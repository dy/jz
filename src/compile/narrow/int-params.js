/**
 * Integral parameters: a parameter every call passes an integral Number (an
 * integer, NaN, ±∞ or -0 — `Math.floor`'s results, a remainder of integers
 * by a literal, a clamp of integers by `Math.min`/`Math.max`, a sum of
 * integers, an integer typed element or its miss) is integral in the callee,
 * which then keys a typed array by it with one truncation and a NaN test
 * instead of the fraction test (type/int-certain.js level 1, `intCertain`).
 *
 * A greatest fixpoint over the direct calls of functions nothing else calls
 * (the call-site lattices' own exclusions: not exported, not address-taken,
 * not raw): every candidate starts integral, a call that passes anything else,
 * or nothing, retracts it, and a retraction re-reads the callee as a caller,
 * whose locals it may have made integral. A function no call reaches proves
 * nothing. A caller's writes inside its closures count among its definitions.
 *
 * @module compile/narrow/int-params
 */
import { ctx } from '../../ctx.js'
import { intLevelMap, intLevelOf } from '../../type/int-certain.js'
import { K, tagOf, hasTag } from '../../summary/index.js'
import { isExported } from '../func-exports.js'

const NO_LEVELS = new Map()
const ASSIGNS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=', '++', '--'])

/** Names a body's nested closures assign: their writes are definitions of the body's own bindings. */
const closureWrites = (body) => {
  const out = new Set()
  const walk = (n, inArrow) => {
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op === '=>') inArrow = true
    else if (inArrow && ASSIGNS.has(op) && typeof n[1] === 'string') out.add(n[1])
    for (let i = 1; i < n.length; i++) walk(n[i], inArrow)
  }
  walk(body, false)
  return out
}

/** Stamp `intLevel: 1` on every parameter the direct calls prove integral. */
export function inferIntegralParams(callSites, callerCtx, addressTaken) {
  const cand = new Map(), reached = new Set()
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw || isExported(func) || addressTaken.has(func.name)) continue
    const summary = ctx.summary.at(func.sig), rest = func.rest ? func.sig.params.length - 1 : -1
    let ks = null
    for (let k = 0; k < func.sig.params.length; k++) {
      const p = func.sig.params[k]
      if (k === rest || p.type !== 'f64' || p.ptrKind != null || func.defaults?.[p.name] != null) continue
      // a Number at every call: a Boolean's atom or a missing value is no integer
      const kd = summary.paramKindOf(p.name)
      if (tagOf(kd) !== K.NUMBER || hasTag(kd, K.NULLISH) || hasTag(kd, K.ABSENT)) continue
      if (!ks) ks = new Set()
      ks.add(k)
    }
    if (ks) cand.set(func, ks)
  }
  if (!cand.size) return
  const levelsOf = new Map()
  const callerLevels = (caller) => {
    if (!caller?.body) return NO_LEVELS
    let m = levelsOf.get(caller)
    if (!m) {
      const ks = cand.get(caller)
      const params = ks ? caller.sig.params.map((p, k) => ks.has(k) ? { ...p, intLevel: 1 } : p) : caller.sig.params
      m = intLevelMap(caller.body, closureWrites(caller.body), null, callerCtx.get(caller)?.readPresent, params)
      levelsOf.set(caller, m)
    }
    return m
  }
  for (let changed = true; changed;) {
    changed = false
    for (const cs of callSites) {
      const func = ctx.funcs.map.get(cs.callee), ks = func ? cand.get(func) : null
      if (!ks) continue
      reached.add(func)
      if (!ks.size) continue
      const levels = callerLevels(cs.callerFunc), present = callerCtx.get(cs.callerFunc)?.readPresent
      for (const k of [...ks]) {
        const arg = cs.argList[k]
        if (arg != null && intLevelOf(arg, levels, present) > 0) continue
        ks.delete(k)
        levelsOf.delete(func)
        changed = true
      }
    }
  }
  for (const [func, ks] of cand) if (reached.has(func)) for (const k of ks) func.sig.params[k].intLevel = 1
}
