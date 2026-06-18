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

import parseWat from 'watr/parse'
import { ctx, err, inc, resolveIncludes, PTR, LAYOUT, declGlobal } from '../ctx.js'
import { T, isBlockBody, isReassigned, refsName, REFS_IN_EXPR } from '../ast.js'
import { intLiteralValue } from '../static.js'
import {
  analyzeBody, unboxablePtrs, cseSafeLoadBases, boxedCaptures,
  analyzeStructInline, invalidateLocalsCache,
} from './analyze.js'
import { typedElemAux } from '../../layout.js'
import { VAL, updateRep, REP_FIELDS } from '../reps.js'
import { inferLocals } from './infer.js'
import { optimizeFunc, treeshake } from '../optimize/index.js'
import { strengthReduceLoopDivMod } from './loop-divmod.js'
import { peelClampedStencil } from './peel-stencil.js'
import { emit, emitter, emitVoid, emitBlockBody } from './emit.js'
import { emitCharDecompPrologue, JSS_IMPORT_SIGS } from '../abi/string.js'
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
  boolBoxIR,
  I32_MIN, I32_MAX, dollar,
} from '../ir.js'
import plan from './plan/index.js'
import { foldStaticConstAggregates } from './plan/literals.js'
import {
  buildStartFn, dedupClosureBodies, finalizeClosureTable,
  pullStdlib, syncImports, optimizeModule, stripStaticDataPrefix, hoistConstGlobalInits,
} from '../wat/assemble.js'

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

/** Collect JS-visible export names that resolve to `funcName` (as an array).
 *  Used to emit per-export ABI metadata in custom sections — one entry per
 *  JS-visible name, since the host (interop.js wrap) keys by export name. */
function exportNamesOf(funcName) {
  const names = []
  for (const [key, val] of Object.entries(ctx.func.exports)) {
    if ((val === true && key === funcName) || val === funcName) names.push(key)
  }
  return names
}

const timePhase = (profiler, name, fn) => profiler?.time ? profiler.time(name, fn) : fn()

// Per-compile func name set + map live on ctx.func.names / ctx.func.map,
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
  if (!isExported(func) || func.raw || func.sig.results.length !== 1) return false
  if (func.sig.results[0] !== 'f64' || func.sig.ptrKind != null) return true
  // A boolean result rides the 0/1 number carrier internally; the export thunk
  // boxes it to the TRUE_NAN/FALSE_NAN atom so the host sees a real boolean.
  if (func.valResult === VAL.BOOL) return true
  // A bigint result rides the i64-reinterpreted-f64 carrier internally; the export thunk converts
  // it to a real Number so a JS host doesn't see raw i64 bits (`() => 100n` was returning 4.94e-322).
  if (func.valResult === VAL.BIGINT) return true
  return func.sig.params.some(p => p.type !== 'f64' || p.ptrKind != null)
}

// Static-string intern index (the `internStrings` pass). Open-addressing table
// over the deduped static string literals (5–32 bytes): [hash u32][ptr u32]
// pairs appended to the data segment, FNV-1a matching __str_hash's heap branch.
// __str_slice/__str_slice_view probe it so a runtime substring whose content
// equals any source literal returns the CANONICAL static pointer — string
// equality then short-circuits on bit-eq instead of walking bytes (a compiler
// or parser compares each token against tag literals many times; ~25% of
// self-host compile time was __str_eq/__eq/__str_hash volume). Built before
// pullStdlib (the slice thunks emit the probe only when `__internBase` exists);
// stripStaticDataPrefix shifts the stored ptr slots like every other static
// reference. Misses cost one FNV + one probe per slice; the table is read-only.
function buildInternTable() {
  const cfg = ctx.transform.optimize
  if (!cfg || cfg.internStrings === false) return
  if (ctx.memory.shared || !ctx.runtime.dataDedup?.size) return
  const enc = new TextEncoder()
  const entries = []
  for (const [str, off] of ctx.runtime.dataDedup) {
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
  while (ctx.runtime.data.length % 8 !== 0) ctx.runtime.data += '\0'
  const base = ctx.runtime.data.length
  let s = ''
  for (let i = 0; i < slots.length; i++) {
    const v = slots[i]
    s += String.fromCharCode(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF)
  }
  ctx.runtime.data += s
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

// Drop the $__jz_err tag + __jz_last_err_bits globals when optimization
// eliminated every actual throw site. ensureThrowRuntime runs before
// optimizeModule so dead-throw analysis can see the tag/global as live; once
// opt has finished, an unused tag still forces consumers (wasmtime, wasm2c) to
// enable the exceptions proposal just to parse the module. User-written
// throw/try/catch/finally is an ABI contract (JS-side may inspect
// __jz_last_err_bits), so `userThrows` keeps the runtime declared regardless;
// the prune fires only when `throws` was set purely by stdlib pattern matching
// or compiler-internal coercion sites.
const pruneUnusedThrowRuntime = (sec) => {
  if (!ctx.runtime.throws || ctx.runtime.userThrows) return
  const hasThrow = (n) => Array.isArray(n) && (n[0] === 'throw' || n.some(hasThrow))
  for (const arr of [sec.funcs, sec.stdlib, sec.start])
    for (const f of arr) if (hasThrow(f)) return
  sec.tags = sec.tags.filter(t => !(Array.isArray(t) &&
    ((t[0] === 'tag' && t[1] === '$__jz_err') ||
     (t[0] === 'export' && t[1] === '"__jz_last_err_bits"'))))
  sec.globals = sec.globals.filter(g => !(Array.isArray(g) &&
    g[0] === 'global' && g[1] === '$__jz_last_err_bits'))
  ctx.scope.globals.delete('__jz_last_err_bits')
}

// === Module compilation ===

const cloneRepMap = map => map ? new Map([...map].map(([k, v]) => [k, { ...v }])) : null

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

function scanAndTagNonEscapingClosures(body) {
  if (!body) return
  const onlyCalledNotReferenced = (node, name) => {
    if (typeof node === 'string') return node !== name
    if (!Array.isArray(node)) return true
    const op = node[0]
    if (op === 'str') return true
    if (op === '=>') {
      return !refsName(node[1], name, REFS_IN_EXPR) && !refsName(node[2], name, REFS_IN_EXPR)
    }
    if (op === '=' && node[1] === name) {
      return onlyCalledNotReferenced(node[2], name)
    }
    if (op === '()' && node[1] === name) {
      for (let i = 2; i < node.length; i++) {
        if (!onlyCalledNotReferenced(node[i], name)) return false
      }
      return true
    }
    if (op === '.' || op === '?.') return onlyCalledNotReferenced(node[1], name)
    if (op === ':') return onlyCalledNotReferenced(node[2], name)
    for (let i = 1; i < node.length; i++) {
      if (!onlyCalledNotReferenced(node[i], name)) return false
    }
    return true
  }

  const walk = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === 'let' || op === 'const') {
      for (const decl of node.slice(1)) {
        if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string') {
          const name = decl[1]
          const init = decl[2]
          if (Array.isArray(init) && init[0] === '=>') {
            const arrow_body = init[2]
            if (arrow_body && typeof arrow_body === 'object' && !ctx.func.boxed?.has(name) && !isGlobal(name) && !isReassigned(body, name) && onlyCalledNotReferenced(body, name)) {
              arrow_body._nonEscaping = name
            }
          }
        }
      }
    } else if (op === '=' && typeof node[1] === 'string' && Array.isArray(node[2]) && node[2][0] === '=>') {
      const name = node[1]
      const init = node[2]
      const arrow_body = init[2]
      if (arrow_body && typeof arrow_body === 'object' && !ctx.func.boxed?.has(name) && !isGlobal(name) && !isReassigned(body, name) && onlyCalledNotReferenced(body, name)) {
        arrow_body._nonEscaping = name
      }
    }
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(body)
}

// Reset per-function emit-frame state — the single source of frame entry.
// `emitFunc`, `analyzeFuncForEmit`, and `emitClosureBody` all route through
// here. Top-level funcs start `uniq` at 0; closures pass a higher base so
// their synthetic labels can't collide with the parent frame's.
function enterFunc(sig, body, { uniq = 0, directClosures = null } = {}) {
  ctx.func.stack = []
  ctx.func.maybeNullish = new Set()   // bindings assigned a nullish literal → coerce in arithmetic (null-flow)
  ctx.func.pendingLabel = null        // label awaiting its loop, for `continue <label>`
  ctx.func.uniq = uniq
  ctx.func.current = sig
  ctx.func.body = body
  ctx.func.directClosures = directClosures
  ctx.func.localProps = null
  ctx.func.charDecomp = null
  if (ctx.transform.optimize) {
    scanAndTagNonEscapingClosures(body)
  }
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
  // Edge-clamp peeling: split a clamped stencil loop into clamp-free interior + edges
  // (the interior then lifts to SIMD). Before analyze so the new loops are analyzed.
  if (_o && _o.clampPeel !== false && isBlockBody(func.body)) func.body = peelClampedStencil(func.body)

  const { name, body, sig } = func
  enterFunc(sig, body)

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
  // Trust numeric export params. An exported f64 param used only in numeric
  // positions is marked VAL.NUMBER so its uses skip the `__to_num` coercion
  // entirely (not just hoist it). External callers reach jz through interop's
  // `mem.wrapVal`, which passes a JS number straight to f64 — so the coercion
  // only ever fired for a *string* arg to a numeric param (a type misuse). When
  // that lone coercion is the only `__to_num` consumer, dropping it lets the whole
  // ToNumber string-parse dep tree (`__to_str`→`__itoa`/`__toExp`/`__mkstr`/…)
  // treeshake away — a ~4× module shrink that, decisively, lets V8 tier the hot
  // fill loop up properly (the bloated module JITs the *identical* loop ~2× slower).
  if (func.exported && block) {
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
  if (block) {
    seedLocalIntConsts(body)
  }
  // Drop any earlier-cached analyzeBody.locals slice for this body —
  // narrowSignatures called it before our pre-seed, when params still had no
  // inferred VAL.TYPED, so the cached widths reflect the pre-narrow state.
  // Re-walk now with reps in place.
  invalidateLocalsCache(body)
  const bodyFacts = block ? analyzeBody(body) : null
  ctx.func.locals = bodyFacts ? bodyFacts.locals : new Map()
  if (bodyFacts?.valTypes) {
    for (const [name, vt] of bodyFacts.valTypes) updateRep(name, { val: vt })
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
  for (const p of sig.params) {
    if (p.jsstring) updateRep(p.name, { carrier: 'jsstring', val: VAL.STRING })
  }

  // CSE-safe load bases — pointer locals whose memory reads `cseScalarLoad`
  // may scalar-replace. Computed last: needs every `let`/param ptrKind in place.
  const cseLoadBases = block
    ? cseSafeLoadBases(body, ctx.func.locals, ctx.func.localReps)
    : new Set()

  // Closure-capture narrowing: a boxed var whose every defining RHS — owner
  // body AND nested arrows, the narrower's intCertain contract — is integer-
  // valued keeps its CELL in i32, so readVar/writeVar skip the f64↔i32
  // round-trip per access. Params are excluded: their cell is seeded from the
  // raw f64 param value, which would desync an i32-read cell. Same asm.js-style
  // range contract as plain intCertain locals.
  const cellTypes = new Set()
  for (const name of ctx.func.boxed.keys()) {
    if (sig.params.some(p => p.name === name)) continue
    if (ctx.func.localReps?.get(name)?.intCertain === true) cellTypes.add(name)
  }

  return {
    block,
    locals: new Map(ctx.func.locals),
    boxed: new Map(ctx.func.boxed),
    cellTypes,
    flatObjects: new Map(ctx.func.flatObjects),
    sliceViews: new Set(ctx.func.sliceViews),
    cseLoadBases,
    typedElem: ctx.types.typedElem ? new Map(ctx.types.typedElem) : null,
    localReps: cloneRepMap(ctx.func.localReps),
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

// `=`/`+=`/`++`/… targets — reassigning the param breaks the coerce-once premise.
const PARAM_REASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=',
  '^=', '>>=', '<<=', '>>>=', '||=', '&&=', '??=', '++', '--'])
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
    if (PARAM_REASSIGN_OPS.has(op) && names.has(node[1])) { ok = false; return }
    if (NUM_BIN_OPS.has(op) && node.length === 3) {     // numeric binary: operands are ToNumber'd
      numOperand(node[1]); numOperand(node[2])
      return
    }
    if (REL_OPS.has(op) && node.length === 3) {         // relational: numeric unless a known string is present
      if (isStrLiteral(node[1]) || isStrLiteral(node[2])) { ok = false; return }
      numOperand(node[1]); numOperand(node[2])
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
      const fn = ctx.func.map?.get(node[1])
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
    if (op === '=>') return                                  // shadowing-safe: closure handled conservatively (escape)
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

  enterFunc(sig, body)
  const block = funcFacts.block
  ctx.func.locals = new Map(funcFacts.locals)
  ctx.func.boxed = new Map(funcFacts.boxed)
  ctx.func.cellTypes = new Set(funcFacts.cellTypes)
  ctx.func.flatObjects = new Map(funcFacts.flatObjects)
  ctx.func.sliceViews = new Set(funcFacts.sliceViews)
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
  // Stamp the emit-side CSE soundness whitelist onto the func node (expando —
  // watr print/compile ignore non-index props). `cseScalarLoad` reads it; absent
  // it the pass is a no-op. `$`-prefixed to match WAT local names directly.
  if (funcFacts.cseLoadBases?.size)
    fn.cseLoadBases = new Set([...funcFacts.cseLoadBases].map(n => `$${n}`))
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
    defaultInits.set(pname,
      ['if', isUndef(typed(['local.get', `$${pname}`], 'f64')),
        ['then', ['local.set', `$${pname}`, t === 'f64' ? asF64(emit(defVal)) : asI32(emit(defVal))]]])
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
    for (const p of sig.params) {
      const di = defaultInits.get(p.name)
      if (di) inits.push(di)
      const dec = ctx.func.charDecomp?.get(p.name)
      if (dec) inits.push(...emitCharDecompPrologue(dec))
    }
    return inits
  }

  if (block) {
    const stmts = emitBlockBody(body)
    // Hoist loop-invariant `__to_num(param)` coercions to a single entry rebind.
    const numCoerceInits = hoistInvariantParamCoercions(stmts, func)
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
    fn.push(...paramInits, ...boxedParamInits, ...preboxedLocalInits, ...numCoerceInits, ...stmts, ...fallthrough)
  } else if (multi && body[0] === '[') {
    const values = body.slice(1).map(e => asF64(emit(e)))
    const paramInits = collectParamInits()
    for (const [l, t] of ctx.func.locals) fn.push(['local', dollar(l), t])
    fn.push(...paramInits, ...boxedParamInits, ...preboxedLocalInits, ...values)
  } else {
    const ir = emit(body)
    const paramInits = collectParamInits()
    for (const [l, t] of ctx.func.locals) fn.push(['local', dollar(l), t])
    const finalIR = sig.ptrKind != null ? asPtrOffset(ir, sig.ptrKind) : asParamType(ir, sig.results[0])
    fn.push(...paramInits, ...boxedParamInits, ...preboxedLocalInits, tcoTailRewrite(finalIR, sig.results[0]))
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
    // Quiet NaN-box ABI: every boundary value is f64. A number is a plain f64; a
    // tagged value (heap pointer, null/undef/bool atom) is an f64 whose quiet-NaN
    // (0x7FF8…) payload carries the tag. Quiet-NaN payloads are preserved across the
    // JS↔wasm call boundary by every real engine (and non-JS hosts don't canonicalize
    // at all), so no i64 carrier is needed — the wasm signature is self-describing
    // (f64 everywhere) and a consumer discriminates a tagged value by the NaN prefix.
    // Env requirement: a non-canonicalizing NaN boundary. To support a canonicalizing
    // engine, a per-position i64 carrier would re-enter here (param/result type i64 +
    // `i64.reinterpret_f64`) plus a `jz:i64exp` section for interop.js.
    const resultBool = func.valResult === VAL.BOOL && sig.ptrKind == null
    const resultBigint = func.valResult === VAL.BIGINT && sig.ptrKind == null
    // Inline `(export ...)` attribute only when the func decl carried the
    // inline-export keyword (`export function foo`). For re-exports
    // (`function foo; export { foo as bar }`) the `name` is the *internal*
    // symbol; sec.customs holds the JS-visible export pointing at this
    // wrapper. Emitting an inline attribute here under the internal name
    // would leak the symbol publicly and collide with the customs entry.
    const wrapNode = func.exported
      ? ['func', `$${name}$exp`, ['export', `"${name}"`]]
      : ['func', `$${name}$exp`]
    // jsstring params flow as externref end-to-end; every other boundary value is f64.
    sig.params.forEach((p) => {
      wrapNode.push(['param', `$${p.name}`, p.jsstring ? 'externref' : 'f64'])
    })
    wrapNode.push(['result', resultBigint ? 'i64' : 'f64'])
    const args = sig.params.map((p) => {
      const get = ['local.get', `$${p.name}`]
      // jsstring: externref flows through unchanged — inner func also takes externref.
      if (p.jsstring) return get
      // ptrKind param: the f64 NaN-box carries the pointer — extract the i32 offset.
      if (p.ptrKind != null) return ['i32.wrap_i64', ['i64.reinterpret_f64', get]]
      if (p.type === 'f64') return get
      // Numeric narrowing: f64 → i32 truncate
      return ['i32.trunc_sat_f64_s', get]
    })
    const callIR = ['call', `$${name}`, ...args]
    let body
    if (sig.ptrKind != null) {
      const ptrType = valKindToPtr(sig.ptrKind)
      body = mkPtrIR(ptrType, sig.ptrAux ?? 0, callIR)
    } else if (resultBool) {
      // The inner func returns a clean 0/1 boolean carrier — never NaN. The i32
      // carrier already takes truthyIR's identity path; the f64 carrier would
      // otherwise fall through to the full __is_truthy NaN-discrimination, every
      // arm of which is dead for a boolean. Pull the bit out with one f64.ne so
      // boolBoxIR boxes `4|bit` straight into the TRUE_NAN/FALSE_NAN atom.
      const carrier = sig.results[0] === 'i32'
        ? typed(callIR, 'i32')
        : typed(['f64.ne', callIR, ['f64.const', 0]], 'i32')
      body = boolBoxIR(carrier)
    } else if (resultBigint) {
      // BigInt rides the i64-reinterpret-f64 carrier internally; expose the raw i64 at the JS
      // boundary so the host receives a real, lossless BigInt (wasm i64 <-> JS BigInt). Internal
      // callers use `$name` (the f64 carrier) untouched; only the `$exp` export result is i64.
      body = ['i64.reinterpret_f64', callIR]
    } else if (sig.results[0] === 'i32') {
      body = [sig.unsignedResult ? 'f64.convert_i32_u' : 'f64.convert_i32_s', callIR]
    } else {
      body = callIR
    }
    wrapNode.push(body)
    // Track externref param positions so interop.js can pass JS values
    // raw (skipping `mem.wrapVal`) at those slots. Today this only fires
    // for `jsstring`-tagged params; future externref carriers wire here too.
    // `extParams` is per-slot: false (non-ext) | { def: '...' }-bearing object
    // for jsstring params with a JS-side default substitution.
    const extParams = sig.params.map(p => {
      if (!p.jsstring) return false
      return p.jsstringDefault != null ? { def: p.jsstringDefault } : true
    })
    if (extParams.some(Boolean)) func._exportExtParams = extParams
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
  if (cb.nullables) for (const name of cb.nullables) updateRep(name, { nullable: true })
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
  // i32-narrowed cells: the owner decided the cell width (funcFacts.cellTypes);
  // every body sharing the cell must read/write it at that width.
  ctx.func.cellTypes = new Set(cb.cellI32 || [])
  const parentBoxedCaptures = new Set(cb.boxed || [])
  ctx.func.preboxed = new Set()
  // Bare `;`-sequence bodies (no enclosing `{}`) reach us when callers built a
  // statement list directly — wrap into a block body so the multi-stmt path
  // runs (otherwise emit returns an untyped list and asF64 wraps it with
  // `f64.convert_i32_s`, yielding invalid WAT).
  if (Array.isArray(cb.body) && cb.body[0] === ';') cb.body = ['{}', cb.body]
  // Uniform convention: (env f64, argc i32, a0..a{width-1} f64) → f64
  const W = ctx.closure.width ?? MAX_CLOSURE_ARITY
  const paramDecls = [{ name: '__env', type: 'f64' }, { name: '__argc', type: 'i32' }]
  for (let i = 0; i < W; i++) paramDecls.push({ name: `__a${i}`, type: 'f64' })
  // Enter the closure frame. uniq ≥ 100 keeps synthetic labels from colliding
  // with the parent. directClosures: closure.make snapshotted the parent's
  // direct-call map for each capture, so a call to a captured const closure
  // still lowers to `call $closureN` instead of call_indirect (A3 across the
  // capture boundary).
  enterFunc({ params: paramDecls, results: ['f64'] }, cb.body, {
    uniq: Math.max(ctx.func.uniq, 100),
    directClosures: cb.directClosures ? new Map(cb.directClosures) : null,
  })

  const fn = ['func', `$${cb.name}`]
  fn.push(['param', '$__env', 'f64'])
  fn.push(['param', '$__argc', 'i32'])
  for (let i = 0; i < W; i++) fn.push(['param', `$__a${i}`, 'f64'])
  fn.push(['result', 'f64'])

  // Params are locals, assigned directly from inline slots
  for (const p of cb.params) ctx.func.locals.set(p, 'f64')
  // Mark params that every direct call site passed a number (seeded by
  // tryDirectClosureCall) VAL.NUMBER — their body uses then skip the __to_num
  // coercion. All direct calls were emitted before this body (module end), so the
  // lattice is complete; a `false`/unobserved slot leaves the param boxed.
  const ptRow = ctx.closure.paramTypes?.get(cb.name)
  // A param numeric at every call site is typed NUMBER so its body uses skip __to_num. If some
  // call omits it (index ≥ minArgc) it can hold UNDEF_NAN, so also flag it nullable — that keeps
  // the boxing win yet stops `x === undefined` mis-folding to false (it bit-compares instead).
  const minArgc = ctx.closure.minArgc?.get(cb.name) ?? 0
  if (ptRow) for (let i = 0; i < cb.params.length; i++) {
    if (ptRow[i] === true && !ctx.func.localReps?.get(cb.params[i])?.val)
      updateRep(cb.params[i], i < minArgc ? { val: VAL.NUMBER } : { val: VAL.NUMBER, nullable: true })
  }
  // A param passed the same typed-array ctor at every direct call site is TYPED:
  // register its element ctor so `buf[i]` reads use the typed load (it stays an f64
  // NaN-box in the closure ABI, but knowing the kind avoids the dynamic `__typed_idx`
  // /`__len` dispatch that pulls the string runtime). Numeric trust (above) wins if it
  // already classified the slot — they're disjoint anyway (NUMBER vs TYPED arg).
  const tcRow = ctx.closure.paramTypedCtors?.get(cb.name)
  if (tcRow) for (let i = 0; i < cb.params.length; i++) {
    const ctor = tcRow[i]
    if (ctor && !ctx.func.localReps?.get(cb.params[i])?.val) {
      updateRep(cb.params[i], { val: VAL.TYPED })
      ;(ctx.types.typedElem ||= new Map()).set(cb.params[i], ctor)
    }
  }
  // Body-usage numeric trust for closure params — the same proof the export path
  // applies (paramAllUsesNumeric). A nested helper like heapsort's `heapify(n)` whose
  // param is used only in arithmetic/relational positions is VAL.NUMBER, so `(n>>1)-1`
  // skips the `__to_num` coercion that would otherwise drag the ToNumber string-parse
  // tree into a pure-integer kernel. paramAllUsesNumeric walks any AST node, so this
  // also covers expression-bodied arrows (`(m) => m | 0`) — the common closure shape
  // whose dynamic param would otherwise emit a polymorphic add/coerce that pulls the
  // whole string runtime in. Call-site evidence (ptRow) already covers the monomorphic
  // case; this also catches params the lattice left unobserved.
  for (const p of cb.params) {
    if (!ctx.func.localReps?.get(p)?.val && !cb.defaults?.[p] && paramAllUsesNumeric(cb.body, p))
      updateRep(p, { val: VAL.NUMBER })
  }

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
    bodyIR = emitBlockBody(cb.body)
  } else {
    bodyIR = [asF64(emit(cb.body))]
  }

  // Pre-allocate cache locals for env unpacking
  const envBase = cb.captures.length > 0 ? `${T}envBase${ctx.func.uniq++}` : null
  if (envBase) ctx.func.locals.set(envBase, 'i32')
  // Rest param: allocate helper locals (len + offset + spill loop index) before emitting decls
  let restOff, restLen, restIdx
  if (cb.rest) {
    restOff = `${T}restOff${ctx.func.uniq++}`
    restLen = `${T}restLen${ctx.func.uniq++}`
    restIdx = `${T}restIdx${ctx.func.uniq++}`
    ctx.func.locals.set(restOff, 'i32')
    ctx.func.locals.set(restLen, 'i32')
    ctx.func.locals.set(restIdx, 'i32')
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
  // Boxed locals that aren't captures or params get a fresh null-init cell;
  // captures/params already carry their incoming value.
  const preboxedLocalInits = emitPreboxedLocalInits(name =>
    boxedCaptureNames.has(name) || boxedValueCaptureNames.has(name) || boxedParamNames.has(name))

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
    const rid = ctx.func.uniq++
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
  // Contract: callers (jzCompileInner / scripts/self.js compileSelf) must set
  // ctx.transform.optimize before reaching here — every optimize-gated pass below
  // reads `cfg && cfg.x === false`, so a null cfg silently runs every pass.
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
        }
      }
    }
  }

  // Whole-program constant fold of module-scope aggregate literals — `var x=[1,2,3];
  // y=x[0]` → `y=1`, dropping the array (no data segment, no __arr_idx_known) when
  // every reference is a static read. The scalar analog of the constInts fold above.
  timePhase(profiler, 'foldAggregates', () => foldStaticConstAggregates(ast))

  const programFacts = timePhase(profiler, 'plan', () => plan(ast, profiler))

  // Inspect sink: editor hosts opt in via { inspect: true } to read inferred shapes.
  // Initialized here (post-plan) so paramReps and schema.list are stable, populated
  // per-function below as funcFacts settle. Bytes themselves are unchanged.
  if (ctx.transform.inspect) ctx.inspect = { functions: {}, schemas: ctx.schema.list.map(s => s.slice()) }

  const funcFacts = new Map()
  timePhase(profiler, 'analyzeFuncs', () => {
    for (const func of ctx.func.list) {
      if (func.raw) continue
      const facts = analyzeFuncForEmit(func, programFacts)
      funcFacts.set(func, facts)
      captureFuncInspect(func, facts, programFacts)
    }
  })
  // Whole-program SRoA: pick the schemas whose `Array<S>` instances use the
  // `structInline` carrier. Runs once the per-function reps have settled (they
  // are codegen truth) and before any function is emitted.
  timePhase(profiler, 'structInline', () => analyzeStructInline(funcFacts, programFacts))
  const funcs = timePhase(profiler, 'emitFuncs', () => ctx.func.list.map(func => emitFunc(func, funcFacts.get(func), programFacts)))
  funcs.push(...synthesizeBoundaryWrappers())

  const closureFuncs = []
  let compiledBodyCount = 0
  const compilePendingClosures = () => timePhase(profiler, 'emitClosures', () => {
    const bodies = ctx.closure.bodies || []
    for (let bodyIndex = compiledBodyCount; bodyIndex < bodies.length; bodyIndex++) {
      closureFuncs.push(emitClosureBody(bodies[bodyIndex]))
    }
    compiledBodyCount = bodies.length
  })
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
  const sec = {
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

  timePhase(profiler, 'buildStart', () => buildStartFn(ast, sec, closureFuncs, compilePendingClosures))

  // Host globals (globalThis/process/WebAssembly/…) referenced as values are
  // recorded in ctx.core.hostGlobals during emit; register them as env imports
  // now (assembly owns ctx.module.imports). Drained after buildStartFn so a
  // host global first used in a top-level statement (emitted into __start) is
  // captured; syncImports below merges them into sec.imports.
  for (const name of ctx.core.hostGlobals)
    ctx.module.imports.push(['import', '"env"', `"${name}"`, ['global', `$${name}`, 'i64']])

  syncImports(sec)

  dedupClosureBodies(closureFuncs, sec)

  finalizeClosureTable(sec)

  buildInternTable()

  timePhase(profiler, 'pullStdlib', () => pullStdlib(sec))

  stripStaticDataPrefix(sec)

  ensureThrowRuntime(sec)

  timePhase(profiler, 'optimizeModule', () => optimizeModule(sec, profiler))

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

  // Custom section: per-export externref param positions. interop.js reads
  // this to pass JS arguments straight through at those positions (no
  // `mem.wrapVal`, no SSO encoding). Format: { name, p, d? } where p lists
  // 0-based externref param indices and d (optional) is a map idx→default
  // string for jsstring-carrier params whose default-substitution happens
  // JS-side. Empty list emits nothing.
  const extExports = []
  for (const f of ctx.func.list) {
    if (!isExported(f) || !isBoundaryWrapped(f) || !f._exportExtParams) continue
    const p = []
    const d = {}
    f._exportExtParams.forEach((b, i) => {
      if (!b) return
      p.push(i)
      // String-key the index: object property keys are conceptually strings (JSON renders
      // `{"0":…}` either way), and the self-host kernel's objects don't enumerate a numeric
      // key — `d[0]=…` stores but Object.keys(d) misses it, so the `d` map would read empty
      // and the default never reach the jz:extparam section. Same coercion as the optimize
      // LEVEL_PRESETS lookup. (Native is unaffected: numeric keys auto-stringify.)
      if (typeof b === 'object' && b.def != null) d[String(i)] = b.def
    })
    if (!p.length) continue
    // Build each export entry as a direct literal — no `entry.d = d` after the fact and no
    // `{...entry, name}` spread. The self-host kernel's fixed-schema objects don't enumerate
    // a key added to a non-empty literal (JSON.stringify/spread would silently drop a post-hoc
    // `d`), and spreading a 3-key literal mis-resolves the merged schema there. Constructing
    // the final shape directly sidesteps both.
    const hasDefaults = Object.keys(d).length > 0
    for (const exportName of exportNamesOf(f.name))
      extExports.push(hasDefaults ? { name: exportName, p, d } : { name: exportName, p })
  }
  if (extExports.length)
    sec.customs.push(['@custom', '"jz:extparam"', `"${JSON.stringify(extExports).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`])

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
    { removeDead: !optCfg || optCfg.treeshake !== false, globals: sec.globals, userGlobals: ctx.scope.userGlobals,
      userFuncs: new Set(ctx.func.list.map(f => `$${f.name}`)) }
  )

  pruneUnusedThrowRuntime(sec)

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
