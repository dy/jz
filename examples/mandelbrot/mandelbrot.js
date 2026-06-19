// Mandelbrot — escape-time with continuous (smooth) colouring. A large bail-out radius
// (|z|² > 256) replaces the old fixed post-escape smoothing loop: the fractional
// iteration count log2(½·log|z|²) is already smooth at this radius, and |z|² stays well
// inside f32 range — which lets the SIMD sibling (mandelbrot.simd.js) colour 4 lanes at
// once without overflow. Same source runs as the V8 baseline and compiles to wasm.
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
