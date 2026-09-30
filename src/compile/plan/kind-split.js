/**
 * A loop reading elements of a name that may hold a typed array or something
 * else runs, where it holds the typed array, as a copy over a fresh name of
 * that array's kind.
 *
 * `exc = exciter === 'impulse' ? impulse : exciter` (a Float32Array, or a
 * string a caller passed), then `exc[i]` and `exc.length` per sample: a value
 * of several kinds, so each read dispatches on what it holds. Where
 * `exc instanceof Float32Array`, a copy of the loop over `const exc′ = exc`
 * reads its elements as Float32 loads (summary: the class test proves the
 * element kind); the loop itself is the other arm. The same values are read
 * in the same order, so what the program does is the same in both.
 *
 * The names: those the loop reads elements or a length of, and writes
 * nowhere in it, whose kind holds a typed array among other kinds (or a typed
 * array of an element kind it does not know); the class, the one typed array
 * constructor their writes name (a `new Float32Array(…)`, an arm of a
 * conditional of one). A loop with a closure, a label or a suspension in it
 * is left alone, and one too large to copy twice.
 *
 * @module compile/plan/kind-split
 */
import { ctx } from '../../ctx.js'
import { T, ASSIGN_OPS, extractParams, some, walkAst } from '../../ast.js'
import { freshId } from '../../ir.js'
import { cloneWithSubst } from '../../type.js'
import { collectBindings, nodeSize } from './common.js'
import { K, core, hasTag, tagOf, typedAux, UNKNOWN } from '../../summary/kind.js'
import { invalidateBodies } from '../analyze.js'
import { invalidateProgramFactsCache } from '../program-facts.js'

const LOOPS = new Set(['for', 'while'])
const MAX_SIZE = 4000, MAX_CTORS = 3

/** The names `node` reads elements (`x[i]`) or a length (`x.length`) of. */
const receivers = (node) => {
  const out = new Set()
  walkAst(node, { enter: (n) => {
    if (n[0] === '=>') return false
    if ((n[0] === '[]' || n[0] === '?.[]') && typeof n[1] === 'string') out.add(n[1])
    if ((n[0] === '.' || n[0] === '?.') && n[2] === 'length' && typeof n[1] === 'string') out.add(n[1])
  } })
  return out
}

/** The names `node` writes (an assignment's or an update's target). */
const writtenIn = (node) => {
  const out = new Set()
  walkAst(node, { enter: (n) => {
    if ((ASSIGN_OPS.has(n[0]) || n[0] === '++' || n[0] === '--') && typeof n[1] === 'string') out.add(n[1])
  } })
  return out
}

/** Each value `name` is given in `body` (a declaration's or an assignment's), or null for one of no value. */
const valuesOf = (body, name) => {
  const out = []
  walkAst(body, { enter: (n) => {
    if (n[0] === '=>') return false
    if (n[0] === 'let' || n[0] === 'const') for (let i = 1; i < n.length; i++) {
      if (n[i] === name) out.push(null)
      else if (Array.isArray(n[i]) && n[i][0] === '=' && n[i][1] === name) out.push(n[i][2])
    }
    else if (n[0] === '=' && n[1] === name) out.push(n[2])
    else if (ASSIGN_OPS.has(n[0]) && n[1] === name) out.push(null)
  } })
  return out
}

const ctorName = (c) => { const m = typeof c === 'string' && /^new\.(\w+Array)(\.view|\.anyview)?$/.exec(c); return m ? m[1] : null }

/** The typed array constructor names the leaves of `e` (its conditional's arms,
 *  its `||`/`??` operands) hold: through a local's values, and a parameter's
 *  (an element of one, of the argument list a rest parameter gathers) by what
 *  the function's callers pass there (`f([out[0], out[1]])`, `f(out[0])`). A
 *  caller's argument of no one constructor that is a parameter of the function
 *  the call sits in, never reassigned (`source`, which a tracker's closure hands
 *  on), is what that function's callers pass, two functions out. */
const ctorsOf = (e, cx, out, depth = 0) => {
  for (const [view, x, site] of sources(e, cx, new Set())) {
    const c = ctorName(view.typedPayloadCtorOfExpr(x))
    if (c) { out.add(c); continue }
    // a call of one of several functions: what each returns
    const called = view.callResultCtors(x)
    if (called) { for (const r of called) { const n = ctorName(r); if (n) out.add(n) } continue }
    const f = site?.callerFunc
    const at = depth < 2 && typeof x === 'string' && f?.sig && f.body && cx.programFacts ? f.sig.params.findIndex(p => p.name === x) : -1
    if (at < 0 || f.rest === x || valuesOf(f.body, x).length) continue
    const sites = cx.programFacts.callSites.filter(cs => cs.callee === f.name && !cs.synthetic)
    ctorsOf(x, { view: ctx.summary.at(f.sig), params: f.sig.params.map(p => p.name), rest: f.rest, sites, func: f, body: f.body, programFacts: cx.programFacts }, out, depth + 1)
  }
}

// The view a call site's arguments read in: its function's, or the innermost
// closure's around it (`(inputs, outputs) => { … kernel([out[0], out[1]]) }`).
const scopes = new WeakMap()
const callerView = (site) => {
  const f = site.callerFunc
  if (!f?.body || !f.sig) return null
  let m = scopes.get(f)
  if (!m) {
    scopes.set(f, m = new Map())
    const walk = (n, scope) => {
      if (!Array.isArray(n)) return
      if (n[0] === '=>') { walk(n[2], n[1]); return }
      if (n[0] === '()') m.set(n, scope)
      for (let i = 1; i < n.length; i++) walk(n[i], scope)
    }
    walk(f.body, null)
  }
  const scope = m.get(site.node)
  return ctx.summary.at(scope ?? f.sig)
}

/** Where the value of `e` comes from, as expressions and the views that read them. */
const sources = (e, cx, seen) => {
  const { view, params, rest, sites, func } = cx
  const bySites = (f) => sites.flatMap(site => {
    const cv = callerView(site)
    const a = cv && f(site.argList)
    return a == null ? [] : [[cv, a, site]]
  })
  if (Array.isArray(e) && e[0] === '?:') return [...sources(e[2], cx, seen), ...sources(e[3], cx, seen)]
  if (Array.isArray(e) && (e[0] === '||' || e[0] === '??')) return [...sources(e[1], cx, seen), ...sources(e[2], cx, seen)]
  if (typeof e === 'string') {
    const at = params.indexOf(e)
    if (at >= 0 && e !== rest) return bySites(args => args[at])
    if (seen.has(e) || at >= 0) return [[view, e]]
    seen.add(e)
    // a declaration of no value holds undefined: no constructor
    const values = valuesOf(cx.body ?? func.body, e).filter(v => v != null)
    return values.length ? values.flatMap(v => sources(v, cx, seen)) : [[view, e]]
  }
  if (Array.isArray(e) && e[0] === '[]') {
    const k = Array.isArray(e[2]) && e[2][0] == null && Number.isInteger(e[2][1]) ? e[2][1] : null
    if (e[1] === rest && k != null) return bySites(args => args[k])
    // an element of a list literal is the expression written there (`[out[0], out[1]]`)
    return sources(e[1], cx, seen).map(([v, x, s]) => Array.isArray(x) && x[0] === '[' && k != null && k + 1 < x.length &&
      !x.slice(1).some(y => Array.isArray(y) && y[0] === '...') ? [v, x[k + 1], s] : [v, ['[]', x, e[2]], s])
  }
  return [[view, e]]
}

/** Split the loops of one body: a function's, or a closure's with its own view. */
const splitBody = (func, body, view, params, rest, programFacts) => {
  // what a closure of the body names, it reads or writes where the copy cannot see
  const captured = new Set()
  walkAst(body, { enter: (n) => {
    if (n[0] !== '=>') return
    walkAst(n, { enter: (m) => { for (let i = 1; i < m.length; i++) if (typeof m[i] === 'string') captured.add(m[i]) } })
    return false
  } })
  const locals = new Set(params)
  collectBindings(body, locals)
  // every loop, outer first: a nest is copied whole under one test
  const loops = []
  walkAst(body, { enter: (node, parent, idx) => {
    if (node[0] === '=>') return false
    if (LOOPS.has(node[0]) && parent) loops.push([node, parent, idx])
  } })
  const done = new Set()
  let rewrote = false, sites = null
  for (const [loop, parent, idx] of loops) {
    if (done.has(loop) || parent[idx] !== loop || nodeSize(loop) > MAX_SIZE) continue
    if (some(loop, n => n[0] === '=>' || n[0] === 'label' || n[0] === 'yield' || n[0] === 'await')) continue
    // a `for`'s own declarations (`for (let x = ch[c], i = 0; …)`) go before the test, the copy and the loop sharing them
    const init = loop[0] === 'for' && loop.length === 5 && Array.isArray(loop[1]) && (loop[1][0] === 'let' || loop[1][0] === 'const') ? loop[1] : null
    const bare = init ? ['for', null, loop[2], loop[3], loop[4]] : loop
    const own = new Set(), inner = new Set()
    if (init) collectBindings(init, own)
    collectBindings(bare, inner)
    const writes = writtenIn(bare)
    // a name of several kinds, a typed array among them, and the constructors its values name:
    // one each, or up to three for one of the names (a Float32Array a caller passes, a Float64Array another
    // does) where the loop only reads that name's elements: a loop storing into it is versioned by
    // width after emission (optimize/unswitch.js), one copy per width instead of one per constructor
    const storedInto = (n) => some(bare, m => ASSIGN_OPS.has(m[0]) && Array.isArray(m[1]) && m[1][0] === '[]' && m[1][1] === n)
    const split = []
    let multi = null
    for (const n of receivers(bare)) {
      if (!(locals.has(n) || own.has(n)) || inner.has(n) || writes.has(n) || captured.has(n) || ctx.funcs.names.has(n)) continue
      const k = view.kindOf(n)
      if (k == null || !hasTag(k, K.TYPED) || (tagOf(core(k)) === K.TYPED && typedAux(k) !== UNKNOWN)) continue
      const ctors = new Set()
      sites ??= programFacts?.callSites.filter(cs => cs.callee === func.name && !cs.synthetic && func.body === body) ?? []
      ctorsOf(n, { view, params, rest, sites, func, body, programFacts }, ctors)
      if (ctors.size === 1) split.push([n, [...ctors][0]])
      else if (ctors.size > 1 && ctors.size <= MAX_CTORS && !multi && !storedInto(n)) multi = [n, [...ctors]]
    }
    if (!split.length && !multi) continue
    // a copy per constructor of the one name, each under its own test beside the others'; the loop last
    const arms = multi ? multi[1].map(c => [...split, [multi[0], c]]) : [split]
    let choice = ['{}', [';', bare]]
    for (const arm of arms.reverse()) {
      const fresh = new Map([...arm.map(([n]) => n), ...inner].map(n => [n, `${n}${T}k${freshId(ctx)}`]))
      const copy = cloneWithSubst(bare, new Map(), fresh)
      const test = arm.map(([n, c]) => ['instanceof', n, c]).reduce((a, b) => ['&&', a, b])
      choice = ['if', test, ['{}', [';', ['const', ...arm.map(([n]) => ['=', fresh.get(n), n])], copy]], choice]
    }
    parent[idx] = init ? ['{}', [';', init, choice]] : choice
    walkAst(loop, { enter: (n) => { if (LOOPS.has(n[0])) done.add(n) } })
    rewrote = true
  }
  return rewrote
}

export const splitLoopKinds = (programFacts) => {
  if (ctx.transform.optimize?.splitLoopKinds === false) return false
  let changed = false
  for (const func of ctx.funcs.list) {
    if (func.raw || !func.body) continue
    const view = ctx.summary?.at(func.sig)
    if (!view) continue
    let rewrote = splitBody(func, func.body, view, (func.sig?.params ?? []).map(p => p.name), func.rest, programFacts)
    // a closure's loops, in its own body with its own view
    walkAst(func.body, { enter: (n) => {
      if (n[0] !== '=>') return
      const cv = ctx.summary.at(n[1])
      const ps = extractParams(n[1]).filter(p => typeof p === 'string')
      if (cv && splitBody(func, n[2], cv, ps, null, null)) rewrote = true
    } })
    // rewritten in place: the facts cached for the body describe what it was
    if (rewrote) { invalidateProgramFactsCache(func.body); invalidateBodies([func.body]); changed = true }
  }
  return changed
}
