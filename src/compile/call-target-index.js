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

  const resolveMember = (objName, prop) => {
    if (typeof objName !== 'string' || typeof prop !== 'string' || !safeReceiver(objName)) return null
    const props = table.get(objName)
    if (!props) return null
    const fn = props.get(prop)
    // Only a named-function resolution is `resolveMember`'s contract — an
    // arrow-node resolution (foldWrite's other resolved shape, added for
    // resolveComputed below) is deliberately declined here, unchanged from
    // before that addition: nothing that calls resolveMember expects (or
    // could use) a bare AST node in place of a ctx.funcs.list entry.
    return fn && fn !== POISON && !Array.isArray(fn) ? fn : null
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
