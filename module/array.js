/**
 * Array module — literals, indexing, methods, push/pop.
 *
 * Type=1 (ARRAY): C-style header in memory.
 * Layout: [-8:len(i32)][-4:cap(i32)][elem0:f64, elem1:f64, ...]
 * offset points to elem0 (past header). len/cap mutable. Aliases see changes.
 *
 * @module array
 */

import { emit, typed, asF64, asI32, valTypeOf, lookupValType, VAL, NULL_NAN, UNDEF_NAN, temp, tempI32, allocPtr, extractParams, multiCount, materializeMulti, arrayLoop, elemLoad, elemStore, truthyIR, extractF64Bits, appendStaticSlots, mkPtrIR, slotAddr } from '../src/compile.js'
import { ctx, inc, err, PTR } from '../src/ctx.js'


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

// Check whether a name is referenced inside a pure expression body.
// Mirrors substExpr's traversal — skips property names on '.'/'?.' and object keys on ':'.
function exprUses(node, name) {
  if (typeof node === 'string') return node === name
  if (!Array.isArray(node)) return false
  const op = node[0]
  if (op === '.' || op === '?.') return exprUses(node[1], name)
  if (op === ':') return exprUses(node[2], name)
  for (let i = 1; i < node.length; i++) if (exprUses(node[i], name)) return true
  return false
}

// Callback factory: returns { setup, call, usedParams } where call(argExprs) emits the invocation.
// Fast path: literal arrow with simple-string params and pure expression body → inline,
// substituting param refs with fresh locals. Zero closure alloc, zero call_indirect, zero
// args-array alloc. Captures resolve naturally to outer locals.
// Slow path: fall back to ctx.closure.call (heap-allocated args array per iteration).
// usedParams: boolean array (fast path only) — callers can skip computing args for unused params.
function makeCallback(fn) {
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
          for (let i = 0; i < raw.length; i++) {
            if (!usedParams[i]) continue  // skip dead local + arg evaluation
            const fresh = temp('inl')
            mapping.set(raw[i], fresh)
            const ae = i < argExprs.length && argExprs[i] != null
              ? asF64(argExprs[i])
              : typed(['f64.reinterpret_i64', ['i64.const', UNDEF_NAN]], 'f64')
            stmts.push(['local.set', `$${fresh}`, ae])
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

// Factory for simple arr→call stdlib patterns (mirrors strMethod in string.js)
const arrMethod = (name, nArgs = 0) => (...args) => {
  inc(name)
  const call = ['call', `$${name}`, ...args.slice(0, nArgs + 1).map(a => asF64(emit(a)))]
  return typed(call, 'f64')
}

export default (ctx) => {
  Object.assign(ctx.core.stdlibDeps, {
    __arr_idx: [],
    __arr_grow: ['__dyn_move'],
    __arr_set_idx_ptr: ['__arr_grow', '__ptr_offset', '__set_len'],
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
      ['i32.eq', ['call', '$__ptr_type', ['local.get', `$${t}`]], ['i32.const', PTR.ARRAY]]], 'i32')
  }

  // ARRAY-only indexed read. Inline forwarding-follow + bounds check + load — avoids
  // the redundant double pass through __len then __ptr_offset that both follow forwarding.
  ctx.core.stdlib['__arr_idx'] = `(func $__arr_idx (param $ptr f64) (param $i i32) (result f64)
    (local $bits i64) (local $off i32)
    (local.set $bits (i64.reinterpret_f64 (local.get $ptr)))
    (if (result f64)
      (i32.ne
        (i32.wrap_i64 (i64.and (i64.shr_u (local.get $bits) (i64.const 47)) (i64.const 0xF)))
        (i32.const ${PTR.ARRAY}))
      (then (f64.const nan:${UNDEF_NAN}))
      (else
        (local.set $off (i32.wrap_i64 (i64.and (local.get $bits) (i64.const 0xFFFFFFFF))))
        (block $done
          (loop $follow
            (br_if $done (i32.lt_u (local.get $off) (i32.const 8)))
            (br_if $done (i32.gt_u (local.get $off) (i32.shl (memory.size) (i32.const 16))))
            (br_if $done (i32.ne (i32.load (i32.sub (local.get $off) (i32.const 4))) (i32.const -1)))
            (local.set $off (i32.load (i32.sub (local.get $off) (i32.const 8))))
            (br $follow)))
        (if (result f64)
          (i32.and
            (i32.ge_u (local.get $off) (i32.const 8))
            (i32.and
              (i32.ge_s (local.get $i) (i32.const 0))
              (i32.lt_u (local.get $i) (i32.load (i32.sub (local.get $off) (i32.const 8))))))
          (then (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))
          (else (f64.const nan:${UNDEF_NAN})))))) `

  // Runtime-dispatch index: element-type aware load with bounds check + view indirection.
  // Full body handles TYPED element types and view indirection since external host can
  // pass typed arrays even when typedarray module isn't loaded. When features.typedarray
  // and features.external are both off, collapses to ARRAY-only f64 indexing.
  ctx.core.stdlib['__typed_idx'] = () => {
    if (!ctx.features.typedarray && !ctx.features.external) {
      return `(func $__typed_idx (param $ptr f64) (param $i i32) (result f64)
    (local $len i32)
    (local.set $len (call $__len (local.get $ptr)))
    (if (result f64)
      (i32.or
        (i32.lt_s (local.get $i) (i32.const 0))
        (i32.ge_u (local.get $i) (local.get $len)))
      (then (f64.const nan:${UNDEF_NAN}))
      (else (f64.load (i32.add (call $__ptr_offset (local.get $ptr)) (i32.shl (local.get $i) (i32.const 3)))))))`
    }
    // Hot (~37M calls in watr self-host). Type/aux/offset extracted once from $bits.
    return `(func $__typed_idx (param $ptr f64) (param $i i32) (result f64)
    (local $bits i64) (local $t i32) (local $off i32) (local $et i32) (local $len i32) (local $aux i32)
    (local.set $bits (i64.reinterpret_f64 (local.get $ptr)))
    (local.set $t (i32.wrap_i64 (i64.and (i64.shr_u (local.get $bits) (i64.const 47)) (i64.const 0xF))))
    (local.set $aux (i32.wrap_i64 (i64.and (i64.shr_u (local.get $bits) (i64.const 32)) (i64.const 0x7FFF))))
    (local.set $off (i32.wrap_i64 (i64.and (local.get $bits) (i64.const 0xFFFFFFFF))))
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
                (then (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))
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
  ctx.core.stdlib['__arr_from'] = `(func $__arr_from (param $src f64) (result f64)
    (local $len i32) (local $dst i32)
    (local.set $len (call $__len (local.get $src)))
    (local.set $dst (call $__alloc_hdr (local.get $len) (local.get $len) (i32.const 8)))
    (memory.copy (local.get $dst) (call $__ptr_offset (local.get $src)) (i32.shl (local.get $len) (i32.const 3)))
    (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $dst)))`

  ctx.core.emit['Array.from'] = (src) => {
    inc('__arr_from')
    return typed(['call', '$__arr_from', asF64(emit(src))], 'f64')
  }

  // Grow array if capacity insufficient. Returns (possibly new) NaN-boxed pointer.
  // Old storage is left behind as a forwarding header so existing aliases keep
  // seeing the current backing store after growth.
  ctx.core.stdlib['__arr_grow'] = `(func $__arr_grow (param $ptr f64) (param $minCap i32) (result f64)
    (local $t i32) (local $off i32) (local $oldCap i32) (local $newCap i32) (local $newOff i32) (local $len i32)
    (local.set $t (call $__ptr_type (local.get $ptr)))
    (local.set $off (call $__ptr_offset (local.get $ptr)))
    ;; Defensive path: invalid/non-array pointer -> create fresh array buffer.
    (if
      (i32.or
        (i32.ne (local.get $t) (i32.const ${PTR.ARRAY}))
        (i32.lt_u (local.get $off) (i32.const 8)))
      (then
        (local.set $newCap (select (local.get $minCap) (i32.const 4) (i32.gt_s (local.get $minCap) (i32.const 4))))
        (local.set $newOff (call $__alloc_hdr (i32.const 0) (local.get $newCap) (i32.const 8)))
        (return (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $newOff)))))
    (local.set $oldCap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (if (i32.ge_s (local.get $oldCap) (local.get $minCap))
      (then (return (local.get $ptr))))
    (local.set $newCap (select
      (local.get $minCap)
      (i32.shl (local.get $oldCap) (i32.const 1))
      (i32.gt_s (local.get $minCap) (i32.shl (local.get $oldCap) (i32.const 1)))))
    (local.set $len (i32.load (i32.sub (local.get $off) (i32.const 8))))
    (local.set $newOff (call $__alloc_hdr (local.get $len) (local.get $newCap) (i32.const 8)))
    (memory.copy (local.get $newOff) (local.get $off) (i32.shl (local.get $len) (i32.const 3)))
    (call $__dyn_move (local.get $off) (local.get $newOff))
    (i32.store (i32.sub (local.get $off) (i32.const 8)) (local.get $newOff))
    (i32.store (i32.sub (local.get $off) (i32.const 4)) (i32.const -1))
    (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $newOff)))`

  // Hot for arr[i] = val (~18M calls in watr self-host). Compute base via __ptr_offset
  // once and read len from the inline header (i32.load base-8) — avoids __len's separate
  // forwarding follow. On the rare grow path the base is recomputed after relocation.
  ctx.core.stdlib['__arr_set_idx_ptr'] = `(func $__arr_set_idx_ptr (param $ptr f64) (param $i i32) (param $val f64) (result f64)
    (local $base i32)
    (if (i32.lt_s (local.get $i) (i32.const 0))
      (then (return (local.get $ptr))))
    (local.set $base (call $__ptr_offset (local.get $ptr)))
    (if (i32.ge_u (local.get $i)
                  (i32.load (i32.sub (local.get $base) (i32.const 8))))
      (then
        (local.set $ptr (call $__arr_grow (local.get $ptr) (i32.add (local.get $i) (i32.const 1))))
        (call $__set_len (local.get $ptr) (i32.add (local.get $i) (i32.const 1)))
        (local.set $base (call $__ptr_offset (local.get $ptr)))))
    (f64.store
      (i32.add (local.get $base) (i32.shl (local.get $i) (i32.const 3)))
      (local.get $val))
    (local.get $ptr))`

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
      const a = allocArray(len, Math.max(len, 4))  // min cap=4 for small pushes
      const body = [...a.setup]
      for (let i = 0; i < len; i++)
        body.push(['f64.store', slotAddr(a.local, i), asF64(emit(elems[i]))])
      body.push(a.ptr)
      return typed(['block', ['result', 'f64'], ...body], 'f64')
    }

    const a = allocArray(0, Math.max(elems.length, 4))
    const out = temp('sa'), pos = tempI32('sp')
    inc('__arr_set_idx_ptr')

    const body = [
      ...a.setup,
      ['local.set', `$${out}`, a.ptr],
      ['local.set', `$${pos}`, ['i32.const', 0]],
    ]

    for (const e of elems) {
      if (Array.isArray(e) && e[0] === '...') {
        const src = temp('ss'), slen = tempI32('sl'), si = tempI32('si')
        const id = ctx.func.uniq++
        const spreadVal = multiCount(e[1]) ? materializeMulti(e[1]) : asF64(emit(e[1]))
        const spreadItem = ctx.module.modules['string']
          ? ['if', ['result', 'f64'],
            ['i32.or',
              ['i32.eq', ['call', '$__ptr_type', ['local.get', `$${src}`]], ['i32.const', PTR.STRING]],
              ['i32.eq', ['call', '$__ptr_type', ['local.get', `$${src}`]], ['i32.const', PTR.SSO]]],
            ['then', (inc('__str_idx'), ['call', '$__str_idx', ['local.get', `$${src}`], ['local.get', `$${si}`]])],
            ['else', (['call', '$__typed_idx', ['local.get', `$${src}`], ['local.get', `$${si}`]])]]
          : (['call', '$__typed_idx', ['local.get', `$${src}`], ['local.get', `$${si}`]])

        body.push(
          ['local.set', `$${src}`, spreadVal],
          ['local.set', `$${slen}`, ['call', '$__len', ['local.get', `$${src}`]]],
          ['local.set', `$${si}`, ['i32.const', 0]],
          ['block', `$brk${id}`, ['loop', `$loop${id}`,
            ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${si}`], ['local.get', `$${slen}`]]],
            ['local.set', `$${out}`, ['call', '$__arr_set_idx_ptr', ['local.get', `$${out}`], ['local.get', `$${pos}`], spreadItem]],
            ['local.set', `$${pos}`, ['i32.add', ['local.get', `$${pos}`], ['i32.const', 1]]],
            ['local.set', `$${si}`, ['i32.add', ['local.get', `$${si}`], ['i32.const', 1]]],
            ['br', `$loop${id}`]]])
      } else {
        body.push(
          ['local.set', `$${out}`, ['call', '$__arr_set_idx_ptr', ['local.get', `$${out}`], ['local.get', `$${pos}`], asF64(emit(e))]],
          ['local.set', `$${pos}`, ['i32.add', ['local.get', `$${pos}`], ['i32.const', 1]]])
      }
    }

    body.push(['local.get', `$${out}`])
    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // === Index read ===

  ctx.core.emit['[]'] = (arr, idx) => {
    // Hoist non-identifier arr so side-effecting sources (e.g. `foo.shift()[i]`) execute once.
    // The rest of the handler inlines `emit(arr)` into multiple IR positions, which would
    // otherwise re-execute the source expression per use at runtime.
    if (typeof arr !== 'string' && !(Array.isArray(arr) && arr[0] === 'local.get')) {
      const vtArr = valTypeOf(arr)
      const h = temp('ai')
      if (vtArr) ctx.func.valTypes.set(h, vtArr)
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
    const litKey = Array.isArray(idx) && idx[0] === 'str' && typeof idx[1] === 'string' ? idx[1] : null
    if (litKey != null && typeof arr === 'string' && ctx.schema.find) {
      const slot = ctx.schema.find(arr, litKey)
      if (slot >= 0) {
        inc('__ptr_offset')
        return typed(['f64.load',
          ['i32.add', ['call', '$__ptr_offset', asF64(emit(arr))], ['i32.const', slot * 8]]], 'f64')
      }
    }
    // Multi-value calls are materialized at call site (see '()' handler), so
    // func()[i] works naturally — func() returns a heap array pointer, [i] indexes it.
    const vt = typeof arr === 'string' ? lookupValType(arr) : valTypeOf(arr)
    const va = emit(arr), vi = asI32(emit(idx))
    const ptrExpr = asF64(va)
    const dynLoad = (objExpr, keyExpr) => {
      if (ctx.transform.strict) err(`strict mode: dynamic property access \`${typeof arr === 'string' ? arr : '<expr>'}[<expr>]\` falls back to __dyn_get. Use a literal key or known typed-array receiver, or pass { strict: false }.`)
      inc('__dyn_get')
      return ['call', '$__dyn_get', objExpr, keyExpr]
    }
    const stringLoad = () => (inc('__str_idx'), ['call', '$__str_idx', ptrExpr, vi])
    const arrayLoad = (['call', '$__typed_idx', ptrExpr, vi])
    const emitDynamicKeyDispatch = (objExpr, numericLoad) => {
      const keyTmp = temp()
      inc('__is_str_key')
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${keyTmp}`, asF64(emit(idx))],
        ['if', ['result', 'f64'], ['call', '$__is_str_key', ['local.get', `$${keyTmp}`]],
          ['then', dynLoad(objExpr, ['local.get', `$${keyTmp}`])],
          ['else', numericLoad(['local.get', `$${keyTmp}`])]]], 'f64')
    }
    // Boxed object: string keys address the box, numeric keys address the inner array.
    if (typeof arr === 'string' && ctx.schema.isBoxed?.(arr)) {
      const inner = ctx.schema.emitInner(arr)
      if (keyType === VAL.STRING) return typed(dynLoad(asF64(emit(arr)), asF64(emit(idx))), 'f64')
      if (useRuntimeKeyDispatch)
        return emitDynamicKeyDispatch(asF64(emit(arr)), keyExpr =>
          ['f64.load', ['i32.add', ['call', '$__ptr_offset', inner], ['i32.shl', asI32(typed(keyExpr, 'f64')), ['i32.const', 3]]]])
      return typed(
        ['f64.load', ['i32.add', ['call', '$__ptr_offset', inner], ['i32.shl', vi, ['i32.const', 3]]]],
        'f64')
    }
    // Known array → direct f64 element load, skip string check
    if (keyType === VAL.STRING)
      return typed(dynLoad(ptrExpr, asF64(emit(idx))), 'f64')
    if (vt === 'array') {
      // Known-ARRAY → __arr_idx (single forwarding follow + inline bounds check),
      // not __typed_idx (which does __len + __ptr_offset = two forwarding follows
      // plus type-dispatch overhead irrelevant for plain arrays).
      inc('__arr_idx')
      const baseTmp = temp()
      return useRuntimeKeyDispatch
        ? typed(['block', ['result', 'f64'],
          ['local.set', `$${baseTmp}`, ptrExpr],
          emitDynamicKeyDispatch(typed(['local.get', `$${baseTmp}`], 'f64'), keyExpr => {
            const keyI32 = asI32(typed(keyExpr, 'f64'))
            return (['call', '$__arr_idx', ['local.get', `$${baseTmp}`], keyI32])
          })], 'f64')
        : typed(['block', ['result', 'f64'],
          ['local.set', `$${baseTmp}`, ptrExpr],
          (['call', '$__arr_idx', ['local.get', `$${baseTmp}`], vi])], 'f64')
    }
    // Known string → single-char SSO string
    if (vt === 'string')
      return typed(stringLoad(), 'f64')
    if (useRuntimeKeyDispatch)
      return emitDynamicKeyDispatch(ptrExpr, keyExpr => {
        const keyI32 = asI32(typed(keyExpr, 'f64'))
        if (ctx.module.modules['string']) {
          return ['if', ['result', 'f64'],
            ['i32.or',
              ['i32.eq', ['call', '$__ptr_type', ptrExpr], ['i32.const', PTR.STRING]],
              ['i32.eq', ['call', '$__ptr_type', ptrExpr], ['i32.const', PTR.SSO]]],
            ['then', (inc('__str_idx'), ['call', '$__str_idx', ptrExpr, keyI32])],
            ['else', (['call', '$__typed_idx', ptrExpr, keyI32])]]
        }
        return (['call', '$__typed_idx', ptrExpr, keyI32])
      })
    // Unknown → runtime dispatch (string module loaded → check ptr_type)
    if (ctx.module.modules['string'])
      return typed(
        ['if', ['result', 'f64'],
          ['i32.or',
            ['i32.eq', ['call', '$__ptr_type', ptrExpr], ['i32.const', PTR.STRING]],
            ['i32.eq', ['call', '$__ptr_type', ptrExpr], ['i32.const', PTR.SSO]]],
          ['then', stringLoad()],
          ['else', arrayLoad]],
        'f64')
    return typed(arrayLoad, 'f64')
  }

  // === Push/Pop (mutate in place) ===

  // .push(val) → append, increment len, return array (possibly reallocated pointer)
  ctx.core.emit['.push'] = (arr, ...vals) => {
    inc('__arr_grow')
    const va = asF64(emit(arr))
    const t = temp('pp'), len = tempI32('pl')

    // Known ARRAY → inline len as `i32.load(off - 8)` (ARRAY branch of __len). Saves a
    // full __ptr_type + dispatch per push site. The off<8 nullish guard in __len is
    // unreachable here: .push on a nullish var is a JS error before we get here.
    const vt = typeof arr === 'string' ? lookupValType(arr) : valTypeOf(arr)
    const inlineLen = vt === VAL.ARRAY

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
        ['local.set', `$${pushBase}`, ['call', '$__ptr_offset', ['local.get', `$${t}`]]],
        ['local.set', `$${len}`,
          ['i32.load', ['i32.sub', ['local.get', `$${pushBase}`], ['i32.const', 8]]]],
        ['if',
          ['i32.lt_s',
            ['i32.load', ['i32.sub', ['local.get', `$${pushBase}`], ['i32.const', 4]]],
            ['i32.add', ['local.get', `$${len}`], ['i32.const', vals.length]]],
          ['then',
            ['local.set', `$${t}`, ['call', '$__arr_grow', ['local.get', `$${t}`],
              ['i32.add', ['local.get', `$${len}`], ['i32.const', vals.length]]]],
            ['local.set', `$${pushBase}`, ['call', '$__ptr_offset', ['local.get', `$${t}`]]]]],
      )
    } else {
      body.push(
        ['local.set', `$${len}`, ['call', '$__len', ['local.get', `$${t}`]]],
        // Grow if needed: ensure cap >= len + vals.length
        ['local.set', `$${t}`, ['call', '$__arr_grow', ['local.get', `$${t}`],
          ['i32.add', ['local.get', `$${len}`], ['i32.const', vals.length]]]],
        ['local.set', `$${pushBase}`, ['call', '$__ptr_offset', ['local.get', `$${t}`]]],
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

    // Update length header, update source variable (pointer may have changed from grow), return new length
    body.push(['call', '$__set_len', ['local.get', `$${t}`], ['local.get', `$${len}`]])
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
    body.push(['f64.convert_i32_s', ['local.get', `$${len}`]])

    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // .pop() → decrement len, return removed element
  ctx.core.emit['.pop'] = (arr) => {
    const va = asF64(emit(arr))
    const t = temp('po'), len = tempI32('pl')
    // Known ARRAY → inline len (skips __len dispatch tree).
    const vt = typeof arr === 'string' ? lookupValType(arr) : valTypeOf(arr)
    const rawLen = vt === VAL.ARRAY
      ? ['i32.load', ['i32.sub', ['call', '$__ptr_offset', ['local.get', `$${t}`]], ['i32.const', 8]]]
      : ['call', '$__len', ['local.get', `$${t}`]]
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, va],
      ['local.set', `$${len}`, ['i32.sub', rawLen, ['i32.const', 1]]],
      ['call', '$__set_len', ['local.get', `$${t}`], ['local.get', `$${len}`]],
      ['f64.load',
        ['i32.add', ['call', '$__ptr_offset', ['local.get', `$${t}`]], ['i32.shl', ['local.get', `$${len}`], ['i32.const', 3]]]]], 'f64')
  }

  // .shift() → remove first element, shift remaining left, return removed
  ctx.core.emit['.shift'] = arrMethod('__arr_shift')

  ctx.core.stdlib['__arr_shift'] = `(func $__arr_shift (param $arr f64) (result f64)
    (local $off i32) (local $len i32) (local $val f64)
    (local.set $off (call $__ptr_offset (local.get $arr)))
    (local.set $len (call $__len (local.get $arr)))
    (if (result f64) (i32.le_s (local.get $len) (i32.const 0))
      (then (f64.const 0))
      (else
        (local.set $val (f64.load (local.get $off)))
        (memory.copy
          (local.get $off)
          (i32.add (local.get $off) (i32.const 8))
          (i32.shl (i32.sub (local.get $len) (i32.const 1)) (i32.const 3)))
        (call $__set_len (local.get $arr) (i32.sub (local.get $len) (i32.const 1)))
        (local.get $val))))`

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
      : ['local.set', `$${len}`, ['call', '$__len', va]]
    const body = [
      recv.setup,
      ['local.set', `$${off}`, ['call', '$__ptr_offset', va]],
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
      // update length
      ['call', '$__set_len', va, ['i32.sub', ['local.get', `$${len}`], ['local.get', `$${cnt}`]]],
      out.ptr,
    ]
    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // .unshift(val) → prepend element, shift existing right
  ctx.core.emit['.unshift'] = arrMethod('__arr_unshift', 1)

  ctx.core.stdlib['__arr_unshift'] = `(func $__arr_unshift (param $arr f64) (param $val f64) (result f64)
    (local $off i32) (local $len i32)
    (local.set $arr (call $__arr_grow (local.get $arr) (i32.add (call $__len (local.get $arr)) (i32.const 1))))
    (local.set $off (call $__ptr_offset (local.get $arr)))
    (local.set $len (call $__len (local.get $arr)))
    (memory.copy
      (i32.add (local.get $off) (i32.const 8))
      (local.get $off)
      (i32.shl (local.get $len) (i32.const 3)))
    (f64.store (local.get $off) (local.get $val))
    (call $__set_len (local.get $arr) (i32.add (local.get $len) (i32.const 1)))
    (f64.convert_i32_s (i32.add (local.get $len) (i32.const 1))))`

  // .some(fn) → return 1 if any element passes, else 0 (early exit)
  ctx.core.emit['.some'] = (arr, fn) => {
    const recv = hoistArrayValue(arr)
    const r = temp('sr')
    const exit = `$exit${ctx.func.uniq++}`
    const cb = makeCallback(fn)
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      ['if', truthyIR(cb.call([item, idxArg(cb, i)])),
        ['then', ['local.set', `$${r}`, ['f64.const', 1]], ['br', exit]]]
    ])
    return typed(['block', ['result', 'f64'],
      recv.setup,
      cb.setup,
      ['local.set', `$${r}`, ['f64.const', 0]],
      ['block', exit, ...loop],
      ['local.get', `$${r}`]], 'f64')
  }

  // .every(fn) → return 1 if all elements pass, else 0 (early exit)
  ctx.core.emit['.every'] = (arr, fn) => {
    const recv = hoistArrayValue(arr)
    const r = temp('ev')
    const exit = `$exit${ctx.func.uniq++}`
    const cb = makeCallback(fn)
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      ['if', ['i32.eqz', truthyIR(cb.call([item, idxArg(cb, i)]))],
        ['then', ['local.set', `$${r}`, ['f64.const', 0]], ['br', exit]]]
    ])
    return typed(['block', ['result', 'f64'],
      recv.setup,
      cb.setup,
      ['local.set', `$${r}`, ['f64.const', 1]],
      ['block', exit, ...loop],
      ['local.get', `$${r}`]], 'f64')
  }

  // .findIndex(fn) → return index of first matching element, or -1 (early exit)
  ctx.core.emit['.findIndex'] = (arr, fn) => {
    const recv = hoistArrayValue(arr)
    const r = temp('fi')
    const exit = `$exit${ctx.func.uniq++}`
    const cb = makeCallback(fn)
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      ['if', truthyIR(cb.call([item, idxArg(cb, i)])),
        ['then', ['local.set', `$${r}`, ['f64.convert_i32_s', ['local.get', `$${i}`]]], ['br', exit]]]
    ])
    return typed(['block', ['result', 'f64'],
      recv.setup,
      cb.setup,
      ['local.set', `$${r}`, ['f64.const', -1]],
      ['block', exit, ...loop],
      ['local.get', `$${r}`]], 'f64')
  }

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
    const body = fn[2]
    const params = new Set()
    const p = fn[1]
    const raw = p == null ? [] : Array.isArray(p) ? (p[0] === ',' ? p.slice(1) : p[0] === '()' ? (p[1] == null ? [] : Array.isArray(p[1]) && p[1][0] === ',' ? p[1].slice(1) : [p[1]]) : [p]) : [p]
    for (const r of raw) params.add(Array.isArray(r) && r[0] === '...' ? r[1] : typeof r === 'string' ? r : Array.isArray(r) && r[0] === '=' ? r[1] : null)
    const locals = new Set(params)
    collectLocals(body, locals)
    let pure = true
    ;(function walk(node) {
      if (!pure || !Array.isArray(node)) return
      const [op, ...args] = node
      if (op === '=>') return
      if (op === '()' || op === '?.()' || op === 'new') { pure = false; return }
      if (op === '++' || op === '--') { pure = false; return }
      if (op === '=' || op === '+=' || op === '-=' || op === '*=' || op === '/=' || op === '%=' || op === '&=' || op === '|=' || op === '^=' || op === '>>=' || op === '<<=' || op === '>>>=' || op === '||=' || op === '&&=' || op === '??=') {
        const t = args[0]
        if (typeof t === 'string') { if (!locals.has(t)) { pure = false; return } }
        else { pure = false; return }
      }
      for (const a of args) walk(a)
    })(body)
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
      const count = tempI32('fc'), maxLen = tempI32('fm')
      const filterCb = makeCallback(up.fn), mapCb = makeCallback(fn)
      const out = allocPtr({ type: PTR.ARRAY, len: 0, cap: ['local.get', `$${maxLen}`], tag: 'fm' })
      const loop = arrayLoop(recv.value, (_p, _l, i, item) => [
        ['if', truthyIR(filterCb.call([item, idxArg(filterCb, i)])),
          ['then',
            elemStore(out.local, count, asF64(mapCb.call([item, idxArg(mapCb, count)]))),
            ['local.set', `$${count}`, ['i32.add', ['local.get', `$${count}`], ['i32.const', 1]]]]]
      ], maxLen)
      return typed(['block', ['result', 'f64'],
        recv.setup, filterCb.setup, mapCb.setup,
        ['local.set', `$${maxLen}`, ['call', '$__len', recv.value]],
        out.init, ['local.set', `$${count}`, ['i32.const', 0]],
        ...loop,
        ['i32.store', ['i32.sub', ['local.get', `$${out.local}`], ['i32.const', 8]], ['local.get', `$${count}`]],
        out.ptr], 'f64')
    }
    const recv = hoistArrayValue(arr)
    const len = tempI32('ml')
    const cb = makeCallback(fn)
    const lenIR = ['local.get', `$${len}`]
    const out = allocPtr({ type: PTR.ARRAY, len: lenIR, tag: 'mo' })
    // Reuse the precomputed len local in arrayLoop (skip its internal load).
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      elemStore(out.local, i, asF64(cb.call([item, idxArg(cb, i)])))
    ], len)
    return typed(['block', ['result', 'f64'],
      recv.setup,
      cb.setup,
      ['local.set', `$${len}`, ['call', '$__len', recv.value]],
      out.init,
      ...loop,
      out.ptr], 'f64')
  }

  ctx.core.emit['.filter'] = (arr, fn) => {
    // .map(f).filter(g) → single loop: apply f, test g, store if passes
    const up = detectUpstream(arr)
    if (up && up.method === 'map' && isPureCallback(fn)) {
      const recv = hoistArrayValue(up.source)
      const count = tempI32('fc'), maxLen = tempI32('fm'), mapped = temp('mv')
      const mapCb = makeCallback(up.fn), filterCb = makeCallback(fn)
      const out = allocPtr({ type: PTR.ARRAY, len: 0, cap: ['local.get', `$${maxLen}`], tag: 'mf' })
      const loop = arrayLoop(recv.value, (_p, _l, i, item) => [
        ['local.set', `$${mapped}`, asF64(mapCb.call([item, idxArg(mapCb, i)]))],
        ['if', truthyIR(filterCb.call([typed(['local.get', `$${mapped}`], 'f64'), idxArg(filterCb, i)])),
          ['then',
            ['f64.store', ['i32.add', ['local.get', `$${out.local}`], ['i32.shl', ['local.get', `$${count}`], ['i32.const', 3]]], ['local.get', `$${mapped}`]],
            ['local.set', `$${count}`, ['i32.add', ['local.get', `$${count}`], ['i32.const', 1]]]]]
      ], maxLen)
      return typed(['block', ['result', 'f64'],
        recv.setup, mapCb.setup, filterCb.setup,
        ['local.set', `$${maxLen}`, ['call', '$__len', recv.value]],
        out.init, ['local.set', `$${count}`, ['i32.const', 0]],
        ...loop,
        ['i32.store', ['i32.sub', ['local.get', `$${out.local}`], ['i32.const', 8]], ['local.get', `$${count}`]],
        out.ptr], 'f64')
    }
    const recv = hoistArrayValue(arr)
    const count = tempI32('fc'), maxLen = tempI32('fm')
    const cb = makeCallback(fn)
    const out = allocPtr({ type: PTR.ARRAY, len: 0, cap: ['local.get', `$${maxLen}`], tag: 'fo' })
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      ['if', truthyIR(cb.call([item, idxArg(cb, i)])),
        ['then',
          ['f64.store', ['i32.add', ['local.get', `$${out.local}`], ['i32.shl', ['local.get', `$${count}`], ['i32.const', 3]]], item],
          ['local.set', `$${count}`, ['i32.add', ['local.get', `$${count}`], ['i32.const', 1]]]]]
    ], maxLen)
    return typed(['block', ['result', 'f64'],
      recv.setup,
      cb.setup,
      ['local.set', `$${maxLen}`, ['call', '$__len', recv.value]],
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
      const mapCb = makeCallback(up.fn), redCb = makeCallback(fn)
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
      const filterCb = makeCallback(up.fn), redCb = makeCallback(fn)
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
    const cb = makeCallback(fn)
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
      const mapCb = makeCallback(up.fn), forCb = makeCallback(fn)
      const loop = arrayLoop(recv.value, (_p, _l, i, item) => [
        ['local.set', `$${mapped}`, asF64(mapCb.call([item, idxArg(mapCb, i)]))],
        ['local.set', `$${tmp}`, asF64(forCb.call([typed(['local.get', `$${mapped}`], 'f64'), idxArg(forCb, i)]))]
      ])
      return typed(['block', ['result', 'f64'], recv.setup, mapCb.setup, forCb.setup, ...loop, ['f64.const', 0]], 'f64')
    }
    if (up && up.method === 'filter') {
      const recv = hoistArrayValue(up.source)
      const tmp = temp('ft')
      const filterCb = makeCallback(up.fn), forCb = makeCallback(fn)
      const loop = arrayLoop(recv.value, (_p, _l, i, item) => [
        ['if', truthyIR(filterCb.call([item, idxArg(filterCb, i)])),
          ['then', ['local.set', `$${tmp}`, asF64(forCb.call([item, idxArg(forCb, i)]))]]]
      ])
      return typed(['block', ['result', 'f64'], recv.setup, filterCb.setup, forCb.setup, ...loop, ['f64.const', 0]], 'f64')
    }
    const recv = hoistArrayValue(arr)
    const tmp = temp('ft')
    const cb = makeCallback(fn)
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      ['local.set', `$${tmp}`, asF64(cb.call([item, idxArg(cb, i)]))]
    ])
    return typed(['block', ['result', 'f64'], recv.setup, cb.setup, ...loop, ['f64.const', 0]], 'f64')
  }

  ctx.core.emit['.find'] = (arr, fn) => {
    const recv = hoistArrayValue(arr)
    const result = temp('ff')
    const exit = `$exit${ctx.func.uniq++}`
    const cb = makeCallback(fn)
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      ['if', truthyIR(cb.call([item, idxArg(cb, i)])),
        ['then', ['local.set', `$${result}`, item], ['br', exit]]]
    ])
    return typed(['block', ['result', 'f64'],
      recv.setup,
      cb.setup,
      ['local.set', `$${result}`, ['f64.reinterpret_i64', ['i64.const', NULL_NAN]]],
      ['block', exit, ...loop],
      ['local.get', `$${result}`]], 'f64')
  }

  ctx.core.emit['.indexOf'] = (arr, val) => {
    const recv = hoistArrayValue(arr)
    const vv = asF64(emit(val))
    const result = tempI32('ix')
    const exit = `$exit${ctx.func.uniq++}`
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      ['if', ['f64.eq', item, vv],
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
    const result = tempI32('ic')
    const exit = `$exit${ctx.func.uniq++}`
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      ['if', ['f64.eq', item, vv],
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
    const t = tempI32('ai'), a = temp('aa')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${a}`, asF64(emit(arr))],
      ['local.set', `$${t}`, asI32(emit(idx))],
      // Negative index: t += length
      ['if', ['i32.lt_s', ['local.get', `$${t}`], ['i32.const', 0]],
        ['then', ['local.set', `$${t}`, ['i32.add', ['local.get', `$${t}`],
          ['call', '$__len', ['local.get', `$${a}`]]]]]],
      ['f64.load', ['i32.add', ['call', '$__ptr_offset', ['local.get', `$${a}`]],
        ['i32.shl', ['local.get', `$${t}`], ['i32.const', 3]]]]], 'f64')
  }

  ctx.core.emit['.slice'] = (arr, start, end) => {
    // BUFFER slice → byte-level copy handled in typedarray module.
    if (typeof arr === 'string') {
      const vt = lookupValType(arr)
      if (vt === 'buffer' && ctx.core.emit['.buf:slice']) return ctx.core.emit['.buf:slice'](arr, start, end)
    }
    const recv = hoistArrayValue(arr)
    const vs = asI32(emit(start))
    const ve = end ? asI32(emit(end)) : ['call', '$__len', recv.value]
    const len = tempI32('sl'), j = tempI32('sj'), ptr = tempI32('sp')
    const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${len}`], tag: 'so' })
    const id = ctx.func.uniq++
    return typed(['block', ['result', 'f64'],
      recv.setup,
      ['local.set', `$${ptr}`, ['call', '$__ptr_offset', recv.value]],
      ['local.set', `$${len}`, ['i32.sub', ve, vs]],
      out.init,
      ['local.set', `$${j}`, ['i32.const', 0]],
      ['block', `$brk${id}`, ['loop', `$loop${id}`,
        ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${j}`], ['local.get', `$${len}`]]],
        ['f64.store',
          ['i32.add', ['local.get', `$${out.local}`], ['i32.shl', ['local.get', `$${j}`], ['i32.const', 3]]],
          ['f64.load', ['i32.add', ['local.get', `$${ptr}`], ['i32.shl', ['i32.add', vs, ['local.get', `$${j}`]], ['i32.const', 3]]]]],
        ['local.set', `$${j}`, ['i32.add', ['local.get', `$${j}`], ['i32.const', 1]]],
        ['br', `$loop${id}`]]],
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
      ['local.set', `$${len}`, ['call', '$__len', va]],
    ]

    const otherVals = []
    for (const other of others) {
      const vo = asF64(emit(other))
      otherVals.push(vo)
      body.push(['local.set', `$${len}`, ['i32.add', ['local.get', `$${len}`], ['call', '$__len', vo]]])
    }

    body.push(out.init)

    // Copy source array
    const srcOff = tempI32('co')
    body.push(
      ['local.set', `$${pos}`, ['i32.const', 0]],
      ['local.set', `$${len}`, ['call', '$__len', va]],
      ['local.set', `$${srcOff}`, ['call', '$__ptr_offset', va]]
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
    body.push(['local.set', `$${offset}`, ['call', '$__len', va]])

    const otherOff = tempI32('co2')
    for (let i = 0; i < otherVals.length; i++) {
      const vo = otherVals[i]
      const id2 = ctx.func.uniq++
      body.push(
        ['local.set', `$${pos}`, ['i32.const', 0]],
        ['local.set', `$${len}`, ['call', '$__len', vo]],
        ['local.set', `$${otherOff}`, ['call', '$__ptr_offset', vo]],
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
  ctx.core.stdlib['__arr_flat'] = `(func $__arr_flat (param $src f64) (result f64)
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
        (i32.eq (call $__ptr_type (local.get $elem)) (i32.const ${PTR.ARRAY})))
        (then (local.set $total (i32.add (local.get $total) (call $__len (local.get $elem)))))
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
        (i32.eq (call $__ptr_type (local.get $elem)) (i32.const ${PTR.ARRAY})))
        (then
          (local.set $subOff (call $__ptr_offset (local.get $elem)))
          (local.set $subLen (call $__len (local.get $elem)))
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

  ctx.core.emit['.flat'] = arrMethod('__arr_flat')

  // .flatMap(fn) → map then flatten
  ctx.core.emit['.flatMap'] = (arr, fn) => {
    // Desugar: arr.map(fn).flat()
    const mapped = ctx.core.emit['.map'](arr, fn)
    inc('__arr_flat')
    return typed(['call', '$__arr_flat', asF64(mapped)], 'f64')
  }

  // .join(sep) → concatenate array elements with separator string
  ctx.core.emit['.join'] = arrMethod('__str_join', 1)
}
