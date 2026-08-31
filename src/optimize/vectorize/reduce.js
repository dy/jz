import { walkAst } from '../../ast.js'
import { _offsetLocalStride, constNum, hasSideEffect, isI32Const, isLocalGet, matchLaneAddr, matchStrideAddr, matchStrideOffset } from './addr-model.js'
import { isProfitable } from './cost-model.js'
import { matchCanonBlock, matchCanonSelect, matchIntMinMaxReduce, normTee } from './idioms.js'
import { LANE_INFO, LOAD_OPS, MINMAX_CVT, MINMAX_WIDEN, REDUCE_CANON, REDUCE_OP_LOOKUP, STORE_OPS, WIDEN_LOADS } from './lane-tables.js'
import { liftExprV, liftFail, vecState } from './lift.js'
import { isArr } from './node-utils.js'

// ---- Reduction recognizer -------------------------------------------------
//
// Matches inner loops of shape:
//     for (let i = 0; i < N; i++) S = OP(S, EXPR(arr[i], ...))
// where OP is associative+commutative (REDUCE_OPS table) and EXPR is lane-
// pure (operates on the loaded element with at most loop-invariant data).
// S is a SCALAR loop-carried accumulator — exempt from the lane-local
// "first access must be a write" check.
//
// Lift:
//   acc = splat(IDENTITY)
//   for (i = 0; i < bound & ~(L-1); i += L) acc = OP_v(acc, lifted EXPR)
//   S = OP(S, horizontal_reduce(acc))
//   <original scalar tail handles the remainder>
//
// Float adds are not strictly associative — vectorized reduction differs
// from scalar reduction by ulps. Acceptable when bit-exact equality is not
// required (which it isn't, by spec, in JS engines either).
//
// REDUCTION unification (.work/archive/vectorizer-generality-design.md §2 "REDUCTION (#5-6) → 1
// general recognizer"): this is the reassociating (tree-reduce + horizontal-sum) fold-order
// tier of the ONE reduction transform — a single scalar accumulator, `S = OP(S, EXPR(arr[i]))`.
// `tryReduceBitExact` below is the other fold-order tier (scalar-order-preserving f64x2
// pairing, multi-accumulator). `tryReduce`, at the bottom of this section, is the shared
// dispatch entry: try this (reassociating) shape first — exactly today's `tryReduceVectorize
// ?? tryMapReduceVectorize` order — falling to the bit-exact shape only when this one bails.
// The two shapes' preconditions are structurally disjoint (single vs. multi accumulator,
// one-or-two-statement canonical body vs. arbitrary straight-line multi-statement body) enough
// that unifying their MATCH bodies (not just their dispatch slot) would risk a behavior change
// under the byte-identical gate; kept as two internal matchers behind one recognizer entry,
// selected by which fold order (`bitExact`) actually fires — see `tryReduce`.
function tryReduceReassoc(bl, fnLocals, freshIdRef, multiAcc = false) {
  // Same scaffold as tryVectorize, but no preamble: a reduction block is just the loop.
  if (!bl || bl.preamble.length) return null
  const { loopNode, incIdx, incVar } = bl

  // Body is either a bare single-statement reduction —
  //   (local.set $acc (OP (local.get $acc) EXPR))            add/xor/and/or
  // — or a NaN-canonicalized two-statement min/max reduction —
  //   (local.set $cn  (OP (local.get $acc) EXPR))
  //   (local.set $acc (select C (local.get $cn) (T.ne $cn $cn)))
  // A conditional-store min/max (`if (a[i] > m) m = a[i]`) is the SAME reduction as the ternary
  // `m = a[i] > m ? a[i] : m`; rewrite it to the select-assign form so one recognizer covers both.
  // Sound for recognition: the lane EXPR (an array load) is pure, and the SIMD lift reads it
  // unconditionally anyway (pmax), while the scalar remainder keeps the original conditional store.
  const asSelectAssign = (stmt) => {
    if (isArr(stmt) && stmt[0] === 'if' && stmt.length === 3 && isArr(stmt[2]) && stmt[2][0] === 'then' && stmt[2].length === 2) {
      const set = stmt[2][1]
      if (isArr(set) && set[0] === 'local.set' && set.length === 3 && !hasSideEffect(set[2]))
        return ['local.set', set[1], ['select', set[2], ['local.get', set[1]], stmt[1]]]
    }
    return stmt
  }
  const bodyStmts = []
  for (let i = 3; i < incIdx; i++) bodyStmts.push(asSelectAssign(loopNode[i]))
  // CSE collapse: `m = a[i] > m ? a[i] : m` hoists the load into its own `(local.set $t LOAD)`
  // ahead of the reduction, making a 2-statement body the single-statement min/max recognizer
  // misses. When $t is pure (no side effect, no accumulator reference) inline it back into the
  // reduction so the canonical one-statement shape is recognized. Sound: the lift only consumes
  // the inlined lane expr for the SIMD prefix; the original $t set survives in the scalar
  // remainder (the unchanged blockNode), so $t stays defined wherever else it is read.
  let body0 = bodyStmts
  if (bodyStmts.length === 2) {
    const [s1, s2] = bodyStmts
    if (isArr(s1) && s1[0] === 'local.set' && typeof s1[1] === 'string' && s1.length === 3 &&
        isArr(s2) && s2[0] === 'local.set' && typeof s2[1] === 'string' && s2.length === 3 && s1[1] !== s2[1]) {
      const t = s1[1], expr = s1[2]
      const usesName = (n, name) => isArr(n) && ((n[0] === 'local.get' && n[1] === name) || n.some(c => usesName(c, name)))
      if (!hasSideEffect(expr) && !usesName(expr, s2[1]) && !usesName(expr, t)) {
        const subst = (n) => isArr(n) ? (n[0] === 'local.get' && n[1] === t ? expr : n.map(subst)) : n
        body0 = [['local.set', s2[1], subst(s2[2])]]
      }
    }
  }
  const bodyLen = body0.length
  let accName, opName, reduceEntry, exprNode, canonC = null
  if (bodyLen === 1) {
    const stmt = body0[0]
    if (!isArr(stmt) || stmt[0] !== 'local.set' || stmt.length !== 3) return null
    accName = stmt[1]
    if (typeof accName !== 'string') return null
    const rhs = stmt[2]
    if (!isArr(rhs)) return null
    const minmax = matchIntMinMaxReduce(rhs, accName)
    if (minmax && minmax.laneType === 'f64') {
      // Comparison min/max over an f64 array (`m = a[i] > m ? a[i] : m`). f64x2.pmax/pmin
      // replicate the scalar `(a>m)?a:m` EXACTLY per element — pmax(m,a) = (m<a)?a:m keeps the
      // accumulator on NaN (m<NaN is false) and on a ±0 tie, never NaN-poisoning the way
      // f64x2.max would. They preserve the data's exact NaN bits (a selection, not a compute),
      // so no canon is needed. The ONLY divergence from the sequential scalar is the SIGN of a
      // zero RESULT when the extremum is hit by both +0 and −0 in different lanes (a cross-lane
      // reorder) — strictly less than the ULP reassociation the sum reductions already accept,
      // so it rides the relaxedSimd tier (on at 'speed'); strict callers opt out (scalar).
      if (!vecState.relaxF32) return null
      reduceEntry = {
        simd: minmax.isMax ? 'f64x2.pmax' : 'f64x2.pmin',
        extract: 'f64x2.extract_lane', laneType: 'f64',
        identity: ['f64.const', minmax.isMax ? '-inf' : 'inf'],
        minmaxSelect: true, isMax: minmax.isMax, pmaxF64: true,
      }
      exprNode = minmax.exprNode
    } else if (minmax) {
      // Synthetic entry: WASM has the SIMD i32x4.max_s/min_s but no scalar i32.max, so the
      // horizontal fold + merge below use select (flagged by minmaxSelect). Identity is the
      // op's neutral — INT_MIN for max, INT_MAX for min. A bare narrow load instead folds
      // at its own lane width/sign (MINMAX_WIDEN), 16 or 8 lanes per vector.
      const w = isArr(minmax.exprNode) && minmax.exprNode.length === 2
        ? MINMAX_WIDEN[minmax.exprNode[0]] : null
      reduceEntry = w ? {
        simd: `${w.pre}.${minmax.isMax ? 'max' : 'min'}_${w.sign}`,
        extract: `${w.pre}.extract_lane_${w.sign}`, laneType: w.laneType,
        identity: ['i32.const', minmax.isMax ? w.lo : w.hi],
        minmaxSelect: true, isMax: minmax.isMax, accI32: true,
      } : {
        simd: minmax.isMax ? 'i32x4.max_s' : 'i32x4.min_s',
        extract: 'i32x4.extract_lane', laneType: 'i32',
        identity: ['i32.const', minmax.isMax ? -2147483648 : 2147483647],
        minmaxSelect: true, isMax: minmax.isMax,
      }
      exprNode = minmax.exprNode
    } else if (rhs[0] === 'block') {
      // Un-flattened NaN-canon float min/max — the same reduction as the two-statement
      // canon (bodyLen===2 below), but with the cn-temp set + select still wrapped in a
      // value-block: (local.set acc (block (result T) (local.set cn (OP acc expr))
      // (select C (local.get cn) (T.ne cn cn)))). mergeBlocks normally hoists this to the
      // flat form; recognize the block form directly so vectorization doesn't hinge on
      // that hoist having run.
      let bi = 1
      if (typeof rhs[bi] === 'string' && rhs[bi].startsWith('$')) bi++
      if (isArr(rhs[bi]) && rhs[bi][0] === 'result') bi++
      const inner = rhs[bi]
      const op = isArr(inner) && inner[0] === 'local.set' && isArr(inner[2]) ? inner[2][0] : null
      reduceEntry = op ? REDUCE_CANON[op] : null
      if (!reduceEntry) return null
      const cb = matchCanonBlock(rhs, reduceEntry.laneType)
      if (!cb || !isArr(cb.core) || cb.core.length !== 3 || !isLocalGet(cb.core[1], accName)) return null
      opName = op
      exprNode = cb.core[2]
      canonC = cb.C
    } else {
      if (rhs.length !== 3) return null
      opName = rhs[0]
      reduceEntry = REDUCE_OP_LOOKUP.get(opName)
      if (!reduceEntry || !isLocalGet(rhs[1], accName)) return null
      exprNode = rhs[2]
    }
  } else if (bodyLen === 2) {
    const s1 = body0[0], s2 = body0[1]
    if (!isArr(s1) || s1[0] !== 'local.set' || s1.length !== 3) return null
    if (!isArr(s2) || s2[0] !== 'local.set' || s2.length !== 3) return null
    const cnName = s1[1], rhs = s1[2]
    if (typeof cnName !== 'string' || !isArr(rhs) || rhs.length !== 3) return null
    opName = rhs[0]
    reduceEntry = REDUCE_CANON[opName]
    if (!reduceEntry) return null
    accName = s2[1]
    if (typeof accName !== 'string' || accName === cnName) return null
    const canon = matchCanonSelect(s2[2], reduceEntry.laneType)
    if (!canon || !isLocalGet(canon.val, cnName)) return null
    if (!isLocalGet(rhs[1], accName)) return null
    canonC = canon.C
    exprNode = rhs[2]
  } else return null

  // Offset-indexed reductions (matmul `s += A[ai+k]*Bt[bj+k]`): the index `ai+k`
  // lowers to `(i32.shl (i32.add ai i) K)`, which matchLaneAddr rejects (the IV is
  // not the bare shift operand). Fold the loop-invariant part into the base —
  //   (base + (INV+i)<<K)  →  ((base + INV<<K) + i<<K)
  // so the offset is the bare IV the matcher/lifter already accept. The byte address
  // is unchanged, so the v128.load reads the same consecutive pair → bit-exact. INV
  // must be loop-invariant (not written in the loop) and IV-free (coefficient 1).
  {
    const writtenInLoop = new Set()
    ;(function wr(n) { if (!isArr(n)) return; if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') writtenInLoop.add(n[1]); for (let i = 1; i < n.length; i++) wr(n[i]) })(loopNode)
    const invFree = (n) => !isArr(n) || (!(n[0] === 'local.get' && (n[1] === incVar || writtenInLoop.has(n[1]))) && n.every((c, i) => i === 0 || invFree(c)))
    let folded = false
    const foldAddr = (n) => {
      if (!isArr(n)) return n
      if (n[0] === 'i32.add' && n.length === 3) {
        for (const [base, off] of [[n[1], n[2]], [n[2], n[1]]]) {
          if (isArr(off) && off[0] === 'i32.shl' && off.length === 3 && isArr(off[1]) && off[1][0] === 'i32.add' && off[1].length === 3) {
            const k = constNum(off[2]), x = off[1][1], y = off[1][2]
            const xIV = isLocalGet(x, incVar), yIV = isLocalGet(y, incVar)
            if (k != null && k >= 0 && k <= 3 && xIV !== yIV) {
              const inv = xIV ? y : x
              if (invFree(inv)) {
                folded = true
                return ['i32.add', ['i32.add', foldAddr(base), ['i32.shl', inv, ['i32.const', k]]], ['i32.shl', ['local.get', incVar], ['i32.const', k]]]
              }
            }
          }
        }
      }
      return n.map(foldAddr)
    }
    const fe = foldAddr(exprNode)
    if (folded) exprNode = fe
  }

  // Accumulator's declared local type must match the lane element type.
  // Exception: the widening byte/short sum — i32 accumulator fed by ONE bare
  // narrow load (`s += u8[i]`), whose LANE type is i8/i16 but reduces into i32.
  const accType = fnLocals.get(accName)
  const widen = (opName === 'i32.add' && accType === 'i32' && canonC == null
    && isArr(exprNode) && exprNode.length === 2 && WIDEN_LOADS[exprNode[0]]) || null
  // Widening float min/max: the canon over a sign-matched converted narrow load
  // (`m = Math.max(m, u8[i])`, acc f64) folds at the load's own width — exact,
  // since min/max never rounds and u8…i16 values are exact in f64. Only the one
  // horizontal result converts to f64 for the merge (+ re-canon for a NaN acc).
  if (canonC != null && (opName === 'f64.max' || opName === 'f64.min') && accType === 'f64'
      && isArr(exprNode) && exprNode.length === 2 && MINMAX_CVT[exprNode[0]] && isArr(exprNode[1])) {
    const w = MINMAX_WIDEN[exprNode[1][0]]
    if (w && w.sign === MINMAX_CVT[exprNode[0]]) {
      const isMax = opName === 'f64.max'
      reduceEntry = {
        simd: `${w.pre}.${isMax ? 'max' : 'min'}_${w.sign}`,
        extract: `${w.pre}.extract_lane_${w.sign}`, laneType: w.laneType,
        identity: ['i32.const', isMax ? w.lo : w.hi],
        minmaxSelect: true, isMax, accF64: exprNode[0], canonC,
      }
      exprNode = exprNode[1]
      canonC = null
    }
  }
  if (!widen && accType !== (reduceEntry.accI32 ? 'i32' : reduceEntry.accF64 ? 'f64' : reduceEntry.laneType)) return null

  // Bound must be loop-invariant: (local.get $L) or (i32.const N).
  const { bound, boundLocal } = bl
  if (!boundLocal && !isI32Const(bound)) return null

  // Scan EXPR for lane-aligned loads. Stores forbidden. Re-references of
  // accName forbidden (the accumulator only appears in the outer wrapper).
  const laneType = widen ? widen.laneType : reduceEntry.laneType
  const stride = LANE_INFO[laneType].stride
  const addrLocals = new Map()
  const offsetTees = new Map()
  let loadCount = 0, sawWidenF32 = false
  function scanExpr(node) {
    if (!isArr(node)) return true
    const op = node[0]
    if (LOAD_OPS[op]) {
      // f32→f64 widening reduction (`s += f32arr[i]`, acc f64): liftExprV promotes
      // the f32.load to f64x2.promote_low_f32x4, so accept it under an f64 lane and
      // validate at the f32 element stride (4) — the loop still steps `lanes` (2)
      // elements, advancing the f32 address by 8 bytes (the load64_zero the lift reads).
      const ltw = LOAD_OPS[op]
      const widenF32 = ltw === 'f32' && laneType === 'f64'
      if (ltw !== laneType && !widenF32) return false
      if (widenF32) sawWidenF32 = true
      const m = matchLaneAddr(node[1], incVar, addrLocals, offsetTees)
      if (!m) return false
      if ((1 << m.strideLog2) !== (widenF32 ? 4 : stride)) return false
      if (m.teeName) addrLocals.set(m.teeName, { strideLog2: m.strideLog2, base: m.base })
      if (m.offsetTeeName) offsetTees.set(m.offsetTeeName, m.strideLog2)
      loadCount++
      return true
    }
    if (STORE_OPS[op]) return false
    if (op === 'local.set' || op === 'local.tee') return false  // no intermediates
    if (op === 'local.get' && node[1] === accName) return false
    for (let i = 1; i < node.length; i++) if (!scanExpr(node[i])) return false
    return true
  }
  if (!scanExpr(exprNode)) return null
  if (loadCount === 0) return null
  // Soundness gate for offset-tee resolution (see tryVectorize).
  for (const [name, k] of offsetTees) {
    if (_offsetLocalStride([exprNode], name, incVar) !== k) return null
  }

  // Classify locals referenced in EXPR. Anything not the induction var or an
  // address-tee is invariant (we forbade local.set/tee in scanExpr).
  const referenced = new Set()
  walkAst(exprNode, { enter: n => { if (n[0] === 'local.get' && typeof n[1] === 'string') referenced.add(n[1]) } })
  const localKind = new Map()
  for (const name of referenced) {
    if (name === incVar) continue
    if (addrLocals.has(name) || offsetTees.has(name)) { localKind.set(name, 'addr'); continue }
    localKind.set(name, 'invariant')
  }
  for (const name of addrLocals.keys()) localKind.set(name, 'addr')
  for (const name of offsetTees.keys()) localKind.set(name, 'addr')

  const ctx = { laneType, incVar, rampVar: null, rampTemp: null, widenLoads: false, localKind, fnLocals, newLanedLocals: new Map(), extraLocals: [], freshIdRef, fail: false, failReason: null }

  const liftedExpr = liftExprV(exprNode, ctx)
  // liftExprV's contract is "null ⟺ ctx.fail"; under self-compile (jz.wasm) it can diverge and
  // return null WITHOUT the flag, which would otherwise splice a literal `null` operand into the
  // emitted `(<reduce>.add acc null)` — invalid wasm ("not enough arguments on the stack"). Treat
  // a null lift as a bail (the loop stays scalar — correct, just unvectorized on that leg).
  if (ctx.fail || liftedExpr == null) return null
  if (ctx.newLanedLocals.size > 0 || ctx.extraLocals.length > 0) return null

  // Synthesize SIMD prefix block + horizontal reduce + (preserved scalar tail).
  const id = freshIdRef.next++
  const simdBoundName = `$__simd_bound${id}`
  const simdAccName = `$__simd_acc${id}`   // accumulator 0 — the one the merge folds
  const simdBrkLabel = `$__simd_brk${id}`
  const simdLoopLabel = `$__simd_loop${id}`
  const info = LANE_INFO[laneType]
  const lanes = info.lanes
  const boundExpr = boundLocal ? ['local.get', boundLocal] : bound

  // Multi-accumulator unroll. A reduction's loop-carried accumulator is a latency
  // chain — each iteration's op waits on the previous result, so a single vector
  // accumulator runs at FP-op latency, not throughput. N INDEPENDENT accumulators
  // (each summing every Nth lane-chunk, combined at the end) expose instruction-
  // level parallelism and hide the latency — ~2x on a dot/FIR reduction. It is
  // DETERMINISTIC: only the reduction's reassociation widens (8 partial sums vs 2),
  // the same kind the existing 2-lane fold already does, identical on every engine.
  // Restricted to the plain horizontal-fold FP path (not min/max-select, the
  // narrow-widening sums, or NaN-canon — those have their own fold shapes).
  // The f32→f64 widening sum uses half-width load64_zero loads; the multi-accumulator
  // offsetLoads/laneBytes logic assumes full v128 loads, so keep it single-accumulator.
  const plainReduce = !reduceEntry.minmaxSelect && !widen && !sawWidenF32 && canonC == null
  const NACC = (multiAcc && plainReduce && (laneType === 'f64' || laneType === 'f32')) ? 4 : 1
  const accK = (k) => k === 0 ? simdAccName : `$__simd_acc${id}_${k}`
  const laneBytes = lanes * stride

  // Widening sum: the ACCUMULATOR vector is i32x4 regardless of the (narrow)
  // lane type; each iteration's 16-byte load collapses via extadd_pairwise.
  const accSplat = widen ? 'i32x4.splat' : info.splat
  const accumOperand = widen ? widen.steps.reduce((e, s) => [s, e], liftedExpr) : liftedExpr
  // Accumulator k reads the same lane-aligned data as acc 0, shifted by k chunks
  // (k·laneBytes). Acc 0 keeps the address tees (it sets them); acc k>0 reads the
  // tee'd address (normTee → local.get) and adds the byte offset to each load.
  const offsetLoads = (node, off) => !isArr(node) ? node
    : node[0] === 'v128.load' ? ['v128.load', ['i32.add', node[1], ['i32.const', off]]]
    : node.map(c => offsetLoads(c, off))
  const accOperandFor = (k) => k === 0 ? accumOperand : offsetLoads(normTee(accumOperand), k * laneBytes)

  const initAcc = []
  for (let k = 0; k < NACC; k++) initAcc.push(['local.set', accK(k), [accSplat, reduceEntry.constNode ?? reduceEntry.identity]])
  const loopBody = []
  for (let k = 0; k < NACC; k++) loopBody.push(['local.set', accK(k), [reduceEntry.simd, ['local.get', accK(k)], accOperandFor(k)]])
  loopBody.push(['local.set', incVar, ['i32.add', ['local.get', incVar], ['i32.const', lanes * NACC]]])
  const simdBlock = ['block', simdBrkLabel,
    ['loop', simdLoopLabel,
      ['br_if', simdBrkLabel,
        ['i32.eqz', ['i32.lt_s', ['local.get', incVar], ['local.get', simdBoundName]]]],
      ...loopBody,
      ['br', simdLoopLabel]
    ]
  ]
  // Combine the N accumulators into acc 0 (lane-wise) before the horizontal fold.
  const combineAccs = []
  for (let k = 1; k < NACC; k++) combineAccs.push(['local.set', simdAccName, [reduceEntry.simd, ['local.get', simdAccName], ['local.get', accK(k)]]])

  // Horizontal fold + merge into the live accumulator.
  const extraDecls = []
  let mergeStmts
  if (reduceEntry.minmaxSelect) {
    // No scalar max/min op — fold via select through a temp (no exponential operand
    // duplication): ht = lane0; ht = minmax(ht, lane_k); acc = minmax(acc, ht). For int,
    // `select(a,b,(gt|lt)_s a b)` = max/min(a,b). For the f64 pmax/pmin reduction the scalar
    // equivalent is the pmax/pmin select — `pmax(a,b) = (a<b)?b:a` — so the merge keeps the
    // same NaN/±0 tie semantics as the f64x2.pmax lanes.
    const ht = `$__simd_h${id}`
    extraDecls.push(['local', ht, reduceEntry.pmaxF64 ? 'f64' : 'i32'])
    const lane = (k) => [reduceEntry.extract, k, ['local.get', simdAccName]]
    const minmaxSel = reduceEntry.pmaxF64
      ? (a, b) => reduceEntry.isMax ? ['select', b, a, ['f64.lt', a, b]] : ['select', b, a, ['f64.lt', b, a]]
      : (a, b) => ['select', a, b, [reduceEntry.isMax ? 'i32.gt_s' : 'i32.lt_s', a, b]]
    mergeStmts = [['local.set', ht, lane(0)]]
    for (let k = 1; k < lanes; k++) mergeStmts.push(['local.set', ht, minmaxSel(lane(k), ['local.get', ht])])
    if (reduceEntry.accF64) {
      // Widening canon merge: one convert of the horizontal result, the scalar
      // f64 op against the live acc, then re-canon (a NaN-seeded acc must still
      // cross as the canonical NaN when the scalar tail is empty).
      mergeStmts.push(['local.set', accName,
        [opName, ['local.get', accName], [reduceEntry.accF64, ['local.get', ht]]]])
      mergeStmts.push(['local.set', accName,
        ['select', reduceEntry.canonC, ['local.get', accName],
          ['f64.ne', ['local.get', accName], ['local.get', accName]]]])
    } else {
      mergeStmts.push(['local.set', accName, minmaxSel(['local.get', accName], ['local.get', ht])])
    }
  } else {
    // Horizontal fold: scalar.op(extract 0, extract 1, …, extract L-1).
    // Widening sum folds the 4 i32x4 PARTIALS, not the (narrow) data lanes.
    const foldLanes = widen ? 4 : lanes
    let horiz = [reduceEntry.extract, 0, ['local.get', simdAccName]]
    for (let k = 1; k < foldLanes; k++) {
      horiz = [opName, horiz, [reduceEntry.extract, k, ['local.get', simdAccName]]]
    }
    // Merge the SIMD result into the live accumulator. For canon (min/max) the
    // merged value is re-canonicalized so a NaN that surfaced only in the SIMD
    // range still crosses as the canonical NaN when the scalar tail is empty.
    const merged = [opName, ['local.get', accName], horiz]
    mergeStmts = canonC == null
      ? [['local.set', accName, merged]]
      : [['local.set', accName, merged],
         ['local.set', accName,
           ['select', canonC, ['local.get', accName],
             [`${laneType}.ne`, ['local.get', accName], ['local.get', accName]]]]]
  }
  // Overshoot-safe SIMD bound: stop while a full `lanes`-wide load stays in
  // range, for ANY induction start (the min/max idiom seeds m=a[0] and starts
  // at i=1, which `& ~(lanes-1)` masking would run one lane past the end). For
  // a lane-aligned start this yields the same iteration set as masking; the
  // scalar tail (original `i<bound` guard) cleans up regardless.
  // A full N·lanes-wide step (all N accumulators) must stay in range.
  const boundSetup = ['local.set', simdBoundName, ['i32.sub', boundExpr, ['i32.const', lanes * NACC - 1]]]

  // Narrow-widened entries seed the vector acc with a LANE-domain neutral (e.g.
  // 0 for u8-max) — only neutral once real lanes fold in. Guard the whole SIMD
  // prefix incl. the merge so a zero-iteration range can't clamp the live acc
  // toward the identity. Full-width entries use absolute neutrals; unguarded.
  // (The guarded path is always NACC=1 — accI32/accF64 are non-plain reductions.)
  const core = reduceEntry.accI32 || reduceEntry.accF64
    ? [['if', ['i32.lt_s', ['local.get', incVar], ['local.get', simdBoundName]],
        ['then', ...initAcc, simdBlock, ...combineAccs, ...mergeStmts]]]
    : [...initAcc, simdBlock, ...combineAccs, ...mergeStmts]
  const wrapper = ['block', boundSetup, ...core, bl.blockNode]
  const newLocalDecls = [
    ['local', simdBoundName, 'i32'],
    ['local', simdAccName, 'v128'],
    ...Array.from({ length: NACC - 1 }, (_, k) => ['local', accK(k + 1), 'v128']),
    ...extraDecls,
  ]
  return { wrapper, newLocalDecls }
}

// Bit-exact f64 map-reduce (the direct-summation n-body force loop). A loop that
// accumulates one or more f64 reductions whose per-iteration contribution is computed
// INDEPENDENTLY of the accumulators. Process 2 iterations per step in f64x2 — every lane
// op (sub/mul/add/div/sqrt) is IEEE-754-identical to scalar f64 (no FMA in non-relaxed
// SIMD) — then accumulate each accumulator's two lane contributions IN SCALAR ORDER, so
// the reduction is BIT-EXACT (unlike the reassociating `tryReduceReassoc`). Wins when the
// per-element compute is expensive (a sqrt + reciprocal) so the 2-wide arithmetic
// outweighs the serial lane-accumulation. The original block is preserved as the ≤1
// scalar remainder, continuing the accumulators. Returns {wrapper, newLocalDecls} or null.
//
// Other fold-order tier of the unified REDUCTION recognizer (see `tryReduceReassoc`'s doc
// above and `tryReduce` below) — the `bitExact` branch.
function tryReduceBitExact(bl, fnLocals, freshIdRef) {
  if (!bl || bl.preamble.length) return null
  const { incVar, bound, boundLocal, body, siteAccess } = bl
  if (!boundLocal && !isI32Const(bound)) return null
  if (body.length < 2) return null

  // Every body stmt must be `(local.set $x EXPR)`. An accumulator reads its own target
  // through `f64.add` (`acc = acc + EXPR`); the rest are per-iteration lane locals. (One
  // write per acc — duplicate writes would break the per-acc ordering.)
  for (const s of body) if (!(isArr(s) && s[0] === 'local.set' && typeof s[1] === 'string' && s.length === 3)) return null
  const accSet = new Set()
  for (const s of body) if (isArr(s[2]) && s[2][0] === 'f64.add' && isLocalGet(s[2][1], s[1])) accSet.add(s[1])
  if (!accSet.size) return null
  const writeCount = new Map()
  for (const s of body) writeCount.set(s[1], (writeCount.get(s[1]) || 0) + 1)
  for (const a of accSet) { if (writeCount.get(a) !== 1 || fnLocals.get(a) !== 'f64') return null }

  // Address tees: locals that equal `ind << K`. f64 loads must be stride-8 (K=3) so one
  // f64x2.load (16 bytes) covers iterations j and j+1 — consecutive elements. BodyModel fact
  // (bl.siteAccess, see buildSiteAccess) — computed once at the dispatch instead of a private
  // per-site matchLaneAddr(e[1], incVar, new Map(), bl.offsetTees) call — shadow-assert-proven
  // equivalent to that plain query (.work/evidence.md §BodyModel).

  // f64x2 lift: load → f64x2.load (2 consecutive), const/invariant → splat, a lane local
  // → its f64x2 temp, sub/mul/add/div → f64x2.OP, sqrt → f64x2.sqrt. Anything else bails.
  const laneV = new Map()
  const newLocalDecls = []
  const fresh = () => { const n = `$__mr${freshIdRef.next++}`; newLocalDecls.push(['local', n, 'v128']); return n }
  let bad = false
  const lift = (e) => {
    if (bad || !isArr(e)) { bad = true; return null }
    const op = e[0]
    if (op === 'f64.const') return ['f64x2.splat', e]
    if (op === 'f64.load') {
      const m = siteAccess.get(e)
      if (!m || m.strideLog2 !== 3) { bad = true; return null }
      return ['v128.load', e[1]]   // 16 bytes = 2 consecutive f64s; the f64x2 op reads them
    }
    if (op === 'local.get' && typeof e[1] === 'string') {
      if (e[1] === incVar || accSet.has(e[1])) { bad = true; return null }   // IV-as-data / acc-dependent contribution
      if (laneV.has(e[1])) return ['local.get', laneV.get(e[1])]
      if (writeCount.has(e[1])) { bad = true; return null }   // a body local used BEFORE its set this iteration → loop-carried, not a fresh lane
      return ['f64x2.splat', e]   // genuine loop-invariant scalar (xi, …)
    }
    if ((op === 'f64.add' || op === 'f64.sub' || op === 'f64.mul' || op === 'f64.div') && e.length === 3)
      return [op.replace('f64.', 'f64x2.'), lift(e[1]), lift(e[2])]
    if (op === 'f64.sqrt' && e.length === 2) return ['f64x2.sqrt', lift(e[1])]
    bad = true; return null
  }

  // Lifted body: setup lanes → f64x2 temps (in order, so the offset tee in the first load
  // is set before later loads read it); each accumulator → a temp + two in-order adds.
  const lifted = []
  for (const s of body) {
    if (accSet.has(s[1])) {
      const cV = fresh()
      const v = lift(s[2][2])
      if (bad) return null
      lifted.push(['local.set', cV, v],
        ['local.set', s[1], ['f64.add', ['local.get', s[1]], ['f64x2.extract_lane', 0, ['local.get', cV]]]],
        ['local.set', s[1], ['f64.add', ['local.get', s[1]], ['f64x2.extract_lane', 1, ['local.get', cV]]]])
    } else {
      const tv = fresh()
      laneV.set(s[1], tv)
      const v = lift(s[2])
      if (bad) return null
      lifted.push(['local.set', tv, v])
    }
  }
  if (bad || !lifted.length) return null

  // SIMD prefix over the even prefix [0, bound & ~1); the original block is the ≤1 scalar
  // remainder (continues j and the accumulators). IV advances by 2.
  const id = freshIdRef.next++
  const simdBoundName = `$__mrb${id}`, simdBrk = `$__mrbrk${id}`, simdLoop = `$__mrl${id}`
  const boundExpr = boundLocal ? ['local.get', boundLocal] : ['i32.const', constNum(bound)]
  const simdBlock = ['block', simdBrk,
    ['loop', simdLoop,
      ['br_if', simdBrk, ['i32.eqz', ['i32.lt_s', ['local.get', incVar], ['local.get', simdBoundName]]]],
      ...lifted,
      ['local.set', incVar, ['i32.add', ['local.get', incVar], ['i32.const', 2]]],
      ['br', simdLoop]]]
  // span-aligned (same entry≠0 hazard as tryVectorize's bound — see there)
  const boundSetup = ['local.set', simdBoundName,
    ['i32.add', ['local.get', incVar],
      ['i32.and', ['i32.sub', boundExpr, ['local.get', incVar]], ['i32.const', -2]]]]
  const wrapper = ['block', boundSetup, simdBlock, bl.blockNode]
  return { wrapper, newLocalDecls: [['local', simdBoundName, 'i32'], ...newLocalDecls] }
}

// ---- Unified REDUCTION recognizer (dispatch entry) --------------------------
//
// One recognizer, two fold-order tiers keyed on shape (design §2 "REDUCTION (#5-6) → 1
// general recognizer"): try the reassociating single-accumulator shape first (`tryReduceReassoc`
// — today's `tryReduceVectorize`), fall to the bit-exact multi-accumulator shape
// (`tryReduceBitExact` — today's `tryMapReduceVectorize`) only when the first bails. Same
// dispatch order as before the merge (`tryReduceVectorize(...) ?? tryMapReduceVectorize(...)`),
// so this is a pure entry-point consolidation — behavior is unchanged by construction.
export function tryReduce(bl, fnLocals, freshIdRef, multiAcc = false) {
  return tryReduceReassoc(bl, fnLocals, freshIdRef, multiAcc) ?? tryReduceBitExact(bl, fnLocals, freshIdRef)
}

// ---- General base-layer REDUCTION recognizer (dispatch-chain terminal) ----------------
//
// Generalizes `tryReduce`'s (`tryReduceReassoc`) shape-specific address proof — `matchLaneAddr`'s
// literal post-lowering WAT-pattern list — to an AST-level affine-in-IV proof, the SAME lever
// `tryGeneralMap` already applied to the MAP class (design §2/§3 step 3, REDUCTION slice —
// .work/archive/vectorizer-generality-design.md). `ivCoeff`/`matchAddr` below are a PORT of
// `tryGeneralMap`'s own (itself ported from `tryStencil`) — not a literal import, matching
// `tryGeneralMap`'s own "port, don't share" precedent so `tryReduceReassoc`'s already-gated
// corpus behavior stays byte-for-byte untouched. One difference from `tryGeneralMap`'s copy:
// `matchAddr` takes the lane stride as an explicit parameter instead of inferring it from the
// first load site — a reduction's accumulator (and its associative op) already fixes the lane
// type before any load is scanned, so there is nothing to infer.
//
// Preconditions (design brief): single scalar accumulator, ONE recognized associative-
// commutative op (`REDUCE_OP_LOOKUP`: i32/i64 add·mul·xor·and·or, f32/f64 add·mul — the SAME
// table `tryReduce` itself gates on, so no new op is accepted, only a broader ADDRESS proof) —
// or the int/float min-max canon shapes `tryReduceReassoc` already recognizes
// (`matchIntMinMaxReduce`/`REDUCE_CANON`, reused verbatim, no new codegen). Body restricted to
// exactly ONE statement (bare op / int-minmax) or TWO (the NaN-canon float-minmax temp+select
// pair) — this alone proves "no other loop-carried state": a second independent write would be
// a third body statement, which this recognizer declines. Loads must be affine-in-IV at
// coefficient 1 (`ivCoeff`); `scanExpr` forbids stores, intermediates (`local.set`/`.tee`), and
// any re-reference of the accumulator inside EXPR — the identical contract `tryReduceReassoc`
// already enforces. Bound must be loop-invariant (`boundLocal` or an `i32.const`) — same
// convention every recognizer in this file uses.
//
// Deliberately OUT of scope (stays `tryReduce`'s territory — its address proof already succeeds
// there whenever it applies; this pass only widens the ADDRESS proof, never adds new numeric
// behavior): the narrow-widening sum/min-max variants (`widen`/`accI32`/`accF64`), the
// conditional-store→select-assign rewrite, the CSE-collapsed 2-statement body, and the
// un-flattened `block`-wrapped NaN-canon. Also out of scope: `tryReduceBitExact`'s multi-
// accumulator bit-exact tier — it has no single canonical "one accumulator, one op" shape to
// generalize (inherently multi-accumulator by construction), so REDUCTION's `bitExact` policy
// knob (design §2) is unaffected by this recognizer either way.
//
// Codegen from "Synthesize SIMD prefix…" on is byte-identical to `tryReduceReassoc`'s own
// horizontal-fold synth (copied, not refactored-shared — see the port-not-share note above),
// with `widen`/`sawWidenF32` fixed at their "off" values since this recognizer never produces
// those shapes (the accType gate below enforces it). Fold-order/bitExact convention: reassociates
// exactly where `tryReduceReassoc` already reassociates (float add/mul — ULP-level reorder,
// documented at `REDUCE_OPS`'s own header), value-exact everywhere `tryReduceReassoc` already is
// (int add/mul/xor/and/or, min/max) — no new numeric divergence, same fold order, just reached
// from a broader address proof.
export function tryGeneralReduce(bl, fnLocals, freshIdRef, multiAcc = false) {
  if (!bl || bl.preamble.length) return null
  const { incVar, bound, boundLocal, body, writes } = bl
  if (!boundLocal && !isI32Const(bound)) return null
  if (body.length !== 1 && body.length !== 2) return null

  let accName, opName, reduceEntry, exprNode, canonC = null
  if (body.length === 1) {
    const stmt = body[0]
    if (!isArr(stmt) || stmt[0] !== 'local.set' || stmt.length !== 3) return null
    accName = stmt[1]
    if (typeof accName !== 'string') return null
    const rhs = stmt[2]
    if (!isArr(rhs)) return null
    const minmax = matchIntMinMaxReduce(rhs, accName)
    if (minmax && minmax.laneType === 'f64') {
      // Same relaxedSimd gate tryReduceReassoc uses for the f64 pmax/pmin tier — see its own
      // doc (cross-lane ±0-sign reorder, strictly inside the ULP-reassociation budget already
      // accepted for sum reductions).
      if (!vecState.relaxF32) return null
      reduceEntry = {
        simd: minmax.isMax ? 'f64x2.pmax' : 'f64x2.pmin',
        extract: 'f64x2.extract_lane', laneType: 'f64',
        identity: ['f64.const', minmax.isMax ? '-inf' : 'inf'],
        minmaxSelect: true, isMax: minmax.isMax, pmaxF64: true,
      }
      exprNode = minmax.exprNode
    } else if (minmax) {
      reduceEntry = {
        simd: minmax.isMax ? 'i32x4.max_s' : 'i32x4.min_s',
        extract: 'i32x4.extract_lane', laneType: 'i32',
        identity: ['i32.const', minmax.isMax ? -2147483648 : 2147483647],
        minmaxSelect: true, isMax: minmax.isMax,
      }
      exprNode = minmax.exprNode
    } else {
      if (rhs.length !== 3) return null
      opName = rhs[0]
      reduceEntry = REDUCE_OP_LOOKUP.get(opName)
      if (!reduceEntry || !isLocalGet(rhs[1], accName)) return null
      exprNode = rhs[2]
    }
  } else {
    const s1 = body[0], s2 = body[1]
    if (!isArr(s1) || s1[0] !== 'local.set' || s1.length !== 3) return null
    if (!isArr(s2) || s2[0] !== 'local.set' || s2.length !== 3) return null
    const cnName = s1[1], rhs = s1[2]
    if (typeof cnName !== 'string' || !isArr(rhs) || rhs.length !== 3) return null
    opName = rhs[0]
    reduceEntry = REDUCE_CANON[opName]
    if (!reduceEntry) return null
    accName = s2[1]
    if (typeof accName !== 'string' || accName === cnName) return null
    const canon = matchCanonSelect(s2[2], reduceEntry.laneType)
    if (!canon || !isLocalGet(canon.val, cnName)) return null
    if (!isLocalGet(rhs[1], accName)) return null
    canonC = canon.C
    exprNode = rhs[2]
  }

  // Accumulator's declared local type must match the lane element type exactly — see the
  // header doc's "deliberately out of scope" list (no narrow-widening accumulator here).
  const accType = fnLocals.get(accName)
  if (accType !== reduceEntry.laneType) return null

  // Affine-in-IV coefficient solver — verbatim port of tryGeneralMap's own `ivCoeff` (see the
  // header doc above for the soundness argument reference).
  const ivCoeff = (n) => {
    if (isLocalGet(n)) {
      const nm = n[1]
      if (nm === incVar) return 1
      return writes.has(nm) ? null : 0
    }
    if (isI32Const(n)) return 0
    if (isArr(n) && n[0] === 'global.get') return 0
    if (isArr(n) && (n[0] === 'i32.add' || n[0] === 'i32.sub') && n.length === 3) {
      const a = ivCoeff(n[1]), b = ivCoeff(n[2])
      if (a == null || b == null) return null
      const c = n[0] === 'i32.add' ? a + b : a - b
      return c === 0 || c === 1 ? c : null
    }
    if (isArr(n) && n[0] === 'i32.mul' && n.length === 3)
      return ivCoeff(n[1]) === 0 && ivCoeff(n[2]) === 0 ? 0 : null
    if (isArr(n) && n[0] === 'local.tee' && n.length === 3) return ivCoeff(n[2])
    return null
  }
  const offTees = new Map(), addrTees = new Map()
  // matchOffset/matchAddr: shared with tryGeneralStencil/tryGeneralMap, see
  // addr-model.js's matchStrideOffset/matchStrideAddr header doc (pipeline-
  // minimality campaign, the six verbatim load/store validator ports).
  const matchOffset = (off, expectStride) => matchStrideOffset(off, expectStride, offTees, ivCoeff)
  const matchAddr = (addr, expectStride) => matchStrideAddr(addr, expectStride, writes, offTees, addrTees, ivCoeff)

  // Scan EXPR for lane-aligned loads. Stores forbidden. Re-references of accName forbidden (the
  // accumulator only appears in the outer wrapper) — identical contract to tryReduceReassoc's own
  // scanExpr, generalized ONLY in the address proof (matchAddr above, in place of matchLaneAddr's
  // literal WAT-shape list).
  const laneType = reduceEntry.laneType
  const stride = LANE_INFO[laneType].stride
  let loadCount = 0
  function scanExpr(node) {
    if (!isArr(node)) return true
    const op = node[0]
    if (LOAD_OPS[op]) {
      if (LOAD_OPS[op] !== laneType) return false
      let addr = node[1]
      if (typeof addr === 'string' && addr.startsWith('offset=')) addr = node[2]
      const m = matchAddr(addr, stride)
      if (!m) return false
      loadCount++
      return true
    }
    if (STORE_OPS[op]) return false
    if (op === 'local.set' || op === 'local.tee') return false   // no intermediates
    if (op === 'local.get' && node[1] === accName) return false
    for (let i = 1; i < node.length; i++) if (!scanExpr(node[i])) return false
    return true
  }
  if (!scanExpr(exprNode)) return null
  if (loadCount === 0) return null

  // Classify locals referenced in EXPR. Anything not the induction var or an address-tee is
  // invariant (scanExpr forbade local.set/tee, so nothing else could be lane data).
  const referenced = new Set()
  walkAst(exprNode, { enter: n => { if (n[0] === 'local.get' && typeof n[1] === 'string') referenced.add(n[1]) } })
  const localKind = new Map()
  for (const name of referenced) {
    if (name === incVar) continue
    if (addrTees.has(name) || offTees.has(name)) { localKind.set(name, 'addr'); continue }
    localKind.set(name, 'invariant')
  }
  for (const name of addrTees.keys()) localKind.set(name, 'addr')
  for (const name of offTees.keys()) localKind.set(name, 'addr')

  const ctx = { laneType, incVar, rampVar: null, rampTemp: null, widenLoads: false, localKind, fnLocals, newLanedLocals: new Map(), extraLocals: [], freshIdRef, fail: false, failReason: null }
  const liftedExpr = liftExprV(exprNode, ctx)
  // Same fail-open contract as tryReduceReassoc (see its own doc): a null lift without the
  // flag (self-compile divergence) bails rather than splicing a literal `null` operand.
  if (ctx.fail || liftedExpr == null) return null
  if (ctx.newLanedLocals.size > 0 || ctx.extraLocals.length > 0) return null
  // Cost model (Part 2 — shared header doc before tryGeneralMap). REDUCE has no
  // store sites (`scanExpr` above forbids STORE_OPS entirely) — no alias-versioning hazard to
  // guard, always `guardCount` 0 (matches layer 3's own "tryGeneralReduce doesn't need this
  // layer" finding). The vector-side cost is the one accumulate step this pass's own codegen
  // below emits per iteration-group: the reduce op itself (`reduceEntry.simd`, arith weight 1)
  // applied to `liftedExpr`'s own already-lifted load/arith tree — a tiny synthetic wrapper node
  // costs it without duplicating the codegen below.
  if (!isProfitable(body, [[reduceEntry.simd, liftedExpr]], LANE_INFO[laneType].lanes, 0))
    return liftFail(ctx, 'not profitable: vector cost/lane ≥ scalar cost')

  // ---- Codegen: byte-identical to tryReduceReassoc's own horizontal-fold synth — see header
  // doc. `widen`/`sawWidenF32` fixed at "off": this recognizer never produces those shapes.
  const widen = null, sawWidenF32 = false
  const id = freshIdRef.next++
  const simdBoundName = `$__simd_bound${id}`
  const simdAccName = `$__simd_acc${id}`
  const simdBrkLabel = `$__simd_brk${id}`
  const simdLoopLabel = `$__simd_loop${id}`
  const info = LANE_INFO[laneType]
  const lanes = info.lanes
  const boundExpr = boundLocal ? ['local.get', boundLocal] : bound

  const plainReduce = !reduceEntry.minmaxSelect && !widen && !sawWidenF32 && canonC == null
  const NACC = (multiAcc && plainReduce && (laneType === 'f64' || laneType === 'f32')) ? 4 : 1
  const accK = (k) => k === 0 ? simdAccName : `$__simd_acc${id}_${k}`
  const laneBytes = lanes * stride

  const accSplat = widen ? 'i32x4.splat' : info.splat
  const accumOperand = widen ? widen.steps.reduce((e, s) => [s, e], liftedExpr) : liftedExpr
  const offsetLoads = (node, off) => !isArr(node) ? node
    : node[0] === 'v128.load' ? ['v128.load', ['i32.add', node[1], ['i32.const', off]]]
    : node.map(c => offsetLoads(c, off))
  const accOperandFor = (k) => k === 0 ? accumOperand : offsetLoads(normTee(accumOperand), k * laneBytes)

  const initAcc = []
  for (let k = 0; k < NACC; k++) initAcc.push(['local.set', accK(k), [accSplat, reduceEntry.constNode ?? reduceEntry.identity]])
  const loopBody = []
  for (let k = 0; k < NACC; k++) loopBody.push(['local.set', accK(k), [reduceEntry.simd, ['local.get', accK(k)], accOperandFor(k)]])
  loopBody.push(['local.set', incVar, ['i32.add', ['local.get', incVar], ['i32.const', lanes * NACC]]])
  const simdBlock = ['block', simdBrkLabel,
    ['loop', simdLoopLabel,
      ['br_if', simdBrkLabel,
        ['i32.eqz', ['i32.lt_s', ['local.get', incVar], ['local.get', simdBoundName]]]],
      ...loopBody,
      ['br', simdLoopLabel]
    ]
  ]
  const combineAccs = []
  for (let k = 1; k < NACC; k++) combineAccs.push(['local.set', simdAccName, [reduceEntry.simd, ['local.get', simdAccName], ['local.get', accK(k)]]])

  const extraDecls = []
  let mergeStmts
  if (reduceEntry.minmaxSelect) {
    const ht = `$__simd_h${id}`
    extraDecls.push(['local', ht, reduceEntry.pmaxF64 ? 'f64' : 'i32'])
    const lane = (k) => [reduceEntry.extract, k, ['local.get', simdAccName]]
    const minmaxSel = reduceEntry.pmaxF64
      ? (a, b) => reduceEntry.isMax ? ['select', b, a, ['f64.lt', a, b]] : ['select', b, a, ['f64.lt', b, a]]
      : (a, b) => ['select', a, b, [reduceEntry.isMax ? 'i32.gt_s' : 'i32.lt_s', a, b]]
    mergeStmts = [['local.set', ht, lane(0)]]
    for (let k = 1; k < lanes; k++) mergeStmts.push(['local.set', ht, minmaxSel(lane(k), ['local.get', ht])])
    mergeStmts.push(['local.set', accName, minmaxSel(['local.get', accName], ['local.get', ht])])
  } else {
    const foldLanes = widen ? 4 : lanes
    let horiz = [reduceEntry.extract, 0, ['local.get', simdAccName]]
    for (let k = 1; k < foldLanes; k++) {
      horiz = [opName, horiz, [reduceEntry.extract, k, ['local.get', simdAccName]]]
    }
    const merged = [opName, ['local.get', accName], horiz]
    mergeStmts = canonC == null
      ? [['local.set', accName, merged]]
      : [['local.set', accName, merged],
         ['local.set', accName,
           ['select', canonC, ['local.get', accName],
             [`${laneType}.ne`, ['local.get', accName], ['local.get', accName]]]]]
  }
  const boundSetup = ['local.set', simdBoundName, ['i32.sub', boundExpr, ['i32.const', lanes * NACC - 1]]]

  // No accI32/accF64 narrow-widened entries here (out of scope — see header doc), so the SIMD
  // prefix is always unguarded (full-width identities, exactly like tryReduceReassoc's own
  // documented distinction for that case).
  const core = [...initAcc, simdBlock, ...combineAccs, ...mergeStmts]
  const wrapper = ['block', boundSetup, ...core, bl.blockNode]
  const newLocalDecls = [
    ['local', simdBoundName, 'i32'],
    ['local', simdAccName, 'v128'],
    ...Array.from({ length: NACC - 1 }, (_, k) => ['local', accK(k + 1), 'v128']),
    ...extraDecls,
  ]
  return { wrapper, newLocalDecls }
}
