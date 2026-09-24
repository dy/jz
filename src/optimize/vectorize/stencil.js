import { nodeEqual as exprEq, cloneNode, walkAst } from '../../ast.js'
import { constNum, laneAccess, isI32Const, isLocalGet, matchStrideAddr, hasNestedLoopOrCall, indexDefs } from './addr-model.js'
import { aliasGuards } from './alias.js'
import { isProfitable } from './cost-model.js'
import { normTee } from './idioms.js'
import { LANE_INFO, LOAD_OPS, STORE_OPS, floatLane } from './lane-tables.js'
import { liftCtx, liftFail, liftStmt } from './lift.js'
import { forEachLocalDef, isArr } from './node-utils.js'
import { simdLoop } from './scaffold.js'

// A stencil's bound is re-evaluated for the SIMD guard, so it must be a PURE loop-invariant
// i32 expression (const / unwritten local / global / +,-,* thereof).
const boundPureInv = (n, writes) =>
  isI32Const(n) ? true
  : isLocalGet(n) ? !writes.has(n[1])
  : (isArr(n) && n[0] === 'global.get') ? true
  : (isArr(n) && (n[0] === 'i32.add' || n[0] === 'i32.sub' || n[0] === 'i32.mul') && n.length === 3)
    ? boundPureInv(n[1], writes) && boundPureInv(n[2], writes)
  : false

// Element-index model of a stencil body, shared by tryStencil and tryGeneralStencil.
// `ivCoeff(n)`: the index's coefficient in the IV — 0 (loop-invariant), 1 (stride-1 affine:
// the IV, a derived IV, or either ± invariant), or null. `derived`: locals set once to a
// coefficient-1 index before any read. `peel`: toroidal wrap-selects seen (`needed`) and the
// right-boundary bounds (`rightBs`) the SIMD cap must stay under.
function stencilIndexModel(body, incVar, writes, fnLocals) {
  const derived = new Set(), peel = { needed: false, rightBs: [] }
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
      if (w) { peel.needed = true; if (w.dir === 'R' && !peel.rightBs.some(b => exprEq(b, w.B))) peel.rightBs.push(w.B); return 1 }
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
  // load address, reused by the store. (ivCoeff returns 1 for a wrap-select and flags the peel.)
  for (let pass = 0; pass < 4; pass++) {
    let added = false
    const consider = (name, def) => {
      if (derived.has(name) || fnLocals.get(name) !== 'i32' || countSets(name) !== 1 || ivCoeff(def) !== 1) return
      if (laneAccess(body, name) === 'write') { derived.add(name); added = true }
    }
    forEachLocalDef(body, consider)
    if (!added) break
  }

  return { ivCoeff, derived, peel }
}

// ---- Stencil recognizer (neighbour loads: a[i±δ], a[c±δ], a[rn+x]) --------
//
// Vectorizes a map whose loads read NEIGHBOURING elements — `b[i] = f(a[i-1],
// a[i], a[i+1])` and the 2-D form `b[c] = f(a[c-1], a[c+1], a[rn+x], …)` where
// `c = rc + x` is a derived induction var (rc loop-invariant, x the IV).
//
// The lift is bit-exact BY CONSTRUCTION: a scalar `f64.load` at `base+(idx<<K)`
// becomes `v128.load` at the SAME address; for f64x2 lanes (x, x+1) that covers
// `(elem[idx], elem[idx+1])` — exactly the bytes the two scalar iterations read.
// No new memory is touched (scalar tail handles the remainder) ⇒ no boundary
// special-casing, no new OOB. The neighbour `a[i+1]` arrives as
// `(f64.load offset=8 …)` → `v128.load offset=8` (the +1-shifted pair). Stride-1
// in the IV is required (consecutive lanes ⇒ consecutive elements): every index
// must be affine in the IV with coefficient exactly 1 (`ivCoeff`).
//
// Correctness gates:
//   • f64/f32 lanes only — float data locals vs i32 index/address locals are
//     type-distinct, so localKind is by type. An i32-used-as-data case bails in
//     the lifter (never miscompiles). Integer-lane stencils (types collide) decline.
//   • In-place bail: if the WRITTEN base is also accessed at a DIFFERENT element,
//     SIMD reads the old value where scalar reads the just-written one (loop-
//     carried) ⇒ null. Offset-0 read of the written array is safe.
//   • Distinct base subtrees ⇒ assumed non-aliasing — the SAME assumption the
//     plain map path already relies on. A ping-pong buffer swap (waves) is OUTSIDE
//     the loop, so in-loop bases stay distinct globals — safe without a runtime guard.
//   • Reassociation: summing neighbours reorders f64 adds across lanes (ulp, like
//     float reductions) — gated behind cfg.stencil until proven.
export function tryStencil(node, fnLocals, freshIdRef, enabled, bl) {
  if (!enabled) return null
  // Consumes the dispatch-computed inner scaffold (LoopPlan) — the opts there
  // ({ allowPreamble: true, allowInlinedLi: true }) are exactly what this pass
  // matched for itself (inlined LICM preambles carry grid row-bases like
  // schrodinger's `y*w`).
  if (!bl) return null
  const { incVar, bound, body, preamble, hasGlobalSet: blHasGlobalSet, writes, referenced: blReferenced } = bl   // preamble: LICM-hoisted $__li invariants
  if (blHasGlobalSet) return null

  // Leaf-stencil guard: a nested loop (the outer loop of a 2-D sweep) or a non-$math call.
  if (body.some(hasNestedLoopOrCall)) return null
  // The bound is re-evaluated for the SIMD guard: stencils commonly bound by `w-1`.
  if (!boundPureInv(bound, writes)) return null

  const { ivCoeff, peel } = stencilIndexModel(body, incVar, writes, fnLocals)

  // Scan loads/stores: address `base + (IDX<<K)`, ivCoeff(IDX)=1, base invariant.
  let laneType = floatLane(body), stride = laneType ? LANE_INFO[laneType].stride : -1
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
      else if (st !== laneType && !(st === 'f32' && laneType === 'f64')) return false
      const m = matchAddr(node[1], LANE_INFO[st].stride)
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
        const access = laneAccess(body, name, bl.outsideReads)
        if (access === 'read' || access === 'liveout') return null   // loop-carried, or carried out
        localKind.set(name, 'lane')
      } else localKind.set(name, 'invariant')
      continue
    }
    if (!writes.has(name)) { localKind.set(name, 'invariant'); continue }
    return null                                            // written non-i32 non-lane local
  }

  // Lift through the shared lifter (addresses kept verbatim; loads → v128.load).
  const newLanedLocals = new Map(), extraLocals = []
  const ctx = liftCtx(laneType, incVar, localKind, freshIdRef, fnLocals, newLanedLocals, extraLocals)
  const lifted = []
  for (const s of body) {
    const r = liftStmt(s, ctx)
    if (ctx.fail) return null
    if (r != null) { if (Array.isArray(r) && r[0] === '__seq__') lifted.push(...r.slice(1)); else lifted.push(r) }
  }
  if (!lifted.length) return null

  const id = freshIdRef.next++
  const simdBoundName = `$__simd_bound${id}`
  const info = LANE_INFO[laneType], lanes = info.lanes
  const boundExpr = cloneNode(bound)   // cloned: also lives in the scalar-tail exit guard
  // Overshoot-safe bound: a full lanes-wide chunk [x,x+lanes) must stay < bound for
  // ANY start x (stencils start at 1). `bound-(lanes-1)` — NOT `& ~(lanes-1)`, which
  // overshoots for a non-multiple start. SIMD reads ⊆ scalar reads ⇒ no new OOB.
  // A toroidal-wrap stencil additionally PEELS both boundary columns scalar: cap the SIMD at
  // `min(bound, …rightWrapBoundaries) - (lanes-1)` so no chunk reaches a right-wrap column x=B,
  // and run x=0 scalar below (where the left wrap fires) so the SIMD starts in the wrap-free interior.
  const simdCap = peel.rightBs.reduce((acc, b) => ['select', cloneNode(b), acc, ['i32.lt_s', cloneNode(b), acc]], boundExpr)
  const boundSetup = ['local.set', simdBoundName, ['i32.sub', simdCap, ['i32.const', lanes - 1]]]
  const simdBlock = simdLoop(id, incVar, simdBoundName, [...lifted,
    ['local.set', incVar, ['i32.add', ['local.get', incVar], ['i32.const', lanes]]]])
  // Left-boundary peel for a wrap stencil: run the original scalar body once for x=0 (where the wrap
  // takes its WRAP branch), advancing x to 1 so the SIMD starts in the wrap-free interior. Guarded so
  // an empty loop (x ≥ bound) is untouched. Right boundary + odd tail: the kept scalar tail (blockNode).
  const peelStmts = peel.needed
    ? [['if', ['i32.lt_s', ['local.get', incVar], cloneNode(bound)],
        ['then', ...body.map(cloneNode), cloneNode(bl.loopNode[bl.incIdx])]]]
    : []
  // LICM-hoisted $__li invariants run ahead of the SIMD block (the scalar tail's
  // copy inside bl.blockNode re-runs them harmlessly — pure & loop-invariant).
  const wrapper = ['block', ...preamble.map(cloneNode), ...peelStmts, boundSetup, simdBlock, bl.blockNode]
  const newLocalDecls = [['local', simdBoundName, 'i32'], ...[...newLanedLocals.values()].map(laneName => ['local', laneName, 'v128']), ...extraLocals]
  return { wrapper, newLocalDecls }
}

// ---- General stencil: tryStencil's index model over every lane type + alias versioning ----
//
// Runs after tryGeneralMap, so it sees only loops that map's narrower i32-affine proof
// declined: a toroidal wrap-select boundary (`x>0?x-1:w-1`) or a float-domain grid index
// (`y*w+x` computed in f64). Every loop tryGeneralMap accepts this pass would accept too;
// running it later adds reach without re-deciding map's cases.
//
// Differences from tryStencil:
//   • Any LOAD_OPS/STORE_OPS lane type, not only f64/f32. An i32 local is either an
//     address/index scalar or i8/i16/i32 lane data; `_isAddrLocalGS` resolves that the way
//     tryGeneralMap's `_isAddrLocalGM` does, over this pass's broader `matchAddr`/`ivCoeff`.
//     Address arithmetic and lane data are orthogonal, so the float-domain index proof and
//     the wrap-select peel carry over to integer grids unchanged.
//   • In-place accesses use tryGeneralMap's three-way resolution instead of declining: a
//     compile-time element delta >= lanes is accepted, < lanes declines (a windowed in-place
//     recurrence), and a runtime delta versions the loop behind a hoisted `i32.or`
//     disjointness guard with the original scalar loop as the `else`. Distinct bases are
//     assumed non-aliasing, as in every map/stencil recognizer.
//
// Out of scope: non-unit runtime strides (`a[i*step]`) need gather codegen, not a proof
// extension. Codegen is tryStencil's: the absolute cap `simdCap − (lanes−1)` (stencils can
// enter at a non-zero IV and read behind it) plus the toroidal left-column peel, wrapped in
// the versioning `if` when alias guards exist.
export function tryGeneralStencil(node, fnLocals, freshIdRef, enabled, bl, opts = {}) {
  if (!enabled) return null
  if (!bl) return null
  const { aliasVersion = true } = opts
  const { incVar, bound, body, preamble, hasGlobalSet: blHasGlobalSet, writes, referenced: blReferenced } = bl
  if (blHasGlobalSet) return null

  if (body.some(hasNestedLoopOrCall)) return null
  if (!boundPureInv(bound, writes)) return null

  const { ivCoeff, derived, peel } = stencilIndexModel(body, incVar, writes, fnLocals)

  // ---- Address match: base + (IDX<<K) | bare-affine byte-lane fallback (the fallback is NEW
  // relative to tryStencil — tryGeneralMap's own addition, needed here for the first time
  // because tryStencil never reached i8 lanes at all). Any LOAD_OPS/STORE_OPS lane type. ----
  let laneType = null, stride = -1
  const offTees = new Map(), addrTees = new Map()
  const sites = []
  const matchAddr = (addr, expectStride = stride) => matchStrideAddr(addr, expectStride, writes, offTees, addrTees, ivCoeff)
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

  // ---- In-place / loop-carried gate (alias.js), as tryGeneralMap's: a constant element
  // distance decides now, an invariant one versions the loop behind hoisted checks. Index
  // temporaries (`c = rc + x`) stand for their definitions, so a site through one and a site
  // spelled inline compare by value. ----
  const guards = aliasGuards(sites, stride, LANE_INFO[laneType].lanes,
    { defs: indexDefs(body, fnLocals, bl.outsideReads), varying: new Set(writes).add(incVar), version: aliasVersion })
  if (!guards) return null

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
      const access = laneAccess(body, name, bl.outsideReads)
      if (access === 'read' || access === 'liveout') return null   // loop-carried, or carried out
      localKind.set(name, 'lane')
    } else localKind.set(name, 'invariant')
  }

  // ---- Lift through the shared lifter (verbatim). ----
  const newLanedLocals = new Map(), extraLocals = []
  const ctx = liftCtx(laneType, incVar, localKind, freshIdRef, fnLocals, newLanedLocals, extraLocals)
  const lifted = []
  for (const s of body) {
    const r = liftStmt(s, ctx)
    if (ctx.fail) return null
    if (r != null) { if (Array.isArray(r) && r[0] === '__seq__') lifted.push(...r.slice(1)); else lifted.push(r) }
  }
  if (!lifted.length) return null
  // Cost model (Part 2 — see the shared header doc before tryGeneralMap). Same
  // check, same reused arrays; `guards.length` is the guard-clause count when versioned.
  if (!isProfitable(body, lifted, LANE_INFO[laneType].lanes, guards.length))
    return liftFail(ctx, 'not profitable: vector cost/lane ≥ scalar cost')

  // ---- Codegen: tryStencil's own proven neighbourhood-gather wrapper, verbatim, plus
  // layer-3's versioning wrap when `guards` is non-empty (see header doc). ----
  const id = freshIdRef.next++
  const simdBoundName = `$__simd_bound${id}`
  const info = LANE_INFO[laneType], lanes = info.lanes
  const boundExpr = cloneNode(bound)
  const simdCap = peel.rightBs.reduce((acc, b) => ['select', cloneNode(b), acc, ['i32.lt_s', cloneNode(b), acc]], boundExpr)
  const boundSetup = ['local.set', simdBoundName, ['i32.sub', simdCap, ['i32.const', lanes - 1]]]
  const simdBlock = simdLoop(id, incVar, simdBoundName, [...lifted,
    ['local.set', incVar, ['i32.add', ['local.get', incVar], ['i32.const', lanes]]]])
  const peelStmts = peel.needed
    ? [['if', ['i32.lt_s', ['local.get', incVar], cloneNode(bound)],
        ['then', ...body.map(cloneNode), cloneNode(bl.loopNode[bl.incIdx])]]]
    : []
  // A failed alias guard skips the peel and the strip; the kept scalar loop then runs every iteration.
  const simdPath = guards.length
    ? [['if', guards.reduce((a, g) => ['i32.and', a, g]), ['then', ...peelStmts, boundSetup, simdBlock]]]
    : [...peelStmts, boundSetup, simdBlock]
  const wrapper = ['block', ...preamble.map(cloneNode), ...simdPath, bl.blockNode]
  const newLocalDecls = [['local', simdBoundName, 'i32'], ...[...newLanedLocals.values()].map(laneName => ['local', laneName, 'v128']), ...extraLocals]
  return { wrapper, newLocalDecls }
}
