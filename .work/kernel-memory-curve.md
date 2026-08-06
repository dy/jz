# Kernel memory-amplification: size→peak curve (2026-08-06)

Discriminator task (coordinator brief): does the kernel (self-hosted
`dist/jz.wasm`) OOB on the 12MB-ish `bench/jz/jz.js` graph because of (A)
genuine bump-arena exhaustion, or (B) an i32 address-signedness bug firing
*before* real exhaustion? Answer: **(A)**, confirmed directly rather than
inferred — plus one real, narrower (B)-class bug found and fixed as a
byproduct (see `.work/todo.md`, same date, for the fix write-up).

## Method

`instantiate(dist/jz.wasm, {memory: N})`, call `exports.default(code, 0,
optJSON, modulesJSON, 0)` — the exact ABI `test/kernel-target.js` uses.
`memory:` on an own-memory module is compile-time-baked (not an instantiate
option — confirmed empirically: instantiating with `memory:64` vs
`memory:8192` against the *same* dist/jz.wasm produced byte-identical
results both times), so the reported `initPages` below is dist/jz.wasm's
actual baked-in initial (8192 pages / 512MB) regardless of what's passed —
irrelevant to the outcome. `mem=` is `self.memory.buffer.byteLength` read
immediately after the call returns (success) or throws (failure) — the
organic post-compile watermark, not a synthetic ceiling (dist/jz.wasm is
NOT built with a max initial, so growth is real `__memgrow` activity).

Three REAL, unmodified graphs via `resolveModuleGraph(entry, {resolveNode:
true})` — no synthetic padding, no truncated module lists (an earlier
attempt at truncating self.js's own 149-module closure by prefix produced
non-representative "N bare side-effect imports, no logic" programs that hit
unrelated shapes; abandoned in favor of real complete graphs):

| entry | graph size | result | peak (`memory.buffer.byteLength`) |
|---|---|---|---|
| `bench/jessie/jessie.js` (jessie parser) | 60,086 B | **OK** | 1,073.7 MB |
| `bench/watr/watr.js` (watr WAT compiler) | 103,774 B | **OK** | 4,295.0 MB (= 65536 pages, the wasm32 ceiling — succeeds by the skin of its teeth) |
| `.work/jzify-entry.mjs` (jzify + parse.js closure) | 405,666 B | **FAIL** — `unreachable` | 4,295.0 MB (memgrow's own deliberate "need > 65536 pages" abort) |
| `bench/jz/jz.js` (full self-host graph: parse→jzify→prepare→compile→watr-encode, 149 modules) | 5,580,867–5,583,700 B | **FAIL** — `unreachable` | 4,295.0 MB (same deliberate abort) |

## Reading the curve

60KB→1.07GB, 104KB→~4.3GB: a ~4× byte increase costs ~4× the memory, but the
104KB row already needs the ENTIRE 4GiB address space to just barely
succeed. The very next real graph tested (405KB, only 4× bigger again)
already exceeds it. This is a steep, accelerating cost curve, not a flat
multiplier — consistent with (and sharpens) the already-established
baseline ("~20× native RSS for ~2KB sources, 512MB watermark") by showing
the amplification factor itself GROWS with input size. Root cause already
named by the coordinator: the bump arena retains every intra-compile
temporary for the whole compile with no interior freeing — a big/complex
input accumulates proportionally more *live-looking* garbage, not just
proportionally more real data.

## Why this is (A), not (B)

Both the small-input success cases (jessie, watr) and the large-input
failure cases (jzify-entry, jz-full) — at BOTH the standard 512MB-baked
build and (after the fix banked in `.work/todo.md`) a full-4GiB-initial
build — resolve through `__memgrow`'s existing, deliberate ceiling check
(`module/core.js`: `(if (i64.gt_u need 65536) (then (unreachable)))`) rather
than a raw, uncontrolled wasm bounds trap. That check is *designed* to fire
exactly when a request needs more pages than the wasm32 4GiB ceiling can
ever provide — which is precisely what's happening. No address computation
is silently wrapping past 2GiB and misdirecting a load/store before this
guard gets a chance to run.

(Before the `.work/todo.md`-logged fix, forcing a kernel build with a FULL
`memory:65536`-page initial — i.e. genuinely no room left to grow, ever —
turned this same jz-full-graph failure into a raw "memory access out of
bounds" instead of the clean `unreachable`: with `memory.size()` already at
the ceiling, `__memgrow`'s own guard becomes permanently dead code, leaving
`__alloc`'s un-widened i32 `ptr+bytes` pointer-bump math as the last line of
defense. That's the real (B)-class bug — but note its trigger condition is
"the arena has already organically reached the true ceiling", which is
itself an (A)-shaped situation; the fix converts an unsound crash into a
sound one, it doesn't create headroom.)

## Verdict for the jz×jz bench row

Unlocking `jz×jz` (the compiler compiling itself as a bench workload) needs
real capacity, not a signedness patch: the phase/region arena discipline
already named as the strategic fix (out of this task's bound). No amount of
address-arithmetic hardening turns a genuine >4GiB request into a successful
one. This curve is the sizing evidence for that redesign — the accelerating
cost trend visible here (not just the flat baseline multiplier) should
inform its target: whatever retains state across phases needs to actually
free per-phase temporaries, not just amortize their allocation.
