export const LANE_INFO = {
  i8:  { lanes: 16, strideLog2: 0, stride: 1, splat: 'i8x16.splat', constOp: 'i32.const' },
  i16: { lanes: 8,  strideLog2: 1, stride: 2, splat: 'i16x8.splat', constOp: 'i32.const' },
  i32: { lanes: 4,  strideLog2: 2, stride: 4, splat: 'i32x4.splat', constOp: 'i32.const' },
  i64: { lanes: 2,  strideLog2: 3, stride: 8, splat: 'i64x2.splat', constOp: 'i64.const' },
  f32: { lanes: 4,  strideLog2: 2, stride: 4, splat: 'f32x4.splat', constOp: 'f32.const' },
  f64: { lanes: 2,  strideLog2: 3, stride: 8, splat: 'f64x2.splat', constOp: 'f64.const' },
}

// Narrow loads/stores (i32.load8_u etc.) define i8 / i16 lane types — values
// computed in i32 then truncated by store{8,16}, which matches i{8,16}xN wrap
// semantics exactly.
export const LOAD_OPS = {
  'i32.load8_u': 'i8',  'i32.load8_s': 'i8',
  'i32.load16_u': 'i16','i32.load16_s': 'i16',
  'i32.load': 'i32', 'i64.load': 'i64', 'f32.load': 'f32', 'f64.load': 'f64',
}
export const STORE_OPS = {
  'i32.store8': 'i8', 'i32.store16': 'i16',
  'i32.store': 'i32', 'i64.store': 'i64', 'f32.store': 'f32', 'f64.store': 'f64',
}

// scalar op → SIMD op. shamtScalar:true means second operand stays scalar i32.
//
// For i8/i16 lanes the SCALAR ops are i32.* — wasm has no native i8/i16 ops,
// values flow as i32 and the trailing store{8,16} truncates. i{8,16}x{N}.add
// wraps within each lane the same way, so the observable result matches.
// Note: wasm SIMD has no i8x16.mul, so multiplication on byte arrays bails.
export const LANE_PURE = {
  // Right shifts intentionally omitted for narrow lanes: scalar emits
  // i32.shr_{s,u} on a load8/load16 i32 (zero- or sign-extended), while
  // i{8,16}x{N}.shr_{s,u} treats lanes as their narrow type. The two diverge
  // when load and shift signedness mismatch (e.g. load8_u + shr_s on byte
  // 0xFF: scalar=0x7F, SIMD=0xFF). Safe set excludes shr_*.
  i8: new Map([
    ['i32.add', { simd: 'i8x16.add' }],
    ['i32.sub', { simd: 'i8x16.sub' }],
    ['i32.and', { simd: 'v128.and' }],
    ['i32.or',  { simd: 'v128.or' }],
    ['i32.xor', { simd: 'v128.xor' }],
    ['i32.shl', { simd: 'i8x16.shl', shamtScalar: true }],
  ]),
  i16: new Map([
    ['i32.add', { simd: 'i16x8.add' }],
    ['i32.sub', { simd: 'i16x8.sub' }],
    ['i32.mul', { simd: 'i16x8.mul' }],
    ['i32.and', { simd: 'v128.and' }],
    ['i32.or',  { simd: 'v128.or' }],
    ['i32.xor', { simd: 'v128.xor' }],
    ['i32.shl', { simd: 'i16x8.shl', shamtScalar: true }],
  ]),
  i32: new Map([
    ['i32.add', { simd: 'i32x4.add' }],
    ['i32.sub', { simd: 'i32x4.sub' }],
    ['i32.mul', { simd: 'i32x4.mul' }],
    ['i32.and', { simd: 'v128.and' }],
    ['i32.or',  { simd: 'v128.or' }],
    ['i32.xor', { simd: 'v128.xor' }],
    ['i32.shl', { simd: 'i32x4.shl', shamtScalar: true }],
    ['i32.shr_s', { simd: 'i32x4.shr_s', shamtScalar: true }],
    ['i32.shr_u', { simd: 'i32x4.shr_u', shamtScalar: true }],
  ]),
  i64: new Map([
    ['i64.add', { simd: 'i64x2.add' }],
    ['i64.sub', { simd: 'i64x2.sub' }],
    ['i64.mul', { simd: 'i64x2.mul' }],
    ['i64.and', { simd: 'v128.and' }],
    ['i64.or',  { simd: 'v128.or' }],
    ['i64.xor', { simd: 'v128.xor' }],
    ['i64.shl', { simd: 'i64x2.shl', shamtScalar: true }],
    ['i64.shr_s', { simd: 'i64x2.shr_s', shamtScalar: true }],
    ['i64.shr_u', { simd: 'i64x2.shr_u', shamtScalar: true }],
  ]),
  f32: new Map([
    ['f32.add', { simd: 'f32x4.add' }],
    ['f32.sub', { simd: 'f32x4.sub' }],
    ['f32.mul', { simd: 'f32x4.mul' }],
    ['f32.div', { simd: 'f32x4.div' }],
    ['f32.min', { simd: 'f32x4.min' }],
    ['f32.max', { simd: 'f32x4.max' }],
    ['f32.neg', { simd: 'f32x4.neg' }],
    ['f32.abs', { simd: 'f32x4.abs' }],
    ['f32.sqrt', { simd: 'f32x4.sqrt' }],
    // rounding: each f32x4.* rounds lane-for-lane identically to the scalar f32.* (same
    // IEEE rounding mode), so the lift is bit-exact. Math.floor/ceil/trunc and the bare
    // f64.nearest jz emits all reach here in a Float32Array kernel.
    ['f32.floor', { simd: 'f32x4.floor' }],
    ['f32.ceil', { simd: 'f32x4.ceil' }],
    ['f32.trunc', { simd: 'f32x4.trunc' }],
    ['f32.nearest', { simd: 'f32x4.nearest' }],
  ]),
  f64: new Map([
    ['f64.add', { simd: 'f64x2.add' }],
    ['f64.sub', { simd: 'f64x2.sub' }],
    ['f64.mul', { simd: 'f64x2.mul' }],
    ['f64.div', { simd: 'f64x2.div' }],
    ['f64.min', { simd: 'f64x2.min' }],
    ['f64.max', { simd: 'f64x2.max' }],
    ['f64.neg', { simd: 'f64x2.neg' }],
    ['f64.abs', { simd: 'f64x2.abs' }],
    ['f64.sqrt', { simd: 'f64x2.sqrt' }],
    // rounding: f64x2.* rounds each lane identically to the scalar f64.* op (same IEEE
    // mode), so bit-exact. Unblocks `out[i] = Math.floor/ceil/trunc(f(in[i]))` f64 maps.
    ['f64.floor', { simd: 'f64x2.floor' }],
    ['f64.ceil', { simd: 'f64x2.ceil' }],
    ['f64.trunc', { simd: 'f64x2.trunc' }],
    ['f64.nearest', { simd: 'f64x2.nearest' }],
  ]),
}

// Integer-load → f32x4 widening, for `out[i] = intArr[i] (* k)` (Int16Array →
// Float32Array decode/normalize, the canonical audio/image map). jz emits the
// scalar as `f64.convert_i32_{s,u}(<intload>(addr))`; lift to: load `lanes` ints,
// widen to i32x4, then f32x4.convert. `steps` are applied innermost-first.
// `lossy`: i32→f32 rounds (the scalar converts via exact f64 then demotes — double
// rounding differs by ≤1 ulp), so it needs relaxedSimd; i8/i16 are exact in f32.
export const INT_WIDEN_F32 = {
  'i32.load':     { load: 'v128.load',        steps: [],                                                  cvt: 's', lossy: true },
  'i32.load16_s': { load: 'v128.load64_zero', steps: ['i32x4.extend_low_i16x8_s'],                        cvt: 's', lossy: false },
  'i32.load16_u': { load: 'v128.load64_zero', steps: ['i32x4.extend_low_i16x8_u'],                        cvt: 'u', lossy: false },
  'i32.load8_s':  { load: 'v128.load32_zero', steps: ['i16x8.extend_low_i8x16_s', 'i32x4.extend_low_i16x8_s'], cvt: 's', lossy: false },
  'i32.load8_u':  { load: 'v128.load32_zero', steps: ['i16x8.extend_low_i8x16_u', 'i32x4.extend_low_i16x8_u'], cvt: 'u', lossy: false },
}

// f64 scalar op → f32x4 SIMD op, for Float32Array arithmetic jz computes in f64
// (promote→f64 op→demote). Used only in f32-lane context under relaxedSimd, since
// the f64→f32 intermediate-precision drop is not bit-exact (see _relaxF32).
export const F64_TO_F32X4 = {
  'f64.add': 'f32x4.add', 'f64.sub': 'f32x4.sub', 'f64.mul': 'f32x4.mul', 'f64.div': 'f32x4.div',
  'f64.min': 'f32x4.min', 'f64.max': 'f32x4.max', 'f64.neg': 'f32x4.neg', 'f64.abs': 'f32x4.abs', 'f64.sqrt': 'f32x4.sqrt',
}

// Horizontal reductions: associative+commutative ops applied to one
// loop-carried accumulator. Each entry maps the SCALAR op (which is also
// the op used to combine the SIMD result back into the accumulator at the
// end) to its SIMD lane op, lane extractor, and identity element.
//
// Floats (add, mul) are not strictly associative — vectorized order produces
// ulp-level differences from scalar order. Acceptable for typical use
// (reductions over typed arrays of well-conditioned data); strict-equal
// callers must keep the pass off.
//
// Integer mul (`p *= a[i]`) IS associative+commutative mod 2³² / 2⁶⁴, so its
// vectorization is value-exact. Identity is 1 (the multiplicative neutral).
//
// Narrow lanes (i8/i16) intentionally absent: `s += a[i]` with a u8/u16
// load expands the value to i32 before the add, so the accumulator's lane
// type is always wider than the load's element type. That widening would
// require pairwise/extending-add ops (i16x8.extadd_pairwise_*) — separate
// recognizer. Integer min/max likewise: WASM has no scalar i32.min, so they
// arrive as a `select`, not a binary op — a separate recognizer branch.
const REDUCE_OPS = {
  i32: {
    'i32.add': { simd: 'i32x4.add', extract: 'i32x4.extract_lane', laneType: 'i32', constNode: ['i32.const', 0] },
    'i32.mul': { simd: 'i32x4.mul', extract: 'i32x4.extract_lane', laneType: 'i32', constNode: ['i32.const', 1] },
    'i32.xor': { simd: 'v128.xor',  extract: 'i32x4.extract_lane', laneType: 'i32', constNode: ['i32.const', 0] },
    'i32.and': { simd: 'v128.and',  extract: 'i32x4.extract_lane', laneType: 'i32', constNode: ['i32.const', -1] },
    'i32.or':  { simd: 'v128.or',   extract: 'i32x4.extract_lane', laneType: 'i32', constNode: ['i32.const', 0] },
  },
  i64: {
    'i64.add': { simd: 'i64x2.add', extract: 'i64x2.extract_lane', laneType: 'i64', constNode: ['i64.const', 0] },
    'i64.mul': { simd: 'i64x2.mul', extract: 'i64x2.extract_lane', laneType: 'i64', constNode: ['i64.const', 1] },
    'i64.xor': { simd: 'v128.xor',  extract: 'i64x2.extract_lane', laneType: 'i64', constNode: ['i64.const', 0] },
    'i64.and': { simd: 'v128.and',  extract: 'i64x2.extract_lane', laneType: 'i64', constNode: ['i64.const', -1] },
    'i64.or':  { simd: 'v128.or',   extract: 'i64x2.extract_lane', laneType: 'i64', constNode: ['i64.const', 0] },
  },
  f32: {
    'f32.add': { simd: 'f32x4.add', extract: 'f32x4.extract_lane', laneType: 'f32', constNode: ['f32.const', 0] },
    'f32.mul': { simd: 'f32x4.mul', extract: 'f32x4.extract_lane', laneType: 'f32', constNode: ['f32.const', 1] },
  },
  f64: {
    'f64.add': { simd: 'f64x2.add', extract: 'f64x2.extract_lane', laneType: 'f64', constNode: ['f64.const', 0] },
    'f64.mul': { simd: 'f64x2.mul', extract: 'f64x2.extract_lane', laneType: 'f64', constNode: ['f64.const', 1] },
  },
}

// Widening byte/short sums: an i32 accumulator fed by ONE bare narrow load
// (`s += u8[i]`). The lane data is i8/i16 but the accumulator is i32, so the
// plain lane-add path can't apply — instead each 16-byte vector collapses via
// extadd_pairwise into i32x4 partial sums. VALUE-EXACT mod 2³² (unlike float
// reductions): pairwise intermediates can't overflow (2×255 < 2¹⁶, 2×(−128)
// fits i16; the i16→i32 step extends before adding), and wrap-add is
// associative+commutative. Restricted to a BARE load: arithmetic on the
// narrow lanes before widening would wrap at lane width where the scalar
// code widens first.
export const WIDEN_LOADS = {
  'i32.load8_u':  { laneType: 'i8',  steps: ['i16x8.extadd_pairwise_i8x16_u', 'i32x4.extadd_pairwise_i16x8_u'] },
  'i32.load8_s':  { laneType: 'i8',  steps: ['i16x8.extadd_pairwise_i8x16_s', 'i32x4.extadd_pairwise_i16x8_s'] },
  'i32.load16_u': { laneType: 'i16', steps: ['i32x4.extadd_pairwise_i16x8_u'] },
  'i32.load16_s': { laneType: 'i16', steps: ['i32x4.extadd_pairwise_i16x8_s'] },
}

// Widening min/max over a BARE narrow load (`m = Math.max(m, u8[i])` with an
// i32 accumulator). Unlike the widening SUM there is no overflow concern:
// min/max at the load's own lane width over its own sign is value-exact, so
// the fold stays at lane width (16/8 lanes per vector) and only the final
// horizontal merge widens, via the sign-matched extract. Identity seeds the
// vector accumulator with the op's neutral: type-min for max, type-max for min.
export const MINMAX_WIDEN = {
  'i32.load8_u':  { pre: 'i8x16', sign: 'u', laneType: 'i8',  lo: 0,      hi: 255 },
  'i32.load8_s':  { pre: 'i8x16', sign: 's', laneType: 'i8',  lo: -128,   hi: 127 },
  'i32.load16_u': { pre: 'i16x8', sign: 'u', laneType: 'i16', lo: 0,      hi: 65535 },
  'i32.load16_s': { pre: 'i16x8', sign: 's', laneType: 'i16', lo: -32768, hi: 32767 },
}
// jz's number model converts narrow loads to f64 before Math.min/max, so the
// canon reduce arrives as (f64.max acc (f64.convert_i32_x LOAD)). The convert
// sign must match the load sign for the lane fold to be value-exact.
export const MINMAX_CVT = { 'f64.convert_i32_u': 'u', 'f64.convert_i32_s': 's' }

// op-name → REDUCE entry across all lane types (the op-name itself encodes
// the lane type prefix, e.g. `i32.add` ⇒ i32 lanes).
export const REDUCE_OP_LOOKUP = (() => {
  const m = new Map()
  for (const lt of Object.keys(REDUCE_OPS))
    for (const op of Object.keys(REDUCE_OPS[lt]))
      m.set(op, REDUCE_OPS[lt][op])
  return m
})()

// Min/max reductions (`m = Math.max(m, a[i])`). jz wraps every Math.min/max in
// a NaN-canonicalizing select, so these arrive as a TWO-statement body —
//   (local.set $cn (OP (local.get $acc) EXPR))
//   (local.set $acc (select C (local.get $cn) (OP-type.ne $cn $cn)))
// — handled separately from the bare single-statement reductions above.
//
// max/min ARE associative and commutative (exact reassociation, unlike add),
// so vectorization is value-exact, INCLUDING NaN: f64x2.max/min propagate a
// NaN lane just as scalar does, and we re-apply the canon to the merged result
// so the final NaN bit pattern is canonical even when N is a multiple of LANES
// (zero tail iterations). Identity is the op's annihilator-free neutral:
// -inf for max, +inf for min.
export const REDUCE_CANON = {
  'f64.max': { simd: 'f64x2.max', extract: 'f64x2.extract_lane', laneType: 'f64', identity: ['f64.const', '-inf'] },
  'f64.min': { simd: 'f64x2.min', extract: 'f64x2.extract_lane', laneType: 'f64', identity: ['f64.const', 'inf'] },
  'f32.max': { simd: 'f32x4.max', extract: 'f32x4.extract_lane', laneType: 'f32', identity: ['f32.const', '-inf'] },
  'f32.min': { simd: 'f32x4.min', extract: 'f32x4.extract_lane', laneType: 'f32', identity: ['f32.const', 'inf'] },
}

// Scalar comparison op → SIMD lane comparison, per lane type. Used to vectorize a
// conditional map `buf[i] = cond ? X : Y`, which jz lowers to `(if (result T) COND
// (then X)(else Y))`: COND becomes an all-ones/all-zeros lane mask fed to
// `v128.bitselect`. NaN behaves identically lane-wise — every ordered compare is
// false on a NaN operand in both scalar and SIMD, and `ne` is true — so no
// canonicalization is needed. i64x2 has no unsigned compares in baseline SIMD, so
// those simply aren't listed (the loop stays scalar).
export const LANE_COMPARE = {
  f64: { 'f64.eq': 'f64x2.eq', 'f64.ne': 'f64x2.ne', 'f64.lt': 'f64x2.lt', 'f64.gt': 'f64x2.gt', 'f64.le': 'f64x2.le', 'f64.ge': 'f64x2.ge' },
  f32: { 'f32.eq': 'f32x4.eq', 'f32.ne': 'f32x4.ne', 'f32.lt': 'f32x4.lt', 'f32.gt': 'f32x4.gt', 'f32.le': 'f32x4.le', 'f32.ge': 'f32x4.ge' },
  i32: { 'i32.eq': 'i32x4.eq', 'i32.ne': 'i32x4.ne', 'i32.lt_s': 'i32x4.lt_s', 'i32.lt_u': 'i32x4.lt_u', 'i32.gt_s': 'i32x4.gt_s', 'i32.gt_u': 'i32x4.gt_u', 'i32.le_s': 'i32x4.le_s', 'i32.le_u': 'i32x4.le_u', 'i32.ge_s': 'i32x4.ge_s', 'i32.ge_u': 'i32x4.ge_u' },
  i64: { 'i64.eq': 'i64x2.eq', 'i64.ne': 'i64x2.ne', 'i64.lt_s': 'i64x2.lt_s', 'i64.gt_s': 'i64x2.gt_s', 'i64.le_s': 'i64x2.le_s', 'i64.ge_s': 'i64x2.ge_s' },
  // i8/i16: like `LANE_PURE.i8`/`.i16` (this file, ~line 626), the SOURCE-LEVEL scalar compare
  // on a narrow element always arrives as an `i32.*` op (wasm has no native i8/i16 scalar
  // compare — the sign/zero-extended load already widened it to i32 before the compare runs).
  // `i8x16.*`/`i16x8.*` compare the STORED narrow lanes directly — for a SIGNED narrow load
  // (`i32.load8_s`/`16_s`, sign-extended) this is bit-for-bit the same per-lane boolean as the
  // scalar `i32.*_s` compare against a value that itself came from the same sign extension (the
  // extension is monotonic and injective, so signed narrow compare ≡ signed compare of the
  // extended value); for an UNSIGNED load (`_u`, zero-extended) the analogous `_u`/`eq`/`ne`
  // forms hold for the same reason. Masked/predicated stores on Uint8Array/Int16Array-etc.
  // element streams need a lane-width mask, not an i32x4 one, so byte/short if-conversion
  // depends on these entries existing — their absence is a missing-entry gap, not a
  // codegen limitation.
  i8: { 'i32.eq': 'i8x16.eq', 'i32.ne': 'i8x16.ne', 'i32.lt_s': 'i8x16.lt_s', 'i32.lt_u': 'i8x16.lt_u', 'i32.gt_s': 'i8x16.gt_s', 'i32.gt_u': 'i8x16.gt_u', 'i32.le_s': 'i8x16.le_s', 'i32.le_u': 'i8x16.le_u', 'i32.ge_s': 'i8x16.ge_s', 'i32.ge_u': 'i8x16.ge_u' },
  i16: { 'i32.eq': 'i16x8.eq', 'i32.ne': 'i16x8.ne', 'i32.lt_s': 'i16x8.lt_s', 'i32.lt_u': 'i16x8.lt_u', 'i32.gt_s': 'i16x8.gt_s', 'i32.gt_u': 'i16x8.gt_u', 'i32.le_s': 'i16x8.le_s', 'i32.le_u': 'i16x8.le_u', 'i32.ge_s': 'i16x8.ge_s', 'i32.ge_u': 'i16x8.ge_u' },
}

// ---- Recognizer ------------------------------------------------------------


// Math.sin/cos lower to `call $math.{sin,cos}_core` (the emit-time fast path, math.js:67); the
// public `$math.{sin,cos}` wrap the same core. Their f64x2 mirrors $math.sin2/$math.cos2 (the
// vectorized reduce+horner, module/math.js:543) are BIT-EXACT per lane to the scalar core — so we
// can lift the call straight to the *2 helper. Phase-2 adds pow/log/atan2 here (see PPC_CALL2).
// NOTE: scalar targets here must be kept out of watr's single-caller inlining — jz passes these
// keys (SIMD_PINNED, below) as watOptimize's `pin` list, else the call node is gone before this lift runs.
export const PPC_CALL2 = {
  '$math.sin_core': '$math.sin2', '$math.cos_core': '$math.cos2',
  '$math.sin': '$math.sin2', '$math.cos': '$math.cos2',
  '$math.pow': '$math.pow2',   // 2-arg; bit-exact per-lane scalar (cancellation-sensitive — see module/math.js)
  '$math.atan2': '$math.atan2_2', '$math.hypot': '$math.hypot_2',   // 2-arg; bit-exact extract/repack
  '$math.cbrt': '$math.cbrt_v', '$math.fifthroot': '$math.fifthroot_v',   // 1-arg; per-lane scalar repack
  '$math.pow_fold': '$math.pow_fold_v',   // 2-arg (x, c); only reachable under optimize.crPow — see module/math.js
  // log/exp/exp2: TRUE f64x2 polys — both lanes one evaluation (≈2×, beats V8 native log). Bit-exact
  // via hot-path-vectorized + scalar-edge-fallback ($math.log_v/exp_v/exp2_v, module/math.js).
  '$math.log': '$math.log_v', '$math.exp': '$math.exp_v', '$math.exp2': '$math.exp2_v',
}

// Transcendentals the auto-vectorizer bridges to f64x2 mirrors — BOTH the scalar sources (kept
// intact in the vectorized loop's scalar tail) AND the f64x2 mirrors themselves (the calls the
// SIMD path emits). jz passes this to watOptimize's `pin` option so watr's inliner dissolves
// NEITHER: the scalar tail keeps calling `$math.cbrt` and the SIMD body keeps calling
// `$math.cbrt_v` (inlining the small per-lane repack mirror would erase the vectorized call the
// lift produced). The protection policy lives here in jz, not hardcoded in watr.
export const SIMD_PINNED = [...new Set([...Object.keys(PPC_CALL2), ...Object.values(PPC_CALL2)])]
