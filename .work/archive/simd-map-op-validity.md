# SIMD `.typed:map` op-validity matrix (2026-08-28)

Base: a76a3d23 (tip of the just-landed fix/simd-map-const-toint32 work — float×bitwise
decline + bitwise/shift ToInt32-normalization + integer×fractional-arithmetic decline).
This slice closes the SAME class of bug — an (op, elemType) pair `genSimdMap` lowers to a
WASM instruction that either doesn't exist (compile-time crash) or computes a different
value than ECMAScript's `TypedArray.prototype.map` (silent wrong answer) — by replacing
every per-case decline with one table, `SIMD_MAP_VALID_KINDS`
(`module/typedarray/simd-map.js`).

## Method

`analyzeSimd` (module/typedarray/simd-map.js) recognizes exactly 15 op shapes from a
`.map()` callback body: `mul/add/sub/div` (binary `x OP c`), `and/or/xor/shl/shr/shru`
(bitwise `x OP c`), `neg` (`-x`), and `abs/sqrt/ceil/floor` (`Math.<method>(x)` — the only
four Math methods in its allowlist; `Math.trunc/round/min/max` etc. are simply never
pattern-matched, so they always fall through to the generic per-element lowering and are
outside this table's scope by construction — confirmed empirically below as an unaffected
control).

Each of the 15 ops was probed against `jz()` at `optimize` 0/2/3, crossed with all four
element kinds `genSimdMap` ever receives (`elemType` 4/5/6/7 = Int32Array/Uint32Array/
Float32Array/Float64Array — 0-3, i8/u8/i16/u16, never reach `genSimdMap`'s SIMD dispatch at
all: no i8x16/i16x8 lane path exists for `.typed:map`, unchanged by this work). For the
binary/bitwise families, representative constants were used per the existing pins'
convention (an ordinary integer constant; div was additionally probed with a non-exact
divisor, a power-of-two divisor, `-1` (INT32_MIN/-1 overflow-trap risk), `0` (div-by-zero
trap risk), and a fractional constant). Probe script (scratchpad, not committed):

```js
const wasm = compile(src, { optimize })
const validates = WebAssembly.validate(wasm)          // catches crafted-but-invalid modules
const got = jz(src, { optimize }).exports.main()       // catches compile-time throws too
const want = new globalThis[Kind](vals).map(hostFn)    // host TypedArray.prototype.map — the oracle
// compare got[i] vs want[i] element-by-element (not summed — a compensating-error pair can't hide)
```

## Matrix — BEFORE this fix (base a76a3d23)

`simdish` = the emitted WAT contains a v128/i32x4/f32x4/f64x2 instruction (fast path fired).
Bitwise rows were already correct at this base (prior two commits); included for completeness.

| op | Int32Array (i32) | Uint32Array (u32) | Float32Array (f32) | Float64Array (f64) |
|---|---|---|---|---|
| mul | OK, simdish | OK, simdish | OK, simdish | OK, simdish |
| add | OK, simdish | OK, simdish | OK, simdish | OK, simdish |
| sub | OK, simdish | OK, simdish | OK, simdish | OK, simdish |
| div (int const) | **COMPILE THROWS** `Unknown instruction i32x4.div` | **COMPILE THROWS** `Unknown instruction i32x4.div` | OK, simdish | OK, simdish |
| div (fractional const) | OK, declines (pre-existing gate) | OK, declines (pre-existing gate) | OK, simdish | OK, simdish |
| and/or/xor/shl/shr/shru | OK, simdish | OK, simdish | OK, declines (pre-existing gate) | OK, declines (pre-existing gate) |
| neg | OK, simdish | OK, simdish | OK, simdish | OK, simdish |
| abs | OK, simdish | **WRONG VALUE** — simdish, e.g. elem 4294967295 → 1 (signed lane-abs on unsigned data) | OK, simdish | OK, simdish |
| sqrt | **COMPILE THROWS** `Unknown instruction i32x4.sqrt` | **COMPILE THROWS** `Unknown instruction i32x4.sqrt` | OK, simdish | OK, simdish |
| ceil | **COMPILE THROWS** `Unknown instruction i32x4.ceil` | **COMPILE THROWS** `Unknown instruction i32x4.ceil` | OK, simdish | OK, simdish |
| floor | **COMPILE THROWS** `Unknown instruction i32x4.floor` | **COMPILE THROWS** `Unknown instruction i32x4.floor` | OK, simdish | OK, simdish |
| trunc/round/min/max/… | never pattern-matched by `analyzeSimd` — always declines, unaffected | — | — | — |

Four bug rows, three flavors:

1. **`div` on Int32Array/Uint32Array, any non-fractional constant** (`x / 3`, `x / 4`,
   `x / -1`, `x / 0`) — compile-time crash, `Unknown instruction i32x4.div`. WASM SIMD
   defines no integer-lane division at all (only `f32x4.div`/`f64x2.div` exist), and the
   scalar tail's `(i32.div …)` isn't even a real instruction mnemonic (would need
   `i32.div_s`/`i32.div_u`, and even those trap on `/0` and on `INT32_MIN/-1` where
   ECMAScript's float-divide-then-ToInt32 just returns `0` or wraps). The pre-existing
   fractional-constant gate didn't catch this because `3`, `4`, `-1`, `0` are all integers —
   it was solving a different problem (rounding error), not "this op has no integer lane
   form at any constant."
2. **`sqrt`/`ceil`/`floor` on Int32Array/Uint32Array** — compile-time crash,
   `Unknown instruction i32x4.sqrt`/`i32x4.ceil`/`i32x4.floor`. These are float-only WASM
   instructions (both the v128 lane form and the scalar `f32`/`f64` form); no integer
   equivalent exists at any width. ECMAScript computes `Math.sqrt`/`ceil`/`floor` in double
   and applies `ToInt32`/`ToUint32` only once, on store — ops the fast path's codegen never
   attempts (it just paints `i32` as the type prefix and gets an instruction name that
   doesn't exist).
3. **`abs` on Uint32Array** — compiles and validates, but computes the **wrong value** (not
   a crash). The lane op (`i32x4.abs` / scalar `select + negate-if-negative`) implements
   *signed* absolute value: negate when the sign bit is set. That's correct for Int32Array.
   For Uint32Array the stored bits are identical, but the ECMAScript *value* is already
   non-negative by construction (`ToUint32` range) — `Math.abs` on it is the identity, not
   "negate when the top bit is set." Concretely: element `4294967295` (`0xFFFFFFFF`, i.e.
   `-1` under a signed reading) round-trips through the signed-abs lane op as `1`, but
   `Math.abs(4294967295) === 4294967295`. This is a genuinely new finding — not previously
   disclosed — surfaced by probing every (op, elemType) pair against the host oracle rather
   than trusting the two already-landed gates to be the whole story.

Everything else in the matrix (mul/add/sub with an integer constant on any kind, div/abs/
sqrt/ceil/floor/neg on float kinds, neg on every kind, bitwise on integer kinds, bitwise
declining on float kinds) was already correct at this base and stays correct — confirmed by
rerunning the exact same probe after the fix (see below) and by the full pre-existing
`test/simd.js` suite (231/231, 6577 assertions, unchanged).

## Matrix — AFTER this fix

Same probe, same base, `module/typedarray/simd-map.js` patched. All 60 (op × elemType)
cells plus every div/abs/sqrt/ceil/floor/bitwise variant above: **0 compile throws, 0
WebAssembly.validate failures, 0 value mismatches**, across O0/O2/O3. The three bug rows
now read:

| op | Int32Array | Uint32Array | Float32Array | Float64Array |
|---|---|---|---|---|
| div (any constant) | OK, **declines** (generic lowering) | OK, **declines** | OK, simdish (unchanged) | OK, simdish (unchanged) |
| sqrt / ceil / floor | OK, **declines** | OK, **declines** | OK, simdish (unchanged) | OK, simdish (unchanged) |
| abs | OK, simdish (unchanged) | OK, **declines** | OK, simdish (unchanged) | OK, simdish (unchanged) |

Every previously-passing cell (mul/add/sub, neg, bitwise, div/sqrt/ceil/floor/abs on float)
is byte-for-byte unaffected: still takes the SIMD path, still matches the host oracle.

## The table (implementation)

`module/typedarray/simd-map.js`, `SIMD_MAP_VALID_KINDS`: one object keyed by op name, each
value a `Set` of the elemTypes (4/5/6/7) whose lane form computes the exact ECMAScript value
for every input. `genSimdMap` consults it exactly once:

```js
if (!SIMD_MAP_VALID_KINDS[op]?.has(elemType)) return null
```

replacing both previously-landed gates (float×bitwise decline, integer×fractional-constant
decline) as rows/notes in the same table, plus the two new op-validity holes (div, sqrt/
ceil/floor unconditionally float-only; abs float-or-signed-int only). One value-level check
remains alongside it — `mul`/`add`/`sub` on an integer element additionally need an
integer-valued constant, which is about the constant's *value*, not the (op, elemType)
*shape*, so it can't live in a static table:

```js
if (I.has(elemType) && NEEDS_INT_CONST_ON_INT_ELEM.has(op) && !Number.isInteger(c)) return null
```

`div` is deliberately absent from `NEEDS_INT_CONST_ON_INT_ELEM` — it's already excluded from
the integer kinds entirely in the table above, so no constant shape would matter.

Net effect at the call site: the two gates' ~43 lines (two `if`s plus their comments)
collapse to 2 short `if`s (13 lines) consulting one table declared once, with the
explanatory weight (WHY each pair is/isn't valid) consolidated into the table's own comments
instead of being split across two separate gate comments that each re-derived "genSimdMap is
the single place this decision lives."

## Pins added (test/simd.js)

- Differential: `Int32Array`/`Uint32Array` `.map(x => x / c)` for `c` in
  `{3, 4, -1, 0, 7, -7, 1.5}` against the host oracle, element-by-element, O0/O2/O3 — the
  exact previously-crashing shape (was "Unknown instruction i32x4.div").
- Differential: `Math.sqrt`/`Math.ceil`/`Math.floor` on `Int32Array`/`Uint32Array` against
  the host oracle, O0/O2/O3 — the exact previously-crashing shape.
- Differential: `Math.abs` on `Uint32Array` including high-bit-set elements
  (`4294967295`, `3000000000`, `2147483648`) against the host oracle, O0/O2/O3 — the
  previously-silent-wrong-value shape. A companion `Math.abs` on `Int32Array` pin confirms
  the signed case is untouched (still correct, still SIMD).
- WAT-shape controls (both directions, so a regression is caught even if the scalar
  fallback happens to compute the right number):
  - div/sqrt/ceil/floor on Int32Array/Uint32Array: `i32x4.div`/`.sqrt`/`.ceil`/`.floor` and
    the bare (invalid) scalar mnemonics are ABSENT from the emitted WAT.
  - abs on Uint32Array: `i32x4.abs` ABSENT.
  - div/sqrt/ceil/floor/abs on Float32Array/Float64Array: still present (unaffected).
  - mul/add/sub/bitwise/neg on Int32Array/Uint32Array: still present (unaffected —
    regression guard for the table refactor itself, not just the new rows).

## Oracle + battery

`node scripts/refactor-oracle.mjs check --ref a76a3d23`: CLEAN (0 differences) — the corpus
has no `.typed:map` callback shaped like the four bug rows above, so the oracle sees no
change at all, as expected for a bug fix with no prior corpus coverage of the broken shapes.

Full numbers (commit shas, battery pass counts, kernel-parity/kernel-oracle) are in the
landing commit message(s) for this branch, not duplicated here.
