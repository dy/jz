// stdlib-ddot.js — @stdlib/blas/base/ddot/lib/ddot.js from stdlib 0.4.1 (Apache-2.0), bundled from its CommonJS
// sources by scripts/stdlib-probe.mjs (`bench @stdlib/blas/base/ddot/lib/ddot.js stdlib-ddot blas1 -100 100`):
// the package's own code with the module seams gone, nothing rewritten. The
// sweep follows its benchmark/benchmark.js: inputs uniform in [-100, 100], integer-valued (exact in any order), N varied per call.
// Copyright (c) The Stdlib Authors. Licensed under the Apache License, Version 2.0
// (http://www.apache.org/licenses/LICENSE-2.0); the notices of the bundled files
// are retained by reference to the package.
import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'

function stride2offset(N, stride) {
  if (stride > 0) {
    return 0;
  }
  return (1 - N) * stride;
}
var main_default = stride2offset;

var lib_default = main_default;

var M = 5;
function ddot(N, x, strideX, offsetX, y, strideY, offsetY) {
  var dot;
  var ix;
  var iy;
  var m;
  var i;
  dot = 0;
  if (N <= 0) {
    return dot;
  }
  ix = offsetX;
  iy = offsetY;
  if (strideX === 1 && strideY === 1) {
    m = N % M;
    if (m > 0) {
      for (i = 0; i < m; i++) {
        dot += x[ix] * y[iy];
        ix += 1;
        iy += 1;
      }
    }
    if (N < M) {
      return dot;
    }
    for (i = m; i < N; i += M) {
      dot += x[ix] * y[iy] + x[ix + 1] * y[iy + 1] + x[ix + 2] * y[iy + 2] + x[ix + 3] * y[iy + 3] + x[ix + 4] * y[iy + 4];
      ix += M;
      iy += M;
    }
    return dot;
  }
  for (i = 0; i < N; i++) {
    dot += x[ix] * y[iy];
    ix += strideX;
    iy += strideY;
  }
  return dot;
}
var ndarray_default = ddot;

function ddot2(N, x, strideX, y, strideY) {
  var ix;
  var iy;
  if (N <= 0) {
    return 0;
  }
  ix = lib_default(N, strideX);
  iy = lib_default(N, strideY);
  return ndarray_default(N, x, strideX, ix, y, strideY, iy);
}
var ddot_default = ddot2;

// ../../../../driver.js
var driver_default = ddot_default;

const fn = driver_default
const N_IN = 1024
const N_EVAL = 1 << 12
const N_RUNS = 21
const N_WARMUP = 5

// XorShift32, uniform in [lo, hi): deterministic per target.
const uniform = (n, lo, hi, seed) => {
  const out = new Float64Array(n)
  let s = seed | 0
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out[i] = lo + ((s >>> 0) / 4294967296) * (hi - lo)
  }
  return out
}

const run = () => {
  const x = uniform(N_IN, -100, 100, 0x1234abcd), y = uniform(N_IN, -100, 100, 0x9e3779b9)
  for (let i = 0; i < N_IN; i++) { x[i] = Math.floor(x[i]); y[i] = Math.floor(y[i]) }   // exact products and sums, whatever the lane order
  const out = new Float64Array(N_EVAL)
  const sweep = () => { for (let i = 0; i < N_EVAL; i++) out[i] = fn(N_IN - (i & 7), x, 1, y, 1) }
  for (let i = 0; i < N_WARMUP; i++) sweep()
  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    sweep()
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64(out), N_EVAL, 1, N_RUNS)
}

export let main = () => {
  run()
}
