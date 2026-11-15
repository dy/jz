/**
 * Local rewrites of WAT as one table. A row claims that one tree computes what
 * another does, under a condition on the first tree's constants and in a stated
 * sense of "the same" (its relation, below); one matcher applies the rows, and a
 * pass that rewrites trees bottom-up applies a list of them where its chain of
 * tests stood: fusedRewrite's walk (WALK, and HELPERS outside the helpers' own
 * bodies), foldWrappedWords (WORDS), foldLoadCasts (LOADS).
 *
 * A row is `[name, relation, match, out, when]`:
 *   match  a tree with holes: `'?x'` any subtree (or, in a constant's immediate,
 *          its value), `'?'` any subtree unnamed, `['?x', P]` a subtree matching
 *          P named x, `'?*m'` (last in a list) the rest of the list. A constant's
 *          immediate is matched by the value it spells: an i32 as its word (so
 *          `(i32.const 4294967295)` is -1), an i64 as a BigInt of 64 bits, a
 *          float as a number; a NaN's payload spells no value and matches no
 *          constant. Every node matches with its own arity.
 *   out    the replacement: a tree in which a named hole is the subtree it named
 *          (the node itself, with what the emitter marked on it), a rest hole is
 *          spliced and a function is called with the holes' values in the order
 *          they first appear in match; or such a function giving the whole tree.
 *   when   null, or a function of the holes' values (the same order): the row's
 *          condition on its constants.
 *
 * Relations: what "computes the same" means for a row, checked as stated.
 *   EXACT        the same bits on every input, and a trap exactly where the
 *                pattern traps.
 *   NAN          EXACT but for a NaN's payload (arithmetic leaves it to the
 *                engine).
 *   FEWER_TRAPS  the same where neither side traps; the replacement traps on
 *                a subset of the inputs the pattern traps on, never on another.
 *                A row removes a trap only under an invariant of jz's that makes
 *                the trap unreachable, named in its comment.
 * The rules that stay code (peephole.js and its neighbours) state theirs in the
 * same terms, two more among them: equal where an address sum does not wrap
 * (the memarg fold), and equal up to memory after a trap (merged byte stores).
 *
 * test/rules.js checks every row: for each tuple of constants on a grid that
 * the row's condition admits (each constant spelled as the IR holds it: numbers,
 * a word past 2^31, hex, a sign, `_`), it assembles both trees with watr and runs
 * them over a grid of arguments of each hole's type: the edges of i32 and i64
 * (zero, ±1, the words' bounds, powers of two and their neighbours), of f64 passed
 * as bits (zeros of both signs, the infinities, NaNs of several payloads and both
 * signs, the integer and word bounds, subnormals), NaN boxes of every tag where a
 * runtime helper reads one, addresses at both ends of one page of memory, and
 * random values. It fails where the trees differ on an admitted input by the
 * row's relation. A tuple the condition refuses on which both sides agree is
 * reported, not failed: a condition stricter than the weakest true one. Checked
 * means run on that grid: evidence, not a proof.
 *
 * @module optimize/rules
 */
import { LAYOUT, atomNanHex } from '../../layout.js'

export const EXACT = 'exact', NAN = 'nan', FEWER_TRAPS = 'fewer traps'
// (the two relations of rules that stay code)
export const NO_WRAP = 'no wrap', AFTER_TRAP = 'memory after a trap'

// ── the matcher ───────────────────────────────────────────────────────────

const isHole = (p) => typeof p === 'string' && p.charCodeAt(0) === 63   // '?'
const isRest = (p) => isHole(p) && p.charCodeAt(1) === 42               // '?*'
const CONSTS = new Set(['i32.const', 'i64.const', 'f32.const', 'f64.const'])

// The number an immediate spells (a sign, `_` between digits, decimal or hex, `inf`), or null.
const NUMERAL = /^(?:0x[0-9a-f]+|\d+(?:\.\d*)?(?:e[-+]?\d+)?)$/i
const spelled = (v) => {
  if (typeof v === 'number') return v
  if (typeof v !== 'string') return null
  const s = v.replace(/_/g, ''), neg = s[0] === '-', body = neg || s[0] === '+' ? s.slice(1) : s
  if (body === 'inf') return neg ? -Infinity : Infinity
  if (!NUMERAL.test(body)) return null
  return neg ? -Number(body) : Number(body)
}
/** The value the immediate `v` of a constant `op` denotes, or null: an i32 its word, an i64 a BigInt, a float a number. */
export const immediate = (op, v) => {
  if (op === 'i64.const') {
    if (typeof v === 'bigint') return BigInt.asIntN(64, v)
    const n = spelled(v)
    if (n === null || !Number.isInteger(n)) return null
    if (typeof v === 'number') return BigInt.asIntN(64, BigInt(v))
    const s = v.replace(/_/g, ''), neg = s[0] === '-'
    const big = BigInt(neg || s[0] === '+' ? s.slice(1) : s)
    return BigInt.asIntN(64, neg ? -big : big)
  }
  const n = spelled(v)
  if (n === null) return null
  return op === 'i32.const' ? (Number.isInteger(n) ? n | 0 : null) : n
}

// Whether `n` matches pattern `p`, pushing the holes' values on `v` in the order they appear.
const match = (p, n, v) => {
  if (isHole(p)) { if (p.length > 1) v.push(n); return true }
  if (!Array.isArray(p)) return p === n
  if (!Array.isArray(n)) return false
  if (isHole(p[0])) { v.push(n); return match(p[1], n, v) }
  const rest = isRest(p[p.length - 1]), len = rest ? p.length - 1 : p.length
  if (rest ? n.length < len : n.length !== len) return false
  if (p[0] !== n[0]) return false
  if (CONSTS.has(p[0]) && len === 2) {
    const k = immediate(p[0], n[1])
    if (k === null) return false
    if (isHole(p[1])) { if (p[1].length > 1) v.push(k); return true }
    return k === p[1]
  }
  for (let i = 1; i < len; i++) if (!match(p[i], n[i], v)) return false
  if (rest) v.push(n.slice(len))
  return true
}

// The tree `t` with its holes filled from `v` (named by `names`).
const build = (t, v, names) => {
  if (typeof t === 'function') return t(...v)
  if (isHole(t)) return v[names.indexOf(t)]
  if (!Array.isArray(t)) return t
  const out = []
  for (const x of t) {
    if (isRest(x)) out.push(...v[names.indexOf(x)])
    else out.push(build(x, v, names))
  }
  return out
}

// The named holes of a pattern in the order they appear.
const holes = (p, out = []) => {
  if (isHole(p)) { if (p.length > 1) out.push(p); return out }
  if (!Array.isArray(p)) return out
  for (const x of p) holes(x, out)
  return out
}

/** A row of the table: `[name, relation, match, out, when, holes]`. */
export const rule = (name, relation, match, out, when = null) => [name, relation, match, out, when, holes(match)]

/** A list of rows as a matcher applies it: by the op at their pattern's root, in the list's order. */
export const rulesOf = (rows) => {
  const byOp = new Map()
  for (const r of rows) {
    const op = r[2][0]
    let l = byOp.get(op)
    if (!l) byOp.set(op, l = [])
    l.push(r)
  }
  return byOp
}

// (the holes' values of the row being tried: one list for every match, the hosted compiler freeing nothing within a compile)
const V = []
/** The replacement the first row of `rules` (a `rulesOf` list) matching `n` gives, or null. */
export function rewriteBy(rules, n) {
  const rows = rules.get(n[0])
  if (!rows) return null
  for (const r of rows) {
    V.length = 0
    if (match(r[2], n, V) && (r[4] === null || r[4](...V))) return marked(n, build(r[3], V, r[5]))
  }
  return null
}
// A load a row makes of a load it matched, at the matched one's address (a word of a slot, the
// other type's load of its bytes), reads the region the emitter marked on the matched one
// (src/ir/mem-alias.js): the mark goes with it.
const marked = (n, out) => {
  if (!Array.isArray(out) || typeof out[0] !== 'string' || !out[0].includes('.load') || out.mem != null) return out
  const addr = out[out.length - 1]
  const find = (x) => { if (!Array.isArray(x)) return null; if (x !== out && x.mem != null && x[x.length - 1] === addr) return x; for (let i = 1; i < x.length; i++) { const f = find(x[i]); if (f) return f } return null }
  const from = find(n)
  if (from) out.mem = from.mem
  return out
}

// ── the rows ──────────────────────────────────────────────────────────────

// (a power of two as a word, 2^31 among them: its exponent)
const pow2 = (k) => k !== 0 && (k & (k - 1)) === 0
const log2 = (k) => 31 - Math.clz32(k)
// (a mask keeping every bit a shift right by k leaves)
const keeps = (k, m) => { const low = (-1 >>> (k & 31)) | 0; return (m & low) === low }
// (an operand duplicated by a row: a local's read or a constant)
const cheapF64 = (x) => (x[0] === 'local.get' && typeof x[1] === 'string') || (x[0] === 'f64.const' && typeof x[1] === 'number')
const extend = (x) => (x[0] === 'i64.extend_i32_u' || x[0] === 'i64.extend_i32_s') && x.length === 2
// (a memarg for a four-byte access: an alignment past four bytes, which it may not claim, dropped)
const word = (m) => m.filter(x => !(typeof x === 'string' && x.startsWith('align=') && Number(x.slice(6)) > 4))
const NULL_BITS = atomNanHex(1), UNDEF_BITS = atomNanHex(2)

const ROWS = [
  // x | 0 is x
  rule('or-zero', EXACT, ['i32.or', '?x', ['i32.const', 0]], '?x'),
  rule('or-zero-left', EXACT, ['i32.or', ['i32.const', 0], '?x'], '?x'),
  // `x >>> k` has 32 - k bits: a mask keeping all of them is idle (`(h >>> 23) & 511`)
  rule('and-after-shr_u', EXACT, ['i32.and', ['?s', ['i32.shr_u', '?', ['i32.const', '?k']]], ['i32.const', '?m']], '?s', (s, k, m) => keeps(k, m)),
  rule('and-after-shr_u-left', EXACT, ['i32.and', ['i32.const', '?m'], ['?s', ['i32.shr_u', '?', ['i32.const', '?k']]]], '?s', (m, s, k) => keeps(k, m)),
  // a word scale by a power of two is a shift, which exposes the byte stride to the lane recognizers
  rule('mul-pow2-left', EXACT, ['i32.mul', ['i32.const', '?k'], '?x'], ['i32.shl', '?x', ['i32.const', (k) => log2(k)]], pow2),
  rule('mul-pow2', EXACT, ['i32.mul', '?x', ['i32.const', '?k']], ['i32.shl', '?x', ['i32.const', (x, k) => log2(k)]], (x, k) => pow2(k)),
  // a scaled term moves out of a sum, so the constant beside it can reach the memarg
  rule('add-shl-assoc', EXACT, ['i32.add', '?a', ['i32.add', '?b', ['?c', ['i32.shl', '?', '?']]]], ['i32.add', ['i32.add', '?a', '?b'], '?c']),
  // the constant of a sum lifts to its root, where the memarg fold reads it
  rule('add-const-assoc', EXACT, ['i32.add', '?a', ['i32.add', '?b', ['?k', ['i32.const', '?']]]], ['i32.add', ['i32.add', '?a', '?b'], '?k']),
  rule('add-const-assoc-2', EXACT, ['i32.add', '?a', ['i32.add', ['?k', ['i32.const', '?']], '?b']], ['i32.add', ['i32.add', '?a', '?b'], '?k']),
  rule('add-const-assoc-3', EXACT, ['i32.add', ['i32.add', '?a', ['?k', ['i32.const', '?']]], '?b'], ['i32.add', ['i32.add', '?a', '?b'], '?k']),
  rule('add-const-assoc-4', EXACT, ['i32.add', ['i32.add', ['?k', ['i32.const', '?']], '?a'], '?b'], ['i32.add', ['i32.add', '?a', '?b'], '?k']),
  // a shift's count is taken mod 32
  rule('shl-zero', EXACT, ['i32.shl', '?x', ['i32.const', '?k']], '?x', (x, k) => (k & 31) === 0),
  // two shifts left are one by the sum of their counts, each taken mod 32, while it is below 32
  rule('shl-shl', EXACT, ['i32.shl', ['i32.shl', '?x', ['i32.const', '?a']], ['i32.const', '?b']], ['i32.shl', '?x', ['i32.const', (x, a, b) => (a & 31) + (b & 31)]], (x, a, b) => (a & 31) + (b & 31) < 32),
  // a shift distributes over a sum modulo 2^32: `(x + K) << S` is `(x << S) + (K << S)`, the memarg's constant
  rule('shl-add', EXACT, ['i32.shl', ['i32.add', '?x', ['i32.const', '?k']], ['i32.const', '?s']], ['i32.add', ['i32.shl', '?x', ['i32.const', (x, k, s) => s]], ['i32.const', (x, k, s) => k << s]], (x, k, s) => s >= 0 && s < 32),
  rule('shl-add-left', EXACT, ['i32.shl', ['i32.add', ['i32.const', '?k'], '?x'], ['i32.const', '?s']], ['i32.add', ['i32.shl', '?x', ['i32.const', (k, x, s) => s]], ['i32.const', (k, x, s) => k << s]], (k, x, s) => s >= 0 && s < 32),
  // a word converted is a constant: signed by its word, unsigned by its bits
  rule('convert-const', EXACT, ['f64.convert_i32_s', ['i32.const', '?k']], ['f64.const', (k) => k]),
  rule('convert-const-u', EXACT, ['f64.convert_i32_u', ['i32.const', '?k']], ['f64.const', (k) => k >>> 0]),
  // a doubling of a value read once is a sum (an add is the shorter latency)
  rule('mul-two', NAN, ['f64.mul', ['f64.const', 2], '?x'], ['f64.add', '?x', '?x'], cheapF64),
  rule('mul-two-right', NAN, ['f64.mul', '?x', ['f64.const', 2]], ['f64.add', '?x', '?x'], cheapF64),
  // the low word of a high part or'ed with a word is the word: a NaN box's offset
  rule('wrap-or-extend', EXACT, ['i32.wrap_i64', ['i64.or', ['i64.const', '?h'], '?e']], (h, e) => e[1], (h, e) => (h & 0xFFFFFFFFn) === 0n && extend(e)),
  rule('wrap-or-extend-right', EXACT, ['i32.wrap_i64', ['i64.or', '?e', ['i64.const', '?h']]], (e, h) => e[1], (e, h) => (h & 0xFFFFFFFFn) === 0n && extend(e)),
  // the low word of an eight-byte slot is the word at its address (little-endian);
  // the four-byte read traps on fewer addresses than the eight-byte one (only where
  // the slot's last four bytes leave memory), and a slot jz reads lies inside it
  rule('wrap-box-load', FEWER_TRAPS, ['i32.wrap_i64', ['i64.reinterpret_f64', ['f64.load', '?*m']]], (m) => ['i32.load', ...word(m)]),
  // a word converted and truncated is the convert (watr's simplifyCast holds it too, for the tail)
  rule('trunc-convert', EXACT, ['f64.trunc', ['?c', ['f64.convert_i32_s', '?']]], '?c'),
  rule('trunc-convert-u', EXACT, ['f64.trunc', ['?c', ['f64.convert_i32_u', '?']]], '?c'),
  // a load's bits are the other type's load of the same eight bytes
  rule('bits-of-load', EXACT, ['i64.reinterpret_f64', ['f64.load', '?*m']], ['i64.load', '?*m']),
  rule('float-of-load', EXACT, ['f64.reinterpret_i64', ['i64.load', '?*m']], ['f64.load', '?*m']),
  rule('bits-of-float', EXACT, ['i64.reinterpret_f64', ['f64.reinterpret_i64', '?v']], '?v'),
  // the low word of an i64 load is the i32 load at its address (as wrap-box-load)
  rule('wrap-load', FEWER_TRAPS, ['i32.wrap_i64', ['i64.load', '?*m']], (m) => ['i32.load', ...word(m)]),
  // the runtime's fixed tag tests, as their bodies (module/core.js) compute them
  rule('ptr-type', EXACT, ['call', '$__ptr_type', '?x'], ['i32.and', ['i32.wrap_i64', ['i64.shr_u', '?x', ['i64.const', LAYOUT.TAG_SHIFT]]], ['i32.const', LAYOUT.TAG_MASK]]),
  rule('ptr-aux', EXACT, ['call', '$__ptr_aux', '?x'], ['i32.and', ['i32.wrap_i64', ['i64.shr_u', '?x', ['i64.const', LAYOUT.AUX_SHIFT]]], ['i32.const', LAYOUT.AUX_MASK]]),
  rule('is-null', EXACT, ['call', '$__is_null', '?x'], ['i64.eq', '?x', ['i64.const', NULL_BITS]]),
  // (the operand read twice: a local's bits)
  rule('is-nullish', EXACT, ['call', '$__is_nullish', ['?x', ['i64.reinterpret_f64', ['local.get', '?']]]], ['i32.or', ['i64.eq', '?x', ['i64.const', NULL_BITS]], ['i64.eq', '?x', ['i64.const', UNDEF_BITS]]]),
]

/** Every row, for the checker. */
export const TABLE = ROWS
const named = (...names) => ROWS.filter(r => names.includes(r[0]))
/** fusedRewrite's walk, at every node. */
export const WALK = rulesOf(named('or-zero', 'or-zero-left', 'and-after-shr_u', 'and-after-shr_u-left', 'mul-pow2-left', 'mul-pow2',
  'add-shl-assoc', 'add-const-assoc', 'add-const-assoc-2', 'add-const-assoc-3', 'add-const-assoc-4', 'shl-zero', 'shl-shl', 'shl-add', 'shl-add-left',
  'convert-const', 'convert-const-u', 'mul-two', 'mul-two-right', 'wrap-or-extend', 'wrap-or-extend-right', 'wrap-box-load'))
/** The walk outside the runtime's own tag-test bodies. */
export const HELPERS = rulesOf(named('ptr-type', 'ptr-aux', 'is-null', 'is-nullish'))
/** foldWrappedWords, after watr. */
export const WORDS = rulesOf(named('trunc-convert', 'trunc-convert-u', 'convert-const', 'convert-const-u'))
/** foldLoadCasts, a cast of a value at a time. */
export const LOADS = rulesOf(named('bits-of-load', 'float-of-load', 'bits-of-float', 'wrap-load'))
