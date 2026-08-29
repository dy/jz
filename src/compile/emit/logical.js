/**
 * NAN_MINTING/canonNum/canonArm (the NaN-canon trio), the range-check fusion (rangeBound/fuseRangeCheck{,Or}/combineFusedAnd/Or) plus the !/?:/&&/||/??/void/( emitter properties.
 *
 * @module compile/emit/logical
 */

import { OPTF, ctx } from '../../ctx.js'
import {
  applyBigintRepresentationAction, asF64, bigintEraseErr, bigintStrict, block64, boolBoxIR, flat, isLit, isNullish, litVal, resolveValType, temp, tempI32, toBoolFromEmitted, truthyIR, typed, undefExpr,
} from '../../ir.js'
import { valTypeOf } from '../../kind.js'
import { VAL, lookupValType } from '../../reps.js'
import { intLiteralValue } from '../../static.js'
import { extractRefinements, withRefinements } from '../flow-types.js'
import { REP_EDGE_BOX, REP_EDGE_REJECT, representationJoinArmAction } from '../representation-plan.js'
import { tagFnArrayDispatch } from './call.js'
import { numericVal } from './comparisons.js'
import { emit } from './dispatch.js'
import { REF_EQ_KINDS, boolEagerBody, eagerSelectOK, isCanonicalBoolExpr, isNumArm, selectCondOK } from './shared.js'


// f64 arithmetic that can MINT a sign-nondeterministic NaN (0/0, ∞−∞, 0·∞, x%0): on x86
// these are 0xFFF8…, on arm 0x7FF8…. sqrt/min/max/neg are NOT here — they canon at their
// own emit (math.js / unary `-`), so they reach canonNum already canonical.
const NAN_MINTING = new Set(['f64.div', 'f64.add', 'f64.sub', 'f64.mul'])

const canonNum = (node) => {
  // Fold a possibly-non-canonical NaN to the canonical number-NaN before it reaches a
  // bit-comparing consumer (__is_truthy / untyped === / typeof), which match the canonical
  // NaN by bits and so misread x86's 0xFFF8 as truthy. ONLY an un-canon'd NaN-minting
  // arithmetic op can carry such a value — literals, i32-conversions, opaque locals/calls
  // (canonical by the canon-at-source invariant) and already-canon'd shapes don't — so
  // skipping everything else keeps the size win. (The broken middle ground was
  // `02873d0`'s `isNumericIR` skip, which dropped canon for f64.div too → x86 miscompile.)
  const arith = Array.isArray(node) &&
    (NAN_MINTING.has(node[0]) || (node[0] === 'call' && node[1] === '$__rem'))
  if (!arith) return node
  const t = temp('cn')
  return typed(['block', ['result', 'f64'],
    ['local.set', `$${t}`, node],
    ['select',
      ['f64.const', 'nan'],
      ['local.get', `$${t}`],
      ['f64.ne', ['local.get', `$${t}`], ['local.get', `$${t}`]]]], 'f64')
}

// One arm of a two-arm f64 merge (?:, ??, ||, &&) whose result may be bit-tested while
// untyped. Canon (canonNum, a no-op unless the arm is NaN-minting arithmetic) ONLY a
// LONE numeric arm: when both arms are numeric the merge is value-typed NUMBER and read
// NaN-by-value (no canon); when the other arm is opaque the result is untyped, so a
// non-canonical NaN here would be misread by __is_truthy — fold it. A pointer arm
// (isNum=false) is never touched (canon would destroy its NaN-box).
const canonArm = (f, isNum, otherNum) => isNum && !otherNum ? canonNum(f) : f

// One half of a two-sided range test against a compile-time constant, normalized to
// an inclusive bound on a *local* `x`: `{ x, lo }` (x ≥ lo) or `{ x, hi }` (x ≤ hi).
// `>`/`<` fold to the inclusive neighbor; a const on either side is accepted. Returns
// null for anything else (so the caller leaves the expression untouched).
function rangeBound(n) {
  if (!Array.isArray(n) || n.length !== 3) return null
  const lc = intLiteralValue(n[1]), rc = intLiteralValue(n[2])
  if (rc != null && typeof n[1] === 'string') {        // x  op  CONST
    if (n[0] === '>=') return { x: n[1], lo: rc }
    if (n[0] === '>') return { x: n[1], lo: rc + 1 }
    if (n[0] === '<=') return { x: n[1], hi: rc }
    if (n[0] === '<') return { x: n[1], hi: rc - 1 }
  }
  if (lc != null && typeof n[2] === 'string') {        // CONST  op  x
    if (n[0] === '<=') return { x: n[2], lo: lc }
    if (n[0] === '<') return { x: n[2], lo: lc + 1 }
    if (n[0] === '>=') return { x: n[2], hi: lc }
    if (n[0] === '>') return { x: n[2], hi: lc - 1 }
  }
  return null
}

// `x >= LO && x <= HI` (x a pure i32 local, LO ≤ HI constants) → `(x - LO) <=u (HI - LO)`.
// One subtract + one unsigned compare replaces two signed compares, an AND, and the
// short-circuit branch — the classic range-check trick (valid for any integers via
// wrapping subtraction). Returns the fused IR, or null to leave `&&` lowering unchanged.
//
// `&&` parses left-deep, so a 4-conjunct chain `x>=0 && x<W && y>=0 && y<H` is
// `((x>=0 && x<W) && y>=0) && y<H` — the y-pair straddles an intervening `&&` node
// (`y>=0` is that node's right child, `y<H` is `b`), not immediate siblings. When the
// direct match fails and `a` is itself a left-deep `&&`, `b` can still only ever pair
// with the conjunct immediately to its left in evaluation order — `a`'s own right
// child — so retry there. On success, the chain's remaining head (`a[1]`, itself
// possibly hiding another fusable pair) still needs emitting and ANDing onto the
// fused result: `combineFusedAnd` does that, mirroring the '&&' emitter's own
// combine tail below so the eager-AND / short-circuit-if choice stays identical.
// Sound because every fused operand is a side-effect-free comparison (`rangeBound`
// requires a bare identifier against a compile-time constant, never an arbitrary
// expression) and `&&` is associative over pure booleans; `a[1]` still evaluates and
// gates first, so evaluation order and short-circuiting are unchanged — a non-range
// conjunct anywhere in `a[1]` (e.g. `foo() && x>=0 && x<W`) is simply emitted and
// ANDed in, never reordered or dropped.
function fuseRangeCheck(a, b) {
  const ba = rangeBound(a), bb = rangeBound(b)
  if (!ba || !bb || ba.x !== bb.x || (ba.lo != null) === (bb.lo != null)) {
    if (Array.isArray(a) && a[0] === '&&') {
      const fusedTail = fuseRangeCheck(a[2], b)
      if (fusedTail) return combineFusedAnd(a[1], fusedTail)
    }
    return null
  }
  const lo = ba.lo ?? bb.lo, hi = ba.hi ?? bb.hi
  if (lo > hi) return null
  const xv = emit(ba.x)
  if (xv.type !== 'i32') return null                   // f64 (fractional) would mis-fuse
  return typed(['i32.le_u', ['i32.sub', xv, ['i32.const', lo]], ['i32.const', hi - lo]], 'i32')
}

// The complement: `x < LO || x > HI` (the two outside half-checks — one upper-bounded,
// one lower-bounded, with a gap between) → `(x - LO) >u (HI - LO)`, where [LO, HI] is the
// inside range. Same trick, negated; returns null to leave `||` lowering unchanged.
// Same left-deep-chain recursion as `fuseRangeCheck` above, across `||` nodes instead
// of `&&`, combined via `combineFusedOr`.
function fuseRangeCheckOr(a, b) {
  const ba = rangeBound(a), bb = rangeBound(b)
  if (!ba || !bb || ba.x !== bb.x || (ba.lo != null) === (bb.lo != null)) {
    if (Array.isArray(a) && a[0] === '||') {
      const fusedTail = fuseRangeCheckOr(a[2], b)
      if (fusedTail) return combineFusedOr(a[1], fusedTail)
    }
    return null
  }
  const insideLo = (ba.hi ?? bb.hi) + 1, insideHi = (ba.lo ?? bb.lo) - 1
  if (insideLo > insideHi) return null
  const xv = emit(ba.x)
  if (xv.type !== 'i32') return null
  return typed(['i32.gt_u', ['i32.sub', xv, ['i32.const', insideLo]], ['i32.const', insideHi - insideLo]], 'i32')
}

// Combine a chain-recursion "gate" AST node (the left remainder of a `&&`/`||` chain,
// `a[1]` above) with an already-emitted fused-range IR (always i32, canonical 0/1,
// side-effect-free and cheap by construction — see `fuseRangeCheck`/`fuseRangeCheckOr`).
// Mirrors the combine tail of the `'&&'`/`'||'` emitters (below) exactly, just fed a
// pre-built right-hand IR instead of deriving one from a raw `b` AST node via
// `emit(b)`/`isCanonicalBoolExpr(b)` — the fused IR always qualifies as both (i32-typed,
// canonical, `isI32Num` true), so those checks are inlined as always-true rather than
// recomputed. Kept in exact structural lockstep with the emitters so a future edit to
// one is a visible diff away from the other.
function combineFusedAnd(gateNode, fusedIR) {
  const vg = emit(gateNode)
  if (vg.type === 'i32') {
    if (boolEagerBody() && isCanonicalBoolExpr(gateNode) && eagerSelectOK(fusedIR))
      return typed(['i32.and', vg, fusedIR], 'i32')
    const t = tempI32()
    return typed(['if', ['result', 'i32'],
      ['local.tee', `$${t}`, vg],
      ['then', fusedIR],
      ['else', ['local.get', `$${t}`]]], 'i32')
  }
  const t = temp()
  const numA = isNumArm(vg, gateNode)
  const teed = typed(['local.tee', `$${t}`, canonArm(asF64(vg), numA, true)], 'f64')
  if (numA) teed.valKind = VAL.NUMBER
  return typed(['if', ['result', 'f64'], toBoolFromEmitted(teed),
    ['then', canonArm(asF64(fusedIR), true, numA)],
    ['else', ['local.get', `$${t}`]]], 'f64')
}

function combineFusedOr(gateNode, fusedIR) {
  const vg = emit(gateNode)
  if (vg.type === 'i32') {
    if (boolEagerBody() && isCanonicalBoolExpr(gateNode) && eagerSelectOK(fusedIR))
      return typed(['i32.or', vg, fusedIR], 'i32')
    const t = tempI32()
    return typed(['if', ['result', 'i32'],
      ['local.tee', `$${t}`, vg],
      ['then', ['local.get', `$${t}`]],
      ['else', fusedIR]], 'i32')
  }
  const t = temp()
  const numA = isNumArm(vg, gateNode)
  const teed = typed(['local.tee', `$${t}`, asF64(vg)], 'f64')
  if (numA) teed.valKind = VAL.NUMBER
  return typed(['if', ['result', 'f64'], toBoolFromEmitted(teed),
    ['then', ['local.get', `$${t}`]],
    ['else', canonArm(asF64(fusedIR), true, numA)]], 'f64')
}
export const logicalOps = {
  // === Logical ===

  '!': a => {
    const v = emit(a)
    if (v.type === 'i32') return typed(['i32.eqz', v], 'i32')
    // Unboxed pointer offsets: falsy iff zero offset.
    if (v.ptrKind != null) return typed(['i32.eqz', v], 'i32')
    // Known pointer-kinded operand: `!x` is just `x is nullish` (null/undefined).
    // Excludes STRING — empty string '' is a valid (non-null) pointer but is falsy.
    // VAL.BOOL rides the 0/1 numeric carrier (not a pointer), so normalize it to
    // NUMBER and let it fall to the truthy path — `!false` must be `true`.
    const vt = numericVal(resolveValType(a, valTypeOf, lookupValType))
    if (vt && vt !== VAL.NUMBER && vt !== VAL.BIGINT && vt !== VAL.STRING) {
      return isNullish(asF64(v))
    }
    // Route through truthyIR (not a bare __is_truthy) so a NUMBER operand uses the
    // NaN-safe f64 test — `!(0/0)` must be `true` on every platform (x86's sign-set
    // NaN would read as a truthy box through the bit-based __is_truthy).
    return typed(['i32.eqz', truthyIR(v)], 'i32')
  },

  '?:': (a, b, c, self) => {
    // Constant condition → emit only the live branch, but preserve the
    // materialized join's selected edge normalization.
    const ca = emit(a)
    if (isLit(ca)) {
      const v = litVal(ca), arm = (v !== 0 && v === v) ? b : c
      const action = ctx.func._arrayLiteralNeverEscapes ? REP_EDGE_REJECT
        : representationJoinArmAction(ctx, self, arm)
      return applyBigintRepresentationAction(emit(arm), arm, action)
    }
    const cond = toBoolFromEmitted(ca)
    // Flow-sensitive refinement: each arm sees narrowing consistent with `a` being truthy / falsy.
    const thenRefs = extractRefinements(a, new Map(), true)
    const elseRefs = extractRefinements(a, new Map(), false)
    const vb = withRefinements(thenRefs, b, () => emit(b))
    const vc = withRefinements(elseRefs, c, () => emit(c))
    const repB = representationJoinArmAction(ctx, self, b)
    const repC = representationJoinArmAction(ctx, self, c)
    if (!ctx.func._arrayLiteralNeverEscapes && repB !== REP_EDGE_REJECT && repC !== REP_EDGE_REJECT) {
      if (bigintStrict() && (repB === REP_EDGE_BOX || repC === REP_EDGE_BOX))
        bigintEraseErr('ternary-nullish', 'this ternary\'s BigInt arm')
      const fb = asF64(applyBigintRepresentationAction(vb, b, repB))
      const fc = asF64(applyBigintRepresentationAction(vc, c, repC))
      return typed(['f64.reinterpret_i64',
        ['if', ['result', 'i64'], cond,
          ['then', ['i64.reinterpret_f64', fb]],
          ['else', ['i64.reinterpret_f64', fc]]]], 'f64')
    }
    // A BOOL arm beside a non-BOOL, non-NUMBER arm: the merge kills the static
    // type, so the boolean's identity is observable only through its atom box —
    // materialize it per-arm here, BEFORE the raw-bit collapses below erase it
    // (`i ? true : [from, len]` — watr's rec-type marker — must yield TRUE_NAN,
    // not 1.0). BOOL∪NUMBER stays raw: VT['?:'] carries NUMBER there (the raw
    // 0/1 IS the bool's ToNumber image — the benign numeric-context lie), and
    // both-BOOL arms keep vt BOOL and stay raw 0/1 by design.
    {
      const vtbM = resolveValType(b, valTypeOf, lookupValType)
      const vtcM = resolveValType(c, valTypeOf, lookupValType)
      if ((vtbM === VAL.BOOL) !== (vtcM === VAL.BOOL) &&
          (vtbM === VAL.BOOL ? vtcM : vtbM) !== VAL.NUMBER) {
        const fb = vtbM === VAL.BOOL ? boolBoxIR(vb) : asF64(vb)
        const fc = vtcM === VAL.BOOL ? boolBoxIR(vc) : asF64(vc)
        const ib = ['i64.reinterpret_f64', fb], ic = ['i64.reinterpret_f64', fc]
        const bits = eagerSelectOK(fb, fc) && selectCondOK(cond)
          ? ['select', ib, ic, cond]
          : ['if', ['result', 'i64'], cond, ['then', ib], ['else', ic]]
        return typed(['f64.reinterpret_i64', bits], 'f64')
      }
    }
    // `cond ? 1 : 0` is the condition bit itself; `cond ? 0 : 1` its negation. `cond`
    // (truthyIR) is already canonical 0/1, so the select + two const arms collapse to
    // the bit. (Both arms are literals here, so dropping their emitted IR is side-effect
    // free.) Mirrors what `+(x > 0)` already produces.
    if (isLit(vb) && isLit(vc)) {
      const lb = litVal(vb), lc = litVal(vc)
      if (lb === 1 && lc === 0) return typed(cond, 'i32')
      if (lb === 0 && lc === 1) return typed(['i32.eqz', cond], 'i32')
    }
    // L: Use WASM select for pure ternaries — branchless, smaller bytecode
    if (vb.type === 'i32' && vc.type === 'i32') {
      // A single i32 select is only sound when BOTH arms' i32 carriers mean the same
      // thing to the downstream asF64 — otherwise the result is interpreted one way and
      // the other arm's value is corrupted. Two compatible shapes:
      //   • both non-pointer i32 (numbers/bools) → asF64 numeric-converts, correct; or
      //   • both the SAME pointer kind+aux → result carries that ptrKind so asF64 takes
      //     the NaN-rebox path (and boxPtrIR's single aux slot is the shared one).
      // Anything else — a pointer arm beside a number/bool arm, two different pointer
      // kinds, or the same kind with diverging aux (polymorphic OBJECT schemaIds, TYPED
      // element types) — must fall through to the f64 path, where each arm is asF64'd
      // independently and reboxed with its own kind/aux in the NaN-box. The pre-4.x bug:
      // a pointer arm vs a `true`/number arm took the i32 select, dropped the ptrKind,
      // and `f64.convert_i32_s` numeric-converted the pointer bits — so `cond ? obj : 1`
      // lost its object-ness (typeof → "number").
      const bothPlain = vb.ptrKind == null && vc.ptrKind == null
      const samePtr = vb.ptrKind != null && vb.ptrKind === vc.ptrKind
        && (vb.ptrAux ?? null) === (vc.ptrAux ?? null)
      // A plain arm can ALSO carry `.unsigned` (a proven-uint32 magnitude, cf. ir.js
      // asF64: `n.unsigned ? convert_i32_u : convert_i32_s`) — the same single-widen-
      // after-select hazard the ptrKind check above guards against applies to sign:
      // asF64 widens the JOINED select's result ONCE, with ONE signedness, so a single
      // i32 select is sound only when both plain arms AGREE (pointer arms don't carry
      // `.unsigned`, so samePtr is always "agreement"). Disagreement falls through to
      // the general per-arm asF64 path below (the SAME one a ptrKind mismatch already
      // falls through to) — it widens each arm independently, so it's correct by
      // construction for exactly this reason, no separate branch needed here.
      const signOK = !bothPlain || !!vb.unsigned === !!vc.unsigned
      if ((bothPlain || samePtr) && signOK) {
        const tagPtr = (n) => {
          if (vb.ptrKind != null && vb.ptrKind === vc.ptrKind) {
            n.ptrKind = vb.ptrKind
            if (vb.ptrAux != null && vb.ptrAux === vc.ptrAux) n.ptrAux = vb.ptrAux
          }
          // Agreement propagated onto the joined node so the caller's OWN asF64
          // (this select's result is itself just another i32-typed IR node) converts
          // with the right sign instead of defaulting to signed.
          if (bothPlain && vb.unsigned && vc.unsigned) n.unsigned = true
          return n
        }
        if (eagerSelectOK(vb, vc) && selectCondOK(cond))
          return tagPtr(typed(['select', vb, vc, cond], 'i32'))
        return tagPtr(typed(['if', ['result', 'i32'], cond, ['then', vb], ['else', vc]], 'i32'))
      }
    }
    const fb = asF64(vb), fc = asF64(vc)
    const vtb = resolveValType(b, valTypeOf, lookupValType)
    const vtc = resolveValType(c, valTypeOf, lookupValType)
    const isNaNBoxLit = n => Array.isArray(n) && n[0] === 'f64.const' && typeof n[1] === 'string' && n[1].startsWith('nan:')
    const refPayload = (vtb && vtb === vtc && REF_EQ_KINDS.has(vtb))
      || vb.closureFuncIdx != null || vc.closureFuncIdx != null
      || isNaNBoxLit(fb) || isNaNBoxLit(fc)
    const numericB = isNumArm(vb, b, vtb)
    const numericC = isNumArm(vc, c, vtc)
    // Peephole: `cond ? 1 : 0` (or `cond ? 0 : 1`) is just `f64.convert_i32_s(cond)` —
    // the select collapses because cond is already 0/1. Saves 5 instructions.
    const isOneZero = (one, zero) => {
      const o = one, z = zero
      return o.type === 'i32' && Array.isArray(o) && o[0] === 'i32.const' && o[1] === 1 &&
             z.type === 'i32' && Array.isArray(z) && z[0] === 'i32.const' && z[1] === 0
    }
    if ((isOneZero(vb, vc) || isOneZero(vc, vb)) && !numericB && !numericC) {
      const condBool = truthyIR(emit(a))
      const n = isOneZero(vb, vc)
        ? typed(['f64.convert_i32_s', condBool], 'f64')
        : typed(['f64.convert_i32_s', ['i32.eqz', condBool]], 'f64')
      n.valKind = VAL.NUMBER
      return n
    }
    const branchB = canonArm(fb, numericB, numericC), branchC = canonArm(fc, numericC, numericB)
    const markNumeric = (n) => {
      if (numericB && numericC) n.valKind = VAL.NUMBER
      return n
    }
    if (refPayload) {
      const ib = ['i64.reinterpret_f64', branchB]
      const ic = ['i64.reinterpret_f64', branchC]
      const bits = eagerSelectOK(branchB, branchC) && selectCondOK(cond)
        ? ['select', ib, ic, cond]
        : ['if', ['result', 'i64'], cond, ['then', ib], ['else', ic]]
      return typed(['f64.reinterpret_i64', bits], 'f64')
    }
    if (!refPayload && eagerSelectOK(branchB, branchC) && selectCondOK(cond))
      return markNumeric(typed(['select', branchB, branchC, cond], 'f64'))
    return markNumeric(typed(['if', ['result', 'f64'], cond, ['then', branchB], ['else', branchC]], 'f64'))
  },

  '&&': (a, b, self) => {
    // Plan-materialized BigInt∪other join (C5b, mirrors '?:'s materialized
    // fast path above): both arms proven box-or-keep-able into this join's
    // BOXED_BIGINT target. `a` is BOTH the condition and (when falsy) a
    // surfacing arm, so it's tee'd: truthiness is tested on its RAW value
    // (boxing first would corrupt a falsy BigInt 0n's own truthiness), and
    // only the arm that actually surfaces gets its representation action
    // applied. When the join isn't materialized both actions are
    // REP_EDGE_REJECT (a cheap WeakSet miss) and every branch below runs
    // exactly as before — this check never changes non-bigint codegen.
    const repA0 = representationJoinArmAction(ctx, self, a)
    const repB0 = representationJoinArmAction(ctx, self, b)
    if (!ctx.func._arrayLiteralNeverEscapes && repA0 !== REP_EDGE_REJECT && repB0 !== REP_EDGE_REJECT) {
      const va0 = emit(a)
      const t0 = temp()
      const teed0 = typed(['local.tee', `$${t0}`, asF64(va0)], 'f64')
      const rightRefs0 = extractRefinements(a, new Map(), true)
      const vb0 = withRefinements(rightRefs0, b, () => emit(b))
      const faBoxed = applyBigintRepresentationAction(typed(['local.get', `$${t0}`], 'f64'), a, repA0)
      const fb0 = asF64(applyBigintRepresentationAction(vb0, b, repB0))
      return typed(['f64.reinterpret_i64',
        ['if', ['result', 'i64'], toBoolFromEmitted(teed0),
          ['then', ['i64.reinterpret_f64', fb0]],
          ['else', ['i64.reinterpret_f64', faBoxed]]]], 'f64')
    }
    // Range-check fusion: `x >= LO && x <= HI` (x a pure i32 local, LO ≤ HI compile-time
    // constants) collapses to one unsigned compare `(x - LO) <=u (HI - LO)` — a subtract
    // plus a branch instead of two compares, an AND, and a short-circuit branch. This is
    // the per-char cost in scanners/parsers (digit/alpha classification) and in any
    // two-sided bounds check. Restricted to a local `x` so evaluating it once (the fused
    // form) matches the original's twice-read, side-effect-free semantics.
    const fused = fuseRangeCheck(a, b)
    if (fused) return fused
    const va = emit(a)
    // Constant-folded literal: pre-bind under truthy refinements (b runs only when a was truthy).
    if (isLit(va)) {
      const v = litVal(va)
      if (v !== 0 && v === v) {
        const refs = extractRefinements(a, new Map(), true)
        return withRefinements(refs, b, () => emit(b))
      }
      return va
    }
    // a is truthy in the right-arm — narrow b accordingly. Matches `?:`'s then-arm threading
    // (`Array.isArray(x) && x[0]` → x[0] sees x as ARRAY, eliding union-rep fallbacks).
    const rightRefs = extractRefinements(a, new Map(), true)
    // Guarded indexed-closure dispatch: `(name = V[idx]) && name(args)` —
    // subscript's parse.step idiom for "look up a handler, call it if present."
    // `a`'s assignment (emitted normally, above) already set `name` from
    // `V[idx]`; `b`'s callee, though syntactically a bare identifier, is
    // PROVABLY that same read — tag the resulting call_indirect the same way
    // a direct `V[idx](args)` gets tagged (emitGenericClosureCall below), so
    // devirtConstFnArrayCalls can rewrite it once dyn-closure-tables.js proves
    // V monomorphic. An unresolved/untagged V just leaves the tag inert.
    const dvArrName = (ctx.transform.optFlags & OPTF.devirtClosureTables) && Array.isArray(a) && a[0] === '=' &&
      typeof a[1] === 'string' && Array.isArray(a[2]) && a[2][0] === '[]' &&
      typeof a[2][1] === 'string' && ctx.scope.dynFnTableCandidates?.has(a[2][1]) &&
      Array.isArray(b) && b[0] === '()' && b[1] === a[1] ? a[2][1] : null
    const emitRight = () => {
      const vr = withRefinements(rightRefs, b, () => emit(b))
      return dvArrName ? tagFnArrayDispatch(vr, dvArrName) : vr
    }
    // Mixed BOOL/non-NUMBER sides: the merge kills the static type (VT['&&']
    // returns null), so a surfacing bool must carry its atom box — same rule as
    // the `?:` arm materialization above. Both-BOOL and BOOL∪NUMBER stay raw.
    {
      const vtA = resolveValType(a, valTypeOf, lookupValType)
      const vtB = resolveValType(b, valTypeOf, lookupValType)
      if ((vtA === VAL.BOOL) !== (vtB === VAL.BOOL) && (vtA === VAL.BOOL ? vtB : vtA) !== VAL.NUMBER) {
        const t = temp()
        const fa = vtA === VAL.BOOL ? boolBoxIR(va) : asF64(va)
        const fb0 = emitRight()
        const fb = vtB === VAL.BOOL ? boolBoxIR(fb0) : asF64(fb0)
        return typed(['if', ['result', 'f64'],
          toBoolFromEmitted(typed(['local.tee', `$${t}`, fa], 'f64')),
          ['then', fb],
          ['else', ['local.get', `$${t}`]]], 'f64')
      }
    }
    // i32 fast path: use i32 tee as cond directly (nonzero=truthy in wasm `if`),
    // skip f64 round-trip and __is_truthy call entirely.
    if (va.type === 'i32') {
      const vb = emitRight()
      // Boolean-only short circuit with a pure RHS is safe to evaluate
      // eagerly. Comparisons are canonical 0/1, so bitwise AND preserves the
      // value while removing the nested if/tee ladder in scalar predicates.
      if (vb.type === 'i32' && boolEagerBody() && isCanonicalBoolExpr(a) && isCanonicalBoolExpr(b) && eagerSelectOK(vb))
        return typed(['i32.and', va, vb], 'i32')
      const t = tempI32()
      if (vb.type === 'i32') {
        // This if-join's else-arm (a falsy) is PROVABLY `local.get $t` === 0: the
        // wasm `if` cond IS va's own bits tested nonzero, so the only bit pattern
        // that ever reaches the else-arm is all-zero — and 0 means the same thing
        // signed or unsigned. So va's OWN `.unsigned` can never affect this join's
        // value; only vb (returned verbatim when a is truthy) can surface a real
        // magnitude. Unlike '?:' (9c313e58) and '||' below, there is no second arm
        // for vb to disagree WITH — the joined node just inherits vb's sign outright,
        // no agreement gate needed.
        const node = typed(['if', ['result', 'i32'],
          ['local.tee', `$${t}`, va],
          ['then', vb],
          ['else', ['local.get', `$${t}`]]], 'i32')
        if (vb.unsigned) node.unsigned = true
        return node
      }
      return typed(['if', ['result', 'f64'],
        ['local.tee', `$${t}`, va],
        ['then', asF64(vb)],
        ['else', typed(['f64.convert_i32_s', ['local.get', `$${t}`]], 'f64')]], 'f64')
    }
    const t = temp()
    const numA = isNumArm(va, a)
    const vb = emitRight(), numB = isNumArm(vb, b)
    // `a` is the else-arm result (returned when falsy — incl NaN), so canon a lone-numeric
    // `a` before the tee: `$t` then feeds both the result and the cond canonically.
    const teed = typed(['local.tee', `$${t}`, canonArm(asF64(va), numA, numB)], 'f64')
    // A numeric left arm tests truthiness NaN-by-value (not __is_truthy, which mis-reads
    // x86's sign-set NaN as truthy) — tag it so truthyIR takes that path.
    if (numA) teed.valKind = VAL.NUMBER
    return typed(['if', ['result', 'f64'], toBoolFromEmitted(teed),
      ['then', canonArm(asF64(vb), numB, numA)],
      ['else', ['local.get', `$${t}`]]], 'f64')
  },

  '||': (a, b, self) => {
    // Plan-materialized BigInt∪other join (C5b) — mirror of '&&' above with
    // the then/else arms swapped: `a` surfaces (tee'd, RAW truthiness test)
    // when truthy, `b` only when `a` was falsy. See '&&'s comment for why
    // truthiness is tested before any boxing and why a REJECTed action
    // (the common case) leaves every branch below byte-for-byte unchanged.
    const repA0 = representationJoinArmAction(ctx, self, a)
    const repB0 = representationJoinArmAction(ctx, self, b)
    if (!ctx.func._arrayLiteralNeverEscapes && repA0 !== REP_EDGE_REJECT && repB0 !== REP_EDGE_REJECT) {
      const va0 = emit(a)
      const t0 = temp()
      const teed0 = typed(['local.tee', `$${t0}`, asF64(va0)], 'f64')
      const rightRefs0 = extractRefinements(a, new Map(), false)
      const vb0 = withRefinements(rightRefs0, b, () => emit(b))
      const faBoxed = applyBigintRepresentationAction(typed(['local.get', `$${t0}`], 'f64'), a, repA0)
      const fb0 = asF64(applyBigintRepresentationAction(vb0, b, repB0))
      return typed(['f64.reinterpret_i64',
        ['if', ['result', 'i64'], toBoolFromEmitted(teed0),
          ['then', ['i64.reinterpret_f64', faBoxed]],
          ['else', ['i64.reinterpret_f64', fb0]]]], 'f64')
    }
    // Outside-range fusion (the complement of `&&`): `x < LO || x > HI` → one unsigned
    // compare `(x - LO) >u (HI - LO)`. Common in validation (`if (c < 'a' || c > 'z') …`).
    const fusedOr = fuseRangeCheckOr(a, b)
    if (fusedOr) return fusedOr
    const va = emit(a)
    // Constant-folded literal: pre-bind under falsy refinements (b runs only when a was falsy).
    if (isLit(va)) {
      const v = litVal(va)
      if (v !== 0 && v === v) return va
      const refs = extractRefinements(a, new Map(), false)
      return withRefinements(refs, b, () => emit(b))
    }
    // a is falsy in the right-arm — `x == null || ...` proves x is null/undefined in b;
    // De Morgan'd via the sense=false branch of extractRefinements (mirrors the ?: else-arm).
    const rightRefs = extractRefinements(a, new Map(), false)
    const emitRight = () => withRefinements(rightRefs, b, () => emit(b))
    // Mixed BOOL/non-NUMBER sides — see `&&`: a surfacing bool carries its atom box.
    {
      const vtA = resolveValType(a, valTypeOf, lookupValType)
      const vtB = resolveValType(b, valTypeOf, lookupValType)
      if ((vtA === VAL.BOOL) !== (vtB === VAL.BOOL) && (vtA === VAL.BOOL ? vtB : vtA) !== VAL.NUMBER) {
        const t = temp()
        const fa = vtA === VAL.BOOL ? boolBoxIR(va) : asF64(va)
        const fb0 = emitRight()
        const fb = vtB === VAL.BOOL ? boolBoxIR(fb0) : asF64(fb0)
        return typed(['if', ['result', 'f64'],
          toBoolFromEmitted(typed(['local.tee', `$${t}`, fa], 'f64')),
          ['then', ['local.get', `$${t}`]],
          ['else', fb]], 'f64')
      }
    }
    if (va.type === 'i32') {
      const vb = emitRight()
      // Boolean twin of && above: eager pure RHS + canonical 0/1 values make
      // bitwise OR exactly equivalent to short-circuit OR.
      if (vb.type === 'i32' && boolEagerBody() && isCanonicalBoolExpr(a) && isCanonicalBoolExpr(b) && eagerSelectOK(vb))
        return typed(['i32.or', va, vb], 'i32')
      const t = tempI32()
      // Unlike `&&` above, this if-join's THEN-arm (a truthy) returns va's own
      // value verbatim — so, like '?:' (9c313e58), BOTH arms can surface an
      // independent real magnitude here (the else-arm returns vb whenever a was
      // falsy, unconstrained). A single downstream asF64 can only apply ONE sign
      // to whichever branch fires at runtime, so the single-i32-if fast path is
      // sound only when the two arms AGREE; disagreement (or a non-i32 vb) widens
      // each arm with its OWN sign inside the if instead (still one branch, no
      // extra control flow) — asF64(vb) already respects vb.unsigned, the va side
      // just needs the same sign-aware conversion instead of a hardcoded signed one.
      const signOK = vb.type === 'i32' && !!va.unsigned === !!vb.unsigned
      if (signOK) {
        const node = typed(['if', ['result', 'i32'],
          ['local.tee', `$${t}`, va],
          ['then', ['local.get', `$${t}`]],
          ['else', vb]], 'i32')
        if (va.unsigned && vb.unsigned) node.unsigned = true
        return node
      }
      return typed(['if', ['result', 'f64'],
        ['local.tee', `$${t}`, va],
        ['then', typed([va.unsigned ? 'f64.convert_i32_u' : 'f64.convert_i32_s', ['local.get', `$${t}`]], 'f64')],
        ['else', asF64(vb)]], 'f64')
    }
    const t = temp()
    const numA = isNumArm(va, a)
    const vb = emitRight(), numB = isNumArm(vb, b)
    // `a` (then-arm) is returned only when truthy — hence never NaN — so it needs no canon;
    // the cond's NaN-safety comes from the valKind tag. Only the else (b) arm can surface
    // as a numeric NaN.
    const teed = typed(['local.tee', `$${t}`, asF64(va)], 'f64')
    if (numA) teed.valKind = VAL.NUMBER   // numeric left arm: NaN-safe truthiness (see `&&`)
    return typed(['if', ['result', 'f64'], toBoolFromEmitted(teed),
      ['then', ['local.get', `$${t}`]],
      ['else', canonArm(asF64(vb), numB, numA)]], 'f64')
  },

  // a ?? b: returns b only if a is nullish
  '??': (a, b, self) => {
    // Plan-materialized BigInt∪other join (C5b) — see '&&'s comment. `??`'s
    // condition is nullishness, not truthiness, but the same tee-before-box
    // discipline applies: test on `a`'s raw value, box only the arm that
    // actually surfaces.
    const repA0 = representationJoinArmAction(ctx, self, a)
    const repB0 = representationJoinArmAction(ctx, self, b)
    if (!ctx.func._arrayLiteralNeverEscapes && repA0 !== REP_EDGE_REJECT && repB0 !== REP_EDGE_REJECT) {
      const va0 = emit(a), vb0 = emit(b)
      const t0 = temp()
      const teed0 = typed(['local.tee', `$${t0}`, asF64(va0)], 'f64')
      const faBoxed = applyBigintRepresentationAction(typed(['local.get', `$${t0}`], 'f64'), a, repA0)
      const fb0 = asF64(applyBigintRepresentationAction(vb0, b, repB0))
      return typed(['f64.reinterpret_i64',
        ['if', ['result', 'i64'], ['i32.eqz', isNullish(teed0)],
          ['then', ['i64.reinterpret_f64', faBoxed]],
          ['else', ['i64.reinterpret_f64', fb0]]]], 'f64')
    }
    const va = emit(a), vb = emit(b)
    const t = temp()
    // Mixed BOOL/non-NUMBER sides — see `&&`: a surfacing bool carries its atom box.
    {
      const vtA = resolveValType(a, valTypeOf, lookupValType)
      const vtB = resolveValType(b, valTypeOf, lookupValType)
      if ((vtA === VAL.BOOL) !== (vtB === VAL.BOOL) && (vtA === VAL.BOOL ? vtB : vtA) !== VAL.NUMBER) {
        const fa = vtA === VAL.BOOL ? boolBoxIR(va) : asF64(va)
        const fb = vtB === VAL.BOOL ? boolBoxIR(vb) : asF64(vb)
        return typed(['if', ['result', 'f64'],
          ['i32.eqz', isNullish(['local.tee', `$${t}`, fa])],
          ['then', ['local.get', `$${t}`]],
          ['else', fb]], 'f64')
      }
    }
    const numA = isNumArm(va, a), numB = isNumArm(vb, b)
    // Both arms can surface as the (untyped) result — `a` when non-nullish (a NaN is not
    // nullish, so it IS returned), `b` otherwise. Canon a lone-numeric arm; `a` before the
    // tee so `local.get $t` is canonical. The cond is isNullish, robust to non-canon NaN.
    return typed(['if', ['result', 'f64'],
      ['i32.eqz', isNullish(['local.tee', `$${t}`, canonArm(asF64(va), numA, numB)])],
      ['then', ['local.get', `$${t}`]],
      ['else', canonArm(asF64(vb), numB, numA)]], 'f64')
  },

  'void': a => {
    const v = emit(a)
    const dropAndUndef = (instr) => block64(instr, 'drop', undefExpr())
    if (v == null) return undefExpr()
    const op = Array.isArray(v) ? v[0] : null
    const wasmVoid = op === 'local.set' || (typeof op === 'string' && op.endsWith('.store'))
      || op === 'memory.copy' || op === 'global.set'
    if (wasmVoid)
      return block64(v, undefExpr())
    if (v.type && v.type !== 'void')
      return dropAndUndef(v)
    return block64(...flat(v), undefExpr())
  },

  '(': a => emit(a),

}
