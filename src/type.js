/**
 * WASM local typing + typed-array metadata + integer proofs.
 *
 * - exprType: i32 vs f64 for locals/params
 * - typedElemCtor / ternaryCtorOfRhs: detect typed-array ctor from an AST rhs
 *   (the pure PTR.TYPED aux codec lives in layout.js)
 * - scanBoundedLoops / inBoundsCharCodeAt: charCodeAt i32 contract proof
 * - loop unroll helpers: smallConstForTripCount, cloneWithSubst, …
 * - intCertainMap / intExprChecker: integer-shaped binding analysis
 *
 * @module type
 */
import { isI32, isReassigned } from './ast.js'
import { ctx } from './ctx.js'
import { FITS_I32_MAX } from './widen.js'
import { VAL, lookupValType } from './reps.js'
import { valTypeOf } from './kind.js'
import { propValType, CMP_OPS } from './kind-traits.js'
import { NO_VALUE, staticValue, intLiteralValue } from './static.js'
import { typedElemAux } from '../layout.js'

/** Byte-backed constructors whose `new X()` yields a PTR.TYPED / PTR.BUFFER value:
 *  the typed-array views + ArrayBuffer + DataView. Mirrors autoload's TYPED_CTORS
 *  (kept local to avoid a type↔module import cycle). Every other ctor — Map, Set,
 *  Date, Array, RegExp, user classes — has its own VAL kind via CALLEE_VAL and must
 *  NOT be mistaken for a typed-array construction (else its global misdispatches as
 *  a TypedArray, e.g. `map.set(k,v)` lowering to `arr.set(src,offset)`). */
const TYPED_FAMILY_CTORS = new Set([
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'ArrayBuffer', 'DataView',
])

/** Extract typed-array ctor name ('new.Float32Array', 'new.Int8Array.view', etc) from RHS,
 *  or null if RHS isn't a typed-array/ArrayBuffer/DataView constructor. */
export function typedElemCtor(rhs) {
  if (!Array.isArray(rhs) || rhs[0] !== '()' || typeof rhs[1] !== 'string' || !rhs[1].startsWith('new.')) return null
  if (!TYPED_FAMILY_CTORS.has(rhs[1].slice(4))) return null
  const args = rhs[2]
  const isView = rhs[1].endsWith('Array') && rhs[1] !== 'new.ArrayBuffer'
    && Array.isArray(args) && args[0] === ',' && args.length >= 4
  return isView ? rhs[1] + '.view' : rhs[1]
}

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

/** Fold an int-const expression: literals, module int consts (`const N = 3`), and
 *  +,-,*,<< over them — `new Int8Array(CIN*H*W)` sizes are static facts. */
export function constIntExpr(e) {
  const n = intLiteralValue(e)
  if (n != null) return n
  if (typeof e === 'string') {
    const ci = ctx.scope?.constInts?.get?.(e)
    return ci != null && isI32(ci) ? ci : null
  }
  if (!Array.isArray(e) || e.length !== 3) return null
  const [op, x, y] = e
  if (op !== '+' && op !== '-' && op !== '*' && op !== '<<') return null
  const A = constIntExpr(x), B = constIntExpr(y)
  if (A == null || B == null) return null
  const r = op === '+' ? A + B : op === '-' ? A - B : op === '*' ? A * B : A * 2 ** B
  return Number.isSafeInteger(r) && isI32(r) ? r : null
}

/** `recv[idx]` provably within [0, recv.length) for a typed receiver — the gate the
 *  checked `.typed:[]` forms and the identity folds share. Proof classes:
 *  1. the canonical-loop structural pair (inBoundsArrIdx);
 *  2. a literal index against the binding's STATIC length (ctx.types.typedLen /
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
  if (intervalProvenIdx(ctx).has(idxKey(recv, idx))) return true
  if (typeof idx === 'string' && inBoundsArrIdx(ctx).has(recv + '\x00' + idx)) return true
  const len = ctx.types.typedLen?.get(recv) ?? ctx.scope?.globalTypedLen?.get(recv)
  if (len == null) return false
  const k = intLiteralValue(idx)
  if (k != null) return k >= 0 && k < len
  if (Array.isArray(idx) && idx[0] === '&' && idx.length === 3) {
    const m = intLiteralValue(idx[1]) ?? intLiteralValue(idx[2])
    if (m != null) return m >= 0 && m < len
  }
  if (typeof idx === 'string') {
    const B = litBoundArrIdx(ctx).get(recv + '\x00' + idx)
    if (B != null) return B <= len
  }
  return false
}

/** Structural key for a `recv[idx]` site — the assumedBounds channel between the
 *  versioning scan and typedIdxProven. JSON is structural, so the key matches even
 *  when the prover sees a clone of the scanned node. */
export const idxKey = (recv, idx) => recv + '\x00' + (typeof idx === 'string' ? idx : JSON.stringify(idx))

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
const SLOT_OPS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '>>>'])
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
  const walk = (n) => {
    if (!Array.isArray(n) || n[0] === '=>') return
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
    for (let k = 1; k < n.length; k++) walk(n[k])
  }
  walk(body)
  return env
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
    const collectW = (n) => {
      if (!Array.isArray(n)) return
      if (((n[0] === '=' || n[0] === '+=') && n[1] === iv) || ((n[0] === '++' || n[0] === '--') && n[1] === iv))
        writes.push(n)
      for (let k = 1; k < n.length; k++) collectW(n[k])
    }
    collectW(body)
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
    : (() => { const r = lengthRecv(bound); return r != null && ctx.types.typedElem?.has(r) && stable(r) })() ? 'i32'
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
    if (!Array.isArray(n)) return
    if (n[0] === '[]' && n.length === 3 && typeof n[1] === 'string' && n[1] !== iv
        && ctx.types.typedElem?.has(n[1]) && stable(n[1])) {
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
    for (let k = 1; k < n.length; k++) scan(n[k])
  }
  if (seqBody) {
    for (let s = 1; s < body.length; s++) { scanTop = s; scan(body[s]) }
    scanTop = -1
  } else scan(body)
  // `&&`-cond rest conjuncts — scanned AFTER the body so a shared-key body
  // access (potentially post-increment, wider extent) wins the seen-set
  if (condRest != null) { forcePre = true; scan(condRest); forcePre = false }
  // typeof-process guard, not globalThis.process — a bare `globalThis` read
  // compiles to an env.globalThis import in the self-host build; typeof folds dead
  if (typeof process !== 'undefined' && process.env.JZ_DBG_VS) console.error('VS', iv, 'cands', cands.length, 'bump', bump, 'ivWriteAt', ivWriteAt, 'body0', Array.isArray(body) ? body[0] : typeof body, cands.slice(0,4).map(c => c.recv + (c.range ? ':hull' : c.ind ? ':ind' : ':aff') + (c.post ? ':POST' : '')).join(' '))
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
      if (!Array.isArray(n) || n[0] === '=>') return
      if (n[0] === '[]' && n.length === 3 && typeof n[1] === 'string'
          && ctx.types.typedElem?.has(n[1]) && stable2(n[1])) {
        const key = idxKey(n[1], n[2])
        if (!seen.has(key) && !typedIdxProven(n[1], n[2])) {
          const rng = intervalIdxRanges(ctx).get(key)
          if (rng && (rng.hiName == null || stable2(rng.hiName))) {
            seen.add(key); cands.push({ recv: n[1], idx: n[2], range: rng })
          }
        }
      }
      for (let k = 1; k < n.length; k++) scan(n[k])
    }
    scan(c2)   // `while (keys[h] !== k)` — the accesses live in the COND
    scan(b2)
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
  const exprNames = (e, out) => {
    if (typeof e === 'string') out.push(e)
    else if (Array.isArray(e)) for (let k = 1; k < e.length; k++) exprNames(e[k], out)
  }
  const keepPre = levels.filter((L) => {
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
  const collectCW = (n) => {
    if (!Array.isArray(n)) return
    if ((ASSIGN_OPS_V.has(n[0]) || n[0] === '++' || n[0] === '--') && typeof n[1] === 'string') {
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
    for (let k = 1; k < n.length; k++) collectCW(n[k])
  }
  collectCW(body)
  const contains = (hay, needle) => hay === needle
    || (Array.isArray(hay) && hay.some((x, i) => i > 0 && contains(x, needle)))
  const allLoopBodies = []
  const collectLoops = (n) => {
    if (!Array.isArray(n) || n[0] === '=>') return
    if (n[0] === 'while' && n.length === 3) allLoopBodies.push(n[2])
    else if (n[0] === 'for' && n.length === 5) allLoopBodies.push(n[4])
    for (let k = 1; k < n.length; k++) collectLoops(n[k])
  }
  collectLoops(body)
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
      if (!Array.isArray(n)) return
      if (n === w.node) { seenWrite = true }
      if (n[0] === '[]' && n.length === 3 && typeof n[1] === 'string' && n[2] === name
          && ctx.types.typedElem?.has(n[1])
          && !isReassigned(body, n[1]) && !redeclaresName(body, n[1]))
        cands.push({ recv: n[1], idx: n[2], post: seenWrite })
      for (let k = 1; k < n.length; k++) scanC(n[k])
    }
    scanC(body)
    if (cands.length) cursors.push({ name, slope: w.slope, chain, cands,
      kind: exprType(name, locals) === 'i32' ? 'i32' : 'f64' })
  }
  keep.cursors = cursors
  return keep
}
const ASSIGN_OPS_V = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '**='])

/** Sentinel returned by `ternaryCtorOfRhs` when ternary branches resolve to
 *  different typed-array ctors — caller should drop any cached entry rather
 *  than leave a stale ctor (which would lock the wrong store width). */
export const MIXED_CTORS = Symbol('MIXED_CTORS')


/** A `?:`/`&&`/`||` expression — value depends on a condition, so its ctor
 *  must be derived by walking branches (handled by `ternaryCtorOfRhs`). */
export const isCondExpr = e => Array.isArray(e) && (e[0] === '?:' || e[0] === '&&' || e[0] === '||')

/** Walk a `?:`/`&&`/`||` expression and return:
 *  - a single ctor string when every branch resolves to the same ctor,
 *  - MIXED_CTORS when branches resolve to different ctors,
 *  - null when no branch resolves (caller's behavior unchanged).
 *
 *  `resolveName(name)` (optional) maps a *variable-name* branch to its known
 *  typed-array ctor — without it a branch like `cond ? bufA : bufB` (two typed
 *  bindings rather than two `new` literals) resolves to null and the binding
 *  falls back to the dynamic `$__typed_idx` read path. The classic ping-pong
 *  `let cur = flip ? a : b; cur[i]` needs this to keep fast typed loads. */
export function ternaryCtorOfRhs(rhs, resolveName) {
  if (typeof rhs === 'string') return resolveName?.(rhs) ?? null
  if (!Array.isArray(rhs)) return null
  const op = rhs[0]
  const lo = op === '?:' ? 2 : (op === '&&' || op === '||') ? 1 : 0
  if (!lo) return null
  const a = ternaryCtorOfRhs(rhs[lo], resolveName) ?? typedElemCtor(rhs[lo])
  const b = ternaryCtorOfRhs(rhs[lo + 1], resolveName) ?? typedElemCtor(rhs[lo + 1])
  return a && b ? (a === b ? a : MIXED_CTORS) : (a || b || null)
}

// =============================================================================
// charCodeAt in-bounds proof
// =============================================================================
// `String.prototype.charCodeAt` returns NaN for an out-of-range index, so the
// generic codegen contract is an f64 result (see module/string.js). When the
// index is the induction variable of a `for (let i = C; i < recv.length; i++)`
// loop, every `recv.charCodeAt(i)` in the loop body is statically inside
// `[0, recv.length)` — OOB is impossible — so the call may use the cheaper i32
// (raw-byte) contract instead. This is a static guarantee, not a guess.

/** Step expression of a `for` that increments `name` by exactly 1. */
export function isUnitIncrement(step, name) {
  if (!Array.isArray(step)) return false
  if (step[0] === '++' && step[1] === name) return true
  // postfix `i++` in value position lowers to `(++i) - 1`
  if (step[0] === '-' && Array.isArray(step[1]) && step[1][0] === '++'
      && step[1][1] === name && intLiteralValue(step[2]) === 1) return true
  return false
}

export function isUnitDecrement(step, name) {
  if (!Array.isArray(step)) return false
  if (step[0] === '--' && step[1] === name) return true
  // postfix `i--` in value position lowers to `(--i) + 1`
  if (step[0] === '+' && Array.isArray(step[1]) && step[1][0] === '--'
      && step[1][1] === name && intLiteralValue(step[2]) === 1) return true
  return false
}

/** `let`/`const` re-declaration of `name` within `node` — does not cross `=>`
 *  (a closure has its own scope; collection already stops at closure boundaries). */
function redeclaresName(node, name) {
  if (!Array.isArray(node) || node[0] === '=>') return false
  if (node[0] === 'let' || node[0] === 'const') {
    for (let k = 1; k < node.length; k++) {
      const d = node[k]
      if (d === name) return true
      if (Array.isArray(d) && d[0] === '=' && d[1] === name) return true
    }
  }
  for (let k = 1; k < node.length; k++) if (redeclaresName(node[k], name)) return true
  return false
}

/** Collect `recv.charCodeAt(idxVar)` callee nodes within `node`. Stops at `=>`:
 *  a closure may run after the loop, when `idxVar` has reached `recv.length`. */
function collectBoundedCC(node, recv, idxVar, set) {
  if (!Array.isArray(node) || node[0] === '=>') return
  if (node[0] === '()' && node.length === 3 && node[2] === idxVar
      && Array.isArray(node[1]) && node[1][0] === '.'
      && node[1][1] === recv && node[1][2] === 'charCodeAt')
    set.add(node[1])
  for (let k = 1; k < node.length; k++) collectBoundedCC(node[k], recv, idxVar, set)
}

/** Receiver of a `.length` expression, possibly wrapped in `(… | 0)` — the
 *  shape `prepare` produces when it hoists a for-cond bound. */
function lengthRecv(expr) {
  if (Array.isArray(expr) && expr[0] === '|' && intLiteralValue(expr[2]) === 0) expr = expr[1]
  if (Array.isArray(expr) && expr[0] === '.' && expr[2] === 'length'
      && typeof expr[1] === 'string') return expr[1]
  // `Math.min(X, recv.length)` (either arg order): min ≤ recv.length regardless
  // of X, so the bound proof carries through. This is the shape
  // splitCharScanLoops plants for the in-bounds main loop of a split scan.
  if (Array.isArray(expr) && expr[0] === '()' && expr[1] === 'math.min') {
    const argsNode = expr[2]
    const args = Array.isArray(argsNode) && argsNode[0] === ',' ? argsNode.slice(1) : [argsNode]
    for (const a of args) { const r = lengthRecv(a); if (r) return r }
  }
  return null
}

/** Flatten `let`/`const` declarations (incl. `;`-joined groups) into `out`,
 *  mapping each declared name to its initializer expression. */
function collectDecls(node, out) {
  if (!Array.isArray(node)) return
  if (node[0] === ';') { for (let k = 1; k < node.length; k++) collectDecls(node[k], out); return }
  if (node[0] === 'let' || node[0] === 'const') {
    for (let k = 1; k < node.length; k++) {
      const d = node[k]
      if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') out.set(d[1], d[2])
    }
  }
}

/** Walk `node`, recording in `set` the `charCodeAt` callee nodes proven in-bounds
 *  by an enclosing canonical induction loop `for (let i = C; i < recv.length; i++)`.
 *  Matches the post-`prepare` shape, where the `.length` bound is hoisted into a
 *  temp (`cond` becomes `i < lenTmp`, `lenTmp` declared in `init`). */
export function scanBoundedLoops(node, set) {
  if (!Array.isArray(node)) return
  if (node[0] === 'for' && node.length === 5) {
    const [, init, cond, step, body] = node
    let idx = null, recv = null, boundVar = null
    if (Array.isArray(cond) && cond[0] === '<' && typeof cond[1] === 'string') {
      const decls = new Map()
      collectDecls(init, decls)
      idx = cond[1]
      // index must be declared in `init` as `let i = C`, C an integer literal ≥ 0
      const start = decls.has(idx) ? intLiteralValue(decls.get(idx)) : null
      if (start == null || start < 0) idx = null
      // bound is `recv.length`, directly or via a hoisted temp declared in `init`
      let bound = cond[2]
      if (typeof bound === 'string') { boundVar = bound; bound = decls.get(bound) }
      recv = lengthRecv(bound)
    }
    // step `i++`; body never writes `i`/`recv`/the bound temp (incl. via
    // closures) and never re-declares `i`. Then every bare `i` in the body
    // satisfies `0 ≤ C ≤ i < recv.length`.
    if (idx && recv && idx !== recv && isUnitIncrement(step, idx)
        && !isReassigned(body, idx) && !isReassigned(body, recv)
        && (boundVar == null || !isReassigned(body, boundVar))
        && !redeclaresName(body, idx))
      collectBoundedCC(body, recv, idx, set)
  }
  for (let k = 1; k < node.length; k++) scanBoundedLoops(node[k], set)
}

const NO_BOUNDED_CC = new Set()  // shared immutable empty result

/** Set of `['.', recv, 'charCodeAt']` callee nodes in the current function whose
 *  index argument is provably within `[0, recv.length)`. Memoised per body. */
export function inBoundsCharCodeAt(ctx) {
  const body = ctx.func?.body
  if (!Array.isArray(body)) return NO_BOUNDED_CC
  if (ctx.func._ccBody === body) return ctx.func.ccInBounds
  const set = new Set()
  scanBoundedLoops(body, set)
  ctx.func.ccInBounds = set
  ctx.func._ccBody = body
  return set
}

/** Collect proven-in-bounds `recv[idxVar]` accesses within a canonical induction
 *  loop. Stores `"recv\x00idxVar"` keys — `\x00` isn't a valid identifier char so
 *  the pair is unambiguous. Stops at `=>` (a closure may run after the loop, when
 *  `idxVar` has reached `recv.length`). */
function collectBoundedArrIdx(node, recv, idxVar, set) {
  if (!Array.isArray(node) || node[0] === '=>') return
  if (node[0] === '[]' && node.length === 3 && node[1] === recv && node[2] === idxVar)
    set.add(recv + '\x00' + idxVar)
  for (let k = 1; k < node.length; k++) collectBoundedArrIdx(node[k], recv, idxVar, set)
}

/** Walk `node`, recording `"recv\x00idx"` pairs for `recv[idx]` reads proven within
 *  `[0, recv.length)` by an enclosing canonical loop `for (let i = C; i < recv.length;
 *  i++)`. Same loop contract as `scanBoundedLoops` (charCodeAt) — sibling proof for
 *  the ARRAY indexed-read fast path in `module/array.js`. */
export function scanBoundedArrIdx(node, set, litSet) {
  if (!Array.isArray(node)) return
  if (node[0] === 'for' && node.length === 5) {
    const [, init, cond, step, body] = node
    let idx = null, recv = null, boundVar = null
    if (Array.isArray(cond) && cond[0] === '<' && typeof cond[1] === 'string') {
      const decls = new Map()
      collectDecls(init, decls)
      idx = cond[1]
      const start = decls.has(idx) ? intLiteralValue(decls.get(idx)) : null
      if (start == null || start < 0) idx = null
      let bound = cond[2]
      if (typeof bound === 'string') { boundVar = bound; bound = decls.get(bound) }
      recv = lengthRecv(bound)
    }
    if (idx && recv && idx !== recv && isUnitIncrement(step, idx)
        && !isReassigned(body, idx) && !isReassigned(body, recv)
        && (boundVar == null || !isReassigned(body, boundVar))
        && !redeclaresName(body, idx))
      collectBoundedArrIdx(body, recv, idx, set)
    // LITERAL-bound loop `for (let i = C≥0; i < B; i++)`: every `X[i]` read is in
    // [C, B) — provable against a receiver whose STATIC length ≥ B (typedIdxProven
    // consults litSet's recorded bound vs ctx.types.typedLen). Collected for every
    // receiver name in the body; per-receiver reassignment guarded like the
    // .length form. Two loops sharing (recv, i) names keep the MAX bound —
    // conservative for the proof.
    if (litSet && !(idx && recv)) {
      // re-derive idx with the same start guard (the .length branch nulled it only
      // when recv didn't resolve — recompute cleanly for the literal branch)
      if (Array.isArray(cond) && cond[0] === '<' && typeof cond[1] === 'string') {
        const decls = new Map()
        collectDecls(init, decls)
        const idx2 = cond[1]
        const start = decls.has(idx2) ? intLiteralValue(decls.get(idx2)) : null
        let bound = cond[2]
        if (typeof bound === 'string' && decls.has(bound)) bound = decls.get(bound)
        const B = intLiteralValue(bound)
        if (start != null && start >= 0 && B != null && B >= 0
            && isUnitIncrement(step, idx2) && !isReassigned(body, idx2) && !redeclaresName(body, idx2)) {
          const recvs = new Set()
          const collectRecvs = (n) => {
            if (!Array.isArray(n) || n[0] === '=>') return
            if (n[0] === '[]' && n.length === 3 && typeof n[1] === 'string' && n[2] === idx2) recvs.add(n[1])
            for (let k = 1; k < n.length; k++) collectRecvs(n[k])
          }
          collectRecvs(body)
          for (const r of recvs) {
            if (r === idx2 || isReassigned(body, r)) continue
            const key = r + '\x00' + idx2
            const prev = litSet.get(key)
            litSet.set(key, prev == null ? B : Math.max(prev, B))
          }
        }
      }
    }
  }
  for (let k = 1; k < node.length; k++) scanBoundedArrIdx(node[k], set, litSet)
}

/** Set of `"recv\x00idx"` keys for `recv[idx]` reads in the current function proven
 *  in-bounds. Memoised per body (separate slot from the charCodeAt proof). */
export function inBoundsArrIdx(ctx) {
  const body = ctx.func?.body
  if (!Array.isArray(body)) return NO_BOUNDED_CC
  if (ctx.func._aiBody === body) return ctx.func.aiInBounds
  const set = new Set()
  const litSet = new Map()
  scanBoundedArrIdx(body, set, litSet)
  ctx.func.aiInBounds = set
  ctx.func.aiLitBounds = litSet
  ctx.func._aiBody = body
  return set
}

/** Map of `"recv\x00idx"` → max literal loop bound for `recv[idx]` reads under
 *  `for (let i = C≥0; i < LIT; i++)` — proven in-bounds iff LIT ≤ the receiver's
 *  static length (typedIdxProven). Memoised with inBoundsArrIdx. */
export function litBoundArrIdx(ctx) {
  inBoundsArrIdx(ctx)
  return ctx.func?.aiLitBounds || NO_LIT_BOUNDS
}
const NO_LIT_BOUNDS = new Map()

// === Static interval proof (typedIdxProven class 5) ===
// A tiny abstract interpreter over integer INTERVALS for const-bound loop nests —
// the conv2d/blur shape class: every dimension folds to a literal, every index is a
// chain of decls over ivs (`const irow = inCh+(oy+ky)*W+ox`), and the clamp idiom
// (`if(xi<0)xi=0; else if(xi>=w)xi=w-1`) bounds the tap. No runtime guard can help
// there (nest-level recognizers must see the BARE nest), and none is needed — the
// whole computation is static. Accesses whose idx interval fits a STATIC receiver
// length are recorded proven; everything else stays checked/versioned.

const IP_LIM = 0x40000000   // endpoints beyond ±2^30 widen to unknown (i32 headroom)
const ipOk = (v) => v != null && v[0] >= -IP_LIM && v[1] <= IP_LIM

/** Walk one function body, recording proven `recv[idx]` keys into `out`.
 *  `lens(name)` → static element count or null. Soundness posture: `out` only ever
 *  ADDS proofs, so every unknown/bail direction is safe — the sharp edges are all
 *  in keeping `env` honest (kills before loops/switch, closure-captured writes,
 *  assignments embedded in expressions). */
function scanIntervalIdx(body, out, lens, ranges) {
  const env = new Map()   // name → [lo, hi] | null (unknown)
  // While-body fixpoint passes walk EXPLORATORILY — env may be transiently too
  // narrow, so proof/hull recording is suppressed until the stable final pass.
  let recording = true
  const symEnv = new Map()   // name → { h: symbolic hull, incNode } — wrap cursors vs mutable bounds
  // names written inside ANY closure in this body: a later call can change them at
  // any point — they never hold a trusted interval
  const closureWrites = new Set()
  const collectClosureWrites = (n, inClosure) => {
    if (!Array.isArray(n)) return
    const into = inClosure || n[0] === '=>'
    if (into && (ASSIGN_OPS.has(n[0]) || n[0] === '++' || n[0] === '--')) {
      if (typeof n[1] === 'string') closureWrites.add(n[1])
      // member writes (`o[i]=…`, `o.p=…`) rebind no name; only PATTERN targets do
      else if (Array.isArray(n[1]) && n[1][0] !== '[]' && n[1][0] !== '.' && n[1][0] !== '?.')
        collectNames(n[1], closureWrites)
    }
    for (let k = 1; k < n.length; k++) collectClosureWrites(n[k], into)
  }
  const collectNames = (n, set) => {
    if (typeof n === 'string') { set.add(n); return }
    if (Array.isArray(n)) for (let k = 1; k < n.length; k++) collectNames(n[k], set)
  }
  collectClosureWrites(body, false)
  const activeFacts = new Map()   // name → [lo, hi] theorem stamped by a rewrite pass (peel)
  const setEnv = (name, v) => {
    if (closureWrites.has(name) || !ipOk(v)) v = null
    const f = activeFacts.get(name)
    if (f) v = v ? [Math.max(v[0], f[0]), Math.min(v[1], f[1])] : f
    env.set(name, v)
  }
  const constInt = (e) => {
    const n = intLiteralValue(e)
    if (n != null) return n
    if (typeof e === 'string' && !closureWrites.has(e)) {
      const ci = ctx.scope?.constInts?.get?.(e)
      if (ci != null && isI32(ci)) return ci
    }
    return null
  }
  const ARITH = new Set(['+', '-', '*', '<<', '>>', '>>>', '&', '%', '|'])
  const ev = (e) => {
    const n = constInt(e)
    if (n != null) return [n, n]
    if (typeof e === 'string') return closureWrites.has(e) ? null : env.get(e) ?? null
    if (!Array.isArray(e)) return null
    const [op, x, y] = e
    // a NARROW typed load is range-bound by its element width (`table[in[j]]` — a
    // Uint8Array read is [0,255] wherever j lands; even an unproven-idx read's
    // undefined coerces through ToInt32 to 0, inside every narrow range)
    if (op === '[]' && e.length === 3 && typeof x === 'string') {
      visit(e)   // record the access's own proof attempt
      const r = NARROW_ELEM_RANGE[ctx.types.typedElem?.get(x)]
      return r ?? null
    }
    // `X.length` of a typed receiver with a known static length — the length-
    // identity atom: `const n = a.length` binds a singleton, `(a.length-1)>>1`
    // style index math evaluates exactly. Typed lengths are fixed for the
    // binding's lifetime (the tracker drops the entry on any rebinding).
    if ((op === '.' || op === '?.') && e.length === 3 && typeof x === 'string' && e[2] === 'length') {
      const L = lens(x)
      if (L != null) return [L, L]
    }
    if (e.length === 2 && op === '()') return ev(x)   // grouping, not a call
    if (e.length === 2 && (op === '-' || op === 'u-')) { const v = ev(x); return ipOk(v) && v ? [-v[1], -v[0]] : null }
    if (op === '?:' && e.length === 4) {   // join of both arms, each under its refinement
      visit(x)
      const rT = refine(x, false), rE = refine(x, true)
      const sT = rT ? env.get(rT[0]) : null
      if (rT) env.set(rT[0], rT[1])
      const a = ev(e[2])
      if (rT) env.set(rT[0], sT)
      const sE = rE ? env.get(rE[0]) : null
      if (rE) env.set(rE[0], rE[1])
      const b = ev(e[3])
      if (rE) env.set(rE[0], sE)
      return a && b ? [Math.min(a[0], b[0]), Math.max(a[1], b[1])] : null
    }
    // any non-arithmetic node (call, assignment, ternary, indexing…) routes through
    // visit so its env effects and access proofs are processed, value unknown
    if (e.length !== 3 || !ARITH.has(op)) { visit(e); return null }
    // `x|0` — ToInt32 is identity on an in-range interval
    if (op === '|' && intLiteralValue(y) === 0) { const v = ev(x); return ipOk(v) ? v : null }
    const A = ev(x), B = ev(y)
    if (!A || !B) {
      // a const mask bounds one-sidedly even when the other side is unknown
      if (op === '&') {
        const m = intLiteralValue(x) ?? intLiteralValue(y)
        if (m != null && m >= 0) return [0, m]
      }
      return null
    }
    let r = null
    if (op === '+') r = [A[0] + B[0], A[1] + B[1]]
    else if (op === '-') r = [A[0] - B[1], A[1] - B[0]]
    else if (op === '*') {
      const p = [A[0] * B[0], A[0] * B[1], A[1] * B[0], A[1] * B[1]]
      r = [Math.min(...p), Math.max(...p)]
    }
    else if (op === '<<' && B[0] === B[1] && B[0] >= 0 && B[0] <= 20) r = [A[0] * 2 ** B[0], A[1] * 2 ** B[0]]
    else if (op === '>>' && B[0] === B[1] && B[0] >= 0 && B[0] <= 31) r = [A[0] >> B[0], A[1] >> B[0]]
    else if (op === '>>>' && B[0] === B[1] && B[0] >= 0 && A[0] >= 0) r = [A[0] >>> B[0], A[1] >>> B[0]]
    else if (op === '&' && B[0] === B[1] && B[0] >= 0) r = [0, B[0]]
    else if (op === '%' && B[0] === B[1] && B[0] > 0 && A[0] >= 0) r = [0, Math.min(A[1], B[0] - 1)]
    return ipOk(r) ? r : null
  }
  // condition refinement for if-arms: `name < K` / `name >= K` … over a known name.
  // The lhs also admits the AFFINE form `name ± c` (`inl_i + 3 <= N` — the strided
  // codec cursors): the comparison re-biases to `name OP K∓c`. The rhs admits any
  // ACCESS-FREE expression the evaluator folds to a singleton (`src.length | 0`).
  const pureExpr = (e) => {
    if (!Array.isArray(e)) return true
    if (e[0] === '[]' || e[0] === '()' || e[0] === 'new' || e[0] === '?:' || e[0] === '=' || ASSIGN_OPS.has(e[0])) return false
    for (let k = 1; k < e.length; k++) if (!pureExpr(e[k])) return false
    return true
  }
  const refine = (c, negate) => {
    if (!Array.isArray(c) || c.length !== 3) return null
    let [op, l, r] = c
    // rhs: an int literal/module const, a body-known interval (`xi >= ww`, or a
    // RANGE-valued name — `child < end` inside the extract loop, where end is
    // the enclosing downward iv: the sound bound is the range's op-side
    // endpoint, hi for </<=, lo for >/>=), or a folded access-free expression
    const rE = typeof r === 'string' ? env.get(r) : null
    let rLo = constInt(r), rHi = rLo
    if (rLo == null && rE) { rLo = rE[0]; rHi = rE[1] }
    if (rLo == null && Array.isArray(r) && pureExpr(r)) {
      const rr = ev(r)
      if (rr) { rLo = rr[0]; rHi = rr[1] }
    }
    if (rLo == null) return null
    if (Array.isArray(l) && l.length === 3 && (l[0] === '+' || l[0] === '-')) {
      const cR = intLiteralValue(l[2]), cL = intLiteralValue(l[1])
      if (typeof l[1] === 'string' && cR != null) { rLo = l[0] === '+' ? rLo - cR : rLo + cR; rHi = l[0] === '+' ? rHi - cR : rHi + cR; l = l[1] }
      else if (l[0] === '+' && typeof l[2] === 'string' && cL != null) { rLo = rLo - cL; rHi = rHi - cL; l = l[2] }
    }
    if (typeof l !== 'string') return null
    const v = env.get(l)
    if (!v) return null
    if (negate) op = op === '<' ? '>=' : op === '<=' ? '>' : op === '>' ? '<=' : op === '>=' ? '<'
      : op === '===' ? '!==' : op === '!==' ? '===' : null
    if (op === '<') return [l, [v[0], Math.min(v[1], rHi - 1)]]
    if (op === '<=') return [l, [v[0], Math.min(v[1], rHi)]]
    if (op === '>') return [l, [Math.max(v[0], rLo + 1), v[1]]]
    if (op === '>=') return [l, [Math.max(v[0], rLo), v[1]]]
    if (op === '===') return [l, [Math.max(v[0], rLo), Math.min(v[1], rHi)]]
    // ≠K tightens only at an ENDPOINT (interior point removal keeps the hull) —
    // exactly the toroidal-wrap ternary (`y === 0 ? h-1 : y-1`); singleton rhs only
    if (op === '!==' && rLo === rHi) return [l, [v[0] === rLo ? rLo + 1 : v[0], v[1] === rLo ? rLo - 1 : v[1]]]
    return null
  }
  // every conjunct of an `&&` chain holds where the whole condition held
  const refineAll = (c2) => Array.isArray(c2) && c2[0] === '&&'
    ? [...refineAll(c2[1]), ...refineAll(c2[2])]
    : (() => { const r = refine(c2, false); return r ? [r] : [] })()
  const killAssigned = (n) => {
    if (!Array.isArray(n)) return   // descend into closures too — capture-writes stay dead
    if (ASSIGN_OPS.has(n[0]) || n[0] === '++' || n[0] === '--') {
      if (typeof n[1] === 'string') env.set(n[1], null)
      else if (Array.isArray(n[1]) && n[1][0] !== '[]' && n[1][0] !== '.' && n[1][0] !== '?.') {
        const s = new Set(); collectNames(n[1], s); for (const x of s) env.set(x, null)
      }
    }
    for (let k = 1; k < n.length; k++) killAssigned(n[k])
  }
  // A canonical-iv range `iv ∈ [entry, B−1]` is a body-independent THEOREM only
  // while B is invariant: a body-written bound (`while (i < n) { …; n = 12 }`)
  // admits iv past the entry bound — the seed then "proved" raw OOB reads
  // (dist-reproduced on every canonical loop form). Every name the bound reads
  // must be unwritten AND undeclared in the body.
  const boundInvariant = (bexpr, body) => {
    if (bexpr == null) return false
    const s = new Set(); collectNames(bexpr, s)
    for (const bn of s) if (isReassigned(body, bn) || redeclaresName(body, bn)) return false
    return true
  }
  // ABRUPT EDGES. A `break` reaches the loop's exit — and a `continue` its back
  // edge — carrying the flow state AT the statement, which the fall-through walk
  // never sees (`if (c) { x = BIG; break } x = 0` exits with x = BIG). Loop walks
  // push a frame; break/continue snapshot env into it; exits/joins hull the
  // snapshots in. Bare break binds to the innermost frame (a `switch` frame
  // swallows it); bare continue to the innermost LOOP frame; labeled forms can
  // cross any number of frames, so they conservatively feed every open one.
  const loopStack = []   // { kind: 'loop' | 'switch', breaks: [], continues: [] }
  const hullInto = (snap) => {
    for (const k2 of new Set([...env.keys(), ...snap.keys()])) {
      const a = env.get(k2), b = snap.get(k2)
      env.set(k2, a && b ? [Math.min(a[0], b[0]), Math.max(a[1], b[1])] : null)
    }
  }
  // LOOP BODY FIXPOINT (2-round widening). Pass A walks from the ENTRY state
  // (∩ cond) and yields the back-edge state; the JOIN hulls entry with it (a
  // name known on only one edge → null); pass B re-walks from join∩cond and
  // any name whose back-edge escapes its join widens to unknown; the FINAL
  // pass walks the stable env with proof recording ON, leaving env at the
  // loop invariant. `seedFn` re-applies body-independent theorems (canonical
  // iv ranges, wrap cursors) each pass; `condNode` refines at body top,
  // descending `&&` (both conjuncts hold when the loop is entered).
  const loopFixpoint = (seedFn, walkFn, condNode, exitBodyEnd = false) => {
    const applyCond = () => { if (condNode != null) for (const r of refineAll(condNode)) if (!closureWrites.has(r[0])) env.set(r[0], r[1]) }
    const restore = (m) => { env.clear(); for (const [k2, v2] of m) env.set(k2, v2) }
    // every pass walks under a loop frame: continue edges are back-edges too,
    // so their snapshots hull into the pass-end state before any join/verify
    const walkPass = () => {
      const lc = { kind: 'loop', breaks: [], continues: [] }
      loopStack.push(lc); walkFn(); loopStack.pop()
      for (const s of lc.continues) hullInto(s)
      return lc
    }
    const entryEnv = new Map(env)
    const prevRec = recording
    recording = false
    seedFn(); applyCond(); walkPass()                   // pass A: discovery
    // WIDENING JOIN: an escaping bound widens to the i32 extreme instead of the
    // one-step hull — the pass-B seed's cond refinement then clamps it to the
    // loop bound. This is what turns `for (; x + 3 <= N; x += 3)` into the
    // invariant x ∈ [0, N−3] (the strided-accumulator class) rather than
    // null: hull(entry, one step) can never contain step №2, so without the
    // widen every advancing cursor escapes to unknown.
    const joined = new Map()
    for (const k2 of new Set([...entryEnv.keys(), ...env.keys()])) {
      const a = entryEnv.get(k2), b = env.get(k2)
      joined.set(k2, a && b
        ? [b[0] < a[0] ? -IP_LIM : Math.min(a[0], b[0]), b[1] > a[1] ? IP_LIM : Math.max(a[1], b[1])]
        : null)
    }
    restore(joined); seedFn(); applyCond(); walkPass()  // pass B: verify
    // the back edge re-evaluates the condition before re-entering the body, so
    // the state to verify against the invariant is walk-end ∩ cond
    applyCond()
    for (const [k2, v2] of env) {
      const j = joined.get(k2)
      if (!(v2 && j && v2[0] >= j[0] && v2[1] <= j[1])) joined.set(k2, null)
    }
    // NARROWING (≤2 decreasing passes): the widened invariant is sound but
    // loose — a name with no cond conjunct to re-clamp it sits at ±IP_LIM even
    // when the loop's true range is finite (`i = child` copy chains: i only
    // ever receives root- or cond-clamped child-values, so hull(entry,
    // end-state) is the real invariant). Each pass recomputes the hull from
    // the stable state — every reachable back-edge state ⊆ F(joined ∩ cond),
    // so hull(entry, F(joined ∩ cond)) contains them all and only TIGHTENS
    // (meet with the previous invariant keeps the sequence decreasing).
    for (let np = 0; np < 2; np++) {
      restore(joined); seedFn(); applyCond(); walkPass(); applyCond()
      let changed = false
      for (const [k2, j] of joined) {
        const a = entryEnv.get(k2), b = env.get(k2)
        if (!j || !a || !b) continue
        const nl = Math.max(j[0], Math.min(a[0], b[0])), nh = Math.min(j[1], Math.max(a[1], b[1]))
        if (nl > j[0] || nh < j[1]) { joined.set(k2, [nl, nh]); changed = true }
      }
      if (!changed) break
    }
    recording = prevRec
    restore(joined); seedFn(); applyCond()
    const lcF = walkPass()                              // FINAL: record on the stable env
    // exit state:
    //  - default: the invariant (joined) — sound for any trip count.
    //  - exitBodyEnd (caller proved ≥1 trip): the final walk's BODY-END state —
    //    tighter for defined-every-iteration names (an inlined preamble's
    //    `inl_i = 0` keeps [0,0] where the join would null it), and sound
    //    because the walk ran from the verified invariant, so its end state
    //    covers every real last-iteration state. Zero-trip loops must NOT use
    //    it: their real exit is the ENTRY state, which body-end doesn't cover.
    if (!exitBodyEnd) restore(joined)
    // ∪ break-edge states (a break bypasses the loop condition and reaches the
    // exit mid-body; the caller's tighter iv/wrap exit forms stay sound — each
    // is an every-point invariant that covers break states)
    for (const s of lcF.breaks) hullInto(s)
  }
  const visit = (n) => {
    if (!Array.isArray(n) || n[0] === '=>') return
    if (n._rangeFacts) return visitWithFacts(n)
    const op = n[0]
    if (op === '[]' && n.length === 3 && typeof n[1] === 'string') {
      const idxV = ev(n[2])
      if (!recording) return   // exploratory fixpoint pass: env effects only
      const L = lens(n[1])
      if (typeof process !== 'undefined' && process.env.JZ_DBG_IP) console.error('IPW', n[1], JSON.stringify(n[2]).slice(0,50), JSON.stringify(idxV), 'len', L)
      if (L != null && idxV && idxV[0] >= 0 && idxV[1] < L) out.add(idxKey(n[1], n[2]))
      // a bounded idx against an UNKNOWN length is half a proof — export the hull
      // (joined over every sighting of this key) for the versioning guard to close
      // with a runtime `hi < len` conjunct (the wrap-cursor + dynamic-table class)
      else if (idxV && idxV[0] >= 0 && ranges) {
        const k = idxKey(n[1], n[2]), prev = ranges.get(k)
        ranges.set(k, prev ? [Math.min(prev[0], idxV[0]), Math.max(prev[1], idxV[1])] : idxV)
      }
      // symbolic wrap hull (`seq[si]` with si ∈ [0, SEQLEN-1], SEQLEN mutable):
      // exported only while the cursor's pre-increment window is open; a numeric
      // or conflicting prior sighting voids the key (one symbolic form per key)
      else if (idxV == null && typeof n[2] === 'string' && symEnv.has(n[2]) && ranges) {
        const k = idxKey(n[1], n[2]), h = symEnv.get(n[2]).h, prev = ranges.get(k)
        if (prev == null) ranges.set(k, h)
        else if (prev.hiName !== h.hiName || prev.hiBias !== h.hiBias) ranges.set(k, null)
      }
      return
    }
    if (op === 'let' || op === 'const') {
      for (let k = 1; k < n.length; k++) {
        const d = n[k]
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') setEnv(d[1], ev(d[2]))
        else if (typeof d === 'string') env.set(d, null)
        else if (Array.isArray(d)) { visit(d); const s = new Set(); collectNames(d[0] === '=' ? d[1] : d, s); for (const x of s) env.set(x, null) }
      }
      return
    }
    if (op === '=' && typeof n[1] === 'string') {
      if (symEnv.get(n[1])?.incNode === n) symEnv.delete(n[1])   // past the increment: window closed
      setEnv(n[1], ev(n[2]))
      return
    }
    if (ASSIGN_OPS.has(op) || op === '++' || op === '--') {
      if (typeof n[1] === 'string' && symEnv.get(n[1])?.incNode === n) symEnv.delete(n[1])
      for (let k = 2; k < n.length; k++) visit(n[k])
      if (typeof n[1] === 'string') {
        // `x += K` / `x -= K` / `x++` / `x--` transfer exactly — a strided
        // accumulator keeps a computable back-edge for the loop fixpoint
        // (cond-clamped by the widening join); anything else is unknown
        const cur = env.get(n[1])
        let nv = null
        if (cur) {
          if (op === '++') nv = [cur[0] + 1, cur[1] + 1]
          else if (op === '--') nv = [cur[0] - 1, cur[1] - 1]
          else if (op === '+=' || op === '-=') {
            const d = ev(n[2])
            if (d) nv = op === '+=' ? [cur[0] + d[0], cur[1] + d[1]] : [cur[0] - d[1], cur[1] - d[0]]
          }
        }
        setEnv(n[1], nv)
      }
      else {
        visit(n[1])   // records the member-write access proof (`out[idx] = …`)
        if (Array.isArray(n[1]) && n[1][0] !== '[]' && n[1][0] !== '.' && n[1][0] !== '?.') {
          const s = new Set(); collectNames(n[1], s); for (const x of s) env.set(x, null)
        }
      }
      return
    }
    if (op === 'break' || op === 'continue') {
      if (typeof n[1] === 'string') {   // labeled: may cross frames — feed every open one
        for (const fr of loopStack) if (fr.kind === 'loop') { fr.breaks.push(new Map(env)); fr.continues.push(new Map(env)) }
      }
      else if (op === 'break') {
        const fr = loopStack[loopStack.length - 1]
        if (fr && fr.kind === 'loop') fr.breaks.push(new Map(env))
      }
      else {
        const fr = loopStack.findLast(f => f.kind === 'loop')
        if (fr) fr.continues.push(new Map(env))
      }
      return
    }
    if (op === 'for' && n.length === 5) {
      const [, init, cond, step, lbody] = n
      visit(init)
      // canonical literal-interval iv: `for (iv = A; iv </<= B; iv++)` — or the
      // DOWNWARD twin `for (iv = A; iv >/>= B; iv--)` (heapify roots, reverse
      // scans) — A/B singleton through the full evaluator
      let iv = null, range = null
      const down = Array.isArray(cond) && (cond[0] === '>' || cond[0] === '>=')
      if (Array.isArray(cond) && (cond[0] === '<' || cond[0] === '<=' || down) && typeof cond[1] === 'string') {
        const decls = new Map(); collectDecls(init, decls)
        // start/bound through the full evaluator: function-local consts (`x < ww`)
        // and computed starts (`k = -rr`) resolve as singleton intervals
        const dv = decls.get(cond[1])
        const As = dv != null ? ev(dv) : null
        const Bs = cond[2] != null ? ev(cond[2]) : null
        const A = As && As[0] === As[1] ? As[0] : null
        const B = Bs && Bs[0] === Bs[1] ? Bs[0] : null
        if (A != null && B != null && !isReassigned(lbody, cond[1]) && !redeclaresName(lbody, cond[1])
            && (cond[2] == null || boundInvariant(cond[2], lbody))
            && (down ? isUnitDecrement(step, cond[1]) : isUnitIncrement(step, cond[1]))) {
          iv = cond[1]
          range = down ? [cond[0] === '>' ? B + 1 : B, A] : [A, cond[0] === '<' ? B - 1 : B]
        }
      }
      // Body fixpoint (same engine as `while` below): the canonical-iv range is
      // a body-independent theorem re-seeded each pass; everything else
      // discovers its invariant. This is what proves heapsort's `child` chains
      // (`child = 2*i+1; while-ish descend`) and medianUs's `samples[mid]`.
      // Exit state: a canonical iv with a non-empty LITERAL range proves ≥1
      // trip, so the tighter body-end exit is sound (post-loop peel tails read
      // `src[inl_i+…]` off exactly that state); anything else takes the joined
      // invariant (zero-trip exit = entry state ⊆ joined).
      const seeded = iv && range[0] <= range[1] && !closureWrites.has(iv)
      const seeds = () => {
        if (seeded) env.set(iv, range)
        else if (iv) env.set(iv, null)
      }
      loopFixpoint(seeds,
        () => { if (cond != null) visit(cond); visit(lbody); if (step != null) visit(step) },
        cond, seeded)
      if (iv) env.set(iv, null)   // iv holds the exit value after the loop
      return
    }
    if (op === 'while') {
      // `while (iv < B)` with a known iv at entry, monotone +1 advances, and a
      // bounded B: inside the body iv ∈ [entryLo, B_hi-1] (cond holds at body top);
      // at exit iv ∈ [min(entryLo, B_lo), max(entryHi, B_hi)] — the peel's split
      // loops chain through this. Anything else: kill and walk.
      const [, c, wbody] = n
      let iv = null, entry = null, brange = null
      if (Array.isArray(c) && c[0] === '<' && typeof c[1] === 'string' && wbody != null) {
        entry = env.get(c[1]); brange = c[2] != null ? ev(c[2]) : null
        if (entry && brange && ivMonotoneInc(wbody, c[1]) && !redeclaresName(wbody, c[1])
            && boundInvariant(c[2], wbody)) iv = c[1]
      }
      // WRAPPING-CURSOR invariant (`si = si + K; if (si >= C) si = 0` — the ring
      // index of table-driven maps): the pair is self-closing on [0, C-1], so an
      // entry inside that range keeps the name there for the WHOLE loop. Seeded
      // before the kill; the pair must be the name's only writes in this loop.
      const wraps = [], symWraps = []
      if (wbody != null) {
        const stmts = Array.isArray(wbody) && (wbody[0] === ';' || wbody[0] === '{}') ? wbody : [';', wbody]
        // one-statement MASK cursor `nm = (nm + K) & M` (the ulam direction ring):
        // self-closing on [0, M] for any entry inside it — no reset pair needed
        for (let k = 1; k < stmts.length; k++) {
          const a2 = stmts[k]
          if (!(Array.isArray(a2) && a2[0] === '=' && typeof a2[1] === 'string')) continue
          let rhs = a2[2]
          if (!(Array.isArray(rhs) && rhs[0] === '&' && rhs.length === 3)) continue
          const M = intLiteralValue(rhs[1]) ?? intLiteralValue(rhs[2])
          const inner = intLiteralValue(rhs[1]) != null ? rhs[2] : rhs[1]
          if (M == null || M < 0) continue
          const grp = Array.isArray(inner) && inner[0] === '()' && inner.length === 2 ? inner[1] : inner
          if (!(Array.isArray(grp) && grp[0] === '+' && (grp[1] === a2[1] || grp[2] === a2[1]))) continue
          const e0 = env.get(a2[1])
          if (!e0 || e0[0] < 0 || e0[1] > M) continue
          let writes = 0
          const cw = (x) => { if (!Array.isArray(x)) return
            if ((ASSIGN_OPS.has(x[0]) || x[0] === '++' || x[0] === '--') && x[1] === a2[1]) writes++
            for (let j = 1; j < x.length; j++) cw(x[j]) }
          cw(wbody)
          if (writes === 1) wraps.push([a2[1], [0, M]])
        }
        for (let k = 1; k < stmts.length - 1; k++) {
          const a2 = stmts[k], b2 = stmts[k + 1]
          let nm = null, K = null
          if (Array.isArray(a2) && a2[0] === '=' && typeof a2[1] === 'string'
              && Array.isArray(a2[2]) && a2[2][0] === '+' && a2[2][1] === a2[1]) { nm = a2[1]; K = intLiteralValue(a2[2][2]) }
          else if (Array.isArray(a2) && a2[0] === '+=' && typeof a2[1] === 'string') { nm = a2[1]; K = intLiteralValue(a2[2]) }
          else if (Array.isArray(a2) && a2[0] === '++' && typeof a2[1] === 'string') { nm = a2[1]; K = 1 }
          if (nm == null || K == null || K < 1) continue
          if (!(Array.isArray(b2) && b2[0] === 'if' && b2.length === 3
              && Array.isArray(b2[1]) && b2[1][0] === '>=' && b2[1][1] === nm
              && Array.isArray(b2[2]) && b2[2][0] === '=' && b2[2][1] === nm && intLiteralValue(b2[2][2]) === 0)) continue
          const C = constInt(b2[1][2])
          const Cname = C == null && typeof b2[1][2] === 'string' ? b2[1][2] : null
          if ((C == null || C < 1) && Cname == null) continue
          const e0 = env.get(nm)
          if (!e0 || e0[0] < 0 || (C != null && e0[1] > C - 1)) continue
          // the pair must be the only writes (2 exact: the add and the reset)
          let writes = 0
          const cw = (x) => { if (!Array.isArray(x)) return
            if ((ASSIGN_OPS.has(x[0]) || x[0] === '++' || x[0] === '--') && x[1] === nm) writes++
            for (let j = 1; j < x.length; j++) cw(x[j]) }
          cw(wbody)
          if (writes !== 2) continue
          if (C != null) wraps.push([nm, [0, C - 1]])
          // symbolic bound (`let SEQLEN = 5` — mutable): the invariant is
          // si ∈ [0, C-1] RELATIVE to C's runtime value — recorded as a symbolic
          // hull for reads BEFORE the increment (the versioning guard closes it
          // with `C ≥ entryHi+1 ∧ C ≤ len`); no numeric env seeding is possible
          else symWraps.push([nm, { lo: 0, hiName: Cname, hiBias: -1, entryHi: e0[1] }, a2])
        }
      }
      // Body fixpoint (loopFixpoint below): the monotone-iv/wrap/symWrap seeds
      // are theorems independent of the body, re-applied each pass; everything
      // else discovers its invariant. Bounds heapsort's `while (child < n)`
      // chains, medianUs's downward insertion scan, and interpreter
      // `while (pc < N)` dispatch — shapes the single-kill walk lost entirely.
      const seeds = () => {
        if (iv) env.set(iv, [entry[0], brange[1] - 1])
        for (const [nm, r] of wraps) if (!closureWrites.has(nm)) env.set(nm, r)
        for (const [nm, h, incNode] of symWraps) if (!closureWrites.has(nm)) symEnv.set(nm, { h, incNode })
      }
      loopFixpoint(seeds, () => { visit(c); for (let k = 2; k < n.length; k++) visit(n[k]) }, c)
      // exit state: the invariant (already in env) hulls entry ∪ back-edges;
      // iv/wraps publish their tighter exit forms
      if (iv) env.set(iv, [Math.min(entry[0], brange[0]), Math.max(entry[1], brange[1])])
      for (const [nm, r] of wraps) if (!closureWrites.has(nm)) env.set(nm, r)   // holds at exit too
      for (const [nm] of symWraps) symEnv.delete(nm)
      return
    }
    if (op === 'do' || op === 'for-of' || op === 'for-in' || op === 'label'
        || op === 'switch' || op === 'try' || op === 'catch' || op === 'finally') {
      // ('try' is the parser shape; prepare lowers it to 'catch'/'finally' nodes,
      // which is what this walk actually receives)
      killAssigned(n)   // unknown trip count / branch selection: no interval survives entry
      // Each child walks from the killed entry state and the construct EXITS at
      // it: case selection enters any child directly, an exception can leave a
      // `try` child mid-statement, a `do` body can break out — so neither a
      // sibling's nor the last child's flow state is the construct's. In-child
      // straight-line proofs (defined-before-use chains) still record.
      const killed = new Map(env)
      const fr = op === 'switch' ? { kind: 'switch', breaks: [], continues: [] }
        : op === 'do' || op === 'for-of' || op === 'for-in' ? { kind: 'loop', breaks: [], continues: [] }
        : null   // label/try: transparent — abrupt edges bind to enclosing frames
      if (fr) loopStack.push(fr)
      for (let k = 1; k < n.length; k++) {
        visit(n[k])
        env.clear(); for (const [k2, v2] of killed) env.set(k2, v2)
      }
      if (fr) loopStack.pop()
      return
    }
    if (op === 'if') {
      const [, c, thenB, elseB] = n
      visit(c)
      const save = new Map(env)
      // every `&&` conjunct holds on the then path (`if (child+1 < n && a[child] <
      // a[child+1]) child++` — the ++ under BOTH bounds)
      for (const rT of refineAll(c)) if (!closureWrites.has(rT[0])) env.set(rT[0], rT[1])
      visit(thenB)
      const afterThen = new Map(env)
      env.clear(); for (const [k2, v2] of save) env.set(k2, v2)
      // the fall-through state refines by ¬cond whether or not an else arm exists
      // (`if (xi >= 64) xi = 63` leaves xi < 64 on the other path)
      const rE = refine(c, true)
      if (rE && !closureWrites.has(rE[0])) env.set(rE[0], rE[1])
      if (elseB !== undefined) visit(elseB)
      // join: both arms merge (min lo, max hi); known-in-one-arm-only joins unknown
      const keys = new Set([...afterThen.keys(), ...env.keys()])
      for (const k2 of keys) {
        const a = afterThen.get(k2), b = env.get(k2)
        env.set(k2, a && b ? [Math.min(a[0], b[0]), Math.max(a[1], b[1])] : null)
      }
      return
    }
    // Short-circuit operands evaluate under the left side's verdict: `&&`'s rhs
    // runs only where lhs HELD (`child + 1 < n && a[child] < a[child + 1]` — the
    // lookahead read is bounds-guarded by its sibling conjunct), `||`'s rhs only
    // where lhs FAILED. Reads inside the rhs prove under that refinement; writes
    // there ran conditionally, so the exit state joins both possibilities.
    if ((op === '&&' || op === '||') && n.length === 3) {
      visit(n[1])
      const save = new Map(env)
      if (op === '&&') { for (const r of refineAll(n[1])) if (!closureWrites.has(r[0])) env.set(r[0], r[1]) }
      else { const r = refine(n[1], true); if (r && !closureWrites.has(r[0])) env.set(r[0], r[1]) }
      visit(n[2])
      const after = new Map(env)
      env.clear(); for (const [k2, v2] of save) env.set(k2, v2)
      for (const k2 of new Set([...after.keys(), ...env.keys()])) {
        const a = after.get(k2), b = env.get(k2)
        env.set(k2, a && b ? [Math.min(a[0], b[0]), Math.max(a[1], b[1])] : null)
      }
      return
    }
    if (op === '()' && n.length === 2) { visit(n[1]); return }   // grouping, not a call
    if (op === '()' || op === 'new') {   // a call may reassign module globals
      for (let k = 1; k < n.length; k++) visit(n[k])
      for (const [k2] of env) if (!closureWrites.has(k2) && (ctx.scope?.globalTypes?.has?.(k2) || ctx.types?.typedElem?.has?.(k2))) env.set(k2, null)
      return
    }
    for (let k = 1; k < n.length; k++) visit(n[k])
  }
  // the function root is itself an `=>` node — enter its body; only NESTED closures skip
  // A rewrite pass (peelClampedStencil) stamps `_rangeFacts` — theorems about names
  // inside the stamped subtree (`ci ∈ [0, bound-1]`, established by ITS soundness
  // argument). They intersect every env write of that name while the subtree walks.
  const visitWithFacts = (n) => {
    const popped = []
    for (const [name, boundName] of n._rangeFacts) {
      const B = boundName != null ? ev(boundName) : null
      if (B && !activeFacts.has(name)) { activeFacts.set(name, [0, B[1] - 1]); popped.push(name) }
    }
    const facts = n._rangeFacts
    n._rangeFacts = null   // re-entry brake (the self-host subset has no delete)
    visit(n)
    n._rangeFacts = facts
    for (const name of popped) activeFacts.delete(name)
  }
  visit(Array.isArray(body) && body[0] === '=>' ? body[body.length - 1] : body)
}

/** Every write to `iv` in `node` is a strictly-positive unit step (++iv / iv+=1 /
 *  iv=(iv+1)|0 / iv=iv+1) — the while-iv interval model requires monotone advance. */
function ivMonotoneInc(node, iv) {
  if (!Array.isArray(node)) return true
  if ((node[0] === '++' || node[0] === '--') && node[1] === iv) return node[0] === '++'
  if (ASSIGN_OPS.has(node[0]) && node[1] === iv) {
    if (node[0] === '+=' && intLiteralValue(node[2]) >= 1) return true
    if (node[0] === '=') {
      let rhs = node[2]
      if (Array.isArray(rhs) && rhs[0] === '|' && intLiteralValue(rhs[2]) === 0) rhs = rhs[1]
      if (Array.isArray(rhs) && rhs[0] === '+' && rhs.length === 3
          && ((rhs[1] === iv && intLiteralValue(rhs[2]) >= 1) || (rhs[2] === iv && intLiteralValue(rhs[1]) >= 1))) return true
    }
    return false
  }
  for (let k = 1; k < node.length; k++) if (!ivMonotoneInc(node[k], iv)) return false
  return true
}
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '**='])
const NARROW_ELEM_RANGE = {
  'new.Int8Array': [-128, 127], 'new.Uint8Array': [0, 255], 'new.Uint8ClampedArray': [0, 255],
  'new.Int16Array': [-32768, 32767], 'new.Uint16Array': [0, 65535],
  'new.Int8Array.view': [-128, 127], 'new.Uint8Array.view': [0, 255], 'new.Uint8ClampedArray.view': [0, 255],
  'new.Int16Array.view': [-32768, 32767], 'new.Uint16Array.view': [0, 65535],
}

/** Memoized per-function set of interval-proven `recv[idx]` keys. */
export function intervalProvenIdx(ctx) {
  const body = ctx.func?.body
  if (!Array.isArray(body)) return NO_INTERVAL_PROVEN
  if (ctx.func._ipBody === body) return ctx.func.ipProven
  const out = new Set(), ranges = new Map()
  const lens = (name) => ctx.types.typedLen?.get(name) ?? ctx.scope?.globalTypedLen?.get(name) ?? null
  scanIntervalIdx(body, out, lens, ranges)
  ctx.func.ipProven = out
  ctx.func.ipRanges = ranges
  ctx.func._ipBody = body
  return out
}

/** Idx-interval hulls the walk computed but could not discharge (receiver length
 *  unknown) — the versioning guard closes them with a runtime `hi < len`. */
export function intervalIdxRanges(ctx) {
  intervalProvenIdx(ctx)
  return ctx.func?.ipRanges || NO_INTERVAL_RANGES
}
const NO_INTERVAL_RANGES = new Map()
const NO_INTERVAL_PROVEN = new Set()

// === Loop unroll / AST transforms (emit + plan) ===

export const MAX_SMALL_FOR_UNROLL = 8
export const MAX_NESTED_FOR_UNROLL = 64

export function containsNestedClosure(body) {
  if (!Array.isArray(body)) return false
  if (body[0] === '=>') return true
  for (let i = 1; i < body.length; i++) if (containsNestedClosure(body[i])) return true
  return false
}

export function containsNestedLoop(body) {
  if (!Array.isArray(body)) return false
  const op = body[0]
  if (op === 'for' || op === 'while' || op === 'do') return true
  if (op === '=>') return false
  for (let i = 1; i < body.length; i++) if (containsNestedLoop(body[i])) return true
  return false
}

export function nestedSmallLoopBudget(body) {
  if (!Array.isArray(body)) return 1
  if (body[0] === '=>') return 1
  if (body[0] === 'for') {
    const [, init, cond, step, loopBody] = body
    const n = smallConstForTripCount(init, cond, step)
    return n == null ? MAX_NESTED_FOR_UNROLL + 1 : n * nestedSmallLoopBudget(loopBody)
  }
  let max = 1
  for (let i = 1; i < body.length; i++) max = Math.max(max, nestedSmallLoopBudget(body[i]))
  return max
}

export function containsDeclOf(body, name) {
  if (!Array.isArray(body)) return false
  const op = body[0]
  if (op === '=>') return false
  if (op === 'let' || op === 'const') {
    for (let i = 1; i < body.length; i++) {
      const d = body[i]
      if (d === name) return true
      if (Array.isArray(d) && d[0] === '=' && d[1] === name) return true
    }
  }
  for (let i = 1; i < body.length; i++) if (containsDeclOf(body[i], name)) return true
  return false
}

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
    if (subst.has(node)) return clonePlain(subst.get(node))
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
  const rng = ctx.func?.ipRanges?.get(k)
  if (rng != null) ctx.func.ipRanges.set(idxKey(out[1], out[2]), rng)   // hulls survive substitution too
  const owner = ctx.types?.assumedBounds?.get(k)
  if (owner != null) ctx.types.assumedBounds.set(idxKey(out[1], out[2]), owner)
}

const clonePlain = node => Array.isArray(node) ? node.map(clonePlain) : node

export function containsKnownTypedArrayIndex(body) {
  if (!Array.isArray(body)) return false
  if (body[0] === '=>') return false
  if (body[0] === '[]' && typeof body[1] === 'string' && ctx.types.typedElem?.has(body[1])) return true
  for (let i = 1; i < body.length; i++) if (containsKnownTypedArrayIndex(body[i])) return true
  return false
}

/** Trip count for `for (let i=0; i<N; i++)` when structurally obvious, else null. */
export function smallConstForTripCount(init, cond, step, maxEnd = MAX_SMALL_FOR_UNROLL) {
  if (!Array.isArray(init) || init[0] !== 'let' || init.length !== 2) return null
  const decl = init[1]
  if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') return null
  const name = decl[1]
  const start = intLiteralValue(decl[2])
  if (start !== 0) return null
  if (!Array.isArray(cond) || cond[0] !== '<' || cond[1] !== name) return null
  const end = intLiteralValue(cond[2])
  if (end == null || end < 0 || end > maxEnd) return null
  const stepOk = Array.isArray(step) && (
    (step[0] === '++' && step[1] === name) ||
    (step[0] === '-' && Array.isArray(step[1]) && step[1][0] === '++' && step[1][1] === name && intLiteralValue(step[2]) === 1)
  )
  return stepOk ? end : null
}

/** Does `body` always exit via return/throw/break/continue? */
export function isTerminator(body) {
  if (!Array.isArray(body)) return false
  const op = body[0]
  if (op === 'return' || op === 'throw' || op === 'break' || op === 'continue') return true
  if (op === '{}' || op === ';') {
    for (let i = body.length - 1; i >= 1; i--) {
      const s = body[i]
      if (s == null) continue
      return isTerminator(s)
    }
    return false
  }
  return false
}

// Resolve a name's typed-array element ctor: in-progress local overlay (analyzeBody) →
// per-func map (post-analyze) → module-global registry. The global fallback matters during
// analyzeBody/narrow when the per-func map is null, so a read of a *global* typed array
// (`DX[i]` with `let DX = new Int32Array(...)` at module scope) resolves its element type
// instead of defaulting to f64. Guard against local shadows / dynamic rewrites (cf. kind.js).
const typedElemCtorOf = (name, locals) =>
  ctx.func.localTypedElemsOverlay?.get(name) ?? ctx.types.typedElem?.get(name)
    ?? (!locals?.has?.(name) && !ctx.types?.dynWriteVars?.has?.(name)
      ? ctx.scope?.globalTypedElem?.get(name) : undefined)

// An expression whose i32 value carries the unsigned [0, 2^32) magnitude (not a signed i32):
// `>>>`, an unsigned-result call, or a Uint32Array read (aux 5 — the only typed array whose
// element can exceed signed-i32 range). The +/-/*/% rules widen these to f64 so `U[i] + 1`
// near 2^32 doesn't wrap; bitwise/store consumers are ToInt32-exact and keep the i32 bits.
const isUnsignedI32Expr = (e, locals) => Array.isArray(e) && (
  e[0] === '>>>' ||
  (e[0] === '()' && typeof e[1] === 'string' && ctx.func.map?.get(e[1])?.sig?.unsignedResult === true) ||
  (e[0] === '[]' && typeof e[1] === 'string' && typedElemAux(typedElemCtorOf(e[1], locals)) === 5)
)

/**
 * Infer expression result type from AST (without emitting).
 * Used to determine local variable types before compilation.
 * Looks up `locals` first, then current-function params (for i32-specialized params).
 */
export function exprType(expr, locals) {
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
  if (op == null) return exprType(args[0], locals) // literal [, value]

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
  // localTypedElemsOverlay during analyzeBody; post-analyze passes read ctx.types.typedElem.
  if (op === '[]') {
    if (typeof args[0] === 'string') {
      // Resolve the element ctor across local overlay → per-func map → module-global registry
      // (the global fallback is why `DX[i]` on a module-scope Int32Array types as i32 instead of
      // f64-round-tripping integer accumulation like `ax = ax + DX[i]`). See typedElemCtorOf.
      const ctor = typedElemCtorOf(args[0], locals)
      if (ctor) {
        const aux = typedElemAux(ctor)
        // int family only — Float16Array shares code 3 with a flag; its elements are floats
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
  if (['&', '|', '^', '~', '<<', '>>'].includes(op))
    return valTypeOf(expr) === VAL.BIGINT ? 'f64' : 'i32'
  // Preserve i32 if both operands i32
  if (op === '+' || op === '-') {
    const ta = exprType(args[0], locals)
    const tb = args[1] != null ? exprType(args[1], locals) : ta // unary: inherit
    if (ta !== 'i32' || tb !== 'i32') return 'f64'
    // A uint32 operand ([0, 2^32)) makes the result exceed signed i32 range, so
    // emit widens to f64 (see emit.js `+`/`-`). exprType must agree — else
    // narrowing the result back to i32 would trunc_sat-saturate the f64 to INT32_MAX.
    if (isUnsignedI32Expr(args[0], locals) || (args[1] != null && isUnsignedI32Expr(args[1], locals))) return 'f64'
    return 'i32'
  }
  // `%` is i32 only when emit takes the i32.rem_s path: both operands i32, neither
  // unsigned, AND the divisor is a nonzero integer constant. A 0 or runtime divisor
  // yields NaN via f64rem (f64), so result-narrowing must NOT see i32 here — else a
  // NaN remainder gets i32.trunc_sat'd to 0. Mirrors the emit.js `%` guard exactly.
  if (op === '%') {
    const ta = exprType(args[0], locals), tb = exprType(args[1], locals)
    if (ta !== 'i32' || tb !== 'i32') return 'f64'
    if (isUnsignedI32Expr(args[0], locals) || isUnsignedI32Expr(args[1], locals)) return 'f64'
    const dv = staticValue(args[1])
    return (dv !== NO_VALUE && typeof dv === 'number' && dv !== 0 && Number.isInteger(dv)) ? 'i32' : 'f64'
  }
  // `*` — a JS multiply is an f64 operation; `i32.mul` reproduces it faithfully
  // only while the exact product is f64-exact. Stay i32 when both operands are
  // i32 *and* the product provably fits: a fully-static product checked
  // directly, otherwise a literal operand small enough that |literal|·2^31 ≤
  // 2^53 (mirrors emit.js `mulFitsI32` — keeps `i*4` i32, widens `h*16777619`).
  if (op === '*') {
    const ta = exprType(args[0], locals), tb = exprType(args[1], locals)
    if (ta !== 'i32' || tb !== 'i32') return 'f64'
    // uint32 operand: product can exceed i32; emit widens to f64 (see emit.js `*`).
    if (isUnsignedI32Expr(args[0], locals) || isUnsignedI32Expr(args[1], locals)) return 'f64'
    if (sv !== NO_VALUE && typeof sv === 'number') return isI32(sv) ? 'i32' : 'f64'
    // Shared FITS_I32_MAX threshold (widen.js) keeps this in lock-step with emit's
    // `mulFitsI32`. exprType only proves the static-literal case — a strict SUBSET of
    // emit's i32 verdict (emit also admits masked-bound operands), which is the safe
    // direction: never claim i32 where emit might widen to f64.
    const small = e => {
      const v = staticValue(e)
      return v !== NO_VALUE && typeof v === 'number' && Math.abs(v) <= FITS_I32_MAX
    }
    return small(args[0]) || small(args[1]) ? 'i32' : 'f64'
  }
  // Unary preserves type
  if (op === 'u-' || op === 'u+') return exprType(args[0], locals)
  // Ternary / logical: conciliate
  if (op === '?:' || op === '&&' || op === '||') {
    const branches = op === '?:' ? [args[1], args[2]] : [args[0], args[1]]
    const ta = exprType(branches[0], locals), tb = exprType(branches[1], locals)
    return ta === 'i32' && tb === 'i32' ? 'i32' : 'f64'
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
      const f = ctx.func.map?.get(args[0])
      if (f?.sig?.results?.length === 1 && f.sig.results[0] === 'i32' && f.sig.ptrKind == null) return 'i32'
      if (f?.sig?.results?.length === 1 && f.sig.results[0] === 'v128') return 'v128'   // SIMD helper
    }
  }
  return 'f64'
}

// === Integer-certainty fixpoint (shared by analyzeIntCertain + program-facts) ===

const INT_BIT_OPS = new Set(['|', '&', '^', '~', '<<', '>>', '>>>'])
const INT_CLOSED_OPS = new Set(['+', '-', '*'])  // `%` handled separately — int only for nonzero divisor
const INT_MATH_FNS = new Set(['imul', 'clz32', 'floor', 'ceil', 'round', 'trunc'])

// `capturedNames`, when given, additionally folds in defs found INSIDE nested
// arrow bodies — but ONLY for names in that set, and only when found there;
// the top-level (own-scope) collection below is completely unaffected either
// way. Default callers (no `capturedNames`) get byte-identical behavior to
// before: an ordinary local can't be assigned from inside a nested arrow
// without becoming a closure capture, so stopping at `=>` is exact there. A
// captured (boxed) variable is exactly the case where it CAN — its cell-type
// decision (src/compile/index.js's closure-capture narrowing) needs those
// writes too, wherever in the closure tree they live. Doesn't track arrow-body
// shadowing (a same-named nested param/`let` re-declaring `name`) — same
// direction of imprecision `boxedCaptures`' own `findMutations` already
// accepts for the boxing decision itself: at worst this forgoes the i32 cell
// fast path (falls back to the always-safe f64 cell), it can never mis-widen
// an actually-non-integer write to i32.
function collectIntDefs(body, capturedNames) {
  const defs = new Map()
  const pushDef = (name, rhs, inArrow) => {
    if (inArrow && !capturedNames.has(name)) return
    let list = defs.get(name)
    if (!list) { list = []; defs.set(name, list) }
    list.push(rhs)
  }
  const collect = (node, inArrow) => {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') {
      if (capturedNames && capturedNames.size) collect(args[1], true)
      return
    }
    if (op === 'let' || op === 'const') {
      for (const a of args)
        if (Array.isArray(a) && a[0] === '=' && typeof a[1] === 'string') pushDef(a[1], a[2], inArrow)
    } else if (op === '=' && typeof args[0] === 'string') {
      pushDef(args[0], args[1], inArrow)
    } else if (typeof op === 'string' && op.length > 1 && op.endsWith('=') &&
               !CMP_OPS.has(op) && op !== '=>' && typeof args[0] === 'string') {
      pushDef(args[0], [op.slice(0, -1), args[0], args[1]], inArrow)
    } else if ((op === '++' || op === '--') && typeof args[0] === 'string') {
      pushDef(args[0], [op === '++' ? '+' : '-', args[0], [null, 1]], inArrow)
    }
    for (const a of args) collect(a, inArrow)
  }
  collect(body, false)
  return defs
}

// The integer lattice is 3-level:
//   0 — not provably integer-valued
//   1 — integral, but unbounded magnitude and/or -0-capable (`+ - *` closure,
//       floor/ceil/round/trunc, `>>>` — a uint32 can exceed int32, `%`/unary
//       minus — -0 producers)
//   2 — STRICT int32: the value is exactly representable as a signed 32-bit
//       int and is never -0 — i.e. `i32.trunc_sat_f64_s` of its f64 form is
//       an exact round-trip. Producers: int32-range literals, booleans,
//       comparisons, the signed bitwise ops (`| & ^ ~ << >>`), Math.imul /
//       clz32, and meets of those through ?:/&&/||.
// Level ≥1 is the historical `isIntExpr` (ToNumber-skip / floor-elision
// consumers); level 2 feeds raw-i32 slot loads and i32 local typing, where
// saturation or a lost -0 would be a WRONG VALUE, not a lost optimization.
const INT_MATH_FNS_I32 = new Set(['imul', 'clz32'])
const _numLevel = (v) => typeof v === 'boolean' ? 2
  : typeof v !== 'number' || !Number.isInteger(v) || Object.is(v, -0) ? 0
  : v >= -2147483648 && v <= 2147483647 ? 2 : 1

function makeIntLevelExpr(intLevels, slotLevelOf) {
  return function levelOf(expr) {
    if (typeof expr === 'number' || typeof expr === 'boolean') return _numLevel(expr)
    if (typeof expr === 'string') return intLevels.get(expr) ?? 0
    if (!Array.isArray(expr)) return 0
    const sv = staticValue(expr)
    if (sv !== NO_VALUE && typeof sv === 'number' && Object.is(sv, -0)) return 0
    const [op, ...args] = expr
    if (op == null) return _numLevel(args[0])
    if (op === '>>>') return 1                      // uint32: up to 2^32-1, exceeds int32
    if (INT_BIT_OPS.has(op) || CMP_OPS.has(op)) return 2
    if (op === '.') {
      // Slot-census resolver (analyzeSchemaSlotIntCertain's optimistic
      // fixpoint): a censused slot answers definitively — including 0
      // (a known non-int write beats the val-kind fallback below).
      if (slotLevelOf && typeof args[0] === 'string') {
        const r = slotLevelOf(args[0], args[1])
        if (r != null) return r
      }
      return typeof args[0] === 'string' && propValType(args[1], lookupValType(args[0])) === VAL.NUMBER ? 1 : 0
    }
    if (INT_CLOSED_OPS.has(op)) {
      const a = levelOf(args[0])
      const b = args[1] != null ? levelOf(args[1]) : a
      return a && b ? 1 : 0                          // integral-closed, range-open
    }
    // `a % b` is integer-valued only when b is a provably-nonzero integer
    // constant — `a % 0` is NaN, which is not an integer. A runtime or zero
    // divisor leaves the expression non-int (f64), so result-narrowing won't
    // truncate a NaN remainder to 0 and floor-elision won't drop a NaN.
    // Never strict: `-5 % 5` is -0.
    if (op === '%') {
      const bv = staticValue(args[1])
      return bv !== NO_VALUE && typeof bv === 'number' && bv !== 0 && Number.isInteger(bv) && levelOf(args[0]) ? 1 : 0
    }
    if (op === 'u-') return levelOf(args[0]) ? 1 : 0 // -(0) is -0; -(-2^31) exceeds int32
    if (op === 'u+') return levelOf(args[0])         // ToNumber identity on an int
    if (op === '?:') return Math.min(levelOf(args[1]), levelOf(args[2]))
    if (op === '&&' || op === '||') return Math.min(levelOf(args[0]), levelOf(args[1]))
    if (op === '()') {
      const c = args[0]
      const fn = typeof c === 'string' && c.startsWith('math.') ? c.slice(5)
        : Array.isArray(c) && c[0] === '.' && c[1] === 'Math' ? c[2] : null
      if (fn && INT_MATH_FNS.has(fn)) return INT_MATH_FNS_I32.has(fn) ? 2 : 1
    }
    return 0
  }
}

// Adapt a boolean-or-level slot resolver to the level contract (a boolean
// `true` caps at level 1 — weak evidence stays weak).
const _slotLevelAdapter = (slotIntOf) => slotIntOf
  ? (obj, prop) => { const r = slotIntOf(obj, prop); return r == null ? null : r === true ? 1 : r === false ? 0 : r }
  : null

/** Monotone fixpoint over binding defs in `body`. Map name → intCertain.
 *  `capturedNames` (optional): also fold in defs of these specific names found
 *  inside nested arrow bodies — see collectIntDefs. Only src/compile/index.js's
 *  boxed-cell narrowing passes this; every other caller keeps the default
 *  own-scope-only behavior unchanged. */
/** Monotone-down level fixpoint over binding defs in `body`:
 *  Map name → 0|1|2 (see the lattice above `makeIntLevelExpr`).
 *  `slotLevelOf(obj, prop)` → 0|1|2|null resolves `.prop` reads. */
export function intLevelMap(body, capturedNames, slotLevelOf) {
  const defs = collectIntDefs(body, capturedNames)
  if (defs.size === 0) return new Map()
  const levels = new Map()
  for (const name of defs.keys()) levels.set(name, 2)
  // A parameter has no def in `body` — its entry value is whatever the caller
  // passed. For an f64 param (JS-number ABI) that is an arbitrary real, so a
  // reassigned f64 param is NOT integer-certain: a self/int reassignment
  // (`p = p`, `p = p + 1`) would otherwise vacuously satisfy the optimistic
  // fixpoint, since `levelOf(p)` reads p's own provisional 2. Seed f64
  // params 0 so the unknown entry value grounds the lattice; i32-narrowed
  // params (integer ABI) stay strict. Seeding 0 is always conservative —
  // at worst it re-applies a floor/round that was a runtime no-op — so a
  // mismatched ctx.func.current (whole-program intExprChecker callers) can only
  // forgo an optimization, never miscompile.
  for (const p of ctx.func.current?.params || [])
    if (p.type !== 'i32' && levels.has(p.name)) levels.set(p.name, 0)
  const levelOf = makeIntLevelExpr(levels, slotLevelOf)
  let changed = true
  while (changed) {
    changed = false
    for (const [name, rhsList] of defs) {
      const cur = levels.get(name)
      if (!cur) continue
      let next = cur
      for (const rhs of rhsList) { const l = levelOf(rhs); if (l < next) next = l; if (!next) break }
      if (next !== cur) { levels.set(name, next); changed = true }
    }
  }
  return levels
}

/** Monotone fixpoint over binding defs in `body`. Map name → intCertain
 *  (boolean — the level ≥1 projection; see `intLevelMap` for the raw levels). */
export function intCertainMap(body, capturedNames, slotIntOf) {
  const levels = intLevelMap(body, capturedNames, _slotLevelAdapter(slotIntOf))
  const out = new Map()
  for (const [name, l] of levels) out.set(name, l >= 1)
  return out
}

/** Returns `expr => boolean` — integer-shaped expressions in `body`. */
export function intExprChecker(body, slotIntOf) {
  const slotLevelOf = _slotLevelAdapter(slotIntOf)
  const levelOf = makeIntLevelExpr(intLevelMap(body, undefined, slotLevelOf), slotLevelOf)
  return (expr) => levelOf(expr) >= 1
}

/** Returns `expr => 0|1|2` over `body`'s level fixpoint — the strict-i32
 *  sibling of `intExprChecker` (slot census / raw-i32 consumers). */
export function intLevelChecker(body, slotLevelOf) {
  return makeIntLevelExpr(intLevelMap(body, undefined, slotLevelOf), slotLevelOf)
}
