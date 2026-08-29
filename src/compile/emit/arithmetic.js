/**
 * peelI32, tryI32Arith, widensUnsigned, stripCanon, emitNeg, foldConst plus the +, -, u+, u-, *, / and % emitter properties.
 *
 * @module compile/emit/arithmetic
 */

import { ctx, err, inc } from '../../ctx.js'
import {
  FALSE_NAN, NULL_NAN, TRUE_NAN, asF64, asI32, asI64, block64, emitNum, f64rem, fromI64, isLit, isPostfix, isPureIR, litVal, readI64, temp, toNumF64, toStrI64, typed, withTemp,
} from '../../ir.js'
import { censusMaybeUndefined, censusMaybeUndefinedKind, valTypeOf } from '../../kind.js'
import { VAL } from '../../reps.js'
import { exprType } from '../../type.js'
import {
  bigIntDomainsCanMix, bigIntJointDispatch, bigIntOperand, bigIntUnary, bigintMemberAssignTarget, bigintMixReject, computedBoxOf,
} from './bigint.js'
import { emit, emitBoolStr, tryConcatChain } from './dispatch.js'
import {
  addBoundedFaithful, addFitsI32, addLiteralFitsI32, addRangeFitsI32, i32Mag, mulBoundedFaithful, mulFitsI32, mulRangeFitsI32, subLiteralFitsI32, subRangeFitsI32,
} from './i32-bounds.js'
import { foldOperandPure, isI32Num, isLit1, isNumArm } from './shared.js'


// Peel an emitted operand back to its raw i32 value when it carries one: a value already
// typed i32 (integer literals included — they emit as i32.const), or an integer read wrapped
// in f64.convert_i32_s/u (typed-array / i32-global reads default to the f64 rep). Else null.
const peelI32 = (v) =>
  isI32Num(v) ? v
    : (Array.isArray(v) && (v[0] === 'f64.convert_i32_s' || v[0] === 'f64.convert_i32_u'))
      ? (Array.isArray(v[1]) ? typed(v[1], 'i32') : v[1])
      : null

// Native wrapping i32 arithmetic for `+`/`-`/`*` whose result is consumed as i32. Peels the
// f64.convert_i32_s/u that integer reads (`DX[i]`, a global Int32Array) wrap their load in, so
// `ax = ax + DX[i]` (ax and DX[i] both i32) lowers to one i32.add instead of the
// convert → f64.add → trunc_sat round-trip that doubled hot integer loops (ulam's spiral walk,
// ring-buffer indexing). Bit-identical for an i32 result: ToInt32(exact) ≡ two's-complement wrap.
// Gated on exprType(whole expr)==='i32' so an f64-consumed sum — or an unsigned-wide (uint32)
// operand, which exprType already reports as f64 — still widens. Returns null when inapplicable.
// Widening contract: this is the DECIDE side of the numeric widening invariant —
// the mirror (exprType's i32/f64 prediction) and the full rule set live in
// src/type.js's header. Edit either side only with the other open.
const tryI32Arith = (wasmOp, astOp, a, b, va, vb) => {
  const pa = peelI32(va); if (pa == null) return null
  const pb = peelI32(vb); if (pb == null) return null
  if (exprType([astOp, a, b], ctx.func.locals, undefined, true) !== 'i32') return null
  return typed([wasmOp, pa, pb], 'i32')
}

// An operand whose uint32 value can be *observed as a JS number* — a `>>>`
// result, an `unsignedResult` call, or an unsigned i32.const. Its magnitude can
// exceed signed-i32 range, so wrapping i32 arithmetic would corrupt it; widen to
// f64 instead. A `.wrapSafe` operand is also unsigned but is a `narrowUint32`
// accumulator read proven to be re-truncated by a `>>>` (ToUint32) sink at every
// use — wrapping is exactly its intended semantics, so it stays on the i32 path.
const widensUnsigned = (v) => v.unsigned && !v.wrapSafe

// Strip a redundant NaN-canon wrapper (math.js `canon`) from an operand that
// feeds a NaN-propagating f64 op. `f64.sqrt`/`min`/`max` mint a sign-nondeterministic
// NaN that math.js canon-izes so it can't be bit-confused with a NaN-boxed pointer in
// `===`/`typeof`. But when the result flows straight into `f64.add`/`sub`/`mul`/`div`,
// the consumer propagates that NaN identically and is itself canon-ized if IT escapes —
// so the inner per-op canon (local.set + select + f64.ne, ~3 ops) is dead on the
// critical path. This is THE gap that put sqrt-heavy kernels ~23% behind V8
// (julia/raymarcher/boids); stripping it makes them match native JS.
const stripCanon = (v) => {
  if (!v) return v
  if (v.canonOf != null) return typed(v.canonOf, 'f64')
  // A NaN-canon nested in the VALUE arm of a `select` / `(if result f64)` is equally
  // dead: the consumer that called stripCanon (f64.add/sub/mul/div, or a math call)
  // propagates the NaN identically and the outermost escape re-canon-izes. Recurse into
  // the arms so `(cond ? x : -x) + v` (the Perlin-gradient sign-select, and every other
  // conditional negation) drops the per-neg select+f64.ne, same as a bare `x + -y`.
  if (Array.isArray(v)) {
    if (v[0] === 'select' && v.length === 4) {
      const a = stripCanon(v[1]), b = stripCanon(v[2])
      if (a !== v[1] || b !== v[2]) return typed(['select', a, b, v[3]], 'f64')
    } else if (v[0] === 'if' && Array.isArray(v[1]) && v[1][0] === 'result' && v[1][1] === 'f64'
               && Array.isArray(v[3]) && v[3][0] === 'then' && v[3].length === 2
               && Array.isArray(v[4]) && v[4][0] === 'else' && v[4].length === 2) {
      const t = stripCanon(v[3][1]), e = stripCanon(v[4][1])
      if (t !== v[3][1] || e !== v[4][1]) return typed(['if', v[1], v[2], ['then', t], ['else', e]], 'f64')
    } else if (v[0] === 'local.get' && typeof v[1] === 'string') {
      // hoistNestedCalls' temp (see isHoistTemp above) severs the structural link a
      // direct inline expression would keep: `const __tmp = sinTau(ph)` stores the
      // FULL (possibly canon-guarded) return value, and the use site sees only a
      // fresh `local.get $__tmp` with no `.canonOf` of its own. Since the temp is
      // single-def/single-use by construction, its ONE reader gets to decide whether
      // the guard is dead — recurse into the recorded def and, if anything strips,
      // mutate that def NODE IN PLACE (same array object the earlier `local.set`
      // already references) so the guard is gone at its one definition, not recomputed
      // here. The read itself stays a bare `local.get` either way.
      const def = ctx.func.hoistTempDefs?.get(v[1].slice(1))
      if (def) {
        const stripped = stripCanon(def)
        if (stripped !== def) {
          for (let i = 0; i < stripped.length; i++) def[i] = stripped[i]
          def.length = stripped.length
          def.type = stripped.type
        }
      }
    }
  }
  return v
}

/** Emit unary negation: constant-fold, or i32 sub from 0 / f64.neg. */
const emitNeg = (a, self) => {
  // BigInt operands (literal or otherwise) always carry VAL.BIGINT statically —
  // a bigint LITERAL is the self-describing `['bigint', decimalStr]` node
  // (kind.js VT.bigint), never a raw `[null, number]` node (audit P0-2: the
  // parser tags bigint literals structurally, off the source `n` suffix, so
  // there's no longer a bit-pattern to conflate with a genuine subnormal
  // NUMBER literal here — see parse.js). No magnitude heuristic needed for
  // literals; the runtime magnitude heuristic (emit.js TYPEOF.bigint) remains
  // for genuinely dynamic/unknown-kind values, a separate, real carrier limit.
  // `|| censusMaybeUndefinedKind(a) === VAL.BIGINT` (.work/archive/todo.md
  // §deletion-sweep §6/§12 Slice 5): a census-shaped operand's exact-kind claim reaches
  // `valTypeOf` here only via VT['[]']/['.']/['()']'s own Slice-4 exact-kind
  // promotion (kind.js) — a SEPARATE mechanism from the census helpers
  // (dictValueKindOf/mapValueKindOf) themselves, which this OR-arm consults
  // DIRECTLY (censusMaybeUndefinedKind, unchanged since Slice 1/79082fb2). Keeps
  // this activation gate reachable for a dynamic dict/Map-read operand
  // independent of whether that promotion stays wired.
  if (valTypeOf(a) === VAL.BIGINT || censusMaybeUndefinedKind(a) === VAL.BIGINT)
    return bigIntUnary(a, i64v => ['i64.sub', ['i64.const', 0], i64v], ['f64.const', 'nan'], computedBoxOf(self))
  const v = emit(a)
  // `.unsigned` carries its uint32 value as a signed i32 bit pattern (litVal/i32.sub
  // both read that raw pattern), so negating either fast path directly negates the
  // WRONG number for any magnitude ≥ 2^31 (e.g. `-h` on a `(…) >>> 0` accumulator
  // holding 3000000000 gave 1294967296, not -3000000000). A literal still folds —
  // just via its true unsigned value; a runtime i32 widens through the f64 path
  // below, whose `toNumF64` → `asF64` already convert_i32_u's an `.unsigned` operand.
  if (isLit(v)) return emitNum(-(v.unsigned ? litVal(v) >>> 0 : litVal(v)))
  if (isI32Num(v) && !v.unsigned) return typed(['i32.sub', typed(['i32.const', 0], 'i32'), v], 'i32')
  // f64.neg flips the sign bit, so negating a NaN yields 0xFFF8.. — a non-canonical
  // number-NaN that overlaps the NaN-boxed value space (jz reserves 0x7FF8.. as THE
  // number-NaN). `__is_truthy`/`__eq` compare against that exact pattern, so a sign-
  // flipped NaN reads as a tagged value (truthy / not-NaN). Fold any NaN result back
  // to canonical — the same invariant math.sqrt/min/max keep via `canon` (module/math.js).
  const t = temp('ng')
  const raw = ['f64.neg', toNumF64(a, v)]
  const ir = typed(['block', ['result', 'f64'],
    ['local.set', `$${t}`, raw],
    ['select', ['f64.const', 'nan'], ['local.get', `$${t}`],
      ['f64.ne', ['local.get', `$${t}`], ['local.get', `$${t}`]]]], 'f64')
  // Tag the un-canon'd `f64.neg` so a NaN-propagating consumer (f64.add/sub/mul/div, which
  // canon-ize on their OWN escape) strips this redundant inner canon — same contract as the
  // sqrt/min/max canons in math.js. A bare `x * -y` / `a - -b` then drops the per-neg
  // select + f64.ne instead of carrying it into the multiply/add.
  ir.canonOf = raw
  return ir
}

/** Try constant-folding binary arith: returns emitNum(result) or null. */
// `.unsigned` literals carry a uint32 value whose i32 `litVal` is its *signed* bit
// pattern (e.g. `-1` for 4294967295), so folding them through `fn` numerically would
// be wrong. Bail to the runtime path — the arithmetic handlers widen unsigned operands
// to f64 (convert_i32_u), reproducing the JS-spec result.
const foldConst = (va, vb, fn, guard) =>
  isLit(va) && isLit(vb) && !va.unsigned && !vb.unsigned && (!guard || guard(litVal(vb)))
    ? emitNum(fn(litVal(va), litVal(vb))) : null
export const arithmeticOps = {
  // === Arithmetic (type-preserving) ===

  // Postfix in void: (++i)-1 / (--i)+1 → just ++i / --i
  '+': (a, b, self) => {
    if (ctx.func._expect === 'void' && isPostfix(a, '--', b)) return emit(a, 'void')
    // Postfix `n--` value-position recovery `(--n) + 1`: prepare wraps the '--'
    // in an outer `+ 1` to hand back the OLD value. The literal `1` here is a
    // compiler-synthesized correction constant, not a user-facing operand — it
    // must never trip bigintMixReject's TypeError (that guard exists for genuine
    // source-level BigInt/Number mixing). When n is proven BIGINT, '--' has
    // already produced the correctly-typed i64 result (see the '++'/'--' table
    // entry above); recover the old value with the same i64.add-by-constant
    // shape instead of falling into the generic BIGINT-mix check below.
    if (isPostfix(a, '--', b) && valTypeOf(a) === VAL.BIGINT)
      return fromI64(['i64.add', readI64(a, emit(a)), ['i64.const', 1]])
    // Member BIGINT `obj.p++`'s postfix OLD-value recovery — see
    // bigintMemberAssignTarget above.
    if (isLit1(b) && bigintMemberAssignTarget(a))
      return fromI64(['i64.add', readI64(a, emit(a)), ['i64.const', 1]])
    // A self-accumulation `a = a + …` lets the concat bump-EXTEND `a` in place (a is dead-after).
    // Read it for THIS concat, then clear so nested operands (not the accumulation target) stay fresh.
    const selfAccum = typeof a === 'string' && a === ctx.func._selfAccumConcat
    ctx.func._selfAccumConcat = null
    // String concat-CHAIN fusion: `i + ',' + name + ',' + v + '\n'` is
    // left-associated pairwise `+`, and pairwise lowering re-copies the whole
    // growing prefix at every step (triangular bytes moved, one fresh heap
    // buffer per `+`). Flatten the chain and emit ONE measure→alloc→copy pass
    // instead. Fusion crosses a nested `+` only when a side is statically
    // string-ish (so a numeric `1 + 2 + s` keeps its numeric ADD as a single
    // leaf); ToString order stays left-to-right (leaves evaluate in order).
    // A self-accumulating head (`line = line + a + b`) keeps leaf 0 pairwise
    // so the O(1) bump-extend accumulator survives — only the tail fuses.
    {
      const fused = tryConcatChain(a, b, selfAccum)
      if (fused) return fused
    }
    // String concatenation: pure string operands skip generic ToString coercion.
    const vtA = valTypeOf(a)
    const vtB = valTypeOf(b)
    // mayBeUndefined join (Slice 3, .work/archive/todo.md §deletion-sweep
    // §4 — the "NEWLY added" `+` STRING-concat gap): a STRING claim whose only
    // proof is a maybeUndefined-flagged dict/Map census read (or a bare name
    // that copies one through) is "every value ever WRITTEN was a string", not
    // "this key exists" — the actual runtime value can be real `undefined`,
    // whose ToString is `"undefined"`, not raw string bits. concatRaw below
    // reinterprets its operands' bits AS string pointers with zero coercion —
    // sound only when both sides are GENUINELY strings. Gated out of both the
    // raw-concat fast path (no censusMaybeUndefined guard at all before this
    // fix) and coercionFree's STRING arm just below (which otherwise treated
    // the same unproven claim as "already a string, skip ToString") so a
    // flagged operand always falls through to the explicit `strI64`/toStrI64
    // coercion — that function's OWN existing censusMaybeUndefined guard
    // already stringifies the sentinel correctly ("undefined", not garbage).
    const stringSafe = (vt, n) => vt === VAL.STRING && !censusMaybeUndefined(n)
    if (stringSafe(vtA, a) && stringSafe(vtB, b)) {
      // Fused append-byte: `buf += s[i]` skips 1-char SSO construction + generic concat dispatch
      // when rhs is a string-index. The byte flows straight from __char_at into memory and bump-
      // EXTENDS the heap-top lhs — so only when proven self-accumulating (else it mutates a live s).
      if (selfAccum && Array.isArray(b) && b[0] === '[]' && ctx.core.stdlib['__str_append_byte'] && ctx.core.stdlib['__char_at']) {
        if (valTypeOf(b[1]) === VAL.STRING) {
          inc('__str_append_byte', '__char_at')
          return typed(['call', '$__str_append_byte',
            asI64(emit(a)),
            ctx.abi.string.ops.charCodeAt(asF64(emit(b[1])), asI32(emit(b[2])), ctx),
          ], 'f64')
        }
      }
      return typed(ctx.abi.string.ops.concatRaw(asF64(emit(a)), asF64(emit(b)), ctx, selfAccum), 'f64')
    }
    if (vtA === VAL.STRING || vtB === VAL.STRING) {
      // An OBJECT operand coerces via ToPrimitive(string) at compile time —
      // __str_concat's runtime __to_str cannot invoke a user-defined toString.
      // A BOOL operand renders "true"/"false" rather than its 0/1 carrier.
      const strOperand = (vt, n) => vt === VAL.OBJECT ? typed(['f64.reinterpret_i64', toStrI64(n, emit(n))], 'f64')
        : vt === VAL.BOOL ? emitBoolStr(n) : asF64(emit(n))
      // Coercion-free sides are already strings: a known STRING is raw; OBJECT/BOOL
      // were stringified by `strOperand`. An unknown side still needs ToString, but
      // we can apply it *once* (explicit `__to_str` via `strI64`) and join with
      // concatRaw — equivalent to `__str_concat`'s internal `__to_str` on that side,
      // while NOT re-coercing the already-string side. This drops the redundant
      // per-append `__to_str` on the accumulator in `s += part` (s proven STRING):
      //   - both coercion-free  → concatRaw(ea, eb)
      //   - one unknown         → concatRaw(known, __to_str(unknown))
      //   - both unknown        → cat (unchanged; its runtime __to_str covers both)
      // STRING arm reuses stringSafe (defined above) — a mayBeUndefined-flagged
      // STRING claim is NOT coercion-free (see that comment); OBJECT/BOOL are
      // unaffected (strOperand already applies real coercion for those, never
      // a raw-bits passthrough, so no census claim to falsify there).
      const coercionFree = (vt, n) => stringSafe(vt, n) || vt === VAL.OBJECT || vt === VAL.BOOL
      const cfA = coercionFree(vtA, a), cfB = coercionFree(vtB, b)
      const strI64 = (n) => typed(['f64.reinterpret_i64', toStrI64(n, emit(n))], 'f64')
      if (cfA && cfB) return typed(ctx.abi.string.ops.concatRaw(strOperand(vtA, a), strOperand(vtB, b), ctx, selfAccum), 'f64')
      if (cfA) return typed(ctx.abi.string.ops.concatRaw(strOperand(vtA, a), strI64(b), ctx, selfAccum), 'f64')
      if (cfB) return typed(ctx.abi.string.ops.concatRaw(strI64(a), strOperand(vtB, b), ctx, selfAccum), 'f64')
      return typed(ctx.abi.string.ops.cat(strOperand(vtA, a), strOperand(vtB, b), ctx, selfAccum), 'f64')
    }
    // §14 point 4: joint runtime-domain dispatch (see its own doc comment
    // above bigIntDomain) — `allowUnresolved=false`: a fully unresolved
    // operand here could ALSO be a runtime STRING, which must still reach
    // the STRING-coercion dispatch below, not this BigInt-only check.
    if (bigIntDomainsCanMix(a, b, false)) {
      bigintMixReject('+', a, b)
      return bigIntJointDispatch(a, b,
        (ia, ib) => ['i64.add', ia, ib],
        (fa, fb) => typed(['f64.add', fa, fb], 'f64'), computedBoxOf(self))
    }
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT) {
      bigintMixReject('+', a, b)
      return fromI64(['i64.add', bigIntOperand(a), bigIntOperand(b)])
    }
    // Runtime string dispatch when at least one side could be a string. When one side has
    // a known non-STRING vtype, skip its `__is_str_key` (statically false). Common in
    // chained additions `s + a*b + c.d` — left grows as `+` (=NUMBER), only the new right
    // operand needs the runtime check.
    if ((vtA == null || vtB == null) && ctx.core.stdlib['__str_concat']) {
      const tA = temp('add'), tB = temp('add')
      // Fully-untyped `+`: the string arm is a runtime-guarded cold path that the engine reaches
      // only if BOTH operands are strings at runtime, so it keeps the bump-extend `__str_concat`
      // (its body stays out-of-line — folding it to the smaller _fresh twin would inline this
      // never-numeric branch into every hot integer loop). The demonstrated `t = s + "lit"` mutation
      // is a TYPED concat (handled by concatRaw above); a both-untyped self-mutation stays the
      // documented rare-aliasing tradeoff. Self-accumulation is still safe to extend.
      inc('__str_concat', '__is_str_key')
      const eA = vtA == null ? asF64(emit(a)) : null
      const eB = vtB == null ? asF64(emit(b)) : null
      const checkA = eA ? ['call', '$__is_str_key', ['i64.reinterpret_f64', ['local.tee', `$${tA}`, eA]]] : null
      const checkB = eB ? ['call', '$__is_str_key', ['i64.reinterpret_f64', ['local.tee', `$${tB}`, eB]]] : null
      const concat = ['call', '$__str_concat', ['i64.reinterpret_f64', ['local.get', `$${tA}`]], ['i64.reinterpret_f64', ['local.get', `$${tB}`]]]
      // Numeric arm: an UNKNOWN operand may still be a non-string NaN-box (bool
      // atom, null) whose ToNumber is not its raw bits — `true + 1` is 2,
      // `null + 1` is 1. Guard with the self-compare (every non-NaN f64 IS its
      // own ToNumber; two inline ops on the hot path); the cold arm is the
      // inline ATOM ladder, not __to_num — strings can't reach here (the
      // __is_str_key fork above took them) and objects stay jz-permissive NaN
      // either way, so the full ToNumber (and the number↔string formatter tree
      // it pins — the dyn-object golden) buys nothing. Skipped when the side is
      // known-vt (raw carrier by design) or IR-shape numeric (isNumArm — keeps
      // floatbeat kernels at their box-free ratchet counts).
      const numSide = (t, e, node) => {
        if (!e || isNumArm(e, node)) return ['local.get', `$${t}`]
        const bits = ['i64.reinterpret_f64', ['local.get', `$${t}`]]
        return ['if', ['result', 'f64'],
          ['f64.eq', ['local.get', `$${t}`], ['local.get', `$${t}`]],
          ['then', ['local.get', `$${t}`]],
          ['else', ['select',
            ['f64.const', 1],
            ['select',
              ['f64.const', 0],
              ['f64.const', 'nan'],
              ['i32.or', ['i64.eq', bits, ['i64.const', FALSE_NAN]], ['i64.eq', bits, ['i64.const', NULL_NAN]]]],
            ['i64.eq', bits, ['i64.const', TRUE_NAN]]]]]
      }
      const add    = ['f64.add', numSide(tA, eA, a), numSide(tB, eB, b)]
      if (checkA && checkB) {
        return typed(['if', ['result', 'f64'], ['i32.or', checkA, checkB], ['then', concat], ['else', add]], 'f64')
      }
      // Exactly one side is checked. Pre-eval the known side first, then the if branches on the unknown.
      const preEval = vtA == null ? ['local.set', `$${tB}`, asF64(emit(b))] : ['local.set', `$${tA}`, asF64(emit(a))]
      return block64(
        preEval,
        ['if', ['result', 'f64'], checkA ?? checkB, ['then', concat], ['else', add]])
    }
    const va = emit(a), vb = emit(b), _f = foldConst(va, vb, (a, b) => a + b)
    if (_f) return _f
    // Neither side is a string here (string paths handled above), but either may
    // still be null/undefined/pointer — numeric `+` performs ToNumber like `-`/`*`.
    if (isLit(vb) && litVal(vb) === 0) return toNumF64(a, va)
    if (isLit(va) && litVal(va) === 0) return toNumF64(b, vb)
    // An `.unsigned` operand is a uint32 (range [0, 2^32)); JS `+` is a float
    // op whose result can exceed i32, so `i32.add` would wrap (4294967295+1→0).
    // Widen to f64 — never wrap — matching spec. Only `>>>0`/`|0`/imul wrap.
    if (isI32Num(va) && isI32Num(vb) && !widensUnsigned(va) && !widensUnsigned(vb)
        && (addFitsI32(va, vb) || addBoundedFaithful(va, vb) || addRangeFitsI32(a, b) || addLiteralFitsI32(a, b)))
      return typed(['i32.add', va, vb], 'i32')
    const i32add = tryI32Arith('i32.add', '+', a, b, va, vb); if (i32add) return i32add
    return typed(['f64.add', stripCanon(toNumF64(a, va)), stripCanon(toNumF64(b, vb))], 'f64')
  },
  '-': (a, b, self) => {
    if (ctx.func._expect === 'void' && isPostfix(a, '++', b)) return emit(a, 'void')
    // Postfix `n++` value-position recovery `(++n) - 1` — mirror of the '+'
    // handler's `(--n) + 1` case just above; see its comment for why this
    // bypasses bigintMixReject (compiler-synthesized constant, not a source mix).
    if (isPostfix(a, '++', b) && valTypeOf(a) === VAL.BIGINT)
      return fromI64(['i64.sub', readI64(a, emit(a)), ['i64.const', 1]])
    // Member BIGINT `obj.p--`'s postfix OLD-value recovery — see
    // bigintMemberAssignTarget above ('+').
    if (isLit1(b) && bigintMemberAssignTarget(a))
      return fromI64(['i64.sub', readI64(a, emit(a)), ['i64.const', 1]])
    // §14 point 4: joint runtime-domain dispatch (see bigIntDomain's own doc
    // comment) — binary form only; `b === undefined` here is unary minus
    // (reached through this same table entry, see the plain OR-gate below),
    // a single-operand op with no second domain to mix against.
    // `f1c1256b`'s own pinned KNOWN-FAIL (`let x = BigInt(v); return x - w`,
    // `w` a zero-evidence dynamic param) closes here: `valTypeOfWithLocals`
    // (kind.js) already proves `x` BIGINT for the export-lane decode, but the
    // WASM computation below still took `x`'s proof as license to treat `w`'s
    // raw bits as an i64 carrier unconditionally, with no runtime check that
    // `w` genuinely IS one — `bigIntDomainsCanMix`/`bigIntJointDispatch`
    // (allowUnresolved=true — no STRING ambiguity for `-`, unlike `+`) close
    // that gap the same way as the census-vs-census/census-vs-proven shapes.
    if (b !== undefined && bigIntDomainsCanMix(a, b, true)) {
      bigintMixReject('-', a, b)
      return bigIntJointDispatch(a, b,
        (ia, ib) => ['i64.sub', ia, ib],
        (fa, fb) => typed(['f64.sub', fa, fb], 'f64'), computedBoxOf(self))
    }
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT) {
      bigintMixReject('-', a, b)
      // b===undefined here is UNARY minus (0n - a) reached through this same table
      // entry — a single-operand op, so a maybeUndefined `a` decays to NaN in real
      // JS, never a TypeError (see bigIntOperand's doc comment). Leave its asI64
      // untouched; only the genuinely two-operand form below gets the runtime guard.
      return b === undefined
        ? fromI64(['i64.sub', ['i64.const', 0], readI64(a, emit(a))])
        : fromI64(['i64.sub', bigIntOperand(a), bigIntOperand(b)])
    }
    if (b === undefined) return emitNeg(a, self)
    const va = emit(a), vb = emit(b), _f = foldConst(va, vb, (a, b) => a - b)
    if (_f) return _f
    if (isLit(vb) && litVal(vb) === 0) return toNumF64(a, va)
    // Unsigned uint32 operand: JS `-` is float (can go negative / exceed i32),
    // so avoid the wrapping i32.sub fast-path. See `+` above.
    if (isI32Num(va) && isI32Num(vb) && !widensUnsigned(va) && !widensUnsigned(vb)
        && (addFitsI32(va, vb) || addBoundedFaithful(va, vb) || subRangeFitsI32(a, b) || subLiteralFitsI32(a, b)))
      return typed(['i32.sub', va, vb], 'i32')
    const i32sub = tryI32Arith('i32.sub', '-', a, b, va, vb); if (i32sub) return i32sub
    return typed(['f64.sub', stripCanon(toNumF64(a, va)), stripCanon(toNumF64(b, vb))], 'f64')
  },
  'u+': a => {
    if (valTypeOf(a) === VAL.BIGINT)
      return err('unary `+` on a BigInt is a TypeError in JS — use Number(x)')
    const v = emit(a)
    if (v.type === 'i32') return asF64(v)
    // Deliberately NOT routed through toNumF64 for every non-NUMBER operand
    // (fix/wrong-values-2 tried exactly that, to fix `+{valueOf:()=>2}`'s
    // ToPrimitive gap — no test262 entry actually needed it in the end, since
    // Iterator take/drop's own `+n` runs on an untyped parameter that never
    // reaches toNumF64's VAL.OBJECT gate either way). Reverted: it broke
    // test/watr.js's "simd load/store" bug-pin (37/37 -> 36/37) by changing
    // codegen for a STRING operand read inside a discarded short-circuit
    // expression whose LEFT side is itself an assignment (watr's own
    // compile.js memarg(): `if (align) ((align = Math.log2(align)) % 1) &&
    // err(...)` — align starts '1'-derived-via-unary-plus, discarded-value
    // context) — the nested `align = Math.log2(align)` reassignment stopped
    // taking effect, a genuine toNumF64/discarded-value codegen bug exposed
    // by, not created by, routing a STRING operand through it. Out of scope
    // to chase further here; flagged, not fixed.
    if (valTypeOf(a) === VAL.NUMBER) return toNumF64(a, v)
    inc('__to_num')
    return typed(['call', '$__to_num', asI64(v)], 'f64')
  },
  'u-': (a, self) => emitNeg(a, self),
  '*': (a, b, self) => {
    // §14 point 4: joint runtime-domain dispatch — see '-'s identical comment above.
    if (bigIntDomainsCanMix(a, b, true)) {
      bigintMixReject('*', a, b)
      return bigIntJointDispatch(a, b,
        (ia, ib) => ['i64.mul', ia, ib],
        (fa, fb) => typed(['f64.mul', fa, fb], 'f64'), computedBoxOf(self))
    }
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT) {
      bigintMixReject('*', a, b)
      return fromI64(['i64.mul', bigIntOperand(a), bigIntOperand(b)])
    }
    const va = emit(a), vb = emit(b), _f = foldConst(va, vb, (a, b) => a * b)
    if (_f) return _f
    if (isLit(vb) && litVal(vb) === 1) return toNumF64(a, va)
    if (isLit(va) && litVal(va) === 1) return toNumF64(b, vb)
    // `x * 0` → 0 only when the other factor is provably finite (i32, or a finite
    // literal): JS `NaN*0` / `±Inf*0` are NaN, so a non-finite f64 must fall
    // through to `f64.mul` (which yields NaN). For finite x the dropped product is
    // ±0 — and -0 === +0, so consumers are unaffected. The block evaluates x for
    // its side effects before dropping.
    const finiteFactor = (v) => isI32Num(v) || (isLit(v) && Number.isFinite(litVal(v)))
    if (isLit(vb) && litVal(vb) === 0 && finiteFactor(va)) return isLit(va) ? vb : typed(['block', ['result', vb.type], va, 'drop', vb], vb.type)
    if (isLit(va) && litVal(va) === 0 && finiteFactor(vb)) return isLit(vb) ? va : typed(['block', ['result', va.type], vb, 'drop', va], va.type)
    // `.unsigned` operand is a uint32 ([0, 2^32)); its product can exceed i32, so
    // `i32.mul` would wrap ((2^32-1)*2 → -2). Widen to f64 — see `+` above.
    if (isI32Num(va) && isI32Num(vb) && !widensUnsigned(va) && !widensUnsigned(vb)
        && (mulFitsI32(va, vb) || mulBoundedFaithful(va, vb) || mulRangeFitsI32(a, b))) return typed(['i32.mul', va, vb], 'i32')
    // Typed-element reads arrive PRE-converted (`.typed:[]` returns
    // f64.convert_i32_{s,u}(loadN)), so the faithful-product gate above never
    // sees them. Peel the convert to expose the bounded integer source: when
    // |a|·|b| ≤ 2^31−1 the exact product fits signed i32, so
    // f64.mul(convert(x), convert(y)) == convert_s(i32.mul(x, y)) in every
    // consumer context — one int op instead of two converts + f64.mul, and the
    // i32 product chain is lane-vectorizable. Unsigned converts are safe here
    // for the same reason: a magnitude-bounded (< 2^31) uint reads the same
    // signed or unsigned, and the bounded product needs the signed convert.
    const peeled = (v) => Array.isArray(v) && (v[0] === 'f64.convert_i32_s' || v[0] === 'f64.convert_i32_u') && v.length === 2 ? v[1]
      : isI32Num(v) && !widensUnsigned(v) ? v : null
    const pa = peeled(va), pb = peeled(vb)
    if (pa && pb && i32Mag(pa) * i32Mag(pb) <= 0x7fffffff) return typed(['i32.mul', pa, pb], 'i32')
    const i32mul = tryI32Arith('i32.mul', '*', a, b, va, vb); if (i32mul) return i32mul
    return typed(['f64.mul', stripCanon(toNumF64(a, va)), stripCanon(toNumF64(b, vb))], 'f64')
  },
  '/': (a, b, self) => {
    // §14 point 4: joint runtime-domain dispatch — see '-'s identical comment above.
    if (bigIntDomainsCanMix(a, b, true)) {
      bigintMixReject('/', a, b)
      return bigIntJointDispatch(a, b,
        (ia, ib) => ['i64.div_s', ia, ib],
        (fa, fb) => typed(['f64.div', fa, fb], 'f64'), computedBoxOf(self))
    }
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT) {
      bigintMixReject('/', a, b)
      return fromI64(['i64.div_s', bigIntOperand(a), bigIntOperand(b)])
    }
    const va = emit(a), vb = emit(b), _f = foldConst(va, vb, (a, b) => a / b, b => b !== 0)
    if (_f) return _f
    if (isLit(vb) && litVal(vb) === 1) return toNumF64(a, va)
    // Division by an exact power of two is a BIT-EXACT multiply by its
    // reciprocal (2^-k is representable; per-element scaling is exact for every
    // finite/NaN/±0 input — IEEE 754 multiplication by a power of two only
    // adjusts the exponent). f64.mul is ~4× cheaper than f64.div on every
    // relevant core (the q16 fraction split `(dq - dInt*65536)/65536.0`).
    if (isLit(vb)) {
      const d = litVal(vb)
      const k = Math.log2(Math.abs(d))
      if (Number.isInteger(k) && Number.isFinite(d) && d !== 0 && Math.abs(k) <= 1000)
        return typed(['f64.mul', stripCanon(toNumF64(a, va)), ['f64.const', 1 / d]], 'f64')
    }
    return typed(['f64.div', stripCanon(toNumF64(a, va)), stripCanon(toNumF64(b, vb))], 'f64')
  },
  '%': (a, b, self) => {
    // §14 point 4: joint runtime-domain dispatch — see '-'s identical comment
    // above. Number-domain branch reuses `f64rem` (the SAME `$__rem` call the
    // fully generic '%' path below already uses — exact NaN/±Inf/0 edges).
    if (bigIntDomainsCanMix(a, b, true)) {
      bigintMixReject('%', a, b)
      return bigIntJointDispatch(a, b,
        (ia, ib) => ['i64.rem_s', ia, ib],
        (fa, fb) => f64rem(fa, fb), computedBoxOf(self))
    }
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT) {
      bigintMixReject('%', a, b)
      return fromI64(['i64.rem_s', bigIntOperand(a), bigIntOperand(b)])
    }
    const va = emit(a), vb = emit(b), _f = foldConst(va, vb, (a, b) => a % b, b => b !== 0)
    if (_f) return _f
    // ES remainder by zero is NaN; only the f64 path yields that (a - trunc(a/0)*0).
    // The i32.rem_s fast path traps on a zero divisor, so divert a literal-zero divisor.
    // `va` is ALREADY emitted (above) — an impure dividend (`bump() % 0`) must still run
    // once, in source order, before the NaN fold (re-audit P0, sweep of emitTypeofCmp's
    // static-kind-fold class: this branch used to discard `va` unconditionally).
    if (isLit(vb) && litVal(vb) === 0) {
      const nan = emitNum(NaN)
      return foldOperandPure(a) ? nan : typed(['block', ['result', 'f64'], ['drop', va], nan], 'f64')
    }
    // i32.rem_s is exact for integer operands AND fast, but it TRAPS on a zero
    // divisor where JS yields NaN. Only take it when the divisor is a literal
    // integer (necessarily nonzero — literal 0 is handled above); a runtime i32
    // divisor could be 0, so route it to f64rem (exact for in-range integers,
    // NaN for 0). The dividend may be a bare i32 or a FAITHFUL signed-convert
    // wrapper (f64.convert_i32_s X — the i32 view equals the JS value): peel it.
    // `.unsigned` operand: `i32.rem_s` reads the uint32 as a negative signed value
    // ((2^32-1)%7 → rem_s(-1,7) = -1, not 3). Widen to f64 — see `+` above.
    if (isLit(vb) && Number.isInteger(litVal(vb)) && Math.abs(litVal(vb)) < 2 ** 31 && !vb.unsigned) {
      const pa = isI32Num(va) && !va.unsigned ? va
        : Array.isArray(va) && va[0] === 'f64.convert_i32_s' && !va.unsigned
          ? (Array.isArray(va[1]) ? typed(va[1], 'i32') : va[1]) : null
      if (pa) return typed(['i32.rem_s', pa, ['i32.const', litVal(vb) | 0]], 'i32')
    }
    // Fast path: positive literal divisor → inline a - trunc(a/b) * b.
    // Exact when |a| < 2^53 × |b| (all practical audio/control-range values).
    // The full __rem handles NaN/±Inf/0 edges exactly; this avoids the call overhead.
    if (isLit(vb) && litVal(vb) > 0) {
      const fa = toNumF64(a, va), fb = toNumF64(b, vb)
      const rem = ta => typed(['f64.sub', ta, ['f64.mul', ['f64.trunc', ['f64.div', ta, fb]], fb]], 'f64')
      if (isPureIR(fa)) return rem(fa)
      return withTemp(fa, t => rem(['local.get', `$${t}`]), 'rem')
    }
    return f64rem(toNumF64(a, va), toNumF64(b, vb))
  },
}
