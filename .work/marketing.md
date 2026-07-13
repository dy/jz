# jz — marketing & landing-page research

Goal (set by author): **real adoption** — jz installed and used in real projects, real kernels
shipped with it. Not vanity stars, not a hype launch.
Constraint: **page + repo only** — minimal outbound. ⇒ the README, npm page, and landing page
*are* the distribution. Organic discoverability + on-page conversion carry everything.
Ethos: honesty over hype; *prove with nectar* (show the working thing, never the pitch); subtract
everything not load-bearing. Overclaiming is a disqualifying failure for this audience.

Method: 6-lens research workflow (audience / first-visit questions / positioning / page-conversion /
proof-credibility / discoverability) → synthesis → adversarial stress-test → revision, then
**manual verification of the load-bearing claims** against the real repo (below).

**Canonical:** this doc is the project's single source of truth for audience & personas (§1).
Sibling docs: [`ecosystem.md`](ecosystem.md) = expansion / integration / channel map;
[`strategy.md`](strategy.md) = the promotion & adoption play (proof engines, sequence, Dream-100,
objection→artifact map); [`../.work/research.md`](../.work/research.md) = technical design record.

> **2026-07-01 re-analysis.** §1 personas rebuilt on primary-source VOC (verbatim quotes from
> GitHub issues / blogs / HN, all sourced); §3 positioning re-derived from a live competitor
> scan; §2′ supersedes the §2 report card with a fresh site audit. The promotion strategy
> itself lives in `strategy.md`.

---

## Audience reconciliation — earlier notes → personas

This section folds the project's **earlier audience notes** (the former `research.md` NICE
list, now consolidated here; `ecosystem.md` §4's reach map) into the conversion-ranked
personas of §1. Two lenses, complementary — not duplicates:

| Reachable audience (broader notes) | This doc (conversion priority) | Relationship |
|---|---|---|
| **Web Audio / DSP** community (bytebeat demo) | **#1 persona: Web-Audio/DSP kernel authors** | **Agree** — strongest fit. This doc adds *why* (AudioWorklet 2ms budget, GC glitch) and that the page is currently silent for them. |
| **Edge compute** (EdgeJS, CF Workers, Deno) | de-prioritized for the page | **Diverge by goal.** Edge is I/O-orchestration-heavy — jz now HAS async/await + awaitable host imports (fetch), so the wedge widened, but the numeric-on-edge slice stays narrow/hard to discover. Watch; revisit after the async landing circulates. |
| **Game jams / JS13K** (1–2 kB output) | de-prioritized for the page | **Diverge by goal.** Tiny-wasm size is a genuine *shareable hook*, but jam code is thrown away → low real-adoption conversion, and it's bursty (annual). Keep as a demo, not a page persona. |
| **Porffor community** (education done) | "ignore for page" (compiler-curious) | **Agree-ish.** Reachable, but they star/discuss; they rarely ship a kernel. Serve on the bench page. |
| **README "four/five visitor classes"** (Skeptic, Curious explorer, Pragmatist, Embedder, Language/compiler) | **First-visit questions** (5s/30s/2min) | **Complementary.** The README models *reading-mode* (what a reader scans for); this doc models *who to optimize for* + *attention-horizon ordering*. A DSP author arrives in "Pragmatist" mode. **Finding: that excellent reader-class model is applied in the README but NOT on the landing page.** |

Net: the broader notes answer *"who can be reached"*; the §1 personas answer *"who to optimize
the page for, given the real-adoption goal."* This doc holds both — reachability as context,
conversion-priority as the decision.

---

## 1. Personas, ranked (fit × organic-reachability × ship-likelihood)

*Rebuilt 2026-07-01 on primary-source VOC — every quote below is a real dev, sourced.
The single biggest correction vs the earlier draft: **neither persona's dominant desire is
speed.** Both want the same thing — ONE codebase — and both are Schwartz-sophistication
4–5 (numb to speed multipliers). Diagnosis per persona below drives all copy decisions.*

### #1 — Web-Audio / DSP kernel authors  ← highest fit, still invisible on the page
- **Dominant desire (their words):** *"my DSP code should not click and pop — without
  maintaining two codebases in two languages to get there."* The ~3 ms budget is their own
  canon: *"the process() function is called every 128 samples. That gives you exactly 2.9
  milliseconds… if the browser decides… to scavenge memory… you miss your deadline"* (loke.dev).
  *"The moment you call `new Float32Array(128)` inside process(), you've already lost"* (ibid.).
- **Awareness (Schwartz): Stage 3 — solution-aware of the WRONG categories.** They know two
  fixes: (a) allocation-free-JS discipline (ring buffers, no `new` in process()) — works but is
  a permanent tax every contributor can silently break; (b) Rust/C→wasm. **No evidence anywhere
  that they know "AOT-compile actual JS to wasm" is a category.** Porffor/Javy discussion happens
  in edge/tooling circles, not audio ones. ⇒ For this persona jz is a *category-creation* task:
  open on their problem in their words, then name the mechanism. Never open on the product.
- **Sophistication: 4 — burned, specifically.** The decisive artifact: a team building
  low-end-Android audio tried the canonical Rust→wasm rewrite and **reverted to hand-tuned JS**
  because `AudioWorkletGlobalScope` forbids `fetch()`/dynamic import — loading the wasm INTO the
  worklet was the wall: *"Writing fast JavaScript turned out to be less complex than fighting
  WASM loading restrictions… WASM isn't automatically faster — it's just more predictable"*
  (engineering.videocall.rs). ⇒ jz's sync-instantiate/postMessage-bytes story is a first-class
  claim for them, equal to the GC story. Also primed: ex-AssemblyScript devs (public retraction:
  *"I'd be wary of recommending the language"* — frzi, Medium).
- **Their objections (verified, must be answered by artifacts — map in `strategy.md` §4):**
  f64-only vs int/bit-exact DSP; "no GC = crash delayed, what about hours-long sessions?";
  "the MIDI/UI/port plumbing still needs JS — you shrank, not killed, the dual-codebase problem";
  "sounds exactly like AS's pitch, prove it isn't the same trap"; solo-maintainer/experimental
  (they watched AS stall); cold-compile jank for livecoding.
- **Watering holes:** WebAudio spec issues (#2632, #1471), tidalcycles/strudel (#479 is an open
  inbox), KVR DSP forum, The Audio Programmer Discord, lines (llllllll.co), TOPLAP, HN,
  loke.dev/videocall.rs/cprimozic-class practitioner blogs, Web Audio Weekly.
- **Converting artifact:** biquad/minisynth in a real AudioWorklet, JS⇆JZ toggle, the loading
  story shown (no fetch, no async init), zero underruns on cheap hardware.

### #2 — JS library authors shipping one fast *batch* numeric kernel
- **Dominant desire (their words):** DRY — *"the whole framework… compiled… in the same
  context and language… no painful communication"* (Babylon.js thread). Stop maintaining the
  kernel twice; stop the bundler wars; keep the JS as the single reference impl.
- **Awareness: Stage 3–4, including Stage-4 *disillusionment*.** These maintainers already ran
  the experiment: Babylon.js benchmarked and rejected a math-core port ("WASM should not be
  called for small chunk of work"); gl-matrix reasoned it through and shipped nothing (toji:
  per-call ops "extremely hard to break even" on boundary cost); jimp's AS port found no win;
  AssemblyScript's own tracker holds multiple "5× SLOWER than JS" numeric-port issues (#760).
  Those who DID ship wasm are stuck on operational pain: hash-wasm base64-embeds its binary and
  eats a 10× cold start; brotli-wasm#8 is the canonical Vite-loading saga (*"affects all Vite
  users for all wasm-pack projects"*); satellite-js pays a C++ shadow-repo for its 3–12× bulk
  API. ⇒ The pitch to them is a Stage-4 move: *new mechanism inside a known category* — "your
  batch kernel, the boundary tax amortized, no second source, no async-init dance."
- **Sophistication: 4–5, the most jaded segment.** *"C/Rust is roughly 3× over V8… there is not
  much room left"* (attractivechaos, HN); maintainers cite their OWN benchmarks against pitches
  arriving in their issue trackers. Only two things still land: a named mechanism + reproducible
  numbers **with losses shown**. jz's CI-gated table is built for exactly this audience.
- **Critical shape-filter (new):** pitch **batch kernels only** (resample, propagate-all,
  encode-frame, hash-buffer). Per-call small-op libraries (gl-matrix's vec3.add) are
  **anti-targets** — the maintainer's own boundary-tax analysis is correct; agreeing with it
  unprompted is a trust weapon.
- **Willingness-to-pay exists:** Photopea's founder offered **$5–10k** for a wasm text-shaper
  under a **150–200 kB zipped** size budget (harfbuzz/harfbuzzjs#10). Text shaping is out of
  subset — but the signal stands: real buyers gate adoption on *size budgets* jz beats by
  15–100× (modules 1–10 kB). Use as positioning ammo.
- **Watering holes:** r/WebAssembly, HN Show-HN threads for JS→wasm compilers (Porffor/Jaws
  threads = the exact debate), AssemblyScript issue tracker (primed ex-users), the Dream-100
  issue threads themselves (see `strategy.md` §5 — "a direct, low-competition inbox").

### #3 — Creative coders / generative artists  ← already over-served
- **Desire (their words):** *"rAF drops below 30fps when I add agents; I don't want to learn GLSL for FPS."*
- **Page status:** the gallery is their native idiom — already strong. *Don't add more here.*

### Deliberately ignore (for *page* optimization)
- In-browser scientific / data-viz — discovery path broken without Observable.
- Demoscene / bytebeat / JS13K — tiny crowd, throwaway code; floatbeat already serves them.
- WASM / compiler hobbyists (incl. Porffor crowd) — they star, they don't ship. Serve via bench
  page. (Verified traction shape: Porffor 4.7k stars vs ~1.3k npm downloads/month — stars ≠ ship.)
- **Anti-persona (new):** per-call math-lib authors (gl-matrix class) — boundary tax makes jz
  honestly wrong for them; say so in public, it buys trust with everyone else.

---

## 2′. Site audit — 2026-07-01 (live, browser-verified; supersedes the old §2 report card)

**Working — don't touch** (confirmed by two independent browser audits): the hero reads as
*proof, not decoration* (live JS⇆JZ toggle + op/s sparkline + bench numbers adjacent — the
exact fix §2 asked for, now landed); the real REPL is embedded in the first viewport with WAT
+ "compiled in 38 ms" readout, compiles broken source to a *clear* error (no crash), downloads
a valid 39 B `module.wasm`, and benches JS-vs-JZ inline (`1.38× faster · median of 40`); the
bench page disclosed methodology + rival coverage ("Porffor 11/38 cases", Javy 162×) honestly
AND has a working **RUN button** — the visitor re-runs the corpus in their own tab and a live
"JZ browser · 20 cases" row appears (a proof affordance none of the rivals have; feature it);
REPL & floatbeat both encode full state in the URL hash (reload-verified); floatbeat ships 13
attributed library tracks + SHARE button; the FAQ pre-empts real objections; mobile hero is
solid; zero console errors anywhere; the version label is live-sourced via `version.js`
(v0.8.1 — correct, matches npm).

**Missing signals, ranked (all observed, not inferred):**

| # | Signal | Observed | Fix | Impact |
|---|---|---|---|---|
| 1 | **og:image stale + clipped** | `assets/og.png` still shows *v0.7.0* + old numbers (2.5×/2.8×/2.6×); bottom third empty black, code row sliced mid-character. Every shared link unfurls wrong. | Regenerate on deploy (extend the `version.js` single-source discipline to the OG asset); compose as a designed 1200×630, not a viewport capture | 8 |
| 2 | **floatbeat orphaned** | Live, polished, SHARE button, hash permalinks — and *zero inbound links*: README link HTML-commented, absent from nav and `examples/examples.js`. The #1-persona proof is reachable only by guessing the URL. | **DEFERRED by owner (2026-07-01):** audio demos incl. floatbeat are held back deliberately — they belong to the coming audiojs ecosystem (or a separate project); don't dilute jz's attention. Re-open when audiojs lands. | 8 |
| 3 | **0/58 gallery entries are audio** | `examples.js` lists 58 names, all visual; `jukebox`/`zzfx`/`rfft` exist as dirs but aren't registered. The stated #1 persona sees no audio proof anywhere. | **DEFERRED — same owner decision as #2.** | 7 |
| 4 | **H1 = worn claim** | "Computational JS at native speed" — every wasm tool claims native speed (sophistication-4 market, §3′); the ownable mechanism only appears in the sub. | Author's call (deliberately kept terse before — respected). Candidates that keep the terseness but carry the mechanism: *"Same JS, native WASM"* · *"Your numeric JS, compiled AoT to WASM"* · keep H1, move "Same source" INTO it | 8 |
| 5 | **`npm install jz` buried** | y=2194 of 2942 px (~75% down), isolated section, works (typewriter + copy verified) but invisible without 3 scrolls | Compact install chip in the hero beside the toggle (was already on the old §5 list) | 6 |
| 6 | **No async-visitor capture** | Footer = repl·examples·bench·github·npm·issues. No Discussions (`has_discussions:false`), no Discord, no newsletter, no FUNDING.yml. A not-today visitor has *nothing to do but leave*. | Enable GitHub Discussions (zero-cost); consider FUNDING.yml (the "Sponsor call" todo) | 5 |
| 7 | **Mobile REPL badge clips code** | At 390×844 the floating JZ chip covers the last editor line ("Con[sole]…") — a known tradeoff per the site's own CSS comment, but it triggers with the *default prefilled example*, not only long pastes | CSS offset | 4 |
| 8 | **Thin crawlable text** | `body.innerText` = 1114 chars; 2 heading tags total. Title/meta are strong; `<details>` FAQ is crawlable but heading-less. | h2/h3 on FAQ summaries or a short prose section; low priority vs 1–3 | 4 |
| 9 | **Release-tag lag** | Site + npm at 0.8.1; latest GitHub release tag v0.8.0. Footer links to `releases/latest` → visitor sees older tag. | Cut a GitHub release per npm publish (process, not code) | 3 |
| 10 | **License legibility** | Two conflicting signals: `package.json` + repo LICENSE say **MIT**, footer links only ॐ → krishnized/license — "MIT" appears nowhere on-page. A corporate evaluator doing a 10-second scan sees an unfamiliar term. | Author's framing, author's call — one option: keep ॐ, add a plain "MIT" text link beside it | 2 |

**Five-second promise today:** "fast JS→WASM with a live number" — the speed story. The
differentiated promise (*same file, no rewrite, ejectable*) is present but sub-headline.
Diagnosis unchanged in kind from §2, but the page has visibly improved: the old top gaps
(uncaptioned demo, missing install, meta bug) are fixed; the remaining theme is **persona-1
invisibility (audio) + sharing surface (OG/floatbeat/capture)**.

---

## 3. Positioning

- **Ownable claim (lead with this, not speed):** *Valid jz IS valid JS — the same file passes your existing tests and compiles to GC-free WASM.* No rival can say it (AssemblyScript = TS dialect that can't run in a JS engine; Rust→wasm = a second language; Porffor can't self-host).
- **Why not lead with speed:** the "compile-to-wasm-for-speed" claim is worn out (AssemblyScript, Rust→wasm own it) and the audience is skeptical. Lead with **no-rewrite / no-lock-in relief**; let speed *confirm*.
- **Category:** AOT compiler for the *numeric core* of JavaScript.
- **Awareness/sophistication (Schwartz):** solution-aware, high-sophistication, high-wear-out → relief first, proof-before-claims, never open on the speed number.
- **Positioning sentence:** *For JS devs whose numeric hot paths stutter under GC — DSP, audio worklets, physics, image processing — jz is the AOT JS→WASM compiler that needs no new syntax, no type annotations, and creates zero lock-in, unlike AssemblyScript which demands a dialect that can't run as plain JS.*
- **The effort ladder (group by *cost to adopt*, not by *target*):** the axis a visitor actually weighs isn't JS / WASM / Native (the target) — it's **rewrite vs no-rewrite** (the cost). Three rungs:
  - **Keep your JS** (V8 / Bun / Deno) — zero effort · the floor
  - **Compile your JS** (**jz**) — ~zero effort · *the entire pitch*
  - **Rewrite it** (Rust / Go / C / Zig → wasm or native, AssemblyScript) — high effort · the ceiling

  jz's USP in one line: **rewrite-tier speed at zero-rewrite effort.** jz stands *alone* in the cheap rung, sitting near the top of the expensive rung's performance range — the picture *is* the argument ("only jz gives you this for free"). It's the same no-rewrite relief as the lead claim, made visual and quantified. The bench page groups the corpus by this ladder so its structure argues the position; the per-case view stays an absolute-speed list (let the winner show) with a class tint, since by-case the entertaining question is "who won this kernel".

### 3′. Competitor scan → open positions (2026-07-01, live pages verified)

**Worn claims — never lead with these** (every rival says them; sophistication-4+ buyers
discount them all equally): "near-native speed" / any bare multiplier (Static Hermes "300×",
Porffor "10–30×"), "compiles to WebAssembly" as the headline fact, "small/compact binaries"
as an adjective, bare "no runtime / no GC" (TinyGo/Zig/Emscripten-freestanding variants exist),
bare "ahead-of-time" (Porffor/Static Hermes/Emscripten are AOT too).

**Verified-unclaimed territory — jz can own all five truthfully:**
1. **"The same file runs as JS and compiles to WASM."** Zero surveyed competitors can say it.
2. **"Your existing test suite is the compiler's test suite."** Nobody frames correctness this
   way; it is also the exact answer to the "AS-dialect trap" objection.
3. **"No new hire, no new language, no new toolchain."** The only argument aimed at
   Rust+wasm-bindgen's real cost (organizational, not runtime). No rival markets against it.
4. **"Worst-case latency floor, not average-case speed."** Nobody stakes the tail-latency /
   GC-pause-jitter claim — and it's the one that matches the AudioWorklet ~3 ms budget exactly.
5. **"Honest losses, published."** Unique across the entire set — every rival bench page shows
   only wins.

**Freshness guards (don't overclaim):** AssemblyScript is *not* dead — v0.28.19 shipped
2026-06-12, ~weekly cadence, 6.8M/mo loader downloads (largely legacy); the seam is the
*dialect* (their own FAQ: "unlikely that existing TypeScript code can be compiled"), never
maintenance. Porffor is active and shipping; its traction shape (4.7k stars, ~1.3k npm dl/mo)
says "research project", which its own site states — contrast goals, don't disparage.
Javy is healthy (Bytecode Alliance, v9.0.0) — the contrast is architectural: interpreter-in-wasm
vs compiled semantics. Hand-WAT: concede 3–8× size openly and convert to credibility.

**Category decision (Dunford, tested):** big fish, small pond — **"AOT JS→WASM compiler for
numeric code"**. Rejected: "JS compiler" (collides with full-JS Porffor/Static Hermes, implies
async/DOM), "wasm toolchain" (reads Emscripten-class infra), "AssemblyScript alternative"
(cedes the frame and inherits their audience, not ours), "kernel compiler" (HPC-cold),
"DSP compiler for JS" (right instinct, undersells image/sim/codec). The category noun sets
honest boundaries; the mechanism line ("valid jz is valid JS") does the differentiation work.

---

## 4. Honesty findings — VERIFIED against the repo

- **✅ The meta-description bug (highest priority).** `index.html:7` said *"2.4× faster… beats Rust and
  Zig → wasm on numeric kernels."* The bench Rust/Zig targets are **native** binaries
  (`rustc -C target-cpu=native`, `zig build-exe -O ReleaseFast` — `bench/bench.mjs:323,349`; README
  labels them `rustc -O3`/`ReleaseFast`). So "→ wasm" *mislabels native as wasm*, and "beats"
  overclaims (jz loses 7/20 Rust cases). A senior dev spots this instantly and leaves. Reality is
  *better* than the claim (you beat **native**) — fix needs only honesty. **(fixed → "Over 2×… trades
  blows with native Rust and Zig".)**
- **✅ The hero toggle is an HONEST, decisive win.** Measured the exact hero kernel (`assets/grid-current.js`)
  both ways, mean of 6×2000 frames @1360×560: **jz 0.021 ms vs JS 0.248 ms = 11.8× (jz faster).**
  It's exp-heavy pulse tails — jz's best class, NOT the arithmetic-loop tie the todo warns about. So
  *leaning on the live toggle as the #1 proof is safe and true.* The page already shows live per-frame
  ms (honest) rather than a claimed multiple — keep it that way.
- **✅ Stale "Used internally by" credit** — commented-out/false per todo.md. Make it true (dogfood) or leave removed; not currently visible, so low urgency.
- **⚠️ Suspected stale `bench/README.md` numbers** (callback 27.56×, audio-showcase ms, aggregate
  geomean) — flagged by the research agents, BUT the adversarial pass caught those agents mis-stating
  some numbers (wrong direction). **Do not trust their replacements. Regenerate from `results.json`
  (`npm run bench`)** rather than hand-editing. Also: stop hardcoding the speed multiple in any static
  copy — the page already binds the V8 stat live from `results.json` via sprae; the meta tag (which
  can't be live) should use a conservative non-drifting claim ("over 2×").

**Keep claiming loudly (all honest, underused):** "valid jz is valid JS" · "the compiler compiles
itself" (self-host, CI-gated) · "we publish our losses" (the bench naming where jz trails earns more
trust than any win).

---

## 5. Page changes — RoI ranked (S effort unless noted)

| Change | Why | Impact | Status |
|---|---|---|---|
| Fix meta description | credibility bug; first text a skeptic reads | 10 | **done** |
| Foreground "valid jz is valid JS / no lock-in" + name DSP in sub | #1 objection + makes best persona feel seen | 9 | **done** |
| FAQ: "Does it fit my build pipeline?" (honest gap) | kills the "toy?" doubt for persona #2 | 6 | **done** |
| Caption the JS/JZ toggle ("Same source. Flip to compile to WASM.") | turns verified-11.8× proof from decoration to proof | 8 | todo — verify visually |
| Move `npm install jz` chip into the hero | conversion action shouldn't be 4 screens down | 8 | todo — verify visually |
| Rewrite H1 benefit-first | 5× read headline vs body | 8 | todo — opinionated, propose |
| FAQ: "What JS semantics differ?" + "Can I debug it?" | answer diligence on-page | 5 | todo |
| Remove `FIXME` comment (`index.html:384`) | hygiene | 2 | todo |

Layout-affecting items are deferred because the browser profile was locked this session (couldn't
visually verify). Per house rule, verify visually before shipping those.

---

## 6. Repo / discoverability (the silent funnel)

- **npm:** name `jz` is unsearchable → description + keywords carry discovery. **(done: broadened
  description; added numeric/signal-processing/audio-worklet/math/js-to-wasm/performance keywords.)**
- **README first screen:** add the hook (faster + no-annotations + no-lock-in + use-cases) above the
  fold; pull the good-for/not-for table up. **(done: hook line added.)**
- **GitHub:** About text + topics are how strangers find you — add `dsp`, `audio`, `js-to-wasm`,
  `numeric`, `signal-processing`, `audio-worklet`, `creative-coding`. *(repo settings — do on GitHub.)*
- **Social-preview image:** one-time, makes every shared link unfurl with the pitch (passive).
- **SEO targets:** "assemblyscript alternative", "javascript to wasm no annotations", "dsp javascript
  wasm", "audio worklet performance wasm".

---

## 7. Do-this-first (superseded)

The ordered play now lives in [`strategy.md`](strategy.md) (§3 sequence): Phase 0 = page
legibility (floatbeat linked, permalinks, ejectability + worst-case-floor lines, version chip);
Phase 1 = the audio wedge artifact + post; Phase 2 = `unplugin-jz` + dogfood; Phase 3 =
Kernel PRs into Dream-100 targets. Earlier items from this list that shipped: meta description,
hero sub, build-pipeline FAQ, bench/README regeneration. Still open from the old list: toggle
caption + H1 (see §2′ audit), `unplugin-jz`/dogfood (now Phase 2).
