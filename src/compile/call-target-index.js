import { MUTATE_OPS, isFuncRef, isLiteralStr, collectAllBoundNames } from '../ast.js'
import { staticObjectProps } from '../static.js'

// CallTargetIndex (.work/v1-architecture-campaign.md finish-order item 1) —
// the canonical, frozen, same-module resolver for a `.`-member call's
// callee, mirroring closure-plan.js's ClosureEnvPlan idiom: a fact computed
// ONCE from the parsed program, before any analysis consumer, never mutated
// afterward. Every existing callee-resolution site treats a bare-name call
// (`f(x)`) as fully resolved via `ctx.funcs.map.get('f')` — trivial, since
// the callee IS the name. A `.`-member call (`ns.parse(x)`) has no such
// mechanism anywhere in the compiler: every provenance walker in
// representation-plan.js gates its direct-callee branch on
// `typeof node[1] === 'string'` exclusively, so a real, same-module, user-
// defined function reached through an object property is invisible to
// analysis even though emission's dynamic dispatch calls it correctly at
// the VALUE level (Shape #8, test/data.js "ns.parse" pin, phase-c-
// unification.md's Shape #8 section). This module closes that gap with one
// general proof, not a name-specific guess:
//
//   For a bare module-level name OBJ bound to a value that is never (a)
//   reassigned as a whole, (b) read in a value position anywhere
//   (programFacts.nameEscapes — passed as an argument, returned, aliased,
//   exported…), (c) written through a computed key anywhere
//   (programFacts.dynWriteVars), or (d) shadowed by a parameter/local of the
//   same name in ANY function in the program (collectAllBoundNames, the
//   same shadow-bail discipline program-facts.js's own
//   observeNestedDictMapWrites already uses) — every static write to
//   OBJ.PROP (a `.`-assignment, a literal-string `[]`-assignment, or an
//   inline object-literal property) is enumerable and exhaustive. If every
//   one of those writes assigns the SAME same-module named function, that
//   function is OBJ.PROP's proven, sole call target; any other write shape
//   (a non-function value, a compound/`++`/`--` mutation, or two DIFFERING
//   function values) poisons that property back to unresolved — never
//   guessed, matching every other producer in this file's family
//   (paramBigintOnly/paramNeverBool in representation-plan.js) that goes
//   sticky-impure on the first disagreement rather than picking a side.
//
// Deliberately narrower than a general points-to analysis: property writes
// are collected ONLY at true module top level (this walk never descends
// into `=>`, exactly like collectDispatchTableClosures' own scope in
// representation-plan.js) — a namespace object populated from inside a
// function body is left unresolved rather than reasoned about, since that
// would need the same escape/aliasing proof this file already applies to
// the RECEIVER extended to every intermediate call boundary too. Missing a
// resolution only forfeits the optimization/precision this index enables;
// it can never fabricate a wrong one — every consumer's existing runtime-
// dispatch/no-claim fallback is unchanged for anything this index declines
// to resolve.
//
// Second source, same discipline: a LIFTED function-property (prepare's own
// `fn.prop = arrow` → top-level `fn$prop` rule, src/prepare/index.js's `'='`
// handler — watr's real `i64.parse = n => {...}` onto the named function
// `i64`, not Shape #8's object-literal `ns.parse`). That rule rewrites the
// write to `fn.prop = fn$prop` (a bare-name RHS, in principle exactly the
// shape `collectMemberWrites`/`foldWrite` above already fold) — so for a
// FUNCTION receiver, the write is often visible to the census same as any
// object-literal one (`flattenFuncNamespaces`, plan/scope.js, drops it
// outright only when the property is NEVER read as a value anywhere — see
// that pass's own doc; when it survives, `foldWrite` resolves it exactly as
// written, no different from Shape #8). What actually blocks it is
// `safeReceiver`'s `nameEscapes` term: program-facts.js's whole-program
// `nameEscapes` set has NO exemption for a call's own callee position
// (`ESCAPE_SKIP` has no `'()'` entry — ordinary calls mark their callee
// "escaped" right alongside a true value-read, "sound direction: over-
// marking loses a fold"). A same-module function that is EVER called
// directly by name anywhere — watr's `i64` is, from `encode.i64(...)`
// flattened to a bare `m1_encode$i64(...)` call elsewhere in the very same
// program — ends up in `nameEscapes` regardless of whether it ever truly
// aliases. That coarseness is the right trade-off for `nameEscapes`' many
// other whole-program consumers; it is simply the wrong question for THIS
// file's narrower one. `collectValueEscapes` below answers the question
// this file actually needs for a function-declaration receiver: does the
// name ever appear anywhere OTHER than a call's own callee or a `.`/`?.`/
// `[]` receiver — the two positions that read it without ever copying it
// into a second binding a write could later reach through. If not, every
// occurrence in the whole program is accounted for, and a `.`-property read
// off it is exactly as safe to resolve as the object-literal case.
//
// The written-once witness for a DROPPED write (flattenFuncNamespaces did
// remove it) survives anyway, in a different place: prepare's own lift
// already recorded it, permanently, as an ordinary entry in
// `ctx.funcs.names`/`ctx.funcs.map` (the function `fn$prop` itself) plus a
// negative fact in `ctx.funcs.multiProp` (`"fn.prop"`) exactly when a SECOND
// write to the same property occurs (wrapper-composition reassignment —
// prepare's own "Collide → fresh name" branch). `resolveMember` below falls
// back to these two facts when the census found no write to fold at all,
// trusted the SAME way `tryFnPropCall`/`bigintMethodTargets` (emit.js)
// already trust them for direct-call emission — a same-module function
// base, no second write (`multiProp` absent), the `${objName}$${prop}` name
// resolves — so the resolved callee is the exact function a bare-name call
// to `fn$prop` would reach; no new proof, no new naming convention, no
// divergence from what emission already does with zero analysis support.

const POISON = Symbol('call-target-index poison')

/** Whole-program set of names ever bound as a function parameter or a
 *  local `let`/`const`/`var` anywhere (any nesting depth, any function) —
 *  a module-level candidate in that set could refer to a DIFFERENT value
 *  at some call site (shadowed), so it is excluded from the index
 *  entirely, program-wide, rather than risk misattributing a local's
 *  property write/read to the unrelated module global of the same name.
 *  Over-marking (excluding a name nothing actually shadows) only forfeits
 *  a resolution; under-marking would be unsound — collectAllBoundNames is
 *  already the established shadow-bail primitive for exactly this
 *  question (program-facts.js's observeNestedDictMapWrites, dyn-keys.js). */
// collectAllBoundNames is position-insensitive over whatever subtree it is
// given (ast.js's own doc: "ANY name it returns for this arrow's whole
// subtree is treated as shadowed everywhere in it") — calling it directly on
// `ast`/a moduleInit would therefore also net THEIR OWN top-level `let`/
// `const` declarations (the very module-global candidates this index exists
// to resolve, not shadows of them). At true module scope this walk instead
// only delegates to collectAllBoundNames once it reaches a closure boundary
// (`=>`), so it captures exactly the NESTED bindings that could shadow a
// module global — a function/closure body is always a new scope relative to
// the module, so it is safe (and necessary) to hand the whole subtree,
// unrestricted, straight to collectAllBoundNames from there.
function collectNestedBoundNames(root, out) {
  const walk = node => {
    if (!Array.isArray(node)) return
    if (node[0] === '=>') { collectAllBoundNames(node, out); return }
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(root)
}

function collectShadowedNames(ast, moduleInits, funcsList) {
  const out = new Set()
  collectNestedBoundNames(ast, out)
  if (moduleInits) for (const init of moduleInits) collectNestedBoundNames(init, out)
  for (const func of funcsList) {
    if (func.sig?.params) for (const p of func.sig.params) out.add(p.name)
    if (func.body) collectAllBoundNames(func.body, out)
  }
  return out
}

/** Whole-program set of names that appear anywhere OTHER than a call's own
 *  callee slot or a `.`/`?.`/`[]` receiver slot — see this file's header for
 *  why `programFacts.nameEscapes` (which marks a call's callee too) is the
 *  wrong instrument for a function-declaration receiver specifically. Walks
 *  everywhere `collectShadowedNames` does (module top level, moduleInits,
 *  every function body — a value can escape from any of them), with no
 *  `=>`-boundary stop: unlike shadow/write census above, an escape three
 *  closures deep is exactly as disqualifying as one at module top level.
 *
 *  `safe` propagates a callee/receiver position THROUGH the ops that merely
 *  forward one of their own operand's value untouched (`?:`, `&&`/`||`/`??`,
 *  the comma operator) — a namespace-qualified call `encode[t].parse(...)`
 *  lowers a computed read on a known-shape namespace into exactly this
 *  ternary-of-equality-checks shape (`t === 'i64' ? m1_encode$i64 : t ===
 *  'f32' ? …`, watr's real `compile.js` v128const), and each branch is
 *  every bit as much "the `.`-receiver of a safe read" as a bare receiver
 *  would be — losing that context at the ternary boundary would call a
 *  namespace member's own encoder function an escape merely for being
 *  reached through a runtime-selected branch instead of a fixed name. */
function collectValueEscapes(ast, moduleInits, funcsList) {
  const out = new Set()
  const walk = (node, safe = false) => {
    if (typeof node === 'string') { if (!safe) out.add(node); return }
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === 'import' || op === 'export') return
    if (op === '.' || op === '?.') { walk(node[1], true); return } // receiver reads without exposing it; prop name is never a value
    if (op === '()' || op === '[]') { // callee / index-receiver position is safe; every other slot is an ordinary value position
      walk(node[1], true)
      for (let i = 2; i < node.length; i++) walk(node[i], false)
      return
    }
    if (op === '?:') { walk(node[1], false); walk(node[2], safe); walk(node[3], safe); return }
    if (op === '&&' || op === '||' || op === '??') { walk(node[1], false); walk(node[2], safe); return }
    if (op === ',') {
      for (let i = 1; i < node.length - 1; i++) walk(node[i], false)
      walk(node[node.length - 1], safe)
      return
    }
    for (let i = 1; i < node.length; i++) walk(node[i], false)
  }
  walk(ast)
  if (moduleInits) for (const init of moduleInits) walk(init)
  for (const func of funcsList) if (func.body) walk(func.body)
  return out
}

/** Fold one observed write's value into `table.get(name).get(prop)`. Two
 *  shapes resolve: a same-module named-function reference (`fn`, a
 *  `ctx.funcs.list` entry — the ONLY thing `resolveMember` ever hands out,
 *  its existing contract, unchanged), or an inline arrow literal (the
 *  node itself — `resolveComputed`'s addition, see its own doc; NOT a
 *  `ctx.funcs.list` entry, since prepare.js never lifts an object-literal
 *  property's arrow into one — verified empirically, not assumed: a
 *  property value is either a bare name in `funcsNames` or it stays a
 *  plain `=>` AST node all the way through this file). Anything else (a
 *  non-function value, or a `++`/compound mutation whose "value" isn't a
 *  single reference at all) poisons the slot. A SECOND, DIFFERENT
 *  reference (function OR a different arrow node) also poisons — sticky,
 *  meet-style, matching param-reps.js's mergeParamFact/paramBigintOnly's
 *  own "disagreement → permanently unresolved" rule. Discriminating the
 *  two resolved shapes needs no tag: a `ctx.funcs.list` entry is a plain
 *  object, an arrow node is `['=>', params, body]` — `Array.isArray`
 *  tells them apart everywhere this table is read. */
function foldWrite(table, funcsMap, funcsNames, name, prop, valueNode) {
  let props = table.get(name)
  if (!props) { props = new Map(); table.set(name, props) }
  const prior = props.get(prop)
  if (prior === POISON) return
  const resolved = isFuncRef(valueNode, funcsNames) ? funcsMap.get(valueNode)
    : (Array.isArray(valueNode) && valueNode[0] === '=>') ? valueNode : null
  if (!resolved) { props.set(prop, POISON); return }
  if (prior === undefined) { props.set(prop, resolved); return }
  if (prior !== resolved) props.set(prop, POISON)
}

/** Collect every top-level write to NAME.PROP / NAME['PROP'] / an inline
 *  `{PROP: value}` literal property, plus every bare whole-binding
 *  reassignment (`name = ...` outside its own declaration) — the latter
 *  poisons the RECEIVER (not just one property): once a name is rebound to
 *  a possibly-different value, no earlier write's function target can be
 *  trusted for calls that follow the rebind. Root-level only: stops at
 *  `=>`, the same scope collectDispatchTableClosures already uses for its
 *  own inline-property scan (representation-plan.js). */
function collectMemberWrites(root, table, rebound, funcsMap, funcsNames) {
  const walk = node => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>') return
    // A decl's OWN `['=', NAME, init]` child is a BINDING, not a reassignment
    // — handled explicitly here (seed inline object-literal properties, then
    // descend into the initializer only) so it never also reaches the
    // generic MUTATE_OPS branch below, which would otherwise misread NAME's
    // own initial binding as a whole-name rebind (program-facts.js's
    // observeNodeFacts draws the identical distinction via its `_declEq`
    // WeakSet for the same reason).
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') {
          if (Array.isArray(d[2]) && d[2][0] === '{}') {
            const parsed = staticObjectProps(d[2].slice(1))
            if (parsed) for (let k = 0; k < parsed.names.length; k++)
              foldWrite(table, funcsMap, funcsNames, d[1], parsed.names[k], parsed.values[k])
          }
          walk(d[2])
        } else walk(d)
      }
      return
    }
    if (MUTATE_OPS.has(op)) {
      const lhs = node[1], rhs = node[2]
      if (typeof lhs === 'string') {
        rebound.add(lhs)
      } else if (Array.isArray(lhs) && lhs[0] === '.' && typeof lhs[1] === 'string' && typeof lhs[2] === 'string') {
        foldWrite(table, funcsMap, funcsNames, lhs[1], lhs[2], op === '=' ? rhs : null)
      } else if (Array.isArray(lhs) && lhs[0] === '[]' && typeof lhs[1] === 'string' && isLiteralStr(lhs[2])) {
        foldWrite(table, funcsMap, funcsNames, lhs[1], lhs[2][1], op === '=' ? rhs : null)
      }
    }
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(root)
}

/**
 * Build the frozen call-target index. Called once from plan/index.js, right
 * after the early-plan AST-mutating passes (inlining/SROA/flattening/
 * devirtualization) settle and before solveRepresentationBoundaries/
 * narrowSignatures run — every later plan pass and every emission site sees
 * the identical, already-closed snapshot. Never re-derived, never mutated:
 * requirement (1) of the finish-order item this file implements.
 *
 * @returns {{resolveMember: (objName: string, prop: string) => object|null,
 *   resolveComputed: (objName: string) => Array<object|Array>|null}}
 *  `resolveMember` returns the resolved function's `ctx.funcs.list` entry
 *  (same shape `ctx.funcs.map.get(name)` returns for a bare-name call) or
 *  `null` when the index cannot prove a single same-module target — callers
 *  MUST treat `null` exactly like an ordinary unresolved/dynamic callee,
 *  never guess (requirement 2). `resolveComputed` is `resolveMember`'s
 *  computed-key sibling — see its own doc below.
 */
export function buildCallTargetIndex(ctx, programFacts, ast) {
  const shadowed = collectShadowedNames(ast, ctx.module.moduleInits, ctx.funcs.list)

  const table = new Map()
  const rebound = new Set()
  const roots = [ast, ...(ctx.module.moduleInits || [])]
  for (const root of roots) collectMemberWrites(root, table, rebound, ctx.funcs.map, ctx.funcs.names)

  const nameEscapes = programFacts?.nameEscapes
  const dynWriteVars = programFacts?.dynWriteVars
  const safeReceiver = name =>
    !shadowed.has(name) && !rebound.has(name) &&
    !(nameEscapes && nameEscapes.has(name)) && !(dynWriteVars && dynWriteVars.has(name))
  // Alternate gate for a receiver that is itself a same-module function
  // declaration (`ctx.funcs.names.has(name)`) — see this file's header for
  // why `nameEscapes` over-rejects exactly this receiver shape (a call's own
  // callee position isn't exempt in that whole-program set, so any function
  // ever called directly by name anywhere counts as "escaped"). Computed
  // lazily, once, only if a function-base lookup actually needs it.
  let valueEscapes = null
  const safeFuncBase = name => {
    valueEscapes ??= collectValueEscapes(ast, ctx.module.moduleInits, ctx.funcs.list)
    return !shadowed.has(name) && !rebound.has(name) && !(dynWriteVars && dynWriteVars.has(name)) && !valueEscapes.has(name)
  }

  const resolveMember = (objName, prop) => {
    if (typeof objName !== 'string' || typeof prop !== 'string') return null
    const isFuncBase = ctx.funcs.names.has(objName)
    if (!(isFuncBase ? safeFuncBase(objName) : safeReceiver(objName))) return null
    const fn = table.get(objName)?.get(prop)
    // Only a named-function resolution is `resolveMember`'s contract — an
    // arrow-node resolution (foldWrite's other resolved shape, added for
    // resolveComputed below) is deliberately declined here, unchanged from
    // before that addition: nothing that calls resolveMember expects (or
    // could use) a bare AST node in place of a ctx.funcs.list entry.
    if (fn === POISON || Array.isArray(fn)) return null
    if (fn) return fn
    if (!isFuncBase) return null
    // Lifted function-property fallback (see header) — no write survived for
    // the census above to fold (flattenFuncNamespaces dropped it outright),
    // so resolve directly off prepare's own witnesses: same single-write
    // proof (`multiProp` ABSENT — prepare adds it on a second write to the
    // same `objName.prop`, the identical fact `tryFnPropCall`/
    // `bigintMethodTargets` already gate on), same `${objName}$${prop}` name
    // emission's own direct-call path uses.
    if (ctx.funcs.multiProp.has(`${objName}.${prop}`)) return null
    return ctx.funcs.map.get(`${objName}$${prop}`) ?? null
  }

  /**
   * Computed-member-call sibling of `resolveMember`: `TABLE[key](args)`
   * where `key` is not statically known. Resolves to the closed SET of
   * every one of `objName`'s properties — a same-module named function
   * (`resolveMember`'s own shape) or an inline arrow literal (the `['=>',
   * params, body]` node — watr's actual `HANDLER` shape, every property an
   * arrow literal, none a reference to a pre-existing declared function;
   * see .work/string-method-guess-notes.md "Third follow-up session" for
   * the empirical trace that ruled out treating these as funcEntries
   * directly) — or `null` when even ONE property is unresolved (a non-
   * function value, a `++`/compound write, or two disagreeing writes to
   * the same property: `foldWrite`'s POISON). "Closed" here means what it
   * means throughout this file: every property this walk can see is
   * accounted for, under the IDENTICAL `safeReceiver` eligibility
   * (shadowed/rebound/escapes/dynWriteVars) `resolveMember` already
   * applies — a table with even one dynamically-written or non-function
   * property, or that itself escapes/reassigns/shadows, resolves nothing,
   * same fail-closed discipline as everywhere else in this file. An empty
   * table (no property ever statically folded — e.g. a non-static-key
   * object literal, `staticObjectProps` returning null) also resolves
   * nothing: `resolveComputed` never claims a set it has zero evidence
   * for. Callers get back a MIXED array (funcInfo objects and/or arrow
   * nodes) and must discriminate with `Array.isArray` per element, exactly
   * as `foldWrite`'s own doc above does.
   */
  const resolveComputed = (objName) => {
    if (typeof objName !== 'string' || !safeReceiver(objName)) return null
    const props = table.get(objName)
    if (!props || !props.size) return null
    const members = []
    for (const v of props.values()) {
      if (v === POISON) return null
      members.push(v)
    }
    return members
  }

  return Object.freeze({ resolveMember, resolveComputed })
}

/**
 * Release `programFacts.valueUsed` of a lifted-function-property name whose
 * only possible value-use is its own defining write. Called once from
 * plan/index.js, immediately after `buildCallTargetIndex` — before
 * `solveRepresentationBoundaries`/`narrowSignatures` (representation-plan.js's
 * `makeBoundaryData`) ever read `valueUsed` to decide `uncovered` for a
 * function's boundary plan.
 *
 * Prepare's `fn.prop = arrow` lift substitutes `fn.prop = fn$prop` — a
 * SYNTHESIZED name that cannot appear anywhere else in the whole program by
 * construction (the original source never spells it; nothing before this
 * point in the pipeline re-derives or re-emits it). program-facts.js's
 * whole-program `valueUsed` walk marks a bare func-ref RHS of any `=`
 * (`observeNodeFacts`'s own comment: "so resolveClosureWidth sizes the
 * closure ABI to its arity") — sound for a genuinely first-class use
 * (`store[0] = pick3`, callable through an unknown later dispatch), but this
 * ONE write is not that: it is prepare's own bookkeeping, and every call
 * this index can trace to it goes through the SAME direct `.`-property path
 * (`tryFnPropCall`, emit.js) a bare-name call would. When `resolveMember`
 * independently re-derives the identical `(base, prop) → fn$prop` fact —
 * meaning `base` passed this file's own escape/shadow/reassignment proof —
 * the write is provably fully covered: no truly indirect/closure call can
 * reach `fn$prop` through it, so marking it `valueUsed` only forces every
 * downstream boundary decision (`makeBoundaryData`'s `uncovered`,
 * `representationCallArgAction`'s materialization) onto the conservative,
 * closure-shaped path a REAL indirectly-reachable function needs.
 *
 * Deliberately narrower than "any index-resolved property": an
 * object-literal receiver (Shape #8, `ns.parse = someExistingFn`) resolves
 * to a real, independently-named, PRE-EXISTING function that this write is
 * merely ONE reference to — it may legitimately have other value-uses this
 * index has no way to rule out, so it is left in `valueUsed` untouched. Only
 * a name matching the exact `${base}$${prop}` synthesis convention, with
 * `base` itself a same-module function declaration, carries the "cannot
 * exist anywhere else" guarantee this release depends on.
 */
export function releaseLiftedValueUsed(ctx, programFacts, callTargets) {
  const valueUsed = programFacts?.valueUsed
  if (!valueUsed || !valueUsed.size || !callTargets) return
  const release = []
  for (const name of valueUsed) {
    const cut = name.lastIndexOf('$')
    if (cut <= 0 || cut === name.length - 1) continue
    const base = name.slice(0, cut), prop = name.slice(cut + 1)
    if (!ctx.funcs.names.has(base)) continue
    if (callTargets.resolveMember(base, prop)?.name === name) release.push(name)
  }
  for (const name of release) valueUsed.delete(name)
}
