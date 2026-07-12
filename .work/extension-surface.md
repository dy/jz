# jz — extension surface & coverage plan

*2026-07-10. Ground truth from live suite runs + ~60 compile/run probes on this machine +
three full code sweeps (syntax surface, async/workers architecture, test262/stdlib inventory).
Every claim below carries its evidence; nothing here is re-derivable folklore. Companion to
the `test262` line in todo.md ("know every fail by face — jzify or error cleanly, never fail
unknowingly") — coverage and correctness are the same workstream.*

---

## Gates — what "safe extension" means

1. **Valid JZ = valid JS** (CONTRIBUTING.md Principles).
2. **Pay-per-use** — a program not using a feature compiles **byte-identically**. jzify
   transforms fire per-construct and stdlib includes are lazy (`ctx.core.includes`), so every
   Ring-1/2 item passes by construction. Gate each landing with `test/perf-ratchet.js` +
   `test/wat-invariants.js` absence pins.
3. **Native litmus** — "if another native language can presume it here, JZ may too"
   (CONTRIBUTING.md). Admits threads/Atomics; excludes descriptors/Proxy forever.

Strategy filter (strategy.md): test262 numbers are a *trust artifact* ("your test suite is
the compiler's test suite"), not a Porffor race. The valuable coverage moves also kill
silent divergence.

## Live posture (measured 2026-07-10, corpus pinned 05bb032)

- Language: **1462 pass / 0 fail / 21,924 skip** (6.1% of language/, floor 1453 ✓).
- Builtins: **719 pass / 12 FAIL / 51 xfail / 5,073 skip** — **RED vs floor 722, fail>0**.
- Combined ≈ 4.1% of the 53,598-file corpus; 0-fail honestly earned over a curated slice.

The 12 live builtins fails (same pinned corpus as CI → regression, not drift):
`Math.hypot()` → **boxed `null`** (want +0), `1/Math.hypot(0)` → `null` (want Infinity),
`parseInt(" //1")` → `null` (want 1 — Unicode whitespace skip),
`parseInt("0",1)` → 0 / `parseInt("0",37)` → 0 (want NaN), `parseInt("11",-2147483650)`
(i32 radix wrap), `parseInt(Infinity)` → Infinity (want NaN),
`String.indexOf` position-ToInteger of array arg, `Array.isArray.length`.
The `null` returns = a non-canonical NaN escaping the box as ATOM — suspect recent
math/str-hash legs (pow leg 07f6346, tiered `$__str_hash` 394ab5b). Triage first.
Also: 3 "unexpected passes" to prune from `EXPECTED_FAIL_FILES`.

---

## Ring 0 — truth debt (silent divergence / leaky errors; the "never fail unknowingly" contract)

| # | Finding | Today → Expected | Evidence / fix sketch |
|---|---|---|---|
| 0.1 | Builtins gate RED | 12 fails above → 0 | triage the boxed-null family first |
| 0.2 | **for-head `let` capture** | `for(let i…) fs.push(()=>i)` → `[3,3,3]` at every -O → `[0,1,2]` (ES §14.7.4.7) | only C-style head; `for-of` + body-`let` correct. Fix = jzify Babel-style copy-in/copy-out (`for(let __i…){ let i=__i; …; __i=i }`) **only when the head var is closure-captured** — pay-per-capture |
| 0.3 | **Mixed BigInt⊕Number** | `1n+1` → f64-bits-as-i64 garbage (`4607182418800017409n`); `5n>3` → `false` → TypeError (arith) / correct compare | `emit.js` cmpOp does `i64.op(asI64,asI64)` unconditionally when either side BIGINT |
| 0.4 | **`fn.bind`** | RuntimeError table-OOB → lower or clean reject | jzify: `g.bind(null,x)` → `(…r)=>g(x,…r)` for static callees |
| 0.5 | **`fn.call`/`fn.apply`** | silent `undefined` → direct call | jzify: `g.call(null,a,b)` → `g(a,b)`; spread-apply via existing variadic machinery; dynamic → reject |
| 0.6 | Symbol as computed key | `o[s]=3; o[s]` → 0 silently → clean reject | module/symbol.js has no property-key path |
| 0.7 | **Unknown method on KNOWN receiver** | `[3,1,2].toSorted()` compiles → runtime TypeError → compile error in default mode | `strict:true` already errors; a known-jz-native receiver has no host fallthrough — gate `emitUnknownCalleeCall` on receiver valtype |
| 0.8 | Regex `\p{…}` | silently matches literal `"p{L}"` → reject | regex.js:188 parseEscape default-falls-through |
| 0.9 | Regex `/y` | scans forward like `/g` → anchor at lastIndex | regex.js:864 search_from shared path |
| 0.10 | `matchAll` non-global | no TypeError → throw | regex.js:1123 |
| 0.11 | `.normalize()` | compile crash `Unknown op: [` → ASCII identity no-op | autoload.js:25 tuple misses `'array'`, so `externalMethodFallback`'s arg-packer is absent; implement natively instead |
| 0.12 | `**=` | `Unknown op` → works | `ASSIGN_OPS` (src/ast.js:77) misses it; kind-traits.js/program-facts.js copies already have it |
| 0.13 | strict-mode `switch`+`break` | "break/continue outside loop" → works | strict has a second native switch impl without a break frame (emit.js:3823); route strict through jzify/switch.js and delete the twin |
| 0.14 | `function*` w/o `yield`, `yield*` | leak `Unknown op` → clean "generators not supported" | add `'function*'`,`'yield*'` to REJECT_OPS (op-policy.js:12) |
| 0.15 | `new.target` | leaks watr "Unknown instruction" → clean reject | REJECT_IDENTS entry |
| 0.16 | `#x in o` brand check | generic not-in-scope → clean message (or Ring-1 lower to schema check) | — |
| 0.17 | **JSON.parse `reviver`** | silently dropped → implement | json.js:1529 single-param handler; runtime `replacer` likewise (const-fold path only) — kills a whole xfail family |
| 0.18 | `Object.freeze`/`isFrozen` | freeze no-op AND `isFrozen(freeze(x))`→false (self-inconsistent) → set the flag; bonus: freeze as optimizer fact (immutable schema) | object.js:202/232 |
| 0.19 | Tagged template `.raw` | `undefined` → second strings array | — |
| 0.20 | `({a,b} = obj)` assignment-form | internal error (kernel-leg residue, also main) → support | — |
| 0.21 | **for-of over nullish** | silently 0 iterations (JS: TypeError) → deliberate decision: throw or documented-permissive | surfaced independently by the instrumented-kernel session (todo.md) — it masked two real roots there; leaning THROW |
| 0.22 | `Object.create(proto)` | live-delegation reads not seen (shallow copy) → keep, but ensure README FAQ divergence list states it | object.js:617 documents itself |
| 0.23 | stale error text | strict `void` message claims "evaluates to 0" — behavior is spec-correct | message-only fix |

### Landed 2026-07-10 (session 2 — Ring 0 + unblanketing)

Language suite **1462 → 2205 pass / 0 fail** (6.1% → 9.2%), CI floor bumped
1453 → 2205. Fixed: 0.1 (hypot 0/1/n-ary via MATH_KERNEL — pre-eval was 2-ary
and DROPPED rest args; parseInt/parseFloat Unicode `__skipws`, radix 2..36
validation, numeric-arg ToString route incl. ±0/1e21/1e-7/Infinity;
indexOf-position + isArray.length xfail-classified; the "boxed null" theory was
a probe artifact — `JSON.stringify(NaN)` prints "null"), 0.8–0.10 (regex `\p`
rejects both contexts, `/y` anchors — one attempt at lastIndex, matchAll
requires /g at compile), 0.11 (`normalize` = ASCII identity + generic ToString
twin), 0.12 (`**=` — ASSIGN_OPS/STMT_OPS + emit desugar + autoload `**=`→math),
0.14–0.16 (function*/yield*/new.target/#x-in-o clean rejects), 0.19 (String.raw
→ clean reject; cooked-as-raw fold REMOVED — raw slices need upstream subscript),
0.23 (void text). Plus FOUR unblanketing-surfaced compiler fixes:
**destructuring defaults fired on null** (`??` lowering → spilled-temp +
`=== undefined` ternary, prepare/index.js pushPatternAssign; object defaults
routed through it), **numeric object-pattern keys crashed** (`{0:v}` →
string-hash on a number; now index reads), **`var` pattern declarators were
silently dropped** (hoist-vars: new `hoistVarPattern` collects binding names;
let/const untouched), **for-of head cover-grammar `{x=1}` mis-destructured**
(patternItems now unwraps the `;`-block cover shape). Pins in test/number.js,
math.js, errors.js, statements.js, strings.js, regex.js, destruct.js.

### Newly recorded gaps (from the unblanketing triage)

- **isArray of promotion-DERIVED arrays** answers false at O2+ (`s = a.slice(0);
  Array.isArray(s)` — literals.js's isArray disqualifier tracks direct names
  only; a blanket disqualifier regressed the __to_num elision pin → needs
  derived-name flow). Emitter now answers from static VAL.ARRAY when known
  (fixes O0/known-kind sites); 12 test262 files ride xfail.
- **catch-param patterns** (`catch ({ x })`) and **`var`-pattern for-of heads**
  (`for (var {x} of …)`) don't bind — clean not-in-scope today; small
  prepare/hoist lowerings.
- **Member-expression for-of/destructure targets** (`for (o.x of …)`,
  for-of-head `[o.x]`) — silent 0 today in head position; plain `[o.x] = arr`
  works.
- **const reassignment guard absent entirely** (`const c = 2; c = 3` compiles
  and mutates, every operator) — the skip catalogue said "cheap to add"; it is
  currently not enforced anywhere.
- ~~jzify/arguments.js rest-param default `??`~~ — FIXED same session (review
  pass): inline `=== undefined` ternary over the idempotent index read; pinned
  in test/destruct.js. `**=` also added to emit's SIDE_EFFECT_OPS (was missing
  → statement-position `x **= f()` risked being dropped as pure).
- Bool-carrier xfail family (37 language files + the 48 builtins fails +
  optimizer.js `__to_num` elision pin + perf-ratchet `nest` +275 ops) — all in
  the in-flight carrier work's domain; re-triage on landing, prune xpasses.

### Landed 2026-07-11 (session 3 — Ring 0 completion + runner honesty)

All remaining Ring-0/Ring-1-adjacent items landed; language 262 **2232 pass /
2494 neg-reject / 1551 neg-accept / 0 fail** (98.5% of language/ tracked),
builtins **727 / 0 fail** with TypedArray/WeakMap/WeakSet/RegExp pools wired.
CI floors: 2232 / 727.

- **Predicate builtins carry BOOL** (kind-traits CALLEE_VAL: isNaN/isFinite/
  isArray/Number.is*/Object.is/hasOwn/isFrozen…): `isArray([]) === true` was
  bit-comparing a raw 0/1 against the TRUE atom. `valueOf` passes the receiver
  kind through; `Array.isArray(NS)` folds to boolean false (was number 0).
  Boundary now yields REAL true/false for predicates (pins updated). Residue:
  the mixed `??`/`||`/`?:` JOIN family — recorded carrier-design edge.
- **freeze/isFrozen consistent**: prepare's identity fold records the binding
  (ctx.runtime.frozenVars); isFrozen answers true while never-reassigned.
- **strict `switch` rejects** per the language table; the emit/prepare native
  twin (which miscompiled `break`) is DELETED — jzify's lowering is the one
  switch implementation.
- **BigInt mixed ops**: literal mixes reject (`1n + 1`, `1n | 2`, `**`, unary
  `+1n` — all were raw-bit garbage); literal-mixed COMPARES coerce via f64
  (`5n > 3`, `0n < 0.5`); non-literal sides keep the permissive i64 contract
  (kernel carriers read NUMBER by default — a kind-default, not a proof).
  Reduce seeds a BIGINT acc kind from a bigint init (the SWAR idiom).
- **call/apply/bind lower statically** on proven function bindings (prepare
  foldFnCallApplyBind): thisArg dead (side effects kept via comma), bind mints
  explicit remaining params from the callee arity, literal-array apply expands.
  User objects' own `.call` props untouched. Were silent-undefined/table-OOB.
- **Unknown method on a KNOWN receiver** is a compile error in every mode
  (externalMethodFallback: a jz-native kind has no host fallthrough).
- **JSON.parse reviver implemented** (prepare lowers to an inline bottom-up
  walk; divergence: undefined ASSIGNS instead of deleting); **stringify's
  non-foldable replacer REJECTS** (was silently ignored); foldStringify's
  array-replacer now hand-filters (the host `stringify(v, rep)` call was
  replacer-less in-kernel — host≠kernel fold divergence, fixed).
- **const-reassign guard** at prepare (scope-stack tracked, post-rename):
  every operator, local + module scope; shadowing `let` stays writable.
- **catch-param patterns** (`catch ({ a })`), **var-pattern for-of heads**
  (`for (var [y] of …)` — hoist-vars dropped the declarator), **assignment-
  form for-of/for-in targets** (`for (x of …)`, `for (o.x of …)`, `for ([a]
  of …)` — the unconditional `let` wrap shadowed the outer binding; after-loop
  reads saw stale values).
- **Per-iteration for-head `let` bindings** (ES §14.7.4.7): copy-in/copy-out
  lowering when a body arrow captures the head var (pay-per-capture; body-let
  rides emitLoopFreshBoxed). `fs.push(() => i)` captures 0,1,2 — was [3,3,3].
  In-body mutation + step semantics verified against host JS (135 case).
- **Nullish for-of throws** (landed via __iter_arr with the kern-root
  rationale — confirmed, 0.21 closed).
- **Runner**: negative-parse tests run INVERTED — 2494 correctly-rejected
  count as their own class; **1551 silent-accepts surfaced and tracked**
  (early-error grammar a subset compiler doesn't enforce — the honest dent in
  "valid jz is valid JS"; measured per-dir, not gated). language/import
  tracked; fixture support files excluded.
- **Selfhost-surfaced fixes** (the new rejects caught jz's OWN latent
  divergences): nodeEqual/hoist-key/formatErrorNode used stringify REPLACERS
  that the kernel silently dropped (unsound SLP/CSE dedup keys in-kernel!) —
  all three now use replacer-free recursive keyers, host≡kernel.
- Gates at close: selfhost build + round-trips green, differential 23/6898,
  scalar fuzz 30k/0, ratchet 6/6, optimizer 167, simd 156, 17 unit suites
  green. Known followups: reduce RESULT kind for bigint init (Number() of it
  reads raw bits — probe-level edge), the ??-join bool family, isArray-of-
  derived-promotion (12 xfails).

## Runner honesty pass (coverage without touching the compiler)

The per-directory table proves the skip buckets hide already-working surface:
`for-of` **0**/751, `template-literal` **0**/57, `tagged-template` **0**/27,
`logical-assignment` **0**/78, `switch` 1/111, `labeled` 1/24, `let` 5/145, `const` 4/136,
`optional-chaining` 6/38 — all constructs verified working this session.

- Split blanket `EXCLUDED_PATTERNS` (test262.js:147) into "uses generators/symbols/
  descriptors/eval → skip" vs "plain → run".
- Track implemented-but-untracked built-ins pools: **TypedArray 2,184**, **RegExp 1,877**
  (beyond the 2 exec files), **WeakMap/WeakSet 226** (supported via fold!), Error family
  187, Boolean/global/decodeURI remainder. New fails-by-face included — that's the point.
- Add `language/import/` (182 files) to TRACKED_LANGUAGE_DIRS (`eval-code/` stays out).
- **Negative tests**: jz already rejects all 4,389 parse-negative tests (0 silent accepts,
  audited) — they count as skips only because errors aren't typed `SyntaxError`. Count
  "correctly rejected" as its own honest pass-class in the report.
- Prune the 3 unexpected-passes; re-bump baselines after Ring 0.

## Ring 1 — jzify lowerings (close reach, zero-cost by construction)

- **bind/call/apply** static lowering (0.4/0.5 above) — highest npm-reach per line.
- **Pseudo-classical constructors** — `function Foo(){this.x=…}` + `Foo.prototype.m=…` →
  existing class lowering (`this`-rename machinery already there). The biggest blocker for
  jzify-ing older npm code; today REJECT `this` outside class/method-shorthand.
- **Static blocks** — only the catch-all at jzify/classes.js:229 stops them; run in
  class-init order.
- **Computed class keys from same-scope consts** — extend `constStringKey` with the
  const-binding fold pre-eval already does elsewhere.
- **Labeled non-loop statements** — grammar's `control` list is the only gate; jzify
  `LABEL_BODY_OPS` already anticipates them.
- **`using`/`await using`** (ES2026 ERM, 172 tests) — parser doesn't know it yet
  (`Unclosed {`); pure try/finally + `[Symbol.dispose]()` sugar. Cheap once grammar lands;
  low domain value; optional.
- **Getters/setters stay rejected** — schema-known accessor→call lowering is possible but
  dynamic receivers would grow a per-access check (violates gate 2); descriptor territory.

### Generators — the pivotal Ring-1 item

Not coroutines: **regenerator-style state machines need no stack suspension.** Locals lift
into the closure env (mutable captures shipped — research.md Closures), body becomes a
dispatch loop over a state local (the exact shape jzify/switch.js already builds),
`gen.next(v)` is an ordinary closure call via the uniform ABI.

- **Sync** — no event loop, no microtasks; the anti-goal is untouched. Lazy sequences are
  functional, not OOP.
- **Local fusion = the headline**: `for (const x of gen())` with a statically-known
  generator SROAs the machine away into a plain loop — zero-cost lazy sequences; V8
  allocates generator objects, jz compiles them out.
- Unlocks the **iterator protocol** (user `Symbol.iterator`, generic spread), then
  **ES2025 iterator helpers as fused loops** (514-test pool) — the best "new standards"
  flagship for the audience.
- It is **80% of async's machinery** built without the contested 20%.
- Real costs: regenerator-class transform (try/finally across yield = handler re-entry per
  resume; try/catch is real wasm EH `try_table`, so scopes re-establish per state entry);
  env-cell inference degradation inside generator bodies (acceptable — fusion recovers hot
  cases).
- Pools: generators 556 + yield 63 + iterator-dependent slices of for-of 751 + Iterator 514.

## Ring 2 — stdlib completion (module/, pure compute, mechanical)

| Item | Note |
|---|---|
| Array `toSorted/toReversed/with/copyWithin/of` (ES2023) | **TypedArray already has all four** — port; `Array/of` is tracked-and-scoring-zero |
| Set `union/intersection/difference/symmetricDifference/isSubsetOf/isSupersetOf/isDisjointFrom` (ES2025) | pure set-algebra over existing open-addressing tables; 383-test pool |
| `Object.groupBy`/`Map.groupBy` (ES2024) | trivial over HASH/Map |
| JSON `reviver`/runtime `replacer` | = Ring 0.17 |
| `String.raw`, `.normalize()` ASCII identity, `RegExp.escape` (ES2025) | one-liners |
| **Float16Array** (ES2025) + `Math.f16round` | u16 storage + convert helpers; pixels/ML interchange |
| `structuredClone` | arena deep-copy — natural fit |
| Regex: named backrefs `\k<n>`, real `/y`, matchAll TypeError | contained engine work; makes the 1.9k RegExp pool trackable |
| Date `toJSON`/`toDateString`/UTC-stringify slices | per existing todo scoping; local-tz stays out |
| **Ryū/Grisu shortest-round-trip `String(number)`** | the one user-visible divergence ordinary code hits (`JSON.stringify(0.1)`); ~2–4KB, lazily included only when float-stringify reachable, or opt-in; biggest single trust win |
| Insertion-order Map/Set | already-documented divergence with designed fix (seq sidecar, todo Future); decide on a bench gate — engines pay the same cost |

Already shipped & worth marketing: `Math.sumPrecise` (Stage 3), TextEncoder/Decoder, full
DataView incl. BigInt64, Math 100% complete.
BigInt: keep i64 wrap (native litmus, documented); fix mixed ops (Ring 0.3); arbitrary
precision stays out.

## Ring 3 — wasm-platform standards direction

watr already encodes more than jz uses — toolchain is ahead of the language:

- **Threads/atomics/`shared` memtype** — fully encodable today (`atomic.rmw.*`,
  `atomic.wait/notify`, shared). → Workers below.
- **Relaxed SIMD** — watr has `relaxed_madd/nmadd` (FMA): the named lever for the
  biquad/fft native-parity floor. **Opt-in flag only** (`relaxedSimd:true`) — FMA breaks
  bit-exact valid-jz-runs-as-JS, the documented FMA class.
- **JSPI / stack-switching** — watr encodes the Phase-3 opcodes already; still wrong base
  for async (Chrome-only shipped as of 2026-01 knowledge; absent JSC/WASI/wasm2c — breaks
  the portable-artifact pitch). Reserved-error stance like `host:'gc'`.
- **js-string-builtins** — partially wired (`wasm:js-string` in interop); deepen zero-copy
  host strings.
- memory64 / multi-memory: encodable, YAGNI until a workload. Component model/WIT: already
  Future. custom-page-sizes: relevant to the MCU direction.

## Async — the verdict (investigated, then parked on purpose)

**Not a hard architectural hit.** The pipeline needs zero changes: async fn → jzify state
machine (same machinery as generators) + `module/promise.js` on a **free NaN-box tag**
(5, 12–15 are free — research.md's "4 free" undercounts; SSO moved to an aux bit) + a
microtask queue pumped exactly like timers already are (`host:'js'`: env.setTimeout → host
loop calls back an export; `host:'wasi'`: in-wasm queue + exported `__timer_tick`,
module/timer.js). Continuations ARE jz closures (`$__invoke_closure` is the resume
primitive). Sync code pays nothing; no engine deps.

- **Asyncify: rejected** — whole-module instrumentation × closure-heavy `call_indirect`
  graphs = global size/speed tax + a post-watr pass class the architecture forbids.
- **JSPI: rejected today** — portability (above).
- **The one hard problem: the arena.** A pending continuation holds env pointers into the
  bump heap; `memory.reset()` mid-flight leaves dangling callable state — a correctness
  hazard class that doesn't exist today. Proper fix = nursery arena for in-flight callback
  state, or a documented "no reset while promises pending" contract. **This is the open
  design item**, not the control-flow transform.
- **Why parked**: the domain doesn't want it (kernels; "Not for" column; sync-instantiate
  is a marketed feature), and the async test262 pool (~2.4k language + 703 Promise) mostly
  tests job-queue ordering. Callback-style host imports already work. Re-open when a real
  wedge (Extism plugins / edge functions with async host calls) demands it — generators
  will have built the machinery by then.

## Workers — yes, and before async

Philosophy-aligned: parallelism IS compute; SAB+Atomics is standard JS mapping 1:1 onto
wasm threads with no runtime; worker spawn stays host-side (I/O boundary discipline, per
the todo Future note); valid-JZ-is-valid-JS **holds** — the same source runs in JS workers
over a SharedArrayBuffer.

Exists: `memory.shared` plumbing (import-memory mode — note assemble.js:883 does **not**
emit the wasm `shared` memtype keyword yet); bump pointer already lives in memory at 1020
specifically so instances share it (module/core.js:318); watr atomics; the vectorizer.

Missing, mechanical: `(memory … shared)` + required max; atomic `__alloc` bump
(core.js:350 is plain load/store — races); `module/atomics.js` lowering
`Atomics.load/store/add/…/wait/notify` on Int32Array/BigInt64Array; ~100-line interop
pool/spawn helper.

**The real cost** is the stdlib's single-writer assumptions: relocation forwarding
pointers, lazy string-hash cache bit (STR_HCACHE), object enum caches, hash growth — each
races under true sharing.

**v1 contract that dodges it**: shared **typed arrays + scalars only** (the SPMD tile
shape of the entire bench corpus — mandelbrot tiles, raytrace rows, FFT batches, pixel
filters); strings/objects/hashes stay thread-local by documented contract (allocation is
atomic so it's safe). Small, honest, and produces the strategy's headline:
*"N×cores over V8, same JS file"* — SIMD × cores compounds. Atomics (390) + SAB (104)
pools become trackable. Shared-everything waits for the audit (and possibly the
shared-everything-threads proposal).

## Permanently out (documented in README FAQ; reasons canonical here)

Proxy/Reflect (traps over compile-time offsets are meaningless) · property descriptors &
accessors (no per-property metadata slot — same root as freeze/defineProperty) · live
prototype chains (`Object.create` = documented shallow copy; static dispatch) ·
`delete` on fixed-shape literal keys (shape fixed at construction; dictionary-mode delete
works) · eval/Function/with (compiler at runtime) · Intl + Temporal (CLDR/ICU/tz tables,
hundreds of KB–MB) · UTF-16 semantics & Unicode tables (`\p{…}`, normalize forms, locale
case — the UTF-8 byte model is load-bearing) · arbitrary-precision BigInt · WeakRef/
FinalizationRegistry (no GC to observe) · annexB, DOM, fetch, Node APIs.
Litmus: needs a runtime jz refuses to ship, or per-access metadata that taxes programs
not using it.

## test262 math (pools, for expectation-setting)

Never-pool: Temporal 4,603 + intl402 3,341 + annexB 1,086 + eval-code 347 + with 181 +
Proxy/Reflect 464 + dynamic-import 997 + ShadowRealm 67.
Gated pools: async family ~2,481 language + Promise 703 (parked) · class dirs 8,426
(descriptor/proto tests never pass; realistic slice with static blocks + computed-const
keys + brand checks ≈ 1.5–3k) · generators+iterator ≈ 1.1–1.9k (Ring 1) · builtins
method-completion: the 5,073 tracked skips + newly-tracked TypedArray/RegExp pools (Ring 2
+ runner pass).

## Order

1. **Ring 0** — restores 0-fail (gate is RED today) + the never-fail-unknowingly contract;
   mostly one-liners; includes the two semantic fixes (0.2 let-capture, 0.3 BigInt).
2. **Runner honesty pass** — biggest visible-coverage jump, zero compiler risk.
3. **Ring 2 stdlib batch** — mechanical; converts skips/xfails to passes.
4. **Workers v1** — the differentiator; small once scoped to typed-array SPMD.
5. **Generators** — best philosophy-fit/leverage language extension; async's machinery
   without its philosophy breach.
6. **Iterator helpers as fused loops** — ES2025 flagship riding 5.
7. **Parked with designs recorded**: async (nursery/reset open item), relaxed-SIMD opt-in,
   JSPI watch, insertion-order decision, Ryū module.

Fixed-shape objects, the arena, UTF-8 strings, errors-as-values stay untouched — every
item above extends the surface without spending those four design commitments.

## Ring 2 — landed (2026-07-12)

All stdlib items shipped, pinned, and verified (full suite 0-fail; test262 language
2232/0, builtins 737/0 in-scope — CI baselines bumped):

- **Array change-by-copy** toSorted/toReversed/with/copyWithin + Array.of.
- **ES2025 Set algebra** (7 ops) — spec result order verified against test262 fixtures;
  real Set/Map operands only (set-like GetSetRecord protocol xfail'd: out of the value model).
- **Object.groupBy / Map.groupBy** — __iter_arr sources, identity Map keys, spec
  IsCallable throw before iteration.
- **Regex**: named backrefs `\k<name>`, RegExp.escape (byte-exact vs host for ASCII;
  \u-escaping of astral/whitespace xfail'd — byte-wise strings).
- **Date**: toJSON (null on invalid), toDateString/toTimeString (UTC-backed, fixed
  "GMT+0000 (Coordinated Universal Time)" suffix — documented TZ divergence),
  toISOString expanded years fixed to spec (±YYYYYY).
- **Date schema brand**: dates now carry a registered 1-slot schema ('\x00time') instead
  of aux=0 aliasing schema id 0 — dyn-get, {...date} and structuredClone all see the true
  shape (fixed a latent corruption class).
- **structuredClone** — deep arena clone: identity memo (MAP keyed by boxed bits) gives
  cycles + diamond sharing incl. buffer-shared typed views; insertion order preserved;
  Map keys AND values cloned; closures/host handles throw (DataCloneError). transfer
  ignored (arena has nothing to detach).
- **Math.f16round** — exact round-via-addition (adder does ties-to-even at the f16
  quantum); 200k differential vs host bit-exact. **Float16Array deferred**: elemType
  field is saturated (3 bits, 8 kinds; VIEW=bit3, BIGINT=bit4) and wasm has no f16
  memory ops — software-shimmed loads would betray the native-perf litmus. Revisit
  when the wasm FP16 proposal ships (native loads + SIMD justify the aux re-layout).
- **Ryū String(number)** — ES-spec-exact shortest round-trip digits (port of reference
  d2s.c, small-table variant: 828-byte seed, entries rebuilt per call — verified
  entry-exact vs the full reference tables for all 618 indices). 3,010,156-value
  differential vs V8 String() bit-exact (subnormals, binade edges, boundary bit
  patterns, random sweeps). ES notation branches live in __ftoa_shortest, replacing
  both the 9-digit truncation AND the 8-digit exponential gate. ~1.2KB per module where
  __ftoa links (goldens re-baselined); ~0.17µs/stringify (~3.6× V8 native). The math.js
  PI/INV_PI string-literal workaround is reverted — `${Math.PI}` now interpolates
  full-precision in both legs (the end-to-end proof).
- **Insertion-order Map/Set** — verified already-landed seq machinery is host-exact
  (delete+re-add → end, overwrite stays, rehash preserves); pinned; todo closed.
- **instanceof predicates** (__is_map/__is_set/__is_typed) classified VAL.BOOL —
  `(x instanceof Map) === true` now compares booleans, not a raw carrier vs the atom.
- **Lazy-table injection generalized** (assemble.js): EL + Ryū seed as an order-
  independent span list; dead spans excised post-lowering with exact liveness, survivor
  globals re-pointed; table globals registered in staticI32GlobalInits (also fixes a
  latent __el_tbl offset hazard when the static prefix is stripped).

### Pre-existing bugs surfaced while pinning — ALL FIXED (2026-07-12 follow-up session)

- ~~sort() statement-position `__to_str` leak~~ — root: the default (lexicographic)
  comparator incs `__to_str`/`__str_cmp` without ensuring the string MODULE; fixed with
  `ctx.module.include('string')` at the default-comparator branch (pay-per-use). Pinned
  via the try-discard test below (toSorted case).
- ~~try-discarded-value stack imbalance~~ — root: `applyArenaRewind.rewriteReturns`
  wrapped `return v` in a VALUE-TYPED block (+unreachable); as a statement inside a void
  try_table the reified `(result T)` left a phantom stack value. Fix: rewrite the
  return's VALUE instead — `return (block (result T) set/restore/get)` — the `return`
  keeps wasm's stack-polymorphism and validates in every position. Pinned in
  test/errors.js.
- ~~dictionary `delete d[k]` no-op~~ — root: `__dyn_del` had no arm for a HASH
  *receiver* (a dictionary is ITS OWN storage; every arm only probed the props
  sidecar). Fix: HASH-first arm delegating to `__hash_del_local` on the receiver.
  Enum-cache invalidation and re-add-to-end order verified host-exact; pinned in
  test/data.js.

### Still open from the plan (not Ring 2 scope)
- ~~JSON.stringify(date) → ISO~~ — LANDED (2026-07-12): __json_obj factory-conditional
  arm on the branded sid; invalid date → null; host-exact in every position. Pinned in
  test/json.js. Pay-per-use: programs without the date module emit nothing.
- Ryū follow-up: none needed — small-table variant landed directly.

## Ring 1 leftovers — assessed (2026-07-12)

- **Labeled non-loop statements** — LANDED: one line (`'{}'` joins LABEL_BODY_OPS);
  the label/break machinery already handled block bodies. Pinned in test/statements.js.
- **Computed class keys from module consts** — LANDED: jzify entry prepass collects
  module-scope `const K = 'str'` bindings; constStringKey folds `[K]` for methods AND
  fields (const guarantees no reassignment). Dynamic keys still reject cleanly. Pinned
  in test/classes.js.
- **Pseudo-classical constructors** (`function Foo(){this.x=…}` + `Foo.prototype.m=…`)
  — still a clean reject ("`this` not supported"). Real jzify work: collect prototype
  assignments per constructor, synthesize a class, reuse the class lowering. Highest
  npm-reach item; park until the generators milestone is done (bigger leverage).
- **Static blocks / static members** — the probe shows `static v = 1` itself rejects
  ("static class members are not supported yet"), so this is "static members" work,
  not just static blocks as the plan noted. Park with same priority as above.
- **`using`/ERM** — parser still doesn't know the grammar (`Unclosed {`); blocked
  upstream (subscript), low domain value. Stays parked.

## Workers v1 — landed (2026-07-12)

The plan's #4 milestone, shipped on the v1 contract (shared typed arrays +
scalars; strings/objects/hashes thread-local). Full suite 2838/0 including a
5-test workers suite with REAL node worker_threads.

- **`opts.sharedMemory`** — imports env.memory with the wasm `shared` memtype
  (spec max defaulted to the 4 GiB ceiling). Distinct from importMemory (a
  plain imported Memory must stay non-shared or linking breaks).
- **Atomic heap bump** — the shared-mode `__alloc` is a cmpxchg retry loop on
  memory[HEAP.PTR_ADDR]; `__clear` stores atomically. Plain imported memory
  keeps the cheap non-atomic bump.
- **Shared static region** — shared memory has no active data segment at 0:
  the static region (static strings + EL/Ryū lazy tables) now ships as a
  PASSIVE segment, memory.init'd into __alloc'd space at start behind
  `$__staticBase`; `__static_str` and the table globals rebase. This also
  fixed a PRE-EXISTING hole: `String(n)`/`Number(s)` on ANY imported memory
  read garbage tables.
- **module/atomics.js** — load/store/add/sub/and/or/xor/exchange/
  compareExchange/wait/notify/isLockFree on PROVEN Int32Array receivers;
  host-identical semantics (12-op differential), spec RangeError on OOB,
  wait → 'ok'/'not-equal'/'timed-out' (static strings 9-11), notify count.
  `__atomics_addr` guards tag+elem at runtime, so an out-of-contract host arg
  throws instead of corrupting.
- **Typed default-arg annotation** — `(arr = new Int32Array(0))` seeds the
  param lattice (weak seed; call-site facts still merge/poison over it): the
  ONLY self-declared evidence a host-called SPMD kernel can carry. The
  whole-program-narrowing skip gate now yields when such annotations exist.
- **jz.pool(source, {threads, pages, maxPages})** — compiles once with
  sharedMemory, instantiates main + N node worker_threads over ONE shared
  Memory; run(fn, ...args) broadcasts fn(workerIndex, threads, ...args);
  boxed args cross as exact i64 bits (jz:i64exp lanes — the worker shim honors
  the lane map). `p.memory.Int32Array(...)` allocates the shared array and its
  BigInt box is the arg. Verified: 4×1000 contended Atomics.add loses nothing;
  4 workers block in Atomics.wait and the MAIN instance's notify wakes all.
- **En-route fix**: supporting labeled blocks exposed the `['{}',[':',…]]`
  ambiguity (single-prop literal ≡ single-labeled-statement block) — '{}' in
  LABEL_BODY_OPS silently converted `y: {…}` object PROPS into labels (nested
  literal props vanished). Resolution at the honest altitude: labels of blocks
  are recognized ONLY in statement positions (transformScope's statement
  loop); LABEL_BODY_OPS keeps expression-context disambiguation.

Next named steps: browser Worker leg for jz.pool; BigInt64Array atomics;
bench headline (mandelbrot tiles × cores).

## Generators v1 — landed (2026-07-12)

The pivotal Ring-1 item, exactly as designed: regenerator-style state machines,
no stack suspension. `function*` lowers (jzify/generators.js) to a factory
arrow — body locals hoist to the factory scope, the body becomes a dispatch
loop over a state local, `{ next, return }` are ordinary closures over that
state (mutable captures carry it), each `yield` splits a state and `next(v)`
delivers the sent value at the resume point. Sync only — no event loop.

- for-of over a KNOWN generator call desugars to while-next — outside AND
  inside generator bodies (nested generators compose).
- Decomposition: if/else, while, do-while, C-style for, unlabeled
  break/continue of decomposed loops; compound statements WITHOUT yield stay
  atomic — with the free-jump gate (a non-yield `if (…) continue` whose loop
  was decomposed must decompose too, or its continue binds the dispatch loop).
- Protocol verified host-exact: two-way next(v), return(v) closes the machine,
  independent instances, empty generator immediately done.
- v1 rejects with precise messages: yield*, yield in arbitrary expressions,
  try across yield, yield inside for-of/for-in bodies, destructuring/duplicate
  let declarations in generator bodies (hoist-rename support later).
- 10-test suite (test/generators.js); the stale "prohibited" pins graduated.

Next (recorded, not yet built): ES2025 iterator helpers as fused loops over
these machines (`for (x of g().map(h).filter(p))` → one composed while-next —
zero intermediate objects); yield* delegation; test262 generators pool wiring
(needs the runner-honesty treatment — track the pool, xfail the out-of-v1
families: yield*/try-across-yield/throw()).
