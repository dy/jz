/**
 * SIMD module — source-level f32x4 / i32x4 / f64x2 intrinsics that lower 1:1 to wasm
 * SIMD (v128). Lets a jz kernel process 4 (or, for f64x2, 2) lanes per instruction:
 * the per-pixel-parallel kernels (mandelbrot, raymarcher) run 4 pixels/rays in masked
 * lockstep, and the attractors kernel packs its two sines + two cosines two-per-f64x2.
 * Several-fold over scalar V8 (validated: SIMD-4 mandelbrot ≈ 4.6× a warm-V8 scalar loop).
 *
 * A v128 value is just a local whose wasm type is `v128` (exprType returns 'v128'
 * for these calls; emit passes it through without an f64/i32 coercion). Building
 * blocks for the masked-lockstep idiom:
 *
 *   f32x4.splat(x)            broadcast a scalar to 4 f32 lanes
 *   f32x4.lanes(a,b,c,d)      build a vector from 4 scalars (compile-time consts ok)
 *   f32x4.add/sub/mul/div(a,b)
 *   f32x4.sqrt/abs/neg/floor(a)
 *   f32x4.min/max(a,b)
 *   f32x4.le/lt/ge/gt/eq(a,b) → i32x4 lane mask (all-ones / all-zero per lane)
 *   f32x4.lane(v, k)          extract lane k (0..3) as a number
 *   i32x4.splat(n) / add/sub(a,b) / lane(v,k)
 *   v128.and/or/xor(a,b) / not(a) / bitselect(t,f,mask)
 *   v128.anyTrue(v) / v128.allTrue(v) → i32 (loop-exit tests)
 *   f64x2.splat(x) / lanes(a,b) / add/sub/mul/div/min/max / sqrt/abs/neg/… / cmp
 *   f64x2.sin(v) / f64x2.cos(v) → both lanes through one poly ($math.sin2/$math.cos2)
 *   f64x2.lane(v, k)          extract lane k (0..1) as a number
 *
 * @module simd
 */
import { typed, asF64, asI32 } from '../src/ir.js'
import { emit, emitter } from '../src/bridge.js'
import { err } from '../src/ctx.js'

export default (ctx) => {
  const e = ctx.core.emit
  const V = (node) => typed(node, 'v128')          // a v128-typed (lane vector) result
  const I = (node) => typed(node, 'i32')            // an i32 result (lane extract / any_true)
  const F = (node) => typed(node, 'f64')            // an f64 result (f32 lane → number)
  const op = (a) => emit(a)                          // operand IR (v128 local.get, or a nested v128 expr) — NOT coerced to f64
  const f32 = (a) => ['f32.demote_f64', asF64(emit(a))]   // scalar → f32 for splat/lanes
  // lane index must be a 0..3 literal — wasm extract_lane takes an immediate, so a
  // runtime index can't lower (and would silently read lane 0). Fail loudly instead.
  const laneIdx = (k) => {
    const v = typeof k === 'number' ? k : (Array.isArray(k) && k.length === 2 && k[0] == null && typeof k[1] === 'number') ? k[1] : null
    if (v == null || (v | 0) !== v || v < 0 || v > 3)
      err(`SIMD lane index must be a 0..3 literal (got ${JSON.stringify(k)}) — wasm extract_lane needs a constant lane.`)
    return v
  }

  // ── build / broadcast ──────────────────────────────────────────────────────
  e['f32x4.splat'] = (a) => V(['f32x4.splat', f32(a)])
  e['f32x4.lanes'] = (a, b, c, d) => V(['f32x4.replace_lane', 3,
    ['f32x4.replace_lane', 2,
      ['f32x4.replace_lane', 1, ['f32x4.splat', f32(a)], f32(b)], f32(c)], f32(d)])
  e['i32x4.splat'] = (a) => V(['i32x4.splat', asI32(emit(a))])

  // ── f32x4 arithmetic ─────────────────────────────────────────────────────────
  for (const o of ['add', 'sub', 'mul', 'div', 'min', 'max'])
    e[`f32x4.${o}`] = (a, b) => V([`f32x4.${o}`, op(a), op(b)])
  for (const o of ['sqrt', 'abs', 'neg', 'floor', 'ceil', 'trunc', 'nearest'])
    e[`f32x4.${o}`] = (a) => V([`f32x4.${o}`, op(a)])

  // ── f32x4 comparisons → i32x4 lane mask (v128 of all-ones/all-zero lanes) ─────
  for (const o of ['eq', 'ne', 'lt', 'le', 'gt', 'ge'])
    e[`f32x4.${o}`] = (a, b) => V([`f32x4.${o}`, op(a), op(b)])

  // ── i32x4 arithmetic (iteration counters, masks as ±1) ───────────────────────
  for (const o of ['add', 'sub', 'mul'])
    e[`i32x4.${o}`] = (a, b) => V([`i32x4.${o}`, op(a), op(b)])
  // i32x4 comparisons → lane mask (signed). eq/ne have no suffix; the rest are _s.
  for (const o of ['eq', 'ne', 'lt', 'le', 'gt', 'ge'])
    e[`i32x4.${o}`] = (a, b) => V([`i32x4.${o}${o === 'eq' || o === 'ne' ? '' : '_s'}`, op(a), op(b)])
  // shifts by a scalar count (for float-bit twiddling: exponent extract, etc.)
  e['i32x4.shl'] = (a, n) => V(['i32x4.shl', op(a), asI32(emit(n))])
  e['i32x4.shr'] = (a, n) => V(['i32x4.shr_s', op(a), asI32(emit(n))])
  e['i32x4.shrU'] = (a, n) => V(['i32x4.shr_u', op(a), asI32(emit(n))])
  // lane-wise int → float conversion (i32x4.convert) — the value, not a bit reinterpret
  e['f32x4.convertI32'] = (a) => V(['f32x4.convert_i32x4_s', op(a)])

  // ── v128 bitwise + select + reductions ───────────────────────────────────────
  for (const o of ['and', 'or', 'xor'])
    e[`v128.${o}`] = (a, b) => V([`v128.${o}`, op(a), op(b)])
  e['v128.not'] = (a) => V(['v128.not', op(a)])
  e['v128.bitselect'] = (t, f, m) => V(['v128.bitselect', op(t), op(f), op(m)])
  e['v128.anyTrue'] = (a) => I(['v128.any_true', op(a)])
  e['v128.allTrue'] = (a) => I(['i32x4.all_true', op(a)])

  // ── lane extract (read a single lane back to a scalar) ───────────────────────
  e['f32x4.lane'] = (v, k) => F(['f64.promote_f32', ['f32x4.extract_lane', laneIdx(k), op(v)]])
  e['i32x4.lane'] = (v, k) => I(['i32x4.extract_lane', laneIdx(k), op(v)])

  // ── f64x2 — two full-precision f64 lanes (no f32 demotion) ───────────────────
  // For kernels whose hot value is f64: two independent angles/coords per instruction.
  // `f64x2.sin`/`f64x2.cos` lower to the shared $math.sin2/$math.cos2 poly (module/math.js)
  // — sin and cos of distinct args pack two-per-vector and ≈halve transcendental cost.
  const lane2 = (k) => {
    const v = typeof k === 'number' ? k : (Array.isArray(k) && k.length === 2 && k[0] == null && typeof k[1] === 'number') ? k[1] : null
    if (v == null || (v | 0) !== v || v < 0 || v > 1)
      err(`f64x2 lane index must be a 0..1 literal (got ${JSON.stringify(k)}).`)
    return v
  }
  e['f64x2.splat'] = (a) => V(['f64x2.splat', asF64(emit(a))])
  e['f64x2.lanes'] = (a, b) => V(['f64x2.replace_lane', 1, ['f64x2.splat', asF64(emit(a))], asF64(emit(b))])
  for (const o of ['add', 'sub', 'mul', 'div', 'min', 'max'])
    e[`f64x2.${o}`] = (a, b) => V([`f64x2.${o}`, op(a), op(b)])
  for (const o of ['sqrt', 'abs', 'neg', 'floor', 'ceil', 'trunc', 'nearest'])
    e[`f64x2.${o}`] = (a) => V([`f64x2.${o}`, op(a)])
  for (const o of ['eq', 'ne', 'lt', 'le', 'gt', 'ge'])
    e[`f64x2.${o}`] = (a, b) => V([`f64x2.${o}`, op(a), op(b)])
  e['f64x2.sin'] = emitter(['math.sin2'], (a) => V(['call', '$math.sin2', op(a)]))
  e['f64x2.cos'] = emitter(['math.cos2'], (a) => V(['call', '$math.cos2', op(a)]))
  // f64x2.log/exp/exp2 lower to the true-vectorized $math.log_v/$math.exp_v/$math.exp2_v polys —
  // both lanes through one fdlibm/2^f evaluation (≈2× over two scalar calls), bit-exact via a
  // hot-path-vectorized + scalar-edge-fallback split (module/math.js).
  e['f64x2.log'] = emitter(['math.log_v'], (a) => V(['call', '$math.log_v', op(a)]))
  e['f64x2.exp'] = emitter(['math.exp_v'], (a) => V(['call', '$math.exp_v', op(a)]))
  e['f64x2.exp2'] = emitter(['math.exp2_v'], (a) => V(['call', '$math.exp2_v', op(a)]))
  e['f64x2.lane'] = (v, k) => F(['f64x2.extract_lane', lane2(k), op(v)])
}
