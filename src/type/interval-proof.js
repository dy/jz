/**
 * Static interval proof (`typedIdxProven` class 5): a tiny abstract interpreter
 * over integer INTERVALS for const-bound loop nests — the conv2d/blur shape
 * class, where every dimension folds to a literal and every index is a chain
 * of decls over induction variables. `scanIntervalIdx` is one function by
 * necessity (~15 mutually-closing helpers sharing threaded env state across a
 * 2-round widening fixpoint) — see `.work/archive/type-split.md` for why it stays
 * whole. `intervalProvenIdx`/`intervalIdxRanges` are the memoized per-body
 * accessors every other bounds-proof family (loop-versioning, clone) consults.
 *
 * @module type/interval-proof
 */
import {
  I32_MIN, I32_MAX, isI32, isReassigned, MUTATE_OPS, ASSIGN_OPS as WRITE_OPS,
  walkAst, some, someDeep, REFS_THROUGH_ARROWS,
} from '../ast.js'
import { ctx, getFactStore } from '../ctx.js'
import { intLiteralValue } from '../static.js'
import { exprType } from './expr-type.js'
import { idxKey, redeclaresName, collectDecls, isUnitDecrement } from './canonical-bounds.js'

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
// Initializer roots whose true result can carry range facts through a named const.
const RANGE_GUARD_OPS = new Set(['&&', '<', '<=', '>', '>=', '===', '!=='])

/** Walk one function body, recording proven `recv[idx]` keys into `out`.
 *  `lens(name)` → static element count or null. Guard-seeded proofs fail closed
 *  across repeated structural keys; the other sharp edge is keeping `env` honest
 *  (kills before loops/switch, closure writes, embedded assignments). */
function scanIntervalIdx(body, out, lens, ranges) {
  const env = new Map()   // name → [lo, hi] | null (unknown)
  // A guard-seeded proof may not enter the legacy structural-key channel when
  // that key occurs elsewhere: one guarded site would bless its unguarded twin.
  // Count lazily (normally one key/function) so unaffected functions pay no walk.
  const uniqueGuardKeyMemo = new Map()
  const uniqueGuardKey = (key) => {
    if (uniqueGuardKeyMemo.has(key)) return uniqueGuardKeyMemo.get(key)
    let count = 0
    walkAst(body, { enter: n => {
      if (n[0] === '=>') return false
      if (n[0] === '[]' && n.length === 3 && typeof n[1] === 'string' && idxKey(n[1], n[2]) === key) count++
    } })
    const unique = count === 1
    uniqueGuardKeyMemo.set(key, unique)
    return unique
  }
  let guardProofContext = 0
  const underGuardProof = (guarded, fn) => {
    if (!guarded) return fn()
    guardProofContext++
    try { return fn() } finally { guardProofContext-- }
  }
  // While-body fixpoint passes walk EXPLORATORILY — env may be transiently too
  // narrow, so proof/hull recording is suppressed until the stable final pass.
  let recording = true
  const symEnv = new Map()   // name → { h: symbolic hull, incNode } — wrap cursors vs mutable bounds
  // Positive companion induction variables (`for (i += 3) { out[op] = …; op += 4 }`).
  // Unlike env's loop invariant, this hull is valid only BEFORE the companion's
  // direct increment in each iteration. Keeping that window explicit proves
  // codec/output cursors without pretending the post-increment value is in-bounds.
  const coupledEnv = new Map() // name → { h: [lo, hi], incNode }
  // names written inside ANY closure in this body: a later call can change them at
  // any point — they never hold a trusted interval
  const closureWrites = new Set()
  const collectClosureWrites = (n, inClosure) => {
    if (!Array.isArray(n)) return
    const into = inClosure || n[0] === '=>'
    if (into && MUTATE_OPS.has(n[0])) {
      if (typeof n[1] === 'string') closureWrites.add(n[1])
      // member writes (`o[i]=…`, `o.p=…`) rebind no name; only PATTERN targets do
      else if (Array.isArray(n[1]) && n[1][0] !== '[]' && n[1][0] !== '.' && n[1][0] !== '?.')
        collectNames(n[1], closureWrites)
    }
    for (let k = 1; k < n.length; k++) collectClosureWrites(n[k], into)
  }
  const collectNames = (n, set) => someDeep(n, x => { if (typeof x === 'string') set.add(x); return false })
  collectClosureWrites(body, false)
  const activeFacts = new Map()   // name → [lo, hi] theorem stamped by a rewrite pass (peel)
  // Preserve range facts through an immutable named guard:
  // `const inside = x >= 0 && x < W; if (inside) out[x] = 1`.
  // A definition is usable only while every referenced binding is unchanged;
  // writes and potentially-mutating calls retire it before a later branch.
  const boolDefs = new Map()
  const invalidateBool = (name) => { for (const [k, e] of boolDefs) if (e.free.has(name)) boolDefs.delete(k) }
  // Do not replay an effectful initializer as a theorem: a call/update can
  // change a compared name after an earlier conjunct observed it. Typed reads
  // and fixed typed lengths are effect-free even when receivers alias.
  const stableRangeExpr = (def) => !some(def, n => {
    const op = n[0]
    if ((op === '()' && n.length !== 2) || op === 'new' || MUTATE_OPS.has(op)) return true
    if (op === '[]') return typeof n[1] !== 'string' || !ctx.func.typedElem?.has(n[1])
    if (op === '.' || op === '?.')
      return n[2] !== 'length' || typeof n[1] !== 'string' || !ctx.func.typedElem?.has(n[1])
    return false
  }, REFS_THROUGH_ARROWS)
  const setEnv = (name, v) => {
    invalidateBool(name)
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
    if (typeof e === 'string') return closureWrites.has(e) ? null : coupledEnv.get(e)?.h ?? env.get(e) ?? null
    if (!Array.isArray(e)) return null
    const [op, x, y] = e
    // a NARROW typed load is range-bound by its element width (`table[in[j]]` — a
    // Uint8Array read is [0,255] wherever j lands; even an unproven-idx read's
    // undefined coerces through ToInt32 to 0, inside every narrow range)
    if (op === '[]' && e.length === 3 && typeof x === 'string') {
      visit(e)   // record the access's own proof attempt
      const written = ctx.func.localReps?.get(x)?.arrayElemRange
      const r = written ?? NARROW_ELEM_RANGE[ctx.func.typedElem?.get(x)]
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
    // Prepared post-increment indices use `(++cursor) - 1`. Transfer the
    // mutation and return the incremented interval so the outer subtraction
    // recovers the exact pre-increment index hull.
    if (e.length === 2 && (op === '++' || op === '--') && typeof x === 'string') {
      visit(e)
      return env.get(x) ?? null
    }
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
        // m ≥ 2^31 masks the SIGN bit (ToInt32) — result can be negative
        const m = intLiteralValue(x) ?? intLiteralValue(y)
        if (m != null && m >= 0 && m <= 0x7fffffff) return [0, m]
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
    else if (op === '&' && B[0] === B[1] && B[0] >= 0 && B[0] <= 0x7fffffff) r = [0, B[0]]
    // OR of two known non-negative fields cannot set a bit above either
    // operand's highest possible bit. This covers packed table indices such as
    // `((a & 3) << 4) | (b >>> 4)` without assuming the fields are disjoint.
    else if (op === '|' && A[0] >= 0 && B[0] >= 0) {
      const m = Math.max(A[1], B[1])
      const hi = m === 0 ? 0 : 2 ** Math.ceil(Math.log2(m + 1)) - 1
      r = [0, hi]
    }
    else if (op === '%' && B[0] === B[1] && B[0] > 0 && A[0] >= 0) r = [0, Math.min(A[1], B[0] - 1)]
    return ipOk(r) ? r : null
  }
  // condition refinement for if-arms: `name < K` / `name >= K` … over a known name.
  // The lhs also admits the AFFINE form `name ± c` (`inl_i + 3 <= N` — the strided
  // codec cursors): the comparison re-biases to `name OP K∓c`. The rhs admits any
  // ACCESS-FREE expression the evaluator folds to a singleton (`src.length | 0`).
  const pureExpr = (e) => !some(e,
    n => n[0] === '[]' || n[0] === '()' || n[0] === 'new' || n[0] === '?:' || n[0] === '=' || WRITE_OPS.has(n[0]),
    REFS_THROUGH_ARROWS)
  // A comparison can establish the first finite interval for an otherwise
  // unbounded machine-i32 name. Pointer locals also use i32 storage, so exclude
  // them: their numeric comparison semantics are not an integer-value proof.
  const fullI32Range = (name) => {
    if (exprType(name, ctx.func.locals) !== 'i32') return null
    if (ctx.func.localReps?.get(name)?.ptrKind != null) return null
    const p = ctx.func.current?.params?.find(q => q.name === name)
    return p?.ptrKind == null ? [I32_MIN, I32_MAX] : null
  }
  // Raw facts may exceed IP_LIM while separate conjuncts are being intersected
  // (`x >= 0` and `x < W`). Only refine()/refineAll() publish an ipOk interval.
  const refineRaw = (c, negate, seedUnknown = false) => {
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
    // Bit-field discriminator: `(tag & MASK) === VALUE` narrows a bounded
    // integer source to the matching hull. Enumerating at most 65K values is a
    // compile-time-only, fail-closed operation and handles byte/word opcode
    // classes exactly (QOI's `(b0 & 0xc0) === 0` ⇒ b0 ∈ [0,63]).
    if (!negate && (op === '===' || op === '==') && rLo === rHi &&
        Array.isArray(l) && l[0] === '&' && l.length === 3) {
      const mask = intLiteralValue(l[1]) ?? intLiteralValue(l[2])
      const name = typeof l[1] === 'string' ? l[1] : typeof l[2] === 'string' ? l[2] : null
      const v = name != null ? env.get(name) : null
      if (mask != null && mask >= 0 && name != null && v && v[1] - v[0] <= 65536) {
        let lo = null, hi = null
        for (let x = v[0]; x <= v[1]; x++) if ((x & mask) === rLo) { if (lo == null) lo = x; hi = x }
        if (lo != null) return [name, [lo, hi]]
      }
    }
    let affineLhs = false
    if (Array.isArray(l) && l.length === 3 && (l[0] === '+' || l[0] === '-')) {
      const cR = intLiteralValue(l[2]), cL = intLiteralValue(l[1])
      if (typeof l[1] === 'string' && cR != null) { rLo = l[0] === '+' ? rLo - cR : rLo + cR; rHi = l[0] === '+' ? rHi - cR : rHi + cR; l = l[1]; affineLhs = true }
      else if (l[0] === '+' && typeof l[2] === 'string' && cL != null) { rLo = rLo - cL; rHi = rHi - cL; l = l[2]; affineLhs = true }
    }
    if (typeof l !== 'string') return null
    // A pre-existing finite env range proves affine +/- cannot wrap. A fresh
    // full-i32 seed does not, so only seed bare-name comparisons here.
    const known = env.get(l)
    const fresh = seedUnknown && !affineLhs ? fullI32Range(l) : null
    const v = known ?? fresh
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
  const refine = (c, negate) => {
    const r = refineRaw(c, negate)
    return r && r[1][0] <= r[1][1] && ipOk(r[1]) ? r : null
  }
  // Every conjunct holds on the positive path. Intersect repeated facts for
  // the same name before applying IP_LIM: either half of `x >= 0 && x < W`
  // is too wide alone, while their meet is the useful finite theorem.
  const refineAll = (c2, namedSeed = false) => {
    // The new full-i32 seed is deliberately limited to a positive `if (name)`
    // use of a stable const definition. Every older inline/refinement path keeps
    // its prior finite-env-only behavior.
    const seedUnknown = namedSeed && typeof c2 === 'string' && boolDefs.has(c2)
    if (!seedUnknown) {
      const out = []
      const gatherKnown = (c3) => {
        if (Array.isArray(c3) && c3[0] === '&&') { gatherKnown(c3[1]); gatherKnown(c3[2]); return }
        const r = refineRaw(c3, false, false)
        if (r && r[1][0] <= r[1][1] && ipOk(r[1])) out.push(r)
      }
      gatherKnown(c2)
      return out
    }
    const facts = new Map()
    const add = (r) => {
      if (!r || facts.get(r[0]) === null) return
      const prev = facts.get(r[0])
      const next = prev
        ? [Math.max(prev[0], r[1][0]), Math.min(prev[1], r[1][1])]
        : r[1]
      facts.set(r[0], next[0] <= next[1] ? next : null)
    }
    const gather = (c3) => {
      if (typeof c3 === 'string') {
        const bd = boolDefs.get(c3)
        if (bd) gather(bd.def)
      } else if (Array.isArray(c3) && c3[0] === '&&') {
        gather(c3[1]); gather(c3[2])
      } else add(refineRaw(c3, false, seedUnknown))
    }
    gather(c2)
    return [...facts].filter(([, v]) => v && ipOk(v)).map(([name, v]) => [name, v])
  }
  // descend into closures too — capture-writes stay dead
  const killAssigned = (n) => walkAst(n, { enter: n2 => {
    if (MUTATE_OPS.has(n2[0])) {
      if (typeof n2[1] === 'string') { invalidateBool(n2[1]); env.set(n2[1], null) }
      else if (Array.isArray(n2[1]) && n2[1][0] !== '[]' && n2[1][0] !== '.' && n2[1][0] !== '?.') {
        const s = new Set(); collectNames(n2[1], s); for (const x of s) { invalidateBool(x); env.set(x, null) }
      }
    }
  } })
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
    //
    // GATE (exact, not heuristic — a raw compile-time win jz.wasm pays for):
    // ONLY a name at an ±IP_LIM endpoint can narrow. The join gave every
    // non-escaping name its exact one-step hull (min/max of entry ∪ back-edge),
    // which is already the tightest interval containing both edges — a fresh
    // walk reproduces the same stable end-state, so the meet is a no-op there.
    // The escaped names (widened to the sentinel) are the sole candidates. If
    // NONE widened, skip both extra body walks (the common case: cond-clamped
    // ivs never escape). Turns the heapsort-class cost into zero on every
    // ordinary loop.
    const widened = () => {
      for (const [, j] of joined) if (j && (j[0] === -IP_LIM || j[1] === IP_LIM)) return true
      return false
    }
    for (let np = 0; np < 2 && widened(); np++) {
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
      const L = lens(n[1]), k = idxKey(n[1], n[2])
      const proven = L != null && idxV && idxV[0] >= 0 && idxV[1] < L
      if (typeof process !== 'undefined' && process.env.JZ_DBG_IP) console.error('IPW', n[1], JSON.stringify(n[2]).slice(0,50), JSON.stringify(idxV), 'len', L)
      if (proven && (!guardProofContext || uniqueGuardKey(k))) out.add(k)
      // A bounded idx against an UNKNOWN length is half a proof — export the hull
      // (joined over every sighting of this key) for the versioning guard to close
      // with a runtime `hi < len` conjunct (the wrap-cursor + dynamic-table class).
      // Provisional guard-seeded hulls stay local; structural export would let
      // one guarded occurrence bless an unrelated same-key access.
      if (!proven && !guardProofContext && idxV && idxV[0] >= 0 && ranges) {
        const prev = ranges.get(k)
        ranges.set(k, prev ? [Math.min(prev[0], idxV[0]), Math.max(prev[1], idxV[1])] : idxV)
      }
      // symbolic wrap hull (`seq[si]` with si ∈ [0, SEQLEN-1], SEQLEN mutable):
      // exported only while the cursor's pre-increment window is open; a numeric
      // or conflicting prior sighting voids the key (one symbolic form per key)
      else if (!proven && !guardProofContext && idxV == null && typeof n[2] === 'string' && symEnv.has(n[2]) && ranges) {
        const h = symEnv.get(n[2]).h, prev = ranges.get(k)
        if (prev == null) ranges.set(k, h)
        else if (prev.hiName !== h.hiName || prev.hiBias !== h.hiBias) ranges.set(k, null)
      }
      return
    }
    if (op === 'let' || op === 'const') {
      for (let k = 1; k < n.length; k++) {
        const d = n[k]
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') {
          setEnv(d[1], ev(d[2]))
          // Bare-name conditions resolve through stable, single-assignment guards.
          if (op === 'const' && Array.isArray(d[2]) && RANGE_GUARD_OPS.has(d[2][0]) && stableRangeExpr(d[2])) {
            const free = new Set(); collectNames(d[2], free)
            if (![...free].some(f => closureWrites.has(f))) boolDefs.set(d[1], { def: d[2], free })
          }
        }
        else if (typeof d === 'string') { invalidateBool(d); env.set(d, null) }
        else if (Array.isArray(d)) { visit(d); const s = new Set(); collectNames(d[0] === '=' ? d[1] : d, s); for (const x of s) { invalidateBool(x); env.set(x, null) } }
      }
      return
    }
    if (op === '=' && typeof n[1] === 'string') {
      if (symEnv.get(n[1])?.incNode === n) symEnv.delete(n[1])   // past the increment: window closed
      if (coupledEnv.get(n[1])?.incNode === n) coupledEnv.delete(n[1])
      setEnv(n[1], ev(n[2]))
      return
    }
    if (MUTATE_OPS.has(op)) {
      if (typeof n[1] === 'string' && symEnv.get(n[1])?.incNode === n) symEnv.delete(n[1])
      if (typeof n[1] === 'string' && coupledEnv.get(n[1])?.incNode === n) coupledEnv.delete(n[1])
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
          const s = new Set(); collectNames(n[1], s); for (const x of s) { invalidateBool(x); env.set(x, null) }
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
      // canonical literal-interval iv: `for (iv = A; iv </<= B; iv += STEP)` —
      // including affine tests (`iv + WIDTH <= B`) — or the DOWNWARD unit-step
      // twin (heapify roots, reverse scans). A/B fold through the full evaluator.
      let iv = null, range = null, ivStep = null
      const decls = new Map(); collectDecls(init, decls)
      const stepDelta = (s, name) => {
        if (!Array.isArray(s)) return null
        if (s[0] === '++' && s[1] === name) return 1
        if (s[0] === '+=' && s[1] === name) return constInt(s[2])
        if (s[0] === '=' && s[1] === name && Array.isArray(s[2]) && s[2][0] === '+') {
          if (s[2][1] === name) return constInt(s[2][2])
          if (s[2][2] === name) return constInt(s[2][1])
        }
        return null
      }
      const down = Array.isArray(cond) && (cond[0] === '>' || cond[0] === '>=')
      if (Array.isArray(cond) && (cond[0] === '<' || cond[0] === '<=' || down)) {
        let name = cond[1], bias = 0
        if (!down && Array.isArray(name) && name.length === 3 && (name[0] === '+' || name[0] === '-')) {
          const r = constInt(name[2]), l = constInt(name[1])
          if (typeof name[1] === 'string' && r != null) { bias = name[0] === '+' ? r : -r; name = name[1] }
          else if (name[0] === '+' && typeof name[2] === 'string' && l != null) { bias = l; name = name[2] }
        }
        if (typeof name === 'string') {
          const dv = decls.get(name)
          const As = dv != null ? ev(dv) : env.get(name)
          const Bs = cond[2] != null ? ev(cond[2]) : null
          const A = As && As[0] === As[1] ? As[0] : null
          const B = Bs && Bs[0] === Bs[1] ? Bs[0] : null
          const delta = down ? null : stepDelta(step, name)
          if (A != null && B != null && !isReassigned(lbody, name) && !redeclaresName(lbody, name)
              && (cond[2] == null || boundInvariant(cond[2], lbody))
              && (down ? isUnitDecrement(step, name) : delta != null && delta > 0)) {
            iv = name
            ivStep = down ? -1 : delta
            range = down ? [cond[0] === '>' ? B + 1 : B, A]
              : [A, B - bias - (cond[0] === '<' ? 1 : 0)]
          }
        }
      }
      // Companion-IV theorem. If a positive cursor has one direct positive
      // increment in the loop body, its value BEFORE that increment is bounded
      // by the statically known trip count. This is deliberately a lexical
      // window: after the increment the theorem is removed, so `out[op+k]`
      // becomes raw while a post-increment access remains checked.
      const coupled = []
      // Multi-branch monotone cursor budget. A codec cursor often advances a
      // different number of times in mutually-exclusive arms (`ip++` once for
      // INDEX, five times for RGBA). Compute the MAXIMUM positive constant
      // advance along any one body path; over a literal-trip loop this gives a
      // whole-body invariant `entry <= cursor <= entry + trips*maxAdvance`.
      // Unknown writes, nested control loops, abrupt edges, or closures reject.
      const advanceBudget = (root, name) => {
        const seq = (xs) => { let n = 0; for (const x of xs) { const d = eff(x); if (d == null) return null; n += d } return n }
        const delta = (n) => {
          if (!Array.isArray(n) || n[1] !== name) return null
          if (n[0] === '++') return 1
          if (n[0] === '+=') { const d = constInt(n[2]); return d != null && d > 0 ? d : null }
          if (n[0] === '=' && Array.isArray(n[2]) && n[2][0] === '+') {
            const d = n[2][1] === name ? constInt(n[2][2]) : n[2][2] === name ? constInt(n[2][1]) : null
            return d != null && d > 0 ? d : null
          }
          return null
        }
        const eff = (n) => {
          if (!Array.isArray(n)) return 0
          const op2 = n[0]
          if (op2 === '=>') return closureWrites.has(name) ? null : 0
          if (MUTATE_OPS.has(op2) && n[1] === name) return delta(n)
          if (op2 === 'if') {
            const c = eff(n[1]), a = eff(n[2]), b = n.length > 3 ? eff(n[3]) : 0
            return c == null || a == null || b == null ? null : c + Math.max(a, b)
          }
          if (op2 === '?:') {
            const c = eff(n[1]), a = eff(n[2]), b = eff(n[3])
            return c == null || a == null || b == null ? null : c + Math.max(a, b)
          }
          if (op2 === '&&' || op2 === '||') {
            const a = eff(n[1]), b = eff(n[2])
            return a == null || b == null ? null : a + Math.max(0, b)
          }
          if (op2 === 'while' || op2 === 'for' || op2 === 'do' || op2 === 'for-of' || op2 === 'for-in' ||
              op2 === 'switch' || op2 === 'try' || op2 === 'catch' || op2 === 'finally' ||
              op2 === 'break' || op2 === 'continue' || op2 === 'return' || op2 === 'throw')
            return isReassigned(n, name) ? null : 0
          return seq(n.slice(1))
        }
        return eff(root)
      }
      // Two-counter amortized budget. Track `cursor + credit` path-sensitively
      // through one loop body. This proves buffered/RLE emitters where a rare
      // path writes K+1 bytes only after `credit > 0` and resets the credit:
      // the extra byte spends accumulated credit, so the per-iteration
      // potential still rises by at most K. Only positive constant cursor
      // advances and affine/zero credit writes are accepted; complex control
      // or state explosion fails closed.
      const potentialAdvance = (root, cursor, credit) => {
        const LIM = 128, INF = IP_LIM
        const norm = (xs) => {
          const m = new Map()
          for (const s of xs) {
            if (s.lo > s.hi) continue
            const k = `${s.mode},${s.rv},${s.lo},${s.hi}`
            const p = m.get(k)
            if (!p || s.c > p.c) m.set(k, s)
          }
          const out = [...m.values()]
          return out.length <= LIM ? out : null
        }
        const addC = (xs, d) => d != null && d > 0 ? xs.map(s => ({ ...s, c: s.c + d })) : null
        const setCredit = (xs, mode, rv) => xs.map(s => ({ ...s, mode, rv }))
        const cmp = (a, op2, b) => op2 === '<' ? a < b : op2 === '<=' ? a <= b : op2 === '>' ? a > b
          : op2 === '>=' ? a >= b : op2 === '===' || op2 === '==' ? a === b : a !== b
        const split = (xs, cond2, truth) => {
          if (!Array.isArray(cond2) || cond2.length !== 3 ||
              !['<', '<=', '>', '>=', '===', '==', '!==', '!='].includes(cond2[0])) return xs.map(s => ({ ...s }))
          let op2 = cond2[0], k = constInt(cond2[2])
          if (cond2[1] !== credit || k == null) {
            if (cond2[2] === credit && (k = constInt(cond2[1])) != null)
              op2 = op2 === '<' ? '>' : op2 === '<=' ? '>=' : op2 === '>' ? '<' : op2 === '>=' ? '<=' : op2
            else return xs.map(s => ({ ...s }))
          }
          if (!truth) op2 = op2 === '<' ? '>=' : op2 === '<=' ? '>' : op2 === '>' ? '<=' : op2 === '>=' ? '<'
            : op2 === '===' || op2 === '==' ? '!==' : '==='
          const out = []
          for (const s of xs) {
            if (s.mode === 'const') { if (cmp(s.rv, op2, k)) out.push({ ...s }); continue }
            const q = k - s.rv
            let lo = s.lo, hi = s.hi
            if (op2 === '<') hi = Math.min(hi, q - 1)
            else if (op2 === '<=') hi = Math.min(hi, q)
            else if (op2 === '>') lo = Math.max(lo, q + 1)
            else if (op2 === '>=') lo = Math.max(lo, q)
            else if (op2 === '===' || op2 === '==') { lo = Math.max(lo, q); hi = Math.min(hi, q) }
            // `!=` removes an interior point which an interval cannot express;
            // retain the wider interval (safe, merely less precise).
            if (lo <= hi) out.push({ ...s, lo, hi })
          }
          return out
        }
        const directDelta = (n, name) => {
          if (!Array.isArray(n) || n[1] !== name) return null
          if (n[0] === '++') return 1
          if (n[0] === '--') return -1
          if (n[0] === '+=' || n[0] === '-=') { const d = constInt(n[2]); return d == null ? null : n[0] === '+=' ? d : -d }
          if (n[0] === '=' && Array.isArray(n[2]) && (n[2][0] === '+' || n[2][0] === '-')) {
            if (n[2][1] !== name) return null
            const d = constInt(n[2][2]); return d == null ? null : n[2][0] === '+' ? d : -d
          }
          return null
        }
        const walk = (n, xs) => {
          if (!xs) return null
          if (!Array.isArray(n)) return xs
          const op2 = n[0]
          if (op2 === '=>') return isReassigned(n, cursor) || isReassigned(n, credit) ? null : xs
          if (MUTATE_OPS.has(op2) && (n[1] === cursor || n[1] === credit)) {
            // Evaluate embedded lhs/rhs effects first only when they are not the
            // direct recurrence itself; accepted recurrences contain no calls.
            if (n[1] === cursor) return addC(xs, directDelta(n, cursor))
            if (op2 === '=' && constInt(n[2]) != null) return setCredit(xs, 'const', constInt(n[2]))
            const d = directDelta(n, credit)
            if (d == null) return null
            return xs.map(s => ({ ...s, rv: s.rv + d }))
          }
          if (op2 === 'if') {
            let base = walk(n[1], xs)
            if (!base) return null
            const a = walk(n[2], split(base, n[1], true))
            const b = n.length > 3 ? walk(n[3], split(base, n[1], false)) : split(base, n[1], false)
            return a && b ? norm([...a, ...b]) : null
          }
          if (op2 === '?:') {
            let base = walk(n[1], xs)
            if (!base) return null
            const a = walk(n[2], split(base, n[1], true)), b = walk(n[3], split(base, n[1], false))
            return a && b ? norm([...a, ...b]) : null
          }
          if (op2 === '&&' || op2 === '||') {
            const left = walk(n[1], xs)
            if (!left) return null
            const right = walk(n[2], left)
            return right ? norm([...left, ...right]) : null // RHS may be skipped
          }
          if (op2 === 'break' || op2 === 'continue' || op2 === 'return' || op2 === 'throw') return null
          if (op2 === 'while' || op2 === 'for' || op2 === 'do' || op2 === 'for-of' || op2 === 'for-in' ||
              op2 === 'switch' || op2 === 'try' || op2 === 'catch' || op2 === 'finally')
            return isReassigned(n, cursor) || isReassigned(n, credit) ? null : xs
          let out = xs
          for (let j = 1; j < n.length; j++) { out = walk(n[j], out); if (!out) return null }
          return out
        }
        const end = walk(root, [{ c: 0, mode: 'rel', rv: 0, lo: 0, hi: INF }])
        if (!end?.length) return null
        let max = 0
        for (const s of end) {
          const creditLo = s.mode === 'rel' ? s.lo + s.rv : s.rv
          if (creditLo < 0 || s.c < 0) return null
          const d = s.mode === 'rel' ? s.c + s.rv : s.c + s.rv - s.lo
          if (!Number.isInteger(d)) return null
          max = Math.max(max, d)
        }
        return max
      }
      const budgeted = []
      if (iv && ivStep > 0 && range && range[0] <= range[1]) {
        const trips = Math.floor((range[1] - range[0]) / ivStep) + 1
        const stmts = Array.isArray(lbody) && (lbody[0] === ';' || lbody[0] === '{}') ? lbody.slice(1) : [lbody]
        const writesTo = (root, name) => {
          let count = 0
          walkAst(root, { enter: x => {
            if (MUTATE_OPS.has(x[0])) {
              if (x[1] === name) count++
              else if (Array.isArray(x[1]) && x[1][0] !== '[]' && x[1][0] !== '.' && x[1][0] !== '?.') {
                const names = new Set(); collectNames(x[1], names)
                if (names.has(name)) count++
              }
            }
          } })
          return count
        }
        for (const incNode of stmts) {
          if (!Array.isArray(incNode)) continue
          const name = typeof incNode[1] === 'string' ? incNode[1] : null
          if (!name || name === iv || closureWrites.has(name) || redeclaresName(lbody, name)) continue
          let delta = null
          if (incNode[0] === '++') delta = 1
          else if (incNode[0] === '+=') delta = constInt(incNode[2])
          else if (incNode[0] === '=' && Array.isArray(incNode[2]) && incNode[2][0] === '+') {
            if (incNode[2][1] === name) delta = constInt(incNode[2][2])
            else if (incNode[2][2] === name) delta = constInt(incNode[2][1])
          }
          const entry = env.get(name)
          const h = entry && delta != null && delta > 0
            ? [entry[0], entry[1] + (trips - 1) * delta] : null
          if (ipOk(h) && writesTo(lbody, name) === 1) coupled.push([name, h, incNode])
        }
        const changedNames = new Set()
        walkAst(lbody, { enter: x => {
          if (x[0] === '=>') return false
          if (MUTATE_OPS.has(x[0]) && typeof x[1] === 'string') changedNames.add(x[1])
        } })
        // Only build cursor budgets for names that actually feed a typed index
        // in this loop. The amortized path scanner is intentionally demand-
        // driven: running it for every pair of mutated scalar locals made the
        // compiler itself pay O(locals²) on unrelated arithmetic loops.
        const indexCaps = new Map()
        walkAst(lbody, { enter: x => {
          if (x[0] === '=>') return false
          if (x[0] === '[]' && typeof x[1] === 'string' && ctx.func.typedElem?.has(x[1])) {
            const L = lens(x[1])
            if (L != null) {
              const names = new Set(); collectNames(x[2], names)
              for (const name of names) if (changedNames.has(name)) {
                let a = indexCaps.get(name); if (!a) indexCaps.set(name, a = [])
                if (!a.includes(L)) a.push(L)
              }
            }
          }
        } })
        for (const name of changedNames) {
          const caps = indexCaps.get(name)
          if (!caps?.length) continue
          if (name === iv || closureWrites.has(name) || redeclaresName(lbody, name)) continue
          const entry = env.get(name), maxAdvance = advanceBudget(lbody, name)
          let h = entry && entry[0] >= 0 && maxAdvance != null && maxAdvance > 0
            ? [entry[0], entry[1] + trips * maxAdvance] : null
          // Try every non-negative changed counter as an amortization credit;
          // keep only a strictly tighter, fully verified potential budget.
          if (h && caps.some(L => h[1] >= L)) for (const credit of changedNames) {
            if (credit === name || credit === iv || closureWrites.has(credit) || redeclaresName(lbody, credit)) continue
            const ce = env.get(credit)
            if (!ce || ce[0] < 0) continue
            const K = potentialAdvance(lbody, name, credit)
            const ph = K != null && K >= 0 ? [entry[0], entry[1] + ce[1] + trips * K] : null
            if (ipOk(ph) && ph[1] < h[1]) h = ph
          }
          if (ipOk(h)) budgeted.push([name, h])
        }
      }
      // Body fixpoint (same engine as `while` below): the canonical-iv range is
      // a body-independent theorem re-seeded each pass; everything else
      // discovers its invariant. This is what proves heapsort's `child` chains,
      // medianUs's `samples[mid]`, and strided codec input/output cursors.
      const seeded = iv && ipOk(range) && range[0] <= range[1] && !closureWrites.has(iv)
      const priorCoupled = new Map(coupled.map(([name]) => [name, coupledEnv.get(name)]))
      const priorFacts = new Map(budgeted.map(([name]) => [name, activeFacts.get(name)]))
      for (const [name, h] of budgeted) activeFacts.set(name, h)
      const seeds = () => {
        if (seeded) env.set(iv, range)
        else if (iv) env.set(iv, null)
        for (const [name, h, incNode] of coupled) coupledEnv.set(name, { h, incNode })
        for (const [name, h] of budgeted) setEnv(name, h)
      }
      loopFixpoint(seeds,
        () => { if (cond != null) visit(cond); visit(lbody); if (step != null) visit(step) },
        cond, seeded)
      for (const [name] of budgeted) {
        const prior = priorFacts.get(name)
        if (prior) activeFacts.set(name, prior)
        else activeFacts.delete(name)
      }
      if (iv) env.set(iv, null)   // iv holds the exit value after the loop
      for (const [name] of coupled) {
        const prior = priorCoupled.get(name)
        if (prior) coupledEnv.set(name, prior)
        else coupledEnv.delete(name)
      }
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
          walkAst(wbody, { enter: x => { if (MUTATE_OPS.has(x[0]) && x[1] === a2[1]) writes++ } })
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
          walkAst(wbody, { enter: x => { if (MUTATE_OPS.has(x[0]) && x[1] === nm) writes++ } })
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
      const namedGuard = typeof c === 'string' && boolDefs.has(c)
      const thenRefs = refineAll(c, namedGuard)
      for (const rT of thenRefs) if (!closureWrites.has(rT[0])) env.set(rT[0], rT[1])
      underGuardProof(namedGuard && thenRefs.length, () => visit(thenB))
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
      for (const [name, bd] of boolDefs) {
        for (const free of bd.free) if (ctx.scope?.globalTypes?.has?.(free)) { boolDefs.delete(name); break }
      }
      for (const [k2] of env) if (!closureWrites.has(k2) && (ctx.scope?.globalTypes?.has?.(k2) || ctx.func?.typedElem?.has?.(k2))) {
        invalidateBool(k2); env.set(k2, null)
      }
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
    n._rangeFacts = null   // re-entry brake (the self-compile subset has no delete)
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
  if (WRITE_OPS.has(node[0]) && node[1] === iv) {
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
const NARROW_ELEM_RANGE = {
  'new.Int8Array': [-128, 127], 'new.Uint8Array': [0, 255], 'new.Uint8ClampedArray': [0, 255],
  'new.Int16Array': [-32768, 32767], 'new.Uint16Array': [0, 65535],
  'new.Int8Array.view': [-128, 127], 'new.Uint8Array.view': [0, 255], 'new.Uint8ClampedArray.view': [0, 255],
  'new.Int16Array.view': [-32768, 32767], 'new.Uint16Array.view': [0, 65535],
}

/** Memoized per-function set of interval-proven `recv[idx]` keys (AdHocMemo
 *  retirement — see inBoundsCharCodeAt's comment for the WeakMap idiom, here
 *  getFactStore().ipProven/ipRanges, always populated together). */
export function intervalProvenIdx(ctx) {
  const body = ctx.func?.body
  if (!Array.isArray(body)) return NO_INTERVAL_PROVEN
  const cache = getFactStore().ipProven
  const hit = cache.get(body)
  if (hit) return hit
  const out = new Set(), ranges = new Map()
  const lens = (name) => ctx.func.typedLen?.get(name) ?? ctx.scope?.globalTypedLen?.get(name)
    ?? ctx.func.localReps?.get(name)?.arrayLen ?? null
  scanIntervalIdx(body, out, lens, ranges)
  cache.set(body, out)
  getFactStore().ipRanges.set(body, ranges)
  return out
}

/** Idx-interval hulls the walk computed but could not discharge (receiver length
 *  unknown) — the versioning guard closes them with a runtime `hi < len`. */
export function intervalIdxRanges(ctx) {
  intervalProvenIdx(ctx)
  const body = ctx.func?.body
  return getFactStore().ipRanges.get(body) || NO_INTERVAL_RANGES
}
const NO_INTERVAL_RANGES = new Map()
const NO_INTERVAL_PROVEN = new Set()
