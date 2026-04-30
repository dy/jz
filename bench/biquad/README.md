# biquad

DSP filter cascade benchmark. This case is part of the unified suite:

```sh
npm run bench -- biquad
node bench/bench.mjs biquad --targets=nat,wat,v8,jz,porffor,jz-w2c
```

Files:

| file | purpose |
| --- | --- |
| `biquad.js` | canonical JavaScript source for V8, jz, and flattened Porffor/QuickJS runs |
| `biquad.c` | native C baseline (clang/gcc, `-ffp-contract=off` for parity) |
| `biquad.rs` | Rust baseline (`rustc -O target-cpu=native`) |
| `biquad.go` | Go baseline; FMA-fused on arm64 (parity flag `fma`, not `DIFF`) |
| `biquad.as.ts` | AssemblyScript baseline (`asc -O3 --runtime stub`) |
| `biquad.wat` | hand-written WAT floor |
| `biquad-flat.js` | pre-flattened JS used by older external compiler runs |
| `run-wat.mjs` | case-specific driver for the hand-written WAT baseline |

The workload is an 8-stage direct-form-1 biquad cascade over 480,000 f64
samples. It stresses typed-array narrowing, f64 arithmetic, load-offset fusion,
and per-stage loop structure.
