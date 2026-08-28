import { walkAst } from '../../ast.js'
import { hasImpureCall, isI32Const, isLocalGet, matchInc1, matchIncN } from './addr-model.js'
import { LANE_PURE, LOAD_OPS, PPC_CALL2, STORE_OPS } from './lane-tables.js'
import { isArr } from './node-utils.js'
import { CMP_LANE, bumpPixelIV, epilogueIsSafe, rampPixelIV, readsVar, writesName } from './outer-scaffold.js'
import { tryPerPixelColor } from './per-pixel-color.js'
import { matchBlockLoop } from './scaffold.js'

// ---- Outer-loop strip-mine over an inner reduction (tryOuterStrip, experimental) ----
//
// The dual of tryPerPixelColor for pixel loops whose per-pixel value comes from an
// INNER REDUCTION over invariant data — metaballs `sum += r²/((cx-bx[b])²+(cy-by[b])²+ε)`,
// voronoi/lyapunov shapes. Strip-mine the OUTER pixel loop 2-wide: pixels (xi, xi+1) →
// f64x2 lanes. The per-pixel coordinate (`cx = xi/W`) becomes a ramp `[cx, cx+1/W]`; the
// inner loop's loads `bx[b]` are indexed by the INNER IV (same for both pixels) → splat;
// the accumulator `sum` becomes an f64x2 carrying both lanes' running sums. After the inner
// loop, each lane's sum is extracted and the scalar pack+store runs per lane (xi, xi+1).
//
// BIT-EXACT: each lane accumulates in the SAME scalar order as the original (f64x2.add is
// per-lane IEEE-754-identical) — a per-lane reduction reorders nothing, unlike a horizontal
// fold. The inner loop's trip count (b < count) is invariant, so its scaffold stays scalar;
// only the f64 body lifts. Distinct base subtrees assumed non-aliasing (the standing model).
// Gated behind cfg.outerStrip until proven across the corpus.
function tryOuterStrip(blockNode, fnLocals, freshIdRef, enabled, outer) {
  if (!enabled) return null
  if (!outer) return null
  const { oLabel, loopNode, preamble, pixelIVs, pxVar, widthBound, pivType, obody, oExit, innerIdxs } = outer

  // Exactly one inner loop in obody; it is the per-pixel reduction.
  if (innerIdxs.length !== 1) return null
  const innerIdx = innerIdxs[0], innerBlock = obody[innerIdx]
  if (!innerBlock) return null
  const ibl = matchBlockLoop(innerBlock, { allowPreamble: true })
  if (!ibl) return null
  if (ibl.preamble.length) return null
  const innerIV = ibl.incVar, ibody = ibl.body
  // No impure calls (a non-pure call would read stale state in the per-lane epilogue). $math.*
  // pure. Fact computed once at the dispatch (LoopPlan: matchOuterPixelLoop) — see hasImpureCall.
  if (outer.hasImpureCall) return null

  const id = freshIdRef.next++
  const nm = (s) => `$__os${id}_${s}`
  const readsName = (n, name) => {
    let found = false
    walkAst(n, { enter: x => { if (found) return false; if (x[0] === 'local.get' && x[1] === name) { found = true; return false } } })
    return found
  }

  const laneMap = new Map()   // f64 lane-local (per-pixel-varying) name → its v128 shadow
  // Lift a scalar f64 expr to f64x2 (null = not liftable). pxVar → ramp; lane local → shadow;
  // pixel-invariant local/global → splat; pixel-invariant f64.load → splat(scalar load);
  // $math.*2 transcendental; cond → bitselect; LANE_PURE.f64 op → recurse.
  const liftOS = (n) => {
    if (!isArr(n)) return null
    const op = n[0]
    if (op === 'f64.const') return ['f64x2.splat', n]
    if (op === 'local.get') {
      const v = n[1]
      if (laneMap.has(v)) return ['local.get', laneMap.get(v)]
      if (pivType.get(v) === 'f64') return rampPixelIV(pivType, v)
      if (writesName(loopNode, v)) return null
      return ['f64x2.splat', n]
    }
    if (op === 'f64.convert_i32_s' && isArr(n[1]) && n[1][0] === 'local.get' && pivType.get(n[1][1]) === 'i32') return rampPixelIV(pivType, n[1][1])
    if (op === 'global.get') return writesName(loopNode, n[1]) ? null : ['f64x2.splat', n]
    if (LOAD_OPS[op] === 'f64') {
      // pixel-invariant load (address reads neither the pixel IV nor any per-pixel lane) is the
      // same value for both lanes → load once, splat. A per-pixel gather is not supported.
      const addr = typeof n[1] === 'string' && n[1].startsWith('offset=') ? n[2] : n[1]
      if (readsName(addr, pxVar) || [...laneMap.keys()].some(lv => readsName(addr, lv))) return null
      return ['f64x2.splat', n]
    }
    if (op === 'call') {
      const v2 = PPC_CALL2[n[1]]
      if (v2 && n.length === 3) { const a = liftOS(n[2]); return a && ['call', v2, a] }
      if (v2 && n.length === 4) { const a = liftOS(n[2]), b = liftOS(n[3]); return (a && b) ? ['call', v2, a, b] : null }
      return null
    }
    if (op === 'if') {
      if (!isArr(n[1]) || n[1][0] !== 'result' || n[1][1] !== 'f64') return null
      const thenN = n[3], elseN = n[4]
      if (!isArr(thenN) || thenN[0] !== 'then' || thenN.length !== 2) return null
      if (!isArr(elseN) || elseN[0] !== 'else' || elseN.length !== 2) return null
      let cond = n[2]
      if (isArr(cond) && cond[0] === 'i32.ne' && isI32Const(cond[2]) && cond[2][1] === 0) cond = cond[1]
      const cmp = isArr(cond) && cond.length === 3 ? CMP_LANE[cond[0]] : null
      if (!cmp) return null
      const ca = liftOS(cond[1]), cb = liftOS(cond[2]), x = liftOS(thenN[1]), y = liftOS(elseN[1])
      if (!ca || !cb || !x || !y) return null
      return ['v128.bitselect', x, y, [cmp, ca, cb]]
    }
    if (LANE_PURE.f64.has(op)) {
      const ks = n.slice(1).map(liftOS)
      return ks.some(k => k === null) ? null : [LANE_PURE.f64.get(op).simd, ...ks]
    }
    return null
  }

  // ---- lift the inner loop body: temp f64 lane locals + f64 accumulator(s) `acc = acc + EXPR`,
  // the inner IV bump stays scalar. Anything else (or an unliftable expr) → bail. ----
  // Pre-scan: f64 accumulators `acc = acc + EXPR`. Assign their f64x2 shadows up front so laneInit
  // can seed them and the lift can accumulate into them (order-independent of the inner body).
  const accNames = new Set()
  for (const s of ibody) {
    if (!(isArr(s) && s[0] === 'local.set' && typeof s[1] === 'string' && s.length === 3)) continue
    const name = s[1], rhs = s[2]
    if (fnLocals.get(name) !== 'f64' || !isArr(rhs) || rhs[0] !== 'f64.add') continue
    const addend = isLocalGet(rhs[1], name) ? rhs[2] : isLocalGet(rhs[2], name) ? rhs[1] : null
    if (addend != null && !readsName(addend, name)) { accNames.add(name); laneMap.set(name, nm('acc' + name.replace(/\W/g, ''))) }
  }
  if (!accNames.size) return null

  // ---- pre-inner-loop stmts (obody[<innerIdx]): per-pixel coord lanes (cx = f(xi) → ramp),
  // accumulator seeds (→ splat), scalar inner-IV init. MUST run before the inner-body lift so the
  // per-pixel coord lanes are registered when the inner loop references them. ----
  const laneInit = []
  const seededAccs = new Set()
  for (let i = 0; i < innerIdx; i++) {
    const s = obody[i]
    if (!(isArr(s) && s[0] === 'local.set' && typeof s[1] === 'string' && s.length === 3)) { laneInit.push(s); continue }
    const name = s[1]
    if (accNames.has(name)) {                       // accumulator seed → splat
      // The seed must be a FRESH per-pixel value, independent of the accumulator's own carry.
      // A seed that reads `name` (e.g. `acc = acc * decay`) propagates the previous pixel's
      // running value across pixels — that's a loop-carried recurrence, not a per-pixel reset.
      if (readsName(s[2], name)) return null
      const seed = liftOS(s[2])
      if (!seed) return null
      seededAccs.add(name)
      laneInit.push(['local.set', laneMap.get(name), seed]); continue
    }
    if (fnLocals.get(name) === 'f64' && readsName(s[2], pxVar)) {   // per-pixel coord (cx = xi/W) → ramp lane
      const lane = liftOS(s[2])
      if (!lane) return null
      const sh = nm('p' + name.replace(/\W/g, ''))
      laneMap.set(name, sh)
      laneInit.push(['local.set', sh, lane]); continue
    }
    laneInit.push(s)                                // scalar (inner IV init `b=0`, invariant setup)
  }

  // LEGALITY: every accumulator must be FRESHLY SEEDED inside the outer-loop body. An accumulator
  // with no per-pixel seed is live-in — carried across outer iterations (a recurrence like the
  // lorenz `x = x + S·(…)` evolving over the sample loop). The two pixel lanes are then DEPENDENT:
  // lane xi+1 must continue from lane xi's final value, not restart from a splat of the shared
  // carry. Strip-mining it runs both lanes from the same seed in lockstep — halving the real work
  // and producing a wrong result (a bogus speedup on a serial recurrence). Reject.
  for (const a of accNames) if (!seededAccs.has(a)) return null

  // ---- lift the inner-loop body: temp f64 lane locals + accumulate into the acc shadows; the
  // inner IV bump stays scalar. Per-pixel coords now resolve via laneMap. ----
  const liftedInner = []
  for (const s of ibody) {
    if (matchInc1(s) === innerIV || matchIncN(s)?.name === innerIV) { liftedInner.push(s); continue }
    if (!(isArr(s) && s[0] === 'local.set' && typeof s[1] === 'string' && s.length === 3)) return null
    const name = s[1], rhs = s[2]
    if (fnLocals.get(name) !== 'f64') return null
    if (accNames.has(name)) {
      const addend = isLocalGet(rhs[1], name) ? rhs[2] : rhs[1]
      const lifted = liftOS(addend)
      if (!lifted) return null
      liftedInner.push(['local.set', laneMap.get(name), ['f64x2.add', ['local.get', laneMap.get(name)], lifted]]); continue
    }
    if (readsName(rhs, name)) return null   // loop-carried non-accumulator → bail
    const lifted = liftOS(rhs)
    if (!lifted) return null
    const sh = laneMap.get(name) || nm('t' + name.replace(/\W/g, ''))
    laneMap.set(name, sh)
    liftedInner.push(['local.set', sh, lifted])
  }

  // ---- epilogue (obody[>innerIdx]): the per-pixel pack+store, run scalar per lane (bumped to xi+k),
  // reading the extracted accumulator/lane values. Safety (epilogueIsSafe, hoisted — byte-identical
  // at all 3 outer-pixel call sites): every in-loop read must be a lane local, a pixel IV, or
  // written within the epilogue itself. ----
  const epilogue = obody.slice(innerIdx + 1)
  if (!epilogueIsSafe(epilogue, loopNode, laneMap, pivType)) return null
  // store must exist + vary per lane
  let hasStore = false
  const findStore = n => { if (STORE_OPS[n[0]]) hasStore = true }
  for (const s of epilogue) walkAst(s, { enter: findStore })
  if (!hasStore) return null

  // ============================ emit ============================
  const newLocalDecls = [...new Set(laneMap.values())].map(n => ['local', n, 'v128'])
  const epiReads = [...laneMap.keys()].filter(v => epilogue.some(s => readsVar(s, v)))
  // Rebuild the inner loop with its scalar scaffold (exit + the bottom IV bump, which lives at
  // loopNode[incIdx] — NOT in `body`) and the lifted f64x2 body in between.
  const innerLoopNode = ibl.loopNode
  const iExit = innerLoopNode[2]                       // (br_if iBrk (eqz (b < count)))
  const iInc = innerLoopNode[ibl.incIdx]               // (local.set b (i32.add b 1)) — scalar, kept
  const iLabelB = innerBlock[1], iLabelL = innerLoopNode[1]
  const innerSimd = ['block', iLabelB, ['loop', iLabelL, iExit, ...liftedInner, iInc, ['br', iLabelL]]]
  const laneCompute = [...laneInit, innerSimd]
  const epiLane = (k) => [
    ...epiReads.map(v => ['local.set', v, ['f64x2.extract_lane', k, ['local.get', laneMap.get(v)]]]),
    ...epilogue.map(s => bumpPixelIV(pivType, s, k)),
  ]
  const sOut = nm('ob'), sOl = nm('ol')
  const simdOuter = ['block', sOut, ['loop', sOl,
    ['br_if', sOut, ['i32.eqz', [oExit.cmpOp, bumpPixelIV(pivType, ['local.get', pxVar], 1), widthBound]]],
    ...laneCompute, ...epiLane(0), ...epiLane(1),
    ...pixelIVs.map(p => ['local.set', p.name, [p.type + '.add', ['local.get', p.name], [p.type + '.const', 2]]]),
    ['br', sOl]]]
  const wrapper = ['block', nm('w'), ...preamble, simdOuter, ['block', oLabel, loopNode]]
  return { wrapper, newLocalDecls }
}

// ---- Per-pixel iterated-map reduction (tryIteratedReduce, experimental) ----------------------
//
// Generalizes the outer-strip to the ITERATED-MAP fractal shape — lyapunov, bifurcation, smooth-
// escape attractors — whose per-pixel value runs a recurrence many times and accumulates a
// transcendental. Beyond tryOuterStrip (one inner loop, a plain additive accumulator) it handles:
//   • MULTIPLE inner loops carrying per-pixel f64 state between them (lyapunov warmup → accumulate),
//   • loop-carried f64 RECURRENCES   x = r·x·(1−x)   (not just acc = acc + …),
//   • lane-invariant scalar bookkeeping kept SCALAR — integer counters with wraparound and the
//     forcing-sequence gather seq[si] (same index for both lanes → one scalar load),
//   • a scalar-condition select   seq[si]<1 ? a : b   (a ramps per lane, b splats) → a scalar
//     `if (result v128)`, and a per-lane conditional accumulate   if(d>0) L += log(d)   → bitselect.
// Two adjacent pixels (xi, xi+1) run as f64x2 lanes; the colour pack+store runs scalar per lane,
// and the original scalar loop, kept as the tail, finishes the odd last pixel.
//
// BIT-EXACT: f64x2 arithmetic is per-lane IEEE-identical, $math.log_v/exp_v are the per-lane mirrors
// of the scalar polys, and the conditional accumulate adds bitselect(f(x), 0, mask) — exactly the
// scalar add-or-skip. The speculatively-evaluated transcendental of a masked-out lane is discarded
// (the helpers never trap). Gated behind cfg.outerStrip; only fires when an inner loop
// carries a transcendental (the latency-bound work SIMD actually accelerates — cheap-arithmetic
// pixel loops are left to the scalar JIT, which already pipelines independent iterations).
function tryIteratedReduce(blockNode, fnLocals, freshIdRef, enabled, outer) {
  if (!enabled) return null
  if (!outer) return null
  const { oLabel, loopNode, preamble, pixelIVs, pxVar, widthBound, pivType, obody, oExit, innerIdxs } = outer
  if (!innerIdxs.length) return null
  const lastInner = innerIdxs[innerIdxs.length - 1]
  const innerSet = new Set(innerIdxs)

  // No impure calls — fact computed once at the dispatch (LoopPlan: matchOuterPixelLoop).
  if (outer.hasImpureCall) return null

  const id = freshIdRef.next++
  const nm = (s) => `$__ir${id}_${s}`
  const laneMap = new Map()       // f64 per-pixel local → its v128 shadow
  const shadowOf = (v) => { let s = laneMap.get(v); if (!s) { s = nm(v.replace(/\W/g, '')); laneMap.set(v, s) } return s }
  let sawHeavy = false            // a transcendental lifted inside a loop → SIMD is worth it

  const readsName = (n, name) => {
    let found = false
    walkAst(n, { enter: x => { if (found) return false; if (x[0] === 'local.get' && x[1] === name) { found = true; return false } } })
    return found
  }
  // Lane-invariant: reads no per-pixel lane local and no pixel IV → identical value in both lanes.
  const laneInvariant = (root) => {
    let found = false
    walkAst(root, { enter: n => {
      if (found) return false
      if (n[0] === 'local.get' && (laneMap.has(n[1]) || pivType.has(n[1]))) { found = true; return false }
    } })
    return !found
  }

  // Build the f64x2 form of `cond ? x : y` from already-lifted arms `x`,`y` and the raw `cond`.
  // A lane-INVARIANT cond (same both lanes — e.g. seq[si]<1) → a v128-typed scalar branch; a
  // per-lane f64 compare → bitselect (x where cond, y elsewhere).
  const liftSelect = (x, y, cond) => {
    if (!x || !y) return null
    if (isArr(cond) && cond[0] === 'i32.ne' && isI32Const(cond[2]) && cond[2][1] === 0) cond = cond[1]
    if (laneInvariant(cond)) return ['if', ['result', 'v128'], cond, ['then', x], ['else', y]]
    const cmp = isArr(cond) && cond.length === 3 ? CMP_LANE[cond[0]] : null
    if (!cmp) return null
    const ca = lift(cond[1]), cb = lift(cond[2])
    return (ca && cb) ? ['v128.bitselect', x, y, [cmp, ca, cb]] : null
  }
  // Lift an f64 expression to f64x2 (null = not liftable).
  const lift = (n) => {
    if (!isArr(n)) return null
    const op = n[0]
    if (op === 'f64.const') return ['f64x2.splat', n]
    if (op === 'local.get') {
      const v = n[1]
      if (laneMap.has(v)) return ['local.get', laneMap.get(v)]
      if (pivType.get(v) === 'f64') return rampPixelIV(pivType, v)
      if (writesName(loopNode, v)) return null
      return ['f64x2.splat', n]
    }
    if (op === 'f64.convert_i32_s' && isArr(n[1]) && n[1][0] === 'local.get' && pivType.get(n[1][1]) === 'i32') return rampPixelIV(pivType, n[1][1])
    if (op === 'global.get') return writesName(loopNode, n[1]) ? null : ['f64x2.splat', n]
    if (LOAD_OPS[op] === 'f64') {
      const addr = typeof n[1] === 'string' && n[1].startsWith('offset=') ? n[2] : n[1]
      if (readsName(addr, pxVar) || [...laneMap.keys()].some(lv => readsName(addr, lv))) return null   // per-lane gather: unsupported
      return ['f64x2.splat', n]
    }
    if (op === 'call') {
      const v2 = PPC_CALL2[n[1]]
      if (!v2) return null
      if (n.length === 3) { const a = lift(n[2]); if (!a) return null; sawHeavy = true; return ['call', v2, a] }
      if (n.length === 4) { const a = lift(n[2]), b = lift(n[3]); if (!a || !b) return null; sawHeavy = true; return ['call', v2, a, b] }
      return null
    }
    if (op === 'if') {
      if (!isArr(n[1]) || n[1][0] !== 'result' || n[1][1] !== 'f64') return null
      const thenN = n[3], elseN = n[4]
      if (!isArr(thenN) || thenN[0] !== 'then' || thenN.length !== 2) return null
      if (!isArr(elseN) || elseN[0] !== 'else' || elseN.length !== 2) return null
      let cond = n[2]
      if (isArr(cond) && cond[0] === 'i32.ne' && isI32Const(cond[2]) && cond[2][1] === 0) cond = cond[1]
      return liftSelect(lift(thenN[1]), lift(elseN[1]), cond)
    }
    // jz lowers `cond ? A : B` to a `select` (A if cond else B). Same two cases as the `if` form:
    // lane-invariant cond → a scalar v128-typed branch; per-lane f64 compare → bitselect.
    if (op === 'select' && n.length === 4) return liftSelect(lift(n[1]), lift(n[2]), n[3])
    if (LANE_PURE.f64.has(op)) {
      const ks = n.slice(1).map(lift)
      return ks.some(k => k === null) ? null : [LANE_PURE.f64.get(op).simd, ...ks]
    }
    return null
  }

  // Lift one inner-loop body statement → its lifted form(s), or null to bail.
  const liftInnerStmt = (s, innerIV) => {
    if (matchInc1(s) === innerIV || matchIncN(s)?.name === innerIV) return [s]   // IV bump: scalar
    if (isArr(s) && s[0] === 'local.set' && typeof s[1] === 'string' && s.length === 3) {
      const name = s[1], rhs = s[2]
      if (fnLocals.get(name) !== 'f64') return laneInvariant(rhs) ? [s] : null   // scalar i32 counter
      const lifted = lift(rhs)   // recurrence (rhs reads name) resolves to the shadow — fine
      return lifted ? [['local.set', shadowOf(name), lifted]] : null
    }
    // Lane-invariant scalar `if` (counter wraparound `if(si>=N) si=0`) → keep scalar.
    if (isArr(s) && s[0] === 'if' && laneInvariant(s[1]) &&
        s.slice(2).every(arm => isArr(arm) && (arm[0] === 'then' || arm[0] === 'else') &&
          arm.slice(1).every(st => isArr(st) && st[0] === 'local.set' && fnLocals.get(st[1]) !== 'f64'))) return [s]
    // Per-lane conditional accumulate `if(cond) acc = acc + E` → acc += bitselect(liftE, 0, mask).
    if (isArr(s) && s[0] === 'if' && s.length === 3 && isArr(s[2]) && s[2][0] === 'then' && s[2].length === 2) {
      const st = s[2][1]
      if (isArr(st) && st[0] === 'local.set' && st.length === 3 && fnLocals.get(st[1]) === 'f64' && laneMap.has(st[1]) &&
          isArr(st[2]) && st[2][0] === 'f64.add' && isLocalGet(st[2][1], st[1])) {
        const cond = s[1], cmp = isArr(cond) && cond.length === 3 ? CMP_LANE[cond[0]] : null
        if (!cmp || laneInvariant(cond)) return null   // need a per-lane mask
        const liftE = lift(st[2][2]), ca = lift(cond[1]), cb = lift(cond[2])
        if (!liftE || !ca || !cb) return null
        const sh = laneMap.get(st[1])
        return [['local.set', sh, ['f64x2.add', ['local.get', sh], ['v128.bitselect', liftE, ['f64x2.splat', ['f64.const', 0]], [cmp, ca, cb]]]]]
      }
    }
    return null
  }

  const liftInnerLoop = (block) => {
    const ibl = matchBlockLoop(block, { allowPreamble: true })
    if (!ibl || ibl.preamble.length) return null
    const lifted = []
    for (const s of ibl.body) { const out = liftInnerStmt(s, ibl.incVar); if (!out) return null; lifted.push(...out) }
    return ['block', ibl.blockLabel, ['loop', ibl.loopLabel, ibl.loopNode[2], ...lifted, ibl.loopNode[ibl.incIdx], ['br', ibl.loopLabel]]]
  }

  // ---- laneCompute = obody[0..lastInner]: f64 seeds → shadow lift; scalar seeds kept; loops lifted ----
  const laneCompute = []
  for (let i = 0; i <= lastInner; i++) {
    const s = obody[i]
    if (innerSet.has(i)) { const li = liftInnerLoop(s); if (!li) return null; laneCompute.push(li); continue }
    if (isArr(s) && s[0] === 'local.set' && typeof s[1] === 'string' && s.length === 3) {
      const name = s[1], rhs = s[2]
      if (fnLocals.get(name) === 'f64') {
        if (readsName(rhs, name)) return null   // self-reading seed = carry across the OUTER loop → reject
        const lifted = lift(rhs); if (!lifted) return null
        laneCompute.push(['local.set', shadowOf(name), lifted])
      } else { if (!laneInvariant(rhs)) return null; laneCompute.push(s) }   // scalar counter seed
      continue
    }
    return null
  }
  if (!sawHeavy || !laneMap.size) return null   // no transcendental reduction → leave to the scalar JIT

  // ---- epilogue = obody[lastInner+1..]: colour pack+store, run scalar per lane ----
  const epilogue = obody.slice(lastInner + 1)
  let hasStore = false
  const findStore = n => { if (STORE_OPS[n[0]]) hasStore = true }
  for (const s of epilogue) walkAst(s, { enter: findStore })
  if (!hasStore) return null
  // epilogueIsSafe, hoisted — byte-identical at all 3 outer-pixel call sites.
  const epiSafety = epilogueIsSafe(epilogue, loopNode, laneMap, pivType)
  if (!epiSafety) return null
  const epiReadSet = epiSafety.reads
  const epiReads = [...laneMap.keys()].filter(v => epiReadSet.has(v))
  if (!epiReads.length) return null

  // ============================ emit ============================
  const newLocalDecls = [...new Set(laneMap.values())].map(n => ['local', n, 'v128'])
  const epiLane = (k) => [
    ...epiReads.map(v => ['local.set', v, ['f64x2.extract_lane', k, ['local.get', laneMap.get(v)]]]),
    ...epilogue.map(s => bumpPixelIV(pivType, s, k)),
  ]
  const sOut = nm('ob'), sOl = nm('ol')
  const simdOuter = ['block', sOut, ['loop', sOl,
    ['br_if', sOut, ['i32.eqz', [oExit.cmpOp, bumpPixelIV(pivType, ['local.get', pxVar], 1), widthBound]]],
    ...laneCompute, ...epiLane(0), ...epiLane(1),
    ...pixelIVs.map(p => ['local.set', p.name, [p.type + '.add', ['local.get', p.name], [p.type + '.const', 2]]]),
    ['br', sOl]]]
  const wrapper = ['block', nm('w'), ...preamble, simdOuter, ['block', oLabel, loopNode]]
  return { wrapper, newLocalDecls }
}

// ---- Integer convolution column-strip-mine (tryConvColumn, experimental) ---------------------
//
// The int8 quantized convolution / dense-MAC kernel (conv2d): an OUTER output-pixel loop (ox)
// whose body — after the inner receptive-field loops fully unroll at speed — is a straight-line
// f64 reduction  acc = bias + Σ inp[…+ox]·wt[…]  over int8 taps, then requantize (acc>>SHIFT),
// ReLU-clamp, and store one uint8. jz accumulates in f64, but every product is int8×int8 (≤ 16129)
// and the sum fits i32, so the f64 carries an EXACT integer. That lets us strip-mine the column
// loop 8-wide as pure integer SIMD: 8 adjacent outputs (ox..ox+7) in lanes. Per tap, the per-pixel
// input gather inp[base+ox] is 8 CONTIGUOUS bytes — `v128.load64_zero` + `i16x8.extend_low_i8x16`
// — and the (pixel-invariant) weight broadcasts via `i16x8.splat`; `i16x8.mul` forms 8 products
// (each fits i16), widened (`i32x4.extend_low/high_i16x8_s`) into two i32x4 accumulators so 36 taps
// never overflow. Requant + clamp + store run scalar per lane; the kept scalar loop is the <8 tail.
//
// BIT-EXACT: integer arithmetic reorders nothing — each lane's i32 sum equals the scalar f64's exact
// integer, and ToInt32(acc)>>SHIFT == lane>>SHIFT. Gated behind cfg.outerStrip. ~5×
// over the scalar reduction (the serial f64 add-chain is latency-bound; 8 columns hide it).
function tryConvColumn(blockNode, fnLocals, freshIdRef, enabled, outer) {
  if (!enabled) return null
  if (!outer) return null
  const { oLabel, loopNode, preamble, pixelIVs, pxVar, widthBound, pivType, obody, oExit, innerIdxs } = outer
  if (pivType.get(pxVar) !== 'i32') return null                 // strip-mine an integer column
  if (innerIdxs.length) return null  // body must be unrolled (no inner loop)
  // No impure calls — fact computed once at the dispatch (LoopPlan: matchOuterPixelLoop).
  if (outer.hasImpureCall) return null
  const readsName = (n, name) => {
    let found = false
    walkAst(n, { enter: x => { if (found) return false; if (x[0] === 'local.get' && x[1] === name) { found = true; return false } } })
    return found
  }

  // Locals whose value depends on the column IV (transitively) — these address the per-pixel gather.
  const oxDep = new Set([pxVar])
  const allSets = []
  const collectSets = n => { if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') allSets.push([n[1], n[2]]) }
  for (const s of obody) walkAst(s, { enter: collectSets })
  for (let changed = true; changed;) { changed = false; for (const [name, rhs] of allSets) if (!oxDep.has(name) && [...oxDep].some(d => readsName(rhs, d))) { oxDep.add(name); changed = true } }
  const isGatherAddr = (addr) => [...oxDep].some(d => readsName(addr, d))

  // A byte tap operand: convert_i32_{s,u}(i32.load8_{s,u}(addr)). Returns { load, addr, signed }.
  const matchByteLoad = (n) => {
    // Accept the f64 form (convert_i32_{s,u}(load8)) AND the bare i32 load —
    // the emit-level convert-peel narrows int8·int8 to i32.mul(load8, load8),
    // so the taps arrive unconverted (the better shape: no f64 detour to undo).
    let ld = null
    if (isArr(n) && (n[0] === 'f64.convert_i32_s' || n[0] === 'f64.convert_i32_u') && isArr(n[1])) ld = n[1]
    else if (isArr(n) && (n[0] === 'i32.load8_s' || n[0] === 'i32.load8_u')) ld = n
    if (!ld || (ld[0] !== 'i32.load8_s' && ld[0] !== 'i32.load8_u')) return null
    const addr = (typeof ld[1] === 'string' && ld[1].startsWith('offset=')) ? ld[2] : ld[1]
    return { load: ld, addr, signed: ld[0] === 'i32.load8_s' }
  }
  const load64 = (ld) => (typeof ld[1] === 'string' && ld[1].startsWith('offset=')) ? ['v128.load64_zero', ld[1], ld[2]] : ['v128.load64_zero', ld[1]]
  // Lift a single product addend `inp·wt` (exactly one side gathers on ox) to an i16x8 of 8 products.
  const liftProduct = (prod) => {
    // f64.mul(cvt(load), cvt(load)) — pre-peel — or f64.convert_i32_s(i32.mul(
    // load, load)) / bare i32.mul(load, load) — the peeled faithful product.
    if (isArr(prod) && prod[0] === 'f64.convert_i32_s' && isArr(prod[1]) && prod[1][0] === 'i32.mul') prod = prod[1]
    if (!isArr(prod) || (prod[0] !== 'f64.mul' && prod[0] !== 'i32.mul')) return null
    const a = matchByteLoad(prod[1]), b = matchByteLoad(prod[2])
    if (!a || !b) return null
    const ag = isGatherAddr(a.addr), bg = isGatherAddr(b.addr)
    const g = ag && !bg ? a : bg && !ag ? b : null            // exactly one per-pixel gather
    if (!g) return null
    const inv = g === a ? b : a
    const gI16 = [g.signed ? 'i16x8.extend_low_i8x16_s' : 'i16x8.extend_low_i8x16_u', load64(g.load)]
    return ['i16x8.mul', gI16, ['i16x8.splat', inv.load]]      // splat the invariant weight (fits i16)
  }

  // THE accumulator: an f64 local written as `acc = acc + product` (either operand order). Its FIRST
  // write is the init — a plain invariant `acc = bias`, or (bias folded into the first tap by the
  // reassociator) `acc = bias + product`.
  const macAddend = (rhs, name) => (isArr(rhs) && rhs[0] === 'f64.add') ? (isLocalGet(rhs[1], name) ? rhs[2] : isLocalGet(rhs[2], name) ? rhs[1] : null) : null
  let accName = null
  for (const [name, rhs] of allSets) if (fnLocals.get(name) === 'f64' && macAddend(rhs, name) != null) { if (accName && accName !== name) return null; accName = name }
  if (!accName) return null
  const accIdx = []
  for (let i = 0; i < obody.length; i++) { const s = obody[i]; if (isArr(s) && s[0] === 'local.set' && s[1] === accName && s.length === 3) accIdx.push(i) }
  if (accIdx.length < 4) return null
  const initIdx = accIdx[0], initRhs = obody[initIdx][2]
  if (readsName(initRhs, accName)) return null                   // first write must not read acc

  const id = freshIdRef.next++
  const nm = (s) => `$__cv${id}_${s}`
  const loV = nm('lo'), hiV = nm('hi'), pV = nm('p')
  const splatI32 = (e) => ['i32x4.splat', (isArr(e) && (e[0] === 'f64.convert_i32_s' || e[0] === 'f64.convert_i32_u')) ? e[1] : ['i32.trunc_sat_f64_s', e]]
  const accStmts = (prod) => [
    ['local.set', pV, prod],
    ['local.set', loV, ['i32x4.add', ['local.get', loV], ['i32x4.extend_low_i16x8_s', ['local.get', pV]]]],
    ['local.set', hiV, ['i32x4.add', ['local.get', hiV], ['i32x4.extend_high_i16x8_s', ['local.get', pV]]]],
  ]
  // Init → lo/hi seeded to the invariant bias, plus the folded first tap (if the bias was fused in).
  const initStmts = () => {
    if (isArr(initRhs) && initRhs[0] === 'f64.add') {
      const pA = liftProduct(initRhs[1]), pB = liftProduct(initRhs[2])
      const bias = pA && !pB ? initRhs[2] : pB && !pA ? initRhs[1] : null
      const prod = pA && !pB ? pA : pB && !pA ? pB : null
      if (!prod || isGatherAddr(bias)) return null
      return [['local.set', loV, splatI32(bias)], ['local.set', hiV, splatI32(bias)], ...accStmts(prod)]
    }
    if (isGatherAddr(initRhs)) return null                       // plain seed must be loop-invariant
    return [['local.set', loV, splatI32(initRhs)], ['local.set', hiV, splatI32(initRhs)]]
  }

  // Build the SIMD body: keep scalar address setup; init→lo/hi seed; each MAC→i16x8 product → lo/hi.
  const lastMac = accIdx[accIdx.length - 1]
  const laneCompute = []
  for (let i = 0; i <= lastMac; i++) {
    const s = obody[i]
    if (i === initIdx) { const init = initStmts(); if (!init) return null; laneCompute.push(...init); continue }
    if (isArr(s) && s[0] === 'local.set' && s[1] === accName) {
      const addend = macAddend(s[2], accName)
      if (addend == null) return null                            // an acc write that isn't acc+product
      const prod = liftProduct(addend); if (!prod) return null
      laneCompute.push(...accStmts(prod)); continue
    }
    if (readsName(s, accName)) return null                       // scalar setup must not touch acc
    laneCompute.push(s)
  }

  // Epilogue (requant + clamp + store) runs scalar per lane: acc ← the lane's i32 column sum.
  const epilogue = obody.slice(lastMac + 1)
  let hasStore = false
  const findStore = n => { if (STORE_OPS[n[0]]) hasStore = true }
  for (const s of epilogue) walkAst(s, { enter: findStore })
  if (!hasStore) return null
  const epiLane = (k) => [
    ['local.set', accName, ['f64.convert_i32_s', ['i32x4.extract_lane', k & 3, ['local.get', k < 4 ? loV : hiV]]]],
    ...epilogue.map(s => bumpPixelIV(pivType, s, k)),
  ]

  const newLocalDecls = [['local', loV, 'v128'], ['local', hiV, 'v128'], ['local', pV, 'v128']]
  const sOut = nm('ob'), sOl = nm('ol')
  // Guard requires 8 columns available (ox+7 < width); the kept scalar loop finishes the <8 tail.
  const simdOuter = ['block', sOut, ['loop', sOl,
    ['br_if', sOut, ['i32.eqz', [oExit.cmpOp, bumpPixelIV(pivType, ['local.get', pxVar], 7), widthBound]]],
    ...laneCompute, ...epiLane(0), ...epiLane(1), ...epiLane(2), ...epiLane(3), ...epiLane(4), ...epiLane(5), ...epiLane(6), ...epiLane(7),
    ...pixelIVs.map(p => ['local.set', p.name, [p.type + '.add', ['local.get', p.name], [p.type + '.const', 8]]]),
    ['br', sOl]]]
  const wrapper = ['block', nm('w'), ...preamble, simdOuter, ['block', oLabel, loopNode]]
  return { wrapper, newLocalDecls }
}

// ---- Unified OUTER-STRIP recognizer (dispatch entry) -------------------------
//
// Design §2 "OUTER-STRIP (#8-12, 5 recognizers, 11 reach) → 2 general recognizers": all 5
// already share the outer-pixel scaffold (matchOuterPixelLoop / `op` — bumpPixelIV,
// epilogueIsSafe, PPC_CALL2, LANE_PURE.f64/CMP_LANE); only "what happens inside the outer
// body" is bespoke per function. The design's proposed 2-way split is semantic (masked-
// divergent {tryDivergentEscapeVectorize, tryIteratedReduce} vs. straight-line/reduction
// {tryPerPixelColor, tryOuterStrip, tryConvColumn}) — but that grouping does NOT match the
// current dispatch chain's total order (divergent-escape, per-pixel-color, outer-strip,
// iterated-reduce, conv-column): tryIteratedReduce sits BETWEEN tryOuterStrip and
// tryConvColumn, interleaved with the "straight-line" group, not adjacent to
// tryDivergentEscapeVectorize. Ledger decision (.work/research.md): grouping by the
// design's semantic split was tried first and FAILED the byte-identity gate —
// examples/interference (tryOuterStrip's sole specimen) started matching
// tryIteratedReduce instead once iterated-reduce moved earlier (both produce the identical
// f64x2 lockstep lift, differing only in local-name prefix — `$__os*` vs `$__ir*` — a pure
// recognizer-identity swap, WAT-diffed to confirm: same line count, same op sequence, 82
// changed lines all naming-only). Landed the SAFE alternative instead: `tryDivergentEscapeVectorize`
// stays a standalone dispatch call at its original position (unchanged — cheapest, zero
// reordering risk, it was already first), and the remaining 4 — tryPerPixelColor,
// tryOuterStrip, tryIteratedReduce, tryConvColumn — merge into ONE recognizer
// (`tryOuterStripRest`) in their EXACT original relative order, so total dispatch order is
// byte-for-byte unchanged. This is 5 recognizers → 2 dispatch entries (the design's own
// stated unit, §1: "recognizer = dispatch-chain entry"), just not split along the design's
// semantic axis — coverage-preserving by construction (order-identical), not by re-derived
// preconditions. Gate: 130/130 byte-identical, incl. examples/interference unchanged.
export function tryOuterStripRest(blockNode, fnLocals, freshIdRef, pureFuncMap, outerStrip, outer) {
  return tryPerPixelColor(blockNode, fnLocals, freshIdRef, pureFuncMap, outer)
    ?? tryOuterStrip(blockNode, fnLocals, freshIdRef, outerStrip, outer)
    ?? tryIteratedReduce(blockNode, fnLocals, freshIdRef, outerStrip, outer)
    ?? tryConvColumn(blockNode, fnLocals, freshIdRef, outerStrip, outer)
}

