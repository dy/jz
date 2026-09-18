// Frame effects (src/compile/analyze/frame-effects.js) and the arena rewind
// they gate (src/optimize/arena-rewind.js). A rewind restores the heap
// pointer at return; it is sound only when no allocation made during the
// call outlives the frame. The census proves that from the source, the tape
// pass proves the rest from the emitted body, and `whyNotRewind` names the
// reason a candidate was declined.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { resetTape, fromWat, toWat } from '../src/ir/tape.js'
import { arenaRewind } from '../src/optimize/arena-rewind.js'
import { levels, onKernel } from './_matrix.js'

const TAPE = { optimize: { watr: false } }   // the pass's own output, before watr folds dead allocations away
const bodyOf = (wat, name) => { const i = wat.indexOf(`(func $${name}\n`); if (i < 0) return ''; const j = wat.indexOf('\n  (func ', i + 10); return wat.slice(i, j < 0 ? undefined : j) }
const rewinds = (src, opts = {}) => /heap_save/.test(bodyOf(compile(src, { wat: true, ...TAPE, ...opts }), 'f'))
const whyNot = (src, opts = {}) => { const why = []; compile(src, { ...TAPE, ...opts, whyNotRewind: (n, r) => why.push([n, r]) }); return why.find(([n]) => n === '$f')?.[1] ?? null }

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
  ok(/^escape: grows a/.test(whyNot('export function f(a, n) { a.push(1); const t = new Array(n).fill(0); return t.length }')), 'growth of a parameter array (its storage may extend into fresh memory)')
  is(whyNot('const cache = []; export function f(n) { const t = new Array(n).fill(0); cache.push(t.length); return cache.length }'), 'escape: grows cache', 'growth of a module array, even of a number')
  is(whyNot('import { log } from "env"; export function f(n) { const o = { x: n }; log(o); const t = new Array(n).fill(0); return t.length }', { imports: { env: { log() {} } } }), 'escape: calls log (unknown)', 'a host import may keep what it receives')
  ok(!rewinds('export function f(o, n) { o.x = { y: n }; const t = new Array(n).fill(0); return t.length }'), 'no rewind emitted')
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
