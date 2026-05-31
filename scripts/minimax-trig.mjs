// Fit the minimax polynomials used by module/math.js sin_core / cos_core.
//   node scripts/minimax-trig.mjs
//
// jz folds every angle into [0, π/2], then evaluates a polynomial in x²:
//   sin(x) = x · P(x²)   (odd)      cos(x) = Q(x²)   (even)
// A least-squares fit on a dense grid is ~minimax for these smooth functions, and
// beats a Taylor series of the same degree — Taylor wastes precision near 0, the
// fit spreads error evenly across the range. 5 terms (degree 4 in x²) already beats
// the previous 6-term Taylor on both accuracy AND speed (one fewer multiply).

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

// fit fn(x) ≈ (oddX ? x : 1) · poly(x²), poly of degree `deg`, over [0, π/2]
function fit(fn, deg, oddX) {
  const M = 4000, N = deg + 1
  const A = Array.from({ length: N }, () => new Float64Array(N)), b = new Float64Array(N)
  for (let s = 0; s < M; s++) {
    const x = (s + 0.5) / M * HI, u = x * x
    const target = oddX ? (x > 1e-12 ? fn(x) / x : 1) : fn(x)
    const pu = new Float64Array(N); let p = 1
    for (let k = 0; k < N; k++) { pu[k] = p; p *= u }
    for (let i = 0; i < N; i++) { b[i] += target * pu[i]; for (let j = 0; j < N; j++) A[i][j] += pu[i] * pu[j] }
  }
  const c = solve(A, b, N)
  let maxe = 0
  for (let s = 0; s <= 20000; s++) {
    const x = s / 20000 * HI, u = x * x
    let p = 0; for (let k = N - 1; k >= 0; k--) p = p * u + c[k]
    maxe = Math.max(maxe, Math.abs((oddX ? x * p : p) - fn(x)))
  }
  return { c: [...c], maxe }
}

const sin = fit(Math.sin, 4, true), cos = fit(Math.cos, 4, false)
console.log('SIN_C (max err', sin.maxe.toExponential(2) + '):', JSON.stringify(sin.c))
console.log('COS_C (max err', cos.maxe.toExponential(2) + '):', JSON.stringify(cos.c))
