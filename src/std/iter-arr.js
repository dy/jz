/**
 * `jz:iter-arr` – `Array.from` over iterator-minting programs: protocol
 * values materialize, arrays COPY (from() always returns a fresh array),
 * array-likes build by length.
 *
 * @module std/iter-arr
 */

export default `
export let __it_arr = (v) => {
  if (v == null) throw 'TypeError: value is not iterable'
  let w = v
  if (typeof w === 'object' && w[Symbol.iterator] != null) w = w[Symbol.iterator]()
  if (typeof w === 'object' && w.next != null) {
    let a = [], r = w.next()
    while (!r.done) { a.push(r.value); r = w.next() }
    return a
  }
  let a = [], n = v.length
  for (let i = 0; i < n; i++) {
    if (typeof v === 'string') { let cp = v.codePointAt(i); a.push(String.fromCodePoint(cp)); if (cp > 65535) i++ }
    else a.push(v[i])
  }
  return a
}
`
