/**
 * AST preparation: single-pass traversal that validates, resolves, and normalizes.
 *
 * # Stage contract
 *   IN:  raw jessie AST from subscript/jessie (possibly jzified).
 *   OUT: normalized AST + populated `ctx.func.list`, `ctx.module.imports`, `ctx.schema.list`,
 *        `ctx.scope.consts`, `ctx.module.moduleInits`.
 *   POST: no `var`/`function`/`class`/`this` remain; ++/-- rewritten as +=/-=; arrow
 *        bodies carry no type metadata yet (that's analyze/compile's job).
 *
 * # Concerns (per-node handler table, applied together per op)
 *   1. Validate      — reject prohibited features (this, class, async, var, delete, ...)
 *   2. Resolve       — scope chain + import bindings (Math.sin → math.sin, etc.)
 *   3. Extract       — arrow functions → ctx.func.list with sig
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

import { handlerArgs, refsName, ASSIGN_OPS, JZ_NULL, JZ_UNDEF, TYPEOF } from '../ast.js'
import { ctx, err, derive, emitArity, declGlobal } from '../ctx.js'
import { T } from '../ast.js'
import { extractParams, collectParamNames, classifyParam } from '../ast.js'
import { observeNodeFacts } from '../compile/program-facts.js'
import { staticObjectProps, staticPropertyKey } from '../static.js'
import { VAL } from '../reps.js'
import { STMT_OPS } from '../ast.js'
import { REJECT_IDENTS, REJECT_OPS, rejectHandlers } from '../op-policy.js'
import { recordGlobalRep } from '../compile/infer.js'
import { isFuncRef } from '../ir.js'
import {
  CTORS, COLLECTION_CTORS, TIMER_NAMES,
  hasModule, includeModule, includeMods,
  includeForArrayAccess, includeForArrayLiteral, includeForArrayPattern, includeForCallableValue,
  includeForGenericMethod, includeForKnownKeyIteration, includeForNamedCall, includeForNumericCoercion,
  includeForObjectLiteral, includeForObjectPattern, includeForOp, includeForProperty, includeForRuntimeCtor,
  includeForRuntimeKeyIteration, includeForStringOnly, includeForStringValue, includeForTimerRuntime,
} from '../autoload.js'

// SIMD intrinsic namespaces — pure namespaces backed by the `simd` module.
const SIMD_NS = new Set(['f32x4', 'i32x4', 'f64x2', 'v128'])

// Ops the expression parser binds LOOSER than relational `in`/`of` — in a for-in/of
// head they strand around the `in` node and must re-associate into the iteration
// source (see the 'for' handler). Assignments, sequence, ternary, logical, equality,
// bitwise; everything tighter already lives inside the `in` node's operands.
const FORIN_WRAPPERS = new Set([...ASSIGN_OPS, ',', '?', '&&', '||', '??', '==', '!=', '===', '!==', '&', '^', '|'])

// Module-level prepare state. Six independent stacks/scalars that together form
// the prepare-pass working set. Lifecycle: reinitialized via `resetPrepState()`
// at the top of `prepare()` (line ~368) — any throw inside prepare is cleared
// on the next entry, so leak across compilations is impossible. Kept at module
// scope (rather than ctx.prepare.*) because 78 read sites would mean a single
// indirection on every scope query; the consolidated reset documents the set.
let depth          // arrow nesting depth (0=top-level, >0=inside function)
let scopes         // block scope stack: [{names: Set, renames: Map}]
let staticConstScopes  // lexical const facts: [{strings: Map, arrays: Map}]
let assignedStaticGlobals
// Per-arrow set of names already declared anywhere in the function body. Used
// to force a rename when the same identifier is declared in two sibling blocks
// (else-if arms, separate { ... } chunks): without renaming, both decls lower
// to the same WASM local, but downstream optimizations (directClosures) gate
// on per-decl `isReassigned`, not per-WASM-local — they'd read a stale binding.
let funcLocalNames
// Per-arrow set of local names bound to a function literal (`let g = () => …`).
// Lets the `.`-handler tell a function receiver — where `.caller`/`.callee` are
// prohibited introspection — from a data object that merely has such a field.
let funcValueNames

const resetPrepState = () => {
  depth = 0
  scopes = []
  staticConstScopes = []
  assignedStaticGlobals = new Set()
  funcLocalNames = [new Set()]
  funcValueNames = [new Set()]
}

// ES spec: identifier with \uHHHH or \u{...} escape is equivalent to the decoded
// form. subscript preserves raw spelling in the AST; normalize once before prep.
const IDESC = /\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g
const decodeIdent = s => s.includes('\\u')
  ? s.replace(IDESC, (_, b, p) => String.fromCodePoint(parseInt(b || p, 16)))
  : s

// A for-loop bound `arr.length` may be snapshotted into a pre-loop local only when
// nothing in the loop can change it. Two ways it can change: a write to the receiver
// (`arr = …`, `arr.length = …`, `arr[k] = …`) or a call — push/pop/splice mutate
// directly, and any call can reach `arr` through an alias the compiler can't track
// locally (compilePendingClosures grows ctx.closure.bodies this way). Both predicates
// recurse the whole node; nested arrow *definitions* are harmless until invoked, and
// an invocation is itself a call node, so `callFree` already covers escaped mutators.
const callFree = node => {
  if (!Array.isArray(node)) return true
  if (node[0] === '()' || node[0] === 'new') return false
  for (let i = 1; i < node.length; i++) if (!callFree(node[i])) return false
  return true
}
// Calls that provably can't resize ANY receiver: read-only builtin methods
// (no mutators, no callback-takers — a callback could close over the receiver
// and push) and pure namespaces. Everything else (user fns, push/splice,
// map/forEach) may reach the bound receiver through an alias — disqualifies
// the length snapshot. A user object shadowing one of these names with a
// mutating closure is a documented divergence (same class as for-of's).
const _BOUND_PURE_NS = new Set(['Math', 'math', 'Number', 'String', 'JSON', 'console', 'Date', 'performance'])
const _BOUND_RO_METHODS = new Set([
  'charCodeAt', 'charAt', 'codePointAt', 'at', 'indexOf', 'lastIndexOf', 'includes',
  'startsWith', 'endsWith', 'slice', 'substring', 'trim', 'toUpperCase', 'toLowerCase',
  'join', 'concat', 'toString', 'get', 'has', 'now',
])
const boundSafeCalls = node => {
  if (!Array.isArray(node)) return true
  if (node[0] === 'new') return false
  if (node[0] === '()' || node[0] === '?.()') {
    const callee = node[1]
    const safe = Array.isArray(callee) && (callee[0] === '.' || callee[0] === '?.') &&
      (_BOUND_RO_METHODS.has(callee[2]) ||
       (typeof callee[1] === 'string' && _BOUND_PURE_NS.has(callee[1])))
    if (!safe) return false
  }
  for (let i = 1; i < node.length; i++) if (!boundSafeCalls(node[i])) return false
  return true
}
const writesReceiver = (node, recv) => {
  if (!Array.isArray(node)) return false
  const op = node[0]
  if ((ASSIGN_OPS.has(op) || op === '++' || op === '--') &&
      (node[1] === recv ||
       (Array.isArray(node[1]) && (node[1][0] === '[]' || node[1][0] === '.') && node[1][1] === recv)))
    return true
  for (let i = 1; i < node.length; i++) if (writesReceiver(node[i], recv)) return true
  return false
}

const normalizeIdents = node => {
  if (!Array.isArray(node)) return
  // Literal-value wrapper [null, X] / [undefined, X]: X is a value, not an identifier
  if (node.length === 2 && node[0] == null) return
  for (let i = 1; i < node.length; i++) {
    const v = node[i]
    if (typeof v === 'string') node[i] = decodeIdent(v)
    else if (Array.isArray(v)) normalizeIdents(v)
  }
}

const hostReturnValType = spec => {
  if (!spec || typeof spec === 'function') return null
  // Return type is the canonical string name ('number'/'string'/'bigint'/'f64').
  // (Earlier this also accepted the constructor identity `ret === String` etc.,
  // but that references host-only globals with no first-class value in jz — it
  // broke self-hosting and was never used. String names are the portable form.)
  const ret = spec.returns ?? spec.return ?? spec.result
  if (ret === 'number' || ret === 'f64') return VAL.NUMBER
  if (ret === 'string') return VAL.STRING
  if (ret === 'bigint') return VAL.BIGINT
  return null
}

const addHostImport = (mod, name, alias, spec) => {
  // A numeric host constant (e.g. `Math.PI` via `{ imports: { math: Math } }`) has no callable
  // ABI — record it so references fold to an f64 literal (see prep's identifier resolution) instead
  // of emitting a 0-arg func import that can't be read as a value ("'PI' is not in scope").
  if (typeof spec === 'number') {
    if (!ctx.scope.hostConsts) ctx.scope.hostConsts = Object.create(null)  // name-keyed: prototype-less (see derive)
    ctx.scope.hostConsts[alias] = spec
    return
  }
  const nParams = typeof spec === 'function' ? spec.length : (spec?.params || 0)
  // User-supplied imports carry NaN-boxed values via i64 (not f64) so V8 cannot
  // canonicalize the NaN payload across the wasm↔JS function boundary —
  // same hazard as env.print / __ext_*. Call sites wrap args with asI64()
  // and unwrap the i64 return with f64.reinterpret_i64.
  const params = Array(nParams).fill(['param', 'i64'])
  if (!ctx.module.imports.some(i => i[3]?.[1] === `$${alias}`)) {
    ctx.module.imports.push(['import', `"${mod}"`, `"${name}"`, ['func', `$${alias}`, ...params, ['result', 'i64']]])
  }
  ctx.scope.chain[alias] = alias
  const vt = hostReturnValType(spec)
  if (vt) ctx.module.hostImportValTypes.set(alias, vt)
}

const isImportMeta = node => Array.isArray(node) && node[0] === '.' && node[1] === 'import' && node[2] === 'meta'
const isImportMetaProp = (node, prop) => Array.isArray(node) && node[0] === '.' && isImportMeta(node[1]) && node[2] === prop
// In a pure boolean position (consumer reads only truthiness) `!!e` is exactly `e`.
// Drop redundant double-negation; recurse so `!!!!e → e`. NOT valid for `&&`/`||`
// operands — those are value-preserving (`!!a && b` returns `false`, not `a`).
const stripBoolNot = c => {
  while (Array.isArray(c) && c[0] === '!' && Array.isArray(c[1]) && c[1][0] === '!') c = c[1][1]
  return c
}
// In a statement (value-discarded) position, postfix `x++`/`x--` is lowered to `(++x) − 1` /
// `(--x) + 1` to recover the old value — but nobody reads it, so drop the ∓1 and keep the bare
// increment. (`obj.p++` lowers via `obj.p = obj.p + 1`, also wrapped.) Cleaner AST for the loop/
// recurrence passes; codegen already discarded the ∓1, so this is purely canonicalization.
const isOne = n => Array.isArray(n) && n[0] == null && n[1] === 1
const dropDeadPostfix = s => {
  if (Array.isArray(s) && s.length === 3 && isOne(s[2]) && Array.isArray(s[1])) {
    const inner = s[1][0]
    if ((s[0] === '-' && (inner === '++' || inner === '=')) ||
        (s[0] === '+' && (inner === '--' || inner === '='))) return s[1]
  }
  return s
}
const stringValue = node => Array.isArray(node) && node[0] == null && typeof node[1] === 'string' ? node[1] : null
const MUTATING_ARRAY_METHODS = new Set(['copyWithin', 'fill', 'pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift'])

function staticStringArrayValues(expr) {
  if (!Array.isArray(expr) || expr[0] !== '[]' || expr.length !== 2) return null
  const raw = Array.isArray(expr[1]) && expr[1][0] === ',' ? expr[1].slice(1) : [expr[1]]
  const out = []
  for (const item of raw) {
    const s = staticStringExpr(item)
    if (s == null) return null
    out.push(s)
  }
  return out
}

function immediateStaticStringExpr(node) {
  const lit = stringValue(node)
  if (lit != null) return lit
  if (Array.isArray(node) && node[0] === 'str' && typeof node[1] === 'string') return node[1]
  if (!Array.isArray(node)) return null
  const [op, ...args] = node
  if (op === '+') {
    const a = immediateStaticStringExpr(args[0])
    const b = immediateStaticStringExpr(args[1])
    return a != null && b != null ? a + b : null
  }
  if (op === '`') {
    let out = ''
    for (const part of args) {
      const s = immediateStaticStringExpr(part)
      if (s == null) return null
      out += s
    }
    return out
  }
  return null
}

function immediateStaticStringArrayValues(expr) {
  if (!Array.isArray(expr) || expr[0] !== '[]' || expr.length !== 2) return null
  const raw = Array.isArray(expr[1]) && expr[1][0] === ',' ? expr[1].slice(1) : [expr[1]]
  const out = []
  for (const item of raw) {
    const s = immediateStaticStringExpr(item)
    if (s == null) return null
    out.push(s)
  }
  return out
}

function eachTopLevelStatement(node, fn) {
  if (Array.isArray(node) && node[0] === ';') {
    for (let i = 1; i < node.length; i++) fn(node[i])
  } else {
    fn(node)
  }
}

function collectAssignmentWrites(node, writes) {
  if (!Array.isArray(node)) return
  const [op, lhs] = node
  if (op === '=' && typeof lhs === 'string') writes.set(lhs, (writes.get(lhs) || 0) + 1)
  if ((op === '++' || op === '--') && typeof lhs === 'string') writes.set(lhs, (writes.get(lhs) || 0) + 1)
  for (let i = 1; i < node.length; i++) collectAssignmentWrites(node[i], writes)
}

function collectTopLevelStaticAssignments(node, facts) {
  if (!Array.isArray(node)) return
  if (node[0] === ',') {
    for (let i = 1; i < node.length; i++) collectTopLevelStaticAssignments(node[i], facts)
    return
  }
  if (node[0] !== '=' || typeof node[1] !== 'string') return
  const str = immediateStaticStringExpr(node[2])
  const arr = immediateStaticStringArrayValues(node[2])
  if (str != null || arr) facts.set(node[1], { str, arr })
}

function seedStaticGlobalAssignments(node) {
  // jzify hoists function declarations ahead of `var` initializer assignments.
  // Seed one-write static globals before preparing those function bodies so
  // compile-time-only consumers (for example `new RegExp(`${PART}`)`) can still
  // resolve the same constants they would see after module initialization.
  const writes = new Map()
  const facts = new Map()
  collectAssignmentWrites(node, writes)
  eachTopLevelStatement(node, stmt => collectTopLevelStaticAssignments(stmt, facts))
  for (const [name, fact] of facts) {
    if (writes.get(name) === 1) bindStaticGlobal(name, fact.str, fact.arr)
  }
}

function stringArrayValues(expr) {
  if (!Array.isArray(expr) || expr[0] !== '[' || expr.length === 1) return null
  const out = []
  for (const item of expr.slice(1)) {
    if (!Array.isArray(item) || item[0] !== 'str' || typeof item[1] !== 'string') return null
    out.push(item[1])
  }
  return out
}

function staticString(value) {
  includeForStringValue()
  return ['str', value]
}

function lookupStaticString(name) {
  const resolved = scopes.length && isDeclared(name) ? resolveScope(name) : (ctx.scope.chain[name] || name)
  for (let i = staticConstScopes.length - 1; i >= 0; i--) {
    const v = staticConstScopes[i].strings.get(resolved)
    if (v != null) return v
  }
  return ctx.scope.shapeStrs?.get(resolved) ?? ctx.scope.constStrs?.get(resolved) ?? null
}

function lookupStaticStringArray(name) {
  const resolved = scopes.length && isDeclared(name) ? resolveScope(name) : (ctx.scope.chain[name] || name)
  for (let i = staticConstScopes.length - 1; i >= 0; i--) {
    const v = staticConstScopes[i].arrays.get(resolved)
    if (v) return v
  }
  return ctx.scope.shapeStrArrays?.get(resolved) ?? null
}

/** Evaluate a constant numeric expression (number literals + basic arithmetic) for
 *  compile-time string/template folding. Returns null when it isn't a pure-number
 *  constant — string `+` and dynamic parts fall through to the caller's runtime path. */
function constNum(node) {
  if (Array.isArray(node) && node[0] == null && typeof node[1] === 'number') return node[1]
  if (!Array.isArray(node)) return null
  const [op, a, b] = node
  if ((op === 'u-' || op === '-' || op === '+') && b === undefined) {
    const x = constNum(a)
    return x == null ? null : op === 'u-' || op === '-' ? -x : +x
  }
  const x = constNum(a), y = constNum(b)
  if (x == null || y == null) return null
  switch (op) {
    case '+': return x + y
    case '-': return x - y
    case '*': return x * y
    case '/': return y === 0 ? null : x / y
    case '%': return y === 0 ? null : x % y
    case '**': return x ** y
  }
  return null
}

function staticStringExpr(node) {
  const lit = stringValue(node)
  if (lit != null) return lit
  if (Array.isArray(node) && node[0] === 'str' && typeof node[1] === 'string') return node[1]
  if (typeof node === 'string') return lookupStaticString(node)
  if (!Array.isArray(node)) return null
  const [op, ...args] = node
  if (op === '+') {
    const a = staticStringExpr(args[0])
    const b = staticStringExpr(args[1])
    // Accumulate from a fresh empty string (`'' + a + b`) rather than concatenating two
    // source-derived substrings directly. Under self-host the latter can yield a string
    // backed by transient parse-time storage that's invalid by the time emit['//'] reads
    // it for regex compilation (OOB); forcing a fresh allocation, as the template-literal
    // path already does, keeps it stable. Identical value in both legs.
    return a != null && b != null ? '' + a + b : null
  }
  if (op === '`') {
    let out = ''
    for (const part of args) {
      let s = staticStringExpr(part)
      // A numeric interpolation (`${123}`, `${1+2}`) is a constant in string context —
      // ToString it so a fully-static template folds to one literal instead of a runtime
      // concat. (Only the template case stringifies numbers; `+` stays polymorphic.)
      if (s == null) { const n = constNum(part); if (n != null) s = String(n) }
      if (s == null) return null
      out += s
    }
    return out
  }
  if (op === '``' && Array.isArray(args[0]) && args[0][0] === '.' && args[0][1] === 'String' && args[0][2] === 'raw') {
    let out = ''
    for (const part of args.slice(1)) {
      const s = staticStringExpr(part)
      if (s == null) return null
      out += s
    }
    return out
  }
  if (op === '()' && Array.isArray(args[0]) && args[0][0] === '.' && args[0][2] === 'join' && typeof args[0][1] === 'string') {
    const arr = lookupStaticStringArray(args[0][1])
    if (!arr) return null
    const sep = args.length > 1 && args[1] != null ? staticStringExpr(args[1]) : ','
    return sep != null ? arr.join(sep) : null
  }
  return null
}

function importMetaUrl() {
  if (!ctx.transform.importMetaUrl) err('`import.meta.url` requires compile option `importMetaUrl`')
  return ctx.transform.importMetaUrl
}

function resolveImportMeta(spec) {
  const base = importMetaUrl()
  // URL resolution is a host capability (WHATWG URL parsing), injected via
  // ctx.transform.resolveUrl rather than referencing the `URL` global — the same
  // inversion as ctx.transform.parse. Keeps the self-host kernel (which bundles
  // its module graph and never resolves import.meta at runtime) free of `URL`.
  if (!ctx.transform.resolveUrl) err('import.meta resolution requires ctx.transform.resolveUrl (injected by the jz pipeline)')
  try { return ctx.transform.resolveUrl(spec, base) }
  catch { err(`Cannot resolve import.meta specifier '${spec}' from '${base}'`) }
}

function recordModuleInitFacts(root) {
  const facts = ctx.module.initFacts ||= {
    dynVars: new Set(), dynWriteVars: new Set(), anyDyn: false, hasSchemaLiterals: false,
    hasFuncValue: false, timerNames: new Set(),
    maxDef: 0, maxCall: 0, hasRest: false, hasSpread: false,
    writtenProps: new Set(),
  }
  const visitFuncValue = (node) => {
    if (facts.hasFuncValue || !Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '()') {
      for (let i = 1; i < args.length; i++) {
        const a = args[i]
        if (isFuncRef(a, ctx.func.names)) { facts.hasFuncValue = true; return }
        visitFuncValue(a)
      }
      return
    }
    if (op === '.' || op === '?.') {
      if (isFuncRef(args[0], ctx.func.names)) { facts.hasFuncValue = true; return }
      visitFuncValue(args[0])
      return
    }
    if (op === '=>') { visitFuncValue(args[1]); return }
    for (const a of args) {
      if (isFuncRef(a, ctx.func.names)) { facts.hasFuncValue = true; return }
      visitFuncValue(a)
    }
  }
  const walk = (node) => {
    if (!Array.isArray(node)) {
      if (typeof node === 'string' && TIMER_NAMES.has(node)) facts.timerNames.add(node)
      return
    }
    observeNodeFacts(node, facts)
    for (const a of node.slice(1)) walk(a)
  }
  visitFuncValue(root)
  walk(root)
}

/**
 * @typedef {null|number|string|ASTNode[]} ASTNode
 */

/**
 * Prepare AST node for compilation.
 * @param {ASTNode} node - Raw AST from parser
 * @returns {ASTNode} Normalized AST
 */
// ES2020 §13.13: the nullish-coalescing `??` cannot be combined with `||` or `&&`
// without parentheses — V8 raises a SyntaxError. subscript/jessie doesn't enforce
// it, so jz would otherwise silently accept (and pick its own parse for) the mix.
// Run on the RAW input AST: a parenthesized operand parses as `['()', …]`, so a
// bare `??`/`||`/`&&` child is exactly the illegal unparenthesized form — and at
// this stage no compiler-synthesized `??` (e.g. destructuring defaults) exists yet,
// so `let [a = b || c] = arr` can't false-positive.
function validateCoalesceMixing(n) {
  if (!Array.isArray(n)) return
  const op = n[0]
  if (op === '||' || op === '&&') {
    for (let i = 1; i < n.length; i++) if (Array.isArray(n[i]) && n[i][0] === '??')
      err(`'??' cannot be mixed with '${op}' without parentheses (ES2020) — wrap one side, e.g. (a ?? b) ${op} c`)
  } else if (op === '??') {
    for (let i = 1; i < n.length; i++) if (Array.isArray(n[i]) && (n[i][0] === '||' || n[i][0] === '&&'))
      err(`'??' cannot be mixed with '||' / '&&' without parentheses (ES2020) — wrap one side, e.g. a ?? (b || c)`)
  }
  for (let i = 1; i < n.length; i++) validateCoalesceMixing(n[i])
}

export default function prepare(node) {
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
    const funcNames = new Set(ctx.func.list.map(f => f.name))
    const visit = (n) => {
      if (!Array.isArray(n)) return false
      const [op, ...args] = n
      // Any inline arrow surviving prep is a closure value (defFunc-lifted ones
      // are extracted from the AST into ctx.func.list).
      if (op === '=>') return true
      if (op === '()') {
        // callee at args[0]: skip if it's a bare func name (direct call); recurse rest
        if (typeof args[0] !== 'string' || !funcNames.has(args[0])) {
          if (visit(args[0])) return true
        }
        for (let i = 1; i < args.length; i++) {
          const a = args[i]
          if (typeof a === 'string' && funcNames.has(a)) return true
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
        if (typeof a === 'string' && funcNames.has(a)) return true
        if (visit(a)) return true
      }
      return false
    }
    let needs = visit(ast)
    if (!needs) for (const f of ctx.func.list) if (f.body && visit(f.body)) { needs = true; break }
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
  const allNodes = [ast, ...ctx.func.list.map(f => f.body)]
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
    const scan = (n, inDecl) => {
      if (!Array.isArray(n)) return
      const [op, lhs] = n
      if (op === '=' && typeof lhs === 'string' && !inDecl) writes.add(lhs)
      if (op === '=' && Array.isArray(lhs) && lhs[0] === '[]' && typeof lhs[1] === 'string' && !inDecl) writes.add(lhs[1])
      // Compound assigns desugar to `=`; increments emit as `++`/`--` post-prep.
      if ((op === '++' || op === '--') && typeof lhs === 'string') writes.add(lhs)
      if ((op === '++' || op === '--') && Array.isArray(lhs) && lhs[0] === '[]' && typeof lhs[1] === 'string') writes.add(lhs[1])
      if (op === '()' && Array.isArray(lhs) && lhs[0] === '.' && typeof lhs[1] === 'string' && MUTATING_ARRAY_METHODS.has(lhs[2])) writes.add(lhs[1])
      const childInDecl = (op === 'let' || op === 'const' || op === 'var' || op === 'export')
      for (let i = 1; i < n.length; i++) scan(n[i], childInDecl)
    }
    scan(ast, false)
    for (const f of ctx.func.list) if (f.body) scan(f.body, false)
    for (const name of writes) {
      ctx.scope.shapeStrs?.delete(name)
      ctx.scope.shapeStrArrays?.delete(name)
    }
  }

  return ast
}

// Named constants → numeric literals. The JZ_NULL/JZ_UNDEF atom sentinels live
// in ast.js — shared with emit without crossing the prepare↔compile boundary.
// Prototype-less (Object.create(null)): a plain `{}` inherits Object.prototype in V8, so
// `'valueOf' in CONSTANTS` / `CONSTANTS['toString']` would hit an inherited method and
// mis-resolve a user identifier named like an Object method (jz.js-only — kernel objects
// are already prototype-less). Same reason on F64_CONSTANTS / GLOBALS / REJECT_IDENTS.
const CONSTANTS = Object.assign(Object.create(null), { 'true': true, 'false': false, 'null': JZ_NULL, 'undefined': JZ_UNDEF })
// NaN/Infinity stay as special f64 values in emit()
const F64_CONSTANTS = Object.assign(Object.create(null), { 'NaN': NaN, 'Infinity': Infinity })

/** Resolve variable name through block scope chain (innermost rename wins). */
function resolveScope(name) {
  for (let i = scopes.length - 1; i >= 0; i--)
    if (scopes[i].has(name)) return scopes[i].get(name)
  return name
}

/** Check if name is declared in any current scope level. */
function isDeclared(name) {
  return scopes.some(s => s.has(name))
}

function pushScope(scope = new Map()) {
  scopes.push(scope)
  staticConstScopes.push({ strings: new Map(), arrays: new Map() })
}

function popScope() {
  scopes.pop()
  staticConstScopes.pop()
}

function bindStaticConst(name, str, arr) {
  const frame = staticConstScopes.at(-1)
  if (!frame || typeof name !== 'string') return
  if (str != null) frame.strings.set(name, str)
  if (arr) frame.arrays.set(name, arr)
}

function bindStaticGlobal(name, str, arr) {
  if (typeof name !== 'string') return
  if (str != null) (ctx.scope.shapeStrs ||= new Map()).set(name, str)
  if (arr) (ctx.scope.shapeStrArrays ||= new Map()).set(name, arr)
}

function deleteStaticGlobal(name) {
  ctx.scope.shapeStrs?.delete(name)
  ctx.scope.shapeStrArrays?.delete(name)
}

// Schema id when prhs is a bare object literal with static keys, else null.
function objLiteralSid(prhs) {
  if (!Array.isArray(prhs) || prhs[0] !== '{}') return null
  const props = staticObjectProps(prhs.slice(1))
  return props ? ctx.schema.register(props.names) : null
}

// Shape-consensus accounting for every `name = …` assignment. `sid` is the
// RHS literal's schema id (null for any non-literal source). A name's schema
// binds only while ALL its assignments agree on that one literal shape: the
// first literal binds; any disagreeing assignment — non-literal RHS or a
// different-shape literal — unbinds and poisons. Poisoned names never rebind,
// so compile-time fixed-slot reads can't be aimed at one shape while the
// variable holds another (the misread class: `.x` returning a foreign
// object's slot-0 value). Compile consumes the END state — order-insensitive.
function bindAssignSchema(name, sid) {
  const had = ctx.schema.vars.get(name)
  if (had != null) {
    if (had !== sid) { ctx.schema.vars.delete(name); ctx.schema.poisoned?.add(name) }
  } else if (sid != null) {
    if (!ctx.schema.poisoned?.has(name)) ctx.schema.vars.set(name, sid)
  } else ctx.schema.poisoned?.add(name)
}

const hasFunc = name => ctx.func.names.has(name)
// A builtin name (`Map`, `Array`, `Math`, …) is shadowed when the user bound it
// as a local (let/const/param, via `isDeclared`), a top-level function (via
// `hasFunc`), or a top-level let/const global (via `userGlobals`). A shadowed
// name must resolve to the user binding, so the constructor / named-call
// fast-paths bail and fall through to `resolveCallee`, which already routes a
// declared name to its local value. Mirrors the guard in
// `foldNamespaceIntrospection`.
const shadowsBuiltin = name => typeof name === 'string' &&
  ((scopes.length && isDeclared(name)) || hasFunc(name) || ctx.scope.userGlobals?.has?.(name))
// A local bound to a function literal in any active arrow scope (the nested-
// closure counterpart to `hasFunc`, which only knows depth-0 lifted functions).
const isFuncValueLocal = name => typeof name === 'string' && funcValueNames.some(s => s.has(name))

const renameFunc = (func, nextName) => {
  ctx.func.names.delete(func.name)
  func.name = nextName
  ctx.func.names.add(nextName)
}

// `typeof`-string → code table lives in ast.js (TYPEOF) — shared with
// emitTypeofCmp and flow-types so the codes have one home.
// Spec §13.5.3: `typeof undeclared_x` returns 'undefined' without throwing.
// True iff `name` is a bare identifier with no resolution path. Mirrors the
// resolution chain inside `prep()` so we don't speculate emit-time failures.
function isUnresolvableBareIdent(name) {
  if (typeof name !== 'string') return false
  if (name in CONSTANTS || name in F64_CONSTANTS) return false
  if (name === 'Boolean' || name === 'Number') return false
  if (REJECT_IDENTS[name]) return false
  if (scopes.length && isDeclared(name)) return false
  if (ctx.scope.chain[name]) return false
  if (GLOBALS[name]) return false
  if (ctx.func.names.has(name)) return false
  if (ctx.func?.locals?.has?.(name)) return false
  // Top-level decls live in ctx.scope.globals / userGlobals (set by prepDecl at
  // depth 0). Current arrow's local names are tracked in funcLocalNames.
  if (ctx.scope.globals?.has?.(name)) return false
  if (ctx.scope.userGlobals?.has?.(name)) return false
  const fnNames = funcLocalNames[funcLocalNames.length - 1]
  if (fnNames?.has(name)) return false
  return true
}
// Constant fold typeof for known builtin namespaces (e.g. Math.exp). prep(x) resolves Math.exp → 'math.exp'.
function staticTypeofString(x) {
  // Spec §13.5.3: unresolvable bare ref → 'undefined'.
  if (isUnresolvableBareIdent(x)) return 'undefined'
  // Bare callable global: parseInt, parseFloat, isNaN, isFinite, Error, BigInt, etc.
  if (typeof x === 'string' && !ctx.func?.locals?.has(x) && GLOBALS[x] && emitArity(ctx.core.emit?.[x]) > 0) return 'function'
  const px = prep(x)
  if (typeof px === 'string' && px.includes('.') && emitArity(ctx.core.emit?.[px]) > 0) return 'function'
  return null
}
// Builtin-namespace constructors expose `prototype`/`length`/`name` as own
// properties; plain namespaces (Math, JSON, Reflect, Atomics) do not.
const NS_CTORS = new Set(['Number', 'String', 'Boolean', 'BigInt', 'Object',
  'Array', 'Symbol', 'Error', 'Date', 'RegExp', 'Function', 'Map', 'Set',
  'Promise', 'ArrayBuffer', 'DataView', 'WeakMap', 'WeakSet'])
// `NS.hasOwnProperty("member")` is a compile-time question: jz models a
// builtin namespace as a set of emit keys, so a member is owned iff jz emits
// it — plus the universal constructor trio for constructor namespaces.
function namespaceHasOwn(mod, name, member) {
  if (ctx.core.emit[`${mod}.${member}`] != null) return true
  return NS_CTORS.has(name) && (member === 'prototype' || member === 'length' || member === 'name')
}
function resolveTypeof(node) {
  const [op, a, b] = node
  // `typeof` always yields a string, so `==`/`===` (and `!=`/`!==`) are
  // equivalent here — both collapse to the same type check.
  const eqLike = op === '==' || op === '==='
  // typeof x == 'string' → type check
  if (Array.isArray(a) && a[0] === 'typeof' && Array.isArray(b) && b[0] == null && typeof b[1] === 'string') {
    const known = staticTypeofString(a[1])
    if (known != null) return [, eqLike ? known === b[1] : known !== b[1]]
    const code = TYPEOF[b[1]]
    if (code != null) return [op, ['typeof', a[1]], [, code]]
  }
  // 'string' == typeof x
  if (Array.isArray(b) && b[0] === 'typeof' && Array.isArray(a) && a[0] == null && typeof a[1] === 'string') {
    const known = staticTypeofString(b[1])
    if (known != null) return [, eqLike ? known === a[1] : known !== a[1]]
    const code = TYPEOF[a[1]]
    if (code != null) return [op, ['typeof', b[1]], [, code]]
  }
  return node
}

// Prepare a strict `===`/`!==`. resolveTypeof may fold `typeof x === 'type'` to a
// literal or rewrite it to a numeric-code compare; either way we prep the result's
// operands directly. The strict op stays intact (no collapse to loose `==`) so
// emit can apply the no-coercion type-mismatch fold.
function prepStrictEq(op, a, b) {
  const r = resolveTypeof([op, a, b])
  if (r[0] !== op) return prep(r)            // folded to a literal — re-prep is safe
  return [op, prep(r[1]), prep(r[2])]        // keep strict op; prep operands only
}

const cloneNode = (node) => {
  if (!Array.isArray(node)) return node
  const copy = node.map(cloneNode)
  if (node.loc != null) copy.loc = node.loc
  return copy
}

/** True if `node` contains a `break`/`continue` that belongs to it — i.e. not
 *  one nested inside its own function. (Nested loops are intentionally counted:
 *  an over-detection only opts into the safe frame-carrying lowering below.) */
const hasLoopJump = (node) => {
  if (!Array.isArray(node)) return false
  const op = node[0]
  if (op === 'break' || op === 'continue') return true
  if (op === '=>' || op === 'function') return false
  return node.some(hasLoopJump)
}

/** Retarget a for-in iteration's *own* unlabeled `break`/`continue` to explicit
 *  block labels — `break` to the construct-wide label, `continue` to this
 *  iteration's label. Nested loops/functions own their jumps and are skipped;
 *  labeled jumps already name their target and are left untouched. */
const retargetLoopJumps = (node, brkLabel, contLabel) => {
  if (!Array.isArray(node)) return node
  const op = node[0]
  if (op === 'break' && node.length === 1) return ['break', brkLabel]
  if (op === 'continue' && node.length === 1) return ['break', contLabel]
  if (op === 'for' || op === 'for-in' || op === 'while' || op === 'do'
      || op === '=>' || op === 'function') return node
  return node.map(c => retargetLoopJumps(c, brkLabel, contLabel))
}

function prep(node) {
  if (Array.isArray(node)) includeForOp(node[0])
  if (Array.isArray(node) && node.loc != null) ctx.error.loc = node.loc
  if (node == null) return [, 0] // null/undefined → 0 literal
  // Keep boolean identity (was folded to 1/0). The working representation is
  // still i32/f64 0/1 — emit lowers the raw boolean — but valTypeOf now reads
  // VAL.BOOL off the literal, so typeof/String/JSON/host boundary stay faithful.
  if (node === true) return [, true]
  if (node === false) return [, false]
  if (!Array.isArray(node)) {
    if (typeof node === 'string') {
      if (node in CONSTANTS) return [, CONSTANTS[node]]
      if (node in F64_CONSTANTS) return [, F64_CONSTANTS[node]]
      if (REJECT_IDENTS[node]) err(REJECT_IDENTS[node])
      // Boolean/Number as value → identity arrow (for .filter(Boolean), .map(Number) etc.)
      if (node === 'Boolean' || node === 'Number') { includeForCallableValue(); return ['=>', 'x', 'x'] }
      // Block locals shadow module imports/globals, even when the local keeps the same name.
      if (scopes.length && isDeclared(node)) return resolveScope(node)
      // A user top-level binding (`let Math = …`) shadows a same-named builtin
      // namespace seeded into the scope chain (`Math → math`). Resolve to the
      // user global, not the builtin. (Mangled globals drop their original name
      // from userGlobals, so this fires only for un-renamed user bindings.)
      if (ctx.scope.userGlobals?.has?.(node)) return node
      // Host numeric constant (`Math.PI` etc.) → fold to its f64 literal. Placed after the
      // local/user-global checks above so a same-named binding still shadows it.
      if (ctx.scope.hostConsts && node in ctx.scope.hostConsts) return [, ctx.scope.hostConsts[node]]
      const resolved = ctx.scope.chain[node]
      if (resolved?.includes('.')) return resolved
      // Cross-module import: mangled name (e.g. __util_js$clone)
      if (resolved && resolved !== node) return resolved
      // Block scope: resolve renames
      if (scopes.length) return resolveScope(node)
    }
    return node
  }

  const [op, ...args] = node
  if (op === 'void' && ctx.transform.strict) err('strict mode: `void` is prohibited. It diverges from JS by evaluating to 0.')
  // jz's `==`/`!=` already never coerce (identical to `===`/`!==`), so default mode accepts them.
  // strict enforces the canonical subset, where `===`/`!==` are the one spelling — reject the loose form.
  if ((op === '==' || op === '!=') && ctx.transform.strict)
    err(`strict mode: \`${op}\` is prohibited — use \`${op}=\`. (jz's \`${op}\` doesn't coerce, but the canonical subset is \`===\`/\`!==\` only.)`)
  if (op == null) {
    if (typeof args[0] === 'string') {
      includeForStringValue()
      return ['str', args[0]]  // string literal
    }
    return [, args[0]]  // number literal
  }
  const handler = handlers[op]
  return handler ? handler(...args) : [op, ...args.map(prep)]
}

// Identifier prohibitions: op-policy.js REJECT_IDENTS (prep string nodes).

// Predefined globals seeded into scope.chain at ctx.reset().
// used in ctx.core.emit[]. Dotted lookups (Math.sin) go through the '.' handler which
// resolves via scope.chain → module 'math' → registers 'math.sin' emitter.
// Not actually "implicit imports" — these are ambient globals that exist in every jz/JS
// program (they do not live in any module). jzify auto-injecting imports would still
// need a list of these names to know what to emit, so the table lives here either way.
export const GLOBALS = Object.assign(Object.create(null), {
  Math: 'math',
  Number: 'Number',
  Array: 'Array',
  Object: 'Object',
  Symbol: 'Symbol',
  JSON: 'JSON',
  Date: 'Date',
  isNaN: 'number',
  isFinite: 'number',
  parseInt: 'number',
  parseFloat: 'number',
  encodeURIComponent: 'encodeURIComponent',
  decodeURIComponent: 'decodeURIComponent',
  Error: 'Error',
  // Error subclasses: distinct names in JS, but jz doesn't carry typed error
  // info — `throw` accepts any value and stringification goes through the
  // host. Treat them all as Error-shaped passthrough constructors so user
  // code that throws specific subclasses (`throw new SyntaxError(msg)`) compiles
  // identically. If we ever model `instanceof SyntaxError`, this is where to
  // distinguish them; until then the surfaced message is what matters.
  TypeError: 'Error',
  SyntaxError: 'Error',
  RangeError: 'Error',
  ReferenceError: 'Error',
  URIError: 'Error',
  EvalError: 'Error',
  BigInt: 'BigInt',
  TextEncoder: 'TextEncoder',
  TextDecoder: 'TextDecoder',
})

const patternItems = (node) => node?.[0] === ',' ? node.slice(1) : [node]
const isDestructPattern = (node) => Array.isArray(node) && (node[0] === '[]' || node[0] === '{}')

// Element count of a prepared inline array literal `['[', e0, e1, …]` with no
// spread (spread → dynamic length). Returns null when not such a literal, so
// destructuring a non-literal source keeps its runtime element reads.
const inlineArrayLen = (e) =>
  Array.isArray(e) && e[0] === '[' && !e.slice(1).some(x => Array.isArray(x) && x[0] === '...')
    ? e.length - 1 : null

const simpleArrayPatternItems = (pattern) => {
  if (!Array.isArray(pattern) || pattern[0] !== '[]' || pattern.length !== 2) return null
  const items = patternItems(pattern[1])
  return items.every(item => typeof item === 'string') ? items : null
}

const arrayLiteralItems = (expr) => {
  if (!Array.isArray(expr) || expr[0] !== '[]' || expr.length !== 2) return null
  if (expr[1] == null) return []
  const items = patternItems(expr[1])
  return items.every(item => item != null && !(Array.isArray(item) && item[0] === '...')) ? items : null
}

function scalarArrayDestruct(pattern, rhs) {
  const targets = simpleArrayPatternItems(pattern)
  const values = arrayLiteralItems(rhs)
  if (!targets || !values || targets.length !== values.length) return null

  const decls = []
  const assigns = []
  for (let i = 0; i < targets.length; i++) {
    const tmp = `${T}d${ctx.func.uniq++}`
    decls.push(['=', tmp, prep(values[i])])
    assigns.push(['=', targets[i], tmp])
  }
  return prep([';', ['let', ...decls], ...assigns])
}

function declareGlobal(name, user = true) {
  if (depth !== 0 || typeof name !== 'string') return name
  if (ctx.scope.globals.has(name)) err(`'${name}' conflicts with a compiler internal — choose a different name`)
  declGlobal(name, 'f64')
  if (user) ctx.scope.userGlobals.add(name)
  return name
}

function bindingNames(pattern, out = new Set()) {
  if (typeof pattern === 'string') out.add(pattern)
  else if (Array.isArray(pattern)) {
    if (pattern[0] === '...' && typeof pattern[1] === 'string') out.add(pattern[1])
    else if (pattern[0] === '=') bindingNames(pattern[1], out)
    else if (pattern[0] === ':') bindingNames(pattern[2], out)
    else if (pattern[0] === '[]' || pattern[0] === '{}' || pattern[0] === ',') {
      for (const item of pattern.slice(1)) bindingNames(item, out)
    }
  }
  return out
}

function pushPatternAssign(target, valueExpr, out, decls = null) {
  if (Array.isArray(target) && target[0] === '=') {
    pushPatternAssign(target[1], ['??', valueExpr, prep(target[2])], out, decls)
    return
  }

  if (isDestructPattern(target)) {
    const tmp = `${T}d${ctx.func.uniq++}`
    if (decls) decls.push(['=', tmp, valueExpr])
    else out.push(['=', tmp, valueExpr])
    expandDestruct(target, tmp, out, decls)
    return
  }

  out.push(['=', target, valueExpr])
}

function expandDestruct(pattern, source, out, decls = null, srcLen = null) {
  if (!isDestructPattern(pattern)) return

  if (pattern[0] === '[]') {
    includeForArrayPattern()
    const items = patternItems(pattern[1])
    for (let j = 0; j < items.length; j++) {
      const item = items[j]
      if (item == null) continue

      if (Array.isArray(item) && item[0] === '...') {
        pushPatternAssign(item[1], ['()', ['.', source, 'slice'], [, j]], out, decls)
        continue
      }

      // Source is a known-length inline literal and this index is past its end →
      // the element is statically `undefined` (so any `= default` applies). Folding
      // it here skips a provably out-of-range read — which both avoids the runtime
      // access and dodges an optimizer miscompile of the destructuring-temp shape.
      if (srcLen != null && j >= srcLen) {
        pushPatternAssign(item, [, JZ_UNDEF], out, decls)
        continue
      }

      pushPatternAssign(item, ['[]', source, [, j]], out, decls)
    }
    return
  }

  includeForObjectPattern()
  const items = patternItems(pattern[1])

  // Collect explicit keys and detect rest pattern
  let restTarget = null
  const explicitKeys = []
  for (const item of items) {
    if (item == null) continue
    if (Array.isArray(item) && item[0] === '...') { restTarget = item[1]; continue }
    if (typeof item === 'string') explicitKeys.push(item)
    else if (Array.isArray(item) && item[0] === '=') { if (typeof item[1] === 'string') explicitKeys.push(item[1]) }
    else if (Array.isArray(item) && item[0] === ':') explicitKeys.push(item[1])
  }

  for (const item of items) {
    if (item == null) continue
    if (Array.isArray(item) && item[0] === '...') continue  // handled below

    if (typeof item === 'string') {
      pushPatternAssign(item, ['.', source, item], out, decls)
      continue
    }

    if (Array.isArray(item) && item[0] === '=') {
      if (typeof item[1] === 'string')
        pushPatternAssign(item[1], ['??', ['.', source, item[1]], prep(item[2])], out, decls)
      continue
    }

    if (Array.isArray(item) && item[0] === ':') {
      const key = item[1]
      const computedKey = Array.isArray(key) && key[0] === '[]' && key.length === 2 ? key[1] : null
      if (computedKey) includeForArrayAccess()
      pushPatternAssign(item[2], computedKey ? ['[]', source, computedKey] : ['.', source, key], out, decls)
      continue
    }
  }

  // Object rest: {x, ...rest} = obj → rest = {remaining props from source schema}
  if (restTarget) {
    const srcSchema = typeof source === 'string' && ctx.schema.resolve(source)
    if (srcSchema) {
      const remaining = srcSchema.filter(k => !explicitKeys.includes(k))
      if (remaining.length) {
        const restProps = remaining.map(k => [':', k, ['.', source, k]])
        const restObj = ['{}', remaining.length === 1 ? restProps[0] : [',', ...restProps]]
        // Register schema for the rest variable so property access works
        if (typeof restTarget === 'string') ctx.schema.vars.set(restTarget, ctx.schema.register(remaining))
        pushPatternAssign(restTarget, restObj, out, decls)
      } else {
        pushPatternAssign(restTarget, ['{}'], out, decls)
      }
    } else {
      err('Object rest (...) requires source with known schema — destructure the object before passing to function, or use explicit property access')
    }
  }
}

/** Prepare let/const declaration. */
function prepDecl(op, ...inits) {
  const rest = []
  for (const i of inits) {
    if (Array.isArray(i) && i[0] === '()' && typeof i[1] === 'string' && Array.isArray(i[2]) && i[2][0] === '=' && isDestructPattern(i[2][1])) {
      if (rest.length === 0 && inits.length === 1) return [';', [op, i[1]], prep(i[2])]
      err('destructuring assignment after declaration must be a separate statement')
    }

    if (!Array.isArray(i) || i[0] !== '=') {
      let declName = i
      if (depth === 0 && typeof declName === 'string') {
        if (ctx.module.currentPrefix) {
          declName = `${ctx.module.currentPrefix}$${declName}`
          ctx.scope.chain[i] = declName
        }
        if (ctx.scope.globals.has(declName)) err(`'${declName}' conflicts with a compiler internal — choose a different name`)
        declGlobal(declName, 'f64')
        ctx.scope.userGlobals.add(declName)
      } else if (typeof declName === 'string') {
        // Bare hoisted decl inside a function (var X jzified to `let X` at top
        // of arrow + a later `X = …` assignment). Without registering here, the
        // name is invisible to scope predicates like `isUnresolvableBareIdent`
        // until the assignment runs — which is after any reference to it.
        const fnNames = funcLocalNames[funcLocalNames.length - 1]
        if (fnNames) fnNames.add(declName)
        if (scopes.length > 0) scopes[scopes.length - 1].set(declName, declName)
      }
      rest.push(declName)
      continue
    }
    const [, name, init] = i
    // `const alias = fn` whose RHS is a bare identifier naming a known function
    // is a compile-time function alias — the ES `export { fn as alias }` written
    // in declaration form (a recurring kernel idiom: paramList = extractParams,
    // toBoolFromEmitted = truthyIR …). Resolve `alias` straight to the function
    // so calls compile to a direct call and the export table re-exports the same
    // mangled func. Otherwise it would box a closure into a module global that a
    // cross-module callee resolves to the bare, unmangled name → "not in scope".
    // Module scope + `const` only: depth>0 aliases already work as closure values,
    // and a reassignable `let` is a genuine value binding, not an alias.
    if (op === 'const' && depth === 0 && typeof name === 'string' && typeof init === 'string') {
      const fn = hasFunc(init) ? init : (hasFunc(ctx.scope.chain[init]) ? ctx.scope.chain[init] : null)
      if (fn) {
        ctx.scope.chain[name] = fn
        if (name in ctx.func.exports) ctx.func.exports[name] = fn
        continue
      }
    }
    const staticStr = op === 'const' ? staticStringExpr(init) : null
    const staticArr = op === 'const' ? staticStringArrayValues(init) : null
    const normed = prep(init)

    if (isDestructPattern(name)) {
      // Register each binding both as a module global (depth 0) and in the
      // current arrow's local scope (depth ≠ 0). Without the local registration
      // the name is invisible to `isUnresolvableBareIdent`, so a later
      // `typeof x` would mis-fold to 'undefined' (spec §13.5.3) before emit ever
      // sees the binding — see the bare-hoisted-decl branch above for the same fix.
      const fnNames = funcLocalNames[funcLocalNames.length - 1]
      for (const n of bindingNames(name)) {
        declareGlobal(n)
        if (depth !== 0 && typeof n === 'string') {
          if (fnNames) fnNames.add(n)
          if (scopes.length > 0) scopes[scopes.length - 1].set(n, n)
        }
      }
      // A bare-identifier source needs no temp: reads are idempotent and
      // side-effect-free, so we destructure straight off it. This keeps each
      // element's static type tag (e.g. `let [, x] = strs` resolves `x` to the
      // same STRING that `strs[1]` would) — a copy temp drops the array's
      // element-type shape and `typeof x` would degrade to 'undefined'.
      if (typeof normed === 'string') {
        expandDestruct(name, normed, rest)
        continue
      }
      const tmp = `${T}d${ctx.func.uniq++}`
      declareGlobal(tmp, false)
      rest.push(['=', tmp, normed])
      // Propagate schema to temp so rest destructuring can resolve it
      if (Array.isArray(normed) && normed[0] === '{}') {
        const p = normed.slice(1).filter(p => Array.isArray(p) && p[0] === ':').map(p => p[1])
        if (p.length) ctx.schema.vars.set(tmp, ctx.schema.register(p))
      }
      expandDestruct(name, tmp, rest, null, inlineArrayLen(normed))
      continue
    }

    if (!defFunc(name, normed)) {
      let declName = name
      // Block scope: rename if shadowing an outer declaration, OR if a sibling
      // block at the same arrow scope already declared this name (sibling
      // blocks both lower to the same WASM local; see funcLocalNames comment).
      const fnNames = funcLocalNames[funcLocalNames.length - 1]
      const inCurrentBlock = scopes.length > 0 && scopes[scopes.length - 1].has(name)
      if (typeof name === 'string' && scopes.length > 0 && (isDeclared(name) || (fnNames?.has(name) && !inCurrentBlock))) {
        declName = `${name}${T}${ctx.func.uniq++}`
        scopes[scopes.length - 1].set(name, declName)
      } else if (typeof name === 'string' && scopes.length > 0) {
        scopes[scopes.length - 1].set(name, name)
      }
      if (typeof declName === 'string' && fnNames) fnNames.add(declName)
      // A nested arrow stays a closure value (defFunc only lifts depth-0). Record
      // the binding so `.caller`/`.callee` on it reads as prohibited introspection.
      if (typeof declName === 'string' && Array.isArray(normed) && normed[0] === '=>')
        funcValueNames[funcValueNames.length - 1]?.add(declName)
      if (op === 'const') bindStaticConst(declName, staticStr, staticArr)
      // Track const for reassignment checks — only module-scope consts (depth 0)
      if (typeof declName === 'string' && depth === 0) {
        if (ctx.module.currentPrefix) {
          declName = `${ctx.module.currentPrefix}$${declName}`
          ctx.scope.chain[name] = declName
        }
        if (op === 'const') bindStaticGlobal(declName, staticStr, staticArr)
        if (op === 'const') {
          if (!ctx.scope.consts) ctx.scope.consts = new Set()
          ctx.scope.consts.add(declName)
          if (staticStr != null) (ctx.scope.constStrs ||= new Map()).set(declName, staticStr)
          const strs = staticArr || stringArrayValues(normed)
          if (strs) (ctx.scope.shapeStrArrays ||= new Map()).set(declName, strs)
        } else if (op === 'let' && ctx.scope.consts?.has(declName)) {
          ctx.scope.consts.delete(declName)
          ctx.scope.constStrs?.delete(declName)
          ctx.scope.shapeStrArrays?.delete(declName)
        }
        // Effectively-const string literals: shape inference for `let SRC = '{...}'`
        // patterns (bench convention to defeat compile-time JSON.parse fold without
        // losing schema knowledge). Recorded on init; post-prep scan removes any
        // entry whose name is later assigned to.
        if (Array.isArray(normed) && normed[0] === 'str' && typeof normed[1] === 'string')
          (ctx.scope.shapeStrs ||= new Map()).set(declName, normed[1])
        recordGlobalRep(declName, normed)
      }
      // Track object schemas (after prefix so schema is keyed to final name)
      if (typeof declName === 'string' && Array.isArray(normed) && normed[0] === '{}' && normed.length > 1) {
        const props = []
        const addProp = n => { if (!props.includes(n)) props.push(n) }
        let allKnown = true
        for (const p of normed.slice(1)) {
          // Dedupe every key (explicit AND spread-sourced) so a `k: v` that overrides
          // a spread-provided key doesn't push a duplicate — that would shift the
          // indices of later keys past emitObjectSpread's deduped slot assignment
          // (its `addName` dedupes both), making `decl.laterKey` read the wrong slot.
          if (Array.isArray(p) && p[0] === ':') addProp(p[1])
          else if (Array.isArray(p) && p[0] === '...') {
            const srcSchema = typeof p[1] === 'string' && ctx.schema.resolve(p[1])
            if (srcSchema) for (const n of srcSchema) addProp(n)
            else allKnown = false
          }
        }
        // An unknown spread source makes the value a runtime HASH (see
        // emitObjectSpread). Binding a static schema would compile `decl.prop`
        // to a fixed slot load that misreads the hash, so leave reads dynamic.
        if (allKnown && props.length && ctx.schema.register) ctx.schema.vars.set(declName, ctx.schema.register(props))
      }
      // Module-scope variable → WASM global (mark as user-declared)
      if (depth === 0 && typeof declName === 'string') {
        if (ctx.scope.globals.has(declName)) err(`'${declName}' conflicts with a compiler internal — choose a different name`)
        declGlobal(declName, 'f64')
        ctx.scope.userGlobals.add(declName)
      }
      rest.push(['=', declName, normed])
    }
  }
  return rest.length ? [op, ...rest] : null
}

// --- `'()'` call-handler helpers --------------------------------------------
// The call handler is a thin dispatcher: it tries the compile-time folds
// below (each gated by callee shape, so at most one fires), then resolves the
// callee, then assembles the call. Each helper moves one concern out of line.

// `import.meta.resolve("spec")` → the resolved URL as a static string.
function foldImportMetaResolve(callee, args) {
  if (!isImportMetaProp(callee, 'resolve')) return undefined
  const callArgs = handlerArgs(args)
  if (callArgs.length !== 1) err('`import.meta.resolve` requires one string literal argument')
  const spec = stringValue(callArgs[0])
  if (spec == null) err('`import.meta.resolve` supports only string literal arguments')
  return staticString(resolveImportMeta(spec))
}

// String-callee constructor / named-builtin folds: `Array(n)` and the `CTORS`
// set redirect to the `new` handler; `BigInt64Array`/`BigUint64Array` build a
// direct module call. `includeForNamedCall` is probed for every string callee
// — that probe is also how a module-backed builtin gets its modules included.
// Returns the replacement IR, or `undefined` for an ordinary call.
function dispatchConstructorCall(callee, args) {
  if (typeof callee !== 'string') return undefined
  // A user binding named like a constructor (`let Map = …`, `let Array = …`)
  // shadows the builtin — don't lower `Map(x)` to `new.Map`.
  if (shadowsBuiltin(callee)) return undefined
  if (callee === 'Array') {
    const callArgs = handlerArgs(args)
    if (callArgs.length === 1) return handlers['new'](['()', callee, callArgs[0]])
  }
  if (CTORS.includes(callee)) return handlers['new'](['()', callee, ...args])
  if (includeForNamedCall(callee) && (callee === 'BigInt64Array' || callee === 'BigUint64Array'))
    return ['()', callee, ...args.filter(a => a != null).map(prep)]
  return undefined
}

// Compile-time namespace introspection on a `obj.prop(...)` callee:
// `Array.isArray(NS)` on a bare builtin global folds to `false` (a namespace
// value is never an array); `NS.hasOwnProperty("member")` on a builtin
// namespace folds to a literal — no runtime namespace object. Returns the
// folded literal IR, or `undefined` when nothing folds.
function foldNamespaceIntrospection(callee, args) {
  if (!Array.isArray(callee) || callee[0] !== '.') return undefined
  const [, obj, prop] = callee
  if (obj === 'Array' && prop === 'isArray') {
    const cargs = handlerArgs(args)
    const a0 = cargs.length === 1 ? cargs[0] : null
    if (typeof a0 === 'string' && GLOBALS[a0] && !(scopes.length && isDeclared(a0)) && !hasFunc(a0))
      return [, 0]
  }
  if (prop === 'hasOwnProperty' && typeof obj === 'string' && !(scopes.length && isDeclared(obj))) {
    const mod = ctx.scope.chain[obj]
    if (mod && !mod.includes('.') && hasModule(mod)) {
      const cargs = handlerArgs(args)
      const member = cargs.length === 1 ? stringValue(cargs[0]) : null
      // Include the module so its emit keys (the namespace's member set) are
      // registered; unreferenced emitters/data dead-strip in compile.
      if (member != null) { includeModule(mod); return [, namespaceHasOwn(mod, obj, member) ? 1 : 0] }
    }
  }
  return undefined
}

// Resolve a callee to its lowered form, triggering module autoloads along the
// way: a bare identifier through the scope chain, an `obj.prop` member call
// through host imports / named-call / generic-method / namespace tables, and
// any other expression through `prep` (a callable runtime value).
// Compiler-internal synthetic callees: emit-handled intrinsics, never user
// function values — so a bare reference must not pull in the callable-value
// (function table / closure) machinery.
const INTRINSIC_CALLEES = new Set(['__iter_arr', '__keys_ro'])

function resolveCallee(callee, args) {
  if (typeof callee === 'string') {
    const local = scopes.length && isDeclared(callee)
    const resolved = local ? null : ctx.scope.chain[callee]
    if (local) return resolveScope(callee)
    if (resolved?.includes('.')) return resolved
    if (resolved && hasFunc(resolved)) return resolved
    if (resolved && !resolved.includes('.')) {
      if (hasModule(resolved) && !ctx.module.imports.some(i => i[3]?.[1] === `$${resolved}`)) includeModule(resolved)
      return callee
    }
    if (depth > 0 && !resolved && !INTRINSIC_CALLEES.has(callee) && !ctx.func.exports[callee] && !ctx.module.imports.some(i => i[3]?.[1] === `$${callee}`))
      includeForCallableValue()
    return callee
  }
  if (Array.isArray(callee) && callee[0] === '.') {
    const [, obj, prop] = callee
    // A user binding named like a builtin namespace (`let Math = {…}`) shadows
    // it — resolve `Math.max(…)` as a method call on the local value, not the
    // builtin named-call. (Property reads route through the `.` handler's own
    // shadow check.)
    if (shadowsBuiltin(obj)) return prep(callee)
    // SIMD intrinsic namespaces resolve members directly to their emit key, ahead of
    // generic-method dispatch — they're pure namespaces (never runtime values), and
    // names like `f32x4.add` must not be mistaken for the generic `.add` (Set/Map).
    if (typeof obj === 'string' && typeof prop === 'string' && SIMD_NS.has(obj) && !(scopes.length && isDeclared(obj)) && !ctx.scope.userGlobals?.has?.(obj)) {
      includeModule(obj); return `${obj}.${prop}`
    }
    const key = typeof obj === 'string' && typeof prop === 'string' ? `${obj}.${prop}` : null
    if (key && ctx.module.hostImports?.[obj]?.[prop]) {
      const spec = ctx.module.hostImports[obj][prop]
      const alias = `${obj}$${prop}`
      addHostImport(obj, prop, alias, spec)
      return alias
    }
    if (key && includeForNamedCall(key)) return key
    if (includeForGenericMethod(prop)) return prep(callee)
    const mod = ctx.scope.chain[obj]
    if (typeof obj === 'string' && mod && !mod.includes('.') && hasModule(mod))
      return (includeModule(mod), mod + '.' + prop)
    return prep(callee)
  }
  includeForCallableValue()
  return prep(callee)
}

// A lone parenthesized comma-expression argument — `f((a, b, c))` — is ONE
// argument whose value is the last comma operand. The parser keeps it wrapped
// (`['()', [',', …]]`); prep would strip the grouping, leaving a bare comma
// that emit can no longer tell apart from an arg list and splats into N args.
// With ≥2 args an outer arg-list comma already nests it — only the sole-arg
// case loses the distinction. Re-nest it under a 1-element arg-list comma.
function renestSoleCommaArg(args) {
  if (args.length === 1 && Array.isArray(args[0]) && args[0][0] === '()' && args[0].length === 2) {
    const ungroup = n => Array.isArray(n) && n[0] === '()' && n.length === 2 ? ungroup(n[1]) : n
    const core = ungroup(args[0])
    if (Array.isArray(core) && core[0] === ',') return [[',', args[0]]]
  }
  return args
}

const handlers = {
  ...rejectHandlers(err),
  // Spread operator: [...expr] in arrays, f(...args) in calls, {...obj} in objects
  '...'(expr) {
    includeForArrayLiteral()
    return ['...', prep(expr)]
  },

  'debugger': () => null,
  // Static-key delete (.x, ["x"], [literal]) would change the fixed schema → reject.
  // Computed-key delete (obj[expr]) — including jessie's `delete ctx[k]` — lowers
  // to runtime __dyn_del against the per-object shadow property store.
  'delete'(target) {
    const t = prep(target)
    if (Array.isArray(t) && t[0] === '[]' && t.length === 3) {
      const key = t[2]
      const isLiteralKey = Array.isArray(key) && key[0] == null && key.length === 2
      if (!isLiteralKey) return ['delete', t[1], key]
    }
    err('delete not supported: object shape is fixed')
  },
  'in'(key, obj) { return ['in', prep(key), prep(obj)] },
  'label'(name, body) { return ['label', name, prep(body)] },

  // Destructuring assignment: [a, ...b] = expr or {x, y} = expr
  '='(lhs, rhs) {
    // Destructuring assignment: [a, ...r] = expr or ({x: a} = expr)
    // Distinguishing from index assignment: destructuring patterns have exactly one payload node.
    if (isDestructPattern(lhs) && lhs.length === 2) {
      const scalar = scalarArrayDestruct(lhs, rhs)
      if (scalar) return scalar

      const normed = prep(rhs)
      const tmp = `${T}d${ctx.func.uniq++}`
      const decls = [['=', tmp, normed]]
      // Propagate schema to temp so rest destructuring can resolve it
      if (typeof normed === 'string' && ctx.schema.vars.has(normed))
        ctx.schema.vars.set(tmp, ctx.schema.vars.get(normed))
      const stmts = []
      expandDestruct(lhs, tmp, stmts, decls)
      return prep([';', ['let', ...decls], ...stmts])
    }
    // Function property assignment: fn.prop = arrow → extract as top-level function fn$prop.
    // A property can be reassigned — esbuild/jessie wrapper-composition does
    // `p.s = ...; var old = p.s; p.s = () => old()...`. Each assignment extracts
    // its own top-level function; the property holds whichever was assigned last,
    // and an earlier snapshot keeps pointing at the prior one. Collide → fresh name.
    // The base resolves through the scope chain first so an *imported* function
    // (mangled to `_mod$fn`) is recognised the same as a local one — the
    // subscript parser's plugin model mutates `parse.step` etc. across modules,
    // and a reassignment in module B must mark module A's call sites mutable.
    if (depth === 0 && Array.isArray(lhs) && lhs[0] === '.' && typeof lhs[1] === 'string'
      && Array.isArray(rhs) && rhs[0] === '=>') {
      const fnBase = ctx.scope.chain[lhs[1]] || lhs[1]
      if (hasFunc(fnBase)) {
        let name = `${fnBase}$${lhs[2]}`
        // Reassignment → the property is mutable; record it so `fn.prop()` calls
        // emit a dynamic property read + indirect call instead of a direct call.
        if (ctx.func.names.has(name)) {
          ctx.func.multiProp.add(`${fnBase}.${lhs[2]}`)
          do { name = `${fnBase}$${lhs[2]}$${ctx.func.uniq++}` } while (ctx.func.names.has(name))
        }
        // Build the target `.` node directly from the resolved base — re-`prep`ing
        // the lhs would resolve a multiProp `fn.prop` to an rvalue (closure
        // materialization block), which is not a valid assignment target.
        if (defFunc(name, prep(rhs))) return ['=', ['.', fnBase, lhs[2]], name]
      }
    }
    const staticStr = staticStringExpr(rhs)
    const staticArr = staticStringArrayValues(rhs)
    const plhs = prep(lhs)
    const prhs = prep(rhs)
    if (depth === 0 && typeof plhs === 'string' && ctx.scope.globals.has(plhs)) {
      // First assignment fixes the global's representation + object schema.
      if (!ctx.scope.globalReps?.has(plhs)) {
        recordGlobalRep(plhs, prhs)
        if (Array.isArray(prhs) && prhs[0] === '{}') {
          const props = staticObjectProps(prhs.slice(1))
          if (props) bindAssignSchema(plhs, ctx.schema.register(props.names))
        } else bindAssignSchema(plhs, null)
      } else bindAssignSchema(plhs, objLiteralSid(prhs))
      // Static string/array facts hold only while every assignment is constant.
      if (!assignedStaticGlobals.has(plhs) && (staticStr != null || staticArr)) bindStaticGlobal(plhs, staticStr, staticArr)
      else deleteStaticGlobal(plhs)
      assignedStaticGlobals.add(plhs)
    }
    // Object-literal assignment to a variable — e.g. a `var` that jzify hoisted
    // into `let x; x = {…}`. Recording the schema lets the binding behave like
    // `let x = {…}`: fixed-slot field access and for-in unroll. SOUNDNESS: the
    // shape holds only while EVERY assignment to the name agrees — one literal
    // shape, no other sources. Any disagreeing assignment (non-literal RHS such
    // as a table/Map lookup, or a different-shape literal) unbinds and poisons
    // the name; fixed-slot reads against one literal's layout would misread the
    // other sources' objects (e.g. `.x` returning another shape's slot-0 value).
    // Compile reads the END state, so the conflict check is order-insensitive.
    else if (typeof plhs === 'string') {
      bindAssignSchema(plhs, objLiteralSid(prhs))
    }
    return ['=', plhs, prhs]
  },

  // try/catch/throw
  // Parser produces ['try', body, ['catch', param, handler]?, ['finally', cleanup]?]
  'try'(body, ...clauses) {
    const catchClause = clauses.find(c => Array.isArray(c) && c[0] === 'catch')
    const finallyClause = clauses.find(c => Array.isArray(c) && c[0] === 'finally')
    const tryBody = prep(body)
    // prep(handler) ONCE — it has side effects (uniq++, scope pushes, includes), so
    // the no-finally catch branch must reuse `caught`, not re-prep (FE-3 fix).
    const caught = catchClause
      ? ['catch', tryBody, catchClause[1], prep(catchClause[2])]
      : tryBody
    return finallyClause ? ['finally', caught, prep(finallyClause[1])] : caught
  },
  'throw'(expr) { return ['throw', prep(expr)] },

  // Template literal: [``, part, ...] → fused single-allocation string concat.
  '`'(...parts) {
    // Fully-static template (`a${123}b`, `hello ${1+2} world`) folds to a single string
    // literal — a static data segment / SSO box, no runtime concat and no heap machinery.
    const folded = staticStringExpr(['`', ...parts])
    if (folded != null) return staticString(folded)
    includeForStringValue()
    const nodes = parts.map(p =>
      Array.isArray(p) && p[0] == null && typeof p[1] === 'string' ? ['str', p[1]] : prep(p))
    return ['strcat', ...nodes]
  },

  // Tagged template: tag`a${x}b` → tag(['a','b'], x)
  '``'(tag, ...parts) {
    const raw = staticStringExpr(['``', tag, ...parts])
    if (raw != null) return staticString(raw)
    const strs = [], exprs = []
    for (const p of parts) {
      if (Array.isArray(p) && p[0] == null && typeof p[1] === 'string') strs.push(p)
      else exprs.push(p)
    }
    const arr = strs.length === 1 ? ['[]', strs[0]] : ['[]', [',', ...strs]]
    const callArgs = exprs.length === 0 ? arr : [',', arr, ...exprs]
    return prep(['()', tag, callArgs])
  },

  // Import
  'import'(fromNode) {
    // Bare side-effect: `import './sub.js'` → AST is ['import', [null, 'path']]
    if (Array.isArray(fromNode) && fromNode[0] == null && typeof fromNode[1] === 'string')
      return handlers['from'](null, fromNode)
    if (!Array.isArray(fromNode) || fromNode[0] !== 'from')
      return err('Dynamic import() not supported')
    return handlers['from'](fromNode[1], fromNode[2])
  },

  // Mixed default+named import `import d, { n } from 'm'` — jessie emits it as a
  // statement-level comma `[',', ['import', d], ['from', spec, src]]` (the default
  // fragment lost its source). Reunite: bind the default, then the named specifiers,
  // both against the shared source. (prepareModule caches by specifier, so preparing
  // the source twice is a no-op — same as two separate `import` statements.)
  // Any other comma is a sequence expression: fall through to generic prep.
  ','(...items) {
    if (items.length === 2
      && Array.isArray(items[0]) && items[0][0] === 'import' && typeof items[0][1] === 'string'
      && Array.isArray(items[1]) && items[1][0] === 'from') {
      const source = items[1][2]
      handlers['from'](items[0][1], source)
      handlers['from'](items[1][1], source)
      return null
    }
    return [',', ...items.map(prep)]
  },

  'from'(specifiers, source) {
    const mod = source?.[1]
    if (!mod || typeof mod !== 'string') return err('Invalid import source')

    // Host imports override built-ins for named imports
    const hostMod = ctx.module.hostImports?.[mod]
    let remaining = specifiers
    if (hostMod && Array.isArray(specifiers) && specifiers[0] === '{}') {
      const inner = specifiers[1]
      if (inner != null) {
        const items = (Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : [inner]).filter(x => x != null)
        const builtinItems = []
        for (const item of items) {
          const name = typeof item === 'string' ? item : item[1]
          const alias = typeof item === 'string' ? item : item[2]
          const spec = hostMod[name]
          if (spec) {
            addHostImport(mod, name, alias, spec)
          } else {
            builtinItems.push(item)
          }
        }
        if (builtinItems.length === 0) return null
        if (!hasModule(mod)) {
          const name = typeof builtinItems[0] === 'string' ? builtinItems[0] : builtinItems[0][1]
          err(`'${name}' not declared in host module '${mod}'`)
        }
        remaining = ['{}', builtinItems.length === 1 ? builtinItems[0] : [',', ...builtinItems]]
      } else {
        return null
      }
    }

    // Tier 1: Built-in module
    if (hasModule(mod)) {
      includeModule(mod)
      const bind = (name, alias) => {
        const key = mod + '.' + name
        if (!ctx.core.emit[key]) err(`Unknown import: ${name} from '${mod}'`)
        ctx.scope.chain[alias || name] = key
      }

      if (typeof remaining === 'string') { ctx.scope.chain[remaining] = mod; return null }
      if (Array.isArray(remaining) && remaining[0] === 'as' && remaining[1] === '*') { ctx.scope.chain[remaining[2]] = mod; return null }

      if (Array.isArray(remaining) && remaining[0] === '{}') {
        const inner = remaining[1]
        if (inner == null) return null
        const items = (Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : [inner]).filter(x => x != null)
        for (const item of items)
          if (typeof item === 'string') bind(item)
          else if (Array.isArray(item) && item[0] === 'as') bind(item[1], item[2])
          else err(`Invalid import specifier: ${JSON.stringify(item)}`)
      }
      return null
    }

    // Tier 2: Source module (bundling)
    if (isBundledModule(mod)) {
      const resolved = prepareModule(mod, ctx.module.importSources?.[mod])
      // Default import: import name from 'mod' → bind to default export
      if (typeof specifiers === 'string') {
        const mangled = resolved.exports.get('default')
        if (!mangled) err(`'${mod}' has no default export`)
        ctx.scope.chain[specifiers] = mangled
        return null
      }
      // Namespace import: import * as X from 'mod' → bind X.prop to mangled names
      if (Array.isArray(specifiers) && specifiers[0] === 'as' && specifiers[1] === '*') {
        const alias = specifiers[2]
        // Store namespace mapping so '.' handler can resolve X.prop → mangled name
        if (!ctx.module.namespaces) ctx.module.namespaces = Object.create(null)  // name-keyed: prototype-less (see derive)
        ctx.module.namespaces[alias] = resolved.exports
        return null
      }
      // Named imports: import { a, b } from 'mod'
      if (Array.isArray(specifiers) && specifiers[0] === '{}') {
        const inner = specifiers[1]
        if (inner == null) return null
        const items = (Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : [inner]).filter(x => x != null)
        for (const item of items) {
          const name = typeof item === 'string' ? item : item[1]
          const alias = typeof item === 'string' ? item : item[2]
          const mangled = resolved.exports.get(name)
          if (!mangled) err(`'${name}' is not exported from '${mod}'`)
          ctx.scope.chain[alias] = mangled
        }
      }
      return null
    }

    // Tier 3: Host imports (non-built-in modules)
    if (hostMod) {
      if (Array.isArray(specifiers) && specifiers[0] === '{}') {
        const inner = specifiers[1]
        if (inner == null) return null
        const items = (Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : [inner]).filter(x => x != null)
        for (const item of items) {
          const name = typeof item === 'string' ? item : item[1]
          const alias = typeof item === 'string' ? item : item[2]
          const spec = hostMod[name]
          if (!spec) err(`'${name}' not declared in host module '${mod}'`)
          addHostImport(mod, name, alias, spec)
        }
      }
      return null
    }

    err(`Unknown module '${mod}'. Provide it via { modules: { '${mod}': source } } or { imports: { '${mod}': {...} } }`)
  },

  // `===`/`!==` keep strict semantics (no coercion); emit folds a statically-known
  // type mismatch to false and otherwise shares the loose `==`/`!=` same-type path.
  // resolveTypeof still collapses `typeof x === 'type'` to a compile-time check.
  // Prep operands directly (not via `prep` on the node) so the strict op survives
  // to emit instead of re-dispatching this handler forever.
  '==='(a, b) { return prepStrictEq('===', a, b) },
  '!=='(a, b) { return prepStrictEq('!==', a, b) },

  // Statements
  ';': (...stmts) => [';', ...stmts.map(prep).filter(x => x != null).map(dropDeadPostfix)],
  'let': (...inits) => prepDecl('let', ...inits),
  'const': (...inits) => prepDecl('const', ...inits),

  // Block-scoped control flow: push scope for bodies so inner let/const shadows correctly
  'if': (cond, then, els) => {
    const c = prep(stripBoolNot(cond))
    pushScope(); const t = dropDeadPostfix(prep(then)); popScope()
    if (els != null) { pushScope(); const e = dropDeadPostfix(prep(els)); popScope(); return ['if', c, t, e] }
    return ['if', c, t]
  },
  'while': (cond, body) => {
    const c = prep(stripBoolNot(cond))
    pushScope(); const b = dropDeadPostfix(prep(body)); popScope()
    return ['while', c, b]
  },
  // do { body } while (cond) → flag-guarded while: `flag=true; while (flag||cond) { flag=false; body }`.
  // jzify lowers this in default mode (jzify/transform.js), but strict mode skips jzify — without
  // this prepare-stage twin, strict `do-while` reaches emit as a raw 'do' and dies ("Unknown op: do"),
  // contradicting the README's strict-subset list. Re-prep the synthetic tree so scope/normalize apply.
  'do': (body, cond) => {
    const flag = `${T}do${ctx.func.uniq++}`
    return prep([';',
      ['let', ['=', flag, [null, true]]],
      ['while', ['||', flag, cond],
        ['{}', [';', ['=', flag, [null, false]], body]]]])
  },

  'export': decl => {
    if (Array.isArray(decl) && (decl[0] === 'let' || decl[0] === 'const'))
      for (const i of decl.slice(1))
        if (Array.isArray(i) && i[0] === '=' && typeof i[1] === 'string')
          ctx.func.exports[i[1]] = true
    // export name → bare-identifier re-export (shorthand for `export { name }`).
    // Register the binding and emit nothing; without this the name falls through
    // to `prep(decl)` below and compiles as a dead `global.get; drop` statement
    // while the export itself is silently lost.
    if (typeof decl === 'string') {
      const resolved = ctx.scope.chain[decl]
      ctx.func.exports[decl] = (resolved && resolved !== decl) ? resolved : decl
      return null
    }
    // export { name, name as alias } from './mod' or export * from './mod'
    if (Array.isArray(decl) && decl[0] === 'from') {
      const mod = decl[2]?.[1]
      if (!mod || typeof mod !== 'string') return null
      // Source module re-export
      if (isBundledModule(mod)) {
        const resolved = prepareModule(mod, ctx.module.importSources?.[mod])
        if (decl[1] === '*') {
          // export * from './mod' → register all exports
          for (const [name, mangled] of resolved.exports) {
            if (name !== 'default') ctx.func.exports[name] = mangled
          }
        } else if (Array.isArray(decl[1]) && decl[1][0] === '{}') {
          // export { a, b as c } from './mod'
          const inner = decl[1][1]
          if (inner == null) return null
          const items = (Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : [inner]).filter(x => x != null)
          for (const item of items) {
            const name = typeof item === 'string' ? item : item[1]
            const alias = typeof item === 'string' ? item : item[2]
            const mangled = resolved.exports.get(name)
            if (!mangled) err(`'${name}' is not exported from '${mod}'`)
            ctx.func.exports[alias] = mangled
          }
        }
      }
      return null
    }
    // export { name1, name2 as alias } → register named exports
    if (Array.isArray(decl) && decl[0] === '{}') {
      const inner = decl[1]
      if (inner == null) return null
      const items = Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : [inner]
      for (const item of items) {
        if (typeof item === 'string') {
          const resolved = ctx.scope.chain[item]
          ctx.func.exports[item] = (resolved && resolved !== item) ? resolved : item
        } else if (Array.isArray(item) && item[0] === 'as') {
          const [, source, alias] = item
          const resolved = ctx.scope.chain[source]
          ctx.func.exports[alias] = (resolved && resolved !== source) ? resolved : source
        }
      }
      return null
    }
    // export default expr → mark 'default' export, rewrite to assignment
    if (Array.isArray(decl) && decl[0] === 'default') {
      const val = decl[1]
      // export default name → export existing name as 'default'
      if (typeof val === 'string' && (hasFunc(val) || ctx.scope.globals.has(val))) {
        ctx.func.exports['default'] = val  // alias
        return null
      }
      // export default arrow → create function named 'default'
      ctx.func.exports['default'] = true
      if (Array.isArray(val) && val[0] === '=>') {
        if (defFunc('default', prep(val))) return null
      }
      // export default expr → create global 'default'
      declGlobal('default', 'f64')
      ctx.scope.userGlobals.add('default')
      return ['=', 'default', prep(val)]
    }
    return prep(decl)
  },

  // Arrow: don't prep params. Track depth for nested function detection.
  '=>': (params, body) => {
    if (depth > 0) { includeForCallableValue() }
    const raw = extractParams(params)
    const fnScope = new Map()
    for (const n of collectParamNames(raw)) fnScope.set(n, n)

    depth++
    pushScope(fnScope)
    funcLocalNames.push(new Set(collectParamNames(raw)))
    funcValueNames.push(new Set())

    const nextParams = []
    const bodyPrefix = []
    for (const r of raw) {
      const c = classifyParam(r)
      if (c.kind === 'rest') {
        // A rest param is an array: the binding holds one, and every call site
        // builds the rest array via `['[', …]`. Pull in the array emitter even
        // when the body never names an array literal (e.g. `(...xs) => 0`),
        // otherwise the call-site rest construction hits "Unknown op: [".
        includeForArrayLiteral()
        nextParams.push(r)
        if (typeof c.name === 'string') fnScope.set(c.name, c.name)
      } else if (c.kind === 'plain') {
        nextParams.push(c.name)
      } else if (c.kind === 'default') {
        nextParams.push(['=', c.name, prep(c.defValue)])
      } else {
        const tmp = `${T}p${ctx.func.uniq++}`
        fnScope.set(tmp, tmp)
        nextParams.push(c.kind === 'destruct-default' ? ['=', tmp, prep(c.defValue)] : tmp)
        bodyPrefix.push(prep(['let', ['=', c.pattern, tmp]]))
      }
    }
    let preparedBody = prep(body)
    // An expression-bodied arrow returning an empty object literal — `() => ({})`
    // — preps to a bare `['{}']`, structurally identical to an empty block body.
    // The grouping `()` that marked it an expression is unwrapped by then, so
    // wrap it in an explicit `return` — otherwise downstream block/expression
    // classification (compile.js `isBlockBody`) misreads it as an empty block.
    if (!(Array.isArray(body) && body[0] === '{}')
        && Array.isArray(preparedBody) && preparedBody[0] === '{}' && preparedBody.length === 1)
      preparedBody = ['{}', [';', ['return', ['{}']]]]
    if (bodyPrefix.length) {
      const prefix = bodyPrefix.filter(x => x != null)
      if (Array.isArray(preparedBody) && preparedBody[0] === '{}' && Array.isArray(preparedBody[1]) && preparedBody[1][0] === ';')
        preparedBody = ['{}', [';', ...prefix, ...preparedBody[1].slice(1)]]
      else if (Array.isArray(preparedBody) && preparedBody[0] === '{}')
        preparedBody = ['{}', [';', ...prefix, preparedBody[1]]]
      else
        preparedBody = ['{}', [';', ...prefix, ['return', preparedBody]]]
    }
    const inner = nextParams.length === 0 ? null : nextParams.length === 1 ? nextParams[0] : [',', ...nextParams]
    const result = ['=>', Array.isArray(params) && params[0] === '()' ? ['()', inner] : inner, preparedBody]
    popScope()
    funcLocalNames.pop()
    funcValueNames.pop()
    depth--
    return result
  },

  // Switch: prep discriminant and case values/bodies
  // Parser appends fall-through flag (number) to case bodies — strip it
  'switch'(discriminant, ...cases) {
    const prepCase = body => {
      if (Array.isArray(body) && body[0] === ';')
        return prep([';', ...body.slice(1).filter(s => typeof s !== 'number')])
      return prep(body)
    }
    return ['switch', prep(discriminant), ...cases.map(c => {
      if (c[0] === 'case') return ['case', prep(c[1]), prepCase(c[2])]
      if (c[0] === 'default') return ['default', prep(c[1])]
      return prep(c)
    })]
  },

  // Optional chaining / typeof — need ptr module. Optional member access pulls
  // the same modules as plain `.`/`[]` (a method like `includes` needs string +
  // array for emit's runtime dispatch); the only difference is the nullish guard,
  // which is emit's concern. Without this, `obj?.m(…)` reaches emit missing the
  // `.m` emitter and falls to the dynamic path that needs an unincluded module.
  '?.'(obj, prop) { includeForProperty(prop); return ['?.', prep(obj), prop] },
  '?.[]'(obj, idx) { includeForArrayAccess(); return ['?.[]', prep(obj), prep(idx)] },
  '?.()'(callee, callArgs) {
    // Parser wraps multi-args in a comma list, like '()'. Unwrap so emit gets flat positional args.
    const items = callArgs == null ? []
      : Array.isArray(callArgs) && callArgs[0] === ',' ? callArgs.slice(1)
      : [callArgs]
    return ['?.()', prep(callee), ...items.map(prep)]
  },
  // Boolean literals NaN-box as f64 — typeof at runtime returns 'number'. Fold here so the JS-spec value survives.
  // Unresolvable bare refs fold to 'undefined' via staticTypeofString (spec §13.5.3) —
  // the only place a stray identifier doesn't ReferenceError.
  'typeof'(a) {
    if (Array.isArray(a) && a[0] == null && typeof a[1] === 'boolean') { includeForStringOnly(); return ['str', 'boolean'] }
    const known = staticTypeofString(a)
    if (known != null) { includeForStringOnly(); return ['str', known] }
    return ['typeof', prep(a)]
  },

  // Unary +/- disambiguation
  '+'(a, b) {
    if (b === undefined) {
      const na = prep(a)
      if (isLit(na) && typeof na[1] === 'number') return na
      includeForNumericCoercion()
      return ['u+', na]
    }
    const pa = prep(a), pb = prep(b)
    // Compile-time fold of literal string concat. The combined bytes flow
    // through the `str` emitter as a single literal — SSO if ≤4 ASCII (zero
    // heap), otherwise one dataDedup entry (still cheaper than runtime
    // __str_concat_raw + heap alloc). Bottom-up, so `'a' + 'b' + 'c'` folds
    // left-associatively into one literal.
    if (Array.isArray(pa) && pa[0] === 'str' && typeof pa[1] === 'string' &&
        Array.isArray(pb) && pb[0] === 'str' && typeof pb[1] === 'string') {
      return ['str', pa[1] + pb[1]]
    }
    return ['+', pa, pb]
  },
  '-'(a, b) {
    // Fold `-<numeric literal>` to a literal, but NOT a bigint: jz's own `typeof` reports
    // a bigint value as 'number' too (its carrier is an f64), so under self-host this test
    // alone wrongly folds `-5n`, and negating the bigint here yields garbage (-2^63+5).
    // `typeof !== 'bigint'` excludes it in both engines (real JS: 'bigint'; jz: matches
    // 'bigint'). Bigint negation then flows to emit's i64.sub(0,·) path correctly.
    // `-0` is NOT folded: the self-host kernel evaluates the constant `-na[1]` with
    // i32 negation (i32 has no signed zero), collapsing -0→+0 — observable via sort's
    // -0<+0 tiebreak, Object.is, and 1/x. Leaving it as a runtime `u-` emits f64.neg,
    // which preserves the sign in both engines; V8 re-folds it, so no native cost.
    if (b === undefined) { const na = prep(a); return isLit(na) && typeof na[1] === 'number' && typeof na[1] !== 'bigint' && na[1] !== 0 ? [, -na[1]] : ['u-', na] }
    return ['-', prep(a), prep(b)]
  },

  // Ternary: parser emits '?' not '?:'
  '?'(cond, then, els) { return ['?:', prep(stripBoolNot(cond)), prep(then), prep(els)] },

  // ++/-- prefix vs postfix: parser sends trailing null for postfix
  // Postfix i++ = (++i) - 1: increment happens, arithmetic recovers old value.
  // Property obj.prop++ has no dedicated ++ node (the ++ emitter is name-based),
  // so it lowers to `obj.prop = obj.prop + 1` (returns the NEW value) — and the
  // same -1/+1 recovery wraps it for postfix to yield the OLD value.
  '++'(a, _post) {
    const n = prep(a)
    const inc = Array.isArray(n) && (n[0] === '.' || n[0] === '[]') ? ['=', n, ['+', n, [, 1]]] : ['++', n]
    return _post !== undefined ? ['-', inc, [, 1]] : inc
  },
  '--'(a, _post) {
    const n = prep(a)
    const dec = Array.isArray(n) && (n[0] === '.' || n[0] === '[]') ? ['=', n, ['-', n, [, 1]]] : ['--', n]
    return _post !== undefined ? ['+', dec, [, 1]] : dec
  },

  // Regex literal: ['//','pattern','flags?'] → include regex module, pass through
  '//'(pattern, flags) {
    return ['//', pattern, flags]
  },

  '**'(a, b) {
    // ES2016 §13.6: an unparenthesized unary expression cannot be the base of `**`
    // — `-x**2`, `~x**2`, `!x**2`, `+x**2`, `typeof x**2`, `void x**2`, `delete o[k]**2`
    // are all SyntaxErrors (the precedence is ambiguous). The parser leaves a grouping
    // as `['()', …]`, so a parenthesized base `(-x)**2` (and `-(x**2)`, where the unary
    // sits outside the `**`) arrives with a non-unary root op and is allowed.
    if (Array.isArray(a) && a.length === 2 && (a[0] === '-' || a[0] === '+' || a[0] === '!' || a[0] === '~' || a[0] === 'typeof' || a[0] === 'void' || a[0] === 'delete'))
      err(`Unary '${a[0]}' before '**' is a SyntaxError (ES2016 §13.6) — parenthesize: (${a[0]} x) ** 2 or ${a[0]} (x ** 2)`)
    return ['**', prep(a), prep(b)]
  },

  // Function call or grouping parens
'()'(callee, ...args) {
    // Grouping: (expr) → ['()', expr] with no args. Call: f() → ['()', 'f', null] with null arg.
    if (args.length === 0) return prep(callee)
    if (typeof callee === 'string' && REJECT_IDENTS[callee]) err(REJECT_IDENTS[callee])

    // Compile-time folds: the callee names something resolvable now. Each fold
    // is gated by callee shape, so at most one of the three fires.
    const folded = foldImportMetaResolve(callee, args)
      ?? dispatchConstructorCall(callee, args)
      ?? foldNamespaceIntrospection(callee, args)
    if (folded !== undefined) return folded

    callee = resolveCallee(callee, args)
    args = renestSoleCommaArg(args)

    const preppedArgs = args.filter(a => a != null).map(prep)
    for (const a of preppedArgs) {
      if (typeof a === 'string' && hasFunc(a)) {
        includeForCallableValue(); break
      }
    }
    // A zero-arg call keeps its explicit `null` args slot: `['()', callee, null]`,
    // not the slot-less `['()', callee]`. The latter is indistinguishable from a
    // grouping `(expr)`, so a second `prep` pass (the destructuring-assignment
    // lowering re-`prep`s its result) would re-read `x.pop()` as the grouping
    // `(x.pop)` and drop the call. Keeping the slot makes `prep` idempotent for
    // calls and matches `setCallArgs`'s canonical shape; `commaList(node[2])`
    // reads it back as zero args everywhere downstream.
    const result = preppedArgs.length ? ['()', callee, ...preppedArgs] : ['()', callee, null]

    if (callee === 'Object.assign' && ctx.schema.register) inferAssignSchema(result)

    return result
  },

  // Array literal/indexing — auto-include ptr + array modules
  '[]'(...args) {
    if (args.length === 1) {
      const inner = args[0]
      includeForArrayLiteral()
      if (inner == null) return ['[']
      // jessie consumes the trailing comma itself; every remaining `null` in the
      // element list is a genuine elision (`[,]` → length 1, `[1,,]` → length 2).
      if (Array.isArray(inner) && inner[0] === ',') { const items = inner.slice(1); return ['[', ...items.map(item => item == null ? [, undefined] : prep(item))] }
      return ['[', prep(inner)]
    }
    if (typeof args[0] === 'string' && ctx.module.namespaces?.[args[0]]) {
      includeForStringOnly()
      const key = prep(args[1])
      const exports = [...ctx.module.namespaces[args[0]].entries()]
      let fallback = [, undefined]
      for (let i = exports.length - 1; i >= 0; i--) {
        const [name, resolved] = exports[i]
        fallback = ['?:', ['==', key, ['str', name]], resolved, fallback]
      }
      return fallback
    }
    includeForArrayAccess()
    return ['[]', prep(args[0]), prep(args[1])]
  },

  // Bare block statement: push scope for let/const shadowing
  '{'(inner) {
    pushScope()
    const result = ['{', prep(inner)]
    popScope()
    return result
  },

  // Object literal - flatten comma, expand shorthand
  '{}'(...args) {
    const inner = args[0]
    // Block body: a single statement-op child (object props always start with
    // ':' or '...', never a statement op, so this never misfires on a literal).
    if (args.length === 1 && Array.isArray(inner) && STMT_OPS.has(inner[0])) {
      // Block body: push block scope for let/const shadowing
      pushScope()
      const result = ['{}', prep(inner)]
      popScope()
      return result
    }

    includeForObjectLiteral()
    if (args.length === 0 || inner == null) return ['{}']
    // The parser emits one comma-grouped child `['{}', [',', p1, p2]]`, but prep's
    // own output is spread `['{}', p1, p2]` (see `result` below). Accept both so
    // prep stays idempotent: the destructuring-assignment lowering ('=' handler)
    // re-preps a wrapper that already holds a normalized literal, and reading only
    // the first child here would drop every property but the first — mis-sizing the
    // schema to cap-1 and losing the rest.
    const items = args.length === 1
      ? (Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : [inner])
      : args

    // Computed keys: `{[k]: v}` where `k` isn't compile-time foldable. jz's
    // object layout is slot-based (fixed schema at the literal site), so a
    // truly-dynamic key can't slot in. Lower to the existing dict path:
    //   {a:1, [k]:v, b:2}  →  ((__t) => (__t[k]=v, __t))({a:1, b:2})
    // Static-but-non-string keys still fold via `staticPropertyKey` below.
    const isComputed = p => Array.isArray(p) && p[0] === ':'
      && typeof p[1] !== 'string' && staticPropertyKey(p[1]) == null
    if (items.some(isComputed)) {
      const staticItems = items.filter(p => !isComputed(p))
      const computedItems = items.filter(isComputed)
      const tmp = `${T}o${ctx.func.uniq++}`
      // Body: comma sequence of dict-sets, terminated with the tmp itself.
      // Computed key shape from parser is `[':', ['[]', keyExpr], valExpr]` —
      // unwrap the `['[]', keyExpr]` to grab keyExpr directly.
      const assigns = computedItems.map(p => {
        const keyExpr = Array.isArray(p[1]) && p[1][0] === '[]' ? p[1][1] : p[1]
        return ['=', ['[]', tmp, keyExpr], p[2]]
      })
      const body = [',', ...assigns, tmp]
      const arrow = ['=>', ['()', tmp], body]
      const arg = staticItems.length === 1 ? ['{}', staticItems[0]]
        : staticItems.length ? ['{}', [',', ...staticItems]]
        : ['{}']
      return prep(['()', arrow, arg])
    }

    // Process properties: shorthand 'x' → [':', 'x', 'x'], or [':', key, val] → prep val only
    const prop = p => {
      if (typeof p === 'string') return [':', p, prep(p)]
      if (Array.isArray(p) && p[0] === ':') {
        const key = typeof p[1] === 'string' ? p[1] : staticPropertyKey(p[1])
        if (key == null) err('computed property name not supported for fixed-shape object: use a compile-time string/number key')
        return [':', key, prep(p[2])]
      }
      // Accessors (`{ get x() {…} }` / `{ set x(v) {…} }`) parse to ['get'|'set', …].
      // jz objects are fixed-shape slot records with no accessor protocol, so they'd
      // otherwise fall through and compile to dead code (0 schema slots → `o.x` reads
      // undefined). Reject loudly — silent miscompile breaks "valid jz = valid JS".
      if (Array.isArray(p) && (p[0] === 'get' || p[0] === 'set'))
        err('object getter/setter not supported — jz objects have no accessors; use a method or a plain property + function')
      return prep(p)
    }
    let prepped = items.map(prop)
    // ES spec: duplicate keys allowed; key takes first-seen position, last-seen value.
    const lastValue = new Map()
    for (const p of prepped) if (Array.isArray(p) && p[0] === ':') lastValue.set(p[1], p[2])
    if (lastValue.size < prepped.filter(p => Array.isArray(p) && p[0] === ':').length) {
      const seen = new Set()
      prepped = prepped.filter(p => {
        if (!Array.isArray(p) || p[0] !== ':') return true
        if (seen.has(p[1])) return false
        seen.add(p[1])
        p[2] = lastValue.get(p[1])
        return true
      })
    }
    const result = ['{}', ...prepped]
    // Register schema so property access works for function params (duck typing)
    const props = result.slice(1).filter(p => Array.isArray(p) && p[0] === ':').map(p => p[1])
    if (props.length && ctx.schema.register) ctx.schema.register(props)
    return result
  },

  // For loop
  'for'(head, body) {
    pushScope()
    // For-in/of head re-association. In `for (k in o = expr)` / `for (k in a, obj)` the grammar
    // makes EVERYTHING right of the keyword the iteration source, but the expression parser binds
    // relational `in`/`of` tighter than assignment/comma/ternary/logical/equality/bitwise, so those
    // wrappers strand AROUND the whole head: `(k in o) = expr`. That reading is invalid JS (a
    // relational result is no assignment target; a single-expression for head with a top-level `in`
    // IS a for-in), so the only legal reading splices the wrapper chain back into the source:
    // descend the leftmost spine to the `in`/`of` node, replace it with its own right operand,
    // and iterate over the re-associated expression. (subscript 10.5.0's comment.js
    // `for (s in cm = parse.comment)` is the shape that surfaced this.)
    if (Array.isArray(head) && FORIN_WRAPPERS.has(head[0])) {
      let spine = head, parent = null
      while (Array.isArray(spine) && FORIN_WRAPPERS.has(spine[0])) { parent = spine; spine = spine[1] }
      if (Array.isArray(spine) && (spine[0] === 'in' || spine[0] === 'of')) {
        parent[1] = spine[2]
        head = [spine[0], spine[1], head]
      }
    }
    // A comma/sequence Expression in a for-IN head RHS — `for (x in a, b)` — is valid (the RHS is
    // an Expression): evaluate left-to-right for side effects, value as the last element. (for-OF's
    // RHS is an AssignmentExpression — no comma — so it is left alone.) The re-association above
    // lands it as a bare `,` node in the source slot. Don't wrap it in `()`: Object.keys((a, obj))
    // hides `obj` behind the sequence and loses its static schema (a non-escaping literal
    // scalarizes → 0 keys). Instead take the LAST element as the (direct) iteration source and run
    // the earlier elements once first.
    let forInSeqPre = null
    if (Array.isArray(head) && head[0] === 'in' && Array.isArray(head[2]) && head[2][0] === ',') {
      const parts = head[2].slice(1)
      head = [head[0], head[1], parts[parts.length - 1]]
      if (parts.length > 2) forInSeqPre = [',', ...parts.slice(0, -1)]
      else if (parts.length === 2) forInSeqPre = parts[0]
    }
    let r
    if (Array.isArray(head) && head[0] === ';') {
      let [, init, cond, step] = head
      cond = stripBoolNot(cond)
      // Keep a `.length` / `.size` / `.byteLength` for-bound i32 without snapshotting it:
      //   `i < arr.length` → `i < (arr.length | 0)`   (re-read every iteration)
      // The `| 0` forces i32 even for unknown-typed receivers (where __length returns
      // f64), so the counter `i` stays i32 through the comparison and `i++` — no
      // per-iteration f64.convert_i32_s + f64.lt + f64.add + i32.trunc_sat round-trip.
      // It must stay INLINE, not hoisted into a pre-loop local: JS re-reads the bound
      // each step, and a loop body can grow/shrink the array mid-iteration — including
      // through an alias the compiler can't see locally (e.g. `arr` shares identity with
      // a field a called helper pushes to, as compilePendingClosures does over
      // ctx.closure.bodies). A snapshot diverges from JS and silently truncates such loops.
      if (cond && Array.isArray(cond) && (cond[0] === '<' || cond[0] === '<=' || cond[0] === '>' || cond[0] === '>=')) {
        const lenExpr = cond[0] === '<' || cond[0] === '<=' ? cond[2] : cond[1]
        if (Array.isArray(lenExpr) && lenExpr[0] === '.' &&
            (lenExpr[2] === 'length' || lenExpr[2] === 'size' || lenExpr[2] === 'byteLength')) {
          const recv = lenExpr[1]
          const bound = ['|', lenExpr, [, 0]]
          const lengthStable = typeof recv === 'string' &&
            boundSafeCalls(body) && boundSafeCalls(step) && !writesReceiver(body, recv) && !writesReceiver(step, recv)
          if (lengthStable) {
            // Body can't change the bound → snapshot it once into an i32 local. Keeps
            // the counter `i` i32 through compare + `i++` (no per-iteration f64 round
            // trip) and gives the vectorizer the hoisted trip count it matches on.
            const lenVar = `${T}len${ctx.func.uniq++}`
            const lenDecl = ['let', ['=', lenVar, bound]]
            init = init ? [';', init, lenDecl] : lenDecl
            if (cond[0] === '<' || cond[0] === '<=') cond = [cond[0], cond[1], lenVar]
            else cond = [cond[0], lenVar, cond[2]]
          } else {
            // Body may grow/shrink the array (push/pop, or alias mutation through a
            // call) → re-read every iteration, as JS does. Still `| 0` for an i32 bound.
            if (cond[0] === '<' || cond[0] === '<=') cond = [cond[0], cond[1], bound]
            else cond = [cond[0], bound, cond[2]]
          }
        }
      }
      r = ['for', init ? prep(init) : null, cond ? prep(cond) : null, step ? dropDeadPostfix(prep(step)) : null, dropDeadPostfix(prep(body))]
    } else if (Array.isArray(head) && head[0] === 'of') {
      // for (let x of arr) → hoist arr (if non-trivial) and arr.length once, iterate by index.
      // Divergence from JS: mutating arr during iteration won't extend/shorten the loop.
      // jz philosophy: explicit > implicit; mutation during iteration is a code smell.
      const [, decl, src] = head
      const varName = Array.isArray(decl) && (decl[0] === 'let' || decl[0] === 'const') ? decl[1] : decl
      const idx = `${T}i${ctx.func.uniq++}`
      const lenVar = `${T}len${ctx.func.uniq++}`
      const arrVar = `${T}arr${ctx.func.uniq++}`
      // Normalize the source to an index-iterable once: a Set→keys / Map→[k,v]
      // array, while an Array/String/TypedArray passes through untouched (no
      // copy). Without this, `coll[i]` on a Set/Map reads raw open-addressing
      // slot words instead of live entries.
      // Wrap .length in `| 0` so the hoisted bound is i32 even for unknown
      // receivers (same rationale as the for-cond hoist above).
      const lenE = ['|', ['.', arrVar, 'length'], [, 0]]
      const decls = ['let', ['=', arrVar, ['()', '__iter_arr', src]], ['=', idx, [, 0]], ['=', lenVar, lenE]]
      const cond = ['<', idx, lenVar]
      const step = ['++', idx]
      const inner = [';', ['let', ['=', varName, ['[]', arrVar, idx]]], body]
      r = prep(['for', [';', decls, cond, step], inner])
    } else if (Array.isArray(head) && head[0] === 'in') {
      // `for…in` relies on runtime key enumeration — outside the pure canonical subset. strict
      // rejects it (consistent with `obj[k]` / unknown-receiver methods); use `Object.keys(obj)`.
      if (ctx.transform.strict) err('strict mode: `for…in` is not in the canonical subset — it relies on runtime key enumeration. Iterate `Object.keys(obj)` explicitly instead.')
      // for (let k in src) → enumerate src's own keys via Object.keys (schema ∪ any keys added
      // later for objects; "0".."n-1" for arrays/strings; [] for Set/Map) and iterate the resulting
      // array by index. One uniform path keeps for-in consistent with Object.keys (so dynamically
      // added keys appear in both), and break/continue work as in any for-loop. Object.keys'
      // enumeration stdlib is pulled only when for-in is actually used.
      const [, decl, src] = head
      const isDecl = Array.isArray(decl) && (decl[0] === 'let' || decl[0] === 'const')
      // `for ((x) in …)` — the LHS may be a cover-parenthesized identifier; unwrap to the target.
      let lhs = decl; while (Array.isArray(lhs) && lhs[0] === '()') lhs = lhs[1]
      const target = isDecl ? decl[1] : lhs
      // A member/computed LHS (`for (x.y in …)`, `for (obj[k] in …)`) assigns each key into the
      // existing place; let/const and a bare name take a fresh per-iteration `let` binding.
      const isMemberTarget = Array.isArray(target) && (target[0] === '.' || target[0] === '[]')
      // for-in over null/undefined is a no-op — ES ForIn/OfHeadEvaluation returns a break
      // completion before enumerating — but Object.keys(null|undefined) throws. So a nullish
      // source must enumerate the empty set. A static null (`[null,null]`) / undefined (`[]`)
      // skips Object.keys entirely; a bare identifier is guarded by a runtime `== null` test
      // (evaluated twice — side-effect-free — keeping Object.keys' *direct* receiver so its
      // static key schema still resolves); object/array literals and other expressions, which
      // are never nullish or carry no static schema to lose, stay direct.
      // A nullish literal node is `[<nullish-op>, value]` with both slots nullish: `null` is
      // `[null, null]`, `undefined` is `[null]` (empty value slot). A numeric/string literal
      // `[null, v]` has a non-nullish value slot, so `src[1] == null` discriminates them.
      const nullish = Array.isArray(src) && src[0] == null && src[1] == null
      // `__keys_ro` is for-in's read-only key list: identical to Object.keys, but
      // when the receiver has a complete static schema the keys are a compile-time
      // constant, so it pools ONE static-data array instead of allocating a fresh
      // one each evaluation — the per-iteration heap-growth cliff (jz#deopt-forin).
      // Sound only because for-in reads ks[i]/ks.length and never mutates (unlike
      // user Object.keys, which permits in-place `.sort()`/`.reverse()`).
      includeMods('core', 'object', 'string')
      const keysExpr = nullish ? ['[]', null]
        : typeof src === 'string'
          ? ['?', ['==', src, [null, null]], ['[]', null], ['()', '__keys_ro', src]]
          : ['()', '__keys_ro', src]
      const ks = `${T}fik${ctx.func.uniq++}`, ix = `${T}fii${ctx.func.uniq++}`, lenV = `${T}fil${ctx.func.uniq++}`
      const decls = ['let',
        ['=', ks, keysExpr],
        ['=', ix, [, 0]],
        ['=', lenV, ['|', ['.', ks, 'length'], [, 0]]]]
      const bindEach = isMemberTarget
        ? ['=', target, ['[]', ks, ix]]              // x.y = key / obj[k] = key
        : ['let', ['=', target, ['[]', ks, ix]]]     // let k = key  (fresh per-iteration binding)
      const forNode = ['for', [';', decls, ['<', ix, lenV], ['++', ix]],
        [';', bindEach, body]]
      // Run the dropped sequence prefix (earlier comma elements) once for side effects, before
      // the loop. Built raw and prepped as a unit so prep inserts the value-drop on the prefix.
      r = prep(forInSeqPre ? [';', forInSeqPre, forNode] : forNode)
    } else {
      // Some parser/jzify shapes for `for (;;)` and `for (; cond; )` arrive
      // as a null or bare-condition head instead of the canonical
      // `[';', init, cond, step]` tuple. Normalize them before emit so they
      // remain ordinary for-loops, not malformed two-slot nodes.
      r = ['for', null, head == null ? null : prep(head), null, prep(body)]
    }
    popScope()
    return r
  },

  // Property access - resolve namespaces or object/array properties
  '.'(obj, prop) {
    prop = typeof prop === 'string' ? prop : staticPropertyKey(prop)
    // `.caller`/`.callee` on a function value (or `arguments`) are deprecated
    // stack introspection — prohibited as bad practice. On a plain data object
    // they are ordinary field names (e.g. an ESTree call node's `.callee`), so
    // the ban keys off a known-function receiver, not the bare property name.
    if ((obj === 'arguments' || hasFunc(obj) || isFuncValueLocal(obj)) && (prop === 'caller' || prop === 'callee'))
      err('`.caller`/`.callee` are prohibited: deprecated function stack introspection')
    if (prop === 'url' && isImportMeta(obj)) return staticString(importMetaUrl())
    // A user binding named like a builtin namespace (`let Math = {…}`) shadows it
    // — read the property off the local value, not the builtin namespace table.
    if (shadowsBuiltin(obj)) { includeForProperty(prop); return ['.', prep(obj), prop] }
    const mod = ctx.scope.chain[obj]
    // Only treat as module namespace if it's a known built-in module (not a mangled import name)
    if (typeof obj === 'string' && mod && !mod.includes('.') && hasModule(mod)) {
      includeModule(mod)
      const key = mod + '.' + prop
      if (emitArity(ctx.core.emit[key]) > 0) includeForCallableValue()
      return key
    }
    // Source module namespace: import * as X → X.prop resolved to mangled name
    if (typeof obj === 'string' && ctx.module.namespaces?.[obj]) {
      const mangled = ctx.module.namespaces[obj].get(prop)
      if (mangled) return mangled
    }
    includeForProperty(prop)
    return ['.', prep(obj), prop]
  },

  // new - auto-import modules, resolve constructors
  'new'(ctor, ...args) {
    let name = ctor, ctorArgs = args
    if (Array.isArray(ctor) && ctor[0] === '()') { name = ctor[1]; ctorArgs = ctor.slice(2) }
    // No GC → weakness is unobservable, so we fold WeakSet/WeakMap to Set/Map right here:
    // construction and every .add/.has/.get/.set/.delete reuse the concrete emit path.
    // The fold lives in prepare, not jzify — so `strict` (which only skips jzify) wouldn't
    // drop it on its own; we reject explicitly. It's a deviation anyway (accepts primitive
    // keys, exposes .size/iteration), not a true subset member — there, use Set/Map directly.
    if (name === 'WeakSet' || name === 'WeakMap') {
      const concrete = name === 'WeakSet' ? 'Set' : 'Map'
      if (ctx.transform.strict) err(`strict mode: ${name} is not in the canonical subset — use ${concrete} (jz has no GC, so weak references are unobservable).`)
      name = concrete
    }
    // A lone `null` ctorArg is the parser's no-args sentinel (`new Map()`), and
    // `new Map(null)`/`new Map(undefined)` are spec-equivalent to it (null/undefined
    // → empty collection). Drop it so the emit hits the empty-collection fast path
    // rather than lowering `prep(null)` → `[, 0]` and routing through `__map_from`.
    // Typed arrays keep the sentinel: there `[, 0]` is a legitimate zero length.
    if (ctorArgs.length === 1 && ctorArgs[0] == null && (name === 'Date' || COLLECTION_CTORS.includes(name))) ctorArgs = []
    // Flatten comma-grouped args: [',', a, b, c] → [a, b, c]
    if (ctorArgs.length === 1 && Array.isArray(ctorArgs[0]) && ctorArgs[0][0] === ',')
      ctorArgs = ctorArgs[0].slice(1)

    if (name === 'URL') {
      const literalArgs = ctorArgs.filter(a => a != null)
      if (literalArgs.length === 2 && isImportMetaProp(literalArgs[1], 'url')) {
        const spec = stringValue(literalArgs[0])
        if (spec == null) err('`new URL(relative, import.meta.url)` supports only string literal relatives')
        return staticString(resolveImportMeta(spec))
      }
    }

    // `new RegExp("pattern", "flags?")` with string-literal pattern → compile
    // like a regex literal `/pattern/flags`. Dynamic pattern is not supported
    // (would require a runtime regex interpreter). Reported as build blocker #6.
    if (name === 'RegExp') {
      const literalArgs = ctorArgs.filter(a => a != null)
      const pattern = staticStringExpr(literalArgs[0])
      if (pattern == null)
        err('new RegExp() requires a string-literal pattern; dynamic regex construction is not supported')
      const flags = literalArgs.length > 1 ? staticStringExpr(literalArgs[1]) : ''
      if (flags == null)
        err('new RegExp() flags must be a string literal')
      return prep(['//', pattern, flags || undefined])
    }

    // Wrap multi-arg ctor arg lists back into a single comma-group — the '()' op
    // expects callArgs as a single element (possibly comma-grouped).
    const wrapArgs = (args) => args.length === 0 ? [null]
      : args.length === 1 ? [prep(args[0])]
      : [[',', ...args.map(prep)]]
    if (includeForRuntimeCtor(name)) {
      return ['()', `new.${name}`, ...wrapArgs(ctorArgs)]
    }

    const mod = ctx.scope.chain[name]
    if (typeof name === 'string' && mod && !mod.includes('.')) includeModule(mod)
    // Unknown constructor: treat as function call (jzify already strips new for known safe ones)
    if (typeof name === 'string') return ['()', name, ...ctorArgs.map(prep)]
    return ['new', prep(ctor), ...args.map(prep)]
  }
}

/** Merge source schemas into target via Object.assign for compile-time schema inference. */
function inferAssignSchema(callNode) {
  // After prep, args may be comma-grouped: ['()', callee, [',', target, s1, s2]]
  let assignArgs = callNode.slice(2)
  if (assignArgs.length === 1 && Array.isArray(assignArgs[0]) && assignArgs[0][0] === ',')
    assignArgs = assignArgs[0].slice(1)
  const [target, ...sources] = assignArgs
  if (typeof target !== 'string') return
  const existingId = ctx.schema.vars.get(target)
  const merged = existingId != null ? [...ctx.schema.list[existingId]] : []
  for (const src of sources) {
    let srcProps
    if (Array.isArray(src) && src[0] === '{}')
      srcProps = src.slice(1).filter(p => Array.isArray(p) && p[0] === ':').map(p => p[1])
    else if (typeof src === 'string') {
      const srcId = ctx.schema.vars.get(src)
      if (srcId != null) srcProps = ctx.schema.list[srcId]
    }
    if (srcProps) for (const p of srcProps) if (!merged.includes(p)) merged.push(p)
  }
  if (merged.length) ctx.schema.vars.set(target, ctx.schema.register(merged))
}

function defFunc(name, node) {
  if (!Array.isArray(node) || node[0] !== '=>') return false
  // Only extract top-level functions, not nested (closures stay as values)
  if (depth > 0) return false
  let [, rawParams, body] = node
  const raw = extractParams(rawParams)

  // Extract param names and defaults via shared classifier.
  // Destructured params desugar to fresh tmp + let-binding prefix in body.
  const params = [], defaults = {}, hasRest = [], bodyPrefix = []
  for (const r of raw) {
    const c = classifyParam(r)
    if (c.kind === 'rest') { hasRest.push(c.name); params.push({ name: c.name, type: 'f64', rest: true }) }
    else if (c.kind === 'plain') params.push({ name: c.name, type: 'f64' })
    else if (c.kind === 'default') {
      params.push({ name: c.name, type: 'f64' })
      // defFunc's node arrives PREPPED (every caller passes prep(rhs); the body is
      // consumed as-is below) — so the default value is prepped too. Re-prepping it
      // here double-lowered an arrow default's body: its prepared 5-ary 'for' nodes
      // re-entered the 2-ary 'for' handler, shifting init/cond/step into the wrong
      // slots (surfaced by subscript 10.5.0's dispatch(ops, tail, fn = (…) => {for…}) ).
      const defVal = c.defValue
      defaults[c.name] = defVal
      if (Array.isArray(defVal) && defVal[0] === '{}' && defVal.length > 1 && ctx.schema.register) {
        const props = defVal.slice(1).filter(p => Array.isArray(p) && p[0] === ':').map(p => p[1])
        if (props.length) ctx.schema.vars.set(c.name, ctx.schema.register(props))
      }
    } else {
      const tmp = `${T}p${ctx.func.uniq++}`
      params.push({ name: tmp, type: 'f64' })
      if (c.kind === 'destruct-default') defaults[tmp] = c.defValue   // prepped (see 'default' above)
      bodyPrefix.push(['let', ['=', c.pattern, tmp]])
    }
  }

  // Prepend destructuring to body (body is already prepped, so prefix needs prep too)
  if (bodyPrefix.length) {
    const preppedPrefix = bodyPrefix.map(prep).filter(x => x != null)
    if (Array.isArray(body) && body[0] === '{}' && Array.isArray(body[1]) && body[1][0] === ';')
      body = ['{}', [';', ...preppedPrefix, ...body[1].slice(1)]]
    else if (Array.isArray(body) && body[0] === '{}')
      body = ['{}', [';', ...preppedPrefix, body[1]]]
    else
      body = ['{}', [';', ...preppedPrefix, ['return', body]]]
  }

  const sig = { params, results: detectResults(body) }
  const hasDefaults = Object.keys(defaults).length > 0
  // Only main-module top-level exports become wasm-boundary exports.
  // Sub-module `export let X` is just a re-importable symbol — staying internal
  // unlocks treeshake + type specialization once main stops referencing it.
  const exported = !!ctx.func.exports[name] && ctx.module.moduleStack.length === 0
  const funcInfo = { name, body, exported, sig, ...(hasDefaults && { defaults }) }
  if (hasRest.length) funcInfo.rest = hasRest[0]  // track rest param name
  ctx.func.list.push(funcInfo)
  ctx.func.names.add(name)
  return true
}

// Multi-value threshold: ≤8 elements = tuple (multi-value return), >8 = memory array
const MAX_MULTI = 8

/** Detect return arity from function body. */
function detectResults(body) {
  // Expression body: [e1, e2, ...] → multi-return if ≤ threshold and no spreads
  if (Array.isArray(body) && body[0] === '[' && body.length > 2 && !body.some(e => Array.isArray(e) && e[0] === '...')) {
    const n = body.length - 1
    if (n <= MAX_MULTI) return Array(n).fill('f64')
  }
  // Block body: scan return statements
  if (Array.isArray(body) && body[0] === '{}') {
    const rets = []
    collectReturns(body, rets)
    if (rets.length) {
      const n = rets[0]
      if (n > 1 && n <= MAX_MULTI && rets.every(r => r === n)) return Array(n).fill('f64')
    }
  }
  return ['f64']
}

/** Collect return value arities from block AST. */
function collectReturns(node, out) {
  if (!Array.isArray(node)) return
  if (node[0] === 'return') {
    const val = node[1]
    // Array return: count elements, but only if no spreads (spreads → runtime array, not multi-value)
    if (Array.isArray(val) && val[0] === '[' && val.length > 2 && !val.some(e => Array.isArray(e) && e[0] === '...'))
      out.push(val.length - 1)
    else out.push(1)
    return
  }
  for (let i = 1; i < node.length; i++) collectReturns(node[i], out)
}

const isLit = n => Array.isArray(n) && n[0] == null

/** Self-host: pre-parsed module AST for a specifier, or undefined. Linear scan over
 *  [specifier, ast] pairs — array indexing + string `===` are the ABI-safe primitives
 *  the kernel can read off a host-marshalled argument (dynamic-key object reads aren't). */
function moduleAstFor(specifier) {
  const asts = ctx.module.importAsts
  if (!asts) return undefined
  for (let i = 0; i < asts.length; i++) if (asts[i][0] === specifier) return asts[i][1]
  return undefined
}

/** True when `mod` is bundled in-process — as source (host parses it) or as a
 *  pre-parsed AST (self-host kernel). Either path routes through prepareModule. */
const isBundledModule = mod => !!ctx.module.importSources?.[mod] || moduleAstFor(mod) !== undefined

/** Compile-time bundling: parse + prepare an imported module, collect exports. */
function prepareModule(specifier, source) {
  includeModule('core')
  // Cycle detection
  if (ctx.module.moduleStack.includes(specifier))
    err(`Circular import: ${ctx.module.moduleStack.join(' -> ')} -> ${specifier}`)
  // Already resolved
  if (ctx.module.resolvedModules.has(specifier)) return ctx.module.resolvedModules.get(specifier)

  ctx.module.moduleStack.push(specifier)

  // Name mangling prefix. Long specifiers (the bundler keys modules by
  // ABSOLUTE path — 40-60 byte '_Users_…' / '_home_runner_…' prefixes on every
  // symbol) compact to 'm<N>_<basename>': symbol strings shrink ~4×, which is
  // a direct hot-path win in the SELF-HOST — watr resolves every `call $name`
  // and `local.get $name` through name-keyed maps, paying hash+compare per
  // byte, and shared 35-byte path prefixes defeated the hash-probe early-outs.
  // Deterministic per compile (registration order); short relative specifiers
  // keep the readable form.
  const sanitized = specifier.replace(/[^a-zA-Z0-9]/g, '_')
  let prefix
  if (sanitized.length <= 24) prefix = sanitized
  else {
    if (!ctx.module.prefixIds) ctx.module.prefixIds = new Map()
    let id = ctx.module.prefixIds.get(specifier)
    if (id == null) { id = ctx.module.prefixIds.size; ctx.module.prefixIds.set(specifier, id) }
    const base = sanitized.replace(/_(js|mjs|jz)$/, '').match(/[a-zA-Z0-9]+$/)?.[0] ?? ''
    prefix = `m${id}_${base.slice(-16)}`
  }

  // Save caller state
  const savedScope = ctx.scope.chain, savedExports = ctx.func.exports
  const savedFuncCount = ctx.func.list.length  // track new funcs from this module
  const savedModulePrefix = ctx.module.currentPrefix
  ctx.scope.chain = derive(savedScope)  // inherit parent scope
  ctx.func.exports = Object.create(null)  // name-keyed: prototype-less (see derive)
  ctx.module.currentPrefix = prefix

  try {
  // Parse + prepare imported source (may trigger recursive imports). The parser
  // is injected via ctx.transform.parse (the host pipeline sets it) rather than
  // imported, so prepare carries no hard dependency on a concrete parser — the
  // same inversion as ctx.transform.jzify. The self-host kernel can't parse, so it
  // pre-parses the whole graph on the host and passes the ASTs via importAsts;
  // we consult those first and only parse `source` when no AST was supplied.
  let ast = moduleAstFor(specifier)
  if (ast === undefined) {
    if (!ctx.transform.parse) err('compile-time module bundling requires ctx.transform.parse (injected by the jz pipeline)')
    ast = ctx.transform.parse(source)
  }
  if (ctx.transform.jzify) ast = ctx.transform.jzify(ast)
  const savedDepth = depth; depth = 0
  const moduleInit = prep(ast)
  depth = savedDepth

  // Collect exports: rename exported funcs with prefix
  const moduleExports = new Map()
  const exportLocal = (exportName, localName) => {
    const mangled = `${prefix}$${localName}`
    moduleExports.set(exportName, mangled)
    const func = ctx.func.list.find(f => f.name === localName)
    if (func) { renameFunc(func, mangled); func._modulePrefix = prefix }
    if (ctx.scope.globals.has(localName)) {
      // Records carry no name — a rename is a pure Map re-key.
      ctx.scope.globals.set(mangled, ctx.scope.globals.get(localName))
      ctx.scope.globals.delete(localName)
      if (ctx.scope.userGlobals.has(localName)) { ctx.scope.userGlobals.delete(localName); ctx.scope.userGlobals.add(mangled) }
      if (ctx.scope.globalTypes.has(localName)) { ctx.scope.globalTypes.set(mangled, ctx.scope.globalTypes.get(localName)); ctx.scope.globalTypes.delete(localName) }
    }
  }
  for (const name of Object.keys(ctx.func.exports)) {
    const val = ctx.func.exports[name]
    // Default export alias: export default existingName → map 'default' to that name's mangled form
    if (name === 'default' && typeof val === 'string') {
      // Will resolve after all named exports are mangled
      continue
    }
    // Re-export alias: export { x } from './mod' → pass through inner module's mangled name
    if (typeof val === 'string') {
      if (val.startsWith(prefix + '$')) {
        moduleExports.set(name, val)
        continue
      }
      // Re-export of a binding imported from another module: val already carries
      // that other module's prefix (e.g. `__c$x`). Renaming it under our own
      // prefix would break in-module call sites that still reference the
      // original mangled name. Pass through verbatim.
      if (val.includes('$') &&
          (ctx.func.list.some(f => f.name === val) || ctx.scope.globals.has(val))) {
        moduleExports.set(name, val)
        continue
      }
      if (ctx.func.list.some(f => f.name === val || f.name === `${prefix}$${val}`) || ctx.scope.globals.has(val) || ctx.scope.globals.has(`${prefix}$${val}`)) {
        exportLocal(name, val)
        continue
      }
      moduleExports.set(name, val)
      continue
    }
    exportLocal(name, name)
  }
  // Resolve default export alias after named exports are mangled
  if (typeof ctx.func.exports['default'] === 'string') {
    const alias = ctx.func.exports['default']
    if (moduleExports.has(alias)) {
      // Already renamed as a named export
      moduleExports.set('default', moduleExports.get(alias))
    } else {
      // Not a named export — rename the function/global
      const mangled = `${prefix}$${alias}`
      moduleExports.set('default', mangled)
      const func = ctx.func.list.find(f => f.name === alias)
      if (func) renameFunc(func, mangled)
      if (ctx.scope.globals.has(alias)) {
        ctx.scope.globals.set(mangled, ctx.scope.globals.get(alias))
        ctx.scope.globals.delete(alias)
        if (ctx.scope.userGlobals.has(alias)) { ctx.scope.userGlobals.delete(alias); ctx.scope.userGlobals.add(mangled) }
      }
    }
  }

  // Rename ALL non-exported functions created during this module's prep
  // (fn property assignments like f32.parse, internal helpers like cleanInt).
  // Funcs added by nested prepareModule calls are tagged with `_modulePrefix`
  // by their own pass; skip those so prefixes don't stack (`a$b$name`).
  for (let i = savedFuncCount; i < ctx.func.list.length; i++) {
    const func = ctx.func.list[i]
    if (func.raw || func.name.startsWith(prefix + '$')) continue
    if (func._modulePrefix && func._modulePrefix !== prefix) continue
    const mangled = `${prefix}$${func.name}`
    moduleExports.set(func.name, mangled)
    renameFunc(func, mangled)
    func._modulePrefix = prefix
  }

  // Add mangled non-exported globals to moduleExports for walk renaming
  // (e.g., module-level const/let used by functions declared before the global)
  for (const [mangled, wat] of ctx.scope.globals) {
    if (mangled.startsWith(prefix + '$')) {
      const original = mangled.slice(prefix.length + 1)
      if (!moduleExports.has(original)) moduleExports.set(original, mangled)
    }
  }

  // Rename references in function bodies — walk ALL functions created during this module's prep
  if (moduleExports.size) {
    const walk = (node, skip) => {
      if (!Array.isArray(node)) return typeof node === 'string' && !skip?.has(node) && moduleExports.has(node) ? moduleExports.get(node) : node
      if (node[0] === 'str' || node[0] == null || node[0] === '`' || node[0] === '//') return node
      if (node[0] === ':') { node[2] = walk(node[2], skip); return node }
      // Static member access: `obj.prop` — only the receiver is a reference; the
      // property name is a literal key and must not be renamed even if it collides
      // with a module-scoped binding (e.g. `IMM.reftype` where `const reftype` exists).
      if (node[0] === '.' || node[0] === '?.') { node[1] = walk(node[1], skip); return node }
      if (node[0] === '=>') {
        node[2] = walk(node[2], collectParamNames(extractParams(node[1]), new Set(skip)))
        return node
      }
      for (let j = 0; j < node.length; j++) node[j] = walk(node[j], skip)
      return node
    }
    for (let i = savedFuncCount; i < ctx.func.list.length; i++) {
      const func = ctx.func.list[i]
      if (!func.body) continue
      // Sub-module funcs already had their own walk; parent's rename map doesn't apply.
      if (func._modulePrefix && func._modulePrefix !== prefix) continue
      const funcParams = new Set(func.sig?.params?.map(p => p.name) || [])
      walk(func.body, funcParams)
      if (func.defaults) for (const [k, v] of Object.entries(func.defaults)) func.defaults[k] = walk(v, funcParams)
    }
    // Also rename init code AST
    if (moduleInit) walk(moduleInit)
  }

  // Collect sub-module init code (variable initializations) for __start
  if (moduleInit) {
    if (!ctx.module.moduleInits) ctx.module.moduleInits = []
    ctx.module.moduleInits.push(moduleInit)
    recordModuleInitFacts(moduleInit)
  }

  const result = { exports: moduleExports }
  ctx.module.resolvedModules.set(specifier, result)
  return result
  } finally {
    // ALWAYS restore caller state (FE-6): if `prep(ast)` or a recursive import threw
    // mid-prep, skipping this would leave ctx.scope/exports/prefix/moduleStack
    // corrupted for the rest of the pipeline.
    ctx.scope.chain = savedScope
    ctx.func.exports = savedExports
    ctx.module.currentPrefix = savedModulePrefix
    ctx.module.moduleStack.pop()
  }
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
  walkSparse(root)
}
function walkSparse(node) {
  if (!Array.isArray(node)) return
  for (let i = 1; i < node.length; i++) walkSparse(node[i])
  if (node[0] === ';') tryFuseInBlock(node)
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
    if (refsName(seq[k], NAME, { skipArrow: false })) return null
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
