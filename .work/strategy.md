# jz promotion & adoption strategy

*Owner notes, subordinate to [PLAN.md](../PLAN.md). SEO/distribution actions updated 2026-09-10.
Earlier research includes sourced VOC quotes, a competitor scan, and 10 adoption precedents.
Personas in [`marketing.md`](marketing.md); integration surfaces in [`ecosystem.md`](ecosystem.md).
Goal: real adoption (kernels shipped with jz), not stars.*

## Roadmap (the steps, in order)

**Thesis:** prioritize artifacts other developers can try, reproduce and carry into
their own projects. The adoption precedents favor demonstrations and third-party
accounts over unsupported claims. The sequence is: make the demo prove itself, seed passively, become
someone's invisible compile step, post one honest artifact, then land real kernel PRs.

**Owner decision (audio deferred):** floatbeat, the audio wedge post, and Strudel-class audio
targets belong to the coming **audiojs** project, not jz. The active track below is the
non-audio path; audio moves are parked at the bottom of each phase, marked *(audio, deferred)*.

**Phase 0 · Legibility: the demo must read as proof [mostly shipped]**
- [x] og image, hero install chip, ejectability FAQ line
- [x] color-space used-by, MIT link, GitHub Discussions, npm/tag/release alignment, live versioning
- [ ] REPL copy-link button (hash-state already works; the affordance is missing)
- [x] **Deploy the revised Pages workflow:** deployed September 10 in
  [run 34471751897](https://github.com/dy/jz/actions/runs/34471751897).
  Browser assets, gallery, guide examples and REPL/hero smoke gate deployment;
  full compiler, self-host and benchmark gates are separate. Installation skips
  `npm ci`'s implicit self-build.
- [x] **Publish Google verification HTML:** the existing Pages run succeeded;
  `google59e4244a98d93e54.html` returns HTTP 200 with the exact verification content
  (checked September 10). This deployment predates the local workflow changes.
- [x] **Register Search Console:** owner confirmed registration; awaiting data.
- [ ] **Use Search Console as data arrives:** inspect homepage/guide/gallery/bench
  canonical selection and indexing; submit the sitemap.
- [x] **Deployed static discovery:** all 66 catalog entries rendered as static gallery links
  and captions; page introduction; concise descriptive titles ending in `| JZ`;
  product descriptor in homepage/guide/gallery/bench footers.
- [x] **Published getting started:** `/get-started/` covers function → compile →
  instantiate → call, typed-array interop and the original JS fallback. Links to
  the maintained API, semantic differences and memory contract. Live HTTP 200;
  listed in the sitemap and linked from the README and site footers.
- [ ] **Render benchmark evidence as HTML:** use the committed results snapshot;
  show measurement date, environments, commands, coverage and losses before JS
  runs. Preserve the optional live runner. This is separate from refreshing measurements.
- [ ] **Explain the first non-audio example:** use color-space's actual integration,
  then an image or simulation kernel. Include source, setup, batch boundary,
  differential result and limitations. Keep the full-screen demo usable.
- [ ] **Connect the reading path:** guide → example → benchmark → interop docs →
  playground, using descriptive links. Add new routes to the sitemap; if Markdown
  becomes deployed content, update Pages' Markdown path exclusion.
- [ ] **Extend short descriptors where they fit:** future docs share the footer;
  editor/full-screen demos need a natural help/description surface with specific
  context. Do not overlay controls with SEO text or duplicate generic paragraphs.
- [ ] **Measure mobile page experience:** loading and interaction during hero
  compilation; use a worker/defer work only if measurements justify it. Check
  contrast, keyboard focus, clipping and reduced motion.
- [ ] **Correct comparison copy:** qualify the claim that AssemblyScript cannot
  run as JS; its docs describe suitable shared source compiled with `tsc` and `asc`.
  Maintain one fair comparison page, including Javy's embedded-engine approach.

**Phase 1 · Passive seeding: set-and-forget, low effort, do now**
- [ ] GitHub/npm: align the short category description, homepage link, README
  opening and relevant topics/keywords. Existing npm keywords are already extensive.
- [ ] Appropriate directory PRs: awesome-wasm, awesome-wasm-langs, awesome-compilers;
  check current inclusion criteria and duplicates first. Seek relevant readers,
  not a promised ranking benefit from backlinks.
- [ ] Newsletter submissions: JavaScript Weekly, Changelog News, WASM Weekly
  (verify current activity/contact first). Pitch the specific runnable artifact.
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
- [ ] Community/Q&A support: complete answers to current WebAssembly, graphics and
  simulation problems; disclose authorship and link the relevant example, not
  automatically the homepage. No repetitive promotional replies.
- [ ] Technical writing: publish the complete guide on JZ's domain; use DEV,
  Hashnode or a personal blog for appropriate syndication with canonicals, or
  distinct companion articles. Do not maintain duplicate tutorials.
- [ ] Video/talks: demonstrate JS → compile → integrate → compare; link code and
  the written guide. Target JS/Wasm communities first; Web Audio Conference and
  Audio Developer Conference material follows the audiojs promotion decision.
- [ ] X/Bluesky/Mastodon/LinkedIn: test short demos and engineering findings,
  measure qualified referrals and retain only channels that reach actual users.
- [ ] Release notes/RSS: tell adopters when their specific limitation is resolved;
  add optional email only with demand. Independent references and readable docs
  also support AI-assisted discovery; no separate keyword campaign.

**Do NOT**
- [ ] **ProductHunt: skip it.** Wrong audience (product/SaaS consumers, not people who write DSP kernels), zero verified success among comparable niche dev tools, structurally a vanity-metric machine that fights the real-adoption goal. Best case is a one-day spike plus "congrats!" comments and bounced GitHub visitors. Revisit only if jz ships a one-click hosted tool; not before.
- [ ] No benchmark trash-talk (flat competitor tables only). No overclaiming completeness (keep the honest-limits section). No post before the artifact runs. No spray-posting the Dream-100 (one thread, one artifact, one message).
- [ ] No paid link schemes, fake reviews, hidden keyword blocks, near-duplicate
  query pages or rank guarantees. Defer ads/generic launch directories until
  there is a specific audience hypothesis and a working adoption path.
- [ ] Do not spend time on FAQ rich-result markup (discontinued by Google in May
  2026) or `llms.txt` as a Google ranking tactic. Preserve useful FAQ answers.
- [ ] Regional/local-language material only with a maintainer who can support it;
  no mass-translated landing pages or domain migration just for keywords.

**North star:** merged kernel PRs and projects shipping jz. Honest targets: 1 in 6 months, 3 in 12 (the Zig/htmx timeline, not a viral week). Not metrics: stars, likes, PH rank, HN points. Solo-dev allocation: build artifacts ≥ 80%, post ≤ 20%.

---

## Positioning (locked)

| Decision | Choice | Why |
|---|---|---|
| Category | "AOT JS→WASM compiler for numeric code" (big fish, small pond) | Every other label fails the buyer-assumption test: "JS compiler" collides with Porffor and implies full-JS; "wasm toolchain" reads as Emscripten glue; "AssemblyScript alternative" cedes the frame to the incumbent |
| Headline mechanism | "valid jz is valid JS" / "the same file" | Plain JavaScript, inferred types and a JS fallback; unlike requiring another source language. AS has a shared-source workflow, so do not claim exclusivity. Javy embeds a JS engine. |
| Trust argument | "Your existing test suite is the compiler's test suite" | Novel framing; the disarming answer to "is this another AS-style trap?" |
| Audio claim *(for audiojs)* | Worst-case floor, not average speed: no GC pause can hit `process()`, plus the loading story (compile in main thread, postMessage bytes, sync instantiate, no fetch which `AudioWorkletGlobalScope` forbids) | Unclaimed by anyone surveyed; matches the diagnosed failure mode (missed ~3 ms deadlines) that made a real team abandon Rust→wasm |
| Risk reversal | Ejectability: "remove jz and your code still runs, it's still JS" | Answers the solo-maintainer / bus-factor objection; demonstrate the fallback rather than claim rivals cannot provide one |
| Honesty as position | Losses published, on purpose | Let readers reproduce and assess results; avoid unsupported claims about what every rival publishes |

**Search clarity:** use a descriptive title such as `JavaScript to WebAssembly
Compiler | JZ`. Explain the numeric subset near the top; lead the adoption argument
with retaining existing code/tests. Numbers are supporting evidence, not universal
speed promises. Qualify “no runtime” as “no embedded JavaScript engine” when host
services or interop apply. Avoid promising full frontend/Node application conversion.

**Sophistication note:** both personas are Schwartz level 4-5, numb to speed multipliers
(*"C/Rust is roughly 3x faster than V8, not much room left"* HN; *"WASM isn't automatically
faster, just more predictable"* videocall.rs). The real desire is ONE codebase (*"the whole
framework compiled in the same context and language, no painful communication"*, Babylon.js).

---

## Search coverage and measurement

Candidate intents, not measured search volumes. One useful page covers related
phrases; create a separate page only for a different problem. Audio queries remain
research notes for the deferred promotion track, not extra work in this queue.

| Request / associative searches | Destination |
|---|---|
| JS to WASM; JavaScript to WebAssembly compiler; compile/convert existing JS | Homepage + getting started |
| Can all JS compile? Supported JavaScript subset; browser compatibility | Compatibility/reference |
| Online JS to WASM compiler; playground; JS to WAT; download WASM | Existing REPL |
| WASM without Rust/C++; faster JS without rewriting; no type annotations | Migration guide |
| JZ vs AssemblyScript/Javy; QuickJS WASM vs direct compilation; JS AOT | One maintained comparison |
| WASM vs V8; is WASM faster? call overhead; when WASM is slower | Benchmarks + explanation |
| Fast JS color conversion; image filters; pixel-processing SIMD | Color-space case study + image example |
| JS physics performance; boids/particles/N-body WASM; cellular automata | Selected simulation explanations |
| JS SIMD; auto-vectorization; optimize typed-array loops | SIMD guide with emitted WAT |
| Float32Array interop; shared WASM memory; Web Worker; Node loading | Interop recipes |
| JavaScript to WASI; Wasmtime; AOT native binary | Exact supported host/deployment guide |
| JZ memory management; no GC; debugging; long-running sessions | Lifecycle/troubleshooting |
| AudioWorklet performance; JS DSP; Web Audio glitches; WASM synthesis | Audiojs track, deferred promotion |

Audit baseline (September 10): homepage/robots/sitemap/social image respond;
sitemap has 74 URLs; the old GitHub Pages URL permanently redirects with an
intermediate HTTP hop. Search surfaced the old domain and GitHub; a `site:` query
for the new domain returned nothing in the available provider. This is not proof
of Google's index status. Before the local gallery change, 66 of 69 individual
examples had no static body text; gallery and benchmark content depended on JS.
Google renders JS; improving initial HTML is not a diagnosis of the ranking cause.

- [ ] Until verified: keep a weekly dated log of a small set of queries, engine,
  locale/device and observed URL/position. Do not treat `site:` counts as complete
  or a tool's result order as exact Google rankings.
- [ ] Once verified: inspect index/canonical/rendering reports, then compare
  nonbrand query/landing-page impressions and clicks over 28-day periods.
- [ ] Track referral → successful compile of the visitor's own code → integration.
  Exclude automatic hero/demo compiles from activation and never collect source
  code as analytics. Package installs and issue reports are imperfect secondary signals.
- [ ] Review weekly: recurring user questions, stale claims, broken links and
  deployment dates. Keep titles concise and page-specific descriptions/canonicals
  accurate; optional software structured data must match visible facts.

References: [verification without DNS](https://support.google.com/webmasters/answer/9008080?hl=en),
[JavaScript SEO](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics),
[titles](https://developers.google.com/search/docs/appearance/title-link),
[AI search](https://developers.google.com/search/docs/appearance/ai-features),
[FAQ/llms.txt updates](https://developers.google.com/search/updates),
[AssemblyScript shared source](https://www.assemblyscript.org/compiler.html),
[Javy](https://github.com/bytecodealliance/javy).

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
- **Active trigger:** an existing numeric JS kernel is too slow, but its author wants
  to keep the code and tests. *(Audio, deferred)* GC pause / audio glitch / worklet
  becomes the corresponding audiojs association when that promotion track opens.
- *(audio, deferred)* the floatbeat permalink is the viral object once audiojs ships:
  Practical Value + Public + Social Currency + Story, shareable without a re-type.
