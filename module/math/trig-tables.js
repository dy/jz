/** Shared coefficients and reduction constants for scalar/f64x2 math and folding.
 *  Trig coefficients are fitted by scripts/minimax-trig.mjs; each consumer
 *  evaluates the same table in the same order. */

// Reduced-interval absolute-error target: < 1e-11.
// sin(r)/r and cos(r) on the reduced range |r| <= pi/2, as their Maclaurin
// series with EXACT 1/n! coefficients — ten terms for sin and eleven for cos,
// the lengths that land within a few ulp (4.4e-16 and 1.8e-15 relative where
// the result is not cancelling toward a zero). The seven-term minimax pair
// they replace stopped at 1.2e-12 and 2.2e-11. Near a zero of the function
// the argument reduction, not the series, sets the error.
export const SIN_C = [1, -0.16666666666666666, 0.008333333333333333, -0.0001984126984126984, 0.0000027557319223985893, -2.505210838544172e-8, 1.6059043836821613e-10, -7.647163731819816e-13, 2.8114572543455206e-15, -8.22063524662433e-18]
export const COS_C = [1, -0.5, 0.041666666666666664, -0.001388888888888889, 0.0000248015873015873, -2.755731922398589e-7, 2.08767569878681e-9, -1.1470745597729725e-11, 4.779477332387385e-14, -1.5619206968586225e-16, 4.110317623312165e-19]
// 2^f over the reduced range f ∈ [-0.5, 0.5] for $math.exp2 (rel. err ≤ 6e-9). Lets the
// base-2 power `2**y` skip the ×ln2 / ÷ln2 round-trip exp(y·ln2) pays — see $math.exp2.
/**
 * The polynomial evaluation tree THREE evaluators share — the scalar WAT builder
 * (module/math.js), the two-wide one (module/math/simd.js) and the JS constant
 * folder (src/prepare/math-kernel.js). They must agree bit for bit: a folded
 * `Math.cos(0.7)` is compared against the compiled kernel's own answer, and a
 * vectorized loop against its scalar tail. Sharing the tree makes that agreement
 * structural instead of three copies that have to be kept in step by hand.
 *
 * Estrin's scheme: pair the coefficients, then fold the pairs with x², x⁴, x⁸ …
 * Horner's chain is one multiply-add deep per coefficient, so a series long
 * enough to be accurate spends its time waiting on itself; this tree is log2(n)
 * deep and its halves evaluate side by side. The powers repeat across the tree
 * and the WAT optimizer's CSE shares them, so the operation count is unchanged
 * and only the critical path shrinks.
 *
 * `ops` supplies the three constructors for the target: a constant, a multiply
 * and an add. `x` is the variable already in the target's own form.
 */
export const polyTree = (cs, ops, x) => {
  const { konst, mul, add } = ops
  let terms = []
  for (let i = 0; i < cs.length; i += 2)
    terms.push(i + 1 < cs.length ? add(konst(cs[i]), mul(x, konst(cs[i + 1]))) : konst(cs[i]))
  let pow = mul(x, x)
  while (terms.length > 1) {
    const next = []
    for (let i = 0; i < terms.length; i += 2)
      next.push(i + 1 < terms.length ? add(terms[i], mul(pow, terms[i + 1])) : terms[i])
    terms = next
    pow = mul(pow, pow)
  }
  return terms[0]
}

// atanh's series for log: log((1+s)/(1-s)) = 2s * (1 + s^2/3 + s^4/5 + …), the
// coefficients 1/(2k+1) EXACTLY, k = 0..9. log reduces to |s| <= 0.1716, where
// ten terms land within 2 ulp (measured against log1p(s) - log1p(-s), which has
// no cancellation to hide behind). The five-term minimax this replaces stopped
// at 1.7e-11 and set the accuracy of log2, log1p, asinh, acosh and atanh with it.
export const LOG_C = [1, 0.3333333333333333, 0.2, 0.14285714285714285, 0.1111111111111111, 0.09090909090909091, 0.07692307692307693, 0.06666666666666667, 0.058823529411764705, 0.05263157894736842]

// (e^x - 1)/x on |x| < 0.5 as the Maclaurin series 1/n!, n = 1..14 — the length
// that lands within 2 ulp (measured against the host over 200k points; the
// 8-term series this replaces stopped at 1.3e-8 relative, the one function that
// sat outside jz's own ~1e-9 transcendental budget). expm1 keeps its own series
// rather than `exp(x) - 1` because that subtraction cancels away the answer near
// zero, which is the whole reason the function exists.
export const EXPM1_C = [1, 0.5, 0.16666666666666666, 0.041666666666666664, 0.008333333333333333, 0.001388888888888889, 0.0001984126984126984, 0.0000248015873015873, 0.0000027557319223985893, 2.755731922398589e-7, 2.505210838544172e-8, 2.08767569878681e-9, 1.6059043836821613e-10, 1.1470745597729725e-11]

// 2^f on [-0.5, 0.5] as the Maclaurin series (ln2)^n/n!, n = 0..13 — the degree
// that lands within ONE ulp of the exact power (measured against the host over
// 400k points in the reduced range; degree 12 stops at 3 ulp, and the degree-6
// minimax this replaces stopped at 6.2e-9 relative, ~3.9e7 ulp). exp2 carries
// `Math.exp`, `Math.pow(2, x)`, sinh/cosh/tanh and the colour cases' decode, so
// its accuracy is theirs.
export const EXP2_C = [1, 0.6931471805599453, 0.2402265069591007, 0.055504108664821576, 0.009618129107628477, 0.0013333558146428443, 0.0001540353039338161, 1.525273380405984e-05, 1.3215486790144307e-06, 1.0178086009239699e-07, 7.054911620801122e-09, 4.4455382718708106e-10, 2.56784359934882e-11, 1.3691488853904124e-12]
// Range-reduction constants via plain number interpolation: `${number}` now formats
// through the Ryū shortest-round-trip __ftoa in BOTH legs (host and self-compiled
// kernel), so the full-precision f64 bakes into the WAT verbatim — the former
// string-literal workaround for the kernel's 9-digit dtoa is obsolete.
export const PI = Math.PI, INV_PI = 1 / Math.PI, HALF_PI = Math.PI / 2
