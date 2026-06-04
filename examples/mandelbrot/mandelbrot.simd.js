// Mandelbrot — 4-wide SIMD (f32x4), same continuous-colour image as mandelbrot.js.
// Four pixels march in masked lockstep and the smooth colouring (log2(½·log|z|²)) runs
// 4-wide through a SIMD log — a large bail-out (|z|² > 256) keeps |z|² inside f32 range
// so the log is faithful. jz emits wasm SIMD and beats warm V8 scalar at every limit
// (no auto-SIMD there). Bare `f32x4.*` are native in jz; under plain V8 the harness
// installs examples/lib/simd.js (scalar-emulated) so the same source still runs.
const NUM_COLORS = 2048;
const BAILOUT = 256.0;

let mem;
export let resize = (width, height) => {
  mem = new Uint16Array(width * height);
  return mem;
};
export let dataOffset = () => mem;

// SIMD natural log (Cephes logf, 4 lanes) — ~3e-7 vs Math.log over the colour range.
let slog = (x) => {
  let e = i32x4.sub(v128.and(i32x4.shrU(x, 23), i32x4.splat(255)), i32x4.splat(126));
  let m = v128.or(v128.and(x, i32x4.splat(8388607)), i32x4.splat(1056964608));
  let less = f32x4.lt(m, f32x4.splat(0.70710678));
  m = v128.bitselect(f32x4.sub(f32x4.add(m, m), f32x4.splat(1.0)), f32x4.sub(m, f32x4.splat(1.0)), less);
  e = i32x4.sub(e, v128.and(less, i32x4.splat(1)));
  let ef = f32x4.convertI32(e);
  let z = f32x4.mul(m, m);
  let y = f32x4.splat(0.070376836292);
  y = f32x4.add(f32x4.mul(y, m), f32x4.splat(-0.1151461031));
  y = f32x4.add(f32x4.mul(y, m), f32x4.splat(0.116769987));
  y = f32x4.add(f32x4.mul(y, m), f32x4.splat(-0.12420140846));
  y = f32x4.add(f32x4.mul(y, m), f32x4.splat(0.14249322787));
  y = f32x4.add(f32x4.mul(y, m), f32x4.splat(-0.16668057665));
  y = f32x4.add(f32x4.mul(y, m), f32x4.splat(0.20000714765));
  y = f32x4.add(f32x4.mul(y, m), f32x4.splat(-0.24999993993));
  y = f32x4.add(f32x4.mul(y, m), f32x4.splat(0.33333331174));
  y = f32x4.mul(f32x4.mul(y, m), z);
  y = f32x4.add(y, f32x4.mul(ef, f32x4.splat(-0.000212194440)));
  y = f32x4.sub(y, f32x4.mul(f32x4.splat(0.5), z));
  return f32x4.add(f32x4.add(m, y), f32x4.mul(ef, f32x4.splat(0.693359375)));
};

// one scalar pixel (the tail, when width isn't a multiple of 4) — identical to mandelbrot.js
const pixel = (real, imaginary, limit, invLimit) => {
  let ix = 0.0, iy = 0.0, ixSq = 0.0, iySq = 0.0, iteration = 0;
  while ((ixSq = ix * ix) + (iySq = iy * iy) <= BAILOUT) {
    iy = 2.0 * ix * iy + imaginary;
    ix = ixSq - iySq + real;
    if (iteration >= limit) break;
    ++iteration;
  }
  let col = NUM_COLORS - 1;
  let sqd = ix * ix + iy * iy;
  if (sqd > BAILOUT) {
    let frac = Math.log2(0.5 * Math.log(sqd));
    let val = (iteration + 1 - frac) * invLimit;
    if (val < 0.0) val = 0.0;
    if (val > 1.0) val = 1.0;
    col = ((NUM_COLORS - 1) * val) | 0;
  }
  return col;
};

export let computeLine = (y, width, height, limit) => {
  let translateX = width * (1.0 / 1.6);
  let translateY = height * (1.0 / 2.0);
  let scale = 10.0 / (3 * width < 4 * height ? 3 * width : 4 * height);
  let imaginary = (y - translateY) * scale;
  let realOffset = translateX * scale;
  let stride = y * width;
  let invLimit = 1.0 / limit;

  let ci = f32x4.splat(imaginary);
  let bail = f32x4.splat(BAILOUT);
  let two = f32x4.splat(2.0);
  let lane = f32x4.lanes(0.0, 1.0, 2.0, 3.0);
  let vscale = f32x4.splat(scale);
  let voff = f32x4.splat(realOffset);
  let limV = i32x4.splat(limit);
  let ncF = f32x4.splat(NUM_COLORS - 1);
  let invL = f32x4.splat(invLimit);

  let x = 0;
  while (x + 4 <= width) {
    let cr = f32x4.sub(f32x4.mul(f32x4.add(f32x4.splat(x), lane), vscale), voff);
    let ix = f32x4.splat(0.0), iy = f32x4.splat(0.0);
    let iter = i32x4.splat(0), active = i32x4.splat(-1);

    // escape loop, masked: a lane drops out when |z|² > 256 or it has done `limit` updates
    let k = 0;
    while (k < limit + 2) {
      let ixSq = f32x4.mul(ix, ix), iySq = f32x4.mul(iy, iy);
      active = v128.and(active, f32x4.le(f32x4.add(ixSq, iySq), bail));
      if (v128.anyTrue(active)) {
        iy = v128.bitselect(f32x4.add(f32x4.mul(f32x4.mul(two, ix), iy), ci), iy, active);
        ix = v128.bitselect(f32x4.add(f32x4.sub(ixSq, iySq), cr), ix, active);
        active = v128.and(active, v128.not(i32x4.ge(iter, limV)));
        iter = i32x4.sub(iter, active);
        k++;
      } else { k = limit + 2; }
    }

    // smooth colour, 4-wide: frac = log2(½·log(sqd)); val = (iter+1-frac)/limit clamped;
    // col = (NC-1)·val for escaped lanes (sqd > 256), else NC-1.
    let sqd = f32x4.add(f32x4.mul(ix, ix), f32x4.mul(iy, iy));
    let frac = f32x4.mul(slog(f32x4.mul(f32x4.splat(0.5), slog(sqd))), f32x4.splat(1.4426950408));
    let val = f32x4.mul(f32x4.sub(f32x4.add(f32x4.convertI32(iter), f32x4.splat(1.0)), frac), invL);
    val = f32x4.max(f32x4.splat(0.0), f32x4.min(f32x4.splat(1.0), val));
    let colF = v128.bitselect(f32x4.mul(ncF, val), ncF, f32x4.gt(sqd, bail));
    mem[stride + x]     = f32x4.lane(colF, 0) | 0;
    mem[stride + x + 1] = f32x4.lane(colF, 1) | 0;
    mem[stride + x + 2] = f32x4.lane(colF, 2) | 0;
    mem[stride + x + 3] = f32x4.lane(colF, 3) | 0;
    x = x + 4;
  }

  // tail (width not a multiple of 4)
  while (x < width) {
    mem[stride + x] = pixel(x * scale - realOffset, imaginary, limit, invLimit);
    x++;
  }
};
