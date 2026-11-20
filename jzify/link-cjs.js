/**
 * esbuild's CommonJS modules, linked at compile time.
 *
 * esbuild keeps a CommonJS module as a function it calls at the module's first
 * `require` (`var require_x = __commonJS({ "x.js"(exports, module) { … } })`),
 * its exports an object the function fills. Everything the module declares is
 * then a function's local and everything it takes from another module a
 * property read at run time: a class in it is a class of closures, a class
 * deriving another module's builds its instance from a base it cannot name.
 *
 * Where a module is required only as its requirers start (a `require_x()` in a
 * statement of the bundle's own or of another such module's body) its body runs
 * where the source is written. Such a module is linked: its body's statements
 * stand at the module level, at its first require; each export is a const of
 * the value it was given (`exports.k = v`, `module.exports = { k: v }`,
 * `module.exports = v`); what a requirer takes from it is a const of that
 * export. A name its body declares that is spelled anywhere else in the bundle
 * takes a new one (rename.js).
 *
 * A module anything else is done with stays as esbuild wrote it: one required
 * inside a function or under a condition (it runs when that does), one in a
 * cycle, one whose `exports` or `module` is read or passed on, one whose body
 * returns or reads `this` or `arguments`, and every module such a one requires.
 *
 * @module jzify/link-cjs
 */

import { bindingOf, moduleStmts, nodeEqual, literalString, withLoc, collectParamNames, MUTATE_OPS } from '../src/ast.js'
import { warn } from '../src/ctx.js'
import { rename, occurs, free, spells } from './rename.js'
import { readUndefined } from './hoist-vars.js'

const LIT0 = [, 0]
const OWN_NAMES = ['.', 'Object', 'getOwnPropertyNames']
// The value esbuild's helper answers, which calls a module's function once and keeps its
// exports: `mod || (0, cb[names(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports`.
const memoCall = (cb, mod, names) => [',',
  ['||', mod, ['()', ['()', [',', LIT0, ['[]', cb, ['[]', ['()', names, cb], LIT0]]]],
    [',', ['.', ['()', ['=', mod, ['{}', [':', 'exports', ['{}', null]]]]], 'exports'], mod]]],
  ['.', mod, 'exports']]

/** Whether `init` is esbuild's `__commonJS`: `(cb, mod) => function () { return <memoCall> }`, alone or in its `try`. */
const isRequireHelper = (init, nameFns) => {
  if (!Array.isArray(init) || init[0] !== '=>' || !Array.isArray(init[1]) || init[1][0] !== '()') return false
  const ps = init[1][1], fn = init[2]
  if (!Array.isArray(ps) || ps[0] !== ',' || ps.length !== 3 || typeof ps[1] !== 'string' || typeof ps[2] !== 'string') return false
  if (!Array.isArray(fn) || fn[0] !== 'function' || fn[2] != null) return false
  const cb = ps[1], mod = ps[2], body = fn[3]
  const returns = (n, names) => Array.isArray(n) && n[0] === 'return' && nodeEqual(n[1], memoCall(cb, mod, names))
  const whole = (names) => returns(body, names) || Array.isArray(body) && body[0] === 'try' && body.length === 3 && returns(body[1], names) &&
    Array.isArray(body[2]) && body[2][0] === 'catch' && typeof body[2][1] === 'string' &&
    nodeEqual(body[2][2], ['throw', [',', ['=', mod, LIT0], body[2][1]]])
  return whole(OWN_NAMES) || nameFns.some(whole)
}

const count = (n, name) => n === name ? 1 : Array.isArray(n) ? n.reduce((s, c, i) => i ? s + count(c, name) : s, 0) : 0
/** How many times each text is spelled in a tree. */
const tally = (n, out) => {
  if (typeof n === 'string') out.set(n, (out.get(n) ?? 0) + 1)
  else if (Array.isArray(n)) for (let i = 1; i < n.length; i++) tally(n[i], out)
  return out
}
// a module's import and export forms, which a body has none of (rename.js refuses them)
const moduleForm = (n) => Array.isArray(n) && (n[0] === 'import' || n[0] === 'export' || n[0] === 'from' || n[0] === 'as' || n.some((c, i) => i > 0 && moduleForm(c)))
const isFn = (n) => Array.isArray(n) && (n[0] === 'function' || n[0] === 'function*')
// A body's own `this` or `arguments` (an arrow reads the body's), or a `return` of the body's own.
const ownsBody = (n, arrow = false) => (n === 'this' || n === 'arguments') || Array.isArray(n) && !isFn(n) && n[0] !== 'class' && n[0] !== 'get' && n[0] !== 'set' &&
  (n[0] === 'return' && !arrow || n.some((c, i) => i > 0 && ownsBody(c, arrow || n[0] === '=>')))
const stmtsOf = (body) => body == null ? [] : Array.isArray(body) && body[0] === ';' ? body.slice(1) : [body]
const isDirective = (s) => Array.isArray(s) && s[0] == null && s.length === 2 && typeof s[1] === 'string'
const members = (inner) => inner == null ? [] : Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : [inner]
// a key a const can take its name from
const isName = (k) => typeof k === 'string' && /^[A-Za-z_$][\w$]*$/.test(k)
const namesIn = (s, name) => Array.isArray(s) && s[0] === 'let' ? s.reduce((n, d, i) => n + (i > 0 && d === name ? 1 : 0), 0) : 0

/** The names a statement of a body declares in the body's scope. */
const declares = (s, out) => {
  if (!Array.isArray(s)) return
  if (s[0] === 'let' || s[0] === 'const') collectParamNames(s.slice(1), out)
  else if ((isFn(s) || s[0] === 'class') && typeof s[1] === 'string') out.add(s[1])
  else if (s[0] === 'async' && isFn(s[1]) && typeof s[1][1] === 'string') out.add(s[1][1])
}

/** A statement that takes from a require, or null: `require_x()` alone, `n = require_x()`,
 *  `{ a, b: c } = require_x()`, `n = require_x().k`, each as an assignment or a declaration. */
const requireSite = (s, isRequire) => {
  if (!Array.isArray(s)) return null
  const call = (n) => Array.isArray(n) && n[0] === '()' && n.length === 3 && n[2] == null && typeof n[1] === 'string' && isRequire(n[1]) ? n[1] : null
  if (call(s)) return { req: call(s), kind: 'bare', names: [] }
  const d = s[0] === '=' ? s : (s[0] === 'let' || s[0] === 'const') && s.length === 2 && Array.isArray(s[1]) && s[1][0] === '=' ? s[1] : null
  if (!d) return null
  const declared = d !== s
  if (call(d[2]) && typeof d[1] === 'string') return { req: call(d[2]), kind: 'whole', names: [d[1]], declared }
  if (call(d[2]) && Array.isArray(d[1]) && d[1][0] === '{}' && d[1].length === 2) {
    const picks = members(d[1][1]).map(m => typeof m === 'string' ? [m, m] : Array.isArray(m) && m[0] === ':' && typeof m[1] === 'string' && typeof m[2] === 'string' ? [m[1], m[2]] : null)
    return picks.every(Boolean) ? { req: call(d[2]), kind: 'picks', picks, names: picks.map(p => p[1]), declared } : null
  }
  if (Array.isArray(d[2]) && d[2][0] === '.' && call(d[2][1]) && typeof d[1] === 'string')
    return { req: call(d[2][1]), kind: 'picks', picks: [[d[2][2], d[1]]], names: [d[1]], declared }
  return null
}

/** What a body exports, or null where its `exports` or `module` is used any other way:
 *  `names` an export's key to the index of its one statement, `value` the index of `module.exports = v` or -1. */
const exportsOf = (list, exp, mod) => {
  const names = new Map()
  let value = -1
  for (let i = 0; i < list.length; i++) {
    const s = list[i]
    if (!Array.isArray(s) || s[0] !== '=' || !Array.isArray(s[1]) || s[1][0] !== '.') continue
    if (exp && s[1][1] === exp && isName(s[1][2])) {
      if (names.has(s[1][2]) || value >= 0) return null
      names.set(s[1][2], i)
    } else if (mod && s[1][1] === mod && s[1][2] === 'exports') {
      if (names.size || value >= 0) return null
      value = i
    }
  }
  const all = [';', ...list]
  if ((exp ? occurs(all, exp) : 0) + (mod ? occurs(all, mod) : 0) !== names.size + (value >= 0 ? 1 : 0)) return null
  return { names, value }
}

/** An object literal's members as pairs of a key and a value: null where one is neither a pair nor a shorthand. */
const pairsOf = (lit) => {
  if (!Array.isArray(lit) || lit[0] !== '{}' || lit.length !== 2) return null
  const out = members(lit[1]).map(m => typeof m === 'string' ? [m, m] : Array.isArray(m) && m[0] === ':' && isName(m[1]) && !isFn(m[2]) ? [m[1], m[2]] : null)
  return out.every(Boolean) && new Set(out.map(p => p[0])).size === out.length ? out : null
}

// a statement reads the body's binding of a name where the name is free in it (rename.js)
const reads = (s, n) => spells(s, n) && (moduleForm(s) || free(s, n))

/** A whole module held under a name is an object of its exports, made for that requirer: the
 *  requirer may read members of it and do nothing else with it. Asked of the statements that
 *  read the body's binding: every spelling of the name in them is a member's object, the
 *  require's own target or a declaration. */
const readsMembersOnly = (list, name) => {
  let members = 0
  const walk = (n, target) => {
    if (!Array.isArray(n)) return
    if ((n[0] === '.' || n[0] === '?.') && n[1] === name && !target) members++
    for (let k = 1; k < n.length; k++) walk(n[k], k === 1 && (MUTATE_OPS.has(n[0]) || n[0] === 'delete'))
  }
  const all = [';', ...list.filter(s => reads(s, name))]
  walk(all, false)
  return count(all, name) === members + 1 + list.reduce((c, s) => c + namesIn(s, name), 0)
}

/** The bundle with every module that can be linked standing at the module level. */
export function linkCommonJS(ast) {
  const top = moduleStmts(ast)
  if (!top || top.length < 3) return ast
  const binds = top.map(bindingOf)
  const nameFns = binds.filter(b => b && nodeEqual(b[1], OWN_NAMES)).map(b => b[0])
  const helpers = new Set(binds.filter(b => b && isRequireHelper(b[1], nameFns)).map(b => b[0]))
  if (!helpers.size) return ast

  // The modules: `require_x = __commonJS({ "x.js"(exports, module) { … } })`.
  const mods = new Map(), wrapperAt = new Map()
  top.forEach((s, at) => {
    const b = binds[at]
    if (!b || !Array.isArray(b[1]) || b[1][0] !== '()' || b[1].length !== 3 || !helpers.has(b[1][1]) || mods.has(b[0])) return
    const lit = b[1][2], m = Array.isArray(lit) && lit[0] === '{}' && lit.length === 2 ? lit[1] : null
    if (!Array.isArray(m) || m[0] !== ':' || !Array.isArray(m[2]) || m[2][0] !== 'function' || m[2][1] != null) return
    const ps = m[2][2], params = ps == null ? [] : typeof ps === 'string' ? [ps] : Array.isArray(ps) && ps[0] === ',' ? ps.slice(1) : null
    if (!params || params.length > 2 || !params.every(p => typeof p === 'string')) return
    const mod = { req: b[0], file: literalString(m[1]) ?? b[0], loc: s.loc ?? null, exp: params[0] ?? null, mod: params[1] ?? null, list: stmtsOf(m[2][3]).filter(s => !isDirective(s)), vars: new Map(), valueVar: null, names: new Map() }
    mods.set(b[0], mod); wrapperAt.set(at, mod)
  })
  if (!mods.size) return ast

  const all = [...mods.values()], whole = [';', ...top]
  const sitesIn = (list) => list.map(s => requireSite(s, (n) => mods.has(n)))
  const topSites = sitesIn(top)
  for (const m of all) {
    m.sites = sitesIn(m.list)
    m.exports = m.list.some(moduleForm) ? null : exportsOf(m.list, m.exp, m.mod)
    m.declares = new Set()
    m.list.forEach((s, i) => { if (m.sites[i]?.declared) for (const n of m.sites[i].names) m.declares.add(n); else declares(s, m.declares) })
    m.why = m.list.some(moduleForm) ? 'it holds an import or export form' : !m.exports ? 'its exports or module object is read, passed on or assigned twice'
      : m.list.some(s => ownsBody(s)) ? 'its body returns or reads this or arguments' : null
    m.keep = m.why != null
    // `module.exports = { k: v }` exports its pairs; any other value is the module's one export
    m.pairs = !m.keep && m.exports.value >= 0 ? pairsOf(m.list[m.exports.value][2]) : null
    m.one = !m.keep && m.exports.value >= 0 && !m.pairs
  }
  const has = (m, k) => m.one || (m.pairs ? m.pairs.some(p => p[0] === k) : m.exports.names.has(k))

  // What keeps a module as esbuild wrote it, until nothing more does.
  const linkedBodies = () => [[top, topSites], ...all.filter(m => !m.keep).map(m => [m.list, m.sites])]
  // a body takes a require as consts where the names bind from the require on and a whole module is only read
  // (a statement that binds every occurrence of the name itself reads none of the body's)
  const early = (list, at, n) => readUndefined([';', ...list.map(s => reads(s, n) ? s : null)], at + 1, n)
  const takes = (list, site, at) => site.kind === 'bare' ||
    (site.declared || site.names.every(n => !early(list, at, n))) &&
    (site.kind !== 'whole' || mods.get(site.req).one || readsMembersOnly(list, site.names[0]))
  for (let changed = true; changed;) {
    changed = false
    const keep = (m, why) => { if (!m.keep) { m.keep = changed = true; m.why = why } }
    const bodies = linkedBodies()
    for (const m of all) {
      if (m.keep) continue
      // every spelling of its require is its binding, its place in a `let` of names, or a site of a linked body
      // (one in a kept module's body is none: what a kept module requires is kept)
      let known = 1 + top.reduce((n, s) => n + namesIn(s, m.req), 0)
      for (const [list, sites] of bodies) sites.forEach((site, at) => {
        if (site?.req !== m.req) return
        known++
        if (!takes(list, site, at)) keep(m, 'a requirer reads its binding before the require, or does more with the whole module than read its members')
        else if (site.kind === 'picks' && !site.picks.every(p => has(m, p[0]))) keep(m, 'a requirer takes an export it does not make')
      })
      if (count(whole, m.req) !== known) keep(m, 'it is required inside a function, under a condition, or by a module that is kept')
    }
    // a cycle keeps every module on it
    const state = new Map()
    const visit = (m) => {
      if (m.keep || state.get(m) === 2) return
      if (state.get(m) === 1) return keep(m, 'it requires itself through the modules it requires')
      state.set(m, 1)
      for (const s of m.sites) if (s) visit(mods.get(s.req))
      state.set(m, 2)
    }
    for (const m of all) visit(m)
  }
  // the advisory names each module left a function, and what left it one
  for (const m of all) if (m.keep) warn('module-kept', `CommonJS module ${m.file} stays a function called at its first require, its classes classes of closures: ${m.why}`, {}, m.loc)
  if (all.every(m => m.keep)) return ast

  // A name a linked body declares that the bundle spells anywhere else takes a new one there.
  const spellings = tally(whole, new Map()), taken = new Set(spellings.keys())
  const fresh = (base) => { for (let i = 2; ; i++) { const n = `${base}_${i}`; if (!taken.has(n)) { taken.add(n); return n } } }
  for (const m of all) {
    if (m.keep) continue
    const own = tally([';', ...m.list], new Map())
    for (const n of m.declares) if (spellings.get(n) > own.get(n)) m.names.set(n, fresh(n))
  }
  // what a requirer's const holds: an export's const, the one value's member, or an object of the exports
  const pick = (m, k) => m.one ? ['.', m.valueVar, k] : m.vars.get(k)
  const wholeOf = (m) => m.one ? m.valueVar
    : ['{}', m.vars.size === 0 ? null : m.vars.size === 1 ? [':', ...[...m.vars][0]] : [',', ...[...m.vars].map(([k, v]) => [':', k, v])]]

  const emitted = new Set()
  /** A body's statements at the module level, its requires of linked modules consts; `self` the module, null for the bundle's own. */
  const emit = (list, sites, self) => {
    const here = []
    const local = (n) => self?.names.get(n) ?? n
    const put = (s, from) => here.push(withLoc(self && self.names.size ? rename(s, self.names, true) : s, from))
    // the names a require's const declares leave the body's `let` of names; the bundle's loses its linked requires too
    const gone = new Set(self ? [] : all.filter(m => !m.keep).map(m => m.req))
    sites.forEach((site) => { if (site && !site.declared && !mods.get(site.req).keep) for (const n of site.names) gone.add(n) })
    list.forEach((s, i) => {
      const site = sites[i], dep = site && mods.get(site.req)
      if (dep && !dep.keep) {
        if (!emitted.has(dep)) { emitted.add(dep); here.push(...emit(dep.list, dep.sites, dep)) }
        if (site.kind === 'whole') here.push(withLoc(['const', ['=', local(site.names[0]), wholeOf(dep)]], s))
        else if (site.kind === 'picks') for (const [k, n] of site.picks) here.push(withLoc(['const', ['=', local(n), pick(dep, k)]], s))
        return
      }
      if (self && i === self.exports.value) {
        if (self.pairs) for (const [k, v] of self.pairs) { const name = fresh(k); self.vars.set(k, name); put(['const', ['=', name, v]], s) }
        else { self.valueVar = fresh('exports'); put(['const', ['=', self.valueVar, s[2]]], s) }
        return
      }
      if (self && Array.isArray(s) && s[0] === '=' && Array.isArray(s[1]) && s[1][0] === '.' && s[1][1] === self.exp && self.exports.names.get(s[1][2]) === i) {
        const name = fresh(s[1][2])
        self.vars.set(s[1][2], name)
        put(['const', ['=', name, s[2]]], s)
        return
      }
      if (Array.isArray(s) && s[0] === 'let' && s.some((d, k) => k > 0 && gone.has(d))) {
        const kept = s.filter((d, k) => k === 0 || !gone.has(d))
        if (kept.length > 1) put(kept, s)
        return
      }
      put(s, s)
    })
    return here
  }
  const own = top.map((s, at) => wrapperAt.get(at)?.keep === false ? null : s)
  const out = emit(own.filter(Boolean), topSites.filter((s, at) => own[at]), null)
  return out.length === 1 ? out[0] : withLoc([';', ...out], ast)
}
