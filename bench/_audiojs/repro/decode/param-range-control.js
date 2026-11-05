// param-range.js with numactive, denshift masked to their bit fields as decodeElements reads them (0..31, 0..15): the A1 control.
function signOf(i) { return (((-i) >>> 31) | (i >> 31)) }

function unpcBlock(pc1, out, num, coefs, numactive, chanbits, denshift) {
  let chanshift = 32 - chanbits, denhalf = 1 << (denshift - 1)
  out[0] = pc1[0]
  if (numactive === 0) { for (let i = 1; i < num; i++) out[i] = pc1[i]; return }
  if (numactive === 31) {
    let prev = out[0]
    for (let j = 1; j < num; j++) { let del = pc1[j] + prev; prev = (del << chanshift) >> chanshift; out[j] = prev }
    return
  }
  for (let j = 1; j <= numactive; j++) { let del = pc1[j] + out[j - 1]; out[j] = (del << chanshift) >> chanshift }
  let lim = numactive + 1
  for (let j = lim; j < num; j++) {
    let sum1 = 0, pb = j - 1, top = out[j - lim]
    for (let kk = 0; kk < numactive; kk++) sum1 = (sum1 + Math.imul(coefs[kk], out[pb - kk] - top)) | 0
    let del = pc1[j], del0 = del, sg = signOf(del)
    del = (del + top + ((sum1 + denhalf) >> denshift)) | 0
    out[j] = (del << chanshift) >> chanshift
    if (sg > 0) {
      for (let kk = numactive - 1; kk >= 0; kk--) {
        let dd = top - out[pb - kk], sgn = signOf(dd)
        coefs[kk] -= sgn
        del0 -= Math.imul(numactive - kk, (Math.imul(sgn, dd) >> denshift))
        if (del0 <= 0) break
      }
    } else if (sg < 0) {
      for (let kk = numactive - 1; kk >= 0; kk--) {
        let dd = top - out[pb - kk], sgn = signOf(dd)
        coefs[kk] += sgn
        del0 -= Math.imul(numactive - kk, (Math.imul(-sgn, dd) >> denshift))
        if (del0 >= 0) break
      }
    }
  }
}
const N = 4096, F = 200
let pc1 = new Int32Array(N), out = new Int32Array(N), tmp = new Int32Array(N), coefs = new Int16Array(32), cfg = new Int32Array([4096, 8, 9])
export let init = () => { let s = 7; for (let i = 0; i < N; i++) { s = (s * 1103515245 + 12345) >>> 0; pc1[i] = (s >>> 20) - 2048 } }
export let run = () => {
  let num = cfg[0], na = cfg[1] & 0x1f, ds = cfg[2] & 0xf, h = 0
  for (let f = 0; f < F; f++) {
    for (let k = 0; k < 8; k++) coefs[k] = 100 - k * 9
    unpcBlock(pc1, tmp, num, null, 31, 16, 0)
    unpcBlock(pc1, out, num, coefs, na, 16, ds)
    h = (h + out[N - 1] + out[N >> 1] + tmp[7]) | 0
  }
  return h
}
