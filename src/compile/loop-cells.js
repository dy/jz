/**
 * Loop cells: the elements of typed arrays a loop reads and writes at fixed
 * indexes stay in locals while it runs.
 *
 * A filter's state, a predictor's weights and history, a kernel's coefficients:
 * a few elements of small typed arrays, read and written every sample while the
 * loop stores its output through another array. In memory each is a load and a
 * store a round, and the value the next round reads waits behind the store
 * before it. No store may be taken to miss them: two names can hold one array,
 * and two views can share a buffer. Tested once, where the loop is entered:
 *     for (…) { … A[k] … ; A[k] = E; … B[i] = F }
 *       →  if (A.length > k && apart(A, B)) {
 *            let c = A[k]
 *            for (…) { … c … ; c = E′; … B[i] = F }
 *            A[k] = c
 *          } else for (…) { … A[k] … ; A[k] = E; … B[i] = F }
 * c starts as the element, E′ is E converted to the element type (what a read
 * of the stored element returns), and the element takes c as the loop leaves.
 * The copy that tests nothing is the loop as written, under names of its own.
 *
 * The elements wait for the loop's end, so the loop must reach it, by its test
 * or a `break`, with nothing between that reads them from memory. Applies to a
 * `for` or a `while` among the statements of a list, when:
 *   - it is quiet (QUIET): statements, declarations of names, arithmetic,
 *     comparisons, assignments, element and member accesses, `Math` functions
 *     of Numbers. No closure, label, `return`, `throw`, `try`, pattern, spread,
 *     iteration or other call; no accessor, no conversion of an object, no
 *     arithmetic or store over what may be a BigInt (beside a Number it
 *     throws); a receiver that may be nullish is a name the loop never writes,
 *     tested where the loop is entered. Nothing in it runs the program's code
 *     or throws;
 *   - every element access that may reach a typed array goes through a name the
 *     loop never writes, of a known constructor: each typed array the loop
 *     touches is named where it is entered;
 *   - a held array A is read and written only at integer literals (its cells
 *     differ by index), holds Numbers a local can carry (not BigInt, Float16,
 *     Uint8Clamped, Uint32), and each store to it is a statement: a plain or
 *     compound assignment or a step whose value nothing reads.
 * The test: the receivers present, each held array as long as its last cell
 * (where the body does not prove it), and apart (no shared byte,
 * module/typedarray.js `__typed_apart`) from every other typed array of the
 * loop where either of the two is stored into. Two parameters every call hands
 * its own fresh array, and two module bindings that only ever hold arrays they
 * made, are apart with no test (plan/literals.js). Two module bindings of
 * which that is not known, and two arrays one of which is declared from the
 * other (`new Uint32Array(f.buffer)`, a `subarray`), are not tested, and
 * neither is held: the views a program reads a float's words through are
 * such, and storage only indexed by constants is registers already
 * (optimize/static-scratch.js), which a test naming the arrays would end. An
 * array the loop only reads, apart from every store by proof, is left: its
 * reads leave the loop on their own (optimize/licm.js). A loop left with
 * nothing to test holds its cells where it stands, uncopied.
 * Arrays, objects and strings are other storage. With a memory other threads
 * write nothing is held: a cell the loop left unwritten is stored back as read.
 * An integer cell is a word by its conversion. Speed tiers.
 *
 * @module compile/loop-cells
 */
import { ctx } from '../ctx.js'
import { walkAst, collectAllBoundNames, some, MUTATE_OPS, T } from '../ast.js'
import { freshId } from '../ir.js'
import { TYPED_ELEM_CODE } from '../../layout.js'
import { typedStorageNameCtor } from '../typed-context.js'
import { cloneWithSubst } from '../type/clone.js'
import { valTypeOf } from '../kind.js'
import { VAL } from '../reps.js'
import { K, hasTag } from '../summary/kind.js'
import { runsAccessor, runsConversion } from '../evaluation-effects.js'
import { typedIdxProven } from '../type/loop-versioning.js'
import { invalidateIntervalProof } from '../type/interval-proof.js'
import { withBodyTypedFacts } from './flow-state.js'
import { invalidateRewrittenBody } from './analyze/body-facts.js'
import { representationProgramHasBigint } from './representation-plan.js'
import { CONVERT } from './carry-elements.js'
import { scanBindingUses, USE, BINDING_USE_DECLS, BINDING_USE_INIT, BINDING_USE_USES, BINDING_USE_KIND } from './analyze-scans.js'

const isArr = Array.isArray
const num = (v) => [null, v]
// A store's conversion to its element code, in source form (carry-elements.js CONVERT), with the
// two a carried element leaves out; a Uint32 fills no word.
const HELD = { 0: CONVERT[0], 1: CONVERT[1], 2: CONVERT[2], 3: e => ['&', e, num(65535)], 4: CONVERT[4],
  6: e => ['()', 'math.fround', e], 7: CONVERT[7] }
const NOT_HELD = /^(?:Big|Float16|Uint8Clamped)/
const BIG = /^new\.Big/
// The most tests of two arrays a loop's entry runs, and the most cells it holds.
const MAX_PAIRS = 6, MAX_CELLS = 16
// The operators of code that runs to its end, where its receivers are there and no BigInt meets a Number.
const QUIET = new Set([';', '{}', ',', 'let', 'const', 'if', 'while', 'for', 'do', 'break', 'continue',
  'postfix', '?:', '&&', '||', '??', '__eager&&', '__eager||', '!', '~', 'u-', 'u+', '+1', '-1',
  '+', '-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>', '<', '>', '<=', '>=', '==', '===', '!=', '!==', 'typeof',
  ...MUTATE_OPS, '[]', '.', '()'])
// Of them, those that throw over a BigInt and a Number (or over a BigInt alone: `+x`, `>>>`), a store among them
// (an element takes its array's kind): arithmetic, the bit operators and their assignments. A comparison takes both.
const MIXING = new Set(['+', '-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>', 'u+', '+1', '-1',
  '=', '+=', '-=', '*=', '/=', '%=', '**=', '|=', '&=', '^=', '<<=', '>>=', '>>>='])

/** The element code of a held array's constructor (`new.Int16Array`, `.view` or `.anyview` after it), or null. */
const heldCode = (ctor) => {
  if (!ctor || !ctor.startsWith('new.')) return null
  const dot = ctor.indexOf('.', 4), name = dot < 0 ? ctor.slice(4) : ctor.slice(4, dot)
  const code = NOT_HELD.test(name) ? null : TYPED_ELEM_CODE[name]
  return code != null && HELD[code] ? code : null
}
/** A name's typed constructor: the function's own record of it, or the one the summary holds every value of it to. */
const ctorOf = (name, view) => typedStorageNameCtor(ctx, name) ?? view?.typedCtorOf(name) ?? null
/** A non-negative integer literal's value, or null. */
const cellOf = (x) => isArr(x) && x[0] == null && Number.isInteger(x[1]) && x[1] >= 0 ? x[1] : null
const writesNames = (n, names) => some(n, x => MUTATE_OPS.has(x[0]) && names.has(x[1]), { skipArrow: false })
  || [...collectAllBoundNames(n)].some(x => names.has(x))
/** A `Math` function of Numbers: it reads and writes no memory. */
const pureMath = (n) => typeof n[1] === 'string' && n[1].startsWith('math.') &&
  (n[2] == null || (isArr(n[2]) && n[2][0] === ',' ? n[2].slice(1) : [n[2]]).every(a => valTypeOf(a) === VAL.NUMBER))

/**
 * Loop `L` read as quiet code: `{ acc, present }`, or null where it is not.
 * `acc`: its typed element accesses, each `{ R, I, holder, at, node, write, plain }`
 * (`holder[at]` the access, or the assignment that stores through it; `plain` a store
 * whose value nothing reads). `present`: the names it reads through that may be
 * nullish.
 */
function quietLoop(L, view) {
  const acc = [], present = new Set()
  const big = representationProgramHasBigint(ctx)
  let ok = true
  const kindOf = (e) => { try { return view ? view.kindOfExpr(e) : null } catch { return null } }
  // Whether a value may be a BigInt: by the kind the emitter holds it to, an element by its array's
  // constructor, else by the summary, which lists a BigInt wherever one may reach.
  const bigArray = (e) => isArr(e) && e[0] === '[]' && e.length === 3 && typeof e[1] === 'string' ? ctorOf(e[1], view) : null
  const mayBeBig = (e) => {
    const vt = valTypeOf(e), ctor = vt == null ? bigArray(e) : null
    if (vt != null || ctor) return vt === VAL.BIGINT || BIG.test(ctor ?? '')
    const k = kindOf(e)
    return k == null || hasTag(k, K.BIGINT)
  }
  const mayBeNullish = (e) => { const k = kindOf(e); return k == null || hasTag(k, K.NULLISH) || hasTag(k, K.ABSENT) }
  // whether a receiver is there: by its kind, or a name the loop's entry tests
  const there = (R) => {
    if (!mayBeNullish(R)) return true
    if (typeof R !== 'string') return false
    present.add(R)
    return true
  }
  // an element's receiver: 1 a typed array's name, 0 other storage, -1 one that may be a typed array no name holds, or be missing
  const recv = (R) => {
    const typed = typeof R === 'string' && ctorOf(R, view) != null
    if (!typed) { const vt = valTypeOf(R); if (vt == null || vt === VAL.TYPED) return -1 }
    return !there(R) ? -1 : typed ? 1 : 0
  }
  const visit = (n, used, holder, at) => {
    if (!ok || !isArr(n)) return
    const op = n[0]
    if (op == null || op === 'str' || op === 'bool') return   // a literal
    ok = QUIET.has(op) && (op !== '()' || pureMath(n)) && !runsAccessor(view, n) && !runsConversion(view, n) &&
      !((op === 'break' || op === 'continue') && n.length > 1 && n[1] != null)
    if (!ok) return
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (typeof d === 'string') continue
        if (!isArr(d) || d[0] !== '=' || typeof d[1] !== 'string') { ok = false; return }   // (a pattern reads its value's members)
        visit(d[2], true, d, 2)
      }
      return
    }
    // (a plain store reads no element: its value alone, and the kind of the array it goes to)
    if (big && MIXING.has(op)) for (let i = op === '=' ? 2 : 1; i < n.length; i++) if (mayBeBig(n[i])) { ok = false; return }
    if (big && op === '=' && BIG.test(bigArray(n[1]) ?? '')) { ok = false; return }
    const write = MUTATE_OPS.has(op), t = write ? n[1] : n
    // (a store's target is visited through its store: a setter, a key's conversion)
    if (write && isArr(t) && (runsAccessor(view, t) || runsConversion(view, t))) { ok = false; return }
    if (isArr(t) && t[0] === '[]' && t.length === 3) {
      const r = recv(t[1])
      if (r < 0) { ok = false; return }
      if (r > 0) acc.push({ R: t[1], I: t[2], holder, at, node: n, write,
        plain: write && !used })
      else visit(t[1], true, t, 1)
      visit(t[2], true, t, 2)
      if (write) for (let i = 2; i < n.length; i++) visit(n[i], true, n, i)
      return
    }
    if (isArr(t) && t[0] === '.') {
      // a member of a receiver that is there; a length is read, never set (a length set may throw)
      if ((write && t[2] === 'length') || !there(t[1])) { ok = false; return }
      if (t[2] !== 'length' || typeof t[1] !== 'string') visit(t[1], true, t, 1)
      if (write) for (let i = 2; i < n.length; i++) visit(n[i], true, n, i)
      return
    }
    if (write && typeof t !== 'string') { ok = false; return }   // (a pattern)
    // whether a child's value is read: a statement's is not
    if (op === ';' || op === '{}') for (let i = 1; i < n.length; i++) visit(n[i], false, n, i)
    else if (op === 'if') { visit(n[1], true, n, 1); for (let i = 2; i < n.length; i++) visit(n[i], false, n, i) }
    else if (op === 'for' && n.length === 5) { visit(n[1], false, n, 1); visit(n[2], true, n, 2); visit(n[3], false, n, 3); visit(n[4], false, n, 4) }
    else if (op === 'while' && n.length === 3) { visit(n[1], true, n, 1); visit(n[2], false, n, 2) }
    else if (op === ',') for (let i = 1; i < n.length; i++) visit(n[i], i === n.length - 1 && used, n, i)
    else for (let i = 1; i < n.length; i++) visit(n[i], true, n, i)
  }
  visit(L, false, null, -1)
  return ok ? { acc, present } : null
}

/** Whether `e` names `x` other than for its length. */
const names = (e, x) => e === x || isArr(e) && !(e[0] === '.' && e[1] === x && e[2] === 'length') && e.some((c, i) => i > 0 && names(c, x))

/** What loop `L` holds: `{ held: Map<name, { code, cells: Map<index, accesses> }>, pairs, present }`, or null.
 *  `distinct`: the function's parameters proven separate buffers. `defOf(name)`: the value a name of the
 *  body is declared with, where it has one declaration and no other write. */
function planOf(L, view, distinct, defOf) {
  const q = quietLoop(L, view)
  if (!q || !q.acc.length) return null
  const by = new Map()
  for (const a of q.acc) (by.get(a.R) ?? by.set(a.R, []).get(a.R)).push(a)
  const arrays = [...by.keys()]
  if (writesNames(L, new Set([...arrays, ...q.present]))) return null
  const stored = (R) => by.get(R).some(a => a.write)
  const held = new Map()
  let count = 0
  for (const R of arrays) {
    const code = heldCode(ctorOf(R, view))
    if (code == null) continue
    const cells = new Map()
    let ok = true
    for (const a of by.get(R)) {
      const k = cellOf(a.I)
      if (k == null || (a.write && !a.plain)) { ok = false; break }
      ;(cells.get(k) ?? cells.set(k, []).get(k)).push(a)
    }
    if (!ok) continue
    held.set(R, { code, cells })
    count += cells.size
  }
  if (count > MAX_CELLS) return null
  // the pairs to tell apart: by proof, by a test, or not at all (two module bindings; one array made of the other)
  const global = (x) => ctx.scope.globals?.has(x) && !ctx.func.locals?.has(x)
  const made = (x) => global(x) && ctx.scope.freshTypedGlobals?.has('$' + x)
  const of = (x, y) => names(defOf(x), y)
  let pairs = []
  for (let settled = false; !settled && held.size;) {
    settled = true
    pairs = []
    const drop = []
    for (const R of held.keys()) for (const S of arrays) {
      if (S === R || !(stored(R) || stored(S))) continue
      if (held.has(S) && arrays.indexOf(S) < arrays.indexOf(R)) continue   // (two held arrays: the pair once)
      if ((distinct?.has(R) && distinct.has(S)) || (made(R) && made(S))) continue
      if ((global(R) && global(S)) || of(R, S) || of(S, R)) drop.push(R, S)
      else pairs.push([R, S])
    }
    // an array only read, apart from every store by proof: its reads leave the loop on their own (optimize/licm.js)
    for (const R of held.keys()) if (!stored(R) && !pairs.some(p => p[0] === R || p[1] === R)) drop.push(R)
    for (const x of drop) if (held.delete(x)) settled = false
  }
  return !held.size || pairs.length > MAX_PAIRS ? null : { held, pairs, present: q.present }
}

/**
 * Hold the cells of the loops of `body`. `facts` is the body analysis,
 * `distinct` the function's parameters proven separate buffers, and
 * `reanalyze()` analyzes the body afresh and returns its facts. Returns the
 * final facts, or null when the body is unchanged.
 */
export function holdLoopCells(body, facts, distinct, reanalyze) {
  if (!isArr(body) || ctx.memory.atomic) return null
  const view = ctx.summary?.at(ctx.func.current)
  const splits = []
  let queried = false, uses = null
  const defOf = (name) => {
    const b = (uses ??= scanBindingUses(body)).get(name)
    return b && b[BINDING_USE_DECLS] === 1 && !b[BINDING_USE_USES].some(u => u[BINDING_USE_KIND] === USE.REASSIGN) ? b[BINDING_USE_INIT] : undefined
  }
  withBodyTypedFacts(facts, () => walkAst(body, { enter: (n, parent, index) => {
    if (n[0] === '=>' || n.cold === true) return false
    if (!(n[0] === 'for' && n.length === 5 || n[0] === 'while' && n.length === 3) || !parent || (parent[0] !== ';' && parent[0] !== '{}')) return
    const plan = planOf(n, view, distinct, defOf)
    if (!plan) return   // (a loop inside it may hold its own)
    // the test: the receivers, the lengths the body does not prove, the arrays apart
    const tests = []
    for (const x of plan.present) tests.push(['!=', x, [null, null]])
    for (const [R, { cells: at }] of plan.held) {
      let last = 0
      for (const k of at.keys()) if (k > last) last = k
      queried = true
      if (!typedIdxProven(R, num(last))) tests.push(['>', ['.', R, 'length'], num(last)])
    }
    for (const [R, S] of plan.pairs) tests.push(['()', '__typed_apart', [',', R, S]])
    splits.push({ L: n, parent, p: index, plan, tests })
    return false
  } }))
  // (the length queries proved the body as it stands, under this analysis's facts)
  if (queried) invalidateIntervalProof(body)
  if (!splits.length) return null
  for (const s of splits) {
    // the loop as written, under names of its own, where a test may fail
    const ren = new Map(), cells = []
    if (s.tests.length) {
      walkAst(s.L, { enter: (x) => {
        if (x[0] !== 'let' && x[0] !== 'const') return
        for (const name of collectAllBoundNames(x)) if (!ren.has(name)) ren.set(name, `${T}lw${freshId(ctx)}_${name}`)
      } })
      s.written = cloneWithSubst(s.L, new Map(), ren)
      for (const [a, b] of ren) view?.alias(b, a, false)
    }
    // the cells: every read first (a store's value may read one), then the stores
    for (const [R, { code, cells: at }] of s.plan.held) for (const [k, list] of at) {
      const c = `${T}lc${freshId(ctx)}_${R}`, read = ['[]', R, num(k)]
      view?.alias(c, read, true)
      cells.push({ c, R, k, code, read, list, back: null })
      for (const a of list) if (!a.write) a.holder[a.at] = c
    }
    for (const cell of cells) for (const a of cell.list) {
      if (!a.write) continue
      const n = a.node, op = n[0], c = cell.c
      const value = op === '=' ? n[2] : op === '++' ? ['+', c, num(1)] : op === '--' ? ['-', c, num(1)] : [op.slice(0, -1), c, n[2]]
      a.holder[a.at] = ['=', c, cell.code === 7 && valTypeOf(value) === VAL.NUMBER ? value : HELD[cell.code](value)]
      if (!cell.back) cell.back = ['[]', cell.R, num(cell.k)]
    }
    const held = ['{}', [';', ...cells.map(x => ['let', ['=', x.c, x.read]]), s.L, ...cells.filter(x => x.back).map(x => ['=', x.back, x.c])]]
    s.parent[s.p] = s.tests.length ? ['if', s.tests.reduce((a, t) => ['&&', a, t]), held, ['{}', [';', s.written]]] : held
  }
  invalidateRewrittenBody(body)
  return reanalyze()
}
