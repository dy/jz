/**
 * One numbering of a function's values: an expression that computes again what an earlier
 * one computed reads the earlier's local.
 *
 * A value is named by what it is: a tag of a box (`$__ptr_type X`), a typed subscript's
 * address (`base + idx << k`, as one sum: optimize/address.js), a load (its op, its offset and
 * the local its address is, a copy as the local it copies). The walk goes in the order the
 * code runs and keeps, for each name, the run of sites since the value was last made: a write
 * of a local the value reads ends it, as does, for a load, a store that may reach its bytes
 * (optimize/address.js mayAlias), a call that is no function of its operands alone
 * (optimize/effects.js) and every bulk or atomic memory operation. What holds past a join is
 * what holds on each way into it: both arms of an `if` (an arm that never completes adds
 * nothing), a block's end and every branch to it, nothing at a loop's head or past it, nothing
 * past a handler. A node several parents hold runs at each: none is a site.
 *
 * Whether to keep a value in a local is apart from whether two are one: a run of two sites or
 * more holds it in a local the first site tees (a lone site is pure cost); a load is read from
 * the local only by sites at the first's depth or above it (a load in an arm the first is
 * outside of runs only on that way, and a local read there would become a select); a load's
 * address that steps further than the bytes it reads each round of its loop, a field of a
 * record, is held by no local, nor a part of it: the lane lift gathers the load, each lane its
 * own address (vectorize/map.js), and a local holds one lane's.
 *
 * The uses, each a kind of value asked by a step of the table where its pass stood: TAG
 * (`hoistPtrType`), OFFSET (`hoistPtrOffset`), SUBSCRIPT (`hoistAddrBase`), LOAD (`reuseLoads`)
 * (optimize/pass-table.js; no record keyed by a step's name, its header says why).
 *
 * @module optimize/numbering
 */
import { findBodyStart, nextLocalId, buildRefcount, leavesTo, leftLabels } from '../ir.js'
import { NO_MODULE } from './effects.js'
import { HEADER_STORE_FREE, addressOf, keyOf, linear, memop, mayAlias } from './address.js'

const isArr = Array.isArray
const get = (n) => isArr(n) && n[0] === 'local.get' && typeof n[1] === 'string'
const LOAD = /^(i32|i64|f32|f64)\.load(8_[su]|16_[su]|32_[su])?$/
const STORE = /^(i32|i64|f32|f64|v128)\.store(8|16|32)?$/
// what may change memory, or run code that does, but a store: it forgets every load
const CLOBBER = /^(call_indirect|call_ref|return_call|return_call_indirect|return_call_ref|memory\.(copy|fill|init|grow)|.*\.atomic\..*)$/
// what may move a block: a store of a header word (a payload store never writes one), a bulk
// memory operation, an indirect or tail call
const MOVES = /^(?:[if](?:32|64)\.(?:store|atomic)|v128\.store|memory\.(?:grow|copy|fill|init)|call_indirect|call_ref|return_call)/
const LEAVE = new Set(['unreachable', 'return', 'return_call', 'return_call_indirect', 'return_call_ref', 'throw', 'rethrow'])
// (a block a branch or a handler's catch clause inside leaves, src/ir/control.js, completes)
const never = (n) => isArr(n) && (LEAVE.has(n[0]) || n[0] === 'drop' && n.length === 2 && never(n[1]) ||
  n[0] === 'block' && never(n[n.length - 1]) && !leftLabels(n).size)
// (a block or an if a branch or a catch clause inside goes to the end of: what holds there may come from before a run's first site)
const leftTo = (n) => typeof n[1] === 'string' && leavesTo(n, n[1])
// (the locals a pure i32 subscript reads, or null where one of its leaves is no local, constant or register op)
const SUBSCRIPT_OPS = new Set(['i32.add', 'i32.sub', 'i32.mul', 'i32.shl', 'i32.shr_s', 'i32.shr_u', 'i32.and', 'i32.or', 'i32.xor', 'i32.wrap_i64'])
const subscriptDeps = (n, deps) => {
  if (!isArr(n)) return null
  if (get(n)) { deps.add(n[1]); return deps }
  if (n[0] === 'i32.const' && typeof n[1] === 'number') return deps
  if (!SUBSCRIPT_OPS.has(n[0])) return null
  for (let i = 1; i < n.length; i++) if (!subscriptDeps(n[i], deps)) return null
  return deps
}

// (a typed subscript's address, `base + idx << k`, of locals and constants: a constant index leaves the memarg its sum;
// `steps(atom)`, whether the innermost loop around it writes the atom's local)
const subscriptSite = (n, root, consts, parent, steps) => {
  if (n[0] !== 'i32.add' || n.length !== 3) return null
  const [a, b] = get(n[1]) ? [n[1], n[2]] : get(n[2]) ? [n[2], n[1]] : [null, null]
  if (!a || !(get(b) || isArr(b) && b[0] === 'i32.shl' && b.length === 3 && isArr(b[2]) && b[2][0] === 'i32.const' && typeof b[2][1] === 'number')) return null
  const deps = subscriptDeps(get(b) ? b : b[1], new Set([a[1]]))
  if (!deps || [...deps].every(d => d === a[1] || consts.has(d))) return null
  // (a sum nested deeper than the reader follows is no one value: no site)
  const lin = linear(n, look(root)), m = memop(parent)
  if (!lin) return null
  if (m?.addr === n && !m.store && [...lin.terms].some(([k, t]) => Math.abs(t.scale) > m.bytes && steps(k))) return GATHERED
  return { key: keyOf(lin), deps: [...deps].map(root) }
}
const GATHERED = { gathered: true }
// (the locals `n` writes)
const writesIn = (n, out = new Set()) => {
  if (!isArr(n)) return out
  if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') out.add(n[1])
  for (let i = 1; i < n.length; i++) writesIn(n[i], out)
  return out
}
// (a load at a local, a copy of a local read as the local)
const loadSite = (n, root) => {
  if (!LOAD.test(n[0])) return null
  const m = memop(n), a = m.addr
  if (n.length !== m.ai + 1 || !isArr(a) || (a[0] !== 'local.get' && a[0] !== 'local.tee') || typeof a[1] !== 'string') return null
  const r = root(a[1])
  return { key: n[0] + ' ' + m.off + ' ' + r, deps: [r], load: addressOf(n, look(root), tee), first: a[0] === 'local.tee' }
}
// The kinds of value, as the uses ask: `site(node, root)` names a node { key, deps, load? } or null.
// the tag bits of a box, which never change for a given box, named by the local that holds the box
// and not the one it copies: a tag shared through a copy took three.js's animation case a tenth
// slower, in its microtask drain, the one change there a copy watr then dropped
export const TAG = { prefix: 'pt', type: () => 'i32', site: (n) => boxCall(n, '$__ptr_type', own) }
const own = (name) => name
// an array's live storage through its forward word, which moves where a block may (`MOVES`, a call `fx.header`)
export const OFFSET = { prefix: 'po', type: () => 'i32', site: (n, root) => { const s = boxCall(n, '$__ptr_offset', root); if (s) s.moves = true; return s } }
export const SUBSCRIPT = { prefix: 'ab', type: () => 'i32', consts: true, site: subscriptSite }
export const LOAD_AT = { prefix: 'rl', type: (n) => n[0].slice(0, 3), shallow: true, site: loadSite }
// (a call of a helper on a box a local holds: named by the local, a copy as the local it copies)
const boxCall = (n, callee, root) => {
  if (n[0] !== 'call' || n[1] !== callee || n.length !== 3) return null
  const a = n[2], x = isArr(a) && a[0] === 'i64.reinterpret_f64' && a.length === 2 ? a[1] : a
  return get(x) ? { key: root(x[1]), deps: [root(x[1])] } : null
}
const look = (root) => (x) => x[0] === 'local.get' && root(x[1]) !== x[1] ? 'l:' + root(x[1]) : undefined
const tee = (a) => isArr(a) && a[0] === 'local.tee' ? ['local.get', a[1]] : a

/** Number `fn`'s values of `kind` (TAG, OFFSET, SUBSCRIPT, LOAD_AT) and read each run of two sites or more from one local; `fx` the module's effects. */
export function numberValues(fn, kind, fx = NO_MODULE) {
  if (!isArr(fn) || fn[0] !== 'func') return false
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return false
  const refs = buildRefcount(fn)
  const consts = kind.consts ? constLocals(fn, bodyStart) : null
  // state: open runs by key, and copies (a local → the local it holds the value of)
  let open = new Map(), alias = new Map()
  const root = (name) => alias.get(name) ?? name
  const runs = new Map()   // key → its runs: [{ parent, idx, tee }]
  let shared = 0, depth = 0
  // the loops the walk is in, each with the locals it writes once asked
  const loops = []
  const steps = (atom) => { const l = loops[loops.length - 1]; return !!l && atom.startsWith('l:') && (l.writes ??= writesIn(l.node)).has(atom.slice(2)) }
  const meet = (a, b) => { if (!a || !b) return new Map(a ?? b ?? []); const m = new Map(); for (const [k, v] of a) if (b.get(k) === v) m.set(k, v); return m }
  const clear = () => { open = new Map(); alias = new Map() }
  const wrote = (name) => {
    for (const [k, r] of [...open]) if (r.deps.includes(name)) open.delete(k)
    for (const [a, r] of [...alias]) if (a === name || r === name) alias.delete(a)
  }
  const forgetLoads = (acc) => { for (const [k, r] of [...open]) if (r.load && (!acc || mayAlias(acc, r.load))) open.delete(k) }
  const walk = (n, parent, idx) => {
    if (!isArr(n)) return
    if (refs.get(n) > 1) { shared++; visit(n, parent, idx); shared-- }
    else visit(n, parent, idx)
  }
  const visit = (n, parent, idx) => {
    const op = n[0]
    let s = !shared && kind.site(n, root, consts, parent, steps)
    // (a value no local holds: neither it nor a part of it is a site)
    if (s === GATHERED) return
    if (s) {
      const r = open.get(s.key)
      if (r && !s.first && (!kind.shallow || r.depth >= depth)) { r.sites.push({ parent, idx }); return }
      // (a load's address may tee a local; a tag's or an address's operands are reads, no site in them)
      if (s.load) for (let i = 1; i < n.length; i++) walk(n[i], n, i)
      if (r && kind.shallow && r.depth < depth) return
      // (a load whose address tees a local reads it after the tee: named as the walk left it)
      if (s.first) s = kind.site(n, root, consts)
      const run = { sites: [{ parent, idx, node: n }], deps: s.deps, load: s.load, moves: s.moves, depth }
      open.set(s.key, run)
      if (!runs.has(s.key)) runs.set(s.key, [])
      runs.get(s.key).push(run)
      return
    }
    if (op === 'if') {
      let i = 1
      while (i < n.length && (!isArr(n[i]) || n[i][0] === 'result' || n[i][0] === 'param' || n[i][0] === 'type')) i++
      for (; i < n.length && !(isArr(n[i]) && (n[i][0] === 'then' || n[i][0] === 'else')); i++) walk(n[i], n, i)
      const before = open, beforeAlias = alias
      const ends = []
      for (const arm of ['then', 'else']) {
        const a = n.find((c, j) => j > 0 && isArr(c) && c[0] === arm)
        open = new Map(before); alias = new Map(beforeAlias)
        depth++
        if (a) for (let j = 1; j < a.length; j++) walk(a[j], a, j)
        depth--
        ends.push(a && never(a[a.length - 1]) ? [null, null] : [open, alias])
      }
      open = meet(ends[0][0], ends[1][0]); alias = meet(ends[0][1], ends[1][1])
      if (leftTo(n)) clear()
      return
    }
    if (op === 'block') {
      for (let i = 1; i < n.length; i++) walk(n[i], n, i)
      // (a branch to the block's end may come from before a run's first site)
      if (leftTo(n)) clear()
      return
    }
    if (op === 'loop' || op === 'try' || op === 'try_table' || typeof op === 'string' && op.startsWith('catch') || op === 'delegate') {
      clear()
      if (op === 'loop') loops.push({ node: n, writes: null })
      for (let i = 1; i < n.length; i++) walk(n[i], n, i)
      if (op === 'loop') loops.pop()
      clear()
      return
    }
    for (let i = 1; i < n.length; i++) walk(n[i], n, i)
    if ((op === 'local.set' || op === 'local.tee') && typeof n[1] === 'string') {
      wrote(n[1])
      const v = n[2]
      if (n.length === 3 && get(v) && root(v[1]) !== n[1]) alias.set(n[1], root(v[1]))
      return
    }
    if (typeof op !== 'string') return
    if (op === 'call' ? fx.header(n[1]) : MOVES.test(op) && !HEADER_STORE_FREE.has(op)) for (const [k, r] of [...open]) if (r.moves) open.delete(k)
    if (STORE.test(op)) { forgetLoads(addressOf(n, look(root), tee)); return }
    if (op === 'call') { if (fx.kind(n[1]) !== 'pure') forgetLoads(null); return }
    if (CLOBBER.test(op)) forgetLoads(null)
  }
  for (let i = bodyStart; i < fn.length; i++) walk(fn[i], fn, i)
  // the runs of two sites or more, one local a name
  let id = null
  const locals = []
  for (const list of runs.values()) {
    if (!list.some(r => r.sites.length >= 2)) continue
    id ??= nextLocalId(fn, kind.prefix)
    const local = `$__${kind.prefix}${id++}`
    locals.push(['local', local, kind.type(list[0].sites[0].node)])
    for (const r of list) {
      if (r.sites.length < 2) continue
      const [first, ...rest] = r.sites
      first.parent[first.idx] = ['local.tee', local, first.parent[first.idx]]
      for (const s of rest) s.parent[s.idx] = ['local.get', local]
    }
  }
  if (locals.length) fn.splice(bodyStart, 0, ...locals)
  return locals.length > 0
}

// The locals a function writes once, with an i32 constant (an unrolled loop's per-copy index),
// and never a parameter: an address of one is the base plus a constant, which the memargs take
// once watr folds it.
const constLocals = (fn, bodyStart) => {
  const writes = new Map()
  const visit = (n) => {
    if (!isArr(n)) return
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string')
      writes.set(n[1], !writes.has(n[1]) && isArr(n[2]) && n[2][0] === 'i32.const' && n[2].length === 2)
    for (let i = 1; i < n.length; i++) visit(n[i])
  }
  for (let i = bodyStart; i < fn.length; i++) visit(fn[i])
  const out = new Set()
  for (const [name, w] of writes) if (w) out.add(name)
  for (let i = 2; i < bodyStart; i++) if (isArr(fn[i]) && fn[i][0] === 'param') out.delete(fn[i][1])
  return out
}

// A byte or half of a loaded word, read alone: the narrow load of it. Wasm memory is
// little-endian, so byte k of the word at A is the byte at A + k, inside the word's own
// bytes: `(a[i] >>> 8) & 0xff` reads one byte where it would shift and mask the word
// (clang's load narrowing). A word in a local (a load the numbering reads from a local, `reuseLoads`) narrows when its
// one write is the load and every read takes the same byte: the local holds that byte.
const BYTE_MASK = { 255: 1, 65535: 2 }
const u32 = (n) => { const v = isArr(n) && n[0] === 'i32.const' ? Number(n[1]) : NaN; return Number.isInteger(v) ? v >>> 0 : null }
/** `(i32.load [offset=o] A)` with no other memarg: [offset, address], or null. */
const word = (n) => {
  if (!isArr(n) || n[0] !== 'i32.load') return null
  if (n.length === 2) return [0, n[1]]
  if (n.length === 3 && typeof n[1] === 'string' && n[1].startsWith('offset=')) return [Number(n[1].slice(7)), n[2]]
  return null
}
/** The part of a word `n` takes: { x: the word operand, width, signed, at: byte } or null.
 *  `x & mask`, `(x >>> s) & mask`, `x >>> 24|16`, `x >> 24|16`. */
const extract = (n) => {
  if (!isArr(n) || n.length !== 3) return null
  if (n[0] === 'i32.and') {
    const width = BYTE_MASK[u32(n[2])]
    if (!width) return null
    const x = n[1]
    if (isArr(x) && x[0] === 'i32.shr_u' && x.length === 3) {
      const s = u32(x[2])
      return s != null && s % 8 === 0 && s / 8 + width <= 4 ? { x: x[1], width, signed: false, at: s / 8 } : null
    }
    return { x, width, signed: false, at: 0 }
  }
  if (n[0] === 'i32.shr_u' || n[0] === 'i32.shr_s') {
    const s = u32(n[2])
    return s === 24 || s === 16 ? { x: n[1], width: s === 24 ? 1 : 2, signed: n[0] === 'i32.shr_s', at: s / 8 } : null
  }
  return null
}
const narrow = (e, w) => [`i32.load${e.width === 1 ? 8 : 16}_${e.signed ? 's' : 'u'}`, ...(w[0] + e.at ? [`offset=${w[0] + e.at}`] : []), w[1]]
const same = (a, b) => a.width === b.width && a.signed === b.signed && a.at === b.at
export function narrowByteLoads(fn) {
  if (!isArr(fn) || fn[0] !== 'func') return false
  const bodyStart = findBodyStart(fn)
  // A local's write and reads: the write, every read with the part it takes (null: the word).
  const locals = new Map()
  const of = (name) => { let r = locals.get(name); if (!r) locals.set(name, r = { defs: [], reads: [] }); return r }
  const scan = (n, parent, idx) => {
    if (!isArr(n)) return
    const e = extract(n)
    const x = e && e.x
    if (x && (x[0] === 'local.get' || x[0] === 'local.tee') && typeof x[1] === 'string') {
      of(x[1]).reads.push({ e, parent, idx })
      if (x[0] === 'local.tee') { of(x[1]).defs.push(x); for (let i = 2; i < x.length; i++) scan(x[i], x, i) }
      return
    }
    if (n[0] === 'local.get') of(n[1]).reads.push({ e: null })
    else if (n[0] === 'local.set') of(n[1]).defs.push(n)
    else if (n[0] === 'local.tee') { of(n[1]).defs.push(n); of(n[1]).reads.push({ e: null }) }
    for (let i = 1; i < n.length; i++) scan(n[i], n, i)
  }
  for (let i = bodyStart; i < fn.length; i++) scan(fn[i], fn, i)
  const types = new Map()
  for (let i = 2; i < bodyStart; i++) if (isArr(fn[i]) && fn[i][0] === 'local') types.set(fn[i][1], fn[i][2])
  let did = false
  for (const [name, { defs, reads }] of locals) {
    if (types.get(name) !== 'i32' || defs.length !== 1 || !reads.length) continue
    const w = word(defs[0][2]), e = reads[0].e
    if (!w || !e || !reads.every(r => r.e && same(r.e, e))) continue
    defs[0][2] = narrow(e, w)
    for (const r of reads) r.parent[r.idx] = r.e.x
    did = true
  }
  // a part of a load read in place, the widest pattern first (`(x >>> 16) & 255` is a byte)
  const visit = (n) => {
    if (!isArr(n)) return n
    const e = extract(n), w = e && word(e.x)
    if (w) { did = true; const r = narrow(e, w); r[r.length - 1] = visit(r[r.length - 1]); return r }
    for (let i = 1; i < n.length; i++) n[i] = visit(n[i])
    return n
  }
  for (let i = bodyStart; i < fn.length; i++) fn[i] = visit(fn[i])
  return did
}
