// Allocation pins: a program measures its own heap through `__heap_mark()`
// around a loop, so a shape that must allocate nothing per iteration is
// pinned at zero bytes in the compiled output, at every level. The arena
// keeps everything until the session ends, so a per-call allocation in the
// runtime's ABI or in a closure's prologue is a leak the self-compile pays
// on its own hot paths (a query view, a dynamic method call).
import test from 'tst'
import { is } from 'tst/assert.js'
import jz from '../index.js'

const measure = (body, calls = 1000) => {
  const src = `${body}
export let probe = (n) => { const h0 = __heap_mark(); let s = 0; for (let i = 0; i < n; i++) s += run(i); return __heap_mark() - h0 + (s > 1e300 ? 1 : 0) }`
  const out = {}
  for (const optimize of [0, 1, 2]) {
    const ex = jz(src, { optimize, memory: 256 }).exports
    ex.probe(10)   // warm: first-time growth of caches is not the per-call cost
    out[optimize] = ex.probe(calls) / calls
  }
  return out
}
const zero = (out, what) => { for (const level in out) is(out[level], 0, `${what} allocates ${out[level]} bytes per call at O${level}`) }

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
