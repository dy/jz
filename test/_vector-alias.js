// The alias battery: loops `kern(d, s, n)` over two views of one buffer, which
// test/vector-alias-population.js runs against Node at every level and
// test/vector-coverage.js marks by the lift each takes at level 2 and 'speed'.
// `d` and `s` are made three ways (subarrays, constructors over the buffer, the same
// view twice), `off` and `n` given at run time.

export const TYPES = {
  f64: ['Float64Array', 'i * 37 % 23 - 11 + i % 4 * 0.25'],
  f32: ['Float32Array', 'i * 37 % 23 - 11 + i % 4 * 0.25'],
  i32: ['Int32Array', '(i * 40503 * 65537) | 0'],
  i16: ['Int16Array', 'i * 2053 % 65536 - 32768'],
  u8: ['Uint8Array', 'i * 37 % 251'],
}
// (d, s, n) each; every kernel returns a number
export const KERN = {
  copy: 'for (let i = 0; i < n; i++) d[i] = s[i]; return 0',
  map: 'for (let i = 0; i < n; i++) d[i] = s[i] * 2 + 1; return 0',
  acc2: 'for (let i = 0; i < n; i++) d[i] = d[i] + s[i]; return 0',
  next: 'for (let i = 0; i + 1 < n; i++) d[i] = s[i + 1] + s[i]; return 0',
  prev: 'for (let i = 1; i < n; i++) d[i] = s[i - 1] - s[i]; return 0',
  sten: 'for (let i = 1; i + 1 < n; i++) d[i] = s[i - 1] + s[i] * 2 + s[i + 1]; return 0',
  first: 'for (let i = 0; i < n; i++) d[i] = s[0] + i; return 0',
  lastEl: 'if (n > 0) for (let i = 0; i < n; i++) d[i] = s[n - 1] - i; return 0',
  scale0: 'for (let i = 0; i < n; i++) d[i] = s[i] * d[0]; return 0',
  prefix: 'let acc = 0; for (let i = 0; i < n; i++) { acc += s[i]; d[i] = acc } return acc',
  dot: 'let acc = 0; for (let i = 0; i < n; i++) acc += s[i] * d[i]; return acc',
  sum: 'let acc = 0; for (let i = 0; i < n; i++) acc += s[i]; return acc',
  two: 'for (let i = 0; i < n; i++) { d[i] = s[i] + 1; s[i] = d[i] * 2 } return 0',
  swap: 'for (let i = 0; i < n; i++) { const t = d[i]; d[i] = s[i]; s[i] = t } return 0',
  cond: 'for (let i = 0; i < n; i++) if (s[i] > 0) d[i] = s[i] * 2; return 0',
  tern: 'for (let i = 0; i < n; i++) d[i] = s[i] > 0 ? s[i] : -s[i]; return 0',
  last: 'let last = -1; for (let i = 0; i < n; i++) { last = s[i]; d[i] = last + 1 } return last',
  count: 'let i = 0; for (; i < n; i++) d[i] = s[i] + 3; return i',
  min: 'let m = Infinity; for (let i = 0; i < n; i++) m = Math.min(m, s[i]); return m',
  minIf: 'let m = 1e9; for (let i = 0; i < n; i++) if (s[i] < m) m = s[i]; return m',
  rev: 'for (let i = n - 1; i >= 0; i--) d[i] = s[i] + 1; return 0',
  step2: 'for (let i = 0; i < n; i += 2) d[i] = s[i] * 3; return 0',
  cursor: 'let o = 0; for (let i = 0; i < n; i++) { d[o] = s[i]; o += 1 } return o',
  sq: 'for (let i = 0; i < n; i++) d[i] = s[i] * s[i]; return 0',
  fill: 'for (let i = 0; i < n; i++) d[i] = 7; return 0',
  wrap: 'for (let i = 0; i < n; i++) d[i] = s[(i + 1) % n] + 1; return 0',
  tenth: 'for (let i = 0; i < n; i++) d[i] = s[i] * 0.1 + s[i]; return 0',
  third: 'for (let i = 0; i < n; i++) d[i] = s[i] / 3; return 0',
}
// how the two views of one buffer are made (BASE the first element of `d`)
export const VIEW = {
  sub: () => 'const d = buf.subarray(16, 16 + n), s = buf.subarray(16 + off, 16 + off + n)',
  ctor: (T) => `const d = new ${T}(buf.buffer, 16 * ${T}.BYTES_PER_ELEMENT, n), s = new ${T}(buf.buffer, (16 + off) * ${T}.BYTES_PER_ELEMENT, n)`,
  same: () => 'const d = buf.subarray(16, 16 + n), s = off === 0 ? d : buf.subarray(16 + off, 16 + off + n)',
}
// The program of one element type, seed, kernel and view: `f(off, n)` reads back the
// buffer, what the kernel returns and a first call on two distinct arrays.
export const program = (T, seed, kern, view) => `
const N = 64
const mk = () => { const b = new ${T}(N); for (let i = 0; i < N; i++) b[i] = ${seed}; return b }
const kern = (d, s, n) => { ${kern} }
const sum = (b) => { let h = 0; for (let i = 0; i < N; i++) h = (h * 31) % 1000003 + b[i] * (i + 1); return h }
export const f = (off, n) => {
  const w = mk(), x = mk()
  const r0 = kern(w.subarray(0, 4), x.subarray(8, 12), 4)
  const buf = mk()
  ${view(T)}
  const r = kern(d, s, n)
  return sum(buf) + r * 7 + sum(w) + r0
}`
