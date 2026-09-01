import { MUTATE_OPS, isFuncRef, isLiteralStr, collectAllBoundNames, walkAst } from '../ast.js'
import { staticObjectProps } from '../static.js'

// ProgramIndex member-target family (.work/archive/v1-architecture-campaign.md finish-order item 1).
// This is the canonical, frozen, same-module resolver for a `.`-member call's
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
// the VALUE level (Shape #8, test/data.js "ns.parse" pin, .work/archive/phase-c-
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
// prepare's own "Collide → fresh name" branch). `resolveMemberId` below falls
// back to these two facts when the census found no write to fold at all,
// trusted the SAME way `tryFnPropCall`/`bigintMethodTargets` (emit.js)
// already trust them for direct-call emission — a same-module function
// base, no second write (`multiProp` absent), the `${objName}$${prop}` name
// resolves — so the resolved callee is the exact function a bare-name call
// to `fn$prop` would reach; no new proof, no new naming convention, no
// divergence from what emission already does with zero analysis support.
//
// Nested extension: `root.inner.method()` resolves through the same index when
// every intermediate object is a closed module-level object literal and remains
// unshadowed, unreassigned, free of computed writes, and confined to receiver
// position. Any alias/value escape or conflicting write poisons the nested path.
// This is still a finite static proof, not general points-to analysis.

const POISON = Symbol('program-index member poison')

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
  walkAst(root, { enter: node => {
    if (node[0] === '=>') { collectAllBoundNames(node, out); return false }
  } })
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
 *  `ctx.funcs.list` entry, converted to a numeric ID before publication),
 *  or an inline arrow literal (the node itself, which has no named-function
 *  identity and remains an AST value in `resolveComputedIds`), NOT a
 *  `ctx.funcs.list` entry, since prepare.js never lifts an object-literal
 *  property's arrow into one — verified empirically, not assumed: a
 *  property value is either a bare name in `funcsNames` or it stays a
 *  plain `=>` AST node all the way through this file). Anything else (a
 *  non-function value, or a `++`/compound mutation whose "value" isn't a
 *  single reference at all) poisons the slot. A SECOND, DIFFERENT
 *  reference (function OR a different arrow node) also poisons — sticky,
 *  meet-style, matching param-reps.js's mergeParamFact/paramBigintOnly's
 *  own "disagreement → permanently unresolved" rule. Discriminating the
 *  two resolved shapes needs no tag: a named function is a numeric ID, while
 *  an arrow node is `['=>', params, body]`. `Array.isArray` tells them apart
 *  everywhere this table is read. */
function foldWrite(table, functionNameIds, funcsNames, name, prop, valueNode) {
  let props = table.get(name)
  if (!props) { props = new Map(); table.set(name, props) }
  const prior = props.get(prop)
  if (prior === POISON) return
  const resolved = isFuncRef(valueNode, funcsNames) ? functionNameIds.get(valueNode)
    : (Array.isArray(valueNode) && valueNode[0] === '=>') ? valueNode : null
  if (resolved == null) { props.set(prop, POISON); return }
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
function collectMemberWrites(root, table, rebound, functionNameIds, funcsNames) {
  const enter = node => {
    const op = node[0]
    if (op === '=>') return false
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
              foldWrite(table, functionNameIds, funcsNames, d[1], parsed.names[k], parsed.values[k])
          }
          walkAst(d[2], { enter })
        } else walkAst(d, { enter })
      }
      return false
    }
    if (MUTATE_OPS.has(op)) {
      const lhs = node[1], rhs = node[2]
      if (typeof lhs === 'string') {
        rebound.add(lhs)
      } else if (Array.isArray(lhs) && lhs[0] === '.' && typeof lhs[1] === 'string' && typeof lhs[2] === 'string') {
        foldWrite(table, functionNameIds, funcsNames, lhs[1], lhs[2], op === '=' ? rhs : null)
      } else if (Array.isArray(lhs) && lhs[0] === '[]' && typeof lhs[1] === 'string' && isLiteralStr(lhs[2])) {
        foldWrite(table, functionNameIds, funcsNames, lhs[1], lhs[2][1], op === '=' ? rhs : null)
      }
    }
  }
  walkAst(root, { enter })
}

const memberPath = node => {
  if (typeof node === 'string') return [node]
  if (!Array.isArray(node) || node[0] !== '.' || typeof node[2] !== 'string') return null
  const base = memberPath(node[1])
  return base ? [...base, node[2]] : null
}
const memberPathKey = path => path.join('.')

/** Collect closed nested object-literal receivers (`root.inner`) and their
 * static function-property writes. The root object still has to pass the
 * ordinary ProgramIndex escape/shadow/dynamic-write proof; this layer adds
 * the corresponding proof for the intermediate object itself. */
function collectNestedMemberWrites(root, nestedObjects, table, rebound, dynWrite, functionNameIds, funcsNames) {
  const seedObject = (basePath, literal) => {
    const parsed = staticObjectProps(literal.slice(1))
    if (!parsed) return
    for (let i = 0; i < parsed.names.length; i++) {
      const prop = parsed.names[i], value = parsed.values[i]
      if (!Array.isArray(value) || value[0] !== '{}') continue
      const path = [...basePath, prop], key = memberPathKey(path)
      nestedObjects.add(key)
      const inner = staticObjectProps(value.slice(1))
      if (inner) for (let k = 0; k < inner.names.length; k++)
        foldWrite(table, functionNameIds, funcsNames, key, inner.names[k], inner.values[k])
      seedObject(path, value)
    }
  }
  const enter = node => {
    const op = node[0]
    if (op === '=>') return false
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') {
          if (Array.isArray(d[2]) && d[2][0] === '{}') seedObject([d[1]], d[2])
          walkAst(d[2], { enter })
        } else walkAst(d, { enter })
      }
      return false
    }
    if (!MUTATE_OPS.has(op)) return
    const lhs = node[1], rhs = node[2]
    const path = memberPath(lhs)
    if (path && path.length >= 2) {
      const full = memberPathKey(path)
      if (nestedObjects.has(full)) rebound.add(full)
      if (path.length >= 3) {
        const base = memberPathKey(path.slice(0, -1))
        if (nestedObjects.has(base))
          foldWrite(table, functionNameIds, funcsNames, base, path.at(-1), op === '=' ? rhs : null)
      }
    } else if (Array.isArray(lhs) && lhs[0] === '[]') {
      const basePath = memberPath(lhs[1])
      if (basePath) {
        const base = memberPathKey(basePath)
        if (nestedObjects.has(base)) dynWrite.add(base)
      }
    }
  }
  walkAst(root, { enter })
}

/** A nested receiver is safe only while the receiver value itself never leaves
 * member/callee position. An alias, argument, return, or ordinary value read
 * forfeits the proof; static reads/writes through one more property do not. */
function collectNestedEscapes(ast, moduleInits, funcsList, nestedObjects) {
  const out = new Set()
  const walk = (node, safe = false) => {
    const path = memberPath(node)
    if (path) {
      const key = memberPathKey(path)
      if (nestedObjects.has(key)) {
        if (!safe) out.add(key)
        return
      }
    }
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === 'import' || op === 'export') return
    if (op === '.' || op === '?.') { walk(node[1], true); return }
    if (op === '()' || op === '[]') {
      walk(node[1], true)
      for (let i = 2; i < node.length; i++) walk(node[i], false)
      return
    }
    if (op === '?:') { walk(node[1]); walk(node[2], safe); walk(node[3], safe); return }
    if (op === '&&' || op === '||' || op === '??') { walk(node[1]); walk(node[2], safe); return }
    if (op === ',') {
      for (let i = 1; i < node.length - 1; i++) walk(node[i])
      walk(node[node.length - 1], safe)
      return
    }
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(ast)
  if (moduleInits) for (const init of moduleInits) walk(init)
  for (const func of funcsList) if (func.body) walk(func.body)
  return out
}

// Build SCC spans and the condensed component graph from direct-edge CSR.
// Scratch uses only flat arrays. Nested per-node buckets are unsafe under the
// self-hosted arena rewind and would also retain a second graph shape.
function buildSccSummary(functionCount, edgeStart, edgeCount, edgeTarget, rootIds) {
  const seen = new Array(functionCount).fill(false)
  const finish = []
  const nodeStack = [], nextStack = []
  for (let root = 0; root < functionCount; root++) {
    if (seen[root]) continue
    seen[root] = true
    nodeStack.push(root)
    nextStack.push(edgeStart[root])
    while (nodeStack.length) {
      const top = nodeStack.length - 1
      const node = nodeStack[top]
      const next = nextStack[top]
      const end = edgeStart[node] + edgeCount[node]
      if (next < end) {
        nextStack[top] = next + 1
        const target = edgeTarget[next]
        if (!seen[target]) {
          seen[target] = true
          nodeStack.push(target)
          nextStack.push(edgeStart[target])
        }
      } else {
        finish.push(node)
        nodeStack.pop()
        nextStack.pop()
      }
    }
  }

  const reverseCount = new Array(functionCount).fill(0)
  for (let source = 0; source < functionCount; source++) {
    const end = edgeStart[source] + edgeCount[source]
    for (let edge = edgeStart[source]; edge < end; edge++) reverseCount[edgeTarget[edge]]++
  }
  const reverseStart = new Array(functionCount)
  let reverseTotal = 0
  for (let funcId = 0; funcId < functionCount; funcId++) {
    reverseStart[funcId] = reverseTotal
    reverseTotal += reverseCount[funcId]
  }
  const reverseTarget = new Array(reverseTotal)
  const reverseCursor = reverseStart.slice()
  for (let source = 0; source < functionCount; source++) {
    const end = edgeStart[source] + edgeCount[source]
    for (let edge = edgeStart[source]; edge < end; edge++) {
      const target = edgeTarget[edge]
      reverseTarget[reverseCursor[target]++] = source
    }
  }

  const componentOf = new Array(functionCount).fill(-1)
  const componentStack = []
  let componentCount = 0
  for (let order = finish.length - 1; order >= 0; order--) {
    const root = finish[order]
    if (componentOf[root] >= 0) continue
    componentOf[root] = componentCount
    componentStack.push(root)
    while (componentStack.length) {
      const node = componentStack.pop()
      const end = reverseStart[node] + reverseCount[node]
      for (let edge = reverseStart[node]; edge < end; edge++) {
        const target = reverseTarget[edge]
        if (componentOf[target] >= 0) continue
        componentOf[target] = componentCount
        componentStack.push(target)
      }
    }
    componentCount++
  }

  const componentSize = new Array(componentCount).fill(0)
  for (let funcId = 0; funcId < functionCount; funcId++) componentSize[componentOf[funcId]]++
  const componentStart = new Array(componentCount)
  let componentTotal = 0
  for (let componentId = 0; componentId < componentCount; componentId++) {
    componentStart[componentId] = componentTotal
    componentTotal += componentSize[componentId]
  }
  const componentFunction = new Array(functionCount)
  const componentCursor = componentStart.slice()
  for (let funcId = 0; funcId < functionCount; funcId++)
    componentFunction[componentCursor[componentOf[funcId]]++] = funcId

  const componentEdgeCount = new Array(componentCount).fill(0)
  for (let source = 0; source < functionCount; source++) {
    const sourceComponent = componentOf[source]
    const end = edgeStart[source] + edgeCount[source]
    for (let edge = edgeStart[source]; edge < end; edge++)
      if (componentOf[edgeTarget[edge]] !== sourceComponent) componentEdgeCount[sourceComponent]++
  }
  const componentEdgeStart = new Array(componentCount)
  let componentEdgeTotal = 0
  for (let componentId = 0; componentId < componentCount; componentId++) {
    componentEdgeStart[componentId] = componentEdgeTotal
    componentEdgeTotal += componentEdgeCount[componentId]
  }
  const componentEdgeTarget = new Array(componentEdgeTotal)
  const componentEdgeCursor = componentEdgeStart.slice()
  for (let source = 0; source < functionCount; source++) {
    const sourceComponent = componentOf[source]
    const end = edgeStart[source] + edgeCount[source]
    for (let edge = edgeStart[source]; edge < end; edge++) {
      const targetComponent = componentOf[edgeTarget[edge]]
      if (targetComponent !== sourceComponent)
        componentEdgeTarget[componentEdgeCursor[sourceComponent]++] = targetComponent
    }
  }

  const componentReachable = new Array(componentCount).fill(0)
  const reachStack = []
  for (let i = 0; i < rootIds.length; i++) reachStack.push(componentOf[rootIds[i]])
  while (reachStack.length) {
    const componentId = reachStack.pop()
    if (componentReachable[componentId]) continue
    componentReachable[componentId] = 1
    const end = componentEdgeStart[componentId] + componentEdgeCount[componentId]
    for (let edge = componentEdgeStart[componentId]; edge < end; edge++)
      reachStack.push(componentEdgeTarget[edge])
  }
  const reachable = new Array(functionCount)
  for (let funcId = 0; funcId < functionCount; funcId++)
    reachable[funcId] = componentReachable[componentOf[funcId]]

  Object.freeze(componentOf)
  Object.freeze(componentStart)
  Object.freeze(componentSize)
  Object.freeze(componentFunction)
  Object.freeze(componentEdgeStart)
  Object.freeze(componentEdgeCount)
  Object.freeze(componentEdgeTarget)
  Object.freeze(componentReachable)
  Object.freeze(reachable)
  return Object.freeze({
    componentCount, componentOf, componentStart, componentSize, componentFunction,
    componentEdgeStart, componentEdgeCount, componentEdgeTarget, componentReachable,
    reachable,
  })
}

/**
 * Build the complete ProgramIndex after the early-plan AST mutations settle.
 * An optional enrichment callback receives a temporary identity/member resolver
 * so computed call observations can be synthesized before numeric direct edges,
 * roots, and reachability are frozen. Only the final closed index is returned.
 *
 * @returns a frozen numeric identity, member-target, direct-call, SCC, and reachability authority.
 *  `resolveMemberId` returns a stable function ID or -1. `functionById`
 *  projects that ID to the live function record for compatibility consumers.
 *  `resolveComputedIds` returns a closed mixed set of numeric named-function
 *  IDs and inline arrow AST nodes, or null when any member is unresolved.
 *  This production slice indexes the prepared and imported snapshot, including
 *  its pre-narrowing direct-call graph. Variants minted later by narrowing
 *  remain on the existing registry until final function identity moves to
 *  ProgramIndex in a later slice.
 */
export function buildProgramIndex(ctx, programFacts, ast, enrichCallSites) {
  const functions = []
  let seenFunctions = new Map()
  const functionNameIds = new Map()
  const addFunction = (name, func) => {
    if (!func) return
    let id = seenFunctions.get(func)
    if (id === undefined) {
      id = functions.length
      functions.push(func)
      seenFunctions.set(func, id)
    }
    if (typeof name === 'string') functionNameIds.set(name, id)
  }
  for (const func of ctx.funcs.list) addFunction(func.name, func)
  for (const [name, func] of ctx.funcs.map) addFunction(name, func)

  const shadowed = collectShadowedNames(ast, ctx.module.moduleInits, ctx.funcs.list)

  const table = new Map()
  const rebound = new Set()
  const roots = [ast, ...(ctx.module.moduleInits || [])]
  for (const root of roots) collectMemberWrites(root, table, rebound, functionNameIds, ctx.funcs.names)

  const nestedObjects = new Set(), nestedTable = new Map()
  const nestedRebound = new Set(), nestedDynWrite = new Set()
  for (const root of roots)
    collectNestedMemberWrites(root, nestedObjects, nestedTable, nestedRebound, nestedDynWrite, functionNameIds, ctx.funcs.names)
  const nestedEscapes = collectNestedEscapes(ast, ctx.module.moduleInits, ctx.funcs.list, nestedObjects)

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

  const resolveMemberId = (objName, prop) => {
    if (typeof prop !== 'string') return -1
    const path = memberPath(objName)
    if (path && path.length > 1) {
      const key = memberPathKey(path), root = path[0]
      if (!nestedObjects.has(key) || nestedRebound.has(key) || nestedDynWrite.has(key) ||
          nestedEscapes.has(key) || !safeReceiver(root)) return -1
      const targetId = nestedTable.get(key)?.get(prop)
      return Number.isInteger(targetId) ? targetId : -1
    }
    if (typeof objName !== 'string') return -1
    const isFuncBase = ctx.funcs.names.has(objName)
    if (!(isFuncBase ? safeFuncBase(objName) : safeReceiver(objName))) return -1
    const targetId = table.get(objName)?.get(prop)
    // Only a named-function resolution is `resolveMemberId`'s contract. An
    // arrow-node resolution (foldWrite's other resolved shape, retained for
    // resolveComputedIds below) is deliberately declined here: nothing that
    // asks for one numeric function identity expects (or
    // could use) a bare AST node in place of a ctx.funcs.list entry.
    if (targetId === POISON || Array.isArray(targetId)) return -1
    if (Number.isInteger(targetId)) return targetId
    if (!isFuncBase) return -1
    // Lifted function-property fallback (see header) — no write survived for
    // the census above to fold (flattenFuncNamespaces dropped it outright),
    // so resolve directly off prepare's own witnesses: same single-write
    // proof (`multiProp` ABSENT — prepare adds it on a second write to the
    // same `objName.prop`, the identical fact `tryFnPropCall`/
    // `bigintMethodTargets` already gate on), same `${objName}$${prop}` name
    // emission's own direct-call path uses.
    if (ctx.funcs.multiProp.has(`${objName}.${prop}`)) return -1
    return functionNameIds.get(`${objName}$${prop}`) ?? -1
  }

  /**
   * Computed-member-call sibling of `resolveMemberId`: `TABLE[key](args)`
   * where `key` is not statically known. Resolves to the closed SET of
   * every one of `objName`'s properties — a same-module named function
   * (`resolveMemberId`'s named-function shape) or an inline arrow literal (the `['=>',
   * params, body]` node — watr's actual `HANDLER` shape, every property an
   * arrow literal, none a reference to a pre-existing declared function;
   * see .work/archive/string-method-guess-notes.md "Third follow-up session" for
   * the empirical trace that ruled out treating these as funcEntries
   * directly) — or `null` when even ONE property is unresolved (a non-
   * function value, a `++`/compound write, or two disagreeing writes to
   * the same property: `foldWrite`'s POISON). "Closed" here means what it
   * means throughout this file: every property this walk can see is
   * accounted for, under the IDENTICAL `safeReceiver` eligibility
   * (shadowed/rebound/escapes/dynWriteVars) `resolveMemberId` already
   * applies — a table with even one dynamically-written or non-function
   * property, or that itself escapes/reassigns/shadows, resolves nothing,
   * same fail-closed discipline as everywhere else in this file. An empty
   * table (no property ever statically folded — e.g. a non-static-key
   * object literal, `staticObjectProps` returning null) also resolves
   * nothing: `resolveComputedIds` never claims a set it has zero evidence
   * for. Callers get back a mixed array (numeric function IDs and/or arrow
   * nodes) and must discriminate with `Array.isArray` per element, exactly
   * as `foldWrite`'s own doc above does.
   */
  const resolveComputedIds = (objName) => {
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

  const functionById = id => Number.isInteger(id) && id >= 0 && id < functions.length ? functions[id] : null
  const functionIdOfName = name => functionNameIds.get(name) ?? -1

  if (enrichCallSites) enrichCallSites(Object.freeze({
    functionCount: functions.length,
    functionById,
    functionIdOfName,
    resolveMemberId,
    resolveComputedIds,
  }))

  const count = functions.length
  const callSites = programFacts.callSites || []
  // Count and fill flat CSR in two passes. Do not stage per-caller nested arrays:
  // that shape produced correct first-round bytes but trapped after a self-hosted
  // `_clear()`, while this flat ownership survives repeated arena rewinds.
  const edgeCount = new Array(count).fill(0)
  for (const site of callSites) {
    const targetId = functionNameIds.get(site.callee) ?? -1
    if (targetId < 0) throw new Error(`ProgramIndex has no function ID for direct callee '${site.callee}'`)
    if (site.callerFunc == null) continue
    const callerId = seenFunctions.get(site.callerFunc) ?? functionNameIds.get(site.callerFunc.name) ?? -1
    if (callerId < 0) throw new Error(`ProgramIndex has no function ID for direct caller '${site.callerFunc.name}'`)
    edgeCount[callerId]++
  }
  const edgeStart = new Array(count)
  let totalEdges = 0
  for (let funcId = 0; funcId < count; funcId++) {
    edgeStart[funcId] = totalEdges
    totalEdges += edgeCount[funcId]
  }
  const edgeTarget = new Array(totalEdges)
  const edgeCursor = edgeStart.slice()
  for (const site of callSites) {
    if (site.callerFunc == null) continue
    const callerId = seenFunctions.get(site.callerFunc) ?? functionNameIds.get(site.callerFunc.name)
    edgeTarget[edgeCursor[callerId]++] = functionNameIds.get(site.callee)
  }
  const rootIds = [], dynamicRootIds = []
  const rootSeen = new Array(count).fill(false)
  const addressTakenBits = new Array(count).fill(0)
  for (const name of programFacts.valueUsed || []) {
    const id = functionNameIds.get(name) ?? -1
    if (id >= 0 && !addressTakenBits[id]) {
      addressTakenBits[id] = 1
      dynamicRootIds.push(id)
    }
  }
  const isAddressTaken = idOrName => {
    const id = Number.isInteger(idOrName) ? idOrName : functionNameIds.get(idOrName) ?? -1
    return id >= 0 && !!addressTakenBits[id]
  }
  const addressTaken = Object.freeze({ size: dynamicRootIds.length, has: name => isAddressTaken(name) })
  // ProgramFacts owns the mutable source census only through enrichment. Every
  // later compatibility reader sees this read-only numeric ProgramIndex view.
  programFacts.valueUsed = addressTaken
  for (const func of ctx.funcs.list) {
    const id = functionNameIds.get(func.name) ?? -1
    if (id >= 0 && func.exported && !rootSeen[id]) { rootSeen[id] = true; rootIds.push(id) }
  }
  for (let i = 0; i < dynamicRootIds.length; i++) {
    const id = dynamicRootIds[i]
    if (!rootSeen[id]) { rootSeen[id] = true; rootIds.push(id) }
  }
  for (const site of callSites) if (site.callerFunc == null) {
    const id = functionNameIds.get(site.callee) ?? -1
    if (id >= 0 && !rootSeen[id]) { rootSeen[id] = true; rootIds.push(id) }
  }
  const scc = buildSccSummary(count, edgeStart, edgeCount, edgeTarget, rootIds)
  const reachable = scc.reachable
  Object.freeze(edgeStart)
  Object.freeze(edgeCount)
  Object.freeze(edgeTarget)
  Object.freeze(rootIds)
  Object.freeze(dynamicRootIds)
  Object.freeze(addressTakenBits)
  const callGraph = Object.freeze({
    edgeStart, edgeCount, edgeTarget, rootIds, dynamicRootIds, addressTakenBits,
    componentCount: scc.componentCount,
    componentOf: scc.componentOf,
    componentStart: scc.componentStart,
    componentSize: scc.componentSize,
    componentFunction: scc.componentFunction,
    componentEdgeStart: scc.componentEdgeStart,
    componentEdgeCount: scc.componentEdgeCount,
    componentEdgeTarget: scc.componentEdgeTarget,
    componentReachable: scc.componentReachable,
    reachable,
  })
  seenFunctions = null

  const filterCallSitesToReachable = callSites => {
    let write = 0
    for (let read = 0; read < callSites.length; read++) {
      const site = callSites[read]
      const callerId = site.callerFunc == null ? -1 : functionNameIds.get(site.callerFunc.name) ?? -1
      if (site.callerFunc == null || callerId >= 0 && reachable[callerId]) callSites[write++] = site
    }
    callSites.length = write
  }
  const getCallGraph = () => callGraph
  const isReachable = funcId => !!reachable[funcId]

  Object.freeze(functions)
  return Object.freeze({
    functionCount: functions.length,
    functionById,
    functionIdOfName,
    resolveMemberId,
    resolveComputedIds,
    addressTaken,
    isAddressTaken,
    filterCallSitesToReachable,
    getCallGraph,
    isReachable,
  })
}

/**
 * Release `programFacts.valueUsed` of a lifted-function-property name whose
 * only possible value-use is its own defining write. Called once through
 * `buildProgramIndex`'s enrichment callback, after member resolution exists
 * and before address-taken roots freeze or any boundary consumer runs.
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
 * (`tryFnPropCall`, emit.js) a bare-name call would. When `resolveMemberId`
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
export function releaseLiftedValueUsed(ctx, programFacts, programIndex) {
  const valueUsed = programFacts?.valueUsed
  if (!valueUsed || !valueUsed.size || !programIndex) return
  const release = []
  for (const name of valueUsed) {
    const cut = name.lastIndexOf('$')
    if (cut <= 0 || cut === name.length - 1) continue
    const base = name.slice(0, cut), prop = name.slice(cut + 1)
    if (!ctx.funcs.names.has(base)) continue
    const targetId = programIndex.resolveMemberId(base, prop)
    if (programIndex.functionById(targetId)?.name === name) release.push(name)
  }
  for (const name of release) valueUsed.delete(name)
}
