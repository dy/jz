// The kernel gate's corpus (scripts/kernel-gate.mjs): small and medium programs
// by family, each with the calls the compiled module must answer, and compiler
// subgraphs compiled as programs. `small` is every entry marked so; `medium`
// adds the rest. Expected values are authored by hand and checked against
// Node running the same source by test/kernel-gate.js.
import { resolve } from 'node:path'

const ROOT = resolve(new URL('..', import.meta.url).pathname)

export const PROGRAMS = [
  { name: 'numeric-loop', family: 'numeric', small: true,
    src: `export let main = () => { let s = 0; for (let i = 1; i <= 100; i++) s += i * i % 7; return s }
export let mandel = (cx, cy) => { let x = 0, y = 0, i = 0; while (i < 50 && x * x + y * y < 4) { const t = x * x - y * y + cx; y = 2 * x * y + cy; x = t; i++ } return i }`,
    calls: [['main', [], 201], ['mandel', [0, 0], 50], ['mandel', [1, 1], 2]] },
  { name: 'numeric-bits', family: 'numeric',
    src: `export let crc = (n) => { let c = 0xFFFFFFFF; for (let i = 0; i < n; i++) { c ^= i & 0xFF; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)) } return (c ^ 0xFFFFFFFF) >>> 0 }
export let pow2 = (k) => 2 ** k`,
    calls: [['crc', [0], 0], ['crc', [16], 3469664904], ['pow2', [10], 1024], ['pow2', [-2], 0.25]] },
  { name: 'closures-classes', family: 'closures/classes', small: true,
    src: `const mk = k => { let n = 0; return x => { n += x; return n * k } }
class Acc { constructor(s) { this.s = s } add(v) { this.s += v; return this } get() { return this.s } }
class Twice extends Acc { add(v) { return super.add(v * 2) } }
export let main = () => { const f = mk(3); f(1); f(2); return f(3) }
export let cls = (n) => new Twice(1).add(n).add(1).get()`,
    calls: [['main', [], 18], ['cls', [5], 13]] },
  { name: 'maps-properties', family: 'maps/properties', small: true,
    src: `export let main = () => { const m = new Map(); for (let i = 0; i < 20; i++) m.set('k' + (i % 7), i); let s = 0; for (const [k, v] of m) s += v * k.length; return s + m.size }
export let props = (k) => { const o = { a: 1, b: 2, c: 3 }; o.d = 4; let s = 0; for (const key in o) s += o[key]; return s + (k in o ? 100 : 0) }`,
    calls: [['main', [], 231], ['props', ['b'], 110], ['props', ['z'], 10]] },
  { name: 'typed-arrays', family: 'typed arrays', small: true,
    src: `export let main = (n) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = i * 0.5; let s = 0; for (let i = 0; i < n; i++) s += a[i] * a[i]; return s }
export let bytes = () => { const b = new Uint8Array(16); for (let i = 0; i < 16; i++) b[i] = i * 17; const v = new Int32Array(b.buffer); return v[1] + b[15] }`,
    calls: [['main', [8], 35], ['main', [0], 0], ['bytes', [], 2003195459]] },
  { name: 'strings-parser', family: 'strings/parser/encoder', small: true,
    src: `const tok = s => { const out = []; let i = 0; while (i < s.length) { const c = s[i]; if (c === ' ') { i++; continue } if (c >= '0' && c <= '9') { let j = i; while (j < s.length && s[j] >= '0' && s[j] <= '9') j++; out.push(s.slice(i, j)); i = j } else { out.push(c); i++ } } return out }
export let main = (s) => tok(s).join('|')
export let enc = (n) => { let r = ''; for (let i = 0; i < n; i++) r += String.fromCharCode(97 + (i * 7) % 26); return r.toUpperCase() + r.length }`,
    calls: [['main', ['12 + 345*6'], '12|+|345|*|6'], ['enc', [5], 'AHOVC5']] },
  { name: 'encoder-json', family: 'strings/parser/encoder',
    src: `export let main = (n) => { const o = { n, xs: [1, 2, n], s: 'q"t' }; const t = JSON.stringify(o); const back = JSON.parse(t); return t.length + back.xs[2] }
export let hex = (v) => { let s = ''; for (let i = 7; i >= 0; i--) s += '0123456789abcdef'[(v >>> (i * 4)) & 15]; return s }`,
    calls: [['main', [7], 38], ['hex', [3735928559], 'deadbeef']] },
]

// Compiler subgraphs: an entry of jz's own source compiled through the kernel
// as a program (the graph resolved natively, its modules handed over). No
// expected values beyond validity, bytes and parity with the native compile.
export const SUBGRAPHS = [
  { name: 'src/ir/tape.js', family: 'compiler subgraph', small: true, entry: resolve(ROOT, 'src/ir/tape.js') },
  { name: 'src/abi/number.js', family: 'compiler subgraph', entry: resolve(ROOT, 'src/abi/number.js') },
  { name: 'src/abi/array.js', family: 'compiler subgraph', entry: resolve(ROOT, 'src/abi/array.js') },
]

export const corpus = (size = 'medium') => ({
  programs: PROGRAMS.filter(p => size === 'medium' || p.small),
  subgraphs: SUBGRAPHS.filter(p => size === 'medium' || p.small),
})
