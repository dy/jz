// base64.js — Base64 encode + decode round-trip over a byte buffer, the canonical
// codec / serialization kernel. Table-driven 3-byte→4-char packing and its inverse;
// pure-integer shifts and masks, so the encoded bytes are bit-identical across every
// engine and native target. The decode pass round-trips back to the source and the
// match is folded into the checksum, so a codec bug changes the result.
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, Uint8Array, no class/async/regex. N is a multiple
// of 3 so there is no padding to special-case.

import { medianUs, mix, checksumU8, printResult } from '../_lib/benchlib.js'

const N = 24576              // input bytes (3 * 8192 → clean 3→4 packing, no padding)
const ENC_LEN = (N / 3) * 4  // encoded length
const N_ITERS = 64           // encode+decode passes per kernel run
const N_RUNS = 21
const N_WARMUP = 5

// Standard Base64 alphabet (A-Z a-z 0-9 + /) as char codes.
const buildEnc = (enc) => {
  let i = 0
  for (let c = 65; c <= 90; c++) enc[i++] = c   // A-Z
  for (let c = 97; c <= 122; c++) enc[i++] = c  // a-z
  for (let c = 48; c <= 57; c++) enc[i++] = c   // 0-9
  enc[i++] = 43                                  // +
  enc[i++] = 47                                  // /
}

const buildDec = (enc, dec) => {
  for (let i = 0; i < 256; i++) dec[i] = 0
  for (let i = 0; i < 64; i++) dec[enc[i]] = i
}

const initBuf = (buf) => {
  let x = 0x12345678 | 0
  for (let i = 0; i < N; i++) {
    x = (Math.imul(x, 1103515245) + 12345) | 0
    buf[i] = (x >>> 16) & 0xff
  }
}

const encode = (src, n, enc, out) => {
  let op = 0
  for (let i = 0; i + 3 <= n; i += 3) {
    const a = src[i], b = src[i + 1], c = src[i + 2]
    out[op] = enc[a >>> 2]
    out[op + 1] = enc[((a & 3) << 4) | (b >>> 4)]
    out[op + 2] = enc[((b & 15) << 2) | (c >>> 6)]
    out[op + 3] = enc[c & 63]
    op += 4
  }
  return op
}

const decode = (src, n, dec, out) => {
  let op = 0
  for (let i = 0; i + 4 <= n; i += 4) {
    const a = dec[src[i]], b = dec[src[i + 1]], c = dec[src[i + 2]], d = dec[src[i + 3]]
    out[op] = ((a << 2) | (b >>> 4)) & 0xff
    out[op + 1] = (((b & 15) << 4) | (c >>> 2)) & 0xff
    out[op + 2] = (((c & 3) << 6) | d) & 0xff
    op += 3
  }
  return op
}

const runKernel = (src, enc, dec, b64, back) => {
  let h = 0
  for (let it = 0; it < N_ITERS; it++) {
    encode(src, N, enc, b64)
    decode(b64, ENC_LEN, dec, back)
    let ok = 1
    for (let i = 0; i < N; i++) if (back[i] !== src[i]) ok = 0
    h = mix(mix(h, checksumU8(b64)), ok)
    const j = it % N
    src[j] = (src[j] + 1) & 0xff   // perturb so the codec can't be hoisted out of the loop
  }
  return h >>> 0
}

export let main = () => {
  const src = new Uint8Array(N)
  const enc = new Uint8Array(64)
  const dec = new Uint8Array(256)
  const b64 = new Uint8Array(ENC_LEN)
  const back = new Uint8Array(N)
  buildEnc(enc)
  buildDec(enc, dec)
  initBuf(src)
  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(src, enc, dec, b64, back)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    cs = runKernel(src, enc, dec, b64, back)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, N * N_ITERS, 1, N_RUNS)
}
