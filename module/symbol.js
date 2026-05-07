/**
 * Symbol module — interned atoms via NaN-boxing.
 *
 * Type=0 (ATOM): aux=atomId, offset=0.
 *
 * Reserved atom IDs (0-15):
 *   0     = reserved
 *   1     = null      (NULL_NAN sentinel)
 *   2     = undefined (UNDEF_NAN sentinel)
 *   3-15  = reserved
 *
 * User symbols start at ID 16.
 * Symbol('name')     → unique atom per call site (compile-time)
 * Symbol.for('name') → interned by name (same name = same ID across call sites)
 *
 * Symbols are compared by identity (ptr equality), not by name.
 *
 * @module symbol
 */

import { typed, asF64, mkPtrIR } from '../src/ir.js'
import { emit } from '../src/emit.js'
import { err, inc, PTR } from '../src/ctx.js'

const RESERVED = 16  // first user atom ID

export default (ctx) => {
  inc('__mkptr')

  // Intern table: name → atomId (shared across compilation)
  if (!ctx.runtime.atom) {
    ctx.runtime.atom = { table: new Map(), next: RESERVED }
  }

  /** Allocate a new unique atom ID. */
  const nextAtom = () => ctx.runtime.atom.next++

  /** Get or create interned atom ID for name. */
  const internAtom = (name) => {
    if (ctx.runtime.atom.table.has(name)) return ctx.runtime.atom.table.get(name)
    const id = nextAtom()
    ctx.runtime.atom.table.set(name, id)
    return id
  }

  // Symbol('name') → unique atom (each call site gets a different ID)
  ctx.core.emit['Symbol'] = (nameExpr) => mkPtrIR(PTR.ATOM, nextAtom(), 0)

  // Symbol.for('name') → interned atom (same name = same ID)
  ctx.core.emit['Symbol.for'] = (nameExpr) => {
    // Name must be a string literal at compile time
    if (!Array.isArray(nameExpr) || nameExpr[0] !== 'str')
      err('Symbol.for requires a string literal')
    return mkPtrIR(PTR.ATOM, internAtom(nameExpr[1]), 0)
  }
}
