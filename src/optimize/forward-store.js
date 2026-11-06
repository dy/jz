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
// An `if` whose arms only set locals and store is a join: what both arms leave holds
// past it (quat.invert's early return of zeros, which quat.multiply then reads back).
// Whatever could touch memory or leave the straight line forgets what is known: a
// call other than the header reads, the durable-array snapshot and a throw guard, a
// branch, a nested block or loop; a store through another base (two names can be one
// array or object) forgets the value, but leaves an earlier store dead where the list
// overwrites it unread. A local rewritten between a store and a load gives its
// addresses a new identity, so the two no longer match; a rewrite of a forwarded
// value's local forgets that value.
import { walkAst } from '../ast.js'
import { findBodyStart } from '../ir.js'
import { accessOf, deadTees, hasOp, inertFor, localGetCounts, resolveAddr, CONTROL_OPS, clone } from './vectorize/access.js'
import { normalizeTransparentBlocks } from './vectorize/scaffold.js'
import { isArr } from './vectorize/node-utils.js'
import { mayAlias } from '../ir/mem-alias.js'

const NONE = new Set()
const CALLS = new Set(['call', 'call_indirect', 'call_ref'])
const isLeaf = v => isArr(v) && (v[0] === 'local.get' && typeof v[1] === 'string' || v[0] === 'f64.const')

export function forwardStores(fn) {
  if (!isArr(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return
  normalizeTransparentBlocks(fn)
  const counts = localGetCounts(fn)
  const copies = copyRoots(fn, bodyStart)
  // (a slot both arms of an `if` store: the local each arm sets beside its store)
  const names = new Set(), added = []
  for (let i = 2; i < bodyStart; i++) if (isArr(fn[i]) && typeof fn[i][1] === 'string') names.add(fn[i][1])
  let next = 0
  const fresh = () => { let n; do n = `$__fj${next++}`; while (names.has(n)); names.add(n); added.push(['local', n, 'f64']); return n }
  const visit = (list, from, path) => {
    forwardIn(list, from, counts, copies, path, fresh)
    for (let i = from; i < list.length; i++) if (isArr(list[i])) visit(list[i], 1, copies && [...path, [list, list[i]]])
  }
  visit(fn, bodyStart, copies && [])
  if (added.length) fn.splice(bodyStart, 0, ...added)
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
export const copyRoots = (fn, bodyStart) => {
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
// value to forward and the statement's index. `pending` holds the stores no load has
// read since: a later store to the slot finds its predecessor dead. A store through
// another name forgets what the slot holds, but it reads nothing: what is pending stays.
const forwardIn = (list, from, counts, copies, path, fresh) => {
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
  const w = { defs: new Map(), writes: NONE, root: copies && (name => copies.root(name, path)) }
  const entries = new Map(), pending = new Map()
  const dead = []
  const keyOf = (base, at, win = w) => { const r = resolveAddr(base, win, at); return r && JSON.stringify(r) }
  const written = (name, maps) => { for (const m of maps) for (const [k, e] of m) if (e.value && e.value[0] === 'local.get' && e.value[1] === name) m.delete(k) }
  // A load that reads memory: its own slot, and any slot of another name it may reach
  // (src/ir/mem-alias.js); a slot of its own base at another offset is other bytes.
  const read = (key, off, mem) => {
    for (const [k, p] of pending) if (key ? k === `${key}|${off}` || !k.startsWith(key + '|') && mayAlias(mem, p.mem) : mayAlias(mem, p.mem)) pending.delete(k)
  }
  // The loads of `s` at statement `at`: a tracked slot's value (forwarded where `known`
  // has it and `forward` asks), else a read
  const loads = (s, at, win, known, forward) => walkAst(s, { enter: (n, parent, idx) => {
    if (n === s || !isArr(n) || typeof n[0] !== 'string') return
    if (n[0] === 'f64.load') {
      const a = accessOf(n), key = keyOf(a.base, at, win)
      const e = key && known.get(`${key}|${a.off}`)
      if (forward && e && e.value) parent[idx] = clone(e.value)
      else read(key, a.off, n.mem)
      return false
    }
    if (n[0].includes('.load')) read(null, 0, n.mem)
  } })
  // A store through another name forgets what it may overwrite: every slot, where the
  // emitter left no mark on either access; none of an array of another cell or of an
  // object's other field.
  const overwrite = (known, key, mem) => { for (const [k, e] of [...known]) if ((!key || !k.startsWith(key + '|')) && mayAlias(mem, e.mem)) known.delete(k) }
  for (let i = from; i < list.length; i++) {
    const s = list[i]
    if (!isArr(s)) continue
    if (s[0] === 'if' && diamond(s, i)) continue
    const whole = !hasOp(s, CONTROL_OPS)
    // The tees come first: a load inside the statement resolves through the tee before
    // it. The set the statement is comes after its loads were forwarded, so its
    // definition is what it holds then (a forwarded load: the other local).
    const set = s[0] === 'local.set' && typeof s[1] === 'string' ? s[1] : null
    walkAst(s, { enter: n => {
      if ((n[0] !== 'local.set' && n[0] !== 'local.tee') || typeof n[1] !== 'string') return
      written(n[1], [entries])
      if (n !== s) w.defs.set(n[1], { e: n[0] === 'local.tee' && whole ? n[2] : null, at: i })
    } })
    const isStore = s[0] === 'f64.store'
    const access = isStore ? accessOf(s) : null
    const parts = isStore ? [access.addr, access.val] : [s]
    if (!parts.every(p => inertFor(p, NONE))) { if (set) w.defs.set(set, { e: null, at: i }); entries.clear(); pending.clear(); continue }
    loads(s, i, w, entries, true)
    if (set) w.defs.set(set, { e: s[2], at: i })
    if (set && whole && isArr(s[2]) && s[2][0] === 'f64.load') {
      // A load into a local: a later load of the slot reads the local.
      const a = accessOf(s[2]), key = keyOf(a.base, i)
      if (key && !entries.has(`${key}|${a.off}`)) entries.set(`${key}|${a.off}`, { value: ['local.get', set], at: i, mem: s[2].mem })
      continue
    }
    if (!isStore) continue
    const key = keyOf(access.base, i)
    overwrite(entries, key, s.mem)
    if (!key) continue
    const slot = `${key}|${access.off}`
    if (pending.has(slot)) dead.push(pending.get(slot).at)
    entries.set(slot, { value: isLeaf(access.val) ? access.val : null, at: i, mem: s.mem })
    pending.set(slot, { at: i, mem: s.mem })
  }

  // An `if` whose arms only set locals and store f64s, of operands that call and branch
  // nowhere: each arm runs over what the list knows, and past it the list knows what
  // both arms leave. A slot both arms store last with a local or a literal holds one
  // value through a local each arm sets beside its store; a pending store both arms
  // overwrite, unread, is dead. The statement takes the arms' place in `defs` (at
  // fractions of its index), and what they write is no one value past it.
  function diamond(s, i) {
    let k = 1
    if (typeof s[k] === 'string') k++
    const test = s[k], arms = s.slice(k + 1)
    if (!isArr(test) || hasOp(test, CONTROL_OPS) || hasOp(test, CALLS) || !inertFor(test, NONE) || !arms.length || arms.length > 2) return false
    if (!arms.every(a => isArr(a) && (a[0] === 'then' || a[0] === 'else'))) return false
    for (const a of arms) for (let j = 1; j < a.length; j++) {
      const t = a[j]
      if (!isArr(t) || t[0] !== 'f64.store' && !(t[0] === 'local.set' && typeof t[1] === 'string')) return false
      const parts = t[0] === 'f64.store' ? [accessOf(t).addr, accessOf(t).val] : [t[2]]
      if (!parts.every(p => isArr(p) && !hasOp(p, CONTROL_OPS) && inertFor(p, NONE, false) && !hasOp(p, CALLS))) return false
    }
    if (!arms.some(a => a.slice(1).some(t => t[0] === 'f64.store'))) return false
    loads(test, i, w, entries, true)
    const sets = new Set(), after = []
    for (const a of arms) {
      const win = { defs: new Map(w.defs), writes: NONE, root: w.root }, known = new Map(entries), stored = new Map()
      for (let j = 1; j < a.length; j++) {
        const t = a[j], at = i + j / (a.length + 1)
        walkAst(t, { enter: n => {
          if ((n[0] !== 'local.set' && n[0] !== 'local.tee') || typeof n[1] !== 'string') return
          sets.add(n[1]); written(n[1], [known, stored])
          if (n !== t) win.defs.set(n[1], { e: n[0] === 'local.tee' ? n[2] : null, at })
        } })
        loads(t, at, win, known, false)
        if (t[0] === 'local.set') { win.defs.set(t[1], { e: t[2], at }); continue }
        const acc = accessOf(t), key = keyOf(acc.base, at, win)
        overwrite(known, key, t.mem)
        for (const [sl, e] of [...stored]) if ((!key || !sl.startsWith(key + '|')) && mayAlias(t.mem, e.mem)) stored.delete(sl)
        if (key) stored.set(`${key}|${acc.off}`, { value: isLeaf(acc.val) ? acc.val : null, j, mem: t.mem, arm: a })
      }
      after.push({ known, stored })
    }
    if (after.length === 1) after.push({ known: new Map(entries), stored: new Map() })
    const [x, y] = after
    for (const [sl, p] of [...pending]) if (x.stored.has(sl) && y.stored.has(sl)) { dead.push(p.at); pending.delete(sl) }
    for (const k of [...entries.keys()]) if (x.known.get(k) !== entries.get(k) || y.known.get(k) !== entries.get(k) || x.stored.has(k) || y.stored.has(k)) entries.delete(k)
    for (const name of sets) { written(name, [entries]); w.defs.set(name, { e: null, at: i }) }
    // (an arm's set of the joined local goes right after its last store of the slot, last first)
    const joins = []
    for (const [sl, a] of x.stored) {
      const b = y.stored.get(sl)
      if (!b || !a.value || !b.value || !fresh) continue
      const v = fresh()
      joins.push([a, v], [b, v])
      entries.set(sl, { value: ['local.get', v], at: i, mem: a.mem })
    }
    for (const [e, v] of joins.sort((p, q) => q[0].j - p[0].j)) e.arm.splice(e.j + 1, 0, ['local.set', v, clone(e.value)])
    return true
  }
  // A dead store goes whole, or leaves its operands' tees behind when something reads them.
  for (const i of dead.sort((x, y) => y - x)) {
    const a = accessOf(list[i])
    const keep = [a.addr, a.val].filter(n => !isLeaf(n) && !deadTees(n, counts)).map(n => ['drop', n])
    list.splice(i, 1, ...keep)
  }
}
