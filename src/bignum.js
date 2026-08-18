/**
 * Unsigned arbitrary-precision integer arithmetic on 15-bit limbs (plain JS
 * number arrays, least-significant limb first, no leading-zero limbs —
 * `[]` is the canonical zero). Self-compile-safe by construction: every op is
 * plain array/number manipulation (no `BigInt`, no computed members, no
 * builtins-as-values), so it compiles under jz's own self-compile subset —
 * unlike native `BigInt`, whose jz-compiled carrier is a wrapping 64-bit i64
 * (see ctx.js, WIDE_BIGINT removed), a limb array has NO width ceiling:
 * growing the array is the only "carry", and every element stays a plain
 * safe-integer f64 (jz's native, unambiguous number representation).
 *
 * Scope: exactly what `prepare/pre-eval.js`'s Rational layer needs (f64<->
 * limb bit decomposition, +,-,*, big/big divmod for gcd + decimal expansion,
 * compare) plus what `parse.js`'s bigint-literal tagging needs (radix-text
 * accumulation, decimal stringification, 64-bit truncation). Not a general
 * bignum library — no negative numbers (sign lives one level up, in the
 * caller), no bitwise and/or/xor, no modexp.
 *
 * LIMB BASE IS 2^15 (32768), NOT 2^32 — deliberately narrower than the
 * "u32-limb" shorthand suggests, forced by a real jz self-compile constraint
 * discovered compiling THIS module: emit.js's `mulFitsI32` fast-path
 * (compile/emit.js, the `*` operator) treats a multiply as i32-safe whenever
 * EITHER operand's value is provably <= FITS_I32_MAX (2^22) — a heuristic
 * calibrated for typical index/hash-mix shapes (`i*4`, `t*(m&63)`), where
 * the OTHER operand is expected to already be small from context. It does
 * NOT check the actual product range. A 16-bit-limb split (the natural
 * choice for 32-bit limbs: mask+shift into two <2^16 halves, multiply the
 * halves) has BOTH halves individually <= FITS_I32_MAX, so the heuristic
 * fires on every partial product — but two <2^16 values can multiply past
 * 2^31, and the resulting `i32.mul` silently wraps (verified: compiling
 * `midLo * 65536` for midLo=32768 produced -2147483648 instead of
 * 2147483648 when this module was self-compiled, while identical native JS
 * gave the correct value — a compiler-narrowing bug, not an algorithm bug).
 * 15-bit limbs sidestep it structurally: the worst-case product of two
 * limbs is 32767*32767 = 1073676289 < 2^31-1, so `i32.mul` (whether or not
 * emit.js's heuristic is the reason it was chosen) is ALWAYS the exact
 * product — no split/recombine step is even needed. Every other per-limb op
 * here (add/sub/compare/shift-by-1) already stays far under 2^31 for the
 * same reason. This is a workaround for the compiler's own bootstrap, not a
 * general fix to `mulFitsI32` (out of this audit's scope — that heuristic's
 * soundness contract is a separate, wider concern with its own tests).
 *
 * @module bignum
 */

const BASE = 32768              // 2^15
const LIMB_BITS = 15

/** Strip leading (most-significant) zero limbs. `[]` is the canonical zero. */
function trim(limbs) {
  let n = limbs.length
  while (n > 0 && limbs[n - 1] === 0) n--
  return n === limbs.length ? limbs : limbs.slice(0, n)
}

export const ZERO = []
export const isZero = (a) => a.length === 0

/** Small non-negative safe-integer (up to 2^53) -> limbs. */
export function fromSmall(n) {
  const out = []
  while (n > 0) {
    const lo = n % BASE
    out.push(lo)
    n = Math.floor(n / BASE)
  }
  return out
}

/** -1 / 0 / 1 : a vs b, both magnitude limb arrays. */
export function cmp(a, b) {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1
  for (let i = a.length - 1; i >= 0; i--) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

export function add(a, b) {
  const n = a.length > b.length ? a.length : b.length
  const out = new Array(n)
  let carry = 0
  for (let i = 0; i < n; i++) {
    const s = (i < a.length ? a[i] : 0) + (i < b.length ? b[i] : 0) + carry
    if (s >= BASE) { out[i] = s - BASE; carry = 1 } else { out[i] = s; carry = 0 }
  }
  if (carry) out.push(carry)
  return out
}

/** a - b, magnitude. Requires a >= b (caller's responsibility — sign lives above this layer). */
export function sub(a, b) {
  const out = new Array(a.length)
  let borrow = 0
  for (let i = 0; i < a.length; i++) {
    let d = a[i] - (i < b.length ? b[i] : 0) - borrow
    if (d < 0) { d += BASE; borrow = 1 } else { borrow = 0 }
    out[i] = d
  }
  return trim(out)
}

/** Add a small (< 2^15) value (returns new limbs). */
export function addSmall(a, k) {
  if (k === 0) return a
  const out = a.slice()
  let carry = k
  for (let i = 0; carry > 0; i++) {
    const s = (i < out.length ? out[i] : 0) + carry   // carry may itself exceed BASE on the
    out[i] = s % BASE                                  // first step (k unrestricted) — floor/mod,
    carry = Math.floor(s / BASE)                        // not a single conditional subtract, handles it
  }
  return out
}

/** Multiply by a small (< 2^16) value. limb < 2^15, k < 2^16 -> product < 2^31,
 *  safely under Number.MAX_SAFE_INTEGER AND under the signed-i32 product bound
 *  that keeps this exact under jz's own `*` narrowing (see module doc). */
export function mulSmall(a, k) {
  if (k === 0 || isZero(a)) return ZERO
  const out = new Array(a.length)
  let carry = 0
  for (let i = 0; i < a.length; i++) {
    const p = a[i] * k + carry
    carry = Math.floor(p / BASE)
    out[i] = p - carry * BASE
  }
  while (carry > 0) { out.push(carry % BASE); carry = Math.floor(carry / BASE) }
  return out
}

/** Divide by a small (< 2^16) value. Returns [quotientLimbs, remainder].
 *  Two call sites reach this in-kernel (toDecimalString's per-digit /10 loop,
 *  and — formerly — truncateLimbs' single-limb mask): under O3 self-compile,
 *  those two call sites observably cross-contaminated `k` (traced live: a
 *  truncateLimbs call logged `mod=16` immediately before calling this, yet
 *  `k` read back as `10` — toDecimalString's OWN divisor — inside the call).
 *  Root cause not pinned further (time-boxed); worked around by giving
 *  truncateLimbs its own bitwise mask instead of a second call site here (see
 *  its doc). Flagging so a future O3-miscompile hunt has a lead: two call
 *  sites to the same small exported function, one with a literal `k`, one
 *  with a variable `k`, both under -O3. */
export function divModSmall(a, k) {
  if (isZero(a)) return [ZERO, 0]
  const out = new Array(a.length)
  let rem = 0
  for (let i = a.length - 1; i >= 0; i--) {
    const cur = rem * BASE + a[i]              // rem < k <= 0xffff, a[i] < 2^15 -> cur well under 2^31
    out[i] = Math.floor(cur / k)
    rem = cur - out[i] * k
  }
  return [trim(out), rem]
}

/** General a*b, schoolbook. Every partial product `a[i]*b[j]` is < 2^31 (see module
 *  doc), so it's exact as a plain number regardless of which wasm op emit.js picks for
 *  it. Column accumulators sum up to `min(a.length,b.length)` such partial products —
 *  bounded by diagonal length * 2^31, far under 2^53 for any realistic operand size —
 *  and are carry-normalized once at the end. */
export function mul(a, b) {
  if (isZero(a) || isZero(b)) return ZERO
  const acc = new Array(a.length + b.length).fill(0)
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 0) continue
    for (let j = 0; j < b.length; j++) {
      acc[i + j] += a[i] * b[j]
    }
  }
  let carry = 0
  for (let k = 0; k < acc.length; k++) {
    const v = acc[k] + carry
    carry = Math.floor(v / BASE)
    acc[k] = v - carry * BASE
  }
  while (carry > 0) { acc.push(carry % BASE); carry = Math.floor(carry / BASE) }
  return trim(acc)
}

/** Bit length (0 for zero). */
export function bitLength(a) {
  if (isZero(a)) return 0
  const top = a[a.length - 1]
  let bits = 0, v = top
  while (v > 0) { bits++; v = Math.floor(v / 2) }
  return (a.length - 1) * LIMB_BITS + bits
}

/** Shift left by exactly 1 bit. Every limb stays < 2^15, so `a[i]*2` is < 2^16 —
 *  nowhere near any i32-narrowing boundary. */
function shl1(a) {
  if (isZero(a)) return a
  const out = new Array(a.length)
  let carry = 0
  for (let i = 0; i < a.length; i++) {
    const v = a[i] * 2 + carry
    if (v >= BASE) { out[i] = v - BASE; carry = 1 } else { out[i] = v; carry = 0 }
  }
  if (carry) out.push(carry)
  return out
}

/** Shift right by exactly 1 bit (floor division by 2). */
function shr1(a) {
  if (isZero(a)) return a
  const out = new Array(a.length)
  let carry = 0
  for (let i = a.length - 1; i >= 0; i--) {
    const v = a[i] + carry * BASE
    out[i] = Math.floor(v / 2)
    carry = v % 2
  }
  return trim(out)
}

/** General big/big division. Returns [quotientLimbs, remainderLimbs]. b must be nonzero. */
export function divMod(a, b) {
  if (cmp(a, b) < 0) return [ZERO, a]
  const shift = bitLength(a) - bitLength(b)
  let rem = a
  let divisor = shiftLeft(b, shift)
  let quotient = ZERO
  for (let i = shift; i >= 0; i--) {
    if (cmp(rem, divisor) >= 0) {
      rem = sub(rem, divisor)
      quotient = setBit(quotient, i)
    }
    if (i > 0) divisor = shr1(divisor)
  }
  return [quotient, rem]
}

/** a << bits via a word-shift (whole limbs) + repeated single-bit shifts for the
 *  remainder (bits >= 0, safe for any width — no per-limb multiply by 2^bit). */
export function shiftLeft(a, bits) {
  if (isZero(a) || bits === 0) return a
  const words = Math.floor(bits / LIMB_BITS), bit = bits % LIMB_BITS
  let out = new Array(words).fill(0).concat(a)
  for (let i = 0; i < bit; i++) out = shl1(out)
  return trim(out)
}

/** Set bit `i` of a limb array (grows as needed), returns new array. `bit` is always
 *  < 15 here (LIMB_BITS), so `1 << bit` and the OR both stay far under any i32-range
 *  concern (max value 16384) — bitwise ops are exact-32-bit by JS/wasm spec regardless
 *  of magnitude anyway (only `*`'s i32 fast path has the narrowing gap this module
 *  otherwise works around — see module doc). */
function setBit(a, i) {
  const word = Math.floor(i / LIMB_BITS), bit = i % LIMB_BITS
  const out = a.slice()
  while (out.length <= word) out.push(0)
  out[word] = out[word] | (1 << bit)
  return trim(out)
}

/** Decimal string (no sign — caller prepends "-"). "0" for zero. */
export function toDecimalString(a) {
  if (isZero(a)) return '0'
  let cur = a, digits = ''
  while (!isZero(cur)) {
    const [q, r] = divModSmall(cur, 10)
    digits = String(r) + digits
    cur = q
  }
  return digits
}

/** Parse an unsigned digit-string in the given small radix (2, 8, 10, or 16) into limbs.
 *  Pure structural digit accumulation (fused multiply-by-radix + add-digit, inline —
 *  see the loop comment below for why not the separate mulSmall/addSmall primitives) —
 *  no BigInt, no `typeof` classification of the input text at any point (see parse.js's
 *  bigint-literal tag). */
export function fromRadixDigits(text, radix) {
  const acc = []   // fresh, mutable — NOT the shared `ZERO` singleton
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    let d
    if (c >= 48 && c <= 57) d = c - 48
    else if (c >= 97 && c <= 102) d = c - 97 + 10
    else if (c >= 65 && c <= 70) d = c - 65 + 10
    else continue   // skip stray non-digit chars defensively (callers pre-strip underscores)
    // Fused multiply-by-radix + add-digit, NOT `addSmall(mulSmall(acc,radix),d)`:
    // mulSmall's OTHER call site (pre-eval.js ratToF64's `mulSmall(rem,10)`, a
    // LITERAL `k`) observably cross-contaminated THIS call site's variable `radix`
    // under O3 self-compile (traced live: fromRadixDigits computing `0xffffffffffffffffn`
    // silently ran with k=10 instead of 16 partway through — the same call-site-
    // sharing class as divModSmall's, see its doc). A dedicated inline loop with no
    // shared call site sidesteps it regardless of the exact root cause.
    let carry = d
    for (let j = 0; carry > 0 || j < acc.length; j++) {
      const p = (j < acc.length ? acc[j] : 0) * radix + carry
      carry = Math.floor(p / BASE)
      acc[j] = p - carry * BASE   // out-of-bounds assignment auto-grows a plain array
    }
  }
  return trim(acc)
}

/** Keep only the low `bits` bits (== value mod 2^bits) — used to truncate a bigint
 *  literal's magnitude to the carrier's 64-bit width (bits=64). Whole limbs below the
 *  boundary pass through unchanged; the one limb straddling the boundary is masked
 *  directly (bitwise AND against 2^rem-1, rem<15 so well inside i32 range either way). */
export function truncateLimbs(a, bits) {
  const words = Math.floor(bits / LIMB_BITS), rem = bits % LIMB_BITS
  if (a.length <= words) return a
  const kept = a.slice(0, words)
  if (rem === 0) return trim(kept)
  // mod is always a power of 2 (2^rem, rem<15) — mask the top limb directly
  // (a[words] & (mod-1)) rather than a divModSmall call: single-limb, exact,
  // and keeps this independent of divModSmall's other call site (toDecimalString's
  // digit-extraction loop) — see divModSmall's own doc for why that matters.
  const mod = Math.pow(2, rem)
  const topRem = a[words] & (mod - 1)
  kept.push(topRem)
  return trim(kept)
}
