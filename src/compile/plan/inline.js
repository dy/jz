/**
 * Call-graph reshaping — three related transforms that fold dynamic dispatch
 * into static control flow:
 *
 *   - `inlineHotInternalCalls`   — non-exported call sites whose callee is a
 *                                  small, simple-arg function get the body
 *                                  spliced in. Threshold-gated by callsite
 *                                  count and loop depth (`programFacts`).
 *   - `inlineLocalLambdas`       — `const f = (a) => …; … f(x) …` inside one
 *                                  function body, where `f` is non-escaping,
 *                                  splices the lambda body at each call.
 *   - `specializeFixedRestCalls` — `f(...args)` with statically-known argc
 *                                  produces a clone of `f` whose rest param
 *                                  is destructured at fixed indices; the
 *                                  spread call collapses to a fixed-arity one.
 *
 * Each transform mutates `ctx.funcs.list` / `func.body` and returns `boolean`
 * indicating whether anything changed (so `plan()` knows to invalidate the
 * program-facts cache).
 *
 * TIER BOUNDARY: inlines at the SOURCE-AST level, pre-emission, driven by
 * call-site/loop-depth/escape heuristics — never purity or straight-line
 * analysis, and never anything WAT-shaped (no `local.get`/`call` IR nodes).
 * That's the optimizer tier's job: pure, straight-line callees only, inlined
 * post-emission to expose arithmetic to the vectorizer/narrower/const-folder
 * — documented at optimize/vectorize.js's `inlinePureFnsInFn`/`inlinePureCallExpr`.
 *
 * @module compile/plan/inline
 */

import { ctx } from '../../ctx.js'
import {
  callArgs, setCallArgs, some, walkAst, blockStmts, stmtList, T, CLASS_T, refsName, refsAny, REFS_IN_EXPR, MUTATE_OPS,
  extractParams, isBlockBody, REFS_THROUGH_ARROWS,
} from '../../ast.js'
import { freshId } from '../../ir.js'
import { cloneWithSubst } from '../../type.js'
import { constIntExpr, constNumExpr } from '../../static.js'
import { K, core, tagOf, hasModeledResult, answeredAtCall } from '../../summary/index.js'
import { analyzeBody } from '../analyze.js'
import {
  LOOP_OPS, isSimpleArg, mutatesAny, loopDepth, nodeSize, clonePlain, collectBindings,
  fixedTypedArraysInBody, forLoopBodyIndex, withForLoopBody,
} from './common.js'
import { materializeVariant } from '../variant.js'
import { isExported } from '../func-exports.js'
import { frameNode } from '../../function.js'

// Returns { prefix, value } where prefix is the substituted body statements
// (excluding any trailing `return X`), and value is the substituted return
// expression — null if void or no trailing return value.
// Preserve a call-free leaf's eager-boolean optimization when source inlining
// moves it into a caller containing unrelated calls. Pure scalar comparison
// trees are non-trapping and canonical 0/1, so &&/|| can become &/| in the
// cloned AST without changing evaluation or value semantics.
const BOOL_LEAF_OPS = new Set(['>', '<', '>=', '<=', '==', '!=', '===', '!=='])
const PURE_SCALAR_OPS = new Set([
  'u-', 'u+', '~', '+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '>>>',
])
const pureScalarExpr = n => {
  if (typeof n === 'number' || typeof n === 'string') return true
  if (!Array.isArray(n)) return false
  if (n[0] == null) return true
  return PURE_SCALAR_OPS.has(n[0]) && n.slice(1).every(pureScalarExpr)
}
const pureCanonicalBool = n => Array.isArray(n) && (
  (BOOL_LEAF_OPS.has(n[0]) && pureScalarExpr(n[1]) && pureScalarExpr(n[2])) ||
  (n[0] === '!' && pureCanonicalBool(n[1])) ||
  ((n[0] === '&&' || n[0] === '||') && pureCanonicalBool(n[1]) && pureCanonicalBool(n[2])))
// Encode leaf provenance in an internal AST operator rather than an array
// side-property: subsequent plan transforms clone arrays but preserve op
// strings. Emit still proves both lowered operands pure before going eager,
// so generic parameters that need coercion retain short-circuit semantics.
// The purity test runs pre-order on purpose: it reads the children's own
// `&&`/`||` ops, which this same walk renames — testing after the children were
// visited would see `__eager&&` and reject every outer node of a chain.
const eagerCallFreeBooleans = n => walkAst(n, { enter: n => {
  if (n[0] === '=>') return false
  if ((n[0] === '&&' || n[0] === '||') && pureCanonicalBool(n)) n[0] = n[0] === '&&' ? '__eager&&' : '__eager||'
} })

const isPureCallee = name => typeof name === 'string' && name.startsWith('math.') && name !== 'math.random'

const bodyHasCall = body => some(body, n => n[0] === '()' || n[0] === 'new')
const BIND = CLASS_T + 'bind'

/** Candidates spliced at their sites in loops only; a straight-line site keeps
 *  the call (`inlineHotInternalCalls` fills it, `isCandidateCall` consults it). */
let hotOnly = new Set()
/** Candidates the speed tier splices in a loop at any depth, while the caller has
 *  room (`CALLER_FULL`): a body of its size at a site the loop runs. */
let warm = new Set()
/** The loops around the statement being spliced. */
let loopsDeep = 0

let callerView = null

// The names the closures of `body` bind, renamed with the spliced body.
const closureBindings = (body) => {
  const binds = new Set()
  const inside = (n) => {
    if (!Array.isArray(n) || n[0] === 'str' || n[0] == null) return
    if (n[0] === '.' || n[0] === '?.') { inside(n[1]); return }
    if (n[0] === ':') { inside(n[2]); return }
    if (n[0] === '=>') for (const p of extractParams(n[1])) if (typeof p === 'string') binds.add(p)
    if (n[0] === 'let' || n[0] === 'const') collectBindings(n, binds)
    for (let i = 1; i < n.length; i++) inside(n[i])
  }
  walkAst(body, { enter: n => { if (n[0] === '=>') { inside(n); return false } } })
  return binds
}

// The operators that throw on a BigInt beside a Number (a comparison takes both).
const UNMIXED_OPS = new Set(['+', '-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>'])
const operandKind = (e) => Array.isArray(e) && e[0] === 'bigint' ? K.BIGINT
  : typeof e === 'number' || (Array.isArray(e) && e[0] == null && typeof e[1] === 'number') ? K.NUMBER
  : e == null ? K.NONE : tagOf(core(callerView?.kindOfExpr(e) ?? K.NONE))
// A site that passes a BigInt and a Number to one operator of the body is a TypeError
// when the call runs, and no sooner: spliced, the operator would be one the compiler rejects.
const mixesKinds = (func, args) => {
  const at = new Map(func.sig.params.map((p, i) => [p.name, i]))
  const kindOf = (e) => typeof e === 'string' && at.has(e) ? operandKind(args[at.get(e)]) : typeof e === 'string' ? K.NONE : operandKind(e)
  return some(func.body, n => {
    if (!UNMIXED_OPS.has(n[0]) || n.length !== 3) return false
    const a = kindOf(n[1]), b = kindOf(n[2])
    return (a === K.BIGINT && b === K.NUMBER) || (a === K.NUMBER && b === K.BIGINT)
  })
}

// A function body's statements, or null for an expression body: `(…) => ({ b0, a1 })`
// is a literal, however its node reads like a block.
const funcStmts = (body) => isBlockBody(body) ? blockStmts(body) : null

/** A default that reads the same wherever it is evaluated: a literal, a Math
 *  constant, or a parameter before the one it belongs to. */
const steadyDefault = (d, params, i) => typeof d === 'number' || (Array.isArray(d) && (d[0] == null || d[0] === 'str')) ||
  (typeof d === 'string' && (/^math\.[A-Z0-9_]+$/.test(d) || params.slice(0, i).some(p => p.name === d)))

// A one-use argument can replace the first evaluated operand of a leaf.
// No body operation or other nonliteral argument may run before that read.
const EAGER_OPERANDS = new Set([...PURE_SCALAR_OPS, ...BOOL_LEAF_OPS, '!', 'typeof', ',', '('])
const firstRead = (node, name) => {
  if (node === name) return true
  if (!Array.isArray(node)) return false
  if (node[0] === '.' || node[0] === '[]') return firstRead(node[1], name)
  const operands = node[0] === '()'
    ? typeof node[1] === 'string' && node[1].startsWith('math.') && node[1] !== 'math.random' ? callArgs(node) : null
    : EAGER_OPERANDS.has(node[0]) ? node.slice(1) : null
  if (!operands) return false
  for (const operand of operands) {
    if (firstRead(operand, name)) return true
    if (!isLiteral(operand)) return false
  }
  return false
}
const readCount = (node, name) => {
  if (node === name) return 1
  if (!Array.isArray(node) || node[0] === 'str' || node[0] == null) return 0
  if (node[0] === '.' || node[0] === '?.') return readCount(node[1], name)
  return node.slice(1).reduce((n, value) => n + readCount(value, name), 0)
}
// Re-reading a binding is safe only when the entire leaf cannot call user
// code. Arithmetic and loose/relational comparisons may invoke valueOf.
const NO_COERCION = new Set(['===', '!==', '!', 'typeof', '&&', '||', '??', '?:', '(', ','])
const noCoercion = node => !Array.isArray(node) || isLiteral(node) ||
  NO_COERCION.has(node[0]) && node.slice(1).every(noCoercion)

// A caller-owned binding stays put while a callee runs unless an argument or
// the body writes it. Number arithmetic over such bindings is equally stable:
// it neither invokes user code nor throws, and is only substituted once.
const stableArgument = (arg, roots, args) => {
  const names = new Set()
  const value = n => {
    if (typeof n === 'string') { names.add(n); return !!callerStable?.(n) }
    if (isLiteral(n)) return true
    return Array.isArray(n) && PURE_SCALAR_OPS.has(n[0]) && n.slice(1).every(a =>
      operandKind(a) === K.NUMBER && value(a))
  }
  return value(arg) && !mutatesAny([';', ...args, roots], names, REFS_THROUGH_ARROWS)
}

const inlinedBody = (func, args) => {
  if (some(func.body, n => n[0] === 'this')) return null
  if (args.some(a => operandKind(a) === K.BIGINT) && mixesKinds(func, args)) return null
  const closures = some(func.body, n => n[0] === '=>') ? closureBindings(func.body) : null
  const params = func.sig.params
  // A spread supplies a runtime number of values, not one positional argument.
  if (args.length > params.length || args.some(a => Array.isArray(a) && a[0] === '...')) return null
  const stmts = isBlockBody(func.body) ? blockStmts(func.body) : null
  const roots = func.defaults ? frameNode(func) : func.body
  const paramNames = new Set(params.map(p => p.name))
  const writesParams = mutatesAny(roots, paramNames, REFS_THROUGH_ARROWS)
  // Writes in defaults or nested closures still belong to this call's parameter.
  const writes = (name) => writesParams && mutatesAny(roots, new Set([name]), REFS_THROUGH_ARROWS)

  // Call arguments are values captured before defaults and the body run.
  // Keep that evaluation boundary explicit; later alias/local passes can
  // remove a copy after proving its source stays unchanged.
  const leaf = !closures && !writesParams && !func.defaults
    ? !stmts ? func.body : stmts.length === 1 && stmts[0]?.[0] === 'return' ? stmts[0][1] : null
    : null
  const subst = new Map()
  const argPrefix = []
  for (let i = 0; i < params.length; i++) {
    // A default is decided at the site: an argument the call leaves out is the
    // parameter's default, evaluated in its turn in the parameters' scope
    // (`new Vector3()`: x, y, z are 0), or undefined; one the call passes runs
    // no default when the caller's summary proves it not nullish, and one that
    // may be undefined would need the test at runtime: this site keeps the call.
    const dflt = func.defaults?.[params[i].name]
    // An argument that may be undefined takes a default that reads the same
    // wherever it is evaluated (a literal, a Math constant, a parameter before
    // it) by a test at the site: `Q = Math.SQRT1_2` given `params._qCur`.
    if (i < args.length && dflt != null && callerView?.mayBeNullishExpr(args[i]) !== false) {
      if (!steadyDefault(dflt, params, i)) return null
      const given = `${T}inarg${freshId(ctx)}`, tmp = `${T}inarg${freshId(ctx)}`
      argPrefix.push(['const', ['=', given, args[i]]],
        [writesParams ? 'let' : 'const', ['=', tmp, ['?:', ['===', given, [, undefined]], cloneWithSubst(dflt, subst, new Map()), given]]])
      subst.set(params[i].name, tmp)
      continue
    }
    // An arrow in a left-out default closes over the parameters' scope, which
    // its clone leaves behind (cloneWithSubst keeps `=>` bodies whole, as a
    // body with an arrow is never spliced): this site keeps the call.
    if (i >= args.length && dflt != null && some(dflt, n => n[0] === '=>')) return null
    const arg = i < args.length ? args[i] : dflt != null ? cloneWithSubst(dflt, subst, new Map()) : [null, undefined]
    const name = params[i].name
    const direct = !closures && !func.defaults &&
      (typeof arg === 'string' || readCount(func.body, name) === 1) && stableArgument(arg, roots, args) ||
      leaf && args.every((a, j) => j === i || isLiteral(a)) &&
      ((readCount(leaf, name) === 1 && firstRead(leaf, name)) ||
        (typeof arg === 'string' && noCoercion(leaf)))
    if (!writes(name) && (isLiteral(arg) || direct)) { subst.set(name, arg); continue }
    const tmp = `${T}inarg${freshId(ctx)}`
    // Parameter writes belong to the call's storage, never its caller's binding.
    argPrefix.push([writes(params[i].name) ? 'let' : 'const', ['=', tmp, arg]])
    subst.set(params[i].name, tmp)
  }

  const locals = new Set()
  collectBindings(func.body, locals)
  if (closures) for (const name of closures) locals.add(name)
  for (const p of params) locals.delete(p.name)

  const rename = new Map()
  for (const name of locals) rename.set(name, `${T}inl${freshId(ctx)}_${name}`)
  // a body that makes closures is spliced with them: their bindings are named anew with the body's
  const clone = closures ? (n, sub, ren) => cloneWithSubst(n, sub, ren, true) : cloneWithSubst

  const mark = bodyHasCall(func.body) ? n => n : eagerCallFreeBooleans
  // Expression-bodied arrow `(c) => expr`: no statement block; the whole body
  // *is* the return value. Treat as zero-prefix + value.
  if (!stmts) return { prefix: argPrefix, value: mark(clone(func.body, subst, rename)) }
  const last = stmts.length ? stmts[stmts.length - 1] : null
  const isTrailingReturn = Array.isArray(last) && last[0] === 'return'
  const prefixSrc = isTrailingReturn ? stmts.slice(0, -1) : stmts
  const prefix = prefixSrc.map(stmt => mark(clone(stmt, subst, rename)))
  const value = isTrailingReturn && last.length > 1 ? mark(clone(last[1], subst, rename)) : null
  callerSize += nodeSize(func.body)
  return { prefix: argPrefix.length ? [...argPrefix, ...prefix] : prefix, value }
}

const hasReturn = (n) => some(n, x => x[0] === 'return')
// Returns other than one that ends the body: what `lowerReturns` removes.
const strayReturns = (func) => {
  let n = 0
  some(func.body, x => { if (x[0] === 'return') n++; return false })
  const stmts = funcStmts(func.body)
  const last = stmts?.[stmts.length - 1]
  return Array.isArray(last) && last[0] === 'return' ? n - 1 : n
}
const block = (stmts) => ['{}', [';', ...stmts]]
const isLiteral = (e) => typeof e === 'number' || (Array.isArray(e) && (e[0] == null || e[0] === 'bool' || e[0] === 'str'))

// Every return leaves through one trailing `return r`. A `return X` becomes
// `r = X`; inside a loop `done = true; break` follows, and a loop that may
// return ends the loop around it the same way (`if (done) break`). Statements
// after one that may return go in the else arm when its then arm always
// returns (`if (c) return X; rest` → `if (c) r = X; else rest`, and down an
// else-if ladder whose every arm returns: the ladder keeps its shape, which
// the union carrier's exclusion stacking reads), under `if (!done)`
// otherwise; `done` exists only where a guard reads it, and a final
// `return <literal>` initializes r instead. Frustum's intersectsSphere
// (false out of its plane loop, true after it) and Ray's intersectTriangle
// (null from either arm of a test, then from three more) both splice.
// A return in a switch, try or another statement is left alone (false).
const lowerReturns = (func) => {
  const stmts = funcStmts(func.body)
  // A tuple result (prepare's multi-value signature) is one value per lane at
  // every return: a single result binding would return one lane.
  if (!stmts || func.sig?.results?.length > 1) return false
  const valued = some(func.body, n => n[0] === 'return' && n.length === 2)
  const r = `${T}inret${freshId(ctx)}`, done = `${T}indone${freshId(ctx)}`
  let usesDone = false, emitDone = true, init = null, bail = false
  const exit = (s, depth) => [...(valued ? [['=', r, s.length === 2 ? s[1] : [null, undefined]]] : []),
    ...(emitDone ? [['=', done, ['bool', 1]]] : []), ...(depth ? [['break']] : [])]
  // An `if` → { node, always, sunk }: `sunk` when `rest`, the statements after
  // it, went into the else arm of the first `if` without one down its ladder.
  const lowerIf = (s, depth, rest, top) => {
    const then = list(stmtList(s[2]), depth, false)
    const arm = (els) => then.out.length ? ['if', s[1], block(then.out), els] : ['if', ['!', s[1]], els]
    if (s.length > 3) {
      if (!depth && then.always && Array.isArray(s[3]) && s[3][0] === 'if') {
        const r = lowerIf(s[3], depth, rest, top)
        return { node: arm(r.node), always: r.always, sunk: r.sunk }
      }
      const els = list(stmtList(s[3]), depth, false)
      return { node: ['if', s[1], block(then.out), block(els.out)], always: then.always && els.always, sunk: false }
    }
    if (!depth && then.always && rest.length) {
      const tail = list(rest, 0, top)
      return { node: arm(block(tail.out)), always: tail.always, sunk: true }
    }
    return { node: ['if', s[1], block(then.out)], always: false, sunk: false }
  }
  // A statement list → { out, always }: the lowered statements, and whether
  // every path through them returns. `top`: a tail of the function body.
  const list = (stmts, depth, top) => {
    const out = []
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i]
      if (Array.isArray(s) && s[0] === 'return') { out.push(...exit(s, depth)); return { out, always: true } }
      if (!Array.isArray(s) || !hasReturn(s)) { out.push(s); continue }
      const rest = stmts.slice(i + 1)
      let always = false
      if (s[0] === 'if') {
        const r = lowerIf(s, depth, rest, top)
        out.push(r.node)
        if (r.sunk) return { out, always: r.always }
        always = r.always
      } else if (LOOP_OPS.has(s[0])) {
        const bi = s[0] === 'for' ? forLoopBodyIndex(s) : 2
        const body = list(stmtList(s[bi]), depth + 1, false)
        out.push(s[0] === 'for' ? withForLoopBody(s, block(body.out)) : ['while', s[1], block(body.out)])
        if (depth) { usesDone = true; out.push(['if', done, ['break']]) }
      } else { bail = true; return { out, always: false } }
      if (always) return { out, always: true }
      if (depth || !rest.length) continue
      if (top && rest.length === 1 && Array.isArray(rest[0]) && rest[0][0] === 'return' && (!valued || isLiteral(rest[0][1]))) {
        if (valued) init = rest[0][1]
        return { out, always: true }
      }
      usesDone = true
      const tail = list(rest, 0, top)
      out.push(['if', ['!', done], block(tail.out)])
      return { out, always: tail.always }
    }
    return { out, always: false }
  }
  let { out } = list(stmts, 0, true)
  if (bail) return false
  if (!usesDone) { emitDone = false; init = null; ({ out } = list(stmts, 0, true)) }
  func.body = block([
    ...(valued ? [['let', init != null ? ['=', r, init] : r]] : []),
    ...(usesDone ? [['let', ['=', done, ['bool', 0]]]] : []),
    ...out,
    ...(valued ? [['return', r]] : [])])
  return true
}

// A body that returns a fresh literal it declared: a class factory, an object builder.
const madeLiteral = (func) => {
  const stmts = funcStmts(func.body), last = stmts?.[stmts.length - 1]
  if (!Array.isArray(last) || last[0] !== 'return' || typeof last[1] !== 'string') return false
  return stmts.some(s => stmtDeclName(s) === last[1] && Array.isArray(s[1][2]) && (s[1][2][0] === '{}' || s[1][2][0] === '['))
}
const stmtDeclName = (stmt) => {
  if (!Array.isArray(stmt) || (stmt[0] !== 'let' && stmt[0] !== 'const') || stmt.length !== 2) return null
  const decl = stmt[1]
  return Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string' ? decl[1] : null
}

// Names an lvalue's evaluation writes (`out[w++]` → {w}), `true` for an opaque
// effect (a call, a member write), `false` for none.
const plainTarget = (lhs) => Array.isArray(lhs) && typeof lhs[1] === 'string' &&
  (lhs[0] === '.' ? typeof lhs[2] === 'string' : lhs[0] === '[]' && lhs.length === 3 && (typeof lhs[2] === 'string' || isLiteral(lhs[2])))
const lhsWrites = (n) => {
  if (some(n, x => x[0] === '()' || x[0] === '?.()' || x[0] === 'new' || (MUTATE_OPS.has(x[0]) && typeof x[1] !== 'string'))) return true
  const w = new Set()
  walkAst(n, { enter: x => { if (MUTATE_OPS.has(x[0]) && typeof x[1] === 'string') w.add(x[1]) } })
  return w.size ? w : false
}
// The names of the function being spliced into that nothing but its own statements
// can store to: a local or a parameter no closure mentions, a constant of the module.
let callerStable = null
const stableNames = (func) => {
  const own = new Set((func.sig?.params || []).map(p => p.name)), captured = new Set()
  collectBindings(func.body, own)
  walkAst(frameNode(func), { enter: n => { if (n[0] === '=>') { walkAst(n, { enter: x => { for (let i = 1; i < x.length; i++) if (typeof x[i] === 'string') captured.add(x[i]) } }); return false } } })
  return (name) => own.has(name) ? !captured.has(name) : !!ctx.scope.consts?.has(name)
}
const prefixCommutesWithLhs = (prefix, lhs) => {
  if (typeof lhs === 'string' || !prefix.length) return true
  const body = [';', ...prefix]
  // A target that runs nothing, over names the splice cannot store to, names the same
  // element before the splice and after it, whatever the splice calls (`OUT[i] = f(x)`).
  if (callerStable && lhsWrites(lhs) === false) {
    const stored = new Set()
    walkAst(body, { enter: x => { if (MUTATE_OPS.has(x[0]) && typeof x[1] === 'string') stored.add(x[1]) } })
    let stable = true
    walkAst(['()', lhs], { enter: x => { for (let i = 1; i < x.length; i++) if (typeof x[i] === 'string' && !((x[0] === '.' || x[0] === '?.') && i === 2) && (!callerStable(x[i]) || stored.has(x[i]))) stable = false } })
    if (stable) return true
  }
  // A target that names its receiver and its key (`out[i] = f(x)`, `o.k = f(x)`)
  // reads no memory: a store in the prefix changes neither, a name it writes does.
  if (plainTarget(lhs)) {
    if (some(body, x => (x[0] === '()' && !isPureCallee(x[1])) || x[0] === '?.()' || x[0] === 'new')) return false
    const w = new Set()
    walkAst(body, { enter: x => { if (MUTATE_OPS.has(x[0]) && typeof x[1] === 'string') w.add(x[1]) } })
    return !refsAny(lhs, w, REFS_IN_EXPR)
  }
  const written = lhsWrites(body)
  if (written === true || written && refsAny(lhs, written, REFS_IN_EXPR)) return false
  const seen = lhsWrites(lhs)
  if (seen === false) return true
  if (seen === true) return false
  for (const x of seen) if (refsName(body, x, REFS_IN_EXPR)) return false
  return true
}

const spliceInlinedShape = (prefix, valueStmt) => {
  const splice = [...prefix, valueStmt]
  return { node: ['{}', [';', ...splice]], splice, changed: true }
}

// A caller past this size takes no more loops at sites outside its own: the splice
// of a kernel there saves one call and adds its body to a function the engine
// compiles as one (a driver of three hundred kernels, each called once, spliced
// into one function of thirty thousand lines that never left the baseline tier).
const CALLER_FULL = 3000
// The largest straight-line body the speed tier splices at a site in a loop past the site budgets.
const WARM_BODY = 200
let callerSize = 0, callerBound = true, kernels = new Set(), inClosure = false
// The candidates that splice only where an argument they call is a function: name → the positions of those parameters.
let fnSites = new Map()
// The positions of the parameters `func` calls inside a loop.
const calledParams = (func) => {
  const at = new Map((func.sig?.params || []).map((p, i) => [p.name, i])), out = new Set()
  const walk = (n, inLoop) => {
    if (!Array.isArray(n) || n[0] === '=>' || n[0] === 'str') return
    if (inLoop && n[0] === '()' && typeof n[1] === 'string' && at.has(n[1])) out.add(at.get(n[1]))
    const loop = inLoop || LOOP_OPS.has(n[0])
    for (let i = 1; i < n.length; i++) walk(n[i], loop)
  }
  walk(func.body, false)
  return [...out]
}
// An argument that is a function: one the program names, a value the summary knows as a
// closure, or a name the caller binds to either (the temp a splice bound the argument to).
let callerFunctions = new Set()
const isFunctionValue = (v) => (typeof v === 'string' && (ctx.funcs.names.has(v) || callerFunctions.has(v))) ||
  (Array.isArray(v) && v[0] === '=>') || tagOf(core(callerView?.kindOfExpr(v) ?? K.NONE)) === K.CLOSURE
const boundFunctions = (body) => {
  const out = new Set()
  callerFunctions = out
  walkAst(body, { enter: n => {
    if (n[0] === '=>') return false
    if (n[0] === 'const') for (let i = 1; i < n.length; i++) { const d = n[i]; if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' && isFunctionValue(d[2])) out.add(d[1]) }
  } })
  return out
}
const isFunctionArg = isFunctionValue

// `hot`: the call sits in a loop, where a loop-only candidate splices too.
const isCandidateCall = (node, candidates, hot = false) => {
  if (!Array.isArray(node) || node[0] !== '()' || typeof node[1] !== 'string' || !candidates.has(node[1])) return false
  if (warm.has(node[1])) { if (loopsDeep === 0 && !hot || callerSize > CALLER_FULL) return false }
  else if (!hot && hotOnly.has(node[1])) return false
  if (!hot && callerBound && callerSize > CALLER_FULL && kernels.has(node[1])) { ctx.plans.keptKernels.add(node[1]); return false }
  // in a callback a factory returns, a kernel splices at a site in the callback's own loop only
  if (inClosure && !hot && kernels.has(node[1])) return false
  const called = fnSites.get(node[1])
  if (called === undefined) return true
  const args = callArgs(node)
  return args != null && called.every(i => i < args.length && isFunctionArg(args[i]))
}

// Arithmetic-shaped expression candidates stay small enough to inline. This
// syntactic test selects bodies; it does not prove their coercions effect-free.
// Argument captures and prefix declarations retain their evaluation order.
const PURE_FLATTEN_OPS = new Set([
  '+', '-', '*', '/', '%', 'u-', 'u+', '&', '|', '^', '<<', '>>', '>>>',
  '<', '<=', '>', '>=', '==', '!=', '===', '!==', '&&', '||', '!', '~', '?:',
])
const pureSIMDCall = n => Array.isArray(n) && n[0] === '()' &&
  typeof n[1] === 'string' && /^(?:v128|[ifu](?:8|16|32|64)x\d+)\./.test(n[1]) &&
  !/\.(?:load|store)/.test(n[1])
const pureFlattenExpr = (n) => {
  if (typeof n === 'number' || typeof n === 'string') return true  // literal or ident
  if (!Array.isArray(n)) return false
  const op = n[0]
  if (op == null) return true                                       // boxed literal [null, v]
  // Native SIMD constructors/arithmetic are effect-free and non-trapping,
  // so their initializers qualify for the same splicing as scalar arithmetic.
  if (pureSIMDCall(n)) {
    const args = callArgs(n)
    return !!args && args.every(pureFlattenExpr)
  }
  return PURE_FLATTEN_OPS.has(op) && n.slice(1).every(pureFlattenExpr)
}
const substIdents = (n, subst) => {
  if (typeof n === 'string') return subst.get(n) ?? n
  if (!Array.isArray(n)) return n
  return n.map((c, i) => i === 0 ? c : substIdents(c, subst))
}
const flattenPrefix = (shape) => {
  if (!shape || shape.value === null || !shape.prefix.length) return shape
  const subst = new Map()
  // Only literals can leave their evaluation point without a lifetime proof.
  // Other initializers remain captured; alias/local passes own their removal.
  for (const stmt of shape.prefix) {
    if (!Array.isArray(stmt) || (stmt[0] !== 'let' && stmt[0] !== 'const') || stmt.length !== 2) return null
    const d = stmt[1]
    if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string' || !isLiteral(d[2])) return null
    subst.set(d[1], substIdents(d[2], subst))  // earlier decls feed later RHSs
  }
  // A written or captured prefix binding needs its own storage. A closure may
  // write it or read it after the initializer's source binding has changed.
  const bindings = new Set(subst.keys())
  if (mutatesAny(shape.value, bindings) ||
      some(shape.value, n => n[0] === '=>' && refsAny(n, bindings, REFS_IN_EXPR))) return null
  const value = substIdents(shape.value, subst)
  if (nodeSize(value) > 200) return null  // duplication blow-up guard
  return { prefix: [], value }
}

// Recursively substitute calls to expr-bodied candidates anywhere in `node`.
// Used for tiny pure-expression helpers (`isAlpha(c) => …`) that get called
// from expression contexts (if-conditions, ternary tests). A declaration
// prefix stays in a sequence at the call site; unwritten literals may flatten.
const inlineInExpr = (node, candidates, hot = false) => {
  if (!Array.isArray(node) || node[0] === '=>') return node
  const inner = hot || LOOP_OPS.has(node[0])
  let next = null
  for (let i = 1; i < node.length; i++) {
    const child = inlineInExpr(node[i], candidates, inner)
    if (child !== node[i] && !next) next = node.slice(0, i)
    if (next) next.push(child)
  }
  const out = next || node
  if (isCandidateCall(out, candidates, hot)) {
    const args = callArgs(out)
    const shape = args && inlinedBody(candidates.get(out[1]), args)
    if (shape && shape.value !== null) {
      const flat = flattenPrefix(shape)
      if (flat?.prefix.length === 0) return flat.value
      // Declarations in a sequence keep each argument/default at the call's
      // evaluation point, including conditional arms and later operands.
      // Statement bodies keep the statement splice path below.
      if (shape.prefix.every(s => stmtDeclName(s)))
        return ['(', [',', ...shape.prefix, shape.value]]
    }
  }
  return out
}

// `hot`: the statement sits in an innermost loop — the loops the lane vectorizer
// takes. A loop body that holds no loop of its own.
const innermost = (body) => !some(body, n => LOOP_OPS.has(n[0]))
// A value no one reads, as the statements that run what it runs: nothing for
// a name or a literal, each element in turn for a list the call returned
// (`return [s.l, s.b, h]` spliced where the call's result is dropped).
const unused = (v) => v === null || typeof v !== 'object' || v[0] == null || v[0] === 'str' || v[0] === 'bool' ? []
  : v[0] === '[' && v.every((e, j) => !j || (e != null && !(Array.isArray(e) && e[0] === '...'))) ? v.slice(1).flatMap(unused)
  : [v]

const inlineInStmt = (stmt, candidates, hot = false) => {
  if (!Array.isArray(stmt)) return null
  // Statement-position call: the result is unused, but the callee's return
  // EXPRESSION may still carry side effects — an expression-bodied arrow whose body
  // is itself effectful (`seek = n => idx = n` inlines to the assignment `idx = i`;
  // a one-liner that calls another fn) puts the effect in `value`, not `prefix`.
  // Emit it as a trailing statement so the effect runs; a pure value is dropped
  // later by vacuum/DCE. (Dropping it lost the parser's seek() idx-advance → ∞ loop.)
  // A name or a literal is dropped here: it runs nothing, and left as a statement
  // it reads as a use of the name to every scan ahead of emission (`return y`
  // of an in-place kernel made `y` escape, and its receiver dynamic).
  if (isCandidateCall(stmt, candidates, hot)) {
    const args = callArgs(stmt)
    const shape = args && inlinedBody(candidates.get(stmt[1]), args)
    if (shape) {
      const splice = [...shape.prefix, ...unused(shape.value)]
      return { node: ['{}', [';', ...splice]], changed: true, splice }
    }
  }
  // `let/const X = call(...)` with single decl: inline as prefix + decl(value).
  // A declaration, however many declarators it binds. One `const r = f(a), g =
  // f(b), b = f(c)` is the idiomatic way to read three channels at once, and it
  // inlined nothing at all: the expression path cannot splice a body whose
  // argument needs a temp, and this path only ever looked at a lone declarator.
  // Each declarator becomes its own statement in the original order, so a later
  // initializer still reads the bindings before it.
  //
  // More than one declarator splices only in an innermost loop. That is where
  // it pays, and why: the call it removes is what kept the lane vectorizer out
  // of the loop — colorlog's three `decode` calls became three `exp2_v` lifts
  // and the case went from 1.13x V8 to 0.54. A site in an outer loop gains
  // nothing, and the copies only add size: fft binds its sine and cosine
  // polynomials once per stage, and splicing them grew the module 5% for no
  // time at all. A lone declarator keeps the policy every other statement
  // shape has and splices wherever its callee qualifies.
  if (stmt[0] === 'let' || stmt[0] === 'const') {
    const splice = []
    let any = false
    for (let d = 1; d < stmt.length; d++) {
      const decl = stmt[d]
      if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string' && isCandidateCall(decl[2], candidates, hot)) {
        const args = callArgs(decl[2])
        const shape = args && inlinedBody(candidates.get(decl[2][1]), args)
        if (shape && shape.value !== null) {
          // The callee returns one of its own locals (`let self = {…}; …; return self`,
          // a class factory): the caller's name takes the local's place, so the
          // literal has no alias to escape into and scalar replacement sees it,
          // wherever the name is bound (`const a = new Vector3(), b = new Vector3()`).
          const own = typeof shape.value === 'string' && shape.prefix.some(st => stmtDeclName(st) === shape.value)
          if (stmt.length === 2 || hot || own) {
            if (own) splice.push(...shape.prefix.map(st => substIdents(st, new Map([[shape.value, decl[1]]]))))
            else splice.push(...shape.prefix, [stmt[0], ['=', decl[1], shape.value]])
            any = true
            continue
          }
        }
      }
      splice.push([stmt[0], decl])
    }
    if (any) return { node: ['{}', [';', ...splice]], changed: true, splice }
  }
  // `return call(...)`: the prefix, then the value returned. A loop of its own stays a
  // call there unless it calls its argument: the splice of a loop saves one call.
  if (stmt[0] === 'return' && stmt.length === 2 && isCandidateCall(stmt[1], candidates, hot) && (hot || !kernels.has(stmt[1][1]) || fnSites.has(stmt[1][1]))) {
    const args = callArgs(stmt[1])
    const shape = args && inlinedBody(candidates.get(stmt[1][1]), args)
    if (shape && shape.value !== null) return spliceInlinedShape(shape.prefix, ['return', shape.value])
  }
  // `X = call(...)` at statement position: inline as prefix + assign(value).
  // LHS may be a name or an indexed lvalue (`out[i] = beat(...)` in fill loops).
  // The LHS reference is evaluated before the call, so an effect in it
  // (`out[w++] = draw()`) admits the splice only when the callee's prefix
  // commutes with it: no calls, no memory writes, no name the LHS wrote.
  if (stmt[0] === '=' && isCandidateCall(stmt[2], candidates, hot)) {
    const args = callArgs(stmt[2])
    const shape = args && inlinedBody(candidates.get(stmt[2][1]), args)
    if (shape && shape.value !== null && prefixCommutesWithLhs(shape.prefix, stmt[1])) {
      return spliceInlinedShape(shape.prefix, ['=', stmt[1], shape.value])
    }
  }
  const op = stmt[0]
  if (op === ';') {
    let changed = false
    const next = [';']
    for (let i = 1; i < stmt.length; i++) {
      // A comma expression in statement position is its operands in order (a
      // lowered pattern: `let t = f(…), a = t[0], t`), each a statement a call
      // splices into; the last one's value is dropped, and one that runs
      // nothing goes with it.
      const seq = stmt[i]
      if (Array.isArray(seq) && seq[0] === ',' && seq.some((e, j) => j && inlineInStmt(e, candidates, hot))) {
        const last = seq[seq.length - 1], inert = typeof last === 'string' || isLiteral(last)
        stmt = [...stmt.slice(0, i), ...seq.slice(1, inert ? -1 : seq.length), ...stmt.slice(i + 1)]
        changed = true
      }
      const r = inlineInStmt(stmt[i], candidates, hot)
      if (r) changed = true
      if (r?.splice) next.push(...r.splice)
      else next.push(r ? r.node : stmt[i])
    }
    return changed ? { node: next, changed: true } : null
  }
  if (op === '{}') {
    const r = inlineInStmt(stmt[1], candidates, hot)
    if (!r) return null
    // If the child was itself a candidate call (or a let/assign-of-call), it
    // already returned a `['{}', [';', ...prefix]]` shape. Re-wrapping here
    // would yield `['{}', ['{}', …]]`, which codegen rejects ("Unknown op: {}").
    if (Array.isArray(r.node) && r.node[0] === '{}') return { node: r.node, changed: true }
    return { node: ['{}', r.node], changed: true }
  }
  if (op === 'for') {
    const idx = forLoopBodyIndex(stmt)
    loopsDeep++
    const r = inlineInStmt(stmt[idx], candidates, innermost(stmt[idx]))
    loopsDeep--
    if (!r) return null
    return { node: withForLoopBody(stmt, r.node), changed: true }
  }
  if (op === 'while') {
    loopsDeep++
    const r = inlineInStmt(stmt[2], candidates, innermost(stmt[2]))
    loopsDeep--
    if (!r) return null
    return { node: ['while', stmt[1], r.node], changed: true }
  }
  if (op === 'if') {
    const thenR = inlineInStmt(stmt[2], candidates, hot)
    const elseR = stmt.length > 3 ? inlineInStmt(stmt[3], candidates, hot) : null
    if (thenR || elseR) return {
      node: stmt.length > 3 ? ['if', stmt[1], thenR ? thenR.node : stmt[2], elseR ? elseR.node : stmt[3]]
        : ['if', stmt[1], thenR ? thenR.node : stmt[2]],
      changed: true,
    }
  }
  if (op === 'catch' || op === 'finally') {
    let changed = false
    const next = [op]
    for (let i = 1; i < stmt.length; i++) {
      const part = stmt[i]
      const r = Array.isArray(part) ? inlineInStmt(part, candidates, hot) : null
      if (r) changed = true
      next.push(r ? r.node : part)
    }
    return changed ? { node: next, changed: true } : null
  }
  return null
}

// Short-circuit operators: only the FIRST operand is unconditionally evaluated; a call in
// a later operand might not run, so it can't be hoisted.
const SHORT_CIRCUIT = new Set(['?:', '&&', '||', '??'])
// Optional chaining: jz's own desugaring already tees the base to evaluate it once, and
// the key/args run conditionally — so the hoist treats the WHOLE expression as opaque (no
// operand, not even the base, is hoisted out) to avoid colliding with that desugaring.
const OPTIONAL_CHAIN = new Set(['?.', '?.[]', '?.()'])

// Hoist an unconditionally-evaluated NESTED call to a block-body candidate out to a
// preceding `const __h = call(...)` temp. inlineInStmt folds block-body candidates only at
// a DIRECT `const X = call` / `X = call`; a call buried in an expression (noise's
// `sum = sum + amp * perlin(x)`) is reached by neither that path nor inlineInExpr (which
// only substitutes zero-prefix expr-bodies). Hoisting normalizes it to the direct form.
// Only block-body candidates and only unconditional positions — preserving evaluation order
// + count. Statement HEADERS that are expression positions (for-init/update, while/if test)
// are left untouched: there's no sound place for a hoisted decl there, so those calls just
// stay outlined. Conservatively leaves unrecognized statement shapes alone.
//
// A call in an arm of a conditional runs only where the arm does, so it cannot move
// ahead of the test. The conditional itself can, as a statement: `c ? a : f(x)` is
// `let t; if (c) t = a; else t = f(x)` and then `t`, `a && f(x)` is `let t = a; if (t)
// t = f(x)`, and the call is a statement's whole value, which splices. The conditional
// moves as a call does: only past what it commutes with.
const hoistNestedCalls = (body, bodies, anywhere = bodies) => {
  if (!bodies.size || !Array.isArray(body)) return { node: body, changed: false }
  let changed = false
  const seq = (stmts) => stmts.length === 1 ? stmts[0] : [';', ...stmts]
  // Lifting a call to the pre-decl block moves its evaluation to the TOP of the statement.
  // Sound only if no observable side effect is evaluated BEFORE it — else its effect jumps
  // ahead of that one (`a() + helper(x)` must keep a()'s effect first). `eff.seen` threads
  // left-to-right through evaluation order: a call or assignment LEFT IN PLACE marks every
  // later position. A hoisted call moves as a unit — its args run in a fresh inner eff, and
  // it does NOT advance the outer eff (the whole unit relocates together, order intact).
  // `eff.seen` is `true` for an opaque effect, or the SET of names a preceding plain
  // assignment wrote (`out[w++] = rnd()`): a callee whose body (`bodies`) touches no
  // memory, calls nothing and shares no name with that set commutes with it. A
  // preceding READ (`eff.mem`: a member or element; `eff.reads`: the names) must
  // see the value before the callee's writes: `s.v * 1000 + bump(s)` keeps the
  // read first, so a callee that stores to memory, calls, or assigns a name read
  // stays in place.
  // A body stores to memory, or calls past the candidates (whose bodies are followed).
  const touchesMemory = (b, seen = new Set()) => some(b, n => n[0] === 'new' || (MUTATE_OPS.has(n[0]) && typeof n[1] !== 'string')
    || (n[0] === '()' && (typeof n[1] !== 'string' || !bodies?.has(n[1]) || (!seen.has(n[1]) && touchesMemory(bodies.get(n[1]), seen.add(n[1]))))))
  const assigns = (b, x, seen = new Set()) => some(b, n => (MUTATE_OPS.has(n[0]) && n[1] === x)
    || (n[0] === '()' && typeof n[1] === 'string' && bodies?.has(n[1]) && !seen.has(n[1]) && assigns(bodies.get(n[1]), x, seen.add(n[1]))))
  // `whole`: an expression that moves as it stands (a conditional lifted to a statement), in place of a call and its body
  const commutes = (call, eff, whole = null) => {
    if (eff.seen === true) return false
    if (eff.seen === false && !eff.mem && !eff.reads.size) return true
    const body = whole ?? bodies?.get(call[1])
    if (!body) return false
    // Moving the call also moves its arguments. An argument can update a
    // value already read by the surrounding expression even when the callee
    // only reads it, e.g. [x, pair(next())].
    const b = whole ?? [';', ...callArgs(call), body]
    if ((eff.seen !== false || eff.mem) && touchesMemory(b)) return false
    if (eff.seen !== false) for (const x of eff.seen) if (refsName(b, x, REFS_IN_EXPR)) return false
    for (const x of eff.reads) if (assigns(b, x)) return false
    return true
  }
  // A hoisted call relocates with its arguments: a candidate among them (itself
  // hoisted ahead of the call) must commute with what ran before as the callee
  // must, and any other effect there may only move past nothing.
  const clean = (eff) => eff.seen === false && !eff.mem && !eff.reads.size
  const unitCommutes = (n, eff) => commutes(n, eff) && n.slice(2).every(a => argCommutes(a, eff))
  const argCommutes = (a, eff) => {
    if (!Array.isArray(a) || a[0] === '=>' || a[0] === 'str') return true
    if (a[0] === '()' && typeof a[1] === 'string' && bodies.has(a[1])) return unitCommutes(a, eff)
    if ((a[0] === '()' && !pureSIMDCall(a)) || a[0] === 'new' || MUTATE_OPS.has(a[0])) return clean(eff)
    return a.slice(1).every(c => argCommutes(c, eff))
  }
  const effState = (seen = false) => ({ seen, mem: false, reads: new Set() })
  const note = (eff, w) => { eff.seen = eff.seen === true || w === true ? true : w === false ? eff.seen : eff.seen === false ? w : new Set([...eff.seen, ...w]) }
  // A member reference prepare shares between a read and its write (`m++` is
  // `m = m + 1` over ONE node) is one evaluation: it rewrites once, and both
  // positions keep the same rewritten node, so a hoisted call in it runs once.
  const rewritten = new Map()
  // The statement's loop, as the splicer sees it: a body outside `anywhere`
  // hoists (and then splices) in an innermost loop only, a warm one in any loop.
  let inLoop = false, deep = 0
  const lifts = (name) => bodies.has(name) && (inLoop || anywhere.has(name) || (deep > 0 && warm.has(name) && callerSize <= CALLER_FULL))
  // a call this pass would lift, in a position the expression may not reach
  const holdsLift = (n) => Array.isArray(n) && n[0] !== '=>' && n[0] !== 'str' &&
    ((n[0] === '()' && typeof n[1] === 'string' && lifts(n[1])) || n.some((c, i) => i > 0 && holdsLift(c)))
  const hExpr = (n, pre, cond, eff) => {
    if (typeof n === 'string') { eff.reads.add(n); return n }
    if (!Array.isArray(n) || n[0] === '=>') return n
    const shared = rewritten.get(n)
    if (shared !== undefined) return shared
    const out = hNode(n, pre, cond, eff)
    rewritten.set(n, out)
    return out
  }
  const hNode = (n, pre, cond, eff) => {
    if (!cond && n[0] === '()' && typeof n[1] === 'string' && lifts(n[1]) && unitCommutes(n, eff)) {
      const argEffects = effState()
      const call = [n[0], n[1], ...n.slice(2).map(a => hExpr(a, pre, false, argEffects))]
      const tmp = `${T}inl${freshId(ctx)}_h`
      pre.push(['const', ['=', tmp, call]])
      changed = true
      // Bare name, NOT the boxed-literal wrapper `[null, tmp]`: that shape means
      // "literal with value tmp" to every reader (valTypeOf, stringLiteral, the
      // representation plan's materializedNames lookup), so a hoisted temp dodged
      // kind resolution AND plan-tag resolution — the O3 pin's raw-carrier
      // collision (value === bump() comparing raw bits) was exactly this: the
      // temp's bigint kind erased to number, the C3 tag dispatch skipped.
      return tmp
    }
    if (OPTIONAL_CHAIN.has(n[0])) {
      const out = [n[0], ...n.slice(1).map(c => hExpr(c, pre, true, eff))]
      if (n[0] === '?.()') eff.seen = true  // optional CALL may run
      return out
    }
    if (SHORT_CIRCUIT.has(n[0])) {
      if (!cond && n[0] !== '??' && n.length === (n[0] === '?:' ? 4 : 3) && n.slice(2).some(holdsLift) && commutes(null, eff, n)) {
        const tmp = `${T}inl${freshId(ctx)}_c`
        const test = hExpr(n[1], pre, false, effState())
        const arm = (e) => seq(hStmt(['=', tmp, e]))
        if (n[0] === '?:') pre.push(['let', tmp], ['if', test, arm(n[2]), arm(n[3])])
        else pre.push(['let', ['=', tmp, test]], ['if', n[0] === '&&' ? tmp : ['!', tmp], arm(n[2])])
        changed = true
        return tmp
      }
      return [n[0], hExpr(n[1], pre, cond, eff), ...n.slice(2).map(c => hExpr(c, pre, true, eff))]
    }
    const out = [n[0], ...n.slice(1).map(c => hExpr(c, pre, cond, eff))]
    if (n[0] === '()' && !pureSIMDCall(n)) eff.seen = true  // an effectful call left in place is an opaque effect
    else if (MUTATE_OPS.has(n[0])) note(eff, typeof n[1] === 'string' ? new Set([n[1]]) : true)
    else if (n[0] === '.' || n[0] === '[]') eff.mem = true  // a read left in place sees the value before a later callee's store
    return out
  }
  // A RHS that is DIRECTLY a candidate call is already folded by inlineInStmt's
  // `const X = call` / `X = call` paths — hoisting it would be redundant and (for an
  // object/array-literal `{}`-bodied factory) would break the post-inline alias chain.
  // Only hoist NESTED calls; leave a top-level direct call to those paths.
  const directCall = (e) => Array.isArray(e) && e[0] === '()' && typeof e[1] === 'string' && bodies.has(e[1])
  const hLoopBody = (body) => { const was = inLoop; inLoop = innermost(body); deep++; const out = seq(hStmt(body)); deep--; inLoop = was; return out }
  const hStmt = (s) => {  // → array of statements (hoisted decls prepended)
    if (!Array.isArray(s)) return [s]
    switch (s[0]) {
      case ';': return [[';', ...s.slice(1).flatMap(hStmt)]]
      case '{}': return [['{}', seq(hStmt(s[1]))]]
      // The test is the statement's first evaluation, so a decl before the
      // `if` is its place; an `else if` test hoists into the else arm.
      case 'if': {
        const pre = []; const test = hExpr(s[1], pre, false, effState())
        return [...pre, s.length > 3 ? ['if', test, seq(hStmt(s[2])), seq(hStmt(s[3]))] : ['if', test, seq(hStmt(s[2]))]]
      }
      case 'for': { const i = forLoopBodyIndex(s); return [withForLoopBody(s, hLoopBody(s[i]))] }
      case 'while': return [['while', s[1], hLoopBody(s[2])]]
      case 'let': case 'const': {
        if (s.length === 2 && Array.isArray(s[1]) && s[1][0] === '=' && typeof s[1][1] === 'string' && !directCall(s[1][2])) {
          const pre = []; const rhs = hExpr(s[1][2], pre, false, effState())
          return pre.length ? [...pre, [s[0], ['=', s[1][1], rhs]]] : [s]
        }
        // Several declarators evaluate left to right; one effect state threads
        // through them (a declared name is out of the callee's scope, so the
        // binding itself is not an effect the callee can observe).
        if (s.length > 2 && s.slice(1).every(d => Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' && !directCall(d[2]))) {
          const pre = [], eff = effState()
          const decls = s.slice(1).map(d => ['=', d[1], hExpr(d[2], pre, false, eff)])
          return pre.length ? [...pre, [s[0], ...decls]] : [s]
        }
        return [s]
      }
      // A computed assign target (`a[i]=…`) evaluates its index BEFORE the RHS, so an effect
      // there (`a[j++]=…`) must block hoisting too — seed eff.seen from the LHS.
      case '=': { if (directCall(s[2])) return [s]; const pre = []; const rhs = hExpr(s[2], pre, false, effState(lhsWrites(s[1]))); return pre.length ? [...pre, ['=', s[1], rhs]] : [s] }
      // Compound assignment reads its target before the RHS (a read, not an effect).
      case '+=': case '-=': case '*=': case '|=': case '&=': case '^=': case '<<=': case '>>=': case '>>>=':
        { const pre = []; const rhs = hExpr(s[2], pre, false, effState(lhsWrites(s[1]))); return pre.length ? [...pre, [s[0], s[1], rhs]] : [s] }
      case 'return': { if (s.length < 2 || directCall(s[1])) return [s]; const pre = []; const v = hExpr(s[1], pre, false, effState()); return pre.length ? [...pre, ['return', v]] : [s] }
      default: return [s]  // unrecognized shape (break/continue/throw/try/switch): leave alone
    }
  }
  const out = hStmt(body)
  return { node: changed ? seq(out) : body, changed }
}

// A body that makes closures splices where its own control is a list with one
// trailing return: the passes that lower returns and loops read a closure's
// statements as the body's.
const closureSpliceable = (func) => {
  const stmts = blockStmts(func.body)
  if (!stmts || !stmts.length) return false
  const outside = (n, f) => { let hit = false; walkAst(n, { enter: x => { if (x[0] === '=>') return false; if (f(x)) hit = true } }); return hit }
  const last = stmts[stmts.length - 1]
  if (!Array.isArray(last) || last[0] !== 'return') return false
  for (let i = 0; i < stmts.length - 1; i++) if (outside(stmts[i], x => x[0] === 'return' || LOOP_OPS.has(x[0]))) return false
  // a closure's parameters are named anew with the body's bindings: plain names only
  return !some(func.body, x => x[0] === '=>' && !extractParams(x[1]).every(p => typeof p === 'string'))
}

export const inlineHotInternalCalls = (programFacts, ast) => {
  let changed = false
  const cfg = ctx.transform.optimize
  if (cfg && cfg.sourceInline === false) return false
  // Transitive candidacy + expression-position hoisting are a size↔speed trade (they
  // pull a large multi-call leaf like noise's perlin fully into its hot caller, where
  // the lower tiers prefer to keep multi-caller helpers outlined for V8 tier-up). Gate
  // both on the speed tier so levels ≤2 keep their conservative inlining policy.
  const speedTier = !!(cfg && cfg.inlineFns)
  hotOnly = new Set()
  warm = new Set()
  loopsDeep = 0
  kernels = new Set()
  fnSites = new Map()
  callerSize = 0
  // the size tier keeps one copy of what is called once, wherever: a function of its own costs its frame
  callerBound = cfg?.sourceInlineDup !== false

  const fixedByFunc = new Map(ctx.funcs.list.map(func => [func, fixedTypedArraysInBody(func.body)]))
  const typedByFunc = new Map(ctx.funcs.list.map(func => [func, analyzeBody(func.body).typedElems]))
  // A dispatcher's arm and a binder's closure call the member for a receiver
  // the summary cannot name (class-dispatch.js): the function stays for them
  // whatever the splice does, so they are no sites of it.
  const synthesized = (f) => !!f && (f.sig?.dispatcher === true || f.name.endsWith(BIND))
  const live = ctx.summary?.at('')
  const sitesByCallee = new Map()
  for (const cs of programFacts.callSites) {
    if (synthesized(cs.callerFunc)) continue
    // Unreachable callers emit no copies. Counting them against the size
    // budget can keep a small setter outlined and its live receiver on the heap.
    if (cs.callerFunc && live?.reaches(cs.callerFunc.name) === false) continue
    const list = sitesByCallee.get(cs.callee)
    if (list) list.push(cs); else sitesByCallee.set(cs.callee, [cs])
  }

  // The functions that reach themselves through the calls they make. One that
  // calls itself never splices; one of a longer cycle splices as a leaf only
  // (the bodies it calls spliced first), or its copy would hold the cycle's call.
  const calls = new Map(ctx.funcs.list.map(f => {
    const out = new Set()
    if (f.body) walkAst(f.body, { enter: n => { if (n[0] === '()' && typeof n[1] === 'string' && ctx.funcs.names.has(n[1])) out.add(n[1]) } })
    return [f.name, out]
  }))
  const cyclic = (name) => {
    const seen = new Set(), todo = [...calls.get(name) ?? []]
    while (todo.length) {
      const x = todo.pop()
      if (x === name) return true
      if (seen.has(x)) continue
      seen.add(x)
      for (const y of calls.get(x) ?? []) todo.push(y)
    }
    return false
  }

  // A closure's body counts its own loops: a callback a factory returns runs
  // them whenever it is called, whatever surrounds its literal.
  const containsNode = (root, needle, inLoop = false) => {
    if (root === needle) return inLoop
    if (!Array.isArray(root)) return false
    if (root[0] === '=>') return containsNode(root[2], needle, false)
    const nextInLoop = inLoop || LOOP_OPS.has(root[0])
    for (let i = 1; i < root.length; i++) if (containsNode(root[i], needle, nextInLoop)) return true
    return false
  }

  const hasFixedTypedArraySites = (func, sites) => {
    const params = func.sig?.params || []
    if (!sites?.length) return false
    return sites.every(site => params.some((p, i) => {
      const arg = site.argList[i]
      return typeof arg === 'string' && fixedByFunc.get(site.callerFunc)?.has(arg)
    }))
  }
  const hasFullyFixedTypedArraySites = (func, sites) => {
    const params = func.sig?.params || []
    if (!sites?.length) return false
    let sawTypedArg = false
    for (const site of sites) {
      const typed = typedByFunc.get(site.callerFunc)
      const fixed = fixedByFunc.get(site.callerFunc)
      for (let i = 0; i < params.length; i++) {
        const arg = site.argList[i]
        if (typeof arg !== 'string' || !typed?.has(arg)) continue
        sawTypedArg = true
        if (!fixed?.has(arg)) return false
      }
    }
    return sawTypedArg
  }

  const candidates = new Map()
  const constructing = new Set() // candidates whose expansion introduces a constructor
  // Forwarders — a candidate whose body calls one of its own parameters.
  // Inlining one replaces that parameter with the call-site argument; when the
  // argument is a known function name the resulting indirect call collapses to
  // a direct `call` (devirtualization).
  const forwarders = new Set()
  // Loop-free leaves — safe to splice into EXPORTED callers too: the tier-up
  // rationale for skipping exports concerns relocating loop KERNELS into cold
  // entry points, not pulling a leaf INTO an export's hot loop (game-of-life's
  // step calls rot per cell; pre-Turboshaft wasm tiers never inline calls).
  const leaves = new Set()
  // Transitive candidacy via fixpoint: a function whose only user-callees are THEMSELVES
  // candidates (so they inline away) can be inlined too. noise's `perlin` calls grad/fade/
  // lerp (loop-free leaves) — once those are candidates, perlin clears the call-bearing-body
  // gate and becomes a leaf candidate. Each pass adds ≥1 or stops, so it's bounded.
  for (let recollect = true; recollect;) {
  recollect = false
  for (const func of ctx.funcs.list) {
    if (candidates.has(func.name)) continue
    const sites = sitesByCallee.get(func.name)
    // Exported leaf/kernel with exactly one internal caller (e.g. fill→beat in
    // floatbeat): inline into the caller's loop but keep the export for external
    // one-off calls (bench beat()). Multi-caller exports stay outlined so V8 can
    // tier-up shared kernels.
    const soleCallerExport = isExported(func) && sites?.length === 1
    // Size keeps shared/exported bodies shared. Single-use internal bodies
    // still inline to expose their types without duplicating source.
    if (cfg?.sourceInlineDup === false && (isExported(func) || sites?.length !== 1)) continue
    if (func.raw || !func.body || func.rest) continue
    if (hasModeledResult(func.name) || answeredAtCall(func.name)) continue
    if (isExported(func) && !soleCallerExport) continue
    // A factory's value is a fresh literal of its own (`let self = {…}; …;
    // return self`, jzify/classes.js). Its splice is an allocation site the
    // size of the literal it makes, so no site cap counts it, and the binder
    // that takes its address (`obj.constructor`) keeps the body. The name the
    // literal is bound to then scalarizes where it never escapes
    // (plan/literals.js): three's `const v = new Vector3()` before a loop.
    const factory = madeLiteral(func)
    // A function a value names stays for the value. At the speed tier its body
    // still is what a direct call of it runs (`modf( x )` beside `modf.assign =
    // assign`, the library's form of a second entry).
    if (programFacts.addressTakenNames.has(func.name) && !soleCallerExport && !factory && !speedTier) continue
    const paramNames = new Set((func.sig?.params || []).map(p => p.name))
    if (paramNames.size && some(func.body, n => {
      if (n[0] !== '()' || !Array.isArray(n[1]) || n[1][0] !== '.') return false
      const [, obj, prop] = n[1]
      return prop === 'push' && typeof obj === 'string' && paramNames.has(obj)
    })) continue
    const fixedTypedArraySite = hasFixedTypedArraySites(func, sites)
    const fullyFixedTypedArraySite = hasFullyFixedTypedArraySites(func, sites)
    const hasLoop = some(func.body, n => LOOP_OPS.has(n[0]))
    const size = nodeSize(func.body)
    const isTinyLeaf = !hasLoop && size <= 15
    // A small leaf (no loop, ≤40 nodes) is cheap to splice even when called several times — its
    // per-call overhead + lost cross-call fusion dwarfs the ≤8× duplication, and temp-binding +
    // flattenPrefix keep the spliced body bounded (no arg re-evaluation, CSE collapses copies).
    // The 2-site non-tiny-leaf cap would otherwise outline a hot helper like noise's `grad`
    // (~30 nodes, called 4× from perlin) and freeze the call overhead per pixel.
    const isSmallLeaf = !hasLoop && size <= 48
    // Small loop bodies share the leaf duplication budget at speed. The depth
    // check below still keeps nested loops separate.
    const isSmallKernel = hasLoop && size <= 48 && speedTier
    // Leaf site cap scales with body size — the cost of inlining N sites is
    // N·size nodes, not N: a 30-node pure leaf hammered from 9 sites (colorpq's
    // spow) is 270 spliced nodes, cheaper than 9 call frames per pixel, while a
    // 48-node body keeps the old 8-site bound (360/48 → 8). Full inlining also
    // restores shape identity for downstream CSE — a PARTIAL split (some sites
    // inlined, some calls) makes duplicate pure subtrees structurally unequal.
    const transitiveHotSite = (site, seen = new Set()) => {
      if (site.callerFunc?.body && containsNode(site.callerFunc.body, site.node, false)) return true
      const callerFunc = site.callerFunc
      const caller = callerFunc?.name
      // A tiny non-escaping wrapper may not be a candidate *yet* because it
      // calls the leaf currently being considered (sdRep ← sdf). Looking
      // through it breaks that harmless caller/callee collection cycle and
      // recognizes the same transitive hot path the next fixpoint would.
      const prospectiveLeaf = callerFunc && !isExported(callerFunc) &&
        !programFacts.addressTakenNames.has(caller) && loopDepth(callerFunc.body, 0) === 0 &&
        nodeSize(callerFunc.body) <= 48
      if (!caller || (!candidates.has(caller) && !prospectiveLeaf) || seen.has(caller)) return false
      const callerSites = sitesByCallee.get(caller)
      if (!callerSites?.length) return false
      const next = new Set(seen); next.add(caller)
      return callerSites.every(parent => transitiveHotSite(parent, next))
    }
    // The cap bounds duplication at sites outside loops: a site inside a loop
    // (or in a caller only loops reach) is the call the splice exists to remove,
    // and three's `fromArray`, `subVectors` and `normalize` reach it from a dozen.
    const coldSites = sites ? sites.filter(site => !transitiveHotSite(site)).length : 0
    const hotSites = sites ? sites.length - coldSites : 0
    const leafSiteCap = (isTinyLeaf || isSmallLeaf || isSmallKernel) ? Math.max(8, Math.floor(360 / Math.max(1, size))) : 8
    // Spliced at every site: a small body within its cap of cold sites, or a
    // larger one at two sites. A leaf's second copy is bounded: 200 nodes when
    // every site is hot (cloth's relax, ~160 nodes × 2 sites, fired per link
    // every relaxation pass), 48 when a site is not (noise's grad, called
    // from perlin: straight-line, but the per-pixel kernel itself). A sole
    // site copies nothing, whatever the size (Ray's intersectTriangle).
    // A tiny leaf has no cap at the speed tier: its body is the size of the
    // call it replaces, and the call is what joins the kinds of every site's
    // argument into one parameter (a library's `isnan`, `x !== x` at two
    // hundred sites, one of which passes a value of no known kind, tested each
    // for `undefined` and `null` besides).
    if (!sites?.length) continue
    const small = isTinyLeaf || isSmallLeaf || isSmallKernel
    const everywhere = factory || (small || fixedTypedArraySite ? coldSites <= leafSiteCap || (speedTier && isTinyLeaf) : sites.length <= 2)
      && (small || hasLoop || (sites.length - 1) * size <= (coldSites ? 48 : 200))
    // Past that budget a body still splices at its sites in loops, where the
    // call is the per-iteration cost the splice removes; its straight-line
    // sites keep the call and the body. three's `applyMatrix4` (~80 nodes,
    // a dozen sites) and `intersectsSphere` (a loop, three sites) reach the
    // kernels' loops this way. The duplication a hot site adds is bounded the
    // way the everywhere splice's is: two bodies of 200 nodes.
    const loopOnly = !everywhere && hotSites >= 1 && hotSites * size <= 400
    // Past both budgets the speed tier splices a straight-line body in a loop
    // while the caller has room (`CALLER_FULL`). The budgets above count a
    // callee's sites across the program, so a loop's time would depend on how
    // many other loops call the same function: a library's `sin` is as much
    // the body of the seventh loop that calls it as of the first.
    const warmBody = speedTier && !everywhere && !loopOnly && !hasLoop && hotSites >= 1 && size <= WARM_BODY
    // A loop that calls a parameter (a series summed from a generator, a continued
    // fraction from its terms) runs the argument once per pass: spliced where the
    // argument is a function the caller names or makes, the call is that function's
    // body. Such a site splices whatever the count of sites, at the speed tier: the
    // copy is what removes a call through a table from a loop.
    const called = speedTier && hasLoop && size <= 200 ? calledParams(func) : null
    const fnOnly = !everywhere && !loopOnly && !warmBody && called != null && called.length > 0
    if (!everywhere && !loopOnly && !warmBody && !fnOnly) continue
    // Expression-bodied arrow funcs (`(c) => expr`) have no block — body IS the
    // return value. Treat as a "tiny leaf" branch handled below; force hasLoop=false.
    // a closure's own `return` is no return of the body
    if (some(func.body, n => n[0] === '=>') && !closureSpliceable(func)) continue
    // A `break` or `continue` targets a loop or switch of this body and moves
    // with it; only a `throw` leaves the spliced body unsupported.
    if (some(func.body, n => n[0] === 'throw')) continue
    // Either a kernel (has a loop) or a tiny leaf (no loop, no calls, small body).
    // The leaf branch catches helpers like `isAlpha(c) => (c>=65 && c<=90) || …`
    // that get hammered from a hot caller's loop — replacing the call with its
    // body saves the per-iteration call+reinterpret overhead (tokenizer hot path).
    if (!hasLoop) {
      // Calls to functions that are THEMSELVES candidates are fine — they inline away;
      // only a call to a non-candidate user function blocks (the fixpoint re-checks:
      // a class factory calls its initializer, a candidate leaf, and is one itself).
      // Below speed, the callee must have this one site, so that splicing the caller
      // duplicates nothing a call kept shared (a guard's string compares into four
      // callers cost the flagship 6 KB), or be a leaf spliced at every site while
      // the caller has one: the caller's copy of it then moves, and nothing is added
      // (a filter's `lowpass`, calling the `base` and `norm` its siblings call too).
      // A leaf called only in loops takes a leaf callee along as well while the
      // copies stay within the hot bound, 200 nodes (a band-limited step and its
      // table lookup, called per sample from two sums): the calls are what the
      // loops pay for.
      // At speed a body of a loop's size takes the calls it keeps along (`lcm`
      // over `gcd`, whose loops stay a function), outside a cycle of calls.
      const inlinesAway = (callee) => candidates.has(callee) && (speedTier || sitesByCallee.get(callee)?.length === 1 ||
        (sites.length === 1 && leaves.has(callee) && !hotOnly.has(callee)) ||
        (coldSites === 0 && leaves.has(callee) && !hotOnly.has(callee) && sites.length * nodeSize(candidates.get(callee).body) <= 200))
      if (some(func.body, n => n[0] === '()' && typeof n[1] === 'string' && ctx.funcs.names.has(n[1]) && !inlinesAway(n[1])) &&
          !(speedTier && size <= WARM_BODY && !cyclic(func.name))) continue
    }
    if (some(func.body, n => n[0] === '()' && n[1] === func.name)) continue
    // Kernels with nested loops (depth ≥ 2) are typically large and the inner
    // loop carries most of the cost. Inlining them into a host that V8 can't
    // tier up (e.g. a once-called wrapper) freezes the kernel in baseline.
    // Keep them as standalone functions so V8 wasm tier-up can warm them.
    if (loopDepth(func.body, 0) >= 2 && !fullyFixedTypedArraySite) continue
    // Factory functions that allocate pointers (`new TypedArray`, `new Array`,
    // object/array literals returned) break downstream pointer-ABI specialization
    // when inlined: narrow.js can't trace the post-inline alias chain back to a
    // single ctor, so the typed-array param of a callee like processCascade(x, …)
    // stays at generic f64 ABI with __typed_idx dispatch instead of i32 + f64.load.
    // Keeping the factory as a callable function preserves the call-site type fact.
    // Scalar/void helpers do not return those pointers. Inlining their local
    // construction exposes ownership (notably setters into a fresh receiver).
    const constructs = some(func.body, n => n[0] === '()' && typeof n[1] === 'string' &&
      (n[1].startsWith('new.') || constructing.has(n[1])))
    const resultKind = tagOf(ctx.summary.resultOf(func.name))
    if (constructs && resultKind !== K.NUMBER && resultKind !== K.BOOL && resultKind !== K.NULLISH) continue
    // Keep cold, argument-free array builders intact through result inference.
    // Dynamic builders still inline here to expose their pointer flow; delaying
    // those loses narrowing without gaining a fixed result length.
    if (hasLoop && paramNames.size === 0 && tagOf(core(ctx.summary.resultOf(func.name))) === K.ARRAY &&
        !sites.some(site => site.callerFunc?.body && containsNode(site.callerFunc.body, site.node))) continue
    // Normalize only after the other eligibility checks: an outlined function
    // gains nothing from an extra result binding and branch.
    if (strayReturns(func) > 0 && lowerReturns(func)) changed = true
    if (strayReturns(func) > 0) continue
    if (paramNames.size && some(func.body, n => n[0] === '()' && typeof n[1] === 'string' && paramNames.has(n[1])))
      forwarders.add(func.name)
    if (!hasLoop) leaves.add(func.name); else kernels.add(func.name)
    if (loopOnly || warmBody) hotOnly.add(func.name)
    if (warmBody) warm.add(func.name)
    if (fnOnly) fnSites.set(func.name, called)
    candidates.set(func.name, func)
    if (constructs) constructing.add(func.name)
    recollect = true  // a function this one blocked (a caller of it) may qualify now
  }
  }
  if (!candidates.size) return changed

  // Trivial expr-bodied candidates can be substituted at any expression position
  // (if-condition, ternary, etc.). Stmt-bodied ones go through inlineInStmt's
  // statement-level path which preserves prefix ordering — EXCEPT flattenable
  // block bodies (pure-arith let decls + trailing return, e.g. distance's
  // dx/dy), which inlineInExpr turns into zero-prefix expressions per site.
  const flattenableBody = (func) => {
    const stmts = funcStmts(func.body)
    if (!stmts) return false
    return stmts.every((s, i) => i === stmts.length - 1
      ? Array.isArray(s) && s[0] === 'return'
      : Array.isArray(s) && (s[0] === 'let' || s[0] === 'const') && s.length === 2
        && Array.isArray(s[1]) && s[1][0] === '=' && typeof s[1][1] === 'string' && pureFlattenExpr(s[1][2]))
  }
  const exprOnlyCandidates = new Map()
  for (const func of candidates.values()) {
    const name = func.name
    if (!isBlockBody(func.body) || flattenableBody(func)) exprOnlyCandidates.set(name, func)
  }

  const exportedCandidates = new Map(), exportedExprCandidates = new Map()
  for (const func of candidates.values()) {
    const name = func.name
    const sites = sitesByCallee.get(name)
    const fixedSiteExported = hasFixedTypedArraySites(func, sites) &&
      !sites.some(site => isExported(site.callerFunc) && site.callerFunc.body && containsNode(site.callerFunc.body, site.node))
    // Forwarders cross into an exported caller too: the tier-up rationale that
    // keeps candidates out of exports concerns relocated loop kernels, not
    // these tiny leaves — and inlining one devirtualizes a closure dispatch.
    // A small helper already called inside export loops joins an existing hot
    // loop; this does not relocate a standalone kernel into a cold entry point.
    // Calls can hide a large kernel. Wait for their expansion before pricing
    // this body; otherwise a tiny wrapper pulls bulk work into a cold export.
    const hotKernelExport = speedTier && !bodyHasCall(func.body) && nodeSize(func.body) <= 48 &&
      sites.some(site => isExported(site.callerFunc)) &&
      sites.every(site => !isExported(site.callerFunc) || containsNode(site.callerFunc.body, site.node))
    // A loop-only candidate joins an export's loop by construction.
    if (hotKernelExport || fixedSiteExported || forwarders.has(name) || leaves.has(name) || hotOnly.has(name) || sites?.length === 1) {
      exportedCandidates.set(name, func)
      if (exprOnlyCandidates.has(name)) exportedExprCandidates.set(name, func)
    }
  }
  // Iterate to a (bounded) fixpoint: inlining a call whose args are themselves candidate calls
  // binds those args to temps (`t0 = grad(a)`); the next pass folds the candidate into the temp
  // decl. Depth is bounded by call nesting (a small constant), capped here so a pathological
  // chain can't loop unbounded.
  // Block bodies: the stmt path folds them only at a DIRECT `const X = call`,
  // never nested in an expression. Hoisting such a call to a temp (in the iter
  // fixpoint below) lets inlineInStmt then fold it — the noise `sum + amp*perlin(x)`
  // shape. A loop-free leaf hoists anywhere; a kernel (a loop of its own) and a
  // loop-only candidate hoist inside a loop only (`if (fr.intersectsSphere(s))`):
  // a kernel called in a cold expression position (a 2-site `reduce`) stays
  // outlined for V8 tier-up, and hoisting it would pull the loop into the caller.
  // The body with its candidate calls spliced, or null where none was.
  const splice = (body, isExprBody, activeCandidates, exprActive) => {
    const blockBodies = new Map(), anywhere = new Set()
    if (speedTier && !isExprBody) for (const f of activeCandidates.values()) {
      if (exprActive.has(f.name)) continue
      blockBodies.set(f.name, f.body)
      if (leaves.has(f.name) && !hotOnly.has(f.name)) anywhere.add(f.name)
      // a loop that calls its argument lifts wherever it is called: the splice there is the argument's body
      if (fnSites.has(f.name)) anywhere.add(f.name)
    }
    let bodyChanged = false
    for (let iter = 0; iter < 4; iter++) {
      let iterChanged = false
      callerSize = nodeSize(body)
      if (fnSites.size) boundFunctions(body)
      if (blockBodies.size) {
        const h = hoistNestedCalls(body, blockBodies, anywhere)
        if (h.changed) { body = h.node; iterChanged = true }
      }
      if (isExprBody) {
        const next = inlineInExpr(body, activeCandidates)
        if (next !== body) { body = next; iterChanged = true }
      } else {
        const r = inlineInStmt(body, activeCandidates)
        if (r) { body = r.node; iterChanged = true }
      }
      if (exprActive.size) {
        const next = inlineInExpr(body, exprActive)
        if (next !== body) { body = next; iterChanged = true }
      }
      if (!iterChanged) break
      bodyChanged = true
    }
    if (bodyChanged && isExprBody && some(body, n => n[0] === 'let' || n[0] === 'const'))
      body = block([['return', body]])
    return bodyChanged ? body : null
  }
  // Each closure's body, innermost first, spliced in place (the literal keeps
  // its identity and its parameter node, which name its scope): the body, or
  // null where no closure changed. Leaves only: a kernel keeps its own loop in
  // a function of its own, where the engine's tier-up warms it, rather than in
  // a callback that holds everything else a block runs (a host's process()
  // wrapping a filter ran its loop at half speed spliced there).
  const closureLeaves = new Map([...candidates].filter(([name]) => leaves.has(name) || kernels.has(name)))
  const closureExprLeaves = new Map([...exprOnlyCandidates].filter(([name]) => leaves.has(name)))
  const spliceClosures = (node) => {
    let changed = false
    walkAst(node, { exit: (n) => {
      if (n[0] !== '=>' || n[2] == null) return
      const view = callerView, stable = callerStable
      callerView = ctx.summary?.at(n[1]) ?? null
      callerStable = null
      inClosure = true
      const next = splice(n[2], !isBlockBody(n[2]), closureLeaves, closureExprLeaves)
      inClosure = false
      callerView = view
      callerStable = stable
      if (next != null) { n[2] = next; changed = true }
    } })
    return changed ? node : null
  }
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw || synthesized(func)) continue
    // Skip exports: they're entry points usually invoked once. Inlining a
    // hot kernel here would put the loop into a function V8's wasm tier-up
    // never warms (kernel stays in baseline). Keeping the kernel as its own
    // callable function lets V8 promote it to TurboFan after a few calls.
    // Exception: fixed-size typed-array callees should inline into the exported
    // caller so scalar replacement can cross the call boundary and remove the
    // caller's heap arrays.
    const activeCandidates = isExported(func) ? exportedCandidates : candidates
    callerView = ctx.summary?.at(func.sig) ?? null
    callerStable = stableNames(func)
    // Expression-bodied arrows (`() => expr`) have func.body as the return
    // value itself — never a `{}` block. inlineInStmt treats its argument as a
    // statement (discards the return value of any top-level candidate call),
    // which would turn `() => x()` into an empty block and lose the result.
    // Route those through inlineInExpr so the call is replaced by the inlined
    // value expression instead.
    const isExprBody = !isBlockBody(func.body)
    // Expression-position pass takes the leaf-safe subset for exports — the same tier-up
    // rationale as the statement path (leaves into exports are fine; relocated kernels are not).
    const exprActive = isExported(func) ? exportedExprCandidates : exprOnlyCandidates
    // Iterate to a (bounded) fixpoint: inlining a call whose args are themselves candidate calls
    // binds those args to temps (`t0 = grad(a)`); the next pass folds the candidate into the temp
    // decl. Depth is bounded by call nesting (a small constant), capped here so a pathological
    // chain can't loop unbounded.
    // Block bodies: the stmt path folds them only at a DIRECT `const X = call`,
    // never nested in an expression. Hoisting such a call to a temp (in the iter
    // fixpoint below) lets inlineInStmt then fold it — the noise `sum + amp*perlin(x)`
    // shape. A loop-free leaf hoists anywhere; a kernel (a loop of its own) and a
    // loop-only candidate hoist inside a loop only (`if (fr.intersectsSphere(s))`):
    // a kernel called in a cold expression position (a 2-site `reduce`) stays
    // outlined for V8 tier-up, and hoisting it would pull the loop into the caller.
    const spliced = isExported(func) && !activeCandidates.size ? null : splice(func.body, isExprBody, activeCandidates, exprActive)
    // A closure is a caller of its own: the callback a factory returns
    // (`makeProcess(t)` → `(mag, phase, state) => …`) runs the per-frame loops
    // a leaf it calls sits in. Its body takes the splices a function's does.
    const inner = spliceClosures(spliced ?? func.body)
    const body = inner ?? spliced
    const bodyChanged = body != null
    if (bodyChanged) { func.body = body; changed = true }
  }
  if (ast) {
    const r = inlineInStmt(ast, candidates)
    if (r) changed = true
  }
  return changed
}

// === Inline non-escaping local lambdas ===
// `const f = (a) => …; … f(x) …` → the lambda body substituted at each call
// site. A non-escaping lambda's captured free vars are still in lexical scope at
// the call site, so splicing the body in place preserves capture-by-reference
// semantics while eliminating the closure object (no env pointer, no NaN-box, no
// call_indirect). Mirrors inlineHotInternalCalls, scoped to one function body.

// True iff every textual reference to `name` in `node` is the callee of a
// `name(...)` call (i.e. the binding never escapes — never read as a value,
// reassigned, captured by a nested lambda, or shadowed).
const onlyCalledNotReferenced = (node, name) => {
  if (typeof node === 'string') return node !== name
  if (!Array.isArray(node)) return true
  const op = node[0]
  if (op === 'str') return true
  // A nested lambda touching `name` at all (capture or shadowing param) → bail.
  if (op === '=>') return !refsName(node[1], name, REFS_IN_EXPR) && !refsName(node[2], name, REFS_IN_EXPR)
  if (op === '()' && node[1] === name) {
    for (let i = 2; i < node.length; i++) if (!onlyCalledNotReferenced(node[i], name)) return false
    return true
  }
  if (op === '.' || op === '?.') return onlyCalledNotReferenced(node[1], name)
  if (op === ':') return onlyCalledNotReferenced(node[2], name)
  for (let i = 1; i < node.length; i++) if (!onlyCalledNotReferenced(node[i], name)) return false
  return true
}

const bodyStmtList = body =>
  Array.isArray(body) && body[0] === '{}' ? blockStmts(body)
  : Array.isArray(body) && body[0] === ';' ? body.slice(1)
  : body == null ? [] : [body]

const removeStmts = (body, set) => {
  if (!Array.isArray(body)) return set.has(body) ? null : body
  if (body[0] === '{}') return ['{}', removeStmts(body[1], set) ?? [';']]
  if (body[0] === ';') {
    const kept = body.slice(1).filter(s => !set.has(s))
    return kept.length === 0 ? null : kept.length === 1 ? kept[0] : [';', ...kept]
  }
  return set.has(body) ? null : body
}

// Lambda body must be a guaranteed-return shape inlinedBody can splice: ≤1
// `return` (trailing, if a block), no throw/break/continue, no param mutation,
// no nested lambda.
const inlinableLambdaBody = (abody, params) => {
  if (some(abody, n => n[0] === '=>')) return false
  if (some(abody, n => n[0] === 'throw' || n[0] === 'break' || n[0] === 'continue')) return false
  let returns = 0
  some(abody, n => { if (n[0] === 'return') returns++; return false })
  if (returns > 1) return false
  if (returns === 1) {
    const stmts = blockStmts(abody)
    if (!stmts || !stmts.length) return false
    const last = stmts[stmts.length - 1]
    if (!Array.isArray(last) || last[0] !== 'return') return false
  }
  return !mutatesAny(abody, new Set(params))
}

const inlineLocalLambdasInBody = (getBody, setBody) => {
  const body = getBody()
  const stmts = bodyStmtList(body)
  if (stmts.length < 2) return false

  // Collect `const f = ARROW` / `let f = ARROW` (single-decl), all-plain params,
  // inlinable body. A `let` is admitted on the same terms: the mention check
  // below rejects any write to the name, so a surviving `let` is a const.
  const decls = new Map()
  for (const stmt of stmts) {
    if (!Array.isArray(stmt) || (stmt[0] !== 'const' && stmt[0] !== 'let') || stmt.length !== 2) continue
    const d = stmt[1]
    if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') continue
    const arrow = d[2]
    if (!Array.isArray(arrow) || arrow[0] !== '=>') continue
    const params = extractParams(arrow[1])
    if (!params.every(p => typeof p === 'string')) continue
    if (!inlinableLambdaBody(arrow[2], params)) continue
    decls.set(d[1], { stmt, arrow, params })
  }
  if (!decls.size) return false

  // Drop any candidate whose body references another (or its own) candidate —
  // single-level inlining can't resolve such chains, and a still-referenced
  // candidate's decl can't be removed.
  for (let changed = true; changed;) {
    changed = false
    for (const [name, info] of decls) {
      if ([...decls.keys()].some(c => refsName(info.arrow[2], c, REFS_IN_EXPR))) { decls.delete(name); changed = true }
    }
  }
  // Every other reference to the name must be a `name(...)` call.
  for (const [name, info] of [...decls]) {
    if (!stmts.every(s => s === info.stmt || onlyCalledNotReferenced(s, name))) decls.delete(name)
  }
  if (!decls.size) return false

  const asFunc = info => ({ sig: { params: info.params.map(name => ({ name })) }, body: info.arrow[2] })
  // A small loop-free block body (`const rnd = () => { s ^= …; return s >>> 0 }`)
  // is reached in expression position by hoisting the call to a temp decl
  // first — the closure it would otherwise become (env cell, boxed capture,
  // f64 return) costs more than the spliced body at every site. Kept only
  // when EVERY site folds: a surviving site would leave the closure alive
  // beside the copies, so the pass reruns without that candidate.
  const hoistable = (info) => isBlockBody(info.arrow[2])
    && !some(info.arrow[2], n => LOOP_OPS.has(n[0])) && nodeSize(info.arrow[2]) <= 48
  for (;;) {
    const stmtCands = new Map(), exprCands = new Map(), bodies = new Map()
    for (const [name, info] of decls) {
      (isBlockBody(info.arrow[2]) ? stmtCands : exprCands).set(name, asFunc(info))
      if (hoistable(info)) bodies.set(name, info.arrow[2])
    }
    let out = body, didChange = false
    if (bodies.size) {
      const h = hoistNestedCalls(out, bodies)
      if (h.changed) { out = h.node; didChange = true }
    }
    if (stmtCands.size) { const r = inlineInStmt(out, stmtCands); if (r) { out = r.node; didChange = true } }
    if (exprCands.size) { const next = inlineInExpr(out, exprCands); if (next !== out) { out = next; didChange = true } }
    if (!didChange) return false

    // Remove decls of candidates that are now fully consumed; a hoisted
    // candidate that survives is withdrawn and the body rebuilt without it.
    const newStmts = bodyStmtList(out)
    const dead = new Set()
    let retry = false
    for (const [name, info] of decls) {
      if (!newStmts.some(s => s !== info.stmt && refsName(s, name, REFS_IN_EXPR))) dead.add(info.stmt)
      else if (bodies.has(name)) { decls.delete(name); retry = true }
    }
    if (retry) { if (!decls.size) return false; continue }
    if (dead.size) out = removeStmts(out, dead) ?? [';']
    setBody(out)
    return true
  }
}

// the mentions of `name` in `n`: a property name and a key mention no binding
const mentionCount = (n, name) => {
  if (n === name) return 1
  if (!Array.isArray(n) || n[0] === 'str') return 0
  if (n[0] === '.' || n[0] === '?.') return mentionCount(n[1], name)
  if (n[0] === ':') return mentionCount(n[2], name)
  let c = 0
  for (let i = 1; i < n.length; i++) c += mentionCount(n[i], name)
  return c
}
const lambdaDecl = (s) => Array.isArray(s) && (s[0] === 'const' || s[0] === 'let') && s.length === 2 &&
  Array.isArray(s[1]) && s[1][0] === '=' && typeof s[1][1] === 'string' && Array.isArray(s[1][2]) && s[1][2][0] === '=>' ? s[1][1] : null

// A lambda declared in a list of its own (a loop's body, an arm: where a spliced
// call left it) is local to that list where nothing outside it mentions the
// name: the same splice, the list as the body.
const inlineLambdasInLists = (node, root) => {
  if (!Array.isArray(node) || node[0] === '=>' || node[0] === 'str') return false
  let changed = false
  for (let i = 1; i < node.length; i++) {
    const c = node[i]
    if (!Array.isArray(c)) continue
    if (inlineLambdasInLists(c, root)) changed = true
    if (c[0] !== ';') continue
    const names = c.map(lambdaDecl).filter(n => n != null)
    if (!names.length || !names.every(name => mentionCount(c, name) === mentionCount(root, name))) continue
    if (inlineLocalLambdasInBody(() => node[i], b => { node[i] = Array.isArray(b) && b[0] === ';' ? b : [';', b] })) changed = true
  }
  return changed
}

export const inlineLocalLambdas = () => {
  // `optimize: { sourceInline: false }` asks for no source-level inlining at
  // all: the closure form stays (the tests of closure lowering read it).
  if (ctx.transform.optimize?.sourceInline === false) return false
  let changed = false
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw) continue
    if (inlineLocalLambdasInBody(() => func.body, b => { func.body = b })) changed = true
    if (Array.isArray(func.body) && func.body[0] === '{}' && Array.isArray(func.body[1]) && inlineLambdasInLists(func.body[1], func.body)) changed = true
  }
  return changed
}

const restIndexExpr = (idx, restParams) => {
  const k = constIntExpr(idx)
  if (k != null) return k >= 0 && k < restParams.length ? restParams[k] : [, undefined]

  let out = [, undefined]
  for (let i = restParams.length - 1; i >= 0; i--) {
    out = ['?:', ['==', clonePlain(idx), [, i]], restParams[i], out]
  }
  return out
}

// The rest's `for…of` alias (`let a = __iter_arr(rest)`, prepare/handlers.js)
// reads the same fixed arguments: its binding is dropped and its mentions
// rewrite as the rest's own.
const isIterAlias = (d, rest) => Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string'
  && Array.isArray(d[2]) && d[2][0] === '()' && d[2][1] === '__iter_arr' && d[2][2] === rest

const COMPARE_OPS = new Set(['<', '<=', '>', '>=', '===', '!==', '==', '!='])
const compare = (op, a, b) => op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : op === '>=' ? a >= b : op === '===' || op === '==' ? a === b : a !== b
const isArr = Array.isArray

const rewriteRestBody = (body, restName, restParams) => {
  const names = new Set([restName])
  walkAst(body, { enter: n => {
    if (n[0] === 'let' || n[0] === 'const') for (let i = 1; i < n.length; i++) if (isIterAlias(n[i], restName)) names.add(n[i][1])
  } })
  const rewrite = (node) => {
    if (typeof node === 'string') return names.has(node) ? { ok: false } : { ok: true, node }
    if (!Array.isArray(node)) return { ok: true, node }
    if (node[0] === 'str') return { ok: true, node: node.slice() }

    // Replacing a rest element with an argument slot is a read-only view.
    // Writes need the array's independent storage, including missing indices.
    if ((MUTATE_OPS.has(node[0]) || node[0] === 'delete') && Array.isArray(node[1]) &&
        (node[1][0] === '[]' || node[1][0] === '.') && names.has(node[1][1])) return { ok: false }

    if ((node[0] === '.' || node[0] === '?.') && names.has(node[1])) {
      return node[2] === 'length' ? { ok: true, node: [, restParams.length], count: true } : { ok: false }
    }

    if (node[0] === '[]' && names.has(node[1])) {
      if (!isSimpleArg(node[2])) return { ok: false }
      return { ok: true, node: restIndexExpr(node[2], restParams) }
    }

    const out = [node[0]]
    let count = false
    for (let i = 1; i < node.length; i++) {
      if ((node[0] === 'let' || node[0] === 'const') && isIterAlias(node[i], restName)) continue
      const r = rewrite(node[i])
      if (!r.ok) return r
      if (r.count) count = true
      out.push(r.node)
    }
    if ((node[0] === 'let' || node[0] === 'const') && out.length === 1) return { ok: false }   // the alias alone
    // The count of arguments is a number here: a test of it is decided, and the
    // arm it rules out is no code of this variant (`if ( arguments.length > 1 )`).
    if (count && COMPARE_OPS.has(out[0]) && out.length === 3) {
      const a = constNumExpr(out[1]), b = constNumExpr(out[2])
      if (a != null && b != null) return { ok: true, node: [, compare(out[0], a, b)] }
    }
    if ((out[0] === 'if' || out[0] === '?:' || out[0] === '?') && isArr(out[1]) && out[1].length === 2 && out[1][0] == null && typeof out[1][1] === 'boolean')
      return { ok: true, node: out[1][1] ? out[2] : out[3] ?? (out[0] === 'if' ? [';'] : [, undefined]) }
    return { ok: true, node: out }
  }
  return rewrite(body)
}

export const specializeFixedRestCalls = (programFacts) => {
  const sitesByKey = new Map()
  for (const site of programFacts.callSites) {
    // Synthesized sites (program-facts.js's synthesizeComputedDispatchCallSites)
    // may share `.node` with a sibling synthesized site or the outer
    // computed-dispatch call itself — setCallArgs below rewrites a call
    // node's own arguments in place, which would corrupt whichever of those
    // it doesn't own exclusively. These sites exist only to feed the
    // read-only census; never select them for a rewrite (mirrors variant.js's
    // identical retarget-loop skip, for the same reason).
    if (site.synthetic) continue
    const func = ctx.funcs.map.get(site.callee)
    if (!func?.rest || isExported(func) || func.raw || !func.body) continue
    if (programFacts.addressTakenNames.has(func.name)) continue
    if (func.defaults && Object.keys(func.defaults).length) continue
    if (site.argList.some(a => Array.isArray(a) && a[0] === '...')) continue

    const fixedN = func.sig.params.length - 1
    const restN = Math.max(0, site.argList.length - fixedN)
    const key = `${func.name}/${restN}`
    const list = sitesByKey.get(key)
    if (list) list.push(site); else sitesByKey.set(key, [site])
  }

  let changed = false
  for (const [key, sites] of sitesByKey) {
    const [name, restNText] = key.split('/')
    const func = ctx.funcs.map.get(name)
    const restN = Number(restNText)
    const fixedParams = func.sig.params.slice(0, -1).map(p => ({ ...p }))
    const restName = func.rest
    const restParams = Array.from({ length: restN }, (_, i) => `${restName}${T}r${restN}_${i}`)
    const rewritten = rewriteRestBody(func.body, restName, restParams)
    if (!rewritten.ok) continue

    const cloneName = `${name}${T}rest${restN}`
    // `key: cloneName` — idempotent identity: name+restN is a deterministic,
    // unique key, so a func already registered under it (from an earlier
    // call into this same builder) IS this variant, reused as-is rather than
    // re-cloned. Build the specialized sig fresh. `params`/`results` are
    // sig's only fields and both are replaced here, so a `{ ...func.sig, … }`
    // spread would be pure redundancy — and a full-override spread of a live
    // sig object also trips the self-compile codegen, so the explicit form is
    // both simpler and the one that round-trips through jz.wasm.
    materializeVariant({
      origin: func, key: cloneName, name: cloneName, kind: 'fixed-rest',
      sig: { params: [...fixedParams, ...restParams.map(name => ({ name, type: 'f64' }))], results: [...func.sig.results] },
      body: rewritten.node,
      rest: null,
      eligibleSites: sites, fallback: func,
    })

    const fixedN = func.sig.params.length - 1
    for (const site of sites) {
      setCallArgs(site.node, site.argList.slice(0, fixedN + restN))
      changed = true
    }
  }
  return changed
}
