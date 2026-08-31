/**
 * Integer-certainty fixpoint: a monotone-down dataflow over a body's binding
 * defs, answering "is this expression provably integer-valued" (`intCertainMap`/
 * `intExprChecker`) or the richer 3-level lattice (`intLevelMap`/`intLevelChecker`
 * — see the lattice doc comment below `makeIntLevelExpr`). Shared by
 * `analyzeIntCertain` and `program-facts.js`. Fully independent of every other
 * `type/` family — a true leaf.
 *
 * @module type/int-certain
 */
import { walkAst } from '../ast.js'
import { ctx } from '../ctx.js'
import { VAL, lookupValType } from '../reps.js'
import { propValType, CMP_OPS } from '../kind-traits.js'
import { NO_VALUE, staticValue } from '../static.js'

// === Integer-certainty fixpoint (shared by analyzeIntCertain + program-facts) ===

const INT_BIT_OPS = new Set(['|', '&', '^', '~', '<<', '>>', '>>>'])
const INT_CLOSED_OPS = new Set(['+', '-', '*'])  // `%` handled separately — int only for nonzero divisor
const INT_MATH_FNS = new Set(['imul', 'clz32', 'floor', 'ceil', 'round', 'trunc'])

// `capturedNames`, when given, additionally folds in defs found INSIDE nested
// arrow bodies — but ONLY for names in that set, and only when found there;
// the top-level (own-scope) collection below is completely unaffected either
// way. Default callers (no `capturedNames`) get byte-identical behavior to
// before: an ordinary local can't be assigned from inside a nested arrow
// without becoming a closure capture, so stopping at `=>` is exact there. A
// captured (boxed) variable is exactly the case where it CAN — its cell-type
// decision (src/compile/index.js's closure-capture narrowing) needs those
// writes too, wherever in the closure tree they live. Doesn't track arrow-body
// shadowing (a same-named nested param/`let` re-declaring `name`) — same
// direction of imprecision `boxedCaptures`' own `findMutations` already
// accepts for the boxing decision itself: at worst this forgoes the i32 cell
// fast path (falls back to the always-safe f64 cell), it can never mis-widen
// an actually-non-integer write to i32.
function collectIntDefs(body, capturedNames) {
  const defs = new Map()
  const pushDef = (name, rhs, inArrow) => {
    if (inArrow && !capturedNames.has(name)) return
    let list = defs.get(name)
    if (!list) { list = []; defs.set(name, list) }
    list.push(rhs)
  }
  const collect = (node, inArrow) => walkAst(node, { enter: n => {
    if (n[0] === '=>') {
      if (capturedNames && capturedNames.size) collect(n[2], true)
      return false
    }
    const op = n[0]
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < n.length; i++) {
        const decl = n[i]
        if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string') pushDef(decl[1], decl[2], inArrow)
      }
    } else if (op === '=' && typeof n[1] === 'string') {
      pushDef(n[1], n[2], inArrow)
    } else if (typeof op === 'string' && op.length > 1 && op.endsWith('=') &&
               !CMP_OPS.has(op) && op !== '=>' && typeof n[1] === 'string') {
      pushDef(n[1], [op.slice(0, -1), n[1], n[2]], inArrow)
    } else if ((op === '++' || op === '--') && typeof n[1] === 'string') {
      pushDef(n[1], [op === '++' ? '+' : '-', n[1], [null, 1]], inArrow)
    }
  } })
  collect(body, false)
  return defs
}

// The integer lattice is 3-level:
//   0 — not provably integer-valued
//   1 — integral, but unbounded magnitude and/or -0-capable (`+ - *` closure,
//       floor/ceil/round/trunc, `>>>` — a uint32 can exceed int32, `%`/unary
//       minus — -0 producers)
//   2 — STRICT int32: the value is exactly representable as a signed 32-bit
//       int and is never -0 — i.e. `i32.trunc_sat_f64_s` of its f64 form is
//       an exact round-trip. Producers: int32-range literals, booleans,
//       comparisons, the signed bitwise ops (`| & ^ ~ << >>`), Math.imul /
//       clz32, and meets of those through ?:/&&/||.
// Level ≥1 is the historical `isIntExpr` (ToNumber-skip / floor-elision
// consumers); level 2 feeds raw-i32 slot loads and i32 local typing, where
// saturation or a lost -0 would be a WRONG VALUE, not a lost optimization.
const INT_MATH_FNS_I32 = new Set(['imul', 'clz32'])
const _numLevel = (v) => typeof v === 'boolean' ? 2
  : typeof v !== 'number' || !Number.isInteger(v) || Object.is(v, -0) ? 0
  : v >= -2147483648 && v <= 2147483647 ? 2 : 1

function makeIntLevelExpr(intLevels, slotLevelOf) {
  return function levelOf(expr) {
    if (typeof expr === 'number' || typeof expr === 'boolean') return _numLevel(expr)
    if (typeof expr === 'string') return intLevels.get(expr) ?? 0
    if (!Array.isArray(expr)) return 0
    const sv = staticValue(expr)
    if (sv !== NO_VALUE && typeof sv === 'number' && Object.is(sv, -0)) return 0
    const op = expr[0]
    if (op == null) return _numLevel(expr[1])
    if (op === '>>>') return 1                      // uint32: up to 2^32-1, exceeds int32
    if (INT_BIT_OPS.has(op) || CMP_OPS.has(op)) return 2
    if (op === '.') {
      // Slot-census resolver (analyzeSchemaSlotIntCertain's optimistic
      // fixpoint): a censused slot answers definitively — including 0
      // (a known non-int write beats the val-kind fallback below).
      if (slotLevelOf && typeof expr[1] === 'string') {
        const r = slotLevelOf(expr[1], expr[2])
        if (r != null) return r
      }
      return typeof expr[1] === 'string' && propValType(expr[2], lookupValType(expr[1])) === VAL.NUMBER ? 1 : 0
    }
    if (INT_CLOSED_OPS.has(op)) {
      const a = levelOf(expr[1])
      const b = expr[2] != null ? levelOf(expr[2]) : a
      return a && b ? 1 : 0                          // integral-closed, range-open
    }
    // `a % b` is integer-valued only when b is a provably-nonzero integer
    // constant — `a % 0` is NaN, which is not an integer. A runtime or zero
    // divisor leaves the expression non-int (f64), so result-narrowing won't
    // truncate a NaN remainder to 0 and floor-elision won't drop a NaN.
    // Never strict: `-5 % 5` is -0.
    if (op === '%') {
      const bv = staticValue(expr[2])
      return bv !== NO_VALUE && typeof bv === 'number' && bv !== 0 && Number.isInteger(bv) && levelOf(expr[1]) ? 1 : 0
    }
    if (op === 'u-') return levelOf(expr[1]) ? 1 : 0 // -(0) is -0; -(-2^31) exceeds int32
    if (op === 'u+') return levelOf(expr[1])         // ToNumber identity on an int
    if (op === '?:') return Math.min(levelOf(expr[2]), levelOf(expr[3]))
    if (op === '&&' || op === '||') return Math.min(levelOf(expr[1]), levelOf(expr[2]))
    if (op === '()') {
      const c = expr[1]
      const fn = typeof c === 'string' && c.startsWith('math.') ? c.slice(5)
        : Array.isArray(c) && c[0] === '.' && c[1] === 'Math' ? c[2] : null
      if (fn && INT_MATH_FNS.has(fn)) return INT_MATH_FNS_I32.has(fn) ? 2 : 1
    }
    return 0
  }
}

// Adapt a boolean-or-level slot resolver to the level contract (a boolean
// `true` caps at level 1 — weak evidence stays weak).
const _slotLevelAdapter = (slotIntOf) => slotIntOf
  ? (obj, prop) => { const r = slotIntOf(obj, prop); return r == null ? null : r === true ? 1 : r === false ? 0 : r }
  : null

/** Monotone fixpoint over binding defs in `body`. Map name → intCertain.
 *  `capturedNames` (optional): also fold in defs of these specific names found
 *  inside nested arrow bodies — see collectIntDefs. Only src/compile/index.js's
 *  boxed-cell narrowing passes this; every other caller keeps the default
 *  own-scope-only behavior unchanged. */
/** Monotone-down level fixpoint over binding defs in `body`:
 *  Map name → 0|1|2 (see the lattice above `makeIntLevelExpr`).
 *  `slotLevelOf(obj, prop)` → 0|1|2|null resolves `.prop` reads. */
export function intLevelMap(body, capturedNames, slotLevelOf) {
  const defs = collectIntDefs(body, capturedNames)
  if (defs.size === 0) return new Map()
  const levels = new Map()
  for (const name of defs.keys()) levels.set(name, 2)
  // A parameter has no def in `body` — its entry value is whatever the caller
  // passed. For an f64 param (JS-number ABI) that is an arbitrary real, so a
  // reassigned f64 param is NOT integer-certain: a self/int reassignment
  // (`p = p`, `p = p + 1`) would otherwise vacuously satisfy the optimistic
  // fixpoint, since `levelOf(p)` reads p's own provisional 2. Seed f64
  // params 0 so the unknown entry value grounds the lattice; i32-narrowed
  // params (integer ABI) stay strict. Seeding 0 is always conservative —
  // at worst it re-applies a floor/round that was a runtime no-op — so a
  // mismatched ctx.func.current (whole-program intExprChecker callers) can only
  // forgo an optimization, never miscompile.
  for (const p of ctx.func.current?.params || [])
    if (p.type !== 'i32' && levels.has(p.name)) levels.set(p.name, 0)
  const levelOf = makeIntLevelExpr(levels, slotLevelOf)
  let changed = true
  while (changed) {
    changed = false
    for (const [name, rhsList] of defs) {
      const cur = levels.get(name)
      if (!cur) continue
      let next = cur
      for (const rhs of rhsList) { const l = levelOf(rhs); if (l < next) next = l; if (!next) break }
      if (next !== cur) { levels.set(name, next); changed = true }
    }
  }
  return levels
}

/** Monotone fixpoint over binding defs in `body`. Map name → intCertain
 *  (boolean — the level ≥1 projection; see `intLevelMap` for the raw levels). */
export function intCertainMap(body, capturedNames, slotIntOf) {
  const levels = intLevelMap(body, capturedNames, _slotLevelAdapter(slotIntOf))
  const out = new Map()
  for (const [name, l] of levels) out.set(name, l >= 1)
  return out
}

/** Returns `expr => boolean` — integer-shaped expressions in `body`. */
export function intExprChecker(body, slotIntOf) {
  const slotLevelOf = _slotLevelAdapter(slotIntOf)
  const levelOf = makeIntLevelExpr(intLevelMap(body, undefined, slotLevelOf), slotLevelOf)
  return (expr) => levelOf(expr) >= 1
}

/** Returns `expr => 0|1|2` over `body`'s level fixpoint — the strict-i32
 *  sibling of `intExprChecker` (slot census / raw-i32 consumers). */
export function intLevelChecker(body, slotLevelOf) {
  return makeIntLevelExpr(intLevelMap(body, undefined, slotLevelOf), slotLevelOf)
}
