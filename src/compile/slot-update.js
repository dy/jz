// Fuse a primitive read/modify/write into one collection probe. The receiver
// and key must be stable, and evaluating the value must neither observe the
// insertion nor invalidate the slot. Map methods additionally need identity proof.
import { ctx, inc, OPTF, PTR, LAYOUT } from '../ctx.js'
import { valTypeOf } from '../kind.js'
import { VAL, repOf } from '../reps.js'
import { K, tagOf } from '../summary/kind.js'
import { dictCapacity } from '../static.js'
import { typed, asF64, asI32, temp, tempI32, isLiteralStr, isNumericIR } from '../ir.js'
import { emit, storedValue } from '../bridge.js'

const same = (a, b) => a === b ||
  (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i])))
// A slot upsert inserts before evaluating the RHS. Only primitive value ops
// commute with that insertion: a throw would leave an extra key, and implicit
// ToPrimitive can call user code that grows the table under the held address.
const primitive = n => {
  const k = ctx.summary?.at(ctx.func.current).kindOfExpr(n)
  const t = k == null ? K.ANY : tagOf(k)
  return t === K.NUMBER || t === K.BOOL || t === K.STRING || t === K.NULLISH || t === K.ABSENT
}
const ops = new Set(['+', '-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>', '~', '!',
  '&&', '||', '??', '?', '?:', ',', '==', '===', '!=', '!==', '<', '<=', '>', '>=', 'u-', 'u+', 'void', 'typeof'])
// Count matching reads in the same walk that proves evaluation safe; -1 rejects.
const countReads = (n, readNode) => {
  if (!Array.isArray(n)) return typeof n !== 'string' || primitive(n) ? 0 : -1
  if (same(n, readNode)) return primitive(n) ? 1 : -1
  const op = n[0]
  if (op == null) return typeof n[1] === 'bigint' ? -1 : 0
  if (op === 'str') return 0
  if (!ops.has(op)) return -1
  let reads = 0
  for (let i = 1; i < n.length; i++) {
    const child = countReads(n[i], readNode)
    if (child < 0) return -1
    reads += child
  }
  return reads
}
export function trySlotUpdate(arr, idx, val, map = false) {
  if (!(ctx.transform.optFlags & OPTF.hashRmwFusion)) return null
  if (typeof arr !== 'string' || !Array.isArray(val) || val[0] == null || val[0] === 'str') return null
  // valTypeOf consults the decl-site FLOW overlay, which stamps a dictionary-
  // mode `{}` binding OBJECT (the literal node's kind) even though the
  // dictionary lowering just repped it VAL.HASH — honor the rep, else the
  // fusion never fires on exactly the bindings it exists for (`counts[w] =
  // (counts[w]|0)+1` on a computed-key dictionary).
  const at = repOf(arr)?.val === VAL.HASH ? VAL.HASH : valTypeOf(arr)
  // Unknown receivers still need the ordinary property/method dispatcher.
  if (at !== (map ? VAL.MAP : VAL.HASH)) return null
  if (map && (ctx.summary?.memberMayBeOwnOn('get', VAL.MAP) ||
      ctx.summary?.memberMayBeOwnOn('set', VAL.MAP))) return null
  // A proven string probes directly; an unknown key is normalized once.
  const keyStr = (typeof idx === 'string' && valTypeOf(idx) === VAL.STRING) || isLiteralStr(idx)
  const keyUnknown = typeof idx === 'string' && valTypeOf(idx) == null
  if (map) {
    if (typeof idx !== 'string' && !(Array.isArray(idx) && (idx[0] == null || idx[0] === 'str'))) return null
  } else if (!keyStr && (!keyUnknown || !primitive(idx))) return null
  const readNode = map ? ['()', ['.', arr, 'get'], idx] : ['[]', arr, idx]
  if (countReads(val, readNode) <= 0) return null
  const subst = (n) => !Array.isArray(n) ? n
    : same(n, readNode) ? oldT
    : n.map((c, i) => i === 0 ? c : subst(c))
  const lean = !map && ctx.func.leanHashLocals?.has(arr)
  const i32Values = lean && ctx.func.i32HashLocals?.has(arr)
  // Lean dictionary counts keep the existing i32 cell representation.
  const oT = temp('rmo'), kT = temp('rmk'), oldT = i32Values ? tempI32('rmold') : temp('rmold'), resT = i32Values ? tempI32('rmres') : temp('rmres')
  const slotT = tempI32('rms')
  const domain = lean ? ctx.func.leanHashDomains?.get(arr) : null
  const domainLen = domain ? repOf(domain)?.arrayLen : null
  // The no-growth probe is valid only when analysis proved the source domain's
  // length immutable. A runtime `.length` preallocation hint alone is not a
  // finite-domain proof: the source array may grow while keys are inserted.
  const capHint = dictCapacity(domainLen)
  const fixed = capHint != null
  const slotFn = map ? '$__map_slot' : fixed ? '$__hash_slot_eph_fixed' : lean ? '$__hash_slot_eph' : '$__hash_slot'
  const slotCall = (obj, key) => ['call', slotFn, obj, key,
    ...(fixed ? [['i32.const', capHint]] : [])]
  inc(map ? '__map_slot' : fixed ? '__hash_slot_eph_fixed' : lean ? '__hash_slot_eph' : '__hash_slot')
  const resIR = i32Values ? asI32(emit(subst(val))) : asF64(map ? storedValue(subst(val)) : emit(subst(val)))
  // Numeric results need no durable-pointer write barrier.
  const bare = i32Values || isNumericIR(resIR)
  if (!bare) inc('__slot_write')
  const writeBack = bare
    ? ['i64.store', ['local.get', `$${slotT}`], ['i64.reinterpret_f64', ['local.get', `$${resT}`]]]
    : ['call', '$__slot_write', ['local.get', `$${slotT}`],
      ['i64.reinterpret_f64', ['local.get', `$${resT}`]]]
  // A proven dictionary has a slot for every normalized key. Normalize
  // once, then probe, load, compute and store through that slot.
  if (!map && !keyStr) inc('__to_str')
  return typed(['block', ['result', 'f64'],
    ['local.set', `$${oT}`, asF64(emit(arr))],
    ['local.set', `$${kT}`, asF64(map ? storedValue(idx) : emit(idx))],
    ...(!map && !keyStr ? [['if',
      ['i32.eqz', ['i32.and',
        ['f64.ne', ['local.get', `$${kT}`], ['local.get', `$${kT}`]],
        ['i64.eq',
          ['i64.and', ['i64.shr_u', ['i64.reinterpret_f64', ['local.get', `$${kT}`]],
            ['i64.const', String(LAYOUT.TAG_SHIFT)]], ['i64.const', String(LAYOUT.TAG_MASK)]],
          ['i64.const', String(PTR.STRING)]]]],
      ['then', ['local.set', `$${kT}`,
        ['f64.reinterpret_i64', ['call', '$__to_str', ['i64.reinterpret_f64', ['local.get', `$${kT}`]]]]]]]] : []),
    ['local.set', `$${slotT}`, slotCall(
      ['i64.reinterpret_f64', ['local.get', `$${oT}`]],
      ['i64.reinterpret_f64', ['local.get', `$${kT}`]])],
    ['local.set', `$${oldT}`, i32Values
      ? ['i32.load', ['local.get', `$${slotT}`]]
      : ['f64.load', ['local.get', `$${slotT}`]]],
    ['local.set', `$${resT}`, resIR],
    i32Values
      ? ['i32.store', ['local.get', `$${slotT}`], ['local.get', `$${resT}`]]
      : writeBack,
    map ? ['local.get', `$${oT}`] : i32Values ? ['f64.convert_i32_s', ['local.get', `$${resT}`]] : ['local.get', `$${resT}`]], 'f64')
}

