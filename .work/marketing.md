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
[`../docs/DESIGN.md`](../docs/DESIGN.md) = technical design record.

---

## Audience reconciliation — earlier notes → personas

This section folds the project's **earlier audience notes** (the former `research.md` NICE
list, now consolidated here; `ecosystem.md` §4's reach map) into the conversion-ranked
personas of §1. Two lenses, complementary — not duplicates:

| Reachable audience (broader notes) | This doc (conversion priority) | Relationship |
|---|---|---|
| **Web Audio / DSP** community (bytebeat demo) | **#1 persona: Web-Audio/DSP kernel authors** | **Agree** — strongest fit. This doc adds *why* (AudioWorklet 2ms budget, GC glitch) and that the page is currently silent for them. |
| **Edge compute** (EdgeJS, CF Workers, Deno) | de-prioritized for the page | **Diverge by goal.** Most edge work is async/IO — *out of jz's subset*. The numeric-on-edge slice is real but narrow and hard to discover. Watch, don't shape the page around it. |
| **Game jams / JS13K** (1–2 kB output) | de-prioritized for the page | **Diverge by goal.** Tiny-wasm size is a genuine *shareable hook*, but jam code is thrown away → low real-adoption conversion, and it's bursty (annual). Keep as a demo, not a page persona. |
| **Porffor community** (education done) | "ignore for page" (compiler-curious) | **Agree-ish.** Reachable, but they star/discuss; they rarely ship a kernel. Serve on the bench page. |
| **README "four/five visitor classes"** (Skeptic, Curious explorer, Pragmatist, Embedder, Language/compiler) | **First-visit questions** (5s/30s/2min) | **Complementary.** The README models *reading-mode* (what a reader scans for); this doc models *who to optimize for* + *attention-horizon ordering*. A DSP author arrives in "Pragmatist" mode. **Finding: that excellent reader-class model is applied in the README but NOT on the landing page.** |

Net: the broader notes answer *"who can be reached"*; the §1 personas answer *"who to optimize
the page for, given the real-adoption goal."* This doc holds both — reachability as context,
conversion-priority as the decision.

---

## 1. Personas, ranked (fit × organic-reachability × ship-likelihood)

### #1 — Web-Audio / DSP kernel authors  ← highest fit, currently invisible on the page
- **Desire (their words):** *"GC pause in the worklet glitches the audio — `process()` has to stay under ~2ms and plain JS won't."*
- **Already tried & rejected:** Rust→wasm (two codebases), hand-WAT (unmaintainable).
- **Why jz:** same source tests in Node, runs as WASM in the worklet — erases the two-codebase tax.
- **Converting demo:** a real DSP kernel (biquad / minisynth) in an AudioWorklet, JS/JZ toggle, zero underruns.
- **Page status:** the hero shows 16 *visual* math examples and zero audio/DSP signal above the fold.

### #2 — JS library authors shipping one fast numeric kernel
- **Desire (their words):** *"The JS is my reference impl; I won't maintain a Rust port. 'Valid jz is valid JS' is the whole pitch."*
- **Why jz:** ship a WASM fast-path for the hot kernel with no second source file or Rust toolchain.
- **Blocking question the page ignores:** *"does this fit my build pipeline?"* — silence reads as "toy CLI."
- **Highest-leverage unlock:** `unplugin-jz` (Vite/Rollup/esbuild) or dogfooding a real lib (digital-filter biquad).

### #3 — Creative coders / generative artists  ← already over-served
- **Desire (their words):** *"rAF drops below 30fps when I add agents; I don't want to learn GLSL for FPS."*
- **Page status:** the 16-thumbnail gallery is their native idiom — already strong. *Don't add more here.*

### Deliberately ignore (for *page* optimization)
- In-browser scientific / data-viz — discovery path broken without Observable.
- Demoscene / bytebeat / JS13K — tiny crowd, throwaway code; floatbeat already serves them.
- WASM / compiler hobbyists (incl. Porffor crowd) — they star, they don't ship. Serve via bench page.

---

## 2. First-visit questions — current-page report card

**5s (bounce-or-stay):** what is this (compiler/lib/runtime)? · will my code work or do I rewrite? · is it fast enough?
→ all **partial**: H1 is mechanism-first; "valid jz is valid JS" is buried in the sub/FAQ; the live demo is uncaptioned.

**30s (evaluation):** what can't it compile? (partial) · build-time or runtime? (**missing**) · what does install look like? (**partial** — footer only) · does it do Float32Array/DSP loops? (**missing**) · JS↔WASM boundary? (**buried**).

**2min (diligence):** bundler/Vite plugin? (**missing** — reads as toy) · debugging/DevTools? (missing) · locked in if abandoned? (**buried** — the best line is FAQ #5) · who else uses it? (**missing**) · when 1.0? (partial).

The one-line diagnosis: **the page is tuned for persona #3 (who needed least help) and silent for
persona #1 (the best adopter); and one line in `<head>` actively repels skeptics (see §4).**

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

## 7. Do-this-first (5, ordered; all page+repo)

1. Fix the meta description (done).
2. Foreground "valid jz is valid JS / no lock-in" in the hero + move `npm install` into the hero (sub copy done; install-chip pending visual verify).
3. Caption the toggle + name DSP/audio worklets (sub naming done; caption pending visual verify).
4. Regenerate `bench/README.md` from `results.json` so the first doc a skeptic reads can't undo the CI badges.
5. Ship `unplugin-jz` or dogfood one real library — the only move that manufactures proof someone ships with jz. For real adoption this outranks every copy change combined.
