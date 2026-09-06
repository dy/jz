# BigInt division review — closed 2026-09-06

`x / 0n` and `x % 0n` throw a RangeError the program can catch; a wasm trap
is neither catchable nor kept by an optimizer when the result is unused.
`bigIntDivIR` (src/compile/emit/bigint.js) captures both operands, throws for
zero and negates for -1 (INT64_MIN included); binary and compound callers
share it. The error is a real branded RangeError through the ordinary
constructor (`throwErrorIR`, which `throwTypeErrorIR` now also uses, -36 lines):
a reserved numeric code (214) was tried first and collided with a user's
`throw 214`, since interop's decodeThrown treats a known code as a runtime
error. Prepare registers RangeError for any `/`, `%` in a program that has
BigInts, so a catch or instanceof compiled before the throwing function folds
right; `canThrow` keeps a call-free try/catch live for the same programs. A
constant nonzero divisor (watr's `fold` on the emitted operand, `-1n` lowers
through subtraction) demands no error object or throw runtime.

Evidence (this checkout, watr `5ff0037`):

- test/bigint-division.js: 24 tests, O0-O3 against the JS oracle: zero errors,
  operand order and recovery under `typeof`, comparison and comma consumers;
  failed compound writes keep the RHS state; signed-i64 boundaries in local
  storage; call-free catch/finally; the primitive-throw collision (`throw 214`
  beside `6n / 0n`, with rethrow and finally); census before consumers and a
  shadowed `RangeError`; constant divisors export neither memory nor a tag;
  Number-only try/catch costs no bytes; joint Number/BigInt zero.
- Bytes (`export function f(a,b){…}`, O0/O1/O2/O3): `return 3n` 55/55/36/36;
  `6n/2n` 58/58/36/36 and `6n/-1n` 58/58/36/36 (unchanged); `6n/0n`
  692/681/568/728 (58/58/39/39 before: the RangeError object, its strings
  and the throw runtime); `BigInt(a)/BigInt(b)` 1725/1670/1499/1671
  (1145/1101/997/1001 before). Eight Number-only `/` and `%` try/catch
  binaries and the 156-row sequence-cost corpus are byte-identical to the
  pre-division sources (`division-cost.mjs`: 324/324 value matches, control
  rows 154/156 identical, `control-18` +1 B at O2/O3).
- Native `npm test`: 4171 pass / 53 fail / 1 skip, 51208 assertions; the 53
  failing names are exactly the set before the branded change
  (`native-final.log`), none added. opt0, opt3 and WASI over `bigint-division
  sequence-values unsigned data errors statements`: 689/737, 689/737, 687/735,
  the 48 failing names all within that native set.
- Fresh private `npm run test:self`: 20/26 before and after; the six hosted
  failures are the kernel's, repaired separately (the summary's numeric
  demand beside a BigInt operand, the nullable boolean's identity, the BigInt
  box test on a raw Number).

The pi session's owned scratch (`/tmp/jz-div-review-zzF4wK`: baseline loader,
`number-try-*`, `control-*`, `division-*`, the native logs) can be removed once
this commit lands; nothing else references it.
