/**
 * A loop indexing by numbers the program cannot prove integers runs, when
 * they are integers, as a copy that names each of them afresh from its int32.
 *
 * A ring buffer's cursor read back from its state record (`let p = st.p`), a
 * tap count from a parameter (`N = params.taps || 65`): a number of unknown
 * integrality, so every `buf[idx]` converts it and tests the conversion,
 * `idx - 1` and `(p + 1) % N` stay float arithmetic, and `%` a call. The
 * same loop over names written from `x | 0` gets what a counter written from
 * literals gets: i32 arithmetic and a whole index. Where each such name holds
 * an int32 (`x === (x | 0)`, and not -0: no NaN, fraction or value past 2^31), a
 * copy of the loop runs over fresh names `let x$ = x | 0`, equal to the
 * originals, and the originals take what the copy wrote after it; the loop
 * itself is the other arm. The values, and so what the program does, are
 * the same in both.
 *
 * The names: those whose values reach an element index in the loop through
 * sums, differences, products, remainders, conditionals and bitwise operators, directly
 * (`buf[p]`) or through a name the loop writes (`idx = p`, `idx = idx === 0 ?
 * N - 1 : idx - 1`), and that the loop reads from before it: locals of the
 * function (a parameter or a declaration outside the loop) no closure names.
 * A loop with a closure, a label or a suspension in it is left alone, and one
 * too large to copy twice, and one a `try` guards: a throw from the copy
 * would leave the handler reading the originals, never what the copy wrote.
 *
 * A number of unknown kind is the same case one step earlier: a filter state
 * read back from storage of mixed kinds (`let z1 = s[0]`, `s` a Float64Array
 * or a plain list), a field of a record the summary lost. Every `+` of it
 * asks whether it is a string, and every name it reaches through the loop's
 * writes asks too. Where the loop carries such a name and reads it as a
 * number (an operand of arithmetic or a comparison), writing it only with
 * numbers where its names are numbers, the copy runs where each holds a
 * Number (`typeof x === 'number'`) over fresh names read from the originals,
 * which the guard holds to Numbers: its sums add.
 *
 * So does storage that may be missing: a field of state added on first use
 * (`let keys = state.keys`, a Float64Array or undefined as far as the summary
 * knows) that the loop reads through (`keys[i]`, `keys.length`) and never
 * assigns, or a record it only reads fields of. Every access tests it; where
 * each is present (`x != null`), the copy's fresh names are the storage alone.
 *
 * A cursor the loop steps up by literals (`j++` per pixel, `si = si + 1`),
 * resetting it to a literal or not, advances over the loop by at most its trips
 * times one run's steps: where its entry plus that fits i32, the copy steps its
 * own word. A ring (`qHead++; if (qHead >= QN) qHead = 0`) stays below its bound
 * whatever the trips. A loop under a literal bound counts its trips without a
 * guard of the bound, and a cursor entering from a literal, or from the hull a
 * copy just before left it in, needs no test: such a copy stands alone. A module
 * binding the loop steps, where the loop runs no user code and nothing in it can
 * throw, is a cursor too: the copy steps its word and stores it back after
 * (one the loop resets before every step of it is its scratch, not a cursor:
 * its entry value, perhaps undefined, is never stepped and gets no test).
 * A cursor entering from no literal (`let r = off[g]`, a stream position) counts
 * a step inside a statement's expression too (`const f = stream[r++]`): the
 * copy moves it after the statement, as a step of the word. A cursor stepped
 * by expressions with a literal hull, up or down (`x = x + d` over a byte `d`,
 * `x = (f & 16) ? x + d : x - d`, a 16-bit `x + (w << 16 >> 16)`), advances over
 * one run by the sum of its steps' hulls, one in an arm of an `if` from zero
 * to its step (the arm runs or not): where its entry plus the least and the
 * most of that, times the trips, fit i32, the copy steps its word, the guard
 * testing both ends (a square-tracing walk's `x++`/`x--` under a literal step
 * count: a word of the copy, the loop as written beside it); a literal
 * entry under literal trips needs no copy, the emitter proves such ends itself.
 * A while's counter stepped inside an index (`flags[p++] = f`) and again in a
 * nested run over a byte (`while (rep > 0) { flags[p++] = f; rep-- }`) advances
 * by at most 256 a round: the guard holds the bound below the word's top by
 * that, the copy's counter is a word stepped as wraps, and the stream cursor
 * beside it a word with its budget over the rounds.
 *
 * A derived integer the loop declares once from the counter and from names the
 * guard holds to int32s (`rowC = y * w`, `c = rowC + x`, `xW = x === 0 ? w - 1 :
 * x - 1`), reaching an element index, is a word of the copy where its hull over
 * the loop fits i32; so is an index with a product in it (`hmap[yi * W + xi]`),
 * and an element of an integer typed array at an index the guard proves within
 * its length. A walk of the body in order keeps each name's hull: a test refines
 * its arm, an arm that leaves its sequel with the negation, a conditional
 * assignment joins its arms, a rounding (`Math.floor(fx)`) is an integer where a
 * hull holds it finite. A float the walk holds within a hull (`ysf = y + offY`
 * clamped into [0, H - 1]) truncates to a word within the hull's ends (`ysf |
 * 0`), its stable names held to Numbers; a name visibly a fraction (`lpy /
 * adx`, `0.95`, a float element, a parameter a call passes one) is never held
 * to an int32. An end at the type's extreme (any int32 element, a bit
 * operation's result) stands for no bound: moved by a name it opens, and the
 * hull is none, rather than guarded by a test that holds for a width at most
 * zero and leaves the loop as written, cold. The guard tests every hull's ends
 * and every product's; the copy writes each product as an `imul`, exact
 * there. An index whose hull reaches the extreme (`(row + xi) << 2`) is no
 * element of the proof: a test of it against the length would hold on no run.
 * The typed-bounds versioning then reads an affine index of words, and
 * proves a word of the copy in range, which narrows its arithmetic.
 *
 * A parameter every call of the program's own passes an integer of no name,
 * or an immutable integer module binding (`hblur(img, tmp, W, H, R)` under
 * `const W = 512`), is an integer already; so is a local every write of which
 * selects among such (`r < w ? r : w`, a peel's segment end), which the emitter
 * holds to an int32 as written. A loop under a bound of that kind takes no
 * copy for it: the copy would guard what the emitter proves, and leave the
 * loop as written cold beside it. A sum or difference of integers the emitter
 * may widen, so a bound of one still takes the copy's word.
 *
 * A walk over links (`let j = head[c]; while (j >= 0) { … j = next[j] }` over
 * int32 arrays, the name dead after the loop) is a word of the copy too: every
 * write of it is an integer or a miss, undefined, which ends the walk as
 * written; the copy reads a missed link as -1 and ends there alike.
 *
 * An inner version whose names are int32s of the copy (its words, cursors and
 * guarded names, a name within a hull the guard tests) needs no test of them:
 * the copy holds its fast arm alone, each such alias declared from its name's
 * word (the name's own representation may be wider). A test of its own over
 * what this loop varies (a product of the counter, `py * W + W - 1 <= 2^31 -
 * 1`) is tested at the counter's ends in this guard, and only what no hull
 * answers stays inside. A loop's size counts each inner version as its loop as
 * written.
 *
 * A sum or difference of int32s no hull holds within int32 (`up + 1` over an
 * int32 element, a DP row's cell; `diag + (… ? 0 : 1)` over a name every write
 * of which is an element) is a word of the copy under a test of its wide side
 * before the statement: where the result would leave the word (`up >
 * 2147483646`), the copy leaves for the loop as written, resumed at the copy's
 * counter over the names the copy wrote (a bail, as a JIT deoptimizes), and
 * under the test the sum is exact in the word (`(up + 1) | 0`). The round runs
 * nothing before the test it could not run again: no call but math, no store,
 * no write of a name declared outside, no loop, no user conversion; the
 * statement nothing before the sum but reads. The test reads the wide side as
 * a name (an element read hoists to a declaration before the statement)
 * against the narrow side's literal hull, within half a word; two wide sides
 * have no such test. The recurrence pairs (loop-recurrence.js) are made after,
 * of the copy: a test in the second cell saves the counter one on.
 *
 * A closure's loops are versioned in its own body, its parameters and
 * declarations its locals: the callback a factory returns runs the per-frame
 * loops.
 *
 * @module compile/plan/integral-loops
 */
import { ctx } from '../../ctx.js'
import { frameNode } from '../../function.js'
import { includeModule } from '../../autoload.js'
import { T, I32_MIN, I32_MAX, MUTATE_OPS, TYPEOF, REFS_THROUGH_ARROWS, numberGuard, some, walkAst, cloneNode, extractParams, collectParamName, isReassigned, callArgs, refsName } from '../../ast.js'
import { freshId } from '../../ir.js'
import { cloneWithSubst } from '../../type.js'
import { collectBindings, nodeSize } from './common.js'
import { occursOutside } from './counted-loops.js'
import { isExported } from '../func-exports.js'
import { constIntExpr, forCounterRange, intExprRange } from '../../static.js'
import { MAX_SMALL_FOR_UNROLL } from '../../type/loop-unroll.js'
import { maxAdvanceBudget, minAdvanceBudget } from '../../type/canonical-bounds.js'
import { runsAccessor, runsConversion } from '../../evaluation-effects.js'
import { K, core, hasTag, tagOf, NUMBER } from '../../summary/kind.js'
import { invalidateBodies } from '../analyze.js'
import { invalidateProgramFactsCache } from '../program-facts.js'

const LOOPS = new Set(['for', 'while'])
const TRY = new Set(['try', 'catch', 'finally'])   // the protected body is the first operand
const CLOSED = new Set(['+', '-', '*', '%', 'u-'])
const BITWISE = new Set(['|', '&', '^', '<<', '>>', '>>>', '~'])
const STEPS = new Set(['+=', '-=', '*=', '%='])
const MAX_SIZE = 800

/** Whether `e` is an integer wherever the names in it are (an int32 result, an
 *  integer literal, a length, an element of an integer typed array by
 *  `intArray`, and sums, differences, products, remainders and conditionals
 *  of them); its names go to `out`. */
const integral = (e, out, intArray = NO_ARRAY) => {
  if (typeof e === 'string') { out.add(e); return true }
  if (!Array.isArray(e)) return false
  const op = e[0]
  if (op == null) return typeof e[1] === 'number' && Number.isInteger(e[1])
  if (BITWISE.has(op) || (op === '.' && e[2] === 'length')) return true
  if (op === '[]' && e.length === 3 && intArray(e[1])) return true
  if (op === '()' && e.length === 2) return integral(e[1], out, intArray)
  if (op === '?:') { const a = integral(e[2], out, intArray), b = integral(e[3], out, intArray); return a && b }
  if (!CLOSED.has(op)) return false
  let all = true
  for (let i = 1; i < e.length; i++) if (!integral(e[i], out, intArray)) all = false
  return all
}
const NO_ARRAY = () => false
/** The names a bound made of names and literals by sums, differences and
 *  products reads (`h - 1`, `2 * n`), or null for any other expression: with
 *  each name a Number, it runs no user code. */
const boundTerms = (e, out = []) => {
  if (typeof e === 'string') { out.push(e); return out }
  if (!Array.isArray(e)) return null
  if (e[0] == null) return typeof e[1] === 'number' ? out : null
  if (e[0] === '()' && e.length === 2) return boundTerms(e[1], out)
  if ((e[0] === '+' || e[0] === '-' || e[0] === '*') && e.length === 3) return boundTerms(e[1], out) && boundTerms(e[2], out)
  return null
}
const INT_ELEMENTS = /^(Int8|Uint8|Uint8Clamped|Int16|Uint16|Int32|Uint32)Array$/
// the hull of an element of each integer typed array whose every value is an int32
const ROUNDINGS = new Set(['math.floor', 'math.ceil', 'math.round', 'math.trunc'])
// (a Math function of literals by name, each dispatched in place: jz holds no Math object to index)
const mathOf = (name, a) => name === 'math.floor' ? Math.floor(a[0]) : name === 'math.ceil' ? Math.ceil(a[0]) : name === 'math.round' ? Math.round(a[0]) : name === 'math.trunc' ? Math.trunc(a[0])
  : name === 'math.abs' ? Math.abs(a[0]) : name === 'math.min' ? Math.min(...a) : name === 'math.max' ? Math.max(...a) : null
// what is a fraction for most of its domain: a quotient, a root, a transcendental
const FRACTIONAL = new Set(['math.sqrt', 'math.cbrt', 'math.sin', 'math.cos', 'math.tan', 'math.asin', 'math.acos', 'math.atan', 'math.atan2', 'math.sinh', 'math.cosh', 'math.tanh',
  'math.asinh', 'math.acosh', 'math.atanh', 'math.exp', 'math.expm1', 'math.log', 'math.log2', 'math.log10', 'math.log1p', 'math.pow', 'math.hypot', 'math.random'])
const ELEMENT_RANGES = { Int8Array: [-128, 127], Uint8Array: [0, 255], Uint8ClampedArray: [0, 255], Int16Array: [-32768, 32767], Uint16Array: [0, 65535], Int32Array: [-2147483648, 2147483647] }

/** The values the writes in `node` store, by name (`++`'s is integral), null
 *  for a value it cannot name: one walk answers every name's question. */
const writesIn = (node) => {
  const out = new Map()
  const add = (name, v) => { const l = out.get(name); if (l) l.push(v); else out.set(name, [v]) }
  walkAst(node, { enter: (n, parent) => {
    if (n[0] === '=>') return false
    if (n[0] === 'let' || n[0] === 'const') { for (let i = 1; i < n.length; i++) { const d = n[i]; if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') add(d[1], d[2]) } return }
    if (parent?.[0] === 'let' || parent?.[0] === 'const') return
    if (typeof n[1] !== 'string' || !MUTATE_OPS.has(n[0])) return
    add(n[1], n[0] === '=' ? n[2] : STEPS.has(n[0]) ? n[2] : n[0] === '++' || n[0] === '--' || n[0] === '+1' || n[0] === '-1' ? [null, 1] : BITWISE.has(n[0].slice(0, -1)) ? [null, 0] : null)
  } })
  return out
}
const NO_WRITES = []

const COUNTS = new Set(['++', '--', '+1', '-1'])
/** The literal `name` is stepped up by in `n` (`c++`, `c += k`, `c = c + k`, k ≥ 0), or null. */
const litStep = (n, name) => {
  if (!Array.isArray(n) || n[1] !== name) return null
  if (n[0] === '++' || n[0] === '+1') return 1
  const k = n[0] === '+=' ? n[2] : n[0] === '=' && Array.isArray(n[2]) && n[2][0] === '+' && n[2].length === 3 ? n[2][1] === name ? n[2][2] : n[2][2] === name ? n[2][1] : null : null
  return Array.isArray(k) && k[0] == null && Number.isInteger(k[1]) && k[1] >= 0 ? k[1] : null
}
/** The int32 literal `n` assigns to `name` (`si = 0`, a ring counter's reset), or null. */
const litReset = (n, name) => Array.isArray(n) && n[0] === '=' && n[1] === name && Array.isArray(n[2]) && n[2][0] == null &&
  Number.isInteger(n[2][1]) && Math.abs(n[2][1]) <= 0x7fffffff && !Object.is(n[2][1], -0) ? n[2][1] : null
/** Whether a step of `name` in `node` advances its entry value: one no reset of it
 *  (`qt = 0`) comes before in the same run (`qt = 0; q[qt] = s; qt++` in a loop
 *  whose other rounds leave `qt` alone steps nothing the loop enters with). */
const entryStepped = (node, name, reset = false) => {
  if (!Array.isArray(node) || node[0] === '=>') return false
  if (node[0] === 'postfix') return entryStepped(node[1], name, reset)
  if (node[0] === ';' || node[0] === '{}') {
    let r = reset
    for (let i = 1; i < node.length; i++) { const st = node[i]?.[0] === 'postfix' ? node[i][1] : node[i]; if (entryStepped(st, name, r)) return true; if (litReset(st, name) != null) r = true }
    return false
  }
  if (litStep(node, name) != null) return !reset
  if (litReset(node, name) != null) return false
  for (let i = 1; i < node.length; i++) if (entryStepped(node[i], name, reset)) return true
  return false
}
const BOUND_TESTS = new Set(['<', '<=', '>', '>='])
const ALL_LOOPS = new Set(['for', 'while', 'do', 'for-in', 'for-of'])
const LEAVES = new Set(['break', 'continue', 'return', 'throw'])
/** Place an arm at `p[i]`: a block arm in a block's single-statement slot (`for (…) { for (…) … }`,
 *  prepared as a block holding the loop) is its statement list there, not a block in a block
 *  (which no emitter reads as a block). */
const place = (p, i, node) => { p[i] = Array.isArray(p) && p[0] === '{}' && i === 1 && Array.isArray(node) && node[0] === '{}' ? node[1] : node }
/** Whether every run of `body` steps `counter` up by one or more: a step
 *  (`c++`, `c += k`, k ≥ 1) among the body's own statements, every other write
 *  of it in the body a step too, and no `continue` of this loop's own (one in
 *  an inner loop is that loop's). A loop so stepped runs at most its bound's
 *  count of times. */
const unitStep = (body, counter) => {
  const list = Array.isArray(body) && (body[0] === ';' || body[0] === '{}') ? body.slice(1) : [body]
  const step = (n) => { const st = n?.[0] === 'postfix' ? n[1] : n; return (litStep(st, counter) ?? 0) >= 1 }
  // (a step every time round: a statement of the body, or inside one's expression, `buf[p++] = f`, outside any branch)
  const always = (n) => Array.isArray(n) && n[0] !== '=>' && n[0] !== 'if' && n[0] !== '?:' && n[0] !== '&&' && n[0] !== '||' && n[0] !== '??' && !ALL_LOOPS.has(n[0]) &&
    (step(n) || n.some((c, i) => i > 0 && always(c)))
  if (!list.some(always)) return false
  let ok = true
  const walk = (n, inLoop) => {
    if (!ok || !Array.isArray(n) || n[0] === '=>') return
    if (MUTATE_OPS.has(n[0]) && n[1] === counter && !step(n)) ok = false
    if (n[0] === 'continue' && !inLoop) ok = false
    for (let i = 1; i < n.length; i++) walk(n[i], inLoop || ALL_LOOPS.has(n[0]))
  }
  walk(body, false)
  return ok
}
/** The int32 literal `name` holds where `list[at]` runs: its declaration earlier
 *  in the list (`let j = 0, py = 0`), with no statement between writing it. */
const literalEntry = (list, at, name) => {
  if (!Array.isArray(list) || (list[0] !== ';' && list[0] !== '{}')) return null
  for (let i = at - 1; i >= 1; i--) {
    const st = list[i]
    if (!Array.isArray(st)) continue
    if (st[0] === 'let' || st[0] === 'const' || st[0] === 'var') {
      const d = st.slice(1).find(d => Array.isArray(d) && d[0] === '=' && d[1] === name)
      if (d) return Array.isArray(d[2]) && d[2][0] == null && Number.isInteger(d[2][1]) && Math.abs(d[2][1]) <= 0x7fffffff && !Object.is(d[2][1], -0) ? d[2][1] : null
    }
    if (some(st, n => n[0] === '=>' || MUTATE_OPS.has(n[0]) && n[1] === name)) return null
  }
  return null
}
/** The names a loop tests its counter against (`i < n`, `k + i <= n`: every
 *  name of the side the counter is not on), where the counter is a `for`'s
 *  init name stepped by a constant, or a name a `while` steps by constants alone. */
const boundNames = (loop) => {
  const out = new Set()
  let i = null, test = null
  if (loop[0] === 'for' && loop.length === 5) {
    const [, init, t, step] = loop
    i = Array.isArray(init) && (init[0] === 'let' || init[0] === 'var') && Array.isArray(init[1]) && init[1][0] === '=' ? init[1][1] : null
    if (typeof i !== 'string' || !Array.isArray(step) || step[1] !== i || !(COUNTS.has(step[0]) || step[0] === '+=' || step[0] === '-=')) return out
    test = t
  } else if (loop[0] === 'while') test = loop[1]
  else return out
  if (!Array.isArray(test) || !BOUND_TESTS.has(test[0])) return out
  const names = (e) => { const found = new Set(); integral(e, found); return found }
  const left = names(test[1]), right = names(test[2])
  // a while's counter: the one name of its side the loop writes, by constant steps alone
  if (i == null) {
    const stepped = side => [...side].filter(n => some(loop, m => MUTATE_OPS.has(m[0]) && m[1] === n) && counted(loop, n))
    const l = stepped(left), r = stepped(right)
    i = l.length === 1 && !r.length ? l[0] : r.length === 1 && !l.length ? r[0] : null
    if (i == null) return out
  }
  const side = left.has(i) && !right.has(i) ? right : right.has(i) && !left.has(i) ? left : null
  if (side) for (const n of side) out.add(n)
  return out
}
/** Whether every write of `name` in `loop` steps it by a constant (`x++`, `x += 2`). */
const counted = (loop, name) => !some(loop, n => MUTATE_OPS.has(n[0]) && n[1] === name &&
  !(COUNTS.has(n[0]) || ((n[0] === '+=' || n[0] === '-=') && Array.isArray(n[2]) && n[2][0] == null && Number.isInteger(n[2][1]))))

/** The names whose values reach an element index in `loop` as integers:
 *  read in an index directly, or through a name the loop writes (`writes`,
 *  its writesIn) only with integral values of such names. The names an
 *  index reads, and those their writes read, are gathered first; then a
 *  name with a write that is no integer of the names left goes, until none
 *  does (a name leaving can take its readers with it, never bring one back). */
const indexNames = (loop, writes, intArray) => {
  const names = new Set(), reads = new Map()   // name → the names its writes read, or null for a write no integer
  walkAst(loop, { enter: (n) => { if (n[0] === '[]' && n.length === 3) { const found = new Set(); if (integral(n[2], found)) for (const x of found) names.add(x) } } })
  const work = [...names]
  while (work.length) {
    const name = work.pop(), found = new Set()
    const all = (writes.get(name) ?? NO_WRITES).every(v => v !== null && integral(v, found, intArray))
    reads.set(name, all ? found : null)
    if (all) for (const x of found) if (!names.has(x)) { names.add(x); work.push(x) }
  }
  for (let left = true; left;) {
    left = false
    for (const name of names) {
      const r = reads.get(name)
      if (r === null || [...r].some(x => !names.has(x))) { names.delete(name); left = true }
    }
  }
  return names
}

const ARITH = new Set(['-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>'])
const OPERATED = new Set([...ARITH, '+', 'u-', 'u+', '~', '!', '<', '>', '<=', '>=', '==', '===', '!=', '!==', 'typeof'])
const OPERANDS = new Set([...ARITH, '+', '<', '>', '<=', '>=', 'u-', 'u+', '~'])
// The kinds a `+` or a conversion takes as a Number: no string, no object, no BigInt.
const NOT_NUMERIC = [K.STRING, K.BIGINT, K.TYPED, K.ARRAY, K.OBJECT, K.CLOSURE, K.MAP, K.SET, K.DATE, K.REGEX, K.HASH, K.BUFFER]
const numberish = (k) => k !== 0 && !NOT_NUMERIC.some(t => hasTag(k, t))

const bigintOperand = (e, kindOfExpr) => (Array.isArray(e) && e[0] === 'bigint') || tagOf(core(kindOfExpr(e) ?? 0)) === K.BIGINT

/** Whether `e` is a Number wherever `num` holds for the names it reads (a
 *  Math result, a unary plus, an arithmetic result one Number operand keeps
 *  from being a BigInt, a sum of two Numbers, a conditional of them, a read
 *  the summary holds to a Number: `kindOfExpr`). */
const numeric = (e, num, kindOfExpr) => {
  if (typeof e === 'string') return num(e)
  if (!Array.isArray(e)) return false
  const op = e[0]
  if (op == null) return typeof e[1] === 'number'
  if (op === 'u+') return true
  if (op === '()') return e.length === 2 ? numeric(e[1], num, kindOfExpr) : typeof e[1] === 'string' && e[1].startsWith('math.')
  if (op === '?:') return numeric(e[2], num, kindOfExpr) && numeric(e[3], num, kindOfExpr)
  if (op === '+') return numeric(e[1], num, kindOfExpr) && numeric(e[2], num, kindOfExpr)
  if (op === 'u-' || op === '~') return numeric(e[1], num, kindOfExpr)
  // beside a BigInt (`n >> 7n`) a Number throws: the loop is a BigInt's, no Number's to copy
  if (ARITH.has(op)) return !bigintOperand(e[1], kindOfExpr) && !bigintOperand(e[2], kindOfExpr) &&
    (numeric(e[1], num, kindOfExpr) || numeric(e[2], num, kindOfExpr))
  if (op === '[]' || op === '.') return numberish(kindOfExpr(e))
  return false
}

/** The names the loop reads as numbers (an arithmetic or relational operand)
 *  whose kind the summary cannot hold to a Number, and whose writes in the
 *  loop are Numbers where they are: a state read back from storage of mixed
 *  kinds (`let z1 = s[0]` of a Float64Array or a plain list), a field of a
 *  record the summary lost. Where each holds a Number, a copy of the loop
 *  over fresh names adds and compares them as Numbers. `kindOf` reads the
 *  summary's kind of a name; `outerOk` admits a name the copy can rename. */
const numberNames = (loop, writes, inner, kindOf, kindOfExpr, outerOk) => {
  const used = new Set()
  walkAst(loop, { enter: (n) => { if (n[0] === '=>') return false; if (OPERANDS.has(n[0]) || n[0] === '+=' || n[0] === '-=') for (let i = 1; i < n.length; i++) if (typeof n[i] === 'string') used.add(n[i]) } })
  const names = new Set([...used].filter(n => outerOk(n) && !numberish(kindOf(n)) && hasTag(kindOf(n), K.NUMBER)))
  if (!names.size) return names
  const numbers = new Set([...names, ...inner])   // assumed Numbers until a write shows otherwise
  const num = (n) => numbers.has(n) || (!inner.has(n) && numberish(kindOf(n)))
  for (let left = true; left;) {
    left = false
    for (const n of numbers) {
      const values = writes.get(n) ?? NO_WRITES
      if (values.every(v => v !== null && numeric(v, num, kindOfExpr))) continue
      numbers.delete(n); left = true
    }
  }
  return new Set([...names].filter(n => numbers.has(n)))
}

/** The names the loop reads through (`x[i]`, `x.f`) that may be missing: a
 *  field of state added on first use (`let keys = state.heapKeys`), a typed
 *  array or a list, or null or undefined; or a record the loop only reads
 *  fields of (`c.b0 * x`: an alias of one it wrote through or handed on would
 *  hide its slots). Where each is present, the copy's fresh name is that
 *  storage alone: no test per access. */
const presentNames = (loop, writes, kindOf, outerOk) => {
  const seen = new Set(), recordUse = new Set()   // a record read other than by a field read
  walkAst(loop, { enter: (n, parent, idx) => {
    if (n[0] === '=>') return false
    if ((n[0] === '[]' || n[0] === '.') && typeof n[1] === 'string' && !writes.has(n[1]) && outerOk(n[1])) seen.add(n[1])
    for (let i = 1; i < n.length; i++) {
      if (typeof n[i] !== 'string') continue
      const field = n[0] === '.' && i === 1 && !(parent && (MUTATE_OPS.has(parent[0]) && idx === 1 || parent[0] === '()' && idx === 1))
      if (!field) recordUse.add(n[i])
    }
  } })
  const out = new Set()
  for (const n of seen) {
    const k = kindOf(n), t = tagOf(core(k))
    if (!hasTag(k, K.NULLISH) && !hasTag(k, K.ABSENT)) continue
    if (t === K.TYPED || t === K.ARRAY || (t === K.OBJECT && !recordUse.has(n))) out.add(n)
  }
  return out
}

/** Version the loops of one body, a function's or a closure's
 *  (`params`, the names it binds; `view`, the summary's scope for it; `func`,
 *  the function whose calls bind them, null for a closure): whether any was
 *  rewritten. A closure inside the body is a body of its own. */
const versionBody = (body, params, view, func, programFacts, frame = func ? frameNode(func) : body) => {
  // A closure created by a default or the body can read or write where the
  // copy cannot see. Both belong to this function's capture census.
  const captured = new Set()
  walkAst(frame, { enter: (n) => {
    if (n[0] !== '=>') return
    walkAst(n, { enter: (m) => { for (let i = 1; i < m.length; i++) if (typeof m[i] === 'string') captured.add(m[i]) } })
    return false
  } })
  const locals = new Set(params)
  collectBindings(body, locals)
  // a loop a `try` of the body guards: a throw from the copy would hand the
  // handler the originals, never what the copy wrote under names of its own
  const guarded = new Set()
  walkAst(body, { enter: (n) => {
    if (n[0] === '=>') return false
    if (TRY.has(n[0]) && Array.isArray(n[1])) walkAst(n[1], { enter: (m) => { if (m[0] === '=>') return false; if (LOOPS.has(m[0])) guarded.add(m) } })
  } })
  const loops = [], stack = []
  walkAst(body, { enter: node => { if (node[0] === '=>') return false; if (ALL_LOOPS.has(node[0])) stack.push(node) }, exit: (node, parent, idx) => {
    if (!ALL_LOOPS.has(node[0])) return
    stack.pop()
    // Inner copies settle first; the existing size budget includes them when
    // an outer counter needs its own guarded domain.
    // (`enclosing`: the loop around it, which runs it again, reading what it wrote)
    if (LOOPS.has(node[0]) && parent && !guarded.has(node)) loops.push([node, parent, idx, stack[stack.length - 1] ?? null])
  } })
  // a parameter only the program's own calls bind, each to an integer of no name (`off | 0`)
  const sites = func ? programFacts?.callSites.filter(cs => cs.callee === func.name) ?? [] : []
  const integralEntry = (n) => {
    if (!func) return false
    const at = func.sig.params.findIndex(p => p.name === n)
    if (at < 0 || !sites.length || isExported(func) || programFacts.addressTakenNames.has(func.name) || func.defaults?.[n] != null) return false
    return sites.every(cs => { const found = new Set(); return at < cs.argList.length && integral(cs.argList[at], found) && [...found].every(x => moduleInt(x, cs)) })
  }
  // (an argument of an immutable integer module binding the caller leaves unbound, `hblur(img, tmp, W, H, R)` under `const W = 512`: an integer by its value)
  const callerBindings = new Map()
  const moduleInt = (n, cs) => {
    const g = ctx.scope.globals.get(n)
    if (!g || g.mut || !Number.isInteger(g.init)) return false
    const caller = cs.callerFunc
    if (!caller) return true
    let bound = callerBindings.get(caller)
    if (!bound) { bound = new Set((caller.sig?.params ?? []).map(p => p.name)); if (caller.body) collectBindings(caller.body, bound); callerBindings.set(caller, bound) }
    return !bound.has(n)
  }
  // (a parameter some call passes a visible fraction: a float element, a quotient, `0.95`)
  const fractionalEntry = (n, fractional) => {
    if (!func) return false
    const at = func.sig.params.findIndex(p => p.name === n)
    return at >= 0 && sites.some(cs => at < cs.argList.length && fractional(cs.argList[at]))
  }
  // A copy's fresh name holds the value of the name it copies (an int32 the
  // guard proved equal, a Number, present storage, a binding of the copy's
  // own): the summary answers for it as for that name, which the summary saw.
  const origin = new Map()
  const unrenamed = (e) => typeof e === 'string' ? origin.get(e) ?? e : origin.size && Array.isArray(e) ? cloneWithSubst(e, new Map(), origin) : e
  // an element of an integer typed array is an integer (undefined past its end reads NaN, which the copy computes alike)
  // (the summary names a constructor as `new.Int32Array`)
  const ctorOf = (e) => (view?.typedPayloadCtorOfExpr(unrenamed(e)) ?? '').replace(/^new\./, '')
  const intArray = (e) => typeof e === 'string' && INT_ELEMENTS.test(ctorOf(e))
  const kindOf = (n) => view?.kindOf(unrenamed(n)) ?? 0, kindOfExpr = (e) => view?.kindOfExpr(unrenamed(e)) ?? 0
  let bodyWrites = null   // the body's writes, indexed once; a copy adds its own
  const fresh = new Set()  // the copies' own Numbers: int32 aliases and rounded bounds
  // The guards this pass made, by their `if`: a test of names alone (no alias it
  // captures), with its fast arm. An enclosing copy takes the test as its own
  // where the names hold through the loop, and keeps the fast arm alone: the
  // copies of a nest are one, not one per level squared.
  const versions = new Map()
  let rewrote = false
  for (const [loop, parent, idx, enclosing] of loops) {
    if (parent[idx] !== loop) continue
    let size = nodeSize(loop)
    walkAst(loop, { enter: (n) => { if (n[0] === '=>') return false; const v = versions.get(n); if (v) { size -= nodeSize(n) - nodeSize(v.asWritten); return false } } })
    if (size > MAX_SIZE) continue
    // a name the loop around declares anew each time round is dead after this loop
    // unless read after it; one from outside carries to the next time round
    const carried = new Set()
    if (enclosing) collectBindings(enclosing[enclosing[0] === 'for' ? 4 : enclosing[0] === 'while' ? 2 : 1], carried)
    const readAfter = (n) => {
      if (ctx.scope.globals.has(n) && !locals.has(n)) return true
      if (enclosing == null) return occursOutside(body, loop, n)
      if (!carried.has(n)) return true
      // (declared anew each time round: a later statement of the round reads it, or none does)
      const list = enclosing[enclosing[0] === 'for' ? 4 : enclosing[0] === 'while' ? 2 : 1]
      if (parent !== list && !(Array.isArray(list) && list[0] === '{}' && list[1] === parent)) return occursOutside(body, loop, n)
      for (let k = idx + 1; k < parent.length; k++) if (refsName(parent[k], n, REFS_THROUGH_ARROWS)) return true
      return false
    }
    // a jump to a label outside (`continue out`) leaves the copy past what it writes back
    if (some(loop, n => n[0] === '=>' || n[0] === 'label' || n[0] === 'yield' || n[0] === 'await' ||
      ((n[0] === 'break' || n[0] === 'continue') && typeof n[1] === 'string'))) continue
    const inner = new Set()
    collectBindings(loop, inner)
    const loopWrites = writesIn(loop)
    bodyWrites ??= writesIn(body)
    // a name every write of which, anywhere, is an integer of such names is
    // one already; so is a parameter every call passes an integer of none
    const already = (n, seen = new Set()) => {
      if (seen.has(n)) return true
      seen.add(n)
      const values = bodyWrites.get(n) ?? NO_WRITES, found = new Set()
      if (params.has(n) ? !integralEntry(n) : values.length === 0) return false
      return values.every(v => v !== null && integral(v, found, intArray)) && [...found].every(x => already(x, seen))
    }
    // a name the emitter holds to an int32 as written: a parameter every call passes an
    // integer of none, a local every write of which selects among such (a peel's segment
    // end, `r < w ? r : w`) or is an int32 by construction; a sum or difference of them
    // it may widen, and an element it holds only where it proves the read present, so a
    // bound of either takes the copy's word
    const int32Held = (n, seen = new Set()) => {
      if (seen.has(n)) return true
      seen.add(n)
      if (params.has(n)) return integralEntry(n)
      const values = bodyWrites.get(n) ?? NO_WRITES
      return values.length > 0 && values.every(v => selects(v, seen))
    }
    const selects = (e, seen) => typeof e === 'string' ? int32Held(e, seen)
      : !Array.isArray(e) ? false
      : e[0] == null ? Number.isInteger(e[1]) && e[1] >= I32_MIN && e[1] <= I32_MAX
      : e[0] === '?:' && e.length === 4 ? selects(e[2], seen) && selects(e[3], seen)
      : e[0] === '()' && e.length === 3 && (e[1] === 'math.min' || e[1] === 'math.max') && e[2]?.[0] === ',' && e[2].length === 3 ? selects(e[2][1], seen) && selects(e[2][2], seen)
      : e[0] === '()' && e.length === 2 ? selects(e[1], seen)
      : BITWISE.has(e[0]) || (e[0] === '.' && e[2] === 'length')
    // a name the summary knows holds no number (an object key) is never an int32
    const mayBeNumber = (n) => { const k = view?.kindOfExpr(unrenamed(n)); return k == null || hasTag(k, K.NUMBER) || tagOf(core(k)) === K.ANY }
    const isNumberKind = (n) => { const k = view?.kindOfExpr(unrenamed(n)); return k != null && k !== 0 && tagOf(core(k)) === K.NUMBER && !hasTag(k, K.ABSENT) && !hasTag(k, K.NULLISH) }
    const outerOk = (n) => locals.has(n) && !inner.has(n) && !captured.has(n) && !ctx.funcs.names.has(n)
    // The names the copy's guard holds to Numbers (`typeof x === 'number'`):
    // the stable names the loop converts, whose conversion then runs no user
    // code. Null where the loop can run code no such guard rules out (a call,
    // `new`, a getter, a conversion of anything else).
    let quiet
    const quietNames = () => {
      if (quiet !== undefined) return quiet
      // (an operator's result is a primitive, so are a typed element and a local of the body
      // only operators write: converting one runs no user code, which is all this view answers)
      const operated = n => locals.has(n) && !params.has(n) && !captured.has(n) &&
        !!bodyWrites.get(n)?.every(v => Array.isArray(v) && (v[0] == null || OPERATED.has(v[0])))
      const primitive = e => typeof e === 'string' ? g.has(e) || fresh.has(e) || operated(e)
        : Array.isArray(e) && (OPERATED.has(e[0]) || e[0] === '[]' && e.length === 3 && tagOf(core(kindOfExpr(e[1]))) === K.TYPED)
      const g = new Set(), view = { kindOfExpr: e => primitive(e) ? NUMBER : kindOfExpr(e) }
      const guardable = x => typeof x === 'string' && !g.has(x) && !loopWrites.has(x) && !inner.has(x) && mayBeNumber(x) &&
        (outerOk(x) || ctx.scope.globals.has(x) && !locals.has(x) && !captured.has(x))
      for (;;) {
        let found = null
        some(loop, e => {
          const call = e[0] === '?.()' || e[0] === '()' && e.length > 2
          const math = call && e[0] === '()' && typeof e[1] === 'string' && e[1].startsWith('math.')
          if (e[0] === 'new' || call && !math) { found = false; return true }
          if (math ? callArgs(e).every(arg => core(view.kindOfExpr(arg)) === NUMBER) : !runsAccessor(view, e, true) && !runsConversion(view, e, true)) return false
          found = (math ? callArgs(e) : e.slice(1)).filter(guardable)
          return true
        })
        if (found === null) return quiet = g
        if (!found?.length) return quiet = null
        for (const x of found) g.add(x)
      }
    }
    // A module binding supplies the same snapshot as a local only when the
    // whole loop cannot run code that changes it between comparisons.
    const stableBound = n => outerOk(n) || typeof n === 'string' && ctx.scope.globals.has(n) && !locals.has(n) && !loopWrites.has(n) && quietNames() != null
    // A counter's integer-valued updates do not prove its magnitude. Where a
    // stable numeric bound fits i32, round that bound once in a private copy;
    // the shared counter-range proof then includes its final increment. The
    // original bound stays unchanged for uses in the body (including fractions).
    // a bound of stable names, each held to a Number by the guard: one value through the loop
    // (an expression of them, where some term's integrality is unknown: of integers it is one already)
    const stableTerms = (n) => {
      const ns = boundTerms(n)
      return ns?.length && ns.every(x => stableBound(x) && !loopWrites.has(x)) &&
        (typeof n === 'string' || ns.some(x => !already(x) && !intExprRange(x))) ? ns : null
    }
    let counterBound = null
    if (loop[0] === 'for' && loop[1]?.[0] === 'let' && loop[1].length === 2 &&
        loop[1][1]?.[0] === '=' && typeof loop[1][1][1] === 'string' &&
        BOUND_TESTS.has(loop[2]?.[0])) {
      const n = loop[2][2], counter = loop[1][1][1], init = loop[1][1][2]
      const up = loop[2][0][0] === '<', inclusive = loop[2][0].length === 2
      const comparison = up ? '<' : '>', adjust = inclusive ? up ? 1 : -1 : 0
      const direction = up !== inclusive ? 'ceil' : 'floor'
      const rounded = ['()', `math.${direction}`, n]
      const bound = ['>>', adjust ? ['+', rounded, [null, adjust]] : rounded, [null, 0]]
      const range = forCounterRange(loop[1], [comparison, counter, bound], loop[3], counter)
      const values = bodyWrites.get(n)
      const knownBound = intExprRange(n) ?? (!params.has(n) && values?.length === 1 && !isReassigned(body, n) ? intExprRange(values[0]) : null)
      const alreadyBounded = knownBound && forCounterRange(loop[1], loop[2], loop[3], counter, e => e === n ? knownBound : intExprRange(e))
      const terms = stableTerms(n)
      if (loop[2][1] === counter && terms &&
          !captured.has(counter) && !writesIn(loop[4]).has(counter) && init?.[0] == null &&
          range && range.test[0] >= -2147483648 && range.test[1] <= 2147483647 &&
          !alreadyBounded && !intExprRange(n) && !(typeof n === 'string' && int32Held(n)))
        counterBound = { name: n, terms, bound, comparison, testAt: 2, min: -2147483648 - Math.min(0, adjust), max: 2147483647 - Math.max(0, adjust),
          // (the trips: a literal start, a unit step up)
          trip: up && Number.isInteger(init[1]) && (COUNTS.has(loop[3]?.[0]) || loop[3]?.[0] === 'postfix' && COUNTS.has(loop[3][1]?.[0]) || loop[3]?.[0] === '+=' && loop[3][2]?.[0] == null && loop[3][2][1] === 1) && !/^-/.test(loop[3][0] ?? loop[3][1]?.[0]) ? { n, adj: inclusive ? 1 : 0, entry: init[1] } : null }
    }
    // A while counter has an observable entry outside the loop. Capture its
    // word only behind the same exact-entry guard, then reserve room for every
    // positive step before the next comparison (including the final landing).
    if (loop[0] === 'while' && (loop[1]?.[0] === '<' || loop[1]?.[0] === '<=')) {
      const counter = loop[1][1], n = loop[1][2], inclusive = loop[1][0] === '<='
      const terms = stableTerms(n)
      if (typeof counter === 'string' && outerOk(counter) && mayBeNumber(counter) && terms && !intExprRange(n) && !(typeof n === 'string' && int32Held(n))) {
        // (an element of an integer typed array ranges over its type, and a sum, difference or
        // literal product of such over theirs: a byte read bounds a down-counting inner loop's
        // trips, a run of a byte plus one a counter's step)
        const elementRange = (e) => {
          const r = intExprRange(e)
          if (r) return r
          if (!Array.isArray(e)) return null
          if (e[0] === '[]' && e.length === 3 && typeof e[1] === 'string' && intArray(e[1])) return ELEMENT_RANGES[ctorOf(e[1])] ?? null
          if ((e[0] === '+' || e[0] === '-') && e.length === 3) { const a = elementRange(e[1]), b = elementRange(e[2]); return a && b ? (e[0] === '+' ? [a[0] + b[0], a[1] + b[1]] : [a[0] - b[1], a[1] - b[0]]) : null }
          if (e[0] === '*' && e.length === 3) { const k = constIntExpr(e[1]) ?? constIntExpr(e[2]); const a = k != null ? elementRange(constIntExpr(e[1]) != null ? e[2] : e[1]) : null; return a && k != null ? (k >= 0 ? [a[0] * k, a[1] * k] : [a[1] * k, a[0] * k]) : null }
          return null
        }
        const budget = { constInt: constIntExpr, evRange: elementRange, stepRange: elementRange, closureWrites: captured, MUTATE_OPS }
        const advance = maxAdvanceBudget(loop[2], counter, budget)
        if (advance > 0 && advance <= 2147483647) {
          const rounded = ['()', inclusive ? 'math.floor' : 'math.ceil', n]
          // (a counter entering as a literal needs no test of its own word: the copy takes it as read)
          const entry = already(counter) ? literalEntry(parent, idx, counter) : null
          counterBound = { name: n, terms, counter, entry, testAt: 1, comparison: '<',
            bound: ['>>', inclusive ? ['+', rounded, [null, 1]] : rounded, [null, 0]],
            min: -2147483648, max: 2147483647 - advance + (inclusive ? 0 : 1),
            // (the trips: a literal start, at least a unit step up every time round: literal steps, or a rise of at least one by the budget)
            trip: entry != null && (unitStep(loop[2], counter) || (minAdvanceBudget(loop[2], counter, budget) ?? 0) >= 1) ? { n, adj: inclusive ? 1 : 0, entry } : null }
        }
      }
    }
    // State/presence copies belong to leaf loops. A surrounding scan may
    // still need a bounded counter even when its work contains another loop.
    if (!counterBound && some(loop, n => n !== loop && LOOPS.has(n[0]))) continue
    // a module binding the loop cannot change reads as a local would: the copy snapshots it
    // (one the program already holds to an integer range, a constant, needs no copy)
    const stableGlobal = (n) => !outerOk(n) && !inner.has(n) && !locals.has(n) && ctx.scope.globals.has(n) && !intExprRange(n) && stableBound(n)
    const reaching = indexNames(loop, loopWrites, intArray)
    const indexed = [...reaching].filter(n => (outerOk(n) || stableGlobal(n)) && !already(n) && mayBeNumber(n))
    // the names a counter is tested against (`i < n`, n read from a parameter): the
    // counter is an int32 only where they are
    // (not an export's own parameter: the host's value there keeps the boundary's representation;
    // nor a module binding only the counter's test reads: its rounded bound answers that test)
    const testOnly = n => counterBound?.terms.includes(n) && !loop.some((part, i) => i > 0 && i !== counterBound.testAt && refsName(part, n))
    const bounds = [...boundNames(loop)].filter(n => (outerOk(n) || stableGlobal(n) && !testOnly(n)) && !loopWrites.has(n) && !already(n) && mayBeNumber(n) &&
      !(func && isExported(func) && params.has(n)))
    // a cursor the loop moves other than by a constant step (`p = (p + 1) % N`), or a
    // counter's bound of unknown integrality: an index made of names the loop only reads
    // or counts, under a bound that is an integer, is affine over its counters, which the
    // typed-bounds versioning already proves; nor is such an index a Number to copy for
    const names = bounds.length || indexed.some(n => loopWrites.has(n) && !counted(loop, n)) ? [...new Set([...indexed, ...bounds])] : []
    // A walk over links: `while (c >= 0)` over a local the loop writes only as an
    // element of one int32 array (`j = gnext[j]`, a cell's chain of next
    // pointers), last in its round, declared before the loop and dead after it.
    // Its writes are integers or a miss, undefined, which ends the walk as
    // written; the copy's word reads a missed element as -1 and ends there too.
    const linkWalk = (() => {
      if (loop[0] !== 'while' || !Array.isArray(loop[1]) || loop[1].length !== 3 || !Array.isArray(parent) || (parent[0] !== ';' && parent[0] !== '{}')) return null
      const [op, c, lim] = loop[1]
      if (typeof c !== 'string' || !outerOk(c) || !mayBeNumber(c) || !Array.isArray(lim) || lim[0] != null || !(op === '>=' && lim[1] === 0 || op === '>' && lim[1] === -1)) return null
      const list = loop[2]?.[0] === '{}' ? loop[2][1] : loop[2]
      if (!Array.isArray(list) || list[0] !== ';') return null
      const values = loopWrites.get(c)
      if (!values?.length) return null
      let A = null
      for (const v of values) {
        if (!Array.isArray(v) || v[0] !== '[]' || v.length !== 3 || typeof v[1] !== 'string' || !intArray(v[1]) || loopWrites.has(v[1]) || !(outerOk(v[1]) || !locals.has(v[1]) && ctx.scope.globals.has(v[1])) || (A != null && A !== v[1])) return null
        const found = new Set()
        if (!integral(v[2], found) || ![...found].every(x => x === c || already(x))) return null
        A = v[1]
      }
      // (the one write, a statement of the round after which nothing reads the name)
      const at = list.findIndex((st, k) => k > 0 && Array.isArray(st) && st[0] === '=' && st[1] === c)
      if (at < 0 || values.length !== 1 || list.slice(at + 1).some(st => refsName(st, c, REFS_THROUGH_ARROWS))) return null
      if (!parent.slice(1, idx).some(st => Array.isArray(st) && (st[0] === 'let' || st[0] === 'const') && st.slice(1).some(d => Array.isArray(d) && d[0] === '=' && d[1] === c))) return null
      if (parent.slice(idx + 1).some(st => refsName(st, c, REFS_THROUGH_ARROWS))) return null
      return { c, A }
    })()
    if (linkWalk && !names.includes(linkWalk.c)) names.push(linkWalk.c)
    const counters = counterBound?.counter && counterBound.entry != null ? [counterBound.counter] : []
    if (counterBound?.counter && !counters.length && !names.includes(counterBound.counter)) names.push(counterBound.counter)
    let numbers = [...numberNames(loop, loopWrites, inner, kindOf, kindOfExpr, outerOk)].filter(n => !indexed.includes(n))
    // a Number the loop carries (`z1 = x - a1 * y`): what it only reads converts once per use, as it would
    if (!numbers.some(n => loopWrites.has(n))) numbers = []
    const present = [...presentNames(loop, loopWrites, kindOf, outerOk)]
    // (a module array that may be missing: tested once where a cursor or a word of the copy needs the loop to run without a throw)
    const presentGlobals = [...presentNames(loop, loopWrites, kindOf, n => !outerOk(n) && stableGlobal(n))]
    let needPresence = false
    // The trips of a loop as an expression at this loop's entry, where its
    // counter starts at a literal, steps up by one or more every time round and
    // tests a bound of names the loop holds: `max(0, ceil(n) + adj - entry)`.
    // Null where the loop may run on past any such count.
    const tripNames = new Set()
    const tripsOf = (trip) => {
      if (!trip) return null
      const ns = boundTerms(trip.n)
      if (!ns || !ns.every(x => !loopWrites.has(x) && stableBound(x))) return null
      for (const x of ns) tripNames.add(x)
      if (typeof trip.entry !== 'number') for (const x of boundTerms(Array.isArray(trip.entry) && trip.entry[0] === 'u-' ? trip.entry[1] : trip.entry) ?? []) tripNames.add(x)
      const count = ['-', ['+', ['()', 'math.ceil', trip.n], [null, trip.adj]], typeof trip.entry === 'number' ? [null, trip.entry] : cloneNode(trip.entry)]
      return ['()', 'math.max', [',', [null, 0], count]]
    }
    const tripOfLoop = (node, p, i) => {
      if (node[0] === 'while' && (node[1]?.[0] === '<' || node[1]?.[0] === '<=') && typeof node[1][1] === 'string') {
        const c = node[1][1], entry = already(c) ? literalEntry(p, i, c) : null
        return entry != null && !captured.has(c) && unitStep(node[2], c)
          ? { n: node[1][2], adj: node[1][0] === '<=' ? 1 : 0, entry, counter: c } : null
      }
      if (node[0] === 'for' && node.length === 5 && node[1]?.[0] === 'let' && node[1].length === 2 && node[1][1]?.[0] === '=' &&
          typeof node[1][1][1] === 'string' && (node[1][1][2]?.[0] == null && Number.isInteger(node[1][1][2][1]) || stableEntry(node[1][1][2])) &&
          (node[2]?.[0] === '<' || node[2]?.[0] === '<=') && node[2][1] === node[1][1][1] && !writesIn(node[4]).has(node[1][1][1])) {
        const step = node[3]?.[0] === 'postfix' ? node[3][1] : node[3]
        const init = node[1][1][2]
        // (an entry of stable names is the trips' expression: `for (let k = -r; k <= r; k++)` runs 2r + 1 times)
        return (step?.[0] === '++' || step?.[0] === '+1' || step?.[0] === '+=' && step[2]?.[0] == null && step[2][1] === 1) && step[1] === node[1][1][1]
          ? { n: node[2][2], adj: node[2][0] === '<=' ? 1 : 0, entry: init[0] == null ? init[1] : init, counter: node[1][1][1] } : null
      }
      return null
    }
    // an entry of stable names and literals by sums, differences, products and a leading minus
    const stableEntry = (e) => { const ns = boundTerms(Array.isArray(e) && e[0] === 'u-' && e.length === 2 ? e[1] : e); return !!ns && ns.length > 0 && ns.every(x => !loopWrites.has(x) && stableBound(x)) }
    const sum = (terms) => terms.reduce((a, b) => ['+', a, b])
    let resets = null   // the literal resets of the cursor whose advance is being read
    const stepOf = (n) => litStep(n, n[1])
    // A step of `c` inside an expression of the statement `st` (`buf[w++] = v`,
    // `const d = a[r++]`, `const a = s[r++], b = s[r++]`) moves after the
    // statement in the copy, as one step of its word (a step the word's own
    // storage reads as its `| 0`), each occurrence reading the word plus the
    // steps before it: a declaration, an assignment or an expression statement
    // every occurrence of `c` in which is a literal step, none under a
    // conditional operator (an arm may not run) and none in a closure.
    const hoistableStep = (st, c) => {
      const n = Array.isArray(st) && st[0] === 'postfix' ? st[1] : st
      if (!Array.isArray(n) || n[0] === ';' || n[0] === '{}' || n[0] === 'if' || n[0] === 'label' || ALL_LOOPS.has(n[0]) || LEAVES.has(n[0]) || n[0] === 'switch' || n[0] === 'try') return false
      let refs = 0, steps = 0, ok = true
      const walk = (m, cond) => {
        if (!Array.isArray(m)) return
        if (m[0] === '=>') { if (refsName(m, c, REFS_THROUGH_ARROWS)) ok = false; return }
        const branch = m[0] === '&&' || m[0] === '||' || m[0] === '??' || m[0] === '?:'
        for (let k = 1; k < m.length; k++) {
          if (m[k] === c) { refs++; if (cond) ok = false }
          walk(m[k], cond || (branch && k > 1))
        }
        if (MUTATE_OPS.has(m[0]) && m[1] === c) { steps++; if (litStep(m, c) == null) ok = false }
      }
      walk(n, false)
      return ok && steps >= 1 && refs === steps
    }
    // What `c` advances by over one run of `node`, as terms, or null: a step
    // by a non-negative literal, a statement or (`wide`: a cursor entering from
    // no literal, which the emitter's own cursor proofs cannot type) inside one
    // the copy can move it after; a nested loop, its trips times its body's (a
    // version, by the loop as written), none in its test or step; nothing else.
    const perIteration = (node, c, p = null, i = 0, stmt = false, host = null, wide = false) => {
      if (!Array.isArray(node)) return []
      if (node[0] === '=>') return refsName(node, c) ? null : []
      const v = versions.get(node)
      if (v) {
        const t = tripsOf(v.trip)
        if (!t) return refsName(node, c) ? null : []
        const inner = v.advances.get(c) ?? (loopWrites.has(c) ? perIteration(v.loop[v.loop[0] === 'for' ? 4 : 2], c, null, 0, true, null, wide) : [])
        return inner && inner !== RING ? inner.length ? [['*', t, sum(inner)]] : [] : null
      }
      if (LOOPS.has(node[0])) {
        // (a step in the loop's own test or step runs as often as the test does)
        if (refsName(node[node[0] === 'for' ? 2 : 1], c) || node[0] === 'for' && refsName(node[3], c)) return null
        const t = tripsOf(tripOfLoop(node, p, i))
        if (!t) return refsName(node, c) ? null : []
        const inner = perIteration(node[node[0] === 'for' ? 4 : 2], c, null, 0, true, null, wide)
        if (!inner) return null
        return inner.length ? [['*', t, sum(inner)]] : []
      }
      if (node[0] === 'postfix') return perIteration(node[1], c, p, i, stmt, host, wide)
      // (a reset to a literal: no advance, a floor the budget starts from)
      const reset = litReset(node, c)
      if (reset != null) { resets?.push(reset); return [] }
      if (MUTATE_OPS.has(node[0]) && node[1] === c) {
        const k = stepOf(node)
        return k != null && (stmt || wide && host != null && hoistableStep(host, c)) ? k ? [[null, k]] : [] : null
      }
      const list = node[0] === ';' || node[0] === '{}'
      const out = []
      for (let k = 1; k < node.length; k++) {
        const terms = perIteration(node[k], c, node, k, list, list ? node[k] : host, wide)
        if (!terms) return null
        out.push(...terms)
      }
      return out
    }
    // Cursors: a local declared outside the loop that the loop only steps up
    // by literals (`j++` per pixel), integral by every write of it. Its advance
    // over the loop is the trips times one run's; where the entry plus that
    // fits i32, the copy steps its own word (every step a `| 0`, so its
    // storage is the word). A step inside an inner loop counts that loop's
    // trips: an inner copy's, which recorded them, or a loop as written.
    // (a loop under a literal bound counts its trips too: its cursors need no guard of the bound)
    const ownTrip = counterBound?.trip ?? tripOfLoop(loop, parent, idx)
    // whether `c` is declared from an integer literal anywhere in the body
    const literalDecl = (c) => some(body, n => (n[0] === 'let' || n[0] === 'var') && n.slice(1).some(d => Array.isArray(d) && d[0] === '=' && d[1] === c && Array.isArray(d[2]) && d[2][0] == null && Number.isInteger(d[2][1])))
    // the trips as a number where their names are module constants (`for (kx < K)` under `const K = 3`)
    const literalTrips = (e) => {
      const sub = (n) => {
        if (typeof n === 'string') { const g = locals.has(n) ? null : ctx.scope.globals.get(n); return g && !g.mut && typeof g.init === 'number' ? [null, g.init] : n }
        return Array.isArray(n) ? n.map((c, i) => i ? sub(c) : c) : n
      }
      return e == null ? null : numOf(sub(e))
    }
    const trips = tripsOf(ownTrip)
    const cursors = new Map(), cursorTests = [], cursorHulls = new Map(), cursorRange = new Map()
    const cursorEntry = new Map()   // a cursor entering from one literal: the copy's word is declared from it
    // The hull `name` holds within where `list[at]` runs: a literal it was declared
    // or assigned (`let j = 0`), or the hull a version just before left it in (a
    // cursor's floor and its budget's top), with no statement between writing it.
    const entryHull = (list, at, name) => {
      if (!Array.isArray(list) || (list[0] !== ';' && list[0] !== '{}')) return null
      for (let i = at - 1; i >= 1; i--) {
        const st = list[i]
        if (!Array.isArray(st)) continue
        const h = versions.get(st)?.cursorHulls.get(name)
        if (h) return h
        if (st[0] === 'let' || st[0] === 'const' || st[0] === 'var') {
          const d = st.slice(1).find(d => Array.isArray(d) && d[0] === '=' && d[1] === name)
          if (d) { const k = litReset(d, name); return k != null ? [k, k] : null }
        }
        const k = litReset(st, name)
        if (k != null) return [k, k]
        if (some(st, n => n[0] === '=>' || MUTATE_OPS.has(n[0]) && n[1] === name)) return null
      }
      return null
    }
    // The number `e` comes to where its parts are literals, or null.
    const numOf = (e) => {
      if (!Array.isArray(e)) return null
      if (e[0] == null) return typeof e[1] === 'number' ? e[1] : null
      if (e[0] === '()' && e.length === 2) return numOf(e[1])
      if (e[0] === '()' && e.length === 3 && typeof e[1] === 'string' && e[1].startsWith('math.')) {
        const args = e[2]?.[0] === ',' ? e[2].slice(1).map(numOf) : [numOf(e[2])]
        return args.every(v => v != null) ? mathOf(e[1], args) : null
      }
      if (e.length !== 3) return null
      const a = numOf(e[1]), b = numOf(e[2])
      return a == null || b == null ? null : e[0] === '+' ? a + b : e[0] === '-' ? a - b : e[0] === '*' ? a * b : null
    }
    // A ring: every step of `c` in the loop (`c++`, `c += k`, `c = c + k`) is the
    // statement before `if (c >= B) c = L`, B of stable names, L an int32 literal
    // (`qHead++; if (qHead >= QN) qHead = 0`). Whatever the trips, an int32 below B
    // at entry stays within [min(entry, L), B + k).
    const RING = []
    const ring = (c) => {
      let B = null, L = null, k = null, bad = false
      const handled = new Set()
      walkAst(loop, { enter: (n) => {
        if (bad || n[0] === '=>') return false
        if (n[0] !== ';' && n[0] !== '{}') {
          if (MUTATE_OPS.has(n[0]) && n[1] === c && !handled.has(n) && litReset(n, c) == null) bad = true
          return
        }
        for (let i = 1; i < n.length; i++) {
          const st = n[i]?.[0] === 'postfix' ? n[i][1] : n[i], step = Array.isArray(st) ? litStep(st, c) : null
          if (step == null) continue
          handled.add(st); handled.add(n[i])
          const next = n[i + 1]
          const arm = Array.isArray(next) && next[0] === 'if' && next.length === 3 && Array.isArray(next[1]) && next[1][0] === '>=' && next[1][1] === c ? next[2] : null
          const r = arm == null ? null : litReset(arm, c) ?? (Array.isArray(arm) && arm[0] === '{}' && arm[1]?.[0] === ';' && arm[1].length === 2 ? litReset(arm[1][1], c) : null)
          const ns = r != null ? boundTerms(next[1][2]) : null
          if (step < 1 || r == null || (k != null && k !== step) || (L != null && L !== r) || (B != null && JSON.stringify(B) !== JSON.stringify(next[1][2])) ||
              !ns || !ns.every(x => stableBound(x) && !loopWrites.has(x))) { bad = true; return false }
          k = step; L = r; B = next[1][2]
        }
      } })
      return !bad && k != null ? { k, L, B } : null
    }
    // A module binding the loop steps while it runs no user code and nothing in
    // it can throw: the copy steps its own word and stores it back after the loop.
    const SAFE_OPS = new Set([';', '{}', 'let', 'const', 'if', 'while', 'for', 'do', 'break', 'continue', 'postfix', '?:', '&&', '||', '__eager&&', '__eager||', '!', '~', 'u-', 'u+',
      '+', '-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>', '<', '>', '<=', '>=', '==', '===', '!=', '!==', '=', '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^=', '<<=', '>>=', '>>>=', '++', '--', '+1', '-1', 'typeof', '[]', '.', '()', 'str'])
    const cannotThrow = () => quietNames() != null && !some(loop, n => {
      if (n[0] == null || n[0] === 'str') return false
      if (!SAFE_OPS.has(n[0])) return true
      if (n[0] === '()') return !(typeof n[1] === 'string' && n[1].startsWith('math.')) && n.length !== 2
      if (n[0] === '.') return n[2] !== 'length' || typeof n[1] !== 'string'
      if (n[0] === '[]') { const k = typeof n[1] === 'string' ? kindOf(n[1]) : 0; return !(typeof n[1] === 'string' && (present.includes(n[1]) || presentGlobals.includes(n[1]) || view?.typedPayloadCtorOfExpr(unrenamed(n[1])) && !hasTag(k, K.NULLISH) && !hasTag(k, K.ABSENT))) }
      return false
    })
    const globalCursor = (g) => !locals.has(g) && !inner.has(g) && loopWrites.has(g) && !captured.has(g) && !ctx.funcs.names.has(g) && mayBeNumber(g)
    const own_ = loop[0] === 'for' ? loop[1]?.[1]?.[1] : counterBound?.counter ?? ownTrip?.counter
    for (const c of [...locals, ...(some(loop, n => MUTATE_OPS.has(n[0]) && typeof n[1] === 'string' && ctx.scope.globals.has(n[1]) && !locals.has(n[1])) && cannotThrow() ? [...ctx.scope.globals.keys()].filter(globalCursor) : [])]) {
      const global = !locals.has(c)
      if (!loopWrites.has(c) || !(global || outerOk(c)) || c === own_ || names.includes(c) || !(global || already(c)) || !mayBeNumber(c)) continue
      // (a module binding every step of which follows a reset is the loop's scratch, not what it enters with)
      if (global && !entryStepped(loop[loop[0] === 'for' ? 4 : 2], c)) continue
      resets = []
      // an int32 at entry, and not -0, with room for its advance: an entry within a
      // hull answers that itself, a reset puts the floor at the higher of the two
      const entry = global ? null : entryHull(parent, idx, c)
      // (a cursor declared from a literal is an int32 of the emitter's own where its
      // steps are literals: a copy for its steps inside expressions would change
      // nothing; a loop of literal trips unrolls or proves its own ends at emission,
      // where a guard per entry would only stand between its taps. A while's trips
      // the budget alone bounds are the plan's: the emitter holds no cursor of it)
      const budgeted = loop[0] === 'while' && counterBound?.trip != null
      const wide = !global && literalTrips(trips) == null && (budgeted || (!entry && !literalDecl(c)))
      const terms = perIteration(loop[loop[0] === 'for' ? 4 : 2], c, null, 0, true, null, wide)
      const budget = trips && terms?.length ? true : false, r = budget ? null : ring(c)
      if (!budget && !r) continue
      if (refsName(loop[loop[0] === 'for' ? 2 : 1], c) || loop[0] === 'for' && refsName(loop[3], c)) continue
      const floor = resets.length ? Math.max(...resets) : null
      if (entry && entry[0] === entry[1]) cursorEntry.set(c, entry[0])
      if (r) {
        for (const x of boundTerms(r.B)) tripNames.add(x)
        cursorTests.push(['<', c, r.B], ['<=', ['+', r.B, [null, r.k]], [null, 2147483647]])
        cursorRange.set(c, [entry ? [null, Math.min(entry[0], r.L)] : ['()', 'math.min', [',', c, [null, r.L]]], ['-', ['()', 'math.ceil', r.B], [null, 1]]])
      } else {
        const base = entry ? [null, floor != null ? Math.max(entry[1], floor) : entry[1]] : floor != null ? ['()', 'math.max', [',', c, [null, floor]]] : c
        const top = ['+', base, ['*', trips, sum(terms)]], at = numOf(top)
        if (at != null && at > 2147483647) continue
        cursorRange.set(c, [entry ? [null, floor != null ? Math.min(entry[0], floor) : entry[0]] : floor != null ? ['()', 'math.min', [',', c, [null, floor]]] : c, top])
        if (at == null) cursorTests.push(['<=', top, [null, 2147483647]])
        // (what the loop leaves the cursor within, for a loop after it)
        if (entry && at != null) cursorHulls.set(c, [floor != null ? Math.min(entry[0], floor) : entry[0], at])
      }
      cursors.set(c, terms ?? RING)
      if (global) needPresence = true
      if (global) cursorTests.push(['&&', numberGuard(c), ['&&', ['===', c, ['|', c, [null, 0]]], ['||', ['!==', c, [null, 0]], ['>', ['/', [null, 1], c], [null, 0]]]]])
      else if (!entry) cursorTests.push(['&&', ['>=', c, [null, -2147483648]], ['||', ['!==', c, [null, 0]], ['>', ['/', [null, 1], c], [null, 0]]]])
    }
    resets = null
    // Derived integers: a name the loop declares once from the counter, from
    // stable names the guard holds to int32s and from such names before it, by
    // sums, differences, products, remainders and conditionals, reaching an
    // element index (`rowC = y * w`, `c = rowC + x`, `xW = x === 0 ? w - 1 :
    // x - 1`); and an index of such names with a product in it (`hmap[yi * W +
    // xi]`). A walk of the body in order keeps each name's hull where it runs,
    // an expression of what the guard reads: the counter from its entry to the
    // bound less one, a stable name as itself, a word within one signed word, a
    // conditional's arms by their least and most, a product by its corners; a
    // test refines its arm (`if (row >= 0 && row < H)`), an arm that leaves
    // the sequel with its negation (`if (xi < 1 || xi >= W - 1) break`), a
    // conditional assignment joins its arms (`if (x1 > W - 1) x1 = W - 1`), a
    // nested loop loses what it writes. Where the hull fits i32 the copy takes
    // the name or the index as its word (`| 0`, the identity there), each
    // product in it an `imul` (exact there), so its storage is i32 and an index
    // of words is affine in the counter for the typed-bounds versioning. The
    // guard tests the ends of every such hull and of every product in it.
    // (no element of a typed array: one past the end reads NaN, which a word takes to zero;
    // an invariant product, `py * w` in an element loop, stays the versioning's slot)
    const lit = (v) => [null, v], isLit = (e) => Array.isArray(e) && e[0] == null && typeof e[1] === 'number'
    const same = (a, b) => a === b || Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b)
    // An end at the type's extreme (an int32 element's, a bit operation's) stands
    // for no bound: moved by anything but a literal it is open, and the hull is
    // none (a test of it would hold for a width of one at most).
    const open = (x, hi) => isLit(x) ? (hi ? x[1] >= I32_MAX : x[1] <= I32_MIN)
      : Array.isArray(x) && x[0] === '()' && (x[1] === 'math.max' || x[1] === 'math.min') && ((x[1] === 'math.max') === hi ? open(x[2][1], hi) || open(x[2][2], hi) : open(x[2][1], hi) && open(x[2][2], hi))
    const opened = (a, b) => a == null || b == null || !isLit(a) && (open(b, true) || open(b, false)) || !isLit(b) && (open(a, true) || open(a, false))
    const add = (a, b) => isLit(a) && isLit(b) ? lit(a[1] + b[1]) : isLit(b) && b[1] === 0 ? a : isLit(a) && a[1] === 0 ? b : opened(a, b) ? null : ['+', a, b]
    const sub = (a, b) => isLit(a) && isLit(b) ? lit(a[1] - b[1]) : isLit(b) && b[1] === 0 ? a : opened(a, b) ? null : ['-', a, b]
    const mul = (a, b) => isLit(a) && isLit(b) ? lit(a[1] * b[1]) : isLit(a) && a[1] === 0 || isLit(b) && b[1] === 0 ? lit(0) : isLit(a) && a[1] === 1 ? b : isLit(b) && b[1] === 1 ? a : opened(a, b) ? null : ['*', a, b]
    const neg = (a) => a == null ? null : isLit(a) ? lit(-a[1]) : ['u-', a]
    // (the extreme absorbs the least of ends above the floor, the most below the ceiling)
    // (a literal end the other's span answers is the least or most itself: `min(0, max(x, 0))` is 0)
    const least = (a, b) => a == null || b == null ? null : isLit(a) && isLit(b) ? lit(Math.min(a[1], b[1])) : same(a, b) ? a
      : isLit(a) && span(b)[0] >= a[1] ? a : isLit(b) && span(a)[0] >= b[1] ? b : isLit(a) && span(b)[1] <= a[1] ? b : isLit(b) && span(a)[1] <= b[1] ? a : ['()', 'math.min', [',', a, b]]
    const most = (a, b) => a == null || b == null ? null : isLit(a) && isLit(b) ? lit(Math.max(a[1], b[1])) : same(a, b) ? a
      : isLit(a) && span(b)[1] <= a[1] ? a : isLit(b) && span(a)[1] <= b[1] ? b : isLit(a) && span(b)[0] >= a[1] ? b : isLit(b) && span(a)[0] >= b[1] ? a : ['()', 'math.max', [',', a, b]]
    const whole = (h) => h != null && h[0] != null && h[1] != null
    const point = (h) => whole(h) && same(h[0], h[1])
    const counter = own_
    // the counter runs from its entry to the bound less one (a literal bound's trips stand for it)
    const counterHull = () => {
      if (typeof counter !== 'string') return null
      if (counterBound) {
        // (to the bound less one, or to the bound itself under `<=`)
        if (counterBound.comparison !== '<' && counterBound.comparison !== '<=') return null
        const entry = counterBound.trip ? lit(counterBound.trip.entry) : loop[0] === 'while' && unitStep(loop[2], counter) ? counter : null
        return entry == null ? null : [entry, counterBound.comparison === '<' ? sub(cloneNode(counterBound.bound), lit(1)) : cloneNode(counterBound.bound)]
      }
      if (!ownTrip) return null
      const n = intExprRange(ownTrip.n)
      return n && typeof ownTrip.entry === 'number' ? [lit(ownTrip.entry), lit(n[1] + ownTrip.adj - 1)] : null
    }
    const env = new Map()   // name → its hull where the walk stands, null for none known
    const words = new Map(), used = new Set(), prods = [], floats = new Set()   // decl name → hull; guard names the hulls read; product hulls; names hulls read as floats
    const guardable = (n) => !loopWrites.has(n) && !inner.has(n) && mayBeNumber(n) && (outerOk(n) || stableGlobal(n)) && !(func && isExported(func) && params.has(n))
    // An int32 of the copy: the counter, a cursor, a word, a name the guard holds
    // to one, an i32 module binding, or a local every write of which is an
    // integer of such names (no typed element: one past the end is NaN).
    // `leaves` collects the stable names the guard must hold for that.
    // A value visibly a fraction for most of its domain (`lpy / adx`, `0.5`,
    // `math.sqrt(d)`, a sum, difference, product or arm with one in it), or a
    // name any write of which is: the guard holds no such name to an int32,
    // as its test would fail where the loop runs.
    // (`foreign`: an argument of a call to this function, in its caller's scope: a
    // local there is another binding, unknown here; a module binding is the same)
    const fractional = (e, seen = new Set(), foreign = false) => {
      if (typeof e === 'string') {
        if (!locals.has(e)) { const g = ctx.scope.globals.get(e); return g != null && typeof g.init === 'number' && !Number.isInteger(g.init) }
        if (foreign || seen.has(e)) return false
        seen.add(e)
        if (params.has(e)) return fractionalEntry(e, (a) => fractional(a, seen, true))
        return (bodyWrites.get(e) ?? NO_WRITES).some(v => v != null && fractional(v, seen))
      }
      if (!Array.isArray(e)) return false
      const op = e[0]
      if (op == null) return typeof e[1] === 'number' && !Number.isInteger(e[1])
      if (op === '/') return true
      if (op === '[]' && e.length === 3 && typeof e[1] === 'string') return /^(new\.)?Float(32|64)Array$/.test(view?.typedPayloadCtorOfExpr(unrenamed(e[1])) ?? '')
      if (op === '()' && e.length === 2) return fractional(e[1], seen, foreign)
      if (op === '()' && e.length === 3 && typeof e[1] === 'string') return FRACTIONAL.has(e[1]) || (e[1] === 'math.abs' || e[1] === 'math.min' || e[1] === 'math.max') && (e[2]?.[0] === ',' ? e[2].slice(1) : [e[2]]).some(a => fractional(a, seen, foreign))
      if (op === '+' || op === '-' || op === '*' || op === 'u-') return e.slice(1).some(a => fractional(a, seen, foreign))
      if (op === '?:') return fractional(e[2], seen, foreign) || fractional(e[3], seen, foreign)
      return false
    }
    const intHere = (n, leaves, seen) => {
      if (n === counter || names.includes(n) || cursors.has(n) || words.has(n) || used.has(n)) return true
      if (!locals.has(n) && ctx.scope.globals.get(n)?.type === 'i32') return true
      if (guardable(n)) { if (fractional(n)) return false; leaves?.add(n); return true }
      if (!locals.has(n)) return false
      if (seen.has(n)) return true
      seen.add(n)
      const values = bodyWrites.get(n) ?? NO_WRITES, found = new Set()
      if (params.has(n) ? !integralEntry(n) : values.length === 0) return false
      // (a rounding of any number is an integer or not finite: a hull the walk
      // bounds, a test's arm, holds the name finite there)
      if (!values.every(v => v !== null && (rounding(v) || integral(v, found)))) return false
      for (const x of found) if (!intHere(x, leaves, seen)) return false
      return true
    }
    const rounding = (v) => Array.isArray(v) && v[0] === '()' && v.length === 3 && ROUNDINGS.has(v[1])
    const isIntName = (n, leaves = null) => intHere(n, leaves instanceof Set ? leaves : null, new Set())
    const guardLeaves = (leaves) => { for (const x of leaves) if (!names.includes(x) && !used.has(x)) used.add(x) }
    const intExpr = (e) => { const f = new Set(); return integral(e, f) && [...f].every(isIntName) }
    const varies = (e) => { let v = false; walkAst(e, { enter: n => { for (const x of n) if (typeof x === 'string' && (x === counter || loopWrites.has(x) || inner.has(x))) v = true } }); return v }
    // (every read of `name` an element index, or affine in one)
    const onlyIndexed = (name, decl) => {
      let ok = true
      const walk = (n, inIdx) => {
        if (!ok || n === decl) return
        if (n === name) { if (!inIdx) ok = false; return }
        if (!Array.isArray(n) || n[0] === 'str') return
        if (n[0] === '[]' && n.length === 3) { walk(n[1], false); walk(n[2], true); return }
        if (n[0] === '=>') { if (refsName(n, name, REFS_THROUGH_ARROWS)) ok = false; return }
        const affine = inIdx && (n[0] === '+' || n[0] === '-') && n.length === 3
        for (let i = 1; i < n.length; i++) walk(n[i], affine)
      }
      walk(loop[loop[0] === 'for' ? 4 : 2], false)
      return ok
    }
    const invariantProduct = (e) => Array.isArray(e) && (e[0] === '*' && e.length === 3 && !isLit(e[1]) && !isLit(e[2]) && !varies(e) ||
      e.slice(1).some(invariantProduct))
    const hasProduct = (e) => Array.isArray(e) && (e[0] === '*' && e.length === 3 && !isLit(e[1]) && !isLit(e[2]) || e.slice(1).some(hasProduct))
    // the hull of `e`, its products' hulls to `ps`
    const hullOf = (e, ps = null) => {
      if (typeof e === 'string') {
        if (e === counter) return counterHull()
        if (env.has(e)) return isIntName(e) ? env.get(e) : null
        if (loopWrites.has(e) || inner.has(e)) return null
        const r = intExprRange(e)
        if (r && Number.isFinite(r[0]) && Number.isFinite(r[1]) && !loopWrites.has(e)) return [lit(r[0]), lit(r[1])]
        return isIntName(e) ? [e, e] : null
      }
      if (!Array.isArray(e)) return null
      const op = e[0]
      if (op == null) return Number.isInteger(e[1]) && e[1] >= I32_MIN && e[1] <= I32_MAX ? [e, e] : null
      if (op === '()' && e.length === 2) return hullOf(e[1], ps)
      // (an element of an integer typed array the guard proves present: its index within the length)
      if (op === '[]' && e.length === 3 && typeof e[1] === 'string' && intArray(e[1]) && !loopWrites.has(e[1]) && (outerOk(e[1]) || !locals.has(e[1]) && ctx.scope.globals.has(e[1]))) {
        const k = kindOf(e[1])
        if ((hasTag(k, K.NULLISH) || hasTag(k, K.ABSENT)) && !present.includes(e[1]) && !presentGlobals.includes(e[1])) return null
        const range = ELEMENT_RANGES[ctorOf(e[1])], ix = hullOf(e[2], ps)
        if (!range || !whole(ix)) return null
        // (an index whose hull reaches an int32's extreme, `(row + xi) << 2`, is no element the guard can prove: no test that cannot hold)
        if (span(ix[0])[1] < 0 || span(ix[1])[0] >= I32_MAX) return null
        if (!(span(ix[0])[0] >= 0)) ps?.push(['test', ['>=', ix[0], lit(0)]])
        ps?.push(['test', ['<', ix[1], ['.', e[1], 'length']]])
        return [lit(range[0]), lit(range[1])]
      }
      if (op === 'u-' && e.length === 2) { const a = hullOf(e[1], ps); return a && [neg(a[1]), neg(a[0])] }
      // (the least and most of two hulls; a rounding of a hull's ends, monotone; an imul as a product; a whole hull through `>> 0`)
      if (op === '()' && e.length === 3 && typeof e[1] === 'string') {
        if ((e[1] === 'math.min' || e[1] === 'math.max') && e[2]?.[0] === ',' && e[2].length === 3) {
          const a = hullOf(e[2][1], ps), b = hullOf(e[2][2], ps)
          return whole(a) && whole(b) ? e[1] === 'math.min' ? [least(a[0], b[0]), least(a[1], b[1])] : [most(a[0], b[0]), most(a[1], b[1])] : null
        }
        if (ROUNDINGS.has(e[1])) { const a = hullOf(e[2], ps), r = (x) => isLit(x) ? lit(mathOf(e[1], [x[1]]) + 0) : ['()', e[1], x]; return whole(a) ? [r(a[0]), r(a[1])] : null }
        if (e[1] === 'math.imul' && e[2]?.[0] === ',' && e[2].length === 3) return hullOf(['*', e[2][1], e[2][2]], ps)
        return null
      }
      if (op === '>>' && e.length === 3 && isLit(e[2]) && e[2][1] === 0) { const a = hullOf(e[1], ps); return whole(a) && fits(a) ? a : [lit(I32_MIN), lit(I32_MAX)] }
      // (a signed shift right by k of any int32 lies within 32 - k bits: `x << 16 >> 16` is an int16)
      if (op === '>>' && e.length === 3 && isLit(e[2]) && (e[2][1] & 31) >= 1) { const k = e[2][1] & 31; return [lit(I32_MIN >> k), lit(I32_MAX >> k)] }
      // (a cursor stepped inside an expression, `a[r++]`: the hull its budget holds it within)
      if (op === 'postfix' && e.length === 2 && Array.isArray(e[1]) && typeof e[1][1] === 'string' && cursors.has(e[1][1]) && litStep(e[1], e[1][1]) != null) return hullOf(e[1][1], ps)
      if ((op === '++' || op === '+1' || op === '+=') && typeof e[1] === 'string' && cursors.has(e[1]) && litStep(e, e[1]) != null) { const a = hullOf(e[1], ps); return whole(a) ? [add(a[0], lit(litStep(e, e[1]))), add(a[1], lit(litStep(e, e[1])))] : null }
      if (op === '~' && e.length === 2) return [lit(I32_MIN), lit(I32_MAX)]
      if (op === '?:' && e.length === 4) { const a = hullOf(e[2], ps), b = hullOf(e[3], ps); return a && b ? [least(a[0], b[0]), most(a[1], b[1])] : null }
      if (e.length !== 3) return null
      if (op === '&') { const m = isLit(e[1]) ? e[1][1] : isLit(e[2]) ? e[2][1] : null; return m != null && m >= 0 && m <= I32_MAX ? [lit(0), lit(m)] : [lit(I32_MIN), lit(I32_MAX)] }
      // (a truncated float the walk holds within a hull, `(ysf | 0)` after `if (ysf < 0.0) ysf = 0.0; if (ysf > H - 1) ysf = H - 1`:
      // the ends truncated, each tested within int32 where the guard can; else any int32)
      if (op === '|' && isLit(e[2]) && e[2][1] === 0 && ps) {
        const a = floatHull(e[1]), tr = (x) => isLit(x) ? lit(Math.trunc(x[1]) + 0) : ['()', 'math.trunc', x]
        const h = whole(a) ? [tr(a[0]), tr(a[1])] : null
        if (h && fits(h)) {
          if (!(span(h[0])[0] >= I32_MIN)) ps.push(['test', ['>=', h[0], lit(I32_MIN)]])
          if (!(span(h[1])[1] <= I32_MAX)) ps.push(['test', ['<=', h[1], lit(I32_MAX)]])
          return h
        }
      }
      if (op === '|' || op === '^' || op === '<<' || op === '>>') return [lit(I32_MIN), lit(I32_MAX)]
      if (op === '>>>') { const k = isLit(e[2]) ? e[2][1] & 31 : 0; return k >= 1 ? [lit(0), lit(2 ** (32 - k) - 1)] : null }
      const a = hullOf(e[1], ps), b = hullOf(e[2], ps)
      if (!a || !b) return null
      if (op === '+') return [add(a[0], b[0]), add(a[1], b[1])]
      if (op === '-') return [sub(a[0], b[1]), sub(a[1], b[0])]
      // (a remainder keeps the dividend's sign, within the divisor's magnitude: a literal's, or the most of a hull's ends)
      if (op === '%') {
        if (!whole(b)) return null
        const m = isLit(b[0]) && isLit(b[1]) ? lit(Math.max(Math.abs(b[0][1]), Math.abs(b[1][1])) - 1) : sub(most(['()', 'math.abs', b[0]], ['()', 'math.abs', b[1]]), lit(1))
        return a[0] && isLit(a[0]) && a[0][1] >= 0 ? [lit(0), m] : [neg(m), m]
      }
      if (op !== '*' || !whole(a) || !whole(b)) return null
      let h
      if (point(a) && isLit(a[0])) h = a[0][1] >= 0 ? [mul(a[0], b[0]), mul(a[0], b[1])] : [mul(a[0], b[1]), mul(a[0], b[0])]
      else if (point(b) && isLit(b[0])) h = b[0][1] >= 0 ? [mul(b[0], a[0]), mul(b[0], a[1])] : [mul(b[0], a[1]), mul(b[0], a[0])]
      else {
        const corners = point(a) ? [mul(a[0], b[0]), mul(a[0], b[1])] : point(b) ? [mul(b[0], a[0]), mul(b[0], a[1])]
          : [mul(a[0], b[0]), mul(a[0], b[1]), mul(a[1], b[0]), mul(a[1], b[1])]
        h = [corners.reduce(least), corners.reduce(most)]
      }
      if (ps && !(isLit(e[1]) || isLit(e[2]))) ps.push(h)
      return h
    }
    // A float's hull: a literal, a name's where the walk stands (an integer's is one),
    // sums and differences by their ends, the least and most of a conditional's arms
    const floatHull = (e) => {
      if (typeof e === 'string') {
        if (env.has(e) || e === counter) return env.has(e) ? env.get(e) : counterHull()
        if (loopWrites.has(e) || inner.has(e)) return null
        const r = intExprRange(e)
        if (r && Number.isFinite(r[0]) && Number.isFinite(r[1])) return [lit(r[0]), lit(r[1])]
        // (a stable Number, one the summary holds to a Number already: a value of unknown kind
        // would read through a coercion in the guard)
        // (nor an export's own parameter: the host's value keeps the boundary's representation)
        if (!(!inner.has(e) && isNumberKind(e) && (outerOk(e) || stableGlobal(e))) || func && isExported(func) && params.has(e)) return null
        // (its hull is itself, as a float, unless an int32 already)
        if (!(names.includes(e) || cursors.has(e) || words.has(e) || used.has(e) || !locals.has(e) && ctx.scope.globals.get(e)?.type === 'i32' || locals.has(e) && already(e))) floats.add(e)
        return [e, e]
      }
      if (!Array.isArray(e)) return null
      const op = e[0]
      if (op == null) return typeof e[1] === 'number' && Number.isFinite(e[1]) ? [e, e] : null
      if (op === '()' && e.length === 2) return floatHull(e[1])
      if (op === '()' && e.length === 3 && (e[1] === 'math.min' || e[1] === 'math.max') && e[2]?.[0] === ',' && e[2].length === 3) {
        const a = floatHull(e[2][1]), b = floatHull(e[2][2])
        return a && b ? e[1] === 'math.min' ? [least(a[0], b[0]), least(a[1], b[1])] : [most(a[0], b[0]), most(a[1], b[1])] : null
      }
      if (op === '?:' && e.length === 4) { const a = floatHull(e[2]), b = floatHull(e[3]); return a && b ? [least(a[0], b[0]), most(a[1], b[1])] : null }
      if (op === 'u-' && e.length === 2) { const a = floatHull(e[1]); return a && [neg(a[1]), neg(a[0])] }
      if ((op === '+' || op === '-' || op === '*') && e.length === 3) {
        const a = floatHull(e[1]), b = floatHull(e[2])
        if (!a || !b) return null
        if (op === '+') return [add(a[0], b[0]), add(a[1], b[1])]
        if (op === '-') return [sub(a[0], b[1]), sub(a[1], b[0])]
        if (!whole(a) || !whole(b)) return null
        const corners = [mul(a[0], b[0]), mul(a[0], b[1]), mul(a[1], b[0]), mul(a[1], b[1])]
        return [corners.reduce(least), corners.reduce(most)]
      }
      // (a quotient by a literal: the ends divided, in order)
      if (op === '/' && e.length === 3 && isLit(e[2]) && e[2][1] !== 0 && Number.isFinite(e[2][1])) {
        const a = floatHull(e[1]), d = e[2][1], div = (x) => isLit(x) ? lit(x[1] / d) : ['/', x, lit(d)]
        return whole(a) ? d > 0 ? [div(a[0]), div(a[1])] : [div(a[1]), div(a[0])] : null
      }
      // (an integer by construction: a word, a remainder, an element, a rounding)
      if (BITWISE.has(op) || op === '%' || op === '[]' || op === '()' && ROUNDINGS.has(e[1])) return hullOf(e)
      return null
    }
    const fits = (h) => h?.[0] === 'test' || whole(h) && !(isLit(h[0]) && h[0][1] < I32_MIN) && !(isLit(h[1]) && h[1][1] > I32_MAX)
    // the guard holds every stable name a hull reads to an int32, unless it is one already
    // (a float read by a hull is held to a Number)
    const accept = (hs) => {
      const take = (x) => {
        if (typeof x !== 'string') return
        if (floats.has(x)) { if (!numbers.includes(x) && !names.includes(x) && !used.has(x)) numbers.push(x); return }
        if (guardable(x) && !(names.includes(x) || cursors.has(x) || locals.has(x) && !ctx.scope.globals.has(x) && already(x))) used.add(x)
      }
      for (const h of hs) walkAst(h, { enter: n => { if (n[0] === '()') { walkAst(n[2], { enter: m => { for (const x of m) take(x) } }); return false } for (const x of n) take(x) } })
    }
    // a test's refinement of a name's hull in the arm it holds in
    const CMP = { '<': '<', '<=': '<=', '>': '>', '>=': '>=', '===': '===', '==': '===' }
    const FLIP = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '===': '===' }
    const NEG = { '<': '>=', '<=': '>', '>': '<=', '>=': '<', '!==': '===', '!=': '===' }
    const refine = (c, truth) => {
      if (!Array.isArray(c)) return
      const op = c[0]
      if (op === '!' && c.length === 2) return refine(c[1], !truth)
      if (/&&$/.test(op) && c.length === 3) { if (truth) { refine(c[1], true); refine(c[2], true) } return }
      if (/\|\|$/.test(op) && c.length === 3) { if (!truth) { refine(c[1], false); refine(c[2], false) } return }
      if (c.length !== 3) return
      let o = truth ? CMP[op] : NEG[op]
      if (!o) return
      let [, x, y] = c
      if (!(typeof x === 'string' && env.has(x))) { if (!(typeof y === 'string' && env.has(y))) return; [x, y] = [y, x]; o = FLIP[o] }
      // (an integer's bound is the next integer within; a float's, the bound itself)
      const int = isIntName(x), b = int ? hullOf(y) : floatHull(y)
      if (!b) return
      const exact = intExpr(y), ceil = (e) => exact ? e : ['()', 'math.ceil', e], floor = (e) => exact ? e : ['()', 'math.floor', e]
      const h = env.get(x) ?? [null, null]
      let lo = h[0], hi = h[1]
      if (o === '<') { if (b[1]) { const t = int ? sub(ceil(b[1]), lit(1)) : b[1]; hi = hi ? least(hi, t) : t } }
      else if (o === '<=') { if (b[1]) { const t = int ? floor(b[1]) : b[1]; hi = hi ? least(hi, t) : t } }
      else if (o === '>') { if (b[0]) { const t = int ? add(floor(b[0]), lit(1)) : b[0]; lo = lo ? most(lo, t) : t } }
      else if (o === '>=') { if (b[0]) { const t = int ? ceil(b[0]) : b[0]; lo = lo ? most(lo, t) : t } }
      else { lo = b[0] ? (lo ? most(lo, b[0]) : b[0]) : lo; hi = b[1] ? (hi ? least(hi, b[1]) : b[1]) : hi }
      env.set(x, [lo, hi])
    }
    // (a test an int32 answers already is left out: a word's end, the least of
    // ends above the range's floor, the most of ends below its ceiling)
    const span = (e) => {
      if (typeof e === 'string') return e === counter ? [counterHull()?.[0]?.[1] ?? -Infinity, I32_MAX] : names.includes(e) || used.has(e) || words.has(e) || cursors.has(e) ? [I32_MIN, I32_MAX] : [-Infinity, Infinity]
      if (!Array.isArray(e)) return [-Infinity, Infinity]
      if (e[0] == null) return [e[1], e[1]]
      if (e[0] === '>>' || e[0] === '|') return [I32_MIN, I32_MAX]
      if (e[0] === '()' && e.length === 3 && e[2]?.[0] === ',' && (e[1] === 'math.min' || e[1] === 'math.max')) {
        const a = span(e[2][1]), b = span(e[2][2])
        return e[1] === 'math.min' ? [Math.min(a[0], b[0]), Math.min(a[1], b[1])] : [Math.max(a[0], b[0]), Math.max(a[1], b[1])]
      }
      if (e[0] === '()' && e.length === 3 && (e[1] === 'math.ceil' || e[1] === 'math.floor' || e[1] === 'math.trunc')) return span(e[2])
      if (e[0] === '+' && e.length === 3) { const a = span(e[1]), b = span(e[2]); return [a[0] + b[0], a[1] + b[1]] }
      if (e[0] === '-' && e.length === 3) { const a = span(e[1]), b = span(e[2]); return [a[0] - b[1], a[1] - b[0]] }
      if (e[0] === 'u-' && e.length === 2) { const a = span(e[1]); return [-a[1], -a[0]] }
      return [-Infinity, Infinity]
    }
    const wraps = []   // [node, index, the expression as written]: what the copy takes as a word
    // An inner version whose names are int32s of this copy (its words, cursors
    // and guarded names, a name within a hull the guard tests) needs no test of
    // them: the copy holds its fast arm reading those names, and tests the rest
    // (presence, hulls) where any is left. An index entering nonnegative is read
    // off its hull's floor, tested once here.
    const absorbs = new Map()   // version node → { subst: alias → name, extra: tests of this copy }
    const int32Now = (n) => {
      if (n === counter || names.includes(n) || used.has(n) || cursors.has(n) || words.has(n) || !locals.has(n) && ctx.scope.globals.get(n)?.type === 'i32') return true
      const leaves = new Set()
      if (!isIntName(n, leaves)) return false
      const h = env.has(n) ? env.get(n) : loopWrites.has(n) || inner.has(n) ? null : hullOf(n)
      if (!h || !fits(h)) return false
      prods.push(h); accept([h]); guardLeaves(leaves)
      return true
    }
    const absorb = (s, v) => {
      if (!v.test || !v.conj) return
      const subst = new Map(), extra = []
      for (const t of v.conj.nameTests) { if (!int32Now(t.n)) return; subst.set(t.alias, t.n) }
      for (const t of [...v.conj.numberTests, ...v.conj.typeTests]) if (!int32Now(t.n)) return
      for (const t of v.conj.movingTests) {
        const h = env.has(t.n) ? env.get(t.n) : hullOf(t.n)
        if (!h?.[0] || !int32Now(t.n)) return
        if (!(span(h[0])[0] >= 0)) extra.push(['>=', h[0], lit(0)])
      }
      for (const t of v.conj.boundPosTests) {
        const h = hullOf(t.n)
        if (!h?.[0] || !int32Now(t.n)) return
        if (!(span(h[0])[0] > 0)) extra.push(['>', h[0], lit(0)])
      }
      // A residual test of the inner copy (a hull's end within int32, an index
      // within a length) over what this loop varies holds for every round where
      // it holds at the ends of its hull here: tested once in this guard, by this
      // loop's stable names. The copy then holds the inner copy alone, one nest
      // for every later pass (the typed-bounds versioning reads a nest, not a
      // test between its loops).
      const lift = (t, out) => {
        // (a test capturing an alias declared around the inner copy stays with it)
        if (!Array.isArray(t) || some(t, n => MUTATE_OPS.has(n[0]))) return false
        if (!varies(t)) { out.push(t); return true }
        if (t.length !== 3 || !BOUND_TESTS.has(t[0]) || varies(t[2])) return false
        const ps = [], h = hullOf(t[1], ps)
        if (!whole(h)) return false
        // (a hull's end names the counter for its entry value, which the guard reads)
        const moves = (e) => { let v = false; walkAst(e, { enter: n => { for (const x of n) if (typeof x === 'string' && x !== counter && (loopWrites.has(x) || inner.has(x))) v = true } }); return v }
        const end = t[0] === '<=' || t[0] === '<' ? h[1] : h[0]
        if (moves(end)) return false
        const more = []
        // (a product in it within int32 at its corners; an element's index within its length)
        for (const p of ps) {
          if (p[0] === 'test') { if (moves(p[1])) return false; more.push(p[1]); continue }
          if (!whole(p) || moves(p[0]) || moves(p[1])) return false
          more.push(['>=', p[0], lit(I32_MIN)], ['<=', p[1], lit(I32_MAX)])
        }
        more.push([t[0], end, t[2]])
        for (const m of more) {
          if (isLit(m[2])) { const sp = span(m[1]), k = m[2][1]; if (m[0] === '<=' ? sp[1] <= k : m[0] === '<' ? sp[1] < k : m[0] === '>=' ? sp[0] >= k : sp[0] > k) continue }
          out.push(m)
        }
        return true
      }
      const rest = [], lifted = [], seen = new Set(extra.map(t => JSON.stringify(t)))
      for (const t of v.conj.rest) if (!lift(cloneWithSubst(t, new Map(), subst), lifted)) rest.push(t)
      for (const t of lifted) { const k = JSON.stringify(t); if (!seen.has(k)) { seen.add(k); extra.push(t) } }
      for (const t of extra) accept([t])
      absorbs.set(s, { subst, extra, rest })
    }
    const leaves = (s) => Array.isArray(s) && (LEAVES.has(s[0]) || (s[0] === ';' || s[0] === '{}') && leaves(s[s.length - 1]))
    const forget = (s) => { for (const n of writesIn(s).keys()) if (env.has(n) || inner.has(n) || outerOk(n)) env.set(n, null) }
    const join = (a, b) => {
      if (!a) return b; if (!b) return a
      const out = new Map()
      for (const k of new Set([...a.keys(), ...b.keys()])) { const x = a.get(k), y = b.get(k); out.set(k, x && y && a.has(k) && b.has(k) ? [least(x[0], y[0]), most(x[1], y[1])] : null) }
      return out
    }
    // the words of an expression in index position: one with a product in it
    const indexWords = (e) => {
      walkAst(e, { enter: (n, p, i) => {
        if (n[0] === '=>') return false
        // (an invariant product in an index is the typed-bounds versioning's slot, as in a declaration)
        if (n[0] !== '[]' || n.length !== 3 || !Array.isArray(n[2]) || BITWISE.has(n[2][0]) || !hasProduct(n[2]) || invariantProduct(n[2]) || !intArray(n[1]) && !view) return
        const found = new Set(), leaves = new Set()
        if (!integral(n[2], found) || ![...found].every(x => isIntName(x, leaves))) return
        const ps = [], h = hullOf(n[2], ps)
        if (!fits(h) || !ps.every(fits)) return
        wraps.push([n, 2, n[2]]); prods.push(...ps); accept([h, ...ps]); guardLeaves(leaves)
      } })
    }
    // A cursor the loop moves by expressions with a literal hull, up or down
    // (`x = x + d` over a byte `d`, `x -= d`, `x = (f & 16) ? x + d : x - d`, a
    // 16-bit `x + (w << 16 >> 16)`): its advance over one run is the sum of its
    // steps' hulls, each a statement of the body (one in an arm of an `if` runs
    // or not: from zero to its step), and over the loop that times the trips
    // (a count the emitter would unroll takes no cursor). Where its entry
    // plus the least and the most of that fit i32 (the guard tests both), the
    // copy steps its word (every step a `| 0`). A step in a nested loop, in the
    // loop's test, or inside another expression ends the candidacy. Each step
    // reads the walk's hulls where it stands: an element it reads is a word
    // whose presence the guard tests.
    const stepCands = new Map()   // name → { lo, hi }: the advance so far over one run
    const stepFeeds = new Set()   // the names the candidates' steps read: declared once from an element, words of the copy
    if (trips) for (const c of locals) {
      if (!loopWrites.has(c) || !outerOk(c) || c === own_ || names.includes(c) || cursors.has(c) || !mayBeNumber(c) || !already(c)) continue
      if (refsName(loop[loop[0] === 'for' ? 2 : 1], c) || loop[0] === 'for' && refsName(loop[3], c)) continue
      // (literal trips from a literal entry: the emitter unrolls the loop or proves the ends itself, a guard
      // per entry would only stand between the taps of an unrolled nest; from an entry of a range, the copy's word)
      if (literalTrips(trips) != null && (literalTrips(trips) <= MAX_SMALL_FOR_UNROLL || entryHull(parent, idx, c) != null)) continue
      stepCands.set(c, { lo: 0, hi: 0 })
      for (const v of loopWrites.get(c)) if (v != null) walkAst(v, { enter: (n) => { if (n[0] === '=>') return false; for (const x of n) if (typeof x === 'string' && inner.has(x)) stepFeeds.add(x) } })
    }
    const endCands = (node) => { if (stepCands.size) for (const n of writesIn(node).keys()) stepCands.delete(n) }
    // the change a write makes to `c`: a literal step, `c + e`, `e + c`, `c - e`, a conditional of such, `c` itself
    const delta = (rhs, c) => rhs === c ? lit(0) : !Array.isArray(rhs) ? null
      : rhs[0] === '+' && rhs.length === 3 ? rhs[1] === c ? rhs[2] : rhs[2] === c ? rhs[1] : null
      : rhs[0] === '-' && rhs.length === 3 && rhs[1] === c ? ['u-', rhs[2]]
      : rhs[0] === '?:' && rhs.length === 4 ? (() => { const a = delta(rhs[2], c), b = delta(rhs[3], c); return a && b ? ['?:', rhs[1], a, b] : null })() : null
    const stepHull = (st, c) => {
      const n = st[0] === 'postfix' ? st[1] : st
      const k = litStep(n, c)
      if (k != null) return [k, k]
      if (n[0] === '--' || n[0] === '-1') return [-1, -1]
      const e = n[0] === '+=' ? n[2] : n[0] === '-=' ? ['u-', n[2]] : n[0] === '=' ? delta(n[2], c) : null
      if (e == null) return null
      const ps = [], h = hullOf(e, ps)
      if (!whole(h) || !isLit(h[0]) || !isLit(h[1]) || !ps.every(fits)) return null
      // (a step of half a word or more, a truncation of any number: no budget of two such fits)
      if (h[1][1] - h[0][1] >= 2 ** 31) return null
      if (ps.length) { prods.push(...ps); accept(ps); if (ps.some(x => x[0] === 'test')) needPresence = true }
      return [h[0][1], h[1][1]]
    }
    // A sum or difference of int32s no hull holds within int32 (`up + 1` over an
    // int32 element, `diag + (… ? 0 : 1)` over a name every write of which is an
    // element): the copy tests the wide side before the statement and leaves for
    // the loop as written where the result would leave the word (`if (up >
    // 2147483646) { j$ = j; bail = 1; break }`), then takes the word (`(up + 1) |
    // 0`, exact under the test). The loop as written resumes at the copy's
    // counter, over the names the copy wrote back: so the round runs nothing
    // before the test it could not run again (no call but math, no store, no
    // write of a name declared outside, no loop, no user conversion or accessor),
    // and the statement nothing before the sum but reads. The test reads the wide
    // side as a name (an expression hoists to a declaration before the statement)
    // against the narrow side's literal hull, within half a word; two wide sides
    // have no such test. Under `optimize.coldTrap` the resumption throws too.
    const bails = []   // { list, at, pre: statements before `list[at]`, swaps: [node, i, name, as written] }
    const siteSums = new Set()
    let slot = null, prefixImpure = false, bailFlag = null, bailSave = null
    const counterName = loop[0] === 'for' && loop[1]?.[0] === 'let' ? loop[1][1]?.[1] : null
    const bailable = loop[0] === 'while' || loop[0] === 'for' && (loop[1] == null || MUTATE_OPS.has(loop[1]?.[0]) ||
      typeof counterName === 'string' && loop[1].length === 2 && loop[1][1][0] === '=' && !writesIn(loop[4]).has(counterName))
    const impure = (st, target = null) => some(st, n => n[0] === '=>' || n[0] === 'new' || n[0] === '?.()' || n[0] === 'yield' || n[0] === 'await' || n[0] === 'delete' ||
      n[0] === '()' && n.length === 3 && !(typeof n[1] === 'string' && n[1].startsWith('math.') && n[1] !== 'math.random') ||
      MUTATE_OPS.has(n[0]) && n !== target && !(typeof n[1] === 'string' && inner.has(n[1])) ||
      ALL_LOOPS.has(n[0]) || LEAVES.has(n[0]) || runsAccessor(view, n, true) || runsConversion(view, n, true))
    const FULL = () => [lit(I32_MIN), lit(I32_MAX)]
    // an int32 as every write leaves it: a literal, an element of an int array the guard proves
    // present (one read before the loop at a literal index), a bit operation, a conditional, a
    // minimum or a maximum of such, a sum the copy tests, or a name so written
    const int32Valued = (e, ps, seen = new Set(), before = false) => {
      if (typeof e === 'string') {
        if (e === counter || names.includes(e) || cursors.has(e) || words.has(e) || used.has(e)) return true
        if (!locals.has(e)) { const g = ctx.scope.globals.get(e); return g != null && (g.type === 'i32' || !g.mut && Number.isInteger(g.init) && g.init >= I32_MIN && g.init <= I32_MAX) }
        if (params.has(e)) return integralEntry(e)
        if (seen.has(e)) return true
        seen.add(e)
        const values = bodyWrites.get(e) ?? NO_WRITES, inLoop = loopWrites.get(e) ?? NO_WRITES
        return values.length > 0 && values.every(v => v !== null && int32Valued(v, ps, seen, !inLoop.includes(v)))
      }
      if (!Array.isArray(e)) return false
      const op = e[0]
      if (op == null) return Number.isInteger(e[1]) && e[1] >= I32_MIN && e[1] <= I32_MAX
      if (op === '()' && e.length === 2) return int32Valued(e[1], ps, seen, before)
      if (op === '[]') {
        if (before) { const ix = e.length === 3 ? hullOf(e[2]) : null; if (!whole(ix) || !isLit(ix[0]) || !isLit(ix[1])) return false }
        const h = hullOf(e, ps)
        return whole(h) && fits(h)
      }
      if (op === '?:' && e.length === 4) return int32Valued(e[2], ps, seen, before) && int32Valued(e[3], ps, seen, before)
      if (op === '()' && e.length === 3 && (e[1] === 'math.min' || e[1] === 'math.max') && e[2]?.[0] === ',' && e[2].length === 3) return int32Valued(e[2][1], ps, seen, before) && int32Valued(e[2][2], ps, seen, before)
      if ((op === '+' || op === '-') && e.length === 3) return siteSums.has(e) || wordHull(e, ps, seen) != null
      return BITWISE.has(op) && (op !== '>>>' || isLit(e[2]) && (e[2][1] & 31) >= 1)
    }
    // the hull of a word the copy reads, its ends literal: a word of the copy within its hull, a literal,
    // an element the guard proves present, a name every write of which is an int32, a conditional, a sum or a difference of such within int32
    const wordHull = (e, ps, seen = new Set()) => {
      if (typeof e === 'string') {
        const h = hullOf(e)
        if (whole(h) && fits(h) && isLit(h[0]) && isLit(h[1])) return h
        return int32Valued(e, ps, seen) ? FULL() : null
      }
      if (!Array.isArray(e)) return null
      const op = e[0]
      if (op == null) return Number.isInteger(e[1]) && e[1] >= I32_MIN && e[1] <= I32_MAX ? [e, e] : null
      if (op === '()' && e.length === 2) return wordHull(e[1], ps, seen)
      if (op === '[]') { const h = hullOf(e, ps); return whole(h) && fits(h) && isLit(h[0]) && isLit(h[1]) ? h : null }
      if (op === '?:' && e.length === 4) { const a = wordHull(e[2], ps, seen), b = wordHull(e[3], ps, seen); return a && b ? [least(a[0], b[0]), most(a[1], b[1])] : null }
      if ((op === '+' || op === '-') && e.length === 3) {
        const a = wordHull(e[1], ps, seen), b = wordHull(e[2], ps, seen)
        if (!a || !b) return null
        const h = op === '+' ? [add(a[0], b[0]), add(a[1], b[1])] : [sub(a[0], b[1]), sub(a[1], b[0])]
        return whole(h) && fits(h) ? h : null
      }
      return int32Valued(e, ps, seen) ? FULL() : null
    }
    // `p[i]`, a sum or difference of `st`: its hull within int32 as the copy's word, with the test
    // of its wide side before the statement where the hull leaves int32; null for no word
    const sumSite = (st, p, i) => {
      const e = p[i]
      if (!bailable || !slot || prefixImpure || dead || !Array.isArray(e) || (e[0] !== '+' && e[0] !== '-') || e.length !== 3) return null
      if (impure(st, st[0] === 'let' || st[0] === 'const' ? p : st)) return null
      const ps = [], a = wordHull(e[1], ps), b = wordHull(e[2], ps)
      if (!a || !b || !ps.every(fits)) return null
      const h = e[0] === '+' ? [add(a[0], b[0]), add(a[1], b[1])] : [sub(a[0], b[1]), sub(a[1], b[0])]
      if (!whole(h) || !isLit(h[0]) || !isLit(h[1])) return null
      if (fits(h)) return null
      const take = () => { siteSums.add(e); prods.push(...ps); accept(ps); if (ps.some(x => x[0] === 'test')) needPresence = true }
      // (the narrow side: the literal hull of the smaller span; the other is tested)
      const width = (x) => x[1][1] - x[0][1]
      const right = width(b) <= width(a)
      const [nl, nu] = right ? [b[0][1], b[1][1]] : [a[0][1], a[1][1]], wi = right ? 1 : 2, wide = e[wi]
      if (nu - nl > 2 ** 30) return null
      const top = h[1][1] > I32_MAX, bottom = h[0][1] < I32_MIN, tests = []
      const w = typeof wide === 'string' ? wide : `wide${T}${freshId(ctx)}`
      // (`W + N`: W > MAX - Nu, W < MIN - Nl; `W - N`: W > MAX + Nl, W < MIN + Nu; `N - W`: W < Nu - MAX, W > Nl - MIN)
      if (e[0] === '+') { if (top) tests.push(['>', w, lit(I32_MAX - nu)]); if (bottom) tests.push(['<', w, lit(I32_MIN - nl)]) }
      else if (right) { if (top) tests.push(['>', w, lit(I32_MAX + nl)]); if (bottom) tests.push(['<', w, lit(I32_MIN + nu)]) }
      else { if (top) tests.push(['<', w, lit(nu - I32_MAX)]); if (bottom) tests.push(['>', w, lit(nl - I32_MIN)]) }
      if (!tests.length) return null
      if (!bailFlag) {
        bailFlag = `bail${T}${freshId(ctx)}`
        bailSave = counterName ? `${counterName}${T}at${freshId(ctx)}` : null
        locals.add(bailFlag); if (bailSave) locals.add(bailSave)
      }
      const pre = [], swaps = []
      if (w !== wide) { pre.push(['const', ['=', w, cloneNode(wide)]]); swaps.push([e, wi, w, wide]); locals.add(w) }
      pre.push(['if', tests.reduce((x, y) => ['||', x, y]), ['{}', [';', ...(bailSave ? [['=', bailSave, counterName]] : []), ['=', bailFlag, [null, 1]], ['break']]]])
      bails.push({ list: slot[0], at: slot[1], pre, swaps })
      take()
      return [lit(Math.max(h[0][1], I32_MIN)), lit(Math.min(h[1][1], I32_MAX))]
    }
    let dead = false, arms = 0   // (the arms of `if`s the walk stands in: a step there runs or not)
    const step = (s) => {
      if (dead || !Array.isArray(s)) return
      const op = s[0], v = versions.get(s)
      if (v || ALL_LOOPS.has(op)) {
        if (v) absorb(s, v)
        for (const n of writesIn(s).keys()) env.set(n, v?.cursorHulls.get(n) ? [lit(v.cursorHulls.get(n)[0]), lit(v.cursorHulls.get(n)[1])] : null)
        endCands(s)
        prefixImpure = true
        return
      }
      if (op === ';' || op === '{}') { for (let i = 1; i < s.length; i++) { slot = [s, i]; step(s[i]) } return }
      if (LEAVES.has(op)) { if (s[1] != null) indexWords(s[1]); endCands(s); dead = true; return }
      if (op === 'if') {
        indexWords(s[1])
        endCands(s[1])
        if (impure(s[1])) prefixImpure = true
        const before = new Map(env)
        arms++
        refine(s[1], true); step(s[2])
        const a = dead ? null : new Map(env); dead = false
        env.clear(); for (const [k, h] of before) env.set(k, h)
        refine(s[1], false); if (s[3] != null) step(s[3])
        arms--
        const b = dead ? null : new Map(env); dead = false
        const out = join(a, b)
        env.clear()
        if (out) for (const [k, h] of out) env.set(k, h); else dead = true
        return
      }
      if (op === 'let' || op === 'const') {
        endCands(s)
        for (let i = 1; i < s.length; i++) {
          const d = s[i]
          if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') { if (typeof d === 'string') env.set(d, null); continue }
          const name = d[1], e = d[2]
          indexWords(e)
          const found = new Set(), leaves = new Set(), ok = (Array.isArray(e) || typeof e === 'string') && integral(e, found, intArray) && [...found].every(x => isIntName(x, leaves))
          const trunc = Array.isArray(e) && e[0] === '|' && e.length === 3 && isLit(e[2]) && e[2][1] === 0
          const ps = [], h = ok || trunc ? hullOf(e, ps) : null
          // (a sum no hull holds within int32: the copy tests its wide side and takes the word, an int32
          // of the copy where every other write of the name is one)
          const site = h && fits(h) && ps.every(fits) ? null : sumSite(s, d, 2)
          if (site) {
            env.set(name, site); wraps.push([d, 2, e])
            const more = []
            if ((loopWrites.get(name) ?? NO_WRITES).every(v => v === e || v !== null && int32Valued(v, more)) && more.every(fits)) { words.set(name, site); prods.push(...more); accept(more) }
            continue
          }
          env.set(name, h ?? (ok ? null : floatHull(e)))
          // (a truncation holds its hull by the tests on it, taken here: its name is an int32 already)
          if (trunc && h && ps.length) { if (ps.every(fits)) { prods.push(...ps); accept(ps) } else env.set(name, [lit(I32_MIN), lit(I32_MAX)]) }
          // (a word where the name would otherwise be a Number: a product in it, a word or a guarded name read, an element)
          const needs = hasProduct(e) || e[0] === '[]' || [...found].some(x => x !== counter && (names.includes(x) || words.has(x) || cursors.has(x) || used.has(x) || guardable(x) && !(locals.has(x) && !ctx.scope.globals.has(x) && already(x))))
          if (!h || !needs || !inner.has(name) || !reaching.has(name) && !stepFeeds.has(name) || captured.has(name) || loopWrites.get(name)?.length !== 1 || !mayBeNumber(name) ||
              BITWISE.has(e[0]) || !fits(h) || !ps.every(fits)) continue
          words.set(name, h); wraps.push([d, 2, e]); prods.push(...ps); accept([h, ...ps]); guardLeaves(leaves)
          if (ps.some(x => x[0] === 'test')) needPresence = true
        }
        if (impure(s)) prefixImpure = true
        return
      }
      if (MUTATE_OPS.has(op) && typeof s[1] === 'string') {
        if (s[2] != null) indexWords(s[2])
        // (a sum no hull holds within int32, assigned: the copy tests its wide side and takes the word)
        const held = () => { const f = new Set(), h = integral(s[2], f) && [...f].every(isIntName) ? hullOf(s[2]) : null; return whole(h) && fits(h) }
        const site = op === '=' && !stepCands.has(s[1]) && !cursors.has(s[1]) && !held() ? sumSite(s, s, 2) : null
        if (impure(s)) prefixImpure = true
        if (site) { env.set(s[1], site); wraps.push([s, 2, s[2]]); return }
        const cand = stepCands.get(s[1])
        if (cand) {
          const h = (writesIn(s).get(s[1])?.length ?? 0) === 1 ? stepHull(s, s[1]) : null
          // (a step in an arm runs or not: its advance from zero to the step's)
          if (h) { cand.lo += arms ? Math.min(0, h[0]) : h[0]; cand.hi += arms ? Math.max(0, h[1]) : h[1] } else stepCands.delete(s[1])
        }
        if (s[2] != null) for (const n of writesIn(s[2]).keys()) stepCands.delete(n)
        const cur = env.get(s[1]), k = litStep(s, s[1]), r = litReset(s, s[1])
        if (r != null) env.set(s[1], [lit(r), lit(r)])
        else if (k != null) env.set(s[1], cur ? [add(cur[0], lit(k)), add(cur[1], lit(k))] : null)
        else if (op === '=' ) { const f = new Set(); env.set(s[1], integral(s[2], f) && [...f].every(isIntName) ? hullOf(s[2]) : floatHull(s[2])) }
        else if (op === '--' || op === '-1') env.set(s[1], cur ? [sub(cur[0], lit(1)), sub(cur[1], lit(1))] : null)
        else env.set(s[1], null)
        return
      }
      if (op === 'postfix') return step(s[1])
      if (impure(s)) prefixImpure = true
      indexWords(s)
      endCands(s)
      forget(s)
    }
    for (const n of loopWrites.keys()) env.set(n, null)
    if (typeof counter === 'string') env.set(counter, counterHull())
    for (const [c, r] of cursorRange) env.set(c, r)
    // (a version in the body, a loop in it: the prefix is impure from there, as `step` reads)
    step(loop[loop[0] === 'for' ? 4 : 2])
    // (the stepped cursors the walk kept: their ends over the loop, tested where not literal)
    for (const [c, { lo, hi }] of stepCands) {
      if (lo === 0 && hi === 0) continue
      const entry = entryHull(parent, idx, c)
      const top = hi > 0 ? ['+', entry ? lit(entry[1]) : c, ['*', trips, lit(hi)]] : entry ? lit(entry[1]) : c
      const bottom = lo < 0 ? ['+', entry ? lit(entry[0]) : c, ['*', trips, lit(lo)]] : entry ? lit(entry[0]) : c
      const atTop = numOf(top), atBottom = numOf(bottom)
      if (atTop != null && atTop > I32_MAX || atBottom != null && atBottom < I32_MIN) continue
      if (atTop == null) cursorTests.push(['<=', top, lit(I32_MAX)])
      if (atBottom == null) cursorTests.push(['>=', bottom, lit(I32_MIN)])
      if (!entry) cursorTests.push(['||', ['!==', c, lit(0)], ['>', ['/', lit(1), c], lit(0)]])
      cursorRange.set(c, [bottom, top])
      if (entry && entry[0] === entry[1]) cursorEntry.set(c, entry[0])
      if (entry && atTop != null && atBottom != null) cursorHulls.set(c, [atBottom, atTop])
      cursors.set(c, RING)   // (no terms for a loop around: its ends are the tests' alone)
    }
    for (const n of used) names.push(n)
    const presenceTests = needPresence ? presentGlobals.filter(n => !present.includes(n)).map(n => ['!=', n, [null, null]]) : []
    const wordTests = [], seenTests = new Set()
    for (const [lo, hi] of [...words.values(), ...prods, ...[...absorbs.values()].flatMap(a => a.extra.map(t => ['test', t]))]) for (const t of lo === 'test' ? [hi] : [span(lo)[0] >= I32_MIN ? null : ['>=', lo, lit(I32_MIN)], span(hi)[1] <= I32_MAX ? null : ['<=', hi, lit(I32_MAX)]]) {
      if (!t) continue
      const k = JSON.stringify(t)
      if (!seenTests.has(k)) { seenTests.add(k); wordTests.push(t) }
    }
    if (!names.length && !numbers.length && !present.length && !counterBound && !cursors.size && !wraps.length) continue
    // A Number the copy writes gets a name of its own too: a local has one
    // representation, and the original loop keeps the float values the copy
    // does not. The copy's own declarations also get fresh names. Fixed
    // nonnumeric outer values keep their binding, so copying a loop creates
    // no alias of a private string builder. A
    // number (every write an integer) is read by `+`: a plain read would
    // count as an integer use of the loop's own name.
    const written = [...locals].filter(n => loopWrites.has(n) && !inner.has(n) && !captured.has(n) && !ctx.funcs.names.has(n) && mayBeNumber(n) && !already(n))
    const outer = [...new Set([...names, ...counters, ...numbers, ...present, ...written])]
    const own = new Map([...outer, ...inner].map(n => [n, `${n}${T}int${freshId(ctx)}`]))
    for (const n of [...names, ...numbers]) fresh.add(own.get(n))
    // A non-counted index recurrence gets the nonnegative index domain;
    // a positive count closes wrap/decrement recurrences. Readonly offsets
    // retain signed entries. Subsequent writes still need a complete hull.
    const moving = names.filter(n => indexed.includes(n) && loopWrites.has(n) && !counted(loop, n))
    for (const c of cursors.keys()) if (!own.has(c)) { const m = `${c}${T}int${freshId(ctx)}`; own.set(c, m); outer.push(c) }
    // An inner guard whose names the loop holds (its own locals it does not
    // write, module bindings it cannot change, a cursor the loop budgets) is
    // decided once out here: the copy holds the inner fast arm alone, and the
    // loop, the other arm now, the inner loop as written (where the test fails
    // on the loop's own terms the inner copy could still run: that arm is for
    // the values, not the time, and one version of a nest is what every later
    // pass reads).
    // (an alias the inner test captures is declared around it: the copy declares
    // it around this loop instead, under the name the copy gives it)
    const innerTests = [], swapped = [], hoistedAliases = []
    walkAst(loop, { enter: (n, p, i) => {
      if (n[0] === '=>') return false
      const v = versions.get(n)
      if (!v) return
      const hoist = v.names.every(x => (!loopWrites.has(x) && stableBound(x)) || cursors.has(x)), ab = hoist ? null : absorbs.get(n)
      if (!hoist && !ab) return false
      if (hoist) {
        if (v.test) innerTests.push(v.aliases.length ? cloneWithSubst(v.test, new Map(), own) : v.test)
        for (const a of v.aliases) hoistedAliases.push(own.get(a) ?? a)
      }
      // (a Number the inner copy wrote under a name of its own, for the loop as
      // written beside it: alone in this copy, it writes the name itself)
      let fast = v.version
      if (v.undo.size) {
        fast = cloneWithSubst(v.version, new Map(), v.undo)
        const list = fast[1], decl = list[1]
        const self = (d) => Array.isArray(d) && d[0] === '=' && (d[2] === d[1] || Array.isArray(d[2]) && d[2][0] === 'u+' && d[2][1] === d[1])
        for (let k = decl.length - 1; k >= 1; k--) if (self(decl[k])) decl.splice(k, 1)
        if (decl.length === 1) list.splice(1, 1)
        for (let k = list.length - 1; k >= 1; k--) if (self(list[k])) list.splice(k, 1)
      }
      if (ab) {
        // (an alias a dropped test captured is declared from its name's word: the
        // name is an int32 here, and the alias keeps that representation where
        // the name's own may be wider; the other aliases stay declared around)
        const rest = ab.rest
        const kept = v.aliases.filter(a => !ab.subst.has(a))
        const guarded = rest.length ? ['if', rest.reduce((a, b) => ['&&', a, b]), fast, v.asWritten] : fast
        const decls = [...kept.map(a => ['=', a, [null, 0]]), ...[...ab.subst].map(([a, n]) => ['=', a, ['|', n, [null, 0]]])]
        fast = decls.length ? ['{}', [';', ['let', ...decls], guarded]] : guarded
      }
      place(p, i, fast); swapped.push([p, i, v.asWritten])
      return false
    } })
    // (the copy takes each derived integer and each such index as its word, every product in it an imul)
    const imulify = (e) => !Array.isArray(e) || e[0] === 'str' || e[0] === '[]' ? e : e[0] === '*' && e.length === 3 ? ['()', 'math.imul', [',', imulify(e[1]), imulify(e[2])]]
      : e[0] === '?:' && e.length === 4 ? ['?:', e[1], imulify(e[2]), imulify(e[3])] : e.map((x, i) => i ? imulify(x) : x)
    for (const b of bails) for (const [n, i, w] of b.swaps) n[i] = w
    for (const [n, i, e] of wraps) n[i] = ['|', imulify(cloneNode(e)), [null, 0]]
    // (later statements first, so each position stays as the walk saw it)
    for (const b of [...bails].sort((x, y) => y.at - x.at)) b.list.splice(b.at, 0, ...b.pre)
    const copy = cloneWithSubst(loop, new Map(), own)
    // (the walk's word reads a missed link as -1)
    if (linkWalk) {
      const w = own.get(linkWalk.c), a = own.get(linkWalk.A) ?? linkWalk.A
      walkAst(copy, { enter: (n) => {
        if (n[0] === '=>') return false
        if (n[0] === '=' && n[1] === w && Array.isArray(n[2]) && n[2][0] === '[]' && n[2][1] === a) {
          const e = n[2][2]
          n[2] = ['?:', ['&&', ['>=', cloneNode(e), [null, 0]], ['<', cloneNode(e), ['.', a, 'length']]], ['|', n[2], [null, 0]], [null, -1]]
        }
      } })
    }
    for (const [n, i, e] of wraps) n[i] = e
    for (const b of [...bails].sort((x, y) => x.at - y.at)) { b.list.splice(b.at, b.pre.length); for (const [n, i, , e] of b.swaps) n[i] = e }
    for (const [p, i, n] of swapped) place(p, i, n)
    // (the loop as written is the other arm now: every inner version in it is
    // its loop as written too, the fast arm there would run as rarely)
    walkAst(loop, { enter: (n, p, i) => {
      if (n[0] === '=>') return false
      const v = versions.get(n)
      if (!v) return
      place(p, i, v.asWritten)
      return false
    } })
    // the copy steps each cursor's word, and a while's counter's: the guard holds its
    // bound below the word's top by the loop's advance, so no step of it wraps
    if (cursors.size || (loop[0] === 'while' && counters.length)) {
      const words = new Set([...cursors.keys(), ...(loop[0] === 'while' ? counters : [])].map(c => own.get(c)))
      // (a statement stepping a word: by a literal, by an expression, a conditional of such)
      const stepped = (st) => {
        const n = st[0] === 'postfix' ? st[1] : st
        if (!Array.isArray(n) || !words.has(n[1])) return null
        if (stepOf(n) != null) return ['=', n[1], ['|', ['+', n[1], [null, stepOf(n)]], [null, 0]]]
        if (n[0] === '--' || n[0] === '-1') return ['=', n[1], ['|', ['-', n[1], [null, 1]], [null, 0]]]
        if (n[0] === '+=' || n[0] === '-=') return ['=', n[1], ['|', [n[0][0], n[1], n[2]], [null, 0]]]
        if (n[0] === '=' && delta(n[2], n[1]) != null) return ['=', n[1], ['|', n[2], [null, 0]]]
        return null
      }
      // (the literal steps of one word inside a statement's expression, in evaluation
      // order: each occurrence reads the word plus the steps before it, a postfix the
      // value before its own, and one step of their sum follows the statement)
      const hoisted = (st) => {
        const found = []
        walkAst(st, { enter: (n, p, i) => {
          if (n[0] === '=>') return false
          if (n[0] === 'postfix' && Array.isArray(n[1]) && words.has(n[1][1]) && litStep(n[1], n[1][1]) != null) { found.push([p, i, n[1][1], litStep(n[1], n[1][1]), true]); return false }
          if (MUTATE_OPS.has(n[0]) && words.has(n[1]) && litStep(n, n[1]) != null && p !== undefined) found.push([p, i, n[1], litStep(n, n[1]), false])
        } })
        if (!found.length || found.some(f => f[2] !== found[0][2])) return null
        const w = found[0][2]
        let off = 0
        for (const [p, i, , k, post] of found) {
          const at = post ? off : off + k
          p[i] = at ? ['+', w, [null, at]] : w
          off += k
        }
        return ['=', w, ['|', ['+', w, [null, off]], [null, 0]]]
      }
      // (a statement of a list, an arm of an `if`, the body of a loop; in a list, a step inside a statement moves after it)
      walkAst(copy, { enter: (n) => {
        if (n[0] === '=>') return false
        const slots = n[0] === ';' || n[0] === '{}' ? null : n[0] === 'if' ? [2, 3] : n[0] === 'for' ? [4] : n[0] === 'while' ? [2] : []
        for (let k = slots ? 0 : 1; k < (slots ? slots.length : n.length); k++) {
          const i = slots ? slots[k] : k, st = n[i]
          if (!Array.isArray(st)) continue
          const r = stepped(st)
          if (r) { n[i] = r; continue }
          if (slots || st[0] === ';' || st[0] === '{}' || st[0] === 'if' || ALL_LOOPS.has(st[0]) || LEAVES.has(st[0]) || st[0] === 'label') continue
          const after = hoisted(st)
          if (after) n.splice(++k, 0, after)
        }
      } })
    }
    const boundDecl = []
    if (counterBound || cursorTests.length || wordTests.length || wraps.length) includeModule('math')
    if (counterBound) {
      const bound = `${counterBound.terms[0]}${T}bound${freshId(ctx)}`
      fresh.add(bound)
      boundDecl.push(['=', bound, counterBound.bound])
      copy[counterBound.testAt][0] = counterBound.comparison
      copy[counterBound.testAt][2] = bound
    }
    // Capture the word in its fresh alias inside the type-guarded equality.
    // Its exact assignment is visible to flow analysis and is evaluated once.
    // A number, an int32 and not -0: `typeof x === 'number' && x === (x$ = x | 0) && (x !== 0 || 1 / x > 0)`;
    // the type first, so the test converts no object (a key's valueOf runs where the loop reads it);
    // a Number alone: `typeof x === 'number'`, the form whose arm the summary reads as a Number;
    // present: `x != null`
    // (a module binding read for the copy takes the guard of every name the loop converts)
    const quietGuards = [...names, ...counterBound?.terms ?? [], ...tripNames].some(n => !outerOk(n)) ? [...quiet ?? []] : []
    const boundTest = counterBound ? [['&&', ['>=', counterBound.name, [null, counterBound.min]], ['<=', counterBound.name, [null, counterBound.max]]]] : []
    // (an inner test comes after the aliases this one captures: it reads them by the copy's names)
    const typeNames = [...new Set([...counterBound?.terms ?? [], ...tripNames, ...quietGuards])]
    const conj = {
      typeTests: typeNames.map(n => ({ n, test: numberGuard(n) })),
      nameTests: names.map(n => ({ n, alias: own.get(n), test: ['&&', ['&&', numberGuard(n), ['===', n, ['=', own.get(n), ['|', n, [null, 0]]]]], ['||', ['!==', n, [null, 0]], ['>', ['/', [null, 1], n], [null, 0]]]] })),
      movingTests: moving.map(n => ({ n, alias: own.get(n), test: ['>=', own.get(n), [null, 0]] })),
      boundPosTests: moving.length ? bounds.map(n => ({ n, alias: own.get(n), test: ['>', own.get(n), [null, 0]] })) : [],
      numberTests: numbers.map(n => ({ n, test: ['===', ['typeof', n], [null, TYPEOF.number]] })),
      rest: [...boundTest, ...present.map(n => ['!=', n, [null, null]]), ...presenceTests, ...innerTests, ...cursorTests, ...wordTests],
    }
    const tests = [...conj.typeTests.map(t => t.test), ...boundTest, ...conj.nameTests.map(t => t.test), ...conj.movingTests.map(t => t.test), ...conj.boundPosTests.map(t => t.test),
      ...conj.numberTests.map(t => t.test), ...present.map(n => ['!=', n, [null, null]]), ...presenceTests, ...innerTests, ...cursorTests, ...wordTests]
    const test = tests.length ? tests.reduce((a, b) => ['&&', a, b]) : null
    // (a counter enters as its literal; a cursor as its word, an int32 by the guard)
    // (the loop as written runs for the values the guard rejects: cold, with every loop in it;
    // a mark on the node and its body, which a clone carries: type/clone.js carrySite)
    walkAst(loop, { enter: (n) => { if (n[0] === '=>') return false; if (ALL_LOOPS.has(n[0])) { n.cold = true; const b = n[n[0] === 'for' ? 4 : n[0] === 'while' ? 2 : 1]; if (Array.isArray(b)) b.cold = true } } })
    // (`optimize.coldTrap`: the loop as written throws its version's number instead of
    // running, a diagnostic that finds a guard failing on an input the copy was meant for)
    const trap = () => ['{}', [';', ['throw', [null, (ctx.transform.coldTraps = (ctx.transform.coldTraps ?? 0) + 1)]]]]
    // The loop as written again, where the copy left for it: from the copy's counter, over the
    // names the copy wrote; its declarations under names of its own, as any copy's.
    const resumption = () => {
      if (ctx.transform.optimize?.coldTrap) return trap()
      const ren = new Map([...inner].map(n => [n, `${n}${T}cold${freshId(ctx)}`]))
      for (const [n, m] of ren) { locals.add(m); origin.set(m, origin.get(n) ?? n) }
      const r = cloneWithSubst(loop, new Map(), ren)
      if (r[0] === 'for') r[1] = bailSave ? ['let', ['=', ren.get(counterName), bailSave]] : null
      return ['{}', [';', ...outer.filter(n => loopWrites.has(n) && !readAfter(n)).map(n => ['=', n, own.get(n)]), r]]
    }
    // (the declarations first: an enclosing copy reads them there, plan/integral-loops.js `undo`)
    const version = ['{}', [';', ['let', ...boundDecl, ...outer.filter(n => !names.includes(n)).map(n => ['=', own.get(n), counters.includes(n) ? [null, counterBound.entry] : cursors.has(n) ? cursorEntry.has(n) ? [null, cursorEntry.get(n)] : ['|', n, [null, 0]] : already(n) ? ['u+', n] : n])],
      ...(bailFlag ? [['=', bailFlag, [null, 0]]] : []), copy,
      // what the copy wrote under a name of its own, where the body reads it after the loop
      // or a loop around runs it again (a Number every write keeps an integer is renamed too: its sum is the copy's)
      ...outer.filter(n => loopWrites.has(n) && readAfter(n)).map(n => ['=', n, own.get(n)]),
      ...(bailFlag ? [['if', bailFlag, resumption()]] : [])]]
    // (nothing to test, a cursor from a literal: the copy alone, the loop as written for an enclosing version's other arm)
    const asWritten = ctx.transform.optimize?.coldTrap ? trap() : ['{}', [';', loop]]
    const guarded = test ? ['if', test, version, asWritten] : version
    const aliases = [...names.map(n => own.get(n)), ...hoistedAliases, ...(bailFlag ? [bailFlag, ...(bailSave ? [bailSave] : [])] : [])]
    const wrapped = aliases.length ? ['{}', [';', ['let', ...aliases.map(a => ['=', a, [null, 0]])], guarded]] : guarded
    parent[idx] = wrapped
    const found = new Set()
    if (test) walkAst(test, { enter: n => { if (n[0] === 'str') return false; for (let i = 1; i < n.length; i++) if (typeof n[i] === 'string' && n[0] !== '()' && !aliases.includes(n[i])) found.add(n[i]) } })
    const undo = new Map(written.filter(n => !names.includes(n) && !counters.includes(n) && !cursors.has(n) && !numbers.includes(n) && !present.includes(n)).map(n => [own.get(n), n]))
    versions.set(wrapped, { test, version, asWritten, loop, names: [...found], aliases, undo, trip: counterBound?.trip ?? null, advances: cursors, cursorHulls, conj })
    for (const [n, values] of writesIn(version)) { const l = bodyWrites.get(n); if (l) l.push(...values); else bodyWrites.set(n, values) }
    // (the copy's names are the body's locals now: an enclosing loop's copy reads them so)
    for (const [n, m] of own) { locals.add(m); origin.set(m, origin.get(n) ?? n) }
    for (const d of boundDecl) locals.add(d[1])
    rewrote = true
  }
  return rewrote
}

export const versionIntegralLoops = (programFacts) => {
  if (ctx.transform.optimize?.versionIntegralLoops === false) return false
  let changed = false
  for (const func of ctx.funcs.list) {
    if (func.raw || !func.body) continue
    let rewrote = versionBody(func.body, new Set((func.sig?.params ?? []).map(p => p.name)), ctx.summary?.at(func.sig), func, programFacts)
    // A closure's loops are its own (a callback a factory returns runs the
    // per-frame work): its parameters and declarations are its locals.
    walkAst(func.body, { exit: (n) => {
      if (n[0] !== '=>' || !Array.isArray(n[2]) || n[2][0] !== '{}') return
      const params = new Set()
      for (const p of extractParams(n[1])) collectParamName(p, params)
      if (versionBody(n[2], params, ctx.summary?.at(n[1]), null, programFacts, [';', n[1], n[2]])) rewrote = true
    } })
    // rewritten in place: the facts cached for the body describe what it was
    if (rewrote) { invalidateProgramFactsCache(func.body); invalidateBodies([func.body]); changed = true }
  }
  return changed
}
