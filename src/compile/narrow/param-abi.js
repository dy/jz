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
import { findMutations, reanalyzeBody, invalidateBodies } from '../analyze.js'
import { intLevelMap } from '../../type.js'
import { typedElemAux } from '../../../layout.js'
import { VAL } from '../../reps.js'
import { PTR_ABI_KINDS } from './caller-ctx.js'

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
  invalidateBodies(touched)
  return ok
}

export function applyI32ParamSpecialization(paramReps, valueUsed, sitesByCallee, { skipTyped = false } = {}) {
  for (const func of ctx.funcs.list) {
    if (func.raw || valueUsed.has(func.name)) continue
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
    let mutated = null
    for (const [k, r] of reps) {
      if (k === restIdx || k >= func.sig.params.length) continue
      const p = func.sig.params[k]
      if (func.defaults?.[p.name] != null) continue
      // Admit 'f64' evidence too (beyond the plain i32/v128 gate below) — ONLY
      // the mutated branch may act on it, via the mutation-safety +
      // caller-consistency proof; the non-mutated tail still requires a hard
      // 'i32'/'v128' verdict, unchanged.
      if (r.wasm !== 'v128' && r.wasm !== 'i32' && r.wasm !== 'f64') continue
      if (r.wasm === 'i32' && p.type === 'i32') continue
      if (mutated === null) {
        mutated = new Set()
        if (func.body) findMutations(func.body, new Set(func.sig.params.map(p => p.name)), mutated)
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
      if (r.wasm !== 'i32') continue
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
export function validateTypedLenParams(paramReps, valueUsed) {
  for (const func of ctx.funcs.list) {
    const hostReachable = func.exported || func.raw || valueUsed.has(func.name)
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
    findMutations(func.body, new Set(candidates.keys()), mutated)
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
export function validateLenBoundOfParams(paramReps, valueUsed) {
  for (const func of ctx.funcs.list) {
    const hostReachable = func.exported || func.raw || valueUsed.has(func.name)
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
      findMutations(func.body, new Set([pname, recvName]), mutated)
      if (mutated.has(pname) || mutated.has(recvName)) r.lenBoundOf = null
    }
  }
}

export function validateIntConstParams(paramReps, valueUsed) {
  for (const func of ctx.funcs.list) {
    if (func.exported || func.raw || valueUsed.has(func.name)) continue
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
    findMutations(func.body, new Set(candidates.keys()), mutated)
    for (const name of mutated) candidates.get(name).intConst = null
  }
}

export function applyPointerParamAbi(paramReps, valueUsed, hardParamVal) {
  for (const func of ctx.funcs.list) {
    if (func.exported || func.raw || valueUsed.has(func.name)) continue
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
      // Re-fold call sites HARD (the shared val lattice is soft, so r.val may be a
      // partial consensus from typed sites alone) — only specialize when every site
      // proves the same pointer kind.
      const hv = hardParamVal(func.name, k)
      if (!PTR_ABI_KINDS.has(hv)) continue
      if (k === restIdx) continue
      if (k >= func.sig.params.length) continue
      const p = func.sig.params[k]
      if (p.type === 'i32') continue
      if (func.defaults?.[p.name] != null) continue
      if (mutated === null) {
        mutated = new Set()
        if (func.body) findMutations(func.body, new Set(func.sig.params.map(q => q.name)), mutated)
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

export function narrowableFuncs(valueUsed) {
  return ctx.funcs.list.filter(f =>
    !f.raw && !valueUsed.has(f.name) && f.sig.results.length === 1
  )
}

export function applyTypedPointerParamAbi(paramReps, valueUsed) {
  for (const func of ctx.funcs.list) {
    if (func.exported || func.raw || valueUsed.has(func.name)) continue
    const reps = paramReps.get(func.name)
    if (!reps) continue
    const restIdx = func.rest ? func.sig.params.length - 1 : -1
    let mutated = null   // body-write guard — same contract as applyPointerParamAbi
    for (const [k, r] of reps) {
      const ctor = r.typedCtor
      if (ctor == null) continue
      if (k === restIdx) continue
      if (k >= func.sig.params.length) continue
      const p = func.sig.params[k]
      if (p.type === 'i32') continue
      if (func.defaults?.[p.name] != null) continue
      if (mutated === null) {
        mutated = new Set()
        if (func.body) findMutations(func.body, new Set(func.sig.params.map(q => q.name)), mutated)
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

