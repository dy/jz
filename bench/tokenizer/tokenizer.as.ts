// tokenizer.as.ts — AssemblyScript translation of bench/tokenizer/tokenizer.js.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N_REPEAT: i32 = 512
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

const BASE_LEN: i32 = 79  // length of one BASE line

function mix(h: u32, x: i32): u32 {
  return (h ^ <u32>(x | 0)) * <u32>0x01000193
}

function srcLen(): i32 {
  return BASE_LEN * N_REPEAT
}

function scan(src: Uint8Array, len: i32): u32 {
  let h: u32 = 0x811c9dc5
  let number: i32 = 0
  let inNumber: bool = false
  let inIdent: bool = false
  let tokens: i32 = 0
  for (let i = 0; i < len; i++) {
    const c = unchecked(src[i])
    if (c >= 48 && c <= 57) {
      number = ((number * 10) + (c - 48)) | 0
      inNumber = true
    } else {
      if (inNumber) { h = mix(h, number); tokens++; number = 0; inNumber = false }
      const isAlpha = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95
      if (isAlpha) {
        if (!inIdent) { h = mix(h, <i32>c); tokens++ }
        inIdent = true
      } else {
        if (c > 32) { h = mix(h, <i32>c); tokens++ }
        inIdent = false
      }
    }
  }
  if (inNumber) { h = mix(h, number); tokens++ }
  h = mix(h, tokens)
  return h
}

function buildSrc(out: Uint8Array): void {
  const base: string = "let alpha_12 = beta + 12345; if (alpha_12 >= 99) { total = total + alpha_12; }\n"
  let pos: i32 = 0
  for (let r = 0; r < N_REPEAT; r++) {
    for (let i = 0; i < BASE_LEN; i++) {
      unchecked(out[pos++] = <u8>base.charCodeAt(i))
    }
  }
}

export function main(): void {
  const len = srcLen()
  const src = new Uint8Array(len)
  buildSrc(src)

  // Each run scans a slightly shorter prefix so `scan` gets a different input
  // every call — it can't be hoisted out of the timing loop (matches the .js).
  let cs: u32 = 0
  for (let i = 0; i < N_WARMUP; i++) cs = scan(src, len - (i & 7))

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    cs = scan(src, len - (i & 7))
    unchecked(samples[i] = perfNow() - t0)
  }

  // sort for median
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
  logLine(<i32>(medianMs * 1000.0), cs, len, 5, N_RUNS)
}
