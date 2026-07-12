/**
 * String module — literals, char access, and string methods.
 *
 * Type=4 (STRING) covers both encodings; aux bit LAYOUT.SSO_BIT discriminates:
 *   bit clear: heap-allocated, length in header [-4:len], offset → bytes.
 *   bit set:   inline ≤6 ASCII chars packed in the payload (no memory),
 *              length at payload bits 42-44.
 *
 * INVARIANT (load-bearing): every producer normalizes a ≤6-byte all-ASCII result
 * to SSO — literals, slices, concat, append, case, pad, repeat, number/JSON/URI
 * formatting, byte decode, host marshaling (interop.js). Consequence: two strings
 * where exactly one is SSO can never be content-equal, so `__str_eq` decides any
 * mixed compare by bits alone and `x === 'shortLit'` lowers to a bare i64.eq
 * (emit.js emitLooseEq). Breaking the invariant in ONE producer silently breaks
 * string equality — new string constructors MUST route short ASCII results
 * through SSO (see __sso_norm / the concat short-pack).
 *
 * Methods use type-qualified keys (.string:slice) for array-colliding names,
 * generic keys (.toUpperCase) for non-colliding ones.
 *
 * @module string
 */

import { typed, asF64, asI32, asI64, NULL_NAN, UNDEF_NAN, FALSE_NAN, TRUE_NAN, mkPtrIR, temp, tempI32, toNumF64, toStrI64 } from '../src/ir.js'
import { emit, bool, method, deps, wat, bind } from '../src/bridge.js'
import { valTypeOf } from '../src/kind.js'
import { VAL } from '../src/reps.js'
import { ctx, inc, PTR, LAYOUT, err, declGlobal } from '../src/ctx.js'
import { ssoBitI64Hex, sliceBitI64Hex, hcacheBitI64Hex, ptrNanHex, STR_INTERN_BIT, STR_HCACHE_BIT } from '../layout.js'

const SSO_BIT_I64 = ssoBitI64Hex()
const SLICE_BIT_I64 = sliceBitI64Hex()
const HCACHE_BIT_I64 = hcacheBitI64Hex()
// (SSO_BIT | SLICE_BIT) << AUX_SHIFT as i64 hex — BigInt-free (self-host runs this)
const SSO_SLICE_I64 = '0x' + (LAYOUT.SSO_BIT | LAYOUT.SLICE_BIT).toString(16) + '00000000'

// === SSO codec — single source of truth for the inline-string bit layout ===
// ASCII chars packed at 7 bits each into the NaN-box payload: char i at payload bit
// i*7  (uniform `(ptr >> i*7) & 0x7f`), length at payload bits 42-44, SSO_BIT at bit 46
// (SLICE_BIT at 45 stays 0). 6 chars fit (6*7=42, + 3-bit len). ASCII-only — a byte
// ≥0x80 falls back to a heap string. The 7-bit-uniform layout makes equal short strings
// content-bit-equal (so `op === 'tag'` is a bare i64.eq) and never touches memory.
export const MAX_SSO = 6
const SSO_LEN_SHIFT = 10  // length occupies aux bits 10-12 (= payload bits 42-44)
const SSO_CHAR_MASK = '0x3ffffffffff'  // payload bits 0-41: the 6 × 7-bit char lanes
// JS: ASCII string → { aux, offset }, or null when ineligible (too long / non-ASCII).
// BigInt-free (i32 ops only) so the self-hosted compiler — which runs this to encode
// every string literal — stays on jz's numeric core. offset = payload bits 0-31, aux =
// bits 32-46; char i at bit i*7 (chars 0-3 fit the offset, char 4 straddles, char 5 → aux).
// Exported: collection.js's strHashLiteral reuses this to build the exact lo/hi pair
// __str_hash's SSO branch mixes — single source of truth for the packing (see its use).
export const ssoEncode = (str) => {
  if (str.length > MAX_SSO || !/^[\x00-\x7f]*$/.test(str)) return null
  let offset = 0, auxChars = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i), bit = i * 7
    if (bit <= 24) offset |= c << bit                 // chars 0-3 (bits 0-27), wholly in offset
    else if (bit < 32) { offset |= (c & 0xF) << 28; auxChars |= c >> 4 }  // char 4: bits 28-34 straddle
    else auxChars |= c << (bit - 32)                  // char 5: bits 35-41 → aux bits 3-9
  }
  return { aux: LAYOUT.SSO_BIT | (str.length << SSO_LEN_SHIFT) | auxChars, offset: offset >>> 0 }
}
// aux for an SSO string whose chars all fit in the offset (len ≤ 4: 4*7=28 ≤ 32 bits).
const ssoAux = (len) => LAYOUT.SSO_BIT | (len << SSO_LEN_SHIFT)
// WAT: char i (i32 expr) of SSO ptr (i64 expr) — 7-bit at payload bit i*7.
const ssoCharWat = (ptr, i) => `(i32.wrap_i64 (i64.and (i64.shr_u ${ptr} (i64.mul (i64.extend_i32_u ${i}) (i64.const 7))) (i64.const 0x7f)))`
// WAT: length (i32) of SSO ptr (i64 expr) — payload bits 42-44.
const ssoLenWat = (ptr) => `(i32.wrap_i64 (i64.and (i64.shr_u ${ptr} (i64.const 42)) (i64.const 7)))`
// WAT: length (i32) from an already-extracted aux (i32 expr).
const ssoLenFromAux = (aux) => `(i32.and (i32.shr_u ${aux} (i32.const ${SSO_LEN_SHIFT})) (i32.const 7))`

// WAT (no-locals expression): byte length of a heap STRING given its raw $-local
// names for the offset and the i64 ptr. A view (SLICE_BIT) carries its length in
// aux[12:0]; an own heap string reads the i32 header at off-4. Callers must have
// already excluded SSO. Used inline by the hot char/eq helpers so a slice never
// reads a bogus length out of a parent buffer's bytes.
const heapLenExpr = (ptrLocal, offLocal) => `(if (result i32)
  (i64.ne (i64.and (local.get ${ptrLocal}) (i64.const ${SLICE_BIT_I64})) (i64.const 0))
  (then (i32.and
    (i32.wrap_i64 (i64.shr_u (local.get ${ptrLocal}) (i64.const ${LAYOUT.AUX_SHIFT})))
    (i32.const ${LAYOUT.SLICE_LEN_MASK})))
  (else (if (result i32) (i32.ge_u (local.get ${offLocal}) (i32.const 4))
    (then (i32.load (i32.sub (local.get ${offLocal}) (i32.const 4))))
    (else (i32.const 0)))))`



// SSO-pack a ≤4-byte slice straight from the source bytes (both SSO and
// memory-backed parents) — no allocation, and equal short tokens become
// bit-equal (SSO content IS the bits). Bails to the caller's heap path on a
// non-ASCII byte (SSO is ASCII-only). Locals: $sb scratch byte, $sp packed.
const sliceSsoPackWat = () => `
    (if (i32.le_u (local.get $nlen) (i32.const ${MAX_SSO}))
      (then (block $heap8
        (local.set $srcOff (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK}))))
        (local.set $isSso (i32.wrap_i64 (i64.shr_u
          (i64.and (local.get $ptr) (i64.const ${SSO_BIT_I64}))
          (i64.const ${LAYOUT.AUX_SHIFT}))))
        (local.set $i (i32.const 0)) (local.set $sp64 (i64.const 0))
        (loop $pk7
          (if (i32.lt_u (local.get $i) (local.get $nlen))
            (then
              (local.set $sb (if (result i32) (local.get $isSso)
                (then ${ssoCharWat('(local.get $ptr)', '(i32.add (local.get $start) (local.get $i))')})
                (else (i32.load8_u (i32.add (i32.add (local.get $srcOff) (local.get $start)) (local.get $i))))))
              (br_if $heap8 (i32.ge_u (local.get $sb) (i32.const 0x80)))
              (local.set $sp64 (i64.or (local.get $sp64)
                (i64.shl (i64.extend_i32_u (local.get $sb)) (i64.mul (i64.extend_i32_u (local.get $i)) (i64.const 7)))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $pk7))))
        (return (f64.reinterpret_i64 (i64.or (i64.or
          (i64.const ${ptrNanHex(PTR.STRING, LAYOUT.SSO_BIT)})
          (i64.shl (i64.extend_i32_u (local.get $nlen)) (i64.const 42)))
          (local.get $sp64)))))))`

// Probe the static intern index (buildInternTable, compile/index.js): a 5..32
// byte slice whose content equals a static literal returns the CANONICAL
// static pointer, making every later comparison a bit-eq hit. Emitted only
// when the table exists ($__internBase declared — the stdlib body is a thunk
// evaluated at pullStdlib, after buildInternTable). FNV-1a must match
// __str_hash's heap branch. Locals: $ip src ptr, $h, $j, $slot, $cand, $k.
const internProbeWat = (ipExpr, guard = '(i32.const 1)') => ctx.scope.globals.has('__internBase') ? `
    (if (i32.and (i32.le_u (local.get $nlen) (i32.const 32)) ${guard})
      (then
        (local.set $ip ${ipExpr})
        (local.set $h (i32.const 0x811c9dc5))
        (local.set $j (i32.const 0))
        (block $hd (loop $hl
          (br_if $hd (i32.ge_u (local.get $j) (local.get $nlen)))
          (local.set $h (i32.mul
            (i32.xor (local.get $h) (i32.load8_u (i32.add (local.get $ip) (local.get $j))))
            (i32.const 0x01000193)))
          (local.set $j (i32.add (local.get $j) (i32.const 1)))
          (br $hl)))
        (if (i32.le_s (local.get $h) (i32.const 1))
          (then (local.set $h (i32.add (local.get $h) (i32.const 2)))))
        (local.set $j (i32.and (local.get $h) (global.get $__internMask)))
        (block $missI (loop $plI
          (block $nextI
            (local.set $slot (i32.add (global.get $__internBase) (i32.shl (local.get $j) (i32.const 3))))
            (local.set $cand (i32.load (i32.add (local.get $slot) (i32.const 4))))
            (br_if $missI (i32.eqz (local.get $cand)))
            (br_if $nextI (i32.ne (i32.load (local.get $slot)) (local.get $h)))
            (br_if $nextI (i32.ne (i32.load (i32.sub (local.get $cand) (i32.const 4))) (local.get $nlen)))
            (local.set $k (i32.const 0))
            (block $vd (loop $vl
              (br_if $vd (i32.ge_u (local.get $k) (local.get $nlen)))
              (br_if $nextI (i32.ne
                (i32.load8_u (i32.add (local.get $ip) (local.get $k)))
                (i32.load8_u (i32.add (local.get $cand) (local.get $k)))))
              (local.set $k (i32.add (local.get $k) (i32.const 1)))
              (br $vl)))
            (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${STR_INTERN_BIT}) (local.get $cand))))
          (local.set $j (i32.and (i32.add (local.get $j) (i32.const 1)) (global.get $__internMask)))
          (br $plI)))))` : ''


export default (ctx) => {
  deps({
    __str_concat: ['__to_str', '__str_byteLen', '__alloc', '__memgrow', '__mkptr', '__str_copy'],
    __str_concat_raw: ['__str_byteLen', '__alloc', '__memgrow', '__mkptr', '__str_copy'],
    __str_concat_fresh: ['__to_str', '__str_byteLen', '__alloc', '__mkptr', '__str_copy'],
    __str_concat_raw_fresh: ['__str_byteLen', '__alloc', '__mkptr', '__str_copy'],
    __str_append_byte: ['__str_byteLen', '__alloc', '__memgrow', '__mkptr', '__str_copy'],
    __str_copy: [],
    // __str_slice/_view are FUNCTION templates: resolveIncludes' auto-dep scan realizes the
    // factory (v()) to discover body calls, but that realization DIVERGES under self-host
    // (jz.wasm) — so a body-called helper not also listed here is dropped from the kernel
    // ("Unknown func $__clamp_idx" on `str.slice`). FN templates must declare body deps
    // manually; pinned by test/selfhost-includes.js.
    __str_slice: ['__str_byteLen', '__alloc', '__clamp_idx', '__mkptr'],
    __str_slice_view: ['__str_byteLen', '__mkptr', '__str_slice', '__clamp_idx'],
    __str_indexof: ['__str_byteLen'],
    __str_lastindexof: ['__str_byteLen'],
    __wrap1: ['__alloc', '__mkptr'],
    __str_substring: ['__str_slice'],
    __str_startswith: ['__str_byteLen'],
    __str_endswith: ['__str_byteLen'],
    __str_case: ['__str_byteLen', '__alloc'],
    __str_trim: ['__str_slice', '__str_byteLen', '__char_at'],
    __str_trimStart: ['__str_slice', '__str_byteLen', '__char_at'],
    __str_trimEnd: ['__str_slice', '__str_byteLen', '__char_at'],
    __str_repeat: ['__str_byteLen', '__str_copy', '__alloc', '__sso_norm'],
    __str_replace: ['__str_indexof', '__str_slice', '__str_concat'],
    __str_replaceall: ['__str_indexof', '__str_slice', '__str_concat'],
    __str_split: ['__str_slice', '__str_byteLen', '__char_at', '__alloc'],
    __str_idx: ['__char1byte'],
    __sso_norm: [],
    __bytes_decode: ['__ptr_offset', '__len', '__alloc', '__mkptr', '__sso_norm'],
    __str_eq: ['__str_eq_cold'],
    __str_eq_cold: ['__char_at', '__str_byteLen'],
    __str_cmp: ['__char_at', '__str_byteLen'],
    __str_range_eq: ['__char_at', '__str_byteLen'],
    __str_substring_eq: ['__str_byteLen', '__str_range_eq'],
    __str_slice_eq: ['__str_byteLen', '__str_range_eq', '__clamp_idx'],  // body-calls __clamp_idx; declare it (self-host auto-scan unreliable — test/selfhost-includes.js)
    __str_pad: ['__str_byteLen', '__str_copy', '__alloc'],
    __str_join: ['__str_concat', '__to_str', '__str_byteLen', '__len', '__ptr_offset', '__mkptr'],  // FN template: __mkptr body-called, must be manual (self-host auto-scan diverges)
    __str_encode: ['__str_byteLen', '__str_copy'],
    __encodeURIComponent: ['__to_str', '__str_byteLen', '__char_at', '__alloc', '__mkptr', '__sso_norm'],
    __decodeURIComponent: ['__to_str', '__str_byteLen', '__char_at', '__alloc', '__mkptr', '__uri_hex', '__sso_norm'],
    __uri_hex: [],
    __to_str: ['__ftoa', '__static_str', '__str_join', '__mkptr'],
    __str_byteLen: ['__ptr_type', '__ptr_aux', '__str_len'],
  })

  // String *runtime* construction (concat/slice/split/`String(n)`/shared-memory
  // pools) allocates and boxes pointers, so the module eagerly declares its core
  // heap deps — same as object.js / typedarray.js / array.js. Several such helpers
  // (`__str_slice`, `__str_split`, `__str_case`, …) call `$__mkptr`/`$__alloc` only
  // through nested template thunks (sliceSsoPackWat/internProbeWat); resolveIncludes'
  // auto-derivation realizes those thunks to recover the dep, but that re-realization
  // is not reliable under self-host (the jz.wasm kernel re-runs the thunk late, with
  // intern/heap state the native run never reaches), so a runtime string op would
  // emit `call $__mkptr` with no definition. Declaring the deps explicitly here makes
  // inclusion independent of thunk re-realization. Reachability pruning still drops
  // both for a literals-only module (no `__mkptr`/`__alloc` call site → unreachable),
  // so a heap-free program stays heap-free — no allocator, no memory, no exports.
  inc('__mkptr', '__alloc')

  // === String literal: "abc" → SSO if ≤6 ASCII, else static data ===

  bind('str', (str) => {
    if (ctx.features.sso) {
      const sso = ssoEncode(str)
      if (sso) return mkPtrIR(PTR.STRING, sso.aux, sso.offset)
    }
    // Falls through to the static-data path below ONLY when ssoEncode returned null
    // (>6 bytes or non-ASCII) — so an interned static NEVER carries ≤6-ASCII content,
    // and its cached hash (below) stays byte-FNV without needing the SSO mix
    // (__str_hash's SSO branch, module/collection.js, never sees an interned pointer).
    const bytes = new TextEncoder().encode(str)
    const len = bytes.length
    if (!ctx.memory.shared) {
      // Own memory: place in static data segment (no runtime allocation).
      // Under internStrings the layout is [hash u32][len u32][bytes] and the
      // pointer carries STR_INTERN_BIT: statics are CANONICAL (deduped), so
      // unequal canonicals are bit-unequal (__str_eq short-circuit) and
      // __str_hash loads the cached FNV at -8 instead of re-hashing. The len
      // header stays at -4 either way — no other reader changes.
      const interned = !!ctx.transform.optimize?.internStrings
      const hdr = interned ? 8 : 4
      const aux = interned ? STR_INTERN_BIT : 0
      if (!ctx.runtime.data) ctx.runtime.data = ''
      const prior = ctx.runtime.dataDedup.get(str)
      if (prior !== undefined) return mkPtrIR(PTR.STRING, aux, prior + hdr)
      while (ctx.runtime.data.length % 4 !== 0) ctx.runtime.data += '\0'
      const offset = ctx.runtime.data.length
      if (interned) {
        // byte-FNV + clamp — must equal __str_hash's output exactly (it hashes
        // UTF-8 bytes, then clamps ≤1 → +2 for the empty/tombstone sentinels).
        // Always the byte-FNV branch, never the SSO mix: this string is here
        // because ssoEncode rejected it (see the guard above).
        let h = 0x811c9dc5 | 0
        for (let i = 0; i < len; i++) h = Math.imul(h ^ bytes[i], 0x01000193) | 0
        if (h <= 1) h = (h + 2) | 0
        h = h >>> 0
        ctx.runtime.data += String.fromCharCode(h & 0xFF, (h >> 8) & 0xFF, (h >> 16) & 0xFF, (h >> 24) & 0xFF)
      }
      ctx.runtime.data += String.fromCharCode(len & 0xFF, (len >> 8) & 0xFF, (len >> 16) & 0xFF, (len >> 24) & 0xFF)
      for (let i = 0; i < len; i++) ctx.runtime.data += String.fromCharCode(bytes[i])
      ctx.runtime.dataDedup.set(str, offset)
      return mkPtrIR(PTR.STRING, aux, offset + hdr)
    }
    // Shared memory: pack all string literals into one passive data segment with 4-byte
    // length prefixes. At __start, alloc the whole pool once and memory.init it in a single
    // call. Each use site resolves to `strBase + compile-time-offset` — O(1) IR nodes per
    // use, independent of string length AND reused across uses.
    if (!ctx.runtime.strPool) {
      ctx.runtime.strPool = ''
      declGlobal('__strBase', 'i32')
    }
    let off = ctx.runtime.strPoolDedup.get(str)
    if (off === undefined) {
      // Pack length header then UTF-8 bytes; offset points PAST the length (at the data).
      ctx.runtime.strPool += String.fromCharCode(len & 0xFF, (len >> 8) & 0xFF, (len >> 16) & 0xFF, (len >> 24) & 0xFF)
      off = ctx.runtime.strPool.length
      for (let i = 0; i < len; i++) ctx.runtime.strPool += String.fromCharCode(bytes[i])
      ctx.runtime.strPoolDedup.set(str, off)
    }
    return mkPtrIR(PTR.STRING, 0, ['i32.add', ['global.get', '$__strBase'], ['i32.const', off]])
  })

  // === WAT: char extraction ===

  // SSO/STRING ptrs never have forwarding pointers (only ARRAY does), so we extract
  // the raw offset directly instead of paying the __ptr_offset function-call overhead.
  wat('__sso_char', `(func $__sso_char (param $ptr i64) (param $i i32) (result i32)
    ${ssoCharWat('(local.get $ptr)', '(local.get $i)')})`)

  wat('__str_char', `(func $__str_char (param $ptr i64) (param $i i32) (result i32)
    (i32.load8_u (i32.add
      (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK})))
      (local.get $i))))`)

  // Hot (~37M calls in watr self-host, ~40k/scan in tokenizer bench). Caller
  // guarantees $ptr is a STRING; SSO bit picks inline-byte-extract vs heap memory
  // load. Returns 0 for OOB — internal tokenizer callers (number/json/regex
  // parsers) rely on this sentinel to terminate `while (c > 32)`-shape loops
  // past end-of-string. The SSO bounds check is essential: i32.shr_u wraps shift
  // count mod 32, so without it `'a'.charCodeAt(4)` would return 'a' again
  // (shift 32→0).
  //
  // Body written as a single nested-if expression with NO locals so watr's
  // inliner picks it up (gate: no-locals + ≤4 params + body.length===1). After
  // inlining into a hot loop, V8's LICM hoists the SSO-bit test, offset
  // extraction and heap-length load out — the per-iteration cost collapses to a
  // load+bounds-check, beating call-site overhead. Repeated `i32.wrap_i64 +
  // i64.and OFFSET_MASK` subexpressions rely on CSE in the consumer; both
  // V8/TurboFan and watr's own propagate pass handle this.
  wat('__char_at', `(func $__char_at (param $ptr i64) (param $i i32) (result i32)
    (if (result i32)
      (i64.ne (i64.and (local.get $ptr) (i64.const ${SSO_BIT_I64})) (i64.const 0))
      (then
        (if (result i32)
          (i32.ge_u (local.get $i) ${ssoLenWat('(local.get $ptr)')})
          (then (i32.const 0))
          (else ${ssoCharWat('(local.get $ptr)', '(local.get $i)')})))
      (else
        (if (result i32)
          (i32.ge_u (local.get $i)
            ;; non-SSO length: view → aux[12:0]; own heap string → header at off-4
            ;; (off<4 sentinel guards the literal-data-segment edge). Both arms
            ;; are loop-invariant — V8 LICM hoists the whole select.
            (if (result i32)
              (i64.ne (i64.and (local.get $ptr) (i64.const ${SLICE_BIT_I64})) (i64.const 0))
              (then (i32.and
                (i32.wrap_i64 (i64.shr_u (local.get $ptr) (i64.const ${LAYOUT.AUX_SHIFT})))
                (i32.const ${LAYOUT.SLICE_LEN_MASK})))
              (else
                (if (result i32)
                  (i32.lt_u
                    (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK})))
                    (i32.const 4))
                  (then (i32.const 0))
                  (else (i32.load
                    (i32.sub
                      (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK})))
                      (i32.const 4))))))))
          (then (i32.const 0))
          (else
            (i32.load8_u
              (i32.add
                (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK})))
                (local.get $i)))))))))`)

  wat('__str_idx', `(func $__str_idx (param $ptr i64) (param $i i32) (result f64)
    (local $t i32) (local $off i32) (local $len i32) (local $isSso i32)
    (local.set $t (i32.wrap_i64 (i64.and (i64.shr_u (local.get $ptr) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    (local.set $off (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $isSso (i32.and
      (i32.wrap_i64 (i64.shr_u (local.get $ptr) (i64.const ${LAYOUT.AUX_SHIFT})))
      (i32.const ${LAYOUT.SSO_BIT})))
    (local.set $len
      (if (result i32) (local.get $isSso)
        (then ${ssoLenWat('(local.get $ptr)')})
        (else
          (if (result i32)
            (i64.ne (i64.and (local.get $ptr) (i64.const ${SLICE_BIT_I64})) (i64.const 0))
            (then (i32.and
              (i32.wrap_i64 (i64.shr_u (local.get $ptr) (i64.const ${LAYOUT.AUX_SHIFT})))
              (i32.const ${LAYOUT.SLICE_LEN_MASK})))
            (else
              (if (result i32) (i32.and (i32.eq (local.get $t) (i32.const ${PTR.STRING})) (i32.ge_u (local.get $off) (i32.const 4)))
                (then (i32.load (i32.sub (local.get $off) (i32.const 4))))
                (else (i32.const 0))))))))
    (if (result f64)
      (i32.or (i32.lt_s (local.get $i) (i32.const 0)) (i32.ge_u (local.get $i) (local.get $len)))
      (then (f64.const nan:${UNDEF_NAN}))
      (else
        (if (result f64) (local.get $isSso)
          ;; SSO source: chars are ASCII (<0x80) → inline 1-char SSO (hot path, no branch).
          (then (f64.reinterpret_i64
            (i64.or
              (i64.const ${ptrNanHex(PTR.STRING, ssoAux(1))})
              (i64.extend_i32_u ${ssoCharWat('(local.get $ptr)', '(local.get $i)')}))))
          ;; Heap source: the byte may be ≥0x80 (non-ASCII), which can't be a 7-bit SSO,
          ;; so __char1byte routes those to a heap 1-byte string.
          (else (call $__char1byte (i32.load8_u (i32.add (local.get $off) (local.get $i)))))))))`)

  // Hot: ~53M calls in watr self-host. Bit-eq covers identity. SSO/SSO with !bit-eq
  // guarantees content differs (high 32 bits encode type+len; both equal → low 32 differs
  // ⇒ bytes differ). Heap/heap uses raw load8_u — no per-byte function calls.
  // Mixed SSO×heap is rare; falls back to __char_at.
  // Hot/cold split: the prefix every comparison runs (bit-eq, both-SSO,
  // both-canonical, heap length mismatch) is LOOP-FREE and small enough for
  // the engine's wasm inliner — the call overhead disappears at every site
  // while the byte-walk lives in __str_eq_cold. Mirrors the __ptr_offset_fwd
  // split; a body containing a loop is excluded from V8's inliner.
  wat('__str_eq', () => `(func $__str_eq (param $a i64) (param $b i64) (result i32)
    (local $axA i32) (local $axB i32) (local $offA i32) (local $offB i32)
    (if (i64.eq (local.get $a) (local.get $b))
      (then (return (i32.const 1))))
    (local.set $axA (i32.wrap_i64 (i64.shr_u (local.get $a) (i64.const ${LAYOUT.AUX_SHIFT}))))
    (local.set $axB (i32.wrap_i64 (i64.shr_u (local.get $b) (i64.const ${LAYOUT.AUX_SHIFT}))))
    ${ctx.features.sso ? `
    ;; ANY SSO operand ⇒ bit-ne decided content-ne: ≤${MAX_SSO}-ASCII content is
    ;; always SSO (module invariant), so an SSO can equal neither a bit-different
    ;; SSO nor any heap string. Kills the mixed SSO×heap byte-walk class outright.
    (if (i32.or
          (i32.and (local.get $axA) (i32.const ${LAYOUT.SSO_BIT}))
          (i32.and (local.get $axB) (i32.const ${LAYOUT.SSO_BIT})))
      (then (return (i32.const 0))))` : `
    ;; both SSO ⇒ bit-ne already decided content-ne
    (if (i32.and
          (i32.and (local.get $axA) (i32.const ${LAYOUT.SSO_BIT}))
          (i32.and (local.get $axB) (i32.const ${LAYOUT.SSO_BIT})))
      (then (return (i32.const 0))))`}
    ;; both CANONICAL interned heap strings ⇒ bit-ne ⇒ content-ne
    (if (i32.and
          (i32.eq (i32.and (local.get $axA) (i32.const ${LAYOUT.SSO_BIT | LAYOUT.SLICE_BIT | 0x1})) (i32.const 0x1))
          (i32.eq (i32.and (local.get $axB) (i32.const ${LAYOUT.SSO_BIT | LAYOUT.SLICE_BIT | 0x1})) (i32.const 0x1)))
      (then (return (i32.const 0))))
    ;; both PLAIN heap (not SSO, not slice): length mismatch exits without bytes
    (if (i32.eqz (i32.or
          (i32.and (i32.or (local.get $axA) (local.get $axB)) (i32.const ${LAYOUT.SSO_BIT | LAYOUT.SLICE_BIT}))
          (i32.const 0)))
      (then
        (local.set $offA (i32.wrap_i64 (i64.and (local.get $a) (i64.const ${LAYOUT.OFFSET_MASK}))))
        (local.set $offB (i32.wrap_i64 (i64.and (local.get $b) (i64.const ${LAYOUT.OFFSET_MASK}))))
        (if (i32.and (i32.ge_u (local.get $offA) (i32.const 4)) (i32.ge_u (local.get $offB) (i32.const 4)))
          (then
            (if (i32.ne
                  (i32.load (i32.sub (local.get $offA) (i32.const 4)))
                  (i32.load (i32.sub (local.get $offB) (i32.const 4))))
              (then (return (i32.const 0))))))))
    (call $__str_eq_cold (local.get $a) (local.get $b)))`)

  wat('__str_eq_cold', `(func $__str_eq_cold (param $a i64) (param $b i64) (result i32)
    (local $len i32) (local $lenB i32) (local $i i32)
    (local $ta i32) (local $tb i32)
    (local $offA i32) (local $offB i32)
    (local $ssoA i32) (local $ssoB i32)
    ;; Sole caller is __str_eq, which already returned for bit-equal pointers, both-SSO
    ;; (bit-ne ⇒ content-ne), both-canonical-interned (bit-ne ⇒ content-ne) and both-plain-
    ;; heap length mismatch. Re-testing them here is dead work on every cold call — skip to
    ;; the byte walk. (__str_eq/__str_eq_cold are ~14% of self-host runtime; this trims the
    ;; per-call fixed cost.) The heap/mixed paths below still decide every case correctly
    ;; on their own, so this stays correct even if a future caller skips the prelude.
    (local.set $ta (i32.wrap_i64 (i64.and (i64.shr_u (local.get $a) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    (local.set $tb (i32.wrap_i64 (i64.and (i64.shr_u (local.get $b) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    (local.set $offA (i32.wrap_i64 (i64.and (local.get $a) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $offB (i32.wrap_i64 (i64.and (local.get $b) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $ssoA (i32.and
      (i32.wrap_i64 (i64.shr_u (local.get $a) (i64.const ${LAYOUT.AUX_SHIFT})))
      (i32.const ${LAYOUT.SSO_BIT})))
    (local.set $ssoB (i32.and
      (i32.wrap_i64 (i64.shr_u (local.get $b) (i64.const ${LAYOUT.AUX_SHIFT})))
      (i32.const ${LAYOUT.SSO_BIT})))
    ;; Both heap STRING fast path: inline len from header. Chunk by 4 bytes via unaligned
    ;; i32.load (wasm guarantees unaligned-OK), then byte-tail. Most string comparisons fail
    ;; early on the first 4-byte word, so this collapses the per-byte branch overhead into a
    ;; single 32-bit equality.
    (if (i32.and
          (i32.and (i32.eq (local.get $ta) (i32.const ${PTR.STRING})) (i32.eqz (local.get $ssoA)))
          (i32.and (i32.eq (local.get $tb) (i32.const ${PTR.STRING})) (i32.eqz (local.get $ssoB))))
      (then
        (if (i32.or (i32.lt_u (local.get $offA) (i32.const 4)) (i32.lt_u (local.get $offB) (i32.const 4)))
          (then (return (i32.const 0))))
        (local.set $len ${heapLenExpr('$a', '$offA')})
        (local.set $lenB ${heapLenExpr('$b', '$offB')})
        (if (i32.ne (local.get $len) (local.get $lenB))
          (then (return (i32.const 0))))
        (local.set $lenB (i32.and (local.get $len) (i32.const -4)))
        (block $d4 (loop $l4
          (br_if $d4 (i32.ge_s (local.get $i) (local.get $lenB)))
          (if (i32.ne
                (i32.load (i32.add (local.get $offA) (local.get $i)))
                (i32.load (i32.add (local.get $offB) (local.get $i))))
            (then (return (i32.const 0))))
          (local.set $i (i32.add (local.get $i) (i32.const 4)))
          (br $l4)))
        (block $dh (loop $lh
          (br_if $dh (i32.ge_s (local.get $i) (local.get $len)))
          (if (i32.ne
                (i32.load8_u (i32.add (local.get $offA) (local.get $i)))
                (i32.load8_u (i32.add (local.get $offB) (local.get $i))))
            (then (return (i32.const 0))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $lh)))
        (return (i32.const 1))))
    ;; Mixed (SSO×heap) or anything else: compute len per side then per-byte via __char_at.
    ;; __str_byteLen handles SSO, slice (SLICE_BIT) and own-heap encodings uniformly.
    (local.set $len (call $__str_byteLen (local.get $a)))
    (local.set $lenB (call $__str_byteLen (local.get $b)))
    (if (i32.ne (local.get $len) (local.get $lenB))
      (then (return (i32.const 0))))
    (block $dm (loop $lm
      (br_if $dm (i32.ge_s (local.get $i) (local.get $len)))
      (if (i32.ne (call $__char_at (local.get $a) (local.get $i))
                  (call $__char_at (local.get $b) (local.get $i)))
        (then (return (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lm)))
    (i32.const 1))`)

  // Three-way byte-wise compare: -1 if a < b, 0 if equal, +1 if a > b. Returns
  // i32 so callers can `i32.lt_s 0`, `i32.gt_s 0`, etc. without coercion.
  // Comparison is unsigned (i32.load8_u via __char_at) — matches JS spec for
  // ASCII; for non-ASCII it's a UTF-8 byte order, which collates the same as
  // codepoint order for code points < 0x80 and well-formed strings. NOT locale-
  // aware: this is the byte-wise variant suitable for sort-stability use cases,
  // not human-language collation.
  wat('__str_cmp', `(func $__str_cmp (param $a i64) (param $b i64) (result i32)
    (local $lenA i32) (local $lenB i32) (local $minLen i32) (local $i i32)
    (local $ca i32) (local $cb i32)
    ;; Bit-equal pointers (including same SSO inline form) ⇒ identical strings.
    (if (i64.eq (local.get $a) (local.get $b))
      (then (return (i32.const 0))))
    (local.set $lenA (call $__str_byteLen (local.get $a)))
    (local.set $lenB (call $__str_byteLen (local.get $b)))
    (local.set $minLen (select (local.get $lenA) (local.get $lenB)
      (i32.lt_s (local.get $lenA) (local.get $lenB))))
    (block $done (loop $next
      (br_if $done (i32.ge_s (local.get $i) (local.get $minLen)))
      (local.set $ca (call $__char_at (local.get $a) (local.get $i)))
      (local.set $cb (call $__char_at (local.get $b) (local.get $i)))
      (if (i32.lt_u (local.get $ca) (local.get $cb)) (then (return (i32.const -1))))
      (if (i32.gt_u (local.get $ca) (local.get $cb)) (then (return (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next)))
    ;; Common prefix matches — shorter string sorts first.
    (if (i32.lt_s (local.get $lenA) (local.get $lenB)) (then (return (i32.const -1))))
    (if (i32.gt_s (local.get $lenA) (local.get $lenB)) (then (return (i32.const 1))))
    (i32.const 0))`)

  // === WAT: unified byte length (SSO → aux low bits, heap → header) ===

  wat('__str_byteLen', `(func $__str_byteLen (param $ptr i64) (result i32)
    (local $t i32) (local $off i32) (local $aux i32)
    (local.set $t (i32.wrap_i64 (i64.and (i64.shr_u (local.get $ptr) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    (if (result i32) (i32.eq (local.get $t) (i32.const ${PTR.STRING}))
      (then
        (local.set $aux (i32.and
          (i32.wrap_i64 (i64.shr_u (local.get $ptr) (i64.const ${LAYOUT.AUX_SHIFT})))
          (i32.const ${LAYOUT.AUX_MASK})))
        (if (result i32) (i32.and (local.get $aux) (i32.const ${LAYOUT.SSO_BIT}))
          (then ${ssoLenFromAux('(local.get $aux)')})
          (else
            (if (result i32) (i32.and (local.get $aux) (i32.const ${LAYOUT.SLICE_BIT}))
              ;; view: length lives in aux[12:0], not a header.
              (then (i32.and (local.get $aux) (i32.const ${LAYOUT.SLICE_LEN_MASK})))
              (else
                (local.set $off (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK}))))
                (if (result i32) (i32.ge_u (local.get $off) (i32.const 4))
                  (then (i32.load (i32.sub (local.get $off) (i32.const 4))))
                  (else (i32.const 0))))))))
      (else (i32.const 0))))`)

  // === WAT: string methods ===

  // SSO source uses an unrolled byte-extract loop (len ≤ 4); heap source uses memory.copy
  // (single bulk op instead of nlen × __char_at).
  wat('__str_slice', () => `(func $__str_slice (param $ptr i64) (param $start i32) (param $end i32) (result f64)
    (local $len i32) (local $nlen i32) (local $off i32) (local $i i32)
    (local $srcOff i32) (local $isSso i32) (local $sb i32) (local $sp i32) (local $sp64 i64)
    (local $ip i32) (local $h i32) (local $j i32) (local $slot i32) (local $cand i32) (local $k i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (local.set $start (call $__clamp_idx (local.get $start) (local.get $len)))
    (local.set $end (call $__clamp_idx (local.get $end) (local.get $len)))
    (if (i32.ge_s (local.get $start) (local.get $end))
      (then (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${LAYOUT.SSO_BIT}) (i32.const 0)))))
    (local.set $nlen (i32.sub (local.get $end) (local.get $start)))
    ${sliceSsoPackWat()}
    ${internProbeWat('(i32.add (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ' + LAYOUT.OFFSET_MASK + '))) (local.get $start))', '(i32.eqz (local.get $isSso))')}
    (local.set $off (call $__alloc (i32.add (i32.const 8) (local.get $nlen))))
    (i32.store (local.get $off) (i32.const 0))
    (i32.store offset=4 (local.get $off) (local.get $nlen))
    (local.set $off (i32.add (local.get $off) (i32.const 8)))
    (local.set $srcOff (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $isSso (i32.wrap_i64 (i64.shr_u
      (i64.and (local.get $ptr) (i64.const ${SSO_BIT_I64}))
      (i64.const ${LAYOUT.AUX_SHIFT}))))
    (if (local.get $isSso)
      (then
        (block $done (loop $loop
          (br_if $done (i32.ge_s (local.get $i) (local.get $nlen)))
          (i32.store8 (i32.add (local.get $off) (local.get $i))
            (i32.and (i32.shr_u (local.get $srcOff)
              (i32.shl (i32.add (local.get $start) (local.get $i)) (i32.const 3)))
              (i32.const 0xFF)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $loop))))
      (else
        (memory.copy (local.get $off) (i32.add (local.get $srcOff) (local.get $start)) (local.get $nlen))))
    (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${STR_HCACHE_BIT}) (local.get $off)))`)

  // No-copy slice: returns a VIEW into the receiver's buffer instead of copying
  // bytes. Only emitted when escape analysis proves the result never outlives the
  // parent (a non-escaping local). A view is a heap STRING with SLICE_BIT set and
  // its length in aux[12:0]; the offset points straight into the parent's bytes,
  // so it stays valid as long as the parent does. Falls back to a real copy
  // (__str_slice) when the parent is SSO (no buffer to point into) or the result
  // is longer than SLICE_LEN_MASK (aux can't hold the length). Clamping mirrors
  // __str_slice; the fallback re-clamps idempotently.
  wat('__str_slice_view', () => `(func $__str_slice_view (param $ptr i64) (param $start i32) (param $end i32) (result f64)
    (local $len i32) (local $nlen i32) (local $srcOff i32) (local $tag i32)
    (local $ip i32) (local $h i32) (local $j i32) (local $slot i32) (local $cand i32) (local $k i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (local.set $start (call $__clamp_idx (local.get $start) (local.get $len)))
    (local.set $end (call $__clamp_idx (local.get $end) (local.get $len)))
    (if (i32.ge_s (local.get $start) (local.get $end))
      (then (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${LAYOUT.SSO_BIT}) (i32.const 0)))))
    (local.set $nlen (i32.sub (local.get $end) (local.get $start)))
    (local.set $tag (i32.wrap_i64 (i64.and (i64.shr_u (local.get $ptr) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    ;; View-eligible: STRING parent, not SSO, length fits aux[12:0]. ≤${MAX_SSO}-byte
    ;; results route to __str_slice's SSO pack instead (bit-equal short tokens —
    ;; a short VIEW would break the ≤${MAX_SSO}-ASCII⇒SSO invariant).
    (if (i32.and
          (i32.and
            (i32.and
              (i32.eq (local.get $tag) (i32.const ${PTR.STRING}))
              (i32.gt_u (local.get $nlen) (i32.const ${MAX_SSO})))
            (i64.eqz (i64.and (local.get $ptr) (i64.const ${SSO_BIT_I64}))))
          (i32.le_u (local.get $nlen) (i32.const ${LAYOUT.SLICE_LEN_MASK})))
      (then
        (local.set $srcOff (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK}))))
        ${internProbeWat('(i32.add (local.get $srcOff) (local.get $start))')}
        (return (call $__mkptr
          (i32.const ${PTR.STRING})
          (i32.or (i32.const ${LAYOUT.SLICE_BIT}) (local.get $nlen))
          (i32.add (local.get $srcOff) (local.get $start))))))
    ;; Fallback: copy (SSO parent, or slice too long for the aux length field).
    (call $__str_slice (local.get $ptr) (local.get $start) (local.get $end)))`)

  wat('__str_substring', `(func $__str_substring (param $ptr i64) (param $start i32) (param $end i32) (result f64)
    (local $len i32) (local $tmp i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (if (i32.lt_s (local.get $start) (i32.const 0))
      (then (local.set $start (i32.const 0))))
    (if (i32.lt_s (local.get $end) (i32.const 0))
      (then (local.set $end (i32.const 0))))
    (if (i32.gt_s (local.get $start) (local.get $len))
      (then (local.set $start (local.get $len))))
    (if (i32.gt_s (local.get $end) (local.get $len))
      (then (local.set $end (local.get $len))))
    (if (i32.gt_s (local.get $start) (local.get $end))
      (then
        (local.set $tmp (local.get $start))
        (local.set $start (local.get $end))
        (local.set $end (local.get $tmp))))
    (call $__str_slice (local.get $ptr) (local.get $start) (local.get $end)))`)

  // === WAT: fused substring-equality ===
  //
  // `<str>.{substr,substring,slice}(...) === <other>` consumed only by the
  // equality materialises a transient substring (an __alloc + byte copy) just
  // to feed __eq. emit.js's emitSubstringEqCmp peepholes that pair to these
  // helpers, which clamp the range exactly like __str_substring / __str_slice
  // then byte-compare it against `other` in place — zero allocation. Motivating
  // hot path: the parser keyword scan, `cur.substr(i,l) === keyword`.
  //
  // __str_range_eq assumes the receiver is a STRING (every substring method
  // returns one) and type-checks only `other`, mirroring __eq's STRING-vs-?
  // arm: a genuine number never equals a string, and a NaN-boxed non-STRING
  // never does either (jz `==` is strict).
  wat('__str_range_eq', `(func $__str_range_eq (param $ptr i64) (param $start i32) (param $end i32) (param $other i64) (result i32)
    (local $n i32) (local $i i32) (local $fb f64)
    ;; A genuine number reinterprets to a non-NaN f64 (equals itself) — never a string.
    (local.set $fb (f64.reinterpret_i64 (local.get $other)))
    (if (f64.eq (local.get $fb) (local.get $fb))
      (then (return (i32.const 0))))
    ;; NaN-boxed but not STRING-tagged ⇒ not a string ⇒ not equal.
    (if (i32.ne
          (i32.wrap_i64 (i64.and (i64.shr_u (local.get $other) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
          (i32.const ${PTR.STRING}))
      (then (return (i32.const 0))))
    (local.set $n (i32.sub (local.get $end) (local.get $start)))
    (if (i32.lt_s (local.get $n) (i32.const 0))
      (then (local.set $n (i32.const 0))))
    (if (i32.ne (local.get $n) (call $__str_byteLen (local.get $other)))
      (then (return (i32.const 0))))
    (block $done (loop $next
      (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
      (if (i32.ne
            (call $__char_at (local.get $ptr) (i32.add (local.get $start) (local.get $i)))
            (call $__char_at (local.get $other) (local.get $i)))
        (then (return (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next)))
    (i32.const 1))`)

  // Clamp mirrors __str_substring (negatives floor to 0, swap when start>end).
  wat('__str_substring_eq', `(func $__str_substring_eq (param $ptr i64) (param $start i32) (param $end i32) (param $other i64) (result i32)
    (local $len i32) (local $tmp i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (if (i32.lt_s (local.get $start) (i32.const 0))
      (then (local.set $start (i32.const 0))))
    (if (i32.lt_s (local.get $end) (i32.const 0))
      (then (local.set $end (i32.const 0))))
    (if (i32.gt_s (local.get $start) (local.get $len))
      (then (local.set $start (local.get $len))))
    (if (i32.gt_s (local.get $end) (local.get $len))
      (then (local.set $end (local.get $len))))
    (if (i32.gt_s (local.get $start) (local.get $end))
      (then
        (local.set $tmp (local.get $start))
        (local.set $start (local.get $end))
        (local.set $end (local.get $tmp))))
    (call $__str_range_eq (local.get $ptr) (local.get $start) (local.get $end) (local.get $other)))`)

  // Clamp mirrors __str_slice (negatives count from the end; __str_range_eq
  // floors a negative span to an empty match).
  wat('__str_slice_eq', `(func $__str_slice_eq (param $ptr i64) (param $start i32) (param $end i32) (param $other i64) (result i32)
    (local $len i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (local.set $start (call $__clamp_idx (local.get $start) (local.get $len)))
    (local.set $end (call $__clamp_idx (local.get $end) (local.get $len)))
    (call $__str_range_eq (local.get $ptr) (local.get $start) (local.get $end) (local.get $other)))`)

  // Hoist SSO/heap dispatch for hay and ndl out of the inner byte loop. Inner
  // loop becomes (load8_u OR sso byte-extract) per side — no per-byte calls.
  // Needle byte j, SSO-aware (packed-bits extract vs heap load) — lets the SIMD
  // haystack scan serve SSO needles too (the common short "," / "://" needle),
  // not just heap×heap. `$nsso` is loop-invariant so the branch predicts away.
  const nByte = (j) => `(if (result i32) (local.get $nsso)
    (then ${ssoCharWat('(local.get $ndl)', j)})
    (else (i32.load8_u (i32.add (local.get $noff) ${j}))))`
  wat('__str_indexof', `(func $__str_indexof (param $hay i64) (param $ndl i64) (param $from i32) (result i32)
    (local $hlen i32) (local $nlen i32) (local $i i32) (local $j i32) (local $match i32)
    (local $hoff i32) (local $noff i32)
    (local $hsso i32) (local $nsso i32) (local $hb i32) (local $nb i32) (local $k i32)
    (local $splat v128) (local $mask i32) (local $scanEnd i32)
    ;; The search value is ToString'd at the call site (searchArg) per 21.1.3.9 step 4 —
    ;; a known-string needle passes raw, so this helper carries no float-pulling __to_str.
    (local.set $hlen (call $__str_byteLen (local.get $hay)))
    (local.set $nlen (call $__str_byteLen (local.get $ndl)))
    ;; Empty needle matches at clamp(from, 0, hlen) — per 21.1.3.9 step 6 (Min(Max(pos,0),len)).
    (if (i32.eqz (local.get $nlen))
      (then (return (select
        (select (local.get $from) (local.get $hlen) (i32.lt_s (local.get $from) (local.get $hlen)))
        (i32.const 0)
        (i32.ge_s (local.get $from) (i32.const 0))))))
    (if (i32.gt_s (local.get $nlen) (local.get $hlen)) (then (return (i32.const -1))))
    (local.set $hoff (i32.wrap_i64 (i64.and (local.get $hay) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $noff (i32.wrap_i64 (i64.and (local.get $ndl) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $hsso (i32.and
      (i32.wrap_i64 (i64.shr_u (local.get $hay) (i64.const ${LAYOUT.AUX_SHIFT})))
      (i32.const ${LAYOUT.SSO_BIT})))
    (local.set $nsso (i32.and
      (i32.wrap_i64 (i64.shr_u (local.get $ndl) (i64.const ${LAYOUT.AUX_SHIFT})))
      (i32.const ${LAYOUT.SSO_BIT})))
    (local.set $i (if (result i32) (i32.gt_s (local.get $from) (i32.const 0)) (then (local.get $from)) (else (i32.const 0))))
    ;; Single-byte needle (the common s.indexOf('/') / s.includes(' ')): scan for one byte without
    ;; the per-position match/j/k bookkeeping. Heap haystack gets a branchless load8_u loop (no
    ;; per-byte SSO test); a 16-wide SIMD scan here would only add splat/window setup that short
    ;; strings — the bulk of single-char searches — never amortize, so the scalar scan stays.
    (if (i32.eq (local.get $nlen) (i32.const 1))
      (then
        (local.set $nb ${nByte('(i32.const 0)')})
        (if (i32.eqz (local.get $hsso))
          (then
            (block $sd (loop $ss
              (br_if $sd (i32.ge_s (local.get $i) (local.get $hlen)))
              (if (i32.eq (i32.load8_u (i32.add (local.get $hoff) (local.get $i))) (local.get $nb))
                (then (return (local.get $i))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $ss)))
            (return (i32.const -1)))
          (else
            (block $sd2 (loop $ss2
              (br_if $sd2 (i32.ge_s (local.get $i) (local.get $hlen)))
              (if (i32.eq ${ssoCharWat('(local.get $hay)', '(local.get $i)')} (local.get $nb))
                (then (return (local.get $i))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $ss2)))
            (return (i32.const -1))))))
    ;; Multi-byte needle, HEAP haystack (needle SSO or heap): a SIMD first-byte memchr — broadcast
    ;; needle[0] across 16 lanes, i8x16.eq a 16-byte haystack window, and read the match-bitmask.
    ;; Only positions whose first byte matches reach the branchless verify; the rare match (V8's own
    ;; StringIndexOf is SIMD here) is what the scalar path lost on. The SIMD load only touches the
    ;; haystack, so an SSO needle (the common short "," / "://" / "TARGET") rides this path too —
    ;; its bytes are fetched SSO-aware via nByte(). scanEnd = hlen-nlen is the last viable start; the
    ;; window stops at hlen-16 (a full 16-byte load stays inside the string), a scalar tail covers
    ;; the rest. Only an SSO haystack (≤ MAX_SSO bytes — too short to scan 16-wide) falls through.
    (if (i32.eqz (local.get $hsso))
      (then
        (local.set $nb ${nByte('(i32.const 0)')})
        (local.set $scanEnd (i32.sub (local.get $hlen) (local.get $nlen)))
        (local.set $splat (i8x16.splat (local.get $nb)))
        (block $vd (loop $vo
          (br_if $vd (i32.gt_s (local.get $i) (i32.sub (local.get $hlen) (i32.const 16))))
          (local.set $mask (i8x16.bitmask
            (i8x16.eq (v128.load (i32.add (local.get $hoff) (local.get $i))) (local.get $splat))))
          (block $bd (loop $bo
            (br_if $bd (i32.eqz (local.get $mask)))
            (local.set $k (i32.add (local.get $i) (i32.ctz (local.get $mask))))   ;; candidate start
            (br_if $bd (i32.gt_s (local.get $k) (local.get $scanEnd)))            ;; positions only grow
            (local.set $match (i32.const 1))
            (local.set $j (i32.const 1))
            (block $mn (loop $mi
              (br_if $mn (i32.ge_s (local.get $j) (local.get $nlen)))
              (if (i32.ne (i32.load8_u (i32.add (i32.add (local.get $hoff) (local.get $k)) (local.get $j)))
                          ${nByte('(local.get $j)')})
                (then (local.set $match (i32.const 0)) (br $mn)))
              (local.set $j (i32.add (local.get $j) (i32.const 1)))
              (br $mi)))
            (if (local.get $match) (then (return (local.get $k))))
            (local.set $mask (i32.and (local.get $mask) (i32.sub (local.get $mask) (i32.const 1))))  ;; clear lowest match
            (br $bo)))
          (local.set $i (i32.add (local.get $i) (i32.const 16)))
          (br $vo)))
        ;; scalar tail: positions [i, scanEnd] the SIMD window couldn't cover
        (block $md (loop $mo
          (br_if $md (i32.gt_s (local.get $i) (local.get $scanEnd)))
          (if (i32.eq (i32.load8_u (i32.add (local.get $hoff) (local.get $i))) (local.get $nb))
            (then
              (local.set $match (i32.const 1))
              (local.set $j (i32.const 1))
              (block $mn2 (loop $mi2
                (br_if $mn2 (i32.ge_s (local.get $j) (local.get $nlen)))
                (if (i32.ne (i32.load8_u (i32.add (i32.add (local.get $hoff) (local.get $i)) (local.get $j)))
                            ${nByte('(local.get $j)')})
                  (then (local.set $match (i32.const 0)) (br $mn2)))
                (local.set $j (i32.add (local.get $j) (i32.const 1)))
                (br $mi2)))
              (if (local.get $match) (then (return (local.get $i))))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $mo)))
        (return (i32.const -1))))
    (block $done (loop $outer
      (br_if $done (i32.gt_s (local.get $i) (i32.sub (local.get $hlen) (local.get $nlen))))
      (local.set $match (i32.const 1))
      (local.set $j (i32.const 0))
      (block $nomatch (loop $inner
        (br_if $nomatch (i32.ge_s (local.get $j) (local.get $nlen)))
        (local.set $k (i32.add (local.get $i) (local.get $j)))
        (local.set $hb (if (result i32) (local.get $hsso)
          (then ${ssoCharWat('(local.get $hay)', '(local.get $k)')})
          (else (i32.load8_u (i32.add (local.get $hoff) (local.get $k))))))
        (local.set $nb (if (result i32) (local.get $nsso)
          (then ${ssoCharWat('(local.get $ndl)', '(local.get $j)')})
          (else (i32.load8_u (i32.add (local.get $noff) (local.get $j))))))
        (if (i32.ne (local.get $hb) (local.get $nb))
          (then (local.set $match (i32.const 0)) (br $nomatch)))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $inner)))
      (if (local.get $match) (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $outer)))
    (i32.const -1))`)

  // Mirror of __str_indexof but searches from the end. Returns the last byte-offset
  // of `ndl` in `hay` at or before `from` (-1 if not found). Per JS spec step 4,
  // ToString(searchValue) is applied first. SSO/heap dispatch hoisted exactly as
  // in __str_indexof so the inner loop is cheap byte-fetches.
  wat('__str_lastindexof', `(func $__str_lastindexof (param $hay i64) (param $ndl i64) (param $from i32) (result i32)
    (local $hlen i32) (local $nlen i32) (local $i i32) (local $j i32) (local $match i32)
    (local $hoff i32) (local $noff i32)
    (local $hsso i32) (local $nsso i32) (local $hb i32) (local $nb i32) (local $k i32)
    ;; The search value is ToString'd at the call site (searchArg) per 21.1.3.10 step 4.
    (local.set $hlen (call $__str_byteLen (local.get $hay)))
    (local.set $nlen (call $__str_byteLen (local.get $ndl)))
    ;; Empty needle always matches at the clamp(from,0,hlen) position
    (if (i32.eqz (local.get $nlen))
      (then (return (select
        (select (local.get $from) (local.get $hlen) (i32.lt_s (local.get $from) (local.get $hlen)))
        (i32.const 0)
        (i32.ge_s (local.get $from) (i32.const 0))))))
    (if (i32.gt_s (local.get $nlen) (local.get $hlen)) (then (return (i32.const -1))))
    (local.set $hoff (i32.wrap_i64 (i64.and (local.get $hay) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $noff (i32.wrap_i64 (i64.and (local.get $ndl) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $hsso (i32.and
      (i32.wrap_i64 (i64.shr_u (local.get $hay) (i64.const ${LAYOUT.AUX_SHIFT})))
      (i32.const ${LAYOUT.SSO_BIT})))
    (local.set $nsso (i32.and
      (i32.wrap_i64 (i64.shr_u (local.get $ndl) (i64.const ${LAYOUT.AUX_SHIFT})))
      (i32.const ${LAYOUT.SSO_BIT})))
    ;; clamp start position: from defaults to hlen-nlen, capped at that ceiling
    (local.set $i (i32.sub (local.get $hlen) (local.get $nlen)))
    (if (i32.and (i32.ge_s (local.get $from) (i32.const 0)) (i32.lt_s (local.get $from) (local.get $i)))
      (then (local.set $i (local.get $from))))
    (block $done (loop $outer
      (br_if $done (i32.lt_s (local.get $i) (i32.const 0)))
      (local.set $match (i32.const 1))
      (local.set $j (i32.const 0))
      (block $nomatch (loop $inner
        (br_if $nomatch (i32.ge_s (local.get $j) (local.get $nlen)))
        (local.set $k (i32.add (local.get $i) (local.get $j)))
        (local.set $hb (if (result i32) (local.get $hsso)
          (then ${ssoCharWat('(local.get $hay)', '(local.get $k)')})
          (else (i32.load8_u (i32.add (local.get $hoff) (local.get $k))))))
        (local.set $nb (if (result i32) (local.get $nsso)
          (then ${ssoCharWat('(local.get $ndl)', '(local.get $j)')})
          (else (i32.load8_u (i32.add (local.get $noff) (local.get $j))))))
        (if (i32.ne (local.get $hb) (local.get $nb))
          (then (local.set $match (i32.const 0)) (br $nomatch)))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $inner)))
      (if (local.get $match) (then (return (local.get $i))))
      (local.set $i (i32.sub (local.get $i) (i32.const 1)))
      (br $outer)))
    (i32.const -1))`)

  // SSO/heap dispatch hoisted; inner loop is two inlined byte-fetches and a compare.
  wat('__str_startswith', `(func $__str_startswith (param $str i64) (param $pfx i64) (result i32)
    (local $plen i32) (local $i i32)
    (local $soff i32) (local $poff i32) (local $ssso i32) (local $psso i32)
    (local.set $plen (call $__str_byteLen (local.get $pfx)))
    (if (i32.gt_s (local.get $plen) (call $__str_byteLen (local.get $str)))
      (then (return (i32.const 0))))
    (local.set $soff (i32.wrap_i64 (i64.and (local.get $str) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $poff (i32.wrap_i64 (i64.and (local.get $pfx) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $ssso (i32.and
      (i32.wrap_i64 (i64.shr_u (local.get $str) (i64.const ${LAYOUT.AUX_SHIFT})))
      (i32.const ${LAYOUT.SSO_BIT})))
    (local.set $psso (i32.and
      (i32.wrap_i64 (i64.shr_u (local.get $pfx) (i64.const ${LAYOUT.AUX_SHIFT})))
      (i32.const ${LAYOUT.SSO_BIT})))
    (block $done (loop $loop
      (br_if $done (i32.ge_s (local.get $i) (local.get $plen)))
      (if (i32.ne
            (if (result i32) (local.get $ssso)
              (then ${ssoCharWat('(local.get $str)', '(local.get $i)')})
              (else (i32.load8_u (i32.add (local.get $soff) (local.get $i)))))
            (if (result i32) (local.get $psso)
              (then ${ssoCharWat('(local.get $pfx)', '(local.get $i)')})
              (else (i32.load8_u (i32.add (local.get $poff) (local.get $i))))))
        (then (return (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (i32.const 1))`)

  wat('__str_endswith', `(func $__str_endswith (param $str i64) (param $sfx i64) (result i32)
    (local $slen i32) (local $flen i32) (local $off i32) (local $i i32) (local $k i32)
    (local $soff i32) (local $foff i32) (local $ssso i32) (local $fsso i32)
    (local.set $slen (call $__str_byteLen (local.get $str)))
    (local.set $flen (call $__str_byteLen (local.get $sfx)))
    (if (i32.gt_s (local.get $flen) (local.get $slen))
      (then (return (i32.const 0))))
    (local.set $off (i32.sub (local.get $slen) (local.get $flen)))
    (local.set $soff (i32.wrap_i64 (i64.and (local.get $str) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $foff (i32.wrap_i64 (i64.and (local.get $sfx) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $ssso (i32.and
      (i32.wrap_i64 (i64.shr_u (local.get $str) (i64.const ${LAYOUT.AUX_SHIFT})))
      (i32.const ${LAYOUT.SSO_BIT})))
    (local.set $fsso (i32.and
      (i32.wrap_i64 (i64.shr_u (local.get $sfx) (i64.const ${LAYOUT.AUX_SHIFT})))
      (i32.const ${LAYOUT.SSO_BIT})))
    (block $done (loop $loop
      (br_if $done (i32.ge_s (local.get $i) (local.get $flen)))
      (local.set $k (i32.add (local.get $off) (local.get $i)))
      (if (i32.ne
            (if (result i32) (local.get $ssso)
              (then ${ssoCharWat('(local.get $str)', '(local.get $k)')})
              (else (i32.load8_u (i32.add (local.get $soff) (local.get $k)))))
            (if (result i32) (local.get $fsso)
              (then ${ssoCharWat('(local.get $sfx)', '(local.get $i)')})
              (else (i32.load8_u (i32.add (local.get $foff) (local.get $i))))))
        (then (return (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (i32.const 1))`)

  // Source SSO/heap dispatch hoisted out of the byte loop (was a per-byte __char_at).
  wat('__str_case', `(func $__str_case (param $ptr i64) (param $lo i32) (param $hi i32) (param $delta i32) (result f64)
    (local $len i32) (local $off i32) (local $i i32) (local $c i32)
    (local $srcOff i32) (local $sp64 i64)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (if (i32.eqz (local.get $len))
      (then (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${LAYOUT.SSO_BIT}) (i32.const 0)))))
    ;; SSO in ⇒ SSO out: case-map the 7-bit lanes in registers (no allocation);
    ;; ASCII stays ASCII, so the result is always SSO-eligible (invariant).
    (if (i64.ne (i64.and (local.get $ptr) (i64.const ${SSO_BIT_I64})) (i64.const 0))
      (then
        (local.set $sp64 (i64.const 0))
        (block $dsso (loop $lsso
          (br_if $dsso (i32.ge_s (local.get $i) (local.get $len)))
          (local.set $c ${ssoCharWat('(local.get $ptr)', '(local.get $i)')})
          (if (i32.and (i32.ge_u (local.get $c) (local.get $lo)) (i32.le_u (local.get $c) (local.get $hi)))
            (then (local.set $c (i32.add (local.get $c) (local.get $delta)))))
          (local.set $sp64 (i64.or (local.get $sp64)
            (i64.shl (i64.extend_i32_u (local.get $c)) (i64.mul (i64.extend_i32_u (local.get $i)) (i64.const 7)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $lsso)))
        (return (f64.reinterpret_i64 (i64.or
          (i64.or
            (i64.const ${ptrNanHex(PTR.STRING, LAYOUT.SSO_BIT)})
            (i64.shl (i64.extend_i32_u (local.get $len)) (i64.const 42)))
          (local.get $sp64))))))
    (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $len))))
    (i32.store (local.get $off) (local.get $len))
    (local.set $off (i32.add (local.get $off) (i32.const 4)))
    (local.set $srcOff (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (block $dh (loop $lh
      (br_if $dh (i32.ge_s (local.get $i) (local.get $len)))
      (local.set $c (i32.load8_u (i32.add (local.get $srcOff) (local.get $i))))
      (if (i32.and (i32.ge_u (local.get $c) (local.get $lo)) (i32.le_u (local.get $c) (local.get $hi)))
        (then (local.set $c (i32.add (local.get $c) (local.get $delta)))))
      (i32.store8 (i32.add (local.get $off) (local.get $i)) (local.get $c))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lh)))
    (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $off)))`)

  wat('__str_trim', `(func $__str_trim (param $ptr i64) (result f64)
    (local $len i32) (local $start i32) (local $end i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (local.set $start (i32.const 0))
    (local.set $end (local.get $len))
    (block $d1 (loop $l1
      (br_if $d1 (i32.ge_s (local.get $start) (local.get $end)))
      (br_if $d1 (i32.gt_u (call $__char_at (local.get $ptr) (local.get $start)) (i32.const 32)))
      (local.set $start (i32.add (local.get $start) (i32.const 1)))
      (br $l1)))
    (block $d2 (loop $l2
      (br_if $d2 (i32.le_s (local.get $end) (local.get $start)))
      (br_if $d2 (i32.gt_u (call $__char_at (local.get $ptr) (i32.sub (local.get $end) (i32.const 1))) (i32.const 32)))
      (local.set $end (i32.sub (local.get $end) (i32.const 1)))
      (br $l2)))
    (call $__str_slice (local.get $ptr) (local.get $start) (local.get $end)))`)

  wat('__str_trimStart', `(func $__str_trimStart (param $ptr i64) (result f64)
    (local $len i32) (local $start i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (local.set $start (i32.const 0))
    (block $done (loop $loop
      (br_if $done (i32.ge_s (local.get $start) (local.get $len)))
      (br_if $done (i32.gt_u (call $__char_at (local.get $ptr) (local.get $start)) (i32.const 32)))
      (local.set $start (i32.add (local.get $start) (i32.const 1)))
      (br $loop)))
    (call $__str_slice (local.get $ptr) (local.get $start) (local.get $len)))`)

  wat('__str_trimEnd', `(func $__str_trimEnd (param $ptr i64) (result f64)
    (local $len i32) (local $end i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (local.set $end (local.get $len))
    (block $done (loop $loop
      (br_if $done (i32.le_s (local.get $end) (i32.const 0)))
      (br_if $done (i32.gt_u (call $__char_at (local.get $ptr) (i32.sub (local.get $end) (i32.const 1))) (i32.const 32)))
      (local.set $end (i32.sub (local.get $end) (i32.const 1)))
      (br $loop)))
    (call $__str_slice (local.get $ptr) (i32.const 0) (local.get $end)))`)

  // Materialize source bytes once via __str_copy (handles SSO/heap), then memory.copy
  // each subsequent repetition (single bulk op vs len byte stores per copy).
  wat('__str_repeat', `(func $__str_repeat (param $ptr i64) (param $n i32) (result f64)
    (local $len i32) (local $total i32) (local $off i32) (local $i i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (if (i32.or (i32.eqz (local.get $n)) (i32.eqz (local.get $len)))
      (then (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${LAYOUT.SSO_BIT}) (i32.const 0)))))
    (local.set $total (i32.mul (local.get $len) (local.get $n)))
    (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $total))))
    (i32.store (local.get $off) (local.get $total))
    (local.set $off (i32.add (local.get $off) (i32.const 4)))
    (call $__str_copy (local.get $ptr) (local.get $off) (local.get $len))
    (local.set $i (i32.const 1))
    (block $done (loop $loop
      (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
      (memory.copy
        (i32.add (local.get $off) (i32.mul (local.get $i) (local.get $len)))
        (local.get $off)
        (local.get $len))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    ;; short ASCII result → SSO (invariant); the heap copy stays as arena garbage
    (if (i32.le_u (local.get $total) (i32.const ${MAX_SSO}))
      (then (return (call $__sso_norm (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $off))))))
    (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $off)))`)

  // Coerce value to string: numbers → __ftoa, nullish → static strings,
  // plain NaN → "NaN", arrays → join(","), other string-like pointers pass through.
  wat('__to_str', `(func $__to_str (param $val i64) (result i64)
    (local $type i32) (local $f f64)
    (local.set $f (f64.reinterpret_i64 (local.get $val)))
    ;; Not NaN → number, convert
    (if (f64.eq (local.get $f) (local.get $f))
      (then (return (i64.reinterpret_f64 (call $__ftoa (local.get $f) (i32.const 0) (i32.const 0))))))
    (if (i64.eq (local.get $val) (i64.const ${NULL_NAN}))
      (then (return (i64.reinterpret_f64 (call $__static_str (i32.const 5))))))
    (if (i64.eq (local.get $val) (i64.const ${UNDEF_NAN}))
      (then (return (i64.reinterpret_f64 (call $__static_str (i32.const 6))))))
    (if (i64.eq (local.get $val) (i64.const ${FALSE_NAN}))
      (then (return (i64.reinterpret_f64 (call $__static_str (i32.const 4))))))
    (if (i64.eq (local.get $val) (i64.const ${TRUE_NAN}))
      (then (return (i64.reinterpret_f64 (call $__static_str (i32.const 3))))))
    (local.set $type (call $__ptr_type (local.get $val)))
    ;; Plain NaN (type=0) → "NaN" string
    (if (i32.eqz (local.get $type))
      (then (return (i64.reinterpret_f64 (call $__static_str (i32.const 0))))))
    ;; Array (type=1) → join(",") like JS Array.toString()
    (if (i32.eq (local.get $type) (i32.const ${PTR.ARRAY}))
      (then (return (i64.reinterpret_f64 (call $__str_join (local.get $val)
        (i64.reinterpret_f64 (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${ssoAux(1)}) (i32.const 44))))))))
    (local.get $val))`)

  // Copy bytes of a string (SSO or heap) into memory at dst. Uses memory.copy for
  // heap strings (single native op); unpacks SSO offset-packed bytes inline.
  wat('__str_copy', `(func $__str_copy (param $src i64) (param $dst i32) (param $len i32)
    (local $w i32)
    (if (i64.ne (i64.and (local.get $src) (i64.const ${SSO_BIT_I64})) (i64.const 0))
      (then
        ;; SSO: write $len ASCII chars, each 7-bit-packed at payload bit i*7 (chars 4-5
        ;; span into aux, so read via the 7-bit codec, not the low 32 bits). $w = index.
        (local.set $w (i32.const 0))
        (loop $ssocp
          (if (i32.lt_u (local.get $w) (local.get $len))
            (then
              (i32.store8 (i32.add (local.get $dst) (local.get $w)) ${ssoCharWat('(local.get $src)', '(local.get $w)')})
              (local.set $w (i32.add (local.get $w) (i32.const 1)))
              (br $ssocp)))))
      (else
        ;; Heap STRING: memory.copy directly from string data
        (memory.copy (local.get $dst)
          (i32.wrap_i64 (i64.and (local.get $src) (i64.const ${LAYOUT.OFFSET_MASK})))
          (local.get $len)))))`)

  // Bump-extend fast path: when `a` is a heap STRING sitting at the top of the
  // bump allocator, extend its allocation in place instead of copying. Mutates
  // memory[a.off-4] to the new length and bumps __heap. This makes the canonical
  // `buf += char` build pattern O(N) instead of O(N²) — closing the asymptotic
  // gap with V8's cons-strings. Tradeoff: aliased refs to `a` see the larger
  // length too, so this departs from strict JS string immutability for the rare
  // `let b = a; a += x` aliasing case. The fast path can't trigger when other
  // allocations have happened since `a` was created (it's no longer at heap top).
  // Only emitted for own-memory mode with a $__heap global; shared memory and
  // alloc:false (which routes the heap pointer through memory[1020]) fall back.
  // SSO-result fast path: both operands SSO and total ≤ 4 → repack inline,
  // no alloc, no copy. Combined offset field = a's bytes | (b's bytes shifted
  // by alen*8). New aux = SSO_BIT | total. Mode-independent (pointer arith
  // only, no heap); fires whenever the upstream `'+'` couldn't fold at
  // compile time (one or both operands runtime values). Critical for the
  // identifier-style `'$' + x` / `prefix + s` patterns hot in parsers.
  // Both-SSO short result: splice the two 42-bit char payloads — no walk, no alloc.
  const ssoResultFast = `
    (if (i32.and
          (i32.and
            (i64.ne (i64.and (local.get $a) (i64.const ${SSO_BIT_I64})) (i64.const 0))
            (i64.ne (i64.and (local.get $b) (i64.const ${SSO_BIT_I64})) (i64.const 0)))
          (i32.le_u (local.get $total) (i32.const ${MAX_SSO})))
      (then
        (return (f64.reinterpret_i64 (i64.or
          (i64.or
            (i64.const ${ptrNanHex(PTR.STRING, LAYOUT.SSO_BIT)})
            (i64.shl (i64.extend_i32_u (local.get $total)) (i64.const 42)))
          (i64.or
            (i64.and (local.get $a) (i64.const ${SSO_CHAR_MASK}))
            (i64.shl
              (i64.and (local.get $b) (i64.const ${SSO_CHAR_MASK}))
              (i64.extend_i32_u (i32.mul (local.get $alen) (i32.const 7))))))))))`

  // Mixed/heap-source short result: walk the ≤6 source bytes (SSO lane or heap
  // load per side), bail to the caller's heap path on a non-ASCII byte. Upholds
  // the module invariant for concat regardless of operand representation.
  const concatSsoPack = `
    (if (i32.le_u (local.get $total) (i32.const ${MAX_SSO}))
      (then (block $kspill
        (local.set $ksp (i64.const 0))
        (local.set $ki (i32.const 0))
        (local.set $kao (i32.wrap_i64 (i64.and (local.get $a) (i64.const ${LAYOUT.OFFSET_MASK}))))
        (local.set $kbo (i32.wrap_i64 (i64.and (local.get $b) (i64.const ${LAYOUT.OFFSET_MASK}))))
        (loop $kl
          (if (i32.lt_u (local.get $ki) (local.get $total))
            (then
              (local.set $kc (if (result i32) (i32.lt_u (local.get $ki) (local.get $alen))
                (then (if (result i32) (i64.ne (i64.and (local.get $a) (i64.const ${SSO_BIT_I64})) (i64.const 0))
                  (then ${ssoCharWat('(local.get $a)', '(local.get $ki)')})
                  (else (i32.load8_u (i32.add (local.get $kao) (local.get $ki))))))
                (else (if (result i32) (i64.ne (i64.and (local.get $b) (i64.const ${SSO_BIT_I64})) (i64.const 0))
                  (then ${ssoCharWat('(local.get $b)', '(i32.sub (local.get $ki) (local.get $alen))')})
                  (else (i32.load8_u (i32.add (local.get $kbo) (i32.sub (local.get $ki) (local.get $alen)))))))))
              (br_if $kspill (i32.ge_u (local.get $kc) (i32.const 0x80)))
              (local.set $ksp (i64.or (local.get $ksp)
                (i64.shl (i64.extend_i32_u (local.get $kc)) (i64.mul (i64.extend_i32_u (local.get $ki)) (i64.const 7)))))
              (local.set $ki (i32.add (local.get $ki) (i32.const 1)))
              (br $kl))))
        (return (f64.reinterpret_i64 (i64.or
          (i64.or
            (i64.const ${ptrNanHex(PTR.STRING, LAYOUT.SSO_BIT)})
            (i64.shl (i64.extend_i32_u (local.get $total)) (i64.const 42)))
          (local.get $ksp)))))))`

  const concatFast = !ctx.memory.shared && ctx.transform.alloc !== false ? `
    (local.set $ta (i32.wrap_i64 (i64.and (i64.shr_u (local.get $a) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    (local.set $aoff (i32.wrap_i64 (i64.and (local.get $a) (i64.const ${LAYOUT.OFFSET_MASK}))))
    ;; Bump-extend requires an OWN heap STRING — not SSO (offset holds packed bytes)
    ;; and not a slice/view (bumping would corrupt the parent buffer it points into).
    (if (i32.and
          (i32.and
            (i32.eq (local.get $ta) (i32.const ${PTR.STRING}))
            (i32.and
              (i64.eqz (i64.and (local.get $a) (i64.const ${SSO_BIT_I64})))
              (i64.eqz (i64.and (local.get $a) (i64.const ${SLICE_BIT_I64})))))
          (i32.eq
            (i32.and (i32.add (i32.add (local.get $aoff) (local.get $alen)) (i32.const 7)) (i32.const -8))
            (global.get $__heap)))
      (then
        (local.set $newHeap
          (i32.and (i32.add (i32.add (local.get $aoff) (local.get $total)) (i32.const 7)) (i32.const -8)))
        (call $__memgrow (local.get $newHeap))
        (call $__str_copy (local.get $b)
          (i32.add (local.get $aoff) (local.get $alen))
          (local.get $blen))
        (i32.store (i32.sub (local.get $aoff) (i32.const 4)) (local.get $total))
        ;; bytes changed in place — drop the cached hash (cell exists iff HCACHE bit)
        (if (i64.ne (i64.and (local.get $a) (i64.const ${HCACHE_BIT_I64})) (i64.const 0))
          (then (i32.store (i32.sub (local.get $aoff) (i32.const 8)) (i32.const 0))))
        (global.set $__heap (local.get $newHeap))
        (return (f64.reinterpret_i64 (local.get $a)))))` : ''

  // Always-fresh tail: allocate a new buffer and copy both operands. Shared by the
  // bump-extend concats (reached when `a` is NOT heap-top) and the `_fresh` variants
  // (which never bump-extend at all — emit routes a NON-self-accumulating `t = s + x`
  // here so it can't mutate the live `s` the way the heap-top extend would).
  // [hash=0 u32][len u32][bytes] + STR_HCACHE_BIT: __str_hash fills the hash cell on
  // first hash so repeated keying of a built string skips the byte-FNV walk.
  const allocCopyTail = `
    (local.set $off (call $__alloc (i32.add (i32.const 8) (local.get $total))))
    (i32.store (local.get $off) (i32.const 0))
    (i32.store offset=4 (local.get $off) (local.get $total))
    (local.set $off (i32.add (local.get $off) (i32.const 8)))
    (call $__str_copy (local.get $a) (local.get $off) (local.get $alen))
    (call $__str_copy (local.get $b) (i32.add (local.get $off) (local.get $alen)) (local.get $blen))
    (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${STR_HCACHE_BIT}) (local.get $off)))`

  // Fused single-byte append: `buf += str[i]` lowers to this when both sides are
  // VAL.STRING and the rhs is a string-index. Skips __str_idx's 1-char SSO
  // construction and __str_concat's type-dispatch — byte goes directly from
  // __char_at to memory. Bump-extends in place when `a` is at heap top.
  wat('__str_append_byte', `(func $__str_append_byte (param $a i64) (param $byte i32) (result f64)
    (local $ta i32) (local $aoff i32) (local $alen i32)
    (local $newHeap i32) (local $off i32) (local $total i32)
    (local.set $ta (i32.wrap_i64 (i64.and (i64.shr_u (local.get $a) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    (local.set $aoff (i32.wrap_i64 (i64.and (local.get $a) (i64.const ${LAYOUT.OFFSET_MASK}))))
    ;; Heap STRING at heap top: bump-extend by 1 byte (own-memory mode w/ $__heap global only).
    ;; Gate on STRING tag AND !SSO_BIT ($aoff would hold packed bytes) AND !SLICE_BIT
    ;; (a view's $aoff points into a parent buffer — bumping it would corrupt the parent).
    ${!ctx.memory.shared && ctx.transform.alloc !== false ? `
    (if (i32.and
          (i32.eq (local.get $ta) (i32.const ${PTR.STRING}))
          (i32.and
            (i64.eqz (i64.and (local.get $a) (i64.const ${SSO_BIT_I64})))
            (i64.eqz (i64.and (local.get $a) (i64.const ${SLICE_BIT_I64})))))
      (then
        (local.set $alen (i32.load (i32.sub (local.get $aoff) (i32.const 4))))
        (if (i32.eq
              (i32.and (i32.add (i32.add (local.get $aoff) (local.get $alen)) (i32.const 7)) (i32.const -8))
              (global.get $__heap))
          (then
            (local.set $newHeap
              (i32.and (i32.add (i32.add (local.get $aoff) (local.get $alen)) (i32.const 8)) (i32.const -8)))
            (call $__memgrow (local.get $newHeap))
            (i32.store8 (i32.add (local.get $aoff) (local.get $alen)) (local.get $byte))
            (i32.store (i32.sub (local.get $aoff) (i32.const 4)) (i32.add (local.get $alen) (i32.const 1)))
            ;; bytes changed in place — drop the cached hash (cell exists iff HCACHE bit)
            (if (i64.ne (i64.and (local.get $a) (i64.const ${HCACHE_BIT_I64})) (i64.const 0))
              (then (i32.store (i32.sub (local.get $aoff) (i32.const 8)) (i32.const 0))))
            (global.set $__heap (local.get $newHeap))
            (return (f64.reinterpret_i64 (local.get $a)))))))` : ''}
    ;; SSO (STRING with SSO bit) with len < ${MAX_SSO} and ASCII byte: pack into SSO without allocation.
    ;; NB: the aux test must be a BOOLEAN (i32.ne) — bitwise-ANDing the raw 0x4000 mask
    ;; result with the boolean (i32.eq …) yields 1 & 0x4000 = 0, silently killing the path.
    (if (i32.and
          (i32.eq (local.get $ta) (i32.const ${PTR.STRING}))
          (i32.ne
            (i32.and
              (i32.wrap_i64 (i64.shr_u (local.get $a) (i64.const ${LAYOUT.AUX_SHIFT})))
              (i32.const ${LAYOUT.SSO_BIT}))
            (i32.const 0)))
      (then
        (local.set $alen ${ssoLenWat('(local.get $a)')})
        (if (i32.and
              (i32.lt_u (local.get $alen) (i32.const ${MAX_SSO}))
              (i32.lt_u (local.get $byte) (i32.const 0x80)))
          (then
            (return (f64.reinterpret_i64 (i64.or
              (i64.or
                (i64.const ${ptrNanHex(PTR.STRING, LAYOUT.SSO_BIT)})
                (i64.shl (i64.extend_i32_u (i32.add (local.get $alen) (i32.const 1))) (i64.const 42)))
              (i64.or
                (i64.and (local.get $a) (i64.const ${SSO_CHAR_MASK}))
                (i64.shl (i64.extend_i32_u (local.get $byte)) (i64.extend_i32_u (i32.mul (local.get $alen) (i32.const 7))))))))))))
    ;; Slow path: allocate new heap STRING with original bytes + 1 new byte
    (local.set $alen (call $__str_byteLen (local.get $a)))
    (local.set $total (i32.add (local.get $alen) (i32.const 1)))
    (local.set $off (call $__alloc (i32.add (i32.const 8) (local.get $total))))
    (i32.store (local.get $off) (i32.const 0))
    (i32.store offset=4 (local.get $off) (local.get $total))
    (local.set $off (i32.add (local.get $off) (i32.const 8)))
    (call $__str_copy (local.get $a) (local.get $off) (local.get $alen))
    (i32.store8 (i32.add (local.get $off) (local.get $alen)) (local.get $byte))
    (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${STR_HCACHE_BIT}) (local.get $off)))`)

  // __str_concat / __str_concat_raw bump-EXTEND `a` in place when it is the heap-top own string
  // (the O(N) accumulator path). Emit calls these ONLY when the source is a self-accumulation
  // `x = x + …` (so the mutated `a` is dead-after-reassign) or when `a` is a provably-fresh
  // module-internal temporary; a plain `t = s + x` over a live `s` routes to the _fresh twins.
  wat('__str_concat', `(func $__str_concat (param $a i64) (param $b i64) (result f64)
    (local $alen i32) (local $blen i32) (local $total i32) (local $off i32)
    (local $ta i32) (local $aoff i32) (local $newHeap i32)
    (local $ki i32) (local $kc i32) (local $ksp i64) (local $kao i32) (local $kbo i32)
    ;; Coerce operands to strings if needed
    (local.set $a (call $__to_str (local.get $a)))
    (local.set $b (call $__to_str (local.get $b)))
    (local.set $alen (call $__str_byteLen (local.get $a)))
    (local.set $blen (call $__str_byteLen (local.get $b)))
    (local.set $total (i32.add (local.get $alen) (local.get $blen)))
    (if (i32.eqz (local.get $total))
      (then (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${LAYOUT.SSO_BIT}) (i32.const 0)))))
    ${ssoResultFast}
    ${concatSsoPack}
    ${concatFast}${allocCopyTail}`)

  wat('__str_concat_raw', `(func $__str_concat_raw (param $a i64) (param $b i64) (result f64)
    (local $alen i32) (local $blen i32) (local $total i32) (local $off i32)
    (local $ta i32) (local $aoff i32) (local $newHeap i32)
    (local $ki i32) (local $kc i32) (local $ksp i64) (local $kao i32) (local $kbo i32)
    (local.set $alen (call $__str_byteLen (local.get $a)))
    (local.set $blen (call $__str_byteLen (local.get $b)))
    (local.set $total (i32.add (local.get $alen) (local.get $blen)))
    (if (i32.eqz (local.get $total))
      (then (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${LAYOUT.SSO_BIT}) (i32.const 0)))))
    ${ssoResultFast}
    ${concatSsoPack}
    ${concatFast}${allocCopyTail}`)

  // Non-mutating twins: same SSO-pair fast path, but NEVER bump-extend — always alloc+copy a fresh
  // buffer, leaving `a` untouched. The default for emit's user-level `+` (any `t = s + x` where the
  // result is not assigned straight back to `s`), so string immutability holds for live operands.
  wat('__str_concat_fresh', `(func $__str_concat_fresh (param $a i64) (param $b i64) (result f64)
    (local $alen i32) (local $blen i32) (local $total i32) (local $off i32)
    (local $ki i32) (local $kc i32) (local $ksp i64) (local $kao i32) (local $kbo i32)
    (local.set $a (call $__to_str (local.get $a)))
    (local.set $b (call $__to_str (local.get $b)))
    (local.set $alen (call $__str_byteLen (local.get $a)))
    (local.set $blen (call $__str_byteLen (local.get $b)))
    (local.set $total (i32.add (local.get $alen) (local.get $blen)))
    (if (i32.eqz (local.get $total))
      (then (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${LAYOUT.SSO_BIT}) (i32.const 0)))))
    ${ssoResultFast}
    ${concatSsoPack}${allocCopyTail}`)

  wat('__str_concat_raw_fresh', `(func $__str_concat_raw_fresh (param $a i64) (param $b i64) (result f64)
    (local $alen i32) (local $blen i32) (local $total i32) (local $off i32)
    (local $ki i32) (local $kc i32) (local $ksp i64) (local $kao i32) (local $kbo i32)
    (local.set $alen (call $__str_byteLen (local.get $a)))
    (local.set $blen (call $__str_byteLen (local.get $b)))
    (local.set $total (i32.add (local.get $alen) (local.get $blen)))
    (if (i32.eqz (local.get $total))
      (then (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${LAYOUT.SSO_BIT}) (i32.const 0)))))
    ${ssoResultFast}
    ${concatSsoPack}${allocCopyTail}`)

  wat('__str_replace', `(func $__str_replace (param $str i64) (param $search i64) (param $repl i64) (result f64)
    (local $idx i32) (local $slen i32)
    (local.set $idx (call $__str_indexof (local.get $str) (local.get $search) (i32.const 0)))
    (if (result f64) (i32.lt_s (local.get $idx) (i32.const 0))
      (then (f64.reinterpret_i64 (local.get $str)))
      (else
        (local.set $slen (call $__str_byteLen (local.get $search)))
        (call $__str_concat
          (i64.reinterpret_f64 (call $__str_concat
            (i64.reinterpret_f64 (call $__str_slice (local.get $str) (i32.const 0) (local.get $idx)))
            (local.get $repl)))
          (i64.reinterpret_f64 (call $__str_slice (local.get $str) (i32.add (local.get $idx) (local.get $slen))
            (call $__str_byteLen (local.get $str))))))))`)

  wat('__str_replaceall', `(func $__str_replaceall (param $str i64) (param $search i64) (param $repl i64) (result f64)
    (local $idx i32) (local $slen i32) (local $pos i32) (local $result i64)
    (local.set $slen (call $__str_byteLen (local.get $search)))
    (local.set $result (local.get $str))
    (local.set $pos (i32.const 0))
    (block $done (loop $next
      (local.set $idx (call $__str_indexof (local.get $result) (local.get $search) (local.get $pos)))
      (br_if $done (i32.lt_s (local.get $idx) (i32.const 0)))
      (local.set $result (i64.reinterpret_f64 (call $__str_concat
        (i64.reinterpret_f64 (call $__str_concat
          (i64.reinterpret_f64 (call $__str_slice (local.get $result) (i32.const 0) (local.get $idx)))
          (local.get $repl)))
        (i64.reinterpret_f64 (call $__str_slice (local.get $result) (i32.add (local.get $idx) (local.get $slen))
          (call $__str_byteLen (local.get $result)))))))
      (local.set $pos (i32.add (local.get $idx) (call $__str_byteLen (local.get $repl))))
      (br $next)))
    (f64.reinterpret_i64 (local.get $result)))`)

  // $limit ≥ 0: honour JS's optional limit arg. 0x7fffffff = "no limit"
  // (sentinel passed by the no-limit call site). limit=0 → []. limit=N → at
  // most N elements; the (N+1)th and later pieces are DISCARDED (not appended
  // as a remainder). Empty separator: split into individual byte-chars, up to
  // $limit chars ("abc".split("") → ["a","b","c"], "".split("") → []).
  wat('__str_split', `(func $__str_split (param $str i64) (param $sep i64) (param $limit i32) (result f64)
    (local $slen i32) (local $plen i32) (local $count i32)
    (local $i i32) (local $j i32) (local $match i32)
    (local $arr i32) (local $piece_start i32) (local $piece_idx i32) (local $hitlim i32)
    (local.set $slen (call $__str_byteLen (local.get $str)))
    (local.set $plen (call $__str_byteLen (local.get $sep)))
    ;; limit=0 → empty array
    (if (i32.eqz (local.get $limit)) (then
      (local.set $arr (call $__alloc (i32.const 8)))
      (i32.store (local.get $arr) (i32.const 0))
      (i32.store (i32.add (local.get $arr) (i32.const 4)) (i32.const 0))
      (return (call $__mkptr (i32.const 1) (i32.const 0) (i32.add (local.get $arr) (i32.const 8))))))
    (if (i32.eqz (local.get $plen)) (then
      ;; Empty-separator: split into individual byte-chars, up to $limit
      (local.set $count (select (local.get $limit) (local.get $slen) (i32.lt_u (local.get $limit) (local.get $slen))))
      (local.set $arr (call $__alloc (i32.add (i32.const 8) (i32.shl (local.get $count) (i32.const 3)))))
      (i32.store (local.get $arr) (local.get $count))
      (i32.store (i32.add (local.get $arr) (i32.const 4)) (local.get $count))
      (local.set $arr (i32.add (local.get $arr) (i32.const 8)))
      (block $de (loop $le
        (br_if $de (i32.ge_s (local.get $i) (local.get $count)))
        (f64.store (i32.add (local.get $arr) (i32.shl (local.get $i) (i32.const 3)))
          (call $__str_slice (local.get $str) (local.get $i) (i32.add (local.get $i) (i32.const 1))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $le)))
      (return (call $__mkptr (i32.const 1) (i32.const 0) (local.get $arr)))))
    ;; Count pass: tally pieces = separators+1, capped at $limit.
    ;; We stop incrementing count once count reaches $limit (last sep found
    ;; at that point produces piece #limit — a separator *after* piece limit-1,
    ;; meaning we've already found all limit pieces and don't count more).
    (local.set $count (i32.const 1))
    (local.set $i (i32.const 0))
    (block $d1 (loop $l1
      (br_if $d1 (i32.gt_s (local.get $i) (i32.sub (local.get $slen) (local.get $plen))))
      (br_if $d1 (i32.ge_u (local.get $count) (local.get $limit)))
      (local.set $match (i32.const 1))
      (local.set $j (i32.const 0))
      (block $n1 (loop $c1
        (br_if $n1 (i32.ge_s (local.get $j) (local.get $plen)))
        (if (i32.ne (call $__char_at (local.get $str) (i32.add (local.get $i) (local.get $j)))
                    (call $__char_at (local.get $sep) (local.get $j)))
          (then (local.set $match (i32.const 0)) (br $n1)))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $c1)))
      (if (local.get $match) (then
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        (local.set $i (i32.add (local.get $i) (local.get $plen)))
        (br $l1)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l1)))
    (local.set $arr (call $__alloc (i32.add (i32.const 8) (i32.shl (local.get $count) (i32.const 3)))))
    (i32.store (local.get $arr) (local.get $count))
    (i32.store (i32.add (local.get $arr) (i32.const 4)) (local.get $count))
    (local.set $arr (i32.add (local.get $arr) (i32.const 8)))
    (local.set $piece_start (i32.const 0))
    (local.set $piece_idx (i32.const 0))
    (local.set $i (i32.const 0))
    ;; Fill pass: write pieces separated by $sep, up to $count total pieces.
    ;; When a separator is found and piece_idx+1 reaches count, write that
    ;; piece (before the sep) and exit WITHOUT appending the tail — this
    ;; correctly discards the remainder when $limit truncates the result.
    (local.set $hitlim (i32.const 0))
    (block $d2 (loop $l2
      (br_if $d2 (i32.gt_s (local.get $i) (i32.sub (local.get $slen) (local.get $plen))))
      (local.set $match (i32.const 1))
      (local.set $j (i32.const 0))
      (block $n2 (loop $c2
        (br_if $n2 (i32.ge_s (local.get $j) (local.get $plen)))
        (if (i32.ne (call $__char_at (local.get $str) (i32.add (local.get $i) (local.get $j)))
                    (call $__char_at (local.get $sep) (local.get $j)))
          (then (local.set $match (i32.const 0)) (br $n2)))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $c2)))
      (if (local.get $match) (then
        (f64.store (i32.add (local.get $arr) (i32.shl (local.get $piece_idx) (i32.const 3)))
          (call $__str_slice (local.get $str) (local.get $piece_start) (local.get $i)))
        (local.set $piece_idx (i32.add (local.get $piece_idx) (i32.const 1)))
        (local.set $i (i32.add (local.get $i) (local.get $plen)))
        (local.set $piece_start (local.get $i))
        ;; If we've emitted all $count pieces, mark limit-hit and stop (discard tail)
        (if (i32.ge_s (local.get $piece_idx) (local.get $count))
          (then (local.set $hitlim (i32.const 1)) (br $d2)))
        (br $l2)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l2)))
    ;; Write tail only when the scan ended naturally (not truncated by limit)
    (if (i32.eqz (local.get $hitlim)) (then
      (f64.store (i32.add (local.get $arr) (i32.shl (local.get $piece_idx) (i32.const 3)))
        (call $__str_slice (local.get $str) (local.get $piece_start) (local.get $slen)))))
    (call $__mkptr (i32.const 1) (i32.const 0) (local.get $arr)))`)

  // Array (type=1) → join(",") like JS Array.toString().
  // When the typedarray module is loaded, also handles PTR.TYPED (type=3) arrays:
  // promoteIntArrayLiterals rewrites [int,...] → new Int32Array([...]) internally,
  // so a.map(fn).join() may receive a PTR.TYPED result. Use __typed_idx to load
  // each element correctly (it returns f64 for any element type / stride).
  wat('__str_join', () => {
    if (!ctx.module.modules.typedarray) {
      // ARRAY-only fast path — no __typed_idx overhead.
      return `(func $__str_join (param $arr i64) (param $sep i64) (result f64)
    (local $off i32) (local $len i32) (local $i i32) (local $result f64)
    (local.set $off (call $__ptr_offset (local.get $arr)))
    (local.set $len (call $__len (local.get $arr)))
    (if (i32.eqz (local.get $len))
      (then (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${LAYOUT.SSO_BIT}) (i32.const 0)))))
    (local.set $result (f64.reinterpret_i64 (call $__to_str (i64.load (local.get $off)))))
    (local.set $i (i32.const 1))
    (block $done (loop $loop
      (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
      (local.set $result (call $__str_concat (i64.reinterpret_f64 (local.get $result)) (local.get $sep)))
      (local.set $result (call $__str_concat (i64.reinterpret_f64 (local.get $result))
        (i64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (local.get $result))`
    }
    // ARRAY + TYPED path: runtime dispatch on ptr type.
    // PTR.TYPED (type=3): elements have typed-array stride; __typed_idx reads correctly.
    // PTR.ARRAY (type=1): elements are 8-byte NaN-boxed f64 slots; i64.load is correct.
    return `(func $__str_join (param $arr i64) (param $sep i64) (result f64)
    (local $off i32) (local $len i32) (local $i i32) (local $result f64) (local $isTyped i32)
    (local.set $isTyped
      (i32.eq
        (i32.and (i32.wrap_i64 (i64.shr_u (local.get $arr) (i64.const ${LAYOUT.TAG_SHIFT})))
                 (i32.const ${LAYOUT.TAG_MASK}))
        (i32.const ${PTR.TYPED})))
    (local.set $off (call $__ptr_offset (local.get $arr)))
    (local.set $len (call $__len (local.get $arr)))
    (if (i32.eqz (local.get $len))
      (then (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${LAYOUT.SSO_BIT}) (i32.const 0)))))
    (local.set $result
      (f64.reinterpret_i64
        (call $__to_str
          (if (result i64) (local.get $isTyped)
            (then (i64.reinterpret_f64 (call $__typed_idx (local.get $arr) (i32.const 0))))
            (else (i64.load (local.get $off)))))))
    (local.set $i (i32.const 1))
    (block $done (loop $loop
      (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
      (local.set $result (call $__str_concat (i64.reinterpret_f64 (local.get $result)) (local.get $sep)))
      (local.set $result
        (call $__str_concat
          (i64.reinterpret_f64 (local.get $result))
          (if (result i64) (local.get $isTyped)
            (then (i64.reinterpret_f64 (call $__typed_idx (local.get $arr) (local.get $i))))
            (else (i64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (local.get $result))`
  })

  // Source string copied via __str_copy (handles SSO/heap with memory.copy where possible).
  // Pad fill loops a single tile of pad bytes — hoist pad dispatch out of the byte loop.
  wat('__str_pad', `(func $__str_pad (param $str i64) (param $target i32) (param $pad i64) (param $before i32) (result f64)
    (local $slen i32) (local $plen i32) (local $fill i32) (local $off i32) (local $i i32)
    (local $str_off i32) (local $pad_off i32)
    (local $pbits i64) (local $poff i32) (local $psso i32) (local $sp64 i64) (local $sb i32)
    (local.set $slen (call $__str_byteLen (local.get $str)))
    (if (i32.ge_s (local.get $slen) (local.get $target))
      (then (return (f64.reinterpret_i64 (local.get $str)))))
    (local.set $plen (call $__str_byteLen (local.get $pad)))
    (local.set $fill (i32.sub (local.get $target) (local.get $slen)))
    (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $target))))
    (i32.store (local.get $off) (local.get $target))
    (local.set $off (i32.add (local.get $off) (i32.const 4)))
    (local.set $str_off (select (local.get $fill) (i32.const 0) (local.get $before)))
    (local.set $pad_off (select (i32.const 0) (local.get $slen) (local.get $before)))
    (call $__str_copy (local.get $str) (i32.add (local.get $off) (local.get $str_off)) (local.get $slen))
    (local.set $pbits (local.get $pad))
    (local.set $poff (i32.wrap_i64 (i64.and (local.get $pbits) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $psso (i32.and
      (i32.wrap_i64 (i64.shr_u (local.get $pbits) (i64.const ${LAYOUT.AUX_SHIFT})))
      (i32.const ${LAYOUT.SSO_BIT})))
    (block $d2 (loop $l2
      (br_if $d2 (i32.ge_s (local.get $i) (local.get $fill)))
      (i32.store8 (i32.add (local.get $off) (i32.add (local.get $pad_off) (local.get $i)))
        (if (result i32) (local.get $psso)
          (then (i32.and
            (i32.shr_u (local.get $poff) (i32.shl (i32.rem_u (local.get $i) (local.get $plen)) (i32.const 3)))
            (i32.const 0xFF)))
          (else (i32.load8_u (i32.add (local.get $poff) (i32.rem_u (local.get $i) (local.get $plen)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l2)))
    ${!ctx.memory.shared ? `
    ;; SSO + reclaim for ≤${MAX_SSO} ASCII results: pack into the pointer and free this pad
    ;; allocation (at heap top) so padStart in a builder loop is allocation-neutral
    ;; — the accumulator stays at heap top and keeps bump-extending (O(n)).
    (if (i32.le_u (local.get $target) (i32.const ${MAX_SSO}))
      (then
        (block $heap
          (local.set $i (i32.const 0)) (local.set $sp64 (i64.const 0))
          (loop $pk
            (if (i32.lt_u (local.get $i) (local.get $target))
              (then
                (local.set $sb (i32.load8_u (i32.add (local.get $off) (local.get $i))))
                (br_if $heap (i32.ge_u (local.get $sb) (i32.const 0x80)))
                (local.set $sp64 (i64.or (local.get $sp64)
                  (i64.shl (i64.extend_i32_u (local.get $sb)) (i64.mul (i64.extend_i32_u (local.get $i)) (i64.const 7)))))
                (local.set $i (i32.add (local.get $i) (i32.const 1)))
                (br $pk))))
          (global.set $__heap (i32.sub (local.get $off) (i32.const 4)))
          (return (f64.reinterpret_i64 (i64.or
            (i64.or
              (i64.const ${ptrNanHex(PTR.STRING, LAYOUT.SSO_BIT)})
              (i64.shl (i64.extend_i32_u (local.get $target)) (i64.const 42)))
            (local.get $sp64)))))))` : ''}
    (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $off)))`)

  // Base helpers (__sso_char/__str_char/__char_at/__str_byteLen) are referenced
  // from other helpers' WAT bodies and from emit sites; their `stdlibDeps`
  // entries pull them transitively when actually used. No unconditional inc.

  // === Method emitters ===

  // Type-qualified (collide with array: slice, indexOf, includes)
  // String.prototype.toString / .valueOf — both return the receiver per spec
  // (21.1.3.27/28). Typed forms cover the static-string case; generic forms
  // pair with them so the dispatcher can pick a runtime ptr-type branch when
  // the receiver type can't be statically inferred (e.g. a callback param).
  bind('.string:toString', (str) => asF64(emit(str)))
  bind('.string:valueOf', (str) => asF64(emit(str)))
  // String.prototype.normalize — identity: every normalization form (NFC/NFD/
  // NFKC/NFKD) is the identity on ASCII, and jz strings are UTF-8 bytes with
  // ASCII-only case/space semantics (README divergences). No Unicode tables.
  // The form argument is ignored (a bogus form's RangeError needs the same
  // tables to justify checking — out of scope with them). Generic twin
  // ToString-coerces an untyped receiver (spec step 1), like .toString.
  bind('.string:normalize', (str) => asF64(emit(str)))
  bind('.normalize', (val) => {
    inc('__to_str')
    return typed(['f64.reinterpret_i64', ['call', '$__to_str', asI64(emit(val))]], 'f64')
  })
  bind('.toString', (val) => {
    inc('__to_str')
    return typed(['f64.reinterpret_i64', ['call', '$__to_str', asI64(emit(val))]], 'f64')
  })
  // Object.prototype.valueOf returns the receiver (per ES2024 20.1.3.7).
  // Array/Object inherit this; only primitive wrappers (Number/Boolean/String)
  // override to return the primitive — strings already covered by .string:valueOf.
  bind('.valueOf', (val) => asF64(emit(val)))

  // `.slice` lowering, parametrised on the backing helper: __str_slice copies
  // bytes; __str_slice_view returns a no-copy SLICE_BIT view — used only when
  // escape analysis proved the result never outlives its parent buffer (see
  // scanSliceViews / emitDecl). The `#view` key cannot be produced by method
  // dispatch (`#` is not a legal identifier char), so the view variant is
  // reachable only through the explicit emitDecl route.
  const sliceEmitter = (fn) => (str, start, end) => {
    inc(fn)
    const startIR = start == null ? ['i32.const', 0] : asI32(emit(start))
    if (end != null) return typed(['call', `$${fn}`, asI64(emit(str)), startIR, asI32(emit(end))], 'f64')
    const t = temp('t')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, asF64(emit(str))],
      ['call', `$${fn}`, ['i64.reinterpret_f64', ['local.get', `$${t}`]], startIR,
        ['call', '$__str_byteLen', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]]], 'f64')
  }
  bind('.string:slice', sliceEmitter('__str_slice'))
  bind('.string:slice#view', sliceEmitter('__str_slice_view'))

  // ToIntegerOrInfinity for a string-method position argument: ToNumber (so
  // string / boolean / null / undefined positions coerce per spec) then trunc.
  // trunc_sat maps NaN→0 and ±∞→±maxint — both clamp correctly downstream.
  // `toNumF64` routes an object position through `valueOf`/`toString`
  // (ToPrimitive), so a throwing method propagates as an abrupt completion.
  const posIndex = (node) => {
    if (node == null) return ['i32.const', 0]
    return asI32(toNumF64(node, emit(node)))
  }

  // ToString(searchString) per spec step 3. __str_indexof's internal __to_str
  // covers string/number/null/undefined needles, but two cases need help here:
  // a BOOL rides the 0/1 carrier (→ "0"/"1" not "true"/"false"), and an OBJECT
  // needs compile-time ToPrimitive(string) (__to_str can't invoke user toString).
  // Coerce the search operand to a string AT THE CALL SITE (21.1.3.x ToString step),
  // so the `__str_indexof` family carries no embedded `__to_str`. A known-STRING arg
  // (the overwhelmingly common `s.indexOf("x")` / `s.indexOf(t)` shape) passes raw —
  // dropping the whole ToString → float-formatter dep tree (~4 KB) that an internal,
  // unconditional coercion forced into every search-method program. Mirrors
  // `stringSearchMethod` (startsWith/endsWith), which has always coerced here.
  const searchArg = (search) => {
    const vt = valTypeOf(search)
    if (vt === VAL.STRING) return asI64(emit(search))
    if (vt === VAL.BOOL) return asI64(bool(search))
    if (vt === VAL.OBJECT) return toStrI64(search, emit(search))
    inc('__to_str')
    return ['call', '$__to_str', asI64(emit(search))]
  }
  // Replacement operand of .replace/.replaceAll — same call-site ToString as searchArg.
  const strReplArg = searchArg

  bind('.string:indexOf', (str, search, from) => {
    inc('__str_indexof')
    const hay = asI64(emit(str)), ndl = searchArg(search)
    return typed(['f64.convert_i32_s', ['call', '$__str_indexof', hay, ndl, posIndex(from)]], 'f64')
  })

  // String.prototype.lastIndexOf: search from the end, returning the last
  // byte-offset of `search` in `str` at or before `fromIndex` (or -1).
  // Per spec the `from` default is +∞ (search from the very end), which we
  // map to 0x7fffffff — __str_lastindexof clamps it to hlen-nlen anyway.
  bind('.string:lastIndexOf', (str, search, from) => {
    inc('__str_lastindexof')
    const hay = asI64(emit(str)), ndl = searchArg(search)
    const fromIR = from == null ? ['i32.const', 0x7fffffff] : asI32(emit(from))
    return typed(['f64.convert_i32_s', ['call', '$__str_lastindexof', hay, ndl, fromIR]], 'f64')
  })

  // String.prototype.{includes,startsWith,endsWith} run IsRegExp(searchString)
  // and throw a TypeError when it is a RegExp. Detect a regex-typed search arg
  // at compile time and lower to a $__jz_err throw.
  const regexpSearchGuard = (search) => {
    if (valTypeOf(search) !== VAL.REGEX) return null
    ctx.runtime.throws = true
    return typed(['block', ['result', 'f64'], ['throw', '$__jz_err', ['f64.const', 0]]], 'f64')
  }

  bind('.string:includes', (str, search, from) => {
    const guard = regexpSearchGuard(search); if (guard) return guard
    inc('__str_indexof')
    const hay = asI64(emit(str)), ndl = searchArg(search)
    return typed(['f64.convert_i32_s',
      ['i32.ge_s', ['call', '$__str_indexof', hay, ndl, posIndex(from)], ['i32.const', 0]]], 'f64')
  })

  // Generic (no collision)
  bind('.substring', (str, start, end) => {
    inc('__str_substring')
    if (end != null) return typed(['call', '$__str_substring', asI64(emit(str)), asI32(emit(start)), asI32(emit(end))], 'f64')
    const t = temp('t')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, asF64(emit(str))],
      ['call', '$__str_substring', ['i64.reinterpret_f64', ['local.get', `$${t}`]], asI32(emit(start)),
        ['call', '$__str_byteLen', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]]], 'f64')
  })

  // .substr(start, length) — Annex B / legacy. Equivalent to substring(start, start+length).
  // __str_substring clamps end to byteLen and start/end to [0, byteLen], so negative
  // values are floored to 0 (matches v8 for length<0 → empty; for start<0 spec wants
  // max(0, len+start), which we don't implement — rare in practice).
  bind('.substr', (str, start, length) => {
    inc('__str_substring')
    if (length != null) {
      const s = tempI32('substrS')
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${s}`, asI32(emit(start))],
        ['call', '$__str_substring', asI64(emit(str)),
          ['local.get', `$${s}`],
          ['i32.add', ['local.get', `$${s}`], asI32(emit(length))]]
      ], 'f64')
    }
    const t = temp('t')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, asF64(emit(str))],
      ['call', '$__str_substring', ['i64.reinterpret_f64', ['local.get', `$${t}`]], asI32(emit(start)),
        ['call', '$__str_byteLen', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]]], 'f64')
  })

  // Search args go through ToString per spec — coerce non-string-typed args
  // via __to_str so the underlying byte-compare receives an actual string.
  const stringSearchMethod = (name) => (str, sfx) => {
    const guard = regexpSearchGuard(sfx); if (guard) return guard
    inc(name)
    const esfx = emit(sfx)
    let sfxArg = asI64(esfx)
    if (valTypeOf(sfx) === VAL.OBJECT) {
      sfxArg = toStrI64(sfx, esfx)
    } else if (valTypeOf(sfx) !== VAL.STRING) {
      inc('__to_str')
      sfxArg = ['call', '$__to_str', sfxArg]
    }
    return typed(['f64.convert_i32_s', ['call', `$${name}`, asI64(emit(str)), sfxArg]], 'f64')
  }
  bind('.startsWith', stringSearchMethod('__str_startswith'))
  bind('.endsWith', stringSearchMethod('__str_endswith'))
  bind('.trim', method('__str_trim',       'I'))
  bind('.trimStart', method('__str_trimStart',  'I'))
  bind('.trimEnd', method('__str_trimEnd',    'I'))
  bind('.repeat', method('__str_repeat',     'Ii'))
  // split(sep, limit): both args are optional.
  // - No args (undefined sep) → [str]: JS spec step 3 treats undefined separator
  //   as returning a single-element array of the whole string (not splitting at all).
  // - 1 arg → no limit (sentinel 0x7fffffff = MAX_I32).
  // - 2 args → honour limit: 0 → [], N → at most N pieces.
  bind('.split', (str, sep, limit) => {
    if (sep === undefined) {
      // split() → [str]: wrap the whole string in a 1-element array
      inc('__wrap1')
      return typed(['call', '$__wrap1', asI64(emit(str))], 'f64')
    }
    inc('__str_split')
    const limitIR = limit === undefined
      ? ['i32.const', 0x7fffffff]
      : ['i32.trunc_sat_f64_u', asF64(emit(limit))]
    return typed(['call', '$__str_split', asI64(emit(str)), asI64(emit(sep)), limitIR], 'f64')
  })

  // replace(search, replacement). When `replacement` is a function, replace the
  // FIRST occurrence of the (string) search with ToString(fn(match)) — per spec a
  // string search matches once and the callback receives the matched substring.
  // (A regex search routes to `.string:replace` in the regex module, which also
  // handles the /g loop.) Without a closure runtime we can't invoke the callback,
  // so fall back to a clear error rather than silent data loss.
  bind('.replace', (str, search, repl) => {
    if (valTypeOf(repl) === VAL.CLOSURE) {
      if (!ctx.closure?.call) err('.replace(search, fn): no closure runtime available for the callback form')
      inc('__str_indexof', '__str_slice', '__str_concat', '__str_byteLen', '__to_str')
      const s = temp('rps'), q = temp('rpq'), fnL = temp('rpf')
      const idx = tempI32('rpi'), mlen = tempI32('rpm')
      const sI64 = () => ['i64.reinterpret_f64', ['local.get', `$${s}`]]
      const match = typed(['call', '$__str_slice', sI64(), ['local.get', `$${idx}`],
        ['i32.add', ['local.get', `$${idx}`], ['local.get', `$${mlen}`]]], 'f64')
      const repIR = ['call', '$__to_str', asI64(ctx.closure.call(typed(['local.get', `$${fnL}`], 'f64'), [match]))]
      const head = typed(['call', '$__str_slice', sI64(), ['i32.const', 0], ['local.get', `$${idx}`]], 'f64')
      const tail = typed(['call', '$__str_slice', sI64(),
        ['i32.add', ['local.get', `$${idx}`], ['local.get', `$${mlen}`]],
        ['call', '$__str_byteLen', sI64()]], 'f64')
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${s}`, asF64(emit(str))],
        ['local.set', `$${q}`, asF64(emit(search))],
        ['local.set', `$${fnL}`, asF64(emit(repl))],
        ['local.set', `$${mlen}`, ['call', '$__str_byteLen', ['i64.reinterpret_f64', ['local.get', `$${q}`]]]],
        ['local.set', `$${idx}`, ['call', '$__str_indexof', sI64(), ['i64.reinterpret_f64', ['local.get', `$${q}`]], ['i32.const', 0]]],
        ['if', ['result', 'f64'], ['i32.lt_s', ['local.get', `$${idx}`], ['i32.const', 0]],
          ['then', ['local.get', `$${s}`]],
          ['else', typed(['call', '$__str_concat',
            asI64(typed(['call', '$__str_concat', asI64(head), repIR], 'f64')),
            asI64(tail)], 'f64')]]], 'f64')
    }
    inc('__str_replace')
    // search/repl ToString'd at the call site (searchArg) — __str_replace's __str_indexof
    // no longer coerces internally, so a non-string search must be stringified here.
    return typed(['call', '$__str_replace', asI64(emit(str)), searchArg(search), strReplArg(repl)], 'f64')
  })
  bind('.replaceAll', (str, search, repl) => {
    inc('__str_replaceall')
    return typed(['call', '$__str_replaceall', asI64(emit(str)), searchArg(search), strReplArg(repl)], 'f64')
  })

  const caseMethod = (lo, hi, delta) => (str) => {
    inc('__str_case')
    return typed(['call', '$__str_case', asI64(emit(str)), ['i32.const', lo], ['i32.const', hi], ['i32.const', delta]], 'f64')
  }
  bind('.toUpperCase', caseMethod(97, 122, -32))
  const _toLowerCase = caseMethod(65, 90, 32)
  bind('.toLowerCase', _toLowerCase)

  // Locale-specific casing needs ICU/CLDR data. jz intentionally has no
  // runtime, so this follows the existing ASCII-only lowercase helper and
  // ignores optional locale arguments.
  bind('.toLocaleLowerCase', _toLowerCase)

  const padMethod = (start) => (str, len, pad) => {
    inc('__str_pad')
    const vpad = pad != null ? asI64(emit(pad)) : ['i64.reinterpret_f64', mkPtrIR(PTR.STRING, ssoAux(1), 32)]
    return typed(['call', '$__str_pad', asI64(emit(str)), asI32(emit(len)), vpad, ['i32.const', start]], 'f64')
  }
  bind('.padStart', padMethod(1))
  bind('.padEnd', padMethod(0))

  // Byte-wise variant of String.prototype.localeCompare. Returns -1/0/1 from
  // an unsigned byte-by-byte compare with shorter-string-sorts-first tiebreak.
  // NOT locale-aware: real localeCompare is ICU-driven (CLDR collation, case
  // folding, accent ordering). For ASCII inputs the byte-wise result matches
  // the spec exactly; for non-ASCII it follows UTF-8 byte order, which is
  // codepoint order for well-formed strings — close enough for sort-stability
  // use cases, wrong for human-language collation.
  bind('.localeCompare', method('__str_cmp', 'II', 'i32'))

  bind('.string:concat', (str, ...others) => {
    inc('__str_concat')
    let result = asF64(emit(str))
    for (const other of others) result = typed(['call', '$__str_concat', ['i64.reinterpret_f64', result], asI64(emit(other))], 'f64')
    return result
  })

  // A VAL.BOOL part rides the 0/1 carrier, so __to_str would render "1"/"0".
  // bool selects the interned "true"/"false" literal (constant-folded
  // when the operand is known); every other part goes through __to_str.
  const partStrI64 = (p) => valTypeOf(p) === VAL.BOOL ? asI64(bool(p)) : toStrI64(p, emit(p))

  bind('strcat', (...parts) => {
    inc('__to_str', '__str_byteLen', '__alloc', '__mkptr', '__str_copy', '__sso_norm')
    if (!parts.length) return mkPtrIR(PTR.STRING, LAYOUT.SSO_BIT, 0)
    if (parts.length === 1) return typed(['f64.reinterpret_i64', partStrI64(parts[0])], 'f64')

    const vals = parts.map(() => temp('s'))
    const lens = parts.map(() => tempI32('sl'))
    const total = tempI32('st')
    const off = tempI32('so')
    const dst = tempI32('sd')
    const ir = []

    for (let i = 0; i < parts.length; i++) {
      ir.push(['local.set', `$${vals[i]}`, ['f64.reinterpret_i64', partStrI64(parts[i])]])
      ir.push(['local.set', `$${lens[i]}`, ['call', '$__str_byteLen', ['i64.reinterpret_f64', ['local.get', `$${vals[i]}`]]]])
    }
    ir.push(['local.set', `$${total}`, ['i32.const', 0]])
    for (const len of lens)
      ir.push(['local.set', `$${total}`, ['i32.add', ['local.get', `$${total}`], ['local.get', `$${len}`]]])
    const alloc = [
      ['local.set', `$${off}`, ['call', '$__alloc', ['i32.add', ['i32.const', 4], ['local.get', `$${total}`]]]],
      ['i32.store', ['local.get', `$${off}`], ['local.get', `$${total}`]],
      ['local.set', `$${off}`, ['i32.add', ['local.get', `$${off}`], ['i32.const', 4]]],
      ['local.set', `$${dst}`, ['local.get', `$${off}`]],
    ]
    for (let i = 0; i < parts.length; i++) {
      alloc.push(['call', '$__str_copy', ['i64.reinterpret_f64', ['local.get', `$${vals[i]}`]], ['local.get', `$${dst}`], ['local.get', `$${lens[i]}`]])
      alloc.push(['local.set', `$${dst}`, ['i32.add', ['local.get', `$${dst}`], ['local.get', `$${lens[i]}`]]])
    }
    // ≤6-ASCII template results (`\`$\${n}\`` name-building) must SSO-normalize —
    // the module invariant; a leaked short heap string breaks bare-i64.eq ===.
    alloc.push(['call', '$__sso_norm',
      ['call', '$__mkptr', ['i32.const', PTR.STRING], ['i32.const', 0], ['local.get', `$${off}`]]])
    ir.push(['if', ['result', 'f64'], ['i32.eqz', ['local.get', `$${total}`]],
      ['then', mkPtrIR(PTR.STRING, LAYOUT.SSO_BIT, 0)],
      ['else', ['block', ['result', 'f64'], ...alloc]]])
    return typed(['block', ['result', 'f64'], ...ir], 'f64')
  })

  // Shared: `$iLocal` in `[0, lenIR)` → a 1-byte SSO string of the char at that
  // index; otherwise `oobIR`. Without the bounds check `__char_at` returns 0 for an
  // out-of-range index, which would wrap to a bogus `"\x00"` string (charAt → "",
  // at → undefined). `sLocal` is the receiver as an f64 local.
  const charAtOr = (sLocal, iLocal, lenIR, oobIR) => (
    inc('__char1byte'),
    ['if', ['result', 'f64'],
      ['i32.and',
        ['i32.ge_s', ['local.get', iLocal], ['i32.const', 0]],
        ['i32.lt_s', ['local.get', iLocal], lenIR]],
      // __char_at yields a raw byte (≥0x80 for non-ASCII heap strings) → __char1byte
      // builds an SSO byte when ASCII, else a heap 1-byte string.
      ['then', ['call', '$__char1byte',
        ['call', '$__char_at', ['i64.reinterpret_f64', ['local.get', sLocal]], ['local.get', iLocal]]]],
      ['else', oobIR]])
  const emptyStr = mkPtrIR(PTR.STRING, LAYOUT.SSO_BIT, 0)

  // .charAt(i) → 1-char string at index i, or "" when out of range (JS spec: no
  // negative-index wraparound — a negative or >=length index yields "").
  bind('.charAt', (str, idx) => {
    inc('__char_at', '__str_byteLen')
    const s = temp('cs'), i = tempI32('ci')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${s}`, asF64(emit(str))],
      ['local.set', `$${i}`, asI32(emit(idx))],
      charAtOr(`$${s}`, `$${i}`,
        ['call', '$__str_byteLen', ['i64.reinterpret_f64', ['local.get', `$${s}`]]], emptyStr)], 'f64')
  })

  // .charCodeAt(i) → JS-spec char code: the UTF-16 code unit at `i`, or NaN
  // when `i` is out of range (`i < 0 || i >= length`). Result is f64 because
  // NaN is not representable as i32 — an i32 `0` sentinel for OOB silently
  // miscompiles any reader that distinguishes 0 from NaN, e.g. the parser hot
  // loop `while ((cc = s.charCodeAt(i++)) <= 32) {}` would never terminate
  // (`0 <= 32` is true, `NaN <= 32` is false). The narrower may re-narrow the
  // result to i32 where it can prove the index in-bounds.
  bind('.charCodeAt', (str, idx) =>
    typed(ctx.abi.string.ops.charCodeAt(asF64(emit(str)), asI32(emit(idx)), ctx, true), 'f64'))

  // String.prototype.codePointAt(i) — byte-indexed.
  // jz strings are UTF-8 byte-arrays; `i` is a byte offset, not a UTF-16 code-unit
  // index. For ASCII inputs (U+0000..U+007F) the result is the exact Unicode code
  // point. For multi-byte sequences the result is the value of the leading byte only
  // (not a full code-point decode). Out-of-range → undefined (NaN-boxed). This is a
  // documented byte-semantics limitation; it keeps the implementation allocation-free
  // and consistent with jz's byte-indexed string model throughout.
  bind('.codePointAt', (str, idx) =>
    typed(ctx.abi.string.ops.charCodeAt(asF64(emit(str)), asI32(emit(idx)), ctx, true), 'f64'))

  // String.fromCharCode(code) → 1-char SSO string
  bind('String', (value) => {
    if (value === undefined) return emit(['str', ''])
    if (valTypeOf(value) === VAL.STRING) return emit(value)
    if (valTypeOf(value) === VAL.BOOL) return bool(value)
    if (valTypeOf(value) === VAL.NUMBER) {
      inc('__ftoa')
      return typed(['call', '$__ftoa', asF64(emit(value)), ['i32.const', 0], ['i32.const', 0]], 'f64')
    }
    return typed(['f64.reinterpret_i64', toStrI64(value, emit(value))], 'f64')
  })

  // 1-byte string from a raw byte: SSO when ASCII (<0x80, fits the 7-bit codec),
  // else a heap 1-byte string (the 7-bit SSO can't represent bytes ≥0x80).
  wat('__char1byte', `(func $__char1byte (param $b i32) (result f64)
    (local $off i32)
    (local.set $b (i32.and (local.get $b) (i32.const 0xFF)))
    (if (result f64) (i32.lt_u (local.get $b) (i32.const 0x80))
      (then (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${ssoAux(1)}) (local.get $b)))
      (else
        (local.set $off (call $__alloc (i32.const 8)))
        (i32.store (local.get $off) (i32.const 1))
        (i32.store8 (i32.add (local.get $off) (i32.const 4)) (local.get $b))
        (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (i32.add (local.get $off) (i32.const 4))))))`)

  // Normalize a fresh plain-heap STRING to SSO when its content is ≤${MAX_SSO} ASCII
  // bytes — the epilogue every string PRODUCER that hand-writes heap bytes (number/
  // JSON/URI formatting, byte decode, repeat) routes through to uphold the module
  // invariant. Non-STRING values, SSO, slices, long or non-ASCII strings pass through
  // untouched. Pure loads, no calls — cheap enough for every producer return.
  wat('__sso_norm', `(func $__sso_norm (param $s f64) (result f64)
    (local $b i64) (local $len i32) (local $off i32) (local $i i32) (local $c i32) (local $sp i64)
    (local.set $b (i64.reinterpret_f64 (local.get $s)))
    ;; plain heap STRING only: tag=STRING, SSO/SLICE clear, header present
    (if (i32.eqz (i32.and
          (i32.eq
            (i32.wrap_i64 (i64.and (i64.shr_u (local.get $b) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
            (i32.const ${PTR.STRING}))
          (i32.and
            (f64.ne (local.get $s) (local.get $s))
            (i64.eqz (i64.and (local.get $b) (i64.const ${SSO_SLICE_I64}))))))
      (then (return (local.get $s))))
    (local.set $off (i32.wrap_i64 (i64.and (local.get $b) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (if (i32.lt_u (local.get $off) (i32.const 4)) (then (return (local.get $s))))
    (local.set $len (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (if (i32.gt_u (local.get $len) (i32.const ${MAX_SSO})) (then (return (local.get $s))))
    (local.set $sp (i64.const 0))
    (block $spill
      (block $d (loop $l
        (br_if $d (i32.ge_u (local.get $i) (local.get $len)))
        (local.set $c (i32.load8_u (i32.add (local.get $off) (local.get $i))))
        (br_if $spill (i32.ge_u (local.get $c) (i32.const 0x80)))
        (local.set $sp (i64.or (local.get $sp)
          (i64.shl (i64.extend_i32_u (local.get $c)) (i64.mul (i64.extend_i32_u (local.get $i)) (i64.const 7)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
      (return (f64.reinterpret_i64 (i64.or
        (i64.or
          (i64.const ${ptrNanHex(PTR.STRING, LAYOUT.SSO_BIT)})
          (i64.shl (i64.extend_i32_u (local.get $len)) (i64.const 42)))
        (local.get $sp)))))
    (local.get $s))`)

  // String.fromCharCode(...codes) — variadic; each arg is ToUint16(ToNumber(code))
  // → a 1-byte string, concatenated left to right (mirrors String.fromCodePoint).
  bind('String.fromCharCode', (...codes) => {
    if (codes.length === 0) return emit(['str', ''])
    // ToUint16(ToNumber(code)): `toNumF64` performs ToPrimitive on an object
    // argument, so a throwing valueOf/toString propagates per spec. A byte ≥0x80
    // can't be a 7-bit-ASCII SSO, so __char1byte routes it to a heap 1-byte string.
    const one = (node) => { inc('__char1byte'); return typed(['call', '$__char1byte', asI32(toNumF64(node, emit(node)))], 'f64') }
    let r = one(codes[0])
    for (let i = 1; i < codes.length; i++) {
      inc('__str_concat_raw')
      r = typed(['call', '$__str_concat_raw', asI64(r), asI64(one(codes[i]))], 'f64')
    }
    return r
  })

  // String.fromCodePoint(cp) → UTF-8 encoded string for one code point.
  // Param is f64 (already ToNumber-coerced); throws RangeError ($__jz_err) when
  // the value is not an integer in [0, 0x10FFFF] (22.1.2.2 step 5.d).
  wat('__fromCodePoint', `(func $__fromCodePoint (param $cpf f64) (result f64)
    (local $cp i32) (local $off i32) (local $len i32)
    (if (i32.or
          (i32.or
            (f64.ne (f64.trunc (local.get $cpf)) (local.get $cpf))
            (f64.lt (local.get $cpf) (f64.const 0)))
          (f64.gt (local.get $cpf) (f64.const 0x10FFFF)))
      (then (throw $__jz_err (f64.const 0))))
    (local.set $cp (i32.trunc_sat_f64_s (local.get $cpf)))
    ;; ASCII: 1 byte SSO
    (if (i32.lt_u (local.get $cp) (i32.const 128))
      (then (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${ssoAux(1)}) (local.get $cp)))))
    ;; multi-byte (cp ≥ 0x80): UTF-8 bytes are ≥0x80 → can't be 7-bit ASCII SSO, so
    ;; build a heap STRING (len header at $off, bytes at $off+4). Over-alloc to 8 so the
    ;; i32.store of the packed bytes never runs past the buffer; the len word bounds reads.
    ;; 2-byte: 0x80-0x7FF
    (if (i32.lt_u (local.get $cp) (i32.const 0x800))
      (then
        (local.set $off (call $__alloc (i32.const 8)))
        (i32.store (local.get $off) (i32.const 2))
        (i32.store (i32.add (local.get $off) (i32.const 4))
          (i32.or
            (i32.or (i32.const 0xC0) (i32.shr_u (local.get $cp) (i32.const 6)))
            (i32.shl (i32.or (i32.const 0x80) (i32.and (local.get $cp) (i32.const 0x3F))) (i32.const 8))))
        (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (i32.add (local.get $off) (i32.const 4))))))
    ;; 3-byte: 0x800-0xFFFF
    (if (i32.lt_u (local.get $cp) (i32.const 0x10000))
      (then
        (local.set $off (call $__alloc (i32.const 8)))
        (i32.store (local.get $off) (i32.const 3))
        (i32.store (i32.add (local.get $off) (i32.const 4))
          (i32.or (i32.or
            (i32.or (i32.const 0xE0) (i32.shr_u (local.get $cp) (i32.const 12)))
            (i32.shl (i32.or (i32.const 0x80) (i32.and (i32.shr_u (local.get $cp) (i32.const 6)) (i32.const 0x3F))) (i32.const 8)))
            (i32.shl (i32.or (i32.const 0x80) (i32.and (local.get $cp) (i32.const 0x3F))) (i32.const 16))))
        (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (i32.add (local.get $off) (i32.const 4))))))
    ;; 4-byte: 0x10000-0x10FFFF
    (local.set $off (call $__alloc (i32.const 8)))
    (i32.store (local.get $off) (i32.const 4))
    (i32.store (i32.add (local.get $off) (i32.const 4))
      (i32.or (i32.or (i32.or
        (i32.or (i32.const 0xF0) (i32.shr_u (local.get $cp) (i32.const 18)))
        (i32.shl (i32.or (i32.const 0x80) (i32.and (i32.shr_u (local.get $cp) (i32.const 12)) (i32.const 0x3F))) (i32.const 8)))
        (i32.shl (i32.or (i32.const 0x80) (i32.and (i32.shr_u (local.get $cp) (i32.const 6)) (i32.const 0x3F))) (i32.const 16)))
        (i32.shl (i32.or (i32.const 0x80) (i32.and (local.get $cp) (i32.const 0x3F))) (i32.const 24))))
    (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (i32.add (local.get $off) (i32.const 4)))))`)

  // String.fromCodePoint(...codePoints) — variadic; each arg is ToNumber-coerced
  // then validated/encoded by __fromCodePoint, results concatenated left to right.
  bind('String.fromCodePoint', (...codes) => {
    if (codes.length === 0) return emit(['str', ''])
    ctx.runtime.throws = true
    inc('__fromCodePoint')
    const one = (node) => typed(['call', '$__fromCodePoint',
      toNumF64(node, emit(node))], 'f64')
    let r = one(codes[0])
    for (let i = 1; i < codes.length; i++) {
      inc('__str_concat_raw')
      r = typed(['call', '$__str_concat_raw', asI64(r), asI64(one(codes[i]))], 'f64')
    }
    return r
  })

  wat('__encodeURIComponent', `(func $__encodeURIComponent (param $val i64) (result f64)
    (local $str i64) (local $slen i32) (local $base i32) (local $out i32)
    (local $i i32) (local $j i32) (local $c i32) (local $hi i32) (local $lo i32)
    (local.set $str (call $__to_str (local.get $val)))
    (local.set $slen (call $__str_byteLen (local.get $str)))
    (if (i32.eqz (local.get $slen))
      (then (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${LAYOUT.SSO_BIT}) (i32.const 0)))))
    (local.set $base (call $__alloc (i32.add (i32.const 4) (i32.mul (local.get $slen) (i32.const 3)))))
    (local.set $out (i32.add (local.get $base) (i32.const 4)))
    (block $done (loop $loop
      (br_if $done (i32.ge_u (local.get $i) (local.get $slen)))
      (local.set $c (call $__char_at (local.get $str) (local.get $i)))
      (if (i32.or
            (i32.or
              (i32.or
                (i32.and (i32.ge_u (local.get $c) (i32.const 65)) (i32.le_u (local.get $c) (i32.const 90)))
                (i32.and (i32.ge_u (local.get $c) (i32.const 97)) (i32.le_u (local.get $c) (i32.const 122))))
              (i32.and (i32.ge_u (local.get $c) (i32.const 48)) (i32.le_u (local.get $c) (i32.const 57))))
            (i32.or
              (i32.or
                (i32.or (i32.eq (local.get $c) (i32.const 45)) (i32.eq (local.get $c) (i32.const 95)))
                (i32.or (i32.eq (local.get $c) (i32.const 46)) (i32.eq (local.get $c) (i32.const 33))))
              (i32.or
                (i32.or (i32.eq (local.get $c) (i32.const 126)) (i32.eq (local.get $c) (i32.const 42)))
                (i32.or
                  (i32.eq (local.get $c) (i32.const 39))
                  (i32.or (i32.eq (local.get $c) (i32.const 40)) (i32.eq (local.get $c) (i32.const 41)))))))
        (then
          (i32.store8 (i32.add (local.get $out) (local.get $j)) (local.get $c))
          (local.set $j (i32.add (local.get $j) (i32.const 1))))
        (else
          (local.set $hi (i32.shr_u (local.get $c) (i32.const 4)))
          (local.set $lo (i32.and (local.get $c) (i32.const 15)))
          (i32.store8 (i32.add (local.get $out) (local.get $j)) (i32.const 37))
          (i32.store8 (i32.add (local.get $out) (i32.add (local.get $j) (i32.const 1)))
            (i32.add (local.get $hi) (select (i32.const 55) (i32.const 48) (i32.gt_u (local.get $hi) (i32.const 9)))))
          (i32.store8 (i32.add (local.get $out) (i32.add (local.get $j) (i32.const 2)))
            (i32.add (local.get $lo) (select (i32.const 55) (i32.const 48) (i32.gt_u (local.get $lo) (i32.const 9)))))
          (local.set $j (i32.add (local.get $j) (i32.const 3)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (i32.store (local.get $base) (local.get $j))
    (call $__sso_norm (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $out))))`)

  bind('encodeURIComponent', (value) => {
    inc('__encodeURIComponent')
    const input = value === undefined ? ['i64.const', UNDEF_NAN] : asI64(emit(value))
    return typed(['call', '$__encodeURIComponent', input], 'f64')
  })

  wat('__uri_hex', `(func $__uri_hex (param $c i32) (result i32)
    (if (result i32) (i32.and (i32.ge_u (local.get $c) (i32.const 48)) (i32.le_u (local.get $c) (i32.const 57)))
      (then (i32.sub (local.get $c) (i32.const 48)))
      (else (if (result i32) (i32.and (i32.ge_u (local.get $c) (i32.const 65)) (i32.le_u (local.get $c) (i32.const 70)))
        (then (i32.sub (local.get $c) (i32.const 55)))
        (else (if (result i32) (i32.and (i32.ge_u (local.get $c) (i32.const 97)) (i32.le_u (local.get $c) (i32.const 102)))
          (then (i32.sub (local.get $c) (i32.const 87)))
          (else (i32.const -1))))))))`)

  wat('__decodeURIComponent', `(func $__decodeURIComponent (param $v i64) (result f64)
    (local $s i64) (local $len i32) (local $i i32)
    (local $base i32) (local $dst i32) (local $outLen i32)
    (local $c i32) (local $hi i32) (local $lo i32)
    (local $b i32) (local $n i32) (local $j i32) (local $cp i32) (local $min i32) (local $stored i32)
    (local.set $s (call $__to_str (local.get $v)))
    (local.set $len (call $__str_byteLen (local.get $s)))
    (local.set $base (call $__alloc (i32.add (i32.const 4) (local.get $len))))
    (local.set $dst (i32.add (local.get $base) (i32.const 4)))
    (block $done (loop $loop
      (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
      (local.set $stored (i32.const 0))
      (local.set $c (call $__char_at (local.get $s) (local.get $i)))
      (if (i32.eq (local.get $c) (i32.const 37))
        (then
          (if (i32.ge_s (i32.add (local.get $i) (i32.const 2)) (local.get $len))
            (then (throw $__jz_err (f64.const 0))))
          (local.set $hi (call $__uri_hex (call $__char_at (local.get $s) (i32.add (local.get $i) (i32.const 1)))))
          (local.set $lo (call $__uri_hex (call $__char_at (local.get $s) (i32.add (local.get $i) (i32.const 2)))))
          (if (i32.or (i32.lt_s (local.get $hi) (i32.const 0)) (i32.lt_s (local.get $lo) (i32.const 0)))
            (then (throw $__jz_err (f64.const 0))))
          (local.set $c (i32.or (i32.shl (local.get $hi) (i32.const 4)) (local.get $lo)))
          (local.set $i (i32.add (local.get $i) (i32.const 3)))
          (if (i32.ge_u (local.get $c) (i32.const 128))
            (then
              (if (i32.and (i32.ge_u (local.get $c) (i32.const 0xC2)) (i32.le_u (local.get $c) (i32.const 0xDF)))
                (then
                  (local.set $n (i32.const 2))
                  (local.set $cp (i32.and (local.get $c) (i32.const 0x1F)))
                  (local.set $min (i32.const 0x80)))
                (else (if (i32.and (i32.ge_u (local.get $c) (i32.const 0xE0)) (i32.le_u (local.get $c) (i32.const 0xEF)))
                  (then
                    (local.set $n (i32.const 3))
                    (local.set $cp (i32.and (local.get $c) (i32.const 0x0F)))
                    (local.set $min (i32.const 0x800)))
                  (else (if (i32.and (i32.ge_u (local.get $c) (i32.const 0xF0)) (i32.le_u (local.get $c) (i32.const 0xF4)))
                    (then
                      (local.set $n (i32.const 4))
                      (local.set $cp (i32.and (local.get $c) (i32.const 0x07)))
                      (local.set $min (i32.const 0x10000)))
                    (else (throw $__jz_err (f64.const 0))))))))
              (i32.store8 (i32.add (local.get $dst) (local.get $outLen)) (local.get $c))
              (local.set $outLen (i32.add (local.get $outLen) (i32.const 1)))
              (local.set $j (i32.const 1))
              (block $seqDone (loop $seq
                (br_if $seqDone (i32.ge_s (local.get $j) (local.get $n)))
                (if (i32.ge_s (i32.add (local.get $i) (i32.const 2)) (local.get $len))
                  (then (throw $__jz_err (f64.const 0))))
                (if (i32.ne (call $__char_at (local.get $s) (local.get $i)) (i32.const 37))
                  (then (throw $__jz_err (f64.const 0))))
                (local.set $hi (call $__uri_hex (call $__char_at (local.get $s) (i32.add (local.get $i) (i32.const 1)))))
                (local.set $lo (call $__uri_hex (call $__char_at (local.get $s) (i32.add (local.get $i) (i32.const 2)))))
                (if (i32.or (i32.lt_s (local.get $hi) (i32.const 0)) (i32.lt_s (local.get $lo) (i32.const 0)))
                  (then (throw $__jz_err (f64.const 0))))
                (local.set $b (i32.or (i32.shl (local.get $hi) (i32.const 4)) (local.get $lo)))
                (if (i32.or (i32.lt_u (local.get $b) (i32.const 0x80)) (i32.gt_u (local.get $b) (i32.const 0xBF)))
                  (then (throw $__jz_err (f64.const 0))))
                (local.set $cp (i32.or (i32.shl (local.get $cp) (i32.const 6)) (i32.and (local.get $b) (i32.const 0x3F))))
                (i32.store8 (i32.add (local.get $dst) (local.get $outLen)) (local.get $b))
                (local.set $outLen (i32.add (local.get $outLen) (i32.const 1)))
                (local.set $i (i32.add (local.get $i) (i32.const 3)))
                (local.set $j (i32.add (local.get $j) (i32.const 1)))
                (br $seq)))
              (if (i32.or
                    (i32.or (i32.lt_u (local.get $cp) (local.get $min)) (i32.gt_u (local.get $cp) (i32.const 0x10FFFF)))
                    (i32.and (i32.ge_u (local.get $cp) (i32.const 0xD800)) (i32.le_u (local.get $cp) (i32.const 0xDFFF))))
                (then (throw $__jz_err (f64.const 0))))
              (local.set $stored (i32.const 1)))))
        (else
          (local.set $i (i32.add (local.get $i) (i32.const 1)))))
      (if (i32.eqz (local.get $stored))
        (then
          (i32.store8 (i32.add (local.get $dst) (local.get $outLen)) (local.get $c))
          (local.set $outLen (i32.add (local.get $outLen) (i32.const 1)))))
      (br $loop)))
    (i32.store (local.get $base) (local.get $outLen))
    (call $__sso_norm (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $dst))))`)

  bind('decodeURIComponent', (value) => {
    ctx.runtime.throws = true
    inc('__decodeURIComponent')
    return typed(['call', '$__decodeURIComponent',
      value === undefined ? ['i64.const', UNDEF_NAN] : asI64(emit(value))], 'f64')
  })

  // .at(i) → 1-char string at index i with negative-index support, or undefined
  // when out of range (JS spec: `i += length` for negative, then OOB → undefined).
  bind('.string:at', (str, idx) => {
    inc('__char_at', '__str_byteLen')
    const t = tempI32('at'), s = temp('as'), len = tempI32('al')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${s}`, asF64(emit(str))],
      ['local.set', `$${len}`, ['call', '$__str_byteLen', ['i64.reinterpret_f64', ['local.get', `$${s}`]]]],
      ['local.set', `$${t}`, asI32(emit(idx))],
      // Negative index: t += length
      ['if', ['i32.lt_s', ['local.get', `$${t}`], ['i32.const', 0]],
        ['then', ['local.set', `$${t}`, ['i32.add', ['local.get', `$${t}`], ['local.get', `$${len}`]]]]],
      charAtOr(`$${s}`, `$${t}`, ['local.get', `$${len}`],
        ['f64.reinterpret_i64', ['i64.const', UNDEF_NAN]])], 'f64')
  })

  // .search(str) → indexOf (same as indexOf for string args)
  bind('.search', (str, search) => {
    inc('__str_indexof')
    return typed(['f64.convert_i32_s', ['call', '$__str_indexof', asI64(emit(str)), asI64(emit(search)), ['i32.const', 0]]], 'f64')
  })

  // .match(str) → [match] array if found, or 0 (null) if not
  // For string args, returns single-element array with the matched substring
  bind('.match', (str, search) => {
    inc('__str_indexof', '__str_slice', '__wrap1')
    const s = temp('ms'), q = temp('mq'), idx = tempI32('mi')
    // indexOf, then if >= 0, create 1-element array with the match slice
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${s}`, asF64(emit(str))],
      ['local.set', `$${q}`, asF64(emit(search))],
      ['local.set', `$${idx}`, ['call', '$__str_indexof', ['i64.reinterpret_f64', ['local.get', `$${s}`]], ['i64.reinterpret_f64', ['local.get', `$${q}`]], ['i32.const', 0]]],
      ['if', ['result', 'f64'], ['i32.lt_s', ['local.get', `$${idx}`], ['i32.const', 0]],
        ['then', ['f64.const', 0]],  // null
        ['else',
          // Build 1-element array containing the search string
          ['call', '$__wrap1',
            ['i64.reinterpret_f64',
              ['call', '$__str_slice', ['i64.reinterpret_f64', ['local.get', `$${s}`]],
                ['local.get', `$${idx}`],
                ['i32.add', ['local.get', `$${idx}`], ['call', '$__str_byteLen', ['i64.reinterpret_f64', ['local.get', `$${q}`]]]]]]]]]], 'f64')
  })

  // __wrap1(val: i64) → f64 — create 1-element array [val]
  wat('__wrap1', `(func $__wrap1 (param $val i64) (result f64)
    (local $ptr i32)
    (local.set $ptr (call $__alloc (i32.const 16)))
    (i32.store (local.get $ptr) (i32.const 1))
    (i32.store (i32.add (local.get $ptr) (i32.const 4)) (i32.const 1))
    (i64.store (i32.add (local.get $ptr) (i32.const 8)) (local.get $val))
    (call $__mkptr (i32.const 1) (i32.const 0) (i32.add (local.get $ptr) (i32.const 8))))`)

  // TextEncoder() / TextDecoder() → dummy values (methods do the work)
  bind('TextEncoder', () => typed(['f64.const', 1], 'f64'))
  bind('TextDecoder', () => typed(['f64.const', 2], 'f64'))

  // .encode(str) → Uint8Array of string's UTF-8 bytes
  // Copies bytes from string (SSO or heap) into a new Uint8Array
  wat('__str_encode', `(func $__str_encode (param $str i64) (result f64)
    (local $len i32) (local $dst i32)
    (local.set $len (call $__str_byteLen (local.get $str)))
    (local.set $dst (call $__alloc (i32.add (i32.const 8) (local.get $len))))
    (i32.store (local.get $dst) (local.get $len))
    (i32.store (i32.add (local.get $dst) (i32.const 4)) (local.get $len))
    (local.set $dst (i32.add (local.get $dst) (i32.const 8)))
    (call $__str_copy (local.get $str) (local.get $dst) (local.get $len))
    (call $__mkptr (i32.const 3) (i32.const 1) (local.get $dst)))`)

  bind('.encode', (obj, str) => {
    inc('__str_encode')
    // .encode() yields a runtime PTR.TYPED/u8 array (see __mkptr above). Downstream
    // indexing/spread dispatch through __typed_idx, whose element-unaware fallback
    // (f64.load, stride 8) is only valid when no typed array can flow in. Enabling
    // the feature pulls the element-aware variant — same invariant `.length` follows.
    ctx.features.typedarray = true
    return typed(['call', '$__str_encode', asI64(emit(str))], 'f64')
  })

  // .decode(uint8arr) → string from byte data
  wat('__bytes_decode', `(func $__bytes_decode (param $arr i64) (result f64)
    (local $off i32) (local $len i32) (local $dst i32)
    (local.set $off (call $__ptr_offset (local.get $arr)))
    (local.set $len (call $__len (local.get $arr)))
    (local.set $dst (call $__alloc (i32.add (i32.const 4) (local.get $len))))
    (i32.store (local.get $dst) (local.get $len))
    (local.set $dst (i32.add (local.get $dst) (i32.const 4)))
    (memory.copy (local.get $dst) (local.get $off) (local.get $len))
    ;; short ASCII decode → SSO (invariant)
    (if (i32.le_u (local.get $len) (i32.const ${MAX_SSO}))
      (then (return (call $__sso_norm (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $dst))))))
    (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $dst)))`)

  bind('.decode', (obj, arr) => {
    inc('__bytes_decode')
    return typed(['call', '$__bytes_decode', asI64(emit(arr))], 'f64')
  })
}
