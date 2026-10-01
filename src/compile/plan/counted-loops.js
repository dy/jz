/**
 * Counted loops in canonical form.
 *
 * Every later reading of a loop (extent tests, the lane recognizers) takes
 * addresses affine in ONE counter that starts at a literal. A strided kernel
 * walks a cursor beside its counter and starts its main loop at a remainder:
 *
 *   ix = offset                              c = ix | 0
 *   for (i = m; i < N; i += 4) {             for (k = 0; k < T; k++) {
 *     s += x[ix] * y[ix] + …          →        s += x[c + 4 * k] * y[c + 4 * k] + …
 *     ix += 4                                }
 *   }                                        ix = c + 4 * T
 *
 * Two rewrites, each exact:
 *
 *   - `guardConstants`: inside `if (p === 1 && q === 1) { … }` a name the arm
 *     never writes is the literal it was tested against, so `ix += p` steps by
 *     one. A hand-versioned kernel states its unit stride this way.
 *
 *   - `canonicalizeCountedLoops`: a cursor written once per trip, by a
 *     constant step at the top of the body, holds `c + K·k` in trip `k`. Its
 *     reads become that expression and its step leaves the loop; it lands on
 *     `c + K·T` after T trips. A counter starting at a computed value is the
 *     trip number scaled and shifted the same way. A test of the counter
 *     plus an offset against a length (`i + k < n`, a lag or a tap) is the
 *     counter against the length less the offset (`offsetTest`).
 *
 * A cursor is read as an element index only; the entry and final update must
 * both fit signed int32 without losing negative zero. A computed start is an integer by test:
 * the rewrite runs under `v === floor(v)` with the original loop as the other
 * arm. The trip count is the closed form, corrected by comparison so that a
 * fractional bound counts as the loop itself would.
 *
 * @module compile/plan/counted-loops
 */

import { ctx } from '../../ctx.js'
import { T, MUTATE_OPS, numberGuard, some, walkAst, stmtList, cloneNode } from '../../ast.js'
import { freshId } from '../../ir.js'
import { includeModule } from '../../autoload.js'
import { optimizing } from './common.js'
import { intLevelMap } from '../../type.js'
import { K, NUMBER, core, tagOf } from '../../summary/kind.js'

const lit = (v) => [null, v]
const TRY = new Set(['try', 'catch', 'finally'])
const isInt = (n) => Array.isArray(n) && n[0] == null && typeof n[1] === 'number' && Number.isInteger(n[1]) && Math.abs(n[1]) <= 0x7fffffff
/** The integer `n` is: a literal, or a module constant by name (`var M = 5`). Null otherwise. */
const intOf = (n) => isInt(n) ? n[1] : typeof n === 'string' && ctx.scope.constInts?.has(n) ? ctx.scope.constInts.get(n) : null
const fresh = (tag) => `${T}${tag}${freshId(ctx)}`
const add = (a, k) => k === 0 ? a : ['+', a, lit(k)]
const scale = (k, e) => k === 1 ? e : ['*', lit(k), e]
const call = (fn, ...args) => ['()', fn, args.length === 1 ? args[0] : [',', ...args]]
/** `out` carrying what `node` carries beside its elements (positions, marks). */
const like = (node, out) => { for (const key in node) if (!(key in out)) out[key] = node[key]; return out }

/** `name` is written somewhere in `node`. */
const writes = (node, name) => some(node, n => MUTATE_OPS.has(n[0]) && n[1] === name)
/** `name` occurs in `node`, property names aside. */
const mentions = (node, name) => {
  if (typeof node === 'string') return node === name
  if (!Array.isArray(node) || node[0] == null || node[0] === 'str') return false
  if (node[0] === '.' || node[0] === '?.') return mentions(node[1], name)
  for (let i = 1; i < node.length; i++) if (mentions(node[i], name)) return true
  return false
}
/** Arithmetic over proved Numbers, or immutable built-in lengths: no coercion calls. */
const PURE_OPS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '>>>', 'u-', 'u+', '~'])
const pure = (n, view) => {
  if (typeof n === 'string') return view.kindOfExpr(n) === NUMBER
  if (typeof n === 'number') return true
  if (!Array.isArray(n)) return false
  if (n[0] == null) return typeof n[1] === 'number'
  if (n[0] === '.' && n[2] === 'length' && typeof n[1] === 'string') {
    const tag = tagOf(core(view.kindOfExpr(n[1])))
    return tag === K.TYPED || tag === K.STRING
  }
  if (!PURE_OPS.has(n[0])) return false
  for (let i = 1; i < n.length; i++) if (!pure(n[i], view)) return false
  return true
}
const namesOf = (n, out = new Set()) => {
  if (typeof n === 'string') out.add(n)
  else if (Array.isArray(n) && n[0] != null) for (let i = 1; i < n.length; i++) namesOf(n[i], out)
  return out
}

// ── constants an equality guards ────────────────────────────────────────────

/** The `name === literal` conjuncts of a test, zero aside (`-0 === 0`). */
const guarded = (test, out = new Map()) => {
  if (!Array.isArray(test)) return out
  if (test[0] === '&&') { guarded(test[1], out); guarded(test[2], out); return out }
  if (test[0] !== '===' || test.length !== 3) return out
  const [, a, b] = test
  const take = (name, v) => { if (typeof name === 'string' && isInt(v) && v[1] !== 0 && !ctx.scope.globals.has(name)) out.set(name, v[1]) }
  take(a, b); take(b, a)
  return out
}
const substitute = (node, consts) => {
  if (typeof node === 'string') return consts.has(node) ? lit(consts.get(node)) : node
  if (!Array.isArray(node) || node[0] == null || node[0] === 'str') return node
  if (node[0] === '.' || node[0] === '?.') {
    const recv = substitute(node[1], consts)
    return recv === node[1] ? node : [node[0], recv, ...node.slice(2)]
  }
  let out = null
  for (let i = 1; i < node.length; i++) {
    const next = substitute(node[i], consts)
    if (next !== node[i]) { if (!out) out = node.slice(); out[i] = next }
  }
  return out || node
}

export const guardConstants = () => {
  if (!optimizing()) return false
  let changed = false
  for (const func of ctx.funcs.list) {
    if (func.raw || !func.body) continue
    walkAst(func.body, { enter: (node) => {
      if (node[0] === '=>') return false
      if (node[0] !== 'if' || node[2] == null) return
      const consts = guarded(node[1])
      // a name the arm writes, or a closure may write, keeps its reads
      for (const name of consts.keys()) if (writes(node[2], name) || some(node[2], n => n[0] === '=>' && mentions(n, name))) consts.delete(name)
      if (!consts.size) return
      const arm = substitute(node[2], consts)
      if (arm !== node[2]) { node[2] = arm; changed = true }
    } })
  }
  return changed
}

// ── counted loops ───────────────────────────────────────────────────────────

/** `i++`, `i += s`, `i = i + s` with s an integer constant: the signed step, else 0. */
const stepOf = (step, name) => {
  if (!Array.isArray(step) || step[1] !== name) return 0
  if (step[0] === '++') return 1
  if (step[0] === '--') return -1
  if (step[0] === '+=' || step[0] === '-=') { const k = intOf(step[2]); return k == null ? 0 : step[0] === '+=' ? k : -k }
  if (step[0] === '=' && Array.isArray(step[2]) && (step[2][0] === '+' || step[2][0] === '-') && step[2][1] === name) {
    const k = intOf(step[2][2])
    return k == null ? 0 : step[2][0] === '+' ? k : -k
  }
  return 0
}
/** The name a cursor steps by, where the step is no constant: `c += sx`. */
const strideOf = (step) => Array.isArray(step) && (step[0] === '+=' || (step[0] === '=' && Array.isArray(step[2]) && step[2][0] === '+' && step[2][1] === step[1]))
  && typeof step[1] === 'string' ? (n => typeof n === 'string' && intOf(n) == null ? n : null)(step[0] === '+=' ? step[2] : step[2][2]) : null

/** Every read of `name` in `node` is an element index, behind constant offsets at most. */
const indexOnly = (node, name) => {
  let ok = true
  const affine = (n) => typeof n === 'string' || isInt(n) || (Array.isArray(n) && (n[0] === '+' || n[0] === '-') && n.length === 3 && affine(n[1]) && intOf(n[2]) != null)
  const visit = (n) => {
    if (!ok) return
    if (typeof n === 'string') { if (n === name) ok = false; return }
    if (!Array.isArray(n) || n[0] == null || n[0] === 'str') return
    if (n[0] === '[]' && n.length === 3 && mentions(n[2], name)) {
      if (!affine(n[2])) { ok = false; return }
      visit(n[1])
      return
    }
    if (n[0] === '.' || n[0] === '?.') { visit(n[1]); return }
    for (let i = 1; i < n.length; i++) visit(n[i])
  }
  visit(node)
  return ok
}

// `e` as `inv + coef·q + off`: `inv` the terms free of `q` (an expression, or
// null), `coef` and `off` integers. Null when `e` is not affine in `q`.
const affineIn = (e, q) => {
  if (e === q) return { inv: null, coef: 1, off: 0 }
  if (intOf(e) != null) return { inv: null, coef: 0, off: intOf(e) }
  if (typeof e === 'string') return { inv: e, coef: 0, off: 0 }
  if (!Array.isArray(e)) return null
  const free = () => mentions(e, q) ? null : { inv: e, coef: 0, off: 0 }
  if ((e[0] === '+' || e[0] === '-') && e.length === 3) {
    const a = affineIn(e[1], q), b = affineIn(e[2], q)
    if (!a || !b) return null
    const sign = e[0] === '+' ? 1 : -1
    const inv = b.inv == null ? a.inv : a.inv == null ? (sign > 0 ? b.inv : ['u-', b.inv]) : [e[0], a.inv, b.inv]
    return { inv, coef: a.coef + sign * b.coef, off: a.off + sign * b.off }
  }
  if (e[0] === '*' && e.length === 3 && (intOf(e[1]) != null || intOf(e[2]) != null)) {
    const first = intOf(e[1]) != null
    const x = intOf(first ? e[1] : e[2]), a = affineIn(first ? e[2] : e[1], q)
    if (!a) return null
    return { inv: a.inv == null ? null : scale(x, a.inv), coef: x * a.coef, off: x * a.off }
  }
  return free()
}
let sums = false   // set per run: whether a reduction may be rolled
const isIndexOf = (n, q) => Array.isArray(n) && n[0] === '[]' && n.length === 3 && mentions(n[2], q)

/**
 * An unrolled body rolled back: M copies of one group of statements, copy j
 * reading the elements j past copy 0 (or one reduction over M such terms), in
 * a loop that advances every index by M a trip. The copies run in element
 * order, so the unit loop over M·T elements runs the same operations in the
 * same order; a reduction adds its terms one by one where the source added
 * their sum, the reordering every lane reduction makes.
 * Returns { M, stmts } over the counter `q`, or null.
 */
function reroll(stmts, k, q) {
  let M = 0, ok = true
  const scan = (n, inIndex) => {
    if (!ok) return
    if (typeof n === 'string') { if (n === k && !inIndex) ok = false; return }
    if (!Array.isArray(n) || n[0] == null || n[0] === 'str') return
    if (isIndexOf(n, k)) {
      const a = affineIn(n[2], k)
      if (!a || a.coef < 2 || (M && a.coef !== M)) { ok = false; return }
      M = a.coef
      scan(n[1], false)
      return
    }
    if (n[0] === '.' || n[0] === '?.') { scan(n[1], inIndex); return }
    for (let j = 1; j < n.length; j++) scan(n[j], inIndex)
  }
  for (const st of stmts) scan(st, false)
  if (!ok || M < 2) return null
  // a statement with each index named by what it is affine in, copy `j` brought back to copy 0
  const norm = (n, j) => {
    if (!Array.isArray(n) || n[0] == null || n[0] === 'str') return n
    if (isIndexOf(n, k)) { const a = affineIn(n[2], k); return ['[]', norm(n[1], j), ['#', a.inv, a.coef, a.off - j]] }
    return n.map((c, at) => at ? norm(c, j) : c)
  }
  const same = (a, j, b) => JSON.stringify(norm(a, j)) === JSON.stringify(norm(b, 0))
  const rolled = (n) => {
    if (!Array.isArray(n) || n[0] == null || n[0] === 'str') return n
    if (isIndexOf(n, k)) { const a = affineIn(n[2], k); return like(n, ['[]', rolled(n[1]), ['+', a.inv == null ? lit(a.off) : add(a.inv, a.off), q]]) }
    return like(n, n.map((c, at) => at ? rolled(c) : c))
  }
  if (stmts.length % M === 0 && stmts.length >= M) {
    const g = stmts.length / M
    let copies = true
    for (let j = 1; j < M && copies; j++) for (let r = 0; r < g && copies; r++) if (!same(stmts[j * g + r], j, stmts[r])) copies = false
    if (copies) return { M, stmts: stmts.slice(0, g).map(rolled) }
  }
  if (sums && stmts.length === 1 && Array.isArray(stmts[0]) && stmts[0][0] === '+=' && typeof stmts[0][1] === 'string') {
    const terms = []
    const flat = (e) => { if (Array.isArray(e) && e[0] === '+' && e.length === 3) { flat(e[1]); terms.push(e[2]) } else terms.push(e) }
    flat(stmts[0][2])
    if (terms.length === M && !terms.some(t => mentions(t, stmts[0][1])) && terms.every((t, j) => same(t, j, terms[0])))
      return { M, stmts: [like(stmts[0], ['+=', stmts[0][1], rolled(terms[0])])] }
  }
  return null
}

function canonicalize(node, parent, idx, live, captured, view) {
  const [, init, test, step, body] = node
  if (!Array.isArray(init) || init[0] !== 'let' || init.length !== 2 || !Array.isArray(init[1]) || init[1][0] !== '=' || typeof init[1][1] !== 'string') return false
  const i = init[1][1], start = init[1][2]
  if (!Array.isArray(test) || (test[0] !== '<' && test[0] !== '<=') || test[1] !== i) return false
  const bound = test[2], incl = test[0] === '<='
  const s = stepOf(step, i)
  if (s <= 0 || !pure(bound, view) || !pure(start, view) || mentions(bound, i) || captured.has(i)) return false
  for (const name of namesOf(bound)) if (captured.has(name) || ctx.scope.globals.has(name) && !ctx.scope.constInts?.has(name)) return false
  if (some(body, n => n[0] === '=>' || n[0] === 'break' || n[0] === 'continue' || n[0] === ':' || n[0] === 'label')) return false
  if (writes(body, i)) return false
  for (const name of namesOf(bound)) if (writes(body, name)) return false

  // cursors: one constant step, a statement of the body, no other write
  const stmts = stmtList(body) ?? [body]
  const cursors = []
  for (let at = 0; at < stmts.length; at++) {
    const st = stmts[at], name = Array.isArray(st) && MUTATE_OPS.has(st[0]) && typeof st[1] === 'string' ? st[1] : null
    if (name == null || name === i || ctx.scope.globals.has(name) || captured.has(name)) continue
    const K = stepOf(st, name)
    if (!K) continue
    let count = 0
    walkAst(body, { enter: n => { if (MUTATE_OPS.has(n[0]) && n[1] === name) count++ } })
    if (count !== 1 || mentions(bound, name)) continue
    const rest = stmts.filter((_, j) => j !== at)
    if (!rest.every(r => indexOnly(r, name))) continue
    cursors.push({ name, K, at })
  }
  if (cursors.length === stmts.length) return false   // nothing but steps
  const reads = [i, ...cursors.map(c => c.name)]
  if (!some(body, n => n[0] === '[]' && n.length === 3 && reads.some(r => mentions(n[2], r)))) return false
  const startAt = intOf(start)
  if (Object.is(startAt, -0)) return false
  const computed = startAt == null

  // The body over the trip number `k`: the counter is `a + s·k`, a cursor `c + K·k`.
  const k = fresh('clk'), a = fresh('cla')
  const entries = new Map(cursors.map(c => [c.name, { ...c, entry: fresh('clc') }]))
  const overTrips = (n, at) => {
    if (typeof n === 'string') {
      if (n === i) return computed ? ['+', a, scale(s, k)] : add(scale(s, k), startAt)
      const c = entries.get(n)
      if (!c) return n
      return add(['+', c.entry, scale(c.K, k)], at > c.at ? c.K : 0)
    }
    if (!Array.isArray(n) || n[0] == null || n[0] === 'str') return n
    if (n[0] === '.' || n[0] === '?.') return like(n, [n[0], overTrips(n[1], at), ...n.slice(2)])
    return like(n, [n[0], ...n.slice(1).map(c => overTrips(c, at))])
  }
  const kept = []
  stmts.forEach((st, at) => { if (!entries.has(st[1]) || entries.get(st[1]).at !== at) kept.push(overTrips(st, at)) })

  const q = fresh('clq')
  const roll = s > 1 || cursors.some(c => Math.abs(c.K) > 1) ? reroll(kept, k, q) : null
  // A literal-start loop without secondary cursors already has canonical
  // addresses. Float cursors need this guarded rewrite before lane matching.
  if (!roll && !computed && !cursors.length) return false
  const own = false

  includeModule('math')
  const MAX = 0x7fffffff
  const pre = [], post = []
  const v = computed ? fresh('cls') : null
  if (computed) pre.push(['const', ['=', v, start]])
  const from = computed ? v : lit(startAt)

  // Trips: the closed form, then one comparison each way, so a bound between
  // two counter values counts as the loop's own test does.
  const needTrips = !own || cursors.some(c => live(c.name))
  const trips = needTrips ? fresh('clt') : null
  if (needTrips) {
    const span = ['-', cloneNode(bound), cloneNode(from)]
    const at = (n) => ['+', cloneNode(from), scale(s, n)]
    const cmp = incl ? '<=' : '<'
    pre.push(['let', ['=', trips, incl
      ? ['+', call('math.floor', s === 1 ? span : ['/', span, lit(s)]), lit(1)]
      : call('math.ceil', s === 1 ? span : ['/', span, lit(s)])]])
    pre.push(['if', [cmp, at(trips), cloneNode(bound)], ['=', trips, ['+', trips, lit(1)]]])
    pre.push(['if', ['&&', ['>', trips, lit(0)], ['!', [cmp, at(['-', trips, lit(1)]), cloneNode(bound)]]], ['=', trips, ['-', trips, lit(1)]]])
    pre.push(['if', ['!', ['>', trips, lit(0)]], ['=', trips, lit(0)]])
  }
  const setup = cursors.map(c => ['const', ['=', entries.get(c.name).entry, ['|', c.name, lit(0)]]])
  for (const c of cursors) if (live(c.name)) post.push(['=', c.name, ['+', entries.get(c.name).entry, scale(c.K, trips)]])

  let out
  if (own) {
    // `k` is `(i − start) / s`: every coefficient of it is a multiple of s
    const back = (n) => {
      if (n === k) return null
      if (!Array.isArray(n) || n[0] == null || n[0] === 'str') return n
      if (n[0] === '*' && n.length === 3 && isInt(n[1]) && n[2] === k) return add(scale(n[1][1] / s, i), -(n[1][1] / s) * startAt)
      return like(n, n.map((c, at) => at ? (c === k ? (s === 1 ? add(i, -startAt) : ['/', add(i, -startAt), lit(s)]) : back(c)) : c))
    }
    const ownBody = kept.map(back)
    out = [...pre, ...setup, ['for', init, test, step, ['{}', ownBody.length === 1 ? ownBody[0] : [';', ...ownBody]]], ...post]
  } else {
    const M = roll ? roll.M : 1
    const counter = roll ? q : k
    const run = roll ? roll.stmts : kept
    const count = fresh('cln')
    // under the test the start is an integer and the trips fit a counter
    const tests = [['<=', trips, lit(Math.floor(MAX / M))], ['<=', cloneNode(bound), lit(MAX)]]
    if (computed) tests.unshift(['===', v, call('math.floor', v)], ['<=', call('math.abs', v), lit(MAX)],
      ['||', ['!==', v, lit(0)], ['>', ['/', lit(1), v], lit(0)]])
    // Index use does not make the stored cursor an int32. Preserve fractional,
    // unsigned and signed-zero entries, and every update through the landing.
    for (const c of cursors) {
      const end = ['+', c.name, scale(c.K, trips)]
      tests.push(numberGuard(c.name), ['===', c.name, ['|', c.name, lit(0)]],
        ['||', ['!==', c.name, lit(0)], ['>', ['/', lit(1), c.name], lit(0)]],
        ['>=', end, lit(-2147483648)], ['<=', cloneNode(end), lit(MAX)])
    }
    const guard = tests.reduce((l, r) => ['&&', l, r])
    const fast = [
      ...(computed ? [['const', ['=', a, ['|', v, lit(0)]]]] : []),
      ['const', ['=', count, ['|', scale(M, trips), lit(0)]]],
      ...setup,
      ['for', ['let', ['=', counter, lit(0)]], ['<', counter, count], ['++', counter], ['{}', run.length === 1 ? run[0] : [';', ...run]]],
      ...post,
    ]
    out = [...pre, ['if', guard, ['{}', [';', ...fast]], ['{}', [';', ['for', ['let', ['=', i, from]], test, step, body]]]]]
  }
  parent[idx] = out.length === 1 ? out[0] : ['{}', [';', ...out]]
  return true
}

/**
 * A cursor stepped by a name (`ix += strideX`) walks its array one element at a
 * time when the name is 1, the stride nearly every caller passes: the loop is
 * versioned on it, `if (sx === 1 && sy === 1) L[1] else L`, and the unit copy
 * reads like any other. Not where the same test, on an arm that leaves the
 * function, already stands ahead of the loop: there it cannot hold.
 */
function versionUnitStride(node, parent, idx, captured) {
  const body = node[4]
  if (some(body, n => n[0] === '=>')) return false
  const names = new Set()
  const stmts = stmtList(body) ?? [body]
  for (let at = 0; at < stmts.length; at++) {
    const st = stmts[at], name = strideOf(st)
    if (name == null) continue
    if (ctx.scope.globals.has(name) || ctx.scope.globals.has(st[1]) || captured.has(name) || captured.has(st[1]) || writes(body, name) || writes(node[3], name)) return false
    // a cursor indexes an array; an accumulator stepped by a parameter (`acc = acc + p`) is none
    if (!stmts.some((r, j) => j !== at && some(r, n => n[0] === '[]' && n.length === 3 && mentions(n[2], st[1])))) continue
    if (!stmts.every((r, j) => j === at || indexOnly(r, st[1]))) continue
    names.add(name)
  }
  if (!names.size) return false
  const key = [...names].sort().join()
  if (Array.isArray(parent) && parent[0] === ';') for (let j = 1; j < idx; j++) {
    const st = parent[j]
    if (Array.isArray(st) && st[0] === 'if' && [...guarded(st[1]).entries()].filter(([, v]) => v === 1).map(([n]) => n).sort().join() === key && leaves(st[2])) return false
  }
  const consts = new Map([...names].map(n => [n, 1]))
  const unit = substitute(cloneNode(node), consts)
  const test = [...names].map(n => ['===', n, lit(1)]).reduce((l, r) => ['&&', l, r])
  parent[idx] = ['if', test, ['{}', [';', unit]], ['{}', [';', node]]]
  return true
}
/** Every path through `n` leaves the function. */
const leaves = (n) => {
  if (!Array.isArray(n)) return false
  if (n[0] === 'return' || n[0] === 'throw') return true
  if (n[0] === '{}' && n.length === 2) return leaves(n[1])
  if (n[0] === ';') return leaves(n[n.length - 1])
  if (n[0] === 'if') return n.length > 3 && leaves(n[2]) && leaves(n[3])
  return false
}

export const canonicalizeCountedLoops = () => {
  const cfg = ctx.transform.optimize
  if (!cfg || !cfg.countedLoops) return false
  // a rolled reduction adds term by term: the order the lane reductions take, allowed where they are
  sums = !!cfg.vectorizeLaneLocal && !cfg.noSimd
  let changed = false
  for (const func of ctx.funcs.list) {
    if (func.raw || !func.body) continue
    const captured = new Set(), guarded = new Set()
    let protectedDepth = 0
    const strided = []
    walkAst(func.body, { enter: (node, parent, idx) => {
      if (node[0] === '=>') {
        walkAst(node, { enter: m => { for (let j = 1; j < m.length; j++) if (typeof m[j] === 'string') captured.add(m[j]) } })
        return false
      }
      if (TRY.has(node[0])) protectedDepth++
      if (node[0] === 'for' && node.length === 5 && parent) {
        // An exception bypasses delayed cursor writeback; its handler must
        // observe every update made before the throwing operation.
        if (protectedDepth) guarded.add(node)
        else strided.push([node, parent, idx])
      }
    }, exit: node => { if (TRY.has(node[0])) protectedDepth-- } })
    for (const [node, parent, idx] of strided) if (parent[idx] === node && versionUnitStride(node, parent, idx, captured)) changed = true
    const loops = []
    walkAst(func.body, { enter: (node, parent, idx) => {
      if (node[0] === '=>') return false
      if (guarded.has(node)) return false
      if (node[0] === 'for' && node.length === 5 && parent) loops.push([node, parent, idx])
    } })
    let levels = null
    const view = loops.length ? ctx.summary.at(func.sig) : null
    for (const [node] of loops) if (offsetTest(node, func, () => levels ??= intLevelMap(func.body))) changed = true
    // innermost first: an outer loop is matched over its rewritten body
    for (let n = loops.length - 1; n >= 0; n--) {
      const [node, parent, idx] = loops[n]
      if (parent[idx] !== node) continue
      // a cursor lives on when anything outside the loop names it, or an enclosing loop runs the loop again
      const nested = loops.some(([outer]) => outer !== node && some(outer, m => m === node))
      const live = (name) => nested || occursOutside(func.body, node, name)
      if (canonicalize(node, parent, idx, live, captured, view)) changed = true
    }
  }
  return changed
}

/**
 * `for (let i = a; i + c < n; i++)`, a an integer literal at least 0, c an
 * integer, n a length (a typed array's, or a name only ever given one; or
 * `<=`, or `c + i`): the test is `i < n − c`, the
 * difference taken once as the loop begins. Then the counter's own bound
 * is a length less a loop constant, the form the extent proofs and the lane
 * recognizers read, where the sum was a new value each trip. Exact: while
 * the loop runs i + c is at most n, a length below 2^53, so neither side
 * rounds; where it never runs (c at least n − a) both fail the first test,
 * and a NaN or an infinite c decides both alike. Neither c nor n is written
 * in the loop, by a closure, or anywhere a call reaches (a global), so the
 * difference is what every trip computed.
 */
function offsetTest(node, func, levels) {
  const [, init, test, step, body] = node
  if (!Array.isArray(init) || init[0] !== 'let' || !Array.isArray(init[1]) || init[1][0] !== '=' || typeof init[1][1] !== 'string') return false
  const i = init[1][1], a = init[1][2]
  if (!isInt(a) || a[1] < 0) return false
  if (!Array.isArray(step) || step[1] !== i || !(step[0] === '++' || (step[0] === '+=' && isInt(step[2]) && step[2][1] === 1))) return false
  if (!Array.isArray(test) || (test[0] !== '<' && test[0] !== '<=') || !Array.isArray(test[1]) || test[1][0] !== '+' || test[1].length !== 3) return false
  const c = test[1][1] === i ? test[1][2] : test[1][2] === i ? test[1][1] : null, n = test[2]
  if (c == null || writes(body, i)) return false
  // loop constants: a local no write in the loop, no closure and no call reaches
  const steady = (name) => typeof name === 'string' && name !== i && !ctx.scope.globals.has(name) && !writes(body, name) &&
    !some(func.body, m => m[0] === '=>' && writes(m, name), { skipArrow: false })
  if (!(isInt(c) || (steady(c) && levels().get(c) >= 1))) return false
  // a length: a name every write of which is one, or a typed array's (a list's grows)
  const isLength = (e) => Array.isArray(e) && e[0] === '.' && e[2] === 'length' && typeof e[1] === 'string'
  if (isLength(n)) {
    const k = ctx.summary?.at(func.sig)?.kindOf(n[1])
    if (!steady(n[1]) || k == null || tagOf(core(k)) !== K.TYPED) return false
  } else {
    if (!steady(n)) return false
    let defs = 0, lengths = 0
    const declared = new Set()
    walkAst(func.body, { enter: (m) => {
      if (m[0] === 'let' || m[0] === 'const') for (let j = 1; j < m.length; j++) {
        const d = m[j]
        if (d === n) defs++
        else if (Array.isArray(d) && d[0] === '=' && d[1] === n) { declared.add(d); defs++; if (isLength(d[2])) lengths++ }
      }
      else if (MUTATE_OPS.has(m[0]) && m[1] === n && !declared.has(m)) defs++
    } })
    if (defs === 0 || defs !== lengths) return false
  }
  const lim = fresh('clb')
  node[1] = like(init, [...init, ['=', lim, ['-', cloneNode(n), cloneNode(c)]]])
  node[2] = like(test, [test[0], i, lim])
  return true
}

/** `name` is read or written in `root` outside `loop`, its bare declaration aside. */
export function occursOutside(root, loop, name) {
  let seen = 0
  const visit = (n, declared) => {
    if (n === loop) return
    if (typeof n === 'string') { if (n === name && !declared) seen++; return }
    if (!Array.isArray(n) || n[0] == null || n[0] === 'str') return
    if (n[0] === '.' || n[0] === '?.') { visit(n[1], false); return }
    if (n[0] === 'let' || n[0] === 'const') {
      for (let j = 1; j < n.length; j++) {
        const d = n[j]
        if (typeof d === 'string') continue
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') visit(d[2], false)
        else visit(d, false)
      }
      return
    }
    // the value a plain write stores is no read of the name it writes
    if (n[0] === '=' && n[1] === name) { visit(n[2], false); return }
    for (let j = 1; j < n.length; j++) visit(n[j], false)
  }
  visit(root, false)
  return seen > 0
}
