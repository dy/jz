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

### Imports & jzify

* [ ] jzify script converting any JZ
* [ ] jzify: auto-import stdlib globals (Math.* → `import math from 'math'`, etc.)
* [ ] jz core: require explicit imports for stdlib (remove auto-import from prepare/compile)
* [ ] align with Crockford practices

### Diagnostics

* [ ] Source maps (blocked on watr upstream) — meanwhile add WASM name section (function names) independently

### Metacircularity (jz compiling jz)

* [ ] Extract minimal jz parser from subscript features — jz-jessie fork excluding class/async/regex + refactor parse.js function-property assignments (~30 lines)
* [ ] jzify uses jessie, pure jz uses internal parser
* [ ] True metacircular bootstrap
* [ ] swappable watr: AST likely needs stringifying before compile if an adapter is provided


### Interop (host ↔ wasm boundary)

Goal: run jz-compiled `.wasm` from any host without pulling the compiler. The marshalling shim lives at `jz/interop/<abi>`; the abi is a value-representation choice the wasm declares, not part of the host. (Named `interop` not `host` because the variant axis is the ABI — `jz/interop/gc` reads cleanly; `jz/host/gc` reads as "GC is part of the host", which it isn't.)

Compiler emits a `jz:abi` custom section carrying the per-type rep map; top-level `jz/interop` reads it on instantiate and assembles the matching per-type marshallers from a registry. Single import path, any ABI configuration:

```js
import { instantiate } from 'jz/interop'
const { exports, memory } = await instantiate(wasmBytes)
```

**Module-level ABI, no mixing.** One module = one rep map = one set of marshallers. A program needing both a hot-kernel config and a dynamic-shape config compiles two `.wasm` files and shares linear memory through `opts.memory`. Rationale: per-export marshalling matrices double both glue and test surface, undermine the size win of stricter reps (a flat export living next to a nanbox export re-pulls the nanbox decoder), and force combinatorial gating in tests. Single rep map per module keeps the boundary as one decision, kept honest by `jz:abi`.

#### Architecture — per-type rep registry

`opts.abi` is **a preset name string**. Each preset is a tested per-type rep map — a small focused file per (type, rep) pair, combined into named bundles. Free-form maps were considered and rejected: presets are the unit of testing, and ad-hoc mixes have no driver. The dispatch table that already exists implicitly in jz codegen (different IR per inferred type) becomes reified by the per-type axis.

**Config shape:**

```js
// abi/index.js — preset values are rep modules, not name strings.
// Identity comparison (abi === PRESETS[DEFAULT_PRESET]) decides whether to
// emit the jz:abi discriminant section.
import numberNanboxF64 from './number/nanbox-f64.js'
import stringJsstring  from './string/jsstring.js'

export const PRESETS = {
  nanbox:            { number: numberNanboxF64 },
  'nanbox+jsstring': { number: numberNanboxF64, string: stringJsstring },
  // flat, gc, component — land as their reps land
}

jz.compile(src, { abi: 'nanbox' })            // default — no section emitted
jz.compile(src, { abi: 'nanbox+jsstring' })   // section records preset name
jz.compile(src, { abi: 'bogus' })             // throws with available list
```

**Compiler-side rep registry (`abi/<type>/<rep>.js`):**

```js
// abi/string/jsstring.js — minimum hooks today; ops table filled as
// module/*.js sites route through ctx.abi.<type>.ops.<op> (Step 5).
export default {
  slotTypes: ['externref'],                  // wasm slot(s); read by sig synth
  imports:   ['length', 'charCodeAt', ...],  // 'wasm:js-string' names referenced by ops
  ops: {                                     // per-op codegen the registry dispatches through
    // length:     (s) => ['call', '$jsstring_length', s],
    // charCodeAt: (s, i) => ['call', '$jsstring_charCodeAt', s, i],
  },
  peephole: (node) => node|null,             // rep-specific folds (optional;
                                             //   nanbox-f64 has one, jsstring doesn't need any)
}
```

No `type` / `name` discriminant fields — the PRESETS table is the single source of rep identity (reps are referenced by object identity, not lookup). Operator emitters in `module/*.js` will call `ctx.abi.string.ops.length(s)` and the rep decides; compound containers (`array`, `object`) ask the rep for the cell/field shape of each element type.

**Host-side: per-preset driver, not per-(type, rep).**

Different axis from the compiler side. A driver knows how to instantiate wasm under one whole ABI bundle — wasi linking, env defaults, allocator wiring, marshallers for every type it ships. Today that's `interop/nanbox.js`. The shared scaffolding (custom-section reader, `prepareInterop` / `buildImports` / `finishInstantiation`, `_setMemory`, `__timer_tick`, `__invoke_closure`) lives in `interop/_shared.js`, ABI-agnostic. The umbrella `interop/index.js` sniffs the `jz:abi` section, decodes the preset name as UTF-8 bytes, and dispatches to the right entry in its `DRIVERS` table.

Per-type host marshallers (`interop/<type>/<rep>.js`) were drafted and removed as premature — they only earn their keep when a second driver shows duplicated marshalling code. Until then, drivers stay flat.

**Why per-type on the compiler side:**

1. Subsumes flags like `jsStrings` as config values (`string: 'jsstring'`) instead of orthogonal toggles layered on top of an ABI's "main" choice.
2. Reifies the dispatch table that already exists implicitly in jz emit — nanbox-tagged-f64 vs typed-array vs known-string each take different paths today; per-type makes the table a registry lookup.
3. Each rep variant is a small focused file (~50-150 lines). Adding one doesn't touch the others.
4. Compound types derive: `array<T>`'s cell layout follows from T's slot rep — we don't configure cell encoding independently, the array's `cellOf(T, abi)` reads the chosen primitive rep.

**Validation:**

Presets are the validated unit; free-form combos were dropped to keep the test matrix bounded. Unknown preset names throw at compile time with the available list. Combinatorial-explosion concerns (e.g., `wasm-gc array of nanbox-tagged-f64 numbers`) become impossible by construction — they're only reachable if someone adds the combo to PRESETS, at which point it must come with a driver and a test.

#### Optimizer stays ABI-agnostic

Today `src/optimize.js` has exactly one nanbox-specific pass: the rebox/unbox peephole (`i64.reinterpret_f64 (f64.reinterpret_i64 x)` → `x`) re-run after watr inlining. **Move that into the relevant rep's `peephole` hook** (`abi/number/nanbox-f64.js`). After that move every other pass — CSE, DCE, inline, vectorize, hoist, fold, treeshake, propagate, LICM, dedupe, packData, brif, loopify, offset-fusion, strength, identity — operates on watr-typed IR and is rep-blind. The narrowing fixpoint (`src/narrow.js`) already produces typed-value IR; reps intercept only at op-emit and function boundary.

Audit targets that may have nanbox assumptions to surface and route through the registry:
- `module/*.js` ad-hoc `boxPtrIR` / `i64.reinterpret_f64` emits → call `ctx.abi.<type>.box/unbox` or `ctx.abi.<type>.ops.<op>`
- `src/ir.js` layout constants (`PTR.STRING`, `PTR.ARRAY`, tag bits, offset bits) → owned by `abi/object/schema-linear.js` and `abi/string/nanbox-sso.js`, not core
- `src/compile.js` import/export sig synthesis → call `ctx.abi.<type>.slotTypes` per arg/result
- `interop/nanbox.js` wasi/env/allocator glue → carve into `interop/_shared.js` ✓ (step 1)

#### Test contract — `JZ_ABI` env flag, per-test ABI gate

```js
// test/util.js
const ABI = process.env.JZ_ABI || 'nanbox'
export const run = (code, opts = {}) => jz(code, { abi: ABI, ...opts })
export const supportsAbi = (...abis) => abis.includes(ABI)
```

Rules:
- Every test calls `run()`, never `jz()` directly. (Mostly true today — fix stragglers as part of the refactor.)
- No test imports `jz/interop/nanbox` directly. Use the umbrella `jz/interop` which sniffs `_jz_abi`. `test/interop.js` already pins this.
- ABI-specific tests gate explicitly: `if (!supportsAbi('nanbox')) return` at the top of the test body.
- Per-file declaration: each test file optionally exports `supportedAbis = ['nanbox', 'flat']` (default = all). Runner reads it and emits one line per file: `# flat: skipped N tests`. No silent skips.
- CI matrix: `JZ_ABI=nanbox npm test && JZ_ABI=flat npm test`. Same `package.json`, two runs.
- Honest framing: skipping ≠ working. A test file that runs under `flat` only proves its static subset works — flat-specific tests (e.g. cross-ABI calling convention conformance) are additive, not gated reuse.

#### Refactor sequencing — architecture first, variants second

Each step is shippable on its own. Stop after 3 and the codebase is structurally cleaner even with only the nanbox preset.

* [x] **Step 1: carve `interop/_shared.js`** out of `interop/nanbox.js` (wasi linking, env defaults, allocator wiring, custom-section reader, `prepareInterop`/`buildImports`/`finishInstantiation` scaffold). `interop/nanbox.js` keeps only marshalling + nanbox codec. Tests green.
* [x] **Step 2 (scaffold): rep registry shape on compiler side** — `abi/number/nanbox-f64.js` shipped. Rebox/unbox + NaN-box-layout-aware folds (`wrap_i64(reinterpret_f64(f64.load/_mkptr/block))`, `wrap_i64(or HIGH_ONLY (extend X))`) migrated out of `src/optimize.js` into the rep's `peephole` hook; the optimizer calls `ctx.abi.number.peephole(node)`. Pure-WASM folds (`wrap_i64(extend(x))`, `trunc_sat(convert(x))`, etc.) stay in optimize.js as ABI-agnostic. `ctx.abi` resolved in `reset()` via `abi/index.js`. Tests green (1598).
  * **Deferred** to Step 5 mass-routing (gated on a 2nd rep having codegen-divergent ops): routing the ~1000 `module/*.js` ad-hoc encoding sites through `ctx.abi.<type>.ops.<op>` while only one rep exists is mechanical work with no observable behavior change, no validation that the abstraction is right, and high regression surface. Each call site can only be honestly classified as "per-rep" vs "rep-agnostic" when a second rep disagrees with the first. Same for `PTR.*` layout constants: they're shared by every nanbox-emitting site today; pulling them into one rep file is a lie until non-nanbox reps need different ones.
* [x] **Step 3: `opts.abi` plumbing + `jz:abi` section + host-side registry skeleton** — `opts.abi` accepts a preset name string (free-form map dropped — preset is the unit of testing). `resolveAbi` validates and throws on unknown preset. `jz:abi` custom section emitted only when the resolved preset differs from the default (no metadata tax on default outputs; bytes-identical to pre-ABI emission). Section payload is the preset name as UTF-8 bytes (no JSON). CLI `--abi=<preset>` flag added. `test/util.js` updated with `ABI`/`run(code, opts)`/`compileSrc`/`supportsAbi`; reads `JZ_ABI` env, errors clearly on garbage.
* [x] **Step 4: `interop/index.js` umbrella** — sniffs `jz:abi` section via `customSection` helper, decodes the preset name, dispatches to the matching driver in `DRIVERS`. Falls back to `nanbox` for legacy/default-preset wasm (no section). Unknown preset name → clear error. Re-exports nanbox-codec helpers verbatim (`memory`, `wrap`, `ptr`, `offset`, `type`, `aux`, `i64ToF64`, `f64ToI64`, `coerce`, `NULL_NAN`, `UNDEF_NAN`); `instantiate` is the dispatching wrapper. `package.json` exports map repointed `./interop` → `./interop/index.js`. 1598 tests pass at default preset *and* under `JZ_ABI=nanbox+jsstring` (proves the dispatch path is real — section emitted, sniffed, driver picked end-to-end).
* [x] **Simplification pass** (after Steps 2–4 landed): collapsed `abi/registry.js` + `abi/presets.js` → single `abi/index.js`. PRESETS values are rep modules directly (no name-string indirection / no `REPS` table). Dropped `name`/`type` fields from rep modules — preset table is the single source of rep identity. Deleted `interop/registry.js` + `interop/` (premature surface — host-side rep mirrors land when a rep actually needs boundary marshalling). Section payload is preset name bytes, not JSON. `opts.abi` accepts preset-name strings only. Net delete ~140 lines.
* [x] **Second rep scaffold (`string: 'jsstring'`)** — `abi/string/jsstring.js` shipped as architectural scaffold; declares `slotTypes: ['externref']`, `imports: [...]` (the `wasm:js-string` names), and an empty `ops` hook table. Wired into PRESETS as `'nanbox+jsstring': { number: nanboxF64, string: jsstring }`. Host driver in `interop/index.js` aliased to `nanbox` until codegen actually diverges. End-to-end verified: `compile(code, { abi: 'nanbox+jsstring' })` writes the preset name into `jz:abi`; `interop.instantiate` sniffs and picks the right driver. Today the wasm output for both presets is identical apart from the section — observable divergence comes when string codegen routes through `ctx.abi.string.ops.<op>`.
* [ ] **Step 5 mass-routing (gated on jsstring ops actually emitting different wasm)** — route `module/string.js` (`.length`, `[i]`, `+`, `charCodeAt`, …), `module/property.js` string-prop dispatch, and any other string-typed call sites through `ctx.abi.string.ops`. Populate `jsstring.ops.*` to emit `call $jsstring_<op>` referencing the engine builtins. Wire `wasm:js-string` imports + externref slot type into the signature synthesizer. Host driver for `nanbox+jsstring` then needs to actually marshal externrefs (not nanbox tags) for string params/returns.

#### Open policy questions (decide before step 5)

These don't block the architectural refactor but block first non-nanbox emission:

1. **Type-discovery on polymorphic exports.** jz's narrowing today is for codegen, not stable export ABIs. Options: (a) hard-error on exports whose params can't be flat-represented, (b) declared annotation (JSDoc `/** @type {string} */` or per-export pragma), (c) silently downgrade to nanbox for that module if any export is polymorphic. Reject (c) — silently violates "module-level ABI."
2. **Null/undefined.** No flat `f64` slot can carry them without sentinels (which is partly nanbox). Either refuse nullable scalar params/returns, or introduce explicit `option<T>` (future). Cleanest now: refuse + clear error.
3. **Compound-value lifetime.** Flat strings allocated by `__alloc` for a host call — when freed? jz today bump-allocates with `_clear` reset; fine for short-lived, leaks long-running. Each ABI carries a memory policy. Make this a hook (`abi.lifetime: 'arena' | 'caller-frees' | 'gc'`) before flat lands.
4. **Object identity.** Nanbox objects round-trip with stable identity via extMap. Flat objects copy across the boundary, lose identity. Documented limitation per-ABI, not a bug.

#### Immediate focus — nanbox gains; rep machinery is the door, not the destination

The transition to a second preset is worth doing **for architecture**, not as a competitive moat. jz's unique position is "JS-shaped source in, small wasm out" — adding flat puts jz in AssemblyScript's territory where AS has years of head start. The same 40× size delta a flat probe shows is largely available **without** a second preset by improving narrowing: most "nanbox output is big" complaints are dynamic-fallback emit that narrows away when inference reaches the relevant param.

Two concrete nanbox-gain workstreams run alongside the architectural refactor (steps 1–4):

* [ ] **Narrowing investigation** — pick 5 real jz programs whose output is bigger than it should be, chase the dynamic-fallback sites, quantify post-narrowing size. Targets: `(a, b) => a + b` should not pull `__str_concat` when neither side ever sees a string; `xs[i]` should not pull `__dyn_get`/`__str_idx`/`__typed_idx` when `xs` is provably typed-array. If narrowing delivers 5–20× on real programs at nanbox shape, the flat-preset case weakens to "I need to call jz from Rust" — a real but narrow user.
* [~] **JS String Builtins rep (`string: 'jsstring'`)** — scaffold landed (`abi/string/jsstring.js`; preset `nanbox+jsstring` in `abi/index.js`; dispatch path verified end-to-end). Remaining: populate `jsstring.ops.*` to emit `call $jsstring_<op>` against `wasm:js-string` imports (`length`/`charCodeAt`/`concat`/`fromCharCode`/...); route `module/string.js` through `ctx.abi.string`; declare `externref` slot type in signature synthesis; teach the `nanbox+jsstring` host driver to marshal externrefs for string params/returns. Highest-leverage nanbox gain — unique competitive corner (JS-shaped source + native JS strings), no equivalent in AssemblyScript. Engine support: V8 17+, Safari 18.4+, Firefox behind flag.

#### Presets — what gets shipped

Each preset is a tested per-type rep map. Reps are reusable building blocks; presets are the supported combinations.

* [x] **`nanbox`** — baseline. All types use nanbox encoding (tagged f64 numbers, SSO+heap strings, tagged-linear arrays, schema-linear objects). Existing repr extracted as no-compiler subpath (commit `dc54fb0`).
* [~] **`nanbox+jsstring`** — `nanbox` preset with `string: 'jsstring'`. Preset entry + section emit/sniff/dispatch all live; codegen still nanbox-shaped until the JS String Builtins routing above lands.
* [ ] **`flat`** — `{ number: 'f64', int: 'i32', string: 'utf8-ptrlen', array: 'flat-linear', object: 'schema-linear' }`. C-ABI shape for non-JS hosts (Rust/Go/C). Multi-value returns for compound results (wasm 2.0). **Deferred behind narrowing investigation** — if narrowing closes the size gap at nanbox shape, flat reduces to a non-JS-host story, which is real but narrow.
* [ ] **`gc`** — `{ number: 'f64', int: 'i32', string: 'stringref', array: 'wasm-array', object: 'wasm-struct' }`. Real GC (today jz has none — long-lived programs leak), engine-managed values, zero linear-memory blobs for refs. Drops MVP-engine support.
* [ ] **`component`** — WIT-defined interface; bindings tool generates host stubs. The interop shim disappears for the user (jco / wit-bindgen emits typed JS). Requires component-aware host. Compiler emits a `.wit` alongside the `.wasm`.

Layout discoverability: rep-specific layout constants (e.g. nanbox tag bits, SSO encoding, schema struct offsets) live inside each rep's compiler-side module; the host-side mirror inlines matching constants. If a layout ever needs to evolve without breaking shipped wasm, the `jz:abi` section can carry a version per rep and the host mirror checks compatibility at instantiate.

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


---

## Archive

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

* [x] **`sort` (in-place heapsort): jz ~8.6× slower than V8/`asc -O3`** — FIXED. Root cause: cross-call typed-array param propagation didn't reach the 3-deep `main→runKernel→heapsort→siftDown` chain — `siftDown.a` stayed an untyped NaN-boxed f64 ⇒ `a[child]` → runtime `__typed_idx`/`__typed_set_idx` calls + `child` an f64 index with `i32.trunc_sat` per access. Two fixes in `narrow.js`: (1) `runArrElemFixpoint` now iterates a *soft* ctor merge to a fixpoint (don't sticky-poison a callee on the first sweep when the caller's own param isn't typed yet), then one hard validating sweep; (2) `refreshCallerLocals` seeds pointer-narrowed params' val-kind into a transient `repByLocal` so `n = arr.length` is recognised as i32 and propagates to `siftDown`'s `end` param. Result: `siftDown` now emits direct `f64.load/store` + i32 indices; jz beats `asc -O3` and runs at V8 parity. `bench-pin.js` sort: v8 `near`, as `tie`. Size still ~1.10× `asc -Oz` (generic codegen slack, follow-up open).
* [x] **`valid jz = valid JS` break — `Math.round`** — FIXED (`module/math.js`): `f64.nearest` (ties-to-even) replaced with ties-toward-+∞ — emit `nearest(x)`, bump by one iff `nearest(x) === x - 0.5` (the only disagreeing case; −0.5→−0 and 0.49999…94→0 already match). Repro folded into `test/differential.js` (`rounding`, `round half-integers`); stale `Math.round(-3.5)` assertion in `test/math.js` corrected (was `-4`, JS gives `-3`).
* [x] **`valid jz = valid JS` break — `Math.imul`/`Math.clz32` operand coercion** — FIXED (`module/math.js`): operands now go through `toI32` (ECMAScript ToInt32, wrapping, +∞/NaN→0) instead of `asI32` (saturating) — `Math.imul(x, 2654435761)` wraps to negative like JS instead of clamping to INT_MAX. Repro folded into `test/differential.js` (`imul big literal`).
* [x] **All `bench/bench.mjs` cases run at `optimize: { level: 'speed' }`** — previously biquad / mandelbrot / tokenizer fell back to `balanced` or `size` because `'speed'` produced wrong checksums or crashes. Two upstream optimizer bugs fixed in watr:
  * `inlineOnce` zero-init leak — substituting an init-`local.set $x 0` callee body into a caller that already used `$x` for another value silently aliased the slot. Fixed by gating substitution on absence of caller writes to the target local.
  * `propagate.substGets` sibling-eval leak (commit `d0e2d8a`) — `substGets` recursed through operand siblings sharing one `known` map; when arg1 contained `(local.tee $X NEW)`, arg2's `(local.get $X)` got substituted with $X's pre-tee tracked constant. After `coalesceLocals` aliased an init-const local with a sibling-read role this surfaced as `alloc(len=320, cap=40, …)` in biquad → buffer overflow → wrong checksum `1465809949` vs expected `422839881`. Fix: per-sibling invalidation in `substGets` (drop tracked entries whose slot was set/tee'd by an earlier sibling), with lazy `Map` clone so the overhead is paid only when needed. Regression test in `watr/test/optimize.js`. jz `bench/bench.mjs` synced to `'speed'` in commit `fb46c29`; tokenizer 0.583× (`win`). Mandelbrot ~0.90× local / ~1.005× CI — within noise of V8; claim demoted `win`→`tie` because the inner loop is at the wasm-v1 algorithmic floor (3 fmul + 4 fadd + 1 fsub + 1 fgt + 3 i32 ops + 3 branches, no instruction left to drop), wasm v1 has no scalar `f64.fma`, and `f64x2.relaxed_madd` lane-0 measured 17% *slower* on ARM due to splat/extract overhead. Revisit if the wasm `fma` proposal lands.

### i64-tagged carrier switch — investigated, closed wontfix

* [x] Spike + codegen survey (see `.work/i64-spike/` — FINDINGS.md, bench*.mjs, json.wat). Conclusion: switching the internal value carrier from NaN-boxed f64 → i64 buys **no measurable perf or size win**. (1) No bit headroom — raw-f64-bit numbers must keep the NaN-box encoding regardless of storage type, so the 51-bit payload split is unchanged; the "type:8/aux:24/offset:32 = 64 bits" scheme is infeasible (would force boxing doubles, killing numeric perf). (2) jz already has unboxed-i32-offset pointer locals (`repByLocal` carries `ptrKind`/`ptrAux`/`schemaId`; pointer ops are bare `local.get`s) — strictly cheaper than an i64 carrier (32 vs 64 bits). (3) Static `*.reinterpret_*` count is ~45/15 flat across numeric and pointer/string-heavy benches — fixed runtime plumbing, not per-hot-op codegen; existing hoisting/unboxing keeps reinterprets off hot recurrences everywhere. (4) Microbenchmarks: i64-local-with-reinterpret 1.49× slower on a numeric recurrence; json WALK i64/f64 = 1.01×, json PARSE = 0.76×; WASM size ±handful of bytes. The two "surgical" alternatives (LICM on property-access loads; unboxed-pointer return ABI for `__jp_shape_N`) target a gap that doesn't move any benchmark, and LICM-on-loads re-opens the `cseScalarLoad` aliasing bug class. Only real upside is host.js boundary simplification (drop the NaN-canonicalization plumbing) — not worth a multi-day high-risk carrier refactor. Revisit only if a real bottleneck surfaces.
* [x] (prep landed earlier, kept) `env.setTimeout` cbPtr — i64 import
* [x] (prep landed earlier, kept) `__ext_prop` / `__ext_has` / `__ext_set` / `__ext_call` — i64 imports
* [x] (prep landed earlier, kept) Add `globalTypes` tracking for host-imported globals (i64)
* [x] (prep landed earlier, kept) Switch user opts.imports declared sig from f64 → i64

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
  * [ ] Known limitation (pre-existing jz core, surfaced more often by classes): `new C().get()` chained directly on a `new`/call expression crashes when the method name is a collection method (`get`/`set`/`has`/`add`/`delete`) — `emit.js` dispatches `.get()` on an untyped receiver to the Map/Set emitter, which then `emit(undefined)`s the missing key arg → "expected emitted IR value, got empty value". Workaround: `let c = new C(); c.get()` (a typed local hits schema dispatch). Real fix: don't pick a collection-method emitter for an untyped receiver when arg count doesn't match / a closure-call path exists.
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
