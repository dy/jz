/**
 * Variable-storage abstraction: the boxed/global/local 3-way dispatch used
 * by =, ++/--, +=, etc. (readVar/writeVar), plus the name-scoping predicates
 * (isBoundName/isGlobal/isConst) and the dyn-props-shadow-needed classifier
 * (usesDynProps/needsDynShadow) it sits next to in the original file.
 *
 * @module ir/vars
 */

import { ctx } from '../ctx.js'
import { isI32 } from '../ast.js'
import { VAL, lookupValType, repOf, repOfGlobal } from '../reps.js'
import { typed } from './tag.js'
import { temp, tempI32 } from './locals.js'
import { asF64, asI32, toI32 } from './numeric.js'

export function usesDynProps(vt) {
  return vt === VAL.ARRAY || vt === VAL.STRING || vt === VAL.CLOSURE
    || vt === VAL.TYPED || vt === VAL.SET || vt === VAL.MAP || vt === VAL.REGEX
}

/** Does this object literal / property write need a `__dyn_props` shadow update?
 *  `target` is the var name receiving the literal (or null when escaping).
 *  `sid` (dyn-reach slice) is the call site's OWN resolved schema id, when it
 *  has one locally — passed explicitly rather than re-derived here because
 *  every call site already resolves it for its own purposes (a construction's
 *  litId/schemaId, an assign's tSid, a ptrAux, a chainSid walk) and the exact
 *  SAME resolution the write-hazard scan used to build dynPointsTo must be
 *  reused, not approximated afresh, or the two sides can silently diverge on
 *  schema-merge/poisoned-binding edges (CARRIER PROGRAM §15/§16's granularity-
 *  mismatch lesson, module/schema.js:441-453 — construction-time shadow and
 *  every read-side dyn-props probe must agree at IDENTICAL schema granularity). */
export function needsDynShadow(target, sid) {
  if (!ctx.module.modules.collection) return false
  // Functions/CLOSURE always need dynamic props so cross-module property
  // access (fn.parse, i32.parse aliases) sees the same value as schema slots.
  const vt = typeof target === 'string' ? (ctx.func.localReps?.get(target)?.val || ctx.scope.globalValTypes?.get(target)) : null
  if (vt === 'closure' || usesDynProps(vt)) return true
  // A module-wide dynamic-key access (`obj[expr]`) means SOME object may later
  // be read through the dyn-props hash (__dyn_get_any) or enumerated by
  // `for-in` — but only objects of a schema a dyn-key read/for-in receiver can
  // actually resolve to (schemaDynReach, module/schema.js, fed by
  // collectSlotWriteHazards' hz.dynPointsTo — program-facts.js) need the
  // shadow mirror those paths consult; a schema no such read can ever name
  // needs none. Fail closed exactly like today's whole-program behavior on
  // BOTH remaining uncertainties: this call site's own sid unresolvable (it
  // can't ask schemaDynReach a specific question), and schemaDynReach's own
  // 'ALL' sentinel (some dyn-key read/for-in receiver in the program was
  // itself unresolvable) — either one shadows, matching what anyDynKey alone
  // used to do unconditionally.
  if (ctx.types?.anyDynKey) return sid == null || !ctx.schema.schemaDynReach || ctx.schema.schemaDynReach(sid)
  const dyn = ctx.types?.dynKeyVars
  return target != null && dyn ? dyn.has(target) : false
}

// === Variable storage abstraction ===
// Centralizes the boxed/global/local 3-way dispatch (used by =, ++/--, +=, etc.)

/** Check if name is a module-scope global (not shadowed by local/param). */

/** Bound in the current function frame — a declared local or a parameter. */
export const isBoundName = name =>
  ctx.func.locals?.has(name) || ctx.func.current?.params?.some(p => p.name === name)

export function isGlobal(name) {
  return ctx.scope.globals.has(name) && !ctx.func.locals?.has(name) && !ctx.func.current?.params?.some(p => p.name === name)
}

/** Check if assigning to name would violate const. Only applies when not shadowed. */
export function isConst(name) {
  return ctx.scope.consts?.has(name) && !ctx.func.locals?.has(name) && !ctx.func.current?.params?.some(p => p.name === name)
}

/** Get i32 memory address for a boxed variable's cell. Cell locals are always i32. */
export function boxedAddr(name) {
  return ['local.get', `$${ctx.func.boxed.get(name)}`]
}

// '$'-prefixed name memo. readVar/writeVar run per IR node; rebuilding the
// `$name` string each time costs an alloc+copy in the self-host kernel AND
// produces a fresh instance per use — making watr's name-keyed lookups
// content-compare. The memo returns ONE canonical instance per name, so
// construction is a map hit and every downstream comparison is bit-eq.
// Module-level: in-kernel it lives per instance (arena strings are immortal),
// natively it is a plain cross-compile cache; the name vocabulary is bounded.
let DOLLAR = new Map()

export const dollar = (name) => {
  let v = DOLLAR.get(name)
  if (v === undefined) { v = '$' + name; DOLLAR.set(name, v) }
  return v
}

// Region-arena EMISSION rounds (re-landing .work/research.md §Emission rounds):
// DOLLAR is a module-scope Map, entirely outside `ctx` — invisible to any
// ctx.*-based region-round root array. `dollar()` fires on effectively every
// emitted IR node (every param/local/name reference), so it grows heavily
// DURING emission — exactly the "arena strings are immortal" assumption this
// binding's own doc makes, which a region round breaks (the arena is no
// longer immortal within a round's [mark, exit) window). Without threading
// DOLLAR through the round's root/rebind, a round-exit mid-emission can
// reclaim a just-grown backing table out from under it — the same class this
// binding's own doc already names for warm-instance reuse (`_clear`
// swap-in-fresh-Map), just triggered by a region-round boundary instead of a
// new compile. `dollarMap`/`setDollarMap` let compile/index.js root and
// rebind it exactly like a ctx.* field.
export const dollarMap = () => DOLLAR

export const setDollarMap = (m) => { DOLLAR = m }

// Self-host-only: DOLLAR's keys/values are both arena strings built during compile
// (the `name`s come from the source being compiled) AND the Map's own backing
// table is itself an arena allocation. Natively the arena is the host GC heap, so
// stale entries (or a `.clear()`) are enough — the old backing store just becomes
// garbage. In-kernel the arena is a bump allocator that `_clear` rewinds between
// compiles: `.clear()` alone leaves the Map pointing at its OLD backing table,
// which a later allocation can overwrite while still "owned" by DOLLAR (as opposed
// to the entries becoming merely unreachable) — so a warm-instance compile loop
// must swap in a FRESH Map (not just empty this one) after every `_clear`
// (see scripts/self.js setupSelf) — `.clear()` alone still traps
// `__hash_set_local` on the 2nd compile of a warm instance.
export const clearDollar = () => { DOLLAR = new Map() }

/** Read variable value: boxed → f64.load, global → global.get, local → local.get.
 *  Unboxed pointer locals (repOf(name).ptrKind) tag the returned node with `.ptrKind`
 *  so downstream coercions know it's an i32 offset, not a numeric. */
export function readVar(name) {
  if (ctx.func.boxed?.has(name)) {
    // i32-narrowed cell (closure-capture narrowing — see analyzeFuncForEmit's
    // cellTypes): the cell stores a raw i32, load it directly.
    if (ctx.func.cellTypes?.has(name)) return typed(['i32.load', boxedAddr(name)], 'i32')
    return typed(['f64.load', boxedAddr(name)], 'f64')
  }
  if (isGlobal(name)) {
    // A module-level integer const (`const N = 16384`) is an immutable compile-time
    // value: emit i32.const directly (when it fits i32) so `x % N` / `x & N` / `x / N`
    // and counters bounded by N take the native integer path, instead of the global
    // folding to an f64 constant and routing through the f64 round-trip. Value-preserving
    // — an f64 consumer widens the i32.const via convert, which folds back to f64.const.
    const ci = ctx.scope.constInts?.get?.(name)
    if (ci != null && isI32(ci)) return typed(['i32.const', ci], 'i32')
    // Fractional pre-folded const (`const nv = 2610/16384`): same immutability
    // argument as the integer arm — substitute the literal so downstream
    // compile-time folds (constant-exponent pow, ranges) see the value.
    const cn = ctx.scope.constNums?.get?.(name)
    if (cn != null) { const node = typed(['f64.const', cn], 'f64'); node.valKind = VAL.NUMBER; return node }
    const gt = ctx.scope.globalTypes.get(name) || 'f64'
    const node = typed(['global.get', dollar(name)], gt)
    const grep = repOfGlobal(name)
    if (gt === 'f64' && (lookupValType(name) === VAL.NUMBER || grep?.val === VAL.NUMBER)) node.valKind = VAL.NUMBER
    // ptrKind tags a raw i32 pointer offset — meaningful only for an i32-STORED
    // global (a typed-array/buffer carrier unboxed by unboxConstTypedGlobals). An
    // f64 global holds a NaN-boxed value: object/array reads unbox at the access
    // site via the schema/reinterpret path, never an i32 reinterpret of the storage.
    // Attaching ptrKind to an f64 global makes `asF64` box the f64 *as if it were an
    // i32* (i64.extend_i32_u on a global.get of type f64 → invalid wasm). Gate on the
    // storage type so the tag follows the declared ABI.
    if (gt === 'i32' && grep?.ptrKind != null) {
      node.ptrKind = grep.ptrKind
      if (grep.ptrAux != null) node.ptrAux = grep.ptrAux
    }
    return node
  }
  const t = ctx.func.locals?.get(name) || ctx.func.current?.params?.find(p => p.name === name)?.type || 'f64'
  const rep = repOf(name)
  // Const-arg propagation: param proven to be the same integer literal at every static
  // call site (cross-call fixpoint sets rep.intConst). Substitute the read with the
  // literal — lets watr fold guards and treeshake unused params without touching the
  // param ABI (which the V8 inliner is sensitive to: narrowing nStages from f64→i32
  // tanked biquad ~60%). Type follows the local's declared type to preserve any
  // coercions the surrounding code expects.
  if (rep?.intConst != null) {
    return t === 'i32' ? typed(['i32.const', rep.intConst], 'i32')
                       : typed(['f64.const', rep.intConst], 'f64')
  }
  const node = typed(['local.get', dollar(name)], t)
  if (t === 'f64' && (lookupValType(name) === VAL.NUMBER || rep?.val === VAL.NUMBER)) node.valKind = VAL.NUMBER
  // Proven uint32 accumulator local (narrowUint32): a later asF64 must widen with
  // convert_i32_u (the i32 bit pattern is an unsigned value), not _s. `.wrapSafe`
  // marks it as the always-ToUint32-sunk kind so the arithmetic widening guards
  // keep it on the i32 path — wrapping is its intended semantics, not a leak.
  if (t === 'i32' && rep?.unsigned) { node.unsigned = true; node.wrapSafe = true }
  if (rep?.ptrKind != null) {
    node.ptrKind = rep.ptrKind
    // closureAux: emission-minted table idx for an unboxed CLOSURE local (slice-4 P2) —
    // per-function emission state; the map only ever holds CLOSURE names.
    const aux = rep.ptrAux ?? ctx.func.closureAux?.get(name) ?? ctx.schema.idOf?.(name)
    if (aux != null) node.ptrAux = aux
    // structInline cursor into a PACKED (i32-cell) array: slot access must
    // pick the packedI32 ops, not the f64 slot layout — the flag rides the
    // node because a standalone object of the same sid keeps f64 slots.
    if (rep.ptrKind === VAL.OBJECT && ctx.schema.inlineCellCursors?.get(ctx.func.current)?.has(name))
      node.cellI32 = true
    // Union cursor (analyzeUnionInline): packed i32 cells; the slot comes from
    // the refinement chain (schema.slotOf), never a single sid aux.
    if (rep.ptrKind === VAL.OBJECT && ctx.schema.inlineUnionCursors?.get(ctx.func.current)?.has(name)) {
      node.cellI32 = true
      node.unionKey = ctx.schema.inlineUnionCursors.get(ctx.func.current).get(name)
    }
  }
  // Union-cursor PARAM (stage 3): the packed cell address rides the OBJECT
  // NaN-box across the call, so the param has val=OBJECT but no ptrKind (it's a
  // boxed f64, not an unboxed local). Tag its reads cellI32 + unionKey; the
  // slot read (emitPropAccess) unboxes to the cell address then packedI32-loads.
  // NO ptrKind on the tag: the node's storage IS f64 (the NaN-box), and
  // ptrKind on an f64-typed node makes asF64/asI64 box it as if it were a raw
  // i32 offset (the f64-global hazard above) — any non-field-read use of the
  // param (dyn fallback, logging, compare) must keep the plain f64 carrier.
  // (A local cursor is caught by the ptrKind branch above; this is the
  // f64-carrier param case only.)
  else if (ctx.schema.inlineUnionCursors?.get(ctx.func.current)?.has(name)) {
    node.cellI32 = true
    node.unionKey = ctx.schema.inlineUnionCursors.get(ctx.func.current).get(name)
  }
  return node
}

/** Write variable value. void_ → local.set (no result); otherwise → local.tee.
 *  valIR is raw emit result — coerced to f64 for boxed/global, to local type for locals. */
export function writeVar(name, valIR, void_) {
  // Loop-guard hull channel invalidation (emit.js's loopGuardHi/boundedHi,
  // sort lever): a `while(name < bound)`-derived upper-bound fact for `name`
  // is only valid until the FIRST write to `name` — writeVar is the single
  // choke point every bare-name write path (`=`, `+=`, `++`/`--`, a for-loop
  // step) funnels through, so one delete here covers all of them. Emission
  // order matches evaluation order up to this point, so any comparison that
  // already READ the fact (via boundedHi, before this write emitted) stays
  // sound — only what's emitted AFTER this write loses it.
  ctx.types.loopGuardHi?.delete(name)
  if (ctx.func.boxed?.has(name)) {
    const addr = boxedAddr(name)
    // i32-narrowed cell: store the raw i32 (mirrors the integer-global write
    // gate below — the storage type decides the coercion).
    const i32Cell = ctx.func.cellTypes?.has(name)
    const st = i32Cell ? 'i32.store' : 'f64.store'
    const v = i32Cell ? asI32(valIR) : asF64(valIR)
    if (void_) return typed(['block', [st, addr, v]], 'void')
    const t = i32Cell ? tempI32() : temp()
    return typed(['block', ['result', i32Cell ? 'i32' : 'f64'],
      ['local.set', `$${t}`, v],
      [st, addr, ['local.get', `$${t}`]],
      ['local.get', `$${t}`]], i32Cell ? 'i32' : 'f64')
  }
  if (isGlobal(name)) {
    // Scalar globals are f64 by default, but integer-global inference (plan.js)
    // narrows purpose-focused counters/sizes to i32 — coerce the write to match.
    const gt = ctx.scope.globalTypes.get(name) || 'f64'
    const v = gt === 'i32' ? asI32(valIR) : asF64(valIR)
    if (void_) return typed(['block', ['global.set', dollar(name), v]], 'void')
    const t = gt === 'i32' ? tempI32() : temp()
    return typed(['block', ['result', gt],
      ['local.set', `$${t}`, v],
      ['global.set', dollar(name), ['local.get', `$${t}`]],
      ['local.get', `$${t}`]], gt)
  }
  // NOTE: an unknown name is NOT minted here — a write-legalized binding lets a
  // later-emitted read of the same undeclared name resolve to 0 instead of
  // rejecting (test262 pins the ReferenceError: `x = x`, `x++`, `x + (x = 1)`
  // — 50 in-scope failures from an unconditional mint). The one structural
  // write-only binder, a bare undeclared `for (k in o)` head, is declared at
  // its prepare lowering instead.
  // A PARAMETER has no `let`/`const` decl for analyzeBody to seed into
  // ctx.func.locals — mirrors readVar's identical fallback (above) to the
  // signature's declared type. Needed once narrowMutatedParams (narrow.js)
  // lets an i32-specialized param be reassigned: without this fallback the
  // write defaulted to 'f64' (an i32 param was never written before this
  // lever — the mutation guard excluded it), coercing the RHS through
  // asF64 into a local the wasm signature declares i32 — a validation-
  // failing local.set type clash (the narrow.js comment's "generic f64
  // assign path").
  const t = ctx.func.locals.get(name) || ctx.func.current?.params?.find(p => p.name === name)?.type || 'f64'
  const ptrKind = repOf(name)?.ptrKind
  let coerced
  if (ptrKind != null) {
    // Local stores unboxed i32 offset. If RHS is already a same-kind offset, pass through;
    // otherwise extract low 32 bits from the NaN-boxed f64.
    coerced = valIR.ptrKind === ptrKind
      ? valIR
      : typed(['i32.wrap_i64', ['i64.reinterpret_f64', asF64(valIR)]], 'i32')
  } else {
    // i32 target: toI32 (not asI32) — a strict superset (same `|0`/ToInt32
    // wrap contract, ir.js docstrings) that ALSO tries narrowI32's ring-
    // arithmetic recovery first. Needed because
    // tryI32Arith (emit.js) requires a magnitude proof before admitting
    // `i32.add`/`i32.sub` (a value that might escape BARE, e.g. via `return`,
    // can no longer trust an unproven wrap) — but an assignment INTO an
    // i32-typed local like the loop-counter idiom `i = i + 1` has no such
    // escape (every read of `i` re-applies this SAME wrap), so it doesn't
    // need tryI32Arith's admission at all: narrowI32's own (looser, ring-safe
    // under 2^53) recovery already re-narrows the resulting f64.add here,
    // right at the one assignment site that's provably safe to wrap.
    coerced = t === 'v128' ? valIR : t === 'f64' ? asF64(valIR) : toI32(valIR)
  }
  if (void_) return typed(['local.set', dollar(name), coerced], 'void')
  const teeNode = typed(['local.tee', dollar(name), coerced], t)
  if (ptrKind != null) teeNode.ptrKind = ptrKind
  return teeNode
}

/** Check if f64 expr is nullish (NULL_NAN or UNDEF_NAN). Returns i32.
 *  Peepholes: fold known NaN-boxed sentinel literals; elide on numeric literals;
 *  unboxed pointer locals are proven non-null by unboxablePtrs.
 *  Inlines directly: (i32.or (i64.eq bits NULL_NAN) (i64.eq bits UNDEF_NAN))
 *  rather than calling $__is_nullish — saves WASM call dispatch in V8 JIT. */
