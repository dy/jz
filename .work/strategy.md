# jz promotion & adoption strategy

*Evidence-based: sourced VOC quotes, a live competitor scan, and 10 adoption precedents.
Personas in [`marketing.md`](marketing.md); integration surfaces in [`ecosystem.md`](ecosystem.md).
Goal: real adoption (kernels shipped with jz), not stars.*

## Roadmap (the steps, in order)

**Thesis:** this market cannot be reached by claims. Every comparable tool (ripgrep, Ruff,
esbuild, Zig, htmx, SQLite) converted through artifacts other people carried, never the
author's own promotion. htmx's creator says his marketing was not the mechanism; a
stranger's talk was. So the sequence is: make the demo prove itself, seed passively, become
someone's invisible compile step, post one honest artifact, then land real kernel PRs.

**Owner decision (audio deferred):** floatbeat, the audio wedge post, and Strudel-class audio
targets belong to the coming **audiojs** project, not jz. The active track below is the
non-audio path; audio moves are parked at the bottom of each phase, marked *(audio, deferred)*.

**Phase 0 · Legibility: the demo must read as proof [mostly shipped]**
- [x] og image, hero install chip, ejectability FAQ line, H1 mechanism-first ("Same JS, native WASM")
- [x] color-space used-by, MIT link, GitHub Discussions, npm/tag/release alignment, live versioning
- [ ] REPL copy-link button (hash-state already works; the affordance is missing)

**Phase 1 · Passive seeding: set-and-forget, low effort, do now**
- [ ] awesome-wasm PR; awesome-compilers PR (30 min each, permanent, compounding SEO)
- [ ] Newsletter submissions: JavaScript Weekly (`editor@cooperpress.com`), Changelog News, WASM Weekly (verify still alive first)
- [ ] *(audio, deferred)* awesome-webaudio "Performance / WASM" section; Web Audio Weekly

**Phase 2 · Engine Inside: transitive adoption, no trust decision by the user [active]**
- [ ] unplugin-jz: finish (emitted-asset mode, bundled-source imports, boxed-value interop) and publish. The bundler wound is documented (brotli-wasm#8 "affects all Vite users for all wasm-pack projects"; hash-wasm base64-embeds its binary to dodge it), so the plugin answers a complaint already being voiced.
- [ ] Dogfood digital-filter next (color-space v3 is the first shipped proof)
- [ ] Document sync-instantiate / no-async-init as a first-class feature

**Phase 3 · One honest post: artifact first, then post; self-submit to HN**
- [ ] Bench post, "The same JS file, run five ways": one kernel run as V8 / jz-wasm / Rust-wasm / AS / C-wasm; the CI geomean table with wins AND losses, full method, run-it-yourself link. Flat tone, zero editorializing. Then Show HN, r/WebAssembly, lobste.rs.
- [ ] *(audio, deferred)* Audio wedge post, "They rewrote their audio engine in Rust, then went back to JS" (opens on the videocall.rs story, a live worklet demo)

**Phase 4 · Kernel PRs: the actual adoption metric [months]**
- [ ] One Tier-1 target at a time, non-audio first: **satellite-js → hash-wasm → jimp**
- [ ] Each artifact: fork, swap one *batch* kernel to a jz build with JS fallback, differential test in CI, honest bench on THEIR corpus. Open one honest issue with the numbers and the losses; accept "no" gracefully.

**Ongoing**
- [ ] UDF examples (SingleStore / ScyllaDB, ecosystem §3.8); the two free GitHub-issue comments (libSQL#1, datafusion#9326)
- [ ] Support (never ghostwrite) any adopter willing to write or talk about their own result. The htmx inflection was a third party's talk; Zig's was TigerBeetle's own posts.

**Do NOT**
- [ ] **ProductHunt: skip it.** Wrong audience (product/SaaS consumers, not people who write DSP kernels), zero verified success among comparable niche dev tools, structurally a vanity-metric machine that fights the real-adoption goal. Best case is a one-day spike plus "congrats!" comments and bounced GitHub visitors. Revisit only if jz ships a one-click hosted tool; not before.
- [ ] No benchmark trash-talk (flat competitor tables only). No overclaiming completeness (keep the honest-limits section). No post before the artifact runs. No spray-posting the Dream-100 (one thread, one artifact, one message).

**North star:** merged kernel PRs and projects shipping jz. Honest targets: 1 in 6 months, 3 in 12 (the Zig/htmx timeline, not a viral week). Not metrics: stars, likes, PH rank, HN points. Solo-dev allocation: build artifacts ≥ 80%, post ≤ 20%.

---

## Positioning (locked)

| Decision | Choice | Why |
|---|---|---|
| Category | "AOT JS→WASM compiler for numeric code" (big fish, small pond) | Every other label fails the buyer-assumption test: "JS compiler" collides with Porffor and implies full-JS; "wasm toolchain" reads as Emscripten glue; "AssemblyScript alternative" cedes the frame to the incumbent |
| Headline mechanism | "valid jz is valid JS" / "the same file" | Verified unclaimed. No rival can say it (AS is a dialect that can't run as JS; MoonBit/Grain/Rust/Go/Zig are other languages; Javy ships an interpreter) |
| Trust argument | "Your existing test suite is the compiler's test suite" | Novel framing; the disarming answer to "is this another AS-style trap?" |
| Audio claim *(for audiojs)* | Worst-case floor, not average speed: no GC pause can hit `process()`, plus the loading story (compile in main thread, postMessage bytes, sync instantiate, no fetch which `AudioWorkletGlobalScope` forbids) | Unclaimed by anyone surveyed; matches the diagnosed failure mode (missed ~3 ms deadlines) that made a real team abandon Rust→wasm |
| Risk reversal | Ejectability: "remove jz and your code still runs, it's still JS" | The structural guarantee no rival can copy; answers the solo-maintainer / bus-factor objection |
| Honesty as position | Losses published, on purpose | Unique; every rival's bench shows only wins. Published losses are what made ripgrep/Ruff trusted |

**Never lead with:** speed multiples, "compiles to WebAssembly", "small binaries", bare "no
runtime / no GC", bare "ahead-of-time". All verified worn; buyers discount them equally.
Numbers appear as proof under a mechanism claim, never as the claim.

**Sophistication note:** both personas are Schwartz level 4-5, numb to speed multipliers
(*"C/Rust is roughly 3x faster than V8, not much room left"* HN; *"WASM isn't automatically
faster, just more predictable"* videocall.rs). The real desire is ONE codebase (*"the whole
framework compiled in the same context and language, no painful communication"*, Babylon.js).

---

## Objection → artifact map

Every verified objection gets an artifact, not a rebuttal.

| Objection (verified, their words) | Artifact | Status |
|---|---|---|
| "f64-only, my DSP needs int/bit-exact math" | bitwise/crc32/hash/bytebeat bench cases (bit-exact) + an "integer reality" README note (i32 narrowing inferred; `Math.imul`/shifts/masks native) | bench exists; doc to write |
| "no GC = crash just delayed, what about hours-long sessions?" | arena/`_clear` reset doc + a soak demo with a flat memory graph | to build |
| "the plumbing (MIDI/UI/ports) still needs JS" | honest-boundary doc: jz owns the kernel, JS owns plumbing, shown in the worklet template | to write |
| "sounds like AssemblyScript's dialect trap" | the differential proof: same file, `node test` + wasm test in CI, bit-exact; "your test suite is the compiler's test suite" | CI exists; surface as the claim |
| "experimental, solo maintainer" | ejectability guarantee + self-hosting + pin-version guidance | one paragraph to add |
| "bundler/wasm loading hell (Vite, async init, base64 hacks)" | unplugin-jz + sync-instantiate doc | in progress (highest leverage) |
| "geomean is cherry-picked, show me MY kernel losing" | losses in the same table + "report a slow case" link + REPL "run your own kernel" | exists; keep loud |
| "JS↔wasm boundary tax killed it for us (small ops)" | agree in public: jz is for batch kernels, per-call shapes stay JS. Saying it unprompted is a trust weapon | to write |

---

## Dream-100 first targets (documented pain first)

**Tier 1 (they already asked in public, the inbox exists):**

| Target | Pain evidence | Fit | First move |
|---|---|---|---|
| satellite-js | #148: ships a C++/Emscripten bulk API for 3-12x; dual-maintenance pain explicit | high (batch SGP4 is pure numeric) | PR: same-source jz build of the bulk propagator + differential test vs JS and C++ |
| hash-wasm (Daninet) | #12: 10x cold-start from base64+compile; hand-maintains C | medium (integer hashing is jz's floor; author is skeptical, fair) | benchmark artifact first, PR only if numbers win incl. size |
| jimp | #833: wanted wasm, AS port found no win | medium (per-pixel batch fits; team burned once, lead with losses) | standalone bench on their blur/resize kernel; issue only with numbers |
| brotli-wasm / httptoolkit | #8: the canonical Vite/wasm-loading saga | medium; the *bundler story* is the pitch, via unplugin-jz | cite the thread in unplugin-jz's README |
| Strudel / superdough *(audio, deferred)* | strudel#479: worklet crackle on low-end hw, maintainer active | high | after audiojs: one superdough voice as a jz kernel, measured on a Pi |

**Tier 2 (qualify before approach):** pica, image-q, jsQR/zxing-js, fft.js, ml-matrix,
delaunator, upng/uzip, Observable notebook kernels.

**Anti-targets (evidence says no):** gl-matrix and any per-call math lib (the maintainer's
own boundary-tax analysis is the definitive no); harfbuzzjs (text shaping is out of subset,
but keep the Photopea size-budget signal as positioning ammo); Shopify Functions full port
(subset mismatch; the Javy-3x quote is ammo, not a market).

**Rule:** one Tier-1 target at a time, complete artifact each, no simultaneous scatter.

---

## Spreadability (STEPPS)

- **The bench table** is the skeptic's shareable object: the honesty ("they publish their
  losses") is both the Social Currency and the differentiator.
- **Trigger to own:** whenever a dev hears "GC pause / audio glitch / worklet", jz should be
  the association. The wedge post, the template, and the awesome-list entries reinforce one
  trigger across many surfaces.
- *(audio, deferred)* the floatbeat permalink is the viral object once audiojs ships:
  Practical Value + Public + Social Currency + Story, shareable without a re-type.
