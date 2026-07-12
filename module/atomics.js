/**
 * Atomics — wasm threads (0xfe atomics) mapping for shared-memory SPMD kernels.
 *
 * v1 contract (Workers v1, .work/extension-surface.md): shared TYPED ARRAYS +
 * scalars only. Receivers must be PROVEN Int32Array — the one JS type whose
 * Atomics semantics map 1:1 onto i32.atomic.* (BigInt64Array can join later).
 * Strings/objects/hashes stay thread-local by documented contract.
 *
 * Same source runs as plain JS: host Atomics accepts non-shared Int32Array
 * (ES2024) exactly like these lowerings on non-shared memory; only wait()
 * requires a shared buffer on both sides.
 *
 * @module atomics
 */
import { typed, asI64, asI32, toNumF64 } from '../src/ir.js'
import { valTypeOf } from '../src/kind.js'
import { emit, deps } from '../src/bridge.js'
import { inc, err, PTR } from '../src/ctx.js'
import { VAL } from '../src/reps.js'

export default (ctx) => {
  deps({
    __atomics_addr: ['__typed_data', '__len', '__ptr_type', '__ptr_aux'],
    __atomics_addr64: ['__typed_data', '__len', '__ptr_type', '__ptr_aux'],
  })

  // Element address of an Int32Array. Guards BEFORE touching memory: the boxed
  // value must actually be an Int32Array (tag TYPED, elem code 4 — the compile
  // proof may come from the default-arg annotation, which a host caller can
  // violate) and the index in range (spec RangeError) — either failure throws.
  ctx.core.stdlib['__atomics_addr'] = `(func $__atomics_addr (param $arr i64) (param $i i32) (result i32)
    (if (i32.or
          (i32.ne (call $__ptr_type (local.get $arr)) (i32.const ${PTR.TYPED}))
          (i32.ne (i32.and (call $__ptr_aux (local.get $arr)) (i32.const 7)) (i32.const 4)))
      (then (throw $__jz_err (f64.const 0))))
    (if (i32.ge_u (local.get $i) (call $__len (local.get $arr)))
      (then (throw $__jz_err (f64.const 0))))
    (i32.add (call $__typed_data (local.get $arr)) (i32.shl (local.get $i) (i32.const 2))))`

  // BigInt64Array twin: elem code 7 + the BIGINT aux flag (16), stride 8.
  ctx.core.stdlib['__atomics_addr64'] = `(func $__atomics_addr64 (param $arr i64) (param $i i32) (result i32)
    (if (i32.or
          (i32.ne (call $__ptr_type (local.get $arr)) (i32.const ${PTR.TYPED}))
          (i32.or
            (i32.ne (i32.and (call $__ptr_aux (local.get $arr)) (i32.const 7)) (i32.const 7))
            (i32.eqz (i32.and (call $__ptr_aux (local.get $arr)) (i32.const 16)))))
      (then (throw $__jz_err (f64.const 0))))
    (if (i32.ge_u (local.get $i) (call $__len (local.get $arr)))
      (then (throw $__jz_err (f64.const 0))))
    (i32.add (call $__typed_data (local.get $arr)) (i32.shl (local.get $i) (i32.const 3))))`

  // v1 receiver gate: a name whose element ctor is PROVEN Int32Array, or a
  // direct `new Int32Array(...)` expression. Anything else is a clean reject —
  // an unproven receiver would need runtime elem dispatch the contract excludes.
  const recvWidth = (arr) => {
    let ctor = null
    if (Array.isArray(arr) && arr[0] === 'new' && typeof arr[1] === 'string') ctor = 'new.' + arr[1]
    else if (typeof arr === 'string')
      ctor = ctx.func.localTypedElemsOverlay?.get(arr) ?? ctx.types.typedElem?.get(arr)
        ?? ctx.func.localReps?.get(arr)?.typedCtor          // narrowed param facts (typed default-arg seed)
        ?? ctx.scope?.globalTypedElem?.get(arr)
    if (ctor === 'new.Int32Array' || ctor === 'new.Int32Array.view') return 'i32'
    if (ctor === 'new.BigInt64Array' || ctor === 'new.BigInt64Array.view') return 'i64'
    err(`Atomics: receiver must be a proven Int32Array or BigInt64Array (shared-memory v1 contract) — got ${typeof arr === 'string' ? `'${arr}' (${ctor ?? 'unproven'})` : 'an expression'}`)
  }

  const addr = (arr, i, w) => {
    inc(w === 'i64' ? '__atomics_addr64' : '__atomics_addr')
    ctx.runtime.throws = true
    return ['call', w === 'i64' ? '$__atomics_addr64' : '$__atomics_addr', asI64(emit(arr)), asI32(toNumF64(i, emit(i)))]
  }
  const i32val = (v) => asI32(toNumF64(v, emit(v)))
  // BigInt64 lanes carry raw i64 — the value must be a proven BigInt expression.
  const i64val = (v) => {
    if (valTypeOf(v) !== VAL.BIGINT) err('Atomics on a BigInt64Array takes BigInt values — wrap with BigInt(…)')
    return asI64(emit(v))
  }
  const val = (v, w) => w === 'i64' ? i64val(v) : i32val(v)
  const out = (irF, w) => w === 'i64'
    ? typed(['f64.reinterpret_i64', irF], 'f64')          // raw BIGINT carrier
    : typed(['f64.convert_i32_s', irF], 'f64')

  ctx.core.emit['Atomics.load'] = (arr, i) => {
    const w = recvWidth(arr)
    return out([`${w}.atomic.load`, addr(arr, i, w)], w)
  }

  // store returns the stored value (spec: the coerced input)
  ctx.core.emit['Atomics.store'] = (arr, i, v) => {
    const w = recvWidth(arr)
    const t = `atst${ctx.func.uniq++}`
    ctx.func.locals.set(t, w)
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, val(v, w)],
      [`${w}.atomic.store`, addr(arr, i, w), ['local.get', `$${t}`]],
      out(['local.get', `$${t}`], w)], 'f64')
  }

  // RMW family — each returns the OLD value.
  for (const [name, op] of [['add', 'add'], ['sub', 'sub'], ['and', 'and'], ['or', 'or'], ['xor', 'xor'], ['exchange', 'xchg']])
    ctx.core.emit[`Atomics.${name}`] = (arr, i, v) => {
      const w = recvWidth(arr)
      return out([`${w}.atomic.rmw.${op}`, addr(arr, i, w), val(v, w)], w)
    }

  ctx.core.emit['Atomics.compareExchange'] = (arr, i, expected, replacement) => {
    const w = recvWidth(arr)
    return out([`${w}.atomic.rmw.cmpxchg`, addr(arr, i, w), val(expected, w), val(replacement, w)], w)
  }

  // wait(arr, i, value, timeoutMs?) → 'ok' | 'not-equal' | 'timed-out'
  // (static strings 9/10/11). Timeout converts ms → ns; absent/Infinity →
  // -1 (infinite). Only valid off the main thread on a SHARED memory — a
  // non-shared memory traps, the wasm analogue of the host's TypeError.
  ctx.core.emit['Atomics.wait'] = (arr, i, value, timeout) => {
    const w = recvWidth(arr)
    inc('__static_str')
    const tmo = timeout === undefined
      ? ['i64.const', -1]
      : ['i64.trunc_sat_f64_s', ['f64.mul', toNumF64(timeout, emit(timeout)), ['f64.const', 1e6]]]
    return typed(['call', '$__static_str',
      ['i32.add', ['i32.const', 9],
        [w === 'i64' ? 'memory.atomic.wait64' : 'memory.atomic.wait32', addr(arr, i, w), val(value, w), tmo]]], 'f64')
  }

  // notify(arr, i, count?) → number of woken waiters; count defaults to all.
  ctx.core.emit['Atomics.notify'] = (arr, i, count) => {
    const w = recvWidth(arr)
    return typed(['f64.convert_i32_s',
      ['memory.atomic.notify', addr(arr, i, w), count === undefined ? ['i32.const', -1] : i32val(count)]], 'f64')
  }

  // isLockFree(n) — wasm i32 atomics are lock-free at 1/2/4 (and 8 via i64).
  ctx.core.emit['Atomics.isLockFree'] = (n) => {
    const t = `atlf${ctx.func.uniq++}`
    ctx.func.locals.set(t, 'i32')
    const v = () => ['local.get', `$${t}`]
    return typed(['block', ['result', 'i32'],
      ['local.set', `$${t}`, asI32(toNumF64(n, emit(n)))],
      ['i32.or',
        ['i32.or', ['i32.eq', v(), ['i32.const', 4]], ['i32.eq', v(), ['i32.const', 1]]],
        ['i32.or', ['i32.eq', v(), ['i32.const', 2]], ['i32.eq', v(), ['i32.const', 8]]]]], 'i32')
  }
}
