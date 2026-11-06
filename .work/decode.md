# @audio/decode on jz

Every @audio/decode codec written in JavaScript, compiled unchanged, against the same file
under V8. Measured 2026-11-05 on jz 1045150c2 (default level), @audio/decode d571810 (the
family checkout), Node 25.9.0, Apple M4 Max, load average 13–30 throughout: ratios held
across reruns, absolute times did not. Rerun: `node bench/_audiojs/decoders.mjs`.

Not here: the codecs that are C compiled to wasm (aac, ac3, amr, ape, dts, eac3, flac, gsm,
mod, mp3, mpc, opus, vorbis, wavpack, wma), which have no JavaScript to compile, and the
containers (avi, mp4, webm), async dispatchers to those codecs through `import()`.

## Result

All 19 cases compile from the unchanged packages and decode bit-exactly. jz is ahead of
V8 on 2 of them (more than 5%), within 5% on 3, behind on 14.

| case | V8 | jz | against V8 |
|---|---|---|---|
| wav pcm16 | 720 µs | 2.50 ms | 0.29× |
| wav pcm24 | 1.36 ms | 1.87 ms | 0.73× |
| wav float32 | 678 µs | 2.41 ms | 0.28× |
| wav ima-adpcm | 82 µs | 81 µs | 1.02× |
| wav ms-adpcm | 146 µs | 221 µs | 0.66× |
| wav mulaw | 8 µs | 6 µs | 1.24× |
| aiff pcm16 | 2.09 ms | 2.23 ms | 0.94× |
| aiff pcm24 | 2.29 ms | 2.29 ms | 1.00× |
| aiff alaw | 6 µs | 12 µs | 0.50× |
| caf pcm16 | 1.90 ms | 1.69 ms | 1.12× |
| caf float32 | 1.90 ms | 2.05 ms | 0.93× |
| caf ima4 | 144 µs | 142 µs | 1.02× |
| qoa | 4.02 ms | 8.71 ms | 0.46× |
| tta 16-bit | 14.34 ms | 20.25 ms | 0.71× |
| tta 24-bit | 2.28 ms | 3.98 ms | 0.57× |
| tta 6ch | 7.65 ms | 10.51 ms | 0.73× |
| dsd dsf64 | 72.92 ms | 115.09 ms | 0.63× |
| alac 16-bit | 25.32 ms | 28.99 ms | 0.87× |
| alac 24-bit | 26.33 ms | 34.69 ms | 0.76× |

The host boundary is not the gap: a decode-shaped call that only allocates the output
costs 41 µs, and the input crosses as itself (`Array+`). Profiles put 85–92% of jz's time
in the codec's own loop.

## Gaps

Each class has its kernel and control in `bench/_audiojs/repro/decode/`, run with
`node bench/_audiojs/repro/decode/run.mjs <file> [exports]`. Times from that runner,
one file per process.

| | Class | Kernel → control | V8 / jz | control | Hits | Prior |
|---|---|---|---|---|---|---|
| D1 | One method call on a host value anywhere in the module (`arr.foo()`, `.map`, `.forEach`, `.subarray`: the `__ext_method` import) de-types an unrelated hot closure: its typed reads go through `__dyn_get_t`, its `sum +=` through `__is_str_key` / `__add_slow` per tap | `ring-dyn.js` → `ring.js` | 8.06 / 24.45 ms 0.33× | 0.71× | DSD stage 1 (70% of its time): about the whole DSD gap. ALAC `dynDecomp` carries the signature, at parity | new |
| G1 | A typed array built by a helper from a constructor parameter (`samples(raw, T, n)` → `new T(buf, off, n)`) returns boxed, kind unknown: `__typed_idx_tagged` per element | `pcm.js k1r` → `k1` | 824 µs / 3.16 ms 0.26× | 0.96× | WAV pcm16, pcm32, float32/64 | L1 used to reject this shape; it compiles now, untyped |
| G2 | A secondary induction (`k += nCh`, `off += 4` stepped beside the loop counter) stays f64: f64 add, `trunc_sat` and an index check per access; on a DataView an out-of-line `__dv_index(f64)` per get | `pcm.js c1f` → `c1fi` | 261 / 375 µs 0.69× | 1.24× | WAV all PCM, CAF all LPCM | new |
| D2 | A trip count read from a destructured record (`const { C, tables } = st`) leaves the induction f64; `C \| 0` does not help, a literal does | `ring.js` → `ring-literal.js` | 9.44 / 13.35 ms 0.71× | 0.89× | DSD stage 1 | new |
| A1 | Three losses, fixed on branch alac-gap. (a) A call inside a closure typed its arguments by the enclosing function's locals and walked no hull for them: `unpcBlock`, called only from `decodeElements`, took `numactive`, `denshift` as f64 (5face223f). (b) A `for` counter entering from a name (`j = lim`) under a bound of unknown integrality (`num`, the frame length) took no integral copy where the names it guards are read by inner loops: the main loop counted in f64 (15415df9c). (c) A descending counter (`kk = numactive - 1; kk >= 0; kk--`) was not versionable: its accesses took the walk's static hull, `kk < 4095` in the kernel against a 32-entry table, which never passed (49c2dcb7f) | `param-range.js` (c), `param-bound.js` (b) → `param-range-control.js` | 0.90–0.93× → 1.14–1.16× (c) | 1.14× (same run) | ALAC `unpcBlock` | S2's form |
| K1 | A row of an array of arrays (`tab[i][q]`): length unknown, a miss reads `undefined`, so what it feeds runs in f64; plain integer Arrays are f64 too, typed rows do not help | `table-rows.js plain`, `typed` → `flat` | 3.74 / 10.11 ms 0.37× | 0.87× | QOA `qoa_dequant_tab[sf][q]`: about 87% of the QOA gap | partly S3/S4 |
| K2 | An integer recurrence bounded by a clamp stays f64: the clamp's bound is not fed back into the sum's range | `clamp-acc.js clamp` → `control` | 883 µs / 2.11 ms 0.42× | 0.91× | QOA, while K1 holds | new |
| K3 | Methods of a factory-made object closing over mutable integer `let`s (`makeBits → { unary, read }`): `call_indirect` with the boxed ABI, captured state in f64 cells loaded and stored per call | `closure-state.js closures` → `globals`, `locals` | 19.75 / 50.76 ms 0.39× | 0.84×, 0.88× | TTA bit reader (32% of its time) | S8's residual, unnamed there |
| K4 | Mutated integer fields of a non-escaping record passed per sample (`ch.k0`, `ch.sum0`): f64 slots, truncate and convert per update, heap-allocated, not scalar-replaced | `record-fields.js fields` → `typed` | 2.54 / 13.75 ms 0.18× | 1.05× | TTA `decodeValue` | new; S3 covers reads only |
| G6 | A local lambda is not spliced at `a[c][i] = f(…)`: `src/compile/plan/inline.js` splices `X = call()` only under `prefixCommutesWithLhs`, and a nested receiver is not a plain target | `pcm.js k6` → `c6e` (`L[p] = expand()`) | jz 91.8 → 35.9 ms in one module | | WAV ms-adpcm | new |
| G5 | Call-site specialization matches the exact pointer aux: an owned Uint8Array gets `$spec`, a subarray view the generic variant | not reduced (a kernel did not reproduce it) | | | AIFF all PCM (`decodeAiffRaw(chunk.subarray(…))`), 5–10% | S2 family |

How much each case's gap they explain, from edited copies of the packages (not from
compiler fixes; the copies are not kept):

| case | explained by | edited copy reaches | not diagnosed |
|---|---|---|---|
| wav pcm16 | G1 | 0.82× | the rest; likely the table read `t[s[k]]` from a `??=` module global |
| wav float32 | G1 + G2 | 1.21–1.30× | |
| wav ms-adpcm | G6 | jz 1.74× faster than unspliced | |
| aiff pcm16 | G5 | 0.98–1.01× | |
| caf float32 | G2 | 1.10–1.19× | |
| qoa | K1 (+ K2) | 0.87× | ~13%: DataView offset in f64 (`__dv_index` ×2 per slice), an `__iter_release` check per slice |
| tta | K3 + K4 | 0.84× (about 43% of the gap) | `>>> 0` uint32 arithmetic in f64, the unbounded `unary` counter f64, `gbit` not inlined, a frame prologue per `decodeValue` call |
| dsd | D1, then D2 | about level, then about 1.2× (scaled from stage 1) | |
| alac | A1 (fixed: 16-bit 1.01× → 1.06×, 24-bit 0.51× → 0.88× against main in one alternating run; in-process A/B of the wasm alone has A1(c) level with (a)+(b)) | | 24-bit: `read` 16.8% of jz's time, about 2% of V8's (A2) |

Shared shape: integer-ness and typed kind are proven inside a function but do not survive a
record field, a parameter, a secondary induction or a helper's return. Four of the eleven
classes (G2, D2, A1, K4) are that one loss on four carriers.

## Also found

- `Int32Array.of(…)` and `Uint8Array.of(…)` reject: "'Int32Array' is not in scope". Likely
  every `TypedArray.of`.
- In one process, a case's speed depends on the cases before it: CAF float32 measured
  0.95–1.11× alone and 0.56× after CAF pcm16, since its 1.0× rests on V8 speculatively
  inlining `$__dv_index` (0.59× under `--no-wasm-inlining`). `decoders.mjs` and the repro
  runner run one case per process.

- `T.BYTES_PER_ELEMENT` on a typed constructor held as a value read `undefined` at every
  level (decode-wav's `samples()` survived it: `byteOffset % undefined` is NaN, so the
  realign branch never ran). Fixed with G1.
- A typed array's named property read under a computed string key (`t[key]`, `key =
  'tag'`, the property stored by `t.tag = 'str'`) reads `undefined`. Open, on main too.
- Copying a function that calls itself per closure set (watr's `walk(node, fn)`, three
  copies) made the watr self-compile in test/perf.js run for over four minutes where it
  takes 20 s. `splitByClosureArgs` now leaves such a function whole; which later pass
  the copies sent into the long run is not found.
- Pre-existing failures on main 045d0c89f, unrelated: `min recurrence (watr)` in
  optimizer.js, `from, as and of are names outside their clauses` in parser-bugs.js, and the
  runner's own off-terminal test.

Not diagnosed: wav pcm24/pcm32, the ADPCM and law cases, aiff alaw (0.50×, a 2000-sample
fixture: likely per-call setup).

- A2, open: ALAC's cookie is the host's, so its bytes are any value: `cfg.bitDepth = c[5]`
  reaches `read(bb, chanBits)` raw in the CPE escape branch, `read`'s `n` is ANY, and
  `bb.pos = p + n` may become a string. Every `read` then tests both operands with
  `__is_str_key` calls, takes an escape frame and runs two write barriers on the field
  store; `readShift` calls it per sample at 24-bit. `frameLength = … + c[o + 3]` may
  concatenate too, which is why `numSamples` (`unpcBlock`'s `num`) is NUMBER|STRING and
  stays f64. A host typed array's elements typed as numbers (a guarded variant at the
  boundary, as array arguments already have) would remove both. Testing the dynamic
  `+` for two Numbers before the string test was measured and not kept: under load it
  read 0.89–1.26×.
- A1(b)'s copy is dead weight where the bound narrows to a word anyway (`param-bound.js`,
  `num = cfg[0] >>> 0` over a constant table: main 1.22–1.27×, branch 1.10–1.15×): the
  copy, its resumption and the loop as written exhaust `optimize/specialize.js`'s growth
  budget before the second adapting loop's split. The gate needs the parameter's word,
  which `narrowSignatures` settles after this plan pass.
- A1(c) guarding every access by the entry (`out[pb - kk]` too) cost ALAC 16-bit 10–15%:
  the adapting loops often run one or two rounds, so a per-entry i64 guard outweighs
  them; the kept form guards only the hull's keys. Lifting a nested descending level
  whose entry is a top-invariant expression (`numactive - 1`) to the nest's one guard is
  not done; nested levels need a literal entry to lift.

The speed tier covers none of the classes but K4 (`record-fields.js` 0.18× → 0.83×, the
record scalar-replaced) and is slower than the default on ALAC's `unpcBlock` (0.53×),
AIFF (0.72×) and TTA (0.53×): the fixes belong in the shared passes.

## Fixed (branch decode-opt)

| | Change | Kernel before → after | Decoder before → after |
|---|---|---|---|
| D1 | A method on a host value leaves typed arrays' named properties as the program stores them (summary/index.js `escapeReceiver`) | `ring-dyn.js` 0.33× → `ring.js` level | dsd 0.63× → 0.87× |
| G1 | `jz:typed` constructors carry `BYTES_PER_ELEMENT`; a copy of a function per set of closures its calls pass a parameter it calls or reads through, ahead of the inliner and summarized at once (plan/called-args.js `splitByClosureArgs`) | `pcm.js k1r` 0.26× → 1.08–1.20×, two-site float 0.26× → 0.76× | wav pcm16 0.29× → 0.85×, float32 0.28× → 0.74× |
| D2 | A closure's loop versions a binding it captures that nothing writes as one of its own (plan/integral-loops.js) | `ring.js` 0.71× → 0.84× (`ring-literal.js` 0.91×) | dsd, with D1 |

Measured under load 20–40; the decoder rows are single runs.
