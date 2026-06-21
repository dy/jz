// qoi.as.ts — AssemblyScript translation of bench/qoi/qoi.js.
//
// QOI ("Quite OK Image") lossless encoder + decoder round-trip.
// Pure scalar byte twiddling — checksum is bit-identical to V8 and every native target.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const NPIX: i32 = 256 * 256
const IMG_LEN: i32 = NPIX * 4
const CAP: i32 = NPIX * 5 + 64
const N_ITERS: i32 = 10
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function mkImage(img: Uint8Array): void {
  let x: i32 = 0x12345678
  let r: i32 = 128, g: i32 = 128, b: i32 = 128, a: i32 = 255
  for (let p = 0; p < NPIX; p++) {
    x = x * 1103515245 + 12345
    const ux: u32 = <u32>x
    const roll: i32 = <i32>((ux >>> 28) & 7)
    if (roll < 3) {
      // keep previous pixel - run-length
    } else if (roll < 6) {
      r = (r + (<i32>((ux >>> 4) & 3) - 1)) & 255
      g = (g + (<i32>((ux >>> 6) & 3) - 1)) & 255
      b = (b + (<i32>((ux >>> 8) & 3) - 1)) & 255
    } else if (roll == 6) {
      r = <i32>((ux >>> 10) & 255)
      g = <i32>((ux >>> 16) & 255)
      b = <i32>((ux >>> 20) & 255)
    } else {
      a = <i32>((ux >>> 12) & 255)
    }
    const o: i32 = p << 2
    unchecked(img[o] = <u8>r)
    unchecked(img[o + 1] = <u8>g)
    unchecked(img[o + 2] = <u8>b)
    unchecked(img[o + 3] = <u8>a)
  }
}

function encode(img: Uint8Array, ir: Uint8Array, ig: Uint8Array, ib: Uint8Array, ia: Uint8Array, out: Uint8Array): i32 {
  for (let i = 0; i < 64; i++) { unchecked(ir[i] = 0); unchecked(ig[i] = 0); unchecked(ib[i] = 0); unchecked(ia[i] = 0) }
  let pr: i32 = 0, pg: i32 = 0, pb: i32 = 0, pa: i32 = 255
  let run: i32 = 0
  let op: i32 = 0
  for (let p = 0; p < NPIX; p++) {
    const o: i32 = p << 2
    const r: i32 = unchecked(img[o])
    const g: i32 = unchecked(img[o + 1])
    const b: i32 = unchecked(img[o + 2])
    const a: i32 = unchecked(img[o + 3])
    if (r == pr && g == pg && b == pb && a == pa) {
      run++
      if (run == 62 || p == NPIX - 1) {
        unchecked(out[op++] = <u8>(0xc0 | (run - 1)))
        run = 0
      }
    } else {
      if (run > 0) { unchecked(out[op++] = <u8>(0xc0 | (run - 1))); run = 0 }
      const h: i32 = (r * 3 + g * 5 + b * 7 + a * 11) & 63
      if (unchecked(ir[h]) == r && unchecked(ig[h]) == g && unchecked(ib[h]) == b && unchecked(ia[h]) == a) {
        unchecked(out[op++] = <u8>h)
      } else {
        unchecked(ir[h] = <u8>r); unchecked(ig[h] = <u8>g); unchecked(ib[h] = <u8>b); unchecked(ia[h] = <u8>a)
        if (a == pa) {
          const vr: i32 = ((r - pr) << 24) >> 24
          const vg_: i32 = ((g - pg) << 24) >> 24
          const vb: i32 = ((b - pb) << 24) >> 24
          const vgr: i32 = vr - vg_
          const vgb: i32 = vb - vg_
          if (vr >= -2 && vr <= 1 && vg_ >= -2 && vg_ <= 1 && vb >= -2 && vb <= 1) {
            unchecked(out[op++] = <u8>(0x40 | ((vr + 2) << 4) | ((vg_ + 2) << 2) | (vb + 2)))
          } else if (vgr >= -8 && vgr <= 7 && vg_ >= -32 && vg_ <= 31 && vgb >= -8 && vgb <= 7) {
            unchecked(out[op++] = <u8>(0x80 | (vg_ + 32)))
            unchecked(out[op++] = <u8>(((vgr + 8) << 4) | (vgb + 8)))
          } else {
            unchecked(out[op++] = 0xfe)
            unchecked(out[op++] = <u8>r)
            unchecked(out[op++] = <u8>g)
            unchecked(out[op++] = <u8>b)
          }
        } else {
          unchecked(out[op++] = 0xff)
          unchecked(out[op++] = <u8>r)
          unchecked(out[op++] = <u8>g)
          unchecked(out[op++] = <u8>b)
          unchecked(out[op++] = <u8>a)
        }
      }
    }
    pr = r; pg = g; pb = b; pa = a
  }
  return op
}

function decode(inp: Uint8Array, clen: i32, ir: Uint8Array, ig: Uint8Array, ib: Uint8Array, ia: Uint8Array, out: Uint8Array): void {
  for (let i = 0; i < 64; i++) { unchecked(ir[i] = 0); unchecked(ig[i] = 0); unchecked(ib[i] = 0); unchecked(ia[i] = 0) }
  let pr: i32 = 0, pg: i32 = 0, pb: i32 = 0, pa: i32 = 255
  let run: i32 = 0
  let ip: i32 = 0
  for (let p = 0; p < NPIX; p++) {
    if (run > 0) {
      run--
    } else if (ip < clen) {
      const b0: i32 = unchecked(inp[ip++])
      if (b0 == 0xfe) {
        pr = unchecked(inp[ip++]); pg = unchecked(inp[ip++]); pb = unchecked(inp[ip++])
      } else if (b0 == 0xff) {
        pr = unchecked(inp[ip++]); pg = unchecked(inp[ip++]); pb = unchecked(inp[ip++]); pa = unchecked(inp[ip++])
      } else if ((b0 & 0xc0) == 0x00) {
        pr = unchecked(ir[b0]); pg = unchecked(ig[b0]); pb = unchecked(ib[b0]); pa = unchecked(ia[b0])
      } else if ((b0 & 0xc0) == 0x40) {
        pr = (pr + ((b0 >> 4) & 3) - 2) & 255
        pg = (pg + ((b0 >> 2) & 3) - 2) & 255
        pb = (pb + (b0 & 3) - 2) & 255
      } else if ((b0 & 0xc0) == 0x80) {
        const b1: i32 = unchecked(inp[ip++])
        const vg: i32 = (b0 & 63) - 32
        pr = (pr + vg + ((b1 >> 4) & 15) - 8) & 255
        pg = (pg + vg) & 255
        pb = (pb + vg + (b1 & 15) - 8) & 255
      } else {
        run = b0 & 63
      }
      const h: i32 = (pr * 3 + pg * 5 + pb * 7 + pa * 11) & 63
      unchecked(ir[h] = <u8>pr); unchecked(ig[h] = <u8>pg); unchecked(ib[h] = <u8>pb); unchecked(ia[h] = <u8>pa)
    }
    const o: i32 = p << 2
    unchecked(out[o] = <u8>pr); unchecked(out[o + 1] = <u8>pg); unchecked(out[o + 2] = <u8>pb); unchecked(out[o + 3] = <u8>pa)
  }
}

function mix(h: u32, x: u32): u32 {
  return (h ^ x) * <u32>0x01000193
}

function runKernel(img: Uint8Array, ir: Uint8Array, ig: Uint8Array, ib: Uint8Array, ia: Uint8Array, comp: Uint8Array, dec: Uint8Array): u32 {
  let h: u32 = 0
  for (let it = 0; it < N_ITERS; it++) {
    const clen: i32 = encode(img, ir, ig, ib, ia, comp)
    decode(comp, clen, ir, ig, ib, ia, dec)
    let ok: u32 = 1
    for (let i = 0; i < IMG_LEN; i++) if (unchecked(dec[i]) != unchecked(img[i])) ok = 0
    h = mix(h, <u32>clen)
    for (let i = 0; i < clen; i++) h = mix(h, <u32>unchecked(comp[i]))
    h = mix(h, ok)
    const j: i32 = (it % NPIX) << 2
    unchecked(img[j] = <u8>((unchecked(img[j]) + 1) & 255))
  }
  return h
}

export function main(): void {
  const img = new Uint8Array(IMG_LEN)
  const ir = new Uint8Array(64)
  const ig = new Uint8Array(64)
  const ib = new Uint8Array(64)
  const ia = new Uint8Array(64)
  const comp = new Uint8Array(CAP)
  const dec = new Uint8Array(IMG_LEN)
  mkImage(img)
  let cs: u32 = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(img, ir, ig, ib, ia, comp, dec)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    cs = runKernel(img, ir, ig, ib, ia, comp, dec)
    unchecked(samples[i] = perfNow() - t0)
  }

  const sorted = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) unchecked(sorted[i] = samples[i])
  for (let i = 1; i < N_RUNS; i++) {
    const v = unchecked(sorted[i])
    let j = i - 1
    while (j >= 0 && unchecked(sorted[j]) > v) {
      unchecked(sorted[j + 1] = sorted[j])
      j--
    }
    unchecked(sorted[j + 1] = v)
  }
  const medianMs = unchecked(sorted[(N_RUNS - 1) >> 1])
  logLine(<i32>(medianMs * 1000.0), cs, NPIX * N_ITERS, 1, N_RUNS)
}
