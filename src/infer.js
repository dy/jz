/**
 * src/infer — unified per-binding inference.
 *
 * Single front door for "what shape is this binding?". Evidence sources walk a
 * function body and report facts about a candidate name set; `inferParams`
 * runs every registered source and merges results (first source wins).
 *
 * ## Evidence ladder (strongest first, registration order = precedence)
 *
 *   1. Literal use         — `let x = 0`, `let s = ''`, `let xs = []`.    [done: analyzeValTypes]
 *   2. Operator use        — `s.charCodeAt(...)` → STRING.                 [done: method source]
 *   3. Member access       — `.push` / `.pop` → ARRAY; index/length-write
 *                            → notString.                                 [done: method + notString sources]
 *   4. `typeof` guard      — `typeof x === 'string'` flow-refines.         [done: extractRefinements + B3]
 *   5. Assignment flow     — `x = y` propagates y's evidence to x.        [done: analyzeValTypes]
 *   6. Comparison shape    — `x === null` proves nullable.                [out of scope: no nullable rep field, see C2]
 *   7. JSDoc `@type`       — explicit hint; advisory, not enforced.       [in prepare]
 *   8. Name heuristic      — last resort (e.g. `count`/`n`/`i` integer).  [out of scope]
 *
 * Rungs 1/5 live in `analyzeValTypes` rather than as registry sources because
 * they share the canonical body-walk machinery (regex tracking, typed-elem
 * tracking, JSON-shape, arr-elem schema, ternary unification) and lifting
 * them would duplicate that walker. Rung 4 lives in `extractRefinements`
 * because flow-scoped narrowing is per-branch, not param-wide — adding it as
 * a registry source would over-narrow params whose other branch handles a
 * non-string (callers correctly stay polymorphic in that case).
 *
 * Ambiguous bindings stay nanbox-tagged f64. Default is never wrong, only
 * sometimes wider than necessary.
 *
 * ## Source contract
 *
 *   `(body, candidates: string[]) => Map<name, { val?: VAL, … }>`
 *
 * Sources see the full body AST and a candidate-name set. They return only
 * names for which they have definite evidence. `{ val }` is canonical; future
 * sources may add `arrayElemValType`, `intConst`, etc. — `inferParams` returns
 * the full fact, and the caller passes it straight to `updateRep`.
 *
 * Convenience readers (`infer`, `facts`) sit at the bottom for hot-path
 * lookups after passes have populated the per-binding rep.
 *
 * @module src/infer
 */

import { ctx } from './ctx.js'
import {
  VAL, collectParamNames, valTypeOf,
  updateRep, updateGlobalRep, analyzeValTypes, analyzeIntCertain,
  staticObjectProps, typedElemCtor, ctorFromElemAux,
} from './analyze.js'
import { shapeOfObjectLiteral } from './shape.js'

// === typeof predicate helper ==============================================
//
// `typeof name == lit` / `!= lit` is the canonical narrowing predicate.
// Two consumers — body-walk evidence (`notStringEvidence` below) and
// flow-sensitive refinement (`extractRefinements` in src/emit.js) — used to
// re-implement the recognizer independently with diverging tolerances for
// the literal form (raw `'string'` vs prepare-normalized typeof-code `-2`).
// The helper accepts both, so callers stop caring about the normalization
// boundary.

/** Match a `typeof name <op> lit` predicate. Returns `{ name, code, eq }` —
 *  `name` is the typeof's operand binding, `code` is either the raw type
 *  string ('string'|'number'|'function'|…) or the prepare-normalized typeof
 *  code (-1|-2|-3|-4|-5|-6, see TYPEOF_MAP in prepare.js), and `eq` is true
 *  for `==`/`===` (false for `!=`/`!==`). Returns null when the node isn't a
 *  typeof predicate. */
export function typeofPredicate(node) {
  if (!Array.isArray(node)) return null
  const op = node[0]
  if (op !== '==' && op !== '===' && op !== '!=' && op !== '!==') return null
  const a = node[1], b = node[2]
  const typeofSide = Array.isArray(a) && a[0] === 'typeof' && typeof a[1] === 'string' ? a
    : Array.isArray(b) && b[0] === 'typeof' && typeof b[1] === 'string' ? b : null
  if (!typeofSide) return null
  const litSide = typeofSide === a ? b : a
  const code = Array.isArray(litSide) && litSide[0] == null ? litSide[1] : null
  if (code == null) return null
  return { name: typeofSide[1], code, eq: op === '==' || op === '===' }
}

// === paramReps lattice primitives ==========================================
//
// `paramReps: Map<funcName, Map<paramIdx, ValueRep>>` is the cross-call fact
// lattice. Evidence sources (body-walk and call-site `infer*`) produce
// raw observations; these primitives apply them with sticky-null poison
// semantics: undefined → observe (set); equal → stay; disagreement → null
// (sticky). null is "no consensus" — readers treat it as missing.
//
// Lifecycle phases (chronological — readers should know which fields are
// valid at which point):
//
//   1. prepare      ─ no paramReps yet. AST walk collects callSites with raw
//                     arg lists; programFacts.paramReps is allocated empty.
//
//   2. collectProgramFacts ─ unchanged paramReps; aggregates module-global
//                     callSites, valueUsed, hasSchemaLiterals into
//                     programFacts. paramReps still empty here.
//
//   3. narrowSignatures phase D (call-site lattice) ─
//                     runCallsiteLattice merges raw call-site facts via
//                     mergeParamFact for fields: val, schemaId, intConst,
//                     arrayElemSchema, arrayElemValType, typedCtor, wasm.
//                     After D, these may be undefined/null/value.
//                     Sticky-null reachable on any field whose call sites
//                     disagreed.
//
//   4. validateIntConstParams ─ clears intConst on any param whose body
//                     contains a write to it (intConst's contract is "no
//                     writes after the call").
//
//   5. phase E / E2 / E3 (param ABI narrowing) ─
//                     applyI32ParamSpecialization sets sig.params[k].type
//                     to 'i32' based on rep.wasm consensus. Then
//                     applyPointerParamAbi sets rep.ptrKind on
//                     consistently-OBJECT/ARRAY/etc params; this prepares
//                     the i32-offset ABI for unboxed pointer params.
//
//   6. phase F (signature fixpoint) ─ clearStickyNull on val + schemaId,
//                     then re-runs D until stable. New evidence from
//                     newly-narrowed return types (valResult) can unstick.
//
//   7. phase G (narrowReturnArrayElems) ─ propagates Array<T> element
//                     facts back through return paths into caller param
//                     reps. After G, arrayElemSchema/arrayElemValType
//                     reflect the transitive closure.
//
//   8. phase H (applyTypedPointerParamAbi) ─ sets ptrKind=TYPED + ptrAux
//                     (elem code) for params whose val converged to TYPED.
//                     Depends on F having seeded val first.
//
//   9. phase I (resetParamWasmFacts + final i32 spec) ─ last WASM-level
//                     pass. After H/I, sig.params[k].type and rep.ptrKind
//                     are frozen for emit.
//
//  10. per-function compile (emit start) ─ each func reads its
//                     paramReps[name][k] and folds the consensus facts
//                     into ctx.func.localReps via updateRep. Locals and
//                     params then share one ValueRep store for the
//                     remainder of emit.

/** Per-call-site fact merge into a param's ValueRep field. */
export const mergeParamFact = (rep, key, observed) => {
  if (rep[key] === null) return                        // sticky poison
  if (observed == null) { rep[key] = null; return }    // unknown → poison
  if (rep[key] === undefined) rep[key] = observed
  else if (rep[key] !== observed) rep[key] = null
}

/** Get-or-create per-param rep at (funcName, paramIdx) on a paramReps map. */
export const ensureParamRep = (paramReps, funcName, k) => {
  let m = paramReps.get(funcName)
  if (!m) { m = new Map(); paramReps.set(funcName, m) }
  let r = m.get(k)
  if (!r) { r = {}; m.set(k, r) }
  return r
}

/** Reset sticky-null on a single field across all params program-wide.
 *  Used between fixpoint phases when newly-narrowed facts unblock previously-
 *  poisoned observations (e.g. valResult set after first pass). */
export const clearStickyNull = (paramReps, key) => {
  for (const m of paramReps.values()) for (const r of m.values()) {
    if (r[key] === null) r[key] = undefined
  }
}

// === Source registry =======================================================

const SOURCES = []

/** Register an evidence source. Insertion order = precedence: earlier sources
 *  win the merge for a given name. */
export const registerEvidence = (name, fn) => { SOURCES.push({ name, fn }) }

/** Infer per-name facts by running every registered evidence source.
 *  Returns Map<name, fact>; callers pass `fact` straight to updateRep.
 *
 *  Merge semantics: first source wins per FIELD. Sources contribute orthogonal
 *  facts (`methodEvidence` → `{val}`, future sources may add `{notString}`,
 *  `{intConst}`, etc.); a later source's field is only kept if no earlier
 *  source set the same key on the same name. */
export const inferParams = (body, candidates) => {
  if (!candidates || candidates.length === 0) return new Map()
  const merged = new Map()
  for (const { fn } of SOURCES) {
    const facts = fn(body, candidates)
    for (const [n, fact] of facts) {
      const prev = merged.get(n)
      merged.set(n, prev ? { ...fact, ...prev } : fact)
    }
  }
  return merged
}

// === Source: method evidence (rungs 2-3, member-access shape) ==============
//
// `name.method(...)` is the strongest cheap signal we get for the STRING vs
// ARRAY distinction. The method-name partition is three sets:
//
//   STRING_ONLY      — definite STRING (no Array/TypedArray equivalent)
//   ARRAY_INDUCERS   — definite plain Array (absent on String + TypedArray)
//   ARRAY_ONLY_POISON— Array + TypedArray (poisons tentative STRING, doesn't
//                      induce ARRAY because the receiver may still be TYPED)
//
// Reassignment to an unambiguously-typed RHS (`x = 0`) poisons the inference
// regardless of prior evidence — a later method call can't re-induce a shape
// already contradicted by an earlier scalar assignment.

const STRING_ONLY_METHODS = new Set([
  'charCodeAt', 'charAt', 'codePointAt', 'startsWith', 'endsWith',
  'toUpperCase', 'toLowerCase', 'toLocaleLowerCase', 'normalize', 'localeCompare',
  'padStart', 'padEnd', 'repeat', 'trimStart', 'trimEnd', 'trim',
  'matchAll', 'match', 'replace', 'replaceAll', 'split',
])
const ARRAY_ONLY_POISON = new Set([
  'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'fill', 'reverse',
  'flat', 'flatMap', 'copyWithin',
])
const ARRAY_INDUCERS = new Set([
  'push', 'pop', 'shift', 'unshift', 'splice', 'flat', 'flatMap',
])

const methodEvidence = (body, names) => {
  const scope0 = new Set(names)
  const evidence = new Map() // name → 'string' | 'array' | 'conflict'
  const induce = (name, kind) => {
    const prev = evidence.get(name)
    if (prev === 'conflict') return
    if (prev && prev !== kind) return evidence.set(name, 'conflict')
    evidence.set(name, kind)
  }
  function walk(node, scope) {
    if (!Array.isArray(node) || scope.size === 0) return
    const op = node[0]
    if (op === '=>') {
      // Nested arrow: drop shadowed names so an inner param of the same name
      // is treated independently. Captured names retain their outer evidence.
      const shadowed = collectParamNames([node[1]])
      let inner = scope
      for (const s of shadowed) {
        if (inner.has(s)) {
          if (inner === scope) inner = new Set(scope)
          inner.delete(s)
        }
      }
      walk(node[2], inner)
      return
    }
    if (op === '.' && typeof node[1] === 'string' && scope.has(node[1])) {
      const name = node[1]
      const m = node[2]
      if (typeof m === 'string') {
        if (STRING_ONLY_METHODS.has(m)) induce(name, 'string')
        else if (ARRAY_INDUCERS.has(m)) induce(name, 'array')
        else if (ARRAY_ONLY_POISON.has(m) && evidence.get(name) === 'string') {
          evidence.set(name, 'conflict')
        }
      }
    }
    if (op === '=' && typeof node[1] === 'string' && scope.has(node[1])) {
      const name = node[1]
      const vt = valTypeOf(node[2])
      if (vt && vt !== VAL.STRING && vt !== VAL.ARRAY) evidence.set(name, 'conflict')
      else if (vt === VAL.STRING && evidence.get(name) === 'array') evidence.set(name, 'conflict')
      else if (vt === VAL.ARRAY && evidence.get(name) === 'string') evidence.set(name, 'conflict')
    }
    for (let i = 1; i < node.length; i++) walk(node[i], scope)
  }
  walk(body, scope0)
  const out = new Map()
  for (const [n, ev] of evidence) {
    if (ev === 'string') out.set(n, { val: VAL.STRING })
    else if (ev === 'array') out.set(n, { val: VAL.ARRAY })
  }
  return out
}

registerEvidence('method', methodEvidence)

// === Source: not-string evidence (rung 3, write-shape) =====================
//
// Strings in JS are immutable: `s[i] = v` is silently dropped (strict throws),
// `s.length = n` likewise has no effect. An *unambiguous write* through
// `xs[i]` / `xs[i] op= v` / `xs.length = n` / `++xs.length` would prove the
// receiver isn't a primitive string — but param flow can mix shapes via
// `typeof x === 'string'` gates (e.g. watr's AST walker takes both array and
// string nodes). Without flow-sensitive refinement the narrowing turns
// soundly-mixed callers into miscompilations: a post-gate `node[0]` read
// would route through `__typed_idx` and return garbage on a string tag.
//
// So we require a *conservative* discharge: ANY string-shape evidence on the
// same name (typeof string check, STRING_ONLY_METHODS call, string-literal
// assignment) disables the narrow. Method evidence promoting to VAL.ARRAY
// (push/pop/etc.) wins via the merge regardless and subsumes notString. The
// remaining win: pure write+length-only params (e.g. `fill(buf, v)`) skip
// the runtime `__ptr_type==STRING` gate at every read.

const isLengthAccess = (n) =>
  Array.isArray(n) && n[0] === '.' && typeof n[1] === 'string' && n[2] === 'length'

const isIndexAccess = (n) =>
  Array.isArray(n) && n[0] === '[]' && typeof n[1] === 'string'

const isAssignOp = (op) =>
  typeof op === 'string' && (op === '=' || (op.length > 1 && op.endsWith('=') && op !== '==' && op !== '===' && op !== '!=' && op !== '!==' && op !== '<=' && op !== '>='))

const isStringLiteralRhs = (rhs) =>
  Array.isArray(rhs) && (rhs[0] === 'str' || (rhs[0] == null && typeof rhs[1] === 'string'))

const notStringEvidence = (body, names) => {
  const scope0 = new Set(names)
  const writes = new Set()       // candidates with at least one index/length-write site
  const stringy = new Set()      // candidates with positive string-shape evidence (disqualified)
  const markStringy = (n) => { stringy.add(n); writes.delete(n) }
  function walk(node, scope) {
    if (!Array.isArray(node) || scope.size === 0) return
    const op = node[0]
    if (op === '=>') {
      const shadowed = collectParamNames([node[1]])
      let inner = scope
      for (const s of shadowed) {
        if (inner.has(s)) {
          if (inner === scope) inner = new Set(scope)
          inner.delete(s)
        }
      }
      walk(node[2], inner)
      return
    }
    // typeof x === 'string' / 'string' === typeof x → x is sometimes a string.
    // The helper handles both raw-string and prepare-normalized -2 forms; the
    // `eq` flag is intentionally ignored — `!=` 'string' is also positive
    // evidence the binding *can* be string in some flow.
    const tp = typeofPredicate(node)
    if (tp && (tp.code === 'string' || tp.code === -2) && scope.has(tp.name)) markStringy(tp.name)
    // STRING_ONLY method call: x.charCodeAt(...), x.split(...), etc.
    if (op === '.' && typeof node[1] === 'string' && scope.has(node[1]) &&
        typeof node[2] === 'string' && STRING_ONLY_METHODS.has(node[2])) {
      markStringy(node[1])
    }
    // String-literal assignment: `x = 'foo'` — re-binds to a string.
    if (op === '=' && typeof node[1] === 'string' && scope.has(node[1]) && isStringLiteralRhs(node[2])) {
      markStringy(node[1])
    }
    // Index write: `xs[i] = v` or compound `xs[i] op= v`.
    if (isAssignOp(op) && isIndexAccess(node[1]) && scope.has(node[1][1]) && !stringy.has(node[1][1])) {
      writes.add(node[1][1])
    }
    // Length mutation: `xs.length = n`, `xs.length += k`, `xs.length++`.
    if (isAssignOp(op) && isLengthAccess(node[1]) && scope.has(node[1][1]) && !stringy.has(node[1][1])) {
      writes.add(node[1][1])
    }
    if ((op === '++' || op === '--') && isLengthAccess(node[1]) && scope.has(node[1][1]) && !stringy.has(node[1][1])) {
      writes.add(node[1][1])
    }
    for (let i = 1; i < node.length; i++) walk(node[i], scope)
  }
  walk(body, scope0)
  const out = new Map()
  for (const n of writes) if (!stringy.has(n)) out.set(n, { notString: true })
  return out
}

registerEvidence('notString', notStringEvidence)

// === Per-function orchestration ============================================
//
// Single front door for everything that narrows local + param shape from a
// function body. Two layers fold together here:
//
//   • Registry sources (above) seed undecided params with `{ val: VAL.* }`
//     evidence merged across all registered fact-returners.
//   • Body-wide ctx-mutating passes (`analyzeValTypes`, `analyzeIntCertain`)
//     walk the AST and write directly to `ctx.func.localReps` — they also
//     populate `ctx.types.typedElem`, `ctx.schema.vars`, regex tracking, etc.
//     and stay in analyze.js where their helpers live.
//
// Callers in compile.js used to repeat the merge boilerplate at every emit
// entry; centralizing it here keeps the ordering invariant in one place
// (param facts before body walk — `analyzeValTypes`'s `valTypeOf` consults
// rep, so seeded params must be visible before the walk starts).

/** Run the full per-function inference pipeline against `body`.
 *  `candidates` is the param-name set eligible for shape seeding (skip names
 *  already typed by an upstream source such as `paramReps`). Side-effects
 *  only — facts flow into `ctx.func.localReps` via `updateRep`. */
export const inferLocals = (body, candidates) => {
  if (candidates && candidates.length) {
    const inferred = inferParams(body, candidates)
    for (const [n, fact] of inferred) updateRep(n, fact)
  }
  analyzeValTypes(body)
  analyzeIntCertain(body)
}

// === Module-global value-fact recording ===================================
//
// Top-level `const X = …` / `let X = …` produces module-global facts the
// emitter consults at every call/read site: VAL.* for tagged-pointer dispatch,
// a typed-array ctor for elem-load fast paths, and a regex var registration.
// Single per-decl atomic — prepare.js calls it inline during its depth-0 walk
// (the unique authoritative pass). plan.js used to re-walk the top-level
// statement list with the same logic; that duplicate was deleted once tests
// confirmed prepare's depth-0 catch is a strict superset.
export function recordGlobalRep(name, expr) {
  if (typeof name !== 'string') return
  const vt = valTypeOf(expr)
  if (vt) {
    ;(ctx.scope.globalValTypes ||= new Map()).set(name, vt)
    if (vt === VAL.REGEX && ctx.runtime.regex) ctx.runtime.regex.vars.set(name, expr)
  }
  const ctor = typedElemCtor(expr)
  if (ctor) (ctx.scope.globalTypedElem ||= new Map()).set(name, ctor)
  const shape = shapeOfObjectLiteral(expr)
  updateGlobalRep(name, { jsonShape: shape || undefined })
}

// === Call-site argument inference =========================================
//
// Each `infer*(expr, ...callerCtx)` resolves an argument expression to a
// single fact (val / schemaId / elem-schema / elem-VAL / typedCtor) using the
// caller's body-local observations plus module-level program facts. Returns
// null when the fact can't be pinned down at this call site.
//
// These are the call-site mirror of the body-walk evidence sources above:
// body sources answer "what shape does this binding have?"; call-site
// extractors answer "what shape does this argument carry into a callee?".
// Both feed the same `paramReps` lattice via narrow.js' signature fixpoint.

/** Infer arg val type using caller's body-local valTypes and module globals. */
export function inferValType(expr, callerValTypes) {
  if (typeof expr === 'string') return callerValTypes?.get(expr) || ctx.scope.globalValTypes?.get(expr) || null
  return valTypeOf(expr)
}

/** Resolve a constant schemaId for an expression in a caller-or-return scope.
 *  Sources (in order): per-name `lookupMap` (caller's per-param schemaId map),
 *  module-level `ctx.schema.vars` binding, static-key `{}` literal,
 *  call to an OBJECT-narrowed function (carries schemaId in `f.sig.ptrAux`),
 *  recursive descent through `?:` / `&&` / `||` when both branches agree.
 *  Returns the schemaId (number) or null when no constant exists.
 *
 *  Used at both call sites (narrow.js D-phase mergeRule for `schemaId`) and
 *  return sites (narrow.js phase G's `narrowReturnArrayElems` and the per-fn
 *  return-schema narrowing). At early D-iterations the call-result branch
 *  is a no-op (valResult not yet seeded by phase F); strictly accretive. */
export function inferSchemaId(expr, lookupMap) {
  if (typeof expr === 'string') {
    if (lookupMap?.has(expr)) return lookupMap.get(expr)
    const id = ctx.schema.vars.get(expr)
    return id != null ? id : null
  }
  if (!Array.isArray(expr)) return null
  const op = expr[0]
  if (op === '{}') {
    const parsed = staticObjectProps(expr.slice(1))
    return parsed ? ctx.schema.register(parsed.names) : null
  }
  if (op === '()' && typeof expr[1] === 'string') {
    const f = ctx.func.map?.get(expr[1])
    if (f?.valResult === VAL.OBJECT && f.sig.ptrAux != null) return f.sig.ptrAux
    return null
  }
  if (op === '?:') {
    const a = inferSchemaId(expr[2], lookupMap)
    const b = inferSchemaId(expr[3], lookupMap)
    return a != null && a === b ? a : null
  }
  if (op === '&&' || op === '||') {
    const a = inferSchemaId(expr[1], lookupMap)
    const b = inferSchemaId(expr[2], lookupMap)
    return a != null && a === b ? a : null
  }
  return null
}

/** Infer arg arr-elem-schema. Sources: caller's body-local arr-elem map, caller's
 *  per-param arr-elem (transitive), or a call to an arr-narrowed user fn. */
export function inferArrElemSchema(expr, callerArrElems, callerArrParams) {
  if (typeof expr === 'string') {
    if (callerArrElems?.has(expr)) {
      const v = callerArrElems.get(expr)
      if (v != null) return v
    }
    if (callerArrParams?.has(expr)) {
      const v = callerArrParams.get(expr)
      if (v != null) return v
    }
    return null
  }
  if (Array.isArray(expr) && expr[0] === '()' && typeof expr[1] === 'string') {
    const f = ctx.func.map?.get(expr[1])
    if (f?.arrayElemSchema != null) return f.arrayElemSchema
  }
  return null
}

/** Infer arg arr-elem-VAL. Mirrors inferArrElemSchema but tracks VAL.* element kind. */
export function inferArrElemValType(expr, callerArrElemVals, callerArrValParams) {
  if (typeof expr === 'string') {
    if (callerArrElemVals?.has(expr)) {
      const v = callerArrElemVals.get(expr)
      if (v != null) return v
    }
    if (callerArrValParams?.has(expr)) {
      const v = callerArrValParams.get(expr)
      if (v != null) return v
    }
    return null
  }
  if (Array.isArray(expr) && expr[0] === '()' && typeof expr[1] === 'string') {
    const f = ctx.func.map?.get(expr[1])
    if (f?.arrayElemValType != null) return f.arrayElemValType
  }
  return null
}

/** Infer typed-array ctor (`new.Float64Array` etc.) of an arg expression at a call site.
 *  Sources: caller's body-local typedElems, caller's typed params, literal `new TypedArray(...)`,
 *  calls to typed-narrowed user funcs. Returns null when the ctor can't be determined. */
export function inferTypedCtor(expr, callerTypedElems, callerTypedParams) {
  if (typeof expr === 'string') {
    if (callerTypedElems?.has(expr)) return callerTypedElems.get(expr)
    if (callerTypedParams?.has(expr)) return callerTypedParams.get(expr)
    return null
  }
  const ctor = typedElemCtor(expr)
  if (ctor) return ctor
  if (Array.isArray(expr) && expr[0] === '()' && typeof expr[1] === 'string') {
    const f = ctx.func.map?.get(expr[1])
    if (f?.sig?.ptrKind === VAL.TYPED && f.sig.ptrAux != null) return ctorFromElemAux(f.sig.ptrAux)
  }
  return null
}
