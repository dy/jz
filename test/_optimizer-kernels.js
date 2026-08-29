// Shared source fixture for the eq-zero peephole's IR, full-pipeline, and
// native-vs-self-hosted regressions. Five same-scrutinee arms are the minimal
// dense-switch chain accepted by the downstream table builder; the two value
// functions are deliberately outside that chain and cover both zero-operand
// orders on computed expressions.
export const EQ_ZERO_KERNEL = `
const dispatch = (op, x, out) => {
  if (op === 0) out[0] = x + 11
  else if (op === 1) out[0] = x - 7
  else if (op === 2) out[0] = Math.imul(x, 3)
  else if (op === 3) out[0] = x ^ 85
  else if (op === 4) out[0] = x | 256
  else out[0] = -1
  return out[0]
}
export let chain = (n, x) => {
  let out = new Int32Array(1), sum = 0
  for (let i = 0; i < n; i++) sum += dispatch(i % 6, x + i, out)
  return sum
}
export let masked = (x) => (x & 7) === 0 ? 101 : 202
export let reversed = (x) => 0 === Math.imul(x, 3) ? 303 : 404
export let main = () => masked(8) + reversed(0)
`

// A different program for one-instance A→B reset coverage. It still exercises
// both eq-zero operand orders, but cannot accidentally encode to A's artifact.
export const EQ_ZERO_REUSE_B = `
export let main = () => {
  let x = 6
  return ((x & 3) === 0 ? 17 : 19) + (0 === Math.imul(x, 5) ? 23 : 29)
}
`
