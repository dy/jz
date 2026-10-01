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

import { ctx, emitArity, PTR } from '../ctx.js'
import { TIMER_NAMES, includeForCallableValue, includeForTimerRuntime, includeModule } from '../autoload.js'
import { T, MUTATE_OPS, walkAst } from '../ast.js'
import { MUTATING_ARRAY_METHODS } from './const-fold.js'
import { prep } from './handlers.js'
import { scanReassignedTopLevel } from './ident-purity.js'
import { hoistIndexedConstLiterals, seedStaticGlobalAssignments } from './literals.js'
import { validateCoalesceMixing } from './module-resolve.js'
import { fuseSparseMapReads } from './sparse-map.js'
import { prepState, resetPrepState } from './state.js'
import { splitReassigned } from './split-bindings.js'
import { settleModules } from './module-eval.js'
import { frameNode } from '../function.js'



// A builtin function referenced as a value (`xs.every(Number.isFinite)`,
// `arr.map(Math.round)`) becomes a
// top-level arrow of the builtin's arity, lifted like any user function, so
// the closure machinery carries it. Callee positions and property keys are
// not values. The wrapper is minted once per builtin.
const COLLECTION_METHODS = new Map([
  ['set', ['Map']], ['get', ['Map']], ['add', ['Set']],
  ...['has', 'delete', 'clear', 'keys', 'values', 'entries', 'forEach'].map(name => [name, ['Map', 'Set']]),
])
const wrapBuiltinValues = (ast) => {
  const wrappers = new Map()
  const inits = []
  const sourceFuncs = ctx.funcs.list.slice()
  const methodReaders = new Map()
  // These are compiler intrinsics, independent of same-named user bindings.
  const receiverIs = (name, ctor) => ['__ptr_is', name, [null, PTR[ctor.toUpperCase()]]]
  const declare = (name, params, body) => {
    const decl = prep(['const', ['=', name, ['=>', ['()', params], body]]])
    if (decl != null) inits.push(decl)
    return name
  }
  const methodFor = (ctor, prop) => {
    if (ctor === 'Set' && prop === 'keys') prop = 'values'
    const key = `.${ctor.toLowerCase()}:${prop}`
    let name = wrappers.get(key)
    if (name) return ['()', name, [',']]
    includeModule('collection')
    const native = ctx.core.emit[key] ? key : '.' + prop
    name = `${T}bm${wrappers.size}_${ctor}_${prop}`
    wrappers.set(key, name)
    const params = Array.from({ length: emitArity(ctx.core.emit[native], '.' + prop) - 1 }, (_, i) => `${T}a${i}`)
    const recv = `${T}receiver`
    let result = ['()', native, [',', recv, ...params]]
    if (prop === 'has' || prop === 'delete') result = ['!', ['!', result]]
    if (prop === 'forEach') params[1] = ['=', params[1], []]
    const wrapper = ['=>', ['()', params.length === 1 ? params[0] : [',', ...params]], ['{}', [';',
      ['const', ['=', recv, ['this']]],
      ['if', ['!', receiverIs(recv, ctor)], ['__throw_method_receiver']],
      ['return', result]]]]
    declare(name, [','], ['{}', ['return', wrapper]])
    return ['()', name, [',']]
  }
  const readerFor = prop => {
    if (methodReaders.has(prop)) return methodReaders.get(prop)
    const families = COLLECTION_METHODS.get(prop)
    if (!families) return null
    const name = `${T}br${methodReaders.size}_${prop}`, recv = `${T}receiver`
    const reader = { name, sites: [] }; methodReaders.set(prop, reader)
    const body = [['if', ['()', 'Object.hasOwn', [',', recv, ['str', prop]]], ['return', ['__data_prop', recv, ['str', prop]]]]]
    for (const ctor of families) body.push(['if', receiverIs(recv, ctor), ['return', methodFor(ctor, prop)]])
    body.push(['return', ['__data_prop', recv, ['str', prop]]])
    declare(name, recv, ['{}', [';', ...body]])
    ctx.funcs.list[ctx.funcs.list.length - 1].sig.dispatcher = true
    ;(ctx.funcs.builtinMethodReaders ||= new Map()).set(prop, reader)
    return reader
  }
  const computedReader = () => {
    if (methodReaders.has(null)) return methodReaders.get(null)
    const name = `${T}br_computed`, recv = `${T}receiver`, key = `${T}property`
    const reader = { name, sites: [] }; methodReaders.set(null, reader)
    const body = [
      ['if', ['!', ['||', receiverIs(recv, 'Map'), receiverIs(recv, 'Set')]], ['return', ['__data_key', recv, key]]],
      ['=', key, ['()', T + 'key', key]],
    ]
    for (const prop of COLLECTION_METHODS.keys()) {
      readerFor(prop)
      body.push(['if', ['===', key, ['str', prop]], ['return', ['.', recv, prop]]])
    }
    body.push(['return', ['__data_key', recv, key]])
    declare(name, [',', recv, key], ['{}', [';', ...body]])
    ctx.funcs.list[ctx.funcs.list.length - 1].sig.dispatcher = true
    ctx.funcs.builtinMethodReaders.set(null, reader)
    return reader
  }
  const isBuiltinValue = (s) => typeof s === 'string' && s.indexOf('.') > 0
    && ctx.core.emit[s] != null && emitArity(ctx.core.emit[s], s) > 0 && !ctx.funcs.names.has(s)
  const wrapperFor = (name) => {
    let w = wrappers.get(name)
    if (w) return w
    w = `${T}bw${wrappers.size}_${name.replace(/\W/g, '_')}`
    const n = emitArity(ctx.core.emit[name], name)
    const params = Array.from({ length: n }, (_, i) => `${T}a${i}`)
    const args = params.length === 1 ? params[0] : [',', ...params]
    const decl = prep(['const', ['=', w, ['=>', ['()', args], ['()', name, args]]]])
    if (decl != null) inits.push(decl)
    wrappers.set(name, w)
    ;(ctx.funcs.builtinWrapped ||= new Map()).set(w, name)
    return w
  }
  const visit = (n, reference = false, scope = '') => {
    if (!Array.isArray(n) || n[0] == null || n[0] === 'str' || n[0] === '`' || n[0] === '//') return n
    const op = n[0]
    for (let i = 1; i < n.length; i++) {
      const child = n[i]
      if (typeof child === 'string') {
        if (op === '()' && i === 1) continue
        if ((op === '.' || op === '?.') && i === 2) continue
        if (op === ':' && i === 1) continue
        if (isBuiltinValue(child)) n[i] = wrapperFor(child)
      } else n[i] = visit(child, i === 1 && (op === '()' || op === '?.()') ? 'call'
        : i === 1 && (op === 'delete' || MUTATE_OPS.has(op)) ? 'write' : false, op === '=>' ? n[2] : scope)
    }
    if (reference !== 'write' && (op === '[]' || op === '?.[]') && n.length === 3 && n[2]?.[0] !== 'str' &&
        !(Array.isArray(n[2]) && n[2][0] == null))
      computedReader().sites.push([scope, n[1], n[2]])
    const read = op === '.' || op === '?.' ||
      (op === '[]' || op === '?.[]') && n.length === 3 && n[2]?.[0] === 'str'
    if (!read || reference) return n
    const prop = op === '.' || op === '?.' ? n[2] : n[2][1]
    const ctor = typeof n[1] === 'string' && n[1].endsWith('.prototype') ? n[1].slice(0, -10) : null
    if (ctor && COLLECTION_METHODS.get(prop)?.includes(ctor)) return methodFor(ctor, prop)
    readerFor(prop)?.sites.push([scope, n[1]])
    return n
  }
  ast = visit(ast)
  if (ctx.module.moduleInits) for (let i = 0; i < ctx.module.moduleInits.length; i++) ctx.module.moduleInits[i] = visit(ctx.module.moduleInits[i])
  for (const f of sourceFuncs) {
    if (f.body) f.body = visit(f.body, false, f.name)
    if (f.defaults) for (const name of Object.keys(f.defaults)) f.defaults[name] = visit(f.defaults[name], false, f.name)
  }
  if (!inits.length) return ast
  return Array.isArray(ast) && ast[0] === ';' ? [';', ...inits, ...ast.slice(1)] : [';', ...inits, ast]
}

export default function prepare(node) {
  // This direct call must stay even though reset()'s RESET_HOOKS (ctx.js) also
  // clears this working set before every prepare() call (beginSession, raw-reset
  // test harnesses — every caller runs reset() first). The two are NOT redundant:
  // omitting the direct call crashes the SELF-COMPILED kernel ("memory access out
  // of bounds" on the very first compile) even though native + full battery +
  // JZ_DEBUG_INVARIANTS pass byte-identically without it. module/regex.js's and
  // optimize/vectorize/'s equivalent hooks, registered the same way, do NOT
  // have this requirement — the dependency is specific to this working set, via
  // some closure reachable only indirectly through RESET_HOOKS; the exact
  // mechanism is not otherwise documented. resetPrepState() is idempotent and
  // cheap, so keeping BOTH the direct call and the registration is correct, not
  // a half-migration — see .work/archive/session-survey.md for the full account.
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
  ctx.module.ast = node
  validateCoalesceMixing(node)  // ES2020: reject unparenthesized `??` mixed with `||`/`&&`
  fuseSparseMapReads(node)  // AST-level fusion; needs pre-resolution shape — defined at end of file
  seedStaticGlobalAssignments(node)
  node = hoistIndexedConstLiterals(node)
  prepState.reassignedTopLevel = scanReassignedTopLevel(node)
  let ast = prep(node)
  settleModules(prep)
  ast = wrapBuiltinValues(ast)
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
    // function (including a normalized builtin wrapper) needs a closure-table entry
    // for (e.g. `xs.filter(Array.isArray)` — prep collapses the member access to
    // the string "Array.isArray" before this scan runs, same shape as a user name).
    const isFuncValueName = a => funcNames.has(a)
    const visit = (n) => {
      if (!Array.isArray(n)) return false
      const op = n[0]
      // Any inline arrow surviving prep is a closure value (defFunc-lifted ones
      // are extracted from the AST into ctx.funcs.list).
      if (op === '=>') return true
      if (op === '()') {
        // Skip a bare direct callee; recurse through the receiver and arguments.
        if (typeof n[1] !== 'string' || !funcNames.has(n[1])) {
          if (visit(n[1])) return true
        }
        for (let i = 2; i < n.length; i++) {
          const child = n[i]
          if (typeof child === 'string' && isFuncValueName(child)) return true
          if (visit(child)) return true
        }
        return false
      }
      if (op === '.' || op === '?.') {
        // The receiver can be a function reference; the property name cannot.
        if (typeof n[1] === 'string' && funcNames.has(n[1])) return true
        return visit(n[1])
      }
      for (let i = 1; i < n.length; i++) {
        const child = n[i]
        if (typeof child === 'string' && isFuncValueName(child)) return true
        if (visit(child)) return true
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
    for (const f of ctx.funcs.list) if (f.body) walkAst(frameNode(f), { enter: scan })
    for (const name of writes) {
      ctx.scope.shapeStrs?.delete(name)
      ctx.scope.shapeStrArrays?.delete(name)
    }
  }

  // Last: every scan above reads the bindings as the source wrote them.
  if (ctx.transform.optimize?.splitBindings !== false)
    for (const f of ctx.funcs.list) if (f.body && !f.raw) f.body = splitReassigned(f)

  return ast
}
