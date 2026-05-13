import { medianUs, mix, printResult } from '../_lib/benchlib.js'

// Branch-heavy lexer: classify each character — digit / identifier /
// punctuation / whitespace — accumulate integer tokens, FNV-1a mix the token
// stream. Each run scans a slightly shorter prefix of the source (`len - (i &
// 7)`), so `scan` gets a genuinely different input every call — it can't be
// hoisted out of the timing loop or memoized on a constant argument. The work
// per run varies by ≤ 7 chars out of ~40 k, i.e. timing noise; the printed
// checksum is the last run's, deterministic across engines.

const BASE = 'let alpha_12 = beta + 12345; if (alpha_12 >= 99) { total = total + alpha_12; }\n'
const N_REPEAT = 512
const N_RUNS = 21
const N_WARMUP = 5

const makeSource = () => {
  let s = ''
  for (let i = 0; i < N_REPEAT; i++) s = s + BASE
  return s
}

const isAlpha = (c) =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95

const scan = (src, len) => {
  let h = 0x811c9dc5 | 0
  let number = 0
  let inNumber = 0
  let inIdent = 0
  let tokens = 0
  for (let i = 0; i < len; i++) {
    const c = src.charCodeAt(i)
    if (c >= 48 && c <= 57) {
      number = ((number * 10) + (c - 48)) | 0
      inNumber = 1
    } else {
      if (inNumber) { h = mix(h, number); tokens++; number = 0; inNumber = 0 }
      if (isAlpha(c)) {
        if (!inIdent) { h = mix(h, c); tokens++ }
        inIdent = 1
      } else {
        if (c > 32) { h = mix(h, c); tokens++ }
        inIdent = 0
      }
    }
  }
  if (inNumber) { h = mix(h, number); tokens++ }
  h = mix(h, tokens)
  return h >>> 0
}

export let main = () => {
  const src = makeSource()
  const n = src.length
  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) cs = scan(src, n - (i & 7))

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    cs = scan(src, n - (i & 7))
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, n, 5, N_RUNS)
}
