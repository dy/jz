// A static typed array only constant indices reach is registers
// (src/optimize/static-scratch.js): a load after the stores that wrote its bytes
// is their values' bits, of whatever widths and types, and a store nothing reads
// goes. A view of a static array's whole buffer is a constant address
// (module/typedarray.js, src/wat/assemble/start-fn.js). An array with any other
// use (an argument, a return, an export, a variable index, a view made in a
// function) stays in memory, and both answer what the host answers.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, levels, onWasi } from './_matrix.js'
import { funcWat, oracle, run, wat } from './util.js'

const V = 'const F = new Float64Array(1)\nconst U = new Uint32Array(F.buffer)\n'
const FLOATS = [1.5, -0, 3.141592653589793, 1e308, -2.5e-310, NaN, -Infinity, 4503599627370497]
const WORDS = [0, 1, 0x3ff00000, 0x80000000, 0xffffffff, 0x7ff80000]
const pairs = (xs, ys) => xs.flatMap(x => ys.map(y => [x, y]))
// A callee no inliner dissolves (it calls itself), with `tail` run at its last level.
const DEEP = (name, tail) => `function ${name}(v, d) { if (d > 0) { return ${name}(v * 0.5 + d, d - 1) } ${tail} return v }\n`

const registers = {
  'the words of a float': [V + 'export let f = (x) => { F[0] = x; return U[1] * 4294967296 + U[0] }', FLOATS.map(x => [x])],
  'a float with its low word set': [V + 'export let f = (x, w) => { F[0] = x; U[0] = w >>> 0; return F[0] }', pairs(FLOATS, WORDS)],
  'a float with its high word set': [V + 'export let f = (x, w) => { F[0] = x; U[1] = w >>> 0; return F[0] }', pairs(FLOATS, WORDS)],
  'a float from two words': [V + 'export let f = (h, l) => { U[1] = h >>> 0; U[0] = l >>> 0; return F[0] }', pairs(WORDS, WORDS)],
  'the words through helpers and named indices': [V + 'const HIGH = 1, LOW = 0\nfunction hi(x) { F[0] = x; return U[HIGH] }\nfunction lo(x) { F[0] = x; return U[LOW] }\nfunction join(h, l) { U[HIGH] = h; U[LOW] = l; return F[0] }\n'
    + 'export let f = (x) => join((hi(x) & 0xfffff) | 0x3ff00000, lo(x)) + hi(x * 2)', FLOATS.map(x => [x])],
  'the bytes of a float': [V + 'const B = new Uint8Array(F.buffer)\nexport let f = (x) => { F[0] = x; return B[7] * 65536 + B[6] * 256 + B[0] + B[3] }', FLOATS.map(x => [x])],
  'signed pieces of a float': [V + 'const I = new Int16Array(F.buffer), C = new Int8Array(F.buffer), W = new Int32Array(F.buffer)\nexport let f = (x) => { F[0] = x; return I[3] * 7 + C[7] * 3 + I[0] + W[1] }', FLOATS.map(x => [x])],
  'a word from bytes': [V + 'const B = new Uint8Array(F.buffer)\nexport let f = (a, b) => { B[0] = a; B[1] = b; B[2] = a + b; B[3] = 300; U[1] = 7; return U[0] + F[0] }', pairs([0, 1, 255, 256, -1], [2, 128, 511])],
  'a single float and its word': ['const S = new Float32Array(1), W = new Uint32Array(S.buffer)\nexport let f = (x, w) => { S[0] = x; const bits = W[0]; W[0] = w >>> 0; return bits + S[0] }', pairs(FLOATS, WORDS)],
  'a store to another array between the reads': [V + 'const out = new Float64Array(2)\nexport let f = (x) => { F[0] = x; out[0] = U[1]; out[1] = U[0]; return out[0] * 3 + out[1] }', FLOATS.map(x => [x])],
  'a plain array between the reads': [V + 'const out = [0, 0]\nexport let f = (x) => { F[0] = x; out[0] = U[1]; out[1] = U[0]; return out[0] * 3 + out[1] }', FLOATS.map(x => [x])],
  'words in a loop': [V + 'export let f = (x, n) => { let acc = 0; for (let i = 0; i < n; i++) { F[0] = x * i; acc += (U[1] ^ U[0]) >>> 0; U[0] = i; acc += F[0] } return acc }', FLOATS.map(x => [x, 9])],
  'a call that leaves the arrays alone': [V + DEEP('deep', '') + 'export let f = (x) => { F[0] = x; const s = deep(x, 3); return U[1] + s }', FLOATS.map(x => [x])],
}

// jz and the host on every row of every program, one compile per program and level.
const agreeAll = (programs) => {
  for (const [name, [src, rows]] of Object.entries(programs)) {
    const host = oracle(src)
    for (const optimize of levels(0, 2, 3)) {
      const m = run(src, { optimize })
      for (const args of rows) is(m.f(...args), host.f(...args), `${name} at ${optimize}: f(${args.join(', ')})`)
    }
  }
}

test('static scratch: a word read after its stores is their bits', () => agreeAll(registers))

test('static scratch: an array nothing else reaches leaves no access', () => {
  if (belowOpt(2)) return
  for (const [name, [src]] of Object.entries(registers)) {
    if (name.includes('between the reads')) continue
    const text = wat(src, { optimize: 3 })
    for (const fn of ['f', 'deep']) ok(!/\b[if](32|64)\.(load|store)/.test(funcWat(text, fn)), `${name}: no load and no store in ${fn}`)
    ok(!/\(global \$[FUSBWIC]\b/.test(text), `${name}: no binding left`)
  }
})

const memory = {
  'a store one arm makes': [V + 'export let f = (x, c) => { F[0] = x; if (c > 0) { U[1] = 0 } return F[0] + U[1] }', pairs(FLOATS, [0, 1])],
  'a store both arms make': [V + 'export let f = (x, c) => { F[0] = x; if (c > 0) { U[1] = 5 } else { U[1] = 9 } U[0] = 1; return F[0] }', pairs(FLOATS, [0, 1])],
  'a read a loop carries': [V + 'export let f = (x, n) => { let acc = 0; F[0] = x; for (let i = 0; i < n; i++) { acc += U[1]; U[1] = i } return acc + F[0] }', FLOATS.map(x => [x, 5])],
  'a read after a loop\'s stores': [V + 'export let f = (x, n) => { F[0] = x; for (let i = 0; i < n; i++) { if (i === 3) break; U[0] = i } return F[0] }', FLOATS.map(x => [x, 6])],
  'a loop that may not run': [V + 'export let f = (x, n) => { F[0] = x; for (let i = 0; i < n; i++) { F[0] = i + 0.5 } return F[0] + U[1] }', pairs(FLOATS, [0, 1, 4])],
  'a loop left after a store': [V + 'export let f = (x, n) => { F[0] = x; for (let i = 0; i < n; i++) { F[0] = i; if (i === 3) { F[0] = -1; break } F[0] = i * 2 } return F[0] + U[1] }', pairs(FLOATS, [0, 2, 6])],
  'a helper left early': [V + 'const pick = (x, c) => { F[0] = x; if (c > 0) return 1; U[1] = 0; return 2 }\nexport let f = (x, c) => pick(x, c) + F[0] + U[1]', pairs(FLOATS, [0, 1])],
  'a block left early': [V + 'export let f = (x, c) => { F[0] = x; out: { if (c > 0) break out; U[1] = 0 } return F[0] + U[1] }', pairs(FLOATS, [0, 1])],
  'a call that stores to the array': [V + DEEP('deep', 'F[0] = v;') + 'export let f = (x) => { F[0] = x; const s = deep(x, 3); return U[1] + U[0] + s }', FLOATS.map(x => [x])],
  'a call to a caller of one that stores': [V + DEEP('deep', 'F[0] = v;') + DEEP('outer', 'v = deep(v, 2);') + 'export let f = (x) => { F[0] = x; const s = outer(x, 2); return U[1] + U[0] + s }', FLOATS.map(x => [x])],
  'a call through a value': [V + 'const put = (v) => { F[0] = v; return 1 }\nconst keep = (v) => v\nexport let f = (x, c) => { const g = c > 0 ? put : keep; F[0] = x; g(2.5); return U[1] }', pairs(FLOATS, [0, 1])],
  'a view passed to a function': [V + DEEP('deep', '') + 'function poke(u, v) { u[1] = deep(v, 2) }\nexport let f = (x) => { F[0] = x; poke(U, x); return F[0] }', FLOATS.map(x => [x])],
  'an array a function returns': [V + 'const get = (c) => c > 0 ? F : null\nexport let f = (x, c) => { F[0] = x; const a = get(c); if (a) { a[0] = 1.5 } return U[1] }', pairs(FLOATS, [0, 1])],
  'a variable index': [V + 'export let f = (x, i) => { F[0] = x; U[i & 1] = 3; return F[0] + U[(i + 1) & 1] }', pairs(FLOATS, [0, 1])],
  'an index past the array': [V + 'export let f = (x) => { F[0] = x; U[2] = 7; const v = U[2]; return (v === undefined ? 1 : 0) + U[1] }', FLOATS.map(x => [x])],
  'a view made in the function': [V + 'export let f = (x) => { const b = new Uint8Array(F.buffer); F[0] = x; b[7] = 64; return F[0] + U[0] }', FLOATS.map(x => [x])],
  'a view of a part': [V + 'const T = new Uint16Array(F.buffer, 6, 1)\nexport let f = (x) => { F[0] = x; T[0] = 0x4000; return F[0] + U[1] }', FLOATS.map(x => [x])],
  'a second name of the array': [V + 'const G = F\nexport let f = (x) => { F[0] = x; G[0] = G[0] * 2; return U[1] + F[0] }', FLOATS.map(x => [x])],
  'an array reassigned': ['let F = new Float64Array(1)\nconst U = new Uint32Array(F.buffer)\nexport let f = (x) => { F[0] = x; const w = U[1]; F = new Float64Array(1); F[0] = 1; return w + U[1] }', FLOATS.map(x => [x])],
}

test('static scratch: a path that joins, a call that stores, an array with another use', () => agreeAll(memory))

test('static scratch: a view of a static array\'s whole buffer is declared with the array\'s address', () => {
  // An index that is not constant keeps both in memory, where their globals show.
  const src = V + 'export let f = (x, i) => { F[0] = x; return U[i & 1] }'
  for (const optimize of levels(0)) {
    const text = wat(src, { optimize })
    const at = (name) => new RegExp(`\\(global \\$${name} i32\\s*\\(i32\\.const (\\d+)\\)`).exec(text)?.[1]
    ok(at('F') != null, `the array's address is a constant at ${optimize}`)
    is(at('U'), at('F'), `the view has the array's address at ${optimize}`)
  }
  // The optimizer folds a constant global into the code that reads it.
  for (const optimize of levels(0, 2, 3)) {
    const text = wat(src, { optimize })
    ok(!/global\.set \$[FU]\b/.test(text) && !/\(global \$[FU] \(mut/.test(text), `no assignment at start at ${optimize}`)
    ok(!/\(func \$__start/.test(text), `no start function at ${optimize}`)
  }
})

test('static scratch: a store a later call reads stays', () => {
  if (onWasi()) return
  const src = V + 'export let put = (x) => { F[0] = x }\nexport let high = () => U[1]\nexport let low = () => U[0]\nexport let swap = () => { const h = U[1]; U[1] = U[0]; U[0] = h; return F[0] }'
  const host = oracle(src)
  for (const optimize of levels(0, 2, 3)) {
    const m = run(src, { optimize })
    for (const x of FLOATS) {
      m.put(x); host.put(x)
      is(m.high(), host.high(), `high word of ${x} at ${optimize}`)
      is(m.low(), host.low(), `low word of ${x} at ${optimize}`)
      is(m.swap(), host.swap(), `words of ${x} swapped at ${optimize}`)
      is(m.high(), host.high(), `high word after the swap of ${x} at ${optimize}`)
    }
  }
})

test('static scratch: an exported array keeps its stores', () => {
  if (onWasi()) return
  const src = 'export const F = new Float64Array(2)\nconst U = new Uint32Array(F.buffer)\nexport let f = (x) => { F[0] = x; F[1] = U[1]; return U[0] }'
  for (const optimize of levels(0, 2, 3)) {
    const m = run(src, { optimize }), host = oracle(src)
    for (const x of FLOATS) {
      is(m.f(x), host.f(x), `low word of ${x} at ${optimize}`)
      // The export is the array's address; the host reads the elements there.
      const F = new Float64Array(m.memory.buffer, m.F.value, 2)
      is(F[0], host.F[0], `the array's first element after f(${x}) at ${optimize}`)
      is(F[1], host.F[1], `the array's second element after f(${x}) at ${optimize}`)
    }
  }
})
