// blur.as.ts — AssemblyScript translation of bench/blur/blur.js.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const W: i32 = 512
const H: i32 = 512
const R: i32 = 4
const WIN: i32 = 2 * R + 1
const N: i32 = W * H * 4
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function mkImage(out: Uint8Array, n: i32): void {
  let s: u32 = 0x1234abcd
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    unchecked(out[i] = <u8>(s & 255))
  }
}

function hblur(src: Uint8Array, dst: Uint8Array, w: i32, h: i32, r: i32): void {
  const win = 2 * r + 1
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let sr = 0, sg = 0, sb = 0, sa = 0
      for (let k = -r; k <= r; k++) {
        let xi = x + k
        if (xi < 0) xi = 0
        else if (xi >= w) xi = w - 1
        const p = (row + xi) << 2
        sr += unchecked(src[p]); sg += unchecked(src[p + 1]); sb += unchecked(src[p + 2]); sa += unchecked(src[p + 3])
      }
      const o = (row + x) << 2
      unchecked(dst[o] = <u8>(sr / win))
      unchecked(dst[o + 1] = <u8>(sg / win))
      unchecked(dst[o + 2] = <u8>(sb / win))
      unchecked(dst[o + 3] = <u8>(sa / win))
    }
  }
}

function vblur(src: Uint8Array, dst: Uint8Array, w: i32, h: i32, r: i32): void {
  const win = 2 * r + 1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sr = 0, sg = 0, sb = 0, sa = 0
      for (let k = -r; k <= r; k++) {
        let yi = y + k
        if (yi < 0) yi = 0
        else if (yi >= h) yi = h - 1
        const p = (yi * w + x) << 2
        sr += unchecked(src[p]); sg += unchecked(src[p + 1]); sb += unchecked(src[p + 2]); sa += unchecked(src[p + 3])
      }
      const o = (y * w + x) << 2
      unchecked(dst[o] = <u8>(sr / win))
      unchecked(dst[o + 1] = <u8>(sg / win))
      unchecked(dst[o + 2] = <u8>(sb / win))
      unchecked(dst[o + 3] = <u8>(sa / win))
    }
  }
}

function checksumU8(out: Uint8Array): u32 {
  let h: u32 = 0x811c9dc5
  const n = out.length
  for (let i = 0; i < n; i++) h = (h ^ <u32>unchecked(out[i])) * 0x01000193
  return h
}

export function main(): void {
  const img = new Uint8Array(N)
  const tmp = new Uint8Array(N)
  const out = new Uint8Array(N)
  mkImage(img, N)
  for (let i = 0; i < N_WARMUP; i++) { hblur(img, tmp, W, H, R); vblur(tmp, out, W, H, R) }

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    hblur(img, tmp, W, H, R)
    vblur(tmp, out, W, H, R)
    unchecked(samples[i] = perfNow() - t0)
  }

  const cs = checksumU8(out)
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
  logLine(<i32>(medianMs * 1000.0), cs, W * H, WIN, N_RUNS)
}
