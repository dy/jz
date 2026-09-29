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
 * @module compile/plan/integral-loops
 */
import { ctx } from '../../ctx.js'
import { T, MUTATE_OPS, some, walkAst } from '../../ast.js'
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

export const versionIntegralLoops = (programFacts) => {
  if (ctx.transform.optimize?.versionIntegralLoops === false) return false
  let changed = false
  for (const func of ctx.funcs.list) {
    if (func.raw || !func.body) continue
    // what a closure of the function names, it reads or writes where the copy cannot see
    const captured = new Set()
    walkAst(func.body, { enter: (n) => {
      if (n[0] !== '=>') return
      walkAst(n, { enter: (m) => { for (let i = 1; i < m.length; i++) if (typeof m[i] === 'string') captured.add(m[i]) } })
      return false
    } })
    const locals = new Set((func.sig?.params ?? []).map(p => p.name))
    collectBindings(func.body, locals)
    const loops = []
    walkAst(func.body, { enter: (node, parent, idx) => {
      if (node[0] === '=>') return false
      // an innermost loop: a nest copies its inner loops alone, each under its own test
      if (LOOPS.has(node[0]) && parent && !some(node, n => n !== node && LOOPS.has(n[0]))) { loops.push([node, parent, idx]); return false }
    } })
    const params = new Set((func.sig?.params ?? []).map(p => p.name))
    const view = ctx.summary?.at(func.sig)
    // a parameter only the program's own calls bind, each to an integer of no name (`off | 0`)
    const sites = programFacts?.callSites.filter(cs => cs.callee === func.name) ?? []
    const integralEntry = (n) => {
      const at = func.sig.params.findIndex(p => p.name === n)
      if (at < 0 || !sites.length || isExported(func) || programFacts.addressTakenNames.has(func.name) || func.defaults?.[n] != null) return false
      return sites.every(cs => { const found = new Set(); return at < cs.argList.length && integral(cs.argList[at], found) && !found.size })
    }
    // an element of an integer typed array is an integer (undefined past its end reads NaN, which the copy computes alike)
    const intArray = (e) => typeof e === 'string' && INT_ELEMENTS.test(view?.typedPayloadCtorOfExpr(e) ?? '')
    let bodyWrites = null   // the function's writes, indexed once; a copy adds its own
    let rewrote = false
    for (const [loop, parent, idx] of loops) {
      if (parent[idx] !== loop || nodeSize(loop) > MAX_SIZE) continue
      if (some(loop, n => n[0] === '=>' || n[0] === 'label' || n[0] === 'yield' || n[0] === 'await')) continue
      const inner = new Set()
      collectBindings(loop, inner)
      const loopWrites = writesIn(loop)
      bodyWrites ??= writesIn(func.body)
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
      const names = [...indexNames(loop, loopWrites, intArray)].filter(n => locals.has(n) && !inner.has(n) && !captured.has(n) && !ctx.funcs.names.has(n) && !already(n) && mayBeNumber(n))
      // a cursor the loop moves other than by a constant step (`p = (p + 1) % N`): an index
      // made of names the loop only reads or counts is affine over its counters, which the
      // typed-bounds versioning already proves
      if (!names.some(n => loopWrites.has(n) && !counted(loop, n))) continue
      // Every local the copy writes gets a name of its own too, from its
      // value: a local is one representation, and the loop's keep the float
      // values the copy's do not. So do the copy's own declarations. A
      // number (every write an integer) is read by `+`: a plain read would
      // count as an integer use of the loop's own name.
      const written = [...locals].filter(n => loopWrites.has(n) && !inner.has(n) && !captured.has(n) && !ctx.funcs.names.has(n) && !already(n))
      const outer = [...new Set([...names, ...written])]
      const own = new Map([...outer, ...inner].map(n => [n, `${n}${T}int${freshId(ctx)}`]))
      const copy = cloneWithSubst(loop, new Map(), own)
      // a number, an int32 and not -0: `typeof x === 'number' && x === (x | 0) && (x !== 0 || 1 / x > 0)`;
      // the type first, so the test converts no object (a key's valueOf runs where the loop reads it)
      const test = names.map(n => ['&&', ['&&', ['===', ['typeof', n], ['str', 'number']], ['===', n, ['|', n, [null, 0]]]], ['||', ['!==', n, [null, 0]], ['>', ['/', [null, 1], n], [null, 0]]]])
        .reduce((a, b) => ['&&', a, b])
      const version = ['{}', [';', ['let', ...outer.map(n => ['=', own.get(n), names.includes(n) ? ['|', n, [null, 0]] : already(n) ? ['u+', n] : n])], copy,
        // what the copy wrote, where the function reads it after the loop
        ...written.filter(n => occursOutside(func.body, loop, n)).map(n => ['=', n, own.get(n)])]]
      parent[idx] = ['if', test, version, ['{}', [';', loop]]]
      for (const [n, values] of writesIn(version)) { const l = bodyWrites.get(n); if (l) l.push(...values); else bodyWrites.set(n, values) }
      rewrote = true
    }
    // rewritten in place: the facts cached for the body describe what it was
    if (rewrote) { invalidateProgramFactsCache(func.body); invalidateBodies([func.body]); changed = true }
  }
  return changed
}
