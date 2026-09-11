/**
 * Self-contained whole-program interprocedural analyses feeding
 * narrowSignatures: fixed-length proof for literal+push-built arrays
 * (inferInternalArrayLengths), whole-program typed-elem
 * store range hulls (inferTypedValueRanges), and the caller-side
 * parameter-length-bound proof (boundedByCallerLength — see its own doc
 * comment for the shape-class and soundness contract; ledger-performance.md
 * §6.1). Each has fan-out 0 into any sibling narrow/*.js family — every
 * dependency here is an upstream import.
 *
 * @module compile/narrow/summaries
 */

import { ctx } from '../../ctx.js'
import {
  returnExprs, callArgs, ASSIGN_OPS, refsName, carriesName, REFS_THROUGH_ARROWS, walkAst, isReassigned,
} from '../../ast.js'
import {
  staticArrayElems, staticArrayLen, hull, typedValueLiteral, typedValueExprRange,
} from '../../static.js'
import { typedElemCtor, typedStaticLen } from '../../type.js'
import { scanIntervalIdx } from '../../type/interval-proof.js'
import { ensureParamRep } from '../../param-reps.js'
import { enterActiveFunction, restoreActiveFunction } from '../active-function.js'
import { isExported } from '../func-exports.js'
import { analyzeBody } from '../analyze.js'
import { VAL } from '../../reps.js'

// Reuse the bounds interpreter at call sites. Start at unknown and refine only
// when EVERY incoming site proves a hull. Each intermediate result is sound;
// a bounded worklist budget can forgo precision without trusting an unfinished
// optimistic fixpoint. Indirect/synthetic calls stay unknown.
export function inferNumericRanges(paramReps, callSites, callerCtx, addressTaken, ast) {
  const outgoing = new Map(), incoming = new Map(), observed = new Map(), stores = new Map()
  const hasKind = (f, kind) => {
    for (const r of paramReps.get(f.name)?.values() ?? []) if (r.val === kind || r.presentVal === kind) return true
    return false
  }
  for (const cs of callSites) {
    const f = ctx.funcs.map.get(cs.callee)
    if (!f?.body || f.raw || isExported(f) || addressTaken.has(f.name)) continue
    if (!hasKind(f, VAL.NUMBER)) continue
    if (!outgoing.has(cs.callerFunc)) outgoing.set(cs.callerFunc, [])
    outgoing.get(cs.callerFunc).push(cs)
    if (!incoming.has(f)) incoming.set(f, [])
    incoming.get(f).push(cs)
  }
  // Existing kind/body facts rule out functions with no numeric-call or
  // typed-store consumer. Walking their loops creates only discarded facts.
  const queue = ctx.funcs.list.filter(f => f.body && !f.raw &&
    (outgoing.has(f) || hasKind(f, VAL.TYPED) || analyzeBody(f.body).typedElems.size))
  if (outgoing.has(null)) queue.push(null)
  const queued = new Set(queue), visits = new Map()
  for (let head = 0; head < queue.length; head++) {
    const caller = queue[head], body = caller?.body ?? ast
    queued.delete(caller)
    const count = visits.get(caller) ?? 0
    if (count >= 8) continue
    visits.set(caller, count + 1)
    const entry = new Map(), reps = paramReps.get(caller?.name)
    for (let k = 0; k < (caller?.sig.params.length ?? 0); k++)
      entry.set(caller.sig.params[k].name, reps?.get(k)?.range ?? null)
    const calls = new Map((outgoing.get(caller) ?? []).filter(cs => !cs.synthetic).map(cs => [cs.node, undefined]))
    const writes = new Map(), receivers = new Set(caller ? analyzeBody(body).typedElems.keys() : [])
    for (let k = 0; k < (caller?.sig.params.length ?? 0); k++) {
      const r = reps?.get(k)
      if (r?.val === VAL.TYPED || r?.presentVal === VAL.TYPED) receivers.add(caller.sig.params[k].name)
    }
    if (receivers.size) walkAst(body, { enter: n => {
      if (n[0] === '=>') return false
      if (n[0] === '=' && Array.isArray(n[1]) && n[1][0] === '[]' && receivers.has(n[1][1])) writes.set(n, undefined)
    } })
    if (!calls.size && !writes.size) continue
    const prev = enterActiveFunction(ctx, { sig: caller?.sig, body })
    try {
      ctx.func.locals = callerCtx.get(caller)?.callerLocals ?? new Map()
      scanIntervalIdx(body, new Set(), () => null, null, calls, entry, writes)
    } finally { restoreActiveFunction(ctx, prev) }
    stores.set(caller, writes)
    const targets = new Set()
    for (const cs of outgoing.get(caller) ?? []) {
      observed.set(cs, cs.synthetic ? null : calls.get(cs.node))
      targets.add(ctx.funcs.map.get(cs.callee))
    }
    for (const f of targets) {
      let changed = false
      for (let k = 0; k < f.sig.params.length; k++) {
        const p = f.sig.params[k]
        if (f.defaults?.[p.name] != null || (f.rest && k === f.sig.params.length - 1) || isReassigned(f.body, p.name)) continue
        let range = undefined
        for (const cs of incoming.get(f)) {
          const v = observed.get(cs)?.[k]
          if (!v || !Number.isFinite(v[0]) || !Number.isFinite(v[1]) || v[0] < -2147483648 || v[1] > 2147483647) { range = null; break }
          range = hull(range, v)
        }
        const r = ensureParamRep(paramReps, f.name, k)
        if (range && (!r.range || range[0] !== r.range[0] || range[1] !== r.range[1])) {
          r.range = range
          changed = true
        }
      }
      if (changed && (outgoing.has(f) || stores.has(f)) && !queued.has(f)) { queue.push(f); queued.add(f) }
    }
  }
  return stores
}

// Fixed lengths of internal arrays built from a literal plus unconditional
// pushes in canonical constant-trip loops. Any alias, unknown call, unequal
// branch growth, indexed write, or control exit rejects the array. This captures table
// builders without pretending mutable JS arrays are generally fixed-size.
export function inferInternalArrayLengths() {
  const cint = (n) => {
    if (typeof n === 'number' && Number.isInteger(n)) return n
    if (Array.isArray(n) && n[0] == null && typeof n[1] === 'number' && Number.isInteger(n[1])) return n[1]
    if (typeof n === 'string') return ctx.scope.constInts?.get(n) ?? null
    return null
  }
  const declInit = (n, name) => {
    if (!Array.isArray(n)) return null
    if (n[0] === 'let' || n[0] === 'const' || n[0] === ';') for (let i = 1; i < n.length; i++) {
      const d = n[i]
      if (Array.isArray(d) && d[0] === '=' && d[1] === name) return cint(d[2])
      const v = declInit(d, name); if (v != null) return v
    }
    return null
  }
  const unitInc = (n, name) => Array.isArray(n) &&
    ((n[0] === '++' && n[1] === name) || (n[0] === '+=' && n[1] === name && cint(n[2]) === 1))
  // refsName's unconditional-descend form (skipArrow: false): a closure capture
  // can read/alias/mutate the name at any time, so it counts as a reference
  // everywhere this predicate gates a reject. A shadowing arrow param matches
  // by string and over-rejects — sound.
  const refs = (n, name) => refsName(n, name, REFS_THROUGH_ARROWS)
  const pushCount = (n, arr) => {
    if (!Array.isArray(n)) return n === arr ? null : 0
    if (n[0] === '=>') return refs(n, arr) ? null : 0
    if (n[0] === '()') {
      if (Array.isArray(n[1]) && n[1][0] === '.' && n[1][1] === arr)
        return n[1][2] === 'push' && callArgs(n).length > 0 && !callArgs(n).some(a => (Array.isArray(a) && a[0] === '...') || refs(a, arr))
          ? callArgs(n).length : null
      if (callArgs(n).some(a => refs(a, arr)) || refs(n[1], arr)) return null
    }
    if (n[0] === '&&' || n[0] === '||' || n[0] === '??' || n[0] === 'catch' || n[0] === 'finally') return refs(n, arr) ? null : 0
    if (n[0] === 'if' || n[0] === '?:') {
      if (refs(n[1], arr)) return null
      const a = pushCount(n[2], arr), b = pushCount(n[3], arr)
      return a != null && a === b ? a : null
    }
    if (n[0] === 'while' || n[0] === 'do' || n[0] === 'for' || n[0] === 'switch')
      return refs(n, arr) ? null : 0
    if (n[0] === 'return' || n[0] === 'throw' || n[0] === 'break' || n[0] === 'continue') return null
    if (ASSIGN_OPS.has(n[0]) || n[0] === '++' || n[0] === '--') {
      if (n[1] === arr || refs(n[1], arr) || carriesName(n[2], arr)) return null
    }
    let total = 0
    for (let i = 1; i < n.length; i++) {
      const c = pushCount(n[i], arr)
      if (c == null) return null
      total += c
    }
    return total
  }
  const hasOp = (n, op) => {
    if (!Array.isArray(n) || n[0] === '=>') return false
    if (n[0] === op) return true
    for (let i = 1; i < n.length; i++) if (hasOp(n[i], op)) return true
    return false
  }
  const returnedName = (body) => {
    const rs = returnExprs(body)
    return rs.length && rs.every(x => typeof x === 'string' && x === rs[0]) ? rs[0] : null
  }
  // Also descends into arrows: a captured-iv write (`arr.forEach(() => i++)`)
  // changes the trip count as surely as a direct one. Shadowing over-rejects.
  const mutatesName = (n, name) => {
    if (!Array.isArray(n)) return false
    if ((ASSIGN_OPS.has(n[0]) || n[0] === '++' || n[0] === '--') && n[1] === name) return true
    for (let i = 1; i < n.length; i++) if (mutatesName(n[i], name)) return true
    return false
  }
  const funcLens = new Map(), capacities = new Map()
  for (const f of ctx.funcs.list) {
    if (f.raw || !Array.isArray(f.body)) continue
    const arr = returnedName(f.body)
    if (!arr) continue
    let len = null, bad = false, defNode = null
    walkAst(f.body, { enter: n => {
      if (bad) return false
      if (n[0] === '=>') { if (refs(n, arr)) bad = true; return false }
      if ((n[0] === 'let' || n[0] === 'const')) for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (Array.isArray(d) && d[0] === '=' && d[1] === arr) {
          if (defNode) { bad = true; return false }
          const size = staticArrayLen(d[2])
          if (size != null) { len = size; defNode = d } else bad = true
        }
      }
      if ((n[0] === 'if' || n[0] === '?:' || n[0] === '&&' || n[0] === '||' || n[0] === '??' || n[0] === 'while' || n[0] === 'do' || n[0] === 'switch' || n[0] === 'catch' || n[0] === 'finally') && refs(n, arr)) {
        bad = true
        return false
      }
      if (n[0] === 'for' && n.length === 5 && refs(n[4], arr)) {
        if (refs(n[1], arr) || refs(n[2], arr) || refs(n[3], arr)) { bad = true; return false }
        const initNames = new Set()
        const findIv = (x) => {
          if (!Array.isArray(x)) return
          if (x[0] === '=' && typeof x[1] === 'string' && cint(x[2]) != null) initNames.add(x[1])
          for (let i = 1; i < x.length; i++) findIv(x[i])
        }
        findIv(n[1])
        const iv = [...initNames].find(x => Array.isArray(n[2]) && n[2][0] === '<' && n[2][1] === x && unitInc(n[3], x))
        const start = iv ? declInit(n[1], iv) : null
        const bound = iv ? cint(n[2][2]) : null
        const per = iv ? pushCount(n[4], arr) : null
        if (len == null || start == null || bound == null || bound < start || per == null ||
            hasOp(n[4], 'break') || hasOp(n[4], 'continue') || hasOp(n[4], 'return') || hasOp(n[4], 'throw') ||
            mutatesName(n[4], iv)) bad = true
        else len += (bound - start) * per
        return false
      }
      if (n[0] === '()' && Array.isArray(n[1]) && n[1][0] === '.' && n[1][1] === arr && n[1][2] === 'push') {
        if (len == null || !callArgs(n).length || callArgs(n).some(a => (Array.isArray(a) && a[0] === '...') || refs(a, arr))) bad = true
        else len += callArgs(n).length
        return false
      }
      if (n[0] === '()' && (refs(n[1], arr) || callArgs(n).some(a => refs(a, arr)))) { bad = true; return false }
      if (n !== defNode && (ASSIGN_OPS.has(n[0]) || n[0] === '++' || n[0] === '--') &&
          (n[1] === arr || refs(n[1], arr) || refs(n[2], arr))) { bad = true; return false }
      if (n[0] === 'return' && n[1] === arr) return false
    } })
    if (!bad && len != null) {
      f.arrayLen = len
      funcLens.set(f.name, len)
      if (defNode[2][0] === '[' && Number.isSafeInteger(len) && len >= 0 && len <= 0x1ffffffe)
        capacities.set(f, new Map([[arr, len]]))
    }
  }
  // Length-preserving parameter summaries let a caller retain a local length
  // fact across known reader helpers. Any alias, closure capture, return,
  // indexed/property write, method call, or unknown call poisons the summary.
  const carries = carriesName
  const funcs = ctx.funcs.list.filter(f => !f.raw && Array.isArray(f.body))
  const safeParams = new Map(funcs.map(f => [f.name, f.sig.params.map(() => true)]))
  for (const f of funcs) {
    const ps = new Map(f.sig.params.map((p, i) => [p.name, i])), safe = safeParams.get(f.name)
    walkAst(f.body, { enter: n => {
      if (n[0] === '=>') { for (const [name, k] of ps) if (refs(n, name)) safe[k] = false; return false }
      if (ASSIGN_OPS.has(n[0]) || n[0] === '++' || n[0] === '--') for (const [name, k] of ps) {
        if (n[1] === name || carries(n[2], name) || (Array.isArray(n[1]) && refs(n[1], name))) safe[k] = false
      }
      if (n[0] === 'return') for (const [name, k] of ps) if (carries(n[1], name)) safe[k] = false
      if (n[0] === '()') {
        const args = callArgs(n), callee = typeof n[1] === 'string' ? n[1] : null
        for (const [name, k] of ps) {
          if (refs(n[1], name)) safe[k] = false
          for (const a of args) if (carries(a, name) && (a !== name || !safeParams.has(callee))) safe[k] = false
        }
      }
    } })
  }
  let safeChanged = true
  while (safeChanged) {
    safeChanged = false
    for (const f of funcs) {
      const ps = new Map(f.sig.params.map((p, i) => [p.name, i])), safe = safeParams.get(f.name)
      walkAst(f.body, { enter: n => {
        if (n[0] === '=>') return false
        if (n[0] === '()' && typeof n[1] === 'string' && safeParams.has(n[1])) {
          const args = callArgs(n), target = safeParams.get(n[1])
          for (let k = 0; k < args.length; k++) if (ps.has(args[k]) && !target[k] && safe[ps.get(args[k])]) {
            safe[ps.get(args[k])] = false
            safeChanged = true
          }
        }
      } })
    }
  }

  const locals = new Map()
  for (const f of funcs) {
    const candidates = new Map(), defs = new Map()
    const collect = (n) => {
      if (!Array.isArray(n) || n[0] === '=>') return
      if (n[0] === 'let' || n[0] === 'const') for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') continue
        const size = staticArrayLen(d[2])
        const len = size != null ? size
          : Array.isArray(d[2]) && d[2][0] === '()' && typeof d[2][1] === 'string' ? funcLens.get(d[2][1])
          : null
        if (len != null) { candidates.set(d[1], len); defs.set(d[1], d) }
      }
      for (let i = 1; i < n.length; i++) collect(n[i])
    }
    collect(f.body)
    const m = new Map()
    for (const [name, len] of candidates) {
      let ok = true
      const verify = (n) => {
        if (!ok || !Array.isArray(n)) return
        if (n[0] === '=>') { if (refs(n, name)) ok = false; return }
        if (n !== defs.get(name) && (ASSIGN_OPS.has(n[0]) || n[0] === '++' || n[0] === '--') &&
            (n[1] === name || carries(n[2], name) || (Array.isArray(n[1]) && refs(n[1], name)))) { ok = false; return }
        if (n[0] === 'return' && carries(n[1], name)) { ok = false; return }
        if (n[0] === '()') {
          const args = callArgs(n), callee = typeof n[1] === 'string' ? n[1] : null
          if (refs(n[1], name)) { ok = false; return }
          for (let k = 0; k < args.length; k++) if (carries(args[k], name) &&
              (args[k] !== name || !safeParams.get(callee)?.[k])) { ok = false; return }
        }
        for (let i = 1; i < n.length; i++) verify(n[i])
      }
      verify(f.body)
      if (ok) m.set(name, len)
    }
    locals.set(f, m)
  }
  return { funcLens, locals, safeParams, capacities }
}

// Whole-program typed-element hulls for fresh local typed arrays. A callee
// summary records only values written through each parameter; callers union
// that effect with the fresh array's initial zero. This is deliberately not a
// general alias analysis: aliases, external calls, returns, unknown writes, and
// closures poison the fact. The useful class is broad nevertheless — fill(a)
// helpers followed by compute(a), common in codecs and generated kernels.
export function inferTypedValueRanges(storeRanges) {
  // Store effects use flow intervals when available, with a context-free
  // expression fallback for constant or intrinsically bounded values.
  const literal = typedValueLiteral, exprRange = typedValueExprRange
  // Model integer typed-array stores. A source interval that crosses the
  // element representation's wrap/clamp boundary widens to the full stored
  // range; retaining the source interval there would be an unsound under-
  // approximation (e.g. `Uint8Array[0] = -100` stores 156).
  const elemBounds = new Map([
    ['new.Int8Array', [-128, 127]], ['new.Uint8Array', [0, 255]], ['new.Uint8ClampedArray', [0, 255]],
    ['new.Int16Array', [-32768, 32767]], ['new.Uint16Array', [0, 65535]],
    ['new.Int32Array', [-2147483648, 2147483647]], ['new.Uint32Array', [0, 4294967295]],
  ])
  const storedRange = (ctor, r) => {
    const base = ctor?.endsWith('.view') ? ctor.slice(0, -5) : ctor
    const lim = elemBounds.get(base)
    if (!lim || !r || !Number.isFinite(r[0]) || !Number.isFinite(r[1])) return null
    return r[0] >= lim[0] && r[1] <= lim[1] ? [...r] : [...lim]
  }
  const initialRange = (rhs, ctor) => {
    const args = rhs?.[2]
    if (args == null || literal(args) != null) return [0, 0]
    const elems = staticArrayElems(args)
    if (!elems) return null
    let out = null
    for (const e of elems) {
      const r = storedRange(ctor, exprRange(e))
      if (!r) return null
      out = hull(out, r)
    }
    return out || [0, 0]
  }
  const mentions = (n, name) => refsName(n, name, REFS_THROUGH_ARROWS)
  // Expressions that can evaluate to the array object itself. Element/property
  // reads merely consume it and must not be mistaken for aliases.
  const carries = carriesName
  const funcs = ctx.funcs.list.filter(f => !f.raw && Array.isArray(f.body))
  const summaries = new Map()
  for (const f of funcs) summaries.set(f.name, f.sig.params.map(() => ({ range: null, writes: false, bad: false })))

  // Direct effects: each function's own body, in isolation — an array-elem
  // write through a param seeds/widens that param's summary range; any alias,
  // return-escape, or opaque call poisons it (`bad`). User-call forwarding
  // (a param passed straight through to another narrowable function) is
  // deliberately NOT resolved here — folded to a fixpoint below instead,
  // since a callee's own summary may itself still be settling.
  function computeDirectEffects() {
    for (const f of funcs) {
      const ps = new Map(f.sig.params.map((p, i) => [p.name, i]))
      const sum = summaries.get(f.name)
      const walk = (n, inClosure = false) => {
        if (!Array.isArray(n)) return
        const closure = inClosure || n[0] === '=>'
        if (closure && n !== f.body) {
          for (const [name, k] of ps) if (mentions(n, name)) sum[k].bad = true
          return
        }
        if (ASSIGN_OPS.has(n[0]) && Array.isArray(n[1]) && n[1][0] === '[]' && ps.has(n[1][1])) {
          const s = sum[ps.get(n[1][1])], r = n[0] === '=' ? storeRanges.get(f)?.get(n) ?? exprRange(n[2]) : null
          s.writes = true
          if (!r) s.bad = true; else s.range = hull(s.range, r)
        }
        // Aliases/returns escape the receiver; element/property reads do not.
        if (n[0] === 'return') for (const [name, k] of ps) if (carries(n[1], name)) sum[k].bad = true
        if (ASSIGN_OPS.has(n[0])) for (const [name, k] of ps) {
          if (n[1] === name || carries(n[2], name)) sum[k].bad = true
          if (Array.isArray(n[1]) && n[1][0] !== '[]' && mentions(n[1], name)) sum[k].bad = true
        }
        if (n[0] === '()') {
          const args = callArgs(n)
          const callee = typeof n[1] === 'string' ? n[1] : null
          for (const [name, k] of ps) {
            // Calling a method on the receiver may mutate it. A direct argument
            // to a known user function is handled by the summary fixpoint;
            // unknown or expression-hidden aliases poison immediately.
            if (mentions(n[1], name)) sum[k].bad = true
            for (const a of args) if (carries(a, name) && (!callee || !summaries.has(callee) || a !== name)) sum[k].bad = true
          }
        }
        for (let i = 1; i < n.length; i++) walk(n[i], closure)
      }
      walk(f.body)
    }
  }

  // Fold direct-effect summaries to a fixpoint across user-call forwarding: a
  // param passed straight through to another narrowable function's own param
  // inherits that callee's settled range/bad state, repeated until stable.
  function propagateCallForwarding() {
    let changed = true
    while (changed) {
      changed = false
      for (const f of funcs) {
        const ps = new Map(f.sig.params.map((p, i) => [p.name, i])), sum = summaries.get(f.name)
        walkAst(f.body, { enter: n => {
          if (n[0] === '=>') return false
          if (n[0] === '()' && typeof n[1] === 'string' && summaries.has(n[1])) {
            const args = callArgs(n), target = summaries.get(n[1])
            for (let k = 0; k < args.length; k++) if (ps.has(args[k])) {
              const s = sum[ps.get(args[k])], t = target[k]
              if (!t || t.bad) { if (!s.bad) { s.bad = true; changed = true } }
              else if (t.writes) {
                const r = hull(s.range, t.range)
                if (!s.writes || r[0] !== s.range?.[0] || r[1] !== s.range?.[1]) { s.writes = true; s.range = r; changed = true }
              }
            }
          }
        } })
      }
    }
  }

  // Per-function local typed-array variables: seed a range at each fresh
  // literal-initialized decl (initialRange), then narrow it at every element
  // store (storedRange) and every settled call-forwarding site (the param
  // summaries computeDirectEffects/propagateCallForwarding produced) —
  // poisoning on any alias/return-escape/opaque call, same discipline as the
  // param summaries above.
  function computeLocalRanges() {
    const locals = new Map()
    for (const f of funcs) {
      const ranges = new Map(), ctors = new Map(), poisoned = new Set(), freshDefs = new Set()
      const merge = (name, r) => {
        if (poisoned.has(name)) return
        if (!r) { poisoned.add(name); ranges.delete(name); return }
        ranges.set(name, hull(ranges.get(name), r))
      }
      walkAst(f.body, { enter: n => {
        if (n[0] === '=>') {
          for (const name of [...ranges.keys()]) if (mentions(n, name)) merge(name, null)
          return false
        }
        if (n[0] === 'let' || n[0] === 'const') for (let i = 1; i < n.length; i++) {
          const d = n[i]
          if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' && typedStaticLen(d[2]) != null) {
            const ctor = typedElemCtor(d[2]), init = initialRange(d[2], ctor)
            if (ctor && init) {
              ranges.set(d[1], init)
              ctors.set(d[1], ctor)
              freshDefs.add(d)
            }
          }
        }
        if (ASSIGN_OPS.has(n[0])) {
          if (Array.isArray(n[1]) && n[1][0] === '[]' && ranges.has(n[1][1]))
            merge(n[1][1], n[0] === '=' ? storedRange(ctors.get(n[1][1]), storeRanges.get(f)?.get(n) ?? exprRange(n[2])) : null)
          for (const name of [...ranges.keys()]) {
            if (!freshDefs.has(n) && (n[1] === name || carries(n[2], name))) merge(name, null)
            if (Array.isArray(n[1]) && n[1][0] !== '[]' && mentions(n[1], name)) merge(name, null)
          }
        }
        if (n[0] === 'return') for (const name of [...ranges.keys()]) if (carries(n[1], name)) merge(name, null)
        if (n[0] === '()') {
          const args = callArgs(n), callee = typeof n[1] === 'string' ? n[1] : null
          const target = callee ? summaries.get(callee) : null
          for (const name of [...ranges.keys()]) {
            if (mentions(n[1], name)) merge(name, null)
            for (let k = 0; k < args.length; k++) if (carries(args[k], name)) {
              if (args[k] !== name || !target?.[k] || target[k].bad) merge(name, null)
              else if (target[k].writes) merge(name, storedRange(ctors.get(name), target[k].range))
            }
          }
        }
      } })
      locals.set(f, ranges)
    }
    return locals
  }

  computeDirectEffects()
  propagateCallForwarding()
  const locals = computeLocalRanges()
  return { locals, summaries, hull, initialRange }
}

// ============================================================================
// Cross-function parameter-length-bound proof (ledger-performance.md §6.1)
// ============================================================================
// Does param K's value never exceed param R's runtime `.length`, PROVEN FROM
// THE CALLER'S OWN ARGUMENT EXPRESSIONS at every live call site (never from
// the callee's body — a callee cannot see who calls it). Feeds
// canonical-bounds.js's scanBoundedLoops: a loop `for (i=C; i<paramK; i++)
// recv.charCodeAt(i)` where paramK is a PARAMETER (not itself `recv.length`)
// can still take the canonical in-bounds proof — the SAME proof that already
// fires when the bound is written `recv.length` directly — once this fact
// supplies the missing `paramK <= recv.length` link (the tokenizer shape:
// `scan(src, n - (i&7))` where `n` is a single-def alias of `src.length`;
// `len` never exceeds `src`'s length, but neither is a compile-time
// constant, so typedLen itself can't carry it).
//
// Deliberately narrow: a small, terminating structural recursion over the
// SPECIFIC shapes real callers use to express "at most this receiver's
// length" (a `.length` read, a single-def alias of one, or that minus a
// provably-nonnegative amount) — not a general symbolic interval prover
// (interval-proof.js's own scope is numeric-literal-bound loop nests; this
// needs no absolute bound at all, only a relation to an unresolved runtime
// `.length`). Fails closed (returns false) on anything unrecognized: forgoes
// the proof, never wrong.
//
// SOUNDNESS: an entry-time relation ("the value passed for paramK does not
// exceed the length of the value passed for paramR"), proven once from the
// caller's own expressions and true only because BOTH names are ordinary
// parameters — bound once at the call and never reassigned thereafter
// (validated by narrow/param-abi.js's validateLenBoundOfParams, which also
// excludes any host-reachable function: an external caller isn't covered by
// this proof — same discipline as validateTypedLenParams). A consumer must
// additionally confirm the RECEIVER's length cannot change mid-activation
// (aliasing/re-entrancy) before trusting the relation past entry —
// scanBoundedLoops's own receiver is a JS string, immutable by language
// definition, so that half is free there. A future consumer over a MUTABLE
// receiver (a growable Array; canonical-bounds.js's sibling
// scanBoundedArrIdx) would need its own argument for why the length can't
// shrink underneath the proof — NOT wired here; see the ledger design note.

/** Resolve `name`'s initializer within `body` iff it has EXACTLY ONE
 *  `let`/`const` declaration in the whole body — a second declaration
 *  (shadowing/redeclaration) evicts to null, same discipline as
 *  loop-versioning.js's bodyAffineEnv. Does not descend into nested arrow
 *  bodies: a captured rebinding belongs to a DIFFERENT activation, never
 *  this caller's own single def. */
function singleDeclInit(body, name) {
  let init = null, count = 0
  walkAst(body, { enter: n => {
    if (n[0] === '=>') return false
    if (n[0] === 'let' || n[0] === 'const') for (let i = 1; i < n.length; i++) {
      const d = n[i]
      if (Array.isArray(d) && d[0] === '=' && d[1] === name) { count++; init = d[2] }
    }
  } })
  return count === 1 ? init : null
}

/** Does `expr` (an argument expression written in `body`) provably not
 *  exceed `recvName.length`? See the module-level doc above for the
 *  shape-class and soundness contract. `seen` (internal — callers omit it)
 *  guards the single-def alias chase against a pathological self-referential
 *  decl (`const n = n - 1`, a TDZ violation in real JS but not necessarily
 *  one this AST layer rejects earlier): each name visited once per call,
 *  never re-entered, so recursion terminates even on a cyclic chain instead
 *  of stack-overflowing — an unusual input still fails closed, it never
 *  crashes. */
export function boundedByCallerLength(expr, recvName, body, seen = null) {
  if (Array.isArray(expr) && expr.length === 3 && expr[0] === '.' && expr[2] === 'length' && expr[1] === recvName) return true
  if (typeof expr === 'string') {
    if (expr === recvName || isReassigned(body, expr)) return false
    if (seen?.has(expr)) return false
    const init = singleDeclInit(body, expr)
    return init != null && boundedByCallerLength(init, recvName, body, (seen ??= new Set()).add(expr))
  }
  if (Array.isArray(expr) && expr.length === 3 && expr[0] === '-') {
    const nonneg = typedValueExprRange(expr[2])
    return nonneg != null && nonneg[0] >= 0 && boundedByCallerLength(expr[1], recvName, body, seen)
  }
  return false
}
