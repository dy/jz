# jz — recovered todos (clean)

1st-level open tasks recovered from the pre-`db9911bb` `todo.md` (working log
archived in `.work/archive-todo-2026-07.md`). The compact rewrite kept only the
kernel/perf ledger and dropped every forward-looking section below — recovered
here. Verdict/status prose and completed `[x]` items stripped; grep the archive
for the full dissection of anything that needs it.

## V1 (pinned)

* [ ] Beat all bench cases, all examples — the standing mandate (residual V2-class
  tails: shapes record layout, qoi branch-sched, sdf symbolic hull, ulam/raymarcher
  parity noise; tracked in `todo.md`).
* [ ] sourcemaps
* [ ] floatbeat
* [ ] color-space
* [ ] audiojs
* [ ] unplugin
* [ ] hsluv wasm — https://www.hsluv.org/implementations/
* [ ] jz-strict minimal exported subset (less than 100-200kb if possible)

## Floatbeat (name TBD)

* [ ] A codepen/codesandbox for sharing floatbeats with visualizations.
* [ ] Search — find floatbeats across platforms (scraper / live pull / cache).
* [ ] Visualizers (via jz or shaders): classic notes staff, Xenakis, log/mel spectrogram.
* [ ] Interactivity — synth, MIDI, randomization, simulations.
* [ ] An agent to help drive creation.
* [ ] Music-theory integration.
* [ ] Audio metrics.
* [ ] Output mastering params (maybe drop into wavearea for fragment editing?).
* [ ] Download a slice / fragment.

## Ship — flagship (the compounding "make-world-know" move)

* [ ] **Floatbeat playground** — type a formula, hear music; AudioWorklet, compiled
  live. Vibecoder + audio + live-coding proof in one. Needs: syntax highlight,
  waveform renderer, recipe-book/DB, samples collection, 1st-class waveform +
  spectrogram + artistic (Chladni) renderers, easy share (compressed code in URL),
  persisted samples. The point: an audiovis playground.
* [ ] Sponsor call (main page).
* [ ] **Examples** — each a high-quality, hero-screen-able, configurable piece of art
  with a lovely code editor + settings-panel side-menu; a few powerful boosted
  examples over myriads; all math examples educative + entertaining; "open in REPL".

## Reach — perception / proof (highest external leverage)

* [ ] **AudioWorklet + live in-browser REPL** — highest-leverage move. Demos ship
  pre-built `.wasm` (looks like AS's gallery); the differentiator (compiles in-browser)
  is invisible. ~30 lines: textarea → debounce → jz(src) → postMessage(bytes) →
  instantiate in worklet.
* [~] **unplugin-jz** — prototype in `~/projects/unplugin-jz`: `kernel.js?jz` compiles
  import-free numeric exports to inline sync-instantiated WASM; Vite/Rollup/esbuild
  pass, webpack/Rspack adapters exposed. Next: emitted-asset A/B, source-module graph,
  boxed-value interop.
* [~] **Dogfood own libs** — color-space v3 shipped (27-space `color-space/wasm`).
  Remaining: digital-filter biquad, web-audio-api, fourier-transform.
* [~] **REPL** — download wasm; show produced WAT; auto var→let / function→arrow on
  paste; auto-import implicit globals; resolve npm packages (url); document interop.
* [ ] **Extism plugin path** — author Extism plugins in plain JS; underserved niche.
* [ ] **WASM-4 fantasy console** — no plain-JS path today (AS/C/Rust/Zig/Go only);
  cartridge = wasm start/update over a framebuffer = jz's shape. Viral, direct AS turf.
* [ ] **Subtractive subset spec** — a written acceptance criterion (PARSE-2 is exactly
  what one would have caught).
* [ ] (later) live-coding hosts (Hydra/Strudel/p5/canvas-sketch) — jz as the
  compile-your-hot-loop escape hatch. Pitch: warm kernel speed + tiny portable wasm.
* [ ] vec4 package (unlocks SIMD); stdlib.io integration; glsl-transpiler.
* [ ] (later) dithering/convolution filters; water sim; text-layout algo;
  pinterest/fb-reels soundvis; math-formula soundvis; floatbeat reproductions.
* [ ] Enhance: settings-panel, palettes, meaningful UI/automation, file-drop inputs.
  Jukebox: more floatbeats, rotate (not random).
* [ ] https://github.com/thejustinwalsh/zzfx-studio

## Useful tools — returnable, not just demos

Wedge: compute behind an upload/paywall/install → run it local, free, private, instant.
jz = compute core, JS = thin UI shell.

* [ ] **Audio workbench** (Tier 0) — decode → EQ/filter → effects → resample/convert/
  LUFS → export, AudioWorklet on jz kernels. Reuses audio-decode / digital-filter /
  audio-effect / pcm-convert / web-audio-api. The useful flagship.
* [ ] **QR generator/decoder** — Reed-Solomon + masking = pure integer, jz's floor.
* [ ] **Local image converter/optimizer** (PNG/JPEG/WebP/QOI + dithering) — Squoosh-class
  privacy wedge; reuses color-space.
* [ ] **Function plotter** ("compile your math") — `f(x,t)` → compiled → plotted.
* [ ] **Color/palette tool** (OKLCH↔hex, extraction, contrast/CVD sim) — reuses color-space.
* [ ] (niche) Voronoi stippler→SVG · bitmap→SVG tracer · pixel-art upscalers (EPX/xBRZ) ·
  cymatics/harmonograph/guilloché · WFC tile generator; quant (Black-Scholes/MC) ·
  GIS (simplify/MVT) · fabrication (G-code/STL) · sci kernels (RK4/FFT/least-squares) ·
  bioinformatics (alignment).
* [ ] **Demoscene / js13k / Genuary** — tiny wasm = sizecoding hook; same-source JS↔WASM =
  prototype-then-compile. Pouët, Dwitter/tixy.land, Lovebyte, JS13k, Genuary starter.

## Embedded — jz → native MCU (AOT, no interpreter — the honest differentiator)

Path: `jz → wasm2c/w2c2 → C → arm-none-eabi-gcc / esp-idf / avr-gcc → flash`.

* [ ] **Target matrix + f64 reality** — best on FPU MCUs (M4F/M7: ESP32, RP2040, STM32,
  Teensy 4, Daisy Seed); M7 double-precision FPU ⇒ f64 unpenalized; AVR no FPU ⇒ i32-only
  or out of scope. Document it.
* [ ] **Pure-compute proof** — `alloc:false`, no WASI, scalar kernel → C → flash → verify.
* [ ] **Flagship: biquad on hardware** — digital-filter biquad → jz → C → Daisy/Teensy audio.
* [ ] **Heap + RAM budget** — pick a memory region; document RAM budget; w2c2 (~150 KB) runtime.

## Language coverage / correctness

* [ ] **Extension surface — still open** (designs recorded; plan doc gone):
  * async/await — parked by verdict (state machine + module/promise.js on a free NaN-box
    tag + microtask pump); open design: memory.reset() vs in-flight continuations.
  * generator methods (`class { *m() }`, `{ *g() {} }`) and `using`/ERM — parser-blocked
    upstream (subscript); lowering ready.
  * Workers: browser pool leg (jz.pool is node worker_threads today); shared-everything
    waits on the stdlib single-writer audit.
  * relaxed-SIMD opt-in (`relaxedSimd:true`) — flag only, never default (breaks bit-exact).
  * Float16Array — revisit when the wasm FP16 proposal ships (f16round already landed).
* [ ] **Date** — deterministic spec slices first; local-tz/Intl later.
* [ ] **Intl**; **test262** (know every fail by face — jzify or error cleanly, never fail
  unknowingly); **all AssemblyScript tests**; warn/error on memory-limit.
* [~] **jzify** — remaining: auto-import stdlib globals (Math.* → import math); then make jz
  core require explicit stdlib imports (remove auto-import); Crockford align.
* [ ] **Source maps** (blocked on watr upstream) — meanwhile add a WASM name section.
* [ ] **Math-kernel precision** — sin/cos/exp ~1e-9 vs libm (~30-bit); biquad cancellation
  amplifies it. Lever: compile-time rational simplification — carry `2πfc/fs` exactly, emit
  the cancellation-free form.
* [ ] **Self-host-only miscompiles, open** (bite only the wasm kernel, host is fine):
  * bare `return;` sibling + i64-carrier boundary wrapper traps OOB at kernel L2
    (test/parser-bugs.js:276).
  * `src/ir.js writeVar` emits invalid wasm in-kernel for `[a] = [7]` (destructuring
    assignment) and reassigned-param returns.
  * parked: SROA re-land (miscompiles m5_parse$expr in the kernel bundle — needs a flatten
    stack-shape audit).
* [ ] **EL-table size recovery** — full-range Eisel-Lemire costs 10.4 KB data; derive the
  reciprocal (negative-exp10) half at `__start` via 256÷128 long division from the positive
  5^q half instead of shipping it (~8 KB back for ~1 KB init code).
* [ ] **Number/parseFloat >19-digit midpoints** — crafted 20-digit midpoint literals need an
  arbitrary-precision slow path; implement big-decimal compare if a real workload hits it.
* [ ] **Self-host fragility guards, live** (each neutralized only at its one known trigger):
  Root F `.typed:[]` runtime-variable OOB index unchecked (silent adjacent-heap corruption);
  multi-prop spread `{...src,k1,k2}` HASH-vs-OBJECT confusion; same-scope for-of loop-var
  shadowing in-kernel. Contributor rule (ctx-literal field-set/order uniformity) → CONTRIBUTING.

## Compiler backlog — deferred-on-no-workload (YAGNI: build when a real bench surfaces the shape)

* [ ] **Stdlib-pull audit** — walk `module/*.js` for builtins emitting a polyfill where
  wasm-v1 has a native op / cheap fold (the `**0.5→sqrt` win, generalized). Gate on the
  builtin actually appearing in a kernel.
* [ ] **Representation carriers** (design: .work/research.md) — jsstring internal-locals flow;
  boundary string cache (by identity); schema-object field packing (i32/ptr, not f64-tag);
  typed-array element rep (auto Int32Array backing); closure-capture narrowing (i32 cell).
* [ ] **form-normalization folds** (lint) — `parseInt(intLit)` fold; `x=x` drop; `s+""` drop
  (only when statically STRING); `no-useless-return`. Defer until one is hot.

## Future

* [ ] Component interface (wit).
* [ ] **threads/atomics** — lower `Atomics.*` on shared typed arrays → wasm atomic ops;
  `memory:{shared:true}` → shared Memory; worker spawn stays host-side. Verify a real
  workload first.
* [ ] memory64 (>4GB); relaxed SIMD; WebGPU compute shaders.
* [ ] **wasm-gc backend** (`host:'gc'`) — orthogonal multi-month backend rewrite; benefits
  memory-model / externref / debugging. Reserved error today (index.js:315).

## Ideas

* [ ] webpack/esbuild/unplugin — extract & compile fast pieces with jz.
* [ ] AS integrations/plugins (assemblyscript.org/built-with).
* [ ] potrace playground.
* [ ] EdgeJS test/harness entry — only if it runs in their CI without large/optional deps.

## Demos / visualizers — no-GPU graphical uses

* [ ] Screensavers · NFT · Instagram minimalism renderers · xor shaders · demoscene
* [ ] winamp visualizers · classic audio visualizers · wave-osc visualizers
* [ ] DAW play visualizers (pitch bend) · musical visgens (windchimes, physical)
* [ ] ASCII renderers · SVG visualizer
