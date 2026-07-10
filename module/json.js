/**
 * JSON module — JSON.stringify and JSON.parse.
 *
 * stringify: recursive type-dispatch → string assembly in scratch buffer.
 * parse: recursive descent parser using globals for input position.
 * Objects parsed as Map (dynamic keys). Arrays as standard jz arrays.
 *
 * @module json
 */

import { typed, asF64, asI64, toStrI64, temp, tempI32, nullExpr, undefExpr, allocPtr, slotAddr, mkPtrIR, extractF64Bits, appendStaticSlots, NULL_WAT, UNDEF_NAN, UNDEF_WAT, FALSE_NAN, TRUE_NAN, FALSE_IR, TRUE_IR } from '../src/ir.js'
import { emit, bool, deps } from '../src/bridge.js'
import { valTypeOf } from '../src/kind.js'
import { T } from '../src/ast.js'
import { VAL } from '../src/reps.js'
import { err, inc, PTR, LAYOUT, declGlobal } from '../src/ctx.js'
import { strHashLiteral, heapResetWat } from './collection.js'

function jsonConstString(ctx, expr) {
  if (Array.isArray(expr) && expr[0] === 'str' && typeof expr[1] === 'string') return expr[1]
  if (Array.isArray(expr) && expr[0] == null && typeof expr[1] === 'string') return expr[1]
  if (typeof expr === 'string') return ctx.scope.constStrs?.get(expr) ?? null
  return null
}

// Sentinel distinct from any JS value `JSON.stringify` could hold (`undefined`
// is a legitimate literal — an array hole or a bare `undefined`).
const NOT_LIT = Symbol('not-literal')

// Evaluate a prepared AST node to its constant JS value, or NOT_LIT if any
// part is dynamic. Mirrors the literal grammar prepare produces: `[null, v]`
// for primitives, `['str', s]`, `['[' …]` arrays, `['{}' …]` objects.
function literalValue(node) {
  if (node === undefined) return undefined            // array hole
  if (!Array.isArray(node)) return NOT_LIT
  const op = node[0]
  if (op == null) return node[1]                      // number | string | bool | null | undefined
  if (op === 'str') return node[1]
  if (op === 'u-') { const v = literalValue(node[1]); return v === NOT_LIT ? NOT_LIT : -v }
  if (op === '[') {
    const arr = []
    for (let i = 1; i < node.length; i++) {
      const v = literalValue(node[i])
      if (v === NOT_LIT) return NOT_LIT
      arr.push(v)
    }
    return arr
  }
  if (op === '{}') {
    const obj = {}
    for (let i = 1; i < node.length; i++) {
      const e = node[i]
      if (!Array.isArray(e) || e[0] !== ':' || (typeof e[1] !== 'string' && typeof e[1] !== 'number')) return NOT_LIT
      const v = literalValue(e[2])
      if (v === NOT_LIT) return NOT_LIT
      obj[e[1]] = v
    }
    return obj
  }
  return NOT_LIT
}

// A BigInt has no JSON representation: `JSON.stringify` of a bigint — anywhere in
// the value graph — is a TypeError (ES JSON.stringify → SerializeJSONProperty).
// Detects it in a resolved literal value so the caller can emit the throw rather
// than handing the bigint to the host `JSON.stringify` (which crashes the fold).
const literalHasBigInt = (v) =>
  typeof v === 'bigint' ||
  (Array.isArray(v) ? v.some(literalHasBigInt)
    : !!v && typeof v === 'object' && Object.values(v).some(literalHasBigInt))

// Fold a literal AST node directly to its compact JSON string (no replacer /
// no space). Unlike the value-level `literalValue` + `JSON.stringify` path, this
// renders the self-host kernel boolean marker `['bool', 1|0]` as true/false:
// the value path can't, because jz carries a boolean as a 0/1 *number*, so the
// kernel's compile-time `JSON.stringify` of the folded value emits "1"/"0", not
// "true"/"false" (native folds via real JS booleans and is unaffected). Scalars
// delegate to the value path for exact number/string formatting; anything not
// cleanly renderable (undefined, holes, function/symbol) returns NOT_LIT so the
// caller falls back. Returns a JSON string or NOT_LIT.
function foldJsonStr(node) {
  if (!Array.isArray(node)) return NOT_LIT
  const op = node[0]
  // `['bool', carrier]` — prepare wraps the 0/1 carrier as a number-literal node
  // `[, 0|1]` on the kernel leg (bare number in native), so unwrap before testing.
  if (op === 'bool') {
    const c = Array.isArray(node[1]) ? node[1][1] : node[1]
    return c ? 'true' : 'false'
  }
  if (op === '[') {
    const parts = []
    for (let i = 1; i < node.length; i++) {
      const s = foldJsonStr(node[i])
      if (s === NOT_LIT) return NOT_LIT
      parts.push(s)
    }
    return '[' + parts.join(',') + ']'
  }
  if (op === '{}') {
    const parts = []
    for (let i = 1; i < node.length; i++) {
      const e = node[i]
      if (!Array.isArray(e) || e[0] !== ':' || (typeof e[1] !== 'string' && typeof e[1] !== 'number')) return NOT_LIT
      const s = foldJsonStr(e[2])
      if (s === NOT_LIT) return NOT_LIT
      parts.push(JSON.stringify(String(e[1])) + ':' + s)
    }
    return '{' + parts.join(',') + '}'
  }
  // Scalar (number / string / null / u-): exact formatting via the value path.
  const v = literalValue(node)
  if (v === NOT_LIT || typeof v === 'bigint') return NOT_LIT   // bigint ⇒ TypeError, not a literal string
  const s = JSON.stringify(v)
  return s === undefined ? NOT_LIT : s   // undefined/function/symbol — defer
}

function jsonShapeString(ctx, expr) {
  if (typeof expr === 'string') return ctx.scope.shapeStrs?.get(expr) ?? null
  return null
}

function jsonShapeStrings(ctx, expr) {
  const single = jsonShapeString(ctx, expr)
  if (single != null) return [single]
  if (Array.isArray(expr) && expr[0] === '[]' && typeof expr[1] === 'string') return ctx.scope.shapeStrArrays?.get(expr[1]) ?? null
  return null
}

function hashCapFor(n) {
  let cap = 8
  const need = Math.max(1, Math.ceil(n * 4 / 3))
  while (cap < need) cap <<= 1
  return cap
}

export default (ctx) => {
  deps({
    __stringify: ['__json_val', '__json_setgap', '__json_omit', '__jput', '__jput_str', '__jput_num', '__mkstr'],
    __json_setgap: ['__alloc', '__ptr_type', '__str_byteLen', '__char_at'],
    __json_omit: ['__ptr_type'],
    __json_enter: ['__alloc'],
    __jindent: ['__jput'],
    __json_val: ['__ptr_type', '__len', '__ptr_offset', '__jput', '__jindent', '__jput_num', '__jput_str', '__json_enter', '__json_leave', '__json_hash', '__json_obj'],
    __json_hash: ['__ptr_offset', '__jput', '__jindent', '__jput_str', '__json_omit', '__json_enter', '__json_leave', '__json_val', '__coll_order'],
    // Durable-receiver global-table merge (see __json_obj's body) pulls in
    // __ihash_get_local/__is_nullish only when collection.js's dyn-props
    // machinery is actually part of this build (mirrors array.js's
    // needsArrayDynMove-gated deps thunks) — a program that never writes a
    // dynamic prop anywhere never loads collection.js.
    __json_obj: () => ['__ptr_offset', '__ptr_aux', '__len', '__jput', '__jindent', '__jput_str', '__json_omit', '__json_enter', '__json_leave', '__json_val', '__coll_order',
      ...(ctx.scope.globals.has('__dyn_props') ? ['__ihash_get_local', '__is_nullish'] : [])],
    // Chain edges ($__jput_num → $__jput_str → $__jput): each body CALLS the
    // next stage; without the explicit edge they ride the auto-dep scan, which
    // silently yields nothing under self-host (test/selfhost-includes.js).
    __jput_num: ['__ftoa', '__jput_str'],
    __jput_str: ['__char_at', '__str_byteLen', '__jput'],
    __jp: ['__jp_val', '__jp_str', '__jp_num', '__jp_arr', '__jp_obj', '__sso_char', '__ptr_aux', '__ptr_type', '__ptr_offset', '__str_byteLen'],
    __jp_val: ['__jp_str', '__jp_num', '__jp_arr', '__jp_obj'],
    __jp_str: ['__sso_char', '__char_at', '__str_byteLen', '__hex4', '__ishex', '__utf8_enc', '__sso_norm'],
    __hex4: ['__hex1'],
    __jp_num: ['__pow10'],
    __jp_arr: ['__jp_val'],
    __jp_obj: ['__jp_val', '__jp_str', '__jp_schema_get', '__alloc_hdr', '__mkptr'],
    __jp_schema_get: ['__alloc', '__alloc_hdr', '__mkptr'],
  })

  // Emit a compile-time-known JSON value tree.
  //
  // Objects → fixed-shape OBJECT (schema-tagged, slot-based). Property reads
  // on the receiving binding compile to direct f64.load at the slot offset
  // (no hash probe, no key-string compare). Per-iter cost ≈ alloc + N stores
  // where N is the schema length, vs HASH's alloc + N hash_set_local_h calls.
  //
  // Arrays → ARRAY pointer with f64 element slots, same as before.
  //
  // For pure-numeric/literal trees (no nested objects with computed values),
  // the {...} static-data fast path in module/object.js would apply if we
  // routed through the same recognizer; for now we always alloc fresh per
  // call to preserve `JSON.parse(SRC); a.x = 7; b.x === original` semantics.
  function emitJsonConstValue(v) {
    if (v == null) return nullExpr()
    if (typeof v === 'number') return asF64(emit(v))
    if (typeof v === 'string') return asF64(emit(['str', v]))
    if (typeof v === 'boolean') return typed((v ? TRUE_IR : FALSE_IR).slice(), 'f64')
    if (Array.isArray(v)) {
      const a = allocPtr({ type: PTR.ARRAY, len: v.length, cap: Math.max(v.length, 4), tag: 'jarr' })
      const body = [a.init]
      for (let i = 0; i < v.length; i++) body.push(['f64.store', slotAddr(a.local, i), emitJsonConstValue(v[i])])
      body.push(a.ptr)
      return typed(['block', ['result', 'f64'], ...body], 'f64')
    }
    if (typeof v === 'object') {
      const keys = Object.keys(v)
      // Empty object: minimal OBJECT with no slots.
      if (keys.length === 0) {
        return mkPtrIR(PTR.OBJECT, 0, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', ctx.abi.object.ops.allocSlots(0)]])
      }
      const schemaId = ctx.schema.register(keys)
      const t = tempI32('jobj')
      const body = [
        ['local.set', `$${t}`, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', ctx.abi.object.ops.allocSlots(keys.length)]]],
      ]
      for (let i = 0; i < keys.length; i++) {
        body.push(ctx.abi.object.ops.store(['local.get', `$${t}`], i, asF64(emitJsonConstValue(v[keys[i]]))))
      }
      body.push(mkPtrIR(PTR.OBJECT, schemaId, ['local.get', `$${t}`]))
      return typed(['block', ['result', 'f64'], ...body], 'f64')
    }
    return asF64(emit(nullExpr))
  }


  // === JSON.stringify ===

  // Scratch buffer approach: __json_buf is a growable output buffer.
  // Functions append bytes to it, __json_pos tracks current write position.

  declGlobal('__jbuf', 'i32')
  declGlobal('__jpos', 'i32')
  declGlobal('__jcap', 'i32')
  declGlobal('__schema_tbl', 'i32')
  // Pretty-print state for the `space` argument. $__jgap points at the gap
  // string bytes ($__jgaplen of them); $__jdepth is the live nesting depth.
  // $__jgaplen == 0 ⇒ compact mode — every indent emission below is gated on
  // it, so the no-space path stays byte-identical to the unindented output.
  declGlobal('__jgap', 'i32')
  declGlobal('__jgaplen', 'i32')
  declGlobal('__jdepth', 'i32')
  // Cycle-detection stack: the i64 values of the containers currently open on
  // the recursion path. JSON.stringify of a structure that points back at an
  // ancestor must throw a TypeError. $__jstack is a lazily-allocated buffer of
  // up to 256 entries; $__jsp is the live depth.
  declGlobal('__jstack', 'i32')
  declGlobal('__jsp', 'i32')

  // __jput(byte: i32) — append one byte to output buffer
  ctx.core.stdlib['__jput'] = `(func $__jput (param $b i32)
    (local $new i32)
    (if (i32.ge_s (global.get $__jpos) (global.get $__jcap))
      (then
        (global.set $__jcap (i32.shl (i32.add (global.get $__jcap) (i32.const 1)) (i32.const 1)))
        (local.set $new (call $__alloc (global.get $__jcap)))
        (memory.copy (local.get $new) (global.get $__jbuf) (global.get $__jpos))
        (global.set $__jbuf (local.get $new))))
    (i32.store8 (i32.add (global.get $__jbuf) (global.get $__jpos)) (local.get $b))
    (global.set $__jpos (i32.add (global.get $__jpos) (i32.const 1))))`

  // __jindent — emit a newline followed by $__jdepth copies of the gap string.
  // No-op in compact mode ($__jgaplen == 0), so callers can invoke it
  // unconditionally and the unindented output stays exactly as before.
  ctx.core.stdlib['__jindent'] = `(func $__jindent
    (local $i i32) (local $j i32)
    (if (i32.eqz (global.get $__jgaplen)) (then (return)))
    (call $__jput (i32.const 10))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $i) (global.get $__jdepth)))
      (local.set $j (i32.const 0))
      (block $d2 (loop $l2
        (br_if $d2 (i32.ge_s (local.get $j) (global.get $__jgaplen)))
        (call $__jput (i32.load8_u (i32.add (global.get $__jgap) (local.get $j))))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $l2)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))`

  // __json_setgap(space: i64) — derive the indentation gap from the third
  // JSON.stringify argument. Number → min(10, ToInteger) spaces; String →
  // first min(10) code units; anything else → compact. Resets $__jdepth.
  ctx.core.stdlib['__json_setgap'] = `(func $__json_setgap (param $sp i64)
    (local $f f64) (local $n i32) (local $i i32) (local $g i32)
    (global.set $__jdepth (i32.const 0))
    (global.set $__jgaplen (i32.const 0))
    (local.set $f (f64.reinterpret_i64 (local.get $sp)))
    (if (f64.eq (local.get $f) (local.get $f))
      (then
        (local.set $n (i32.trunc_sat_f64_s (local.get $f)))
        (if (i32.gt_s (local.get $n) (i32.const 10)) (then (local.set $n (i32.const 10))))
        (if (i32.lt_s (local.get $n) (i32.const 1)) (then (return)))
        (local.set $g (call $__alloc (local.get $n)))
        (block $d (loop $l
          (br_if $d (i32.ge_s (local.get $i) (local.get $n)))
          (i32.store8 (i32.add (local.get $g) (local.get $i)) (i32.const 32))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $l)))
        (global.set $__jgap (local.get $g))
        (global.set $__jgaplen (local.get $n))
        (return)))
    (if (i32.eq (call $__ptr_type (local.get $sp)) (i32.const ${PTR.STRING}))
      (then
        (local.set $n (call $__str_byteLen (local.get $sp)))
        (if (i32.gt_s (local.get $n) (i32.const 10)) (then (local.set $n (i32.const 10))))
        (if (i32.eqz (local.get $n)) (then (return)))
        (local.set $g (call $__alloc (local.get $n)))
        (block $d (loop $l
          (br_if $d (i32.ge_s (local.get $i) (local.get $n)))
          (i32.store8 (i32.add (local.get $g) (local.get $i))
            (call $__char_at (local.get $sp) (local.get $i)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $l)))
        (global.set $__jgap (local.get $g))
        (global.set $__jgaplen (local.get $n)))))`

  // __jput_str(ptr: i64) — append string chars (without quotes) to buffer.
  // Per QuoteJSONString: every code unit U+0000..U+001F must be escaped — the
  // five with short forms (\b \t \n \f \r) plus \uXXXX for the rest.
  ctx.core.stdlib['__jput_str'] = `(func $__jput_str (param $ptr i64)
    (local $len i32) (local $i i32) (local $ch i32) (local $n i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $i) (local.get $len)))
      (local.set $ch (call $__char_at (local.get $ptr) (local.get $i)))
      ;; Escape special JSON chars
      (if (i32.lt_u (local.get $ch) (i32.const 32))
        (then
          (if (i32.eq (local.get $ch) (i32.const 10)) (then (call $__jput (i32.const 92)) (call $__jput (i32.const 110)))
          (else (if (i32.eq (local.get $ch) (i32.const 13)) (then (call $__jput (i32.const 92)) (call $__jput (i32.const 114)))
          (else (if (i32.eq (local.get $ch) (i32.const 9)) (then (call $__jput (i32.const 92)) (call $__jput (i32.const 116)))
          (else (if (i32.eq (local.get $ch) (i32.const 8)) (then (call $__jput (i32.const 92)) (call $__jput (i32.const 98)))
          (else (if (i32.eq (local.get $ch) (i32.const 12)) (then (call $__jput (i32.const 92)) (call $__jput (i32.const 102)))
          (else
            ;; \\u00XX — control char with no short escape
            (call $__jput (i32.const 92)) (call $__jput (i32.const 117))
            (call $__jput (i32.const 48)) (call $__jput (i32.const 48))
            (call $__jput (i32.add (i32.const 48) (i32.shr_u (local.get $ch) (i32.const 4))))
            (local.set $n (i32.and (local.get $ch) (i32.const 15)))
            (if (i32.ge_u (local.get $n) (i32.const 10))
              (then (call $__jput (i32.add (local.get $n) (i32.const 87))))
              (else (call $__jput (i32.add (local.get $n) (i32.const 48))))))))))))))))
        (else
          (if (i32.eq (local.get $ch) (i32.const 34)) (then (call $__jput (i32.const 92)) (call $__jput (i32.const 34)))
          (else (if (i32.eq (local.get $ch) (i32.const 92)) (then (call $__jput (i32.const 92)) (call $__jput (i32.const 92)))
            (else (call $__jput (local.get $ch))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))`

  // __jput_num(val: f64) — convert number to string, append bytes to buffer
  ctx.core.stdlib['__jput_num'] = `(func $__jput_num (param $val f64)
    (call $__jput_str (i64.reinterpret_f64 (call $__ftoa (local.get $val) (i32.const 0) (i32.const 0)))))`

  // __json_omit(val: i64) → i32 — 1 if the value serializes to nothing
  // (undefined or a function/CLOSURE). Per the JSON spec such values are
  // dropped from objects, rendered as null in arrays, and make a top-level
  // JSON.stringify return undefined.
  ctx.core.stdlib['__json_omit'] = `(func $__json_omit (param $val i64) (result i32)
    (local $f f64)
    (local.set $f (f64.reinterpret_i64 (local.get $val)))
    (if (f64.eq (local.get $f) (local.get $f)) (then (return (i32.const 0))))
    (if (i64.eq (local.get $val) (i64.const ${UNDEF_NAN})) (then (return (i32.const 1))))
    (i32.eq (call $__ptr_type (local.get $val)) (i32.const ${PTR.CLOSURE})))`

  // __json_enter(val: i64) — push a container onto the cycle stack, throwing a
  // TypeError ($__jz_err) if it is already an open ancestor (a circular ref).
  ctx.core.stdlib['__json_enter'] = `(func $__json_enter (param $val i64)
    (local $i i32) (local $st i32)
    (local.set $st (global.get $__jstack))
    (if (i32.eqz (local.get $st))
      (then
        (local.set $st (call $__alloc (i32.const 2048)))
        (global.set $__jstack (local.get $st))))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $i) (global.get $__jsp)))
      (if (i64.eq (i64.load (i32.add (local.get $st) (i32.shl (local.get $i) (i32.const 3)))) (local.get $val))
        (then (throw $__jz_err (f64.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    ;; A structure deeper than the buffer is treated as non-serializable.
    (if (i32.ge_s (global.get $__jsp) (i32.const 256)) (then (throw $__jz_err (f64.const 0))))
    (i64.store (i32.add (local.get $st) (i32.shl (global.get $__jsp) (i32.const 3))) (local.get $val))
    (global.set $__jsp (i32.add (global.get $__jsp) (i32.const 1))))`

  // __json_leave — pop the most recent container off the cycle stack.
  ctx.core.stdlib['__json_leave'] = `(func $__json_leave
    (global.set $__jsp (i32.sub (global.get $__jsp) (i32.const 1))))`

  // __json_val(val: i64) — stringify any value, append to buffer
  ctx.core.stdlib['__json_val'] = `(func $__json_val (param $val i64)
    (local $type i32) (local $len i32) (local $i i32) (local $off i32) (local $f f64)
    (local.set $f (f64.reinterpret_i64 (local.get $val)))
    ;; Number (not NaN) — but Infinity must be null per JSON spec
    (if (f64.eq (local.get $f) (local.get $f))
      (then
        (if (f64.eq (f64.abs (local.get $f)) (f64.const inf))
          (then
            (call $__jput (i32.const 110)) (call $__jput (i32.const 117))
            (call $__jput (i32.const 108)) (call $__jput (i32.const 108)) (return)))
        (call $__jput_num (local.get $f)) (return)))
    ;; NaN-boxed pointer
    (local.set $type (call $__ptr_type (local.get $val)))
    ;; Boolean atoms: FALSE_NAN / TRUE_NAN → "false" / "true"
    (if (i64.eq (local.get $val) (i64.const ${FALSE_NAN}))
      (then
        (call $__jput (i32.const 102)) (call $__jput (i32.const 97))
        (call $__jput (i32.const 108)) (call $__jput (i32.const 115))
        (call $__jput (i32.const 101)) (return)))
    (if (i64.eq (local.get $val) (i64.const ${TRUE_NAN}))
      (then
        (call $__jput (i32.const 116)) (call $__jput (i32.const 114))
        (call $__jput (i32.const 117)) (call $__jput (i32.const 101)) (return)))
    ;; Plain NaN (type=0) → null
    (if (i32.eqz (local.get $type))
      (then
        (call $__jput (i32.const 110)) (call $__jput (i32.const 117))
        (call $__jput (i32.const 108)) (call $__jput (i32.const 108)) (return)))
    ;; String
    (if (i32.eq (local.get $type) (i32.const ${PTR.STRING}))
      (then
        (call $__jput (i32.const 34))
        (call $__jput_str (local.get $val))
        (call $__jput (i32.const 34)) (return)))
    ;; Array
    (if (i32.eq (local.get $type) (i32.const ${PTR.ARRAY}))
      (then
        (call $__json_enter (local.get $val))
        (call $__jput (i32.const 91))  ;; [
        (local.set $len (call $__len (local.get $val)))
        (local.set $off (call $__ptr_offset (local.get $val)))
        (local.set $i (i32.const 0))
        ;; A non-empty array opens one indent level; an empty array stays compact.
        (if (i32.gt_s (local.get $len) (i32.const 0))
          (then (global.set $__jdepth (i32.add (global.get $__jdepth) (i32.const 1)))))
        (block $d (loop $l
          (br_if $d (i32.ge_s (local.get $i) (local.get $len)))
          (if (local.get $i) (then (call $__jput (i32.const 44))))  ;; ,
          (call $__jindent)
          (call $__json_val (i64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $l)))
        (if (i32.gt_s (local.get $len) (i32.const 0))
          (then
            (global.set $__jdepth (i32.sub (global.get $__jdepth) (i32.const 1)))
            (call $__jindent)))
        (call $__jput (i32.const 93))  ;; ]
        (call $__json_leave)
        (return)))
    ;; HASH/MAP — iterate entries: {"key":val,...}
    (if (i32.or (i32.eq (local.get $type) (i32.const ${PTR.HASH}))
                (i32.eq (local.get $type) (i32.const ${PTR.MAP})))
      (then (call $__json_hash (local.get $val)) (return)))
    ;; OBJECT — schema-based: iterate props with schema name table
    (if (i32.eq (local.get $type) (i32.const ${PTR.OBJECT}))
      (then (call $__json_obj (local.get $val)) (return)))
    ;; Unknown type → null
    (call $__jput (i32.const 110)) (call $__jput (i32.const 117))
    (call $__jput (i32.const 108)) (call $__jput (i32.const 108)))`

  // __json_hash(val: i64) — stringify HASH/MAP: emit {"key":val,...} in insertion
  // order. Slot layout: 24 bytes each — [hash:f64][key:f64][val:f64]. __coll_order
  // returns the n live slot offsets sorted by packed seq, matching the JS spec.
  ctx.core.stdlib['__json_hash'] = `(func $__json_hash (param $val i64)
    (local $off i32) (local $cap i32) (local $n i32) (local $i i32) (local $slot i32) (local $ord i32) (local $first i32) (local $pv i64)
    (local.set $off (call $__ptr_offset (local.get $val)))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $n (i32.load (i32.sub (local.get $off) (i32.const 8))))
    (local.set $ord (call $__coll_order (local.get $off) (local.get $cap) (i32.const 24)))
    (local.set $first (i32.const 1))
    (call $__json_enter (local.get $val))
    (call $__jput (i32.const 123))
    (global.set $__jdepth (i32.add (global.get $__jdepth) (i32.const 1)))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $i) (local.get $n)))
      (local.set $slot (i32.load (i32.add (local.get $ord) (i32.shl (local.get $i) (i32.const 2)))))
      (local.set $pv (i64.load (i32.add (local.get $slot) (i32.const 16))))
      (if (i32.eqz (call $__json_omit (local.get $pv)))
        (then
          (if (i32.eqz (local.get $first))
            (then (call $__jput (i32.const 44))))
          (local.set $first (i32.const 0))
          (call $__jindent)
          (call $__jput (i32.const 34))
          (call $__jput_str (i64.load (i32.add (local.get $slot) (i32.const 8))))
          (call $__jput (i32.const 34))
          (call $__jput (i32.const 58))
          (if (global.get $__jgaplen) (then (call $__jput (i32.const 32))))
          (call $__json_val (local.get $pv))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (global.set $__jdepth (i32.sub (global.get $__jdepth) (i32.const 1)))
    (if (i32.eqz (local.get $first)) (then (call $__jindent)))
    (call $__jput (i32.const 125))
    (call $__json_leave))`

  // __json_obj(val: f64) — stringify OBJECT using runtime schema name table.
  // Schema name table: global $__schema_tbl → array of f64 pointers.
  //   schema_tbl[schemaId * 8] = f64 pointer to jz Array of key name strings.
  // Object props are sequential f64 at ptr_offset, indexed same as schema.
  // Thunked (not a plain template string) so heapResetWat()/the __dyn_props
  // presence check below read the FINAL declaration state — see collection.js's
  // heapResetWat comment for why (module load order isn't otherwise settled
  // at the time this string would eagerly evaluate).
  ctx.core.stdlib['__json_obj'] = () => `(func $__json_obj (param $val i64)
    (local $off i32) (local $sid i32) (local $keys i32) (local $nkeys i32)
    (local $i i32) (local $koff i32) (local $first i32) (local $pv i64)
    (local $props i64) (local $slot i32) (local $j i32) (local $skip i32)
    ;; Two dyn-prop sources for a DURABLE receiver — see collection.js's
    ;; heapResetWat and module/object.js's emitEnumerateObject for the full
    ;; rationale: G(lobal) holds runtime/post-init keys, S(idecar) holds
    ;; init-time keys. An EPHEMERAL receiver only ever populates S.
    (local $poffG i32) (local $pcapG i32) (local $dnG i32) (local $ordG i32)
    (local $poffS i32) (local $pcapS i32) (local $dnS i32) (local $ordS i32)
    (local.set $off (call $__ptr_offset (local.get $val)))
    (local.set $sid (call $__ptr_aux (local.get $val)))
    ;; Schema keys: schema_tbl + sid*8. Dyn-only programs (empty {} + computed
    ;; o[k]=v) never allocate __schema_tbl, leaving it 0 — guard the read so the
    ;; dyn-prop walk below still runs.
    (local.set $nkeys (i32.const 0))
    (local.set $koff (i32.const 0))
    (if (i32.ne (global.get $__schema_tbl) (i32.const 0))
      (then
        (local.set $koff (call $__ptr_offset
          (i64.load (i32.add (global.get $__schema_tbl) (i32.shl (local.get $sid) (i32.const 3))))))
        (local.set $nkeys (call $__len
          (i64.load (i32.add (global.get $__schema_tbl) (i32.shl (local.get $sid) (i32.const 3))))))))
    (local.set $first (i32.const 1))
    (call $__json_enter (local.get $val))
    (call $__jput (i32.const 123))
    (global.set $__jdepth (i32.add (global.get $__jdepth) (i32.const 1)))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $i) (local.get $nkeys)))
      (local.set $pv (i64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))
      (if (i32.eqz (call $__json_omit (local.get $pv)))
        (then
          (if (i32.eqz (local.get $first)) (then (call $__jput (i32.const 44))))
          (local.set $first (i32.const 0))
          (call $__jindent)
          (call $__jput (i32.const 34))
          (call $__jput_str (i64.load (i32.add (local.get $koff) (i32.shl (local.get $i) (i32.const 3)))))
          (call $__jput (i32.const 34))
          (call $__jput (i32.const 58))
          (if (global.get $__jgaplen) (then (call $__jput (i32.const 32))))
          (call $__json_val (local.get $pv))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    ;; Dynamic (off-schema) properties: heap OBJECTs carry a HASH propsPtr
    ;; either at off-16 (populated by an init-time write, or by any write at
    ;; all on an EPHEMERAL receiver — one allocated after the post-init
    ;; high-water mark, per the durable-receiver policy) or in the global
    ;; __dyn_props table keyed by offset (populated by a RUNTIME/post-init
    ;; write on a DURABLE receiver; see collection.js's heapResetWat for the
    ;; full policy). A durable receiver can carry BOTH — gather each into its
    ;; own (poff/pcap/dn) pair; G(lobal) and S(idecar) below. Static-segment
    ;; objects (off < __heap_start) have no header at all — guard both reads
    ;; on off >= __heap_start so neither ever reads neighbor static data.
    (if (i32.ge_u (local.get $off) (global.get $__heap_start))
      (then
    ;; mask bit0 — durable words may carry the runtime-shadowed marker
    ;; (collection.js __dyn_set); unmasked, the resolved sidecar off is odd.
    (local.set $props (i64.and (i64.load (i32.sub (local.get $off) (i32.const 16))) (i64.const -2)))
    (if (i32.eq
          (i32.wrap_i64 (i64.and (i64.shr_u (local.get $props) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
          (i32.const ${PTR.HASH}))
      (then
        (local.set $poffS (call $__ptr_offset (local.get $props)))
        (local.set $pcapS (i32.load (i32.sub (local.get $poffS) (i32.const 4))))
        (local.set $dnS (i32.load (i32.sub (local.get $poffS) (i32.const 8))))))))${ctx.scope.globals.has('__dyn_props') ? `
    ;; Global (runtime keys on a durable receiver) — independent of the sidecar
    ;; gate above: STATIC-SEGMENT receivers (off < __heap_start, no header) also
    ;; store their dyn writes here, and the probe is keyed by offset alone.
    (if (i32.lt_u (local.get $off) ${heapResetWat()})
      (then
        (if (f64.ne (global.get $__dyn_props) (f64.const 0))
          (then
            (local.set $props (call $__ihash_get_local (i64.reinterpret_f64 (global.get $__dyn_props)) (i64.reinterpret_f64 (f64.convert_i32_s (local.get $off)))))
            (if (i32.eqz (call $__is_nullish (local.get $props)))
              (then
                (local.set $poffG (call $__ptr_offset (local.get $props)))
                (local.set $pcapG (i32.load (i32.sub (local.get $poffG) (i32.const 4))))
                (local.set $dnG (i32.load (i32.sub (local.get $poffG) (i32.const 8))))))))))` : ''}
    ;; Walk in insertion order via __coll_order — schema-only enumeration
    ;; would drop computed props (e.g. {} then o.a=1). Skip entries whose key
    ;; already appears in the schema: object literals with
    ;; needsDynShadow(target)=true shadow-write each schema key into propsPtr
    ;; so dyn-key reads can resolve via hash lookup. That mirror is a runtime
    ;; acceleration, not an enumeration entity — without dedup, JSON output
    ;; emits each schema key twice. Schema-key interns equal the keys we
    ;; shadow-write (same compile-time string literal), so i64.eq matches.
    ;; G walks first (schema-dedup only); S walks second (schema-dedup AND
    ;; G-dedup, so a key present in both — reassigned at runtime after being
    ;; set at init — emits once, from the authoritative G copy).
    (if (i32.ne (local.get $poffG) (i32.const 0))
      (then (local.set $ordG (call $__coll_order (local.get $poffG) (local.get $pcapG) (i32.const 24)))))
    (if (i32.ne (local.get $poffS) (i32.const 0))
      (then (local.set $ordS (call $__coll_order (local.get $poffS) (local.get $pcapS) (i32.const 24)))))
    (if (i32.ne (local.get $dnG) (i32.const 0))
      (then
            (local.set $i (i32.const 0))
            (block $gd (loop $gl
              (br_if $gd (i32.ge_s (local.get $i) (local.get $dnG)))
              (local.set $slot (i32.load (i32.add (local.get $ordG) (i32.shl (local.get $i) (i32.const 2)))))
              (local.set $pv (i64.load (i32.add (local.get $slot) (i32.const 16))))
              (local.set $skip (i32.const 0))
              (local.set $j (i32.const 0))
              (block $gsd (loop $gsl
                (br_if $gsd (i32.ge_s (local.get $j) (local.get $nkeys)))
                (if (i64.eq
                      (i64.load (i32.add (local.get $slot) (i32.const 8)))
                      (i64.load (i32.add (local.get $koff) (i32.shl (local.get $j) (i32.const 3)))))
                  (then (local.set $skip (i32.const 1)) (br $gsd)))
                (local.set $j (i32.add (local.get $j) (i32.const 1)))
                (br $gsl)))
              (if (i32.and (i32.eqz (local.get $skip)) (i32.eqz (call $__json_omit (local.get $pv))))
                (then
                  (if (i32.eqz (local.get $first)) (then (call $__jput (i32.const 44))))
                  (local.set $first (i32.const 0))
                  (call $__jindent)
                  (call $__jput (i32.const 34))
                  (call $__jput_str (i64.load (i32.add (local.get $slot) (i32.const 8))))
                  (call $__jput (i32.const 34))
                  (call $__jput (i32.const 58))
                  (if (global.get $__jgaplen) (then (call $__jput (i32.const 32))))
                  (call $__json_val (local.get $pv))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $gl)))))
    (if (i32.ne (local.get $dnS) (i32.const 0))
      (then
            (local.set $i (i32.const 0))
            (block $sd (loop $sl
              (br_if $sd (i32.ge_s (local.get $i) (local.get $dnS)))
              (local.set $slot (i32.load (i32.add (local.get $ordS) (i32.shl (local.get $i) (i32.const 2)))))
              (local.set $pv (i64.load (i32.add (local.get $slot) (i32.const 16))))
              (local.set $skip (i32.const 0))
              (local.set $j (i32.const 0))
              (block $ssd (loop $ssl
                (br_if $ssd (i32.ge_s (local.get $j) (local.get $nkeys)))
                (if (i64.eq
                      (i64.load (i32.add (local.get $slot) (i32.const 8)))
                      (i64.load (i32.add (local.get $koff) (i32.shl (local.get $j) (i32.const 3)))))
                  (then (local.set $skip (i32.const 1)) (br $ssd)))
                (local.set $j (i32.add (local.get $j) (i32.const 1)))
                (br $ssl)))
              (if (i32.eqz (local.get $skip))
                (then
                  (local.set $j (i32.const 0))
                  (block $sgd (loop $sgl
                    (br_if $sgd (i32.ge_s (local.get $j) (local.get $dnG)))
                    (if (i64.eq
                          (i64.load (i32.add (local.get $slot) (i32.const 8)))
                          (i64.load (i32.add (i32.load (i32.add (local.get $ordG) (i32.shl (local.get $j) (i32.const 2)))) (i32.const 8))))
                      (then (local.set $skip (i32.const 1)) (br $sgd)))
                    (local.set $j (i32.add (local.get $j) (i32.const 1)))
                    (br $sgl)))))
              (if (i32.and (i32.eqz (local.get $skip)) (i32.eqz (call $__json_omit (local.get $pv))))
                (then
                  (if (i32.eqz (local.get $first)) (then (call $__jput (i32.const 44))))
                  (local.set $first (i32.const 0))
                  (call $__jindent)
                  (call $__jput (i32.const 34))
                  (call $__jput_str (i64.load (i32.add (local.get $slot) (i32.const 8))))
                  (call $__jput (i32.const 34))
                  (call $__jput (i32.const 58))
                  (if (global.get $__jgaplen) (then (call $__jput (i32.const 32))))
                  (call $__json_val (local.get $pv))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $sl)))))
    (global.set $__jdepth (i32.sub (global.get $__jdepth) (i32.const 1)))
    (if (i32.eqz (local.get $first)) (then (call $__jindent)))
    (call $__jput (i32.const 125))
    (call $__json_leave))`

  // __stringify(val: i64, space: i64) → f64 (NaN-boxed string)
  ctx.core.stdlib['__stringify'] = `(func $__stringify (param $val i64) (param $space i64) (result f64)
    ;; Top-level undefined / function serializes to nothing → return undefined.
    (if (call $__json_omit (local.get $val)) (then (return ${UNDEF_WAT})))
    ;; Reset output buffer + cycle stack
    (global.set $__jsp (i32.const 0))
    (global.set $__jbuf (call $__alloc (i32.const 256)))
    (global.set $__jpos (i32.const 0))
    (global.set $__jcap (i32.const 256))
    (call $__json_setgap (local.get $space))
    (call $__json_val (local.get $val))
    ;; Create string from buffer
    (call $__mkstr (global.get $__jbuf) (global.get $__jpos)))`

  // === JSON.parse ===

  declGlobal('__jpstr', 'i32')  // input string offset
  declGlobal('__jplen', 'i32')  // input length
  declGlobal('__jppos', 'i32')  // current parse position
  // Side-channel hash for the most-recently-parsed string. __jp_str folds a
  // byte-FNV-1a pass into its scan loop; __jp_obj mixes it straight into the
  // schema-cache's key-SEQUENCE hash ($hh, __jp_schema_get's probe key) — an
  // independent hash from __str_hash, so it need not agree bit-for-bit with the
  // runtime string hash (a schema-cache hit is verified by direct i64 key-array
  // comparison, not by hash equality). 0 is a sentinel meaning "string had
  // escapes"; it still mixes into $hh (a false schema-cache collision is caught
  // by the verify step, never silently wrong).
  declGlobal('__jp_keyh', 'i32')
  // Sticky syntax-error flag. Set by any parser sub-routine on malformed input;
  // checked once by __jp after the top-level value, which throws if it is set.
  // Sticky (never cleared mid-parse) so recursive descent need not thread an
  // error result through every call — __jp resets it per invocation.
  declGlobal('__jp_err', 'i32')
  // Runtime schema infrastructure. __schema_next points at the first free slot
  // in $__schema_tbl reserved for runtime registration; compile.js initializes
  // it to ctx.schema.list.length when __jp_obj is included. The schema cache
  // is a 64-entry open-addressed hash on key-sequence FNV — repeated parses of
  // the same shape reuse a previously-registered sid, so __jp_obj allocates a
  // fresh-shape OBJECT once and converts to slot stores thereafter (skipping
  // every __hash_set_local). Cache slot layout: i32 hash, i32 sid (8 bytes).
  // Hash 0 = empty slot; we bump <=1 to 2 like __str_hash to avoid sentinel
  // collision with valid hashes.
  declGlobal('__schema_next', 'i32')
  declGlobal('__schema_cache', 'i32')

  // Sentinel-driven peek: __jp copies input to a scratch buffer with 0xFF bytes
  // appended past the end. i32.load8_s sign-extends, so the sentinel reads as -1
  // — exactly the EOF value all callers already test for. Inlined into every
  // parser body via PEEK/ADV string templates; the per-char function-call
  // overhead (~50 calls/char in well-formed JSON) was the dominant cost.
  const PEEK = `(i32.load8_s (i32.add (global.get $__jpstr) (global.get $__jppos)))`
  const ADV = (n) => `(global.set $__jppos (i32.add (global.get $__jppos) (i32.const ${n})))`

  // Whitespace skip — inlined at every call site as a tight loop. Compact
  // JSON often has zero whitespace between tokens, so the dominant case is
  // a single peek + break. Per the JSON grammar only tab (9), LF (10), CR
  // (13) and space (32) are JSONWhitespace; every other byte — including
  // other control chars and non-ASCII Unicode spaces — ends the run, so a
  // stray VT/FF or U+2028 surfaces to the value dispatcher as a syntax
  // error. The sentinel byte (PEEK returns -1) matches none of the four and
  // ends the run too, so EOF needs no separate guard.
  let WS_ID = 0
  const WS = () => {
    const id = WS_ID++
    return `(block $jpws_d${id} (loop $jpws_l${id}
      (br_if $jpws_d${id} (i32.eqz (i32.or
        (i32.or (i32.eq ${PEEK} (i32.const 32)) (i32.eq ${PEEK} (i32.const 9)))
        (i32.or (i32.eq ${PEEK} (i32.const 10)) (i32.eq ${PEEK} (i32.const 13))))))
      ${ADV(1)}
      (br $jpws_l${id})))`
  }

  // Parse string (after opening " consumed). Single-pass scan that folds three
  // concerns into one byte loop: simplicity flag (no escapes / no high-bit),
  // SSO byte packing for ≤4-char ASCII keys, and byte-FNV-1a hash. The hash is
  // stashed in $__jp_keyh so __jp_obj can mix it into the schema-cache sequence
  // hash without re-scanning the key bytes (see the $__jp_keyh declaration above
  // for why it need not match __str_hash's SSO-mix output).
  // Hex nibble: '0'-'9' / 'a'-'f' / 'A'-'F' → 0..15; anything else → 0 (lenient).
  ctx.core.stdlib['__hex1'] = `(func $__hex1 (param $c i32) (result i32)
    (if (i32.le_u (i32.sub (local.get $c) (i32.const 48)) (i32.const 9))
      (then (return (i32.sub (local.get $c) (i32.const 48)))))
    (if (i32.le_u (i32.sub (i32.or (local.get $c) (i32.const 0x20)) (i32.const 97)) (i32.const 5))
      (then (return (i32.sub (i32.or (local.get $c) (i32.const 0x20)) (i32.const 87)))))
    (i32.const 0))`

  // Strict hex-digit predicate — 1 iff $c is [0-9A-Fa-f], else 0. Used to
  // validate \uXXXX escapes (__hex1 itself is lenient and returns 0 for
  // non-hex, which would silently accept `\u0X50`).
  ctx.core.stdlib['__ishex'] = `(func $__ishex (param $c i32) (result i32)
    (i32.or
      (i32.le_u (i32.sub (local.get $c) (i32.const 48)) (i32.const 9))
      (i32.le_u (i32.sub (i32.or (local.get $c) (i32.const 0x20)) (i32.const 97)) (i32.const 5))))`

  // All four bytes at the current parse position are hex digits.
  const HEX4_VALID = `(i32.and
    (i32.and (call $__ishex (i32.load8_u (i32.add (global.get $__jpstr) (global.get $__jppos))))
             (call $__ishex (i32.load8_u (i32.add (global.get $__jpstr) (i32.add (global.get $__jppos) (i32.const 1))))))
    (i32.and (call $__ishex (i32.load8_u (i32.add (global.get $__jpstr) (i32.add (global.get $__jppos) (i32.const 2)))))
             (call $__ishex (i32.load8_u (i32.add (global.get $__jpstr) (i32.add (global.get $__jppos) (i32.const 3)))))))`

  // Read 4 hex bytes at absolute address $p → 16-bit value.
  ctx.core.stdlib['__hex4'] = `(func $__hex4 (param $p i32) (result i32)
    (i32.or (i32.or (i32.or
      (i32.shl (call $__hex1 (i32.load8_u (local.get $p))) (i32.const 12))
      (i32.shl (call $__hex1 (i32.load8_u (i32.add (local.get $p) (i32.const 1)))) (i32.const 8)))
      (i32.shl (call $__hex1 (i32.load8_u (i32.add (local.get $p) (i32.const 2)))) (i32.const 4)))
      (call $__hex1 (i32.load8_u (i32.add (local.get $p) (i32.const 3))))))`

  // Encode code point $cp as UTF-8 at $off; returns bytes written (1-4).
  ctx.core.stdlib['__utf8_enc'] = `(func $__utf8_enc (param $off i32) (param $cp i32) (result i32)
    (if (i32.lt_u (local.get $cp) (i32.const 0x80))
      (then (i32.store8 (local.get $off) (local.get $cp)) (return (i32.const 1))))
    (if (i32.lt_u (local.get $cp) (i32.const 0x800))
      (then
        (i32.store8 (local.get $off) (i32.or (i32.const 0xC0) (i32.shr_u (local.get $cp) (i32.const 6))))
        (i32.store8 (i32.add (local.get $off) (i32.const 1)) (i32.or (i32.const 0x80) (i32.and (local.get $cp) (i32.const 0x3F))))
        (return (i32.const 2))))
    (if (i32.lt_u (local.get $cp) (i32.const 0x10000))
      (then
        (i32.store8 (local.get $off) (i32.or (i32.const 0xE0) (i32.shr_u (local.get $cp) (i32.const 12))))
        (i32.store8 (i32.add (local.get $off) (i32.const 1)) (i32.or (i32.const 0x80) (i32.and (i32.shr_u (local.get $cp) (i32.const 6)) (i32.const 0x3F))))
        (i32.store8 (i32.add (local.get $off) (i32.const 2)) (i32.or (i32.const 0x80) (i32.and (local.get $cp) (i32.const 0x3F))))
        (return (i32.const 3))))
    (i32.store8 (local.get $off) (i32.or (i32.const 0xF0) (i32.shr_u (local.get $cp) (i32.const 18))))
    (i32.store8 (i32.add (local.get $off) (i32.const 1)) (i32.or (i32.const 0x80) (i32.and (i32.shr_u (local.get $cp) (i32.const 12)) (i32.const 0x3F))))
    (i32.store8 (i32.add (local.get $off) (i32.const 2)) (i32.or (i32.const 0x80) (i32.and (i32.shr_u (local.get $cp) (i32.const 6)) (i32.const 0x3F))))
    (i32.store8 (i32.add (local.get $off) (i32.const 3)) (i32.or (i32.const 0x80) (i32.and (local.get $cp) (i32.const 0x3F))))
    (i32.const 4))`

  ctx.core.stdlib['__jp_str'] = `(func $__jp_str (result f64)
    (local $start i32) (local $ch i32) (local $len i32) (local $off i32) (local $i i32) (local $simple i32) (local $sso i32) (local $h i32) (local $cp i32)
    (local.set $start (global.get $__jppos))
    (local.set $simple (i32.const 1))
    (local.set $h (i32.const 0x811c9dc5))
    (block $d (loop $l
      (local.set $ch ${PEEK})
      (br_if $d (i32.eq (local.get $ch) (i32.const 34)))
      (br_if $d (i32.eq (local.get $ch) (i32.const -1)))
      ;; Unescaped control char (U+0000..U+001F) is not a valid JSONStringCharacter.
      (if (i32.lt_u (local.get $ch) (i32.const 32))
        (then (global.set $__jp_err (i32.const 1)) (br $d)))
      ;; Mark non-simple: escape (\\=92) or non-ASCII (load8_s gives <0 for byte≥128).
      (if (i32.or (i32.eq (local.get $ch) (i32.const 92)) (i32.lt_s (local.get $ch) (i32.const 0)))
        (then (local.set $simple (i32.const 0))))
      (if (i32.eq (local.get $ch) (i32.const 92))
        (then
          (local.set $len (i32.add (local.get $len) (i32.const 1)))
          ${ADV(2)})
        (else
          ;; Pack first 4 bytes into SSO slot (used only when len ≤ 4): 7-bit ASCII, char at bit len*7.
          (if (i32.lt_u (local.get $len) (i32.const 4))
            (then (local.set $sso
              (i32.or (local.get $sso)
                (i32.shl (i32.and (local.get $ch) (i32.const 0xFF))
                  (i32.mul (local.get $len) (i32.const 7)))))))
          (local.set $h (i32.mul (i32.xor (local.get $h) (i32.and (local.get $ch) (i32.const 0xFF))) (i32.const 0x01000193)))
          (local.set $len (i32.add (local.get $len) (i32.const 1)))
          ${ADV(1)}))
      (br $l)))
    ;; Loop exited on the closing quote (34) or EOF (-1); the latter means an
    ;; unterminated string literal.
    (if (i32.eq (local.get $ch) (i32.const -1)) (then (global.set $__jp_err (i32.const 1))))
    ;; Stash hash. 0/1 bumped to 2 to match __str_hash's clamp convention (kept for
    ;; sentinel consistency, though __jp_obj's consumer — the schema sequence hash —
    ;; doesn't itself need agreement with __str_hash). Escape strings (simple==0) get
    ;; sentinel 0, which still mixes into $hh (harmless: __jp_schema_get verifies by
    ;; key-array compare, not hash equality).
    (global.set $__jp_keyh
      (if (result i32) (local.get $simple)
        (then (if (result i32) (i32.le_s (local.get $h) (i32.const 1))
          (then (i32.add (local.get $h) (i32.const 2))) (else (local.get $h))))
        (else (i32.const 0))))
    ${ADV(1)}  ;; skip "
    ;; SSO fast path: ≤4 ASCII chars, no escapes — bytes already packed inline.
    (if (i32.and (local.get $simple) (i32.le_u (local.get $len) (i32.const 4)))
      (then
        (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.or (i32.const ${LAYOUT.SSO_BIT}) (i32.shl (local.get $len) (i32.const 10))) (local.get $sso)))))
    ;; Simple STRING fast path: no escapes, len > 4 — bulk memcpy from parse buffer,
    ;; skip rewind + per-byte escape-decode loop. Hits 5+ char keys without escapes.
    ;; 5-6 char ASCII results route through __sso_norm (string-module invariant).
    (if (local.get $simple)
      (then
        (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $len))))
        (local.set $off (i32.add (local.get $off) (i32.const 4)))
        (i32.store (i32.sub (local.get $off) (i32.const 4)) (local.get $len))
        (memory.copy (local.get $off) (i32.add (global.get $__jpstr) (local.get $start)) (local.get $len))
        (return (call $__sso_norm (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $off))))))
    ;; Copy chars to new string (handles escapes inline)
    (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $len))))
    (local.set $off (i32.add (local.get $off) (i32.const 4)))
    (local.set $i (i32.const 0))
    (global.set $__jppos (local.get $start))  ;; rewind to re-scan
    (local.set $len (i32.const 0))  ;; actual output length
    (block $d2 (loop $l2
      (local.set $ch ${PEEK})
      (br_if $d2 (i32.eq (local.get $ch) (i32.const 34)))
      (br_if $d2 (i32.eq (local.get $ch) (i32.const -1)))
      (if (i32.eq (local.get $ch) (i32.const 92))
        (then
          ${ADV(1)}
          (local.set $ch ${PEEK})
          ${ADV(1)}
          (if (i32.eq (local.get $ch) (i32.const 117))  ;; \\uXXXX
            (then
              (if (i32.eqz ${HEX4_VALID}) (then (global.set $__jp_err (i32.const 1))))
              (local.set $cp (call $__hex4 (i32.add (global.get $__jpstr) (global.get $__jppos))))
              ${ADV(4)}
              ;; High surrogate immediately followed by \\uXXXX low surrogate → combine.
              (if (i32.and
                    (i32.eq (i32.and (local.get $cp) (i32.const 0xFC00)) (i32.const 0xD800))
                    (i32.and (i32.eq ${PEEK} (i32.const 92))
                             (i32.eq (i32.load8_u (i32.add (global.get $__jpstr) (i32.add (global.get $__jppos) (i32.const 1)))) (i32.const 117))))
                (then
                  ${ADV(2)}
                  (if (i32.eqz ${HEX4_VALID}) (then (global.set $__jp_err (i32.const 1))))
                  (local.set $i (call $__hex4 (i32.add (global.get $__jpstr) (global.get $__jppos))))
                  ${ADV(4)}
                  (local.set $cp (i32.add (i32.const 0x10000)
                    (i32.or (i32.shl (i32.and (local.get $cp) (i32.const 0x3FF)) (i32.const 10))
                            (i32.and (local.get $i) (i32.const 0x3FF)))))))
              (local.set $len (i32.add (local.get $len)
                (call $__utf8_enc (i32.add (local.get $off) (local.get $len)) (local.get $cp))))
              (br $l2))
            (else
              ;; Decode simple escape: n→10 t→9 r→13 b→8 f→12, else literal char.
              (if (i32.eq (local.get $ch) (i32.const 110)) (then (local.set $ch (i32.const 10))))
              (if (i32.eq (local.get $ch) (i32.const 116)) (then (local.set $ch (i32.const 9))))
              (if (i32.eq (local.get $ch) (i32.const 114)) (then (local.set $ch (i32.const 13))))
              (if (i32.eq (local.get $ch) (i32.const 98))  (then (local.set $ch (i32.const 8))))
              (if (i32.eq (local.get $ch) (i32.const 102)) (then (local.set $ch (i32.const 12)))))))
        (else ${ADV(1)}))
      (i32.store8 (i32.add (local.get $off) (local.get $len)) (local.get $ch))
      (local.set $len (i32.add (local.get $len) (i32.const 1)))
      (br $l2)))
    ${ADV(1)}  ;; skip closing "
    ;; Store actual length in header
    (i32.store (i32.sub (local.get $off) (i32.const 4)) (local.get $len))
    ;; escape-decoded result may be short ASCII ("\\n" → 1 char) → normalize (invariant)
    (call $__sso_norm (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $off))))`

  // Parse number
  ctx.core.stdlib['__jp_num'] = `(func $__jp_num (result f64)
    (local $neg i32) (local $val f64) (local $scale f64) (local $ch i32)
    (local $exp i32) (local $expNeg i32)
    (if (i32.eq ${PEEK} (i32.const 45))
      (then (local.set $neg (i32.const 1)) ${ADV(1)}))
    (block $d (loop $l
      (local.set $ch ${PEEK})
      (br_if $d (i32.or (i32.lt_s (local.get $ch) (i32.const 48)) (i32.gt_s (local.get $ch) (i32.const 57))))
      (local.set $val (f64.add (f64.mul (local.get $val) (f64.const 10))
        (f64.convert_i32_s (i32.sub (local.get $ch) (i32.const 48)))))
      ${ADV(1)} (br $l)))
    (if (i32.eq ${PEEK} (i32.const 46))
      (then
        ${ADV(1)}
        (local.set $scale (f64.const 0.1))
        (block $fd (loop $fl
          (local.set $ch ${PEEK})
          (br_if $fd (i32.or (i32.lt_s (local.get $ch) (i32.const 48)) (i32.gt_s (local.get $ch) (i32.const 57))))
          (local.set $val (f64.add (local.get $val)
            (f64.mul (local.get $scale) (f64.convert_i32_s (i32.sub (local.get $ch) (i32.const 48))))))
          (local.set $scale (f64.mul (local.get $scale) (f64.const 0.1)))
          ${ADV(1)} (br $fl)))))
    (if (i32.or (i32.eq ${PEEK} (i32.const 101)) (i32.eq ${PEEK} (i32.const 69)))
      (then
        ${ADV(1)}
        (if (i32.eq ${PEEK} (i32.const 45))
          (then (local.set $expNeg (i32.const 1)) ${ADV(1)})
        (else (if (i32.eq ${PEEK} (i32.const 43))
          (then ${ADV(1)}))))
        (block $ed (loop $el
          (local.set $ch ${PEEK})
          (br_if $ed (i32.or (i32.lt_s (local.get $ch) (i32.const 48)) (i32.gt_s (local.get $ch) (i32.const 57))))
          (local.set $exp (i32.add (i32.mul (local.get $exp) (i32.const 10)) (i32.sub (local.get $ch) (i32.const 48))))
          ${ADV(1)} (br $el)))
        (if (local.get $expNeg) (then (local.set $exp (i32.sub (i32.const 0) (local.get $exp)))))
        (local.set $val (f64.mul (local.get $val) (call $__pow10
          (if (result i32) (i32.lt_s (local.get $exp) (i32.const 0))
            (then (i32.const 0)) (else (local.get $exp))))))
        (if (i32.lt_s (local.get $exp) (i32.const 0))
          (then (local.set $val (f64.div (local.get $val) (call $__pow10 (i32.sub (i32.const 0) (local.get $exp)))))))))
    (if (result f64) (local.get $neg) (then (f64.neg (local.get $val))) (else (local.get $val))))`

  // Parse array
  ctx.core.stdlib['__jp_arr'] = `(func $__jp_arr (result f64)
    (local $ptr i32) (local $len i32) (local $cap i32) (local $new i32) (local $ch i32)
    (local.set $cap (i32.const 8))
    (local.set $ptr (call $__alloc (i32.add (i32.const 8) (i32.shl (local.get $cap) (i32.const 3)))))
    (local.set $ptr (i32.add (local.get $ptr) (i32.const 8)))
    ${WS()}
    (if (i32.eq ${PEEK} (i32.const 93))
      (then ${ADV(1)}
        (i32.store (i32.sub (local.get $ptr) (i32.const 8)) (i32.const 0))
        (i32.store (i32.sub (local.get $ptr) (i32.const 4)) (local.get $cap))
        (return (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $ptr)))))
    (block $d (loop $l
      ${WS()}
      ;; Grow if needed
      (if (i32.ge_s (local.get $len) (local.get $cap))
        (then
          (local.set $new (call $__alloc (i32.add (i32.const 8) (i32.shl (i32.shl (local.get $cap) (i32.const 1)) (i32.const 3)))))
          (local.set $new (i32.add (local.get $new) (i32.const 8)))
          (memory.copy (local.get $new) (local.get $ptr) (i32.shl (local.get $len) (i32.const 3)))
          (local.set $cap (i32.shl (local.get $cap) (i32.const 1)))
          (local.set $ptr (local.get $new))))
      (f64.store (i32.add (local.get $ptr) (i32.shl (local.get $len) (i32.const 3))) (call $__jp_val))
      (local.set $len (i32.add (local.get $len) (i32.const 1)))
      ${WS()}
      (local.set $ch ${PEEK})
      (br_if $d (i32.eq (local.get $ch) (i32.const 93)))
      ;; After an element only a comma (more) or close-bracket (done) is
      ;; valid; anything else (incl. EOF) is a syntax error. Break to terminate.
      (if (i32.eq (local.get $ch) (i32.const 44))
        (then ${ADV(1)})
        (else (global.set $__jp_err (i32.const 1)) (br $d)))
      (br $l)))
    ${ADV(1)}
    (i32.store (i32.sub (local.get $ptr) (i32.const 8)) (local.get $len))
    (i32.store (i32.sub (local.get $ptr) (i32.const 4)) (local.get $cap))
    (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $ptr)))`

  // Schema cache lookup/register. Cache is a 64-entry open-addressed table
  // keyed by FNV of (key1_hash, key2_hash, ..., n). On hit, sid is reused
  // and the OBJECT is allocated with that schemaId so subsequent property
  // accesses go through the slot fast path. On miss, register a new schema
  // by allocating a jz Array of key STRINGs and storing it in $__schema_tbl
  // at the next free slot. Allocated lazily on first call.
  //
  // kbuf layout: 16 bytes per entry — [key:i64][val:i64]. n entries at $kbuf.
  // Returns sid (i32). Caller materializes OBJECT with given sid + values.
  ctx.core.stdlib['__jp_schema_get'] = `(func $__jp_schema_get (param $kbuf i32) (param $n i32) (param $hh i32) (result i32)
    (local $cache i32) (local $idx i32) (local $entry i32) (local $eh i32) (local $sid i32)
    (local $karr i32) (local $karr_off i32) (local $i i32) (local $tries i32)
    (local.set $cache (global.get $__schema_cache))
    ;; Lazy-init cache: 64 entries × 8 bytes = 512 bytes, zero-filled by alloc.
    (if (i32.eqz (local.get $cache))
      (then
        (local.set $cache (call $__alloc (i32.const 512)))
        (global.set $__schema_cache (local.get $cache))))
    (local.set $idx (i32.and (local.get $hh) (i32.const 63)))
    (block $found (block $miss (loop $probe
      (local.set $entry (i32.add (local.get $cache) (i32.shl (local.get $idx) (i32.const 3))))
      (local.set $eh (i32.load (local.get $entry)))
      (br_if $miss (i32.eqz (local.get $eh)))
      (if (i32.eq (local.get $eh) (local.get $hh))
        (then
          (local.set $sid (i32.load (i32.add (local.get $entry) (i32.const 4))))
          ;; Verify by comparing key i64s against schema_tbl[sid]'s key array.
          (local.set $karr (i32.wrap_i64 (i64.and
            (i64.load (i32.add (global.get $__schema_tbl) (i32.shl (local.get $sid) (i32.const 3))))
            (i64.const ${LAYOUT.OFFSET_MASK}))))
          (if (i32.eq (i32.load (i32.sub (local.get $karr) (i32.const 8))) (local.get $n))
            (then
              (local.set $i (i32.const 0))
              (block $eq (block $neq (loop $cmp
                (br_if $eq (i32.ge_s (local.get $i) (local.get $n)))
                (br_if $neq (i64.ne
                  (i64.load (i32.add (local.get $karr) (i32.shl (local.get $i) (i32.const 3))))
                  (i64.load (i32.add (local.get $kbuf) (i32.shl (local.get $i) (i32.const 4))))))
                (local.set $i (i32.add (local.get $i) (i32.const 1)))
                (br $cmp)))
                (br $found)))))
        ;; Hash collision or length mismatch — keep probing.
      )
      (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
      (br_if $miss (i32.ge_s (local.get $tries) (i32.const 64)))
      (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.const 63)))
      (br $probe)))
      ;; miss: register new schema.
      (local.set $sid (global.get $__schema_next))
      (global.set $__schema_next (i32.add (local.get $sid) (i32.const 1)))
      ;; Allocate jz Array of n keys. __alloc_hdr(len, cap) returns base of
      ;; slot region with len@-8 and cap@-4. The schema dispatch arm reads
      ;; nkeys from -8, so len must equal cap=n.
      (local.set $karr (call $__alloc_hdr (local.get $n) (local.get $n)))
      (local.set $i (i32.const 0))
      (block $cd (loop $cl
        (br_if $cd (i32.ge_s (local.get $i) (local.get $n)))
        (i64.store
          (i32.add (local.get $karr) (i32.shl (local.get $i) (i32.const 3)))
          (i64.load (i32.add (local.get $kbuf) (i32.shl (local.get $i) (i32.const 4)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $cl)))
      ;; Store ARRAY ptr in schema table at sid.
      (i64.store
        (i32.add (global.get $__schema_tbl) (i32.shl (local.get $sid) (i32.const 3)))
        (i64.reinterpret_f64 (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $karr))))
      ;; Insert into cache at probe position.
      (i32.store (local.get $entry) (local.get $hh))
      (i32.store (i32.add (local.get $entry) (i32.const 4)) (local.get $sid)))
    (local.get $sid))`

  // Parse object → OBJECT (schema-tagged, slot-based), always, via the runtime
  // schema cache (no HASH fallback in this build — every key sequence gets a sid).
  // Builds a transient (key, val) buffer during parse, then resolves a sid via
  // the runtime schema cache, allocs an OBJECT, and copies values into slots.
  // Walk-side `obj.prop` accesses then route through the OBJECT fast path
  // (slot load) instead of the dispatcher → __hash_get_local chain.
  ctx.core.stdlib['__jp_obj'] = `(func $__jp_obj (result f64)
    (local $kbuf i32) (local $kn i32) (local $kcap i32) (local $hh i32)
    (local $key i64) (local $val i64) (local $h i32) (local $ch i32)
    (local $sid i32) (local $obj i32) (local $i i32) (local $newbuf i32)
    (local.set $kcap (i32.const 8))
    (local.set $kbuf (call $__alloc (i32.shl (local.get $kcap) (i32.const 4))))
    (local.set $hh (i32.const 0x811c9dc5))
    ${WS()}
    ;; Empty object — alloc an empty OBJECT with sid 0 (schema slot 0 may be
    ;; empty/unused; downstream Object.keys handles 0-length names array).
    (if (i32.eq ${PEEK} (i32.const 125))
      (then ${ADV(1)}
        (local.set $sid (call $__jp_schema_get (local.get $kbuf) (i32.const 0) (local.get $hh)))
        (return (call $__mkptr (i32.const ${PTR.OBJECT}) (local.get $sid)
          (call $__alloc_hdr (i32.const 0) (i32.const 1))))))
    (block $d (loop $l
      ${WS()}
      (if (i32.eq ${PEEK} (i32.const 34))
        (then ${ADV(1)}))
      (local.set $key (i64.reinterpret_f64 (call $__jp_str)))
      (local.set $h (global.get $__jp_keyh))
      ;; Mix key hash into running sequence hash. Escape-bearing keys (h=0)
      ;; still mix; identical key sequences differing only by escapes will
      ;; collide here, but the verify-step in __jp_schema_get rejects via
      ;; i64.ne on the actual key bytes.
      (local.set $hh (i32.mul (i32.xor (local.get $hh) (local.get $h)) (i32.const 0x01000193)))
      ${WS()}
      (if (i32.eq ${PEEK} (i32.const 58))
        (then ${ADV(1)}))
      ${WS()}
      (local.set $val (i64.reinterpret_f64 (call $__jp_val)))
      ;; Grow kbuf if at capacity.
      (if (i32.ge_s (local.get $kn) (local.get $kcap))
        (then
          (local.set $kcap (i32.shl (local.get $kcap) (i32.const 1)))
          (local.set $newbuf (call $__alloc (i32.shl (local.get $kcap) (i32.const 4))))
          (memory.copy (local.get $newbuf) (local.get $kbuf) (i32.shl (local.get $kn) (i32.const 4)))
          (local.set $kbuf (local.get $newbuf))))
      ;; Append (key, val).
      (i64.store (i32.add (local.get $kbuf) (i32.shl (local.get $kn) (i32.const 4))) (local.get $key))
      (i64.store (i32.add (local.get $kbuf) (i32.add (i32.shl (local.get $kn) (i32.const 4)) (i32.const 8))) (local.get $val))
      (local.set $kn (i32.add (local.get $kn) (i32.const 1)))
      ${WS()}
      (local.set $ch ${PEEK})
      (br_if $d (i32.eq (local.get $ch) (i32.const 125)))
      ;; After a member only a comma (more) or close-brace (done) is
      ;; valid; anything else (incl. EOF) is a syntax error. Break to terminate.
      (if (i32.eq (local.get $ch) (i32.const 44))
        (then ${ADV(1)})
        (else (global.set $__jp_err (i32.const 1)) (br $d)))
      (br $l)))
    ${ADV(1)}
    ;; Resolve schema sid (cached or freshly registered).
    (local.set $sid (call $__jp_schema_get (local.get $kbuf) (local.get $kn) (local.get $hh)))
    ;; Allocate OBJECT slot region: kn × 8 bytes, with header (size at -8,
    ;; cap at -4) matching the static-fold path's emitJsonConstValue layout.
    (local.set $obj (call $__alloc_hdr (i32.const 0) (local.get $kn)))
    ;; Copy values into OBJECT slots.
    (local.set $i (i32.const 0))
    (block $vd (loop $vl
      (br_if $vd (i32.ge_s (local.get $i) (local.get $kn)))
      (i64.store
        (i32.add (local.get $obj) (i32.shl (local.get $i) (i32.const 3)))
        (i64.load (i32.add (local.get $kbuf) (i32.add (i32.shl (local.get $i) (i32.const 4)) (i32.const 8)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $vl)))
    (call $__mkptr (i32.const ${PTR.OBJECT}) (local.get $sid) (local.get $obj)))`

  // Verify a bare keyword literal: the dispatch char is already known to be
  // word[0]; AND-check word[1..] against the bytes after the parse position.
  // Past-end reads land in the 0xFF sentinel pad, which matches nothing.
  const litMatch = (word) => {
    // Index with charCodeAt rather than `[...word]` spread: jz (self-host) does not
    // spread a string into a char array, so the spread form yields an empty test set
    // and the literal match folds to a constant-false `(if 0 …)` — breaking
    // JSON.parse of true/false/null once jz compiles its own parser. The first char
    // is already matched by the caller's `ch` switch, so compare offsets 1..len-1.
    let acc = ''
    for (let i = 1; i < word.length; i++) {
      const t = `(i32.eq (i32.load8_u (i32.add (global.get $__jpstr) (i32.add (global.get $__jppos) (i32.const ${i})))) (i32.const ${word.charCodeAt(i)}))`
      acc = acc ? `(i32.and ${acc} ${t})` : t
    }
    return acc
  }
  const litCase = (ch, word, valIR, adv) => `(if (i32.eq (local.get $ch) (i32.const ${ch}))
      (then (if ${litMatch(word)}
        (then ${ADV(adv)} (return ${valIR}))
        (else (global.set $__jp_err (i32.const 1)) (return ${NULL_WAT})))))`

  // Main value dispatcher
  ctx.core.stdlib['__jp_val'] = `(func $__jp_val (result f64)
    (local $ch i32)
    ${WS()}
    (local.set $ch ${PEEK})
    (if (i32.eq (local.get $ch) (i32.const 34))
      (then ${ADV(1)} (return (call $__jp_str))))
    (if (i32.eq (local.get $ch) (i32.const 91))
      (then ${ADV(1)} (return (call $__jp_arr))))
    (if (i32.eq (local.get $ch) (i32.const 123))
      (then ${ADV(1)} (return (call $__jp_obj))))
    (if (i32.or (i32.and (i32.ge_s (local.get $ch) (i32.const 48)) (i32.le_s (local.get $ch) (i32.const 57)))
                (i32.eq (local.get $ch) (i32.const 45)))
      (then (return (call $__jp_num))))
    ${litCase(116, 'true', `(f64.const nan:${TRUE_NAN})`, 4)}
    ${litCase(102, 'false', `(f64.const nan:${FALSE_NAN})`, 5)}
    ${litCase(110, 'null', NULL_WAT, 4)}
    ;; No production matched — malformed JSON value.
    (global.set $__jp_err (i32.const 1))
    ${NULL_WAT})`

  function canSpecializeJsonShape(v) {
    if (v == null) return true
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return true
    if (Array.isArray(v)) return v.length > 0 && v.every(x => sameJsonShape(v[0], x)) && canSpecializeJsonShape(v[0])
    if (typeof v === 'object') return Object.keys(v).every(k => /^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/.test(k) && canSpecializeJsonShape(v[k]))
    return false
  }

  function sameJsonShape(a, b) {
    if (a == null || b == null) return a == null && b == null
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length > 0 && b.length > 0 && sameJsonShape(a[0], b[0])
    if (typeof a !== typeof b) return false
    if (typeof a !== 'object') return true
    const ak = Object.keys(a), bk = Object.keys(b)
    return ak.length === bk.length && ak.every((k, i) => k === bk[i] && sameJsonShape(a[k], b[k]))
  }

  function emitJsonShapeParser(parsed) {
    if (!canSpecializeJsonShape(parsed)) return null
    ctx.runtime.jsonShapeParsers ||= new Map()
    const sig = JSON.stringify(shapeSignature(parsed))
    const cached = ctx.runtime.jsonShapeParsers.get(sig)
    if (cached) return cached

    const name = `__jp_shape_${ctx.runtime.jsonShapeParsers.size}`
    const locals = new Map([['len', 'i32'], ['buf', 'i32'], ['i', 'i32'], ['ch', 'i32']])
    let uniq = 0
    const local = (p, t) => {
      const n = `${p}${uniq++}`
      locals.set(n, t)
      return n
    }
    const fail = `(return (call $__jp (local.get $str)))`
    const expect = (byte) => `(if (i32.ne ${PEEK} (i32.const ${byte})) (then ${fail}))
    ${ADV(1)}`
    const expectText = (text) => [...text].map(c => expect(c.charCodeAt(0))).join('\n    ')
    // Forward-declared with `let` (assigned below) so `parse` captures a boxed
    // cell, not a not-yet-initialized `const` binding — the self-host kernel
    // miscompiles the latter capture in this deeply-nested mutually-recursive
    // context (parse ends up calling a garbage `parseObject`, emitting a corrupt
    // node into the shaped parser).
    let parseObject, parseArray
    const parse = (v, out) => {
      if (v == null) return `${expectText('null')}
    (local.set $${out} ${NULL_WAT})`
      if (typeof v === 'boolean') return `${expectText(v ? 'true' : 'false')}
    (local.set $${out} (f64.const nan:${v ? TRUE_NAN : FALSE_NAN}))`
      if (typeof v === 'number') return `(local.set $${out} (call $__jp_num))`
      if (typeof v === 'string') return `${expect(34)}
    (local.set $${out} (call $__jp_str))`
      if (Array.isArray(v)) return parseArray(v[0], out)
      return parseObject(v, out)
    }
    parseObject = (v, out) => {
      const keys = Object.keys(v)
      const obj = local('obj', 'i32')
      const val = local('val', 'f64')
      const sid = ctx.schema.register(keys)
      let body = `${WS()}
    ${expect(123)}
    (local.set $${obj} (call $__alloc_hdr (i32.const 0) (i32.const ${Math.max(1, keys.length)})))`
      keys.forEach((k, i) => {
        body += `
    ${WS()}
    ${expect(34)}
    ${expectText(k)}
    ${expect(34)}
    ${WS()}
    ${expect(58)}
    ${WS()}
    ${parse(v[k], val)}
    (f64.store (i32.add (local.get $${obj}) (i32.const ${i * 8})) (local.get $${val}))
    ${WS()}
    ${expect(i === keys.length - 1 ? 125 : 44)}`
      })
      if (keys.length === 0) body += `
    ${WS()}
    ${expect(125)}`
      return `${body}
    (local.set $${out} (call $__mkptr (i32.const ${PTR.OBJECT}) (i32.const ${sid}) (local.get $${obj})))`
    }
    parseArray = (elem, out) => {
      const ptr = local('arr', 'i32')
      const len = local('alen', 'i32')
      const cap = local('acap', 'i32')
      const val = local('aval', 'f64')
      const next = local('anew', 'i32')
      const id = uniq++
      return `${WS()}
    ${expect(91)}
    (local.set $${cap} (i32.const 8))
    (local.set $${ptr} (call $__alloc (i32.add (i32.const 8) (i32.shl (local.get $${cap}) (i32.const 3)))))
    (local.set $${ptr} (i32.add (local.get $${ptr}) (i32.const 8)))
    ${WS()}
    (if (i32.eq ${PEEK} (i32.const 93))
      (then
        ${ADV(1)}
        (i32.store (i32.sub (local.get $${ptr}) (i32.const 8)) (i32.const 0))
        (i32.store (i32.sub (local.get $${ptr}) (i32.const 4)) (local.get $${cap}))
        (local.set $${out} (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $${ptr}))))
      (else
        (block $ad${id} (loop $al${id}
          (if (i32.ge_s (local.get $${len}) (local.get $${cap}))
            (then
              (local.set $${cap} (i32.shl (local.get $${cap}) (i32.const 1)))
              (local.set $${next} (call $__alloc (i32.add (i32.const 8) (i32.shl (local.get $${cap}) (i32.const 3)))))
              (local.set $${next} (i32.add (local.get $${next}) (i32.const 8)))
              (memory.copy (local.get $${next}) (local.get $${ptr}) (i32.shl (local.get $${len}) (i32.const 3)))
              (local.set $${ptr} (local.get $${next}))))
          ${parse(elem, val)}
          (f64.store (i32.add (local.get $${ptr}) (i32.shl (local.get $${len}) (i32.const 3))) (local.get $${val}))
          (local.set $${len} (i32.add (local.get $${len}) (i32.const 1)))
          ${WS()}
          (local.set $ch ${PEEK})
          (br_if $ad${id} (i32.eq (local.get $ch) (i32.const 93)))
          (if (i32.ne (local.get $ch) (i32.const 44)) (then ${fail}))
          ${ADV(1)}
          ${WS()}
          (br $al${id})))
        ${ADV(1)}
        (i32.store (i32.sub (local.get $${ptr}) (i32.const 8)) (local.get $${len}))
        (i32.store (i32.sub (local.get $${ptr}) (i32.const 4)) (local.get $${cap}))
        (local.set $${out} (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $${ptr})))))`
    }

    const out = local('out', 'f64')
    const body = `${parse(parsed, out)}
    ${WS()}
    (if (i32.ne ${PEEK} (i32.const -1)) (then ${fail}))
    (local.get $${out})`
    const localDecls = [...locals].map(([n, t]) => `    (local $${n} ${t})`).join('\n')
    ctx.core.stdlib[name] = `(func $${name} (param $str i64) (result f64)
${localDecls}
    (local.set $len (call $__str_byteLen (local.get $str)))
    (local.set $buf (call $__alloc (i32.add (local.get $len) (i32.const 8))))
    (i64.store (i32.add (local.get $buf) (local.get $len)) (i64.const -1))
    (if (i32.and (call $__ptr_aux (local.get $str)) (i32.const ${LAYOUT.SSO_BIT}))
      (then
        (local.set $i (i32.const 0))
        (block $sd (loop $sl
          (br_if $sd (i32.ge_s (local.get $i) (local.get $len)))
          (i32.store8 (i32.add (local.get $buf) (local.get $i))
            (call $__sso_char (local.get $str) (local.get $i)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $sl))))
      (else
        (memory.copy (local.get $buf) (call $__ptr_offset (local.get $str)) (local.get $len))))
    (global.set $__jpstr (local.get $buf))
    (global.set $__jplen (local.get $len))
    (global.set $__jppos (i32.const 0))
    ${body})`
    ctx.core.stdlibDeps[name] = ['__jp', '__jp_num', '__jp_str', '__str_byteLen', '__alloc', '__ptr_aux', '__sso_char', '__ptr_offset', '__alloc_hdr', '__mkptr']
    ctx.runtime.jsonShapeParsers.set(sig, name)
    return name
  }

  function shapeSignature(v) {
    if (v == null) return null
    if (typeof v === 'number') return 'number'
    if (typeof v === 'string') return 'string'
    if (typeof v === 'boolean') return 'boolean'
    if (Array.isArray(v)) return ['array', shapeSignature(v[0])]
    return ['object', Object.keys(v).map(k => [k, shapeSignature(v[k])])]
  }

  // Entry point — copies input to a scratch buffer with 0xFF sentinel padding
  // past the end so __jp_peek can omit its bounds check. Pad is 8 bytes so any
  // overshoot from speculative peek/adv on malformed input still hits sentinel,
  // not unallocated memory.
  ctx.core.stdlib['__jp'] = `(func $__jp (param $str i64) (result f64)
    (local $len i32) (local $buf i32) (local $i i32) (local $r f64)
    (local.set $len (call $__str_byteLen (local.get $str)))
    (local.set $buf (call $__alloc (i32.add (local.get $len) (i32.const 8))))
    ;; Pre-fill 8 sentinel bytes at end (writes overlapping a 64-bit slot).
    (i64.store (i32.add (local.get $buf) (local.get $len)) (i64.const -1))
    ;; SSO: byte-by-byte via __sso_char; heap STRING: bulk memcpy from string offset.
    (if (i32.and (call $__ptr_aux (local.get $str)) (i32.const ${LAYOUT.SSO_BIT}))
      (then
        (local.set $i (i32.const 0))
        (block $d (loop $l
          (br_if $d (i32.ge_s (local.get $i) (local.get $len)))
          (i32.store8 (i32.add (local.get $buf) (local.get $i))
            (call $__sso_char (local.get $str) (local.get $i)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $l))))
      (else
        (memory.copy (local.get $buf) (call $__ptr_offset (local.get $str)) (local.get $len))))
    (global.set $__jpstr (local.get $buf))
    (global.set $__jplen (local.get $len))
    (global.set $__jppos (i32.const 0))
    (global.set $__jp_err (i32.const 0))
    (local.set $r (call $__jp_val))
    ;; Any non-whitespace byte after the top-level value is a syntax error.
    ${WS()}
    (if (i32.ne ${PEEK} (i32.const -1)) (then (global.set $__jp_err (i32.const 1))))
    (if (global.get $__jp_err) (then (throw $__jz_err (f64.const 0))))
    (local.get $r))`

  // === Emitters ===

  // JSON.stringify(value [, replacer [, space ]]).
  //
  // Compile-time fold: when `value` is a fully-literal tree — and `replacer` /
  // `space` are likewise constant — the result is computed with the host
  // `JSON.stringify` and emitted as a single string constant. This is the
  // mirror of the `JSON.parse` const-fold: spec-exact (replacer-array filtering,
  // dedup, key order, indentation all come free from the host), and it removes
  // the runtime call entirely. The runtime `__stringify` path (which ignores a
  // replacer) handles every non-constant case unchanged.
  ctx.core.emit['JSON.stringify'] = (x, replacer, space) => {
    // An explicit `null`/`undefined` replacer is spec-equivalent to none; only a
    // real array/function replacer changes the result. (foldStringify normalizes
    // the same way via literalValue.) Used by both peepholes below.
    const noReplacer = replacer == null || literalValue(replacer) == null
    // BigInt has no JSON form — spec throws a TypeError. Emit the throw for the
    // statically-known cases (a top-level bigint expr, or a literal tree holding
    // one); the host fold can't render a bigint either. A function/array replacer
    // may rewrite the value, so defer to the fold/runtime path when one is present.
    if (noReplacer) {
      const lv = literalValue(x)
      if (valTypeOf(x) === VAL.BIGINT || (lv !== NOT_LIT && literalHasBigInt(lv))) {
        ctx.runtime.throws = true
        return typed(['block', ['result', 'f64'], ['throw', '$__jz_err', ['f64.const', 0]]], 'f64')
      }
    }
    const folded = foldStringify(x, replacer, space)
    if (folded !== undefined) return folded
    // Scalar boolean: the working-rep is the 0/1 number carrier, so the runtime
    // tag-walker would emit "0"/"1". A boolean's JSON is the bare word
    // true/false — exactly bool. Guard on no replacer: a replacer function may
    // rewrite the top-level value, in which case fall to runtime.
    if (noReplacer && valTypeOf(x) === VAL.BOOL) return bool(x)
    inc('__stringify')
    const spaceIR = asI64(space == null ? undefExpr() : emit(space))
    return typed(['call', '$__stringify', asI64(emit(x)), spaceIR], 'f64')
  }

  // Returns folded IR, or `undefined` when any argument is non-constant.
  function foldStringify(x, replacer, space) {
    // No replacer / no space: try the bool-aware AST string fold first so a
    // literal boolean renders as true/false on the self-host leg (see foldJsonStr).
    if (replacer == null && space == null) {
      const s = foldJsonStr(x)
      if (s !== NOT_LIT) return asF64(emit(['str', s]))
    }
    const val = literalValue(x)
    if (val === NOT_LIT) return undefined

    let rep
    if (replacer != null) {
      const rv = literalValue(replacer)
      if (rv === NOT_LIT) {
        const arr = jsonShapeStrings(ctx, replacer)   // const-bound string array
        if (arr == null) return undefined
        rep = arr
      } else if (rv == null) {
        rep = undefined                               // null / undefined replacer
      } else if (Array.isArray(rv)) {
        rep = rv
      } else {
        return undefined                              // function replacer — can't fold
      }
    }

    let sp
    if (space != null) {
      sp = literalValue(space)
      if (sp === NOT_LIT) return undefined
    }

    let result
    try { result = JSON.stringify(val, rep, sp) }
    catch { return undefined }
    return result === undefined ? undefExpr() : asF64(emit(['str', result]))
  }

  ctx.core.emit['JSON.parse'] = (x) => {
    // A non-string primitive literal argument is coerced via ToString, then
    // parsed: JSON.parse(0) → "0", JSON.parse(null) → "null", JSON.parse() →
    // "undefined" (which parses to a SyntaxError, the spec-correct outcome).
    // Literals reach the emitter as `[null, value]` nodes.
    if (x === undefined) x = ['str', 'undefined']
    else if (Array.isArray(x) && x[0] == null && typeof x[1] !== 'string')
      x = ['str', x[1] == null ? 'null' : String(x[1])]
    const src = jsonConstString(ctx, x)
    if (src != null) {
      try { return emitJsonConstValue(JSON.parse(src)) }
      catch { /* fall through to runtime parser for invalid JSON so runtime behavior stays unchanged */ }
    }
    // The runtime parser (and any shape parser that falls back to it) raises a
    // SyntaxError via $__jz_err on malformed input, so the throw tag must exist.
    ctx.runtime.throws = true
    const shapeSrcs = jsonShapeStrings(ctx, x)
    if (shapeSrcs) {
      try {
        const parsed = shapeSrcs.map(src => JSON.parse(src))
        if (!parsed.every(v => sameJsonShape(parsed[0], v))) throw new Error('mixed JSON shapes')
        const fn = emitJsonShapeParser(parsed[0])
        if (fn) { inc(fn); return typed(['call', `$${fn}`, asI64(emit(x))], 'f64') }
      } catch { /* fall through to generic runtime parser */ }
    }
    inc('__jp')
    const value = temp('jp_arg')
    const input = valTypeOf(x) === VAL.BOOL
      ? asI64(bool(x))
      : valTypeOf(x) === VAL.STRING
        ? ['i64.reinterpret_f64', ['local.get', `$${value}`]]
        : toStrI64(null, typed(['local.get', `$${value}`], 'f64'))
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${value}`, asF64(emit(x))],
      ['call', '$__jp', input]], 'f64')
  }
}
