// Shared AST-level loop primitives for the per-function loop transforms
// (loop-divmod, loop-square, peel-stencil). Operates on the post-prepare AST.
//
// Each of those passes recognizes one narrow loop idiom and rewrites it, but they had
// re-derived the same building blocks verbatim: the `[, v]` number-literal-hole
// recognizer, the "+1 induction variable" matcher, the closure-mutated-variable
// analysis (a var assigned inside any `=>` may be mutated by a call in the loop, so it
// is unsafe as an IV/bound/divisor), the while/for structural normalizer, and the
// post-order block walk that applies a per-statement rewrite. One home for all of them
// — adding the next loop transform is then one recognizer over these, not a fourth copy.

import { MUTATE_OPS, walkAst, isReassigned } from '../ast.js'
import { ctx } from '../ctx.js'
import { findMutations } from './analyze-scans.js'
import { guardCounterName, forCounterRange, intExprRange, counterInit, constIntExpr } from '../static.js'

// Fresh id for a loop transform's generated locals (`__lsrx<id>`, `__pks<id>`, …). Backed by
// a per-compile counter (reset in ctx.reset), NOT a module-global: a module-`let` counter
// grows unbounded across a long-lived host and makes compile(P) non-deterministic — its output
// names depend on how many programs were compiled before it. Distinct prefixes keep the shared
// id space collision-free across transforms.
export const freshLoopId = () => ctx.transform.loopXformId++

// Post-prepare number literals are sparse-array holes `[<hole>, v]` (length 2, the op
// slot `n[0]` is the elided hole == null). `loopLitVal` returns the numeric value or
// null (distinct from ir.js's unchecked litVal — this one validates the literal shape
// first); `litN(n, k)` tests for the exact literal `k`.
export const loopLitVal = (n) => Array.isArray(n) && n.length === 2 && n[0] == null && typeof n[1] === 'number' ? n[1] : null
export const litN = (n, k) => Array.isArray(n) && n.length === 2 && n[0] == null && n[1] === k

// The induction variable a statement increments by exactly +1, else null. Covers
// `i++` (post-inc desugars to `(++i) - 1`), `++i`, `i += 1`, `i = i + 1` / `i = 1 + i`.
export function unitIncVar(stmt) {
  if (!Array.isArray(stmt)) return null
  let inc = stmt
  if (stmt[0] === '-' && litN(stmt[2], 1) && Array.isArray(stmt[1]) && stmt[1][0] === '++') inc = stmt[1]
  if (inc[0] === '++' && typeof inc[1] === 'string') return inc[1]
  if (stmt[0] === '+=' && typeof stmt[1] === 'string' && litN(stmt[2], 1)) return stmt[1]
  if (stmt[0] === '=' && typeof stmt[1] === 'string' && Array.isArray(stmt[2]) && stmt[2][0] === '+') {
    const [, a, b] = stmt[2]
    if (a === stmt[1] && litN(b, 1)) return stmt[1]
    if (b === stmt[1] && litN(a, 1)) return stmt[1]
  }
  return null
}

// Normalize a `while` / flat `for` (`['for', init, cond, update, body]`) into a common
// shape, else null. `init`/`step` are null for a while; a `for` with fewer than the 5
// flat slots (no body) is not a loop here.
export function normalizeLoop(stmt) {
  if (!Array.isArray(stmt)) return null
  if (stmt[0] === 'while') return { kind: 'while', init: null, cond: stmt[1], step: null, body: stmt[2] }
  if (stmt[0] === 'for' && stmt.length >= 5) return { kind: 'for', init: stmt[1], cond: stmt[2], step: stmt[3], body: stmt[4] }
  return null
}

// Variables assigned anywhere inside a closure (`=>`) in `body`. A call in the loop can
// mutate such a var even though a direct-write scan (findMutations) misses it (the
// closure may be defined outside the loop), so an IV / bound / divisor in this set is
// unsafe to strength-reduce. (ASSIGN_OPS plus the `++`/`--` updates.)
export function closureMutatedVars(body) {
  const out = new Set()
  const collect = (n) => walkAst(n, { enter: m => {
    if (typeof m[1] === 'string' && MUTATE_OPS.has(m[0])) out.add(m[1])
  } })
  walkAst(body, { enter: n => { if (n[0] === '=>') collect(n) } })
  return out
}

// The unique `+1` increment OF `iv` in a `;`-body: returns its statement index, or
// -1 when absent, or null when `iv` has TWO unit increments (ambiguous — every
// consumer bails). This is the `while`-loop IV-increment discovery each pass
// re-derived with its own scan; a `for`'s IV comes from unitIncVar(L.step).
// (Increments of OTHER variables are ignored — same as every original scan.)
// The sole unit-increment statement of ANY variable in a `;`-body — { iv, ivIdx }
// when exactly one statement is a `+1` increment (of whatever variable), else null.
// This is loop-divmod's IV DISCOVERY form: no candidate IV is known up front, and a
// second increment (even of another var) is ambiguous. Contrast uniqueUnitIncOf.
export function soleUnitInc(body) {
  if (!Array.isArray(body) || body[0] !== ';') return null
  let iv = null, ivIdx = -1
  for (let k = 1; k < body.length; k++) {
    const v = unitIncVar(body[k])
    if (v) { if (iv) return null; iv = v; ivIdx = k }
  }
  return iv ? { iv, ivIdx } : null
}

export function uniqueUnitIncOf(body, iv) {
  if (!Array.isArray(body) || body[0] !== ';') return null
  let ivIdx = -1
  for (let k = 1; k < body.length; k++) {
    if (unitIncVar(body[k]) === iv) { if (ivIdx >= 0) return null; ivIdx = k }
  }
  return ivIdx
}

// One safety oracle per loop: is `name` written by the loop body? Combines the
// two channels every pass paired by hand — direct writes (findMutations over the
// LOOP body) and closure writes (`cm` — closureMutatedVars over the FUNCTION
// body, since a closure defined outside the loop can be called inside it).
// `exceptIdx` excludes a statement (the IV's own increment) from the
// direct-write scan — the idiom of every IV-safety check.
export function loopHazards(cm, body) {
  return {
    mutated(name, exceptIdx = -1) {
      if (cm.has(name)) return true
      const src = exceptIdx >= 0 ? [';', ...body.slice(1).filter((_, k) => k !== exceptIdx - 1)] : body
      const m = new Set()
      findMutations(src, new Set([name]), m)
      return m.has(name)
    },
  }
}

// Post-order block rewriter: walk `body`; for every `;`-sequence, apply `tryStmt` to
// each statement. A truthy result is an ARRAY of replacement statements spliced in
// place; a falsy result keeps the statement unchanged. Children are rewritten first, so
// a nested loop is transformed before the block that encloses it.
export function rewriteBlocks(body, tryStmt) {
  // Copy a node only above a change: the tree keeps its identity where
  // nothing rewrote (the summary keys closures and cells by node, and every
  // emitted function ran four of these passes over a fresh copy of its body).
  const walk = (node) => {
    if (!Array.isArray(node)) return node
    let n = null
    for (let i = 0; i < node.length; i++) {
      const c = node[i], w = walk(c)
      if (n) n.push(w)
      else if (w !== c) { n = node.slice(0, i); n.push(w) }
    }
    n ??= node
    if (n[0] !== ';') return n
    let out = null
    for (let k = 1; k < n.length; k++) {
      const r = tryStmt(n[k])
      if (out) { if (r) out.push(...r); else out.push(n[k]) }
      else if (r) { out = n.slice(0, k); out.push(...r) }
    }
    return out ?? n
  }
  return walk(body)
}

// === Loop facts: what HIR proves about one emitted loop ===
//
// The 'for' emitter (compile/emit/control-flow.js) derives these once per loop it emits, in
// the refinement context that loop is emitted under (enclosing counters, branch guards, a
// versioned arm's magnitude proofs), so they are exactly the facts its body is emitted with.
// The emitter hands them to the optimizer through the loop's lowering link
// (ctx.plans.loweringLinks, src/ir/control.js): one derivation, read at every level.
//   iv, hull, step: the counter the guard tests, the range {lo, hi} it holds in the body, and
//     its step per iteration. Hull and step only when the step alone moves the counter (the
//     body never writes it), so the body runs at most ⌊(hi - lo) / step⌋ + 1 times per entry.
//   counters: the loop's other counters, `k` of `for (let j = 0, k = 0; …; j++, k += s)`: each
//     moves by an invariant amount per pass, so in the body it holds k₀ + t·s for a pass t
//     below the trip bound: [lo, hi] per counter. Only with a counter hull (the trip bound).
//   guard, guardRange, boundConst: the name a `<`/`<=` guard bounds, its bound's range, and
//     that bound when the range is one point. The first write to the name ends the fact,
//     so it needs no counter discipline.
export function loopFacts(init, cond, step, body) {
  const iv = guardCounterName(cond)
  const range = iv && !isReassigned(body, iv) ? forCounterRange(init, cond, step, iv) : null
  const guard = Array.isArray(cond) && (cond[0] === '<' || cond[0] === '<=') && typeof cond[1] === 'string' ? cond[1] : null
  const guardRange = guard ? intExprRange(cond[2]) : null
  return Object.freeze({
    iv,
    hull: range ? Object.freeze({ lo: range[0], hi: range[1] }) : null,
    step: range ? range.step : null,
    counters: range ? Object.freeze(secondaryCounters(init, step, body, iv, Math.floor((range[1] - range[0]) / range.step) + 1)) : [],
    guard,
    guardRange,
    boundConst: guardRange && guardRange[0] === guardRange[1] ? guardRange[0] : null,
  })
}

/** The refinements a loop's facts give its body: each counter's range there. */
export function counterRefinements(facts) {
  const refs = new Map()
  if (facts.hull) refs.set(facts.iv, { rlo: facts.hull.lo, rhi: facts.hull.hi })
  for (const { name, lo, hi } of facts.counters) refs.set(name, { rlo: lo, rhi: hi })
  return refs
}

// A step that moves `name` by a fixed amount per pass: `x++`, `x--`, `x += S`, `x -= S`,
// `x = x ± S`, `x = S + x` (a postfix value, `(++x) - 1`, is the same write) →
// { name, by, sign }, else null.
function counterStep(s) {
  if (Array.isArray(s) && s.length === 3 && (s[0] === '-' || s[0] === '+') && Array.isArray(s[1]) &&
      (s[1][0] === '++' || s[1][0] === '--') && constIntExpr(s[2]) === 1) s = s[1]
  if (!Array.isArray(s) || typeof s[1] !== 'string') return null
  const [op, x, v] = s
  if ((op === '++' || op === '--') && s.length === 2) return { name: x, by: 1, sign: op === '++' ? 1 : -1 }
  if (op === '+=' || op === '-=') return { name: x, by: v, sign: op === '+=' ? 1 : -1 }
  if (op === '=' && Array.isArray(v) && v.length === 3 && (v[0] === '+' || v[0] === '-') && v[1] === x) return { name: x, by: v[2], sign: v[0] === '+' ? 1 : -1 }
  if (op === '=' && Array.isArray(v) && v.length === 3 && v[0] === '+' && v[2] === x) return { name: x, by: v[1], sign: 1 }
  return null
}

// The loop's secondary counters and their body ranges, given at most `trips` passes per entry.
// A step amount is a literal or a name that neither the body nor the step writes.
function secondaryCounters(init, step, body, iv, trips) {
  const steps = Array.isArray(step) && step[0] === ',' ? step.slice(1) : [step]
  const moves = steps.map(counterStep)
  const written = new Set(moves.filter(Boolean).map(m => m.name))
  const out = []
  for (const m of moves) {
    if (!m || m.name === iv || moves.filter(x => x?.name === m.name).length !== 1 || isReassigned(body, m.name)) continue
    if (typeof m.by === 'string' && (written.has(m.by) || isReassigned(body, m.by) || steps.some(x => isReassigned(x, m.by)))) continue
    if (typeof m.by !== 'string' && constIntExpr(m.by) == null && typeof m.by !== 'number') continue
    const from = counterInit(init, m.name)
    const k0 = from == null ? null : intExprRange(from)
    const by = typeof m.by === 'number' ? [m.by, m.by] : intExprRange(m.by)
    if (!k0 || !by) continue
    const [sLo, sHi] = m.sign > 0 ? by : [-by[1], -by[0]]
    const lo = k0[0] + Math.min(0, sLo * (trips - 1)), hi = k0[1] + Math.max(0, sHi * (trips - 1))
    if (Number.isSafeInteger(lo) && Number.isSafeInteger(hi)) out.push(Object.freeze({ name: m.name, lo, hi }))
  }
  return out
}
