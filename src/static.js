/**
 * Compile-time static evaluation — literals, property keys, schema ids.
 * @module static
 */
import { I32_MIN, I32_MAX } from './ast.js'
import { ctx } from './ctx.js'
import { repOf, VAL } from './reps.js'
import { TYPED_ELEM_CODE } from '../layout.js'

// Byte width per TYPED_ELEM_CODE index (0..7) — parallel to module/typedarray.js's
// own private SHIFT table (log2 of this), duplicated here (layout.js-adjacent, no
// compiler-state dependency) since that module isn't importable from this leaf file.
const TYPED_ELEM_BYTE_WIDTH = [1, 1, 2, 2, 4, 4, 4, 8]

// Bare-name typed-array ctor resolution — the raw 'new.X' / 'new.X.view' string,
// same multi-source chain resolveElem (module/typedarray.js) and this compiler's
// own typed-dispatch sites read for a receiver NAME: a per-function narrowing
// overlay first, then the whole-function map, then the module-global map.
const typedCtorRawOf = (name) =>
  ctx.func?.localTypedElemsOverlay?.get(name) ?? ctx.types?.typedElem?.get(name) ?? ctx.scope?.globalTypedElem?.get(name) ?? null

/** Extract integer value from AST literal node. Returns null if not a 32-bit integer. */
export function intLiteralValue(expr) {
  let v = null
  if (typeof expr === 'number') v = expr
  else if (Array.isArray(expr) && expr[0] == null && typeof expr[1] === 'number') v = expr[1]
  else if (Array.isArray(expr) && expr[0] === 'u-' && typeof expr[1] === 'number') v = -expr[1]
  else if (typeof expr === 'string') v = repOf(expr)?.intConst ?? ctx.scope.constInts?.get(expr) ?? null
  return v != null && Number.isInteger(v) && v >= I32_MIN && v <= I32_MAX ? v : null
}

/** Non-negative integer literal — used for string/typed-array index bounds. */
export const nonNegIntLiteral = (node) => { const n = intLiteralValue(node); return n != null && n >= 0 ? n : null }

/** Flat-array slot key for a *bare* non-negative integer index literal `[null, k]`
 *  — returns the stringified index ("0","1",…) so an array `a[k]` resolves through
 *  the same SRoA `name#i` machinery as an object `o.key`. Only a literal index
 *  qualifies (not a const-folded identifier): the key must be unambiguous at scan
 *  time, before any rep is known. Null for dynamic / non-integer / huge indices. */
export const staticIndexKey = (node) =>
  Array.isArray(node) && node[0] == null && Number.isInteger(node[1]) && node[1] >= 0 && node[1] < 0x100000000
    ? String(node[1]) : null

/** Fold compile-time integer expressions (literals, const bindings, + - * <<). */
export function constIntExpr(node) {
  let lit = intLiteralValue(node)
  if (lit == null && typeof node === 'number' && Number.isInteger(node)) lit = node
  if (lit == null && Array.isArray(node) && node[0] == null && Number.isInteger(node[1])) lit = node[1]
  if (lit != null) return lit
  if (typeof node === 'string') return repOf(node)?.intConst ?? ctx.scope.constInts?.get(node) ?? null
  if (!Array.isArray(node)) return null
  const op = node[0]
  if (op === 'u-') {
    const v = constIntExpr(node[1])
    return v == null ? null : -v
  }
  if (node.length !== 3) return null
  const a = constIntExpr(node[1]), b = constIntExpr(node[2])
  if (a == null || b == null) return null
  if (op === '+') return a + b
  if (op === '-') return a - b
  if (op === '*') return a * b
  if (op === '<<') return a << b
  return null
}


/** Closed integer hull [lo, hi] of an int expression, or null. Resolves names
 *  through constIntExpr (module const-ints + per-function intConst reps) and
 *  models the range-bearing operators: masks (`x & m` ⇒ [0, m]), unsigned
 *  shifts, ternary hulls, and ± / * interval arithmetic. The canonical range
 *  evaluator — narrow's typed-value-range walk and emit's i32-provability
 *  (product safety, power-of-two division strength reduction) share it. */
export function intExprRange(n) {
  const c = constIntExpr(n)
  if (c != null && Number.isInteger(c)) return [c, c]
  if (typeof n === 'string') {
    // Branch-local range refinements (flow-types: `x >= 0 && x < W` inside the
    // guarded arm) intersect with the binding's durable range rep. Analyze-time
    // stamping never sees refinements (they install only during emit), so decl
    // range reps stay context-free.
    const rf = ctx.func?.refinements?.get(n)
    const rep = repOf(n)?.range
    let lo = rep ? rep[0] : -Infinity, hi = rep ? rep[1] : Infinity
    if (rf?.rlo != null && rf.rlo > lo) lo = rf.rlo
    if (rf?.rhi != null && rf.rhi < hi) hi = rf.rhi
    return Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : null
  }
  if (!Array.isArray(n)) return null
  const op = n[0]
  // A typed array's `.length` (element count) is bounded by wasm32's own hard
  // linear-memory ceiling: a SINGLE allocation can span at most the whole
  // address space, 2^32 BYTES (WebAssembly core spec, memory32 limit — 65536
  // pages × 64 KiB), and elemCount = byteLength / elementByteWidth exactly (no
  // rounding — layout.js's SHIFT/stride convention). This is universal and
  // unconditional (no allocator-size-class assumption, no `--memory` flag
  // assumption) — it holds even for a receiver that later grows to fill all of
  // memory. Only useful (≤ i32 range) for element widths ≥ 4 bytes: a 1-byte
  // element's ceiling is 2^32 itself (not < 2^31), a 2-byte element's is
  // exactly 2^31 (still not STRICTLY under 0x7fffffff) — both left unbounded
  // here rather than admitting a boundary-adjacent hull.
  if (op === '.' && n.length === 3 && n[2] === 'length' && typeof n[1] === 'string') {
    const raw = typedCtorRawOf(n[1])
    if (raw != null) {
      const bare = raw.endsWith('.view') ? raw.slice(4, -5) : raw.slice(4)
      const code = TYPED_ELEM_CODE[bare]
      const width = code != null ? TYPED_ELEM_BYTE_WIDTH[code] : null
      if (width != null) {
        const cap = Math.floor(0x100000000 / width)
        if (cap <= 0x7fffffff) return [0, cap]
      }
    }
  }
  if (op === '?:' && n.length === 4) {
    const a = intExprRange(n[2]), b = intExprRange(n[3])
    return a && b ? [Math.min(a[0], b[0]), Math.max(a[1], b[1])] : null
  }
  if (op === '&' && n.length === 3) {
    const m = constIntExpr(n[1]) ?? constIntExpr(n[2])
    // `&` is ToInt32: for m ≥ 2^31 the mask bit is the SIGN bit, so the result
    // can be negative (x & 0x80000000 → 0 or -2^31) — only i31-safe masks
    // yield the [0, m] hull.
    if (m != null && m >= 0 && m <= 0x7fffffff) return [0, m]
  }
  if (op === '>>>' && n.length === 3) {
    const sh = constIntExpr(n[2])
    if (sh != null && (sh & 31) !== 0) return [0, 0xFFFFFFFF >>> (sh & 31)]
  }
  // `>>` is ToInt32 then a SIGNED shift: the result is always a genuine i32,
  // shifted — sound for ANY operand (even one with no known range of its own,
  // e.g. an unbounded param) purely from the operator's own semantics, same
  // "derive from the op, not the operand" reasoning as `&`/`>>>` just above.
  // Tightened against the operand's own hull when one is known.
  if (op === '>>' && n.length === 3) {
    const sh = constIntExpr(n[2])
    if (sh != null) {
      const s = sh & 31
      const a = intExprRange(n[1])
      return a ? [a[0] >> s, a[1] >> s] : [I32_MIN >> s, I32_MAX >> s]
    }
  }
  if ((op === 'u-' || op === '-') && n.length === 2) {
    const a = intExprRange(n[1])
    return a ? [-a[1], -a[0]] : null
  }
  // `++x`/`--x` as an expression VALUE is always the NEW (post-mutation) value at
  // this AST layer — postfix `x++`'s old-value form is `(++x) - 1` (ast.js), so a
  // bare `++`/`--` node is uniformly prefix semantics: operand's range, shifted by
  // ±1. Lets a loop counter's own forCounterRange hull (emit.js) reach the counter's
  // OWN in-body step-expression arithmetic (e.g. a comma-step dual-IV header's
  // dropped post-increment value), not just bare reads of the name elsewhere.
  if ((op === '++' || op === '--') && n.length === 2 && typeof n[1] === 'string') {
    const a = intExprRange(n[1])
    return a ? (op === '++' ? [a[0] + 1, a[1] + 1] : [a[0] - 1, a[1] - 1]) : null
  }
  if ((op === '+' || op === '-' || op === '*') && n.length === 3) {
    const a = intExprRange(n[1]), b = intExprRange(n[2])
    if (!a || !b) return null
    if (op === '+') return [a[0] + b[0], a[1] + b[1]]
    if (op === '-') return [a[0] - b[1], a[1] - b[0]]
    const p = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]]
    return [Math.min(...p), Math.max(...p)]
  }
  return null
}

// Loop-counter RANGE-PROOF lever (audit-#8 P1-2 follow-up to 3b50d504/16f2d7c8):
// a bare counted loop `for (let i = C; i < B; i++)` proves nothing about `i` to
// opBound/intExprRange today — `i` is written by the step, so it never qualifies
// for the decl-range stamp analyze.js gives a never-reassigned local (its own
// "closed integer hull for never-reassigned decls" comment, src/compile/
// analyze.js). Without a range, `i*K`/`i+j`/`B-i` shapes fall through
// addFitsI32/mulFitsI32's magnitude-blind default (opBound's unproven ceiling,
// 2^31 — ONE more than 0x7fffffff, so it fails by construction) all the way to
// the f64 round-trip, which cascades into the vectorizer pattern-matchers
// (they match the raw i32.add/i32.mul shapes) declining.
//
// Lives here (not emit.js) since forCounterRange has exactly ONE dependency —
// intExprRange/constIntExpr, both already leaf-level in this file — and BOTH
// an emit-time consumer (emit.js's ctx.func.refinements channel) and an
// ANALYZE-TIME consumer (analyze-scans.js's stampCoInductionRanges, INDUCTION-
// VARIABLE FACT project) need the identical proof: the whole point of "the
// canonical range evaluator... shared" (intExprRange's own doc, above).
//
// Returns a real, closed [lo, hi] hull for `name` — sound for the ENTIRE body
// of exactly this loop, nothing more — or null. Two independent proof
// obligations, both required:
//   1. `init` is a decl/assign of `name` to an expression intExprRange can hull
//      (a literal is itself; a name chains through its own already-proven
//      decl-range/refinement — same resolver every other intExprRange consumer
//      shares, so composition is free).
//   2. `cond` is `name < B` / `name <= B` and intExprRange(B) hulls too — a
//      const bound is itself; a typed-array `.length`/module-const bound
//      chains the same way; an unbounded dynamic bound (a raw param, an
//      unproven global) returns null here and admits NOTHING — no heuristic
//      fallback, matching the "the range proof must be REAL" floor.
// `step` must be a KNOWN, monotone integer constant in the SAME direction as
// the guard: increasing (`i++`, `i += K`, `i = i + K`, guard `i < B`/`i <=
// B`) OR, symmetrically, decreasing (`i--`, `i -= K`, `i = i - K`, guard `i >
// B`/`i >= B` — sort's heap-extract `for (end = n-1; end > 0; end--)`):
// monotone motion is what makes the guard's tightened bound a true ceiling
// (increasing) or floor (decreasing) and the init a true floor/ceiling on the
// OTHER side; an unknown/non-self/direction-mismatched step proves nothing
// (and is rejected). Reassignment elsewhere in the body (a closure capture, a
// mid-body write) is NOT checked here — withRefinements (flow-types.js), the
// sole caller, already refuses to install a refinement for any name
// isReassigned finds written in that exact body.
//
// `expr ≡ name + K` for a compile-time integer K (K may be negative) — the
// constant SHIFT a guard comparand can carry without changing which name the
// comparison is really about. `name` itself is K=0. `K - name` is EXCLUDED:
// that's `-name + K`, a sign-flipped (decreasing-into-K) relationship, never
// a same-direction rewrite of `name`'s own motion — same exclusion
// forCounterRange's own step-matcher already applies below. Lets a SHIFTED
// guard (`i + 3 <= n`, base64's `encode`/`decode` shape — INDUCTION-VARIABLE
// FACT project, see .work/todo.md) reuse the identical lo/hi arithmetic as a
// bare-name guard, just against a bound pre-shifted by `-K`.
export function nameShift(expr, name) {
  if (expr === name) return 0
  if (!Array.isArray(expr) || expr.length !== 3) return null
  if (expr[0] === '+') {
    if (expr[1] === name) { const k = constIntExpr(expr[2]); return Number.isInteger(k) ? k : null }
    if (expr[2] === name) { const k = constIntExpr(expr[1]); return Number.isInteger(k) ? k : null }
    return null
  }
  if (expr[0] === '-' && expr[1] === name) { const k = constIntExpr(expr[2]); return Number.isInteger(k) ? -k : null }
  return null
}
// Which name does a relational guard's LHS actually compare — bare, or
// shifted by a compile-time constant (nameShift's own shapes)? Both
// forCounterRange callers need this BEFORE they can even name which
// counter to ask forCounterRange to prove a hull for — `cond[1]` alone
// (the old, pre-shift assumption both call sites made) is only ever a bare
// name for an UNSHIFTED guard; a shifted one (`i + 3 <= n`) has an
// expression there instead.
export function guardCounterName(cond) {
  if (!Array.isArray(cond) || !['<', '<=', '>', '>='].includes(cond[0])) return null
  const lhs = cond[1]
  if (typeof lhs === 'string') return lhs
  if (Array.isArray(lhs) && lhs.length === 3 && lhs[0] === '+') {
    if (typeof lhs[1] === 'string' && constIntExpr(lhs[2]) != null) return lhs[1]
    if (typeof lhs[2] === 'string' && constIntExpr(lhs[1]) != null) return lhs[2]
  }
  if (Array.isArray(lhs) && lhs.length === 3 && lhs[0] === '-' && typeof lhs[1] === 'string' && constIntExpr(lhs[2]) != null) return lhs[1]
  return null
}
export function forCounterRange(init, cond, step, name) {
  if (!Array.isArray(cond) || !['<', '<=', '>', '>='].includes(cond[0])) return null
  const shift = nameShift(cond[1], name)
  if (shift == null) return null
  const increasing = cond[0] === '<' || cond[0] === '<='
  // Multi-declarator init (`let j = 0, k = 0`) — a dual-IV header (the FFT
  // butterfly's `j`/`k` twiddle-walk being the motivating shape): find the ONE
  // declarator that binds `name`, ignoring sibling declarators entirely (they
  // prove nothing about `name` and disprove nothing either).
  const initExpr =
    Array.isArray(init) && (init[0] === 'let' || init[0] === 'const')
      ? (init.slice(1).find(d => Array.isArray(d) && d[0] === '=' && d[1] === name) ?? null)?.[2] ?? null
    : Array.isArray(init) && init[0] === '=' && init[1] === name ? init[2]
    : null
  if (initExpr == null) return null
  const posConst = (e) => { const k = constIntExpr(e); return k != null && k > 0 }
  // A comma-sequenced step (`j++, k += step`) — postfix `j++`'s VALUE is
  // `(++j) - 1` at this AST layer (the old value), but the WRITE that matters
  // for the range proof is the inner `++j`; unwrap that value-sugar before
  // testing the mutation shape. `--x`'s postfix twin is `(--x) + 1`.
  const unwrapPostfixVal = (e) =>
    Array.isArray(e) && e[0] === '-' && e.length === 3 && Array.isArray(e[1]) && e[1][0] === '++' && constIntExpr(e[2]) === 1 ? e[1]
    : Array.isArray(e) && e[0] === '+' && e.length === 3 && Array.isArray(e[1]) && e[1][0] === '--' && constIntExpr(e[2]) === 1 ? e[1]
    : e
  // mutOp: the '++'/'--' unary that moves `name` one unit in the guard's own
  // direction. arithOp: the binary '+'/'-' a spelled-out `name = name ± K`
  // step uses in that SAME direction — only that direction's operand-order
  // swap (`K + name`) is a valid alternate spelling; `K - name` is a
  // DIFFERENT (decreasing-into-K) quantity, never a same-direction rewrite of
  // `name - K`, so it's deliberately excluded (the `arithOp === '+'` guard).
  // Returns the step's own POSITIVE magnitude (not just a boolean) — the
  // INDUCTION-VARIABLE FACT project's trip-count derivation needs it;
  // existing callers only ever consumed the boolean truthiness, so this is
  // additive.
  const stepMag = (s, mutOp, arithOp) => {
    s = unwrapPostfixVal(s)
    if (Array.isArray(s) && s[0] === mutOp && s[1] === name) return 1
    if (Array.isArray(s) && s[0] === (mutOp === '++' ? '+=' : '-=') && s[1] === name && posConst(s[2])) return constIntExpr(s[2])
    if (Array.isArray(s) && s[0] === '=' && s[1] === name &&
        Array.isArray(s[2]) && s[2][0] === arithOp && s[2].length === 3 &&
        ((s[2][1] === name && posConst(s[2][2])) || (arithOp === '+' && s[2][2] === name && posConst(s[2][1]))))
      return constIntExpr(s[2][1] === name ? s[2][2] : s[2][1])
    return null
  }
  const stepMatches = (s) => increasing ? stepMag(s, '++', '+') : stepMag(s, '--', '-')
  const stepOK = Array.isArray(step) && step[0] === ',' ? (step.slice(1).map(stepMatches).find(v => v != null) ?? null) : stepMatches(step)
  if (stepOK == null) return null
  const initRange = intExprRange(initExpr), boundRange0 = intExprRange(cond[2])
  if (!initRange || !boundRange0) return null
  const boundRange = [boundRange0[0] - shift, boundRange0[1] - shift]
  const lo = increasing ? initRange[0] : boundRange[0] + (cond[0] === '>' ? 1 : 0)
  const hi = increasing ? boundRange[1] - (cond[0] === '<' ? 1 : 0) : initRange[1]
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) return null
  const result = [lo, hi]
  result.step = stepOK
  return result
}

export const NO_VALUE = Symbol('no-static-property-key')

export function staticPropertyKey(node) {
  const value = staticValue(node)
  return value === NO_VALUE ? null : String(value)
}

export function staticValue(node) {
  if (node === undefined) return undefined
  if (node === null || typeof node === 'number' || typeof node === 'boolean') return node
  if (typeof node === 'string') return ctx.scope.constStrs?.get(node) ?? NO_VALUE
  if (!Array.isArray(node)) return NO_VALUE

  const [op, ...args] = node
  if (op == null) return args.length ? args[0] : undefined
  if (op === 'str') return args[0]
  // parse.js tags a literal bool as `['bool', 1|0]` (self-host kernel boundary
  // marker — the same convention as bigint literals' `['bigint', decimalStr]`,
  // see kind.js), where native subscript's own literal shape `[, true]` would
  // also work (caught by op==null above) but degrades once self-hosted.
  // Recover the boolean from its 0/1 carrier so const-folded keys/conditions
  // resolve on the kernel leg (e.g. `{ [true ? 3 : 4]: 5 }`).
  if (op === 'bool') { const c = staticValue(args[0]); return c === NO_VALUE ? NO_VALUE : !!c }
  if (op === '[]' && args.length === 1) return staticValue(args[0])
  if (op === '()' && args[0] === 'String' && args.length === 2) {
    const value = staticValue(args[1])
    return value === NO_VALUE ? NO_VALUE : String(value)
  }
  if (op === '()' && args[0] === 'Number' && args.length === 2) {
    const value = staticValue(args[1])
    return value === NO_VALUE ? NO_VALUE : Number(value)
  }
  if (op === '?:' || op === '?') {
    const cond = staticValue(args[0])
    return cond === NO_VALUE ? NO_VALUE : staticValue(cond ? args[1] : args[2])
  }
  if (op === '&&' || op === '||') {
    const left = staticValue(args[0])
    if (left === NO_VALUE) return NO_VALUE
    return op === '&&' ? (left ? staticValue(args[1]) : left) : (left ? left : staticValue(args[1]))
  }
  if (op === '??') {
    const left = staticValue(args[0])
    return left === NO_VALUE ? NO_VALUE : left == null ? staticValue(args[1]) : left
  }

  if (args.length === 1) {
    const value = staticValue(args[0])
    if (value === NO_VALUE) return NO_VALUE
    // Parser emits raw `-`/`+` for both unary and binary; prep later normalizes
    // unary to `u-`/`u+`, but staticPropertyKey runs on raw parser AST.
    if (op === 'u+' || op === '+') return +value
    if (op === 'u-' || op === '-') return -value
    if (op === '!') return !value
    if (op === '~') return ~value
    return NO_VALUE
  }

  if (args.length === 2) {
    const left = staticValue(args[0])
    const right = staticValue(args[1])
    if (left === NO_VALUE || right === NO_VALUE) return NO_VALUE
    switch (op) {
      case '+': return typeof left === 'string' || typeof right === 'string' ? String(left) + String(right) : Number(left) + Number(right)
      case '-': return Number(left) - Number(right)
      case '*': return Number(left) * Number(right)
      case '/': return Number(left) / Number(right)
      case '%': return Number(left) % Number(right)
      case '**': return Number(left) ** Number(right)
      case '&': return Number(left) & Number(right)
      case '|': return Number(left) | Number(right)
      case '^': return Number(left) ^ Number(right)
      case '<<': return Number(left) << Number(right)
      case '>>': return Number(left) >> Number(right)
      case '>>>': return Number(left) >>> Number(right)
      default: return NO_VALUE
    }
  }

  return NO_VALUE
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

export function staticArrayElems(expr) {
  if (!Array.isArray(expr)) return null
  if (expr[0] === '[') return expr.slice(1)
  if (expr[0] !== '[]' || expr.length >= 3) return null
  const arg = expr[1]
  if (arg == null) return []
  return Array.isArray(arg) && arg[0] === ',' ? arg.slice(1) : [arg]
}

/** Schema-id for an object literal expression. Returns null on dynamic keys, spread, shorthand. */
export function objLiteralSchemaId(expr) {
  if (!Array.isArray(expr) || expr[0] !== '{}' || !ctx.schema?.register) return null
  const parsed = staticObjectProps(expr.slice(1))
  return parsed ? ctx.schema.register(parsed.names) : null
}

/** Canonical content key for an inplace/structInline replace-store site —
 *  the ','-wrapper around literal props is normalized away between plan and
 *  emit, so flatten before serializing. Shared by scanInplaceStores (plan),
 *  analyzeStructInline (eligibility), and the emit arms; lives here so the
 *  three importers stay acyclic (the self-host resolver rejects cycles). */
export const inplaceKey = (arrName, lit) => {
  const props = lit.slice(1)
  const flat = props.length === 1 && Array.isArray(props[0]) && props[0][0] === ',' ? props[0].slice(1) : props
  return `${arrName}|${JSON.stringify(flat)}`
}

/** K schema-ordered field-value AST nodes of an object literal `{S}` — the
 *  cell-store order for a structInline `.push({S})` / `a[i] = {S}` — or null if
 *  `lit` is not a plain static-key `{}` literal carrying exactly schema `sid`'s
 *  fields. Mapped by name into schema order so sites with differing key order
 *  flatten to the same cell run. */
export function structLiteralFields(lit, sid) {
  if (!Array.isArray(lit) || lit[0] !== '{}') return null
  const parsed = staticObjectProps(lit.slice(1))
  const schema = ctx.schema.list[sid]
  if (!parsed || parsed.names.length !== schema.length) return null
  const byName = new Map()
  for (let i = 0; i < parsed.names.length; i++) byName.set(parsed.names[i], parsed.values[i])
  const out = []
  for (const name of schema) {
    if (!byName.has(name)) return null
    out.push(byName.get(name))
  }
  return out
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

/** Closed-union inline carrier for `name` (Array of a packed heterogeneous
 *  union — analyzeUnionInline). Same function-local-only rule as
 *  inlineArraySid, keyed by the rep's canonical set. */
export function inlineArrayUnion(name) {
  if (typeof name !== 'string') return null
  if (ctx.scope.globals?.has(name)) return null
  const set = ctx.func.localReps?.get(name)?.arrayElemSchemaSet
  if (!set || set.length < 2) return null
  const key = set.join(',')              // canonical key — tiny join, no expando on the shared rep array
  const u = ctx.schema.inlineUnion?.get(key)
  return u ? { key, sids: u.sids, stride: u.stride } : null
}

export function inlineArraySid(name) {
  if (typeof name !== 'string') return null
  // structInline is keyed on the per-function `localReps` rep, so it is only
  // consistent for a *function-local* array — a write site and a read site in the
  // same frame agree. A module-global array is read across functions whose frames
  // carry no rep for it, so the carrier would diverge: `G.push({a,b})` in one
  // function flattens the struct into K cells, while `G.length` / `G[i].a` in
  // another sees a plain array (K=1) and reads garbage. Never inline a global's
  // element struct — the plain Array<ptr> representation is consistent everywhere.
  if (ctx.scope.globals?.has(name)) return null
  const sid = ctx.func.localReps?.get(name)?.arrayElemSchema
  return sid != null && ctx.schema.inlineArray?.has(sid) ? sid : null
}
