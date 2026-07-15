# jz — promotion & adoption strategy

*2026-07-01. Evidence-based: VOC research (verbatim quotes, sourced), competitor
positioning scan (live pages, verified), and adoption-history research on 10
comparable dev tools (verified mechanics, founder mythology flagged). Personas
canonical in [`marketing.md`](marketing.md); integration surfaces in
[`ecosystem.md`](ecosystem.md). Goal unchanged: **real adoption** — kernels
shipped with jz — not stars.*

---

## 0. The strategic core

Both target personas want the **same thing, and it is not speed**:

> *"the whole framework… compiled… in the same context and language… no painful
> communication"* — Babylon.js maintainer thread
> *"Maybe the problem is that we were writing slow JavaScript"* — videocall.rs,
> after trying Rust→wasm and **reverting**

The desire is **one codebase** — no second language, no second toolchain, no
second test suite. Speed is the *proof*, not the pitch: this market is at
sophistication level 4–5 (Schwartz), numb to multipliers — *"C/Rust is roughly
three times as fast as V8… there is not much room left"* (HN, Porffor thread);
*"WASM isn't automatically faster — it's just more predictable"* (videocall.rs).

**Corollary: this market cannot be reached by claims at all.** Every verified
adoption precedent (ripgrep, Ruff, esbuild, Zig, htmx, SQLite) converts through
artifacts and third-party proof, never through the author's promotion. htmx's
creator says this outright: his own marketing was *not* the mechanism — a
stranger's conference talk was. So the strategy is not "market jz better."
It is: **manufacture proof objects that other people carry.**

---

## 1. Positioning decisions (locked)

| Decision | Choice | Why (evidence) |
|---|---|---|
| Category | **"AOT JS→WASM compiler for numeric code"** — big fish, small pond | Every alternative label fails the buyer-assumption test: "JS compiler" collides with Porffor/Static Hermes and implies full-JS; "wasm toolchain" reads as Emscripten-class glue infra; "AssemblyScript alternative" cedes the frame to the incumbent's audience |
| Headline mechanism | **"valid jz is valid JS" / "the same file"** | Verified unclaimed: zero competitors can say it (AS = dialect that can't run as JS; MoonBit/Grain/Rust/Go/Zig = other languages; Porffor/Javy don't market it; Javy ships an interpreter) |
| Trust argument | **"Your existing test suite is the compiler's test suite"** | Novel — no competitor frames correctness this way. It converts jz's differential-testing reality into the single most disarming answer to "is this another AS-style trap?" |
| Audio claim | **Worst-case floor, not average speed** — "no GC pause can hit `process()`" + the loading story (compile in main thread, postMessage bytes, *sync* instantiate — no fetch, which `AudioWorkletGlobalScope` forbids) | Unclaimed by anyone surveyed; matches the persona's actual diagnosed failure mode (missed ~3 ms deadlines), and the loading friction is what made a real team abandon Rust→wasm |
| Risk reversal | **Ejectability: "remove jz and your code still runs — it's still JS"** | The structural guarantee no rival can copy. Answers Endowment + Uncertainty (REDUCE) and the bus-factor objection ("solo maintainer, v0.8") in one sentence |
| Honesty as position | **Losses published, on purpose** | Unique in the category — every rival's bench page shows only wins. In a claims-fatigued market, published losses are what made ripgrep/Ruff trusted |

**Never lead with:** speed multiples, "compiles to WebAssembly", "small
binaries", bare "no runtime / no GC", bare "ahead-of-time" — all verified worn
(every competitor says them; buyers discount them equally). Numbers appear as
*proof under* a mechanism claim, never as the claim.

---

## 2. The play — three proof engines

### Engine A — the Kernel PR *(the Ruff→pandas move)*
**The unit of adoption is one merged PR** into an existing library: swap one hot
*batch* kernel to a jz-compiled wasm build with JS fallback — same source file,
differential test in CI, revertible in one commit. Because valid jz is valid JS,
the PR adds **zero second-source burden** — that's what makes it mergeable where
every Rust/AS port PR died.

- Ruff's real proof was pandas/FastAPI/SciPy PRs, not the launch post. Each
  merged PR makes "Used by" true, is public, checkable, and is *someone else's*
  repo vouching.
- **Batch kernels only.** The boundary tax is the documented killer — gl-matrix
  (toji): per-call `vec3.add` "extremely hard to break even." Never pitch
  per-call shapes; pitch loops (resample, propagate-all, encode-frame,
  hash-buffer).
- **Etiquette (one shot each):** answer a thread's exact question with a working
  artifact, once, honestly, with the losses; accept "no" gracefully. The
  Dream-100 inboxes below are *documented-pain threads where they already asked*.
- Enhancer: a tiny differential badge for adopters ("kernel: JS ⇆ wasm,
  bit-exact") — Public + Social-Currency levers (STEPPS) that make the adoption
  visible to the next maintainer.

### Engine B — the Engine Inside *(the esbuild-in-Vite / sharp-in-Next move)*
Become the invisible compile step of someone else's tool, so users adopt jz
transitively with **no trust decision of their own**:
1. **`unplugin-jz`** — the wasm-bundler wound is documented and named
   (brotli-wasm#8: "affects all Vite users for all wasm-pack projects";
   hash-wasm base64-embeds its binary + eats a 10× cold-start to dodge it).
   **Prototype shipped locally (`~/projects/unplugin-jz`, 2026-07-15):** a
   `kernel.js?jz` import compiles an import-free numeric kernel at build time,
   inlines the bytes, and instantiates synchronously; real Rollup/Vite/esbuild
   builds pass. Next boundary: emitted asset mode, bundled source imports, and
   boxed-value interop.
2. **Dogfood own libs.** **color-space v3 now ships this proof:** its 27-space
   `color-space/wasm` backend is built by JZ from valid JS into an import-free,
   precompiled module, with scalar↔WASM parity tests. digital-filter and
   web-audio-api remain open; each library's users become transitive jz users.
3. **Audio workbench / AudioWorklet template** — the worklet loading story
   (sync instantiate, no fetch) productized as a 30-line template.
4. Seasonal culture rides: WASM-4 / godot-wasm templates, js13k (August),
   Genuary (January) — cheap, demo-native, sizecoding-aligned.

### Engine C — the Same-File Post *(the ripgrep/Ruff move)*
One rigorous post per persona wedge — **artifact first, then post**, losses
included, methodology linked, self-submitted to HN. Verified: this exact move
worked from zero audience for ripgrep (day-1 front page, 25 reproducible
benchmarks, showed losses) and Ruff (named multiples per competitor,
`pip install` ready at post time).

1. **The audio wedge post:** *"They rewrote their audio engine in Rust — then
   went back to JavaScript."* Opens on the videocall.rs story (their words),
   names the two known solutions (allocation-free JS discipline / Rust→wasm and
   its worklet-loading wall), introduces the third option with a live worklet
   demo. This is the Schwartz-correct move: the audio persona is Solution-Aware
   of *other* categories — the post's job is to make jz's category exist in
   their head, opening on *their* conversation, not the product.
2. **The bench post:** *"The same JS file, run five ways"* — one kernel, run as:
   V8 / jz-wasm / Rust-wasm / AS / C-wasm; the CI-gated geomean table, wins and
   losses, full method, run-it-yourself link. Flat tone, zero editorializing
   (the anti-benchmark-war discipline that kept ripgrep/Ruff credible).

**Timeline honesty:** ripgrep-speed virality applies to drop-in replacements for
a daily verb; jz is a new category for a narrow niche — the verified analogue
timeline is Zig/htmx: **the unsolicited-adopter moment takes 1–2+ years** of
artifact-dense patience. Plan cadence for that, not for a viral week.

---

## 3. Sequence — what unlocks what

**Phase 0 — legibility (days).** The demo must be *legible as proof* before any
post. Site-audit-verified (2026-07-01, details in `marketing.md` §2′).
Shipped by 2026-07-15: og:image regenerated (was v0.7.0 + old numbers), hero
install chip (>960px; stacked layouts keep the CLI-section chip), ejectability
line in the production-ready FAQ, H1 → "Same JS, native WASM" (mechanism-first),
color-space v3 real-use proof, "MIT" link beside ॐ in the footer, GitHub
Discussions, aligned npm/tag/GitHub releases, and live nav versioning. Still
open: REPL copy-link button (hash-state already works, the affordance is
missing); worst-case-floor line.

> **Owner decision (2026-07-01): audio artifacts — floatbeat, jukebox/zzfx/rfft
> gallery entries, the audio wedge — are DEFERRED.** They belong to the coming
> **audiojs ecosystem** (or a separate project); linking them from jz now would
> dilute attention. Consequence: Phase 1's audio wedge waits for audiojs; until
> then the active engines are B (unplugin-jz, dogfood) and C post #2 (the bench
> post), with Kernel-PR targets drawn from the non-audio Tier-1 list
> (satellite-js, hash-wasm, jimp).

**Phase 1 — the audio wedge (weeks).** AudioWorklet template + biquad/minisynth
worklet demo above the fold; the loading-story doc; then Engine-C post #1;
simultaneously the passive seeding from the June research: Web Audio Weekly,
JavaScript Weekly, Changelog News, wasm-weekly (if alive), awesome-webaudio
(propose "Performance / WASM" section, be its first entry), awesome-wasm,
awesome-compilers.

**Phase 2 — friction to zero (active).** `unplugin-jz` has a working inline,
sync-instantiation prototype; color-space v3 is the first shipped internal-use
proof and is now credited in the README/site. Next: prove emitted-asset vs inline
tradeoffs, then dogfood digital-filter; document sync instantiate / no async init
as a first-class feature.

**Phase 3 — Kernel PRs (months).** 3–5 Dream-100 attempts, one at a time, each
a complete artifact (fork + kernel swap + differential test + honest bench on
*their* corpus). Support — never ghostwrite — any adopter willing to write or
talk about their own result (the htmx inflection was a third party's talk;
Zig's was TigerBeetle's own posts).

**Ongoing.** UDF surfaces (ecosystem §3.8) as S-effort standalone artifacts;
the two free GitHub-issue comments (libSQL#1, datafusion#9326); watch for the
**adjacent-community surprise** — htmx broke out in Django, not JS; jz's
equivalents to watch: embedded/Daisy-Teensy DSP folks, Rust devs wanting
GC-free scripting, CS/compiler educators.

---

## 4. Objection → artifact map

Every verified objection gets an *artifact*, not a rebuttal. (VOC-sourced,
their words compressed.)

| Objection (verified) | Artifact that answers it | Status |
|---|---|---|
| "f64-only — my DSP needs int/bit-exact math" | bitwise/crc32/hash/bytebeat bench cases (bit-exact, published) + an "integer reality" README section: i32 narrowing is inferred, `Math.imul`/shifts/masks are native | bench exists; doc section to write |
| "no GC = the crash is just delayed — what about hours-long sessions?" | arena/`_clear` reset pattern doc + a soak demo (jukebox running hours, flat memory graph) | to build; jukebox is close |
| "the plumbing (MIDI/UI/ports) still needs JS — you only shrank the dual-codebase problem" | honest-boundary doc: jz owns the kernel, JS owns plumbing — that's the design, shown in the 30-line worklet template | to write |
| "sounds like AssemblyScript's pitch; that turned out to be a dialect trap" | the differential proof: same file, `node test` + wasm test in CI, bit-exact; test262 numbers; **"your test suite is the compiler's test suite"** | CI exists; needs surfacing as the badge/claim |
| "experimental, solo maintainer, v0.8 — I watched AS go quiet" | ejectability guarantee (it's still JS — removal is a one-line build change) + self-hosting + pin-version guidance | one paragraph, to add |
| "cold compile slower than `new Function` — livecoding jank?" | compile-once/hot-swap pattern + measured compile-ms in the REPL; floatbeat *is* the live proof | floatbeat exists (unlinked) |
| "bundler/wasm loading hell (Vite, async init, base64 hacks)" | `unplugin-jz` + sync-instantiate doc (no fetch, no async init, no asset dance) | to build (highest leverage) |
| "geomean is cherry-picked — show me MY kernel losing" | losses published in the same table + "report a slow case" link (exists) + REPL "run your own kernel" | exists; keep loud |
| "JS↔wasm boundary tax killed it for us (small ops)" | *agree* — published guidance: jz is for batch kernels; per-call shapes stay JS. Saying this unprompted is a trust weapon | to write |

---

## 5. Dream-100 — first targets (documented pain first)

Tier 1 — **they already asked, in public** (the inbox exists):
| Target | Pain evidence | Fit | First move |
|---|---|---|---|
| Strudel / superdough (felixroos) | strudel#479: worklet perf/crackle on low-end hw, maintainer active | high — JS-native livecoding, batch DSP | working demo in-thread: one superdough voice as jz kernel, measured on a Pi |
| satellite-js | #148: ships a C++/Emscripten bulk API to get 3–12×; dual-maintenance pain explicit | high — batch SGP4 propagation is pure numeric | PR: same-source jz build of the bulk propagator + differential test vs both JS and C++ paths |
| hash-wasm (Daninet) | #12: 10× cold-start from base64+compile; maintains hand-written C | medium — integer hashing is jz's floor; author is wasm-fluent (skeptical, fair) | benchmark artifact first, PR only if numbers win incl. size |
| brotli-wasm users / httptoolkit | #8: the canonical Vite/wasm-loading saga | medium (codec complexity) — but the *bundler story* is the pitch, via unplugin-jz | cite thread in unplugin-jz README; comment once when plugin ships |
| jimp | #833: wanted wasm, AS port found no win; ships wasm codecs only | medium — per-pixel batch ops fit; core team burned once (lead with losses) | standalone bench on their blur/resize kernel; open issue only with numbers |
| Web Audio Weekly / awesome-webaudio | curated inboxes, sharpest persona concentration | high | submission + PR (from June plan) |
| WebAudio spec-adjacent devs (goldwaving et al., #2632) | years of production crackle documented | high empathy, wrong ask (they want the API fixed) | don't pitch the thread; write the wedge post *about* the pain, let it travel |
| simple-statistics | archived 2017 wasm attempt; chose plain-JS algo fixes | low-medium — descriptive stats are batch | qualify first: bench their percentile/regression kernels |

Tier 2 — qualify before approach (fit likely, pain not yet documented):
pica (batch image resize), image-q (quantization), jsQR / zxing-js (integer
scanning), fft.js / dsp-kit, ml-matrix (batch linalg), delaunator (Voronoi
crowd), upng/uzip, zzfx/ZzFXM (sizecoding audio), Tone.js internals,
Elementary Audio community, glicol, Max/MSP v8 users, Observable notebooks
(plot/simulation kernels).

Anti-targets (evidence says no): **gl-matrix** and any per-call math lib — the
maintainer's own analysis is the definitive "boundary tax" no; **harfbuzzjs**
(text shaping is out of subset — but keep the Photopea signal: real buyers set
*size budgets* (150–200 kB zipped) that jz beats by 15–100×; use as positioning
ammo, not a target); Shopify Functions full port (subset mismatch — the Javy-3×
quote is ammo, not a market).

Rule: **one Tier-1 target at a time**, complete artifact each, no simultaneous
scatter (Hormozi's dilution warning applied at solo-dev scale).

---

## 6. Spreadability by design (STEPPS, applied to the two shareable artifacts)

- **Floatbeat permalink** = the viral object: Practical Value (hear it now) +
  Public (the link is the demo) + Social Currency (*"this 80-char formula is
  583 bytes of wasm compiled in my tab"*) + Story (type → hear → tweak). The
  permalink is non-negotiable — without it every share costs a re-type.
- **The bench table** = the skeptic's object: Social Currency for the sharer is
  the *honesty* ("they publish their losses"), which is also the differentiator.
- **Trigger** to own long-term: every time a dev hears "GC pause / audio
  glitch / worklet", jz should be the association. That's what the wedge post,
  the template, and the awesome-webaudio entry all reinforce — one trigger,
  many surfaces.

## 7. Metrics & cadence (real adoption, not vanity)

- **North star: merged kernel PRs / projects shipping jz.** Honest targets:
  1 within 6 months, 3 within 12. (Zig/htmx timeline, not ripgrep.)
- Supporting: unsolicited issues/PRs from strangers; REPL/floatbeat permalink
  shares observed; npm weekly downloads *trend* (ignore spikes); "report a slow
  case" submissions (each one = an engaged skeptic).
- Explicitly not metrics: stars, likes, PH rank, HN points.
- Solo-dev allocation: artifact-building ≥ 80%, posting ≤ 20% — the htmx
  lesson says over-investing in self-promotion is the wrong allocation.

## 8. Anti-patterns (verified, from the precedent research)

1. **No ProductHunt / PR-agency launches** — zero verified success cases among
   comparable niche dev tools; structurally vanity-metric machinery.
2. **No benchmark trash-talk** — flat tables, competitor numbers presented
   neutrally; editorializing is what gets torn apart on HN.
3. **No overclaiming completeness** — keep the honest-limits section forever;
   Ruff/esbuild listed missing features at launch *on purpose*.
4. **No post before the artifact runs** — a number without a runnable repro is
   a liability; jz's CI-gated bench already meets the bar — never drift.
5. **No Bun-myth emulation** — Bun was 3 years YC-funded with an audience;
   citing it as a solo-dev template is citing the wrong case.
6. **No spray-posting the Dream-100** — one thread, one artifact, one honest
   message; a "no" is data, not an invitation to argue.
