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
 * A Symbol has no storage. Its description is a constant of the program: a
 * runtime identity carries the slot of the literal it was made with in its low
 * bits (layout.js symbolCountMax), an interned one is its registry key, and
 * `__sym_described` reads either from a table of the program's static strings.
 * Slot 1 holds no description of the program's: none, one `jz:symbol` keeps
 * for a description computed at run time (jzify routes `Symbol(x)` there), or
 * one of a Symbol the host made, which the host answers (`__ext_sym_desc`).
 *
 * @module symbol
 */

import print from 'watr/print'
import { mkPtrIR, typed, asF64, asI64, temp, throwErrorIR, undefExpr, UNDEF_NAN } from '../src/ir.js'
import { ctx as compileCtx, err, inc, PTR, declGlobal } from '../src/ctx.js'
import { emit, storedValue, withIgnoredArgs, wat, deps } from '../src/bridge.js'
import { primitiveKind } from '../src/evaluation-effects.js'
import { unboundedPresent } from '../src/summary/contract.js'
import { copyReceiverFacts } from '../src/compile/emit/shared.js'
import { hostValueIngress } from '../src/compile/func-exports.js'
import { dataLen } from '../src/static-data.js'
import { atomNanHex, SYMBOL_MIN, symbolCountMax, symbolSlotBits } from '../layout.js'

// fix/wrong-values-3: exported — module/json.js's __json_omit needs this
// exact threshold to tell a genuine user Symbol apart from a canonical
// arithmetic NaN (aux=0, explicitly "reserved" above, never a real atom).
export const RESERVED = SYMBOL_MIN  // first user atom ID

/** The description a literal argument of `Symbol` fixes (undefined for none),
 *  or null where the argument is no literal. */
const literalDescription = (n) => {
  if (n === undefined || n === 'undefined') return undefined
  if (Array.isArray(n) && n[0] === 'str' && typeof n[1] === 'string') return n[1]
  if (Array.isArray(n) && n[0] == null && n.length === 2) return n[1] === undefined ? undefined : String(n[1])
  return typeof n === 'number' ? String(n) : null
}

/** `String(x)`, `x.toString()`, `x.description` and a WASI print of a value
 *  that may be a Symbol (the summary cannot bound it) in a program that makes
 *  Symbols (`ctx.features.symbols`): the stdlib reader `read` of the temp holding it where it is one
 *  (`__sym_string`, its descriptive string, or `__sym_described`), what
 *  `other(t)` emits for the temp otherwise. Null where the value is no Symbol. */
export const symbolFork = (value, other, read = '__sym_string') => {
  const ctx = compileCtx
  if (!ctx.features.symbols) return null
  const view = ctx.summary?.at(ctx.func.current), k = view?.kindOfExpr(value)
  if (k != null && !unboundedPresent(k)) return null
  const t = temp('sym')
  inc('__is_symbol', read)
  const held = asF64(emit(value))
  copyReceiverFacts(value, t)
  view?.alias(t, value)
  try {
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, held],
      ['if', ['result', 'f64'], ['call', '$__is_symbol', ['i64.reinterpret_f64', ['local.get', `$${t}`]]],
        ['then', ['f64.reinterpret_i64', ['call', `$${read}`, ['i64.reinterpret_f64', ['local.get', `$${t}`]]]]],
        ['else', asF64(other(t))]]], 'f64')
  } finally { view?.unalias(t) }
}

export default (ctx) => {
  inc('__mkptr')

  // Intern table: name → atomId (shared across compilation); description
  // slots: literal → its slot (2 up, slot 1 is none of the program's)
  if (!ctx.runtime.atom) {
    ctx.runtime.atom = { table: new Map(), next: RESERVED, slots: new Map() }
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

  /** The slot of description `text` (none: 1): one per literal. */
  const slotOf = (text) => {
    const slots = ctx.runtime.atom.slots
    if (text == null) return 1
    if (!slots.has(text)) slots.set(text, slots.size + 2)
    return slots.get(text)
  }

  ctx.core.emit['Symbol'] = (nameExpr, ...ignored) => {
    // the count of runtime identities made, shared with the host's (interop.js)
    declGlobal('__symbol_id', 'i64', '0', { export: '__symbol_id' })
    const primitive = nameExpr === undefined || primitiveKind(ctx.summary?.at(ctx.func.current), nameExpr)
    // (a description no literal fixes is `jz:symbol`'s to keep, jzify)
    const slot = slotOf(literalDescription(nameExpr))
    inc('__sym_make')
    return withIgnoredArgs(nameExpr ?? undefExpr(), ignored, value => {
      const description = []
      if (nameExpr !== undefined) {
        if (primitive) description.push(['drop', emit(value)])
        else {
          inc('__to_key', '__is_symbol')
          description.push(['if', ['call', '$__is_symbol', ['call', '$__to_key', asI64(storedValue(value))]],
            ['then', ['drop', throwErrorIR('TypeError', 'Cannot convert a Symbol value to a string')]]])
        }
      }
      return typed(['block', ['result', 'f64'], ...description, ['call', '$__sym_make', ['i64.const', slot]]], 'f64')
    })
  }

  // A fresh identity of description slot `$slot`. Realized at link, when the
  // program's slots are all known: their count fixes the layout.
  const exhausted = () => {
    ctx.runtime.throws = true
    return ctx.core.throwHelper('RangeError', 'Symbol identity space exhausted')
  }
  deps({ __sym_make: () => [exhausted()], __sym_string: ['__sym_described', '__str_concat'],
    __sym_described: () => hostValueIngress() ? ['__ext_sym_desc'] : [] })
  wat('__sym_make', () => {
    const k = symbolSlotBits(ctx.runtime.atom.slots.size)
    return `(func $__sym_make (param $slot i64) (result f64)
    (local $n i64)
    (local.set $n (i64.add (global.get $__symbol_id) (i64.const 1)))
    (if (i64.gt_u (local.get $n) (i64.const ${symbolCountMax(k)})) (then (call $${exhausted()}) (unreachable)))
    (global.set $__symbol_id (local.get $n))
    (f64.reinterpret_i64 (i64.add (i64.const ${atomNanHex(SYMBOL_MIN)})
      (i64.add (i64.shl (local.get $n) (i64.const ${k})) (local.get $slot)))))`
  })

  // A Symbol's description, undefined for none: an interned one's registry
  // key, a slot's literal, or (slot 1) the one `jz:symbol` keeps, else the
  // host's for a Symbol it made. Its strings are static data a dead reader
  // reclaims.
  const staticStr = (text) => `(return (i64.reinterpret_f64 ${print(ctx.core.emit['str'](text))}))`
  wat('__sym_described', () => {
    ctx.module.include('string')
    const atom = ctx.runtime.atom, start = dataLen()
    const kept = ctx.module.resolvedModules?.get('jz:symbol')?.exports.get('__sym_desc')
    const host = hostValueIngress()
    let interned = '', slotted = ''
    for (const [name, id] of atom.table) interned += `\n        (if (i32.eq (local.get $aux) (i32.const ${id})) (then ${staticStr(name)}))`
    for (const [text, slot] of atom.slots) slotted += `\n    (if (i64.eq (local.get $slot) (i64.const ${slot})) (then ${staticStr(text)}))`
    if (dataLen() > start) ctx.runtime.reclaimSpans.push({ fn: '$__sym_described', start, end: dataLen() })
    const k = symbolSlotBits(atom.slots.size)
    return `(func $__sym_described (param $s i64) (result i64)
    (local $aux i32) (local $slot i64) (local $d i64)
    ${interned && `(if (i32.eqz (i32.wrap_i64 (local.get $s)))
      (then
        (local.set $aux (i32.and (i32.wrap_i64 (i64.shr_u (local.get $s) (i64.const 32))) (i32.const 0x7fff)))${interned}
        (return (i64.const ${UNDEF_NAN}))))`}
    (local.set $slot (i64.and (local.get $s) (i64.const ${(1 << k) - 1})))${slotted}
    (local.set $d (i64.const ${UNDEF_NAN}))
    ${kept ? `(local.set $d (i64.reinterpret_f64 (call $${kept} (f64.convert_i64_u (i64.and (local.get $s) (i64.const 0x00007FFFFFFFFFFF))))))` : ''}
    ${host ? `(if (result i64) (i64.eq (local.get $d) (i64.const ${UNDEF_NAN})) (then (call $__ext_sym_desc (local.get $s))) (else (local.get $d)))` : '(local.get $d)'})`
  })
  ctx.core.stdlib['__ext_sym_desc'] = '(import "env" "__ext_sym_desc" (func $__ext_sym_desc (param i64) (result i64)))'

  // A Symbol's descriptive string, `Symbol(description)` (ECMA-262 20.4.3.3.1),
  // what String() and toString() give where ToString throws
  wat('__sym_string', () => {
    ctx.module.include('string')
    const start = dataLen()
    const str = (text) => `(i64.reinterpret_f64 ${print(ctx.core.emit['str'](text))})`
    const none = str('Symbol()'), open = str('Symbol('), close = str(')')
    if (dataLen() > start) ctx.runtime.reclaimSpans.push({ fn: '$__sym_string', start, end: dataLen() })
    return `(func $__sym_string (param $s i64) (result i64)
    (local $d i64)
    (local.set $d (call $__sym_described (local.get $s)))
    (if (result i64) (i64.eq (local.get $d) (i64.const ${UNDEF_NAN}))
      (then ${none})
      (else (i64.reinterpret_f64 (call $__str_concat
        (i64.reinterpret_f64 (call $__str_concat ${open} (local.get $d))) ${close})))))`
  })

  // The number a Symbol's identity reads as (its aux and offset, under 2^47 so
  // exact in an f64): the key of a description `jz:symbol` keeps, the same on the host.
  ctx.core.emit['__sym_key'] = (symbol) => typed(['f64.convert_i64_u',
    ['i64.and', asI64(emit(symbol)), ['i64.const', '0x00007FFFFFFFFFFF']]], 'f64')

  // Symbol.for('name') → interned atom (same name = same ID)
  ctx.core.emit['Symbol.for'] = (nameExpr, ...ignored) => {
    // Name must be a string literal at compile time
    if (!Array.isArray(nameExpr) || nameExpr[0] !== 'str')
      err('Symbol.for requires a string literal')
    return withIgnoredArgs(nameExpr, ignored, () => mkPtrIR(PTR.ATOM, internAtom(nameExpr[1]), 0))
  }
}
