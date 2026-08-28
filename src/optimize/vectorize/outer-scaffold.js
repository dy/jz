import { walkAst } from '../../ast.js'
import { constNum, hasImpureCall, isI32Const, isLocalGet } from './addr-model.js'
import { isArr } from './node-utils.js'
import { matchBlockLoop } from './scaffold.js'

export const CMP_NEG = {  // comparison → its logical negation (active lanes are finite → NaN-free)
  'f64.gt': 'f64.le', 'f64.ge': 'f64.lt', 'f64.lt': 'f64.ge', 'f64.le': 'f64.gt', 'f64.eq': 'f64.ne', 'f64.ne': 'f64.eq',
  'i32.lt_s': 'i32.ge_s', 'i32.ge_s': 'i32.lt_s', 'i32.gt_s': 'i32.le_s', 'i32.le_s': 'i32.gt_s',
  'i32.lt_u': 'i32.ge_u', 'i32.ge_u': 'i32.lt_u', 'i32.gt_u': 'i32.le_u', 'i32.le_u': 'i32.gt_u',
}
export const CMP_LANE = {  // f64/i32 scalar compare → f64x2 lane compare (iter is f64x2; z-compares are f64)
  'f64.gt': 'f64x2.gt', 'f64.ge': 'f64x2.ge', 'f64.lt': 'f64x2.lt', 'f64.le': 'f64x2.le', 'f64.eq': 'f64x2.eq', 'f64.ne': 'f64x2.ne',
  'i32.lt_s': 'f64x2.lt', 'i32.le_s': 'f64x2.le', 'i32.ge_s': 'f64x2.ge', 'i32.gt_s': 'f64x2.gt',
  'i32.lt_u': 'f64x2.lt', 'i32.le_u': 'f64x2.le', 'i32.ge_u': 'f64x2.ge', 'i32.gt_u': 'f64x2.gt',
}
export const readsVar = (n, v) => {
  let found = false
  walkAst(n, { enter: x => { if (found) return false; if (x[0] === 'local.get' && x[1] === v) { found = true; return false } } })
  return found
}
export const writesName = (n, name) => {
  let found = false
  walkAst(n, { enter: x => {
    if (found) return false
    if ((x[0] === 'local.set' || x[0] === 'local.tee' || x[0] === 'global.set') && x[1] === name) { found = true; return false }
  } })
  return found
}

// Epilogue safety (class-A hoist, .work/research.md §BodyModel §1a/§5 slice 3): the per-pixel
// epilogue runs scalar per lane (each statement bumped to pixel j+k), so every in-loop read it
// makes must be a lane local (per-lane source via `laneMap`), a pixel IV (`pivType`), or a value
// the epilogue itself computes (`epiWritten` — incl. within-statement tees, e.g. an Infinity-guard
// temp inside an `(if … |0)` pack; straight-line source guarantees write-before-read). Verified
// byte-identical at all three call sites (tryPerPixelColor, tryOuterStrip, tryIteratedReduce)
// before this hoist — same `wr`/read-collection/rejection-loop shape, only the surrounding
// variable names (`reads` vs `epiReadSet`) differed. Returns `{ epiWritten, reads }` (both Sets)
// when safe, `null` when the epilogue reads an in-loop value with no per-lane source (caller bails).
export function epilogueIsSafe(epilogue, loopNode, laneMap, pivType) {
  const epiWritten = new Set()
  for (const s of epilogue) walkAst(s, { enter: n => { if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') epiWritten.add(n[1]) } })
  const reads = new Set()
  for (const s of epilogue) walkAst(s, { enter: n => { if (n[0] === 'local.get') { reads.add(n[1]); return false } } })
  for (const v of reads) if (writesName(loopNode, v) && !laneMap.has(v) && !epiWritten.has(v) && !pivType.has(v)) return null
  return { epiWritten, reads }
}
// Pixel induction variables may be i32 (const-bound loops) or f64 (param-bound loops,
// e.g. `for (x=0; x<width; ++x)` with f64 `width`). Match `v += 1` and `v < bound` for both.
const matchPixelInc = (stmt) => {
  if (!isArr(stmt) || stmt[0] !== 'local.set' || stmt.length !== 3) return null
  const x = stmt[1], v = stmt[2]
  if (!isArr(v) || v.length !== 3 || !isLocalGet(v[1], x)) return null
  if (v[0] === 'i32.add' && constNum(v[2]) === 1) return { name: x, type: 'i32' }
  if (v[0] === 'f64.add' && isArr(v[2]) && v[2][0] === 'f64.const' && Number(v[2][1]) === 1) return { name: x, type: 'f64' }
  return null
}
const matchPixelExit = (stmt, label) => {
  if (!isArr(stmt) || stmt[0] !== 'br_if' || stmt[1] !== label) return null
  const cond = stmt[2]
  if (!isArr(cond) || cond[0] !== 'i32.eqz') return null
  const cmp = cond[1]
  if (!isArr(cmp) || !isLocalGet(cmp[1])) return null
  if (cmp[0] === 'i32.lt_s' || cmp[0] === 'i32.lt_u') return { ind: cmp[1][1], bound: cmp[2], cmpOp: cmp[0], type: 'i32' }
  if (cmp[0] === 'f64.lt') return { ind: cmp[1][1], bound: cmp[2], cmpOp: cmp[0], type: 'f64' }
  return null
}

/**
 * Match the OUTER per-pixel loop scaffold shared by tryDivergentEscapeVectorize
 * (inner escape loop) and tryPerPixelColor (straight-line body):
 *   (block $o [preamble: pure local.set…]
 *     (loop $l (br_if $o (i32.eqz (IV < WIDTH))) OBODY… (pxIV += 1)… (br $l)))
 * One-or-more trailing `v += 1` are pixel induction vars (the bound IV plus any
 * parallel counters like `j`); the exit bounds one of them by an invariant width.
 *
 * Returns the shared FACTS, or null:
 *   { oLabel, loopNode, preamble, pixelIVs, pivStart, pxVar, widthBound, pivType,
 *     obody, hasImpureCall }  — obody = loopNode.slice(3, pivStart), the per-pixel
 *   work between the exit guard and the IV bumps; hasImpureCall = obody.some of the
 *   module-level hasImpureCall predicate (strict: no $math.* exemption beyond the
 *   builtin one). Every consumer branches on `obody` afterward; strip/iterated-
 *   reduce/conv-column also read `hasImpureCall` directly instead of re-scanning.
 * The bound is re-evaluated for the SIMD guard, so it must be invariant + pure:
 *   a constant, or a local/global the loop nest never writes (`writesName`).
 */
export function matchOuterPixelLoop(blockNode) {
  const bl = matchBlockLoop(blockNode, { envelope: 'pixelIV' })
  if (!bl) return null
  const { blockLabel: oLabel, loopNode, preamble, endIdx: oEnd } = bl
  const pixelIVs = []   // [{ name, type }]
  let pivStart = oEnd
  for (let i = oEnd - 1; i >= 3; i--) {
    const m = matchPixelInc(loopNode[i])
    if (!m) break
    pixelIVs.unshift(m); pivStart = i
  }
  if (!pixelIVs.length) return null
  const oExit = matchPixelExit(loopNode[2], oLabel)
  const pxIV = oExit && pixelIVs.find(p => p.name === oExit.ind && p.type === oExit.type)
  if (!pxIV) return null
  const widthBound = oExit.bound
  const pivType = new Map(pixelIVs.map(p => [p.name, p.type]))
  if (isI32Const(widthBound)) { /* ok */ }
  else if (isArr(widthBound) && (widthBound[0] === 'local.get' || widthBound[0] === 'global.get')) {
    if (writesName(loopNode, widthBound[1])) return null
  } else return null
  const obody = loopNode.slice(3, pivStart)     // between exit guard and the pixel-IV bumps
  // Inner block-loop census — every outer-pixel consumer re-derived this scan
  // (exactly-one / none / at-least-one gates); one authoritative list here.
  const innerIdxs = []
  for (let i = 0; i < obody.length; i++) {
    const s = obody[i]
    if (isArr(s) && s[0] === 'block' && s.slice(1).some(c => isArr(c) && c[0] === 'loop')) innerIdxs.push(i)
  }
  return { oLabel, loopNode, preamble, pixelIVs, pivStart, pxVar: oExit.ind, widthBound, pivType, obody, oExit, innerIdxs, hasImpureCall: obody.some(hasImpureCall) }
}

/**
 * Substitute every pixel-IV `local.get` in `n` with (IV + k), in the IV's own wasm type —
 * the per-lane epilogue bump (lane k of a strip re-runs the scalar epilogue at pixel index
 * base+k). Every outer-pixel recognizer (tryDivergentEscapeVectorize, tryPerPixelColor,
 * tryOuterStrip, tryIteratedReduce, tryConvColumn) re-derived this exact walk, closed over
 * its own local `pivType` — already a field of the LoopPlan's matchOuterPixelLoop descriptor
 * (`outer.pivType`, Map pixel-IV name → wasm type); hoisted here parametrized on pivType.
 */
export function bumpPixelIV(pivType, n, k) {
  if (k === 0) return n
  if (isArr(n) && n[0] === 'local.get' && pivType.has(n[1]))
    return [pivType.get(n[1]) + '.add', n, [pivType.get(n[1]) + '.const', k]]
  return isArr(n) ? n.map(c => bumpPixelIV(pivType, c, k)) : n
}

/**
 * The two lanes of a pixel-IV local (or its alias) as an f64x2 ramp [v, v+1] — an i32 IV
 * converts per lane. Every outer-pixel recognizer that builds a per-pixel coordinate lane
 * (tryPerPixelColor, tryOuterStrip, tryIteratedReduce) re-derived this identically; hoisted
 * as the LoopPlan companion to bumpPixelIV, same pivType parametrization.
 */
export function rampPixelIV(pivType, piv) {
  return pivType.get(piv) === 'f64'
    ? ['f64x2.replace_lane', 1, ['f64x2.splat', ['local.get', piv]], ['f64.add', ['local.get', piv], ['f64.const', 1]]]
    : ['f64x2.replace_lane', 1, ['f64x2.splat', ['f64.convert_i32_s', ['local.get', piv]]], ['f64.convert_i32_s', ['i32.add', ['local.get', piv], ['i32.const', 1]]]]
}

