// Array slice views (src/compile/array-view.js): a slice read only as a spread
// source keeps its array and a range. Every kernel runs against the host, at
// every level and with the views off; the declines must keep the copy's
// snapshot semantics.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { onKernel, levels } from './_matrix.js'
import { oracle } from './util.js'

const OFF = { level: 'speed', arrayViews: false }
const check = (name, src, inputs) => {
  const native = oracle(src).run
  for (const optimize of [...levels(0, 2, 3, 'size'), 'speed', OFF]) {
    const wasm = jz(src, { optimize }).exports.run
    for (const n of inputs) is(wasm(n), native(n), `${name} ${JSON.stringify(optimize)}: run(${n})`)
  }
}

// subscript's statement-list join: the slice is spread by a push or by a new list
const JOIN = `const join = (a, b, items) => {
    items = b?.[0] === ';' ? b.slice(1) : [b]
    return a?.[0] === ';' ? (a.push(...items), a) : [';', a, ...items]
  }`

test('array views: a spread slice reads its array in place, at every level', () => {
  check('join', `${JOIN}
    export let run = (n) => { let r = 'z'
      for (let i = 0; i < n; i++) r = join('s' + i, r)
      const t = join([';', 'u'], ['q'])
      return r.length + '/' + r[1] + '/' + r[r.length - 1] + '/' + t.join(',') }`, [0, 1, 2, 3, 7, 40])
  // arguments: none, one, two, negative, out of range, empty, and a numeric name
  check('ranges', `export let run = (n) => { const a = [1, 2, 3, 4, 5, 6], out = []
    const k = n - 3
    const s0 = a.slice(); out.push([...s0].join(''))
    const s1 = a.slice(2); out.push([0, ...s1].join(''))
    const s2 = a.slice(1, 4); out.push([...s2, 9].join(''))
    const s3 = a.slice(-2); out.push([...s3].join(''))
    const s4 = a.slice(-9, 99); out.push([...s4].join(''))
    const s5 = a.slice(4, 2); out.push([7, ...s5, 8].join(''))
    const s6 = a.slice(k, k + 2); out.push([...s6].join(''))
    const j = n > 4 ? '2' : null
    const s7 = a.slice(j); out.push([...s7].join(''))
    const m = n > 4 ? Infinity : n > 2 ? -Infinity : NaN
    const s8 = a.slice(m); out.push([...s8].join(''))
    const s9 = a.slice(1, m); out.push([...s9].join(''))
    return out.join('|') }`, [0, 3, 5, 12])
  // strings, typed arrays and other values take the ordinary slice
  check('receivers', `const f = (v) => { const t = v.slice(1); return [0, ...t].length }
    export let run = (n) => f('abc' + n) + f(new Int8Array(n + 2)) + f([n, n, n]) + f('') + f([]) * 10 + f([n]) * 100`, [0, 4])
  // a nullish receiver throws where the slice would
  check('nullish', `const f = (v) => { try { const t = v.slice(1); return [0, ...t].length } catch (e) { return -1 } }
    export let run = (n) => f(n > 2 ? null : [1, 2]) + f(n > 1 ? undefined : 'ab') * 10`, [0, 2, 4])
  // two spreads on one path, a view in a loop, and a push onto the sliced array itself
  check('uses', `export let run = (n) => { const a = [1, 2, 3], out = []
    const t = a.slice(1); const w = [...t, 0, ...t]
    for (let i = 0; i < n; i++) { const u = w.slice(i); out.push(...u) }
    const s = a.slice(1); a.push(...s)
    return w.join('') + '/' + out.length + '/' + a.join('') }`, [0, 1, 3, 9])
})

test('array views: a mutation, a call or an accessor before the spread keeps the copy', () => {
  check('store', `export let run = (n) => { const a = [1, 2, 3]; const t = a.slice(1); a[1] = n; return [...t].join('') }`, [0, 7])
  check('call', `const bump = (a) => { a[2] = 9; return 1 }
    export let run = (n) => { const a = [1, 2, 3], k = n > 1 ? 1 : 0; const t = a.slice(k); const r = bump(a); return [r, ...t].join('') }`, [0, 3])
  check('in-statement call', `const bump = (a) => { a.length = 1; return 5 }
    export let run = (n) => { const a = [1, 2, 3]; const t = a.slice(1); return [bump(a), ...t].join('') + n }`, [0, 2])
  check('accessor', `export let run = (n) => { const a = [1, 2, 3]
    const o = { get g() { a[1] = n; return 4 } }
    const t = a.slice(1); const g = o.g; return [g, ...t].join('') }`, [0, 6])
  // a generator stores into the sliced array while a spread drains it (with an
  // iterator producer in the program, every spread runs the protocol)
  check('iterator', `function* g(a, n) { a[1] = n; yield 5 }
    export let run = (n) => { const a = [1, 2, 3]; const it = g(a, n); const t = a.slice(1); return [...it, ...t].join('') }`, [0, 8])
})

// A consumer that does not copy through a range reads the view as a fresh array.
const MATERIALIZED = {
  unshift: `export let run = (n) => { const a = [1, 2, 3], k = n > 0 ? 1 : 0; const t = a.slice(k); a.unshift(...t); return a.join('') }`,
  max: `export let run = (n) => { const a = [4, 1, 8], k = n > 0 ? 1 : 0; const t = a.slice(k); const m = Math.max(...t); return m }`,
}

test('array views: other consumers read a copy of the range', () => {
  for (const [name, src] of Object.entries(MATERIALIZED)) check(name, src, [0, 1, 2])
})

test('array views: the view skips the copy', () => {
  if (onKernel()) return
  const src = `${JOIN}
    export let run = (n) => { let r = 'z'; for (let i = 0; i < n; i++) r = join('s' + i, r); return r.length }`
  const on = compile(src, { optimize: 'speed', wat: true }), off = compile(src, { optimize: OFF, wat: true })
  ok(/\(local \$\S*avs\d+ i32\)/.test(on), 'the view keeps its start in a local')
  ok(!/avs\d+/.test(off), 'views off: no view locals')
  for (const [name, src] of Object.entries(MATERIALIZED))
    ok(/avs\d+/.test(compile(src, { optimize: 'speed', wat: true })), `${name}: the binding is a view`)
  // allocation volume of one run: the heap pointer after it, from a fresh instance each
  const heapAfter = (optimize) => {
    const { exports } = jz(src, { optimize })
    exports.run(200)
    return exports.__heap?.value ?? new Uint8Array(exports.memory.buffer).length
  }
  ok(heapAfter('speed') < heapAfter(OFF), 'the slices no longer allocate')
})
