/**
 * A loop whose body is a guarded loop scans for its guard in a loop of its
 * own (speed tier):
 *
 *   (loop $L (block $B (br_if $B c1) … (br_if $B ck) REST…) (br_if $L C))
 *
 * with a loop in REST becomes
 *
 *   (block $out
 *     (loop $L
 *       (block $B
 *         (block $found
 *           (loop $S
 *             (block $skip (br_if $skip c1) … (br_if $skip ck) (br $found))
 *             (br_if $S C)
 *             (br $out)))
 *         REST…)
 *       (br_if $L C)))
 *
 * A pixel scan that starts a contour walk where it finds a boundary, a sieve
 * that crosses off from each prime it finds: most rounds leave by the guard,
 * and each pays the round's loop header (V8's stack check), the guard and the
 * latch, two taken branches. The scan alone is an innermost loop, which V8
 * unrolls under one stack check, a taken branch a round. The operations run in
 * the order they did: the guard's conditions, in turn, where the round would
 * have tested them, and the latch C, copied, once a round in either copy (a
 * `local.tee` step of the counter included). REST runs where the guard holds,
 * a branch to $B in it still lands on the latch, and one to $L still tests the
 * guard again without the latch.
 *
 * Where the guard mostly holds, the inner loop's exit is a branch a round
 * beside REST's loop. A body without a loop keeps its shape: its guard may hold
 * as often as not, and its rounds are as cheap as the scan's. So does a body
 * that ends in its loop, the guard that loop's own entry test (a rotated
 * loop's), which holds on nearly every round.
 *
 * @module optimize/search-loops
 */

const isArr = Array.isArray
// (sets, not patterns: the compiler compiles itself, and its source keeps to plain string tests)
const LEAVES = new Set(['br', 'br_if', 'br_table', 'return', 'return_call', 'return_call_indirect', 'return_call_ref',
  'throw', 'throw_ref', 'rethrow', 'try', 'try_table', 'delegate', 'unreachable'])
const LABELLED = new Set(['block', 'loop', 'if', 'try', 'try_table'])

const some = (n, pred) => isArr(n) && (pred(n) || n.some(c => some(c, pred)))
const clone = (n) => isArr(n) ? n.map(clone) : n
// a condition that runs straight through: no branch, no call, no loop of its own
const plain = (e) => !some(e, n => typeof n[0] === 'string' && (LEAVES.has(n[0]) || n[0] === 'loop' || n[0].startsWith('call')))
const label = (n) => typeof n[1] === 'string' && n[1][0] === '$' ? n[1] : null
// (a block or loop carrying a type yields a value: out of scope)
const typed = (n) => n.slice(2, 4).some(c => isArr(c) && (c[0] === 'result' || c[0] === 'param' || c[0] === 'type'))

/** The rewrite of `loop`, or null where it is not a scan for a guarded loop. */
const searchOf = (loop, fresh) => {
  const L = label(loop)
  if (!L || loop.length !== 4 || typed(loop)) return null
  const body = loop[2], latch = loop[3]
  if (!isArr(latch) || latch[0] !== 'br_if' || latch[1] !== L || latch.length !== 3 || !plain(latch[2])) return null
  if (!isArr(body) || body[0] !== 'block' || typed(body)) return null
  const B = label(body)
  if (!B) return null
  let k = 2
  while (k < body.length && isArr(body[k]) && body[k][0] === 'br_if' && body[k][1] === B && body[k].length === 3 && plain(body[k][2])) k++
  const rest = body.slice(k)
  // (a body that ends in its loop is that loop under its own entry test, a rotated
  // loop's guard: it holds on nearly every round, and the round is the loop)
  if (k === 2 || !rest.length || !rest.some(s => some(s, n => n[0] === 'loop')) || rest[rest.length - 1][0] === 'loop') return null
  const out = fresh('out'), found = fresh('found'), S = fresh('search'), skip = fresh('skip')
  const scan = ['loop', S,
    ['block', skip, ...body.slice(2, k).map(c => ['br_if', skip, c[2]]), ['br', found]],
    ['br_if', S, clone(latch[2])],
    ['br', out]]
  return ['block', out, ['loop', L, ['block', B, ['block', found, scan], ...rest], latch]]
}

/** Give each scan for a guarded loop, in every function of `ast` (a module), a loop of its own. */
export function searchLoops(ast) {
  if (!isArr(ast)) return ast
  for (const fn of ast) {
    if (!isArr(fn) || fn[0] !== 'func') continue
    const labels = new Set()
    // (a branch by depth would reach another label once the loop is wrapped: such a function keeps its loops)
    let byDepth = false
    const collect = (n) => {
      if (!isArr(n)) return
      if (LABELLED.has(n[0]) && label(n)) labels.add(n[1])
      if ((n[0] === 'br' || n[0] === 'br_if' || n[0] === 'br_table') && n.slice(1).some(c => typeof c === 'number' || typeof c === 'string' && c[0] >= '0' && c[0] <= '9')) byDepth = true
      for (const c of n) collect(c)
    }
    collect(fn)
    if (byDepth) continue
    let id = 0
    const fresh = (base) => {
      let name = `$${base}${id++}`
      while (labels.has(name)) name = `$${base}${id++}`
      labels.add(name)
      return name
    }
    // innermost first: a rewritten scan's own loops are not visited again
    const visit = (n) => {
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        if (!isArr(c)) continue
        visit(c)
        if (c[0] !== 'loop') continue
        const r = searchOf(c, fresh)
        if (r) n[i] = r
      }
    }
    visit(fn)
  }
  return ast
}
