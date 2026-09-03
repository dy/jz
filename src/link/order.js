/**
 * Function order: hot callees first, so `call $f` encodes its index in one
 * LEB128 byte (indices under 128). Ties among runtime functions (`$__`)
 * break by name so the order is stable across compiles; the user's functions
 * keep their source order.
 *
 * @module link/order
 */
import { T, NONE, intern, text, insertAfter } from '../ir/tape.js'

export function orderFuncs(root, callCount) {
  const FUNC = intern('func')
  const funcs = []
  let before = NONE  // the child the first function follows
  for (let c = T.a[root], prev = NONE; c !== NONE; c = T.next[c]) {
    if (T.op[c] !== FUNC) { prev = c; continue }
    if (!funcs.length) before = prev
    funcs.push(c)
  }
  if (funcs.length < 2) return
  const nameOf = (f) => text(T.a[f])
  const calls = (f) => { const n = nameOf(f); return n === null ? 0 : callCount.get(n) || 0 }
  const sorted = funcs.slice().sort((a, b) => {
    const delta = calls(b) - calls(a)
    if (delta) return delta
    const na = nameOf(a), nb = nameOf(b)
    const sa = na !== null && na.startsWith('$__'), sb = nb !== null && nb.startsWith('$__')
    return sa && sb ? (na < nb ? -1 : na > nb ? 1 : 0) : 0
  })
  for (let c = T.a[root], prev = NONE; c !== NONE; c = T.next[c]) {
    if (T.op[c] !== FUNC) { prev = c; continue }
    if (prev === NONE) T.a[root] = T.next[c]; else T.next[prev] = T.next[c]
  }
  let at = before
  for (const f of sorted) { insertAfter(root, at, f); at = f }
}
