// Frame effects (src/compile/analyze/frame-effects.js) and the arena rewind
// they gate (src/optimize/arena-rewind.js). A rewind restores the heap
// pointer at return; it is sound only when no allocation made during the
// call outlives the frame. An escape lowers the escape flag, where it runs,
// to the address it wrote into, and a frame restores when the flag stands at
// or above its own mark: what was written into is the frame's own, and goes
// with it. The census finds the escapes in the source, the tape pass the rest
// in the emitted body, and `whyNotRewind` names why a candidate keeps its
// heap: on every call (`escape: …`), or on a call that runs an escape
// (`kept on a call that runs an escape: …`, the first the frame may reach).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { resetTape, fromWat, toWat } from '../src/ir/tape.js'
import { arenaRewind } from '../src/optimize/arena-rewind.js'
import { listedBuiltin } from '../src/compile/analyze/frame-effects.js'
import { includeAllMods } from '../src/autoload.js'
import { ctx } from '../src/ctx.js'
import { levels, onKernel, belowOpt } from './_matrix.js'
import { oracle } from './util.js'

const TAPE = { optimize: { watr: false } }   // the pass's own output, before watr folds dead allocations away
const bodyOf = (wat, name) => { const i = wat.indexOf(`(func $${name}\n`); if (i < 0) return ''; const j = wat.indexOf('\n  (func ', i + 10); return wat.slice(i, j < 0 ? undefined : j) }
const rewinds = (src, opts = {}) => /heap_save/.test(bodyOf(compile(src, { wat: true, ...TAPE, ...opts }), 'f'))
// A frame that restores the heap only on a call no escape site ran in.
const flagged = (src, opts = {}) => /esc_save/.test(bodyOf(compile(src, { wat: true, ...TAPE, ...opts }), 'f'))
const whyNot = (src, opts = {}) => { const why = []; compile(src, { ...TAPE, ...opts, whyNotRewind: (n, r) => why.push([n, r]) }); return why.find(([n]) => n === '$f')?.[1] ?? null }
// Heap growth over `calls` calls of `call`, after `settle` calls that make first-call state.
const growth = (memory, call, calls = 200, settle = 1) => { for (let i = 0; i < settle; i++) call(); const used = memory.used; for (let i = 0; i < calls; i++) call(); return memory.used - used }
// Each `(loop …)` span of a body, by its parentheses.
const loopSpans = (wat) => [...wat.matchAll(/\(loop/g)].map(({ index }) => { let d = 0, j = index; do { d += wat[j] === '(' ? 1 : wat[j] === ')' ? -1 : 0; j++ } while (d > 0); return wat.slice(index, j) })

test('frame effects: own builtin-named methods retain their call effects', () => {
  for (const [init, method] of [['new Map()', 'get'], ['[1,2]', 'slice'], ['{}', 'get']]) {
    const src = `let a=new Float64Array([1]);let o=${init};
      o.${method}=()=>{a[0]=5;return 0};
      function g(n){return n>0?g(n-1):o.${method}(0)}
      export function f(){a[0]=1;let x=a[0];g(0);let y=a[0];return x+y}`
    for (const optimize of levels(0, 2, 3)) {
      const f = jz(src, { optimize }).exports.f
      is(f(), 6, `${init}.${method}, O${optimize}`)
      is(f(), 6, 'the override still writes on a repeated call')
    }
  }
})

// --- The miscompile: an allocation that escapes the frame through a store into module state.

test('frame effects: a fresh object stored into a module field survives the call', () => {
  const src = `const st = { last: null }
    export function f() { st.last = { x: 1 }; return 1 }
    export const h = () => ({ x: 2 })
    export function g() { return st.last.x }`
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { optimize })
    m.exports.f(); m.exports.h()
    is(m.exports.g(), 1, `O${optimize}: the stored object is not overwritten by the next allocation`)
  }
  is(whyNot(src), 'kept on a call that runs an escape: heap value into st', 'the census names the escaping store')
})

test('frame effects: an empty literal kept in a module binding survives the call', () => {
  // taken for `undefined`, the literal was no value: the frame rewound and the next array took its place
  for (const [init, use, read] of [['[]', 'cache.push(n)', 'cache.length + ":" + cache[0]'], ['{}', 'cache.k = n', '"k:" + cache.k']]) {
    const src = `let cache = null
      export function f(n) { if (!cache) cache = ${init}; const t = [n, n]; return t.length }
      export function g(n) { const z = [7, 8, 9, n]; ${use}; return z.length }
      export let read = () => ${read}`
    for (const optimize of levels(0, 2, 3)) {
      const m = jz(src, { optimize }).exports, js = oracle(src)
      for (const x of [m, js]) { x.f(1); x.g(5); x.f(2); x.g(6) }
      is(m.read(), js.read(), `${init} at O${optimize}`)
    }
  }
})

test('frame effects: a fresh object pushed into a module array, and a string, survive the call', () => {
  const pushed = `const st = { last: null }
    export function f() { st.last = { x: 1 }; return 1 }
    export function g() { const a = []; for (let i = 0; i < 4; i++) a.push({ x: 2 }); return st.last.x + a.length }`
  const str = `const st = { last: null }
    export function f() { st.last = { x: 1 }; return 1 }
    export function g(s) { const t = 'ab' + s + s; return st.last.x + t.length }`
  for (const optimize of levels(0, 2, 3)) {
    let m = jz(pushed, { optimize }); m.exports.f(); is(m.exports.g(), 5, `O${optimize}: array growth after the store`)
    m = jz(str, { optimize }); m.exports.f(); is(m.exports.g('cd'), 7, `O${optimize}: string allocation after the store`)
  }
})

test('frame effects: a value the call surely made, stored into storage older than the call, escapes on every call', () => {
  // The frame a host calls reads the flag all the same: it keeps what the store reaches (module/core/reach.js).
  const kept = 'kept on a call that runs an escape: '
  const param = 'export function f(o, n) { o.x = { y: n }; const t = new Array(n).fill(0); return t.length }'
  ok(whyNot(param).startsWith(kept + 'heap value into o'), 'through a parameter (the prepared name of `o`)')
  ok(flagged(param) && /\$__survive/.test(bodyOf(compile(param, { wat: true, ...TAPE }), 'f')), 'its frame walks from what it wrote into')
  is(whyNot('const reg = []; function keep(o) { reg.push(o) } export function f(n) { const o = { x: n }; keep(o); return 1 }'), kept + 'heap value into reg', 'through a callee that pushes it into module state')
  is(whyNot('let last = null; export function f(n) { last = [n, n]; return last.length }'), kept + 'outer binding last', 'into a module binding')
  // A function of the module's own keeps whole: the frame around it decides for both.
  const inner = []
  compile('const reg = []; function keep(o) { reg.push(o); return o.x > 0 ? keep({ x: o.x - 1 }) : 0 } export function f(n) { const o = { x: n }; keep(o); return 1 }',
    { ...TAPE, whyNotRewind: (n, r) => inner.push(n + ': ' + r) })
  ok(inner.includes('$keep: escape: heap value into reg'), 'a callee no host calls: ' + inner.join(' | '))
  // A host handed a value may keep it, and names no address: no call restores.
  const host = 'import { log } from "env"; export function f(n) { const o = { x: n }; log(o); const t = new Array(n).fill(0); return t.length }'
  is(whyNot(host, { imports: { env: { log() {} } } }), 'calls log, the host\'s', 'a host import may keep what it receives')
  ok(!rewinds(host, { imports: { env: { log() {} } } }), 'no rewind emitted')
})

test('frame effects: a call that ran an escape keeps what the escape reaches', () => {
  // A thousand temporaries beside the one value kept: the heap goes back to the end of what the value reaches.
  const churn = `export function churn(n) { const a = []; for (let i = 0; i < n; i++) a.push('c' + i + 'yyyyyyyyyyyyyyyy'); return a.length }`
  const big = 'const t = []; for (let i = 0; i < 1000; i++) t.push([i, i + n])'
  const cases = {
    'a module binding': [`let kept = null
      export function f(n) { kept = [n, n + 1]; ${big}; return t.length }`, 'kept.join()'],
    'an entry of a Map made at start': [`const cache = new Map()
      export function f(n) { cache.set(n & 3, new Float64Array([n, n * 2])); ${big}; return t.length }`, '[...cache.keys()].sort().map(k => k + ":" + cache.get(k)[1]).join()'],
    'a nested value in a state object': [`const st = { cur: null, n: 0 }
      export function f(n) { st.cur = { a: [n, { deep: 'v' + n + 'zzzzzzzzzzzzzzzzzzzz' }], b: new Float64Array([n]) }; st.n = n; ${big}; return t.length }`,
      'st.cur.a[0] + ":" + st.cur.a[1].deep + ":" + st.cur.b[0] + ":" + st.n'],
    'a closure, the cell and the array it captured': [`const st = { next: null }
      export function f(n) { let c = n; const arr = [n, n + 1]; st.next = () => { c += arr[1]; return c }; ${big}; return t.length }`, 'st.next() + ":" + st.next()'],
    'a view, a Set, a BigInt, a slice, a Map': [`const st = { view: null, set: null, big: null, str: null, map: null }
      export function f(n) { const b = new Float64Array(16); b[3] = n; st.view = b.subarray(2, 8); st.set = new Set([n, 'w' + n + 'zzzzzzzzzzzzzzzzzzzz']); st.big = BigInt(n) * 1000000007n
        st.str = ('a string long enough to live in the heap ' + n).slice(3, 30); st.map = new Map([[n, { deep: [n] }]]); ${big}; return t.length }`,
      'st.view[1] + ";" + [...st.set].join() + ";" + String(st.big) + ";" + st.str + ";" + st.map.get([...st.map.keys()][0]).deep[0]'],
    'an array made at start that the call grows': [`const log = [0]
      export function f(n) { for (let i = 0; i < 40; i++) log.push({ v: n + i }); ${big}; return t.length }`, 'log.length + ":" + log[log.length - 1].v + ":" + log[1].v'],
    'a property an object made at start takes': [`const p = { a: 1 }
      export function f(n) { p['k' + (n & 3) + '_a_key_too_long_to_pack'] = [n, 'v' + n + 'zzzzzzzzzzzzzzzzzzzz']; ${big}; return t.length }`,
      'Object.keys(p).sort().map(k => k.slice(0, 2) + ":" + p[k]).join(";")'],
  }
  for (const [what, [body, read]] of Object.entries(cases)) for (const optimize of levels(2, 3)) {
    const src = `${body}\n export let read = () => ${read}\n ${churn}`
    const { exports: m, memory } = jz(src, { optimize }), js = oracle(src), kept = []
    for (let i = 1; i <= 8; i++) {
      const used = memory.used
      m.f(i); js.f(i)
      kept.push(memory.used - used)
      m.churn(40); js.churn(40)
      is(m.read(), js.read(), `${what}: what call ${i} kept reads back at ${optimize}`)
    }
    // the first calls make a table's first entries and the durable log, one time each; an array that grows moves whole
    ok(Math.max(...kept.slice(4)) < 8192, `${what}: a call keeps what it stored, not the 48 KB beside it, at ${optimize}: ${kept}`)
  }
  // Below the highest block reached everything stays: a value stored last keeps what the call made before it.
  const late = `let kept = null
    export function f(n) { ${big}; kept = [n, t.length]; return t.length }
    export let read = () => kept.join()\n ${churn}`
  // The frame keeps all where an escape names no address (a host handed a value), and where the log is full.
  const host = `import { take } from 'env'
    const st = { cur: null }
    export function f(n) { st.cur = [n]; take([n, n + 1]); ${big}; return t.length }
    export let read = () => st.cur.join()\n ${churn}`
  const full = `const slots = []; for (let i = 0; i < 200; i++) slots.push({ v: null })
    export function f(n) { for (let i = 0; i < 200; i++) slots[i].v = [n, i]; ${big}; return t.length }
    export let read = () => slots[0].v.join() + ';' + slots[199].v.join()\n ${churn}`
  for (const [what, src, opts] of [['a value stored last', late], ['a host handed a value', host, { imports: { env: { take() {} } } }], ['more receivers than the log holds', full]]) for (const optimize of levels(2, 3)) {
    const { exports: m, memory } = jz(src, { optimize, ...opts }), js = oracle(src.replace(/import[^\n]*\n/, 'const take = () => {}\n'))
    for (let i = 1; i <= 3; i++) {
      const used = memory.used
      m.f(i); js.f(i)
      ok(memory.used - used > 40000, `${what}: call ${i} keeps all at ${optimize}`)
      m.churn(40); js.churn(40)
      is(m.read(), js.read(), `${what}: what call ${i} kept reads back at ${optimize}`)
    }
  }
})

test('frame effects: a block with no payload, the last its call made, stays with what names it', () => {
  // an empty typed array is a header alone: its pointer names the heap's top as the call returns
  const src = `let a
    export function reset(n) { const b = new Int32Array(n + 2); b[0] = n; a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = i + 7; return b[0] }
    export function read(n, k) { let s = 0; for (let i = 0; i < n; i++) s += a[k] | 0; return s }
    export function write(n, k) { for (let i = 0; i < n; i++) a[k] = (a[k] | 0) + 1; return a.length }
    export function churn(n) { const t = new Int32Array(n); t.fill(-1); return t.length }
    let e = null, s = null
    export function empties() { e = []; s = new Set(); return 1 }
    export let sizes = () => e.length + ':' + s.size`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { optimize }).exports
    for (const n of [0, 3, 0, 1, 0]) {
      is(m.reset(n), js.reset(n)); is(m.churn(64), js.churn(64))
      for (const k of [0, n]) { is(m.write(2, k), js.write(2, k), `O${optimize}: length ${n}, a write at ${k}`); is(m.read(3, k), js.read(3, k), `O${optimize}: length ${n}, a read at ${k}`) }
    }
    is(m.empties(), js.empties()); is(m.churn(64), js.churn(64))
    is(m.sizes(), js.sizes(), `O${optimize}: an empty array and an empty Set`)
  }
})

test('frame effects: the log of what the escapes wrote into is made as the module starts', () => {
  const src = `let kept = null
    export function f(i) { const t = new Float64Array(64); t[1] = i; kept = [i, t[1]]; return t.length }
    export let read = () => kept.join()`
  const js = oracle(src)
  for (const optimize of levels(2, 3)) {
    const { exports: m, memory } = jz(src, { optimize }), held = []
    for (let i = 0; i < 4; i++) { const used = memory.used; is(m.f(i), js.f(i)); held.push(memory.used - used) }
    is(m.read(), js.read())
    is(held[0], held[3], `O${optimize}: the first call keeps what the last does: ${held}`)
    ok(held[0] > 0 && held[0] < 64, 'the pair it stored, none of its temporary')
  }
  if (belowOpt(2)) return
  ok(!/call \$__alloc/.test(bodyOf(compile(src, { wat: true, ...TAPE }), '__root')), 'no store allocates the log')
})

test('frame effects: the host keeps the mark of a frame that runs around its call', () => {
  // `__base` answers the mark it replaced: the host puts an older one back, and the log starts empty only where none stood.
  const src = `const st = { cur: null }
    export function f(xs, n) { st.cur = [xs.length, n]; const t = [n, n]; return t.length }
    export let read = () => st.cur.join()`
  const { instance, exports: m } = jz(src, { optimize: 2 })
  const base = instance.exports.__base
  ok(typeof base === 'function' && typeof instance.exports.__survive === 'function', 'the module hands the host its mark and its walk')
  is(base(-1) >>> 0, 0xFFFFFFFF, 'no frame reads the flag between calls')
  is(base(4096) >>> 0, 0xFFFFFFFF, 'a mark set where none stood')
  is(base(8192) >>> 0, 4096, 'the mark it replaces is the answer: the older one, to put back')
  is(base(4096) >>> 0, 8192)
  is(base(-1) >>> 0, 4096, 'and the call returns it to none')
  is(m.f([1, 2, 3], 5), 2); is(m.read(), '3,5', 'a call between reads what it stored')
})

test('frame effects: what a walked call kept of a receiver made at start goes at a reset', () => {
  // The durable log a store into such a receiver writes lies in the call's memory: the walk counts it live.
  const src = `const log = [0], st = { n: 0 }
    export function f(n) { log.push(n); st.n = n; const t = []; for (let i = 0; i < 1000; i++) t.push([i, i + n]); return t.length }
    export function churn(n) { const a = []; for (let i = 0; i < n; i++) a.push('c' + i + 'yyyyyyyyyyyyyyyy'); return a.length }
    export let read = () => log.join()`
  for (const optimize of levels(2, 3)) {
    const { exports: m, memory } = jz(src, { optimize })
    for (let round = 0; round < 3; round++) {
      for (let i = 1; i <= 5; i++) { m.f(i); m.churn(20) }
      is(m.read(), '0,1,2,3,4,5', `round ${round}: the array as the calls left it at ${optimize}`)
      memory.reset()
      is(m.read(), '0', `round ${round}: and as the module started, past the reset`)
      m.churn(60)
    }
  }
})

test('frame effects: the log of escapes holds through resets and through more receivers than it takes', () => {
  // Its table is memory no reset restores, its count a global: they agree round after round.
  const src = `const slots = []; for (let i = 0; i < 300; i++) slots.push({ v: null })
    export function f(from, n) { for (let i = 0; i < n; i++) slots[(from + i) % 300].v = [from, i]; const t = []; for (let i = 0; i < 200; i++) t.push([i]); return t.length }
    export let read = (i) => { const v = slots[i].v; return v === null ? 'null' : v.join() }`
  const js = oracle(src)
  for (const optimize of levels(2, 3)) {
    const { exports: m, memory } = jz(src, { optimize })
    for (let round = 0; round < 12; round++) {
      const fresh = oracle(src)
      for (const [from, n] of [[round * 37, 90], [round * 11, 5], [round * 53, 200], [round, 1]]) {
        is(m.f(from, n), fresh.f(from, n))
        for (const i of [from % 300, (from + n - 1) % 300, (from + n) % 300]) is(m.read(i), fresh.read(i), `round ${round}: slot ${i} after ${n} stores from ${from} at ${optimize}`)
      }
      memory.reset()
      is(m.read(round), js.read(round), `round ${round}: as the module started, past the reset`)
    }
  }
})

test('frame effects: an escape that may not run on a call keeps the call that runs it', () => {
  for (const [src, where] of [
    ['export function f(o, n) { if (n > 3) o.x = { y: n }; const t = new Array(n).fill(0); return t.length }', 'an if arm'],
    ['let cache = null; export function f(n) { const t = new Array(n).fill(0); if (cache !== null) return t.length + cache[0]; cache = new Float64Array(2); return t.length }', 'past an early return'],
    ['let st = null; export function f(n) { st ??= new Float64Array(2); const t = new Array(n).fill(0); return t.length + st[0] }', 'a logical assignment\'s store'],
    ['const kept = []; export function f(n) { const t = new Array(n).fill(0); for (let i = 0; i < n; i++) kept.push([i]); return t.length }', 'a loop\'s body, which runs no times as well as many'],
  ]) {
    ok(/^kept on a call that runs an escape: /.test(whyNot(src)), `${where}: ${whyNot(src)}`)
    ok(flagged(src), `${where}: the frame restores by the escape flag`)
  }
  // the call that makes the state keeps its memory, every later one is released
  const lazy = `let cache = null
    export function f(n) { const t = new Array(n).fill(1); if (cache === null) cache = new Float64Array(4); cache[0] += t.length; return cache[0] }`
  const want = oracle(lazy)
  for (const optimize of levels(2, 3, 'size')) {
    const { exports: m, memory } = jz(lazy, { optimize }), js = oracle(lazy)
    is(growth(memory, () => m.f(9)), 0, `a state made on the first call: later calls keep nothing at ${optimize}`)
    for (let i = 0; i <= 200; i++) js.f(9)
    is(m.f(9), js.f(9), `the state kept its values at ${optimize}`)
  }
  ok(want.f(1) === 1)
})

test('frame effects: a store that holds no heap value escapes only where it allocates', () => {
  // A scratch array in a module binding: it grows to its capacity once.
  const scratch = `const scratch = []
    export function f(n) { scratch.length = 0; for (let i = 0; i < n; i++) scratch.push(i * 2); let s = 0; for (let i = 0; i < scratch.length; i++) s += scratch[i]; const t = [s, s]; return t[0] }
    export function churn(n) { const x = []; for (let i = 0; i < n; i++) x.push([i, i]); return x.length }
    export let read = () => scratch.length * 1000 + scratch[7]`
  const want = oracle(scratch)
  for (const optimize of levels(2, 3, 'size')) {
    const { exports: m, memory } = jz(scratch, { optimize })
    is(m.f(64), want.f(64), `the sum at ${optimize}`)
    is(growth(memory, () => m.f(64)), 0, `refilled within its capacity, a call keeps nothing at ${optimize}`)
    m.f(300); m.churn(64); want.f(300); want.churn(64)
    is(m.read(), want.read(), `the call in which it outgrew its capacity kept its storage at ${optimize}`)
  }
  is(whyNot(scratch), 'kept on a call that runs an escape: grows scratch')
  // a number into a slot of unknown kind, an index past the end of a module array
  const slot = `const W = [0, 0], st = { v: null }
    export function f(n) { const t = new Array(8).fill(n); W[n] = t.length; st.v = n; return t.length }
    export function churn(n) { const x = []; for (let i = 0; i < n; i++) x.push([i, i]); return x.length }
    export let read = () => W.length * 100 + W[40] + st.v`
  const wantSlot = oracle(slot)
  for (const optimize of levels(2, 3, 'size')) {
    const { exports: m, memory } = jz(slot, { optimize })
    is(growth(memory, () => m.f(1)), 0, `stores within the array: a call keeps nothing at ${optimize}`)
    m.f(40); m.churn(64); wantSlot.f(1); wantSlot.f(40); wantSlot.churn(64)
    is(m.read(), wantSlot.read(), `the store that grew the array kept it at ${optimize}`)
  }
})

test('frame effects: a growth\'s check stands around the loop that holds its receiver and allocates nothing else', () => {
  // `t` may be an array the store grows: one check per call, outside the loop
  const once = 'export function f(a, b, k, n) { const s = new Array(4).fill(0); const t = k === 1 ? a : b; for (let i = 0; i < n; i = i + 1) t[i] = i + s[0]; return s.length }'
  const body = bodyOf(compile(once, { wat: true, ...TAPE }), 'f')
  ok(flagged(once) && /\$__esc/.test(body) && loopSpans(body).length && !loopSpans(body).some(l => /\$__esc|esch/.test(l)), 'the check is outside every loop')
  const want = oracle(once), m = jz(once).exports
  for (const [a, b] of [[[1, 2], [3]], [new Float64Array(4), [0]]]) is(m.f(a, b, 1, 6), want.f([...a], [...b], 1, 6), 'a growing array and a typed one')
  // a row the outer loop binds anew is the same through the inner loop: its check runs once per row
  const rows = 'export function f(rows, n) { const s = new Array(4).fill(0); for (let i = 0; i < n; i++) { const row = rows[i]; for (let j = 0; j < n; j++) row[j] = j + s[0] } return s.length }'
  const loops = loopSpans(bodyOf(compile(rows, { wat: true, ...TAPE }), 'f')), innermost = loops.filter(l => l.indexOf('(loop', 5) < 0)
  ok(flagged(rows) && loops.some(l => /\$__esc/.test(l)) && !innermost.some(l => /\$__esc|esch/.test(l)), 'the check runs per row, outside the inner loop')
  // a loop that allocates besides its stores checks each store: what the loop made is no growth of the receiver
  const noisy = `const out = [0, 0, 0, 0]
    export function f(n, k) { for (let i = 0; i < k; i++) { const c = 'k' + n + i; out[i] = c.length } return out[3] }`
  ok(loopSpans(bodyOf(compile(noisy, { wat: true, ...TAPE }), 'f')).some(l => /\$__esc/.test(l)), 'the check stands at the store')
  for (const optimize of levels(2, 3, 'size')) {
    const { exports: x, memory } = jz(noisy, { optimize })
    is(x.f(5, 4), oracle(noisy).f(5, 4)); is(growth(memory, () => x.f(5, 4)), 0, `the temporaries of the loop go with the call at ${optimize}`)
  }
})

test('frame effects: receivers one loop stores into each keep theirs', () => {
  // an FDN's stereo block: `L[i] = …` and `R[i] = …`, one check around the loop for both
  const src = `let A = [], B = [], TA = new Float64Array(64), TB = new Float64Array(64)
    export function f(k, n) { const s = new Array(4).fill(0); const a = k === 1 ? A : TA, b = k === 1 ? B : TB; for (let i = 0; i < n; i++) { a[i] = i + s[0]; b[i] = i * 2 } return s.length }
    export function churn(n) { const x = []; for (let i = 0; i < n; i++) x.push([i, i]); return x.length }
    export let read = () => A.length * 1000 + A[7] * 10 + B[7]`
  const want = oracle(src)
  for (const optimize of levels(2, 'size')) {
    const { exports: m, memory } = jz(src, { optimize })
    m.f(0, 8); const used = memory.used
    for (let i = 0; i < 100; i++) m.f(0, 8)
    is(memory.used, used, `two typed receivers: every call released at ${optimize}`)
    is(m.f(1, 8), want.f(1, 8)); m.churn(64); want.churn(64)
    is(m.read(), want.read(), `two growing arrays read back at ${optimize}`)
  }
})

test('frame effects: what escaped through a callback, a return from inside a loop, a named arrow, stays', () => {
  const kept = `let store = [], typed = new Float64Array(8)
    export function f(k, n) { const s = new Array(4).fill(0); const t = k === 1 ? store : typed; for (let i = 0; i < n; i++) { t[i] = i + s[0]; if (i === 2) return s.length } return s.length }
    export function g(k, xs) { const s = new Array(4).fill(0); const t = k === 1 ? store : typed; xs?.forEach((x, i) => { t[i + 4] = x + s[0] }); return s.length }
    export function e(k) { const s = new Array(4).fill(0); const t = k === 1 ? store : typed; const xs = [k, k + 1, k + 2]; xs.forEach((x, i) => { t[i + 12] = x + s[0] }); return s.length }
    export function h(k, n) { const s = new Array(4).fill(0); const pick = (node) => { for (let j = 0; j < 3; j++) node[j + 8] = j + s[0] }; for (let i = 0; i < n; i++) pick(k === 1 ? store : typed); return s.length }
    export function g2(c, k) { const s = new Array(4).fill(0); const t = k === 1 ? store : typed; const put = (i) => { for (let j = 0; j < 2; j++) t[i + j] = j + s[0] }; if (c) { for (let i = 0; i < 3; i++) put(i) } put(20); return s.length }
    export function j(k, n) { const s = new Array(4).fill(0); const t = k === 1 ? store : typed; rows: for (let r = 0; r < 2; r++) { for (let i = 0; i < n; i++) { t[i + 30] = i + s[0]; if (i === 1) break rows } } return s.length }
    export function churn(n) { const a = []; for (let i = 0; i < n; i++) a.push([i, i]); return a.length }
    export let read = () => store.length * 1000 + store[2] * 100 + (store[5] ?? 0) + (store[13] ?? 0) + (store[21] ?? 0) * 10 + (store[31] ?? 0)`
  // a loop a `return` or a jump to a label leaves has no check after it: the store
  // checks itself. A named arrow runs from each call to it (`pick`'s own parameter,
  // out of scope in `h`; `put`, called in a loop a branch guards and after it). Kept
  // out of line, the arrows stay arrows.
  const want = oracle(kept)
  for (const optimize of [...levels(2, 'size'), { level: 2, inlineFns: false, sourceInline: false }]) {
    const m = jz(kept, { optimize }).exports
    for (const [fn, args] of [['f', [1, 6]], ['g', [1, [7, 8]]], ['e', [1]], ['f', [0, 6]], ['h', [1, 2]], ['g2', [0, 1]], ['j', [1, 4]]]) is(m[fn](...args), want[fn](...args), `${fn} at ${optimize}`)
    m.churn(64); is(m.read(), want.read(), `the grown array reads back after other allocations at ${optimize}`)
  }
})

test('frame effects: a call the census cannot name is no escape: what it runs lowers the flag itself', () => {
  // A stream made once, written every block: its method is a closure in a slot, its state a cell.
  const stream = `const make = () => { let g = 0; return { write(chunk) { const out = new Float32Array(chunk.length); for (let i = 0; i < chunk.length; i++) { g = g * 0.5 + chunk[i]; out[i] = g } return out } } }
    let chans = [], inp = new Float32Array(64), out = new Float32Array(64)
    export function start() { chans = [make(), make()]; for (let i = 0; i < 64; i++) inp[i] = i % 7 }
    export function f(c) { out.set(chans[c].write(inp)); return 0 }
    export let read = (i) => out[i]`
  // A temporary built of closures, a cell and a buffer it regrows, made and dropped within the call.
  const temp = `const stream = () => { let buf = new Float64Array(4), len = 0
      const grow = (n) => { if (n > buf.length) { const b = new Float64Array(n * 2); b.set(buf); buf = b } }
      return { push(x) { grow(len + 1); buf[len++] = x }, sum() { let s = 0; for (let i = 0; i < len; i++) s += buf[i]; return s } } }
    export function f(n) { const s = stream(); for (let i = 0; i < n; i++) s.push(i); return s.sum() }`
  // A callback handed to a helper, a method of a receiver of unknown kind.
  const helper = `const each = (xs, visit) => { for (let i = 0; i < xs.length; i++) visit(xs[i], i) }
    const tail = (a) => a.slice(1)
    export function f(n) { const xs = [1, 2, 3, n]; let s = 0; each(xs, (x, i) => { s += x * i }); return s + tail(xs).length }`
  for (const optimize of levels(2, 3, 'size')) {
    let { exports: m, memory } = jz(stream, { optimize }), js = oracle(stream)
    m.start(); js.start()
    is(growth(memory, () => m.f(1)), 0, `a block through a stream's method keeps nothing at ${optimize}`)
    for (let i = 0; i <= 200; i++) js.f(1)
    for (const i of [0, 5, 63]) is(m.read(i), js.read(i), `the stream's state carried from block to block at ${optimize}`)
    ;({ exports: m, memory } = jz(temp, { optimize })); js = oracle(temp)
    for (const n of [3, 10, 1000]) is(m.f(n), js.f(n), `a temporary stream of ${n} at ${optimize}`)
    is(growth(memory, () => m.f(1000)), 0, `it goes with the call at ${optimize}`)
    ;({ exports: m, memory } = jz(helper, { optimize })); js = oracle(helper)
    is(m.f(4), js.f(4)); is(growth(memory, () => m.f(4)), 0, `a callback and an unnamed method keep nothing at ${optimize}`)
  }
  // An unproven receiver may be an array the push grows, or an object with a push of its own.
  const pushes = `const bag = { n: 0, push(x) { this.n += x; return this.n } }, arr = [1]
    export function f(k, x) { const t = [x, x]; const r = k === 1 ? arr : bag; r.push(t.length); return k === 1 ? arr.length : bag.n }
    export function churn(n) { const a = []; for (let i = 0; i < n; i++) a.push([i, i]); return a.length }
    export let read = () => arr.length * 100 + arr[arr.length - 1] + bag.n`
  const want = oracle(pushes)
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(pushes, { optimize }).exports
    for (let i = 0; i < 40; i++) is(m.f(i & 1, i), want.f(i & 1, i))
    m.churn(64); is(m.read(), want.read(), `the grown array and the object's count at O${optimize}`)
  }
})

test('frame effects: a stored value no running call made lowers nothing', () => {
  // Two buffers swapped every block, a string of the module's own, a number where any value may go.
  const swap = `let cur = new Float64Array(16), prev = new Float64Array(16)
    const p = { type: 'none', gain: null }, kinds = ['lowpass', 'highpass']
    export function f(k, x) { const t = [x, x + 1]; const was = cur; cur = prev; prev = was; p.type = kinds[k]; p.gain = x; cur[0] = t[0] + prev[0]; return cur[0] }
    export let read = () => p.type + ':' + p.gain + ':' + cur[0] + ':' + prev[0]`
  for (const optimize of levels(2, 3, 'size')) {
    const { exports: m, memory } = jz(swap, { optimize }), js = oracle(swap)
    is(growth(memory, () => m.f(1, 3)), 0, `a call keeps nothing at ${optimize}`)
    for (let i = 0; i <= 200; i++) js.f(1, 3)
    is(m.f(0, 4), js.f(0, 4)); is(m.read(), js.read(), `what it stored reads back at ${optimize}`)
  }
  // The same stores of values the call made keep them.
  const made = `let cur = null
    const p = { type: 'none', tags: null }
    export function f(k, x) { cur = new Float64Array(4); cur[0] = x; p.type = 'k' + k; p.tags = [k, x]; return cur[0] }
    export function churn(n) { const a = []; for (let i = 0; i < n; i++) a.push('s' + i + 'xxxxxxxxxxxx'); return a.length }
    export let read = () => p.type + ':' + p.tags[1] + ':' + cur[0]`
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(made, { optimize }).exports, js = oracle(made)
    m.f(3, 7); m.churn(64); js.f(3, 7); js.churn(64)
    is(m.read(), js.read(), `O${optimize}`)
  }
})

test('frame effects: a builtin called by name is listed by what it keeps', () => {
  // One the census does not list is an escape with no address at every call of it: the calls it sits in keep their memory.
  compile('export let f = () => 1')
  includeAllMods()
  // what the emitter dispatches by these names is syntax, no callee
  const SYNTAX = new Set(['let', 'const', 'export', 'block', 'throw', 'catch', 'finally', 'return', 'u+', 'u-', 'instanceof', 'void', 'if', 'for', 'while', 'label',
    'break', 'continue', 'this', 'typeof', 'str', 'strcat', 'delete', 'in', 'navigator.hardwareConcurrency'])
  // the host keeps the callback it schedules and what a request or a file is handed; the rest the emitter alone calls
  const KEEPS = new Set(['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'fetch', 'fs.read', 'fs.write',
    '__raw_prop', '__raw_local', '__iter_arr_ctor', '__park_begin', '__park_finish', '__park_rewind',
    ...['u8', 'u32', 'f64', 'i64', 'str'].flatMap(t => ['__park_write_' + t, '__park_read_' + t])])
  const names = Object.keys(ctx.core.emit).filter(k => !k.includes(':') && /^[A-Za-z_$]/.test(k) && !SYNTAX.has(k))
  ok(names.length > 200, `the runtime's names are read: ${names.length}`)
  is(names.filter(n => !listedBuiltin(n) && !KEEPS.has(n)).join(' '), '', 'every name is listed, or kept on purpose')
  is([...KEEPS].filter(n => listedBuiltin(n) || ctx.core.emit[n] == null).join(' '), '', 'and no name is kept that is listed, or gone')
  // Each of these kept a call's memory while the census took it for an escape.
  const kept = {
    'a lane operation': `export function f(n) { const t = [n, n + 1, 'k' + n + 'zzzzzzzzzzzzzzzzzz']; let x = f32x4.splat(n); x = f32x4.add(x, x); return (f32x4.lane(x, 0) + t[2].length) | 0 }`,
    'a random identifier': `export function f(n) { const s = crypto.randomUUID(); return s.length | 0 }`,
    'random bytes': `export function f(n) { const a = new Uint8Array(16); crypto.getRandomValues(a); return a.length | 0 }`,
    'an error of a kind the list left out': `export function f(n) { const e = new URIError('x' + n + 'zzzzzzzzzzzzzzzzzz'); return e.message.length | 0 }`,
    'a text encoder': `export function f(n) { const b = new TextEncoder().encode('x' + n + 'zzzzzzzzzzzzzzzzzz'); return b.length | 0 }`,
    'a text decoder': `export function f(n) { const s = new TextDecoder().decode(new Uint8Array([104, 105, 48 + n])); return s.length | 0 }`,
    'a derived class marking its members': `class A { constructor(x) { this.x = x } a() { return this.x } }
      class B extends A { constructor(x) { super(x); this.y = x + 1 } b() { return this.y + this.a() } }
      export function f(n) { const v = new B(n); return v.b() | 0 }`,
  }
  for (const [what, src] of Object.entries(kept)) for (const optimize of levels(2, 3)) {
    const { exports: m, memory } = jz(src, { optimize })
    is(growth(memory, () => m.f(3), 20), 0, `${what} keeps nothing at ${optimize}`)
  }
})

test('frame effects: a call that opens the runtime\'s iterator records keeps nothing past the first of a round', () => {
  // The records are made as the module starts (src/std/iter.js): a call that made one kept all it allocated beside it.
  // The round's first store of an iterator into a record saves the record for the reset, once.
  const first = (src, args, optimize) => {
    const { exports: m, memory } = jz(src, { optimize }), js = oracle(src), kept = [], reset = []
    for (let i = 0; i < 3; i++) { const used = memory.used; is(m.f(...args, i), js.f(...args, i), `call ${i} at ${optimize}`); kept.push(memory.used - used) }
    memory.reset()
    for (let i = 0; i < 2; i++) { const used = memory.used; is(m.f(...args, i), js.f(...args, i), `call ${i} past a reset at ${optimize}`); reset.push(memory.used - used) }
    return [kept, reset]
  }
  const pair = 'export function f(x, n) { const t = [n, n + 1, n + 2]; const [a, b] = x; return (a | 0) + (b | 0) + t.length }'
  const set = 'export function f(x, n) { const t = [n, n + 1]; const [a, b] = new Set([n, n + 5]); return (a | 0) + (b | 0) + t.length }'
  // five patterns open at once: one record more than the module made
  const deep = 'export function f(x, n) { const t = [n, n + 1]; const [[[[[a]]]], b] = x; return (a | 0) + (b | 0) + t.length }'
  const once = ([kept, reset]) => kept[0] > 0 && kept[0] < 512 && kept[1] === 0 && kept[2] === 0 && reset[0] > 0 && reset[0] < 512 && reset[1] === 0
  for (const optimize of levels(0, 2, 3)) {
    const over = first(pair, [[3, 4]], optimize), set2 = first(set, [0], optimize)
    ok(once(over), `a pattern over an argument keeps the record it saved, once a round, at ${optimize}: ${over.join(' | ')}`)
    ok(once(set2), `a pattern over a Set at ${optimize}: ${set2.join(' | ')}`)
    const [kept, reset] = first(deep, [[[[[[7]]]], 2]], optimize)
    ok(kept[0] > 0 && kept[1] === 0 && kept[2] === 0, `a record past the module's is made once at ${optimize}: ${kept}`)
    ok(reset[0] > 0 && reset[1] === 0, `and once more past a reset, which took it: ${reset}`)
  }
})

test('frame effects: what a store\'s operand allocates is no growth of its receiver', () => {
  // The check of a store that escapes only where it allocates stands past its operands.
  const churn = `export function churn(n) { const a = []; for (let i = 0; i < n; i++) a.push('c' + i + 'yyyyyyyyyyyyyyyy'); return a.length }`
  const quiet = {
    'an element of a module array': [`const out = [0, 0]
      export function f(n) { out[0] = [n, 2, 3].length + n; return 1 }`, 'out.join()'],
    'a property made by the first store': [`const p = {}
      export function f(n) { p.size = [n, 2, 3].length + n; return 1 }`, '"p" + p.size'],
    'an argument of a method that stores': [`const out = []
      export function f(n) { if (out.length < 4) out.push([n, 2].length + n); else out[n & 3] = [n].length + n; return 1 }`, 'out.join()'],
    'a compound store': [`const out = [0, 0]
      export function f(n) { out[1] += [n, 2].length; return 1 }`, 'out.join()'],
  }
  for (const [what, [body, read]] of Object.entries(quiet)) {
    const src = `${body}\n export let read = () => ${read}\n ${churn}`
    for (const optimize of levels(0, 2, 3, 'size')) {
      const { exports: m, memory } = jz(src, { optimize }), js = oracle(src)
      for (let i = 0; i < 20; i++) { m.f(i); m.churn(3); js.f(i); js.churn(3) }
      const used = memory.used
      for (let i = 20; i < 40; i++) { m.f(i); js.f(i) }
      is(memory.used - used, 0, `${what}: a call keeps nothing at ${optimize}`)
      m.churn(8); js.churn(8)
      is(m.read(), js.read(), `${what}: what it stored reads back at ${optimize}`)
    }
  }
  // The store that does grow, and the key made a string before the operand, keep the call.
  const kept = {
    'a store past the end': [`const out = []
      export function f(n) { out[n] = [n, 2, 3].length + n; return 1 }`, 'out.join()'],
    'a key made a string': [`const o = {}
      export function f(n) { o['a_key_too_long_to_pack_' + (n & 7)] = [n, 2].length + n; return 1 }`, 'Object.keys(o).sort().map(k => k + ":" + o[k]).join()'],
    'an operand that grows the receiver itself': [`const out = []
      export function f(n) { out[0] = out.push(n) * 2 + [n].length; return 1 }`, 'out.join()'],
    'an operand that is the value kept': [`const out = [0, 0, 0, 0]
      export function f(n) { out[n & 3] = [n, [n + 1, 'v' + n + 'zzzzzzzzzzzzzzzz']]; return 1 }`, 'out.map(x => x[0] + ":" + x[1][1]).join()'],
  }
  for (const [what, [body, read]] of Object.entries(kept)) {
    const src = `${body}\n export let read = () => ${read}\n ${churn}`
    for (const optimize of levels(0, 2, 3, 'size')) {
      const m = jz(src, { optimize }).exports, js = oracle(src)
      for (let i = 0; i < 40; i++) { m.f(i); m.churn(3); js.f(i); js.churn(3) }
      is(m.read(), js.read(), `${what}: what it stored reads back at ${optimize}`)
    }
  }
})

test('frame effects: a literal stored as numbers into the cells its element had is no escape', () => {
  // the immutable-update idiom: every step replaces each record, and the emitter writes the fields in place
  const src = `const init = () => {
      const ps = []
      let s = 0x9e3779b9 | 0
      for (let i = 0; i < 24; i++) {
        s = (s ^ (s << 7)) | 0
        s = (s ^ (s >>> 9)) | 0
        ps.push({ x: (s >>> 2) & 255, y: (s >>> 5) & 255, vx: (1 + (s & 3)) | 0, vy: (1 + ((s >>> 9) & 3)) | 0 })
      }
      return ps
    }
    const step = (ps) => {
      let h = 0
      for (let it = 0; it < 5; it++) for (let i = 0; i < 24; i++) {
        const p = ps[i]
        const nx = (p.x + p.vx) & 1023, ny = (p.y + p.vy) & 1023, wx = (p.vx ^ it) | 0, wy = (p.vy + 1) | 0
        ps[i] = { x: nx, y: ny, vx: wx, vy: wy }
        h = Math.imul(h ^ (nx + ny * 31), 16777619)
      }
      return h >>> 0
    }
    export const f = () => { let cs = step(init()); const ps = init(); cs = (cs + step(ps) + ps.length) | 0; return cs }
    export const g = () => step(init())`
  const want = oracle(src)
  for (const optimize of levels(0, 2, 3)) {
    const { exports: m, memory } = jz(src, { optimize })
    for (let i = 0; i < 3; i++) is(m.f(), want.f(), `O${optimize}, call ${i}`)
    is(m.g(), want.g(), `O${optimize}: a function that ends by the call`)
    if (optimize < 2) continue   // no frame restores below
    is(growth(memory, () => m.f()), 0, `O${optimize}: the call keeps nothing`)
    is(growth(memory, () => m.g()), 0, `O${optimize}: keeps nothing either`)
  }
  if (belowOpt(2)) return
  const loops = loopSpans(bodyOf(compile(src, { wat: true }), 'step')).filter(l => /i32\.store offset=12/.test(l))
  ok(loops.length > 0, 'the records are written in place, four words each')
  ok(loops.every(l => !/\$__esc|\$__alloc/.test(l)), 'and their loop lowers no flag and allocates nothing')
})

test('frame effects: a value read off the receiver it is stored into is no escape', () => {
  // The receiver held the value already: the store hands it nothing, and asks nothing.
  const asks = (src) => (bodyOf(compile(src, { wat: true, ...TAPE }), 'f').match(/__esc_new/g) ?? []).length
  const copy = 'export function f(a, n) { for (let i = 0; i < n; i++) a[i] = a[i + 1] }'
  const swap = 'export function f(a, n) { for (let i = 0, j = n - 1; i < j; i++, j--) { const t = a[i]; a[i] = a[j]; a[j] = t } }'
  const path = 'export function f(o, n) { for (let i = 0; i < n; i++) o.list[i] = o.list[n - i] }'
  is(asks(copy), 0, 'an element of the receiver')
  is(asks(swap), 0, 'a local bound once to an element of it')
  is(asks(path), 0, 'a path read twice with nothing run between')
  // Another receiver's element, a receiver rebound, a local written twice, a key that runs a call: asked.
  ok(asks('export function f(a, b, n) { for (let i = 0; i < n; i++) a[i] = b[i] }') > 0, 'an element of another receiver')
  ok(asks('export function f(a, b, n) { const t = a[0]; a = b; a[1] = t }') > 0, 'the receiver rebound since the read')
  ok(asks('export function f(a, b, n) { let t = a[0]; t = b[0]; a[1] = t }') > 0, 'a local written again')
  ok(asks('export function f(a, b) { const t = a[0]; { const a = b; a[1] = t } }') > 0, 'a receiver of the same name in a block of its own')
  ok(asks('export function f(a, b) { { const t = a[0]; b[0] = 1 } { const t = b[0]; a[1] = t } }') > 0, 'a local of the same name bound to another read')
  ok(asks('function k(n) { return n > 0 ? k(n - 1) : 0 }\n export function f(a, n) { a[k(n)] = a[n] }') > 0, 'a key that runs a call')
  const src = `let keep = [0, 0, 0]
    export function rev(a, n) { for (let i = 0, j = n - 1; i < j; i++, j--) { const t = a[i]; a[i] = a[j]; a[j] = t } return n }
    export function f(n) { const u = [{ v: n }, { v: n + 1 }, 's' + n + 'xxxxxxxxxxxxxxxx']; for (let i = 0; i < 3; i++) keep[i] = u[i]; rev(keep, 3); return keep.length }
    export function churn(n) { const a = []; for (let i = 0; i < n; i++) a.push('c' + i + 'yyyyyyyyyyyyyyyy'); return a.length }
    export let read = () => keep[0] + ':' + keep[1].v + ':' + keep[2].v`
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { optimize }).exports, js = oracle(src)
    for (const x of [m, js]) { x.f(3); x.churn(64); x.f(5); x.churn(64) }
    is(m.read(), js.read(), `values another receiver held stay, O${optimize}`)
  }
  // A getter makes the value it yields: the receiver never held it.
  const made = `const box = { kept: null, get fresh() { return { v: 7 } } }
    export function f(k, name) { box[k] = box[name]; return 1 }
    export function churn(n) { const a = []; for (let i = 0; i < n; i++) a.push('c' + i + 'yyyyyyyyyyyyyyyy'); return a.length }
    export let read = () => 'v' + box.kept.v`
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(made, { optimize }).exports, js = oracle(made)
    for (const x of [m, js]) { x.f('kept', 'fresh'); x.churn(64); x.f('kept', 'fresh'); x.churn(64) }
    is(m.read(), js.read(), `a getter's value read by a computed key stays, O${optimize}`)
  }
})

test('frame effects: an element store writes no binding, and a runtime import keeps nothing it is handed', () => {
  const fill = 'export function f(n) { const a = []; for (let i = 0; i < n; i++) a[i] = i * 2; let s = 0; for (let i = 0; i < n; i++) s += a[i]; return s }'
  ok(rewinds(fill) && !flagged(fill), 'the local array stays fresh: a plain rewind')
  const log = 'export function f(n) { const t = new Array(n).fill(0); console.log(t.length); return t.length }'
  ok(rewinds(log) && !flagged(log), 'console.log decodes its arguments: a plain rewind')
})

test('frame effects: a result the summary saw no value of proves no scalar', () => {
  // `clone` is never called, only named by its own `node.map(clone)`: the
  // summary's kind of its result is empty, which is no proof it holds no heap
  // value. Its frame asks the result as it returns.
  const wat = compile(`import { twice } from './util.js'
    export let f = (x) => { const t = [x, x]; return twice(t[0] + t[1]) }`, { ...TAPE, wat: true, modules: {
    './util.js': 'export const clone = (node) => Array.isArray(node) ? node.map(clone) : node; export const twice = (x) => x * 2' } })
  const clone = bodyOf(wat, '__util_js$clone')
  ok(/heap_save/.test(clone) && /call \$__made/.test(clone), 'the frame restores unless the result is of its making')
})

test('frame effects: arrays a parameter default pushes into the caller keep their values', () => {
  // the rewind freed them, and the next call's temporary overwrote them (63/0 at O2)
  const src = `const f = (out, n, x = out.push([n, n + 1])) => n
    const g = (n) => [n, n, n, n, n, n, n, n].length
    export let run = (n) => { const out = []; let s = 0; for (let i = 0; i < n; i++) s += f(out, i) + g(i); let t = 0; for (const p of out) t += p[0] * 10 + p[1]; return s + '/' + t }`
  for (const optimize of levels(0, 2, 3)) is(jz(src, { optimize }).exports.run(6), oracle(src).run(6), `O${optimize}`)
})

test('frame effects: a local a closure made in a declaration rebinds is no fresh local', () => {
  // the census stopped at `const alias = …` and took `buf` for fresh storage: the
  // rewind freed the pushed pair, and g's arrays overwrote it (NaN at O2)
  const src = `const keep = []
    export function f(n) { let buf = []; const alias = () => { buf = keep; return () => 0 }; alias(); buf.push([n, n + 1]); return keep.length }
    export function g(m) { const z = []; for (let i = 0; i < m; i++) z.push([i * 100, i * 100 + 1]); let s = 0; for (const p of z) s += p[0]; return keep[0][0] * 10 + keep[0][1] + s }`
  const js = oracle(src); js.f(3)
  for (const optimize of levels(0, 2, 3)) { const m = jz(src, { optimize }).exports; m.f(3); is(m.g(8), js.g(8), `O${optimize}`) }
  ok(/^kept on a call that runs an escape: grows buf/.test(whyNot(src)), 'the push into what the closure rebound is a store into storage of unknown age')
})

// --- The widening: parameters, numbers into outer storage, fresh local containers.

test('frame effects: a function with parameters rewinds when its allocations stay in the frame', () => {
  ok(rewinds('export function f(a, p) { const t = new Float64Array(a.length); for (let i = 0; i < a.length; i++) t[i] = a[i] * p; let s = 0; for (let i = 0; i < t.length; i++) s += t[i]; return s }'), 'a typed temporary sized by a parameter')
  ok(rewinds('const out = new Float64Array(8); export function f(n) { const t = new Float64Array(n); for (let i = 0; i < n; i++) t[i] = i; for (let i = 0; i < 8; i++) out[i] = t[i] * 2; return out[0] }'), 'numbers stored into a module typed buffer')
  ok(rewinds('const st = { t: 0 }; export function f(dt, n) { const tmp = new Array(n).fill(1); st.t = st.t + dt * tmp.length; return st.t }'), 'a number stored into a module object field')
  ok(rewinds('export function f(n) { const a = []; for (let i = 0; i < n; i++) a.push({ v: i }); return a.length }'), 'growth of a fresh local array')
  ok(rewinds('export function f(s, n) { let t = ""; for (let i = 0; i < n; i++) t += s; return t.length }'), 'a string built in the frame, its length read through a kernel tail call')
  ok(rewinds('export function f(n) { const m = new Map(); for (let i = 0; i < n; i++) m.set(i, i * 2); return m.size }'), 'a fresh Map')
  ok(rewinds('export function f(s, n) { const o = { name: s + "!", n }; return o.name.length + o.n }'), 'a fresh object holding a fresh string')
})

test('frame effects: a rewound function with parameters computes the same values as JS, and the heap stays put', () => {
  const src = `export function f(a, p) { const t = new Float64Array(a.length); for (let i = 0; i < a.length; i++) t[i] = a[i] * p; let s = 0; for (let i = 0; i < t.length; i++) s += t[i]; return s }
    export function g(n) { const a = []; for (let i = 0; i < n; i++) a.push({ v: i }); let s = 0; for (let i = 0; i < a.length; i++) s += a[i].v; return s }
    export function h(s, n) { let t = ""; for (let i = 0; i < n; i++) t += s; return t.length }`
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { optimize })
    const heap = () => m.instance.exports.__heap?.value ?? 0
    for (let r = 0; r < 50; r++) {
      is(m.exports.f(new Float64Array([1, 2, 3]), 2), 12, `O${optimize} round ${r}: f`)
      is(m.exports.g(10), 45, `O${optimize} round ${r}: g`)
      is(m.exports.h('abc', 100), 300, `O${optimize} round ${r}: h`)
    }
    const before = heap()
    for (let r = 0; r < 50; r++) { m.exports.g(10); m.exports.h('abc', 100) }
    if (optimize) is(heap(), before, `O${optimize}: fifty more calls allocate nothing that outlives them`)
  }
})

// --- Per-iteration rewinds: a loop whose iteration lets no allocation escape
// restores the heap pointer at the top of each iteration (optimize/loop-rewind.js).

test('frame effects: a loop building a temporary per iteration runs in constant memory, and an escaping one keeps its values', () => {
  const src = `export function temps(n) { let s = 0; for (let i = 0; i < n; i++) { const m = new Map(); m.set('k', i); s += m.get('k') } return s }
    export function carried(n) { let prev = null, s = 0; for (let i = 0; i < n; i++) { const cur = [i, i * 2]; if (prev) s += prev[1]; prev = cur } return s + prev[0] }
    export function pushed(n) { const out = []; for (let i = 0; i < n; i++) { const t = [i]; out.push(t) } let s = 0; for (const t of out) s += t[0]; return s }
    export function returned(n) { for (let i = 0; i < n; i++) { const t = [i, i]; if (i === 3) return t[1] } return -1 }
    export function joined(n) { let s = ''; for (let i = 0; i < n; i++) { const t = 'ab' + i; s += t } return s.length }
    export function kept(n) { const fs = []; for (let i = 0; i < n; i++) { const t = [i]; fs.push(() => t[0]) } let s = 0; for (const f of fs) s += f(); return s }`
  const want = { temps: 200 * 199 / 2, carried: (() => { let prev = null, s = 0; for (let i = 0; i < 200; i++) { const cur = [i, i * 2]; if (prev) s += prev[1]; prev = cur } return s + prev[0] })(), pushed: 200 * 199 / 2, returned: 3, joined: 'ab'.length * 200 + [...Array(200).keys()].join('').length, kept: 200 * 199 / 2 }
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { optimize })
    for (const [name, value] of Object.entries(want)) is(m.exports[name](200), value, `O${optimize}: ${name}`)
    const heap = () => m.instance.exports.__heap?.value ?? 0
    const before = heap(); m.exports.temps(200); if (optimize >= 2) is(heap(), before, `O${optimize}: the Map temporaries never accumulate`)
  }
  const wat = compile(src, { wat: true, optimize: 2 })
  ok(/lrw\d/.test(bodyOf(wat, 'temps')), 'the temporary loop carries the rewind marker')
  for (const name of ['carried', 'pushed', 'returned', 'joined', 'kept']) ok(!/lrw\d/.test(bodyOf(wat, name)), `${name}: an iteration whose allocation escapes is not rewound`)
})

test('frame effects: whyNotRewind reports no allocation and the vetoing callee', () => {
  is(whyNot('export function f(x) { return x * 2 }'), 'no allocation')
  // A recursive callee is not inlined, so the census reaches it through the call graph.
  const viaCallee = whyNot('const cache = []; function keep(v) { cache.push(v); return v > 0 ? keep(v - 1) : 0 } export function f(n) { const t = new Array(n).fill(0); keep(t.length); return t.length }')
  is(viaCallee, 'kept on a call that runs an escape: calls keep: grows cache', 'the transitive census names the callee and its reason')
  const every = whyNot('let last = null; function keep(v) { last = [v]; return v > 0 ? keep(v - 1) : 0 } export function f(n) { const t = new Array(n).fill(0); keep(t.length); return t.length }')
  is(every, 'kept on a call that runs an escape: calls keep: outer binding last', 'a callee escaping on every call, called on every call')
})

// --- The tape pass: the unsafe set, imports, kernel taint, tail calls, cycles.

const onTape = (m, fn) => { resetTape(); const root = fromWat(m); fn(root); return toWat(root) }
const src = (n) => JSON.stringify(n)
// What the pass made of `$f`: a restore on the escape flag, a plain restore, or none.
const mode = (s) => /esc_save/.test(s) ? 'flag' : /heap_save/.test(s) ? 'rewind' : 'none'
const alloc = ['call', '$__alloc', ['i32.const', 8]]
// The heap pointer: a module without one has no allocator, and the pass rewinds nothing.
const HEAP = ['global', '$__heap', ['mut', 'i32'], ['i32.const', 1024]]

test('arena rewind on the tape: the unsafe set vetoes a candidate and every caller of an unsafe function', () => {
  const m = ['module', HEAP,
    ['func', '$leak', ['result', 'i32'], alloc],
    ['func', '$f', ['result', 'i32'], ['drop', ['call', '$leak']], alloc],
    ['func', '$g', ['result', 'i32'], alloc],
  ]
  const why = []
  const out = onTape(m, root => arenaRewind(root, { rewindable: new Map([['$leak', 'i32'], ['$f', 'i32'], ['$g', 'i32']]), heapAddr: null, unsafe: new Set(['$leak']), report: (n, r) => why.push(`${n}: ${r}`) }))
  ok(!/heap_save/.test(src(out[3])), 'a caller of an unsafe function does not rewind')
  ok(/heap_save/.test(src(out[4])), 'an unrelated candidate rewinds')
  is(why.join(' | '), '$leak: escape | $f: calls $leak: escape', 'the report names the vetoing callee')
})

test('arena rewind on the tape: an import taking arguments vetoes, an interop import or a bare import does not', () => {
  const m = (callee, args) => ['module', HEAP,
    ['import', '"env"', '"x"', ['func', callee, ['param', 'f64'], ['result', 'f64']]],
    ['import', '"env"', '"now"', ['func', '$__now', ['result', 'f64']]],
    ['func', '$f', ['result', 'i32'], ['drop', ['call', callee, ...args]], ['drop', ['call', '$__now']], alloc],
  ]
  const run = (callee, args) => /heap_save/.test(src(onTape(m(callee, args), root => arenaRewind(root, { rewindable: new Map([['$f', 'i32']]), heapAddr: null }))))
  ok(!run('$env.x', [['f64.const', 1]]), 'a user import with an argument may keep it')
  ok(!run('$__ext_call', [['f64.const', 1]]), 'a host function jz calls may keep its arguments')
  ok(run('$__ext_prop', [['f64.const', 1]]), 'the interop imports that read hand the host nothing')
  ok(run('$env.x', []), 'an import without arguments receives nothing')
})

test('arena rewind on the tape: a kernel storing through a module-wide table vetoes, one storing into its own allocation or its parameter does not', () => {
  const m = (kernel) => ['module',
    ['global', '$__tab', ['mut', 'i32'], ['i32.const', 0]],
    ['global', '$__fc0', 'f64', ['f64.const', 1.5]],
    ['global', '$__heap', ['mut', 'i32'], ['i32.const', 1024]],
    ['func', '$__k', ['param', '$p', 'i32'], ['result', 'i32'], ['local', '$t', 'i32'], ...kernel],
    ['func', '$f', ['result', 'i32'], ['drop', ['call', '$__k', ['i32.const', 0]]], alloc],
  ]
  const run = (kernel) => /heap_save/.test(src(onTape(m(kernel), root => arenaRewind(root, { rewindable: new Map([['$f', 'i32']]), heapAddr: null }))))
  ok(!run([['i32.store', ['global.get', '$__tab'], ['local.get', '$p']], ['i32.const', 0]]), 'a store through a global table')
  ok(!run([['local.set', '$t', ['i32.load', ['global.get', '$__tab']]], ['i32.store', ['local.get', '$t'], ['local.get', '$p']], ['i32.const', 0]]), 'a store through a local a table reached')
  ok(run([['i32.store', ['local.get', '$p'], ['i32.const', 1]], ['i32.const', 0]]), 'a store through the parameter is the caller\'s business')
  ok(run([['local.set', '$t', alloc], ['i32.store', ['local.get', '$t'], ['i32.const', 1]], ['local.get', '$t']]), 'a store into its own allocation is fresh memory')
  ok(run([['local.set', '$t', ['i32.trunc_f64_s', ['global.get', '$__fc0']]], ['i32.store', ['local.get', '$t'], ['i32.const', 1]], ['i32.const', 0]]), 'an immutable global is a constant, not a table')
  ok(run([['local.set', '$t', ['global.get', '$__heap']], ['i32.store', ['local.get', '$t'], ['i32.const', 1]], ['global.set', '$__heap', ['i32.add', ['local.get', '$t'], ['i32.const', 8]]], ['local.get', '$t']]), 'a bump at the heap pointer is an allocation')
})

test('arena rewind on the tape: an escape in a branch of user code raises the flag, one on every call vetoes, a kernel\'s rare path alone keeps the frame', () => {
  const m = (body) => ['module', HEAP,
    ['import', '"env"', '"x"', ['func', '$env.x', ['param', 'f64'], ['result', 'f64']]],
    ['import', '"env"', '"print"', ['func', '$__print', ['param', 'f64'], ['result', 'f64']]],
    ['global', '$__tab', ['mut', 'i32'], ['i32.const', 0]],
    ['func', '$__k', ['param', '$p', 'i32'], ['result', 'i32'], ['if', ['local.get', '$p'], ['then', ['global.set', '$__tab', ['local.get', '$p']]]], ['i32.const', 0]],
    ['func', '$f', ['param', '$c', 'i32'], ['result', 'i32'], body, alloc],
  ]
  const call = (callee) => ['drop', ['call', callee, callee === '$__k' ? ['local.get', '$c'] : ['f64.const', 1]]]
  const branch = (x) => ['if', ['local.get', '$c'], ['then', x]]
  const run = (body, opts = {}) => mode(src(onTape(m(body), root => arenaRewind(root, { rewindable: new Map([['$f', 'i32']]), heapAddr: null, censused: new Set(['$f']), ...opts }))))
  is(run(branch(call('$env.x'))), 'flag', 'a user import called in a branch raises the flag where it runs')
  is(run(['block', branch(['return', ['i32.const', 0]]), call('$env.x')]), 'flag', 'past a return it may not run either')
  is(run(call('$env.x')), 'none', 'one called on every call keeps the frame')
  // a branch leaves the instruction it stands in only for a label outside it
  const loop = (label) => ['block', '$out', ['loop', '$l', ['br_if', label, ['local.get', '$c']]]]
  is(run(['block', loop('$l'), call('$env.x')]), 'none', 'past a loop branching to its own head it runs on every call')
  is(run(['block', '$far', loop('$far'), call('$env.x')]), 'flag', 'past a branch out of the block around both it may not run')
  // a label by depth: 0 the loop, 1 the block around it, 2 the block around both
  is(run(['block', loop(1), call('$env.x')]), 'none', 'a depth inside the instruction stays in it')
  is(run(['block', loop(2), call('$env.x')]), 'flag', 'a depth past it leaves')
  is(run(['block', '$far', ['block', '$near', ['br_table', '$near', '$far', ['local.get', '$c']]], call('$env.x')]), 'flag', 'a table with one label outside leaves')
  is(run(['block', ['block', '$near', ['br_table', '$near', '$near', ['local.get', '$c']]], call('$env.x')]), 'none', 'a table of labels inside stays')
  is(run(call('$__print'), { keepsNothing: new Set(['$__print']) }), 'rewind', 'a runtime import that keeps nothing it is handed is no escape')
  is(run(call('$__k')), 'none', 'a kernel escaping on a rare path: an inner frame keeps, and no call pays the protocol')
  is(run(call('$__k'), { conditional: new Map([['$f', 'outer binding x']]) }), 'flag', 'a frame with a site of its own restores by the flag the kernel lowers')
  is(run(call('$__k'), { exported: new Set(['$f']) }), 'flag', 'so does a frame the host calls')
  // the raise is a statement of its own: a pass rewriting the store reads its one operand
  const store = src(onTape(m(branch(['global.set', '$__tab', ['local.get', '$c']])), root => arenaRewind(root, { rewindable: new Map([['$f', 'i32']]), heapAddr: null, censused: new Set(['$f']) })))
  ok(store.includes('["global.set","$__esc",["i32.const",0]],["global.set","$__tab",["local.get","$c"]]'), 'the flag rises before the store: ' + store.slice(store.indexOf('"then"'), store.indexOf('"then"') + 120))
})

test('arena rewind on the tape: a check no frame reads goes, what it kept staying where later code reads it', () => {
  // A growth site as emit/dispatch.js leaves it: the receiver and the heap's top kept, the store, the check.
  const site = (hold, mark) => [
    ['local.set', hold, ['local.get', '$x']],
    ['local.set', mark, ['global.get', '$__heap']],
    ['f64.store', ['i32.const', 64], ['local.get', '$x']],
    ['if', ['i32.ne', ['global.get', '$__heap'], ['local.get', mark]], ['then', ['call', '$__esc_val', ['local.get', hold]]]]]
  const m = (tail) => ['module',
    ['global', '$__esc', ['mut', 'i32'], ['i32.const', -1]],
    ['global', '$__heap', ['mut', 'i32'], ['i32.const', 1024]],
    ['func', '$__esc_val', ['param', '$v', 'f64'], ['global.set', '$__esc', ['i32.wrap_i64', ['i64.reinterpret_f64', ['local.get', '$v']]]]],
    ['func', '$__ptr_type', ['param', '$p', 'i64'], ['result', 'i32'], ['i32.wrap_i64', ['i64.shr_u', ['local.get', '$p'], ['i64.const', 47]]]],
    ['func', '$g', ['param', '$x', 'f64'], ['result', 'f64'], ['local', '$\uE000esch0', 'f64'], ['local', '$\uE000esch1', 'i32'], ['local', '$pt', 'i32'],
      ...site('$\uE000esch0', '$\uE000esch1'),
      // a test that sets a local later code reads, as optimize/cse-address.js shares a receiver's type
      ['if', ['i32.ne', ['local.tee', '$pt', ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', '$x']]]], ['i32.const', 3]], ['then', ['global.set', '$__esc', ['i32.const', 0]]]],
      ['drop', ['local.get', '$pt']],
      tail],
  ]
  const run = (tail) => src(onTape(m(tail), root => arenaRewind(root, { rewindable: new Map(), heapAddr: null }))[5])
  const gone = run(['local.get', '$x'])
  ok(!/"\$__esc/.test(gone) && !/esch/.test(gone.replace(/\["local","[^"]*","\w+"\],?/g, '')), 'the check, the lowering and what they kept are gone: ' + gone)
  ok(/"f64.store"/.test(gone), 'the store stays')
  ok(/"local.tee","\$pt"/.test(gone), 'the test that sets $pt stays, dropped')
  // a pass before this one read the receiver once into the site's local: its write stays
  const read = run(['local.get', '$\uE000esch0'])
  ok(/"local.set","\$\uE000esch0"/.test(read) && !/"\$__esc/.test(read), 'the local later code reads keeps its write: ' + read)
})

test('arena rewind on the tape: a lowering stays only where a frame or the host reads the flag', () => {
  // `$f` runs an escape in a branch and allocates nothing: no frame of the module restores by the flag.
  const m = (body) => ['module', HEAP,
    ['global', '$__esc', ['mut', 'i32'], ['i32.const', -1]],
    ['global', '$__tab', ['mut', 'i32'], ['i32.const', 0]],
    ['func', '$f', ['param', '$c', 'i32'], ['result', 'i32'],
      ['if', ['local.get', '$c'], ['then', ['global.set', '$__esc', ['i32.const', 0]], ['global.set', '$__tab', ['local.get', '$c']]]], ...body],
  ]
  const run = (body, opts = {}) => src(onTape(m(body), root => arenaRewind(root, { rewindable: new Map([['$f', 'i32']]), heapAddr: null, censused: new Set(['$f']), userGlobals: new Set(['__tab']),
    conditional: new Map([['$f', 'outer binding tab']]), ...opts }))[4])
  ok(!/"\$__esc"/.test(run([['i32.const', 0]])), 'a frame that allocates nothing restores nothing: the lowering goes')
  ok(/"global.set","\$__esc",\["i32.const",0\]/.test(run([alloc])), 'a frame that restores by the flag keeps it')
  ok(/"global.set","\$__esc",\["i32.const",0\]/.test(run([['i32.const', 0]], { exportInner: new Map([['f', '$f']]) })), 'so does a function whose calls the host releases')
})

test('arena rewind on the tape: the log made at start goes where no frame walks from it', () => {
  const m = (body) => ['module', HEAP,
    ['global', '$__esc', ['mut', 'i32'], ['i32.const', -1]], ['global', '$__base', ['mut', 'i32'], ['i32.const', -1]],
    ['global', '$__roots', ['mut', 'i32'], ['i32.const', 0]], ['global', '$__rootn', ['mut', 'i32'], ['i32.const', 0]],
    ['global', '$__tab', ['mut', 'i32'], ['i32.const', 0]],
    ['func', '$__survive', ['param', '$mark', 'i32'], ['result', 'i32'], ['global.get', '$__heap']],
    ['func', '$__root_reset', ['global.set', '$__rootn', ['i32.const', 0]]],
    ['func', '$__start', ['global.set', '$__roots', ['call', '$__alloc', ['i32.const', 2048]]], ['global.set', '$__tab', ['i32.const', 1]]],
    ['func', '$f', ['param', '$c', 'i32'], ['result', 'i32'],
      ['if', ['local.get', '$c'], ['then', ['global.set', '$__esc', ['i32.const', 0]], ['global.set', '$__tab', ['local.get', '$c']]]], ...body],
  ]
  const run = (body) => { const out = onTape(m(body), root => arenaRewind(root, { rewindable: new Map([['$f', 'i32']]), heapAddr: null, censused: new Set(['$f']), userGlobals: new Set(['__tab']),
    conditional: new Map([['$f', 'outer binding tab']]) })); return [src(out.find(n => n[1] === '$__start')), src(out.find(n => n[1] === '$f'))] }
  const [kept, walked] = run([alloc])
  ok(/"global.set","\$__roots"/.test(kept) && /"call","\$__survive"/.test(walked), 'a frame that walks keeps the log')
  const [gone] = run([['i32.const', 0]])
  ok(!/\$__roots/.test(gone) && /"global.set","\$__tab"/.test(gone), 'with no frame to walk the allocation goes, and the start keeps the rest')
})

test('arena rewind on the tape: a mark moved past an operand goes with the check no frame reads', () => {
  // A growth site as emit/dispatch.js leaves it around an operand that allocates.
  const mark = '$\uE000esch0', body = [
    ['local.set', mark, ['global.get', '$__heap']],
    ['f64.store', ['i32.const', 64], ['block', ['result', 'f64'],
      ['if', ['i32.ne', ['global.get', '$__heap'], ['local.get', mark]], ['then', ['local.set', mark, ['i32.const', -1]]]],
      ['local.set', '$\uE000escv0', ['local.get', '$x']],
      ['if', ['i32.ne', ['local.get', mark], ['i32.const', -1]], ['then', ['local.set', mark, ['global.get', '$__heap']]]],
      ['local.get', '$\uE000escv0']]],
    ['if', ['i32.ne', ['global.get', '$__heap'], ['local.get', mark]], ['then', ['global.set', '$__esc', ['i32.const', 0]]]]]
  const m = ['module',
    ['global', '$__esc', ['mut', 'i32'], ['i32.const', -1]],
    ['global', '$__heap', ['mut', 'i32'], ['i32.const', 1024]],
    ['func', '$g', ['param', '$x', 'f64'], ['result', 'f64'], ['local', mark, 'i32'], ['local', '$\uE000escv0', 'f64'], ...body, ['local.get', '$x']]]
  const out = src(onTape(m, root => arenaRewind(root, { rewindable: new Map(), heapAddr: null }))[3])
  ok(!/"\$__esc"|"\$__heap"/.test(out) && !/"local.(set|get)","\$\uE000esch0"/.test(out), 'the mark, its moves and the check are gone: ' + out)
  ok(/"f64.store"/.test(out) && /"local.set","\$\uE000escv0"/.test(out), 'the store and its value stay')
})

test('arena rewind on the tape: a tail call becomes a plain call inside the rewind, unless its callee may run the function again', () => {
  const m = (callee, body = ['local.get', '$p']) => ['module', HEAP,
    ['func', '$__len', ['param', '$p', 'i32'], ['result', 'i32'], ['local.get', '$p']],
    ['func', '$user', ['param', '$p', 'i32'], ['result', 'i32'], body],
    ['func', '$f', ['result', 'i32'], ['drop', alloc], ['return_call', callee, ['i32.const', 3]]],
  ]
  const run = (...a) => { const why = []; return [src(onTape(m(...a), root => arenaRewind(root, { rewindable: new Map([['$f', 'i32']]), heapAddr: null, report: (n, r) => why.push(`${n}: ${r}`) }))[4]), why.join(' | ')] }
  for (const callee of ['$__len', '$user']) {
    const [f] = run(callee)
    ok(/heap_save/.test(f) && !/return_call/.test(f) && f.includes(`"call","${callee}"`), `${callee}: the tail call is a plain call under the restore`)
  }
  // a recursion written as tail calls counts on the frame the call elides
  for (const [what, body] of [['by a call', ['call', '$f']], ['by a tail call', ['return_call', '$f']]]) {
    const [f, why] = run('$user', body)
    ok(!/heap_save/.test(f) && /return_call/.test(f), `a callee that runs the function again ${what} keeps the tail call`)
    is(why, '$f: return_call', 'and the function keeps its heap, by name')
  }
  const self = src(onTape(['module', HEAP, ['func', '$f', ['param', '$n', 'i32'], ['result', 'i32'], ['drop', alloc], ['return_call', '$f', ['local.get', '$n']]]],
    root => arenaRewind(root, { rewindable: new Map([['$f', 'i32']]), heapAddr: null }))[2])
  ok(!/heap_save/.test(self) && /return_call/.test(self), 'a function that tail-calls itself as well')
})

test('arena rewind on the tape: a tail call is a call: what its callee lowers or keeps, the frames above it read', () => {
  const m = (call, callee) => ['module', HEAP,
    ['table', '$tbl', 1, 'funcref'], ['type', '$sig', ['func', ['param', 'i32'], ['result', 'i32']]], ['elem', ['i32.const', 0], 'func', '$__k'],
    ['global', '$__tab', ['mut', 'i32'], ['i32.const', 0]],
    ['func', '$__k', ['param', '$p', 'i32'], ['result', 'i32'], ['if', ['local.get', '$p'], ['then', ['global.set', '$__tab', ['local.get', '$p']]]], ['i32.const', 0]],
    ['func', '$leak', ['param', '$p', 'i32'], ['result', 'i32'], alloc],
    ['func', '$mid', ['param', '$p', 'i32'], ['result', 'i32'],
      call.endsWith('indirect') ? [call, '$tbl', ['type', '$sig'], ['local.get', '$p'], ['i32.const', 0]] : [call, callee, ['local.get', '$p']]],
    ['func', '$f', ['param', '$c', 'i32'], ['result', 'i32'], ['drop', ['call', '$mid', ['local.get', '$c']]], alloc],
  ]
  const run = (call, callee, opts = {}) => {
    const why = []
    const out = src(onTape(m(call, callee), root => arenaRewind(root, { rewindable: new Map([['$f', 'i32']]), heapAddr: null, exported: new Set(['$f']), report: (n, r) => why.push(`${n}: ${r}`), ...opts })).at(-1))
    return `${mode(out)}: ${why.join(' | ')}`
  }
  is(run('call', '$__k'), 'flag: $f: kept on a call that runs an escape: calls $mid: calls $__k: global.set $__tab', 'the frame above restores by the flag the kernel lowers')
  is(run('return_call', '$__k'), run('call', '$__k'), 'reached by a tail call as well')
  is(run('call_indirect'), run('call', '$__k'), 'through the table')
  is(run('return_call_indirect'), run('call_indirect'), 'and by a tail call through it')
  const unsafe = { unsafe: new Set(['$leak']) }
  is(run('call', '$leak', unsafe), 'none: $f: calls $mid: calls $leak: escape', 'a callee that keeps on every call keeps every caller')
  is(run('return_call', '$leak', unsafe), run('call', '$leak', unsafe), 'reached by a tail call as well')
})

test('frame effects: what a callee reached by a tail call stored into a module binding survives the frames above it', () => {
  // `f` leaves by a tail call of `g`; `g` makes the module's array on its first call.
  const src = `let keep = null
    function g(n, k) {
      if (!keep) keep = new Float64Array(n)
      const out = new Float64Array(n)
      for (let i = 0; i < keep.length; i++) { keep[i] += i * k; out[i] = keep[i] * 2 }
      for (let i = 0; i < out.length; i++) out[i] += Math.sqrt(Math.abs(keep[i]))
      return out
    }
    function f(n) { return g(n, 1) }
    export let h = (n) => g(n, 2)[1]
    export let go = (n) => { const tmp = new Float64Array(16); tmp.fill(n + 1); const r = f(n); return r[3] + tmp[1] + keep.length * 1000 + keep[2] }`
  for (const optimize of [...levels(0, 2, 3), 'size']) {
    const m = jz(src, { optimize }).exports, js = oracle(src)
    for (let i = 0; i < 4; i++) is(m.go(40), js.go(40), `${optimize}, call ${i}: the array the first call made holds what every call added`)
    is(m.h(40), js.h(40), `${optimize}: and by a call of its own`)
  }
})

test('arena rewind on the tape: a tail call is a call: what its callee lowers or keeps, the frames above it read', () => {
  const m = (call, callee) => ['module', HEAP,
    ['table', '$tbl', 1, 'funcref'], ['type', '$sig', ['func', ['param', 'i32'], ['result', 'i32']]], ['elem', ['i32.const', 0], 'func', '$__k'],
    ['global', '$__tab', ['mut', 'i32'], ['i32.const', 0]],
    ['func', '$__k', ['param', '$p', 'i32'], ['result', 'i32'], ['if', ['local.get', '$p'], ['then', ['global.set', '$__tab', ['local.get', '$p']]]], ['i32.const', 0]],
    ['func', '$leak', ['param', '$p', 'i32'], ['result', 'i32'], alloc],
    ['func', '$mid', ['param', '$p', 'i32'], ['result', 'i32'],
      call.endsWith('indirect') ? [call, '$tbl', ['type', '$sig'], ['local.get', '$p'], ['i32.const', 0]] : [call, callee, ['local.get', '$p']]],
    ['func', '$f', ['param', '$c', 'i32'], ['result', 'i32'], ['drop', ['call', '$mid', ['local.get', '$c']]], alloc],
  ]
  const run = (call, callee, opts = {}) => {
    const why = []
    const out = src(onTape(m(call, callee), root => arenaRewind(root, { rewindable: new Map([['$f', 'i32']]), heapAddr: null, exported: new Set(['$f']), report: (n, r) => why.push(`${n}: ${r}`), ...opts })).at(-1))
    return `${mode(out)}: ${why.join(' | ')}`
  }
  is(run('call', '$__k'), 'flag: $f: kept on a call that runs an escape: calls $mid: calls $__k: global.set $__tab', 'the frame above restores by the flag the kernel lowers')
  is(run('return_call', '$__k'), run('call', '$__k'), 'reached by a tail call as well')
  is(run('call_indirect'), run('call', '$__k'), 'through the table')
  is(run('return_call_indirect'), run('call_indirect'), 'and by a tail call through it')
  const unsafe = { unsafe: new Set(['$leak']) }
  is(run('call', '$leak', unsafe), 'none: $f: calls $mid: calls $leak: escape', 'a callee that keeps on every call keeps every caller')
  is(run('return_call', '$leak', unsafe), run('call', '$leak', unsafe), 'reached by a tail call as well')
})

test('frame effects: what a callee reached by a tail call stored into a module binding survives the frames above it', () => {
  // `f` leaves by a tail call of `g`; `g` makes the module's array on its first call.
  const src = `let keep = null
    function g(n, k) {
      if (!keep) keep = new Float64Array(n)
      const out = new Float64Array(n)
      for (let i = 0; i < keep.length; i++) { keep[i] += i * k; out[i] = keep[i] * 2 }
      for (let i = 0; i < out.length; i++) out[i] += Math.sqrt(Math.abs(keep[i]))
      return out
    }
    function f(n) { return g(n, 1) }
    export let h = (n) => g(n, 2)[1]
    export let go = (n) => { const tmp = new Float64Array(16); tmp.fill(n + 1); const r = f(n); return r[3] + tmp[1] + keep.length * 1000 + keep[2] }`
  for (const optimize of [...levels(0, 2, 3), 'size']) {
    const m = jz(src, { optimize }).exports, js = oracle(src)
    for (let i = 0; i < 4; i++) is(m.go(40), js.go(40), `${optimize}, call ${i}: the array the first call made holds what every call added`)
    is(m.h(40), js.h(40), `${optimize}: and by a call of its own`)
  }
})

test('arena rewind on the tape: a frame whose result may be a heap value restores unless the result is of its making', () => {
  const made = ['func', '$__made', ['param', '$v', 'f64'], ['param', '$mark', 'i32'], ['result', 'i32'], ['i32.const', 0]]
  const m = (kernel, type, value) => ['module', HEAP,
    ['global', '$__esc', ['mut', 'i32'], ['i32.const', -1]], ['global', '$__base', ['mut', 'i32'], ['i32.const', -1]],
    ['global', '$__tab', ['mut', 'i32'], ['i32.const', 0]],
    ...(kernel ? [made] : []),
    ['func', '$f', ['param', '$c', 'i32'], ['result', type],
      ['if', ['local.get', '$c'], ['then', ['global.set', '$__esc', ['i32.const', 0]], ['global.set', '$__tab', ['local.get', '$c']]]], ['drop', alloc], value],
  ]
  const run = (kernel, type, value, opts = {}) => { const why = []; return [src(onTape(m(kernel, type, value), root => arenaRewind(root, { rewindable: new Map([['$f', type]]), asked: new Set(['$f']), heapAddr: null,
    censused: new Set(['$f']), userGlobals: new Set(['__tab']), report: (n, r) => why.push(`${n}: ${r}`), ...opts })).at(-1)), why.join(' | ')] }
  const [boxed] = run(true, 'f64', ['f64.const', 1])
  ok(/\["if",\["call","\$__made",\["local.get","\$[^"]*arena_ret0"\],\["local.get","\$[^"]*heap_save0"\]\],\["then"\],\["else",/.test(boxed), 'a tagged result is asked by the kernel, and the heap goes back in the other arm: ' + boxed.slice(0, 300))
  const [address] = run(false, 'i32', ['i32.const', 8])
  ok(/\["if",\["i32.ge_u",\["local.get","\$[^"]*arena_ret0"\],\["local.get","\$[^"]*heap_save0"\]\],\["then"\],\["else",/.test(address), 'an address is asked as it is')
  const [cond] = run(true, 'f64', ['f64.const', 1], { conditional: new Map([['$f', 'outer binding tab']]) })
  ok(/"\$__made"/.test(cond) && /esc_save/.test(cond), 'a frame that restores by the flag asks its result first')
  ok(cond.indexOf('"$__made"') < cond.lastIndexOf('"global.set","$__base"'), 'and puts the flag and the mark back whatever the result')
  const [none, why] = run(false, 'f64', ['f64.const', 1])
  ok(!/heap_save/.test(none), 'with no kernel to ask a tagged result the frame keeps its heap')
  is(why, '$f: result: may hold a heap value', 'by name')
})

test('arena rewind on the tape: mutually recursive clean kernels are safe callees, and allocation counts through them', () => {
  const m = ['module', HEAP,
    ['func', '$__a', ['param', '$n', 'i32'], ['result', 'i32'], ['if', ['result', 'i32'], ['local.get', '$n'], ['then', ['call', '$__b', ['i32.sub', ['local.get', '$n'], ['i32.const', 1]]]], ['else', alloc]]],
    ['func', '$__b', ['param', '$n', 'i32'], ['result', 'i32'], ['call', '$__a', ['local.get', '$n']]],
    ['func', '$f', ['result', 'i32'], ['call', '$__b', ['i32.const', 3]]],
  ]
  const f = src(onTape(m, root => arenaRewind(root, { rewindable: new Map([['$f', 'i32']]), heapAddr: null }))[4])
  ok(/heap_save/.test(f), 'a cycle with no unsafe member is safe, and the allocation inside it makes the caller rewind')
})

// --- Load CSE across a call to a function that writes no outer storage.

test('frame effects: a cached typed-array load survives a call to a read-only callee and not a writing one', () => {
  if (onKernel()) return
  const mk = (callee) => `const a = new Float64Array(8)
    const buf = new Float64Array(4)
    function g(k) { return k <= 0 ? 0 : a[k & 7] + g(k - 1) }
    function h(k) { buf[0] = a[1]; a[0] = k + 1; return k <= 0 ? 0 : h(k - 1) }
    export function f(i, k) { const x = a[i]; const y = ${callee}(k); const z = a[i]; return x + y + z }`
  const loads = (callee) => (bodyOf(compile(mk(callee), { wat: true, ...TAPE }), 'f').match(/f64\.load/g) || []).length
  is(loads('g'), 1, 'the second a[i] reuses the first across the read-only call')
  is(loads('h'), 2, 'a callee that writes a typed array forces a reload')
  const m = jz(mk('h'))
  is(m.exports.f(0, 2), 0 + 0 + 1, 'the reloaded value is the written one')
})

test('frame effects: a cached load survives a callback that stores nothing and not one that may store', () => {
  if (onKernel()) return
  const mk = (body) => `const a = new Float64Array(8)
    const cbs = [(v) => { a[0] = v + 1; return v }]
    function h(k) { ${body}; return k <= 0 ? 0 : h(k - 1) }
    export function f(i, k) { const x = a[i]; const y = h(k); const z = a[i]; return x + y + z }`
  const loads = (src) => (bodyOf(compile(src, { wat: true, ...TAPE }), 'f').match(/f64\.load/g) || []).length
  const swap = 'let cb = (v) => v; const swap = () => { cb = (v) => { a[0] = v + 1; return v } }; swap()'
  is(loads(mk('Array.from([k], (v) => v + 1)')), 1, 'a map function that stores nothing keeps the load')
  for (const [what, body] of [
    // taken for a builtin that reads its arguments only
    ['an Array.from map function', 'Array.from([k], (v) => { a[0] = v + 1; return v })'],
    ['a map function the census cannot see', 'Array.from([k], cbs[0])'],
    // the census walked the arrow `cb` is declared with, not the one swap stores
    ['a rebound callback', swap + '; [k].forEach(cb)'],
    ['a rebound call', swap + '; cb(k)'],
  ]) {
    const src = mk(body)
    is(loads(src), 2, `${what}: the second a[i] reloads`)
    for (const optimize of levels(0, 2, 3)) is(jz(src, { optimize }).exports.f(0, 2), oracle(src).f(0, 2), `${what} O${optimize}`)
  }
})

// The census names what a member reaches instead of declaring it unknown: an
// accessor-named read on a kind that is no object is the array's own, a
// method on a receiver that may be nullish reaches the class's function (the
// read throws for null before any call), a constructor called plainly is
// fresh storage, a choice between fresh values is fresh. Each function here
// rewinds; before, every one was declined.
test('frame effects: members resolve through the receiver, and fresh values through a choice', () => {
  if (onKernel()) return
  const length = `class Buf { #n; constructor(n) { this.#n = n } get length() { return this.#n } }
    export let mk = (n) => new Buf(n)
    export function f(n) { const xs = [n | 0, 2, 3]; let s = 0; for (let i = 0; i < xs.length; i++) { const o = { v: xs[i] }; s += o.v } return s }`
  ok(rewinds(length), 'an array\'s length reads plainly beside a class getter of that name: ' + whyNot(length))
  is(jz(length, { optimize: 'speed' }).exports.f(1), 6)
  const nullish = `class A { w(x) { return x + 1 } }
    let make = (k) => k ? new A() : null
    export function f(k) { const o = make(k); const r = { v: o.w(k | 0) }; return r.v }`
  ok(rewinds(nullish), 'a method of a receiver that may be nullish is a callee: ' + whyNot(nullish))
  const m = jz(nullish, { optimize: 'speed' })
  is(m.exports.f(1), 2)
  let threw = null
  try { m.exports.f(0) } catch (e) { threw = e }
  ok(threw instanceof TypeError, 'the nullish receiver throws')
  const thrown = `export function f(x) { if (x < 0) throw TypeError('negative'); const o = { v: x | 0 }; return o.v }`
  ok(rewinds(thrown), 'a constructor called plainly is fresh storage: ' + whyNot(thrown))
  const choice = `export function f(c) { const r = c ? [1, 2] : [3]; r.push(4); return r.length + r[0] }`
  ok(rewinds(choice), 'a choice between fresh literals is a fresh local: ' + whyNot(choice))
  is(jz(choice, { optimize: 'speed' }).exports.f(0), 5)
})

// An object literal's getter is a closure in a declared slot: reading the
// name through a receiver of that layout runs it, and what it stores
// outward escapes the frame.
test('frame effects: a literal\'s getter is code the census cannot name', () => {
  if (onKernel()) return
  const src = `let keep = null
    const src = [{ get x() { keep = { v: 1 }; return 1 } }, { x: 2 }]
    export function f(i) { const o = src[i]; const r = { v: o.x }; return r.v }
    export function g() { const z = { v: 9 }; return keep.v + z.v }`
  ok(flagged(src), 'the frame restores by the flag the getter lowers: ' + whyNot(src))
  const m = jz(src, { optimize: 'speed' })
  is(m.exports.f(0), 1); is(m.exports.f(1), 2)
  is(m.exports.g(), 10, 'the getter\'s store survives the call')
  const used = m.memory.used
  for (let i = 0; i < 100; i++) m.exports.f(1)
  is(m.memory.used, used, 'a call that runs no getter keeps nothing')
})

// A static pair lives on the class value: reading its name through the
// class runs the getter, and what it stores outward escapes the frame.
test('frame effects: a static getter on a class value is code the census cannot name', () => {
  if (onKernel()) return
  const src = `let keep = null
    class K { static get tag() { keep = { v: 1 }; return 42 } }
    export function f() { const r = { v: K.tag }; return r.v }
    export function g() { const z = { v: 9 }; return keep.v + z.v }`
  ok(flagged(src), 'the frame restores by the flag: ' + whyNot(src))
  const m = jz(src, { optimize: 'speed' })
  is(m.exports.f(), 42)
  is(m.exports.g(), 10, 'the getter\'s store survives the call')
})

// An optional call runs its callee when present: the census and load CSE saw
// no call there, so a typed element cached before `o.f?.()` or `h?.(buf)` read
// the value from before the callee's store.
test('frame effects: an optional call is a call', () => {
  const src = (between) => `const g = (buf, o, h) => { const a = buf[0]; ${between}; const b = buf[0]; return a * 100 + b }
const via = (o, h, buf) => { o.f?.(); return h?.(buf) }
export const entry = () => { const buf = new Float64Array(2); buf[0] = 1; const o = { f: () => { buf[0] = 7; return 1 } }; return g(buf, o, (b) => { b[0] = 8; return 1 }) }`
  for (const between of ['const v = o.f?.()', 'const v = h?.(buf)', 'const v = o?.f?.()', 'const v = via(o, h, buf)'])
    for (const optimize of levels(0, 2, 3)) is(jz(src(between), { optimize }).exports.entry(), oracle(src(between)).entry(), `${between} O${optimize}`)
})
