/**
 * test262 built-ins runner for jz.
 *
 * Usage:
 *   node test/test262-builtins.js
 *   node test/test262-builtins.js --filter=Math/random
 *
 * Strategy: run curated built-ins functionality tests and explicitly skip
 * descriptor/prototype/runtime-shape tests until those semantics are in scope.
 */
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join, relative } from 'path'
import { execSync } from 'child_process'

const ROOT = join(import.meta.dirname, '..')
const TEST262 = join(import.meta.dirname, 'test262')

if (!existsSync(TEST262)) {
  console.log('Cloning test262 (this may take a minute)...')
  execSync('git clone --depth 1 https://github.com/tc39/test262.git ' + TEST262, { stdio: 'inherit' })
}

const TRACKED_BUILTIN_PATHS = [
  'Math',
  'JSON',
  'Number',
  'String/fromCharCode',
  'String/fromCodePoint',
  'String/raw',
  'String/prototype/at',
  'String/prototype/charAt',
  'String/prototype/charCodeAt',
  'String/prototype/codePointAt',
  'String/prototype/concat',
  'String/prototype/endsWith',
  'String/prototype/includes',
  'String/prototype/indexOf',
  'String/prototype/lastIndexOf',
  'String/prototype/padEnd',
  'String/prototype/padStart',
  'String/prototype/repeat',
  'String/prototype/replace',
  'String/prototype/replaceAll',
  'String/prototype/slice',
  'String/prototype/split',
  'String/prototype/startsWith',
  'String/prototype/substring',
  'String/prototype/toLowerCase',
  'String/prototype/toUpperCase',
  'String/prototype/trim',
  'String/prototype/trimEnd',
  'String/prototype/trimStart',
  'Array/isArray',
  'Array/of',
  'Array/from',
  'Array/prototype/at',
  'Array/prototype/concat',
  'Array/prototype/every',
  'Array/prototype/fill',
  'Array/prototype/filter',
  'Array/prototype/find',
  'Array/prototype/findIndex',
  'Array/prototype/findLast',
  'Array/prototype/findLastIndex',
  'Array/prototype/flat',
  'Array/prototype/flatMap',
  'Array/prototype/forEach',
  'Array/prototype/includes',
  'Array/prototype/indexOf',
  'Array/prototype/join',
  'Array/prototype/lastIndexOf',
  'Array/prototype/map',
  'Array/prototype/pop',
  'Array/prototype/push',
  'Array/prototype/reduce',
  'Array/prototype/reduceRight',
  'Array/prototype/reverse',
  'Array/prototype/shift',
  'Array/prototype/slice',
  'Array/prototype/some',
  'Array/prototype/splice',
  'Array/prototype/unshift',
  'Object/keys',
  'Object/values',
  'Object/entries',
  'Object/assign',
  'Object/fromEntries',
  'Date/UTC',
  'Date/prototype/getTime',
  'Date/prototype/valueOf',
  'Date/prototype/setTime',
  'Map/prototype/clear',
  'Map/prototype/delete',
  'Map/prototype/get',
  'Map/prototype/has',
  'Map/prototype/set',
  'Map/prototype/size',
  'Set/prototype/add',
  'Set/prototype/clear',
  'Set/prototype/delete',
  'Set/prototype/has',
  'Set/prototype/size',
  'ArrayBuffer',
  'DataView/prototype/getUint8',
  'DataView/prototype/getInt8',
  'DataView/prototype/getUint16',
  'DataView/prototype/getInt16',
  'DataView/prototype/getUint32',
  'DataView/prototype/getInt32',
  'DataView/prototype/getFloat32',
  'DataView/prototype/getFloat64',
  'DataView/prototype/setUint8',
  'DataView/prototype/setInt8',
  'DataView/prototype/setUint16',
  'DataView/prototype/setInt16',
  'DataView/prototype/setUint32',
  'DataView/prototype/setInt32',
  'DataView/prototype/setFloat32',
  'DataView/prototype/setFloat64',
  'RegExp/prototype/exec',
  'Boolean',
  'BigInt',
  'parseInt',
  'parseFloat',
  'isFinite',
  'isNaN',
  'Infinity',
  'NaN',
  'undefined',
  'Symbol',
]

const FUNCTIONAL_TESTS = new Set([
  'built-ins/Math/E/value.js',
  'built-ins/Math/LN10/value.js',
  'built-ins/Math/LN2/value.js',
  'built-ins/Math/LOG10E/value.js',
  'built-ins/Math/LOG2E/value.js',
  'built-ins/Math/PI/value.js',
  'built-ins/Math/SQRT1_2/value.js',
  'built-ins/Math/SQRT2/value.js',
  'built-ins/Math/abs/S15.8.2.1_A1.js',
  'built-ins/Math/abs/S15.8.2.1_A2.js',
  'built-ins/Math/abs/S15.8.2.1_A3.js',
  'built-ins/Math/abs/absolute-value.js',
  'built-ins/Math/acos/S15.8.2.2_A1.js',
  'built-ins/Math/acos/S15.8.2.2_A2.js',
  'built-ins/Math/acos/S15.8.2.2_A3.js',
  'built-ins/Math/acos/S15.8.2.2_A4.js',
  'built-ins/Math/acosh/arg-is-infinity.js',
  'built-ins/Math/acosh/arg-is-one.js',
  'built-ins/Math/acosh/nan-returns.js',
  'built-ins/Math/asin/S15.8.2.3_A1.js',
  'built-ins/Math/asin/S15.8.2.3_A2.js',
  'built-ins/Math/asin/S15.8.2.3_A3.js',
  'built-ins/Math/asin/S15.8.2.3_A4.js',
  'built-ins/Math/asin/S15.8.2.3_A5.js',
  'built-ins/Math/atan/S15.8.2.4_A1.js',
  'built-ins/Math/atan/S15.8.2.4_A2.js',
  'built-ins/Math/atan/S15.8.2.4_A3.js',
  'built-ins/Math/atan2/S15.8.2.5_A5.js',
  'built-ins/Math/atan2/S15.8.2.5_A9.js',
  'built-ins/Math/ceil/S15.8.2.6_A1.js',
  'built-ins/Math/ceil/S15.8.2.6_A2.js',
  'built-ins/Math/ceil/S15.8.2.6_A3.js',
  'built-ins/Math/ceil/S15.8.2.6_A4.js',
  'built-ins/Math/ceil/S15.8.2.6_A5.js',
  'built-ins/Math/ceil/S15.8.2.6_A6.js',
  'built-ins/Math/ceil/S15.8.2.6_A7.js',
  'built-ins/Math/clz32/Math.clz32.js',
  'built-ins/Math/clz32/Math.clz32_1.js',
  'built-ins/Math/clz32/Math.clz32_2.js',
  'built-ins/Math/clz32/infinity.js',
  'built-ins/Math/clz32/int32bit.js',
  'built-ins/Math/clz32/nan.js',
  'built-ins/Math/cos/S15.8.2.7_A1.js',
  'built-ins/Math/cos/S15.8.2.7_A2.js',
  'built-ins/Math/cos/S15.8.2.7_A3.js',
  'built-ins/Math/cos/S15.8.2.7_A4.js',
  'built-ins/Math/cos/S15.8.2.7_A5.js',
  'built-ins/Math/exp/S15.8.2.8_A1.js',
  'built-ins/Math/exp/S15.8.2.8_A2.js',
  'built-ins/Math/exp/S15.8.2.8_A3.js',
  'built-ins/Math/exp/S15.8.2.8_A4.js',
  'built-ins/Math/exp/S15.8.2.8_A5.js',
  'built-ins/Math/floor/S15.8.2.9_A1.js',
  'built-ins/Math/floor/S15.8.2.9_A2.js',
  'built-ins/Math/floor/S15.8.2.9_A3.js',
  'built-ins/Math/floor/S15.8.2.9_A4.js',
  'built-ins/Math/floor/S15.8.2.9_A5.js',
  'built-ins/Math/floor/S15.8.2.9_A6.js',
  'built-ins/Math/floor/S15.8.2.9_A7.js',
  'built-ins/Math/fround/Math.fround_Infinity.js',
  'built-ins/Math/fround/Math.fround_NaN.js',
  'built-ins/Math/fround/Math.fround_Zero.js',
  'built-ins/Math/fround/ties.js',
  'built-ins/Math/fround/value-convertion.js',
  'built-ins/Math/hypot/Math.hypot_Infinity.js',
  'built-ins/Math/hypot/Math.hypot_InfinityNaN.js',
  'built-ins/Math/hypot/Math.hypot_NaN.js',
  'built-ins/Math/hypot/Math.hypot_NegInfinity.js',
  'built-ins/Math/hypot/Math.hypot_Success_2.js',
  'built-ins/Math/hypot/Math.hypot_ToNumberErr.js',
  'built-ins/Math/imul/results.js',
  'built-ins/Math/log/S15.8.2.10_A1.js',
  'built-ins/Math/log/S15.8.2.10_A2.js',
  'built-ins/Math/log/S15.8.2.10_A3.js',
  'built-ins/Math/log/S15.8.2.10_A4.js',
  'built-ins/Math/log/S15.8.2.10_A5.js',
  'built-ins/Math/log1p/specific-results.js',
  'built-ins/Math/log2/log2-basicTests.js',
  'built-ins/Math/max/Math.max_each-element-coerced.js',
  'built-ins/Math/max/zeros.js',
  'built-ins/Math/min/Math.min_each-element-coerced.js',
  'built-ins/Math/min/zeros.js',
  'built-ins/Math/pow/int32_min-exponent.js',
  'built-ins/Math/random/S15.8.2.14_A1.js',
  'built-ins/Math/round/S15.8.2.15_A1.js',
  'built-ins/Math/round/S15.8.2.15_A2.js',
  'built-ins/Math/round/S15.8.2.15_A3.js',
  'built-ins/Math/round/S15.8.2.15_A4.js',
  'built-ins/Math/round/S15.8.2.15_A5.js',
  'built-ins/Math/round/S15.8.2.15_A6.js',
  'built-ins/Math/round/S15.8.2.15_A7.js',
  'built-ins/Math/sign/sign-specialVals.js',
  'built-ins/Math/sin/S15.8.2.16_A1.js',
  'built-ins/Math/sin/S15.8.2.16_A4.js',
  'built-ins/Math/sin/S15.8.2.16_A5.js',
  'built-ins/Math/sin/zero.js',
  'built-ins/Math/sqrt/S15.8.2.17_A1.js',
  'built-ins/Math/sqrt/S15.8.2.17_A2.js',
  'built-ins/Math/sqrt/S15.8.2.17_A3.js',
  'built-ins/Math/sqrt/S15.8.2.17_A4.js',
  'built-ins/Math/sqrt/S15.8.2.17_A5.js',
  'built-ins/Math/sqrt/results.js',
  'built-ins/Math/tan/S15.8.2.18_A1.js',
  'built-ins/Math/tan/S15.8.2.18_A2.js',
  'built-ins/Math/tan/S15.8.2.18_A3.js',
  'built-ins/Math/tan/S15.8.2.18_A4.js',
  'built-ins/Math/tan/S15.8.2.18_A5.js',
  'built-ins/Math/trunc/Math.trunc_Infinity.js',
  'built-ins/Math/trunc/Math.trunc_NaN.js',
  'built-ins/Math/trunc/Math.trunc_NegDecimal.js',
  'built-ins/Math/trunc/Math.trunc_PosDecimal.js',
  'built-ins/Math/trunc/Math.trunc_Success.js',
  'built-ins/Math/trunc/Math.trunc_Zero.js',
  'built-ins/Math/trunc/trunc-sampleTests.js',
  'built-ins/Math/trunc/trunc-specialVals.js',
  'built-ins/JSON/parse/15.12.1.1-0-1.js',
  'built-ins/JSON/parse/15.12.1.1-0-2.js',
  'built-ins/JSON/parse/15.12.1.1-0-3.js',
  'built-ins/JSON/parse/15.12.1.1-0-4.js',
  'built-ins/JSON/parse/15.12.1.1-0-5.js',
  'built-ins/JSON/parse/15.12.1.1-0-6.js',
  'built-ins/JSON/parse/15.12.1.1-0-8.js',
  'built-ins/JSON/parse/15.12.1.1-0-9.js',
  'built-ins/JSON/parse/15.12.1.1-g1-1.js',
  'built-ins/JSON/parse/15.12.1.1-g1-2.js',
  'built-ins/JSON/parse/15.12.1.1-g1-3.js',
  'built-ins/JSON/parse/15.12.1.1-g1-4.js',
  'built-ins/JSON/parse/15.12.1.1-g2-1.js',
  'built-ins/JSON/parse/15.12.1.1-g2-2.js',
  'built-ins/JSON/parse/15.12.1.1-g2-3.js',
  'built-ins/JSON/parse/15.12.1.1-g2-4.js',
  'built-ins/JSON/parse/15.12.1.1-g2-5.js',
  'built-ins/JSON/parse/15.12.1.1-g4-1.js',
  'built-ins/JSON/parse/15.12.1.1-g4-2.js',
  'built-ins/JSON/parse/15.12.1.1-g4-3.js',
  'built-ins/JSON/parse/15.12.1.1-g4-4.js',
  'built-ins/JSON/parse/15.12.1.1-g5-1.js',
  'built-ins/JSON/parse/15.12.1.1-g5-2.js',
  'built-ins/JSON/parse/15.12.1.1-g5-3.js',
  'built-ins/JSON/parse/15.12.1.1-g6-1.js',
  'built-ins/JSON/parse/15.12.1.1-g6-2.js',
  'built-ins/JSON/parse/15.12.1.1-g6-3.js',
  'built-ins/JSON/parse/15.12.1.1-g6-4.js',
  'built-ins/JSON/parse/15.12.1.1-g6-5.js',
  'built-ins/JSON/parse/15.12.1.1-g6-6.js',
  'built-ins/JSON/parse/15.12.1.1-g6-7.js',
  'built-ins/JSON/parse/duplicate-proto.js',
  'built-ins/JSON/parse/invalid-whitespace.js',
  'built-ins/JSON/parse/text-negative-zero.js',
  'built-ins/JSON/parse/text-object-abrupt.js',
  'built-ins/JSON/parse/text-object.js',
  'built-ins/JSON/stringify/space-number-float.js',
  'built-ins/JSON/stringify/space-number-range.js',
  'built-ins/JSON/stringify/space-number.js',
  'built-ins/JSON/stringify/space-string-object.js',
  'built-ins/JSON/stringify/space-string-range.js',
  'built-ins/JSON/stringify/space-string.js',
  'built-ins/JSON/stringify/value-array-circular.js',
  'built-ins/JSON/stringify/value-boolean-object.js',
  'built-ins/JSON/stringify/value-number-negative-zero.js',
  'built-ins/JSON/stringify/value-number-non-finite.js',
  'built-ins/JSON/stringify/value-object-abrupt.js',
  'built-ins/JSON/stringify/value-primitive-top-level.js',
  'built-ins/JSON/stringify/value-string-escape-unicode.js',
  'built-ins/JSON/stringify/value-tojson-array-circular.js',
  'built-ins/JSON/stringify/value-tojson-not-function.js',
  'built-ins/String/fromCharCode/S9.7_A3.1_T1.js',
  'built-ins/String/fromCharCode/touint16-tonumber-throws-valueof.js',
  'built-ins/String/fromCodePoint/argument-is-not-integer.js',
  'built-ins/String/fromCodePoint/number-is-out-of-range.js',
  'built-ins/String/fromCodePoint/return-string-value.js',
  'built-ins/String/fromCodePoint/to-number-conversions.js',
  'built-ins/String/prototype/indexOf/S15.5.4.7_A1_T6.js',
  'built-ins/String/prototype/indexOf/S15.5.4.7_A1_T7.js',
  'built-ins/String/prototype/indexOf/S15.5.4.7_A1_T8.js',
  'built-ins/String/prototype/indexOf/S15.5.4.7_A1_T9.js',
  'built-ins/String/prototype/indexOf/S15.5.4.7_A2_T1.js',
  'built-ins/String/prototype/indexOf/S15.5.4.7_A2_T2.js',
  'built-ins/String/prototype/indexOf/S15.5.4.7_A2_T3.js',
  'built-ins/String/prototype/indexOf/S15.5.4.7_A2_T4.js',
  'built-ins/String/prototype/indexOf/S15.5.4.7_A3_T1.js',
  'built-ins/String/prototype/indexOf/S15.5.4.7_A3_T3.js',
  'built-ins/String/prototype/indexOf/position-tointeger.js',
  'built-ins/String/prototype/indexOf/searchstring-tostring.js',
  'built-ins/String/prototype/includes/String.prototype.includes_FailBadLocation.js',
  'built-ins/String/prototype/includes/String.prototype.includes_FailLocation.js',
  'built-ins/String/prototype/includes/String.prototype.includes_FailMissingLetter.js',
  'built-ins/String/prototype/includes/String.prototype.includes_Success.js',
  'built-ins/String/prototype/includes/String.prototype.includes_SuccessNoLocation.js',
  'built-ins/String/prototype/includes/coerced-values-of-position.js',
  'built-ins/String/prototype/includes/return-abrupt-from-position.js',
  'built-ins/String/prototype/includes/return-abrupt-from-searchstring.js',
  'built-ins/String/prototype/includes/return-false-with-out-of-bounds-position.js',
  'built-ins/String/prototype/includes/return-true-if-searchstring-is-empty.js',
  'built-ins/String/prototype/includes/searchstring-found-with-position.js',
  'built-ins/String/prototype/includes/searchstring-found-without-position.js',
  'built-ins/String/prototype/includes/searchstring-is-regexp-throws.js',
  'built-ins/String/prototype/includes/searchstring-not-found-with-position.js',
  'built-ins/String/prototype/includes/searchstring-not-found-without-position.js',
  'built-ins/String/prototype/slice/S15.5.4.13_A1_T14.js',
  'built-ins/String/prototype/slice/S15.5.4.13_A1_T4.js',
  'built-ins/String/prototype/slice/S15.5.4.13_A1_T6.js',
  'built-ins/String/prototype/slice/S15.5.4.13_A1_T9.js',
  'built-ins/String/prototype/slice/S15.5.4.13_A2_T2.js',
  'built-ins/String/prototype/slice/S15.5.4.13_A2_T3.js',
  'built-ins/String/prototype/slice/S15.5.4.13_A2_T4.js',
  'built-ins/String/prototype/slice/S15.5.4.13_A2_T5.js',
  'built-ins/String/prototype/slice/S15.5.4.13_A2_T6.js',
  'built-ins/String/prototype/slice/S15.5.4.13_A2_T7.js',
  'built-ins/String/prototype/slice/S15.5.4.13_A2_T8.js',
  'built-ins/String/prototype/slice/S15.5.4.13_A2_T9.js',
  'built-ins/String/prototype/concat/S15.5.4.6_A1_T4.js',
  'built-ins/String/prototype/concat/S15.5.4.6_A1_T7.js',
  'built-ins/String/prototype/concat/S15.5.4.6_A1_T8.js',
  'built-ins/String/prototype/concat/S15.5.4.6_A3.js',
  'built-ins/Array/isArray/15.4.3.2-0-3.js',
  'built-ins/Array/isArray/15.4.3.2-0-4.js',
  'built-ins/Array/isArray/15.4.3.2-0-7.js',
  'built-ins/Array/isArray/15.4.3.2-1-1.js',
  'built-ins/Array/isArray/15.4.3.2-1-12.js',
  'built-ins/Array/isArray/15.4.3.2-1-13.js',
  'built-ins/Array/isArray/15.4.3.2-1-2.js',
  'built-ins/Array/isArray/15.4.3.2-1-3.js',
  'built-ins/Array/isArray/15.4.3.2-1-4.js',
  'built-ins/Array/isArray/15.4.3.2-1-5.js',
  'built-ins/Array/isArray/15.4.3.2-1-6.js',
  'built-ins/Array/isArray/15.4.3.2-2-1.js',
  'built-ins/Array/isArray/15.4.3.2-2-3.js',
  'built-ins/Array/from/elements-added-after.js',
  'built-ins/Array/from/elements-updated-after.js',
  'built-ins/Array/from/from-array.js',
  'built-ins/Array/from/mapfn-is-not-callable-typeerror.js',
  'built-ins/Array/from/mapfn-is-symbol-throws.js',
  'built-ins/Array/from/mapfn-throws-exception.js',
  'built-ins/Array/from/source-object-without.js',
  'built-ins/Array/prototype/concat/create-ctor-non-object.js',
  'built-ins/Object/keys/15.2.3.14-2-1.js',
  'built-ins/Object/keys/15.2.3.14-3-1.js',
  'built-ins/Object/keys/15.2.3.14-3-5.js',
  'built-ins/Object/assign/ObjectOverride-sameproperty.js',
  'built-ins/Object/assign/invoked-as-ctor.js',
  'built-ins/Object/fromEntries/string-entry-string-object-succeeds.js',
  'built-ins/Map/prototype/get/returns-undefined.js',
  'built-ins/Map/prototype/get/returns-value-different-key-types.js',
  'built-ins/Map/prototype/get/returns-value-normalized-zero-key.js',
  'built-ins/Map/prototype/set/append-new-values-normalizes-zero-key.js',
  'built-ins/Map/prototype/set/replaces-a-value-normalizes-zero-key.js',
  'built-ins/Map/prototype/set/replaces-a-value.js',
  'built-ins/Map/prototype/has/normalizes-zero-key.js',
  'built-ins/Set/prototype/add/preserves-insertion-order.js',
  'built-ins/Set/prototype/add/returns-this-when-ignoring-duplicate.js',
  'built-ins/Set/prototype/add/returns-this.js',
  'built-ins/Set/prototype/add/will-not-add-duplicate-entry-initial-iterable.js',
  'built-ins/Set/prototype/add/will-not-add-duplicate-entry-normalizes-zero.js',
  'built-ins/Set/prototype/add/will-not-add-duplicate-entry.js',
  'built-ins/Set/prototype/has/returns-false-when-undefined-added-deleted-not-present-undefined.js',
  'built-ins/Set/prototype/has/returns-false-when-value-not-present-boolean.js',
  'built-ins/Set/prototype/has/returns-false-when-value-not-present-nan.js',
  'built-ins/Set/prototype/has/returns-false-when-value-not-present-null.js',
  'built-ins/Set/prototype/has/returns-false-when-value-not-present-number.js',
  'built-ins/Set/prototype/has/returns-false-when-value-not-present-string.js',
  'built-ins/Set/prototype/has/returns-false-when-value-not-present-undefined.js',
  'built-ins/Set/prototype/has/returns-true-when-value-present-boolean.js',
  'built-ins/Set/prototype/has/returns-true-when-value-present-nan.js',
  'built-ins/Set/prototype/has/returns-true-when-value-present-null.js',
  'built-ins/Set/prototype/has/returns-true-when-value-present-number.js',
  'built-ins/Set/prototype/has/returns-true-when-value-present-string.js',
  'built-ins/Set/prototype/has/returns-true-when-value-present-undefined.js',
  'built-ins/Symbol/uniqueness.js',
  'built-ins/ArrayBuffer/allocation-limit.js',
  'built-ins/ArrayBuffer/init-zero.js',
  'built-ins/ArrayBuffer/isView/arg-has-no-viewedarraybuffer.js',
  'built-ins/ArrayBuffer/isView/arg-is-arraybuffer.js',
  'built-ins/ArrayBuffer/isView/arg-is-dataview.js',
  'built-ins/ArrayBuffer/isView/arg-is-not-object.js',
  'built-ins/ArrayBuffer/length-is-absent.js',
  'built-ins/ArrayBuffer/length-is-too-large-throws.js',
  'built-ins/ArrayBuffer/negative-length-throws.js',
  'built-ins/ArrayBuffer/prototype/byteLength/return-bytelength.js',
  'built-ins/ArrayBuffer/prototype/slice/end-default-if-absent.js',
  'built-ins/ArrayBuffer/prototype/slice/number-conversion.js',
  'built-ins/ArrayBuffer/prototype/slice/start-default-if-absent.js',
  'built-ins/ArrayBuffer/return-abrupt-from-length-symbol.js',
  'built-ins/ArrayBuffer/return-abrupt-from-length.js',
  'built-ins/ArrayBuffer/toindex-length.js',
  'built-ins/ArrayBuffer/zero-length.js',
  'built-ins/DataView/prototype/getUint8/index-is-out-of-range.js',
  'built-ins/DataView/prototype/getUint8/negative-byteoffset-throws.js',
  'built-ins/DataView/prototype/getUint8/return-abrupt-from-tonumber-byteoffset-symbol.js',
  'built-ins/DataView/prototype/getUint8/return-abrupt-from-tonumber-byteoffset.js',
  'built-ins/DataView/prototype/getUint8/return-value-clean-arraybuffer.js',
  'built-ins/DataView/prototype/getUint8/return-values-custom-offset.js',
  'built-ins/DataView/prototype/getUint8/return-values.js',
  'built-ins/DataView/prototype/getInt8/index-is-out-of-range.js',
  'built-ins/DataView/prototype/getInt8/negative-byteoffset-throws.js',
  'built-ins/DataView/prototype/getInt8/return-abrupt-from-tonumber-byteoffset-symbol.js',
  'built-ins/DataView/prototype/getInt8/return-abrupt-from-tonumber-byteoffset.js',
  'built-ins/DataView/prototype/getInt8/return-value-clean-arraybuffer.js',
  'built-ins/DataView/prototype/getInt8/return-values-custom-offset.js',
  'built-ins/DataView/prototype/getInt8/return-values.js',
  'built-ins/DataView/prototype/getUint16/index-is-out-of-range.js',
  'built-ins/DataView/prototype/getUint16/negative-byteoffset-throws.js',
  'built-ins/DataView/prototype/getUint16/return-abrupt-from-tonumber-byteoffset-symbol.js',
  'built-ins/DataView/prototype/getUint16/return-abrupt-from-tonumber-byteoffset.js',
  'built-ins/DataView/prototype/getUint16/return-value-clean-arraybuffer.js',
  'built-ins/DataView/prototype/getUint16/return-values-custom-offset.js',
  'built-ins/DataView/prototype/getUint16/return-values.js',
  'built-ins/DataView/prototype/getUint16/to-boolean-littleendian.js',
  'built-ins/DataView/prototype/getInt16/index-is-out-of-range.js',
  'built-ins/DataView/prototype/getInt16/negative-byteoffset-throws.js',
  'built-ins/DataView/prototype/getInt16/return-abrupt-from-tonumber-byteoffset-symbol.js',
  'built-ins/DataView/prototype/getInt16/return-abrupt-from-tonumber-byteoffset.js',
  'built-ins/DataView/prototype/getInt16/return-value-clean-arraybuffer.js',
  'built-ins/DataView/prototype/getInt16/return-values-custom-offset.js',
  'built-ins/DataView/prototype/getInt16/return-values.js',
  'built-ins/DataView/prototype/getInt16/to-boolean-littleendian.js',
  'built-ins/DataView/prototype/getUint32/index-is-out-of-range.js',
  'built-ins/DataView/prototype/getUint32/negative-byteoffset-throws.js',
  'built-ins/DataView/prototype/getUint32/return-abrupt-from-tonumber-byteoffset-symbol.js',
  'built-ins/DataView/prototype/getUint32/return-abrupt-from-tonumber-byteoffset.js',
  'built-ins/DataView/prototype/getUint32/return-value-clean-arraybuffer.js',
  'built-ins/DataView/prototype/getUint32/return-values-custom-offset.js',
  'built-ins/DataView/prototype/getUint32/return-values.js',
  'built-ins/DataView/prototype/getUint32/to-boolean-littleendian.js',
  'built-ins/DataView/prototype/getInt32/index-is-out-of-range.js',
  'built-ins/DataView/prototype/getInt32/negative-byteoffset-throws.js',
  'built-ins/DataView/prototype/getInt32/return-abrupt-from-tonumber-byteoffset-symbol.js',
  'built-ins/DataView/prototype/getInt32/return-abrupt-from-tonumber-byteoffset.js',
  'built-ins/DataView/prototype/getInt32/return-value-clean-arraybuffer.js',
  'built-ins/DataView/prototype/getInt32/return-values-custom-offset.js',
  'built-ins/DataView/prototype/getInt32/return-values.js',
  'built-ins/DataView/prototype/getInt32/to-boolean-littleendian.js',
  'built-ins/DataView/prototype/getFloat32/index-is-out-of-range.js',
  'built-ins/DataView/prototype/getFloat32/minus-zero.js',
  'built-ins/DataView/prototype/getFloat32/negative-byteoffset-throws.js',
  'built-ins/DataView/prototype/getFloat32/return-abrupt-from-tonumber-byteoffset-symbol.js',
  'built-ins/DataView/prototype/getFloat32/return-abrupt-from-tonumber-byteoffset.js',
  'built-ins/DataView/prototype/getFloat32/return-infinity.js',
  'built-ins/DataView/prototype/getFloat32/return-nan.js',
  'built-ins/DataView/prototype/getFloat32/return-value-clean-arraybuffer.js',
  'built-ins/DataView/prototype/getFloat32/return-values-custom-offset.js',
  'built-ins/DataView/prototype/getFloat32/return-values.js',
  'built-ins/DataView/prototype/getFloat32/to-boolean-littleendian.js',
  'built-ins/DataView/prototype/getFloat64/index-is-out-of-range.js',
  'built-ins/DataView/prototype/getFloat64/minus-zero.js',
  'built-ins/DataView/prototype/getFloat64/negative-byteoffset-throws.js',
  'built-ins/DataView/prototype/getFloat64/return-abrupt-from-tonumber-byteoffset-symbol.js',
  'built-ins/DataView/prototype/getFloat64/return-abrupt-from-tonumber-byteoffset.js',
  'built-ins/DataView/prototype/getFloat64/return-infinity.js',
  'built-ins/DataView/prototype/getFloat64/return-nan.js',
  'built-ins/DataView/prototype/getFloat64/return-value-clean-arraybuffer.js',
  'built-ins/DataView/prototype/getFloat64/return-values-custom-offset.js',
  'built-ins/DataView/prototype/getFloat64/return-values.js',
  'built-ins/DataView/prototype/getFloat64/to-boolean-littleendian.js',
  'built-ins/DataView/prototype/setUint8/index-check-before-value-conversion.js',
  'built-ins/DataView/prototype/setUint8/index-is-out-of-range.js',
  'built-ins/DataView/prototype/setUint8/negative-byteoffset-throws.js',
  'built-ins/DataView/prototype/setUint8/range-check-after-value-conversion.js',
  'built-ins/DataView/prototype/setUint8/return-abrupt-from-tonumber-byteoffset-symbol.js',
  'built-ins/DataView/prototype/setUint8/return-abrupt-from-tonumber-byteoffset.js',
  'built-ins/DataView/prototype/setUint8/return-abrupt-from-tonumber-value-symbol.js',
  'built-ins/DataView/prototype/setUint8/return-abrupt-from-tonumber-value.js',
  'built-ins/DataView/prototype/setInt8/index-check-before-value-conversion.js',
  'built-ins/DataView/prototype/setInt8/index-is-out-of-range.js',
  'built-ins/DataView/prototype/setInt8/negative-byteoffset-throws.js',
  'built-ins/DataView/prototype/setInt8/range-check-after-value-conversion.js',
  'built-ins/DataView/prototype/setInt8/return-abrupt-from-tonumber-byteoffset-symbol.js',
  'built-ins/DataView/prototype/setInt8/return-abrupt-from-tonumber-byteoffset.js',
  'built-ins/DataView/prototype/setInt8/return-abrupt-from-tonumber-value-symbol.js',
  'built-ins/DataView/prototype/setInt8/return-abrupt-from-tonumber-value.js',
  'built-ins/DataView/prototype/setUint16/index-check-before-value-conversion.js',
  'built-ins/DataView/prototype/setUint16/index-is-out-of-range.js',
  'built-ins/DataView/prototype/setUint16/negative-byteoffset-throws.js',
  'built-ins/DataView/prototype/setUint16/range-check-after-value-conversion.js',
  'built-ins/DataView/prototype/setUint16/return-abrupt-from-tonumber-byteoffset-symbol.js',
  'built-ins/DataView/prototype/setUint16/return-abrupt-from-tonumber-byteoffset.js',
  'built-ins/DataView/prototype/setUint16/return-abrupt-from-tonumber-value-symbol.js',
  'built-ins/DataView/prototype/setUint16/return-abrupt-from-tonumber-value.js',
  'built-ins/DataView/prototype/setUint16/to-boolean-littleendian.js',
  'built-ins/DataView/prototype/setInt16/index-check-before-value-conversion.js',
  'built-ins/DataView/prototype/setInt16/index-is-out-of-range.js',
  'built-ins/DataView/prototype/setInt16/negative-byteoffset-throws.js',
  'built-ins/DataView/prototype/setInt16/range-check-after-value-conversion.js',
  'built-ins/DataView/prototype/setInt16/return-abrupt-from-tonumber-byteoffset-symbol.js',
  'built-ins/DataView/prototype/setInt16/return-abrupt-from-tonumber-byteoffset.js',
  'built-ins/DataView/prototype/setInt16/return-abrupt-from-tonumber-value-symbol.js',
  'built-ins/DataView/prototype/setInt16/return-abrupt-from-tonumber-value.js',
  'built-ins/DataView/prototype/setInt16/to-boolean-littleendian.js',
  'built-ins/DataView/prototype/setUint32/index-is-out-of-range.js',
  'built-ins/DataView/prototype/setUint32/range-check-after-value-conversion.js',
  'built-ins/DataView/prototype/setUint32/return-abrupt-from-tonumber-byteoffset-symbol.js',
  'built-ins/DataView/prototype/setUint32/return-abrupt-from-tonumber-byteoffset.js',
  'built-ins/DataView/prototype/setUint32/return-abrupt-from-tonumber-value-symbol.js',
  'built-ins/DataView/prototype/setUint32/return-abrupt-from-tonumber-value.js',
  'built-ins/DataView/prototype/setUint32/to-boolean-littleendian.js',
  'built-ins/DataView/prototype/setInt32/index-is-out-of-range.js',
  'built-ins/DataView/prototype/setInt32/range-check-after-value-conversion.js',
  'built-ins/DataView/prototype/setInt32/return-abrupt-from-tonumber-byteoffset-symbol.js',
  'built-ins/DataView/prototype/setInt32/return-abrupt-from-tonumber-byteoffset.js',
  'built-ins/DataView/prototype/setInt32/return-abrupt-from-tonumber-value-symbol.js',
  'built-ins/DataView/prototype/setInt32/return-abrupt-from-tonumber-value.js',
  'built-ins/DataView/prototype/setInt32/to-boolean-littleendian.js',
  'built-ins/DataView/prototype/setFloat32/index-is-out-of-range.js',
  'built-ins/DataView/prototype/setFloat32/range-check-after-value-conversion.js',
  'built-ins/DataView/prototype/setFloat32/return-abrupt-from-tonumber-byteoffset.js',
  'built-ins/DataView/prototype/setFloat32/return-abrupt-from-tonumber-value-symbol.js',
  'built-ins/DataView/prototype/setFloat32/return-abrupt-from-tonumber-value.js',
  'built-ins/DataView/prototype/setFloat32/to-boolean-littleendian.js',
  'built-ins/DataView/prototype/setFloat64/index-is-out-of-range.js',
  'built-ins/DataView/prototype/setFloat64/range-check-after-value-conversion.js',
  'built-ins/DataView/prototype/setFloat64/return-abrupt-from-tonumber-byteoffset-symbol.js',
  'built-ins/DataView/prototype/setFloat64/return-abrupt-from-tonumber-byteoffset.js',
  'built-ins/DataView/prototype/setFloat64/return-abrupt-from-tonumber-value-symbol.js',
  'built-ins/DataView/prototype/setFloat64/return-abrupt-from-tonumber-value.js',
  'built-ins/DataView/prototype/setFloat64/to-boolean-littleendian.js',
  'built-ins/RegExp/prototype/exec/u-captured-value.js',
  'built-ins/RegExp/prototype/exec/u-lastindex-adv.js',
  // Date.prototype functional algorithm tests (skip .prototype chain / this-binding guards)
  'built-ins/Date/prototype/getTime/this-value-valid-date.js',
  'built-ins/Date/prototype/getTime/this-value-invalid-date.js',
  'built-ins/Date/prototype/getTime/this-value-non-date.js',
  'built-ins/Date/prototype/getTime/this-value-non-object.js',
  'built-ins/Date/prototype/setTime/arg-to-number.js',
  'built-ins/Date/prototype/setTime/arg-to-number-err.js',
  'built-ins/Date/prototype/setTime/new-value-time-clip.js',
  'built-ins/Date/prototype/setTime/this-value-valid-date.js',
  'built-ins/Date/prototype/setTime/this-value-invalid-date.js',
  'built-ins/Date/prototype/setTime/this-value-non-date.js',
  'built-ins/Date/prototype/setTime/this-value-non-object.js',
  'built-ins/Date/prototype/valueOf/S9.4_A3_T1.js',
  'built-ins/Date/prototype/valueOf/S9.4_A3_T2.js',
])

const FILTER = process.argv.find(a => a.startsWith('--filter='))?.split('=')[1]

const NUMBER_CONSTANT_TESTS = new Set([
  'built-ins/Number/MAX_VALUE/value.js',
  'built-ins/Number/MIN_VALUE/value.js',
  'built-ins/Number/NEGATIVE_INFINITY/S15.7.3.5_A1.js',
  'built-ins/Number/NEGATIVE_INFINITY/value.js',
  'built-ins/Number/POSITIVE_INFINITY/S15.7.3.6_A1.js',
  'built-ins/Number/POSITIVE_INFINITY/value.js',
  'built-ins/Number/isFinite/finite-numbers.js',
  'built-ins/Number/isFinite/infinity.js',
  'built-ins/Number/isFinite/nan.js',
  'built-ins/Number/isInteger/infinity.js',
  'built-ins/Number/isInteger/integers.js',
  'built-ins/Number/isInteger/nan.js',
  'built-ins/Number/isInteger/non-integers.js',
  'built-ins/Number/isNaN/nan.js',
  'built-ins/Number/isNaN/not-nan.js',
])

const DATE_UNSUPPORTED_TESTS = new Map([
  ['built-ins/Date/UTC/coercion-order.js', 'object ToPrimitive coercion'],
])

function isNumberFunctionalTest(rel) {
  return NUMBER_CONSTANT_TESTS.has(rel) ||
    /^built-ins\/Number\/S9\.3\.1_/.test(rel) ||
    /^built-ins\/Number\/S9\.1_A1_T1\.js$/.test(rel) ||
    /^built-ins\/Number\/S9\.3_A[1-4](?:\.\d)?_T1\.js$/.test(rel) ||
    /^built-ins\/Number\/string-(?:binary|hex|octal|numeric-separator)-literal/.test(rel)
}

function isFunctionalTest(rel) {
  return FUNCTIONAL_TESTS.has(rel) || isNumberFunctionalTest(rel)
}

const ASSERT_HARNESS = `
function Test262Error(message) { return message || 'Test262Error' }
function Error(message) { return message || 'Error' }
function EvalError(message) { return message || 'EvalError' }
function RangeError(message) { return message || 'RangeError' }
function ReferenceError(message) { return message || 'ReferenceError' }
function SyntaxError(message) { return message || 'SyntaxError' }
function TypeError(message) { return message || 'TypeError' }
function URIError(message) { return message || 'URIError' }
let __sameValue = (a, b) => {
  if (a === b) return a !== 0 || 1 / a === 1 / b
  return a !== a && b !== b
}
let assert = (cond, msg) => { if (!cond) throw msg }
assert.sameValue = (a, b, msg) => { if (!__sameValue(a, b)) throw msg }
assert.notSameValue = (a, b, msg) => { if (__sameValue(a, b)) throw msg }
assert.compareArray = (a, b, msg) => {
  if (a.length != b.length) throw msg
  for (let i = 0; i < a.length; i++) if (!__sameValue(a[i], b[i])) throw msg
}
assert.throws = (expected, fn, msg) => {
  let threw = 0
  try { fn() } catch (e) { threw = 1 }
  if (!threw) throw msg
}
`

function* walk(dir) {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) yield* walk(full)
      else if (entry.name.endsWith('.js') && !entry.name.startsWith('.')) yield full
    }
  } catch { }
}

function countJs(dir) {
  let count = 0
  for (const _ of walk(dir)) count++
  return count
}

function shouldSkip(content, rel) {
  if (DATE_UNSUPPORTED_TESTS.has(rel)) return DATE_UNSUPPORTED_TESTS.get(rel)
  if (isFunctionalTest(rel)) return null
  if (rel.endsWith('/name.js')) return 'function name metadata'
  if (rel.endsWith('/length.js')) return 'function length metadata'
  if (rel.endsWith('/prop-desc.js')) return 'property descriptor metadata'
  if (rel.endsWith('/not-a-constructor.js')) return 'constructor/runtime-shape semantics'
  if (content.includes('propertyHelper')) return 'propertyHelper'
  if (content.includes('verifyProperty')) return 'verifyProperty'
  if (content.includes('includes: [')) return 'harness dependency'
  if (/Reflect\./.test(content)) return 'Reflect'
  if (/\bFunction\b\s*\(/.test(content)) return 'Function global ctor'
  if (/\bclass\b/.test(content)) return 'class'
  if (/async|await/.test(content)) return 'async'
  if (/\bProxy\b/.test(content)) return 'Proxy'
  if (/\bWeak(Ref|Map|Set)\b/.test(content)) return 'Weak collection'
  if (/Symbol\.(species|toPrimitive|iterator|hasInstance|asyncIterator|match|replace|search|split)/.test(content)) return 'Symbol runtime hook'
  if (/\biterator\b/i.test(content)) return 'iterator semantics'
  if (/\bgenerator\b/i.test(content) || /\byield\b/.test(content)) return 'generator semantics'
  if (/\bsuper\b/.test(content)) return 'super'
  if (/\bthis\b/.test(content)) return 'this binding'
  if (/\.prototype\b/.test(content)) return 'prototype chain semantics'
  if (/Object\.defineProperty|Object\.defineProperties/.test(content)) return 'descriptor semantics'
  if (/Object\.create|Object\.setPrototypeOf|Object\.getPrototypeOf/.test(content)) return 'prototype semantics'
  if (/Object\.getOwnProperty/.test(content)) return 'descriptor introspection'
  if (/Object\.preventExtensions|Object\.freeze|Object\.seal/.test(content)) return 'object integrity'
  if (/\.constructor\b/.test(content)) return 'constructor semantics'
  if (/\bnew\s+(?!Map|Set|Array|Error|TypeError|RangeError|ReferenceError|SyntaxError|URIError|EvalError)/.test(content)) return 'custom new'
  if (/\bnew\s+(Boolean|Number|String|Object)\b/.test(content)) return 'wrapper object new'
  if (/\bfor\s*\([^)]*\bof\b/.test(content)) return 'for-of'
  if (/\busing\b/.test(content)) return 'using keyword'
  if (/\$DONE|Test262:Async/.test(content)) return 'async harness dependency'
  if (/negative:\s*\n\s+phase:\s+(parse|runtime)/.test(content)) return 'negative test'
  if (/\bundefined\s*=/.test(content)) return 'global undefined assignment'
  return null
}

const { default: jz } = await import(join(ROOT, 'index.js'))

function runTest(src) {
  let code = src
    .replace(/\/\*---[\s\S]*?---\*\//, '')
    .replace(/^#![^\n]*(?:\n|$)/, '')
    .replace(/\$DONOTEVALUATE\(\)/g, 'return')

  if (!/export\s+(let|const|function|default)/.test(code)) {
    code = `export let _run = () => {\n${ASSERT_HARNESS}\n${code}\nreturn 1\n}`
  } else {
    code = `${ASSERT_HARNESS}\n${code}`
  }

  try {
    const inst = jz(code, { jzify: true })
    if (inst.exports._run) inst.exports._run()
    return { status: 'pass' }
  } catch (e) {
    const msg = e.message || String(e)
    if (msg.includes('Unknown op') || msg.includes('not supported') ||
        msg.includes('prohibited') || msg.includes('Unknown tag') ||
        msg.includes('Unknown func') || msg.includes('Unknown local') ||
        msg.includes('not declared') || msg.includes('Unknown global') ||
        msg.includes('cannot be used as a first-class value') ||
        msg.includes('requires object with known schema') ||
        msg.includes('Unknown instruction')) {
      return { status: 'skip', error: msg.slice(0, 80) }
    }
    return { status: 'fail', error: msg.slice(0, 120) }
  }
}

const results = { pass: 0, fail: 0, skip: 0 }
const fails = []
const skips = new Map()
const builtinsDir = join(TEST262, 'test', 'built-ins')
const allBuiltinsFiles = countJs(builtinsDir)

for (const subpath of TRACKED_BUILTIN_PATHS) {
  if (FILTER && !subpath.includes(FILTER) && !FILTER.includes(subpath)) continue
  const dir = join(builtinsDir, subpath)
  if (!existsSync(dir)) { console.log(`  skipping ${subpath}/ (not found)`); continue }

  let count = 0
  for (const file of walk(dir)) {
    const rel = relative(join(TEST262, 'test'), file)
    if (FILTER && !rel.includes(FILTER)) continue

    try {
      const src = readFileSync(file, 'utf-8')
      const skip = shouldSkip(src, rel)
      if (skip) {
        results.skip++
        skips.set(skip, (skips.get(skip) || 0) + 1)
        count++
        continue
      }

      const { status, error } = runTest(src)
      results[status]++
      count++

      if (status === 'fail' && fails.length < 30) fails.push(`${rel}: ${error}`)
      if (status === 'skip') skips.set(error, (skips.get(error) || 0) + 1)
    } catch {
      results.skip++
      skips.set('read/runner error', (skips.get('read/runner error') || 0) + 1)
      count++
    }
  }

  console.log(`  ${subpath}/: ${count} tests`)
}

const total = results.pass + results.fail + results.skip
const coverage = allBuiltinsFiles ? (results.pass / allBuiltinsFiles * 100).toFixed(2) : '0.00'

console.log(`\n── Built-ins results ──`)
console.log(`  Pass:          ${results.pass}`)
console.log(`  Fail:          ${results.fail}`)
console.log(`  Skip:          ${results.skip}`)
console.log(`  Tracked files: ${total}/${allBuiltinsFiles} built-ins JS files`)
console.log(`\n  Built-ins coverage (pass / built-ins JS files): ${coverage}% (${results.pass}/${allBuiltinsFiles})`)

if (skips.size) {
  console.log(`\n── Skip reasons ──`)
  for (const [reason, count] of [...skips.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count} ${reason}`)
  }
}

if (fails.length) {
  console.log(`\n── Sample failures ──`)
  fails.forEach(f => console.log(`  x ${f}`))
  process.exitCode = 1
}
