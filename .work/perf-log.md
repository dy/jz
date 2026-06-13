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
