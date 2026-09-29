// A call releases what it did not keep. The frame census (compile/analyze/
// frame-effects.js) proves a function keeps nothing it allocates or is handed;
// such a frame restores the heap pointer at return (optimize/arena-rewind.js),
// and the host rewinds the argument copies it made for the call (`jz:release`,
// interop.js). Void results, writes to numeric module bindings and calls
// through a binding the summary resolves to closures stay inside that proof;
// whatever a call may keep keeps the memory it lives in. `memory.used` reads
// the heap above the mark `memory.reset()` returns to.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { levels, onWasi } from './_matrix.js'
import { oracle } from './util.js'

const CALLS = 2000
// Heap growth over CALLS calls of `call`, after one call to settle first-call state.
const growth = (memory, call) => { call(); const u0 = memory.used; for (let i = 0; i < CALLS; i++) call(); return memory.used - u0 }

test('call release: memory.used reads the heap the calls and the host keep', () => {
  const { exports, memory } = jz(`let kept = []
    export let keep = (n) => { kept.push(new Float64Array(n)); return kept.length }`)
  is(memory.used, 0, 'nothing kept at the start')
  exports.keep(16)
  ok(memory.used >= 16 * 8, 'a kept array counts')
  memory.Float32Array(new Float32Array(64))
  ok(memory.used >= 16 * 8 + 64 * 4, 'a buffer the host made counts')
  memory.reset()
  is(memory.used, 0, 'a reset returns it to 0')
})

for (const optimize of levels(2, 3, 'size'))
  test(`call release: a call that keeps nothing leaves the heap as it found it at ${optimize}`, () => {
    const src = `
      let elapsed = 0
      export let scale = (buf, g) => { const t = new Float32Array(buf.length); for (let i = 0; i < buf.length; i++) t[i] = buf[i] * g; buf.set(t); return buf.length }
      export let label = (s) => (s + '!').length
      export function tick(n) { const t = [n, n + 1]; elapsed += t[0] + t[1] }
      export let clock = () => elapsed
      const factory = () => (b, n) => { const t = new Float64Array(n); for (let i = 0; i < n; i++) t[i] = b[i] * 0.5; for (let i = 0; i < n; i++) b[i] = t[i] }
      const block = new Float64Array(64).fill(2)
      let proc = (b, n) => {}
      export let start = () => { proc = factory() }
      export function run(n) { proc(block, n); elapsed += n }
      export let first = () => block[0]`
    const { exports, memory } = jz(src, { optimize })
    const buf = new Float32Array(256).fill(1)
    is(growth(memory, () => exports.scale(buf, 1)), 0, `host Float32Array block at ${optimize}`)
    is(growth(memory, () => exports.label('abc')), 0, `host string at ${optimize}`)
    is(growth(memory, () => exports.tick(3)), 0, `void result, numeric module binding at ${optimize}`)
    is(exports.clock(), 7 * (CALLS + 1), `the binding kept its value at ${optimize}`)
    exports.start()
    is(growth(memory, () => exports.run(64)), 0, `a call through a resolved closure binding at ${optimize}`)
    is(exports.first(), 2 / 2 ** (CALLS + 1), `the closure's writes stayed at ${optimize}`)
  })

for (const optimize of levels(0, 2, 3, 'size'))
  test(`call release: what a call keeps stays alive and correct at ${optimize}`, () => {
    const src = `
      let hist = [], last = null, cache = null
      export let record = (buf) => { hist.push(buf[0]); last = buf; return hist.length }
      export let lastFirst = () => last[0]
      export let histSum = () => { let s = 0; for (let i = 0; i < hist.length; i++) s += hist[i]; return s }
      export let lazy = (n) => { if (cache === null) cache = new Float64Array(n); cache[0] += 1; return cache[0] }
      const make = () => { let state = null; return (x) => { if (state === null) state = [0]; state[0] += x; return state[0] } }
      let acc = (x) => 0
      export let arm = () => { acc = make() }
      export let add = (x) => acc(x)
      const grab = () => { let kept = []; return (x) => { kept.push([x]); return kept.length } }
      let g = (x) => 0
      export let armGrab = () => { g = grab() }
      export let pushed = (x) => g(x)`
    const want = oracle(src), { exports } = jz(src, { optimize })
    for (let i = 1; i <= 300; i++) {
      const a = Float64Array.of(i, 0), b = Float64Array.of(i, 0)
      is(exports.record(a), want.record(b))
    }
    is(exports.lastFirst(), want.lastFirst(), `the stored argument outlived its call at ${optimize}`)
    is(exports.histSum(), want.histSum(), `a pushed history at ${optimize}`)
    for (let i = 0; i < 300; i++) is(exports.lazy(8), want.lazy(8))
    exports.arm(); want.arm()
    for (let i = 0; i < 300; i++) is(exports.add(i), want.add(i), `closure state made on the first call at ${optimize}`)
    exports.armGrab(); want.armGrab()
    for (let i = 0; i < 300; i++) is(exports.pushed(i), want.pushed(i), `a closure keeping a fresh array per call at ${optimize}`)
  })

test('call release: a call back into the module keeps what the inner call kept', () => {
  if (onWasi()) return  // a host function calls back: the js host's
  // A zero-argument host import calls an export that keeps an array: the call
  // around it must not release what the inner call kept. Today the census counts
  // any import call as unknown, so the outer frame is not released at all; the
  // host's nesting flag (interop.js enter/leave) holds this when it is.
  let inst
  const src = `import { poke } from 'host'
    let kept = []
    export let keep = () => { kept.push([kept.length, 7]); return kept.length }
    export let outer = (buf) => { poke(); return buf.length }
    export let check = () => { let s = 0; for (let i = 0; i < kept.length; i++) s += kept[i][0] * 10 + kept[i][1]; return s }`
  inst = jz(src, { imports: { host: { poke: () => inst.exports.keep() } } })
  let want = 0
  for (let i = 0; i < 200; i++) { inst.exports.outer(new Float64Array(64).fill(i)); want += i * 10 + 7 }
  is(inst.exports.check(), want, 'the arrays the inner calls kept read back intact')
})

for (const optimize of levels(2, 3, 'size'))
  test(`call release: state made on the first call is kept, every later call released at ${optimize}`, () => {
    // An escape that happens at one node raises the escape flag where it runs
    // (compile/analyze/frame-effects.js sites); the frame keeps its heap only
    // on a call that raised it.
    const src = `
      let st = null
      export let smooth = (buf) => { if (!st) st = new Float64Array(2); let z = st[0]; for (let i = 0; i < buf.length; i++) { z = z * 0.9 + buf[i] * 0.1; buf[i] = z } st[0] = z; return buf.length }
      export let state = () => st[0]
      const makeLp = () => { let prev = null; return (b, n) => { if (prev === null) prev = new Float64Array(1); const t = new Float64Array(n); for (let i = 0; i < n; i++) { prev[0] = prev[0] * 0.5 + b[i] * 0.5; t[i] = prev[0] } for (let i = 0; i < n; i++) b[i] = t[i]; return prev[0] } }
      const block = new Float64Array(32).fill(1)
      let lp = (b, n) => 0
      export let arm = () => { lp = makeLp() }
      export function run(n) { return lp(block, n) }
      export let bag = (p, x) => { const s = p.state ??= new Float64Array(2); s[0] = s[0] * 0.5 + x; const t = [s[0] * 1, x * 2]; return t[0] + t[1] }`
    const want = oracle(src), { exports, memory } = jz(src, { optimize })
    const a = new Float64Array(64).fill(0.5), b = new Float64Array(64).fill(0.5)
    is(exports.smooth(a), want.smooth(b))
    is(growth(memory, () => { const x = new Float64Array(64).fill(0.5), y = new Float64Array(64).fill(0.5); is(exports.smooth(x), want.smooth(y)) }), 0, `module state at ${optimize}`)
    is(exports.state(), want.state(), `the state survived its release at ${optimize}`)
    exports.arm(); want.arm()
    is(growth(memory, () => is(exports.run(32), want.run(32))), 0, `closure state at ${optimize}`)
    const p1 = {}, p2 = {}
    is(growth(memory, () => is(exports.bag(p1, 3), want.bag(p2, 3))), 0, `state on the parameter object at ${optimize}`)
  })

for (const optimize of levels(2, 3, 'size'))
  test(`call release: a call that escapes every time keeps every call at ${optimize}`, () => {
    const src = `
      let hist = []
      export let log = (x) => { hist.push([x, x * 2]); const t = [x]; return hist.length + t.length }
      export let sum = () => { let s = 0; for (let i = 0; i < hist.length; i++) s += hist[i][0] + hist[i][1]; return s }
      let last = null
      export let keep = (n) => { const a = new Float64Array(n); a[0] = n; if (n % 3 === 0) last = a; return a[0] }
      export let lastFirst = () => last === null ? -1 : last[0]`
    const want = oracle(src), { exports, memory } = jz(src, { optimize })
    for (let i = 0; i < 200; i++) is(exports.log(i), want.log(i))
    ok(memory.used > 0, 'the history is kept')
    for (let i = 0; i < 200; i++) exports.keep(i % 7 + 3), want.keep(i % 7 + 3)
    for (let i = 0; i < 50; i++) exports.keep(4)   // released calls allocate over nothing kept
    is(exports.sum(), want.sum(), `every pushed record reads back at ${optimize}`)
    is(exports.lastFirst(), want.lastFirst(), `the array kept on an escaping call reads back at ${optimize}`)
  })

for (const optimize of levels(2, 3, 'size'))
  test(`call release: an exception past a frame keeps what escaped before it at ${optimize}`, () => {
    // The frame the throw leaves skips its epilogue; the catch assumes the flag rose.
    const src = `
      let kept = null
      const inner = (n) => { const t = new Float64Array(n); t[0] = n; if (n > 5) throw new RangeError('big'); return t[0] }
      export let outer = (n) => { kept = [n, n + 1]; try { return inner(n) } catch (e) { return -1 } }
      export let churn = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(i); return a.length }
      export let read = () => kept[0] * 10 + kept[1]`
    const want = oracle(src), { exports } = jz(src, { optimize })
    is(exports.outer(9), want.outer(9))
    for (let i = 0; i < 20; i++) exports.churn(64), want.churn(64)
    is(exports.read(), want.read(), `the array stored before the throw is intact at ${optimize}`)
  })

for (const optimize of levels(2, 3, 'size'))
  test(`call release: an escape in a callback or a recursive call keeps its call at ${optimize}`, () => {
    const src = `
      const seen = []
      export let collect = (n) => { const xs = []; for (let i = 0; i < n; i++) xs.push(i); xs.forEach(x => { if (x % 5 === 0) seen.push([x, x * 3]) }); return seen.length }
      export let sum = () => { let s = 0; for (const p of seen) s += p[0] + p[1]; return s }
      let tree = null
      const grow = (d) => { const t = [d, 0]; if (d > 0) grow(d - 1); if (d === 2) tree = t; return t[0] }
      export let deep = (d) => grow(d)
      export let treeHead = () => tree === null ? -1 : tree[0] * 10 + tree[1]`
    const want = oracle(src), { exports } = jz(src, { optimize })
    for (let n = 1; n < 30; n++) { is(exports.collect(n), want.collect(n)); exports.deep(4); want.deep(4) }
    is(exports.sum(), want.sum(), `every record a callback kept reads back at ${optimize}`)
    is(exports.treeHead(), want.treeHead(), `the array a recursive call kept reads back at ${optimize}`)
  })

// A call whose arguments are all numbers leaves the host nothing to marshal
// and, where the frame releases by itself, nothing to release: it crosses as
// it is (interop.js `crossing`), with the general path's results.
for (const optimize of levels(2, 3, 'size'))
  test(`call release: a call of numbers crosses as it is, with the general path's results, at ${optimize}`, () => {
    const src = `const st = new Float64Array(8), cache = { cur: null }
      export let mix = (a, b) => { const t = new Float64Array(16); t[0] = a; t[1] = b; st[0] = t[0] * 2 + t[1]; return st[0] }
      export let none = () => { st[1]++ }
      export let count = () => st[1]
      export let pick = (n) => n > 2 ? 'three and more, a string too long to pack' : n > 1 ? [n, n] : n > 0 ? null : n < 0 ? undefined : NaN
      export let keep = (n) => { if (n > 0) cache.cur = [n, n + 1]; const t = [n, n, n]; return t.length }
      export let kept = () => cache.cur === null ? -1 : cache.cur[1]
      export let fail = (n) => { const t = [n]; if (n < 0) throw new RangeError('below zero: ' + n); return t.length }
      export let churn = (n) => { const a = []; for (let i = 0; i < n; i++) a.push('c' + i + 'yyyyyyyyyyyyyyyy'); return a.length }`
    const want = oracle(src), { exports, memory } = jz(src, { optimize })
    // whatever is handed is a number as JS makes it one
    for (const [a, b] of [[2, 3], ['2', 3], [undefined, 1], [null, 1], [true, '0x10'], [{ valueOf: () => 7 }, [4]], [2], [2, 3, 4]])
      is(exports.mix(a, b), want.mix(a, b), `mix(${String(a)}, ${String(b)})`)
    let named = null
    try { exports.mix(1n, 2) } catch (e) { named = e }
    ok(named instanceof TypeError && /BigInt argument at param 0 of mix\(\)/.test(named.message), 'a BigInt is refused by name: ' + named?.message)
    is(growth(memory, () => exports.mix(1, 2)), 0, `a temporary of the call goes with it at ${optimize}`)
    is(exports.none(), undefined, 'no result'); is(exports.count(), 1)
    // a result that is no number takes the general decoding
    for (const n of [3, 2, 1, 0, -1]) is(exports.pick(n), want.pick(n), `pick(${n})`)
    // a throw is the error the module threw, and leaves no call half entered
    for (let i = 0; i < 3; i++) {
      let thrown = null
      try { exports.fail(-1 - i) } catch (e) { thrown = e }
      ok(thrown instanceof RangeError && thrown.message === 'below zero: ' + (-1 - i), 'the error the module threw: ' + thrown?.message)
      is(exports.fail(i), 1, 'the call after it returns')
    }
    const held = memory.used
    is(growth(memory, () => exports.mix(1, 2)), 0, `calls after a throw release as before at ${optimize}`)
    // what a call stored stays, what it made beside goes
    is(exports.keep(5), 3); is(exports.churn(30), 30); is(exports.kept(), 6, 'the stored pair reads back')
    is(growth(memory, () => exports.keep(0)), 0, `a call that stored nothing keeps nothing at ${optimize}`)
    is(exports.kept(), 6)
    ok(memory.used - held < 4096, `and the one that stored keeps the pair, or the call at the size tier: ${memory.used - held}`)
  })

test('call release: a call of numbers made while another runs tells it what it kept', () => {
  // `keep` crosses as it is when the host calls it, and by the general path
  // from inside `outer`'s call, whose release has to know what it kept.
  let inst
  const src = `import { poke } from 'host'
    let kept = []
    export let keep = (n) => { kept.push([n, 7]); return kept.length }
    export let outer = (buf) => { poke(); return buf.length }
    export let check = () => { let s = 0; for (let i = 0; i < kept.length; i++) s += kept[i][0] * 10 + kept[i][1]; return s }
    export let churn = (n) => { const a = []; for (let i = 0; i < n; i++) a.push('c' + i + 'yyyyyyyyyyyyyyyy'); return a.length }`
  let n = 0
  inst = jz(src, { imports: { host: { poke: () => inst.exports.keep(n) } } })
  let want = 0
  for (n = 0; n < 100; n++) { inst.exports.outer(new Float64Array(64).fill(n)); want += n * 10 + 7; inst.exports.churn(8) }
  for (n = 100; n < 200; n++) { inst.exports.keep(n); want += n * 10 + 7; inst.exports.churn(8) }
  is(inst.exports.check(), want, 'the arrays the calls kept read back intact')
})

// A frame whose result may be a heap value asks it as it returns: one the
// frame did not make (a number, a value older than the call) lets the frame
// give back what it allocated; one it made is the caller's, and the host, which
// takes a copy of a string, an array, an object or a collection, releases it
// then. A typed array is a view of the module's memory: it holds the call's.
// Off at the size tier, with the walk.
for (const optimize of levels(2, 3))
  test(`call release: a call whose result may be a heap value releases unless the result is of its making, at ${optimize}`, () => {
    const src = `const kept = ['a string the module holds, too long to pack', [7, 8, 9]]
      const risky = (n) => { if (n & 1) throw new Error('odd'); return n }
      export const first = (n) => { const a = [n, 3, 1, 2]; a.sort((x, y) => x - y); return a[0] }
      export const caught = (n) => { const t = new Float64Array(64); t[1] = n; try { return risky(n) } catch (e) { return t[1] + 0.5 } }
      export const round = (n) => JSON.parse(JSON.stringify({ a: [n, n + 1], b: 'x' })).a[1]
      export const pair = (n) => { const [a, b] = [n, n + 1]; const { x, y } = { x: a, y: b }; return x + y }
      export const pick = (n) => { const made = ['made ' + n + ' zzzzzzzzzzzzzzzzzzzzzz', [n, n]]; return n % 3 ? made[n % 3 - 1] : kept[n % 2] }
      export const held = (n) => kept[n & 1]
      export const churn = (n) => { const a = []; for (let i = 0; i < n; i++) a.push('c' + i + 'yyyyyyyyyyyyyyyy'); return a.length }`
    const want = oracle(src), { exports, memory } = jz(src, { optimize })
    let n = 0
    for (const name of ['first', 'round', 'pair', 'held', 'pick']) {
      for (let i = 0; i < 12; i++) { is(exports[name](i), want[name](i), `${name}(${i})`); exports.churn(6) }
      n = 0
      is(growth(memory, () => exports[name](n++)), 0, `${name} keeps nothing at ${optimize}`)
    }
    // a catch that ran keeps nothing by itself: the frames the exception left stored nothing
    for (let i = 0; i < 12; i++) { is(exports.caught(i), want.caught(i), `caught(${i})`); exports.churn(6) }
    n = 0
    is(growth(memory, () => exports.caught(n++)), 0, `a call a catch ran in keeps nothing at ${optimize}`)
  })

for (const optimize of levels(2, 3))
  test(`call release: a result the host takes a copy of goes with the call, a view of the module's memory stays, at ${optimize}`, () => {
    const src = `export const str = (n) => 'value ' + n + ' of a string too long to pack'
      export const obj = (n) => ({ a: n, b: [n, n], s: 'field ' + n + ' zzzzzzzzzzzzzzzzzz' })
      export const map = (n) => new Map([[n, 'v' + n + ' zzzzzzzzzzzzzzzzzzzzzz'], ['k', n]])
      export const typed = (n) => { const a = new Float64Array(4); a[0] = n; return a }
      export const holds = (n) => ({ a: n, t: new Float64Array([n, n + 1]) })
      export const churn = (n) => { const a = []; for (let i = 0; i < n; i++) a.push('c' + i + 'yyyyyyyyyyyyyyyy'); return a.length }`
    const want = oracle(src), { exports, memory } = jz(src, { optimize })
    const plain = (v) => v instanceof Map ? [...v] : ArrayBuffer.isView(v) ? [...v] : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v
    for (const [name, copied] of [['str', true], ['obj', true], ['map', true], ['typed', false], ['holds', false]]) {
      const got = [], used = memory.used
      for (let i = 0; i < 40; i++) { got.push(exports[name](i)); exports.churn(8) }
      // read after the heap was written over forty times
      for (let i = 0; i < 40; i++) is(plain(got[i]), plain(want[name](i)), `${name}(${i}) reads back`)
      if (copied) is(memory.used - used, 0, `${name}: the host holds a copy, the call's memory went at ${optimize}`)
      else ok(memory.used - used >= 40 * 32, `${name}: the host holds a view, the call's memory stays at ${optimize}: ${memory.used - used}`)
    }
  })

// An array literal returned as its elements is several results: the frame
// holds each in a local past its restore, and asks each.
for (const optimize of levels(2, 3))
  test(`call release: a call that returns several values releases unless one is of its making, at ${optimize}`, () => {
    const src = `const kept = ['a string the module holds, too long to pack']
      const pair = (n) => { const t = []; for (let i = 0; i < n + 8; i++) t.push([i, i * 2]); if (n < 0) return [0, -1]; return [t.length, t[3][1]] }
      export const two = (n) => pair(n)
      export const sum = (n) => { const [a, b] = pair(n); return a + b }
      export const mixed = (n) => { const t = [n, n + 1]; return n % 2 ? [t[0], 'made ' + n + ' zzzzzzzzzzzzzzzzzzzzzz'] : [t[1], kept[0]] }
      export const nested = (n) => [n, [n + 1, 'nested ' + n + ' zzzzzzzzzzzzzzzzzz'], { k: n }]
      export const view = (n) => { const a = new Float64Array(4); a[0] = n; return [n, a] }
      export const churn = (n) => { const a = []; for (let i = 0; i < n; i++) a.push('c' + i + 'yyyyyyyyyyyyyyyy'); return a.length }`
    const want = oracle(src), { exports, memory } = jz(src, { optimize })
    const plain = (v) => ArrayBuffer.isView(v) ? [...v] : Array.isArray(v) ? v.map(plain) : v
    for (const name of ['two', 'sum', 'mixed', 'nested']) {
      const got = []
      for (let i = -1; i < 12; i++) { got.push(exports[name](i)); exports.churn(6) }
      for (let i = -1; i < 12; i++) is(plain(got[i + 1]), plain(want[name](i)), `${name}(${i}) reads back`)
      let n = 0
      is(growth(memory, () => exports[name](n++ % 9)), 0, `${name} keeps nothing at ${optimize}`)
    }
    const got = [], used = memory.used
    for (let i = 0; i < 20; i++) { got.push(exports.view(i)); exports.churn(6) }
    for (let i = 0; i < 20; i++) is(plain(got[i]), plain(want.view(i)), `view(${i}) reads back`)
    ok(memory.used - used >= 20 * 32, `a view among them holds the call's memory: ${memory.used - used}`)
  })

// A handler takes for the escape flag the lowest it stood at since the
// outermost frame was entered: the frames an exception left did not hand
// theirs back. What they stored stays; a call whose frames stored nothing
// keeps nothing, whether a catch ran in it or not.
for (const optimize of levels(2, 3, 'size'))
  test(`call release: a call in which a catch ran keeps what its frames stored, at ${optimize}`, () => {
    const src = `const st = { cur: null, n: 0 }
      const fail = (n) => { const t = [n, n, n]; throw new RangeError('no ' + n + ' ' + t.length) }
      const deep = (n) => { st.cur = [n, n + 1]; return fail(n) }
      const mid = (n) => { const t = new Float64Array(32); t[0] = n; st.n = t[0]; if (n & 1) st.cur = ['odd', n]; return fail(n) + t[0] }
      export const none = (n) => { const t = new Float64Array(64); t[1] = n; try { return fail(n) } catch (e) { return t[1] + e.message.length } }
      export const stored = (n) => { const t = new Float64Array(64); t[1] = n; try { return deep(n) } catch (e) { return t[1] } }
      export const between = (n) => { const t = [n]; try { return mid(n) } catch (e) { return t[0] } }
      export const after = (n) => { let r = 0; try { r = fail(n) } catch (e) { r = -1 } st.cur = [n, r]; return r }
      export const last = (n) => { let r = 0; try { r = deep(n) } catch (e) { r = -2 } finally { st.n = n + r } return r }
      export const read = () => st.cur === null ? 'null' : st.cur.join() + ':' + st.n
      export const churn = (n) => { const a = []; for (let i = 0; i < n; i++) a.push('c' + i + 'yyyyyyyyyyyyyyyy'); return a.length }`
    const want = oracle(src), { exports, memory } = jz(src, { optimize })
    for (const name of ['none', 'stored', 'between', 'after', 'last']) for (let i = 0; i < 10; i++) {
      is(exports[name](i), want[name](i), `${name}(${i})`)
      exports.churn(8)
      is(exports.read(), want.read(), `${name}(${i}): what the frames stored reads back`)
    }
    if (optimize === 'size') return   // no walk and no asked result there: a call that stored keeps whole
    let n = 0
    is(growth(memory, () => exports.none(n++)), 0, `a call whose frames stored nothing keeps nothing at ${optimize}`)
    const used = memory.used
    for (let i = 0; i < 50; i++) exports.stored(i)
    ok(memory.used - used <= 50 * 96, `one that stored a pair keeps the pair, not the 0.5 KB beside it, at ${optimize}: ${(memory.used - used) / 50} a call`)
  })

// A frame whose tail call is dispatched (narrow's typed guard: one arm calls
// the clone, the other the function) returns from inside the value it
// returns. Each of those returns restores as the frame's own does; one that
// left without it would leave the flag the frame's entry cleared, and the
// caller would free what an escape before the call kept.
for (const optimize of levels(2, 3, 'size'))
  test(`call release: a frame whose tail call is dispatched restores on each of its returns, at ${optimize}`, () => {
    const src = `const st = { last: null }
      const sc = { f: new Float64Array(8), re: new Float64Array(8), im: new Float64Array(8) }
      const win = new Float64Array(8).fill(0.5), src = new Float64Array(8).fill(3)
      function fill(input, out) { const re = out[0], im = out[1], n = input.length; for (let i = 0; i < n; i++) { re[i] = input[i] * 2; im[i] = -input[i] } return out }
      function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }
      function analyze(src, win) { const N = win.length, f = sc.f; for (let i = 0; i < N; i++) f[i] = src[i] * win[i]; return fill(f, [sc.re, sc.im]) }
      function energy(src, win) { const N = win.length, f = new Float64Array(N); for (let i = 0; i < N; i++) f[i] = src[i] * win[i]; return dot(f, win) }
      export function run(k) {
        st.last = [k, k + 1]
        let s = 0
        for (let j = 0; j < k; j++) { const o = analyze(src, win); s += o[0][1] + o[1][2] + energy(src, win) }
        return s + fill([1, 2], [[0, 0], [0, 0]])[0][1] + dot([1, 2], [3, 4])
      }
      export const last = () => st.last === null ? -1 : st.last[1]
      export const churn = (n) => { const a = []; for (let i = 0; i < n; i++) a.push('c' + i + 'yyyyyyyyyyyyyyyy'); return a.length }`
    const want = oracle(src), { exports } = jz(src, { optimize: { level: optimize, sourceInline: false } })
    for (const k of [3, 5, 2]) {
      is(exports.run(k), want.run(k), `run(${k})`)
      exports.churn(64); want.churn(64)
      is(exports.last(), want.last(), `the pair run(${k}) stored reads back`)
    }
  })

// The same, through a string result: `snapshot` copies a Map and returns a
// string; `update`'s tail call of it dispatches. A frame that left without
// its restore made the next call read freed memory.
for (const optimize of levels(2, 3))
  test(`call release: a frame copying a Map and returning a string restores on its dispatched return, at ${optimize}`, () => {
    const src = `const source = new Map([['seed', [7]]]); const sink = []
      export function update(n) { for (let i = 0; i < n; i++) source.set('key' + i, [i]); for (let i = 1; i < n; i += 2) source.delete('key' + i); return snapshot() }
      export function snapshot() { const copy = new Map(source); let count = 0, sum = 0; for (const e of copy) { if (e == null) sink.push(e); count++; sum += e[1][0] } return copy.size + ':' + count + ':' + sum }
      export let churn = n => new Float64Array(n).length`
    const want = oracle(src), { exports } = jz(src, { optimize })
    const both = (name, ...args) => is(exports[name](...args), want[name](...args), `${name}(${args.join()})`)
    both('update', 0); both('snapshot'); exports._clear(); both('churn', 1024); both('snapshot'); exports._clear()
    both('update', 1); both('snapshot'); exports._clear(); both('update', 4); both('snapshot')
  })
