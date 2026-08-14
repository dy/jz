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

import { typed, asF64, asI32, mkPtrIR, temp, tempI32, MAX_CLOSURE_ARITY, UNDEF_NAN } from '../src/ir.js'
import { emit, storedValue } from '../src/bridge.js'
import { isReassigned } from '../src/ast.js'
import { findFreeVars } from '../src/compile/analyze.js'
// Round-6 prereq (a), closure return-kind pre-pass: closureBodyReturnKind is
// the shared AST-only derivation (src/compile/flow-types.js — see its doc).
// This module is its EMISSION-time caller: ctx.closure.make runs when the
// closure literal itself is created, always before any later direct call
// site in program order, so the fact is ready exactly when calleeValType
// (kind-traits.js) needs it. narrow.js's narrowValResults is the OTHER
// caller — the PLANNING-time one, for a function that directly returns a
// call to its OWN freshly-declared local closure (watr's uleb/limits shape).
import { closureBodyReturnKind, closureBodyReturnMayBeUndefined } from '../src/compile/flow-types.js'
import { T } from '../src/ast.js'
import { lookupValType, repOf, VAL } from '../src/reps.js'
import { PTR, LAYOUT, inc, err, declGlobal, setLinkDemand, DBG_INVARIANTS } from '../src/ctx.js'

const intConstExpr = (node) => {
  if (typeof node === 'number' && Number.isInteger(node)) return node
  if (Array.isArray(node) && node[0] == null && Number.isInteger(node[1])) return node[1]
  if (!Array.isArray(node)) return null
  const [op, a, b] = node
  const av = intConstExpr(a)
  if (op === 'u-' || (op === '-' && b === undefined)) return av == null ? null : -av
  const bv = intConstExpr(b)
  if (av == null || bv == null) return null
  switch (op) {
    case '+': return av + bv
    case '-': return av - bv
    case '*': return av * bv
    case '&': return av & bv
    case '|': return av | bv
    case '^': return av ^ bv
    case '<<': return av << bv
    case '>>': return av >> bv
    case '>>>': return av >>> bv
    default: return null
  }
}

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
      const v = intConstExpr(decl[2])
      if (v != null && v >= -2147483648 && v <= 2147483647) out.set(decl[1], v)
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
  // Region arena CLOSURE relocation (.work/research.md §Region arena, the
  // FRONT-BOUNDARY-forcing "give CLOSURE a real region-copy arm" lever) —
  // one {len, cellMask} record per funcIdx (ctx.closure.table index),
  // captured HERE, at the one site that unconditionally knows the real env
  // it allocates for THIS closure, regardless of whether a ClosureEnvPlan
  // covered it (.work/closure-plan-design.md's 90.6%/57.9% mint coverage) or
  // fell open to the legacy inline derivation below — both paths converge on
  // the SAME `envCaptures`/`ctx.func.boxed` facts before reaching this push,
  // so recording it here (not from the plan) is 100% coverage by
  // construction, not a fail-open approximation. Read back by
  // src/wat/assemble.js to materialize the `$__closure_env_len`/
  // `$__closure_env_mask` side table __region_copy_rec's CLOSURE arm
  // (layout-kinds.js regionArmClosure) looks up by funcIdx (aux).
  if (!ctx.closure.envMeta) ctx.closure.envMeta = []
  // Republished for src/compile/closure-plan.js's mintClosureEnvPlans (Slice 1,
  // .work/closure-plan-design.md) — via ctx.closure rather than a direct
  // cross-import, so this module-factory file and the plan mint it feeds don't
  // form an import cycle (matches ctx.closure.make/.call's own module→ctx→src
  // publication channel).
  ctx.closure.topLevelIntConsts = topLevelIntConsts

  ctx.closure.types.add(1) // presence triggers $ftN type emission

  // Region arena side table mint (.work/research.md §Region arena, funcIdx
  // skew) — the ONE place that grows ctx.closure.table. Every OTHER minter
  // (emit.js's builtinFunctionValue and its top-level-function-used-as-value
  // trampoline path) must route through this too, so envMeta grows in
  // lockstep with table and index i always means the SAME closure in both —
  // a bare `table.push()` elsewhere silently desyncs the two arrays, and
  // every closure minted after that point gets attributed to the WRONG
  // funcIdx's env-length/cell-mask by src/wat/assemble.js's side-table build.
  ctx.closure.mint = (name, meta) => {
    let idx = ctx.closure.table.indexOf(name)
    if (idx === -1) {
      idx = ctx.closure.table.length
      ctx.closure.table.push(name)
      ctx.closure.envMeta.push(meta || { len: 0, cellMask: 0 })
    }
    return idx
  }

  /**
   * Create a closure: compile inner function as closure body, capture outer vars.
   * @param {{ params: string[], body, captures: string[], restParam: string|null }} info
   * @returns {WasmNode} NaN-boxed closure pointer
   */
  ctx.closure.make = ({ params, body, captures, restParam, defaults, rawParams }) => {
    const fixedN = params.length - (restParam ? 1 : 0)
    if (fixedN > MAX_CLOSURE_ARITY) err(`Closure with ${fixedN} fixed params exceeds MAX_CLOSURE_ARITY=${MAX_CLOSURE_ARITY}`)
    if (restParam && fixedN >= MAX_CLOSURE_ARITY) err(`Closure with rest param needs at least one free slot — ${fixedN} fixed params leaves none (MAX_CLOSURE_ARITY=${MAX_CLOSURE_ARITY})`)
    // Generate closure body function name
    const fnName = `${T}closure${ctx.closure.table.length}`

    // ClosureEnvPlan (src/compile/closure-plan.js's mintClosureEnvPlans,
    // architecture re-audit item 4, .work/todo.md) — the frozen pre-emission
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
        const v = ctx.scope.constInts?.get(name) ?? localIntConsts.get(name)
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
    // Propagate the parent's `mayBeUndefined` mark (Slice 2, .work/represented-
    // .work/todo.md §deletion-sweep §3 "Closure captures") — the container-read
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
      const elemType = ctx.types.typedElem?.get(name)
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
    // capturing anything — .work/research.md's MapOverlay fix targets the
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
    const bodyFn = { name: fnName, params, body, captures: envCaptures, arity: 1,
      ...(restParam && { rest: restParam }),
      ...(defaults && { defaults }),
      ...(boxedCaptures.length && { boxed: new Set(boxedCaptures) }),
      ...(cellI32Captures.length && { cellI32: new Set(cellI32Captures) }),
      ...(captureIntConsts.size && { intConsts: captureIntConsts }),
      ...(captureIntCertain.size && { intCertain: captureIntCertain }),
      ...(captureNullables.size && { nullables: captureNullables }),
      ...(captureMayBeUndefineds.size && { mayBeUndefineds: captureMayBeUndefineds }),
      ...(captureValTypes.size && { valTypes: captureValTypes }),
      ...(captureSchemaVars.size && { schemaVars: captureSchemaVars }),
      ...(captureTypedElems.size && { typedElems: captureTypedElems }),
      ...(captureDirectClosures.size && { directClosures: captureDirectClosures }) }
    ctx.closure.bodies.push(bodyFn)
    const returnKind = closureBodyReturnKind(body, captureValTypes)
    if (returnKind) (ctx.closure.valResult ||= new Map()).set(fnName, returnKind)
    // mayBeUndefined return-kind join (Slice 2, §3 "Return kinds") — the
    // closureBodyReturnKind sibling, same return-tail sites, OR-folded instead
    // of unified. Stored alongside ctx.closure.valResult in its own Map:
    // closureBodyReturnKind's return shape (a bare VAL.* string) has a live
    // consumer (kind-traits.js calleeValType) this slice must not disturb.
    if (closureBodyReturnMayBeUndefined(body, captureValTypes))
      (ctx.closure.valResultMayBeUndefined ||= new Map()).set(fnName, true)

    // Region arena side table (see ctx.closure.envMeta init above): every
    // slot's mode is EXACTLY the `ctx.func.boxed?.has(envCaptures[i])` test
    // the store loop below also uses — same source of truth, computed once
    // here instead of re-derived twice. Bit i set ⇒ slot i holds a raw i32
    // cell pointer (boxed/mutable capture); clear ⇒ a NaN-boxed f64 value.
    // >31 captures (unobserved on any measured corpus — .work/closure-plan-
    // design.md §1.5's histogram tops out at 27) can't fit the i32 mask;
    // region_copy_rec's CLOSURE arm traps that one case by name rather than
    // silently truncating which slots it treats as pointers.
    let envCellMask = 0
    for (let i = 0; i < envCaptures.length && i < 32; i++)
      if (ctx.func.boxed?.has(envCaptures[i])) envCellMask |= (1 << i)
    // ctx.closure.mint (not addToTable/bare push) — mints the table slot AND
    // the matching envMeta record atomically, see ctx.closure.mint's own doc.
    const tableIdx = ctx.closure.mint(fnName, { len: envCaptures.length, cellMask: envCellMask })

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
      else
        block.push(['f64.store', addr, asF64(emit(envCaptures[i]))])
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
  ctx.closure.call = (closureExpr, args, prebuiltArray) => {
    const t = temp('clos')

    if (prebuiltArray) {
      // Spread path: decode array into inline slots. Slots beyond array len padded with UNDEF.
      // The full args array offset is published in $__closure_spill so a rest-param
      // callee can recover elements beyond width W (the W inline slots hold args[0..W-1];
      // the rest reads args[W..argc-1] straight from the spill array). Unbounded arity.
      declGlobal('__closure_spill', 'i32')
      const arrT = tempI32('sa')
      const lenL = tempI32('sl')
      const setup = [
        ['local.set', `$${arrT}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', asF64(args[0])]]],
        ['local.set', `$${lenL}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],  // placeholder — set below
      ]
      // Rebuild setup properly since we need the array ptr before len call
      setup.length = 0
      const arrPtrF64 = temp('sp')
      setup.push(['local.set', `$${arrPtrF64}`, asF64(args[0])])
      setup.push(['local.set', `$${arrT}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${arrPtrF64}`]]]])
      setup.push(['local.set', `$${lenL}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${arrPtrF64}`]]]])

      const W = ctx.closure.width ?? MAX_CLOSURE_ARITY
      const slots = []
      for (let i = 0; i < W; i++) {
        slots.push(['if', ['result', 'f64'],
          ['i32.gt_s', ['local.get', `$${lenL}`], ['i32.const', i]],
          ['then', ['f64.load', ['i32.add', ['local.get', `$${arrT}`], ['i32.const', i * 8]]]],
          ['else', UNDEF_LIT()]])
      }
      return typed(['block', ['result', 'f64'],
        ...setup,
        ['local.set', `$${t}`, asF64(closureExpr)],
        ['global.set', '$__closure_spill', ['local.get', `$${arrT}`]],
        ['call_indirect', ['type', '$ftN'],
          ['local.get', `$${t}`],
          ['local.get', `$${lenL}`],
          ...slots,
          // Inline __ptr_aux for CLOSURE pointer: aux holds funcIdx.
          ['i32.wrap_i64', ['i64.and',
            ['i64.shr_u', ['i64.reinterpret_f64', ['local.get', `$${t}`]], ['i64.const', LAYOUT.AUX_SHIFT]],
            ['i64.const', LAYOUT.AUX_MASK]]]]], 'f64')
    }

    // Inline path: emit each arg, pad missing slots with UNDEF. Closure ABI slots
    // are untyped boxed-value positions — a bool arg crosses as its atom box so
    // the callee observes boolean identity (typeof/String/strict-eq); pre-emitted
    // IR (has .type) has no AST node to consult and keeps the plain box.
    const n = args.length
    if (n > MAX_CLOSURE_ARITY) err(`Closure call with ${n} args exceeds MAX_CLOSURE_ARITY=${MAX_CLOSURE_ARITY}`)
    const W = ctx.closure.width ?? MAX_CLOSURE_ARITY
    const slots = []
    for (let i = 0; i < n; i++) slots.push(args[i]?.type ? asF64(args[i]) : storedValue(args[i]))
    for (let i = n; i < W; i++) slots.push(UNDEF_LIT())

    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, asF64(closureExpr)],
      ['call_indirect', ['type', '$ftN'],
        ['local.get', `$${t}`],
        ['i32.const', n],
        ...slots,
        // Inline __ptr_aux for CLOSURE pointer: aux holds funcIdx.
        ['i32.wrap_i64', ['i64.and',
          ['i64.shr_u', ['i64.reinterpret_f64', ['local.get', `$${t}`]], ['i64.const', LAYOUT.AUX_SHIFT]],
          ['i64.const', LAYOUT.AUX_MASK]]]]], 'f64')
  }
}
