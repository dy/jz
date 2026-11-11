/**
 * Integral parameters: a parameter every call passes an integral Number (an
 * integer, NaN, ±∞ or -0 — `Math.floor`'s results, a remainder of integers
 * by a literal, a clamp of integers by `Math.min`/`Math.max`, a sum of
 * integers, an integer typed element) and every write of which in its
 * function and its closures keeps one is integral in the callee: `intLevel`,
 * the number the parameter carries to the interval proof (type/interval-proof.js),
 * which then keys a typed array by it with one truncation and a NaN test
 * instead of the fraction test.
 *
 * A greatest fixpoint over the direct calls of functions nothing else calls
 * (the call-site lattices' own exclusions: not exported, not address-taken,
 * not raw): every candidate starts integral, and the interval proof walks each
 * caller (a function's body, the closure a call runs in, the module's
 * statements) under that hypothesis. A call that passes anything else, or
 * nothing, retracts it, as does a write the callee's own walks value
 * otherwise; a retraction walks again what read it. A function no call
 * reaches proves nothing.
 *
 * @module compile/narrow/int-params
 */
import { ctx } from '../../ctx.js'
import { isReassigned, someDeep } from '../../ast.js'
import { scanIntervalIdx, paramEntry, bindingFlows, flowNumbers, WHOLE_VALUE } from '../../type/interval-proof.js'
import { K, tagOf, hasTag } from '../../summary/index.js'
import { isExported } from '../func-exports.js'
import { enterActiveFunction, restoreActiveFunction } from '../active-function.js'
import { frameNode } from '../../function.js'

/** Stamp `intLevel: 1` on every parameter the direct calls and its own writes prove integral. */
export function inferIntegralParams(callSites, callerCtx, addressTaken, ast) {
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
  // The hypothesis is the stamp itself: each walk reads it as the parameter's number.
  for (const [func, ks] of cand) for (const k of ks) func.sig.params[k].intLevel = 1
  const dirty = new Set()
  const retract = (func, k) => { if (!cand.get(func)?.delete(k)) return; delete func.sig.params[k].intLevel; dirty.add(func) }
  // Each caller of a candidate: the innermost flow its call runs in.
  const callers = new Map()
  for (const cs of callSites) {
    const f = ctx.funcs.map.get(cs.callee)
    if (!f || !cand.has(f)) continue
    reached.add(f)
    const key = cs.arrow ?? cs.callerFunc ?? null
    let c = callers.get(key)
    if (!c) callers.set(key, c = { owner: cs.callerFunc ?? null, arrow: cs.arrow ?? null, sites: [] })
    c.sites.push(cs)
  }
  // A candidate its function or a closure of it writes: those flows, walked under the hypothesis.
  const writers = new Map()
  for (const [func, ks] of cand) {
    const frame = frameNode(func), names = new Set()
    for (const k of ks) if (isReassigned(frame, func.sig.params[k].name)) names.add(func.sig.params[k].name)
    if (!names.size) continue
    const { flows, unvalued } = bindingFlows([{ body: frame, sig: func.sig }], names)
    for (const k of [...ks]) if (unvalued.has(func.sig.params[k].name)) retract(func, k)
    writers.set(func, flows)
  }
  const argsOf = (c) => {
    const calls = new Map(), body = c.arrow ? c.arrow[2] : c.owner ? c.owner.body : ast
    for (const cs of c.sites) if (!cs.synthetic) calls.set(cs.node, undefined)
    if (!Array.isArray(body) || !calls.size) return calls
    const view = callerCtx.get(c.owner), own = c.arrow ? [] : null
    if (c.arrow) someDeep(c.arrow[1], x => { if (typeof x === 'string') own.push(x); return false })
    const prev = enterActiveFunction(ctx, { sig: c.owner?.sig, body })
    try {
      ctx.func.locals = view?.callerLocals ?? new Map()
      const present = view?.readPresent
      scanIntervalIdx(body, () => null, { calls, own, entry: c.arrow ? new Map() : paramEntry(), present: present ? n => present.has(n) : null })
    } finally { restoreActiveFunction(ctx, prev) }
    return calls
  }
  for (let round = 0; round === 0 || dirty.size; round++) {
    const changed = round === 0 ? null : new Set(dirty)
    dirty.clear()
    for (const c of callers.values()) {
      // (a walk reads the hypothesis of its own function's parameters alone)
      if (changed && !changed.has(c.owner)) continue
      if (!c.sites.some(cs => cand.get(ctx.funcs.map.get(cs.callee))?.size)) continue
      const calls = argsOf(c)
      for (const cs of c.sites) {
        const f = ctx.funcs.map.get(cs.callee), ks = cand.get(f), args = calls.get(cs.node)
        if (ks) for (const k of [...ks]) if (!args?.[k]?.whole) retract(f, k)
      }
    }
    for (const [func, flows] of writers) {
      const ks = cand.get(func)
      if (!ks.size || changed && !changed.has(func)) continue
      const start = new Map()
      for (const k of ks) start.set(func.sig.params[k].name, WHOLE_VALUE)
      const held = flowNumbers(flows, start)
      for (const k of [...ks]) if (start.has(func.sig.params[k].name) && !held.has(func.sig.params[k].name)) retract(func, k)
    }
  }
  for (const [func, ks] of cand) if (!reached.has(func)) for (const k of ks) delete func.sig.params[k].intLevel
}
