/**
 * JSON shape propagation — builds/unifies structural shape trees
 * (`{ val, props?, elem? }`) from `JSON.parse`d compile-time-known strings
 * and object-spread schemas, so `kind/val-type-of.js`'s `VT['.']` can
 * propagate VAL kinds through `.prop`/`[i]` chains on a binding sourced
 * from a known-shape literal. `shapeOfObjectLiteralAst` (the OTHER shape
 * constructor, building a shape tree from a `{}` AST node rather than a
 * parsed JSON string) stays in `kind/val-type-of.js` instead — it is the
 * one function in this family whose scalar-literal-property-leaf branch
 * calls the general `valTypeOf`, which would otherwise force a cycle here
 * (.work/archive/kind-split.md §4).
 *
 * Split out of kind.js (pipeline-minimality slice, .work/archive/kind-split.md).
 *
 * @module kind/shape
 */

import { ctx } from '../ctx.js'
import { VAL } from '../reps.js'
import { ERR_CLASS_NAMES, ERR_SCHEMA_PROPS } from '../../err-codes.js'

export function jsonConstString(expr) {
  if (Array.isArray(expr) && expr[0] === 'str' && typeof expr[1] === 'string') return expr[1]
  // C5b hardening: see stringLiteral's (emit.js) identical arm removal —
  // `[null, string]` has no producer past prepare/index.js's normalization.
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
    if (parent?.val === VAL.ARRAY) {
      // non-numeric string-literal key = PROPERTY read, not an element (see VT['[]'])
      const k = args[1]
      const lit = Array.isArray(k) && k.length === 2 && k[0] == null ? k[1]
        : Array.isArray(k) && k[0] === 'str' ? k[1] : undefined
      if (typeof lit === 'string' && !/^(0|[1-9][0-9]*)$/.test(lit)) return null
      return parent.elem || null
    }
  }
  return null
}

// Recognizes `cond && {k: v, …}` — kind.js's cycle-free mirror of module/
// object.js's identical-named function (this file must not import the
// object stdlib module — see spreadSchema's own doc just below). Duplicated,
// not shared; keep the two in lockstep by hand, same discipline spreadSchema
// itself already documents for resolveSchema. Returns the inner literal's
// key list (order preserved) or null.
function conditionalSpreadGroup(node) {
  if (!Array.isArray(node) || node[0] !== '&&' || node.length !== 3) return null
  let inner = node[2]
  while (Array.isArray(inner) && inner[0] === '&&' && inner.length === 3) inner = inner[2]
  if (!Array.isArray(inner) || inner[0] !== '{}') return null
  const props = inner.length === 2 && Array.isArray(inner[1]) && inner[1][0] === ','
    ? inner[1].slice(1) : inner.slice(1)
  if (!props.length || !props.every(p => Array.isArray(p) && p[0] === ':')) return null
  return props.map(p => p[1])
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
  // Literal `new X(...)`/`X(...)` Error-constructor call — mirrors module/
  // object.js `resolveSchema`'s identical branch (.work/archive/todo.md §deletion-sweep
  // finding-1/3). INVARIANT: this closes an analyze/emit disagreement — a
  // BOUND Error name already agreed via ctx.schema.resolve above,
  // but this literal shape fell through to `shapeOf` below, which doesn't
  // know Error calls, so it resolved null/HASH here while emit's own
  // resolveSchema resolved the physical schema. Same physical layout for
  // every one of the 7 classes, so no class-name branching needed).
  if (Array.isArray(obj) && obj[0] === '()' && typeof obj[1] === 'string' && ERR_CLASS_NAMES.includes(obj[1]))
    return ERR_SCHEMA_PROPS
  // Conditional-spread group (module/object.js conditionalSpreadGroup /
  // mergeSpreadNames) — checked BEFORE the plain '{}' branch below, whose
  // no-nested-spread-recursion contract stays exactly as it was for every
  // other shape (an existing spreadSchema/resolveSchema asymmetry this
  // doesn't touch).
  const condKeys = conditionalSpreadGroup(obj)
  if (condKeys) return condKeys
  if (Array.isArray(obj) && obj[0] === '{}')
    return obj.slice(1).filter(p => Array.isArray(p) && p[0] === ':').map(p => p[1])
  const sh = shapeOf(obj)
  return (sh?.val === VAL.OBJECT && sh.names) ? sh.names : null
}

// Kind.js's cycle-free mirror of module/object.js `mergeSpreadNames` — VT['{}']
// below only needs the resolves/doesn't-resolve verdict (no consumer here
// needs a schema id or the merged name list itself), so this returns a bool.
// Same collision discipline: a conditional group's key touched by more than
// one prop/source bails the WHOLE merge (→ false, HASH-typed) — MUST match
// emitObjectSpread's own bail exactly, or analysis predicts OBJECT while
// emit builds a HASH and reads misdispatch (the exact class of bug this
// mirror exists to prevent — see spreadSchema's own doc above).
export function spreadMergeResolves(props) {
  for (const p of props) {
    if (Array.isArray(p) && p[0] === '...') {
      const group = conditionalSpreadGroup(p[1])
      // Conditional presence requires the HASH representation; a fixed slot
      // cannot distinguish absent from present-with-undefined.
      if (group) return false
      if (!spreadSchema(p[1])) return false
    }
  }
  return true
}

