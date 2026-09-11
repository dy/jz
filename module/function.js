/**
 * Function module — closures, first-class functions, call_indirect.
 *
 * Closures are NaN-boxed pointers: type=10 (PTR.CLOSURE), aux=funcIdx, offset=envPtr.
 * Closure body: (env: f64, ...params: f64) → f64 — env is pointer to captured values.
 * Captured variables stored as f64 in memory at envPtr.
 *
 * Auto-included when inner functions reference outer variables.
 *
 * @module fn
 */

import { typed, asF64, mkPtrIR, temp, tempI32, MAX_CLOSURE_ARITY, UNDEF_NAN, ptrTypeEq, throwTypeErrorIR } from '../src/ir.js'
import { emit, storedValue, storedValuePlanned } from '../src/bridge.js'
import { constNumExpr } from '../src/static.js'
import { isReassigned } from '../src/ast.js'
import { findFreeVars } from '../src/compile/analyze.js'
import { REP_EDGE_REJECT, representationClosureArgAction } from '../src/compile/representation-plan.js'
import { T } from '../src/ast.js'
import { lookupValType, repOf } from '../src/reps.js'
import { PTR, LAYOUT, inc, err, declGlobal, setLinkDemand, DBG_INVARIANTS } from '../src/ctx.js'

// Republished on ctx.closure below for src/compile/closure-plan.js's
// mintClosureEnvPlans — a pure function of `body` alone, safely re-derivable
// pre-emission to replicate ctx.closure.make's own int-const capture fold.
const topLevelIntConsts = (body) => {
  const inner = Array.isArray(body) && body[0] === '{}' ? body[1] : body
  const stmts = Array.isArray(inner) && inner[0] === ';' ? inner.slice(1) : []
  const out = new Map()
  for (const stmt of stmts) {
    if (!Array.isArray(stmt) || (stmt[0] !== 'const' && stmt[0] !== 'let')) continue
    for (let i = 1; i < stmt.length; i++) {
      const decl = stmt[i]
      if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') continue
      if (stmt[0] === 'let' && isReassigned(body, decl[1])) continue
      const v = constNumExpr(decl[2])
      if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) out.set(decl[1], v)
    }
  }
  return out
}


export default (ctx) => {
  inc('__mkptr', '__alloc', '__len', '__ptr_offset', '__ptr_type')

  // Uniform closure convention: (env f64, argc i32, a0..a{MAX-1} f64) → f64
  if (!ctx.closure.types) ctx.closure.types = new Set()
  if (!ctx.closure.table) ctx.closure.table = []
  if (!ctx.closure.bodies) ctx.closure.bodies = []
  // Republished for src/compile/closure-plan.js's mintClosureEnvPlans (Slice 1,
  // .work/archive/closure-plan-design.md) — via ctx.closure rather than a direct
  // cross-import, so this module-factory file and the plan mint it feeds don't
  // form an import cycle (matches ctx.closure.make/.call's own module→ctx→src
  // publication channel).
  ctx.closure.topLevelIntConsts = topLevelIntConsts

  ctx.closure.types.add(1) // presence triggers $ftN type emission

  ctx.closure.mint = (name) => {
    let idx = ctx.closure.table.indexOf(name)
    if (idx === -1) {
      idx = ctx.closure.table.length
      ctx.closure.table.push(name)
    }
    return idx
  }

  /**
   * Create a closure: compile inner function as closure body, capture outer vars.
   * @param {{ params: string[], body, captures: string[], restParam: string|null }} info
   * @returns {WasmNode} NaN-boxed closure pointer
   */
  ctx.closure.make = ({ params, body, captures, restParam, defaults, rawParams, scope }) => {
    const fixedN = params.length - (restParam ? 1 : 0)
    if (fixedN > MAX_CLOSURE_ARITY) err(`Closure with ${fixedN} fixed params exceeds MAX_CLOSURE_ARITY=${MAX_CLOSURE_ARITY}`)
    if (restParam && fixedN >= MAX_CLOSURE_ARITY) err(`Closure with rest param needs at least one free slot — ${fixedN} fixed params leaves none (MAX_CLOSURE_ARITY=${MAX_CLOSURE_ARITY})`)
    // Generate closure body function name
    const fnName = `${T}closure${ctx.closure.table.length}`

    // ClosureEnvPlan (src/compile/closure-plan.js's mintClosureEnvPlans,
    // see .work/archive/todo.md) — the frozen pre-emission
    // capture classification (free vars, constant folds, boxed cells), keyed
    // on THIS closure's own body node, or — a destructured-param closure
    // only, see that module's own doc — on `rawParams` (untouched by the
    // destructuring-prepend rewrite that reassigns `body` before this call,
    // emit.js's '=>' handler). A miss (this closure sits outside a shape the
    // mint walks) fails open to the legacy inline re-derivation below.
    const plan = ctx.plans.closures.get(body) ??
      (rawParams != null && typeof rawParams === 'object' ? ctx.plans.closures.get(rawParams) : undefined)

    const legacyDerive = () => {
      const localIntConsts = ctx.func.body ? topLevelIntConsts(ctx.func.body) : new Map()
      const intConsts = new Map()
      for (const name of captures) {
        // Third fallback mirrors src/compile/closure-plan.js's mintArrow (see
        // its doc comment): a depth≥2 capture chain whose constant was
        // declared in an ANCESTOR closure, not the current one, is invisible
        // to topLevelIntConsts(ctx.func.body) (current-frame-only) and
        // ctx.scope.constInts (module-only) alike — repOf(name)?.intConst
        // carries it forward regardless, since the ancestor's own
        // seedClosureFrame already republished its fold into this frame's
        // localReps before this arrow's capture set is derived. Keeping this
        // legacy path in lockstep with the plan's is required, not optional:
        // DBG_INVARIANTS diffs the two and treats any mismatch as a hard
        // error (ClosureEnvPlan drift, just below).
        const v = ctx.scope.constInts?.get(name) ?? localIntConsts.get(name) ?? repOf(name)?.intConst
        if (v != null && !ctx.func.boxed?.has(name)) intConsts.set(name, v)
      }
      const env = intConsts.size ? captures.filter(name => !intConsts.has(name)) : captures
      const boxed = env.filter(c => ctx.func.boxed?.has(c))
      return { env, intConsts, boxed, storage: env.length === 0 ? 'none' : 'heap' }
    }

    // Plan is PRIMARY when present: the mint already computed the full
    // classification, so the legacy walk over `captures` below is skipped
    // entirely on the common path — only DBG_INVARIANTS still runs it, as a
    // shadow-assert rather than the source of truth (flipped from Slice 1).
    let envCaptures, captureIntConsts, boxedCaptures, storage
    if (plan) {
      captureIntConsts = new Map()
      const boxed = []
      envCaptures = []
      for (const c of plan.captures) {
        if (c.mode === 'constant') captureIntConsts.set(c.name, c.constant)
        else { envCaptures.push(c.name); if (c.mode === 'cell') boxed.push(c.name) }
      }
      boxedCaptures = boxed
      storage = plan.storage
    } else {
      ;({ env: envCaptures, intConsts: captureIntConsts, boxed: boxedCaptures, storage } = legacyDerive())
    }

    if (DBG_INVARIANTS && plan) {
      const legacy = legacyDerive()
      const sameOrder = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
      const sameMap = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)
      if (storage !== legacy.storage || !sameOrder(envCaptures, legacy.env) ||
          !sameOrder(boxedCaptures, legacy.boxed) || !sameMap(captureIntConsts, legacy.intConsts))
        err(`ClosureEnvPlan drift: ${fnName} plan storage=${storage} env=[${envCaptures}] boxed=[${boxedCaptures}] consts=[${[...captureIntConsts]}] vs legacy storage=${legacy.storage} env=[${legacy.env}] boxed=[${legacy.boxed}] consts=[${[...legacy.intConsts]}]`)
    }

    const captureValTypes = new Map()
    const captureSchemaVars = new Map()
    const captureTypedElems = new Map()
    // Propagate parent's intCertain rep across captures: the parent's narrower
    // already guarantees every defining RHS (including assignments inside
    // nested arrows) is integer-valued, so the f64 round-trip through the env
    // slot preserves integer semantics. Consumers inside the inner body —
    // `toNumF64` elision (src/ir.js), math fast paths (module/math.js),
    // bitwise-key indexing (src/emit.js) — fire on captures just as they
    // would on directly-declared locals.
    const captureIntCertain = new Set()
    // Propagate parent's directClosures across captures: a const-bound closure captured
    // by an inner arrow can still be direct-dispatched in the inner body (skip
    // call_indirect on the captured pointer). Gated on isReassigned over the inner body
    // so a local rewrite of the captured name disables propagation.
    const captureDirectClosures = new Map()
    // Propagate the parent's `nullable` mark: a capture whose parent binding can
    // hold null/undefined (e.g. `let x = null` later assigned a number) must keep
    // that fact inside the body, or the body's own write facts (val = NUMBER)
    // would let `x == null` fold to a constant false and skip the guard.
    const captureNullables = new Set()
    // Propagate the parent's `mayBeUndefined` mark (Slice 2,
    // .work/archive/represented-maybe-undefined-design.md §3 "Closure captures") — the container-read
    // sibling of captureNullables just above, same reasoning: a capture whose
    // parent binding can be real JS `undefined` despite a definite `val` claim
    // must keep that fact inside the body, or the body's own write facts
    // would let it evaporate at the capture boundary.
    const captureMayBeUndefineds = new Set()
    for (const name of envCaptures) {
      const vt = lookupValType(name)
      if (vt != null) captureValTypes.set(name, vt)
      const schemaId = ctx.schema.idOf(name)
      if (schemaId != null) captureSchemaVars.set(name, schemaId)
      const elemType = ctx.func.typedElem?.get(name)
      if (elemType != null) captureTypedElems.set(name, elemType)
      const bodyName = ctx.func.directClosures?.get(name)
      if (bodyName && !isReassigned(body, name)) captureDirectClosures.set(name, bodyName)
      if (repOf(name)?.intCertain === true) captureIntCertain.add(name)
      if (repOf(name)?.nullable) captureNullables.add(name)
      if (repOf(name)?.mayBeUndefined) captureMayBeUndefineds.add(name)
    }

    // findFreeVars's `scope` param needs BOTH `.has(name)` (membership test)
    // AND `.add(name)` (analyze-scans.js's own `let`/`const`/`for(let…)`
    // branches call `collectParamNames(decls, scope)`, which does `scope.add`,
    // to record body-local shadow declarations so a same-named inner `let`
    // doesn't get misread as a free reference to the outer schema var) — a
    // real mutable Set interface, not a plain read-only lookup. The old
    // `new Set(ctx.schema.vars.keys())` materialized a FULL COPY of the
    // program-wide schema table to get that interface, at O(program schema-
    // table size) PER CLOSURE LITERAL (fires for every arrow/function
    // expression seen while ANY body emits, not just ones that end up
    // capturing anything — .work/evidence.md's MapOverlay fix targets the
    // same shape-class one level down, at closure-body-EMISSION time; this
    // site is the more frequent, likely-dominant sibling, at closure-CREATION
    // time). `scopeOwn` below is the SAME two-layer split MapOverlay uses —
    // `.add` writes ONLY into a fresh per-closure Set (bounded by this one
    // closure's own local declarations), `.has` falls through to the real
    // ctx.schema.vars table on miss — so shadow-tracking writes never leak
    // into the shared program-wide map, and constructing the view is O(1).
    if (ctx.schema.vars) {
      const scopeOwn = new Set()
      const schemaVars = ctx.schema.vars
      const scope = { has: (name) => scopeOwn.has(name) || schemaVars.has(name), add: (name) => scopeOwn.add(name) }
      const refs = []
      findFreeVars(body, new Set(params), refs, scope)
      for (const def of Object.values(defaults || {})) findFreeVars(def, new Set(params), refs, scope)
      for (const name of refs) {
        if (captureSchemaVars.has(name)) continue
        const schemaId = ctx.schema.idOf(name)
        if (schemaId != null) captureSchemaVars.set(name, schemaId)
      }
    }

    // i32-narrowed cells travel with the capture: the closure body must access
    // the shared cell at the same width the owner does (see funcFacts.cellTypes).
    const cellI32Captures = boxedCaptures.filter(c => ctx.func.cellTypes?.has(c))
    // Fixed-shape closure-plan record. Conditional spreads used to create a
    // family of HASH-shaped records; region compaction could relocate the
    // outer bodies array while losing one optional-shape member (`params`
    // became null at full jz×jz scale). Null sentinels preserve every existing
    // truthy/optional consumer and give the relocator one stable slot layout.
    const bodyFn = {
      name: fnName, params, body, captures: envCaptures, arity: 1,
      scope: scope ?? null,
      rest: restParam || null,
      defaults: defaults || null,
      boxed: boxedCaptures.length ? new Set(boxedCaptures) : null,
      cellI32: cellI32Captures.length ? new Set(cellI32Captures) : null,
      intConsts: captureIntConsts.size ? captureIntConsts : null,
      intCertain: captureIntCertain.size ? captureIntCertain : null,
      nullables: captureNullables.size ? captureNullables : null,
      mayBeUndefineds: captureMayBeUndefineds.size ? captureMayBeUndefineds : null,
      valTypes: captureValTypes.size ? captureValTypes : null,
      schemaVars: captureSchemaVars.size ? captureSchemaVars : null,
      typedElems: captureTypedElems.size ? captureTypedElems : null,
      directClosures: captureDirectClosures.size ? captureDirectClosures : null,
    }
    ctx.closure.bodies.push(bodyFn)

    const tableIdx = ctx.closure.mint(fnName)

    // At call site: allocate env, store captured values, return NaN-boxed pointer.
    // Tag IR with .closureBodyName so emitDecl can register the binding for direct dispatch
    // (skip call_indirect on a const-bound, non-escaping closure local). See emit.js '()' handler.
    setLinkDemand('closure')
    if (storage === 'none') {
      // No captures — just a function reference
      const ir = mkPtrIR(PTR.CLOSURE, tableIdx, 0)
      ir.closureBodyName = fnName
      ir.closureFuncIdx = tableIdx
      return ir
    }

    const t = tempI32('env')

    const block = [
      ['local.set', `$${t}`, ['call', '$__alloc', ['i32.const', envCaptures.length * 8]]],
    ]
    // Store captured values in env: boxed cells as raw i32 in low 4 bytes, others as f64.
    // Avoids i32↔f64 roundtrip; body loads via i32.load/f64.load using the same branch.
    for (let i = 0; i < envCaptures.length; i++) {
      const addr = ['i32.add', ['local.get', `$${t}`], ['i32.const', i * 8]]
      if (ctx.func.boxed?.has(envCaptures[i]))
        block.push(['i32.store', addr, ['local.get', `$${ctx.func.boxed.get(envCaptures[i])}`]])
      else {
        // Identity-safe capture shadow (src/compile/emit.js's emitDecl,
        // ctx.func.identityShadow — see its own comment there): a captured,
        // ambiguous BOOL∪NUMBER-merge decl (`let v = cond && 1`) already
        // computed and teed its boxed TRUE/FALSE-atom-or-number form once,
        // at declaration time — read it back here instead of a fresh
        // `emit(name)`, which would only ever see the collapsed raw bits
        // (the merge's own valTypeOf reads NUMBER post-collapse, so a bare
        // name reference carries no ambiguity signal of its own by this
        // point — kind.js hasAmbiguousBoolMerge only recognizes the ORIGINAL
        // expression shape, never a name that merely holds its result).
        const shadow = ctx.func.identityShadow?.get(envCaptures[i])
        block.push(['f64.store', addr, shadow ? ['local.get', `$${shadow}`] : asF64(emit(envCaptures[i]))])
      }
    }
    block.push(mkPtrIR(PTR.CLOSURE, tableIdx, ['local.get', `$${t}`]))

    const ir = typed(['block', ['result', 'f64'], ...block], 'f64')
    ir.closureBodyName = fnName
    ir.closureFuncIdx = tableIdx
    return ir
  }

  const UNDEF_LIT = () => ['f64.const', `nan:${UNDEF_NAN}`]

  /**
   * Call a closure value: pass args inline as a0..a{MAX-1} + argc, call_indirect.
   * @param {WasmNode} closureExpr - Already-emitted closure pointer expression
   * @param {any[]} args - AST nodes (will be emitted) OR pre-emitted nodes (if .type is set)
   * @param {boolean} prebuiltArray - args[0] is a pre-built args array (spread path)
   */
  /** One argument in the closure ABI's slot form: an AST node by its representation action, pre-emitted IR (has .type) as is. */
  ctx.closure.argIR = (a) => {
    if (a?.type) return asF64(a)
    const action = representationClosureArgAction(ctx, a)
    return action === REP_EDGE_REJECT ? storedValue(a) : storedValuePlanned(a, action)
  }
  ctx.closure.call = (closureExpr, args, prebuiltArray, check = false) => {
    const t = temp('clos'), recv = typed(['local.get', `$${t}`], 'f64')
    // Every caller captures the callee before evaluating inline or spread args.
    const setup = [['local.set', `$${t}`, asF64(closureExpr)]]
    const W = ctx.closure.width ?? MAX_CLOSURE_ARITY
    const slots = []
    let argc
    if (prebuiltArray) {
      // Publish the full argument array for rest parameters beyond inline width W.
      declGlobal('__closure_spill', 'i32')
      const arrT = tempI32('sa'), lenL = tempI32('sl'), arrPtrF64 = temp('sp')
      setup.push(['local.set', `$${arrPtrF64}`, asF64(args[0])])
      setup.push(['local.set', `$${arrT}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${arrPtrF64}`]]]])
      setup.push(['local.set', `$${lenL}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${arrPtrF64}`]]]])
      setup.push(['global.set', '$__closure_spill', ['local.get', `$${arrT}`]])
      argc = ['local.get', `$${lenL}`]
      for (let i = 0; i < W; i++) slots.push(['if', ['result', 'f64'],
        ['i32.gt_s', argc, ['i32.const', i]],
        ['then', ['f64.load', ['i32.add', ['local.get', `$${arrT}`], ['i32.const', i * 8]]]],
        ['else', UNDEF_LIT()]])
    } else {
      const n = args.length
      if (n > MAX_CLOSURE_ARITY) err(`Closure call with ${n} args exceeds MAX_CLOSURE_ARITY=${MAX_CLOSURE_ARITY}`)
      argc = ['i32.const', n]
      for (let i = 0; i < n; i++) {
        const arg = ctx.closure.argIR(args[i])
        if (!check) slots.push(arg)
        else {
          const a = temp('carg')
          setup.push(['local.set', `$${a}`, arg])
          slots.push(['local.get', `$${a}`])
        }
      }
      for (let i = n; i < W; i++) slots.push(UNDEF_LIT())
    }
    const call = ['call_indirect', ['type', '$ftN'], recv, argc, ...slots,
      ['i32.wrap_i64', ['i64.and',
        ['i64.shr_u', ['i64.reinterpret_f64', recv], ['i64.const', LAYOUT.AUX_SHIFT]],
        ['i64.const', LAYOUT.AUX_MASK]]]]
    // Unproven member slots need a check after argument effects. Other callers
    // already established callability through analysis or runtime dispatch.
    return typed(['block', ['result', 'f64'], ...setup, check
      ? ['if', ['result', 'f64'], ptrTypeEq(recv, PTR.CLOSURE),
        ['then', call], ['else', throwTypeErrorIR('call')]]
      : call], 'f64')
  }
}
