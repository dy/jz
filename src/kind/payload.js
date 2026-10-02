/** NaN payloads: which values can carry one.
 *
 * A Number entering a generic slot is normalized (ir/sentinels.js
 * canonicalNumberIR), so no NaN's payload reads as a box. Only raw ingress
 * makes such a payload: a typed array's element, a parameter, a call's
 * result, an exact Number slot. A constant and an integer carry none;
 * arithmetic on operands that carry none makes none (Wasm answers the
 * canonical NaN when every NaN input is canonical); a plain array's element
 * carries none, normalized where it was stored. A value that is no Number
 * (a box) has none to speak of.
 *
 * @module kind/payload
 */

import { ctx } from '../ctx.js'
import { MUTATE_OPS } from '../ast.js'
import { VAL } from '../reps.js'
import { K, UNKNOWN, core, paramOf, tagOf } from '../summary/kind.js'
import { TYPED_ELEM_CODE, TYPED_ELEM_BIGINT_FLAG, TYPED_ELEM_F16_FLAG } from '../../layout.js'
import { valTypeOf } from './val-type-of.js'

const ARITH = new Set(['+', '-', '*', '/', 'u-', 'u+', '&&', '||', '??', ','])
// An integer, a Boolean, a string: no NaN at all.
const WORD = new Set(['&', '|', '^', '<<', '>>', '>>>', '~', '<', '<=', '>', '>=', '==', '!=', '===', '!==', '!', 'typeof', 'in', 'instanceof', 'str', 'bool', 'nan'])
// The functions of Math one Wasm operator computes.
const MATH = new Set(['math.sqrt', 'math.abs', 'math.floor', 'math.ceil', 'math.trunc', 'math.min', 'math.max'])

const free = (n, names) => {
  if (typeof n === 'string') return names.has(n)
  if (!Array.isArray(n)) return typeof n === 'number'
  const op = n[0]
  if (op == null || WORD.has(op)) return true
  if (ARITH.has(op)) { for (let i = 1; i < n.length; i++) if (!free(n[i], names)) return false; return true }
  if (op === '?:') return free(n[2], names) && free(n[3], names)
  if (op === 'postfix') return free(n[1], names)
  if (op === '++' || op === '--') return typeof n[1] === 'string' && names.has(n[1])
  if (op === '=') return typeof n[1] === 'string' && free(n[2], names)
  if (op === '.') return n[2] === 'length'
  if (op === '[]') {
    if (n.length !== 3) return false
    const k = core(ctx.summary?.at(ctx.func.current).kindOfExpr(n[1]) ?? K.NONE), aux = paramOf(k)
    // an integer typed array's element is an integer
    if (tagOf(k) === K.TYPED) return aux !== UNKNOWN && (aux & 7) <= TYPED_ELEM_CODE.Uint32Array && !(aux & (TYPED_ELEM_BIGINT_FLAG | TYPED_ELEM_F16_FLAG))
    // a plain array to the summary and to the emitter: storage promoted to typed keeps raw bits
    return tagOf(k) === K.ARRAY && valTypeOf(n[1]) === VAL.ARRAY
  }
  if (op === '()') return MATH.has(n[1]) && (n[2]?.[0] === ',' ? n[2].slice(1) : n.slice(2)).every(a => free(a, names))
  return false
}

const bodies = new WeakMap()   // function body → its locals every write of which carries no payload
const namesOf = (body) => {
  let names = bodies.get(body)
  if (names) return names
  bodies.set(body, names = new Set())
  const writes = []            // name, value pairs: a null value is a write of unknown bits
  const unknown = (n) => { if (typeof n === 'string') writes.push(n, null); else if (Array.isArray(n)) for (let i = 1; i < n.length; i++) unknown(n[i]) }
  const scan = (n, inner) => {
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op === '=>') inner = true
    else if ((op === 'let' || op === 'const') && !inner) {
      for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (typeof d === 'string') names.add(d)
        else if (d?.[0] === '=' && typeof d[1] === 'string') { names.add(d[1]); writes.push(d[1], d[2]) }
      }
    } else if (MUTATE_OPS.has(op)) {
      const t = n[1]
      // a closure's write runs whenever; a pattern takes what its source holds
      if (typeof t === 'string') writes.push(t, inner ? null : op === '=' ? n[2] : op === '++' || op === '--' ? t : [op.slice(0, -1), t, n[2]])
      else if (Array.isArray(t) && t[0] !== '.' && t[0] !== '?.' && t[0] !== '[]') unknown(t)
    }
    for (let i = 1; i < n.length; i++) scan(n[i], inner)
  }
  scan(body, false)
  for (let changed = true; changed;) {
    changed = false
    for (let i = 0; i < writes.length; i += 2)
      if (names.has(writes[i]) && !(writes[i + 1] !== null && free(writes[i + 1], names))) { names.delete(writes[i]); changed = true }
  }
  return names
}

const NONE = new Set()
/** Whether `node`, where it is a Number, is one with no NaN payload. */
export const payloadFree = (node) => node != null && free(node, Array.isArray(ctx.func.body) ? namesOf(ctx.func.body) : NONE)
