/**
 * `jz:iter` – spread normalization for iterator values: arrays, strings,
 * Sets and Maps pass through untouched (the spread machinery owns them);
 * generator machines and @@iterator providers materialize.
 *
 * @module std/iter
 */

export default `
export let __it_drain = (v) => {
  if (v == null) return v
  if (typeof v === 'object' && v['@@iterator'] != null) v = v['@@iterator']()
  if (typeof v !== 'object' || v.next == null) return v
  let r = v.next(), a = []
  while (!r.done) { a.push(r.value); r = v.next() }
  return a
}
`
