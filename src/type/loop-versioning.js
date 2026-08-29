/**
 * Typed-array loop-versioning: the single-loop scan for the 'for'/'while' emitter.
 * `typedStaticLen`/`typedIdxProven` are the typed-array provenance queries every
 * bounds-proof family in `type/` ultimately answers through; `versionableTypedFor`
 * is the candidate scan that finds typed accesses a runtime guard could make
 * unchecked, using the affine/monotone-cursor helper machinery below it. The
 * nest-level lift built on top of `versionableTypedFor` lives in
 * `loop-versioning-nest.js` (a one-directional dependency — see
 * `.work/archive/type-split.md` for why the rest stays one file).
 *
 * @module type/loop-versioning
 */
import { isReassigned, ASSIGN_OPS as WRITE_OPS, walkAst } from '../ast.js'
import { ctx } from '../ctx.js'
import { intLiteralValue, intExprRange, constIntExpr } from '../static.js'
import {
  idxKey, inBoundsArrIdx, litBoundArrIdx, redeclaresName, collectDecls, lengthRecv,
  isUnitIncrement,
} from './canonical-bounds.js'
import { intervalProvenIdx, intervalIdxRanges } from './interval-proof.js'
import { exprType } from './expr-type.js'
import { containsNestedClosure } from './loop-unroll.js'

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

/** A value join whose typed-storage fact must be met across arms by the
 * shared typed-provenance authority. */
export const isCondExpr = e => Array.isArray(e) &&
  (e[0] === '?:' || e[0] === '&&' || e[0] === '||' || e[0] === '??')
