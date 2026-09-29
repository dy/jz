// A module array of numbers that every function names only by constant index,
// storing each element before it reads it, is locals of each function
// (src/compile/plan/scratch.js, pass `moduleScratch`): a library returns two
// values through such an array it passes to a helper, and once the helper is
// part of its caller the array holds nothing a later call reads. An array with
// any other use (an element read before its store, a variable index, a call
// that reaches another user, a closure, an export) stays in memory. A caller
// nothing runs is no call site of the helper (plan/inline.js). Both forms answer
// what the host answers.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { compile } from '../index.js'
import { belowOpt, levels } from './_matrix.js'
import { oracle, run, wat } from './util.js'

// A helper that writes two results at a stride: over its second copy's budget, so two sites keep the call.
const ASSIGN = `const SMALLEST = 2.2250738585072014e-308, SCALE = 4503599627370496
const assign = (x, out, stride, offset) => {
  if (x !== x || x === Infinity || x === -Infinity) { out[offset] = x; out[offset + stride] = 0; return out }
  if (x !== 0 && (x < 0 ? -x : x) < SMALLEST) { out[offset] = x * SCALE; out[offset + stride] = -52; return out }
  if (x > 1e300) { out[offset] = x / SCALE; out[offset + stride] = 52; return out }
  if (x < -1e300) { out[offset] = x / SCALE; out[offset + stride] = 52; return out }
  out[offset] = x; out[offset + stride] = 0
  return out
}
`
const UNCALLED = 'const normalize = (x) => assign(x, [0, 0], 1, 0)\n'
const TWO = ASSIGN + 'const FRAC = [0, 0]\nexport let f = (frac, exp) => { assign(frac, FRAC, 1, 0); frac = FRAC[0]; exp += FRAC[1]; return frac * 8 + exp }'
// A callee no inliner dissolves (it calls itself), with `tail` run at its last level.
const DEEP = (name, tail) => `function ${name}(v, d) { if (d > 0) { return ${name}(v * 0.5 + d, d - 1) } ${tail} return v }\n`

const FLOATS = [1.5, -0, 3e-310, -2.5e-310, 1e301, -1e301, NaN, Infinity, 4503599627370497]
const rows = FLOATS.flatMap(x => [[x, 2], [x, -1]])
// operands of a bitwise operator: under 2^63, where the conversion is the host's (README, bitwise operands)
const words = [0, 1, -1, 255.75, -2147483648, 4294967295, 9007199254740991, NaN].flatMap(x => [[x, 0x7fffff80], [x, -3]])

const locals = {
  'two results a helper stores': [TWO, rows],
  'beside a caller nothing runs': [ASSIGN + UNCALLED + TWO.slice(ASSIGN.length), rows],
  'stores and reads in one function': ['const A = [0, 0, 0]\nexport let f = (x, y) => { A[0] = x + y; A[1] = x - y; A[2] = A[0] * A[1]; return A[2] + A[0] }', rows],
  'compound stores': ['const W = [0, 0]\nexport let f = (x, y) => { W[0] = x | 0; W[1] = y | 0; W[0] += 1; W[1] &= ~0x80; W[1] |= 0x100; W[0] <<= 2; W[1] ^= W[0]; W[0] >>>= 1; W[0] *= 3; return W[0] * 65536 + W[1] }', words],
  'an element stepped': ['const C = [0]\nexport let f = (x, y) => { C[0] = x | 0; C[0]++; ++C[0]; C[0]--; return C[0] + y }', words],
  'a store in each arm': ['const A = [0, 0]\nexport let f = (x, y) => { if (x > y) { A[0] = x; A[1] = y } else { A[0] = y; A[1] = x } return A[0] * 2 + A[1] }', rows],
  'two functions, one array': ['const A = [0, 0]\nexport let f = (x, y) => { A[0] = x; A[1] = y; return A[0] - A[1] }\nexport let g = (x) => { A[1] = x * 2; return A[1] + 1 }', rows],
  'an element the function never names': ['const A = [0, 0, 0, 0]\nexport let f = (x, y) => { A[3] = x * y; return A[3] + 1 }', rows],
  'a store in a loop, read in its pass': ['const A = [0, 0]\nexport let f = (x, y) => { let s = 0; for (let i = 0; i < 5; i++) { A[0] = x * i; A[1] = y + i; s += A[0] * A[1] } return s }', rows],
}

// jz and the host on a sequence of calls: [export, ...args] each, results compared in order.
const agreeCalls = (src, calls, label) => {
  const host = oracle(src)
  const want = calls.map(([f, ...args]) => host[f](...args))
  for (const optimize of levels(0, 2, 3)) {
    const m = run(src, { optimize })
    calls.forEach(([f, ...args], i) => is(m[f](...args), want[i], `${label} at ${optimize}: ${f}(${args.join(', ')}) #${i}`))
  }
}

test('module scratch: an array stored before it is read answers what the host answers', () => {
  for (const [name, [src, args]] of Object.entries(locals)) {
    const calls = args.map(a => ['f', ...a])
    if (/export let g\b/.test(src)) calls.push(['g', 4], ['f', 1, 2], ['g', -1])
    agreeCalls(src, calls, name)
  }
})

test('module scratch: the array leaves no binding, no store and no call', () => {
  if (belowOpt(2)) return
  for (const [name, [src]] of Object.entries(locals)) {
    const text = wat(src, { optimize: 3 })
    ok(!/\(global \$[AWCF]\w*\b/.test(text), `${name}: no binding left`)
    ok(!/\b[if](32|64)\.(load|store)/.test(text), `${name}: no load and no store`)
    ok(!/\(call \$/.test(text), `${name}: no call`)
  }
})

test('module scratch: a caller nothing runs changes no byte', () => {
  if (belowOpt(2)) return
  const [alone] = locals['two results a helper stores'], [beside] = locals['beside a caller nothing runs']
  for (const optimize of levels(2, 3)) is([...compile(beside, { optimize })], [...compile(alone, { optimize })], `at ${optimize}`)
})

// [source, the calls]
const memory = {
  'an element read before its store': ['const S = [0, 0]\nexport let put = (v) => { S[0] = v; return 1 }\nexport let get = () => S[0]',
    [['get'], ['put', 5], ['get'], ['put', -2.5], ['get']]],
  'a store one arm makes': ['const S = [0]\nexport let f = (x, c) => { if (c > 0) S[0] = x; return S[0] }',
    [['f', 1, 0], ['f', 2, 1], ['f', 3, 0], ['f', 4, 1], ['f', 5, 0]]],
  'a read a loop may skip the store of': ['const S = [7]\nexport let f = (x, n) => { for (let i = 0; i < n; i++) S[0] = x + i; return S[0] }',
    [['f', 1, 0], ['f', 2, 3], ['f', 9, 0]]],
  'a variable index': ['const S = [0, 0]\nexport let f = (x, i) => { S[0] = x; S[1] = -x; return S[i] }',
    [['f', 1, 0], ['f', 2, 1], ['f', 3, 0]]],
  'an index past the literal': ['const S = [0, 0]\nexport let f = (x) => { S[0] = x; S[2] = x * 2; return S[0] + S[2] + S.length }',
    [['f', 1], ['f', 2]]],
  'a call that stores between a store and its read': ['const S = [0]\n' + DEEP('deep', 'S[0] = v;') + 'export let f = (x) => { S[0] = x; const d = deep(x, 3); return S[0] * 100 + d }',
    [['f', 1], ['f', 8]]],
  'a call that reads what its caller stored': ['const S = [0]\n' + DEEP('deep', 'v += S[0];') + 'export let f = (x) => { S[0] = x; return deep(1, 2) }',
    [['f', 1], ['f', 8]]],
  'a closure that names it': ['const S = [0]\nexport let f = (x) => { S[0] = x; const g = () => S[0] * 2; S[0] = x + 1; return g() }',
    [['f', 1], ['f', 8]]],
  'the array as a value': ['const S = [0, 0]\nexport let f = (x) => { S[0] = x; S[1] = x * 2; const t = S; return t[0] + t[1] + t.length }',
    [['f', 1], ['f', 8]]],
  'the array returned': ['const S = [0, 0]\nconst fill = (x) => { S[0] = x; S[1] = x * 2; return S }\nexport let f = (x) => { const a = fill(x), b = fill(x + 1); return a[0] + b[1] }',
    [['f', 1], ['f', 8]]],
  'a statement of the module that names it': ['const S = [1, 2]\nS[1] = 5\nexport let f = (x) => { S[0] = x; return S[0] + S[1] }\nexport let g = () => S[1]',
    [['g'], ['f', 1], ['g']]],
  'a literal with a value that is no number': ['const S = [0, "a"]\nexport let f = (x) => { S[0] = x; return S[0] + S[1] }',
    [['f', 1], ['f', 8]]],
}

test('module scratch: an array with any other use stays, and answers the same', () => {
  for (const [name, [src, calls]] of Object.entries(memory)) agreeCalls(src, calls, name)
})

test('module scratch: the array left in memory answers the same', () => {
  for (const [name, [src, args]] of Object.entries(locals)) {
    const host = oracle(src)
    for (const level of levels(2, 3)) {
      const m = run(src, { optimize: { level, moduleScratch: false } })
      for (const a of args) is(m.f(...a), host.f(...a), `${name} at ${level}: f(${a.join(', ')})`)
    }
  }
})
