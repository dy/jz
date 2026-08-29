/**
 * Shared trig/exp2 reduction constants: minimax coefficient tables (fit by
 * scripts/minimax-trig.mjs) and π-reduction constants. Pure move from
 * module/math.js (pipeline-minimality) — a zero-dependency leaf, extracted
 * because BOTH math.js's scalar kernels (sin_core/cos_core/exp2/acos/atan2)
 * and module/math/simd.js's f64x2 kernels need the same values; keeping one
 * copy here and importing it both ways avoids duplicating the tables and
 * avoids a math.js <-> simd.js import cycle (mirrors module/typedarray/
 * elem-tables.js's identical role for STRIDE/SHIFT/LOAD/STORE).
 *
 * @module math/trig-tables
 */

export const SIN_C = [1, -0.16666660296130772, 0.008333091744946387, -0.00019811771757028443, 0.000002611054662215034]
export const COS_C = [1, -0.4999993043717576, 0.04166402742354027, -0.0013856638518363177, 0.00002321737177898552]
// 2^f over the reduced range f ∈ [-0.5, 0.5] for $math.exp2 (rel. err ≤ 6e-9). Lets the
// base-2 power `2**y` skip the ×ln2 / ÷ln2 round-trip exp(y·ln2) pays — see $math.exp2.
export const EXP2_C = [1, 0.6931472000619209, 0.24022650999918949, 0.05550340682450019, 0.009618048870444599, 0.0013395279077191057, 0.00015463102004723134]
// Range-reduction constants via plain number interpolation: `${number}` now formats
// through the Ryū shortest-round-trip __ftoa in BOTH legs (host and self-compiled
// kernel), so the full-precision f64 bakes into the WAT verbatim — the former
// string-literal workaround for the kernel's 9-digit dtoa is obsolete.
export const PI = Math.PI, INV_PI = 1 / Math.PI, HALF_PI = Math.PI / 2
