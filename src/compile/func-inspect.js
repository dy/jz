import { isMemWrite } from 'watr/optimize'
import { walkAst } from '../ast.js'
import { matchIncN, constNum } from '../optimize/vectorize/addr-model.js'
import { ctx } from '../ctx.js'
import { REP_FIELDS } from '../reps.js'
import { isExported } from './func-exports.js'

/** Serialize a ValueRep entry into a plain object for inspect output.
 *  Omits undefined fields so consumers can JSON-stringify without noise.
 *  Iterates REP_FIELDS (the closed shape in reps.js) so it can't drift. */
const repView = (rep) => {
  if (!rep) return null
  const out = {}
  for (const k of REP_FIELDS) if (rep[k] != null) out[k] = rep[k]
  return Object.keys(out).length ? out : null
}

/** Capture a function's inferred shape into ctx.inspect.functions. Called after
 *  analyzeFuncForEmit when transform.inspect is set — reads from FunctionPlan +
 *  programFacts.paramReps, never from the live ctx.func.* (which churns per emit). */
export function captureFuncInspect(func, facts, programFacts) {
  if (!ctx.inspect || func.raw) return
  const { name, sig } = func
  const reps = facts?.localReps
  const paramNames = new Set(sig.params.map(p => p.name))
  const params = sig.params.map(p => ({
    name: p.name, type: p.type,
    ...(p.ptrKind != null ? { ptrKind: p.ptrKind } : {}),
    ...(p.ptrAux != null ? { ptrAux: p.ptrAux } : {}),
    ...(repView(reps?.get(p.name)) || {}),
  }))
  const locals = {}
  if (facts?.locals) {
    for (const [lname, ltype] of facts.locals) {
      if (paramNames.has(lname)) continue
      const v = repView(reps?.get(lname))
      locals[lname] = v ? { type: ltype, ...v } : { type: ltype }
    }
  }
  const callerReps = {}
  const cr = programFacts.paramReps?.get(name)
  if (cr) for (const [idx, r] of cr) {
    const v = repView(r)
    if (v) callerReps[idx] = v
  }
  ctx.inspect.functions[name] = {
    exported: isExported(func),
    params,
    results: sig.results.slice(),
    ...(sig.ptrKind != null ? { resultPtrKind: sig.ptrKind } : {}),
    ...(sig.ptrAux != null ? { resultPtrAux: sig.ptrAux } : {}),
    // valResult/valResultMayBeUndefined (Slice 2, .work/archive/todo.md
    // §deletion-sweep §3 "Return kinds") — narrowValResults' joined VAL
    // kind across every return site, and the mayBeUndefined OR-join riding
    // alongside it. Exposed for the same reason params/locals are: the pure-
    // analysis test harness precedent (test/types.js) this design's Slice 1
    // established, since neither fact changes emitted WAT yet.
    ...(func.valResult != null ? { valResult: func.valResult } : {}),
    ...(func.valResultMayBeUndefined ? { valResultMayBeUndefined: true } : {}),
    locals,
    ...(Object.keys(callerReps).length ? { callerReps } : {}),
  }
}

/** Proofs about emitted exports, including their transitive runtime helpers.
 *  true means proved; null means unknown. This inspection never changes codegen.
 *  Work counts Wasm instructions, not time, and excludes host marshalling/init.
 */
export function captureRuntimeInspect(module, sharedMemory = false) {
  const funcs = new Map(), exports = [], records = new Map()
  for (const n of module) {
    if (!Array.isArray(n)) continue
    if (n[0] === 'func') {
      funcs.set(n[1], n)
      for (const c of n) if (Array.isArray(c) && c[0] === 'export') exports.push([JSON.parse(c[1]), n[1]])
    } else if (n[0] === 'export' && n[2]?.[0] === 'func') exports.push([JSON.parse(n[1]), n[2][1]])
  }
  for (const [name, fn] of funcs) {
    const rec = { calls: new Set(), allocation: false, indirect: false }
    walkAst(fn, { enter: n => {
      const op = n[0]
      if (op === 'call' || op === 'return_call') rec.calls.add(n[1])
      if (op === 'import' || /^(return_)?call_(indirect|ref)$/.test(op)) rec.indirect = true
      if (op === 'memory.grow' || op === 'table.grow' || op === 'global.set' && /^\$__heap(?:_|$)/.test(n[1]) ||
          sharedMemory && isMemWrite(op)) rec.allocation = true
    } })
    records.set(name, rec)
  }
  const costs = new Map()
  const cost = (name, visiting = new Set()) => {
    if (costs.has(name)) return costs.get(name)
    if (!funcs.has(name) || visiting.has(name)) return null
    visiting.add(name)
    const count = n => {
      if (!Array.isArray(n)) return 0
      const op = n[0]
      if (['param', 'result', 'local', 'export', 'type'].includes(op)) return 0
      if (op === 'import' || /^(return_)?call_(indirect|ref)$/.test(op) ||
          /^(try|catch|throw|rethrow|delegate)/.test(op) ||
          /^(memory|table)\.(copy|fill|init|grow)$/.test(op) || /atomic\.wait/.test(op)) return null
      let total = 1
      for (let i = 1; i < n.length; i++) {
        const c = count(n[i])
        if (c == null) return null
        total += c
      }
      if (op === 'call' || op === 'return_call') {
        const c = cost(n[1], visiting)
        if (c == null) return null
        total += c
      }
      if (op === 'loop') {
        if (!finiteCounterLoop(n)) return null
        // At most one full i32 domain traversal, plus the final exit check.
        // Deliberately loose: no entry-range claim is reconstructed here.
        total *= 4294967297
      }
      return Number.isSafeInteger(total) ? total : null
    }
    const result = count(funcs.get(name))
    visiting.delete(name)
    costs.set(name, result)
    return result
  }
  const result = {}
  for (const [exportName, target] of exports) {
    let noAllocation = true, noHostCalls = true
    const seen = new Set(), pending = [target]
    while (pending.length) {
      const name = pending.pop()
      if (seen.has(name)) continue
      seen.add(name)
      const rec = records.get(name)
      if (!rec || rec.indirect) { noHostCalls = null; noAllocation = null }
      if (rec?.allocation) noAllocation = null
      if (rec) for (const c of rec.calls) pending.push(c)
    }
    const maxInstructions = cost(target)
    result[exportName] = { noAllocation, noHostCalls, boundedWork: maxInstructions == null ? null : true, maxInstructions }
  }
  return result
}

// A single unconditional positive counter step and a sole back edge controlled
// by a constant upper bound. The exit interval must be wider than the step, so
// wrapping cannot skip it forever. Other loops remain unknown.
function finiteCounterLoop(loop) {
  const tail = loop[loop.length - 1]
  // The vectorizer matcher accepts decimal text; a proof must not misread
  // hexadecimal/underscored immediates as a smaller increment or bound.
  const stepOf = n => typeof n?.[2]?.[2]?.[1] === 'number' ? matchIncN(n) : null
  let cmp, step
  if (tail?.[0] === 'br_if' && tail[1] === loop[1]) {
    cmp = tail[2]
    if (cmp?.[1]?.[0] === 'local.tee') step = stepOf(['local.set', cmp[1][1], cmp[1][2]])
    else step = stepOf(loop[loop.length - 2])
  } else if (tail?.[0] === 'br' && tail[1] === loop[1]) {
    step = stepOf(loop[loop.length - 2])
    const head = loop[2]
    if (head?.[0] !== 'br_if' || head[1] === loop[1]) return false
    cmp = head[2]
    if (cmp?.[0] === 'i32.eqz') cmp = cmp[1]
    else if (cmp?.[0] === 'i32.ge_s' || cmp?.[0] === 'i32.ge_u') cmp = [cmp[0].replace('ge', 'lt'), cmp[1], cmp[2]]
    else return false
  }
  if (!step || step.c <= 0 || !Number.isInteger(step.c) || step.c > 2147483647 ||
      !['i32.lt_s', 'i32.lt_u'].includes(cmp?.[0]) ||
      !['local.get', 'local.tee'].includes(cmp?.[1]?.[0]) || cmp[1][1] !== step.name) return false
  const raw = typeof cmp[2]?.[1] === 'number' ? constNum(cmp[2]) : null
  if (!Number.isInteger(raw) || raw < -2147483648 || raw > 4294967295) return false
  const unsigned = cmp[0] === 'i32.lt_u', bound = unsigned ? raw >>> 0 : raw | 0
  if (bound > (unsigned ? 4294967295 : 2147483647) - step.c + 1) return false
  let writes = 0, backs = 0, unsafe = false
  walkAst(loop, { enter: n => {
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && n[1] === step.name) writes++
    if ((n[0] === 'br' || n[0] === 'br_if') && n[1] === loop[1]) backs++
    if (n !== loop && n[0] === 'loop' || n[0] === 'br_table' ||
        /^(br|local\.(get|set|tee))/.test(n[0]) && typeof n[1] !== 'string') unsafe = true
  } })
  return !unsafe && writes === 1 && backs === 1
}
