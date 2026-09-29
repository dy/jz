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
 * too large to copy twice.
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
import { T, MUTATE_OPS, TYPEOF, some, walkAst, extractParams, collectParamName } from '../../ast.js'
import { freshId } from '../../ir.js'
import { cloneWithSubst } from '../../type.js'
import { collectBindings, nodeSize } from './common.js'
import { occursOutside } from './counted-loops.js'
import { isExported } from '../func-exports.js'
import { K, core, hasTag, tagOf } from '../../summary/kind.js'
import { invalidateBodies } from '../analyze.js'
import { invalidateProgramFactsCache } from '../program-facts.js'

const LOOPS = new Set(['for', 'while'])
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
  walkAst(node, { enter: (n) => {
    if (n[0] === '=>') return false
    if (n[0] === 'let' || n[0] === 'const') { for (let i = 1; i < n.length; i++) { const d = n[i]; if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') add(d[1], d[2]) } return }
    if (typeof n[1] !== 'string' || !MUTATE_OPS.has(n[0])) return
    add(n[1], n[0] === '=' ? n[2] : STEPS.has(n[0]) ? n[2] : n[0] === '++' || n[0] === '--' || n[0] === '+1' || n[0] === '-1' ? [null, 1] : BITWISE.has(n[0].slice(0, -1)) ? [null, 0] : null)
  } })
  return out
}
const NO_WRITES = []

const COUNTS = new Set(['++', '--', '+1', '-1'])
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
  if (ARITH.has(op)) return numeric(e[1], num, kindOfExpr) || numeric(e[2], num, kindOfExpr)
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

/** Version the innermost loops of one body, a function's or a closure's
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
  const loops = []
  walkAst(body, { enter: (node, parent, idx) => {
    if (node[0] === '=>') return false
    // an innermost loop: a nest copies its inner loops alone, each under its own test
    if (LOOPS.has(node[0]) && parent && !some(node, n => n !== node && LOOPS.has(n[0]))) { loops.push([node, parent, idx]); return false }
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
    if (some(loop, n => n[0] === '=>' || n[0] === 'label' || n[0] === 'yield' || n[0] === 'await')) continue
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
    let names = [...indexNames(loop, loopWrites, intArray)].filter(n => outerOk(n) && !already(n) && mayBeNumber(n))
    // a cursor the loop moves other than by a constant step (`p = (p + 1) % N`): an index
    // made of names the loop only reads or counts is affine over its counters, which the
    // typed-bounds versioning already proves
    if (!names.some(n => loopWrites.has(n) && !counted(loop, n))) names = []
    let numbers = [...numberNames(loop, loopWrites, inner, kindOf, kindOfExpr, outerOk)].filter(n => !names.includes(n))
    // a Number the loop carries (`z1 = x - a1 * y`): what it only reads converts once per use, as it would
    if (!numbers.some(n => loopWrites.has(n))) numbers = []
    const present = [...presentNames(loop, loopWrites, kindOf, outerOk)]
    if (!names.length && !numbers.length && !present.length) continue
    // Every local the copy writes gets a name of its own too, from its
    // value: a local is one representation, and the loop's keep the float
    // values the copy's do not. So do the copy's own declarations. A
    // number (every write an integer) is read by `+`: a plain read would
    // count as an integer use of the loop's own name.
    const written = [...locals].filter(n => loopWrites.has(n) && !inner.has(n) && !captured.has(n) && !ctx.funcs.names.has(n) && !already(n))
    const outer = [...new Set([...names, ...numbers, ...present, ...written])]
    const own = new Map([...outer, ...inner].map(n => [n, `${n}${T}int${freshId(ctx)}`]))
    const copy = cloneWithSubst(loop, new Map(), own)
    // a number, an int32 and not -0: `typeof x === 'number' && x === (x | 0) && (x !== 0 || 1 / x > 0)`;
    // the type first, so the test converts no object (a key's valueOf runs where the loop reads it);
    // a Number alone: `typeof x === 'number'`, the form whose arm the summary reads as a Number;
    // present: `x != null`
    const test = [...names.map(n => ['&&', ['&&', ['===', ['typeof', n], ['str', 'number']], ['===', n, ['|', n, [null, 0]]]], ['||', ['!==', n, [null, 0]], ['>', ['/', [null, 1], n], [null, 0]]]]),
      ...numbers.map(n => ['===', ['typeof', n], [null, TYPEOF.number]]),
      ...present.map(n => ['!=', n, [null, null]])]
      .reduce((a, b) => ['&&', a, b])
    const version = ['{}', [';', ['let', ...outer.map(n => ['=', own.get(n), names.includes(n) ? ['|', n, [null, 0]] : already(n) ? ['u+', n] : n])], copy,
      // what the copy wrote under a name of its own, where the body reads it after the loop
      // (a Number every write keeps an integer is renamed too: its sum is the copy's)
      ...outer.filter(n => loopWrites.has(n) && occursOutside(body, loop, n)).map(n => ['=', n, own.get(n)])]]
    parent[idx] = ['if', test, version, ['{}', [';', loop]]]
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
