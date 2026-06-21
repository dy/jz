// qoi.js — QOI ("Quite OK Image") lossless encoder + decoder round-trip, the
// canonical image codec / compression kernel (qoiformat.org). Per pixel the encoder
// picks the cheapest of six ops — run-length, a 64-entry rolling colour index, a
// small RGB delta, a luma delta, or a literal RGB/RGBA — against the previous pixel.
//
// Unlike a box blur or a Sobel gather, QOI is strictly LOOP-CARRIED: each pixel
// depends on the previous one, the running index, and the run counter, so NO target
// (native, AS, jz) can vectorize it — the race is pure scalar-codegen quality, which
// is jz's home turf. All math is integer byte twiddling (signed-8-bit wraparound via
// `(x << 24) >> 24`), so the encoded stream is bit-identical across every engine and
// native target. The decoder round-trips back to the source and the match is folded
// into the checksum, so a codec bug changes the result.
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, Uint8Array, no class/async/regex.

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const NPIX = 256 * 256       // RGBA pixels
const IMG_LEN = NPIX * 4
const CAP = NPIX * 5 + 64     // worst-case QOI output (all RGBA literals) + headroom
const N_ITERS = 10            // encode+decode passes per kernel run
const N_RUNS = 21
const N_WARMUP = 5

// Deterministic image with structure so all six QOI ops fire: flat runs, small
// deltas (diff/luma), fresh colours (rgb/index), and alpha changes (rgba).
const mkImage = (img) => {
  let x = 0x12345678 | 0
  let r = 128, g = 128, b = 128, a = 255
  for (let p = 0; p < NPIX; p++) {
    x = (Math.imul(x, 1103515245) + 12345) | 0
    const roll = (x >>> 28) & 7
    if (roll < 3) {
      // keep previous pixel → run-length
    } else if (roll < 6) {
      r = (r + (((x >>> 4) & 3) - 1)) & 255   // small delta → diff / luma
      g = (g + (((x >>> 6) & 3) - 1)) & 255
      b = (b + (((x >>> 8) & 3) - 1)) & 255
    } else if (roll === 6) {
      r = (x >>> 10) & 255; g = (x >>> 16) & 255; b = (x >>> 20) & 255   // fresh colour
    } else {
      a = (x >>> 12) & 255   // alpha change → rgba
    }
    const o = p << 2
    img[o] = r; img[o + 1] = g; img[o + 2] = b; img[o + 3] = a
  }
}

const encode = (img, npix, ir, ig, ib, ia, out) => {
  for (let i = 0; i < 64; i++) { ir[i] = 0; ig[i] = 0; ib[i] = 0; ia[i] = 0 }
  let pr = 0, pg = 0, pb = 0, pa = 255
  let run = 0
  let op = 0
  for (let p = 0; p < npix; p++) {
    const o = p << 2
    const r = img[o], g = img[o + 1], b = img[o + 2], a = img[o + 3]
    if (r === pr && g === pg && b === pb && a === pa) {
      run++
      if (run === 62 || p === npix - 1) { out[op++] = 0xc0 | (run - 1); run = 0 }
    } else {
      if (run > 0) { out[op++] = 0xc0 | (run - 1); run = 0 }
      const h = (r * 3 + g * 5 + b * 7 + a * 11) & 63
      if (ir[h] === r && ig[h] === g && ib[h] === b && ia[h] === a) {
        out[op++] = h   // QOI_OP_INDEX (0x00 | h)
      } else {
        ir[h] = r; ig[h] = g; ib[h] = b; ia[h] = a
        if (a === pa) {
          const vr = ((r - pr) << 24) >> 24   // signed-8-bit wraparound
          const vg = ((g - pg) << 24) >> 24
          const vb = ((b - pb) << 24) >> 24
          const vgr = vr - vg
          const vgb = vb - vg
          if (vr >= -2 && vr <= 1 && vg >= -2 && vg <= 1 && vb >= -2 && vb <= 1) {
            out[op++] = 0x40 | ((vr + 2) << 4) | ((vg + 2) << 2) | (vb + 2)
          } else if (vgr >= -8 && vgr <= 7 && vg >= -32 && vg <= 31 && vgb >= -8 && vgb <= 7) {
            out[op++] = 0x80 | (vg + 32)
            out[op++] = ((vgr + 8) << 4) | (vgb + 8)
          } else {
            out[op++] = 0xfe; out[op++] = r; out[op++] = g; out[op++] = b
          }
        } else {
          out[op++] = 0xff; out[op++] = r; out[op++] = g; out[op++] = b; out[op++] = a
        }
      }
    }
    pr = r; pg = g; pb = b; pa = a
  }
  return op
}

const decode = (inp, clen, npix, ir, ig, ib, ia, out) => {
  for (let i = 0; i < 64; i++) { ir[i] = 0; ig[i] = 0; ib[i] = 0; ia[i] = 0 }
  let pr = 0, pg = 0, pb = 0, pa = 255
  let run = 0
  let ip = 0
  for (let p = 0; p < npix; p++) {
    if (run > 0) {
      run--
    } else if (ip < clen) {
      const b0 = inp[ip++]
      if (b0 === 0xfe) { pr = inp[ip++]; pg = inp[ip++]; pb = inp[ip++] }
      else if (b0 === 0xff) { pr = inp[ip++]; pg = inp[ip++]; pb = inp[ip++]; pa = inp[ip++] }
      else if ((b0 & 0xc0) === 0x00) { pr = ir[b0]; pg = ig[b0]; pb = ib[b0]; pa = ia[b0] }
      else if ((b0 & 0xc0) === 0x40) {
        pr = (pr + ((b0 >> 4) & 3) - 2) & 255
        pg = (pg + ((b0 >> 2) & 3) - 2) & 255
        pb = (pb + (b0 & 3) - 2) & 255
      } else if ((b0 & 0xc0) === 0x80) {
        const b1 = inp[ip++]
        const vg = (b0 & 63) - 32
        pr = (pr + vg + ((b1 >> 4) & 15) - 8) & 255
        pg = (pg + vg) & 255
        pb = (pb + vg + (b1 & 15) - 8) & 255
      } else {
        run = b0 & 63
      }
      const h = (pr * 3 + pg * 5 + pb * 7 + pa * 11) & 63
      ir[h] = pr; ig[h] = pg; ib[h] = pb; ia[h] = pa
    }
    const o = p << 2
    out[o] = pr; out[o + 1] = pg; out[o + 2] = pb; out[o + 3] = pa
  }
  return ip
}

const runKernel = (img, ir, ig, ib, ia, comp, dec) => {
  let h = 0
  for (let it = 0; it < N_ITERS; it++) {
    const clen = encode(img, NPIX, ir, ig, ib, ia, comp)
    decode(comp, clen, NPIX, ir, ig, ib, ia, dec)
    let ok = 1
    for (let i = 0; i < IMG_LEN; i++) if (dec[i] !== img[i]) ok = 0
    h = mix(h, clen)
    for (let i = 0; i < clen; i++) h = mix(h, comp[i])
    h = mix(h, ok)
    const j = (it % NPIX) << 2
    img[j] = (img[j] + 1) & 255   // perturb so the codec can't be hoisted out of the loop
  }
  return h >>> 0
}

export let main = () => {
  const img = new Uint8Array(IMG_LEN)
  const ir = new Uint8Array(64), ig = new Uint8Array(64), ib = new Uint8Array(64), ia = new Uint8Array(64)
  const comp = new Uint8Array(CAP)
  const dec = new Uint8Array(IMG_LEN)
  mkImage(img)
  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(img, ir, ig, ib, ia, comp, dec)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    cs = runKernel(img, ir, ig, ib, ia, comp, dec)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, NPIX * N_ITERS, 1, N_RUNS)
}
