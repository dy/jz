// SIMD polyfill — installs ambient `f32x4` / `i32x4` / `v128` globals so a kernel
// written with jz's SIMD intrinsics also runs under plain V8 (jz compiles the same
// bare `f32x4.add(…)` to native wasm SIMD; here it's scalar-emulated, 4 lanes per
// call). The intrinsics are AMBIENT (like Math) — a SIMD kernel never imports them;
// jz provides them natively, and a JS host installs this polyfill once.
//
// A lane vector is a 16-byte buffer viewed as Float32Array(4) for f32x4 ops and
// Int32Array(4) for i32x4 / bitwise ops — so the f32↔i32 bit reinterpret that wasm
// gives for free (it's all one v128) works here too, and ops are bit-accurate.
const buf = () => new ArrayBuffer(16);
const F = (b) => new Float32Array(b);
const I = (b) => new Int32Array(b);
const mkF = (a, b, c, d) => { const o = buf(), f = F(o); f[0] = a; f[1] = b; f[2] = c; f[3] = d; return o; };
const mkI = (a, b, c, d) => { const o = buf(), i = I(o); i[0] = a; i[1] = b; i[2] = c; i[3] = d; return o; };
const f1 = (op) => (a) => { const x = F(a), o = buf(), r = F(o); r[0] = op(x[0]); r[1] = op(x[1]); r[2] = op(x[2]); r[3] = op(x[3]); return o; };
const f2 = (op) => (a, b) => { const x = F(a), y = F(b), o = buf(), r = F(o); r[0] = op(x[0], y[0]); r[1] = op(x[1], y[1]); r[2] = op(x[2], y[2]); r[3] = op(x[3], y[3]); return o; };
const fcmp = (op) => (a, b) => { const x = F(a), y = F(b), o = buf(), r = I(o); r[0] = op(x[0], y[0]) ? -1 : 0; r[1] = op(x[1], y[1]) ? -1 : 0; r[2] = op(x[2], y[2]) ? -1 : 0; r[3] = op(x[3], y[3]) ? -1 : 0; return o; };
const i2 = (op) => (a, b) => { const x = I(a), y = I(b), o = buf(), r = I(o); r[0] = op(x[0], y[0]) | 0; r[1] = op(x[1], y[1]) | 0; r[2] = op(x[2], y[2]) | 0; r[3] = op(x[3], y[3]) | 0; return o; };
const icmp = (op) => (a, b) => { const x = I(a), y = I(b), o = buf(), r = I(o); r[0] = op(x[0], y[0]) ? -1 : 0; r[1] = op(x[1], y[1]) ? -1 : 0; r[2] = op(x[2], y[2]) ? -1 : 0; r[3] = op(x[3], y[3]) ? -1 : 0; return o; };
const ishift = (op) => (a, n) => { const x = I(a), o = buf(), r = I(o); r[0] = op(x[0], n); r[1] = op(x[1], n); r[2] = op(x[2], n); r[3] = op(x[3], n); return o; };

export const f32x4 = {
  splat: (x) => mkF(x, x, x, x),
  lanes: (a, b, c, d) => mkF(a, b, c, d),
  add: f2((x, y) => x + y), sub: f2((x, y) => x - y), mul: f2((x, y) => x * y), div: f2((x, y) => x / y),
  min: f2((x, y) => Math.min(x, y)), max: f2((x, y) => Math.max(x, y)),
  sqrt: f1(Math.sqrt), abs: f1(Math.abs), neg: f1((x) => -x),
  floor: f1(Math.floor), ceil: f1(Math.ceil), trunc: f1(Math.trunc), nearest: f1(Math.round),
  eq: fcmp((x, y) => x === y), ne: fcmp((x, y) => x !== y),
  lt: fcmp((x, y) => x < y), le: fcmp((x, y) => x <= y), gt: fcmp((x, y) => x > y), ge: fcmp((x, y) => x >= y),
  convertI32: (a) => { const x = I(a); return mkF(x[0], x[1], x[2], x[3]); },   // i32 lane → f32 value
  lane: (v, k) => F(v)[k],
};
export const i32x4 = {
  splat: (n) => mkI(n, n, n, n),
  add: i2((x, y) => x + y), sub: i2((x, y) => x - y), mul: (a, b) => { const x = I(a), y = I(b); return mkI(Math.imul(x[0], y[0]), Math.imul(x[1], y[1]), Math.imul(x[2], y[2]), Math.imul(x[3], y[3])); },
  eq: icmp((x, y) => x === y), ne: icmp((x, y) => x !== y),
  lt: icmp((x, y) => x < y), le: icmp((x, y) => x <= y), gt: icmp((x, y) => x > y), ge: icmp((x, y) => x >= y),
  shl: ishift((x, n) => x << n), shr: ishift((x, n) => x >> n), shrU: ishift((x, n) => x >>> n),
  lane: (v, k) => I(v)[k],
};
export const v128 = {
  and: i2((x, y) => x & y), or: i2((x, y) => x | y), xor: i2((x, y) => x ^ y),
  not: (a) => { const x = I(a); return mkI(~x[0], ~x[1], ~x[2], ~x[3]); },
  // bitwise select: (t & m) | (f & ~m) — exact wasm semantics (works for any mask, not just -1/0)
  bitselect: (t, f, m) => { const xt = I(t), xf = I(f), xm = I(m); return mkI((xt[0] & xm[0]) | (xf[0] & ~xm[0]), (xt[1] & xm[1]) | (xf[1] & ~xm[1]), (xt[2] & xm[2]) | (xf[2] & ~xm[2]), (xt[3] & xm[3]) | (xf[3] & ~xm[3])); },
  anyTrue: (a) => { const x = I(a); return (x[0] || x[1] || x[2] || x[3]) ? 1 : 0; },
  allTrue: (a) => { const x = I(a); return (x[0] && x[1] && x[2] && x[3]) ? 1 : 0; },
};

/** Install the SIMD intrinsics as ambient globals (idempotent). Call once before a
 *  SIMD kernel runs under a JS host that lacks native intrinsics. */
export function installSimd(g = globalThis) {
  if (!g.f32x4) { g.f32x4 = f32x4; g.i32x4 = i32x4; g.v128 = v128; }
}
