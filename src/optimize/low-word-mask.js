/**
 * `i32.wrap_i64` keeps the low 32 bits, so a low-word mask under it is
 * redundant: `wrap(and(bits, 0xFFFFFFFF))` → `wrap(bits)`. The masked form
 * comes from the raw-offset read of a live array binding and the hoisted
 * global bases; the fold runs on the tape after those hoists.
 *
 * @module optimize/low-word-mask
 */
import { T, NONE, OP_NUM, OP_STR, intern, walk } from '../ir/tape.js'

export function foldLowWordMasks(root) {
  const WRAP = intern('i32.wrap_i64'), AND = intern('i64.and'), I64_CONST = intern('i64.const')
  const isMask = (c) => {
    if (c === NONE || T.op[c] !== I64_CONST) return false
    const v = T.a[c]
    if (v === NONE) return false
    if (T.op[v] === OP_NUM) return T.imm[v] === 0xFFFFFFFF
    if (T.op[v] === OP_STR) { const s = T.syms[T.sym[v]]; return s === '0xFFFFFFFF' || s === '4294967295' }
    return false
  }
  walk(root, (id) => {
    if (T.op[id] !== WRAP) return
    const a = T.a[id]
    if (a === NONE || T.next[a] !== NONE || T.op[a] !== AND) return
    const x = T.a[a], mask = x === NONE ? NONE : T.next[x]
    if (mask === NONE || T.next[mask] !== NONE || !isMask(mask)) return
    T.next[x] = NONE
    T.a[id] = x
  })
}
