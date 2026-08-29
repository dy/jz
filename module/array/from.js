/**
 * Array.from(items, mapfn) — ES2015 22.1.2.1: string/array/typed/general
 * array-like sources, each with its own fast loop shape; IsCallable(mapfn)
 * checked before iterating per spec step 2. Pure move from module/array.js
 * (pipeline-minimality): every helper here (isUndefinedNode/
 * isNonCallableMapFn/arrayFromThrow/nanPtrTypeEq/callbackSetup/
 * staticArrayLikeLength/ARRAY_FROM_MAX_LENGTH/toLengthIR) is private to
 * this one registration — single call site, grep-verified.
 *
 * @module array/from
 */
import { typed, asF64, asI64, temp, tempI32, allocPtr, elemStore, resolveValType, ptrTypeEq, freshId, throwTypeErrorIR, cloneIR } from '../../src/ir.js'
import { emit, spread } from '../../src/bridge.js'
import { valTypeOf } from '../../src/kind.js'
import { staticPropertyKey } from '../../src/static.js'
import { VAL, lookupValType } from '../../src/reps.js'
import { ctx, inc, err, PTR, setLinkDemand } from '../../src/ctx.js'
import { ERR } from '../../err-codes.js'
import { makeCallback, idxArg } from './callback.js'

// Array.from(items, mapfn): spec step 2 — if mapfn is not undefined and
// IsCallable(mapfn) is false, throw a TypeError before iterating items.
// An explicit `undefined` arrives as the literal node [null, undefined];
// treat it as absent. Statically flag literal forms that can't be callable.
const isUndefinedNode = (n) => n === undefined
  || (Array.isArray(n) && n[0] == null && n.length === 2 && n[1] === undefined)
const isNonCallableMapFn = (n) => {
  if (!Array.isArray(n)) return false        // undefined / identifier — unknown
  const op = n[0]
  if (op == null) return true                // [null,x] literal — null/number/bigint
  if (op === '=>') return false              // arrow function — callable
  if (op === '{}' || op === 'str' || op === 'strcat' || op === '//' || op === 'bool') return true  // object/string/regexp/boolean literal
  if (op === '[]' && n.length < 3) return true            // array literal
  if (op === '()' && n[1] === 'Symbol') return true       // Symbol(...) result
  return false                               // calls / member access — unknown
}

const arrayFromThrow = code => {
  ctx.runtime.throws = true
  return [
    ['global.set', '$__jz_last_err_bits', ['i64.reinterpret_f64', ['f64.const', code]]],
    ['throw', '$__jz_err', ['f64.const', code]],
  ]
}

const nanPtrTypeEq = (value, type) => ['i32.and',
  ['f64.ne', cloneIR(value), cloneIR(value)],
  ptrTypeEq(cloneIR(value), type)]

// Dynamic callback values must be rejected before reading items.length, even
// for a zero-length source. Literal arrows are callable by construction.
const callbackSetup = cb => cb ? [
  cb.setup,
  ...(cb.dynamic ? [[
    'if', ['i32.eqz', nanPtrTypeEq(cb.value, PTR.CLOSURE)],
    ['then', ...arrayFromThrow(ERR.ARRAY_FROM_MAPFN)],
  ]] : []),
] : []

const staticArrayLikeLength = src => {
  if (!Array.isArray(src) || src[0] !== '{}') return null
  const props = src.length === 2 && Array.isArray(src[1]) && src[1][0] === ','
    ? src[1].slice(1) : src.slice(1)
  for (const prop of props) {
    if (!Array.isArray(prop) || prop[0] !== ':') continue
    const key = typeof prop[1] === 'string' ? prop[1] : staticPropertyKey(prop[1])
    if (key === 'length') return prop[2]
  }
  return null
}

// __alloc_hdr reserves 16 + len*8 bytes in a wasm32 i32 size. Keep that
// computation non-wrapping; larger legal JS lengths reject as unsupported.
const ARRAY_FROM_MAX_LENGTH = 0x1ffffffd
const toLengthIR = (raw, num, len) => [
  ['local.set', `$${num}`, ['call', '$__to_num', ['i64.reinterpret_f64', ['local.get', `$${raw}`]]]],
  ['if', ['f64.gt', ['local.get', `$${num}`], ['f64.const', ARRAY_FROM_MAX_LENGTH]],
    ['then', ...arrayFromThrow(ERR.ARRAY_FROM_LENGTH)]],
  ['local.set', `$${len}`, ['select',
    ['i32.trunc_sat_f64_s', ['local.get', `$${num}`]],
    ['i32.const', 0],
    ['f64.gt', ['local.get', `$${num}`], ['f64.const', 0]]]],
]

export const arrayFromEmit = (src, mapFn) => {
  if (isUndefinedNode(mapFn)) mapFn = undefined

  // Call arguments evaluate left-to-right before Array.from performs its
  // IsCallable check or reads items.length. Even an obviously invalid mapfn
  // must not erase effects from constructing/evaluating the source argument.
  if (mapFn && isNonCallableMapFn(mapFn)) {
    const s = temp('afbadsrc'), m = temp('afbadmap')
    const srcIR = asF64(emit(src)), mapIR = asF64(emit(mapFn))
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${s}`, srcIR],
      ['local.set', `$${m}`, mapIR],
      ...arrayFromThrow(ERR.ARRAY_FROM_MAPFN)], 'f64')
  }

  const sourceVt = resolveValType(src, valTypeOf, lookupValType)
  if (mapFn && !ctx.closure.call) ctx.module.include('fn')
  if (sourceVt === VAL.SET || sourceVt === VAL.MAP || sourceVt === VAL.CLOSURE)
    err(sourceVt === VAL.CLOSURE
      ? 'Array.from: a function/generator source is not supported — jz has no iterator-protocol dispatch for a callable'
      : 'Array.from: Set/Map sources are not supported here — spread it instead: [...source]')
  const staticLength = staticArrayLikeLength(src)
  if ((staticLength != null && valTypeOf(staticLength) === VAL.BIGINT) ||
      ((sourceVt === VAL.OBJECT || sourceVt === VAL.HASH) && valTypeOf(['.', src, 'length']) === VAL.BIGINT))
    err('Array.from: BigInt array-like length is unsupported (ToLength must throw)')

  // Array.from(string) → array of single-char strings. The generic __arr_from
  // path memory-copies f64 slots and is invalid for byte-backed strings.
  if (sourceVt === VAL.STRING) {
    inc('__str_idx', '__str_len')
    const s = temp('sfs'), len = tempI32('sfl'), i = tempI32('sfi')
    const srcIR = asF64(emit(src))
    const cb = mapFn && makeCallback(mapFn, [null, { val: VAL.NUMBER }])
    const lenIR = ['local.get', `$${len}`]
    const out = allocPtr({ type: PTR.ARRAY, len: lenIR, tag: 'sfr' })
    const ch = typed(['call', '$__str_idx', ['i64.reinterpret_f64', ['local.get', `$${s}`]], ['local.get', `$${i}`]], 'f64')
    const item = cb ? cb.call([ch, idxArg(cb, i)]) : ch
    const id = freshId(ctx)
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${s}`, srcIR],
      ...callbackSetup(cb),
      ['local.set', `$${len}`, ['call', '$__str_len', ['i64.reinterpret_f64', ['local.get', `$${s}`]]]],
      out.init,
      ['local.set', `$${i}`, ['i32.const', 0]],
      ['block', `$brk${id}`, ['loop', `$loop${id}`,
        ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${i}`], lenIR]],
        elemStore(out.local, i, asF64(item)),
        ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
        ['br', `$loop${id}`]]],
      out.ptr], 'f64')
  }

  // Preserve the raw-copy fast path for statically-known Array/TypedArray
  // sources without a mapper.
  if (!mapFn && (sourceVt === VAL.ARRAY || sourceVt === VAL.TYPED)) {
    inc('__arr_from')
    return typed(['call', '$__arr_from', asI64(emit(src))], 'f64')
  }

  // Known Array/TypedArray + mapper: fixed integer length, but each element
  // is read afresh so callback mutations of not-yet-visited slots are visible.
  if (mapFn && (sourceVt === VAL.ARRAY || sourceVt === VAL.TYPED)) {
    inc('__len', '__typed_idx')
    const s = temp('afs'), len = tempI32('afl'), i = tempI32('afi'), item = temp('afv')
    const srcIR = asF64(emit(src))
    const cb = makeCallback(mapFn, [null, { val: VAL.NUMBER }])
    const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${len}`], tag: 'aff' })
    const id = freshId(ctx)
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${s}`, srcIR],
      ...callbackSetup(cb),
      ['local.set', `$${len}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${s}`]]]],
      out.init,
      ['local.set', `$${i}`, ['i32.const', 0]],
      ['block', `$brk${id}`, ['loop', `$loop${id}`,
        ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
        ['local.set', `$${item}`, ['call', '$__typed_idx', ['i64.reinterpret_f64', ['local.get', `$${s}`]], ['local.get', `$${i}`]]],
        elemStore(out.local, i, asF64(cb.call([typed(['local.get', `$${item}`], 'f64'), idxArg(cb, i)]))),
        ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
        ['br', `$loop${id}`]]],
      out.ptr], 'f64')
  }

  // General array-like path. Construct/evaluate the source once, evaluate the
  // mapper next, then perform Get(items, "length") exactly once followed by
  // ToLength. Each iteration performs a fresh indexed Get. This replaces the
  // old literal shortcut, which reordered object-property effects, ignored
  // duplicate/computed keys, and silently omitted indices past a fixed cap.
  ctx.module.include('collection')
  ctx.module.include('array')
  ctx.runtime.schemaTblConsumed = true
  ctx.schema.errorSid('TypeError')
  const checkExternalIterable = sourceVt == null && ctx.transform.targetProfile.envImports
  if (checkExternalIterable) { setLinkDemand('external'); inc('__ext_has_iterator') }
  setLinkDemand('typedarray')
  inc('__length.value', '__ptr_type', '__typed_idx', '__str_idx', '__dyn_get_any_t', '__to_num')

  const s = temp('afsrc'), t = tempI32('aft'), rawLen = temp('afrawlen')
  const num = temp('afnum'), len = tempI32('aflen'), i = tempI32('afi')
  const srcIR = asF64(emit(src))
  const cb = mapFn && makeCallback(mapFn, [null, { val: VAL.NUMBER }])
  const lenIR = ['local.get', `$${len}`]
  const out = allocPtr({ type: PTR.ARRAY, len: lenIR, tag: 'afobj' })
  const idxF64 = typed(['f64.convert_i32_s', ['local.get', `$${i}`]], 'f64')
  const objectIndex = ['f64.reinterpret_i64', ['call', '$__dyn_get_any_t',
    ['i64.reinterpret_f64', ['local.get', `$${s}`]],
    ['i64.reinterpret_f64', idxF64],
    ['local.get', `$${t}`]]]
  const indexed = typed(['if', ['result', 'f64'],
    ['i32.or',
      ['i32.eq', ['local.get', `$${t}`], ['i32.const', PTR.ARRAY]],
      ['i32.eq', ['local.get', `$${t}`], ['i32.const', PTR.TYPED]]],
    ['then', ['call', '$__typed_idx', ['i64.reinterpret_f64', ['local.get', `$${s}`]], ['local.get', `$${i}`]]],
    ['else', ['if', ['result', 'f64'],
      ['i32.eq', ['local.get', `$${t}`], ['i32.const', PTR.STRING]],
      ['then', ['call', '$__str_idx', ['i64.reinterpret_f64', ['local.get', `$${s}`]], ['local.get', `$${i}`]]],
      ['else', objectIndex]]]], 'f64')
  const item = cb ? cb.call([indexed, idxArg(cb, i)]) : indexed
  const id = freshId(ctx)
  ctx.runtime.throws = true
  return typed(['block', ['result', 'f64'],
    ['local.set', `$${s}`, srcIR],
    ...callbackSetup(cb),
    ['local.set', `$${t}`, ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', `$${s}`]]]],
    ...(checkExternalIterable ? [[
      'if', ['i32.eq', ['local.get', `$${t}`], ['i32.const', PTR.EXTERNAL]],
      ['then', ['if',
        ['call', '$__ext_has_iterator', ['i64.reinterpret_f64', ['local.get', `$${s}`]]],
        ['then', ...arrayFromThrow(ERR.ARRAY_FROM_ITERABLE)]]],
    ]] : []),
    ['local.set', `$${rawLen}`, ['call', '$__length.value', ['i64.reinterpret_f64', ['local.get', `$${s}`]]]],
    ['if', nanPtrTypeEq(typed(['local.get', `$${rawLen}`], 'f64'), PTR.BIGINT),
      ['then', ['drop', throwTypeErrorIR()]]],
    ...toLengthIR(rawLen, num, len),
    out.init,
    ['local.set', `$${i}`, ['i32.const', 0]],
    ['block', `$brk${id}`, ['loop', `$loop${id}`,
      ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${i}`], lenIR]],
      elemStore(out.local, i, asF64(item)),
      ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
      ['br', `$loop${id}`]]],
    out.ptr], 'f64')
}
