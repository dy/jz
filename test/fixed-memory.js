import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { onKernel, onWasi, ownedLevels } from './_matrix.js'
import { jz, compile } from './util.js'

const options = optimize => ({ optimize, memory: { fixed: ['process'] } })
const oracle = src => new Function(src.replaceAll('export ', '') + '; return process')()
const tiers = [0, 2, 3, 'size']

test('fixed memory: local DSP scratch is reused and reinitialized at every tier', () => {
  const src = `let history = new Float64Array(128)
    export function process(n, gain) {
      const tmp = new Float32Array(128)
      for (let i=0;i<n;i++) tmp[i] = (i + history[i]) * gain
      let sum = 0
      for (let i=0;i<128;i++) { sum += tmp[i]; history[i] = tmp[i] }
      return sum
    }`
  for (const optimize of tiers) {
    const ref = oracle(src), p = jz(src, options(optimize))
    const bytes = p.memory.buffer.byteLength, used = p.memory.used
    for (let i = 0; i < 128; i++) {
      const n = i % 3 === 0 ? 0 : i % 129, gain = (i % 7) / 8
      is(p.exports.process(n, gain), ref(n, gain), `${optimize}: block ${i}`)
    }
    is(p.memory.buffer.byteLength, bytes, 'no growth')
    is(p.memory.used, used, 'no retained allocation')
    if (!onKernel()) {
      const { wasm, inspect } = compile(src, { ...options(optimize), inspect: true })
      ok(WebAssembly.validate(wasm))
      is(inspect.runtime.process.noAllocation, true)
      is(inspect.runtime.process.noHostCalls, true)
    }
    ok(!compile(src, { ...options(optimize), wat: true }).includes('$__survive'), 'no tracing runtime')
  }
})

test('fixed memory: scratch construction inside loops preserves zeroing and independent buffers', () => {
  const src = `export function process(n) {
    const a = new Float64Array(32)
    let sum = 0
    for (let i=0;i<n;i++) {
      const b = new Float64Array(32)
      b[i & 31] = i
      sum += b[(i+1) & 31] + a[i & 31]
      a[i & 31] = i
    }
    return sum
  }`
  for (const optimize of tiers) {
    const ref = oracle(src), p = jz(src, options(optimize))
    for (const n of [0, 1, 31, 32, 67, 256, 0]) is(p.exports.process(n), ref(n))
  }
})

test('fixed memory: numeric storage kinds preserve coercions and bounds', () => {
  for (const ctor of ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array']) {
    const src = `export function process(i, x) { const a = new ${ctor}(32); a[i] = x; return a[i] }`
    const ref = oracle(src), p = jz(src, options(2))
    for (const i of [-1, 0, 31, 32]) for (const x of [1.25, -0, 300, -300, NaN, Infinity])
      is(p.exports.process(i, x), ref(i, x), `${ctor}[${i}] = ${x}`)
  }
})

test('fixed memory: zero, one element and the 64 KiB boundary preserve reads and zeroing', () => {
  for (const length of [0, 1, 8192]) for (const optimize of tiers) {
    const src = `export function process(i, x) {
      const a = new Float64Array(${length})
      if (x >= 0) a[i] = x
      return x === -2 ? a.length : a[i]
    }`
    const ref = oracle(src), p = jz(src, options(optimize))
    const bytes = p.memory.buffer.byteLength, used = p.memory.used
    for (const [i, x] of [[0, 7], [0, 7], [length - 1, 13], [0, -1], [length - 1, -1], [length, 19], [-1, 23], [0, -2]])
      is(p.exports.process(i, x), ref(i, x), `${optimize}, length ${length}: (${i}, ${x})`)
    is(p.memory.buffer.byteLength, bytes)
    is(p.memory.used, used)
  }
  const tooLarge = 'export function process(i, x){const a=new Float64Array(8193);a[i]=x;return a[i]}'
  throws(() => compile(tooLarge, options(0)), /heap allocation or memory growth/, 'one element past the scratch byte cap')
})

test('fixed memory: named sizes and helper calls keep each live allocation distinct', () => {
  const src = `const N=128
    function step(n) {
      const a=new Float64Array(N), b=new Int8Array(N)
      a[n&127]=n+0.25; b[n&127]=n
      return a[n&127]+b[n&127]
    }
    export function process(n) {
      const a=new Float64Array(N)
      a[0]=n
      return step(n)+step(n+1)+a[0]
    }
    export function outside(n) { return step(n) }`
  for (const optimize of tiers) {
    const p = jz(src, options(optimize)), ref = oracle(src)
    const used = p.memory.used
    for (const n of [0, 4, 127, 128, 300]) {
      is(p.exports.process(n), ref(n))
      p.exports.outside(n)
      is(p.exports.process(n), ref(n), 'other exports may call a safe scratch owner')
    }
    is(p.memory.used, used)
  }
})

test('fixed memory: borrowed host buffers and hidden typed variants allocate nothing in Wasm', () => {
  const src = `export function process(a) {
    const t = new Float32Array(128)
    for(let i=0;i<128;i++) t[i]=a[i]*0.5
    for(let i=0;i<128;i++) a[i]=t[127-i]
  }`
  const p = jz(src, options(2))
  const ptr = p.memory.Float64Array(Array.from({ length: 128 }, (_, i) => i))
  const before = p.memory.buffer.byteLength, used = p.memory.used
  p.instance.exports.process(ptr) // raw Wasm boundary; no JS array marshalling
  const a = p.memory.read(ptr)
  is(a[0], 63.5); is(a[127], 0)
  for (let i = 0; i < 1000; i++) p.instance.exports.process(ptr)
  is(p.memory.buffer.byteLength, before); is(p.memory.used, used)
  for (const Ctor of [Float32Array, Float64Array]) {
    const input = new Ctor(128).fill(4)
    p.exports.process(input)
    is(input[0], 2, Ctor.name)
  }
})

test('fixed memory: typed guards keep borrowed receivers allocation-free', () => {
  const src = `export function process(a) {
    if (!(a instanceof Float32Array)) return -1
    return a[0]
  }`
  for (const optimize of ownedLevels(0, 1, 2, 3, 'size')) {
    const p = jz(src, options(optimize))
    const empty = p.memory.Float32Array([]), a = p.memory.Float32Array([1]), b = p.memory.Float32Array([7, 8, 9])
    const other = p.memory.Float64Array([4]), used = p.memory.used, bytes = p.memory.buffer.byteLength
    for (let round = 0; round < 32; round++) {
      for (const [ptr, want] of [[empty, undefined], [a, 1], [a, 1], [b, 7], [a, 1], [other, -1], [null, -1]])
        is(p.exports.process(ptr), want, `${optimize}, round ${round}`)
    }
    is(p.memory.used, used, 'no retained allocation')
    is(p.memory.buffer.byteLength, bytes, 'no growth')
    if (!onKernel()) {
      const { inspect } = compile(src, { ...options(optimize), inspect: true })
      is(inspect.runtime.process.noAllocation, true, 'the final call graph allocates nothing')
    }
  }
})

test('fixed memory: disjoint lifetimes share storage while overlapping lifetimes keep distinct slots', () => {
  const sequential = `export function process(n) {
    const a=new Float64Array(4096); a[0]=n; let sum=a[0]
    const b=new Float64Array(4096); sum+=b[0]; b[0]=n+1; return sum+b[0]
  }`
  const overlap = `export function process(n) {
    const a=new Float64Array(4096)
    const b=new Float64Array(4096); b[0]=n
    return a[0]+b[0]
  }`
  for (const optimize of tiers) {
    const opts = { optimize, memory: { maximum: 1, fixed: ['process'] } }
    const p = jz(sequential, opts)
    is(p.exports.process(5), 11)
    is(p.exports.process(3), 7, 'shared slot zeroed before constructing b')
    is(p.memory.buffer.byteLength, 65536)
    throws(() => compile(overlap, opts), /exceeding memory.maximum/)
    const q = jz(overlap, options(optimize))
    is(q.exports.process(7), 7, 'a stays zero while b is written')
  }
})

test('fixed memory: escaping storage, unknown keys and growing state are refused', () => {
  const cases = [
    'export function process(n){return new Float64Array(n)}',
    'export function process(){const a=new Float64Array(128);return a}',
    'let saved; export function process(){const a=new Float64Array(128);saved=a;return a[0]}',
    'export function process(){const a=new Float64Array(128);return ()=>a[0]}',
    'export function process(k){const a=new Float64Array(128);return a[""+k]}',
    'export function process(){const a=new Float64Array(128);return a.buffer}',
    'export function process(){const a=new Float64Array(128);return a.subarray(0,32)}',
    'let a=[]; export function process(n){a.push(n);return a.length}',
  ]
  for (const src of cases) throws(() => compile(src, options(0)), /memory.fixed cannot certify/, src)
})

test('fixed memory: a runtime TypeError is raised by its code, allocating nothing', () => {
  // The read of a property of a nullish value throws the TypeError's code; the host and
  // a catch get the Error (err-codes.js), so the throw keeps the export allocation-free.
  const src = `const box = [{ v: 1.5 }, undefined]
    export function process(i) { return box[i & 1].v }`
  for (const optimize of tiers) {
    const p = jz(src, options(optimize)), ref = oracle(src), used = p.memory.used
    is(p.exports.process(0), ref(0), `${optimize}: the read`)
    const thrown = (f) => { try { f(1) } catch (e) { return e } }
    const got = thrown(p.exports.process), want = thrown(ref)
    ok(got instanceof TypeError && want instanceof TypeError, `${optimize}: ${got}`)
    is(got.message, 'Cannot read properties of undefined', `${optimize}: the message`)
    is(p.memory.used, used, `${optimize}: no retained allocation`)
  }
})

test('fixed memory: a closure call is followed to the closures it can reach', () => {
  // A module binding holds a no-op until setup puts a factory's closure in it, the
  // factory's state its typed arrays: process calls through the closure table.
  const factory = `const make = (n) => {
      const state = new Float64Array(n)
      const step = (x, i) => state[i] = state[i] * 0.5 + x
      return (inp, out) => { for (let i = 0; i < inp.length; i++) out[i] = step(inp[i], i) }
    }
    let proc = (inp, out) => {}
    let inp = new Float64Array(0), out = new Float64Array(0)
    export function setup(n) { inp = new Float64Array(n); out = new Float64Array(n); for (let i = 0; i < n; i++) inp[i] = i; proc = make(n) }
    export function process(n) { proc(inp, out); return out[n] }`
  // The table also holds a closure that allocates, which process never calls.
  const apart = factory + `
    let grow = (n) => [n]
    export function other(n) { return grow(n).length }
    export function swap() { grow = (n) => new Float64Array(n) }`
  for (const optimize of tiers) for (const src of [factory, apart]) {
    const label = `${optimize}${src === apart ? ', an allocating closure apart' : ''}`
    const p = jz(src, options(optimize)), ref = new Function(src.replaceAll('export ', '') + '; return { setup, process }')()
    p.exports.setup(8); ref.setup(8)
    const used = p.memory.used, bytes = p.memory.buffer.byteLength
    for (let k = 0; k < 16; k++) is(p.exports.process(k & 7), ref.process(k & 7), `${label}: call ${k}`)
    is(p.memory.used, used, `${label}: no retained allocation`)
    is(p.memory.buffer.byteLength, bytes, `${label}: no growth`)
    ok(!WebAssembly.Module.exports(new WebAssembly.Module(compile(src, options(optimize)))).some(e => e.name === '__jz_table'),
      `${label}: the table the proof bounds the call by is the module's own`)
  }
  // A call of a closure that allocates is refused at the call that reaches it.
  const allocates = `let f = (n) => n
    export function setup() { f = (n) => [n, n].length }
    export function process(n) {
      return f(n)
    }`
  let refused = ''
  try { compile(allocates, options(0)) } catch (e) { refused = e.message }
  // (the hosted compiler keeps no source text, so no error of its names a position: test/error-location.js)
  const through = onKernel() ? /memory\.fixed cannot certify process → .*called through a closure/ : /memory\.fixed cannot certify process → .*called through a closure at line 4:/
  ok(through.test(refused) && /heap allocation/.test(refused), refused)
  // A cycle through a closure call is recursion.
  const cycle = `let f = (n) => 0
    const g = (n) => n > 0 ? f(n - 1) + 1 : 0
    export function setup() { f = g }
    export function process(n) { return f(n) }`
  throws(() => compile(cycle, options(0)), /recursive call/)
})

test('fixed memory: a length read of an unproven receiver, in a module of closures and arrays', () => {
  // Two bus sets whose second slots differ in their channels (the shape of @audio/compile's
  // shim over a processor with a second input): `inp.length` goes through the generic read.
  // Only a function can hold an ordinary `length` here, so the read answers a closure's
  // parameters itself (the WASI leg's function-length tests) and links no dynamic read,
  // whose string arm allocates.
  const src = `let sets = [], fed = 1, proc = (inputs) => 0
    export function setup(frames) {
      const a = [new Float32Array(frames), new Float32Array(frames)], b = [new Float32Array(frames), new Float32Array(frames)], none = []
      sets = [[a, none], [a, b]]
      proc = (inputs) => { const inp = inputs[0]; if (!inp || !inp.length) return 0; return inp[0].length + inputs[1].length }
    }
    export function feed(f) { fed = f ? 1 : 0 }
    export function process() { return proc(sets[fed]) }`
  for (const optimize of tiers) {
    const p = jz(src, options(optimize)), ref = new Function(src.replaceAll('export ', '') + '; return { setup, feed, process }')()
    p.exports.setup(16); ref.setup(16)
    const used = p.memory.used
    for (const f of [0, 1, 0]) { p.exports.feed(f); ref.feed(f); is(p.exports.process(), ref.process(), `${optimize}: fed ${f}`) }
    is(p.memory.used, used, `${optimize}: no retained allocation`)
    if (!onKernel()) ok(!/__dyn_get/.test(compile(src, { ...options(optimize), wat: true })), `${optimize}: no dynamic read is linked`)
  }
})

test('fixed memory: named reads of unproven receivers beside an object literal certify', () => {
  // An object literal in the program links the generic read (module/collection.js
  // __dyn_get_t_h), which the bus program's `inp.length` and a cascade's coefficient
  // reads take. Its string arm for an index key ('ab'['1'], a fresh string past ASCII)
  // is the run-time key's (__dyn_get_t) alone: no key a site names is an index there,
  // so nothing these reads reach allocates.
  const bus = `const cfg = { g: 2 }
    export const gain = () => cfg.g
    let sets = [], fed = 1, proc = (inputs) => 0
    export function setup(frames) {
      const a = [new Float32Array(frames), new Float32Array(frames)], b = [new Float32Array(frames), new Float32Array(frames)], none = []
      sets = [[a, none], [a, b]]
      proc = (inputs) => { const inp = inputs[0]; if (!inp || !inp.length) return 0; return inp[0].length }
    }
    export function feed(f) { fed = f ? 1 : 0 }
    export function process() { return proc(sets[fed]) }`
  const cascade = `const state = () => new Float64Array(2)
    function process (data, c, s) {
      let z1 = s[0], z2 = s[1]
      for (let i = 0, l = data.length; i < l; i++) { let x = data[i], y = c.b0 * x + z1; z1 = c.b1 * x - c.a1 * y + z2; z2 = c.b2 * x - c.a2 * y; data[i] = y }
      s[0] = z1; s[1] = z2
      return data
    }
    function cascade (data, coefs, states) {
      for (let i = 0; i < coefs.length; i++) process(data, coefs[i], states[i])
      return data
    }
    let proc = () => 0
    export const setup = (channels, frames) => {
      const sos = [{ b0: 1, b1: 0.5, b2: 0.25, a1: 0.1, a2: 0.05 }, { b0: 1, b1: 0.3, b2: 0.2, a1: 0.2, a2: 0.01 }], st = [], out = []
      for (let ch = 0; ch < channels; ch++) { st.push(sos.map(() => new Float64Array(2))); out.push(new Float32Array(frames)) }
      proc = () => { for (let ch = 0; ch < out.length; ch++) cascade(out[ch], sos, st[ch]); return 0 }
    }
    export const process_ = 0
    export { run as process }
    function run () { return proc() }`
  for (const optimize of [false, true, 'size', 'speed']) for (const [name, src] of [['bus', bus], ['cascade', cascade]]) {
    // (at size `c` is a parameter of an uninlined function, which the summary cannot bound,
    // and under the JS host such a receiver may be a host object, read through the host)
    if (name === 'cascade' && optimize === 'size' && !onWasi()) continue
    const p = jz(src, options(optimize)), ref = new Function(src.replace(/export \{ run as process \}/, '').replaceAll('export ', '') + `; return { setup, ${name === 'bus' ? 'feed, process' : 'process: run'} }`)()
    p.exports.setup(...(name === 'bus' ? [16] : [2, 16])); ref.setup(...(name === 'bus' ? [16] : [2, 16]))
    const used = p.memory.used
    for (const f of [0, 1, 0]) {
      if (name === 'bus') { p.exports.feed(f); ref.feed(f) }
      is(p.exports.process(), ref.process(), `${name} at ${optimize}: call ${f}`)
    }
    is(p.memory.used, used, `${name} at ${optimize}: no retained allocation`)
  }
})

test('fixed memory: a power of runtime operands, a negative base among them, certifies', () => {
  // $math.pow takes a negative base with an integer exponent past its fast path through
  // its own kernel, the sign in the scale (module/math.js powExpTail), where it called
  // itself for |x|; $math.pow_b (a constant base) and the two-wide kernel call it.
  const srcs = [
    `let g = 3
    export const set = (v) => { g = v }
    export function process(buf) { let s = 0; for (let i = 0; i < buf.length; i++) s += Math.pow(buf[i], g) + buf[i] ** (g + 0.5); return s }`,
    `let db = -6
    export const set = (v) => { db = v }
    export function process(buf) { const k = 10 ** (db / 20); for (let i = 0; i < buf.length; i++) buf[i] *= k; return k }`,
  ]
  for (const optimize of tiers) for (const src of srcs) {
    const p = jz(src, options(optimize)), ref = new Function(src.replaceAll('export ', '') + '; return { set, process }')()
    const used = p.memory.used
    for (const v of [3, 17, -25, 0.5, 1025, -1074]) {
      p.exports.set(v); ref.set(v)
      for (const base of [[-2, 1.5, -0.5, 3], [-1, -0, 1e-300, -1e300]]) {
        const a = new Float64Array(base), b = new Float64Array(base)
        is(p.exports.process(a), ref.process(b), `${optimize}: v = ${v}, ${base}`)
        is([...a].map(String).join(), [...b].map(String).join(), `${optimize}: v = ${v}, the buffer`)
      }
    }
    is(p.memory.used, used, `${optimize}: no retained allocation`)
  }
})

test('fixed memory: host reentry and non-tail recursive scratch are refused', () => {
  const recurse = `export function process(n){const a=new Float64Array(128);a[0]=n;return n>0 ? process(n-1)+a[0] : a[0]}`
  throws(() => compile(recurse, options(0)), /recursive call/)
  const host = `import { tick } from 'host'; export function process(n){const a=new Float64Array(128);a[0]=n;tick();return a[0]}`
  throws(() => compile(host, { ...options(0), imports: { host: { tick() {} } } }), /process → host\.tick: host call/)
  // A selected root's constant argument may erase the recursive branch after
  // inlining. The helper's scratch must also be safe for its other callers.
  const helper = `function step(n) {
      const a=new Float64Array(128); a[0]=n
      return n>0 ? step(n-1)+a[0] : a[0]
    }
    export function process(){return step(0)}
    export function outside(n){return step(n)}`
  throws(() => compile(helper, { ...options({ level: 2, sourceInline: false }) }), /recursive call/)
})

test('fixed memory: an init that runs as an entry stays outside the certified graph', () => {
  // Where init is an entry and not a start section (it can throw, it reads the host, or
  // the build is a WASI command), every export opens with a guard that runs it where the
  // host has not (optimize/watr-tail.js legalizeInit). Init may allocate persistent state,
  // as a start section's may: the proof leaves the guard out, and only the guard.
  const init = `const check = (n) => { if (n <= 0) throw new RangeError('n'); return n }
    let k = 64
    export const setK = (v) => { k = v }
    const table = new Float32Array(check(k))
    for (let i = 0; i < 64; i++) table[i] = i * 0.5
    `
  const src = init + 'export function process(x, i) { return x * table[i & 63] }'
  const own = init + 'const saved = []\nexport function process(x, i) { saved.push(x); return x * table[i & 63] }'
  const host = src.replace('check(k)', 'globalThis.N ?? 64')
  // (each row names its host: the entry is the host's, whatever host the leg compiles for)
  const cases = [[src, { host: 'js' }, '_initialize'], [src, { host: 'wasi' }, '__jz_init'], [host, { host: 'js' }, '_initialize']]
  for (const optimize of tiers) for (const [code, extra, entry] of cases) {
    const opts = { ...options(optimize), ...extra }, label = `${optimize}, ${extra.host}${code === host ? ', host init' : ''}`
    ok(WebAssembly.Module.exports(new WebAssembly.Module(compile(code, opts))).some(e => e.name === entry), `${label}: init is ${entry}`)
    const p = jz(code, opts), ref = oracle(code), used = p.memory.used
    for (const [x, i] of [[2, 3], [-1, 63], [0.5, 64]]) is(p.exports.process(x, i), ref(x, i), `${label}: process(${x}, ${i})`)
    is(p.memory.used, used, `${label}: no retained allocation`)
    if (!onKernel()) is(compile(code, { ...opts, inspect: true }).inspect.runtime.process.noAllocation, true, `${label}: init is not the export's work`)
    if (code === host) continue
    let refused = ''
    try { compile(own, opts) } catch (e) { refused = e.message }
    ok(/memory\.fixed cannot certify process/.test(refused) && !refused.includes('$__start'), `${label}: the export's own allocation is refused: ${refused}`)
  }
})

test('fixed memory: export aliases, configuration errors and compile-state isolation', () => {
  const src = 'function f(n){const a=new Float64Array(128);a[n & 127]=n;return a[n & 127]} export { f as process }'
  is(jz(src, options(2)).exports.process(7), 7)
  for (const fixed of [true, '', [], [3], [null], ['']])
    throws(() => compile(src, { memory: { fixed } }), /memory.fixed/)
  throws(() => compile(src, { memory: { fixed: ['missing'] } }), /not a function export/)
  throws(() => compile(src, { memory: { fixed: ['process'], import: true } }), /module-owned, unshared/)
  throws(() => compile(src, { memory: { fixed: ['process'], shared: true, maximum: 16 } }), /module-owned, unshared/)
  const a = compile(src)
  for (const fixed of [undefined, null])
    is(compile(src, { memory: { fixed } }), a, 'an absent contract leaves ordinary compilation unchanged')
  compile(src, options(2))
  is(compile(src), a, 'ordinary compilation is unchanged after a fixed compile')
  const opts = options(2)
  const before = JSON.stringify(opts)
  compile(src, opts)
  is(JSON.stringify(opts), before, 'caller options are not mutated')
  const other = 'export function other(i){const a=new Uint8Array(16);a[i&15]=i;return a[i&15]}'
  const fixedA = compile(src, opts)
  is(compile(src, opts), fixedA, 'A → A')
  is(jz(other, { memory: { fixed: ['other'] } }).exports.other(257), 1, 'A → different B: different export and element layout')
  is(compile(src, opts), fixedA, 'B → A')
  is(jz(src, opts).exports.process(7), 7, 'A still executes correctly')
})
