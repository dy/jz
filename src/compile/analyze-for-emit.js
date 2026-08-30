import { ctx } from '../ctx.js'
import { T, isBlockBody, isReassigned, returnExprs, walkAst } from '../ast.js'
import { valTypeOf, censusBigintResultShape } from '../kind.js'
import { intLiteralValue } from '../static.js'
import { intCertainMap } from '../type.js'
import { typedElemAux } from '../../layout.js'
import { VAL, updateRep } from '../reps.js'
import { cloneRep, paramValTrustworthy } from '../param-reps.js'
import { I32_MIN, I32_MAX } from '../ir.js'
import { restoreActiveFunction } from './active-function.js'
import { enterFunc } from './func-entry.js'
import { isExported } from './func-exports.js'
import { paramAllUsesNumeric, paramNeverString } from './param-numeric.js'
import { makeMapOverlay, mapOrOverlaySize } from './map-overlay.js'
import {
  analyzeBody, unboxablePtrs, inheritPtrAliases, cseSafeLoadBases,
  boxedCaptures, reanalyzeBody,
} from './analyze.js'
import { inferLocals } from './infer.js'
import { strengthReduceLoopDivMod } from './loop-divmod.js'
import { mintLoopPlans } from './loop-model.js'
import { mintClosureEnvPlans } from './closure-plan.js'
import { mintRepresentationPlan, representationProgramHasBigint } from './representation-plan.js'
import { mintTypedStoragePlan } from './typed-storage-plan.js'
import { narrowBoundedSquare } from './loop-square.js'
import { unrollRecurrence, unrollScalarChains, selectArmUpdatesIn } from './loop-recurrence.js'
import { peelClampedStencil } from './peel-stencil.js'
import { cseLoads } from './cse-load.js'

// Monotonic across all functions so a CSE temp never collides (even after later
// inlining). Per-compile (ctx.transform.cseId, reset in ctx.reset — the
// freshLoopId pattern): a module-level counter made warm-process WAT text
// history-dependent (`cse0/1` then `cse2/3` for the same program).
const freshCseName = () => `${T}cse${ctx.transform.cseId++}`

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

export function analyzeFuncForEmit(func, programFacts) {
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
      // paramValTrustworthy: `r.val` and `r.possibleKinds` are independent
      // lattices over the same call sites (param-reps.js's own header) — a
      // parameter fed by a mix of easily-proven and unresolved-argument call
      // sites (e.g. a compiler-internal helper whose receiver sometimes comes
      // from a plain literal, sometimes from an array-element read whose own
      // kind this fixpoint's `val` meet never got to observe) can settle
      // `val` to a single, UNCHALLENGED kind from the one site that WAS
      // provable, while `possibleKinds`' own wider census (closed coverage:
      // every site enumerated) proves the parameter is genuinely polymorphic.
      // Trusting `val` alone there hardcodes a receiver type tag
      // (emitTypeTag, src/ir.js) that's wrong for every other-kinded call —
      // fix/selfhost-hash-read's own root cause (a HASH-representation
      // parameter compiled with an unconditionally-hardcoded PTR.OBJECT tag).
      if (r.val && !reassigned && paramValTrustworthy(r) && !ctx.func.localReps?.get(pname)?.val) updateRep(pname, { val: r.val })
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
      if (r.localMapBigintUnknown) updateRep(pname, { localMapBigintUnknown: true })
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
      // mayBeUndefined (Slice 2, .work/archive/todo.md §deletion-sweep
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
    // A rest parameter is constructed by the call ABI as a fresh ARRAY on
    // every entry. This is intrinsic parameter provenance, not a caller guess;
    // publish it through the same ValueRep authority as every other carrier
    // fact. A body reassignment invalidates the entry fact in the usual way.
    if (restIdx >= 0) {
      const restName = sig.params[restIdx].name
      if (!isReassigned(body, restName)) updateRep(restName, { val: VAL.ARRAY })
    }
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
  // B1, .work/archive/walk-count-design.md §2.4/§5 item 3): narrowSignatures may
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
    // `censusSafe` (.work/archive/todo.md §deletion-sweep §14) guards BOTH disjuncts below,
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

  // LoopPlan pre-emission mint (.work/evidence.md §BodyModel /
  // LoweredLoopPlan): last, so it sees this function's FINAL AST (every loop-
  // AST-rewrite pass above has already run) and maximally-settled `repOf`
  // facts (every updateRep call above has already landed) — the same two
  // preconditions emit.js's own (separately, locally computed) counter/guard
  // range facts enjoy today, just at analyze time instead of emit time.
  mintLoopPlans(body)
  // ClosureEnvPlan pre-emission mint (Slice 1, .work/archive/closure-plan-design.md)
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
  walkAst(body, { enter: node => {
    const op = node[0]
    if (op === '=>') return false
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const decl = node[i]
        if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string' && !isReassigned(body, decl[1])) decls.push(decl)
      }
      return false
    }
  } })
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
