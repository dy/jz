/**
 * Class dispatch: a class lowered to a schema with identity and functions
 * taking the receiver (jzify/classes.js, `ctx.transform.classes` by brand).
 * A member access on a receiver the summary knows as one class is a direct
 * call; on a receiver it does not, a compare of the pointer's schema id per
 * class that has the member, then whatever the access would otherwise be.
 * `o instanceof C` is the same compare over C and the classes deriving from it.
 *
 * @module compile/emit/class-dispatch
 */

import { OBJECT_SCHEMA_HI_MASK, objectSchemaGuardHex } from '../../../layout.js'
import { ctx, inc } from '../../ctx.js'
import { CLASS_T, ACCESSOR_GET, ACCESSOR_SET, MUTATE_OPS } from '../../ast.js'
import { asF64, asI64, isNullish, isUndef, temp, throwTypeErrorIR, typed } from '../../ir.js'
import { K, tagOf, paramOf, isNullable, UNKNOWN } from '../../summary/index.js'
import { emit } from '../../bridge.js'
import { inBoundsArrIdx } from '../../type/canonical-bounds.js'

const BIND = CLASS_T + 'bind'
const isAccessorSlot = (name) => name.endsWith(ACCESSOR_GET) || name.endsWith(ACCESSOR_SET)

const classes = () => ctx.transform.classes
/** The class registered under a schema id, or null. */
export const classOfSid = (sid) => { const brand = ctx.schema.brandOf?.(sid); return brand ? classes()?.get(brand) ?? null : null }
/** Every class with a method `name`, own or inherited, in declaration order. */
export const classesWith = (name) => classes() ? [...classes().values()].filter(e => e.methods.has(name)) : []
const sidOf = (entry) => ctx.schema.sidOfBrand(entry.brand)

/** The receiver's class when the summary names its schema: `{ entry, nullable }`, else null.
 *  An element read the interval prover puts in bounds is exactly the element's kind. */
const receiverClass = (obj) => {
  const k = ctx.summary?.kindOfExpr(obj)
  if (k == null || tagOf(k) !== K.OBJECT || paramOf(k) === UNKNOWN) return null
  const entry = classOfSid(paramOf(k))
  const inBounds = Array.isArray(obj) && obj[0] === '[]' && typeof obj[1] === 'string' && typeof obj[2] === 'string' && inBoundsArrIdx(ctx).has(obj[1] + '\x00' + obj[2])
  return entry ? { entry, nullable: isNullable(k) && !inBounds } : null
}
/** Whether the summary rules the receiver out as a class instance: a kind other than an object. */
const notAnObject = (obj) => { const k = ctx.summary?.kindOfExpr(obj); return k != null && tagOf(k) !== K.OBJECT && tagOf(k) !== K.ANY && tagOf(k) !== K.NONE }

const tagEq = (recv, sid) => ['i64.eq', ['i64.and', ['i64.reinterpret_f64', ['local.get', `$${recv}`]], ['i64.const', OBJECT_SCHEMA_HI_MASK]], ['i64.const', objectSchemaGuardHex(sid)]]

/**
 * A member of the receiver's class: `fnOf(entry)` names the function taking
 * the receiver (null when the class lacks the member), `build(fn, recv)` emits
 * the access through it, `rest(recv)` the access on any other receiver, and
 * `dispatcher` the shared function for a receiver the summary cannot name
 * (`held` names a local the caller has already set to the receiver's value).
 * Returns undefined when the receiver is no class instance.
 */
function dispatch(obj, name, fnOf, build, rest, dispatcher, held) {
  if (inDispatcher()) return undefined
  // a scalar-replaced literal (SRoA, no heap presence) is never an instance
  if (typeof obj === 'string' && ctx.func.flatObjects?.has(obj)) return undefined
  const known = receiverClass(obj)
  if (!known) return notAnObject(obj) || !ctx.funcs.names.has(dispatcher) ? undefined : dispatcher
  const fn = fnOf(known.entry)
  if (fn == null) return rest(held ?? obj)
  // An own property stored under the member's name shadows it: probe it
  // first and take the ordinary path on a hit (the class contract).
  const member = (t) => {
    if (!ctx.summary.memberMayBeOwn(name)) return asF64(build(fn, t))
    inc('__dyn_get_expr', '__ptr_type')
    return ['if', ['result', 'f64'],
      isUndef(['f64.reinterpret_i64', ['call', '$__dyn_get_expr', ['i64.reinterpret_f64', ['local.get', `$${t}`]], asI64(emit(['str', name]))]]),
      ['then', asF64(build(fn, t))], ['else', asF64(rest(t))]]
  }
  if (!known.nullable && !ctx.summary.memberMayBeOwn(name)) return build(fn, held ?? obj)
  const t = held ?? temp('cls')
  const hold = held ? [] : [['local.set', `$${t}`, asF64(emit(obj))]]
  return typed(['block', ['result', 'f64'], ...hold,
    // the summary admits nullish besides the class: JS throws on the read
    known.nullable
      ? ['if', ['result', 'f64'], isNullish(['local.get', `$${t}`]), ['then', throwTypeErrorIR('read')], ['else', member(t)]]
      : member(t)], 'f64')
}

const withReceiver = (recv, args) => args.length === 0 ? recv : [',', recv, ...args]

/** `obj.method(args)` through the class's function; `rest(recv)` dispatches any other receiver. */
export function classMethodCall(obj, method, args, rest) {
  if (!classes()) return undefined
  const r = dispatch(obj, method, e => e.methods.get(method) ?? null, (fn, recv) => emit(['()', fn, withReceiver(recv, args)]), rest, dispatcherName(method, 'call'))
  return typeof r === 'string' ? emit(['()', r, withReceiver(obj, args)]) : r
}

/** `obj.method` read as a value: the method bound to the receiver. */
export function classMethodValue(obj, method, rest) {
  if (!classes() || isAccessorSlot(method) || !classesWith(method).length) return undefined
  const r = dispatch(obj, method, e => e.methods.has(method) ? e.methods.get(method) + BIND : null, (fn, recv) => emit(['()', fn, recv]), rest, dispatcherName(method, 'read'))
  return typeof r === 'string' ? emit(['()', r, obj]) : r
}

/** `obj.prop` through the class's getter `prop__get`, or `obj.prop = v` through
 *  its setter with `args = [v]`; `held` names a local already holding the receiver. */
export function classAccessor(obj, slot, args, rest, held) {
  if (!classes() || !classesWith(slot).length) return undefined
  const prop = slot.endsWith(ACCESSOR_GET) ? slot.slice(0, -ACCESSOR_GET.length) : slot.slice(0, -ACCESSOR_SET.length)
  const r = dispatch(obj, prop, e => e.methods.get(slot) ?? null, (fn, recv) => emit(['()', fn, withReceiver(recv, args)]), rest, dispatcherName(slot, 'call'), held)
  return typeof r === 'string' ? emit(['()', r, withReceiver(held ?? obj, args)]) : r
}

/** `a instanceof C`: the pointer carries the schema id of C or of a class deriving from C. */
export function classInstanceof(a, brand) {
  const entry = classes()?.get(brand)
  const derives = (e) => { for (let c = e; c; c = c.base ? classes().get(c.base) : null) if (c === entry) return true; return false }
  const sids = entry ? [...classes().values()].filter(derives).map(sidOf).filter(sid => sid != null) : []
  const t = temp('inst')
  const known = receiverClass(a)
  if (known && !known.nullable) return typed(['block', ['result', 'i32'], ['drop', asF64(emit(a))], ['i32.const', derives(known.entry) ? 1 : 0]], 'i32')
  if (!sids.length || notAnObject(a)) return typed(['block', ['result', 'i32'], ['drop', asF64(emit(a))], ['i32.const', 0]], 'i32')
  const test = sids.map(sid => typed(tagEq(t, sid), 'i32')).reduce((x, y) => typed(['i32.or', x, y], 'i32'))
  return typed(['block', ['result', 'i32'], ['local.set', `$${t}`, asF64(emit(a))], test], 'i32')
}

/**
 * The member names the program uses, by position: called (`o.m(…)`), read
 * (`o.m`, `o["m"]`), stored (`o.m = v`). One census per compile.
 */
export function memberUses() {
  if (ctx.transform.memberUses) return ctx.transform.memberUses
  const called = new Set(), read = new Set(), written = new Set()
  // `o.m` and `o["m"]` name the member alike
  const memberOf = (n) => !Array.isArray(n) ? null
    : (n[0] === '.' || n[0] === '?.') && typeof n[2] === 'string' ? n[2]
    : n[0] === '[]' && Array.isArray(n[2]) && (n[2][0] === 'str' || n[2][0] == null) && typeof n[2][1] === 'string' ? n[2][1] : null
  const walk = (n) => {
    if (!Array.isArray(n)) return
    const op = n[0], m = n.length > 1 ? memberOf(n[1]) : null
    // a call through a computed key reads the member as a value first
    if ((op === '()' || op === '?.()') && m != null) { (n[1][0] === '[]' ? read : called).add(m); walk(n[1][1]); for (let i = 2; i < n.length; i++) walk(n[i]); return }
    if (MUTATE_OPS.has(op) && m != null) { written.add(m); if (op !== '=') read.add(m); walk(n[1][1]); for (let i = 2; i < n.length; i++) walk(n[i]); return }
    const own = memberOf(n)
    if (own != null) { read.add(own); walk(n[1]); return }
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  for (const f of ctx.funcs.list) { walk(f.body); if (f.defaults) for (const d of Object.values(f.defaults)) walk(d) }
  walk(ctx.module.entryInit)
  for (const init of ctx.module.moduleInits ?? []) walk(init)
  return ctx.transform.memberUses = { called, read, written }
}

// A dispatcher: one function per member the program accesses on receivers
// the summary cannot name, so every such site is one call and the schema-id
// compares exist once per member rather than once per site.
const DISPATCH = CLASS_T + 'dispatch' + CLASS_T
const dispatcherName = (key, use) => DISPATCH + key + (use === 'call' ? '' : CLASS_T + use)
/** Whether the function being emitted is a dispatcher (its signature says so): class dispatch is off inside it. */
export const inDispatcher = () => !!ctx.func?.current?.dispatcher

/**
 * Synthesize the dispatchers as prepared functions before the summary runs
 * (compile/index.js): for a member `m` the program calls, reads or stores on
 * some receiver, a function of the receiver and the arguments that tests
 * `r instanceof C` for each class with the member, most derived first, and
 * calls the class's function; any other receiver takes the access as it is,
 * with class dispatch off. An own property stored under the member's name
 * is probed first (the class contract, jzify/classes.js).
 */
export function synthesizeClassDispatchers() {
  if (!classes()?.size) return
  const { called, read, written } = memberUses()
  const byName = new Map(ctx.funcs.list.map(f => [f.name, f]))
  const depth = (e) => { let d = 0; for (let c = e; c.base; c = classes().get(c.base)) d++; return d }
  const entries = [...classes().values()].sort((a, b) => depth(b) - depth(a))   // most derived first
  const keys = new Set()
  for (const e of entries) for (const k of e.methods.keys()) keys.add(k)
  const R = CLASS_T + 'r', A = (i) => CLASS_T + 'a' + i
  const argList = (n) => n === 0 ? null : n === 1 ? A(0) : [',', ...Array.from({ length: n }, (_, i) => A(i))]
  // `['__own', r, ['str', prop]]`: whether `r` carries an own property `prop` where the
  // summary admits one stored under that name (the class contract); false
  // otherwise, folding the probe away.
  ctx.core.emit.__own = (r, propLit) => {
    if (!ctx.summary.memberMayBeOwn(propLit[1])) return typed(['i32.const', 0], 'i32')
    inc('__dyn_get_expr', '__ptr_type')
    return typed(['i32.eqz', isUndef(['f64.reinterpret_i64', ['call', '$__dyn_get_expr', ['i64.reinterpret_f64', asF64(emit(r))], asI64(emit(propLit))]])], 'i32')
  }
  const define = (name, arity, arm, fallback, prop) => {
    if (byName.has(name)) return
    const stmts = [['if', ['__own', R, ['str', prop]], ['return', fallback]]]
    for (const e of entries) { const fn = e.methods.get(arm.key); if (fn) stmts.push(['if', ['instanceof', R, e.brand], ['return', arm.call(fn)]]) }
    stmts.push(['return', fallback])
    const params = [{ name: R, type: 'f64' }, ...Array.from({ length: arity }, (_, i) => ({ name: A(i), type: 'f64' }))]
    const body = ['{}', [';', ...stmts]]
    const func = { name, body, exported: false, sig: { params, results: ['f64'], dispatcher: true } }
    ctx.funcs.list.push(func); byName.set(name, func)
  }
  const withR = (n) => n === 0 ? R : [',', R, ...Array.from({ length: n }, (_, i) => A(i))]
  for (const key of keys) {
    const isGet = key.endsWith(ACCESSOR_GET), isSet = key.endsWith(ACCESSOR_SET)
    const prop = isGet ? key.slice(0, -ACCESSOR_GET.length) : isSet ? key.slice(0, -ACCESSOR_SET.length) : key
    if (isGet) { if (read.has(prop)) define(dispatcherName(key, 'call'), 0, { key, call: fn => ['()', fn, R] }, ['.', R, prop], prop); continue }
    if (isSet) { if (written.has(prop)) define(dispatcherName(key, 'call'), 1, { key, call: fn => ['()', fn, withR(1)] }, ['=', ['.', R, prop], A(0)], prop); continue }
    if (called.has(key)) {
      const arity = Math.max(0, ...entries.map(e => { const f = byName.get(e.methods.get(key)); return f ? f.sig.params.length - 1 : 0 }))
      define(dispatcherName(key, 'call'), arity, { key, call: fn => ['()', fn, withR(arity)] }, ['()', ['.', R, key], argList(arity)], key)
    }
    if (read.has(key)) define(dispatcherName(key, 'read'), 0, { key, call: fn => ['()', fn + BIND, R] }, ['.', R, key], key)
  }
}

/**
 * The class functions the program can reach: the dispatchers of the members
 * it calls, reads or stores, and each dispatcher's targets through them; a
 * class function a resolved site calls is reached as any direct callee.
 */
export function classRootNames() {
  if (!classes()?.size) return []
  const { called, read, written } = memberUses()
  const roots = []
  for (const entry of classes().values()) for (const [m, fn] of entry.methods) {
    if (m.endsWith(ACCESSOR_GET)) { if (read.has(m.slice(0, -ACCESSOR_GET.length))) roots.push(fn, dispatcherName(m, 'call')); continue }
    if (m.endsWith(ACCESSOR_SET)) { if (written.has(m.slice(0, -ACCESSOR_SET.length))) roots.push(fn, dispatcherName(m, 'call')); continue }
    if (called.has(m)) roots.push(fn, dispatcherName(m, 'call'))
    if (read.has(m)) roots.push(fn, fn + BIND, dispatcherName(m, 'read'))
  }
  return roots
}
