#!/bin/bash
B="$JZ_BENCH_BUILD_DIR"
W=probe/wasm
echo "== bounds stage (mmh one guard each; gee one guard a round, leaving the loop; ges one guard each, each leaving the loop)"
node probe/pair.mjs 8 c=$B/tgbd/tgbd.c.wasm base=$W/tgb-base.wasm mmh=$W/tgb-mmh.wasm gee=$W/tgb-gee.wasm ges=$W/tgb-ges.wasm
echo "== threegeom"
node probe/pair.mjs 8 c=$B/threegeom/threegeom.c.wasm rust=$B/threegeom/threegeom.rust.wasm base=$W/tg-base.wasm mmh=$W/tg-mmh.wasm gee=$W/tg-gee.wasm ges=$W/tg-ges.wasm
mkdir -p "$RUNNER_TEMP/asm"; for f in $W/tgb-ges.wasm; do node --print-wasm-code bench/_lib/run-jz-host.mjs $f > "$RUNNER_TEMP/asm/$(basename $f .wasm).txt" 2>&1; done
