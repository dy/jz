/**
 * Numeric/VAL-kind/pointer/bool function-result narrowing, plus return-path
 * array-elem propagation — Phases E/E2/E3 of narrowSignatures' fixpoint
 * (narrowI32Results/narrowValResults/narrowPointerResults/narrowReturnArrayElems)
 * and narrowBoolResults, the leaf-module-skip-path bool/bigint inference that
 * runs even when whole-program narrowing itself is skipped.
 *
 * @module compile/narrow/results
 */

import { ctx } from '../../ctx.js'
import { withCurrentFunction, withFunctionFields, withTypedElems } from '../flow-state.js'
import {
  isBlockBody, alwaysReturns, hasBareReturn, returnExprs, callArgs, walkAst, some,
} from '../../ast.js'
import { analyzeBody, reanalyzeBody, invalidateBodies } from '../analyze.js'
import { exprType, typedElemCtor } from '../../type.js'
import { typedElemAux, ctorFromElemAux } from '../../../layout.js'
import {
  valTypeOf, valTypeOfWithLocals, hasAmbiguousBoolMerge, exprMayBeUndefinedIn,
} from '../../kind.js'
import { VAL, lookupValType } from '../../reps.js'
import { paramFactsOf } from '../../param-reps.js'
import { inferSchemaId } from '../infer.js'
import { isExported } from '../func-exports.js'

/**
 * Phase E: numeric result narrowing.
 *
 * For every narrowable func whose body returns only i32-typed expressions,
 * narrow sig.results[0] to 'i32'. An *unsigned* tail flips sig.unsignedResult so
 * the call-site rebox uses f64.convert_i32_u and preserves [0, 2^32) range.
 * A tail is unsigned when it is a top-level `(x >>> 0)` OR a call to a function
 * already narrowed `unsignedResult` — the latter propagates the flag through
 * helper chains (`const u = x => (x|0)>>>0; const main = x => u(x)`), which a
 * literal-`>>>`-only check would miss, reboxing main's result signed and
 * silently turning `4294967295` into `-1`.
 *
 * Sign must be consistent across *all* tails: the same i32 bit pattern maps to
 * two different JS numbers under signed vs unsigned conversion, so a function
 * mixing signed (`x|0`) and unsigned (`x>>>0`) tails cannot be reboxed with a
 * single boundary flag. Such functions are left at f64 — the body then converts
 * each tail with its own sign. (Pre-fix, a top-level `>>>` next to a signed tail
 * narrowed unsigned and corrupted the signed branch.)
 *
 * Fixpoint: a call to another narrowed func contributes i32; iterate until
 * stable so chains of i32-only helpers all narrow together. exprType already
 * consults ctx.funcs.map for narrowed user-function results plus the
 * Math.imul/Math.clz32/charCodeAt stdlib subset.
 *
 * Safe for exports — boundary wrapper restores the f64 JS ABI. `return;`
 * (bare) is preserved as f64; multi-value / raw / value-used are skipped by
 * the narrowable filter.
 */
export function narrowI32Results(funcs) {
  // A return tail's SIGN — 'unsigned' (a uint32 magnitude that needs
  // f64.convert_i32_u at the boundary), 'signed' (ordinary ToInt32 range,
  // f64.convert_i32_s), or null (an unsigned value reaches this tail but the
  // classifier can't collapse it to one boundary flag — narrowing must be
  // REFUSED, not guessed). Grounded in the three base facts: a top-level
  // `>>>` (ECMA-262 §7.1.8 ToUint32), a call to a function already proven
  // unsignedResult, or a bare read of THIS body's own narrowUint32-proven
  // accumulator local (`unsignedLocals` — see analyze-scans.js: a local whose
  // every reassignment is `name = (…) >>> k` always holds a canonical uint32
  // bit pattern, `return acc` included).
  //
  // That sign then THREADS through every identity-preserving position an
  // expression can sit in on its way to the tail, instead of being decided
  // once (as an i32 STORAGE type, in exprType) and separately re-derived here
  // from a syntactic allowlist that stops at the outermost node: `u+` (ToNumber
  // is identity on a number — exprType already treats it as type-preserving,
  // src/type.js's own `op === 'u+'` comment), a `,` tail (only the last
  // member's value survives), and a '?:' / '&&' / '||' JOIN — sign-preserving
  // only when BOTH value-arms agree (mirrors the whole-function cross-tail
  // rule below: a function mixing a signed and an unsigned RETURN also stays
  // f64, because the same i32 bit pattern maps to two different JS numbers
  // under the two conversions). A mismatched join (one arm unsigned, the
  // other signed-or-itself-null) is exactly the unclassifiable case: which
  // value reaches the boundary is a RUNTIME branch, so no single static flag
  // can rebox it — null propagates outward and vetoes i32 narrowing for the
  // whole function (falling back to f64, where each arm already carries its
  // own correct value, is merely slower — silently reboxing the unsigned arm
  // SIGNED, or vice versa, is a silent wrong answer).
  //
  // Any other op (comparison, bitwise, arithmetic, a plain call, `.`/`[]`)
  // defaults to 'signed': a comparison/logical-not is always a 0/1 boolean, a
  // non-`>>>` bitwise result is spec'd ToInt32 regardless of operand sign
  // (`h | 0` is the canonical uint32→int32 RESIGN idiom — its result is a
  // genuinely different, genuinely signed number), and `+`/`-`/`*`/`%` on an
  // unproven-range operand already fail exprType's own magnitude-bound proof
  // (never reach 'i32' at all) — so 'signed' here is a proof, not a guess.
  //
  // Pre-fix, missing the `unsignedLocals` base case alone narrowed e.g.
  // `let h = 0; h = (…) >>> 0; return h` to a signed i32 result — the
  // export/call-site boundary reboxed with f64.convert_i32_s and silently
  // flipped any h ≥ 2^31 negative (djb2/FNV-style hash accumulators returned
  // bare, not re-masked through a final `>>> 0`). Threading that same fact
  // through `u+`/`?:` closed the identical leak one AST shape over: `return
  // +h` and `return c ? h : h` narrowed the same way, for the same reason —
  // exprType already called both tails 'i32' (u+ and a same-typed join are
  // both type-preserving there), but the OLD isUnsignedTail's allowlist ended
  // at the outermost node and never looked through them.
  const tailSign = (e, unsignedLocals) => {
    if (!Array.isArray(e)) return typeof e === 'string' && (unsignedLocals?.has(e) ?? false) ? 'unsigned' : 'signed'
    const op = e[0]
    if (op === '>>>') return 'unsigned'
    if (op === '()' && typeof e[1] === 'string' && ctx.funcs.map?.get(e[1])?.sig?.unsignedResult === true) return 'unsigned'
    if (op === 'u+') return tailSign(e[1], unsignedLocals)
    if (op === ',') return tailSign(e[e.length - 1], unsignedLocals)
    if ((op === '?:' && e.length === 4) || ((op === '&&' || op === '||') && e.length === 3)) {
      const [a, b] = op === '?:' ? [e[2], e[3]] : [e[1], e[2]]
      const sa = tailSign(a, unsignedLocals), sb = tailSign(b, unsignedLocals)
      return sa === sb ? sa : null   // mismatch (or either side already null) — unclassifiable
    }
    return 'signed'
  }
  const isUnsignedTail = (e, unsignedLocals) => tailSign(e, unsignedLocals) === 'unsigned'
  const isUnclassifiableTail = (e, unsignedLocals) => tailSign(e, unsignedLocals) === null
  const callsSelf = (n, name) => Array.isArray(n) && ((n[0] === '()' && n[1] === name) || n.some(c => callsSelf(c, name)))
  // Classify a func's return tails as all-v128 / all-i32 (+ sign) under the CURRENT sig.results.
  const evalTails = (func, body, exprs) => withCurrentFunction(func.sig, () => {
    // valTypes: analyzeBody's VAL-kind facts, threaded into exprType's bitwise-ops
    // BigInt gate (src/type.js) — see that gate's comment. Without it a proven-
    // BIGINT local's `~n`/`n & mask` return tail silently narrowed the WASM
    // result to i32 here while E2 (narrowValResults, below) correctly claimed
    // BIGINT for the same tail — a WAT-validation crash (the two phases'
    // per-tail facts about the same expression must agree).
    const bodyFacts = isBlockBody(body) ? analyzeBody(body) : null
    const locals = bodyFacts ? bodyFacts.locals : new Map()
    const valTypes = bodyFacts?.valTypes
    for (const p of func.sig.params) if (!locals.has(p.name)) locals.set(p.name, p.type)
    // Seed the typedElem overlay with this func's TYPED-pointer params so a return tail
    // reading a typed-array element — `return vals[h]`, vals an Int32Array param (dict's
    // `lookup`) — types as i32, not NaN-boxed f64. Without it the call site keeps the full
    // __typed_idx/ToNumber unbox dispatch (491520× per dict kernel run). Mirrors
    // refreshCallerLocals + analyzeFuncForEmit. Only meaningful once Phase G has tagged params
    // ptrKind=TYPED (the I2 re-run below); harmless before (no typed params → overlay untouched).
    const savedTE = ctx.func.typedElem
    let te = null
    for (const p of func.sig.params) {
      if (p.ptrKind === VAL.TYPED && p.ptrAux != null) {
        const c = ctorFromElemAux(p.ptrAux)
        if (c != null) { if (!te) te = savedTE ? new Map(savedTE) : new Map(); te.set(p.name, c) }
      }
    }
    const classify = () => {
    const allV128 = exprs.every(e => exprType(e, locals, valTypes) === 'v128')
    // research.md §Carrier invariant: exprType's own '&&'/'||'/'?:' conciliation
    // (src/type.js) only asks "is each branch i32-representable", the same
    // question CMP_OPS-vs-NUMBER-literal both answer 'i32' to — it has no
    // notion of hasAmbiguousBoolMerge's BOOL∪NUMBER identity concern, so
    // `return (x>0)&&1` narrowed this func's WASM result to i32 even though
    // the false-branch value is a genuine JS `false`, not the NUMBER 0: the
    // i32→f64 export rebox (`f64.convert_i32_s`) can only ever produce a raw
    // number, permanently losing the FALSE atom no downstream fix could
    // recover (e.g. `f(-1)` returns 0, where the JS oracle is `false`). A
    // locals-aware hasAmbiguousBoolMerge (this phase runs before
    // ctx.func.localReps is populated for the func under analysis — mirrors
    // the BigInt gate two lines below) vetoes i32-narrowing for any such
    // tail, leaving the function at f64 so the return-tail boxing this
    // design's step 1 covers (emit.js 'return', ctx.func.mixedAtomReturn)
    // still gets a chance to run.
    const resolveLocal = name => valTypes?.get(name) ?? lookupValType(name)
    const anyAmbiguous = exprs.some(e => hasAmbiguousBoolMerge(e, ex => valTypeOfWithLocals(ex, resolveLocal)))
    // `body` as `exprType`'s optional `bodyRoot` (§14 point 4 fallout, src/type.js's
    // own doc comment on the parameter): this whole-program pre-pass runs before
    // ctx.func.localReps is live, so the bitwise-ops BigInt guard's bare-name arm
    // needs the ctx-independent structural trace (exprPresentValIn) instead.
    const allI32 = !allV128 && !anyAmbiguous && exprs.every(e => exprType(e, locals, valTypes, true, body) === 'i32')
    const unsignedLocals = bodyFacts?.unsignedLocals
    return {
      allV128, allI32,
      anyUnsigned: exprs.some(e => isUnsignedTail(e, unsignedLocals)),
      allUnsigned: exprs.every(e => isUnsignedTail(e, unsignedLocals)),
      // A mismatched '?:'/'&&'/'||' join (one value-arm unsigned, the other
      // not) reaching a tail — narrowing to EITHER sign would silently
      // corrupt whichever arm's convention it guessed wrong. Vetoes the i32
      // commit below outright, same as a magnitude/BigInt/atom veto.
      anyUnclassifiable: exprs.some(e => isUnclassifiableTail(e, unsignedLocals)),
    }
    }
    return te ? withTypedElems(te, classify) : classify()
  })
  let changed = true
  while (changed) {
    changed = false
    for (const func of funcs) {
      if (func.sig.results[0] === 'i32' || func.sig.results[0] === 'v128') continue
      const body = func.body
      if (isBlockBody(body) && hasBareReturn(body)) continue
      const exprs = returnExprs(body)
      if (!exprs.length) continue
      let r = evalTails(func, body, exprs)
      // Recursive result cycle: a self-call in a return tail — or feeding a returned local
      // (nqueens' `cnt = cnt + solve(…); return cnt`) — reads solve's own not-yet-narrowed
      // f64 result, so `cnt` widens to f64 and the i32 narrowing never fires. Break the cycle
      // optimistically: tentatively assume the i32 result, re-analyze, and keep it ONLY if every
      // tail is then i32 (else revert). Sound — committed only when self-consistent.
      if (!r.allI32 && !r.allV128 && callsSelf(body, func.name)) {
        const saved = func.sig.results
        func.sig.results = ['i32']
        const opt = reanalyzeBody(body, () => evalTails(func, body, exprs))
        if (opt.allI32 && !opt.anyUnclassifiable && (!opt.anyUnsigned || opt.allUnsigned)) {
          if (opt.allUnsigned) func.sig.unsignedResult = true
          changed = true
          continue
        }
        func.sig.results = saved
        r = reanalyzeBody(body, () => evalTails(func, body, exprs))
      }
      // SIMD: every tail returns a lane vector → v128 result.
      if (r.allV128) {
        func.sig.results = ['v128']
        changed = true
      } else if (r.allI32 && !r.anyUnclassifiable && (!r.anyUnsigned || r.allUnsigned)) {   // sign-consistent i32 tails
        func.sig.results = ['i32']
        if (r.allUnsigned) func.sig.unsignedResult = true
        // A committed i32 result is a genuine NUMBER, so stamp valResult for the call-site
        // VAL dispatch — E2 (narrowValResults) ran ABOVE the param lattice and so couldn't
        // type a `return typedArrayParam[idx]` tail (hashjoin's `probe` → `vals[h]`), leaving
        // valResult unset → the hot `sum + probe()` stayed the polymorphic string-or-number
        // `+`. Only-if-unset: an UNBOXED-pointer i32 result already carries its ARRAY/OBJECT/
        // TYPED valResult (the unboxing ABI needs it), so this never overwrites a pointer kind.
        if (func.valResult == null) func.valResult = VAL.NUMBER
        changed = true
      }
    }
  }
}

/**
 * Phase E2: VAL-kind result inference.
 *
 * When every return-tail resolves to the same VAL.* kind, record it on
 * func.valResult so call-site valTypeOf inherits it (enables static dispatch
 * on .length / [i] / .prop through the call chain). Fixpoint propagates
 * through helper chains. Exports are safe — same boundary-wrapper guarantee
 * as numeric narrowing.
 */
// Install THIS function's own arr-elem VAL-kind facts (a body's analyzeBody(...)
// .arrElemValTypes slice) onto ctx.func.localReps for the duration of a
// return-kind resolution — the ARRAY sibling of the ctx.func.flatObjects
// install both narrowValResults and narrowBoolResults already do (same call
// site, same reasoning): kind.js VT['[]']'s `ctx.func.localReps?.get(name)?.
// arrayElemValType` rule is what a bare `return arr[i]` on a proven-element-
// kind array resolves through, and both return-kind pre-passes otherwise run
// "ABOVE" the per-function localReps state that fact normally rides on
// (populated at emit time — compile/index.js's analyzeFuncForEmit-equivalent
// `updateRep` loop over the identical `facts.arrElemValTypes` slice). Without
// this, `let a = [1n]; return a[0]` reads as an unproven (Number) boundary
// kind even though the i64 VALUE is already correct (.work/archive/todo.md
// "NOT FIXED, BANKED" entry — BigInt array literals never
// qualify for flat SRoA, so this whole-program fact is the only path to the
// correct kind).
//
// Only NON-NULL facts are installed. Fail-open is load-bearing here, not
// incidental: analyzeBody's observeArrValType poisons an entry to null the
// moment any element disagrees or an unknown-origin mutation touches the
// array (see analyze.js's `elemOrigin` comment — a fact only ever SETTLES
// non-null for a name whose contents trace to a construction origin: an
// array-literal init with every element statically visible, a fresh-ctor
// call, or a chained alias/call-return/`.map` of another already-proven
// source). "non-null in this Map" already IS the elemOrigin-gated proof this
// needs — asserting a kind (especially BIGINT, whose wrong-boxing is the
// documented historical hazard) off an unproven or poisoned entry would be
// the unsound direction; this only ever narrows, never widens, a claim.
function installArrElemReps(arrElemValTypes, prevReps) {
  if (!arrElemValTypes?.size) return prevReps
  let reps = null
  for (const [name, vt] of arrElemValTypes) {
    if (vt == null) continue
    if (!reps) reps = new Map(prevReps)
    reps.set(name, { ...reps.get(name), arrayElemValType: vt })
  }
  return reps || prevReps
}

export function narrowValResults(funcs) {
  // Delegates to kind.js's shared local-aware resolver (valTypeOfWithLocals) —
  // round-6 prereq (a): a plain valTypeOf(['++','n']) can't see a LOCAL's kind
  // (numericUnaryVT's own recursion always hits the GLOBAL lookupValType, never
  // this function's localValTypes/globalValTypes), which left `return ++n` on a
  // proven-BIGINT local exporting raw f64. The '+'/'?:'/'&&'/'||' cases (and the
  // SOUND-`+` rule below) used to be duplicated here; they now live once in
  // valTypeOfWithLocals. SOUND `+` at the result-stamping boundary: VT['+'] is
  // optimistic (unknown side → NUMBER — load-bearing for local inference), but
  // a func.valResult claim crosses into call-site compare dispatch, where a
  // misproved NUMBER on a string-building helper (watr's `hex + hex` _sb) made
  // `'7fff…' < '8000…'` compare raw NaN-boxed pointers (always false), folding
  // watr-in-kernel's i64.lt_s(-1,0) to 0. Unknown side → no claim. Named-
  // function call results (`f?.valResult`) route through valTypeOf(expr)'s own
  // VT['()'] → calleeValType, same as before this delegation.
  //
  // INVARIANT: NOT wired here — a same-body local-closure
  // extension — resolving `return parse(v)` (watr's uleb/limits shape) through
  // closureBodyReturnKind (flow-types.js) the moment a typeof-guard is
  // involved — round-tripped correctly NATIVE but diverged self-hosted
  // (JZ_TEST_TARGET=jz.wasm): narrowing to "typeof-refined closure return-kind
  // feeding an ENCLOSING function's own valResult" reproduced across two
  // independent closureBodyReturnKind implementations (extractRefinements-
  // driven and a hand-rolled typeofPredicate walk; shared-mutable-state and
  // pure-functional site collection) — same divergence both times, so it isn't
  // this function's own algorithm. Left OUT rather than shipped uncertain:
  // ctx.closure.valResult (module/function.js + kind-traits.js calleeValType)
  // is the part verified value-correct self-hosted (a call-site __to_num skip
  // through the identical typeof-guarded closure round-trips right under
  // kernel) and is what actually ships. A same-body `let parse = …; return
  // parse(v)` tail simply stays unproven here, same as any other call whose
  // callee valResult isn't yet knowable at planning time — fails open.
  const valTypeOfWithCalls = (expr, localValTypes) =>
    valTypeOfWithLocals(expr, name => localValTypes?.get(name) || ctx.scope.globalValTypes?.get(name) || null)
  let changed = true
  while (changed) {
    changed = false
    for (const func of funcs) {
      if (func.valResult) continue
      const body = func.body
      const isBlock = isBlockBody(body)
      if (isBlock && hasBareReturn(body)) continue
      const exprs = returnExprs(body)
      if (!exprs.length) continue
      const bodyFacts = isBlock ? analyzeBody(body) : null
      const localValTypes = bodyFacts ? bodyFacts.valTypes : new Map()
      // A `.`/`[]` return tail (`return obj.p`) resolves its kind through
      // kind.js VT['.'], which consults ctx.func.flatObjects for the SRoA
      // flat-object fast path — normally populated per-function at emit time
      // (compile/index.js), well AFTER this pass runs. Without it, a proven-
      // BIGINT flat field's return tail reads as unproven here (this pass ran
      // "ABOVE" per-function state, same class of gap as the schema.vars note
      // below) and the exported function keeps the wrong (Number) boundary
      // decode even though the value itself is correct. bodyFacts.flatObjects
      // is body-local and pure — safe to install for the duration of this
      // func's own valTypeOfWithCalls calls, then restore.
      const evaluate = () => {
        const vt0 = valTypeOfWithCalls(exprs[0], localValTypes)
        return [vt0, vt0 && exprs.every(e => valTypeOfWithCalls(e, localValTypes) === vt0)]
      }
      const [vt0, allSame] = bodyFacts
        ? withFunctionFields({
          flatObjects: bodyFacts.flatObjects,
          localReps: installArrElemReps(bodyFacts.arrElemValTypes, ctx.func.localReps),
        }, evaluate)
        : evaluate()
      if (!vt0) continue
      if (allSame) {
        func.valResult = vt0
        // mayBeUndefined return-kind join (Slice 2, .work/archive/todo.md
        // §deletion-sweep §3 "Return kinds"): OR across every return-tail
        // expr this SAME allSame fold already unified — a `return d[missing]`
        // arm's census shape, or a `return x` whose `x` traces to one through
        // this func's own writes (exprMayBeUndefinedIn — ctx-independent, see
        // kind.js), makes the whole result maybeUndefined. Additive-only, like
        // valResult itself: never re-checked once true.
        if (!func.valResultMayBeUndefined && exprs.some(e => exprMayBeUndefinedIn(e, body)))
          func.valResultMayBeUndefined = true
        changed = true
      }
    }
  }
}

const PTR_RESULT_KINDS_NOAUX = new Set([VAL.SET, VAL.MAP, VAL.BUFFER])

// Per-body local elemAux map: scans `let/const x = new TypedArray(...)` decls so a return
// like `let a = new Float64Array(...); return a` resolves to a constant aux.
function localElemAuxMap(body) {
  const m = new Map()
  walkAst(body, { enter: n => {
    const op = n[0]
    if (op === '=>') return false
    if ((op === 'let' || op === 'const') && n.length > 1) {
      for (let i = 1; i < n.length; i++) {
        const a = n[i]
        if (Array.isArray(a) && a[0] === '=' && typeof a[1] === 'string') {
          const aux = typedElemAux(typedElemCtor(a[2]))
          if (aux != null) m.set(a[1], aux)
        }
      }
    }
  } })
  return m
}

function typedAuxOfReturn(expr, localElemMap) {
  if (typeof expr === 'string') return localElemMap?.get(expr) ?? null
  if (!Array.isArray(expr)) return null
  const op = expr[0]
  if (op === '()' && typeof expr[1] === 'string') {
    if (expr[1].startsWith('new.')) {
      const ctor = typedElemCtor(expr)
      return ctor != null ? typedElemAux(ctor) : null
    }
    const f = ctx.funcs.map.get(expr[1])
    if (f?.valResult === VAL.TYPED && f.sig.ptrAux != null) return f.sig.ptrAux
    return null
  }
  if (op === '?:') {
    const a = typedAuxOfReturn(expr[2], localElemMap)
    const b = typedAuxOfReturn(expr[3], localElemMap)
    return a != null && a === b ? a : null
  }
  if (op === '&&' || op === '||') {
    const a = typedAuxOfReturn(expr[1], localElemMap)
    const b = typedAuxOfReturn(expr[2], localElemMap)
    return a != null && a === b ? a : null
  }
  return null
}

/**
 * Phase E3: pointer result narrowing.
 *
 * For narrowable funcs whose valResult is a non-ambiguous pointer kind with a
 * constant aux, narrow sig.results[0] from f64 to i32 and tag sig.ptrKind/.ptrAux.
 * Eliminates the f64.reinterpret_i64+i64.or rebox at every return and the
 * matching unbox dance at every call site that uses the value as a pointer.
 *
 * Aux strategy:
 *   - SET/MAP/BUFFER: aux always 0 — no per-callsite preservation needed.
 *   - OBJECT: aux is schema-id; narrow only when all return exprs share a constant
 *     schema (literal, schemaId-bound param, module-bound var, or call to another
 *     OBJECT-narrowed func). Caller picks aux up via callIR.ptrAux → readVar →
 *     localReps.schemaId, restoring property-slot dispatch through the call boundary.
 *   - TYPED: aux is elem-type; require all return tails to agree on a single aux.
 *
 * Skipped: ARRAY forwards on realloc, STRING dual-encoded SSO/heap, CLOSURE
 * (aux carries funcIdx for call_indirect). Body must guarantee-return so the
 * fallthrough fallback can't produce a wrong-typed undef.
 *
 * Fixpoint: a chain `outer → inner → {a,b}` needs inner to narrow first so
 * outer's call to inner contributes a known schema-id.
 */
/** True iff return-expr `e` is provably just `paramName` unchanged: either the bare
 *  name itself, or a recursive call to `func.name` that forwards `paramName` at its
 *  OWN parameter index (`return f(x, out, y)` inside `f`) — by induction on recursion
 *  depth, that call's result is whatever `f` would return given that same value, which
 *  bottoms out at the direct-return arms below. Strict AST-identity match only (no
 *  attempt to prove two *different* expressions are equal at runtime). */
function passesParamThrough(e, paramName, paramIdx, funcName) {
  if (e === paramName) return true
  if (!Array.isArray(e) || e[0] !== '()' || e[1] !== funcName) return false
  return callArgs(e)[paramIdx] === paramName
}

/** A function whose every return is the same parameter that was pointer-ABI
 *  narrowed to an unboxed i32 (p.ptrKind set) — directly, or via a same-function
 *  recursive call that forwards it unchanged (see passesParamThrough). Without the
 *  recursive case, a function like flow-types.js's extractRefinements — whose `!`
 *  branch delegates via `return extractRefinements(cond[1], out, !sense)` instead of
 *  a bare `return out` — fails the naive all-return-exprs-are-the-bare-name check on
 *  that ONE path, so the whole function loses ptrKind tracking (see
 *  narrowPointerResults below): the caller then numeric-converts the returned offset
 *  bits into a bogus float instead of reboxing them into a NaN-boxed pointer — a
 *  silent value corruption, not a compile error, that only a receiver expecting the
 *  real pointer (e.g. Map.prototype.size's raw __len dispatch) turns into a wild
 *  offset read.
 *
 *  Every path must also yield a real value, not fall through / bare-`return` into
 *  `undefined` (an f64 atom) — a match here forces this function's signature to
 *  unconditional i32, so a value-less path would be a genuine wasm type error
 *  (validated on encode, not just a mistracked type). Same guarantee
 *  narrowPointerResults' func.valResult-driven arm takes via alwaysReturns, and
 *  narrowValResults skips via hasBareReturn, for the identical reason: a recursive
 *  walker whose tail happens to read `return helper(...)` (a value only its OWN
 *  recursive call consumes) commonly has OTHER arms that are bare `return;`
 *  early-exits — real shape, not hypothetical (plan/literals.js's
 *  _disqualifyPromotion: single value-bearing return via self-recursion, but
 *  multiple bare `return`s alongside it that returnExprs below never sees).
 *
 *  Returns that param, else null. */
function passthroughPtrParam(func) {
  const body = func.body
  if (isBlockBody(body) && (!alwaysReturns(body) || hasBareReturn(body))) return null
  const exprs = returnExprs(body)
  if (!exprs.length) return null
  return func.sig.params.find((p, idx) =>
    p.ptrKind && exprs.every(e => passesParamThrough(e, p.name, idx, func.name))) || null
}

/** A function whose every return is a plain call `callee(...)` INTO another,
 *  already pointer-ABI-narrowed function (own-param passthrough one call-hop
 *  removed — `mk = () => { let x = new Map(); return pick(x) }`, `pick`'s
 *  OWN param already narrowed to VAL.MAP by passthroughPtrParam above). The
 *  result IS the callee's pointer, so mk's sig must inherit its ptrKind (+
 *  ptrAux) exactly like the param case.
 *
 *  This is NOT a redundant restatement of the `func.valResult`-driven arm
 *  below: narrowSignatures' earlier E-phase sweep (src/compile/plan/index.js
 *  runs narrowI32Results there, before this function's own first call)
 *  classifies a call tail purely by the callee's WASM-level result TYPE
 *  ('i32' vs 'f64') — it has no notion of ptrKind, so once a param
 *  passthrough like `pick` narrows to i32 for genuinely being a pointer,
 *  any CALLER whose return is `pick(x)` reads that i32 as an ordinary
 *  number on the very same fixpoint sweep and
 *  (finding valResult still unset) commits `valResult = VAL.NUMBER` — wrong,
 *  and load-bearing-wrong: the `func.valResult`-driven arm below requires
 *  `sig.results[0] === 'f64'`, a precondition narrowI32Results has already
 *  destroyed by the time THIS function gets a chance to run, so the mistake
 *  is never revisited. `passthroughPtrParam` above survives the identical
 *  race only because its branch has no such precondition — it overwrites
 *  unconditionally. This does the same, one call-hop out: found live via an
 *  O0 `let m = mk(); m.set(k, v); m.has(k)` receiver laundered through a
 *  `mk`/`pick` pair — the miss was `m`'s NaN-boxed pointer bits getting
 *  numerically converted (f64.convert_i32_s) instead of reboxed at the
 *  `.set`/`.has` call sites, corrupting the Map identity into an ordinary
 *  finite double every key silently missed against.
 *
 *  Returns the callee's `sig` (ptrKind/.ptrAux already resolved), else null. */
function passthroughPtrCall(func) {
  const body = func.body
  if (isBlockBody(body) && (!alwaysReturns(body) || hasBareReturn(body))) return null
  const exprs = returnExprs(body)
  if (!exprs.length) return null
  let calleeSig = null
  for (const e of exprs) {
    if (!Array.isArray(e) || e[0] !== '()' || typeof e[1] !== 'string' || e[1] === func.name) return null
    const callee = ctx.funcs.map?.get(e[1])
    const sig = callee?.sig
    if (sig?.ptrKind == null) return null
    if (calleeSig == null) calleeSig = sig
    else if (calleeSig.ptrKind !== sig.ptrKind || calleeSig.ptrAux !== sig.ptrAux) return null
  }
  return calleeSig
}

export function narrowPointerResults(funcs, paramReps) {
  let changed = true
  while (changed) {
    changed = false
    for (const func of funcs) {
      // Pointer pass-through: every return is the same parameter that
      // applyPointerParamAbi narrowed to an unboxed i32 pointer. The result IS that
      // pointer, so its sig must carry the param's ptrKind (+ schemaId for OBJECT).
      // Without this the result is a bare i32 the caller numeric-converts
      // (`f64.convert_i32_s`) instead of reboxing — dropping the schema-id so a
      // later `.prop` read mis-resolves to `undefined`. narrowValResults can't see
      // this (it reads body-locals, not param facts) and narrowI32Results steals it
      // as a numeric i32, so resolve it here from the settled param lattice.
      if (func.sig.ptrKind == null) {
        const pp = passthroughPtrParam(func)
        if (pp) {
          // OBJECT reboxes by schema-id; TYPED by the param's ELEM-TYPE bits
          // (pp.ptrAux) — without them the caller reboxes with aux 0 (Int8
          // dispatch) and every read of the returned array mis-strides to 0.
          const aux = pp.ptrKind === VAL.OBJECT
            ? paramFactsOf(paramReps, func, 'schemaId')?.get(pp.name) ?? null
            : pp.ptrAux ?? null
          // OBJECT needs a known schema-id to rebox; a polymorphic pass-through
          // (conflicting schemas → null) keeps its current handling.
          if (pp.ptrKind !== VAL.OBJECT || aux != null) {
            func.sig.results = ['i32']
            func.sig.ptrKind = pp.ptrKind
            func.valResult = pp.ptrKind
            if (aux != null) func.sig.ptrAux = aux
            changed = true
            continue
          }
        }
        // Call pass-through (passthroughPtrCall's own doc comment): every return is a
        // call straight into an already ptrKind-narrowed function. Same unconditional
        // overwrite as the param case just above, for the same reason (survives
        // narrowI32Results' earlier wrong NUMBER guess, which the func.valResult arm
        // below cannot — its `sig.results[0] === 'f64'` precondition is already gone).
        const cp = passthroughPtrCall(func)
        if (cp) {
          func.sig.results = ['i32']
          func.sig.ptrKind = cp.ptrKind
          func.valResult = cp.ptrKind
          if (cp.ptrAux != null) func.sig.ptrAux = cp.ptrAux
          changed = true
          continue
        }
      }
      if (!func.valResult) continue
      if (func.sig.results[0] !== 'f64') continue
      const isBlock = isBlockBody(func.body)
      if (isBlock && !alwaysReturns(func.body)) continue
      if (PTR_RESULT_KINDS_NOAUX.has(func.valResult)) {
        func.sig.results = ['i32']
        func.sig.ptrKind = func.valResult
        changed = true
        continue
      }
      const exprs = returnExprs(func.body)
      if (!exprs.length) continue
      if (func.valResult === VAL.OBJECT) {
        const paramSchemasMap = paramFactsOf(paramReps, func, 'schemaId')
        const sid0 = inferSchemaId(exprs[0], paramSchemasMap)
        if (sid0 == null) continue
        if (!exprs.every(e => inferSchemaId(e, paramSchemasMap) === sid0)) continue
        func.sig.results = ['i32']
        func.sig.ptrKind = VAL.OBJECT
        func.sig.ptrAux = sid0
        changed = true
      } else if (func.valResult === VAL.TYPED) {
        const localMap = isBlock ? localElemAuxMap(func.body) : null
        const aux0 = typedAuxOfReturn(exprs[0], localMap)
        if (aux0 == null) continue
        if (!exprs.every(e => typedAuxOfReturn(e, localMap) === aux0)) continue
        func.sig.results = ['i32']
        func.sig.ptrKind = VAL.TYPED
        func.sig.ptrAux = aux0
        changed = true
      }
    }
  }
}

const _FIELD_TO_SLICE = {
  arrayElemSchema: 'arrElemSchemas',
  arrayElemSchemaSet: 'arrElemSchemaSets',
  arrayElemValType: 'arrElemValTypes',
}

/** Propagate Array<T> element facts from return paths into caller paramReps (phase G). */
export function narrowReturnArrayElems(field, paramReps, addressTaken) {
  const sliceKey = _FIELD_TO_SLICE[field]
  const targets = ctx.funcs.list.filter(f =>
    !f.raw && !isExported(f) && !addressTaken.has(f.name) &&
    f.valResult === VAL.ARRAY && f[field] == null
  )
  let changed = true
  while (changed) {
    changed = false
    invalidateBodies(targets.map(f => f.body))
    for (const func of targets) {
      if (func[field] != null) continue
      const isBlock = isBlockBody(func.body)
      if (isBlock && !alwaysReturns(func.body)) continue
      const exprs = returnExprs(func.body)
      if (!exprs.length) continue
      const facts = analyzeBody(func.body)
      const localElems = facts[sliceKey]
      const paramElemMap = paramFactsOf(paramReps, func, field) || new Map()
      // Set-valued slices ride as canonical 'a,b,…' keys so the exact-agreement
      // lattice below works unchanged; size-1 sets are the singular fact (skip).
      const canon = (v) => v instanceof Set
        ? (v.size >= 2 ? [...v].sort((x, y) => x - y).join(',') : null)
        : v
      const resolveExpr = (expr) => {
        if (typeof expr === 'string') {
          if (localElems.has(expr)) {
            const v = canon(localElems.get(expr))
            if (v != null) return v
          }
          if (paramElemMap.has(expr)) return paramElemMap.get(expr)
          return null
        }
        if (Array.isArray(expr) && expr[0] === '()' && typeof expr[1] === 'string') {
          const f = ctx.funcs.map?.get(expr[1])
          if (f?.[field] != null) return f[field]
        }
        if (Array.isArray(expr) && expr[0] === '?:') {
          const a = resolveExpr(expr[2]), b = resolveExpr(expr[3])
          return a != null && a === b ? a : null
        }
        if (Array.isArray(expr) && (expr[0] === '&&' || expr[0] === '||')) {
          const a = resolveExpr(expr[1]), b = resolveExpr(expr[2])
          return a != null && a === b ? a : null
        }
        return null
      }
      const v0 = resolveExpr(exprs[0])
      if (v0 == null) continue
      if (!exprs.every(e => resolveExpr(e) === v0)) continue
      func[field] = v0
      changed = true
    }
  }
}

/**
 * Body-local boolean/bigint-result inference. `narrowValResults` is the general
 * (any VAL.*) pass, but it lives inside whole-program narrowing, which is skipped
 * for trivial leaf modules (no call sites). Boolean and bigint are the two kinds
 * whose internal carrier differs from the host-boundary carrier — bool rides a 0/1
 * number internally but crosses as the TRUE_NAN/FALSE_NAN atom; bigint rides an
 * i64-reinterpreted f64 internally but must cross as a real Number — so an exported
 * `(a) => a > 2` or `() => 100n` still needs its boundary thunk even on the skip path.
 * This pass only ever *sets* valResult to VAL.BOOL / VAL.BIGINT, so it is safe to run
 * unconditionally — pointer/array/number results are untouched.
 */
export function narrowBoolResults() {
  for (const func of ctx.funcs.list) {
    if (func.raw || func.valResult || !func.body || func.sig.results.length !== 1) continue
    const body = func.body
    const isBlock = isBlockBody(body)
    if (isBlock && hasBareReturn(body)) continue
    const exprs = returnExprs(body)
    if (!exprs.length) continue
    const bodyFacts = isBlock ? analyzeBody(body) : null
    const localValTypes = bodyFacts ? bodyFacts.valTypes : null
    // Locals-aware FIRST, like narrowValResults' own valTypeOfWithCalls (same
    // helper — kind.js valTypeOfWithLocals): a compound return tail (e.g.
    // `return m.has(k)`) has its receiver's kind only known through THIS body's
    // own analyzeBody facts, invisible to the global-only plain valTypeOf.
    // UNLIKE narrowValResults, still falls back to the plain (locals-blind)
    // valTypeOf when the local resolver can't decide: narrowValResults omits
    // that fallback on purpose (its own doc comment — the optimistic `+`
    // default is unsound to hand back as a whole-function result claim), but
    // narrowBoolResults' pre-existing behavior already relied on that same
    // optimistic default to catch e.g. `return x + 1n` on an untyped param as
    // BIGINT (`RepresentationPlan: direct call edges…` regression, caught
    // live) — losing it outright regressed a previously-working case instead
    // of only ADDING the missing method-call proof. valTypeOfWithLocals's own
    // local proofs are sound by construction, so preferring them and falling
    // back to the historical default is strictly additive, not a new risk.
    const vt = e => valTypeOfWithLocals(e, name => localValTypes?.get(name) || ctx.scope.globalValTypes?.get(name) || null) ?? valTypeOf(e)
    // Same ctx.func.flatObjects gap as narrowValResults above — a `return
    // obj.p` tail on a proven-BIGINT flat field needs it to resolve BIGINT
    // here (this is the leaf-module skip path's own valResult pass, so there
    // is no later chance to correct an unproven result). Same for a `return
    // arr[i]` tail on a proven-BIGINT array element — installArrElemReps'
    // array sibling of the same install (see its own doc comment above).
    const evaluate = () => {
      // Solve a direct-recursive result coinductively through the existing
      // valType authority. The provisional fact affects only self-call nodes;
      // every other arm must still prove BOOL normally. Restore before testing
      // BigInt or publishing the final answer.
      const priorResult = func.valResult
      let isBool
      try {
        func.valResult = VAL.BOOL
        isBool = exprs.every(e => vt(e) === VAL.BOOL)
      } finally {
        func.valResult = priorResult
      }
      return [isBool, !isBool && exprs.every(e => vt(e) === VAL.BIGINT)]
    }
    const [isBool, isBigint] = bodyFacts
      ? withFunctionFields({
        flatObjects: bodyFacts.flatObjects,
        localReps: installArrElemReps(bodyFacts.arrElemValTypes, ctx.func.localReps),
      }, evaluate)
      : evaluate()
    if (isBool) func.valResult = VAL.BOOL
    else if (isBigint) func.valResult = VAL.BIGINT
  }
}

