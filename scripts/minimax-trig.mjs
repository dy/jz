// Fit the shared scalar/SIMD trig polynomials in module/math/trig-tables.js.
//   node scripts/minimax-trig.mjs
//
// Angles reduce to [-π/2, π/2]; fit sin(x)/x and cos(x) in x².
// Keep the constant term exactly 1 so sin(x)/x → 1 and cos(0) = 1.
// Six fitted terms keep measured error below 1e-11 on this interval. The
// former four-term fit lost precision in cancellation such as 1 - cos(x),
// changing filter coefficients enough to cross 16-bit PCM boundaries.

const HI = Math.PI / 2

function solve(A, b, N) {
  for (let i = 0; i < N; i++) {
    let piv = i
    for (let r = i + 1; r < N; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r
    const tA = A[i]; A[i] = A[piv]; A[piv] = tA
    const tb = b[i]; b[i] = b[piv]; b[piv] = tb
    for (let r = 0; r < N; r++) {
      if (r === i) continue
      const f = A[r][i] / A[i][i]
      for (let k = i; k < N; k++) A[r][k] -= f * A[i][k]
      b[r] -= f * b[i]
    }
  }
  const c = new Float64Array(N)
  for (let i = 0; i < N; i++) c[i] = b[i] / A[i][i]
  return c
}

// Fit fn(x) ≈ (oddX ? x : 1) · (1 + c1·x² + … + cN·x²N).
function fit(fn, deg, oddX) {
  const M = 4000, N = deg
  const A = Array.from({ length: N }, () => new Float64Array(N)), b = new Float64Array(N)
  for (let s = 0; s < M; s++) {
    const x = (s + 0.5) / M * HI, u = x * x
    const target = (oddX ? (x > 1e-12 ? fn(x) / x : 1) : fn(x)) - 1
    const pu = new Float64Array(N); let p = u
    for (let k = 0; k < N; k++) { pu[k] = p; p *= u }
    for (let i = 0; i < N; i++) { b[i] += target * pu[i]; for (let j = 0; j < N; j++) A[i][j] += pu[i] * pu[j] }
  }
  const c = [1, ...solve(A, b, N)]
  let maxe = 0
  for (let s = 0; s <= 20000; s++) {
    const x = s / 20000 * HI, u = x * x
    let p = 0; for (let k = N; k >= 0; k--) p = p * u + c[k]
    maxe = Math.max(maxe, Math.abs((oddX ? x * p : p) - fn(x)))
  }
  return { c: [...c], maxe }
}

const sin = fit(Math.sin, 6, true), cos = fit(Math.cos, 6, false)
console.log('SIN_C (max err', sin.maxe.toExponential(2) + '):', JSON.stringify(sin.c))
console.log('COS_C (max err', cos.maxe.toExponential(2) + '):', JSON.stringify(cos.c))
