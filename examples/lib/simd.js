// SIMD polyfill — installs ambient `f32x4` / `i32x4` / `v128` globals so a kernel
// written with jz's SIMD intrinsics also runs under plain V8 (jz compiles the same
// bare `f32x4.add(…)` to native wasm SIMD; here it's scalar-emulated, 4 lanes per
// call). The intrinsics are AMBIENT (like Math) — a SIMD kernel never imports them;
// jz provides them natively, and a JS host installs this polyfill once.
//
// A lane vector is a plain 4-element array. f32x4 ops round to f32 (Math.fround) to
// mirror wasm lane precision; i32x4 ops are int32; masks from a compare are -1 (all
// ones) / 0 per lane, so `v128.and` / `v128.bitselect` are lane-wise selects — exactly
// the masked-lockstep idiom these kernels use.
const fr = Math.fround
const f1 = (op) => (a) => [fr(op(a[0])), fr(op(a[1])), fr(op(a[2])), fr(op(a[3]))]
const f2 = (op) => (a, b) => [fr(op(a[0], b[0])), fr(op(a[1], b[1])), fr(op(a[2], b[2])), fr(op(a[3], b[3]))]
const cmp = (op) => (a, b) => [op(a[0], b[0]) ? -1 : 0, op(a[1], b[1]) ? -1 : 0, op(a[2], b[2]) ? -1 : 0, op(a[3], b[3]) ? -1 : 0]

export const f32x4 = {
  splat: (x) => { x = fr(x); return [x, x, x, x] },
  lanes: (a, b, c, d) => [fr(a), fr(b), fr(c), fr(d)],
  add: f2((x, y) => x + y), sub: f2((x, y) => x - y), mul: f2((x, y) => x * y), div: f2((x, y) => x / y),
  min: f2((x, y) => Math.min(x, y)), max: f2((x, y) => Math.max(x, y)),
  sqrt: f1(Math.sqrt), abs: f1(Math.abs), neg: f1((x) => -x),
  floor: f1(Math.floor), ceil: f1(Math.ceil), trunc: f1(Math.trunc), nearest: f1(Math.round),
  eq: cmp((x, y) => x === y), ne: cmp((x, y) => x !== y),
  lt: cmp((x, y) => x < y), le: cmp((x, y) => x <= y), gt: cmp((x, y) => x > y), ge: cmp((x, y) => x >= y),
  lane: (v, k) => v[k],
}
export const i32x4 = {
  splat: (n) => { n |= 0; return [n, n, n, n] },
  add: (a, b) => [(a[0] + b[0]) | 0, (a[1] + b[1]) | 0, (a[2] + b[2]) | 0, (a[3] + b[3]) | 0],
  sub: (a, b) => [(a[0] - b[0]) | 0, (a[1] - b[1]) | 0, (a[2] - b[2]) | 0, (a[3] - b[3]) | 0],
  mul: (a, b) => [Math.imul(a[0], b[0]), Math.imul(a[1], b[1]), Math.imul(a[2], b[2]), Math.imul(a[3], b[3])],
  eq: cmp((x, y) => x === y), ne: cmp((x, y) => x !== y),
  lt: cmp((x, y) => x < y), le: cmp((x, y) => x <= y), gt: cmp((x, y) => x > y), ge: cmp((x, y) => x >= y),
  lane: (v, k) => v[k] | 0,
}
export const v128 = {
  and: (a, b) => [a[0] & b[0], a[1] & b[1], a[2] & b[2], a[3] & b[3]],
  or: (a, b) => [a[0] | b[0], a[1] | b[1], a[2] | b[2], a[3] | b[3]],
  xor: (a, b) => [a[0] ^ b[0], a[1] ^ b[1], a[2] ^ b[2], a[3] ^ b[3]],
  not: (a) => [~a[0], ~a[1], ~a[2], ~a[3]],
  // mask lane (-1/0) selects t else f — matches wasm bitselect on compare masks
  bitselect: (t, f, m) => [m[0] ? t[0] : f[0], m[1] ? t[1] : f[1], m[2] ? t[2] : f[2], m[3] ? t[3] : f[3]],
  anyTrue: (a) => (a[0] || a[1] || a[2] || a[3]) ? 1 : 0,
  allTrue: (a) => (a[0] && a[1] && a[2] && a[3]) ? 1 : 0,
}

/** Install the SIMD intrinsics as ambient globals (idempotent). Call once before a
 *  SIMD kernel runs under a JS host that lacks native intrinsics. */
export function installSimd(g = globalThis) {
  if (!g.f32x4) { g.f32x4 = f32x4; g.i32x4 = i32x4; g.v128 = v128 }
}
