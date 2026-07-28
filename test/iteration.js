// Iteration protocol edges — for-of over nullish THROWS (ES: "x is not
// iterable"), it does not silently iterate zero times. The silent form masked
// two real self-host miscompiles (a strictSentinel-folded undefined guard and
// a never-armed matchAll both fed undefined into for-of and vanished) before
// they were caught. Known-vt receivers pay nothing — the guard lives only in
// __iter_arr's unknown-receiver arm (module/collection.js).
import test, { is } from 'tst'
import { run } from './util.js'

test('for-of over nullish throws (catchable), iterables unaffected', async () => {
  const SRC = `
  export const probe = (which) => {
    const src = which > 0 ? [1, 2, 3] : which < 0 ? null : undefined
    let n = 0
    try { for (const x of src) n += x } catch (e) { return 'threw' }
    return 'sum:' + n
  }
  export const spreadable = () => {
    const s = new Set([1, 2])
    let n = 0
    for (const x of s) n += x
    return n
  }`
  for (const optimize of [false, 2]) {
    const m = await run(SRC, { memory: 256, optimize })
    is(m.probe(1), 'sum:6', `optimize:${optimize} array iterates`)
    is(m.probe(0), 'threw', `optimize:${optimize} undefined throws`)
    is(m.probe(-1), 'threw', `optimize:${optimize} null throws`)
    is(m.spreadable(), 3, `optimize:${optimize} Set iterates`)
  }
})

test('Set/Map constructors: nullish iterable is an EMPTY collection, for-of still throws', () => {
  // ES: the CONSTRUCTOR skips iteration for undefined/null (new Set(undefined)
  // is empty — GetIterator never runs), while for-of/spread over nullish is a
  // TypeError. The ctor path used to route through the for-of normalizer and
  // threw — natively masked (host JS semantics), self-hosted it broke the
  // compiler's own `new Set(maybeUndefined)` (the census-row class).
  const { f } = run(`export let f = (use) => {
    const base = use ? new Set(['x']) : undefined
    const s = new Set(base)
    const m = new Map(use ? undefined : null)
    return (s.has('x') ? 1 : 0) + m.size * 10
  }`).exports ?? run(`export let f = (use) => {
    const base = use ? new Set(['x']) : undefined
    const s = new Set(base)
    const m = new Map(use ? undefined : null)
    return (s.has('x') ? 1 : 0) + m.size * 10
  }`)
  is(Number(f(1)), 1)
  is(Number(f(0)), 0)
})
