/**
 * Direct/closure/generic call emission plus the '=>'/'()' emitter properties: isUserFunc, emitSpeculativeCall, emitBuiltinCall, emitDirectFunctionCall, tryDirectClosureCall, tagFnArrayDispatch, recordClosureTableCallSite, emitGenericClosureCall, emitUnknownCalleeCall.
 *
 * @module compile/emit/call
 */

import { encodePtrHi, i64Hex } from '../../../layout.js'
import {
  PARAM_DEFAULT, PARAM_KIND, PARAM_NAME, PARAM_PATTERN, T, classifyParam, commaList, extractParams, walkAst,
} from '../../ast.js'
import { LAYOUT, OPTF, PTR, ctx, err } from '../../ctx.js'
import {
  MAX_CLOSURE_ARITY, allocPtr, asF64, carrierF64, freshId, isBoundName, isNullish, reconstructArgsWithSpreads, temp, tempI32, throwTypeErrorIR, typed, undefExpr,
} from '../../ir.js'
import { censusMaybeUndefined, hasAmbiguousBoolMerge, valTypeOf } from '../../kind.js'
import { VAL } from '../../reps.js'
import { findFreeVars } from '../analyze.js'
import { recordClosureCallRepresentations, representationCallArgAction } from '../representation-plan.js'
import { plannedTypedStorageCtor } from '../typed-storage-plan.js'
import { attachSigMeta, buildArrayWithSpreads, materializeMulti, parseCallArgs } from './call-args.js'
import { TYPED_HI_MASK, argIR, coerceArg, emit, emitCallArgs, emitIdentitySafe } from './dispatch.js'
import { emitMethodCall } from './method-dispatch.js'


// A source-defined function (carries a body) — as opposed to an imported name,
// which `ctx.funcs.names` also holds but which has no body and may legitimately
// share a name with a built-in emitter (e.g. an imported `parseInt`).
const isUserFunc = name => !!ctx.funcs.map.get(name)?.body
function emitSpeculativeCall(callee, spec, argNodes, func) {
  const params = func.sig.params
  const specAt = new Map(spec.guards.map(g => [g.k, g.aux]))
  const rt = func.sig.results[0] || 'f64'
  const seq = [], slots = []
  for (let k = 0; k < params.length; k++) {
    if (k < argNodes.length) {
      const ir = coerceArg(argIR(argNodes[k]), params[k], argNodes[k],
        representationCallArgAction(ctx, argNodes[k], params, k))
      // Temp width follows the PARAM's ABI (coerceArg's contract), not the IR
      // tag — pointer-ABI coercions (`__ptr_offset`) come back untagged i32.
      const pt = params[k].ptrKind != null || params[k].type === 'i32' ? 'i32' : 'f64'
      const t = pt === 'i32' ? tempI32('sa') : temp('sa')
      seq.push(['local.set', `$${t}`, ir])
      slots.push({ local: t, type: pt })
    } else {
      slots.push(null)  // arity pad — fresh per use below
    }
  }
  const get = (k) => slots[k]
    ? typed(['local.get', `$${slots[k].local}`], slots[k].type)
    : params[k].type === 'i32' ? typed(['i32.const', 0], 'i32') : undefExpr()
  let cond = null
  for (const [k, aux] of specAt) {
    const c = ['i64.eq',
      ['i64.and', ['i64.reinterpret_f64', get(k)], ['i64.const', TYPED_HI_MASK]],
      ['i64.const', i64Hex(BigInt(encodePtrHi(PTR.TYPED, aux)) << 32n)]]
    cond = cond ? ['i32.and', cond, c] : c
  }
  const thenArgs = params.map((p, k) => specAt.has(k)
    ? ['i32.wrap_i64', ['i64.and', ['i64.reinterpret_f64', get(k)], ['i64.const', LAYOUT.OFFSET_MASK]]]
    : get(k))
  const elseArgs = params.map((p, k) => get(k))
  const ifIR = ['if', ['result', rt], cond,
    ['then', ['call', `$${spec.clone}`, ...thenArgs]],
    ['else', ['call', `$${callee}`, ...elseArgs]]]
  return attachSigMeta(typed(['block', ['result', rt], ...seq, ifIR], rt), func.sig)
}

/** Builtin / module-emitter call: `Math.max(...)`, `JSON.parse(...)`, etc. The
 *  emitter accepts the same `...args` flat shape as the AST (with `['...', x]`
 *  spread markers re-inserted in original position). */
function emitBuiltinCall(callee, parsed) {
  if (parsed.hasSpread) {
    const allArgs = []
    let ni = 0
    for (const s of parsed.spreads) {
      while (ni < s.pos) allArgs.push(parsed.normal[ni++])
      allArgs.push(['...', s.expr])
    }
    while (ni < parsed.normal.length) allArgs.push(parsed.normal[ni++])
    return ctx.core.emit[callee](...allArgs)
  }
  return ctx.core.emit[callee](...parsed.normal)
}

/** Direct call to a known top-level user function — emits `(call $callee args)`.
 *  Handles rest params (collect into trailing array), in-spread fixed params
 *  (runtime split), default-param padding, multi-value return materialization. */
function emitDirectFunctionCall(callee, parsed, callArgs) {
  const func = ctx.funcs.map.get(callee)

  // Rest param case: collect all args (including expanded spreads) into array
  if (func?.rest) {
    const fixedParamCount = func.sig.params.length - 1
    // A spread positioned within the fixed-param range supplies fixed params from
    // inside the spread — they can't be sliced out statically. Build the full args
    // array A and split it at runtime: fixed[k] = A[k], rest = A.slice(fixedParamCount).
    // (Otherwise the static slice below is exact and skips the extra alloc + copy.)
    if (fixedParamCount > 0 && parsed.spreads.some(s => s.pos < fixedParamCount)) {
      const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
      const aVal = temp('ra'), aOff = tempI32('rao'), aLen = tempI32('ral'), rLen = tempI32('rln')
      const rest = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${rLen}`], tag: 'rr' })
      const fixedLoads = []
      for (let k = 0; k < fixedParamCount; k++) {
        const load = typed(['if', ['result', 'f64'],
          ['i32.gt_s', ['local.get', `$${aLen}`], ['i32.const', k]],
          ['then', ['f64.load', ['i32.add', ['local.get', `$${aOff}`], ['i32.const', k * 8]]]],
          ['else', undefExpr()]], 'f64')
        fixedLoads.push(coerceArg(load, func.sig.params[k]))
      }
      const callIR = typed(['block', ['result', func.sig.results[0]],
        ['local.set', `$${aVal}`, asF64(buildArrayWithSpreads(combined))],
        ['local.set', `$${aOff}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${aVal}`]]]],
        ['local.set', `$${aLen}`, ['i32.load', ['i32.sub', ['local.get', `$${aOff}`], ['i32.const', 8]]]],
        ['local.set', `$${rLen}`, ['select',
          ['i32.sub', ['local.get', `$${aLen}`], ['i32.const', fixedParamCount]],
          ['i32.const', 0],
          ['i32.gt_s', ['local.get', `$${aLen}`], ['i32.const', fixedParamCount]]]],
        rest.init,
        ['memory.copy', ['local.get', `$${rest.local}`],
          ['i32.add', ['local.get', `$${aOff}`], ['i32.const', fixedParamCount * 8]],
          ['i32.shl', ['local.get', `$${rLen}`], ['i32.const', 3]]],
        ['call', `$${callee}`, ...fixedLoads, rest.ptr]], func.sig.results[0])
      return attachSigMeta(callIR, func.sig)
    }
    // Pad missing fixed args with `undefined` so default-param init triggers per spec.
    const fixedParams = func.sig.params.slice(0, fixedParamCount)
    const emittedFixed = emitCallArgs(parsed.normal.slice(0, fixedParamCount), fixedParams)

    // Reconstruct with spreads, then take rest args
    const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
    const restArgsFinal = combined.slice(fixedParamCount)

    // Build array: emit code for normal args + code to expand spreads
    const arrayIR = buildArrayWithSpreads(restArgsFinal)
    return attachSigMeta(typed(['call', `$${callee}`, ...emittedFixed, arrayIR], func.sig.results[0]), func.sig)
  }

  // Regular function call without rest params
  if (parsed.hasSpread) err(`Spread not supported in calls to non-variadic function ${callee} — pass arguments individually, or give ${callee} a rest parameter (...args)`)
  // Speculative typed dispatch (narrow's speculateTypedParams): route the call
  // through a per-arg tag guard to the typed clone; a miss takes the original
  // call unchanged. Guard positions must be covered by real args — a site
  // relying on arity-padding at a speculated position would guard `undefined`
  // every call, pure loss.
  const spec = func && ctx.types.specFns?.get(callee)
  if (spec && func.sig.results.length === 1 && spec.guards.every(g => g.k < parsed.normal.length))
    return emitSpeculativeCall(callee, spec, parsed.normal, func)
  // Pad missing args with `undefined` so default-param init triggers per spec
  // (only undefined, not null, should trigger defaults). Drop extras to match
  // JS calling convention — emitting them anyway produces an invalid call
  // when the callee is a fixed-arity import (e.g. `_interp`-registered host
  // stubs) since wasm validates arg count. Use ?? rather than || so a
  // legitimate 0-arity callee isn't bypassed.
  const params = func?.sig.params ?? []
  const args = func ? emitCallArgs(parsed.normal, params)
                    : parsed.normal.map(a => coerceArg(argIR(a), undefined, a))
  if (func && args.length > params.length) args.length = params.length
  // Multi-value return: materialize as heap array (caller expects single pointer).
  // Reuse the canonical comma-wrapped arg slot — materializeMulti re-reads args
  // via commaList(node[2]); a spread-form `[…, ...parsed.normal]` would drop every
  // argument past the first.
  if (func?.sig.results.length > 1) return materializeMulti(['()', callee, callArgs])
  // attachSigMeta also handles the unsigned-uint32 flag (every tail was `>>>`),
  // so consumer's asF64 uses `f64.convert_i32_u` instead of `_s` ([0, 2^32) range).
  const callIR = attachSigMeta(typed(['call', `$${callee}`, ...args], func?.sig.results[0] || 'f64'), func?.sig)
  return callIR
}

/** Const-bound, non-escaping closure — direct call to its body, skipping
 *  call_indirect. emitDecl registered name→bodyName when it saw the closure.make
 *  IR. Returns null if arity exceeds the closure-table slot width (caller falls
 *  through to the generic closure path). */
function tryDirectClosureCall(callee, parsed) {
  const bodyName = ctx.func.directClosures.get(callee)
  const W = ctx.closure.width ?? MAX_CLOSURE_ARITY
  const n = parsed.normal.length
  if (n > W) return null
  // Per-param "every direct call site passed a number" lattice. Every call to a
  // direct (non-escaping) closure flows through here, so once the body is emitted
  // (module end, after all calls) a param only ever seen with numeric args is marked
  // VAL.NUMBER — its body uses then skip __to_num, the same boxing win the numeric
  // export-param path gives. An arg we can't prove numeric poisons the slot to false.
  const pt = (ctx.closure.paramTypes ||= new Map())
  let row = pt.get(bodyName); if (!row) pt.set(bodyName, row = [])
  // Parallel typed-array ctor lattice: a param passed the SAME typed-array ctor at
  // every direct call site is a TYPED param, so its body reads (`buf[i]`) take the
  // typed fast-path instead of the dynamic `__typed_idx`/`__len` route that drags in
  // the string runtime. `null` (sticky) once two sites disagree or an arg isn't a
  // known typed array — the same monotone meet as the numeric row. Mirrors the named-fn
  // applyTypedPointerParamAbi, restricted to non-escaping (directly-called) closures.
  const tc = (ctx.closure.paramTypedCtors ||= new Map())
  let tcRow = tc.get(bodyName); if (!tcRow) tc.set(bodyName, tcRow = [])
  for (let i = 0; i < n; i++) {
    const numeric = valTypeOf(parsed.normal[i]) === VAL.NUMBER
    row[i] = row[i] === undefined ? numeric : (row[i] && numeric)
    const arg = parsed.normal[i]
    const ctor = valTypeOf(arg) === VAL.TYPED ? plannedTypedStorageCtor(ctx, arg) : null
    if (tcRow[i] === undefined) tcRow[i] = ctor
    else if (tcRow[i] !== ctor) tcRow[i] = null
  }
  // Track the fewest args any call passed: a slot at index ≥ minArgc is omitted by some call
  // site (padded with UNDEF_NAN), so it may be undefined — emitClosureBody flags it nullable.
  const mn = (ctx.closure.minArgc ||= new Map())
  const prev = mn.get(bodyName)
  mn.set(bodyName, prev === undefined ? n : (n < prev ? n : prev))
  // Body signature is uniform $ftN: (env f64, argc i32, a0..a{W-1} f64) → f64.
  // We pass the closure NaN-box itself as env (body extracts captures via __ptr_offset(__env)).
  // Slots are untyped boxed-value positions: a BOOL arg crosses as its atom box
  // (the paramTypes numeric lattice above already poisons on non-NUMBER args, so
  // the body never assumes raw numerics for these slots). An ambiguous BOOL-merge
  // arg (.work/todo.md §deletion-sweep) needs emitIdentitySafe in place of
  // carrierF64 — same post-hoc-powerless reasoning as the return tail/store sites.
  recordClosureCallRepresentations(ctx, bodyName, parsed.normal)
  const slots = parsed.normal.map(a => hasAmbiguousBoolMerge(a) ? emitIdentitySafe(a) : carrierF64(a, emit(a)))
  while (slots.length < W) slots.push(undefExpr())
  return typed(['call', `$${bodyName}`,
    asF64(emit(callee)),
    typed(['i32.const', n], 'i32'),
    ...slots], 'f64')
}

/** Tag the generic call_indirect of `constFnArr[idx](args)` for the optimizer's
 *  devirtConstFnArrayCalls pass (optimize/index.js). The candidate set — a
 *  module-const array of capture-free arrows — is recorded when the DECL emits,
 *  which happens in buildStartFn AFTER function bodies emit; so emit only marks
 *  the site (receiver name), and the rewrite runs in optimizeFunc where the
 *  facts are complete. */
export const tagFnArrayDispatch = (ir, arrName) => {
  let ci = null
  walkAst(ir, { enter: (n) => {
    if (ci) return false
    if (n[0] === 'call_indirect') { ci = n; return false }
  } })
  if (ci) ci.dvArr = arrName
  return ir
}

/** Closure-TABLE call-site PARAM lattice — evidence side. `arrName` is a
 *  proven-safe table (ctx.scope.closureTableLatticeCandidates, dyn-closure-
 *  tables.js): every call `arrName[idx](args)` accumulates into a per-array-
 *  name row, exactly the reduction tryDirectClosureCall runs per bodyName
 *  (numeric AND-join, typed-ctor agreement, min arg count) — just keyed by
 *  the ARRAY name since the literal (and therefore its elements' bodyNames)
 *  hasn't emitted yet at this call site's own emit time. A dynamic index
 *  means ANY element could be the one invoked, so every call site's evidence
 *  is conservatively applied to every element alike when the array literal
 *  resolves it (isGlobal decl path, below). Also fires for the IMPERATIVE-
 *  construction class (ctx.scope.imperativeClosureTableLatticeCandidates,
 *  dyn-closure-tables.js) — same accumulator, resolved by compile/index.js's
 *  early-merge step instead of the const-literal decl's own emit time. */
function recordClosureTableCallSite(arrName, argNodes) {
  const W = ctx.closure.width ?? MAX_CLOSURE_ARITY
  const n = Math.min(argNodes.length, W)
  const evid = (ctx.scope.closureTableArgEvidence ||= new Map())
  let e = evid.get(arrName)
  if (!e) evid.set(arrName, e = { numRow: [], tcRow: [], minArgc: undefined })
  for (let i = 0; i < n; i++) {
    const arg = argNodes[i]
    const numeric = valTypeOf(arg) === VAL.NUMBER
    e.numRow[i] = e.numRow[i] === undefined ? numeric : (e.numRow[i] && numeric)
    const ctor = valTypeOf(arg) === VAL.TYPED ? plannedTypedStorageCtor(ctx, arg) : null
    e.tcRow[i] = e.tcRow[i] === undefined ? ctor : (e.tcRow[i] !== ctor ? null : e.tcRow[i])
  }
  e.minArgc = e.minArgc === undefined ? n : Math.min(e.minArgc, n)
}

/** Generic closure call: callee is a value holding a NaN-boxed closure pointer.
 *  Uniform convention: fn.call packs all args into an array and trampolines. */
function emitGenericClosureCall(callee, parsed) {
  const arrName = !parsed.hasSpread && Array.isArray(callee) && callee[0] === '[]' && typeof callee[1] === 'string'
    ? callee[1] : null
  const dvName = (ctx.transform.optFlags & OPTF.devirtClosureTables) && arrName ? arrName : null
  if (arrName && (ctx.scope.closureTableLatticeCandidates?.has(arrName) ||
      ctx.scope.imperativeClosureTableLatticeCandidates?.has(arrName)))
    recordClosureTableCallSite(arrName, parsed.normal)
  // `callee` is a genuinely dynamic expression here — every
  // statically-resolved shape (known top-level function, direct non-escaping
  // closure, method call) was already sifted off by the '()' dispatcher above
  // this function, so its kind is unproven and it may be nullish at runtime
  // (e.g. `m.get('missing')()`, a census-shaped dict/Map absent-key read).
  // ctx.closure.call's call_indirect reads the nullish sentinel's aux bits as
  // a function-table index unconditionally — an out-of-bounds wasm trap,
  // uncatchable in-source ("table index out of bounds"). Real JS throws
  // TypeError.
  //
  // A BARE-NAME callee (`typeof callee === 'string'`, e.g. `f(x)`) is emitted
  // TWICE instead of hoisted through a shared temp — found live, not assumed
  // safe: an intermediate `local.set $ct = (select const1 const2 cond); ...
  // call_indirect(local.get $ct, ...)` hides the "closure value is a select
  // of ≤2 known constants" shape from watr's own post-optimizer devirt pass
  // (perf(wat) "devirt — call_indirect with known closure constants → guarded
  // direct calls", commit 4c49c2ec) — that pass pattern-matches the select
  // directly feeding the call_indirect operand's `local.set`, one level of
  // indirection it does not trace through. `readVar` (ir.js) is pure for a
  // bare name (`local.get`/`global.get`, no side effect, no shared node
  // object between the two emissions — each `emit(callee)` call returns a
  // fresh IR node), so evaluating it twice is exactly as safe as the
  // single-eval case and costs nothing extra once optimized (V8/watr CSE the
  // repeated load). A COMPOUND callee (`m.get(k)()`, `arr[i]()`) may carry a
  // real side effect (the `.get` call itself) — hoisted through a temp,
  // exactly as before; this shape was never the ternary-select-of-constants
  // pattern the devirt pass targets, so hoisting it costs nothing there.
  // Only a genuinely mayBeUndefined callee pays for the guard —
  // same `censusMaybeUndefined` predicate as every other check in this
  // design (tryRuntimePtrTypeFork's comment has the measured SIZE cost of
  // gating on "unresolved kind" alone instead). A callee that is unresolved
  // only because it's a PLAIN closure-holding parameter/local (never
  // touched by census/dict machinery — e.g. `const pass = (g, x) => g(x)`)
  // is unaffected, byte-for-byte, from before this task.
  const mayBeUndef = censusMaybeUndefined(callee)
  const pureCallee = typeof callee === 'string'
  const guarded = (whenOk) => {
    if (!mayBeUndef) return asF64(whenOk(asF64(emit(callee))))
    if (pureCallee) return typed(['if', ['result', 'f64'],
      isNullish(asF64(emit(callee))),
      ['then', throwTypeErrorIR('call')],
      ['else', asF64(whenOk(asF64(emit(callee))))]], 'f64')
    const ct = temp('gcallee')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${ct}`, asF64(emit(callee))],
      ['if', ['result', 'f64'],
        isNullish(typed(['local.get', `$${ct}`], 'f64')),
        ['then', throwTypeErrorIR('call')],
        ['else', asF64(whenOk(typed(['local.get', `$${ct}`], 'f64')))]]], 'f64')
  }
  if (parsed.hasSpread) {
    const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
    const arrayIR = buildArrayWithSpreads(combined)
    // Pass pre-built array as single already-emitted arg
    return guarded(recv => ctx.closure.call(recv, [arrayIR], true))
  }
  const ir = guarded(recv => ctx.closure.call(recv, parsed.normal))
  return dvName ? tagFnArrayDispatch(ir, dvName) : ir
}

/** Last-resort fallback: assume `(call $callee args)` against an import / unknown
 *  identifier. Matches arg count to the env-import signature when known — wasm
 *  validates arity strictly, so JS-style "pad missing / drop extra" needs to be
 *  done here rather than by the host. */
function emitUnknownCalleeCall(callee, argList) {
  let calleeArity = null
  if (typeof callee === 'string') {
    const imp = ctx.module.imports?.find(i =>
      Array.isArray(i) && i[0] === 'import' && i[3]?.[0] === 'func' && i[3]?.[1] === `$${callee}`)
    if (imp) {
      let n = 0
      for (let k = 2; k < imp[3].length; k++) if (Array.isArray(imp[3][k]) && imp[3][k][0] === 'param') n++
      calleeArity = n
    }
  }
  const emittedArgs = argList.map(a => asF64(emit(a)))
  if (calleeArity != null) {
    while (emittedArgs.length < calleeArity) emittedArgs.push(undefExpr())
    if (emittedArgs.length > calleeArity) emittedArgs.length = calleeArity
  }
  return typed(['call', `$${callee}`, ...emittedArgs], 'f64')
}
export const callOps = {
  // === Call ===

  // Arrow as value → closure
  '=>': (rawParams, body) => {
    if (!ctx.closure.make) err('Closures require fn module (auto-included)')

    const raw = extractParams(rawParams)
    const params = [], defaults = {}
    let restParam = null, bodyPrefix = []
    for (const r of raw) {
      const c = classifyParam(r)
      if (c[PARAM_KIND] === 'rest') { restParam = c[PARAM_NAME]; params.push(c[PARAM_NAME]) }
      else if (c[PARAM_KIND] === 'plain') params.push(c[PARAM_NAME])
      else if (c[PARAM_KIND] === 'default') { params.push(c[PARAM_NAME]); defaults[c[PARAM_NAME]] = c[PARAM_DEFAULT] }
      else {
        const tmp = `${T}p${freshId(ctx)}`
        params.push(tmp)
        if (c[PARAM_KIND] === 'destruct-default') defaults[tmp] = c[PARAM_DEFAULT]
        bodyPrefix.push(['let', ['=', c[PARAM_PATTERN], tmp]])
      }
    }

    // Prepend destructuring to body (if any destructured params)
    if (bodyPrefix.length) {
      if (Array.isArray(body) && body[0] === '{}' && Array.isArray(body[1]) && body[1][0] === ';')
        body = ['{}', [';', ...bodyPrefix, ...body[1].slice(1)]]
      else if (Array.isArray(body) && body[0] === '{}')
        body = ['{}', [';', ...bodyPrefix, body[1]]]
      else body = ['{}', [';', ...bodyPrefix, ['return', body]]]
    }

    // Find free variables in body that aren't params → captures
    const paramSet = new Set(params)
    const captures = []
    findFreeVars(body, paramSet, captures)
    for (const def of Object.values(defaults)) findFreeVars(def, paramSet, captures)

    // Pass closure info including rest param and defaults. rawParams is the
    // ClosureEnvPlan fallback lookup key for a destructured-param closure
    // (src/compile/closure-plan.js's mintClosureEnvPlans doc) — `body` above
    // was just reassigned to a FRESH array when bodyPrefix is non-empty, so
    // the plan (minted pre-emission, before this reassignment ever happened)
    // cannot be keyed on it; rawParams is untouched by this rewrite and is
    // the same reference the mint saw.
    const closureInfo = { params, body, captures, restParam, rawParams }
    if (Object.keys(defaults).length) closureInfo.defaults = defaults
    return ctx.closure.make(closureInfo)
  },

  // Linear callee-kind dispatcher. Each strategy below is its own named function
  // (extracted to module scope above); this body is just the routing table.
  '()': (callee, callArgs) => {
    const argList = commaList(callArgs)
    const parsed = parseCallArgs(argList)

    // Closure devirtualization: a module-global callee proven (by plan.js) to hold
    // one statically-known function rewrites to that function, so the
    // known-top-level-function branch emits a direct `call`, dropping the
    // indirect/trampoline path.
    if (typeof callee === 'string' && ctx.funcs.globalDevirt?.has(callee))
      callee = ctx.funcs.globalDevirt.get(callee)

    if (Array.isArray(callee) && callee[0] === '.')  return emitMethodCall(callee, parsed, callArgs)

    if (typeof callee === 'string' && ctx.core.emit[callee] && !isBoundName(callee) && !isUserFunc(callee))
      return emitBuiltinCall(callee, parsed)

    if (typeof callee === 'string' && ctx.funcs.names.has(callee) && !isBoundName(callee))
      return emitDirectFunctionCall(callee, parsed, callArgs)

    if (typeof callee === 'string' && !parsed.hasSpread && ctx.func.directClosures?.has(callee)) {
      const direct = tryDirectClosureCall(callee, parsed)
      if (direct) return direct
    }

    if (ctx.closure.call) return emitGenericClosureCall(callee, parsed)

    return emitUnknownCalleeCall(callee, argList)
  },
}
