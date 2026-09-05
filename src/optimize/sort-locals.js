/**
 * Local declaration order, on the tape. A `local.get/set/tee` encodes its
 * index as a ULEB128: one byte under 128, two above, and the locals vector
 * costs one entry per run of a type. With at most 128 declarations every
 * index is one byte and only the vector matters, so locals group by type
 * (stable within a type) and the vector squashes to one run per type.
 * Above 128 the hottest locals take the one-byte indices, counted over the
 * body as it is now, after every rewrite, and each side of the boundary
 * groups by type again: an index past it costs the same wherever it lands.
 * Parameters never move: their slots are the call ABI. Runs when watr does
 * not: watr's `sortLocals` orders the final body, after its coalescing.
 *
 * @module optimize/sort-locals
 */
import { T, NONE, intern, text, walk } from '../ir/tape.js'

const TYPE_ORDER = { i32: 0, i64: 1, f32: 2, f64: 3, v128: 4 }

export function sortLocalsByUse(root) {
  const FUNC = intern('func'), PARAM = intern('param'), RESULT = intern('result'), LOCAL = intern('local')
  const EXPORT = intern('export'), IMPORT = intern('import'), TYPE = intern('type')
  const LOCAL_GET = intern('local.get'), LOCAL_SET = intern('local.set'), LOCAL_TEE = intern('local.tee')
  const typeOf = (l) => TYPE_ORDER[text(T.next[T.a[l]])] ?? 9
  for (let f = T.a[root]; f !== NONE; f = T.next[f]) {
    if (T.op[f] !== FUNC) continue
    const locals = []
    let params = 0, body = NONE
    for (let c = T.next[T.a[f]]; c !== NONE; c = T.next[c]) {
      const op = T.op[c]
      if (op === PARAM) { params++; continue }
      if (op === RESULT) continue
      if (op === LOCAL) { locals.push(c); continue }
      if (op < 0 || op === EXPORT || op === IMPORT || op === TYPE) continue  // a comment atom, or a header entry
      body = c
      break
    }
    if (locals.length < 2) continue
    const order = locals.map((l, k) => [T.a[l], typeOf(l), k])
    const byType = (a, b) => (a[1] - b[1]) || (a[2] - b[2])
    if (params + locals.length <= 128) order.sort(byType)
    else {
      const counts = new Map()
      for (let c = body; c !== NONE; c = T.next[c]) walk(c, (id) => {
        const op = T.op[id]
        if (op === LOCAL_GET || op === LOCAL_SET || op === LOCAL_TEE) { const n = text(T.a[id]); if (n !== null) counts.set(n, (counts.get(n) || 0) + 1) }
      })
      const uses = (a) => counts.get(text(a[0])) || 0
      order.sort((a, b) => (uses(b) - uses(a)) || (a[1] - b[1]) || (a[2] - b[2]))
      const head = order.slice(0, 128 - params).sort(byType), tail = order.slice(head.length).sort(byType)
      order.splice(0, order.length, ...head, ...tail)
    }
    // Every declaration is `(local $name type)`: the slots stay, their children move.
    locals.forEach((l, k) => { T.a[l] = order[k][0] })
  }
}
