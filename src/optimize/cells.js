/**
 * A cell no closure took is its value, held in a local.
 *
 * A local a closure writes lives in a cell: 8 bytes from `$__alloc`, their
 * address in an i32 local, every read a load and every write a store through
 * it (ir/vars.js readVar, writeVar). Where the function made no closure of the
 * arrow after all, because its walk ran it in place (compile/in-place.js), the
 * address goes nowhere: it only addresses those loads and stores. Such a local
 * holds the value itself, a register the passes after this one read as any
 * other (a sum a callback adds to is a reduction's accumulator).
 *
 * A local qualifies where every write of it is
 * `(local.set c (call $__alloc (i32.const 8)))` and every read of it is the
 * address of a plain `f64.load` / `f64.store`, or of a plain `i32.load` /
 * `i32.store`, one type throughout. An address stored into a closure's
 * environment, compared, or passed to a call keeps the cell. A fresh cell's
 * bytes are unspecified and the emitter stores before it reads, so the
 * allocation itself becomes nothing.
 *
 * @module optimize/cells
 */
import { findBodyStart } from '../ir.js'
import { T } from '../ast.js'

const CELL = '$' + T + 'cell_', HELD = '$' + T + 'held_'
const LOADS = { 'f64.load': 'f64', 'i32.load': 'i32' }, STORES = { 'f64.store': 'f64', 'i32.store': 'i32' }
const isAlloc = (v) => Array.isArray(v) && v[0] === 'call' && v[1] === '$__alloc' && v.length === 3 &&
  Array.isArray(v[2]) && v[2][0] === 'i32.const' && Number(v[2][1]) === 8
const getOf = (n, cells) => Array.isArray(n) && n[0] === 'local.get' && cells.has(n[1]) ? n[1] : null

/** Hold in a local each cell of `fn` whose address only addresses its own loads and stores. */
export function promoteCells(fn) {
  // name → { type, allocs, reads, writes }: the i32 locals that may be cells
  const cells = new Map(), decls = new Map()
  const start = findBodyStart(fn)
  for (let i = 2; i < start; i++) {
    const d = fn[i]
    if (Array.isArray(d) && d[0] === 'local' && typeof d[1] === 'string' && d[2] === 'i32') { cells.set(d[1], { type: null, allocs: [], reads: [], writes: [] }); decls.set(d[1], d) }
  }
  if (!cells.size) return
  const use = (name, type, list, node) => {
    const c = cells.get(name)
    if (c.type && c.type !== type) return cells.delete(name)
    c.type = type
    c[list].push(node)
  }
  // (optimizer nodes may be shared: each is read once, by every parent's own view of its children)
  const seen = new Set(), stack = []
  for (let i = start; i < fn.length; i++) stack.push(fn[i])
  while (stack.length && cells.size) {
    const n = stack.pop()
    if (!Array.isArray(n) || seen.has(n)) continue
    seen.add(n)
    const op = n[0]
    let from = 1
    if ((op === 'local.set' || op === 'local.tee') && cells.has(n[1])) {
      if (op === 'local.set' && n.length === 3 && isAlloc(n[2])) { cells.get(n[1]).allocs.push(n); continue }
      cells.delete(n[1])
    } else if (LOADS[op] && n.length === 2 && getOf(n[1], cells)) { use(n[1][1], LOADS[op], 'reads', n); continue }
    else if (STORES[op] && n.length === 3 && getOf(n[1], cells)) { use(n[1][1], STORES[op], 'writes', n); from = 2 }
    for (let i = from; i < n.length; i++) {
      const name = getOf(n[i], cells)
      if (name) cells.delete(name)   // the address as a value: it escapes
      else stack.push(n[i])
    }
  }
  for (const [name, c] of cells) {
    if (!c.allocs.length || !c.type) continue
    const held = name.startsWith(CELL) ? HELD + name.slice(CELL.length) : name
    for (const n of c.allocs) { n.length = 1; n[0] = 'nop' }
    for (const n of c.reads) { n[0] = 'local.get'; n[1] = held }
    for (const n of c.writes) { n[0] = 'local.set'; n[1] = held }
    const d = decls.get(name)
    d[1] = held; d[2] = c.type
  }
}
