/**
 * Declare in a literal the keys its objects gain later, and give the literals
 * that meet one layout, where nothing reads their key set.
 *
 * State kept on a record the program built earlier (`params._lp1 += …` on
 * the options object a caller passed, `if (!p._buf) p._buf = …`) lands
 * beside the record's layout in the dynamic sidecar: every read and write
 * of the key hashes it at run time. Declared in the literal
 * (`{ fs, _lp1: undefined }`), the key is a slot like any other.
 *
 * A declared key is an own property from the literal on, which only an
 * operation asking the object for its keys can tell from a missing one: a
 * read of either is undefined. The summary names the construction sites
 * whose objects no such operation reaches (summary/query.js `keysUnseen`):
 * every holder is one it names (no hand-off to the host or to code it cannot
 * see), nothing enumerates them, tests a key with `in` or hasOwnProperty,
 * spreads them with other sources or deletes from them, and no store under
 * a computed name reaches them. declareWrittenKeys (declare-written-keys.js)
 * covers the stores that run before anything could look; this pass, the
 * objects nothing looks at.
 *
 * Sites the program joins (a parameter taking the literal of each caller, a
 * default `{}` beside the caller's object, the two arms of a choice, the
 * elements of one array) declare together: every literal of the group gets
 * the group's keys, and one layout, so a read through the join is one slot.
 * A key one literal lacks is its slot, undefined. A group with any site
 * whose keys are seen declares nothing: a name bound to its literals holds
 * one layout. Nor does a group take one layout where the room its literals
 * would leave unused is more than what they hold, or where a literal would
 * be given a key that is more than a slot (an inherited name).
 *
 * A group with no key to declare takes one layout where its literals write
 * the same keys in two orders (`{ x, y }` beside `{ y, x }`): nothing told
 * the two apart but the order nothing reads. The entries of a literal move
 * to the layout's order where each has no effect and cannot throw
 * (exit-tests.js `speculative`: a name, a member of an object that is
 * there, arithmetic over Numbers): they compute the same in any order.
 * Literals of two sets of keys stay two layouts: the layout tells which
 * keys an object has, and a read under a test of its kind is a slot of that
 * layout, of the kind that layout holds.
 *
 * Left out: a name the literal inherits (`toString`, `constructor`), an
 * array-index key (canonical slot order), `length` and `__proto__`, a class
 * instance, an accessor, and a name the compiler minted.
 *
 * @module compile/plan/declare-unseen-keys
 */

import { ctx } from '../../ctx.js'
import { T, CLASS_T, isBrand, isArrayIndexKey, accessorOf } from '../../ast.js'
import { frameRoots } from '../../function.js'
import { invalidateProgramFactsCache } from '../program-facts.js'
import { speculative } from './exit-tests.js'

const INHERITED = new Set(['constructor', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toString', 'toLocaleString', 'valueOf',
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', '__proto__', 'length'])

/** The key of a static literal entry, or null. */
const entryKey = (p) => typeof p === 'string' ? p : Array.isArray(p) && p[0] === ':' && typeof p[1] === 'string' ? p[1] : null

/** One order of `keys` that keeps each of `lists` in its order, or null when two disagree. */
const mergeOrders = (lists, keys) => {
  const before = new Map(keys.map(k => [k, new Set()]))
  for (const l of lists) for (let i = 1; i < l.length; i++) before.get(l[i]).add(l[i - 1])
  const out = [], done = new Set()
  while (out.length < keys.length) {
    const k = keys.find(k => !done.has(k) && [...before.get(k)].every(p => done.has(p)))
    if (k === undefined) return null
    out.push(k); done.add(k)
  }
  return out
}

export const declareUnseenKeys = (ast) => {
  const view = ctx.summary
  if (!view?.keysUnseen || ctx.transform.optimize?.declareUnseenKeys === false) return false
  const accessors = ctx.transform.literalAccessorNames ?? new Set()
  const plain = (key) => typeof key === 'string' && !INHERITED.has(key) && !isArrayIndexKey(key) && !isBrand(key) &&
    !key.includes(T) && !key.includes(CLASS_T) && !accessors.has(key) && !accessorOf(key, accessors)

  // Every static literal the summary made objects of, and the names bound to one.
  const lits = new Map()      // literal node → its sites
  const scopes = new Map()    // literal node → the scope it stands in (its names' kinds)
  const bound = new Map()     // name → literal nodes
  const bind = (name, v) => { if (typeof name === 'string' && lits.has(v)) { let l = bound.get(name); if (!l) bound.set(name, l = []); l.push(v) } }
  const visit = (n, at) => {
    if (!Array.isArray(n)) return
    if (n[0] === '{}' && !lits.has(n)) {
      const sites = view.literalSites(n)
      if (sites.length && sites.every(s => view.siteLayout(s) === view.siteLayout(sites[0])) &&
        n.slice(1).every((p, i, all) => { const k = entryKey(p); return k !== null && !isBrand(k) && all.findIndex(q => entryKey(q) === k) === i })) { lits.set(n, sites); scopes.set(n, at) }
    }
    // (a closure's names are its own scope's: its literals' entries are not asked)
    for (let i = 1; i < n.length; i++) visit(n[i], n[0] === '=>' ? null : at)
    if ((n[0] === '=' || n[0] === '??=') && typeof n[1] === 'string') bind(n[1], n[2])
  }
  const top = view.at('')
  visit(ast, top)
  for (const init of ctx.module.moduleInits ?? []) visit(init, top)
  for (const fn of ctx.funcs.list) if (fn.body && !fn.raw) for (const r of frameRoots(fn)) visit(r, view.at(fn.sig))
  if (!lits.size) return false

  // Groups: the sites values join, a literal's sites, the literals one name holds.
  const up = new Map()
  const find = (s) => { let r = s; while (up.has(r) && up.get(r) !== r) r = up.get(r); if (!up.has(s)) up.set(s, s); else up.set(s, r); return r }
  const union = (list) => { const r = find(list[0]); for (let i = 1; i < list.length; i++) { const o = find(list[i]); if (o !== r) up.set(o, r) } }
  for (const set of view.joinedSites()) if (set.length > 1) union(set)
  for (const sites of lits.values()) union(sites)
  for (const nodes of bound.values()) union(nodes.flatMap(n => lits.get(n)))
  const groups = new Map()    // root → { sites: Set, lits: [] }
  const group = (s) => { const r = find(s); let g = groups.get(r); if (!g) groups.set(r, g = { sites: new Set(), lits: [] }); return g }
  for (const [node, sites] of lits) { const g = group(sites[0]); g.lits.push(node); for (const s of sites) g.sites.add(s) }
  for (const set of view.joinedSites()) for (const s of set) if (up.has(s)) group(s).sites.add(s)

  const layoutKeys = (node) => ctx.schema.list[view.siteLayout(lits.get(node)[0])] ?? []
  const finals = new Map()    // literal node → its layout, declared keys in place
  for (const g of groups.values()) {
    const sites = [...g.sites].sort((a, b) => a - b)
    if (!sites.every(s => view.keysUnseen(s))) continue
    const own = g.lits.map(layoutKeys)
    if (own.some(keys => keys.some(k => accessorOf(k, accessors)) || ctx.schema.hidden.has(keys))) continue
    const side = []
    for (const s of sites) for (const k of view.sideKeys(s)) if (plain(k) && !side.includes(k)) side.push(k)
    // Nothing to declare: literals of one layout stay as they are, and so do literals of two sets
    // of keys, whose layouts tell which keys an object has (a read under a test of its kind is
    // a slot of that layout, of the kind that layout holds). The same keys in two orders go on.
    if (!side.length && (own.every(keys => keys.join('\0') === own[0].join('\0')) || !own.every(keys => keys.length === own[0].length && keys.every(k => own[0].includes(k))))) continue
    const entries = g.lits.map(n => n.slice(1).map(entryKey))
    const all = [...new Set([...entries.flat(), ...own.flat(), ...side])]
    // What each literal's objects hold as written: its keys, and those stored on them later. The
    // rest of the layout is room they never use: a group takes one layout where that room, over
    // its literals, is no more than what they hold, and where no literal is given a key that is
    // more than a slot (an inherited name: `toString: undefined` would answer for the prototype's).
    const holds = g.lits.map((n, i) => new Set([...own[i], ...lits.get(n).flatMap(s => view.sideKeys(s)).filter(plain)]))
    if (holds.some(h => all.some(k => !h.has(k) && !plain(k)))) continue
    if (holds.reduce((room, h) => room + all.length - 2 * h.size, 0) > 0) continue
    // One layout for the group: an order of all its keys that keeps each
    // literal's entries in their order (they evaluate in it); the keys a
    // literal lacks sit where the layout has them, undefined. Where the
    // literals' orders disagree, an order that keeps those of the literals
    // with an entry that has an effect or can throw: the entries of the
    // others compute the same wherever they stand.
    const moves = (node) => node.slice(1).every(p => typeof p === 'string' || scopes.get(node) != null && speculative(p[2], scopes.get(node)))
    const one = mergeOrders(entries, all) ?? mergeOrders(entries.filter((_, i) => !moves(g.lits[i])), all)
    g.lits.forEach((node, i) => {
      const keys = one ?? [...entries[i], ...all.filter(k => !entries[i].includes(k))]
      if (keys.join('\0') !== entries[i].join('\0') || keys.join('\0') !== own[i].join('\0')) finals.set(node, keys)
    })
  }
  if (!finals.size) return false

  const olds = new Map([...finals.keys()].map(n => [n, view.siteLayout(lits.get(n)[0])]))
  for (const [node, keys] of finals) {
    const at = new Map(node.slice(1).map(p => [entryKey(p), p]))
    node.splice(1, node.length - 1, ...keys.map(k => at.get(k) ?? [':', k, [, undefined]]))
    ctx.schema.register(keys)
  }
  // A name every literal of which now holds one layout is bound to it, as
  // prepare binds a declared literal (module/object.js allocates the literal
  // with the binding's layout, which the per-name slot paths read).
  for (const [name, nodes] of bound) {
    const keys = nodes.map(n => finals.get(n))
    if (!keys[0] || keys.some(k => !k || k.join('\0') !== keys[0].join('\0'))) continue
    if (!ctx.schema.vars.has(name) || ctx.schema.vars.get(name) !== olds.get(nodes[0])) continue
    ctx.schema.vars.set(name, ctx.schema.register(keys[0]))
  }
  invalidateProgramFactsCache(ast)
  return true
}
