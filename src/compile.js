/**
 * Compile prepared AST to WASM module (S-expression arrays for watr).
 *
 * # Stage contract
 *   IN:  prepared AST (from prepare) + `ctx.func.list` with raw bodies.
 *   OUT: WAT IR `['module', ...sections]` ready for watrCompile/watrPrint.
 *   FLOW: orchestrator only. Calls analyze passes per function, then emit(body) via
 *         src/emit.js's dispatch, then optimizeFunc (src/optimize.js) per function,
 *         finally assembles module sections in canonical order.
 *
 * # Core abstraction
 * Emitter table (ctx.core.emit) maps AST ops → WASM IR generators. Base operators defined
 * in `emitter` export (src/emit.js); on reset, ctx.core.emit starts as a flat copy of emitter
 * and modules add/override entries directly. No prototype chain.
 * emit(node) dispatches: numbers → i32/f64.const, strings → local.get, arrays → ctx.core.emit[op].
 *
 * # Type system
 * Every emitted node carries .type ('i32' | 'f64').
 * Operators preserve i32 when both operands are i32.
 * Division/power always produce f64. Bitwise/comparisons always produce i32.
 * Variables are typed by pre-analysis: if any assignment is f64, local is f64.
 *
 * Per-function state on ctx: locals (Map name→type), stack (loop labels), uniq (counter), sig.
 *
 * @module compile
 */

import { parse as parseWat } from 'watr'
import { ctx, err, inc, resolveIncludes, PTR, LAYOUT } from './ctx.js'
import {
  T, VAL, analyzeBody,
  unboxablePtrs, typedElemAux, invalidateLocalsCache,
  boxedCaptures, updateRep,
  isBlockBody,
} from './analyze.js'
import { inferLocals } from './infer.js'
import { optimizeFunc, treeshake } from './optimize.js'
import { emit, emitter, emitFlat, emitBody } from './emit.js'
import {
  typed, asF64, asI32, asPtrOffset, asParamType, toI32, asI64, fromI64,
  NULL_NAN, UNDEF_NAN, NULL_WAT, UNDEF_WAT, NULL_IR, UNDEF_IR, nullExpr, undefExpr,
  MAX_CLOSURE_ARITY,
  mkPtrIR,
  isLit, litVal, isNullishLit, emitNum,
  temp,
  isGlobal, isConst, boxedAddr, readVar, writeVar, isNullish, isUndef,
  slotAddr, elemLoad, elemStore, arrayLoop, allocPtr,
  multiCount, loopTop, flat, reconstructArgsWithSpreads,
  valKindToPtr, findBodyStart, tcoTailRewrite,
  I32_MIN, I32_MAX,
} from './ir.js'
import plan from './plan.js'
import {
  buildStartFn, dedupClosureBodies, finalizeClosureTable,
  pullStdlib, syncImports, optimizeModule, stripStaticDataPrefix,
} from './assemble.js'

// =============================================================================
// Single-source export semantics
// =============================================================================
// Two distinct concepts that callers used to conflate:
//
//   1. `f.exported`  — *syntactic* inline-export form, snapshot at `defFunc`
//      time (prepare.js). True iff the func decl carried the inline `export`
//      keyword AND `ctx.func.exports[name]` was already populated by parent
//      decl processing. Only the inline-emit gate below (`(func (export "name") ...)`)
//      should read it — that emit path requires the inline-syntax invariant
//      to avoid duplicate-export collisions with sec.customs.
//
//   2. `isExported(f)` — *semantic* "is this func reachable from JS via any
//      export?". Covers the four forms equally:
//        • inline:           `export function foo` → exports[foo]=true
//        • non-aliased:      `function foo; export { foo }` → exports[foo]='foo'
//        • aliased:          `function foo; export { foo as bar }` → exports[bar]='foo'
//        • default-by-name:  `function foo; export default foo` → exports['default']='foo'
//      Every public-ABI gate (boundary wrap, rest-param packing, i64 ABI,
//      cross-call signature narrowing) should consult this.

/** Semantic export predicate. Use everywhere the question is "should this
 *  func behave as part of the public ABI?" — boundary-wrap, rest-pack,
 *  i64-ABI, sig-narrowing gates.
 *
 *  `f.exported` short-circuits the inline-export case (no map walk needed);
 *  the value-scan picks up `export { f }` / `export { f as g }` / `export
 *  default f` where the source name appears as a *value* keyed under the
 *  public name. */
const isExported = f => {
  if (f.exported) return true
  for (const val of Object.values(ctx.func.exports)) {
    if (val === f.name) return true
  }
  return false
}

/** Iterate JS-visible export names that resolve to `funcName`. Used to emit
 *  per-export ABI metadata in custom sections — one entry per JS-visible name,
 *  since the host (interop.js wrap) keys by export name. */
function* exportNamesOf(funcName) {
  for (const [key, val] of Object.entries(ctx.func.exports)) {
    if (val === true && key === funcName) yield key
    else if (val === funcName) yield key
  }
}

const timePhase = (profiler, name, fn) => profiler ? profiler.time(name, fn) : fn()

// Per-compile func name set + map live on ctx.func.names / ctx.func.map,
// populated at compile() entry. Both reset by ctx.js reset() and re-filled here.

// Low-level IR helpers previously lived here. Pure ones moved to src/ir.js;
// emit-calling ones (toBool, emitTypeofCmp, emitDecl, materializeMulti,
// buildArrayWithSpreads) moved to src/emit.js.

// AST-analysis primitives (staticObjectProps, paramReps lattice helpers,
// infer* cross-call inference, collectProgramFacts) moved to src/analyze.js.

/**
 * Boundary-wrap predicate: exports whose body-driven result OR any param narrowed
 * away from the JS-visible f64 ABI need a wrapper that re-/un-boxes at the JS↔WASM
 * edge so the inner func can keep its raw type while exports preserve Number /
 * pointer semantics for JS callers.
 *
 * Numeric param narrowing on exports IS enabled when all internal call sites pass
 * i32 — the wrapper does `i32.trunc_sat_f64_s` at the boundary (matches JS i32
 * coercion `n | 0` semantics for integer-shaped values; a JS caller passing a
 * fractional Number gets the same truncation it would get from `arr[n]`).
 */
const isBoundaryWrapped = (func) => {
  if (!isExported(func) || func.raw || func.sig.results.length !== 1) return false
  if (func.sig.results[0] !== 'f64' || func.sig.ptrKind != null) return true
  return func.sig.params.some(p => p.type !== 'f64' || p.ptrKind != null)
}

const ensureThrowRuntime = (sec) => {
  if (!ctx.runtime.throws) return

  if (!ctx.scope.globals.has('__jz_last_err_bits'))
    ctx.scope.globals.set('__jz_last_err_bits', '(global $__jz_last_err_bits (mut i64) (i64.const 0))')
  if (!sec.tags.some(t => Array.isArray(t) && t[0] === 'tag' && t[1] === '$__jz_err'))
    sec.tags.push(['tag', '$__jz_err', ['param', 'f64']])
  if (!sec.tags.some(t => Array.isArray(t) && t[0] === 'export' && t[1] === '"__jz_last_err_bits"'))
    sec.tags.push(['export', '"__jz_last_err_bits"', ['global', '$__jz_last_err_bits']])
}

// === Module compilation ===

const cloneRepMap = map => map ? new Map([...map].map(([k, v]) => [k, { ...v }])) : null

/** Serialize a ValueRep entry into a plain object for inspect output.
 *  Omits undefined fields so consumers can JSON-stringify without noise. */
const repView = (rep) => {
  if (!rep) return null
  const out = {}
  for (const k of ['val', 'ptrKind', 'ptrAux', 'schemaId', 'intConst', 'intCertain', 'notString', 'arrayElemSchema', 'arrayElemValType', 'typedCtor', 'jsonShape', 'wasm']) {
    if (rep[k] != null) out[k] = rep[k]
  }
  return Object.keys(out).length ? out : null
}

/** Capture a function's inferred shape into ctx.inspect.functions. Called after
 *  analyzeFuncForEmit when transform.inspect is set — reads from funcFacts +
 *  programFacts.paramReps, never from the live ctx.func.* (which churns per emit). */
function captureFuncInspect(func, facts, programFacts) {
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
    locals,
    ...(Object.keys(callerReps).length ? { callerReps } : {}),
  }
}

function enterFunc(func) {
  ctx.func.stack = []
  ctx.func.uniq = 0
  ctx.func.current = func.sig
  ctx.func.body = func.body
  ctx.func.directClosures = null
  ctx.func.localProps = null
}

function analyzeFuncForEmit(func, programFacts) {
  const { paramReps } = programFacts
  if (func.raw) return null

  const { name, body, sig } = func
  enterFunc(func)

  const block = isBlockBody(body)
  ctx.func.boxed = new Map()
  ctx.func.localReps = null
  ctx.types.typedElem = ctx.scope.globalTypedElem ? new Map(ctx.scope.globalTypedElem) : null

  const _reps = paramReps.get(name)
  if (_reps) {
    for (const [k, r] of _reps) {
      if (k >= sig.params.length) continue
      const pname = sig.params[k].name
      if (r.typedCtor) {
        if (!ctx.types.typedElem) ctx.types.typedElem = new Map()
        if (!ctx.types.typedElem.has(pname)) ctx.types.typedElem.set(pname, r.typedCtor)
        updateRep(pname, { val: VAL.TYPED })
      }
      if (r.val && !ctx.func.localReps?.get(pname)?.val) updateRep(pname, { val: r.val })
      if (r.arrayElemSchema != null) updateRep(pname, { arrayElemSchema: r.arrayElemSchema })
      if (r.arrayElemValType != null) updateRep(pname, { arrayElemValType: r.arrayElemValType })
      if (r.intConst != null) updateRep(pname, { intConst: r.intConst })
    }
  }
  // Drop any earlier-cached analyzeBody.locals slice for this body —
  // narrowSignatures called it before our pre-seed, when params still had no
  // inferred VAL.TYPED, so the cached widths reflect the pre-narrow state.
  // Re-walk now with reps in place.
  invalidateLocalsCache(body)
  ctx.func.locals = block ? analyzeBody(body).locals : new Map()
  // Usage-based shape inference (STRING / ARRAY) for params not already typed
  // by paramReps. Descends into nested closures so a param used in a definite
  // shape only inside an inner arrow (e.g. parseLevel's `str` capture in watr)
  // still gets seeded — the closure capture path then propagates the VAL via
  // captureValTypes.
  //
  // `inferLocals` is body-shape-agnostic — it walks any AST node, so we run it
  // for expression-bodied arrows too (`(s) => s.charCodeAt(0) + s.length` gets
  // `s: VAL.STRING` via methodEvidence the same way the block-bodied variant
  // does). Only `boxedCaptures` / `unboxablePtrs` stay gated:
  // both need `ctx.func.locals` populated, which only block bodies produce.
  const candidates = sig.params
    .filter(p => !ctx.func.localReps?.get(p.name)?.val)
    .map(p => p.name)
  inferLocals(body, candidates)
  if (block) {
    boxedCaptures(body)
    // Lower provably-monomorphic pointer locals to i32 offset storage.
    // VAL.TYPED unbox requires a known element ctor (aux byte) — without it,
    // the use site can't pick the right i32.store{8,16}/i32.store width and
    // the rebox path can't reconstruct the NaN-box. Heterogeneous decls (two
    // `let arr = ...` with different ctors, or a multi-ctor ternary) leave
    // typedElem unset; skip unbox so reads/writes go through `__typed_set_idx`.
    const unbox = unboxablePtrs(body, ctx.func.locals, ctx.func.boxed)
    if (unbox.size > 0) {
      for (const [n, kind] of unbox) {
        const fields = { ptrKind: kind }
        if (kind === VAL.TYPED) {
          const aux = typedElemAux(ctx.types.typedElem?.get(n))
          if (aux == null) continue
          fields.ptrAux = aux
        }
        ctx.func.locals.set(n, 'i32')
        updateRep(n, fields)
      }
    }
  }
  // Pointer-ABI params (from narrowing loop above): params already have type='i32' and
  // ptrKind set. Register them in ctx.func.localReps so readVar tags local.gets correctly.
  // Boxed capture still works: the boxed-init path (below) uses a ptrKind-tagged local.get
  // so asF64 reboxes to NaN-form before f64.store to the cell.
  for (const p of sig.params) {
    if (p.ptrKind == null) continue
    const fields = { ptrKind: p.ptrKind }
    if (p.ptrAux != null) fields.ptrAux = p.ptrAux
    updateRep(p.name, fields)
  }

  return {
    block,
    locals: new Map(ctx.func.locals),
    boxed: new Map(ctx.func.boxed),
    typedElem: ctx.types.typedElem ? new Map(ctx.types.typedElem) : null,
    localReps: cloneRepMap(ctx.func.localReps),
  }
}

/**
 * Phase: emit one user function to WAT IR.
 *
 * Reads precomputed `funcFacts` and the narrowed `func.sig`; applies scoped
 * schema param bindings during emission so they cannot leak between functions.
 */
function emitFunc(func, funcFacts, programFacts) {
  const { paramReps } = programFacts

  // Raw WAT functions (e.g., _alloc, _clear from memory module)
  if (func.raw) return parseWat(func.raw)

  const { name, body, exported, sig } = func
  const multi = sig.results.length > 1
  const _reps = paramReps.get(name)

  enterFunc(func)
  const block = funcFacts.block
  ctx.func.locals = new Map(funcFacts.locals)
  ctx.func.boxed = new Map(funcFacts.boxed)
  ctx.func.localReps = cloneRepMap(funcFacts.localReps)
  ctx.types.typedElem = funcFacts.typedElem ? new Map(funcFacts.typedElem) : null

  // D: Apply call-site param facts (only if body analysis didn't already set them).
  // Schema bindings additionally write into ctx.schema.vars so prop-access dispatch
  // hits the slot map. ctx.schema.vars is saved/restored so bindings don't leak.
  const schemaVarsPrev = new Map(ctx.schema.vars)
  if (_reps) {
    for (const [k, r] of _reps) {
      if (k >= sig.params.length) continue
      const pname = sig.params[k].name
      if (r.val && !ctx.func.localReps?.get(pname)?.val) updateRep(pname, { val: r.val })
      if (r.typedCtor) {
        if (!ctx.types.typedElem) ctx.types.typedElem = new Map()
        if (!ctx.types.typedElem.has(pname)) ctx.types.typedElem.set(pname, r.typedCtor)
        if (!ctx.func.localReps?.get(pname)?.val) updateRep(pname, { val: VAL.TYPED })
      }
      if (r.schemaId != null && !exported && !ctx.schema.vars.has(pname)) {
        ctx.schema.vars.set(pname, r.schemaId)
        updateRep(pname, { schemaId: r.schemaId })
      }
    }
  }

  const fn = ['func', `$${name}`]
  // Inline `(export ...)` attribute only for the syntactic inline-export
  // form (`export function foo`, snapshot in `func.exported` at defFunc
  // time). Re-exports (`function foo; export { foo }`) and aliases (`export
  // { foo as bar }`) flow through sec.customs below — emitting an inline
  // attribute under the internal symbol would collide with the customs
  // entry on the same name, or leak the internal symbol publicly.
  // Boundary-wrapped exports also defer the attribute to the synthesized
  // wrapper ($${name}$exp) that reboxes the narrowed result back to f64.
  if (exported && !isBoundaryWrapped(func)) fn.push(['export', `"${name}"`])
  fn.push(...sig.params.map(p => ['param', `$${p.name}`, p.type]))
  fn.push(...sig.results.map(t => ['result', t]))

  // Default params: ES spec says default applies only when arg is `undefined`
  // (or missing). `null`, `0`, `false`, etc. all skip the default.
  const defaults = func.defaults || {}
  const defaultInits = []
  for (const [pname, defVal] of Object.entries(defaults)) {
    const p = sig.params.find(p => p.name === pname)
    const t = p?.type || 'f64'
    defaultInits.push(
      ['if', isUndef(typed(['local.get', `$${pname}`], 'f64')),
        ['then', ['local.set', `$${pname}`, t === 'f64' ? asF64(emit(defVal)) : asI32(emit(defVal))]]])
  }

  // Box params that are mutably captured: allocate cell, copy param value
  const boxedParamInits = []
  const preboxedLocalInits = []
  ctx.func.preboxed = new Set()
  const paramNames = new Set(sig.params.map(p => p.name))
  for (const p of sig.params) {
    if (ctx.func.boxed.has(p.name)) {
      const cell = ctx.func.boxed.get(p.name)
      ctx.func.locals.set(cell, 'i32')
      ctx.func.preboxed.add(p.name)
      const lget = typed(['local.get', `$${p.name}`], p.type)
      if (p.ptrKind != null) lget.ptrKind = p.ptrKind
      boxedParamInits.push(
        ['local.set', `$${cell}`, ['call', '$__alloc', ['i32.const', 8]]],
        ['f64.store', ['local.get', `$${cell}`], asF64(lget)])
    }
  }
  for (const [name, cell] of ctx.func.boxed) {
    if (paramNames.has(name)) continue
    ctx.func.locals.set(cell, 'i32')
    ctx.func.preboxed.add(name)
    preboxedLocalInits.push(
      ['local.set', `$${cell}`, ['call', '$__alloc', ['i32.const', 8]]],
      ['f64.store', ['local.get', `$${cell}`], nullExpr()])
  }

  if (block) {
    const stmts = emitBody(body)
    for (const [l, t] of ctx.func.locals) fn.push(['local', `$${l}`, t])
    // I: Skip trailing fallback when last statement is return (unreachable code)
    const lastStmt = stmts.at(-1)
    const endsWithReturn = lastStmt && (lastStmt[0] === 'return' || lastStmt[0] === 'return_call')
    fn.push(...defaultInits, ...boxedParamInits, ...preboxedLocalInits, ...stmts, ...(endsWithReturn ? [] : sig.results.map(t => [`${t}.const`, 0])))
  } else if (multi && body[0] === '[') {
    const values = body.slice(1).map(e => asF64(emit(e)))
    for (const [l, t] of ctx.func.locals) fn.push(['local', `$${l}`, t])
    fn.push(...boxedParamInits, ...preboxedLocalInits, ...values)
  } else {
    const ir = emit(body)
    for (const [l, t] of ctx.func.locals) fn.push(['local', `$${l}`, t])
    const finalIR = sig.ptrKind != null ? asPtrOffset(ir, sig.ptrKind) : asParamType(ir, sig.results[0])
    fn.push(...defaultInits, ...boxedParamInits, ...preboxedLocalInits, tcoTailRewrite(finalIR, sig.results[0]))
  }

  // Restore schema.vars so param bindings don't leak to next function.
  ctx.schema.vars = schemaVarsPrev
  return fn
}

/**
 * Phase: synthesize JS-boundary wrappers for narrowed exports.
 *
 * For each `isBoundaryWrapped(func)`, emit a sibling `$${name}$exp` that:
 *   - holds the (export "name") attribute (JS sees the wrapper)
 *   - takes i64 params always — JS-side carrier is BigInt that reinterprets to
 *     f64 NaN-box bits. i64 dodges V8's spec-permitted NaN canonicalization at
 *     the wasm↔JS boundary (see ToJSValue / ToWebAssemblyValue). Host wrap()
 *     in interop.js pairs by converting BigInt↔f64 via reinterpret bits.
 *   - converts each narrowed param at the call: f64 → i32 (truncate-sat) for
 *     numeric narrowed, f64 → i32-offset (`i32.wrap_i64 + i64.reinterpret_f64`)
 *     for pointer narrowed. The reinterpret happens once at param decode and
 *     once at result encode; numeric exports without narrowing skip wrapping
 *     entirely (no NaN-class values).
 *   - forwards args to the inner $${name}
 *   - reboxes the narrowed result and reinterprets to i64 for the boundary
 *
 * Param decode (i64 → f64): each param gets `f64.reinterpret_i64` before the
 * existing narrowing convert. f64 inner params just need the reinterpret.
 *
 * Result rebox cases (then reinterpret to i64 at the boundary):
 *   - sig.ptrKind != null  → mkPtrIR(ptrKind, ptrAux ?? 0, callIR)
 *   - sig.results[0] = i32 → f64.convert_i32_s(callIR), or `_u` when
 *                            sig.unsignedResult (preserves `(x >>> 0)` ∈ [0, 2³²))
 *   - sig.results[0] = f64 → callIR (some params narrowed but result stayed f64)
 */
function synthesizeBoundaryWrappers() {
  const wrappers = []
  for (const func of ctx.func.list) {
    if (!isBoundaryWrapped(func)) continue
    const { name, sig } = func
    // Per-position i64 carrier: only swap to i64 where a NaN-boxed pointer
    // actually crosses the boundary (param.ptrKind set, or result with
    // sig.ptrKind set). Numeric narrowing (i32 trunc-sat / convert) keeps f64
    // so callers seeing the raw export get a plain Number for numerics.
    const paramI64 = sig.params.map(p => p.ptrKind != null)
    const resultI64 = sig.ptrKind != null
    // Inline `(export ...)` attribute only when the func decl carried the
    // inline-export keyword (`export function foo`). For re-exports
    // (`function foo; export { foo as bar }`) the `name` is the *internal*
    // symbol; sec.customs holds the JS-visible export pointing at this
    // wrapper. Emitting an inline attribute here under the internal name
    // would leak the symbol publicly and collide with the customs entry.
    const wrapNode = func.exported
      ? ['func', `$${name}$exp`, ['export', `"${name}"`]]
      : ['func', `$${name}$exp`]
    sig.params.forEach((p, i) => wrapNode.push(['param', `$${p.name}`, paramI64[i] ? 'i64' : 'f64']))
    wrapNode.push(['result', resultI64 ? 'i64' : 'f64'])
    const args = sig.params.map((p, i) => {
      const get = ['local.get', `$${p.name}`]
      if (p.ptrKind != null) {
        // ptrKind: i64 carrier carries NaN-box bits → wrap to i32 offset
        return ['i32.wrap_i64', get]
      }
      if (p.type === 'f64') return get
      // Numeric narrowing: f64 → i32 truncate
      return ['i32.trunc_sat_f64_s', get]
    })
    const callIR = ['call', `$${name}`, ...args]
    let body
    if (sig.ptrKind != null) {
      const ptrType = valKindToPtr(sig.ptrKind)
      body = mkPtrIR(ptrType, sig.ptrAux ?? 0, callIR)
    } else if (sig.results[0] === 'i32') {
      body = [sig.unsignedResult ? 'f64.convert_i32_u' : 'f64.convert_i32_s', callIR]
    } else {
      body = callIR
    }
    wrapNode.push(resultI64 ? ['i64.reinterpret_f64', body] : body)
    func._exportUsesI64 = resultI64 || paramI64.some(Boolean)
    func._exportI64Sig = { params: paramI64, result: resultI64 }
    wrappers.push(wrapNode)
  }
  return wrappers
}


/**
 * Phase: emit one closure body to WAT IR.
 *
 * Closures share a uniform signature (env f64, argc i32, a0..a{W-1} f64) → f64
 * so any closure can be invoked via call_indirect on $ftN. This function
 * builds one body fn given the body record (cb) created by ctx.closure.make.
 *
 * Mutates ctx.func.* per-body state (locals, boxed, localReps) and
 * ctx.schema.vars / ctx.types.typedElem (restored on exit so capture-binding
 * leaks don't poison the next body). Returns the WAT IR for the func node.
 */
function emitClosureBody(cb) {
  const prevSchemaVars = ctx.schema.vars
  const prevTypedElems = ctx.types.typedElem
  // Reset per-function state for closure body
  ctx.func.locals = new Map()
  ctx.func.localReps = null
  if (cb.intConsts) for (const [name, v] of cb.intConsts) updateRep(name, { intConst: v })
  if (cb.intCertain) for (const name of cb.intCertain) updateRep(name, { intCertain: true })
  if (cb.valTypes) for (const [name, vt] of cb.valTypes) updateRep(name, { val: vt })
  if (cb.schemaVars) {
    ctx.schema.vars = new Map([...prevSchemaVars, ...cb.schemaVars])
    for (const [name, sid] of cb.schemaVars) updateRep(name, { schemaId: sid })
  }
  const globalTE = ctx.scope.globalTypedElem
  if (cb.typedElems) {
    ctx.types.typedElem = globalTE ? new Map([...globalTE, ...cb.typedElems]) : new Map(cb.typedElems)
  } else if (globalTE) {
    ctx.types.typedElem = new Map(globalTE)
  } else {
    ctx.types.typedElem = prevTypedElems
  }
  // In closure bodies, boxed captures use the original name as both var and cell local
  ctx.func.boxed = cb.boxed ? new Map([...cb.boxed].map(v => [v, v])) : new Map()
  const parentBoxedCaptures = new Set(cb.boxed || [])
  ctx.func.preboxed = new Set()
  ctx.func.stack = []
  ctx.func.uniq = Math.max(ctx.func.uniq, 100) // avoid label collisions
  // Bare `;`-sequence bodies (no enclosing `{}`) reach us when callers built a
  // statement list directly — wrap into a block body so the multi-stmt path
  // runs (otherwise emit returns an untyped list and asF64 wraps it with
  // `f64.convert_i32_s`, yielding invalid WAT).
  if (Array.isArray(cb.body) && cb.body[0] === ';') cb.body = ['{}', cb.body]
  ctx.func.body = cb.body
  // Seed direct-call dispatch for captured const-bound closures (A3 across capture boundary).
  // closure.make snapshotted the parent's directClosures for each capture; here we restore
  // them so calls to a captured `peek` lower to `call $closureN` instead of call_indirect.
  ctx.func.directClosures = cb.directClosures ? new Map(cb.directClosures) : null
  // Uniform convention: (env f64, argc i32, a0..a{width-1} f64) → f64
  const W = ctx.closure.width ?? MAX_CLOSURE_ARITY
  const paramDecls = [{ name: '__env', type: 'f64' }, { name: '__argc', type: 'i32' }]
  for (let i = 0; i < W; i++) paramDecls.push({ name: `__a${i}`, type: 'f64' })
  ctx.func.current = { params: paramDecls, results: ['f64'] }

  const fn = ['func', `$${cb.name}`]
  fn.push(['param', '$__env', 'f64'])
  fn.push(['param', '$__argc', 'i32'])
  for (let i = 0; i < W; i++) fn.push(['param', `$__a${i}`, 'f64'])
  fn.push(['result', 'f64'])

  // Params are locals, assigned directly from inline slots
  for (const p of cb.params) ctx.func.locals.set(p, 'f64')

  // Register captured variable locals: boxed = i32 cell pointer, otherwise f64 value
  for (let i = 0; i < cb.captures.length; i++) {
    const name = cb.captures[i]
    ctx.func.locals.set(name, ctx.func.boxed.has(name) ? 'i32' : 'f64')
  }

  // Emit body
  const block = isBlockBody(cb.body)
  let bodyIR
  if (block) {
    invalidateLocalsCache(cb.body)
    for (const [k, v] of analyzeBody(cb.body).locals) if (!ctx.func.locals.has(k)) ctx.func.locals.set(k, v)
    // Usage-based shape inference for closure params not seeded by captureValTypes.
    // (Captures already have their parent's val type via cb.valTypes above.)
    inferLocals(cb.body, cb.params.filter(p => !ctx.func.localReps?.get(p)?.val))
    // Detect captures from deeper nested arrows that mutate this body's locals/params/captures
    boxedCaptures(cb.body)
    for (const name of ctx.func.boxed.keys()) {
      if (parentBoxedCaptures.has(name) && ctx.func.locals.get(name) === 'f64') ctx.func.locals.set(name, 'i32')
    }
    const unbox = unboxablePtrs(cb.body, ctx.func.locals, ctx.func.boxed)
    for (const [name, kind] of unbox) {
      if (cb.params.includes(name) || cb.captures.includes(name)) continue
      const fields = { ptrKind: kind }
      if (kind === VAL.TYPED) {
        const aux = typedElemAux(ctx.types.typedElem?.get(name))
        if (aux == null) continue
        fields.ptrAux = aux
      }
      ctx.func.locals.set(name, 'i32')
      updateRep(name, fields)
    }
    bodyIR = emitBody(cb.body)
  } else {
    bodyIR = [asF64(emit(cb.body))]
  }

  // Pre-allocate cache locals for env unpacking
  const envBase = cb.captures.length > 0 ? `${T}envBase${ctx.func.uniq++}` : null
  if (envBase) ctx.func.locals.set(envBase, 'i32')
  // Rest param: allocate helper locals (len + offset) before emitting decls
  let restOff, restLen
  if (cb.rest) {
    restOff = `${T}restOff${ctx.func.uniq++}`
    restLen = `${T}restLen${ctx.func.uniq++}`
    ctx.func.locals.set(restOff, 'i32')
    ctx.func.locals.set(restLen, 'i32')
    inc('__alloc_hdr', '__mkptr')
  }

  const boxedCaptureNames = new Set(cb.captures.filter(name => parentBoxedCaptures.has(name)))
  for (const name of boxedCaptureNames) ctx.func.preboxed.add(name)
  const boxedValueCaptureNames = new Set(cb.captures.filter(name => ctx.func.boxed.has(name) && !parentBoxedCaptures.has(name)))
  for (const name of boxedValueCaptureNames) {
    ctx.func.locals.set(ctx.func.boxed.get(name), 'i32')
    ctx.func.preboxed.add(name)
  }
  const boxedParamNames = new Set(cb.params.filter(name => ctx.func.boxed.has(name)))
  for (const name of boxedParamNames) {
    ctx.func.locals.set(ctx.func.boxed.get(name), 'i32')
    ctx.func.preboxed.add(name)
  }
  const preboxedLocalInits = []
  for (const [name, cell] of ctx.func.boxed) {
    if (boxedCaptureNames.has(name) || boxedValueCaptureNames.has(name) || boxedParamNames.has(name)) continue
    ctx.func.locals.set(cell, 'i32')
    ctx.func.preboxed.add(name)
    preboxedLocalInits.push(
      ['local.set', `$${cell}`, ['call', '$__alloc', ['i32.const', 8]]],
      ['f64.store', ['local.get', `$${cell}`], nullExpr()])
  }

  // Insert locals (captures + params + declared)
  for (const [l, t] of ctx.func.locals) fn.push(['local', `$${l}`, t])

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

  // Rest param: pack slots a[fixedParams..argc-1] into fresh array.
  // len = clamp(argc - fixedParams, 0, restSlots). Rest-param closures receive
  // at most (width - fixedParams) rest args — spread callers with
  // more dynamic elements lose the overflow (documented limitation).
  if (cb.rest) {
    const fixedN = fixedParamN
    const restSlots = W - fixedN
    fn.push(['local.set', `$${restLen}`,
      ['select',
        ['i32.sub', ['local.get', '$__argc'], ['i32.const', fixedN]],
        ['i32.const', 0],
        ['i32.gt_s', ['local.get', '$__argc'], ['i32.const', fixedN]]]])
    fn.push(['if', ['i32.gt_s', ['local.get', `$${restLen}`], ['i32.const', restSlots]],
      ['then', ['local.set', `$${restLen}`, ['i32.const', restSlots]]]])
    fn.push(['local.set', `$${restOff}`,
      ['call', '$__alloc_hdr',
        ['local.get', `$${restLen}`], ['local.get', `$${restLen}`]]])
    for (let i = 0; i < restSlots; i++) {
      fn.push(['if', ['i32.gt_s', ['local.get', `$${restLen}`], ['i32.const', i]],
        ['then', ['f64.store',
          ['i32.add', ['local.get', `$${restOff}`], ['i32.const', i * 8]],
          ['local.get', `$__a${fixedN + i}`]]]])
    }
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
  if (cb.defaults) {
    for (const [pname, defVal] of Object.entries(cb.defaults)) {
      if (boxedParamNames.has(pname)) {
        fn.push(['if', isUndef(['f64.load', boxedAddr(pname)]),
          ['then', ['f64.store', boxedAddr(pname), asF64(emit(defVal))]]])
      } else {
        fn.push(['if', isUndef(['local.get', `$${pname}`]),
          ['then', ['local.set', `$${pname}`, asF64(emit(defVal))]]])
      }
    }
  }
  fn.push(...preboxedLocalInits)
  fn.push(...bodyIR)
  // I: Skip trailing fallback when last statement is return
  // Implicit fall-through return is `undefined` per JS spec, not 0.
  if (block && !(bodyIR.at(-1)?.[0] === 'return' || bodyIR.at(-1)?.[0] === 'return_call')) fn.push(undefExpr())
  ctx.schema.vars = prevSchemaVars
  ctx.types.typedElem = prevTypedElems
  return fn
}

/**
 * Compile prepared AST to WASM module IR.
 * @param {import('./prepare.js').ASTNode} ast - Prepared AST
 * @returns {Array} Complete WASM module as S-expression
 */
export default function compile(ast, profiler) {
  // Populate known function names + lookup map on ctx.func for direct call detection
  ctx.func.names.clear()
  ctx.func.map.clear()
  for (const f of ctx.func.list) { ctx.func.names.add(f.name); ctx.func.map.set(f.name, f) }
  // Include imported functions for call resolution (e.g. template interpolations).
  // Also register a synthesized sig in func.map so emit's arity-aware branches see
  // the import's declared param count — needed for arg pad/truncate to match it.
  for (const imp of ctx.module.imports) {
    if (imp[3]?.[0] !== 'func') continue
    const fname = imp[3][1].replace(/^\$/, '')
    ctx.func.names.add(fname)
    if (!ctx.func.map.has(fname)) {
      const params = []
      let result = 'f64'
      for (let k = 2; k < imp[3].length; k++) {
        const part = imp[3][k]
        if (Array.isArray(part) && part[0] === 'param') params.push({ type: part[1] || 'f64' })
        else if (Array.isArray(part) && part[0] === 'result') result = part[1] || 'f64'
      }
      ctx.func.map.set(fname, { name: fname, sig: { params, results: [result] } })
    }
  }

  // Check user globals don't conflict with runtime globals (modules loaded after user decls)
  for (const name of ctx.scope.userGlobals)
    if (!ctx.scope.globals.get(name)?.includes('mut f64'))
      err(`'${name}' conflicts with a compiler internal — choose a different name`)

  // Pre-fold const globals: evaluate constant initializers before function compilation
  // so functions see the correct global types (i32 vs f64).
  if (ast) {
    const evalConst = n => {
      if (typeof n === 'number') return n
      if (Array.isArray(n) && n[0] == null && typeof n[1] === 'number') return n[1]
      if (!Array.isArray(n)) return null
      const [op, a, b] = n
      const va = evalConst(a), vb = b !== undefined ? evalConst(b) : null
      if (va == null) return null
      if (op === 'u-' || (op === '-' && b === undefined)) return -va
      if (vb == null) return null
      if (op === '+') return va + vb; if (op === '-') return va - vb
      if (op === '*') return va * vb; if (op === '%' && vb) return va % vb
      if (op === '/' && vb) return va / vb; if (op === '**') return va ** vb
      if (op === '&') return va & vb; if (op === '|') return va | vb
      if (op === '^') return va ^ vb; if (op === '<<') return va << vb
      if (op === '>>') return va >> vb; if (op === '>>>') return va >>> vb
      return null
    }
    const stmts = Array.isArray(ast) && ast[0] === ';' ? ast.slice(1)
      : Array.isArray(ast) && ast[0] === 'const' ? [ast] : []
    for (const s of stmts) {
      if (!Array.isArray(s) || s[0] !== 'const') continue
      for (const decl of s.slice(1)) {
        if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') continue
        const [, name, init] = decl
        if (!ctx.scope.globals.has(name) || !ctx.scope.consts?.has(name)) continue
        const v = evalConst(init)
        if (v == null || !isFinite(v)) continue
        const isInt = Number.isInteger(v) && v >= I32_MIN && v <= I32_MAX
        ctx.scope.globals.set(name, isInt
          ? `(global $${name} i32 (i32.const ${v}))`
          : `(global $${name} f64 (f64.const ${v}))`)
        ctx.scope.globalTypes.set(name, isInt ? 'i32' : 'f64')
        // Cache integer values for cross-call const-arg propagation: `f(N)` where
        // `const N = 8` should observe the param as intConst=8.
        if (isInt) (ctx.scope.constInts ||= new Map()).set(name, v)
      }
    }
  }

  const programFacts = timePhase(profiler, 'plan', () => plan(ast))

  // Inspect sink: editor hosts opt in via { inspect: true } to read inferred shapes.
  // Initialized here (post-plan) so paramReps and schema.list are stable, populated
  // per-function below as funcFacts settle. Bytes themselves are unchanged.
  if (ctx.transform.inspect) ctx.inspect = { functions: {}, schemas: ctx.schema.list.map(s => s.slice()) }

  const funcFacts = new Map()
  for (const func of ctx.func.list) {
    if (func.raw) continue
    const facts = analyzeFuncForEmit(func, programFacts)
    funcFacts.set(func, facts)
    captureFuncInspect(func, facts, programFacts)
  }
  const funcs = ctx.func.list.map(func => emitFunc(func, funcFacts.get(func), programFacts))
  funcs.push(...synthesizeBoundaryWrappers())

  const closureFuncs = []
  let compiledBodyCount = 0
  const compilePendingClosures = () => {
    const bodies = ctx.closure.bodies || []
    for (let bodyIndex = compiledBodyCount; bodyIndex < bodies.length; bodyIndex++) {
      closureFuncs.push(emitClosureBody(bodies[bodyIndex]))
    }
    compiledBodyCount = bodies.length
  }
  compilePendingClosures()

  // Build module sections — named slots, assembled at the end (no index bookkeeping)
  const sec = {
    extStdlib: [],  // external stdlib (imports that must precede all other imports)
    imports: [...ctx.module.imports],
    types: [],      // function types for call_indirect
    memory: [],     // memory declaration
    data: [],       // data segment (filled after emit)
    tags: [],       // error tags + related exports
    table: [],      // function table (at most one)
    globals: [],    // globals (filled after __start)
    funcs: [],      // closure funcs + regular funcs
    elem: [],       // element section (table init)
    start: [],      // __start func + start directive
    stdlib: [],     // stdlib functions
    customs: [],    // custom sections + exports
  }

  // Uniform closure convention: (env f64, argc i32, a0..a{MAX-1} f64) → f64.
  // argc = actual arg count passed; missing slots padded with UNDEF_NAN at caller.
  // Rest-param bodies pack slots a[fixedParams..argc-1] into their rest array.
  // MAX_CLOSURE_ARITY is the fixed inline-slot count; calls with more args error.
  if (ctx.closure.types) {
    const params = [['param', 'f64'], ['param', 'i32']] // env + argc
    for (let i = 0; i < (ctx.closure.width ?? MAX_CLOSURE_ARITY); i++) params.push(['param', 'f64'])
    sec.types.push(['type', `$ftN`, ['func', ...params, ['result', 'f64']]])
  }

  // Memory section deferred — emitted after resolveIncludes() when __alloc is needed

  if (ctx.closure.table?.length)
    sec.table.push(['table', ['export', '"__jz_table"'], ctx.closure.table.length, 'funcref'])

  sec.funcs.push(...closureFuncs, ...funcs)

  // WASI command-mode entries (`run`, `_start`) must export as () -> ();
  // wasmtime/wasmer reject f64-returning functions under those names.
  // Parametric entries skip this — a CLI invocation has no way to supply args.
  const wasiCommandExports = new Set()
  if (ctx.transform.host === 'wasi') {
    const WASI_ENTRIES = new Set(['run', '_start'])
    for (const [exportName, val] of Object.entries(ctx.func.exports)) {
      if (!WASI_ENTRIES.has(exportName)) continue
      const targetName = val === true ? exportName : val
      if (typeof targetName !== 'string') continue
      const func = ctx.func.list.find(f => f.name === targetName)
      if (!func) continue
      if (func.sig.params.length) continue
      const inner = isBoundaryWrapped(func) ? `$${targetName}$exp` : `$${targetName}`
      for (const f of sec.funcs) {
        if (f[1] === inner || f[1] === `$${targetName}`) {
          const expIdx = f.findIndex(n => Array.isArray(n) && n[0] === 'export')
          if (expIdx >= 0) f.splice(expIdx, 1)
        }
      }
      sec.funcs.push(['func', `$${exportName}$wasi`, ['export', `"${exportName}"`],
        ['drop', ['call', inner]]])
      wasiCommandExports.add(exportName)
    }
  }

  if (ctx.closure.table?.length)
    sec.elem.push(['elem', ['i32.const', 0], 'func', ...ctx.closure.table.map(n => `$${n}`)])

  buildStartFn(ast, sec, closureFuncs, compilePendingClosures)

  syncImports(sec)

  dedupClosureBodies(closureFuncs, sec)

  finalizeClosureTable(sec)

  pullStdlib(sec)

  stripStaticDataPrefix(sec)

  ensureThrowRuntime(sec)

  optimizeModule(sec)

  // Populate globals (after __start — const folding may update declarations)
  sec.globals.push(...[...ctx.scope.globals.values()].filter(g => g).map(g => parseWat(g)))

  // Data segments (after emit — string literals append to ctx.runtime.data / strPool during emit)
  // Active segment at address 0 — skipped for shared memory (would collide across modules)
  const escBytes = (s) => {
    let esc = ''
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      if (c >= 32 && c < 127 && c !== 34 && c !== 92) esc += s[i]
      else esc += '\\' + c.toString(16).padStart(2, '0')
    }
    return esc
  }
  if (ctx.runtime.data && !ctx.memory.shared)
    sec.data.push(['data', ['i32.const', 0], '"' + escBytes(ctx.runtime.data) + '"'])
  // alloc:false routes the heap pointer through memory[1020] (no $__heap global).
  // Initialize it at module-load — otherwise the first __alloc reads 0 and overlaps
  // allocations with the static-data / constant-pool region.  Owned memory only;
  // for shared memory the host is responsible for init.  Emitted last so it
  // overrides any prior segment that happened to cover bytes 1020..1023.
  if (ctx.transform.alloc === false && !ctx.memory.shared && sec.memory.length > 0) {
    const dataLen = ctx.runtime.data?.length || 0
    const heapBase = dataLen > 1024 ? (dataLen + 7) & ~7 : 1024
    const initBytes = String.fromCharCode(
      heapBase & 0xFF, (heapBase >> 8) & 0xFF,
      (heapBase >> 16) & 0xFF, (heapBase >> 24) & 0xFF)
    sec.data.push(['data', ['i32.const', 1020], '"' + escBytes(initBytes) + '"'])
  }
  // Passive segment for shared-memory string literals (copied via memory.init at runtime)
  if (ctx.runtime.strPool)
    sec.data.push(['data', '$__strPool', '"' + escBytes(ctx.runtime.strPool) + '"'])

  // Custom section: embed object schemas for JS-side interop.
  // Compact binary format: varint(nSchemas); per schema: varint(nProps); per prop:
  //   0x00=null, 0x01=[null, <prop>], 0x02=<varint len><utf8 bytes>. Runtime decodes.
  if (ctx.schema.list.length) {
    const bytes = []
    const utf8 = new TextEncoder()
    const varint = (n) => { while (n >= 0x80) { bytes.push((n & 0x7F) | 0x80); n >>>= 7 } bytes.push(n) }
    const enc = (p) => {
      if (p === null) bytes.push(0)
      else if (Array.isArray(p)) { bytes.push(1); enc(p[1]) }
      else { bytes.push(2); const b = utf8.encode(p); varint(b.length); for (const x of b) bytes.push(x) }
    }
    varint(ctx.schema.list.length)
    for (const s of ctx.schema.list) { varint(s.length); for (const p of s) enc(p) }
    sec.customs.push(['@custom', '"jz:schema"', bytes])
  }

  // Custom section: rest params for exported functions (JS-side wrapping).
  // Entry per JS-visible export name (not per internal func name) — host's
  // interop.js wrap() keys by export name. Aliased re-export
  // (`function foo (...rest); export { foo as bar }`) needs `bar` in the
  // list; otherwise JS pads the missing args with UNDEF_NAN and the
  // VAL.ARRAY narrow path reads i32 at `__ptr_offset(UNDEF_NAN) - 8`, hitting
  // OOB instead of the polymorphic length-check fallback's tag-aware return-0.
  const restParamFuncs = []
  for (const f of ctx.func.list) {
    if (!isExported(f) || !f.rest) continue
    const fixed = f.sig.params.length - 1
    for (const exportName of exportNamesOf(f.name)) restParamFuncs.push({ name: exportName, fixed })
  }
  if (restParamFuncs.length)
    sec.customs.push(['@custom', '"jz:rest"', `"${JSON.stringify(restParamFuncs).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`])

  // Custom section: per-export i64 ABI map. Each entry describes an export
  // whose boundary wrapper carries NaN-boxed pointers via i64 (rather than
  // f64) to dodge V8's NaN canonicalization. Format: { name, p, r } where p
  // is an array of i64 param indices and r is 1 if result is i64. host.js
  // wrap() reinterprets BigInt↔f64 at i64 positions; numeric f64 positions
  // stay as Numbers on the JS side.
  const i64Exports = []
  for (const f of ctx.func.list) {
    if (!isExported(f) || !isBoundaryWrapped(f) || !f._exportUsesI64) continue
    const p = []
    f._exportI64Sig.params.forEach((b, i) => { if (b) p.push(i) })
    const r = f._exportI64Sig.result ? 1 : 0
    // One entry per JS-visible export name (inline + non-aliased + aliased
    // re-exports). `exportNamesOf` yields every name that resolves to f —
    // wrap() looks up by export name, not by internal symbol.
    for (const exportName of exportNamesOf(f.name)) i64Exports.push({ name: exportName, p, r })
  }
  if (i64Exports.length)
    sec.customs.push(['@custom', '"jz:i64exp"', `"${JSON.stringify(i64Exports).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`])

  // Named export aliases: export { name } or export { source as alias }
  for (const [name, val] of Object.entries(ctx.func.exports)) {
    if (wasiCommandExports.has(name)) continue
    if (val === true) {
      if (ctx.scope.userGlobals?.has(name)) sec.customs.push(['export', `"${name}"`, ['global', `$${name}`]])
      continue
    }
    if (typeof val !== 'string') continue
    const func = ctx.func.list.find(f => f.name === val)
    // Boundary-wrapped funcs export through the synthesized $${val}$exp wrapper
    // so the JS-visible alias preserves f64 ABI.
    if (func) sec.customs.push(['export', `"${name}"`, ['func', `$${isBoundaryWrapped(func) ? val + '$exp' : val}`]])
    else if (ctx.scope.globals.has(val)) sec.customs.push(['export', `"${name}"`, ['global', `$${val}`]])
  }

  // Whole-module: prune funcs unreachable from entry points (start, exports, elem refs).
  // Removes orphan top-level consts that never get called (e.g. watr's unused `hoist` = 26 KB).
  // Also returns callCount Map (computed during the same walk — used below for funcidx sort).
  // Reachability walk always runs (callCount feeds the sort even when shake is off);
  // actual removal gated by ctx.transform.optimize.treeshake.
  const optCfg = ctx.transform.optimize
  const { callCount } = treeshake(
    [{ arr: sec.stdlib }, { arr: sec.funcs }, { arr: sec.start }],
    [...sec.start, ...sec.elem, ...sec.customs, ...sec.extStdlib, ...sec.imports, ...sec.tags],
    { removeDead: !optCfg || optCfg.treeshake !== false, globals: sec.globals }
  )

  // Reorder non-import funcs by call count: hot callees get low LEB128 indices.
  // `call $f` encodes funcidx as ULEB128 (1 B for idx < 128, 2 B for idx < 16384).
  // On watr self-host this saves ~6 KB (hot specialized helpers migrate to idx < 128).
  // callCount was computed inline by treeshake's walk (same set of nodes).
  const byCalls = (a, b) => (callCount.get(b[1]) || 0) - (callCount.get(a[1]) || 0)
  const startFn = sec.start.find(n => n[0] === 'func')
  const startDir = sec.start.find(n => n[0] === 'start')
  const sortedFuncs = [
    ...sec.stdlib, ...sec.funcs, ...(startFn ? [startFn] : []),
  ].sort(byCalls)

  // Assemble: named slots → flat section list.
  const sections = [
    ...sec.extStdlib, ...sec.imports, ...sec.types, ...sec.memory, ...sec.data,
    ...sec.tags, ...sec.table, ...sec.globals, ...sortedFuncs,
    ...sec.elem, ...(startDir ? [startDir] : []), ...sec.customs,
  ]
  return ['module', ...sections]
}
