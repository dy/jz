// Mandelbrot — escape-time with continuous (smooth) colouring. A large bail-out radius
// (|z|² > 256) replaces the old fixed post-escape smoothing loop: the fractional iteration
// count log2(½·log|z|²) is already smooth at this radius. One source both ways — the JS toggle
// imports it, the jz toggle runs it compiled, where the escape-time vectorizer lifts the inner
// loop to f64x2 on its own (no hand-written SIMD kernel).
const NUM_COLORS = 2048;
const BAILOUT = 256.0;

let mem;
// View state in a Float64Array: scalar module globals init'd to 0 would be i32-NARROWED in jz, so
// setView's fractional cx/cy/zoom would truncate to 0 and `viewZoom===0` would force the default
// view — pan/zoom silently ignored. A typed array keeps them f64.
let view = new Float64Array(3);   // [cx, cy, zoom]

export let resize = (width, height) => {
  mem = new Uint16Array(width * height);
  return mem;
};
export let dataOffset = () => mem;

export let setView = (cx, cy, zoom) => { view[0] = cx; view[1] = cy; view[2] = zoom; }

export let computeLine = (y, width, height, limit) => {
  let viewCx = view[0], viewCy = view[1], viewZoom = view[2];
  let scale, translateX, translateY;
  if (viewZoom === 0) {
    scale = 10.0 / (3 * width < 4 * height ? 3 * width : 4 * height);
    translateX = width  * (1.0 / 1.6);
    translateY = height * (1.0 / 2.0);
  } else {
    scale = viewZoom;
    translateX = width  * 0.5 - viewCx / scale;
    translateY = height * 0.5 - viewCy / scale;
  }
  let imaginary  = (y - translateY) * scale;
  let realOffset = translateX * scale;
  let stride     = y * width;
  let invLimit   = 1.0 / limit;

  for (let x = 0; x < width; ++x) {
    let real = x * scale - realOffset;

    let ix = 0.0, iy = 0.0, ixSq = 0.0, iySq = 0.0;
    let iteration = 0;
    while ((ixSq = ix * ix) + (iySq = iy * iy) <= BAILOUT) {
      iy = 2.0 * ix * iy + imaginary;
      ix = ixSq - iySq + real;
      if (iteration >= limit) break;
      ++iteration;
    }

    let col = NUM_COLORS - 1;
    let sqd = ix * ix + iy * iy;
    if (sqd > BAILOUT) {                              // escaped → smooth colour
      let frac = Math.log2(0.5 * Math.log(sqd));
      let val = (iteration + 1 - frac) * invLimit;
      if (val < 0.0) val = 0.0;
      if (val > 1.0) val = 1.0;
      col = ((NUM_COLORS - 1) * val) | 0;
    }
    mem[stride + x] = col;
  }
};

// ── Deep zoom (perturbation theory) ─────────────────────────────────────────────────────
// Past ~1e14× float64 can no longer tell a pixel's coordinate from its neighbour's — the
// absolute view centre swamps the tiny per-pixel offset (computeLine's translateX/Y catastrophic-
// cancels). Perturbation theory sidesteps this: the DRIVER (index.html — plain JS, free to use
// BigInt since it isn't compiled here) tracks the view centre at arbitrary precision and iterates
// one high-precision REFERENCE ORBIT Z_0..Z_refLen-1 there, handing it down as plain doubles — a
// reference value's own magnitude stays small (|Z|<16 below bail-out), so double precision holds
// it fine once computed. Each pixel then iterates only the DELTA from the reference:
//   δ_{n+1} = δ_n·(2·Z_n + δ_n) + δc            (expanded: 2·Z_n·δ_n + δ_n² + δc)
// where δc is the pixel's own tiny offset from view centre (a small double, no precision loss)
// and z_n = Z_n + δ_n is the true value. δ_n is kept small by Zhuoran Shen's REBASING trick: once
// |z_n| < |δ_n| the perturbation has grown bigger than the true value it's tracking, so the
// reference has stopped helping this pixel — fold the current total into a fresh δ and restart
// the reference index at 0 (Z_0=0, so δ=z is exactly consistent). Same escape/smooth-colour math
// as computeLine, just carried as (reference + delta) instead of one absolute number. Shallow zoom
// (computeLine above) is untouched — this path only runs once the driver switches to it.
const MAX_REF = 20000;
let refRe = new Float64Array(MAX_REF);
let refIm = new Float64Array(MAX_REF);
let refLen = 0;

// Exposed as getters (not raw bindings) — a jz export is a function; the driver fetches the
// live Float64Array view once (it's backed by the same wasm memory, so direct JS writes into it
// cross the boundary with no per-element call) and re-fetches only if memory could have grown.
export let getRefRe = () => refRe;
export let getRefIm = () => refIm;
export let getMaxRef = () => MAX_REF;
export let setRefLen = (n) => { refLen = n; };

export let computeLineDeep = (y, width, height, limit) => {
  let scale    = view[2];
  let imOffset = (y - height * 0.5) * scale;
  let reOffset = width * 0.5;
  let stride   = y * width;
  let invLimit = 1.0 / limit;

  for (let x = 0; x < width; ++x) {
    let dcRe = (x - reOffset) * scale;
    let dcIm = imOffset;

    let dRe = 0.0, dIm = 0.0;      // δ_n, starts at 0 (z_0 = Z_0 = 0)
    let zRe = 0.0, zIm = 0.0;      // z_n = Z_n + δ_n (the true value), tracked for bail-out/rebase
    let refIdx = 0;                // index of the CURRENT reference sample Z_n
    let iteration = 0;
    let sqd = 0.0;

    while (iteration < limit) {
      let znRe = refRe[refIdx], znIm = refIm[refIdx];
      let sumRe = 2.0 * znRe + dRe, sumIm = 2.0 * znIm + dIm;
      let ndRe = dRe * sumRe - dIm * sumIm + dcRe;
      let ndIm = dRe * sumIm + dIm * sumRe + dcIm;
      dRe = ndRe; dIm = ndIm;
      ++refIdx;
      ++iteration;

      if (refIdx >= refLen) { zRe = dRe; zIm = dIm; refIdx = 0; }   // reference exhausted → rebase
      else { zRe = refRe[refIdx] + dRe; zIm = refIm[refIdx] + dIm; }

      sqd = zRe * zRe + zIm * zIm;
      if (sqd > BAILOUT) break;
      if (sqd < dRe * dRe + dIm * dIm) { dRe = zRe; dIm = zIm; refIdx = 0; }   // glitch → rebase
    }

    let col = NUM_COLORS - 1;
    if (sqd > BAILOUT) {                              // escaped → smooth colour (same formula as computeLine)
      let frac = Math.log2(0.5 * Math.log(sqd));
      let val = (iteration + 1 - frac) * invLimit;
      if (val < 0.0) val = 0.0;
      if (val > 1.0) val = 1.0;
      col = ((NUM_COLORS - 1) * val) | 0;
    }
    mem[stride + x] = col;
  }
};
