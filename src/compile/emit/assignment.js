/**
 * compoundAssign plus the =/+=/-=/*=//=/%=/**=/&=/|=/^=/>>=/<<=/>>>=/||=/&&=/??= emitter properties.
 *
 * @module compile/emit/assignment
 */

import { ctx, err } from '../../ctx.js'
import {
  applyBigintRepresentationAction, asF64, boxBigInt, f64rem, fromI64, isConst, isNullish, isNullishLit, readI64, readVar, temp, toNumF64, truthyIR, typed, writeVar,
} from '../../ir.js'
import { valTypeOf } from '../../kind.js'
import { VAL } from '../../reps.js'
import { emitElementAssign, emitPropertyAssign } from '../emit-assign.js'
import { withInitializerScope } from '../flow-state.js'
import {
  REP_EDGE_BOX, representationBindingWriteAction, representationCompoundAssignAction,
} from '../representation-plan.js'
import { plannedTypedStorageCtor } from '../typed-storage-plan.js'
import { I64_ARITH_OP, bigIntDivIR, bigIntDomainsCanMix, bigIntOperand, bigintMixReject } from './bigint.js'
import { emit, rejectAmbiguousBoolIdentity } from './dispatch.js'
import { isSideEffectFree } from './shared.js'
import {
  addBoundedFaithful, addFitsI32, addRangeFitsI32, mulBoundedFaithful, mulFitsI32, mulRangeFitsI32, subRangeFitsI32,
} from './i32-bounds.js'


// A member reference's receiver or key with an effect (a call, a write, an
// accessor read) is evaluated once, into a temp, before the read and the RHS
// (JS: the reference, then GetValue, then the RHS, then PutValue through the
// same reference). The temp carries the expression's facts (value kind,
// typed constructor, schema), so the read and the write lower as the
// expression would have. A reference without effects is read twice as it
// was: the optimizers recognize that shape. A plain write (`update` false)
// stages only its receiver: the store emitters evaluate the key once
// themselves, and the store's own index shapes (`a[i++] = v`, a proven
// length) stay theirs.
const readsAccessor = (n) => {
  if (!Array.isArray(n)) return false
  if ((n[0] === '.' || n[0] === '?.') && typeof n[2] === 'string' && ctx.transform.accessorNames?.has(n[2])) return true
  for (let i = 1; i < n.length; i++) if (readsAccessor(n[i])) return true
  return false
}
const effectful = (n) => Array.isArray(n) && (!isSideEffectFree(n) || readsAccessor(n))
function stagedReference(name, update = true) {
  if (!Array.isArray(name) || (name[0] !== '.' && name[0] !== '[]')) return null
  const pre = []
  const stage = (node, tag, always = false) => {
    if (!always && !effectful(node)) return node
    const h = temp(tag)
    const vt = valTypeOf(node)
    if (vt) ctx.func.localValTypesOverlay.set(h, vt)
    const ctor = vt === VAL.TYPED ? plannedTypedStorageCtor(ctx, node) : null
    if (ctor) (ctx.func.localTypedElemsOverlay ||= new Map()).set(h, ctor)
    const sid = vt === VAL.OBJECT ? ctx.summary?.at(ctx.func.current).objectSidOfExpr(node) : null
    if (sid != null) (ctx.func.refinements ??= new Map()).set(h, { schemaId: sid })   // the transient channel ctx.schema.idOf reads first
    pre.push(['local.set', `$${h}`, asF64(emit(node))])
    return h
  }
  // A key with an effect may reassign the receiver's binding: the receiver is
  // taken first, whatever it is.
  const keyEffect = update && name[0] === '[]' && effectful(name[2])
  const recv = keyEffect && typeof name[1] === 'string' ? stage(name[1], 'ref', true) : stage(name[1], 'ref')
  const key = keyEffect ? stage(name[2], 'key') : name[2]
  return pre.length ? { ref: [name[0], recv, key], pre } : null
}
const afterStaging = (pre, out) => out?.type ? typed(['block', ['result', out.type], ...pre, out], out.type) : ['block', ...pre, ...(out ? [out] : [])]
/** Lower a compound member write through its staged reference: `build` receives the reference to read and write. */
function throughReference(name, build) {
  const staged = stagedReference(name)
  if (!staged) return build(name)
  return afterStaging(staged.pre, build(staged.ref))
}
/** `ref op= val` as `ref = ref op val`: the rebuilt binary keeps the plan's
 *  compound identity, so its BigInt arm is boxed for the tagged slot it
 *  lands in (representationComputedExprAction). */
const memberCompound = (op, name, val) => throughReference(name, ref => {
  const bin = [op, ref, val]
  ctx.plans.compoundOf.set(bin, ref)
  return emit(['=', ref, bin])
})

/** Compound assignment: read → op → write back (via readVar/writeVar).
 *  `arithOp` (one of '+' '-' '*' '/' '%') is the base symbol for BigInt routing.
 *  Bitwise assignments use the ordinary binary/assignment lowering. */
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
  // A target or operand whose BigInt domain is known at runtime alone (a
  // tagged local beside a BigInt literal): the binary form's joint dispatch
  // decides, throwing on a Number beside a BigInt, and the compound identity
  // boxes the BigInt arm on the way back (`value -= 4n` on a Number|BigInt
  // local ran i64 arithmetic on the Number's bits).
  if (arithOp && typeof name === 'string' && bigIntDomainsCanMix(name, val, true)) {
    const bin = [arithOp, name, val]
    ctx.plans.compoundOf.set(bin, name)
    return emit(['=', name, bin])
  }
  if (arithOp && (valTypeOf(name) === VAL.BIGINT || valTypeOf(val) === VAL.BIGINT)) {
    bigintMixReject(`${arithOp}=`, name, val)
    // `name` is always a bare identifier here — censusMaybeUndefined never fires
    // true for it (that predicate only matches `.`/`[]`/`.get()` AST shapes), so
    // readVar(name) stays the plain raw path; only `val` (the RHS, which CAN be a
    // dict/Map maybeUndefined read) needs bigIntOperand's runtime guard.
    const left = readI64(name, readVar(name)), right = bigIntOperand(val)
    const rawBits = arithOp === '/' || arithOp === '%'
      ? bigIntDivIR(arithOp, left, right) : [`i64.${I64_ARITH_OP[arithOp]}`, left, right]
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
  // `%` is inherently sound on this path, so it stays ungated.
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
    // A member write takes its reference once, before the RHS: the element
    // store emits the receiver in more than one position (the address, the
    // bounds guard), and a member's `++`/`--` (prepare: `m = m ± 1`, `+1`/`-1`
    // an op of its own; a plan rewrite may have copied the reference) reads
    // and writes through the same reference.
    if (Array.isArray(name) && (name[0] === '[]' || name[0] === '.')) {
      const update = Array.isArray(val) && (val[0] === '+1' || val[0] === '-1')
      const staged = stagedReference(name, update)
      if (staged) return afterStaging(staged.pre, emit(['=', staged.ref, update ? [val[0], staged.ref] : val]))
    }
    if (Array.isArray(name) && name[0] === '[]') return emitElementAssign(name[1], name[2], val)
    if (Array.isArray(name) && name[0] === '.')  return emitPropertyAssign(name[1], name[2], val)
    if (Array.isArray(name) && name[0] === '.raw')  return emitPropertyAssign(name[1], name[2], val, true)   // the accessor probe's plain-store arm
    if (typeof name !== 'string') err(`Assignment to non-variable: ${JSON.stringify(name)} — jz assigns to a plain variable, obj.prop, or arr[i] only`)
    // Plain reassignment (`x = …`, `name` already bound) reaches a DIFFERENT
    // emitter than a decl-with-init (emitDecl above) — the ambiguous-identity
    // REJECT lived only on the decl path, so `let x; x = false ?? 1` (and any
    // later `typeof x`/`x === false`) skipped it entirely and silently kept
    // the collapsed raw-NUMBER carrier (audit-#12 BOOL_CARRIER family). Same
    // helper, same contract: rejects only when SOME use of `name` actually
    // observes its identity — a truthiness-only reassignment still compiles.
    rejectAmbiguousBoolIdentity(name, val)
    if (isNullishLit(val)) (ctx.func.maybeNullish ??= new Set()).add(name)   // null-flow: later arithmetic on this var coerces
    const void_ = ctx.func._expect === 'void'
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
    let ev = withInitializerScope(selfAccum ? name : null, neverEscapes, () => emit(val))
    const repAction = representationBindingWriteAction(ctx, name, val)
    ev = applyBigintRepresentationAction(ev, val, repAction)
    return writeVar(name, ev, void_, val)
  },

  // Compound assignments: read-modify-write with type coercion
  '+=': (name, val) => {
    // A member: the same binary and write lowering through the reference, evaluated once.
    if (typeof name !== 'string') return memberCompound('+', name, val)
    // String concatenation: desugar to name = name + val (+ handler knows about strings).
    // Also desugar when either side has unknown type — the `+` operator picks runtime
    // string/numeric dispatch (`__is_str_key`); compoundAssign would force f64.add and
    // silently corrupt string concatenations through unknown-typed values. The rebuilt
    // node keeps the plan's compound identity (ctx.plans.compoundOf) so a tagged
    // binding's BigInt arm is boxed on the way back.
    const vt = typeof name === 'string' ? valTypeOf(name) : null
    const vtB = valTypeOf(val)
    if (vt === VAL.STRING || vtB === VAL.STRING || ((vt == null || vtB == null) && ctx.core.stdlib['__str_concat'])) {
      const sum = ['+', name, val]
      ctx.plans.compoundOf.set(sum, name)
      return emit(['=', name, sum])
    }
    return compoundAssign(name, val, (a, b) => typed(['f64.add', a, b], 'f64'), (a, b) => typed(['i32.add', a, b], 'i32'), '+')
  },
  ...Object.fromEntries([
    ['-=', 'sub'], ['*=', 'mul'], ['/=', 'div'],
  ].map(([op, fn]) => [op, (name, val) => {
    const sym = op.slice(0, -1)
    if (typeof name !== 'string') return memberCompound(sym, name, val)
    return compoundAssign(name, val,
      (a, b) => typed([`f64.${fn}`, a, b], 'f64'),
      fn === 'div' ? null : (a, b) => typed([`i32.${fn}`, a, b], 'i32'),
      sym
    )
  }])),
  '%=': (name, val) => {
    if (typeof name !== 'string') return memberCompound('%', name, val)
    return compoundAssign(name, val, f64rem, (a, b) => typed(['i32.rem_s', a, b], 'i32'), '%')
  },
  // `**` is always f64 (and has its own const-exponent lowering) — full desugar.
  '**=': (name, val) => throughReference(name, ref => emit(['=', ref, ['**', ref, val]])),

  // Bare bindings normalize before planning. Remaining member assignments
  // share the same binary operation and write path, not a second i64 gate.
  ...Object.fromEntries(['&=', '|=', '^=', '<<=', '>>=', '>>>='].map(op =>
    [op, (name, val) => memberCompound(op.slice(0, -1), name, val)]
  )),

  // Logical compound assignments: a ||= b → a = a || b, a &&= b → a = a && b
  // Logical/nullish compound assignments: read → check → conditionally write
  // For complex LHS (obj.prop, arr[i]): emit as check(read(lhs)) ? write(lhs, val) : read(lhs)
  ...Object.fromEntries(['||=', '&&=', '??='].map(op => [op, (name, val) => {
    // A member: read, test, and write through the reference, evaluated once.
    if (typeof name !== 'string') {
      const baseOp = op.slice(0, -1) // '||', '&&', '??'
      return throughReference(name, ref => emit([baseOp, ref, ['=', ref, val]]))
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
