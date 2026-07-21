// Loop induction strength-reduction for `i % w` and `(i / w) | 0`.
//
// JS `%` and `/` are float ops; `i % w` with a RUNTIME divisor lowers to f64
// (i % 0 is NaN, so it can't be soundly typed i32 — see type.js exprType `%`).
// That makes the column `x = i % w` an f64 local, which cascades: every dependent
// neighbour index becomes f64 and each typed-array access pays an f64→i32 convert.
// Measured ~5× slower than V8, which speculates the divisor non-zero and uses i32.
//
// This pass replaces the per-iteration division with incremental i32 counters in a
// unit-stride loop: the column `cx` increments by 1 and wraps to 0 at `w`, bumping
// the row `cy`. No division survives in the body, so the whole index chain stays
// i32. Fully sound — counters are pure increment (the divisor-zero question never
// arises), and if `w == 0` the loop's `i < w*h` guard never admits an iteration, so
// the one-time seed `(i%w)|0` (NaN→0) is unused.
//
// Recognized (post-prepare AST): a `while` whose body increments one IV `i` by +1
// exactly once, reads `['%', i, w]` and/or `['|', ['/', i, w], LIT0]` with `w`
// loop-invariant, and has no `continue` / closure-capture of i,w (which could
// desync the counters). Number literals are sparse-array holes `[, v]` (n[0] is the
// hole = undefined), so literal tests use `== null`; created literals are bare numbers.

import { litN, normalizeLoop, closureMutatedVars, rewriteBlocks, freshLoopId, soleUnitInc, loopHazards } from './loop-model.js'

const isMod = (n, i, w) => Array.isArray(n) && n[0] === '%' && n[1] === i && n[2] === w
const isFloorDiv = (n, i, w) =>
  Array.isArray(n) && n[0] === '|' && litN(n[2], 0) &&
  Array.isArray(n[1]) && n[1][0] === '/' && n[1][1] === i && n[1][2] === w

const usesPattern = (n, i, w, pred) => Array.isArray(n) && (pred(n, i, w) || n.some(c => usesPattern(c, i, w, pred)))
const replace = (n, i, w, cx, cy) =>
  !Array.isArray(n) ? n : isMod(n, i, w) ? cx : isFloorDiv(n, i, w) ? cy : n.map(c => replace(c, i, w, cx, cy))
// a `continue` that targets THIS loop (not one nested inside) — would skip the increment
const hasOuterContinue = (n) => Array.isArray(n) &&
  (n[0] === 'continue' || (n[0] !== 'while' && n[0] !== 'for' && n[0] !== 'do' && n[0] !== '=>' && n.some(hasOuterContinue)))


// Try to strength-reduce one `while` statement. Returns [seed, loop] or null. `cm` is
// the function's closure-mutated-vars set (an IV/divisor in it is unsafe).
function tryReduce(stmt, cm) {
  const L = normalizeLoop(stmt)
  if (!L || L.kind !== 'while') return null
  const cond = L.cond, lbody = L.body
  if (!Array.isArray(lbody) || lbody[0] !== ';') return null

  // exactly one IV incremented by +1
  const inc = soleUnitInc(lbody)
  if (!inc) return null
  const { iv, ivIdx } = inc

  // a single invariant divisor `w` (`i % w` / `(i/w)|0` all share it)
  let w = null
  const findW = (n) => {
    if (!Array.isArray(n)) return
    const d = n[0] === '%' && n[1] === iv ? n[2]
      : (n[0] === '|' && litN(n[2], 0) && Array.isArray(n[1]) && n[1][0] === '/' && n[1][1] === iv) ? n[1][2] : null
    if (typeof d === 'string') { if (w == null) w = d; else if (w !== d) w = false }
    n.forEach(findW)
  }
  findW(lbody)
  if (!w || w === iv) return null

  const usesMod = usesPattern(lbody, iv, w, isMod)
  const usesDiv = usesPattern(lbody, iv, w, isFloorDiv)
  if (!usesMod && !usesDiv) return null

  // soundness: w invariant, iv written ONLY by the increment (both incl. closure
  // writes — a call in the loop can invoke a mutating `=>`), no outer continue
  const hz = loopHazards(cm, lbody)
  if (hz.mutated(w) || hz.mutated(iv, ivIdx)) return null
  if (hasOuterContinue(lbody)) return null

  const id = freshLoopId()
  const cx = `__lsrx${id}`, cy = `__lsry${id}`
  // seed (inside the w>0 branch): cx = (i%w)|0, cy = (i/w)|0 — one-time, i32 via |0
  const seedDecls = [['=', cx, ['|', ['%', iv, w], 0]]]
  if (usesDiv) seedDecls.push(['=', cy, ['|', ['/', iv, w], 0]])
  const seed = ['let', ...seedDecls]

  // transformed body: replace patterns, inject `cx++; if(cx>=w){cx=0; cy++}` after the increment
  const newBody = [';']
  for (let k = 1; k < lbody.length; k++) {
    newBody.push(replace(lbody[k], iv, w, cx, cy))
    if (k === ivIdx) {
      newBody.push(['=', cx, ['+', cx, 1]])
      if (usesDiv) newBody.push(['=', cy, ['+', cy, ['?:', ['>=', cx, w], 1, 0]]])
      newBody.push(['=', cx, ['?:', ['>=', cx, w], 0, cx]])
    }
  }
  const fast = ['while', replace(cond, iv, w, cx, cy), newBody]
  // The counters track i%w only when w>0 AND i>=0: w<=0 gives NaN / a negative-divisor
  // modulo, and i<0 makes i%w negative (JS modulo takes the dividend's sign) — neither
  // follows the 0..w-1 +1-wrap the counters model. A one-time `w>0 && i>=0` guard (i is
  // the IV's entry value; it only increments, so it stays ≥0) keeps the fast i32 path
  // for the universal positive-dimension, forward-counting case and falls back to the
  // unmodified loop otherwise — sound for any w, any start.
  return [['if', ['&&', ['>', w, 0], ['>=', iv, 0]], ['{}', [';', seed, fast]], stmt]]
}

export function strengthReduceLoopDivMod(body) {
  const cm = closureMutatedVars(body)
  return rewriteBlocks(body, stmt => tryReduce(stmt, cm))
}
