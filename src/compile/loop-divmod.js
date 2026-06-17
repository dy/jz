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

import { findMutations } from './analyze-scans.js'

const litN = (n, k) => Array.isArray(n) && n.length === 2 && n[0] == null && n[1] === k
const isMod = (n, i, w) => Array.isArray(n) && n[0] === '%' && n[1] === i && n[2] === w
const isFloorDiv = (n, i, w) =>
  Array.isArray(n) && n[0] === '|' && litN(n[2], 0) &&
  Array.isArray(n[1]) && n[1][0] === '/' && n[1][1] === i && n[1][2] === w

// IV a statement increments by exactly +1, or null. Covers `i++` (post-inc desugars
// to `(++i) - 1`), `++i`, `i += 1`, `i = i + 1`.
function incVarOf(stmt) {
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

const usesPattern = (n, i, w, pred) => Array.isArray(n) && (pred(n, i, w) || n.some(c => usesPattern(c, i, w, pred)))
const replace = (n, i, w, cx, cy) =>
  !Array.isArray(n) ? n : isMod(n, i, w) ? cx : isFloorDiv(n, i, w) ? cy : n.map(c => replace(c, i, w, cx, cy))
// a `continue` that targets THIS loop (not one nested inside) — would skip the increment
const hasOuterContinue = (n) => Array.isArray(n) &&
  (n[0] === 'continue' || (n[0] !== 'while' && n[0] !== 'for' && n[0] !== 'do' && n[0] !== '=>' && n.some(hasOuterContinue)))
// Vars assigned anywhere inside a closure in the function. Such a var can be
// mutated by a call in the loop body (the closure may be defined outside the loop,
// so a body-local findMutations misses it), so it is not safe as the IV or divisor.
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '&&=', '||=', '??='])
const collectAssigns = (n, out) => {
  if (!Array.isArray(n)) return
  if (typeof n[1] === 'string' && (ASSIGN_OPS.has(n[0]) || n[0] === '++' || n[0] === '--')) out.add(n[1])
  n.forEach(c => collectAssigns(c, out))
}
const closureMutated = (n, out) => {
  if (!Array.isArray(n)) return out
  if (n[0] === '=>') collectAssigns(n, out)
  n.forEach(c => closureMutated(c, out))
  return out
}

let _uniq = 0
let _cm = new Set()  // closure-mutated vars for the function currently being transformed

// Try to strength-reduce one `while` statement. Returns [seed, loop] or null.
function tryReduce(stmt) {
  if (!Array.isArray(stmt) || stmt[0] !== 'while') return null
  const cond = stmt[1], lbody = stmt[2]
  if (!Array.isArray(lbody) || lbody[0] !== ';') return null

  // exactly one IV incremented by +1
  let iv = null, ivIdx = -1
  for (let k = 1; k < lbody.length; k++) {
    const v = incVarOf(lbody[k])
    if (v) { if (iv) return null; iv = v; ivIdx = k }
  }
  if (!iv) return null

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

  // soundness: w invariant, iv written ONLY by the increment, no continue/closure capture
  const wMut = new Set(); findMutations(lbody, new Set([w]), wMut)
  if (wMut.has(w)) return null
  const ivMut = new Set()
  findMutations([';', ...lbody.slice(1).filter((_, k) => k !== ivIdx - 1)], new Set([iv]), ivMut)
  if (ivMut.has(iv)) return null
  if (hasOuterContinue(lbody)) return null
  if (_cm.has(iv) || _cm.has(w)) return null  // IV/divisor mutable via a closure call

  const id = _uniq++
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

// Walk the body; transform `while` loops inside every block (post-order so a nested
// loop is reduced before its enclosing one is examined).
function walk(node) {
  if (!Array.isArray(node)) return node
  const n = node.map(walk)
  if (n[0] !== ';') return n
  const out = [';']
  for (let k = 1; k < n.length; k++) {
    const r = tryReduce(n[k])
    if (r) out.push(...r)
    else out.push(n[k])
  }
  return out
}

export function strengthReduceLoopDivMod(body) {
  _cm = closureMutated(body, new Set())
  return walk(body)
}
