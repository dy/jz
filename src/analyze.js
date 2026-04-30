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
 *   - collectValTypes:     pure pass — returns a types map (for caller-local analysis)
 *   - analyzeValTypes:     ctx-mutating pass — writes types + tracks regex/typed + localProps
 *   - analyzeLocals:       name→'i32'|'f64' dataflow, two-pass (assignments + widenPass)
 *   - analyzeDynKeys:      cross-function scan for `obj[runtimeKey]` → sets ctx.types.dynKeyVars
 *   - analyzeBoxedCaptures:detect mutably-captured vars → ctx.func.boxed cells
 *   - extractParams/classifyParam/collectParamNames: arrow param AST normalization helpers
 *
 * Ordering: analyzeDynKeys runs once per compile; others run per function during compile().
 *
 * @module analyze
 */

import { ctx, err } from './ctx.js'

export const T = '\uE000'

/** Statement operators — used to distinguish block bodies from object literals. */
export const STMT_OPS = new Set([';', 'let', 'const', 'return', 'if', 'for', 'for-in', 'while', 'break', 'continue', 'switch',
  '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '>>=', '<<=', '>>>=', '||=', '&&=', '??=',
  'throw', 'try', 'catch', '++', '--', '()'])

// Value types — what a variable holds (for method dispatch, schema resolution)
export const VAL = {
  NUMBER: 'number', ARRAY: 'array', STRING: 'string',
  OBJECT: 'object', SET: 'set', MAP: 'map',
  CLOSURE: 'closure', TYPED: 'typed', REGEX: 'regex',
  BIGINT: 'bigint', BUFFER: 'buffer',
}

/**
 * ValueRep — unified per-local representation record. (S2 unification target.)
 *
 * Currently populated fields:
 *   val:      VAL.* — value-type for method dispatch, schema resolution, length lookup.
 *   ptrKind:  VAL.* — when this local stores an unboxed i32 pointer offset.
 *   ptrAux:   i32   — kind-dependent aux (TYPED elem code, etc.).
 *   schemaId: i32   — schema binding for boxed/known-shape OBJECTs. Mirrors
 *                     `ctx.schema.vars[name]` for function-local names; readers
 *                     prefer rep.schemaId then fall back to ctx.schema.vars
 *                     (which still holds prepare-time + module-level entries).
 *
 * Future fields (per todo.md; absent today, will be lifted from existing
 * scattered maps as later stages collapse them):
 *   wasm:        'i32' | 'f64'  (today: ctx.func.locals)
 *   nullable, stableOffset                              (not yet tracked)
 *
 * Stored at ctx.func.repByLocal: Map<name, ValueRep> — null when no locals
 * have a rep (small-prog optimization, no allocation when nothing to record).
 */

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
 *  function-local scope → module-global scope.
 *  Refinements are pushed by the 'if' emitter when the condition is a type guard
 *  (typeof x === 't', Array.isArray(x), etc.) and popped after the then-branch. */
export const lookupValType = name => {
  const r = ctx.func.refinements
  if (r && r.size) { const v = r.get(name); if (v) return v }
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
  if (op === 'str') return VAL.STRING
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
      // Math.* always returns Number — let `+` skip string-concat dispatch and
      // let exprType propagate i32 for the integer-returning subset.
      if (typeof callee === 'string' && callee.startsWith('math.')) return VAL.NUMBER
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

/** Schema-id for an object literal expression. Returns null on dynamic keys, spread,
 *  shorthand. Mirrors `staticObjectProps` in compile.js (kept here to avoid the import). */
export function objLiteralSchemaId(expr) {
  if (!Array.isArray(expr) || expr[0] !== '{}' || !ctx.schema?.register) return null
  const args = expr.slice(1)
  const raw = args.length === 1 && Array.isArray(args[0]) && args[0][0] === ',' ? args[0].slice(1) : args
  const names = []
  for (const p of raw) {
    if (!Array.isArray(p) || p[0] !== ':' || typeof p[1] !== 'string') return null
    names.push(p[1])
  }
  return names.length ? ctx.schema.register(names) : null
}

/** Resolve schemaId of an expression, given a per-function schemaId map for locals.
 *  Used for both intra-function arr elem-schema observation and func.arrayElemSchema
 *  return inference. Recognizes: object literals, var names with bound schemaId,
 *  user fn calls with narrowed result schema, ?: / && / || when both branches agree. */
export function exprSchemaId(expr, localSchemaMap) {
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

/** Walk a function body to observe per-local "this is Array<VAL.*>" facts.
 *  Mirrors collectArrElemSchemas but tracks the element val-kind (NUMBER, STRING,
 *  OBJECT, …) instead of a schema id. Drives `arr[i]` → VAL.NUMBER inference for
 *  regular Arrays (typed-array case is handled directly by valTypeOf), unlocking
 *  `__to_num` elision on hot `arr.map(x => x*k)` style callbacks where the elem
 *  type was previously unknown.
 *
 *  Sources: `const arr = [n1, n2, …]` (uniform val), `arr.push(num)` /
 *  `arr.push(rhs1, rhs2, …)` where each `rhs` resolves to a stable VAL.*,
 *  alias chains, calls to user fns with bound `arrayElemValType`. */
export function collectArrElemValTypes(body) {
  const out = new Map()
  if (!body) return out
  const observe = (arr, vt) => {
    if (typeof arr !== 'string') return
    if (!ctx.func.locals?.has(arr) && !ctx.scope.globalTypes?.has(arr)) return
    if (out.get(arr) === null) return
    if (!vt) { out.set(arr, null); return }
    if (!out.has(arr)) out.set(arr, vt)
    else if (out.get(arr) !== vt) out.set(arr, null)
  }
  // Resolve a name's array-elem-val, preferring rep.arrayElemValType (set from
  // paramArrElemValTypes at emit start) over local body observations.
  const elemValOf = (name) => {
    if (typeof name !== 'string') return null
    const repVt = ctx.func.repByLocal?.get(name)?.arrayElemValType
    if (repVt) return repVt
    const localVt = out.get(name)
    return localVt || null
  }
  const exprElemSourceVal = (expr) => {
    // Returns the val type of an element expression for `[lit,lit,…]` / `arr.push(arg)`.
    if (typeof expr === 'string') {
      // Ignore param names for now — they have no val rep at collect time. The
      // walk here is body-local; param-bound elem-vals come via paramArrElemValTypes.
      const repVt = ctx.func.repByLocal?.get(expr)?.val
      if (repVt) return repVt
      return ctx.scope.globalValTypes?.get(expr) || null
    }
    return valTypeOf(expr)
  }
  const walk = (n) => {
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op === '=>') return
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < n.length; i++) {
        const a = n[i]
        if (!Array.isArray(a) || a[0] !== '=' || typeof a[1] !== 'string') {
          walk(a)
          continue
        }
        const name = a[1], rhs = a[2]
        // Array literal init: `let arr = [n1, n2]` — observe elem val
        if (Array.isArray(rhs) && rhs[0] === '[]') {
          const elems = rhs.slice(1).filter(e => e != null)
          if (elems.length) {
            let common = exprElemSourceVal(elems[0])
            for (let k = 1; k < elems.length && common != null; k++) {
              if (exprElemSourceVal(elems[k]) !== common) common = null
            }
            if (common != null) observe(name, common)
          }
        }
        // Call to user fn whose return arr-elem-val is known
        if (Array.isArray(rhs) && rhs[0] === '()' && typeof rhs[1] === 'string') {
          const f = ctx.func.map?.get(rhs[1])
          if (f?.arrayElemValType) observe(name, f.arrayElemValType)
        }
        // Alias: `let b = a` where a is a known Array<vt>
        if (typeof rhs === 'string') {
          const v = elemValOf(rhs)
          if (v) observe(name, v)
        }
        // `.map`/`.filter`/`.slice`/`.concat` on a known Array<vt> receiver: derive
        // elem-val from arrow body (.map) or preserve recv elem (.filter/.slice/.concat).
        // Unblocks the fast `b[j]` read path on `b = a.map(x => x*k)` shapes where
        // the result element is provably numeric. Observe-only — body's valTypeOf
        // returns null for genuinely heterogeneous bodies, leaving observation absent.
        if (Array.isArray(rhs) && rhs[0] === '()' &&
            Array.isArray(rhs[1]) && rhs[1][0] === '.' &&
            typeof rhs[1][1] === 'string') {
          const recvName = rhs[1][1], method = rhs[1][2]
          if (method === 'filter' || method === 'slice' || method === 'concat') {
            const v = elemValOf(recvName)
            if (v) observe(name, v)
          } else if (method === 'map') {
            const arrowFn = rhs[2]
            const recvVt = elemValOf(recvName)
            // Single-param arrow: `x => body` (param is bare string) or `(x) => body`
            // (param is `['()', 'x']`). Skip multi-param/destructured forms — rare
            // for chained pipelines and the body wouldn't be uniform anyway.
            const param = Array.isArray(arrowFn) && arrowFn[0] === '=>' ? arrowFn[1] : null
            const paramName = typeof param === 'string' ? param :
              (Array.isArray(param) && param[0] === '()' && typeof param[1] === 'string' ? param[1] : null)
            const arrowBody = paramName ? arrowFn[2] : null
            // Block-bodied arrow `{ return expr }` → unwrap to the return expression.
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
              if (bodyVt) observe(name, bodyVt)
            }
          }
        }
        walk(rhs)
      }
      return
    }
    // arr.push(...) call
    if (op === '()' && Array.isArray(n[1]) && n[1][0] === '.' && n[1][2] === 'push' && typeof n[1][1] === 'string') {
      const arr = n[1][1]
      const callArgs = n[2]
      const list = callArgs == null ? [] :
        (Array.isArray(callArgs) && callArgs[0] === ',') ? callArgs.slice(1) : [callArgs]
      for (const a of list) {
        if (Array.isArray(a) && a[0] === '...') { observe(arr, null); continue }
        observe(arr, exprElemSourceVal(a))
      }
    }
    // Reassignment to non-array-producing rhs invalidates
    if (op === '=' && typeof n[1] === 'string' && out.has(n[1])) {
      const rhs = n[2]
      if (!Array.isArray(rhs) || (rhs[0] !== '[]' && !(rhs[0] === '()' && Array.isArray(rhs[1]) && rhs[1][0] === '.' && (rhs[1][2] === 'slice' || rhs[1][2] === 'concat')))) {
        observe(n[1], null)
      }
    }
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  walk(body)
  return out
}

/** Walk a function body to observe per-local "this is Array<schemaId>" facts.
 *  Sources: `const arr = [{lit}, {lit}, ...]` (uniform schema), `arr.push(rhs)` /
 *  `arr.push(rhs1, rhs2, ...)` where each `rhs` resolves to a stable schemaId.
 *  Returns Map<varName, schemaId | null>; null = ambiguous (observed conflict),
 *  absent = no observation. Conflict bias: unsafe to bind, callers skip. */
export function collectArrElemSchemas(body) {
  const out = new Map()
  if (!body || !ctx.schema?.register) return out
  // Per-walk local schema map for chained assignments: `const v = obj; arr.push(v)`.
  // Filled greedily during the walk; only consulted for `arr.push(name)` lookups.
  const localSchemaMap = new Map()
  const observe = (arr, sid) => {
    if (typeof arr !== 'string') return
    if (!ctx.func.locals?.has(arr) && !ctx.scope.globalTypes?.has(arr)) return
    if (out.get(arr) === null) return
    if (sid == null) { out.set(arr, null); return }
    if (!out.has(arr)) out.set(arr, sid)
    else if (out.get(arr) !== sid) out.set(arr, null)
  }
  const walk = (n, parentIsInit) => {
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op === '=>') return  // don't cross closure boundary
    // const/let RHS schema bindings (for chained name lookups + uniform-array literals)
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < n.length; i++) {
        const a = n[i]
        if (!Array.isArray(a) || a[0] !== '=' || typeof a[1] !== 'string') {
          // not a name=expr decl (e.g. destructuring) — still walk for nested stmts
          walk(a, true)
          continue
        }
        const name = a[1], rhs = a[2]
        const sid = exprSchemaId(rhs, localSchemaMap)
        if (sid != null) localSchemaMap.set(name, sid)
        // Array literal init: `const arr = [{lit}, {lit}]` — observe elem schema
        if (Array.isArray(rhs) && rhs[0] === '[]') {
          const elems = rhs.slice(1).filter(e => e != null)
          if (elems.length) {
            let common = exprSchemaId(elems[0], localSchemaMap)
            for (let k = 1; k < elems.length && common != null; k++) {
              if (exprSchemaId(elems[k], localSchemaMap) !== common) common = null
            }
            if (common != null) observe(name, common)
          }
        }
        // Call to user fn whose return arr-elem-schema is known: `const rows = initRows()`
        if (Array.isArray(rhs) && rhs[0] === '()' && typeof rhs[1] === 'string') {
          const f = ctx.func.map?.get(rhs[1])
          if (f?.arrayElemSchema != null) observe(name, f.arrayElemSchema)
        }
        // Alias: `const b = a` where a is already observed as Array<sid>
        if (typeof rhs === 'string' && out.has(rhs)) {
          const sid2 = out.get(rhs)
          if (sid2 != null) observe(name, sid2)
        }
        // Aliased from a param with known elem schema (set by emit-time pre-seed).
        if (typeof rhs === 'string') {
          const repSid = ctx.func.repByLocal?.get(rhs)?.arrayElemSchema
          if (repSid != null) observe(name, repSid)
        }
        // Walk rhs only — never enter the `=` node so the reassignment-invalidation
        // rule below won't misfire on init.
        walk(rhs, false)
      }
      return
    }
    // arr.push(...) call
    if (op === '()' && Array.isArray(n[1]) && n[1][0] === '.' && n[1][2] === 'push' && typeof n[1][1] === 'string') {
      const arr = n[1][1]
      const callArgs = n[2]
      const list = callArgs == null ? [] :
        (Array.isArray(callArgs) && callArgs[0] === ',') ? callArgs.slice(1) : [callArgs]
      for (const a of list) {
        if (Array.isArray(a) && a[0] === '...') { observe(arr, null); continue }
        observe(arr, exprSchemaId(a, localSchemaMap))
      }
    }
    // Reassignment of arr to non-array → invalidate. Only fires on `arr = …` (not on
    // `let/const arr = …` initializers — let/const handler returns above).
    if (op === '=' && typeof n[1] === 'string' && out.has(n[1])) {
      const rhs = n[2]
      if (!Array.isArray(rhs) || (rhs[0] !== '[]' && !(rhs[0] === '()' && Array.isArray(rhs[1]) && rhs[1][0] === '.' && (rhs[1][2] === 'slice' || rhs[1][2] === 'concat')))) {
        observe(n[1], null)
      }
    }
    for (let i = 1; i < n.length; i++) walk(n[i], false)
  }
  walk(body, false)
  return out
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

// Per-body memoization: analyzeLocals and collectValTypes are pure functions of
// `body`. compile.js calls each ~2-3× per function (scan-fixpoint, narrowing,
// final lowering); cache the result keyed on body identity and clone-on-read so
// callers can still mutate the returned Map.
// Note: analyzeLocals' exprType now consults ctx.func.repByLocal for `.length`
// receiver type — emitFunc invalidates this entry after seeding cross-call
// param VAL facts so the final emit-time walk picks up the refined types.
const _localsCache = new WeakMap()
const _valTypesCache = new WeakMap()
const _typedElemsCache = new WeakMap()

/** Drop a cached analyzeLocals entry so the next call re-walks with the current
 *  ctx.func.repByLocal. Used by emitFunc after seeding cross-call param VAL facts. */
export function invalidateLocalsCache(body) {
  if (body && typeof body === 'object') _localsCache.delete(body)
}

/** Drop a cached collectValTypes entry. Used after E2-phase valResult narrowing so
 *  the next collectValTypes call re-walks with up-to-date `f.valResult` lookups —
 *  required for the D-pass paramValTypes/paramArrSchemas re-fixpoint to see
 *  `const rows = initRows()` as VAL.ARRAY (initRows.valResult set by E2). */
export function invalidateValTypesCache(body) {
  if (body && typeof body === 'object') _valTypesCache.delete(body)
}

/**
 * Lightweight walk: collect var→valType from let/const/= assignments.
 * Shared between analyzeValTypes and compile.js pre-compile call-site scan.
 */
export function collectValTypes(body, types) {
  const cacheable = !types && body && typeof body === 'object'
  if (cacheable) {
    const hit = _valTypesCache.get(body)
    if (hit) return new Map(hit)
  }
  if (!types) types = new Map()
  function walk(node) {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') return
    if (op === 'let' || op === 'const') {
      for (const a of args) {
        if (!Array.isArray(a) || a[0] !== '=' || typeof a[1] !== 'string') continue
        const vt = valTypeOf(a[2])
        if (vt) types.set(a[1], vt); else types.delete(a[1])
      }
    } else if (op === '=' && typeof args[0] === 'string') {
      const vt = valTypeOf(args[1])
      if (vt) types.set(args[0], vt); else types.delete(args[0])
    }
    for (const a of args) walk(a)
  }
  walk(body)
  if (cacheable) _valTypesCache.set(body, new Map(types))
  return types
}

/**
 * Lightweight walk: collect var → typed-array ctor (e.g. 'new.Float64Array',
 * 'new.Int32Array.view') from let/const/= where the RHS is a typed-array
 * constructor or a TYPED-narrowed call. Used by call-site param propagation
 * so callees can pick up the caller's element type for inline f64.load.
 */
export function collectTypedElems(body) {
  if (body && typeof body === 'object') {
    const hit = _typedElemsCache.get(body)
    if (hit) return new Map(hit)
  }
  const result = new Map()
  const track = (name, rhs) => {
    const ctor = typedElemCtor(rhs)
    if (ctor) { result.set(name, ctor); return }
    if (Array.isArray(rhs) && rhs[0] === '()' && typeof rhs[1] === 'string') {
      const f = ctx.func.map?.get(rhs[1])
      if (f?.sig?.ptrKind === VAL.TYPED && f.sig.ptrAux != null) {
        const c = ctorFromElemAux(f.sig.ptrAux)
        if (c) result.set(name, c)
      }
    }
  }
  function walk(node) {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') return
    if (op === 'let' || op === 'const') {
      for (const a of args) {
        if (!Array.isArray(a) || a[0] !== '=' || typeof a[1] !== 'string') continue
        track(a[1], a[2])
      }
    } else if (op === '=' && typeof args[0] === 'string') {
      track(args[0], args[1])
    }
    for (const a of args) walk(a)
  }
  walk(body)
  if (body && typeof body === 'object') _typedElemsCache.set(body, new Map(result))
  return result
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
  const arrElems = collectArrElemSchemas(body)
  // Parallel walk for Array<VAL.*> facts (numeric/string/etc. element kinds).
  // Records into rep.arrayElemValType so valTypeOf's `arr[i]` rule can elide
  // __to_num and route through the right method dispatch on `arr[i].method()`.
  const arrElemVals = collectArrElemValTypes(body)
  for (const [name, vt] of arrElemVals) {
    if (vt != null) updateRep(name, { arrayElemValType: vt })
  }
  // Resolve a name's array-elem-schema, preferring rep.arrayElemSchema (set from
  // paramArrSchemas at emit start) over local body observations.
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
        // or from paramArrSchemas binding), p inherits the schema. Unlocks slotVT-driven
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
    return ctx.func.current?.params?.find(p => p.name === expr)?.type || 'f64'
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
  }
  return 'f64'
}

/**
 * Analyze all local declarations and assignments to determine types.
 * A local is i32 if ALL assignments produce i32. Any f64 widens to f64.
 */
export function analyzeLocals(body) {
  if (body && typeof body === 'object') {
    const hit = _localsCache.get(body)
    if (hit) return new Map(hit)
  }
  const locals = new Map()

  function walk(node) {
    if (!Array.isArray(node)) return
    const [op, ...args] = node

    if (op === 'let' || op === 'const') {
      for (const a of args) {
        if (typeof a === 'string') { if (!locals.has(a)) locals.set(a, 'f64'); continue }
        if (!Array.isArray(a) || a[0] !== '=') continue
        if (typeof a[1] !== 'string') {
          for (const n of collectParamNames([a[1]])) if (!locals.has(n)) locals.set(n, 'f64')
          walk(a[2]); continue
        }
        const name = a[1], t = exprType(a[2], locals)
        if (!locals.has(name)) locals.set(name, t)
        else if (locals.get(name) === 'i32' && t === 'f64') locals.set(name, 'f64')
      }
    }

    if (op === '=' && typeof args[0] === 'string') {
      const name = args[0], t = exprType(args[1], locals)
      if (locals.has(name) && locals.get(name) === 'i32' && t === 'f64') locals.set(name, 'f64')
    }

    if (['+=', '-=', '*=', '%='].includes(op) && typeof args[0] === 'string') {
      const name = args[0], opChar = op[0]
      const t = exprType([opChar, args[0], args[1]], locals)
      if (locals.has(name) && locals.get(name) === 'i32' && t === 'f64') locals.set(name, 'f64')
    }
    if (['/='].includes(op) && typeof args[0] === 'string') {
      if (locals.has(args[0])) locals.set(args[0], 'f64')
    }

    if (op !== '=>') for (const a of args) walk(a)
  }

  walk(body)

  // Second pass: widen i32 locals that are compared against f64 operands.
  // `for (let i = 0; i < n; i++)` where n is f64 param — i should be f64
  // to avoid per-iteration f64.convert_i32_s.
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

  if (body && typeof body === 'object') _localsCache.set(body, new Map(locals))
  return locals
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
function findMutations(node, names, mutated) {
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
  const isLiteralStr = idx => Array.isArray(idx) && idx[0] === 'str' && typeof idx[1] === 'string'

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
  if (ctx.module.moduleInits) for (const mi of ctx.module.moduleInits) walk(mi)

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
