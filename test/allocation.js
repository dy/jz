// Allocation pins: a program measures its own heap through `__heap_mark()`
// around a loop, so a shape that must allocate nothing per iteration is
// pinned at zero bytes in the compiled output, at every level. The arena
// keeps everything until the session ends, so a per-call allocation in the
// runtime's ABI or in a closure's prologue is a leak the self-compile pays
// on its own hot paths (a query view, a dynamic method call).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { levels } from './_matrix.js'
import { firstRefKind, MUTATE_OPS, extractParams, classifyParam, collectParamName, collectParamNames } from '../src/ast.js'
import { findFreeVars } from '../src/compile/analyze-scans.js'

const measure = (body, calls = 1000, warm = 10) => {
  const src = `${body}
export let probe = (n) => { const h0 = __heap_mark(); let s = 0; for (let i = 0; i < n; i++) s += run(i); return __heap_mark() - h0 + (s > 1e300 ? 1 : 0) }`
  const out = {}
  for (const optimize of levels(0, 1, 2)) {
    const ex = jz(src, { optimize, memory: 256 }).exports
    ex.probe(warm)   // warm: first-time growth of caches is not the per-call cost
    out[optimize] = ex.probe(calls) / calls
  }
  return out
}
const zero = (out, what) => { for (const level in out) is(out[level], 0, `${what} allocates ${out[level]} bytes per call at O${level}`) }

test('allocation: short numeric strings reclaim formatter scratch', () => {
  zero(measure(`const values = new Float64Array([0, -0, 123.5, -12.5, 123456])
    const run = i => String(values[i % values.length]).length`), 'short decimal formatting')
  zero(measure(`const run = i => String((i % 10000) | 0).length`), 'signed-i32 formatting')
  zero(measure(`const run = i => BigInt(i % 10000).toString(16).length`), 'short BigInt radix formatting')
  zero(measure(`const run = i => (i % 10000).toString(16).length`), 'short Number radix formatting')
})

test('allocation: long numeric strings retain only their final payload', () => {
  for (const [expr, text] of [
    ['String(1234567 + (i & 1))', '1234567'],
    ['String((-2147483648 + (i & 1)) | 0)', '-2147483648'],
    ['BigInt(123456789 + (i & 1)).toString(16)', '75bcd15'],
    ['(123456789 + (i & 1)).toString(16)', '75bcd15'],
  ]) {
    const bytes = (4 + text.length * 2 + 7) & ~7
    const out = measure(`let saved; export const read = () => saved
      const run = i => { saved = ${expr}; return saved.length }`, 40, 2)
    for (const level in out) is(out[level], bytes, `O${level}: formatter retains only the aligned string payload`)
  }
})

test('allocation: skipped closure branches do not allocate captured cells', () => {
  const source = `let kept = () => -1
    function choose(flag, x) {
      if (flag) { let n = x; const next = () => ++n; kept = next; return next() + next() }
      return x
    }
    export function probe(flag, count) {
      const start = __heap_mark(); let total = 0
      for (let i = 0; i < count; i++) total += choose(flag, i)
      return [__heap_mark() - start, total]
    }
    export function read() { return kept() }`
  for (const optimize of levels(0, 1, 2, 3)) {
    const ex = jz(source, { optimize }).exports
    is(ex.probe(false, 0).join(','), '0,0', 'zero work allocates nothing')
    is(ex.probe(false, 40).join(','), '0,780', 'a skipped branch leaves the heap untouched')
    is(ex.read(), -1, 'a skipped branch does not create its closure')
    for (const count of [1, 1, 4, 0, 1]) {
      is(ex.probe(true, count)[1], count * (count - 1) + count * 3, 'taken calls share each captured counter')
      if (count) is(ex.read(), count + 2, 'the last closure keeps its cell after returning')
      is(ex.probe(false, 40).join(','), '0,780', 'taken → skipped keeps allocation lazy')
    }
  }
})

test('allocation: conditional reference scans do not copy each nested node', () => {
  for (const [node, expected] of [
    [null, null], [[], null], [[';'], null],
    [['=', 'x', 1], 'write'], [['=', 'x', ['+', 'x', 1]], 'read'],
    [['if', 'c', ['=', 'x', 1]], 'read'],
    [['if', 'c', ['=', 'x', 1], ['=', 'x', 2]], 'write'],
    [['=>', 'y', ['=', 'x', 1]], 'read'],
  ]) is(firstRefKind(node, 'x'), expected, 'evaluation order and conditional writes keep their verdict')
  let deep = 'x'
  for (let i = 0; i < 16; i++) deep = ['+', 1, deep]
  const source = `const MUTATE_OPS = new Set(${JSON.stringify([...MUTATE_OPS])})
    ${firstRefKind.toString()}
    const shallow = ['if', 'c', 'x'], deep = ${JSON.stringify(['if', 'c', deep])}
    export function probe(d, n) {
      const a = d ? deep : shallow, start = __heap_mark()
      let reads = 0
      for (let i = 0; i < n; i++) reads += firstRefKind(a, 'x') === 'read' ? 1 : 0
      return reads === n ? __heap_mark() - start : -1
    }`
  for (const optimize of levels(0, 1, 2, 3)) {
    const ex = jz(source, { optimize }).exports
    is(ex.probe(0, 0), 0, 'a zero-work scan allocates nothing')
    const shallow = ex.probe(0, 40)
    is(shallow >= 0, true, 'every scan finds the conditional read')
    for (const depth of [1, 1, 0, 1])
      is(ex.probe(depth, 40), shallow, `O${optimize}: nesting adds no temporary arrays`)
  }
})

test('allocation: free-variable scans do not copy declaration lists', () => {
  const source = `const PARAM_DEFAULT = 2
    ${extractParams.toString()}
    ${classifyParam.toString()}
    const collectParamName = ${collectParamName.toString()}
    ${collectParamNames.toString()}
    const ctx = { func: { locals: new Map(), current: { params: [] } } }
    const repOf = () => null
    ${findFreeVars.toString()}
    const nodes = [[';', 'a', 'b'], ['const', 'a', 'b'],
      ['for', [';', 'a', 'b'], null, null, null], ['for', ['let', 'a', 'b'], null, null, null]]
    const bound = new Set(['a', 'b']), scope = new Set(['a', 'b']), free = []
    export function probe(k, n, explicit) {
      const start = __heap_mark()
      for (let i = 0; i < n; i++) findFreeVars(nodes[k], bound, free, explicit ? scope : null)
      return free.length ? -1 : __heap_mark() - start
    }`
  for (const optimize of levels(0, 1, 2, 3)) {
    const ex = jz(source, { optimize }).exports
    for (const explicit of [0, 1]) {
      is(ex.probe(1, 0, explicit), 0, 'zero scans allocate nothing')
      for (const [decl, control] of [[1, 0], [1, 0], [3, 2], [1, 0]])
        is(ex.probe(decl, 40, explicit), ex.probe(control, 40, explicit),
          `O${optimize}: declarations add no allocation to the same tree walk`)
    }
  }
  const scope = new Set(['outer', 'last']), bound = new Set(), free = []
  findFreeVars(['const', ['=', 'a', 'outer'], ['=', 'b', 'last']], bound, free, scope)
  is(free.join(','), 'outer,last', 'all initializers retain their free references')
  is([...bound].join(','), 'a,b', 'all declarations bind, including the last one')
  is([...scope].join(','), 'outer,last,a,b', 'an explicit scope receives every declaration')
  free.length = 0
  findFreeVars(['for', ['let', ['=', 'i', 'outer'], ['=', 'j', 'last']], null, null, ['+', 'i', 'j']], bound, free, scope)
  is(free.join(','), 'outer,last', 'loop declarations bind before the body is scanned')
  findFreeVars(null, bound, free, scope)
  findFreeVars([], bound, free, scope)
  is(free.join(','), 'outer,last', 'empty input preserves the discovered references')
})

test('allocation: seeded collections apply their capacity floor without adding a reserve', () => {
  const src = `let m = new Map(), s = new Set()
    export function map(n) { const a = []; for (let i = 0; i < n; i++) a.push([i, i + 1]); const h = __heap_mark(); m = new Map(a); return __heap_mark() - h }
    export function set(n) { const a = []; for (let i = 0; i < n; i++) a.push(i); const h = __heap_mark(); s = new Set(a); return __heap_mark() - h }
    export function copy() { const h = __heap_mark(); m = new Map(m); return __heap_mark() - h }
    export function read() { return JSON.stringify([[...m], [...s]]) }`
  for (const level of levels(0, 1, 2, 3)) for (const floor of [2, 8]) for (const compact of [false, true]) {
    const ex = jz(src, { optimize: { level, collectionInitCap: floor }, _compactCollections: compact }).exports
    for (const n of [0, 1, 2, 3, 4, 5, 7, 8, 9, 16, 0, 4, 4]) {
      const cap = Math.max(floor, 2 ** Math.ceil(Math.log2(Math.max(1, n * 2))))
      const mapBytes = 16 + cap * (compact ? 24 : 28)
      is(ex.map(n), mapBytes, `Map(${n}), floor ${floor}, compact ${compact}, O${level}`)
      is(ex.set(n), 16 + cap * (compact ? 16 : 20), `Set(${n}), floor ${floor}, compact ${compact}, O${level}`)
      is(ex.copy(), mapBytes, 'a dense copy allocates only its table')
      is(ex.read(), JSON.stringify([Array.from({ length: n }, (_, i) => [i, i + 1]), Array.from({ length: n }, (_, i) => i)]), 'contents and insertion order survive copying and repeated construction')
    }
  }
})

test('allocation: closed destructuring records are reused', () => {
  zero(measure(`const a = [3, 5]
    export function read(a) { const [x, y] = a; return x + y }
    const run = i => { a[0] = i; return read(a) }`), 'array destructuring after warmup')
  zero(measure(`const a = [[3, 5], [7, 11]]
    export function read(a) { const [[x, y], [z, w]] = a; return x + y + z + w }
    const run = i => { a[0][0] = i; return read(a) }`), 'nested destructuring after warmup')
})

test('allocation: a dynamic method call passes its arguments inline', () => {
  // `pick` returns one of two shapes: the receiver's slot is read at runtime and the closure called through the dynamic path.
  zero(measure(`const o = { add: (a, b) => a + b, id: (x) => x, n: 1 }
const pick = (k) => k ? o : { add: (a, b) => a * b, id: (x) => x }
const run = (i) => pick(i & 1).add(i, 2) + pick(1 - (i & 1)).id(i)`), 'a dynamic method call')
})

test('allocation: a cache hit returns before the view it would build', () => {
  zero(measure(`const views = new Map()
const facts = new Map()
facts.set('k', 3)
const view = (scope) => {
  let cached = views.get(scope)
  if (cached) return cached
  const keys = new Map()
  const keyOf = (name) => { let k = keys.get(name); if (k !== undefined) return k; k = name + scope; keys.set(name, k); return k }
  const kindOf = (n) => typeof n === 'string' ? facts.get(keyOf(n)) ?? 0 : n[0] === '.' ? kindOf(n[1]) + 1 : 0
  const rec = (n) => n > 0 ? rec(n - 1) + 1 : 0
  cached = { kindOf, keyOf, rec, sidOf: (name) => kindOf(name) & 7, valOf: (name) => kindOf(name) * 2 }
  views.set(scope, cached)
  return cached
}
const q = { at: (x) => view(x), other: 1 }
const run = (i) => q.at('f').kindOf('k') + view(1).sidOf('k') + view(2).rec(3)`), 'a cached view')
})

test('allocation: a closure boxes only the captures it mutates', () => {
  // `scope` (a parameter) and `base` (a capture) are copied into the nested
  // closures; `count`, mutated after its capture, is the one cell, made
  // when `bump` is declared, so a call that returns early makes none.
  zero(measure(`const mk = (base) => (scope) => {
  if (scope < 0) return base
  let count = 0
  const bump = () => ++count
  const read = () => base + scope + count
  bump()
  return read()
}
const f = mk(10)
const run = (i) => f(-1)`), 'an early return')
  const out = measure(`const mk = (base) => (scope) => {
  if (scope < 0) return base
  let count = 0
  const bump = () => ++count
  const read = () => base + scope + count
  bump()
  return read()
}
const f = mk(10)
const run = (i) => f(i)`)
  // one cell for \`count\`, two closure environments (bump: count; read: base, scope, count)
  for (const level in out) is(out[level] <= 8 + 8 + 24, true, `the mutated capture's cell and the closures alone (${out[level]} bytes at O${level})`)
})

test('allocation: a push loop grows its array in place at the heap top', () => {
  // The array's storage ends at the heap top, so each doubling extends it
  // instead of copying: the arena holds one capacity (at most twice the
  // length), not every doubling's.
  const out = measure(`const run = (i) => { const r = []; for (let k = 0; k < 100; k++) r.push(k); return r.length }`, 200)
  for (const level in out) is(out[level] <= 16 + 2 * 100 * 8, true, `one capacity for 100 pushes (${out[level]} bytes at O${level})`)
})

test('allocation: a rest parameter that never escapes reads the argument slots', () => {
  // watr's ByteBuf: method closures over their object, `push(...xs)` and a
  // `for…of` reached through an unknown receiver (the slot view); a module
  // function's `for…of` called with fixed arities (the per-arity clone).
  zero(measure(`const mk = (cap) => {
  const b = { buf: new Uint8Array(cap), length: 0 }
  b.push = (...xs) => { for (let i = 0; i < xs.length; i++) b.buf[b.length++] = xs[i]; return b.length }
  b.add = (k, ...xs) => { let s = k; for (const x of xs) s += x; return s }
  b.reset = () => { b.length = 0 }
  return b
}
const bb = mk(64)
const total = (...xs) => { let s = 0; for (const x of xs) s += x; return s }
const write = (out, i) => { out.push(i & 0xff); out.push(1, 2, 3, 4); const s = out.add(1, i) + out.add(1, 2, 3); out.reset(); return s }
const run = (i) => write(bb, i) + total(i) + total(1, 2, 3) + bb.length`), 'a rest parameter')
})

test('allocation: a queue reuses the head its shifts vacate', () => {
  // A shift moves the header up one slot; a push that finds the tail full
  // slides the elements back down to the storage's base (module/array.js
  // __arr_grow) instead of extending the storage by one slot per pair. Warmed
  // past the one doubling that settles the capacity at twice the length.
  zero(measure(`const a = []; for (let k = 0; k < 1000; k++) a.push(k)
const run = (i) => { const v = a.shift(); a.push(v); return v }`, 3000, 1200), 'a shift then a push')
})

test('allocation: private string builders grow linearly', () => {
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const { bytes, build } = jz(`
      export function bytes(n) {
        const h = __heap_mark(); let s = '';
        for (let i = 0; i < n; i++) s += 'ab';
        return __heap_mark() - h + (s.length === n * 2 ? 0 : 1000000)
      }
      export function build(n) { let s = ''; for (let i = 0; i < n; i++) s += 'ab'; return s }
    `, { optimize }).exports
    is(bytes(0), 0, `empty builder O${optimize}`)
    for (const n of [100, 100, 1000]) {
      ok(bytes(n) <= n * 4 + 32, `O${optimize}, ${n} appends stay within output bytes plus one header`)
      is(build(n), 'ab'.repeat(n), `terminal return O${optimize}, n=${n}`)
    }
  }
})

test('allocation: copied concat results do not retain builder storage', () => {
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const { run } = jz(`export function run(n) {
      const h = __heap_mark(); let s = '';
      for (let i = 0; i < n; i++) s += 'abcdefgh';
      const copy = s + '!';
      for (let i = 0; i < 8; i++) s += 'z';
      return [__heap_mark() - h, s.length, copy.length, copy.charCodeAt(copy.length - 1)]
    }`, { optimize }).exports
    for (const n of [0, 100, 100, 1000]) {
      const [bytes, len, copied, end] = run(n)
      // Size mode merges the mutable/fresh helpers when both are needed.
      // Every tier preserves text; O0–O3 also keep linear builder allocation.
      if (optimize !== 'size') ok(bytes < n * 64 + 1024, `O${optimize}: copies and appends use linear storage`)
      is([len, copied, end], [n * 8 + 8, n * 8 + 1, 33], `O${optimize}: the copied result stays unchanged`)
    }
  }
})
