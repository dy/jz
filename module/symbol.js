/**
 * Symbol module — interned atoms via NaN-boxing.
 *
 * Type=0 (ATOM): aux>=16. Interned atoms have offset=0; runtime identities
 * use the remaining payloads, excluding the private absent-slot marker.
 *
 * Reserved atom IDs (0-15):
 *   0     = reserved
 *   1     = null      (NULL_NAN sentinel)
 *   2     = undefined (UNDEF_NAN sentinel)
 *   3-15  = reserved
 *
 * User symbols start at ID 16.
 * Symbol('name')     → a fresh identity on every invocation
 * Symbol.for('name') → interned by name (same name = same ID across call sites)
 *
 * Symbols are compared by identity (ptr equality), not by name.
 *
 * @module symbol
 */

import { mkPtrIR, typed, tempI64, throwErrorIR } from '../src/ir.js'
import { err, inc, PTR, declGlobal } from '../src/ctx.js'
import { atomNanHex, TOMB_NAN, SYMBOL_MIN } from '../layout.js'

// fix/wrong-values-3: exported — module/json.js's __json_omit needs this
// exact threshold to tell a genuine user Symbol apart from a canonical
// arithmetic NaN (aux=0, explicitly "reserved" above, never a real atom).
export const RESERVED = SYMBOL_MIN  // first user atom ID

export default (ctx) => {
  inc('__mkptr')

  // Intern table: name → atomId (shared across compilation)
  if (!ctx.runtime.atom) {
    ctx.runtime.atom = { table: new Map(), next: RESERVED }
  }

  /** Allocate an interned atom's auxiliary id; the low word stays zero. */
  const nextAtom = () => {
    if (ctx.runtime.atom.next > 0x7fff) err('Too many interned symbols')
    return ctx.runtime.atom.next++
  }

  /** Get or create interned atom ID for name. */
  const internAtom = (name) => {
    if (ctx.runtime.atom.table.has(name)) return ctx.runtime.atom.table.get(name)
    const id = nextAtom()
    ctx.runtime.atom.table.set(name, id)
    return id
  }

  declGlobal('__symbol_id', 'i64', atomNanHex(RESERVED))
  ctx.core.emit['Symbol'] = (nameExpr) => {
    const id = tempI64('symbol')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${id}`, ['i64.add', ['global.get', '$__symbol_id'], ['i64.const', 1]]],
      // A carry must skip the zero-offset domain owned by Symbol.for.
      ['if', ['i32.eqz', ['i32.wrap_i64', ['local.get', `$${id}`]]],
        ['then', ['local.set', `$${id}`, ['i64.add', ['local.get', `$${id}`], ['i64.const', 1]]]]],
      ['if', ['i64.ge_u', ['local.get', `$${id}`], ['i64.const', TOMB_NAN]],
        ['then', ['drop', throwErrorIR('RangeError', 'Symbol identity space exhausted')]]],
      ['global.set', '$__symbol_id', ['local.get', `$${id}`]],
      ['f64.reinterpret_i64', ['local.get', `$${id}`]]], 'f64')
  }

  // Symbol.for('name') → interned atom (same name = same ID)
  ctx.core.emit['Symbol.for'] = (nameExpr) => {
    // Name must be a string literal at compile time
    if (!Array.isArray(nameExpr) || nameExpr[0] !== 'str')
      err('Symbol.for requires a string literal')
    return mkPtrIR(PTR.ATOM, internAtom(nameExpr[1]), 0)
  }
}
