/**
 * `jz:iter` – spread normalization for iterator values: arrays, strings,
 * Sets and Maps pass through untouched (the spread machinery owns them);
 * generator machines and @@iterator providers materialize.
 *
 * @module std/iter
 */

export default `
export let __it_open = (v) => {
  if (v == null) throw new TypeError('value is not iterable')
  let w = v
  let indexed = Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView)) || typeof v === 'string'
  let method = indexed ? undefined : w['@@iterator']
  if (method != null) {
    if (typeof method !== 'function') throw new TypeError('iterator method is not callable')
    w = method()
    if (w == null || typeof w !== 'object') throw new TypeError('iterator is not an object')
  } else if (indexed) {
    let i = 0
    w = { next: () => {
      if (i >= v.length) return { value: undefined, done: true }
      let value = v[i]; i++
      if (typeof v === 'string') { let cp = v.codePointAt(i-1); if (cp > 65535) { value = String.fromCodePoint(cp); i++ } }
      return { value, done: false }
    } }
  } else if (typeof w.next !== 'function') throw new TypeError('value is not iterable')
  return { iterator: w, next: w.next, done: false }
}
export let __it_pull = (r, value) => {
  if (r.done) return undefined
  // Leave done set if next(), done or value access throws.
  r.done = true
  let next = r.next
  if (typeof next !== 'function') throw new TypeError('iterator next is not callable')
  let step = next()
  if (step == null || typeof step !== 'object') throw new TypeError('iterator result is not an object')
  if (step.done) return undefined
  let v = value ? step.value : undefined
  r.done = false
  return v
}
export let __it_step = (r) => __it_pull(r, true)
export let __it_skip = (r) => __it_pull(r, false)
export let __it_rest = (r) => {
  let a = []
  while (!r.done) { let v = __it_step(r); if (!r.done) a.push(v) }
  return a
}
export let __it_close = (r, abrupt) => {
  if (r.done) return
  r.done = true
  try {
    let close = r.iterator.return
    if (close != null) {
      if (typeof close !== 'function') throw new TypeError('iterator return is not callable')
      let result = close()
      if (!abrupt && (result == null || typeof result !== 'object')) throw new TypeError('iterator return is not an object')
    }
  } catch (e) { if (!abrupt) throw e }
}
export let __it_drain = (v) => {
  if (v == null) return v
  if (typeof v === 'object' && v['@@iterator'] != null) v = v['@@iterator']()
  if (typeof v !== 'object' || v.next == null) return v
  let r = v.next(), a = []
  while (!r.done) { a.push(r.value); r = v.next() }
  return a
}
`
