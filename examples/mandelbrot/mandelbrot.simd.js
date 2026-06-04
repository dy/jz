// Mandelbrot — 4-wide SIMD (f32x4). Same escape-time image as mandelbrot.js, but
// four pixels march in masked lockstep per iteration, so jz emits wasm SIMD and runs
// ~3-4× a warm-V8 scalar loop (V8 has no auto-SIMD for this divergent loop). The
// bare `f32x4.*` intrinsics are native in jz; under plain V8 the harness installs the
// examples/lib/simd.js polyfill (scalar-emulated) so the same source still runs.
//
// resize/dataOffset/computeLine mirror mandelbrot.js exactly — only the inner loop is
// vectorized — so it drops into the same demo + bench harness.
const NUM_COLORS = 2048;

let mem;
export let resize = (width, height) => {
  mem = new Uint16Array(width * height);
  return mem;
};
export let dataOffset = () => mem;

// escape-time colour from a lane's final (iteration, ix, iy) — same smoothing as mandelbrot.js
const color = (iteration, ix, iy, invLimit) => {
  let col = NUM_COLORS - 1;
  let sqd = ix * ix + iy * iy;
  if (sqd > 1.0) {
    let frac = Math.log2(0.5 * Math.log(sqd));
    let val = (iteration + 1 - frac) * invLimit;
    if (val < 0.0) val = 0.0;
    if (val > 1.0) val = 1.0;
    col = ((NUM_COLORS - 1) * val) | 0;
  }
  return col;
};

// one scalar pixel (the tail, when width isn't a multiple of 4) — identical to mandelbrot.js
const pixel = (real, imaginary, limit, minIterations, invLimit) => {
  let ix = 0.0, iy = 0.0, ixSq = 0.0, iySq = 0.0, iteration = 0;
  while ((ixSq = ix * ix) + (iySq = iy * iy) <= 4.0) {
    iy = 2.0 * ix * iy + imaginary;
    ix = ixSq - iySq + real;
    if (iteration >= limit) break;
    ++iteration;
  }
  while (iteration < minIterations) {
    let ixNew = ix * ix - iy * iy + real;
    iy = 2.0 * ix * iy + imaginary;
    ix = ixNew;
    ++iteration;
  }
  return color(iteration, ix, iy, invLimit);
};

export let computeLine = (y, width, height, limit) => {
  let translateX = width * (1.0 / 1.6);
  let translateY = height * (1.0 / 2.0);
  let scale = 10.0 / (3 * width < 4 * height ? 3 * width : 4 * height);
  let imaginary = (y - translateY) * scale;
  let realOffset = translateX * scale;
  let stride = y * width;
  let invLimit = 1.0 / limit;
  let minIterations = 8 < limit ? 8 : limit;

  let ci = f32x4.splat(imaginary);
  let four = f32x4.splat(4.0);
  let two = f32x4.splat(2.0);
  let vscale = f32x4.splat(scale);
  let voff = f32x4.splat(realOffset);
  let lane = f32x4.lanes(0.0, 1.0, 2.0, 3.0);
  let limV = i32x4.splat(limit);
  let minV = i32x4.splat(minIterations);

  let x = 0;
  while (x + 4 <= width) {
    // real lanes: (x + 0..3) * scale - realOffset
    let cr = f32x4.sub(f32x4.mul(f32x4.add(f32x4.splat(x), lane), vscale), voff);
    let ix = f32x4.splat(0.0), iy = f32x4.splat(0.0);
    let iter = i32x4.splat(0), active = i32x4.splat(-1);

    // escape loop, masked: a lane drops out when |z|>2 or it has done `limit` updates
    let k = 0;
    while (k < limit + 2) {
      let ixSq = f32x4.mul(ix, ix), iySq = f32x4.mul(iy, iy);
      active = v128.and(active, f32x4.le(f32x4.add(ixSq, iySq), four));   // escaped lanes deactivate (no update)
      if (v128.anyTrue(active)) {
        let nIy = f32x4.add(f32x4.mul(f32x4.mul(two, ix), iy), ci);
        let nIx = f32x4.add(f32x4.sub(ixSq, iySq), cr);
        iy = v128.bitselect(nIy, iy, active);                            // only active lanes advance
        ix = v128.bitselect(nIx, ix, active);
        active = v128.and(active, v128.not(i32x4.ge(iter, limV)));       // lanes at `limit` stop (already advanced)
        iter = i32x4.sub(iter, active);                                  // ++ the still-active lanes
        k++;
      } else { k = limit + 2; }
    }

    // smoothing: lanes that escaped before minIterations keep advancing (no escape test)
    let active2 = i32x4.lt(iter, minV);
    let j = 0;
    while (j < minIterations) {
      if (v128.anyTrue(active2)) {
        let nIx = f32x4.add(f32x4.sub(f32x4.mul(ix, ix), f32x4.mul(iy, iy)), cr);
        let nIy = f32x4.add(f32x4.mul(f32x4.mul(two, ix), iy), ci);
        ix = v128.bitselect(nIx, ix, active2);
        iy = v128.bitselect(nIy, iy, active2);
        iter = i32x4.sub(iter, active2);
        active2 = i32x4.lt(iter, minV);
        j++;
      } else { j = minIterations; }
    }

    // colour each lane — extract_lane needs a literal lane, so unroll 0..3 (the log
    // smoothing is scalar, once per pixel, not per iteration)
    mem[stride + x]     = color(i32x4.lane(iter, 0), f32x4.lane(ix, 0), f32x4.lane(iy, 0), invLimit);
    mem[stride + x + 1] = color(i32x4.lane(iter, 1), f32x4.lane(ix, 1), f32x4.lane(iy, 1), invLimit);
    mem[stride + x + 2] = color(i32x4.lane(iter, 2), f32x4.lane(ix, 2), f32x4.lane(iy, 2), invLimit);
    mem[stride + x + 3] = color(i32x4.lane(iter, 3), f32x4.lane(ix, 3), f32x4.lane(iy, 3), invLimit);
    x = x + 4;
  }

  // tail (width not a multiple of 4)
  while (x < width) {
    mem[stride + x] = pixel(x * scale - realOffset, imaginary, limit, minIterations, invLimit);
    x++;
  }
};
