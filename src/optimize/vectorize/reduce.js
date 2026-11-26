import { cloneNode, walkAst } from '../../ast.js'
import { _offsetLocalStride, addressTees, affineAddr, constNum, hasSideEffect, indexDefs, isI32Const, isLocalGet, matchLaneAddr, matchStrideAddr, affineIvCoeff } from './addr-model.js'
import { isProfitable, liftWeight } from './cost-model.js'
import { matchCanonBlock, matchCanonSelect, matchIntMinMaxReduce, normTee } from './idioms.js'
import { CONVERT_LANES, LANE_INFO, LOAD_OPS, MINMAX_CVT, MINMAX_WIDEN, NARROW_LANES, PPC_CALL2, REDUCE_CANON, REDUCE_OP_LOOKUP, STORE_OPS, WIDEN_LOADS } from './lane-tables.js'
import { deadTee, liftCtx, liftExprV, liftFail, refusedFor, vecState } from './lift.js'
import { isArr } from './node-utils.js'
import { simdLoop, simdBound, stripOpen } from './scaffold.js'

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
// Float adds and multiplies are not associative: a reduction in lanes rounds otherwise than
// the loop, and JavaScript fixes the loop's order. So this tier takes a float sum or product
// under `relaxedFloat` alone (README, "Float sums in lanes"; plainReduceEntry below); without
// it the exact tier (tryReduceBitExact) lifts the work of each element and carries the
// accumulation in the loop's own order.
//
// Two lowerings of a reduction, each its own to the chooser (index.js): this one, which folds
// lanes in another order than the loop (multiple accumulators, a horizontal sum at the end),
// and `tryReduceBitExact` below, which keeps the loop's order, the work of each element in
// lanes. Where the order is free (an integer's wrapping sum, a relaxed float's) both may lift
// and the chooser takes the cheaper pass; where it is not, this one declines.

// The tees of a statement that hold a pure load, inlined at the tee and at every read
// of the local (a temp the load cache made for a lane read), each noted in `teed` with
// its load; a local read past the loop keeps its tee.
const inlineLaneTees = (stmt, outsideReads, teed) => {
  const tees = new Map(), written = new Set(), blocked = new Set()
  let straight = true
  const find = (n, defined) => {
    if (!isArr(n)) return
    const op = n[0]
    if (op === 'local.get') { if (!defined.has(n[1])) blocked.add(n[1]); return }
    if (op === 'local.set' || op === 'local.tee') {
      find(n[2], defined)
      if (written.has(n[1])) blocked.add(n[1])
      written.add(n[1]); defined.add(n[1])
      if (op === 'local.tee' && n.length === 3 && typeof n[1] === 'string' && isArr(n[2]) && n[2][0] in LOAD_OPS
          && !hasSideEffect(n[2]) && !outsideReads?.has(n[1])) tees.set(n[1], n[2])
      return
    }
    if (op === 'if') {
      let i = typeof n[1] === 'string' ? 2 : 1
      if (isArr(n[i]) && n[i][0] === 'result') i++
      find(n[i++], defined)
      for (; i < n.length; i++) find(n[i], new Set(defined))
      return
    }
    if (op === 'br' || op === 'br_if' || op === 'br_table' || op === 'loop' || op === 'return' || op.startsWith('throw') || op.startsWith('try')) straight = false
    for (let i = 1; i < n.length; i++) find(n[i], defined)
  }
  find(stmt, new Set())
  // Every substituted read must see the one load, on every path. A branch's
  // assignment does not define its sibling or the continuation.
  for (const name of blocked) tees.delete(name)
  if (!straight || !tees.size) return stmt
  for (const [t, load] of tees) teed.set(t, load)
  const clone = (n) => isArr(n) ? n.map(clone) : n
  const sub = (n) => !isArr(n) ? n : (n[0] === 'local.tee' || n[0] === 'local.get') && tees.has(n[1]) ? clone(tees.get(n[1])) : n.map(sub)
  return sub(stmt)
}

export function tryReduceReassoc(bl, fnLocals, freshIdRef, multiAcc = false) {
  // Same scaffold as tryVectorize: the block's preamble runs cloned ahead of the strips
  // (reduceWrapper), as it does ahead of a map's.
  if (!bl) return null
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
  // The arm may stage its value in a temp first (`t = X; m = canon(t)`, a NaN
  // canonicalization into a generic binding): the value is `canon(X)`.
  const usesLocal = (n, name) => isArr(n) && ((n[0] === 'local.get' || n[0] === 'local.tee') && n[1] === name || n.some(c => usesLocal(c, name)))
  const asSelectAssign = (stmt) => {
    if (isArr(stmt) && stmt[0] === 'if' && stmt.length === 3 && isArr(stmt[2]) && stmt[2][0] === 'then' && (stmt[2].length === 2 || stmt[2].length === 3)) {
      let set = stmt[2][stmt[2].length - 1]
      if (stmt[2].length === 3) {
        const stage = stmt[2][1]
        // the temp is the arm's own: nothing past the loop reads what the lift leaves in it
        if (!(isArr(stage) && stage[0] === 'local.set' && stage.length === 3 && !hasSideEffect(stage[2]) && !usesLocal(stage[2], stage[1]) && !bl.outsideReads?.has(stage[1]) &&
            isArr(set) && set[0] === 'local.set' && set.length === 3 && set[1] !== stage[1])) return stmt
        const t = stage[1], subst = (n) => isArr(n) ? (n[0] === 'local.get' && n[1] === t ? stage[2] : n.map(subst)) : n
        set = ['local.set', set[1], subst(set[2])]
      }
      if (isArr(set) && set[0] === 'local.set' && set.length === 3 && !hasSideEffect(set[2]))
        return ['local.set', set[1], ['select', set[2], ['local.get', set[1]], stmt[1]]]
    }
    return stmt
  }
  // The body in reductions, each one statement, or the two of a NaN-canon min/max (the temp's
  // set and the select that reads it). Every other statement must be a temp: a set of a local
  // to a value with no effect, which is that value where the statements after it read the
  // local. `const x = a[i]` ahead of `s += x` and of `if (x > m) m = x` is one; so is the load
  // `m = a[i] > m ? a[i] : m` hoists, and the load the load cache shares between statements:
  // `(local.set $t C)` declares it, the first read is `(local.tee $t LOAD)` and the reads after
  // it `(local.get $t)` (inlineLaneTees: inlined in its statement, and for those after it).
  // Sound: the lift only consumes the inlined value for the SIMD prefix; the temp's own set
  // survives in the scalar remainder (the unchanged blockNode), so it stays defined wherever
  // else it is read. Several reductions lift as one loop, each with its accumulators, where
  // none reads another's accumulator: a sum beside a sum of squares, a minimum beside a maximum.
  const isSet = (s) => isArr(s) && s[0] === 'local.set' && s.length === 3 && typeof s[1] === 'string'
  const temps = new Map(), groups = []
  const inlined = (n) => !isArr(n) || !temps.size ? n : n[0] === 'local.get' && temps.has(n[1]) ? cloneNode(temps.get(n[1])) : n.map(inlined)
  // (a statement's own tees first, which its reads after them see; then the temps of the statements
  // before it. A write a statement still holds inside it refuses the reduction where its operand is scanned.)
  // (first without the tees nothing reads, lift.js deadTee: the test's read of an element and the
  // store's are then one expression. The loop as written keeps them: this is the recognizer's copy.)
  const undead = (n) => !isArr(n) ? n : deadTee(n) ? undead(n[2]) : n.map(undead)
  const normal = (stmt, teed) => asSelectAssign(inlined(inlineLaneTees(undead(stmt), bl.outsideReads, teed)))
  for (let i = 3; i < incIdx; i++) {
    const teed = new Map(), s = normal(loopNode[i], teed)
    if (!isSet(s)) return null
    if (usesLocal(s[2], s[1])) groups.push([s])
    else {
      // (the canon pair: the next statement reads this one's temp into the accumulator this one read)
      const next = i + 1 < incIdx ? normal(loopNode[i + 1], new Map()) : null
      if (isSet(next) && next[1] !== s[1] && usesLocal(s[2], next[1]) && usesLocal(next[2], s[1])) { groups.push([s, next]); i++ }
      else if (hasSideEffect(s[2])) return null
      else temps.set(s[1], s[2])
    }
    for (const [t, load] of teed) temps.set(t, load)
  }
  if (!groups.length) return null
  const found = []
  for (const g of groups) {
    const m = matchReduction(g)
    if (!m) return null
    found.push(m)
  }
  return reduceWrapper(bl, freshIdRef, multiAcc, found)

  // One reduction of the body: what its lanes are and how they fold, or null.
  function matchReduction(body0) {
    const bodyLen = body0.length
    let accName, opName, mergeOp = null, reduceEntry, exprNode, canonC = null
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
        // so it rides the relaxedFloat tier (on at 'speed'); strict callers opt out (scalar).
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
        const plain = plainReduce(rhs, accName)
        if (!plain) return null
        opName = plain.opName; mergeOp = plain.mergeOp; reduceEntry = plain.reduceEntry; exprNode = plain.exprNode
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
    let widen = (opName === 'i32.add' && accType === 'i32' && canonC == null
      && isArr(exprNode) && exprNode.length === 2 && WIDEN_LOADS[exprNode[0]]) || null
    // The narrowing sum (lane-tables.js NARROW_LANES): the lanes are the f64 operand's, converted
    // into the i32 accumulator's two low lanes.
    if (!widen && accType === 'i32' && canonC == null && !reduceEntry.minmaxSelect && constNum(reduceEntry.constNode) === 0
        && isArr(exprNode) && exprNode.length === 2 && NARROW_LANES[exprNode[0]]) {
      widen = { laneType: 'f64', steps: [NARROW_LANES[exprNode[0]]], fold: 2 }
      exprNode = exprNode[1]
    }
    // Widening float min/max: the canon over a sign-matched converted narrow load
    // (`m = Math.max(m, u8[i])`, acc f64) folds at the load's own width — exact,
    // since min/max never rounds and u8…i16 values are exact in f64. Only the one
    // horizontal result converts to f64 for the merge (+ re-canon for a NaN acc).
    // (with its NaN canon or bare, where the dead-canon pass took it: optimize/nan-canon.js)
    if ((opName === 'f64.max' || opName === 'f64.min') && accType === 'f64'
        && isArr(exprNode) && exprNode.length === 2 && MINMAX_CVT[exprNode[0]] && isArr(exprNode[1])) {
      // (a whole signed word too, `Math.max(m, int32arr[i])`: exact in an f64 as the narrower are)
      const w = MINMAX_WIDEN[exprNode[1][0]] ?? (exprNode[1][0] === 'i32.load' ? WHOLE_WORD : null)
      if (w && w.sign === MINMAX_CVT[exprNode[0]]) {
        const isMax = opName === 'f64.max'
        reduceEntry = {
          simd: `${w.pre}.${isMax ? 'max' : 'min'}_${w.sign}`,
          extract: w.extract ?? `${w.pre}.extract_lane_${w.sign}`, laneType: w.laneType,
          identity: ['i32.const', isMax ? w.lo : w.hi],
          minmaxSelect: true, isMax, accF64: exprNode[0], canonC,
        }
        exprNode = exprNode[1]
        canonC = null
      }
    }
    // A count under a test of f64 elements (`if (a[i] > t) n++`: an i32 accumulator fed a choice of
    // two small integers by a comparison of f64 lanes): the lanes are the comparison's, so the
    // choice is of the same integers as floats and the count their float sum, exact in any order
    // (integers of at most 2^20 a pass, under 2^31 passes), taken back to a word at the merge.
    let counted = null
    if (!widen && accType === 'i32' && canonC == null && (opName === 'i32.add') && isArr(exprNode) && exprNode[0] === 'select' && exprNode.length === 4) {
      const [x, y] = [constNum(exprNode[1]), constNum(exprNode[2])]
      if (isI32Const(exprNode[1]) && isI32Const(exprNode[2]) && Math.abs(x) <= 0x100000 && Math.abs(y) <= 0x100000 && testsF64(exprNode[3])) {
        counted = mergeOp
        opName = 'f64.add'; mergeOp = 'f64.add'; reduceEntry = REDUCE_OP_LOOKUP.get('f64.add')
        exprNode = ['select', ['f64.const', x], ['f64.const', y], exprNode[3]]
      }
    }
    if (!widen && accType !== (counted ? 'i32' : reduceEntry.accI32 ? 'i32' : reduceEntry.accF64 ? 'f64' : reduceEntry.laneType)) return null

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
        // a constant element offset (`a[i + 3]`) rides the memarg, `offset=12`: the lane
        // address is the operand after it, and the lift keeps the memarg on the vector load
        const m = matchLaneAddr(typeof node[1] === 'string' && node[1].startsWith('offset=') ? node[2] : node[1], incVar, addrLocals, offsetTees)
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
      // (a local the body writes is no invariant: another reduction's accumulator, or one a later
      // statement sets, read here as the pass before left it)
      if (bl.writes.has(name)) return null
      localKind.set(name, 'invariant')
    }
    for (const name of addrLocals.keys()) localKind.set(name, 'addr')
    for (const name of offsetTees.keys()) localKind.set(name, 'addr')

    const ctx = liftCtx(laneType, incVar, localKind, freshIdRef, fnLocals)

    const liftedExpr = liftExprV(exprNode, ctx)
    // liftExprV's contract is "null ⟺ ctx.fail"; under self-compile (jz.wasm) it can diverge and
    // return null WITHOUT the flag, which would otherwise splice a literal `null` operand into the
    // emitted `(<reduce>.add acc null)` — invalid wasm ("not enough arguments on the stack"). Treat
    // a null lift as a bail (the loop stays scalar — correct, just unvectorized on that leg).
    if (ctx.fail || liftedExpr == null) return null
    if (ctx.newLanedLocals.size > 0 || ctx.extraLocals.length > 0) return null

    return { reduceEntry, opName, accName, canonC, laneType, liftedExpr, widen, sawWidenF32, mergeOp: mergeOp ?? opName, counted }
  }
}

// SIMD prefix + horizontal fold + (preserved scalar tail), shared by tryReduceReassoc and
// tryGeneralReduce: N vector accumulators over the lifted operand, combined and folded
// across lanes, merged into the live accumulator; the original loop runs the remainder.
// The block's preamble (scaffold.js preambleOf: pure sets the loop neither writes nor reads
// a write of) runs cloned first, where the strips read the bases and the bound it stages: a
// plain array's unboxed pointer and its forwarded header, a typed array's held in a field.
// `widen`/`sawWidenF32` are the narrow-widening sum shapes only tryReduceReassoc produces:
// `widen` takes a vector of its lane type to i32x4 partials by its `steps`, of which `fold`
// lanes hold a value (all four where it names none).
// `mergeOp` merges the folded lanes into the accumulator: the reduction's op, or the
// subtraction of a sum taken from it (plainReduce).
// `found` is the loop's reductions (matchReduction's, tryGeneralReduce's one): each brings its
// accumulators, what a round adds to them and how they fold (reducePart), and the strips run
// them side by side, a round of each a pass. All step by one count of elements a round.
function reduceWrapper(bl, freshIdRef, multiAcc, found) {
  const { incVar } = bl
  const parts = found.map(m => reducePart(m, freshIdRef, multiAcc))
  const { id, step, guarded } = parts[0]
  // (a guarded part's prefix is skipped whole where no strip runs: alone in its loop)
  if (parts.length > 1 && parts.some(p => p.step !== step || p.guarded)) return null
  const simdBoundName = `$__simd_bound${id}`
  const boundExpr = bl.boundLocal ? ['local.get', bl.boundLocal] : bl.bound
  const loopBody = parts.flatMap(p => p.accumulate)
  loopBody.push(['local.set', incVar, ['i32.add', ['local.get', incVar], ['i32.const', step]]])
  const simdBlock = simdLoop(id, incVar, simdBoundName, loopBody, bl.dir)
  // Span-aligned SIMD bound: stop while a full `lanes`-wide load stays in
  // range, for ANY induction start (the min/max idiom seeds m=a[0] and starts
  // at i=1, which `& ~(lanes-1)` masking would run one lane past the end). For
  // a lane-aligned start this yields the same iteration set as masking; the
  // scalar tail (original `i<bound` guard) cleans up regardless.
  // A full N·lanes-wide step (all N accumulators) must stay in range.
  const boundSetup = ['local.set', simdBoundName, simdBound(incVar, boundExpr, step, 0, bl.dir)]
  // Narrow-widened entries seed the vector acc with a LANE-domain neutral (e.g.
  // 0 for u8-max) — only neutral once real lanes fold in. Guard the whole SIMD
  // prefix incl. the merge so a zero-iteration range can't clamp the live acc
  // toward the identity. Full-width entries use absolute neutrals; unguarded.
  // (The guarded path is always NACC=1 — accI32/accF64 are non-plain reductions.)
  const prefix = [...parts.flatMap(p => p.initAcc), simdBlock, ...parts.flatMap(p => [...p.combineAccs, ...p.mergeStmts])]
  const core = guarded ? [['if', stripOpen(incVar, simdBoundName, bl.dir, step), ['then', ...prefix]]] : prefix
  const wrapper = ['block', ...bl.preamble.map(cloneNode), boundSetup, ...core, bl.blockNode]
  return { wrapper, newLocalDecls: [['local', simdBoundName, 'i32'], ...parts.flatMap(p => p.decls)], reductions: new Set(found.map(m => m.accName)) }
}

// One reduction's part of the strips: its accumulators' start, what a round adds to them, their
// fold into one and its merge into the live accumulator, the locals it declares, the elements a
// round takes (`step`), and whether its prefix must be skipped where no strip runs (`guarded`).
function reducePart(m, freshIdRef, multiAcc) {
  const { reduceEntry, opName, accName, canonC, laneType, liftedExpr, widen, sawWidenF32, mergeOp, counted } = m
  const stride = LANE_INFO[laneType].stride
  const id = freshIdRef.next++
  const simdAccName = `$__simd_acc${id}`   // accumulator 0 — the one the merge folds
  const info = LANE_INFO[laneType]
  const lanes = info.lanes

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
  // The narrowing sum takes them too (lane-tables.js NARROW_LANES: whole v128 loads of f64
  // lanes, a round's conversions independent of one another, and a wrapping integer sum the
  // same in any order): with one accumulator an integer sum over 256 cells ran at 36 ns
  // where the float sum beside it, four to the round, ran at 15. The byte and short
  // widening sums keep one: not measured.
  const narrowing = widen?.laneType === 'f64'
  // And the float extreme by a test (`if (a[i] > m) m = a[i]`, f64x2.pmax): its one accumulator
  // carries a compare and a select from round to round, where the loop as written carries a
  // branch that predicts. Over 256 elements one accumulator ran at 79 ns, the loop at 73.
  const NACC = multiAcc && (plainReduce && (laneType === 'f64' || laneType === 'f32') || narrowing || reduceEntry.pmaxF64 === true) ? 4 : 1
  const accK = (k) => k === 0 ? simdAccName : `$__simd_acc${id}_${k}`
  const laneBytes = lanes * stride

  // Widening sum: the ACCUMULATOR vector is i32x4 regardless of the (narrow)
  // lane type; each iteration's 16-byte load collapses via extadd_pairwise.
  const accSplat = widen ? 'i32x4.splat' : info.splat
  const accumOperand = widen ? widen.steps.reduce((e, s) => [s, e], liftedExpr) : liftedExpr
  // Accumulator k reads the same lane-aligned data as acc 0, shifted by k chunks
  // (k·laneBytes). Acc 0 keeps the address tees (it sets them); acc k>0 reads the
  // tee'd address (normTee → local.get) and adds the byte offset to each load.
  // (a load that carries its constant element offset as a memarg, `a[i + 1]`, adds to it)
  const offsetLoads = (node, off) => !isArr(node) ? node
    : node[0] === 'v128.load' ? (typeof node[1] === 'string' && node[1].startsWith('offset=')
      ? ['v128.load', `offset=${+node[1].slice(7) + off}`, ...node.slice(2)]
      : ['v128.load', ['i32.add', node[1], ['i32.const', off]]])
    : node.map(c => offsetLoads(c, off))
  const accOperandFor = (k) => k === 0 ? accumOperand : offsetLoads(normTee(accumOperand), k * laneBytes)

  const initAcc = []
  for (let k = 0; k < NACC; k++) initAcc.push(['local.set', accK(k), [accSplat, reduceEntry.constNode ?? reduceEntry.identity]])
  const accumulate = []
  for (let k = 0; k < NACC; k++) accumulate.push(['local.set', accK(k), [reduceEntry.simd, ['local.get', accK(k)], accOperandFor(k)]])
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
      if (reduceEntry.canonC != null) mergeStmts.push(['local.set', accName,
        ['select', reduceEntry.canonC, ['local.get', accName],
          ['f64.ne', ['local.get', accName], ['local.get', accName]]]])
    } else {
      mergeStmts.push(['local.set', accName, minmaxSel(['local.get', accName], ['local.get', ht])])
    }
  } else {
    // Horizontal fold: scalar.op(extract 0, extract 1, …, extract L-1).
    // Widening sum folds the 4 i32x4 PARTIALS, not the (narrow) data lanes.
    const foldLanes = widen ? widen.fold ?? 4 : lanes
    let horiz = [reduceEntry.extract, 0, ['local.get', simdAccName]]
    for (let k = 1; k < foldLanes; k++) {
      horiz = [opName, horiz, [reduceEntry.extract, k, ['local.get', simdAccName]]]
    }
    // Merge the SIMD result into the live accumulator. For canon (min/max) the
    // merged value is re-canonicalized so a NaN that surfaced only in the SIMD
    // range still crosses as the canonical NaN when the scalar tail is empty.
    // (a count kept in float lanes goes back to its word: exact, the lanes' sum an integer)
    const merged = counted ? [counted, ['local.get', accName], ['i32.wrap_i64', ['i64.trunc_sat_f64_s', horiz]]] : [mergeOp, ['local.get', accName], horiz]
    mergeStmts = canonC == null
      ? [['local.set', accName, merged]]
      : [['local.set', accName, merged],
         ['local.set', accName,
           ['select', canonC, ['local.get', accName],
             [`${laneType}.ne`, ['local.get', accName], ['local.get', accName]]]]]
  }
  const decls = [
    ['local', simdAccName, 'v128'],
    ...Array.from({ length: NACC - 1 }, (_, k) => ['local', accK(k + 1), 'v128']),
    ...extraDecls,
  ]
  return { id, step: lanes * NACC, guarded: !!(reduceEntry.accI32 || reduceEntry.accF64), initAcc, accumulate, combineAccs, mergeStmts, decls }
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
// The other lowering of a reduction (`tryReduceReassoc`'s doc above): the loop's own order.
// The f64 ops whose f64x2 form computes each lane as the scalar op computes it, bit for bit
// (wasm SIMD: lane-wise IEEE 754 arithmetic, the same min/max and roundings, no fused op).
const EXACT_LANE_BIN = new Set(['f64.add', 'f64.sub', 'f64.mul', 'f64.div', 'f64.min', 'f64.max'])
const EXACT_LANE_UN = new Set(['f64.sqrt', 'f64.abs', 'f64.neg', 'f64.ceil', 'f64.floor', 'f64.trunc', 'f64.nearest'])
// An f64 from the low two lanes of an i32x4 or an f32x4, exact as the scalar widening.
const CONVERT_LOW = { ...CONVERT_LANES.f64, 'f64.promote_f32': 'f64x2.promote_low_f32x4' }
// An integer element in an i32x4's low lanes: the load of two (its bytes' log2 a stride) and the widening of each.
const LOW_INT_LOAD = {
  'i32.load': ['v128.load64_zero', 2],
  'i32.load16_s': ['v128.load32_zero', 1, 'i32x4.extend_low_i16x8_s'],
  'i32.load16_u': ['v128.load32_zero', 1, 'i32x4.extend_low_i16x8_u'],
  'i32.load8_s': ['v128.load16_splat', 0, 'i16x8.extend_low_i8x16_s', 'i32x4.extend_low_i16x8_s'],
  'i32.load8_u': ['v128.load16_splat', 0, 'i16x8.extend_low_i8x16_u', 'i32x4.extend_low_i16x8_u'],
}
const INT_LANE_BIN = { 'i32.add': 'i32x4.add', 'i32.sub': 'i32x4.sub', 'i32.mul': 'i32x4.mul', 'i32.and': 'v128.and', 'i32.or': 'v128.or', 'i32.xor': 'v128.xor' }
const INT_LANE_SHIFT = { 'i32.shl': 'i32x4.shl', 'i32.shr_s': 'i32x4.shr_s', 'i32.shr_u': 'i32x4.shr_u' }
// The mirrors (lane-tables.js PPC_CALL2) that run both lanes through the scalar kernel's own
// operations in one evaluation (module/math/simd.js), bit for bit with the scalar call; the
// others take each lane out and call the scalar kernel, no work saved. A call weighs what an
// evaluation of the kernel does, against the ops the weights count: tens of them.
const TWO_WIDE = new Set(['$math.sin2', '$math.cos2', '$math.pow2', '$math.pow_b_v', '$math.pow_fold_v', '$math.log_v', '$math.exp_v', '$math.exp2_v'])
const CALL_WEIGHT = 20
export function tryReduceBitExact(bl, fnLocals, freshIdRef) {
  if (!bl) return null
  const { incVar, bound, boundLocal, body, siteAccess, writes } = bl
  if (!boundLocal && !isI32Const(bound)) return null
  if (!body.length) return null
  // (a loop counting down runs a strip's lanes from the last: its lanes' contributions are
  // carried in the loop's order, the higher lane first, scaffold.js simdLoop)
  const order = bl.dir === -1 ? [1, 0] : [0, 1]
  // An index the body defines once from the counter (`const j = i`) is computed at the lanes'
  // first pass and read by their addresses (addr-model.js indexDefs, affineIvCoeff).
  // An address tee (`(local.tee $a (i32.add o i))` at one read of `px[o + i]`, `$a` at the next:
  // addressTees) stands for its value in the addresses after it, as an index temporary does.
  const defs = indexDefs(body, fnLocals, bl.outsideReads)
  const addrDefs = new Map([...defs, ...addressTees(body, fnLocals)]), ivCoeff = affineIvCoeff(incVar, writes, addrDefs)
  const offTees = new Map(), addrTees = new Map()

  // Every body stmt must be `(local.set $x EXPR)`. An accumulator reads its own target
  // through `f64.add` or `f64.mul` (`acc = acc + EXPR`, `acc = acc * EXPR`); the rest are
  // per-iteration lane locals. (One write per acc — duplicate writes would break the per-acc
  // ordering.) The statements are the loop's whatever their count: `s += a[i] * b[i]` and
  // `const x = a[i] * b[i]; s = s + x` lift alike.
  for (const s of body) if (!(isArr(s) && s[0] === 'local.set' && typeof s[1] === 'string' && s.length === 3)) return null
  const accSet = new Set()
  for (const s of body) if (isArr(s[2]) && (s[2][0] === 'f64.add' || s[2][0] === 'f64.mul') && isLocalGet(s[2][1], s[1])) accSet.add(s[1])
  if (!accSet.size) return null
  const writeCount = new Map()
  for (const s of body) writeCount.set(s[1], (writeCount.get(s[1]) || 0) + 1)
  for (const a of accSet) { if (writeCount.get(a) !== 1 || fnLocals.get(a) !== 'f64' || defs.has(a)) return null }
  // A body that is only accumulators, each fed an integer element as it is loaded, is the wide
  // accumulator's (optimize/wide-accumulator.js): carried as an integer its add is off the float
  // chain, where the lanes here would convert two elements and still add them in the loop's order,
  // a lane's extraction a round on top. Over an Int32Array the lift ran at 93 ns for 256 elements
  // where the loop as written runs at 72; with no wide accumulator the loop as written runs at 79.
  // (An f32 element's sum stays: its promotion in lanes ran at 86 ns at level 2 where 97 without.)
  const whole = (e) => isArr(e) && CONVERT_LOW[e[0]] != null && e.length === 2 && isArr(e[1]) && LOW_INT_LOAD[e[1][0]] != null
  if (body.every(s => accSet.has(s[1]) && whole(s[2][2]))) return refusedFor('cost')

  // Address tees: locals that equal `ind << K`. f64 loads must be stride-8 (K=3) so one
  // f64x2.load (16 bytes) covers iterations j and j+1 — consecutive elements. BodyModel fact
  // (bl.siteAccess, see buildSiteAccess) — computed once at the dispatch instead of a private
  // per-site matchLaneAddr(e[1], incVar, new Map(), bl.offsetTees) call — shadow-assert-proven
  // equivalent to that plain query (.work/evidence.md §BodyModel).

  // f64x2 lift: load → f64x2.load (2 consecutive), const/invariant → splat, a lane local
  // → its f64x2 temp (a tee of one, its temp's), and each op whose lanes round as the scalar
  // op does (wasm SIMD: the f64x2 arithmetic, min, max and roundings are the scalar ops' per
  // lane) → its f64x2 op. Anything else bails.
  const laneV = new Map(), teed = new Set()
  for (const s of body) walkAst(s, { enter: n => { if (n[0] === 'local.tee' && typeof n[1] === 'string') teed.add(n[1]) } })
  const newLocalDecls = []
  const fresh = () => { const n = `$__mr${freshIdRef.next++}`; newLocalDecls.push(['local', n, 'v128']); return n }
  // A field of a record of k elements (`pts[2 * (o + i) + 1]`, k = 2..8): its address moves 8k
  // bytes a pass (addr-model.js affineAddr), so its lane 1 is what the next pass reads, 8k bytes
  // on. Where the loop reads every field of a record of two, three or four, the two records are
  // k vectors loaded once and each field a shuffle of two of them (`blocks`); any other field
  // is a gather, a load for each lane, its address computed once. Either reads only what the
  // two scalar passes read.
  const affine = affineAddr(incVar, writes, addrDefs)
  const offsetOf = (e) => { for (let i = 1; i < e.length - 1; i++) if (typeof e[i] === 'string' && e[i].startsWith('offset=')) return +e[i].slice(7); return 0 }
  const forms = new Map()        // load → its form
  const fieldSites = new Map()   // `c|key` → [{ e, C, s, tee }]
  if (bl.dir !== -1) for (const s of body) walkAst(s, { enter: n => {
    if (n[0] !== 'f64.load' || siteAccess.get(n)) return
    const addr = n[n.length - 1], f = affine(addr)
    if (!f) return
    forms.set(n, f)
    if (f.c % 8 !== 0 || f.c < 16 || f.c > 64) return
    let tee = false
    walkAst(addr, { enter: x => { if (x[0] === 'local.tee') tee = true } })
    const k = `${f.c}|${f.key}`
    if (!fieldSites.has(k)) fieldSites.set(k, [])
    fieldSites.get(k).push({ e: n, C: f.k + offsetOf(n), s: f.c, tee })
  } })
  // (a block: every field of a record of two, three or four read; the vectors load where the
  // pass first reads one, at that load's address moved back to the record's first field, so a
  // tee in it runs where it ran; the other loads' addresses, tee-free, go)
  const blocks = new Map()       // load → { g, field }
  for (const sites of fieldSites.values()) {
    const s = sites[0].s, k = s / 8, C0 = Math.min(...sites.map(x => x.C))
    const fields = new Set(sites.map(x => (x.C - C0) / 8))
    if (k > 4 || fields.size !== k || sites.some(x => x.C - C0 >= s || (x.C - C0) % 8 !== 0)) continue
    if (sites.some((x, i) => i > 0 && x.tee)) continue
    const first = sites[0], back = first.C - C0, off = offsetOf(first.e) - back
    let addr = first.e[first.e.length - 1]
    if (off < 0) addr = ['i32.sub', addr, ['i32.const', -off]]
    const g = { k, addr, off: Math.max(off, 0), temps: null }
    for (const x of sites) blocks.set(x.e, { g, field: (x.C - C0) / 8 })
  }
  let shuffles = 0
  const bytes = (lane) => Array.from({ length: 8 }, (_, b) => String(lane * 8 + b))
  const blockLanes = ({ g, field }) => {
    // lane 0 is element `field` of the two records' 2k, lane 1 element `field + k`
    const shuffle = (temps) => { shuffles++; const m = field + g.k; return ['i8x16.shuffle', ...bytes(field & 1), ...bytes(2 + (m & 1)), ['local.get', temps[field >> 1]], ['local.get', temps[m >> 1]]] }
    if (g.temps) return shuffle(g.temps)
    g.temps = Array.from({ length: g.k }, () => fresh())
    // (the address once: the first vector's tees it, the others read it)
    const a = `$__mra${freshIdRef.next++}`
    newLocalDecls.push(['local', a, 'i32'])
    const loads = g.temps.map((t, v) => ['local.set', t, ['v128.load', ...(g.off + 16 * v ? [`offset=${g.off + 16 * v}`] : []), v ? ['local.get', a] : ['local.tee', a, g.addr]]])
    return ['block', ['result', 'v128'], ...loads, shuffle(g.temps)]
  }
  const gatherLanes = (e, s) => {
    let off = 0
    const rest = []
    for (let i = 1; i < e.length - 1; i++) { const x = e[i]; if (typeof x === 'string' && x.startsWith('offset=')) off = +x.slice(7); else rest.push(x) }
    let a0 = e[e.length - 1], a1
    if (isArr(a0) && a0[0] === 'local.get') a1 = a0
    else if (isArr(a0) && a0[0] === 'local.tee' && a0.length === 3) a1 = ['local.get', a0[1]]
    else { const t = `$__mra${freshIdRef.next++}`; newLocalDecls.push(['local', t, 'i32']); a0 = ['local.tee', t, a0]; a1 = ['local.get', t] }
    const load = (o, a) => ['f64.load', ...(o ? [`offset=${o}`] : []), ...rest, a]
    return ['f64x2.replace_lane', 1, ['f64x2.splat', load(off, a0)], load(off + s, a1)]
  }
  let bad = false, calls = 0
  const lift = (e) => {
    if (bad || !isArr(e)) { bad = true; return null }
    const op = e[0]
    if (op === 'f64.const') return ['f64x2.splat', e]
    if (op === 'call' && TWO_WIDE.has(PPC_CALL2[e[1]])) { calls++; return ['call', PPC_CALL2[e[1]], ...e.slice(2).map(lift)] }
    if (op === 'f64.load') {
      // 16 bytes = 2 consecutive f64s; the f64x2 op reads them (a memarg kept)
      const addr = e[e.length - 1]
      const m = siteAccess.get(e) ?? (matchStrideAddr(addr, 8, writes, offTees, addrTees, ivCoeff) && { strideLog2: 3 })
      if (m && m.strideLog2 === 3 && (m.pixelStride ?? 1) === 1) return ['v128.load', ...e.slice(1)]
      if (blocks.has(e)) return blockLanes(blocks.get(e))
      const f = forms.get(e)
      // (a record wider than eight values: no gather of its fields, the advisories' 'stride')
      if (!f || f.c % 8 !== 0 || f.c < 16 || f.c > 64) { if (f && f.c > 64) refusedFor('stride'); bad = true; return null }
      return gatherLanes(e, f.c)
    }
    if (op === 'local.get' && typeof e[1] === 'string') {
      if (e[1] === incVar || accSet.has(e[1])) { bad = true; return null }   // IV-as-data / acc-dependent contribution
      if (laneV.has(e[1])) return ['local.get', laneV.get(e[1])]
      // a body local read BEFORE its write this iteration → loop-carried, not a fresh lane
      // (a write anywhere in the loop: a statement's, a tee's, a value block's)
      if (writes.has(e[1]) || teed.has(e[1])) { bad = true; return null }
      return ['f64x2.splat', e]   // genuine loop-invariant scalar (xi, …)
    }
    // A value block (an inlined helper's let-binding, `(block (result f64) (local.set $u …) V)`):
    // straight-line, its sets lane temps as the body's statements are, its last child the value.
    if (op === 'block' && isArr(e[1]) && e[1][0] === 'result' && e[1][1] === 'f64' && e[1].length === 2) {
      const out = ['block', ['result', 'v128']]
      for (let i = 2; i < e.length - 1; i++) {
        const s = e[i]
        if (!(isArr(s) && s[0] === 'local.set' && typeof s[1] === 'string' && s.length === 3) || s[1] === incVar || accSet.has(s[1]) || defs.has(s[1]) || fnLocals.get(s[1]) !== 'f64') { bad = true; return null }
        const v = lift(s[2])
        if (bad) return null
        if (!laneV.has(s[1])) laneV.set(s[1], fresh())
        out.push(['local.set', laneV.get(s[1]), v])
      }
      out.push(lift(e[e.length - 1]))
      return bad ? null : out
    }
    // (an operand here is an f64, as wasm types it; the body writes no global, its statements all locals')
    if (op === 'global.get') return ['f64x2.splat', e]
    if (op === 'local.tee' && typeof e[1] === 'string' && e.length === 3) {
      if (e[1] === incVar || accSet.has(e[1]) || defs.has(e[1])) { bad = true; return null }
      const v = lift(e[2])
      if (!laneV.has(e[1])) laneV.set(e[1], fresh())
      return ['local.tee', laneV.get(e[1]), v]
    }
    if (EXACT_LANE_BIN.has(op) && e.length === 3) return [op.replace('f64.', 'f64x2.'), lift(e[1]), lift(e[2])]
    if (EXACT_LANE_UN.has(op) && e.length === 2) return [op.replace('f64.', 'f64x2.'), lift(e[1])]
    if (CONVERT_LOW[op] && e.length === 2) return [CONVERT_LOW[op], (op === 'f64.promote_f32' ? liftF32 : liftI)(e[1])]
    bad = true; return null
  }
  // An element of an integer or f32 array widened to an f64 (`s += ia[i] * ib[i]` over
  // Int32Arrays): two elements' lanes, the low two of a v128 loaded from them, the integer
  // ops lane-wise as the scalar ones wrap, then widened as the scalar op widens.
  const element = (e, narrow) => {
    const [load, log2, ...ext] = narrow
    const m = siteAccess.get(e) ?? (matchStrideAddr(e[e.length - 1], 1 << log2, writes, offTees, addrTees, ivCoeff) && { strideLog2: log2 })
    if (!m || m.strideLog2 !== log2) { bad = true; return null }
    return ext.reduce((v, x) => [x, v], [load, ...e.slice(1)])
  }
  const liftI = (e) => {
    if (bad || !isArr(e)) { bad = true; return null }
    const op = e[0]
    if (op === 'i32.const') return ['i32x4.splat', e]
    if (LOW_INT_LOAD[op]) return element(e, LOW_INT_LOAD[op])
    if (op === 'local.get' && typeof e[1] === 'string') {
      if (e[1] === incVar || writeCount.has(e[1]) || teed.has(e[1]) || defs.has(e[1])) { bad = true; return null }
      return ['i32x4.splat', e]
    }
    if (op === 'global.get') return ['i32x4.splat', e]
    if (INT_LANE_BIN[op] && e.length === 3) return [INT_LANE_BIN[op], liftI(e[1]), liftI(e[2])]
    // (a shift by a count every pass shares: the lanes' shift takes it, mod 32 as the scalar's)
    if (INT_LANE_SHIFT[op] && e.length === 3 && isI32Const(e[2])) return [INT_LANE_SHIFT[op], liftI(e[1]), e[2]]
    bad = true; return null
  }
  const liftF32 = (e) => {
    if (!isArr(e) || e[0] !== 'f32.load') { bad = true; return null }
    return element(e, ['v128.load64_zero', 2])
  }

  // Lifted body: setup lanes → f64x2 temps (in order, so the offset tee in the first load
  // is set before later loads read it); each accumulator → a temp + two in-order adds.
  const lifted = []
  for (const s of body) {
    if (defs.has(s[1])) { lifted.push(cloneNode(s)); continue }
    if (accSet.has(s[1])) {
      const cV = fresh()
      const v = lift(s[2][2])
      if (bad) return null
      const op = s[2][0]
      lifted.push(['local.set', cV, v],
        ...order.map(k => ['local.set', s[1], [op, ['local.get', s[1]], ['f64x2.extract_lane', k, ['local.get', cV]]]]))
    } else {
      const tv = fresh()
      const v = lift(s[2])
      if (bad) return null
      laneV.set(s[1], tv)
      lifted.push(['local.set', tv, v])
    }
  }
  if (bad || !lifted.length) return null
  // Two passes of the loop against one step of the lanes, each accumulator's two lanes taken
  // out and carried in order: the lanes may do no more weighted work (cost-model.js), a
  // kernel's evaluation one for two passes. A plain sum is the case they lose: one load
  // saved, a read of the lanes and of the accumulator for each pass paid.
  // (a record field's shuffle weighs one, as the lane ops do: cost-model.js weighs it nothing)
  if (liftWeight(lifted) + shuffles + calls * CALL_WEIGHT > 2 * (liftWeight(body) + calls * CALL_WEIGHT)) return refusedFor('cost')

  // SIMD prefix over the even prefix [0, bound & ~1); the original block is the ≤1 scalar
  // remainder (continues j and the accumulators). IV advances by 2.
  const id = freshIdRef.next++
  const simdBoundName = `$__mrb${id}`
  const boundExpr = boundLocal ? ['local.get', boundLocal] : ['i32.const', constNum(bound)]
  const simdBlock = simdLoop(id, incVar, simdBoundName, [...lifted,
    ['local.set', incVar, ['i32.add', ['local.get', incVar], ['i32.const', 2]]]], bl.dir)
  // span-aligned (same entry≠0 hazard as tryVectorize's bound — see there)
  const boundSetup = ['local.set', simdBoundName, simdBound(incVar, boundExpr, 2, 0, bl.dir)]
  // (the preamble cloned first, as reduceWrapper's)
  const wrapper = ['block', ...bl.preamble.map(cloneNode), boundSetup, simdBlock, bl.blockNode]
  return { wrapper, newLocalDecls: [['local', simdBoundName, 'i32'], ...newLocalDecls], reductions: accSet }
}

// A single-statement reduction's entry: the plain operators, and a min/max whose
// canon the dead-canon pass took (optimize/nan-canon.js) where only arithmetic
// reads the accumulator; the merge then needs no canon of its own (canonC null).
// A float sum or product in lanes adds in another order than the loop: relaxedFloat's alone.
const REASSOCIATES = new Set(['f64.add', 'f64.mul', 'f32.add', 'f32.mul'])
const plainReduceEntry = (opName) => REASSOCIATES.has(opName) && !vecState.relaxF32 ? null : REDUCE_OP_LOOKUP.get(opName) ?? REDUCE_CANON[opName] ?? null
// A signed word's lanes, for an extreme of whole words kept in a float (MINMAX_WIDEN's shape).
const WHOLE_WORD = { pre: 'i32x4', sign: 's', laneType: 'i32', lo: -2147483648, hi: 2147483647, extract: 'i32x4.extract_lane' }
// A condition over f64 values: its lanes are f64's (an element of another width in it fails the scan of its loads).
const testsF64 = (c) => {
  let f64 = false
  walkAst(c, { enter: n => { if (typeof n[0] === 'string' && n[0].startsWith('f64.')) f64 = true } })
  return f64
}
// A plain reduction's value, `acc OP x`, read for both recognizers: its op, the op that merges the
// lanes' result into the accumulator, the table's entry and the operand. Each op here commutes, so
// `x OP acc` is the same reduction (`s = a[i] + s`). And `acc - x` is the sum of the x's taken from
// the accumulator once: the lanes add, the merge subtracts, exactly for a wrapping integer and, for
// a float, in the other order its sum already takes under relaxedFloat.
const SUM_OF = { 'i32.sub': 'i32.add', 'i64.sub': 'i64.add', 'f32.sub': 'f32.add', 'f64.sub': 'f64.add' }
function plainReduce(rhs, accName) {
  // Under a condition, `if (c) acc = acc OP x` (asSelectAssign's `select(acc OP x, acc, c)`): the
  // reduction of `c ? x : N`, N the op's neutral, which leaves the accumulator as it was (a float
  // sum's but for the sign of a zero, relaxedFloat's as its order is).
  if (rhs[0] === 'select' && rhs.length === 4) {
    const plain = isLocalGet(rhs[2], accName) && isArr(rhs[1]) ? plainReduce(rhs[1], accName) : null
    const neutral = plain?.reduceEntry.constNode
    return neutral == null ? null : { ...plain, exprNode: ['select', plain.exprNode, neutral, rhs[3]] }
  }
  if (rhs.length !== 3) return null
  const sum = SUM_OF[rhs[0]], opName = sum ?? rhs[0], reduceEntry = plainReduceEntry(opName)
  if (!reduceEntry) return null
  if (isLocalGet(rhs[1], accName)) return { opName, mergeOp: rhs[0], reduceEntry, exprNode: rhs[2] }
  return sum == null && isLocalGet(rhs[2], accName) ? { opName, mergeOp: opName, reduceEntry, exprNode: rhs[1] } : null
}

// ---- General base-layer REDUCTION recognizer (dispatch-chain terminal) ----------------
//
// Generalizes `tryReduceReassoc`'s shape-specific address proof (`matchLaneAddr`'s literal
// post-lowering WAT-pattern list) to the affine-in-IV proof `tryGeneralMap` uses for maps:
// `affineIvCoeff` + `matchStrideAddr`. The lane stride is passed to `matchAddr` explicitly:
// the accumulator fixes the lane type before any load is scanned.
//
// Preconditions (design brief): single scalar accumulator, ONE recognized associative-
// commutative op (`REDUCE_OP_LOOKUP`: i32/i64 add·mul·xor·and·or, f32/f64 add·mul — the SAME
// table `tryReduceReassoc` itself gates on, so no new op is accepted, only a broader ADDRESS proof) —
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
// Deliberately OUT of scope (stays `tryReduceReassoc`'s territory — its address proof already succeeds
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
// those shapes (the accType gate below enforces it). Fold order: it reorders exactly where
// `tryReduceReassoc` does (a float add or multiply under relaxedFloat alone, plainReduceEntry),
// value-exact everywhere `tryReduceReassoc` already is (int add/mul/xor/and/or, min/max) — no
// new numeric divergence, same fold order, just reached from a broader address proof.
export function tryGeneralReduce(bl, fnLocals, freshIdRef, multiAcc = false) {
  if (!bl) return null
  const { incVar, bound, boundLocal, body, writes } = bl
  if (!boundLocal && !isI32Const(bound)) return null
  if (body.length !== 1 && body.length !== 2) return null

  let accName, opName, mergeOp = null, reduceEntry, exprNode, canonC = null
  if (body.length === 1) {
    const stmt = body[0]
    if (!isArr(stmt) || stmt[0] !== 'local.set' || stmt.length !== 3) return null
    accName = stmt[1]
    if (typeof accName !== 'string') return null
    const rhs = stmt[2]
    if (!isArr(rhs)) return null
    const minmax = matchIntMinMaxReduce(rhs, accName)
    if (minmax && minmax.laneType === 'f64') {
      // Same relaxedFloat gate tryReduceReassoc uses for the f64 pmax/pmin tier — see its own
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
      const plain = plainReduce(rhs, accName)
      if (!plain) return null
      opName = plain.opName; mergeOp = plain.mergeOp; reduceEntry = plain.reduceEntry; exprNode = plain.exprNode
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

  // (an address tee stands for its value: `px[o + i]` then `py[o + i]`, addr-model.js addressTees)
  const ivCoeff = affineIvCoeff(incVar, writes, addressTees(body, fnLocals))
  const offTees = new Map(), addrTees = new Map()
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

  const ctx = liftCtx(laneType, incVar, localKind, freshIdRef, fnLocals)
  const liftedExpr = liftExprV(exprNode, ctx)
  // Same fail-open contract as tryReduceReassoc (see its own doc): a null lift without the
  // flag (self-compile divergence) bails rather than splicing a literal `null` operand.
  if (ctx.fail || liftedExpr == null) return null
  if (ctx.newLanedLocals.size > 0 || ctx.extraLocals.length > 0) return null
  // Cost model (cost-model.js): the vector side is the one accumulate step the codegen below
  // emits per group, the reduce op (`reduceEntry.simd`) over `liftedExpr`.
  if (!isProfitable(body, [[reduceEntry.simd, liftedExpr]], LANE_INFO[laneType].lanes))
    return liftFail(ctx, 'not profitable: vector cost/lane ≥ scalar cost', 'cost')

  return reduceWrapper(bl, freshIdRef, multiAcc, [{ reduceEntry, opName, accName, canonC, laneType, liftedExpr, widen: null, sawWidenF32: false, mergeOp: mergeOp ?? opName }])
}
