#!/bin/bash
B="$JZ_BENCH_BUILD_DIR"
W=probe/wasm
echo "== threescene N=1000 x 200 frames (fits the L2)"
node probe/pair.mjs 8 c=$W/tss.c.wasm rust=$W/tss.rust.wasm jz=$W/tss-jz.wasm
echo "== threescene N=10000 x 20 frames"
node probe/pair.mjs 8 c=$B/threescene/threescene.c.wasm rust=$B/threescene/threescene.rust.wasm jz=$B/threescene/threescene-host.wasm
