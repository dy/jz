import { OPTF } from '../ctx.js'
import { dataAlign, dataPush, dataLen, dataString, strPoolLen, strPoolString } from '../static-data.js'
/**
 * Compile prepared AST to WASM module (S-expression arrays for watr).
 *
 * # Stage contract
 *   IN:  prepared AST (from prepare) + `ctx.funcs.list` with raw bodies.
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

import parseWat from 'watr/parse'
import { ctx, err, inc, resolveIncludes, PTR, LAYOUT, declGlobal, assertCtxInvariants } from '../ctx.js'
import { enterActiveFunction, restoreActiveFunction } from './active-function.js'
import { enterPreparedFunction, functionPlanOf, installFunctionPlan, publishFunctionPlan, publishPreparedFunctionPlan, retireFunctionPlan } from './function-plan.js'
import { makeMapOverlay, mapOrOverlaySize } from './map-overlay.js'
import { i64Hex } from '../../layout.js'
import { T, isBlockBody, isReassigned, returnExprs, MUTATE_OPS, beginAssignedMemo, endAssignedMemo } from '../ast.js'
import { valTypeOf, hasAmbiguousBoolMerge, censusBigintResultShape } from '../kind.js'
import { intLiteralValue } from '../static.js'
import { intCertainMap, typedStaticLen } from '../type.js'
import {
  analyzeBody, unboxablePtrs, inheritPtrAliases, cseSafeLoadBases, boxedCaptures,
  analyzeStructInline, analyzeUnionInline, reanalyzeBody, invalidateAllBodyFacts,
} from './analyze.js'
import { typedElemAux } from '../../layout.js'
import { invalidateBindingUsesCache, resetBindingUsesCache } from './analyze-scans.js'
import { VAL, updateRep, REP_FIELDS } from '../reps.js'
import { inferLocals } from './infer.js'
import { optimizeFunc, treeshake } from '../optimize/index.js'
import { strengthReduceLoopDivMod } from './loop-divmod.js'
import { mintLoopPlans } from './loop-model.js'
import { mintClosureEnvPlans } from './closure-plan.js'
import { mintRepresentationPlan, representationHostBoxesParam, representationProgramHasBigint, representationResultRawBigint, representationResultTagRequired, representationReturnAction } from './representation-plan.js'
import { mintTypedStoragePlan } from './typed-storage-plan.js'
import { narrowBoundedSquare } from './loop-square.js'
import { specializeUnionCursorParams } from './narrow.js'
import { cloneRep } from '../param-reps.js'
import { unrollRecurrence, unrollScalarChains, selectArmUpdatesIn } from './loop-recurrence.js'
import { peelClampedStencil } from './peel-stencil.js'
import { cseLoads } from './cse-load.js'
import {
  scanDynClosureTableCandidates, recordParamClosureDefault, recordDirectReturnClosure, resolveDynFnTables,
  scanClosureTableLatticeCandidates, scanImperativeClosureTableLatticeCandidates,
} from './dyn-closure-tables.js'


// Monotonic across all functions so a CSE temp never collides (even after later
// inlining). Per-compile (ctx.transform.cseId, reset in ctx.reset — the
// freshLoopId pattern): a module-level counter made warm-process WAT text
// history-dependent (`cse0/1` then `cse2/3` for the same program).
const freshCseName = () => `${T}cse${ctx.transform.cseId++}`
import { emit, emitter, emitVoid, emitBlockBody, emitIdentitySafe, resolveClosureTableParamLattice } from './emit.js'
import { emitCharDecompPrologue, JSS_IMPORT_SIGS } from '../abi/string.js'
import {
  typed, asF64, asI32, asPtrOffset, asParamType, toI32, asI64, fromI64, ptrTypeEq,
  NULL_NAN, UNDEF_NAN, NULL_WAT, UNDEF_WAT, NULL_IR, UNDEF_IR, nullExpr, undefExpr,
  MAX_CLOSURE_ARITY,
  mkPtrIR,
  isLit, litVal, isNullishLit, emitNum,
  temp,
  isConst, boxedAddr, readVar, writeVar, isNullish, isUndef,
  slotAddr, elemLoad, elemStore, arrayLoop, allocPtr,
  multiCount, loopTop, flat, reconstructArgsWithSpreads,
  valKindToPtr, findBodyStart, tcoTailRewrite,
  boolBoxIR,
  I32_MIN, I32_MAX, dollar,
  carrierF64,
  applyBigintRepresentationAction,
  freshId,
  dollarMap, setDollarMap,
} from '../ir.js'
import plan from './plan/index.js'
import { foldStaticConstAggregates } from './plan/literals.js'
import {
  buildStartFn, dedupClosureBodies, finalizeClosureTable,
  pullStdlib, syncImports, optimizeModule, stripStaticDataPrefix, hoistConstGlobalInits, stripDeadLazyTables, stripDeadInternedSpans,
  stripLocalRenameSuffixes,
  stdlibParseCacheMap, setStdlibParseCacheMap,
} from '../wat/assemble.js'
import { instrumentHelperCallsites } from '../helper-counters.js'

// =============================================================================
// Single-source export semantics
// =============================================================================
// Two distinct concepts that callers used to conflate:
//
//   1. `f.exported`  — *syntactic* inline-export form, snapshot at `defFunc`
//      time (prepare.js). True iff the func decl carried the inline `export`
//      keyword AND `ctx.funcs.exports[name]` was already populated by parent
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
  for (const val of Object.values(ctx.funcs.exports)) {
    if (val === f.name) return true
  }
  return false
}

/** Collect JS-visible export names that resolve to `funcName` (as an array).
 *  Used to emit per-export ABI metadata in custom sections — one entry per
 *  JS-visible name, since the host (interop.js wrap) keys by export name. */
function exportNamesOf(funcName) {
  const names = []
  for (const [key, val] of Object.entries(ctx.funcs.exports)) {
    if ((val === true && key === funcName) || val === funcName) names.push(key)
  }
  return names
}

const timePhase = (profiler, name, fn) => profiler?.time ? profiler.time(name, fn) : fn()

// Per-compile func name set + map live on ctx.funcs.names / ctx.funcs.map,
// populated at compile() entry. Both reset by ctx.js reset() and re-filled here.

// Low-level IR helpers previously lived here. Pure ones moved to src/ir.js;
// emit-calling ones (toBool, emitTypeofCmp, emitDecl, materializeMulti,
// buildArrayWithSpreads) moved to src/emit.js.

// AST-analysis primitives live in kind.js, type.js, static.js, program-facts.js.

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
  if (!isExported(func) || func.raw) return false
  // Multi-value return: every lane is an f64 NaN-box carrier (the `return [a,b,…]` emit forces
  // asF64 per lane; result narrowing only touches single-result funcs), so any lane may hold a
  // box whose NaN payload JSC/V8 erases at the boundary — wrap to i64-carry every lane.
  if (func.sig.results.length !== 1) return true
  if (func.sig.results[0] !== 'f64' || func.sig.ptrKind != null) return true
  // Any result that isn't a proven plain number can be a NaN-box — a heap pointer,
  // a null/undef/bool atom, a bigint carrier, or a dynamic value — so it crosses as
  // i64 and JSC (Safari) can't canonicalize the payload away. A proven-number result
  // stays f64: free, and a number is never a NaN-box. `_resultNumeric` is set in
  // analyzeFuncForEmit (covers value-bound arrows narrowValResults skips).
  if (!func._resultNumeric) return true
  // Number result, but a param may still carry a box — a pointer-ABI param, or a
  // dynamic f64 param flagged `boundaryI64` during analyze — so wrap for i64 params.
  return func.sig.params.some(p => p.type !== 'f64' || p.ptrKind != null || p.boundaryI64)
}

// Static-string intern index (the `internStrings` pass). Open-addressing table
// over the deduped static string literals (5–32 bytes): [hash u32][ptr u32]
// pairs appended to the data segment, FNV-1a matching __str_hash's heap branch.
// __str_slice/__str_slice_view probe it so a runtime substring whose content
// equals any source literal returns the CANONICAL static pointer — string
// equality then short-circuits on bit-eq instead of walking bytes (a compiler
// or parser compares each token against tag literals many times; ~25% of
// self-compile compile time was __str_eq/__eq/__str_hash volume). Built before
// pullStdlib (the slice thunks emit the probe only when `__internBase` exists);
// stripStaticDataPrefix shifts the stored ptr slots like every other static
// reference. Misses cost one FNV + one probe per slice; the table is read-only.
function buildInternTable() {
  const cfg = ctx.transform.optimize
  if (!cfg || cfg.internStrings === false) return
  if (ctx.memory.shared || !ctx.runtime.dataDedup?.size) return
  const enc = new TextEncoder()
  const entries = []
  // buildStartFn's schema-table construction (the only reclaimSpans producer that
  // can have already run by this point — __throw_property_nullish/__err_prop's
  // spans are pushed later, inside pullStdlib, well after this function returns)
  // may have interned strings that stripDeadInternedSpans later truncates off the
  // data-segment tail once real reachability is known. This probe table is raw
  // bytes baked straight into the data segment — there is no going back to edit a
  // slot out of it once written — so a reclaimable string must never earn one: a
  // stale slot's candidate offset would sit past the (now correspondingly
  // shrunk) memory bound, and the in-wasm probe (module/string.js's
  // internProbeWat) reads the candidate's length header before it ever compares
  // bytes, so a hash COLLISION alone — no matching runtime string required —
  // would be a genuine out-of-bounds trap, not just a wasted probe.
  const inReclaimSpan = (off) => (ctx.runtime.reclaimSpans || []).some(s => off >= s.start && off < s.end)
  for (const [str, off] of ctx.runtime.dataDedup) {
    if (inReclaimSpan(off)) continue
    const b = enc.encode(str)
    if (b.length < 5 || b.length > 32) continue
    let h = 0x811c9dc5 | 0
    for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193) | 0
    if (h <= 1) h = (h + 2) | 0   // mirror __str_hash's empty/tombstone clamp
    entries.push([h >>> 0, off + 8])
  }
  if (!entries.length) return
  let size = 4
  while (size < entries.length * 2) size = (size * 2) | 0
  const mask = size - 1
  const slots = new Uint32Array(size * 2)
  for (let e = 0; e < entries.length; e++) {
    const h = entries[e][0], off = entries[e][1]
    let i = h & mask
    while (slots[i * 2 + 1] !== 0) i = (i + 1) & mask
    slots[i * 2] = h
    slots[i * 2 + 1] = off
  }
  dataAlign(8)
  const base = dataLen()
  // Parts-array + single join, NOT `s += chunk`: a member-free `+=` still
  // fresh-copies the whole accumulated string per iteration in the kernel
  // (no rope strings), and `slots.length` runs into the tens of thousands on
  // a self-compile — measured 207.6 MB / 39,216 $__str_concat_raw calls of
  // Window-A churn (.work/research.md §elephant attribution). Same
  // remediation class as the ctx.runtime.data parts-array and the dedup
  // rolling-hash fixes.
  const parts = []
  for (let i = 0; i < slots.length; i++) {
    const v = slots[i]
    parts.push(String.fromCharCode(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF))
  }
  dataPush(parts.join(''))
  ctx.runtime.internTable = { base, size }
  declGlobal('__internBase', 'i32', base, { mut: false })
  declGlobal('__internMask', 'i32', mask, { mut: false })
}

const ensureThrowRuntime = (sec) => {
  // A pulled stdlib helper may throw $__jz_err even when no user `throw` set the
  // flag (e.g. __to_num on a Symbol). Detect it from the included stdlib bodies
  // so the $__jz_err tag is always present when something can raise it.
  if (!ctx.runtime.throws && [...ctx.core.includes].some(n => {
    const body = ctx.core.stdlib[n]
    return typeof body === 'string' && body.includes('(throw ')
  })) ctx.runtime.throws = true
  if (!ctx.runtime.throws) return

  if (!ctx.scope.globals.has('__jz_last_err_bits'))
    declGlobal('__jz_last_err_bits', 'i64')
  if (!sec.tags.some(t => Array.isArray(t) && t[0] === 'tag' && t[1] === '$__jz_err'))
    sec.tags.push(['tag', '$__jz_err', ['param', 'f64']])
  if (!sec.tags.some(t => Array.isArray(t) && t[0] === 'export' && t[1] === '"__jz_last_err_bits"'))
    sec.tags.push(['export', '"__jz_last_err_bits"', ['global', '$__jz_last_err_bits']])
}

// Drop the $__jz_err TAG (not the last-err global) when no throw can be CAUGHT.
// ensureThrowRuntime runs before optimizeModule so dead-throw analysis sees the
// tag as live; once opt has finished, an unused tag still forces consumers
// (wasmtime, wasm2c, wabt) to enable the exceptions proposal just to PARSE the module.
//
// When `!userThrows`, every `throw` is compiler-internal (bounds / coercion / type
// errors) and — with no user try/catch — uncatchable IN WASM: nothing inside the
// module inspects the thrown value, so it is semantically a trap there. The
// exceptions proposal is needed only to DECLARE the tag a `throw` references;
// lowering each surviving uncatchable throw to `unreachable` keeps the module in
// the wasm MVP, so every runtime can parse it (V8 alone enables exceptions by
// default, which masked this). A pure-recursion or typed-array kernel (nqueens,
// anything pulling __to_num) thus stops emitting a Tag section it can never use.
// User-written throw/try/catch/finally is an ABI contract (JS-side may inspect
// __jz_last_err_bits), so `userThrows` keeps the tag + exceptions runtime intact.
//
// `__jz_last_err_bits` itself is KEPT (global + export + every `global.set`) even
// on this trap path: it is plain mutable-i64 wasm MVP (no exceptions proposal
// needed to declare or write it), and it is the ONLY signal that survives an
// `unreachable` trap to the host boundary. Every internal throw site writes it
// immediately before its (now-trap) throw, so interop.js's decodeThrown can read
// it out of the trapped instance and resolve the code via err-codes.js — turning
// an otherwise-opaque `RuntimeError: unreachable` into the real ECMAScript error
// class the site models. Stripping this global would make host decode of
// ordinary runtime errors unreachable by construction, so it must stay.
// `noEhAbort` (opts.noEhAbort → --no-eh-abort, index.js): opt-in generalization
// of the trap-lowering above for consumers with NO wasm-exceptions support at
// all (wasm2c, w2c2 — see bench/README's native-lane / lab-row notes). Without
// it, `userThrows` is a coarse proxy: it goes true the moment source has ANY
// `throw` statement, even one with no reachable `try`/`catch` anywhere (e.g. a
// parser's `throw SyntaxError(...)` on malformed input, never caught by
// design) — so a case can carry a live-but-unreachable exceptions tag purely
// because of a bare throw. With the flag, that coarse gate is replaced by the
// SAME hasCatch() scan already below: it still unconditionally bails (no-ops,
// zero behavior change) the instant a real `try_table`/`catch`/`catch_all`
// exists anywhere in the module — so this can never silently turn a genuinely
// CAUGHT throw into a trap. It only unlocks the prune for modules that have
// throws but structurally zero catches, regardless of why userThrows got set.
const pruneUnusedThrowRuntime = (sec) => {
  if (!ctx.runtime.throws) return
  if (ctx.runtime.userThrows && !ctx.transform.noEhAbort) return
  // A catch handler (try_table) means SOME throw is caught; bail unconditionally
  // (with or without noEhAbort) so a caught throw is never silently turned into
  // a trap — this scan is the sole safety net once userThrows no longer gates.
  // Note this also fires for a bare `try { … } finally { … }` with NO catch
  // clause at all: jz's own `finally` codegen still needs an internal
  // try_table/catch(-rethrow) to run the cleanup on the exceptional path, so
  // it is exactly as unsafe to trap-lower as a real user catch. For example,
  // subscript's switch-parsing feature — reachable from the `jessie` bench
  // case even though it has zero `catch` clauses anywhere — uses try/finally
  // for its `inSwitch` depth counter, and this scan correctly refuses to
  // prune it.
  const hasCatch = (n) => Array.isArray(n) &&
    (n[0] === 'try_table' || n[0] === 'catch' || n[0] === 'catch_all' || n.some(hasCatch))
  for (const arr of [sec.funcs, sec.stdlib, sec.start])
    for (const f of arr) if (hasCatch(f)) return
  // Rewrite every surviving `(throw $__jz_err …)` to `(unreachable)` (same polymorphic
  // stack type — a drop-in in any position). The thrown operand is side-effect-free
  // (a local read / const), so dropping it loses nothing. The preceding
  // `(global.set $__jz_last_err_bits …)` at each site is left untouched — see above.
  const lowerThrows = (n) => {
    if (!Array.isArray(n)) return n
    if (n[0] === 'throw') return ['unreachable']
    for (let i = 1; i < n.length; i++) n[i] = lowerThrows(n[i])
    return n
  }
  for (const arr of [sec.funcs, sec.stdlib, sec.start])
    for (let i = 0; i < arr.length; i++) arr[i] = lowerThrows(arr[i])
  sec.tags = sec.tags.filter(t => !(Array.isArray(t) &&
    (t[0] === 'tag' && t[1] === '$__jz_err')))
}

// === Module compilation ===

// Routes through cloneRep (param-reps.js) — the authoritative deep clone: a
// bare `{ ...v }` shallow-copies Set-valued lattice fields, so a later join
// on the copy would silently mutate the source map's rep. `map` here is
// `ctx.func.localReps` (ValueRep records) — cloneRep's REP_SET_FIELDS list
// (param-reps.js) covers its `dictValueValType`/`mapValueValType` Sets
// alongside paramReps' `possibleKinds`.
const cloneRepMap = map => {
  if (!map) return null
  const out = new Map()
  for (const [k, v] of map) out.set(k, cloneRep(v))
  return out
}

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

// Replace the complete active-function authority at a real function boundary.
// Top-level funcs start `uniq` at 0; closures pass a higher base so their
// synthetic labels cannot collide with the displaced parent frame.
function enterFunc(sig, body, options = {}) {
  return enterActiveFunction(ctx, { sig, body, ...options })
}

// Allocate + null-init a heap cell for every boxed local that isn't seeded
// from an incoming param/capture value. Registers the cell as an i32 local
// and marks the name preboxed; `isSeeded(name)` skips the already-seeded.
function emitPreboxedLocalInits(isSeeded) {
  const inits = []
  for (const [name, cell] of ctx.func.boxed) {
    if (isSeeded(name)) continue
    ctx.func.locals.set(cell, 'i32')
    ctx.func.preboxed.add(name)
    inits.push(
      ['local.set', `$${cell}`, ['call', '$__alloc', ['i32.const', 8]]],
      ['f64.store', ['local.get', `$${cell}`], nullExpr()])
  }
  return inits
}

function analyzeFuncForEmit(func, programFacts) {
  const { paramReps } = programFacts
  if (func.raw) return null

  // Strength-reduce per-iteration `i % w` / `(i/w)|0` to incremental i32 counters
  // (idempotent: a reduced loop has no modulo left to match). Before analyze so the
  // counters are typed/narrowed like any i32 local. Off at L0 / `loopIVDivMod:false`.
  const _o = ctx.transform.optimize
  if (_o && _o.loopIVDivMod !== false && isBlockBody(func.body)) func.body = strengthReduceLoopDivMod(func.body)
  // Bounded-square narrowing: `i*i` under an `i*i < CONST` (CONST ≤ 2³⁰) guard → Math.imul,
  // so the sieve's product/counter chain carries i32 instead of f64. Before analyze so the
  // Math.imul typed/narrows like any i32. Off at L0 / `loopSquare:false`.
  if (_o && _o.loopSquare !== false && isBlockBody(func.body)) func.body = narrowBoundedSquare(func.body)
  // Array-recurrence unroll: a unit-stride DP/scan that reads arr[j-1] and writes arr[j] carries
  // its value through memory (store→load) and re-pays loop overhead per cell — both of which V8
  // hides but Cranelift/baseline don't. Scalar-replace the recurrence + unroll ×2 (clang's fix).
  // Off at L0 / `unrollRecurrence:false`.
  if (_o && _o.unrollRecurrence !== false && isBlockBody(func.body)) func.body = unrollRecurrence(func.body)
  // Serial-chain ×2 unroll (crc/hash class): an address-carried scalar makes the
  // loop non-vectorizable, so pairing iterations halves loop overhead with no
  // recognizer downstream to blind. Speed/L3 only (`unrollScalarChain: true`).
  if (_o && _o.unrollScalarChain === true && isBlockBody(func.body)) func.body = unrollScalarChains(func.body)
  // Disjoint-arm update chains → branchless select accumulation (the square-
  // tracing direction-step class: data-dependent arm choice defeats prediction).
  if (_o && _o.selectArmUpdates === true && isBlockBody(func.body)) func.body = selectArmUpdatesIn(func.body)
  // Edge-clamp peeling: split a clamped stencil loop into clamp-free interior + edges
  // (the interior then lifts to SIMD). Before analyze so the new loops are analyzed.
  if (_o && _o.clampPeel !== false && isBlockBody(func.body)) func.body = peelClampedStencil(func.body)

  const { name, body, sig } = func
  const previousFrame = enterFunc(sig, body, { exported: func.exported })
  try {

  const block = isBlockBody(body)
  ctx.func.boxed = new Map()
  // Fresh per function — analyze-scans.js's boxedCaptures (called below, once
  // `block` is confirmed) populates capturedNames; emitDecl consults it for
  // the identity-safe closure-capture shadow (kind.js hasAmbiguousBoolMerge).
  // identityShadow is emitDecl's OWN output (name → shadow local), read back
  // by module/function.js's ctx.closure.make at the env-slot store. Both
  // must reset here — ctx.func is a persistent, per-session object mutated
  // in place across functions (createActiveFunction, src/ctx.js), never
  // freshly allocated per function — so a stale Map/Set from a sibling
  // function would otherwise leak forward.
  ctx.func.capturedNames = new Set()
  ctx.func.identityShadow = new Map()
  ctx.func.localReps = null
  ctx.func.leanHashLocals = new Set()
  ctx.func.i32HashLocals = new Set()
  ctx.func.leanHashDomains = new Map()
  ctx.func.hoistTempDefs = null
  // MapOverlay (see emitClosureBody's own doc for the same fix applied to a
  // sibling site) avoids an O(programSize) full clone of `new Map(ctx.scope.
  // globalTypedElem)`/`new Map(ctx.scope.globalTypedLen)` paid PER FUNCTION
  // (analyzeFuncForEmit runs once per function in ctx.func.list — thousands
  // for a bundled multi-module program). `globalTypedElem`/`globalTypedLen`
  // must be frozen module-scope tables by this point (last written during
  // infer.js/plan/scope.js's own passes and the pendingTypedLens sweep, all
  // upstream of plan(), with no write site downstream of here) so overlaying
  // a live reference as `base` is safe: it can never go stale mid-loop. `own`
  // starts empty; the param-typedCtor seeding just below writes into it via
  // `.set` exactly like the pre-overlay code did.
  ctx.func.typedElem = ctx.scope.globalTypedElem ? makeMapOverlay(ctx.scope.globalTypedElem) : null
  // typedLen mirrors typedElem's per-function lifecycle EXACTLY — a stale entry from a
  // sibling function's same-named local would prove a wrong bound (names are per-function).
  ctx.func.typedLen = ctx.scope.globalTypedLen ? makeMapOverlay(ctx.scope.globalTypedLen) : null

  const _reps = paramReps.get(name)
  if (_reps) {
    for (const [k, r] of _reps) {
      if (k >= sig.params.length) continue
      const pname = sig.params[k].name
      // r.val/r.typedCtor describe the CALLER's argument — the param's value AT
      // ENTRY, before this function's own body runs. A param the body reassigns
      // (`opts = normalize(opts)`) no longer necessarily holds that entry-time
      // kind past the write, so seeding it here is only sound when the body
      // never writes the name. Without this guard the stale entry-time kind
      // stands unchallenged: analyzeBody's OWN valType tracker (below, `bodyFacts.
      // valTypes`) starts with no memory of this pre-seeded value (it's a fresh
      // Map, not the shared ctx.func.localReps store), so when the reassignment's
      // RHS type can't be resolved (e.g. a call to a function whose own valResult
      // never converges), makeValTracker's poison path requires a PRIOR value
      // in ITS OWN map to fire — there isn't one — so it neither confirms nor
      // invalidates the seed, and the merge loop below never touches the name at
      // all. A hardcoded-wrong kind then rides every read of that binding for the
      // rest of the function (watr's own `optimize()`: opts's param-fact kind is
      // VAL.OBJECT from callers that pass object literals; `opts = normalize(opts)`
      // reassigns it to normalize's actual return — a HASH in the schema-less-
      // spread shape — but the stale OBJECT kind survives, so `emitTypeTag` bakes
      // a hardcoded `(i32.const PTR.OBJECT)` tag into `opts.inlineOnce`'s dyn-get
      // dispatch instead of reading the receiver's true runtime tag, and the probe
      // walks a schema this HASH was never shaped as — a silent miss, not a trap).
      const reassigned = isReassigned(body, pname)
      if (r.typedCtor && !reassigned) {
        if (!ctx.func.typedElem) ctx.func.typedElem = new Map()
        if (!ctx.func.typedElem.has(pname)) ctx.func.typedElem.set(pname, r.typedCtor)
        updateRep(pname, { val: VAL.TYPED })
        // Unanimous static length from the call sites (validateTypedLenParams:
        // module-local callee, never-written param, settled ctor) — the body's
        // reads gain the static-length proof family, `.length` folds literal.
        if (r.typedLen != null) {
          if (!ctx.func.typedLen) ctx.func.typedLen = new Map()
          if (!ctx.func.typedLen.has(pname)) ctx.func.typedLen.set(pname, r.typedLen)
        }
      }
      if (r.val && !reassigned && !ctx.func.localReps?.get(pname)?.val) updateRep(pname, { val: r.val })
      // presentVal (§16→§18 "presentVal param producers") — narrow.js's
      // inter-procedural hardParamPresentVal fold (mirroring hardParamVal's
      // own poison-on-disagreement discipline, NOT mayBeUndefined's monotonic
      // boolean OR further below). An EXACT KIND claim, same "mutually
      // exclusive with val, same discipline as val" contract reps.js's own
      // presentVal doc establishes — so it gets the SAME `!reassigned` guard
      // as `r.val` directly above, for the identical reason (a body write
      // past entry invalidates the entry-time claim; analyzeValTypes' own
      // `setPresentVal` tracker settles the post-write truth independently,
      // starting fresh).
      if (r.presentVal && !reassigned && !ctx.func.localReps?.get(pname)?.presentVal) updateRep(pname, { presentVal: r.presentVal })
      // recvArrTyped: same reassignment hazard as r.val (an entry-time class proof
      // doesn't survive a body write) — module/array.js's unproven-receiver numeric-
      // key guard reads this to skip its runtime ptrTypeEq test (reps.js doc).
      if (r.recvArrTyped && !reassigned) updateRep(pname, { recvArrTyped: true })
      if (r.arrayElemSchema != null) updateRep(pname, { arrayElemSchema: r.arrayElemSchema })
      // Closed-union param facts ride the lattice as canonical 'a,b,…' keys.
      if (typeof r.arrayElemSchemaSet === 'string')
        updateRep(pname, { arrayElemSchemaSet: r.arrayElemSchemaSet.split(',').map(Number) })
      if (typeof r.schemaIdSet === 'string' && !reassigned)
        updateRep(pname, { schemaIdSet: r.schemaIdSet.split(',').map(Number), val: VAL.OBJECT })
      // Proven-possible maybe-miss arg (narrow's veto): the UNDEF box can
      // arrive, so this param's arithmetic coerces (undefined → NaN) and its
      // nullish compares stay live. Targeted — unknown-caller params keep the
      // cheaper nullable-only treatment below.
      // (nullable only: rep-level `missArg` had no reader and isn't a REP_FIELD —
      // the maybe-miss distinction lives in the param lattice, not the ValueRep.)
      if (r.missArg) updateRep(pname, { nullable: true })
      if (r.arrayElemValType != null) updateRep(pname, { arrayElemValType: r.arrayElemValType })
      if (r.arrayElemRange != null) updateRep(pname, { arrayElemRange: r.arrayElemRange })
      if (r.arrayLen != null) updateRep(pname, { arrayLen: r.arrayLen })
      if (r.intConst != null) updateRep(pname, { intConst: r.intConst })
      // Cross-function never-relocation proof (analyzeParamNeverGrown) — the
      // raw-base array read (module/array.js arrBase) keys off this rep.
      if (r.neverGrown) updateRep(pname, { neverGrown: true })
      // mayBeUndefined (Slice 2, .work/todo.md §deletion-sweep
      // §3) — narrow.js's inter-procedural join already proved this param's
      // ENTRY value can be a census-shaped read at some live call site.
      // Unconditional (no `!reassigned` guard, unlike r.val/r.recvArrTyped
      // just above): this is a safe-direction, monotonic fact like `nullable`
      // (the caller-side nullability block right below seeds THAT one the
      // same unconditional way) — never an exact-kind claim a stale seed
      // could make wrong, only ever an extra soundness carve-out a stale seed
      // makes unnecessary. A body write the fixpoint couldn't see keeps the
      // flag one step more conservative than strictly needed; per the
      // design's own fail-closed direction that's the safe side to be wrong on.
      // `presence` mirrors mayBeUndefined's own stamp here — 'maybe-undef',
      // the only state this paramReps-sourced fact can prove (a param's
      // positive-presence proof, if any, is a body-local decl question the
      // caller-side join below has no view into).
      if (r.mayBeUndefined) updateRep(pname, { mayBeUndefined: true, presence: 'maybe-undef' })
    }
  }
  // Caller-side nullability: a NO-DEFAULT param observes the UNDEF pad whenever a
  // site omits its position (narrow's missing rule poisons r.val) or when callers
  // are unknown (exported / value-used — no fact at all). A later body write
  // (`nbar = 4` inside `if (nbar == null)`) sets val=NUMBER, which used to
  // constant-fold the very null-check guarding it — under-arity callers then read
  // the raw UNDEF box as NaN (window-function's taylor manual-default idiom).
  // `nullable` only suppresses the nullish-compare FOLD; arithmetic typing keeps.
  // `r.nullable` alongside a SETTLED val is narrow.js's BIGINT re-derivation:
  // a `c ? BigInt(x) : null` site proves the kind yet still passes null — the
  // callee's `x == null` sentinel must stay a live bit-compare.
  {
    const restIdx = func.rest ? sig.params.length - 1 : -1
    for (let k = 0; k < sig.params.length; k++) {
      if (k === restIdx) continue                       // rest arrays are never undefined
      const pname = sig.params[k].name
      if (func.defaults?.[pname] != null) continue      // default fires on the UNDEF pad
      const r = _reps?.get(k)
      if (!r || r.val == null || r.nullable) updateRep(pname, { nullable: true })
    }
  }
  // Trust numeric export params. An exported f64 param used only in numeric
  // positions is marked VAL.NUMBER so its uses skip the `__to_num` coercion
  // entirely (not just hoist it). External callers reach jz through interop's
  // `mem.wrapVal`, which passes a JS number straight to f64 — so the coercion
  // only ever fired for a *string* arg to a numeric param (a type misuse). When
  // that lone coercion is the only `__to_num` consumer, dropping it lets the whole
  // ToNumber string-parse dep tree (`__to_str`→`__itoa`/`__toExp`/`__mkstr`/…)
  // treeshake away — a ~4× module shrink that, decisively, lets V8 tier the hot
  // fill loop up properly (the bloated module JITs the *identical* loop ~2× slower).
  // Block AND expression bodies: value-bound arrows (`export let f = (a,b) => a*b`) are
  // skipped by narrowValResults, so without trusting their params here they'd fall to the
  // i64 boundary carrier. The closure path runs the same proof at line ~1300.
  if (func.exported) {
    for (const p of sig.params) {
      if (p.type === 'f64' && p.ptrKind == null && !p.jsstring
          && !func.defaults?.[p.name] && !ctx.func.boxed?.has(p.name)
          && !ctx.func.localReps?.get(p.name)?.val
          // Numeric either by PROOF (ToNumber-forcing uses) or by the export
          // boundary contract (never used as a string → wrapVal guarantees a
          // number). The latter catches `acc + cre` float kernels whose `+` would
          // otherwise pull a per-iteration string-concat fork (julia, floatbeats).
          && (paramAllUsesNumeric(body, p.name) || paramNeverString(body, p.name)))
        updateRep(p.name, { val: VAL.NUMBER })
    }
  }
  // Sound load-CSE: cache a repeated pure typed-array load `arr[idx]` when every intervening
  // store writes a provably-different element (idx2 ≠ idx). Recovers the fft butterfly's redundant
  // `re[a]` load. Before analyze so the introduced temp is typed/narrowed like any local.
  // mapOrOverlaySize (not `.size` directly): ctx.func.typedElem is now a MapOverlay
  // when globalTypedElem exists (the clone-elimination fix above) — see its own doc.
  if (_o && _o.loadCSE !== false && block && mapOrOverlaySize(ctx.func.typedElem))
    cseLoads(body, n => ctx.func.typedElem.has(n), freshCseName)

  if (block) {
    seedLocalIntConsts(body)
  }
  // A plain analyzeBody read, not a forced reanalyzeBody (walk-count design
  // B1, .work/walk-count-design.md §2.4/§5 item 3): narrowSignatures may
  // have cached this body's locals slice before our pre-seed, when params
  // still had no inferred VAL.TYPED — but analyzeBody's own live
  // sigFingerprint gate now catches that mismatch on the read itself and
  // recomputes, so this call no longer needs to unconditionally invalidate
  // first. Re-walks with reps in place exactly when the cache can't be
  // trusted, not on every emit.
  const bodyFacts = block ? analyzeBody(body) : null
  ctx.func.locals = bodyFacts ? bodyFacts.locals : new Map()
  if (bodyFacts?.valTypes) {
    // A PARAMETER name has no `let`/`const` declaration node inside body for
    // analyzeBody's own tracker to seed a baseline "unknown" observation from
    // (makeValTracker's poison logic needs a PRIOR value in ITS OWN map to
    // detect a conflict — see that function's doc). So when a parameter is
    // reassigned only CONDITIONALLY (`if (typeof opts === 'string' && …) opts
    // = { profile: … }` — watr's own normalize()), the tracker's first (and
    // only) observation is that ONE branch's type, with no competing
    // observation for the other, equally-reachable path where the param keeps
    // its original, caller-supplied value — a path this walk never visits
    // because there's no assignment node ON it to visit. The merge below would
    // then adopt the conditional branch's type as if it held on EVERY path.
    // Trust it only when the param's own call-site-proven entry type (_reps,
    // the fixpoint-settled cross-call-site fact — unlike this per-body walk,
    // it already answers "what can this param be at entry, always") agrees:
    // if it does, both the reassigned and the original-value paths carry the
    // same kind, so unconditional-adoption is sound; if it's absent or
    // different, the conditional branch's type does NOT generalize and must
    // not override the (correctly) unresolved entry-time kind.
    const paramIdx = block ? new Map(sig.params.map((p, i) => [p.name, i])) : null
    for (const [name, vt] of bodyFacts.valTypes) {
      if (paramIdx?.has(name)) {
        const entryVal = _reps?.get(paramIdx.get(name))?.val
        if (entryVal !== vt) continue
      }
      updateRep(name, { val: vt })
    }
  }
  // Never-relocated array bindings — the `[]` reader skips the forwarding follow.
  if (bodyFacts?.neverGrown) for (const name of bodyFacts.neverGrown) updateRep(name, { neverGrown: true })
  // Proven uint32 accumulator locals — readVar tags reads `.unsigned` so the
  // f64 round-trip widens with convert_i32_u (not _s).
  if (bodyFacts?.unsignedLocals) for (const n of bodyFacts.unsignedLocals) updateRep(n, { unsigned: true })
  // SRoA flat-object bindings — `let o = {...}` dissolved into `o#i` field
  // locals. Consumed by the codegen flat hooks (emitDecl, `.`/`[]` read+write).
  ctx.func.flatObjects = bodyFacts ? bodyFacts.flatObjects : new Map()
  // No-copy slice views — `let t = s.slice(...)` bindings proven non-escaping.
  // Consumed by emitDecl to lower the initializer to a SLICE_BIT view.
  ctx.func.sliceViews = bodyFacts ? bodyFacts.sliceViews : new Set()
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
  // analyzeBody's locals slice (line above bodyFacts) ran BEFORE inferLocals
  // bound elem-alias schema ids (`const p = ps[i]` → p.schemaId via
  // analyzeValTypes). With strict-int32 slots in the program, re-derive the
  // widths so exprType's slotI32CertainAt consult resolves through p — then
  // `const x = hitX ? p.x : nx` declares i32 and the raw i32 slot load lands
  // without an f64 round-trip. Gated: programs without strict slots skip the
  // extra walk.
  if (block && ctx.schema.slotI32Certain?.size) {
    ctx.func.locals = reanalyzeBody(body).locals
  }
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
          const aux = typedElemAux(ctx.func.typedElem?.get(n))
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
  for (const p of sig.params) {
    if (p.jsstring) updateRep(p.name, { carrier: 'jsstring', val: VAL.STRING })
  }

  // CSE-safe load bases — pointer locals whose memory reads `cseScalarLoad`
  // may scalar-replace. Computed last: needs every `let`/param ptrKind in place.
  const cseLoadBases = block
    ? cseSafeLoadBases(body, ctx.func.locals, ctx.func.localReps)
    : new Set()

  // P1 predictor (slice 4): plan-time ptrKind inheritance for alias-init decls
  // (the reassigned ping-pong class unboxablePtrs rejects). AFTER cseLoadBases
  // for strict parity with the retired emit-time write, which also ran after
  // cse planning. Emit asserts agreement under JZ_DEBUG_INVARIANTS.
  if (block) inheritPtrAliases(body, ctx.func.locals, ctx.func.boxed)

  // Closure-capture narrowing: a boxed var whose every defining RHS — owner
  // body AND nested arrows — is integer-valued keeps its CELL in i32, so
  // readVar/writeVar skip the f64↔i32 round-trip per access. Params are
  // excluded: their cell is seeded from the raw f64 param value, which would
  // desync an i32-read cell. Same asm.js-style range contract as plain
  // intCertain locals.
  //
  // `ctx.func.localReps.get(name).intCertain` (forward-propagated in analyze.js
  // via the plain, single-arg `intCertainMap(body)`) only sees defs in THIS
  // scope's own top level — correct for an ordinary local (it can't be
  // assigned from inside a nested arrow without becoming a capture) but blind
  // to the writes that make a name "boxed" in the first place: `let env = 0;
  // let set = () => { env = 1.5 }` has no top-level def contradicting `env`'s
  // integer init, so it read back intCertain=true and the cell stayed i32,
  // silently truncating every closure-body float write. Recompute instead with
  // `capturedNames` — collectIntDefs' arrow-descending mode — scoped to just
  // the boxed names, so their nested-arrow write sites join the SAME fixpoint.
  const cellTypes = new Set()
  const boxedNames = new Set(ctx.func.boxed.keys())
  if (boxedNames.size) {
    const capturedIntCertain = intCertainMap(body, boxedNames)
    for (const name of boxedNames) {
      if (sig.params.some(p => p.name === name)) continue
      if (capturedIntCertain.get(name) === true) cellTypes.add(name)
    }
  }

  // Snapshot each param's JS-boundary carrier while reps are live — synthesizeBoundaryWrappers
  // runs after they're torn down. A dynamic f64 param crosses as i64 (the carrier JSC can't
  // canonicalize) iff it can hold a NaN-box, i.e. it isn't proven numeric. Numeric (NUMBER /
  // BOOL → 0/1) params keep f64; pointer-ABI (ptrKind, type i32) and jsstring params are
  // classified directly in the wrapper, so leave their flag false here.
  if (isExported(func)) for (const p of sig.params) {
    if (p.jsstring || p.ptrKind != null || p.type !== 'f64') { p.boundaryI64 = false; continue }
    const rv = ctx.func.localReps?.get(p.name)?.val
    p.boundaryI64 = rv !== VAL.NUMBER && rv !== VAL.BOOL
  }

  // Result-numeric proof for the boundary carrier. Block bodies get func.valResult from
  // narrowValResults; value-bound arrows (`export let f = (a,b) => a*b`) don't, so prove via
  // the return expression(s) with params now trusted numeric. A proven-number f64 result
  // never carries a NaN-box → crosses as plain f64; anything else rides i64 (Safari-safe).
  if (isExported(func)) {
    const rex = returnExprs(body)
    // Void body (falls off → undefined, which callers ignore) keeps the f64 carrier:
    // undefined isn't a reference, so no i64 is needed and wrapping every void export
    // is pure overhead. A non-empty set must be all-NUMBER to stay f64.
    // `censusSafe` (.work/todo.md §deletion-sweep §14) guards BOTH disjuncts below,
    // not just the `valResult == null` one, because `valTypeOf(e)`/`func.valResult`
    // for a bare census-BIGINT node, a `-`/`~` unary wrapping one, or a BINARY
    // arithmetic/bitwise node whose operands `valTypeOfWithLocals` can't locally
    // resolve, falls back to each op's own "unproven → optimistic NUMBER default"
    // (kind.js — numericUnaryVT for the unary family, the arithmetic/bitwise
    // family's own deliberate "unknown → NUMBER" default for `-`/`*`/`/`/`%`/
    // bitwise, load-bearing elsewhere for the closure-table call-site bootstrap,
    // not removable) whenever the operand's exact kind isn't proven. That
    // optimistic default can settle `func.valResult` to a DEFINITE `VAL.NUMBER`
    // (not `null`) for a shape like `let x = m.get(a); let y = m.get(b); return
    // x - y` (both present-key BIGINT census) — without `censusSafe`, that would
    // short-circuit `_resultNumeric = true` on the FIRST disjunct below, never
    // reaching `censusBigintResultShape` at all, skipping the i64 boundary wrap
    // for a value that's genuinely a present-key BigInt at runtime (the raw i64
    // sum's bits misread as a subnormal float, `1e-323` instead of `2n`).
    // `censusBigintResultShape` sources its answer from the census helpers
    // DIRECTLY (dictValueKindOf/mapValueKindOf via censusMaybeUndefinedKind),
    // never through VT/valTypeOf/valResult, so this check stays correct
    // regardless of which optimistic default fired.
    const censusSafe = rex.length === 0 || rex.every(e => censusBigintResultShape(e) === 0)
    func._resultNumeric = censusSafe && (func.valResult === VAL.NUMBER ||
      (func.valResult == null && sig.results[0] === 'f64' && rex.every(e => valTypeOf(e) === VAL.NUMBER)))
  }

  // LoopPlan pre-emission mint (.work/research.md §BodyModel /
  // LoweredLoopPlan): last, so it sees this function's FINAL AST (every loop-
  // AST-rewrite pass above has already run) and maximally-settled `repOf`
  // facts (every updateRep call above has already landed) — the same two
  // preconditions emit.js's own (separately, locally computed) counter/guard
  // range facts enjoy today, just at analyze time instead of emit time.
  mintLoopPlans(body)
  // ClosureEnvPlan pre-emission mint (Slice 1, .work/closure-plan-design.md)
  // — same call site, same "last, sees final AST + settled ctx.func.boxed"
  // guarantee; ctx.closure.make reads astClosurePlan back at each closure
  // literal's own emission.
  mintClosureEnvPlans(body)
  // TypedStoragePlan snapshots the settled receiver/result/storage ctor facts.
  // Every typed emitter consumes this frozen plan rather than re-reading the
  // mutable inference maps with its own priority chain.
  mintTypedStoragePlan(ctx, func, sig, body, ctx.func.localReps)
  // RepresentationPlan v2 Slice 1: freeze semantic kinds, current carriers,
  // normalized targets, and edge actions after every local fact settles.
  if (representationProgramHasBigint(ctx))
    mintRepresentationPlan(ctx, func, sig, body, ctx.func.localReps, {
      exported: isExported(func),
      valResult: func.valResult,
      valResultMayBeUndefined: func.valResultMayBeUndefined,
    })

  const facts = {
    block,
    locals: new Map(ctx.func.locals),
    boxed: new Map(ctx.func.boxed),
    // Captured-anywhere names (analyze-scans.js's boxedCaptures pre-scan) —
    // emitDecl (emit.js) consults this at EMISSION time to gate the
    // identity-safe closure-capture shadow (kind.js hasAmbiguousBoolMerge),
    // but boxedCaptures only ever runs HERE, during analysis. Must cross the
    // same analyze→emit handoff `boxed` above does (function-plan.js's
    // clonePlanData/installFunctionPlan) or it reads back empty every time —
    // ctx.func is a fresh ActiveFunction record per enterFunc call
    // (active-function.js createActiveFunction), not a persistent object, so
    // nothing survives the analysis→emission boundary that isn't explicitly
    // published through the plan.
    capturedNames: new Set(ctx.func.capturedNames || []),
    cellTypes,
    flatObjects: new Map(ctx.func.flatObjects),
    sliceViews: new Set(ctx.func.sliceViews),
    cseLoadBases,
    distinctParams: func.distinctParams || null,
    leanHashLocals: new Set(ctx.func.leanHashLocals || []),
    i32HashLocals: new Set(ctx.func.i32HashLocals || []),
    leanHashDomains: new Map(ctx.func.leanHashDomains || []),
    // Publication forks only the overlay's function-local `own` map and keeps
    // the stable program-wide base by reference. This handoff therefore stays
    // O(function facts), never the retired O(programSize)-per-function clone.
    typedElem: ctx.func.typedElem,
    typedLen: ctx.func.typedLen,
    localReps: cloneRepMap(ctx.func.localReps),
  }
  return facts
  } finally {
    restoreActiveFunction(ctx, previousFrame)
  }
}

function seedLocalIntConsts(body) {
  // Fold each never-reassigned local `const`/`let NAME = EXPR` to a known i32, so a
  // divisor / bound / size built from earlier consts (`rr = R|0; win = 2*rr+1`) becomes
  // a compile-time literal — which lets the int-divide lowering hand the wasm backend a
  // constant divisor to magic-multiply (no runtime sdiv), array bounds resolve, etc.
  // Mirrors the module-scope fold (evalConst above); a string ref resolves through the
  // intConst already recorded on its rep, and the fixpoint lets a later const see an
  // earlier one regardless of declaration order. Skips nested functions (own scope).
  const evalC = (n) => {
    if (typeof n === 'number') return Number.isInteger(n) ? n : null
    if (Array.isArray(n) && n[0] == null && typeof n[1] === 'number') return Number.isInteger(n[1]) ? n[1] : null
    if (typeof n === 'string') return intLiteralValue(n)   // a seeded intConst / literal local
    if (!Array.isArray(n)) return null
    const [op, a, b] = n
    const va = evalC(a); if (va == null) return null
    if (op === 'u-' || (op === '-' && b === undefined)) return -va
    const vb = evalC(b); if (vb == null) return null
    switch (op) {
      case '+': return va + vb; case '-': return va - vb; case '*': return va * vb
      case '&': return va & vb; case '|': return va | vb; case '^': return va ^ vb
      case '<<': return va << vb; case '>>': return va >> vb; case '>>>': return va >>> vb
      default: return null
    }
  }
  const decls = []
  const walk = (node) => {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') return
    if (op === 'let' || op === 'const') {
      for (const decl of args)
        if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string' && !isReassigned(body, decl[1])) decls.push(decl)
      return
    }
    for (const arg of args) walk(arg)
  }
  walk(body)
  const seeded = new Set()
  let changed = true
  while (changed) {
    changed = false
    for (const decl of decls) {
      if (seeded.has(decl[1])) continue
      const value = evalC(decl[2])
      if (value != null && Number.isInteger(value) && value >= I32_MIN && value <= I32_MAX) {
        updateRep(decl[1], { intConst: value }); seeded.add(decl[1]); changed = true
      }
    }
  }
}

// ── Loop-invariant exported-param coercion hoist ────────────────────────────
//
// An exported numeric param arrives as a NaN-box (jz's value ABI), so each use
// in an arithmetic context emits `__to_num(p)`. When the param is never
// reassigned and *every* use is an unconditional-ToNumber arithmetic operand,
// the coercion is loop-invariant: do it once at entry and let every use read the
// already-unboxed f64. This flips a serial recurrence like the de Jong attractor
// (4 `__to_num`/iter × millions) from ~parity to a clear win over V8.
//
// Self-gating: the rewrite only fires when the emitted body ALREADY contains
// `__to_num(p)` calls — meaning the helper is loaded for other reasons (global
// typed-array assigns, strings, …). A provably-numeric program (`(a,b)=>a*b`)
// never loads the helper, has no pattern to match, and is left byte-for-byte
// alone, preserving the minimal-bundle / golden-size guarantee.

// Reassigning the param breaks the coerce-once premise (any write op).
// Binary ops that unconditionally ToNumber BOTH operands, so a bare param operand
// is a pure numeric use. `+` is excluded (may concatenate); `===`/`==` are excluded
// (they branch on type, never coerce a string operand to number).
const NUM_BIN_OPS = new Set(['*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>'])
// Relational ops: jz has no lexicographic compare for an untyped operand — `<`
// lowers to `f64.lt`, taking the string path only when a *known-string* operand
// is present (emit.js cmpOp). So a bare param compared against a non-string is a
// pure numeric use, same as NUM_BIN_OPS. A string-literal counterpart (`x < "m"`)
// signals string intent and is rejected (handled in the walk below).
const REL_OPS = new Set(['<', '<=', '>', '>='])
// A string literal/template operand poisons relational numeric inference.
const isStrLiteral = (n) => Array.isArray(n) && (n[0] === 'str' || n[0] === 'template')

/** True iff every use of param `name` in `body` is numeric-COMPATIBLE *and* at
 *  least one use is numeric-PROVING — so coercing it to a number once at entry is
 *  observationally exact. Two verdict levels guard against a polymorphic slot
 *  passing on absence of evidence:
 *   - PROVING (`proven=true`): arithmetic / relational / bitwise / unary operand —
 *     JS ToNumbers these, and a string/array value would have shown a disqualifying
 *     use elsewhere.
 *   - COMPATIBLE-ONLY: the length slot of `new TypedArray(x)` / `new ArrayBuffer(x)`.
 *     A number sizes the buffer, but an array is COPIED and a buffer VIEWED — so a
 *     bare param here proves nothing. A param used *solely* as `new Float64Array(arr)`
 *     stays unproven and keeps the polymorphic ctor dispatch (else array-copy is lost).
 *  Any other appearance (member/call-arg/return/concat/`===`/reassignment) rejects.
 *  Two transparencies:
 *   - copy aliases: `let x = name` makes `x` carry the same value, so `x`'s uses
 *     must be numeric too (fixpoint-collected). Catches `let T = t` then `…T…`.
 *   - captured closures: a non-shadowing inner arrow captures the binding by
 *     reference, so its body's uses count — we recurse instead of rejecting.
 *     Catches floatbeat helpers `let s=(f)=>…t…` that read the param numerically. */
// requireProof=true (default): the param has a ToNumber-FORCING use (PROVES numeric).
// requireProof=false: the param merely has NO string-requiring use (numeric-COMPATIBLE).
// Forwarding recursions use the latter — a callee receiving the param need only be
// string-free (e.g. fbm's `ph`, used additively inside Math.sin), since the OUTER
// param earns its own proof from its own uses; requiring the callee be self-proven
// wrongly rejected forwards into additive-only params.
function paramAllUsesNumeric(body, name, _seen = new Set(), requireProof = true) {
  if (body == null) return false
  // Local closure defs (`let f = (p,…) => …`) so a call `f(name)` can be judged by
  // f's own param numericity (see the call-arg handler in the walk).
  const closures = new Map()  // name → { params:[string], body }
  // Fixpoint-collect copy aliases: `let/const x = <name-or-alias>`.
  const names = new Set([name])
  for (let grew = true; grew;) {
    grew = false
    const collect = (node) => {
      if (!Array.isArray(node)) return
      if ((node[0] === 'let' || node[0] === 'const') && node.length === 2
          && Array.isArray(node[1]) && node[1][0] === '=' && typeof node[1][1] === 'string') {
        const init = node[1][2]
        if (typeof init === 'string' && names.has(init) && !names.has(node[1][1])) { names.add(node[1][1]); grew = true }
        else if (Array.isArray(init) && init[0] === '=>' && !closures.has(node[1][1])) {
          const ps = Array.isArray(init[1]) ? init[1].slice(1) : [init[1]]   // ['()', p0, p1] → [p0,p1]
          if (ps.every(p => typeof p === 'string')) closures.set(node[1][1], { params: ps, body: init[2] })
        }
      }
      for (let i = 1; i < node.length; i++) collect(node[i])
    }
    collect(body)
  }
  // Locals with a provably-numeric init (`let x = 0`, `let k = -r`): a
  // relational compare against one of these forces its partner numeric.
  const numericLocals = new Set()
  const numericInit = (e) => typeof e === 'number' ||
    (Array.isArray(e) && (e[0] == null ? typeof e[1] === 'number' :
      NUM_BIN_OPS.has(e[0]) || e[0] === 'u-' || e[0] === 'u+'))
  ;(function collectNum(node) {
    if (!Array.isArray(node)) return
    if (node[0] === 'let' || node[0] === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' && numericInit(d[2]))
          numericLocals.add(d[1])
      }
    }
    for (let i = 1; i < node.length; i++) collectNum(node[i])
  })(body)
  let ok = true, proven = false
  // A param in a numeric-operand slot is a PROVING use; recurse into a non-param sub-expr.
  const numOperand = (n) => { if (names.has(n)) proven = true; else walk(n) }
  // Positional call args, flattening the `(, a b c)` node multi-arg calls parse to —
  // without this a forward like `fbm(x, y, t, …)` never matched its param positions.
  const flat1 = (a) => Array.isArray(a) && a[0] === ',' ? a.slice(1).flatMap(flat1) : [a]
  const callArgList = (n) => n.slice(2).flatMap(flat1)
  const walk = (node) => {
    if (!ok) return
    if (typeof node === 'string') { if (names.has(node)) ok = false; return }  // bare use → reject
    if (!Array.isArray(node)) return
    const op = node[0]
    // single `let/const x = init`: x is a binding (not a use). A pure copy of an
    // alias is consumed (already in `names`); otherwise the init must be numeric.
    if ((op === 'let' || op === 'const') && node.length === 2
        && Array.isArray(node[1]) && node[1][0] === '=' && typeof node[1][1] === 'string') {
      const init = node[1][2]
      if (typeof init === 'string' && names.has(init)) return
      walk(init)
      return
    }
    if (op === '=>') {                                  // closure capture: recurse unless shadowed
      const ps = node[1]
      const shadowed = Array.isArray(ps)
        ? ps.some(p => names.has(p) || (Array.isArray(p) && names.has(p[1])))
        : names.has(ps)
      if (!shadowed) { walk(node[1]); walk(node[2]) }   // defaults + body; param names aren't in `names`
      return
    }
    if (MUTATE_OPS.has(op) && names.has(node[1])) { ok = false; return }
    if (NUM_BIN_OPS.has(op) && node.length === 3) {     // numeric binary: operands are ToNumber'd
      numOperand(node[1]); numOperand(node[2])
      return
    }
    // min/max ternary (`x < y ? x : y` — clampPeel synthesizes `__pks = min(r,w)`
    // peel bounds INTO the body before this proof runs): pass-through — the value
    // flows to the ternary's consumer; neither a numeric proof nor a reject.
    // Without this the proof rejected the peel's OWN output as a bare use and
    // un-proved the very params the peel had just relied on.
    if (op === '?:' && Array.isArray(node[1]) && REL_OPS.has(node[1][0]) &&
        ((node[2] === node[1][1] && node[3] === node[1][2]) ||
         (node[2] === node[1][2] && node[3] === node[1][1]))) {
      walk(node[1]); return
    }
    if (REL_OPS.has(op) && node.length === 3) {
      // Relational proof requires a PROVABLY-NUMERIC PARTNER: `x < 0` or
      // `k <= r` (k init `-r`) force ToNumber on the other side, but JS
      // compares two strings lexicographically — `(p, q) => p < q` proves
      // NOTHING about either param's kind. The old unconditional proof
      // stamped watr's hex-string i64 comparators NUMBER and their compares
      // took the raw-f64 path (NaN-boxed pointers compare as NaN → always
      // false), folding i64.lt_s(-1, 0) to 0 in-kernel — the -1n<0n row and
      // the shaped-parser family. Unproven params stay boxed and take
      // cmpOp's runtime string/number dispatch.
      if (isStrLiteral(node[1]) || isStrLiteral(node[2])) { ok = false; return }
      const numericPartner = (e) => typeof e === 'number' ||
        (typeof e === 'string' && numericLocals.has(e)) ||
        (Array.isArray(e) && (e[0] == null ? typeof e[1] === 'number' :
          NUM_BIN_OPS.has(e[0]) || e[0] === 'u-' || e[0] === 'u+' ||
          (e[0] === '.' && e[2] === 'length')))
      const side = (self, other) => {
        if (names.has(self)) { if (numericPartner(other)) proven = true }
        else walk(self)
      }
      side(node[1], node[2]); side(node[2], node[1])
      return
    }
    // `new TypedArray(x)` / `new ArrayBuffer(x)`: the length argument is ToNumber'd
    // on the alloc path, but a pointer arg is copied (array) or viewed (buffer).
    // A bare param in the length slot is numeric-COMPATIBLE but not PROVING — skip it
    // (no reject, no proof); other args walk normally. A param used *solely* as
    // `new Float64Array(param)` thus stays unproven → keeps the polymorphic ctor (so
    // `f(arr)` copies the array instead of mis-sizing a zero buffer).
    if (op === '()' && typeof node[1] === 'string' && node[1].startsWith('new.')
        && (node[1].endsWith('Array') || node[1] === 'new.ArrayBuffer')) {
      for (let i = 2; i < node.length; i++) if (!names.has(node[i])) walk(node[i])
      return
    }
    // Call of a LOCAL closure `f(…name…)`: forwarding the param flows its value into
    // f's positional param. If that param is itself all-numeric (recursively, with a
    // cycle guard), `name` in that slot is numeric-COMPATIBLE — neither rejected nor
    // proving (so a param used *only* as a forwarded arg stays unproven, like the ctor
    // length slot). Unknown / non-numeric callees fall through and reject (a string
    // could flow in). Covers heapsort's `heapify(n)` and crc32's `crc32(buf)`.
    if (op === '()' && typeof node[1] === 'string' && closures.has(node[1]) && !_seen.has(node[1])) {
      const cl = closures.get(node[1])
      const args = callArgList(node)
      for (let i = 0; i < args.length; i++) {
        if (!names.has(args[i])) { walk(args[i]); continue }
        const param = cl.params[i]
        if (param == null || !paramAllUsesNumeric(cl.body, param, new Set([..._seen, node[1]]), false)) { ok = false; return }
      }
      return
    }
    // Same forwarding judgement for a call to a MODULE-LEVEL user function (sibling,
    // not a body-local closure): `frame` passing its param into a helper `fbm(x,y,t,…)`.
    // Without this the bare arg fell through and rejected, leaving an exported numeric
    // param (plasma/raymarcher's `t`) unproven → per-pixel `__to_num` + polymorphic-`+`
    // string forks. Judge by the callee param's own numericity (recursive, cycle-guarded).
    if (op === '()' && typeof node[1] === 'string' && !_seen.has(node[1])) {
      const fn = ctx.funcs.map?.get(node[1])
      if (fn && fn.body && !fn.raw && Array.isArray(fn.sig?.params) && !fn.rest) {
        const args = callArgList(node)
        for (let i = 0; i < args.length; i++) {
          if (!names.has(args[i])) { walk(args[i]); continue }
          const p = fn.sig.params[i]
          if (!p || !paramAllUsesNumeric(fn.body, p.name, new Set([..._seen, node[1]]), false)) { ok = false; return }
        }
        return
      }
    }
    // `Math.f(...)` ToNumbers every argument (Math operates on numbers), so a bare
    // param in any arg slot is a PROVING numeric use — same contract as `*`/`-`.
    // Without this, `Math.sin(t)` rejected the param via the generic-call fallthrough,
    // so a numeric kernel like `Math.sin(tick) + …` lost its NUMBER proof and paid a
    // per-use `__to_num` + a polymorphic-`+` string-concat fork (interference example).
    // The callee is the lowered `math.sin` string at emit time (post-autoload), or the
    // raw `(. Math sin)` member pre-lowering — match both.
    const isMathCall = op === '()' && (
      (typeof node[1] === 'string' && node[1].startsWith('math.')) ||
      (Array.isArray(node[1]) && node[1][0] === '.' && node[1][1] === 'Math'))
    if (isMathCall) {
      const numArg = (a) => { if (Array.isArray(a) && a[0] === ',') { numArg(a[1]); numArg(a[2]) } else numOperand(a) }
      for (let i = 2; i < node.length; i++) numArg(node[i])
      return
    }
    // Binary `+` is overloaded (numeric add | string concat). A string-literal
    // operand means concat intent → reject. Otherwise it is numeric-COMPATIBLE but
    // not self-PROVING (a string param would concat) — recurse the non-param operand
    // and treat a bare param as compatible (neither prove nor reject), exactly like
    // paramNeverString. The numeric proof must still come from a ToNumber-forcing use
    // (`*`, `Math.*`, …); a param used ONLY in `+` stays unproven (sound).
    if (op === '+' && node.length === 3) {
      if (isStrLiteral(node[1]) || isStrLiteral(node[2])) { ok = false; return }
      if (!names.has(node[1])) walk(node[1])
      if (!names.has(node[2])) walk(node[2])
      return
    }
    if (op === '-' && node.length === 2) { numOperand(node[1]); return }  // unary negate
    if (op === '-' && node.length === 3) { numOperand(node[1]); numOperand(node[2]); return }
    // `u-`/`u+` are the normalized unary minus/plus (prepare rewrites `-x`/`+x`); both ToNumber.
    if ((op === 'u-' || op === 'u+') && node.length === 2) { numOperand(node[1]); return }
    if (op === '+' && node.length === 2) { numOperand(node[1]); return }  // unary + = ToNumber
    if (op === '~' && node.length === 2) { numOperand(node[1]); return }
    for (let i = 1; i < node.length; i++) walk(node[i])  // bare param reaching here → rejected above
  }
  walk(body)
  return requireProof ? (ok && proven) : ok
}

// String methods whose receiver MUST be a string — their presence proves the
// param is (sometimes) string and disqualifies the boundary-numeric trust.
const STRING_RECV_METHODS = new Set([
  'charCodeAt', 'charAt', 'codePointAt', 'startsWith', 'endsWith', 'toUpperCase',
  'toLowerCase', 'normalize', 'localeCompare', 'padStart', 'padEnd', 'repeat',
  'trim', 'trimStart', 'trimEnd', 'split', 'match', 'matchAll', 'replace',
  'replaceAll', 'substring', 'substr', 'concat', 'indexOf', 'lastIndexOf',
  'includes', 'slice',
])

/** True iff no use of exported f64 param `name` REQUIRES it to be a string — so
 *  the interop boundary contract (`wrapVal` passes a JS number straight to an f64
 *  param; a string arg is a type misuse already unsupported, returning NaN) makes
 *  it provably numeric. Weaker than `paramAllUsesNumeric`: that PROVES numericity
 *  from ToNumber-forcing ops, this DISPROVES stringness so binary `+` (the common
 *  `accumulator + cre` shape) no longer pessimistically pulls the string-concat
 *  fork into a pure float kernel. Only sound under the export boundary — never use
 *  for locals/closures, whose values can genuinely be strings.
 *
 *  Disqualifying (string-requiring) uses:
 *   - `+` with a string-literal/template operand (`"px" + name`) — concat intent
 *   - a string-receiver method call (`name.charCodeAt(…)`, `name.split(…)`)
 *   - `name[k]` / `name.length` is NOT disqualifying (works on arrays/typed too,
 *     but an f64 param is neither — so a member access means the caller passed a
 *     pointer, out of the f64-number contract; conservatively we reject it)
 *   - passing `name` to a call / returning it / storing into an aggregate: the
 *     value escapes where it could be ToString'd; reject conservatively. */
function paramNeverString(body, name) {
  if (body == null) return false
  let ok = true
  const walk = (node) => {
    if (!ok || node == null) return
    if (typeof node === 'string') { if (node === name) ok = false; return }  // bare escape → reject
    if (!Array.isArray(node)) return
    const op = node[0]
    // Closure capture: recurse into the arrow (params — default-value exprs
    // may reference `name` — and body) unless the arrow's OWN param list
    // shadows `name`, exactly mirroring paramAllUsesNumeric's arrow arm just
    // above in this file. Previously this bailed unconditionally ("handled
    // conservatively (escape)" per the stale comment it replaces) WITHOUT
    // setting `ok = false` — the opposite of conservative: a param used only
    // inside a nested arrow (`{...s, [k]: v}`'s prepare-time computed-key
    // desugaring is exactly this — `((t) => (t[k]=v, t))({...s})`, k free
    // in the arrow) went completely unseen, so `k[…]`/string-concat/method-
    // call uses of it inside the closure never tripped the reject at the
    // `.`/`?.`/`[]`-receiver check or the generic bare-name fallback below.
    // paramNeverString then wrongly returned true, and the exported-param
    // trust optimization (`if (func.exported) …`, above this function's own
    // caller) stamped the param VAL.NUMBER — corrupting every dynamic-key
    // write through it (root-caused via `emitElementAssign`'s idxNumericName
    // trusting that stamp to skip the runtime `__is_str_key` fork).
    if (op === '=>') {
      const ps = node[1]
      const shadowed = Array.isArray(ps)
        ? ps.some(p => p === name || (Array.isArray(p) && p[1] === name))
        : ps === name
      if (!shadowed) { walk(node[1]); walk(node[2]) }
      return
    }
    // `+` (binary): a string-literal/template operand makes it concat → reject.
    // Otherwise the param is in an arithmetic add; recurse the non-name operand.
    if (op === '+' && node.length === 3) {
      if (isStrLiteral(node[1]) || isStrLiteral(node[2])) { ok = false; return }
      for (let i = 1; i <= 2; i++) if (node[i] !== name) walk(node[i])
      return
    }
    // Numeric/relational/bitwise binary + unary: param operand is fine, recurse rest.
    if ((NUM_BIN_OPS.has(op) || REL_OPS.has(op)) && node.length === 3) {
      for (let i = 1; i <= 2; i++) if (node[i] !== name) walk(node[i])
      return
    }
    if ((op === 'u-' || op === 'u+' || op === '~') && node.length === 2) {
      if (node[1] !== name) walk(node[1]); return
    }
    if (op === '-' && (node.length === 2 || node.length === 3)) {
      for (let i = 1; i < node.length; i++) if (node[i] !== name) walk(node[i])
      return
    }
    // min/max ternary — same pass-through as paramAllUsesNumeric (clampPeel's
    // synthesized `__pks = min(r,w)` bounds must not read as a string escape).
    if (op === '?:' && Array.isArray(node[1]) && REL_OPS.has(node[1][0]) &&
        ((node[2] === node[1][1] && node[3] === node[1][2]) ||
         (node[2] === node[1][2] && node[3] === node[1][1]))) {
      walk(node[1]); return
    }
    // Member access / method call on the param → it's a pointer, not an f64 number:
    // reject (out of contract). `.`/`?.`/`[]` with the name as receiver.
    if ((op === '.' || op === '?.' || op === '[]') && node[1] === name) { ok = false; return }
    // `=`/compound reassignment of the param to a non-numeric value: reject if it
    // could become a string. A reassignment makes the param mutable — conservatively
    // require the RHS to be string-free too (recurse), and the target isn't a use.
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(body)
  return ok
}

/** Hoist each eligible param's `__to_num` coercion to a single entry `local.set`,
 *  rewriting per-use calls in `stmts` to a bare typed `local.get`. Mutates
 *  `stmts` in place; returns the prologue inits to splice ahead of the body.
 *  Only fires for params whose coercion appears inside a loop (or ≥2×) — a lone
 *  straight-line coercion isn't worth the rebind. */
function hoistInvariantParamCoercions(stmts, func) {
  const inits = []
  const defaults = func.defaults || {}
  for (const p of func.sig.params) {
    if (p.type !== 'f64' || p.ptrKind != null || p.jsstring) continue
    if (ctx.func.boxed?.has(p.name)) continue
    if (p.name in defaults) continue
    if (!paramAllUsesNumeric(func.body, p.name)) continue
    const pat = (n) => Array.isArray(n) && n[0] === 'call' && n[1] === '$__to_num'
      && Array.isArray(n[2]) && n[2][0] === 'i64.reinterpret_f64'
      && Array.isArray(n[2][1]) && n[2][1][0] === 'local.get' && n[2][1][1] === `$${p.name}`
    let total = 0, inLoop = 0
    const count = (node, depth) => {
      if (!Array.isArray(node)) return
      const d = node[0] === 'loop' ? depth + 1 : depth
      for (let i = 1; i < node.length; i++) {
        if (pat(node[i])) { total++; if (d > 0) inLoop++ }
        else count(node[i], d)
      }
    }
    for (const s of stmts) count(s, 0)
    if (total === 0 || (inLoop === 0 && total < 2)) continue
    const strip = (node) => {
      if (!Array.isArray(node)) return
      for (let i = 1; i < node.length; i++) {
        if (pat(node[i])) node[i] = typed(['local.get', `$${p.name}`], 'f64')
        else strip(node[i])
      }
    }
    for (const s of stmts) strip(s)
    inits.push(['local.set', `$${p.name}`,
      typed(['call', '$__to_num', ['i64.reinterpret_f64', typed(['local.get', `$${p.name}`], 'f64')]], 'f64')])
    inc('__to_num')
  }
  return inits
}

/** Sibling of hoistInvariantParamCoercions for union-CURSOR params (stage 3's
 *  f64 NaN-box carrier): every packed-cell read re-derives the raw cell address
 *  with `i32.wrap_i64(i64.reinterpret_f64($o))`. Strip the repeats to one i32
 *  local bound at entry — a K-field variant then pays one unbox instead of K+1
 *  (and after watr inlines the callee, one per record instead of per read). */
function hoistUnionCursorUnbox(stmts, func) {
  const cursors = ctx.schema.inlineUnionCursors?.get(func.sig)
  if (!cursors) return []
  const inits = []
  for (const p of func.sig.params) {
    if (p.type !== 'f64' || !cursors.has(p.name)) continue
    if (ctx.func.boxed?.has(p.name)) continue
    const pat = (n) => Array.isArray(n) && n[0] === 'i32.wrap_i64'
      && Array.isArray(n[1]) && n[1][0] === 'i64.reinterpret_f64'
      && Array.isArray(n[1][1]) && n[1][1][0] === 'local.get' && n[1][1][1] === `$${p.name}`
    let total = 0
    const count = (node) => {
      if (!Array.isArray(node)) return
      for (let i = 1; i < node.length; i++) { if (pat(node[i])) total++; else count(node[i]) }
    }
    for (const s of stmts) count(s)
    if (total < 2) continue
    const cell = `${p.name}#cell`
    const strip = (node) => {
      if (!Array.isArray(node)) return
      for (let i = 1; i < node.length; i++) {
        if (pat(node[i])) node[i] = typed(['local.get', `$${cell}`], 'i32')
        else strip(node[i])
      }
    }
    for (const s of stmts) strip(s)
    ctx.func.locals.set(cell, 'i32')
    inits.push(['local.set', `$${cell}`,
      ['i32.wrap_i64', ['i64.reinterpret_f64', typed(['local.get', `$${p.name}`], 'f64')]]])
  }
  return inits
}

/**
 * Phase: emit one user function to WAT IR.
 *
 * Reads the published `FunctionPlan` and narrowed `func.sig`; applies scoped
 * schema param bindings during emission so they cannot leak between functions.
 */
function emitFunc(func, functionPlan, programFacts) {
  const { paramReps } = programFacts

  // Raw WAT functions (e.g., _alloc, _clear from memory module)
  if (func.raw) return parseWat(func.raw)

  const { name, body, exported, sig } = func
  const multi = sig.results.length > 1
  const _reps = paramReps.get(name)

  const previousFrame = enterFunc(sig, body, { exported })
  let schemaVarsPrev = null
  try {
  // Escape-boxing gate for return-position BOOL literals/expressions (emit.js
  // 'return'): a func with >= 2 syntactic return statements whose overall
  // valResult ISN'T proven uniformly BOOL may still have individual return
  // tails that ARE statically BOOL (a mixed BOOL|NUMBER — or BOOL|anything —
  // return join). Those callers see this func's result as "dynamic/unknown", and the
  // rest of the compiler already assumes an unknown f64 value carries a
  // boolean as its TRUE_NAN/FALSE_NAN atom (emitStrictEq's BOOL-vs-unknown
  // identity compare, '+'​'s numSide atom ladder, __to_num's atom arms) — so
  // the atom-typed return tail must box to honor that invariant.
  //
  // The >=2-return-statement guard is load-bearing, not cosmetic: a SINGLE
  // return statement whose valType narrowValResults couldn't prove early is
  // NOT evidence of mixing — it's just an early-unprovable UNIFORM result
  // (e.g. Set.has/Map.get's VAL.BOOL kind resolves only once ctx.schema.vars
  // is populated, later than narrowValResults' own pass). An earlier version
  // of this fix gated only on `valResult !== VAL.BOOL` and boxed these too —
  // it broke every single-return Set/Map/array-element boolean read in the
  // test suite: those funcs have no boundary-wrapper code path to UN-box
  // (isBoundaryWrapped's resultDynamic arm just reinterprets bits), so a lone
  // boxed return either surfaced as a decoded JS `true`/`false` where a raw
  // `1`/`0` was the established, separately-pinned contract (test/data.js
  // Set/Map alias tests, test/booleans.js's documented "bare boolean read
  // from a container" gap), or handed NaN straight to an un-wrapped caller.
  // Requiring a SECOND return statement restricts boxing to genuine syntactic
  // joins (≥2 `return` sites in one body) — exactly the boolconst repro's
  // shape — and leaves every real single-return function, provable or not,
  // untouched. ADDITIVE single-return admission (.work/todo.md
  // §deletion-sweep): a single-expression arrow body whose lone return IS itself an
  // ambiguous BOOL-merge (`s => cond ? 1 : false`) is STRUCTURAL evidence of
  // genuine mixing, not "unproven" — categorically unlike the ≥2-return gate's
  // own concern (an early-unprovable UNIFORM result), so it's safe to admit
  // without reopening the reverted broad fix's timing hazard. This was
  // previously out of scope here (returnExprs on a non-block body is always
  // length 1) — see test/kernel-oracle.js's now-flipped s?1:false row.
  //
  // A proven-uniform-BOOL func (valResult === VAL.BOOL) also needs no
  // per-return boxing: its own escape sites (the boundary wrapper's
  // resultBool arm / the closure trampoline's boolResult arm) box the WHOLE
  // result once from valResult. carrierF64 itself is a no-op (byte-identical
  // to the prior asParamType/asF64) for any return whose OWN static valType
  // isn't BOOL, so a genuinely mixed func's NUMBER (or other) arms — and
  // every non-bool-mixed function, period — are untouched either way.
  ctx.func.valResult = func.valResult
  {
    const returns = isBlockBody(body) ? returnExprs(body) : [body]
    ctx.func.mixedAtomReturn = func.valResult !== VAL.BOOL &&
      (returns.length > 1 || (returns.length === 1 && hasAmbiguousBoolMerge(returns[0])))
  }
  // Only this path drains charDecomp prologues (collectParamInits below) —
  // the shape-1b global-receiver decomposition may mint only here.
  ctx.func.charDecompGlobals = true
  // FunctionPlan is an opaque identity; install returns one detached mutable
  // working copy and seeds the complete active record from it. Canonical plan
  // collections never leave function-plan.js.
  const installedPlan = installFunctionPlan(ctx, functionPlan)
  const block = installedPlan.block
  // emitDecl's closure-capture identity shadow (emit.js, ctx.func.
  // identityShadow — name → shadow-local name) is purely an EMISSION-tier
  // fact: minted and consumed entirely within this one emitFunc call (unlike
  // capturedNames above, it has no analysis-time source and needs no plan
  // publication) — but createActiveFunction's baseline record doesn't carry
  // it either, so it must start fresh here, not inherit whatever a sibling
  // function's emission left on a reused field.
  ctx.func.identityShadow = new Map()
  // Derive WAT-node metadata before call-site seeding mutates the active rep
  // map. This preserves the published analysis snapshot's exact semantics.
  const plannedCseLoadBases = installedPlan.cseLoadBases.size
    ? new Set([...installedPlan.cseLoadBases].map(n => `$${n}`)) : null
  const plannedDistinctParams = installedPlan.distinctParams?.size
    ? new Set([...installedPlan.distinctParams].map(n => `$${n}`)) : null
  let plannedStableHeaderNames = null
  if (installedPlan.localReps?.size) {
    const names = new Set()
    for (const [nm, r] of installedPlan.localReps)
      if (r && (r.val === VAL.TYPED || r.neverGrown === true)) names.add(`$${nm}`)
    if (names.size) plannedStableHeaderNames = names
  }
  // Global-table fallback for a plan published before global typed lengths
  // settled. The active record owns the resulting overlay.
  if (!ctx.func.typedLen && ctx.scope.globalTypedLen) ctx.func.typedLen = makeMapOverlay(ctx.scope.globalTypedLen)

  // D: Apply call-site param facts (only if body analysis didn't already set them).
  // Schema bindings additionally write into ctx.schema.vars so prop-access dispatch
  // hits the slot map. ctx.schema.vars is saved/restored so bindings don't leak.
  // MapOverlay instead of a clone (same jz×jz-ceiling fix as typedElem/typedLen
  // above and emitClosureBody's own doc): this used to be `new Map(ctx.schema.
  // vars)` — an O(programSize) clone of the WHOLE-PROGRAM schema table, paid once
  // per function in emitFuncs' driver loop. `own` starts empty; the `.set` calls
  // below (unchanged) write this function's own param-schema bindings into it;
  // restoring below is the identical "re-point the ctx field back" the overlay
  // doc already establishes, now O(1) instead of O(programSize) either direction.
  schemaVarsPrev = ctx.schema.vars
  ctx.schema.vars = makeMapOverlay(schemaVarsPrev)
  if (_reps) {
    for (const [k, r] of _reps) {
      if (k >= sig.params.length) continue
      const pname = sig.params[k].name
      // Same entry-vs-body-reassignment hazard analyzeFuncForEmit guards against
      // (see its comment): r.val/r.typedCtor/r.schemaId describe the CALLER's
      // argument, sound only while the body never writes the name. This step
      // duplicates that seeding (FunctionPlan.localReps already carries whatever
      // analyzeFuncForEmit settled, guarded — but re-applying the UNGUARDED
      // call-site fact here would undo it) so it needs the identical guard.
      const reassigned = isReassigned(body, pname)
      if (r.val && !reassigned && !ctx.func.localReps?.get(pname)?.val) updateRep(pname, { val: r.val })
      // presentVal: mirrors the analyzeFuncForEmit seeding above (see its comment) —
      // same guard, same duplication reason.
      if (r.presentVal && !reassigned && !ctx.func.localReps?.get(pname)?.presentVal) updateRep(pname, { presentVal: r.presentVal })
      // recvArrTyped: mirrors the analyzeFuncForEmit seeding above (see its comment).
      if (r.recvArrTyped && !reassigned) updateRep(pname, { recvArrTyped: true })
      if (r.typedCtor && !reassigned) {
        if (!ctx.func.typedElem) ctx.func.typedElem = new Map()
        if (!ctx.func.typedElem.has(pname)) ctx.func.typedElem.set(pname, r.typedCtor)
        if (!ctx.func.localReps?.get(pname)?.val) updateRep(pname, { val: VAL.TYPED })
        if (r.typedLen != null) {
          if (!ctx.func.typedLen) ctx.func.typedLen = new Map()
          if (!ctx.func.typedLen.has(pname)) ctx.func.typedLen.set(pname, r.typedLen)
        }
      }
      if (r.schemaId != null && !reassigned && !exported && !ctx.schema.vars.has(pname)) {
        ctx.schema.vars.set(pname, r.schemaId)
        updateRep(pname, { schemaId: r.schemaId })
      }
    }
  }

  const fn = ['func', `$${name}`]
  // Stamp the emit-side CSE, alias, and stable-header facts captured from the
  // detached install snapshot above. Watr ignores these non-index expandos.
  if (plannedCseLoadBases) fn.cseLoadBases = plannedCseLoadBases
  if (plannedDistinctParams) fn.distinctParams = plannedDistinctParams
  if (plannedStableHeaderNames) fn.stableHeaderNames = plannedStableHeaderNames
  // Inline `(export ...)` attribute only for the syntactic inline-export
  // form (`export function foo`, snapshot in `func.exported` at defFunc
  // time). Re-exports (`function foo; export { foo }`) and aliases (`export
  // { foo as bar }`) flow through sec.customs below — emitting an inline
  // attribute under the internal symbol would collide with the customs
  // entry on the same name, or leak the internal symbol publicly.
  // Boundary-wrapped exports also defer the attribute to the synthesized
  // wrapper ($${name}$exp) that reboxes the narrowed result back to f64.
  if (exported && !isBoundaryWrapped(func)) fn.push(['export', `"${name}"`])
  fn.push(...sig.params.map(p => ['param', dollar(p.name), p.type]))
  fn.push(...sig.results.map(t => ['result', t]))

  // Default params: ES spec says default applies only when arg is `undefined`
  // (or missing). `null`, `0`, `false`, etc. all skip the default.
  // Emitted here (registers any `charCodeAt` decomposition the default's
  // initializer triggers) but keyed by param name — final ordering vs the
  // charDecomp prologue is resolved in `collectParamInits` below.
  const defaults = func.defaults || {}
  const defaultInits = new Map()
  for (const [pname, defVal] of Object.entries(defaults)) {
    const p = sig.params.find(p => p.name === pname)
    // jsstring-carrier params with string-literal defaults skip wasm-side
    // substitution — the interop wrapper applies the default JS-side (the
    // value rides through `jz:extparam`). The wasm side never sees a null
    // externref so no `ref.is_null` branch is needed.
    if (p?.jsstring && p.jsstringDefault != null) continue
    const t = p?.type || 'f64'
    // emit(defVal) ONCE, before branching on t — same self-compile miscompile class as
    // emit.js's 'return' handler. See .work/todo.md (groundtruth archive).
    const emittedDefVal = emit(defVal)
    // dyn-closure-tables.js: a default value that's provably a closure literal
    // (e.g. subscript's `dispatch(ops, tail, fn = (a, …) => {…})`) is the fact
    // proveClosureFactory needs to see through `dispatch`'s forwarded return.
    recordParamClosureDefault(name, pname, emittedDefVal)
    defaultInits.set(pname,
      ['if', isUndef(typed(['local.get', `$${pname}`], 'f64')),
        ['then', ['local.set', `$${pname}`, t === 'f64' ? asF64(emittedDefVal) : asI32(emittedDefVal)]]])
  }

  // Box params that are mutably captured: allocate cell, copy param value
  const boxedParamInits = []
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
  // Remaining boxed locals (non-params) get a fresh null-init cell.
  const preboxedLocalInits = emitPreboxedLocalInits(name => paramNames.has(name))

  // Drain `ctx.func.charDecomp` after body emit: any param `charCodeAt` use
  // registered a decomposition request that needs a function-entry prologue
  // initialising its four i32 locals (base / len / sso / loadbase). Locals
  // themselves were already added to `ctx.func.locals` during emit so they
  // appear in the local-decl block below.
  //
  // Interleave with the per-param default inits in `sig.params` order so each
  // param's prologue runs *after* that param's own default init (the prologue
  // reads the param's final value) and *before* any later param's default
  // init — a default like `c = op.charCodeAt(0)` must see `op`'s prologue
  // locals already populated, else its bounds check reads len=0 and the
  // in-bounds char wrongly decodes as the OOB NaN.
  const collectParamInits = () => {
    const inits = []
    // Global-receiver decompositions (shape 1b) come first: a param default
    // like `(c = cur.charCodeAt(0))` must see the global's prologue locals
    // populated. Globals are readable at entry, so nothing precedes them.
    if (ctx.func.charDecomp) for (const dec of ctx.func.charDecomp.values())
      if (dec.global) inits.push(...emitCharDecompPrologue(dec))
    // Hoisted method-override probes (emit.js tryGenericEmitter): the probe's
    // answer is loop-invariant for a stable-global receiver — resolve it once.
    // Mirrors sidecarOverride's arm: primitives (real numbers, strings) can
    // never carry an own override, so only NaN-boxed non-STRING receivers probe.
    // Function-invariant typed lens (module/typedarray.js leanLen): a stable
    // PARAM receiver's element count, shared by every checked read/write guard.
    if (ctx.func.lenHoist) for (const h of ctx.func.lenHoist.values())
      inits.push(['local.set', `$${h.t}`, h.init])
    if (ctx.func.probeHoist) for (const ph of ctx.func.probeHoist.values()) {
      const g = () => ['i64.reinterpret_f64', ph.recvIR()]
      inits.push(
        ['local.set', `$${ph.ovr}`, ['if', ['result', 'f64'],
          ['i32.and',
            ['f64.ne', ph.recvIR(), ph.recvIR()],
            ['i64.ne',
              ['i64.and', g(), ['i64.const', i64Hex(BigInt(LAYOUT.TAG_MASK) << BigInt(LAYOUT.TAG_SHIFT))]],
              ['i64.const', i64Hex(BigInt(PTR.STRING) << BigInt(LAYOUT.TAG_SHIFT))]]],
          ['then', ['f64.reinterpret_i64', ['call', '$__dyn_get_expr', g(), ph.keyIR()]]],
          ['else', undefExpr()]]],
        ['local.set', `$${ph.is}`, ptrTypeEq(['local.get', `$${ph.ovr}`], PTR.CLOSURE)])
    }
    for (const p of sig.params) {
      const di = defaultInits.get(p.name)
      if (di) inits.push(di)
      const dec = ctx.func.charDecomp?.get(p.name)
      if (dec) inits.push(...emitCharDecompPrologue(dec))
    }
    return inits
  }

  ctx.func.repsFrozen = true   // FunctionPlan freeze: body emission begins — durable reps read-only
  assertCtxInvariants('pre-emit')
  if (block) {
    const stmts = emitBlockBody(body)
    // Hoist loop-invariant `__to_num(param)` coercions to a single entry rebind.
    const numCoerceInits = hoistInvariantParamCoercions(stmts, func)
    const cursorUnboxInits = hoistUnionCursorUnbox(stmts, func)
    const paramInits = collectParamInits()
    for (const [l, t] of ctx.func.locals) fn.push(['local', dollar(l), t])
    // I: Skip trailing fallback when last statement is return (unreachable code)
    const lastStmt = stmts.at(-1)
    const endsWithReturn = lastStmt && (lastStmt[0] === 'return' || lastStmt[0] === 'return_call')
    // Implicit fall-through return is `undefined` per JS spec, not 0 — same as
    // the closure path below. A reachable fall-through forces an f64 result
    // (it must carry undefined); concretely-typed results keep the `.const 0`
    // form since they can only be reached via explicit typed returns.
    const fallthrough = endsWithReturn ? []
      : sig.results.length === 1 && sig.results[0] === 'f64' ? [undefExpr()]
      : sig.results.map(t => [`${t}.const`, 0])
    fn.push(...paramInits, ...boxedParamInits, ...preboxedLocalInits, ...numCoerceInits, ...cursorUnboxInits, ...stmts, ...fallthrough)
  } else if (multi && body[0] === '[') {
    const values = body.slice(1).map(e => asF64(emit(e)))
    const paramInits = collectParamInits()
    for (const [l, t] of ctx.func.locals) fn.push(['local', dollar(l), t])
    fn.push(...paramInits, ...boxedParamInits, ...preboxedLocalInits, ...values)
  } else {
    // Top-level twin of emitFunc's 'return'-statement mixedAtomReturn admission
    // and emitClosureBody's expression-body site: a non-block arrow body
    // (`g = (s) => s ? 1 : false`) is this function's ENTIRE result, emitted
    // here directly rather than through the 'return' handler. An ambiguous
    // BOOL-merge body needs emitIdentitySafe in place of plain `emit` for the
    // same reason as those two sites — the merge's own valTypeOf already
    // collapsed to NUMBER, so a post-hoc box (there is none on this path
    // today) would be powerless; the box has to happen while the merge's own
    // arms are still separately known (.work/todo.md §deletion-sweep).
    // Guarded on sig.results[0] === 'f64': a proven-uniform-BOOL (or numeric)
    // result already narrows to i32 and needs no boxing here (the boundary
    // wrapper's own resultBool arm handles that crossing).
    const ambiguous = sig.ptrKind == null && sig.results[0] === 'f64' && hasAmbiguousBoolMerge(body)
    let ir = ambiguous ? emitIdentitySafe(body) : emit(body)
    ir = applyBigintRepresentationAction(ir, body, representationReturnAction(ctx, body))
    // dyn-closure-tables.js: an expression-bodied function whose return value
    // is unconditionally a closure literal (e.g. `mk = (n) => (x) => x + n`) —
    // a direct-return closure factory, no defaulted-param indirection needed.
    recordDirectReturnClosure(name, ir)
    const paramInits = collectParamInits()
    for (const [l, t] of ctx.func.locals) fn.push(['local', dollar(l), t])
    const finalIR = sig.ptrKind != null ? asPtrOffset(ir, sig.ptrKind) : asParamType(ir, sig.results[0])
    fn.push(...paramInits, ...boxedParamInits, ...preboxedLocalInits, tcoTailRewrite(finalIR, sig.results[0]))
  }

  return fn
  } finally {
    if (schemaVarsPrev) ctx.schema.vars = schemaVarsPrev
    restoreActiveFunction(ctx, previousFrame)
  }
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
  for (const func of ctx.funcs.list) {
    if (!isBoundaryWrapped(func)) continue
    const { name, sig } = func
    // i64 boundary carrier (Safari-safe). A genuine number is never a NaN-box, so it crosses
    // as plain f64 (zero cost). Everything that can be a NaN-box — heap pointer, null/undef/
    // bool atom, bigint carrier, or a dynamic value — crosses as i64: JSC (Safari) canonicalizes
    // f64 NaN payloads at the JS↔wasm boundary, erasing the box. The wasm signature is
    // self-describing; interop.js wrap() reinterprets BigInt↔f64 by bits, driven by the
    // `jz:i64exp` section emitted below. Non-JS hosts (WASI) read the same signature — i64 is
    // just int64 there, no BigInt.
    const resultPtr = sig.ptrKind != null
    // Plan-tagged UNION result (phase-c C2): valResult can settle VAL.BIGINT
    // for a result the plan carries as a tagged union (BigInt member BOXED,
    // number raw, pointers self-tagged) — the raw-bigint passthrough lane
    // would hand the host the union's BITS as one BigInt (a box pointer's
    // own bits for the boxed member). Route it to resultDynamic's generic
    // tag decode instead; interop's PTR.BIGINT arm derefs the box.
    const resultTaggedUnion = !resultPtr && representationResultTagRequired(ctx, func)
    const resultRawBigint = !resultPtr && !resultTaggedUnion && representationResultRawBigint(ctx, func)
    const resultBool = func.valResult === VAL.BOOL && !resultPtr
    const resultBigint = (func.valResult === VAL.BIGINT || resultRawBigint) && !resultPtr && !resultTaggedUnion
    // Dynamic f64 result: not pointer/bool/raw-bigint and not a proven number.
    // It may be a NaN box, so cross i64 and let interop's generic decoder own it.
    const resultDynamic = !resultPtr && !resultBool && !resultBigint &&
      sig.results[0] === 'f64' && !func._resultNumeric
    const resultI64 = resultPtr || resultBool || resultBigint || resultDynamic
    // jz:i64exp `r` marks results interop must reinterpret then `mem.read`.
    // A proven raw BigInt result is already the value, so it stays unmarked.
    const resultReinterpret = resultPtr || resultBool || resultDynamic
    // i64 carrier per param: pointer-ABI (offset) or a dynamic f64 param (boundaryI64).
    const paramIsI64 = (p) => !p.jsstring && (p.ptrKind != null || p.boundaryI64)
    // Inline `(export ...)` attribute only when the func decl carried the
    // inline-export keyword (`export function foo`). For re-exports
    // (`function foo; export { foo as bar }`) the `name` is the *internal*
    // symbol; sec.customs holds the JS-visible export pointing at this
    // wrapper. Emitting an inline attribute here under the internal name
    // would leak the symbol publicly and collide with the customs entry.
    const wrapNode = func.exported
      ? ['func', `$${name}$exp`, ['export', `"${name}"`]]
      : ['func', `$${name}$exp`]
    // jsstring params flow as externref end-to-end; boxed params ride i64; numbers f64.
    const i64Params = [], bigintBoxParams = []
    sig.params.forEach((p, i) => {
      wrapNode.push(['param', `$${p.name}`, p.jsstring ? 'externref' : paramIsI64(p) ? 'i64' : 'f64'])
      if (paramIsI64(p)) i64Params.push(i)
      if (representationHostBoxesParam(ctx, func, i)) {
        if (!paramIsI64(p)) throw new Error(`RepresentationPlan host-box param lacks i64 boundary: ${name}[${i}]`)
        bigintBoxParams.push(i)
      }
    })
    if (bigintBoxParams.length) inc('__alloc', '__mkptr')
    // Track externref param positions so interop.js can pass JS values raw (skipping
    // `mem.wrapVal`) at those slots — today only `jsstring` params; future externref carriers
    // wire here too. `extParams` is per-slot: false | { def: '...' } for a JS-side default.
    const extParams = sig.params.map(p => !p.jsstring ? false : p.jsstringDefault != null ? { def: p.jsstringDefault } : true)
    if (extParams.some(Boolean)) func._exportExtParams = extParams
    // Inner→wrapper argument list, shared by both single- and multi-value result shapes.
    const args = sig.params.map((p) => {
      const get = ['local.get', `$${p.name}`]
      if (p.jsstring) return get                              // externref flows through unchanged
      if (p.ptrKind != null) return ['i32.wrap_i64', get]     // ptr param: inner takes the i32 offset
      if (p.boundaryI64) return ['f64.reinterpret_i64', get]  // dynamic boxed param → f64 NaN-box carrier
      if (p.type === 'f64') return get
      return ['i32.trunc_sat_f64_s', get]                     // numeric narrowing f64 → i32
    })
    const callIR = ['call', `$${name}`, ...args]
    // Multi-value return: each lane is an f64 NaN-box carrier (every `return [a,b,…]` lane is
    // asF64; narrowing only touches single-result funcs). A boxed lane's NaN payload is erased
    // at the JS boundary, so cross EVERY lane as i64 — capture the inner call's N lanes into f64
    // locals (last result on top of the stack ⇒ pop in reverse) and re-push each reinterpreted.
    // interop reads the lane tuple via mem.read / decode (both map over an array result).
    if (sig.results.length > 1) {
      sig.results.forEach(() => wrapNode.push(['result', 'i64']))
      // Lane temporaries — guaranteed distinct from the wrapper's params (jz doesn't reserve
      // `__`, so a user param could be `__mlane0`): bump the prefix until no lane name collides.
      const pnames = new Set(sig.params.map((p) => p.name))
      let pfx = '__mlane'
      while (sig.results.some((_, i) => pnames.has(`${pfx}${i}`))) pfx = `_${pfx}`
      const lanes = sig.results.map((_, i) => `$${pfx}${i}`)
      lanes.forEach((n) => wrapNode.push(['local', n, 'f64']))
      const stmts = [callIR]
      for (let i = lanes.length - 1; i >= 0; i--) stmts.push(['local.set', lanes[i]])
      for (const n of lanes) stmts.push(['i64.reinterpret_f64', ['local.get', n]])
      wrapNode.push(...stmts)
      // `m` (lane count) marks a multi-value result so interop / the test adapter decode each
      // lane (vs `r`'s single reinterpret). Always recorded — even with no i64 params — so the
      // numeric-only `(a,b)=>[a+1,b+2]` tuple still gets its lanes turned back into numbers.
      func._exportI64 = { p: i64Params, m: sig.results.length }
      wrappers.push(wrapNode)
      continue
    }
    wrapNode.push(['result', resultI64 ? 'i64' : 'f64'])
    const toI64 = (n) => ['i64.reinterpret_f64', n]
    let body
    if (resultPtr) {
      const ptrType = valKindToPtr(sig.ptrKind)
      body = toI64(mkPtrIR(ptrType, sig.ptrAux ?? 0, callIR))
    } else if (resultBool) {
      // The i32 carrier is a clean 0/1 — truthyIR's identity path boxes it
      // straight into the TRUE_NAN/FALSE_NAN atom. The f64 carrier is NOT
      // provably raw: a BOOL-valued result may already be the atom box
      // (JSON.parse("false") returns FALSE_NAN — a bare f64.ne(v,0) reads any
      // atom as truthy). __is_truthy normalizes both representations; this is
      // the cold host boundary, the call costs nothing that matters.
      let carrier
      if (sig.results[0] === 'i32') carrier = typed(callIR, 'i32')
      else {
        inc('__is_truthy')
        carrier = typed(['call', '$__is_truthy', toI64(callIR)], 'i32')
      }
      body = toI64(boolBoxIR(carrier))
    } else if (resultBigint || resultDynamic) {
      // Proven raw BigInt and generic tagged results both cross losslessly as
      // i64. Only the latter sets `r`, so interop dereferences PTR.BIGINT boxes.
      body = toI64(callIR)
    } else if (sig.results[0] === 'i32') {
      body = [sig.unsignedResult ? 'f64.convert_i32_u' : 'f64.convert_i32_s', callIR]
    } else {
      body = callIR
    }
    wrapNode.push(body)
    // Record the i64 carrier map for interop.js (jz:i64exp). A pure-numeric
    // export records nothing.
    if (i64Params.length || resultReinterpret)
      func._exportI64 = { p: i64Params, r: resultReinterpret ? 1 : 0 }
    wrappers.push(wrapNode)
  }
  return wrappers
}


// MapOverlay implementation lives in map-overlay.js so FunctionPlan can
// fork detached typed views without importing this compile driver.

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
function analyzeClosureBodyForEmit(cb) {
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
function emitClosureBody(cb, functionPlan) {
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

/**
 * Compile prepared AST to WASM module IR.
 * @param {import('./prepare.js').ASTNode} ast - Prepared AST
 * @param {Object} [profiler] - host-only per-phase timing sink (timePhase)
 * @param {{mark: Function, exit: Function}} [regionHooks] - region-arena EMIT
 *  boundary (.work/research.md §Region arena, Slice 3): supplied ONLY by the
 *  self-compile kernel entry (scripts/self.js), mirroring frontHalf's own
 *  `regionHooks` contract (src/front.js) one boundary later in the pipeline —
 *  never passed by the native host (index.js calls `compile(ast, profiler)`,
 *  2 args, so `regionHooks` stays undefined there, zero behavior change: the
 *  gate battery below is for the NATIVE/dormant axis, unaffected by any of
 *  this). When present, wraps this WHOLE function body in one region round:
 *  every allocation `compile()` makes (plan/analyze facts, per-function
 *  locals, emit scratch, the whole `sec.*` staging structure) gets reclaimed
 *  at exit EXCEPT what's reachable from the root `[module, ctx.func,
 *  ctx.funcs, ctx.transform, ctx.scope]` — the returned module tree, plus the
 *  ctx containers the emit/encode tail (this file's own caller: scripts/self.js's
 *  `optimizeTail` wrapper, then `watrTail`'s post-watr `stablePtrGlobalNames`/
 *  `hoistGlobalPtrOffset` repair) still reads AFTER this function returns
 *  (`ctx.funcs.list.length`/`.map` — populated by the two `.clear()`-then-
 *  rebuild loops right below, read back by `scripts/self.js`'s own
 *  `optimizeTail` at `funcCount: ctx.funcs.list.length` and
 *  `ctx.funcs.map.get(...)`; `ctx.transform.optimize`/`.targetProfile`/
 *  `._vectorizedFnNames`; `ctx.scope.globalValTypes` — populated by this
 *  function's own `declGlobal` calls). Root the CONTAINERS, not individual
 *  leaf fields, matching `ctx.module`/`ctx.schema`/`ctx.closure` already
 *  riding front's own root this way. `ctx.module`/`ctx.schema` are NOT in
 *  THIS root: every read of either happens INSIDE this function, before exit
 *  fires (schema custom-section emission above, module import resolution at
 *  the top) — not needed post-return.
 *  The root must name `ctx.funcs` (plural, the function REGISTRY: `.list`/
 *  `.map`/`.names`, freshly rebuilt by this function's own opening
 *  `.clear()`-then-rebuild loops below), not `ctx.func` (singular, the
 *  ACTIVE-FRAME scratch record — inert/null by the time this exit fires):
 *  only the registry survives to be read by `optimizeTail`/`watrTail` after
 *  `compile()` returns. `ctx.func` is kept in the root too (harmless,
 *  uniform-root idiom) alongside it.
 *
 *  Rooting `ctx.transform` requires `__region_relocate_props` to be
 *  idempotent under re-application to its own output — otherwise
 *  `__region_copy_rec` corrupts a durable-but-unreached receiver's dyn-props
 *  on a second pass (see `module/core.js`, .work/research.md §Region arena
 *  "REGION MACHINERY SOUND"). `REGION_HOOKS_ACTIVE` still stays `false` as
 *  the committed default (scripts/self.js) — this boundary and its
 *  PLAN-TAIL children (`src/compile/plan/index.js`'s own five inner region
 *  rounds, threaded through the SAME `regionHooks` this function receives —
 *  see that file's own doc) ship DORMANT, gate-verified on both axes, not
 *  wired live in any shipped build.
 * @returns {Array} Complete WASM module as S-expression
 */
export default function compile(ast, profiler, regionHooks) {
  const __regionMark = regionHooks?.mark()
  // Contract: callers (jzCompileInner / scripts/self.js compileSelf) must set
  // ctx.transform.optimize before reaching here — every optimize-gated pass below
  // reads `cfg && cfg.x === false`, so a null cfg silently runs every pass.
  // Populate known function names + lookup map on ctx.func for direct call detection
  ctx.funcs.names.clear()
  ctx.funcs.map.clear()
  for (const f of ctx.funcs.list) { ctx.funcs.names.add(f.name); ctx.funcs.map.set(f.name, f) }
  // Include imported functions for call resolution (e.g. template interpolations).
  // Also register a synthesized sig in func.map so emit's arity-aware branches see
  // the import's declared param count — needed for arg pad/truncate to match it.
  for (const imp of ctx.module.imports) {
    if (imp[3]?.[0] !== 'func') continue
    const fname = imp[3][1].replace(/^\$/, '')
    ctx.funcs.names.add(fname)
    if (!ctx.funcs.map.has(fname)) {
      const params = []
      let result = 'f64'
      for (let k = 2; k < imp[3].length; k++) {
        const part = imp[3][k]
        if (Array.isArray(part) && part[0] === 'param') params.push({ type: part[1] || 'f64' })
        else if (Array.isArray(part) && part[0] === 'result') result = part[1] || 'f64'
      }
      ctx.funcs.map.set(fname, { name: fname, sig: { params, results: [result] } })
    }
  }

  // Check user globals don't conflict with runtime globals (modules loaded after user decls)
  for (const name of ctx.scope.userGlobals)
    if (!(ctx.scope.globals.get(name)?.mut && ctx.scope.globals.get(name)?.type === 'f64'))
      err(`'${name}' conflicts with a compiler internal — choose a different name`)

  // Pre-fold const globals: evaluate constant initializers before function compilation
  // so functions see the correct global types (i32 vs f64). Covers the main module
  // and every bundled sub-module — a sub-module's top-level `const SPACE = 32` lands
  // in `moduleInits` (emitted from __start), not `ast`, so without this it stays a
  // `(mut f64)` global. Folding it makes the scanner's char-code constants immutable
  // globals V8 constant-folds at each read site.
  if (ast) {
    const evalConst = n => {
      if (typeof n === 'number') return n
      // A reference to an already-folded integer const (`const NEW = CALL + 1`):
      // resolve it from constInts so const-referencing-const initializers fold too.
      // Without this they stay unfolded → decl defaults to 0 AND emitDecl skips the
      // (const) runtime init → the binding reads 0 (e.g. subscript's NEW=CALL+1 → the
      // `new` keyword registers with precedence 0 and never dispatches).
      if (typeof n === 'string') return ctx.scope.constInts?.get(n) ?? null
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
    const topStmts = n => Array.isArray(n) && n[0] === ';' ? n.slice(1)
      : Array.isArray(n) && n[0] === 'const' ? [n] : []
    const stmts = [...topStmts(ast)]
    for (const mi of ctx.module.moduleInits || []) stmts.push(...topStmts(mi))
    // Fixpoint: a const may reference one declared later or in another module
    // (`NEW = CALL + 1`). Each pass folds every now-resolvable initializer (its refs
    // already in constInts); repeat until none change so order/cross-module refs resolve.
    const foldedDecls = new Set()
    let changed = true
    while (changed) {
      changed = false
      for (const s of stmts) {
        if (!Array.isArray(s) || s[0] !== 'const') continue
        for (const decl of s.slice(1)) {
          if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') continue
          const [, name, init] = decl
          if (foldedDecls.has(name)) continue
          if (!ctx.scope.globals.has(name) || !ctx.scope.consts?.has(name)) continue
          const v = evalConst(init)
          if (v == null || !isFinite(v)) continue
          foldedDecls.add(name)
          changed = true
          const isInt = Number.isInteger(v) && v >= I32_MIN && v <= I32_MAX
          declGlobal(name, isInt ? 'i32' : 'f64', v, { mut: false })
          // Cache integer values for cross-call const-arg propagation: `f(N)` where
          // `const N = 8` should observe the param as intConst=8.
          if (isInt) (ctx.scope.constInts ||= new Map()).set(name, v)
          // Cache EVERY folded value (fractional too) so readVar substitutes the
          // literal at each read site — compile-time paths (emitPow's constant
          // non-integer exponent → exp(c·log x), narrowing, the vectorizer) see
          // through the global where V8 would only fold it at runtime. colorpq's
          // PQ exponents (nv = 2610/16384, p = 1.7·2523/32) rode global.get into
          // the generic runtime-exponent $math.pow because of exactly this gap.
          ;(ctx.scope.constNums ||= new Map()).set(name, v)
        }
      }
    }
  }

  // Typed-ctor sizes parked at prepare (`new T(CIN*H*W)` — names only now folded):
  // re-run the static-len derivation with constInts populated. Feeds the interval
  // proof's receiver lengths (typedIdxProven class 5).
  if (ctx.scope.pendingTypedLens) {
    for (const [name, rhs] of ctx.scope.pendingTypedLens) {
      const len = typedStaticLen(rhs)
      if (len != null && ctx.scope.globalTypedElem?.has(name))
        (ctx.scope.globalTypedLen ||= new Map()).set(name, len)
    }
    ctx.scope.pendingTypedLens = null
  }

  // Whole-program constant fold of module-scope aggregate literals — `var x=[1,2,3];
  // y=x[0]` → `y=1`, dropping the array (no data segment, no __arr_idx_known) when
  // every reference is a static read. The scalar analog of the constInts fold above.
  timePhase(profiler, 'foldAggregates', () => foldStaticConstAggregates(ast))

  // `let`, not `const`: the post-plan-scans region round below (region-live
  // only, dead code otherwise) rebinds this from its own `exit()` return.
  let programFacts = timePhase(profiler, 'plan', () => plan(ast, profiler, regionHooks))

  // Region-arena plan-tail round 6 (.work/research.md §Region arena, per-pass
  // slice): the three closure-table scans below are pure AST walks producing
  // three ctx.scope fields (+~61 MB combined, dominated by
  // scanClosureTableLatticeCandidates's own +61 MB)
  // — one round. Root: the UNION-FIELD set (Slice C-v2, `.work/compile-
  // session-design.md` §2.1/§3, front.js's own doc has the full rationale
  // for why this is the union of every field any round has ever needed,
  // applied uniformly, rather than a wholesale `[ast, ctx]` root).
  const __scanMark = regionHooks?.mark()
  // Same-body indirect devirt (dyn-closure-tables.js): which module globals are
  // structurally safe candidate closure tables (never alias/escape) — the
  // write-family + call-site facts gathered during emission below only fire
  // for names in this set. Post-plan so the scan sees the AST shapes that will
  // actually emit.
  if ((ctx.transform.optFlags & OPTF.devirtClosureTables)) ctx.scope.dynFnTableCandidates = scanDynClosureTableCandidates(ast)

  // Closure-TABLE call-site PARAM lattice (dispatch-through-array-of-closures
  // class — dyn-closure-tables.js's scanClosureTableLatticeCandidates docs the
  // exact safety notion, stricter than the devirt scan above): which const
  // arrays of closures are provably invoked ONLY via `name[idx](args)`. Always
  // on (fail-open by construction — no gate needed, mirrors the ungated direct-
  // closure paramTypes lattice in emit.js/tryDirectClosureCall). emit.js
  // consults this set at every `name[idx](args)` call site to decide whether
  // to accumulate arg-kind evidence for the table's elements. NOTE: "always
  // on" describes the FACT computation; whether emit consumes the proof is
  // tier-dependent (O0 keeps the generic call path — values identical, no
  // proof-shaped codegen; the structural pins in test/closures.js are
  // belowOpt(2)-guarded accordingly).
  ctx.scope.closureTableLatticeCandidates = scanClosureTableLatticeCandidates(ast)

  // Same lattice, IMPERATIVE-construction class (dispatch tables built via
  // scattered `name[key] = arrowLiteral` writes rather than one array
  // literal — jessie's subscript `lookup` shape; the named follow-on to the
  // const-literal scan above). Also always on, fail-open by construction —
  // see dyn-closure-tables.js's own doc for the safety notion and the
  // module-init-order reasoning behind its "early-mergeable" subset.
  ctx.scope.imperativeClosureTableLatticeCandidates = scanImperativeClosureTableLatticeCandidates(ast)
  if (regionHooks) {
    ;[ast, programFacts, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.func, ctx.transform, ctx.facts] =
      regionHooks.exit(__scanMark, [ast, programFacts, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.func, ctx.transform, ctx.facts])
  }

  // Inspect sink: editor hosts opt in via { inspect: true } to read inferred shapes.
  // Initialized here (post-plan) so paramReps and schema.list are stable, populated
  // per-function below as FunctionPlans settle. Bytes themselves are unchanged.
  if (ctx.transform.inspect) ctx.inspect = { functions: {}, schemas: ctx.schema.list.map(s => s.slice()) }

  const publishPlan = (func, facts) => publishFunctionPlan(ctx, func, facts)
  // Region-arena analyzeFuncs BATCHED round (.work/research.md §Region arena,
  // Lever 1 — the retained-set census's own top lever: ~70% MAP/HASH-shaped
  // churn, up to 1435 calls for jz×jz). Iteration below is index-based,
  // re-reading `ctx.funcs.list[i]` FRESH every access rather than holding
  // the array or an iterator across a region exit: a plain `for…of` iterator
  // over `ctx.funcs.list` caches the array's base pointer ONCE at loop entry
  // (this codebase's own self-compiled for-of lowering, not V8's), so a
  // mid-loop `region_exit` that relocates `ctx.funcs` (and thus its `.list`
  // backing store) would leave that cached base stale — the "durable
  // receiver, stale pointer to reclaimed memory" class (see the
  // closure4232/fromnested test cases). The index-based form is
  // behavior-identical to the original `for…of` both natively (V8's own
  // Array iterator is itself index+length-checked per step, so growth-
  // during-iteration behaves the same either way) and self-compiled (a fresh
  // property read always observes the just-rebound `ctx.funcs`).
  //
  // GRANULARITY — batched (every AFE_ROUND_BATCH functions), not per-function:
  // this round's own root bundle (below) must include `ctx.plans` (see its
  // own note) — a container that grows by one FunctionPlan every iteration
  // and is never emptied. `__region_exit` is a compacting relocator that
  // walks and RE-COPIES the entire root-reachable durable set at every exit
  // (confirmed by the census's own mark/delta methodology: the memo resets at
  // every new round — no cross-round memoization of "unchanged since last
  // round"), so exiting once per function against a linearly-growing root
  // would cost O(N²) total copy work for N functions (1435 for jz×jz) — a
  // real risk of the reclaim overhead eclipsing the reclaim benefit. Batching
  // divides that cost by the batch size while still reclaiming per-function
  // churn (the actual target) far more often than the status quo (never).
  // AFE_ROUND_BATCH is a tunable constant, sized from jessie/watr/jzify-entry
  // measurement (`.work/research.md` §Region arena, this entry), not guessed.
  const AFE_ROUND_BATCH = 32
  // Fixed-shape closure records closed the former `cb.params` relocation
  // corruption, but full closure-round jz×jz still reaches wasm32's copying
  // ceiling before producing bytes. Keep this high-copy boundary dormant until
  // the complete goal (not only parity/oracle probes) proves it end to end.
  const CLOSURE_ROUNDS_ACTIVE = false
  const EMIT_FUNC_ROUNDS_ACTIVE = true
  timePhase(profiler, 'analyzeFuncs', () => {
    // Mark lazily, at the first index actually reached (not unconditionally
    // before the loop) — an empty/all-raw `ctx.funcs.list` must never leave
    // an unpaired `mark()` with no matching `exit()`.
    let __mark = null
    for (let i = 0; i < ctx.funcs.list.length; i++) {
      if (regionHooks && __mark == null) __mark = regionHooks.mark()
      const func = ctx.funcs.list[i]
      if (!func.raw) {
        const facts = analyzeFuncForEmit(func, programFacts)
        publishPlan(func, facts)
        captureFuncInspect(func, facts, programFacts)
      }
      const lastFunc = i === ctx.funcs.list.length - 1
      if (regionHooks && ((i + 1) % AFE_ROUND_BATCH === 0 || lastFunc)) {
        // Union-field root (Slice C-v2, `.work/compile-session-design.md`
        // §2.1/§3, front.js's own doc has the full rationale): covers every
        // container this loop writes — `ctx.plans` (publishFunctionPlan's
        // per-iteration `.set()`) and `ctx.inspect` (captureFuncInspect)
        // included. `func`/`functionPlan` (the loop locals) stay
        // deliberately unrooted: both are fully consumed (published,
        // captured, scanned) before this exit fires, dead the instant this
        // branch is reached — exactly the garbage this round exists to
        // reclaim.
        ;[ast, programFacts, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.func, ctx.transform, ctx.facts] =
          regionHooks.exit(__mark, [ast, programFacts, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.func, ctx.transform, ctx.facts])
        __mark = null  // re-armed lazily at the next index, if any
      }
    }
  })
  // Whole-program SRoA: pick the schemas whose `Array<S>` instances use the
  // `structInline` carrier. Runs once the per-function reps have settled (they
  // are codegen truth) and before any function is emitted.
  // `optimize: { structInline/unionInline: false }` disable a representation
  // wholesale — the REFERENCE MODES for three-way differentials (off / on /
  // plain JS); with an empty registry every consumer takes the plain path.
  if (ctx.transform.optimize?.structInline !== false)
    timePhase(profiler, 'structInline', () => analyzeStructInline(programFacts))
  if (ctx.transform.optimize?.unionInline !== false) {
    timePhase(profiler, 'unionInline', () => analyzeUnionInline(programFacts))
    // Carrier-specialized clones (after the registry settles): verified
    // cursor-param functions get a raw-i32 `$union` sibling; sanctioned
    // callsites rewrite to it — no NaN-box crosses the call.
    // The clone's facts must derive under ITS sig (the pointer-ABI param
    // registration + reps seeding live in analyzeFuncForEmit) — re-run it
    // per clone rather than sharing the original's f64-sig facts.
    timePhase(profiler, 'unionClones', () => {
      for (const clone of specializeUnionCursorParams(programFacts)) {
        const facts = analyzeFuncForEmit(clone, programFacts)
        publishPlan(clone, facts)
        captureFuncInspect(clone, facts, programFacts)
      }
    })
  }
  // FeaturePlan freeze (.work/research.md §FeaturePlan freeze): every per-function
  // analyze pass has now run (analyzeFuncs + structInline/unionInline/unionClones
  // above) — this is the freeze point after which NO ctx.features key may change
  // (uniform, no exceptions; typedView — the one key that used to keep flipping
  // past this point — was reclassified onto ctx.linkDemand). Extends the
  // post-prepare SESSION+PROGRAM snapshot with ANALYSIS (currently empty);
  // compared at 'pre-assemble' below.
  assertCtxInvariants('post-analyze')
  // FunctionPlans now own every named-function fact needed by emission. Drop
  // the duplicate bodyFacts cache before region rounds start; any genuinely
  // late consumer recomputes, while the self-host relocator no longer copies
  // both the canonical plan and its analysis cache for every function.
  invalidateAllBodyFacts()
  resetBindingUsesCache()
  // isReassigned memo window: emission is a pure projection of the frozen
  // post-analyze AST, so per-subtree assigned-name sets stay valid for the
  // whole stage (see the memo doc in ast.js).
  //
  // EMISSION region-round exit wrapper — roots/rebinds non-`ctx` module-scope
  // caches alongside the ordinary ctx.* root array. DOLLAR (src/ir.js,
  // dollarMap/setDollarMap) lives entirely outside `ctx`, invisible to any
  // ctx.*-based root no matter how that array is extended: `dollar()` fires
  // on effectively every emitted IR node, growing DOLLAR's backing Map
  // heavily mid-emission, and with DOLLAR unrooted a round-exit mid-batch
  // reclaims that growth out from under it — the SAME class this binding's
  // own doc already names for warm-instance reuse (`_clear` swap-in-fresh-
  // Map), just triggered by a region-round boundary instead of a new
  // compile. Verified NOT sufficient alone to close the jz×jz-scale trap
  // (see the ledger note below) but real and worth keeping regardless — it
  // is unconditionally safer than leaving DOLLAR unrooted. `extern` pairs
  // (get, set) let a specific round add MORE non-ctx caches (pullStdlib's
  // stdlibParseCache, src/wat/assemble.js — same documented hazard class,
  // only live during that one stage) without every site paying for it.
  const DOLLAR_EXTERN = [dollarMap, setDollarMap]
  const emissionRoundExit = (mark, root, extern = [DOLLAR_EXTERN], exit = regionHooks.exit) => {
    const values = []
    for (let i = 0; i < extern.length; i++) values.push(extern[i][0]())
    const rootLen = root.length
    // `extern` itself contains closure-valued setter functions and is used
    // AFTER region exit. Root and rebind that descriptor too; otherwise the
    // freshly-created default `[DOLLAR_EXTERN]` can be reclaimed and the first
    // setter call reads a stale closure aux → call_indirect table OOB.
    const out = exit(mark, [...root, extern, ...values])
    const movedExtern = out[rootLen]
    for (let i = movedExtern.length - 1; i >= 0; i--) movedExtern[i][1](out.pop())
    out.splice(rootLen, 1)
    return out
  }
  // Region rounds through EMISSION (re-landing .work/research.md §Emission
  // rounds — same batching rationale and iterator discipline as the
  // analyzeFuncs loop above: index-based fresh reads, roots rebound at every
  // exit, batch size shared with AFE_ROUND_BATCH). Nothing reclaimed here
  // before this re-land: the whole emission+assembly pipeline ran hook-free,
  // accumulating every emit temporary from the last AFE exit to the
  // (never-reached) outer boundary — the quantified 69.1%/2,274 MB jz×jz
  // window (fresh forensic attribution, this entry). The accumulating output
  // array rides in the root bundle; the isReassigned memo is pointer-keyed
  // off AST nodes, so it is closed before every exit and reopened after
  // (relocation would strand its keys).
  //
  // ROOT BUNDLE — extended past the ANALYSIS-stratum 12-field union (front.js's
  // own doc, shared by every round so far) with EMISSION's own write-set,
  // PLAIN-DATA FIELDS ONLY: ctx.runtime (dataParts/dataDedup grow per string
  // literal), ctx.memory, ctx.error, ctx.linkDemand, ctx.names, ctx.features
  // (scalars/Maps/Sets, no closures) — plus the specific ctx.core SUB-fields
  // emission writes (ctx.core.includes/extImports/jsstring/hostGlobals/
  // stdlibDeps — Sets/plain objects). `ctx.core` ITSELF (its `.emit`/`.stdlib`
  // siblings — hundreds of CLOSURE-valued dispatch/codegen entries), plus
  // `ctx.bridge`/`ctx.abi` (same shape), stay OUT of every round root: this is
  // the load-bearing lesson of the FIRST re-land attempt (53bcb112+7085cb57,
  // reverted) — 7085cb57 rooted `ctx.core`/`ctx.abi`/`ctx.bridge` wholesale to
  // fix exactly this under-coverage and made the regression WORSE ("phantom
  // pair GROWN", third failure mode), and a dedicated prior investigation unrelated
  // to this file (.work/research.md §CompileSession Slice D, two direct
  // experiments) independently proved wholesale-rooting these same nine
  // fields reproduces real WASM traps (`unreachable`, `memory access out of
  // bounds`) neither hypothesis closed — walking a several-hundred-entry
  // closure dict is a shape `__region_copy_rec` has never been proven safe
  // against. Narrower fix: root only the plain-data containers actually
  // written; `ensureThrowRuntime`'s one post-pullStdlib read of
  // `ctx.core.stdlib` (the sole read of the excluded closure dicts found
  // anywhere after any round's exit) is closed by reordering, not rooting —
  // see the pullStdlib round below.
  //
  // KNOWN OPEN ISSUE (re-land session, jz×jz scale only): this round is
  // GATE-CLEAN on jessie/watr/jzify (region-live probes: jessie 345.44 MB,
  // ≤380.8 baseline PASS; jzify 2032.56 MB PASS, completes; watr traps at
  // the pre-existing 4 GiB ceiling, neutral — bit-identical to the SAME
  // probes run against this round entirely absent, i.e. genuinely zero
  // regression at this scale). The jz×jz goal probe (self.js compiling
  // itself, 2234 functions) does NOT yet pass with this round active: it
  // hits a deterministic "memory access out of bounds" / "Cannot iterate
  // null or undefined" at peak 3059.38 MB, IDENTICAL across three tested
  // root-set configurations (full ctx.runtime/ctx.core extension + DOLLAR;
  // extension without DOLLAR; DOLLAR without extension) — ruling out both
  // DOLLAR and the ctx.* extension as the cause by elimination. HEAD (no
  // emission round at all, front+AFE only) ALSO fails the same probe, but
  // with a DIFFERENT, pre-existing signature ("Maximum call stack size
  // exceeded" @ 3669.50 MB) — the jz×jz goal probe was not passing on this
  // exact methodology before this round existed either, so this is a
  // genuinely distinct, deeper mechanism (likely in `__region_copy_rec`'s
  // handling of the `out` accumulator's large/deeply-nested WAT-IR content
  // specifically — the one structural difference between this round and
  // AFE's own proven-safe use of the same 12-field union), not a simple
  // root-completeness gap. Needs dedicated WAT-breadcrumb forensics (the
  // campaign's own established method for this exact class, .work/
  // research.md §CompileSession Slice B) — banked, not chased further this
  // session, per the same campaign's repeated precedent of not spot-fixing
  // an unconfirmed mechanism.
  let funcs = timePhase(profiler, 'emitFuncs', () => {
    let out = []
    let __mark = null, batchN = 0
    const closeRound = () => {
      endAssignedMemo()
      ;[ast, programFacts, out, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.func, ctx.transform, ctx.facts, ctx.runtime, ctx.memory, ctx.error, ctx.linkDemand, ctx.names, ctx.features, ctx.core.includes, ctx.core.extImports, ctx.core.jsstring, ctx.core.hostGlobals, ctx.core.stdlibDeps] =
        emissionRoundExit(__mark, [ast, programFacts, out, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.func, ctx.transform, ctx.facts, ctx.runtime, ctx.memory, ctx.error, ctx.linkDemand, ctx.names, ctx.features, ctx.core.includes, ctx.core.extImports, ctx.core.jsstring, ctx.core.hostGlobals, ctx.core.stdlibDeps])
      __mark = null
      batchN = 0
      beginAssignedMemo()
    }
    beginAssignedMemo()
    try {
      for (let i = 0; i < ctx.funcs.list.length; i++) {
        const func = ctx.funcs.list[i]
        // Fixed-shape closure records make closure-producing named functions
        // relocation-safe too; all named functions share one batched policy.
        // Closure-BODY waves remain separately gated below.
        if (EMIT_FUNC_ROUNDS_ACTIVE && regionHooks && __mark == null) __mark = regionHooks.mark()
        if (func.raw) out.push(emitFunc(func, null, programFacts))
        else {
          const functionPlan = functionPlanOf(ctx, func)
          out.push(emitFunc(func, functionPlan, programFacts))
          retireFunctionPlan(ctx, func, functionPlan)
          invalidateBindingUsesCache(func.body)
        }
        if (__mark != null) batchN++
        const last = i === ctx.funcs.list.length - 1
        if (__mark != null && (batchN >= AFE_ROUND_BATCH || last)) closeRound()
      }
    } finally { endAssignedMemo() }
    return out
  })
  funcs.push(...synthesizeBoundaryWrappers())

  let closureFuncs = []
  // `sec` doesn't exist yet at the first compilePendingClosures() call (its
  // declaration is further below), but the buildStartFn callback re-enters
  // this function AFTER sec holds every emitted function — a region exit
  // there must root sec or reclaim the module. Registered once sec is built
  // (right after its own declaration, below); null until then (an inert,
  // always-safe root — every round tolerates a null element, same as
  // ctx.inspect's own null-until-populated shape in the 12-field union).
  let __secRoot = null
  let compiledBodyCount = 0
  const compilePendingClosures = () => timePhase(profiler, 'emitClosures', () => {
    // Emitting a body may discover nested closures. Process stable batches:
    // every body known at batch entry is fully planned before any body in that
    // batch emits; newly discovered bodies become the next batch.
    // NOTE: analyzeClosureBodyForEmit runs OUTSIDE the isReassigned memo window
    // (it may touch analyze-side caches); only the pure emit half is bracketed.
    // Region round per batch (see the emitFuncs loop above, same write-set +
    // DOLLAR discipline via emissionRoundExit): `ctx.closure.bodies` is
    // re-read fresh each access (never held across an exit — the AFE loop's
    // own "durable receiver, stale pointer" note applies identically here);
    // `funcs`/`closureFuncs`/`__secRoot` ride in the root bundle.
    while (compiledBodyCount < (ctx.closure.bodies?.length || 0)) {
      const __mark = CLOSURE_ROUNDS_ACTIVE ? regionHooks?.mark() : null
      const batchEnd = ctx.closure.bodies.length
      for (let i = compiledBodyCount; i < batchEnd; i++) analyzeClosureBodyForEmit(ctx.closure.bodies[i])
      beginAssignedMemo()
      try {
        for (let i = compiledBodyCount; i < batchEnd; i++) {
          const cb = ctx.closure.bodies[i]
          const functionPlan = functionPlanOf(ctx, cb)
          closureFuncs.push(emitClosureBody(cb, functionPlan))
          retireFunctionPlan(ctx, cb, functionPlan)
          invalidateBindingUsesCache(cb.body)
        }
      } finally { endAssignedMemo() }
      compiledBodyCount = batchEnd
      if (CLOSURE_ROUNDS_ACTIVE && regionHooks) {
        ;[ast, programFacts, funcs, closureFuncs, __secRoot, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.func, ctx.transform, ctx.facts, ctx.runtime, ctx.memory, ctx.error, ctx.linkDemand, ctx.names, ctx.features, ctx.core.includes, ctx.core.extImports, ctx.core.jsstring, ctx.core.hostGlobals, ctx.core.stdlibDeps] =
          emissionRoundExit(__mark, [ast, programFacts, funcs, closureFuncs, __secRoot, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.func, ctx.transform, ctx.facts, ctx.runtime, ctx.memory, ctx.error, ctx.linkDemand, ctx.names, ctx.features, ctx.core.includes, ctx.core.extImports, ctx.core.jsstring, ctx.core.hostGlobals, ctx.core.stdlibDeps])
        if (__secRoot) sec = __secRoot
      }
    }
  })

  // Imperative closure-TABLE PARAM lattice — early merge (dyn-closure-
  // tables.js scanImperativeClosureTableLatticeCandidates). Every named
  // function has now emitted (the map() just above), so every write
  // (register()-style `lookup[c] = fn`) and every read (`lookup[cc](...)`)
  // this candidate class permits has already recorded its evidence — but
  // NONE of the closure bodies those writes created have COMPILED yet
  // (compilePendingClosures' first flush is the very next line). This is the
  // one window where merging is both sound (every occurrence the safety scan
  // allows is confined to functions that already emitted) and useful (still
  // before the bodies it targets compile). Module-scope-touching candidates
  // are excluded from imperativeClosureTableEarlyMergeable up front — see
  // that scan's own doc.
  if (ctx.scope.imperativeClosureTableEarlyMergeable?.size)
    for (const name of ctx.scope.imperativeClosureTableEarlyMergeable) {
      const members = ctx.scope.imperativeClosureTableMembers?.get(name)
      if (members?.length) resolveClosureTableParamLattice(name, members)
    }

  compilePendingClosures()

  // `wasm:js-string` imports — drained from `ctx.core.jsstring`, one
  // `(import …)` per builtin referenced by emitted code. Engines with
  // js-string-builtins support intercept the namespace; engines without
  // fall back to JS-side polyfills wired in interop.js. The import nodes
  // precede user imports so the host providing them sees them first.
  const jssImports = []
  if (ctx.core.jsstring?.size) {
    for (const name of ctx.core.jsstring) {
      const sig = JSS_IMPORT_SIGS[name]
      if (!sig) continue  // unknown builtin — silently skip (defensive)
      const funcNode = ['func', `$__jss_${name}`,
        ...sig.params.map(t => ['param', t]),
        ['result', sig.result],
      ]
      jssImports.push(['import', '"wasm:js-string"', `"${name}"`, funcNode])
    }
  }

  // Build module sections — named slots, assembled at the end (no index bookkeeping)
  let sec = {
    extStdlib: [],  // external stdlib (imports that must precede all other imports)
    imports: [...jssImports, ...ctx.module.imports],
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
  // Register `sec` for the closure round above (its `__secRoot` was null
  // until now — see that binding's own doc) and for the stage rounds below.
  __secRoot = sec

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

  // WASI command-mode entry legalization (`run`/`_start` re-exported as () -> ()) and
  // the WASI reactor `_initialize` conversion used to live here and further down in this
  // function, mutating `sec.funcs`/`sec.start` in place. Both are now target legalization
  // (src/optimize/watr-tail.js legalizeForTarget), ported onto the fully assembled
  // `['module', …]` tree — see that function's doc comment for why (and for the byte-
  // identity evidence that the relocation is safe). Nothing here builds `wasiCommandExports`
  // any more, so the "Named export aliases" loop below always emits the natural alias
  // export entry for an aliased `run`/`_start` — legalizeForTarget rewrites it from there.

  if (ctx.closure.table?.length)
    sec.elem.push(['elem', ['i32.const', 0], 'func', ...ctx.closure.table.map(n => `$${n}`)])

  // Stage region round: mark before buildStart (late closure batches + the
  // start-function IR churn — top-level statements, module-init code — none
  // of which any prior round has ever reclaimed), exit after — mirrors the
  // AFE-round shape, same write-set + DOLLAR discipline via
  // emissionRoundExit. `sec` rides via __secRoot (registered above); `funcs`/
  // `closureFuncs` may still grow here (compilePendingClosures' own re-entry
  // from inside buildStartFn) so both stay in the root too.
  const __buildMark = regionHooks?.mark()
  timePhase(profiler, 'buildStart', () => buildStartFn(ast, sec, closureFuncs, compilePendingClosures))
  if (regionHooks) {
    ;[ast, programFacts, funcs, closureFuncs, sec, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.func, ctx.transform, ctx.facts, ctx.runtime, ctx.memory, ctx.error, ctx.linkDemand, ctx.names, ctx.features, ctx.core.includes, ctx.core.extImports, ctx.core.jsstring, ctx.core.hostGlobals, ctx.core.stdlibDeps] =
      emissionRoundExit(__buildMark, [ast, programFacts, funcs, closureFuncs, sec, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.func, ctx.transform, ctx.facts, ctx.runtime, ctx.memory, ctx.error, ctx.linkDemand, ctx.names, ctx.features, ctx.core.includes, ctx.core.extImports, ctx.core.jsstring, ctx.core.hostGlobals, ctx.core.stdlibDeps])
    __secRoot = sec
  }

  // dyn-closure-tables.js: every function AND module init has now emitted, so
  // callSites/paramClosureDefaults/directReturnClosures are complete — resolve
  // each candidate table's write family and (if monomorphic) hand it to
  // devirtConstFnArrayCalls via ctx.scope.constFnArrays, same as a const array.
  if ((ctx.transform.optFlags & OPTF.devirtClosureTables)) timePhase(profiler, 'resolveDynFnTables', () => resolveDynFnTables(programFacts))

  // Host globals (globalThis/process/WebAssembly/…) referenced as values are
  // recorded in ctx.core.hostGlobals during emit; register them as env imports
  // now (assembly owns ctx.module.imports). Drained after buildStartFn so a
  // host global first used in a top-level statement (emitted into __start) is
  // captured; syncImports below merges them into sec.imports.
  for (const name of ctx.core.hostGlobals) {
    ctx.module.imports.push(['import', '"env"', `"${name}"`, ['global', `$${name}`, 'i64']])
    // Host references cross the JS↔wasm boundary as raw i64 NaN-box carriers.
    // Register that REPRESENTATION type alongside the import: optimizeModule's
    // promoteGlobals consumes globalTypes, and treating this slot as the
    // source-level f64 value would emit `(local f64) (local.set … global.get i64)`.
    ctx.scope.globalTypes.set(name, 'i64')
  }

  syncImports(sec)

  dedupClosureBodies(closureFuncs, sec)

  finalizeClosureTable(sec)

  buildInternTable()

  // FeaturePlan freeze (.work/research.md §FeaturePlan freeze): emission is done —
  // asserts ctx.features' SESSION+PROGRAM+ANALYSIS strata are present and unchanged
  // since their post-prepare/post-analyze snapshots, right before pullStdlib's
  // resolveIncludes() starts reading the DEMAND stratum (module template factories
  // + deps lambdas).
  assertCtxInvariants('pre-assemble')

  // Stage region round: pullStdlib realizes every stdlib helper's WAT
  // template (+927 MB churn measured on jz×jz, .work/research.md §Parts-fix
  // verified) via resolveIncludes()/includeModule() — module registration,
  // which is ALSO where ctx.core.emit/ctx.core.stdlib (the closure-bearing
  // dicts excluded from every round's root, see the emitFuncs round's own
  // doc above) grow most heavily. `ensureThrowRuntime` is called INSIDE this
  // round's mark/exit window, not after: it is the one caller anywhere that
  // reads `ctx.core.stdlib` post-pullStdlib (checking realized helper bodies
  // for `(throw `), and with those dicts deliberately unrooted a read after
  // THIS exit would be the exact dangling-arena-pointer class the DOLLAR fix
  // documents — closed by REORDERING the read inside the live round instead
  // of rooting the closure dict. `stripStaticDataPrefix` stays after the
  // exit: its own ctx.core dependency (`.includes`, a plain Set) is already
  // rooted, so a post-exit read is sound. `stdlibParseCache` (src/wat/
  // assemble.js) is the SAME non-ctx module-scope hazard class as DOLLAR,
  // fired by every `parseTemplate` call inside pullStdlib's own realize
  // step — rooted here via the `extern` list (site-scoped: no other round
  // touches it).
  // Everything below pullStdlib needs only compact public-ABI/export facts,
  // never source bodies or FunctionPlans. Snapshot those facts before the
  // stage-8 region exit so that exit can release the complete analysis graph.
  const lateRest = []
  const lateExt = []
  const lateI64 = []
  const lateHostAbi = []
  const lateNamedExports = []
  const lateExportedNames = new Set()
  for (const f of ctx.funcs.list) {
    if (isExported(f)) lateExportedNames.add(f.name)
    if (isExported(f) && f.rest) {
      const fixed = f.sig.params.length - 1
      for (const exportName of exportNamesOf(f.name)) lateRest.push({ name: exportName, fixed })
    }
    if (isExported(f) && isBoundaryWrapped(f) && f._exportExtParams) {
      const p = []
      const d = {}
      f._exportExtParams.forEach((b, i) => {
        if (!b) return
        p.push(i)
        if (typeof b === 'object' && b.def != null) d[String(i)] = b.def
      })
      if (p.length) {
        const hasDefaults = Object.keys(d).length > 0
        for (const exportName of exportNamesOf(f.name))
          lateExt.push(hasDefaults ? { name: exportName, p, d } : { name: exportName, p })
      }
    }
    if (isExported(f) && isBoundaryWrapped(f) && f._exportI64) {
      const { p, r, m } = f._exportI64
      for (const exportName of exportNamesOf(f.name))
        lateI64.push(m ? { name: exportName, p, m } : r ? { name: exportName, p, r } : { name: exportName, p })
    }
    if (isExported(f)) {
      const tag = []
      for (let i = 0; i < f.sig.params.length; i++)
        if (representationHostBoxesParam(ctx, f, i)) tag.push(i)
      if (tag.length) for (const exportName of exportNamesOf(f.name))
        lateHostAbi.push({ name: exportName, tag })
    }
  }
  for (const [name, val] of Object.entries(ctx.funcs.exports)) {
    if (val === true) {
      if (ctx.scope.userGlobals?.has(name)) lateNamedExports.push(['export', `"${name}"`, ['global', `$${name}`]])
      continue
    }
    if (typeof val !== 'string') continue
    const func = ctx.funcs.list.find(f => f.name === val)
    if (func) lateNamedExports.push(['export', `"${name}"`, ['func', `$${isBoundaryWrapped(func) ? val + '$exp' : val}`]])
    else if (ctx.scope.globals.has(val)) lateNamedExports.push(['export', `"${name}"`, ['global', `$${val}`]])
  }
  let lateFacts = {
    rest: lateRest,
    ext: lateExt,
    i64: lateI64,
    hostAbi: lateHostAbi,
    namedExports: lateNamedExports,
    userFuncs: new Set(ctx.funcs.list.map(f => `$${f.name}`)),
    exportedNames: lateExportedNames,
    funcCount: ctx.funcs.list.length,
    errorSidEntries: [...ctx.schema.errorSidEntries()],
    typedPins: null,
  }

  const __stdlibMark = regionHooks?.mark()
  timePhase(profiler, 'pullStdlib', () => pullStdlib(sec))
  ensureThrowRuntime(sec)
  lateFacts.errorSidEntries = [...ctx.schema.errorSidEntries()]
  lateFacts.typedPins = ctx.linkDemand.typedRuntime
    ? ['$__typed_idx', '$__typed_set_idx', '$__typed_idx_tagged', '$__typed_set_idx_tagged', '$__arr_typed_set_idx', '$__arr_typed_obj_set_idx']
      .filter(name => ctx.core.includes.has(name.slice(1)))
    : []
  if (regionHooks) {
    let lateScope = {
      globals: ctx.scope.globals,
      globalTypes: ctx.scope.globalTypes,
      userGlobals: ctx.scope.userGlobals,
      globalValTypes: ctx.scope.globalValTypes,
      globalTypedLen: ctx.scope.globalTypedLen,
      globalTypedElem: ctx.scope.globalTypedElem,
      staticArrs: ctx.scope.staticArrs,
      constFnArrays: ctx.scope.constFnArrays,
      dvArmFns: ctx.scope.dvArmFns,
    }
    let lateTypes = { arrResized: ctx.types.arrResized, nameEscapes: ctx.types.nameEscapes }
    let lateSchema = { list: ctx.schema.list }
    // pullStdlib only mutates these section arrays. Root them individually;
    // traversing `sec` would also walk every already-durable user function,
    // turning a ~stdlib-only reclaim into a multi-gigabyte full-module copy.
    let lateSections = {
      start: sec.start,
      imports: sec.imports,
      memory: sec.memory,
      extStdlib: sec.extStdlib,
      stdlib: sec.stdlib,
      tags: sec.tags,
    }
    ;[lateSections, lateFacts, lateScope, lateTypes, lateSchema, ctx.transform, ctx.runtime, ctx.memory, ctx.core.includes, ctx.warnings] =
      emissionRoundExit(__stdlibMark, [lateSections, lateFacts, lateScope, lateTypes, lateSchema, ctx.transform, ctx.runtime, ctx.memory, ctx.core.includes, ctx.warnings],
        [DOLLAR_EXTERN, [stdlibParseCacheMap, setStdlibParseCacheMap]])
    sec.start = lateSections.start
    sec.imports = lateSections.imports
    sec.memory = lateSections.memory
    sec.extStdlib = lateSections.extStdlib
    sec.stdlib = lateSections.stdlib
    sec.tags = lateSections.tags
    ctx.scope = lateScope
    ctx.types = lateTypes
    ctx.schema = lateSchema
    ctx.funcs = { list: { length: lateFacts.funcCount } }
    __secRoot = sec
  }

  stripStaticDataPrefix(sec)

  timePhase(profiler, 'optimizeModule', () => optimizeModule(sec, profiler,
    regionHooks ? {
      mark: regionHooks.mark,
      exit: (mark, root) => emissionRoundExit(mark, root),
      forceExit: regionHooks.forceExit || regionHooks.exit,
    } : null))
  if (ctx.transform.helperCallsites) instrumentHelperCallsites([...sec.funcs, ...sec.stdlib, ...sec.start])

  // Fold constant `__start` global inits into immutable inline decls (drops the
  // store, and `__start` with it when that empties it). Runs HERE — after
  // stripStaticDataPrefix and optimizeModule — so any data-segment offset a hoisted
  // pointer carries is already in its final, shifted form (hoisting earlier would
  // freeze a pre-strip offset the shift pass never revisits in the global decl).
  hoistConstGlobalInits(sec)

  // Populate globals (after __start — const folding may update declarations).
  // Records build IR directly — no WAT-text parse-back.
  // The wasm type comes from globalTypes (the canonical name→type map declGlobal
  // maintains alongside the entry), falling back to the entry's own `.type`. They
  // are normally identical, but a global whose entry object is later rebuilt (e.g.
  // hoistConstGlobalInits' `{...g, …}` spread) must not depend on that rebuild
  // preserving `.type` — globalTypes is the stable source, so an entry that lost
  // its `.type` still emits a well-typed `(global …)` rather than `(undefined.const)`.
  sec.globals.push(...[...ctx.scope.globals].filter(([, g]) => g).map(([n, g]) => {
    const ty = ctx.scope.globalTypes.get(n) ?? g.type
    return ['global', `$${n}`,
      ...(g.export ? [['export', `"${g.export}"`]] : []),
      g.mut ? ['mut', ty] : ty,
      [`${ty}.const`, g.init]]
  }))

  // Drop the lazy conversion tables (EL decimal→f64, Ryū float→decimal) whose owner
  // functions no live code calls — must run after sec.globals/funcs are final (exact
  // reachability) and before the data segment below serializes ctx.runtime.data.
  stripDeadLazyTables(sec)

  // Reclaim the trailing run of any OTHER coarsely-interned data (buildStartFn's
  // whole-schema-list table, a stdlib thunk's own string constants — see
  // stripDeadInternedSpans' own doc) that the same exact, final reachability
  // proves dead. Runs after stripDeadLazyTables so a dead lazy table doesn't
  // masquerade as the "true tail" this pass's contiguity check relies on.
  stripDeadInternedSpans(sec)

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
  if (dataLen() && !ctx.memory.shared)
    sec.data.push(['data', ['i32.const', 0], '"' + escBytes(dataString()) + '"'])
  // Shared memory: no active segment at 0 (instances would collide) — ship the
  // static region (static strings + lazy conversion tables) as a PASSIVE segment,
  // memory.init it into __alloc'd space at start, and rebase its consumers:
  // $__staticBase for __static_str, plus each surviving table global (their
  // declared inits hold offsets WITHIN the region — see injectTable/strip).
  else if (dataLen() && ctx.memory.shared && ctx.scope.globals.has('__staticBase')) {
    const len = dataLen()
    sec.data.push(['data', '$__staticData', '"' + escBytes(dataString()) + '"'])
    const inits = [
      ['global.set', '$__staticBase', ['call', '$__alloc', ['i32.const', len]]],
      ['memory.init', '$__staticData', ['global.get', '$__staticBase'], ['i32.const', 0], ['i32.const', len]],
      ['data.drop', '$__staticData'],
      ...(ctx.runtime.lazySpans || []).map(t => ['global.set', `$${t.global}`,
        ['i32.add', ['global.get', '$__staticBase'], ['i32.const', ctx.scope.globals.get(t.global)?.init || 0]]]),
    ]
    let startFn = sec.start.find(n => Array.isArray(n) && n[0] === 'func' && n[1] === '$__start')
    if (!startFn) sec.start.push(startFn = ['func', '$__start'], ['start', '$__start'])
    // insert after the local decls, before any init code (module init may stringify)
    let at = 2
    while (at < startFn.length && Array.isArray(startFn[at]) && startFn[at][0] === 'local') at++
    startFn.splice(at, 0, ...inits)
  }
  // Passive segment for shared-memory string literals (copied via memory.init at runtime)
  if (strPoolLen())
    sec.data.push(['data', '$__strPool', '"' + escBytes(strPoolString()) + '"'])

  // Custom sections "jz:schema" / "jz:errcls" (object schemas + Error-class
  // sid→name map for JS-side interop) are built further down, AFTER the
  // treeshake() call — see the usedSchemaIds block just below it for why
  // (mint-vs-treeshake reconciliation, audit-evidenced size-gate fix).

  // Custom section: rest params for exported functions (JS-side wrapping).
  // Entry per JS-visible export name (not per internal func name) — host's
  // interop.js wrap() keys by export name. Aliased re-export
  // (`function foo (...rest); export { foo as bar }`) needs `bar` in the
  // list; otherwise JS pads the missing args with UNDEF_NAN and the
  // VAL.ARRAY narrow path reads i32 at `__ptr_offset(UNDEF_NAN) - 8`, hitting
  // OOB instead of the polymorphic length-check fallback's tag-aware return-0.
  const restParamFuncs = lateFacts.rest
  if (restParamFuncs.length)
    sec.customs.push(['@custom', '"jz:rest"', `"${JSON.stringify(restParamFuncs).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`])

  // Custom section: per-export externref param positions. interop.js reads
  // this to pass JS arguments straight through at those positions (no
  // `mem.wrapVal`, no SSO encoding). Format: { name, p, d? } where p lists
  // 0-based externref param indices and d (optional) is a map idx→default
  // string for jsstring-carrier params whose default-substitution happens
  // JS-side. Empty list emits nothing.
  const extExports = lateFacts.ext
  if (extExports.length)
    sec.customs.push(['@custom', '"jz:extparam"', `"${JSON.stringify(extExports).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`])

  // jz:i64exp — per-export i64 carrier map (NaN-canonicalization dodging).
  // `{name, p:[i64 param indices], r:1? | m:N?}`: `p` lists params interop
  // passes as BigInt; `r` marks a single result for generic tagged decode;
  // `m` marks an N-lane multi-value result. Pure-numeric single-result
  // exports emit no entry. A proven raw BigInt result is i64 but unmarked.
  // Written under every JS-visible alias, like jz:extparam. Each shape is built as a direct
  // literal (no spread) — the self-compile kernel's fixed schemas don't enumerate post-hoc keys.
  const i64Exports = lateFacts.i64
  if (i64Exports.length)
    sec.customs.push(['@custom', '"jz:i64exp"', `"${JSON.stringify(i64Exports).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`])

  // jz:hostabi — ONE authority for the per-slot host-BigInt ingress policy
  // (phase-c C4b, external audit P0 #1/#2: interop must dispatch on an
  // explicit enum, never guess a slot's policy from the absence of a
  // different signal). Supersedes jz:bigintbox's bare boolean membership
  // (interop used to read "absent" as "reject" with no way to represent a
  // hypothetical proven-raw slot at all). Per export: `raw` lists i64 param
  // indices the plan proved ALWAYS bigint — a plain host bigint would cross
  // with no box (wasm's native BigInt→i64 coercion). ALWAYS EMPTY TODAY:
  // reachability audit (phase-c C4b) — makeBoundaryData (representation-
  // plan.js) sets `uncovered = isExported(...)` unconditionally for every
  // exported function's params, because the JS host can call with ANY value
  // regardless of what the body proves about its own internal call sites.
  // `uncovered` forces `currentParamRep` to ANY_BIGINT (never CLOSED) for
  // any param that may touch bigint at all, which forces `targetRepFor` past
  // both `bigintRepIsClosed(current)` guards straight to BOXED_BIGINT — RAW
  // is only reachable there when `current` is closed, which an exported
  // param's forced-open boundary can never be. Confirmed empirically too:
  // every export-param shape tried (direct bigint arithmetic on a param,
  // typeof-guarded params, BigInt()-converted params) either lands in `tag`
  // below or gets no i64/bigint marking at all — never a bare i64 carrier
  // proven bigint with no box. The field is real (not a placeholder) and
  // reserved: a future closed-world export analysis needs no interop
  // redesign, only a producer for this array. `tag` lists indices the plan
  // proved MAY be bigint (representationHostBoxesParam) — the one reachable
  // evidenced state today; interop boxes a plain bigint via mem.BigInt, wasm
  // dispatches by tag. `rest` (present+truthy only) would mark the
  // REST-ELEMENT policy tagged when the plan can prove bigint evidence for
  // elements past the fixed count — omitted always today: rest elements are
  // host-populated (interop's own mem.Array, never a traceable in-program
  // def site RepresentationPlan's provenance solver can reach), so no
  // evidence source exists yet; interop.js rejects a plain bigint rest
  // element exactly like an unmarked fixed slot. A slot in neither `raw` nor
  // `tag` — the overwhelming common case — carries no BigInt evidence of any
  // kind: reject.
  const hostAbiExports = lateFacts.hostAbi
  if (hostAbiExports.length)
    sec.customs.push(['@custom', '"jz:hostabi"', `"${JSON.stringify(hostAbiExports).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`])

  // Named export aliases: export { name } or export { source as alias }. A `run`/`_start`
  // alias under host:'wasi' emits its natural entry here too — legalizeForTarget (TargetProfile
  // stage, src/optimize/watr-tail.js) rewrites it into the () -> () wrapper afterward, keyed
  // off this same customs entry shape (no wasiCommandExports skip needed).
  sec.customs.push(...lateFacts.namedExports)

  // Whole-module: prune funcs unreachable from entry points (start, exports, elem refs).
  // Removes orphan top-level consts that never get called (e.g. watr's unused `hoist` = 26 KB).
  // Also returns callCount Map (computed during the same walk — used below for funcidx sort).
  // Reachability walk always runs (callCount feeds the sort even when shake is off);
  // actual removal gated by ctx.transform.optimize.treeshake.
  const optCfg = ctx.transform.optimize
  const { callCount } = treeshake(
    [{ arr: sec.stdlib }, { arr: sec.funcs }, { arr: sec.start }],
    [...sec.start, ...sec.elem, ...sec.customs, ...sec.extStdlib, ...sec.imports, ...sec.tags],
    { removeDead: !optCfg || optCfg.treeshake !== false, globals: sec.globals, userGlobals: ctx.scope.userGlobals,
      userFuncs: lateFacts.userFuncs }
  )

  // Custom sections "jz:schema" / "jz:errcls": object schemas + Error-class
  // sid→name map, for JS-side interop (interop.js). Built HERE — after
  // treeshake, not before — because the MINT (module/schema.js's
  // ctx.schema.register/errorSid) and the SERIALIZE step can now legitimately
  // disagree: emitLengthAccess (module/core.js) and Array.from's general path
  // (module/array.js) mint 'TypeError' eagerly and unconditionally the moment
  // either is visited during emission (commit 8954dac2 — load-bearing, keeps
  // the schema minted before O0 catch/property planning freezes schema
  // tables; do not make this conditional). But a later pass can still
  // constant-fold away the one call that would have used it, or treeshake
  // above can remove the whole function around it — so by this point some
  // minted schema ids may have zero surviving constructors. Serializing
  // straight from ctx.schema.list/errorSidEntries (as before) shipped every
  // schema ever minted, dead or not — the audited size-gate regression
  // (aos/dotprod/wav/callback, e867c3af's opaque-length TypeError).
  //
  // A schema id is reconciled as LIVE iff some surviving `$__mkptr` call still
  // carries it as the AUX (2nd) literal argument — mkPtrIR's (src/ir.js) only
  // construction path for a PTR.OBJECT pointer, and thus the only way any
  // value tagged with that schema id can ever come to exist, be observed by
  // an in-wasm `instanceof`/catch dispatch, or cross the host boundary for
  // interop.js to decode. optimizeModule's specializeMkptr
  // (src/optimize/index.js), which runs earlier in this same compile, may
  // already have rewritten a literal-aux call site from
  // `(call $__mkptr (i32.const T) (i32.const A) dyn)` into a named variant
  // `$__mkptr_T_A_d` — both shapes are scanned. A call whose aux is NOT a
  // literal (a dynamic clone/copy helper forwarding some other value's
  // already-tagged type+aux) needs no separate accounting: it can only ever
  // reproduce a sid some OTHER, literal-bearing site already established for
  // a value that must already exist, so that other site is what makes it
  // live. Over-approximating (treating a schema as live when the strict
  // answer is dead) is always safe — it only costs bytes; under-approximating
  // would silently corrupt a live interop decode, so every literal-aux
  // `$__mkptr`/`$__mkptr_*` call site found here counts, unconditionally.
  const usedSchemaIds = new Set()
  {
    // No RegExp anywhere in this scan — deliberately. This code is compiler-
    // internal (src/compile/index.js), and the KERNEL (dist/jz.wasm) is jz's
    // own compiler self-compiled — so THIS scan is itself self-hosted and
    // runs INSIDE the kernel every time it compiles ANY program. A regex-
    // literal version of this exact scan passed every native/JS-hosted check
    // but broke kernel-only ('kernel O0') behavior — some self-hosted-vs-V8
    // regex discrepancy this file had never exercised before (grep confirms
    // zero prior RegExp use in this file). Plain charCodeAt scanning is the
    // same idiom src/wat/assemble.js's stripRenameRuns and src/early-errors.js/
    // src/static-data.js's own hex decoding already rely on inside the
    // self-hosted kernel — proven safe, not a new risk.
    const isDigit = (c) => c >= 48 && c <= 57  // '0'-'9'
    const isHexDigit = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)  // 0-9 A-F a-f
    const allDigits = (s, i, end) => { if (i >= end) return false; for (; i < end; i++) if (!isDigit(s.charCodeAt(i))) return false; return true }
    const allHexDigits = (s, i, end) => { if (i >= end) return false; for (; i < end; i++) if (!isHexDigit(s.charCodeAt(i))) return false; return true }
    // i32.const operands are JS numbers when built directly by IR-construction
    // code (mkPtrIR) but plain numeric STRINGS when a hand-written WAT-text
    // stdlib template (e.g. module/core.js's __throw_property_nullish) comes
    // back through the WAT parser untouched by any literal-normalizing pass —
    // accept either.
    const litI32 = (n) => {
      if (!Array.isArray(n) || n[0] !== 'i32.const') return null
      if (typeof n[1] === 'number') return n[1]
      if (typeof n[1] !== 'string' || !n[1].length) return null
      const neg = n[1].charCodeAt(0) === 45  // '-'
      return allDigits(n[1], neg ? 1 : 0, n[1].length) ? +n[1] : null
    }
    // mkPtrIR (src/ir.js) folds a construction straight to `(f64.const nan:HHHHHHHHLLLLLLLL)`
    // — 8 hex digits of type+aux (hi word) + 8 of offset (lo word), see layout.js's
    // i64Hex/ptrBits — whenever ALL THREE args are compile-time literals. That is
    // NOT rare for PTR.OBJECT the way a heap `$__alloc_hdr` offset would suggest:
    // an object literal whose every slot is itself a literal (`mk = () => ({a:111,
    // b:222,c:333})` — this exact test's shape) gets its whole allocation constant-
    // folded away by an earlier pass, and mkPtrIR then folds the now-literal offset
    // too. specializeMkptr's own pass-3 (src/optimize/index.js) produces the
    // identical `f64.const nan:...` shape for the same reason, and its inline
    // fast path (and narrow.js's devirt re-boxing of an already-unboxed offset —
    // this test's `chase`) OR a bare `i64.const 0xHHHHHHHH00000000` "box prefix"
    // against a dynamic offset instead — same hi word, no `nan:` text wrapper.
    // Anchored to the exact node shapes that carry the literal (not "any string
    // leaf anywhere" — an unrelated i64 bit-mask constant elsewhere in the
    // module, coincidentally 16 hex digits, would over-match and cost real
    // bytes on a strict win-limit gate like dotprod/wav; false-KEEPS are safe
    // for correctness but not for the size gate this fix exists to close). A
    // constant-pooling pass (optimizeModule's hoistConstantPool, which — like
    // specializeMkptr — runs before treeshake) can lift a repeated packed
    // pointer literal out of its call site into a `(global $g ...)` init or a
    // `global.set` inside `$__start`'s body, leaving only `global.get $g`
    // where the literal used to be — scanning sec.globals/sec.elem below
    // (their init/offset exprs use these SAME `f64.const`/`i64.const` shapes)
    // catches that relocation without widening the match itself.
    // PTR.OBJECT-gated: `aux` is only ever a schema id for that one ptr type —
    // every other PTR.* (STRING's SSO/intern bits, TYPED's element code, …)
    // packs something else entirely into the identical bit position, and a
    // hoisted/pooled literal of THEIRS would otherwise false-match the same
    // 16-hex-digit shape and cost bytes on dotprod/wav's strict win gate.
    // Optional "nan:" prefix, then "0x", then exactly 16 hex digits (8 hi + 8
    // lo — layout.js's i64Hex format), nothing else. Returns the FULL 64-bit
    // value as a BigInt, or null. BigInt, not a JS number split into a "hi
    // word": layout.js's own comment ("BigInt views of the NaN-box fields —
    // the carrier is 64-bit, JS bit-ops are 32-bit") is exactly the trap
    // decodePtrType/decodePtrAux (also layout.js, but the plain-number-typed
    // decode side, never previously self-hosted) fell into here — this file's
    // hi word can legitimately exceed 2^31 (PTR.OBJECT's own tag bits push it
    // past the sign boundary), and self-hosted `>>>`/`&` on such a value
    // decoded the wrong type/aux, silently dropping a live schema INSIDE the
    // kernel's own compiles (never reproduced natively — this is why
    // `runNative` always agreed and only `runKernel` broke). Extracting type/
    // aux with the identical BigInt shift+mask ptrBits uses to ENCODE them
    // sidesteps the 32-bit boundary entirely, in the one representation
    // already proven correct under self-compilation.
    const TAG_SHIFT_BIG = BigInt(LAYOUT.TAG_SHIFT), TAG_MASK_BIG = BigInt(LAYOUT.TAG_MASK)
    const AUX_SHIFT_BIG = BigInt(LAYOUT.AUX_SHIFT), AUX_MASK_BIG = BigInt(LAYOUT.AUX_MASK)
    const parsePackedBits = (s) => {
      let i = 0
      if (s.startsWith('nan:')) i = 4
      if (s.charCodeAt(i) !== 48 || s.charCodeAt(i + 1) !== 120) return null  // "0x"
      i += 2
      return s.length === i + 16 && allHexDigits(s, i, i + 16) ? BigInt('0x' + s.slice(i)) : null
    }
    const scanMkptrAux = (n) => {
      if (!Array.isArray(n)) return
      if ((n[0] === 'f64.const' || n[0] === 'i64.const') && typeof n[1] === 'string') {
        const bits = parsePackedBits(n[1])
        if (bits != null && (bits >> TAG_SHIFT_BIG & TAG_MASK_BIG) === BigInt(PTR.OBJECT))
          usedSchemaIds.add(Number(bits >> AUX_SHIFT_BIG & AUX_MASK_BIG))
      } else if ((n[0] === 'call' || n[0] === 'return_call') && typeof n[1] === 'string') {
        // `return_call` (tail-call form — treeshake's own CALL_OPS set above
        // treats it identically to `call`): a single-expression arrow whose
        // whole body is the construction, `x => new TypeError(x)`, compiles
        // the final mkptr as a tail call, not an ordinary one — missing this
        // dropped a genuinely-returned (not even thrown) TypeError's schema.
        if (n[1] === '$__mkptr') {
          const type = litI32(n[2]), aux = litI32(n[3])
          if (type === PTR.OBJECT && aux != null) usedSchemaIds.add(aux)
        } else if (n[1].startsWith('$__mkptr_')) {
          // specializeMkptr's variantName: '__mkptr_' + 3 underscore-joined
          // parts, each either 'd' (dynamic) or a decimal literal — see its
          // own definition (src/optimize/index.js) for the exact join.
          const parts = n[1].slice(9).split('_')
          if (parts.length === 3 && parts[0] === String(PTR.OBJECT) &&
              parts[1] !== 'd' && allDigits(parts[1], 0, parts[1].length)) usedSchemaIds.add(+parts[1])
        }
      }
      for (const c of n) scanMkptrAux(c)
    }
    // Exactly the arrays treeshake() above just pruned to their final surviving
    // shape, PLUS sec.globals (a hoisted constant's init lives there, and
    // treeshake's own dead-global elimination — the `globals:` opt above —
    // already dropped any global nothing references) and sec.elem (function
    // table entries can't relocate a pointer literal but cost nothing to
    // include). sec.extStdlib/imports are import declarations only, never a
    // construction site.
    for (const arr of [sec.stdlib, sec.funcs, sec.start, sec.globals, sec.elem]) for (const f of arr) scanMkptrAux(f)
  }
  if (usedSchemaIds.size) {
    // Positional format (entry index === schema id, no key per entry — see
    // STABILITY.md's "raw custom sections stay experimental": the byte FORMAT
    // is unchanged here, only which entries carry real content). A dead id's
    // slot must still be emitted, to keep every live id's position correct —
    // varint(nSchemas) below stays ctx.schema.list.length either way.
    //
    // NOT emitted empty (`[]`) — interop.js's own ingestion (enhance(), the
    // `newSchemas`/`schemas` merge loop) deduplicates incoming entries by
    // CONTENT (`s.join(',')`) before appending, then indexes the merged array
    // directly BY SID (`mem.schemas[aux(p)]`, decodeThrown's schema lookup).
    // `[].join(',')` is `''` for every dead entry alike, so two-plus zeroed
    // entries collide on that one key, the dedupe silently keeps only the
    // first and drops the rest, and EVERY live sid positioned after the first
    // collision then indexes the wrong (shifted) array slot — reproduced
    // exactly this way: the self-hosted kernel's own `Error`/`TypeError`/
    // `SyntaxError` schemas decoded fine in isolation (verified byte-for-byte
    // correct in the built jz:schema section) but the kernel oracle's
    // ambiguous-BOOL|NUMBER reject still lost its message, because some
    // OTHER dead schema earlier in its (825-entry) list collided with
    // another and shifted every later sid's runtime array position. A
    // one-element placeholder keyed by the id itself (`[String(id)]`) is
    // unique per dead entry — collides with nothing else dead, and
    // collision with a live entry is no more likely than any other
    // pre-existing content collision this dedupe already tolerates — while
    // still costing far fewer bytes than the real prop list it replaces.
    const bytes = []
    const utf8 = new TextEncoder()
    const varint = (n) => { while (n >= 0x80) { bytes.push((n & 0x7F) | 0x80); n >>>= 7 } bytes.push(n) }
    const enc = (p) => {
      if (p === null) bytes.push(0)
      else if (Array.isArray(p)) { bytes.push(1); enc(p[1]) }
      else { bytes.push(2); const b = utf8.encode(p); varint(b.length); for (const x of b) bytes.push(x) }
    }
    varint(ctx.schema.list.length)
    ctx.schema.list.forEach((props, id) => {
      const live = usedSchemaIds.has(id) ? props : [String(id)]
      varint(live.length); for (const p of live) enc(p)
    })
    sec.customs.push(['@custom', '"jz:schema"', bytes])
  }
  // jz:errcls has an explicit sid per entry (unlike jz:schema above), so a
  // dead class is simply omitted rather than zeroed.
  if (ctx.schema.errorSidEntries?.().size) {
    const entries = [...ctx.schema.errorSidEntries()].filter(([sid]) => usedSchemaIds.has(sid))
    if (entries.length) {
      const bytes = []
      const utf8 = new TextEncoder()
      const varint = (n) => { while (n >= 0x80) { bytes.push((n & 0x7F) | 0x80); n >>>= 7 } bytes.push(n) }
      varint(entries.length)
      for (const [sid, name] of entries) {
        varint(sid)
        const b = utf8.encode(name)
        varint(b.length)
        for (const x of b) bytes.push(x)
      }
      sec.customs.push(['@custom', '"jz:errcls"', bytes])
    }
  }

  pruneUnusedThrowRuntime(sec)

  // WASI reactor `_initialize` conversion (the p1 ABI forbids WASI calls inside the wasm
  // start section — top-level console.log/Date.now crashed with "Cannot read properties of
  // null" since no host can service them before `new WebAssembly.Instance` finishes wiring
  // memory) used to run here, mutating `sec.start`/`sec.funcs` in place. It's target
  // legalization now (src/optimize/watr-tail.js legalizeForTarget), ported onto the fully
  // assembled `['module', …]` tree together with the command-entry rewrite above — see that
  // function's doc comment. `sec.start`'s `$__start` func and its `(start …)` directive are
  // left exactly as built here; legalizeForTarget finds `$__start` by name and does the
  // `_initialize` conversion + self-arming guard injection from there.

  // Reorder non-import funcs by call count: hot callees get low LEB128 indices.
  // `call $f` encodes funcidx as ULEB128 (1 B for idx < 128, 2 B for idx < 16384).
  // On watr self-compile this saves ~6 KB (hot specialized helpers migrate to idx < 128).
  // callCount was computed inline by treeshake's walk (same set of nodes).
  const byCalls = (a, b) => (callCount.get(b[1]) || 0) - (callCount.get(a[1]) || 0)
  const startFn = sec.start.find(n => n[0] === 'func')
  const startDir = sec.start.find(n => n[0] === 'start')
  const sortedFuncs = [
    ...sec.stdlib, ...sec.funcs, ...(startFn ? [startFn] : []),
  ].sort(byCalls)

  // BindingId suffixes off the WAT surface LAST — every internal pass keys
  // facts (distinctParams, boxed cells, alias bases) by the full renamed
  // spelling; stripping earlier desyncs those sets from the tokens (the
  // param-distinctness LICM pin caught exactly that). Display-only: binaries
  // carry no name section.
  stripLocalRenameSuffixes(sortedFuncs)

  // Assemble: named slots → flat section list.
  const sections = [
    ...sec.extStdlib, ...sec.imports, ...sec.types, ...sec.memory, ...sec.data,
    ...sec.tags, ...sec.table, ...sec.globals, ...sortedFuncs,
    ...sec.elem, ...(startDir ? [startDir] : []), ...sec.customs,
  ]
  let builtModule = ['module', ...sections]
  // Region-arena Slice 3 (union-field root, Slice C-v2 — `.work/compile-
  // session-design.md` §2.1/§3, front.js's own doc has the full rationale):
  // exit the emit round here, rebinding `builtModule` (phase-local, not
  // durable ctx state) and every `ctx.*` field any round needs, including
  // both `ctx.func` AND `ctx.funcs` (see .work/research.md §Region arena for
  // the root-completeness requirement), without exposing `ctx.core`/
  // `ctx.bridge`/etc to the relocator, which don't need it. Any later read
  // through a stale `ctx.*` or the pre-relocation `builtModule` reference is
  // a use-after-free, the identical contract frontHalf's own rebind
  // documents.
  if (regionHooks?.releaseSession) {
    // The wasm-hosted compiler immediately feeds this module to the WAT tail;
    // it never observes analysis/session internals after compileAst returns.
    // Preserve only immutable optimizer facts and a compact boundary summary,
    // rather than copying every AST, FunctionPlan and analysis cache alongside
    // the already-large emitted module at the final region boundary.
    const cfg = ctx.transform.optimize
    const boundaryPins = [
      ...(cfg?._vectorizedFnNames?.size
        ? [...cfg._vectorizedFnNames].filter(name => lateFacts.exportedNames.has(name.slice(1)))
        : []),
      ...lateFacts.typedPins,
    ]
    let released = {
      transform: ctx.transform,
      funcs: { list: { length: lateFacts.funcCount } },
      scope: {
        globalValTypes: ctx.scope.globalValTypes,
        globalTypedLen: ctx.scope.globalTypedLen,
        globalTypedElem: ctx.scope.globalTypedElem,
        staticArrs: ctx.scope.staticArrs,
        constFnArrays: ctx.scope.constFnArrays,
        dvArmFns: ctx.scope.dvArmFns,
      },
      types: { arrResized: ctx.types.arrResized, nameEscapes: ctx.types.nameEscapes },
      schema: { list: ctx.schema.list },
      includes: ctx.core.includes,
      warnings: ctx.warnings,
      diagSink: ctx.core.diagSink,
      tail: { funcCount: lateFacts.funcCount, boundaryPins, targetProfile: ctx.transform.targetProfile },
    }
    ;[builtModule, released] = (regionHooks.finalExit || regionHooks.exit)(__regionMark, [builtModule, released])
    ctx.transform = released.transform
    ctx.funcs = released.funcs
    ctx.scope = released.scope
    ctx.types = released.types
    ctx.schema = released.schema
    ctx.core.includes = released.includes
    ctx.warnings = released.warnings
    ctx.core.diagSink = released.diagSink
    ctx.transform._regionTail = released.tail
  } else if (regionHooks) {
    [builtModule, ctx.func, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.transform, ctx.facts] =
      regionHooks.exit(__regionMark, [builtModule, ctx.func, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.transform, ctx.facts])
  }
  return builtModule
}
