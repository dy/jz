/**
 * AST preparation: single-pass traversal that validates, resolves, and normalizes.
 *
 * # Stage contract
 *   IN:  raw jessie AST from subscript/jessie (possibly jzified).
 *   OUT: normalized AST + populated `ctx.funcs.list`, `ctx.module.imports`, `ctx.schema.list`,
 *        `ctx.scope.consts`, `ctx.module.moduleInits`.
 *   POST: no `var`/`function`/`class`/`this` remain; ++/-- rewritten as +=/-=; arrow
 *        bodies carry no type metadata yet (that's analyze/compile's job).
 *
 * # Concerns (per-node handler table, applied together per op)
 *   1. Validate      — reject prohibited features (this, class, async, var, delete, ...)
 *   2. Resolve       — scope chain + import bindings (Math.sin → math.sin, etc.)
 *   3. Extract       — arrow functions → ctx.funcs.list with sig
 *   4. Normalize     — ++/-- → +=/-=, unary ± disambiguation, for-head flattening
 *   5. Auto-import   — Math/Array/etc usage triggers includeModule(...)
 *   6. Track schemas — object literals, Object.assign inference (inferAssignSchema)
 *
 * Each handler may touch multiple concerns, but helpers keep each concern self-contained.
 * Unhandled ops fall through to recursive prep() of their children.
 *
 * # Forward seeding (the two compile/ imports — deliberate, not a layering leak)
 * Prepare is the only pass that sees module-scope declarations in source order,
 * so it seeds two compile-stage fact stores AS it walks (re-deriving them later
 * would need a second whole-AST pass over information prepare already holds):
 *   - `recordGlobalRep` (compile/infer.js)        — module-global value reps
 *   - `observeNodeFacts` (compile/program-facts.js) — per-node program facts
 * The contract is write-only: prepare never READS compile-stage state, so the
 * stage remains re-runnable and compile owns every read path.
 *
 * @module prepare
 */

import { REFS_THROUGH_ARROWS, refsName, walkAst } from '../ast.js'
import { TIMER_NAMES, includeForCallableValue, includeForTimerRuntime, includeModule } from '../autoload.js'
import { FIRST_CLASS_BUILTIN_NAMES } from '../compile/emit.js'
import { ctx } from '../ctx.js'
import { MUTATING_ARRAY_METHODS } from './const-fold.js'
import { prep } from './handlers.js'
import { normalizeIdents, scanReassignedTopLevel } from './ident-purity.js'
import { hoistIndexedConstLiterals, seedStaticGlobalAssignments } from './literals.js'
import { validateCoalesceMixing } from './module-resolve.js'
import { prepState, resetPrepState } from './state.js'
export { GLOBALS } from './state.js'



export default function prepare(node) {
  // This direct call must stay even though reset()'s RESET_HOOKS (ctx.js) also
  // clears this working set before every prepare() call (beginSession, raw-reset
  // test harnesses — every caller runs reset() first). The two are NOT redundant:
  // omitting the direct call crashes the SELF-COMPILED kernel ("memory access out
  // of bounds" on the very first compile) even though native + full battery +
  // JZ_DEBUG_INVARIANTS pass byte-identically without it. module/regex.js's and
  // optimize/vectorize.js's equivalent hooks, registered the same way, do NOT
  // have this requirement — the dependency is specific to this working set, via
  // some closure reachable only indirectly through RESET_HOOKS; the exact
  // mechanism is not otherwise documented. resetPrepState() is idempotent and
  // cheap, so keeping BOTH the direct call and the registration is correct, not
  // a half-migration — see .work/session-survey.md for the full account.
  resetPrepState()
  // Inject the module-include primitive so stdlib modules can pull dependency
  // modules (e.g. object → collection) without importing autoload.js — that
  // import would cycle (autoload imports every module via module/index.js).
  ctx.module.include = includeModule
  includeModule('core')
  // Empty or whitespace-only source parses to a bare '' — an empty program, not an
  // identifier reference. Normalize to an empty statement so it compiles to a bare
  // `(module)` instead of a `(local.get $)` against a zero-length name. (A non-empty
  // bare identifier like `foo` parses to `'foo'` and stays a real reference.)
  if (node === '') node = [';']
  validateCoalesceMixing(node)  // ES2020: reject unparenthesized `??` mixed with `||`/`&&`
  normalizeIdents(node)
  fuseSparseMapReads(node)  // AST-level fusion; needs pre-resolution shape — defined at end of file
  seedStaticGlobalAssignments(node)
  node = hoistIndexedConstLiterals(node)
  prepState.reassignedTopLevel = scanReassignedTopLevel(node)
  const ast = prep(node)
  // Top-level functions referenced as first-class values (e.g. `let o = { fn: g }`,
  // `arr.push(g)`, `return g`) need trampoline emission, which depends on the fn
  // module's closure.table machinery. defFunc paths don't trigger fn-module load,
  // so scan post-prep and include `fn` if any user func appears in a value position.
  // Same scan also catches inline arrows that survive prep (e.g. `{ m: (x) => x }`)
  // — defFunc only lifts arrows that are the direct RHS of a let/const/export default,
  // and depth-0 arrows in any other position (object property, ternary arm, return
  // value, ...) skip the depth>0 prep-time include, so they reach emit unsupported
  // unless we catch them here.
  if (!ctx.module.modules.fn) {
    const funcNames = new Set(ctx.funcs.list.map(f => f.name))
    // A bare reference is a first-class function VALUE if it names either a user
    // function or a builtin `builtinFunctionValue` can mint a closure-table entry
    // for (e.g. `xs.filter(Array.isArray)` — prep collapses the member access to
    // the string "Array.isArray" before this scan runs, same shape as a user name).
    const isFuncValueName = a => funcNames.has(a) || FIRST_CLASS_BUILTIN_NAMES.has(a)
    const visit = (n) => {
      if (!Array.isArray(n)) return false
      const [op, ...args] = n
      // Any inline arrow surviving prep is a closure value (defFunc-lifted ones
      // are extracted from the AST into ctx.funcs.list).
      if (op === '=>') return true
      if (op === '()') {
        // callee at args[0]: skip if it's a bare func name (direct call); recurse rest
        if (typeof args[0] !== 'string' || !funcNames.has(args[0])) {
          if (visit(args[0])) return true
        }
        for (let i = 1; i < args.length; i++) {
          const a = args[i]
          if (typeof a === 'string' && isFuncValueName(a)) return true
          if (visit(a)) return true
        }
        return false
      }
      if (op === '.' || op === '?.') {
        // obj at args[0] can be a func ref; prop at args[1] is a name, never a ref
        if (typeof args[0] === 'string' && funcNames.has(args[0])) return true
        return visit(args[0])
      }
      for (const a of args) {
        if (typeof a === 'string' && isFuncValueName(a)) return true
        if (visit(a)) return true
      }
      return false
    }
    let needs = visit(ast)
    // DEP-module top-level inits live in ctx.module.moduleInits, NOT the entry
    // ast (same convention as plan/scope.js's walk, program-facts.js's
    // initCallSites, dyn-closure-tables.js's topRoots, …) — without walking them
    // a bundled `export const T = { x2: (x) => … }` const-table's arrow property
    // is invisible to this scan, ctx.closure.table never gets set up, and the
    // importing module's `T.x2(n)` call reaches emit with no table to index into.
    if (!needs && ctx.module.moduleInits) for (const mi of ctx.module.moduleInits) if (visit(mi)) { needs = true; break }
    if (!needs) for (const f of ctx.funcs.list) if (f.body && visit(f.body)) { needs = true; break }
    if (!needs && ctx.module.initFacts?.hasFuncValue) needs = true
    if (needs) includeForCallableValue()
  }

  // Native timers: inline WASM timer queue when referenced (no host imports needed)
  const usedTimers = new Set(ctx.module.initFacts?.timerNames || [])
  const scanTimers = (n) => {
    if (!Array.isArray(n)) {
      if (typeof n === 'string' && TIMER_NAMES.has(n)) usedTimers.add(n)
      return
    }
    for (let i = 0; i < n.length; i++) scanTimers(n[i])
  }
  const allNodes = [ast, ...ctx.funcs.list.map(f => f.body)]
  for (const node of allNodes) scanTimers(node)
  if (usedTimers.size) {
    includeForTimerRuntime()
  }

  // Invalidate shapeStrs for any module-level binding that's later assigned to.
  // shapeStrs is "effectively-const string literals at module scope" — used by
  // shape.js's jsonConstString to enable shape inference on `let SRC = '{...}'`
  // patterns (bench convention) without enabling the const-only static fold.
  // The scan must skip `=` nodes that are children of `let`/`const`/`export` —
  // those are decl-initializers, not reassignments.
  if (ctx.scope.shapeStrs?.size || ctx.scope.shapeStrArrays?.size) {
    const writes = new Set()
    // inDecl only ever depends on the DIRECT parent's op (never accumulates past one
    // level — a nested '=' inside a decl's own init expression is a real reassignment
    // again), so it's read off walkAst's `parent` argument instead of threaded state.
    const scan = (n, parent) => {
      const inDecl = parent != null && (parent[0] === 'let' || parent[0] === 'const' || parent[0] === 'var' || parent[0] === 'export')
      const [op, lhs] = n
      if (op === '=' && typeof lhs === 'string' && !inDecl) writes.add(lhs)
      if (op === '=' && Array.isArray(lhs) && lhs[0] === '[]' && typeof lhs[1] === 'string' && !inDecl) writes.add(lhs[1])
      // Compound assigns desugar to `=`; increments emit as `++`/`--` post-prep.
      if ((op === '++' || op === '--') && typeof lhs === 'string') writes.add(lhs)
      if ((op === '++' || op === '--') && Array.isArray(lhs) && lhs[0] === '[]' && typeof lhs[1] === 'string') writes.add(lhs[1])
      if (op === '()' && Array.isArray(lhs) && lhs[0] === '.' && typeof lhs[1] === 'string' && MUTATING_ARRAY_METHODS.has(lhs[2])) writes.add(lhs[1])
    }
    walkAst(ast, { enter: scan })
    for (const f of ctx.funcs.list) if (f.body) walkAst(f.body, { enter: scan })
    for (const name of writes) {
      ctx.scope.shapeStrs?.delete(name)
      ctx.scope.shapeStrArrays?.delete(name)
    }
  }

  return ast
}

// =============================================================================
// AST-level fusion passes (pre-resolution)
// =============================================================================
// Unlike src/optimize.js (a pure WAT IR→IR rewrite, post-emission), these
// rewrites need the *raw, pre-resolution* AST shape — bindings still named,
// arrow bodies still inline — so they run inside prepare(), before scope
// resolution and emit. They mutate the AST in place; shape guards are strict
// enough that misfires are impossible.

/** Sparse-read .map fusion: rewrite `const b = a.map(arrow); for(...; j<b.length; ...) USE(b[j])`
 *  into a fused for-loop that inlines `arrow(a[j])` at the read site, eliminating the materialized
 *  intermediate array. Only fires on shapes where every use of `b` is a numeric `b[idx]` read or a
 *  `b.length` read, the arrow is pure with a single named param, and `b` is not referenced after the
 *  consumer for-loop. Preserves observable behavior because the arrow's pure-expression body has no
 *  order-dependent effects. */
function fuseSparseMapReads(root) {
  walkAst(root, { exit: node => { if (node[0] === ';') tryFuseInBlock(node) } })
}
function tryFuseInBlock(seq) {
  for (let i = 1; i < seq.length - 1; i++) {
    const fused = tryFusePair(seq[i], seq[i + 1], seq, i)
    if (fused) {
      seq.splice(i, 2, ...fused)
      i--  // re-examine same position (chained fusions)
    }
  }
}
function tryFusePair(decl, forNode, seq, declIdx) {
  if (!Array.isArray(decl) || (decl[0] !== 'const' && decl[0] !== 'let')) return null
  if (decl.length !== 2) return null  // single binding only
  const bind = decl[1]
  if (!Array.isArray(bind) || bind[0] !== '=' || typeof bind[1] !== 'string') return null
  const NAME = bind[1], rhs = bind[2]
  if (!Array.isArray(rhs) || rhs[0] !== '()') return null
  const callee = rhs[1]
  if (!Array.isArray(callee) || callee[0] !== '.' || callee[2] !== 'map') return null
  const RECV = callee[1]
  if (typeof RECV !== 'string' || RECV === NAME) return null
  const arrow = rhs[2]
  if (!Array.isArray(arrow) || arrow[0] !== '=>') return null
  // Single-name param only: `x => …` or `(x) => …`
  const ap = arrow[1]
  const PARAM = typeof ap === 'string' ? ap :
    (Array.isArray(ap) && ap[0] === '()' && typeof ap[1] === 'string' ? ap[1] : null)
  if (!PARAM || PARAM === NAME || PARAM === RECV) return null
  // Body: single-expression arrow only (block bodies skipped — could extend later).
  const aBody = arrow[2]
  if (Array.isArray(aBody) && aBody[0] === '{}') return null
  if (!isPureSparseArrowBody(aBody, PARAM)) return null
  // For-loop: ['for', [';', initStmt, cond, inc], body]
  if (!Array.isArray(forNode) || forNode[0] !== 'for' || forNode.length !== 3) return null
  const head = forNode[1]
  if (!Array.isArray(head) || head[0] !== ';' || head.length !== 4) return null
  const cond = head[2], forBody = forNode[2]
  // Verify `NAME` is used only as `NAME[idx]` or `NAME.length` inside cond+forBody.
  if (!hasOnlySparseUses(cond, NAME)) return null
  if (!hasOnlySparseUses(forBody, NAME)) return null
  if (!hasAnyIndexedRead(forBody, NAME) && !hasAnyIndexedRead(cond, NAME)) return null
  // `NAME` must not be read after the for-loop in the same block.
  for (let k = declIdx + 2; k < seq.length; k++) {
    if (refsName(seq[k], NAME, REFS_THROUGH_ARROWS)) return null
  }
  // RECV must not be reassigned inside the for-loop (would invalidate substitution).
  if (assignsName(forNode, RECV) || assignsName(forNode, NAME)) return null
  // PARAM must not collide with any binding inside forBody (otherwise substitution shadows wrongly).
  if (bindsName(forNode, PARAM)) return null
  // Apply substitution: NAME.length → RECV.length; NAME[idx] → arrowBody[PARAM ← RECV[idx]].
  const newCond = substSparse(cond, NAME, RECV, PARAM, aBody)
  const newBody = substSparse(forBody, NAME, RECV, PARAM, aBody)
  const newHead = [';', head[1], newCond, head[3]]
  return [['for', newHead, newBody]]
}
function isPureSparseArrowBody(n, PARAM) {
  if (typeof n === 'string') return true
  if (!Array.isArray(n)) return true
  const op = n[0]
  // Calls / new / assignments / increments are unsafe for repeated-substitution semantics.
  if (op === '()' || op === '?.()' || op === 'new' || op === '++' || op === '--') return false
  if (op === '=>') return false  // nested closure is opaque
  if (typeof op === 'string' && op !== '=>' && op !== '===' && op !== '!==' && op !== '==' && op !== '!=' && op !== '<=' && op !== '>=' && op.endsWith('=') && op !== '=') return false
  if (op === '=') return false
  for (let i = 1; i < n.length; i++) if (!isPureSparseArrowBody(n[i], PARAM)) return false
  return true
}
function hasOnlySparseUses(n, NAME) {
  if (typeof n === 'string') return n !== NAME
  if (!Array.isArray(n)) return true
  const op = n[0]
  if (op === '[]' && n.length === 3 && n[1] === NAME) return hasOnlySparseUses(n[2], NAME)  // NAME[idx] — idx must not reference NAME
  if (op === '.' && n[1] === NAME) {
    if (n[2] === 'length') return true
    return false  // any other property access on NAME is opaque
  }
  for (let i = 1; i < n.length; i++) if (!hasOnlySparseUses(n[i], NAME)) return false
  return true
}
function hasAnyIndexedRead(n, NAME) {
  if (!Array.isArray(n)) return false
  if (n[0] === '[]' && n.length === 3 && n[1] === NAME) return true
  for (let i = 1; i < n.length; i++) if (hasAnyIndexedRead(n[i], NAME)) return true
  return false
}
function assignsName(n, NAME) {
  if (!Array.isArray(n)) return false
  const op = n[0]
  if ((op === '=' || op === '++' || op === '--' ||
       (typeof op === 'string' && op.endsWith('=') && op !== '==' && op !== '===' && op !== '!=' && op !== '!==' && op !== '<=' && op !== '>='))
      && n[1] === NAME) return true
  for (let i = 1; i < n.length; i++) if (assignsName(n[i], NAME)) return true
  return false
}
function bindsName(n, NAME) {
  if (!Array.isArray(n)) return false
  const op = n[0]
  if ((op === 'let' || op === 'const')) {
    for (let i = 1; i < n.length; i++) {
      const bind = n[i]
      if (Array.isArray(bind) && bind[0] === '=' && bind[1] === NAME) return true
    }
  }
  if (op === '=>') {
    const p = n[1]
    if (p === NAME) return true
    if (Array.isArray(p)) {
      if (p[0] === '()' && p[1] === NAME) return true
      // skip deeper destructuring forms — conservative
    }
  }
  for (let i = 1; i < n.length; i++) if (bindsName(n[i], NAME)) return true
  return false
}
function substSparse(n, NAME, RECV, PARAM, arrowBody) {
  if (typeof n !== 'object' || n === null || !Array.isArray(n)) return n
  if (n[0] === '.' && n[1] === NAME && n[2] === 'length') return ['.', RECV, 'length']
  if (n[0] === '[]' && n.length === 3 && n[1] === NAME) {
    const idx = substSparse(n[2], NAME, RECV, PARAM, arrowBody)
    return cloneAndBind(arrowBody, PARAM, ['[]', RECV, idx])
  }
  return n.map((c, i) => i === 0 ? c : substSparse(c, NAME, RECV, PARAM, arrowBody))
}
function cloneAndBind(node, PARAM, replacement) {
  if (node === PARAM) return replacement
  if (!Array.isArray(node)) return node
  return node.map((c, i) => i === 0 ? c : cloneAndBind(c, PARAM, replacement))
}
