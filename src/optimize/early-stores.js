/**
 * A store whose address and value are ready goes ahead of the computation
 * before it that it does not read (speed tier):
 *
 *   (local.set $x1 (f64.load (local.tee $s (i32.add (local.get $state) (i32.const 32)))))
 *   (local.set $y (f64.sub … (f64.load offset=8 (local.get $s)) … (f64.load offset=8 (local.get $c)) …))
 *   (f64.store (local.get $s) (local.get $v))
 *     →
 *   (local.set $x1 (f64.load (local.tee $s …)))
 *   (f64.store (local.get $s) (local.get $v))
 *   (local.set $y (f64.sub …))
 *
 * A core retires in order: a store behind a long chain of arithmetic holds its
 * store-queue entry, and the reorder-buffer entries after it, until the chain
 * is done, though its value was ready before the chain began. A filter
 * cascade's state update (biquad: each section's input stored for the next
 * sample while the section's output is computed) is the shape; ahead of the
 * output it ran 0.95x its time on an AMD Zen 5, 0.99x on a Zen 3 and a Zen 4,
 * as before on Intel Xeons.
 *
 * A load read once, by a later statement, is first read there (as watr's
 * propagation would, but past a store its address provably misses): a store
 * raised between a load and its use would keep the load a statement of its
 * own, a register held across the store.
 *
 * Statements cross only where nothing observes the order: no branch, call,
 * trap or global write, none of the locals one reads written by the other,
 * and memory accesses that provably miss each other (optimize/address.js
 * mayAlias): one sum with disjoint bytes, or bases rooted at parameters the plan
 * proves distinct buffers (`distinctParams`). A store goes just ahead of the topmost
 * statement it may cross that holds a chain of at least LATENCY cycles of work.
 *
 * @module optimize/early-stores
 */
import { findBodyStart } from '../ir.js'
import { NO_MODULE } from './effects.js'
import { addressOf, mayAlias } from './address.js'

const isArr = Array.isArray
const STORE = /^(?:i32|i64|f32|f64)\.store(?:8|16|32)?$/
const LOAD = /^(?:i32|i64|f32|f64)\.load(?:8|16|32)?(?:_[su])?$/
const STOP = new Set(['br', 'br_if', 'br_table', 'return', 'return_call', 'return_call_indirect', 'return_call_ref', 'unreachable', 'throw', 'throw_ref', 'rethrow',
  'block', 'loop', 'if', 'try', 'try_table', 'call', 'call_indirect', 'call_ref', 'global.set', 'select'])
const TRAPS = /^(?:i32|i64)\.(?:div|rem)_[su]$|^(?:i32|i64)\.trunc_f(?:32|64)_[su]$/
const SLOW = /^f(?:32|64)\.(?:div|sqrt)$/
// the cycles of the deepest chain a statement must hold for a store to cross it
const LATENCY = 8
// the bytes an access touches: its packed width, else its type's
const walk = (n, f) => { if (!isArr(n)) return; f(n); for (let i = 1; i < n.length; i++) walk(n[i], f) }
const writes = (c) => (c[0] === 'local.set' || c[0] === 'local.tee') && typeof c[1] === 'string'
/** Whether a node's operation is one no statement may cross: control, a call, a trap, a global or memory-wide write. */
const fixed = (op) => typeof op !== 'string' || STOP.has(op) || TRAPS.test(op) || op.startsWith('memory.') || op.includes('atomic') || op.startsWith('v128.') && (op.includes('load') || op.includes('store'))
/** What an access moving past node `c` cannot pass, of the module's effects `fx`: a fixed node,
 *  but a call whose result is a function of its operands alone and that cannot throw (it reads
 *  and writes nothing of the program), and a global's write, which is no memory, but to an
 *  access whose operands read that global (`globals`). */
const stops = (c, fx, globals) => c[0] === 'call' ? !(typeof c[1] === 'string' && fx.kind(c[1]) === 'pure' && !fx.throws(c[1]))
  : c[0] === 'global.set' ? globals.has(c[1]) : fixed(c[0])

/** The cycles of the deepest dependence chain of an expression (a coarse x64 table). */
const depth = (n) => {
  if (!isArr(n) || typeof n[0] !== 'string') return 0
  let d = 0
  for (let i = 1; i < n.length; i++) { const c = depth(n[i]); if (c > d) d = c }
  const op = n[0]
  // a store is no work of its own: what it waits for is its value
  if (STORE.test(op)) return depth(n[n.length - 1])
  if (op === 'local.get' || op === 'local.set' || op === 'local.tee' || op.endsWith('.const')) return d
  if (LOAD.test(op)) return d + 5
  if (SLOW.test(op)) return d + 13
  if (op.startsWith('f64.') || op.startsWith('f32.') || op.endsWith('.mul')) return d + 3
  return d + 1
}

/**
 * The locals of an address read at statement `at` of `list` (optimize/address.js `look`):
 * a local the statement itself writes cannot be said; one an earlier statement of the
 * list writes, unconditionally, is what that write holds there; one none writes is a
 * parameter `distinct` names, as its root, or stands as itself.
 */
const lookAt = (ctx, at) => (n) => {
  if (n[0] !== 'local.get') return undefined
  const x = n[1]
  let mine = false
  walk(ctx.list[at], (c) => { if (writes(c) && c[1] === x) mine = true })
  if (mine) return null
  for (let k = at - 1; k >= ctx.from; k--) {
    let def = null, other = false
    walk(ctx.list[k], (c) => {
      if (writes(c) && c[1] === x) { if (def) other = true; def = c }
      else if (c[0] === 'if' || c[0] === 'block' || c[0] === 'loop') other = true
    })
    if (!def) continue
    return other ? null : { e: def[2], look: lookAt(ctx, k), token: `l:${x}@${k}` }
  }
  return ctx.distinct.has(x) ? 'r:' + x : undefined
}
/** An access at statement `at`, as one sum. */
const accAt = (n, at, ctx) => addressOf(n, lookAt(ctx, at))
/** Whether two accesses miss each other: one sum over disjoint bytes, or roots the plan proves apart. */
const misses = (a, b, ctx) => !mayAlias(a, b, ctx.roots)

/** Arithmetic of locals and constants: nothing it does could not move with it. */
const pure = (n) => {
  if (!isArr(n) || typeof n[0] !== 'string') return false
  const op = n[0]
  if (op === 'local.get' || op.endsWith('.const')) return true
  if (writes(n) || op === 'global.get' || fixed(op) || op.includes('.load') || op.includes('.store')) return false
  for (let i = 1; i < n.length; i++) if (isArr(n[i]) && !pure(n[i])) return false
  return true
}

/** Read each load set into a local read once, by a later statement of `list`, where it is read. */
const sink = (ctx) => {
  const { list, from, counts, fx } = ctx
  for (let i = from; i < list.length; i++) {
    const s = list[i]
    if (!isArr(s) || s[0] !== 'local.set' || s.length !== 3 || typeof s[1] !== 'string' || counts.get(s[1]) !== 1) continue
    const load = s[2]
    if (!isArr(load) || !LOAD.test(load[0])) continue
    const x = s[1], mine = accAt(load, i, ctx), deps = new Set(), globals = new Set()
    let plain = true
    walk(mine.addr, (c) => { if (fixed(c[0]) || writes(c) || LOAD.test(c[0])) plain = false; else if (c[0] === 'local.get') deps.add(c[1]); else if (c[0] === 'global.get') globals.add(c[1]) })
    if (!plain) continue
    // the statement reading x, past statements that leave the load's value alone
    let at = -1
    for (let k = i + 1; k < list.length && at < 0; k++) {
      const p = list[k]
      let reads = false, ok = isArr(p)
      const stores = []
      walk(p, (c) => {
        if (c[0] === 'local.get' && c[1] === x) reads = true
        else if (stops(c, fx, globals) || writes(c) && (c[1] === x || deps.has(c[1]))) ok = false
        else if (STORE.test(c[0])) stores.push(c)
      })
      if (reads) {
        // read there before anything the statement stores, outside any branch of it
        if (ok && (stores.length === 0 || stores.length === 1 && stores[0] === p)) at = k
        break
      }
      if (!ok) break
      for (const c of stores) if (!misses(mine, accAt(c, k, ctx), ctx)) ok = false
      if (!ok) break
    }
    if (at < 0) continue
    walk(list[at], (c) => { for (let j = 1; j < c.length; j++) if (isArr(c[j]) && c[j][0] === 'local.get' && c[j][1] === x) c[j] = load })
    counts.set(x, 0)
    list.splice(i, 1)
    i--
  }
}

/** Move each store of the list ahead of the long computations before it that it may cross. */
const raise = (ctx) => {
  const { list, from, counts, fx } = ctx
  for (let j = from + 1; j < list.length; j++) {
    const s = list[j]
    if (!isArr(s) || typeof s[0] !== 'string' || !STORE.test(s[0])) continue
    // a temporary set just before for this store alone is the store's own value
    const v = s[s.length - 1], prev = list[j - 1]
    if (isArr(v) && v[0] === 'local.get' && counts.get(v[1]) === 1 && isArr(prev) && prev[0] === 'local.set' && prev[1] === v[1] && prev.length === 3 && pure(prev[2])) {
      s[s.length - 1] = prev[2]
      counts.set(v[1], 0)
      list.splice(j - 1, 1)
      j--
    }
    // the store itself: no control, no call, no trap, no local written
    let plain = true
    const reads = new Set(), globals = new Set()
    walk(s, (c) => { if (fixed(c[0]) || writes(c)) plain = false; else if (c[0] === 'local.get') reads.add(c[1]); else if (c[0] === 'global.get') globals.add(c[1]) })
    if (!plain) continue
    const mine = accAt(s, j, ctx), myLoads = []
    walk(s[s.length - 1], (c) => { if (LOAD.test(c[0])) myLoads.push(accAt(c, j, ctx)) })
    // it goes just ahead of the topmost long computation it may cross: a statement
    // holding LATENCY cycles of work; past cheaper ones there is nothing to gain
    let t = j
    for (let k = j - 1; k >= from; k--) {
      const p = list[k]
      if (!isArr(p) || typeof p[0] !== 'string') break
      let ok = true
      const accesses = []
      walk(p, (c) => {
        if (stops(c, fx, globals) || writes(c) && reads.has(c[1])) ok = false
        else if (LOAD.test(c[0]) || STORE.test(c[0])) accesses.push(c)
      })
      if (!ok) break
      for (const c of accesses) {
        const a = accAt(c, k, ctx)
        if (!misses(mine, a, ctx)) { ok = false; break }
        // a store it crosses must miss the loads the store makes
        if (STORE.test(c[0]) && myLoads.some(l => !misses(l, a, ctx))) { ok = false; break }
      }
      if (!ok) break
      if (depth(p) >= LATENCY) t = k
    }
    if (t === j) continue
    list.splice(j, 1)
    list.splice(t, 0, s)
  }
}

/** Raise the stores of function `fn` (a func node) where they may go earlier, asking `fx` (the
 *  module's effects) what a call does. */
export function earlyStores(fn, fx = NO_MODULE) {
  if (!isArr(fn) || fn[0] !== 'func') return
  const distinct = fn.distinctParams
  if (!distinct?.size) return
  const counts = new Map()
  walk(fn, (c) => { if (c[0] === 'local.get' && typeof c[1] === 'string') counts.set(c[1], (counts.get(c[1]) || 0) + 1) })
  const lists = []
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return
  lists.push([fn, bodyStart])
  walk(fn, (n) => {
    if (n[0] !== 'block' && n[0] !== 'loop' && n[0] !== 'then' && n[0] !== 'else') return
    let k = 1
    while (k < n.length && (!isArr(n[k]) || n[k][0] === 'result' || n[k][0] === 'param' || n[k][0] === 'type')) k++
    lists.push([n, k])
  })
  const roots = new Set([...distinct].map(x => 'r:' + x))
  for (const [list, from] of lists) {
    const ctx = { list, from, distinct, roots, counts, fx }
    sink(ctx)
    raise(ctx)
  }

}
