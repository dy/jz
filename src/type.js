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

/** Static element count for `new T(<int literal>)` / `new T([literals…])`, or null
 *  for views (buffer, off, len), buffer/array copies, ternaries and computed sizes.
 *  Typed arrays are FIXED-LENGTH, so a binding's length is exactly as stable as its
 *  ctor — the tracker applies the same multi-def invalidation to both. */
export function typedStaticLen(rhs) {
  if (!Array.isArray(rhs) || rhs[0] !== '()' || typeof rhs[1] !== 'string' || !rhs[1].startsWith('new.')) return null
  if (!rhs[1].endsWith('Array') || rhs[1] === 'new.ArrayBuffer') return null
  const args = rhs[2]
  if (args === undefined) return 0
  if (Array.isArray(args) && args[0] === ',') return null        // view form
  const n = constIntExpr(args)
  if (n != null) return n >= 0 ? n : null
  // `new T([a,b,c])` — BOTH literal shapes: parse-time `['[]', [',', …]]` (the
  // module-scope infer site) and post-prepare `['[', …elems]` (the analyze tracker).
  if (Array.isArray(args) && args[0] === '[]' && args.length === 2) {
    const inner = args[1]
    return inner === undefined ? 0
      : Array.isArray(inner) && inner[0] === ',' ? inner.length - 1 : 1
  }
  if (Array.isArray(args) && args[0] === '['
      && !args.slice(1).some(e => Array.isArray(e) && e[0] === '...')) return args.length - 1
  return null
}

// constIntExpr relocated to static.js (audit: two diverging implementations —
// this one skipped unary minus and bypassed static.js's repOf-through-
// intLiteralValue chain). Consumers here (typedStaticLen above, typedIdxProven
// below) import the shared static.js version — see its doc comment there.

/** `recv[idx]` provably within [0, recv.length) for a typed receiver — the gate the
 *  checked `.typed:[]` forms and the identity folds share. Proof classes:
 *  1. the canonical-loop structural pair (inBoundsArrIdx);
 *  2. a literal index against the binding's STATIC length (ctx.func.typedLen /
 *     ctx.scope.globalTypedLen — `new T(<n>)`, tracker-invalidated on redef);
 *  3. the masked form `x & m` / `m & x` (ToInt32 & clears the sign for m ≥ 0, so the
 *     result is in [0, m]) with m < that static length;
 *  4. a versioned-loop assumption (ctx.types.assumedBounds) — the emitter is inside
 *     the guarded arm of a loop whose runtime extent check covers exactly this
 *     (recv, idx) pair (see versionableTypedFor / the 'for' emitter);
 *  5. the static interval walk (intervalProvenIdx) — const-bound nests whose index
 *     chains (incl. the clamp idiom) provably fit a static receiver length. */
export function typedIdxProven(recv, idx) {
  if (typeof recv !== 'string') return false
  // a versioned assumption is scoped to its OWNING loop: honored only while that
  // loop's frame is on the emission stack (a textual twin of the access OUTSIDE
  // the loop sees the cursor past its bound and must stay checked)
  const owner = ctx.types.assumedBounds?.get(idxKey(recv, idx))
  if (owner != null && ctx.func.stack?.some(f => f.bodyNode === owner)) return true
  // 4b. per-RECEIVER guarded const hull — the value-level twin of the key channel.
  //     The versioned guard proved every CONSTANT extent ≤ hull.max < recv.length,
  //     so any read whose index is a compile-time constant within the hull is
  //     in-bounds regardless of how many clone/rename layers (plan unroll, per-arm
  //     emit unroll, inline suffixes) rewrote the index NODE since the scan — the
  //     AST-JSON assumption keys break under those; the receiver name + value do
  //     not. Same owner-frame scoping as the key channel.
  const hull = ctx.types.assumedConstHull?.get(recv)
  if (hull != null && ctx.func.stack?.some(f => f.bodyNode === hull.owner)) {
    const v = constIntExpr(idx)
    if (v != null && v >= 0 && v <= hull.max) return true
  }
  if (intervalProvenIdx(ctx).has(idxKey(recv, idx))) return true
  if (typeof idx === 'string' && inBoundsArrIdx(ctx).has(recv + '\x00' + idx)) return true
  const len = ctx.func.typedLen?.get(recv) ?? ctx.scope?.globalTypedLen?.get(recv)
    ?? ctx.func.localReps?.get(recv)?.arrayLen
  if (len == null) return false
  const k = intLiteralValue(idx)
  if (k != null) return k >= 0 && k < len
  if (Array.isArray(idx) && idx[0] === '&' && idx.length === 3) {
    const m = intLiteralValue(idx[1]) ?? intLiteralValue(idx[2])
    if (m != null) return m >= 0 && m < len
  }
  // 6. refined-range proof: an i32-typed index whose closed hull (branch-local
  //    compare refinements ∩ ranged decl reps ∩ const chains) fits [0, len).
  //    The i32 gate makes the int-tightened refinement bounds sound (a
  //    fractional value cannot type i32).
  if (exprType(idx, ctx.func.locals) === 'i32') {
    const r = intExprRange(idx)
    if (r && r[0] >= 0 && r[1] < len) return true
  }
  if (typeof idx === 'string') {
    const B = litBoundArrIdx(ctx).get(recv + '\x00' + idx)
    if (B != null) return B <= len
  }
  return false
}

/** Decompose `idx` as `a*iv + bName + bConst`: literal iv-coefficient a ≥ 0, at most
 *  one symbolic body-invariant name (coefficient 1), an int constant. `env` maps
 *  single-def body-let names to their own affine forms (`const j = 3*i` → uses of
 *  `j`, `j+1` resolve through it). Additive combine over `+`/`-`/literal-`*`; two
 *  symbolic names, a scaled name, or a negative final iv-coefficient reject. The
 *  kernel shapes: `i`, `3*i+1` (AoS), `j+half` via env (butterfly), `irow+kx`
 *  (conv), plain invariant `base` (a = 0). */
export function affineIdxOfIV(idx, iv, body, env) {
  const slotEq = (p, q) => p === q || (typeof p !== 'string' && typeof q !== 'string'
    && JSON.stringify(p) === JSON.stringify(q))
  const MAX_SLOTS = 2   // butterfly's `b = i + j + half` carries two symbolic terms
  const addSlots = (A, B, s) => {
    const out = A.map(t => ({ k: t.k, e: t.e }))
    for (const t of B) {
      const hit = out.find(o => slotEq(o.e, t.e))
      if (hit) hit.k += s * t.k
      else out.push({ k: s * t.k, e: t.e })
    }
    return out.filter(t => t.k !== 0)
  }
  const aff = (e) => {
    if (e === iv) return { a: 1, slots: [], bConst: 0 }
    const n = intLiteralValue(e)
    if (n != null) return { a: 0, slots: [], bConst: n }
    if (typeof e === 'string') {
      // a name the env KNOWS (declared in this body) must resolve through it — a
      // null entry is a body-varying non-affine value the guard cannot pre-read
      if (env?.has(e)) return env.get(e)
      return isReassigned(body, e) ? null : { a: 0, slots: [{ k: 1, e }], bConst: 0 }
    }
    if (!Array.isArray(e)) return null
    const [op, x, y] = e
    // TOROIDAL WRAP of this loop's OWN iv — `iv === 0 ? B-1 : iv-1` (backward) or
    // `iv === B-1 ? 0 : iv+1` (forward): a bounded ATOM ∈ [0, B-1]. Asymmetric by
    // nature — it contributes B-1 to the HI extent and 0 to the LO — carried as a
    // wrap-flagged slot the emitter accounts one-sidedly.
    if (op === '?:' && e.length === 4 && Array.isArray(x) && x.length === 3) {
      const [cop, cl, cr] = x
      const isMinus1 = (n, B) => Array.isArray(n) && n[0] === '-' && n.length === 3
        && slotEq(n[1], B) && intLiteralValue(n[2]) === 1
      let B = null
      if (cop === '===' && cl === iv && intLiteralValue(cr) === 0
          && Array.isArray(e[3]) && e[3][0] === '-' && e[3][1] === iv && intLiteralValue(e[3][2]) === 1
          && Array.isArray(e[2]) && e[2][0] === '-' && intLiteralValue(e[2][2]) === 1)
        B = e[2][1]   // iv===0 ? B-1 : iv-1
      else if (cop === '===' && cl === iv && isMinus1(cr, Array.isArray(cr) ? cr[1] : cr)
          && intLiteralValue(e[2]) === 0
          && Array.isArray(e[3]) && e[3][0] === '+' && e[3][1] === iv && intLiteralValue(e[3][2]) === 1)
        B = cr[1]     // iv===B-1 ? 0 : iv+1
      else if (cop === '>' && cl === iv && intLiteralValue(cr) === 0
          && Array.isArray(e[2]) && e[2][0] === '-' && e[2][1] === iv && intLiteralValue(e[2][2]) === 1
          && Array.isArray(e[3]) && e[3][0] === '-' && intLiteralValue(e[3][2]) === 1)
        B = e[3][1]   // iv>0 ? iv-1 : B-1
      else if (cop === '<' && cl === iv && isMinus1(cr, Array.isArray(cr) ? cr[1] : cr)
          && Array.isArray(e[2]) && e[2][0] === '+' && e[2][1] === iv && intLiteralValue(e[2][2]) === 1
          && intLiteralValue(e[3]) === 0)
        B = cr[1]     // iv<B-1 ? iv+1 : 0
      if (B != null && invariantIdxExpr(B, iv, body, env))
        return { a: 0, slots: [{ k: 1, e: B, wrap: true }], bConst: 0 }
    }
    if (e.length === 3 && op === '*') {
      const L = intLiteralValue(x) ?? intLiteralValue(y)
      if (L != null) {
        const t = aff(intLiteralValue(x) != null ? y : x)
        if (t) return { a: t.a * L, slots: t.slots.map(u => ({ ...u, k: u.k * L })), bConst: t.bConst * L }
      }
      // fall through: a non-literal product (`y*w`) may still be an invariant slot
    }
    if (e.length === 3 && (op === '+' || op === '-')) {
      const l = aff(x), r = aff(y)
      if (l && r) {
        const s = op === '+' ? 1 : -1
        const slots = addSlots(l.slots, r.slots, s)
        if (slots.length <= MAX_SLOTS)
          return { a: l.a + s * r.a, slots, bConst: l.bConst + s * r.bConst }
      }
      // fall through to the whole-expr slot
    }
    // WHOLE-EXPR SLOT: an iv-free pure arithmetic expression over stable outer names
    // (`y*w`, `(oy+ky)*IW`) — the guard evaluates it once at loop entry; runtime
    // `integral ∧ |v| ≤ 2^31` conjuncts (the 'f64' slot kind) make the int model exact.
    return invariantIdxExpr(e, iv, body, env) ? { a: 0, slots: [{ k: 1, e }], bConst: 0 } : null
  }
  const r = aff(idx)
  // Negative iv-coefficients are admitted (the mirror index `N−k` of symmetric
  // fills): the guard emitter picks extremes by the SIGN of a — a·iv is maximal
  // at maxIv for a ≥ 0 but at ENTRY for a < 0, and minimal at the other end.
  return r && Number.isInteger(r.a) && Number.isInteger(r.bConst)
    && r.slots.every(t => Number.isInteger(t.k)) ? r : null
}

/** `e` is a pure arithmetic expression whose value cannot change across the loop:
 *  literals and stable outer names under numeric operators — no calls, no indexing,
 *  no property reads, no assignments, no iv, no body-declared names (they don't
 *  exist at guard time). The slot whitelist matches what the guard can safely
 *  re-evaluate before the loop. */
export const SLOT_OPS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '>>>'])
function invariantIdxExpr(e, iv, body, env) {
  if (intLiteralValue(e) != null) return true
  if (typeof e === 'string')
    return e !== iv && !env?.has(e) && !isReassigned(body, e) && !redeclaresName(body, e)
  if (!Array.isArray(e) || !SLOT_OPS.has(e[0]) || e.length > 3) return false
  for (let k = 1; k < e.length; k++) if (!invariantIdxExpr(e[k], iv, body, env)) return false
  return true
}

/** Single-def body-let affine environment for `affineIdxOfIV`: names declared
 *  EXACTLY once in `body`, never written, whose rhs is itself iv-affine (through
 *  earlier env entries — decls resolve in walk order: `const j = 3*i; const k = j+1`).
 *  A second decl of the same name (block shadowing) evicts it permanently. */
export function bodyAffineEnv(body, iv) {
  const env = new Map()   // name → affine, or null = body-declared but unresolvable
  walkAst(body, { enter: n => {
    if (n[0] === '=>') return false
    if (n[0] === 'let' || n[0] === 'const') {
      for (let k = 1; k < n.length; k++) {
        const d = n[k]
        const name = typeof d === 'string' ? d : Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' ? d[1] : null
        if (name == null) continue
        if (env.has(name)) { env.set(name, null); continue }   // shadowing second decl — evict
        env.set(name, typeof d === 'string' || isReassigned(body, name) ? null
          : affineIdxOfIV(d[2], iv, body, env))
      }
    }
  } })
  return env
}

/** `idx` as a MONOTONE CURSOR reference: a bare non-iv local name `c`, or `c + K0`
 *  / `K0 + c` with K0 an int literal — the shapes a data-dependent stream cursor
 *  (`stream[r]`, `stream[r+1]`) is read at. A postfix `c++` used in VALUE position
 *  lowers (prepare.js) to `(++c) - 1`: the read sees the OLD value, same as a bare
 *  `c` — unwrapped here so `stream[r++]` matches like `stream[r]` (the ++ itself is
 *  counted separately by maxCursorAdvance, wherever it appears in the body). */
function monotoneCursorOf(idx, iv) {
  const unwrapPost = (e) => Array.isArray(e) && e[0] === '-' && e.length === 3 && intLiteralValue(e[2]) === 1
    && Array.isArray(e[1]) && e[1][0] === '++' && typeof e[1][1] === 'string' ? e[1][1] : e
  const base = unwrapPost(idx)
  if (typeof base === 'string') return base !== iv ? { c: base, K0: 0 } : null
  if (Array.isArray(base) && base[0] === '+' && base.length === 3) {
    const x = unwrapPost(base[1]), y = unwrapPost(base[2])
    if (typeof x === 'string' && x !== iv) { const k = intLiteralValue(y); if (k != null) return { c: x, K0: k } }
    if (typeof y === 'string' && y !== iv) { const k = intLiteralValue(x); if (k != null) return { c: y, K0: k } }
  }
  return null
}

/** Per-iteration MAX advance of cursor `c` anywhere in `body`: `c++` / `c+=LIT`
 *  (LIT a positive int literal) contribute their amount wherever they occur
 *  (top-level statement or nested inside an expression, e.g. `stream[r++]`);
 *  sequential statements SUM; an `if` contributes its cond's advance plus
 *  max(then, else); a nested loop with no `c`-write contributes 0. Any other
 *  write to `c` (`=`, `-=`, `--`, …) — or a `c`-write inside a NESTED loop, whose
 *  per-inner-iteration advance this per-outer-iteration walk cannot hull — is
 *  non-monotone or unhullable and BAILS the whole candidate (null propagates up
 *  through every sum/max on the way out). */
function maxCursorAdvance(n, c) {
  if (!Array.isArray(n)) return 0
  const op = n[0]
  if (op === '++' && n[1] === c) return 1
  if (op === '--' && n[1] === c) return null
  if (op === '+=' && n[1] === c) { const k = intLiteralValue(n[2]); return k != null && k > 0 ? k : null }
  if (WRITE_OPS.has(op) && n[1] === c) return null
  if (op === 'if') {
    const [, cnd, thenB, elseB] = n
    const cA = maxCursorAdvance(cnd, c)
    if (cA == null) return null
    const tA = maxCursorAdvance(thenB, c)
    const eA = elseB !== undefined ? maxCursorAdvance(elseB, c) : 0
    return tA == null || eA == null ? null : cA + Math.max(tA, eA)
  }
  if (op === 'for' || op === 'while' || op === 'do') return isReassigned(n, c) ? null : 0
  if (op === '=>') return 0   // unreachable: containsNestedClosure already bailed the caller
  let sum = 0
  for (let k = 1; k < n.length; k++) {
    const a = maxCursorAdvance(n[k], c)
    if (a == null) return null
    sum += a
  }
  return sum
}

/** Loop-versioning scan for the 'for' emitter: a countable loop
 *  `for (let iv = C≥0; iv < BOUND; iv++)` whose body indexes TYPED receivers with
 *  iv-affine indices that no static class proves. Returns null or
 *  `{ iv, startC, bound, cands }` — each cand `{ recv, idx, a, bName, bConst }`.
 *  The caller emits `if (∀ extents in bounds) fast-arm else checked-arm`, assuming
 *  exactly `cands`' keys inside the fast arm, so every judgment here is
 *  load-bearing for memory safety:
 *  - BOUND re-evaluates in the guard → must be pure AND i32-machine-typed (an f64
 *    bound like `i < 5.5` admits iv = trunc-extent + 1 — the guard would under-
 *    estimate); literal int, an unwritten i32 name, or an unwritten typed
 *    receiver's `.length`;
 *  - bName terms must be i32-typed for the same reason;
 *  - closures in the body would be cloned per arm (two instances) — bail;
 *  - a candidate whose static low extent `a*C + bConst` is provably negative is
 *    DROPPED (its first iterations are genuinely OOB — the checked form is the
 *    semantics, a guard would just always fail). */
export function versionableTypedFor(init, cond, step, body, locals, entryHint = null) {
  // `&&`-cond whiles (`while (len < max && src[j+len] === src[ip+len]) len++`
  // — the LZ match scan): the countable bound must be the LEFTMOST conjunct.
  // Every later conjunct short-circuits AFTER it, so its accesses run only at
  // iv < bound (exactly the pre-increment extent), and a false conjunct only
  // exits the loop EARLY — the iv range never grows. The rest conjuncts ride
  // into both arms verbatim; their typed accesses are candidates (scanned
  // after the body so a same-key BODY access — possibly post-increment, wider
  // — registers its extent first).
  let condRest = null
  let c = cond
  while (Array.isArray(c) && c[0] === '&&' && Array.isArray(c[1])) {
    condRest = condRest == null ? c[2] : ['&&', c[2], condRest]   // scan-only bag
    c = c[1]
  }
  if (!Array.isArray(c) || (c[0] !== '<' && c[0] !== '<=') || typeof c[1] !== 'string') return null
  if (containsNestedClosure(body)) return null
  if (condRest != null && containsNestedClosure(condRest)) return null
  const iv = c[1], incl = c[0] === '<='
  if (redeclaresName(body, iv)) return null
  // iv start: a static init decl (`for (let i = 0; …)`) folds the lo conjunct;
  // otherwise (while-shapes: `let i = 0; while (i < n) …`) the guard reads the
  // ENTRY value of iv at runtime — the extent math is entry-relative either way.
  const decls = new Map()
  collectDecls(init, decls)
  // entryHint: a sibling `let b = 0` right before a while — the nest scan's decl
  // tracking supplies the static entry the empty init slot can't
  const startC = decls.has(iv) ? intLiteralValue(decls.get(iv)) : entryHint
  if (startC != null && startC < 0) return null   // statically-negative start: guard is dead weight
  // iv advance: a unit-increment step slot (for-loops), or — when the step slot is
  // empty — a SINGLE body write of shape `i = (i+LIT)|0` / `i = i+LIT` / `i += LIT` /
  // `i++` with int LIT ≥ 1 (while-loops). A body-advanced iv is visible PAST the
  // bound inside its final iteration (cond passes at B-1, the increment runs mid-
  // body), so the max-iv widens by LIT (`bump`). Any other write shape rejects.
  // a name the guard re-reads must denote the same binding for the whole loop
  const stable = (name) => !isReassigned(body, name) && !redeclaresName(body, name)
  let bump = 0, inds = null, stepBy = null
  if (isUnitIncrement(step, iv)) {
    if (isReassigned(body, iv)) return null
  } else if (Array.isArray(step) && (step[0] === '+=' && step[1] === iv
      || (step[0] === '=' && step[1] === iv && Array.isArray(step[2]) && step[2][0] === '+'
          && (step[2][1] === iv || step[2][2] === iv)))) {
    // MONOTONE non-unit advance (`i += len` — the fft block stride): extents only
    // need iv ⊆ [start, maxIv], which any positive stride preserves. A literal
    // stride proves positivity statically; a stable-name stride adds a runtime
    // `stride ≥ 1` conjunct (zero/negative falls to the checked arm).
    const x = step[0] === '+=' ? step[2] : step[2][1] === iv ? step[2][2] : step[2][1]
    const lit = intLiteralValue(x)
    if (lit != null ? lit < 1 : !(typeof x === 'string' && x !== iv
        && !isReassigned(body, x) && !redeclaresName(body, x))) return null
    if (isReassigned(body, iv)) return null
    stepBy = lit != null ? { lit } : { name: x, kind: exprType(x, locals) === 'i32' ? 'i32' : 'f64' }
  } else if (Array.isArray(step) && step[0] === ',') {
    // comma step (`j++, k += step`): exactly one unit-inc of iv; every other part
    // `cursor += slope` (int literal or invariant name, cursor unwritten in body)
    // declares an INDUCTION — cursor value at iteration t is entry + slope*t, so a
    // plain `arr[cursor]` access guards by its two endpoints (either slope sign).
    let unit = 0
    inds = new Map()
    for (const p of step.slice(1)) {
      if (isUnitIncrement(p, iv)) { unit++; continue }
      if (Array.isArray(p) && p[0] === '+=' && typeof p[1] === 'string' && p[1] !== iv
          && stable(p[1])
          && (intLiteralValue(p[2]) != null || (typeof p[2] === 'string' && p[2] !== iv && stable(p[2])))) {
        inds.set(p[1], p[2]); continue
      }
      inds = null; break
    }
    if (!inds || unit !== 1 || !inds.size || isReassigned(body, iv)) return null
  } else if (step == null && isReassigned(body, iv)) {
    const writes = []
    walkAst(body, { enter: n => {
      if (((n[0] === '=' || n[0] === '+=') && n[1] === iv) || ((n[0] === '++' || n[0] === '--') && n[1] === iv))
        writes.push(n)
    } })
    if (writes.length !== 1) return null
    const w = writes[0]
    const incOf = (n) => {
      if (n[0] === '++') return 1
      if (n[0] === '+=') return intLiteralValue(n[2])
      if (n[0] !== '=') return null
      let rhs = n[2]
      if (Array.isArray(rhs) && rhs[0] === '|' && intLiteralValue(rhs[2]) === 0) rhs = rhs[1]   // (i+LIT)|0
      if (Array.isArray(rhs) && rhs[0] === '+' && rhs.length === 3) {
        if (rhs[1] === iv) return intLiteralValue(rhs[2])
        if (rhs[2] === iv) return intLiteralValue(rhs[1])
      }
      return null
    }
    const L = incOf(w)
    if (L == null || L < 1 || !Number.isInteger(L)) return null
    bump = L
  } else return null
  const bound = c[2]
  // bKind drives the guard's conversion to a max-iv i64:
  //   'i32' — literal, i32-machine name, or a typed receiver's .length: exact extend;
  //   'f64' — any other stable name (an untyped param, a NaN-boxed unknown): the
  //     emitter adds a runtime `|B| ≤ 2^31` conjunct — box bit patterns are NaN, so
  //     abs-compare fails and the checked arm takes over; a genuine number converts
  //     exactly via ceil/floor + trunc_sat (never traps, saturation is conjunct-dead).
  const bKind = intLiteralValue(bound) != null ? 'i32'
    : (() => { const r = lengthRecv(bound); return r != null && ctx.func.typedElem?.has(r) && stable(r) })() ? 'i32'
    : typeof bound === 'string' && stable(bound) ? (exprType(bound, locals) === 'i32' ? 'i32' : 'f64')
    // an invariant pure EXPRESSION bound (`x < w - 1` — the stencil interior) re-
    // evaluates safely in the guard; machine-f64 rides the runtime-conjunct path
    : invariantIdxExpr(bound, iv, body, null) ? (exprType(bound, locals) === 'i32' ? 'i32' : 'f64')
    : null
  if (bKind == null) return null
  const env = bodyAffineEnv(body, iv)
  // induction cursors vary per iteration — they must not leak into slot terms
  // (the affine env blocks them); their PLAIN `arr[cursor]` reads are their own
  // candidate class below
  if (inds) for (const nm of inds.keys()) env.set(nm, null)
  // MONOTONE CURSOR eligibility (v1): the guard's trips = maxIv − start + 1 is
  // exact only when the iv advances by exactly 1 per iteration — a classic
  // `for (;iv<bound;iv++)` step, or a body-advanced iv proven bump === 1 (a
  // multi-write iv like the flag loop's `p` never reaches here — the writes-
  // count check above already returned null for that whole loop).
  const cursorIvOk = isUnitIncrement(step, iv) || bump === 1
  const cursorKCache = new Map()
  const cursorAdvanceOf = (name) => {
    if (cursorKCache.has(name)) return cursorKCache.get(name)
    const K = maxCursorAdvance(body, name)
    cursorKCache.set(name, K)
    return K
  }
  const cands = []
  const seen = new Set()
  // A body-advanced iv (bump > 0) exceeds bound−1 only AFTER its increment
  // runs — accesses in top-level statements strictly BEFORE the write see
  // iv ≤ bound−1 and need no widening. The canonical tail-increment while
  // (`…reads…; k++`) then guards exactly; only genuinely post-increment
  // accesses widen. Nested/mid-expression writes keep everything `post`.
  let ivWriteAt = -1
  const seqBody = Array.isArray(body) && (body[0] === '{}' || body[0] === ';')
  if (bump > 0 && seqBody) {
    for (let s = 1; s < body.length; s++) {
      const st = body[s]
      if (Array.isArray(st) && ((st[0] === '=' || st[0] === '+=') && st[1] === iv || (st[0] === '++' || st[0] === '--') && st[1] === iv)) { ivWriteAt = s; break }
    }
  }
  let scanTop = -1   // current top-level statement index during scan
  // cond-rest accesses are exactly pre-increment: short-circuit order proves
  // they evaluate only when `iv < bound` already held this iteration
  let forcePre = false
  const isPost = () => !forcePre && bump > 0 && (ivWriteAt === -1 || scanTop === -1 || scanTop >= ivWriteAt)
  const scan = (n) => {
    if (n[0] === '[]' && n.length === 3 && typeof n[1] === 'string' && n[1] !== iv
        && ctx.func.typedElem?.has(n[1]) && stable(n[1])) {
      const key = idxKey(n[1], n[2])
      if (!seen.has(key) && !typedIdxProven(n[1], n[2])) {
        if (typeof n[2] === 'string' && inds?.has(n[2])) {
          seen.add(key)
          cands.push({ recv: n[1], idx: n[2], ind: n[2], slope: inds.get(n[2]),
            entryC: decls.has(n[2]) ? intLiteralValue(decls.get(n[2])) : null })
        } else {
          const aff = affineIdxOfIV(n[2], iv, body, env)
          // symbolic slots: i32-machine exprs are exact; any other rides the f64
          // path with runtime `integral ∧ |v| ≤ 2^31` conjuncts (kind 'f64')
          if (aff
              // statically-negative low extent: the checked form IS the semantics, a
              // guard would always fail (runtime-entry loops keep the runtime lo check)
              && !(aff.slots.length === 0 && startC != null && aff.a * startC + aff.bConst < 0)) {
            seen.add(key)
            const slots = aff.slots.map(t => ({ ...t, kind: exprType(t.e, locals) === 'i32' ? 'i32' : 'f64' }))
            cands.push({ recv: n[1], idx: n[2], a: aff.a, slots, bConst: aff.bConst, post: isPost() })
          } else {
            // MONOTONE CURSOR (r not the iv, body-advanced only by c++/c+=LIT):
            // `arr[r]` / `arr[r+K0]` / `arr[r++]` (postfix, unwrapped) — a data-
            // dependent cursor the affine model can't hull (its per-iteration
            // advance depends on runtime branches, not the iv). K bounds that
            // advance from a static walk of the body; the emitter guards
            // `entryR + K·trips + K0 < len` once, covering every access.
            const mc = cursorIvOk ? monotoneCursorOf(n[2], iv) : null
            const K = mc ? cursorAdvanceOf(mc.c) : null
            if (mc && K != null) {
              seen.add(key)
              cands.push({ recv: n[1], idx: n[2], cursor: mc.c, K, cConst: mc.K0 })
            } else {
              // LAST resort — beyond the affine model (masked ring cursors, wrap
              // idioms): an interval HULL the static walk bounded but couldn't
              // discharge (dynamic receiver length) closes with one runtime
              // `hull.hi < len` conjunct. Strictly a fallback: it must never steal
              // an affine candidate (whose per-iv extents are tighter).
              const rng = intervalIdxRanges(ctx).get(key)
              if (rng && (rng.hiName == null || stable(rng.hiName))) {
                seen.add(key); cands.push({ recv: n[1], idx: n[2], range: rng })
              }
            }
          }
        }
      }
    }
  }
  if (seqBody) {
    for (let s = 1; s < body.length; s++) { scanTop = s; walkAst(body[s], { enter: scan }) }
    scanTop = -1
  } else walkAst(body, { enter: scan })
  // `&&`-cond rest conjuncts — scanned AFTER the body so a shared-key body
  // access (potentially post-increment, wider extent) wins the seen-set
  if (condRest != null) { forcePre = true; walkAst(condRest, { enter: scan }); forcePre = false }
  // typeof-process guard, not globalThis.process — a bare `globalThis` read
  // compiles to an env.globalThis import in the self-compile build; typeof folds dead
  if (typeof process !== 'undefined' && process.env.JZ_DBG_VS) console.error('VS', iv, 'cands', cands.length, 'bump', bump, 'ivWriteAt', ivWriteAt, 'body0', Array.isArray(body) ? body[0] : typeof body, cands.slice(0,4).map(c => c.recv + (c.range ? ':hull' : c.ind ? ':ind' : c.cursor != null ? `:cursor(${c.cursor},K=${c.K})` : ':aff') + (c.post ? ':POST' : '')).join(' '))
  return cands.length
    ? { iv, ivKind: exprType(iv, locals) === 'i32' ? 'i32' : 'f64', startC, bump, bound, bKind, incl, stepBy, cands }
    : null
}

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

/** A value join whose typed-storage fact must be met across arms by the
 * shared typed-provenance authority. */
export const isCondExpr = e => Array.isArray(e) &&
  (e[0] === '?:' || e[0] === '&&' || e[0] === '||' || e[0] === '??')


/** Clone AST with substitutions/renames. Skips into `=>` bodies. */
export function cloneWithSubst(node, subst, rename = null) {
  if (!(subst instanceof Map)) {
    const name = subst, value = rename
    if (node === name) return [null, value]
    if (!Array.isArray(node)) return node
    if (node[0] === '=>') return node
    const out = node.map(x => cloneWithSubst(x, name, value))
    stampClonedIdxProof(node, out)
    return out
  }
  const ren = rename instanceof Map ? rename : new Map()
  if (typeof node === 'string') {
    if (subst.has(node)) return cloneNode(subst.get(node))
    return ren.get(node) || node
  }
  if (!Array.isArray(node)) return node
  const op = node[0]
  if (op === 'str') return node.slice()
  if (op === '=>') return node
  if (op === '.' || op === '?.') return [op, cloneWithSubst(node[1], subst, ren), node[2]]
  if (op === ':') return [op, node[1], cloneWithSubst(node[2], subst, ren)]
  const out = node.map((part, i) => i === 0 ? part : cloneWithSubst(part, subst, ren))
  stampClonedIdxProof(node, out)
  return out
}

/** Proof carry-over for clones: substitution only SHRINKS an index's value set (an
 *  unrolled iv becomes one literal from its proven range), so a proven typed access
 *  stays proven under its post-substitution key — without this, loop unrolling
 *  silently re-checks every access the interval walk or a versioned guard covered. */
function stampClonedIdxProof(node, out) {
  if (node[0] !== '[]' || node.length !== 3 || typeof node[1] !== 'string' || out[1] !== node[1]) return
  const k = idxKey(node[1], node[2])
  const ip = intervalProvenIdx(ctx)   // memoized; NO_INTERVAL_PROVEN when no function ctx
  if (ip.has(k)) ip.add(idxKey(out[1], out[2]))
  // intervalProvenIdx(ctx) above already populated getFactStore().ipRanges for
  // ctx.func.body when it's a valid function body (AdHocMemo retirement — was
  // ctx.func.ipRanges, a plain field mirroring the same memoized Map).
  const ranges = Array.isArray(ctx.func?.body) ? getFactStore().ipRanges.get(ctx.func.body) : null
  const rng = ranges?.get(k)
  if (rng != null) ranges.set(idxKey(out[1], out[2]), rng)   // hulls survive substitution too
  const owner = ctx.types?.assumedBounds?.get(k)
  if (owner != null) ctx.types.assumedBounds.set(idxKey(out[1], out[2]), owner)
}

// Resolve a name's typed-array element ctor: in-progress local overlay (analyzeBody) →
// per-func map (post-analyze) → module-global registry. The global fallback matters during
// analyzeBody/narrow when the per-func map is null, so a read of a *global* typed array
// (`DX[i]` with `let DX = new Int32Array(...)` at module scope) resolves its element type
// instead of defaulting to f64. Guard against local shadows / dynamic rewrites (cf. kind.js).
const typedElemCtorOf = (name, locals) => typedStorageNameCtor(ctx, name, locals)

// An expression whose i32 value carries the unsigned [0, 2^32) magnitude (not a signed i32):
// `>>>`, an unsigned-result call, or a Uint32Array read (aux 5 — the only typed array whose
// element can exceed signed-i32 range). The +/-/*/% rules widen these to f64 so `U[i] + 1`
// near 2^32 doesn't wrap; bitwise/store consumers are ToInt32-exact and keep the i32 bits.
const isUnsignedI32Expr = (e, locals) => Array.isArray(e) && (
  e[0] === '>>>' ||
  (e[0] === '()' && typeof e[1] === 'string' && ctx.funcs.map?.get(e[1])?.sig?.unsignedResult === true) ||
  (e[0] === '[]' && typeof e[1] === 'string' && typedElemAux(typedElemCtorOf(e[1], locals)) === 5)
)

/**
 * Infer expression result type from AST (without emitting).
 * Used to determine local variable types before compilation.
 * Looks up `locals` first, then current-function params (for i32-specialized params).
 *
 * `valTypes` (optional): Map<name, VAL.*> — VAL-KIND facts for the CURRENT
 * body's locals (analyzeBody(body).valTypes), consulted ONLY by the bitwise-
 * ops BigInt gate below. Round-6 prereq (a) sibling: that gate's own BigInt
 * check used a bare valTypeOf(expr), whose recursion into a bare identifier
 * (numericUnaryVT → valTypeOf(name) → the GLOBAL lookupValType) can't see a
 * local's kind before narrow.js's per-function reps are live — the exact gap
 * valTypeOfWithLocals (kind.js) exists to close. Phase E (narrowI32Results)
 * runs this early, so without `valTypes` a proven-BigInt local's `~`/`&`/etc.
 * return tail silently narrowed the function's WASM result to i32 (a NUMBER),
 * contradicting Phase E2's (narrowValResults, same body, same local) now-
 * correct BIGINT valResult claim — a WAT-validation crash, not a silent one,
 * since the two phases' facts about the SAME expression must agree. Omitted
 * by every other caller (defaults to undefined): they run late enough that
 * lookupValType alone is already sound, or don't call through this gate.
 */
// `bodyRoot` (optional, §14 point 4 fallout): the ctx-INDEPENDENT structural
// presentVal trace (kind.js exprPresentValIn/namePresentValInBody) for the
// bitwise-ops BigInt guard below, needed specifically by narrow.js's
// `narrowI32Results` — a whole-program pre-pass that runs BEFORE per-function
// `ctx.func.localReps` is live, so `censusMaybeUndefinedKind`'s bare-name arm
// (which DOES need ctx) can't see a presentVal-carrying local there. Every
// OTHER caller of exprType runs at emit time (`ctx.func.locals`, reps live)
// where `censusMaybeUndefinedKind` alone already resolves a bare name — they
// pass no `bodyRoot` and are unaffected (parameter is optional, threaded
// through recursive calls purely for the callers that do supply it).
export function exprType(expr, locals, valTypes, strict, bodyRoot) {
  if (expr == null) return 'f64'
  if (typeof expr === 'number')
    return isI32(expr) ? 'i32' : 'f64'
  if (typeof expr === 'string') {
    if (locals?.has?.(expr)) return locals.get(expr)
    const paramType = ctx.func.current?.params?.find(p => p.name === expr)?.type
    if (paramType) return paramType
    // A module-level INTEGER const (`const N = 16384`) is an integer compile-time
    // constant — type it i32 when it fits, regardless of the global's f64 (NaN-box)
    // storage. Otherwise a counter bounded by it (`for (i=0; i<N; i++)`) widens to
    // f64 and `x % N` / `x & N` / `x / N` take the f64 round-trip instead of the
    // native integer path (i32.rem_s / i32.and / i32.shr). Mirrors a literal int.
    const ci = ctx.scope?.constInts?.get?.(expr)
    if (ci != null && isI32(ci)) return 'i32'
    // Module-level numeric consts emitted as wasm globals with a known wasm type.
    // Only propagate primitive numeric kinds — i64 globals are reserved for the
    // NaN-box carrier ABI and shouldn't influence local typing.
    const gt = ctx.scope?.globalTypes?.get?.(expr)
    if (gt === 'i32' || gt === 'f64') return gt
    return 'f64'
  }
  if (!Array.isArray(expr)) return 'f64'

  const [op, ...args] = expr
  if (op == null) return exprType(args[0], locals, valTypes, strict, bodyRoot) // literal [, value]

  // Statically evaluable to -0 (e.g. -1 * 0) — i32 would lose the sign.
  const sv = staticValue(expr)
  if (sv !== NO_VALUE && typeof sv === 'number' && Object.is(sv, -0)) return 'f64'

  // Always f64
  if (op === '/' || op === '**' || op === '[' || op === '{}' || op === 'str') return 'f64'
  // arr[i] — integer typed arrays (Int8/Uint8/Int16/Uint16/Int32/Uint32, aux 0..5) read as i32:
  // the element IS a 32-bit machine integer, so a binding used in integer/bitwise ops stays i32
  // instead of round-tripping i32.load → f64 → trunc back (the deopt that made packed-pixel fade
  // loops like lorenz slow). Uint32 reads carry the full 0..2^32-1 range as the i32 bit-pattern;
  // ToInt32-coercing uses (& | ^ << >> >>>, i32.store) are bit-exact, and value uses that need the
  // unsigned magnitude (compare, f64 convert) go through the elem-aux's unsigned path. Floats
  // (Float32/Float64, aux 6/7) genuinely yield f64. typedElems: in-progress reads come from
  // localTypedElemsOverlay during analyzeBody; post-analyze passes read ctx.func.typedElem.
  if (op === '[]') {
    if (typeof args[0] === 'string') {
      // Resolve the element ctor across local overlay → per-func map → module-global registry
      // (the global fallback is why `DX[i]` on a module-scope Int32Array types as i32 instead of
      // f64-round-tripping integer accumulation like `ax = ax + DX[i]`). See typedElemCtorOf.
      const ctor = typedElemCtorOf(args[0], locals)
      if (ctor) {
        const aux = typedElemAux(ctor)
        // int family only — Float16Array shares code 3 with a flag; its elements are floats.
        // NOTE the i32 claim is a VALUE-context answer (ToInt32 consumers fold a
        // miss's undefined to 0, correctly). STORAGE narrowing (an i32 local
        // cell) must additionally prove the read cannot miss — the cell would
        // trunc_sat the miss's NaN to 0 — and that veto lives with the cell
        // writers in analyze.js (body-local proofs, cache-pure), not here:
        // exprType runs inside the context-pure cached analyzeBody where the
        // emit-time prover state (typedIdxProven) is unavailable/foreign.
        if (aux != null && (aux & 7) <= 5 && !(aux & 32)) return 'i32'
      }
    }
    return 'f64'
  }
  // A sized built-in property on a statically-known receiver (`.length` on
  // STRING/ARRAY/TYPED, `.size` on SET/MAP, `.byteLength`/`.byteOffset` on
  // TYPED/BUFFER) returns i32 directly (`__len`/`__str_byteLen` return i32).
  // Keeping it i32 lets analyzeBody keep the counter local i32, eliminating the
  // per-iteration `f64.convert_i32_s` widen and matching `arr[i]`/`i*k` truncs.
  // The membership lives in one place — `propValType` (src/kind-traits.js).
  if (op === '.') {
    if (typeof args[0] === 'string' && propValType(args[1], lookupValType(args[0])) === VAL.NUMBER) return 'i32'
    // Strict-int32 schema slot (write census): the read emits as a raw i32
    // (emitSchemaSlotRead's trunc route), so the static local-slot classifier
    // must agree — `const x = hitX ? p.x : nx` then declares x i32 instead of
    // f64, and the whole ternary/arith chain stays in int registers.
    if (typeof args[0] === 'string' && ctx.schema?.slotI32CertainAt?.(args[0], args[1])) return 'i32'
    return 'f64'
  }
  // Comparisons, logical-not, and unsigned shift always yield an i32 — a boolean,
  // or a ToUint32 result. True even on BigInt operands (`>>>` throws on bigint, so
  // it never reaches here with one).
  if (CMP_OPS.has(op) || op === '>>>') return 'i32'
  // Bitwise & signed-shift: i32 on numbers, but f64 when operands are BigInt — the
  // result is a bigint carried in the i64-bits-as-f64 ABI, not a 32-bit int.
  // valTypeOfWithLocals (not a bare valTypeOf(expr)): `valTypes` — when the
  // caller has it (narrowI32Results, this phase's only BigInt-sensitive
  // caller) — resolves a bare identifier's kind from analyzeBody's per-body
  // facts BEFORE narrow.js's global per-function reps are live; see the
  // module doc above exprType.
  if (['&', '|', '^', '~', '<<', '>>'].includes(op)) {
    // PRECISE census checks (§14 point 4 fallout) — an ACTUAL BIGINT-kind
    // resolution (censusMaybeUndefinedKind's own dictValueKindOf/mapValueKindOf
    // receiver-kind check filters out a plain array/typed-array receiver
    // already — never fires for `arr[i]`), plus the ctx-independent
    // `exprPresentValIn`/`exprMapGetShapedIn` structural twins for a
    // whole-program pre-pass where `ctx.func.localReps` isn't live yet.
    // Checked UNCONDITIONALLY, before `valTypeOfWithLocals` — NOT gated on
    // `vt == null` (a real regression this design's own §14 point 4 landing
    // found: the arithmetic/bitwise family's OWN deliberate "unknown operand
    // → NUMBER" optimistic default, kind.js, resolves `vt` to a DEFINITE
    // VAL.NUMBER for exactly this shape — bare census-sourced names, unresolved
    // by `resolveLocal` — so gating this behind `vt == null` skipped it
    // entirely, the WASM validator's own type-mismatch catching what would
    // otherwise have been a desynced boundary wrapper).
    const preciseBigCensus = (e) => censusMaybeUndefinedKind(e) === VAL.BIGINT ||
      (bodyRoot && (exprPresentValIn(e, bodyRoot) === VAL.BIGINT || exprMapGetShapedIn(e, bodyRoot)))
    if (preciseBigCensus(args[0]) || (args.length > 1 && preciseBigCensus(args[1]))) return 'f64'
    const vt = valTypeOfWithLocals(expr, name => valTypes?.get(name) ?? lookupValType(name))
    if (vt === VAL.BIGINT) return 'f64'
    // IMPRECISE, purely-structural fallback (censusShapedNode's own broad
    // `[]`/`.` arm ALSO matches an ordinary array/typed-array 2-arg index —
    // `arr[i] & mask` is common in hot bitwise code) — kept GATED on
    // `vt == null`, the EXACT original (pre-§14-point-4) condition, never
    // widened: unconditionally applying this broad check regressed
    // vectorization for exactly that ordinary-array shape (measured, caught
    // by the gate run — `test/inference.js`'s PRNG bitwise-kernel pin lost
    // its v128 codegen entirely), confirmed the array/typed-array case
    // reaches here with `vt` ALREADY non-null (definitively resolved), so
    // this arm is unreached for it either way — restored to its narrowest,
    // originally-verified-safe form.
    if (vt == null && (censusShapedNode(args[0]) || (args.length > 1 && censusShapedNode(args[1])))) return 'f64'
    return 'i32'
  }
  // Preserve i32 if both operands i32. `strict` additionally requires a
  // magnitude-bound proof the sum/difference fits signed i32 (P0-2 sibling,
  // 2026-08-02) — needed ONLY by callers deciding whether a value may escape
  // BARE with no further ToInt32 sink (tryI32Arith, emit.js). Every other
  // caller (local/param storage-type decisions — the overwhelming majority)
  // omits it: a value merely STORED i32 is safe regardless of magnitude,
  // since every read of that storage re-applies the identical ToInt32
  // conversion the write did — a magnitude-strict default here (measured,
  // reverted) demoted 8/10 perf-ratchet benchmarks' hottest accumulator/
  // index shapes from i32 to f64.
  if (op === '+' || op === '-') {
    const ta = exprType(args[0], locals, valTypes, strict)
    const tb = args[1] != null ? exprType(args[1], locals, valTypes, strict) : ta // unary: inherit
    if (ta !== 'i32' || tb !== 'i32') return 'f64'
    // A uint32 operand ([0, 2^32)) makes the result exceed signed i32 range, so
    // emit widens to f64 (see emit.js `+`/`-`). exprType must agree — else
    // narrowing the result back to i32 would trunc_sat-saturate the f64 to INT32_MAX.
    if (isUnsignedI32Expr(args[0], locals) || (args[1] != null && isUnsignedI32Expr(args[1], locals))) return 'f64'
    if (!strict || args[1] == null) return 'i32'  // unary: no combination magnitude to bound
    if (sv !== NO_VALUE && typeof sv === 'number') return isI32(sv) ? 'i32' : 'f64'
    const bound = e => {
      const r = intExprRange(e)
      return r != null ? Math.max(Math.abs(r[0]), Math.abs(r[1])) : 0x80000000
    }
    return bound(args[0]) + bound(args[1]) <= 0x7fffffff ? 'i32' : 'f64'
  }
  // `%` is i32 only when emit takes the i32.rem_s path: both operands i32, neither
  // unsigned, AND the divisor is a nonzero integer constant. A 0 or runtime divisor
  // yields NaN via f64rem (f64), so result-narrowing must NOT see i32 here — else a
  // NaN remainder gets i32.trunc_sat'd to 0. Mirrors the emit.js `%` guard exactly.
  if (op === '%') {
    const ta = exprType(args[0], locals, valTypes, strict), tb = exprType(args[1], locals, valTypes, strict)
    if (ta !== 'i32' || tb !== 'i32') return 'f64'
    if (isUnsignedI32Expr(args[0], locals) || isUnsignedI32Expr(args[1], locals)) return 'f64'
    const dv = staticValue(args[1])
    return (dv !== NO_VALUE && typeof dv === 'number' && dv !== 0 && Number.isInteger(dv)) ? 'i32' : 'f64'
  }
  // `*` — a JS multiply is an f64 operation; `i32.mul` reproduces it faithfully
  // only when the exact product provably fits signed i32 (±(2^31−1)) — NOT
  // merely f64-exact (P0-2 ledger: the old "one literal operand ≤2^22, other
  // side unbounded" rule let `i32.mul` wrap past i32 range while staying
  // f64-representable, corrupting any consumer that widens the result straight
  // to f64). Stay i32 when both operands are i32 *and* the product provably
  // fits: a fully-static product checked directly, otherwise a magnitude BOUND
  // on EACH operand (intExprRange's hull — resolves module const-ints, ranged
  // decl reps, masks/ternaries) whose PRODUCT (not either bound alone) clears
  // the i32 ceiling. Mirrors emit.js `mulFitsI32`/`mulRangeFitsI32` exactly —
  // this must stay a SUBSET of emit's verdict (never claim i32 where emit
  // might widen to f64): an unproven operand costs the full i32 magnitude in
  // the product check, same sentinel emit's `maskBound` defaults to.
  if (op === '*') {
    const ta = exprType(args[0], locals, valTypes, strict), tb = exprType(args[1], locals, valTypes, strict)
    if (ta !== 'i32' || tb !== 'i32') return 'f64'
    // uint32 operand: product can exceed i32; emit widens to f64 (see emit.js `*`).
    if (isUnsignedI32Expr(args[0], locals) || isUnsignedI32Expr(args[1], locals)) return 'f64'
    if (sv !== NO_VALUE && typeof sv === 'number') return isI32(sv) ? 'i32' : 'f64'
    const bound = e => {
      const r = intExprRange(e)
      return r != null ? Math.max(Math.abs(r[0]), Math.abs(r[1])) : 0x80000000
    }
    return bound(args[0]) * bound(args[1]) <= 0x7fffffff ? 'i32' : 'f64'
  }
  // `u+` truly just preserves its operand's type (ToNumber, no arithmetic). `u-`
  // is `0 - x` — same overflow shape as binary `-` (line ~2351 above) and needs
  // the same magnitude-bound proof under `strict`: negating I32_MIN (-2^31)
  // overflows to 2^31, one past I32_MAX, and negating a proven-unsigned i32
  // ([0, 2^32)) — a `>>>`/unsignedResult/Uint32Array-read value, or a
  // narrowUint32 accumulator local (isUnsignedI32Expr doesn't see the latter;
  // its range is simply unproven, so the generic bound fallback below already
  // catches it) — can go far past it (`-(3000000000)` = -3000000000). Missing
  // this let narrowI32Results (the only `strict` caller with no further
  // ToInt32 sink) commit a function's result to i32 for `return -y`, then
  // wrap the true value through i32.wrap_i64(trunc_sat) instead of leaving it
  // f64 — silently corrupting both `-(-2^31)` (signed) and `-(unsigned h)`.
  if (op === 'u+') return exprType(args[0], locals, valTypes, strict)
  if (op === 'u-') {
    const t = exprType(args[0], locals, valTypes, strict)
    if (t !== 'i32') return t
    if (isUnsignedI32Expr(args[0], locals)) return 'f64'
    if (!strict) return 'i32'
    if (sv !== NO_VALUE && typeof sv === 'number') return isI32(sv) ? 'i32' : 'f64'
    const r = intExprRange(args[0])
    const bound = r != null ? Math.max(Math.abs(r[0]), Math.abs(r[1])) : 0x80000000
    return bound <= 0x7fffffff ? 'i32' : 'f64'
  }
  // Ternary / logical: conciliate
  if (op === '?:' || op === '&&' || op === '||') {
    const branches = op === '?:' ? [args[1], args[2]] : [args[0], args[1]]
    const ta = exprType(branches[0], locals, valTypes, strict), tb = exprType(branches[1], locals, valTypes, strict)
    if (ta !== 'i32' || tb !== 'i32') return 'f64'
    // research.md §Carrier invariant: both branches are i32-REPRESENTABLE (a
    // comparison's 0/1 and a NUMBER literal both answer 'i32' here — this
    // function only asks "does the WASM storage type fit", not "do the two
    // branches carry the same represented VALUE"), but a BOOL∪NUMBER merge
    // (`cond && 1`, `cond ? 1 : false`) needs its BOOL arm to keep its
    // TRUE/FALSE atom identity — an i32-classification is exactly what lets
    // a caller narrow this expression's storage to i32 and permanently lose
    // that atom (narrowI32Results' return-tail narrowing, the param lattice's
    // argWasmType — both consult exprType, both would otherwise commit to a
    // narrowing no downstream boxing fix could recover from). hasAmbiguousBoolMerge
    // is the same locals-aware resolver Phase E's BigInt gate two branches up
    // already needed (this phase runs before ctx.func.localReps is populated).
    if (hasAmbiguousBoolMerge(expr, e => valTypeOfWithLocals(e, name => valTypes?.get(name) ?? lookupValType(name))))
      return 'f64'
    return 'i32'
  }
  if (op === '[') return 'f64'
  // Builtin calls with known i32 result. Math.imul / Math.clz32 always produce
  // a 32-bit integer; recognising this here keeps `let x = Math.imul(...)` (and
  // chains like `x = Math.imul(x, k) + 12345`) on the i32 ABI all the way
  // through, instead of widening the local to f64 because exprType defaulted.
  if (op === '()') {
    if (args[0] === 'math.imul' || args[0] === 'math.clz32') return 'i32'
    // SIMD intrinsics → v128 lane vector, except lane-extract / reductions which
    // hand a scalar back (i32x4.lane / v128.anyTrue / v128.allTrue → i32;
    // f32x4.lane → f64). See module/simd.js.
    if (typeof args[0] === 'string' && (args[0].startsWith('f32x4.') || args[0].startsWith('i32x4.') || args[0].startsWith('f64x2.') || args[0].startsWith('v128.'))) {
      if (args[0] === 'f32x4.lane' || args[0] === 'f64x2.lane') return 'f64'
      if (args[0] === 'i32x4.lane' || args[0] === 'v128.anyTrue' || args[0] === 'v128.allTrue') return 'i32'
      return 'v128'
    }
    // charCodeAt: i32 when the index is provably in `[0, recv.length)` (an
    // induction variable bounded by `recv.length` — OOB impossible). Otherwise
    // f64: the JS-spec OOB result is NaN, which is not representable as i32.
    if (Array.isArray(args[0]) && args[0][0] === '.' && args[0][2] === 'charCodeAt'
        && inBoundsCharCodeAt(ctx).has(args[0])) return 'i32'
    // User-function call: consult the callee's narrowed result type. By the time
    // analyzeBody runs in emitFunc, narrowSignatures has set sig.results[0]='i32'
    // on every body-i32-only func. Propagating this lets `let h = userFn(...)`
    // (mix in callback bench: i32-FNV) keep h as an i32 local instead of widening
    // to f64 and round-tripping i32↔f64 every iteration.
    if (typeof args[0] === 'string') {
      const f = ctx.funcs.map?.get(args[0])
      if (f?.sig?.results?.length === 1 && f.sig.results[0] === 'i32' && f.sig.ptrKind == null) return 'i32'
      if (f?.sig?.results?.length === 1 && f.sig.results[0] === 'v128') return 'v128'   // SIMD helper
    }
  }
  return 'f64'
}
