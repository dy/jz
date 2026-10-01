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
 * A closure's loops are versioned in its own body, its parameters and
 * declarations its locals: the callback a factory returns runs the per-frame
 * loops.
 *
 * @module compile/plan/integral-loops
 */
import { ctx } from '../../ctx.js'
import { includeModule } from '../../autoload.js'
import { T, MUTATE_OPS, TYPEOF, numberGuard, some, walkAst, extractParams, collectParamName, isReassigned } from '../../ast.js'
import { freshId } from '../../ir.js'
import { cloneWithSubst } from '../../type.js'
import { collectBindings, nodeSize } from './common.js'
import { occursOutside } from './counted-loops.js'
import { isExported } from '../func-exports.js'
import { constIntExpr, forCounterRange, intExprRange } from '../../static.js'
import { maxAdvanceBudget } from '../../type/canonical-bounds.js'
import { runsAccessor, runsConversion } from '../analyze/frame-effects.js'
import { K, core, hasTag, tagOf } from '../../summary/kind.js'
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
const BOUND_TESTS = new Set(['<', '<=', '>', '>='])
/** The names a `for` loop tests its counter against (`i < n`, `k + i <= n`: every
 *  name of the side the counter is not on), where the counter is its init's
 *  name stepped by a constant. */
const boundNames = (loop) => {
  const out = new Set()
  if (loop[0] !== 'for' || loop.length !== 5) return out
  const [, init, test, step] = loop
  const i = Array.isArray(init) && (init[0] === 'let' || init[0] === 'var') && Array.isArray(init[1]) && init[1][0] === '=' ? init[1][1] : null
  if (typeof i !== 'string' || !Array.isArray(step) || step[1] !== i || !(COUNTS.has(step[0]) || step[0] === '+=' || step[0] === '-=')) return out
  if (!Array.isArray(test) || !BOUND_TESTS.has(test[0])) return out
  const names = (e) => { const found = new Set(); integral(e, found); return found }
  const left = names(test[1]), right = names(test[2])
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
const versionBody = (body, params, view, func, programFacts) => {
  // what a closure of the body names, it reads or writes where the copy cannot see
  const captured = new Set()
  walkAst(body, { enter: (n) => {
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
  const loops = []
  walkAst(body, { enter: node => node[0] === '=>' ? false : undefined, exit: (node, parent, idx) => {
    // Inner copies settle first; the existing size budget includes them when
    // an outer counter needs its own guarded domain.
    if (LOOPS.has(node[0]) && parent && !guarded.has(node)) loops.push([node, parent, idx])
  } })
  // a parameter only the program's own calls bind, each to an integer of no name (`off | 0`)
  const sites = func ? programFacts?.callSites.filter(cs => cs.callee === func.name) ?? [] : []
  const integralEntry = (n) => {
    if (!func) return false
    const at = func.sig.params.findIndex(p => p.name === n)
    if (at < 0 || !sites.length || isExported(func) || programFacts.addressTakenNames.has(func.name) || func.defaults?.[n] != null) return false
    return sites.every(cs => { const found = new Set(); return at < cs.argList.length && integral(cs.argList[at], found) && !found.size })
  }
  // an element of an integer typed array is an integer (undefined past its end reads NaN, which the copy computes alike)
  const intArray = (e) => typeof e === 'string' && INT_ELEMENTS.test(view?.typedPayloadCtorOfExpr(e) ?? '')
  const kindOf = (n) => view?.kindOf(n) ?? 0, kindOfExpr = (e) => view?.kindOfExpr(e) ?? 0
  let bodyWrites = null   // the body's writes, indexed once; a copy adds its own
  let rewrote = false
  for (const [loop, parent, idx] of loops) {
    if (parent[idx] !== loop || nodeSize(loop) > MAX_SIZE) continue
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
    const mayBeNumber = (n) => { const k = view?.kindOfExpr(n); return k == null || hasTag(k, K.NUMBER) || tagOf(core(k)) === K.ANY }
    const outerOk = (n) => locals.has(n) && !inner.has(n) && !captured.has(n) && !ctx.funcs.names.has(n)
    // A module binding can supply the same snapshot as a local only when
    // the entire loop cannot run code that changes it between comparisons.
    const stableBound = n => outerOk(n) || typeof n === 'string' && ctx.scope.globals.has(n) &&
      !loopWrites.has(n) && !some(loop, e => runsAccessor(view, e) || runsConversion(view, e) ||
        e[0] === 'new' || (e[0] === '()' && e.length > 2))
    // A counter's integer-valued updates do not prove its magnitude. Where a
    // stable numeric bound fits i32, round that bound once in a private copy;
    // the shared counter-range proof then includes its final increment. The
    // original bound stays unchanged for uses in the body (including fractions).
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
      if (loop[2][1] === counter && typeof n === 'string' && stableBound(n) && !loopWrites.has(n) &&
          !captured.has(counter) && !writesIn(loop[4]).has(counter) && init?.[0] == null &&
          range && range.test[0] >= -2147483648 && range.test[1] <= 2147483647 &&
          !alreadyBounded && !intExprRange(n) && !integralEntry(n)) counterBound = { name: n, bound, comparison, testAt: 2, min: -2147483648 - Math.min(0, adjust), max: 2147483647 - Math.max(0, adjust) }
    }
    // A while counter has an observable entry outside the loop. Capture its
    // word only behind the same exact-entry guard, then reserve room for every
    // positive step before the next comparison (including the final landing).
    if (loop[0] === 'while' && (loop[1]?.[0] === '<' || loop[1]?.[0] === '<=')) {
      const counter = loop[1][1], n = loop[1][2], inclusive = loop[1][0] === '<='
      if (typeof counter === 'string' && outerOk(counter) && mayBeNumber(counter) &&
          typeof n === 'string' && stableBound(n) && !loopWrites.has(n) && !intExprRange(n)) {
        const advance = maxAdvanceBudget(loop[2], counter, { constInt: constIntExpr, evRange: intExprRange, closureWrites: captured, MUTATE_OPS })
        if (advance > 0 && advance <= 2147483647) {
          const rounded = ['()', inclusive ? 'math.floor' : 'math.ceil', n]
          counterBound = { name: n, counter, testAt: 1, comparison: '<',
            bound: ['>>', inclusive ? ['+', rounded, [null, 1]] : rounded, [null, 0]],
            min: -2147483648, max: 2147483647 - advance + (inclusive ? 0 : 1) }
        }
      }
    }
    // State/presence copies belong to leaf loops. A surrounding scan may
    // still need a bounded counter even when its work contains another loop.
    if (!counterBound && some(loop, n => n !== loop && LOOPS.has(n[0]))) continue
    const indexed = [...indexNames(loop, loopWrites, intArray)].filter(n => outerOk(n) && !already(n) && mayBeNumber(n))
    // the names a counter is tested against (`i < n`, n read from a parameter): the
    // counter is an int32 only where they are
    // (not an export's own parameter: the host's value there keeps the boundary's representation)
    const bounds = [...boundNames(loop)].filter(n => outerOk(n) && !loopWrites.has(n) && !already(n) && mayBeNumber(n) &&
      !(func && isExported(func) && params.has(n)))
    // a cursor the loop moves other than by a constant step (`p = (p + 1) % N`), or a
    // counter's bound of unknown integrality: an index made of names the loop only reads
    // or counts, under a bound that is an integer, is affine over its counters, which the
    // typed-bounds versioning already proves; nor is such an index a Number to copy for
    const names = bounds.length || indexed.some(n => loopWrites.has(n) && !counted(loop, n)) ? [...new Set([...indexed, ...bounds])] : []
    if (counterBound?.counter && !names.includes(counterBound.counter)) names.push(counterBound.counter)
    let numbers = [...numberNames(loop, loopWrites, inner, kindOf, kindOfExpr, outerOk)].filter(n => !indexed.includes(n))
    // a Number the loop carries (`z1 = x - a1 * y`): what it only reads converts once per use, as it would
    if (!numbers.some(n => loopWrites.has(n))) numbers = []
    const present = [...presentNames(loop, loopWrites, kindOf, outerOk)]
    if (!names.length && !numbers.length && !present.length && !counterBound) continue
    // A Number the copy writes gets a name of its own too: a local has one
    // representation, and the original loop keeps the float values the copy
    // does not. The copy's own declarations also get fresh names. Fixed
    // nonnumeric outer values keep their binding, so copying a loop creates
    // no alias of a private string builder. A
    // number (every write an integer) is read by `+`: a plain read would
    // count as an integer use of the loop's own name.
    const written = [...locals].filter(n => loopWrites.has(n) && !inner.has(n) && !captured.has(n) && !ctx.funcs.names.has(n) && mayBeNumber(n) && !already(n))
    const outer = [...new Set([...names, ...numbers, ...present, ...written])]
    const own = new Map([...outer, ...inner].map(n => [n, `${n}${T}int${freshId(ctx)}`]))
    // A non-counted index recurrence gets the nonnegative index domain;
    // a positive count closes wrap/decrement recurrences. Readonly offsets
    // retain signed entries. Subsequent writes still need a complete hull.
    const moving = names.filter(n => indexed.includes(n) && loopWrites.has(n) && !counted(loop, n))
    const copy = cloneWithSubst(loop, new Map(), own)
    const boundDecl = []
    if (counterBound) {
      includeModule('math')
      const bound = `${counterBound.name}${T}bound${freshId(ctx)}`
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
    const boundTest = counterBound ? [['&&', numberGuard(counterBound.name), ['&&', ['>=', counterBound.name, [null, counterBound.min]], ['<=', counterBound.name, [null, counterBound.max]]]]] : []
    const test = [...boundTest, ...names.map(n => ['&&', ['&&', numberGuard(n), ['===', n, ['=', own.get(n), ['|', n, [null, 0]]]]], ['||', ['!==', n, [null, 0]], ['>', ['/', [null, 1], n], [null, 0]]]]),
      ...moving.map(n => ['>=', own.get(n), [null, 0]]),
      ...(moving.length ? bounds.map(n => ['>', own.get(n), [null, 0]]) : []),
      ...numbers.map(n => ['===', ['typeof', n], [null, TYPEOF.number]]),
      ...present.map(n => ['!=', n, [null, null]])]
      .reduce((a, b) => ['&&', a, b])
    const version = ['{}', [';', ['let', ...boundDecl, ...outer.filter(n => !names.includes(n)).map(n => ['=', own.get(n), already(n) ? ['u+', n] : n])], copy,
      // what the copy wrote under a name of its own, where the body reads it after the loop
      // (a Number every write keeps an integer is renamed too: its sum is the copy's)
      ...outer.filter(n => loopWrites.has(n) && occursOutside(body, loop, n)).map(n => ['=', n, own.get(n)])]]
    const guarded = ['if', test, version, ['{}', [';', loop]]]
    parent[idx] = names.length ? ['{}', [';', ['let', ...names.map(n => ['=', own.get(n), [null, 0]])], guarded]] : guarded
    for (const [n, values] of writesIn(version)) { const l = bodyWrites.get(n); if (l) l.push(...values); else bodyWrites.set(n, values) }
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
      if (versionBody(n[2], params, ctx.summary?.at(n[1]), null, programFacts)) rewrote = true
    } })
    // rewritten in place: the facts cached for the body describe what it was
    if (rewrote) { invalidateProgramFactsCache(func.body); invalidateBodies([func.body]); changed = true }
  }
  return changed
}
