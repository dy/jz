/**
 * Block merging, on the tape. A result block of one statement is that
 * statement; at scope level, `local.set`, `global.set` or `drop` of a
 * result block runs the block's statements in the scope and consumes its
 * value alone (the wrapper an inlined body leaves), and a block whose
 * label nothing targets splices its body into the scope.
 *
 * @module optimize/merge-blocks
 */
import { T, NONE, OP_STR, remove, replace, insertAfter, intern } from '../ir/tape.js'
import { ops, bodyOf, targetsLabel } from './fn.js'

export function mergeBlocks(f) {
  const O = ops(), body = bodyOf(f)
  if (body === NONE) return
  const GLOBAL_SET = intern('global.set'), DROP = intern('drop')
  const isScope = (op) => op === O.FUNC || op === O.BLOCK || op === O.LOOP || op === O.THEN || op === O.ELSE
  // A block's label symbol (or NONE), whether it has a result, and its first statement.
  const parts = (b) => {
    let c = T.a[b], label = NONE, result = false
    if (c !== NONE && T.op[c] === OP_STR) { label = T.sym[c]; c = T.next[c] }
    for (; c !== NONE; c = T.next[c]) { const op = T.op[c]; if (op === O.RESULT) result = true; else if (op !== O.PARAM && op !== O.TYPE) break }
    return { label, result, first: c }
  }
  const count = (first) => { let k = 0; for (let c = first; c !== NONE; c = T.next[c]) k++; return k }
  // The statements of the subtree at `b`, spliced into `parent` in place of `at`.
  const splice = (parent, at, first) => {
    let prev = at
    for (let c = first, next; c !== NONE; c = next) { next = T.next[c]; insertAfter(parent, prev, c); prev = c }
    remove(parent, at)
  }
  // A result block of one statement is that statement.
  const single = (n) => {
    for (let c = T.a[n]; c !== NONE; c = T.next[c]) {
      if (T.op[c] < 0) continue
      single(c)
      if (T.op[c] !== O.BLOCK) continue
      const { label, result, first } = parts(c)
      if (!result || first === NONE || T.next[first] !== NONE || T.op[first] < 0) continue
      if (label !== NONE && targetsLabel(first, label)) continue
      replace(n, c, first); c = first
    }
  }
  single(f)
  const scopes = (n) => {
    if (isScope(T.op[n])) {
      for (let c = T.op[n] === O.FUNC ? bodyOf(n) : T.a[n]; c !== NONE;) {
        const next = T.next[c], op = T.op[c]
        if (op < 0) { c = next; continue }
        // `set`/`drop` of a result block: the block's statements run in the scope, its value is consumed alone
        const consumer = op === O.LOCAL_SET || op === GLOBAL_SET ? 1 : op === DROP ? 0 : -1
        if (consumer >= 0) {
          const operand = consumer === 1 ? (T.a[c] === NONE ? NONE : T.next[T.a[c]]) : T.a[c]
          if (operand !== NONE && T.next[operand] === NONE && T.op[operand] === O.BLOCK) {
            const { label, result, first } = parts(operand)
            if (result && count(first) >= 2 && !(label !== NONE && targetsLabel(first, label))) {
              let last = first; while (T.next[last] !== NONE) last = T.next[last]
              // unlink the value from the setup, put the setup before the consumer, the value in the operand's place
              let beforeLast = first; while (T.next[beforeLast] !== last) beforeLast = T.next[beforeLast]
              T.next[beforeLast] = NONE
              replace(c, operand, last)
              let prev = NONE
              for (let s = T.a[n]; s !== c; s = T.next[s]) prev = s
              for (let s = first, sn; s !== NONE; s = sn) { sn = T.next[s]; insertAfter(n, prev, s); prev = s }
              c = first   // re-examine from the first spliced statement
              continue
            }
          }
        }
        if (op === O.BLOCK) {
          const { label, first } = parts(c)
          if (!(label !== NONE && targetsLabel(first, label))) { splice(n, c, first); c = first === NONE ? next : first; continue }
        }
        c = next
      }
    }
    for (let c = T.a[n]; c !== NONE; c = T.next[c]) if (T.op[c] >= 0) scopes(c)
  }
  scopes(f)
}
