/** Shared coefficients and reduction constants for scalar/f64x2 math and folding.
 *  Trig coefficients are fitted by scripts/minimax-trig.mjs; each consumer
 *  evaluates the same table in the same order. */

// Reduced-interval absolute-error target: < 1e-11.
export const SIN_C = [1, -0.16666666667145086, 0.008333333357420617, -0.00019841273492958287, 0.0000027557505892476993, -2.505078488144839e-8, 1.569548903996199e-10]
export const COS_C = [1, -0.5000000000313822, 0.04166666680489532, -0.001388889031874116, 0.00002480154443918303, -2.75435907987491e-7, 2.0172342025584007e-9]
// 2^f over the reduced range f ∈ [-0.5, 0.5] for $math.exp2 (rel. err ≤ 6e-9). Lets the
// base-2 power `2**y` skip the ×ln2 / ÷ln2 round-trip exp(y·ln2) pays — see $math.exp2.
export const EXP2_C = [1, 0.6931472000619209, 0.24022650999918949, 0.05550340682450019, 0.009618048870444599, 0.0013395279077191057, 0.00015463102004723134]
// Range-reduction constants via plain number interpolation: `${number}` now formats
// through the Ryū shortest-round-trip __ftoa in BOTH legs (host and self-compiled
// kernel), so the full-precision f64 bakes into the WAT verbatim — the former
// string-literal workaround for the kernel's 9-digit dtoa is obsolete.
export const PI = Math.PI, INV_PI = 1 / Math.PI, HALF_PI = Math.PI / 2
