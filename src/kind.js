/**
 * Expression value KIND inference (STRING, ARRAY, …) + JSON shape propagation.
 *
 * Cycle-free w.r.t. analyze.js body walkers — reads ctx + reps only.
 *
 * @module kind
 */

import { ctx } from './ctx.js'
import { VAL, lookupValType, repOf } from './reps.js'
import { intLiteralValue, staticIndexKey } from './static.js'
import {
  BOOL_OPS, NUMERIC_BINARY_OPS, NUMERIC_UNARY_OPS, COMPOUND_NUMERIC_OPS,
  calleeValType, methodValType, propValType, typedCtorElemValType,
} from './kind-traits.js'

export { typedCtorElemValType } from './kind-traits.js'

function literalTruthiness(expr) {
  if (typeof expr === 'number') return expr !== 0 && expr === expr
  if (typeof expr === 'boolean') return expr
  if (typeof expr === 'bigint') return expr !== 0n
  if (typeof expr === 'string') {
    const value = intLiteralValue(expr)
    if (value != null) return value !== 0
  }
  if (Array.isArray(expr)) {
    const [op, ...args] = expr
    if (op == null) {
      if (args.length === 0 || args[0] == null) return false
      return literalTruthiness(args[0])
    }
    if (op === 'bool') return literalTruthiness(args[0])
    if (op === 'nan') return false
    if (op === 'str' && typeof args[0] === 'string') return args[0].length !== 0
    if (op === '()' && expr.length === 2) return literalTruthiness(args[0])
    if (BOOL_OPS.has(op)) {
      const result = literalBool(expr)
      if (result != null) return result
    }
    if (op === '?:' || op === '?') {
      const truthy = literalTruthiness(args[0])
      if (truthy != null) return literalTruthiness(truthy ? args[1] : args[2])
      const thenTruthy = literalTruthiness(args[1])
      const elseTruthy = literalTruthiness(args[2])
      if (thenTruthy != null && thenTruthy === elseTruthy) return thenTruthy
    }
    if (op === '()' && Array.isArray(args[0]) && args[0][0] === '?') {
      const truthy = literalTruthiness(args[0][1])
      if (truthy != null) return literalTruthiness(truthy ? args[0][2] : args[0][3])
      const thenTruthy = literalTruthiness(args[0][2])
      const elseTruthy = literalTruthiness(args[0][3])
      if (thenTruthy != null && thenTruthy === elseTruthy) return thenTruthy
    }
  }
  return null
}

function literalValue(expr) {
  if (expr == null || typeof expr === 'number' || typeof expr === 'boolean' || typeof expr === 'bigint') return expr
  if (!Array.isArray(expr)) return undefined
  const [op, ...args] = expr
  if (op == null) return args.length ? args[0] : undefined
  if (op === 'nan') return NaN
  if (op === 'str') return args[0]
  if (op === 'bool') {
    const truthy = literalTruthiness(args[0])
    return truthy == null ? undefined : truthy
  }
  if (op === '()' && expr.length === 2) return literalValue(args[0])
  return undefined
}

function literalBool(expr) {
  if (!Array.isArray(expr)) return null
  const [op, left, right] = expr
  if (op === '!') {
    const truthy = literalTruthiness(left)
    return truthy == null ? null : !truthy
  }
  if (!['<', '<=', '>', '>=', '==', '!=', '===', '!=='].includes(op)) return null
  const a = literalValue(left), b = literalValue(right)
  if (a === undefined || b === undefined) return null
  switch (op) {
    case '<': return a < b
    case '<=': return a <= b
    case '>': return a > b
    case '>=': return a >= b
    case '==': return a == b
    case '!=': return a != b
    case '===': return a === b
    case '!==': return a !== b
  }
  return null
}

/**
 * Per-op val-type rules — the dispatch table behind `valTypeOf`. Each entry
 * takes the op's args and returns a VAL kind or undefined (→ null). Set-driven
 * families (BOOL_OPS, NUMERIC_*) enroll at module init, so adding an operator
 * is a kind-traits table entry, not a new branch here.
 */
const VT = Object.create(null)

// Self-describing boolean literal from the host→kernel AST boundary (normalizeBigints).
VT.bool = () => VAL.BOOL
// Boolean-result operators: relational/equality compares and logical-not always
// yield a boolean. (`&&`/`||` are value-preserving, not boolean — excluded.)
for (const op of BOOL_OPS) VT[op] = VT.bool
// Self-describing bigint literal (`normalizeBigints`) — same VAL as a raw `255n`.
VT.bigint = () => VAL.BIGINT
VT['['] = () => VAL.ARRAY
VT.str = VT.strcat = () => VAL.STRING
VT['=>'] = () => VAL.CLOSURE
VT['//'] = () => VAL.REGEX

VT['{}'] = (args) => {
  const hasSpread = args.some(p => Array.isArray(p) && p[0] === '...')
  if (!hasSpread) return args[0]?.[0] === ':' ? VAL.OBJECT : null
  // Spread literal — mirror emitObjectSpread (module/object.js). When every
  // spread source has a compile-time schema, emit builds a fixed-shape OBJECT
  // and the existing schema-by-name read path resolves props with no val-type
  // tag, so leave it untyped (tagging OBJECT here regresses it — the merged
  // schema isn't bound to this name). When any source's schema is unknown, emit
  // builds a dynamic HASH (emitDynamicSpread); that result carries no schema, so
  // the binding MUST be HASH-typed or computed/static reads silently misdispatch
  // (fixed-slot / array index) and return undefined — the bug this fixes.
  for (const p of args)
    if (Array.isArray(p) && p[0] === '...' && !spreadSchema(p[1])) {
      // `{ ...src }` with a single unknown spread aliases src — carry its type.
      return args.length === 1 ? valTypeOf(args[0][1]) : VAL.HASH
    }
  return null
}

VT['?:'] = (args) => {
  const truthy = literalTruthiness(args[0])
  if (truthy != null) return valTypeOf(truthy ? args[1] : args[2])
  const ta = valTypeOf(args[1]), tb = valTypeOf(args[2])
  if (ta && ta === tb) return ta
  // A boolean branch coerces to 0/1 in NUMERIC context: when the other branch is a
  // known NUMBER, the conditional carries NUMBER — the raw 0/1 bool carrier IS its
  // ToNumber image, so the claim is benign and keeps `num + (cond ? num : num>k)`
  // off the polymorphic string-concat dispatch (which pins the whole number→string
  // formatter — __str_concat → __to_str → __static_str, a pure-int program
  // ballooning 1 → ~19 funcs; see test/wat-invariants.js, .work/todo.md).
  // Any OTHER mix is null: both ternary arms are "the value", so claiming the
  // non-bool arm's kind would let strict-eq's differing-class fold constant-fold
  // `x === true` on a value that IS sometimes a boolean (watr's `i ? true :
  // [from,len]` rec marker); the bool arm materializes as its atom at emit
  // (emit.js '?:') and stays observable. (&&/||/?? below keep the full carry —
  // there the bool side is a GUARD whose value surfaces only when falsy, and the
  // carry is what types `cond && typedArr` guarded-use idioms.)
  if (ta === VAL.BOOL && tb && tb !== VAL.BOOL) return tb === VAL.NUMBER ? VAL.NUMBER : null
  if (tb === VAL.BOOL && ta && ta !== VAL.BOOL) return ta === VAL.NUMBER ? VAL.NUMBER : null
  // BIGINT arm + nullish-LITERAL arm carries BIGINT. BIGINT is the one kind
  // with NO runtime tag — raw i64 bits ride the f64 slot, indistinguishable
  // from a number — so a dispatcher that loses the static kind has no runtime
  // fork to fall back on: tryRuntimeStringFork's non-NaN arm claimed
  // `(c ? BigInt(x) : null).toString(16)` as NUMBER and formatted the bits as
  // a denormal ("0.000…"), watr's `cb ? BigInt(cb.value) : null` folder shape.
  // Sound where the bool-arm carry above is not: a nullish receiver is
  // TypeError-class in JS (no method table to mis-pick), the nullish arm
  // materializes as its ATOM whose bits the sentinel compare still matches at
  // runtime, and the decl-site mayBeNullish flag (analyze.js) plus
  // nullableOperand (emit.js) keep `x == null` folds honest — narrow.js
  // re-derives that nullability across call boundaries for BIGINT params.
  // Tagged kinds stay null here on purpose: their runtime fork handles the
  // mix soundly and their eq-folds stay maximally live.
  if (ta === VAL.BIGINT && nullishArm(args[2])) return VAL.BIGINT
  if (tb === VAL.BIGINT && nullishArm(args[1])) return VAL.BIGINT
  return null
}

// AST nullish literal — mirrors ir.js isNullishLit ([null,null] = null literal,
// [] = undefined) plus the bare `undefined` name form recordGlobalRep accepts;
// local copy because ir.js already imports valTypeOf from here (cycle).
const nullishArm = (n) => n === 'undefined' ||
  (Array.isArray(n) && ((n.length === 2 && n[0] == null && n[1] == null) || n.length === 0))

// Value-preserving logical: `&&`/`||` return one of their operands.
// When both sides share a type, return it. When one side is boolean
// (a condition/guard) and the other has a known non-boolean type,
// return the non-boolean type — common in `condition && numericValue`
// guard patterns where the falsey boolean is coerced to 0 in numeric context.
// `a && b` / `a || b` / `a ?? b` all yield one of the two operands, so the result
// type is their common type (else unknown). Giving `??` a type — not just ||/&& —
// lets `numA ?? numB` read NaN-safe (value-typed NUMBER → f64.eq) instead of routing
// through the bit-comparing __is_truthy, which mis-reads a non-canonical NaN.
VT['&&'] = VT['||'] = VT['??'] = (args) => {
  const ta = valTypeOf(args[0]), tb = valTypeOf(args[1])
  if (ta && ta === tb) return ta
  if (ta === VAL.BOOL && tb && tb !== VAL.BOOL) return tb
  if (tb === VAL.BOOL && ta && ta !== VAL.BOOL) return ta
  return null
}

// `[]` op covers both array literals (1 arg) and index access (2 args).
// Array literal: `[]` → ['[]', null]; `[1,2]` → ['[]', [',', ...]]; `[x]` → ['[]', x].
// Index access:  `arr[i]` → ['[]', arr, i].
VT['[]'] = (args) => {
  if (args.length < 2) return VAL.ARRAY
  // A literal NEGATIVE index is always out of range → reads undefined, not the
  // element type. Returning a numeric elem type here would let `a[-1] === undefined`
  // fold to false (a NUMBER can't be undefined), silently dropping the guard.
  { const li = intLiteralValue(args[1]); if (li != null && li < 0) return null }
  // SRoA flat-array slot read: `a[k]` (static index) where `a` dissolved into
  // scalar `a#i` locals (scanFlatObjects). A write-once slot's value-type is its
  // element literal's — same numeric-binding as the `VT['.']` object case, so
  // `a[0] * 2` stays a plain f64 op instead of the polymorphic ToNumber battery.
  if (typeof args[0] === 'string') {
    const flat = ctx.func.flatObjects?.get(args[0])
    if (flat) {
      const k = staticIndexKey(args[1])
      if (k != null && !flat.written?.has(k)) {
        const i = flat.names.indexOf(k)
        if (i >= 0 && flat.values[i] !== undefined) return valTypeOf(flat.values[i])
      }
    }
  }
  // Indexed read on a known typed-array receiver yields Number except for
  // BigInt64Array/BigUint64Array, whose i64 carriers must stay BigInt-typed.
  if (typeof args[0] === 'string' && lookupValType(args[0]) === VAL.TYPED)
    return typedCtorElemValType(ctx.types.typedElem?.get(args[0])) || VAL.NUMBER
  // Indexed read on a STRING returns a 1-char string (SSO at runtime).
  if (typeof args[0] === 'string' && lookupValType(args[0]) === VAL.STRING) return VAL.STRING
  if (Array.isArray(args[0]) && valTypeOf(args[0]) === VAL.STRING) return VAL.STRING
  // Indexed read on a known Array<VAL> receiver: bind by rep.arrayElemValType.
  // Set by analyzeValTypes from body observations + emitFunc preseed for params.
  if (typeof args[0] === 'string') {
    const elemVt = ctx.func.localReps?.get(args[0])?.arrayElemValType
    if (elemVt) return elemVt
    // Module-level const array (a numeric/uniform table): its element val-type was
    // recorded on the global rep at decl time. Trust it only when no function element-
    // writes the array — dynWriteVars holds every var written via a non-named-property
    // index, so a `X[i]=str` anywhere disables this and falls back to the untyped read.
    if (!ctx.func.localReps?.has(args[0])) {
      const gElem = ctx.scope.globalReps?.get(args[0])?.arrayElemValType
      if (gElem && !ctx.types?.dynWriteVars?.has(args[0])) return gElem
    }
  }
  // Direct double-index on a module-level nested numeric table — `C[i][j]` where
  // `C = [[…number…], …]`. The receiver is itself a single-index read of a global
  // array whose nested element kind was recorded at decl time. Same dynWriteVars
  // guard (now root-aware, so a `C[i][j]=…` write anywhere disables it).
  if (Array.isArray(args[0]) && args[0][0] === '[]' && args[0].length === 3 && typeof args[0][1] === 'string') {
    const base = args[0][1]
    if (!ctx.func.localReps?.has(base)) {
      const gNested = ctx.scope.globalReps?.get(base)?.arrayElemElemValType
      if (gNested && !ctx.types?.dynWriteVars?.has(base)) return gNested
    }
  }
  // Indexed read on an inline all-numeric array literal — `[2,4,2,9][i]` (floatbeat
  // chord/pattern tables; literal op is `[`, elements inline). Every element is a
  // Number, so the load is a Number; this lets toNumF64 skip __to_num on the result
  // and propagates numericness outward (e.g. a closure arg that then marks its param
  // numeric, or the surrounding `-arr[i]` that feeds a numeric accumulator).
  if (Array.isArray(args[0]) && args[0][0] === '[' && args[0].length > 1
      && args[0].slice(1).every(e => valTypeOf(e) === VAL.NUMBER)) return VAL.NUMBER
  return null
}

VT['.'] = (args) => {
  if (typeof args[1] !== 'string') return null
  // SRoA flat-object slot read: `p.x` where `p` dissolved into scalar `p#i`
  // locals (scanFlatObjects). A write-once slot's value-type IS its literal
  // initializer's, so bind by it — exactly as a plain `let slot = value` local
  // would. Without this `p.x * 2` looks like "could be anything" and pulls the
  // ToNumber + string-format battery, though it can only be numeric. Computed
  // on-demand (not cached at analyze time) because param val-types — `{x:n}`'s
  // `n` is numeric-by-divergence — are only seeded at emit. A reassigned slot
  // (`p.x = …`) stays untyped: its runtime value may differ from the literal.
  if (typeof args[0] === 'string') {
    const flat = ctx.func.flatObjects?.get(args[0])
    if (flat && !flat.written?.has(args[1])) {
      const i = flat.names.indexOf(args[1])
      if (i >= 0 && flat.values[i] !== undefined) return valTypeOf(flat.values[i])
    }
  }
  // Schema slot read: when `varName` has a bound schemaId and `.prop` resolves
  // to a slot whose VAL kind is monomorphic across program-wide observations,
  // return that kind. Lets `+`, `===`, method dispatch skip runtime str-key
  // checks on numeric properties of known shapes. Precise-only — see
  // ctx.schema.slotVT for why structural subtyping is intentionally off.
  if (ctx.schema?.slotVT) {
    const slotVT = ctx.schema.slotVT(args[0], args[1])
    if (slotVT) return slotVT
  }
  // OBJECT `.prop` propagation: when the receiver chain roots at a binding
  // sourced from `JSON.parse(stringConst)`, walk the shape tree to recover the
  // child's val-type. Generic for any compile-time-known JSON literal.
  // The shape's per-prop kind is a DECL-SITE fact — writes can invalidate it:
  //   - a sid-bound receiver whose schema declares the prop: the slot census
  //     above (slotVT) is authoritative — it saw every resolvable write and
  //     answered null on clash/poison, so the stale decl kind must not revive
  //     (`o.x = 'oops'; o.x + 1` skipped concat dispatch — live miscompile);
  //   - otherwise, the write-hazard sets cover unresolvable-receiver writes
  //     that could reach this object through an alias.
  const sh = shapeOf(args[0])
  if (sh?.val === VAL.OBJECT || sh?.val === VAL.HASH) {
    const child = sh.props[args[1]]
    if (child) {
      const sid = typeof args[0] === 'string'
        ? (repOf(args[0])?.schemaId ?? ctx.schema?.vars?.get(args[0])) : null
      if (sid != null && ctx.schema?.list?.[sid]?.indexOf(args[1]) >= 0) return null
      const hz = ctx.schema?.slotWriteHazards
      if (hz && (hz.all || hz.props.has(args[1]) ||
        (hz.numeric && /^(0|[1-9][0-9]*)$/.test(args[1])))) return null
      return child.val
    }
  }
  // Built-in property on a known sized kind — `.length` on STRING/ARRAY/TYPED,
  // `.size` on SET/MAP, `.byteLength`/`.byteOffset` on TYPED/BUFFER. These are
  // language invariants (the property is always a number on that kind), so typing
  // them NUMBER lets `+` skip the string-concat dispatch. Object schema slots
  // resolved above override this, keeping user-defined same-name slots sound.
  const objType = typeof args[0] === 'string' ? lookupValType(args[0]) : valTypeOf(args[0])
  const pvt = propValType(args[1], objType)
  if (pvt) return pvt
  return null
}

// Arithmetic expressions: BigInt if either operand is BigInt, else number.
const numericBinaryVT = (args) =>
  valTypeOf(args[0]) === VAL.BIGINT || valTypeOf(args[1]) === VAL.BIGINT ? VAL.BIGINT : VAL.NUMBER
for (const op of NUMERIC_BINARY_OPS) VT[op] = numericBinaryVT
// `~`, `++`, `--`, `**` preserve/propagate BigInt…
const numericUnaryVT = (args) =>
  valTypeOf(args[0]) === VAL.BIGINT || (args[1] != null && valTypeOf(args[1]) === VAL.BIGINT) ? VAL.BIGINT : VAL.NUMBER
for (const op of NUMERIC_UNARY_OPS) VT[op] = numericUnaryVT
// …while `>>>` and unary-plus throw on bigint operands so they always yield Number.
VT['>>>'] = VT['u+'] = () => VAL.NUMBER

VT['+'] = (args) => {
  const ta = valTypeOf(args[0]), tb = valTypeOf(args[1])
  if (ta === VAL.STRING || tb === VAL.STRING) return VAL.STRING
  if (ta === VAL.BIGINT || tb === VAL.BIGINT) return VAL.BIGINT
  return VAL.NUMBER
}

// Assignment & compound-assign expressions return the rhs value. Without this,
// `(a = x*x) + (b = y*y)` falls through to null and `+` emits the polymorphic
// string-concat dispatch on two pure-numeric subexpressions.
VT['='] = (args) => valTypeOf(args[1])
VT['+='] = (args) => {
  const ta = typeof args[0] === 'string' ? lookupValType(args[0]) : null
  const tb = valTypeOf(args[1])
  if (ta === VAL.STRING || tb === VAL.STRING) return VAL.STRING
  if (ta === VAL.BIGINT || tb === VAL.BIGINT) return VAL.BIGINT
  return VAL.NUMBER
}
const compoundNumericVT = (args) => {
  const ta = typeof args[0] === 'string' ? lookupValType(args[0]) : null
  return ta === VAL.BIGINT || valTypeOf(args[1]) === VAL.BIGINT ? VAL.BIGINT : VAL.NUMBER
}
for (const op of COMPOUND_NUMERIC_OPS) VT[op] = compoundNumericVT

VT['()'] = (args) => {
  const callee = args[0]
  // __iter_arr normalizes an iterable to an index-iterable Array: Set→keys,
  // Map→[k,v], while Array/String/TypedArray pass through unchanged. The result
  // type drives the downstream arr[i]/.length dispatch, so a Set/Map source
  // becomes ARRAY and everything else keeps the source's own type.
  if (callee === '__iter_arr') {
    const t = valTypeOf(args[1])
    return t === VAL.SET || t === VAL.MAP ? VAL.ARRAY : t
  }
  // for-in's read-only key list (src/prepare) — always an Array of key strings.
  if (callee === '__keys_ro') return VAL.ARRAY
  // Ternary is parsed as call to '?' operator: ['()', ['?', cond, a, b]]
  if (Array.isArray(callee) && callee[0] === '?') {
    const truthy = literalTruthiness(callee[1])
    if (truthy != null) return valTypeOf(truthy ? callee[2] : callee[3])
    const ta = valTypeOf(callee[2]), tb = valTypeOf(callee[3])
    return ta && ta === tb ? ta : null
  }
  // Constructor results + user function return-type inference
  if (typeof callee === 'string') {
    if (callee === 'JSON.parse') {
      const src = jsonConstString(args[1])
      if (src != null) {
        const c = src.trimStart()[0]
        if (c === '{') return VAL.OBJECT
        if (c === '[') return VAL.ARRAY
        if (c === '"') return VAL.STRING
        // 't'/'f' → boolean: the parser mints the TRUE/FALSE atom (module/json.js
        // litCase), NOT a raw 0/1 — claiming NUMBER here would let numeric fast
        // paths raw-add the atom bits.
        if (c === 't' || c === 'f') return VAL.BOOL
        if (c === '-' || (c >= '0' && c <= '9')) return VAL.NUMBER
      }
    } else {
      const vt = calleeValType(callee, args, ctx)
      if (vt != null) return vt
    }
  }
  if (Array.isArray(callee) && callee[0] === '.') {
    const [, obj, method] = callee
    const vt = methodValType(method, obj, valTypeOf(obj), ctx)
    if (vt != null) return vt
  }
  return null
}

export function valTypeOf(expr) {
  if (expr == null) return null
  if (typeof expr === 'number') return VAL.NUMBER
  if (typeof expr === 'boolean') return VAL.BOOL
  if (typeof expr === 'bigint') return VAL.BIGINT
  if (typeof expr === 'string') return lookupValType(expr)
  if (!Array.isArray(expr)) return null

  const [op, ...args] = expr
  if (op == null) {
    // Literal forms: [] = undefined, [null, null] = null, [null, n] = number/bigint, [, bool] = boolean
    if (args.length === 0) return null              // undefined literal
    if (args[0] == null) return null                // null literal
    if (typeof args[0] === 'boolean') return VAL.BOOL
    if (typeof args[0] === 'symbol') return null    // prepared null sentinel
    return typeof args[0] === 'bigint' ? VAL.BIGINT : VAL.NUMBER
  }
  return VT[op]?.(args) ?? null
}

export function jsonConstString(expr) {
  if (Array.isArray(expr) && expr[0] === 'str' && typeof expr[1] === 'string') return expr[1]
  if (Array.isArray(expr) && expr[0] == null && typeof expr[1] === 'string') return expr[1]
  if (typeof expr === 'string') {
    return ctx.scope.shapeStrs?.get(expr) ?? ctx.scope.constStrs?.get(expr) ?? null
  }
  return null
}

function jsonShapeStrings(expr) {
  const single = jsonConstString(expr)
  if (single != null) return [single]
  if (Array.isArray(expr) && expr[0] === '[]' && typeof expr[1] === 'string') return ctx.scope.shapeStrArrays?.get(expr[1]) ?? null
  return null
}

/** Build a structural shape tree from a parsed JSON value. Each node is
 *  `{ val, props?, elem? }` — `val` is the inferred VAL kind (matches
 *  rep.val in localReps entries). Lets `valTypeOf` propagate VAL kinds
 *  through `.prop` chains and `[i]` reads on bindings sourced from
 *  `JSON.parse` of a compile-time-known string. Polymorphic arrays drop
 *  their `elem`. */
function shapeOfJsonValue(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return { val: VAL.NUMBER }
  if (typeof v === 'string') return { val: VAL.STRING }
  if (typeof v === 'boolean') return { val: VAL.NUMBER }
  if (Array.isArray(v)) {
    let elem = null
    for (const x of v) {
      const s = shapeOfJsonValue(x)
      if (!s) { elem = null; break }
      if (!elem) elem = s
      else if (!shapeUnifies(elem, s)) { elem = null; break }
    }
    return { val: VAL.ARRAY, elem }
  }
  if (typeof v === 'object') {
    const props = Object.create(null)
    const names = Object.keys(v)
    for (const k of names) {
      const s = shapeOfJsonValue(v[k])
      if (s) props[k] = s
    }
    return { val: VAL.OBJECT, props, names }
  }
  return null
}

function shapeUnifies(a, b) {
  if (!a || !b || a.val !== b.val) return false
  if (a.val === VAL.OBJECT || a.val === VAL.HASH) {
    const ak = Object.keys(a.props), bk = Object.keys(b.props)
    if (ak.length !== bk.length) return false
    for (const k of ak) {
      if (!b.props[k] || !shapeUnifies(a.props[k], b.props[k])) return false
    }
  }
  if (a.val === VAL.ARRAY) {
    if ((a.elem == null) !== (b.elem == null)) return false
    if (a.elem && !shapeUnifies(a.elem, b.elem)) return false
  }
  return true
}

function shapeLayoutUnifies(a, b) {
  if (!shapeUnifies(a, b)) return false
  if (a.val === VAL.OBJECT || a.val === VAL.HASH) {
    if (a.names?.length !== b.names?.length) return false
    for (let i = 0; i < a.names.length; i++) if (a.names[i] !== b.names[i]) return false
  }
  if (a.val === VAL.ARRAY && a.elem) return shapeLayoutUnifies(a.elem, b.elem)
  return true
}

function parseJsonShape(src) {
  if (typeof src !== 'string') return null
  let parsed
  try { parsed = JSON.parse(src) } catch { return null }
  return shapeOfJsonValue(parsed)
}

function parseUnifiedJsonShape(srcs) {
  if (!srcs?.length) return null
  let out = null
  for (const src of srcs) {
    const sh = parseJsonShape(src)
    if (!sh) return null
    if (!out) out = sh
    else if (!shapeLayoutUnifies(out, sh)) return null
  }
  return out
}

/** Resolve the json shape for an expression by walking name → rep.jsonShape and
 *  `.prop` / `[i]` indirection. Returns null when shape is unknown at this site. */
export function shapeOf(expr) {
  if (typeof expr === 'string')
    return ctx.func.localReps?.get(expr)?.jsonShape
        ?? ctx.scope.globalReps?.get(expr)?.jsonShape
        ?? null
  if (!Array.isArray(expr)) return null
  const [op, ...args] = expr
  if (op === '()' && args[0] === 'JSON.parse') {
    const srcs = jsonShapeStrings(args[1])
    if (srcs) return parseUnifiedJsonShape(srcs)
  }
  if (op === '.' && typeof args[1] === 'string') {
    const parent = shapeOf(args[0])
    if (parent?.val === VAL.OBJECT || parent?.val === VAL.HASH) return parent.props[args[1]] || null
  }
  if (op === '[]' && args.length === 2) {
    const parent = shapeOf(args[0])
    if (parent?.val === VAL.ARRAY) return parent.elem || null
  }
  return null
}

/** Spread source's static schema (key list) or null if unknown at compile time.
 *  Mirrors module/object.js `resolveSchema` so kind inference predicts the same
 *  OBJECT-vs-HASH decision emitObjectSpread makes (kept here to keep kind.js
 *  cycle-free — it must not import the object stdlib module). */
function spreadSchema(obj) {
  // A parameter's compile-time schema is an inferred/union guess (and is unbound
  // during this body's analysis but bound by emit) — see resolveSchema in
  // module/object.js. Treat params as unknown so the spread result is HASH-typed
  // consistently across analyze and emit; otherwise reads misdispatch.
  if (typeof obj === 'string') {
    if (ctx.func.current?.params?.some(p => p.name === obj)) return null
    return ctx.schema?.resolve?.(obj)
  }
  if (Array.isArray(obj) && obj[0] === '{}')
    return obj.slice(1).filter(p => Array.isArray(p) && p[0] === ':').map(p => p[1])
  const sh = shapeOf(obj)
  return (sh?.val === VAL.OBJECT && sh.names) ? sh.names : null
}

/** Build a structural shape from a `{}` AST node — recursive for nested
 *  object/array literals + propagating shapes through identifier references
 *  (so `let G = {…}; let H = {x: G}` carries G's shape under H.x). Returns
 *  null when any property breaks the static-shape contract (computed key,
 *  spread, non-shape value). Only called from `recordGlobalRep` — local
 *  bindings keep relying on `shapeOf` whose narrower contract (JSON.parse /
 *  traversal only) lets `Object.assign(a, …)` extend `a`'s schema without
 *  locking a static jsonShape onto it. */
export function shapeOfObjectLiteralAst(expr) {
  if (typeof expr === 'string') return shapeOf(expr)
  if (!Array.isArray(expr) || expr[0] !== '{}') return shapeOf(expr)
  const raw = expr.length === 2 && Array.isArray(expr[1]) && expr[1][0] === ','
    ? expr[1].slice(1)
    : expr.slice(1)
  const props = Object.create(null)
  const names = []
  for (const p of raw) {
    if (!Array.isArray(p) || p[0] !== ':' || typeof p[1] !== 'string') return null
    names.push(p[1])
    const child = shapeOfObjectLiteralAst(p[2])
    if (child) props[p[1]] = child
  }
  return names.length ? { val: VAL.OBJECT, props, names } : null
}
