// Range-proof regressions for guarded typed-array indices. The kernel is the
// generic shape: an otherwise-unbounded machine-i32 coordinate is bounded by
// conjuncts, the boolean is stored in a const, and a later branch reuses it.
import test from 'tst'
import parseWat from 'watr/parse'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { onKernel, levels } from './_matrix.js'
import { funcWat, oracle } from './util.js'
import { scanIntervalIdx } from '../src/type/interval-proof.js'
import { scanBoundedArrIdx } from '../src/type/canonical-bounds.js'
import { typedIdxProven } from '../src/type/loop-versioning.js'
import { ctx } from '../src/ctx.js'
import { createActiveFunction } from '../src/compile/active-function.js'

test('interval proof: returning branches retain only the live continuation range', () => {
  for (const exit of ['return', 'throw']) for (const branch of [2, 3]) {
    const call = ['()', 'take', ['-', 'n', 1]]
    const arms = branch === 2 ? [[exit, 0], [';']] : [[';'], [exit, 0]]
    const body = [';', ['if', [branch === 2 ? '<=' : '>', 'n', 0], ...arms], call]
    const calls = new Map([[call, undefined]]), prior = ctx.func
    ctx.func = createActiveFunction({ body })
    try { scanIntervalIdx(body, null, () => null, null, calls, new Map([['n', [-2147483648, 2147483647]]])) }
    finally { ctx.func = prior }
    is(calls.get(call), [[0, 2147483646]], `${exit} in arm ${branch}: the continuation requires n > 0`)
  }
})

test('interval proof: rounding identities and bounded shift counts preserve exact words', () => {
  const examples = [
    ...['ceil', 'floor', 'trunc', 'round'].map(name => [['()', 'math.' + name, 'n'], new Map([['n', [-7, 7]]]), [-7, 7]]),
    [['()', 'math.ceil', [null, -0]], null, null],
    [['()', 'math.floor', 'n'], new Map([['n', null]]), null],
    [['<<', 1, 'n'], new Map([['n', [8, 11]]]), [256, 2048]],
    [['<<', -1, 'n'], new Map([['n', [8, 11]]]), [-2048, -256]],
    [['<<', 1, 'n'], new Map([['n', [30, 31]]]), null],
    [['<<', 1, 'n'], new Map([['n', [0, 32]]]), null],
  ]
  const prior = ctx.func
  try { for (const [arg, entry, expected] of examples) {
    const call = ['()', 'take', arg], body = [';', call], calls = new Map([[call, undefined]])
    ctx.func = createActiveFunction({ body })
    scanIntervalIdx(body, null, () => null, null, calls, entry)
    is(calls.get(call), [expected], JSON.stringify(arg))
  } } finally { ctx.func = prior }
})

test('interval proof: pure shifted bounds keep word storage separate from their intermediates', () => {
  for (const [op, insideWant, exitWant] of [
    ['-', [1, 2147483645], [1, 2147483646]],
    ['+', [1, 2147483647], null],
  ]) {
    const inside = ['()', 'take', 'i'], after = ['()', 'take', 'i']
    const scalar = ['()', 'take', [',', 0, ['-', ['+', 'n', 1], 1]]]
    const body = [';', ['let', ['=', 'i', 1]],
      ['while', ['<', 'i', [op, 'n', 1]], [';', inside, ['++', 'i']]], after, scalar]
    const prior = ctx.func, globals = ctx.scope.globalTypes
    ctx.func = createActiveFunction({ body })
    ctx.scope.globalTypes = new Map()
    try {
      const calls = new Map([[inside, undefined], [after, undefined], [scalar, undefined]]), bindings = new Map([['i', undefined]])
      scanIntervalIdx(body, null, () => null, null, calls,
        new Map([['n', [-2147483648, 2147483647]]]), null, null, bindings)
      is(calls.get(inside), [insideWant], `${op}: the body excludes the bound`)
      is(calls.get(after), [exitWant], `${op}: the final increment remains visible`)
      is(bindings.get('i'), exitWant, `${op}: a wide landing cannot narrow the binding`)
      is(calls.get(scalar), [[0, 0], null], 'wide intermediate mode never enters scalar call arguments')
    } finally { ctx.func = prior; ctx.scope.globalTypes = globals }
  }
})

test('interval proof: unknown bindings survive sparse control-flow snapshots', () => {
  const cases = [
    ['bare declaration', ['let', 'x'], null],
    ['unknown parameter', [';'], null, null],
    ['invalidated global', ['()', 'mutate'], null, [0, 0]],
    ['one-sided definition', [';', ['let', 'x'], ['if', 'flag', ['=', 'x', 1]]], null],
    ['two-sided definition', ['if', 'flag', ['=', 'x', 1], ['=', 'x', 2]], [1, 2]],
    ['unknown branch', [';', ['let', ['=', 'x', 0]], ['if', 'flag', ['=', 'x', 'unknown']]], null],
    ['zero-work definition', [';', ['let', 'x'], ['for', ['let', ['=', 'i', 0]], ['<', 'i', 0], ['++', 'i'], ['=', 'x', 1]]], null],
    ['captured write', [';', ['let', ['=', 'x', 0]], ['=>', [], ['=', 'x', 'unknown']]], null],
    ['destructured definition', ['let', ['=', ['[', 'x'], 'values']], null],
    ['exceptional write', [';', ['let', ['=', 'x', 0]], ['catch', ['=', 'x', 1], ['=', 'x', 'unknown']]], null],
  ]
  const previous = ctx.func, constants = ctx.scope.constInts, globals = ctx.scope.globalTypes
  try {
    // A rejected local constant must not expose a same-named outer constant
    // when a branch restores an unknown binding without a range-map entry.
    ctx.scope.constInts = new Map([['x', 3]])
    for (const [name, statements, expected, input] of cases) {
      const call = ['()', 'take', 'x'], read = ['[]', 'src', 'x'], body = [';', statements, call, read]
      ctx.func = createActiveFunction({ body })
      ctx.func.localReps = new Map([['x', { intConst: Infinity }]])
      ctx.scope.globalTypes = name === 'invalidated global' ? new Map([['x', 'f64']]) : globals
      const calls = new Map([[call, undefined]]), out = new Set(), bindings = new Map([['x', undefined]])
      const entry = new Map([['flag', null]])
      if (input !== undefined) entry.set('x', input)
      scanIntervalIdx(body, out, n => n === 'src' ? 4 : null, null, calls, entry, null, null, bindings)
      is(calls.get(call), [expected], `${name}: scalar call hull`)
      is(out.has(read), !!expected, `${name}: unknown does not become a proven index`)
    }
  } finally { ctx.func = previous; ctx.scope.constInts = constants; ctx.scope.globalTypes = globals }
})

test('interval proof: shadowed missing indices and exception reuse match JavaScript', () => {
  const src = `const index = 0
    export function f(mode, empty) {
      const a = new Int32Array(empty ? 0 : 1); if (!empty) a[0] = 7
      let index
      if (mode === 1) index = 0
      if (mode === 2) { try { index = 0; throw 1 } catch(e) { index = undefined } }
      const reset = () => { index = undefined }
      if (mode === 3) { index = 0; reset() }
      return [a[index], index]
    }`
  const want = oracle(src)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const got = jz(src, { optimize }).exports
    for (const mode of [0, 1, 1, 2, 3, 0, 1]) for (const empty of [0, 1])
      is(got.f(mode, empty), want.f(mode, empty), `O${optimize}: mode ${mode}, empty ${empty}`)
  }
})

test('interval proof: monotone counter sign bounds remainder without an i32 counter hull', () => {
  const cases = [
    ['unit', 0, ['++', 'i'], null, 6, [0, 5]],
    ['stride', 1, ['+=', 'i', 3], null, 6, [0, 5]],
    ['commuted', 0, ['=', 'i', ['+', 2, 'i']], null, 6, [0, 5]],
    ['negative zero', -0, ['++', 'i'], null, 6, null],
    ['negative start', -1, ['++', 'i'], null, 6, null],
    ['fractional step', 0, ['+=', 'i', 0.5], null, 6, null],
    ['zero divisor', 0, ['++', 'i'], null, 0, null],
    ['body write', 0, ['++', 'i'], ['=', 'i', -6], 6, null],
    ['captured write', 0, ['++', 'i'], ['=>', [], ['=', 'i', -6]], 6, null],
    ['condition write', 0, ['++', 'i'], null, 6, null, ['<', ['=', 'i', -6], 'n']],
    ['redeclaration', 0, ['++', 'i'], ['let', ['=', 'i', -6]], 6, null],
    ['later initializer write', 0, ['++', 'i'], null, 6, null, null, ['let', ['=', 'i', 0], ['=', 'j', ['=', 'i', -6]]]],
    ['later initializer negative zero', 0, ['++', 'i'], null, 6, null, null, ['let', ['=', 'i', 0], ['=', 'j', ['=', 'i', -0]]]],
  ]
  for (const [name, start, step, effect, divisor, want, condition, init] of cases) {
    const read = ['()', 'take', ['%', 'i', divisor]], counter = ['()', 'take', 'i']
    const after = ['()', 'take', ['%', 'i', divisor]]
    const loop = ['for', init ?? ['let', ['=', 'i', start]], condition ?? ['<', 'i', 'n'], step,
      [';', ...(effect ? [effect] : []), read, counter]]
    const body = [';', loop, after], calls = new Map([[read, undefined], [counter, undefined], [after, undefined]])
    const prior = ctx.func
    ctx.func = createActiveFunction({ body })
    try { scanIntervalIdx(body, null, () => null, null, calls) }
    finally { ctx.func = prior }
    is(calls.get(read), [want], `${name}: remainder hull`)
    if (want) {
      is(calls.get(counter), [null], 'a sign proof does not claim an i32 counter bound')
      is(calls.get(after), [null], 'the counter sign does not escape its lexical loop')
    }
  }
})

test('interval proof: assignment-valued indices retain bounds and execute mutations once', () => {
  for (const initial of [0, 0, 3, 4, -1]) {
    const first = ['[]', 'a', ['=', 'x', ['++', 'i']]], next = ['[]', 'a', 'x']
    const body = [';', ['let', ['=', 'i', initial]], first, next]
    const proven = new Set(), ranges = new Map()
    scanIntervalIdx(body, proven, name => name === 'a' ? 4 : null, ranges)
    is(proven.has(first), initial >= -1 && initial < 3, `assignment result from ${initial}`)
    is(proven.has(next), initial >= -1 && initial < 3, `subsequent binding from ${initial}`)
  }
  const src = `export function f(start) {
    const a=new Int32Array([7,11,13,17]); let i=start|0,x=0;
    const first=a[x=++i],next=a[x]; return [first,next,i,x]
  }`
  const native = oracle(src).f
  for (const optimize of levels(0, 2, 3, 'size')) {
    const f = jz(src, { optimize }).exports.f
    for (const start of [-2, -1, 0, 2, 3, 4, 2147483647])
      is(f(start), native(start), `O${optimize}: assignment index after ${start}`)
  }
})

test('interval proof: existing bounds do not trigger a whole-body interval scan', () => {
  if (onKernel()) return
  for (const length of [1, 4, 4, 0, 1]) {
    compile('')
    const prior = ctx.func
    const idx = ['+', 'i', 0], access = ['[]', 'dst', idx], twin = ['[]', 'dst', idx]
    const body = [';', ['for', ['let', ['=', 'i', 0]], ['<', 'i', length], ['++', 'i'], access], twin]
    ctx.func = createActiveFunction({ body })
    ctx.func.typedLen = new Map([['dst', length]])
    try {
      if (length) {
        is(typedIdxProven('dst', length - 1), true, 'the final valid constant index is proven')
        is(typedIdxProven('dst', ['&', 'x', length - 1]), true, 'a fitting mask is proven')
      }
      ctx.facts.guardProven.add(access)
      is(typedIdxProven('dst', idx, access), true, 'a guarded occurrence uses its own proof')
      ok(!ctx.facts.ipProven.has(body), 'existing proofs leave interval analysis unallocated')
      ctx.facts.guardProven.delete(access)
      is(typedIdxProven('dst', idx, access), length > 0, 'a compound loop index falls back to occurrence analysis')
      ok(ctx.facts.ipProven.has(body), 'a missing proof invokes the interval interpreter')
      is(typedIdxProven('dst', idx, twin), false, 'the out-of-bounds twin cannot borrow the occurrence proof')
      is(typedIdxProven('dst', -1), false, 'negative indices are rejected')
      is(typedIdxProven('dst', length), false, 'the final boundary is rejected, including an empty array')
      is(typedIdxProven(null, 0), false, 'an unknown receiver supplies no proof')
    } finally { ctx.func = prior }
  }
})

test('interval proof: canonical access nodes do not require structural keys', () => {
  const access = ['[]', 'dst', 'i'], captured = ['[]', 'dst', 'i']
  for (const start of [0, 0, -1]) {
    const body = ['for', ['let', ['=', 'i', start]], ['<', 'i', ['.', 'dst', 'length']], ['++', 'i'],
      [';', access, ['=>', 'x', captured]]]
    const nodes = new Set()
    scanBoundedArrIdx(body, null, null, nodes)
    is([...nodes], start < 0 ? [] : [access], 'only the direct read under a nonnegative induction is proven')
  }
  const nodes = new Set()
  scanBoundedArrIdx([';'], null, null, nodes)
  is(nodes.size, 0, 'an empty body supplies no proof')
})

test('interval proof: scalar and missing-access results do not require an access-proof sink', () => {
  for (const limit of [0, 1, 4, 4, 2, 5]) for (const out of [new Set(), null]) {
    const access = ['[]', 'dst', 'i']
    const call = ['()', 'take', 'i'], store = ['=', access, ['+', 'i', 1]]
    const body = ['for', ['let', ['=', 'i', 0]], ['<', 'i', limit], ['++', 'i'], [';', call, store]]
    const calls = new Map([[call, undefined]]), stores = new Map([[store, undefined]]), misses = new Map()
    scanIntervalIdx(body, out, name => name === 'dst' ? 4 : null, null, calls, null, stores, misses)
    is(calls.get(call), [limit ? [0, limit - 1] : null], `argument hull, limit ${limit}`)
    is(stores.get(store), limit ? [1, limit] : null, `stored value hull, limit ${limit}`)
    if (limit > 4) is(misses.get(access), [0, limit - 1, 4], 'the boundary miss retains its complete index hull')
    else if (limit) ok(!misses.has(access), 'every executed access fits')
  }
  scanIntervalIdx([';'], null, () => null, null)
})

const GUARD = 'x >= 0 && x < 4 && y >= 0 && y < 4 && src[y * 4 + x] === 1'
const KERNEL = `
export let mark = (ax, ay) => {
  const xy = new Int32Array(2)
  const pixels = new Uint8Array(16)
  const src = pixels, dst = pixels
  xy[0] = ax; xy[1] = ay; pixels[5] = 1
  const x = xy[0], y = xy[1]
  const inside = ${GUARD}
  if (inside) dst[y * 4 + x] = 7
  return pixels[5] * 10 + pixels[10]
}`

const INLINE = KERNEL.replace(`  const inside = ${GUARD}\n  if (inside)`, `  if (${GUARD})`)
const LET_FLAG = KERNEL.replace(
  `  const inside = ${GUARD}`,
  `  let inside = ${GUARD}\n  if (ax === 123) inside = true`)
const STALE_DEP = `
export let mark = (ax, ay) => {
  const xy = new Int32Array(2)
  const pixels = new Uint8Array(16)
  const src = pixels, dst = pixels
  xy[0] = ax; xy[1] = ay; pixels[5] = 1
  let x = xy[0]
  const y = xy[1]
  const inside = ${GUARD}
  x += 16
  if (inside) dst[y * 4 + x] = 7
  return pixels[5] * 10 + pixels[10]
}`
const REPEATED_KEY = `
export let mark = (ax, ay) => {
  const xy = new Int32Array(2)
  const pixels = new Uint8Array(16)
  xy[0] = ax; xy[1] = ay; pixels[5] = 1
  const x = xy[0], y = xy[1]
  const inside = x >= 0 && x < 4 && y >= 0 && y < 4 && pixels[y * 4 + x] === 1
  if (inside) pixels[y * 4 + x] = 7
  if (ax === 123) pixels[y * 4 + x] = 9
  return pixels[5] * 10 + pixels[10]
}`
const EFFECTFUL_GUARD = `
let ticks = 0
const note = () => { ticks++; return true }
export let mark = (ax, ay) => {
  const xy = new Int32Array(2)
  const pixels = new Uint8Array(16)
  const src = pixels, dst = pixels
  xy[0] = ax; xy[1] = ay; pixels[5] = 1
  const x = xy[0], y = xy[1]
  const inside = x >= 0 && x < 4 && y >= 0 && y < 4 && note() && src[y * 4 + x] === 1
  if (inside) dst[y * 4 + x] = 7
  return ticks * 100 + pixels[5] * 10 + pixels[10]
}`
const CALL_MUTATION = `
let gx = 1
const move = () => { gx = 20 }
export let mark = () => {
  const pixels = new Uint8Array(4)
  const src = pixels, dst = pixels
  pixels[1] = 1
  const inside = gx >= 0 && gx < 4 && src[gx] === 1
  move()
  if (inside) dst[gx] = 7
  return pixels[1]
}`
const F64_COORDS = `
export let mark = (x, y) => {
  const pixels = new Uint8Array(16)
  const src = pixels, dst = pixels
  pixels[5] = 1
  const inside = ${GUARD}
  if (inside) dst[y * 4 + x] = 7
  return pixels[5] * 10 + pixels[10]
}`
const OR_GUARD = KERNEL.replace('x >= 0 && x < 4', '(x >= 0 || x < 4)')
const OVERFLOW_INDEX = KERNEL.replaceAll('y * 4 + x', 'y * 1073741824 + x')
const AFFINE_WRAP_GUARD = KERNEL.replace(
  'x >= 0 && x < 4',
  'x + 2147483647 >= 0 && x + 2147483647 < 4')

const sameOutput = (a, b) => typeof a === 'string' ? a === b
  : a.length === b.length && a.every((x, i) => x === b[i])
const assertCompileHistoryIndependent = (src, predecessors, opts, label) => {
  const cold = compile(src, opts)
  for (const prior of predecessors) {
    compile(prior, opts)
    const warm = compile(src, opts)
    ok(sameOutput(cold, warm), `${label}: matches cold output after a sibling compile`)
  }
}
const hasTypedBoundsTemp = wat => /\$[^\s)]*(?:tb[in]|ixv)\d*/.test(wat)
// Match the guard's tree, not a character window: exact f64 index validation
// can sit between the unsigned bounds test and its load or store. Wide keys
// compare their full i64 value before narrowing the memory address.
const someWat = (n, test) => Array.isArray(n) && (test(n) || n.some(c => someWat(c, test)))
const hasCheckedTypedAccess = wat => hasTypedBoundsTemp(wat) || parseWat(wat).some(f =>
  Array.isArray(f) && f[0] === 'func' && /^\$(?!__)/.test(f[1]) && someWat(f, n => {
    if (n[0] !== 'if') return false
    const at = n[1]?.[0] === 'result' ? 2 : 1
    return (n[at]?.[0] === 'i32.lt_u' || n[at]?.[0] === 'i64.lt_u') && n[at + 1]?.[0] === 'then' &&
      someWat(n[at + 1], x => /^(?:f32|f64|i32|i64)\.(?:load|store)/.test(x[0]))
  }))

test('interval proof: control-flow joins retain unknown and out-of-bounds paths', () => {
  for (const branch of [
    'if (c) i = n; else i = 1',
    'c ? i = n : i = 1',
    'c && (i = n)',
    'c || (i = n)',
    'while (n-- > 0) { if (c) { i = 6; break } i = 2 }',
  ]) {
    const src = `const a = new Int32Array([11, 22, 33, 44]);
      export function f(c, n) { let i = 0; ${branch}; return a[i] ?? -1 }`
    const js = oracle(src)
    for (const optimize of levels(0, 2, 3)) {
      const wasm = jz(src, { optimize }).exports
      for (const c of [0, 1, 1, 0]) for (const n of [-1, 0, 1, 3, 4, 8])
        is(wasm.f(c, n), js.f(c, n), `O${optimize}: ${branch}, c=${c}, n=${n}`)
    }
  }
})

const tableWalk = (table, edit = '', length = 4) => `
function fill(a, n) {
  const table = ${table}
  ${edit}
  for (let i = 0; i < table.length; i++) a[i] = table[i] | 0
}
function follow(a, remaining) {
  let cursor = 0, total = 0
  while (cursor < 4 && remaining > 0) {
    const value = a[cursor]
    total += value
    cursor = value
    remaining--
  }
  return total
}
export function f(n) { const a = new Int32Array(${length}); fill(a, n); return follow(a, n) }
`

const copiedTable = (ctor, edit = '', length = 8) => `
function fill(a) { for (let i = 0; i < 8; i++) a[i] = i % 5 }
function move(a, k) { const t = a[k]; a[k] = a[0]; a[0] = t; ${edit} }
function gather(a, n) { const x = +a[n & 7]; return a[x] + a[x + 1] }
export function f(n, k) {
  const a = new ${ctor}(${length})
  fill(a); move(a, k | 0)
  return gather(a, n)
}
`

test('interval proof: element copies preserve stored bounds through helpers and numeric conversion', () => {
  for (const ctor of ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array']) {
    const src = copiedTable(ctor), native = oracle(src).f
    for (const level of levels(0, 2, 3, 'size')) {
      const f = jz(src, { optimize: { level, sourceInline: false } }).exports.f
      for (const k of [-1, 0, 0, 1, 7, 8, 99]) for (const n of [-1, 0, 1, 7, 8])
        is(f(n, k), native(n, k), `${ctor}/O${level}: gather ${n} after moving ${k}`)
    }
  }
  if (onKernel()) return
  const src = copiedTable('Int32Array'), optimize = { level: 'speed', sourceInline: false, watr: false }
  const inspect = compile(src, { optimize, inspect: true }).inspect
  is(inspect.functions.gather.params[0].arrayElemRange, [0, 4], 'copies retain the fill hull, including missing-read zero')
  const body = funcWat(compile(src, { optimize, wat: true }), 'gather')
  ok(body.includes('i32.load'), 'the dependent reads remain')
  ok(!body.includes('i32.lt_u'), 'both dependent reads use the preserved bounds')
})

test('interval proof: copy hulls reject named reads, replacement values and other arrays', () => {
  const edits = [
    'a.note = 99; a[0] = a["note"]',
    'let x = a[1]; x = 99; a[0] = x',
    'let x = a[1]; const modify = () => { x = 99 }; modify(); a[0] = x',
    'const b = new Int32Array([99]); a[0] = b[0]',
    'a[0] += 99',
  ]
  const sources = edits.map(edit => copiedTable('Int32Array', edit))
  sources.push(copiedTable('Int32Array', '', 0))
  for (const [ctor, values] of [['Int32Array', '[2, 3]'], ['Int32Array', '[-2147483648, 2147483647]'], ['Uint32Array', '[2147483648, 4294967295]']])
    sources.push(copiedTable(ctor).replace(`${ctor}(8)`, `${ctor}(${values})`)
      .replace('fill(a); ', '').replace('return gather(a, n)', 'return [a[0], a[1]]'))
  for (const src of sources) {
    const native = oracle(src).f
    for (const level of levels(0, 2, 3, 'size')) {
      const f = jz(src, { optimize: { level, sourceInline: false } }).exports.f
      for (const k of [-1, 0, 7, 8]) for (const n of [0, 1, 7])
        is(f(n, k), native(n, k), `O${level}: gather ${n} after moving ${k}`)
    }
  }
})

test('interval proof: immutable table bounds survive fill helpers and dependent reads', () => {
  const src = tableWalk('[1, 2, 3, 2147483647]')
  const native = oracle(src).f
  for (const optimize of levels(0, 2, 3, 'size')) {
    const wasm = jz(src, { optimize }).exports.f
    for (const n of [0, 0, 1, 2, 3, 4, 8, 0, 4])
      is(wasm(n), native(n), `O${optimize}: ${n} dependent reads preserve the full sum`)
  }
  if (onKernel()) return
  const f = compile(src, { optimize: 2, inspect: true }).inspect.functions.follow
  const local = name => Object.entries(f.locals).find(([key]) => key.startsWith(name))[1]
  is(f.params[0].arrayElemRange, [0, 2147483647], 'the fill carries its closed stored-value hull')
  is(local('cursor').type, 'i32', 'the loop condition closes the cursor bounds')
  is(local('value').type, 'i32', 'proven-present reads retain their integer carrier')
  is(local('total').type, 'f64', 'integer payloads do not bound an accumulating result')
})

test('interval proof: table mutation, missing entries and word boundaries stay conservative', () => {
  const sources = [
    tableWalk('[]'),
    tableWalk('[1, 2, 3, 2147483647]', '', 0),
    tableWalk('[1, 2, 3, -2147483648]'),
    tableWalk('[1, 2, 3, 2147483648]'),
    tableWalk('[1, 2, 3, 4294967295]'),
    tableWalk('[1, , 3, 2147483647]'),
    tableWalk('[1, NaN, Infinity, -0]'),
    tableWalk('[1, 2, 3, 2147483647]', 'table[2] = -1'),
    tableWalk('[1, 2, 3, 2147483647]', 'const alias = table; alias[2] = -1'),
    tableWalk('[1, 2, 3, 2147483647]', 'const change = () => { table[2] = -1 }; change()'),
    tableWalk('[1, 2, 3, 2147483647]', 'table.push(-1)'),
    tableWalk('[1, 2, 3, 2147483647]', 'table[2] = 1.5'),
    tableWalk('[1, 2, 3, 2147483647]', 'let key = n & 3; delete table[key]'),
    tableWalk('[1, 2, 3, 2147483647]', 'function erase(p, key) { delete p[key] }; erase(table, n & 3)'),
    tableWalk('[1, 2, 3, 2147483647]', 'function edit(p, q = p) { q[2] = -1 }; edit(table)'),
    tableWalk('[1, 2, 3, 2147483647]', 'function edit(p, q = { p }) { q.p[2] = -1 }; edit(table)'),
    tableWalk('[1, 2, 3, 2147483647]', 'function leak(p) { throw p }; try { leak(table) } catch (p) { p[2] = -1 }'),
  ]
  for (const optimize of levels(0, 2, 3, 'size')) for (const src of sources) {
    const native = oracle(src).f, wasm = jz(src, { optimize }).exports.f
    for (const n of [0, 0, 1, 4, 8, 0, 4])
      ok(Object.is(wasm(n), native(n)), `O${optimize}, n=${n}: ${src.split('\n')[2].trim()}`)
  }
})

test('interval proof: table ranges do not survive a different compilation', () => {
  const src = tableWalk('[1, 2, 3, 2147483647]')
  const other = tableWalk('[1, 2, 3, -2147483648]')
  for (const optimize of levels(0, 2, 3, 'size'))
    assertCompileHistoryIndependent(src, [src, other, tableWalk('[]'), other], { optimize }, `O${optimize} table bounds`)
})

const relayedElements = length => `
function seed(a, n) {
  for (let i = 0; i < a.length; i++) a[i] = (i + (n & 3)) & ${Math.max(0, length - 1)}
}
function put(a, k, value) { a[k] = value }
function relay(a, b) { for (let i = 0; i < a.length; i++) put(b, i, a[i]) }
function read(a, k) { return a[a[k]] }
function checksum(a) {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum = sum * 7 + read(a, i)
  return sum
}
export function f(n) {
  const a = new Int32Array(${length}), b = new Int32Array(${length})
  seed(a, n); relay(a, b); return checksum(b)
}`

test('interval proof: element and scalar bounds cross calls and return to typed storage', () => {
  for (const length of [0, 1, 4]) {
    const src = relayedElements(length), native = oracle(src).f
    for (const level of levels(0, 2, 3, 'size')) {
      const f = jz(src, { optimize: { level, sourceInline: false } }).exports.f
      for (const n of [0, 0, 1, 3, 4, -1, 0])
        is(f(n), native(n), `O${level}: ${length} elements, offset ${n}`)
    }
  }
  if (onKernel()) return
  const src = relayedElements(4), optimize = { level: 'speed', sourceInline: false, watr: false }
  const { functions } = compile(src, { optimize, inspect: true }).inspect
  is(functions.put.params[1].range, [0, 3], 'the caller counter bounds the store index')
  is(functions.put.params[2].range, [0, 3], 'a bounded element becomes a bounded scalar parameter')
  is(functions.read.params[0].arrayElemRange, [0, 3], 'the scalar parameter bounds the destination elements')
  is(functions.read.params[1].range, [0, 3], 'the final helper receives the complete counted index hull')
  const body = funcWat(compile(src, { optimize, wat: true }), 'read')
  ok(body.includes('i32.load'), 'the dependent element reads remain live')
  ok(!body.includes('i32.lt_u'), 'both dependent reads use the bounds propagated through calls')
})

test('interval proof: callee writes join allocation ranges before proving dependent reads', () => {
  const sources = [
    `function get(a) { a[0] = 7; return a[a[0]] ?? -1 }
     export function f() { return get(new Int32Array(4)) }`,
    `function get(a) { const alias = a; alias[0] = 7; return a[a[0]] ?? -1 }
     export function f() { return get(new Int32Array(4)) }`,
    `function change(a) { a[0] = 7 }
     function get(a) { change(a); return a[a[0]] ?? -1 }
     export function f() { return get(new Int32Array(4)) }`,
    `function get(a, b = (a[0] = 7)) { return a[a[0]] ?? -1 }
     export function f() { return get(new Int32Array(4)) }`,
    `function get(a, b = a) { b[0] = 7; return a[a[0]] ?? -1 }
     export function f() { return get(new Int32Array(4)) }`,
    `function get(a, b = { a }) { b.a[0] = 7; return a[a[0]] ?? -1 }
     export function f() { return get(new Int32Array(4)) }`,
    `function get(a) { return a[a[0]] ?? -1 }
     export function f() {
       const a = new Int32Array(4), b = new Int32Array(a.buffer)
       b[0] = 7; return get(a)
     }`,
    `function get(a) { return a[a[0]] ?? -1 }
     export function f() {
       const a = new Int32Array(4), b = new Int32Array(a?.['buffer'])
       b[0] = 7; return get(a)
     }`,
    `function get(a) { const alias = a ?? new Int32Array(0); alias[0] = 7; return a[a[0]] ?? -1 }
     export function f() { return get(new Int32Array(4)) }`,
    `function get(a) { return a[a[0]] ?? -1 }
     function edit(box) { box.a[0] = 7 }
     export function f() {
       const a = new Int32Array(4), box = { a }
       edit(box); return get(a)
     }`,
    `function get(a) { return a[a[0]] ?? -1 }
     export function f() {
       const change = () => { a[0] = 7 }
       const a = new Int32Array(4)
       change(); return get(a)
     }`,
  ]
  for (const step of ['a[0]++', '++a[0]', 'a[0]--', '--a[0]'])
    sources.push(`function get(a) { a[0] = ${step.includes('++') ? 3 : 0}; ${step}; return a[a[0]] ?? -1 }
      export function f() { return get(new Int32Array(4)) }`)
  for (const [i, src] of sources.entries()) {
    const native = oracle(src).f
    for (const level of levels(0, 2, 3, 'size')) {
      const f = jz(src, { optimize: { level, sourceInline: false } }).exports.f
      is(f(), native(), `O${level}: callee write ${i}`)
      is(f(), native(), `O${level}: repeated callee write ${i}`)
    }
  }
})

test('interval proof: conditional receivers and optional calls cannot hide typed writes', () => {
  const bodies = [
    `function edit(k, ...rest) { rest[k][0] = 7 }
     export function f(n) { const a = new Int32Array(4); edit(n & 1, a, a); return get(a) }`,
    `function edit(k, a, b) { (k ? a : b)[0] = 7 }
     export function f(n) {
       const a = new Int32Array(4), b = new Int32Array(4)
       edit(n & 1, a, b); return [get(a), get(b)]
     }`,
    `export function f(n) {
       const a = new Int32Array(4), b = new Int32Array(4);
       (n & 1 ? a : b)[0] = 7; return [get(a), get(b)]
     }`,
    `function edit(a) { a[0] = 7 }
     function forward(a) { edit?.(a) }
     export function f(n) { const a = new Int32Array(4); forward(a); return get(a) }`,
    `function edit(a) { a[0] = 7 }
     export function f(n) { const a = new Int32Array(4); edit?.(a); return get(a) }`,
    `function edit(a) { a[0] = 7 }
     function forward(a, enabled) { const write = enabled ? edit : null; write?.(a) }
     export function f(n) { const a = new Int32Array(4); forward(a, n & 1); return get(a) }`,
  ]
  for (const [i, body] of bodies.entries()) {
    const src = `function get(a) { return a[a[0]] ?? -1 }\n${body}`, native = oracle(src).f
    for (const level of levels(0, 2, 3, 'size')) {
      const f = jz(src, { optimize: { level, sourceInline: false } }).exports.f
      for (const n of [0, 0, 1, 0, 1])
        is(f(n), native(n), `O${level}: hidden writer ${i}, selector ${n}`)
    }
  }
})

test('interval proof: optional calls invalidate plain-array length invariants', () => {
  const bodies = [
    `function forward(a) { grow?.(a) }
     export function f() { const a = [1]; forward(a); return length(a) }`,
    `export function f() { const a = [1]; grow?.(a); return length(a) }`,
    `function make() { const a = [1]; grow?.(a); return a }
     export function f() { return length(make()) }`,
  ]
  for (const [i, body] of bodies.entries()) {
    const src = `function grow(a) { a.push(7) }
      function length(a) { return a.length }\n${body}`, native = oracle(src).f
    for (const level of levels(0, 2, 3, 'size')) {
      const f = jz(src, { optimize: { level, sourceInline: false } }).exports.f
      is(f(), native(), `O${level}: optional array growth ${i}`)
      is(f(), native(), `O${level}: repeated optional array growth ${i}`)
    }
  }
})

test('interval proof: parameter length caches follow defaults and reject rebinding', () => {
  const sources = [
    `function get(a, b = a, c = b[3]) { return [b[0], c, b[b[0]] ?? -1] }
     export function f(n) {
       const a = new Int32Array(n)
       if (n) a[0] = 7
       return [get(a), get(a, new Int32Array([1, 2, 3, 4])), get(a)]
     }`,
    `function get(a, b = (a = new Int32Array([1, 2, 3, 4]))) { return [a[0], a[3]] }
     export function f(n) { return get(new Int32Array(n)) }`,
  ]
  for (const [i, src] of sources.entries()) {
    const native = oracle(src).f
    for (const level of levels(0, 2, 3, 'size')) for (const watr of [false, true]) {
      const f = jz(src, { optimize: { level, sourceInline: false, watr } }).exports.f
      for (const n of [0, 1, 1, 4, 0])
        is(f(n), native(n), `O${level}, watr=${watr}: default sequence ${i}, length ${n}`)
    }
  }
})

test('interval proof: nullable parameter lengths stay behind their presence guards', () => {
  const sources = [
    `function read(a) { if (!a) return -2; return a[a[0]] ?? -1 }
     export function f(mode, n) { if (mode) var a = new Int32Array(n); return read(a) }`,
    `function read(a) { if (!a) return -2; return a[a[0]] ?? -1 }
     export function f(mode, n) {
       const a = mode === 0 ? null : mode === 1 ? undefined : new Int32Array(n)
       return read(a)
     }`,
    `function read(a, enabled) { if (!enabled) return -2; return a[a[0]] ?? -1 }
     export function f(mode, n) { return read(mode ? new Int32Array(n) : undefined, mode) }`,
    `function read(a = new Int32Array(0)) { if (!a) return -2; return a[a[0]] ?? -1 }
     export function f(mode, n) {
       if (mode === 0) return read(null)
       if (mode === 1) return read()
       return read(new Int32Array(n))
     }`,
  ]
  for (const [i, src] of sources.entries()) {
    const native = oracle(src).f
    for (const level of levels(0, 2, 3, 'size')) for (const watr of [false, true]) {
      const f = jz(src, { optimize: { level, sourceInline: false, watr } }).exports.f
      for (const [mode, n] of [[0, 0], [0, 1], [1, 0], [2, 0], [2, 1], [2, 4], [0, 4], [2, 4]])
        is(f(mode, n), native(mode, n), `O${level}, watr=${watr}: nullable receiver ${i}, mode ${mode}, length ${n}`)
    }
  }
})

test('interval proof: an unknown incoming array opens every forwarded element range', () => {
  const src = `
    function get(a) { return a[a[0]] ?? -1 }
    function forward(a) { return get(a) }
    export function f(x) {
      const b = new Int32Array(4); b[0] = x
      return [forward(new Int32Array(4)), forward(b)]
    }`
  for (const source of [src, src.replace('forward(new Int32Array(4)), forward(b)', 'forward(b), forward(new Int32Array(4))')]) {
    const native = oracle(source).f
    for (const level of levels(0, 2, 3, 'size')) {
      const f = jz(source, { optimize: { level, sourceInline: false } }).exports.f
      for (const x of [0, 0, 3, 4, 7, -1, 2147483647, 0])
        is(f(x), native(x), `O${level}: mixed incoming elements, value ${x}`)
    }
    if (!onKernel()) {
      const optimize = { level: 'speed', sourceInline: false, watr: false }
      const get = funcWat(compile(source, { optimize, wat: true }), 'get')
      ok(hasCheckedTypedAccess(`(module ${get})`), 'the dependent read remains checked after forwarding an unknown writer')
    }
  }
})

test('interval proof: forwarded lengths include dynamic, reassigned and defaulted arrays', () => {
  const bodies = [
    `export function f(n) {
       const a = Array(n).fill(1)
       return [forward([1]), forward(a), forward([1])]
     }`,
    `function get(a, b) { a = b; return forward(a) }
     export function f(n) { return get(new Int32Array(1), new Int32Array(n)) }`,
    `function get(a = new Int32Array(1)) { return forward(a) }
     export function f(n) { return [get(), get(new Int32Array(n)), get()] }`,
  ]
  for (const [i, body] of bodies.entries()) {
    const src = `function length(a) { return a.length }
      function forward(a) { return length(a) }\n${body}`, native = oracle(src).f
    for (const level of levels(0, 2, 3, 'size')) {
      const f = jz(src, { optimize: { level, sourceInline: false } }).exports.f
      for (const n of [0, 1, 1, 4, 8, 0, 1])
        is(f(n), native(n), `O${level}: length sequence ${i}, length ${n}`)
    }
  }
})

test('typed named properties: computed keys preserve buffer aliases and inherited accessors', () => {
  const src = `export function f(n, key) {
    key = String(key)
    const a = new Int32Array(n)
    const view = new Int32Array(a.buffer, n ? 4 : 0, n ? n - 1 : 0)
    const buffer = view?.['buffer'], alias = new Int32Array(buffer)
    if (n) alias[n - 1] = 7
    const data = new DataView(buffer), value = view[key]
    return [a[n - 1] ?? -1, a['buffer'].byteLength,
      view['length'], view['byteLength'], view['byteOffset'], view['BYTES_PER_ELEMENT'],
      data['byteLength'], data['byteOffset'], data['length'], data['BYTES_PER_ELEMENT'],
      value instanceof ArrayBuffer ? value.byteLength : value]
  }`
  const native = oracle(src).f
  for (const level of levels(0, 2, 3, 'size')) {
    const f = jz(src, { optimize: { level, sourceInline: false } }).exports.f
    for (const n of [0, 1, 1, 4, 0])
      for (const key of ['buffer', 'BYTES_PER_ELEMENT', 'length', 'byteLength', 'byteOffset', 'buffer\0', 'BYTES_PER_ELEMENT\0', 'unknown'])
        is(f(n, key), native(n, key), `O${level}: ${n} elements, property ${JSON.stringify(key)}`)
  }
})

test('typed named properties: element widths agree for every typed storage kind', () => {
  const ctors = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
    'Int32Array', 'Uint32Array', 'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array']
    .filter(name => typeof globalThis[name] === 'function')
  const src = ctors.map((name, i) => `export function f${i}(n, key) {
    key = String(key)
    const a = new ${name}(n)
    const view = new ${name}(a.buffer, n ? ${globalThis[name].BYTES_PER_ELEMENT} : 0, n ? n - 1 : 0)
    return [a[key], view[key], a.BYTES_PER_ELEMENT, view?.['BYTES_PER_ELEMENT']]
  }`).join('\n')
  const native = oracle(src)
  for (const level of levels(0, 2, 3, 'size')) {
    const wasm = jz(src, { optimize: { level, sourceInline: false } }).exports
    for (const [i, name] of ctors.entries()) for (const n of [0, 1, 4])
      is(wasm[`f${i}`](n, 'BYTES_PER_ELEMENT'), native[`f${i}`](n, 'BYTES_PER_ELEMENT'), `O${level}: ${name}, length ${n}`)
  }
})

test('interval proof: scalar relay bounds include missing values, defaults and reassignment', () => {
  const bodies = [
    ['missing read', `function relay(a, k) { return get(a, a[k]) }
      export function f(x) { const a = new Int32Array([1, 2, 3, 0]); return relay(a, x) }`],
    ['default parameter', `function relay(a, k = 7) { return get(a, k) }
      export function f(x) { const a = new Int32Array([1, 2, 3, 0]); return [relay(a, 0), relay(a)] }`],
    ['reassigned parameter', `function relay(a, k, x) { k = x; return get(a, k) }
      export function f(x) { const a = new Int32Array([1, 2, 3, 0]); return relay(a, 0, x) }`],
    ['closure-assigned parameter', `function relay(a, k, x) { const change = () => { k = x }; change(); return get(a, k) }
      export function f(x) { const a = new Int32Array([1, 2, 3, 0]); return relay(a, 0, x) }`],
    ['stored wrapping', `function put(a, value) { a[0] = value }
      export function f(x) { const a = new Int8Array([0, 11, 22, 33]); put(a, x); return get(a, a[0]) }`],
    ['empty array', `function relay(a) { return get(a, a[0]) }
      export function f(x) { return relay(new Int32Array(0)) }`],
  ]
  for (const [name, body] of bodies) {
    const src = `function get(a, k) { return a[k] ?? -1 }\n${body}`, native = oracle(src).f
    for (const level of levels(0, 2, 3, 'size')) {
      const f = jz(src, { optimize: { level, sourceInline: false } }).exports.f
      for (const x of [0, 0, 1, 3, 4, -1, 7, 127, 128, 255, 256, 257, 0])
        is(f(x), native(x), `O${level}: ${name}, value ${x}`)
    }
  }
})

test('interval proof: relayed element facts are independent of prior compilations', () => {
  if (onKernel()) return
  const src = relayedElements(4)
  const other = src.replace('a[i] = (i + (n & 3)) & 3', 'a[i] = n')
  for (const level of levels(0, 2, 3, 'size'))
    assertCompileHistoryIndependent(src, [src, other, relayedElements(0), src],
      { optimize: { level, sourceInline: false } }, `O${level}: relayed elements`)
})

const INPUTS = [
  [1, 1], [2, 2], [-1, 1], [4, 1], [1, 4], [1.9, 1], [-0, 1],
  [NaN, 1], [Infinity, 1], [-Infinity, 1], [4294967297, 1],
  [-4294967295, 1], [2147483647, 1], [2147483648, 1],
]

test('interval proof: a named const carries conjunctive i32 bounds to a typed store', () => {
  const native = oracle(KERNEL).mark
  for (const optimize of levels(0, 2, 3)) {
    const wasm = jz(KERNEL, { optimize }).exports.mark
    for (const args of INPUTS)
      is(wasm(...args), native(...args), `O${optimize} (${args.map(String).join(', ')}): Node parity`)
  }
})

test('interval proof: named-guard WAT is raw at O0/O2/O3; sibling controls fail closed', () => {
  if (onKernel()) return // the self-compile kernel returns bytes, not host-inspectable WAT
  for (const optimize of levels(0, 2, 3)) {
    const named = compile(KERNEL, { optimize, wat: true })
    const inline = compile(INLINE, { optimize, wat: true })
    ok(!hasTypedBoundsTemp(named), `O${optimize}: named guard removes the typed bounds branch`)
    ok(!hasTypedBoundsTemp(inline), `O${optimize}: inline conjuncts establish the same finite hull`)
    ok(/i32\.load8_u/.test(named) && /i32\.store8/.test(named), `O${optimize}: guarded load/store remain live`)

    for (const [name, src] of [
      ['let flag', LET_FLAG],
      ['stale dependency', STALE_DEP],
      ['repeated structural key', REPEATED_KEY],
      ['effectful guard', EFFECTFUL_GUARD],
      ['call-mutated global', CALL_MUTATION],
      ['f64 coordinates', F64_COORDS],
      ['disjunctive guard', OR_GUARD],
      ['overflowing index', OVERFLOW_INDEX],
      ['wrapping affine guard', AFFINE_WRAP_GUARD],
    ]) {
      ok(hasCheckedTypedAccess(compile(src, { optimize, wat: true })),
        `O${optimize}: ${name} retains a checked typed access`)
    }
  }
})

test('interval proof: effects, stale facts, NaN, signed values, and aliasing stay exact', () => {
  for (const optimize of levels(0, 2, 3)) {
    for (const [name, src, args] of [
      ['aliased read/write', KERNEL, [1, 1]],
      ['stale dependency', STALE_DEP, [1, 1]],
      ['repeated structural key', REPEATED_KEY, [123, 1]],
      ['effectful guard', EFFECTFUL_GUARD, [1, 1]],
      ['call-mutated global', CALL_MUTATION, []],
      ['f64 NaN', F64_COORDS, [NaN, 1]],
      ['f64 signed', F64_COORDS, [-1, 1]],
      ['f64 fractional', F64_COORDS, [1.5, 1]],
      ['f64 fractional integral sum', F64_COORDS, [1, 0.25]],
      ['overflowing index', OVERFLOW_INDEX, [1, 3]],
      ['wrapping affine guard', AFFINE_WRAP_GUARD, [-2147483648, 1]],
    ]) {
      const native = oracle(src).mark
      const wasm = jz(src, { optimize }).exports.mark
      is(wasm(...args), native(...args), `O${optimize}: ${name} matches Node`)
    }
  }
})

test('interval proof: output is independent of prior guard shapes', () => {
  const predecessors = [LET_FLAG, STALE_DEP, REPEATED_KEY, EFFECTFUL_GUARD, CALL_MUTATION, F64_COORDS, OR_GUARD]
  for (const optimize of levels(0, 2, 3)) {
    assertCompileHistoryIndependent(KERNEL, predecessors, { optimize }, `O${optimize} binary`)
    if (!onKernel())
      assertCompileHistoryIndependent(KERNEL, predecessors, { optimize, wat: true }, `O${optimize} WAT`)
  }
})

// Field bounds: a loop-carried cursor written only by xor / shift stays inside
// its power-of-two field (the bit-reversal permutation of every radix-2 FFT).
// The linear widening cannot see it; the fixpoint retries such names with the
// field bound and adopts it only when the whole trial verifies.
const BIT_REVERSAL = `
export let rev = (seed) => {
  const re = new Float64Array(256)
  for (let i = 0; i < 256; i++) re[i] = (i * seed) | 0
  let j = 0
  for (let i = 1; i < 256; i++) {
    let bit = 256 >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t }
  }
  let h = 0
  for (let i = 0; i < 256; i++) h = (h * 31 + re[i]) | 0
  return h
}`
// The same cursor leaving its field (the extra +1, a mask above the length)
// keeps its checked access.
const FIELD_ESCAPES = [
  ['affine step', `export let f = (n) => { const a = new Float64Array(64); let j = 0; for (let i = 0; i < n; i++) { j = (j ^ i) + 1; a[j] = i } return a[3] }`],
  ['mask above length', `export let f = (n) => { const a = new Float64Array(64); let j = 0; for (let i = 0; i < n; i++) { j ^= 64; a[j] = i } return a[3] }`],
]

test('interval proof: xor/shift cursors are proven inside their field', () => {
  const wat = compile(BIT_REVERSAL, { optimize: 3, wat: true })
  ok(!hasTypedBoundsTemp(wat), 'bit-reversal accesses are raw')
  const native = oracle(BIT_REVERSAL).rev
  for (const optimize of levels(0, 2, 3)) {
    const wasm = jz(BIT_REVERSAL, { optimize }).exports.rev
    is(wasm(1), native(1), `O${optimize}: permutation matches Node`)
    is(wasm(7), native(7), `O${optimize}: permutation of another fill matches Node`)
  }
  for (const [name, src] of FIELD_ESCAPES) {
    ok(hasCheckedTypedAccess(compile(src, { optimize: 3, wat: true })), `${name}: access stays checked`)
    is(jz(src).exports.f(100), oracle(src).f(100), `${name}: matches Node`)
  }
})

// A payload's integer type is not an accumulator bound. Only a finite trip
// count and a bound covering every stored element justify an i32 reduction.
const reduceTyped = (ctor, values, step = 'sum += a[i]', init = '0', bound = 'a.length') => `
export function f() {
  const a = new ${ctor}(${values})
  let sum = ${init}
  for (let i = 0; i < ${bound}; i++) { ${step} }
  return sum
}`

test('interval proof: typed reductions preserve overflow, signedness, misses and explicit wrapping', () => {
  const cases = [
    ['empty', reduceTyped('Uint8Array', '0')],
    ['bytes', reduceTyped('Uint8Array', '[0, 255, 128, 1]')],
    ['signed subtract', reduceTyped('Int16Array', '[-32768, 32767, -1]', 'sum -= a[i]')],
    ['i32 positive overflow', reduceTyped('Int32Array', '[2147483647, 2147483647]')],
    ['i32 negative overflow', reduceTyped('Int32Array', '[-2147483648, -2147483648]')],
    ['u32 payload', reduceTyped('Uint32Array', '[4294967295, 2147483648]')],
    ['near boundary', reduceTyped('Uint8Array', '[255, 255, 255]', 'sum += a[i]', '2147483000')],
    ['missing element', reduceTyped('Int32Array', '[1, 2]', 'sum += a[i + 1]')],
    ['returned compound assignment', reduceTyped('Int32Array', '[2147483647, 2147483647]').replace('return sum', 'return sum += 1')],
    ['returned postincrement', reduceTyped('Int32Array', '[2147483647, 2147483647]').replace('return sum', 'return sum++')],
    ['nested assignment', reduceTyped('Int32Array', '[2147483647, 2147483647]', 'sum = (sum += a[i])')],
    ['wrapping requested', reduceTyped('Int32Array', '[2147483647, 2147483647]', 'sum = (sum + a[i]) | 0')],
    ['fractional payload', reduceTyped('Float32Array', '[0.5, 1.25]')],
    ['clamped store keeps magnitude', reduceTyped('Int32Array', '[2147483647, 2147483647]').replace('return sum', 'const dst = new Uint8ClampedArray(1); dst[0] = sum; return dst[0]')],
  ]
  for (const optimize of levels(0, 2, 3, 'size')) for (const [name, src] of cases) {
    const expected = oracle(src).f(), wasm = jz(src, { optimize }).exports.f
    is(wasm(), expected, `${name}, O${optimize}`)
    is(wasm(), expected, `${name}, repeated call, O${optimize}`)
  }
  if (!onKernel()) {
    const functions = compile(cases[1][1], { optimize: 2, inspect: true }).inspect.functions
    const sum = Object.entries(functions.f.locals).find(([name]) => name.startsWith('sum'))?.[1]
    is(sum?.type, 'i32', 'bounded byte reduction stays integer')
  }
})

test('interval proof: reductions account for repeated regions and writes outside the counted loop', () => {
  const cases = [
    `const a = new Uint8Array([255, 255, 255]); let sum = 2147483000;
     for (let row = 0; row < 2; row++) for (let i = 0; i < 3; i++) sum += a[i]; return sum`,
    `const a = new Uint8Array([255, 255, 255]); let result = 0;
     for (let row = 0, sum = 2147483000; row < 2; row++) {
       for (let i = 0; i < 3; i++) sum += a[i]; result = sum
     } return result`,
    `const a = new Uint8Array([255, 255, 255]); let sum = 0;
     for (let i = 0; i < 3; i++) sum += a[i]; sum += 2147483647; return sum`,
    `const a = new Uint8Array([255, 255, 255]); let sum = 0;
     const change = () => { sum = 2147483647 };
     for (let i = 0; i < 3; i++) { change(); sum += a[i] } return sum`,
    `const a = new Int32Array([1, 2, 3]);
     function escape(p) { throw p }
     try { escape(a) } catch (p) { p[1] = 2147483647 }
     let sum = 0; for (let i = 0; i < 3; i++) sum += a[i]; return sum`,
    `let sum = 2147483600;
     for (let i = 0; i < 2; i++, i -= 0.5) sum += 20; return sum`,
    `let sum = 2147483600;
     for (let i = 0; i < 2; i -= 0.75, i++) sum += 20; return sum`,
    `let sum = 2147483600;
     for (let i = 0, saved = i--; i < 2; i++) sum += 20; return sum`,
  ]
  for (const optimize of levels(0, 2, 3, 'size')) for (const [i, body] of cases.entries()) {
    const src = `export function f() { ${body} }`
    is(jz(src, { optimize }).exports.f(), oracle(src).f(), `region/write ${i}, O${optimize}`)
  }
})


test('interval proof: typed-store assignment values retain the original magnitude', () => {
  const src = `export function f(key) {
    const a = new Int32Array([2147483647, 2147483647])
    let sum = 0; for (let i = 0; i < 2; i++) sum += a[i]
    const dst = new Int32Array(1); return dst[key] = sum
  }`
  for (const optimize of levels(0, 2, 3, 'size')) {
    const native = oracle(src).f, wasm = jz(src, { optimize }).exports.f
    for (const key of ['label', 0, 'label', '0', 'label'])
      is(wasm(key), native(key), `dynamic property ${key}, O${optimize}`)
  }
})

// A checked element read yields undefined (or, consumed by arithmetic, NaN) on
// its miss arm; the count of those arms is the count of checked reads (loop
// rotation copies a loop test's read).
const missArms = (wat) => (wat.match(/\(else \(f64\.const nan\b/g) || []).length
const NO_GUARDS = { level: 'speed', sentinelGuards: false }

// A loop exits where its test failed. The exit state is the head invariant
// (entry ∪ back edges) refined by the failed test, never the state the body
// ran in, and the test's own reads are judged on the head: a read in the test
// that runs once more at the exiting value stays checked.
const LOOP_EXITS = {
  // `while (i < 5 && j < 3)` exits with j = 3, so a[3] reads past the array
  counters: `export function f(n) {
    const a = new Int32Array(3); a[0] = 11; a[1] = 22; a[2] = 33
    let i = 0, j = n & 1
    while (i < 5 && j < 3) { i++; j++ }
    const r = a[j]; return r === undefined ? -1 : r }`,
  // a stride-two counter passes its bound: from 1, `i += 2` exits at 11
  stride: `export function f(n) {
    const a = new Int32Array(11); for (let t = 0; t < 11; t++) a[t] = t
    let i = 1 + (n & 1)
    while (i < 10) i += 2
    const r = a[i]; return r === undefined ? -1 : r }`,
  // the test reads a[i] before comparing i, so the last test reads a[4]
  testRead: `export function f(n) {
    const a = new Int32Array(4); for (let t = 0; t < 4; t++) a[t] = t + 1
    let i = n & 1
    while (a[i] !== -1 && i < 4) i++
    return i }`,
  forTestRead: `export function f(n) {
    const a = new Int32Array(4); for (let t = 0; t < 4; t++) a[t] = t + 1
    let s = 0
    for (let i = n & 1; a[i] > 0 && i < 4; i++) s += 1
    return s }`,
}

test('interval proof: a loop exit is where its test failed, not where its body ran', () => {
  for (const optimize of levels(0, 2, 3, 'size')) for (const [name, src] of Object.entries(LOOP_EXITS)) {
    const native = oracle(src).f, wasm = jz(src, { optimize }).exports.f
    for (const n of [0, 1, 2, 3]) is(wasm(n), native(n), `${name}(${n}), O${optimize}`)
  }
  if (onKernel()) return
  for (const name of ['testRead', 'forTestRead'])
    ok(hasCheckedTypedAccess(compile(LOOP_EXITS[name], { optimize: NO_GUARDS, wat: true })), `${name}: the test's read stays checked`)
})

// On the true path of `x <= a[k]` the read hit, so k is an element index there:
// the body's read of another array of that length at k needs no check. The
// test's own read has no such help, so the pop that runs k to -1 stops on its miss.
test('interval proof: a relational test on a typed read bounds its index where it held', () => {
  const src = `export function f(n) {
    const a = new Float64Array(8), b = new Float64Array(8)
    for (let t = 0; t < 8; t++) { a[t] = t * 1.5; b[t] = t + 0.25 }
    let k = 7, s = 0
    while (n <= a[k]) { s += b[k]; k-- }
    return s + k * 1000 }`
  for (const optimize of levels(0, 2, 3, 'size')) {
    const native = oracle(src).f, wasm = jz(src, { optimize }).exports.f
    for (const n of [-1, 0, 5, 20, NaN, -Infinity]) is(wasm(n), native(n), `f(${n}), O${optimize}`)
  }
  if (onKernel()) return
  // `a[k] + 0` is the same test (undefined + 0 is NaN), with no read to hit
  const plain = src.replace('n <= a[k]', 'n <= a[k] + 0')
  is(oracle(plain).f(-1), oracle(src).f(-1))
  const checked = (s) => missArms(funcWat(compile(s, { optimize: NO_GUARDS, wat: true }), 'f'))
  is(checked(plain) - checked(src), 1, 'the body read b[k] is unchecked where the test read hit')
})

// Proofs are per occurrence: a[k] where k is bounded is unchecked even though
// the same text a[k] later reads with an unbounded k (which keeps its check).
test('interval proof: an access keeps its own proof beside an unprovable twin', () => {
  const src = `export function f(n) {
    const a = new Int32Array(4)
    for (let t = 0; t < 4; t++) a[t] = t + 10
    let k = 0, s = 0
    for (let t = 0; t < 4; t++) { k = t; s += a[k] }
    k = n | 0
    const r = a[k]
    return s * 100 + (r === undefined ? -1 : r) }`
  for (const optimize of levels(0, 2, 3, 'size')) {
    const native = oracle(src).f, wasm = jz(src, { optimize }).exports.f
    for (const n of [0, 3, 4, -1, 2147483647]) is(wasm(n), native(n), `f(${n}), O${optimize}`)
  }
  if (onKernel()) return
  is(missArms(funcWat(compile(src, { optimize: NO_GUARDS, wat: true }), 'f')), 1, 'the unbounded read alone is checked')
})

// A stack cursor pushed once per outer iteration and popped by an inner loop
// rises by at most 1 an iteration: its store and read stay unchecked. The
// pop's own test bounds it below (`k > 0`).
test('interval proof: a cursor that also falls keeps its rise budgeted', () => {
  const src = `export function f(seed) {
    const st = new Int32Array(16)
    let k = 0, s = seed | 0
    for (let q = 0; q < 15; q++) {
      s = (s * 1103515245 + 12345) | 0
      while (k > 0 && (s & 7) < 3) { k--; s = (s * 1103515245 + 12345) | 0 }
      st[k] = q + st[k]
      k++
    }
    let h = 0
    for (let i = 0; i < 16; i++) h = (h * 31 + st[i]) | 0
    return h + k }`
  for (const optimize of levels(0, 2, 3, 'size')) {
    const native = oracle(src).f, wasm = jz(src, { optimize }).exports.f
    for (const seed of [1, 7, 12345, -3]) is(wasm(seed), native(seed), `f(${seed}), O${optimize}`)
  }
  if (onKernel()) return
  ok(!hasCheckedTypedAccess(compile(src, { optimize: NO_GUARDS, wat: true })), 'the stack store and read are unchecked')
})

test('typed named properties: returned buffers survive later allocations', () => {
  const src = `function make(n, key) {
    const a = new Int32Array(n)
    a[0] = 42; a[n - 1] = 99
    return a[String(key)]
  }
  function churn(n) { const a = new Int32Array(n); a.fill(7); return a[0] ?? 0 }
  export function f(n, key) {
    const buffer = make(n, key)
    let total = 0
    for (let i = 0; i < 20; i++) total += churn(n)
    const view = new Int32Array(buffer)
    return [view.length, view[0], view[n - 1], total]
  }`
  const expected = oracle(src).f
  for (const level of levels(0, 1, 2, 3, 'size')) {
    const f = jz(src, { optimize: { level, sourceInline: false } }).exports.f
    for (const n of [0, 1, 1, 32, 0, 32])
      for (const key of ['buffer', 'BYTES_PER_ELEMENT', 'buffer'])
        is(f(n, key), expected(n, key), `O${level}: retained ${key}, length ${n}`)
  }
})
