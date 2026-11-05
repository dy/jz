// decode-dsd stage 1 (buildStage1's tables, a ring of input bytes, one table read per tap).
// D2: the trip count C comes from a destructured record: the induction stays f64. Control: ring-literal.js.
// D1 control for ring-dyn.js.
const N = 352800
let own = new Uint8Array(N)
export let init = () => { let s = 1; for (let i = 0; i < N; i++) { s = (s * 1103515245 + 12345) >>> 0; own[i] = s >>> 24 } }
function plan(taps) {
  const HTAPS = taps / 2, C = Math.ceil(HTAPS / 8)
  const tables = Array.from({ length: C }, () => new Float32Array(256))
  const acc = new Float64Array(C)
  for (let v = 0; v < 256; v++) {
    acc.fill(0)
    for (let bit = 0; bit < 8; bit++) { const sign = ((v >> (7 - bit)) & 1) * 2 - 1; for (let t = 0; t < C; t++) acc[t] += sign * Math.sin(t * 8 + bit) }
    for (let t = 0; t < C; t++) tables[C - 1 - t][v] = acc[t]
  }
  return { C, tables }
}
function ring(st) {
  const { C, tables } = st
  let size = 4; while (size < C * 2) size <<= 1
  const MASK = size - 1, buf = new Uint8Array(size)
  let pos = 0
  return { push(byte) {
    buf[pos] = byte
    let sum = 0
    for (let i = 0; i < C; i++) {
      const a = buf[(pos - i) & MASK], b = buf[(pos - (C * 2 - 1) + i) & MASK]
      sum += tables[i][a] + tables[i][b]
    }
    pos = (pos + 1) & MASK
    return sum
  } }
}
const drive = (src) => { const p = ring(plan(192)); let s = 0; for (let i = 0; i < src.length; i++) s += p.push(src[i]); return s }
export let run = () => drive(own)

