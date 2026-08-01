/**
 * Central registry of `$__jz_err` runtime throw-site codes.
 *
 * Every one of jz's ~48 in-stdlib `(throw $__jz_err (f64.const N))` sites used
 * to throw the SAME sentinel `0` — a TypeError, a RangeError, a JSON.parse
 * SyntaxError and a bounds check were all indistinguishable to anything that
 * caught them (in-wasm `catch`, or the host boundary). This table gives each
 * site its own small integer, grouped by ECMAScript error class:
 *
 *   1xx  TypeError-class   — coercion, receiver-shape, callability checks
 *   2xx  RangeError-class  — bounds, size, precision
 *   3xx  SyntaxError/URIError-class — JSON.parse, decodeURI, base64/hex decode
 *
 * `fs.js` is NOT in this table: its throws forward real POSIX errno values
 * (OS-defined, not jz's own), untouched by this registry.
 *
 * LEAF MODULE — no imports. interop.js (the host boundary, outside the
 * compiler) pulls ERR_INFO to resolve a caught code to a message without
 * dragging in any compile machinery; module/*.js and src/ir.js (emit sites)
 * pull ERR for the numeric constants. Never import compile/emit/ir modules
 * here — that coupling is the one this file exists to avoid.
 *
 * Codes are part of neither the language surface nor a stability contract for
 * external consumers — they're an internal diagnostic aid. Renumbering is
 * safe; keep names stable within a session since messages are matched by
 * eye in the ledger, not machine-checked.
 */

export const ERR = {
  // ── 1xx TypeError-class ──────────────────────────────────────────────────
  TO_PRIMITIVE: 100,           // OrdinaryToPrimitive: every valueOf/toString returned non-primitive
  ARRAY_FROM_MAPFN: 101,       // Array.from(iterable, mapFn) — mapFn is not callable
  GROUP_BY_CALLBACK: 102,      // Object.groupBy/Map.groupBy — callback is not callable
  CLONE_UNCLONEABLE: 103,      // structuredClone — function/host handle can't be cloned
  ITERATE_NULLISH: 104,        // for-of/spread over null/undefined
  CRYPTO_NOT_TYPED: 105,       // crypto.getRandomValues — receiver not an integer-typed array
  CRYPTO_FLOAT_TYPE: 106,      // crypto.getRandomValues — Float32Array/Float64Array rejected
  JSON_CIRCULAR: 107,          // JSON.stringify — circular reference
  JSON_BIGINT: 108,            // JSON.stringify — BigInt has no JSON representation
  OBJECT_NULLISH: 109,         // Object.keys/values/entries(null/undefined)
  SYMBOL_TO_NUMBER: 110,       // ToNumber(Symbol)
  STRING_SEARCH_REGEX: 111,    // String#{includes,startsWith,endsWith}(regex)
  ENCODE_INTO_RECEIVER: 112,   // String#encodeInto — destination not a Uint8Array
  U8_RECEIVER: 113,            // Uint8Array-only method called on a non-Uint8Array
  ATOMICS_RECEIVER32: 114,     // Atomics.* — receiver not an Int32Array
  ATOMICS_RECEIVER64: 115,     // Atomics.* — receiver not a BigInt64Array

  // ── 2xx RangeError-class ─────────────────────────────────────────────────
  ARRAY_WITH_INDEX: 200,       // Array.prototype.with — index out of range
  ATOMICS_INDEX32: 201,        // Atomics.* — Int32Array index out of range
  ATOMICS_INDEX64: 202,        // Atomics.* — BigInt64Array index out of range
  CRYPTO_QUOTA: 203,           // crypto.getRandomValues — byteLength > 65536
  JSON_TOO_DEEP: 204,          // JSON.stringify — nesting exceeds jz's cycle-stack buffer
  NUMBER_RADIX: 205,           // Number.prototype.toString(radix) — radix outside [2,36]
  NUMBER_TO_BIGINT_RANGE: 206, // BigInt(number) — not a finite integer
  FROM_CODE_POINT_RANGE: 207,  // String.fromCodePoint — not an integer in [0, 0x10FFFF]
  ARRAY_BUFFER_LENGTH: 208,    // new ArrayBuffer(n) — negative or unrepresentable length
  DATAVIEW_INDEX_RANGE: 209,   // DataView get/set — byte offset negative or > 2^53-1
  DATAVIEW_OFFSET_OOB_FAST: 210, // DataView get/set (proven-i32 offset) — outside view bounds
  DATAVIEW_OFFSET_OOB: 211,    // DataView get/set (dynamic offset) — outside view bounds
  TYPED_WITH_INDEX: 212,       // TypedArray.prototype.with — index out of range

  // ── 3xx SyntaxError/URIError-class ───────────────────────────────────────
  JSON_PARSE_SYNTAX: 300,      // JSON.parse — malformed input
  BIGINT_PARSE_DIGIT: 301,     // BigInt(string) — invalid digit for the given radix
  BIGINT_PARSE_EMPTY: 302,     // BigInt(string) — sign/radix prefix with no digits
  URI_TRUNC_ESCAPE: 303,       // decodeURI(Component) — truncated %-escape
  URI_BAD_HEX: 304,            // decodeURI(Component) — non-hex digit after %
  URI_BAD_LEAD_BYTE: 305,      // decodeURI(Component) — invalid UTF-8 leading byte
  URI_TRUNC_CONT_ESCAPE: 306,  // decodeURI(Component) — truncated continuation %-escape
  URI_MISSING_CONT_PERCENT: 307, // decodeURI(Component) — continuation byte not %-escaped
  URI_BAD_CONT_HEX: 308,       // decodeURI(Component) — non-hex digit in continuation escape
  URI_BAD_CONT_BYTE: 309,      // decodeURI(Component) — continuation byte outside 0x80-0xBF
  URI_BAD_CODEPOINT: 310,      // decodeURI(Component) — out-of-range or surrogate code point
  BASE64_TRAILING_CHAR: 311,   // fromBase64 — non-whitespace char after complete padding
  BASE64_EARLY_PAD: 312,       // fromBase64 — '=' with fewer than 2 chars in the quantum
  BASE64_CHAR_AFTER_PAD: 313,  // fromBase64 — value char inside an open padding run
  BASE64_INVALID_CHAR: 314,    // fromBase64 — char outside the base64/base64url alphabet
  BASE64_UNTERMINATED_PAD: 315, // fromBase64 — EOF with an unterminated padding run
  BASE64_LEFTOVER_CHAR: 316,   // fromBase64 — EOF with exactly one leftover quantum char
  HEX_ODD_LENGTH: 317,         // fromHex/setFromHex — odd-length input
  HEX_INVALID_DIGIT: 318,      // fromHex/setFromHex — non-hex character
}

/** code → { name, message }. `name` is the ECMAScript error class this site
 *  models (used by interop.js's decodeThrown to build a real host Error). */
export const ERR_INFO = {
  [ERR.TO_PRIMITIVE]: { name: 'TypeError', message: 'Cannot convert object to primitive value' },
  [ERR.ARRAY_FROM_MAPFN]: { name: 'TypeError', message: 'Array.from: mapFn is not a function' },
  [ERR.GROUP_BY_CALLBACK]: { name: 'TypeError', message: 'groupBy callback is not a function' },
  [ERR.CLONE_UNCLONEABLE]: { name: 'TypeError', message: 'could not be cloned' },
  [ERR.ITERATE_NULLISH]: { name: 'TypeError', message: 'Cannot iterate null or undefined' },
  [ERR.CRYPTO_NOT_TYPED]: { name: 'TypeError', message: 'getRandomValues: argument must be an integer-typed array' },
  [ERR.CRYPTO_FLOAT_TYPE]: { name: 'TypeError', message: 'getRandomValues: Float32Array/Float64Array are not allowed' },
  [ERR.JSON_CIRCULAR]: { name: 'TypeError', message: 'Converting circular structure to JSON' },
  [ERR.JSON_BIGINT]: { name: 'TypeError', message: 'Do not know how to serialize a BigInt' },
  [ERR.OBJECT_NULLISH]: { name: 'TypeError', message: 'Cannot convert undefined or null to object' },
  [ERR.SYMBOL_TO_NUMBER]: { name: 'TypeError', message: 'Cannot convert a Symbol value to a number' },
  [ERR.STRING_SEARCH_REGEX]: { name: 'TypeError', message: 'First argument must not be a regular expression' },
  [ERR.ENCODE_INTO_RECEIVER]: { name: 'TypeError', message: 'encodeInto: destination must be a Uint8Array' },
  [ERR.U8_RECEIVER]: { name: 'TypeError', message: 'receiver must be a Uint8Array' },
  [ERR.ATOMICS_RECEIVER32]: { name: 'TypeError', message: 'Atomics: receiver must be an Int32Array' },
  [ERR.ATOMICS_RECEIVER64]: { name: 'TypeError', message: 'Atomics: receiver must be a BigInt64Array' },

  [ERR.ARRAY_WITH_INDEX]: { name: 'RangeError', message: 'Invalid index' },
  [ERR.ATOMICS_INDEX32]: { name: 'RangeError', message: 'index out of range' },
  [ERR.ATOMICS_INDEX64]: { name: 'RangeError', message: 'index out of range' },
  [ERR.CRYPTO_QUOTA]: { name: 'RangeError', message: 'byteLength exceeds the maximum of 65536' },
  [ERR.JSON_TOO_DEEP]: { name: 'RangeError', message: 'JSON structure nesting too deep' },
  [ERR.NUMBER_RADIX]: { name: 'RangeError', message: 'toString() radix must be between 2 and 36' },
  [ERR.NUMBER_TO_BIGINT_RANGE]: { name: 'RangeError', message: 'The number is not a finite integer, cannot convert to a BigInt' },
  [ERR.FROM_CODE_POINT_RANGE]: { name: 'RangeError', message: 'Invalid code point' },
  [ERR.ARRAY_BUFFER_LENGTH]: { name: 'RangeError', message: 'Invalid array buffer length' },
  [ERR.DATAVIEW_INDEX_RANGE]: { name: 'RangeError', message: 'Invalid DataView offset' },
  [ERR.DATAVIEW_OFFSET_OOB_FAST]: { name: 'RangeError', message: 'Offset is outside the bounds of the DataView' },
  [ERR.DATAVIEW_OFFSET_OOB]: { name: 'RangeError', message: 'Offset is outside the bounds of the DataView' },
  [ERR.TYPED_WITH_INDEX]: { name: 'RangeError', message: 'Invalid typed array index' },

  [ERR.JSON_PARSE_SYNTAX]: { name: 'SyntaxError', message: 'Unexpected token in JSON' },
  [ERR.BIGINT_PARSE_DIGIT]: { name: 'SyntaxError', message: 'Cannot convert string to a BigInt' },
  [ERR.BIGINT_PARSE_EMPTY]: { name: 'SyntaxError', message: 'Cannot convert string to a BigInt' },
  [ERR.URI_TRUNC_ESCAPE]: { name: 'URIError', message: 'URI malformed' },
  [ERR.URI_BAD_HEX]: { name: 'URIError', message: 'URI malformed' },
  [ERR.URI_BAD_LEAD_BYTE]: { name: 'URIError', message: 'URI malformed' },
  [ERR.URI_TRUNC_CONT_ESCAPE]: { name: 'URIError', message: 'URI malformed' },
  [ERR.URI_MISSING_CONT_PERCENT]: { name: 'URIError', message: 'URI malformed' },
  [ERR.URI_BAD_CONT_HEX]: { name: 'URIError', message: 'URI malformed' },
  [ERR.URI_BAD_CONT_BYTE]: { name: 'URIError', message: 'URI malformed' },
  [ERR.URI_BAD_CODEPOINT]: { name: 'URIError', message: 'URI malformed' },
  [ERR.BASE64_TRAILING_CHAR]: { name: 'SyntaxError', message: 'Unexpected character after base64 padding' },
  [ERR.BASE64_EARLY_PAD]: { name: 'SyntaxError', message: 'Unexpected base64 padding' },
  [ERR.BASE64_CHAR_AFTER_PAD]: { name: 'SyntaxError', message: 'Unexpected character after base64 padding' },
  [ERR.BASE64_INVALID_CHAR]: { name: 'SyntaxError', message: 'Invalid base64 character' },
  [ERR.BASE64_UNTERMINATED_PAD]: { name: 'SyntaxError', message: 'Unterminated base64 padding' },
  [ERR.BASE64_LEFTOVER_CHAR]: { name: 'SyntaxError', message: 'Malformed base64 string' },
  [ERR.HEX_ODD_LENGTH]: { name: 'SyntaxError', message: 'Hex string must have an even length' },
  [ERR.HEX_INVALID_DIGIT]: { name: 'SyntaxError', message: 'Invalid hex character' },
}
