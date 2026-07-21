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

import { ASSIGN_OPS } from '../ast.js'
import { ctx } from '../ctx.js'
import { findMutations } from './analyze-scans.js'

// Fresh id for a loop transform's generated locals (`__lsrx<id>`, `__pks<id>`, …). Backed by
// a per-compile counter (reset in ctx.reset), NOT a module-global: a module-`let` counter
// grows unbounded across a long-lived host and makes compile(P) non-deterministic — its output
// names depend on how many programs were compiled before it. Distinct prefixes keep the shared
// id space collision-free across transforms.
export const freshLoopId = () => ctx.transform.loopXformId++

// Post-prepare number literals are sparse-array holes `[<hole>, v]` (length 2, the op
// slot `n[0]` is the elided hole == null). `litVal` returns the numeric value or null;
// `litN(n, k)` tests for the exact literal `k`.
export const litVal = (n) => Array.isArray(n) && n.length === 2 && n[0] == null && typeof n[1] === 'number' ? n[1] : null
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
  const collect = (n) => {
    if (!Array.isArray(n)) return
    if (typeof n[1] === 'string' && (ASSIGN_OPS.has(n[0]) || n[0] === '++' || n[0] === '--')) out.add(n[1])
    n.forEach(collect)
  }
  const walk = (n) => {
    if (!Array.isArray(n)) return
    if (n[0] === '=>') collect(n)
    n.forEach(walk)
  }
  walk(body)
  return out
}

// The unique `+1` increment OF `iv` in a `;`-body: returns its statement index, or
// -1 when absent, or null when `iv` has TWO unit increments (ambiguous — every
// consumer bails). This is the `while`-loop IV-increment discovery each pass
// re-derived with its own scan; a `for`'s IV comes from unitIncVar(L.step).
// (Increments of OTHER variables are ignored — same as every original scan.)
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
  const walk = (node) => {
    if (!Array.isArray(node)) return node
    const n = node.map(walk)
    if (n[0] !== ';') return n
    const out = [';']
    for (let k = 1; k < n.length; k++) {
      const r = tryStmt(n[k])
      if (r) out.push(...r); else out.push(n[k])
    }
    return out
  }
  return walk(body)
}
