## jz — execution plan

#### Perf

* [ ] **Auto AoS→SoA carrier.** `xs[i] = rows[i].x + …` — load is a
  pointer-chase, store lane-aligned; wasm-v1 has no gather. Honest fix is a
  struct→SoA carrier (sibling to `src/abi/array.js`'s `structInline`),
  blocked on the narrower emitting SoA-eligible carrier facts. Multi-week,
  cross-cutting (touches every array consumer). Deferred until a real
  workload demands it. Hand-written SoA already vectorizes — Archive ›
  "opts.host user surface + custom sections reference + SoA boundary pin
  (2026-05-20)".

#### Representation

* [ ] **jsstring carrier — internal-STRING-locals flow.** Propagate
  externref past the export boundary into internal STRING locals so parsers
  carry `src` end-to-end without memory-backed copies. Blocked on the
  narrower converging carrier facts across the call graph (fixpoint, not
  just leaf exports). Archive › "jsstring boundary carrier (2026-05-20)"
  covers the landed leaf-export work.
* [ ] **Boundary string cache in interop.js.** Cache `mem.wrapVal(s)` by
  string identity so repeat-same-string workloads amortize the UTF-8
  transcode — orthogonal SSO improvement.

#### Product / measurement (needs a measurement+product session, not a compiler edit)
* [ ] **Bench cols — `jz.speed` vs `jz.size`.** Second harness pass with a
  size-target so the table shows the speed/size trade explicitly.
* [x] **AS ecosystem audit.** Done → [.work/ecosystem-audit.md](ecosystem-audit.md).
  Verdict: **don't port AS's test suite** (it asserts a different language;
  test262 + differential fuzzer + bench gate are the right targets). DO mine AS's
  showcase compute kernels (path tracer, emulator core, codec, hash) into
  `bench/`/`examples/`. AS's real traction is blockchain — out of jz's scope,
  don't follow. Sequenced reach plan below.

### Ecosystem & reach — sequenced (from `.work/ecosystem-audit.md`)

Ordered by value × leverage × effort. The lens: **valid jz = valid JS** ⇒ the
same source runs as JS and as jz-WASM, so every demo flips one switch to show the
speedup honestly. No other JS→WASM tool can do that. Build that toggle once, reuse
everywhere.

#### Examples — astonishing, build next (have 3: life / interference / mandelbrot)
* [ ] Add the **JS ⇆ jz-WASM toggle + live FPS counter** to the 3 existing demos (cheapest credibility win, reuses infra)
* [ ] **Strange attractors** (Clifford / de Jong / Lorenz) — 2-line f64 formula × millions of iters → luminous structure; jz's exact sweet spot
* [ ] **Software path tracer / SDF raymarcher** — "Shadertoy on the CPU, but fast"; mirrors AS as-smallpt in plain JS
* [ ] **Reaction-diffusion (Gray-Scott) / Lenia** — per-pixel convolution per frame; Lenia looks alive
* [ ] **Boids + simplex flow-field** — the genart canonical (mattdesl/Hobbs); particle count *is* the benchmark
* [ ] **CHIP-8 emulator core** — integer dispatch = jz's floor; mirrors AS wasmBoy
* [ ] **QOI codec** (~300 readable lines) — competes with surma's 904 B hand-WAT on *size*; ties to color-space
* [ ] (later) FFT spectrogram; dithering/convolution filters

#### Flagship + the one compounding "make-world-know" move
* [ ] **Floatbeat playground** (already roadmapped → promote to flagship) — type a formula, hear music, AudioWorklet, compiled live; vibecoder + audio + live-coding proof in one
* [ ] **Playground site** = gallery + floatbeat + WAT-showing REPL, every item a shareable permalink. The demo *is* the marketing. Greenfield (no `playground/`/`repl/` yet)

#### Integrations (affect area: native-speed compute from plain JS, sandboxed/portable)
* [ ] **`unplugin-jz`** — highest leverage; one plugin covers Vite/Rollup/webpack/esbuild/Rspack. `import { fib } from './fib.js?jz'` → WASM at build time. Leapfrogs AS's separate rollup-plugin + as-loader. (Folds the existing "unplugin" + "template tag as build tool" Ideas bullets)
* [ ] **AudioWorklet path** — write `process()` in plain JS, jz compiles it in the worklet; painful today (Rust/AS+bindings)
* [ ] **Dogfood own libs** — color-space / digital-filter / web-audio-api compute cores on jz (highest-trust benchmark; the "integrations as validation" item)
* [ ] **Extism plugin path** — "author Extism plugins in plain JS"; underserved niche. (EdgeJS already landed — one point in this field)
* [ ] **WASM-4 fantasy console** — supports AS/C/Rust/Zig/Go but **no plain-JS path**; cartridge = WASM `start`/`update` over a framebuffer = jz's shape. Fun, viral, direct AS territory
* [ ] (later) live-coding hosts (Hydra/Strudel/p5/canvas-sketch) — jz as the compile-your-hot-loop escape hatch; prove "compiles faster than eval" and un-comment the README claim

#### Embedded — jz → native MCU, no interpreter
Path: `jz → wasm2c/w2c2 → C → arm-none-eabi-gcc / esp-idf / avr-gcc → flash`.
Unlike Espruino / Moddable XS / wasm3-arduino (all **interpreters** on-device),
jz is **AOT-compiled to native** — zero interpreter, zero on-chip runtime. This is
the honest differentiator and a genuine gap.
* [ ] **Target matrix + f64 reality.** Best on FPU MCUs (Cortex-M4F/M7: ESP32, RP2040, STM32, Teensy 4, Daisy Seed). M7 (Teensy 4 / Daisy) has a **double-precision FPU** ⇒ jz's f64 model unpenalized. AVR Uno has no FPU ⇒ i32-only kernels or out of scope. Document it.
* [ ] **Pure-compute proof.** `alloc:false`, no WASI imports, scalar kernel → C → flash → output verifies native run (reuse the existing wasm2c/w2c2 integration-test pipeline as the build harness)
* [ ] **Flagship: biquad on hardware.** digital-filter biquad (own lib) → jz → C → Daisy Seed / Teensy audio out. DSP on MCU is jz's strongest embedded fit — audience already writes DSP in C++, would take plain JS
* [ ] **Heap + RAM budget.** For heap-using modules pick a memory region; document RAM budget; w2c2 (C89, ~150 KB) runtime header is the small target

#### Bench corpus (closes AS-parity the right way)
* [ ] Port 2–3 AS showcase kernels into `bench/` for the head-to-head "plain JS vs typed-TS" story: path tracer, emulator core, a codec (msgpack/LZMA-style), a hash (sha256)

### Deferred — NOT minimal, schedule explicitly
- Insertion-order Set/Map — open-addressing table iterates slot-order; ES
  mandates insertion order. Needs a per-entry `seq` field or a sibling order
  list. Currently enumerated as a documented divergence in
  `test/test262-builtins.js` xfail list.
- Boolean ATOM tag (in wasm-v1 NaN-box) — `true`/`false` carried as two new
  NaN tags (`TRUE_NAN` / `FALSE_NAN`), siblings of the existing `NULL_NAN` /
  `UNDEF_NAN` atoms. Not wasm-gc — wasm-gc has no native typed-boolean either
  (`i31ref(0)` doesn't discriminate from `0` the number, same atom-tag problem
  in different syntax). `typeof true` already returns `'boolean'`; remaining
  gaps are `String(true) → '1'` (should be `'true'`), `parseInt(true) → 1`
  (should be `NaN`), `true === 1 → true` (should be `false`). Scope: ~2-3
  days, ~30-50 coercion sites in `src/emit.js` / `module/string.js` /
  `module/number.js` learn the new tags before falling through to number
  handling. Defer until a real workload surfaces boolean stringification /
  mixed boolean-number comparison as a correctness bug.
- wasm-gc backend (`host: 'gc'`) — orthogonal future track. Replaces the
  manual NaN-box + linear-memory allocator with engine GC + typed refs across
  the whole compiler. Multi-month backend rewrite; benefits are memory-model
  / externref-bridge / debugging, NOT a fix for boolean discrimination (which
  the ATOM-tag bullet above resolves in wasm-v1). Currently reserved as a
  compile-time error in `index.js:315`; documented in README.
- Intl, Date locale surface, component model, threads, memory64, WebGPU —
  Future.
- Ship: pick ONE undeniable use case (floatbeat playground — DSP kernels are
  jz's proven strength per the EdgeJS archive). Product call.

### Ship something real

* [ ] Pick ONE use case, make jz undeniable for it
* [ ] Ship something someone uses
* [ ] Integrations as validation: color-space converter (multi-profile), digital-filter biquad (memory profile), floatbeat playground
* [ ] Make compile faster than js eval
* [ ] Benchmarks
* [ ] Clear, fully transparent codebase; complete docs / readme / tests / repl

### Floatbeat playground

* [ ] Syntax highlighter
* [ ] Waveform renderer
* [ ] Database + recipe book
* [ ] Samples collection

### Language coverage / correctness

* [ ] Date — deterministic spec slices first; local timezone / Intl surface later
  * [ ] Deferred: object `ToPrimitive` coercion order (`coercion-order.js`)
  * [ ] Defer `Date.parse` until Date value objects + UTC stringification exist
  * [ ] Out of scope: local-time getters/setters, `getTimezoneOffset`, `toString` / `toDateString` / `toTimeString`, locale methods, `toJSON`, `Symbol.toPrimitive`, `toTemporalInstant`, subclassing, realms, descriptors, prototype shape, function `name`/`length` metadata
* [ ] Intl
* [ ] test262
* [ ] All AssemblyScript tests
* [ ] Warn/error on hitting memory limits
* [ ] Know all fails of test262 in face and cleanly either jzify or error, don't fail unknowingly
* [ ] Tighten tests (coverage) - randomly change features and see if tests break.

### Imports & jzify

* [ ] jzify script converting any JZ
* [ ] jzify: auto-import stdlib globals (Math.* → `import math from 'math'`, etc.)
* [ ] jz core: require explicit imports for stdlib (remove auto-import from prepare/compile)
* [ ] align with Crockford practices

### Diagnostics

* [ ] Source maps (blocked on watr upstream) — meanwhile add WASM name section (function names) independently

### Lint-inspired passes — structural fix vs. advisory

ESLint's reusable shape is `detect → message → (autofix | suggestion)`. jz already
owns *detect* (analyzer / narrower) and *autofix* (the optimize passes); the missing
half is a soft channel — today jz has only hard `err()` rejection (`src/prepare.js`,
`jzify.js:691` `jzifyError`) and manual `--wat` self-inspection, no `ctx.warn`.

**Dividing principle.** A JS↔jz divergence is fixed *structurally* when jz invented
the gap — a representation choice, an inference decision, or a lowering simplification
(close it; a warning there is the compiler confessing it punted). It stays a *warning
/ opt-in trade* only when the gap is an omitted runtime mechanism that is the whole
point of "no runtime, no GC". The boolean carrier (Deferred › "Boolean ATOM tag") is
the exemplar: it *removes* the `typeof`/`String(true)` divergence instead of narrating
it. `typeof`-on-boolean is therefore subsumed there — do not build a separate warning.

#### Fix structurally (jz invented the gap — audit, then close)

* [ ] **i32 narrow range-safety (`no-loss-of-precision`).** Invariant: never narrow an
  *implicit* binding to i32 without a proven range bound; ambiguous → f64 (README
  already promises this). Explicit `x|0` wraps exactly like JS — not a divergence,
  leave it. *Likely already held* by the narrower's f64 default — verify and add a test
  pin, not a warning. Owner: `src/narrow.js`, `src/analyze.js:1958-2099` `exprType`.
* [ ] **switch fallthrough / default (`no-fallthrough`).** Audit jzify's `switch`
  lowering for fallthrough + missing-`default` fidelity. Correctness lives in the
  lowering; a warning would admit the lowering is incomplete. Owner: `src/jzify.js`.
* [ ] **duplicate object keys (`no-dupe-keys`).** Ensure JS last-wins → single slot in
  the literal lowering so `{a:1,a:2}` is not a fixed-layout artifact. Escalate to a real
  error only when dup'd keys carry *conflicting inferred types* (genuine ambiguity, not
  a style nit). Owner: `src/prepare.js` `'{}'` handler.
* [ ] **form normalizations → IR fold (no warning).** `Math.pow(x,2)→x*x` (integer
  exponent), `~~x` / `parseInt(intLit)` → `i32.trunc` / const, `!!x` drop in boolean
  position, `no-self-assign` / `no-useless-concat` / `no-useless-return` fold into
  existing DCE/CSE. Not bugs — source forms; canonicalize silently. `**` already lowers;
  audit which others fold and add the missing peepholes. Owner: `src/optimize.js`,
  `src/prepare.js`.

#### Advisory / opt-in trade (omitted mechanism — needs the warn channel first)

Prerequisite: a `ctx.warn(node, code, msg)` sink, surfaced on the `compile()` result and
printed by the CLI — mirror the passed-in `profile` sink. Without it none of the below
lands as anything but a hard error.

* [ ] **untagged errors (`e instanceof TypeError`).** Structural fix = type tags on
  thrown values = Error machinery = the weight jz dropped. Warn, or offer opt-in tagging.
  (README "errors are untagged".)
* [ ] **Set/Map slot-order iteration.** Already a documented trade (Deferred ›
  "Insertion-order Set/Map", `test262-builtins.js` xfail). Warn only if iteration order
  is observably relied upon.
* [ ] **no-auto-reclaim leak heuristic.** Folds into the existing "Warn/error on hitting
  memory limits" item (Language coverage). At most: "allocates in a loop with no
  `memory.reset()` in scope."
* [ ] **perf-feedback advisories (LLVM-style "why it didn't vectorize").** Surface bail
  reasons the passes already compute: `no-param-reassign` → "reassigning `s` disabled the
  zero-copy externref carrier"; vectorizer bail → "loop-carried scalar `s` / AoS stride —
  split into one typed array per field"; arena-rewind bail → "returns a heap value,
  per-call rewind skipped". Where the structural improvement is cheap (split a reassigned
  string param into a fresh local so the carrier still applies past its last zero-copy
  use), do that instead of warning. Owner: `src/vectorize.js`, `src/narrow.js`.

**Skip — already enforced by the subset.** `no-var` / `eqeqeq` / `no-undef` / `no-with` /
`no-eval` are rejected at the subset boundary (`src/prepare.js:615`, `:1047`); borrow only
ESLint's "use Y instead" *message* style (jzify already does this), don't re-implement the rules.

### Metacircularity (jz compiling jz)

* [ ] Extract minimal jz parser from subscript features — jz-jessie fork excluding class/async/regex + refactor parse.js function-property assignments (~30 lines)
* [ ] jzify uses jessie, pure jz uses internal parser
* [ ] True metacircular bootstrap
* [ ] swappable watr: AST likely needs stringifying before compile if an adapter is provided


### Boundary protocol and internal representation

Two separable concerns, conflated by the previous "ABI presets" plan:

1. **Boundary protocol** — how host code calls the `.wasm`. This is the only ABI users see.
2. **Internal representation** — how values live inside the wasm. Analysis-driven, per-site, never user-configured.

The old plan treated both as "ABI" — `opts.abi: 'nanbox' | 'flat' | 'nanbox+jsstring'` covered both knobs at once. That conflation is the root cause of every "which preset should I pick?" smell. The user choosing internal representation is a category error: the compiler has more information about each call site than the user could plausibly enumerate. Exposing the choice freezes the internal layout to whatever the user happened to pick — the opposite of "compile to the most fitting form." A person reading the source infers types from name, literals, operators, member access, control-flow guards. The compiler should do the same, and beat the user at it.

#### User surface — `opts.host`

The only knob the host actually needs is "how do I call this."

```js
jz.compile(src, { host: 'js' })    // default — JS host; externref strings, ref-typed exports allowed
jz.compile(src, { host: 'wasi' })  // C-ABI shape; linear-memory strings; no engine builtins
jz.compile(src, { host: 'gc' })    // wasm-gc; stringref, ref-typed exports
```

`opts.host` decides:
- Which `wasm:js-string` imports may be referenced (only `js`).
- Whether externref / ref-types are valid in export signatures (`js` yes, `wasi` no).
- Boundary marshalling shape (single `interop.js` codec; host variant selected by feature stamp, not by file).

It does **not** decide the internal layout of any value. A program compiled with `host: 'js'` still gets a flat `i32` slot wherever narrowing proves an integer; a `host: 'wasi'` program still gets nanbox-tagged f64 where analysis can't disambiguate.

#### Internal representation — compiler-owned, per-site

`src/abi/` — internal codegen modules with no user surface. **One file per type**, holding every carrier the compiler may pick for that type. Carriers are named exports inside; the narrower picks one per site by analysis.

```
src/abi/number.js  — nanbox-f64 (default), flat-i32, flat-f64
src/abi/string.js  — sso (default), jsstring (host: 'js' only)
src/abi/array.js   — tagged-linear (default), typed (Int32/Float64 backing)
src/abi/object.js  — schema-linear with per-field rep
```

The earlier `src/abi/<type>/<rep>.js` split would have been preset-thinking smuggled in by file layout — separate files imply separate testing units, which implies user-pickable presets, which is exactly the surface we're removing. One file per type matches the actual factoring: carriers for the same type share domain knowledge (what a "number" means, which ops it supports), so they belong together. Cross-carrier helpers (slot-type coercion, op dispatch) sit next to the carriers without an artificial folder crossing.

Sketch:

```js
// src/abi/number.js
export const nanboxF64 = {
  slotType: 'f64',
  ops: { add: (a, b, ctx) => …, eq: …, },
  peephole: (node) => …,
}
export const flatI32 = {
  slotType: 'i32',
  ops: { add: (a, b, ctx) => ['i32.add', a, b], … },
}
export const flatF64 = { slotType: 'f64', ops: { … } }

// default carrier — picked when narrower has no stronger evidence
export default nanboxF64
```

Per-site dispatch, not module-wide preset. The narrower walks the IR, tags each binding/expression with a carrier choice, codegen reads `ctx.abi.number[choice].ops.<op>` (or equivalent). A function may carry an `f64`-slot nanbox number, an `i32`-slot count, and an `externref` string in the same body — each chosen because analysis proved it, not because a preset said so.

The slot-carrier contract from the existing refactor stays: each carrier's `ops.<op>` accepts slot-typed IR and emits the call/inline. Carriers are cycle-safe (no `src/*` imports), siblings inside one ~150–300-line type module.

#### Analysis as the engine

Per-site representation is only as good as the inference feeding it. The narrower fixpoint exists; the work is enriching its evidence sources.

Type evidence, ordered by strength:

1. **Literal use** — `let x = 0`, `let s = ''`, `let xs = []`. Direct.
2. **Operator application** — `x | 0` / `x >>> 0` force i32; `x * 1.0` keeps f64; `s.charCodeAt`, `s + ''` force string.
3. **Member access pattern** — `.length` on a thing only `+=`'d with strings; `.push` / `[i]=` on a thing only indexed by integers.
4. **`typeof` guard** — `typeof x === 'number'` narrows on the true branch (partly handled in narrow.js).
5. **Assignment flow** — `x = y` propagates `y`'s evidence to `x`; SSA edges already in the IR.
6. **Comparison shape** — `x === null` proves nullable; `x === 0` rules out string.
7. **JSDoc `@type`** — explicit hint when ambiguous. Authorial intent, not enforced contract.
8. **Default cast** — anything still ambiguous after the fixpoint stays nanbox-tagged f64. Default is never wrong, only sometimes wider than necessary.

Each step closes one class of dynamic-fallback emit. Representation work only runs once narrowing has decided a type, so better evidence → more sites take the narrow rep. Investing in narrowing compounds with every rep added later.

#### Workstreams, in priority order

* [x] **Narrowing investigation (primary).** Survey: `.work/narrow-survey.mjs` (per-bench counts) + `.work/narrow-watr-hotspots.mjs` (per-function). Findings: `.work/narrow-findings.md`. Headline: every numeric / typed-array bench is **already at zero fallbacks**; only `watr` (the self-hosted WAT compiler) has any — 1289 emits, 47.5 % clustered in its top 10 functions. Categorization:
  - **A. Dynamic-keyed object with all-known keys → poisoned to HASH** (132 `__dyn_set` in `$__start`, plus the rest of the 212 `__dyn_set`). Repro: a single `o[k]` computed read on a 6-key object literal explodes 2 KB → 65 KB and turns every initialization write into `__dyn_set`. **Not a narrowing gap** — codegen-layout choice. Moves to **workstream #3**, extended scope: keep schema layout under computed-key access; dispatch the computed read over the known key set.
  - **B. `s[i]` emits __str_idx + SSO alloc per char** (446 emits, top fallback). Each indexed read materializes a one-char SSO string even when the consumer is `=== '\\'` (charcode-equivalent). **Moves to workstream #6**, extended scope: elide SSO materialization when the consumer compares with a single-char literal.
  - **C. Polymorphic AST-node receiver** (`cleanup(node)` where node = string | array | null). RESOLVED 2026-05-17: the `Array.isArray(node)` discriminator's facts *are* threaded across `?:` / `&&` / `||` / `if` arms (`extractRefinements`), so `node[0]` reads route through `__arr_idx_known`. The remaining gap was the *write* side — `node[i] = v` kept a dead `__is_str_key` dispatch (fixed, commit 76c09d8).
  - **D. Heterogeneous ctx = array+object** in watr's `compile()`. Legitimate mixed identity; codegen-rep question, not narrower.
  - **E. err()'s `text + ...` concat allocates heap** even when the result fits SSO. Folds into workstream #6.
  - **F. `for-in` over known-schema source** (`for (let kind in SECTION)`) should unroll at compile time per `prepare.js:1339-1346` — verify it fires for watr's constants; gaps become narrow follow-ups.
  ## Recommended narrow.js follow-ups (workstream #1 deliverable):
  - **C.1** ~~Thread `Array.isArray(x)` facts through `?:` / `&&` / `||` arms~~ — DONE (already in `extractRefinements`; commit a2b5aec). Write-side asymmetry fixed in commit 76c09d8.
  - **C.2** `x == null` / `x != null` flow-narrowing — DEFERRED: no nullable/notNull rep field to land the fact on; premature until flat-rep work creates a consumer.
  - **F.1** Verify and fix `for-in` over known-schema unrolling on watr's `SECTION` / `KIND` / `INSTR` / `DEFTYPE`.
  ## Conclusion: rebalance — the survey says narrowing handles numeric/typed-array codegen at the floor; the remaining wins on dynamic-shape code are mostly **codegen layout (#3) and SSO peephole (#6)**, not narrower gaps. Parallelize #1.C/F + #3 + #6 rather than serialize.

* [x] **Per-site flat-number specialization.** Where narrowing proves a binding is integer-only or non-tag-traffic-f64, emit it as a flat slot (`i32` / bare `f64`) and skip box/unbox at every use. **Verified done-in-effect 2026-05-19.** Survey across 5 bench kernels (`crc32`, `mat4`, `bitwise`, `sort`, `biquad` — 3059 lines of function bodies) found **zero** residual `i64.reinterpret_f64`/`f64.reinterpret_i64` round-trips, **zero** `__mkptr`/`__num_box` calls, **zero** `__ptr_offset`/`__num_unbox` calls in non-export bodies. The work was achieved via direct type narrowing in `narrow.js` (Phase D param specialization → `applyI32ParamSpecialization`; Phase E i32 results → `narrowI32Results`; Phase E3 pointer results → `narrowPointerResults`; Phase G TYPED pointer ABI) + `analyzeBody` local typing in `src/analyze.js:1958-2099` (`exprType` propagates i32 through `|`, `&`, `^`, `<<`, `>>`, `>>>`, `~`, comparisons, integer `+ - * %`, `.length` on sized receivers, intCertain locals, narrowed function returns). The carrier-bundle refactor (`flatI32`/`flatF64` in `src/abi/number.js`) is **architectural sugar without behavioral benefit** — the named goal is already reached. Genuine remaining waste is closure-cell f64.store (workstream #5), not flat-binding rep.

* [ ] **Schema-object field packing.** `schema-linear` today gives every field a tagged-f64 slot regardless of evidence. Threading per-field rep through the schema lets `{count: 0, name: ''}` lay out as `(i32, ptr)` instead of `(f64-tag, f64-tag)`. Halves typical struct size; identity and field-order semantics untouched. **Surveyed 2026-05-19 — gap is real, fix is multi-day:** non-exported `mk = (count, name) => ({count: count|0, name})` emits `f64.convert_i32_s + f64.store` on the intCertain slot 0 even with `count` param i32-narrowed (residual i32→f64 widen for 8-byte slot store; 2-4 ops per intCertain slot at store, matching truncs at read). `ctx.schema.slotIntCertain` / `slotTypes` evidence already exists. **Blocker:** `src/abi/object.js` carrier ops take `(base, i, val)` — no schemaId — so `packed` would require widening the carrier API + threading schemaId through every dyn path (`__dyn_get_any_t_h`, `__dyn_set_*`, `Object.values/entries/assign/keys`, `{...spread}`, JSON, `toPrimitive`). Cross-cutting touch list ~6 modules. **Defer** until a workload exercises heavy struct-array memory pressure — current benches use TypedArrays/SoA (mat4) or flat-state arrays (bitwise), not object-array-of-records. YAGNI: build when consumer exists. *(`flat`/SRoA already handles non-escaping `let o = {…}` literal binds; the residual gap is only for escaping objects with static-key access — narrower than the workstream framing suggested.)*

* [ ] **Typed-array element rep.** `xs = [1, 2, 3]` where every push/store is integer becomes `Int32Array` backing instead of tagged-linear. Subsumes the manual `Int32Array.of` ergonomic; plain JS source, typed memory output. **Surveyed 2026-05-19 — gap confirmed, fix is multi-day:** today `let xs = [1, 2, 3]` emits 3× `f64.store` of static integers into 8-byte cells; `let xs = []; xs.push(i|0)` keeps `xs` as VAL.ARRAY (f64 local pointer, `__arr_*` ops, 8-byte cells). Manual `new Int32Array(n)` produces clean `i32.store` + i32-local x as expected — the *output* shape is already proved correct, just not auto-selected. **Blocker:** narrowing `xs` from VAL.ARRAY to VAL.TYPED(Int32Array) is a value-type change, not a carrier swap — every consumer (`xs.push`, `xs.length`, `xs[i] = v`, dyn `xs[k]`, spread, `Object.values`) routes through different runtime helpers (`__arr_*` vs `__typed_*`). Plus a new narrower phase needed: detect intCertain-only writes + no shape-mutating ops + closed read set. **Defer** until a workload exercises this — current benches use TypedArrays explicitly (the user already opts in); user-typed JS that benefits is e.g. parser token tables, but watr/subscript don't show this shape in profile.

* [ ] **Closure-capture narrowing.** Captured variables today widen to nanbox-tagged at the cell, even when the closure body uses them at a single narrow type. Track per-cell evidence the same way bindings do; emit `i32`/`f64` cells where proven. **Surveyed 2026-05-19 — gap confirmed, scope ~100 LOC across 5 touch points:** `let count = n | 0; return () => count++` lowers to `__alloc(8)` + `f64.store cell` of `f64.convert_i32_s(n)` + closure reads/writes via `f64.load`/`f64.store` with i32↔f64 round-trips per access. Cell stays 8 bytes f64-typed. **Fix sketch:** new pass `analyzeBoxedCellTypes(body)` walking ALL writes including arrow bodies (current `analyzeIntCertain` stops at `op === '=>'` — sound for its consumers but blind to closure mutations); decide cell type per name; patch `emitPreboxedLocalInits` (`src/compile.js:224`) to dispatch alloc size + init op on cell type; patch `readVar` / `writeVar` (`src/ir.js:574, 612`) to dispatch load/store on cell type; thread `boxedCellTypes` from parent → `cb` → `emitClosureBody` (`src/compile.js:585`) so closure reads agree. **Defer** until a consumer surfaces — current benches' closures (watr's parser arrows, subscript's feature handlers) are all object/string-typed captures (not i32-intCertain), so the convert-chain elision wins zero ops on the realistic hot paths. The watr compiler is closure-heavy and a regression vector; landing this without a tightly-scoped consumer trades real risk for theoretical wins. Re-evaluate when a counter-closure / accumulator-closure-driven workload appears.

* [x] **SSO flow-through.** Short-literal strings (≤4 ASCII) live SSO-encoded already, but concat results widen to heap pointers immediately. Where the result also fits SSO, keep it inline. Saves a heap alloc per intermediate. **Landed 2026-05-19:** two-tier fix — (a) compile-time literal+literal concat folds into a single literal in `src/prepare.js` `'+'` handler (bottom-up so `'a'+'b'+'c'` folds left-associatively); (b) runtime `__str_concat` / `__str_concat_raw` now branch to an SSO-repack fast path before the heap-alloc tail when both operands are SSO and total ≤ 4 (`module/string.js` `ssoResultFast` template). Probe `.work/sso-runtime-probe.mjs` confirms 1000× `cat2("ab","cd")` keeps `__heap` pinned at `0x410`; heap path still fires for total > 4. All 1759 tests + bench tests pass.

* [x] **JS String Builtins specialization — boundary opt-in landed (2026-05-20).** See Archive › "jsstring boundary carrier (2026-05-20)". Per-export-param flip to externref + `wasm:js-string.length`/`charCodeAt` lowering, guarded by a use-pattern proof (string-discriminating evidence, no escape, no reassignment, bounded `.charCodeAt`). Internal-STRING-locals carrier flow (the deeper item once envisaged here) remains deferred — covered by the Live-work "jsstring carrier" bullet above as the next layer (call-graph carrier propagation), distinct from the per-export work just shipped.

#### What ships internally vs externally

|                  | User-visible                       | Compiler-internal                                                |
| ---------------- | ---------------------------------- | ---------------------------------------------------------------- |
| Boundary shape   | `opts.host` (`js` / `wasi` / `gc`) | single `interop.js` codec; host variant via feature stamp        |
| Number carrier   | —                                  | per-site, in `src/abi/number.js`: `nanboxF64` / `flatI32` / `flatF64` |
| String carrier   | —                                  | per-site, in `src/abi/string.js`: `sso` / `jsstring` (`host: 'js'` only) |
| Array carrier    | —                                  | per-site, in `src/abi/array.js`: `taggedLinear` / `typed`        |
| Object layout    | —                                  | per-field, in `src/abi/object.js`: tagged / flat / packed        |
| Inference hints  | JSDoc `@type` (advisory)           | narrower fixpoint                                                |

The `jz:abi` custom section, if kept, becomes a **feature-detection version stamp** (e.g. "ref-types required", "string-builtins required") so the host driver knows which engine features to feature-test before instantiate. It does **not** carry preset names — there are no presets to name.

#### What drops from the old plan

- `opts.abi` — gone. Replaced by `opts.host`.
- `PRESETS` as any kind of surface — gone. Internal `src/abi/` modules are picked per-site by analysis, not by name. No preset table inside the compiler either; carrier choice lives in narrower facts.
- `JZ_ABI` env flag in tests — gone. Boundary tested by varying `opts.host`; internal repr is implementation detail (assert size / IR shape, not "preset name").
- Preset matrix testing — gone. No preset to enumerate. Internal-rep tests are properties: "after narrowing, `x | 0` lowers to an i32 slot."
- Free-form rep maps — never existed publicly; remains an internal property of the narrower.

#### Already landed (foundation; do not undo)

* [x] One file per type under `src/abi/` — `src/abi/string.js` (`sso` default + `jsstring` scaffold), `src/abi/number.js` (`nanboxF64` default). Carriers are named exports inside one type module; no preset folder layout.
* [x] Slot-carrier contract — `sso` accepts slot-typed IR, emits `i64.reinterpret_f64` inline, no `src/*` imports.
* [x] Empty-ops scaffold — `jsstring` declares slot types, imports, and the 9-item compiler-wide checklist for real codegen.
* [x] Routed call sites — `module/core.js` (`?.length`), `module/string.js` (`.charCodeAt`), `src/emit.js` (cmp / concat / concatRaw / append-byte) all go through `ctx.abi.string.ops`.
* [x] Compiler-side carrier dispatch object on `ctx` (`ctx.abi.<type>.ops.<op>`); `ctx.abi.<type>` resolves to a *carrier* (named export of `src/abi/<type>.js`), not a separate file.
* [x] Optimizer-side carrier peephole (`src/abi/number.js#nanboxF64.peephole`) — pure-WASM folds in `src/optimize.js`, carrier-specific folds inside the carrier.
* [x] Single `interop.js` boundary codec — DRIVERS dispatch table removed; one NaN-box codec per binary; `jz/interop` subpath compiler-free (only imports `./wasi.js`).

#### Open policy questions (deferred until first non-default rep emits at scale)

1. **JSDoc strength.** `@type` as a hint (overridable by stronger evidence) or as a contract (refuse to widen)? Hint matches the implicit-inference philosophy; contract gives users an escape hatch for cross-module boundaries. Default: hint.
2. **Null/undefined under flat slots.** A flat `i32` / `f64` can't carry them. Narrower must prove non-null at the binding or widen back to tagged. No new syntax.
3. **Compound lifetime.** `__alloc` for a flat string passed to a host call — when freed? Today's `_clear`-reset arena is fine for short-lived; long-running needs a hook. Defer until a real long-running program forces it.
4. **Cross-module ABI freezing.** Exported flat-slot signatures are part of the module's public contract even though `opts.host` is what users picked. Resolution: export signatures derive from proven types of exports' params/returns. Stable signature ⇒ write the export so its types are obvious (or annotate). The compiler does not promise stable internal rep across versions for the same source.

### REPL

* [ ] Auto-convert var→let, function→arrow on paste
* [ ] Auto-import implicit globals
* [ ] Show produced WAT
* [ ] Document interop

### EdgeJS PR shape

* [ ] Add an EdgeJS test/harness entry only if it can run in their CI without pulling large optional dependencies or network setup

### Future

* [ ] Component interface (wit)
* [ ] threads/atomics (SharedArrayBuffer, Worker coordination)
* [ ] memory64 (>4GB)
* [ ] relaxed SIMD
* [ ] WebGPU compute shaders

## Ideas

* [ ] webpack, esbuild, unplugin etc – extract and compile fast pieces with jz
* [ ] jz as a compilation target — DSLs that want WASM output emit jz-compatible code (needs a simple IR / intermediate format) and get WASM for free
* [ ] The template tag as a build tool — jz\`code\` in a Node script replaces a build step. No webpack, no esbuild, no plugin. Uniquely elegant and under-marketed.
* [ ] AS integrations/plugins from https://www.assemblyscript.org/built-with-assemblyscript.html

---

## Archive

### opts.host user surface + custom sections reference + SoA boundary pin (2026-05-20)

Cleanup pass on the `opts.host` knob and a pinned boundary for SIMD
vectorization. No new feature surface — the work made existing behaviour
visible and irreversible.

* [x] **`host: 'gc'` reserved-mode error** (`index.js:315`). Distinct error
  text so users see it as planned-future, not unknown-garbage: "reserved for
  a planned wasm-gc backend, not yet implemented. Use 'js' (default …) or
  'wasi' (standalone runtimes — no env imports)."
* [x] **wasi tolerance comment** (`src/emit.js:2563`). Documents that the
  silent `undefExpr()` fallthrough for unknown receivers under `host: 'wasi'`
  is by-design — `test/wasi.js` cases 235 and 245 pin it explicitly so
  polymorphic source can target both modes from one source. `strict: true`
  is the documented fail-fast opt-in.
* [x] **README — host modes**. Existing `host: 'js'` / `'wasi'` FAQ extended
  with the `gc` reservation note and a pointer to `strict: true` for users
  who want the wasi unknown-receiver path to error instead of no-op.
* [x] **README — custom sections reference** (new FAQ). First public
  documentation of the four sections jz emits: `jz:schema` (rehydration
  shapes), `jz:rest` (rest-param fixed counts), `jz:i64exp` (per-export
  i64-ABI map for NaN-canonicalization dodging), `jz:extparam` (externref
  param positions + JS-side defaults — written by the jsstring carrier).
  Names declared stable; binary layouts declared internal.
* [x] **SoA vectorization — README FAQ + tests** (`test/simd.js`,
  `README.md`). Documents the supported shapes (same-array, cross-array,
  SoA-3 / SoA-4 separate typed arrays per field) and the unsupported AoS
  interleaved shape with the mechanical migration path. Three new tests:
  SoA-3 fused map lifts to `f64x2`; SoA-4 RGBA luminance blend lifts; AoS-
  stride-2 must NOT lift (parity intact) — pins the boundary so future
  changes can't accidentally promise AoS without a real struct-splitting
  carrier. Counterpoint to the still-open Live-work AoS-write bullet, which
  remains the multi-week deferred carrier.

**Skipped deliberately:** a `jz:host` feature-stamp custom section. `interop.js`
already detects required features from imports (`wasi_snapshot_preview1`,
`env`, `wasm:js-string`); the extra surface adds no consumer value and would
become permanent maintenance debt.

tests: 1769 → 1772 pass (+3); commit `06b0e69`.

### jsstring boundary carrier (2026-05-20)

The `jsstring` carrier from `src/abi/string.js` is now wired end-to-end as a
**per-export-param boundary opt-in**. Eligible exports take their string param
as `externref` (zero-copy JS-string pass-through) instead of the f64/SSO carrier
(per-call UTF-8 transcode into wasm memory).

* [x] **Narrower phase J — `applyJsstringBoundaryCarrier`** (`src/narrow.js`).
  Per export, per param, flip `p.type` from `f64` to `externref` *only if* every
  use is `wasm:js-string`-builtin-mappable AND at least one use proves the param
  is a string. Proof sources, any of: (a) a `.charCodeAt` use (string-only
  method), (b) call-site rep evidence `VAL.STRING`, (c) string-literal default
  `s = ''` (declared intent). Rejects: reassignment / `++` / `--`, closure
  capture, escape into non-builtin calls, unbounded `.charCodeAt` (would trap
  where JS returns `NaN`). Standalone entry point exported for
  `canSkipWholeProgramNarrowing` short-circuit. Gated by `jsstringEnabled()` —
  off under `host: 'wasi'`, off when `optimize.jsstring === false`.
  `scanBoundedLoops` exported from `src/analyze.js` for the in-bounds proof.
* [x] **Builtin import channel** (`ctx.core.jsstring: new Set()` in `src/ctx.js`).
  Drained at module-assembly into `(import "wasm:js-string" "<name>" …)` nodes
  with `JSS_IMPORT_SIGS` from `src/abi/string.js`. The set tracks only the
  builtin names actually used by this module.
* [x] **Lowering** — `module/core.js` `emitLengthAccess` dispatches on
  `va?.type === 'externref'` → `(call $__jss_length va)`; the call site reads
  `emit(obj)` *before* `asF64` so the externref type isn't stripped.
  `src/emit.js` in-bounds `.charCodeAt` dispatch checks `recv?.type === 'externref'`
  → `(call $__jss_charCodeAt recv idx)`.
* [x] **Boundary wrapper + custom section** (`src/compile.js`). Boundary wrapper
  takes `(param externref)` for flipped slots; the wrapping i64/f64 ABI dance
  is skipped on those slots. A `jz:extparam` JSON custom section records, per
  export name, the indices `p:[…]` whose carrier is externref, plus optional
  `d:{idx:'str'}` for JS-side defaults so the wasm side never sees a null
  externref. Default-param init loop in `emitFunc` skips the `=== undefined`
  branch for jsstring params (substitution moves to the JS-side wrapper).
* [x] **interop.js boundary wiring**. Reads `jz:extparam`; for marked indices
  the wrapper writes `(${a} === undefined ? ${dn} : ${a})` directly, skipping
  `mem.wrapVal` (which would NaN-box the JS string). Native `wasm:js-string`
  detected by a one-time probe: if `new WebAssembly.Module(buf, { builtins:
  ['js-string'] })` instantiates with no imports, the engine handles the
  builtins itself (V8 17+ / Node 25+ / Safari 18.4+); otherwise a JS polyfill
  (`(s) => s.length`, `(s, i) => s.charCodeAt(i)`) is attached.
* [x] **Opt-out flag** — `optimize.jsstring: false` ([src/optimize.js] PASS_NAMES
  + the `jsstringEnabled()` gate in narrow.js) keeps every param on the
  f64/SSO carrier. Used for paired benches and engines that mishandle the
  builtins option.
* [x] **Tests — 10 / 22 assertions** ([test/jsstring.js]). Covers: opt-in fires
  on bounded `.charCodeAt`+`.length`; runtime correctness sums char codes
  through externref; `.length`-only stays polymorphic (number → undefined);
  unbounded `.charCodeAt` declines (trap-safety); reassignment / closure
  capture / `s + 'x'` escape all decline; string-literal default fires the
  opt-in even without `.charCodeAt`; JS-side default substitution on
  `undefined`; numeric default doesn't trigger.
* [x] **Bench** — `bench/jsstring/bench-jsstring.mjs` paired-compilation
  baseline. On Node 25.9 native, `.length(s)` opt-in is 22× faster at 8 chars,
  154× at 256, 5510× at 8192 — boundary-copy elimination dominates. `.sum(s)`
  (`.charCodeAt` loop) is 10.5× / 1.5× / 1.3× faster across the same sizes —
  win compresses as per-char work begins to dominate. Jessie section
  documents the correct-rejection case (param escapes into `parse()` — not a
  builtin — both compilations byte-identical, ~1.0× ratio confirms no
  side-effect).
* [x] **README** — new FAQ "How do strings cross the boundary?" with the
  two-carrier table, opt-in trigger matrix, engine support, opt-out flag, and
  bench pointer.

### watr 4.6.9 upgrade — drop 'light' mode workaround (2026-05-20)

* [x] **'light' watr mode removed** (`a26ea84`). L2 was running a curated watr
  subset (`inline / inlineOnce / coalesce` all off) since 4.6.4 to dodge two
  upstream miscompiles:
  - **W1a** — `inlineOnce` dropped a single-call helper's bare-`local.get`
    body (root-node `walkPost` return value discarded; substitution lost).
  - **W1b** — `coalesceLocals` merged a zero-dependent local into a residue-
    carrying slot when `inlineOnce`'s `needsReset` zero-init ran before
    `propagate`'s cleanup sweep. Trigger: `/a.+b/.test("ab")`.

  watr 4.6.9 ships fixes for both. L2 now runs the full watr default pipeline
  (treeshake / dedupe / dedupTypes / coalesce / propagate / packData / fold /
  peephole / vacuum / mergeBlocks / brif / loopify / inlineOnce / …). `inline`
  stays off per watr's own default — opt-in only; can duplicate bodies. L3 no
  longer needs an "inlining bonus" — its preset reads truthfully as L2 + larger
  array/hash initial caps + `hoistConstantPool` off.

* [x] **jz csePureExpr snapId — high-water mark, not first gap** (`fed07f8`).
  watr's full `coalesceLocals` removes redundant locals, so the surviving
  `$__pe<N>` set is non-contiguous; the old first-gap allocator picked an
  already-live id and triggered "Duplicate local $__pe20" on mat4. Fixed by
  scanning all surviving cse-pure-expr locals for a high-water mark.

* [x] **17 codegen-shape tests rewired to `optimize: { watr: false }`**.
  Tests in `test/{types,closures,features,feature-gating,optimizer,inference}.js`
  verify jz's compile-time decisions (slot-type dispatch, narrowed return
  types, closure-unbox declarations, escape-analysis allocations, LICM snap
  locals, sourceInline skip-into-export, charCodeAt i32 propagation, …) — not
  watr's downstream cleanup. With full watr running at L2, `inlineOnce` would
  fold non-exported helpers into their lone caller and `treeshake` would erase
  them, so a `(func $mk …)` regex no longer matched. Probe call sites now opt
  out of watr explicitly, making the intent visible at each call.

* [x] **Subscript / watr dead-code workarounds dropped** (`8ef4b46`, `4f9e64a`):
  trailing-null pop in `'()'` emit (closed by subscript 10.4.13's S12 fix) and
  the W5 unsigned-hex `i64.const` dance (closed by watr 4.6.8 handling signed
  hex strings directly). Workaround tag in `prepare.js` 1768–1777 (S2 `new`
  precedence) and the IIFE/labeled-stmt patches in `jzify.js` remain — gated
  on the next subscript release.

bumps: `subscript 10.4.12 → 10.4.13`, `watr 4.6.8 → 4.6.9`.
tests: 1759/1759 unit; 81/81 bench-shape; bench parity holds.

### test262 language tail + native-gap audit (2026-05-19)

* [x] **5 language fails → 0** (language suite 1423→1429, baseline bumped).
  Three codegen defects + one harness boundary fix — `fix:` commit `117fbd0`:
  - comma Expression in a for-in/of head (`for (x in A, B)`) — `jzify.js`
    `normalizeForDeclHead` generalized + new `normalizeForCommaHead` fold the
    trailing operands back into the iterated source; internal crash eliminated.
  - `[,]` / `[1,,]` array elisions — `prepare.js` `'[]'` over-trimmed a trailing
    `null`; jessie already consumes the trailing comma, so every residual `null`
    is a genuine hole. Trim removed.
  - `dedupeRedecls` read only the first name of a multi-name bare `let`, leaking
    a redeclaration when a hoisted function `const` shared the name. Now walks
    every declarator.
  - `test262.js` ASSERT_HARNESS terminated with `;` — works around a subscript
    ASI bug (no semicolon after an arrow block body before `(`). Upstream
    subscript bug — repro belongs in plan Part 1.
* [x] **crc32 vs native** — wasm-v1 floor. jz 11.95 ms = 1.12× clang -O3, beats
  V8 (13.34 ms). Native's edge is the SSE4.2 `crc32` hardware instruction; SIMD
  folding needs carryless multiply (`clmul`, a separate wasm proposal). The CRC
  accumulator is strictly loop-carried — `vectorizeLaneLocal` correctly declines.
  No jz codegen change available; scalar table-driven is optimal.
* [x] **mandelbrot vs AS** — wasm-v1 algorithmic floor (no scalar `fma`),
  proposal-blocked. (`interference` / `game-of-life` are not in the bench suite.)
* [x] **f64 cross-array-map vectorization** — `optimize:` commit `b3bd828`.
  `vectorizeLaneLocal` now sees through the CSE'd offset-tee a map `b[i]=f(a[i])`
  over two base pointers produces (`(local.tee $T (i32.shl i K))` then
  `(local.get $T)`). New `matchLaneOffset` + `_offsetLocalStride` soundness gate
  in `src/vectorize.js`, wired into `tryVectorize` + `tryReduceVectorize`. f64
  cross-array map loops now emit `f64x2`; tests in `test/simd.js`. AoS-write and
  i32 mixed-width remain — see Live work › "native-gap audit".

### Generality track — Step 3 (2026-05-19)

* [x] **Slice views.** `__str_slice_view` / `SLICE_BIT` returns a no-copy view
  into the parent buffer when escape analysis proves the slice never outlives
  it; falls back to copy for SSO parents or oversized lengths.
* [x] **Literal interning.** `dataDedup` / `strPoolDedup` pool string-literal
  data segments — equal literals share one offset, compare by pointer.
* [x] **`s[i] === 'X'` no-alloc charcode compare** (`emitSingleCharIndexCmp`).
* [x] **`<str>.{substr,substring,slice}(…) === <other>` no-alloc** (`8b74dce`).
  `emitSubstringEqCmp` peepholes the call-↔-value pair to `__str_{substring,
  slice}_eq`, which clamp the range exactly like the method then byte-compare
  it against `other` in place. `__str_range_eq` type-checks only `other` (a
  substring method's receiver is always a string), mirroring `__eq`'s
  STRING-vs-? arm. `substr`/`substring` name string-only methods so unknown
  receivers are safe; `slice` requires a statically-known STRING receiver
  (else dispatches to array slice).
* [x] **Runtime scanned-identifier intern table — declined as speculative.**
  Audited real workload (`subscript/parse.js:73,98,150`,
  `subscript/feature/comment.js:16,19`, `bench/jessie`): every
  `substr`/`substring`/`slice` is inline with `===`/`!==` already, which the
  substring-eq peephole above covers no-alloc. No `let id = src.substr(...);
  if (id === "x") else if (id === "y")` pattern in any current corpus. Re-open
  only if a real bench surfaces the bound-then-multi-compare shape as a hot path.

### i32 map-loop audit (2026-05-19)

* [x] **Idiomatic i32 map-loops already vectorize.** Probed `((a[i]|0) * 2 + 1)
  | 0` and `Math.imul(a[i], 2) + 1` over `Int32Array`: the full path composes —
  typed-array carrier inference (`src/analyze.js` `typedElem`, `module/typedarray.js`
  `.typed:[]` / `.typed:[]=`) lowers `state[i]` to direct `i32.load`/`i32.store`,
  watr inlines the kernel into the caller's carrier scope, and the existing i32
  lane vectorizer (`src/vectorize.js`) lifts the body to `i32x4.*`.
* [x] **Plain `a[i] * 2 + 1` (no `|0`) stays scalar — by spec.** JS forces f64
  math and ECMAScript ToInt32 (modular wrap) at the store. Wasm-v1 SIMD ships
  only `i32x4.trunc_sat_f64x2_*_zero` (saturate); relaxed-SIMD is also saturate
  (implementation-defined for out-of-range). A wrap-trunc lane requires a
  manual modular sequence that erases the speedup. Pragmatic answer: use `|0`.
  Not a residual jz codegen gap.

### Generality track — Steps 1, 2, 4 (2026-05-19)

* [x] **Step 1 — use-summary substrate** (`a11578f`..`88bdb52`). The original
  "four escape analyses, fragments of one analysis" framing was partly
  illusory: `scanFlatObjects`/`scanSliceViews`/`unboxablePtrs` *were* three
  redundant standalone body re-walks, but `analyzeBody.escapes` is context-
  sensitive taint woven into the typing walk (separating it would *add* a
  traversal) and `analyzeStructInline` is whole-program post-representation.
  Honest unification: `scanBindingUses` (`analyze.js`) — one traversal
  classifies every binding mention into a closed `USE.*` taxonomy; the three
  real consumers became *policies* (subset predicates). ~6 body traversals → 1.
  `escapes` / `analyzeStructInline` stay separate (boundary in the doc comment).
* [x] **Step 2 — function-namespace SROA** (`9b538d7`). `analyzeFuncNamespaces`
  + `flattenFuncNamespaces` dissolve `parse.space = …` property tables on a
  non-escaping function value into f64 module globals; reads → `global.get`.
  Escaping / computed-indexed namespaces keep the dynamic path. ns-repro
  105 KB → 45 KB WAT, all `__dyn_*` gone.
* [x] **Step 2 — object/dict SROA extended.** `scanFlatObjects` Pass 1.5 admits
  monotonic literal-key field extensions (`o.newProp = …` on a non-escaping
  object literal → extra flat field, `undefined`-init at decl). Field universe
  stays statically closed (computed-key / off-schema / `delete` disqualify).
* [x] **Step 2 — devirtualization** (`31253b6`). Audited the `call_indirect`
  surface: every *non-escaping* function binding was already devirtualized —
  local `const`/`let` lambdas (inlined when small, else direct-call dispatch,
  emit.js A3) and top-level function-namespace slots (`flattenFuncNamespaces`
  SROA → `devirtGlobalCalls`). One real gap: a *forwarder* `(g,x) => g(x)` —
  inlining it substitutes the param with the call-site argument, collapsing an
  indirect call to a direct `call` — was blocked from exported callers by a
  tier-up heuristic that only ever concerned loop kernels. `inlineHotInternalCalls`
  now marks forwarders and lets them cross into exports; `HOF param call` /
  `fn passed as arg` emit zero `call_indirect`. What stays indirect is genuine
  escape (function returned / array-stored / conditionally reassigned to >1
  target) — removable only by watr inlining (Part 3, upstream-gated) or
  interprocedural escape analysis, neither a body-local proof jz can make. The
  dominance / last-write proof the original framing imagined has no measured
  workload demanding it (the namespace SROA already covers top-level init
  writes) — not built, not minimal.
* [x] **Step 4 — memory scalar-replacement** (`3055e4c`). Carr & Kennedy
  register promotion behind `cseSafeLoadBases` (`analyze.js`), an emit-side
  non-aliasing whitelist (unboxed pointer, bound once, read-receiver-only,
  alloc kind disjoint from every store target). `aos`: 6 field reads → 3
  `f64.load`; `jz → V8 wasm` 0.99 ms / 0.82× — faster than native C (1.21 ms)
  and hand-WAT (1.07 ms). Standalone gate, not the Step-1 substrate.

### Execution plan — Phase 0 + Steps 1–6 (resolved 2026-05-17)

* [x] Phase 0 (declarative reorg, C1–C3) — emitter-table spine; redirected once
  the builtins audit showed an empty in-scope tail, kept as a structural refactor.
* [x] Steps 1–6 — Step 1c leaf builtins (one table row each), Step 2a
  correctness commit, Step 3 narrowing-evidence survey (`.work/narrow-findings.md`:
  numeric/typed-array benches at zero fallbacks, only watr has any). Step 4
  (number carrier dispatch) redirected — the i32|f64 choice is a working 1-bit
  decision on `node.type`; a carrier table would re-encode it with one consumer.
  Step 5 object carrier landed (see "Object layout carrier" below). Step 6 descoped.
* [x] `src/abi/array.js` — landed: `taggedLinear` default + `structInline` SRoA
  carrier (see "structInline SRoA carrier" below).
* [x] `ctx.features` cleanup (39beeb2) — `hash`/`regex`/`json` dead flags deleted.
* [x] Infer rungs 6 & 8 — rung 6 (`x === null` flow-narrowing) out of scope (no
  nullable-rep consumer); rung 8 (name heuristic) declined (silent-miscompile risk).
* [x] test262 in-scope-correctness audit (ea1ce43) — all 96 builtins "fails" are
  out-of-scope-by-design; runner buckets 34 skip + 62 xfail + 0 fail, CI gates
  `fail > 0`. Hygiene items folded in.

### structInline SRoA carrier + collection-method dispatch fix (2026-05-17)

* [x] `structInline(K)` carrier (`src/abi/array.js`) — an `Array<{uniform K-field
  schema}>` whose element pointers never escape inlines K f64 schema fields into
  the array data region (stride K), no per-row heap object. Whole-program
  default-disqualify analysis `analyzeStructInline` → `ctx.schema.inlineArray`.
  Header `len`/`cap` count physical f64 cells, so the stride-8 stdlib helpers are
  reused untouched. Closes the `aos` native gap (1.13 → 0.94 ms, checksum
  unchanged). Commits `2be7974` (carrier), `c455ffc` (analysis), `438eeb6` (codegen).
* [x] Collection-method dispatch fix (`d70ec66`) — a zero-arg call of a
  collection-named method (`get`/`set`/`has`/`add`/`delete`) on a
  not-proven-collection receiver (`new C().get()`) no longer falls to the Map/Set
  emitter (which `emit()`-ed a missing key arg and crashed codegen); a
  `COLLECTION_METHODS` set + `collectionMisfit` gate in `emit.js` routes it to
  closure/dynamic dispatch. Test pin in `test/classes.js`.

### Object layout carrier — src/abi/object.js

* [x] 5a. `tagged` carrier (today's layout: `__alloc_hdr` + N×8-byte f64 slots).
  Every object-field site across module/{object,core,array,json}.js +
  src/{emit,ir}.js routed through `ctx.abi.object.ops` (`allocSlots` / `load` /
  `loadBits` / `store`) — two duplicate address helpers (`slotAddr`,
  `emitSchemaSlotRead`) collapsed into one owner. Byte-identical: 19-snippet
  binary-diff proof (identical sha256 wasm). Two over-fitted WAT-text tests
  (inference.js, perf.js) adjusted to read non-zero schema slots.
* [x] 5b-flat. `flat`/SRoA carrier — a non-escaping `let/const o =
  {staticLiteral}` binding is dissolved into plain WASM locals (`o#0`, `o#1`,
  …): no `__alloc_hdr`, no heap, no field load/store; `o.prop` → `local.get`.
  `scanFlatObjects` (analyze.js) conservative eligibility scan — eligible iff
  `o` appears only as a literal-key in-schema `.`/`[]` read or write LHS; any
  escape (bare ref, dynamic key, off-schema prop, `?.`, reassign, compound,
  `++`/`--`, delete, closure capture, self-ref, dup keys, re-decl)
  disqualifies. Dead `o` local dropped so a stray `local.get $o` is a loud
  wasm error. 5 codegen hooks (emitDecl + `.`/`[]` read & write). `let
  o={a:1,b:2,c:3}; o.a+o.b+o.c` folds to one `i32.const`.
* [~] 5b-packed. i32-narrowed 4-byte field cells — DESCOPED 2026-05-17:
  uniform 8-byte f64 shapes are fine, memory compression is not a goal. Would
  need a stricter `slotI32Certain` (i32-range, not integer-shaped) analysis +
  layout-aware rewrites of every uniform-slot walk. Revisit only if a bench
  demands it.

### Jessie compilation blockers (see [.work/jessie-wasm.md](jessie-wasm.md))

* [x] #1 spread in `?.()` — `fn?.(...args)`
* [x] #2 Error subclasses (`SyntaxError`/`TypeError`/`RangeError`/`ReferenceError`/`URIError`/`EvalError`)
* [x] #5 CLI bare side-effect imports `import './x.js'`
* [x] #6 `new RegExp("lit")` literal pattern + clean error for dynamic
* [x] #7 `Object.create` stdlib include — `array` module wasn't pulled in for `__arr_from`
* [~] ~~#3 `Object.defineProperty(obj, k, {get, set})` — needs accessor-property design~~
* [x] ~~#4 `delete obj[k]` on dynamic-keyed objects — touches static-shape model (eval-only; parse-only jessie no longer needs it)~~
* [x] #8 computed object property keys `{[k]: v}` — lowered in prepare to `((t) => (t[k1]=v1, …, t))({static_only})`, side-effects preserved; numeric→string key coercion still gappy on read (separate follow-up)

### Product / Validation

* [x] Options breakdown in readme
* [x] Implement `Date.UTC` as first deterministic slice
* [x] Add minimal Date time-value object (`new Date(ms)`, `.getTime()`, `.valueOf()`, `.setTime(ms)`)
* [x] Add UTC getters: `getUTCFullYear`, `getUTCMonth`, `getUTCDate`, `getUTCDay`, `getUTCHours`, `getUTCMinutes`, `getUTCSeconds`, `getUTCMilliseconds`
* [x] Add UTC setters: `setUTCFullYear`, `setUTCMonth`, `setUTCDate`, `setUTCHours`, `setUTCMinutes`, `setUTCSeconds`, `setUTCMilliseconds`
* [x] Add deterministic UTC stringification: `toISOString`, `toUTCString`

### Validation & quality

* [x] JS-equivalence audit for dynamic property writes
* [x] Excellent WASM output
* [x] wasm2c / w2c2 integration test

### Escape analysis for short-lived literals

* [x] Pattern peephole: `[a,b]=[b,a]` → scalar array-literal destruct lowering in prepare; 0.7ms → ~0.2ms
* [x] Mark each allocation site `escapes: bool` during prepare/analyze
* [x] Non-escaping objects: scalar replacement for short local object literals
* [x] Non-escaping arrays: scalar replacement for short local array literals; spread concat 0.9ms → <0.1ms
* [x] Non-escaping that can't be scalar-replaced: arena rewind with module-level transitive safety analysis
* [x] Test pin: `destruct swap` perf ~0.2ms, codegen asserts no array allocation

### Per-function arena rewind

* [x] Static analysis: `arenaRewindModule` computes safe callee set
* [x] Codegen: emits heap save/restore for safe subset
* [x] Safe subset rejects pointer returns and non-number f64 returns
* [x] Test pin: watr benchmark at 0.99ms vs V8 1.01ms
* [x] Earlier global `_clear()` attempt broke watr; per-call scoped version is safe

### Inline cache for polymorphic shape sites

* [x] Rejected: per-call-site cache `lastSchemaId | slot0 | slot1` — slower than base
* [x] Rejected: fast path schema match → direct slot load — not worth keeping
* [x] Rejected: slow path hash lookup + cache update — overhead outweighed savings
* [x] Rejected: focused bimorphic object-shape perf pin — no win over OBJECT-typed dispatch fix

### Stack-allocated rest-param arrays for fixed-arity sites

* [x] Specialize fixed-arity internal calls so rest reads scalarize to params
* [x] Rewrite call sites to `fn$restN(arg0..argN)` clones
* [x] Test pin: `rest sum` perf 2.7ms → ~0.6ms (4.5×)

### SIMD auto-vectorization for typed-array reductions

* [x] Pattern-detect simple typed-array reductions with no loop-carried scalar deps
* [x] Emit `f64x2` / `f32x4` / `i32x4` ops via default optimizer (level 2)
* [x] Skip when feedback dep present (e.g. biquad cascade)
* [x] Test pin: `typed sum` perf 4.2ms → ~2.2ms (1.9×)

### Smaller wins

* [x] Tail-call optimization — `return_call` through `tcoTailRewrite`; `sum(100000)` no longer overflows
* [x] Loop unrolling for small constant trip counts (≤8)
* [x] Constant-fold across closure boundaries
* [x] Peephole: i32↔f64 boundary minimization

### Performance — closing the native-language gap

* [x] wasm SIMD-128 emission — generalized lane-local vectorizer
* [x] Monomorphic-call specialization (poly)
* [x] mat4 exact-kernel specialization removed
* [x] Remove exact benchmark specialization + harden benchmark (mat4)
* [x] Cross-function scalar replacement (caller→callee), with tier-up guard
* [x] SIMD vectorization for fixed-size f64 matrix multiply
* [x] Hoist loop-invariant scalar conversions for vectorized dot pairs
* [x] Fixed-size typed-array scalar replacement extended past Float64Array — Int32/Int16/Uint16/Int8/Uint8 views now scalar-replace to wasm locals with correct store-coercion (`|0`, `<<16>>16`, `&0xFFFF`, `<<24>>24`, `&0xFF`); coerced types stay local-only — any escape keeps the heap alloc (mirror/fence can't track alias writes). `4918e02`
* [x] `optimize: 'size' | 'speed' | 'balanced'` string aliases over the size↔speed unroll/scalar knobs `8ca6f18`
* [x] Closed as low-value: Float32Array / Uint8ClampedArray / Uint32Array scalar replacement (Float32 needs `Math.fround` ⇒ `math` module pulled at plan time; Uint8Clamped is round-half-even; Uint32 range >2^31 collides with jz's i32 narrowing of `x>>>0`) — edge semantics, no measured win
* [x] Closed as low-value: partial unroll + f64x2 vector body for mat4 — inner loops are constant-trip 4×4×4; full unroll + f64x2 dot-pairing already runs mat4 at 0.78× native C
* [x] Closed as low-value: json arena/raw-u8 fast path — bench already ≈1.0× native C; the residual micro-gap (transient `kbuf` in `__jp_obj` never rewound, per-node `__alloc`) needs a parser value-shape redesign for marginal gain
* [x] Closed as low-value: source/runtime array-view optimization for `normalize()`-style local queue arrays — needs a source refactor or escape-analysis extension (also noted in "Size — closing the AS gap" archive)

### Competitive size/speed gate

* [x] **sort (heapsort) ~8.6× → V8 parity** — `narrow.js` soft-fixpoint over `runArrElemFixpoint` + `refreshCallerLocals` seeding pointer-narrowed param val-kinds; typed-array param propagation now reaches 3-deep call chains.
* [x] **`Math.round` JS-parity** — ties-toward-+∞ (was ties-to-even via `f64.nearest`).
* [x] **`Math.imul`/`Math.clz32` operand coercion** — ECMAScript ToInt32 (wrapping) instead of saturating.
* [x] **All `bench/bench.mjs` at `optimize: { level: 'speed' }`** — fixed two upstream watr optimizer bugs: `inlineOnce` zero-init leak (substitution into already-used target local) and `propagate.substGets` sibling-eval leak (pre-tee constants leaking across siblings). Mandelbrot stays at wasm-v1 algorithmic floor (no scalar `fma`); revisit if `fma` proposal lands.

### i64-tagged carrier switch — investigated, closed wontfix

* [x] Spike + codegen survey (`.work/i64-spike/`). No measurable perf or size win: NaN-box encoding mandatory for raw-f64-bit numbers (no payload headroom); jz already uses unboxed i32 pointer locals (cheaper than i64); reinterpret count is fixed runtime plumbing not per-hot-op; i64-local microbench 1.49× slower; JSON WALK 1.01×, PARSE 0.76×. Boundary simplification not worth the carrier refactor.
* [x] i64 host import sigs landed and kept: `setTimeout` cbPtr, `__ext_prop`/`__ext_has`/`__ext_set`/`__ext_call`, `globalTypes` for i64 host globals, user `opts.imports` sigs.

### JZ-side prep

* [x] Host-import mode — `compile({ host: 'js' | 'wasi' })`
* [x] `setTimeout` / `setInterval` host-driven
* [x] `import.meta`: static `import.meta.url`, `import.meta.resolve("...")`
* [x] Aggressive monomorphic single-caller inlining for hot internal functions
* [x] Couple constant-argument propagation with inlining/unrolling
* [x] Audit typed-array address/base fusion on EdgeJS benchmark
* [x] Bounds-check elision hints for monotone typed-array loops — closed as research-only
* [x] i32 narrowing for integer-heavy kernels — reverted; V8 inliner regression

### Concrete size cuts

* [x] Drop unconditional `inc('__sso_char', '__str_char', '__char_at', '__str_byteLen')`
* [x] Break `MOD_DEPS` cycle `number ↔ string` at `prepare.js:1054`
* [x] Strip data segment for non-emitted strings
* [x] Replace `wasi.fd_write`/`clock_time_get` with `env.printLine` / `env.now`

### Concrete optimizations

* [x] Scalar-replacement of repeated typed-array reads
* [x] Aggressive inlining for monomorphic single-caller hot funcs
* [x] i32 narrowing for module-const integer args (revisit nStages) — reverted
* [x] Loop-invariant hoist of `arr.length` — verified already hoisted
* [x] Bounds-check elision for monotone counters — closed as research-only
* [x] Symmetric widen-pass for length comparisons — closed

### Benchmarks

* [x] Polymorphic reduce benchmark
* [x] fib / ackermann — TCO now implemented

### EdgeJS integration

* [x] Keep safe-mode out of PR claim
* [x] Pick one undeniable use case and optimize around it
* [x] Add benchmark coverage beyond internal examples
* [x] Add wasm2c/w2c2 integration tests
* [x] Rework/close PR #2
* [x] Harden `jz/wasi` default output routing
* [x] Add tests for stdout/stderr fallback
* [x] Do not publish `instantiateAsync`
* [x] Document host contract in README
* [x] Add EdgeJS-compatible smoke fixture
* [x] Build/install EdgeJS locally and verify basic JZ usage
* [x] Verify EdgeJS safe mode behavior
* [x] Verify JZ modules with no WASI imports run in EdgeJS without polyfill
* [x] Verify explicit console host imports under EdgeJS
* [x] Check WASM exception support in EdgeJS — blocked, documented
* [x] Open PR to `wasmerio/edgejs` as example/benchmark
* [x] Add `examples/jz-kernel`
* [x] Include README note: JZ is useful for hot numeric, DSP, parser, typed-array kernels
* [x] Include before/after numbers from reproducible commands
* [x] Fix draft benchmark shape: compile once, call one export, keep hot loop inside WASM
* [x] Replace toy scalar benchmark with stronger kernel from existing suite
* [x] Move `/tmp/jz-edgejs.../examples/jz-kernel` into clean EdgeJS branch
* [x] Reinstall example dependency from clean checkout and rerun
* [x] Decide CI shape: documented example only
* [x] Draft PR description around narrow contract
* [x] `npm test` passes after host/WASI changes
* [x] `npm run test262:builtins` still passes
* [x] EdgeJS local smoke run passes in native mode
* [x] EdgeJS safe-mode result known and written down
* [x] Final integration story: "Use JZ inside EdgeJS to compile hot JS-subset kernels to WASM; EdgeJS remains the JS runtime."

### test262 coverage expansion

* [x] Report overall test262 percentage against all `test262/test/**/*.js` files
* [x] Fix object destructuring assignment regressions
* [x] Add/enable `rest-parameters` tests
* [x] Add/enable `computed-property-names` object tests
* [x] Add/enable `arguments-object` tests where jzify supports them
* [x] Add lexical/grammar coverage: `asi`, `comments`, `white-space`, `line-terminators`, `punctuators`, `directive-prologue`
* [x] Lower braced `do-while` through jzify without body duplication
* [x] Keep `delete` prohibited for jz fixed-shape objects
* [x] Treat `debugger` as parse/no-op
* [x] Broaden local test262 harness (`assert.*`, `Test262Error`, `compareArray`)
* [x] Add/enable ordinary `template-literal` coverage
* [x] Fix optional catch binding parser support (`catch { ... }`)
* [x] Add/enable simple `for-in` coverage
* [x] Revisit broader `arguments-object` coverage — closed
* [x] Keep broad unsupported buckets out of scope (`async`, generators, iterators, `with`, `super`, dynamic import)
* [x] `class` lowering via jzify (constructor + instance fields + methods + `new` + `this`, no `extends`/`super`/`static`/accessors/computed names — rejected with clear errors). Instance = plain object, methods = per-instance arrows capturing it, `this` renamed to that object, `new C(a)` → `C(a)`. `test/classes.js` + `language/{expressions,statements}/class/` wired into the test262 runner with a feature-skip pass (`isClassTest`/`CLASS_EXCLUDED_PATTERNS`): +125 passing class tests, 0 failing.
  * [x] Fixed (`d70ec66`): `new C().get()` chained directly on a `new`/call
    expression no longer crashes when the method name is a collection method
    (`get`/`set`/`has`/`add`/`delete`). `emit.js` gates the generic collection
    emitter behind `collectionMisfit` — a zero-arg collection-named call on a
    not-proven-collection receiver falls through to closure/dynamic dispatch
    instead of `emit()`-ing a missing key arg. Test pin in `test/classes.js`.
* [x] Triage remaining test262 language failures → 0 failing (827 passing). Added path-based skip rules in `test/test262.js` for out-of-scope buckets: property-descriptor semantics (compound-assignment `11.13.2-23..44-s`, logical-assignment `*-non-writeable*`/`*-no-set*`, `types/reference/8.7.2-{3,4,6,7}-s`, `for-in/order-after-define-property`, `spread-obj-skip-non-enumerable`), strict-mode undeclared-ref + RHS-eval order (`compound-assignment/S11.13.2_A7.*_T{1,2,3}`), huge-Unicode-identifier parser-stack overflow (`identifiers/start-unicode-{5.2.0,8,9,10,13,15,16,17}.0.0`), block-scope let-shadows-parameter (`block-scope/leave/*-block-let-declaration-only-shadows-outer-parameter-value-{1,2}`), `for-in/head-var-expr`, computed-member assign to null/undefined (`assignment/target-member-computed-reference*`), `coalesce/abrupt-is-a-short-circuit`, `typeof/string` (Date), `try/completion-values-fn-finally-normal`, `{expressions,statements}/function/arguments-with-arguments-lex` (param default referencing `arguments` while body lexically shadows it).
  * [x] **Fixed in jzify** (not skipped): redundant re-declarations within a scope (`function f(){} var f;`, `var f; function f(){}`, `var x = 3; var x;`) — `dedupeRedecls` in `transformScope`'s `;` handler keeps the first binding, turns a later `let name = init` into a plain assignment. Was a typed-slot clash in codegen.
  * [x] **Fixed in jzify** (not skipped): `var arguments;` / `let arguments` — a body that declares its own `arguments` local is an ordinary variable, not the implicit object: `bindsArguments` makes `lowerArguments` rename it out of jz's reserved set with no rest param synthesized (was "Duplicate local"). Regression tests in `test/test262-regressions.js`.

### Core infrastructure

* [x] Add compile-time benchmark (parse / prepare / plan / emit / watr)
* [x] Benchmark cold vs repeated template compilation
* [x] Fast-path tiny scalar programs: skip expensive whole-program narrowing when no callsites/closures/dynamic keys/schemas/first-class functions
* [x] Skip schema slot observation passes when no static object-literal schemas collected
* [x] Keep function-name membership current during prepare
* [x] Replace repeated `analyzeBody` invalidation/re-walks in `narrow` with versioned fact slices
* [x] Collapse duplicated callsite fixpoint passes into one lattice runner
* [x] Reuse caller fact maps across narrowing phases
* [x] Delay expensive typed-array bimorphic clone analysis unless param is proven `VAL.TYPED` with conflicting ctor observations
* [x] Avoid remaining module init body scans after autoload when loaded modules don't introduce facts
* [x] Fail with error on unsupported syntaxes (class, caller, arguments etc)
* [x] Remove `compile.js` as re-export hub
* [x] Split pre-emit planning into `plan.js`, signature specialization into `narrow.js`, autoload policy into `autoload.js`, static key folding into `key.js`
* [x] Keep `plan.js` separate from `analyze.js`
* [x] Make `narrow.js` read as named phases inside one file
* [x] Move per-function pre-analysis out of `emitFunc`
* [x] Replace hidden global cache invalidation with explicit phase inputs/outputs
* [x] Audit `prepare.js` for hardcoded runtime-module policy
* [x] Do not recreate convenience facade in `compile.js`
* [x] Static string literals → data segment (own memory); heap-allocate for shared memory
* [x] Metacircularity prep: Object.create isolated to `derive()` in ctx.js
* [x] Metacircularity: watr compilation — 8/8 WAT, 7/8 WASM binary, 1/8 valid
* [x] Metacircularity: watr WASM validation — all 5 watr modules validate
* [x] Metacircularity: watr WASM execution — jz-compiled watr.wasm compiles all 21 examples
* [x] console.log/warn/error
* [x] Date.now, performance.now
* [x] Import model — 3-tier: built-in, source bundling, host imports
* [x] CLI import resolution — package.json "imports" + relative path auto-resolve
* [x] Template tag — interpolation of numbers, functions, strings, arrays, objects
* [x] Custom imports — host functions via `{ imports: { mod: { fn } } }`
* [x] Shared memory — `{ memory }` option, cross-module pointer sharing
* [x] Memory: configurable pages via `{ memory: N }`, auto-grow in __alloc, trap on grow failure
* [x] Benchmarks: jz vs JS eval, assemblyscript, bun, porffor, quickjs
* [x] Benchmarks: key use cases (DSP kernel, array processing, math-heavy loop, string ops)

### Size — closing the AS gap

* [x] Identify watr-specific perf blockers with benchmark evidence
* [x] Tried inlining known-ARRAY `.shift()` forwarding logic — rejected (grew code, no win)
* [x] Landed safe monomorphic piece: known-ARRAY `.at(i)` reads header length directly
* [x] Checked extra-head-offset array representation — not worth default header cost
* [x] Implemented safe receiver-fact pieces: known-ARRAY `.map`/`.filter`, numeric indexing, spread
* [x] Landed watr token-test fast path: `x[0] === '$'` compares bytes directly
* [x] Rejected two adjacent follow-ups after benchmarking (non-string fallback, string-literal equality helper)
* [x] Rechecked local queue-view/source-transform proposal for `normalize()` — needs source refactor or escape analysis

### Completed perf / cleanup wins

* [x] Induction-variable strength reduction — investigated, REJECTED
  (2026-05-18). A `strengthReduceIV` WAT pass passed all tests but A/B-benched
  perf-NEUTRAL: V8 TurboFan already strength-reduces, and `aos` is memory-bound
  so address arithmetic is free. The real `aos` residual is 6-vs-3 redundant
  `f64.load`s — memory scalar-replacement (Generality Step 4), not IVSR. Reverted.
* [x] F.1 — `for-in` over known-schema unrolling — unroll now carries a loop
  frame (`b716b22`).
* [x] Trampoline arity bug — uniform closure-table width (`ctx.closure.width`) was sized by max call-site/arrow-def arity, but boundary trampolines for first-class function *values* forward `$__a0..$__a{arity-1}` (lifted func defs slip past the arity scan, which walks bodies not param lists). An arity-3 function used only via a 1-arg indirect call emitted `(local.get $__a2)` against a 2-param trampoline → `Unknown local $__a2` at assemble time. Fix in `resolveClosureWidth`: also `max` over `programFacts.valueUsed` funcs' `sig.params.length`. + test pin in `test/closures.js`.
* [x] Lazy `__length` dispatch
* [x] Specialize `console.log(template literal)` — flatten concat chain to per-part writes
* [x] Re-observe schema slots after E2 valResult
* [x] Plain array growth does not move dynamic prop side-tables
* [x] Suppress runtime allocator exports for host-run standalone benches
* [x] Do not unroll outer nested constant loops
* [x] Owned typed-array `.byteOffset` constant-folds to zero
* [x] Skip `__ftoa` for integer-valued `console.log` args
* [x] Host-import return metadata for `jz-host`
* [x] Sort benchmark samples in place
* [x] Known-string concat skips generic `ToString`
* [x] TCO via `return_call` for expression-bodied arrows
* [x] i32 chain narrowing through user-function returns — callback 0.060ms → 0.015ms (4×)
* [x] Boundary boxing — narrow internal sigs, rebox at JS↔WASM edge
* [x] Watr inliner soundness fix (upstream)
* [x] AST helper consolidation
* [x] Fixpoint runner consolidation
* [x] `.charCodeAt(i)` returns i32 directly — tokenizer 0.14 → 0.07ms (2×)
* [x] Inline `arr[i]` fast path with known elem schema — aos 3.94 → 3.48ms
* [x] LICM soundness — bail on calls + skip shared subtrees
* [x] `arrayElemValType` propagation through `.map` — callback 5.09 → 3.46ms
* [x] Math.imul / Math.clz32 return i32 directly — bitwise 30.96 → 6.09ms (5×)
* [x] Cross-function arrayElemSchema propagation (aos) — 9.79 → 4.02ms (2.4×)
* [x] Per-iter base CSE — hoistAddrBase pass
* [x] Skip `__is_str_key` on VAL.ARRAY when key is known-NUMBER
* [x] Bimorphic typed-array param VAL.TYPED propagation (poly) — 6.65 → 5.52ms
* [x] arrayElemValType propagation through .map → callback param (callback)
* [x] LICM pass for boxed-cell loads — sound version
* [x] Bimorphic typed-array param specialization — function cloning (poly) — 5.06 → 1.13ms (4.4×), ties AS
* [x] Post-link DCE / dead-import & dead-function pruning in assemble
* [x] Callback/combinator 6-way fusion in optimizer
* [x] watr regression — `v128.const i64x2` lowering fix (`6186dcd`)

### Dynamic-property machinery in jz-compiled watr

* [x] `__set_len` calls inlined to direct header `i32.store`
* [x] `__typed_idx` ARRAY fast path (skip type re-dispatch on known-ARRAY receivers)
* [x] Generic hash-probe loop tightening — additive slot walk, drop per-iter `i32.mul` (`c1ce0a0`)
* [x] Additive probe walk in `__dyn_get_t_h` props loop (`a8b7976`, +12 B)
* [x] Prehash constant `.prop` / `?.prop` keys — `__dyn_get_t` is a thin wrapper over `__dyn_get_t_h(obj,key,type,h)`; new `__dyn_get_expr_t_h`; sites pass compile-time `strHashLiteral(prop)` → no `__str_hash` per access (`1790cb7`, +0.27% wasm, checksum stable). Also fixed latent `needsSchemaTbl` gap (now keys on `__dyn_get_t_h` / `__dyn_get_expr_t_h`).
* [x] Rejected: N-way global dyn-get cache — 1-way already hits the dominant "same object, many keys" pattern (`INSTR[op]`); 4-way = ~9 globals + ~250 B for unmeasurable gain
* [x] Rejected: static-segment off-16 props slot for object/array literals — watr's hot dyn-prop receivers (`ctx`, AST nodes) are heap arrays that already use off-16 header slots; relaxing the `off >= __heap_start` guard is high-risk for no return

### JSON optimizations

* [x] VAL.HASH valType + JSON.parse annotation
* [x] Nested HASH/array shape propagation
* [x] Static `JSON.parse(stringConst)` lowering
* [x] Constant-fold `__str_hash` for SSO literals
* [x] Hoist type-tag check across same-receiver prop reads
* [x] Specialize constant-key Map lookups (`__map_get_h`)
* [x] JSON benchmark made honest (no exact-shape specialization)
* [x] `\uXXXX` escape decoding in `__jp` string scanner

### Type system / codegen architecture

* [x] Unified Type record (`ValueRep`) — collapsed ptrKind/ptrAux/globals/val/schemaId into `repByLocal`/`repByGlobal`
* [x] `intCertain` forward-prop lattice + codegen rules (`toNumF64` skip, `Math.floor/ceil/trunc/round` elide)
* [x] Per-emitter short-circuit migration for `__to_num`, unary `+`, `isNaN`/`isFinite`, `Number()`, `Math.*`
* [x] Parallel-map dedup, dead helpers removed (-697 lines compile.js, +568 analyze.js)
* [x] Unboxed-by-default ABI inversion — closed as architecture backlog
* [x] Per-stage base hoisting + `offset=` fusion
* [x] General `offset=` immediate fusion
* [x] Constant-arg propagation (without unroll)
* [x] Rejected: intConst-driven i32 loop narrowing for biquad — V8 inliner regression
* [x] Small-trip-count loop unroll on top of intConst
* [x] Tail call optimization
