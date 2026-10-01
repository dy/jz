// Iteration protocol edges — for-of over nullish THROWS (ES: "x is not
// iterable"), it does not silently iterate zero times. The silent form masked
// two real self-compile miscompiles (a strictSentinel-folded undefined guard and
// a never-armed matchAll both fed undefined into for-of and vanished) before
// they were caught. Known-vt receivers pay nothing — the guard lives only in
// __iter_arr's unknown-receiver arm (module/collection.js).
import test, { is } from 'tst'
import { throws } from 'tst/assert.js'
import jz from '../index.js'
import { run, oracle } from './util.js'
import { levels } from './_matrix.js'

test('for-of reads the live array length through direct and helper mutations', () => {
  const src = `
    export function grow(n) {
      const a = n ? [1] : []
      function append(x) { a.push(x) }
      const out = []
      for (const x of a) {
        out.push(x)
        if (x < n) append(x + 1)
      }
      return out
    }
    export function shrink(n) {
      const a = [1, 2, 3, 4], alias = a, out = []
      function resize() { alias.length = n }
      for (const x of a) {
        out.push(x)
        if (x === 1) resize()
      }
      return out
    }
    export function direct() {
      const a = [1], out = []
      for (const x of a) {
        if (x < 3) { a.push(x + 1); continue }
        out.push(x)
        break
      }
      return out
    }
    export function planned() {
      const nodes = [['~', ['~', 0]]], seen = new WeakSet()
      function plan(node) { nodes.push(node) }
      let n = 0
      for (const node of nodes) {
        if (Array.isArray(node[1])) plan(node[1])
        seen.add(node)
        n++
      }
      return [n, seen.has(nodes[1])]
    }
  `
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const actual = run(src, { optimize }), expected = oracle(src)
    for (const n of [0, 1, 1, 4, 2, 0, 4]) {
      is(actual.grow(n), expected.grow(n), `append ${n}, O${optimize}`)
      is(actual.shrink(n), expected.shrink(n), `shrink ${n}, O${optimize}`)
    }
    is(actual.direct(), expected.direct(), `continue and break, O${optimize}`)
    is(actual.planned(), expected.planned(), `newly planned nodes, O${optimize}`)
  }
})

test('for-of captures its source once while observing holes and later element writes', () => {
  const src = `
    export function f(mode) {
      let source = [1, 2], calls = 0
      const original = source, out = []
      function read() { calls++; return source }
      for (const x of read()) {
        out.push(x)
        if (out.length === 1) {
          source = [9]
          if (mode === 1) original[2] = 3
          if (mode === 2) { original.length = 4; original[3] = 4 }
          if (mode === 3) { original[1] = 5; original.length = 1 }
        }
      }
      return [calls, out, source, original]
    }
  `
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const actual = run(src, { optimize }), expected = oracle(src)
    for (const mode of [0, 0, 1, 2, 3, 0])
      is(actual.f(mode), expected.f(mode), `source capture ${mode}, O${optimize}`)
  }
})

test('for-of over nullish throws (catchable), iterables unaffected', async () => {
  const SRC = `
  export const probe = (which) => {
    const src = which > 0 ? [1, 2, 3] : which < 0 ? null : undefined
    let n = 0
    try { for (const x of src) n += x } catch (e) { return 'threw' }
    return 'sum:' + n
  }
  export const spreadable = () => {
    const s = new Set([1, 2])
    let n = 0
    for (const x of s) n += x
    return n
  }`
  for (const optimize of levels(false, 2)) {
    const m = await run(SRC, { memory: 256, optimize })
    is(m.probe(1), 'sum:6', `optimize:${optimize} array iterates`)
    is(m.probe(0), 'threw', `optimize:${optimize} undefined throws`)
    is(m.probe(-1), 'threw', `optimize:${optimize} null throws`)
    is(m.spreadable(), 3, `optimize:${optimize} Set iterates`)
  }
})

test('Set/Map constructors: nullish iterable is an EMPTY collection, for-of still throws', () => {
  // ES: the CONSTRUCTOR skips iteration for undefined/null (new Set(undefined)
  // is empty — GetIterator never runs), while for-of/spread over nullish is a
  // TypeError. The ctor path used to route through the for-of normalizer and
  // threw — natively masked (host JS semantics), self-compiled it broke the
  // compiler's own `new Set(maybeUndefined)` (the census-row class).
  const { f } = run(`export let f = (use) => {
    const base = use ? new Set(['x']) : undefined
    const s = new Set(base)
    const m = new Map(use ? undefined : null)
    return (s.has('x') ? 1 : 0) + m.size * 10
  }`).exports ?? run(`export let f = (use) => {
    const base = use ? new Set(['x']) : undefined
    const s = new Set(base)
    const m = new Map(use ? undefined : null)
    return (s.has('x') ? 1 : 0) + m.size * 10
  }`)
  is(Number(f(1)), 1)
  is(Number(f(0)), 0)
})

test('for-of over an iterable of unknown kind resolves it at runtime (a host typed array, a Set, a Map)', async () => {
  // The summary knows a for-of's iterable only when the program built it: a host
  // encoder's bytes are of no kind it names, so the loop dispatches on the value
  // (the self-hosted compiler read its custom-section bytes as f64s once).
  const SRC = `
  const utf8 = new TextEncoder()
  export const bytes = (s) => { const out = []; for (const x of utf8.encode(s)) out.push(x); return out[0] * 1000 + out[1] }
  export const colls = () => { const out = []; for (const x of new Set([3, 4])) out.push(x); for (const [k, v] of new Map([[1, 2]])) out.push(k * 10 + v); return out[0] * 1000 + out[1] * 100 + out[2] }`
  for (const optimize of levels(false, 2)) {
    const m = await run(SRC, { optimize })
    is(m.bytes('ab'), 97098, `optimize:${optimize} the encoder's bytes iterate as bytes`)
    is(m.colls(), 3412, `optimize:${optimize} a Set and a Map iterate as arrays`)
  }
})


test('iteration rejects noniterables through spread, calls, loops and collection constructors', () => {
  const src = `function args(...xs) { return xs }
    export function f(which, mode) {
      const sources = [3, -0, NaN, Infinity, false, true, 17n, 0x7ff8000100000000n,
        {}, {length: 1, 0: 3}, () => 1, new Date(0), new ArrayBuffer(0), new ArrayBuffer(8),
        new DataView(new ArrayBuffer(8)), null, undefined, [], [1, 2], 'a𝄞', new Int16Array([3, 4])];
      const x = sources[which];
      try {
        if (mode === 0) return [...x];
        if (mode === 1) return [1].concat(...x);
        if (mode === 2) return args(...x);
        if (mode === 3) { let n = 0; for (const v of x) n++; return n }
        return new Set(x).size;
      } catch (e) { return [e.name, e instanceof TypeError] }
    }`
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const got = jz(src, { optimize }).exports, want = oracle(src), retained = []
    for (const which of [17, 17, ...Array.from({length: 17}, (_, i) => i), 18, 19, 20, 17, 3, 18])
      for (let mode = 0; mode < 5; mode++) {
        const actual = got.f(which, mode), expected = want.f(which, mode)
        is(actual, expected, `O${optimize}: source ${which}, operation ${mode}`)
        if (which >= 17 && mode < 3) retained.push([actual, expected])
      }
    for (const [actual, expected] of retained) is(actual, expected, 'subsequent throws preserve retained results')
  }
})

test('iteration rejects statically known noniterables and decodes host TypeErrors', () => {
  const values = ['3', 'false', '17n', '0x7ff8000100000000n', '{}', '{length: 1, 0: 3}',
    'new Date(0)', 'new ArrayBuffer(0)', 'new DataView(new ArrayBuffer(0))']
  for (const optimize of levels(0, 1, 2, 3, 'size')) for (const value of values) {
    const src = `export function f() { return [...(${value})] }
      export function valid() { return [...[1, 2]] }`
    const got = jz(src, { optimize }).exports, want = oracle(src)
    for (let i = 0; i < 2; i++) {
      throws(() => got.f(), TypeError, `O${optimize}: ${value}`)
      throws(() => want.f(), TypeError)
      is(got.valid(), want.valid(), 'same instance recovers after failed iteration')
    }
  }
})

test('iteration retains indexed, collection and custom protocol sources', () => {
  const src = `export function f(n) {
      const custom = { [Symbol.iterator]() { let i = 0; return { next() { return i < n ? {value: ++i, done: false} : {done: true} } } } };
      const out = []; for (const v of custom) out.push(v);
      return [out, [...custom], [0].concat(...custom), [...new Set([1, 2])], [...new Map([[1, 2]])],
        [...new BigInt64Array([3n])], [...new Uint8Array([4])], [...new Set(new Int16Array([3, 3, 4]))],
        [...new Set(new BigInt64Array([3n, 3n, 4n]))], [...'a𝄞'], [...[, undefined]],
        Array.from({length: 2, 0: 7}), Array.from(3),
        Object.groupBy(new BigInt64Array([3n, 4n]), x => typeof x).bigint,
        Map.groupBy(new BigInt64Array([3n, 4n]), x => typeof x).get('bigint')]
    }`
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const got = jz(src, { optimize }).exports, want = oracle(src)
    for (const n of [0, 0, 1, 3, 0, 2]) is(got.f(n), want.f(n), `O${optimize}: valid iterator ${n}`)
  }
})
