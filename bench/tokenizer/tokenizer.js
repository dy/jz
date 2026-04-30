import { medianUs, mix, printResult } from '../_lib/benchlib.js'

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

const scan = (src) => {
  let h = 0x811c9dc5 | 0
  let number = 0
  let inNumber = 0
  let inIdent = 0
  let tokens = 0
  for (let i = 0; i < src.length; i++) {
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
  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) cs = scan(src)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    cs = scan(src)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, src.length, 5, N_RUNS)
}
