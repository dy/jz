/**
 * Function results: the value kind is the program summary's (`seedResultKinds`:
 * the join of the returns), the pointer ABI it licenses (`narrowPointerResults`)
 * and the numeric i32 result the range channels prove (`narrowI32Results`),
 * plus the closed element-schema union of an array result.
 *
 * @module compile/narrow/results
 */

import { ctx } from '../../ctx.js'
import { withCurrentFunction, withTypedElems } from '../flow-state.js'
import { isBlockBody, alwaysReturns, hasBareReturn, returnExprs, walkAst, isReassigned } from '../../ast.js'
import { analyzeBody, reanalyzeBody, invalidateBodies } from '../analyze.js'
import { exprType, typedStaticLen } from '../../type.js'
import { ctorFromElemAux } from '../../../layout.js'
import { valTypeOfWithLocals, hasAmbiguousBoolMerge } from '../../kind.js'
import { VAL, KIND_UNIVERSE, lookupValType } from '../../reps.js'
import { paramFactsOf } from '../../param-reps.js'
import { isExported } from '../func-exports.js'
import { K, tagOf, paramOf, isNullable, valOf, valsOf, hasTag, core, UNKNOWN } from '../../summary/index.js'

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
 * Safe for exports — boundary wrapper restores the f64 JS ABI. A block that
 * can fall through or execute `return;` is preserved as f64; multi-value / raw /
 * value-used functions are skipped by the narrowable filter.
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
  // A pointer result is not a number, though an unboxed pointer parameter or
  // call reads as i32 to exprType: a result the summary proves a pointer kind
  // is not narrowed (an unknown one, a v128 helper's, is exprType's to decide).
  const numericResult = (func) => {
    const vs = valsOf(ctx.summary.resultOf(func.name))
    return vs.length >= KIND_UNIVERSE.length || vs.every(v => v === VAL.NUMBER || v === VAL.BOOL)
  }
  let changed = true
  while (changed) {
    changed = false
    for (const func of funcs) {
      if (func.sig.results[0] === 'i32' || func.sig.results[0] === 'v128') continue
      if (!numericResult(func)) continue
      const body = func.body
      if (isBlockBody(body) && (!alwaysReturns(body) || hasBareReturn(body))) continue
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

/** The summary's result kinds onto every function: `valResult` (the join of the
 *  returns, one value kind), its presence (an ABSENT return), and an array
 *  result's element facts. A deliberate nullish result makes no value-kind
 *  claim; an absent container read keeps its present kind and records presence.
 *  Runs on the narrowing path and the skip path alike (a boolean crosses the
 *  host boundary as its atom and a BigInt through its tagged carrier). */
export function seedResultKinds() {
  for (const func of ctx.funcs.list) {
    // A multi-value result (a scalarized array return) is no one value.
    if (func.raw || !func.body || func.valResult || func.sig.results.length !== 1) continue
    const k = ctx.summary.resultOf(func.name), t = tagOf(k)
    if (t === K.NONE || t === K.ABSENT || t === K.NULLISH) continue
    const v = valOf(core(k))
    if (v == null) continue
    func.valResult = v
    // Presence beside the kind, as for a parameter (narrow/index.js seedParamKinds).
    // BigInt needs this especially: without it the raw i64 result would reinterpret
    // an out-of-range read's undefined atom as an integer payload.
    if (hasTag(k, K.NULLISH) || hasTag(k, K.ABSENT)) func.valResultMayBeUndefined = true
    if (v === VAL.ARRAY) {
      const e = ctx.summary.elemKindOf(k)
      if (!hasTag(e, K.NULLISH)) {
        if (tagOf(e) === K.OBJECT && paramOf(e) !== UNKNOWN) func.arrayElemSchema = paramOf(e)
        const ev = valOf(core(e))
        if (ev != null) func.arrayElemValType = ev
      }
    }
  }
}

const PTR_RESULT_KINDS_NOAUX = new Set([VAL.SET, VAL.MAP, VAL.BUFFER])

/**
 * Phase E3: pointer result narrowing.
 *
 * For narrowable funcs whose result is one pointer kind with a constant aux,
 * narrow sig.results[0] from f64 to i32 and tag sig.ptrKind/.ptrAux.
 * Eliminates the f64.reinterpret_i64+i64.or rebox at every return and the
 * matching unbox dance at every call site that uses the value as a pointer.
 *
 * Aux strategy:
 *   - SET/MAP/BUFFER: aux always 0 — no per-callsite preservation needed.
 *   - OBJECT: aux is the schema id the summary names (every return one shape).
 *   - TYPED: aux is the element type the summary names.
 *
 * Skipped: ARRAY forwards on realloc, STRING dual-encoded SSO/heap, CLOSURE
 * (aux carries funcIdx for call_indirect). Body must guarantee-return so the
 * fallthrough fallback can't produce a wrong-typed undef.
 */
export function narrowPointerResults(funcs, paramReps, calledInside) {
  for (const func of funcs) {
    if (func.sig.ptrKind != null || !func.valResult) continue
    if (func.sig.results[0] !== 'f64') continue
    // An export no site calls has only the host as a caller, whose wrapper would rebox the offset: no gain.
    if (isExported(func) && !calledInside.has(func.name)) continue
    const isBlock = isBlockBody(func.body)
    if (isBlock && (!alwaysReturns(func.body) || hasBareReturn(func.body))) continue
    const k = ctx.summary.resultOf(func.name)
    if (isNullable(k)) continue
    if (PTR_RESULT_KINDS_NOAUX.has(func.valResult)) {
      func.sig.results = ['i32']
      func.sig.ptrKind = func.valResult
      continue
    }
    if (func.valResult === VAL.OBJECT) {
      if (paramOf(k) === UNKNOWN) continue
      func.sig.results = ['i32']
      func.sig.ptrKind = VAL.OBJECT
      func.sig.ptrAux = paramOf(k)
    } else if (func.valResult === VAL.TYPED) {
      if (paramOf(k) === UNKNOWN) continue
      func.sig.results = ['i32']
      func.sig.ptrKind = VAL.TYPED
      func.sig.ptrAux = paramOf(k)
      // A factory returning one local of static length (`const out = new
      // Float64Array(n)` with `n` a call-site constant) publishes that length:
      // the caller's binding (`const sig = mkSignal(N)`) then proves its
      // own accesses exactly as a local constructor would.
      const exprs = returnExprs(func.body)
      const L = isBlock && exprs.length ? typedLenOfReturns(func, exprs, paramFactsOf(paramReps, func, 'intConst')) : null
      if (L != null) func.sig.typedLen = L
    }
  }
}

/** Static element count every return of `func` carries: each return is a
 *  bare local declared once as `new T(<expr>)` and never reassigned, where
 *  `<expr>` folds under the params' call-site constants (`intConsts`). */
function typedLenOfReturns(func, exprs, intConsts) {
  const subst = (n) => typeof n === 'string' ? (intConsts?.get(n) != null ? [, intConsts.get(n)] : n)
    : Array.isArray(n) && n[0] !== 'str' ? n.map((c, i) => i === 0 ? c : subst(c)) : n
  let L = null
  for (const e of exprs) {
    if (typeof e !== 'string' || isReassigned(func.body, e)) return null
    let init = null, decls = 0
    walkAst(func.body, { enter: n => {
      if (n[0] === '=>') return false
      if ((n[0] === 'const' || n[0] === 'let') && n.length === 2 && Array.isArray(n[1]) && n[1][0] === '=' && n[1][1] === e) { decls++; init = n[1][2] }
    } })
    if (decls !== 1 || !Array.isArray(init) || init[0] !== '()' || typeof init[1] !== 'string' || !init[1].startsWith('new.')) return null
    const len = typedStaticLen(['()', init[1], subst(init[2])])
    if (len == null || (L != null && L !== len)) return null
    L = len
  }
  return L
}

/** Propagate the closed element-schema union from return paths into `func.arrayElemSchemaSet`
 *  (the one array-element fact the summary does not carry: a set of shapes). */
export function narrowReturnArrayElemSets(paramReps, addressTaken) {
  const field = 'arrayElemSchemaSet', sliceKey = 'arrElemSchemaSets'
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

