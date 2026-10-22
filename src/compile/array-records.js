/**
 * Record layouts for the named properties of arrays.
 *
 * An array whose named properties the program names statically (`node.loc =
 * at` on every parsed node, `ctx.local = []` on a compiler's context) keeps
 * them in a record: a block of slots its header's property word points to
 * (PTR.RECORD, aux the layout), one slot per name of its layout. A store or a
 * read of a known name at a site whose receiver the summary places is a slot
 * access behind one compare of the word (module/collection/record.js); every
 * other access takes the dynamic path, which reads records as it reads a
 * dictionary, and a store of a name outside the layout turns the record into
 * one.
 *
 * Layouts come from the summary, fixed before emission: one per array cell
 * that holds a named property, its names those the program stores on it by a
 * literal key, and one for arrays of unknown cell (a receiver of several kinds
 * narrowed by a test), its names those stored on them. A name a computed key
 * makes is the dynamic path's: an array that takes one after its first literal
 * name turns its record into a dictionary, once. Names that would make a
 * record larger than the smallest dictionary keep dictionaries, so a record
 * never costs an array more memory than the dictionary it replaces. A site's
 * receiver names its layout by its cell; a layout is a runtime check, never a
 * proof, so a receiver the summary misplaces only misses the slot path.
 *
 * @module compile/array-records
 */
import { ctx } from '../ctx.js'

// A record is 16 bytes of header, a slot per name and, for several names,
// their order list in a word per eight: four names keep it below the 64 bytes
// of the smallest dictionary (two entries behind its header), the bound past
// which it could cost an array that carries one name more than a dictionary.
const MAX_NAMES = 4

// A name a slot holds: not an element's, not `length` (a resize), not one a
// number spells (the dynamic path classifies those before any table).
const usable = (name) => typeof name === 'string' && name.length > 0 && name !== 'length' && name !== '__proto__' &&
  !(name.charCodeAt(0) >= 48 && name.charCodeAt(0) <= 57) && name.charCodeAt(0) !== 45

/** Fix the program's record layouts from the summary (compile/index.js, after its last solve). */
export function planArrayRecords() {
  const R = ctx.runtime.records = { list: [], byCell: new Map() }
  const s = ctx.summary
  // the size tier keeps the dictionaries: records add their helpers and arms to the binary
  if (!s?.arrayRecordCells || ctx.memory.shared || ctx.transform.optimize?.leanRuntime) return R
  const keyOf = new Map()
  const add = (c, names) => {
    names = names.filter(usable)
    if (!names.length || names.length > MAX_NAMES) return
    const key = names.join('\0')
    let rid = keyOf.get(key)
    if (rid === undefined) { rid = R.list.push(names) - 1; keyOf.set(key, rid) }
    R.byCell.set(c, rid)
  }
  for (const c of s.arrayRecordCells()) add(c, s.arrayRecordNames(c))
  add(-1, s.arrayRecordNames(-1))
  return R
}

/** Whether the program lays out any record: the dynamic paths read records only then. */
export const recordsOn = () => (ctx.runtime.records?.list.length ?? 0) > 0

/** The record slot `obj.prop` names: `{ rid, slot, n }`, or null where the
 *  receiver may be no array, or no layout it may have holds the name. An array
 *  of unknown cell stores into the layout of such arrays, or else into the one
 *  layout that holds the name (the solver may have met the store through a
 *  cell its final join lost); it reads the one layout that holds the name, or
 *  dynamically where several do, its record being any of them. */
export function arrayRecordSlot(obj, prop, read = false) {
  const R = ctx.runtime.records
  if (!R?.list.length || !usable(prop)) return null
  const c = ctx.summary?.at(ctx.func.current)?.arrayRecordOf?.(obj)
  if (c == null) return null
  let rid = R.byCell.get(c)
  if (c < 0 && (read || !(rid !== undefined && R.list[rid].includes(prop)))) {
    rid = undefined
    for (let i = 0; i < R.list.length; i++) if (R.list[i].includes(prop)) { if (rid !== undefined) return null; rid = i }
  }
  if (rid === undefined) return null
  const names = R.list[rid], slot = names.indexOf(prop)
  return slot < 0 ? null : { rid, slot, n: names.length }
}
