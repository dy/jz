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
 * resetting it to a literal or not (`if (si >= N) si = 0`, a ring counter),
 * advances over the loop by at most its trips times one run's steps: where its
 * entry plus that fits i32, the copy steps its own word. A loop under a literal
 * bound counts its trips without a guard of the bound, and a cursor entering
 * from a literal, or from the hull a copy just before left it in, needs no test:
 * such a copy stands alone. A derived integer the loop declares once from the
 * counter and from names the guard holds to int32s (`rowC = y * w`, `c = rowC +
 * x`, `xW = x === 0 ? w - 1 : x - 1`), reaching an element index, is a word of
 * the copy where its hull over the loop, an expression the guard tests, fits
 * i32: the typed-bounds versioning then reads an affine index of words.
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
import { maxAdvanceBudget } from '../../type/canonical-bounds.js'
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
const BOUND_TESTS = new Set(['<', '<=', '>', '>='])
const ALL_LOOPS = new Set(['for', 'while', 'do', 'for-in', 'for-of'])
/** Whether every run of `body` steps `counter` up by one or more: a step
 *  (`c++`, `c += k`, k ≥ 1) among the body's own statements, every other write
 *  of it in the body a step too, and no `continue` of this loop's own (one in
 *  an inner loop is that loop's). A loop so stepped runs at most its bound's
 *  count of times. */
const unitStep = (body, counter) => {
  const list = Array.isArray(body) && (body[0] === ';' || body[0] === '{}') ? body.slice(1) : [body]
  const step = (n) => { const st = n?.[0] === 'postfix' ? n[1] : n; return (litStep(st, counter) ?? 0) >= 1 }
  if (!list.some(step)) return false
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
    return sites.every(cs => { const found = new Set(); return at < cs.argList.length && integral(cs.argList[at], found) && !found.size })
  }
  // A copy's fresh name holds the value of the name it copies (an int32 the
  // guard proved equal, a Number, present storage, a binding of the copy's
  // own): the summary answers for it as for that name, which the summary saw.
  const origin = new Map()
  const unrenamed = (e) => typeof e === 'string' ? origin.get(e) ?? e : origin.size && Array.isArray(e) ? cloneWithSubst(e, new Map(), origin) : e
  // an element of an integer typed array is an integer (undefined past its end reads NaN, which the copy computes alike)
  const intArray = (e) => typeof e === 'string' && INT_ELEMENTS.test(view?.typedPayloadCtorOfExpr(unrenamed(e)) ?? '')
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
    if (parent[idx] !== loop || nodeSize(loop) > MAX_SIZE) continue
    // a name the loop around declares anew each time round is dead after this loop
    // unless read after it; one from outside carries to the next time round
    const carried = new Set()
    if (enclosing) collectBindings(enclosing[enclosing[0] === 'for' ? 4 : enclosing[0] === 'while' ? 2 : 1], carried)
    const readAfter = (n) => {
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
    // a name the summary knows holds no number (an object key) is never an int32
    const mayBeNumber = (n) => { const k = view?.kindOfExpr(unrenamed(n)); return k == null || hasTag(k, K.NUMBER) || tagOf(core(k)) === K.ANY }
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
          !alreadyBounded && !intExprRange(n) && !(typeof n === 'string' && integralEntry(n)))
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
      if (typeof counter === 'string' && outerOk(counter) && mayBeNumber(counter) && terms && !intExprRange(n)) {
        const advance = maxAdvanceBudget(loop[2], counter, { constInt: constIntExpr, evRange: intExprRange, closureWrites: captured, MUTATE_OPS })
        if (advance > 0 && advance <= 2147483647) {
          const rounded = ['()', inclusive ? 'math.floor' : 'math.ceil', n]
          // (a counter entering as a literal needs no test of its own word: the copy takes it as read)
          const entry = already(counter) ? literalEntry(parent, idx, counter) : null
          counterBound = { name: n, terms, counter, entry, testAt: 1, comparison: '<',
            bound: ['>>', inclusive ? ['+', rounded, [null, 1]] : rounded, [null, 0]],
            min: -2147483648, max: 2147483647 - advance + (inclusive ? 0 : 1),
            // (the trips: a literal start, at least a unit step up every time round)
            trip: entry != null && unitStep(loop[2], counter) ? { n, adj: inclusive ? 1 : 0, entry } : null }
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
    const counters = counterBound?.counter && counterBound.entry != null ? [counterBound.counter] : []
    if (counterBound?.counter && !counters.length && !names.includes(counterBound.counter)) names.push(counterBound.counter)
    let numbers = [...numberNames(loop, loopWrites, inner, kindOf, kindOfExpr, outerOk)].filter(n => !indexed.includes(n))
    // a Number the loop carries (`z1 = x - a1 * y`): what it only reads converts once per use, as it would
    if (!numbers.some(n => loopWrites.has(n))) numbers = []
    const present = [...presentNames(loop, loopWrites, kindOf, outerOk)]
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
      const count = ['-', ['+', ['()', 'math.ceil', trip.n], [null, trip.adj]], [null, trip.entry]]
      return ['()', 'math.max', [',', [null, 0], count]]
    }
    const tripOfLoop = (node, p, i) => {
      if (node[0] === 'while' && (node[1]?.[0] === '<' || node[1]?.[0] === '<=') && typeof node[1][1] === 'string') {
        const c = node[1][1], entry = already(c) ? literalEntry(p, i, c) : null
        return entry != null && !captured.has(c) && unitStep(node[2], c)
          ? { n: node[1][2], adj: node[1][0] === '<=' ? 1 : 0, entry, counter: c } : null
      }
      if (node[0] === 'for' && node.length === 5 && node[1]?.[0] === 'let' && node[1].length === 2 && node[1][1]?.[0] === '=' &&
          typeof node[1][1][1] === 'string' && node[1][1][2]?.[0] == null && Number.isInteger(node[1][1][2][1]) &&
          (node[2]?.[0] === '<' || node[2]?.[0] === '<=') && node[2][1] === node[1][1][1] && !writesIn(node[4]).has(node[1][1][1])) {
        const step = node[3]?.[0] === 'postfix' ? node[3][1] : node[3]
        return (step?.[0] === '++' || step?.[0] === '+1' || step?.[0] === '+=' && step[2]?.[0] == null && step[2][1] === 1) && step[1] === node[1][1][1]
          ? { n: node[2][2], adj: node[2][0] === '<=' ? 1 : 0, entry: node[1][1][2][1], counter: node[1][1][1] } : null
      }
      return null
    }
    const sum = (terms) => terms.reduce((a, b) => ['+', a, b])
    let resets = null   // the literal resets of the cursor whose advance is being read
    const stepOf = (n) => litStep(n, n[1])
    // What `c` advances by over one run of `node`, as terms, or null: a step in
    // statement position by a non-negative literal; a nested loop, its trips
    // times its body's (a version, by the loop as written); nothing else.
    const perIteration = (node, c, p = null, i = 0, stmt = false) => {
      if (!Array.isArray(node)) return []
      if (node[0] === '=>') return refsName(node, c) ? null : []
      const v = versions.get(node)
      if (v) {
        const t = tripsOf(v.trip)
        if (!t) return refsName(node, c) ? null : []
        const inner = v.advances.get(c) ?? (loopWrites.has(c) ? perIteration(v.loop[v.loop[0] === 'for' ? 4 : 2], c, null, 0, true) : [])
        return inner ? inner.length ? [['*', t, sum(inner)]] : [] : null
      }
      if (LOOPS.has(node[0])) {
        const t = tripsOf(tripOfLoop(node, p, i))
        if (!t) return refsName(node, c) ? null : []
        const inner = perIteration(node[node[0] === 'for' ? 4 : 2], c, null, 0, true)
        if (!inner) return null
        if (node[0] === 'for' && refsName(node[3], c)) return null
        return inner.length ? [['*', t, sum(inner)]] : []
      }
      if (node[0] === 'postfix') return perIteration(node[1], c, p, i, stmt)
      // (a reset to a literal: no advance, a floor the budget starts from)
      const reset = litReset(node, c)
      if (reset != null) { resets?.push(reset); return [] }
      if (MUTATE_OPS.has(node[0]) && node[1] === c) { const k = stepOf(node); return k != null && stmt ? k ? [[null, k]] : [] : null }
      const list = node[0] === ';' || node[0] === '{}'
      const out = []
      for (let k = 1; k < node.length; k++) {
        const terms = perIteration(node[k], c, node, k, list)
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
    const trips = tripsOf(ownTrip)
    const cursors = new Map(), cursorTests = [], cursorHulls = new Map()
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
        const f = Math[e[1].slice(5)]
        return typeof f === 'function' && args.every(v => v != null) ? f(...args) : null
      }
      if (e.length !== 3) return null
      const a = numOf(e[1]), b = numOf(e[2])
      return a == null || b == null ? null : e[0] === '+' ? a + b : e[0] === '-' ? a - b : e[0] === '*' ? a * b : null
    }
    if (trips) for (const c of locals) {
      if (!loopWrites.has(c) || !outerOk(c) || c === (counterBound?.counter ?? ownTrip?.counter) || names.includes(c) || !already(c) || !mayBeNumber(c)) continue
      resets = []
      const terms = perIteration(loop[loop[0] === 'for' ? 4 : 2], c, null, 0, true)
      if (!terms?.length || loop[0] === 'for' && refsName(loop[3], c)) continue
      // an int32 at entry, and not -0, with room for its advance: an entry within a
      // hull answers that itself, a reset puts the floor at the higher of the two
      const entry = entryHull(parent, idx, c), floor = resets.length ? Math.max(...resets) : null
      const base = entry ? [null, floor != null ? Math.max(entry[1], floor) : entry[1]] : floor != null ? ['()', 'math.max', [',', c, [null, floor]]] : c
      const top = ['+', base, ['*', trips, sum(terms)]], at = numOf(top)
      if (at != null && at > 2147483647) continue
      cursors.set(c, terms)
      if (at == null) cursorTests.push(['<=', top, [null, 2147483647]])
      if (!entry) cursorTests.push(['&&', ['>=', c, [null, -2147483648]], ['||', ['!==', c, [null, 0]], ['>', ['/', [null, 1], c], [null, 0]]]])
      // (what the loop leaves the cursor within, for a loop after it)
      else if (at != null) cursorHulls.set(c, [floor != null ? Math.min(entry[0], floor) : entry[0], at])
    }
    resets = null
    if (!names.length && !numbers.length && !present.length && !counterBound && !cursors.size) continue
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
    // Derived integers: a name the loop declares once, by sums, differences,
    // products, remainders and conditionals of the counter, of stable names the
    // guard holds to int32s and of such names before it, that reaches an element
    // index (`rowC = y * w`, `c = rowC + x`, `xW = x === 0 ? w - 1 : x - 1`).
    // Its hull over the loop is an expression of what the guard reads: the
    // counter runs from its entry to the bound less one, a stable name is
    // itself, a conditional the least and most of its arms, a product its
    // corners. Where the hull fits i32 the copy declares the name as a word
    // (`| 0`, the identity there): its storage is i32, and an index of such
    // words is affine in the counter for the typed-bounds versioning.
    // (no element of a typed array: one past the end reads NaN, which a word takes to zero)
    const lit = (v) => [null, v], isLit = (e) => Array.isArray(e) && e[0] == null && typeof e[1] === 'number'
    const same = (a, b) => a === b || Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b)
    const add = (a, b) => isLit(a) && isLit(b) ? lit(a[1] + b[1]) : isLit(b) && b[1] === 0 ? a : isLit(a) && a[1] === 0 ? b : ['+', a, b]
    const sub = (a, b) => isLit(a) && isLit(b) ? lit(a[1] - b[1]) : isLit(b) && b[1] === 0 ? a : ['-', a, b]
    const mul = (a, b) => isLit(a) && isLit(b) ? lit(a[1] * b[1]) : isLit(a) && a[1] === 0 || isLit(b) && b[1] === 0 ? lit(0) : isLit(a) && a[1] === 1 ? b : isLit(b) && b[1] === 1 ? a : ['*', a, b]
    const neg = (a) => isLit(a) ? lit(-a[1]) : ['u-', a]
    const least = (a, b) => isLit(a) && isLit(b) ? lit(Math.min(a[1], b[1])) : same(a, b) ? a : ['()', 'math.min', [',', a, b]]
    const most = (a, b) => isLit(a) && isLit(b) ? lit(Math.max(a[1], b[1])) : same(a, b) ? a : ['()', 'math.max', [',', a, b]]
    const point = (h) => same(h[0], h[1])
    const counter = loop[0] === 'for' ? loop[1]?.[1]?.[1] : counterBound?.counter
    const hulls = new Map()
    const counterHull = () => {
      if (!counterBound || counterBound.comparison !== '<' || typeof counter !== 'string') return null
      const entry = counterBound.trip ? lit(counterBound.trip.entry) : loop[0] === 'while' && unitStep(loop[2], counter) ? counter : null
      return entry == null ? null : [entry, sub(cloneNode(counterBound.bound), lit(1))]
    }
    const hullOf = (e) => {
      if (typeof e === 'string') {
        if (e === counter) return counterHull()
        if (hulls.has(e)) return hulls.get(e)
        if (loopWrites.has(e) || inner.has(e)) return null
        return names.includes(e) || outerOk(e) && already(e) ? [e, e] : null
      }
      if (!Array.isArray(e)) return null
      const op = e[0]
      if (op == null) return Number.isInteger(e[1]) && e[1] >= I32_MIN && e[1] <= I32_MAX ? [e, e] : null
      if (op === '()' && e.length === 2) return hullOf(e[1])
      if (op === 'u-' && e.length === 2) { const a = hullOf(e[1]); return a && [neg(a[1]), neg(a[0])] }
      if (op === '~' && e.length === 2) return [lit(I32_MIN), lit(I32_MAX)]
      if (op === '?:' && e.length === 4) { const a = hullOf(e[2]), b = hullOf(e[3]); return a && b ? [least(a[0], b[0]), most(a[1], b[1])] : null }
      if (e.length !== 3) return null
      if (op === '&') { const m = isLit(e[1]) ? e[1][1] : isLit(e[2]) ? e[2][1] : null; return m != null && m >= 0 && m <= I32_MAX ? [lit(0), lit(m)] : [lit(I32_MIN), lit(I32_MAX)] }
      if (op === '|' || op === '^' || op === '<<' || op === '>>') return [lit(I32_MIN), lit(I32_MAX)]
      if (op === '>>>') { const k = isLit(e[2]) ? e[2][1] & 31 : 0; return k >= 1 ? [lit(0), lit(2 ** (32 - k) - 1)] : null }
      const a = hullOf(e[1]), b = hullOf(e[2])
      if (!a || !b) return null
      if (op === '+') return [add(a[0], b[0]), add(a[1], b[1])]
      if (op === '-') return [sub(a[0], b[1]), sub(a[1], b[0])]
      if (op === '%') { const m = isLit(e[2]) && Number.isInteger(e[2][1]) && e[2][1] !== 0 ? Math.abs(e[2][1]) : null; return m == null ? null : isLit(a[0]) && a[0][1] >= 0 ? [lit(0), lit(m - 1)] : [lit(1 - m), lit(m - 1)] }
      if (op !== '*') return null
      if (point(a) && isLit(a[0])) return a[0][1] >= 0 ? [mul(a[0], b[0]), mul(a[0], b[1])] : [mul(a[0], b[1]), mul(a[0], b[0])]
      if (point(b) && isLit(b[0])) return b[0][1] >= 0 ? [mul(b[0], a[0]), mul(b[0], a[1])] : [mul(b[0], a[1]), mul(b[0], a[0])]
      const corners = point(a) ? [mul(a[0], b[0]), mul(a[0], b[1])] : point(b) ? [mul(b[0], a[0]), mul(b[0], a[1])]
        : [mul(a[0], b[0]), mul(a[0], b[1]), mul(a[1], b[0]), mul(a[1], b[1])]
      return [corners.reduce(least), corners.reduce(most)]
    }
    // (an invariant product, `py * w` in the element loop, is the typed-bounds
    // versioning's slot, evaluated once at entry: a word of it would be computed
    // per element)
    const invariantProduct = (e) => Array.isArray(e) && (e[0] === '*' && e.length === 3 && !isLit(e[1]) && !isLit(e[2]) && !refsName(e, counter) ||
      e.slice(1).some(invariantProduct))
    const words = new Map()   // name → its hull, both ends expressions the guard tests
    walkAst(loop, { enter: (n) => {
      if (n[0] === '=>') return false
      if (n[0] !== 'let' && n[0] !== 'const') return
      for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') continue
        const name = d[1], e = d[2]
        if (!inner.has(name) || !reaching.has(name) || captured.has(name) || loopWrites.get(name)?.length !== 1 || !mayBeNumber(name)) continue
        if (!Array.isArray(e) || BITWISE.has(e[0]) || !integral(e, new Set()) || invariantProduct(e)) continue
        const h = hullOf(e)
        if (!h || isLit(h[0]) && h[0][1] < I32_MIN || isLit(h[1]) && h[1][1] > I32_MAX) continue
        hulls.set(name, h)
        words.set(name, h)
      }
    } })
    // (a test an int32 answers already is left out: a word's end, the least of
    // ends above the range's floor, the most of ends below its ceiling)
    const span = (e) => {
      if (typeof e === 'string') return e === counter ? [counterHull()?.[0]?.[1] ?? -Infinity, I32_MAX] : names.includes(e) ? [I32_MIN, I32_MAX] : [-Infinity, Infinity]
      if (!Array.isArray(e)) return [-Infinity, Infinity]
      if (e[0] == null) return [e[1], e[1]]
      if (e[0] === '>>' || e[0] === '|') return [I32_MIN, I32_MAX]
      if (e[0] === '()' && e.length === 3 && e[2]?.[0] === ',' && (e[1] === 'math.min' || e[1] === 'math.max')) {
        const a = span(e[2][1]), b = span(e[2][2])
        return e[1] === 'math.min' ? [Math.min(a[0], b[0]), Math.min(a[1], b[1])] : [Math.max(a[0], b[0]), Math.max(a[1], b[1])]
      }
      if (e[0] === '+' && e.length === 3) { const a = span(e[1]), b = span(e[2]); return [a[0] + b[0], a[1] + b[1]] }
      if (e[0] === '-' && e.length === 3) { const a = span(e[1]), b = span(e[2]); return [a[0] - b[1], a[1] - b[0]] }
      if (e[0] === 'u-' && e.length === 2) { const a = span(e[1]); return [-a[1], -a[0]] }
      return [-Infinity, Infinity]
    }
    const wordTests = [], seenTests = new Set()
    for (const [lo, hi] of words.values()) for (const t of [span(lo)[0] >= I32_MIN ? null : ['>=', lo, lit(I32_MIN)], span(hi)[1] <= I32_MAX ? null : ['<=', hi, lit(I32_MAX)]]) {
      if (!t) continue
      const k = JSON.stringify(t)
      if (!seenTests.has(k)) { seenTests.add(k); wordTests.push(t) }
    }
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
      if (!v.names.every(x => (!loopWrites.has(x) && stableBound(x)) || cursors.has(x))) return false
      if (v.test) innerTests.push(v.aliases.length ? cloneWithSubst(v.test, new Map(), own) : v.test)
      for (const a of v.aliases) hoistedAliases.push(own.get(a) ?? a)
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
      p[i] = fast; swapped.push([p, i, v.asWritten])
      return false
    } })
    const copy = cloneWithSubst(loop, new Map(), own)
    for (const [p, i, n] of swapped) p[i] = n
    // the copy declares each derived integer as its word
    if (words.size) {
      const wordNames = new Set([...words.keys()].map(n => own.get(n)))
      walkAst(copy, { enter: (n) => {
        if (n[0] === '=>') return false
        if (n[0] !== 'let' && n[0] !== 'const') return
        for (let i = 1; i < n.length; i++) { const d = n[i]; if (Array.isArray(d) && d[0] === '=' && wordNames.has(d[1])) d[2] = ['|', d[2], lit(0)] }
      } })
    }
    // (the loop as written is the other arm now: every inner version in it is
    // its loop as written too, the fast arm there would run as rarely)
    walkAst(loop, { enter: (n, p, i) => {
      if (n[0] === '=>') return false
      const v = versions.get(n)
      if (!v) return
      p[i] = v.asWritten
      return false
    } })
    // the copy steps each cursor's word
    if (cursors.size) {
      const words = new Set([...cursors.keys()].map(c => own.get(c)))
      const stepped = (st) => { const n = st[0] === 'postfix' ? st[1] : st; return Array.isArray(n) && words.has(n[1]) && stepOf(n) != null ? ['=', n[1], ['|', ['+', n[1], [null, stepOf(n)]], [null, 0]]] : null }
      walkAst(copy, { enter: (n) => {
        if (n[0] === '=>') return false
        if (n[0] !== ';' && n[0] !== '{}') return
        for (let k = 1; k < n.length; k++) { const r = Array.isArray(n[k]) && stepped(n[k]); if (r) n[k] = r }
      } })
    }
    const boundDecl = []
    if (counterBound || cursorTests.length || wordTests.length) includeModule('math')
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
    const typeGuards = [...new Set([...counterBound?.terms ?? [], ...tripNames, ...quietGuards])].map(numberGuard)
    const boundTest = counterBound ? [['&&', ['>=', counterBound.name, [null, counterBound.min]], ['<=', counterBound.name, [null, counterBound.max]]]] : []
    // (an inner test comes after the aliases this one captures: it reads them by the copy's names)
    const tests = [...typeGuards, ...boundTest, ...names.map(n => ['&&', ['&&', numberGuard(n), ['===', n, ['=', own.get(n), ['|', n, [null, 0]]]]], ['||', ['!==', n, [null, 0]], ['>', ['/', [null, 1], n], [null, 0]]]]),
      ...moving.map(n => ['>=', own.get(n), [null, 0]]),
      ...(moving.length ? bounds.map(n => ['>', own.get(n), [null, 0]]) : []),
      ...numbers.map(n => ['===', ['typeof', n], [null, TYPEOF.number]]),
      ...present.map(n => ['!=', n, [null, null]]),
      ...innerTests, ...cursorTests, ...wordTests]
    const test = tests.length ? tests.reduce((a, b) => ['&&', a, b]) : null
    // (a counter enters as its literal; a cursor as its word, an int32 by the guard)
    const version = ['{}', [';', ['let', ...boundDecl, ...outer.filter(n => !names.includes(n)).map(n => ['=', own.get(n), counters.includes(n) ? [null, counterBound.entry] : cursors.has(n) ? ['|', n, [null, 0]] : already(n) ? ['u+', n] : n])], copy,
      // what the copy wrote under a name of its own, where the body reads it after the loop
      // or a loop around runs it again (a Number every write keeps an integer is renamed too: its sum is the copy's)
      ...outer.filter(n => loopWrites.has(n) && readAfter(n)).map(n => ['=', n, own.get(n)])]]
    // (nothing to test, a cursor from a literal: the copy alone, the loop as written for an enclosing version's other arm)
    const asWritten = ['{}', [';', loop]]
    const guarded = test ? ['if', test, version, asWritten] : version
    const aliases = [...names.map(n => own.get(n)), ...hoistedAliases]
    const wrapped = aliases.length ? ['{}', [';', ['let', ...aliases.map(a => ['=', a, [null, 0]])], guarded]] : guarded
    parent[idx] = wrapped
    // (the loop as written runs for the values the guard rejects: cold, with every loop in it;
    // a mark on the node and its body, which a clone carries: type/clone.js carrySite)
    walkAst(loop, { enter: (n) => { if (n[0] === '=>') return false; if (ALL_LOOPS.has(n[0])) { n.cold = true; const b = n[n[0] === 'for' ? 4 : n[0] === 'while' ? 2 : 1]; if (Array.isArray(b)) b.cold = true } } })
    const found = new Set()
    if (test) walkAst(test, { enter: n => { if (n[0] === 'str') return false; for (let i = 1; i < n.length; i++) if (typeof n[i] === 'string' && n[0] !== '()' && !aliases.includes(n[i])) found.add(n[i]) } })
    const undo = new Map(written.filter(n => !names.includes(n) && !counters.includes(n) && !cursors.has(n) && !numbers.includes(n) && !present.includes(n)).map(n => [own.get(n), n]))
    versions.set(wrapped, { test, version, asWritten, loop, names: [...found], aliases, undo, trip: counterBound?.trip ?? null, advances: cursors, cursorHulls })
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
