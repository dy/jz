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

import { ctx } from '../ctx.js'
import { TIMER_NAMES, includeForCallableValue, includeForTimerRuntime, includeModule } from '../autoload.js'
import { FIRST_CLASS_BUILTIN_NAMES } from '../compile/emit.js'
import { walkAst } from '../ast.js'
import { MUTATING_ARRAY_METHODS } from './const-fold.js'
import { prep } from './handlers.js'
import { normalizeIdents, scanReassignedTopLevel } from './ident-purity.js'
import { hoistIndexedConstLiterals, seedStaticGlobalAssignments } from './literals.js'
import { validateCoalesceMixing } from './module-resolve.js'
import { fuseSparseMapReads } from './sparse-map.js'
import { prepState, resetPrepState } from './state.js'



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