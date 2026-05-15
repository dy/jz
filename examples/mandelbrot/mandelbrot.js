const NUM_COLORS = 2048;

let mem; 
export let resize = (width, height) => {
    mem = new Uint16Array(width * height);
    return mem;
}
export let dataOffset = () => mem;

export let computeLine = (y, width, height, limit) => {
  let translateX = width  * (1.0 / 1.6);
  let translateY = height * (1.0 / 2.0);
  let scale      = 10.0 / (3 * width < 4 * height ? 3 * width : 4 * height);
  let imaginary  = (y - translateY) * scale;
  let realOffset = translateX * scale;
  let stride     = y * width;
  let invLimit   = 1.0 / limit;

  let minIterations = 8 < limit ? 8 : limit;

  for (let x = 0; x < width; ++x) {
    let real = x * scale - realOffset;

    let ix = 0.0, iy = 0.0, ixSq = 0.0, iySq = 0.0;
    let iteration = 0;
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

    let col = NUM_COLORS - 1;
    let sqd = ix * ix + iy * iy;
    if (sqd > 1.0) {
      let frac = Math.log2(0.5 * Math.log(sqd));
      let val = (iteration + 1 - frac) * invLimit;
      if (val < 0.0) val = 0.0;
      if (val > 1.0) val = 1.0;
      col = ((NUM_COLORS - 1) * val) | 0;
    }
    mem[stride + x] = col;
  }
}
