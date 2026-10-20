/**
 * A byte or halfword mask over a combination moves onto the operand it
 * narrows (speed tier): `(x ^ y) & 0xff` where `y` is a byte becomes
 * `(x & 0xff) ^ y`, the same value, since the mask keeps every bit `y` can
 * set. The same for `|`.
 *
 * x64 V8 lowers the mask to a zero extension. Over the combination it extends
 * a register into itself, an instruction on every path through the
 * expression. Over `x` alone, a value read again later (a table-driven CRC's
 * `c` before its `c >>> 8`), it copies into a register of its own, a move the
 * core can rename away, and a path from `y` passes one instruction instead of
 * two. No path grows and the instruction count holds. crc32's step
 * `table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)` runs 0.90x its time on Xeon
 * 6973P-C and 8370C, 0.98x on EPYC 7763 and 9V74, 1.01x on 9V45.
 *
 * Where neither operand sets a bit past the mask, the mask goes. Operands and
 * conditions evaluate in the order they did.
 *
 * @module optimize/mask-operands
 */

const isArr = Array.isArray
const FULL = 0xFFFFFFFF
// (sets, not patterns: the compiler compiles itself, and its source keeps to plain string tests)
const FLAGS = new Set(['i32.eqz', 'i64.eqz', ...['i32', 'i64'].flatMap(t => ['eq', 'ne', 'lt_s', 'lt_u', 'gt_s', 'gt_u', 'le_s', 'le_u', 'ge_s', 'ge_u'].map(o => `${t}.${o}`)),
  ...['f32', 'f64'].flatMap(t => ['eq', 'ne', 'lt', 'gt', 'le', 'ge'].map(o => `${t}.${o}`))])
const MASKS = new Set([0xFF, 0xFFFF])

const constOf = n => isArr(n) && n[0] === 'i32.const' && n.length === 2 && typeof n[1] === 'number' && Number.isInteger(n[1]) ? n[1] >>> 0 : null

/** The bits an i32 expression may set, as an unsigned word (every bit where unknown). */
const bitsOf = (n) => {
  if (!isArr(n)) return FULL
  const op = n[0], c = constOf(n)
  if (c != null) return c
  if (op === 'i32.load8_u') return 0xFF
  if (op === 'i32.load16_u') return 0xFFFF
  if (FLAGS.has(op)) return 1
  if (n.length !== 3) return FULL
  if (op === 'i32.and') return (bitsOf(n[1]) & bitsOf(n[2])) >>> 0
  if (op === 'i32.or' || op === 'i32.xor') return (bitsOf(n[1]) | bitsOf(n[2])) >>> 0
  if (op === 'i32.shr_u') { const k = constOf(n[2]); return k == null ? FULL : bitsOf(n[1]) >>> (k & 31) }
  return FULL
}

/** `(i32.and P M)` with M a byte or halfword mask and P an `^` or `|`: the rewrite, or null. */
const moveMask = (n) => {
  if (n.length !== 3) return null
  const m = constOf(n[2]) ?? constOf(n[1])
  if (m == null || !MASKS.has(m)) return null
  const p = constOf(n[2]) != null ? n[1] : n[2]
  if (!isArr(p) || p.length !== 3 || (p[0] !== 'i32.xor' && p[0] !== 'i32.or')) return null
  const out = (~m) >>> 0
  const wa = (bitsOf(p[1]) & out) !== 0, wb = (bitsOf(p[2]) & out) !== 0
  if (wa && wb) return null
  const mask = x => ['i32.and', x, ['i32.const', m]]
  // (the moved mask may narrow further: `((a ^ b) ^ y) & 0xff` with `b` a byte too)
  const inner = x => { const k = mask(x); return moveMask(k) ?? k }
  return wa ? [p[0], inner(p[1]), p[2]] : wb ? [p[0], p[1], inner(p[2])] : p
}

/** Move the byte and halfword masks of every function in `ast` (a module) onto the operand they narrow. */
export function maskOperands(ast) {
  if (!isArr(ast)) return ast
  const visit = (n) => {
    for (let i = 1; i < n.length; i++) {
      const c = n[i]
      if (!isArr(c)) continue
      visit(c)
      if (c[0] !== 'i32.and') continue
      const r = moveMask(c)
      if (r) n[i] = r
    }
  }
  for (const fn of ast) if (isArr(fn) && fn[0] === 'func') visit(fn)
  return ast
}
