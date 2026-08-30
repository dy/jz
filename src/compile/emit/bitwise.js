/**
 * INT_MIN_I32, tryIntDivTrunc (the '|'-handler's (x/y)|0 idiom fold) plus the ~/&/|/^/<</>>/>>> emitter properties.
 *
 * @module compile/emit/bitwise
 */

import { ctx, err } from '../../ctx.js'
import { asF64, asI32, emitNum, fromI64, isLit, litVal, toI32, toNumF64, typed } from '../../ir.js'
import { censusMaybeUndefinedKind, valTypeOf } from '../../kind.js'
import { VAL, repOf } from '../../reps.js'
import { intExprRange, intLiteralValue } from '../../static.js'
import { exprType } from '../../type.js'
import {
  bigIntDomainsCanMix, bigIntJointDispatch, bigIntOperand, bigIntShiftIR, bigIntUnary, bigintMixReject, computedBoxOf,
} from './bigint.js'
import { emit } from './dispatch.js'
import { isI32Num } from './shared.js'


// `(a / b) | 0` (the JS integer-division idiom) → i32.div_s. jz otherwise lowers `/`
// to f64.div + ToInt32, paying two i32→f64 converts and the trunc; i32.div_s is
// direct and lets the wasm backend magic-multiply a constant divisor. Bit-exact for
// all i32 a,b: |a|<2³³≪2⁵³ so the f64 quotient never rounds across the truncation
// boundary — EXCEPT b=0 (`(a/0)|0` is ToInt32(±Inf)=0, but i32.div_s traps) and
// INT_MIN/-1 (ToInt32 wraps to INT_MIN, i32.div_s traps); both guarded. A constant
// divisor folds the guards away. `exprType==='i32'` excludes unsigned operands
// (those return 'f64'), where div_s would misread the sign. Returns IR or null.
const INT_MIN_I32 = -2147483648
function tryIntDivTrunc(aNode, bNode) {
  const o = ctx.transform.optimize
  if (!o || o.intDivLower === false) return null
  const L = ctx.func.locals
  if (exprType(aNode, L) !== 'i32' || exprType(bNode, L) !== 'i32') return null
  const dv = intLiteralValue(bNode)
  if (dv != null) {                         // constant divisor — no runtime guard
    const va = asI32(emit(aNode))
    if (dv === 0) return typed(['block', ['result', 'i32'], ['drop', va], ['i32.const', 0]], 'i32')
    if (dv === -1) return typed(['i32.sub', ['i32.const', 0], va], 'i32')  // -a, wraps at INT_MIN
    // Power-of-two divisor with a PROVEN-non-negative dividend truncates the
    // same as a logical shift (`(dq/65536)|0` ≡ `dq >>> 16` for dq ≥ 0 — the
    // q16 fixed-point split). intExprRange supplies the proof through masked/
    // ternary/bounded-product decl chains; sdiv is ~13 cycles, shr is 1.
    if (dv > 0 && (dv & (dv - 1)) === 0) {
      const r = intExprRange(aNode)
      if (r && r[0] >= 0) return typed(['i32.shr_u', va, ['i32.const', 31 - Math.clz32(dv)]], 'i32')
    }
    return typed(['i32.div_s', va, ['i32.const', dv | 0]], 'i32')
  }
  // Runtime divisor needs a,b repeated across the guard; only intercept when both are
  // simple re-emittable operands (var / literal) so re-emit is pure and side-effect-free.
  const simple = (n) => typeof n === 'string' || intLiteralValue(n) != null
  if (!simple(aNode) || !simple(bNode)) return null
  const A = () => asI32(emit(aNode)), B = () => asI32(emit(bNode))
  return typed(['if', ['result', 'i32'], ['i32.eqz', B()],
    ['then', ['i32.const', 0]],
    ['else', ['if', ['result', 'i32'],
      ['i32.and', ['i32.eq', A(), ['i32.const', INT_MIN_I32]], ['i32.eq', B(), ['i32.const', -1]]],
      ['then', A()],
      ['else', ['i32.div_s', A(), B()]]]]], 'i32')
}
export const bitwiseOps = {
  // === Bitwise (i32 for numbers, i64 for BigInt) ===

  // Per ECMAScript ToInt32, bitwise ops first ToNumber-coerce non-numeric operands.
  // i32 / lit values are already numeric — the toNumF64 wrap is skipped to keep
  // the numeric fast path at one wasm instruction. Non-numeric (NaN-boxed string,
  // unknown type) routes through __to_num so "2026" | 0 === 2026.
  // `~~x` is the idiomatic int32 truncation: the two xor-with-(-1) cancel, leaving
  // a single toI32 (whose NaN/Infinity guard runs once, unchanged). Fold it here so
  // DSP/bytebeat `~~` doesn't emit a dead double-xor watr won't remove.
  '~':   (a, self) => {
    if (typeof a === 'string' && repOf(a)?.localMapBigintUnknown)
      err('Unary ~ on a local Map value with control-dependent BigInt writes is not supported; branch on presence/type before applying it')
    if (Array.isArray(a) && a[0] === '~') {
      const inner = a[1]
      // ~~x === x for BigInt; the int32-truncation fold below is number-only.
      if (valTypeOf(inner) === VAL.BIGINT) return emit(inner)
      const iv = emit(inner)
      return isLit(iv) ? emitNum(~~litVal(iv)) : typed(toI32(isI32Num(iv) ? iv : toNumF64(inner, iv)), 'i32')
    }
    // BigInt complement is the i64 `x ^ -1` (all bits flipped), like emitNeg's i64.sub.
    // bigIntUnary: a maybeUndefined-BIGINT operand's real
    // JS value is ToInt32(NaN)'s complement, NUMBER -1 — not `x ^ -1` on the raw
    // UNDEF_NAN sentinel bits (see emitNeg's identical substitution above).
    // `|| censusMaybeUndefinedKind(a) === VAL.BIGINT` — see emitNeg's identical
    // OR-arm comment (§6/§12 Slice 5): keeps this gate VT-Slice-4-independent.
    if (valTypeOf(a) === VAL.BIGINT || censusMaybeUndefinedKind(a) === VAL.BIGINT)
      return bigIntUnary(a, i64v => ['i64.xor', i64v, ['i64.const', -1]], ['f64.const', -1], computedBoxOf(self))
    const v = emit(a); return isLit(v) ? emitNum(~litVal(v)) : typed(['i32.xor', toI32(isI32Num(v) ? v : toNumF64(a, v)), typed(['i32.const', -1], 'i32')], 'i32')
  },
  ...Object.fromEntries([
    ['&', 'and'], ['|', 'or'], ['^', 'xor'], ['<<', 'shl'], ['>>', 'shr_s'],
  ].map(([op, fn]) => [op, (a, b, self) => {
    // §14 point 4: joint runtime-domain dispatch — see '-'s identical comment
    // above. Number-domain branch mirrors the generic i32 fast path below
    // (`toI32`/`i32.${fn}`) exactly, widened back to f64 via `asF64`.
    if (bigIntDomainsCanMix(a, b, true)) {
      bigintMixReject(op, a, b)
      return bigIntJointDispatch(a, b,
        op === '<<' || op === '>>' ? (ia, ib) => bigIntShiftIR(op, ia, ib) : (ia, ib) => [`i64.${fn}`, ia, ib],
        (fa, fb) => asF64(typed([`i32.${fn}`, toI32(fa), toI32(fb)], 'i32')), computedBoxOf(self))
    }
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT) {
      bigintMixReject(op, a, b)
      // `<<`/`>>` need the sign-aware direction flip (bigIntShiftIR) — see its
      // own doc comment. `&`/`|`/`^` have no such hazard (bitwise ops are
      // direction-symmetric; only a shift COUNT's sign is meaningful).
      if (op === '<<' || op === '>>') return fromI64(bigIntShiftIR(op, bigIntOperand(a), bigIntOperand(b)))
      return fromI64([`i64.${fn}`, bigIntOperand(a), bigIntOperand(b)])
    }
    if (op === '|') {  // `(x / y) | 0` integer-division idiom → i32.div_s
      const divN = intLiteralValue(b) === 0 ? a : intLiteralValue(a) === 0 ? b : null
      if (Array.isArray(divN) && divN[0] === '/') { const r = tryIntDivTrunc(divN[1], divN[2]); if (r) return r }
    }
    const va = emit(a), vb = emit(b)
    if (isLit(va) && isLit(vb)) {
      const la = litVal(va), lb = litVal(vb)
      if (op === '&') return emitNum(la & lb); if (op === '|') return emitNum(la | lb)
      if (op === '^') return emitNum(la ^ lb); if (op === '<<') return emitNum(la << lb)
      if (op === '>>') return emitNum(la >> lb)
    }
    const ca = isI32Num(va) || isLit(va) ? va : toNumF64(a, va)
    const cb = isI32Num(vb) || isLit(vb) ? vb : toNumF64(b, vb)
    return typed([`i32.${fn}`, toI32(ca), toI32(cb)], 'i32')
  }])),
  '>>>': (a, b) => {
    // BigInt has no unsigned right shift — ES2020 §6.1.6.2.11 defines no
    // BigInt::unsignedRightShift; `>>>`'s abstract operation for a BigInt
    // operand throws TypeError unconditionally (unlike the signed bitwise
    // ops above, which fall to i64.shr_s/etc — `>>>` has no i64 arm at all
    // to fall to). Checked before either side emits, so no side effect runs
    // ahead of the throw.
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT)
      err('BigInt has no unsigned right shift (>>>) — TypeError in JS; convert with Number(x) first if you need an unsigned shift')
    const va = emit(a), vb = emit(b)
    if (isLit(va) && isLit(vb)) {
      const r = litVal(va) >>> litVal(vb) // JS uint32 result ∈ [0, 2^32)
      // ≥ 2^31 doesn't fit signed i32: materialize the wrapped bits as an i32 const
      // tagged `.unsigned` so `asF64` lifts via `convert_i32_u`. Emitting `f64.const r`
      // here (the old foldConst path) would `trunc_sat_f64_s`-saturate to INT32_MAX
      // when the enclosing function narrows to an i32 result. Values < 2^31 fold to a
      // plain i32 const (signed == unsigned, stays foldable downstream).
      if (r >= 0x80000000) { const node = typed(['i32.const', r | 0], 'i32'); node.unsigned = true; return node }
      return emitNum(r)
    }
    // F: Mark unsigned so `asF64` lifts via `f64.convert_i32_u` (preserving the
    // [0, 2^32) value range). Without this, `(s >>> 0) / 4294967296` would convert
    // signed for negative-high-bit s values, flipping sign and breaking the
    // canonical "uint32 → f64" idiom used in PRNGs and bit-manipulation code.
    const ca = isI32Num(va) || isLit(va) ? va : toNumF64(a, va)
    const cb = isI32Num(vb) || isLit(vb) ? vb : toNumF64(b, vb)
    const node = typed(['i32.shr_u', toI32(ca), toI32(cb)], 'i32')
    node.unsigned = true
    return node
  },

}
