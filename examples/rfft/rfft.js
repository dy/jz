// Real FFT — magnitude spectrum via split-radix, in place.
//
// Adapted from the `fourier-transform` package to the jz subset, which is also
// plain JS: no Map cache (one fixed N, precomputed once in init), no Math.clz32
// (bit count via a loop), no destructured Math, no do/while (rewritten as while
// — safe because the initial index is always < N), SQRT constants inlined.
//
//   init(n)     → input buffer (Float64Array N) — host writes time samples here
//   spectrum()  → magnitude buffer (Float64Array N/2) — read after rfft()
//   quefrency() → cepstrum buffer (Float64Array N/2) — read after cepstrum()
//   rfft()      → transform input → magnitude spectrum, in place
//   cepstrum()  → real cepstrum of the log-magnitude (call after rfft())

const SQRT1_2 = 0.7071067811865476;
const TWO_PI = 6.283185307179586;

let N = 0, half = 0, bSi = 0;
let inp;       // time-domain input (length N)
let x;         // working buffer (length N)
let spec;      // magnitude output (length N/2)
let cep;       // real-cepstrum output (length N/2)
let perm;      // bit-reversal permutation (length N)
let tw;        // interleaved twiddles [cc1, ss1, cc3, ss3] per entry
let stageOff;  // per-stage twiddle offset into tw
let stageCnt;  // per-stage twiddle count

export let init = (n) => {
  N = n; half = n >>> 1; bSi = 2.0 / n;
  inp = new Float64Array(n);
  x = new Float64Array(n);
  spec = new Float64Array(half);
  cep = new Float64Array(half);

  // bit count = log2(N)
  let bits = 0, t = n;
  while (t > 1) { t >>= 1; bits++; }

  // bit-reversal permutation table
  perm = new Uint32Array(n);
  let i = 0;
  while (i < n) {
    let rev = 0, v = i, j = 0;
    while (j < bits) { rev = (rev << 1) | (v & 1); v >>= 1; j++; }
    perm[i] = rev;
    i++;
  }

  // count twiddle factors per stage
  stageOff = new Int32Array(bits);
  stageCnt = new Int32Array(bits);
  let total = 0, n2 = 2, nn = half, si = 0;
  while ((nn = nn >>> 1)) {
    n2 = n2 << 1;
    let n8 = n2 >>> 3;
    let count = n8 > 1 ? n8 - 1 : 0;
    stageOff[si] = total;
    stageCnt[si] = count;
    total += count;
    si++;
  }

  // interleaved twiddle table
  tw = new Float64Array(total << 2);
  n2 = 2; nn = half; si = 0;
  while ((nn = nn >>> 1)) {
    n2 = n2 << 1;
    let n8 = n2 >>> 3;
    let e = TWO_PI / n2;
    let off = stageOff[si] << 2;
    let j = 1;
    while (j < n8) {
      let a = j * e;
      let s = Math.sin(a), c = Math.cos(a);
      let idx = off + ((j - 1) << 2);
      tw[idx] = c;
      tw[idx + 1] = s;
      tw[idx + 2] = 4.0 * c * (c * c - 0.75);
      tw[idx + 3] = 4.0 * s * (0.75 - s * s);
      j++;
    }
    si++;
  }

  return inp;
};

export let spectrum = () => spec;
export let quefrency = () => cep;

// Bit-reverse inp → x, then split-radix butterflies in place. After this x holds
// the packed real DFT: x[k] = Re, x[N-k] = Im for k = 1..N/2-1. Shared by rfft()
// and cepstrum() — both transform a real sequence of length N.
let transform = () => {
  // bit-reversal copy: input → working buffer
  let i = 0;
  while (i < N) { x[i] = inp[perm[i]]; i++; }

  // first pass — length-2 butterflies
  let ix = 0, id = 4;
  while (ix < N) {
    let i0 = ix;
    while (i0 < N) {
      let tt = x[i0] - x[i0 + 1];
      x[i0] += x[i0 + 1];
      x[i0 + 1] = tt;
      i0 += id;
    }
    ix = 2 * (id - 1);
    id *= 4;
  }

  // subsequent stages
  let n2 = 2, nn = N >>> 1, si = 0;
  while ((nn = nn >>> 1)) {
    n2 = n2 << 1;
    let n4 = n2 >>> 2;
    let n8 = n2 >>> 3;

    // zero-angle butterflies
    ix = 0;
    id = n2 << 1;
    while (ix < N) {
      if (n4 !== 1) {
        let i0 = ix;
        while (i0 < N) {
          let i1 = i0, i2 = i1 + n4, i3 = i2 + n4, i4 = i3 + n4;
          let t1 = x[i3] + x[i4];
          x[i4] -= x[i3];
          x[i3] = x[i1] - t1;
          x[i1] += t1;
          i1 += n8; i2 += n8; i3 += n8; i4 += n8;
          t1 = x[i3] + x[i4];
          let t2 = x[i3] - x[i4];
          t1 = -t1 * SQRT1_2;
          t2 *= SQRT1_2;
          let st1 = x[i2];
          x[i4] = t1 + st1;
          x[i3] = t1 - st1;
          x[i2] = x[i1] - t2;
          x[i1] += t2;
          i0 += id;
        }
      } else {
        let i0 = ix;
        while (i0 < N) {
          let i1 = i0, i3 = i1 + 2, i4 = i3 + 1;
          let t1 = x[i3] + x[i4];
          x[i4] -= x[i3];
          x[i3] = x[i1] - t1;
          x[i1] += t1;
          i0 += id;
        }
      }
      ix = (id << 1) - n2;
      id = id << 2;
    }

    // twiddle-factor butterflies
    let off = stageOff[si], count = stageCnt[si];
    let j = 0;
    while (j < count) {
      let ti = (off + j) << 2;
      let cc1 = tw[ti], ss1 = tw[ti + 1], cc3 = tw[ti + 2], ss3 = tw[ti + 3];
      ix = 0; id = n2 << 1;
      while (ix < N) {
        let i0 = ix;
        while (i0 < N) {
          let i1 = i0 + j + 1;
          let i2 = i1 + n4;
          let i3 = i2 + n4;
          let i4 = i3 + n4;
          let i5 = i0 + n4 - j - 1;
          let i6 = i5 + n4;
          let i7 = i6 + n4;
          let i8 = i7 + n4;
          let t2 = x[i7] * cc1 - x[i3] * ss1;
          let t1 = x[i7] * ss1 + x[i3] * cc1;
          let t4 = x[i8] * cc3 - x[i4] * ss3;
          let t3 = x[i8] * ss3 + x[i4] * cc3;
          let st1 = t2 - t4;
          t2 += t4;
          t4 = st1;
          x[i8] = t2 + x[i6];
          x[i3] = t2 - x[i6];
          let st2 = t3 - t1;
          t1 += t3;
          t3 = st2;
          x[i4] = t3 + x[i2];
          x[i7] = t3 - x[i2];
          x[i6] = x[i1] - t1;
          x[i1] += t1;
          x[i2] = t4 + x[i5];
          x[i5] -= t4;
          i0 += id;
        }
        ix = (id << 1) - n2;
        id = id << 2;
      }
      j++;
    }
    si++;
  }

};

export let rfft = () => {
  transform();

  // magnitude spectrum
  let k = half;
  while (--k) {
    let rval = x[k], ival = x[N - k];
    spec[k] = bSi * Math.sqrt(rval * rval + ival * ival);
  }
  spec[0] = Math.abs(bSi * x[0]);
};

// Real cepstrum = IDFT of the log-magnitude spectrum. The log-magnitude is real
// and even-symmetric, so its DFT is itself real — we reuse the same transform and
// keep the real part. A peak at quefrency q means the signal repeats every q
// samples (pitch ≈ sampleRate / q), so the cepstrogram traces the melody's pitch.
// Call after rfft() (it consumes spec[]); overwrites inp[] with the log-spectrum.
export let cepstrum = () => {
  // build the symmetric log-magnitude sequence in inp[]
  inp[0] = Math.log(spec[0] + 1e-6);
  let k = 1;
  while (k < half) {
    let lm = Math.log(spec[k] + 1e-6);
    inp[k] = lm;
    inp[N - k] = lm;
    k++;
  }
  inp[half] = Math.log(spec[half - 1] + 1e-6);   // Nyquist bin ≈ last computed bin

  transform();

  // real part / N is the real cepstrum
  let m = 0;
  while (m < half) { cep[m] = x[m] / N; m++; }
};
