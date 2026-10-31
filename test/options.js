// The public compile options: twelve keys, a closed set, with the memory and
// optimize objects folding onto the internal flags (src/options.js normalizeOptions).
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { jz as jzInternal, compile as compileInternal } from './util.js'
import { belowOpt, levels } from './_matrix.js'

const flat = s => s.replace(/\s+/g, ' ')
const HEAP = 'export let f = (n) => { let a = new Float64Array(n); a[0] = 1.5; return a[0] }'
const LOOP = 'export let f = (n) => { let a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = a[i] * 2; return a[0] }'
const TAIL = 'export let sum = (n, acc) => n === 0 ? acc : sum(n - 1, acc + n)'
const GROW = 'export let f = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(i); return a }'
const THROW = 'export let f = (x) => { if (x < 0) throw new RangeError("neg"); return x }'
const DEP = 'export let f = (n) => { let a = new Float64Array(n); for (let i = 1; i < n; i++) a[i] = a[i - 1] + 1; return a[0] }'

test('options: define preserves scalar values, property names and sparse array length', () => {
  const shared = { 'a-b': 7 }, value = {
    '': null, 'a-b': -0, 'quote"\\': 'α😀', left: shared, right: shared,
    ['__proto__']: 13, slots: [, undefined, ,],
  }
  const src = `export const f = () => [K[''] === null, 1 / K['a-b'], K['quote"\\\\'],
    K.left['a-b'], K.right['a-b'], K['__proto__'], K.slots.length,
    K.slots[0] === undefined, K.slots[2] === undefined, 0 in K.slots, 2 in K.slots]`
  // (the levels are the internal flags')
  const jz = jzInternal
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const f = jz(src, { define: { K: value }, optimize }).exports.f
    const expected = [true, -Infinity, 'α😀', 7, 7, 13, 3, true, true, true, true]
    is(f(), expected, `literal fields, O${optimize}`)
    is(f(), expected, `same instance again, O${optimize}`)
    for (const K of [undefined, null, true, false, 0, -0, NaN, Infinity, -Infinity, '', 'α😀']) {
      const actual = jz('export const f = () => K', { define: { K }, optimize }).exports.f()
      ok(Object.is(actual, K), `scalar ${String(K)}, O${optimize}`)
    }
    for (const K of [[], [,], [,,], [1,,], []]) {
      const f = jz('export const f = () => [K.length, K[K.length - 1] === undefined]', { define: { K }, optimize }).exports.f
      is(f(), [K.length, K[K.length - 1] === undefined], `empty/trailing holes, O${optimize}`)
    }
  }
})

test('options: define rejects cycles and nonliteral values, then compiles again', () => {
  const object = {}, array = []
  object.self = object; array.push(array)
  let reads = 0
  const accessor = { get x() { reads++; return 1 } }
  for (const K of [object, array, new Date(0), new Map(), new Float64Array(1), { fn() {} }, accessor]) {
    throws(() => compile('export const f = () => K', { define: { K } }), /not a compile-time constant/)
    is(jz('export const f = () => K', { define: { K: { x: 9 } } }).exports.f(), { x: 9 }, 'valid input after rejection')
  }
  is(reads, 0, 'reject accessors without executing them')
})

test('template constants preserve literal values at operator and property boundaries', () => {
  is(jz`export const f = () => 1-${-1}`.exports.f(), 2, 'subtraction before a negative value')
  is(jz`export const f = () => 1/${-0}`.exports.f(), -Infinity, 'negative zero')
  is(jz`export const f = () => !${false}`.exports.f(), true, 'boolean operand')
  const data = { 'a-b': 7, text: 'α😀', slots: [,] }
  const f = jz`export const f = () => { const k = ${data}; return [k['a-b'], k.text, k.slots.length] }`.exports.f
  is(f(), [7, 'α😀', 1])
  is(f(), [7, 'α😀', 1], 'repeat')
})

test('options: memory descriptor sets initial and maximum pages', () => {
  const wat = flat(compile(HEAP, { wat: true, memory: { initial: 4, maximum: 16 } }))
  ok(wat.includes('(memory (export "memory") 4 16'), 'min/max on the exported memory')
  throws(() => compile(HEAP, { memory: { initial: 10, maximum: 4 } }), /below the initial/)
})

test('options: invalid memory limits reject before encoding and leave later compiles intact', () => {
  for (const initial of [NaN, Infinity, -Infinity, -1, 0.5, 65537, '2', true]) {
    for (const memory of [initial, { initial }])
      throws(() => compile(HEAP, { memory }), /non-negative integer page count/, `initial ${String(initial)}`)
  }
  for (const maximum of [NaN, Infinity, -Infinity, -1, 0, 0.5, 65537, '2', true])
    throws(() => compile(HEAP, { memory: { maximum } }), /positive integer page count/, `maximum ${String(maximum)}`)
  // Zero requests no extra pages; runtime storage still supplies its minimum.
  for (const initial of [0, 1, 1, 2, 0]) {
    const p = jz(HEAP, { memory: { initial, maximum: 4 } })
    is(p.memory.buffer.byteLength, Math.max(1, initial) * 65536)
    is(p.exports.f(1), 1.5)
  }
  ok(flat(compile(HEAP, { wat: true, memory: { initial: 65536, maximum: 65536 } })).includes('65536 65536'), 'the wasm32 upper boundary remains valid without allocating it in the test')
  is(jz(HEAP).exports.f(1), 1.5, 'default options after explicit limits and rejected values')
})

test('options: memory descriptor imports env.memory', () => {
  const wat = flat(compile(HEAP, { wat: true, memory: { initial: 2, import: true } }))
  ok(wat.includes('(import "env" "memory" (memory 2'), 'memory imported from env')
})

test('options: static data must fit memory.maximum before emitting a module', () => {
  const literal = 'x'.repeat(40000)
  const src = `export function f(){return ${JSON.stringify(literal)}}`
  for (const maximum of [1, 1, 2, 2, 1, 2]) {
    const opts = { optimize: false, memory: { maximum } }
    if (maximum === 1) throws(() => compile(src, opts), /exceeding memory.maximum/)
    else {
      const p = jz(src, opts)
      is(p.exports.f(), literal, 'large data fits two pages')
      is(p.exports.f(), literal, 'same instance preserves its data')
      is(p.memory.buffer.byteLength, 2 * 65536)
    }
  }
  is(jz('export function f(){return "ok"}', { memory: { maximum: 1 } }).exports.f(), 'ok', 'small data after rejected large data')
  is(jz(src, { optimize: false }).exports.f(), literal, 'ordinary compilation after a limited one')
})

test('options: shared memory, by descriptor or by a shared Memory object', () => {
  const byDesc = flat(compile(HEAP, { wat: true, memory: { initial: 2, maximum: 8, shared: true } }))
  ok(/\(import "env" "memory" \(memory [^)]*shared/.test(byDesc), 'descriptor links the shared memtype')
  const mem = new WebAssembly.Memory({ initial: 2, maximum: 8, shared: true })
  const byObject = flat(compile(HEAP, { wat: true, memory: mem }))
  ok(/\(import "env" "memory" \(memory [^)]*shared/.test(byObject), 'a shared Memory object is detected')
})

test('options: optimize object — simd:false leaves no v128', () => {
  if (belowOpt(2)) return
  ok(/v128|f64x2/.test(compile(LOOP, { wat: true })), 'default vectorizes (sanity)')
  ok(!/v128|f64x2|i32x4|f32x4/.test(compile(LOOP, { wat: true, optimize: { simd: false } })), 'simd:false is scalar')
})

test('options: optimize object — tailCall:false uses ordinary call frames', () => {
  ok(/return_call/.test(compile(TAIL, { wat: true })), 'default emits return_call (sanity)')
  ok(!/return_call/.test(compile(TAIL, { wat: true, optimize: { tailCall: false } })), 'tailCall:false')
})

// audit-#11: the wasm2c lane's TargetProfile (src/session.js, the internal host
// 'native') forces the noTailCall policy tailCall:false sets explicitly.
test('options: the internal host native uses ordinary call frames', () => {
  ok(!/return_call/.test(compileInternal(TAIL, { wat: true, host: 'native' })), "host 'native' emits no return_call")
})

test('options: optimize object — exceptions:false drops the exceptions tag', () => {
  ok(/\(tag /.test(compile(THROW, { wat: true })), 'a bare throw keeps the tag by default')
  const wat = compile(THROW, { wat: true, optimize: { exceptions: false } })
  ok(!/\(tag /.test(wat) && /unreachable/.test(wat), 'exceptions:false traps instead')
})

test('options: optimize object — alloc:false omits the allocator exports', () => {
  const wat = compile(GROW, { wat: true })
  ok(/\(export "_alloc"/.test(wat) || /\(export "_clear"/.test(wat), 'a growing array exports the allocator (sanity)')
  const raw = compile(GROW, { wat: true, optimize: { alloc: false } })
  ok(!/\(export "_alloc"/.test(raw) && !/\(export "_clear"/.test(raw), 'alloc:false is the raw ABI')
})

test('options: optimize object — its seven keys; a pass name or a typo refused', () => {
  ok(compile(LOOP, { optimize: { level: 'size' } }).byteLength > 0, 'level:size')
  ok(compile(LOOP, { optimize: { level: 'speed', compact: false, rationalConst: false } }).byteLength > 0, 'compact and rationalConst')
  throws(() => compile(LOOP, { optimize: { level: 'speed', stencil: false } }), /^TypeError: Unknown optimize option 'stencil' \(optimize takes level, simd, tailCall, exceptions, alloc, compact, rationalConst\)$/)
  throws(() => compile(LOOP, { optimize: { levle: 'size' } }), /Unknown optimize option 'levle'; did you mean 'level'\?/)
  throws(() => compile(LOOP, { optimize: { noSimd: true } }), /'noSimd' is not an optimize option: use simd: false/)
  ok(compileInternal(LOOP, { optimize: { level: 'speed', stencil: false } }).byteLength > 0, 'a pass toggle is an internal flag')
})

test('options: why reports declined loops to the warnings callback', () => {
  if (belowOpt(2)) return
  const seen = []
  compile(DEP, { why: true, warnings: w => seen.push(w.code) })
  ok(seen.some(c => c === 'simd-why-not' || c === 'rewind-why-not'), seen.join(','))
  const quiet = []
  compile(DEP, { warnings: w => quiet.push(w.code) })
  ok(!quiet.some(c => c === 'simd-why-not' || c === 'rewind-why-not'), 'declined loops stay unreported without why')
  const r = jz(DEP, { why: true, warnings: () => {} })
  ok(!('warnings' in r), 'jz() leaves the advisories with the callback')
})

test('options: warnings takes a callback and refuses a sink object', () => {
  throws(() => compile(DEP, { warnings: { entries: [] } }), /callback/)
  throws(() => jz(DEP, { warnings: [] }), /callback/)
  ok(compile(DEP, { warnings: undefined }).byteLength > 0, 'an absent callback is no callback')
})

test('options: optimize level takes optimize\'s values; randomSeed takes a number', () => {
  is(compile(LOOP, { optimize: { level: false } }), compile(LOOP, { optimize: false }), 'level:false is off')
  is(compile(LOOP, { optimize: { level: true } }), compile(LOOP, { optimize: true }), 'level:true is optimize:true')
  // (a matrix leg compiles a call that names no level at its own)
  if (process.env.JZ_TEST_OPTIMIZE == null) is(compile(LOOP, { optimize: { level: true } }), compile(LOOP), 'level:true is the default')
  throws(() => compile(HEAP, { randomSeed: true }), /finite number/)
  throws(() => compile(LOOP, { optimize: { level: 'speed', experimentalStencil: false } }), /Unknown optimize option/)
  for (const [v, use] of [[0, 'false'], [1, null], [2, 'true'], [3, "'speed'"], ['fast', null], ['balanced', null]]) {
    throws(() => compile(LOOP, { optimize: v }), new RegExp(`optimize takes true, false, 'size' or 'speed'; got ${typeof v === 'string' ? `'${v}'` : v}${use ? `: use ${use}` : '$'}`), `optimize: ${v}`)
    throws(() => compile(LOOP, { optimize: { level: v } }), /^TypeError: optimize\.level takes true, false, 'size' or 'speed'/, `optimize.level: ${v}`)
  }
})

// The 0.9 spellings and the internal flags are no options: each throws a
// TypeError naming the key, before any compile state is touched.
test('options: a closed set — an unknown key throws naming it, a 0.9 spelling its replacement', () => {
  const refused = (opts, re) => {
    let error
    try { compile(HEAP, opts) } catch (e) { error = e }
    ok(error instanceof TypeError, `${JSON.stringify(opts)}: TypeError, got ${error}`)
    ok(re.test(error.message), `${JSON.stringify(opts)}: ${error.message}`)
    ok(!/\n|jz bug|at line/.test(error.message), `an option error names no source line and no compiler bug: ${error.message}`)
  }
  for (const [key, use] of [['maxMemory', 'memory: { maximum }'], ['importMemory', 'memory: { import: true }'], ['sharedMemory', 'memory: { shared: true }'],
    ['noSimd', 'optimize: { simd: false }'], ['tailCall', 'optimize: { tailCall }'], ['noTailCall', 'optimize: { tailCall: false }'],
    ['alloc', 'optimize: { alloc }'], ['noEhAbort', 'optimize: { exceptions: false }'], ['whyNotSimd', 'why: true with a warnings callback'],
    ['resolve', 'modules'], ['strict', 'a warnings callback']])
    refused({ [key]: key === 'maxMemory' ? 4 : true }, new RegExp(`^'${key}' is not an option: use ${use.replace(/[{}()]/g, '\\$&')}`))
  refused({ optimise: 'speed' }, /^Unknown option 'optimise'; did you mean 'optimize'\? \(options are modules, imports, define, host, memory, optimize, randomSeed, names, sourceMap, wat, warnings, why\)$/)
  for (const key of ['stencil', 'profile', 'inspect', 'sourceType', 'importMetaUrl', 'nativeTimers', '_interp', 'jzify'])
    refused({ [key]: true }, new RegExp(`^Unknown option '${key}'`))
  refused({ memory: { inital: 4 } }, /^Unknown memory option 'inital'; did you mean 'initial'\? \(memory takes initial, maximum, shared, import, fixed\)$/)
  refused({ memory: 'big' }, /^memory takes a non-negative integer page count/)
  refused({ host: 'native' }, /^host takes 'js' or 'wasi'; got 'native'$/)
  refused({ host: 'node' }, /^host takes 'js' or 'wasi'; got 'node'$/)
  refused({ names: 1 }, /^names takes true or false; got 1$/)
  refused({ define: { 'a-b': 1 } }, /^define key 'a-b' is not an identifier a module can declare$/)
  refused({ define: { let: 1 } }, /^define key 'let' is not an identifier/)
  refused({ define: { N: () => 1 } }, /^define\.N is not a compile-time constant/)
  refused({ why: true }, /^why reports through warnings: pass a warnings callback beside it$/)
  refused({ sourceMap: true, optimize: 'speed' }, /^sourceMap requires optimize: false/)
  refused({ modules: { './a.js': 1 } }, /^modules takes/)
  ok(compile(HEAP, { sourceMap: true, optimize: { level: false, tailCall: false } }).sourceMap, 'a debug build takes the engine switches')
  ok(compileInternal(HEAP, { noSimd: true, host: 'native', sourceType: 'module' }).byteLength > 0, 'internal flags through the internal entry')
  throws(() => compileInternal(HEAP, { host: 'node' }), /^TypeError: host takes 'js' or 'wasi'; got 'node'$/, 'the internal entry checks a value before compiling too')
})

test('options: an option error after a failed compile carries no stale source', () => {
  throws(() => compile('export let f = x => eval(x)'))
  let error
  try { compile('export let g = 2', { host: 'node' }) } catch (e) { error = e }
  is(error.message, "host takes 'js' or 'wasi'; got 'node'")
})

test('options: memory limits name memory.maximum', () => {
  throws(() => compile(HEAP, { memory: { maximum: 0 } }), /^RangeError: memory\.maximum takes a positive integer page count/)
  throws(() => compile(HEAP, { memory: { initial: 4, maximum: 2 } }), /^RangeError: memory\.maximum \(2\) is below the initial memory size \(4 pages\)$/)
})

test('options: jz() instantiates — wat refused, an option of neither compile nor instantiate refused', () => {
  throws(() => jz(HEAP, { wat: true }), /^TypeError: jz\(\) instantiates; use compile\(src, \{ wat: true \}\) for text$/)
  throws(() => jz(HEAP, { optimise: 'speed' }), /^TypeError: Unknown option 'optimise'/)
  is(jz(HEAP, { optimize: 'size', memory: { initial: 2 } }).exports.f(1), 1.5)
})

test('options: the caller\'s option object is left untouched', () => {
  const opts = { memory: { initial: 2 }, optimize: { simd: false } }
  compile(HEAP, opts)
  is(JSON.stringify(opts), '{"memory":{"initial":2},"optimize":{"simd":false}}')
})

// A warnings callback runs after the compilation that recorded the entries,
// so it may compile; a callback that runs during compilation (whyNotRewind)
// may not, and says so.
test('options: warning callbacks run after compilation; a nested compile during one is rejected', () => {
  const src = `export let f = (o) => { let s = 0; for (const k in o) s += o[k]; return s }`
  const seen = []
  const wasm = compile(src, { warnings: (w) => { seen.push(w.code); compile('export let g = () => 1') } })
  ok(wasm.length > 0 && seen.length > 0, 'the callback compiled again once its own compilation was over')
  const again = compile(src, { warnings: () => {} })
  is(again.length, wasm.length, 'the nested compile left the outer output intact')
  let error
  try { compileInternal('let kept=[];export let f=n=>{kept.push([n]);return kept.length}', { optimize: 'speed', whyNotRewind: () => { compile('export let g = () => 1') } }) } catch (e) { error = e }
  ok(error && /while a compilation is active/.test(error.message), `nested compile rejected: ${error?.message}`)
})
