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
    // valResult/valResultMayBeUndefined (Slice 2, .work/todo.md
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
