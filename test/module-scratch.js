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
import { belowOpt, levels } from './_matrix.js'
import { oracle, run, wat, compile, funcWat } from './util.js'

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

// A function that names the array calls a user of it, itself included (a library's
// `pow` takes the words of x and y through its module's array and calls itself for
// `-Infinity`): a read before the call, or after a store after it, holds the value
// its own call stored. [source, the calls]
const calling = {
  'a recursion that reads before it calls': [DEEP('deep', '') + 'const W = [0, 0]\nfunction pw(x, y) { W[0] = x * 2; W[1] = y - 1; if (W[1] > 3) return pw(W[0] * 0.5, W[1] - 1); return W[0] + W[1] }\nexport let f = (x, y) => pw(x, y) + deep(x, 2)',
    rows.map(a => ['f', ...a]).concat([['f', 1, 9], ['f', -3, 12]])],
  'a store after a call that writes it': ['const W = [0]\nfunction deep(v, d) { W[0] = v; if (d > 0) return deep(W[0] * 0.5 + d, d - 1); return W[0] }\nexport let f = (x) => { W[0] = x; const r = deep(W[0], 3); W[0] = r + 1; return W[0] * 2 }',
    [['f', 1], ['f', 8], ['f', -0], ['f', NaN]]],
  'a store in each arm after the call': ['const W = [0, 0]\nfunction deep(v, d) { W[1] = v; if (d > 0) return deep(W[1] + d, d - 1); return W[1] }\nexport let f = (x, c) => { W[0] = x; const r = deep(W[0], 2); if (c > 0) W[0] = r; else W[0] = -r; return W[0] }',
    [['f', 1, 0], ['f', 2, 1], ['f', -5, 1]]],
}
// [source, the calls]: a read past such a call with no store after it reads what the callee stored
const calledOver = {
  'a read after a recursion without a store': ['const S = [0]\nfunction rec(v, d) { S[0] = v; if (d > 0) { rec(v + 1, d - 1) } return S[0] }\nexport let f = (x) => rec(x, 3)',
    [['f', 1], ['f', 8], ['f', -2]]],
  'a store in one arm after the call': ['const S = [0]\nfunction deep(v, d) { S[0] = v; if (d > 0) return deep(S[0] + d, d - 1); return S[0] }\nexport let f = (x, c) => { S[0] = x; deep(S[0], 2); if (c > 0) S[0] = 7; return S[0] }',
    [['f', 1, 0], ['f', 2, 1], ['f', -5, 0]]],
}

test('module scratch: a call that writes the array between, the stores after it are what a read holds', () => {
  for (const [name, [src, calls]] of Object.entries({ ...calling, ...calledOver })) agreeCalls(src, calls, name)
  if (belowOpt(2)) return
  for (const [name, [src]] of Object.entries(calling)) {
    const text = wat(src, { optimize: 3 })
    ok(!/\(global \$[WS]\b/.test(text), `${name}: no binding left`)
    // (the program's own functions: a value the host passes may be a string, whose runtime loads)
    for (const fn of ['f', 'pw', 'deep']) ok(!/\bf64\.(load|store)/.test(funcWat(text, fn)), `${name}: no load and no store in ${fn}`)
  }
  // (in memory: a store of the element a callee reads back, whether a global or static data holds the array)
  for (const [name, [src]] of Object.entries(calledOver)) {
    const text = wat(src, { optimize: 3 })
    ok(['rec', 'deep'].some(fn => /\bf64\.store/.test(funcWat(text, fn))), `${name}: the array stays`)
  }
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

// The words of a number a library returns through the array (`toWords( x, WORDS )`, twice in one
// call): every read of an element follows its store, so the element's local is declared with no
// `undefined` (compile/emit/dispatch.js), and its writes, words, are what types it. The words then
// stay in integer registers: no word goes through a Number to be truncated back.
const WORDS = `const F = new Float64Array(1), U = new Uint32Array(F.buffer)
const W = [0, 0]
const toWords = (x) => { F[0] = x; W[0] = U[1]; W[1] = U[0] }
export let f = (xs, ys) => {
  let s = 0
  for (let i = 0; i < xs.length; i++) {
    toWords(xs[i])
    const hx = W[0], lx = W[1]
    toWords(ys[i])
    const hy = W[0], ly = W[1]
    s = (s + ((hx ^ hy) >>> 20) + (lx === ly ? 1 : 0) + (hx >>> 31)) | 0
  }
  return s
}
export let g = (x) => { toWords(x); return W[0] * 4294967296 + W[1] }
`
test('module scratch: the words a helper returns through the array stay words', () => {
  const xs = new Float64Array([0, -0, 1, -1.5, 3e-310, -3e-310, 1e300, -1e300, Infinity, -Infinity, NaN, 4503599627370497, 0.1])
  const ys = xs.slice().reverse()
  const host = oracle(WORDS)
  for (const optimize of levels(false, 2, 3, 'speed', 'size')) {
    const m = run(WORDS, { optimize })
    is(m.f(xs, ys), host.f(xs, ys), `the words at ${optimize}`)
    for (const x of xs) is(m.g(x), host.g(x), `g(${x}) at ${optimize}`)
  }
  if (belowOpt(2)) return
  for (const optimize of [2, 'speed']) {
    const text = funcWat(wat(WORDS, { optimize }), 'f')
    ok(!/f64\.convert_i32_u|0x4338000000000000|6755399441055744/.test(text), `at ${optimize}: no word goes through a Number`)
  }
})
