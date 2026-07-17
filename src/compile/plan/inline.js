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
 * Each transform mutates `ctx.func.list` / `func.body` and returns `boolean`
 * indicating whether anything changed (so `plan()` knows to invalidate the
 * program-facts cache).
 *
 * @module compile/plan/inline
 */

import { ctx } from '../../ctx.js'
import {
  callArgs, setCallArgs, some, blockStmts, T, refsName, refsAny, REFS_IN_EXPR,
  extractParams,
} from '../../ast.js'
import { cloneWithSubst } from '../../type.js'
import { constIntExpr } from '../../static.js'
import { analyzeBody } from '../analyze.js'
import {
  LOOP_OPS, isSimpleArg, mutatesAny, loopDepth, nodeSize, clonePlain, collectBindings,
  fixedTypedArraysInBody, forLoopBodyIndex, withForLoopBody,
} from './common.js'

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
const eagerCallFreeBooleans = n => {
  if (!Array.isArray(n) || n[0] === '=>') return n
  // Encode leaf provenance in an internal AST operator rather than an array
  // side-property: subsequent plan transforms clone arrays but preserve op
  // strings. Emit still proves both lowered operands pure before going eager,
  // so generic parameters that need coercion retain short-circuit semantics.
  if ((n[0] === '&&' || n[0] === '||') && pureCanonicalBool(n)) {
    for (let i = 1; i < n.length; i++) eagerCallFreeBooleans(n[i])
    n[0] = n[0] === '&&' ? '__eager&&' : '__eager||'
    return n
  }
  for (let i = 1; i < n.length; i++) eagerCallFreeBooleans(n[i])
  return n
}
const bodyHasCall = body => some(body, n => n[0] === '()' || n[0] === 'new')

const inlinedBody = (func, args) => {
  const params = func.sig.params
  if (args.length !== params.length) return null
  const paramNames = new Set(params.map(p => p.name))
  if (mutatesAny(func.body, paramNames)) return null

  // A simple arg (ident / literal / arithmetic) is cheap to substitute directly, even when its
  // param is used several times. A NON-simple arg (a call, `?:`, indexed load) is bound to a fresh
  // temp evaluated ONCE in call order — preserving evaluation count + left-to-right order, and
  // never duplicating the expression. This lets nested calls inline: `lerp(grad(a), grad(b), u)`
  // binds `t0 = grad(a); t1 = grad(b)` and substitutes the body with t0/t1; a later inliner pass
  // then folds grad into those temp decls (the fixpoint in inlineHotInternalCalls).
  const subst = new Map()
  const argPrefix = []
  for (let i = 0; i < params.length; i++) {
    const arg = args[i]
    if (isSimpleArg(arg)) { subst.set(params[i].name, arg); continue }
    const tmp = `${T}inarg${ctx.func.uniq++}`
    argPrefix.push(['const', ['=', tmp, arg]])
    subst.set(params[i].name, tmp)
  }

  const locals = new Set()
  collectBindings(func.body, locals)
  for (const p of params) locals.delete(p.name)

  const rename = new Map()
  for (const name of locals) rename.set(name, `${T}inl${ctx.func.uniq++}_${name}`)

  const stmts = blockStmts(func.body)
  const mark = bodyHasCall(func.body) ? n => n : eagerCallFreeBooleans
  // Expression-bodied arrow `(c) => expr`: no statement block; the whole body
  // *is* the return value. Treat as zero-prefix + value.
  if (!stmts) return { prefix: argPrefix, value: mark(cloneWithSubst(func.body, subst, rename)) }
  const last = stmts.length ? stmts[stmts.length - 1] : null
  const isTrailingReturn = Array.isArray(last) && last[0] === 'return'
  const prefixSrc = isTrailingReturn ? stmts.slice(0, -1) : stmts
  const prefix = prefixSrc.map(stmt => mark(cloneWithSubst(stmt, subst, rename)))
  const value = isTrailingReturn && last.length > 1 ? mark(cloneWithSubst(last[1], subst, rename)) : null
  return { prefix: argPrefix.length ? [...argPrefix, ...prefix] : prefix, value }
}

const stmtDeclName = (stmt) => {
  if (!Array.isArray(stmt) || (stmt[0] !== 'let' && stmt[0] !== 'const') || stmt.length !== 2) return null
  const decl = stmt[1]
  return Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string' ? decl[1] : null
}

const whileInductionVar = (cond) => {
  if (typeof cond === 'string') return cond
  if (!Array.isArray(cond)) return null
  const op = cond[0]
  if ((op === '<' || op === '<=' || op === '>' || op === '>=') && typeof cond[1] === 'string') return cond[1]
  return null
}

// When splicing an inlined kernel into a loop, hoist leading decls that do not
// reference the loop induction var (e.g. floatbeat chord tables).
const partitionInvariantPrefix = (prefix, variantNames) => {
  if (!prefix.length || !variantNames?.size) return { hoisted: [], rest: prefix }
  const hoisted = []
  let i = 0
  for (; i < prefix.length; i++) {
    const s = prefix[i]
    if (!stmtDeclName(s) || refsAny(s, variantNames, REFS_IN_EXPR)) break
    hoisted.push(s)
  }
  return { hoisted, rest: prefix.slice(i) }
}

const spliceInlinedShape = (prefix, valueStmt, loopVariantNames) => {
  const { hoisted, rest } = partitionInvariantPrefix(prefix, loopVariantNames)
  const splice = [...rest, valueStmt]
  return { node: ['{}', [';', ...splice]], splice, hoisted, changed: true }
}

const isCandidateCall = (node, candidates) =>
  Array.isArray(node) && node[0] === '()' && typeof node[1] === 'string' && candidates.has(node[1])

// Prefix flattening for expression-position inlining. A helper like
//   let distance = (x1,y1,x2,y2) => { let dx=x1-x2; let dy=y1-y2; return Math.sqrt(dx*dx+dy*dy) }
// called as `Math.sin(distance(...) * res)` can't splice statements into an
// expression context — but when every prefix stmt is `let name = <pure
// arithmetic>`, substituting the decls into the return value turns it into a
// zero-prefix expression. Duplicated subtrees (`dx` used twice → `x1-x2`
// twice) are pure, and the watr-layer CSE collapses the copies.
const PURE_FLATTEN_OPS = new Set([
  '+', '-', '*', '/', '%', 'u-', 'u+', '&', '|', '^', '<<', '>>', '>>>',
  // pure value-producing ops with no side effects — safe to duplicate (CSE collapses copies):
  // comparisons, logical, bit-not, and the conditional. Lets a branchy leaf like noise's
  // `grad(h,x,y) => { …; u = (h&1)===0 ? x : -x; … }` flatten to an expression so it inlines
  // into its multi-call caller `perlin` — `lerp(grad(a), grad(b), u)` then collapses end to end.
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
  if (op === '()' && n.length === 2) return pureFlattenExpr(n[1])   // grouping parens
  // Native SIMD constructors/arithmetic are effect-free and non-trapping. Let
  // expression-bodied v128 wrappers flatten complex SIMD arguments just like
  // scalar arithmetic; this enables the normal statement inliner to reach a
  // larger block-bodied helper nested underneath (sdf → sdRep).
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
  for (const stmt of shape.prefix) {
    if (!Array.isArray(stmt) || (stmt[0] !== 'let' && stmt[0] !== 'const') || stmt.length !== 2) return null
    const d = stmt[1]
    if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string' || !pureFlattenExpr(d[2])) return null
    subst.set(d[1], substIdents(d[2], subst))  // earlier decls feed later RHSs
  }
  const value = substIdents(shape.value, subst)
  if (nodeSize(value) > 200) return null  // duplication blow-up guard
  return { prefix: [], value }
}

// Recursively substitute calls to expr-bodied candidates anywhere in `node`.
// Used for tiny pure-expression helpers (`isAlpha(c) => …`) that get called
// from expression contexts (if-conditions, ternary tests). For these the
// inlined body is value-only (zero prefix), so a pure substitution is safe.
const inlineInExpr = (node, candidates) => {
  if (!Array.isArray(node)) return { node, changed: false }
  if (node[0] === '=>') return { node, changed: false }
  let changed = false
  const next = [node[0]]
  for (let i = 1; i < node.length; i++) {
    const r = inlineInExpr(node[i], candidates)
    if (r.changed) changed = true
    next.push(r.node)
  }
  if (isCandidateCall(next, candidates)) {
    const args = callArgs(next)
    const shape = flattenPrefix(args && inlinedBody(candidates.get(next[1]), args))
    if (shape && shape.value !== null && shape.prefix.length === 0) {
      return { node: shape.value, changed: true }
    }
  }
  return { node: changed ? next : node, changed }
}

const inlineInStmt = (stmt, candidates, loopVariantNames = null) => {
  if (!Array.isArray(stmt)) return { node: stmt, changed: false }
  // Statement-position call: the result is unused, but the callee's return
  // EXPRESSION may still carry side effects — an expression-bodied arrow whose body
  // is itself effectful (`seek = n => idx = n` inlines to the assignment `idx = i`;
  // a one-liner that calls another fn) puts the effect in `value`, not `prefix`.
  // Emit it as a trailing statement so the effect runs; a pure value is dropped
  // later by vacuum/DCE. (Dropping it lost the parser's seek() idx-advance → ∞ loop.)
  if (isCandidateCall(stmt, candidates)) {
    const args = callArgs(stmt)
    const shape = args && inlinedBody(candidates.get(stmt[1]), args)
    if (shape) {
      const { hoisted, rest } = partitionInvariantPrefix(shape.prefix, loopVariantNames)
      const splice = shape.value !== null ? [...rest, shape.value] : rest
      return { node: ['{}', [';', ...splice]], changed: true, splice, hoisted }
    }
  }
  // `let/const X = call(...)` with single decl: inline as prefix + decl(value).
  if ((stmt[0] === 'let' || stmt[0] === 'const') && stmt.length === 2) {
    const decl = stmt[1]
    if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string' && isCandidateCall(decl[2], candidates)) {
      const args = callArgs(decl[2])
      const shape = args && inlinedBody(candidates.get(decl[2][1]), args)
      if (shape && shape.value !== null) {
        const { hoisted, rest } = partitionInvariantPrefix(shape.prefix, loopVariantNames)
        const splice = [...rest, [stmt[0], ['=', decl[1], shape.value]]]
        return { node: ['{}', [';', ...splice]], changed: true, splice, hoisted }
      }
    }
  }
  // `X = call(...)` at statement position: inline as prefix + assign(value).
  // LHS may be a name or an indexed lvalue (`out[i] = beat(...)` in fill loops).
  if (stmt[0] === '=' && isCandidateCall(stmt[2], candidates)) {
    const args = callArgs(stmt[2])
    const shape = args && inlinedBody(candidates.get(stmt[2][1]), args)
    if (shape && shape.value !== null) {
      return spliceInlinedShape(shape.prefix, ['=', stmt[1], shape.value], loopVariantNames)
    }
  }
  const op = stmt[0]
  if (op === ';') {
    let changed = false
    const next = [';']
    for (let i = 1; i < stmt.length; i++) {
      const r = inlineInStmt(stmt[i], candidates, loopVariantNames)
      changed ||= r.changed
      if (r.hoisted?.length) {
        next.push(...r.hoisted)
        changed = true
      }
      if (r.splice) next.push(...r.splice)
      else next.push(r.node)
    }
    return changed ? { node: next, changed: true } : { node: stmt, changed: false }
  }
  if (op === '{}') {
    const r = inlineInStmt(stmt[1], candidates, loopVariantNames)
    if (!r.changed) return { node: stmt, changed: false }
    // If the child was itself a candidate call (or a let/assign-of-call), it
    // already returned a `['{}', [';', ...prefix]]` shape. Re-wrapping here
    // would yield `['{}', ['{}', …]]`, which codegen rejects ("Unknown op: {}").
    if (Array.isArray(r.node) && r.node[0] === '{}') return { node: r.node, changed: true, hoisted: r.hoisted }
    return { node: ['{}', r.node], changed: true, hoisted: r.hoisted }
  }
  if (op === 'for') {
    const idx = forLoopBodyIndex(stmt)
    const vars = loopVariantNames ? new Set(loopVariantNames) : new Set()
    const r = inlineInStmt(stmt[idx], candidates, vars.size ? vars : null)
    if (!r.changed) return { node: stmt, changed: false }
    return { node: withForLoopBody(stmt, r.node), changed: true, hoisted: r.hoisted }
  }
  if (op === 'while') {
    const vars = loopVariantNames ? new Set(loopVariantNames) : new Set()
    const ind = whileInductionVar(stmt[1])
    if (ind) vars.add(ind)
    const r = inlineInStmt(stmt[2], candidates, vars.size ? vars : null)
    if (!r.changed) return { node: stmt, changed: false }
    return { node: ['while', stmt[1], r.node], changed: true, hoisted: r.hoisted }
  }
  if (op === 'if') {
    const thenR = inlineInStmt(stmt[2], candidates, loopVariantNames)
    const elseR = stmt.length > 3 ? inlineInStmt(stmt[3], candidates, loopVariantNames) : null
    if (thenR.changed || elseR?.changed) return {
      node: stmt.length > 3 ? ['if', stmt[1], thenR.node, elseR.node] : ['if', stmt[1], thenR.node],
      changed: true,
      hoisted: [...(thenR.hoisted || []), ...(elseR?.hoisted || [])],
    }
  }
  if (op === 'try' || op === 'catch' || op === 'finally') {
    let changed = false
    const next = [op]
    let hoisted = []
    for (let i = 1; i < stmt.length; i++) {
      const part = stmt[i]
      const r = Array.isArray(part) ? inlineInStmt(part, candidates, loopVariantNames) : { node: part, changed: false }
      changed ||= r.changed
      if (r.hoisted?.length) hoisted = hoisted.concat(r.hoisted)
      next.push(r.node)
    }
    return changed ? { node: next, changed: true, hoisted } : { node: stmt, changed: false }
  }
  return { node: stmt, changed: false }
}

// Short-circuit operators: only the FIRST operand is unconditionally evaluated; a call in
// a later operand might not run, so it can't be hoisted.
const SHORT_CIRCUIT = new Set(['?:', '?', '&&', '||', '??'])
// Optional chaining: jz's own desugaring already tees the base to evaluate it once, and
// the key/args run conditionally — so the hoist treats the WHOLE expression as opaque (no
// operand, not even the base, is hoisted out) to avoid colliding with that desugaring.
const OPTIONAL_CHAIN = new Set(['?.', '?.[]', '?.()'])
// Mutating expression operators — evaluating one is an observable side effect.
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '**=', '&&=', '||=', '??=', '++', '--'])
// Does evaluating this expression have an observable side effect (a call or assignment)?
const containsEffect = (n) => Array.isArray(n) && n[0] !== '=>' &&
  ((n[0] === '()' && !pureSIMDCall(n)) || n[0] === '?.()' || ASSIGN_OPS.has(n[0]) || n.slice(1).some(containsEffect))

// Hoist an unconditionally-evaluated NESTED call to a block-body candidate out to a
// preceding `const __h = call(...)` temp. inlineInStmt folds block-body candidates only at
// a DIRECT `const X = call` / `X = call`; a call buried in an expression (noise's
// `sum = sum + amp * perlin(x)`) is reached by neither that path nor inlineInExpr (which
// only substitutes zero-prefix expr-bodies). Hoisting normalizes it to the direct form.
// Only block-body candidates and only unconditional positions — preserving evaluation order
// + count. Statement HEADERS that are expression positions (for-init/update, while/if test)
// are left untouched: there's no sound place for a hoisted decl there, so those calls just
// stay outlined. Conservatively leaves unrecognized statement shapes alone.
const hoistNestedCalls = (body, blockNames) => {
  if (!blockNames.size || !Array.isArray(body)) return { node: body, changed: false }
  let changed = false
  const seq = (stmts) => stmts.length === 1 ? stmts[0] : [';', ...stmts]
  // Lifting a call to the pre-decl block moves its evaluation to the TOP of the statement.
  // Sound only if no observable side effect is evaluated BEFORE it — else its effect jumps
  // ahead of that one (`a() + helper(x)` must keep a()'s effect first). `eff.seen` threads
  // left-to-right through evaluation order: a call or assignment LEFT IN PLACE marks every
  // later position. A hoisted call moves as a unit — its args run in a fresh inner eff, and
  // it does NOT advance the outer eff (the whole unit relocates together, order intact).
  const hExpr = (n, pre, cond, eff) => {
    if (!Array.isArray(n) || n[0] === '=>') return n
    if (!cond && !eff.seen && n[0] === '()' && typeof n[1] === 'string' && blockNames.has(n[1])) {
      const call = [n[0], n[1], ...n.slice(2).map(a => hExpr(a, pre, false, { seen: false }))]
      const tmp = `${T}inl${ctx.func.uniq++}_h`
      pre.push(['const', ['=', tmp, call]])
      changed = true
      return [null, tmp]
    }
    if (OPTIONAL_CHAIN.has(n[0])) {
      const out = [n[0], ...n.slice(1).map(c => hExpr(c, pre, true, eff))]
      if (n[0] === '?.()') eff.seen = true  // optional CALL may run
      return out
    }
    if (SHORT_CIRCUIT.has(n[0]))
      return [n[0], hExpr(n[1], pre, cond, eff), ...n.slice(2).map(c => hExpr(c, pre, true, eff))]
    const out = [n[0], ...n.slice(1).map(c => hExpr(c, pre, cond, eff))]
    if ((n[0] === '()' && !pureSIMDCall(n)) || ASSIGN_OPS.has(n[0])) eff.seen = true  // an effectful call/assign left in place is an effect
    return out
  }
  // A RHS that is DIRECTLY a candidate call is already folded by inlineInStmt's
  // `const X = call` / `X = call` paths — hoisting it would be redundant and (for an
  // object/array-literal `{}`-bodied factory) would break the post-inline alias chain.
  // Only hoist NESTED calls; leave a top-level direct call to those paths.
  const directCall = (e) => Array.isArray(e) && e[0] === '()' && typeof e[1] === 'string' && blockNames.has(e[1])
  const hStmt = (s) => {  // → array of statements (hoisted decls prepended)
    if (!Array.isArray(s)) return [s]
    switch (s[0]) {
      case ';': return [[';', ...s.slice(1).flatMap(hStmt)]]
      case '{}': return [['{}', seq(hStmt(s[1]))]]
      case 'if': return [s.length > 3
        ? ['if', s[1], seq(hStmt(s[2])), seq(hStmt(s[3]))]
        : ['if', s[1], seq(hStmt(s[2]))]]
      case 'for': { const i = forLoopBodyIndex(s); return [withForLoopBody(s, seq(hStmt(s[i])))] }
      case 'while': return [['while', s[1], seq(hStmt(s[2]))]]
      case 'let': case 'const': {
        if (s.length === 2 && Array.isArray(s[1]) && s[1][0] === '=' && typeof s[1][1] === 'string' && !directCall(s[1][2])) {
          const pre = []; const rhs = hExpr(s[1][2], pre, false, { seen: false })
          return pre.length ? [...pre, [s[0], ['=', s[1][1], rhs]]] : [s]
        }
        return [s]
      }
      // A computed assign target (`a[i]=…`) evaluates its index BEFORE the RHS, so an effect
      // there (`a[j++]=…`) must block hoisting too — seed eff.seen from the LHS.
      case '=': { if (directCall(s[2])) return [s]; const pre = []; const rhs = hExpr(s[2], pre, false, { seen: containsEffect(s[1]) }); return pre.length ? [...pre, ['=', s[1], rhs]] : [s] }
      case 'return': { if (s.length < 2 || directCall(s[1])) return [s]; const pre = []; const v = hExpr(s[1], pre, false, { seen: false }); return pre.length ? [...pre, ['return', v]] : [s] }
      default: return [s]  // unrecognized shape (break/continue/throw/try/switch): leave alone
    }
  }
  const out = hStmt(body)
  return { node: changed ? seq(out) : body, changed }
}

export const inlineHotInternalCalls = (programFacts, ast) => {
  const cfg = ctx.transform.optimize
  if (cfg && cfg.sourceInline === false) return false
  // Transitive candidacy + expression-position hoisting are a size↔speed trade (they
  // pull a large multi-call leaf like noise's perlin fully into its hot caller, where
  // the lower tiers prefer to keep multi-caller helpers outlined for V8 tier-up). Gate
  // both on the speed tier so levels ≤2 keep their conservative inlining policy.
  const speedTier = !!(cfg && cfg.inlineFns)

  const fixedByFunc = new Map(ctx.func.list.map(func => [func, fixedTypedArraysInBody(func.body)]))
  const typedByFunc = new Map(ctx.func.list.map(func => [func, analyzeBody(func.body).typedElems]))
  const sitesByCallee = new Map()
  for (const cs of programFacts.callSites) {
    const list = sitesByCallee.get(cs.callee)
    if (list) list.push(cs); else sitesByCallee.set(cs.callee, [cs])
  }

  const containsNode = (root, needle, inLoop = false) => {
    if (root === needle) return inLoop
    if (!Array.isArray(root) || root[0] === '=>') return false
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
  for (const func of ctx.func.list) {
    if (candidates.has(func.name)) continue
    const sites = sitesByCallee.get(func.name)
    // Exported leaf/kernel with exactly one internal caller (e.g. fill→beat in
    // floatbeat): inline into the caller's loop but keep the export for external
    // one-off calls (bench beat()). Multi-caller exports stay outlined so V8 can
    // tier-up shared kernels.
    const soleCallerExport = func.exported && sites?.length === 1
    if (func.raw || !func.body || func.rest) continue
    if (func.exported && !soleCallerExport) continue
    if (programFacts.valueUsed.has(func.name) && !soleCallerExport) continue
    if (func.defaults && Object.keys(func.defaults).length) continue
    const paramNames = new Set((func.sig?.params || []).map(p => p.name))
    if (paramNames.size && some(func.body, n => {
      if (n[0] !== '()' || !Array.isArray(n[1]) || n[1][0] !== '.') return false
      const [, obj, prop] = n[1]
      return prop === 'push' && typeof obj === 'string' && paramNames.has(obj)
    })) continue
    const fixedTypedArraySite = hasFixedTypedArraySites(func, sites)
    const fullyFixedTypedArraySite = hasFullyFixedTypedArraySites(func, sites)
    const hasLoop = some(func.body, n => LOOP_OPS.has(n[0]))
    const isTinyLeaf = !hasLoop && nodeSize(func.body) <= 15
    // A small leaf (no loop, ≤40 nodes) is cheap to splice even when called several times — its
    // per-call overhead + lost cross-call fusion dwarfs the ≤8× duplication, and temp-binding +
    // flattenPrefix keep the spliced body bounded (no arg re-evaluation, CSE collapses copies).
    // The 2-site non-tiny-leaf cap would otherwise outline a hot helper like noise's `grad`
    // (~30 nodes, called 4× from perlin) and freeze the call overhead per pixel.
    const isSmallLeaf = !hasLoop && nodeSize(func.body) <= 48
    // Leaf site cap scales with body size — the cost of inlining N sites is
    // N·size nodes, not N: a 30-node pure leaf hammered from 9 sites (colorpq's
    // spow) is 270 spliced nodes, cheaper than 9 call frames per pixel, while a
    // 48-node body keeps the old 8-site bound (360/48 → 8). Full inlining also
    // restores shape identity for downstream CSE — a PARTIAL split (some sites
    // inlined, some calls) makes duplicate pure subtrees structurally unequal.
    const leafSiteCap = (isTinyLeaf || isSmallLeaf) ? Math.max(8, Math.floor(360 / Math.max(1, nodeSize(func.body)))) : 8
    if (!sites || sites.length < 1 || (!isTinyLeaf && !isSmallLeaf && !fixedTypedArraySite && sites.length > 2) || sites.length > leafSiteCap) continue
    const stmts = blockStmts(func.body)
    // Expression-bodied arrow funcs (`(c) => expr`) have no block — body IS the
    // return value. Treat as a "tiny leaf" branch handled below; force hasLoop=false.
    if (some(func.body, n => n[0] === '=>')) continue
    // throw/break/continue are unsupported; return is OK if it's a single
    // trailing return (rewritten to a value at inlining time).
    if (some(func.body, n => n[0] === 'throw' || n[0] === 'break' || n[0] === 'continue')) continue
    let returnCount = 0
    some(func.body, n => { if (n[0] === 'return') returnCount++; return false })
    if (returnCount > 1) continue
    if (returnCount === 1 && stmts) {
      const last = stmts[stmts.length - 1]
      if (!Array.isArray(last) || last[0] !== 'return') continue
    }
    // Either a kernel (has a loop) or a tiny leaf (no loop, no calls, small body).
    // The leaf branch catches helpers like `isAlpha(c) => (c>=65 && c<=90) || …`
    // that get hammered from a hot caller's loop — replacing the call with its
    // body saves the per-iteration call+reinterpret overhead (tokenizer hot path).
    if (!hasLoop) {
      // Calls to functions that are THEMSELVES candidates are fine — they inline away;
      // only a call to a non-candidate user function blocks (a later fixpoint pass re-checks).
      // Speed-tier only; lower tiers keep the strict "any user call ⇒ outline" rule.
      if (some(func.body, n => n[0] === '()' && typeof n[1] === 'string' && ctx.func.names.has(n[1]) && !(speedTier && candidates.has(n[1])))) continue
      // Per-iteration call overhead dwarfs body-size bloat when EVERY site sits
      // inside a caller's loop (game-of-life's rot: ~40 nodes × 2 sites, fired
      // for most of 260k cells/frame; cloth's relax: ~160 nodes × 2 sites, fired
      // per link every relaxation pass). V8's pre-Turboshaft wasm tiers never
      // inline cross-function, so an out-of-line leaf in a hot loop is a hard
      // per-cell tax on Node ≤ 22 — and still saves call setup on newer tiers.
      // The in-loop cap is generous because the gate above bounds non-tiny leaves
      // to ≤2 sites, so the spliced duplication is at most ~2× a bounded body.
      const transitiveHotSite = (site, seen = new Set()) => {
        if (site.callerFunc?.body && containsNode(site.callerFunc.body, site.node, false)) return true
        const callerFunc = site.callerFunc
        const caller = callerFunc?.name
        // A tiny non-escaping wrapper may not be a candidate *yet* because it
        // calls the leaf currently being considered (sdRep ← sdf). Looking
        // through it breaks that harmless caller/callee collection cycle and
        // recognizes the same transitive hot path the next fixpoint would.
        const prospectiveLeaf = callerFunc && !callerFunc.exported &&
          !programFacts.valueUsed.has(caller) && loopDepth(callerFunc.body, 0) === 0 &&
          nodeSize(callerFunc.body) <= 48
        if (!caller || (!candidates.has(caller) && !prospectiveLeaf) || seen.has(caller)) return false
        const callerSites = sitesByCallee.get(caller)
        if (!callerSites?.length) return false
        const next = new Set(seen); next.add(caller)
        return callerSites.every(parent => transitiveHotSite(parent, next))
      }
      const allSitesInLoop = sites.every(site => transitiveHotSite(site))
      // Non-in-loop cap is 40 (not 30) so a small leaf called from a straight-line but
      // transitively-hot caller still inlines (noise's grad is called from perlin, which has
      // no loop of its own but is itself the per-pixel kernel). Still tightly bounded.
      if (nodeSize(func.body) > (allSitesInLoop ? 200 : 48)) continue
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
    if (some(func.body, n => n[0] === '()' && typeof n[1] === 'string' && n[1].startsWith('new.'))) continue
    if (paramNames.size && some(func.body, n => n[0] === '()' && typeof n[1] === 'string' && paramNames.has(n[1])))
      forwarders.add(func.name)
    if (!hasLoop) leaves.add(func.name)
    candidates.set(func.name, func)
    if (speedTier) recollect = true  // only the speed-tier transitive relaxation needs a re-pass
  }
  }
  if (!candidates.size) return false

  // Trivial expr-bodied candidates can be substituted at any expression position
  // (if-condition, ternary, etc.). Stmt-bodied ones go through inlineInStmt's
  // statement-level path which preserves prefix ordering — EXCEPT flattenable
  // block bodies (pure-arith let decls + trailing return, e.g. distance's
  // dx/dy), which inlineInExpr turns into zero-prefix expressions per site.
  const flattenableBody = (func) => {
    const stmts = blockStmts(func.body)
    if (!stmts) return false
    return stmts.every((s, i) => i === stmts.length - 1
      ? Array.isArray(s) && s[0] === 'return'
      : Array.isArray(s) && (s[0] === 'let' || s[0] === 'const') && s.length === 2
        && Array.isArray(s[1]) && s[1][0] === '=' && typeof s[1][1] === 'string' && pureFlattenExpr(s[1][2]))
  }
  const exprOnlyCandidates = new Map()
  for (const [name, func] of candidates) {
    if (!Array.isArray(func.body) || func.body[0] !== '{}' || flattenableBody(func)) exprOnlyCandidates.set(name, func)
  }

  let changed = false
  const exportedCandidates = new Map()
  for (const [name, func] of candidates) {
    const sites = sitesByCallee.get(name)
    const fixedSiteExported = hasFixedTypedArraySites(func, sites) &&
      !sites.some(site => site.callerFunc?.exported && site.callerFunc.body && containsNode(site.callerFunc.body, site.node))
    // Forwarders cross into an exported caller too: the tier-up rationale that
    // keeps candidates out of exports concerns relocated loop kernels, not
    // these tiny leaves — and inlining one devirtualizes a closure dispatch.
    if (fixedSiteExported || forwarders.has(name) || leaves.has(name) || sites?.length === 1) exportedCandidates.set(name, func)
  }
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    // Skip exports: they're entry points usually invoked once. Inlining a
    // hot kernel here would put the loop into a function V8's wasm tier-up
    // never warms (kernel stays in baseline). Keeping the kernel as its own
    // callable function lets V8 promote it to TurboFan after a few calls.
    // Exception: fixed-size typed-array callees should inline into the exported
    // caller so scalar replacement can cross the call boundary and remove the
    // caller's heap arrays.
    const activeCandidates = func.exported ? exportedCandidates : candidates
    if (func.exported && !activeCandidates.size) continue
    // Expression-bodied arrows (`() => expr`) have func.body as the return
    // value itself — never a `{}` block. inlineInStmt treats its argument as a
    // statement (discards the return value of any top-level candidate call),
    // which would turn `() => x()` into an empty block and lose the result.
    // Route those through inlineInExpr so the call is replaced by the inlined
    // value expression instead.
    const isExprBody = !Array.isArray(func.body) || func.body[0] !== '{}'
    // Expression-position pass takes the leaf-safe subset for exports — the same tier-up
    // rationale as the statement path (leaves into exports are fine; relocated kernels are not).
    const exprActive = func.exported
      ? new Map([...exprOnlyCandidates].filter(([n]) => exportedCandidates.has(n)))
      : exprOnlyCandidates
    // Iterate to a (bounded) fixpoint: inlining a call whose args are themselves candidate calls
    // binds those args to temps (`t0 = grad(a)`); the next pass folds the candidate into the temp
    // decl. Depth is bounded by call nesting (a small constant), capped here so a pathological
    // chain can't loop unbounded.
    // Loop-free block-body LEAVES: the stmt path folds them only at a DIRECT `const X =
    // call`, never nested in an expression. Hoisting such a call to a temp (in the iter
    // fixpoint below) lets inlineInStmt then fold it — the noise `sum + amp*perlin(x)`
    // shape. Restricted to LEAVES (no own loop): a loop kernel called in expression
    // position (e.g. a 2-site `reduce`) was deliberately staying outlined for V8 tier-up,
    // and hoisting it would pull the loop into a cold caller.
    const blockNames = new Set()
    for (const n of activeCandidates.keys()) if (leaves.has(n) && !exprActive.has(n)) blockNames.add(n)
    let body = func.body, bodyChanged = false
    for (let iter = 0; iter < 4; iter++) {
      let iterChanged = false
      if (speedTier && !isExprBody && blockNames.size) {
        const h = hoistNestedCalls(body, blockNames)
        if (h.changed) { body = h.node; iterChanged = true }
      }
      const r = isExprBody ? inlineInExpr(body, activeCandidates) : inlineInStmt(body, activeCandidates)
      if (r.changed) { body = r.node; iterChanged = true }
      if (exprActive.size) {
        const e = inlineInExpr(body, exprActive)
        if (e.changed) { body = e.node; iterChanged = true }
      }
      if (!iterChanged) break
      bodyChanged = true
    }
    if (bodyChanged) { func.body = body; changed = true }
  }
  if (ast) {
    const r = inlineInStmt(ast, candidates)
    if (r.changed) changed = true
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

  // Collect `const f = ARROW` (single-decl), all-plain params, inlinable body.
  const decls = new Map()
  for (const stmt of stmts) {
    if (!Array.isArray(stmt) || stmt[0] !== 'const' || stmt.length !== 2) continue
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
  const stmtCands = new Map(), exprCands = new Map()
  for (const [name, info] of decls)
    (Array.isArray(info.arrow[2]) && info.arrow[2][0] === '{}' ? stmtCands : exprCands).set(name, asFunc(info))

  let out = body, didChange = false
  if (stmtCands.size) { const r = inlineInStmt(out, stmtCands); if (r.changed) { out = r.node; didChange = true } }
  if (exprCands.size) { const r = inlineInExpr(out, exprCands); if (r.changed) { out = r.node; didChange = true } }
  if (!didChange) return false

  // Remove decls of candidates that are now fully consumed.
  const newStmts = bodyStmtList(out)
  const dead = new Set()
  for (const [name, info] of decls) {
    if (!newStmts.some(s => s !== info.stmt && refsName(s, name, REFS_IN_EXPR))) dead.add(info.stmt)
  }
  if (dead.size) out = removeStmts(out, dead) ?? [';']

  setBody(out)
  return true
}

export const inlineLocalLambdas = () => {
  let changed = false
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    if (inlineLocalLambdasInBody(() => func.body, b => { func.body = b })) changed = true
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

const rewriteRestBody = (node, restName, restParams) => {
  if (typeof node === 'string') return node === restName ? { ok: false } : { ok: true, node }
  if (!Array.isArray(node)) return { ok: true, node }
  if (node[0] === 'str') return { ok: true, node: node.slice() }

  if ((node[0] === '.' || node[0] === '?.') && node[1] === restName) {
    return node[2] === 'length' ? { ok: true, node: [, restParams.length] } : { ok: false }
  }

  if (node[0] === '[]' && node[1] === restName) {
    if (!isSimpleArg(node[2])) return { ok: false }
    return { ok: true, node: restIndexExpr(node[2], restParams) }
  }

  const out = [node[0]]
  for (let i = 1; i < node.length; i++) {
    const r = rewriteRestBody(node[i], restName, restParams)
    if (!r.ok) return r
    out.push(r.node)
  }
  return { ok: true, node: out }
}

export const specializeFixedRestCalls = (programFacts) => {
  const sitesByKey = new Map()
  for (const site of programFacts.callSites) {
    const func = ctx.func.map.get(site.callee)
    if (!func?.rest || func.exported || func.raw || !func.body) continue
    if (programFacts.valueUsed.has(func.name)) continue
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
    const func = ctx.func.map.get(name)
    const restN = Number(restNText)
    const fixedParams = func.sig.params.slice(0, -1).map(p => ({ ...p }))
    const restName = func.rest
    const restParams = Array.from({ length: restN }, (_, i) => `${restName}${T}r${restN}_${i}`)
    const rewritten = rewriteRestBody(func.body, restName, restParams)
    if (!rewritten.ok) continue

    const cloneName = `${name}${T}rest${restN}`
    if (!ctx.func.map.has(cloneName)) {
      const restSigParams = restParams.map(name => ({ name, type: 'f64' }))
      const clone = {
        ...func,
        name: cloneName,
        exported: false,
        rest: null,
        // Build the specialized sig fresh. `params`/`results` are sig's only
        // fields and both are replaced here, so a `{ ...func.sig, … }` spread
        // would be pure redundancy — and a full-override spread of a live sig
        // object also trips the self-host codegen, so the explicit form is both
        // simpler and the one that round-trips through jz.wasm.
        sig: {
          params: [...fixedParams, ...restSigParams],
          results: [...func.sig.results],
        },
        body: rewritten.node,
      }
      ctx.func.list.push(clone)
      ctx.func.names.add(cloneName)
      ctx.func.map.set(cloneName, clone)
    }

    const fixedN = func.sig.params.length - 1
    for (const site of sites) {
      site.node[1] = cloneName
      setCallArgs(site.node, site.argList.slice(0, fixedN + restN))
      changed = true
    }
  }
  return changed
}
