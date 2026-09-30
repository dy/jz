/**
 * Wasm-type / pointer-ABI param specialization — narrows a function's f64
 * JS-boundary params to 'i32'/'v128' from call-site consensus, or to an
 * OBJECT/SET/MAP/BUFFER pointer's raw i32 offset (applyPointerParamAbi) /
 * a TYPED pointer's i32 offset + elem-type aux (applyTypedPointerParamAbi).
 *
 * @module compile/narrow/param-abi
 */

import { ctx } from '../../ctx.js'
import { withCurrentFunction } from '../flow-state.js'
import { findMutations, reanalyzeBody, clearBodyFacts, invalidateBodies } from '../analyze.js'
import { intLevelMap } from '../../type.js'
import { typedElemAux } from '../../../layout.js'
import { VAL } from '../../reps.js'
import { PTR_ABI_KINDS } from './caller-ctx.js'
import { isExported } from '../func-exports.js'
import { paramNumericArrayLike } from '../param-numeric.js'
import { ensureParamRep } from '../../param-reps.js'
import { scanBindingUses, USE, BINDING_USE_KIND, BINDING_USE_USES } from '../analyze-scans.js'
import { K, tagOf, core } from '../../summary/kind.js'
import { frameNode } from '../../function.js'
import { materializeVariant } from '../variant.js'

// narrowMutatedParams: admit a body-WRITTEN param into the i32 specialization
// when every mutation of it is provably int-preserving. Reuses type.js's
// intLevelMap fixpoint — the SAME prover that grounds ordinary intCertain
// locals — rather than inventing a parallel one: seed the param optimistically
// i32 (so a self-referential def like `nc = nc + 1` doesn't vacuously ground
// at the anti-fixpoint's level 0, see intLevelMap's param-seeding comment) and
// read back its settled level. collectIntDefs (intLevelMap's def-collector)
// already recognizes exactly the classic shapes — `p++`,
// `p += <int>`, `p = p + <int>`, `p = <int-expr of p>` desugar to the same
// def-list entries a plain int-certain local would produce. Anything it can't
// see (a write inside a nested arrow — capturedNames not passed) or that
// doesn't reach level ≥1 (float ops, an unresolved call, a non-int rhs) fails
// CLOSED: the level lookup misses or stays 0, so the optimistic seed is
// reverted and the param stays f64 — never a miscompile, only a forgone
// optimization. On success the seed IS the specialization (p.type stays
// 'i32'); the reassignment then needs writeVar (src/ir.js) to honor the
// param's declared type on the store side, not the generic f64 assign path
// (mirrors readVar's own params fallback).
function isIntSafeMutatedParam(func, p) {
  const saved = p.type
  p.type = 'i32'
  const level = withCurrentFunction(func.sig,
    () => intLevelMap(func.body, undefined, null).get(p.name) ?? 0)
  if (level < 1) { p.type = saved; return false }
  return true
}

// Cross-function self-consistency check for a mutated param whose caller-side
// evidence (paramReps' r.wasm) ISN'T already 'i32'. The cursor-through-helper
// shape narrowMutatedParams targets (`nc = traceLoop(..., nc, ...)`) is
// circular: the call-site lattice (built ONCE, before this narrowing) reads
// the caller's own local through the SAME not-yet-narrowed analyzeBody pass —
// which widens it to f64 because, at that time, this func's OWN result isn't
// narrowed either (the callee-result half of the very cycle narrowI32Results
// resolves, but only AFTER param specialization runs). Neither half can settle
// first from its own evidence alone.
//
// Mirrors narrowI32Results' own "tentatively assume the i32 result, re-analyze,
// keep only if self-consistent" idiom (see callsSelf handling above) one hop
// further out: hypothesize this func's RESULT i32 (the param is already
// optimistically i32 on `p`, set by isIntSafeMutatedParam just before this
// runs) and ask the caller's OWN, unmodified analyzeBody — the exact prover
// every other local classification in the program trusts — whether the
// feeding argument settles i32 under that hypothesis. Committed only when
// EVERY call site agrees; an argument that isn't even a bare name, a caller
// with no body (raw/unknown), or a caller whose OTHER evidence disagrees fails
// closed to f64 — never a miscompile, only a forgone optimization.
function callerArgSelfConsistentI32(func, k, sites) {
  const savedResults = func.sig.results
  func.sig.results = ['i32']
  const touched = new Set()
  let ok = true
  for (const cs of sites) {
    if (!ok) break
    const arg = cs.argList[k]
    const callerFunc = cs.callerFunc
    if (typeof arg !== 'string' || !callerFunc?.body) { ok = false; break }
    touched.add(callerFunc.body)
    const locals = withCurrentFunction(callerFunc.sig,
      () => reanalyzeBody(callerFunc.body).locals)
    if (locals.get(arg) !== 'i32') ok = false
  }
  func.sig.results = savedResults
  // The hypothesis tainted analyzeBody's cache for every touched caller body —
  // invalidate again so the next (real, non-hypothetical) read re-derives clean.
  clearBodyFacts(touched)
  return ok
}

export function applyI32ParamSpecialization(paramReps, addressTaken, sitesByCallee, { skipTyped = false } = {}) {
  for (const func of ctx.funcs.list) {
    if (func.raw || addressTaken.has(func.name)) continue
    const reps = paramReps.get(func.name)
    if (!reps) continue
    const restIdx = func.rest ? func.sig.params.length - 1 : -1
    // A narrowed param type is a CALLER-side contract; a body-written param
    // keeps it ONLY when narrowMutatedParams (isIntSafeMutatedParam /
    // callerArgSelfConsistentI32, above) proves every mutation int-preserving
    // AND the caller side self-consistent — otherwise the reassignment's RHS
    // isn't provably representable as i32 and the param stays f64. The blanket
    // "never written" exclusion still applies unmodified to
    // validateTypedLenParams/validateIntConstParams/applyPointerParamAbi below:
    // those guard DIFFERENT contracts (a static length, a literal constant, a
    // pointer identity) that a value-preserving int mutation can still break,
    // so they are not int-safety questions this lever answers.
    let mutated = null, uses = null
    for (const [k, r] of reps) {
      if (k === restIdx || k >= func.sig.params.length) continue
      const p = func.sig.params[k]
      if (func.defaults?.[p.name] != null) continue
      // Admit f64 evidence when mutations preserve integer values, or every
      // read applies a word conversion at the boundary below.
      if (r.wasm !== 'v128' && r.wasm !== 'i32' && r.wasm !== 'f64') continue
      if (r.wasm === 'i32' && p.type === 'i32') continue
      if (mutated === null) {
        mutated = new Set()
        if (func.body) findMutations(frameNode(func), new Set(func.sig.params.map(p => p.name)), mutated)
      }
      if (mutated.has(p.name)) {
        if (r.wasm === 'f64') {
          if (!func.body) continue
          const origType = p.type
          if (isIntSafeMutatedParam(func, p) && callerArgSelfConsistentI32(func, k, sitesByCallee.get(func.name) ?? [])) continue
          p.type = origType
          continue
        }
        if (r.wasm === 'i32' && func.body) isIntSafeMutatedParam(func, p)
        continue
      }
      // SIMD: a param passed a v128 (lane vector) at every call site is a v128 param.
      if (r.wasm === 'v128') { p.type = 'v128'; continue }
      if (r.wasm !== 'i32') {
        // Moving a primitive word conversion to the call boundary is exact
        // when every parameter read repeats it. Missing elements then become
        // zero only at the helper that actually asks for ToInt32.
        if (isExported(func) || !func.body ||
            tagOf(core(ctx.summary.at(func.sig).paramKindOf(p.name))) !== K.NUMBER) continue
        uses ||= scanBindingUses(frameNode(func), new Set(func.sig.params.map(p => p.name)))
        const reads = uses.get(p.name)?.[BINDING_USE_USES]
        if (!reads?.length || !reads.every(u => u[BINDING_USE_KIND] === USE.WORD)) continue
      }
      if (skipTyped && r.val === VAL.TYPED) continue
      p.type = 'i32'
    }
  }
}

// typedLen rides the same safety rails as intConst: only module-local direct
// callees (not exported / value-used / raw), no rest/default positions, and a
// body that never writes the param. Additionally requires the SETTLED typedCtor
// — length evidence for a receiver that never proved typed is dead weight the
// `.length` fold must not trust.
export function validateTypedLenParams(paramReps, addressTaken) {
  for (const func of ctx.funcs.list) {
    const hostReachable = isExported(func) || func.raw || addressTaken.has(func.name)
    const reps = paramReps.get(func.name)
    if (!reps) continue
    const restIdx = func.rest ? func.sig.params.length - 1 : -1
    let candidates = null
    for (const [k, r] of reps) {
      if (r.typedLen == null) continue
      if (hostReachable || !func.body || k === restIdx || k >= func.sig.params.length ||
          r.typedCtor == null) { r.typedLen = null; continue }
      const pname = func.sig.params[k].name
      if (func.defaults?.[pname] != null) { r.typedLen = null; continue }
      ;(candidates ||= new Map()).set(pname, r)
    }
    if (!candidates) continue
    const mutated = new Set()
    findMutations(frameNode(func), new Set(candidates.keys()), mutated)
    for (const name of mutated) candidates.get(name).typedLen = null
  }
}

// lenBoundOf rides similar safety rails to typedLen: module-local direct
// callees only (not exported/value-used/raw), no rest/default position on
// EITHER param (the bound-param k or the receiver-param r.lenBoundOf points
// at), and a body that never writes either name — the caller-side proof
// (summaries.js's boundedByCallerLength) is an entry-time fact about the
// values passed at the call; a body that reassigns either name could hold
// something else by the time a consumer relies on it. See
// ledger-performance.md §6.1 for the full soundness contract.
export function validateLenBoundOfParams(paramReps, addressTaken) {
  for (const func of ctx.funcs.list) {
    const hostReachable = isExported(func) || func.raw || addressTaken.has(func.name)
    const reps = paramReps.get(func.name)
    if (!reps) continue
    const restIdx = func.rest ? func.sig.params.length - 1 : -1
    for (const [k, r] of reps) {
      if (r.lenBoundOf == null) continue
      const ri = r.lenBoundOf
      if (hostReachable || !func.body || k === restIdx || ri === restIdx ||
          k >= func.sig.params.length || ri >= func.sig.params.length) { r.lenBoundOf = null; continue }
      const pname = func.sig.params[k].name, recvName = func.sig.params[ri].name
      if (func.defaults?.[pname] != null || func.defaults?.[recvName] != null) { r.lenBoundOf = null; continue }
      const mutated = new Set()
      findMutations(frameNode(func), new Set([pname, recvName]), mutated)
      if (mutated.has(pname) || mutated.has(recvName)) r.lenBoundOf = null
    }
  }
}

export function validateIntConstParams(paramReps, addressTaken) {
  for (const func of ctx.funcs.list) {
    if (isExported(func) || func.raw || addressTaken.has(func.name)) continue
    if (!func.body) continue
    const reps = paramReps.get(func.name)
    if (!reps) continue
    const restIdx = func.rest ? func.sig.params.length - 1 : -1
    let candidates = null
    for (const [k, r] of reps) {
      if (r.intConst == null || k === restIdx) continue
      if (k >= func.sig.params.length) { r.intConst = null; continue }
      const pname = func.sig.params[k].name
      if (func.defaults?.[pname] != null) { r.intConst = null; continue }
      ;(candidates ||= new Map()).set(pname, r)
    }
    if (!candidates) continue
    const mutated = new Set()
    findMutations(frameNode(func), new Set(candidates.keys()), mutated)
    for (const name of mutated) candidates.get(name).intConst = null
  }
}

// The positions of a node that hold a name without reading a binding: a member's
// name, a literal key, a string's text. A closure keeps its names: its body is
// compiled apart, with the constant as a fact of the binding (closure-emit.js).
const NAME_SLOTS = { '.': 2, '?.': 2, ':': 1 }
const OPAQUE = new Set(['str', '=>', 'function', 'function*', 'class', 'import', 'export'])
const replaceReads = (node, subst) => {
  if (!Array.isArray(node) || OPAQUE.has(node[0])) return
  const skip = NAME_SLOTS[node[0]]
  for (let i = 1; i < node.length; i++) {
    const c = node[i]
    if (i === skip) continue
    if (typeof c === 'string') { const v = subst.get(c); if (v !== undefined) node[i] = [null, v] }
    else replaceReads(c, subst)
  }
}

/** A parameter every call fixes to one integer (`intConst`, validated: never
 *  written, no default, not the rest) reads as that integer in its body: an
 *  index, a stride, an offset the consumers then see as the literal they serve
 *  best (a store inside a fixed length, a folded sum), not as a name whose value
 *  a fact carries. The parameter stays in the signature: callers pass what the
 *  body no longer reads. In place, so every plan keyed by a node keeps its key. */
export function substituteIntConstParams(paramReps, addressTaken) {
  let changed = false
  for (const func of ctx.funcs.list) {
    if (isExported(func) || func.raw || addressTaken.has(func.name) || !func.body) continue
    const reps = paramReps.get(func.name)
    if (!reps) continue
    const restIdx = func.rest ? func.sig.params.length - 1 : -1
    let subst = null
    for (const [k, r] of reps) {
      if (r.intConst == null || k === restIdx || k >= func.sig.params.length) continue
      const pname = func.sig.params[k].name
      if (func.defaults?.[pname] != null) continue
      ;(subst ??= new Map()).set(pname, r.intConst)
    }
    if (!subst) continue
    replaceReads(frameNode(func), subst)
    changed = true
  }
  return changed
}

export function applyPointerParamAbi(paramReps, addressTaken) {
  for (const func of ctx.funcs.list) {
    if (isExported(func) || func.raw || addressTaken.has(func.name)) continue
    const reps = paramReps.get(func.name)
    if (!reps) continue
    const restIdx = func.rest ? func.sig.params.length - 1 : -1
    // A pointer-narrowed param is a CALLER-side contract (unboxed i32 offset,
    // reads rebox via ptrKind/ptrAux). The body keeps it only if it never
    // WRITES the param: a reassignment (`v = v['@@iterator']()`) stores a
    // boxed f64 into the i32 local — mixed views, wasm validation failure
    // (the recorded reassigned-param kind bug). Same rule the wasm-type
    // narrowing applies, for the same reason.
    let mutated = null
    for (const [k, r] of reps) {
      // The summary's kind: every argument at every site proves the same pointer kind.
      const hv = r.val
      if (!PTR_ABI_KINDS.has(hv)) continue
      if (r.mayBeUndefined) continue   // an i32 offset has no `undefined` (see applyTypedPointerParamAbi)
      if (k === restIdx) continue
      if (k >= func.sig.params.length) continue
      const p = func.sig.params[k]
      if (p.type === 'i32') continue
      if (func.defaults?.[p.name] != null) continue
      if (mutated === null) {
        mutated = new Set()
        if (func.body) findMutations(frameNode(func), new Set(func.sig.params.map(q => q.name)), mutated)
      }
      if (mutated.has(p.name)) continue
      // OBJECT is the one PTR_ABI_KINDS member whose unboxed i32 offset is
      // ambiguous without a schema id: SET/MAP/BUFFER have a fixed runtime layout
      // (aux always 0, per narrowPointerResults), but an OBJECT's payload slots are
      // laid out per-schema, and the offset alone can't tell a reader which schema
      // to rebox against. r.schemaId is the SAME hard (never-reset) call-site fact
      // narrowPointerResults' return-value arm trusts (param-reps.js: "schemaId ...
      // stay HARD"); demanding it here too, and skipping the narrow when it's absent
      // or conflicting, closes the gap this function used to leave: it set
      // p.ptrKind = VAL.OBJECT with no p.ptrAux, so every later reboxer of this
      // param — asF64's boxPtrIR defaults an omitted aux to 0 — stamped the offset
      // with WHATEVER schema happens to be id 0 program-wide (a live, unrelated
      // object's field layout, not this parameter's own). A fresh instance built
      // from that mistagged parameter (watr's own `normalize(opts)`, opts narrowed
      // this way with no callers.length>1 disagreement to save it) then reads as
      // if it belonged to schema 0 — the wild "phantom keys" class of miscompile.
      if (hv === VAL.OBJECT) {
        const aux = r.schemaId
        if (aux == null) continue
        p.ptrAux = aux
      }
      p.type = 'i32'
      p.ptrKind = hv
    }
  }
}

export function narrowableFuncs(addressTaken) {
  return ctx.funcs.list.filter(f =>
    !f.raw && !addressTaken.has(f.name) && f.sig.results.length === 1
  )
}

export function applyTypedPointerParamAbi(paramReps, addressTaken) {
  for (const func of ctx.funcs.list) {
    if (func.raw || addressTaken.has(func.name)) continue
    // An exported function narrows only the parameters the export contract
    // normalizes at entry (applyExportTypedArrayAbi); the host may pass anything
    // to the rest.
    const exported = isExported(func)
    if (exported && !func.sig.params.some(p => p.boundaryTyped)) continue
    const reps = paramReps.get(func.name)
    if (!reps) continue
    const restIdx = func.rest ? func.sig.params.length - 1 : -1
    let mutated = null   // body-write guard — same contract as applyPointerParamAbi
    for (const [k, r] of reps) {
      const ctor = r.typedCtor
      if (ctor == null) continue
      // An argument absent on some path (an uninitialized `let` returned, a
      // record field assigned on the other path) keeps its constructor for the
      // body's reads, but an i32 offset has no `undefined`: the boxed carrier
      // stays, so `o instanceof Float32Array` and `o == null` can see it.
      if (r.mayBeUndefined) continue
      if (exported && !func.sig.params[k]?.boundaryTyped) continue
      if (k === restIdx) continue
      if (k >= func.sig.params.length) continue
      const p = func.sig.params[k]
      if (p.type === 'i32') continue
      if (func.defaults?.[p.name] != null) continue
      if (mutated === null) {
        mutated = new Set()
        if (func.body) findMutations(frameNode(func), new Set(func.sig.params.map(q => q.name)), mutated)
      }
      if (mutated.has(p.name)) continue
      const aux = typedElemAux(ctor)
      if (aux == null) continue
      p.type = 'i32'
      p.ptrKind = VAL.TYPED
      p.ptrAux = aux
    }
  }
}


/** The element kinds an export's typed slots take. The origin, under the public
 *  name, takes Float64Array at every slot; each variant, under a hidden export
 *  name (`<function>:<key>`), is the same body with its own kinds: Float32Array
 *  at every slot, or Float32Array at the in-place slots (stored into and read)
 *  and Float64Array at the others. The host calls the one its arguments fit
 *  exactly (interop.js), so an element the body stores and reads back rounds
 *  as the caller's own array rounds it, and a Float32Array block crosses as
 *  itself. */
const ORIGIN_KINDS = { inPlace: 'Float64Array', other: 'Float64Array' }
const KIND_VARIANTS = [
  { key: 'Float32Array', inPlace: 'Float32Array', other: 'Float32Array' },
  { key: 'mixed', inPlace: 'Float32Array', other: 'Float64Array' },
]

/** Each node of `from` → its copy in `to`, a structural clone (ast.js cloneNode). */
function twinNodes(from, to) {
  const twin = new Map(), stack = [from, to]
  while (stack.length) {
    const b = stack.pop(), a = stack.pop()
    if (!Array.isArray(a) || !Array.isArray(b)) continue
    twin.set(a, b)
    for (let i = 0; i < a.length; i++) stack.push(a[i], b[i])
  }
  return twin
}

/** A slot takes the typed pointer ABI in `ctor`'s kind: the wrapper normalizes
 *  the host value at entry, the lattice sees a typed argument at every
 *  forward. The pointer narrowing itself waits for applyTypedPointerParamAbi,
 *  after the fixpoint: an i32 signature this early reads as a numeric i32 at
 *  every forward (applyI32ParamSpecialization) instead of a pointer. A
 *  trailing `+` asks the wrapper to copy the storage back after the call. */
function typeSlot(func, k, ctor, writes, inPlace, paramReps) {
  const p = func.sig.params[k], rep = ensureParamRep(paramReps, func.name, k)
  rep.val = VAL.TYPED
  ;(rep.possibleKinds ||= new Set()).add(VAL.TYPED)   // the boundary supplies this kind
  rep.typedCtor = 'new.' + ctor
  rep.recvArrTyped = true   // the receiver IS typed: no runtime kind probe at reads
  p.boundaryTyped = writes ? ctor + '+' : ctor
  if (inPlace) p.boundaryInPlace = true
}

/** The kind variants an export's slots call for, each exported under its
 *  hidden name, minted once: Float32Array always, the mixed kinds only where
 *  an in-place slot and another stand side by side (otherwise they are the
 *  origin's, or Float32Array's). A variant minted after some slots took the
 *  origin's kinds takes them in its own. A variant calls what its origin
 *  calls, from its own body: those calls join the census, so every callee's
 *  lattice sees the kinds the variant passes (a callee fed two kinds splits
 *  per kind, specializeBimorphicTyped). */
function mintKindVariants(func, slots, paramReps, callSites) {
  const typed = func.sig.params.filter(p => p.boundaryTyped)
  const inPlace = typed.some(p => p.boundaryInPlace) || slots.some(s => s.inPlace)
  const other = typed.some(p => !p.boundaryInPlace) || slots.some(s => !s.inPlace)
  const own = callSites.filter(cs => cs.callerFunc === func)
  func.boundaryVariants ??= []
  for (const kinds of KIND_VARIANTS) {
    if (func.boundaryVariants.some(v => v.func.boundaryKinds === kinds)) continue
    if (kinds.inPlace !== kinds.other && !(inPlace && other)) continue
    const clone = materializeVariant({ origin: func, name: `${func.name}$${kinds.key}`, kind: 'boundary-kind', paramReps, eligibleSites: [], fallback: func })
    clone.boundaryKinds = kinds
    clone.boundaryOrigin = func.name
    // a slot copied typed keeps its in-place mark: it takes its kind in the variant's
    clone.sig.params.forEach((p, k) => { if (p.boundaryTyped) typeSlot(clone, k, p.boundaryInPlace ? kinds.inPlace : kinds.other, p.boundaryTyped.endsWith('+'), !!p.boundaryInPlace, paramReps) })
    const twin = twinNodes(func.body, clone.body), at = n => twin.get(n) ?? n
    for (const cs of own) {
      if (!twin.has(cs.node)) continue
      const argList = cs.argList.map(at), node = at(cs.node)
      callSites.push(cs.synthetic ? { callee: cs.callee, argList, callerFunc: clone, node, synthetic: true } : { callee: cs.callee, argList, callerFunc: clone, node })
    }
    const exportName = `${func.name}:${kinds.key}`
    ctx.funcs.exports[exportName] = clone.name
    func.boundaryVariants.push({ exportName, func: clone })
  }
}

/** Exported parameters used only as numeric array-likes (paramNumericArrayLike)
 *  take the typed pointer ABI (typeSlot, `jz:i64exp` `t`, the in-place slots in
 *  `k`), and the body reads typed storage. A round types an export's slots in
 *  the origin and in each kind variant (above) by its own kinds, so every
 *  round's summary sees them all. Seeded before the signature fixpoint so
 *  callees fed from the parameter inherit the kind. */
export function applyExportTypedArrayAbi(paramReps, callSites, addressTaken) {
  const touched = []
  const calledInside = new Set()
  for (const cs of callSites) calledInside.add(cs.callee)
  // A copy: minting appends the variants, typed here with their origin.
  for (const func of ctx.funcs.list.slice()) {
    if (!isExported(func) || func.raw || !func.body || func.boundaryOrigin) continue
    // The contract holds at the boundary only: an internal caller or a value
    // use could hand the function any array, so such exports keep the dynamic path.
    if (calledInside.has(func.name) || addressTaken.has(func.name)) continue
    const restIdx = func.rest ? func.sig.params.length - 1 : -1
    const slots = []
    func.sig.params.forEach((p, k) => {
      if (k === restIdx || p.boundaryTyped || p.type !== 'f64' || p.ptrKind != null || p.jsstring || func.defaults?.[p.name] != null) return
      const use = paramNumericArrayLike(frameNode(func), p.name, new Set(), func.sig.params.map(q => q.name))
      // An element the body stores and reads back observes the element kind.
      if (use) slots.push({ k, writes: use.writes, inPlace: use.writes && use.reads })
    })
    if (!slots.length) continue
    mintKindVariants(func, slots, paramReps, callSites)
    for (const target of [func, ...func.boundaryVariants.map(v => v.func)]) {
      const kinds = target.boundaryKinds ?? ORIGIN_KINDS
      for (const { k, writes, inPlace } of slots) typeSlot(target, k, inPlace ? kinds.inPlace : kinds.other, writes, inPlace, paramReps)
      touched.push(target.body)
    }
    // The typed readers live in the typedarray module, which only a source
    // constructor would otherwise pull in.
    ctx.module.include?.('typedarray')
  }
  // A settled signature fact: the bodies read their parameters' kinds (analyze.js seam).
  if (touched.length) invalidateBodies(touched)
  return touched.length > 0
}

