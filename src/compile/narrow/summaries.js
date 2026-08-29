/**
 * Self-contained whole-program interprocedural analyses feeding
 * narrowSignatures: fixed-length proof for literal+push-built arrays
 * (inferInternalArrayLengths), the co-induction bounds prover
 * (coInductionCounterHull/findCoInductionLoopCtx/arrayReadProvenInBounds,
 * .work/archive/todo.md "the co-induction prover"), and whole-program typed-elem
 * store range hulls (inferTypedValueRanges). Each has fan-out 0 into any
 * sibling narrow/*.js family — every dependency here is an upstream import.
 *
 * @module compile/narrow/summaries
 */

import { ctx } from '../../ctx.js'
import {
  returnExprs, callArgs, ASSIGN_OPS, refsName, carriesName, REFS_THROUGH_ARROWS, walkAst, some,
} from '../../ast.js'
import { findMutations } from '../analyze.js'
import {
  staticArrayElems, hull, typedValueLiteral, typedValueExprRange, linearIndexOf, guardCounterName,
} from '../../static.js'
import { normalizeLoop, unitIncVar } from '../loop-model.js'
import { typedElemCtor, typedStaticLen } from '../../type.js'

// Fixed lengths of internal arrays built from a literal plus unconditional
// pushes in canonical constant-trip loops. Any alias, unknown call, conditional
// push, indexed write, or control exit rejects the array. This captures table
// builders without pretending mutable JS arrays are generally fixed-size.
export function inferInternalArrayLengths(paramReps) {
  const cint = (n) => {
    if (typeof n === 'number' && Number.isInteger(n)) return n
    if (Array.isArray(n) && n[0] == null && typeof n[1] === 'number' && Number.isInteger(n[1])) return n[1]
    if (typeof n === 'string') return ctx.scope.constInts?.get(n) ?? null
    return null
  }
  const declInit = (n, name) => {
    if (!Array.isArray(n)) return null
    if (n[0] === 'let' || n[0] === 'const' || n[0] === ';') for (let i = 1; i < n.length; i++) {
      const d = n[i]
      if (Array.isArray(d) && d[0] === '=' && d[1] === name) return cint(d[2])
      const v = declInit(d, name); if (v != null) return v
    }
    return null
  }
  const unitInc = (n, name) => Array.isArray(n) &&
    ((n[0] === '++' && n[1] === name) || (n[0] === '+=' && n[1] === name && cint(n[2]) === 1))
  // refsName's unconditional-descend form (skipArrow: false): a closure capture
  // can read/alias/mutate the name at any time, so it counts as a reference
  // everywhere this predicate gates a reject. A shadowing arrow param matches
  // by string and over-rejects — sound.
  const refs = (n, name) => refsName(n, name, REFS_THROUGH_ARROWS)
  const pushCount = (n, arr) => {
    if (!Array.isArray(n)) return 0
    if (n[0] === '=>') return refs(n, arr) ? null : 0
    if (n[0] === '()') {
      if (Array.isArray(n[1]) && n[1][0] === '.' && n[1][1] === arr)
        return n[1][2] === 'push' && callArgs(n).length > 0 && !callArgs(n).some(a => refs(a, arr))
          ? callArgs(n).length : null
      if (callArgs(n).some(a => refs(a, arr)) || refs(n[1], arr)) return null
    }
    if (n[0] === 'if' || n[0] === '?:' || n[0] === 'while' || n[0] === 'do' || n[0] === 'for' || n[0] === 'switch')
      return refs(n, arr) ? null : 0
    if (n[0] === 'return' || n[0] === 'throw' || n[0] === 'break' || n[0] === 'continue') return null
    if (ASSIGN_OPS.has(n[0]) || n[0] === '++' || n[0] === '--') {
      if (n[1] === arr || refs(n[1], arr) || refs(n[2], arr)) return null
    }
    let total = 0
    for (let i = 1; i < n.length; i++) {
      const c = pushCount(n[i], arr)
      if (c == null) return null
      total += c
    }
    return total
  }
  const hasOp = (n, op) => {
    if (!Array.isArray(n) || n[0] === '=>') return false
    if (n[0] === op) return true
    for (let i = 1; i < n.length; i++) if (hasOp(n[i], op)) return true
    return false
  }
  const returnedName = (body) => {
    const rs = returnExprs(body)
    return rs.length && rs.every(x => typeof x === 'string' && x === rs[0]) ? rs[0] : null
  }
  // Also descends into arrows: a captured-iv write (`arr.forEach(() => i++)`)
  // changes the trip count as surely as a direct one. Shadowing over-rejects.
  const mutatesName = (n, name) => {
    if (!Array.isArray(n)) return false
    if ((ASSIGN_OPS.has(n[0]) || n[0] === '++' || n[0] === '--') && n[1] === name) return true
    for (let i = 1; i < n.length; i++) if (mutatesName(n[i], name)) return true
    return false
  }
  const funcLens = new Map()
  for (const f of ctx.funcs.list) {
    if (f.raw || !Array.isArray(f.body)) continue
    const arr = returnedName(f.body)
    if (!arr) continue
    let len = null, bad = false, defNode = null
    walkAst(f.body, { enter: n => {
      if (bad) return false
      if (n[0] === '=>') { if (refs(n, arr)) bad = true; return false }
      if ((n[0] === 'let' || n[0] === 'const')) for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (Array.isArray(d) && d[0] === '=' && d[1] === arr) {
          if (defNode) { bad = true; return false }
          const elems = staticArrayElems(d[2])
          if (elems) { len = elems.length; defNode = d } else bad = true
        }
      }
      if ((n[0] === 'if' || n[0] === '?:' || n[0] === 'while' || n[0] === 'do' || n[0] === 'switch') && refs(n, arr)) {
        bad = true
        return false
      }
      if (n[0] === 'for' && n.length === 5 && refs(n[4], arr)) {
        const initNames = new Set()
        const findIv = (x) => {
          if (!Array.isArray(x)) return
          if (x[0] === '=' && typeof x[1] === 'string' && cint(x[2]) != null) initNames.add(x[1])
          for (let i = 1; i < x.length; i++) findIv(x[i])
        }
        findIv(n[1])
        const iv = [...initNames].find(x => Array.isArray(n[2]) && n[2][0] === '<' && n[2][1] === x && unitInc(n[3], x))
        const start = iv ? declInit(n[1], iv) : null
        const bound = iv ? cint(n[2][2]) : null
        const per = iv ? pushCount(n[4], arr) : null
        if (len == null || start == null || bound == null || bound < start || per == null ||
            hasOp(n[4], 'break') || hasOp(n[4], 'continue') || hasOp(n[4], 'return') || hasOp(n[4], 'throw') ||
            mutatesName(n[4], iv)) bad = true
        else len += (bound - start) * per
        return false
      }
      if (n[0] === '()' && Array.isArray(n[1]) && n[1][0] === '.' && n[1][1] === arr && n[1][2] === 'push') {
        if (len == null || !callArgs(n).length || callArgs(n).some(a => refs(a, arr))) bad = true
        else len += callArgs(n).length
        return false
      }
      if (n[0] === '()' && (refs(n[1], arr) || callArgs(n).some(a => refs(a, arr)))) { bad = true; return false }
      if (n !== defNode && (ASSIGN_OPS.has(n[0]) || n[0] === '++' || n[0] === '--') &&
          (n[1] === arr || refs(n[1], arr) || refs(n[2], arr))) { bad = true; return false }
      if (n[0] === 'return' && n[1] === arr) return false
    } })
    if (!bad && len != null) { f.arrayLen = len; funcLens.set(f.name, len) }
  }
  // Length-preserving parameter summaries let a caller retain a local length
  // fact across known reader helpers. Any alias, closure capture, return,
  // indexed/property write, method call, or unknown call poisons the summary.
  const carries = carriesName
  const funcs = ctx.funcs.list.filter(f => !f.raw && Array.isArray(f.body))
  const safeParams = new Map(funcs.map(f => [f.name, f.sig.params.map(() => true)]))
  for (const f of funcs) {
    const ps = new Map(f.sig.params.map((p, i) => [p.name, i])), safe = safeParams.get(f.name)
    walkAst(f.body, { enter: n => {
      if (n[0] === '=>') { for (const [name, k] of ps) if (refs(n, name)) safe[k] = false; return false }
      if (ASSIGN_OPS.has(n[0]) || n[0] === '++' || n[0] === '--') for (const [name, k] of ps) {
        if (n[1] === name || carries(n[2], name) || (Array.isArray(n[1]) && refs(n[1], name))) safe[k] = false
      }
      if (n[0] === 'return') for (const [name, k] of ps) if (carries(n[1], name)) safe[k] = false
      if (n[0] === '()') {
        const args = callArgs(n), callee = typeof n[1] === 'string' ? n[1] : null
        for (const [name, k] of ps) {
          if (refs(n[1], name)) safe[k] = false
          for (const a of args) if (carries(a, name) && (a !== name || !safeParams.has(callee))) safe[k] = false
        }
      }
    } })
  }
  let safeChanged = true
  while (safeChanged) {
    safeChanged = false
    for (const f of funcs) {
      const ps = new Map(f.sig.params.map((p, i) => [p.name, i])), safe = safeParams.get(f.name)
      walkAst(f.body, { enter: n => {
        if (n[0] === '=>') return false
        if (n[0] === '()' && typeof n[1] === 'string' && safeParams.has(n[1])) {
          const args = callArgs(n), target = safeParams.get(n[1])
          for (let k = 0; k < args.length; k++) if (ps.has(args[k]) && !target[k] && safe[ps.get(args[k])]) {
            safe[ps.get(args[k])] = false
            safeChanged = true
          }
        }
      } })
    }
  }

  const locals = new Map()
  for (const f of funcs) {
    const candidates = new Map(), defs = new Map()
    const collect = (n) => {
      if (!Array.isArray(n) || n[0] === '=>') return
      if (n[0] === 'let' || n[0] === 'const') for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') continue
        const elems = staticArrayElems(d[2])
        const len = elems ? elems.length
          : Array.isArray(d[2]) && d[2][0] === '()' && typeof d[2][1] === 'string' ? funcLens.get(d[2][1])
          : null
        if (len != null) { candidates.set(d[1], len); defs.set(d[1], d) }
      }
      for (let i = 1; i < n.length; i++) collect(n[i])
    }
    collect(f.body)
    const m = new Map()
    for (const [name, len] of candidates) {
      let ok = true
      const verify = (n) => {
        if (!ok || !Array.isArray(n)) return
        if (n[0] === '=>') { if (refs(n, name)) ok = false; return }
        if (n !== defs.get(name) && (ASSIGN_OPS.has(n[0]) || n[0] === '++' || n[0] === '--') &&
            (n[1] === name || carries(n[2], name) || (Array.isArray(n[1]) && refs(n[1], name)))) { ok = false; return }
        if (n[0] === 'return' && carries(n[1], name)) { ok = false; return }
        if (n[0] === '()') {
          const args = callArgs(n), callee = typeof n[1] === 'string' ? n[1] : null
          if (refs(n[1], name)) { ok = false; return }
          for (let k = 0; k < args.length; k++) if (carries(args[k], name) &&
              (args[k] !== name || !safeParams.get(callee)?.[k])) { ok = false; return }
        }
        for (let i = 1; i < n.length; i++) verify(n[i])
      }
      verify(f.body)
      if (ok) m.set(name, len)
    }
    locals.set(f, m)
  }
  return { funcLens, locals }
}

// === Co-induction + interprocedural bounds proof (colorlog project,
// .work/archive/todo.md "the co-induction prover") ===
//
// censusShapedNode (kind.js) over-approximates ANY `arr[idx]` call argument
// as possibly undefined — sound (an unproven OOB read really does read
// `undefined`) but blind to index arithmetic that PROVES `idx` in bounds:
// colorlog's `decode(src[j])` (`j = 3 * i`, `i` the enclosing loop's own
// counter) never reads OOB, yet the over-approximation still poisons
// decode's param, forcing every arithmetic use of it through a runtime
// undefined-sentinel dispatch (ir.js toNumF64's coerceNullishToNum) that a
// definite Float64Array element can never need. This section closes that
// gap with a small, purely STRUCTURAL walker: given a call argument shaped
// `['[]', arrName, idxExpr]` and the caller's own body, it finds the
// enclosing canonical for-loop, resolves `idxExpr` as a compile-time-
// constant linear function of the loop counter (extending nameShift's own
// +/- shape to a scaled `K*name` via static.js's linearIndexOf, composed
// through ONE decl-hop for a loop-local index like colorlog's `j`), and
// checks the resulting hull against the array's own provable length.
//
// Deliberately NOT built on forCounterRange/intExprRange (static.js): both
// resolve a bare-name operand via `repOf`, which reads `ctx.func.localReps`
// — installed for whichever function is CURRENTLY being emitted, not the
// caller this whole-program walk is examining (same caveat this file's own
// bodyNameNullable/censusShapedNode already document for the identical
// reason). Every resolver below reads ONLY already-fixpoint-settled
// `paramReps` facts (by construction: this runs from the mayBeUndefined
// join, which itself runs after the intConst/arrayLen/typedLen fixpoints
// above have converged) plus `ctx.scope.constInts` (a whole-module fact,
// settled before any function's ctx.func is installed — closure-plan.js's
// own precedent for the identical safety argument) — never `repOf`.
//
// Sound-narrow throughout: any shape this can't recognize returns false/null
// and the caller falls through to the existing over-approximation — this
// code only ever REMOVES false-positive mayBeUndefined evidence, never adds
// any of its own.

/** Literal integer, OR a bare name resolved via `func`'s OWN already-settled
 *  `intConst` param fact (by index, via `reps` — `func`'s paramReps entry),
 *  OR a module-level int const (`ctx.scope.constInts`, ctx.func-independent
 *  — see this section's header doc). No `repOf` anywhere. Mirrors
 *  static.js's constIntExpr/intLiteralValue shape-for-shape, swapping their
 *  `repOf(name)` arm for this caller-safe pair. */
function literalOrCallerParamInt(expr, func, reps) {
  if (typeof expr === 'number' && Number.isInteger(expr)) return expr
  if (Array.isArray(expr) && expr.length === 2 && expr[0] == null && typeof expr[1] === 'number') return expr[1]
  if (Array.isArray(expr) && expr[0] === 'u-' && expr.length === 2) {
    const v = literalOrCallerParamInt(expr[1], func, reps)
    return v == null ? null : -v
  }
  if (typeof expr === 'string') {
    if (ctx.scope.constInts?.has(expr)) return ctx.scope.constInts.get(expr)
    const k = func?.sig?.params?.findIndex(p => p.name === expr) ?? -1
    return k >= 0 ? (reps?.get(k)?.intConst ?? null) : null
  }
  if (Array.isArray(expr) && expr.length === 3) {
    const a = literalOrCallerParamInt(expr[1], func, reps), b = literalOrCallerParamInt(expr[2], func, reps)
    if (a == null || b == null) return null
    if (expr[0] === '+') return a + b
    if (expr[0] === '-') return a - b
    if (expr[0] === '*') return a * b
    if (expr[0] === '<<') return a << b
  }
  return null
}

/** The RHS of the single `const`/`let` decl of `name` in `body`, or null if
 *  `name` is never declared there or is declared more than once (ambiguous
 *  — same "single-def" discipline inferInternalArrayLengths's own funcLens
 *  walker above applies to a builder's returned name). Does NOT check for
 *  reassignment — callers that need that guarantee (a plain `let`, unlike a
 *  `const`) add it themselves. */
function singleDefRhs(body, name) {
  let rhs = null, multi = false
  walkAst(body, { enter: n => {
    if (multi) return false
    if (n[0] === 'let' || n[0] === 'const') {
      for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (Array.isArray(d) && d[0] === '=' && d[1] === name) {
          if (rhs !== null) { multi = true; return false }
          rhs = d[2]
        }
      }
    }
  } })
  return multi ? null : rhs
}

/** A builder function's OWN provable typed-array return length: `function f
 *  (...) { const arr = new T(lenExpr); ...; return arr }` — single def,
 *  never reassigned (typed arrays have no `.length=` resize, so a fixed-at-
 *  construction length can't be invalidated the way inferInternalArrayLengths'
 *  plain-array `push` case can). `lenExpr` resolves through `f`'s OWN
 *  already-settled `intConst` param facts (literalOrCallerParamInt) — the
 *  "chained through mkInput's return" shape colorlog's `src = mkInput(N)`
 *  needs (mkInput's `new Float64Array(n * 3)`, `n` a param fixed by its
 *  single call site). Mirrors type.js's typedStaticLen shape gate exactly,
 *  swapping its `constIntExpr` (repOf-based) arg resolver for the caller-
 *  safe one. */
function builderTypedArrayLen(calleeName, paramReps) {
  const f = ctx.funcs.map?.get(calleeName)
  if (!f?.body || f.raw) return null
  const rs = returnExprs(f.body)
  const arr = rs.length && rs.every(x => typeof x === 'string' && x === rs[0]) ? rs[0] : null
  if (!arr) return null
  const rhs = singleDefRhs(f.body, arr)
  if (!Array.isArray(rhs) || rhs[0] !== '()' || typeof rhs[1] !== 'string' ||
      !rhs[1].startsWith('new.') || !rhs[1].endsWith('Array') || rhs[1] === 'new.ArrayBuffer') return null
  const mutated = new Set()
  findMutations(f.body, new Set([arr]), mutated)
  if (mutated.has(arr)) return null
  const args = rhs[2]
  if (args === undefined) return 0
  if (Array.isArray(args) && args[0] === ',') return null   // view form — no single length
  return literalOrCallerParamInt(args, f, paramReps.get(calleeName))
}

/** The provable element length of `arrName` as seen inside `callerFunc` — a
 *  caller PARAM (its own already-settled arrayLen/typedLen fact) or a caller
 *  LOCAL bound, once, to a builder call whose return length chains via
 *  builderTypedArrayLen above. Null if neither resolves. */
function callerArrayLen(arrName, callerFunc, callerReps, paramReps) {
  const arrIdx = callerFunc.sig?.params?.findIndex(p => p.name === arrName) ?? -1
  if (arrIdx >= 0) return callerReps?.get(arrIdx)?.arrayLen ?? callerReps?.get(arrIdx)?.typedLen ?? null
  const rhs = singleDefRhs(callerFunc.body, arrName)
  if (!Array.isArray(rhs) || rhs[0] !== '()' || typeof rhs[1] !== 'string') return null
  const mutated = new Set()
  findMutations(callerFunc.body, new Set([arrName]), mutated)
  if (mutated.has(arrName)) return null
  return builderTypedArrayLen(rhs[1], paramReps)
}

/** A canonical `for (let ctr = LO; ctr < HI; ctr++)` (or `<=`) hull [lo, hi]
 *  — self-contained (normalizeLoop/unitIncVar, loop-model.js — pure AST
 *  shape tests) with LO/HI resolved via literalOrCallerParamInt (never
 *  repOf). Deliberately bare-guard only (`L.cond[1] === counterName`, not
 *  nameShift's own +/- shape): a shifted counter guard is real but out of
 *  this walker's minimal scope — falls through to null, sound (loses a
 *  provable case, never wrongly proves one). */
function coInductionCounterHull(L, counterName, callerFunc, callerReps) {
  if (!Array.isArray(L.cond) || L.cond[1] !== counterName || !['<', '<='].includes(L.cond[0])) return null
  if (unitIncVar(L.step) !== counterName) return null
  const initExpr =
    Array.isArray(L.init) && (L.init[0] === 'let' || L.init[0] === 'const')
      ? (L.init.slice(1).find(d => Array.isArray(d) && d[0] === '=' && d[1] === counterName) ?? null)?.[2] ?? null
    : Array.isArray(L.init) && L.init[0] === '=' && L.init[1] === counterName ? L.init[2]
    : null
  if (initExpr == null) return null
  const lo = literalOrCallerParamInt(initExpr, callerFunc, callerReps)
  const boundRaw = literalOrCallerParamInt(L.cond[2], callerFunc, callerReps)
  if (lo == null || boundRaw == null) return null
  const hi = L.cond[0] === '<' ? boundRaw - 1 : boundRaw
  return hi < lo ? null : [lo, hi]
}

/** Walk `node` (part of `callerFunc.body`) looking for `targetRef` BY
 *  IDENTITY (the exact AST node object `cs.argList[k]` — the same reference
 *  program-facts.js's own walk collected it from, so `===` is a valid
 *  "found the call argument's read node" test). `loopCtx` is the innermost
 *  enclosing canonical for-loop's {counterName, hull, decls} — decls (a
 *  Map name→{scale,shift}) accumulates each `const NAME = K*counter(+/-C)`
 *  decl-hop seen so far, IN ORDER (sequential/straight-line dominance — the
 *  only scope this walker claims; an `if`/`while` branch's own decls are
 *  still visited, harmless since a later lookup would just miss, never
 *  wrongly hit). Stops the instant `targetRef` is found so no decl DECLARED
 *  AFTER the read can leak into its proof (`out.found` guards every
 *  recursive call). `out.loopCtx` is null if the target sits outside any
 *  provable canonical loop. */
function findCoInductionLoopCtx(node, targetRef, loopCtx, out, callerFunc, callerReps) {
  if (out.found || !Array.isArray(node)) return
  if (node === targetRef) { out.found = true; out.loopCtx = loopCtx; return }
  const L = normalizeLoop(node)
  if (L && L.kind === 'for') {
    const counterName = guardCounterName(L.cond)
    const hull = counterName ? coInductionCounterHull(L, counterName, callerFunc, callerReps) : null
    const innerCtx = hull ? { counterName, hull, decls: new Map() } : null
    findCoInductionLoopCtx(node[1], targetRef, loopCtx, out, callerFunc, callerReps)
    findCoInductionLoopCtx(node[2], targetRef, loopCtx, out, callerFunc, callerReps)
    findCoInductionLoopCtx(node[3], targetRef, loopCtx, out, callerFunc, callerReps)
    findCoInductionLoopCtx(node[4], targetRef, innerCtx, out, callerFunc, callerReps)
    return
  }
  if (node[0] === 'const' && loopCtx) {
    for (let i = 1; i < node.length; i++) {
      const d = node[i]
      if (out.found) return
      if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' && !loopCtx.decls.has(d[1])) {
        const lin = linearIndexOf(d[2])
        if (lin && lin.name === loopCtx.counterName) loopCtx.decls.set(d[1], { scale: lin.scale, shift: lin.shift })
      }
    }
  }
  for (let i = 1; i < node.length; i++) findCoInductionLoopCtx(node[i], targetRef, loopCtx, out, callerFunc, callerReps)
}

/** Is `readNode` (`['[]', arrName, idxExpr]`, a call argument flagged by
 *  censusShapedNode) a PROVABLY in-bounds array element read? `arrName` must
 *  resolve a length (callerArrayLen) and `idxExpr` must resolve — directly,
 *  or through exactly one loop-local decl-hop (colorlog's `j = 3*i`) — to a
 *  linear function of the enclosing loop's own counter whose hull composes
 *  in-bounds against that length. See this section's header doc for the
 *  full soundness argument. */
export function arrayReadProvenInBounds(readNode, callerFunc, paramReps) {
  if (!Array.isArray(readNode) || readNode[0] !== '[]' || readNode.length !== 3) return false
  const [, arrName, idxExpr] = readNode
  if (typeof arrName !== 'string' || !callerFunc?.body || !callerFunc.sig?.params) return false
  const callerReps = paramReps.get(callerFunc.name)
  const arrLen = callerArrayLen(arrName, callerFunc, callerReps, paramReps)
  if (typeof arrLen !== 'number') return false

  const out = { found: false, loopCtx: null }
  findCoInductionLoopCtx(callerFunc.body, readNode, null, out, callerFunc, callerReps)
  if (!out.found || !out.loopCtx) return false
  const { counterName, hull, decls } = out.loopCtx

  const lin = linearIndexOf(idxExpr)
  if (!lin) return false
  let scale = lin.scale, shift = lin.shift
  if (lin.name !== counterName) {
    const d = decls.get(lin.name)
    if (!d) return false
    scale = lin.scale * d.scale
    shift = lin.shift + lin.scale * d.shift
  }
  const a = scale * hull[0] + shift, b = scale * hull[1] + shift
  const idxLo = Math.min(a, b), idxHi = Math.max(a, b)
  return idxLo >= 0 && idxHi < arrLen
}

// Whole-program typed-element hulls for fresh local typed arrays. A callee
// summary records only values written through each parameter; callers union
// that effect with the fresh array's initial zero. This is deliberately not a
// general alias analysis: aliases, external calls, returns, unknown writes, and
// closures poison the fact. The useful class is broad nevertheless — fill(a)
// helpers followed by compute(a), common in codecs and generated kernels.
export function inferTypedValueRanges(paramReps) {
  // hull/literal/exprRange relocated to static.js (consistency-audit item 4) —
  // see hull/typedValueLiteral/typedValueExprRange's own doc comments there
  // for why they stay a separate, narrower pair rather than merging into
  // constIntExpr/intExprRange.
  const literal = typedValueLiteral, exprRange = typedValueExprRange
  // Model integer typed-array stores. A source interval that crosses the
  // element representation's wrap/clamp boundary widens to the full stored
  // range; retaining the source interval there would be an unsound under-
  // approximation (e.g. `Uint8Array[0] = -100` stores 156).
  const elemBounds = new Map([
    ['new.Int8Array', [-128, 127]], ['new.Uint8Array', [0, 255]], ['new.Uint8ClampedArray', [0, 255]],
    ['new.Int16Array', [-32768, 32767]], ['new.Uint16Array', [0, 65535]],
    ['new.Int32Array', [-2147483648, 2147483647]], ['new.Uint32Array', [0, 4294967295]],
  ])
  const storedRange = (ctor, r) => {
    const base = ctor?.endsWith('.view') ? ctor.slice(0, -5) : ctor
    const lim = elemBounds.get(base)
    if (!lim || !r || !Number.isFinite(r[0]) || !Number.isFinite(r[1])) return null
    return r[0] >= lim[0] && r[1] <= lim[1] ? [...r] : [...lim]
  }
  const initialRange = (rhs, ctor) => {
    const args = rhs?.[2]
    if (args == null || literal(args) != null) return [0, 0]
    const elems = staticArrayElems(args)
    if (!elems) return null
    let out = null
    for (const e of elems) {
      const r = storedRange(ctor, exprRange(e))
      if (!r) return null
      out = hull(out, r)
    }
    return out || [0, 0]
  }
  const mentions = (n, name) => refsName(n, name, REFS_THROUGH_ARROWS)
  // Expressions that can evaluate to the array object itself. Element/property
  // reads merely consume it and must not be mistaken for aliases.
  const carries = carriesName
  const funcs = ctx.funcs.list.filter(f => !f.raw && Array.isArray(f.body))
  const summaries = new Map()
  for (const f of funcs) summaries.set(f.name, f.sig.params.map(() => ({ range: null, writes: false, bad: false })))

  // Direct effects: each function's own body, in isolation — an array-elem
  // write through a param seeds/widens that param's summary range; any alias,
  // return-escape, or opaque call poisons it (`bad`). User-call forwarding
  // (a param passed straight through to another narrowable function) is
  // deliberately NOT resolved here — folded to a fixpoint below instead,
  // since a callee's own summary may itself still be settling.
  function computeDirectEffects() {
    for (const f of funcs) {
      const ps = new Map(f.sig.params.map((p, i) => [p.name, i]))
      const sum = summaries.get(f.name)
      const walk = (n, inClosure = false) => {
        if (!Array.isArray(n)) return
        const closure = inClosure || n[0] === '=>'
        if (closure && n !== f.body) {
          for (const [name, k] of ps) if (mentions(n, name)) sum[k].bad = true
          return
        }
        if (ASSIGN_OPS.has(n[0]) && Array.isArray(n[1]) && n[1][0] === '[]' && ps.has(n[1][1])) {
          const s = sum[ps.get(n[1][1])], r = n[0] === '=' ? exprRange(n[2]) : null
          s.writes = true
          if (!r) s.bad = true; else s.range = hull(s.range, r)
        }
        // Aliases/returns escape the receiver; element/property reads do not.
        if (n[0] === 'return') for (const [name, k] of ps) if (carries(n[1], name)) sum[k].bad = true
        if (ASSIGN_OPS.has(n[0])) for (const [name, k] of ps) {
          if (n[1] === name || carries(n[2], name)) sum[k].bad = true
          if (Array.isArray(n[1]) && n[1][0] !== '[]' && mentions(n[1], name)) sum[k].bad = true
        }
        if (n[0] === '()') {
          const args = callArgs(n)
          const callee = typeof n[1] === 'string' ? n[1] : null
          for (const [name, k] of ps) {
            // Calling a method on the receiver may mutate it. A direct argument
            // to a known user function is handled by the summary fixpoint;
            // unknown or expression-hidden aliases poison immediately.
            if (mentions(n[1], name)) sum[k].bad = true
            for (const a of args) if (carries(a, name) && (!callee || !summaries.has(callee) || a !== name)) sum[k].bad = true
          }
        }
        for (let i = 1; i < n.length; i++) walk(n[i], closure)
      }
      walk(f.body)
    }
  }

  // Fold direct-effect summaries to a fixpoint across user-call forwarding: a
  // param passed straight through to another narrowable function's own param
  // inherits that callee's settled range/bad state, repeated until stable.
  function propagateCallForwarding() {
    let changed = true
    while (changed) {
      changed = false
      for (const f of funcs) {
        const ps = new Map(f.sig.params.map((p, i) => [p.name, i])), sum = summaries.get(f.name)
        walkAst(f.body, { enter: n => {
          if (n[0] === '=>') return false
          if (n[0] === '()' && typeof n[1] === 'string' && summaries.has(n[1])) {
            const args = callArgs(n), target = summaries.get(n[1])
            for (let k = 0; k < args.length; k++) if (ps.has(args[k])) {
              const s = sum[ps.get(args[k])], t = target[k]
              if (!t || t.bad) { if (!s.bad) { s.bad = true; changed = true } }
              else if (t.writes) {
                const r = hull(s.range, t.range)
                if (!s.writes || r[0] !== s.range?.[0] || r[1] !== s.range?.[1]) { s.writes = true; s.range = r; changed = true }
              }
            }
          }
        } })
      }
    }
  }

  // Per-function local typed-array variables: seed a range at each fresh
  // literal-initialized decl (initialRange), then narrow it at every element
  // store (storedRange) and every settled call-forwarding site (the param
  // summaries computeDirectEffects/propagateCallForwarding produced) —
  // poisoning on any alias/return-escape/opaque call, same discipline as the
  // param summaries above.
  function computeLocalRanges() {
    const locals = new Map()
    for (const f of funcs) {
      const ranges = new Map(), ctors = new Map(), poisoned = new Set(), freshDefs = new Set()
      const merge = (name, r) => {
        if (poisoned.has(name)) return
        if (!r) { poisoned.add(name); ranges.delete(name); return }
        ranges.set(name, hull(ranges.get(name), r))
      }
      walkAst(f.body, { enter: n => {
        if (n[0] === '=>') {
          for (const name of [...ranges.keys()]) if (mentions(n, name)) merge(name, null)
          return false
        }
        if (n[0] === 'let' || n[0] === 'const') for (let i = 1; i < n.length; i++) {
          const d = n[i]
          if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' && typedStaticLen(d[2]) != null) {
            const ctor = typedElemCtor(d[2]), init = initialRange(d[2], ctor)
            if (ctor && init) {
              ranges.set(d[1], init)
              ctors.set(d[1], ctor)
              freshDefs.add(d)
            }
          }
        }
        if (ASSIGN_OPS.has(n[0])) {
          if (Array.isArray(n[1]) && n[1][0] === '[]' && ranges.has(n[1][1]))
            merge(n[1][1], n[0] === '=' ? storedRange(ctors.get(n[1][1]), exprRange(n[2])) : null)
          for (const name of [...ranges.keys()]) {
            if (!freshDefs.has(n) && (n[1] === name || carries(n[2], name))) merge(name, null)
            if (Array.isArray(n[1]) && n[1][0] !== '[]' && mentions(n[1], name)) merge(name, null)
          }
        }
        if (n[0] === 'return') for (const name of [...ranges.keys()]) if (carries(n[1], name)) merge(name, null)
        if (n[0] === '()') {
          const args = callArgs(n), callee = typeof n[1] === 'string' ? n[1] : null
          const target = callee ? summaries.get(callee) : null
          for (const name of [...ranges.keys()]) {
            if (mentions(n[1], name)) merge(name, null)
            for (let k = 0; k < args.length; k++) if (carries(args[k], name)) {
              if (args[k] !== name || !target?.[k] || target[k].bad) merge(name, null)
              else if (target[k].writes) merge(name, storedRange(ctors.get(name), target[k].range))
            }
          }
        }
      } })
      locals.set(f, ranges)
    }
    return locals
  }

  computeDirectEffects()
  propagateCallForwarding()
  const locals = computeLocalRanges()
  return { locals, summaries, hull, initialRange }
}

