#!/bin/bash
B="$JZ_BENCH_BUILD_DIR"
W=probe/wasm
echo "== cull stage (p2: the tree's compiler; v4: the hand-written pairs)"
node probe/pair.mjs 8 c=$B/tcull/tcull.c.wasm base=$B/tcull/tcull-host.wasm p2=$W/tcs-p2.wasm v4=$W/tcs-v4.wasm
echo "== threecull (tip: the tree's compiler)"
node probe/pair.mjs 8 c=$B/threecull/threecull.c.wasm rust=$B/threecull/threecull.rust.wasm base=$B/threecull/threecull-host.wasm tip=$W/tc-tip.wasm
echo "== threegeom (tip: the tree's compiler)"
node probe/pair.mjs 8 c=$B/threegeom/threegeom.c.wasm rust=$B/threegeom/threegeom.rust.wasm base=$B/threegeom/threegeom-host.wasm tip=$W/tg-tip.wasm
echo "== threescene (tip: the tree's compiler)"
node probe/pair.mjs 8 c=$B/threescene/threescene.c.wasm rust=$B/threescene/threescene.rust.wasm base=$B/threescene/threescene-host.wasm tip=$W/ts-tip.wasm
