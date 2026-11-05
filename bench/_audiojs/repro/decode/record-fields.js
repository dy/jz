// Class: integer state in fields of a record passed to a per-sample function (ch.k0, ch.sum0, ...).
// Fields are f64 slots: each update loads f64, truncates (with NaN guard), computes, converts back, stores;
// a table read indexed by a field gets a bounds test whose miss is undefined, so the compare runs in f64.
// TTA: decodeValue(br, chans[c], predShift) adapts k0/k1/sum0/sum1 and the predictor per sample.
// Control: the same adaptation with the state in an Int32Array.
const SHIFT1 = new Uint32Array(41)
for (let i = 0; i < 32; i++) SHIFT1[i] = (1 << i) >>> 0
for (let i = 32; i < 40; i++) SHIFT1[i] = 0x80000000
SHIFT1[40] = 0xFFFFFFFF
const SHIFT16 = SHIFT1.subarray(4)
const V = new Uint32Array(1 << 20)
for (let i = 0, x = 1; i < V.length; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; V[i] = (x >>> 16) & 0x3ff }
const make = () => ({ k0: 10, sum0: SHIFT16[10], predictor: 0 })
function stepObj(ch, value) {
  ch.sum0 = (ch.sum0 + value - (ch.sum0 >>> 4)) >>> 0
  if (ch.k0 > 0 && ch.sum0 < SHIFT16[ch.k0]) ch.k0--
  else if (ch.sum0 > SHIFT16[ch.k0 + 1]) ch.k0++
  let p = ch.predictor
  value = (value + (((p << 5) - p) >> 5)) | 0
  ch.predictor = value
  return value
}
export function fields() { let ch = make(), s = 0; for (let i = 0; i < V.length; i++) s = (s + stepObj(ch, V[i])) | 0; return s + ch.k0 }
// control: K0, SUM0, PRED slots of an Int32Array
function stepArr(st, value) {
  st[1] = ((st[1] >>> 0) + value - ((st[1] >>> 0) >>> 4)) >>> 0
  let sum0 = st[1] >>> 0
  if (st[0] > 0 && sum0 < SHIFT16[st[0]]) st[0]--
  else if (sum0 > SHIFT16[st[0] + 1]) st[0]++
  let p = st[2]
  value = (value + (((p << 5) - p) >> 5)) | 0
  st[2] = value
  return value
}
export function typed() { let st = new Int32Array(3), s = 0; st[0] = 10; st[1] = SHIFT16[10]; for (let i = 0; i < V.length; i++) s = (s + stepArr(st, V[i])) | 0; return s + st[0] }
