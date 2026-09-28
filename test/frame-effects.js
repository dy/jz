// Frame effects (src/compile/analyze/frame-effects.js) and the arena rewind
// they gate (src/optimize/arena-rewind.js). A rewind restores the heap
// pointer at return; it is sound only when no allocation made during the
// call outlives the frame. The census proves that from the source, the tape
// pass proves the rest from the emitted body, and `whyNotRewind` names the
// reason a candidate was declined. An escape that may not run on a call (in a
// branch, past a statement that may return, behind its own receiver test) is
// a site: the frame restores the heap only on a call that ran none, and
// `whyNotRewind` names the first site (`kept on a call that runs an escape`).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { resetTape, fromWat, toWat } from '../src/ir/tape.js'
import { arenaRewind } from '../src/optimize/arena-rewind.js'
import { levels, onKernel } from './_matrix.js'
import { oracle } from './util.js'

const TAPE = { optimize: { watr: false } }   // the pass's own output, before watr folds dead allocations away
const bodyOf = (wat, name) => { const i = wat.indexOf(`(func $${name}\n`); if (i < 0) return ''; const j = wat.indexOf('\n  (func ', i + 10); return wat.slice(i, j < 0 ? undefined : j) }
const rewinds = (src, opts = {}) => /heap_save/.test(bodyOf(compile(src, { wat: true, ...TAPE, ...opts }), 'f'))
// A frame that restores the heap only on a call no escape site ran in.
const flagged = (src, opts = {}) => /esc_save/.test(bodyOf(compile(src, { wat: true, ...TAPE, ...opts }), 'f'))
const whyNot = (src, opts = {}) => { const why = []; compile(src, { ...TAPE, ...opts, whyNotRewind: (n, r) => why.push([n, r]) }); return why.find(([n]) => n === '$f')?.[1] ?? null }

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
  is(whyNot(src), 'escape: heap value into st', 'the census names the escaping store')
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

test('frame effects: an allocation escaping through a parameter, a callee, or a host import vetoes the rewind', () => {
  ok(/^escape: heap value into o/.test(whyNot('export function f(o, n) { o.x = { y: n }; const t = new Array(n).fill(0); return t.length }')), 'through a parameter (the prepared name of `o`)')
  is(whyNot('const reg = []; function keep(o) { reg.push(o) } export function f(n) { const o = { x: n }; keep(o); return 1 }'), 'escape: grows reg', 'through a callee that grows module state')
  is(whyNot('export function f(a, n) { a.push(1); const t = new Array(n).fill(0); return t.length }'), 'escape: method push', 'an unproven receiver may override push and retain fresh memory')
  is(whyNot('const cache = []; export function f(n) { const t = new Array(n).fill(0); cache.push(t.length); return cache.length }'), 'escape: grows cache', 'growth of a module array, even of a number')
  is(whyNot('import { log } from "env"; export function f(n) { const o = { x: n }; log(o); const t = new Array(n).fill(0); return t.length }', { imports: { env: { log() {} } } }), 'escape: calls log (unknown)', 'a host import may keep what it receives')
  ok(!rewinds('export function f(o, n) { o.x = { y: n }; const t = new Array(n).fill(0); return t.length }'), 'no rewind emitted')
  // a parameter default runs in the frame: its growth of a parameter array escapes
  is(whyNot('export function f(o, n, x = o.push([n])) { const t = new Array(n).fill(0); return t.length }'), 'escape: method push', 'through an unproven parameter default receiver')
})

test('frame effects: an escape that may not run on a call is a site, one that runs on every call vetoes', () => {
  for (const [src, where] of [
    ['export function f(o, n) { if (n > 3) o.x = { y: n }; const t = new Array(n).fill(0); return t.length }', 'an if arm'],
    ['let cache = null; export function f(n) { const t = new Array(n).fill(0); if (cache !== null) return t.length + cache[0]; cache = new Float64Array(2); return t.length }', 'past an early return'],
    ['let st = null; export function f(n) { st ??= new Float64Array(2); const t = new Array(n).fill(0); return t.length + st[0] }', 'a logical assignment\'s store'],
  ]) {
    ok(/^kept on a call that runs an escape: /.test(whyNot(src)), `${where}: ${whyNot(src)}`)
    ok(flagged(src), `${where}: the frame restores on the escape flag`)
  }
  const loop = 'const cache = []; export function f(n) { const t = new Array(n).fill(0); for (let i = 0; i < n; i++) cache.push(i); return t.length }'
  is(whyNot(loop), 'escape: grows cache', 'a loop body runs on every call that reaches it')
  ok(!rewinds(loop), 'no rewind emitted')
  // a receiver that is no typed array grows on every store: its test would always pass
  is(whyNot('const W = [0, 0]; export function f(n) { const t = new Array(n).fill(0); W[n] = n; return t.length }'), 'escape: grows W', 'a plain array\'s growth has no test of its own')
})

test('frame effects: a receiver\'s test stands before the loop it stays the same through', () => {
  // `t` may be an array the store grows: the frame is conditional, its test runs once per call
  const once = 'export function f(a, b, k, n) { const s = new Array(4).fill(0); const t = k === 1 ? a : b; for (let i = 0; i < n; i = i + 1) t[i] = i + s[0]; return s.length }'
  const body = bodyOf(compile(once, { wat: true, ...TAPE }), 'f')
  // each `(loop …)` span, by its parentheses
  const loops = [...body.matchAll(/\(loop/g)].map(({ index }) => { let d = 0, j = index; do { d += body[j] === '(' ? 1 : body[j] === ')' ? -1 : 0; j++ } while (d > 0); return body.slice(index, j) })
  ok(flagged(once) && /\$__esc/.test(body) && loops.length && !loops.some(l => /\$__esc/.test(l)), 'the test is outside every loop')
  const want = oracle(once), m = jz(once).exports
  for (const [a, b] of [[[1, 2], [3]], [new Float64Array(4), [0]]]) is(m.f(a, b, 1, 6), want.f([...a], [...b], 1, 6), 'a growing array and a typed one')
  // a receiver each iteration binds anew has no test that runs once
  ok(/^escape: grows row/.test(whyNot('export function f(rows, n) { const s = new Array(4).fill(0); for (let i = 0; i < n; i++) { const row = rows[i]; row[5] = s[0] } return s.length }')), 'the test would run every iteration')
})

test('frame effects: receivers whose tests stand before one loop each keep theirs', () => {
  // an FDN's stereo block: `L[i] = …` and `R[i] = …`, both tested before the loop
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

test('frame effects: a receiver\'s test stands before a callback run per element and before an inner loop', () => {
  const spans = (wat) => [...wat.matchAll(/\(loop/g)].map(({ index }) => { let d = 0, j = index; do { d += wat[j] === '(' ? 1 : wat[j] === ')' ? -1 : 0; j++ } while (d > 0); return wat.slice(index, j) })
  const raise = /global\.set \$__esc \(i32\.const 1\)/
  // forEach runs its callback per element: the test stands before the call
  const each = 'export function f(a, b, k) { const s = new Array(4).fill(0); const t = k === 1 ? a : b; const xs = [k, k + 1, k + 2]; xs.forEach((x, i) => { t[i] = x + s[0] }); return s.length }'
  const wat = compile(each, { wat: true, ...TAPE })
  ok(flagged(each) && raise.test(bodyOf(wat, 'f')) && !spans(wat).some(l => raise.test(l)) && !/\(func \$closure[^]*?global\.set \$__esc \(i32\.const 1\)/.test(wat.slice(wat.indexOf('(func $closure'))), 'no element pays the test')
  // a row the outer loop binds anew is the same through the inner loop: its test runs once per row
  const rows = 'export function f(rows, n) { const s = new Array(4).fill(0); for (let i = 0; i < n; i++) { const row = rows[i]; for (let j = 0; j < n; j++) row[j] = j + s[0] } return s.length }'
  const loops = spans(bodyOf(compile(rows, { wat: true, ...TAPE }), 'f')), innermost = loops.filter(l => l.indexOf('(loop', 5) < 0)
  ok(flagged(rows) && loops.some(l => raise.test(l)) && !innermost.some(l => raise.test(l)), 'the test runs per row, outside the inner loop')
  // an optional call's callback, a return from inside the loop: what escaped stays
  const kept = `let store = [], typed = new Float64Array(8)
    export function f(k, n) { const s = new Array(4).fill(0); const t = k === 1 ? store : typed; for (let i = 0; i < n; i++) { t[i] = i + s[0]; if (i === 2) return s.length } return s.length }
    export function g(k, xs) { const s = new Array(4).fill(0); const t = k === 1 ? store : typed; xs?.forEach((x, i) => { t[i + 4] = x + s[0] }); return s.length }
    export function h(k, n) { const s = new Array(4).fill(0); const pick = (node) => { for (let j = 0; j < 3; j++) node[j + 8] = j + s[0] }; for (let i = 0; i < n; i++) pick(k === 1 ? store : typed); return s.length }
    export function g2(c, k) { const s = new Array(4).fill(0); const t = k === 1 ? store : typed; const put = (i) => { for (let j = 0; j < 2; j++) t[i + j] = j + s[0] }; if (c) { for (let i = 0; i < 3; i++) put(i) } put(20); return s.length }
    export function churn(n) { const a = []; for (let i = 0; i < n; i++) a.push([i, i]); return a.length }
    export let read = () => store.length * 1000 + store[2] * 100 + (store[5] ?? 0) + (store[21] ?? 0) * 10`
  // a named arrow runs from each call to it: its receiver's test never leaves its body
  // (`pick`'s own parameter, out of scope in `h`; `put`, called in a loop a branch
  // guards and after it). Kept out of line, the arrows stay arrows.
  const want = oracle(kept)
  for (const optimize of [...levels(2, 'size'), { level: 2, inlineFns: false, sourceInline: false }]) {
    const m = jz(kept, { optimize }).exports
    for (const [fn, args] of [['f', [1, 6]], ['g', [1, [7, 8]]], ['f', [0, 6]], ['h', [1, 2]], ['g2', [0, 1]]]) is(m[fn](...args), want[fn](...args), `${fn} at ${optimize}`)
    m.churn(64); is(m.read(), want.read(), `the grown array reads back after other allocations at ${optimize}`)
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
  // summary's kind of its result is empty, which is no proof it holds no heap value.
  const why = []
  compile(`import { twice } from './util.js'
    export let f = (x) => { const t = [x, x]; return twice(t[0] + t[1]) }`, { ...TAPE, whyNotRewind: (n, r) => why.push([n, r]), modules: {
    './util.js': 'export const clone = (node) => Array.isArray(node) ? node.map(clone) : node; export const twice = (x) => x * 2' } })
  is(why.find(([n]) => n === '$__util_js$clone')?.[1], 'result: may hold a heap value')
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
  ok(/^escape: shared cell buf/.test(whyNot(src)), 'the census names the cell the closure rebinds')
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
  is(viaCallee, 'escape: calls keep: grows cache', 'the transitive census names the callee and its reason')
})

// --- The tape pass: the unsafe set, imports, kernel taint, tail calls, cycles.

const onTape = (m, fn) => { resetTape(); const root = fromWat(m); fn(root); return toWat(root) }
const src = (n) => JSON.stringify(n)
// What the pass made of `$f`: a restore on the escape flag, a plain restore, or none.
const mode = (s) => /esc_save/.test(s) ? 'flag' : /heap_save/.test(s) ? 'rewind' : 'none'
const alloc = ['call', '$__alloc', ['i32.const', 8]]

test('arena rewind on the tape: the unsafe set vetoes a candidate and every caller of an unsafe function', () => {
  const m = ['module',
    ['func', '$leak', ['result', 'i32'], alloc],
    ['func', '$f', ['result', 'i32'], ['drop', ['call', '$leak']], alloc],
    ['func', '$g', ['result', 'i32'], alloc],
  ]
  const why = []
  const out = onTape(m, root => arenaRewind(root, { rewindable: new Map([['$leak', 'i32'], ['$f', 'i32'], ['$g', 'i32']]), heapAddr: null, unsafe: new Set(['$leak']), report: (n, r) => why.push(`${n}: ${r}`) }))
  ok(!/heap_save/.test(src(out[2])), 'a caller of an unsafe function does not rewind')
  ok(/heap_save/.test(src(out[3])), 'an unrelated candidate rewinds')
  is(why.join(' | '), '$leak: escape | $f: calls $leak: escape', 'the report names the vetoing callee')
})

test('arena rewind on the tape: an import taking arguments vetoes, an interop import or a bare import does not', () => {
  const m = (callee, args) => ['module',
    ['import', '"env"', '"x"', ['func', callee, ['param', 'f64'], ['result', 'f64']]],
    ['import', '"env"', '"now"', ['func', '$__now', ['result', 'f64']]],
    ['func', '$f', ['result', 'i32'], ['drop', ['call', callee, ...args]], ['drop', ['call', '$__now']], alloc],
  ]
  const run = (callee, args) => /heap_save/.test(src(onTape(m(callee, args), root => arenaRewind(root, { rewindable: new Map([['$f', 'i32']]), heapAddr: null }))))
  ok(!run('$env.x', [['f64.const', 1]]), 'a user import with an argument may keep it')
  ok(run('$__ext_set', [['f64.const', 1]]), 'the interop imports copy what they receive')
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
  const m = (body) => ['module',
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
  is(run(call('$__print'), { keepsNothing: new Set(['$__print']) }), 'rewind', 'a runtime import that keeps nothing it is handed is no escape')
  is(run(call('$__k')), 'none', 'a kernel escaping on a rare path: the frame keeps, and no call pays the protocol')
  is(run(call('$__k'), { conditional: new Map([['$f', 'outer binding x']]) }), 'flag', 'a frame with a site of its own restores on the flag the kernel raises')
  // the raise is a statement of its own: a pass rewriting the store reads its one operand
  const store = src(onTape(m(branch(['global.set', '$__tab', ['local.get', '$c']])), root => arenaRewind(root, { rewindable: new Map([['$f', 'i32']]), heapAddr: null, censused: new Set(['$f']) })))
  ok(store.includes('["global.set","$__esc",["i32.const",1]],["global.set","$__tab",["local.get","$c"]]'), 'the flag rises before the store: ' + store.slice(store.indexOf('"then"'), store.indexOf('"then"') + 120))
})

test('arena rewind on the tape: a guard no conditional frame reaches goes, its test staying where it sets a local', () => {
  // optimize/cse-address.js may hoist the receiver's type into the guard's test: later reads share the local.
  const m = ['module',
    ['global', '$__esc', ['mut', 'i32'], ['i32.const', 0]],
    ['func', '$__ptr_type', ['param', '$p', 'i64'], ['result', 'i32'], ['i32.wrap_i64', ['i64.shr_u', ['local.get', '$p'], ['i64.const', 47]]]],
    ['func', '$g', ['param', '$x', 'f64'], ['result', 'i32'], ['local', '$pt', 'i32'],
      ['if', ['i32.ne', ['local.tee', '$pt', ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', '$x']]]], ['i32.const', 3]], ['then', ['global.set', '$__esc', ['i32.const', 1]]]],
      ['if', ['i32.ne', ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', '$x']]], ['i32.const', 3]], ['then', ['global.set', '$__esc', ['i32.const', 1]]]],
      ['local.get', '$pt']],
  ]
  const out = src(onTape(m, root => arenaRewind(root, { rewindable: new Map(), heapAddr: null })))
  ok(!/"\$__esc",\["i32.const",1\]/.test(out), 'no raise is left')
  ok(/"local.tee","\$pt"/.test(out), 'the test that sets $pt stays')
  is((out.match(/"call","\$__ptr_type"/g) ?? []).length, 1, 'the test that sets nothing goes')
})

test('arena rewind on the tape: a tail call to a safe kernel becomes a plain call inside the rewind; other tail calls veto', () => {
  const m = (callee) => ['module',
    ['func', '$__len', ['param', '$p', 'i32'], ['result', 'i32'], ['local.get', '$p']],
    ['func', '$user', ['param', '$p', 'i32'], ['result', 'i32'], ['local.get', '$p']],
    ['func', '$f', ['result', 'i32'], ['drop', alloc], ['return_call', callee, ['i32.const', 3]]],
  ]
  const kernel = src(onTape(m('$__len'), root => arenaRewind(root, { rewindable: new Map([['$f', 'i32']]), heapAddr: null }))[3])
  ok(/heap_save/.test(kernel) && !/return_call/.test(kernel) && /"call","\$__len"/.test(kernel), 'the kernel tail call is a plain call under the restore')
  const user = src(onTape(m('$user'), root => arenaRewind(root, { rewindable: new Map([['$f', 'i32']]), heapAddr: null }))[3])
  ok(!/heap_save/.test(user) && /return_call/.test(user), 'a tail call into user code keeps its frame elision and does not rewind')
})

test('arena rewind on the tape: mutually recursive clean kernels are safe callees, and allocation counts through them', () => {
  const m = ['module',
    ['func', '$__a', ['param', '$n', 'i32'], ['result', 'i32'], ['if', ['result', 'i32'], ['local.get', '$n'], ['then', ['call', '$__b', ['i32.sub', ['local.get', '$n'], ['i32.const', 1]]]], ['else', alloc]]],
    ['func', '$__b', ['param', '$n', 'i32'], ['result', 'i32'], ['call', '$__a', ['local.get', '$n']]],
    ['func', '$f', ['result', 'i32'], ['call', '$__b', ['i32.const', 3]]],
  ]
  const f = src(onTape(m, root => arenaRewind(root, { rewindable: new Map([['$f', 'i32']]), heapAddr: null }))[3])
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
  ok(!rewinds(src), 'the frame is declined: ' + whyNot(src))
  const m = jz(src, { optimize: 'speed' })
  is(m.exports.f(0), 1); is(m.exports.f(1), 2)
  is(m.exports.g(), 10, 'the getter\'s store survives the call')
})

// A static pair lives on the class value: reading its name through the
// class runs the getter, and what it stores outward escapes the frame.
test('frame effects: a static getter on a class value is code the census cannot name', () => {
  if (onKernel()) return
  const src = `let keep = null
    class K { static get tag() { keep = { v: 1 }; return 42 } }
    export function f() { const r = { v: K.tag }; return r.v }
    export function g() { const z = { v: 9 }; return keep.v + z.v }`
  ok(!rewinds(src), 'the frame is declined: ' + whyNot(src))
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
