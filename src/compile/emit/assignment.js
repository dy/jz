/**
 * compoundAssign plus the =/+=/-=/*=//=/%=/**=/&=/|=/^=/>>=/<<=/>>>=/||=/&&=/??= emitter properties.
 *
 * @module compile/emit/assignment
 */

import { ctx, err, inc } from '../../ctx.js'
import {
  applyBigintRepresentationAction, asF64, asI64, boxBigInt, f64rem, fromI64, isConst, isNullish, isNullishLit, readI64, readVar, temp, toI32, toNumF64, truthyIR, typed, writeVar,
} from '../../ir.js'
import { valTypeOf } from '../../kind.js'
import { VAL } from '../../reps.js'
import { emitElementAssign, emitPropertyAssign } from '../emit-assign.js'
import { withFunctionFields } from '../flow-state.js'
import {
  REP_EDGE_BOX, representationBindingWriteAction, representationCompoundAssignAction,
} from '../representation-plan.js'
import { I64_ARITH_OP, bigIntOperand, bigIntShiftIR, bigintMixReject } from './bigint.js'
import { emit, rejectAmbiguousBoolIdentity } from './dispatch.js'
import {
  addBoundedFaithful, addFitsI32, addRangeFitsI32, mulBoundedFaithful, mulFitsI32, mulRangeFitsI32, subRangeFitsI32,
} from './i32-bounds.js'


/** Compound assignment: read → op → write back (via readVar/writeVar).
 *  `arithOp` (one of '+' '-' '*' '/' '%') is the base symbol for BigInt routing;
 *  omit it for ops that only exist elsewhere for BigInt (this fn is never called
 *  for '&='/etc — those have their own i64 gate right below in the dispatch table). */
function compoundAssign(name, val, f64op, i32op, arithOp) {
  if (typeof name === 'string' && isConst(name)) err(`Assignment to const '${name}' — const bindings can't be reassigned after initialization; declare it with let instead`)
  const void_ = ctx.func._expect === 'void'
  // BigInt target/operand: route through the SAME i64 arithmetic the spelled-out
  // binary form uses (asI64 both sides, i64.<op>, fromI64) — see e.g. binary '+'
  // below (asI64(emit(a)), i64.add, fromI64). The f64 path further down silently
  // rounds away magnitude ≥ 2^53 for a proven-BIGINT accumulator: `n += 1n` on a
  // large n was a no-op (f64.add(n, 1) == n once n exceeds f64's integer precision).
  // bigintMixReject keeps the same TypeError-on-provable-mix contract the binary
  // op enforces (`n += 1` on a BigInt n throws in JS, not silently masks to 0).
  if (arithOp && (valTypeOf(name) === VAL.BIGINT || valTypeOf(val) === VAL.BIGINT)) {
    bigintMixReject(`${arithOp}=`, name, val)
    // `name` is always a bare identifier here — censusMaybeUndefined never fires
    // true for it (that predicate only matches `.`/`[]`/`.get()` AST shapes), so
    // readVar(name) stays the plain raw path; only `val` (the RHS, which CAN be a
    // dict/Map maybeUndefined read) needs bigIntOperand's runtime guard.
    const rawBits = [`i64.${I64_ARITH_OP[arithOp]}`, readI64(name, readVar(name)), bigIntOperand(val)]
    // Shape #6 emission companion: this op always computes a FRESH raw i64
    // result (readI64 unboxed the input, i64.<op> ran) — when `name` is
    // plan-materialized BOXED, that raw result must be boxed before it lands
    // back in name's storage slot, or the next plan-aware read (readI64's
    // own isPlanTaggedBigint arm) misreads its raw i64 bits as a box
    // pointer. representationBindingWriteAction can't be reused here: it
    // keys off the AST node collectDefs recorded as this def's rhs (the
    // whole compound node), which this handler never receives — only
    // `name`/`val`. representationCompoundAssignAction is the name-keyed
    // twin (source is always RAW_BIGINT here, by construction — so the
    // action is only ever KEEP/BOX/REJECT, never UNBOX; applied directly
    // rather than through applyBigintRepresentationAction's valTypeOf(node)
    // gate, which would wrongly veto on a proven-bigint LITERAL operand
    // paired with a not-yet-proven `name`, per bigintMixReject's own
    // asymmetric OR guard just above).
    return writeVar(name,
      representationCompoundAssignAction(ctx, name) === REP_EDGE_BOX ? boxBigInt(rawBits) : fromI64(rawBits),
      void_)
  }
  const va = readVar(name), vb = emit(val)
  // Peel f64.convert_i32_s/u when va is i32 — typed-array integer reads wrap their
  // i32.load in convert_i32_* by default, but the i32 arithmetic path can use the
  // raw i32 directly (eliminates per-iter widen + saturating-trunc roundtrip on
  // hot accumulator loops like `let s = 0; for (...) s += i32arr[i]`).
  let vbi = vb
  if (i32op && va.type === 'i32' && vb.type !== 'i32' &&
      Array.isArray(vb) && (vb[0] === 'f64.convert_i32_s' || vb[0] === 'f64.convert_i32_u')) {
    const inner = vb[1]
    vbi = Array.isArray(inner) ? typed(inner, 'i32') : inner
  }
  // INVARIANT: this admission needs the magnitude gate —
  // worse than the old (already-unsound) mulFitsI32, which needed at least one
  // bound. `name op= val` desugars to the exact binary-op arithmetic below, so
  // it must pass the SAME bilateral-bound proof the binary `+`/`-`/`*` operators
  // now require (addFitsI32/mulFitsI32 + their typed-magnitude/AST-range twins,
  // reused verbatim — no second bound tracker). Matters when this compound-
  // assign's OWN result crosses to a DIFFERENT (non-i32) consumer as a VALUE
  // (`y = (x *= huge)` with y f64-typed) — an unfaithfully-wrapped i32 result
  // would be trusted at THAT boundary the same way a bare `return` trusts one
  // (fixed alongside this at narrowI32Results, narrow.js). Value-neutral for
  // the common "write straight back into x's own i32 storage" case either way
  // (ir.js `writeVar` now coerces via `toI32`, which recovers the identical
  // wrapped result through narrowI32 when this gate falls to the f64 arm).
  // `%`/bitwise compounds reach here with no arithOp or an inherently-sound
  // op, so they stay ungated.
  const compoundFitsI32 = arithOp === '*' ? (mulFitsI32(va, vbi) || mulBoundedFaithful(va, vbi) || mulRangeFitsI32(name, val))
    : arithOp === '+' ? (addFitsI32(va, vbi) || addBoundedFaithful(va, vbi) || addRangeFitsI32(name, val))
    : arithOp === '-' ? (addFitsI32(va, vbi) || addBoundedFaithful(va, vbi) || subRangeFitsI32(name, val))
    : true
  if (i32op && va.type === 'i32' && vbi.type === 'i32' && compoundFitsI32)
    return writeVar(name, i32op(va, vbi), void_)
  // Both operands coerce like '+' operands: toNumF64 folds a checked read's
  // UNDEF miss arm to canonical NaN and ToNumber-coerces non-numeric carriers,
  // while proven-NUMBER values pass through unchanged (asF64 identity — hot
  // accumulators pay nothing). A bare asF64 carries a sentinel payload through
  // f64 arithmetic to the boundary (decoded back as `undefined`; JS: NaN) —
  // `s += a[i]` and `let u; s += u` are accumulator shapes the binary '+'
  // emitter never sees.
  return writeVar(name, f64op(asF64(toNumF64(name, va)), asF64(toNumF64(val, vb))), void_)
}
export const assignmentOps = {
  // === Assignment ===

  '=': (name, val) => {
    if (typeof name === 'string' && isConst(name)) err(`Assignment to const '${name}' — const bindings can't be reassigned after initialization; declare it with let instead`)
    if (Array.isArray(name) && name[0] === '[]') return emitElementAssign(name[1], name[2], val)
    if (Array.isArray(name) && name[0] === '.')  return emitPropertyAssign(name[1], name[2], val)
    if (typeof name !== 'string') err(`Assignment to non-variable: ${JSON.stringify(name)} — jz assigns to a plain variable, obj.prop, or arr[i] only`)
    // Plain reassignment (`x = …`, `name` already bound) reaches a DIFFERENT
    // emitter than a decl-with-init (emitDecl above) — the ambiguous-identity
    // REJECT lived only on the decl path, so `let x; x = false ?? 1` (and any
    // later `typeof x`/`x === false`) skipped it entirely and silently kept
    // the collapsed raw-NUMBER carrier (audit-#12 BOOL_CARRIER family). Same
    // helper, same contract: rejects only when SOME use of `name` actually
    // observes its identity — a truthiness-only reassignment still compiles.
    rejectAmbiguousBoolIdentity(name, val)
    if (isNullishLit(val)) ctx.func.maybeNullish?.add(name)   // null-flow: later arithmetic on this var coerces
    const void_ = ctx.func._expect === 'void'
    if (Array.isArray(val) && val[0] === 'u+' && val[1] === name) {
      inc('__to_num')
      return writeVar(name, typed(['call', '$__to_num', asI64(emit(name))], 'f64'), void_)
    }
    // Self-accumulation `x = x + …` (incl. desugared `x += …`): the new value REPLACES x, so x's
    // old buffer is dead — the one context where a string concat may bump-EXTEND it in place. The
    // `+` handler reads this flag for its immediate concat; nested operands clear it (not the target).
    const selfAccum = Array.isArray(val) && val[0] === '+' && val[1] === name
    // Compiler-synthesized decl-destructure array-literal temp (prepare/index.js
    // prepDecl, ctx.schema.arrayVars — kind.js's own doc comment on that map:
    // "tmp is a compiler-synthesized, single-write, non-escaping carrier that
    // only this destructure's own generated reads ever touch"). `tmp = […]`'s
    // own elements never cross the host boundary and are never read via a
    // registry-aware dynamic dispatch — module/array.js's array-literal
    // emitter reads this flag to admit storedValueNarrow unconditionally
    // (dropping its default per-element-uniformity gate, which a mixed-type
    // destructure source like `let [a, b] = [1, BigInt(v)]` fails even though
    // no reader here is ever dynamic). See carrierF64Narrow's own doc comment
    // (ir.js) for the established pattern this mirrors.
    const neverEscapes = Array.isArray(val) && val[0] === '[' && ctx.schema.arrayVars?.has(name)
      ? true : ctx.func._arrayLiteralNeverEscapes
    let ev = withFunctionFields({
      _selfAccumConcat: selfAccum ? name : null,
      _arrayLiteralNeverEscapes: neverEscapes,
    }, () => emit(val))
    const repAction = representationBindingWriteAction(ctx, name, val)
    ev = applyBigintRepresentationAction(ev, val, repAction)
    return writeVar(name, ev, void_)
  },

  // Compound assignments: read-modify-write with type coercion
  '+=': (name, val) => {
    // Complex LHS (obj.prop, arr[i]) → desugar to side-effect-safe `name = name + val`
    if (typeof name !== 'string') return emit(['=', name, ['+', name, val]])
    // String concatenation: desugar to name = name + val (+ handler knows about strings).
    // Also desugar when either side has unknown type — the `+` operator picks runtime
    // string/numeric dispatch (`__is_str_key`); compoundAssign would force f64.add and
    // silently corrupt string concatenations through unknown-typed values.
    const vt = typeof name === 'string' ? valTypeOf(name) : null
    const vtB = valTypeOf(val)
    if (vt === VAL.STRING || vtB === VAL.STRING) return emit(['=', name, ['+', name, val]])
    if ((vt == null || vtB == null) && ctx.core.stdlib['__str_concat']) return emit(['=', name, ['+', name, val]])
    return compoundAssign(name, val, (a, b) => typed(['f64.add', a, b], 'f64'), (a, b) => typed(['i32.add', a, b], 'i32'), '+')
  },
  ...Object.fromEntries([
    ['-=', 'sub'], ['*=', 'mul'], ['/=', 'div'],
  ].map(([op, fn]) => [op, (name, val) => {
    const sym = op.slice(0, -1)
    if (typeof name !== 'string') return emit(['=', name, [sym, name, val]])
    return compoundAssign(name, val,
      (a, b) => typed([`f64.${fn}`, a, b], 'f64'),
      fn === 'div' ? null : (a, b) => typed([`i32.${fn}`, a, b], 'i32'),
      sym
    )
  }])),
  '%=': (name, val) => {
    if (typeof name !== 'string') return emit(['=', name, ['%', name, val]])
    return compoundAssign(name, val, f64rem, (a, b) => typed(['i32.rem_s', a, b], 'i32'), '%')
  },
  // `**` is always f64 (and has its own const-exponent lowering) — full desugar.
  '**=': (name, val) => emit(['=', name, ['**', name, val]]),

  // Bitwise compound assignments: i32 normally, i64 when either operand is BigInt
  ...Object.fromEntries([
    ['&=', 'and'], ['|=', 'or'], ['^=', 'xor'],
    ['>>=', 'shr_s'], ['<<=', 'shl'], ['>>>=', 'shr_u'],
  ].map(([op, fn]) => [op, (name, val) => {
    const sym = op.slice(0, -1)
    if (typeof name !== 'string') return emit(['=', name, [sym, name, val]])
    if (valTypeOf(name) === VAL.BIGINT || valTypeOf(val) === VAL.BIGINT) {
      // `>>>=` has no BigInt arm at all (see the binary '>>>' handler above) —
      // unlike the other bitwise compounds, which fall to i64.<op>, this one
      // must throw unconditionally rather than take fn='shr_u' on i64 bits.
      if (fn === 'shr_u') err('BigInt has no unsigned right shift (>>>) — TypeError in JS; convert with Number(x) first if you need an unsigned shift')
      bigintMixReject(sym, name, val)
      const void_ = ctx.func._expect === 'void'
      // See compoundAssign's identical comment: `name` is always a bare identifier,
      // so only `val` can be a maybeUndefined dict/Map read. `<<=`/`>>=` share the
      // binary `<<`/`>>` handler's sign-aware direction flip — see bigIntShiftIR.
      const rawBits = (sym === '<<' || sym === '>>')
        ? bigIntShiftIR(sym, readI64(name, readVar(name)), bigIntOperand(val))
        : [`i64.${fn}`, readI64(name, readVar(name)), bigIntOperand(val)]
      // Shape #6 emission companion — see compoundAssign's identical comment
      // just above (this dispatch's bigint arm has the exact same
      // fresh-raw-i64-result / box-before-write-back gap).
      return writeVar(name,
        representationCompoundAssignAction(ctx, name) === REP_EDGE_BOX ? boxBigInt(rawBits) : fromI64(rawBits),
        void_)
    }
    return compoundAssign(name, val,
      (a, b) => asF64(typed([`i32.${fn}`, toI32(a), toI32(b)], 'i32')),
      (a, b) => typed([`i32.${fn}`, a, b], 'i32')
    )
  }])),

  // Logical compound assignments: a ||= b → a = a || b, a &&= b → a = a && b
  // Logical/nullish compound assignments: read → check → conditionally write
  // For complex LHS (obj.prop, arr[i]): emit as check(read(lhs)) ? write(lhs, val) : read(lhs)
  ...Object.fromEntries(['||=', '&&=', '??='].map(op => [op, (name, val) => {
    // Complex LHS → desugar (side-effect-safe since obj/arr/idx are locals)
    if (typeof name !== 'string') {
      const baseOp = op.slice(0, -1) // '||', '&&', '??'
      return emit([baseOp, name, ['=', name, val]])
    }
    if (isConst(name)) err(`Assignment to const '${name}' — const bindings can't be reassigned after initialization; declare it with let instead`)
    const void_ = ctx.func._expect === 'void'
    const t = temp()
    const va = readVar(name)
    // Condition: ||= → truthy check, &&= → truthy check, ??= → nullish check
    const lhs = typed(['local.tee', `$${t}`, asF64(va)], 'f64')
    const cond = op === '??=' ? isNullish(lhs) : truthyIR(lhs)
    // &&= and ??= assign when cond is true (truthy / nullish); ||= assigns when cond is false
    const repAction = representationBindingWriteAction(ctx, name, val)
    const assigned = asF64(applyBigintRepresentationAction(emit(val), val, repAction))
    const [thenExpr, elseExpr] = op === '||='
      ? [['local.get', `$${t}`], assigned]
      : [assigned, ['local.get', `$${t}`]]
    const result = typed(['if', ['result', 'f64'], cond, ['then', thenExpr], ['else', elseExpr]], 'f64')
    // Write back — writeVar owns the cell/global/local discipline INCLUDING the
    // i32-narrowed-cell width (a direct f64.store here desynced narrowed cells).
    return writeVar(name, result, void_)
  }])),

}
