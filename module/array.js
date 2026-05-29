/**
 * Array module — literals, indexing, methods, push/pop.
 *
 * Type=1 (ARRAY): C-style header in memory.
 * Layout: [-8:len(i32)][-4:cap(i32)][elem0:f64, elem1:f64, ...]
 * offset points to elem0 (past header). len/cap mutable. Aliases see changes.
 *
 * @module array
 */

import { typed, asF64, asI64, asI32, NULL_NAN, UNDEF_NAN, temp, tempI32, allocPtr, multiCount, arrayLoop, elemLoad, elemStore, truthyIR, extractF64Bits, appendStaticSlots, mkPtrIR, slotAddr, isLiteralStr, resolveValType, undefExpr, ptrTypeEq } from '../src/ir.js'
import { inBoundsArrIdx } from '../src/type.js'
import { emit, spread, deps } from '../src/bridge.js'
import { valTypeOf } from '../src/kind.js'
import { extractParams, classifyParam, ASSIGN_OPS, refsName, REFS_IN_EXPR } from '../src/ast.js'
import { staticPropertyKey, staticObjectProps, inlineArraySid } from '../src/static.js'
import { VAL, lookupValType, lookupNotString, updateRep } from '../src/reps.js'
import { structInline } from '../src/abi/index.js'
import { ctx, inc, err, PTR, LAYOUT, followForwardingWat } from '../src/ctx.js'
import { strHashLiteral } from './collection.js'


/** Allocate ARRAY (type=1): header + n*8 data. Returns { local, setup, ptr } where local is data offset. */
function allocArray(len, cap) {
  const a = allocPtr({ type: PTR.ARRAY, len, cap, tag: 'arr' })
  return { local: a.local, setup: [a.init], ptr: a.ptr }
}

/** Pack literal i64 slots as a static ARRAY: writes [len][cap][slots...] into the data segment
 *  and returns a folded ARRAY pointer to the first slot. */
function staticArrayPtr(slots) {
  if (!ctx.runtime.data) ctx.runtime.data = ''
  while (ctx.runtime.data.length % 8 !== 0) ctx.runtime.data += '\0'
  const headerOff = ctx.runtime.data.length
  const len = slots.length
  const hdr = new Uint8Array(8); new DataView(hdr.buffer).setInt32(0, len, true); new DataView(hdr.buffer).setInt32(4, len, true)
  for (let i = 0; i < 8; i++) ctx.runtime.data += String.fromCharCode(hdr[i])
  appendStaticSlots(slots)
  return mkPtrIR(PTR.ARRAY, 0, headerOff + 8)
}

function hoistArrayValue(arr) {
  const recv = temp('ar')
  return {
    setup: ['local.set', `$${recv}`, asF64(emit(arr))],
    value: typed(['local.get', `$${recv}`], 'f64'),
  }
}

const arrayLenFromPtr = ptr => ['i32.load', ['i32.sub', ['local.get', `$${ptr}`], ['i32.const', 8]]]

/** K schema-ordered field-value AST nodes of an object literal `{S}` for a
 *  structInline `.push({S})`, or null if `lit` is not a plain static-key `{}`
 *  literal carrying exactly schema `sid`'s fields. Mapped by name into schema
 *  order so push sites with differing key order flatten to the same cell run. */
function structLiteralFields(lit, sid) {
  if (!Array.isArray(lit) || lit[0] !== '{}') return null
  const parsed = staticObjectProps(lit.slice(1))
  const schema = ctx.schema.list[sid]
  if (!parsed || parsed.names.length !== schema.length) return null
  const byName = new Map()
  for (let i = 0; i < parsed.names.length; i++) byName.set(parsed.names[i], parsed.values[i])
  const out = []
  for (const name of schema) {
    if (!byName.has(name)) return null
    out.push(byName.get(name))
  }
  return out
}

// Pure-expression check: no statements, binders, control flow, or assignments.
// Inlining is only safe for these — anything else needs the full closure machinery.
const NOT_PURE_OPS = new Set([
  ';', '{}', 'let', 'const', 'var', '=>', 'function', 'return', 'throw',
  'if', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'try', 'catch', 'finally', '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '<<=', '>>=', '>>>=', '||=', '&&=', '??=', '++', '--', 'delete', 'yield', 'await',
])
function isPureExpr(node) {
  if (node == null || typeof node !== 'object' || !Array.isArray(node)) return true
  const op = node[0]
  if (op == null) return true
  if (NOT_PURE_OPS.has(op)) return false
  for (let i = 1; i < node.length; i++) if (!isPureExpr(node[i])) return false
  return true
}

// Substitute variable references in a pure expression. Skips property names on `.` / `?.`
// and object-literal keys on `:`. Body must be pre-checked with isPureExpr.
function substExpr(node, mapping) {
  if (typeof node === 'string') return mapping.has(node) ? mapping.get(node) : node
  if (!Array.isArray(node)) return node
  const op = node[0]
  if (op === '.' || op === '?.') return [op, substExpr(node[1], mapping), node[2]]
  if (op === ':') return [op, node[1], substExpr(node[2], mapping)]
  const out = [op]
  for (let i = 1; i < node.length; i++) out.push(substExpr(node[i], mapping))
  return out
}

function exprUses(node, name) {
  return refsName(node, name, REFS_IN_EXPR)
}

// Callback factory: returns { setup, call, usedParams } where call(argExprs) emits the invocation.
// Fast path: literal arrow with simple-string params and pure expression body → inline,
// substituting param refs with fresh locals. Zero closure alloc, zero call_indirect, zero
// args-array alloc. Captures resolve naturally to outer locals.
// Slow path: fall back to ctx.closure.call (heap-allocated args array per iteration).
// usedParams: boolean array (fast path only) — callers can skip computing args for unused params.
function makeCallback(fn, argReps) {
  if (Array.isArray(fn) && fn[0] === '=>') {
    const raw = extractParams(fn[1])
    const body = fn[2]
    if (raw.every(p => typeof p === 'string') && isPureExpr(body)) {
      const usedParams = raw.map(p => exprUses(body, p))
      return {
        setup: ['nop'],
        usedParams,
        call: (argExprs) => {
          const stmts = []
          const mapping = new Map()
          const freshNames = []
          for (let i = 0; i < raw.length; i++) {
            if (!usedParams[i]) { freshNames.push(null); continue }  // skip dead local + arg evaluation
            const fresh = temp('inl')
            mapping.set(raw[i], fresh)
            freshNames.push(fresh)
            const ae = i < argExprs.length && argExprs[i] != null
              ? asF64(argExprs[i])
              : typed(['f64.reinterpret_i64', ['i64.const', UNDEF_NAN]], 'f64')
            stmts.push(['local.set', `$${fresh}`, ae])
          }
          // Emit-time rep seeding for inliner-fresh param locals (lifecycle:
          // analysis already finished; these `inl_i` names didn't exist then).
          // Apply argReps hints (caller knows recv elem val type) to inlined-param
          // reps so emit(subst) sees `inl_i.val=NUMBER` and elides __to_num/__is_str_key.
          if (argReps) {
            for (let i = 0; i < raw.length && i < argReps.length; i++) {
              const fresh = freshNames[i]
              if (!fresh || !argReps[i]) continue
              updateRep(fresh, argReps[i])
            }
          }
          const subst = substExpr(body, mapping)
          const result = emit(subst)
          // Preserve i32 result type so callers (truthyIR, etc.) can skip f64↔i32 round-trips.
          const ty = result.type === 'i32' ? 'i32' : 'f64'
          return typed(['block', ['result', ty], ...stmts, result], ty)
        },
      }
    }
  }
  // Fallback: closure call — all params are potentially used.
  const cb = temp('af')
  return {
    setup: ['local.set', `$${cb}`, asF64(emit(fn))],
    call: (argExprs) => ctx.closure.call(typed(['local.get', `$${cb}`], 'f64'), argExprs),
  }
}

// Derive callback argReps from a receiver AST. For .map/.filter/etc., callbacks
// receive (item, idx, arr). idx is always a NUMBER. item depends on recv kind:
//  - VAL.TYPED → NUMBER (BigInt typed-arrays excluded; we don't track elem prec
//    here, but the .typed:[] path handles them, and __to_num elision is safe
//    because BigInt's f64-cast in arithmetic still yields a Number).
//  - VAL.ARRAY with rep.arrayElemValType set → that val.
//  - else → no hint (slow path, runtime dispatch as today).
function callbackArgReps(arr) {
  const idxRep = { val: VAL.NUMBER }
  const arrRep = { val: VAL.ARRAY }
  let itemRep = null
  if (typeof arr === 'string') {
    const vt = lookupValType(arr)
    if (vt === VAL.TYPED) itemRep = { val: VAL.NUMBER }
    else if (vt === VAL.ARRAY) {
      const elemVt = ctx.func.localReps?.get(arr)?.arrayElemValType
      if (elemVt) itemRep = { val: elemVt }
    }
  } else {
    const vt = valTypeOf(arr)
    if (vt === VAL.TYPED) itemRep = { val: VAL.NUMBER }
  }
  return [itemRep, idxRep, arrRep]
}

// Factory for simple arr→call stdlib patterns (mirrors strMethod in string.js)
const arrMethod = (name, nArgs = 0) => (...args) => {
  inc(name)
  const call = ['call', `$${name}`, ...args.slice(0, nArgs + 1).map(a => asF64(emit(a)))]
  return typed(call, 'f64')
}

const needsArrayDynMove = () => ctx.core.includes.has('__dyn_set')
const arrayGrowDeps = (knownArray = false) => () => [
  ...(knownArray ? [] : ['__ptr_type']),
  '__ptr_offset', '__alloc_hdr', '__mkptr',
  ...(needsArrayDynMove() ? ['__dyn_move'] : []),
]

// Arrays keep dynamic props in the global table because old/new array storage can
// be forwarded. Relocate that entry when growth moves the backing store.
const maybeDynMoveIR = () => needsArrayDynMove()
  ? '(call $__dyn_move (local.get $off) (local.get $newOff))'
  : ''

// Per-object propsPtr lives in the 16-byte header at $off-16. On grow we copy it
// from old to new header (still HASH-tagged → unshifted ARRAY case). On shift we
// migrate it to the global __dyn_props because the forwarding writes overwrite
// the destination's $newOff-16 slot. The HASH-tag check rejects 0 (no props) and
// forwarding garbage from a prior shift, so chained shift→grow is safe — the
// global hash takes over and __dyn_move keeps it in sync.
const headerPropsCopyIR = () => needsArrayDynMove() ? `
    (local.set $oldProps (f64.load (i32.sub (local.get $off) (i32.const 16))))
    (if (i32.eq
          (i32.wrap_i64 (i64.and (i64.shr_u (i64.reinterpret_f64 (local.get $oldProps)) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
          (i32.const ${PTR.HASH}))
      (then (f64.store (i32.sub (local.get $newOff) (i32.const 16)) (local.get $oldProps))))` : ''

const headerPropsToGlobalIR = () => needsArrayDynMove() ? `
    (if (i32.ge_u (local.get $off) (i32.const 16))
      (then
        (local.set $oldProps (f64.load (i32.sub (local.get $off) (i32.const 16))))
        (if (i32.eq
              (i32.wrap_i64 (i64.and (i64.shr_u (i64.reinterpret_f64 (local.get $oldProps)) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
              (i32.const ${PTR.HASH}))
          (then
            (local.set $root (global.get $__dyn_props))
            (if (f64.eq (local.get $root) (f64.const 0))
              (then (local.set $root (call $__hash_new))))
            (local.set $root (f64.reinterpret_i64 (call $__ihash_set_local
              (i64.reinterpret_f64 (local.get $root))
              (i64.reinterpret_f64 (f64.convert_i32_s (local.get $newOff)))
              (i64.reinterpret_f64 (local.get $oldProps)))))
            (global.set $__dyn_props (local.get $root)))))) ` : ''

export default (ctx) => {
  deps({
    __arr_idx: [],
    __arr_grow: arrayGrowDeps(false),
    __arr_grow_known: arrayGrowDeps(true),
    __arr_shift: () => [
      '__ptr_offset',
      ...(needsArrayDynMove() ? ['__dyn_move', '__hash_new', '__ihash_set_local'] : []),
    ],
    __arr_fill: ['__ptr_offset'],
    __arr_set_idx_ptr: ['__arr_grow', '__ptr_offset'],
    __arr_push1: ['__arr_grow_known', '__ptr_offset'],
    __arr_set_length: ['__arr_grow_known', '__ptr_offset', '__ptr_type'],
    __arr_unshift: ['__arr_grow', '__len', '__ptr_offset'],
    __arr_splice: ['__arr_grow', '__len', '__ptr_offset', '__alloc_hdr', '__mkptr'],
    __typed_idx: () => ctx.features.typedarray || ctx.features.external
      ? ['__len']
      : ['__len', '__ptr_offset'],
  })

  // Iteration methods (.map/.filter/.reduce/.forEach/...) invoke callbacks with
  // (item, idx) internally — closure width must accommodate arity 2 even if no
  // source-level closure has that arity.
  ctx.closure.floor = Math.max(ctx.closure.floor ?? 0, 2)

  inc('__ptr_offset', '__ptr_type', '__len', '__set_len', '__typed_idx', '__is_truthy')

  // Array.isArray(x): check ptr_type === PTR.ARRAY
  ctx.core.emit['Array.isArray'] = (x) => {
    const v = asF64(emit(x))
    const t = temp('t')
    return typed(['i32.and',
      ['f64.ne', ['local.tee', `$${t}`, v], ['local.get', `$${t}`]],
      ptrTypeEq(['local.get', `$${t}`], PTR.ARRAY)], 'i32')
  }

  ctx.core.emit['new.Array'] = (len) => {
    const n = tempI32('alen')
    const nIR = ['local.get', `$${n}`]
    // L3/'speed' bumps the cap floor to skip the first growth cycles (default 0
    // → grow on first push). Length stays exactly what the user requested.
    const minCap = ctx.transform.optimize?.arrayMinCap | 0
    const capIR = minCap > 0
      ? ['select', ['i32.const', minCap], nIR, ['i32.gt_s', ['i32.const', minCap], nIR]]
      : nIR
    const out = allocPtr({ type: PTR.ARRAY, len: nIR, cap: capIR, tag: 'newarr' })
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${n}`, len == null ? ['i32.const', 0] : asI32(emit(len))],
      out.init,
      out.ptr], 'f64')
  }

  // ARRAY-only indexed read. Inline forwarding-follow + bounds check + load — avoids
  // the redundant double pass through __len then __ptr_offset that both follow forwarding.
  ctx.core.stdlib['__arr_idx'] = `(func $__arr_idx (param $ptr i64) (param $i i32) (result f64)
    (local $off i32)
    (if (result f64)
      (i32.ne
        (i32.wrap_i64 (i64.and (i64.shr_u (local.get $ptr) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
        (i32.const ${PTR.ARRAY}))
      (then (f64.const nan:${UNDEF_NAN}))
      (else
        (local.set $off (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK}))))
        ${followForwardingWat('$off', { lowGuard: true })}
        (if (result f64)
          (i32.and
            (i32.ge_u (local.get $off) (i32.const 8))
            (i32.and
              (i32.ge_s (local.get $i) (i32.const 0))
              (i32.lt_u (local.get $i) (i32.load (i32.sub (local.get $off) (i32.const 8))))))
          (then (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))
          (else (f64.const nan:${UNDEF_NAN})))))) `

  ctx.core.stdlib['__arr_idx_known'] = `(func $__arr_idx_known (param $ptr i64) (param $i i32) (result f64)
    (local $off i32)
    (local.set $off (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK}))))
    ${followForwardingWat('$off', { lowGuard: true })}
    (if (result f64)
      (i32.and
        (i32.ge_u (local.get $off) (i32.const 8))
        (i32.and
          (i32.ge_s (local.get $i) (i32.const 0))
          (i32.lt_u (local.get $i) (i32.load (i32.sub (local.get $off) (i32.const 8))))))
      (then (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))
      (else (f64.const nan:${UNDEF_NAN}))))`

  // Runtime-dispatch index: element-type aware load with bounds check + view indirection.
  // Full body handles TYPED element types and view indirection since external host can
  // pass typed arrays even when typedarray module isn't loaded. When features.typedarray
  // and features.external are both off, collapses to ARRAY-only f64 indexing.
  ctx.core.stdlib['__typed_idx'] = () => {
    if (!ctx.features.typedarray && !ctx.features.external) {
      return `(func $__typed_idx (param $ptr i64) (param $i i32) (result f64)
    (local $len i32)
    (local.set $len (call $__len (local.get $ptr)))
    (if (result f64)
      (i32.or
        (i32.lt_s (local.get $i) (i32.const 0))
        (i32.ge_u (local.get $i) (local.get $len)))
      (then (f64.const nan:${UNDEF_NAN}))
      (else (f64.load (i32.add (call $__ptr_offset (local.get $ptr)) (i32.shl (local.get $i) (i32.const 3)))))))`
    }
    // Hot (~37M calls in watr self-host). Type/aux/offset extracted once from $ptr.
    return `(func $__typed_idx (param $ptr i64) (param $i i32) (result f64)
    (local $t i32) (local $off i32) (local $et i32) (local $len i32) (local $aux i32)
    (local.set $t (i32.wrap_i64 (i64.and (i64.shr_u (local.get $ptr) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    (local.set $off (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK}))))
    ;; ARRAY fast path: follow forwarding inline, bounds-check against header len, f64.load — no $__len call.
    (if (i32.and (i32.eq (local.get $t) (i32.const ${PTR.ARRAY})) (i32.ge_u (local.get $off) (i32.const 8)))
      (then
        ${followForwardingWat('$off', { lowGuard: false })}
        (return (if (result f64)
          (i32.and (i32.ge_s (local.get $i) (i32.const 0)) (i32.lt_u (local.get $i) (i32.load (i32.sub (local.get $off) (i32.const 8)))))
          (then (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))
          (else (f64.const nan:${UNDEF_NAN}))))))
    (local.set $aux (i32.wrap_i64 (i64.and (i64.shr_u (local.get $ptr) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK}))))
    (if
      (i32.and
        (i32.eq (local.get $t) (i32.const ${PTR.TYPED}))
        (i32.ne (i32.and (local.get $aux) (i32.const 8)) (i32.const 0)))
      (then (local.set $off (i32.load (i32.add (local.get $off) (i32.const 4))))))
    (local.set $len (call $__len (local.get $ptr)))
    (if (result f64)
      (i32.or
        (i32.lt_s (local.get $i) (i32.const 0))
        (i32.ge_u (local.get $i) (local.get $len)))
      (then (f64.const nan:${UNDEF_NAN}))
      (else
        (if (result f64) (i32.eq (local.get $t) (i32.const ${PTR.TYPED}))
          (then
            (local.set $et (i32.and (local.get $aux) (i32.const 7)))
            (if (result f64) (i32.ge_u (local.get $et) (i32.const 6))
              (then (if (result f64) (i32.eq (local.get $et) (i32.const 7))
                (then (if (result f64) (i32.and (local.get $aux) (i32.const 16))
                  (then (f64.reinterpret_i64 (i64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3))))))
                  (else (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))))
                (else (f64.promote_f32 (f32.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 2))))))))
              (else (if (result f64) (i32.ge_u (local.get $et) (i32.const 4))
                (then (if (result f64) (i32.and (local.get $et) (i32.const 1))
                  (then (f64.convert_i32_u (i32.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 2))))))
                  (else (f64.convert_i32_s (i32.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 2))))))))
                (else (if (result f64) (i32.ge_u (local.get $et) (i32.const 2))
                  (then (if (result f64) (i32.and (local.get $et) (i32.const 1))
                    (then (f64.convert_i32_u (i32.load16_u (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 1))))))
                    (else (f64.convert_i32_s (i32.load16_s (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 1))))))))
                  (else (if (result f64) (i32.and (local.get $et) (i32.const 1))
                    (then (f64.convert_i32_u (i32.load8_u (i32.add (local.get $off) (local.get $i)))))
                    (else (f64.convert_i32_s (i32.load8_s (i32.add (local.get $off) (local.get $i)))))))))))))
          (else (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))))))`
  }

  // Array.from(src) — shallow copy of array (memory.copy of f64 elements)
  ctx.core.stdlib['__arr_from'] = `(func $__arr_from (param $src i64) (result f64)
    (local $len i32) (local $dst i32)
    (local.set $len (call $__len (local.get $src)))
    (local.set $dst (call $__alloc_hdr (local.get $len) (local.get $len)))
    (memory.copy (local.get $dst) (call $__ptr_offset (local.get $src)) (i32.shl (local.get $len) (i32.const 3)))
    (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $dst)))`

  function arrayLikeLength(src) {
    if (!Array.isArray(src) || src[0] !== '{}') return null
    for (let i = 1; i < src.length; i++) {
      const prop = src[i]
      if (!Array.isArray(prop) || prop[0] !== ':') continue
      const key = typeof prop[1] === 'string' ? prop[1] : staticPropertyKey(prop[1])
      if (key === 'length') return prop[2]
    }
    return null
  }

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
    if (op === '{}' || op === 'str' || op === 'strcat' || op === '//') return true
    if (op === '[]' && n.length < 3) return true            // array literal
    if (op === '()' && n[1] === 'Symbol') return true       // Symbol(...) result
    return false                               // calls / member access — unknown
  }

  ctx.core.emit['Array.from'] = (src, mapFn) => {
    if (isUndefinedNode(mapFn)) mapFn = undefined
    else if (isNonCallableMapFn(mapFn)) {
      ctx.runtime.throws = true
      return typed(['block', ['result', 'f64'], ['throw', '$__jz_err', ['f64.const', 0]]], 'f64')
    }
    // Array.from(string) → array of single-char strings. The generic __arr_from
    // path memory.copies len*8 bytes from the string's byte storage (1 byte/char),
    // reading far past its end → OOB trap. Iterate __str_idx per char instead.
    if (resolveValType(src, valTypeOf, lookupValType) === VAL.STRING) {
      inc('__str_idx', '__str_len')
      const len = tempI32('sfl'), i = tempI32('sfi'), s = temp('sfs')
      const lenIR = ['local.get', `$${len}`]
      const out = allocPtr({ type: PTR.ARRAY, len: lenIR, tag: 'sfr' })
      const cb = mapFn && makeCallback(mapFn, [null, { val: VAL.NUMBER }])
      const ch = typed(['call', '$__str_idx', ['i64.reinterpret_f64', ['local.get', `$${s}`]], ['local.get', `$${i}`]], 'f64')
      const item = cb ? cb.call([ch, idxArg(cb, i)]) : ch
      const id = ctx.func.uniq++
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${s}`, asF64(emit(src))],
        ['local.set', `$${len}`, ['call', '$__str_len', ['i64.reinterpret_f64', ['local.get', `$${s}`]]]],
        out.init,
        ...(cb ? [cb.setup] : []),
        ['local.set', `$${i}`, ['i32.const', 0]],
        ['block', `$brk${id}`, ['loop', `$loop${id}`,
          ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${i}`], lenIR]],
          elemStore(out.local, i, asF64(item)),
          ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
          ['br', `$loop${id}`]]],
        out.ptr], 'f64')
    }
    const lengthExpr = arrayLikeLength(src)
    if (lengthExpr) {
      const len = tempI32('fl'), i = tempI32('fi')
      const lenIR = ['local.get', `$${len}`]
      const out = allocPtr({ type: PTR.ARRAY, len: lenIR, tag: 'fr' })
      const cb = mapFn && makeCallback(mapFn, [null, { val: VAL.NUMBER }])
      const undef = typed(['f64.reinterpret_i64', ['i64.const', UNDEF_NAN]], 'f64')
      const item = cb ? cb.call([undef, idxArg(cb, i)]) : undef
      const id = ctx.func.uniq++
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${len}`, asI32(emit(lengthExpr))],
        out.init,
        ...(cb ? [cb.setup] : []),
        ['local.set', `$${i}`, ['i32.const', 0]],
        ['block', `$brk${id}`, ['loop', `$loop${id}`,
          ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${i}`], lenIR]],
          elemStore(out.local, i, asF64(item)),
          ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
          ['br', `$loop${id}`]]],
        out.ptr], 'f64')
    }
    if (!mapFn) {
      inc('__arr_from')
      return typed(['call', '$__arr_from', asI64(emit(src))], 'f64')
    }
    // mapfn present: iterate the source array element by element, reading each
    // slot fresh inside the loop so a callback that mutates a not-yet-visited
    // source element sees its update (spec reads source[k] per step).
    inc('__len')
    const cb = makeCallback(mapFn, [null, { val: VAL.NUMBER }])
    const s = temp('afs'), len = tempI32('afl')
    const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${len}`], tag: 'aff' })
    const loop = arrayLoop(typed(['local.get', `$${s}`], 'f64'),
      (_p, _l, i, item) => [elemStore(out.local, i, asF64(cb.call([item, idxArg(cb, i)])))], len)
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${s}`, asF64(emit(src))],
      ['local.set', `$${len}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${s}`]]]],
      out.init,
      cb.setup,
      ...loop,
      out.ptr], 'f64')
  }

  // Grow array if capacity insufficient. Returns (possibly new) NaN-boxed pointer.
  // Old storage is left behind as a forwarding header so existing aliases keep
  // seeing the current backing store after growth. `defensive` adds a type/bounds
  // guard (non-array ptr → fresh 4-cap buffer) for untyped call sites; the `_known`
  // variant skips it for hot paths that already proved the receiver is an array.
  // Single source of truth: both stdlib entries share the grow/relocate tail.
  const arrGrow = (name, defensive) => `(func $${name} (param $ptr i64) (param $minCap i32) (result f64)
    ${defensive ? '(local $t i32) ' : ''}(local $off i32) (local $oldCap i32) (local $newCap i32) (local $newOff i32) (local $len i32)
    ${needsArrayDynMove() ? '(local $oldProps f64)' : ''}
    ${defensive ? `(local.set $t (call $__ptr_type (local.get $ptr)))
    (local.set $off (call $__ptr_offset (local.get $ptr)))
    ;; Defensive path: invalid/non-array pointer -> create fresh array buffer.
    (if
      (i32.or
        (i32.ne (local.get $t) (i32.const ${PTR.ARRAY}))
        (i32.lt_u (local.get $off) (i32.const 8)))
      (then
        (local.set $newCap (select (local.get $minCap) (i32.const 4) (i32.gt_s (local.get $minCap) (i32.const 4))))
        (local.set $newOff (call $__alloc_hdr (i32.const 0) (local.get $newCap)))
        (return (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $newOff)))))` : `(local.set $off (call $__ptr_offset (local.get $ptr)))`}
    (local.set $oldCap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (if (i32.ge_s (local.get $oldCap) (local.get $minCap))
      (then (return (f64.reinterpret_i64 (local.get $ptr)))))
    (local.set $newCap (select
      (local.get $minCap)
      (i32.shl (local.get $oldCap) (i32.const 1))
      (i32.gt_s (local.get $minCap) (i32.shl (local.get $oldCap) (i32.const 1)))))
    (local.set $len (i32.load (i32.sub (local.get $off) (i32.const 8))))
    (local.set $newOff (call $__alloc_hdr (local.get $len) (local.get $newCap)))
    (memory.copy (local.get $newOff) (local.get $off) (i32.shl (local.get $len) (i32.const 3)))
    ${headerPropsCopyIR()}
    ${maybeDynMoveIR()}
    (i32.store (i32.sub (local.get $off) (i32.const 8)) (local.get $newOff))
    (i32.store (i32.sub (local.get $off) (i32.const 4)) (i32.const -1))
    (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $newOff)))`

  ctx.core.stdlib['__arr_grow'] = () => arrGrow('__arr_grow', true)
  ctx.core.stdlib['__arr_grow_known'] = () => arrGrow('__arr_grow_known', false)

  // Hot for arr[i] = val (~18M calls in watr self-host). Compute base via __ptr_offset
  // once and read len from the inline header (i32.load base-8) — avoids __len's separate
  // forwarding follow. On the rare grow path the base is recomputed after relocation.
  ctx.core.stdlib['__arr_set_idx_ptr'] = `(func $__arr_set_idx_ptr (param $ptr i64) (param $i i32) (param $val f64) (result f64)
    (local $base i32) (local $p f64) (local $oldLen i32) (local $k i32)
    (local.set $p (f64.reinterpret_i64 (local.get $ptr)))
    (if (i32.lt_s (local.get $i) (i32.const 0))
      (then (return (local.get $p))))
    (local.set $base (call $__ptr_offset (local.get $ptr)))
    (local.set $oldLen (i32.load (i32.sub (local.get $base) (i32.const 8))))
    (if (i32.ge_u (local.get $i) (local.get $oldLen))
      (then
        (local.set $p (call $__arr_grow (local.get $ptr) (i32.add (local.get $i) (i32.const 1))))
        (local.set $base (call $__ptr_offset (i64.reinterpret_f64 (local.get $p))))
        (i32.store (i32.sub (local.get $base) (i32.const 8)) (i32.add (local.get $i) (i32.const 1)))
        ;; gap slots [oldLen, i) are holes — fill with undefined, not zero
        (local.set $k (local.get $oldLen))
        (block $fdone (loop $fill
          (br_if $fdone (i32.ge_u (local.get $k) (local.get $i)))
          (i64.store (i32.add (local.get $base) (i32.shl (local.get $k) (i32.const 3))) (i64.const ${UNDEF_NAN}))
          (local.set $k (i32.add (local.get $k) (i32.const 1)))
          (br $fill)))))
    (f64.store
      (i32.add (local.get $base) (i32.shl (local.get $i) (i32.const 3)))
      (local.get $val))
    (local.get $p))`

  // Out-of-line .push(val) for known-ARRAY receivers — keeps each call site to a
  // single call + var update instead of ~30 inlined instructions. Returns the
  // (possibly relocated) array pointer; caller derives the new length if needed.
  ctx.core.stdlib['__arr_push1'] = `(func $__arr_push1 (param $ptr i64) (param $val f64) (result f64)
    (local $p f64) (local $base i32) (local $len i32)
    (local.set $p (f64.reinterpret_i64 (local.get $ptr)))
    (local.set $base (call $__ptr_offset (local.get $ptr)))
    (local.set $len (i32.load (i32.sub (local.get $base) (i32.const 8))))
    (if (i32.lt_s (i32.load (i32.sub (local.get $base) (i32.const 4))) (i32.add (local.get $len) (i32.const 1)))
      (then
        (local.set $p (call $__arr_grow_known (local.get $ptr) (i32.add (local.get $len) (i32.const 1))))
        (local.set $base (call $__ptr_offset (i64.reinterpret_f64 (local.get $p))))))
    (f64.store (i32.add (local.get $base) (i32.shl (local.get $len) (i32.const 3))) (local.get $val))
    (i32.store (i32.sub (local.get $base) (i32.const 8)) (i32.add (local.get $len) (i32.const 1)))
    (local.get $p))`

  // arr.length = N. Truncation (N ≤ len) just rewrites the len word in place — no
  // relocation, so aliases keep their pointer. Growth past capacity relocates via
  // __arr_grow_known (old header forward-marked) and undefined-fills the new slots,
  // matching JS sparse-array semantics. Non-ARRAY receivers are left unchanged so a
  // mistyped `.length =` cannot corrupt object/collection headers. Returns the
  // (possibly relocated) pointer; the assignment's value is N (computed at the call site).
  ctx.core.stdlib['__arr_set_length'] = `(func $__arr_set_length (param $ptr i64) (param $n i32) (result f64)
    (local $base i32) (local $p f64) (local $oldLen i32) (local $cap i32) (local $k i32)
    (local.set $p (f64.reinterpret_i64 (local.get $ptr)))
    (if (i32.ne (call $__ptr_type (local.get $ptr)) (i32.const ${PTR.ARRAY}))
      (then (return (local.get $p))))
    (if (i32.lt_s (local.get $n) (i32.const 0)) (then (local.set $n (i32.const 0))))
    (local.set $base (call $__ptr_offset (local.get $ptr)))
    (if (i32.lt_u (local.get $base) (i32.const 8)) (then (return (local.get $p))))
    (local.set $oldLen (i32.load (i32.sub (local.get $base) (i32.const 8))))
    (local.set $cap (i32.load (i32.sub (local.get $base) (i32.const 4))))
    (if (i32.gt_s (local.get $n) (local.get $cap))
      (then
        (local.set $p (call $__arr_grow_known (local.get $ptr) (local.get $n)))
        (local.set $base (call $__ptr_offset (i64.reinterpret_f64 (local.get $p))))))
    (if (i32.gt_u (local.get $n) (local.get $oldLen))
      (then
        (local.set $k (local.get $oldLen))
        (block $fdone (loop $fill
          (br_if $fdone (i32.ge_u (local.get $k) (local.get $n)))
          (i64.store (i32.add (local.get $base) (i32.shl (local.get $k) (i32.const 3))) (i64.const ${UNDEF_NAN}))
          (local.set $k (i32.add (local.get $k) (i32.const 1)))
          (br $fill)))))
    (i32.store (i32.sub (local.get $base) (i32.const 8)) (local.get $n))
    (local.get $p))`

  // === Array literal ===

  ctx.core.emit['['] = (...elems) => {
    const hasSpread = elems.some(e => Array.isArray(e) && e[0] === '...')

    if (!hasSpread) {
      const len = elems.length
      // R: Static data segment for arrays of pure-literal elements (own-memory only).
      // Saves N×(alloc+store) instructions in __start; raw f64 bits embedded directly.
      if (len >= 4 && !ctx.memory.shared) {
        // asF64 folds i32.const → f64.const literally, so int-literal arrays also qualify.
        const slots = elems.map(e => extractF64Bits(asF64(emit(e))))
        if (slots.every(b => b !== null)) return staticArrayPtr(slots)
      }
      // L3/'speed' bumps the cap floor (default 4) to skip more growth cycles.
      const minCap = Math.max(ctx.transform.optimize?.arrayMinCap | 0, 4)
      const a = allocArray(len, Math.max(len, minCap))
      const body = [...a.setup]
      for (let i = 0; i < len; i++)
        body.push(['f64.store', slotAddr(a.local, i), asF64(emit(elems[i]))])
      body.push(a.ptr)
      return typed(['block', ['result', 'f64'], ...body], 'f64')
    }

    // Spread literal: spread pre-sums the total length, allocates
    // exact, and bulk-copies ARRAY sources with a single memory.copy — vs the
    // per-element __arr_set_idx_ptr grow loop. Normalise the parser's `['...', x]`.
    return spread(elems.map(e =>
      Array.isArray(e) && e[0] === '...' ? ['__spread', e[1]] : e))
  }

  // === Index read ===

  ctx.core.emit['[]'] = (arr, idx) => {
    // Hoist non-identifier arr so side-effecting sources (e.g. `foo.shift()[i]`) execute once.
    // The rest of the handler inlines `emit(arr)` into multiple IR positions, which would
    // otherwise re-execute the source expression per use at runtime.
    if (typeof arr !== 'string' && !(Array.isArray(arr) && arr[0] === 'local.get')) {
      const vtArr = valTypeOf(arr)
      const h = temp('ai')
      // Emit-time rep seed on fresh hoist-temp `h` so the recursive emit
      // below (`ctx.core.emit['[]'](h, idx)`) takes the typed-arr fast path.
      if (vtArr) updateRep(h, { val: vtArr })
      const setup = ['local.set', `$${h}`, asF64(emit(arr))]
      const result = ctx.core.emit['[]'](h, idx)
      return typed(['block', ['result', 'f64'], setup, asF64(result)], 'f64')
    }
    const keyType = typeof idx === 'string' ? lookupValType(idx) : valTypeOf(idx)
    const useRuntimeKeyDispatch = keyType == null || (typeof idx === 'string' && keyType !== VAL.STRING)
    // TypedArray: type-aware load
    if (typeof arr === 'string' && ctx.core.emit['.typed:[]'] &&
        lookupValType(arr) === 'typed') {
      const r = ctx.core.emit['.typed:[]'](arr, idx)
      if (r) return r
    }
    // Literal string key on schema-known object → direct payload slot read (skip __dyn_get)
    const litKey = isLiteralStr(idx) ? idx[1]
      : typeof arr === 'string' && lookupValType(arr) === VAL.OBJECT ? staticPropertyKey(idx)
      : null
    // SRoA flat object: `o['k']` → `local.get $o#i` (analyze.js scanFlatObjects).
    if (litKey != null && typeof arr === 'string' && ctx.func.flatObjects?.has(arr)) {
      const fo = ctx.func.flatObjects.get(arr)
      const fi = fo.names.indexOf(litKey)
      if (fi >= 0) return typed(['local.get', `$${arr}#${fi}`], 'f64')
    }
    if (litKey != null && typeof arr === 'string' && ctx.schema.find) {
      const slot = ctx.schema.find(arr, litKey)
      if (slot >= 0) {
        inc('__ptr_offset')
        return typed(ctx.abi.object.ops.load(['call', '$__ptr_offset', ['i64.reinterpret_f64', asF64(emit(arr))]], slot), 'f64')
      }
    }
    if (litKey != null && typeof arr === 'string' && lookupValType(arr) === VAL.HASH) {
      inc('__hash_get_local_h')
      return typed(['f64.reinterpret_i64', ['call', '$__hash_get_local_h', asI64(emit(arr)), asI64(emit(['str', litKey])), ['i32.const', strHashLiteral(litKey)]]], 'f64')
    }
    if (litKey != null && typeof arr !== 'string' && valTypeOf(arr) === VAL.HASH) {
      inc('__hash_get_local_h')
      return typed(['f64.reinterpret_i64', ['call', '$__hash_get_local_h', asI64(emit(arr)), asI64(emit(['str', litKey])), ['i32.const', strHashLiteral(litKey)]]], 'f64')
    }
    // Multi-value calls are materialized at call site (see '()' handler), so
    // func()[i] works naturally — func() returns a heap array pointer, [i] indexes it.
    const vt = typeof arr === 'string' ? lookupValType(arr) : valTypeOf(arr)
    const va = emit(arr), vi = asI32(emit(idx))
    const ptrExpr = asF64(va)
    const dynLoad = (objExpr, keyExpr) => {
      if (ctx.transform.strict) err(`strict mode: dynamic property access \`${typeof arr === 'string' ? arr : '<expr>'}[<expr>]\` falls back to __dyn_get. Use a literal key or known typed-array receiver, or pass { strict: false }.`)
      inc('__dyn_get')
      return ['f64.reinterpret_i64', ['call', '$__dyn_get', ['i64.reinterpret_f64', objExpr], ['i64.reinterpret_f64', keyExpr]]]
    }
    const stringLoad = () => (inc('__str_idx'), ['call', '$__str_idx', ['i64.reinterpret_f64', ptrExpr], vi])
    const arrayLoad = (['call', '$__typed_idx', ['i64.reinterpret_f64', ptrExpr], vi])
    const emitDynamicKeyDispatch = (objExpr, numericLoad) => {
      const keyTmp = temp()
      inc('__is_str_key')
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${keyTmp}`, asF64(emit(idx))],
        ['if', ['result', 'f64'], ['call', '$__is_str_key', ['i64.reinterpret_f64', ['local.get', `$${keyTmp}`]]],
          ['then', dynLoad(objExpr, ['local.get', `$${keyTmp}`])],
          ['else', numericLoad(['local.get', `$${keyTmp}`])]]], 'f64')
    }
    // Boxed object: string keys address the box, numeric keys address the inner array.
    if (typeof arr === 'string' && ctx.schema.isBoxed?.(arr)) {
      const inner = ctx.schema.emitInner(arr)
      if (keyType === VAL.STRING) return typed(dynLoad(asF64(emit(arr)), asF64(emit(idx))), 'f64')
      if (useRuntimeKeyDispatch)
        return emitDynamicKeyDispatch(asF64(emit(arr)), keyExpr =>
          ctx.abi.array.ops.load(['call', '$__ptr_offset', ['i64.reinterpret_f64', inner]], asI32(typed(keyExpr, 'f64'))))
      return typed(
        ctx.abi.array.ops.load(['call', '$__ptr_offset', ['i64.reinterpret_f64', inner]], vi),
        'f64')
    }
    // HASH receiver with runtime string key: probe the HASH directly via
    // __hash_get_local. Mirrors the literal-key path above but defers the
    // hash computation to runtime. When the key's val-type is unknown at
    // compile time, gate on __is_str_key — HASH has no numeric-key
    // semantics, so non-string keys return undef.
    if (vt === VAL.HASH) {
      if (keyType === VAL.STRING) {
        inc('__hash_get_local')
        return typed(['f64.reinterpret_i64', ['call', '$__hash_get_local', ['i64.reinterpret_f64', ptrExpr], asI64(emit(idx))]], 'f64')
      }
      if (useRuntimeKeyDispatch) {
        inc('__hash_get_local', '__is_str_key')
        const keyTmp = temp()
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${keyTmp}`, asF64(emit(idx))],
          ['if', ['result', 'f64'], ['call', '$__is_str_key', ['i64.reinterpret_f64', ['local.get', `$${keyTmp}`]]],
            ['then', ['f64.reinterpret_i64', ['call', '$__hash_get_local', ['i64.reinterpret_f64', ptrExpr], ['i64.reinterpret_f64', ['local.get', `$${keyTmp}`]]]]],
            ['else', undefExpr()]]], 'f64')
      }
    }
    // Known array → direct f64 element load, skip string check
    if (keyType === VAL.STRING)
      return typed(dynLoad(ptrExpr, asF64(emit(idx))), 'f64')
    if (vt === 'array') {
      // structInline Array<S>: element i is K consecutive inline f64 schema
      // cells — no per-row heap object, no stored element pointer. `arr[i]` is
      // the byte address of the element's first cell, returned as a first-class
      // unboxed OBJECT pointer (schema S); `arr[i].field` then composes a plain
      // `+field*8` off it. The narrower proved every use of this binding is one
      // structInline handles (src/analyze.js analyzeStructInline).
      const inlSid = inlineArraySid(arr)
      if (inlSid != null) {
        inc('__ptr_offset')
        const baseI32 = tempI32('ab')
        const K = ctx.schema.list[inlSid].length
        const cell = typed(structInline(K).ops.elemAddr(
          ['local.tee', `$${baseI32}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ptrExpr]]],
          vi), 'i32')
        cell.ptrKind = VAL.OBJECT
        cell.ptrAux = inlSid
        return cell
      }
      // Known-ARRAY → __arr_idx (single forwarding follow + inline bounds check),
      // not __typed_idx (which does __len + __ptr_offset = two forwarding follows
      // plus type-dispatch overhead irrelevant for plain arrays).
      const keyIsNum = keyType === VAL.NUMBER
      // Inline fast path: when arr has a known element schema and key is a
      // known number, the type-tag check and bounds check inside __arr_idx are
      // dead weight in hot kernels. Emit (f64.load (i32.add base (shl i 3)))
      // directly. base goes through __ptr_offset (still does forwarding follow),
      // and hoistAddrBase will CSE the (base, i) pair across the iteration body.
      // Array<NUMBER>/<STRING>/<OBJECT> all use 8-byte f64 slot layout — direct
      // f64.load is correct regardless of elem kind (returns raw f64 for NUMBER,
      // NaN-boxed pointer for OBJECT/STRING; downstream typed() handles both).
      // Fast path fires on schemaId (Array<{x,y,z}> shapes) OR plain elem-val
      // (Array<NUMBER> from `.map(x => x*k)` etc.) — both are proven facts from
      // the narrowing fixpoint (carried onto params via paramReps).
      const rep = typeof arr === 'string' ? ctx.func.localReps?.get(arr) : null
      const hasElemFact = rep?.arrayElemSchema != null || rep?.arrayElemValType != null
      // Take the unchecked inline load ONLY when the index is proven in-bounds by an
      // enclosing canonical loop `for (let i=C; i<arr.length; i++)`. Skipping the bounds
      // check on an arbitrary numeric index is unsound: `a[1]` on a length-1 array would
      // read the raw (uninitialized) cell instead of undefined. Constant / unproven
      // indices fall through to __arr_idx(_known) below, which bounds-checks → UNDEF_NAN.
      const idxProvenInBounds = hasElemFact && keyIsNum
        && typeof arr === 'string' && typeof idx === 'string'
        && inBoundsArrIdx(ctx).has(arr + '\x00' + idx)
      if (idxProvenInBounds) {
        inc('__ptr_offset')
        // __ptr_offset returns i32 — base local must be i32 (not the default
        // f64 NaN-box temp). Flat tee form so downstream peepholes can fold
        // `i32.wrap_i64 (i64.reinterpret_f64 (f64.load …))` → `i32.load …`
        // when this load feeds a ptrUnboxed OBJECT field.
        const baseI32 = tempI32('ab')
        return typed(ctx.abi.array.ops.load(
          ['local.tee', `$${baseI32}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ptrExpr]]],
          vi), 'f64')
      }
      // Known-elem array, numeric key, NOT proven in-bounds → inline bounds-checked
      // load: `idx < len ? load : undefined`. Same semantics as __arr_idx_known but
      // inline, so watr hoists the loop-invariant len load and CSEs the base — the
      // residual cost is a single (predictable) compare per access, not a call. Skipping
      // the check would read raw memory for OOB indices (e.g. `a[1]` on a length-1 array).
      if (hasElemFact && keyIsNum) {
        inc('__ptr_offset')
        const baseI32 = tempI32('ab'), idxI32 = tempI32('ai')
        return typed(['if', ['result', 'f64'],
          ['i32.lt_u',
            ['local.tee', `$${idxI32}`, vi],
            ['i32.load', ['i32.sub',
              ['local.tee', `$${baseI32}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ptrExpr]]],
              ['i32.const', 8]]]],
          ['then', ctx.abi.array.ops.load(['local.get', `$${baseI32}`], ['local.get', `$${idxI32}`])],
          ['else', undefExpr()]], 'f64')
      }
      const baseTmp = temp()
      // Numeric key (literal or known-NUMBER name) → skip __is_str_key dispatch;
      // arrays don't honor string-key access for numeric keys (keys aren't coerced
      // back to numbers for ARRAY index reads). Mirrors the VAL.TYPED branch below.
      if (useRuntimeKeyDispatch && !keyIsNum)
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${baseTmp}`, ptrExpr],
          emitDynamicKeyDispatch(typed(['local.get', `$${baseTmp}`], 'f64'), keyExpr => {
            const keyI32 = asI32(typed(keyExpr, 'f64'))
            inc('__arr_idx')
            return (['call', '$__arr_idx', ['i64.reinterpret_f64', ['local.get', `$${baseTmp}`]], keyI32])
          })], 'f64')
      inc('__arr_idx_known')
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${baseTmp}`, ptrExpr],
        (['call', '$__arr_idx_known', ['i64.reinterpret_f64', ['local.get', `$${baseTmp}`]], vi])], 'f64')
    }
    // Known string → single-char SSO string
    if (vt === 'string')
      return typed(stringLoad(), 'f64')
    // Known typed-array (ctor unknown — bimorphic call sites). Skip str-key dispatch
    // since arr is provably never a string. Inner __typed_idx still ctor-dispatches.
    // Key narrowing: if idx is provably NUMBER (via lookupValType on the name), the
    // str-key check is dead — emit the direct __typed_idx call. Other key shapes keep
    // the runtime str_key dispatch (rare for typed arrays but legal: arr['length']).
    if (vt === 'typed') {
      const keyIsNum = keyType === VAL.NUMBER
      if (useRuntimeKeyDispatch && !keyIsNum)
        return emitDynamicKeyDispatch(ptrExpr, keyExpr => {
          const keyI32 = asI32(typed(keyExpr, 'f64'))
          return (['call', '$__typed_idx', ['i64.reinterpret_f64', ptrExpr], keyI32])
        })
      return typed((['call', '$__typed_idx', ['i64.reinterpret_f64', ptrExpr], vi]), 'f64')
    }
    // Pure-write narrowing: an `xs[i] = v` / `xs.length = n` site in this
    // body, with no offsetting string-shape evidence (typeof string check,
    // STRING_ONLY method call, string-literal assignment), proves `arr` isn't
    // a primitive string. Skip the runtime `__ptr_type==STRING` gate —
    // `__typed_idx` already handles both ARRAY and TYPED tags internally.
    // Discharge analysis lives in src/infer.js (notStringEvidence source); flow-sensitive
    // notString refinements (from `if (typeof x === 'string') return ...`) overlay via lookup.
    const notString = typeof arr === 'string' && lookupNotString(arr)
    // A provably-NUMBER key can never be a string key, so the `__is_str_key`
    // dispatch is statically dead — its numeric arm is what runs. Fall through
    // to the direct ptr_type==STRING ? __str_idx : __typed_idx form below, which
    // indexes with the i32 `vi` and skips the per-element f64 round-trip + call.
    // Mirrors the `&& !keyIsNum` guard in the known-array/typed branches above.
    if (useRuntimeKeyDispatch && keyType !== VAL.NUMBER)
      return emitDynamicKeyDispatch(ptrExpr, keyExpr => {
        const keyI32 = asI32(typed(keyExpr, 'f64'))
        if (ctx.module.modules['string'] && !notString) {
          return ['if', ['result', 'f64'],
            ptrTypeEq(ptrExpr, PTR.STRING),
            ['then', (inc('__str_idx'), ['call', '$__str_idx', ['i64.reinterpret_f64', ptrExpr], keyI32])],
            ['else', (['call', '$__typed_idx', ['i64.reinterpret_f64', ptrExpr], keyI32])]]
        }
        return (['call', '$__typed_idx', ['i64.reinterpret_f64', ptrExpr], keyI32])
      })
    // Unknown → runtime dispatch (string module loaded → check ptr_type)
    if (ctx.module.modules['string'] && !notString)
      return typed(
        ['if', ['result', 'f64'],
          ptrTypeEq(ptrExpr, PTR.STRING),
          ['then', stringLoad()],
          ['else', arrayLoad]],
        'f64')
    return typed(arrayLoad, 'f64')
  }

  // === Push/Pop (mutate in place) ===

  // .push(val) → append, increment len, return array (possibly reallocated pointer)
  ctx.core.emit['.push'] = (arr, ...vals) => {
    // structInline Array<S>: `.push({S})` writes the K schema fields as K
    // consecutive f64 cells. Flatten the struct literal into K schema-ordered
    // field-value nodes and fall through to the general multi-value store path
    // — `len`/`cap` count physical cells, so `__arr_grow_known` and the cell
    // loop are reused untouched; `.push` then returns the logical element count
    // (`len / K`). K=1 stays a single value → the `__arr_push1` fast path.
    const inlSid = inlineArraySid(arr)
    const inlK = inlSid != null ? ctx.schema.list[inlSid].length : 0
    if (inlSid != null) {
      const flat = []
      for (const v of vals) {
        const fields = structLiteralFields(v, inlSid)
        if (!fields) err(`structInline Array.push expects { ${ctx.schema.list[inlSid].join(', ')} } literal arguments`)
        flat.push(...fields)
      }
      vals = flat
    }
    // Out-of-line fast path: single value, named known-ARRAY receiver. One call +
    // var update instead of ~30 inlined instructions — the dominant size cost of
    // push-heavy code (e.g. watr's WASM emitter).
    if (vals.length === 1 && typeof arr === 'string' && lookupValType(arr) === VAL.ARRAY) {
      inc('__arr_push1')
      const box = ctx.func.boxed?.get(arr)
      const isGlobal = !box && ctx.scope.globals.has(arr) && !ctx.func.locals?.has(arr)
      const readVar = box ? ['f64.load', ['local.get', `$${box}`]] : isGlobal ? ['global.get', `$${arr}`] : ['local.get', `$${arr}`]
      const writeVar = v => box ? ['f64.store', ['local.get', `$${box}`], v] : isGlobal ? ['global.set', `$${arr}`, v] : ['local.set', `$${arr}`, v]
      const vv = asF64(emit(vals[0]))
      return typed(['block', ['result', 'f64'],
        writeVar(['call', '$__arr_push1', ['i64.reinterpret_f64', readVar], vv]),
        ['f64.convert_i32_s', ['i32.load', ['i32.sub',
          ['call', '$__ptr_offset', ['i64.reinterpret_f64', readVar]], ['i32.const', 8]]]]], 'f64')
    }
    const va = asF64(emit(arr))
    const t = temp('pp'), len = tempI32('pl')

    // Known ARRAY → inline len as `i32.load(off - 8)` (ARRAY branch of __len). Saves a
    // full __ptr_type + dispatch per push site. The off<8 nullish guard in __len is
    // unreachable here: .push on a nullish var is a JS error before we get here.
    const vt = typeof arr === 'string' ? lookupValType(arr) : valTypeOf(arr)
    const inlineLen = vt === VAL.ARRAY
    const grow = inlineLen ? '__arr_grow_known' : '__arr_grow'
    inc(grow)

    const body = [
      ['local.set', `$${t}`, va],
    ]
    const pushBase = tempI32('pb')
    if (inlineLen) {
      // Hoist offset once; reuse for len load, cap-fits check, store base, and
      // post-grow rebase. On cap-fits (the common path) we skip __arr_grow's call
      // dispatch and prologue entirely; on grow we re-extract offset because the
      // alloc may have relocated the buffer.
      body.push(
        ['local.set', `$${pushBase}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
        ['local.set', `$${len}`,
          ['i32.load', ['i32.sub', ['local.get', `$${pushBase}`], ['i32.const', 8]]]],
        ['if',
          ['i32.lt_s',
            ['i32.load', ['i32.sub', ['local.get', `$${pushBase}`], ['i32.const', 4]]],
            ['i32.add', ['local.get', `$${len}`], ['i32.const', vals.length]]],
          ['then',
            ['local.set', `$${t}`, ['call', `$${grow}`, ['i64.reinterpret_f64', ['local.get', `$${t}`]],
              ['i32.add', ['local.get', `$${len}`], ['i32.const', vals.length]]]],
            ['local.set', `$${pushBase}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]]]],
      )
    } else {
      body.push(
        ['local.set', `$${len}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
        // Grow if needed: ensure cap >= len + vals.length
        ['local.set', `$${t}`, ['call', `$${grow}`, ['i64.reinterpret_f64', ['local.get', `$${t}`]],
          ['i32.add', ['local.get', `$${len}`], ['i32.const', vals.length]]]],
        ['local.set', `$${pushBase}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
      )
    }

    // Store each value and increment len
    for (const val of vals) {
      const vv = asF64(emit(val))
      body.push(
        ['f64.store',
          ['i32.add', ['local.get', `$${pushBase}`], ['i32.shl', ['local.get', `$${len}`], ['i32.const', 3]]],
          vv],
        ['local.set', `$${len}`, ['i32.add', ['local.get', `$${len}`], ['i32.const', 1]]]
      )
    }

    // Update length header (write directly via the offset we already hold —
    // skips __set_len's tag/forward dispatch), update source variable (pointer
    // may have changed from grow), return new length
    body.push(['i32.store', ['i32.sub', ['local.get', `$${pushBase}`], ['i32.const', 8]], ['local.get', `$${len}`]])
    // Update the source variable if it's a named variable (so arr still points to valid memory)
    if (typeof arr === 'string') {
      if (ctx.func.boxed?.has(arr)) {
        body.push(['f64.store', ['local.get', `$${ctx.func.boxed.get(arr)}`], ['local.get', `$${t}`]])
      }
      else if (ctx.scope.globals.has(arr) && !ctx.func.locals?.has(arr))
        body.push(['global.set', `$${arr}`, ['local.get', `$${t}`]])
      else
        body.push(['local.set', `$${arr}`, ['local.get', `$${t}`]])
    }
    // structInline: `len` counts physical cells — `.push` returns the JS array
    // length, i.e. the logical element count `len / K`.
    body.push(['f64.convert_i32_s', inlK > 1
      ? ['i32.div_s', ['local.get', `$${len}`], ['i32.const', inlK]]
      : ['local.get', `$${len}`]])

    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // .pop() → decrement len, return removed element
  ctx.core.emit['.pop'] = (arr) => {
    const va = asF64(emit(arr))
    const t = temp('po'), len = tempI32('pl')
    // Known ARRAY → inline len (skips __len dispatch tree).
    const vt = typeof arr === 'string' ? lookupValType(arr) : valTypeOf(arr)
    const rawLen = vt === VAL.ARRAY
      ? ['i32.load', ['i32.sub', ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]], ['i32.const', 8]]]
      : ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, va],
      ['local.set', `$${len}`, ['i32.sub', rawLen, ['i32.const', 1]]],
      ['call', '$__set_len', ['i64.reinterpret_f64', ['local.get', `$${t}`]], ['local.get', `$${len}`]],
      ['f64.load',
        ['i32.add', ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]], ['i32.shl', ['local.get', `$${len}`], ['i32.const', 3]]]]], 'f64')
  }

  // .shift() → remove first element, shift remaining left, return removed
  ctx.core.emit['.shift'] = (arr) => (inc('__arr_shift'),
    typed(['call', '$__arr_shift', asI64(emit(arr))], 'f64'))

  ctx.core.stdlib['__arr_shift'] = () => `(func $__arr_shift (param $arr i64) (result f64)
    (local $rawOff i32) (local $off i32) (local $newOff i32) (local $len i32) (local $cap i32) (local $val f64)
    ${needsArrayDynMove() ? '(local $oldProps f64) (local $root f64)' : ''}
    (local.set $rawOff (i32.wrap_i64 (i64.and (local.get $arr) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $off (call $__ptr_offset (local.get $arr)))
    (if (result f64) (i32.lt_u (local.get $off) (i32.const 8))
      (then (f64.const nan:${UNDEF_NAN}))
      (else
        (local.set $len (i32.load (i32.sub (local.get $off) (i32.const 8))))
        (if (result f64) (i32.le_s (local.get $len) (i32.const 0))
          (then (f64.const nan:${UNDEF_NAN}))
          (else
            (local.set $val (f64.load (local.get $off)))
            (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
            (local.set $newOff (i32.add (local.get $off) (i32.const 8)))
            ${headerPropsToGlobalIR()}
            (i32.store (local.get $off) (i32.sub (local.get $len) (i32.const 1)))
            (i32.store (i32.add (local.get $off) (i32.const 4))
              (select (i32.sub (local.get $cap) (i32.const 1)) (i32.const 0) (i32.gt_s (local.get $cap) (i32.const 0))))
            ${maybeDynMoveIR()}
            (i32.store (i32.sub (local.get $off) (i32.const 8)) (local.get $newOff))
            (i32.store (i32.sub (local.get $off) (i32.const 4)) (i32.const -1))
            (if (i32.and (i32.ne (local.get $rawOff) (local.get $off)) (i32.ge_u (local.get $rawOff) (i32.const 8)))
              (then
                (i32.store (i32.sub (local.get $rawOff) (i32.const 8)) (local.get $newOff))
                (i32.store (i32.sub (local.get $rawOff) (i32.const 4)) (i32.const -1))))
            (local.get $val))))))`

  // .fill(value, start?, end?) — overwrite [start, end) with value; mutate + return the
  // array. start/end default to 0 / length and accept negatives (offset from end). The
  // INT_MAX end sentinel clamps to length in the helper, which also normalizes negatives.
  ctx.core.emit['.fill'] = (arr, val, start, end) => {
    inc('__arr_fill')
    return typed(['call', '$__arr_fill',
      asI64(emit(arr)),
      val == null ? undefExpr() : asF64(emit(val)),
      start == null ? ['i32.const', 0] : asI32(emit(start)),
      end == null ? ['i32.const', 0x7FFFFFFF] : asI32(emit(end))], 'f64')
  }

  ctx.core.stdlib['__arr_fill'] = `(func $__arr_fill (param $arr i64) (param $val f64) (param $start i32) (param $end i32) (result f64)
    (local $off i32) (local $len i32) (local $i i32)
    (if (i32.eq
          (i32.wrap_i64 (i64.and (i64.shr_u (local.get $arr) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
          (i32.const ${PTR.ARRAY}))
      (then
        (local.set $off (call $__ptr_offset (local.get $arr)))
        (if (i32.ge_u (local.get $off) (i32.const 8))
          (then
            (local.set $len (i32.load (i32.sub (local.get $off) (i32.const 8))))
            (if (i32.lt_s (local.get $start) (i32.const 0)) (then (local.set $start (i32.add (local.get $len) (local.get $start)))))
            (if (i32.lt_s (local.get $start) (i32.const 0)) (then (local.set $start (i32.const 0))))
            (if (i32.gt_s (local.get $start) (local.get $len)) (then (local.set $start (local.get $len))))
            (if (i32.lt_s (local.get $end) (i32.const 0)) (then (local.set $end (i32.add (local.get $len) (local.get $end)))))
            (if (i32.lt_s (local.get $end) (i32.const 0)) (then (local.set $end (i32.const 0))))
            (if (i32.gt_s (local.get $end) (local.get $len)) (then (local.set $end (local.get $len))))
            (local.set $i (local.get $start))
            (block $done (loop $fill
              (br_if $done (i32.ge_s (local.get $i) (local.get $end)))
              (f64.store (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3))) (local.get $val))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $fill)))))))
    (f64.reinterpret_i64 (local.get $arr)))`

  // .splice(start) | .splice(start, deleteCount) → remove range, return removed as new array
  ctx.core.emit['.splice'] = (arr, start, deleteCount) => {
    const recv = hoistArrayValue(arr)
    const va = recv.value
    const vs = asI32(emit(start))
    const s = tempI32('sps'), cnt = tempI32('spc'), len = tempI32('spl'), off = tempI32('spo'), j = tempI32('spj')
    const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${cnt}`], tag: 'sp' })
    const id = ctx.func.uniq++
    // Known ARRAY → fuse len with offset (__len would re-compute __ptr_offset + dispatch).
    const svt = typeof arr === 'string' ? lookupValType(arr) : valTypeOf(arr)
    const lenInit = svt === VAL.ARRAY
      ? ['local.set', `$${len}`, ['i32.load', ['i32.sub', ['local.get', `$${off}`], ['i32.const', 8]]]]
      : ['local.set', `$${len}`, ['call', '$__len', ['i64.reinterpret_f64', va]]]
    const body = [
      recv.setup,
      ['local.set', `$${off}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', va]]],
      lenInit,
      // clamp start to [0, len]
      ['local.set', `$${s}`, vs],
      ['if', ['i32.lt_s', ['local.get', `$${s}`], ['i32.const', 0]],
        ['then',
          ['local.set', `$${s}`, ['i32.add', ['local.get', `$${s}`], ['local.get', `$${len}`]]],
          ['if', ['i32.lt_s', ['local.get', `$${s}`], ['i32.const', 0]],
            ['then', ['local.set', `$${s}`, ['i32.const', 0]]]]]],
      ['if', ['i32.gt_s', ['local.get', `$${s}`], ['local.get', `$${len}`]],
        ['then', ['local.set', `$${s}`, ['local.get', `$${len}`]]]],
      // compute count
      deleteCount === undefined
        ? ['local.set', `$${cnt}`, ['i32.sub', ['local.get', `$${len}`], ['local.get', `$${s}`]]]
        : ['block',
            ['local.set', `$${cnt}`, asI32(emit(deleteCount))],
            ['if', ['i32.lt_s', ['local.get', `$${cnt}`], ['i32.const', 0]],
              ['then', ['local.set', `$${cnt}`, ['i32.const', 0]]]],
            ['if', ['i32.gt_s',
                ['i32.add', ['local.get', `$${s}`], ['local.get', `$${cnt}`]],
                ['local.get', `$${len}`]],
              ['then', ['local.set', `$${cnt}`,
                ['i32.sub', ['local.get', `$${len}`], ['local.get', `$${s}`]]]]]],
      // allocate result array of size cnt
      out.init,
      // copy removed elements into new array
      ['memory.copy',
        ['local.get', `$${out.local}`],
        ['i32.add', ['local.get', `$${off}`], ['i32.shl', ['local.get', `$${s}`], ['i32.const', 3]]],
        ['i32.shl', ['local.get', `$${cnt}`], ['i32.const', 3]]],
      // shift remaining elements left: copy arr[s+cnt..len] → arr[s..]
      ['memory.copy',
        ['i32.add', ['local.get', `$${off}`], ['i32.shl', ['local.get', `$${s}`], ['i32.const', 3]]],
        ['i32.add', ['local.get', `$${off}`], ['i32.shl',
          ['i32.add', ['local.get', `$${s}`], ['local.get', `$${cnt}`]], ['i32.const', 3]]],
        ['i32.shl',
          ['i32.sub', ['i32.sub', ['local.get', `$${len}`], ['local.get', `$${s}`]], ['local.get', `$${cnt}`]],
          ['i32.const', 3]]],
      // update length (write directly via the offset we already hold)
      ['i32.store', ['i32.sub', ['local.get', `$${off}`], ['i32.const', 8]], ['i32.sub', ['local.get', `$${len}`], ['local.get', `$${cnt}`]]],
      out.ptr,
    ]
    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // .unshift(val) → prepend element, shift existing right
  ctx.core.emit['.unshift'] = (arr, val) => (inc('__arr_unshift'),
    typed(['call', '$__arr_unshift', asI64(emit(arr)), asF64(emit(val))], 'f64'))

  ctx.core.stdlib['__arr_unshift'] = `(func $__arr_unshift (param $arr i64) (param $val f64) (result f64)
    (local $off i32) (local $len i32) (local $a f64)
    (local.set $a (call $__arr_grow (local.get $arr) (i32.add (call $__len (local.get $arr)) (i32.const 1))))
    (local.set $off (call $__ptr_offset (i64.reinterpret_f64 (local.get $a))))
    (local.set $len (call $__len (i64.reinterpret_f64 (local.get $a))))
    (memory.copy
      (i32.add (local.get $off) (i32.const 8))
      (local.get $off)
      (i32.shl (local.get $len) (i32.const 3)))
    (f64.store (local.get $off) (local.get $val))
    (i32.store (i32.sub (local.get $off) (i32.const 8)) (i32.add (local.get $len) (i32.const 1)))
    (f64.convert_i32_s (i32.add (local.get $len) (i32.const 1))))`

  // .splice(start, deleteCount, ...items) with inserts → __arr_splice. Deletes
  // `del` elements at `s`, inserts the elements of `ins`, returns the removed
  // elements as a new array. Mutation is in place: a grow relocates the buffer
  // but leaves a forwarding pointer, so the caller's NaN-box still resolves —
  // no write-back needed (mirrors __arr_unshift). memory.copy is memmove, so the
  // tail shift is correct whether the array grew (shift right) or shrank (left).
  ctx.core.stdlib['__arr_splice'] = `(func $__arr_splice (param $arr i64) (param $start i32) (param $del i32) (param $ins i64) (result f64)
    (local $off i32) (local $len i32) (local $s i32) (local $cnt i32)
    (local $m i32) (local $newLen i32) (local $tail i32) (local $out f64) (local $a f64)
    (local.set $len (call $__len (local.get $arr)))
    (local.set $off (call $__ptr_offset (local.get $arr)))
    (local.set $s (local.get $start))
    (if (i32.lt_s (local.get $s) (i32.const 0))
      (then
        (local.set $s (i32.add (local.get $s) (local.get $len)))
        (if (i32.lt_s (local.get $s) (i32.const 0)) (then (local.set $s (i32.const 0))))))
    (if (i32.gt_s (local.get $s) (local.get $len)) (then (local.set $s (local.get $len))))
    (local.set $cnt (local.get $del))
    (if (i32.lt_s (local.get $cnt) (i32.const 0)) (then (local.set $cnt (i32.const 0))))
    (if (i32.gt_s (i32.add (local.get $s) (local.get $cnt)) (local.get $len))
      (then (local.set $cnt (i32.sub (local.get $len) (local.get $s)))))
    (local.set $m (call $__len (local.get $ins)))
    (local.set $newLen (i32.add (i32.sub (local.get $len) (local.get $cnt)) (local.get $m)))
    (local.set $tail (i32.sub (i32.sub (local.get $len) (local.get $s)) (local.get $cnt)))
    (local.set $out (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (call $__alloc_hdr (local.get $cnt) (local.get $cnt))))
    (memory.copy
      (call $__ptr_offset (i64.reinterpret_f64 (local.get $out)))
      (i32.add (local.get $off) (i32.shl (local.get $s) (i32.const 3)))
      (i32.shl (local.get $cnt) (i32.const 3)))
    (local.set $a (f64.reinterpret_i64 (local.get $arr)))
    (if (i32.gt_s (local.get $newLen) (local.get $len))
      (then (local.set $a (call $__arr_grow (local.get $arr) (local.get $newLen)))))
    (local.set $off (call $__ptr_offset (i64.reinterpret_f64 (local.get $a))))
    (memory.copy
      (i32.add (local.get $off) (i32.shl (i32.add (local.get $s) (local.get $m)) (i32.const 3)))
      (i32.add (local.get $off) (i32.shl (i32.add (local.get $s) (local.get $cnt)) (i32.const 3)))
      (i32.shl (local.get $tail) (i32.const 3)))
    (memory.copy
      (i32.add (local.get $off) (i32.shl (local.get $s) (i32.const 3)))
      (call $__ptr_offset (local.get $ins))
      (i32.shl (local.get $m) (i32.const 3)))
    (i32.store (i32.sub (local.get $off) (i32.const 8)) (local.get $newLen))
    (local.get $out))`

  // Early-exit callback iterator: init value, exit test, value on match.
  const earlyExitMethod = ({ tag, init, test, onMatch, reverse }) => (arr, fn) => {
    const recv = hoistArrayValue(arr)
    const r = temp(tag)
    const exit = `$exit${ctx.func.uniq++}`
    const cb = makeCallback(fn, callbackArgReps(arr))
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      ['if', test(cb, i, item),
        ['then', ['local.set', `$${r}`, onMatch(cb, i, item)], ['br', exit]]]
    ], undefined, undefined, reverse)
    return typed(['block', ['result', 'f64'],
      recv.setup,
      cb.setup,
      ['local.set', `$${r}`, init],
      ['block', exit, ...loop],
      ['local.get', `$${r}`]], 'f64')
  }

  ctx.core.emit['.some'] = earlyExitMethod({
    tag: 'sr',
    init: ['f64.const', 0],
    test: (cb, i, item) => truthyIR(cb.call([item, idxArg(cb, i)])),
    onMatch: () => ['f64.const', 1],
  })

  ctx.core.emit['.every'] = earlyExitMethod({
    tag: 'ev',
    init: ['f64.const', 1],
    test: (cb, i, item) => ['i32.eqz', truthyIR(cb.call([item, idxArg(cb, i)]))],
    onMatch: () => ['f64.const', 0],
  })

  ctx.core.emit['.findIndex'] = earlyExitMethod({
    tag: 'fi',
    init: ['f64.const', -1],
    test: (cb, i, item) => truthyIR(cb.call([item, idxArg(cb, i)])),
    onMatch: (_cb, i) => ['f64.convert_i32_s', ['local.get', `$${i}`]],
  })

  ctx.core.emit['.find'] = earlyExitMethod({
    tag: 'ff',
    init: ['f64.reinterpret_i64', ['i64.const', NULL_NAN]],
    test: (cb, i, item) => truthyIR(cb.call([item, idxArg(cb, i)])),
    onMatch: (_cb, _i, item) => item,
  })

  ctx.core.emit['.findLastIndex'] = earlyExitMethod({
    tag: 'fli',
    init: ['f64.const', -1],
    test: (cb, i, item) => truthyIR(cb.call([item, idxArg(cb, i)])),
    onMatch: (_cb, i) => ['f64.convert_i32_s', ['local.get', `$${i}`]],
    reverse: true,
  })

  ctx.core.emit['.findLast'] = earlyExitMethod({
    tag: 'fl',
    init: ['f64.reinterpret_i64', ['i64.const', NULL_NAN]],
    test: (cb, i, item) => truthyIR(cb.call([item, idxArg(cb, i)])),
    onMatch: (_cb, _i, item) => item,
    reverse: true,
  })

  // === Array methods ===

  // Fusion is only semantics-preserving when callbacks are side-effect-free.
  // A callback with calls or writes to outer state (e.g., `ctx.push(x)`) observes
  // the iteration order; fusing filter().forEach() would interleave them.
  // Conservative purity: no call-expressions (covers method calls, free fn calls);
  // no assignments to names not declared locally in the callback.
  function collectLocals(node, locals) {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') return
    if (op === 'let' || op === 'const' || op === 'var') {
      for (const a of args) if (Array.isArray(a) && a[0] === '=' && typeof a[1] === 'string') locals.add(a[1])
    }
    for (const a of args) collectLocals(a, locals)
  }
  function isPureCallback(fn) {
    if (!Array.isArray(fn) || fn[0] !== '=>') return false
    const params = new Set()
    for (const r of extractParams(fn[1])) {
      const p = classifyParam(r)
      if (p.name) params.add(p.name)
    }
    const locals = new Set(params)
    collectLocals(fn[2], locals)
    let pure = true
    ;(function walk(node) {
      if (!pure || !Array.isArray(node)) return
      const [op, ...args] = node
      if (op === '=>') return
      if (op === '()' || op === '?.()' || op === 'new') { pure = false; return }
      if (op === '++' || op === '--') { pure = false; return }
      if (ASSIGN_OPS.has(op)) {
        const t = args[0]
        if (typeof t === 'string') { if (!locals.has(t)) { pure = false; return } }
        else { pure = false; return }
      }
      for (const a of args) walk(a)
    })(fn[2])
    return pure
  }

  // Detect fuseable chain: arr.map(f).filter(g) etc.
  // Returns {source, method, fn} or null.
  function detectUpstream(arr) {
    if (!Array.isArray(arr) || arr[0] !== '()') return null
    const [, callee, ...callArgs] = arr
    if (!Array.isArray(callee) || callee[0] !== '.' || callArgs.length !== 1) return null
    const [, source, method] = callee
    if (method !== 'map' && method !== 'filter') return null
    if (!isPureCallback(callArgs[0])) return null
    return { source, method, fn: callArgs[0] }
  }

  function idxF64(i) { return typed(['f64.convert_i32_s', ['local.get', `$${i}`]], 'f64') }
  // Skip f64-convert when callback's index param is unused — saves per-iteration conversion.
  function idxArg(cb, i, slot = 1) {
    return cb.usedParams && !cb.usedParams[slot] ? null : idxF64(i)
  }

  ctx.core.emit['.map'] = (arr, fn) => {
    // .filter(f).map(g) → single loop: test f, apply g if passes
    const up = detectUpstream(arr)
    if (up && up.method === 'filter' && isPureCallback(fn)) {
      const recv = hoistArrayValue(up.source)
      const count = tempI32('fc'), maxLen = tempI32('fm'), base = tempI32('fb')
      const upReps = callbackArgReps(up.source)
      const filterCb = makeCallback(up.fn, upReps), mapCb = makeCallback(fn, upReps)
      const out = allocPtr({ type: PTR.ARRAY, len: 0, cap: ['local.get', `$${maxLen}`], tag: 'fm' })
      const loop = arrayLoop(recv.value, (_p, _l, i, item) => [
        ['if', truthyIR(filterCb.call([item, idxArg(filterCb, i)])),
          ['then',
            elemStore(out.local, count, asF64(mapCb.call([item, idxArg(mapCb, count)]))),
            ['local.set', `$${count}`, ['i32.add', ['local.get', `$${count}`], ['i32.const', 1]]]]]
      ], maxLen, base)
      inc('__ptr_offset')
      return typed(['block', ['result', 'f64'],
        recv.setup, filterCb.setup, mapCb.setup,
        ['local.set', `$${base}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', recv.value]]],
        ['local.set', `$${maxLen}`, arrayLenFromPtr(base)],
        out.init, ['local.set', `$${count}`, ['i32.const', 0]],
        ...loop,
        ['i32.store', ['i32.sub', ['local.get', `$${out.local}`], ['i32.const', 8]], ['local.get', `$${count}`]],
        out.ptr], 'f64')
    }
    const recv = hoistArrayValue(arr)
    const len = tempI32('ml'), base = tempI32('mb')
    const cb = makeCallback(fn, callbackArgReps(arr))
    const lenIR = ['local.get', `$${len}`]
    const out = allocPtr({ type: PTR.ARRAY, len: lenIR, tag: 'mo' })
    // Reuse the precomputed len local in arrayLoop (skip its internal load).
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      elemStore(out.local, i, asF64(cb.call([item, idxArg(cb, i)])))
    ], len, base)
    inc('__ptr_offset')
    return typed(['block', ['result', 'f64'],
      recv.setup,
      cb.setup,
      ['local.set', `$${base}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', recv.value]]],
      ['local.set', `$${len}`, arrayLenFromPtr(base)],
      out.init,
      ...loop,
      out.ptr], 'f64')
  }

  ctx.core.emit['.filter'] = (arr, fn) => {
    // .map(f).filter(g) → single loop: apply f, test g, store if passes
    const up = detectUpstream(arr)
    if (up && up.method === 'map' && isPureCallback(fn)) {
      const recv = hoistArrayValue(up.source)
      const count = tempI32('fc'), maxLen = tempI32('fm'), base = tempI32('fb'), mapped = temp('mv')
      const upReps = callbackArgReps(up.source)
      const mapCb = makeCallback(up.fn, upReps), filterCb = makeCallback(fn)
      const out = allocPtr({ type: PTR.ARRAY, len: 0, cap: ['local.get', `$${maxLen}`], tag: 'mf' })
      const loop = arrayLoop(recv.value, (_p, _l, i, item) => [
        ['local.set', `$${mapped}`, asF64(mapCb.call([item, idxArg(mapCb, i)]))],
        ['if', truthyIR(filterCb.call([typed(['local.get', `$${mapped}`], 'f64'), idxArg(filterCb, i)])),
          ['then',
            ['f64.store', ['i32.add', ['local.get', `$${out.local}`], ['i32.shl', ['local.get', `$${count}`], ['i32.const', 3]]], ['local.get', `$${mapped}`]],
            ['local.set', `$${count}`, ['i32.add', ['local.get', `$${count}`], ['i32.const', 1]]]]]
      ], maxLen, base)
      inc('__ptr_offset')
      return typed(['block', ['result', 'f64'],
        recv.setup, mapCb.setup, filterCb.setup,
        ['local.set', `$${base}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', recv.value]]],
        ['local.set', `$${maxLen}`, arrayLenFromPtr(base)],
        out.init, ['local.set', `$${count}`, ['i32.const', 0]],
        ...loop,
        ['i32.store', ['i32.sub', ['local.get', `$${out.local}`], ['i32.const', 8]], ['local.get', `$${count}`]],
        out.ptr], 'f64')
    }
    const recv = hoistArrayValue(arr)
    const count = tempI32('fc'), maxLen = tempI32('fm'), base = tempI32('fb')
    const cb = makeCallback(fn, callbackArgReps(arr))
    const out = allocPtr({ type: PTR.ARRAY, len: 0, cap: ['local.get', `$${maxLen}`], tag: 'fo' })
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      ['if', truthyIR(cb.call([item, idxArg(cb, i)])),
        ['then',
          ['f64.store', ['i32.add', ['local.get', `$${out.local}`], ['i32.shl', ['local.get', `$${count}`], ['i32.const', 3]]], item],
          ['local.set', `$${count}`, ['i32.add', ['local.get', `$${count}`], ['i32.const', 1]]]]]
    ], maxLen, base)
    inc('__ptr_offset')
    return typed(['block', ['result', 'f64'],
      recv.setup,
      cb.setup,
      ['local.set', `$${base}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', recv.value]]],
      ['local.set', `$${maxLen}`, arrayLenFromPtr(base)],
      out.init,
      ['local.set', `$${count}`, ['i32.const', 0]],
      ...loop,
      // Patch actual length into header (data start - 8).
      ['i32.store', ['i32.sub', ['local.get', `$${out.local}`], ['i32.const', 8]], ['local.get', `$${count}`]],
      out.ptr], 'f64')
  }

  ctx.core.emit['.reduce'] = (arr, fn, init) => {
    const up = detectUpstream(arr)
    // .map(f).reduce(g, init) → single loop: apply f, accumulate with g
    if (up && up.method === 'map') {
      const recv = hoistArrayValue(up.source)
      const acc = temp('ra'), mapped = temp('mv')
      const upReps = callbackArgReps(up.source)
      const mapCb = makeCallback(up.fn, upReps), redCb = makeCallback(fn)
      const loop = arrayLoop(recv.value, (_p, _l, i, item) => [
        ['local.set', `$${mapped}`, asF64(mapCb.call([item, idxArg(mapCb, i)]))],
        ['local.set', `$${acc}`, asF64(redCb.call([typed(['local.get', `$${acc}`], 'f64'), typed(['local.get', `$${mapped}`], 'f64')]))]
      ])
      return typed(['block', ['result', 'f64'],
        recv.setup, mapCb.setup, redCb.setup,
        ['local.set', `$${acc}`, init ? asF64(emit(init)) : ['f64.const', 0]],
        ...loop, ['local.get', `$${acc}`]], 'f64')
    }
    // .filter(f).reduce(g, init) → single loop: test f, accumulate with g if passes
    if (up && up.method === 'filter') {
      const recv = hoistArrayValue(up.source)
      const acc = temp('ra')
      const upReps = callbackArgReps(up.source)
      const filterCb = makeCallback(up.fn, upReps)
      // reduce cb signature: (acc, item, idx). Item rep mirrors upstream's item rep.
      const redCb = makeCallback(fn, [null, upReps[0], { val: VAL.NUMBER }])
      const loop = arrayLoop(recv.value, (_p, _l, i, item) => [
        ['if', truthyIR(filterCb.call([item, idxArg(filterCb, i)])),
          ['then', ['local.set', `$${acc}`, asF64(redCb.call([typed(['local.get', `$${acc}`], 'f64'), item]))]]]
      ])
      return typed(['block', ['result', 'f64'],
        recv.setup, filterCb.setup, redCb.setup,
        ['local.set', `$${acc}`, init ? asF64(emit(init)) : ['f64.const', 0]],
        ...loop, ['local.get', `$${acc}`]], 'f64')
    }
    const recv = hoistArrayValue(arr)
    const acc = temp('ra')
    // reduce cb signature: (acc, item, idx). Item rep mirrors recv's elem val type.
    const reps = callbackArgReps(arr)
    const cb = makeCallback(fn, [null, reps[0], { val: VAL.NUMBER }])
    const loop = arrayLoop(recv.value, (_ptr, _len, _i, item) => [
      ['local.set', `$${acc}`, asF64(cb.call([typed(['local.get', `$${acc}`], 'f64'), item]))]
    ])
    return typed(['block', ['result', 'f64'],
      recv.setup,
      cb.setup,
      ['local.set', `$${acc}`, init ? asF64(emit(init)) : ['f64.const', 0]],
      ...loop,
      ['local.get', `$${acc}`]], 'f64')
  }

  ctx.core.emit['.forEach'] = (arr, fn) => {
    // .map(f).forEach(g) → single loop: apply f, call g — no intermediate array
    const up = detectUpstream(arr)
    if (up && up.method === 'map' && isPureCallback(fn)) {
      const recv = hoistArrayValue(up.source)
      const mapped = temp('mv'), tmp = temp('ft')
      const upReps = callbackArgReps(up.source)
      const mapCb = makeCallback(up.fn, upReps), forCb = makeCallback(fn)
      const loop = arrayLoop(recv.value, (_p, _l, i, item) => [
        ['local.set', `$${mapped}`, asF64(mapCb.call([item, idxArg(mapCb, i)]))],
        ['local.set', `$${tmp}`, asF64(forCb.call([typed(['local.get', `$${mapped}`], 'f64'), idxArg(forCb, i)]))]
      ])
      return typed(['block', ['result', 'f64'], recv.setup, mapCb.setup, forCb.setup, ...loop, ['f64.const', 0]], 'f64')
    }
    if (up && up.method === 'filter') {
      const recv = hoistArrayValue(up.source)
      const tmp = temp('ft')
      const upReps = callbackArgReps(up.source)
      const filterCb = makeCallback(up.fn, upReps), forCb = makeCallback(fn, upReps)
      const loop = arrayLoop(recv.value, (_p, _l, i, item) => [
        ['if', truthyIR(filterCb.call([item, idxArg(filterCb, i)])),
          ['then', ['local.set', `$${tmp}`, asF64(forCb.call([item, idxArg(forCb, i)]))]]]
      ])
      return typed(['block', ['result', 'f64'], recv.setup, filterCb.setup, forCb.setup, ...loop, ['f64.const', 0]], 'f64')
    }
    const recv = hoistArrayValue(arr)
    const tmp = temp('ft')
    const cb = makeCallback(fn, callbackArgReps(arr))
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      ['local.set', `$${tmp}`, asF64(cb.call([item, idxArg(cb, i)]))]
    ])
    return typed(['block', ['result', 'f64'], recv.setup, cb.setup, ...loop, ['f64.const', 0]], 'f64')
  }

  // .reverse() → in-place swap arr[i] ↔ arr[len-1-i], returns the array.
  ctx.core.emit['.reverse'] = (arr) => {
    const recv = hoistArrayValue(arr)
    const arrTmp = temp('rv')
    const base = tempI32('rb')
    const len = tempI32('rl')
    const i = tempI32('ri')
    const j = tempI32('rj')
    const tmp = temp('rt')
    const id = ctx.func.uniq++
    const exit = `$revexit${id}`, loop = `$revloop${id}`

    inc('__ptr_offset')

    const addr = (idxIR) => ['i32.add', ['local.get', `$${base}`], ['i32.shl', idxIR, ['i32.const', 3]]]

    return typed(['block', ['result', 'f64'],
      recv.setup,
      ['local.set', `$${arrTmp}`, recv.value],
      ['local.set', `$${base}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${arrTmp}`]]]],
      ['local.set', `$${len}`, ['i32.load', ['i32.sub', ['local.get', `$${base}`], ['i32.const', 8]]]],
      ['local.set', `$${i}`, ['i32.const', 0]],
      ['local.set', `$${j}`, ['i32.sub', ['local.get', `$${len}`], ['i32.const', 1]]],
      ['block', exit,
        ['loop', loop,
          ['br_if', exit, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${j}`]]],
          ['local.set', `$${tmp}`, ['f64.load', addr(['local.get', `$${i}`])]],
          ['f64.store', addr(['local.get', `$${i}`]), ['f64.load', addr(['local.get', `$${j}`])]],
          ['f64.store', addr(['local.get', `$${j}`]), ['local.get', `$${tmp}`]],
          ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
          ['local.set', `$${j}`, ['i32.sub', ['local.get', `$${j}`], ['i32.const', 1]]],
          ['br', loop]]],
      ['local.get', `$${arrTmp}`]
    ], 'f64')
  }

  // Insertion sort — stable, in-place, O(n²). The comparator is called per
  // shift; positive return → swap. NaN returns become "no swap" via f64.gt's
  // IEEE 754 semantics (NaN compares false), matching the spec's NaN-as-0
  // behavior. When fn is omitted, elements are compared as strings via
  // __to_str → __str_cmp (byte-wise; NOT locale-aware).
  ctx.core.emit['.sort'] = (arr, fn) => {
    const recv = hoistArrayValue(arr)
    const arrTmp = temp('sr')
    const base = tempI32('sb')
    const len = tempI32('sl')
    const i = tempI32('si')
    const j = tempI32('sj')
    const cur = temp('sc')
    const neighbor = temp('sn')
    const id = ctx.func.uniq++
    const outerExit = `$sortexit${id}`, innerExit = `$sortinnerexit${id}`
    const outerLoop = `$sortouter${id}`, innerLoop = `$sortinner${id}`

    let cmpExpr, cmpSetup
    if (fn == null) {
      inc('__to_str', '__str_cmp')
      cmpExpr = (aIR, bIR) => typed(['f64.convert_i32_s',
        ['call', '$__str_cmp',
          ['call', '$__to_str', ['i64.reinterpret_f64', aIR]],
          ['call', '$__to_str', ['i64.reinterpret_f64', bIR]]
        ]
      ], 'f64')
      cmpSetup = ['nop']
    } else {
      const cb = makeCallback(fn, [])
      cmpSetup = cb.setup
      cmpExpr = (aIR, bIR) => asF64(cb.call([
        typed(aIR, 'f64'),
        typed(bIR, 'f64')
      ]))
    }

    inc('__ptr_offset')

    const addr = (idxIR) => ['i32.add', ['local.get', `$${base}`], ['i32.shl', idxIR, ['i32.const', 3]]]
    const jPlus1 = ['i32.add', ['local.get', `$${j}`], ['i32.const', 1]]

    return typed(['block', ['result', 'f64'],
      recv.setup,
      cmpSetup,
      ['local.set', `$${arrTmp}`, recv.value],
      ['local.set', `$${base}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${arrTmp}`]]]],
      ['local.set', `$${len}`, ['i32.load', ['i32.sub', ['local.get', `$${base}`], ['i32.const', 8]]]],

      ['local.set', `$${i}`, ['i32.const', 1]],
      ['block', outerExit,
        ['loop', outerLoop,
          ['br_if', outerExit, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
          ['local.set', `$${cur}`, ['f64.load', addr(['local.get', `$${i}`])]],
          ['local.set', `$${j}`, ['i32.sub', ['local.get', `$${i}`], ['i32.const', 1]]],

          ['block', innerExit,
            ['loop', innerLoop,
              ['br_if', innerExit, ['i32.lt_s', ['local.get', `$${j}`], ['i32.const', 0]]],
              ['local.set', `$${neighbor}`, ['f64.load', addr(['local.get', `$${j}`])]],
              // Break unless cmp(neighbor, cur) > 0. f64.gt is false for NaN.
              ['br_if', innerExit, ['i32.eqz',
                ['f64.gt',
                  cmpExpr(['local.get', `$${neighbor}`], ['local.get', `$${cur}`]),
                  ['f64.const', 0]]]],
              ['f64.store', addr(jPlus1), ['local.get', `$${neighbor}`]],
              ['local.set', `$${j}`, ['i32.sub', ['local.get', `$${j}`], ['i32.const', 1]]],
              ['br', innerLoop]]],

          ['f64.store', addr(jPlus1), ['local.get', `$${cur}`]],
          ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
          ['br', outerLoop]]],

      ['local.get', `$${arrTmp}`]
    ], 'f64')
  }

  // Boxed pointer values (strings/objects/etc.) carry NaN payloads, and
  // f64.eq treats NaN as not-equal to anything — even bit-identical NaN —
  // so a raw f64 compare misses string and reference matches. Route those
  // through __eq, the same helper `==` uses for STRING/BIGINT/cross-type.
  // f64.eq stays the fast path when the search value is statically NUMBER.
  const arrEqIR = (val) => {
    const vt = resolveValType(val, valTypeOf, lookupValType)
    if (vt === VAL.NUMBER) return (item, vv) => ['f64.eq', item, vv]
    inc('__eq')
    return (item, vv) => ['call', '$__eq', ['i64.reinterpret_f64', item], ['i64.reinterpret_f64', vv]]
  }

  ctx.core.emit['.indexOf'] = (arr, val) => {
    const recv = hoistArrayValue(arr)
    const vv = asF64(emit(val))
    const eq = arrEqIR(val)
    const result = tempI32('ix')
    const exit = `$exit${ctx.func.uniq++}`
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      ['if', eq(item, vv),
        ['then', ['local.set', `$${result}`, ['local.get', `$${i}`]], ['br', exit]]]
    ])
    return typed(['block', ['result', 'f64'],
      recv.setup,
      ['local.set', `$${result}`, ['i32.const', -1]],
      ['block', exit, ...loop],
      ['f64.convert_i32_s', ['local.get', `$${result}`]]], 'f64')
  }

  ctx.core.emit['.includes'] = (arr, val) => {
    const recv = hoistArrayValue(arr)
    const vv = asF64(emit(val))
    const eq = arrEqIR(val)
    const result = tempI32('ic')
    const exit = `$exit${ctx.func.uniq++}`
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      ['if', eq(item, vv),
        ['then', ['local.set', `$${result}`, ['i32.const', 1]], ['br', exit]]]
    ])
    return typed(['block', ['result', 'f64'],
      recv.setup,
      ['local.set', `$${result}`, ['i32.const', 0]],
      ['block', exit, ...loop],
      ['f64.convert_i32_s', ['local.get', `$${result}`]]], 'f64')
  }

  // .at(i) → array element with negative index support
  ctx.core.emit['.array:at'] = (arr, idx) => {
    const vt = typeof arr === 'string' ? lookupValType(arr) : valTypeOf(arr)
    if (vt === VAL.ARRAY) {
      inc('__ptr_offset')
      const t = tempI32('ai'), off = tempI32('ao')
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${off}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', asF64(emit(arr))]]],
        ['local.set', `$${t}`, asI32(emit(idx))],
        ['if', ['i32.lt_s', ['local.get', `$${t}`], ['i32.const', 0]],
          ['then', ['local.set', `$${t}`, ['i32.add', ['local.get', `$${t}`],
            ['i32.load', ['i32.sub', ['local.get', `$${off}`], ['i32.const', 8]]]]]]],
        ['f64.load', ['i32.add', ['local.get', `$${off}`],
          ['i32.shl', ['local.get', `$${t}`], ['i32.const', 3]]]]], 'f64')
    }
    const t = tempI32('ai'), a = temp('aa')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${a}`, asF64(emit(arr))],
      ['local.set', `$${t}`, asI32(emit(idx))],
      // Negative index: t += length
      ['if', ['i32.lt_s', ['local.get', `$${t}`], ['i32.const', 0]],
        ['then', ['local.set', `$${t}`, ['i32.add', ['local.get', `$${t}`],
          ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${a}`]]]]]]],
      ['f64.load', ['i32.add', ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${a}`]]],
        ['i32.shl', ['local.get', `$${t}`], ['i32.const', 3]]]]], 'f64')
  }
  ctx.core.emit['.at'] = ctx.core.emit['.array:at']

  ctx.core.emit['.slice'] = (arr, start, end) => {
    // BUFFER slice → byte-level copy handled in typedarray module.
    if (typeof arr === 'string') {
      const vt = lookupValType(arr)
      if (vt === 'buffer' && ctx.core.emit['.buf:slice']) return ctx.core.emit['.buf:slice'](arr, start, end)
    }
    const recv = hoistArrayValue(arr)
    const s = tempI32('ss'), e = tempI32('se'), len = tempI32('sl'), outLen = tempI32('sn'), ptr = tempI32('sp')
    const rawStart = start == null ? ['i32.const', 0] : asI32(emit(start))
    const rawEnd = end == null ? ['local.get', `$${len}`] : asI32(emit(end))
    const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${outLen}`], tag: 'so' })
    return typed(['block', ['result', 'f64'],
      recv.setup,
      ['local.set', `$${ptr}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', recv.value]]],
      ['local.set', `$${len}`, ['i32.load', ['i32.sub', ['local.get', `$${ptr}`], ['i32.const', 8]]]],
      ['local.set', `$${s}`, rawStart],
      ['if', ['i32.lt_s', ['local.get', `$${s}`], ['i32.const', 0]],
        ['then', ['local.set', `$${s}`, ['i32.add', ['local.get', `$${s}`], ['local.get', `$${len}`]]]]],
      ['if', ['i32.lt_s', ['local.get', `$${s}`], ['i32.const', 0]], ['then', ['local.set', `$${s}`, ['i32.const', 0]]]],
      ['if', ['i32.gt_s', ['local.get', `$${s}`], ['local.get', `$${len}`]], ['then', ['local.set', `$${s}`, ['local.get', `$${len}`]]]],
      ['local.set', `$${e}`, rawEnd],
      ['if', ['i32.lt_s', ['local.get', `$${e}`], ['i32.const', 0]],
        ['then', ['local.set', `$${e}`, ['i32.add', ['local.get', `$${e}`], ['local.get', `$${len}`]]]]],
      ['if', ['i32.lt_s', ['local.get', `$${e}`], ['i32.const', 0]], ['then', ['local.set', `$${e}`, ['i32.const', 0]]]],
      ['if', ['i32.gt_s', ['local.get', `$${e}`], ['local.get', `$${len}`]], ['then', ['local.set', `$${e}`, ['local.get', `$${len}`]]]],
      ['local.set', `$${outLen}`, ['i32.sub', ['local.get', `$${e}`], ['local.get', `$${s}`]]],
      ['if', ['i32.lt_s', ['local.get', `$${outLen}`], ['i32.const', 0]], ['then', ['local.set', `$${outLen}`, ['i32.const', 0]]]],
      out.init,
      ['memory.copy',
        ['local.get', `$${out.local}`],
        ['i32.add', ['local.get', `$${ptr}`], ['i32.shl', ['local.get', `$${s}`], ['i32.const', 3]]],
        ['i32.shl', ['local.get', `$${outLen}`], ['i32.const', 3]]],
      out.ptr], 'f64')
  }

  // .concat(...others) → concatenate arrays
  ctx.core.emit['.array:concat'] = (arr, ...others) => {
    const len = tempI32('len'), pos = tempI32('pos')
    const recv = hoistArrayValue(arr)
    const va = recv.value
    const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${len}`], tag: 'res' })
    const result = out.local

    // Calculate total length
    const body = [
      recv.setup,
      ['local.set', `$${len}`, ['call', '$__len', ['i64.reinterpret_f64', va]]],
    ]

    const otherVals = []
    for (const other of others) {
      const vo = asF64(emit(other))
      otherVals.push(vo)
      body.push(['local.set', `$${len}`, ['i32.add', ['local.get', `$${len}`], ['call', '$__len', ['i64.reinterpret_f64', vo]]]])
    }

    body.push(out.init)

    // Copy source array
    const srcOff = tempI32('co')
    body.push(
      ['local.set', `$${pos}`, ['i32.const', 0]],
      ['local.set', `$${len}`, ['call', '$__len', ['i64.reinterpret_f64', va]]],
      ['local.set', `$${srcOff}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', va]]]
    )
    const id = ctx.func.uniq++
    body.push(
      ['block', `$done${id}`, ['loop', `$loop${id}`,
        ['br_if', `$done${id}`, ['i32.ge_s', ['local.get', `$${pos}`], ['local.get', `$${len}`]]],
        ['f64.store',
          ['i32.add', ['local.get', `$${result}`], ['i32.shl', ['local.get', `$${pos}`], ['i32.const', 3]]],
          ['f64.load', ['i32.add', ['local.get', `$${srcOff}`], ['i32.shl', ['local.get', `$${pos}`], ['i32.const', 3]]]]],
        ['local.set', `$${pos}`, ['i32.add', ['local.get', `$${pos}`], ['i32.const', 1]]],
        ['br', `$loop${id}`]]]
    )

    // Copy each other array
    const offset = tempI32('off')
    body.push(['local.set', `$${offset}`, ['call', '$__len', ['i64.reinterpret_f64', va]]])

    const otherOff = tempI32('co2')
    for (let i = 0; i < otherVals.length; i++) {
      const vo = otherVals[i]
      const id2 = ctx.func.uniq++
      body.push(
        ['local.set', `$${pos}`, ['i32.const', 0]],
        ['local.set', `$${len}`, ['call', '$__len', ['i64.reinterpret_f64', vo]]],
        ['local.set', `$${otherOff}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', vo]]],
        ['block', `$done${id2}`, ['loop', `$loop${id2}`,
          ['br_if', `$done${id2}`, ['i32.ge_s', ['local.get', `$${pos}`], ['local.get', `$${len}`]]],
          ['f64.store',
            ['i32.add', ['local.get', `$${result}`], ['i32.shl', ['i32.add', ['local.get', `$${offset}`], ['local.get', `$${pos}`]], ['i32.const', 3]]],
            ['f64.load', ['i32.add', ['local.get', `$${otherOff}`], ['i32.shl', ['local.get', `$${pos}`], ['i32.const', 3]]]]],
          ['local.set', `$${pos}`, ['i32.add', ['local.get', `$${pos}`], ['i32.const', 1]]],
          ['br', `$loop${id2}`]]],
        ['local.set', `$${offset}`, ['i32.add', ['local.get', `$${offset}`], ['local.get', `$${len}`]]]
      )
    }

    body.push(out.ptr)
    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // .flat() → flatten one level of nested arrays
  ctx.core.stdlib['__arr_flat'] = `(func $__arr_flat (param $src i64) (result f64)
    (local $len i32) (local $off i32) (local $i i32) (local $total i32) (local $dst i32) (local $pos i32)
    (local $elem f64) (local $subLen i32) (local $subOff i32) (local $j i32)
    (local.set $off (call $__ptr_offset (local.get $src)))
    (local.set $len (call $__len (local.get $src)))
    ;; First pass: count total elements
    (local.set $total (i32.const 0)) (local.set $i (i32.const 0))
    (block $c1 (loop $cl1
      (br_if $c1 (i32.ge_s (local.get $i) (local.get $len)))
      (local.set $elem (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))
      (if (i32.and (f64.ne (local.get $elem) (local.get $elem))
        (i32.eq (call $__ptr_type (i64.reinterpret_f64 (local.get $elem))) (i32.const ${PTR.ARRAY})))
        (then (local.set $total (i32.add (local.get $total) (call $__len (i64.reinterpret_f64 (local.get $elem))))))
        (else (local.set $total (i32.add (local.get $total) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $cl1)))
    ;; Allocate result
    (local.set $dst (call $__alloc (i32.add (i32.const 8) (i32.shl (local.get $total) (i32.const 3)))))
    (i32.store (local.get $dst) (local.get $total))
    (i32.store (i32.add (local.get $dst) (i32.const 4)) (local.get $total))
    (local.set $dst (i32.add (local.get $dst) (i32.const 8)))
    ;; Second pass: copy
    (local.set $pos (i32.const 0)) (local.set $i (i32.const 0))
    (block $c2 (loop $cl2
      (br_if $c2 (i32.ge_s (local.get $i) (local.get $len)))
      (local.set $elem (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))
      (if (i32.and (f64.ne (local.get $elem) (local.get $elem))
        (i32.eq (call $__ptr_type (i64.reinterpret_f64 (local.get $elem))) (i32.const ${PTR.ARRAY})))
        (then
          (local.set $subOff (call $__ptr_offset (i64.reinterpret_f64 (local.get $elem))))
          (local.set $subLen (call $__len (i64.reinterpret_f64 (local.get $elem))))
          (local.set $j (i32.const 0))
          (block $s (loop $sl
            (br_if $s (i32.ge_s (local.get $j) (local.get $subLen)))
            (f64.store (i32.add (local.get $dst) (i32.shl (local.get $pos) (i32.const 3)))
              (f64.load (i32.add (local.get $subOff) (i32.shl (local.get $j) (i32.const 3)))))
            (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
            (local.set $j (i32.add (local.get $j) (i32.const 1)))
            (br $sl))))
        (else
          (f64.store (i32.add (local.get $dst) (i32.shl (local.get $pos) (i32.const 3))) (local.get $elem))
          (local.set $pos (i32.add (local.get $pos) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $cl2)))
    (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $dst)))`

  ctx.core.emit['.flat'] = (arr) => (inc('__arr_flat'),
    typed(['call', '$__arr_flat', asI64(emit(arr))], 'f64'))

  // .flatMap(fn) → map then flatten
  ctx.core.emit['.flatMap'] = (arr, fn) => {
    const mapped = ctx.core.emit['.map'](arr, fn)
    inc('__arr_flat')
    return typed(['call', '$__arr_flat', asI64(mapped)], 'f64')
  }

  // .join(sep) → concatenate array elements with separator string
  ctx.core.emit['.join'] = (arr, sep) => (inc('__str_join'),
    typed(['call', '$__str_join', asI64(emit(arr)), asI64(emit(sep == null ? ['str', ','] : sep))], 'f64'))
}
