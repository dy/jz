import { ctx, inc, PTR, declGlobal, assertCtxInvariants } from '../ctx.js'
import { T, isBlockBody, isReassigned } from '../ast.js'
import { hasAmbiguousBoolMerge } from '../kind.js'
import { typedElemAux } from '../../layout.js'
import { VAL, updateRep } from '../reps.js'
import {
  MAX_CLOSURE_ARITY, asF64, boxedAddr, isUndef, undefExpr, carrierF64,
  applyBigintRepresentationAction, freshId, dollar,
} from '../ir.js'
import { restoreActiveFunction } from './active-function.js'
import { enterPreparedFunction, publishPreparedFunctionPlan } from './function-plan.js'
import { makeMapOverlay } from './map-overlay.js'
import { unboxablePtrs, inheritPtrAliases, boxedCaptures, reanalyzeBody } from './analyze.js'
import { inferLocals } from './infer.js'
import { mintLoopPlans } from './loop-model.js'
import { mintClosureEnvPlans } from './closure-plan.js'
import {
  mintRepresentationPlan, representationProgramHasBigint, representationReturnAction,
} from './representation-plan.js'
import { mintTypedStoragePlan } from './typed-storage-plan.js'
import { emit, emitBlockBody, emitIdentitySafe } from './emit.js'
import { enterFunc, emitPreboxedLocalInits } from './func-entry.js'
import { paramAllUsesNumeric } from './param-numeric.js'

const normalizeClosureBody = cb => {
  if (Array.isArray(cb.body) && cb.body[0] === ';') cb.body = ['{}', cb.body]
}

const closureSig = cb => {
  const params = [{ name: '__env', type: 'f64' }, { name: '__argc', type: 'i32' }]
  const width = ctx.closure.width ?? MAX_CLOSURE_ARITY
  for (let i = 0; i < width; i++) params.push({ name: `__a${i}`, type: 'f64' })
  return { params, results: ['f64'] }
}

const enterClosureFrame = cb => enterFunc(closureSig(cb), cb.body, {
  uniq: Math.max(ctx.func.uniq, 100),
  directClosures: cb.directClosures ? new Map(cb.directClosures) : null,
})

/** Seed the closure's captured/call-site facts on its active analysis frame. */
function seedClosureFrame(cb, prevSchemaVars, prevTypedElems) {
  ctx.func.boxedResult = true
  if (cb.intConsts) for (const [name, v] of cb.intConsts) updateRep(name, { intConst: v })
  if (cb.intCertain) for (const name of cb.intCertain) updateRep(name, { intCertain: true })
  if (cb.nullables) for (const name of cb.nullables) updateRep(name, { nullable: true })
  // A captured census value keeps its monotone maybe-undefined/presence fact
  // inside the closure; otherwise a locally-settled kind could erase it.
  if (cb.mayBeUndefineds) for (const name of cb.mayBeUndefineds)
    updateRep(name, { mayBeUndefined: true, presence: 'maybe-undef' })
  if (cb.valTypes) for (const [name, vt] of cb.valTypes) updateRep(name, { val: vt })
  if (cb.schemaVars) {
    ctx.schema.vars = makeMapOverlay(prevSchemaVars, new Map(cb.schemaVars))
    for (const [name, sid] of cb.schemaVars) updateRep(name, { schemaId: sid })
  }
  const globalTE = ctx.scope.globalTypedElem
  ctx.func.typedElem = cb.typedElems
    ? makeMapOverlay(globalTE, new Map(cb.typedElems))
    : globalTE ? makeMapOverlay(globalTE) : prevTypedElems
  const globalTL = ctx.scope.globalTypedLen
  ctx.func.typedLen = cb.typedLens
    ? makeMapOverlay(globalTL, new Map(cb.typedLens))
    : globalTL ? makeMapOverlay(globalTL) : null
  ctx.func.boxed = cb.boxed ? new Map([...cb.boxed].map(v => [v, v])) : new Map()
  // Fresh per closure body too — see analyzeFuncForEmit's identical reset
  // (above) for why these can't be left to carry over from the parent frame.
  ctx.func.capturedNames = new Set()
  ctx.func.identityShadow = new Map()
  ctx.func.cellTypes = new Set(cb.cellI32 || [])
  const parentBoxedCaptures = new Set(cb.boxed || [])

  for (const p of cb.params) ctx.func.locals.set(p, 'f64')
  // Closure bodies bypass analyzeFuncForEmit, so publish the same intrinsic
  // rest-array entry fact here. A body assignment invalidates it.
  if (cb.rest && !isReassigned(cb.body, cb.rest)) updateRep(cb.rest, { val: VAL.ARRAY })
  // All direct named-function callers emitted before closure planning begins,
  // so closure parameter lattices are complete at this boundary.
  const ptRow = ctx.closure.paramTypes?.get(cb.name)
  const minArgc = ctx.closure.minArgc?.get(cb.name) ?? 0
  if (ptRow) for (let i = 0; i < cb.params.length; i++) {
    if (ptRow[i] === true && !ctx.func.localReps?.get(cb.params[i])?.val)
      updateRep(cb.params[i], i < minArgc ? { val: VAL.NUMBER } : { val: VAL.NUMBER, nullable: true })
  }
  const tcRow = ctx.closure.paramTypedCtors?.get(cb.name)
  if (tcRow) for (let i = 0; i < cb.params.length; i++) {
    const ctor = tcRow[i]
    if (ctor && !ctx.func.localReps?.get(cb.params[i])?.val) {
      updateRep(cb.params[i], { val: VAL.TYPED })
      ;(ctx.func.typedElem ||= new Map()).set(cb.params[i], ctor)
    }
  }
  // Usage-only numeric proof catches closure params the call lattice never saw.
  for (const p of cb.params)
    if (!ctx.func.localReps?.get(p)?.val && !cb.defaults?.[p] &&
        paramAllUsesNumeric(cb.body, p, new Set(), true, false))
      updateRep(p, { val: VAL.NUMBER })

  for (const name of cb.captures)
    ctx.func.locals.set(name, ctx.func.boxed.has(name) ? 'i32' : 'f64')
  return parentBoxedCaptures
}

/** Analysis-only half of closure lowering; publishes before any body IR emits. */
export function analyzeClosureBodyForEmit(cb) {
  normalizeClosureBody(cb)
  const prevSchemaVars = ctx.schema.vars
  const prevTypedElems = ctx.func.typedElem
  const previousFrame = enterClosureFrame(cb)
  try {
    const parentBoxedCaptures = seedClosureFrame(cb, prevSchemaVars, prevTypedElems)
    const block = isBlockBody(cb.body)
    if (block) {
      for (const [k, v] of reanalyzeBody(cb.body).locals)
        if (!ctx.func.locals.has(k)) ctx.func.locals.set(k, v)
      inferLocals(cb.body, cb.params.filter(p => !ctx.func.localReps?.get(p)?.val))
      boxedCaptures(cb.body)
      for (const name of ctx.func.boxed.keys())
        if (parentBoxedCaptures.has(name) && ctx.func.locals.get(name) === 'f64')
          ctx.func.locals.set(name, 'i32')
      const unbox = unboxablePtrs(cb.body, ctx.func.locals, ctx.func.boxed)
      for (const [name, kind] of unbox) {
        if (cb.params.includes(name) || cb.captures.includes(name)) continue
        const fields = { ptrKind: kind }
        if (kind === VAL.TYPED) {
          const aux = typedElemAux(ctx.func.typedElem?.get(name))
          if (aux == null) continue
          fields.ptrAux = aux
        }
        ctx.func.locals.set(name, 'i32')
        updateRep(name, fields)
      }
      inheritPtrAliases(cb.body, ctx.func.locals, ctx.func.boxed)
    }

    const boxedCaptureNames = new Set(cb.captures.filter(name => parentBoxedCaptures.has(name)))
    const boxedValueCaptureNames = new Set(cb.captures.filter(name =>
      ctx.func.boxed.has(name) && !parentBoxedCaptures.has(name)))
    const boxedParamNames = new Set(cb.params.filter(name => ctx.func.boxed.has(name)))
    // Classification happens before emission because emitDecl consults
    // preboxed while lowering the body. Reordering this after emit previously
    // made mutually-recursive arrows capture stale null cells.
    const seeded = new Set([...boxedCaptureNames, ...boxedValueCaptureNames, ...boxedParamNames])
    ctx.func.closureAux.set('parentBoxedCaptures', parentBoxedCaptures)
    ctx.func.closureAux.set('boxedCaptureNames', boxedCaptureNames)
    ctx.func.closureAux.set('boxedValueCaptureNames', boxedValueCaptureNames)
    ctx.func.closureAux.set('boxedParamNames', boxedParamNames)
    for (const [name, cell] of ctx.func.boxed) {
      ctx.func.preboxed.add(name)
      if (seeded.has(name)) {
        if (!boxedCaptureNames.has(name)) ctx.func.locals.set(cell, 'i32')
      } else ctx.func.locals.set(cell, 'i32')
    }

    // Closure bodies never pass through analyzeFuncForEmit; mint their nested
    // loop/closure plans here under this body's final reps.
    mintLoopPlans(cb.body)
    mintClosureEnvPlans(cb.body)
    const repSig = {
      name: cb.name,
      params: cb.params.map(name => ({ name, type: 'f64' })),
      results: ['f64'],
    }
    mintTypedStoragePlan(ctx, cb, repSig, cb.body, ctx.func.localReps)
    if (representationProgramHasBigint(ctx)) {
      const forceTaggedResult = ctx.scope.taggedClosureResultBodies?.has(cb.body) === true ||
        ctx.scope.taggedClosureResultShapes?.has(JSON.stringify(cb.body)) === true
      mintRepresentationPlan(ctx, cb, repSig, cb.body, ctx.func.localReps, {
        generic: true,
        forceTaggedResult,
      })
    }
    return publishPreparedFunctionPlan(ctx, cb, ctx.func)
  } finally {
    ctx.schema.vars = prevSchemaVars
    restoreActiveFunction(ctx, previousFrame)
  }
}

/**
 * Phase: emit one closure body to WAT IR.
 *
 * Closures share a uniform signature (env f64, argc i32, a0..a{W-1} f64) → f64
 * so any closure can be invoked via call_indirect on $ftN. This function
 * builds one body fn given the body record (cb) created by ctx.closure.make.
 *
 * Installs a previously-published FunctionPlan; no durable fact is discovered
 * here. Exit restores ctx.schema.vars explicitly while typedElem/typedLen return
 * with the displaced ActiveFunction record. Returns the WAT IR for the func node.
 */
export function emitClosureBody(cb, functionPlan) {
  normalizeClosureBody(cb)
  const prevSchemaVars = ctx.schema.vars
  const previousFrame = enterPreparedFunction(ctx, functionPlan)
  try {
  ctx.func.boxedResult = true
  if (cb.schemaVars) ctx.schema.vars = makeMapOverlay(prevSchemaVars, new Map(cb.schemaVars))

  // The one-shot prepared frame carries the already-built Set views, so
  // emission allocates no duplicate classification state.
  const parentBoxedCaptures = ctx.func.closureAux.get('parentBoxedCaptures')
  const boxedCaptureNames = ctx.func.closureAux.get('boxedCaptureNames')
  const boxedValueCaptureNames = ctx.func.closureAux.get('boxedValueCaptureNames')
  const boxedParamNames = ctx.func.closureAux.get('boxedParamNames')
  const W = ctx.closure.width ?? MAX_CLOSURE_ARITY
  const fn = ['func', `$${cb.name}`]
  fn.push(['param', '$__env', 'f64'])
  fn.push(['param', '$__argc', 'i32'])
  for (let i = 0; i < W; i++) fn.push(['param', `$__a${i}`, 'f64'])
  fn.push(['result', 'f64'])

  // The classification is plan-time; this emission-only half materializes the
  // already-decided null-initialized local cells before the body reads them.
  const preboxedLocalInits = emitPreboxedLocalInits(name =>
    boxedCaptureNames.has(name) || boxedValueCaptureNames.has(name) || boxedParamNames.has(name))

  const block = isBlockBody(cb.body)
  ctx.func.repsFrozen = true
  assertCtxInvariants('pre-emit')
  const bodyIR = block
    ? emitBlockBody(cb.body)
    // The closure ABI result is a boxed-value position; preserve a false atom
    // in a BOOL∪NUMBER expression body before it collapses to raw 0.
    : [hasAmbiguousBoolMerge(cb.body)
      ? emitIdentitySafe(cb.body)
      : carrierF64(cb.body,
        applyBigintRepresentationAction(emit(cb.body), cb.body, representationReturnAction(ctx, cb.body)))]

  // Pre-allocate cache locals for env unpacking
  const envBase = cb.captures.length > 0 ? `${T}envBase${freshId(ctx)}` : null
  if (envBase) ctx.func.locals.set(envBase, 'i32')
  // Rest param: allocate helper locals (len + offset + spill loop index) before emitting decls
  let restOff, restLen, restIdx
  if (cb.rest) {
    restOff = `${T}restOff${freshId(ctx)}`
    restLen = `${T}restLen${freshId(ctx)}`
    restIdx = `${T}restIdx${freshId(ctx)}`
    ctx.func.locals.set(restOff, 'i32')
    ctx.func.locals.set(restLen, 'i32')
    ctx.func.locals.set(restIdx, 'i32')
    inc('__alloc_hdr', '__mkptr')
  }

  // Insert locals (captures + params + declared)
  // Build default-param initializer IR before local declarations are emitted:
  // default expressions can allocate temporaries (for example `param = []`).
  const defaultParamInits = []
  if (cb.defaults) {
    for (const [pname, defVal] of Object.entries(cb.defaults)) {
      if (boxedParamNames.has(pname)) {
        defaultParamInits.push(['if', isUndef(['f64.load', boxedAddr(pname)]),
          ['then', ['f64.store', boxedAddr(pname), asF64(emit(defVal))]]])
      } else {
        defaultParamInits.push(['if', isUndef(['local.get', `$${pname}`]),
          ['then', ['local.set', `$${pname}`, asF64(emit(defVal))]]])
      }
    }
  }

  for (const [l, t] of ctx.func.locals) fn.push(['local', dollar(l), t])

  // Load captures from env: boxed → i32.load (raw cell pointer), immutable → f64.load value.
  // env is the CLOSURE pointer (PTR.CLOSURE) — never an ARRAY, no forwarding chain.
  // Inline the offset extraction (low 32 bits) instead of calling __ptr_offset per invocation.
  if (envBase) {
    fn.push(['local.set', `$${envBase}`,
      ['i32.wrap_i64', ['i64.reinterpret_f64', ['local.get', '$__env']]]])
    for (let i = 0; i < cb.captures.length; i++) {
      const name = cb.captures[i]
      const addr = ['i32.add', ['local.get', `$${envBase}`], ['i32.const', i * 8]]
      if (parentBoxedCaptures.has(name)) {
        fn.push(['local.set', `$${name}`, ['i32.load', addr]])
      } else if (boxedValueCaptureNames.has(name)) {
        fn.push(
          ['local.set', `$${ctx.func.boxed.get(name)}`, ['call', '$__alloc', ['i32.const', 8]]],
          ['f64.store', boxedAddr(name), ['f64.load', addr]])
      } else {
        fn.push(['local.set', `$${name}`, ['f64.load', addr]])
      }
    }
  }

  // Unpack fixed params directly from inline slots (caller padded missing with UNDEF_NAN).
  // Rest name (if present) is last in cb.params — handled separately below.
  const fixedParamN = cb.params.length - (cb.rest ? 1 : 0)
  for (let i = 0; i < fixedParamN && i < W; i++) {
    const pname = cb.params[i]
    if (boxedParamNames.has(pname)) {
      fn.push(
        ['local.set', `$${ctx.func.boxed.get(pname)}`, ['call', '$__alloc', ['i32.const', 8]]],
        ['f64.store', boxedAddr(pname), ['local.get', `$__a${i}`]])
    } else {
      fn.push(['local.set', `$${pname}`, ['local.get', `$__a${i}`]])
    }
  }

  // Rest param: pack args a[fixedParams..argc-1] into a fresh array.
  // len = max(argc - fixedParams, 0). The first `restSlots = width - fixedParams`
  // come from the inline arg slots; any overflow (argc > width, only reachable via a
  // spread call) is read straight from the caller's full args array, whose offset the
  // spread path published in $__closure_spill. This gives unbounded variadic arity.
  if (cb.rest) {
    const fixedN = fixedParamN
    const restSlots = W - fixedN
    declGlobal('__closure_spill', 'i32')
    fn.push(['local.set', `$${restLen}`,
      ['select',
        ['i32.sub', ['local.get', '$__argc'], ['i32.const', fixedN]],
        ['i32.const', 0],
        ['i32.gt_s', ['local.get', '$__argc'], ['i32.const', fixedN]]]])
    fn.push(['local.set', `$${restOff}`,
      ['call', '$__alloc_hdr',
        ['local.get', `$${restLen}`], ['local.get', `$${restLen}`]]])
    for (let i = 0; i < restSlots; i++) {
      fn.push(['if', ['i32.gt_s', ['local.get', `$${restLen}`], ['i32.const', i]],
        ['then', ['f64.store',
          ['i32.add', ['local.get', `$${restOff}`], ['i32.const', i * 8]],
          ['local.get', `$__a${fixedN + i}`]]]])
    }
    // Overflow beyond the inline slots: copy args[width..argc-1] from the spill array
    // (set by the spread-call site). rest[i] = spill[(fixedN+i)*8] for i in [restSlots, restLen).
    const rid = freshId(ctx)
    fn.push(['if', ['i32.gt_s', ['local.get', `$${restLen}`], ['i32.const', restSlots]],
      ['then',
        ['local.set', `$${restIdx}`, ['i32.const', restSlots]],
        ['block', `$restEnd${rid}`,
          ['loop', `$restLoop${rid}`,
            ['br_if', `$restEnd${rid}`, ['i32.ge_s', ['local.get', `$${restIdx}`], ['local.get', `$${restLen}`]]],
            ['f64.store',
              ['i32.add', ['local.get', `$${restOff}`], ['i32.mul', ['local.get', `$${restIdx}`], ['i32.const', 8]]],
              ['f64.load', ['i32.add', ['global.get', '$__closure_spill'],
                ['i32.mul', ['i32.add', ['local.get', `$${restIdx}`], ['i32.const', fixedN]], ['i32.const', 8]]]]],
            ['local.set', `$${restIdx}`, ['i32.add', ['local.get', `$${restIdx}`], ['i32.const', 1]]],
            ['br', `$restLoop${rid}`]]]]])
    const restValue = ['call', '$__mkptr', ['i32.const', PTR.ARRAY], ['i32.const', 0], ['local.get', `$${restOff}`]]
    if (boxedParamNames.has(cb.rest)) {
      fn.push(
        ['local.set', `$${ctx.func.boxed.get(cb.rest)}`, ['call', '$__alloc', ['i32.const', 8]]],
        ['f64.store', boxedAddr(cb.rest), restValue])
    } else {
      fn.push(['local.set', `$${cb.rest}`, restValue])
    }
  }

  // Default params for closures (check sentinel after unpack)
  // Only `undefined` triggers default per spec — `null`/`0`/`false` pass through.
  fn.push(...defaultParamInits)
  fn.push(...preboxedLocalInits)
  fn.push(...bodyIR)
  // I: Skip trailing fallback when last statement is return
  // Implicit fall-through return is `undefined` per JS spec, not 0.
  if (block && !(bodyIR.at(-1)?.[0] === 'return' || bodyIR.at(-1)?.[0] === 'return_call')) fn.push(undefExpr())
  return fn
  } finally {
    ctx.schema.vars = prevSchemaVars
    // typedElem/typedLen are members of previousFrame, so restoring the one
    // record restores the complete function-local authority.
    restoreActiveFunction(ctx, previousFrame)
  }
}
