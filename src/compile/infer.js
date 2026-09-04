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
 *   2. Operator use        — `s.charCodeAt(...)` used to induce STRING;
 *                            retired (fix/string-method-guess) — a plain
 *                            OBJECT/HASH can own a same-named closure
 *                            property, so usage alone never proves it.     [retired: see paramReps census]
 *   3. Member access       — `.push` / `.pop` used to induce ARRAY; retired
 *                            for the identical reason (fix/param-mutation-
 *                            propagation). index/length-write still proves
 *                            notString.                                   [retired ARRAY half; notString: done]
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

import { ctx } from '../ctx.js'
import { collectParamNames, ASSIGN_OPS, typeofPredicate } from '../ast.js'
import { analyzeValTypes, analyzeIntCertain } from './analyze.js'
import { staticObjectProps, staticArrayElems } from '../static.js'
import { isNullishLit } from '../ir.js'
import { typedStaticLen } from '../type.js'
import { typedStorageCtorFromContext } from '../typed-context.js'
import { shapeOfObjectLiteralAst, valTypeOf } from '../kind.js'
import { includeForStringValue } from '../autoload.js'
import { VAL, updateRep, updateGlobalRep } from '../reps.js'

// === typeof predicate helper ==============================================
//
// `typeof name == lit` / `!= lit` is the canonical narrowing predicate.
// typeofPredicate now lives in ast.js (a cycle-free leaf both this file and
// flow-types.js/module/function.js need — moving it there closed a real
// cycle: module/function.js → flow-types.js → infer.js → autoload.js →
// module/index.js → module/function.js); this file still uses it below.

// === paramReps lattice =====================================================
//
// Primitives live in src/param-reps.js (cycle-free leaf). Lifecycle phases
// below document when each field is valid during narrowSignatures.

// === Source registry =======================================================

const SOURCES = []

/** Register an evidence source. Insertion order = precedence: earlier sources
 *  win the merge for a given name. */
const registerEvidence = (name, fn) => { SOURCES.push({ name, fn }) }

/** Infer per-name facts by running every registered evidence source.
 *  Returns Map<name, fact>; callers pass `fact` straight to updateRep.
 *
 *  Merge semantics: first source wins per FIELD. Sources contribute orthogonal
 *  facts (`notStringEvidence` → `{notString}`; a future source may add
 *  `{intConst}` etc.); a later source's field is only kept if no earlier
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

// === Source: method evidence — RETIRED (rung 2/3, member-access shape) =====
//
// `name.method(...)` used to be a cheap STRING/ARRAY signal: STRING_ONLY_METHODS
// (charCodeAt, trim, padStart, …) induced VAL.STRING; ARRAY_INDUCERS (push, pop,
// …) induced VAL.ARRAY (removed first — fix/param-mutation-propagation). Both
// directions are the SAME unsoundness: a plain OBJECT/HASH value can own a
// same-named closure property attached post-construction (`t.charCodeAt = (i)
// => t.n + i`, `b.push = (v) => {...}` — the makeByteBuf/ByteBuf idiom,
// pervasive in jz's own self-hosted parser/lexer). Every downstream consumer
// trusted a settled `val` as a hard proof with no shadow check of its own —
// emit.js's tryStaticDispatch (strategy 7) dispatches a "proven"-STRING
// receiver straight to the `.string:${method}` builtin unconditionally, and
// module/core.js's emitLengthAccess reads a "proven"-STRING receiver's byte
// length unconditionally — so a param merely GUESSED into VAL.STRING from
// method-name usage alone silently ran the wrong receiver's closure or read
// the wrong memory shape (fix/string-method-guess: `t.charCodeAt(1)` on such
// an object returned NaN at O0 instead of calling the user's own closure; the
// ARRAY twin, fix/param-mutation-propagation, found the identical shape one
// rung up — `.push()` dispatching to Array-growth codegen on a HASH, and a
// same-object `.length` read landing on the wrong memory offset).
//
// Seeing one of these method names on an otherwise-unproven parameter IS real
// evidence the receiver isn't some OTHER kind (no String.prototype.push, no
// Array.prototype.charCodeAt) — but "isn't kind X" for one candidate still
// leaves every remaining kind on the table (a HASH with a colliding closure
// property, chief among them), so it can never license a positive `val`
// claim — the sound negative these names prove is exactly "not disprovable
// any further," i.e. no claim at all. The module's own contract ("Default is
// never wrong, only sometimes wider than necessary") means retiring this rung
// to a genuine no-op (an eliminated evidence source contributes nothing, same
// as if it had never run) IS the fix — there is no narrower guess to keep.
// The sound REPLACEMENT for a genuinely string-typed parameter is the
// cross-function paramReps call-site census (narrow.js): a real call-site
// literal, a proven-STRING forwarded argument, or a `typeof` guard
// (extractRefinements) all still narrow soundly — only the "usage alone"
// shortcut is gone. STRING_ONLY_METHODS itself stays: notStringEvidence below
// still needs it (seeing one of these disqualifies a WRITE-shape notString
// proof on the same binding — that direction was always sound, and is
// unrelated to the retired positive induce this rung used to run).

// Methods that exist ONLY on String.prototype — `indexOf`/`includes`/
// `lastIndexOf`/`concat`/`slice`/`at` are NOT here: Array.prototype has them
// too, so the receiver is genuinely ambiguous there (and the argument can't
// disambiguate — String coerces it, Arrays hold strings); those keep the
// runtime __ptr_type fork, correct for both.
const STRING_ONLY_METHODS = new Set([
  'charCodeAt', 'charAt', 'codePointAt', 'startsWith', 'endsWith',
  'toUpperCase', 'toLowerCase', 'toLocaleLowerCase', 'normalize', 'localeCompare',
  'padStart', 'padEnd', 'repeat', 'trimStart', 'trimEnd', 'trim',
  'matchAll', 'match', 'replace', 'replaceAll', 'split',
])

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
// assignment) disables the narrow. (The sibling 'method' source above is
// retired — it never contributes a `val` fact for this merge to race against
// — so this discharge is the ONLY thing standing between a write-shape
// param and a false notString claim.) The win: pure write+length-only params
// (e.g. `fill(buf, v)`) skip the runtime `__ptr_type==STRING` gate at every read.

const isLengthAccess = (n) =>
  Array.isArray(n) && n[0] === '.' && typeof n[1] === 'string' && n[2] === 'length'

const isIndexAccess = (n) =>
  Array.isArray(n) && n[0] === '[]' && typeof n[1] === 'string'

// C5b hardening: no producer emits `[null, string]` past prepare/index.js's
// normalization — see stringLiteral's (emit.js) identical arm removal.
const isStringLiteralRhs = (rhs) => Array.isArray(rhs) && rhs[0] === 'str'

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
    if (ASSIGN_OPS.has(op) && isIndexAccess(node[1]) && scope.has(node[1][1]) && !stringy.has(node[1][1])) {
      writes.add(node[1][1])
    }
    // Length mutation: `xs.length = n`, `xs.length += k`, `xs.length++`.
    if (ASSIGN_OPS.has(op) && isLengthAccess(node[1]) && scope.has(node[1][1]) && !stringy.has(node[1][1])) {
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
//     populate `ctx.func.typedElem`, `ctx.schema.vars`, regex tracking, etc.
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
  // A nullish decl init makes the binding NULLABLE program-wide — any later
  // val-kind claim (typed promote, pointer-ABI assignment) must keep an
  // `x === null` compare honest. This is THE plan-cache memo idiom
  // (`let lastPlan = null` + `if (lastPlan === null) lastPlan = make()`):
  // without the flag, strictSentinel folds the guard to a constant and the
  // memo never fills (silently wrong values, not a trap).
  if (isNullishLit(expr) || expr === 'null' || expr === 'undefined')
    updateGlobalRep(name, { nullable: true })
  const vt = valTypeOf(expr)
  if (vt) {
    ;(ctx.scope.globalValTypes ||= new Map()).set(name, vt)
    if (vt === VAL.REGEX && ctx.runtime.regex) ctx.runtime.regex.vars.set(name, expr)
  }
  const ctor = typedStorageCtorFromContext(ctx, expr, {
    resolveName: n => ctx.scope.globalTypedElem?.get(n) ?? null,
    calls: false, fields: false, indices: false,
  })
  if (ctor) {
    ;(ctx.scope.globalTypedElem ||= new Map()).set(name, ctor)
    const len = typedStaticLen(expr)
    if (len != null) (ctx.scope.globalTypedLen ||= new Map()).set(name, len)
    else {
      ctx.scope.globalTypedLen?.delete(name)
      // `new T(CIN*H*W)` — the size is a const expression whose names fold AFTER
      // prepare (the compile-time constInts fixpoint). Park the rhs; the fold's tail
      // re-runs typedStaticLen over these (see "Pre-fold const globals").
      ;(ctx.scope.pendingTypedLens ||= new Map()).set(name, expr)
    }
  }
  // Module-level const array literal with a uniform element val-type (e.g. a numeric
  // table `const FREQS = [261.63, …]`): record it so `FREQS[i]` reads in any using
  // function are typed (NUMBER) rather than untyped. Without this an untyped element
  // read makes `s += FREQS[i]` take the polymorphic +/ToString path — dragging the
  // entire string runtime (~5 kB) into a kernel that uses no strings. A function-local
  // array gets this from analyzeValTypes; a module-level one is invisible to the using
  // function's body walk, so capture it here. Soundness for a later `FREQS[i]=…` is the
  // read-site dynWriteVars guard in valTypeOf (kind.js) — this is just the literal fact.
  if (vt === VAL.ARRAY) {
    const elems = staticArrayElems(expr)
    if (elems && elems.length && elems.every(e => e != null)) {
      let common = valTypeOf(elems[0])
      for (let k = 1; k < elems.length && common != null; k++)
        if (valTypeOf(elems[k]) !== common) common = null
      if (common != null) updateGlobalRep(name, { arrayElemValType: common })
      // Array-of-arrays numeric table (`const C = [[0,4,7], …]`): also record the
      // nested element kind so `C[i][j]` (and `ch = C[i]; ch[j]`) reads stay typed —
      // the same string-runtime drop as the flat case, one level down. Single-level
      // (mirrors analyzeValTypes' local arrElemElemValTypes); deeper nesting falls back.
      if (common === VAL.ARRAY) {
        let nested = null, seen = false, ok = true
        for (const el of elems) {
          const inner = staticArrayElems(el)
          if (!inner || !inner.length || !inner.every(e => e != null)) { ok = false; break }
          for (const ie of inner) {
            const ivt = valTypeOf(ie)
            if (!seen) { nested = ivt; seen = true }
            else if (ivt !== nested) { ok = false; break }
          }
          if (!ok) break
        }
        if (ok && nested != null) updateGlobalRep(name, { arrayElemElemValType: nested })
      }
    }
  }
  // Static-shape capture for module-level object literals — lets `{ ...G.path }`
  // resolve its source schema by walking the global rep's shape tree at the
  // spread site (see shape walk in analyze.js / resolveSchema in object.js).
  const sh = shapeOfObjectLiteralAst(expr)
  if (sh) {
    updateGlobalRep(name, { jsonShape: sh })
    // A module-global object is read via __dyn_get (its props live behind a
    // runtime key, not a function-local schema slot), which emits a `['str', key]`
    // node at compile time. Ensure the string module's `str` emitter is bound now
    // — a string-literal-free program (`let g = {l:{a:1}}; export let f = () => g.l`)
    // would otherwise abort late with "Unknown op: str". Scoped to globals that
    // actually capture an object shape, so string-free local-object programs keep
    // their minimal bundle (and golden-size pins).
    includeForStringValue()
  }
}

// === Call-site argument inference =========================================
//
// The value kinds of a call-site argument are the program summary's
// (src/summary, narrow/index.js seedParamKinds). What remains here resolves
// the facts the summary does not carry: a constant schema id for a return
// expression (narrowPointerResults) and the closed element-schema union.

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
    // The program summary: a binding every assignment of which is one shape
    // (a local holding a factory's result, a parameter of one shape).
    return id != null ? id : ctx.summary?.sidOf(expr) ?? null
  }
  if (!Array.isArray(expr)) return null
  const op = expr[0]
  if (op === '{}') {
    const parsed = staticObjectProps(expr.slice(1))
    return parsed ? ctx.schema.register(parsed.names) : null
  }
  if (op === '()' && typeof expr[1] === 'string') {
    const f = ctx.funcs.map?.get(expr[1])
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

/** Infer arg closed elem-schema UNION as its canonical 'a,b,…' key. Sources:
 *  caller's body set census (Set values, `cx.callerElems`), caller's param fact
 *  (already canonical, `cx.paramFacts`), or a set-narrowed user fn return. */
export function inferArrElemSchemaSet(expr, cx) {
  const callerElems = cx.callerElems, paramFacts = cx.paramFacts  // hoisted once: cx arrives through an indirect call
  const canon = (v) => v instanceof Set
    ? (v.size >= 2 ? [...v].sort((a, b) => a - b).join(',') : null)
    : typeof v === 'string' ? v : null
  if (typeof expr === 'string') {
    const v = canon(callerElems?.get(expr))
    if (v != null) return v
    const p = canon(paramFacts?.get(expr))
    if (p != null) return p
    return null
  }
  if (Array.isArray(expr) && expr[0] === '()' && typeof expr[1] === 'string') {
    const f = ctx.funcs.map?.get(expr[1])
    if (typeof f?.arrayElemSchemaSet === 'string') return f.arrayElemSchemaSet
  }
  return null
}
