import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { onKernel } from './_matrix.js'

const options = optimize => ({ optimize, memory: { fixed: ['process'] } })
const oracle = src => new Function(src.replaceAll('export ', '') + '; return process')()
const tiers = [0, 2, 3, 'size']

test('fixed memory: local DSP scratch is reused and reinitialized at every tier', () => {
  if (onKernel()) return // public memory options are supplied by the host compiler
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
    const { wasm, inspect } = compile(src, { ...options(optimize), inspect: true })
    ok(WebAssembly.validate(wasm))
    is(inspect.runtime.process.noAllocation, true)
    is(inspect.runtime.process.noHostCalls, true)
    ok(!compile(src, { ...options(optimize), wat: true }).includes('$__survive'), 'no tracing runtime')
  }
})

test('fixed memory: scratch construction inside loops preserves zeroing and independent buffers', () => {
  if (onKernel()) return
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
  if (onKernel()) return
  for (const ctor of ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array']) {
    const src = `export function process(i, x) { const a = new ${ctor}(32); a[i] = x; return a[i] }`
    const ref = oracle(src), p = jz(src, options(2))
    for (const i of [-1, 0, 31, 32]) for (const x of [1.25, -0, 300, -300, NaN, Infinity])
      is(p.exports.process(i, x), ref(i, x), `${ctor}[${i}] = ${x}`)
  }
})

test('fixed memory: zero, one element and the 64 KiB boundary preserve reads and zeroing', () => {
  if (onKernel()) return
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
  if (onKernel()) return
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
  if (onKernel()) return
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
  if (onKernel()) return
  const src = `export function process(a) {
    if (!(a instanceof Float32Array)) return -1
    return a[0]
  }`
  for (const optimize of [0, 1, 2, 3, 'size']) {
    const p = jz(src, options(optimize))
    const empty = p.memory.Float32Array([]), a = p.memory.Float32Array([1]), b = p.memory.Float32Array([7, 8, 9])
    const other = p.memory.Float64Array([4]), used = p.memory.used, bytes = p.memory.buffer.byteLength
    for (let round = 0; round < 32; round++) {
      for (const [ptr, want] of [[empty, undefined], [a, 1], [a, 1], [b, 7], [a, 1], [other, -1], [null, -1]])
        is(p.exports.process(ptr), want, `${optimize}, round ${round}`)
    }
    is(p.memory.used, used, 'no retained allocation')
    is(p.memory.buffer.byteLength, bytes, 'no growth')
    const { inspect } = compile(src, { ...options(optimize), inspect: true })
    is(inspect.runtime.process.noAllocation, true, 'the final call graph allocates nothing')
  }
})

test('fixed memory: disjoint lifetimes share storage while overlapping lifetimes keep distinct slots', () => {
  if (onKernel()) return
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
  if (onKernel()) return
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

test('fixed memory: host reentry and non-tail recursive scratch are refused', () => {
  if (onKernel()) return
  const recurse = `export function process(n){const a=new Float64Array(128);a[0]=n;return n>0 ? process(n-1)+a[0] : a[0]}`
  throws(() => compile(recurse, options(0)), /recursive call/)
  const host = `import { tick } from 'host'; export function process(n){const a=new Float64Array(128);a[0]=n;tick();return a[0]}`
  throws(() => compile(host, { ...options(0), imports: { host: { tick() {} } } }), /host or unresolved call/)
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

test('fixed memory: export aliases, configuration errors and compile-state isolation', () => {
  if (onKernel()) return
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
