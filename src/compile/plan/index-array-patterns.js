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
 * row through both spellings alike. A source that may be nullish reads the
 * same way behind a test that hands a missing one to the protocol's open, which
 * throws the TypeError the protocol would (`let [c, d] = opts.coefs` of a field
 * set on first use). A source of any other kind keeps the protocol (a string is
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
import { K, tagOf, hasTag, core } from '../../summary/kind.js'
import { VAL } from '../../reps.js'
import { isReassigned, T } from '../../ast.js'
import { freshId } from '../../ir.js'
import {
  scanBindingUses, USE, BINDING_USE_DECLS, BINDING_USE_INIT, BINDING_USE_USES,
  BINDING_USE_KIND, BINDING_USE_KEY, BINDING_USE_OP,
} from '../analyze-scans.js'

const OPEN = /\$__it_open$/, STEP = /\$__it_step$/, SKIP = /\$__it_skip$/, REST = /\$__it_rest$/, CLOSE = /\$__it_close$/
const isArr = Array.isArray
/** The callee name of a call node with a string callee, else null. */
const calleeOf = (n) => isArr(n) && n[0] === '()' && typeof n[1] === 'string' ? n[1] : null

/** The summary proves the expression an array that is never nullish. */
const provenArray = (view, e, present) => {
  let k
  try { k = view.kindOfExpr(e) } catch { return false }
  return k != null && tagOf(k) === K.ARRAY && !hasTag(k, K.NULLISH) &&
    (!hasTag(k, K.ABSENT) || present?.has(e))
}

/** The summary proves the expression an array or a missing value. */
const arrayOrMissing = (view, e) => {
  let k
  try { k = view.kindOfExpr(e) } catch { return false }
  return k != null && tagOf(core(k)) === K.ARRAY
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

/** Whether a statement binds or assigns `name`. */
const assigns = (n, name) => isArr(n) && (((n[0] === '=' || n[0] === 'let' || n[0] === 'const') && (n[1] === name || isArr(n[1]) && n[1][0] === '=' && n[1][1] === name)) ||
  n.some((c, j) => j > 0 && assigns(c, name)))

/** The protocol's statements at `list[at]` (its open) rewritten in place, or nothing. */
const indexPattern = (list, at, view, present) => {
  const open = list[at], init = isArr(open) && open[0] === 'let' && isArr(open[1]) && open[1][0] === '=' && typeof open[1][1] === 'string' ? open[1][2] : null
  const opener = calleeOf(init)
  if (opener === null || !OPEN.test(opener) || (!provenArray(view, init[2], present) && !arrayOrMissing(view, init[2]))) return false
  const it = open[1][1], src = init[2], missing = !provenArray(view, src, present)
  // the pulls guarded by the close on a throw: prepare's `catch` spelling of the lowering's `try`
  const guard = list[at + 1], pulls = isArr(guard) && guard[0] === 'catch' && isArr(guard[1]) && guard[1][0] === '{}' && isArr(guard[1][1]) && guard[1][1][0] === ';' ? guard[1][1] : null
  const closeAt = pulls ? at + 2 : at + 1, close = list[closeAt], closer = calleeOf(close)
  if (closer === null || !CLOSE.test(closer) || !isArr(close[2]) || close[2][1] !== it) return false
  // A source held in a name the pulls leave alone is read through that name:
  // the cursor would be one more name for it, which hides the array's uses.
  const own = typeof src === 'string' && !missing && !assigns(pulls, src)
  if (pulls) {
    const copy = pulls.slice()
    if (!indexPulls(copy, it, own ? src : it, view)) return false
    list.splice(at + 1, 2, ...copy.slice(1))
  } else list.splice(at + 1, 1)
  if (own) { list.splice(at, 1); return true }
  open[1][2] = src
  // a missing source still meets the open, which throws for it; as a test
  // the summary narrows (a statement list can sit in an expression), only a
  // missing value reaches the protocol
  if (missing) list.splice(at + 1, 0, ['&&', ['==', it, [null, null]], ['()', opener, it]])
  return true
}

// A normalized Map loop traverses a fresh, dense snapshot of entry pairs.
// Its private index is below the captured length, so the pair read cannot
// be absent. Keep the proof local to that loop and refuse escaped snapshots,
// writes to their storage, changed bounds, or rebound pair bindings.
const presentMapPairs = (loop, view, getBindings) => {
  const init = loop[1], cond = loop[2], step = loop[3], body = loop[4]
  if (init?.[0] !== 'let' || init.length !== 4 || cond?.[0] !== '<' || step?.[0] !== '++') return null
  const [snapshot, counter, bound] = init.slice(1)
  if (snapshot?.[0] !== '=' || counter?.[0] !== '=' || bound?.[0] !== '=') return null
  const arr = snapshot[1], idx = counter[1], len = bound[1], source = snapshot[2], length = bound[2]
  if (typeof arr !== 'string' || typeof idx !== 'string' || typeof len !== 'string' ||
      calleeOf(source) !== '__iter_arr' || counter[2]?.[0] != null || counter[2]?.[1] !== 0 ||
      length?.[0] !== '|' || length[1]?.[0] !== '.' || length[1][1] !== arr || length[1][2] !== 'length' || length[2]?.[0] != null || length[2]?.[1] !== 0 ||
      cond[1] !== idx || cond[2] !== len || step[1] !== idx ||
      tagOf(view.kindOfExpr(source[2])) !== K.MAP || isReassigned(body, idx) || isReassigned(body, len)) return null
  const bindings = getBindings(), use = bindings.get(arr)
  if (use?.[BINDING_USE_DECLS] !== 1 || !use[BINDING_USE_USES].every(u =>
    u[BINDING_USE_KIND] === USE.MEMBER_R && (u[BINDING_USE_OP] === '[]' || u[BINDING_USE_KEY] === 'length'))) return null
  const present = new Set()
  for (const [name, binding] of bindings) {
    const value = binding[BINDING_USE_INIT]
    if (binding[BINDING_USE_DECLS] === 1 && value?.[0] === '[]' && value[1] === arr && value[2] === idx &&
        !binding[BINDING_USE_USES].some(u => u[BINDING_USE_KIND] === USE.REASSIGN || u[BINDING_USE_KIND] === USE.CAPTURE)) present.add(name)
  }
  return present.size ? present : null
}

/** Every array pattern over a proven array in the program's functions reads by index. */
export const indexArrayPatterns = () => {
  let changed = false
  let body, bindings
  const getBindings = () => bindings ||= scanBindingUses(body)
  const walk = (n, view, present) => {
    if (!isArr(n)) return
    if (n[0] === '=>') { walk(n[2], ctx.summary.at(n[1])); return }
    if (n[0] === 'for') {
      const pairs = presentMapPairs(n, view, getBindings)
      for (let j = 1; j < n.length; j++) walk(n[j], view, j === 4 && pairs ? pairs : present)
      return
    }
    if (n[0] === ';' || n[0] === ',') for (let s = 1; s < n.length; s++) if (indexPattern(n, s, view, present)) changed = true
    for (let j = 1; j < n.length; j++) walk(n[j], view, present)
  }
  for (const f of ctx.funcs.list) if (f.body && !f.raw) {
    body = f.body
    bindings = null
    walk(f.body, ctx.summary.at(f.sig))
  }
  return changed
}


// An entry whose identity never escapes is just two columns. Capture both
// columns before the loop so Map writes in its body keep snapshot semantics.
const splitMapLoop = (loop, body, view, bindings) => {
  const pairs = presentMapPairs(loop, view, () => bindings)
  if (!pairs || ctx.summary.memberMayBeOwnOn('keys', VAL.MAP) ||
      ctx.summary.memberMayBeOwnOn('values', VAL.MAP) || ctx.summary.memberMayBeOwnOn('size', VAL.MAP)) return false
  const init = loop[1], source = init[1][2][2], arr = init[1][1], idx = init[2][1]
  const kind = view.kindOfExpr(source)
  if (hasTag(kind, K.NULLISH) || hasTag(kind, K.ABSENT)) return false
  // The snapshot has only its bound read and the pair initializers.
  if (bindings.get(arr)[BINDING_USE_USES].length !== pairs.size + 1) return false
  for (let again = true; again;) {
    again = false
    for (const [name, b] of bindings) if (!pairs.has(name) && b[BINDING_USE_DECLS] === 1 && pairs.has(b[BINDING_USE_INIT])) {
      pairs.add(name); again = true
    }
  }
  for (const name of pairs) if (bindings.get(name)[BINDING_USE_USES].some(u => u[BINDING_USE_KIND] !== USE.MEMBER_R && u[BINDING_USE_KIND] !== USE.BARE)) return false
  const outside = n => {
    if (n === loop) return false
    if (typeof n === 'string') return pairs.has(n)
    if (!isArr(n) || n[0] == null || n[0] === 'str') return false
    for (let i = 1; i < n.length; i++) if (outside(n[i])) return true
    return false
  }
  if (outside(body)) return false
  const columns = [null, null], edits = []
  const column = i => columns[i] ||= `${T}entry${freshId(ctx)}`
  // Keep edits private until every occurrence has passed the identity proof.
  const walk = (n, parent, at, discarded = false) => {
    if (typeof n === 'string') {
      if (!pairs.has(n)) return n !== arr
      if (!discarded) return false
      edits.push([parent, at, [null, 0]])
      return true
    }
    if (!isArr(n) || n[0] == null || n[0] === 'str') return true
    const op = n[0]
    if (op === 'let' || op === 'const') {
      const kept = []
      for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (d?.[0] === '=' && pairs.has(d[1])) continue
        if (d?.[0] === '=' && !walk(d[2], d, 2)) return false
        kept.push(d)
      }
      if (kept.length !== n.length - 1) edits.push([parent, at, kept.length ? [op, ...kept] : [';']])
      return true
    }
    if ((op === '[]' || op === '.') && pairs.has(n[1])) {
      const key = op === '.' ? n[2] : isArr(n[2]) && (n[2][0] == null || n[2][0] === 'str') ? n[2][1] : null
      if (key === 'length') edits.push([parent, at, [null, 2]])
      else if (key === 0 || key === '0' || key === 1 || key === '1') edits.push([parent, at, ['[]', column(Number(key)), idx]])
      else return false
      return true
    }
    if (op === '.' || op === '?.') return walk(n[1], n, 1)
    if (op === ':') return walk(n[2], n, 2)
    for (let i = 1; i < n.length; i++) {
      const unused = op === ';' || op === '{}' || op === ',' && (i < n.length - 1 || discarded)
      if (!walk(n[i], n, i, unused)) return false
    }
    return true
  }
  if (!walk(loop[4], loop, 4, true)) return false
  const lengthColumn = columns[0] || columns[1]
  for (const [n, at, value] of edits) n[at] = value
  // Capture the Map once and skip snapshot storage for an empty collection.
  // The columns are ordinary arrays, initialized only on the nonempty path.
  const map = `${T}entryMap${freshId(ctx)}`
  init[3][2] = ['|', ['.', lengthColumn || map, lengthColumn ? 'length' : 'size'], [null, 0]]
  const defs = []
  for (let i = 0; i < 2; i++) if (columns[i]) defs.push(['=', columns[i], ['()', ['.', map, i ? 'values' : 'keys']]])
  init.splice(1, 1, ...defs)
  const inner = loop.slice()
  loop.splice(0, loop.length, '{}', [';', ['let', ['=', map, source]], ['if', ['.', map, 'size'], inner]])
  return true
}

/** Private destructured Map entries keep their keys and values in columns. */
export const splitMapPairs = () => {
  let changed = false
  for (const f of ctx.funcs.list) if (f.body && !f.raw) {
    const bindings = scanBindingUses(f.body), view = ctx.summary.at(f.sig)
    const walk = n => {
      if (!isArr(n) || n[0] === '=>') return
      if (n[0] === 'for' && splitMapLoop(n, f.body, view, bindings)) changed = true
      for (let i = 1; i < n.length; i++) walk(n[i])
    }
    walk(f.body)
  }
  return changed
}
