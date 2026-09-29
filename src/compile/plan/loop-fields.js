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
 * receiver of the loop may share its buffer (an array, or a typed array of
 * another element kind that is no view, is another buffer), and the copy
 * runs where every index is within the array's length.
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
import { MUTATE_OPS, T, isBlockBody, some } from '../../ast.js'
import { freshId } from '../../ir.js'
import { K, core, tagOf, paramOf, isNullable, hasTag } from '../../summary/kind.js'
import { TYPED_ELEM_VIEW_FLAG, TYPED_ELEM_ANY_VIEW_FLAG } from '../../../layout.js'
import { invalidateBodies } from '../analyze.js'
import { invalidateProgramFactsCache } from '../program-facts.js'
import { LOOP_OPS, collectBindings, nodeSize } from './common.js'

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
const VIEW_FLAGS = TYPED_ELEM_VIEW_FLAG | TYPED_ELEM_ANY_VIEW_FLAG
const ctorName = (c) => c?.replace(/^new\./, '') ?? null
const accessor = (p) => ctx.transform.accessorNames?.has(p) || ctx.transform.literalAccessorNames?.has(p) || p === '__proto__'
const mayBeMissing = (k) => k == null || isNullable(k) || hasTag(k, K.NULLISH) || hasTag(k, K.ABSENT)
const isObject = (k) => tagOf(core(k ?? 0)) === K.OBJECT

/** What `loop` does with fields, or null where it does anything that could reach them unseen. */
const censusOf = (loop, view) => {
  const declared = new Set(), written = new Set(), stored = new Set(), bare = new Set()
  const accesses = []               // [node, isWrite]: every static field access
  const elements = new Set()        // receivers of element accesses
  const slots = []                  // [node, isWrite, value]: every element access at a constant index
  const indexed = new Set()         // receivers read or written at an index the loop computes
  const aliases = new Map()         // `const s = r.q` in the loop: s → r.q
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
      if (Array.isArray(d) && isField(d[2]) && isName(d[2][1])) aliases.set(name, d[2])
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
  return open ? null : { declared, written, stored, bare, accesses, elements, slots, indexed, aliases, computedRead }
}

/** The fields `loop` holds in locals, by receiver, and the receivers the copy must find present; null for none. */
const planLoop = (loop, view) => {
  const c = censusOf(loop, view)
  if (!c) return null
  const { declared, written, stored, bare, accesses, elements, slots, indexed, aliases, computedRead } = c
  const steady = (r) => isName(r) && !written.has(r) && !declared.has(r)
  // an alias stands for its record when nothing else writes it and it is used for fields alone
  for (const [s, e] of aliases) if (written.has(s) || bare.has(s) || !steady(e[1]) || stored.has(e[2]) || accessor(e[2])) aliases.delete(s)
  // the receiver an access reads through: a steady name, or a steady name's field no store names
  const receiverOf = (e) => {
    if (isName(e)) return aliases.has(e) ? chainOf(aliases.get(e)) : steady(e) ? { key: e, base: e } : null
    return chainOf(e)
  }
  const chainOf = (e) => isField(e) && steady(e[1]) && !stored.has(e[2]) && !accessor(e[2]) && isObject(view.kindOfExpr(e[1]))
    ? { key: e[1] + '.' + e[2], base: e[1], field: e[2], expr: e } : null
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
  // receivers naming one field may be one object, unless their records come from disjoint construction sites
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
    if (dropped.has(f.recv.base) || (byName.get(f.p).size > 1 && !apart(byName.get(f.p))) || accessor(f.p)) continue
    const kind = f.recv.expr ? view.kindOfExpr(f.recv.expr) : view.kindOfExpr(f.recv.key)
    if (!isObject(kind)) continue
    const shapes = f.recv.expr ? view.shapesOfExpr(f.recv.expr) : view.shapesOfExpr(f.recv.key)
    if (f.written && (computedRead || !(shapes?.every(sid => view.layoutSlot(sid, f.p)) ?? false))) continue
    held.push(f)
  }
  // An element at a constant index of an owned Float64Array (`s[0]`, `s[1]` of a
  // filter's state) the loop stores numbers into: no other receiver of the loop
  // shares its buffer (another element kind, or an array, is another object; a
  // view is none of these), and every index is within its length in the copy.
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
    return t2 === K.ARRAY || (t2 === K.TYPED && ctorName(view.typedPayloadCtorOfExpr(r2)) != null && ctorName(view.typedPayloadCtorOfExpr(r2)) !== 'Float64Array' && !(paramOf(k2) & VIEW_FLAGS))
  })
  const elems = []
  for (const [r, e] of slotsOf) {
    if (!steady(r) || bare.has(r) || indexed.has(r) || aliases.has(r) || !e.numbers || !ownF64(r) || !apartFrom(r)) continue
    if (accesses.some(([n, w]) => w && n[1] === r)) continue
    elems.push({ recv: r, max: e.max, written: e.written, indices: [...new Set(slots.filter(([n]) => n[1] === r).map(([n]) => slotIndex(n[2])))] })
  }
  if (!held.some(f => f.written) && !elems.some(e => e.written.size)) return null
  // every receiver of the loop, present in the copy: nothing in it throws
  const bases = new Set(), chains = new Map()
  for (const [n] of accesses) {
    const r = receiverOf(n[1])
    if (!r) {
      // a receiver the copy cannot name ahead: it must be present by its kind
      if (mayBeMissing(view.kindOfExpr(n[1]))) return null
      continue
    }
    if (r.expr) { chains.set(r.key, r); if (mayBeMissing(view.kindOfExpr(r.base))) bases.add(r.base) }
    else if (mayBeMissing(view.kindOfExpr(r.key))) bases.add(r.key)
  }
  for (const r of elements) if (mayBeMissing(view.kindOfExpr(r))) {
    if (!steady(r)) return null
    bases.add(r)
  }
  return { held, elems, bases: [...bases], chains: [...chains.values()], aliases, view }
}

/** `loop` with each held field access naming its local, each chain its record's local, and each name it declares a name of its own. */
const substitute = (loop, plan, locals, records) => {
  const own = new Set()
  collectBindings(loop, own)
  const rename = new Map([...own].map(n => [n, `${n}${T}f${freshId(ctx)}`]))
  const key = (e) => e[1] + '.' + e[2]
  const recordOf = (e) => isName(e) && plan.aliases.has(e) ? records.get(key(plan.aliases.get(e))) : isField(e) && isName(e[1]) ? records.get(key(e)) : null
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
    if ((n[0] === 'let' || n[0] === 'const')) return [n[0], ...n.slice(1).map(d => Array.isArray(d) && isName(d[1]) && plan.aliases.has(d[1]) && records.has(key(plan.aliases.get(d[1])))
      ? ['=', walk(d[1]), records.get(key(plan.aliases.get(d[1]))).local] : walk(d))]
    return n.map((c, i) => i === 0 ? c : walk(c))
  }
  return walk(loop)
}

/** Whether some innermost loop of the program stores a field or an element at a constant index: the pass has anything to look at. */
export const loopFieldCandidates = () => ctx.transform.optimize?.promoteLoopFields !== false && ctx.funcs.list.some(f => f.body && !f.raw &&
  some(f.body, n => LOOP_OPS.has(n[0]) && !some(n, m => m !== n && LOOP_OPS.has(m[0])) &&
    some(n, m => MUTATE_OPS.has(m[0]) && (isField(m[1]) || Array.isArray(m[1]) && m[1][0] === '[]' && slotIndex(m[1][2]) != null))))

export const promoteLoopFields = () => {
  if (ctx.transform.optimize?.promoteLoopFields === false) return false
  let changed = false
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw) continue
    const view = ctx.summary?.at(func.sig)
    if (!view) continue
    let rewrote = false
    statements(func.body, (st) => {
      if (!LOOP_OPS.has(st[0]) || some(st, n => n !== st && LOOP_OPS.has(n[0])) || nodeSize(st) > MAX_SIZE) return
      const plan = planLoop(st, view)
      if (!plan) return
      // a record the loop reads through a field: one local, loaded after its base is found present
      const records = new Map(plan.chains.map(r => [r.key, { ...r, local: `${r.base}${T}${r.field}${freshId(ctx)}` }]))
      const recv = (r) => r.expr ? records.get(r.key).local : r.key
      const locals = new Map(plan.held.map(f => [f.recv.key + '|' + f.p, `${recv(f.recv)}${T}${f.p}${freshId(ctx)}`]))
      for (const e of plan.elems) for (const k of e.indices) locals.set(e.recv + '[' + k, `${e.recv}${T}${k}${freshId(ctx)}`)
      const decls = [...plan.held.map(f => ['=', locals.get(f.recv.key + '|' + f.p), ['.', recv(f.recv), f.p]]),
        ...plan.elems.flatMap(e => e.indices.map(k => ['=', locals.get(e.recv + '[' + k), ['[]', e.recv, [null, k]]]))]
      const back = [...plan.held.filter(f => f.written).map(f => ['=', ['.', recv(f.recv), f.p], locals.get(f.recv.key + '|' + f.p)]),
        ...plan.elems.flatMap(e => [...e.written].map(k => ['=', ['[]', e.recv, [null, k]], locals.get(e.recv + '[' + k)]))]
      const copy = ['{}', [';', ['let', ...decls], substitute(st, plan, locals, records), ...back]]
      rewrote = true
      const tests = [...plan.bases.map(r => ['!=', r, [null, null]]),
        ...plan.elems.map(e => ['>', ['.', e.recv, 'length'], [null, e.max]]),
        ...[...records.values()].map(r => ['!=', ['=', r.local, r.expr], [null, null]])]
      const head = records.size ? [['let', ...[...records.values()].map(r => r.local)]] : []
      if (!tests.length) return head.length ? ['{}', [';', ...head, copy]] : copy
      return ['{}', [';', ...head, ['if', tests.reduce((a, b) => ['&&', a, b]), copy, ['{}', [';', st]]]]]
    })
    if (rewrote) { invalidateProgramFactsCache(func.body); invalidateBodies([func.body]); changed = true }
  }
  return changed
}
