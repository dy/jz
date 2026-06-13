# Perf/size improvement loop (autonomous session, 2026-06-13)

User hypothesis: jz slower than V8 ⇒ extra work. Suspect pointer structure / architecture.
Mandate: perf + size + codebase wins, loop until plateaued.

## Baselines (wasm bytes, M4 darwin)
aos 6127 · mat4 7779 · biquad 7909 · bitwise 5747 · mandelbrot 5633 · poly 5832
crc32 6050 · sort 6127 · tokenizer 6647 · json 14062 · callback 5736
jessie 82759 · watr 235578 · dist/jz.wasm 4475418

## Perf baselines (median µs, default node)
self-host(jz) ~59600 · jessie ~2730 · watr ~1380

## Attempts log
(append: what tried / measured / kept|reverted / why)

### ptrOffsetIR type-directed inline (KEPT)
ptrOffsetIR ignored valType; now non-forwarding kinds (object/typed/closure/buffer/date)
extract offset via `i32.wrap_i64` (1 op) instead of calling __ptr_offset. Sound (suite green).
Size: jessie -27, watr -56, json -16. Perf flat on jessie/watr (their hot accesses are
ARRAY/forwarding, not helped). Measured: 3.96M __ptr_offset calls/jessie-run, 72.6% forwarding-
eligible, only 8.29% of those actually forward (2.6M wasted checks — the user's "extra work").

### Data-driven plateau confirmation (profiles)
jessie profile (cli build, 400 iters): ~33% in jessie's OWN parse functions
(parse$space 9.5%, parse$step 8%, expr 3.6%, asi — untouchable user code) +
value-model helpers: __typed_idx 6.7% (ARRAY fast-path, kind-erased node access),
hashNode 6%, __dyn_get_expr_t 4.3%, __hash_set_local 2.3%, __char_at 2%.
watr profile: FLAT 2.3% across __dyn_move, __str_endswith, __hash_set_local,
__str_hash, __ptr_offset, __str_eq, __arr_shift, __ihash_get_local — no
concentrated hot spot. Classic distributed representational tax.

### Investigated + NOT pursued (this session)
- redundant-mask peephole fold (wrap(and(x,0xFFFFFFFF))→wrap(x)): sound + real
  size win (json -76, tokenizer -119) BUT breaks the JSON shape-parser via an
  unexplained size coupling (canSpecializeJsonShape at emit, peephole post-emit —
  mechanism not understood). Reverted; don't ship unexplained couplings. LATENT
  FRAGILITY: any size optimization can trip the json shape guard — worth a future
  robustness fix to decouple the shape decision from byte-size noise.
- __typed_idx et-dispatch reorder (small-types-first): ALL numeric corpus cases
  have 0 __typed_idx call sites (direct typed loads); only metacircular hit it,
  via the ARRAY fast-path not the et-dispatch → 0 corpus benefit. Skipped.
- forwarding-free array model: ~3-5% ceiling on metacircular but days-scale +
  high regression risk (touches every helper). Not a 3-4h bet.

### Conclusion
jz is at its value-model optimization frontier. Provable cases use optimal direct
codegen (0 dispatch); the metacircular residual is a flat-distributed polymorphic
tax (~2.3%/helper × dozens) with no concentrated lever — the fundamental AOT
NaN-box cost. Net session win: ptr-offset type-directed inline + forwarding
bitmask (b1621d2): dist/jz.wasm -3.5KB, per-module -16..-119B, perf-flat, sound.
