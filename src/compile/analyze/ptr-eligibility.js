/**
 * Per-function pointer/CSE eligibility passes — which locals can be stored
 * as an unboxed i32 pointer offset (unboxablePtrs), plan-time ptrKind
 * inheritance for decl aliases (inheritPtrAliases), and CSE-safe scalar
 * load bases (cseSafeLoadBases). Grouped together: all three are per-
 * function pointer-representation eligibility analyses, imported together
 * at every call site (index.js). Split out of analyze.js (pipeline-
 * minimality slice); see analyze.js's module header for the full split
 * rationale and `.work/archive/analyze-traversals.md` for the traversal inventory.
 *
 * @module compile/analyze/ptr-eligibility
 */
import { MUTATE_OPS, isI32, walkAst } from '../../ast.js'
import { ctx } from '../../ctx.js'
import { VAL, repOfGlobal, updateRep } from '../../reps.js'
import { valTypeOf } from '../../kind.js'
import { exprType } from '../../type.js'
import { typedStorageCtorFromContext } from '../../typed-context.js'
import { scanBindingUses, USE, BINDING_USE_INIT, BINDING_USE_USES, BINDING_USE_KIND, BINDING_USE_NULL_CMP } from '../analyze-scans.js'

// A directly-uint32 expression: `x >>> 0` (zero-fill shift) or a call to a function
// already proven `unsignedResult`. Such a value lives in i32 but ranges [0, 2^32),
// so signed i32 ops on it are wrong — exprType widens its arithmetic to f64 to
// match emit (which reboxes via `f64.convert_i32_u`). Unsignedness through a local
// assignment is intentionally not tracked here — kept in lockstep with narrow.js's
// `isUnsignedTail`, so emit and exprType agree (no trunc_sat saturation).

// `analyzeBody` was inlined to `analyzeBody(body).locals` at its three real
// call sites in src/compile.js and src/narrow.js — the one-line facade existed
// only as a historical surface and obscured the unified-walk relationship.

/**
 * Identify locals that can be stored as an unboxed i32 pointer offset instead of
 * a NaN-boxed f64. Static type is tracked out-of-band so reads skip `__ptr_offset`
 * and `__ptr_type` entirely and writes unbox once at the assignment site.
 *
 * Criteria — the local must be:
 *   - declared once with `let`/`const`, never reassigned or compound-assigned
 *   - valType is an unambiguous non-forwarding pointer kind:
 *       OBJECT, SET, MAP, CLOSURE, TYPED, BUFFER
 *     (excluded: ARRAY — forwards on realloc; STRING — SSO/heap dual encoding.)
 *   - initialized from a form that guarantees a fresh, non-null pointer of that VAL:
 *       OBJECT ← `{…}`
 *       SET    ← `new Set(...)`
 *       MAP    ← `new Map(...)`
 *       CLOSURE← `=>` literal
 *       BUFFER ← `new ArrayBuffer(...)`
 *       TYPED  ← `new XxxArray(...)` / method returning typed array
 *                (`new DataView(...)` is TYPED but stays boxed — no elem aux)
 *   - not captured in boxed storage (boxed locals stay f64 for the heap slot)
 *   - never compared to null/undefined (we lose the nullish NaN representation)
 *
 * Returns Map<name, VAL> of locals to unbox.
 */
export function unboxablePtrs(body, locals, boxed) {
  const valOf = name => ctx.func.localReps?.get(name)?.val
  const UNBOXABLE_KINDS = new Set([VAL.OBJECT, VAL.SET, VAL.MAP, VAL.BUFFER, VAL.TYPED, VAL.CLOSURE, VAL.DATE])

  // RHS must produce a fresh, non-null pointer of the declared VAL kind.
  //   OBJECT  ← `{…}`
  //   CLOSURE ← `=>`
  //   SET/MAP/BUFFER/TYPED ← `new X(...)`
  // Validating the exact ctor→VAL match keeps the analysis tied to valTypeOf, so when
  // that helper grows (e.g. `Array.from` → ARRAY), we don't drift out of sync.
  const isFreshInit = (expr, kind) => {
    if (!Array.isArray(expr)) return false
    if (kind === VAL.OBJECT) {
      if (expr[0] === '{}') return true
      // Call to a narrow-ABI'd helper: returns i32 ptr-offset of the same VAL kind.
      // Unboxing skips the f64-rebox at the callsite. Verifying via sig (not just
      // valResult) ensures the call already produces an i32 — which dual-write picks
      // up to bind ptrKind/schemaId on the local.
      if (expr[0] === '()' && typeof expr[1] === 'string') {
        const f = ctx.funcs.map?.get(expr[1])
        return f?.sig?.ptrKind === kind
      }
      // `let p = arr[i]` where arr has a known elem schema: the runtime helper
      // returns f64 (NaN-box of an OBJECT pointer), but its low 32 bits are
      // exactly the pointer offset. Dual-write coerces once via reinterpret/wrap;
      // subsequent `p.x` reads then become direct `f64.load offset=K (local.get $p)`
      // (since ptrOffsetIR sees ptrKind=OBJECT and skips the per-access wrap).
      if (expr[0] === '[]' && typeof expr[1] === 'string') {
        const r = ctx.func.localReps?.get(expr[1])
        if (r?.arrayElemSchema != null) return true
        // Closed-union element: an OBJECT of some member schema on EITHER
        // layout (plain ptr or inline cell) — unboxing to a raw offset is
        // valid regardless of whether unionInlinePass (which runs later)
        // admits the packed carrier.
        return (r?.arrayElemSchemaSet?.length ?? 0) >= 2
      }
      return false
    }
    if (kind === VAL.CLOSURE) return expr[0] === '=>'
    if (expr[0] === '()' && typeof expr[1] === 'string') {
      const callee = expr[1]
      if (callee.startsWith('new.')) {
        if (kind === VAL.SET) return callee === 'new.Set'
        if (kind === VAL.MAP) return callee === 'new.Map'
        if (kind === VAL.DATE) return callee === 'new.Date'
        if (kind === VAL.BUFFER) return callee === 'new.ArrayBuffer'
        if (kind === VAL.TYPED) return callee.endsWith('Array') && callee !== 'new.ArrayBuffer'
      }
      // Call to narrow-ABI'd helper of matching VAL kind.
      const f = ctx.funcs.map?.get(callee)
      if (f?.sig?.ptrKind === kind) return true
    }
    // Every concrete typed-result chain (map/filter/slice/change-by-copy,
    // subarray views, and receiver-returning mutators) is a fresh/non-null
    // typed pointer. The shared provenance helper owns method semantics.
    if (kind === VAL.TYPED && typedStorageCtorFromContext(ctx, expr)) return true
    return false
  }
  // A policy over `scanBindingUses`: an UNBOXABLE-kind `let/const` local with a
  // fresh-pointer initializer stays unboxable unless some use forbids it. The
  // only forbidding uses are a reassignment (`=`/compound/`++`/`--`) or a
  // null/undefined comparison (an unboxed pointer has no nullish NaN form).
  // Closure captures do not disqualify — a capture-*mutated* local is already
  // in `boxed`, and a capture-*read* leaves the pointer in its own slot.
  const result = new Map()
  for (const [name, s] of scanBindingUses(body)) {
    const vt = valOf(name)
    if (!UNBOXABLE_KINDS.has(vt)) continue
    if (locals.get(name) !== 'f64') continue
    if (boxed?.has(name)) continue
    if (!isFreshInit(s[BINDING_USE_INIT], vt)) continue
    const ok = s[BINDING_USE_USES].every(u =>
      u[BINDING_USE_KIND] !== USE.REASSIGN &&
      !(u[BINDING_USE_KIND] === USE.COMPARE && u[BINDING_USE_NULL_CMP]))
    if (ok) result.set(name, vt)
  }
  return result
}

/**
 * Plan-time ptrKind inheritance for decl inits (slice-4 P1 predictor).
 *
 * The class `unboxablePtrs` rejects but emit resolves anyway: a `let/const`
 * whose init VALUE is already an unboxed pointer, where the binding itself is
 * later reassigned — radixsort's ping-pong (`let a = src, b = tmp; …
 * const t = a; a = b; b = t`). analyzeBody types the local i32 (RHS is an i32
 * pointer), so without the inherited ptrKind a read reboxes numerically
 * instead of via reinterpret.
 *
 * Predicts exactly what emitDecl's `val.ptrKind` observes, from the same
 * sources it derives from:
 *   bare local  → readVar tag: repOf(y).ptrKind, aux = ptrAux ?? schema.idOf(y)
 *                 (intConst substitution carries no tag — mirrored)
 *   bare global → tag iff i32-stored && repOfGlobal(y).ptrKind (constInts /
 *                 constNums substitutions carry no tag — mirrored)
 *   direct call → attachSigMeta: ctx.funcs.map.get(f).sig.ptrKind / ptrAux
 *
 * Program-order walk so alias chains (`a ← src; t ← a`) resolve through reps
 * exactly as sequential emitDecl calls would; nested '=>' bodies are skipped
 * (each closure runs its own plan pass). Names written here are recorded in
 * `ctx.func.p1Predicted`; the emit site ASSERTS agreement (both directions)
 * under JZ_DEBUG_INVARIANTS instead of writing.
 */
export function inheritPtrAliases(body, locals, boxed) {
  const isGlobalName = n => ctx.scope.globals.has(n) && !locals?.has(n) &&
    !ctx.func.current?.params?.some(p => p.name === n)
  const predictPtr = init => {
    if (typeof init === 'string') {
      const y = init
      if (boxed?.has(y)) return null
      if (isGlobalName(y)) {
        if (ctx.scope.constInts?.get?.(y) != null && isI32(ctx.scope.constInts.get(y))) return null
        if (ctx.scope.constNums?.get?.(y) != null) return null
        if ((ctx.scope.globalTypes.get(y) || 'f64') !== 'i32') return null
        const g = repOfGlobal(y)
        return g?.ptrKind != null ? { ptrKind: g.ptrKind, ptrAux: g.ptrAux ?? null } : null
      }
      const r = ctx.func.localReps?.get(y)
      if (r?.intConst != null) return null
      if (r?.ptrKind != null) return { ptrKind: r.ptrKind, ptrAux: r.ptrAux ?? ctx.schema.idOf?.(y) ?? null }
      return null
    }
    if (Array.isArray(init) && init[0] === '()' && typeof init[1] === 'string') {
      const f = ctx.funcs.map?.get(init[1])
      if (f?.sig?.ptrKind != null) return { ptrKind: f.sig.ptrKind, ptrAux: f.sig.ptrAux ?? null }
    }
    return null
  }
  const predicted = (ctx.func.p1Predicted ??= new Set())
  walkAst(body, { enter: node => {
    const op = node[0]
    if (op === '=>') return false
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') continue
        const name = d[1]
        if (locals.get(name) !== 'i32' || boxed?.has(name)) continue
        if (ctx.func.localReps?.get(name)?.ptrKind != null) continue
        const p = predictPtr(d[2])
        if (!p) continue
        updateRep(name, { ptrKind: p.ptrKind })
        predicted.add(name)
        if (p.ptrAux != null) {
          updateRep(name, { ptrAux: p.ptrAux })
          // OBJECT-only: aux IS the schemaId — mirror to schema.vars + rep so
          // .prop slot resolution binds precisely. TYPED/CLOSURE aux carries
          // other semantics (elem code / funcIdx). Poisoned names stay bare.
          if (p.ptrKind === VAL.OBJECT && !ctx.schema.vars?.has(name) && !ctx.schema.poisoned?.has(name)) {
            ctx.schema.vars.set(name, p.ptrAux)
            updateRep(name, { schemaId: p.ptrAux })
          }
        }
      }
      return false
    }
  } })
}

/**
 * CSE-safe load bases — `let/const` pointer locals whose `(f64.load offset=K $X)`
 * reads `cseScalarLoad` (src/optimize.js) may scalar-replace without a store
 * clobbering them. `cseScalarLoad` is module-wide disabled because it scanned
 * *every* i32 local; a store through an i32 local legitimately aliasing the load
 * base returned stale bytes. This pass is the missing soundness gate: a
 * per-function whitelist, each entry proven non-aliasing — guarantee, not guess.
 *
 * `X` qualifies iff ALL hold:
 *  (a) X is an unboxed pointer — `localReps.get(X).ptrKind` set, `locals[X]==='i32'`.
 *  (b) X is bound exactly once (no re-decl, no `=`/`++`/`--`/compound reassign).
 *  (c) Every occurrence of X is the receiver of a `.`/`?.`/`[]` *read* — never a
 *      write target, never a bare value (alias / arg / return / stored element),
 *      never captured by a closure. So X's pointer lives only in `$X`; nothing
 *      else holds it, and no store names it.
 *  (d) The allocation X's bytes live in is disjoint from every store target.
 *      jz allocations carry one kind each and distinct kinds never share bytes,
 *      so X is store-safe when every store's base has a determinable kind ≠ X's
 *      source kind. Any indeterminable store target disqualifies the whole set
 *      (a store through unknown memory could alias anything).
 *
 * (c)+(d): no store in the function can touch a cell reachable via `$X + K`, so
 * a load on `$X` is invariant between two control-flow boundaries — exactly
 * `cseScalarLoad`'s straight-line region model. Method-call mutations (`.push`,
 * …) need no accounting here: the pass already flushes its table on every call.
 *
 * Returns `Set<name>` — names only, no `$` prefix (the caller stamps it).
 */
export function cseSafeLoadBases(body, locals, localReps) {
  if (body === null || typeof body !== 'object') return new Set()

  // Allocation kind a pointer name's bytes live in: ptrKind (unboxed) wins,
  // else value-kind, else an array-schema'd binding is an ARRAY, else unknown.
  const kindOf = (name) => {
    if (typeof name !== 'string') return null
    const r = localReps?.get(name)
    return r?.ptrKind || r?.val || (r?.arrayElemSchema != null ? VAL.ARRAY : null) ||
      ctx.scope.globalValTypes?.get(name) || null
  }
  // X's bytes live in: the array/object an element read drew it from
  // (`X = src[i]` / `X = src.f`), else a fresh `{}`/`new` (X's own kind).
  const srcKind = (rhs) =>
    Array.isArray(rhs) && (rhs[0] === '[]' || rhs[0] === '.' || rhs[0] === '?.') &&
      typeof rhs[1] === 'string' ? kindOf(rhs[1]) : valTypeOf(rhs)

  // Pass 1 — bound-once unboxed-pointer candidates; record each source kind.
  const cand = new Map()                 // name → source allocation kind
  const declCount = new Map()
  const collect = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>') return
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const a = node[i]
        if (typeof a === 'string') { declCount.set(a, (declCount.get(a) || 0) + 1); continue }
        if (Array.isArray(a) && a[0] === '=' && typeof a[1] === 'string') {
          const name = a[1]
          declCount.set(name, (declCount.get(name) || 0) + 1)
          if (localReps?.get(name)?.ptrKind != null && locals.get(name) === 'i32')
            cand.set(name, srcKind(a[2]))
          collect(a[2])
        } else collect(a)
      }
      return
    }
    for (let i = 1; i < node.length; i++) collect(node[i])
  }
  collect(body)
  for (const [n, c] of declCount) if (c > 1) cand.delete(n)
  if (!cand.size) return new Set()

  // Pass 2 — every occurrence must be a `.`/`?.`/`[]` read receiver (c).
  const live = new Set(cand.keys())
  const walk = (node, inClosure) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === 'str') return
    const closured = inClosure || op === '=>'
    if (op === 'let' || op === 'const') {        // decl `=` — bound name is not a use
      for (let i = 1; i < node.length; i++) {
        const a = node[i]
        if (typeof a === 'string') continue
        if (Array.isArray(a) && a[0] === '=') {
          if (typeof a[1] !== 'string') walk(a[1], closured)
          walk(a[2], closured)
        } else walk(a, closured)
      }
      return
    }
    if (op === '.' || op === '?.' || op === '[]') {   // member READ — receiver is safe
      const o = node[1]
      if (typeof o === 'string') { if (inClosure && cand.has(o)) live.delete(o) }
      else walk(o, closured)
      if (op === '[]' && node[2] != null) walk(node[2], closured)
      return
    }
    if (MUTATE_OPS.has(op) || op === 'delete') {
      const t = node[1]                            // write target — X here disqualifies
      if (typeof t === 'string') { if (cand.has(t)) live.delete(t) }
      else if (Array.isArray(t) && (t[0] === '.' || t[0] === '?.' || t[0] === '[]') &&
               typeof t[1] === 'string' && cand.has(t[1])) live.delete(t[1])
      else walk(t, closured)
      for (let i = 2; i < node.length; i++) walk(node[i], closured)
      return
    }
    for (let i = 1; i < node.length; i++) {        // any other position — bare X escapes
      const c = node[i]
      if (typeof c === 'string') { if (cand.has(c)) live.delete(c) }
      else walk(c, closured)
    }
  }
  walk(body, false)
  if (!live.size) return live

  // Pass 3 — store-target disjointness (d). A store lands in `base`'s allocation.
  let unknownStore = false
  const storeKinds = new Set()
  walkAst(body, { enter: node => {
    const op = node[0]
    if (MUTATE_OPS.has(op) && Array.isArray(node[1]) &&
        (node[1][0] === '.' || node[1][0] === '?.' || node[1][0] === '[]') &&
        typeof node[1][1] === 'string') {
      const k = kindOf(node[1][1])
      if (k == null) unknownStore = true
      else storeKinds.add(k)
    }
  } })
  if (unknownStore) return new Set()

  const safe = new Set()
  for (const name of live) {
    const k = cand.get(name)
    if (k != null && !storeKinds.has(k)) safe.add(name)
  }
  return safe
}
