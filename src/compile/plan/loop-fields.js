/**
 * A field a loop reads and writes through one receiver lives in a local for
 * the loop: loaded before it, stored back after.
 *
 * Kernels keep their state on the object they are handed (`params._fcCur +=
 * (fc - params._fcCur) * k` per sample, `s.l += f * s.b` on a record read
 * from it, `params._out.b`): each access is a load, a store and, where the
 * record may be missing or the field unset, a test and a conversion. In a
 * local the field is a register, tested once.
 *
 * A receiver is a name the loop does not write, or a field of one the loop
 * reads and never writes (`params._out`, or `const s = params._sub` in the
 * loop): the record it holds is the same through every iteration. The local
 * stands for the field only where nothing else in the loop can reach it: the
 * loop calls nothing but Math, allocates and deletes nothing, holds no
 * closure, and cannot throw part way (every receiver it reads through is
 * present, and no value it computes with can be a BigInt), so the stores
 * back after it are the only ones anything can see; no other receiver in the
 * loop names the field, or every other one holds a record of other
 * construction sites (another object); a receiver is used for its fields
 * only; and no key the loop computes can name a field (an element of an
 * array or a typed array, or a number, never does). A field it writes is a slot of every layout the receiver may have,
 * so the store back after a loop that never wrote it stores what the slot held.
 *
 * So does an element at a constant index of an owned Float64Array the loop
 * stores numbers into (`s[0]`, `s[1]` of a filter section's state): no other
 * receiver of the loop may share its buffer (an array is another buffer, and
 * so is a typed array of another element kind that is no view, where nothing
 * in the program makes a typed array over existing memory: no `.buffer` read,
 * no buffer made, no typed array made from a value that may be a buffer), and
 * the copy runs where every index is within the array's length.
 *
 * So does one of a plain array whose length never changes, dense and of
 * numbers alone, at an index inside that length: the emitter reads such an
 * array where its pointer points (no growth ever moves it), so two of them are
 * one array exactly where their pointers are equal, and the copy runs where
 * the arrays of one construction cell it holds are distinct and no other
 * receiver of the loop may be one of them. A receiver may also be an alias of
 * an element at a constant index (`const s = state[0]`) no store of the loop
 * reaches, read ahead of the loop as a field's record is; and a field no store
 * of the loop names reads the same through any receiver, so it is held
 * whatever other receivers name it.
 *
 * A loop whose only inner loops are small `for`s of a constant count (from 0
 * by one below at most eight, whose bodies hold no loop, exit or closure) is
 * read with those written out, a copy per pass, the counter a literal in each:
 * a cascade's stages `state[j]`, `coefs[j]` then name constant elements, and the
 * stage state lives in locals across the sample loop. The loop takes the
 * written-out form only where it then holds something; the loop as written
 * stays beside it, as the emitter would unroll it.
 *
 * A receiver that may be null or undefined throws where the loop first
 * reads it: the loop runs as the copy using locals where every receiver is
 * present, and as itself otherwise, throwing where it did. The copy names
 * what it declares afresh: a binding declared once is one every analysis of
 * a binding takes whole.
 *
 * @module compile/plan/loop-fields
 */
import { ctx } from '../../ctx.js'
import { MUTATE_OPS, T, isBlockBody, isReassigned, some, someDeep, walkAst } from '../../ast.js'
import { frameRoots } from '../../function.js'
import { freshId } from '../../ir.js'
import { K, core, tagOf, paramOf, isNullable, hasTag } from '../../summary/kind.js'
import { TYPED_ELEM_VIEW_FLAG, TYPED_ELEM_ANY_VIEW_FLAG } from '../../../layout.js'
import { invalidateBodies } from '../analyze.js'
import { invalidateProgramFactsCache } from '../program-facts.js'
import { LOOP_OPS, collectBindings, nodeSize } from './common.js'
import { cloneWithSubst, smallConstForTripCount, containsNestedClosure, containsDeclOf } from '../../type.js'

const MAX_SIZE = 600
const ELEMENT_KINDS = new Set([K.ARRAY, K.TYPED])
const BARRIERS = new Set(['=>', 'yield', 'await', 'delete', 'new', 'label', 'throw', 'try', 'return', 'in', 'bigint', 'for-in', 'for-of'])

/** Replace every statement of `node` in a statement's place with what `f` returns, if anything. */
const statements = (node, f) => {
  if (!Array.isArray(node) || node[0] === '=>') return
  const op = node[0]
  const at = op === ';' ? node.map((_, i) => i).slice(1) : op === '{}' && isBlockBody(node) ? [1]
    : op === 'if' ? [2, 3] : op === 'while' ? [2] : op === 'for' ? [node.length - 1] : []
  for (const i of at) {
    if (!Array.isArray(node[i])) continue
    const r = f(node[i])
    if (r) node[i] = r
    else statements(node[i], f)
  }
  if (!at.length) for (let i = 1; i < node.length; i++) statements(node[i], f)
}

const isName = (n) => typeof n === 'string'
const isField = (n) => Array.isArray(n) && n[0] === '.' && typeof n[2] === 'string'
const numberKey = (k, view) => typeof k === 'number' || (Array.isArray(k) && k[0] == null && typeof k[1] === 'number') ||
  tagOf(core(view.kindOfExpr(k) ?? 0)) === K.NUMBER
const COUNT_OPS = new Set(['++', '--', '+1', '-1'])
/** A constant element index (`s[0]`), or null. */
const slotIndex = (k) => Array.isArray(k) && k[0] == null && Number.isInteger(k[1]) && k[1] >= 0 ? k[1] : typeof k === 'number' && Number.isInteger(k) && k >= 0 ? k : null
const isSlot = (n) => Array.isArray(n) && n[0] === '[]' && slotIndex(n[2]) != null
// The arrays of one construction cell a copy may hold, compared pairwise ahead of it.
const MAX_DISTINCT = 16
const VIEW_FLAGS = TYPED_ELEM_VIEW_FLAG | TYPED_ELEM_ANY_VIEW_FLAG
const ctorName = (c) => c?.replace(/^new\./, '') ?? null
const accessor = (p) => ctx.transform.accessorNames?.has(p) || ctx.transform.literalAccessorNames?.has(p) || p === '__proto__'
const mayBeMissing = (k) => k == null || isNullable(k) || hasTag(k, K.NULLISH) || hasTag(k, K.ABSENT)
const isObject = (k) => tagOf(core(k ?? 0)) === K.OBJECT

const TYPED_NEW = /^new\.(Big)?\w*\d+(Clamped)?Array$/
const BUFFER_NEW = new Set(['new.ArrayBuffer', 'new.SharedArrayBuffer', 'new.DataView'])
const SIZE_OPS = new Set(['+', '-', '*', '/', '%', '|', '&', '^', '<<', '>>', '>>>', '['])
/** Whether a typed array made from `a` (its first argument) may be made over a buffer. */
const mayBeBuffer = (view, a) => {
  if (Array.isArray(a) && a[0] === ',') a = a[1]
  if (a == null || typeof a === 'number' || (Array.isArray(a) && (a[0] == null || SIZE_OPS.has(a[0]) || (a[0] === '.' && a[2] === 'length')))) return false
  const k = view?.kindOfExpr(a)
  return k == null || tagOf(core(k)) === K.ANY || hasTag(k, K.BUFFER)
}
/** Whether some typed array of the program may be made over another's memory
 *  (`new Uint32Array(F.buffer)`: its stores write F's elements). */
const sharesMemory = (ast) => {
  const roots = [[ast, ctx.summary.at('')], ...(ctx.module.moduleInits ?? []).map(m => [m, ctx.summary.at('')]),
    ...ctx.funcs.list.filter(f => f.body && !f.raw).flatMap(f => frameRoots(f).map(r => [r, ctx.summary.at(f.sig)]))]
  return roots.some(([root, view]) => someDeep(root, n => Array.isArray(n) && (((n[0] === '.' || n[0] === '?.') && n[2] === 'buffer') ||
    (n[0] === '()' && typeof n[1] === 'string' && (BUFFER_NEW.has(n[1]) || (TYPED_NEW.test(n[1]) && mayBeBuffer(view, n[2])))))))
}

/** What `loop` does with fields, or null where it does anything that could reach them unseen. */
const censusOf = (loop, view) => {
  const declared = new Set(), written = new Set(), stored = new Set(), bare = new Set()
  const accesses = []               // [node, isWrite]: every static field access
  const elements = new Set()        // receivers of element accesses
  const slots = []                  // [node, isWrite, value]: every element access at a constant index
  const indexed = new Set()         // receivers read or written at an index the loop computes
  const aliases = new Map()         // `const s = r.q` or `const s = r[0]` in the loop: s → r.q, r[0]
  const elementStores = new Set()   // receivers of the element stores
  let open = false, computedRead = false
  const visit = (n, parent, slot) => {
    if (open) return
    if (isName(n)) {
      if (!(isField(parent) && slot === 1) && !(Array.isArray(parent) && parent[0] === '[]' && slot === 1)) bare.add(n)
      const k = view.kindOfExpr(n)
      if (k != null && (tagOf(core(k)) === K.ANY || hasTag(k, K.BIGINT))) open = true
      return
    }
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op == null || op === 'str') return
    // a literal's key is a name, not a read
    if (op === ':') { visit(n[2], n, 2); return }
    if (BARRIERS.has(op) || (LOOP_OPS.has(op) && n !== loop)) { open = true; return }
    if (op === '()') {
      if (!isName(n[1]) || !n[1].startsWith('math.') || n[1] === 'math.random') { open = true; return }
      for (let i = 2; i < n.length; i++) visit(n[i], n, i)
      return
    }
    if (op === 'let' || op === 'const') for (let i = 1; i < n.length; i++) {
      const d = n[i], name = Array.isArray(d) ? d[1] : d
      declared.add(name)
      if (Array.isArray(d) && (isField(d[2]) || isSlot(d[2])) && isName(d[2][1])) aliases.set(name, d[2])
      // the declared name is a binding, not a read
      if (Array.isArray(d)) { visit(d[2], d, 2); continue }
    }
    if (op === 'let' || op === 'const') return
    if (MUTATE_OPS.has(op)) {
      const t = n[1]
      if (isName(t)) written.add(t)
      else if (isField(t)) { stored.add(t[2]); accesses.push([t, true]) }
      else if (Array.isArray(t) && t[0] === '[]') {
        if (!ELEMENT_KINDS.has(tagOf(core(view.kindOfExpr(t[1]) ?? 0))) && !numberKey(t[2], view)) { open = true; return }
        elementStores.add(t[1])
        if (slotIndex(t[2]) != null) slots.push([t, true, COUNT_OPS.has(op) ? null : n[2]])
      }
      else { open = true; return }
    }
    if (op === '.') {
      if (!isField(n)) { open = true; return }
      if (!(MUTATE_OPS.has(parent?.[0]) && slot === 1)) accesses.push([n, false])
      if (isField(n[1]) && !isName(n[1][1])) { open = true; return }
      visit(n[1], n, 1)
      return
    }
    if (op === '[]') {
      if (!isName(n[1])) { open = true; return }
      elements.add(n[1])
      if (slotIndex(n[2]) == null) indexed.add(n[1])
      else if (!(MUTATE_OPS.has(parent?.[0]) && slot === 1)) slots.push([n, false])
      if (!ELEMENT_KINDS.has(tagOf(core(view.kindOfExpr(n[1]) ?? 0))) && !numberKey(n[2], view)) computedRead = true
    }
    for (let i = 1; i < n.length; i++) visit(n[i], n, i)
  }
  visit(loop, null, 0)
  return open ? null : { declared, written, stored, bare, accesses, elements, slots, indexed, aliases, elementStores, computedRead }
}

/** The fields and elements `loop` holds in locals, by receiver, the receivers
 *  the copy must find present and the arrays it must find distinct; null for none. */
const planLoop = (loop, view, shared) => {
  const c = censusOf(loop, view)
  if (!c) return null
  const { declared, written, stored, bare, accesses, elements, slots, indexed, aliases, elementStores, computedRead } = c
  const steady = (r) => isName(r) && !written.has(r) && !declared.has(r)
  const tagIn = (e) => tagOf(core(view.kindOfExpr(e) ?? 0))
  // an array whose elements stay what they are through the loop: no length
  // store, and no element store reaches one (a store's receiver is a typed
  // array, or an array of another construction cell)
  const unstoredArray = (r) => {
    const cell = tagIn(r) === K.ARRAY && !stored.has('length') ? view.arrayCellOf(r) : null
    return cell != null && [...elementStores].every(w => tagIn(w) === K.TYPED || (tagIn(w) === K.ARRAY && view.arrayCellOf(w) != null && view.arrayCellOf(w) !== cell))
  }
  // a record or an array read ahead of the loop: a steady name's field no store
  // names, or its element at a constant index no store reaches
  const chainOf = (e) => isField(e) && steady(e[1]) && !stored.has(e[2]) && !accessor(e[2]) && isObject(view.kindOfExpr(e[1]))
    ? { key: e[1] + '.' + e[2], base: e[1], field: e[2], expr: e }
    : isSlot(e) && steady(e[1]) && unstoredArray(e[1]) ? { key: e[1] + '[' + slotIndex(e[2]) + ']', base: e[1], index: slotIndex(e[2]), expr: e } : null
  // an alias stands for its record when nothing else writes it and it is used for fields and elements alone
  for (const [s, e] of aliases) if (written.has(s) || bare.has(s) || !chainOf(e)) aliases.delete(s)
  // the receiver an access reads through: a steady name, or a chain
  const receiverOf = (e) => {
    if (isName(e)) return aliases.has(e) ? chainOf(aliases.get(e)) : steady(e) ? { key: e, base: e } : null
    return chainOf(e)
  }
  const fields = new Map(), byName = new Map(), dropped = new Set()
  for (const [n, isWrite] of accesses) {
    const r = receiverOf(n[1])
    if (!r) { const s = byName.get(n[2]) ?? new Set(); s.add('\0'); byName.set(n[2], s); continue }
    const key = r.key + '|' + n[2]
    const f = fields.get(key) ?? { recv: r, p: n[2], written: false, nodes: [] }
    f.written ||= isWrite
    fields.set(key, f)
    const s = byName.get(n[2]) ?? new Set(); s.add(r.key); byName.set(n[2], s)
  }
  // a base used as itself may alias anything: its fields and chains stay
  for (const n of bare) dropped.add(n)
  // receivers naming a field the loop stores may be one object, unless their
  // records come from disjoint construction sites; one no store names reads
  // the same through any of them
  const sitesOf = (key) => { const r = [...fields.values()].find(f => f.recv.key === key)?.recv; return r ? view.sitesOfExpr(r.expr ?? r.key) : null }
  const apart = (keys) => {
    if (keys.has('\0')) return false
    const sets = [...keys].map(sitesOf)
    if (sets.some(s => !s)) return false
    const seen = new Set()
    for (const s of sets) for (const site of s) { if (seen.has(site)) return false; seen.add(site) }
    return true
  }
  const held = []
  for (const f of fields.values()) {
    if (dropped.has(f.recv.base) || (stored.has(f.p) && byName.get(f.p).size > 1 && !apart(byName.get(f.p))) || accessor(f.p)) continue
    const kind = f.recv.expr ? view.kindOfExpr(f.recv.expr) : view.kindOfExpr(f.recv.key)
    if (!isObject(kind)) continue
    const shapes = f.recv.expr ? view.shapesOfExpr(f.recv.expr) : view.shapesOfExpr(f.recv.key)
    if (f.written && (computedRead || !(shapes?.every(sid => view.layoutSlot(sid, f.p)) ?? false))) continue
    held.push(f)
  }
  // An element at a constant index the loop stores numbers into: of an owned
  // Float64Array (`s[0]`, `s[1]` of a filter section's state) no other
  // receiver of the loop shares the buffer of (another element kind, or an
  // array, is another object; a view is none of these), every index within its
  // length in the copy; or of an array whose length never changes, dense and
  // of numbers, every index within that length, that no other receiver of the
  // loop may be but such arrays of its construction cell, which the copy finds
  // distinct (`const s = state[j]` of each stage, the stages written out).
  const slotsOf = new Map()   // receiver → { max, written: Set(index) }
  for (const [n, isWrite, value] of slots) {
    const r = n[1], k = slotIndex(n[2])
    const e = slotsOf.get(r) ?? { max: -1, written: new Set(), numbers: true }
    e.max = Math.max(e.max, k)
    // a number, never a missing one: the element store would convert it, the local does not
    if (isWrite) { e.written.add(k); if (value != null) { const vk = view.kindOfExpr(value); if (tagOf(core(vk ?? 0)) !== K.NUMBER || mayBeMissing(vk)) e.numbers = false } }
    slotsOf.set(r, e)
  }
  const ownF64 = (r) => { const k = view.kindOfExpr(r); return tagOf(core(k ?? 0)) === K.TYPED && ctorName(view.typedPayloadCtorOfExpr(r)) === 'Float64Array' && !(paramOf(k) & VIEW_FLAGS) }
  const apartFrom = (r) => [...elements].every(r2 => {
    if (r2 === r) return true
    const k2 = view.kindOfExpr(r2), t2 = tagOf(core(k2 ?? 0))
    return t2 === K.ARRAY || (t2 === K.TYPED && ctorName(view.typedPayloadCtorOfExpr(r2)) != null && ctorName(view.typedPayloadCtorOfExpr(r2)) !== 'Float64Array' && !(paramOf(k2) & VIEW_FLAGS) && !shared())
  })
  // an array never resized (the emitter reads it without a forwarding hop, and
  // two of them are one exactly where their pointers are), holding numbers alone
  const fixedNumbers = (r, max) => {
    const k = view.kindOfExpr(r), el = tagOf(k) === K.ARRAY ? view.elemOfKind(k) : null
    return el != null && view.fixedLenOfExpr(r) > max && view.arrayDenseOfExpr(r) && tagOf(el) === K.NUMBER && !mayBeMissing(el)
  }
  const elems = [], plain = new Map()   // plain: construction cell → its arrays held
  for (const [r, e] of slotsOf) {
    const chain = aliases.has(r) ? chainOf(aliases.get(r)) : null
    if (!(chain || steady(r)) || bare.has(r) || indexed.has(r) || !e.numbers) continue
    if (accesses.some(([n, w]) => w && n[1] === r)) continue
    const typed = ownF64(r)
    if (typed ? chain || !apartFrom(r) : !fixedNumbers(r, e.max)) continue
    const el = { recv: r, chain, typed, max: e.max, written: e.written, indices: [...new Set(slots.filter(([n]) => n[1] === r).map(([n]) => slotIndex(n[2])))] }
    elems.push(el)
    if (!typed) { const cell = view.arrayCellOf(r), group = plain.get(cell); if (group) group.push(el); else plain.set(cell, [el]) }
  }
  for (const [cell, group] of plain) {
    const others = cell == null || group.length > MAX_DISTINCT || [...elements].some(r2 => !group.some(el => el.recv === r2) && tagIn(r2) === K.ARRAY && view.arrayCellOf(r2) === cell)
    if (others) { for (const el of group) elems.splice(elems.indexOf(el), 1); plain.delete(cell) }
  }
  if (!held.some(f => f.written) && !elems.some(e => e.written.size)) return null
  // every receiver of the loop, present in the copy: nothing in it throws
  const bases = new Set(), chains = new Map()
  const chained = (r) => { chains.set(r.key, r); if (mayBeMissing(view.kindOfExpr(r.base))) bases.add(r.base) }
  for (const [n] of accesses) {
    const r = receiverOf(n[1])
    if (!r) {
      // a receiver the copy cannot name ahead: it must be present by its kind
      if (mayBeMissing(view.kindOfExpr(n[1]))) return null
      continue
    }
    if (r.expr) chained(r)
    else if (mayBeMissing(view.kindOfExpr(r.key))) bases.add(r.key)
  }
  for (const e of elems) if (e.chain) chained(e.chain)
  for (const r of elements) if (mayBeMissing(view.kindOfExpr(r)) && !elems.some(e => e.recv === r && e.chain)) {
    if (!steady(r)) return null
    bases.add(r)
  }
  const distinct = [...plain.values()].filter(group => group.length > 1)
  return { held, elems, distinct, bases: [...bases], chains: [...chains.values()], aliases, view }
}

/** `loop` with each held field access naming its local, each chain its record's local, and each name it declares a name of its own. */
const substitute = (loop, plan, locals, records) => {
  const own = new Set()
  collectBindings(loop, own)
  const rename = new Map([...own].map(n => [n, `${n}${T}f${freshId(ctx)}`]))
  const recordOf = (e) => isName(e) && plan.aliases.has(e) ? records.get(chainKey(plan.aliases.get(e))) : (isField(e) || isSlot(e)) && isName(e[1]) ? records.get(chainKey(e)) : null
  const aliased = new Set()   // the declarations of aliases, each naming its record's local
  const walk = (n) => {
    if (isName(n)) return rename.get(n) ?? n
    if (!Array.isArray(n) || n[0] == null || n[0] === 'str') return n
    if (isField(n)) {
      const rec = recordOf(n[1])
      const local = locals.get((rec ? rec.key : n[1]) + '|' + n[2])
      if (local) return local
      return ['.', rec ? rec.local : walk(n[1]), n[2]]
    }
    if (n[0] === '[]' && isName(n[1]) && slotIndex(n[2]) != null && locals.has(n[1] + '[' + slotIndex(n[2]))) return locals.get(n[1] + '[' + slotIndex(n[2]))
    if (n[0] === ':') return [':', n[1], walk(n[2])]
    // an alias of a record reads the record's local
    if ((n[0] === 'let' || n[0] === 'const')) return [n[0], ...n.slice(1).map(d => {
      if (!(Array.isArray(d) && isName(d[1]) && plan.aliases.has(d[1]) && records.has(chainKey(plan.aliases.get(d[1]))))) return walk(d)
      const out = ['=', walk(d[1]), records.get(chainKey(plan.aliases.get(d[1]))).local]
      aliased.add(out)
      return out
    })]
    return n.map((c, i) => i === 0 ? c : walk(c))
  }
  const out = walk(loop)
  // an alias whose every access now names a local is declared for nothing: the
  // copy declares it not at all (a dead copy of the record in the loop would read,
  // to the passes after, as a value the loop carries)
  const uses = new Map()
  const count = (n) => { if (isName(n)) uses.set(n, (uses.get(n) ?? 0) + 1); else if (Array.isArray(n) && n[0] != null && n[0] !== 'str') for (let i = 1; i < n.length; i++) count(n[i]) }
  count(out)
  const dead = (d) => aliased.has(d) && uses.get(d[1]) === 1
  const prune = (n) => {
    if (!Array.isArray(n) || n[0] == null || n[0] === 'str' || n[0] === '=>') return n
    if (n[0] === ';') return [';', ...n.slice(1).map(prune).filter(s => !(Array.isArray(s) && (s[0] === 'let' || s[0] === 'const') && s.slice(1).every(dead)))]
    if ((n[0] === 'let' || n[0] === 'const') && n.slice(1).some(dead)) return [n[0], ...n.slice(1).filter(d => !dead(d))]
    return n.map((c, i) => i === 0 ? c : prune(c))
  }
  return aliased.size ? prune(out) : out
}
/** The record a chain reads ahead of the loop: `r.q`, `r[0]`. */
const chainKey = (e) => isField(e) ? e[1] + '.' + e[2] : e[1] + '[' + slotIndex(e[2]) + ']'

// Nodes the small loops of a loop may copy out, the emitter's budget for one (emit/control-flow.js).
const UNROLL_SIZE = 1000
const EXITS = new Set(['break', 'continue', 'return', 'label'])

/** The integer a count is on every run of the function, or null: a literal, the
 *  length of an array the summary knows for good (one never resized,
 *  `fixedLenOf`, or one another function built by counted pushes,
 *  `builtLenOf`), or a name the function declares once, `const` of either
 *  (`const n = coefs.length` of a design function's sections). */
const countsOf = (body, view) => {
  const declared = new Map(), init = new Map()
  someDeep(body, n => {
    if (Array.isArray(n) && (n[0] === 'let' || n[0] === 'const')) for (let i = 1; i < n.length; i++) {
      const d = n[i], name = Array.isArray(d) ? d[1] : d
      if (!isName(name)) continue
      declared.set(name, (declared.get(name) ?? 0) + 1)
      if (n[0] === 'const' && Array.isArray(d)) init.set(name, d[2])
    }
    return false
  })
  const known = (e) => Array.isArray(e) && e[0] == null && Number.isInteger(e[1]) ? e[1]
    : Array.isArray(e) && e[0] === '.' && e[2] === 'length' && isName(e[1]) ? view.builtLenOf(e[1]) ?? view.fixedLenOf(e[1]) : null
  return (e) => known(e) ?? (isName(e) && declared.get(e) === 1 && init.has(e) ? known(init.get(e)) : null)
}

/** `loop` with each loop its body runs, a `for` from 0 by one below a count
 *  of at most eight known on every run (`countsOf`), whose body holds no loop,
 *  exit or closure, written out
 *  once a pass: the counter a literal in each copy, the copy's declarations
 *  named afresh (`back`: each new name → the one it copies). Null where the
 *  body runs another loop, or the copies outgrow the emitter's budget. */
const unrollInner = (loop, countOf) => {
  const back = new Map()
  let ok = true, size = 0
  const unrollFor = (n) => {
    if (n[0] !== 'for' || n.length !== 5) return null
    const [, init, cond, step, body] = n
    const end = Array.isArray(cond) && cond.length === 3 ? countOf(cond[2]) : null
    const bound = end == null ? cond : [cond[0], cond[1], [null, end]]
    const trips = smallConstForTripCount(init, bound, step)
    if (trips == null) return null
    const name = init[1][1]
    if (some(body, m => LOOP_OPS.has(m[0]) || EXITS.has(m[0]), { skipArrow: false }) || containsNestedClosure(body) || isReassigned(body, name) || containsDeclOf(body, name)) return null
    size += trips * nodeSize(body)
    const own = new Set()
    collectBindings(body, own)
    const copies = []
    for (let i = 0; i < trips; i++) {
      const rename = new Map([...own].map(b => [b, `${b}${T}u${freshId(ctx)}`]))
      for (const [b, r] of rename) back.set(r, b)
      copies.push(cloneWithSubst(body, new Map([[name, [null, i]]]), rename))
    }
    return ['{}', [';', ...copies]]
  }
  const rewrite = (n) => {
    if (!ok || !Array.isArray(n) || n[0] == null || n[0] === 'str' || n[0] === '=>') return n
    if (LOOP_OPS.has(n[0])) { const u = unrollFor(n); if (!u) ok = false; return u ?? n }
    let out = null
    for (let i = 1; i < n.length; i++) { const c = rewrite(n[i]); if (c !== n[i]) (out ??= n.slice())[i] = c }
    return out ?? n
  }
  const body = loop[loop.length - 1], unrolled = rewrite(body)
  if (!ok || unrolled === body || size > UNROLL_SIZE) return null
  const out = loop.slice()
  out[out.length - 1] = unrolled
  return { loop: out, back }
}

/** `view` answering for the names of written-out copies as for the names they copy:
 *  a copy's binding holds what the binding it copies holds on some pass. */
const copiesView = (view, back) => {
  const orig = (e) => isName(e) ? back.get(e) ?? e : Array.isArray(e) && e[0] != null && e[0] !== 'str' ? e.map((c, i) => i === 0 ? c : orig(c)) : e
  return {
    kindOfExpr: e => view.kindOfExpr(orig(e)), sitesOfExpr: e => view.sitesOfExpr(orig(e)), shapesOfExpr: e => view.shapesOfExpr(orig(e)),
    typedPayloadCtorOfExpr: e => view.typedPayloadCtorOfExpr(orig(e)), fixedLenOfExpr: e => view.fixedLenOfExpr(orig(e)),
    arrayDenseOfExpr: e => view.arrayDenseOfExpr(orig(e)), arrayCellOf: e => view.arrayCellOf(orig(e)),
    layoutSlot: (sid, p) => view.layoutSlot(sid, p), elemOfKind: k => view.elemOfKind(k),
  }
}

/** Whether some innermost loop of the program stores a field or an element at a constant index: the pass has anything to look at. */
export const loopFieldCandidates = () => ctx.transform.optimize?.promoteLoopFields !== false && ctx.funcs.list.some(f => f.body && !f.raw &&
  some(f.body, n => LOOP_OPS.has(n[0]) && !some(n, m => m !== n && LOOP_OPS.has(m[0])) &&
    some(n, m => MUTATE_OPS.has(m[0]) && (isField(m[1]) || Array.isArray(m[1]) && m[1][0] === '[]' && slotIndex(m[1][2]) != null))))

export const promoteLoopFields = (ast) => {
  if (ctx.transform.optimize?.promoteLoopFields === false) return false
  const unrolling = ctx.transform.optimize?.smallConstForUnroll !== false
  let changed = false, memo
  const shared = () => memo ??= sharesMemory(ast)
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw) continue
    const view = ctx.summary?.at(func.sig)
    if (!view) continue
    let rewrote = false, counts = null
    statements(func.body, (st) => {
      if (!LOOP_OPS.has(st[0]) || nodeSize(st) > MAX_SIZE) return
      // a loop running small loops: those written out, where that lets the loop hold its state
      let loop = st, at = view
      if (some(st, n => n !== st && LOOP_OPS.has(n[0]))) {
        const u = unrolling ? unrollInner(st, counts ??= countsOf(func.body, view)) : null
        if (!u) return
        loop = u.loop; at = copiesView(view, u.back)
      }
      const plan = planLoop(loop, at, shared)
      if (!plan) return
      // a record the loop reads through a field or an element: read into `probe` where the
      // guard finds it present (an object or an array: present exactly where truthy, which
      // the arm then knows), and named in the copy by a `local` that is never missing
      const records = new Map(plan.chains.map(r => { const name = `${r.base}${T}${r.field ?? r.index}`; return [r.key, { ...r, probe: name + freshId(ctx), local: name + freshId(ctx) }] }))
      const recv = (r) => r.expr ? records.get(r.key).local : r.key
      const src = (e) => e.chain ? records.get(e.chain.key).local : e.recv
      const probe = (e) => e.chain ? records.get(e.chain.key).probe : e.recv
      const locals = new Map(plan.held.map(f => [f.recv.key + '|' + f.p, `${recv(f.recv)}${T}${f.p}${freshId(ctx)}`]))
      for (const e of plan.elems) for (const k of e.indices) locals.set(e.recv + '[' + k, `${src(e)}${T}${k}${freshId(ctx)}`)
      const decls = [...plan.held.map(f => ['=', locals.get(f.recv.key + '|' + f.p), ['.', recv(f.recv), f.p]]),
        ...plan.elems.flatMap(e => e.indices.map(k => ['=', locals.get(e.recv + '[' + k), ['[]', src(e), [null, k]]]))]
      const back = [...plan.held.filter(f => f.written).map(f => ['=', ['.', recv(f.recv), f.p], locals.get(f.recv.key + '|' + f.p)]),
        ...plan.elems.flatMap(e => [...e.written].map(k => ['=', ['[]', src(e), [null, k]], locals.get(e.recv + '[' + k)]))]
      const own = records.size ? [['const', ...[...records.values()].map(r => ['=', r.local, r.probe])]] : []
      const copy = ['{}', [';', ...own, ['let', ...decls], substitute(loop, plan, locals, records), ...back]]
      rewrote = true
      // the bases present, the records read, the typed arrays long enough, the arrays of a cell distinct
      const tests = [...plan.bases.map(r => ['!=', r, [null, null]]),
        ...[...records.values()].map(r => ['=', r.probe, r.expr]),
        ...plan.elems.filter(e => e.typed).map(e => ['>', ['.', e.recv, 'length'], [null, e.max]]),
        ...plan.distinct.flatMap(g => g.flatMap((a, i) => g.slice(i + 1).map(b => ['!==', probe(a), probe(b)])))]
      const head = records.size ? [['let', ...[...records.values()].map(r => r.probe)]] : []
      if (!tests.length) return copy
      // (the loop as written runs where the guard fails: cold, with every loop in it, as a version's twin is)
      walkAst(st, { enter: (n) => { if (n[0] === '=>') return false; if (n[0] === 'for' || n[0] === 'while') { n.cold = true; const b = n[n.length - 1]; if (Array.isArray(b)) b.cold = true } } })
      return ['{}', [';', ...head, ['if', tests.reduce((a, b) => ['&&', a, b]), copy, ['{}', [';', st]]]]]
    })
    if (rewrote) { invalidateProgramFactsCache(func.body); invalidateBodies([func.body]); changed = true }
  }
  return changed
}
