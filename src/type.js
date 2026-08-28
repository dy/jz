/**
 * WASM local typing + typed-array metadata + integer proofs.
 *
 * - exprType: i32 vs f64 for locals/params
 * - typedElemCtor: direct typed-array construction (composite provenance lives
 *   in typed-provenance.js; the pure PTR.TYPED aux codec lives in layout.js)
 * - scanBoundedLoops / inBoundsCharCodeAt: charCodeAt i32 contract proof
 * - loop unroll helpers: smallConstForTripCount, cloneWithSubst, …
 * - intCertainMap / intExprChecker: integer-shaped binding analysis
 *
 * ── NUMERIC WIDENING INVARIANT (shared contract with emit.js) ──
 * "When does i32 arithmetic stay i32 vs widen to f64" is decided in TWO places
 * that must agree: emit.js DECIDES (emits `i32.mul`/`i32.add` or widens),
 * exprType here MIRRORS (predicts the same i32/f64 so locals are typed right).
 * They cannot share one function (emit reads IR values via isLit/maskBound,
 * type reads AST via staticValue/intExprRange) but they MUST share these rules
 * — edit one side only with the other open beside it:
 *
 * 1. SOUNDNESS DIRECTION (one-way, unforgiving): exprType's i32 verdict must
 *    be a SUBSET of emit's — answer i32 only where emit DEFINITELY produces
 *    i32. If type says i32 but emit yields f64, the value is trunc_sat-
 *    narrowed back → silent miscompile.
 * 2. `*` RULE: i32.mul is faithful only when the EXACT product provably fits
 *    signed i32 — a magnitude bound on BOTH operands, product ≤ 2^31−1
 *    (emit.js `mulFitsI32` via opBound; here via intExprRange). f64-exactness
 *    (≤2^53) is NOT sufficient: an f64-exact product can still wrap i32.mul.
 * 3. `+`/`-` TWO-TIER: the magnitude-blind "both operands i32 ⇒ i32" answer is
 *    sound for STORAGE-type decisions (every read of i32 storage re-applies
 *    ToInt32 — ir.js routes i32 targets through `toI32`). Only callers deciding
 *    whether a value escapes BARE (no further ToInt32 sink) pass `strict=true`,
 *    which adds `*`'s magnitude bound (emit.js `addFitsI32`: opBound(a)+
 *    opBound(b) ≤ 2^31−1 — triangle inequality covers `-`). Making `+`/`-`
 *    unconditionally strict costs the hottest accumulation shapes 8/10
 *    perf-ratchet rows — the tier split is load-bearing, not an oversight.
 * 4. BARE-ESCAPE STORAGE RULE: a var keeps i32 storage only if every later
 *    value-position read is index-positioned, ToInt32-rooted, a tracked edge's
 *    affine RHS, statically in-range, or comparison-governed —
 *    `collectBareEscapes` (analyze-scans.js) is the single authority both
 *    storage commitments consult.
 *
 * @module type
 */
import { isI32, isReassigned, cloneNode, MUTATE_OPS, ASSIGN_OPS as WRITE_OPS, walkAst, some, someDeep, REFS_THROUGH_ARROWS } from './ast.js'
import { ctx, getFactStore } from './ctx.js'
import { VAL, lookupValType } from './reps.js'
import { valTypeOf, valTypeOfWithLocals, hasAmbiguousBoolMerge, censusShapedNode, censusMaybeUndefinedKind, exprPresentValIn, exprMapGetShapedIn } from './kind.js'
import { propValType, CMP_OPS } from './kind-traits.js'
import { NO_VALUE, staticValue, intLiteralValue, intExprRange, constIntExpr } from './static.js'
import { typedElemAux } from '../layout.js'
import { typedElemCtor } from './typed-provenance.js'
import { typedStorageNameCtor } from './typed-context.js'
import {
  idxKey, isUnitIncrement, isUnitDecrement, redeclaresName, collectDecls, lengthRecv,
  inBoundsCharCodeAt, inBoundsArrIdx, litBoundArrIdx,
} from './type/canonical-bounds.js'
import { containsNestedClosure } from './type/loop-unroll.js'
import { intervalProvenIdx, intervalIdxRanges } from './type/interval-proof.js'
import { exprType } from './type/expr-type.js'
import { versionableTypedFor, typedIdxProven } from './type/loop-versioning.js'
export { typedElemCtor } from './typed-provenance.js'
export {
  idxKey, isUnitIncrement, isUnitDecrement, scanBoundedLoops, inBoundsCharCodeAt,
  scanBoundedArrIdx, inBoundsArrIdx, litBoundArrIdx,
} from './type/canonical-bounds.js'
export {
  MAX_SMALL_FOR_UNROLL, MAX_NESTED_FOR_UNROLL, containsNestedClosure, containsNestedLoop,
  nestedSmallLoopBudget, containsDeclOf, containsKnownTypedArrayIndex, smallConstForTripCount,
  isTerminator,
} from './type/loop-unroll.js'
export { intLevelMap, intCertainMap, intExprChecker, intLevelChecker } from './type/int-certain.js'
export { intervalProvenIdx, intervalIdxRanges } from './type/interval-proof.js'
export { exprType } from './type/expr-type.js'
export { cloneWithSubst } from './type/clone.js'
export {
  typedStaticLen, typedIdxProven, affineIdxOfIV, SLOT_OPS, bodyAffineEnv, versionableTypedFor,
  isCondExpr,
} from './type/loop-versioning.js'

/** Nest-level versioning scan: the intercepted loop PLUS every nested loop whose
 *  guard is evaluable at the TOP entry — one guard for the whole nest, so the
 *  outer-strip / per-pixel / iterated-reduce recognizers see a BARE nest in the
 *  fast arm (an inner-loop guard would blind them, and per-row guards are dearer
 *  than one per nest anyway). A nested level lifts only when
 *  - its iv entry is STATIC (init literal or the `let b = 0; while (b < n)`
 *    sibling-decl pattern — a runtime entry read at top-entry would be stale),
 *  - it carries no induction cursors (their entry values are per-inner-entry),
 *  - every name its guard reads is neither written NOR DECLARED anywhere in the
 *    top body (redeclaresName catches inner decls — a per-row offset slot must
 *    not be read before its row exists). Unliftable levels simply keep their own
 *    inner versioning during arm emission — graceful degradation, not a bail. */
/** The countable-iv name of a (possibly `&&`-chained) loop cond — the leftmost
 *  conjunct's lhs. Feeds the sibling-decl entryHint lookup for while-shapes. */
const condIvName = (cnd) => {
  let c = cnd
  while (Array.isArray(c) && c[0] === '&&' && Array.isArray(c[1])) c = c[1]
  return Array.isArray(c) && (c[0] === '<' || c[0] === '<=') && typeof c[1] === 'string' ? c[1] : null
}

export function versionableTypedNest(init, cond, step, body, locals) {
  if (containsNestedClosure(body)) return null
  const levels = []
  // RANGE-ONLY level: a loop the canonical-iv analysis rejects (`while (keys[h]
  // !== k)` — no `<` cond, no countable iv) can still guard its hull-bounded
  // accesses: hull conjuncts need no iv at all. The masked ring cursor over a
  // dynamic-length param table is exactly this shape.
  const rangeOnly = (c2, b2) => {
    const cands = [], seen = new Set()
    const stable2 = (nm) => !isReassigned(b2, nm) && !redeclaresName(b2, nm)
    const scan = (n) => {
      if (n[0] === '=>') return false
      if (n[0] === '[]' && n.length === 3 && typeof n[1] === 'string'
          && ctx.func.typedElem?.has(n[1]) && stable2(n[1])) {
        const key = idxKey(n[1], n[2])
        if (!seen.has(key) && !typedIdxProven(n[1], n[2])) {
          const rng = intervalIdxRanges(ctx).get(key)
          if (rng && (rng.hiName == null || stable2(rng.hiName))) {
            seen.add(key); cands.push({ recv: n[1], idx: n[2], range: rng })
          }
        }
      }
    }
    walkAst(c2, { enter: scan })   // `while (keys[h] !== k)` — the accesses live in the COND
    walkAst(b2, { enter: scan })
    return cands.length ? { rangeOnly: true, cands } : null
  }
  const walkLoop = (i2, c2, s2, b2, hint, isTop) => {
    const spec = versionableTypedFor(i2, c2, s2, b2, locals, hint) ?? rangeOnly(c2, b2)
    if (spec) { spec.top = isTop; spec.bodyNode = b2; levels.push(spec) }
    scanStmts(b2)
  }
  const scanStmts = (n) => {
    if (!Array.isArray(n) || n[0] === '=>') return
    if (n[0] === 'while' && n.length === 3 && Array.isArray(n[1])) { walkLoop(null, n[1], null, n[2], null, false); return }
    if (n[0] === 'for' && n.length === 5) { walkLoop(n[1], n[2], n[3], n[4], null, false); return }
    if (n[0] === ';' || n[0] === '{}') {
      let lastDecls = new Map()
      for (let k = 1; k < n.length; k++) {
        const st = n[k]
        if (Array.isArray(st) && (st[0] === 'let' || st[0] === 'const')) {
          for (let j = 1; j < st.length; j++) {
            const d = st[j]
            if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') {
              const v = intLiteralValue(d[2])
              if (v != null && v >= 0) lastDecls.set(d[1], v); else lastDecls.delete(d[1])
            } else if (typeof d === 'string') lastDecls.delete(d)
          }
          continue
        }
        if (Array.isArray(st) && st[0] === 'while' && st.length === 3
            && Array.isArray(st[1]) && condIvName(st[1]) != null) {
          walkLoop(null, st[1], null, st[2], lastDecls.get(condIvName(st[1])) ?? null, false)
        } else if (Array.isArray(st) && st[0] === 'for' && st.length === 5) {
          walkLoop(st[1], st[2], st[3], st[4], null, false)
        } else scanStmts(st)
        lastDecls = new Map()   // any other statement may disturb tracked entries
      }
      return
    }
    for (let k = 1; k < n.length; k++) scanStmts(n[k])
  }
  walkLoop(init, cond, step, body, null, true)
  const stableTop = (name) => typeof name !== 'string'
    || (!isReassigned(body, name) && !redeclaresName(body, name))
  const exprNames = (e, out) => someDeep(e, n => { if (typeof n === 'string') out.push(n); return false })
  const keepPre = levels.filter((L) => {
    // A numeric hull that already exceeds a receiver's STATIC length can never
    // satisfy the emitted version guard. Drop that candidate instead of
    // cloning an entire containing loop behind a compile-time-dead fast arm
    // (QOI's byte `b0` ∈ [0,255] against 64-entry colour tables used to clone
    // the full encode/decode kernel, then always execute the checked twin).
    L.cands = L.cands.filter(c => {
      if (!Array.isArray(c.range) || c.range.hiName != null) return true
      const len = ctx.func.typedLen?.get(c.recv) ?? ctx.scope?.globalTypedLen?.get(c.recv)
      return len == null || c.range[1] < len
    })
    if (!L.cands.length) return false
    if (!L.top) {
      if (!L.rangeOnly && L.startC == null) return false
      const n0 = L.cands.length
      // an induction whose ENTRY is a static init literal (`for (let j=0, k=0; …)`)
      // lifts like any extent — only runtime-entry cursors are per-inner-entry
      L.cands = L.cands.filter(c => c.ind == null || c.entryC != null)
      if (!L.cands.length) return false
      // runtime-entry inductions dropped: the level still needs ITS OWN intercept
      // for them — the top guard must not brake it
      if (L.cands.length !== n0) L.partial = true
    }
    // names the lifted guard READS at top entry (iv itself is NOT read — inner
    // entries are static by the filter above, and only the top may read its iv)
    const names = []
    exprNames(L.bound, names)
    if (typeof L.bound === 'string') names.push(L.bound)
    for (const c of L.cands) {
      names.push(c.recv)
      if (c.range != null) { if (c.range.hiName != null) names.push(c.range.hiName); continue }
      if (c.ind != null) { names.push(c.ind); if (typeof c.slope === 'string') names.push(c.slope) }
      else if (c.cursor != null) names.push(c.cursor)
      else for (const t of c.slots) { if (typeof t.e === 'string') names.push(t.e); else exprNames(t.e, names) }
    }
    // the top level's own iv/bound legitimately live in the top body — only names
    // read by LIFTED (inner) guards need top-stability; the top spec re-checks
    // nothing new here beyond its own scan
    return L.top || names.every(stableTop)
  })
  const keep = keepPre
  if (!keep.length) return null
  // FLAT-CURSOR inductions: `j++` exactly once in the whole nest (the universal
  // image-kernel pixel cursor `px[j] = …; j++`). Its value spans
  // [j0, j0 + slope·(Π level-trips − 1 or − 0)] — every containing loop must be a
  // LIFTED level (trip = maxIv − entry + 1 known at the guard); a pre-increment
  // read tops out one slope earlier than a post-increment one, so each access
  // carries its position. Entry j0 reads at the nest top (the cursor lives in an
  // enclosing scope by construction — a body-declared cursor is rejected by
  // redeclaresName).
  const cursorWrites = new Map()   // name → { node, slope } | null (disqualified)
  walkAst(body, { enter: n => {
    if (MUTATE_OPS.has(n[0]) && typeof n[1] === 'string') {
      const name = n[1]
      const L = n[0] === '++' ? 1
        : n[0] === '--' ? null
        : n[0] === '+=' ? intLiteralValue(n[2])
        : n[0] === '=' ? (() => {
            let rhs = n[2]
            if (Array.isArray(rhs) && rhs[0] === '|' && intLiteralValue(rhs[2]) === 0) rhs = rhs[1]
            if (Array.isArray(rhs) && rhs[0] === '+' && rhs.length === 3) {
              if (rhs[1] === name) return intLiteralValue(rhs[2])
              if (rhs[2] === name) return intLiteralValue(rhs[1])
            }
            return null
          })()
        : null
      cursorWrites.set(name, cursorWrites.has(name) || L == null || L < 1 || !Number.isInteger(L)
        ? null : { node: n, slope: L })
    }
  } })
  const contains = (hay, needle) => some(hay, n => n === needle, REFS_THROUGH_ARROWS)
  const allLoopBodies = []
  walkAst(body, { enter: n => {
    if (n[0] === '=>') return false
    if (n[0] === 'while' && n.length === 3) allLoopBodies.push(n[2])
    else if (n[0] === 'for' && n.length === 5) allLoopBodies.push(n[4])
  } })
  const keptBodies = new Set(keep.map(L => L.bodyNode))
  const cursors = []
  for (const [name, w] of cursorWrites) {
    if (w == null) continue
    if (redeclaresName(body, name)) continue
    // every loop containing the write must be a lifted level (trips known);
    // the top level's own body contains it by construction
    const containing = allLoopBodies.filter(b => contains(b, w.node))
    if (!containing.every(b => keptBodies.has(b) || b === body)) continue
    if (!keptBodies.has(body) && containing.length === 0) continue
    const chain = keep.filter(L => contains(L.bodyNode, w.node) || L.bodyNode === body)
    if (!chain.length) continue
    // accesses arr[name]: position vs the write decides the endpoint
    const cands = []
    let seenWrite = false
    const scanC = (n) => {
      if (n === w.node) { seenWrite = true }
      if (n[0] === '[]' && n.length === 3 && typeof n[1] === 'string' && n[2] === name
          && ctx.func.typedElem?.has(n[1])
          && !isReassigned(body, n[1]) && !redeclaresName(body, n[1]))
        cands.push({ recv: n[1], idx: n[2], post: seenWrite })
    }
    walkAst(body, { enter: scanC })
    if (cands.length) cursors.push({ name, slope: w.slope, chain, cands,
      kind: exprType(name, locals) === 'i32' ? 'i32' : 'f64' })
  }
  keep.cursors = cursors
  return keep
}
