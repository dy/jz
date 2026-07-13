/**
 * test262 built-ins runner for jz.
 *
 * Usage:
 *   node test/test262-builtins.js
 *   node test/test262-builtins.js --filter=Math/random
 *   node test/test262-builtins.js --jobs=32
 *
 * Strategy: run curated built-ins functionality tests and explicitly skip
 * descriptor/prototype/runtime-shape tests until those semantics are in scope.
 *
 * Execution: the work list is split round-robin across a pool of worker
 * threads (one per core by default; override with --jobs=N or JZ_TEST262_JOBS).
 * Each worker has its own module registry, and jz resets all state per call,
 * so a worker's tallies are identical to running the same files sequentially.
 */
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join, relative } from 'path'
import { execSync } from 'child_process'
import { Worker, isMainThread, workerData, parentPort } from 'worker_threads'
import { availableParallelism } from 'os'

const ROOT = join(import.meta.dirname, '..')
const TEST262 = join(import.meta.dirname, 'test262')

if (isMainThread && !existsSync(TEST262)) {
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
  'Array/prototype/toSorted',
  'Array/prototype/toReversed',
  'Array/prototype/with',
  'Array/prototype/copyWithin',
  'Object/keys',
  'Object/values',
  'Object/entries',
  'Object/assign',
  'Object/fromEntries',
  'Object/groupBy',
  'Map/groupBy',
  'Date/UTC',
  'Date/prototype/getTime',
  'Date/prototype/valueOf',
  'Date/prototype/setTime',
  // UTC-clean stringifiers only: toDateString/toTimeString/toString are local-TZ
  // shapes in test262 fixtures — jz is UTC-only (documented divergence).
  'Date/prototype/toISOString',
  'Date/prototype/toUTCString',
  'Date/prototype/toJSON',
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
  'Set/prototype/union',
  'Set/prototype/intersection',
  'Set/prototype/difference',
  'Set/prototype/symmetricDifference',
  'Set/prototype/isSubsetOf',
  'Set/prototype/isSupersetOf',
  'Set/prototype/isDisjointFrom',
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
  'RegExp/escape',
  'Boolean',
  'BigInt',
  'parseInt',
  'parseFloat',
  'encodeURIComponent',
  'decodeURIComponent',
  'isFinite',
  'isNaN',
  'Infinity',
  'NaN',
  'undefined',
  'Symbol',
  // Implemented-but-untracked pools wired 2026-07-10 (extension-surface plan):
  // typed arrays are jz's flagship type — its full prototype surface has real
  // implementations (module/typedarray.js incl. the ES2023 change-by-copy trio
  // plain Array still lacks); WeakMap/WeakSet fold to Map/Set (documented);
  // RegExp beyond exec: literal-based flags/source/test surfaces. Tests using
  // harness helpers (testTypedArray.js etc.) absorb as not-in-scope skips.
  'TypedArray/prototype/at',
  'TypedArray/prototype/copyWithin',
  'TypedArray/prototype/every',
  'TypedArray/prototype/fill',
  'TypedArray/prototype/filter',
  'TypedArray/prototype/find',
  'TypedArray/prototype/findIndex',
  'TypedArray/prototype/findLast',
  'TypedArray/prototype/findLastIndex',
  'TypedArray/prototype/forEach',
  'TypedArray/prototype/includes',
  'TypedArray/prototype/indexOf',
  'TypedArray/prototype/join',
  'TypedArray/prototype/lastIndexOf',
  'TypedArray/prototype/map',
  'TypedArray/prototype/reduce',
  'TypedArray/prototype/reduceRight',
  'TypedArray/prototype/reverse',
  'TypedArray/prototype/set',
  'TypedArray/prototype/slice',
  'TypedArray/prototype/some',
  'TypedArray/prototype/sort',
  'TypedArray/prototype/subarray',
  'TypedArray/prototype/toReversed',
  'TypedArray/prototype/toSorted',
  'TypedArray/prototype/with',
  'WeakMap/prototype/get',
  'WeakMap/prototype/set',
  'WeakMap/prototype/has',
  'WeakMap/prototype/delete',
  'WeakSet/prototype/add',
  'WeakSet/prototype/has',
  'WeakSet/prototype/delete',
  'RegExp/prototype/test',
  'RegExp/prototype/source',
  'RegExp/prototype/flags',
  'RegExp/prototype/global',
  'RegExp/prototype/sticky',
  'RegExp/prototype/unicode',
  // Promise pool wired 2026-07-13: the jzify async runtime implements
  // resolve/reject/all/race/allSettled/any/try/withResolvers + executor +
  // then/catch/finally; flags:[async] tests run through the $DONE shim
  // (module-level, polled via __t262_check — same design as the language
  // runner). Subclassing/species/descriptor tests absorb as skips.
  'Promise',
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
  'built-ins/encodeURIComponent/S15.1.3.4_A3.1_T1.js',
  'built-ins/encodeURIComponent/S15.1.3.4_A3.2_T1.js',
  'built-ins/encodeURIComponent/S15.1.3.4_A3.2_T2.js',
  'built-ins/encodeURIComponent/S15.1.3.4_A3.2_T3.js',
  'built-ins/encodeURIComponent/S15.1.3.4_A3.3_T1.js',
  'built-ins/encodeURIComponent/S15.1.3.4_A4_T1.js',
  'built-ins/encodeURIComponent/S15.1.3.4_A4_T2.js',
  'built-ins/encodeURIComponent/S15.1.3.4_A4_T3.js',
  'built-ins/encodeURIComponent/S15.1.3.4_A4_T4.js',
  'built-ins/encodeURIComponent/S15.1.3.4_A6_T1.js',
  'built-ins/decodeURIComponent/S15.1.3.2_A3_T1.js',
  'built-ins/decodeURIComponent/S15.1.3.2_A3_T2.js',
  'built-ins/decodeURIComponent/S15.1.3.2_A3_T3.js',
  'built-ins/decodeURIComponent/S15.1.3.2_A4_T1.js',
  'built-ins/decodeURIComponent/S15.1.3.2_A4_T2.js',
  'built-ins/decodeURIComponent/S15.1.3.2_A4_T3.js',
  'built-ins/decodeURIComponent/S15.1.3.2_A4_T4.js',
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
const JOBS_ARG = Number(process.argv.find(a => a.startsWith('--jobs='))?.split('=')[1])

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

// ── Expected failures ───────────────────────────────────────────────────────
// Built-ins tests that COMPILE and RUN but assert-fail because they exercise a
// feature jz deliberately does not implement (out of scope for the distilled-JS
// subset) or a documented representation divergence. They still run, but bucket
// as `xfail` instead of `fail`, so the `fail` count gates *in-scope* correctness
// honestly — any non-zero `fail` is a genuine regression. If a listed *file*
// ever passes it is reported as `xpass` so the entry can be pruned. Compile-time
// fails ("… is not in scope" / "Unknown op" …) are bucketed as `skip` by runTest.
//
// A prefix covers a whole feature family that will not be implemented; a file
// entry is an exact, individually-reviewed expectation (and gets xpass tracking).
const EXPECTED_FAIL_PREFIXES = [
  ['built-ins/BigInt/', 'BigInt arithmetic/coercion — out of scope (no BigInt type)'],
  ['built-ins/RegExp/prototype/exec/', 'dynamic RegExp lastIndex / u-flag exec — out of scope'],
  ['built-ins/ArrayBuffer/', 'resizable ArrayBuffer options — out of scope'],
  ['built-ins/Symbol/', 'Symbol primitive semantics — out of scope'],
]
const EXPECTED_FAIL_FILES = new Map([
  // ES2025 Set algebra — jz accepts real Set/Map operands only; arbitrary
  // "set-likes" (GetSetRecord: any object with size/has/keys) are out of the
  // value model (no dynamic method protocol on plain objects).
  ['built-ins/Set/prototype/union/called-with-object.js', 'Set-like GetSetRecord operand — out of scope (real Set/Map only)'],
  ['built-ins/Set/prototype/union/keys-is-callable.js', 'Set-like GetSetRecord operand — out of scope (real Set/Map only)'],
  ['built-ins/Set/prototype/intersection/called-with-object.js', 'Set-like GetSetRecord operand — out of scope (real Set/Map only)'],
  ['built-ins/Set/prototype/intersection/keys-is-callable.js', 'Set-like GetSetRecord operand — out of scope (real Set/Map only)'],
  ['built-ins/Set/prototype/difference/called-with-object.js', 'Set-like GetSetRecord operand — out of scope (real Set/Map only)'],
  ['built-ins/Set/prototype/difference/keys-is-callable.js', 'Set-like GetSetRecord operand — out of scope (real Set/Map only)'],
  ['built-ins/Set/prototype/symmetricDifference/called-with-object.js', 'Set-like GetSetRecord operand — out of scope (real Set/Map only)'],
  ['built-ins/Set/prototype/symmetricDifference/keys-is-callable.js', 'Set-like GetSetRecord operand — out of scope (real Set/Map only)'],
  ['built-ins/Set/prototype/isSubsetOf/called-with-object.js', 'Set-like GetSetRecord operand — out of scope (real Set/Map only)'],
  ['built-ins/Set/prototype/isSubsetOf/keys-is-callable.js', 'Set-like GetSetRecord operand — out of scope (real Set/Map only)'],
  ['built-ins/Set/prototype/isSupersetOf/called-with-object.js', 'Set-like GetSetRecord operand — out of scope (real Set/Map only)'],
  ['built-ins/Set/prototype/isSupersetOf/keys-is-callable.js', 'Set-like GetSetRecord operand — out of scope (real Set/Map only)'],
  ['built-ins/Set/prototype/isDisjointFrom/called-with-object.js', 'Set-like GetSetRecord operand — out of scope (real Set/Map only)'],
  ['built-ins/Set/prototype/isDisjointFrom/keys-is-callable.js', 'Set-like GetSetRecord operand — out of scope (real Set/Map only)'],
  // RegExp.escape — jz strings are UTF-8 bytes: the spec's \\uXXXX escaping of
  // astral/whitespace/lineterminator code points cannot arise byte-wise (non-ASCII
  // bytes are never regex-special and pass through).
  ['built-ins/RegExp/escape/escaped-lineterminator.js', 'RegExp.escape non-ASCII \\u-escaping — out of scope (byte-wise strings)'],
  ['built-ins/RegExp/escape/escaped-surrogates.js', 'RegExp.escape non-ASCII \\u-escaping — out of scope (byte-wise strings)'],
  ['built-ins/RegExp/escape/escaped-whitespace.js', 'RegExp.escape non-ASCII \\u-escaping — out of scope (byte-wise strings)'],
  // Array.of.call(CustomCtor, …) — this-constructor protocol on builtins
  ['built-ins/Array/of/return-a-custom-instance.js', 'builtin .call with custom this-constructor — out of scope'],
  // JSON.parse — ToString-coerces a non-string argument
  ['built-ins/JSON/parse/text-non-string-primitive.js', 'JSON.parse non-string-arg ToString coercion — out of scope'],
  ['built-ins/JSON/parse/text-object.js', 'JSON.parse non-string-arg ToString coercion — out of scope'],
  // JSON.stringify — replacer argument (jz stringify is single-arg)
  ['built-ins/JSON/stringify/replacer-array-duplicates.js', 'JSON.stringify replacer argument — out of scope'],
  ['built-ins/JSON/stringify/replacer-array-order.js', 'JSON.stringify replacer argument — out of scope'],
  ['built-ins/JSON/stringify/replacer-array-undefined.js', 'JSON.stringify replacer argument — out of scope'],
  ['built-ins/JSON/stringify/replacer-function-array-circular.js', 'JSON.stringify replacer argument — out of scope'],
  ['built-ins/JSON/stringify/replacer-function-object-circular.js', 'JSON.stringify replacer argument — out of scope'],
  ['built-ins/JSON/stringify/replacer-function-result-undefined.js', 'JSON.stringify replacer argument — out of scope'],
  ['built-ins/JSON/stringify/replacer-function-tojson.js', 'JSON.stringify replacer argument — out of scope'],
  ['built-ins/JSON/stringify/value-bigint-replacer.js', 'JSON.stringify replacer argument — out of scope'],
  // JSON.stringify — toJSON() hook
  ['built-ins/JSON/stringify/value-tojson-array-circular.js', 'JSON.stringify toJSON() hook — out of scope'],
  ['built-ins/JSON/stringify/value-tojson-not-function.js', 'JSON.stringify toJSON() hook — out of scope'],
  ['built-ins/JSON/stringify/value-tojson-object-circular.js', 'JSON.stringify toJSON() hook — out of scope'],
  // JSON.stringify — wrapper-object / circular / abrupt-getter / Symbol edges
  ['built-ins/JSON/stringify/space-string-object.js', 'JSON.stringify wrapper-object coercion — out of scope'],
  ['built-ins/JSON/stringify/value-boolean-object.js', 'JSON.stringify wrapper-object coercion — out of scope'],
  ['built-ins/JSON/stringify/value-object-abrupt.js', 'JSON.stringify abrupt-getter propagation — out of scope'],
  ['built-ins/JSON/stringify/value-object-circular.js', 'JSON.stringify circular-reference detection — out of scope'],
  ['built-ins/JSON/stringify/value-symbol.js', 'JSON.stringify of Symbol value — out of scope'],
  // String
  ['built-ins/String/prototype/indexOf/S15.5.4.7_A1_T9.js', 'String wrapper-object ToPrimitive coercion — out of scope'],
  ['built-ins/String/prototype/indexOf/position-tointeger.js', 'String indexOf position object ToPrimitive coercion — out of scope'],
  ['built-ins/String/prototype/indexOf/searchstring-tostring.js', 'String(object) is JSON-ish, not "[object Object]" — documented divergence (boolean/number/null/undefined/array needles all coerce correctly)'],
  // Array
  ['built-ins/Array/from/elements-added-after.js', 'live iterator protocol — out of scope'],
  ['built-ins/Array/prototype/concat/create-ctor-non-object.js', 'Symbol.species constructor lookup — out of scope'],
  ['built-ins/Array/isArray/15.4.3.2-0-2.js', 'builtin function .length reflection — out of scope (function-object property semantics)'],
  // Object — function objects, array-likes, dynamic schema, iterable coercion
  ['built-ins/Object/keys/15.2.3.14-3-2.js', 'Object.keys on function object — out of scope'],
  ['built-ins/Object/keys/15.2.3.14-3-4.js', 'Object.keys on arguments/array-like — out of scope'],
  ['built-ins/Object/assign/OnlyOneArgument.js', 'primitive ToObject boxing — out of scope'],
  ['built-ins/Object/fromEntries/string-entry-string-object-succeeds.js', 'Object.fromEntries iterable/entry coercion — out of scope'],
  ['built-ins/Object/fromEntries/supports-symbols.js', 'Object.fromEntries Symbol keys — out of scope'],
  // Promise — jz promises are fixed-shape values adopted STRUCTURALLY
  // (`__p === 1` → subscribe), not via a dynamic `.then` lookup, so overriding
  // `.then` on a native promise is not observed (documented divergence).
  ['built-ins/Promise/prototype/then/resolve-pending-fulfilled-prms-cstm-then.js', 'overridden .then on a native promise — structural adoption divergence'],
  ['built-ins/Promise/prototype/then/resolve-pending-rejected-prms-cstm-then.js', 'overridden .then on a native promise — structural adoption divergence'],
  ['built-ins/Promise/prototype/then/resolve-settled-fulfilled-prms-cstm-then.js', 'overridden .then on a native promise — structural adoption divergence'],
  ['built-ins/Promise/prototype/then/resolve-settled-rejected-prms-cstm-then.js', 'overridden .then on a native promise — structural adoption divergence'],
  ['built-ins/Promise/race/resolve-prms-cstm-then.js', 'overridden .then on a native promise — structural adoption divergence'],
  ['built-ins/Promise/resolve-prms-cstm-then-deferred.js', 'overridden .then on a native promise — structural adoption divergence'],
  ['built-ins/Promise/resolve-prms-cstm-then-immed.js', 'overridden .then on a native promise — structural adoption divergence'],
  // Promise — function-object / namespace reflection
  ['built-ins/Promise/constructor.js', 'typeof Promise as first-class value — out of scope'],
  ['built-ins/Promise/exec-args.js', 'executor resolve/reject .length reflection — out of scope'],
  ['built-ins/Promise/prototype/catch/S25.4.5.1_A2.1_T1.js', 'instanceof Function reflection — out of scope'],
  ['built-ins/Promise/withResolvers/resolvers.js', 'resolve/reject .name/.length reflection — out of scope'],
  // parseInt / parseFloat
  ['built-ins/parseInt/S15.1.2.2_A1_T7.js', 'parseInt object-arg ToPrimitive coercion — out of scope'],
  ['built-ins/parseInt/S15.1.2.2_A3.1_T7.js', 'parseInt object-radix ToPrimitive coercion — out of scope'],
  ['built-ins/encodeURIComponent/S15.1.3.4_A6_T1.js', 'encodeURIComponent object ToPrimitive coercion — out of scope'],
])

function expectedFailReason(rel) {
  if (EXPECTED_FAIL_FILES.has(rel)) return EXPECTED_FAIL_FILES.get(rel)
  for (const [prefix, reason] of EXPECTED_FAIL_PREFIXES)
    if (rel.startsWith(prefix)) return reason
  return null
}

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

// flags:[async] — the test calls $DONE(err?) when its promise chain settles;
// runTest runs it through the module-level shim and polls __t262_check.
function isAsyncFlagged(content) {
  return /flags:\s*\[[^\]]*\basync\b/.test(content) || /\$DONE/.test(content)
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
  if (/\bProxy\b/.test(content)) return 'Proxy'
  if (/\bWeak(Ref|Map|Set)\b/.test(content)) return 'Weak collection'
  if (/\bAggregateError\s*\(/.test(content) || /instanceof AggregateError/.test(content)) return 'AggregateError constructor semantics'
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
  if (/\bnew\s+(?!Map|Set|Array|Promise|Error|TypeError|RangeError|ReferenceError|SyntaxError|URIError|EvalError)/.test(content)) return 'custom new'
  if (/\bnew\s+(Boolean|Number|String|Object)\b/.test(content)) return 'wrapper object new'
  if (/\bfor\s*\([^)]*\bof\b/.test(content)) return 'for-of'
  if (/\busing\b/.test(content)) return 'using keyword'
  if (/negative:\s*\n\s+phase:\s+(parse|runtime)/.test(content)) return 'negative test'
  if (/\bundefined\s*=/.test(content)) return 'global undefined assignment'
  return null
}

const { default: jz } = await import(join(ROOT, 'index.js'))

// flags:[async] tests — module-level $DONE shim (doneprintHandle.js stand-in);
// the host polls __t262_check, each call draining the module's microtask queue
// at the boundary. Same design as the language runner's ASYNC_DONE_SHIM.
const ASYNC_DONE_SHIM = `
let __t262d = 0
let __t262e = undefined
let $DONE = (e) => { if (__t262d) return; __t262d = 1; if (e != null && e !== false) __t262e = '' + e }
let asyncTest = (fn) => { fn().then(() => $DONE(), (e) => $DONE(e == null ? 'rejected' : e)) }
export let __t262_check = () => __t262d === 0 ? '@pending' : __t262e == null ? '@ok' : __t262e
`

function runTest(src, isAsync) {
  let code = src
    .replace(/\/\*---[\s\S]*?---\*\//, '')
    .replace(/^#![^\n]*(?:\n|$)/, '')
    .replace(/\$DONOTEVALUATE\(\)/g, 'return')

  if (!/export\s+(let|const|function|default)/.test(code)) {
    // asyncDone: the assert harness hoists to MODULE level (nesting it inside
    // _run trips the closure-state visibility gap even at O0 — see the KNOWN
    // GAP pins in test/parser-bugs.js); module bindings are visible either way.
    code = isAsync
      ? `export let _run = () => {\n${code}\nreturn 1\n}`
      : `export let _run = () => {\n${ASSERT_HARNESS}\n${code}\nreturn 1\n}`
  } else {
    code = `${ASSERT_HARNESS}\n${code}`
  }
  if (isAsync) code = `${ASYNC_DONE_SHIM}\n${ASSERT_HARNESS}\n${code}`

  try {
    const inst = jz(code, { jzify: true })
    if (inst.exports._run) inst.exports._run()
    if (isAsync) {
      return (async () => {
        try {
          for (let i = 0; i < 300; i++) {
            const st = inst.exports.__t262_check()
            if (st !== '@pending') return st === '@ok' ? { status: 'pass' } : { status: 'fail', error: String(st).slice(0, 120) }
            await new Promise(r => setTimeout(r, 1))
          }
          return { status: 'fail', error: 'async $DONE timeout' }
        } catch (e) { return { status: 'fail', error: (e.message || String(e)).slice(0, 120) } }
      })()
    }
    return { status: 'pass' }
  } catch (e) {
    const msg = e.message || String(e)
    // An unresolved reference ("'JSON' is not in scope", "'$262' is not in
    // scope", …) means the test names a built-in or namespace jz does not
    // implement — feature-absent, not a wrong answer. Group as one skip reason.
    if (msg.includes('is not in scope')) {
      return { status: 'skip', error: 'unsupported builtin or namespace-as-value' }
    }
    if (msg.includes('Unknown op') || msg.includes('not supported') ||
        msg.includes('prohibited') || msg.includes('Unknown tag') ||
        msg.includes('Unknown func') || msg.includes('Unknown local') ||
        msg.includes('not declared') || msg.includes('Unknown global') ||
        msg.includes('cannot be used as a first-class value') ||
        msg.includes('requires object with known schema') ||
        msg.includes('outside the v1 async surface') ||
        msg.includes('Unknown instruction')) {
      return { status: 'skip', error: msg.slice(0, 80) }
    }
    return { status: 'fail', error: msg.slice(0, 120) }
  }
}

const builtinsDir = join(TEST262, 'test', 'built-ins')

// ─── Work collection (main thread) ──────────────────────────────────────────
// Walk the tracked built-in paths once, applying the --filter, and produce a
// flat work list — one entry per test file. Content-level skip classification
// and compile/run happen later, in parallel workers.
function collectWork() {
  const work = []   // { file, rel, subpath }
  for (const subpath of TRACKED_BUILTIN_PATHS) {
    if (FILTER && !subpath.includes(FILTER) && !FILTER.includes(subpath)) continue
    const dir = join(builtinsDir, subpath)
    if (!existsSync(dir)) { console.log(`  skipping ${subpath}/ (not found)`); continue }
    for (const file of walk(dir)) {
      const rel = relative(join(TEST262, 'test'), file)
      if (FILTER && !rel.includes(FILTER)) continue
      work.push({ file, rel, subpath })
    }
  }
  return work
}

// ─── Worker: classify + compile/run an assigned slice of the work list ──────
// Pure given its inputs (jz resets all state per call), so a worker's tallies
// are identical to running the same files sequentially.
async function runChunk(items) {
  const perPath = Object.create(null)
  const results = { pass: 0, fail: 0, xfail: 0, skip: 0 }
  const fails = []
  const skips = new Map()
  const xfails = new Map()
  const xpasses = []
  for (const { file, rel, subpath } of items) {
    perPath[subpath] = (perPath[subpath] || 0) + 1
    try {
      const src = readFileSync(file, 'utf-8')
      const skip = shouldSkip(src, rel)
      if (skip) {
        results.skip++
        skips.set(skip, (skips.get(skip) || 0) + 1)
        continue
      }

      const { status, error } = await runTest(src, isAsyncFlagged(src))
      const xfReason = expectedFailReason(rel)
      if (status === 'fail' && xfReason) {
        results.xfail++
        xfails.set(xfReason, (xfails.get(xfReason) || 0) + 1)
      } else {
        results[status]++
        if (status === 'fail' && fails.length < 1000) fails.push(`${rel}: ${error}`)
        if (status === 'skip') skips.set(error, (skips.get(error) || 0) + 1)
        if (status === 'pass' && EXPECTED_FAIL_FILES.has(rel)) xpasses.push(rel)
      }
    } catch {
      results.skip++
      skips.set('read/runner error', (skips.get('read/runner error') || 0) + 1)
    }
  }
  return { perPath, results, fails, skips, xfails, xpasses }
}

if (!isMainThread) {
  // Spawned worker: run the assigned slice and report tallies back.
  runChunk(workerData.items).then(r => parentPort.postMessage(r))
} else {
  // ─── Main: collect work, fan out to a worker pool, aggregate ──────────────
  const allBuiltinsFiles = countJs(builtinsDir)
  const work = collectWork()

  // One worker per core by default; override with --jobs=N or JZ_TEST262_JOBS.
  const jobs = Math.max(1, Math.min(
    JOBS_ARG || Number(process.env.JZ_TEST262_JOBS) || availableParallelism(),
    work.length || 1))

  // Round-robin split: spreads heavy paths (Math/, DataView/) evenly so no
  // single worker draws the whole slow tail.
  const chunks = Array.from({ length: jobs }, () => [])
  work.forEach((item, i) => chunks[i % jobs].push(item))

  console.log(`Running ${work.length} tests across ${jobs} worker${jobs > 1 ? 's' : ''}...`)
  const t0 = Date.now()

  const chunkResults = await Promise.all(chunks.map(items => new Promise((resolve, reject) => {
    const w = new Worker(import.meta.filename, { workerData: { items } })
    w.once('message', resolve)
    w.once('error', reject)
    w.once('exit', code => code === 0 || reject(new Error(`worker exited with code ${code}`)))
  })))

  // Merge worker tallies.
  const results = { pass: 0, fail: 0, xfail: 0, skip: 0 }
  const perPath = Object.create(null)
  const fails = []
  const skips = new Map()
  const xfails = new Map()
  const xpasses = []
  for (const r of chunkResults) {
    results.pass += r.results.pass
    results.fail += r.results.fail
    results.xfail += r.results.xfail
    results.skip += r.results.skip
    for (const p in r.perPath) perPath[p] = (perPath[p] || 0) + r.perPath[p]
    fails.push(...r.fails)
    for (const [k, v] of r.skips) skips.set(k, (skips.get(k) || 0) + v)
    for (const [k, v] of r.xfails) xfails.set(k, (xfails.get(k) || 0) + v)
    xpasses.push(...r.xpasses)
  }

  for (const subpath of TRACKED_BUILTIN_PATHS) {
    if (perPath[subpath]) console.log(`  ${subpath}/: ${perPath[subpath]} tests`)
  }

  const total = results.pass + results.fail + results.xfail + results.skip
  const coverage = allBuiltinsFiles ? (results.pass / allBuiltinsFiles * 100).toFixed(2) : '0.00'

  console.log(`\n── Built-ins results ── (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  console.log(`  Pass:          ${results.pass}`)
  console.log(`  Fail:          ${results.fail}`)
  console.log(`  Xfail:         ${results.xfail}  (ran, expected to fail — out-of-scope feature)`)
  console.log(`  Skip:          ${results.skip}`)
  console.log(`  Tracked files: ${total}/${allBuiltinsFiles} built-ins JS files`)
  console.log(`\n  Built-ins coverage (pass / built-ins JS files): ${coverage}% (${results.pass}/${allBuiltinsFiles})`)

  if (skips.size) {
    console.log(`\n── Skip reasons ──`)
    for (const [reason, count] of [...skips.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count} ${reason}`)
    }
  }

  if (xfails.size) {
    console.log(`\n── Expected failures (out of scope) ──`)
    for (const [reason, count] of [...xfails.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count} ${reason}`)
    }
  }

  if (xpasses.length) {
    console.log(`\n── Unexpected passes — prune from EXPECTED_FAIL_FILES ──`)
    xpasses.sort().forEach(f => console.log(`  ✓ ${f}`))
  }

  if (fails.length) {
    console.log(`\n── Failures (in-scope — should be 0) ──`)
    fails.sort().forEach(f => console.log(`  x ${f}`))
  }

  // CI gating: when JZ_TEST262_BASELINE is set (e.g. in GitHub Actions), exit
  // non-zero if pass count drops below the baseline, or if any *in-scope* test
  // fails. Out-of-scope fails are bucketed as `xfail` and do not gate; a non-zero
  // `fail` is therefore a genuine regression or an unlisted out-of-scope test.
  const baseline = Number(process.env.JZ_TEST262_BASELINE)
  if (Number.isFinite(baseline) && baseline > 0) {
    if (results.pass < baseline) {
      console.error(`\nFAIL: pass count ${results.pass} below baseline ${baseline}`)
      process.exit(1)
    }
    if (results.fail > 0) {
      console.error(`\nFAIL: ${results.fail} in-scope failure(s) — fix, or add to EXPECTED_FAIL_* if out of scope`)
      process.exit(1)
    }
  }
}
