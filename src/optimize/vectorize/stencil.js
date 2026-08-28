import { nodeEqual as exprEq, cloneNode, walkAst } from '../../ast.js'
import { constNum, firstAccess, hasGlobalSet, isI32Const, isLocalGet } from './addr-model.js'
import { ALIAS_VERSION_MAX_BODY_NODES, gmNodeCount, isProfitable } from './cost-model.js'
import { normTee } from './idioms.js'
import { LANE_INFO, LOAD_OPS, STORE_OPS } from './lane-tables.js'
import { liftFail, liftStmt } from './lift.js'
import { forEachLocalDef, isArr } from './node-utils.js'

export function tryStencil(node, fnLocals, freshIdRef, enabled, bl) {
  if (!enabled) return null
  // Consumes the dispatch-computed inner scaffold (LoopPlan) — the opts there
  // ({ allowPreamble: true, allowInlinedLi: true }) are exactly what this pass
  // matched for itself (inlined LICM preambles carry grid row-bases like
  // schrodinger's `y*w`).
  if (!bl) return null
  const { incVar, bound, body, preamble, hasGlobalSet: blHasGlobalSet, writes, referenced: blReferenced } = bl   // preamble: LICM-hoisted $__li invariants
  if (blHasGlobalSet) return null

  // Leaf-stencil guard: a stencil body is pure array arithmetic. A NESTED LOOP (the outer loop of a
  // 2-D sweep, whose body contains the inner loop) or a non-$math call must NOT be lifted as a
  // stencil — its "neighbour reads" would be the nested loop's loads, misaligned. waves/schrodinger/
  // metaballs bodies are pure arithmetic (math calls allowed), so they pass.
  const hasNestedLoopOrCall = (n) => {
    let found = false
    walkAst(n, { enter: x => {
      if (found) return false
      if (x[0] === 'loop' || (x[0] === 'call' && (typeof x[1] !== 'string' || !x[1].startsWith('$math.'))) || x[0] === 'call_indirect') { found = true; return false }
    } })
    return found
  }
  if (body.some(hasNestedLoopOrCall)) return null

  // Bound is re-evaluated for the SIMD guard, so it must be a PURE loop-invariant
  // i32 expression (const / unwritten local / global / +,-,* thereof). Unlike the
  // plain-map path (bare local-or-const only), stencils commonly bound by `w-1`.
  const boundPureInv = (n) =>
    isI32Const(n) ? true
    : isLocalGet(n) ? !writes.has(n[1])
    : (isArr(n) && n[0] === 'global.get') ? true
    : (isArr(n) && (n[0] === 'i32.add' || n[0] === 'i32.sub' || n[0] === 'i32.mul') && n.length === 3)
      ? boundPureInv(n[1]) && boundPureInv(n[2])
    : false
  if (!boundPureInv(bound)) return null

  // Element-index coefficient in the IV: 0 (loop-invariant), 1 (stride-1 affine —
  // IV, a derived IV, or either ± invariant), or null (anything else).
  const derived = new Set()
  let needsPeel = false
  const rightBs = []
  const unTee = (b) => (isArr(b) && b[0] === 'local.tee' && b.length === 3) ? b[2] : b   // CSE folds x±1 into a tee
  // `x±1`: native i32 (`i32.op(x,1)`), OR — when the ternary's OTHER branch is an unprovable-i32
  // invariant (`w-1` from a runtime-set global) forcing the WHOLE select to unify at f64 — the SAME
  // step in f64 domain, `f64.op(f64.convert_i32_s(x), 1.0)`. Same semantics, different wasm type.
  const isStep = (b, op) => {
    b = unTee(b)
    if (isArr(b) && b[0] === op && b.length === 3 && isLocalGet(b[1], incVar) && isI32Const(b[2]) && constNum(b[2]) === 1) return true
    // f64-UNIFIED native-i32 step: a sound `x±1` range proof (addLiteralFitsI32/
    // subLiteralFitsI32, emit.js) now recovers native `i32.op(x,1)` for THIS
    // branch even when the select's OTHER branch stays an unprovable f64
    // invariant (`h-1` from a runtime-set global) — the select still needs
    // both arms in the SAME wasm type, so THIS arm gets wrapped in one outer
    // f64.convert_i32_s to unify. Same value as the two shapes below (bare
    // i32.op, and the older fully-f64 f64.op(convert(x),1) fallback), a
    // third wasm SHAPE for it — peel the convert and re-check underneath.
    if (isArr(b) && b[0] === 'f64.convert_i32_s' && b.length === 2 && isStep(b[1], op)) return true
    const f64op = op === 'i32.sub' ? 'f64.sub' : 'f64.add'
    if (!isArr(b) || b[0] !== f64op || b.length !== 3) return false
    const l = unTee(b[1])
    return isArr(l) && l[0] === 'f64.convert_i32_s' && l.length === 2 && isLocalGet(l[1], incVar) && isArr(b[2]) && b[2][0] === 'f64.const' && Number(b[2][1]) === 1
  }
  const isZeroGuard = (g) => isArr(g) && ((g[0] === 'i32.eqz' && isLocalGet(g[1], incVar)) || (g[0] === 'i32.eq' && isLocalGet(g[1], incVar) && isI32Const(g[2]) && constNum(g[2]) === 0))
  // RIGHT-dir guard `x op B`: native i32 (`i32.op(x,B)`), or — the SAME f64-unification isStep's f64
  // variant comes from — `f64.op(f64.convert_i32_s(x), B)` with B then f64-typed too (e.g. a cached
  // `w-1`). Returns { B, f64 } | null.
  const ivCompare = (g, iop, fop) => {
    if (!isArr(g) || g.length !== 3) return null
    if (g[0] === iop && isLocalGet(g[1], incVar)) return { B: g[2], f64: false }
    if (g[0] === fop && isArr(g[1]) && g[1][0] === 'f64.convert_i32_s' && g[1].length === 2 && isLocalGet(g[1][1], incVar)) return { B: g[2], f64: true }
    return null
  }
  // An f64-domain B (a cached `w-1` local) converts to the identical i32 value via the exact
  // trunc_sat+wrap idiom jz's own overflow-canon already uses to extract these selects' OWN result —
  // value-exact for any finite integer-valued f64 (what `w-1` always is here), no approximation.
  const toI32B = ({ B, f64 }) => f64 ? ['i32.wrap_i64', ['i64.trunc_sat_f64_s', B]] : B
  // Toroidal wrap-select: `xw = x>0?x-1:w-1` / `xe = x<w-1?x+1:0`. Fires its wrap value only at a
  // boundary column the peel covers — LEFT (interior x-1) at x=0, RIGHT (interior x+1) at x=B.
  // Returns null | {dir:'L'} | {dir:'R',B}. Sound for ANY B: simdBound caps at min(bound,…B)-(lanes-1)
  // so no chunk reaches x=B (no need to prove B==bound-1, which may be hoisted out of reach).
  const isWrapSelect = (e) => {
    if (!isArr(e) || e[0] !== 'select' || e.length !== 4) return null
    const g = e[3]
    if (isStep(e[1], 'i32.sub') && ivCoeff(e[2]) === 0 && isArr(g) && g[0] === 'i32.gt_s' && isLocalGet(g[1], incVar) && isI32Const(g[2]) && constNum(g[2]) === 0) return { dir: 'L' }
    if (isStep(e[2], 'i32.sub') && ivCoeff(e[1]) === 0 && isZeroGuard(g)) return { dir: 'L' }
    if (isStep(e[1], 'i32.add') && ivCoeff(e[2]) === 0) { const c = ivCompare(g, 'i32.lt_s', 'f64.lt'); if (c) return { dir: 'R', B: toI32B(c) } }
    if (isStep(e[2], 'i32.add') && ivCoeff(e[1]) === 0) { const c = ivCompare(g, 'i32.eq', 'f64.eq'); if (c) return { dir: 'R', B: toI32B(c) } }
    return null
  }
  const ivCoeff = (n) => {
    if (isLocalGet(n)) {
      const nm = n[1]
      if (nm === incVar || derived.has(nm)) return 1
      return writes.has(nm) ? null : 0          // unwritten ⇒ loop-invariant
    }
    if (isI32Const(n)) return 0
    // A bare f64 constant (e.g. the `0` literal branch of an f64-unified wrap-select, coerced to f64
    // by the ternary's OTHER branch needing it) is loop-invariant regardless of its value — same
    // unconditional-any-value reasoning as the isI32Const branch just above.
    if (isArr(n) && n[0] === 'f64.const') return 0
    if (isArr(n) && n[0] === 'global.get') return 0
    if (isArr(n) && (n[0] === 'i32.add' || n[0] === 'i32.sub') && n.length === 3) {
      const a = ivCoeff(n[1]), b = ivCoeff(n[2])
      if (a == null || b == null) return null
      const c = n[0] === 'i32.add' ? a + b : a - b
      return c === 0 || c === 1 ? c : null
    }
    // `y*w` (inline row base, e.g. idx = y*w + x): invariant×invariant ⇒ coeff 0.
    // Any IV-dependent factor would be non-unit-stride (stride-w) ⇒ reject.
    if (isArr(n) && (n[0] === 'i32.mul' || n[0] === 'f64.mul') && n.length === 3)
      return ivCoeff(n[1]) === 0 && ivCoeff(n[2]) === 0 ? 0 : null
    // Float-derived index (grid loops compute the row base `y*w` in f64): the index arrives as
    // `idx = select(wrap(trunc_sat(INV + convert(x))), 0, ≠Inf)`. For an integer counter x,
    // trunc(C + x) = trunc(C) + x ⇒ stride-1 (the i32 lane offset is added before the trunc); the
    // Infinity-canon select takes the trunc branch for finite coords (grid indices are finite).
    // f64.add/sub mirror i32.add/sub; convert/wrap/trunc_sat/tee are coeff-transparent.
    if (isArr(n) && (n[0] === 'f64.add' || n[0] === 'f64.sub') && n.length === 3) {
      const a = ivCoeff(n[1]), b = ivCoeff(n[2])
      if (a == null || b == null) return null
      const c = n[0] === 'f64.add' ? a + b : a - b
      return c === 0 || c === 1 ? c : null
    }
    if (isArr(n) && (n[0] === 'f64.convert_i32_s' || n[0] === 'i32.wrap_i64' || n[0] === 'i64.trunc_sat_f64_s') && n.length === 2)
      return ivCoeff(n[1])
    if (isArr(n) && n[0] === 'local.tee' && n.length === 3) return ivCoeff(n[2])
    if (isArr(n) && n[0] === 'select') {
      // Toroidal wrap-select (inline in an address or named): stride-1 interior; flag the peel.
      const w = isWrapSelect(n)
      if (w) { needsPeel = true; if (w.dir === 'R' && !rightBs.some(b => exprEq(b, w.B))) rightBs.push(w.B); return 1 }
      // jz overflow-canon `select(wrap(trunc_sat(…)), 0, ≠Inf)`: finite (grids) ⇒ the trunc branch.
      if (n.length === 4 && isI32Const(n[2]) && isArr(n[3]) && n[3][0] === 'f64.ne' && isArr(n[3][2]) && n[3][2][0] === 'f64.const' && /inf/i.test(String(n[3][2][1])))
        return ivCoeff(n[1])
    }
    return null
  }
  const countSets = (name) => {
    let k = 0
    for (const s of body) walkAst(s, { enter: x => { if ((x[0] === 'local.set' || x[0] === 'local.tee') && x[1] === name) k++ } })
    return k
  }
  // Derived IVs: `c = INV + x` (coeff 1) or a toroidal wrap-select; set exactly once, first access a
  // write. RECURSES into nested tees — O3 CSEs `rc+x` into `(local.tee $pe (i32.add rc x))` inside a
  // load address, reused by the store. (ivCoeff returns 1 for a wrap-select and flags needsPeel.)
  for (let pass = 0; pass < 4; pass++) {
    let added = false
    const consider = (name, def) => {
      if (derived.has(name) || fnLocals.get(name) !== 'i32' || countSets(name) !== 1 || ivCoeff(def) !== 1) return
      let fk = null; for (const t of body) { const k = firstAccess(t, name); if (k) { fk = k; break } }
      if (fk === 'write') { derived.add(name); added = true }
    }
    forEachLocalDef(body, consider)
    if (!added) break
  }

  // Scan loads/stores: address `base + (IDX<<K)`, ivCoeff(IDX)=1, base invariant.
  let laneType = null, stride = -1
  const offTees = new Map()    // $pe → IDX expr  (from $pe = IDX<<K)
  const addrTees = new Map()   // $ab → { base, idx }
  const sites = []             // { kind, base, idx, memBytes }
  const isInvBase = (b) => (isArr(b) && b[0] === 'global.get') || (isLocalGet(b) && !writes.has(b[1]))
  const matchAddr = (addr, expectStride = stride) => {
    let teeName = null, n = addr
    if (isArr(n) && n[0] === 'local.tee' && n.length === 3) { teeName = n[1]; n = n[2] }
    if (isLocalGet(n) && addrTees.has(n[1])) { const e = addrTees.get(n[1]); if (teeName) addrTees.set(teeName, e); return e }
    if (!isArr(n) || n[0] !== 'i32.add' || n.length !== 3) return null
    const tryOff = (off) => {
      let ot = null, o = off
      if (isArr(o) && o[0] === 'local.tee' && o.length === 3) { ot = o[1]; o = o[2] }
      if (isLocalGet(o) && offTees.has(o[1])) return { idx: offTees.get(o[1]) }
      if (isArr(o) && o[0] === 'i32.shl' && o.length === 3 && isI32Const(o[2]) && (1 << o[2][1]) === expectStride && ivCoeff(o[1]) === 1) {
        if (ot) offTees.set(ot, o[1])
        return { idx: o[1] }
      }
      return null
    }
    for (const [bi, oi] of [[1, 2], [2, 1]]) {
      if (!isInvBase(n[bi])) continue
      const om = tryOff(n[oi])
      if (om) { const e = { base: n[bi], idx: om.idx }; if (teeName) addrTees.set(teeName, e); return e }
    }
    return null
  }
  const scan = (node, parent, pi) => {
    if (!isArr(node)) return true
    const op = node[0]
    if (LOAD_OPS[op]) {
      let addr = node[1], memBytes = 0
      if (typeof addr === 'string' && addr.startsWith('offset=')) { memBytes = +addr.slice(7); addr = node[2] }
      const lt = LOAD_OPS[op]
      if (laneType == null) { if (lt !== 'f64' && lt !== 'f32') return false; laneType = lt; stride = LANE_INFO[lt].stride }
      else if (lt !== laneType && !(lt === 'f32' && laneType === 'f64')) return false   // f32→f64 widening OK
      // Validate the address at the LOAD's own element stride (f64=8, widening f32=4); the index
      // must still be stride-1 in elements (ivCoeff===1). The f32 load is promoted in liftExprV.
      const m = matchAddr(addr, LANE_INFO[lt].stride)
      if (!m) return false
      sites.push({ kind: 'load', base: m.base, idx: m.idx, memBytes })
      return true
    }
    if (STORE_OPS[op]) {
      if (node.length !== 3) return false
      const st = STORE_OPS[op]
      if (laneType == null) { if (st !== 'f64' && st !== 'f32') return false; laneType = st; stride = LANE_INFO[st].stride }
      else if (st !== laneType) return false
      const m = matchAddr(node[1])
      if (!m) return false
      sites.push({ kind: 'store', base: m.base, idx: m.idx, memBytes: 0 })
      return scan(node[2], node, 2)                        // value child only
    }
    if ((op === 'local.set' || op === 'local.tee') && typeof node[1] === 'string' && node.length === 3) {
      const v = node[2]
      if (isArr(v) && v[0] === 'i32.shl' && v.length === 3 && isI32Const(v[2]) && stride > 0 && (1 << v[2][1]) === stride && ivCoeff(v[1]) === 1) offTees.set(node[1], v[1])
      else matchAddr(['local.tee', node[1], v])
    }
    for (let i = 1; i < node.length; i++) if (!scan(node[i], node, i)) return false
    return true
  }
  for (const s of body) if (!scan(s, null, -1)) return null
  if (!laneType || !sites.some(s => s.kind === "store") || !sites.some(s => s.kind === "load")) return null

  // In-place / loop-carried gate: every access to a WRITTEN base must touch the
  // SAME element (idx + memarg). Else SIMD reads stale data vs scalar.
  const elemKey = (s) => `${JSON.stringify(normTee(s.idx))}@${s.memBytes / stride}`
  for (const st of sites) {
    if (st.kind !== 'store') continue
    for (const s of sites) if (exprEq(normTee(s.base), normTee(st.base)) && elemKey(s) !== elemKey(st)) return null
  }
  // A pure offset-0 map (every access the same element, no memarg) is tryVectorize's
  // job — it ran first. Nothing stencil-specific here. (Defensive; ?? order ensures it.)
  const k0 = elemKey(sites[0])
  if (sites.every(s => elemKey(s) === k0)) return null

  // Classify locals by TYPE: i32 → addr (index/address, kept scalar), laneType
  // written → lane (first access must be a write), laneType unwritten → invariant.
  const referenced = blReferenced
  const localKind = new Map()
  for (const name of referenced) {
    if (name === incVar) continue
    const ty = fnLocals.get(name)
    if (ty === 'i32') { localKind.set(name, 'addr'); continue }
    // A stencil temp computed in f64 then stored to an f32 array carries `ty === 'f64'`
    // in an f32 lane (jz computes Float32Array math in f64). Treat it as lane/invariant
    // data the same as a native-typed local — the lift lanes it as f32x4 (relaxedSimd).
    if (ty === laneType || (laneType === 'f32' && ty === 'f64')) {
      if (writes.has(name)) {
        let fk = null; for (const s of body) { const k = firstAccess(s, name); if (k) { fk = k; break } }
        if (fk === 'read') return null                    // loop-carried float local
        localKind.set(name, 'lane')
      } else localKind.set(name, 'invariant')
      continue
    }
    if (!writes.has(name)) { localKind.set(name, 'invariant'); continue }
    return null                                            // written non-i32 non-lane local
  }

  // Lift through the shared lifter (addresses kept verbatim; loads → v128.load).
  const newLanedLocals = new Map(), extraLocals = []
  const ctx = { laneType, incVar, rampVar: null, rampTemp: null, widenLoads: false, localKind, fnLocals, newLanedLocals, extraLocals, freshIdRef, fail: false, failReason: null }
  const lifted = []
  for (const s of body) {
    const r = liftStmt(s, ctx)
    if (ctx.fail) return null
    if (r != null) { if (Array.isArray(r) && r[0] === '__seq__') lifted.push(...r.slice(1)); else lifted.push(r) }
  }
  if (!lifted.length) return null

  const id = freshIdRef.next++
  const simdBoundName = `$__simd_bound${id}`, simdBrkLabel = `$__simd_brk${id}`, simdLoopLabel = `$__simd_loop${id}`
  const info = LANE_INFO[laneType], lanes = info.lanes
  const boundExpr = cloneNode(bound)   // cloned: also lives in the scalar-tail exit guard
  // Overshoot-safe bound: a full lanes-wide chunk [x,x+lanes) must stay < bound for
  // ANY start x (stencils start at 1). `bound-(lanes-1)` — NOT `& ~(lanes-1)`, which
  // overshoots for a non-multiple start. SIMD reads ⊆ scalar reads ⇒ no new OOB.
  // A toroidal-wrap stencil additionally PEELS both boundary columns scalar: cap the SIMD at
  // `min(bound, …rightWrapBoundaries) - (lanes-1)` so no chunk reaches a right-wrap column x=B,
  // and run x=0 scalar below (where the left wrap fires) so the SIMD starts in the wrap-free interior.
  const simdCap = rightBs.reduce((acc, b) => ['select', cloneNode(b), acc, ['i32.lt_s', cloneNode(b), acc]], boundExpr)
  const boundSetup = ['local.set', simdBoundName, ['i32.sub', simdCap, ['i32.const', lanes - 1]]]
  const simdBlock = ['block', simdBrkLabel,
    ['loop', simdLoopLabel,
      ['br_if', simdBrkLabel, ['i32.eqz', ['i32.lt_s', ['local.get', incVar], ['local.get', simdBoundName]]]],
      ...lifted,
      ['local.set', incVar, ['i32.add', ['local.get', incVar], ['i32.const', lanes]]],
      ['br', simdLoopLabel]]]
  // Left-boundary peel for a wrap stencil: run the original scalar body once for x=0 (where the wrap
  // takes its WRAP branch), advancing x to 1 so the SIMD starts in the wrap-free interior. Guarded so
  // an empty loop (x ≥ bound) is untouched. Right boundary + odd tail: the kept scalar tail (blockNode).
  const peelStmts = needsPeel
    ? [['if', ['i32.lt_s', ['local.get', incVar], cloneNode(bound)],
        ['then', ...body.map(cloneNode), cloneNode(bl.loopNode[bl.incIdx])]]]
    : []
  // LICM-hoisted $__li invariants run ahead of the SIMD block (the scalar tail's
  // copy inside bl.blockNode re-runs them harmlessly — pure & loop-invariant).
  const wrapper = ['block', ...preamble.map(cloneNode), ...peelStmts, boundSetup, simdBlock, bl.blockNode]
  const newLocalDecls = [['local', simdBoundName, 'i32'], ...[...newLanedLocals.values()].map(laneName => ['local', laneName, 'v128']), ...extraLocals]
  return { wrapper, newLocalDecls }
}

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
// REDUCTION unification (.work/vectorizer-generality-design.md §2 "REDUCTION (#5-6) → 1
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

export function tryGeneralStencil(node, fnLocals, freshIdRef, enabled, bl, opts = {}) {
  if (!enabled) return null
  if (!bl) return null
  const { aliasVersion = true } = opts
  const { incVar, bound, body, preamble, hasGlobalSet: blHasGlobalSet, writes, referenced: blReferenced } = bl
  if (blHasGlobalSet) return null

  // Leaf-stencil guard (verbatim from tryStencil): no nested loop / non-$math call.
  const hasNestedLoopOrCall = (n) => {
    let found = false
    walkAst(n, { enter: x => {
      if (found) return false
      if (x[0] === 'loop' || (x[0] === 'call' && (typeof x[1] !== 'string' || !x[1].startsWith('$math.'))) || x[0] === 'call_indirect') { found = true; return false }
    } })
    return found
  }
  if (body.some(hasNestedLoopOrCall)) return null

  // Bound must be a pure loop-invariant i32 expression (verbatim from tryStencil — broader than
  // tryGeneralMap's bare boundLocal-or-const rule: stencils commonly bound by `w-1`).
  const boundPureInv = (n) =>
    isI32Const(n) ? true
    : isLocalGet(n) ? !writes.has(n[1])
    : (isArr(n) && n[0] === 'global.get') ? true
    : (isArr(n) && (n[0] === 'i32.add' || n[0] === 'i32.sub' || n[0] === 'i32.mul') && n.length === 3)
      ? boundPureInv(n[1]) && boundPureInv(n[2])
    : false
  if (!boundPureInv(bound)) return null

  // ---- Affine-in-IV coefficient solver — verbatim port of tryStencil's own (including the
  // toroidal wrap-select and float-domain-index branches; see header doc's fold-in note). ----
  const derived = new Set()
  let needsPeel = false
  const rightBs = []
  const unTee = (b) => (isArr(b) && b[0] === 'local.tee' && b.length === 3) ? b[2] : b
  const isStep = (b, op) => {
    b = unTee(b)
    if (isArr(b) && b[0] === op && b.length === 3 && isLocalGet(b[1], incVar) && isI32Const(b[2]) && constNum(b[2]) === 1) return true
    if (isArr(b) && b[0] === 'f64.convert_i32_s' && b.length === 2 && isStep(b[1], op)) return true
    const f64op = op === 'i32.sub' ? 'f64.sub' : 'f64.add'
    if (!isArr(b) || b[0] !== f64op || b.length !== 3) return false
    const l = unTee(b[1])
    return isArr(l) && l[0] === 'f64.convert_i32_s' && l.length === 2 && isLocalGet(l[1], incVar) && isArr(b[2]) && b[2][0] === 'f64.const' && Number(b[2][1]) === 1
  }
  const isZeroGuard = (g) => isArr(g) && ((g[0] === 'i32.eqz' && isLocalGet(g[1], incVar)) || (g[0] === 'i32.eq' && isLocalGet(g[1], incVar) && isI32Const(g[2]) && constNum(g[2]) === 0))
  const ivCompare = (g, iop, fop) => {
    if (!isArr(g) || g.length !== 3) return null
    if (g[0] === iop && isLocalGet(g[1], incVar)) return { B: g[2], f64: false }
    if (g[0] === fop && isArr(g[1]) && g[1][0] === 'f64.convert_i32_s' && g[1].length === 2 && isLocalGet(g[1][1], incVar)) return { B: g[2], f64: true }
    return null
  }
  const toI32B = ({ B, f64 }) => f64 ? ['i32.wrap_i64', ['i64.trunc_sat_f64_s', B]] : B
  const isWrapSelect = (e) => {
    if (!isArr(e) || e[0] !== 'select' || e.length !== 4) return null
    const g = e[3]
    if (isStep(e[1], 'i32.sub') && ivCoeff(e[2]) === 0 && isArr(g) && g[0] === 'i32.gt_s' && isLocalGet(g[1], incVar) && isI32Const(g[2]) && constNum(g[2]) === 0) return { dir: 'L' }
    if (isStep(e[2], 'i32.sub') && ivCoeff(e[1]) === 0 && isZeroGuard(g)) return { dir: 'L' }
    if (isStep(e[1], 'i32.add') && ivCoeff(e[2]) === 0) { const c = ivCompare(g, 'i32.lt_s', 'f64.lt'); if (c) return { dir: 'R', B: toI32B(c) } }
    if (isStep(e[2], 'i32.add') && ivCoeff(e[1]) === 0) { const c = ivCompare(g, 'i32.eq', 'f64.eq'); if (c) return { dir: 'R', B: toI32B(c) } }
    return null
  }
  const ivCoeff = (n) => {
    if (isLocalGet(n)) {
      const nm = n[1]
      if (nm === incVar || derived.has(nm)) return 1
      return writes.has(nm) ? null : 0
    }
    if (isI32Const(n)) return 0
    if (isArr(n) && n[0] === 'f64.const') return 0
    if (isArr(n) && n[0] === 'global.get') return 0
    if (isArr(n) && (n[0] === 'i32.add' || n[0] === 'i32.sub') && n.length === 3) {
      const a = ivCoeff(n[1]), b = ivCoeff(n[2])
      if (a == null || b == null) return null
      const c = n[0] === 'i32.add' ? a + b : a - b
      return c === 0 || c === 1 ? c : null
    }
    if (isArr(n) && (n[0] === 'i32.mul' || n[0] === 'f64.mul') && n.length === 3)
      return ivCoeff(n[1]) === 0 && ivCoeff(n[2]) === 0 ? 0 : null
    if (isArr(n) && (n[0] === 'f64.add' || n[0] === 'f64.sub') && n.length === 3) {
      const a = ivCoeff(n[1]), b = ivCoeff(n[2])
      if (a == null || b == null) return null
      const c = n[0] === 'f64.add' ? a + b : a - b
      return c === 0 || c === 1 ? c : null
    }
    if (isArr(n) && (n[0] === 'f64.convert_i32_s' || n[0] === 'i32.wrap_i64' || n[0] === 'i64.trunc_sat_f64_s') && n.length === 2)
      return ivCoeff(n[1])
    if (isArr(n) && n[0] === 'local.tee' && n.length === 3) return ivCoeff(n[2])
    if (isArr(n) && n[0] === 'select') {
      const w = isWrapSelect(n)
      if (w) { needsPeel = true; if (w.dir === 'R' && !rightBs.some(b => exprEq(b, w.B))) rightBs.push(w.B); return 1 }
      if (n.length === 4 && isI32Const(n[2]) && isArr(n[3]) && n[3][0] === 'f64.ne' && isArr(n[3][2]) && n[3][2][0] === 'f64.const' && /inf/i.test(String(n[3][2][1])))
        return ivCoeff(n[1])
    }
    return null
  }
  const countSets = (name) => {
    let k = 0
    for (const s of body) walkAst(s, { enter: x => { if ((x[0] === 'local.set' || x[0] === 'local.tee') && x[1] === name) k++ } })
    return k
  }
  for (let pass = 0; pass < 4; pass++) {
    let added = false
    const consider = (name, def) => {
      if (derived.has(name) || fnLocals.get(name) !== 'i32' || countSets(name) !== 1 || ivCoeff(def) !== 1) return
      let fk = null; for (const t of body) { const k = firstAccess(t, name); if (k) { fk = k; break } }
      if (fk === 'write') { derived.add(name); added = true }
    }
    forEachLocalDef(body, consider)
    if (!added) break
  }

  // ---- Address match: base + (IDX<<K) | bare-affine byte-lane fallback (the fallback is NEW
  // relative to tryStencil — tryGeneralMap's own addition, needed here for the first time
  // because tryStencil never reached i8 lanes at all). Any LOAD_OPS/STORE_OPS lane type. ----
  let laneType = null, stride = -1
  const offTees = new Map(), addrTees = new Map()
  const sites = []
  const isInvBase = (b) => (isArr(b) && b[0] === 'global.get') || (isLocalGet(b) && !writes.has(b[1]))
  const matchOffset = (off, expectStride) => {
    let ot = null, o = off
    if (isArr(o) && o[0] === 'local.tee' && o.length === 3) { ot = o[1]; o = o[2] }
    if (isLocalGet(o) && offTees.has(o[1])) return { idx: offTees.get(o[1]) }
    if (isArr(o) && o[0] === 'i32.shl' && o.length === 3 && isI32Const(o[2]) && (1 << o[2][1]) === expectStride && ivCoeff(o[1]) === 1) {
      if (ot) offTees.set(ot, o[1])
      return { idx: o[1] }
    }
    if (expectStride === 1 && ivCoeff(o) === 1) { if (ot) offTees.set(ot, o); return { idx: o } }
    return null
  }
  const matchAddr = (addr, expectStride = stride) => {
    let teeName = null, n = addr
    if (isArr(n) && n[0] === 'local.tee' && n.length === 3) { teeName = n[1]; n = n[2] }
    if (isLocalGet(n) && addrTees.has(n[1])) { const e = addrTees.get(n[1]); if (teeName) addrTees.set(teeName, e); return e }
    if (!isArr(n) || n[0] !== 'i32.add' || n.length !== 3) return null
    for (const [bi, oi] of [[1, 2], [2, 1]]) {
      if (!isInvBase(n[bi])) continue
      const om = matchOffset(n[oi], expectStride)
      if (om) { const e = { base: n[bi], idx: om.idx }; if (teeName) addrTees.set(teeName, e); return e }
    }
    return null
  }
  const scan = (n, parent, pi) => {
    if (!isArr(n)) return true
    const op = n[0]
    if (LOAD_OPS[op]) {
      let addr = n[1], memBytes = 0
      if (typeof addr === 'string' && addr.startsWith('offset=')) { memBytes = +addr.slice(7); addr = n[2] }
      const lt = LOAD_OPS[op]
      if (laneType == null) { laneType = lt; stride = LANE_INFO[lt].stride }
      else if (lt !== laneType) return false
      const m = matchAddr(addr, LANE_INFO[lt].stride)
      if (!m) return false
      sites.push({ kind: 'load', base: m.base, idx: m.idx, memBytes })
      return true
    }
    if (STORE_OPS[op]) {
      if (n.length !== 3) return false
      const st = STORE_OPS[op]
      if (laneType == null) { laneType = st; stride = LANE_INFO[st].stride }
      else if (st !== laneType) return false
      const m = matchAddr(n[1])
      if (!m) return false
      sites.push({ kind: 'store', base: m.base, idx: m.idx, memBytes: 0 })
      return scan(n[2], n, 2)
    }
    if ((op === 'local.set' || op === 'local.tee') && typeof n[1] === 'string' && n.length === 3) {
      const v = n[2]
      if (isArr(v) && v[0] === 'i32.shl' && v.length === 3 && isI32Const(v[2]) && stride > 0 && (1 << v[2][1]) === stride && ivCoeff(v[1]) === 1) offTees.set(n[1], v[1])
      else matchAddr(['local.tee', n[1], v])
    }
    for (let i = 1; i < n.length; i++) if (!scan(n[i], n, i)) return false
    return true
  }
  for (const s of body) if (!scan(s, null, -1)) return null
  if (!laneType || !sites.some(s => s.kind === 'store') || !sites.some(s => s.kind === 'load')) return null

  // ---- In-place / loop-carried gate: three-way resolution — the SAME shape as
  // tryGeneralMap's own (layer 3), with ONE adaptation this pass needs and tryGeneralMap
  // doesn't: tryGeneralMap's `foldAtIv0` folds each side INDEPENDENTLY to a raw number,
  // requiring every non-IV term to already be a compile-time literal — sound there because
  // tryGeneralMap has no derived-IV concept, every address is IV-or-literal. This pass's
  // addresses routinely route through a DERIVED local (`c = rc + x`, single-assignment,
  // `ivCoeff===1`) whose own row-base term (`rc`) is a genuine RUNTIME value, not a literal —
  // folding each side independently then fails even on a textbook adjacent-column hazard
  // (`a[c] = a[c-1] ^ a[c]`): a compile-time-PROVABLY-unsafe delta (|D|=1) would be mis-classified
  // as "runtime-unknown" and VERSIONED instead of declined — correct at runtime (the guard is
  // always false, so results stay bit-exact) but dead SIMD code emitted for nothing, exactly the
  // kind of regression layer 3's own "compile-time-foldable, unsafe" branch exists to catch.
  // Fix: fold the DELTA symbolically instead of each side alone — peel ONE literal additive/subtractive term off
  // the top of each side and compare what remains via `exprEq` (the same side-effect-free
  // structural-equality primitive `elemKey`'s own base comparison already relies on); when
  // the remainders match structurally, the two sides differ by EXACTLY the peeled literals
  // regardless of what the (possibly-symbolic, e.g. `rc`) remainder equals at runtime — sound
  // because `exprEq` only accepts genuine structural identity, never a heuristic guess.
  // Returns null (unresolvable, falls through to the runtime-unknown/version path — the same
  // conservative "return null when unsure" tryGeneralMap's own foldAtIv0 already uses) for
  // any pair whose remainders aren't provably identical, including a MIXED pair (one side
  // routed through a derived local, the other through something structurally different) —
  // never a false "safe", only ever a missed free-fold (falls to versioning/decline instead).
  const elemKey = (s) => `${JSON.stringify(normTee(s.idx))}@${s.memBytes / stride}`
  const lanesForGuard = LANE_INFO[laneType].lanes
  const peelConst = (n) => {
    n = normTee(n)
    if (isArr(n) && (n[0] === 'i32.add' || n[0] === 'i32.sub') && n.length === 3 && isI32Const(n[2]))
      return { rest: n[1], k: n[0] === 'i32.add' ? +n[2][1] : -(+n[2][1]) }
    return { rest: n, k: 0 }
  }
  const foldDeltaExpr = (a, b) => {
    const pa = peelConst(a), pb = peelConst(b)
    return exprEq(normTee(pa.rest), normTee(pb.rest)) ? pa.k - pb.k : null
  }
  let aliasGuards = null
  {
    const guards = [], seenPairs = new Set()
    let sawMismatch = false, unversionable = false, bodyTooBig = null
    for (let i = 0; i < sites.length; i++) {
      const st = sites[i]
      if (st.kind !== 'store') continue
      for (let j = 0; j < sites.length; j++) {
        if (i === j) continue
        const s = sites[j]
        if (!exprEq(normTee(s.base), normTee(st.base)) || elemKey(s) === elemKey(st)) continue
        const pk = i < j ? `${i}|${j}` : `${j}|${i}`
        if (seenPairs.has(pk)) continue
        seenPairs.add(pk)
        if ((st.memBytes - s.memBytes) % stride !== 0) { sawMismatch = true; unversionable = true; continue }
        const constDelta = (s.memBytes - st.memBytes) / stride
        const foldedDelta = foldDeltaExpr(s.idx, st.idx)
        if (foldedDelta != null) {
          if (Math.abs(foldedDelta + constDelta) >= lanesForGuard) continue
          sawMismatch = true; unversionable = true; continue
        }
        sawMismatch = true
        if (bodyTooBig == null) bodyTooBig = body.reduce((n, stmt) => n + gmNodeCount(stmt), 0) > ALIAS_VERSION_MAX_BODY_NODES
        if (!aliasVersion || bodyTooBig) { unversionable = true; continue }
        let delta = ['i32.sub', cloneNode(s.idx), cloneNode(st.idx)]
        if (constDelta !== 0) delta = ['i32.add', delta, ['i32.const', String(constDelta)]]
        guards.push(['i32.or',
          ['i32.le_s', delta, ['i32.const', String(-lanesForGuard)]],
          ['i32.ge_s', delta, ['i32.const', String(lanesForGuard)]]])
      }
    }
    if (sawMismatch) {
      if (unversionable) return null
      aliasGuards = guards
    }
  }

  // ---- Local classification (generalized: tryGeneralMap's address/lane disambiguation,
  // adapted to this pass's own broader matchAddr/ivCoeff — an i32-typed local is 'addr' when
  // its every write is proven index/address arithmetic under THIS pass's own affine grammar,
  // not merely tryGeneralMap's narrower one, so a row-base/wrap-select derived local
  // classifies correctly too). ----
  const _isAddrLocalGS = (name) => {
    let onlyAddr = true, found = false
    const inspect = n => {
      if (!isArr(n) || (n[0] !== 'local.tee' && n[0] !== 'local.set') || n[1] !== name || n.length !== 3) return
      found = true
      if (ivCoeff(n[2]) == null && !matchAddr(['local.tee', name, n[2]])) onlyAddr = false
      return false
    }
    for (const s of body) walkAst(s, { enter: inspect })
    return found && onlyAddr
  }
  const referenced = blReferenced
  const localKind = new Map()
  for (const name of referenced) {
    if (name === incVar) continue
    const ty = fnLocals.get(name)
    if (ty === 'i32' && (addrTees.has(name) || offTees.has(name) || derived.has(name) || _isAddrLocalGS(name))) { localKind.set(name, 'addr'); continue }
    if (writes.has(name)) {
      let fk = null; for (const s of body) { const k = firstAccess(s, name); if (k) { fk = k; break } }
      if (fk === 'read') return null
      localKind.set(name, 'lane')
    } else localKind.set(name, 'invariant')
  }

  // ---- Lift through the shared lifter (verbatim). ----
  const newLanedLocals = new Map(), extraLocals = []
  const ctx = { laneType, incVar, rampVar: null, rampTemp: null, widenLoads: false, localKind, fnLocals, newLanedLocals, extraLocals, freshIdRef, fail: false, failReason: null, aosPixelStride: 1, pureFuncMap: null, inlineDepth: 0, constLocals: null }
  const lifted = []
  for (const s of body) {
    const r = liftStmt(s, ctx)
    if (ctx.fail) return null
    if (r != null) { if (Array.isArray(r) && r[0] === '__seq__') lifted.push(...r.slice(1)); else lifted.push(r) }
  }
  if (!lifted.length) return null
  // Cost model (Part 2 — see the shared header doc before tryGeneralMap). Same
  // check, same reused arrays; `aliasGuards.length` is the guard-clause count when versioned.
  if (!isProfitable(body, lifted, LANE_INFO[laneType].lanes, aliasGuards ? aliasGuards.length : 0))
    return liftFail(ctx, 'not profitable: vector cost/lane ≥ scalar cost')

  // ---- Codegen: tryStencil's own proven neighbourhood-gather wrapper, verbatim, plus
  // layer-3's versioning wrap when aliasGuards is non-null (see header doc). ----
  const id = freshIdRef.next++
  const simdBoundName = `$__simd_bound${id}`, simdBrkLabel = `$__simd_brk${id}`, simdLoopLabel = `$__simd_loop${id}`
  const info = LANE_INFO[laneType], lanes = info.lanes
  const boundExpr = cloneNode(bound)
  const simdCap = rightBs.reduce((acc, b) => ['select', cloneNode(b), acc, ['i32.lt_s', cloneNode(b), acc]], boundExpr)
  const boundSetup = ['local.set', simdBoundName, ['i32.sub', simdCap, ['i32.const', lanes - 1]]]
  const simdBlock = ['block', simdBrkLabel,
    ['loop', simdLoopLabel,
      ['br_if', simdBrkLabel, ['i32.eqz', ['i32.lt_s', ['local.get', incVar], ['local.get', simdBoundName]]]],
      ...lifted,
      ['local.set', incVar, ['i32.add', ['local.get', incVar], ['i32.const', lanes]]],
      ['br', simdLoopLabel]]]
  const peelStmts = needsPeel
    ? [['if', ['i32.lt_s', ['local.get', incVar], cloneNode(bound)],
        ['then', ...body.map(cloneNode), cloneNode(bl.loopNode[bl.incIdx])]]]
    : []
  const simdPath = [...peelStmts, boundSetup, simdBlock, bl.blockNode]
  const guardedPath = aliasGuards
    ? [['if', aliasGuards.reduce((a, g) => a == null ? g : ['i32.and', a, g], null),
        ['then', ...simdPath],
        ['else', cloneNode(bl.blockNode)]]]
    : simdPath
  const wrapper = ['block', ...preamble.map(cloneNode), ...guardedPath]
  const newLocalDecls = [['local', simdBoundName, 'i32'], ...[...newLanedLocals.values()].map(laneName => ['local', laneName, 'v128']), ...extraLocals]
  return { wrapper, newLocalDecls }
}

// ---- General base-layer REDUCTION recognizer (dispatch-chain terminal) ----------------
//
// Generalizes `tryReduce`'s (`tryReduceReassoc`) shape-specific address proof — `matchLaneAddr`'s
// literal post-lowering WAT-pattern list — to an AST-level affine-in-IV proof, the SAME lever
// `tryGeneralMap` already applied to the MAP class (design §2/§3 step 3, REDUCTION slice —
// .work/vectorizer-generality-design.md). `ivCoeff`/`matchAddr` below are a PORT of
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
