/**
 * An array pattern over a value the summary proves an array reads it by
 * index. Prepare lowers every array pattern to the iterator protocol
 * (src/iterator-pattern.js): a cursor opened over the source, a step per
 * element, a rest, a close in a `try` that closes on a throw. Over an array
 * the protocol is the array's own reads (JS iterates a plain array by
 * position; jz has no patched array iterator), so the cursor becomes the
 * array itself, each step its element at the position, a rest the slice
 * from there, a skip nothing, and the closes nothing: the pattern costs no
 * record, no calls, no unwinding, and the frame it is in keeps its
 * allocations to its own (the protocol's record pool is module state, which
 * no rewound frame may touch). The summary reads the positions of a tuple
 * row through both spellings alike. A source that may be nullish keeps the
 * protocol, which throws for it, as does one of any other kind (a string is
 * iterated by code point, a collection by its snapshot view).
 *
 * The array iterator is live and finishes once: a default or a nested
 * pattern that runs code between two steps could change the array or
 * exhaust the iterator (`const [x = (a.push(1), 0), y] = a` leaves `y`
 * undefined). The reads by index replace the steps only where every pull is
 * a binding of a name with an expression that runs no code: names, literals,
 * `===`, `!==`, `!`, `typeof`, `??`, `||`, `&&`, `?:`, and the protocol's
 * own calls, a nested pattern's over a proven array. A rest copies the
 * remainder through `slice`, the array's own method: where the program
 * stores a `slice` of its own on an array (jz's dispatch honours it), the
 * rest keeps the protocol, which never calls it.
 *
 * @module compile/plan/index-array-patterns
 */
import { ctx } from '../../ctx.js'
import { K, tagOf, hasTag } from '../../summary/kind.js'
import { VAL } from '../../reps.js'

const OPEN = /\$__it_open$/, STEP = /\$__it_step$/, SKIP = /\$__it_skip$/, REST = /\$__it_rest$/, CLOSE = /\$__it_close$/
const isArr = Array.isArray
/** The callee name of a call node with a string callee, else null. */
const calleeOf = (n) => isArr(n) && n[0] === '()' && typeof n[1] === 'string' ? n[1] : null

/** The summary proves the expression an array that is never nullish. */
const provenArray = (view, e) => {
  let k
  try { k = view.kindOfExpr(e) } catch { return false }
  return k != null && tagOf(k) === K.ARRAY && !hasTag(k, K.NULLISH) && !hasTag(k, K.ABSENT)
}

const PURE_OPS = new Set(['===', '!==', '!', 'typeof', '??', '||', '&&', '?:'])
const PROTOCOL = /\$__it_(open|step|skip|rest|close)$/

/** Whether an expression of the pulls runs no code: a name, a literal, one
 *  of the operators that coerce nothing, or the protocol's own call (an open
 *  over a nested pattern's source only where that source is a proven array:
 *  any other kind's iterator is code). */
const pure = (n, view) => {
  if (!isArr(n)) return true
  const op = n[0]
  if (op == null || op === 'str' || op === 'bool') return true
  if (op === '()') return typeof n[1] === 'string' && PROTOCOL.test(n[1]) && (!OPEN.test(n[1]) || provenArray(view, n[2])) && pure(n[2], view)
  if (!PURE_OPS.has(op) && op !== ',') return false
  for (let j = 1; j < n.length; j++) if (!pure(n[j], view)) return false
  return true
}

/** Whether a statement of the pulls is a binding of a name (or a nested
 *  pattern's own statements) with a pure expression. */
const pureBinding = (n, view) => {
  if (!isArr(n)) return true
  const op = n[0]
  if (op === ';' || op === '{}') return n.slice(1).every(c => pureBinding(c, view))
  if (op === 'let') return n.slice(1).every(c => typeof c === 'string' || (isArr(c) && c[0] === '=' && typeof c[1] === 'string' && pure(c[2], view)))
  if (op === '=') return typeof n[1] === 'string' && pure(n[2], view)
  if (op === 'catch') return pureBinding(n[1], view) && typeof n[2] === 'string' && pureBinding(n[3], view)
  if (op === 'throw') return typeof n[1] === 'string'
  if (op === '()') return pure(n, view)   // a skip, or a close on a throw
  return false
}

/** Whether some array of the program may carry a `slice` of its own, which the array's dispatch would call. */
const sliceMayBeOwn = () => ctx.summary?.memberMayBeOwnOn?.('slice', VAL.ARRAY) === true || ctx.summary?.memberMayBeOwn?.('slice') === true

/** Rewrite the pulls of a cursor (the statements of the protocol's `try`)
 *  in place: steps and rests to reads of `src` by position, skips away.
 *  Returns false when a pull is not one of the protocol's over this cursor,
 *  or runs code between two steps (the statements then stay as they are). */
const indexPulls = (stmts, it, src, view) => {
  if (!stmts.slice(1).every(n => pureBinding(n, view))) return false
  const edits = [], skips = []
  let i = 0
  const pull = (n) => {
    if (!isArr(n)) return true
    if (n[0] === '()' && n[2] === it) {
      if (SKIP.test(n[1])) return true
      return false   // a step or rest as a statement, its value unused: never the lowering's spelling
    }
    for (let j = 1; j < n.length; j++) {
      const c = n[j]
      if (isArr(c) && c[0] === '()' && c[2] === it && typeof c[1] === 'string') {
        if (STEP.test(c[1])) edits.push([n, j, ['[]', src, [null, i++]]])
        else if (REST.test(c[1])) { if (sliceMayBeOwn()) return false; edits.push([n, j, ['()', ['.', src, 'slice'], [null, i]]]) }
        else if (CLOSE.test(c[1]) || OPEN.test(c[1])) return false
      } else if (!pull(c)) return false
    }
    return true
  }
  for (let s = 1; s < stmts.length; s++) {
    const n = stmts[s], callee = calleeOf(n)
    if (callee !== null && SKIP.test(callee) && n[2] === it) { i++; skips.push(s); continue }
    if (!pull(n)) return false
  }
  // Commit only after every pull qualifies: the caller's copy shares its children.
  for (const [node, at, value] of edits) node[at] = value
  for (let s = skips.length - 1; s >= 0; s--) stmts.splice(skips[s], 1)
  return true
}

/** The protocol's statements at `list[at]` (its open) rewritten in place, or nothing. */
const indexPattern = (list, at, view) => {
  const open = list[at], init = isArr(open) && open[0] === 'let' && isArr(open[1]) && open[1][0] === '=' && typeof open[1][1] === 'string' ? open[1][2] : null
  const opener = calleeOf(init)
  if (opener === null || !OPEN.test(opener) || !provenArray(view, init[2])) return false
  const it = open[1][1], src = init[2]
  // the pulls guarded by the close on a throw: prepare's `catch` spelling of the lowering's `try`
  const guard = list[at + 1], pulls = isArr(guard) && guard[0] === 'catch' && isArr(guard[1]) && guard[1][0] === '{}' && isArr(guard[1][1]) && guard[1][1][0] === ';' ? guard[1][1] : null
  const closeAt = pulls ? at + 2 : at + 1, close = list[closeAt], closer = calleeOf(close)
  if (closer === null || !CLOSE.test(closer) || !isArr(close[2]) || close[2][1] !== it) return false
  if (pulls) {
    const copy = pulls.slice()
    if (!indexPulls(copy, it, it, view)) return false
    list.splice(at + 1, 2, ...copy.slice(1))
  } else list.splice(at + 1, 1)
  open[1][2] = src
  return true
}

/** Every array pattern over a proven array in the program's functions reads by index. */
export const indexArrayPatterns = () => {
  let changed = false
  const walk = (n, view) => {
    if (!isArr(n)) return
    if (n[0] === '=>') { walk(n[2], ctx.summary.at(n[1])); return }
    if (n[0] === ';' || n[0] === ',') for (let s = 1; s < n.length; s++) if (indexPattern(n, s, view)) changed = true
    for (let j = 1; j < n.length; j++) walk(n[j], view)
  }
  for (const f of ctx.funcs.list) if (f.body && !f.raw) walk(f.body, ctx.summary.at(f.sig))
  return changed
}
