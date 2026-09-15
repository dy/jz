/** Shared iterator records for binding patterns, plus spread materialization.
 * @module std/iter
 */

export default `
// Binding records are private and closed exactly once. Retain only as many
// as the deepest overlapping pattern needs; never retain a user's iterator.
let spare = null
const recycle = r => { r.iterator = undefined; r.next = undefined; spare.push(r) }
export let __it_open = (v) => {
  if (v == null) throw new TypeError('value is not iterable')
  // Native collection methods expose snapshot views (see README.md).
  if (v instanceof Map) v = v.entries()
  else if (v instanceof Set) v = v.values()
  let w = v
  let indexed = Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView)) || typeof v === 'string'
  let method = indexed ? undefined : w['@@iterator']
  if (method != null) {
    if (typeof method !== 'function') throw new TypeError('iterator method is not callable')
    w = method()
    if (w == null || typeof w !== 'object') throw new TypeError('iterator is not an object')
  } else if (!indexed && typeof w.next !== 'function') throw new TypeError('value is not iterable')
  // Read next before borrowing: a throwing getter must not lose a record.
  const next = indexed ? undefined : w.next
  if (!spare) spare = []
  const r = spare.pop() || { iterator: undefined, next: undefined, index: 0, done: false }
  // A nonnegative index is an indexed cursor; -1 is a protocol iterator.
  r.iterator = w; r.next = next; r.index = indexed ? 0 : -1; r.done = false
  return r
}
export let __it_pull = (r, value) => {
  if (r.done) return undefined
  // Leave done set if next(), done or value access throws.
  r.done = true
  if (r.index >= 0) {
    let v = r.iterator, i = r.index
    let result
    // Each cursor kind is guarded by its own test so its length and element
    // reads compile to that kind's direct form.
    if (Array.isArray(v)) {
      if (i >= v.length) return undefined
      if (value) result = v[i]
      i++
    } else if (typeof v === 'string') {
      if (i >= v.length) return undefined
      let cp = v.codePointAt(i)
      if (value) result = String.fromCodePoint(cp)
      i += cp > 65535 ? 2 : 1
    } else {
      if (i >= v.length) return undefined
      if (value) result = v[i]
      i++
    }
    r.index = i; r.done = false
    return result
  }
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
  if (r.done || r.index >= 0) { recycle(r); return }
  r.done = true
  try {
    let close = r.iterator.return
    if (close != null) {
      if (typeof close !== 'function') throw new TypeError('iterator return is not callable')
      let result = close()
      if (!abrupt && (result == null || typeof result !== 'object')) throw new TypeError('iterator return is not an object')
    }
  } catch (e) { recycle(r); if (!abrupt) throw e; return }
  // A user return() can destructure again: release after it completes.
  recycle(r)
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
