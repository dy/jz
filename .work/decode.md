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
| A1 | Scalar parameters lose their range across a call: `unpcBlock(…, numactive, …, denshift)` gets f64 params; `coefs[k] -= sgn` goes through `__dyn_set` | `param-range.js` → `param-range-control.js` (masked to the bit fields) | 11.86 / 15.07 ms 0.79× | 1.28× | ALAC `unpcBlock`, half of its time: about the whole ALAC gap | S2's form; it loses range, not kind |
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
| alac | A1 | about 1.14× (scaled from `unpcBlock`) | 24-bit not profiled |

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

Not diagnosed: wav pcm24/pcm32, the ADPCM and law cases, aiff alaw (0.50×, a 2000-sample
fixture: likely per-call setup), 24-bit ALAC. Everything at the default level only.
