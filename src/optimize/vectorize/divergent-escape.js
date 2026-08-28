import { walkAst } from '../../ast.js'
import { constNum, hasSideEffect, isLocalGet, matchInc1 } from './addr-model.js'
import { LANE_PURE } from './lane-tables.js'
import { isArr } from './node-utils.js'
import { CMP_LANE, CMP_NEG, bumpPixelIV, readsVar, writesName } from './outer-scaffold.js'

export function tryDivergentEscapeVectorize(blockNode, fnLocals, freshIdRef, outer) {
  // Outer per-pixel scaffold (+ LICM preamble feeding both SIMD path and tail) —
  // matched once at the dispatch (LoopPlan), consumed here.
  if (!outer) return null
  const { oLabel, loopNode, preamble, pixelIVs, pxVar, widthBound, pivType, obody, oExit, innerIdxs } = outer
  if (innerIdxs.length !== 1) return null   // exactly one inner escape loop
  const innerIdx = innerIdxs[0], innerBlock = obody[innerIdx]
  const iLabel = (typeof innerBlock[1] === 'string' && innerBlock[1].startsWith('$')) ? innerBlock[1] : null
  if (!iLabel || innerBlock.length < 3) return null
  const innerLoop = innerBlock[innerBlock.length - 1]
  if (!isArr(innerLoop) || innerLoop[0] !== 'loop') return null
  const ilLabel = (typeof innerLoop[1] === 'string' && innerLoop[1].startsWith('$')) ? innerLoop[1] : null
  if (!ilLabel) return null
  // The inner block may also carry LICM-hoisted invariants (e.g. BAILOUT) before the loop.
  // They must be pixel-pair-invariant (read only outer-invariants) so one copy feeds both
  // lanes; hoist them ahead of the SIMD loop.
  const innerPre = innerBlock.slice(2, innerBlock.length - 1)
  for (const s of innerPre) {
    if (!isArr(s) || s[0] !== 'local.set' || s.length !== 3) return null
    const inv = (n) => !isArr(n) || ((n[0] === 'local.get' || n[0] === 'global.get') ? !writesName(loopNode, n[1]) : n.every((c, i) => i === 0 || inv(c)))
    if (!inv(s[2])) return null
  }

  // ---- inner escape loop: a top while-cond + body (f64 updates + one mid-break) + it++.
  // The two continue/break conditions are an `it < MAXIT` limit and a `|z|² vs T` escape,
  // in EITHER order (mandelbrot/ship: limit at top; example-mandelbrot: escape at top). ----
  const iEnd = innerLoop.length - 1
  if (!(isArr(innerLoop[iEnd]) && innerLoop[iEnd][0] === 'br' && innerLoop[iEnd][1] === ilLabel)) return null
  const itVar = matchInc1(innerLoop[iEnd - 1])
  if (!itVar || fnLocals.get(itVar) !== 'i32') return null

  // A break statement (br_if, or `if BC (then (br iLabel))`) → its break-when condition.
  // breakCond: does this statement break the inner loop?  Returns { cond, assigns } where
  // `assigns` is a list of { name, val } local.set stmts extracted from the then-block
  // BEFORE the final br.  Existing single-br form → assigns=[].  Multi-stmt then form (Newton:
  // `if(cond)(then (local.set $root K)(br $iLabel))`) → assigns=[{name,val}].
  const breakCond = (s) => {
    if (!isArr(s)) return null
    if (s[0] === 'br_if' && s[1] === iLabel) return { cond: s[2], assigns: [] }
    if (s[0] !== 'if' || s.length !== 3 || !isArr(s[2]) || s[2][0] !== 'then') return null
    const then = s[2]
    // then-block must end with (br $iLabel); all preceding stmts must be local.set
    if (!isArr(then[then.length - 1]) || then[then.length - 1][0] !== 'br' || then[then.length - 1][1] !== iLabel) return null
    const assigns = []
    for (let k = 1; k < then.length - 1; k++) {
      const st = then[k]
      if (!isArr(st) || st[0] !== 'local.set' || st.length !== 3) return null
      assigns.push({ name: st[1], val: st[2] })
    }
    return { cond: s[1], assigns }
  }
  // keep (continue) condition vs the break-when condition. A while-guard `(i32.eqz CONT)`
  // keeps on CONT directly; a mid-break `if (X) break` keeps on ¬X. We must NOT lower ¬X by
  // flipping the comparison (f64.gt→f64.le): for NaN, scalar `NOT(NaN>T)` is TRUE but
  // `NaN<=T` is FALSE — they disagree, so an orbit that reaches NaN without escaping would
  // wrongly deactivate. Instead keep the DIRECT comparison and negate the lane mask with
  // v128.not (NaN-exact: gt is false on NaN, ¬false = keep, matching scalar).
  const keepOf = (bc) => {
    if (!isArr(bc)) return null
    if (bc[0] === 'i32.eqz' && isArr(bc[1]) && CMP_LANE[bc[1][0]]) return { cmp: bc[1], negate: false }
    if (CMP_NEG[bc[0]]) return { cmp: bc, negate: true }
    return null
  }
  const topBcR = breakCond(innerLoop[2])
  const topBc = topBcR?.cond   // raw condition expr (backward-compat name for compound-top checks)
  let keepTop = topBcR && keepOf(topBcR.cond)
  const ibody = innerLoop.slice(3, iEnd - 1)
  let midIdx = -1, keepMid = null, compoundTop = false
  // Compound while-guard `while (it<MAX && |z|²<T)` → `eqz(and(A,B))`: two keep conditions, both
  // at the top (continue while A AND B). The Julia set is written this way. Split A,B into the two
  // keeps; the body is then pure updates (no mid-break).
  if (!keepTop && isArr(topBc) && topBc[0] === 'i32.eqz' && isArr(topBc[1]) && topBc[1][0] === 'i32.and'
      && isArr(topBc[1][1]) && CMP_LANE[topBc[1][1][0]] && isArr(topBc[1][2]) && CMP_LANE[topBc[1][2][0]]) {
    keepTop = { cmp: topBc[1][1], negate: false }
    keepMid = { cmp: topBc[1][2], negate: false }
    compoundTop = true
  }
  if (!keepTop) return null
  // Collect mid-breaks.  The existing single-break path requires exactly one.
  // The new multi-break path (Newton-style convergence) allows several outcome breaks
  // — each `if(COND)(then (local.set $X K)(br $iLabel))` — when the top guard is the
  // sole limit condition and ALL mid-breaks are escape-kind with i32 outcome assigns.
  const midBreaks = []   // [{ idx, keep, assigns }]
  if (compoundTop) {
    for (let i = 0; i < ibody.length; i++)
      if (!(isArr(ibody[i]) && ibody[i][0] === 'local.set' && ibody[i].length === 3 && fnLocals.get(ibody[i][1]) === 'f64')) return null
  } else {
    for (let i = 0; i < ibody.length; i++) {
      const bcR = breakCond(ibody[i])
      if (bcR) {
        const k = keepOf(bcR.cond)
        if (!k) return null
        midBreaks.push({ idx: i, keep: k, assigns: bcR.assigns })
      } else if (!(isArr(ibody[i]) && ibody[i][0] === 'local.set' && ibody[i].length === 3 && fnLocals.get(ibody[i][1]) === 'f64')) return null
    }
    if (midBreaks.length === 0) return null
    if (midBreaks.length === 1) {
      // single-break: preserve exact existing behaviour
      midIdx = midBreaks[0].idx; keepMid = midBreaks[0].keep
    }
    // multi-break: handled below after classification
  }

  // classify f64 vars written across [top-guard, …body…]: loop-carried (first access a READ)
  // vs within-iteration temp (first access a WRITE — including squares tee'd in the guard).
  const seq = [innerLoop[2], ...ibody]
  const written = new Set()
  for (const s of seq) walkAst(s, { enter: n => { if ((n[0] === 'local.set' || n[0] === 'local.tee') && fnLocals.get(n[1]) === 'f64') written.add(n[1]) } })
  const carried = new Set(), temp = new Set(), seen = new Set()
  const classify = (n) => {
    if (!isArr(n)) return
    if (n[0] === 'local.get') { const v = n[1]; if (written.has(v) && !seen.has(v)) { seen.add(v); carried.add(v) }; return }
    if (n[0] === 'local.set' || n[0] === 'local.tee') { classify(n[2]); const v = n[1]; if (written.has(v) && !seen.has(v)) { seen.add(v); temp.add(v) }; return }
    for (let i = 1; i < n.length; i++) classify(n[i])
  }
  seq.forEach(classify)

  // hoist tees out of the keep conditions into explicit temp computations
  const tees = []
  const detee = (n) => isArr(n) ? (n[0] === 'local.tee' ? (tees.push({ tgt: n[1], expr: detee(n[2]) }), ['local.get', n[1]]) : n.map(detee)) : n
  const keepTopC = { cmp: [keepTop.cmp[0], detee(keepTop.cmp[1]), detee(keepTop.cmp[2])], negate: keepTop.negate }
  const teeTop = tees.length
  const keepMidC = keepMid ? { cmp: [keepMid.cmp[0], detee(keepMid.cmp[1]), detee(keepMid.cmp[2])], negate: keepMid.negate } : null

  // each keep is an it-limit (mentions `it` directly or via convert) or a z-escape; need one of each
  const isIt = (n) => isLocalGet(n, itVar) || (isArr(n) && n[0] === 'f64.convert_i32_s' && isLocalGet(n[1], itVar))
  const kindOf = (k) => (isIt(k.cmp[1]) || isIt(k.cmp[2])) ? 'limit' : 'escape'
  const kTop = kindOf(keepTopC)
  const limitKeep = keepTopC   // initialised here; may be reassigned below for single-break
  let kMid = null, boundExpr, boundI32, itLeft
  // Compound-top guard `while (A && B)`: classify the SECOND keep too. Left unclassified (kMid=null),
  // the downstream lift/keepMask treats keepMidC as a per-lane f64 escape — right for the Julia order
  // (limit, escape) but it then lifts the i32 LIMIT of the mandelbrot order (escape, `it<MAX`) into an
  // f64 lane and crashes. Setting kMid routes the limit through the scalar guard instead; for the
  // Julia order kMid='escape' is identical to the old null (both lift). Bail if neither keep is an
  // escape — a two-limit guard has no per-lane divergence for this vectorizer to exploit.
  if (compoundTop) {
    kMid = kindOf(keepMidC)
    if (kTop === 'limit' && kMid === 'limit') return null
  }
  if (midBreaks.length === 1) {
    kMid = kindOf(keepMidC)
    if (kTop === kMid) return null
    const lk = kTop === 'limit' ? keepTopC : keepMidC
    itLeft = isIt(lk.cmp[1])
    boundExpr = itLeft ? lk.cmp[2] : lk.cmp[1]
    boundI32 = lk.cmp[0].startsWith('i32.')
  } else if (midBreaks.length > 1) {
    // Multi-break path: top must be the sole limit; all mid-breaks must be escape-kind.
    if (kTop !== 'limit') return null
    for (const mb of midBreaks) if (kindOf(mb.keep) !== 'escape') return null
    itLeft = isIt(keepTopC.cmp[1])
    boundExpr = itLeft ? keepTopC.cmp[2] : keepTopC.cmp[1]
    boundI32 = keepTopC.cmp[0].startsWith('i32.')
  }
  // limit bound must be loop-invariant (splatted once per pair): no carried/temp ref, not written
  for (const v of [...carried, ...temp]) if (readsVar(boundExpr, v)) return null
  const boundInvariant = (n) => !isArr(n) || ((n[0] !== 'local.get' && n[0] !== 'global.get') || !writesName(loopNode, n[1])) && n.every((c, i) => i === 0 || boundInvariant(c))
  if (!boundInvariant(boundExpr)) return null

  // c-vars: f64 locals read in the lifted exprs but never written there (per-pixel/invariant inputs).
  // Also allow loop-invariant global.get (e.g. module constants like R3 in newton) — splatted inline.
  const cVars = new Set()
  const liftable = (root) => {
    let bad = false
    walkAst(root, { enter: n => {
      if (bad) return false
      if (n[0] === 'local.get') {
        const v = n[1]
        if (v !== itVar && !carried.has(v) && !temp.has(v)) {
          if (fnLocals.get(v) !== 'f64') { bad = true; return false }
          cVars.add(v)
        }
        return false
      }
      if (n[0] === 'f64.const') return false
      if (n[0] === 'global.get') { if (writesName(loopNode, n[1])) bad = true; return false }   // loop-invariant global → splat
      if (!LANE_PURE.f64.has(n[0])) { bad = true; return false }
    } })
    return isArr(root) && !bad
  }
  const midIdxSet = new Set(midBreaks.map(mb => mb.idx))
  for (const t of tees) if (!liftable(t.expr)) return null
  for (let i = 0; i < ibody.length; i++) if (!midIdxSet.has(i) && !liftable(ibody[i][2])) return null
  if (midBreaks.length === 1) {
    const escapeKeep = kTop === 'escape' ? keepTopC : keepMidC
    if (!liftable(escapeKeep.cmp[1]) || !liftable(escapeKeep.cmp[2])) return null
  } else {
    // multi-break: each break's escape condition arguments must be liftable
    for (const mb of midBreaks) {
      const mbC = { cmp: [mb.keep.cmp[0], detee(mb.keep.cmp[1]), detee(mb.keep.cmp[2])], negate: mb.keep.negate }
      mb.keepC = mbC   // store deteed keepC on mb for use in emit
      if (!liftable(mbC.cmp[1]) || !liftable(mbC.cmp[2])) return null
    }
  }

  // ---- pre-inner inits + epilogue ----
  // i32 outcome variables assigned by multi-break outcome stmts (e.g. $root in Newton).
  // Their pre-inner `local.set $root 0` default-init is valid and must not be rejected.
  const outcomeVarSetEarly = new Set(midBreaks.flatMap(mb => mb.assigns.map(a => a.name)))
  const carriedInit = new Map()   // carried var → its f64.const seed (before the loop)
  const perPxInit = new Map()     // c-var → its per-pixel init expr
  // Pre-watr, jz's raw lowering hasn't run DCE yet — obody[0..innerIdx) may hold pre-loop f64
  // locals the OLD post-watr recognizer never saw (watr had already deleted them). Two live
  // shapes beyond direct escape-loop reads (cVars, already populated by the liftable() walk
  // above): (a) truly dead — a per-pixel grid coord the update ignores (Julia fixed-c: cx/cy
  // computed but the orbit never reads them — mandelbrot's dual DOES read them); safe to drop.
  // (b) a carried var's z0 seed reads it INDIRECTLY through one extra local (Julia/Newton
  // per-pixel z0: x0 = <ramp>; zx = x0) — cVars only sees reads INSIDE the escape loop, so x0
  // is invisible to it even though it IS the real seed expression. Close that gap with a
  // needed-set fixpoint before classifying, so x0 promotes to a c-var exactly like a directly
  // read grid coord — liftCLane already resolves a cVar reference at emit.
  const epilogue = obody.slice(innerIdx + 1)
  const preStmts = []
  for (let i = 0; i < innerIdx; i++) {
    const s = obody[i]
    if (!isArr(s) || s[0] !== 'local.set' || s.length !== 3) return null
    preStmts.push({ tgt: s[1], expr: s[2] })
  }
  const preTgt = new Set(preStmts.map(p => p.tgt))
  // A pre-loop local promotes to a c-var only if some OTHER classified site actually reads it —
  // never one of the reserved roles (carried/temp/itVar/outcome), which already have their own
  // per-lane home and must keep taking their existing branch below.
  const promotable = (v) => !carried.has(v) && !temp.has(v) && v !== itVar && !outcomeVarSetEarly.has(v)
  const needed = new Set(cVars)
  for (const { tgt, expr } of preStmts) if (carried.has(tgt)) for (const v of preTgt) if (promotable(v) && readsVar(expr, v)) needed.add(v)
  for (const e of epilogue) for (const v of preTgt) if (promotable(v) && readsVar(e, v)) needed.add(v)
  for (let changed = true; changed;) {
    changed = false
    for (const { tgt, expr } of preStmts) if (needed.has(tgt))
      for (const v of preTgt) if (v !== tgt && promotable(v) && !needed.has(v) && readsVar(expr, v)) { needed.add(v); changed = true }
  }
  for (const { tgt, expr } of preStmts) {
    if (carried.has(tgt)) {
      // z₀ seed: a constant (mandelbrot/burning-ship z₀=0) OR a per-pixel expr (Julia set, where
      // z₀ = the pixel and c is constant — the dual of mandelbrot). liftCLane handles both at emit.
      carriedInit.set(tgt, expr)
    } else if (temp.has(tgt)) { /* recomputed each iteration — init ignored */ }
    else if (tgt === itVar) { if (constNum(expr) !== 0) return null }
    else if (needed.has(tgt)) { cVars.add(tgt); perPxInit.set(tgt, expr) }
    else if (outcomeVarSetEarly.has(tgt)) { /* i32 outcome var default init — ignored, handled per-lane */ }
    else if (!hasSideEffect(expr)) { /* dead per-pixel local — the escape update never reads it, drop */ }
    else return null
  }
  for (const c of carried) if (!carriedInit.has(c)) return null
  // The epilogue runs scalar per lane; it may only read carried/it/pixel-IV/invariant
  // values (each statement's reads, before that statement's writes). A read of an
  // inner-loop temp or a per-pixel c-var has no post-loop per-lane value → bail.
  {
    const written = new Set()
    for (const s of epilogue) {
      const r = new Set()
      walkAst(s, { enter: n => { if (n[0] === 'local.get') { r.add(n[1]); return false } } })
      for (const v of r) if (!written.has(v) && (temp.has(v) || perPxInit.has(v))) return null
      walkAst(s, { enter: n => { if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') written.add(n[1]) } })
    }
    if (!epilogue.length) return null
  }

  // ============================ emit ============================
  const id = freshIdRef.next++
  const nm = (s) => `$__esc${id}_${s}`
  const shadow = new Map()                       // carried/temp f64 var → v128 shadow
  for (const v of [...carried, ...temp]) shadow.set(v, nm('z' + v.replace(/\W/g, '')))
  const cLane = new Map()
  for (const cv of cVars) cLane.set(cv, nm('c' + cv.replace(/\W/g, '')))
  const iterV = nm('iter'), activeV = nm('act'), maxitLane = nm('lim')
  const newLocalDecls = []
  for (const n of [...shadow.values(), ...cLane.values()]) newLocalDecls.push(['local', n, 'v128'])

  const lift = (n) => {
    if (n[0] === 'local.get') return ['local.get', shadow.has(n[1]) ? shadow.get(n[1]) : cLane.get(n[1])]
    if (n[0] === 'f64.const') return ['f64x2.splat', n]
    if (n[0] === 'global.get') return ['f64x2.splat', n]   // loop-invariant module global (e.g. R3)
    return [LANE_PURE.f64.get(n[0]).simd, ...n.slice(1).map(lift)]
  }

  // Build a per-pixel c-var's two lanes by lifting its init to f64x2: the pixel IV becomes the
  // ramp [v, v+1], a dependency on another c-var resolves to that c-var's already-built lane
  // (so chains like `bail = 4 + cx*cx` get the right per-lane value — NOT the px=0 value from a
  // bump that can't follow `cx`), and everything else (grid constants) splats. Returns null if
  // the init reads inner-loop state or an op we can't lift, in which case we decline.
  const liftCLane = (n) => {
    if (!isArr(n)) return null
    if (n[0] === 'local.get' || n[0] === 'global.get') {
      const v = n[1]
      if (n[0] === 'local.get') {
        if (cLane.has(v)) return ['local.get', cLane.get(v)]                 // another c-var's lane
        if (carried.has(v) || temp.has(v)) return null                       // inner-loop state — must not appear
        if (pivType.get(v) === 'f64') return ['f64x2.replace_lane', 1, ['f64x2.splat', n], ['f64.add', n, ['f64.const', 1]]]
      }
      if (writesName(loopNode, v)) return null                               // a per-pixel value we can't ramp → decline
      return ['f64x2.splat', n]                                              // loop-invariant local/global
    }
    if (n[0] === 'f64.const') return ['f64x2.splat', n]
    if (n[0] === 'f64.convert_i32_s' && isArr(n[1]) && n[1][0] === 'local.get' && pivType.get(n[1][1]) === 'i32') {
      const piv = n[1]
      return ['f64x2.replace_lane', 1, ['f64x2.splat', ['f64.convert_i32_s', piv]], ['f64.convert_i32_s', ['i32.add', piv, ['i32.const', 1]]]]
    }
    if (LANE_PURE.f64.has(n[0])) { const ks = n.slice(1).map(liftCLane); return ks.some(k => k === null) ? null : [LANE_PURE.f64.get(n[0]).simd, ...ks] }
    return null
  }
  // c-lanes in dependency order: invariants splat first, then per-pixel inits in source (obody) order
  const cOrder = [...cVars].filter(cv => !perPxInit.has(cv))
  for (let i = 0; i < innerIdx; i++) { const s = obody[i]; if (isArr(s) && s[0] === 'local.set' && perPxInit.has(s[1])) cOrder.push(s[1]) }
  const pre = []
  for (const cv of cOrder) {
    if (perPxInit.has(cv)) {
      const lane = liftCLane(perPxInit.get(cv))
      if (!lane) return null
      pre.push(['local.set', cLane.get(cv), lane])
    } else pre.push(['local.set', cLane.get(cv), ['f64x2.splat', ['local.get', cv]]])
  }
  // Seed each carried lane in dependency order. Seeds reading only non-carried values (z₀ = a
  // const, or a per-pixel ramp for the Julia set) build their lanes via liftCLane. Seeds reading
  // a carried var — the cached squares `zx2 = zx*zx` in Julia's compound guard — lift through the
  // already-built shadow lanes instead.
  const seedDeps = (e) => [...carried].some(c => readsVar(e, c))
  const depLiftable = (n) => !isArr(n) ? false
    : n[0] === 'local.get' ? shadow.has(n[1])
    : n[0] === 'f64.const' ? true
    : (LANE_PURE.f64.has(n[0]) && n.slice(1).every(depLiftable))
  for (const v of carried) if (!seedDeps(carriedInit.get(v))) {
    const lane = liftCLane(carriedInit.get(v))
    if (!lane) return null
    pre.push(['local.set', shadow.get(v), lane])
  }
  for (const v of carried) if (seedDeps(carriedInit.get(v))) {
    if (!depLiftable(carriedInit.get(v))) return null
    pre.push(['local.set', shadow.get(v), lift(carriedInit.get(v))])
  }
  const teeStmts = (range) => range.map(t => ['local.set', shadow.get(t.tgt), lift(t.expr)])
  const sIn = nm('ib'), sIl = nm('il'), sOut = nm('ob'), sOl = nm('ol')

  // FAST PATH — the common escape-time shape `while (it<MAX){ …updates…; if (|z|²>T) break }`:
  // break the pair the instant the FIRST lane escapes (no per-iteration freeze/mask), keep `it`
  // a scalar i32, raw f64x2 updates. A short scalar tail then finishes whichever lane lagged (≈0
  // iterations when the pair is coherent, which adjacent pixels overwhelmingly are). Inside-set
  // pixels (both lanes to MAX) run clean 2× with zero mask overhead — exactly where the masked
  // loop bled its speedup. Other shapes (escape-at-top, body after the break) take the masked path.
  // escape-at-MID: `…updates…; if (|z|²>T) break` (burning-ship). escape-at-TOP: the escape gates
  // the loop head — either syntactically in the while condition, or after only temporary
  // computations such as `x2=zx*zx; y2=zy*zy` and before every carried-state update. The latter
  // is canonical `while(limit){ squares; if(escape) break; update }`. Both take the fast path;
  // only a true post-update break advances `it` before the lagging-lane tail resumes.
  const escAtMid = !compoundTop && kMid === 'escape' && midIdx === ibody.length - 1
  const escBeforeCarry = !compoundTop && kMid === 'escape' && midIdx >= 0 &&
    ibody.slice(0, midIdx).every(s => temp.has(s[1])) &&
    ibody.slice(midIdx + 1).some(s => carried.has(s[1]))
  const escAtTop = compoundTop || kTop === 'escape' || escBeforeCarry
  const fastPath = escAtMid || escAtTop
  let simdInner, epiLane, postLoop = []

  if (fastPath) {
    const shIt = nm('shit'), escF = nm('escf')
    newLocalDecls.push(['local', shIt, 'i32'], ['local', escF, 'i32'])
    pre.push(['local.set', itVar, ['i32.const', 0]], ['local.set', escF, ['i32.const', 0]])
    const limOf = (keepC) => keepC.negate ? [CMP_NEG[keepC.cmp[0]], keepC.cmp[1], keepC.cmp[2]] : keepC.cmp
    // emit a keep at its source position: a LIMIT (it is shared) → a scalar i32 guard; an ESCAPE
    // → an any_true break. `escF` records whether the loop exited via an escape (vs the limit) —
    // they can BOTH land at it=MAX (escape-at-top fires before the limit-at-mid's final update),
    // so `it < MAX` alone can't tell them apart; the tail must run only on an escape exit.
    const fastKeep = (keepC, kind, teeRange) => {
      const out = teeStmts(teeRange)
      if (kind === 'limit') out.push(['br_if', sIn, ['i32.eqz', limOf(keepC)]])
      else {
        const escL = [CMP_LANE[keepC.cmp[0]], lift(keepC.cmp[1]), lift(keepC.cmp[2])]
        out.push(['local.set', escF, ['i32.const', 1]])
        out.push(['br_if', sIn, ['v128.any_true', keepC.negate ? escL : ['v128.not', escL]]])
        out.push(['local.set', escF, ['i32.const', 0]])
      }
      return out
    }
    const sbody = [...fastKeep(keepTopC, kTop, tees.slice(0, teeTop))]
    if (compoundTop) sbody.push(...fastKeep(keepMidC, kMid, tees.slice(teeTop)))   // second top keep
    for (let i = 0; i < ibody.length; i++) {
      if (!compoundTop && i === midIdx) sbody.push(...fastKeep(keepMidC, kMid, tees.slice(teeTop)))
      else sbody.push(['local.set', shadow.get(ibody[i][1]), lift(ibody[i][2])])   // raw update, no freeze
    }
    sbody.push(['local.set', itVar, ['i32.add', ['local.get', itVar], ['i32.const', 1]]])
    simdInner = ['block', sIn, ['loop', sIl, ...sbody, ['br', sIl]]]
    postLoop = [['local.set', shIt, ['local.get', itVar]]]   // capture the break `it` AFTER the block exits

    // a fresh-labelled copy of the inner block, to finish a lagging lane's remaining iterations
    let copyN = 0
    const relabelInner = () => {
      const ni = nm('tb' + copyN), nl = nm('tl' + copyN); copyN++
      const rl = (n) => !isArr(n) ? n
        : ((n[0] === 'block' || n[0] === 'loop' || n[0] === 'br' || n[0] === 'br_if') && (n[1] === iLabel || n[1] === ilLabel))
          ? [n[0], n[1] === iLabel ? ni : nl, ...n.slice(2).map(rl)]
          : n.map(rl)
      return rl(innerBlock)
    }
    const escKeepC = compoundTop ? keepMidC : (kTop === 'escape' ? keepTopC : keepMidC)
    const escTees = (kTop === 'escape' ? tees.slice(0, teeTop) : tees.slice(teeTop)).map(t => ['local.set', t.tgt, t.expr])
    const notEsc = escKeepC.negate ? ['i32.eqz', escKeepC.cmp] : escKeepC.cmp
    epiLane = (k) => {
      const out = []
      // Extract carried AND temp lanes: the escape compare may read a temp (the optimizer
      // copy-propagates `x = xt` so `x*x` becomes `xt*xt`); the skip test below needs it.
      for (const v of [...carried, ...temp]) out.push(['local.set', v, ['f64x2.extract_lane', k, ['local.get', shadow.get(v)]]])
      for (let i = 0; i < innerIdx; i++) { const s = obody[i]; if (isArr(s) && s[0] === 'local.set' && perPxInit.has(s[1])) out.push(bumpPixelIV(pivType, s, k)) }
      out.push(['local.set', itVar, ['local.get', shIt]])
      out.push(['if', ['local.get', escF], ['then',                 // exited via escape (not the limit)…
        ...escTees,
        ['if', notEsc, ['then',                                      // …and THIS lane hadn't escaped → finish it
          // escape-at-MID already ran this iteration's update, so step past it before resuming;
          // escape-at-TOP tests before the update, so resume at the same it.
          ...(escAtMid ? [['local.set', itVar, ['i32.add', ['local.get', itVar], ['i32.const', 1]]]] : []),
          relabelInner()]]]])
      for (const s of epilogue) out.push(bumpPixelIV(pivType, s, k))
      return out
    }
  } else if (midBreaks.length > 1) {
    // ---- MULTI-OUTCOME masked path (Newton-style convergence loops) ----
    // Each mid-break `if(COND)(then (local.set $X K)(br))` converges a subset of lanes per
    // iteration.  We track which lanes are still running in `activeV` and per-lane outcomes
    // in i32x4 shadow vectors (one per distinct i32 outcome variable).  The break mask for
    // each convergence condition is: v128.and(activeV, breakMaskOf(keepC)).
    // Bit-exactness: i32x4 layout has 4 lanes of 32 bits.  f64x2 has 2 lanes of 64 bits.
    // For f64 lane k, i32 lane 2*k carries the outcome (lower 32 bits of the f64 lane).
    // i32x4.splat(K) fills all 4 i32 lanes with K; v128.bitselect selects at bit level, so
    // for a converged f64 lane (bits 64k…64k+63 = -1 in the mask) both i32 halves get K.
    // i32x4.extract_lane(2*k, outcomeVec) recovers the scalar outcome per lane. ✓

    // Collect distinct i32 outcome variables across all mid-breaks.
    const outcomeVars = []    // distinct i32 local names that get assigned in outcome breaks
    const outcomeVarSet = new Set()
    for (const mb of midBreaks) {
      for (const a of mb.assigns) {
        // itVar is tracked by iterV (f64x2) directly — not as an i32x4 outcome shadow.
        if (a.name !== itVar && !outcomeVarSet.has(a.name)) { outcomeVarSet.add(a.name); outcomeVars.push(a.name) }
      }
    }
    // Each outcome var gets an i32x4 shadow vector (initial value 0 = "no convergence" default).
    const outcomeVec = new Map()
    for (const v of outcomeVars) { const sv = nm('out' + v.replace(/\W/g, '')); outcomeVec.set(v, sv); newLocalDecls.push(['local', sv, 'v128']) }

    newLocalDecls.push(['local', iterV, 'v128'], ['local', activeV, 'v128'], ['local', maxitLane, 'v128'])
    pre.push(['local.set', iterV, ['f64x2.splat', ['f64.const', 0]]])
    pre.push(['local.set', activeV, ['v128.const', 'i32x4', '-1', '-1', '-1', '-1']])
    pre.push(['local.set', maxitLane, ['f64x2.splat', boundI32 ? ['f64.convert_i32_s', boundExpr] : boundExpr]])
    for (const sv of outcomeVec.values()) pre.push(['local.set', sv, ['v128.const', 'i32x4', '0', '0', '0', '0']])

    // keepMask for the limit top-guard (iter < MAXIT)
    const keepMask = (keep, isLimit) => {
      const m = isLimit
        ? [CMP_LANE[keep.cmp[0]], itLeft ? ['local.get', iterV] : ['local.get', maxitLane], itLeft ? ['local.get', maxitLane] : ['local.get', iterV]]
        : [CMP_LANE[keep.cmp[0]], lift(keep.cmp[1]), lift(keep.cmp[2])]
      return keep.negate ? ['v128.not', m] : m
    }
    // breakMaskOf: v128 where bits = -1 for lanes whose break condition is NOW true
    // (opposite of keepMask: keep.negate=true → break is the positive compare).
    const breakMaskOf = (keepC) => {
      const m = [CMP_LANE[keepC.cmp[0]], lift(keepC.cmp[1]), lift(keepC.cmp[2])]
      return keepC.negate ? m : ['v128.not', m]
    }

    const sbody = [
      ...teeStmts(tees.slice(0, teeTop)),
      ['local.set', activeV, ['v128.and', ['local.get', activeV], keepMask(keepTopC, true)]],
      ['br_if', sIn, ['i32.eqz', ['v128.any_true', ['local.get', activeV]]]],
    ]
    for (let i = 0; i < ibody.length; i++) {
      const mb = midBreaks.find(m => m.idx === i)
      if (mb) {
        // Convergence break: compute which lanes converge on THIS step.
        const bm = breakMaskOf(mb.keepC)
        const convV = nm('conv' + i)
        newLocalDecls.push(['local', convV, 'v128'])
        sbody.push(['local.set', convV, ['v128.and', ['local.get', activeV], bm]])
        // Apply each outcome assignment via bitselect on converged-this-step mask.
        for (const a of mb.assigns) {
          if (a.name === itVar) {
            // Assignment to the iteration counter (e.g. it=MAXIT before break): freeze iterV.
            sbody.push(['local.set', iterV, ['v128.bitselect', ['local.get', maxitLane], ['local.get', iterV], ['local.get', convV]]])
          } else if (outcomeVec.has(a.name)) {
            // i32 outcome variable (e.g. root=1/2/3): bitselect into its i32x4 shadow.
            // The scalar value K must be an i32 constant — splat it across all i32x4 lanes.
            if (!isArr(a.val) || a.val[0] !== 'i32.const') return null
            const sv = outcomeVec.get(a.name)
            sbody.push(['local.set', sv, ['v128.bitselect', ['i32x4.splat', a.val], ['local.get', sv], ['local.get', convV]]])
          } else return null   // unexpected assign target
        }
        // Remove newly-converged lanes from active set.
        sbody.push(['local.set', activeV, ['v128.andnot', ['local.get', activeV], ['local.get', convV]]])
      } else {
        const v = ibody[i][1]
        if (carried.has(v)) sbody.push(['local.set', shadow.get(v), ['v128.bitselect', lift(ibody[i][2]), ['local.get', shadow.get(v)], ['local.get', activeV]]])
        else sbody.push(['local.set', shadow.get(v), lift(ibody[i][2])])
      }
    }
    sbody.push(['local.set', iterV, ['v128.bitselect', ['f64x2.add', ['local.get', iterV], ['f64x2.splat', ['f64.const', 1]]], ['local.get', iterV], ['local.get', activeV]]])
    simdInner = ['block', sIn, ['loop', sIl, ...sbody, ['br', sIl]]]
    const carriedInEpi = [...carried].filter(v => epilogue.some(s => readsVar(s, v)))
    epiLane = (k) => {
      const out = []
      for (const v of carriedInEpi) out.push(['local.set', v, ['f64x2.extract_lane', k, ['local.get', shadow.get(v)]]])
      out.push(['local.set', itVar, ['i32.trunc_f64_s', ['f64x2.extract_lane', k, ['local.get', iterV]]]])
      // Extract per-lane outcome variables from their i32x4 shadows (i32 lane = 2*k).
      for (const [v, sv] of outcomeVec) out.push(['local.set', v, ['i32x4.extract_lane', 2 * k, ['local.get', sv]]])
      for (const s of epilogue) out.push(bumpPixelIV(pivType, s, k))
      return out
    }
  } else {
    newLocalDecls.push(['local', iterV, 'v128'], ['local', activeV, 'v128'], ['local', maxitLane, 'v128'])
    pre.push(['local.set', iterV, ['f64x2.splat', ['f64.const', 0]]])
    pre.push(['local.set', activeV, ['v128.const', 'i32x4', '-1', '-1', '-1', '-1']])
    pre.push(['local.set', maxitLane, ['f64x2.splat', boundI32 ? ['f64.convert_i32_s', boundExpr] : boundExpr]])
    // AND a keep into the active mask: limit compares iter (f64x2) to the bound; escape lifts its
    // z-comparison; a mid-break's ¬X is the DIRECT compare negated by v128.not (NaN-exact).
    const keepMask = (keep, isLimit) => {
      const m = isLimit
        ? [CMP_LANE[keep.cmp[0]], itLeft ? ['local.get', iterV] : ['local.get', maxitLane], itLeft ? ['local.get', maxitLane] : ['local.get', iterV]]
        : [CMP_LANE[keep.cmp[0]], lift(keep.cmp[1]), lift(keep.cmp[2])]
      return keep.negate ? ['v128.not', m] : m
    }
    const sbody = [
      ...teeStmts(tees.slice(0, teeTop)),
      ['local.set', activeV, ['v128.and', ['local.get', activeV], keepMask(keepTopC, kTop === 'limit')]],
      // compound `while (A && B)`: the second keep (B) also gates at the top, before the body
      ...(compoundTop ? teeStmts(tees.slice(teeTop)).concat([['local.set', activeV, ['v128.and', ['local.get', activeV], keepMask(keepMidC, kMid === 'limit')]]]) : []),
      ['br_if', sIn, ['i32.eqz', ['v128.any_true', ['local.get', activeV]]]],
    ]
    for (let i = 0; i < ibody.length; i++) {
      if (!compoundTop && i === midIdx) {
        sbody.push(...teeStmts(tees.slice(teeTop)))
        sbody.push(['local.set', activeV, ['v128.and', ['local.get', activeV], keepMask(keepMidC, kMid === 'limit')]])
      } else {
        const v = ibody[i][1]
        if (carried.has(v)) sbody.push(['local.set', shadow.get(v), ['v128.bitselect', lift(ibody[i][2]), ['local.get', shadow.get(v)], ['local.get', activeV]]])
        else sbody.push(['local.set', shadow.get(v), lift(ibody[i][2])])
      }
    }
    sbody.push(['local.set', iterV, ['v128.bitselect', ['f64x2.add', ['local.get', iterV], ['f64x2.splat', ['f64.const', 1]]], ['local.get', iterV], ['local.get', activeV]]])
    simdInner = ['block', sIn, ['loop', sIl, ...sbody, ['br', sIl]]]
    const carriedInEpi = [...carried].filter(v => epilogue.some(s => readsVar(s, v)))
    epiLane = (k) => {
      const out = []
      for (const v of carriedInEpi) out.push(['local.set', v, ['f64x2.extract_lane', k, ['local.get', shadow.get(v)]]])
      out.push(['local.set', itVar, ['i32.trunc_f64_s', ['f64x2.extract_lane', k, ['local.get', iterV]]]])
      for (const s of epilogue) out.push(bumpPixelIV(pivType, s, k))
      return out
    }
  }

  // SIMD outer loop: process a pair while x+1 is still a valid pixel, then advance every pixel IV
  // by 2. The scalar tail (original block) finishes any last odd pixel.
  const simdOuter = ['block', sOut, ['loop', sOl,
    ['br_if', sOut, ['i32.eqz', [oExit.cmpOp, bumpPixelIV(pivType, ['local.get', pxVar], 1), widthBound]]],
    ...pre, simdInner, ...postLoop, ...epiLane(0), ...epiLane(1),
    ...pixelIVs.map(p => ['local.set', p.name, [p.type + '.add', ['local.get', p.name], [p.type + '.const', 2]]]),
    ['br', sOl]]]

  // wrapper: hoisted preambles once (outer + inner-block invariants like BAILOUT), then the
  // SIMD even-pixel loop, then the original scalar block handles the odd-pixel tail.
  const tailBlock = ['block', oLabel, loopNode]
  const wrapper = ['block', nm('w'), ...preamble, ...innerPre, simdOuter, tailBlock]
  return { wrapper, newLocalDecls }
}
