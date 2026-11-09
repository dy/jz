/**
 * What memory a load or a store reaches, as the emitter knew it where it made the
 * access, and whether two accesses may reach the same bytes.
 *
 * The emitter marks the instruction node (`node.mem`) where the program summary
 * names what the access touches:
 *   - `e<cell>`: an element of an array of the summary's allocation cell `cell`
 *     (the class of the constructions a value may come from: src/summary). Arrays of
 *     two cells are two allocations, so their elements never overlap: an array of
 *     Numbers and an array of the objects that hold it, two arrays of Numbers made at
 *     two literals.
 *   - `f<slot>:<sid,…>`: field `slot` of an object of one of the layouts `sid,…`. An
 *     object keeps one layout and its fields keep their slots for its life, so two
 *     fields share bytes only at one slot of one object: the same slot, and a layout
 *     both may have.
 * An array's elements and an object's fields are never one allocation. Every other
 * access stays unmarked and may touch anything: a header, a typed array's buffer
 * (its views may share it), a dictionary's table, a struct-inlined array's cells,
 * the runtime's own memory. A pass that rebuilds a marked node drops its mark,
 * which is the unmarked answer.
 *
 * The optimizer's memory passes ask `mayAlias` before a store forgets what a load
 * read or a store left (optimize/forward-store.js, optimize/reuse-loads.js).
 *
 * @module ir/mem-alias
 */
import { ctx } from '../ctx.js'

const isArr = Array.isArray

/** Mark `node`, an element load or store, with the cell of the array `arr` reads; returns `node`. */
export const markElem = (node, arr) => {
  if (!isArr(node) || arr == null) return node
  let cell = null
  try { cell = ctx.summary?.at?.(ctx.func.current)?.arrayCellOf(arr) } catch { cell = null }
  if (cell != null) node.mem = 'e' + cell
  return node
}

/** Whether a layout's fields may live outside a heap object of its own: in an array's
 *  struct-inlined cells (the Array<S> carrier), in a union's packed cells. */
const inlined = (sid) => !!ctx.schema.inlineArray?.has(sid) ||
  [...(ctx.schema.inlineUnion?.values?.() ?? [])].some(u => u?.sids?.includes(sid))

/** Mark `node`, a load or store of field `slot` of the object `obj` holds, with the
 *  layouts the summary gives it; returns `node`. A receiver of no named layout, or of
 *  one a struct-inlined array may hold in its cells, stays unmarked. */
export const markField = (node, obj, slot) => {
  if (!isArr(node) || obj == null || !(slot >= 0)) return node
  let sids = null
  try { sids = ctx.summary?.at?.(ctx.func.current)?.shapesOfExpr(obj) } catch { sids = null }
  if (!sids?.length || sids.some(s => s == null || inlined(s))) return node
  node.mem = 'f' + slot + ':' + [...sids].sort((a, b) => a - b).join(',')
  return node
}

const layoutsOf = (m) => m.slice(m.indexOf(':') + 1).split(',')

/** Whether accesses marked `a` and `b` (a node's `mem`, or undefined) may reach the same bytes. */
export const mayAlias = (a, b) => {
  if (a == null || b == null) return true
  if (a[0] !== b[0]) return false
  if (a[0] === 'e') return a === b
  if (a.slice(0, a.indexOf(':')) !== b.slice(0, b.indexOf(':'))) return false
  const lb = new Set(layoutsOf(b))
  return layoutsOf(a).some(s => lb.has(s))
}

