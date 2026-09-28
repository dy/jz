// A typed element read inside the array's count is a number, never undefined
// (src/summary `typedReadPresent`): the index's span within a length the walk
// knows (an allocation of one bounded length, a name of one definition, a
// helper's every return), a mask inside it, or a counter the loop bounds by
// the array's own length. A callee taking such a read takes a number, so its
// parameter needs no per-use conversion. A read the walk cannot place inside
// the count stays number-or-undefined, and the callee sees the undefined.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { compile } from '../index.js'
import { ctx } from '../src/ctx.js'
import { K, hasTag, tagOf } from '../src/summary/kind.js'
import { belowOpt, levels } from './_matrix.js'
import { agree, funcWat, wat } from './util.js'

// The kind the callee's parameter is bound to, as the summary holds it: 'number' or 'number|undefined'.
const paramKind = (src, fn = 'g', param = 'v') => {
  compile(src, { optimize: 0 })
  const f = ctx.funcs.map.get(fn)
  const spelled = JSON.stringify([f.sig.params.map(p => p.name), f.body]).match(new RegExp('"' + param + '[^"A-Za-z0-9_$][^"]*"'))?.[0]
  const k = ctx.summary.at(f.sig).paramKindOf(spelled ? JSON.parse(spelled) : param)
  return tagOf(k) === K.NUMBER ? (hasTag(k, K.ABSENT) ? 'number|undefined' : 'number') : String(tagOf(k))
}
// A callee too large to inline, with an early return that reads the parameter by identity.
const G = 'function g(v) { if (v === undefined) { return -1 } let s = 1; ' + Array.from({ length: 40 }, (_, k) => `s = s * v + ${(k + 1) * 0.37}; if (s > 1e300) { s = ${k} }`).join(' ') + ' return v * 2 + s }\n'
const MK = 'const mk = (n) => { const o = new Float64Array(n); for (let i = 0; i < n; i++) o[i] = i * 0.5; return o }\n'
const conversions = (src) => (funcWat(wat(src, { optimize: 3 }), 'g') || '').match(/__to_num/g)?.length ?? 0

test('typed presence: a read inside a known count binds a number', () => {
  const present = {
    'a counter under the count': G + 'const N = 64\nexport let run = () => { const x = new Float64Array(N), out = new Float64Array(N); for (let i = 0; i < N; i++) x[i] = i * 0.5; for (let i = 0; i < N; i++) out[i] = g(x[i]); return out[3] }',
    'a mask inside the count': G + 'const N = 64\nexport let run = () => { const x = new Float64Array(N), out = new Float64Array(N); for (let i = 0; i < N; i++) x[i] = i * 0.5; for (let i = 0; i < 2 * N; i++) out[i & (N - 1)] = g(x[i & (N - 1)]); return out[3] }',
    'a counter the array\'s length bounds': G + 'const N = 64\nexport let run = () => { const x = new Float64Array(N), out = new Float64Array(N); for (let i = 0; i < N; i++) x[i] = i * 0.5; for (let i = 0; i < x.length; i++) out[i] = g(x[i]); return out[3] }',
    'a helper\'s array, a mask': G + 'const N = 64\n' + MK + 'export let run = () => { const x = mk(N), out = new Float64Array(N); for (let i = 0; i < 2 * N; i++) out[i & (N - 1)] = g(x[i & (N - 1)]); return out[3] }',
    'a helper\'s array, its length bounds': G + 'const N = 64\n' + MK + 'export let run = () => { const x = mk(N), out = new Float64Array(N); for (let i = 0; i < x.length; i++) out[i] = g(x[i]); return out[3] }',
    'a helper\'s array of an unknown length, its length bounds': G + MK + 'export let run = (n) => { const x = mk(n), out = new Float64Array(x.length); for (let i = 0; i < x.length; i++) out[i] = g(x[i]); return out[3] }',
    'a parameter\'s array, its length bounds': G + 'function sweep(x, out) { for (let i = 0; i < x.length; i++) out[i] = g(x[i]); return out[3] }\nconst N = 64\n' + MK + 'export let run = () => sweep(mk(N), new Float64Array(N))',
    'a closure\'s loop over a helper\'s array': G + 'const N = 64\n' + MK + 'export let run = () => { const x = mk(N), out = new Float64Array(N); const sweep = () => { for (let i = 0; i < 2 * N; i++) out[i & (N - 1)] = g(x[i & (N - 1)]) }; sweep(); return out[3] }',
    'a module array, a shifted count': G + 'const N = 1 << 6\nconst x = new Float64Array(N), out = new Float64Array(N)\nfor (let i = 0; i < N; i++) x[i] = i * 0.5\nexport let run = () => { for (let i = 0; i < x.length; i++) out[i] = g(x[i]); return out[3] }',
  }
  for (const [name, src] of Object.entries(present)) {
    is(paramKind(src), 'number', name)
    for (const optimize of levels(0, 2, 3)) agree(src, 'run', name.includes('unknown') ? [64] : [], { optimize }, `${name} at ${optimize}`)
    if (!belowOpt(3)) is(conversions(src), 0, `${name}: the callee converts nothing`)
  }
})

test('typed presence: a read the walk cannot place inside the count stays number-or-undefined', () => {
  const absent = {
    'a counter past the count': G + 'const N = 64\nexport let run = () => { const x = new Float64Array(N), out = new Float64Array(N + 1); for (let i = 0; i <= N; i++) out[i] = g(x[i]); return out[N] }',
    'a counter past the array\'s length': G + 'const N = 64\nexport let run = () => { const x = new Float64Array(N), out = new Float64Array(N + 1); for (let i = 0; i <= x.length; i++) out[i] = g(x[i]); return out[N] }',
    'a neighbour under the length bound': G + 'const N = 64\nexport let run = () => { const x = new Float64Array(N), out = new Float64Array(N); for (let i = 0; i < x.length; i++) out[i] = g(x[i + 1]); return out[N - 1] }',
    'a mask wider than the count': G + 'const N = 64\nexport let run = () => { const x = new Float64Array(N), out = new Float64Array(2 * N); for (let i = 0; i < 2 * N; i++) out[i] = g(x[i & (2 * N - 1)]); return out[N] }',
    'a helper of two counts': G + 'const mk = (n) => n > 0 ? new Float64Array(64) : new Float64Array(32)\nexport let run = (n) => { const x = mk(n), out = new Float64Array(64); for (let i = 0; i < 64; i++) out[i] = g(x[i]); return out[40] }',
    'an array rebound in the loop': G + 'const N = 64\nexport let run = () => { let x = new Float64Array(N); const out = new Float64Array(N); for (let i = 0; i < x.length; i++) { out[i] = g(x[i]); x = new Float64Array(N / 2) } return out[N - 1] }',
    'a count from an unknown length': G + 'export let run = (n) => { const x = new Float64Array(n), out = new Float64Array(64); for (let i = 0; i < 64; i++) out[i] = g(x[i]); return out[40] }',
  }
  for (const [name, src] of Object.entries(absent)) {
    is(paramKind(src), 'number|undefined', name)
    for (const optimize of levels(0, 2, 3)) agree(src, 'run', name.includes('helper of two') ? [0] : name.includes('unknown') ? [32] : [], { optimize }, `${name} at ${optimize}`)
  }
})

// stdlib's word helpers: `F64[0] = x; hi = U32[HIGH]`, the two views over one
// buffer, the index a module constant behind a decided test, an alias and a
// field of a literal nothing stores to. The view's count is the buffer's bytes
// over its element size; the read is inside it, so the emitter loads the word
// with no bounds test and the value is never the undefined of a miss.
const VIEWS = 'var F = new Float64Array(1)\nvar U = new Uint32Array(F.buffer)\n'
const WORD = 'function hw(x) { F[0] = x; return U[HIGH2] }\nexport let f = (x) => hw(x) + hw(x * 2)'
const loadsUnchecked = (src) => { const body = funcWat(wat(src, { optimize: 3 }), 'hw') || funcWat(wat(src, { optimize: 3 }), 'f$exp') || funcWat(wat(src, { optimize: 3 }), 'f') || ''; return /i32\.load/.test(body) && !/i32\.lt_u|nan:0x7FF8000200000000/.test(body) }

test('typed presence: a word of a float through a view of its buffer', () => {
  const present = {
    'an index a decided test assigns': `var le = true\nvar HIGH\nif (le === true) { HIGH = 1 } else { HIGH = 0 }\nvar HIGH2 = HIGH\n` + VIEWS + WORD,
    'an index read from a held literal\'s field': `var le = true\nvar indices\nvar HIGH\nvar LOW\nif (le === true) { HIGH = 1; LOW = 0 } else { HIGH = 0; LOW = 1 }\nindices = { "HIGH": HIGH, "LOW": LOW }\nvar idx = indices\nvar HIGH2 = idx.HIGH\n` + VIEWS + WORD,
    'a literal index': `var HIGH2 = 1\n` + VIEWS + WORD,
    'a view of another element size': `var HIGH2 = 7\nvar F = new Float64Array(1)\nvar U = new Uint8Array(F.buffer)\n` + WORD,
  }
  for (const [name, src] of Object.entries(present)) {
    for (const optimize of levels(0, 2, 3)) agree(src, 'f', [1.5], { optimize }, `${name} at ${optimize}`)
    is(paramKind(src.replace('export let f = (x) => hw(x) + hw(x * 2)', G + 'export let f = (x) => g(hw(x)) + g(hw(x * 2))')), 'number', `${name}: the word is a number`)
    if (!belowOpt(3)) ok(loadsUnchecked(src), `${name}: the word loads with no bounds test`)
  }
  const absent = {
    'an index past the view\'s count': `var HIGH2 = 2\n` + VIEWS + WORD,
    'an index a runtime test assigns': `var le = Math.random() < 2\nvar HIGH2\nif (le === true) { HIGH2 = 1 } else { HIGH2 = 5 }\n` + VIEWS + WORD,
    'a literal something stores to': `var indices = { HIGH: 1 }\nexport let set = (v) => { indices.HIGH = v }\nvar HIGH2 = indices.HIGH\n` + VIEWS + WORD,
    'a literal handed on': `var indices = { HIGH: 1 }\nfunction keep(o) { o.HIGH = 9; return o }\nvar kept = keep(indices)\nvar HIGH2 = indices.HIGH\n` + VIEWS + WORD,
    'a view of a buffer of a runtime size': `var HIGH2 = 1\nvar n = (Math.random() < 2 ? 1 : 0)\nvar F = new Float64Array(n)\nvar U = new Uint32Array(F.buffer)\n` + WORD.replace('F[0] = x', 'F[0] = x'),
  }
  for (const [name, src] of Object.entries(absent)) {
    for (const optimize of levels(0, 2, 3)) agree(src, 'f', [1.5], { optimize }, `${name} at ${optimize}`)
    ok(paramKind(src.replace('export let f = (x) => hw(x) + hw(x * 2)', G + 'export let f = (x) => g(hw(x)) + g(hw(x * 2))')) !== 'number', `${name}: the word is not proven a number`)
  }
})
