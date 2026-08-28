
/**
 * Lane-local SIMD-128 vectorizer.
 *
 *   Recognizes inner loops of shape:
 *     for (let i = 0; i < N; i++) arr[i] = f(arr[i], …)
 *   where every body op is "lane-pure" — its k-th lane output depends only
 *   on k-th lane inputs. Lifts the body to SIMD-128, prefixed before the
 *   original (now tail) loop. Original loop runs the remainder.
 *
 * Design:
 *   • Lane-purity is a structural property, not a benchmark match. The op
 *     whitelist is the single source of truth (one entry per (lane-type, op)).
 *   • Lift is mechanical. The recognizer either matches the structure — in
 *     which case lifting is unambiguous — or skips. No bench-specific
 *     heuristics.
 *   • Tail loop is the original WAT, untouched. If anything regresses the
 *     SIMD recognizer just doesn't match, never miscompiles.
 *
 * Match conditions:
 *   1. (block $brk (loop $L (br_if $brk !cond) BODY (i = i+1) (br $L)))
 *   2. cond is `(i32.lt_s i BOUND)` or `i32.lt_u`; BOUND is loop-invariant.
 *   3. All loads/stores in BODY use address `(add base (shl i K))` where
 *      base is loop-invariant and K matches the elem stride. Optional
 *      enclosing `local.tee` is allowed (and reused).
 *   4. All loads share the same opcode → defines lane type.
 *   5. All other ops in BODY are in the lane-pure whitelist for that type.
 *   6. Each non-induction local in BODY is either purely loop-invariant
 *      (only read) or purely lane-local (first action is a write). Never
 *      both — that's a loop-carried scalar (reduction / stencil) → bail.
 *
 * Lift produces, before the original block:
 *     (local.set $__simd_bound{N} (i32.and BOUND (i32.const ~(LANES-1))))
 *     (block $__simd_brk{N}
 *       (loop $__simd_loop{N}
 *         (br_if $__simd_brk{N} (i32.eqz (i32.lt_s i $__simd_bound{N})))
 *         <body lifted op-by-op; lane-local locals routed to v128 shadows>
 *         (local.set $i (i32.add i (i32.const LANES)))
 *         (br $__simd_loop{N})))
 *
 * The original block runs immediately after with i pre-advanced; its own
 * `i < BOUND` guard handles the tail.
 */




import { findBodyStart, dollar } from '../ir.js'
import { warn, ctx, DBG_INVARIANTS } from '../ctx.js'
import { walkAst } from '../ast.js'
import { constNum, isI32Const, isLocalGet } from './vectorize/addr-model.js'
import { tryChannelReduce } from './vectorize/blur-channel.js'
import { tryDivergentEscapeVectorize } from './vectorize/divergent-escape.js'
import { hoistReductionInvariantsIn, slpPairsIn } from './vectorize/dot-slp.js'
import { vecState } from './vectorize/lift.js'
import { tryGeneralMap, tryVectorize } from './vectorize/map.js'
import { tryMemCopyFill } from './vectorize/memcpy.js'
import { forEachLocalDef, isArr } from './vectorize/node-utils.js'
import { matchOuterPixelLoop } from './vectorize/outer-scaffold.js'
import { tryOuterStripRest } from './vectorize/outer-strip.js'
import { tryRampMap } from './vectorize/ramp.js'
import { tryGeneralReduce, tryReduce } from './vectorize/reduce.js'
import { canonicalizeIfBr, foldVecIdentities, matchBlockLoop, normalizeTransparentBlocks } from './vectorize/scaffold.js'
import { tryGeneralStencil, tryStencil } from './vectorize/stencil.js'
import { tryStrengthReduceIV } from './vectorize/strength-reduce.js'
import { tryToneMap } from './vectorize/tone-map.js'
export { inlinePureCallExpr, inlinePureFnsInFn } from './vectorize/inline-pure.js'
export { SIMD_PINNED } from './vectorize/lane-tables.js'

function tryButterfly(blockNode, fnLocals, freshIdRef) {
  if (!isArr(blockNode) || blockNode[0] !== 'block' || typeof blockNode[1] !== 'string') return null
  const brk = blockNode[1]
  if (blockNode.length !== 3 || !isArr(blockNode[2]) || blockNode[2][0] !== 'loop') return null
  const loop = blockNode[2]
  const lbl = loop[1]
  if (typeof lbl !== 'string') return null
  // scaffold: (loop $L (br_if $brk (i32.eqz (i32.lt_s J HALF))) BODY×17 INC 'drop' (br $L))
  const exit = loop[2]
  if (!isArr(exit) || exit[0] !== 'br_if' || exit[1] !== brk) return null
  const ez = exit[2]
  if (!isArr(ez) || ez[0] !== 'i32.eqz' || !isArr(ez[1]) || ez[1][0] !== 'i32.lt_s') return null
  const [, jGet, halfGet] = ez[1]
  if (!isLocalGet(jGet) || !isLocalGet(halfGet)) return null
  const J = jGet[1], HALF = halfGet[1]
  const end = loop.length - 1
  if (!isArr(loop[end]) || loop[end][0] !== 'br' || loop[end][1] !== lbl) return null
  if (loop[end - 1] !== 'drop') return null
  // inc: (block (result i32) (drop (i32.sub (local.tee J (i32.add J 1)) 1)) (local.tee K (i32.add K STEP)))
  const inc = loop[end - 2]
  if (!isArr(inc) || inc[0] !== 'block' || !isArr(inc[1]) || inc[1][0] !== 'result' || inc.length !== 4) return null
  const jInc = inc[2], kInc = inc[3]
  if (!isArr(jInc) || jInc[0] !== 'drop' || !isArr(jInc[1]) || jInc[1][0] !== 'i32.sub') return null
  const jTee = jInc[1][1]
  if (!isArr(jTee) || jTee[0] !== 'local.tee' || jTee[1] !== J || !isArr(jTee[2]) || jTee[2][0] !== 'i32.add'
      || !isLocalGet(jTee[2][1], J) || constNum(jTee[2][2]) !== 1) return null
  if (!isArr(kInc) || kInc[0] !== 'local.tee' || !isArr(kInc[2]) || kInc[2][0] !== 'i32.add') return null
  const K = kInc[1]
  if (typeof K !== 'string' || !isLocalGet(kInc[2][1], K) || !isLocalGet(kInc[2][2])) return null
  const STEP = kInc[2][2][1]
  const body = loop.slice(3, end - 2)
  if (body.length !== 17) return null

  // unification environment over the exact emit shapes
  const U = {}
  const bind = (name, v) => U[name] === undefined ? (U[name] = v, true) : U[name] === v
  const idx8 = (n, base, iv) => isArr(n) && n[0] === 'i32.add'
    && isLocalGet(n[1]) && bind(base, n[1][1])
    && isArr(n[2]) && n[2][0] === 'i32.shl' && isLocalGet(n[2][1]) && bind(iv, n[2][1][1])
    && constNum(n[2][2]) === 3
  const setF64Load = (st, name, base, iv, ab) => {
    if (!isArr(st) || st[0] !== 'local.set' || st.length !== 3 || !isArr(st[2]) || st[2][0] !== 'f64.load') return false
    let addr = st[2][1]
    if (ab != null) {
      if (!isArr(addr) || addr[0] !== 'local.tee') return false
      if (!bind(ab, addr[1])) return false
      addr = addr[2]
    }
    if (!idx8(addr, base, iv)) return false
    return bind(name, st[1])
  }
  const g = (n, name) => isLocalGet(n) && U[name] !== undefined && n[1] === U[name]
  const mulPair = (n, x, y) => isArr(n) && n[0] === 'f64.mul' && g(n[1], x) && g(n[2], y)
  const setArith = (st, name, op, mk) => {
    if (!isArr(st) || st[0] !== 'local.set' || st.length !== 3 || !isArr(st[2]) || st[2][0] !== op) return false
    if (!mk(st[2])) return false
    return bind(name, st[1])
  }
  // flat pair: (local.set T (op LHS VAL)) ; (f64.store (local.get AB) (local.get T))
  const storePair = (setSt, stoSt, op, lhs, val2, ab) => {
    if (!isArr(setSt) || setSt[0] !== 'local.set' || !isArr(setSt[2]) || setSt[2][0] !== op) return false
    const e = setSt[2]
    if (!lhs(e[1]) || !g(e[2], val2)) return false
    if (!isArr(stoSt) || stoSt[0] !== 'f64.store' || !g(stoSt[1], ab) || !isLocalGet(stoSt[2], setSt[1])) return false
    return true
  }

  if (!setF64Load(body[0], 'WR', 'WRE', 'K0', null) || U.K0 !== K) return null
  if (!setF64Load(body[1], 'WI', 'WIM', 'K1', null) || U.K1 !== K) return null
  {  // a = I + j (either order), I ≠ J
    const st = body[2]
    if (!isArr(st) || st[0] !== 'local.set' || !isArr(st[2]) || st[2][0] !== 'i32.add') return null
    const [, l, r] = st[2]
    if (isLocalGet(l) && isLocalGet(r, J) && l[1] !== J) U.I = l[1]
    else if (isLocalGet(r) && isLocalGet(l, J) && r[1] !== J) U.I = r[1]
    else return null
    U.A = st[1]
  }
  {  // b = a + half (either order)
    const st = body[3]
    if (!isArr(st) || st[0] !== 'local.set' || !isArr(st[2]) || st[2][0] !== 'i32.add') return null
    const [, l, r] = st[2]
    if (!((isLocalGet(l, U.A) && isLocalGet(r, HALF)) || (isLocalGet(r, U.A) && isLocalGet(l, HALF)))) return null
    U.B = st[1]
  }
  if (!setF64Load(body[4], 'XR', 'RE', 'B0', 'AB4') || U.B0 !== U.B) return null
  if (!setF64Load(body[5], 'XI', 'IM', 'B1', 'AB5') || U.B1 !== U.B) return null
  if (!setArith(body[6], 'TR', 'f64.sub', e => mulPair(e[1], 'WR', 'XR') && mulPair(e[2], 'WI', 'XI'))) return null
  if (!setArith(body[7], 'TI', 'f64.add', e => mulPair(e[1], 'WR', 'XI') && mulPair(e[2], 'WI', 'XR'))) return null
  if (!setF64Load(body[8], 'C0', 'RE', 'A0', 'AB6') || U.A0 !== U.A) return null
  const c0lhs = (n) => g(n, 'C0')
  const ab7teeLhs = (n) => {  // (f64.load (local.tee AB7 (im + a<<3)))
    if (!isArr(n) || n[0] !== 'f64.load' || !isArr(n[1]) || n[1][0] !== 'local.tee') return false
    if (!bind('AB7', n[1][1])) return false
    return idx8(n[1][2], 'IM', 'A2') && U.A2 === U.A
  }
  const ab7getLhs = (n) => isArr(n) && n[0] === 'f64.load' && g(n[1], 'AB7')
  if (!storePair(body[9], body[10], 'f64.sub', c0lhs, 'TR', 'AB4')) return null
  if (!storePair(body[11], body[12], 'f64.sub', ab7teeLhs, 'TI', 'AB5')) return null
  if (!storePair(body[13], body[14], 'f64.add', c0lhs, 'TR', 'AB6')) return null
  if (!storePair(body[15], body[16], 'f64.add', ab7getLhs, 'TI', 'AB7')) return null
  // loop-invariance: the four bases, HALF/STEP and the outer offset I are never written in the body
  const invariants = new Set([U.RE, U.IM, U.WRE, U.WIM, HALF, STEP, U.I].filter(x => typeof x === 'string'))
  if (invariants.size !== 7) return null
  let clobbered = false
  const wscan = n => {
    if (clobbered) return false
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && invariants.has(n[1])) { clobbered = true; return false }
  }
  for (const st of body) walkAst(st, { enter: wscan })
  if (clobbered) return null
  if (new Set([U.RE, U.IM, U.WRE, U.WIM]).size !== 4) return null

  const id = freshIdRef.next++
  const nm = (t) => `$__bf${id}_${t}`
  const L = (x) => ['local.get', x]
  const addr = (base, iv) => ['i32.add', L(base), ['i32.shl', L(iv), ['i32.const', 3]]]
  const twiddle = (base) => ['f64x2.replace_lane', 1,
    ['f64x2.splat', ['f64.load', addr(base, K)]],
    ['f64.load', ['i32.add', L(base), ['i32.shl', ['i32.add', L(K), L(STEP)], ['i32.const', 3]]]]]
  const wrv = nm('wrv'), wiv = nm('wiv'), xrv = nm('xrv'), xiv = nm('xiv')
  const trv = nm('trv'), tiv = nm('tiv'), c0v = nm('c0v'), iav = nm('iav')
  const av = nm('a'), bv = nm('b'), vl = nm('L'), strip = nm('go')
  const newLocalDecls = [
    ['local', wrv, 'v128'], ['local', wiv, 'v128'], ['local', xrv, 'v128'], ['local', xiv, 'v128'],
    ['local', trv, 'v128'], ['local', tiv, 'v128'], ['local', c0v, 'v128'], ['local', iav, 'v128'],
    ['local', av, 'i32'], ['local', bv, 'i32'],
  ]
  const stripGuard = () => ['i32.lt_s', ['i32.add', L(J), ['i32.const', 1]], L(HALF)]
  const vbody = [
    ['local.set', wrv, twiddle(U.WRE)],
    ['local.set', wiv, twiddle(U.WIM)],
    ['local.set', av, ['i32.add', L(U.I), L(J)]],
    ['local.set', bv, ['i32.add', L(av), L(HALF)]],
    ['local.set', xrv, ['v128.load', addr(U.RE, bv)]],
    ['local.set', xiv, ['v128.load', addr(U.IM, bv)]],
    ['local.set', trv, ['f64x2.sub', ['f64x2.mul', L(wrv), L(xrv)], ['f64x2.mul', L(wiv), L(xiv)]]],
    ['local.set', tiv, ['f64x2.add', ['f64x2.mul', L(wrv), L(xiv)], ['f64x2.mul', L(wiv), L(xrv)]]],
    ['local.set', c0v, ['v128.load', addr(U.RE, av)]],
    ['v128.store', addr(U.RE, bv), ['f64x2.sub', L(c0v), L(trv)]],
    ['local.set', iav, ['v128.load', addr(U.IM, av)]],
    ['v128.store', addr(U.IM, bv), ['f64x2.sub', L(iav), L(tiv)]],
    ['v128.store', addr(U.RE, av), ['f64x2.add', L(c0v), L(trv)]],
    ['v128.store', addr(U.IM, av), ['f64x2.add', L(iav), L(tiv)]],
    ['local.set', J, ['i32.add', L(J), ['i32.const', 2]]],
    ['local.set', K, ['i32.add', L(K), ['i32.add', L(STEP), L(STEP)]]],
    ['br_if', vl, stripGuard()],
  ]
  const wrapper = ['block',
    ['block', strip,
      ['br_if', strip, ['i32.eqz', stripGuard()]],
      ['loop', vl, ...vbody]],
    blockNode]  // the ORIGINAL loop is the scalar tail: 0..1 leftover iterations, or everything when half < 2
  return { wrapper, newLocalDecls }
}


// ---- Cost model (.work/vectorizer-generality-design.md's final follow-up seam, Part 2): a
// profitability gate for the GENERAL base layers ONLY (tryGeneralMap/
// tryGeneralStencil/tryGeneralReduce below) — every idiom FUSER above (tryDivergentEscapeVectorize,
// tryBlurMultiPixel, tryButterfly, …) keeps its own separately-tuned, always-fire behavior
// unchanged; this gate never runs for them. Today the three general recognizers vectorize
// UNCONDITIONALLY the instant their affine/dependence proof succeeds — sound, but blind to
// whether the SIMD prologue/epilogue/blend overhead is actually worth paying for a given body.
//
// Estimate, not a simulator: `scalarCost` = weighted op count of ONE original scalar iteration
// (`body`, pre-lift); `vectorCost` = weighted op count of ONE vector step (`lifted`, the SAME
// tree the codegen below emits, processing `lanes` elements) + a fixed prologue overhead + a
// per-guard overhead when runtime alias-versioning (layer 3) adds a disjointness check. Decline
// (the caller returns null, exactly like any other precondition failure in this file) when
// `vectorCost / lanes >= scalarCost` — vectorizing would cost at least as much per element as
// just running the scalar loop.
//
// Weights: `load`/`store` = 1, the baseline unit. Arithmetic/compare/convert-class ops (add,
// sub, mul, and, or, xor, shift, eq/lt/gt/…, min, max, neg, abs, sqrt, floor/ceil/trunc/nearest,
// convert/extend/narrow/wrap/promote/demote, splat) = 1 — same instruction-count class as a
// load. `div`/`rem` (float only — integer div/rem are never LANE_PURE, see that table's own
// header; a speculated arm containing one fails to lift and declines the WHOLE loop, never
// reaching this cost check) = 8 — division has no fast SIMD form on wasm (no reciprocal-estimate
// instruction in the MVP+SIMD feature set). `bitselect` (blend, the if-conversion codegen
// above) = 5.
//
// Calibration: these weights are an ESTIMATE, not a measured multiplier. A wall-clock microbench
// (`d = mask ? a : b` vs `d = a + b` vs `d = a / b`, SIMD_OPT, both a 2e7-element streaming pass
// and a 2e5-element pass repeated 200× to stay cache-resident) showed NO measurable difference
// between add/blend/div on V8 — all three are memory-bandwidth-bound, not compute-bound, at any
// array size tried. That is itself useful signal (real streaming SIMD kernels are memory-bound,
// so op-mix rarely changes wall-clock much), but it means no microbench can supply a blend/div
// MULTIPLIER directly. The weights actually used are a conservative PRIOR instead (in the spirit
// of LLVM's TargetTransformInfo select/div cost classes — blend ~2-5x, div severalx-to-double-digit
// x, target-dependent), gate-calibrated against corpus behavior: `div`=8 is the illustrative
// starting value (never empirically contradicted — no corpus loop has a speculated arm with float
// division to test against either way); `bitselect`=5 and `COST_OVERHEAD_PROLOGUE`/
// `COST_OVERHEAD_PER_GUARD` = 1/1 are chosen so the model does not decline a real, corpus-shaped
// case (`test/simd.js`'s alias-versioned f64 same-array runtime-offset map — an ordinary affine
// MAP with one alias-versioning guard, NO if-conversion, at f64's 2-lane width, where guard/
// prologue overhead alone would otherwise punish a perfectly profitable plain map) while still
// declining the synthetic decline case below (§SIMD cost model tests). Governing rule: if the
// model would decline a real corpus case, the model is wrong — recalibrate the weights, never
// special-case the site. Weight is shifted FROM the lane-count-sensitive per-loop overhead (which
// penalizes every general-layer recognizer, if-converted or not, hardest at f64/i64's 2 lanes)
// TOWARD the blend-specific weight (which only penalizes if-conversion codegen). A full corpus
// sweep against the test suite is the decisive calibration signal — not either number in isolation.

function assertLoopPlanAgrees(node, bl) {
  const link = ctx.plans.loweringLinks.get(node)
  if (!link) return
  const { plan, lowering } = link
  if (lowering.ivName != null && dollar(lowering.ivName) !== bl.incVar)
    throw new Error(`LoopPlan #${plan.id} IV diverges from WAT: HIR ivName=${lowering.ivName} (${dollar(lowering.ivName)}), WAT incVar=${bl.incVar}`)
  if (plan.boundConst != null && isI32Const(bl.bound) && constNum(bl.bound) !== plan.boundConst)
    throw new Error(`LoopPlan #${plan.id} bound diverges from WAT: HIR boundConst=${plan.boundConst}, WAT bound=${constNum(bl.bound)}`)
}

// ---- Pass entry ------------------------------------------------------------

/**
 * Walk a function looking for vectorizable (block (loop)) pairs, in-place.
 * Adds new locals to the function header.
 */
// opts gates the recognizer set + lift variants (all default-safe so a bare
// `vectorizeLaneLocal(fn)` is the conservative scalar-preserving pass):
//   multiAcc, relaxedFma, blurMP, whyNot, stencil, outerStrip, pureFuncMap, toneMap.
export function vectorizeLaneLocal(fn, opts = {}) {
  const { multiAcc = false, relaxedFma = false, blurMP = true, whyNot = false,
    stencil = false, outerStrip = false, pureFuncMap = null, toneMap = false, slp = false, crPow = false,
    aliasVersion = true } = opts
  if (!isArr(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return
  const fnName = typeof fn[1] === 'string' ? fn[1] : '(anon)'
  let whyNotN = 0

  // Normalize jz's per-statement `block` grouping into flat statement lists ONCE, up front —
  // the recognizers below (both the scaffold consumers and the raw-node matchers like ramp-map,
  // stencil, per-pixel) were tuned on watr's flattened shape. Pre-watr, jz wraps each source
  // statement group in a transparent block; without this every loop body would arrive as a
  // single opaque `block` node and no lift would fire. Walking `fn` itself also flattens a
  // top-level body block (decls never match — they aren't blocks).
  normalizeTransparentBlocks(fn)
  // Canonicalize the raw arithmetic identities watr would fold (chiefly `i<<0` byte addresses),
  // so the address/value matchers read dataflow, not jz's un-folded emission.
  for (let i = bodyStart; i < fn.length; i++) fn[i] = foldVecIdentities(fn[i])
  // Canonicalize the `if COND (then (br L))` break idiom to `br_if L COND` (watr's brif shape),
  // so the loop-scan recognizers see the branch form they were tuned against.
  canonicalizeIfBr(fn)

  // Build local-name → wasm-type map.
  const fnLocals = new Map()
  for (let i = 2; i < bodyStart; i++) {
    const d = fn[i]
    if (isArr(d) && d[0] === 'local' && typeof d[1] === 'string' && typeof d[2] === 'string') {
      fnLocals.set(d[1], d[2])
    } else if (isArr(d) && d[0] === 'param' && typeof d[1] === 'string' && typeof d[2] === 'string') {
      fnLocals.set(d[1], d[2])
    }
  }

  // Loop-invariant constant locals — hoistConstantPool's `$…_pg` pool (`set $L (f64.const C)`,
  // written exactly once). name → numeric value, used to resolve a constant `pow` exponent that
  // reached the loop as a pooled local rather than a literal.
  const constLocals = new Map()
  {
    const setCount = new Map()
    forEachLocalDef(fn.slice(bodyStart), (name, rhs, node) => {
      if (node.length !== 3) return
      setCount.set(name, (setCount.get(name) || 0) + 1)
      if (isArr(rhs) && rhs[0] === 'f64.const') constLocals.set(name, +rhs[1])
    })
    for (const [k, c] of setCount) if (c !== 1) constLocals.delete(k)   // multiply-written → not invariant
  }

  const freshIdRef = { next: 0 }
  const newLocalDeclsAll = []
  // Whether a REAL SIMD lift happened (as opposed to the scalar tryStrengthReduceIV
  // fallback below, which also populates newLocalDeclsAll with plain i32 locals) —
  // the caller pins the function's $name/$name$exp boundary wrapper on this, so a
  // false positive here would needlessly block watr's inlineOnce on a non-SIMD fn.
  let simdFired = false

  // Hoist loop-invariant partial products out of unrolled dot reductions (rust/LLVM's
  // mat4 prologue trick). Reassociates the float sum, so tied to the relaxedFma tier;
  // runs BEFORE the dot-pair vectorizer so a hoisted dot drops below DOT_UNROLL steps
  // and stays scalar (faster here than the pack/extract SIMD form — see the lab).
  if (relaxedFma) hoistReductionInvariantsIn(fn, fnLocals, freshIdRef, newLocalDeclsAll)
  // Unified SLP packer (dot-sequence tier, then element-store tier) — see slpPairsIn.
  slpPairsIn(fn, fnLocals, freshIdRef, newLocalDeclsAll, relaxedFma, slp)
  if (newLocalDeclsAll.length) simdFired = true

  // Walk body recursively. Process inner-most matches first (post-order)
  // so we don't try to vectorize an outer loop whose inner is the lane-local one.
  function walk(parent, idx) {
    const node = parent[idx]
    if (!isArr(node)) return
    for (let i = 0; i < node.length; i++) {
      if (isArr(node[i])) walk(node, i)
    }
    if (node[0] === 'block') {
      if (vecState.whyNotActive) vecState.whyNotReason = null
      // Recognition layer: match the canonical (block (loop)) scaffold ONCE; the
      // inner-scaffold lifters (memcpy/map/reduce) consume the descriptor instead of
      // each re-matching. The outer-pixel + special-shape recognizers (outer-strip
      // family, ramp-map, channel-reduce) do their own matching on the raw node.
      // Order is preserved exactly — it is load-bearing (first match wins).
      // allowInlinedLi: accept an inlined LICM preamble (`$__inl*___li*`) too — jz's
      // LICM hoists ToInt32/casts of loop-invariant params just before the loop (e.g.
      // `a[i] & m` with a runtime `m`), and after inlining the snap is renamed off the
      // bare `$__li*` form. The preamble is pure & loop-invariant by construction
      // (hasSideEffect-guarded) and cloned ahead of the SIMD block, so this only widens
      // which loops the recognizers see, never changes a lifted result.
      const bl = matchBlockLoop(node, { allowPreamble: true, allowInlinedLi: true })
      // HIR provenance link shadow-assert (.work/research.md §BodyModel slice 4) — see
      // assertLoopPlanAgrees's own doc. `bl`-scoped only (the IV/bound facts it exists to
      // cross-check); a null `bl` has nothing to compare. Runs BEFORE the consultation below
      // so it still checks the fresh WAT derivation, unmodified by the override.
      if (DBG_INVARIANTS && bl) assertLoopPlanAgrees(node, bl)
      // FIRST REAL CONSUMPTION (.work/research.md §BodyModel): the shadow-assert above runs
      // across the full battery with zero divergences, so wherever the link resolves an IV
      // name, it is PROVEN to equal `bl.incVar`'s WAT-derived one. Roles invert: the plan
      // becomes the primary source for the name every bl-based
      // recognizer below reads (tryMemCopyFill/tryVectorize/tryReduce/
      // tryStencil/tryToneMap/tryStrengthReduceIV — all share
      // this one `bl`), and `matchInc1`'s WAT walk above becomes the fail-open FALLBACK (link
      // miss keeps its structurally-derived name) plus, under JZ_DEBUG_INVARIANTS, the shadow
      // (assertLoopPlanAgrees, run just above, already fills that role — nothing left to add).
      // Bound/hull are NOT flipped here: assertLoopPlanAgrees only proves `plan.boundConst`
      // against `bl.bound` in the branch where `bl.bound` is ALREADY an `i32.const` node — i.e.
      // exactly the case where the WAT derivation is already the concrete number in one read: a
      // non-const (boundLocal) bound is never compared, so consulting the plan there would be
      // unproven. Narrowed to the proven subset (banked finding, .work/research.md §BodyModel).
      if (bl) {
        const link = ctx.plans.loweringLinks.get(node)
        if (link && link.lowering.ivName != null) bl.incVar = dollar(link.lowering.ivName)
      }
      // LoopPlan classification (stage-3 slice 1): the OUTER-pixel scaffold is
      // matched ONCE here — the five outer-family recognizers consume this
      // descriptor (with its inner-loop census) instead of each re-matching.
      // `bl` (inner scaffold) + `op` (outer scaffold) together are the loop's
      // plan; a recognizer whose scaffold is null skips without walking.
      const op = matchOuterPixelLoop(node)
      // Loose-envelope variant of the same scaffold (any non-loop content
      // tolerated) — shared by blur-multi-pixel + channel-reduce, both LATE
      // in the `??` chain below. Lazy + memoized: most blocks either aren't
      // loop scaffolds at all or already match one of the earlier `bl`-based
      // recognizers, so the chain short-circuits before ever reaching the
      // two consumers — computing this third matcher pass upfront would be
      // pure waste on that (common) path. `getBlLoose()` runs the actual
      // `matchBlockLoop` at most once, on first read.
      let blLoose, blLooseComputed = false
      const getBlLoose = () => blLooseComputed ? blLoose
        : (blLooseComputed = true, blLoose = matchBlockLoop(node, { envelope: 'loose' }))
      let r = tryDivergentEscapeVectorize(node, fnLocals, freshIdRef, op)
        ?? tryMemCopyFill(bl, fnLocals, freshIdRef)
        ?? tryVectorize(bl, fnLocals, freshIdRef, pureFuncMap, constLocals)
        ?? tryReduce(bl, fnLocals, freshIdRef, multiAcc)
        ?? tryStencil(node, fnLocals, freshIdRef, stencil, bl)
        ?? tryRampMap(node, fnLocals, freshIdRef)
        ?? tryChannelReduce(node, fnLocals, freshIdRef, getBlLoose(), blurMP)
        ?? tryOuterStripRest(node, fnLocals, freshIdRef, pureFuncMap, outerStrip, op)
        ?? tryToneMap(bl, fnLocals, freshIdRef, toneMap)
        ?? tryButterfly(node, fnLocals, freshIdRef)
        ?? tryGeneralMap(node, fnLocals, freshIdRef, bl, { aliasVersion })
        ?? tryGeneralStencil(node, fnLocals, freshIdRef, stencil, bl, { aliasVersion })
        ?? tryGeneralReduce(bl, fnLocals, freshIdRef, multiAcc)
      // --why-not-simd: a canonical loop-shaped candidate that no SIMD pass took.
      // Reported BEFORE the scalar strength-reduce fallback (which fires on most
      // affine loops and would otherwise mask "didn't vectorize"). Diagnostic only.
      // Reuses `op` (already matched above) instead of re-running matchOuterPixelLoop.
      if (!r && vecState.whyNotActive && (bl || op)) {
        whyNotN++
        warn('simd-why-not',
          `${fnName}: loop #${whyNotN} not vectorized — ${vecState.whyNotReason || 'no SIMD-liftable shape (loop-carried dependency, non-affine address, or unsupported control flow)'}`,
          { fn: `${fnName}#${whyNotN}` })
      }
      if (r) simdFired = true   // one of the real SIMD recognizers above matched
      if (r) {
        // Mark the consumed subtree: the wrapper REUSES these nodes (scalar tail, and the
        // lane splats alias the original load nodes), so a deferred strength-reduce must
        // never rewrite inside them — it would mutate the lifted lanes through the alias.
        walkAst(node, { enter: n => { srConsumed.add(n) } })
        parent[idx] = r.wrapper
        newLocalDeclsAll.push(...r.newLocalDecls)
      } else if (bl) {
        // Scalar IV strength-reduction is a non-SIMD fallback — DEFERRED to after the
        // whole walk. Applied eagerly here (post-order = innermost first) it rewrites an
        // inner reduction loop into its wrapper before the ENCLOSING loop's outer
        // recognizers (outer-strip / iterated-reduce / conv-column / tone-map) ever run,
        // and they bail on the non-canonical inner shape — metaballs' pixel loop lost its
        // whole f64x2 outer-strip to an eager strength-reduce of the blob loop.
        deferredSR.push([node, parent, idx, bl])
      }
    }
  }
  const deferredSR = [], srConsumed = new Set()
  vecState.whyNotActive = whyNot
  vecState.relaxF32 = relaxedFma
  vecState.crPow = crPow
  for (let i = bodyStart; i < fn.length; i++) walk(fn, i)
  vecState.whyNotActive = false
  vecState.relaxF32 = false
  vecState.crPow = false
  // Apply the deferred scalar fallback innermost-first (push order), skipping candidates
  // inside any SIMD-consumed subtree (see the mark above), plus a same-slot check for
  // wrappers that replaced the candidate node itself.
  for (const [node, parent, idx, bl] of deferredSR) {
    if (srConsumed.has(node) || parent[idx] !== node) continue
    const r = tryStrengthReduceIV(bl, fnLocals, freshIdRef)
    if (r) { parent[idx] = r.wrapper; newLocalDeclsAll.push(...r.newLocalDecls) }
  }

  if (newLocalDeclsAll.length) {
    // Sibling loops (and the straight-line dot pass) can each lift the SAME source
    // local to an identically-named `$name__v` v128 scratch. Post-order vectorizes
    // innermost-first and an outer loop bails once its inner became a wrapper block,
    // so no two NESTED loops ever share a lift — every collision is between
    // SEQUENTIAL loops, where one shared scratch is correct (each writes its lanes
    // before reading). Declaring a local twice is invalid wasm ("duplicate local"),
    // so keep one decl per name (all dups are the identical `['local', name, 'v128']`).
    fn.splice(bodyStart, 0, ...new Map(newLocalDeclsAll.map(d => [d[1], d])).values())
  }
  return simdFired
}
