// A typed array a function makes at a literal length and keeps to itself is
// static storage (compile/fixed-memory.js planStaticLocals): one block, zeroed
// where its declaration runs, its address a constant every access folds, read
// at that constant in the helpers every call hands it to. It stays a heap
// allocation where a second activation could reach it while it lives
// (recursion, a host import, a closure value, a callback, a suspension), or
// where it goes anywhere but element reads and writes, its length and
// parameters that do the same; and every program answers what the host answers.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { belowOpt, levels, onWasi } from './_matrix.js'
import { funcWat, oracle, run, wat } from './util.js'

const agree = (src, calls) => {
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const m = run(src, { optimize }), host = oracle(src)
    for (const [name, args] of calls) is(m[name](...args), host[name](...args), `O${optimize}: ${name}(${args})`)
  }
}
const fills = (text, name) => [...funcWat(text, name).matchAll(/\(memory\.fill\s+\(i32\.const (\d+)\)/g)].map(m => +m[1])
const SUM = `const sum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * (i + 1); return s }\n`

test('static locals: a table and a buffer handed to helpers are static blocks read at constant addresses', () => {
  const src = `const N = 64
    const build = (table) => { for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); table[n] = c | 0 } }
    function crc(buf, table) { let c = -1; for (let i = 0; i < N; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0 }
    function twice(buf, table) { return crc(buf, table) + crc(buf, table) }
    export let go = (seed) => {
      const buf = new Uint8Array(N)
      const table = new Int32Array(256)
      build(table)
      for (let i = 0; i < N; i++) buf[i] = (i * seed) & 255
      return twice(buf, table) + crc(buf, table)
    }`
  agree(src, [['go', [3]], ['go', [7]], ['go', [3]]])
  if (belowOpt(2)) return
  const text = wat(src, { optimize: 2 })
  ok(!funcWat(text, 'go').includes('__alloc'), 'the owner allocates no heap block')
  is(fills(text, 'go').length, 2, 'the owner zeroes its two blocks where it declares them')
  // the helper takes the addresses as its own: no read of what the caller passed
  const body = funcWat(text, 'crc').split('\n').filter(l => !/^\s*\((param|result|local) /.test(l)).join('\n')
  for (const p of ['buf', 'table']) {
    const at = body.search(new RegExp(`local\\.(set|tee) \\$${p}\\b`)), before = at < 0 ? body : body.slice(0, at)
    ok(!new RegExp(`local\\.get \\$${p}\\b`).test(before), `${p}: the helper reads the static address, not the argument`)
  }
})

test('static locals: a loop over static arrays at constant addresses is vectorized as one over parameters is', () => {
  // the address is a constant base the memarg fold moves into `offset=`; the
  // vectorizer reads it back as the base (vectorize/index.js constBaseForm)
  const src = `const N = 8192
    const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }
    const fill = (a, b) => { for (let i = 0; i < N; i++) { a[i] = (i % 13) - 6; b[i] = ((i * 7) % 11) - 5 } }
    const run = (a, b) => { let h = 0; for (let i = 0; i < 20; i++) h = (h * 31 + dot(a, b)) | 0; return h }
    export let go = () => { const a = new Float64Array(N), b = new Float64Array(N); fill(a, b); return run(a, b) + run(a, b) }`
  agree(src, [['go', []]])
  if (belowOpt(3)) return
  const text = wat(src, { optimize: 'speed' })
  ok(!text.includes('__alloc'), 'the arrays are static')
  ok(text.includes('f64x2.mul'), 'and the reduction over them is vectorized')
})

test('static locals: every declaration starts from zeros, two live arrays never share a block', () => {
  agree(`export let f = (k) => { const a = new Int32Array(4); a[k & 3] += 1; a[(k + 1) & 3] += 2; return a[0] + a[1] * 10 + a[2] * 100 + a[3] * 1000 }`,
    [0, 1, 2, 3, 0, 5].map(k => ['f', [k]]))
  agree(SUM + `export let f = (k) => { let s = 0; for (let j = 0; j < 3; j++) { const a = new Int32Array(4); a[(k + j) & 3] += j + 1; a[k & 3] += 1; s = s * 100 + sum(a) } return s }`,
    [0, 1, 5].map(k => ['f', [k]]))
  const two = SUM + `export let f = (k) => { const a = new Int32Array(4), b = new Int32Array(4); a[k & 3] = 1; b[(k + 1) & 3] = 2; return sum(a) * 100 + sum(b) }`
  agree(two, [0, 1, 2, 3].map(k => ['f', [k]]))
  if (belowOpt(2)) return
  const at = fills(wat(two, { optimize: 2 }), 'f')
  is(at.length, 2, 'both arrays are placed')
  ok(Math.abs(at[0] - at[1]) >= 16, 'at disjoint addresses')
})

test('static locals: a helper parameter reads a constant address only where every call passes one block', () => {
  agree(SUM + `export let f = (k) => { const a = new Int32Array(4); a[k & 3] = 5; return sum(a) }
    export let g = (k) => { const b = new Int32Array(8); b[k & 7] = 3; return sum(b) + sum(b) }`,
    [1, 2, 6].flatMap(k => [['f', [k]], ['g', [k]]]))
  // one helper, a placed array and a kept one
  agree(SUM + `const keep = []
    export let f = (k) => { const a = new Int32Array(4); a[k & 3] = 5; return sum(a) }
    export let g = (k) => { const b = new Int32Array(4); b[k & 3] = 3; keep.push(b); return sum(b) + keep.length }`,
    [1, 2, 6].flatMap(k => [['f', [k]], ['g', [k]]]))
})

test('static locals: an array a second activation could reach while it lives stays on the heap', () => {
  const cases = [
    // the owner reached again through the helper it hands the array to
    `const g = (a, d) => { a[1] += d; return d > 0 ? f(d - 1) : 0 }
      export let f = (d) => { const a = new Int32Array(2); a[0] = d; const r = g(a, d); return a[0] * 100 + a[1] * 10 + r }`,
    // through a closure value, a closure in a local handed to a builtin, a callback, a method, a constructor
    `const hooks = [(d) => d > 0 ? f(d - 1) : 0]
      export let f = (d) => { const a = new Int32Array(2); a[d & 1] = d + 1; const r = hooks[0](d); return a[0] + a[1] * 10 + r * 100 }`,
    `export let f = (d) => { const a = new Int32Array(2); const m = (x) => d > 0 ? f(d - 1) : x; a[d & 1] = d + 1; const r = Array.from([1], m); return a[0] + a[1] * 10 + r[0] * 100 }`,
    `export let f = (d) => { const a = new Int32Array(2); a[d & 1] = d + 1; const xs = [2, 1]; let r = 0; xs.sort((p, q) => { r = d > 0 ? f(d - 1) : 1; return p - q }); return a[0] + a[1] * 10 + r * 100 }`,
    `const o = { run(d) { return d > 0 ? f(d - 1) : 1 } }
      export let f = (d) => { const a = new Int32Array(2); a[d & 1] = d + 1; const r = o.run(d); return a[0] + a[1] * 10 + r * 100 }`,
    `class C { constructor(d) { this.v = d > 0 ? f(d - 1) : 1 } }
      export let f = (d) => { const a = new Int32Array(2); a[d & 1] = d + 1; const r = new C(d).v; return a[0] + a[1] * 10 + r * 100 }`,
    // a generator suspends with its array live; two run interleaved
    `function* gen(n) { const a = new Int32Array(4); for (let i = 0; i < n; i++) { a[i & 3] += i; yield a[0] + a[1] * 10 } }
      export let f = (n) => { const x = gen(n), y = gen(n); let s = 0; for (let i = 0; i < n; i++) { s = s * 7 + x.next().value; s = s * 7 + y.next().value } return s }`,
  ]
  for (const src of cases) agree(src, [0, 1, 2, 3].map(d => ['f', [d]]))
  if (onWasi()) return
  // a host import may call the owner back
  const src = `import { poke } from 'host'
    const put = (a, i, v) => { a[i & 1] = v }
    export let f = (d) => { const a = new Int32Array(2); put(a, d, d + 1); const r = poke(d); return a[0] + a[1] * 10 + r * 100 }`
  const host = d => { const a = new Int32Array(2); a[d & 1] = d + 1; const r = d > 0 ? host(d - 1) : 1; return a[0] + a[1] * 10 + r * 100 }
  for (const optimize of levels(0, 2, 3, 'size')) {
    let inst
    inst = jz(src, { optimize, imports: { host: { poke: d => d > 0 ? inst.exports.f(d - 1) : 1 } } })
    for (const d of [0, 1, 2, 3]) is(inst.exports.f(d), host(d), `O${optimize}: host re-entry f(${d})`)
  }
})

test('static locals: a kept, returned or captured array, or one past 64 KiB, stays a heap array', () => {
  const kept = `const keep = []
    let n = 0
    export let f = () => { const a = new Int32Array(2); a[0] = n++; keep.push(a); return keep.length }
    export let sum = () => { let s = 0; for (const a of keep) s = s * 10 + a[0]; return s }`
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const m = run(kept, { optimize }), host = oracle(kept)
    for (let i = 0; i < 3; i++) { m.f(); host.f() }
    is(m.sum(), host.sum(), `O${optimize}: kept arrays stay distinct`)
  }
  agree(`export let r = (k) => { const a = new Int32Array(3); a[k] = 5; return a[k] + a.length }
    export let c = (k) => { const a = new Int32Array(3); const get = () => a[k]; a[k] = 7; return get() }
    export let h = (k) => { const a = new Int32Array(3); a[0] = k; const fs = [(x) => x + a[0]]; return fs[0](1) }
    export let big = (k) => { const a = new Float64Array(10000); a[k] = k; let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s }`,
    [['r', [1]], ['c', [1]], ['h', [4]], ['big', [3]], ['big', [9999]], ['big', [3]]])
  for (const optimize of levels(0, 2, 'size')) {
    const { r } = jz(`export let r = (k) => { const a = new Int32Array(3); a[k] = 5; return a }`, { optimize }).exports
    const x = r(0), y = r(1)
    is([...x, ...y].join(), '5,0,0,0,5,0', `O${optimize}: each returned array its own`)
  }
})
