# jz — ecosystem audit & affect map

Answers the todo "AS ecosystem audit" plus the wider question: where does jz
overlap the WASM/JS ecosystem, what examples make it undeniable, and how does it
become known across the dev spectrum.

---

## 0. The lens (everything below is judged against this)

jz's irreducible magic is one sentence: **valid jz = valid JS.** You write plain
JS that runs in the browser today, and it compiles to tiny WASM at `clang -O3`
speed, with no annotations, no runtime, no toolchain.

The corollary nobody else can match: **the same source runs two ways — as JS and
as jz-WASM — so a speedup can be demoed honestly by flipping one switch.** AS
source isn't runnable JS; Rust isn't JS; emscripten isn't JS. Only jz can put the
*identical bytes* on both sides of the toggle. That toggle is the punchline of
every demo and the spine of the whole strategy.

A jz example is **astonishing** iff all five hold:
1. compute-bound, so the win is visceral (FPS / resolution / particle count / sample-rate jumps);
2. the kernel reads like plain JS any dev would write;
3. immediate sensory output (canvas pixels or audio), in real time;
4. small — the "tiny formula → native speed" feeling; ideally tweetable;
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

## 2. Astonishing examples (have 3, this is the next batch)

Current: game-of-life, interference, mandelbrot — all canvas + integer/float
loops. Solid but conventional. Each example folder is `kernel.js` + `build.mjs` +
`index.html` + `test.mjs`; reuse that shape.

Ranked by astonishment × fit × effort. Tier 1 = build next.

### Tier 1 — flagships

**A. Strange attractors** (Clifford / de Jong / Lorenz).
A 2-line float formula iterated millions of times paints a luminous structure.
Pure f64 — jz's literal sweet spot. The toggle is dramatic: 5M points/frame is a
slideshow as JS, smooth as jz-WASM. Tweetable source, mathematical beauty.
*Whoa:* "this entire galaxy is four lines of arithmetic."

**B. Floatbeat / bytebeat playground** (already on the roadmap — make it the flagship).
A one-liner `t => (t*((t>>12|t>>8)&63&t>>4))` becomes music; floatbeat (f64 in
[-1,1]) is jz's home turf. Type formula → hear sound, sample-accurate in an
AudioWorklet, compiled live (jz compiles faster than the audio buffer drains).
This is the single best vibecoder/musician hook and it doubles as the live-coding
proof. Shareable permalinks per formula.

**C. Software path tracer / SDF raymarcher** ("Shadertoy on the CPU, but fast").
A weekend-raytracer or SDF march loop in plain JS, progressive accumulation.
Astonishing precisely because "CPU ray tracing is supposed to be slow in JS." AS
ships as-smallpt; jz does it in *plain JS* and toggles against itself.

### Tier 2 — strong, build after Tier 1 lands

**D. Reaction-diffusion (Gray-Scott) / Lenia.** Continuous cellular automata —
Gray-Scott grows Turing patterns, Lenia grows things that look *alive*. Per-pixel
convolution per frame = compute-bound and mesmerizing. Lenia is the jaw-dropper.

**E. Boids / flow-field particles.** The canonical generative-art piece
(mattdesl / Tyler Hobbs territory): a simplex-noise flow field driving 100k+
particles. The particle count you can push live *is* the benchmark. Speaks
directly to the generative-art audience.

**F. CHIP-8 (or tiny Game Boy-ish) emulator core.** An emulator CPU loop is pure
integer dispatch — jz's floor. CHIP-8 is a few hundred readable lines and runs
real ROMs. *Whoa:* "I wrote an emulator in plain JS and it runs at native speed."
Mirrors AS's wasmBoy showcase, in JS.

**G. QOI image codec (encode + decode).** The "complete, useful, tiny" demo —
QOI's reference is ~300 lines of simple logic, trivially in-subset. Competes
head-on with surma's hand-WAT `miniqoi` (904 B) on *size* while staying readable
JS. Drag an image → watch it encode. Ties into the user's color-space work.

**H. Real-time FFT spectrogram.** Mic input → FFT → scrolling spectrogram. DSP
staple, compute-bound, real-time; squarely jz's primary (audio/DSP) audience.

**I. Dithering & convolution filters** (Floyd-Steinberg, ordered/Bayer, blur,
edge-detect). Drag image → instant filter. Dithering is visually striking and
retro-flavored (funky-coder bait); per-pixel compute.

### Cross-cutting demo pattern — the toggle and the gallery

- Every demo ships a **"JS ⇆ jz-WASM" switch** that swaps engines on the *same
  source* and shows a live FPS / sample-rate / particle-count counter. This is
  the honest, irrefutable speedup and it's unique to jz.
- The **vehicle** that makes the world know jz is **one playground site**:
  gallery (A,C,D,E,F,I) + floatbeat (B) + a REPL that shows produced WAT, every
  item a shareable permalink. The demo *is* the marketing. There is no
  `playground/` or `repl/` dir yet — this is greenfield.

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
  doesn't want to learn Rust/C (noted in research.md).

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

## 5. Recommended next actions (minimal first cut)

1. **Close the AS-parity todo** with the §1 verdict: no test port; add 2–3 AS
   showcase kernels (path tracer, emulator core, a codec) to `bench/`/`examples/`.
2. **Build Tier-1 examples** A (attractors) and C (path tracer) — both reuse the
   existing `build.mjs` + canvas pattern and need no new infra; add the JS↔WASM
   toggle to all three existing demos while there.
3. **Floatbeat playground (B)** — already roadmapped; promote to flagship, it's
   the vibecoder + live-coding + audio proof in one artifact.
4. **`unplugin-jz`** — highest-leverage integration; turns jz into a drop-in build
   speedup with zero workflow change.
5. **Dogfood** color-space / digital-filter / web-audio-api as the trust anchor.

Out of scope, explicitly: blockchain/smart-contract anything; porting AS's unit
tests; chasing full-app frameworks (jz is for kernels, not UIs).
</content>
</invoke>
