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

### Forwarding-free model: empirically sized, rejected
Raw-WAT prototype (80M-iter call-heavy loop, per-access forwarding check that can't
be CSE'd vs stable offset): forwarding overhead = 3.9% in the SYNTHETIC WORST CASE
(2.7ms of 71.3ms). Real jessie/watr CSE many accesses (LICM hoists ptr_offset when
no growth-call in the loop), so the realistic ceiling is ~2%. A days-scale,
every-helper-touching rewrite for ~2-4% is poor risk/reward — and b1621d2 already
captured the non-forwarding-kind portion safely. User's "pointer structure = extra
work" hypothesis VALIDATED (forwarding is real extra work) but it's a ~2-4% lever,
not the headline. The headline 1.6-1.8x gap is the distributed NaN-box decode tax
spread across every op — no single mechanism, confirmed by 3 profiles + this sizing.

## Typed-region / "avoid NaN-boxing" investigation (empirical)

PREMISE REFUTED BY DATA. Raw-WAT prototypes (V8, M4):
- Boxing (i64.reinterpret_f64 round-trip): **1.1% overhead** — effectively FREE.
  V8 compiles bit-reinterpretation to no-ops. NaN-boxing is NOT the cost.
- Per-op type-check (is-number / tag dispatch): **7.7%** in a tight 1-op loop —
  THIS is the value-model tax (dispatch on polymorphic values, not boxing).
- Typed-region (check tag ONCE vs dispatch-per-access, 3 accesses to one node):
  **3.8%** speedup — and that's the synthetic best case where V8 can CSE the
  inlined checks.

What jz ALREADY does (the tractable wins are captured):
- Numbers stored as raw f64 (no boxing). Proven-monomorphic locals use raw
  i32/f64 (the `wasm` rep). Box/unbox reinterprets are free.
- Type computation hoisted: __ptr_type is in SAFE_OFFSET_CALLS (CSE'd across
  accesses); helpers have _t variants taking a pre-computed type; _known
  variants skip the tag check for statically-proven kinds.
- Real jz `node[0]+node[1]+node[2]`: 1 shared tag extract in $f, ptr_offset
  CSE'd; the 3 typed_idx CALLS each re-check the tag internally (function
  boundary blocks CSE) — the only residual.

The residual (per-helper-call tag re-check) can only be removed by INLINING the
raw access into the call site — exactly `inlineArrayIdx`, which the frontier
already tried and reverted at +260KB bloat. So the typed-region is a MODEST
(~3-4%) lever gated behind significant code bloat, attacking dispatch (not
boxing, which is free). jz's value model is near-optimal: the transformative
"avoid NaN-boxing" win doesn't exist because boxing was never the cost.

### julia: typed-store + untyped `+` → spurious string-concat fork (SOURCE-FIXED, compiler gap open)
Symptom: julia 1.25× slower than JS. Hot per-pixel loop `zy = 2*zx*zy + cim`,
`zx = zx2-zy2 + cre` compiled to `if(__is_str_key(cim)) __str_concat else f64.add`
on every iteration — `cre`/`cim` are untyped exported f64 params.
Root isolation (minimal repros): NEITHER a typed-array element store NOR an
untyped `+` loads `__str_concat` alone; TOGETHER they do. `px[0]=5; return a+c`
loads it; either half alone does not. The `+` emitter (emit.js:2417) forks iff
`ctx.core.stdlib['__str_concat']` is present; a typed-array store makes it
present (module-include interaction, not the store's own value coercion —
verified with a constant store value). So the typed store poisons every untyped
`+` in the function.
Source fix (shipped, examples/julia): `cre = +cre; cim = +cim` pins numeric →
fork gone, pixel-identical, +15% (11.8→10.3ms @400×300).
Compiler fix (OPEN, needs care): (a) a `+` whose result is immediately ToInt32'd
(`|0`) or stored to an integer typed array can't be a string — skip the fork;
(b) a typed-array store should not pull `__str_concat` into stdlib scope. Both
touch the include/treeshake + hot `+` path — deserve an isolated PR with full
suite + golden-size verification, not an end-of-session change.

### canon-strip: NaN-canon dead when result feeds a NaN-safe consumer (KEPT, big win)
f64.sqrt/min/max mint a sign-nondeterministic NaN that math.js `canon`-izes (local +
select + f64.ne) to stay distinct from NaN-boxed pointers in untyped ===/typeof. When
the result feeds f64.add/sub/mul/div or another math call, the consumer propagates the
NaN identically and re-canon-izes on escape → inner canon is dead.
Fix: canon() tags its wrapper `.canonOf`; f64 arith ops (emit.js) + math-call args
(math.js fn) strip via the tag. Sound: value stays type-numeric (=== lowers to f64.eq,
NaN-by-value); only escape-to-untyped needs canonical bits, which it still gets.
Measured (interleaved, M-series): sqrt-heavy loop 1.22x→0.85x vs V8 (now FASTER, ==
hand-wasm). full suite 2204 pass, differential+fuzz: zero jz-vs-JS divergence.

### Float-kernel ceiling: jz codegen == or beats hand-wasm; residual gap is wasm-vs-JIT
Verified with watr hand-written wasm baselines:
- pure sqrt loop:        jz 0.85x vs V8,  jz == hand-wasm
- distance/force kernel: jz 1.16x vs V8,  jz 0.95x vs hand-wasm (jz BEATS hand-wasm)
Conclusion: where jz emits optimal wasm (clean f64 arith, no canon, no fork), it
matches or beats hand-written wasm. The residual 1.0-1.2x vs V8 on conversion-heavy
kernels (per-iter f64.convert_i32_s for `i*0.001`) is V8's JS-JIT keeping the index
integer and fusing better than the wasm engine — a wasm/JIT boundary, NOT a jz codegen
gap. math.log remains 1.17x (polynomial vs native hardware log) — separate, numeric.
