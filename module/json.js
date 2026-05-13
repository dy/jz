/**
 * JSON module — JSON.stringify and JSON.parse.
 *
 * stringify: recursive type-dispatch → string assembly in scratch buffer.
 * parse: recursive descent parser using globals for input position.
 * Objects parsed as Map (dynamic keys). Arrays as standard jz arrays.
 *
 * @module json
 */

import { typed, asF64, asI64, temp, tempI32, nullExpr, allocPtr, slotAddr, mkPtrIR, extractF64Bits, appendStaticSlots, NULL_WAT } from '../src/ir.js'
import { emit } from '../src/emit.js'
import { T } from '../src/analyze.js'
import { err, inc, PTR, LAYOUT } from '../src/ctx.js'
import { strHashLiteral } from './collection.js'

function jsonConstString(ctx, expr) {
  if (Array.isArray(expr) && expr[0] === 'str' && typeof expr[1] === 'string') return expr[1]
  if (Array.isArray(expr) && expr[0] == null && typeof expr[1] === 'string') return expr[1]
  if (typeof expr === 'string') return ctx.scope.constStrs?.get(expr) ?? null
  return null
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
  Object.assign(ctx.core.stdlibDeps, {
    __stringify: ['__json_val', '__jput', '__jput_str', '__jput_num', '__mkstr'],
    __json_val: ['__ptr_type', '__len', '__ptr_offset', '__jput', '__jput_num', '__jput_str', '__json_hash', '__json_obj'],
    __json_hash: ['__ptr_offset', '__jput', '__jput_str', '__json_val'],
    __json_obj: ['__ptr_offset', '__ptr_aux', '__len', '__jput', '__jput_str', '__json_val'],
    __jput_num: ['__ftoa'],
    __jput_str: ['__char_at', '__str_byteLen'],
    __jp: ['__jp_val', '__jp_str', '__jp_num', '__jp_arr', '__jp_obj', '__sso_char', '__ptr_aux', '__ptr_type', '__ptr_offset', '__str_byteLen'],
    __jp_val: ['__jp_str', '__jp_num', '__jp_arr', '__jp_obj'],
    __jp_str: ['__sso_char', '__char_at', '__str_byteLen', '__hex4', '__utf8_enc'],
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
    if (typeof v === 'boolean') return asF64(emit(v ? 1 : 0))
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
        return mkPtrIR(PTR.OBJECT, 0, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', 1]])
      }
      const schemaId = ctx.schema.register(keys)
      const t = tempI32('jobj')
      const body = [
        ['local.set', `$${t}`, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', keys.length]]],
      ]
      for (let i = 0; i < keys.length; i++) {
        body.push(['f64.store', slotAddr(t, i), asF64(emitJsonConstValue(v[keys[i]]))])
      }
      body.push(mkPtrIR(PTR.OBJECT, schemaId, ['local.get', `$${t}`]))
      return typed(['block', ['result', 'f64'], ...body], 'f64')
    }
    return asF64(emit(nullExpr))
  }


  // === JSON.stringify ===

  // Scratch buffer approach: __json_buf is a growable output buffer.
  // Functions append bytes to it, __json_pos tracks current write position.

  ctx.scope.globals.set('__jbuf', '(global $__jbuf (mut i32) (i32.const 0))')
  ctx.scope.globals.set('__jpos', '(global $__jpos (mut i32) (i32.const 0))')
  ctx.scope.globals.set('__jcap', '(global $__jcap (mut i32) (i32.const 0))')
  ctx.scope.globals.set('__schema_tbl', '(global $__schema_tbl (mut i32) (i32.const 0))')

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

  // __jput_str(ptr: i64) — append string chars (without quotes) to buffer
  ctx.core.stdlib['__jput_str'] = `(func $__jput_str (param $ptr i64)
    (local $len i32) (local $i i32) (local $ch i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $i) (local.get $len)))
      (local.set $ch (call $__char_at (local.get $ptr) (local.get $i)))
      ;; Escape special JSON chars
      (if (i32.le_u (local.get $ch) (i32.const 13))
        (then
          (if (i32.eq (local.get $ch) (i32.const 10)) (then (call $__jput (i32.const 92)) (call $__jput (i32.const 110)))
          (else (if (i32.eq (local.get $ch) (i32.const 13)) (then (call $__jput (i32.const 92)) (call $__jput (i32.const 114)))
          (else (if (i32.eq (local.get $ch) (i32.const 9)) (then (call $__jput (i32.const 92)) (call $__jput (i32.const 116)))
          (else (if (i32.eq (local.get $ch) (i32.const 8)) (then (call $__jput (i32.const 92)) (call $__jput (i32.const 98)))
          (else (if (i32.eq (local.get $ch) (i32.const 12)) (then (call $__jput (i32.const 92)) (call $__jput (i32.const 102)))
            (else (call $__jput (local.get $ch)))))))))))))
        (else
          (if (i32.eq (local.get $ch) (i32.const 34)) (then (call $__jput (i32.const 92)) (call $__jput (i32.const 34)))
          (else (if (i32.eq (local.get $ch) (i32.const 92)) (then (call $__jput (i32.const 92)) (call $__jput (i32.const 92)))
            (else (call $__jput (local.get $ch))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))`

  // __jput_num(val: f64) — convert number to string, append bytes to buffer
  ctx.core.stdlib['__jput_num'] = `(func $__jput_num (param $val f64)
    (call $__jput_str (i64.reinterpret_f64 (call $__ftoa (local.get $val) (i32.const 0) (i32.const 0)))))`

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
        (call $__jput (i32.const 91))  ;; [
        (local.set $len (call $__len (local.get $val)))
        (local.set $off (call $__ptr_offset (local.get $val)))
        (local.set $i (i32.const 0))
        (block $d (loop $l
          (br_if $d (i32.ge_s (local.get $i) (local.get $len)))
          (if (local.get $i) (then (call $__jput (i32.const 44))))  ;; ,
          (call $__json_val (i64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $l)))
        (call $__jput (i32.const 93))  ;; ]
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

  // __json_hash(val: i64) — stringify HASH/MAP: iterate slots, emit {"key":val,...}
  // Slot layout: 24 bytes each — [hash:f64][key:f64][val:f64]. Empty slots have hash==0.
  ctx.core.stdlib['__json_hash'] = `(func $__json_hash (param $val i64)
    (local $off i32) (local $cap i32) (local $i i32) (local $slot i32) (local $first i32)
    (local.set $off (call $__ptr_offset (local.get $val)))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $first (i32.const 1))
    (call $__jput (i32.const 123))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $i) (local.get $cap)))
      (local.set $slot (i32.add (local.get $off) (i32.mul (local.get $i) (i32.const 24))))
      (if (f64.ne (f64.load (local.get $slot)) (f64.const 0))
        (then
          (if (i32.eqz (local.get $first))
            (then (call $__jput (i32.const 44))))
          (local.set $first (i32.const 0))
          (call $__jput (i32.const 34))
          (call $__jput_str (i64.load (i32.add (local.get $slot) (i32.const 8))))
          (call $__jput (i32.const 34))
          (call $__jput (i32.const 58))
          (call $__json_val (i64.load (i32.add (local.get $slot) (i32.const 16))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (call $__jput (i32.const 125)))`

  // __json_obj(val: f64) — stringify OBJECT using runtime schema name table.
  // Schema name table: global $__schema_tbl → array of f64 pointers.
  //   schema_tbl[schemaId * 8] = f64 pointer to jz Array of key name strings.
  // Object props are sequential f64 at ptr_offset, indexed same as schema.
  ctx.core.stdlib['__json_obj'] = `(func $__json_obj (param $val i64)
    (local $off i32) (local $sid i32) (local $keys i32) (local $nkeys i32)
    (local $i i32) (local $koff i32)
    (local.set $off (call $__ptr_offset (local.get $val)))
    (local.set $sid (call $__ptr_aux (local.get $val)))
    ;; Load keys array from schema table: schema_tbl + sid * 8
    (local.set $keys (call $__ptr_offset
      (i64.load (i32.add (global.get $__schema_tbl) (i32.shl (local.get $sid) (i32.const 3))))))
    (local.set $nkeys (call $__len
      (i64.load (i32.add (global.get $__schema_tbl) (i32.shl (local.get $sid) (i32.const 3))))))
    (local.set $koff (local.get $keys))
    (call $__jput (i32.const 123))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $i) (local.get $nkeys)))
      (if (local.get $i) (then (call $__jput (i32.const 44))))
      (call $__jput (i32.const 34))
      (call $__jput_str (i64.load (i32.add (local.get $koff) (i32.shl (local.get $i) (i32.const 3)))))
      (call $__jput (i32.const 34))
      (call $__jput (i32.const 58))
      (call $__json_val (i64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (call $__jput (i32.const 125)))`

  // __stringify(val: i64) → f64 (NaN-boxed string)
  ctx.core.stdlib['__stringify'] = `(func $__stringify (param $val i64) (result f64)
    ;; Reset output buffer
    (global.set $__jbuf (call $__alloc (i32.const 256)))
    (global.set $__jpos (i32.const 0))
    (global.set $__jcap (i32.const 256))
    (call $__json_val (local.get $val))
    ;; Create string from buffer
    (call $__mkstr (global.get $__jbuf) (global.get $__jpos)))`

  // === JSON.parse ===

  ctx.scope.globals.set('__jpstr', '(global $__jpstr (mut i32) (i32.const 0))')  // input string offset
  ctx.scope.globals.set('__jplen', '(global $__jplen (mut i32) (i32.const 0))')  // input length
  ctx.scope.globals.set('__jppos', '(global $__jppos (mut i32) (i32.const 0))')  // current parse position
  // Side-channel hash for the most-recently-parsed string. __jp_str folds an
  // FNV-1a pass into its scan loop; __jp_obj forwards it to __hash_set_local_h
  // and skips the redundant __str_hash call inside the generic insert. 0 is a
  // sentinel meaning "string had escapes — recompute via __str_hash".
  ctx.scope.globals.set('__jp_keyh', '(global $__jp_keyh (mut i32) (i32.const 0))')
  // Runtime schema infrastructure. __schema_next points at the first free slot
  // in $__schema_tbl reserved for runtime registration; compile.js initializes
  // it to ctx.schema.list.length when __jp_obj is included. The schema cache
  // is a 64-entry open-addressed hash on key-sequence FNV — repeated parses of
  // the same shape reuse a previously-registered sid, so __jp_obj allocates a
  // fresh-shape OBJECT once and converts to slot stores thereafter (skipping
  // every __hash_set_local). Cache slot layout: i32 hash, i32 sid (8 bytes).
  // Hash 0 = empty slot; we bump <=1 to 2 like __str_hash to avoid sentinel
  // collision with valid hashes.
  ctx.scope.globals.set('__schema_next', '(global $__schema_next (mut i32) (i32.const 0))')
  ctx.scope.globals.set('__schema_cache', '(global $__schema_cache (mut i32) (i32.const 0))')

  // Sentinel-driven peek: __jp copies input to a scratch buffer with 0xFF bytes
  // appended past the end. i32.load8_s sign-extends, so the sentinel reads as -1
  // — exactly the EOF value all callers already test for. Inlined into every
  // parser body via PEEK/ADV string templates; the per-char function-call
  // overhead (~50 calls/char in well-formed JSON) was the dominant cost.
  const PEEK = `(i32.load8_s (i32.add (global.get $__jpstr) (global.get $__jppos)))`
  const ADV = (n) => `(global.set $__jppos (i32.add (global.get $__jppos) (i32.const ${n})))`

  // Whitespace skip — inlined at every call site as a tight loop. Compact
  // JSON often has zero whitespace between tokens, so the dominant case is
  // a single peek + break. WS chars (9/10/13/32) all fit in [0..32]; we
  // exit on anything > 32 unsigned. The sentinel byte (PEEK returns -1
  // sign-extended) is 0xFFFFFFFF unsigned — > 32 — so the same check
  // handles EOF without a separate guard. Other control chars in [0..8],
  // [11..12], [14..31] would be falsely consumed as WS, but those aren't
  // valid in well-formed JSON anyway.
  let WS_ID = 0
  const WS = () => {
    const id = WS_ID++
    return `(block $jpws_d${id} (loop $jpws_l${id}
      (br_if $jpws_d${id} (i32.gt_u ${PEEK} (i32.const 32)))
      ${ADV(1)}
      (br $jpws_l${id})))`
  }

  // Parse string (after opening " consumed). Single-pass scan that folds three
  // concerns into one byte loop: simplicity flag (no escapes / no high-bit),
  // SSO byte packing for ≤4-char ASCII keys, and FNV-1a hash. The hash is
  // stashed in $__jp_keyh so __jp_obj can use the prehashed insert and skip
  // a redundant __str_hash call.
  // Hex nibble: '0'-'9' / 'a'-'f' / 'A'-'F' → 0..15; anything else → 0 (lenient).
  ctx.core.stdlib['__hex1'] = `(func $__hex1 (param $c i32) (result i32)
    (if (i32.le_u (i32.sub (local.get $c) (i32.const 48)) (i32.const 9))
      (then (return (i32.sub (local.get $c) (i32.const 48)))))
    (if (i32.le_u (i32.sub (i32.or (local.get $c) (i32.const 0x20)) (i32.const 97)) (i32.const 5))
      (then (return (i32.sub (i32.or (local.get $c) (i32.const 0x20)) (i32.const 87)))))
    (i32.const 0))`

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
      ;; Mark non-simple: escape (\\=92) or non-ASCII (load8_s gives <0 for byte≥128).
      (if (i32.or (i32.eq (local.get $ch) (i32.const 92)) (i32.lt_s (local.get $ch) (i32.const 0)))
        (then (local.set $simple (i32.const 0))))
      (if (i32.eq (local.get $ch) (i32.const 92))
        (then
          (local.set $len (i32.add (local.get $len) (i32.const 1)))
          ${ADV(2)})
        (else
          ;; Pack first 4 bytes into SSO slot (used only when len ≤ 4).
          (if (i32.lt_u (local.get $len) (i32.const 4))
            (then (local.set $sso
              (i32.or (local.get $sso)
                (i32.shl (i32.and (local.get $ch) (i32.const 0xFF))
                  (i32.shl (local.get $len) (i32.const 3)))))))
          (local.set $h (i32.mul (i32.xor (local.get $h) (i32.and (local.get $ch) (i32.const 0xFF))) (i32.const 0x01000193)))
          (local.set $len (i32.add (local.get $len) (i32.const 1)))
          ${ADV(1)}))
      (br $l)))
    ;; Stash hash. 0/1 bumped to 2 to match __str_hash convention; escape strings
    ;; (simple==0) get sentinel 0 so __jp_obj falls back to non-prehashed insert.
    (global.set $__jp_keyh
      (if (result i32) (local.get $simple)
        (then (if (result i32) (i32.le_s (local.get $h) (i32.const 1))
          (then (i32.add (local.get $h) (i32.const 2))) (else (local.get $h))))
        (else (i32.const 0))))
    ${ADV(1)}  ;; skip "
    ;; SSO fast path: ≤4 ASCII chars, no escapes — bytes already packed inline.
    (if (i32.and (local.get $simple) (i32.le_u (local.get $len) (i32.const 4)))
      (then
        (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.or (i32.const ${LAYOUT.SSO_BIT}) (local.get $len)) (local.get $sso)))))
    ;; Simple STRING fast path: no escapes, len > 4 — bulk memcpy from parse buffer,
    ;; skip rewind + per-byte escape-decode loop. Hits 5+ char keys without escapes.
    (if (local.get $simple)
      (then
        (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $len))))
        (local.set $off (i32.add (local.get $off) (i32.const 4)))
        (i32.store (i32.sub (local.get $off) (i32.const 4)) (local.get $len))
        (memory.copy (local.get $off) (i32.add (global.get $__jpstr) (local.get $start)) (local.get $len))
        (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $off)))))
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
              (local.set $cp (call $__hex4 (i32.add (global.get $__jpstr) (global.get $__jppos))))
              ${ADV(4)}
              ;; High surrogate immediately followed by \\uXXXX low surrogate → combine.
              (if (i32.and
                    (i32.eq (i32.and (local.get $cp) (i32.const 0xFC00)) (i32.const 0xD800))
                    (i32.and (i32.eq ${PEEK} (i32.const 92))
                             (i32.eq (i32.load8_u (i32.add (global.get $__jpstr) (i32.add (global.get $__jppos) (i32.const 1)))) (i32.const 117))))
                (then
                  ${ADV(2)}
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
    (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $off)))`

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
      (if (i32.eq (local.get $ch) (i32.const 44)) (then ${ADV(1)}))
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

  // Parse object → OBJECT (schema-tagged, slot-based) when key sequence has a
  // cached/registerable shape; falls back to HASH only on extreme key counts.
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
      (if (i32.eq (local.get $ch) (i32.const 44)) (then ${ADV(1)}))
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
    (if (i32.eq (local.get $ch) (i32.const 116))
      (then ${ADV(4)} (return (f64.const 1))))
    (if (i32.eq (local.get $ch) (i32.const 102))
      (then ${ADV(5)} (return (f64.const 0))))
    (if (i32.eq (local.get $ch) (i32.const 110))
      (then ${ADV(4)} (return ${NULL_WAT})))
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
    const parse = (v, out) => {
      if (v == null) return `${expectText('null')}
    (local.set $${out} ${NULL_WAT})`
      if (typeof v === 'boolean') return `${expectText(v ? 'true' : 'false')}
    (local.set $${out} (f64.const ${v ? 1 : 0}))`
      if (typeof v === 'number') return `(local.set $${out} (call $__jp_num))`
      if (typeof v === 'string') return `${expect(34)}
    (local.set $${out} (call $__jp_str))`
      if (Array.isArray(v)) return parseArray(v[0], out)
      return parseObject(v, out)
    }
    const parseObject = (v, out) => {
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
    const parseArray = (elem, out) => {
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
    (local $len i32) (local $buf i32) (local $i i32)
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
    (call $__jp_val))`

  // === Emitters ===

  ctx.core.emit['JSON.stringify'] = (x) => {
    inc('__stringify')
    return typed(['call', '$__stringify', asI64(emit(x))], 'f64')
  }

  ctx.core.emit['JSON.parse'] = (x) => {
    const src = jsonConstString(ctx, x)
    if (src != null) {
      try { return emitJsonConstValue(JSON.parse(src)) }
      catch { /* fall through to runtime parser for invalid JSON so runtime behavior stays unchanged */ }
    }
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
    return typed(['call', '$__jp', asI64(emit(x))], 'f64')
  }
}
