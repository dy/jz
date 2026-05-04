/**
 * Pre-analysis passes — type inference, local analysis, capture detection.
 *
 * # Stage contract
 *   IN:  prepared AST + ctx.func.list (from prepare).
 *   OUT: per-function populated `ctx.func.repByLocal` (val field) + `ctx.func.locals` + `ctx.func.boxed`,
 *        module-global `ctx.scope.globalValTypes`, type-analysis `ctx.types.typedElem` /
 *        `.dynKeyVars` / `.anyDynKey`.
 *
 * # Passes (all walk AST; none mutate AST itself — only ctx)
 *   - valTypeOf:           expression-level value-type inference (pure)
 *   - lookupValType:       name→VAL.* resolver (func scope ∪ global scope)
 *   - analyzeBody:         single unified walk — body-keyed cache, returns
 *                          { locals, valTypes, arrElemSchemas, arrElemValTypes, typedElems }
 *   - analyzeValTypes:     ctx-mutating pass — writes types + tracks regex/typed + localProps
 *   - analyzeLocals:       thin clone-and-extend facade over analyzeBody().locals
 *   - analyzeDynKeys:      cross-function scan for `obj[runtimeKey]` → sets ctx.types.dynKeyVars
 *   - analyzeBoxedCaptures:detect mutably-captured vars → ctx.func.boxed cells
 *   - extractParams/classifyParam/collectParamNames: arrow param AST normalization helpers
 *
 * Ordering: analyzeDynKeys runs once per compile; others run per function during compile().
 *
 * @module analyze
 */

import { ctx, err } from './ctx.js'
import { isLiteralStr, isFuncRef } from './ir.js'

export const T = '\uE000'

/** Statement operators — used to distinguish block bodies from object literals. */
export const STMT_OPS = new Set([';', 'let', 'const', 'return', 'if', 'for', 'for-in', 'while', 'break', 'continue', 'switch',
  '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '>>=', '<<=', '>>>=', '||=', '&&=', '??=',
  'throw', 'try', 'catch', 'finally', '++', '--', '()'])

/** Distinguish a function block body `{ ... }` from an expression-bodied object literal `({a:1})`.
 *  Both share the `'{}'` op tag; blocks have a non-`':'` first child (object literals start with key:val pairs). */
export const isBlockBody = (body) =>
  Array.isArray(body) && body[0] === '{}' && body[1]?.[0] !== ':'

/** Collect all `return X` expressions (X != null) from a function body, skipping nested arrow funcs.
 *  Pushes into `out`. Non-returning paths are silently skipped — pair with `alwaysReturns` if total
 *  coverage matters, or with `hasBareReturn` to detect `return;` (undef result). */
export const collectReturnExprs = (node, out) => {
  if (!Array.isArray(node)) return
  const [op, ...args] = node
  if (op === '=>') return
  if (op === 'return') { if (args[0] != null) out.push(args[0]); return }
  for (const a of args) collectReturnExprs(a, out)
}

/** True if every control-flow path through `n` is guaranteed to terminate via return/throw.
 *  Conservative: only recognizes block-trailing return, both arms of complete if/else. Loops/switches
 *  count as non-terminating since fall-through is possible. Used by ptr-narrowing to ensure
 *  fallthrough fallback won't produce a wrong-typed undef. */
export const alwaysReturns = (n) => {
  if (!Array.isArray(n)) return false
  const op = n[0]
  if (op === '=>') return false
  if (op === 'return' || op === 'throw') return true
  if (op === '{}' || op === ';') return alwaysReturns(n[n.length - 1])
  if (op === 'if') return n.length >= 4 && alwaysReturns(n[2]) && alwaysReturns(n[3])
  return false
}

/** True if `n` contains a bare `return;` (no value → undefined).
 *  Bare returns force the result type to f64 (undef sentinel) — narrowing must skip such bodies. */
export const hasBareReturn = (n) => {
  if (!Array.isArray(n)) return false
  if (n[0] === '=>') return false
  if (n[0] === 'return' && n[1] == null) return true
  return n.some(hasBareReturn)
}

/** Unify body→return-expressions: block bodies collect via `collectReturnExprs`,
 *  expression bodies wrap into `[body]`. Pure convenience over the
 *  `if (isBlock) collect(...) else exprs.push(body)` pattern repeated across
 *  narrowing passes. */
export const returnExprs = (body) => {
  if (isBlockBody(body)) {
    const out = []
    collectReturnExprs(body, out)
    return out
  }
  return [body]
}

// Value types — what a variable holds (for method dispatch, schema resolution)
export const VAL = {
  NUMBER: 'number', ARRAY: 'array', STRING: 'string',
  OBJECT: 'object', HASH: 'hash', SET: 'set', MAP: 'map',
  CLOSURE: 'closure', TYPED: 'typed', REGEX: 'regex',
  BIGINT: 'bigint', BUFFER: 'buffer',
}

/**
 * ValueRep — unified per-local + per-param representation record. (S2.)
 *
 * One shape, two storages:
 *   - per-local (current func):  ctx.func.repByLocal: Map<name, ValueRep>
 *   - per-param (cross-call):    programFacts.paramReps: Map<funcName, Map<paramIdx, ValueRep>>
 *
 * Lattice per field: undefined = unobserved, null = sticky-poison
 * (cross-site disagreement), value = consensus. Local reps don't use the null
 * sentinel (locals are intra-function — single point of truth). Param reps do
 * (cross-call fixpoint convergence).
 *
 * Fields:
 *   val:              VAL.* — value-type for method dispatch / schema / length
 *   wasm:             'i32'|'f64' — narrowed wasm type at param boundary (param-only today)
 *   ptrKind:          VAL.* — local stores unboxed i32 pointer offset (local-only today)
 *   ptrAux:           i32   — kind-dependent aux (TYPED elem code, schemaId, …)
 *   schemaId:         i32   — schema binding for known-shape OBJECTs
 *   arrayElemSchema:  i32   — Array<schemaId> element shape
 *   arrayElemValType: VAL.* — Array<VAL.*> element val-kind
 *   jsonShape:        obj   — { vt, props?, elem? } for HASH/ARRAY trees parsed
 *                             from a compile-time JSON.parse source. Propagates
 *                             through `.prop` and `[i]` so nested chains stay typed.
 *   typedCtor:        str   — TypedArray ctor name (`Float64Array`, …)
 *   intCertain:       bool  — proven integer-valued (every defining RHS is integer-shaped).
 *                             Pure analysis fact; codegen extensions may use it to choose
 *                             i32-shaped emission inside hot regions where range fits.
 *                             Boundary ABI is NOT narrowed by this fact alone — narrowing
 *                             at param/result level remains a separate, opt-in decision.
 *   intConst:         number — proven same integer literal at every static call site.
 *                             Param-only (cross-call fixpoint). Drives constant substitution
 *                             at readVar: every `local.get $param` lowers to `i32.const N`
 *                             (or `f64.const N`), letting the WAT optimizer fold guards,
 *                             unroll fixed-bound loops, and treeshake the read entirely.
 *                             Cleared if the param is written inside the body.
 *
 * Future (S2 stage 4 follow-ups): boxed, intLikely, nullable.
 */

// === ParamReps lattice helpers (cross-call fixpoint) ===
// programFacts.paramReps: Map<funcName, Map<paramIdx, ValueRep>>. Per-field lattice:
// undefined unobserved, null sticky-poison (cross-site disagreement), value = consensus.

/** Per-call-site fact merge into a param's ValueRep field, with sticky-null poison
 *  on disagreement. undefined→observed (set); same value→stay; conflict→null (sticky).
 *  null is "no consensus" — readers treat it as missing. */
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

/** Build `paramName → fact` lookup for a caller's already-narrowed param facts.
 *  Used to flow caller's param info into its callees during the cross-call
 *  fixpoint (transitive propagation). Returns null if caller has no facts. */
export const callerParamFactMap = (paramReps, callerFunc, key) => {
  if (!callerFunc) return null
  const m = paramReps.get(callerFunc.name)
  if (!m) return null
  let out = null
  for (const [k, r] of m) {
    const v = r[key]
    if (v != null && k < callerFunc.sig.params.length) {
      out ||= new Map()
      out.set(callerFunc.sig.params[k].name, v)
    }
  }
  return out
}

/** Reset sticky-null on a single field across all params program-wide.
 *  Used between fixpoint phases when newly-narrowed facts unblock previously-
 *  poisoned observations (e.g. valResult set after first pass). */
export const clearStickyNull = (paramReps, key) => {
  for (const m of paramReps.values()) for (const r of m.values()) {
    if (r[key] === null) r[key] = undefined
  }
}

/** Get the rep for a local name, or undefined if not tracked. */
export const repOf = name => ctx.func.repByLocal?.get(name)

/** Merge fields into a local's rep. Lazily allocates the map and the rep.
 *  Field set to `undefined` removes that field; empty rep is dropped from the map. */
export const updateRep = (name, fields) => {
  const m = ctx.func.repByLocal ||= new Map()
  const prev = m.get(name) || {}
  const next = { ...prev, ...fields }
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
  if (Object.keys(next).length === 0) m.delete(name)
  else m.set(name, next)
}

/** Get the rep for a global name, or undefined if not tracked. */
export const repOfGlobal = name => ctx.scope.repByGlobal?.get(name)

/** Merge fields into a global's rep. Lazily allocates the map and the rep. */
export const updateGlobalRep = (name, fields) => {
  const m = ctx.scope.repByGlobal ||= new Map()
  const prev = m.get(name)
  m.set(name, prev ? { ...prev, ...fields } : { ...fields })
}

/** Look up value type for a variable name. Order: flow-sensitive refinement (if any) →
 *  in-progress analyzeBody overlay (if any) → function-local scope → module-global scope.
 *  Refinements are pushed by the 'if' emitter when the condition is a type guard
 *  (typeof x === 't', Array.isArray(x), etc.) and popped after the then-branch.
 *  The overlay (`ctx.func.localValTypesOverlay`) is set by analyzeBody/observeSlots passes
 *  pre-emit, when `repByLocal` isn't populated yet but a local Map<name, VAL.*> is
 *  available — lets `const x = new Float64Array(); const y = x[0]` resolve y as NUMBER. */
export const lookupValType = name => {
  const r = ctx.func.refinements
  if (r && r.size) { const v = r.get(name); if (v) return v }
  const ov = ctx.func.localValTypesOverlay
  if (ov) { const v = ov.get(name); if (v) return v }
  return ctx.func.repByLocal?.get(name)?.val || ctx.scope.globalValTypes?.get(name) || null
}

/** Infer value type of an AST expression (without emitting). */
export function valTypeOf(expr) {
  if (expr == null) return null
  if (typeof expr === 'number') return VAL.NUMBER
  if (typeof expr === 'bigint') return VAL.BIGINT
  if (typeof expr === 'string') return lookupValType(expr)
  if (!Array.isArray(expr)) return null

  const [op, ...args] = expr
  if (op == null) {
    // Literal forms: [] = undefined, [null, null] = null, [null, n] = number/bigint
    if (args.length === 0) return null              // undefined literal
    if (args[0] == null) return null                // null literal
    return typeof args[0] === 'bigint' ? VAL.BIGINT : VAL.NUMBER
  }

  if (op === '[') return VAL.ARRAY
  if (op === 'str' || op === 'strcat') return VAL.STRING
  if (op === '=>') return VAL.CLOSURE
  if (op === '//') return VAL.REGEX
  if (op === '{}' && args[0]?.[0] === ':') return VAL.OBJECT
  // `[]` op covers both array literals (1 arg) and index access (2 args).
  // Array literal: `[]` → ['[]', null]; `[1,2]` → ['[]', [',', ...]]; `[x]` → ['[]', x].
  // Index access:  `arr[i]` → ['[]', arr, i].
  if (op === '[]') {
    if (args.length < 2) return VAL.ARRAY
    // Indexed read on a known typed-array receiver yields a number (BigInt64/BigUint64Array
    // would yield BigInt, but they're rare and we don't track per-elem type here — the
    // .typed:[] emit path already handles their f64-cast correctly; this only affects
    // arithmetic-time __to_num elision, where assuming Number is safe-by-construction).
    if (typeof args[0] === 'string' && lookupValType(args[0]) === VAL.TYPED) return VAL.NUMBER
    // Indexed read on a known Array<VAL> receiver: bind by rep.arrayElemValType.
    // Set by analyzeValTypes from body observations + emitFunc preseed for params.
    if (typeof args[0] === 'string') {
      const elemVt = ctx.func.repByLocal?.get(args[0])?.arrayElemValType
      if (elemVt) return elemVt
    }
  }
  // Schema slot read: when `varName` has a bound schemaId and `.prop` resolves
  // to a slot whose VAL kind is monomorphic across program-wide observations,
  // return that kind. Lets `+`, `===`, method dispatch skip runtime str-key
  // checks on numeric properties of known shapes. Precise-only — see
  // ctx.schema.slotVT for why structural subtyping is intentionally off.
  if (op === '.' && typeof args[1] === 'string' && ctx.schema?.slotVT) {
    const slotVT = ctx.schema.slotVT(args[0], args[1])
    if (slotVT) return slotVT
  }
  // VAL.HASH `.prop` propagation: when the receiver chain roots at a binding
  // sourced from `JSON.parse(stringConst)`, walk the shape tree to recover the
  // child's val-type. Generic for any compile-time-known JSON literal.
  if (op === '.' && typeof args[1] === 'string') {
    const sh = shapeOf(args[0])
    if (sh?.vt === VAL.HASH) {
      const child = sh.props[args[1]]
      if (child) return child.vt
    }
  }
  // Arithmetic expressions: BigInt if either operand is BigInt, else number
  if (['-', 'u-', '*', '/', '%', '&', '|', '^', '<<', '>>'].includes(op)) {
    if (valTypeOf(args[0]) === VAL.BIGINT || valTypeOf(args[1]) === VAL.BIGINT) return VAL.BIGINT
    return VAL.NUMBER
  }
  if (['**', '++', '--', '~', '>>>', 'u+'].includes(op)) return VAL.NUMBER
  if (op === '+') {
    const ta = valTypeOf(args[0]), tb = valTypeOf(args[1])
    if (ta === VAL.STRING || tb === VAL.STRING) return VAL.STRING
    if (ta === VAL.BIGINT || tb === VAL.BIGINT) return VAL.BIGINT
    return VAL.NUMBER
  }

  if (op === '()') {
    const callee = args[0]
    // Ternary is parsed as call to '?' operator: ['()', ['?', cond, a, b]]
    if (Array.isArray(callee) && callee[0] === '?') {
      const ta = valTypeOf(callee[2]), tb = valTypeOf(callee[3])
      return ta && ta === tb ? ta : null
    }
    // Constructor results + user function return-type inference
    if (typeof callee === 'string') {
      if (callee === 'new.Set') return VAL.SET
      if (callee === 'new.Map') return VAL.MAP
      if (callee === 'new.ArrayBuffer') return VAL.BUFFER
      if (callee === 'new.DataView') return VAL.BUFFER
      if (callee.startsWith('new.')) return VAL.TYPED
      if (callee === 'String.fromCharCode' || callee === 'String') return VAL.STRING
      if (callee === 'BigInt' || callee === 'BigInt.asIntN' || callee === 'BigInt.asUintN') return VAL.BIGINT
      if (callee === 'JSON.parse') {
        const src = jsonConstString(args[1])
        if (src != null) {
          const c = src.trimStart()[0]
          if (c === '{') return VAL.HASH
          if (c === '[') return VAL.ARRAY
          if (c === '"') return VAL.STRING
          if (c === 't' || c === 'f' || c === '-' || (c >= '0' && c <= '9')) return VAL.NUMBER
        }
      }
      // Math.* always returns Number — let `+` skip string-concat dispatch and
      // let exprType propagate i32 for the integer-returning subset.
      if (typeof callee === 'string' && callee.startsWith('math.')) return VAL.NUMBER
      // Clock helpers always return Number — lets `t0 = performance.now()` propagate
      // VAL.NUMBER through subsequent reads, eliding `__to_num` wrappers in arithmetic.
      if (callee === 'performance.now' || callee === 'Date.now') return VAL.NUMBER
      const hostVT = ctx.module.hostImportValTypes?.get(callee)
      if (hostVT) return hostVT
      // User-defined func with monomorphic VAL return (populated in compile.js E2 pass).
      const f = ctx.func.map?.get(callee)
      if (f?.valResult) return f.valResult
    }
    // Method return types
    if (Array.isArray(callee) && callee[0] === '.') {
      const [, obj, method] = callee
      if (method === 'map' || method === 'filter') {
        // Typed-array .map/.filter preserve element type → return VAL.TYPED.
        // Unknown receiver: don't claim (stay null) — runtime-dispatched index handles both.
        const objType = valTypeOf(obj)
        if (objType === VAL.TYPED) return VAL.TYPED
        if (objType === VAL.ARRAY) return VAL.ARRAY
        return null
      }
      if (method === 'push') return VAL.ARRAY
      if (method === 'add' || method === 'delete') return VAL.SET
      if (method === 'set') return VAL.MAP
      // String-returning methods
      if (['toUpperCase', 'toLowerCase', 'trim', 'trimStart', 'trimEnd',
        'repeat', 'padStart', 'padEnd', 'replace', 'charAt', 'substring'].includes(method)) return VAL.STRING
      // slice/concat preserve caller type (string.slice → string, array.slice → array)
      if (method === 'slice' || method === 'concat') {
        const objType = valTypeOf(obj)
        if (objType) return objType
        return VAL.ARRAY // default to array when unknown
      }
    }
  }
  return null
}

function jsonConstString(expr) {
  if (Array.isArray(expr) && expr[0] === 'str' && typeof expr[1] === 'string') return expr[1]
  if (Array.isArray(expr) && expr[0] == null && typeof expr[1] === 'string') return expr[1]
  if (typeof expr === 'string') return ctx.scope.constStrs?.get(expr) ?? null
  return null
}

/** Build a structural shape tree from a parsed JSON value. Each node is
 *  `{ vt, props?, elem? }`. Lets `valTypeOf` propagate VAL kinds through
 *  `.prop` chains and `[i]` reads on bindings sourced from `JSON.parse`
 *  of a compile-time-known string. Polymorphic arrays drop their `elem`. */
function shapeOfJsonValue(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return { vt: VAL.NUMBER }
  if (typeof v === 'string') return { vt: VAL.STRING }
  if (typeof v === 'boolean') return { vt: VAL.NUMBER }
  if (Array.isArray(v)) {
    let elem = null
    for (const x of v) {
      const s = shapeOfJsonValue(x)
      if (!s) { elem = null; break }
      if (!elem) elem = s
      else if (!shapeUnifies(elem, s)) { elem = null; break }
    }
    return { vt: VAL.ARRAY, elem }
  }
  if (typeof v === 'object') {
    const props = Object.create(null)
    for (const k of Object.keys(v)) {
      const s = shapeOfJsonValue(v[k])
      if (s) props[k] = s
    }
    return { vt: VAL.HASH, props }
  }
  return null
}

function shapeUnifies(a, b) {
  if (!a || !b || a.vt !== b.vt) return false
  if (a.vt === VAL.HASH) {
    const ak = Object.keys(a.props), bk = Object.keys(b.props)
    if (ak.length !== bk.length) return false
    for (const k of ak) {
      if (!b.props[k] || !shapeUnifies(a.props[k], b.props[k])) return false
    }
  }
  if (a.vt === VAL.ARRAY) {
    if ((a.elem == null) !== (b.elem == null)) return false
    if (a.elem && !shapeUnifies(a.elem, b.elem)) return false
  }
  return true
}

const _jsonShapeCache = new WeakMap()
function parseJsonShape(src) {
  if (typeof src !== 'string') return null
  if (_jsonShapeCache.has(src)) return _jsonShapeCache.get(src)
  let parsed
  try { parsed = JSON.parse(src) } catch { _jsonShapeCache.set(Object(src), null); return null }
  const sh = shapeOfJsonValue(parsed)
  // WeakMap requires object keys; cache via a wrapper. Skip caching for cold path.
  return sh
}

/** Resolve the json shape for an expression by walking name → rep.jsonShape and
 *  `.prop` / `[i]` indirection. Returns null when shape is unknown at this site. */
export function shapeOf(expr) {
  if (typeof expr === 'string') return ctx.func.repByLocal?.get(expr)?.jsonShape || null
  if (!Array.isArray(expr)) return null
  const [op, ...args] = expr
  if (op === '()' && args[0] === 'JSON.parse') {
    const src = jsonConstString(args[1])
    if (src != null) return parseJsonShape(src)
  }
  if (op === '.' && typeof args[1] === 'string') {
    const parent = shapeOf(args[0])
    if (parent?.vt === VAL.HASH) return parent.props[args[1]] || null
  }
  if (op === '[]' && args.length === 2) {
    const parent = shapeOf(args[0])
    if (parent?.vt === VAL.ARRAY) return parent.elem || null
  }
  return null
}


/** Decode a `['{}', ...]` AST's children into `{names, values}`, or null if any
 *  property is non-static-key (computed key, spread, shorthand). Matches the
 *  emitter's flatten rule for comma-grouped props. Used by collectProgramFacts,
 *  narrowSignatures, and objLiteralSchemaId; the emitter (module/object.js)
 *  does its own decoding because it must handle the spread/computed-key paths. */
export function staticObjectProps(args) {
  const raw = args.length === 1 && Array.isArray(args[0]) && args[0][0] === ',' ? args[0].slice(1) : args
  const names = [], values = []
  for (const p of raw) {
    if (!Array.isArray(p) || p[0] !== ':' || typeof p[1] !== 'string') return null
    names.push(p[1]); values.push(p[2])
  }
  return names.length ? { names, values } : null
}

/** Schema-id for an object literal expression. Returns null on dynamic keys, spread, shorthand. */
function objLiteralSchemaId(expr) {
  if (!Array.isArray(expr) || expr[0] !== '{}' || !ctx.schema?.register) return null
  const parsed = staticObjectProps(expr.slice(1))
  return parsed ? ctx.schema.register(parsed.names) : null
}

/** Resolve schemaId of an expression, given a per-function schemaId map for locals.
 *  Used for both intra-function arr elem-schema observation and func.arrayElemSchema
 *  return inference. Recognizes: object literals, var names with bound schemaId,
 *  user fn calls with narrowed result schema, ?: / && / || when both branches agree. */
function exprSchemaId(expr, localSchemaMap) {
  if (typeof expr === 'string') {
    if (localSchemaMap?.has(expr)) return localSchemaMap.get(expr)
    return ctx.schema?.idOf?.(expr) ?? null
  }
  if (!Array.isArray(expr)) return null
  const op = expr[0]
  if (op === '{}') return objLiteralSchemaId(expr)
  if (op === '()' && typeof expr[1] === 'string') {
    const f = ctx.func.map?.get(expr[1])
    if (f?.valResult === VAL.OBJECT && f.sig?.ptrAux != null) return f.sig.ptrAux
    return null
  }
  if (op === '?:') {
    const a = exprSchemaId(expr[2], localSchemaMap)
    const b = exprSchemaId(expr[3], localSchemaMap)
    return a != null && a === b ? a : null
  }
  if (op === '&&' || op === '||') {
    const a = exprSchemaId(expr[1], localSchemaMap)
    const b = exprSchemaId(expr[2], localSchemaMap)
    return a != null && a === b ? a : null
  }
  return null
}

/** Extract typed-array ctor name ('new.Float32Array', 'new.Int8Array.view', etc) from RHS,
 *  or null if RHS isn't a typed-array/ArrayBuffer/DataView constructor. */
export function typedElemCtor(rhs) {
  if (!Array.isArray(rhs) || rhs[0] !== '()' || typeof rhs[1] !== 'string' || !rhs[1].startsWith('new.')) return null
  const args = rhs[2]
  const isView = rhs[1].endsWith('Array') && rhs[1] !== 'new.ArrayBuffer'
    && Array.isArray(args) && args[0] === ',' && args.length >= 4
  return isView ? rhs[1] + '.view' : rhs[1]
}

// Element-type byte mapping (mirror of module/typedarray.js ELEM). Bit 3 (|8) marks a view.
const _ELEM_AUX = {
  Int8Array: 0, Uint8Array: 1, Int16Array: 2, Uint16Array: 3,
  Int32Array: 4, Uint32Array: 5, Float32Array: 6, Float64Array: 7,
  BigInt64Array: 7, BigUint64Array: 7,
}
/** Encode a `typedElemCtor` string ('new.Int32Array' | 'new.Int32Array.view') to the 4-bit
 *  aux value used in PTR.TYPED NaN-boxing. Returns null for unknown ctors (ArrayBuffer/DataView). */
export function typedElemAux(ctor) {
  if (!ctor || !ctor.startsWith('new.')) return null
  const isView = ctor.endsWith('.view')
  const name = isView ? ctor.slice(4, -5) : ctor.slice(4)
  const et = _ELEM_AUX[name]
  if (et == null) return null
  return isView ? et | 8 : et
}
const _ELEM_NAMES = ['Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array']
/** Reverse of typedElemAux: pick a canonical ctor string for a 4-bit elem aux. Used
 *  to round-trip TYPED-narrowed call results through ctx.types.typedElem so the
 *  unboxed local's rep picks up the same aux. aux=7 is shared with BigInt typed
 *  arrays — Float64Array is canonical (read-side compares aux only). */
export function ctorFromElemAux(aux) {
  if (aux == null) return null
  const isView = (aux & 8) !== 0
  const name = _ELEM_NAMES[aux & 7]
  if (!name) return null
  return isView ? `new.${name}.view` : `new.${name}`
}

// === Cross-call argument inference helpers (used by narrowSignatures fixpoint) ===
// Each `inferArg*(expr, ...callerCtx)` resolves an argument expression to a single
// fact (val/schemaId/elem*/typedCtor) using caller-local observations and program
// facts, returning null when the fact can't be determined at this call site.

/** Infer arg val type using caller's body-local valTypes and module globals. */
export function inferArgType(expr, callerValTypes) {
  if (typeof expr === 'string') return callerValTypes?.get(expr) || ctx.scope.globalValTypes?.get(expr) || null
  return valTypeOf(expr)
}

/** Infer arg schemaId. Sources: caller's per-param schemaId map, module-level
 *  ctx.schema.vars binding, or a static-key object literal. */
export function inferArgSchema(expr, callerSchemas) {
  if (typeof expr === 'string') {
    if (callerSchemas?.has(expr)) return callerSchemas.get(expr)
    const id = ctx.schema.vars.get(expr)
    return id != null ? id : null
  }
  if (Array.isArray(expr) && expr[0] === '{}') {
    const parsed = staticObjectProps(expr.slice(1))
    return parsed ? ctx.schema.register(parsed.names) : null
  }
  return null
}

/** Infer arg arr-elem-schema. Sources: caller's body-local arr-elem map, caller's
 *  per-param arr-elem (transitive), or a call to an arr-narrowed user fn. */
export function inferArgArrElemSchema(expr, callerArrElems, callerArrParams) {
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

/** Infer arg arr-elem-VAL. Mirrors inferArgArrElemSchema but tracks VAL.* element kind. */
export function inferArgArrElemValType(expr, callerArrElemVals, callerArrValParams) {
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
export function inferArgTypedCtor(expr, callerTypedElems, callerTypedParams) {
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

// Per-body memoization: analyzeBody is a pure function of `body` plus a small
// set of ctx fields (func.locals, func.repByLocal, func.map[*][field]). compile.js
// calls slices of it many times per function (scan-fixpoint, narrowing, final
// lowering); the unified cache absorbs that traffic. Caller-mutation safety is
// preserved by cloning every Map on read (entry value stored once, copies handed out).
// Invalidation: emitFunc calls `invalidateLocalsCache` after seeding cross-call
// param facts; compile.js' E2 pass calls `invalidateValTypesCache` after valResult
// narrowing; narrowReturnArrayElems clears entries between fixpoint iters.

/**
 * Unified per-body analysis. Single AST traversal producing every per-binding
 * fact the emitter needs:
 *
 *   {
 *     locals:           Map<name, 'i32'|'f64'>     // wasm type per local
 *     valTypes:         Map<name, VAL.*>           // value-type for dispatch
 *     arrElemSchemas:   Map<name, schemaId|null>   // Array<schema> facts
 *     arrElemValTypes:  Map<name, VAL.*|null>      // Array<val-kind> facts
 *     typedElems:       Map<name, ctorString>      // typed-array ctor binding
 *   }
 *
 * Recursion shape: after a `let`/`const` decl, the rhs is walked but the `=`
 * node itself is skipped — arrElemSchemas/ValTypes have a reassignment
 * invalidation rule that would misfire on init. Other slices' `=`-visit is
 * idempotent with the decl handler, so skipping it is safe for them too.
 *
 * Forward-only observation order: every rule reads only state already produced
 * earlier in the same walk (alias chains, push observations, etc.), so a single
 * traversal is sound.
 *
 * After the walk a `widenPass` runs to widen `i32` locals compared against `f64`
 * operands.
 *
 * Caching: body-keyed via `_bodyFactsCache`. See
 * `invalidateLocalsCache` / `invalidateValTypesCache` for the invalidation hooks.
 */
const _bodyFactsCache = new WeakMap()

/**
 * Returns the cached facts object directly — DO NOT MUTATE the returned maps.
 * Callers that need to extend (e.g. add params to locals) must clone explicitly.
 * `analyzeLocals` is the canonical clone-then-extend facade; everywhere else
 * reads slices via `analyzeBody(body).<slice>`.
 */
export function analyzeBody(body) {
  // Non-object bodies (`() => 0`, `() => x`, missing) have nothing to observe
  // for any slice and can't be WeakMap-keyed. Return empty maps without caching.
  if (body === null || typeof body !== 'object') return {
    locals: new Map(), valTypes: new Map(), arrElemSchemas: new Map(),
    arrElemValTypes: new Map(), typedElems: new Map(),
  }
  const hit = _bodyFactsCache.get(body)
  if (hit) return hit

  const locals = new Map()
  const valTypes = new Map()
  const arrElemSchemas = new Map()
  const arrElemValTypes = new Map()
  const typedElems = new Map()

  const doSchemas = !!ctx.schema?.register
  // Per-walk local schema map for chained `arr.push(name)` resolution.
  const localSchemaMap = new Map()

  // === Observation helpers ===
  //
  // These trust the AST: any `arr.push(...)` syntactically present has `arr` as
  // a body-relevant name (decl, param, or global) since closure boundaries are
  // skipped at walk time. Pure typo names produce harmless dead Map entries
  // that are never queried (consumers index by known local/param names).
  // Removing the legacy `ctx.func.locals.has(arr)` filter makes analyzeBody's
  // output context-pure — cache hits don't depend on transient ctx state.

  const observeArrSchema = (arr, sid) => {
    if (!doSchemas) return
    if (typeof arr !== 'string') return
    if (arrElemSchemas.get(arr) === null) return
    if (sid == null) { arrElemSchemas.set(arr, null); return }
    if (!arrElemSchemas.has(arr)) arrElemSchemas.set(arr, sid)
    else if (arrElemSchemas.get(arr) !== sid) arrElemSchemas.set(arr, null)
  }

  const observeArrValType = (arr, vt) => {
    if (typeof arr !== 'string') return
    if (arrElemValTypes.get(arr) === null) return
    if (!vt) { arrElemValTypes.set(arr, null); return }
    if (!arrElemValTypes.has(arr)) arrElemValTypes.set(arr, vt)
    else if (arrElemValTypes.get(arr) !== vt) arrElemValTypes.set(arr, null)
  }

  const elemValOf = (name) => {
    if (typeof name !== 'string') return null
    const repVt = ctx.func.repByLocal?.get(name)?.arrayElemValType
    if (repVt) return repVt
    return arrElemValTypes.get(name) || null
  }

  const exprElemSourceVal = (expr) => {
    if (typeof expr === 'string') {
      const repVt = ctx.func.repByLocal?.get(expr)?.val
      if (repVt) return repVt
      return ctx.scope.globalValTypes?.get(expr) || null
    }
    return valTypeOf(expr)
  }

  const trackTyped = (name, rhs) => {
    const ctor = typedElemCtor(rhs)
    if (ctor) { typedElems.set(name, ctor); return }
    if (Array.isArray(rhs) && rhs[0] === '()' && typeof rhs[1] === 'string') {
      const f = ctx.func.map?.get(rhs[1])
      if (f?.sig?.ptrKind === VAL.TYPED && f.sig.ptrAux != null) {
        const c = ctorFromElemAux(f.sig.ptrAux)
        if (c) typedElems.set(name, c)
      }
    }
  }

  // === Per-decl observation (called for each `let`/`const` `name = rhs`) ===
  const processDecl = (name, rhs) => {
    // wasm type (locals slice)
    const wt = exprType(rhs, locals)
    if (!locals.has(name)) locals.set(name, wt)
    else if (locals.get(name) === 'i32' && wt === 'f64') locals.set(name, 'f64')

    // val type (valTypes slice)
    const vt = valTypeOf(rhs)
    if (vt) valTypes.set(name, vt); else valTypes.delete(name)

    // typed-array element ctor (typedElems slice)
    trackTyped(name, rhs)

    // arr-elem schema (arrElemSchemas slice) — schema bindings + array-literal init + alias + call return
    if (doSchemas) {
      const sid = exprSchemaId(rhs, localSchemaMap)
      if (sid != null) localSchemaMap.set(name, sid)
      if (Array.isArray(rhs) && rhs[0] === '[]') {
        const elems = rhs.slice(1).filter(e => e != null)
        if (elems.length) {
          let common = exprSchemaId(elems[0], localSchemaMap)
          for (let k = 1; k < elems.length && common != null; k++) {
            if (exprSchemaId(elems[k], localSchemaMap) !== common) common = null
          }
          if (common != null) observeArrSchema(name, common)
        }
      }
      if (Array.isArray(rhs) && rhs[0] === '()' && typeof rhs[1] === 'string') {
        const f = ctx.func.map?.get(rhs[1])
        if (f?.arrayElemSchema != null) observeArrSchema(name, f.arrayElemSchema)
      }
      if (typeof rhs === 'string' && arrElemSchemas.has(rhs)) {
        const sid2 = arrElemSchemas.get(rhs)
        if (sid2 != null) observeArrSchema(name, sid2)
      }
      if (typeof rhs === 'string') {
        const repSid = ctx.func.repByLocal?.get(rhs)?.arrayElemSchema
        if (repSid != null) observeArrSchema(name, repSid)
      }
    }

    // arr-elem val type (arrElemValTypes slice) — array-literal init + call return + alias + .map/.filter/.slice/.concat chain
    if (Array.isArray(rhs) && rhs[0] === '[]') {
      const elems = rhs.slice(1).filter(e => e != null)
      if (elems.length) {
        let common = exprElemSourceVal(elems[0])
        for (let k = 1; k < elems.length && common != null; k++) {
          if (exprElemSourceVal(elems[k]) !== common) common = null
        }
        if (common != null) observeArrValType(name, common)
      }
    }
    if (Array.isArray(rhs) && rhs[0] === '()' && typeof rhs[1] === 'string') {
      const f = ctx.func.map?.get(rhs[1])
      if (f?.arrayElemValType) observeArrValType(name, f.arrayElemValType)
    }
    if (typeof rhs === 'string') {
      const v = elemValOf(rhs)
      if (v) observeArrValType(name, v)
    }
    if (Array.isArray(rhs) && rhs[0] === '()' &&
        Array.isArray(rhs[1]) && rhs[1][0] === '.' &&
        typeof rhs[1][1] === 'string') {
      const recvName = rhs[1][1], method = rhs[1][2]
      if (method === 'filter' || method === 'slice' || method === 'concat') {
        const v = elemValOf(recvName)
        if (v) observeArrValType(name, v)
      } else if (method === 'map') {
        const arrowFn = rhs[2]
        const recvVt = elemValOf(recvName)
        const param = Array.isArray(arrowFn) && arrowFn[0] === '=>' ? arrowFn[1] : null
        const paramName = typeof param === 'string' ? param :
          (Array.isArray(param) && param[0] === '()' && typeof param[1] === 'string' ? param[1] : null)
        const arrowBody = paramName ? arrowFn[2] : null
        const exprBody = (Array.isArray(arrowBody) && arrowBody[0] === '{}' &&
          Array.isArray(arrowBody[1]) && arrowBody[1][0] === 'return') ? arrowBody[1][1] : arrowBody
        if (paramName && exprBody != null) {
          const refs = ctx.func.refinements
          const hadParam = refs?.has(paramName)
          const prev = hadParam ? refs.get(paramName) : undefined
          if (refs && recvVt) refs.set(paramName, recvVt)
          let bodyVt = null
          try { bodyVt = valTypeOf(exprBody) }
          finally {
            if (refs && recvVt) {
              if (hadParam) refs.set(paramName, prev); else refs.delete(paramName)
            }
          }
          if (bodyVt) observeArrValType(name, bodyVt)
        }
      }
    }
  }

  // arrElem invalidation rule — fires on `=` reassign of tracked name to non-array
  const isArrayProducingRhs = (rhs) =>
    Array.isArray(rhs) && (rhs[0] === '[]' ||
      (rhs[0] === '()' && Array.isArray(rhs[1]) && rhs[1][0] === '.' &&
       (rhs[1][2] === 'slice' || rhs[1][2] === 'concat')))

  // === Single walk ===
  function walk(node) {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>') return  // don't cross closure boundary

    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const a = node[i]
        // analyzeLocals: bare-name decl
        if (typeof a === 'string') { if (!locals.has(a)) locals.set(a, 'f64'); continue }
        if (!Array.isArray(a) || a[0] !== '=') continue
        // analyzeLocals: destructuring decl — set destructured names to f64, walk rhs only
        if (typeof a[1] !== 'string') {
          for (const n of collectParamNames([a[1]])) if (!locals.has(n)) locals.set(n, 'f64')
          walk(a[2])
          continue
        }
        const name = a[1], rhs = a[2]
        processDecl(name, rhs)
        // Walk rhs only — never enter the `=` node so the reassignment-invalidation
        // rule won't misfire on the binding's own initializer.
        walk(rhs)
      }
      return
    }

    // arr.push(...) — observe both schemas and val types in one pass
    if (op === '()' && Array.isArray(node[1]) && node[1][0] === '.' && node[1][2] === 'push' && typeof node[1][1] === 'string') {
      const arr = node[1][1]
      const callArgs = node[2]
      const list = callArgs == null ? [] :
        (Array.isArray(callArgs) && callArgs[0] === ',') ? callArgs.slice(1) : [callArgs]
      for (const a of list) {
        if (Array.isArray(a) && a[0] === '...') {
          observeArrSchema(arr, null); observeArrValType(arr, null); continue
        }
        observeArrSchema(arr, exprSchemaId(a, localSchemaMap))
        observeArrValType(arr, exprElemSourceVal(a))
      }
    }

    // `=` reassignment — locals widen, valTypes/typedElems track,
    // arrElemSchemas/ValTypes invalidate when rhs isn't array-producing.
    if (op === '=' && typeof node[1] === 'string') {
      const name = node[1], rhs = node[2]
      const wt = exprType(rhs, locals)
      if (locals.has(name) && locals.get(name) === 'i32' && wt === 'f64') locals.set(name, 'f64')
      const vt = valTypeOf(rhs)
      if (vt) valTypes.set(name, vt); else valTypes.delete(name)
      trackTyped(name, rhs)
      if (arrElemSchemas.has(name) && !isArrayProducingRhs(rhs)) observeArrSchema(name, null)
      if (arrElemValTypes.has(name) && !isArrayProducingRhs(rhs)) observeArrValType(name, null)
    }

    // compound-assign widening (locals slice)
    if ((op === '+=' || op === '-=' || op === '*=' || op === '%=') && typeof node[1] === 'string') {
      const name = node[1], opChar = op[0]
      const t = exprType([opChar, node[1], node[2]], locals)
      if (locals.has(name) && locals.get(name) === 'i32' && t === 'f64') locals.set(name, 'f64')
    }
    if (op === '/=' && typeof node[1] === 'string') {
      if (locals.has(node[1])) locals.set(node[1], 'f64')
    }

    for (let i = 1; i < node.length; i++) walk(node[i])
  }

  // Install the in-progress valTypes as a lookup overlay so successive decls
  // resolve chains (`const a = new TypedArr(); const b = a[0]` → b: NUMBER)
  // and shorthand-bound `{a}` props see a's type. Restored after walk completes.
  const prevOverlay = ctx.func.localValTypesOverlay
  ctx.func.localValTypesOverlay = valTypes
  try { walk(body) } finally { ctx.func.localValTypesOverlay = prevOverlay }

  // Second pass: widen i32 locals compared against f64.
  const CMP_OPS = new Set(['<', '>', '<=', '>=', '==', '!='])
  function widenPass(node) {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (CMP_OPS.has(op)) {
      const [a, b] = args
      const ta = exprType(a, locals), tb = exprType(b, locals)
      if (ta === 'i32' && tb === 'f64' && typeof a === 'string' && locals.has(a)) locals.set(a, 'f64')
      if (tb === 'i32' && ta === 'f64' && typeof b === 'string' && locals.has(b)) locals.set(b, 'f64')
    }
    if (op !== '=>') for (const a of args) widenPass(a)
  }
  widenPass(body)

  const result = { locals, valTypes, arrElemSchemas, arrElemValTypes, typedElems }
  _bodyFactsCache.set(body, result)
  return result
}

/** Drop the cached analyzeBody entry for this body. Used by emitFunc after
 *  seeding cross-call param VAL facts so the next walk picks up fresh
 *  `ctx.func.repByLocal` (drives exprType receiver-type lookups).
 *  Same hook as `invalidateValTypesCache` — split names preserve caller intent. */
export function invalidateLocalsCache(body) {
  if (body && typeof body === 'object') _bodyFactsCache.delete(body)
}

/** Drop the cached analyzeBody entry. Used after E2-phase valResult narrowing
 *  so the next walk re-evaluates `valTypeOf(call)` with up-to-date `f.valResult`
 *  — required for the D-pass paramReps val/arrayElemSchema re-fixpoint to see
 *  `const rows = initRows()` as VAL.ARRAY (initRows.valResult set by E2). */
export function invalidateValTypesCache(body) {
  if (body && typeof body === 'object') _bodyFactsCache.delete(body)
}

/**
 * Analyze all local value types from declarations and assignments.
 * Writes the per-name `val` field of `ctx.func.repByLocal` for method dispatch
 * and schema resolution.
 */
export function analyzeValTypes(body) {
  const setVal = (name, vt) => updateRep(name, { val: vt || undefined })
  const getVal = name => ctx.func.repByLocal?.get(name)?.val
  // Pre-walk: observe Array<schema> facts so `const p = arr[i]` can bind a schemaId
  // on `p`, unlocking schema slot reads + skipping str_key dispatch on `.prop` access.
  // Parallel arrElemValTypes walk records VAL.* element kinds into
  // rep.arrayElemValType so valTypeOf's `arr[i]` rule can elide __to_num and route
  // method dispatch on `arr[i].method()`. Both come from a single unified walk.
  const facts = analyzeBody(body)
  const arrElems = facts.arrElemSchemas
  for (const [name, vt] of facts.arrElemValTypes) {
    if (vt != null) updateRep(name, { arrayElemValType: vt })
  }
  // Resolve a name's array-elem-schema, preferring rep.arrayElemSchema (set from
  // paramReps[k].arrayElemSchema at emit start) over local body observations.
  const arrElemSchemaOf = (name) => {
    if (typeof name !== 'string') return null
    const repSid = ctx.func.repByLocal?.get(name)?.arrayElemSchema
    if (repSid != null) return repSid
    const localSid = arrElems.get(name)
    return localSid != null ? localSid : null
  }
  function trackRegex(name, rhs) {
    if (ctx.runtime.regex && Array.isArray(rhs) && rhs[0] === '//') ctx.runtime.regex.vars.set(name, rhs)
  }
  function trackTyped(name, rhs) {
    if (!ctx.types.typedElem) ctx.types.typedElem = new Map() // first use in this function scope
    const ctor = typedElemCtor(rhs)
    if (ctor) { ctx.types.typedElem.set(name, ctor); return }
    // TYPED-narrowed call result carries elem aux on f.sig.ptrAux — reverse-map it
    // back to a canonical ctor string so analyzePtrUnboxable's typedElemAux lookup
    // (compile.js) restores the same aux on the unboxed local's rep.
    if (Array.isArray(rhs) && rhs[0] === '()' && typeof rhs[1] === 'string') {
      const f = ctx.func.map?.get(rhs[1])
      if (f?.sig?.ptrKind === VAL.TYPED && f.sig.ptrAux != null) {
        const ctor = ctorFromElemAux(f.sig.ptrAux)
        if (ctor) ctx.types.typedElem.set(name, ctor)
      }
    }
  }
  function walk(node) {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') return  // don't leak inner-closure val types
    // Propagate typed array type through method calls (e.g. buf.map → typed)
    function propagateTyped(name, rhs) {
      if (!Array.isArray(rhs) || rhs[0] !== '()') return
      const callee = rhs[1]
      if (!Array.isArray(callee) || callee[0] !== '.') return
      const src = callee[1], method = callee[2]
      if (typeof src === 'string' && getVal(src) === VAL.TYPED && method === 'map') {
        setVal(name, VAL.TYPED)
        if (ctx.types.typedElem?.has(src)) {
          const srcCtor = ctx.types.typedElem.get(src)
          ctx.types.typedElem.set(name, srcCtor.endsWith('.view') ? srcCtor.slice(0, -5) : srcCtor)
        }
      }
    }
    if (op === 'let' || op === 'const') {
      for (const a of args) {
        if (!Array.isArray(a) || a[0] !== '=' || typeof a[1] !== 'string') continue
        const vt = valTypeOf(a[2])
        setVal(a[1], vt)
        if (vt === VAL.REGEX) trackRegex(a[1], a[2])
        if (vt === VAL.TYPED || vt === VAL.BUFFER) trackTyped(a[1], a[2])
        propagateTyped(a[1], a[2])
        // JSON-shape propagation. When the RHS resolves to a known JSON shape
        // (root: `JSON.parse(literal)`; nested: `o.meta`, `items[j]` from a known
        // root), record it on the binding so subsequent `.prop`/`[i]` accesses
        // skip dynamic dispatch and propagate VAL kinds. Generic for any
        // compile-time JSON literal.
        const sh = shapeOf(a[2])
        if (sh) {
          updateRep(a[1], { jsonShape: sh })
          if (sh.vt === VAL.ARRAY && sh.elem?.vt) {
            updateRep(a[1], { arrayElemValType: sh.elem.vt })
          }
        }
        // Propagate schemaId from a narrowed call result so subsequent valTypeOf
        // calls in this function body see the precise schema. emitDecl rebinds
        // this at emission time too — analyze-time binding is what unlocks the
        // slotVT lookup chain in `analyzeValTypes`'s own walk + per-func emit
        // dispatch reading repByLocal.
        if (vt === VAL.OBJECT && Array.isArray(a[2]) && a[2][0] === '()' && typeof a[2][1] === 'string') {
          const f = ctx.func.map?.get(a[2][1])
          if (f?.sig?.ptrAux != null) updateRep(a[1], { schemaId: f.sig.ptrAux })
        }
        // `const p = arr[i]` — when arr's element schema is known (from .push observations
        // or from paramReps arrayElemSchema binding), p inherits the schema. Unlocks slotVT-driven
        // numeric typing on `.prop` reads + slot-direct loads.
        if (Array.isArray(a[2]) && a[2][0] === '[]' && typeof a[2][1] === 'string') {
          const elemSid = arrElemSchemaOf(a[2][1])
          if (elemSid != null) {
            updateRep(a[1], { schemaId: elemSid })
            // Also set the val so structural call dispatch + valTypeOf see VAL.OBJECT.
            setVal(a[1], VAL.OBJECT)
          }
        }
      }
    }
    if (op === '=' && typeof args[0] === 'string') {
      const vt = valTypeOf(args[1])
      setVal(args[0], vt)
      if (vt === VAL.REGEX) trackRegex(args[0], args[1])
      if (vt === VAL.TYPED || vt === VAL.BUFFER) trackTyped(args[0], args[1])
      propagateTyped(args[0], args[1])
    }
    // Track property assignments for auto-boxing: x.prop = val
    if (op === '=' && Array.isArray(args[0]) && args[0][0] === '.' && typeof args[0][1] === 'string') {
      const [, obj, prop] = args[0]
      const vt = getVal(obj)
      if ((vt === VAL.NUMBER || vt === VAL.BIGINT) && ctx.func.locals?.has(obj) && ctx.schema.register) {
        if (!ctx.func.localProps) ctx.func.localProps = new Map()
        if (!ctx.func.localProps.has(obj)) ctx.func.localProps.set(obj, new Set())
        ctx.func.localProps.get(obj).add(prop)
      }
    }
    for (const a of args) walk(a)
  }
  walk(body)

  // Register boxed schemas for local variables with property assignments
  if (ctx.func.localProps) {
    for (const [name, props] of ctx.func.localProps) {
      if (ctx.schema.vars.has(name)) continue
      const schema = ['__inner__', ...props]
      const sid = ctx.schema.register(schema)
      ctx.schema.vars.set(name, sid)
      updateRep(name, { schemaId: sid })
    }
  }
}

const INT_BIT_OPS = new Set(['|', '&', '^', '~', '<<', '>>', '>>>'])
const INT_CMP_OPS = new Set(['<', '>', '<=', '>=', '==', '!=', '===', '!==', '!'])
const INT_CLOSED_OPS = new Set(['+', '-', '*', '%'])
const INT_MATH_FNS = new Set(['imul', 'clz32', 'floor', 'ceil', 'round', 'trunc'])

/**
 * Forward-propagate `intCertain` across local bindings (S2 Stage 4a — pure analysis).
 *
 * A binding is `intCertain` iff every defining RHS evaluates to an integer-valued
 * expression. Reassignments widen — any non-int RHS poisons the binding, regardless
 * of order in source. Multi-pass fixpoint converges when RHSs read other bindings
 * transitively (`let j = i + 1` resolves only after `i` is known intCertain).
 *
 * Integer-shaped RHS (closed under composition):
 *   - integer Number literal, boolean literal
 *   - bitwise ops `& | ^ ~ << >> >>>` — i32 result by spec
 *   - comparisons `< > <= >= == != === !== !` — 0/1 result
 *   - `.length` / `.byteLength` on TYPED/ARRAY/STRING/BUFFER receiver
 *   - `+ - * %` and unary `+ -` of intCertain operands (overflow OK — value is mathematically integer)
 *   - `?: && ||` when both branches are intCertain
 *   - `Math.{imul, clz32, floor, ceil, round, trunc}`
 *   - self-mutation ops `++` `--` `+=` `-=` `*=` `%=` (preserve when operand is int);
 *     `&= |= ^= <<= >>= >>>=` (always int by op result type);
 *     `/=` `**=` poison.
 *
 * Writes `intCertain: true` on `ctx.func.repByLocal[name]`. No emit impact —
 * codegen extensions consume this in follow-up passes.
 */
export function analyzeIntCertain(body) {
  // Pass 1: collect every defining RHS per binding name. Compound assignments
  // are desugared to their `=` equivalent (`x += y` → `x = x + y`) so the
  // existing `isIntExpr` op rules apply uniformly.
  const defs = new Map()
  const pushDef = (name, rhs) => {
    let list = defs.get(name)
    if (!list) { list = []; defs.set(name, list) }
    list.push(rhs)
  }
  const collect = (node) => {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') return
    if (op === 'let' || op === 'const') {
      for (const a of args) {
        if (Array.isArray(a) && a[0] === '=' && typeof a[1] === 'string') pushDef(a[1], a[2])
      }
    } else if (op === '=' && typeof args[0] === 'string') {
      pushDef(args[0], args[1])
    } else if (typeof op === 'string' && op.length > 1 && op.endsWith('=') &&
               !INT_CMP_OPS.has(op) && op !== '=>' && typeof args[0] === 'string') {
      // Compound assign: desugar `x <op>= rhs` → `x = x <op> rhs`. The base op
      // result is fed back through isIntExpr — bitwise compounds become int by
      // the bitwise rule; +=/-=/*=/%= preserve via int-closed rule.
      pushDef(args[0], [op.slice(0, -1), args[0], args[1]])
    } else if ((op === '++' || op === '--') && typeof args[0] === 'string') {
      // `x++` / `x--` desugars to `x = x ± 1`. 1 is int → preserves intCertain.
      pushDef(args[0], [op === '++' ? '+' : '-', args[0], [null, 1]])
    }
    for (const a of args) collect(a)
  }
  collect(body)
  if (defs.size === 0) return

  // Pass 2: monotone-down fixpoint. Start optimistic (every defined binding
  // assumed intCertain), then for each iteration mark false any binding whose
  // RHS list contains a non-int expression. Once false, stays false — defs is
  // fixed and isIntExpr only reads back through bindings that themselves can
  // only flip true→false. Converges when no further bindings flip.
  //
  // (Naive bottom-up `false→true` direction is unsound for recursive bindings
  // like `let i = 0; i = i + 1` — first iteration sees i unobserved → false →
  // i+1 false → i stays false, missing the fact that all RHSs are int.)
  const intCertain = new Map()
  for (const name of defs.keys()) intCertain.set(name, true)

  const isIntExpr = (expr) => {
    if (typeof expr === 'number') return Number.isInteger(expr)
    if (typeof expr === 'boolean') return true
    if (typeof expr === 'string') return intCertain.get(expr) === true
    if (!Array.isArray(expr)) return false
    const [op, ...args] = expr
    if (op == null) {
      // `[, value]` / `[null, value]` literal form
      const v = args[0]
      if (typeof v === 'number') return Number.isInteger(v)
      if (typeof v === 'boolean') return true
      return false
    }
    if (INT_BIT_OPS.has(op) || INT_CMP_OPS.has(op)) return true
    if (op === '.') {
      if ((args[1] === 'length' || args[1] === 'byteLength') && typeof args[0] === 'string') {
        const vt = lookupValType(args[0])
        return vt === VAL.TYPED || vt === VAL.ARRAY || vt === VAL.STRING || vt === VAL.BUFFER
      }
      if (args[1] === 'size' && typeof args[0] === 'string') {
        const vt = lookupValType(args[0])
        return vt === VAL.SET || vt === VAL.MAP
      }
      return false
    }
    if (INT_CLOSED_OPS.has(op)) {
      const a = isIntExpr(args[0])
      const b = args[1] != null ? isIntExpr(args[1]) : a
      return a && b
    }
    if (op === 'u-' || op === 'u+') return isIntExpr(args[0])
    if (op === '?:') return isIntExpr(args[1]) && isIntExpr(args[2])
    if (op === '&&' || op === '||') return isIntExpr(args[0]) && isIntExpr(args[1])
    // Math.{imul,clz32,floor,ceil,round,trunc} — prepare normalizes the callee to
    // the string `math.<fn>`. The pre-prepare `['.', 'Math', '<fn>']` shape is
    // matched too so this analyzer is robust if invoked on a non-normalized AST.
    if (op === '()') {
      const c = args[0]
      if (typeof c === 'string' && c.startsWith('math.') && INT_MATH_FNS.has(c.slice(5))) return true
      if (Array.isArray(c) && c[0] === '.' && c[1] === 'Math' && INT_MATH_FNS.has(c[2])) return true
    }
    return false
  }

  let changed = true
  while (changed) {
    changed = false
    for (const [name, rhsList] of defs) {
      if (!intCertain.get(name)) continue
      if (!rhsList.every(isIntExpr)) { intCertain.set(name, false); changed = true }
    }
  }

  for (const [name, intC] of intCertain) {
    if (intC) updateRep(name, { intCertain: true })
  }
}

/**
 * Infer expression result type from AST (without emitting).
 * Used to determine local variable types before compilation.
 * Looks up `locals` first, then current-function params (for i32-specialized params).
 */
export function exprType(expr, locals) {
  if (expr == null) return 'f64'
  if (typeof expr === 'number')
    return Number.isInteger(expr) && expr >= -2147483648 && expr <= 2147483647 ? 'i32' : 'f64'
  if (typeof expr === 'string') {
    if (locals?.has?.(expr)) return locals.get(expr)
    const paramType = ctx.func.current?.params?.find(p => p.name === expr)?.type
    if (paramType) return paramType
    return 'f64'
  }
  if (!Array.isArray(expr)) return 'f64'

  const [op, ...args] = expr
  if (op == null) return exprType(args[0], locals) // literal [, value]

  // Always f64
  if (op === '/' || op === '**' || op === '[' || op === '[]' || op === '{}' || op === 'str') return 'f64'
  // `.length` on a known sized receiver returns i32 directly (__len/__str_byteLen
  // both return i32). Letting it stay i32 lets analyzeLocals keep the counter
  // local i32 too, eliminating the per-iteration `f64.convert_i32_s` widen and
  // the matching `i32.trunc_sat_f64_s` truncs at every `arr[i]` / `i*k` site.
  // Only safe when receiver type is statically known to expose an integer length.
  if (op === '.') {
    if (args[1] === 'length' && typeof args[0] === 'string') {
      const vt = lookupValType(args[0])
      if (vt === VAL.TYPED || vt === VAL.ARRAY || vt === VAL.STRING || vt === VAL.BUFFER) return 'i32'
    }
    if (args[1] === 'size' && typeof args[0] === 'string') {
      const vt = lookupValType(args[0])
      if (vt === VAL.SET || vt === VAL.MAP) return 'i32'
    }
    if (args[1] === 'byteLength' && typeof args[0] === 'string') {
      const vt = lookupValType(args[0])
      if (vt === VAL.BUFFER || vt === VAL.TYPED) return 'i32'
    }
    return 'f64'
  }
  // Always i32
  if (['>', '<', '>=', '<=', '==', '!=', '!', '&', '|', '^', '~', '<<', '>>', '>>>'].includes(op)) return 'i32'
  // Preserve i32 if both operands i32
  if (['+', '-', '*', '%'].includes(op)) {
    const ta = exprType(args[0], locals)
    const tb = args[1] != null ? exprType(args[1], locals) : ta // unary: inherit
    return ta === 'i32' && tb === 'i32' ? 'i32' : 'f64'
  }
  // Unary preserves type
  if (op === 'u-' || op === 'u+') return exprType(args[0], locals)
  // Ternary / logical: conciliate
  if (op === '?:' || op === '&&' || op === '||') {
    const branches = op === '?:' ? [args[1], args[2]] : [args[0], args[1]]
    const ta = exprType(branches[0], locals), tb = exprType(branches[1], locals)
    return ta === 'i32' && tb === 'i32' ? 'i32' : 'f64'
  }
  if (op === '[') return 'f64'
  // Builtin calls with known i32 result. Math.imul / Math.clz32 always produce
  // a 32-bit integer; recognising this here keeps `let x = Math.imul(...)` (and
  // chains like `x = Math.imul(x, k) + 12345`) on the i32 ABI all the way
  // through, instead of widening the local to f64 because exprType defaulted.
  if (op === '()') {
    if (args[0] === 'math.imul' || args[0] === 'math.clz32') return 'i32'
    // Method calls returning i32: charCodeAt → byte (0..255). Lets tokenizer-shape
    // hot loops keep `c` as i32 across `c >= 48 && c <= 57`, `c - 48`, etc.,
    // skipping the f64.convert_i32_u widen at every char read.
    if (Array.isArray(args[0]) && args[0][0] === '.' && args[0][2] === 'charCodeAt') return 'i32'
    // User-function call: consult the callee's narrowed result type. By the time
    // analyzeLocals runs in emitFunc, narrowSignatures has set sig.results[0]='i32'
    // on every body-i32-only func. Propagating this lets `let h = userFn(...)`
    // (mix in callback bench: i32-FNV) keep h as an i32 local instead of widening
    // to f64 and round-tripping i32↔f64 every iteration.
    if (typeof args[0] === 'string') {
      const f = ctx.func.map?.get(args[0])
      if (f?.sig?.results?.length === 1 && f.sig.results[0] === 'i32' && f.sig.ptrKind == null) return 'i32'
    }
  }
  return 'f64'
}

/**
 * Analyze all local declarations and assignments to determine types.
 * A local is i32 if ALL assignments produce i32. Any f64 widens to f64.
 *
 * Thin slice of `analyzeBody` (single unified walk).
 */
export function analyzeLocals(body) {
  return analyzeBody(body).locals
}

/**
 * Identify locals that can be stored as an unboxed i32 pointer offset instead of
 * a NaN-boxed f64. Static type is tracked out-of-band so reads skip `__ptr_offset`
 * and `__ptr_type` entirely and writes unbox once at the assignment site.
 *
 * Criteria — the local must be:
 *   - declared once with `let`/`const`, never reassigned or compound-assigned
 *   - valType is an unambiguous non-forwarding pointer kind:
 *       OBJECT, SET, MAP, CLOSURE, TYPED, BUFFER
 *     (excluded: ARRAY — forwards on realloc; STRING — SSO/heap dual encoding.)
 *   - initialized from a form that guarantees a fresh, non-null pointer of that VAL:
 *       OBJECT ← `{…}`
 *       SET    ← `new Set(...)`
 *       MAP    ← `new Map(...)`
 *       CLOSURE← `=>` literal
 *       BUFFER ← `new ArrayBuffer(...)` / `new DataView(...)`
 *       TYPED  ← `new XxxArray(...)` / method returning typed array
 *   - not captured in boxed storage (boxed locals stay f64 for the heap slot)
 *   - never compared to null/undefined (we lose the nullish NaN representation)
 *
 * Returns Map<name, VAL> of locals to unbox.
 */
export function analyzePtrUnboxable(body, locals, boxed) {
  const candidates = new Set()
  const disqualified = new Set()
  const valOf = name => ctx.func.repByLocal?.get(name)?.val

  const UNBOXABLE_KINDS = new Set([VAL.OBJECT, VAL.SET, VAL.MAP, VAL.BUFFER, VAL.TYPED, VAL.CLOSURE])

  // RHS must produce a fresh, non-null pointer of the declared VAL kind.
  //   OBJECT  ← `{…}`
  //   CLOSURE ← `=>`
  //   SET/MAP/BUFFER/TYPED ← `new X(...)`
  // Validating the exact ctor→VAL match keeps the analysis tied to valTypeOf, so when
  // that helper grows (e.g. `Array.from` → ARRAY), we don't drift out of sync.
  const isFreshInit = (expr, kind) => {
    if (!Array.isArray(expr)) return false
    if (kind === VAL.OBJECT) {
      if (expr[0] === '{}') return true
      // Call to a narrow-ABI'd helper: returns i32 ptr-offset of the same VAL kind.
      // Unboxing skips the f64-rebox at the callsite. Verifying via sig (not just
      // valResult) ensures the call already produces an i32 — which dual-write picks
      // up to bind ptrKind/schemaId on the local.
      if (expr[0] === '()' && typeof expr[1] === 'string') {
        const f = ctx.func.map?.get(expr[1])
        return f?.sig?.ptrKind === kind
      }
      // `let p = arr[i]` where arr has a known elem schema: the runtime helper
      // returns f64 (NaN-box of an OBJECT pointer), but its low 32 bits are
      // exactly the pointer offset. Dual-write coerces once via reinterpret/wrap;
      // subsequent `p.x` reads then become direct `f64.load offset=K (local.get $p)`
      // (since ptrOffsetIR sees ptrKind=OBJECT and skips the per-access wrap).
      if (expr[0] === '[]' && typeof expr[1] === 'string') {
        const repSid = ctx.func.repByLocal?.get(expr[1])?.arrayElemSchema
        return repSid != null
      }
      return false
    }
    if (kind === VAL.CLOSURE) return expr[0] === '=>'
    if (expr[0] === '()' && typeof expr[1] === 'string') {
      const callee = expr[1]
      if (callee.startsWith('new.')) {
        if (kind === VAL.SET) return callee === 'new.Set'
        if (kind === VAL.MAP) return callee === 'new.Map'
        if (kind === VAL.BUFFER) return callee === 'new.ArrayBuffer' || callee === 'new.DataView'
        if (kind === VAL.TYPED) return callee.endsWith('Array') && callee !== 'new.ArrayBuffer'
      }
      // Call to narrow-ABI'd helper of matching VAL kind.
      const f = ctx.func.map?.get(callee)
      if (f?.sig?.ptrKind === kind) return true
    }
    // Method call returning TYPED: `arr.map(fn)` where `arr` is in typedElem
    // (locally TYPED with a known elem ctor). Only `.typed:map` is registered
    // as TYPED-returning — `.filter`/`.slice` fall back to ARRAY emit. The
    // typedElem.has(src) gate ensures we don't accept the polymorphic-receiver
    // path that emits a plain ARRAY result. propagateTyped already mirrored
    // the src ctor onto the receiver, so the unbox path picks up its aux.
    if (kind === VAL.TYPED && expr[0] === '()' &&
        Array.isArray(expr[1]) && expr[1][0] === '.' &&
        typeof expr[1][1] === 'string' && expr[1][2] === 'map' &&
        ctx.types.typedElem?.has(expr[1][1])) {
      return true
    }
    return false
  }
  const isNullishLit = (expr) =>
    expr === 'null' || expr === 'undefined' ||
    (Array.isArray(expr) && expr[0] == null &&
      (expr[1] === null || expr[1] === undefined))

  function collect(node) {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') return
    if (op === 'let' || op === 'const') {
      for (const a of args) {
        if (!Array.isArray(a) || a[0] !== '=' || typeof a[1] !== 'string') continue
        const name = a[1]
        const vt = valOf(name)
        if (!UNBOXABLE_KINDS.has(vt)) continue
        if (locals.get(name) !== 'f64') continue
        if (boxed?.has(name)) continue
        if (!isFreshInit(a[2], vt)) continue
        candidates.add(name)
      }
    }
    for (const a of args) collect(a)
  }

  const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
    '<<=', '>>=', '>>>=', '||=', '&&=', '??='])
  const NULL_CMP_OPS = new Set(['==', '!=', '===', '!=='])

  function check(node) {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') return
    if (ASSIGN_OPS.has(op) && typeof args[0] === 'string' && candidates.has(args[0])) {
      if (op !== '=') disqualified.add(args[0])
      // Initial `let x = {…}` arrives here too as op='='; the `let` pass already vetted it.
      // A later `x = …` in the same body is a re-assignment — disqualify unless it's the init.
      // We detect by tracking count: if we see '=' twice for the same name, disqualify.
    }
    if ((op === '++' || op === '--') && typeof args[0] === 'string' && candidates.has(args[0]))
      disqualified.add(args[0])
    if (NULL_CMP_OPS.has(op)) {
      for (let i = 0; i < 2; i++) {
        const side = args[i], other = args[1 - i]
        if (typeof side === 'string' && candidates.has(side) && isNullishLit(other)) disqualified.add(side)
      }
    }
    for (const a of args) check(a)
  }

  // Count bare `=` assignments per candidate. Init `let x = …` is NOT parsed as `['=', x, …]`
  // at the statement level — it's inside `['let', ['=', x, …]]`. A standalone `['=', x, …]`
  // at statement level IS a reassignment.
  const assignCount = new Map()
  function countAssigns(node, inLet) {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') return
    if (op === '=' && !inLet && typeof args[0] === 'string' && candidates.has(args[0])) {
      assignCount.set(args[0], (assignCount.get(args[0]) || 0) + 1)
    }
    const childInLet = op === 'let' || op === 'const'
    for (const a of args) countAssigns(a, childInLet)
  }

  collect(body)
  check(body)
  countAssigns(body, false)

  for (const [name, count] of assignCount) if (count > 0) disqualified.add(name)

  const result = new Map()
  for (const name of candidates) if (!disqualified.has(name)) result.set(name, valOf(name))
  return result
}

// === Param / closure helpers ===

export function extractParams(rawParams) {
  let p = rawParams
  if (Array.isArray(p) && p[0] === '()') p = p[1]
  return p == null ? [] : Array.isArray(p) ? (p[0] === ',' ? p.slice(1) : [p]) : [p]
}

export function classifyParam(r) {
  if (Array.isArray(r) && r[0] === '...') return { kind: 'rest', name: r[1] }
  if (Array.isArray(r) && r[0] === '=') {
    if (typeof r[1] === 'string') return { kind: 'default', name: r[1], defValue: r[2] }
    return { kind: 'destruct-default', pattern: r[1], defValue: r[2] }
  }
  if (Array.isArray(r) && (r[0] === '[]' || r[0] === '{}')) return { kind: 'destruct', pattern: r }
  return { kind: 'plain', name: r }
}

export function collectParamNames(raw, out = new Set()) {
  for (const r of raw) {
    if (typeof r === 'string') out.add(r)
    else if (Array.isArray(r)) {
      if (r[0] === '=' && typeof r[1] === 'string') out.add(r[1])
      else if (r[0] === '...' && typeof r[1] === 'string') out.add(r[1])
      else if (r[0] === '=' && Array.isArray(r[1])) collectParamNames([r[1]], out)
      else if (r[0] === '[]' || r[0] === '{}' || r[0] === ',') collectParamNames(r.slice(1), out)
    }
  }
  return out
}

/** Find free variables in AST: referenced in node, not in `bound`, present in `scope`. */
export function findFreeVars(node, bound, free, scope) {
  if (node == null) return
  if (typeof node === 'string') {
    if (bound.has(node) || free.includes(node)) return
    const inScope = scope
      ? scope.has(node)
      : (ctx.func.locals?.has(node) || ctx.func.current?.params.some(p => p.name === node))
    if (inScope) free.push(node)
    return
  }
  if (!Array.isArray(node)) return
  const [op, ...args] = node
  if (op === '=>') {
    const innerBound = collectParamNames(extractParams(args[0]), new Set(bound))
    findFreeVars(args[1], innerBound, free, scope)
    return
  }
  if (op === 'let' || op === 'const') {
    collectParamNames(args, bound)
    if (scope) collectParamNames(args, scope)
  }
  if (op === 'for' && Array.isArray(args[0]) && (args[0][0] === 'let' || args[0][0] === 'const')) {
    collectParamNames(args[0].slice(1), bound)
    if (scope) collectParamNames(args[0].slice(1), scope)
  }
  for (const a of args) findFreeVars(a, bound, free, scope)
}

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '>>=', '<<=', '>>>=', '||=', '&&=', '??='])

/** Check if any of the given variable names are assigned anywhere in the AST. */
export function findMutations(node, names, mutated) {
  if (node == null || typeof node !== 'object' || !Array.isArray(node)) return
  const [op, ...args] = node
  if (op === 'let' || op === 'const') {
    for (const decl of args)
      if (Array.isArray(decl) && decl[0] === '=') findMutations(decl[2], names, mutated)
    return
  }
  if (ASSIGN_OPS.has(op) && typeof args[0] === 'string' && names.has(args[0]))
    mutated.add(args[0])
  if ((op === '++' || op === '--') && typeof args[0] === 'string' && names.has(args[0]))
    mutated.add(args[0])
  for (const a of args) findMutations(a, names, mutated)
}

/**
 * Pre-scan AST for variables that need a `__dyn_props` shadow sidecar.
 *
 * The shadow exists so `obj[runtimeKey]` can read a value via `__dyn_get`,
 * and `obj.prop = v` keeps the sidecar in sync. Most object literals are only
 * accessed via `.prop` or `obj['lit']`, both of which resolve through the
 * schema directly and bypass the shadow. Allocating + populating the sidecar
 * for those literals is pure waste.
 *
 * Populates:
 *  - ctx.types.dynKeyVars: Set<string> — names accessed via runtime key
 *  - ctx.types.anyDynKey: boolean — any dynamic key access exists in program
 *    (used for escaping literals where no target var is known)
 */
export function analyzeDynKeys(...roots) {
  const dynVars = new Set()
  let anyDyn = false

  function walk(node) {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '[]') {
      const [obj, idx] = args
      if (!isLiteralStr(idx)) {
        anyDyn = true
        if (typeof obj === 'string') dynVars.add(obj)
      }
    }
    // Runtime for-in (compile-time unroll didn't fire) → walks via shadow
    if (op === 'for-in') {
      anyDyn = true
      if (typeof args[1] === 'string') dynVars.add(args[1])
    }
    for (const a of args) walk(a)
  }
  for (const r of roots) walk(r)
  if (ctx.func.list) for (const f of ctx.func.list) if (f.body) walk(f.body)
  const initFacts = ctx.module.initFacts
  if (initFacts?.anyDyn) {
    anyDyn = true
    for (const v of initFacts.dynVars) dynVars.add(v)
  }

  ctx.types.dynKeyVars = dynVars
  ctx.types.anyDynKey = anyDyn
}

/**
 * Pre-scan function body for captured variables that are mutated.
 * Marks mutably-captured vars in ctx.func.boxed for cell-based capture.
 */
export function analyzeBoxedCaptures(body) {
  const outerScope = new Set()
  ;(function collectDecls(node) {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') return
    if (op === 'let' || op === 'const')
      for (const a of args)
        if (Array.isArray(a) && a[0] === '=' && typeof a[1] === 'string') outerScope.add(a[1])
    for (const a of args) collectDecls(a)
  })(body)
  if (ctx.func.current?.params) for (const p of ctx.func.current.params) outerScope.add(p.name)
  if (ctx.func.locals) for (const k of ctx.func.locals.keys()) outerScope.add(k)

  ;(function walk(node, assignTarget) {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') {
      let p = args[0]
      if (Array.isArray(p) && p[0] === '()') p = p[1]
      const raw = p == null ? [] : Array.isArray(p) ? (p[0] === ',' ? p.slice(1) : [p]) : [p]
      const paramSet = new Set(raw.map(r => Array.isArray(r) && r[0] === '...' ? r[1] : r))
      const captures = []
      findFreeVars(args[1], paramSet, captures, outerScope)
      if (captures.length === 0) return
      const captureSet = new Set(captures)
      const mutated = new Set()
      findMutations(body, captureSet, mutated)
      if (assignTarget && captureSet.has(assignTarget)) mutated.add(assignTarget)
      for (const v of mutated) if (!ctx.func.boxed.has(v)) ctx.func.boxed.set(v, `${T}cell_${v}`)
      return
    }
    if (op === '=' && typeof args[0] === 'string' && Array.isArray(args[1]) && args[1][0] === '=>')
      return walk(args[1], args[0])
    for (const a of args) walk(a)
  })(body)
}

/**
 * Narrow return arr-elem-{schema|valType}: for each non-exported, non-value-used
 * user func with `valResult === VAL.ARRAY` and `func[field] == null`, walk return
 * exprs (and trailing-fallthrough literal), resolve each via body-local elem map
 * + caller-param facts + transitive user-fn results, and if all agree set `func[field]`.
 * Lets callers' `const rows = initRows()` gain the elem fact, propagating to
 * runKernel params via paramReps. `field` selects which fact ('arrayElemSchema'
 * | 'arrayElemValType') — slice key is derived.
 */
const _FIELD_TO_SLICE = {
  arrayElemSchema: 'arrElemSchemas',
  arrayElemValType: 'arrElemValTypes',
}
export function narrowReturnArrayElems(field, paramReps, valueUsed) {
  const sliceKey = _FIELD_TO_SLICE[field]
  const targets = ctx.func.list.filter(f =>
    !f.raw && !f.exported && !valueUsed.has(f.name) &&
    f.valResult === VAL.ARRAY && f[field] == null
  )
  let changed = true
  while (changed) {
    changed = false
    // Cache-staleness barrier: the fixpoint mutates target funcs' [field]
    // between iterations. analyzeBody reads ctx.func.map[*][field] when
    // resolving `const x = callee()` and similar chains, so any cached entry
    // from a prior iter would freeze cross-func propagation. Clear all target
    // bodies before each sweep.
    for (const f of targets) _bodyFactsCache.delete(f.body)
    for (const func of targets) {
      if (func[field] != null) continue
      const isBlock = isBlockBody(func.body)
      if (isBlock && !alwaysReturns(func.body)) continue
      const exprs = returnExprs(func.body)
      if (!exprs.length) continue
      // analyzeBody is context-pure for the arrElem slices, so a single walk
      // gives both `locals` (for ctx.func.locals seeding — observe filter for
      // param-aware downstream consumers) and the requested slice.
      const savedLocals = ctx.func.locals
      const facts = analyzeBody(func.body)
      ctx.func.locals = new Map(facts.locals)
      for (const p of func.sig.params) if (!ctx.func.locals.has(p.name)) ctx.func.locals.set(p.name, p.type)
      const localElems = facts[sliceKey]
      ctx.func.locals = savedLocals
      const paramElemMap = callerParamFactMap(paramReps, func, field) || new Map()
      const resolveExpr = (expr) => {
        if (typeof expr === 'string') {
          if (localElems.has(expr)) {
            const v = localElems.get(expr)
            if (v != null) return v
          }
          if (paramElemMap.has(expr)) return paramElemMap.get(expr)
          return null
        }
        if (Array.isArray(expr) && expr[0] === '()' && typeof expr[1] === 'string') {
          const f = ctx.func.map?.get(expr[1])
          if (f?.[field] != null) return f[field]
        }
        if (Array.isArray(expr) && expr[0] === '?:') {
          const a = resolveExpr(expr[2]), b = resolveExpr(expr[3])
          return a != null && a === b ? a : null
        }
        if (Array.isArray(expr) && (expr[0] === '&&' || expr[0] === '||')) {
          const a = resolveExpr(expr[1]), b = resolveExpr(expr[2])
          return a != null && a === b ? a : null
        }
        return null
      }
      const v0 = resolveExpr(exprs[0])
      if (v0 == null) continue
      if (!exprs.every(e => resolveExpr(e) === v0)) continue
      func[field] = v0
      changed = true
    }
  }
}

/**
 * Phase: program-fact collection.
 *
 * Single whole-program walk over the module AST + each user function body
 * + all moduleInits. Collects:
 *   dynVars/anyDyn   — vars accessed via runtime key (drives strict mode +
 *   1                   __dyn_get fallback gating)
 *   propMap          — property assignments per receiver (auto-box schemas)
 *   valueUsed        — ctx.func.names passed as first-class values (excluded
 *                      from internal narrowing — they need uniform $ftN ABI)
 *   maxDef/maxCall   — closure ABI width inputs
 *   hasRest/hasSpread
 *   callSites        — `{ callee, argList, callerFunc, node }` for static-name
 *                      calls (drives the type/schema fixpoint without
 *                      re-walking the AST). `node` is the call AST itself,
 *                      mutable for bimorphic-typed clone routing.
 *   paramReps        — Map<funcName, Map<paramIdx, ValueRep>>, empty here;
 *                      populated by narrowSignatures (per-field lattice) and
 *                      read by emitFunc.
 *
 * Also writes ctx.schema.slotTypes (static-key object literal slot val types).
 *
 * Three visit modes:
 *   full=true  (ast + user funcs)  → all facts including call-site collection
 *   full=false (moduleInits)        → dyn + arity only (no propMap/valueUsed/
 *                                     callSites: moduleInits don't own user
 *                                     props/funcs)
 *   inArrow=true                    → flips off call-site collection so
 *                                     closure-internal calls don't poison
 *                                     caller-context type inference.
 */
export function collectProgramFacts(ast) {
  const paramReps = new Map()
  const valueUsed = new Set()
  const dynVars = new Set()
  let anyDyn = false
  const propMap = new Map()
  const callSites = []
  const doSchema = ast && ctx.schema.register
  const doArity = !!ctx.closure.make
  let hasSchemaLiterals = false
  let maxDef = 0, maxCall = 0, hasRest = false, hasSpread = false
  // Slot-type observation lives in the dedicated `observeProgramSlots` pass below;
  // walkFacts only registers schemas (which is local to the AST node).
  const walkFacts = (node, full, inArrow, callerFunc) => {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    // dyn-key detection. Strict check deferred to emit time (e.g. `buf[i]` on a
    // Float64Array uses typed-array load, not __dyn_get — only the actual
    // dynamic-dispatch fallback should error in strict mode).
    if (op === '[]') {
      const [obj, idx] = args
      if (!isLiteralStr(idx)) { anyDyn = true; if (typeof obj === 'string') dynVars.add(obj) }
    } else if (op === 'for-in') {
      if (ctx.transform.strict) err(`strict mode: \`for (... in ...)\` is not allowed (dynamic enumeration). Pass { strict: false } to enable.`)
      anyDyn = true
      if (typeof args[1] === 'string') dynVars.add(args[1])
    }
    // Object literal: register schema. Slot val-type observation is deferred to a
    // second pass (observeSlotsIn below) so that shorthand `{x}` (expanded by prepare
    // to `[':', x, x]`) resolves x's val type via per-function locals, not just globals.
    if (op === '{}' && doSchema) {
      const parsed = staticObjectProps(args)
      if (parsed) {
        ctx.schema.register(parsed.names)
        hasSchemaLiterals = true
      }
    }
    // closure ABI arity
    if (doArity) {
      if (op === '=>') {
        let fixedN = 0
        for (const r of extractParams(args[0])) {
          if (classifyParam(r).kind === 'rest') hasRest = true
          else fixedN++
        }
        if (fixedN > maxDef) maxDef = fixedN
      } else if (op === '()') {
        const a = args[1]
        const callArgs = a == null ? [] : (Array.isArray(a) && a[0] === ',') ? a.slice(1) : [a]
        if (callArgs.some(x => Array.isArray(x) && x[0] === '...')) hasSpread = true
        if (callArgs.length > maxCall) maxCall = callArgs.length
      }
    }
    // Crossing into a closure body: from now on, no call-site collection (matches the
    // pre-fusion scanCalls bailing at '=>'). Still walks children for arity/dyn.
    if (op === '=>') {
      for (const a of args) walkFacts(a, full, true, callerFunc)
      return
    }
    if (full) {
      // property-assignment scan for auto-box
      if (doSchema && op === '=' && Array.isArray(args[0]) && args[0][0] === '.') {
        const [, obj, prop] = args[0]
        if (typeof obj === 'string' && (ctx.scope.globals.has(obj) || ctx.func.names.has(obj))) {
          if (!propMap.has(obj)) propMap.set(obj, new Set())
          propMap.get(obj).add(prop)
        }
      }
      // first-class function-value + static-call-site scan
      if (op === '()' && isFuncRef(args[0], ctx.func.names)) {
        if (!inArrow) {
          // Record call site for the type/schema fixpoint. Filtering by
          // exported/raw/valueUsed happens later (valueUsed isn't fully populated yet).
          // `node` is the call AST node itself; specializeBimorphicTyped mutates
          // node[1] (the callee name) to point at a per-ctor clone.
          const a = args[1]
          const argList = a == null ? [] : (Array.isArray(a) && a[0] === ',') ? a.slice(1) : [a]
          callSites.push({ callee: args[0], argList, callerFunc, node })
        }
        for (let i = 1; i < args.length; i++) {
          const a = args[i]
          if (isFuncRef(a, ctx.func.names)) valueUsed.add(a)
          else walkFacts(a, true, inArrow, callerFunc)
        }
        return
      }
      if ((op === '.' || op === '?.') && isFuncRef(args[0], ctx.func.names)) return
      for (const a of args) {
        if (isFuncRef(a, ctx.func.names)) valueUsed.add(a)
        else walkFacts(a, true, inArrow, callerFunc)
      }
    } else {
      for (const a of args) walkFacts(a, false, inArrow, callerFunc)
    }
  }
  walkFacts(ast, true, false, null)
  for (const func of ctx.func.list) if (func.body && !func.raw) walkFacts(func.body, true, false, func)
  const initFacts = ctx.module.initFacts
  if (initFacts) {
    if (initFacts.anyDyn) {
      anyDyn = true
      for (const v of initFacts.dynVars) dynVars.add(v)
    }
    if (doArity) {
      if (initFacts.maxDef > maxDef) maxDef = initFacts.maxDef
      if (initFacts.maxCall > maxCall) maxCall = initFacts.maxCall
      if (initFacts.hasRest) hasRest = true
      if (initFacts.hasSpread) hasSpread = true
    }
    if (doSchema && initFacts.hasSchemaLiterals) hasSchemaLiterals = true
  }

  // Slot-type observation pass: walk every `{}` literal with the right scope's
  // valTypes installed as `ctx.func.localValTypesOverlay` so shorthand `{x}`
  // (expanded by prepare to `[':', x, x]`) and chained typed-array reads resolve
  // through valTypeOf → lookupValType. Skips into closures — they're observed via
  // their own func.list entry. The overlay is the per-function analyzeBody.valTypes
  // map (already populated with the same overlay-aware walk).
  if (doSchema && hasSchemaLiterals) observeProgramSlots(ast)

  return {
    dynVars, anyDyn, propMap, valueUsed, callSites,
    maxDef, maxCall, hasRest, hasSpread,
    paramReps, hasSchemaLiterals,
  }
}

/** Walk `ast` + every user function body + module inits, observing slot types
 *  on each `{}` literal. Per-function bodies have their analyzeBody.valTypes
 *  installed as overlay so shorthand `{x}` resolves through local consts.
 *
 *  Re-runnable: compile.js calls this once during collectProgramFacts (before
 *  E2 valResult inference), then again after E2 — on the second pass, valTypeOf
 *  on user-function calls resolves via `f.valResult`, lifting slots whose value
 *  is `const x = userFn(...)` from `undefined` to `NUMBER`/etc.
 *  observeSlot's first-wins-then-clash rule means later precise observations
 *  upgrade undefined slots without re-poisoning already-monomorphic ones. */
export function observeProgramSlots(ast) {
  if (!ctx.schema?.register) return
  const slotTypes = ctx.schema.slotTypes
  const observeSlot = (sid, idx, vt) => {
    if (!vt) return
    let arr = slotTypes.get(sid)
    if (!arr) { arr = []; slotTypes.set(sid, arr) }
    while (arr.length <= idx) arr.push(undefined)
    if (arr[idx] === null) return
    if (arr[idx] === undefined) arr[idx] = vt
    else if (arr[idx] !== vt) arr[idx] = null
  }
  const visit = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>') return
    if (op === '{}') {
      const parsed = staticObjectProps(node.slice(1))
      if (parsed) {
        const sid = ctx.schema.register(parsed.names)
        for (let i = 0; i < parsed.values.length; i++) {
          observeSlot(sid, i, valTypeOf(parsed.values[i]))
        }
      }
    }
    for (let i = 1; i < node.length; i++) visit(node[i])
  }
  const prevOverlay = ctx.func.localValTypesOverlay
  if (ast) { ctx.func.localValTypesOverlay = null; visit(ast) }
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    ctx.func.localValTypesOverlay = analyzeBody(func.body).valTypes
    visit(func.body)
  }
  if (ctx.module.initFacts?.hasSchemaLiterals && ctx.module.moduleInits) {
    ctx.func.localValTypesOverlay = null
    for (const mi of ctx.module.moduleInits) visit(mi)
  }
  ctx.func.localValTypesOverlay = prevOverlay
}
