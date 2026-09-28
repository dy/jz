// Store-to-load forwarding and dead-store elimination in straight-line code.
//
// A kernel that chains library calls through an out-parameter (`quat.multiply(out, a,
// b); quat.normalize(out, out)`) stores every result and reloads it a few statements
// later; a JIT keeps those values in registers. This pass walks each statement list
// once, remembering what the last f64 store to each slot put there — the slot is the
// access's `base ⊕ off` resolved as the SLP packer resolves it, over the locals the
// list has defined so far — and
//   • replaces a later load of that slot by the stored value (a local or a constant),
//     or by the local an earlier load of the slot filled (`ax = a[0]` read twice),
//   • drops a store whose slot the list overwrites before anything could read it.
// Whatever could touch memory or leave the straight line forgets what is known: a
// store through another base (two names can be one array), a non-f64 access it cannot
// place, a call other than the durable-array snapshot and a throw guard, a branch, a
// nested block or loop. A local rewritten between a store and a load gives its
// addresses a new identity, so the two no longer match; a rewrite of a forwarded
// value's local forgets that value.
import { walkAst } from '../ast.js'
import { findBodyStart } from '../ir.js'
import { accessOf, deadTees, hasOp, inertFor, localGetCounts, resolveAddr, CONTROL_OPS, clone } from './vectorize/access.js'
import { normalizeTransparentBlocks } from './vectorize/scaffold.js'
import { isArr } from './vectorize/node-utils.js'

const NONE = new Set()
const isLeaf = v => isArr(v) && (v[0] === 'local.get' && typeof v[1] === 'string' || v[0] === 'f64.const')

export function forwardStores(fn) {
  if (!isArr(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return
  normalizeTransparentBlocks(fn)
  const counts = localGetCounts(fn)
  const visit = (list, from) => {
    forwardIn(list, from, counts)
    for (let i = from; i < list.length; i++) if (isArr(list[i])) visit(list[i], 1)
  }
  visit(fn, bodyStart)
}

// One statement list, top to bottom. `defs` gives every local the list writes an
// identity per definition (resolveAddr's tokens); `entries` maps a slot to what last
// put a value in a local for it — a store, or a load into a local (`x = a[0]`): the
// value to forward, the statement's index, whether it was a store, and whether
// something read the slot since (then the store stays).
const forwardIn = (list, from, counts) => {
  const w = { defs: new Map(), writes: NONE }
  const entries = new Map()
  const dead = []
  const keyOf = (base, at) => { const r = resolveAddr(base, w, at); return r && JSON.stringify(r) }
  const markRead = (key) => { for (const [k, e] of entries) if (key == null || k.startsWith(key + '|')) e.read = true }
  const written = (name) => { for (const [k, e] of entries) if (e.value && e.value[0] === 'local.get' && e.value[1] === name) entries.delete(k) }
  for (let i = from; i < list.length; i++) {
    const s = list[i]
    if (!isArr(s)) continue
    const whole = !hasOp(s, CONTROL_OPS)
    // The tees come first: a load inside the statement resolves through the tee before
    // it. The set the statement is comes after its loads were forwarded, so its
    // definition is what it holds then (a forwarded load: the other local).
    const set = s[0] === 'local.set' && typeof s[1] === 'string' ? s[1] : null
    walkAst(s, { enter: n => {
      if ((n[0] !== 'local.set' && n[0] !== 'local.tee') || typeof n[1] !== 'string') return
      written(n[1])
      if (n !== s) w.defs.set(n[1], { e: n[0] === 'local.tee' && whole ? n[2] : null, at: i })
    } })
    const isStore = s[0] === 'f64.store'
    const access = isStore ? accessOf(s) : null
    const parts = isStore ? [access.addr, access.val] : [s]
    if (!parts.every(p => inertFor(p, NONE))) { if (set) w.defs.set(set, { e: null, at: i }); entries.clear(); continue }
    // Its loads: a tracked slot's value, or a read that keeps the slot's store alive.
    walkAst(s, { enter: (n, parent, idx) => {
      if (n === s || !isArr(n) || typeof n[0] !== 'string') return
      if (n[0] === 'f64.load') {
        const a = accessOf(n), key = keyOf(a.base, i)
        const e = key && entries.get(`${key}|${a.off}`)
        if (e && e.value) parent[idx] = clone(e.value)
        else if (e) e.read = true
        else if (!key) markRead(null)
        return false
      }
      if (n[0].includes('.load')) { const a = accessOf(n); markRead(a && keyOf(a.base, i)) }
    } })
    if (set) w.defs.set(set, { e: s[2], at: i })
    if (set && whole && isArr(s[2]) && s[2][0] === 'f64.load') {
      // A load into a local: a later load of the slot reads the local.
      const a = accessOf(s[2]), key = keyOf(a.base, i)
      if (key && !entries.has(`${key}|${a.off}`)) entries.set(`${key}|${a.off}`, { value: ['local.get', set], at: i, store: false, read: false })
      continue
    }
    if (!isStore) continue
    const key = keyOf(access.base, i)
    if (!key) { entries.clear(); continue }
    for (const k of [...entries.keys()]) if (!k.startsWith(key + '|')) entries.delete(k)
    const slot = `${key}|${access.off}`, prev = entries.get(slot)
    if (prev && prev.store && !prev.read) dead.push(prev.at)
    entries.set(slot, { value: isLeaf(access.val) ? access.val : null, at: i, store: true, read: false })
  }
  // A dead store goes whole, or leaves its operands' tees behind when something reads them.
  for (const i of dead.sort((x, y) => y - x)) {
    const a = accessOf(list[i])
    const keep = [a.addr, a.val].filter(n => !isLeaf(n) && !deadTees(n, counts)).map(n => ['drop', n])
    list.splice(i, 1, ...keep)
  }
}
