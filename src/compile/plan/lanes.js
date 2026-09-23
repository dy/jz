/**
 * Record parameters as lanes: a same-module function whose parameter is only
 * ever read field by field (`p.x`, `p.y`) gets a sibling that takes those
 * fields as scalar parameters, and every call site hands the fields over
 * instead of the object. A site that built the object as a literal
 * (`len({ x: dx, y: dy })`) then never allocates it: the values go straight
 * into the lanes. A local literal the caller kept in a binding is left with
 * field reads only, which the object scalarizer (literals.js) dissolves in
 * the same plan. Where the caller holds a real object, the fields are loaded
 * at the call, which is what the callee would have done.
 *
 * Eligibility, all closed:
 *   - the callee is internal, not address-taken, has no rest parameter and
 *     no default mentioning the parameter, and reads the parameter only as
 *     `p.k` with a literal key outside nested functions: never writes a
 *     field (the lanes are copies), never uses `p` whole;
 *   - every direct call site passes either an object literal with literal
 *     keys, whose values are effect-free or spelled in the lanes' order (the
 *     lanes evaluate in parameter order), or a name the summary proves an
 *     object of one known shape, beside effect-free arguments; for the latter
 *     the callee must not write outer state (compile/analyze/frame-effects.js),
 *     or the copies could go stale while it runs.
 * With every site retargeted the original is dead, and the tree shake
 * removes it.
 *
 * @module compile/plan/lanes
 */
import { ctx } from '../../ctx.js'
import { ASSIGN_OPS, isFunctionNode } from '../../ast.js'
import { materializeVariant } from '../variant.js'
import { isExported } from '../func-exports.js'
import { transitiveFrameEffects } from '../analyze/frame-effects.js'
import { frameRoots } from '../../function.js'

const isArr = Array.isArray
const isName = (x) => typeof x === 'string'
const argsNode = (list) => list.length === 0 ? null : list.length === 1 ? list[0] : [',', ...list]
const MAX_LANES = 8
const PURE_OPS = new Set(['+', '-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>', '~', '!', '<', '<=', '>', '>=', '==', '!=', '===', '!==', '&&', '||', '??', '?', 'str', 'bool'])

/** An expression whose evaluation neither reads nor writes anything another
 *  expression's evaluation could change: names, literals, field reads of names,
 *  and operators over such. */
const effectFree = (e) => e == null || isName(e) || (isArr(e) && (e[0] == null || e[0] === 'str' || e[0] === 'bool' ||
  (e[0] === '.' && isName(e[1]) && isName(e[2])) || (e[0] === '[]' && isName(e[1]) && isName(e[2])) ||
  (PURE_OPS.has(e[0]) && e.slice(1).every(effectFree))))

/** The literal keys and values of an object literal (`[':', key, value]`
 *  properties only: no spreads, computed keys or methods), or null. */
function literalProps(e) {
  if (!isArr(e) || e[0] !== '{}') return null
  const names = [], values = []
  for (let i = 1; i < e.length; i++) {
    const p = e[i]
    if (!isArr(p) || p[0] !== ':' || !isName(p[1]) || isFunctionNode(p[2]) || names.includes(p[1])) return null
    names.push(p[1]); values.push(p[2])
  }
  return { names, values }
}

/** The keys `p` is read through, in first-read order, or null when any use is not a plain field read. */
function fieldReadsOnly(nodes, p) {
  const keys = []
  let ok = true
  const walk = (n, nested) => {
    if (!ok) return
    if (n === p) { ok = false; return }           // a whole use: bare, argument, return, comparison
    if (!isArr(n)) return
    const op = n[0]
    if (isFunctionNode(n)) { for (let i = 1; i < n.length; i++) walk(n[i], true); return }
    if ((op === '.' || op === '?.') && n[1] === p) {
      if (!isName(n[2]) || nested) { ok = false; return }
      if (!keys.includes(n[2])) keys.push(n[2])
      return
    }
    if ((ASSIGN_OPS.has(op) || op === '++' || op === '--' || op === 'delete') && isArr(n[1]) && n[1][1] === p) { ok = false; return }
    if ((op === 'let' || op === 'const' || op === 'var') && n.slice(1).some(d => d === p || (isArr(d) && d[1] === p))) { ok = false; return }
    for (let i = 1; i < n.length; i++) walk(n[i], nested)
  }
  for (const n of nodes) walk(n, false)
  return ok ? keys : null
}

/** `['.', p, k]` → the lane name, everywhere in a fresh copy of the body. */
function laneBody(body, p, laneOf) {
  const copy = (n) => {
    if (!isArr(n)) return n
    if ((n[0] === '.' || n[0] === '?.') && n[1] === p && isName(n[2])) return laneOf(n[2])
    const out = new Array(n.length)
    for (let i = 0; i < n.length; i++) out[i] = copy(n[i])
    return out
  }
  return copy(body)
}

/** The argument at a site as one lane expression per key, or null when the site is ineligible. */
function laneArgs(site, arg, keys, mayLoadFields) {
  const lit = literalProps(arg)
  if (lit) {
    const read = lit.names.filter(k => keys.includes(k))
    // The lanes evaluate in parameter order; a literal may reorder its values
    // only when none of them has an effect. A key the callee never reads is
    // still a spelled expression: it stays evaluated only when it is free of
    // effects, so a literal with such a key qualifies only then.
    const ordered = read.every((k, i) => i === 0 || keys.indexOf(read[i - 1]) < keys.indexOf(k))
    if (!ordered && !lit.values.every(effectFree)) return null
    for (let i = 0; i < lit.names.length; i++) if (!keys.includes(lit.names[i]) && !effectFree(lit.values[i])) return null
    // A read key the literal lacks would need an undefined lane; leave that shape.
    if (!keys.every(k => lit.names.includes(k))) return null
    return keys.map(k => lit.values[lit.names.indexOf(k)])
  }
  // A name of one object shape: the field reads move from the callee to the
  // call. With every other argument effect-free, nothing observes the move.
  if (!isName(arg) || !mayLoadFields || !site.argList.every(a => a === arg || effectFree(a))) return null
  const view = ctx.summary?.at(site.callerFunc ?? '')
  if (view?.objectSidOfExpr(arg) == null) return null
  return keys.map(k => ['.', arg, k])
}

/** @param programFacts  the plan's program facts (call sites, address-taken names)
 *  @returns whether any function took lanes (the plan then re-collects its facts) */
export function laneRecordParams(programFacts) {
  const cfg = ctx.transform.optimize
  if (cfg && cfg.laneRecords === false) return false   // tests that pin the source's own functions
  const { callSites, addressTakenNames } = programFacts
  if (!callSites?.length) return false
  let changed = false
  const sitesByCallee = new Map()
  for (const site of callSites) {
    if (site.synthetic || !isName(site.callee)) continue
    const list = sitesByCallee.get(site.callee)
    if (list) list.push(site); else sitesByCallee.set(site.callee, [site])
  }
  let frames = null
  const writesNothingOuter = (func) => (frames ??= transitiveFrameEffects(ctx.funcs.list)).get(func.name)?.writesOuter === false
  for (const func of ctx.funcs.list.slice()) {
    if (func.raw || !func.body || func.rest || isExported(func) || addressTakenNames?.has(func.name)) continue
    const sites = sitesByCallee.get(func.name)
    if (!sites?.length || sites.some(s => s.node[1] !== func.name || s.argList.length !== func.sig.params.length)) continue
    const nodes = frameRoots(func)
    for (let k = 0; k < func.sig.params.length; k++) {
      const p = func.sig.params[k]
      if (!p?.name || p.type !== 'f64' || p.ptrKind != null || func.defaults?.[p.name] != null) continue
      const keys = fieldReadsOnly(nodes, p.name)
      if (!keys || keys.length === 0 || keys.length > MAX_LANES) continue
      const mayLoad = sites.some(s => !literalProps(s.argList[k])) ? writesNothingOuter(func) : false
      const lanesAt = sites.map(s => laneArgs(s, s.argList[k], keys, mayLoad))
      if (lanesAt.some(l => l == null)) continue
      const laneName = (key) => `${p.name}$${key}`
      const params = func.sig.params.flatMap((q, i) => i === k ? keys.map(key => ({ name: laneName(key), type: 'f64' })) : [{ ...q }])
      materializeVariant({
        origin: func, name: `${func.name}$lanes`, kind: 'lane-record',
        sig: { params, results: [...func.sig.results] }, body: laneBody(func.body, p.name, laneName),
        eligibleSites: sites, fallback: func,
      })
      sites.forEach((site, i) => {
        const list = [...site.argList.slice(0, k), ...lanesAt[i], ...site.argList.slice(k + 1)]
        site.node[2] = argsNode(list)
        site.argList = list
      })
      changed = true
      break   // one record parameter per function and plan; the sweep re-collects facts
    }
  }
  return changed
}
