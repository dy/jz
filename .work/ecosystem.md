# jz — ecosystem audit & affect map

Answers the todo "AS ecosystem audit" plus the wider question: where does jz
overlap the WASM/JS ecosystem, what examples make it undeniable, and how does it
become known across the dev spectrum.

> **Status (2026-06).** The example/gallery axis is largely **shipped** (~70
> demos in `examples/`, the `floatbeat/` playground, the `repl/` WAT REPL — see
> §2). The live expansion items are now **integration & reach**, not more demos:
> `unplugin-jz`, dogfooding the author's libs, the unifying playground site,
> embedded-MCU (§3.6), and two remaining flagship kernels (CHIP-8, QOI). Audience
> **personas** are canonical in [`marketing.md`](marketing.md); this doc is the
> **expansion map** (overlap, integration surfaces, channels).

---

## 0. The lens (everything below is judged against this)

jz's irreducible magic is one sentence: **valid jz = valid JS.** You write plain
JS that runs in the browser today, and it compiles to tiny WASM at `clang -O3`
speed, with no annotations, no runtime, no toolchain.

The corollary nobody else can match: **the same source runs two ways — as JS and
as jz-WASM — so the two can be compared honestly by flipping one switch.** AS
source isn't runnable JS; Rust isn't JS; emscripten isn't JS. Only jz can put the
*identical source* on both sides of the toggle. That toggle is the spine of the
whole strategy — but it is an **honesty instrument, not a guaranteed win**.

> ⚠️ **Measured reality (don't build the pitch on a false premise).** Against V8's
> JIT in the browser, jz does **not** uniformly beat JS. Per-frame compute time,
> identical source, optimized jz build:
>
> | kernel | nature | jz | JS (V8) | winner |
> |---|---|---|---|---|
> | interference | Math.sin/sqrt-heavy | 1.03 ms | 1.31 ms | **jz 1.28×** |
> | mandelbrot | f64 + Math.log | 5.1 ms | 5.4 ms | tie |
> | game-of-life | integer-index-heavy, branchy | 0.56 ms | 0.47 ms | **JS 1.2×** |
> | RFFT 2048 (kernel) | split-radix FFT, idiomatic f64 bounds | 7.8 µs | 13.6 µs | **jz 1.69–1.74×** |
> | RFFT 2048 (+cepstrum) | above + log-mag IDFT | 27.1 µs | 31.1 µs | **jz 1.14–1.16×** |
>
> The pattern: **jz wins when transcendentals (sin/cos/sqrt/exp) dominate** (its
> Math is faster than V8's). On **integer-index loops** jz's universal-f64 number
> model used to penalize indexing — every `a[i]` truncs an f64 to i32 and the loop
> arithmetic runs in f64 — and the prior workaround was a per-kernel idiom: hoist the
> f64 loop-bound globals into i32 locals (`let n = N | 0`). That is now a **compiler
> pass, not a source idiom** (`collectI32SafeIndexVars` in `src/analyze.js`): a
> counter used as an *affine* component of a *fully-i32* array index provably stays
> in i32 range (a valid wasm32 byte-offset must fit i32), so the analyzer keeps it
> i32 instead of widening it against the f64 bound — direct indexing, no per-access
> `trunc_sat`. A companion pass, **integer-global type inference**
> (`inferModuleIntGlobals` in `src/plan.js`), goes to the root: a numeric module
> global is `i32` **by default**, demoted to f64 only on proof of a fraction
> (non-integer literal, `/`, `**`, float `Math.*`, or a reference to an
> already-fractional value; a fixpoint propagates fractionality through cross-global
> refs, and a global ever assigned a non-number is left as the f64 box). With `N`/
> `width` now i32 globals, the loop guard `i < N` is **pure-i32** (no per-iteration
> convert) and `mem[y*width + x]` is a **fully-i32** address — so the gated index pass
> above fires automatically. Idiomatic RFFT (no `|0` anywhere) now beats V8
> **1.69–1.74×** on the kernel / **1.14–1.16×** incl. cepstrum (was 1.46× / 1.05×;
> `examples/rfft/bench.mjs`, correctness ~1e-12). interference **1.96×**, mandelbrot
> untouched (no mutable scalar globals). game-of-life stays **neutral** (0.82×, JS
> ~1.2× ahead) — it's branch/call-bound (per-cell ternaries, `rot()` call,
> Uint32Array values), not index-bound, so the now-i32 globals shrink its wasm but
> don't move the ratio. Both passes are correctness-preserving; full suite 1856 pass.
>
> jz's *durable* edges are elsewhere, and the demos should say so honestly:
> **(a) no warmup** — wasm runs full-speed on call #1; JS pays interpreter→JIT
> warmup; **(b) runs where there is no good JIT** — Hermes/React-Native, QuickJS,
> old Safari, embedded — there interpreted JS loses badly to compiled wasm;
> **(c) AOT-to-native** for microcontrollers (no engine at all); **(d) tiny +
> predictable** — 9 KB, no deopts, no GC pauses. The toggle's job is to show the
> *identical-source* magic and a *truthful* number, not to fake a win.

A jz example is **astonishing** iff all five hold:
1. compute-bound, so the per-frame cost is legible (and honest — show ms, not just a vsync-capped FPS);
2. the kernel reads like plain JS any dev would write;
3. immediate sensory output (canvas pixels or audio), in real time;
4. small — the "tiny formula → tiny WASM" feeling; ideally tweetable;
5. carries the same-source JS↔WASM toggle.

---

## 1. Verdict on the actual todo: AS test parity

**Do NOT port AssemblyScript's test suite. DO mine AS's showcase as bench/demo corpus.**

Why porting their tests is the wrong question:
- AS tests verify AS's *language* — typed TS, explicit `i32/u32/f32`, operator
  overloading, decorators, its own GC stdlib. jz diverges from all of that *by
  design* (NaN-box f64, valid-JS subset). Their unit tests assert conformance to
  a different language; passing them would prove nothing about jz and cost weeks.
- jz already targets the *right* conformance corpus — **test262** (real JS) plus
  the differential fuzzer (`test/differential.js`) plus the size/speed bench gate.
  That trio is stronger evidence than AS-test parity could ever be.
- The AS comparison that matters — size/speed on a shared corpus — is **already
  gated** in `test/bench.js`. The work is to *widen that corpus*, not to mirror
  AS's asserts.

What to actually take from AS:
- Port a handful of AS *showcase compute kernels* into `bench/` + `examples/`
  where the "plain JS vs typed-TS" head-to-head is the marketing: path tracer
  (as-smallpt), an emulator CPU loop (wasmBoy), Levenshtein, a hash (as-sha256),
  a codec (msgpack/LZMA-style). These are real workloads, not asserts.
- Ignore AS's actual center of gravity — **blockchain smart contracts** (NEAR,
  The Graph, Koinos, Substrate, eWasm = ~15 of the 81 showcase entries). jz has
  no determinism/gas/host-ABI story for chains and shouldn't grow one. Not jz's
  market; do not follow AS there.

### AS "built-with" inventory, bucketed by relevance to jz

| AS category | Examples | Relevance to jz |
|---|---|---|
| Blockchain / smart contracts | NEAR SDK, graph-ts, Koinos, Substrate, eWasm | **None** — out of scope, don't chase |
| Build tools / loaders | rollup-plugin-assemblyscript, as-loader (webpack), Zwitterion, visitor-as | **High** — jz gap to close (see §3.1) |
| Codecs / serialization | json-as, as-proto, as-msgpack, as-bson, karmem, AS-LZMA | **High** — direct overlap, demo material (§2 G) |
| Crypto / hashing | as-sha256, superfasthash, WASM-Crypto, rabin, xoroshiro128 | **High** — pure integer compute, jz's floor |
| Math libs | as-bignum, as-big, galois (finite fields), merkle | Medium — jz lacks bigint; finite-field/merkle fit |
| Emulators | wasmBoy (Game Boy), Atari 2600, ZX Spectrum | **High** — emulator core = integer dispatch = jz (§2 F) |
| Graphics / rendering | as-smallpt (path tracer), GLAS (three.js port), seam-carving | **High** — path tracer & seam-carving are demo gold (§2 C/I) |
| Games | chess, gomoku, js13k game | Medium — jz isn't for full games; kernels yes |
| Audio / DSP | WebAssembly Music Experiment (live-coding sequencer), Hoofdkantoor demo | **High** — jz's primary audience (§2 B/H, §3.2) |
| Image processing | pixelmatch, seam-carving | **High** — per-pixel compute, visual (§2 I) |
| Embedded / IoT | wasm3-arduino, RGB lamp | **High** — but jz wins differently: AS's wasm3 path *interprets* WASM on-chip; jz AOT-compiles to native via wasm2c (§3.6) |
| Testing frameworks | as-pect, envy, as-tral | None — jz uses JS tooling natively (it *is* JS) |

The headline: AS earns its keep in **blockchain** (irrelevant to jz) and in
**compute kernels / codecs / emulators / DSP / graphics** (jz's exact strength,
and where jz wins the "but it's plain JS" argument). Compete on the second list,
ignore the first.

Source: <https://www.assemblyscript.org/built-with-assemblyscript.html>

---

## 2. Astonishing examples — gallery shipped, two flagships open

The "next batch" has largely **shipped**: the gallery now spans ~70 demos in
`examples/` — attractors + lorenz (was A), raymarcher + raytrace (C), diffusion +
lenia (D), boids + swarm + slime (E), dithering (I), rfft spectrogram (H), and
many more — plus the floatbeat playground (`floatbeat/`, B) and a WAT-showing
REPL (`repl/`). Each is a `kernel.js` + `build.mjs` + `index.html` + `test.mjs`
folder carrying the JS⇆jz-WASM toggle. The example axis is **no longer the gap**;
two high-value kernels remain unbuilt, each worth it for the specific argument it
wins:

**F. CHIP-8 (or tiny Game Boy-ish) emulator core.** An emulator CPU loop is pure
integer dispatch — jz's floor. CHIP-8 is a few hundred readable lines and runs
real ROMs. *Whoa:* "I wrote an emulator in plain JS and it runs at native speed."
Mirrors AS's wasmBoy showcase, in JS.

**G. QOI image codec (encode + decode).** The "complete, useful, tiny" demo —
QOI's reference is ~300 lines of simple logic, trivially in-subset. Competes
head-on with surma's hand-WAT `miniqoi` (904 B) on *size* while staying readable
JS. Drag an image → watch it encode. Ties into the user's color-space work.

### Cross-cutting demo pattern — the toggle and the gallery

- Every demo ships a **"JS ⇆ jz-WASM" switch** that swaps engines on the *same
  source* and shows a live FPS **and per-frame compute-ms** (ms is the honest
  metric — FPS lies under a vsync cap). The switch is unique to jz: identical
  source on both sides. It does *not* promise a uniform win — show the real ms
  and let it land where it lands (jz wins transcendental-heavy work, ties/loses
  pure-arithmetic loops to V8's JIT). The proof is "same source ⇆ 9 KB WASM,"
  not a fabricated speedup.
  - ✅ **Shipped & verified:** the switch + FPS/ms HUD (shared loader/HUD in
    `examples/lib/jzdemo.js`) is the gallery standard across `examples/`, incl.
    `examples/rfft/` (floatbeat tune → live jz-computed spectrogram + waveform
    overlay + wavefont bars + click-to-shuffle + live code panel). The HUD's FPS
    line is a **linefont sparkline** (each glyph a sample, ligatures join them
    into a continuous chart) on an absolute scale, so it tracks the true fps level
    and steps when the engine is swapped. `npm run build:examples` is green.
- The **remaining greenfield** is the unifying **playground site**: one URL that
  threads the gallery + floatbeat + the WAT REPL into shareable permalinks. The
  pieces exist (`examples/`, `floatbeat/`, `repl/`); the single front door that
  makes the world know jz does not yet. The demo *is* the marketing.

---

## 2A. Useful tools (returnable, not just demos)

A demo earns a tweet; a tool earns a bookmark and a backlink. Tools drive
adoption *and* prove jz is good, because a tool gets used in anger.

**The wedge:** compute that today sits behind an **upload, a paywall, or a native
install** — run it locally, free, private, instant, in plain JS.
- *Privacy* — no upload (decisive for images/audio/documents).
- *Free / unwalled* — no watermark, no "pro" tier, no rate limit.
- *Instant / offline* — no roundtrip, works on a plane.
- *jz's part* — fast enough in-browser where plain JS would stutter; small enough
  to load instantly.

Proven appetite: Google **Squoosh** (local image compression, Rust/C wasm) is
loved precisely for "no upload." jz isn't "first" there — it wins where the niche
is **underserved**, where **readable/forkable/tiny** matters, or where it's the
author's **own domain**. Constraint: jz is the compute core, not the UI — each
tool is a thin JS+canvas shell over a jz kernel (matches "kernels, not apps").

### Tier 0 — author already owns every piece (lowest effort, highest trust)
The workspace holds a full audio pipeline: `audio-decode`, `audio-filter`,
`digital-filter`, `pcm-convert`, `periodic-function`, `audio-effect`,
`web-audio-api`.
- **Browser audio workbench** — drag a file → decode → EQ/filter (digital-filter
  biquads) → effects (reverb/bitcrush/saturation, audio-effect) →
  resample/convert/normalize-LUFS (pcm-convert) → export. AudioWorklet on
  jz-compiled kernels. Returnable, private (vs sketchy upload-based converters),
  dogfoods jz on its primary audience. **The useful flagship.**

### Tier 1 — universal utilities (high search traffic, self-contained)
| Tool | Why returnable | jz fit / reuse |
|---|---|---|
| **QR generator/decoder, tracker-free** | Universal; most online ones track/ad | Reed-Solomon + bit masking = pure integer, jz's floor |
| **Local image converter/optimizer** (PNG/JPEG/WebP/QOI + dithering) | Squoosh-class; privacy wedge; dithering/QOI underserved | per-pixel + codec; reuses color-space |
| **Function plotter / "compile your math"** (`f(x,t)` → compiled → plotted) | Desmos-lite people return to | expression→WASM = the literal jz pitch ("faster than eval") |
| **Color/palette tool** (OKLCH↔hex, palette extraction, contrast/CVD sim) | designers use daily | k-means/median-cut; reuses color-space |

### Tier 2 — underserved niches (small crowds, deep loyalty, little competition)
- **Voronoi stippler → pen-plotter SVG** — AxiDraw/plotter crowd lacks free tools, returns per piece; weighted stippling is compute-heavy.
- **Bitmap → SVG tracer** (potrace-like) — laser/vinyl-cutter, logo crowd.
- **Pixel-art upscalers** (EPX / scale2x / xBRZ-lite) — emulator/pixel-art community.
- **Cymatics / harmonograph / guilloché** — beautiful *and* practical (guilloché = the curve family on banknotes/certificates; designers want a generator). Pure math.
- **WFC (Wave Function Collapse) tile generator** — heavily used in gamedev procedural generation.

### Tier 3 — industry verticals (quiet infrastructure; build only when a user pulls)
Finance/quant (Black-Scholes / Monte Carlo / EMA-RSI), GIS (Douglas-Peucker
simplify, MVT vector-tile decode, projection), fabrication (G-code optimize, STL
parse, mesh repair), scientific "MATLAB-in-browser kernels" (RK4 ODE, FFT,
least-squares fit), bioinformatics (Smith-Waterman alignment).

**Out of scope:** anything ML (background removal, OCR, LLM inference) — out of
subset, not jz's win. LLM token counter is trendy but needs a multi-MB vocab blob
that fights the "tiny" story.

### Demoscene + js13k / Genuary — a *culture* fit, not just a feature
jz fits the demoscene's value system (minimal, tiny, raw math, no framework, no
runtime). Two hooks: **tiny WASM output** (close to hand-WAT, < AS) → sizecoding
pitch; **same-source JS↔WASM** → prototype in browser, ship compiled.
- **Venues:** Pouët.net (the hub), **Dwitter** (140-char JS) + **tixy.land**
  (16×16 formula art) — sizecoding *in JS already*, so jz powers "tixy/Dwitter but
  compiled"; **Lovebyte** (sizecoding party); Revision/Evoke/Assembly.
- **JS13kGames** (≤13 KB zipped, annual): jz is the **compute kernel** (gen /
  physics / audio synth) compiled tiny — "spend your 13 KB on content, not on a
  slow JS physics loop." The DOM/canvas glue stays JS (not jz's job).
- **Genuary** (daily generative-art challenge each January, thousands of
  participants): a "jz Genuary starter" rides an annual wave straight into the
  genart community.
- **floatbeat/bytebeat** (§2 B) is *literally* sizecoding-music — one artifact
  serving vibecoders, musicians, and the demoscene at once.

### Recommendation
Build **one** useful flagship now, ride **one** culture wave:
1. **Audio workbench** (Tier 0) — owns all pieces, primary audience, dogfoods jz.
2. **floatbeat playground** doubles as the demoscene/Genuary entry (same artifact).
3. Keep **QR** + **local image/dither** as quick universal wins.

---

## 3. Integration / affect map

Conceptual frame: jz's affect area is **anywhere people want native-speed compute
from plain JS in a constrained / sandboxed / portable form.** Mapped by host,
prioritized.

### 3.1 Build-tool plugin via unplugin — *highest leverage*
One `unplugin-jz` covers Vite + Rollup + webpack + esbuild + Rspack at once. Mark
a file/function (`import { fib } from './fib.js?jz'`), get WASM at build time. This
is the "extract and compile fast pieces" + "template tag as a build step" idea
made real, and it leapfrogs AS (which ships separate rollup-plugin + as-loader).
Zero workflow change for the dev; hot paths silently become WASM. **Build this.**

### 3.2 AudioWorklet / Web Audio
Write an `AudioWorkletProcessor.process()` in plain JS; jz compiles it to WASM in
the worklet thread. This is genuinely painful today (Rust/AS + bindings). Pairs
with the user's own `web-audio-api` project as the showcase. Primary audience,
high trust.

### 3.3 EdgeJS (done) + the wider edge/plugin runtime field
EdgeJS (wasmerio) integration is already landed (PR + smoke tests, per todo). It's
one point in a field jz fits natively because pure modules emit import-free WASM:
- **Extism** — *the* plugin-WASM framework; plugins are tiny modules on a simple
  host ABI. "Author Extism plugins in plain JS" is a strong, underserved niche.
- **Cloudflare Workers / Fastly Compute / Deno / Wasmtime / Wasmer / Spin** —
  "write a fast edge function in JS, ship standalone WASI WASM."
- Affect: jz becomes the no-Rust on-ramp for the edge-WASM crowd that explicitly
  doesn't want to learn Rust/C (noted in marketing.md).

### 3.4 WASM-4 fantasy console — *fun, viral, an actual gap*
WASM-4 supports AS, C, D, Go, Nim, Odin, Rust, Zig, WAT — **no plain-JS path**
(AS is the closest, and it's a TS dialect). A cartridge is just a WASM exporting
`start`/`update` against a memory-mapped 160×160 framebuffer + a few imports —
which is exactly jz's shape (small WASM, host imports, shared memory). A
`jz-wasm4` template + two sample games = "write retro games in plain JS,"
direct AS-territory, hacker/funky-coder catnip.

### 3.5 Live-coding & creative-coding hosts
Hydra, Strudel, p5.js, canvas-sketch, Observable. jz as the **compile-your-hot-
loop escape hatch** inside these environments. The enabling property is "compiles
faster than eval" (currently commented out in the README — worth proving and
un-commenting). Creative devs + vibecoders.

### 3.6 Embedded / microcontrollers — jz → native, no interpreter
The honest differentiator, and a real gap. Existing ways to "run JS on a
microcontroller" — **Espruino, Moddable XS, wasm3-arduino** — all ship an
*interpreter* onto the chip: JS (or WASM) is parsed/dispatched at runtime, paying
interpreter overhead and RAM for the VM. jz takes the opposite route:

```
jz program.js --host wasi → program.wasm
wasm2c / w2c2 → program.c
arm-none-eabi-gcc / esp-idf / avr-gcc → flash
```

The chip runs **native machine code** — zero interpreter, zero on-chip runtime.
You write a control loop / sensor filter / DSP kernel in plain JS and it ends up
as a compiled function in the firmware. Already half-documented (README wasm2c
FAQ); this reframes it as a first-class target.

**The f64 reality (decides which boards fit):**
- **Best fit — Cortex-M7 (Teensy 4, Daisy Seed):** double-precision FPU, so jz's
  f64-everywhere model runs at full speed with no penalty. This is the audio-DSP
  sweet spot: Daisy (STM32H7) and Teensy are where people *already* hand-write
  C++ DSP and would happily take plain JS instead.
- **Good — Cortex-M4F / ESP32 / RP2040 (M0+ via lib):** single-precision FPU;
  f64 is software-emulated but workable for non-tight loops; i32 kernels are
  native-fast.
- **Out of scope — AVR Uno (8-bit, no FPU):** software f64 is large and slow;
  only `|0`-narrowed integer kernels make sense, if at all. Document, don't chase.

**Constraints to nail (all already within jz's model):**
- Compile **pure-compute** (`alloc: false`, no WASI imports) → the C has no
  allocator, no host shim — just functions. This is the clean MCU shape.
- Heap-using modules need a static memory region + a documented RAM budget; the
  bump allocator maps fine to a fixed arena. w2c2 (C89, ~150 KB runtime) is the
  small target.
- Reuse the existing wasm2c/w2c2 integration-test pipeline as the build harness.

**Flagship proof:** digital-filter biquad (the user's own lib) → jz → C → Daisy
Seed / Teensy with live audio out. DSP-on-MCU is jz's single strongest embedded
story — compute-bound, f64-friendly on M7, and aimed at an audience that already
writes exactly this in C++.

Plus the desktop/server side of the same path: jz → C → a native `.so`/binary
embeddable in C / Rust / Python — hacker/embedded reach without jz ever growing
its own native backend.

### 3.7 Dogfood the author's own libraries — *highest-trust proof*
`color-space`, `digital-filter`, `web-audio-api` (all in the workspace). Ship
their compute cores on jz. This is the "integrations as validation" todo item and
the most credible benchmark: the author's published libs measurably faster.

---

## 4. Promotion across the dev spectrum

Reach/channel map across the full spectrum (the conversion-ranked persona detail —
desires, objections, ship-likelihood — is canonical in [`marketing.md`](marketing.md)
§1; this table is the broader who-to-reach-and-where view).

| Audience | Hook | Vehicle | Where they live |
|---|---|---|---|
| **Serious devs** | "Compile your hot path to WASM without leaving JS" | unplugin-jz, AudioWorklet, QOI codec, bench post (native-C parity) | HN "Show HN", lobste.rs, perf blogs |
| **Creative devs** | "Push 100k particles live; same code" | attractors / reaction-diffusion / boids gallery, p5 + canvas-sketch integration | fxhash & genart circles, awesome-creative-coding, mattdesl-adjacent |
| **Funky coders** | "Retro games & dithering in plain JS" | jz-wasm4 template, dithering/CRT filters, sizecoding angle (tiny WASM) | js13k, sizecoding/lovebyte, demoscene |
| **Hackers** | "Plug fast JS anywhere — edge, native, plugins" | Extism plugins, wasm2c → native, metacircular jz-compiles-jz | HN, lobste.rs, WASM/Recurse crowd |
| **Vibecoders** | "Type a formula, hear music, share a link" | floatbeat playground, live-coding REPL, tweetable permalinks | X/Twitter demos, Dwitter-style shares |

**The one move that compounds:** the playground site (§2). A single URL that
demonstrates the magic in five seconds and hands every visitor a shareable link.
Per the design principle — the ideal machine is no machine: the best marketing is
the demo itself.

---

## 5. Recommended next actions (reconciled)

1. **AS-parity todo — closed** per the §1 verdict (no test port). The AS showcase
   kernels still worth adding to `bench/`/`examples/` are an emulator core (F) and
   a codec (G/QOI).
2. **Examples — shipped.** Attractors, raymarcher, diffusion/lenia, boids, rfft,
   dithering and ~60 more are live in `examples/`, all carrying the JS↔WASM toggle;
   the RFFT kernel beats V8 1.69–1.74× via auto i32-index narrowing
   (`examples/rfft/bench.mjs`).
3. **Floatbeat playground — shipped** (`floatbeat/`): the vibecoder + live-coding +
   audio proof in one artifact.
4. **`unplugin-jz`** — still the highest-leverage *open* integration; turns jz into
   a drop-in build speedup with zero workflow change.
5. **Dogfood** color-space / digital-filter / web-audio-api as the trust anchor —
   still open, and (with unplugin) the move that manufactures real-adoption proof.
6. **Unifying playground site** — thread the shipped gallery + floatbeat + REPL into
   one shareable front door (§2).

Out of scope, explicitly: blockchain/smart-contract anything; porting AS's unit
tests; chasing full-app frameworks (jz is for kernels, not UIs).
