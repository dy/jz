/**
 * Flow-sensitive type refinement.
 *
 * A `typeof x === 'string'` guard, an `instanceof` check, or an `Array.isArray(x)`
 * call inside an `if` cond proves something about `x` in the then-branch. Encoded
 * here as a `name → {val?, notString?}` Map (the "refinements" set) installed into
 * `ctx.func.refinements` for the duration of the branch.
 *
 * Lifecycle: every emit site that descends into a conditional branch wraps the
 * inner emit() in `withRefinements(refs, body, () => emit(b))`. Saves/restores
 * the prior ctx state and skips refinement for names reassigned inside `body`
 * (refinement would be unsound).
 *
 * Read side: lookupValType (src/reps.js) checks ctx.func.refinements first —
 * see its lookup-priority docs.
 *
 * @module compile/flow-types
 */

import { ctx, getFactStore } from '../ctx.js'
import { VAL } from '../reps.js'
import { isReassigned, isBlockBody, alwaysReturns, TYPEOF, typeofPredicate } from '../ast.js'
import { constIntExpr } from '../static.js'
import { valTypeOfWithLocals, exprMayBeUndefinedIn } from '../kind.js'
import { TYPED_ELEM_NAMES } from '../../layout.js'

// Exported: the closure return-kind pre-pass (module/function.js, round-6
// prereq (a)) reuses this SAME table for its own typeof-guard walk instead of
// duplicating the typeof-code→VAL mapping. `bigint` was missing — BigInt is
// the one VAL kind with no runtime NaN-box tag (see kind.js VT['?:']'s own
// comment on this), but `typeof x === 'bigint'` still has a real (heuristic:
// finite, nonzero, sub-normal-magnitude f64) runtime check — emitTypeofCmp
// (src/compile/emit.js TYPEOF.bigint arm) — the SAME heuristic every other
// BigInt-carrier consumer in the compiler already trusts. Without this entry,
// a `typeof v === 'bigint'` guard proved nothing about `v` in either branch —
// not for real emission (this table's normal use, ctx.func.refinements) NOR
// for the closure pre-scan — even though the guard is the idiomatic way a
// closure param disambiguates BigInt-vs-Number (watr's uleb/limits `v => {
// if (typeof v === 'bigint') return v; … return BigInt(str) }`).
const TYPEOF_CODE_TO_VAL = { [TYPEOF.number]: VAL.NUMBER, [TYPEOF.string]: VAL.STRING, [TYPEOF.function]: VAL.CLOSURE, [TYPEOF.bigint]: VAL.BIGINT }
export { TYPEOF_CODE_TO_VAL }

/** Walk a boolean condition gathering refinements implied for the `sense` branch
 *  (sense=true = then-branch, sense=false = else-branch). `out` is a Map mutated
 *  in place; returns the same Map for chaining. */
export function extractRefinements(cond, out, sense = true) {
  if (!Array.isArray(cond)) return out
  const op = cond[0]
  // ! flips sense
  if (op === '!') return extractRefinements(cond[1], out, !sense)
  // && under positive sense refines with union of both branches.
  // || under negative sense (De Morgan) similarly refines the else-branch.
  if (op === '&&' && sense)  { extractRefinements(cond[1], out, true);  extractRefinements(cond[2], out, true);  return out }
  if (op === '||' && !sense) { extractRefinements(cond[1], out, false); extractRefinements(cond[2], out, false); return out }
  // typeof x == 'number' | 'string' | 'function' — sense must be positive for "==", negative for "!="
  // Ordered int compares refine a name's closed integer hull for the guarded
  // arm (`x >= 0 && x < W` → x ∈ [0, W-1] inside the chain — the int twin of
  // the discriminant refinements; trace's dominating bounds conjuncts).
  // Consumers (intExprRange via mul/div/index proofs) are gated on the name
  // being i32-typed, so the int tightening (K−1 for `<`) is sound there.
  if (op === '<' || op === '<=' || op === '>' || op === '>=') {
    refineIntCompareRange(op, cond[1], cond[2], out, sense)
    return out
  }
  if ((op === '==' || op === '===' || op === '!=' || op === '!==')) {
    const positiveEq = (op === '==' || op === '===') ? sense : !sense
    if (positiveEq) refineIntegerDiscriminant(cond[1], cond[2], out)
    else excludeIntegerDiscriminant(cond[1], cond[2], out)
    const tp = typeofPredicate(cond)
    if (tp) {
      const wantPositive = tp.eq ? sense : !sense
      if (wantPositive) {
        const val = TYPEOF_CODE_TO_VAL[tp.code]
        if (val) mergeRefinement(out, tp.name, { val })
      } else if (tp.code === 'string' || tp.code === TYPEOF.string) {
        // Negative branch of typeof-string guard (e.g. post `if (typeof x === 'string') return`)
        // proves the binding is not a primitive string in the suffix scope — feeds B4's
        // length / subscript dispatch elision the same way write-shape evidence does.
        mergeRefinement(out, tp.name, { notString: true })
      }
    }
    return out
  }
  // Type-predicate calls under positive sense — refine by the asserted VAL.
  // Callee may be the flattened string 'Array.isArray' or the raw ['.', 'Array',
  // 'isArray'] pair; __is_map / __is_set / __is_typed were jzify's OWN pre-audit-#8
  // instanceof lowering as a bare string callee — jzify now passes Array/Map/Set/
  // TypedArray/ArrayBuffer/Error-family `instanceof` straight through as a real
  // `['instanceof', name, rhs]` node instead (see the case just below), but this
  // arm stays for any other caller still shaped as a direct predicate call.
  if (op === '()' && sense && typeof cond[2] === 'string') {
    const callee = cond[1]
    const val = predicateRefinement(callee)
    if (val != null) { mergeRefinement(out, cond[2], { val }); return out }
  }
  // `x instanceof Array/Map/Set/<TypedCtor>/ArrayBuffer` under positive sense
  // (.work/todo.md §deletion-sweep §4's sound instanceof op — src/prepare/index.js's
  // handler, reached in BOTH strict source and default-mode source since
  // audit-#8 P0-1 made jzify pass these through instead of answering them
  // itself). Same refinement as the predicate-call arm above, keyed off the
  // RHS class name instead of a callee string.
  if (op === 'instanceof' && sense && typeof cond[1] === 'string' && typeof cond[2] === 'string') {
    const val = instanceofRefinement(cond[2])
    if (val != null) { mergeRefinement(out, cond[1], { val }); return out }
  }
  return out
}

/** When an exact integer comparison uses an immutable `obj.tag` alias,
 * select the matching censused schema as a guarded fast-path hint. The runtime
 * sid guard remains the proof; the census only orders speculation. */
function refineIntegerDiscriminant(a, b, out) {
  const lit = n => typeof n === 'number' && Number.isInteger(n) ? n
    : Array.isArray(n) && n[0] == null && Number.isInteger(n[1]) ? n[1]
    : null
  let name, value
  const bv = lit(b), av = lit(a)
  if (typeof a === 'string' && bv != null) { name = a; value = bv }
  else if (typeof b === 'string' && av != null) { name = b; value = av }
  else return

  const alias = constPropAliases().get(name)
  if (!alias || ctx.module.writtenProps?.has(alias.prop)) return

  // CLOSED-UNION PROOF channel: the receiver provably holds one of a closed
  // schema set (`const o = rows[i]` over a censused heterogeneous stream —
  // rep.schemaIdSet, or an enclosing refinement's narrowed set). Inside
  // `tag === C`, members whose censused const tag differs from C cannot reach
  // this branch, and members LACKING the tag prop read `undefined` (≠ C) — both
  // excluded. A member whose tag isn't censused-const stays in (superset-sound).
  // The result is a PROOF — schemaId/schemaIds refinement, raw slot reads, NO
  // runtime guard — because the union's closure already excludes host/foreign
  // objects. Without a closed set, fall back to the speculation hint below.
  const closedSet = ctx.func.refinements?.get(alias.obj)?.schemaIdSet
    ?? ctx.func.localReps?.get(alias.obj)?.schemaIdSet
  if (closedSet?.length) {
    const matches = []
    for (const sid of closedSet) {
      const slot = ctx.schema.list[sid]?.indexOf(alias.prop) ?? -1
      if (slot < 0) continue
      const cv = ctx.schema.slotConstInts?.get(sid)?.[slot]
      if (cv === value || cv == null) matches.push(sid)
    }
    if (matches.length) {
      // Agreeing-slot map across the narrowed members: singleton → the full
      // schema; union → every prop laid at one shared slot in all members.
      const schemaSlots = new Map()
      for (const prop of ctx.schema.list[matches[0]] || []) {
        let slot = ctx.schema.list[matches[0]].indexOf(prop)
        for (let i = 1; i < matches.length && slot >= 0; i++)
          if (ctx.schema.list[matches[i]]?.indexOf(prop) !== slot) slot = -1
        if (slot >= 0) schemaSlots.set(prop, slot)
      }
      const fact = { val: VAL.OBJECT, schemaIds: matches, schemaIdSet: matches, schemaSlots }
      if (matches.length === 1) fact.schemaId = matches[0]
      mergeRefinement(out, alias.obj, fact)
      return
    }
    return
  }

  const matches = []
  for (let sid = 0; sid < ctx.schema.list.length; sid++) {
    if (ctx.schema.externSlotSids?.has(sid)) continue
    const slot = ctx.schema.list[sid]?.indexOf(alias.prop) ?? -1
    if (slot >= 0 && ctx.schema.slotConstInts?.get(sid)?.[slot] === value) matches.push(sid)
  }
  // This is a speculation hint, never a proof: host/external objects or a
  // construction site with a dynamic tag may share the same runtime value.
  // emitBranch must retain an exact-sid guard and the original dynamic fallback.
  if (matches.length === 1) mergeRefinement(out, alias.obj, { schemaHint: matches[0] })
}

/** Negative-sense twin: inside the ELSE of `tag === C` (or the then of !==),
 *  a CLOSED-union receiver excludes the members whose censused tag const IS C
 *  — the chained else-if ladder then narrows level by level until the trailing
 *  else holds a singleton (the verifier's exclusion mirror; unknown-const
 *  members are kept — superset-sound). Open receivers get nothing (a hint
 *  would be speculation with no guard to back it). */
function excludeIntegerDiscriminant(a, b, out) {
  const lit = n => typeof n === 'number' && Number.isInteger(n) ? n
    : Array.isArray(n) && n[0] == null && Number.isInteger(n[1]) ? n[1]
    : null
  let name, value
  const bv = lit(b), av = lit(a)
  if (typeof a === 'string' && bv != null) { name = a; value = bv }
  else if (typeof b === 'string' && av != null) { name = b; value = av }
  else return
  const alias = constPropAliases().get(name)
  if (!alias || ctx.module.writtenProps?.has(alias.prop)) return
  const closedSet = out.get(alias.obj)?.schemaIdSet
    ?? ctx.func.refinements?.get(alias.obj)?.schemaIdSet
    ?? ctx.func.localReps?.get(alias.obj)?.schemaIdSet
  if (!closedSet?.length) return
  const rest = closedSet.filter(sid => {
    const slot = ctx.schema.list[sid]?.indexOf(alias.prop) ?? -1
    if (slot < 0) return true                       // missing prop reads undefined ≠ C — stays
    const cv = ctx.schema.slotConstInts?.get(sid)?.[slot]
    return cv == null || cv !== value
  })
  if (!rest.length || rest.length === closedSet.length) return
  const schemaSlots = new Map()
  for (const prop of ctx.schema.list[rest[0]] || []) {
    let slot = ctx.schema.list[rest[0]].indexOf(prop)
    for (let i = 1; i < rest.length && slot >= 0; i++)
      if (ctx.schema.list[rest[i]]?.indexOf(prop) !== slot) slot = -1
    if (slot >= 0) schemaSlots.set(prop, slot)
  }
  const fact = { val: VAL.OBJECT, schemaIds: rest, schemaIdSet: rest, schemaSlots }
  if (rest.length === 1) fact.schemaId = rest[0]
  mergeRefinement(out, alias.obj, fact)
}

/** Map immutable `const tag = obj.kind` aliases in the current function.
 *  Memoised per body (AdHocMemo retirement — ctxfunc-survey.md §2/§5: WeakMap
 *  on body identity, getFactStore().constPropAliases, same idiom as
 *  type.js's inBoundsCharCodeAt). A non-array body (no active function) can't
 *  be a WeakMap key and can't contain any alias anyway — returns a fresh
 *  empty Map, uncached, matching the walk's own no-op on a non-array root. */
function constPropAliases() {
  const body = ctx.func.body
  if (!Array.isArray(body)) return new Map()
  const cache = getFactStore().constPropAliases
  const hit = cache.get(body)
  if (hit) return hit
  const out = new Map()
  const walk = (n, root = false) => {
    if (!Array.isArray(n)) return
    if (!root && (n[0] === '=>' || n[0] === 'function')) return
    if (n[0] === 'const') for (let i = 1; i < n.length; i++) {
      const d = n[i]
      if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' &&
          Array.isArray(d[2]) && d[2][0] === '.' &&
          typeof d[2][1] === 'string' && typeof d[2][2] === 'string')
        out.set(d[1], { obj: d[2][1], prop: d[2][2] })
    }
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  walk(body, true)
  cache.set(body, out)
  return out
}

/** Map a call-callee shape to the VAL kind it asserts under positive sense, or null. */
export function predicateRefinement(callee) {
  if (callee === 'Array.isArray') return VAL.ARRAY
  if (Array.isArray(callee) && callee[0] === '.' && callee[1] === 'Array' && callee[2] === 'isArray')
    return VAL.ARRAY
  if (callee === '__is_map') return VAL.MAP
  if (callee === '__is_set') return VAL.SET
  if (callee === '__is_typed') return VAL.TYPED
  return null
}

/** Map an `instanceof` RHS class name to the VAL kind it asserts under positive
 *  sense, or null. Mirrors predicateRefinement above for the real `instanceof`
 *  op (.work/todo.md §deletion-sweep §4) — every TYPED_ELEM_NAMES ctor narrows to the
 *  same generic VAL.TYPED tier __is_typed used to (element-type precision isn't
 *  a refinement fact this pass tracks). Error-family RHS names are deliberately
 *  NOT mapped: their LHS can be a real Error OBJECT or an internal NUMBER code
 *  (.work/todo.md §deletion-sweep §3(b)) — a positive `instanceof` here proves OBJECT,
 *  but that's not new information a generic OBJECT-kind receiver didn't already
 *  have, so there's no refinement value in adding it. */
export function instanceofRefinement(rhs) {
  if (rhs === 'Array') return VAL.ARRAY
  if (rhs === 'Map') return VAL.MAP
  if (rhs === 'Set') return VAL.SET
  if (rhs === 'ArrayBuffer') return VAL.BUFFER
  if (TYPED_ELEM_NAMES.includes(rhs)) return VAL.TYPED
  return null
}

/** Merge a refinement fact into the per-name slot. Later facts override; non-overlapping
 *  fields union. Keeps the call-side simple (always assign through this). */
/** `name OP const` (either side) under `sense` → tightest closed int bound.
 *  Bounds come from constIntExpr (literals + module const-ints), so a named
 *  W/H/MASK proves like a literal. Repeated conjuncts intersect. */
function refineIntCompareRange(op, a, b, out, sense) {
  const ka = constIntExpr(a), kb = constIntExpr(b)
  let name = null, k = null, dir = op
  if (typeof a === 'string' && kb != null && Number.isInteger(kb)) { name = a; k = kb }
  else if (typeof b === 'string' && ka != null && Number.isInteger(ka)) {
    name = b; k = ka
    dir = op === '<' ? '>' : op === '<=' ? '>=' : op === '>' ? '<' : '<='
  } else return
  if (!sense) dir = dir === '<' ? '>=' : dir === '<=' ? '>' : dir === '>' ? '<=' : '<'
  if (dir === '<') { dir = '<='; k = k - 1 }
  if (dir === '>') { dir = '>='; k = k + 1 }
  const cur = out.get(name)
  if (dir === '<=') mergeRefinement(out, name, { rhi: cur?.rhi != null ? Math.min(cur.rhi, k) : k })
  else mergeRefinement(out, name, { rlo: cur?.rlo != null ? Math.max(cur.rlo, k) : k })
}

export function mergeRefinement(out, name, fact) {
  const cur = out.get(name)
  out.set(name, cur ? { ...cur, ...fact } : fact)
}

/**
 * Find a profitable branch-local schema speculation.
 *
 * A branch that reads several fields from one unresolved receiver often narrows
 * to exactly one registered schema even when ordinary value-flow cannot prove
 * it (tagged unions are the canonical shape). The emitter can guard that schema
 * once, emit a direct-slot fast body, and retain the original dynamic body as
 * the fallback. The runtime guard, not this census, is the soundness proof.
 *
 * Returns the best `{ name, schemaIds, schemaSlots, accesses }`, or null. Nested closures are
 * excluded: they may run after the guarded branch and outlive its refinement.
 */
export function inferSchemaBranch(body) {
  const schemas = ctx.schema?.list
  if (!schemas?.length) return null
  const byName = new Map()
  const walk = (n) => {
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op === '=>' || op === 'function') return
    if (op === '.' && typeof n[1] === 'string' && typeof n[2] === 'string') {
      let row = byName.get(n[1])
      if (!row) byName.set(n[1], row = { props: new Set(), accesses: 0 })
      row.props.add(n[2]); row.accesses++
    }
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  walk(body)

  let best = null
  for (const [name, row] of byName) {
    // One read already has the ordinary guarded-slot/devirt path. Version only
    // when a single guard amortizes over multiple dynamic accesses.
    if (row.accesses < 2 || isReassigned(body, name)) continue
    if (ctx.schema.idOf?.(name) != null) continue
    const candidates = []
    for (let sid = 0; sid < schemas.length; sid++) {
      const schema = schemas[sid]
      let carriesAll = true
      for (const prop of row.props) if (schema.indexOf(prop) < 0) { carriesAll = false; break }
      if (carriesAll) candidates.push(sid)
    }
    if (!candidates.length) continue
    // A bounded schema UNION is just as direct when every candidate lays each
    // accessed field at the same slot. Guard membership once, then all reads
    // share fixed offsets (e.g. {r} and {r,s}, or {w,h} and {w,h,d}).
    const schemaSlots = new Map()
    let compatible = true
    for (const prop of row.props) {
      const slot = schemas[candidates[0]].indexOf(prop)
      for (let i = 1; i < candidates.length; i++)
        if (schemas[candidates[i]].indexOf(prop) !== slot) { compatible = false; break }
      if (!compatible) break
      schemaSlots.set(prop, slot)
    }
    if (!compatible) continue
    const candidate = {
      name, schemaIds: candidates, schemaId: candidates.length === 1 ? candidates[0] : null,
      schemaSlots, accesses: row.accesses,
    }
    if (!best || candidate.accesses > best.accesses) best = candidate
  }
  return best
}

/** Apply refinements for the duration of `fn()`. Restores prior state on return/throw. */
export function withRefinements(refs, body, fn) {
  if (!refs || refs.size === 0) return fn()
  const cur = ctx.func.refinements
  // Drop names that are reassigned in the body — refinement would be unsound.
  const saved = []
  for (const [name, val] of refs) {
    if (isReassigned(body, name)) continue
    saved.push([name, cur.get(name)])
    cur.set(name, val)
  }
  try { return fn() }
  finally {
    for (const [name, prev] of saved) {
      if (prev === undefined) cur.delete(name); else cur.set(name, prev)
    }
  }
}

/**
 * Round-6 prereq (a): closure return-kind pre-pass.
 *
 * Derives a closure body's unified return-tail VAL kind directly from its raw
 * AST — no compiled form required — so it can run BEFORE the closure itself
 * compiles. Called from module/function.js's ctx.closure.make: derives a
 * closure's kind at CREATION time (the closure literal must be bound to
 * something before it can be called, so this always finishes before any
 * later direct call site in program order), stored in ctx.closure.valResult
 * for calleeValType (kind-traits.js) to read.
 *
 * NOT (yet) called from narrow.js's narrowValResults (Phase E2, "planning" —
 * runs even before any closure is compiled OR created): a function that
 * directly returns a call to its OWN freshly-declared local closure (`let
 * parse = (v) => …; return parse(v)`, watr's own uleb/limits shape) would
 * need this even EARLIER, to let the ENCLOSING function's own valResult see
 * through the call. That extension is pure AST-in/VAL-out exactly like this
 * function, and was prototyped, but a same-body call through a typeof-guarded
 * closure round-tripped correctly native while diverging under self-hosted
 * compilation (JZ_TEST_TARGET=jz.wasm) — reproduced identically across two
 * independent implementations of this same function, so the divergence isn't
 * this algorithm's own shape. Left OUT rather than shipped uncertain; see
 * narrowValResults' own doc comment (src/compile/narrow.js) for the full
 * trail. A same-body `return parse(v)` tail simply stays unproven for now —
 * fails open, same as any other not-yet-provable callee.
 *
 * Kind-generic mirror of narrowValResults' return-tail unification — "every
 * return resolves to the same VAL.* kind" — via the shared resolver
 * (valTypeOfWithLocals, kind.js) — plus two things a plain function's return
 * sites don't need:
 *
 *  - LEAF collection unwraps both `if`/`return` control flow AND top-level
 *    ternaries into flat (expr, refined-kind-map) sites — `return c ? A : B`
 *    is the same fact as `if (c) return A; else return B` for this purpose,
 *    so both idioms feed one unification. A function that can fall off the
 *    end without returning (alwaysReturns fails) is skipped entirely: the
 *    implicit `undefined` tail has no kind to unify against.
 *  - branch-local `typeof` narrowing (extractRefinements, this module's own
 *    table just above — not a re-implementation) lets a guarded early return
 *    see its own proof: the watr uleb/limits shape `v => { if (typeof v ===
 *    'bigint') return v; …; return BigInt(str) }` only resolves BIGINT once
 *    the guarded `return v` knows v is bigint FROM the guard — v's own static
 *    kind is unproven standalone.
 *
 * `capturedKinds` (Map<name, VAL>) seeds identifier lookups. A name absent
 * from it (an unsettled capture, or a bare param) resolves null and any
 * return depending on it fails unification — fail-open by construction: this
 * never guesses past what capturedKinds already proves.
 */
// Copy-on-write: only allocates a new Map when a guard actually adds a fact,
// so a body with no typeof guards touches `refined` (== capturedKinds) zero
// times. Reuses extractRefinements/TYPEOF_CODE_TO_VAL (this module's own
// table, just above) — the ONE typeof-guard mechanism, not a re-implementation.
// && narrows both operands under positive sense; || narrows both under
// negative sense (De Morgan) — extractRefinements already does this itself
// for a compound cond, so a single top-level call covers a chain.
function crkBranchRefine(cond, refined, sense) {
  const facts = extractRefinements(cond, new Map(), sense)
  let out = refined
  for (const [name, fact] of facts) {
    if (!fact.val) continue
    if (out === refined) out = new Map(refined)
    out.set(name, fact.val)
  }
  return out
}

// Returns the flat list of { expr, refined } leaf sites for `expr` (unwrapping
// a top-level ternary into its two branches, each under its own refinement),
// or null if `expr` isn't reachable (never actually used — leaves always
// resolve; kept symmetric with crkWalkSites' null-on-bare-return contract).
function crkLeafSites(expr, refined) {
  if (Array.isArray(expr) && expr[0] === '?:') {
    const [, cond, a, b] = expr
    return crkLeafSites(a, crkBranchRefine(cond, refined, true))
      .concat(crkLeafSites(b, crkBranchRefine(cond, refined, false)))
  }
  return [{ expr, refined }]
}

// Returns the flat list of { expr, refined } return-tail sites reachable from
// statement node `n`, or null the instant a bare `return;` (undefined — kills
// unification) is found. Pure/functional on purpose (returns its result
// instead of pushing into a shared outer array) — no mutable state shared
// across the recursive calls.
function crkWalkSites(n, refined) {
  if (!Array.isArray(n)) return []
  const op = n[0]
  if (op === '=>') return []                              // nested closure — its own pass
  if (op === 'return') {
    if (n.length < 2) return null                          // bare return → undefined kills unification
    return crkLeafSites(n[1], refined)
  }
  if (op === 'if') {
    const t = crkWalkSites(n[2], crkBranchRefine(n[1], refined, true))
    if (t === null) return null
    if (n[3] == null) return t
    const e = crkWalkSites(n[3], crkBranchRefine(n[1], refined, false))
    return e === null ? null : t.concat(e)
  }
  let out = []
  for (let i = 1; i < n.length; i++) {
    const r = crkWalkSites(n[i], refined)
    if (r === null) return null
    out = out.concat(r)
  }
  return out
}

// Shared site-collection: both closureBodyReturnKind and its mayBeUndefined
// sibling below unify/OR-fold over the SAME return-tail sites (design's own
// "extend the join" instruction — a different site set would be a different,
// unjustified fact). Returns null iff there's no closed set of sites to fold
// (bare return / unreachable end), matching closureBodyReturnKind's own
// pre-extraction null contract.
function closureReturnSites(body, capturedKinds) {
  if (isBlockBody(body) && !alwaysReturns(body)) return null
  const sites = isBlockBody(body) ? crkWalkSites(body, capturedKinds) : crkLeafSites(body, capturedKinds)
  return sites === null || !sites.length ? null : sites
}

export function closureBodyReturnKind(body, capturedKinds) {
  const sites = closureReturnSites(body, capturedKinds)
  if (!sites) return null
  const kindOf = (site) => valTypeOfWithLocals(site.expr, name => site.refined.get(name))
  const kind0 = kindOf(sites[0])
  if (!kind0) return null
  for (let i = 1; i < sites.length; i++) if (kindOf(sites[i]) !== kind0) return null
  return kind0
}

/**
 * mayBeUndefined return-kind join (Slice 2, .work/todo.md
 * §deletion-sweep §3 "Return kinds") — the closureBodyReturnKind sibling:
 * same return-tail sites (closureReturnSites), OR-folded instead of unified —
 * any site whose expr is itself census-shaped, or a bare name tracing
 * (through the body's own writes) to one, makes the WHOLE closure's result
 * maybeUndefined. `exprMayBeUndefinedIn` (kind.js) is ctx-independent by
 * construction — sound to call here, at closure-CREATION time, before this
 * closure body has compiled and installed its own ctx.func.localReps (the
 * same reasoning narrow.js's param/return joins document for why they can't
 * trust the real, ctx-aware census either at their own plan-time fixpoint).
 * A separate function (not folded into closureBodyReturnKind's own return)
 * because that function's return shape — a bare VAL.* string — has a live
 * consumer (kind-traits.js calleeValType) this slice must not disturb.
 */
export function closureBodyReturnMayBeUndefined(body, capturedKinds) {
  const sites = closureReturnSites(body, capturedKinds)
  if (!sites) return false
  return sites.some(site => exprMayBeUndefinedIn(site.expr, body))
}
