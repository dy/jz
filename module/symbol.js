/**
 * Symbol module — interned atoms via NaN-boxing.
 *
 * Type=0 (ATOM): aux=atomId, offset=0.
 *
 * Reserved atom IDs (0-15):
 *   0 = reserved
 *   1 = null/undefined (type=0, aux=1, offset=0 — the nullish NaN sentinel)
 *   2-15 = reserved
 *
 * User symbols start at ID 16.
 * Symbol('name')     → unique atom per call site (compile-time)
 * Symbol.for('name') → interned by name (same name = same ID across call sites)
 *
 * Symbols are compared by identity (ptr equality), not by name.
 *
 * @module symbol
 */

import { emit, typed, asF64 } from '../src/compile.js'
import { ctx, err, PTR } from '../src/ctx.js'

const RESERVED = 16  // first user atom ID

export default () => {
  // Intern table: name → atomId (shared across compilation)
  if (!ctx.atom) {
    ctx.atom = { table: new Map(), next: RESERVED }
  }

  /** Allocate a new unique atom ID. */
  const nextAtom = () => ctx.atom.next++

  /** Get or create interned atom ID for name. */
  const internAtom = (name) => {
    if (ctx.atom.table.has(name)) return ctx.atom.table.get(name)
    const id = nextAtom()
    ctx.atom.table.set(name, id)
    return id
  }

  // Symbol('name') → unique atom (each call site gets a different ID)
  ctx.emit['Symbol'] = (nameExpr) => {
    const id = nextAtom()
    return typed(['call', '$__mkptr', ['i32.const', PTR.ATOM], ['i32.const', id], ['i32.const', 0]], 'f64')
  }

  // Symbol.for('name') → interned atom (same name = same ID)
  ctx.emit['Symbol.for'] = (nameExpr) => {
    // Name must be a string literal at compile time
    if (!Array.isArray(nameExpr) || nameExpr[0] !== 'str')
      err('Symbol.for requires a string literal')
    const name = nameExpr[1]
    const id = internAtom(name)
    return typed(['call', '$__mkptr', ['i32.const', PTR.ATOM], ['i32.const', id], ['i32.const', 0]], 'f64')
  }
}
