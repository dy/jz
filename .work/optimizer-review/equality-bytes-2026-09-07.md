# Recursive kernel bytes: f0efa85b → d8ad7958 (+417,549) attributed

## Method

Four source trees (`git archive`): f0efa85b (base), the three commits as they
were in the worktree (c1 = item 2 `a2bf9125`, c2 = item 1 `5f8ead49`, c3 =
item 3 `2979236f`; identical content to main's 4feebbfd / ffcd2a05 /
d8ad7958). From each, two products:

- **host kernel**: `compile(self graph)` on node with the self profile, no
  snapshot (the recursive gate's profile), `names: true`, so every function
  has a name. Sizes per function from the code section (`fnsizes.mjs`).
- **hosted kernel** (the recursive gate's product): the host kernel of that
  tree compiling the same self graph (`hosted.mjs`, the gate's exact call).
  Base gives 13,860,938 B, c3 gives 14,278,487 B: the two numbers in the
  question.

The host product and the hosted product of one tree should agree
function-for-function (the functional gate's "native-identical" rows are
this parity on the corpus). At the base they do: the size multiset differs by
12 hosted-only / 11 host-only functions (7,430 / 7,817 B), the recorded
residual.

## Totals

| tree | host kernel (names) | host code section | hosted (recursive) | hosted funcs | hosted heap |
|---|---|---|---|---|---|
| f0efa85b base | 14,058,615 | 13,214,432 | 13,860,938 | 7,449 | 1,261,376,672 |
| c1 (item 2) | 14,066,330 (+7,715) | 13,222,433 (+8,001) | 14,270,010 (+409,072) | 8,692 | 1,297,020,296 |
| c2 (item 1) | 14,089,600 (+23,270) | 13,244,203 (+21,770) | 14,293,079 (+23,069) | 8,708 | 1,298,566,584 |
| c3 (item 3) | 14,076,293 (−13,307) | 13,230,899 (−13,304) | 14,278,487 (−14,592) | 8,707 | 1,295,431,264 |
| base → c3 | **+17,678** | **+16,467** | **+417,549** | +1,258 | +34,054,592 |

The host kernel grows 17.7 KB over the three commits. The hosted kernel
grows 417.5 KB: 1,249 functions (405,270 B by size multiset) that the host
product does not have appear at c1 and stay. Bisecting c1 into its two
pieces (host kernels built from base + one piece each, then the hosted
compile):

| probe | hosted bytes | hosted funcs |
|---|---|---|
| base + standalone `$__eq_strict` only | 14,264,669 | 8,687 |
| base + `$__eq_num` / looseNumberEq only | 13,866,093 | 7,453 |

The whole 400 KB is the standalone `$__eq_strict`.

## The 1,249 functions: closure-body dedup stopped in the kernel

A diagnostic kernel (`$__eq_strict` flags the case the old delegation
converted, a boolean atom beside its equal number; every call site's
counter bumps only on that flag, labeled by its function) fires at exactly
one site, 5,622 times: `closure4297`, which is `eq` inside `equalBodies` in
`src/wat/assemble/closure-table.js` (the closure-body dedup):

```js
const al = la.has(a), bl = lb.has(b)
if (al !== bl) return false
```

`la` is a proven Set (`$__set_has`, its result the raw 0/1), `lb` is
`cand.locals`, a slot value the callee cannot kind (its `.has` result
comes back as the TRUE/FALSE atom). `al` is BOOL-kinded but the analysis
marks it nullable (`mayBeNullish` fails closed on every call), so
`boolOrNullish(al)` sent the compare to the dynamic `$__eq_strict` with
`al`'s raw bits. The old `$__eq_strict` delegated to `$__eq` and converted
the atom to 1, so raw 1 vs TRUE compared equal and dedup worked; the
IsStrictlyEqual form compares a raw 1 with an atom as unequal, no two
bodies were ever equal, and every duplicate closure body stayed in the
kernel. The host runs the same source in node (`true !== true` is false),
so the host product deduplicated as before: a hosted byte-parity defect,
the same class as predicates 14-16 of the parity record, surfaced by the
strict form the record's item 14 introduced one step earlier.

Native reproduction (`test/bool-identity.js`, the new pin): the shape
returns 0 duplicates where JS returns 2, at every level, before the fix.

### Fix (a plan rule, not a special case)

The bool-identity contract: a boolean is raw 0/1 only while its static type
is known; the moment it enters an untyped position it is its atom. A
dynamic strict compare is such a position. `emitStrictEq`'s identity arm
and `emitLooseEq`'s strict `identity` now emit a BOOL-or-nullish operand
through `nullableBoolBoxIR` (a sentinel or an atom passes as is, a raw 0/1
boxes), beside the existing `mayCarryRawBool` → `emitIdentitySafeArms`
rule. Loose `==` is untouched (`$__eq` converts the atom).

`src/compile/emit/comparisons.js` (+13 / −8), pin in
`test/bool-identity.js` ("a nullable boolean beside an unkinded boolean
compares strictly as its atom": the dedup shape and a direct `Set.has`
pair, against the JS oracle, O0/O1/O2).

On 2ea67766 + fix, hosted vs host: 12 / 11 functions differ (7,430 / 7,817
B), the base's residual exactly.

## Per shape (host kernel, code-section bytes; the compiler compiling its own source)

Two sub-builds split c2: c2a = c1 + module/number.js + module/core.js (the
runtime helpers and `$__eq`'s arm); c2b = c2a + comparisons.js +
representation-plan.js (emitBigintEq, the string-literal path); c2 − c2b =
body-data.js (the array-literal storage-write edge) + array/callback.js.

| step | code bytes | what |
|---|---|---|
| c1: item 2 | +8,001 | linked helpers: `$__eq_num` 114, `$__eq_strict` 84 → 181 (+97). The rest is the compiler's own added source compiled: core.js thunks (+3,008), comparisons.js looseNumberEq (+1,337), closures (+3,284). No loose `==` site in the self graph pays: the graph holds 4 non-null loose `==` (watr compile.js, string-vs-unknown, unchanged path). |
| c2a: runtime | +8,657 | linked helpers net +313: `$__str_to_bigint` 411, `$__to_bigint` 603 → 193 (−410, its parse moved), `$__bigint_eq` 130, `$__eq` 308 → 374 (+66, the mixed arm), `$__bigint_eq_num` 42, `$__eq_strict` +29 (the one-box guard), `$__bigint_eq_str` 24, `$__eq_num` +21 (the BigInt arm). The rest is the compiler's own template source: number.js +4,751, core.js −4,483, closures +8,057. |
| c2b: emitter | +12,507 | `emitBigintEq` at the kernel's own BigInt compare sites: `m60_compile$reftype` +91, `m183_optimize$equal` +46, `m61_encode$i64` +8, `m298_recurrence` +12, `m106_coerce` +6: **+163 B**. The rest is the emitter's own source compiled: `emitBigintEq` 2,847, `mayBeBigint` 950, `emitLooseEq` +1,859, `emitStrictEq` −2,302 (C3 arm removed), predicates 243, closures +3,740, and autoload.js +5,000 (`loadModule`/`includeModule`/`hasModule` grew by inlining, a build-time consequence of the changed module graph, not an emitted shape). |
| c2 − c2b: array-literal edge, callback hint | **+606** | closures +538, callback.js +67. The edge boxes only a source the plan's `activeStorageSourceRep` reads as a definite raw BigInt (`edgeAction(RAW, BOXED)` = BOX); a source whose semantic excludes BigInt gets NO_BIGINT → KEEP, an open one gets REJECT → the legacy carrier. Nothing boxes where the summary proves no BigInt: the whole self graph (every IR array literal in jz and watr) moves 606 B. |
| c3: item 3 | **−13,304** | `coerceRest` no longer emits `maybeUnboxBigInt` (an `if` with a `$__ptr_type` call and a load) ahead of `$__to_str` at every tagged read reaching a template, `String()` or `+ ''`; toStrI64's inline box dispatch collapsed: json.js −1,492, coerce.js −1,009, regex −551, assign −358, optimize −353, handlers −341, closures −6,492, spread over 4,541 functions. dispatch.js +752 (the `.bigint:` fork case at `.toString(radix)` sites on unkinded receivers). |
| base → c3 | +16,467 | |

Summary of the price of the correct edges, host-measured: linked runtime
helpers **+524 B** (`__eq_num` 135, `__bigint_eq` 129, `__bigint_eq_num`
42, `__bigint_eq_str` 24, `__str_to_bigint` 411 against `__to_bigint`
−410, `__eq` +66, `__eq_strict` +126); `emitBigintEq` at call sites **+163
B**; the array-literal storage-write edge **+606 B**; `coerceRest` and the
one ToString path **−13,304 B**; the compiler's own source growth (the new
emitter and template code compiled into the kernel, plus inlining drift in
autoload.js) is the balance, about +29 KB.

## Heap

Recursive heap (the gate's `heap` after the compile): base 1,261,376,672;
c1 1,297,020,296 (+35.6 MB); c3 1,295,431,264 (+34.1 MB). The
`$__eq_num`/looseNumberEq-only probe: 1,261,806,416 (+0.4 MB). The 1,249
duplicate bodies are the heap growth: their IR through optimize, tape and
encode. On 2ea67766 (main, 1,013,778,792) the fix gives 988,217,016
(−25,561,776).

## Fix gates (2ea67766 + fix)

- Kernel gate: recursive **GREEN 13,894,137 B** (from 14,282,371: −388,234;
  +33,199 over f0efa85b, all of main's slices included), heap
  **988,217,016 B** (942.4 MiB), 61.2 s; functional **20/20 GREEN**, all
  native-identical; sequences GREEN; certified.
- Kernel oracle 15/15, parity 3/3.
- Native `node test/index.js`: **4365 pass / 2 fail / 1 skip** (the complex `[2n]` member `++` result at O0, the fromCharCode family; the new pin added).
- Families: **45/50**, the same five rows as a clean f0efa85b (the fromCharCode/escape rows, the slebSize warm-instance pass-2 trap, the escapes warm-instance row).

## Deliverables

- Fix: `eed0f797` on 2ea67766 in the worktree; patch
  `$S/patches/eq-fix/0001-A-nullable-boolean-enters-a-dynamic-strict-compare-a.patch`
  (`src/compile/emit/comparisons.js`, `test/bool-identity.js`).
- Products under `$S/eq/`: `k-{base,c1,c2a,c2b,c2,c3,main,fix}-ns.wasm`
  (host kernels with names) and their `.json` size tables, `hosted-*.wasm`
  (the recursive products), `k-diag.wasm` (the diagnostic kernel),
  `gate-fix.json`, `k-fix.wasm` (the gate's kernel of the fix). Tools:
  `build-nosnap.mjs`, `hosted.mjs`, `fnsizes.mjs`, `fndiff.mjs`,
  `extra.mjs`, `hosted-diag.mjs`.
