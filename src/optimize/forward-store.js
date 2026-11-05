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
//   • drops a store whose slot the list overwrites before anything could read it: no
//     load between them but the forwarded ones and loads of the base's other slots.
// Whatever could touch memory or leave the straight line forgets what is known: a
// store through another base (two names can be one array or object), a call other than
// the header reads, the durable-array snapshot and a throw guard, a branch, a nested
// block or loop. A local rewritten between a store and a load gives its
// addresses a new identity, so the two no longer match; a rewrite of a forwarded
// value's local forgets that value.
import { walkAst } from '../ast.js'
import { findBodyStart } from '../ir.js'
import { accessOf, deadTees, hasOp, inertFor, localGetCounts, resolveAddr, CONTROL_OPS, clone } from './vectorize/access.js'
import { normalizeTransparentBlocks } from './vectorize/scaffold.js'
import { isArr } from './vectorize/node-utils.js'
import { mayAlias } from '../ir/mem-alias.js'

const NONE = new Set()
const isLeaf = v => isArr(v) && (v[0] === 'local.get' && typeof v[1] === 'string' || v[0] === 'f64.const')

export function forwardStores(fn) {
  if (!isArr(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return
  normalizeTransparentBlocks(fn)
  const counts = localGetCounts(fn)
  const copies = copyRoots(fn, bodyStart)
  const visit = (list, from, path) => {
    forwardIn(list, from, counts, copies && (name => copies.root(name, path)))
    for (let i = from; i < list.length; i++) if (isArr(list[i])) visit(list[i], 1, copies && [...path, [list, list[i]]])
  }
  visit(fn, bodyStart, copies && [])
}

// Where the code at path `b` (the [node, child] steps from the function down to it) runs
// only after statement `a` (its path) did: inside a later statement of a's list, in no
// other arm or list. `at` holds each node's position as the scan found it: this pass
// removes statements and replaces a dead store with drops of its operands, never moves
// one, so the order of two it kept is the order they had; a node it made has none.
const dominates = (a, b, at) => {
  const k = a.length - 1
  if (b.length <= k) return false
  for (let j = 0; j < k; j++) if (b[j][0] !== a[j][0] || b[j][1] !== a[j][1]) return false
  if (b[k][0] !== a[k][0]) return false
  const x = at.get(a[k][1]), y = at.get(b[k][1])
  return x != null && y != null && y > x
}

// A local one write gives its value for good: set once, by a statement, to a copy of a
// local set once by a statement that runs before it (or a parameter nothing writes). Read
// where its write has run, it is that local: LICM snaps one base into a local per access
// (`$__li1 = $__li10`, `$__li8 = $__li10`), which are then one address.
const copyRoots = (fn, bodyStart) => {
  const writes = new Map()
  walkAst(fn, { enter: n => { if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') writes.set(n[1], (writes.get(n[1]) || 0) + 1) } })
  const params = new Set()
  for (let i = 2; i < bodyStart; i++) { const c = fn[i]; if (isArr(c) && c[0] === 'param' && typeof c[1] === 'string' && !writes.has(c[1])) params.add(c[1]) }
  const defs = new Map()   // a local written once by a statement → { path, src }
  const at = new Map()     // a node → its position in its parent
  const scan = (node, path) => {
    for (let i = 1; i < node.length; i++) {
      const s = node[i]
      if (!isArr(s)) continue
      at.set(s, i)
      const here = [...path, [node, s]]
      if (s[0] === 'local.set' && typeof s[1] === 'string' && writes.get(s[1]) === 1) {
        const v = isArr(s[2]) && s[2][0] === 'local.tee' ? s[2][2] : s[2]
        defs.set(s[1], { path: here, src: isArr(v) && v[0] === 'local.get' && typeof v[1] === 'string' ? v[1] : null })
      }
      scan(s, here)
    }
  }
  scan(fn, [])
  const roots = new Map()
  const rootOf = (name, seen = 0) => {
    if (roots.has(name)) return roots.get(name)
    const d = defs.get(name)
    let r = null
    if (d?.src && seen < 32) {
      const s = defs.get(d.src)
      if (params.has(d.src) || s && dominates(s.path, d.path, at)) r = rootOf(d.src, seen + 1) ?? d.src
    }
    roots.set(name, r)
    return r
  }
  let any = false
  for (const name of defs.keys()) if (rootOf(name)) any = true
  if (!any) return null
  // The root of a read in the list at `path`, where the local's write has run.
  return { root: (name, path) => { const r = roots.get(name), d = defs.get(name); return r && dominates(d.path, path, at) ? r : null } }
}

// One statement list, top to bottom. `defs` gives every local the list writes an
// identity per definition (resolveAddr's tokens); `entries` maps a slot to what last
// put a value in a local for it — a store, or a load into a local (`x = a[0]`): the
// value to forward, the statement's index, whether it was a store, and whether
// something read the slot since (then the store stays).
const forwardIn = (list, from, counts, root = null) => {
  // Only these statements can seed an entry. Operand lists without either cannot
  // forward or remove anything; rescanning their subtrees makes deep expressions
  // quadratic. The caller still visits their children to find nested candidates.
  let seeded = false
  for (let i = from; i < list.length; i++) {
    const s = list[i]
    if (isArr(s) && (s[0] === 'f64.store' || s[0] === 'local.set' &&
        typeof s[1] === 'string' && isArr(s[2]) && s[2][0] === 'f64.load')) { seeded = true; break }
  }
  if (!seeded) return
  const w = { defs: new Map(), writes: NONE, root }
  const entries = new Map()
  const dead = []
  const keyOf = (base, at) => { const r = resolveAddr(base, w, at); return r && JSON.stringify(r) }
  // (a read through another name reads the entries whose memory it may touch: src/ir/mem-alias.js)
  const markRead = (key, mem) => { for (const [k, e] of entries) if (key == null ? mayAlias(mem, e.mem) : k.startsWith(key + '|')) e.read = true }
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
    // Its loads: a tracked slot's value, or a read that keeps a store alive — the slot's
    // own, or every tracked one when it reads through another name (which may be the
    // same array or object as a tracked base) or another width.
    walkAst(s, { enter: (n, parent, idx) => {
      if (n === s || !isArr(n) || typeof n[0] !== 'string') return
      if (n[0] === 'f64.load') {
        const a = accessOf(n), key = keyOf(a.base, i)
        const e = key && entries.get(`${key}|${a.off}`)
        if (e && e.value) parent[idx] = clone(e.value)
        else if (e) e.read = true
        else if (!key || ![...entries.keys()].some(k => k.startsWith(key + '|'))) markRead(null, n.mem)
        return false
      }
      if (n[0].includes('.load')) markRead(null, n.mem)
    } })
    if (set) w.defs.set(set, { e: s[2], at: i })
    if (set && whole && isArr(s[2]) && s[2][0] === 'f64.load') {
      // A load into a local: a later load of the slot reads the local.
      const a = accessOf(s[2]), key = keyOf(a.base, i)
      if (key && !entries.has(`${key}|${a.off}`)) entries.set(`${key}|${a.off}`, { value: ['local.get', set], at: i, store: false, read: false, mem: s[2].mem })
      continue
    }
    if (!isStore) continue
    const key = keyOf(access.base, i)
    // A store through another name forgets what it may overwrite: every slot, where the
    // emitter left no mark on either access; none of an array of another cell or of an
    // object's other field (src/ir/mem-alias.js).
    for (const [k, e] of [...entries]) if ((!key || !k.startsWith(key + '|')) && mayAlias(s.mem, e.mem)) entries.delete(k)
    if (!key) continue
    const slot = `${key}|${access.off}`, prev = entries.get(slot)
    if (prev && prev.store && !prev.read) dead.push(prev.at)
    entries.set(slot, { value: isLeaf(access.val) ? access.val : null, at: i, store: true, read: false, mem: s.mem })
  }
  // A dead store goes whole, or leaves its operands' tees behind when something reads them.
  for (const i of dead.sort((x, y) => y - x)) {
    const a = accessOf(list[i])
    const keep = [a.addr, a.val].filter(n => !isLeaf(n) && !deadTees(n, counts)).map(n => ['drop', n])
    list.splice(i, 1, ...keep)
  }
}
