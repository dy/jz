import { findBodyStart } from '../../ir.js'
import { walkAst } from '../../ast.js'
import { isI32Const } from './addr-model.js'
import { LANE_PURE, PPC_CALL2, STORE_OPS } from './lane-tables.js'
import { forEachLocalDef, isArr } from './node-utils.js'
import { CMP_LANE, bumpPixelIV, epilogueIsSafe, rampPixelIV, readsVar, writesName } from './outer-scaffold.js'

// Per-pixel-color vectorizer. The dual of tryDivergentEscapeVectorize for kernels with NO inner
// escape loop: an outer pixel loop whose body computes an f64 value from the pixel index (via
// cos/sin/sqrt/…), packs it to a u32 colour, and stores it — every pixel independent. We lift the
// liftable f64 PREFIX of the body to f64x2 (two adjacent pixels per lane: the index becomes the
// ramp [x, x+1]; transcendentals map to the bit-exact $math.*2 helpers; conditionals to bitselect),
// then run the SCALAR pack+store once per lane (extract_lane → the original f64 local → the
// untouched integer pack). The expensive transcendentals run 2-wide; the cheap pack stays scalar.
// Bit-exact by construction: f64x2 arithmetic is per-lane IEEE-identical and extract_lane is exact.
// A call we can't yet vectorize (pow in Phase 1) just ends the SIMD prefix — its lane local and the
// rest fall to the scalar epilogue, so the kernel still partially vectorizes. The original scalar
// loop, re-run as the tail, finishes the odd last pixel for free (its own `x < W` guard).
export function tryPerPixelColor(blockNode, fnLocals, freshIdRef, pureFuncMap, outer) {
  // Outer per-pixel scaffold — matched once at the dispatch (LoopPlan); this pass
  // takes the straight-line-body branch (no inner escape loop) below.
  if (!outer) return null
  const { oLabel, loopNode, preamble, pixelIVs, pxVar, widthBound, pivType, obody, oExit, innerIdxs } = outer

  // ---- body: straight-line (no inner escape loop), no impure call ----
  if (innerIdxs.length) return null  // inner escape loop → tryDivergentEscapeVectorize's job
  // A non-pure call (e.g. a ray-march helper that writes a scratch global / memory) can mutate state
  // that a lane local — computed ONCE, before the per-lane epilogue runs the call — would then read
  // stale, breaking bit-exactness. $math.* helpers are pure (no global/memory writes), so allow them.
  // Pure user-defined functions in pureFuncMap are also safe: they have no side effects (verified
  // when the map is built) and liftPPC inlines them expression-level rather than emitting a call.
  const impureCall = (root) => {
    let found = false
    walkAst(root, { enter: n => {
      if (found) return false
      if (n[0] === 'call' && typeof n[1] === 'string' && !n[1].startsWith('$math.') && !(pureFuncMap && pureFuncMap.has(n[1]))) { found = true; return false }
    } })
    return found
  }
  if (obody.some(impureCall)) return null


  // Pixel-coordinate aliases: a local consistently CSE'd to `convert_i32_s(pixelIV)` (jz tees the f64
  // pixel-x once — reused for the store address AND the per-pixel math — so it lives inside the i32
  // offset stmt, out of reach as a lane local). Treat its reads as the ramp, recomputed per lane.
  const pxAlias = new Map()
  {
    const defs = new Map()
    forEachLocalDef(obody, (name, rhs) => { (defs.get(name) || defs.set(name, []).get(name)).push(rhs) })
    for (const [name, rhss] of defs) {
      const j = JSON.stringify(rhss[0])
      if (!rhss.every(r => JSON.stringify(r) === j)) continue   // multiple distinct defs → not a stable alias
      const r = rhss[0]
      if (isArr(r) && r[0] === 'f64.convert_i32_s' && isArr(r[1]) && r[1][0] === 'local.get' && pivType.get(r[1][1]) === 'i32') pxAlias.set(name, r[1][1])
      else if (isArr(r) && r[0] === 'local.get' && pivType.get(r[1]) === 'f64') pxAlias.set(name, r[1])
    }
  }
  // The two lanes of a pixel IV (or its alias): [v, v+1], in f64 (an i32 IV is converted per lane).

  const id = freshIdRef.next++
  const nm = (s) => `$__ppc${id}_${s}`
  const laneMap = new Map()       // f64 lane-local name → its v128 shadow
  const laneLifted = new Map()    // f64 lane-local name → its lifted f64x2 expr

  // Inline a pure user function call into a lifted f64x2 expression.
  // `callNode` is ['call', '$name', arg0, arg1, ...]; `outerLift` is the liftPPC fn.
  // Walks the callee's body, substituting params with lifted args and inlined-local
  // intermediates. Returns null if any step fails (bail → scalar epilogue).
  // SOUND: only called when callee is in pureFuncMap (no stores/global.sets/impure
  // calls); param names are read-only in the inlinee body (verified below).
  const liftPPCInline = (callNode, outerLift) => {
    const callee = pureFuncMap.get(callNode[1])
    if (!callee) return null
    const calleeBodyStart = findBodyStart(callee)
    if (calleeBodyStart < 0) return null

    // Collect callee params in order.
    const calleeParams = []
    for (let i = 2; i < calleeBodyStart; i++) {
      const d = callee[i]
      if (isArr(d) && d[0] === 'param' && typeof d[1] === 'string') calleeParams.push(d[1])
    }
    // Args supplied by the call site (call node children after the name).
    const callArgs = callNode.slice(2)
    if (callArgs.length !== calleeParams.length) return null

    // Lift each arg with the outer liftPPC.
    const substMap = new Map()
    for (let i = 0; i < calleeParams.length; i++) {
      const lifted = outerLift(callArgs[i])
      if (lifted === null) return null
      substMap.set(calleeParams[i], lifted)
    }

    // Verify no local.set on a param name inside the callee body (params are read-only).
    for (const pname of calleeParams) {
      if (writesName(callee.slice(calleeBodyStart), pname)) return null
    }

    // liftInline: lift a callee-body expression using substMap (params + inlined locals).
    // Handles f64.const, local.get from substMap, LANE_PURE.f64 ops, and PPC_CALL2 calls.
    // Returns null on any unsupported node.
    const liftInline = (n) => {
      if (!isArr(n)) return null
      const op = n[0]
      if (op === 'f64.const') return ['f64x2.splat', n]
      if (op === 'local.get' && typeof n[1] === 'string') {
        return substMap.has(n[1]) ? substMap.get(n[1]) : null
      }
      if (op === 'call') {
        const v2 = PPC_CALL2[n[1]]
        if (v2 && n.length === 3) { const a = liftInline(n[2]); return a && ['call', v2, a] }
        if (v2 && n.length === 4) { const a = liftInline(n[2]), b = liftInline(n[3]); return (a && b) ? ['call', v2, a, b] : null }
        return null
      }
      if (LANE_PURE.f64.has(op)) {
        const ks = n.slice(1).map(liftInline)
        return ks.some(k => k === null) ? null : [LANE_PURE.f64.get(op).simd, ...ks]
      }
      return null
    }

    // Walk callee body: local.set stmts define inlined locals; return stmt gives result.
    for (let i = calleeBodyStart; i < callee.length; i++) {
      const stmt = callee[i]
      if (!isArr(stmt)) return null
      if (stmt[0] === 'local.set' && typeof stmt[1] === 'string') {
        const lifted = liftInline(stmt[2])
        if (lifted === null) return null
        substMap.set(stmt[1], lifted)
        continue
      }
      if (stmt[0] === 'return') {
        return liftInline(stmt[1])
      }
      // Any other statement type → bail (impure or unsupported structure).
      return null
    }
    return null  // no return stmt found
  }

  // Lift a scalar f64 expression to f64x2: pixel IV → ramp [v, v+1]; an earlier lane local → its
  // shadow; an invariant (local/global the loop never writes) → splat; transcendental call → the
  // *2 helper; conditional → bitselect; LANE_PURE.f64 op → recurse. null = not liftable (the lift
  // stops here and the rest becomes the scalar epilogue).
  const liftPPC = (n) => {
    if (!isArr(n)) return null
    const op = n[0]
    if (op === 'f64.const') return ['f64x2.splat', n]
    if (op === 'local.get') {
      const v = n[1]
      if (laneMap.has(v)) return ['local.get', laneMap.get(v)]
      if (pxAlias.has(v)) return rampPixelIV(pivType, pxAlias.get(v))
      if (pivType.get(v) === 'f64') return rampPixelIV(pivType, v)
      if (writesName(loopNode, v)) return null
      return ['f64x2.splat', n]
    }
    if (op === 'local.tee') {   // CSE temp inside a lane expr (e.g. `dx` reused as dx*dx) → a v128 tee
      const lifted = liftPPC(n[2])
      if (lifted === null) return null
      const lane = laneMap.get(n[1]) || nm('t' + n[1].replace(/\W/g, ''))
      laneMap.set(n[1], lane)   // later local.get $v in this expr resolves to the tee's lane
      return ['local.tee', lane, lifted]
    }
    if (op === 'global.get') return writesName(loopNode, n[1]) ? null : ['f64x2.splat', n]
    if (op === 'f64.convert_i32_s' && isArr(n[1]) && n[1][0] === 'local.get' && pivType.get(n[1][1]) === 'i32') return rampPixelIV(pivType, n[1][1])
    if (op === 'call') {
      const v2 = PPC_CALL2[n[1]]
      if (v2 && n.length === 3) { const a = liftPPC(n[2]); return a && ['call', v2, a] }
      if (v2 && n.length === 4) { const a = liftPPC(n[2]), b = liftPPC(n[3]); return (a && b) ? ['call', v2, a, b] : null }
      // Pure user-function inline: substitute params with lifted args, walk body.
      if (pureFuncMap && pureFuncMap.has(n[1])) return liftPPCInline(n, liftPPC)
      return null
    }
    if (op === 'if') {   // `cond ? X : Y` (jz lowers to (if (result f64) COND (then X)(else Y))) → bitselect
      if (!isArr(n[1]) || n[1][0] !== 'result' || n[1][1] !== 'f64') return null
      const thenN = n[3], elseN = n[4]
      if (!isArr(thenN) || thenN[0] !== 'then' || thenN.length !== 2) return null
      if (!isArr(elseN) || elseN[0] !== 'else' || elseN.length !== 2) return null
      let cond = n[2]
      if (isArr(cond) && cond[0] === 'i32.ne' && isI32Const(cond[2]) && cond[2][1] === 0) cond = cond[1]
      const cmp = isArr(cond) && cond.length === 3 ? CMP_LANE[cond[0]] : null
      if (!cmp) return null
      const ca = liftPPC(cond[1]), cb = liftPPC(cond[2]), x = liftPPC(thenN[1]), y = liftPPC(elseN[1])
      if (!ca || !cb || !x || !y) return null
      return ['v128.bitselect', x, y, [cmp, ca, cb]]
    }
    if (LANE_PURE.f64.has(op)) {
      const ks = n.slice(1).map(liftPPC)
      return ks.some(k => k === null) ? null : [LANE_PURE.f64.get(op).simd, ...ks]
    }
    return null
  }

  // Classify each body statement: a `local.set $v EXPR` with v an f64 whose EXPR fully lifts is a
  // SIMD lane local (computed once per pair); everything else (the integer pack, the store, an
  // un-liftable call like pow in Phase 1, a recomputed i32 offset) is a scalar EPILOGUE statement,
  // re-run per lane. Lane locals need NOT be a contiguous prefix — `offset = w*y+x` (i32) commonly
  // precedes the f64 work. Processed in source order so a lane local can reference an earlier one;
  // liftPPC returns null on a read of any in-loop value that isn't already a lane local (incl. a
  // later or epilogue local), so the classification self-enforces "lane locals depend only on
  // IVs/invariants/earlier lane locals" — reordering all lane computes ahead of the epilogue is safe.
  const epilogue = []
  for (const s of obody) {
    if (isArr(s) && s[0] === 'local.set' && s.length === 3 && fnLocals.get(s[1]) === 'f64') {
      const before = new Set(laneMap.keys())
      const lifted = liftPPC(s[2])
      if (lifted !== null) { laneMap.set(s[1], nm('l' + s[1].replace(/\W/g, ''))); laneLifted.set(s[1], lifted); continue }
      for (const k of [...laneMap.keys()]) if (!before.has(k)) laneMap.delete(k)   // roll back tee pollution from a failed lift
    }
    epilogue.push(s)
  }
  if (!laneMap.size) return null   // nothing lifted to f64x2
  // HAZARD: a lane local re-written by an epilogue statement leaves its f64x2 shadow STALE.
  // e.g. `let fx=0; if(denom>ε){fx=…}; let mag=hypot(fx,…)` — `fx=0` lifts to a lane local
  // splat(0); the statement-form `if` lands in the scalar epilogue (updates only the SCALAR local),
  // so the lifted `hypot(fx,…)` — emitted BEFORE the epilogue — reads the stale splat(0) → all-zero.
  // Bail ONLY when the stale shadow actually feeds another LANE compute: a lane local whose shadow
  // is CONSUMED by some laneLifted expr and is ALSO reassigned in the epilogue. (A lane local merely
  // extracted for the scalar epilogue — e.g. `gv`, clamped by `if(gv<0)gv=0` then packed — is safe:
  // the clamp runs per-lane after extraction, corrupting no other lane.)
  {
    const consumedShadows = new Set()
    const recordShadow = n => { if (isArr(n) && n[0] === 'local.get' && typeof n[1] === 'string') consumedShadows.add(n[1]) }
    for (const expr of laneLifted.values()) walkAst(expr, { enter: recordShadow })
    const hazard = (n) => isArr(n) && (((n[0] === 'local.set' || n[0] === 'local.tee') && laneMap.has(n[1]) && consumedShadows.has(laneMap.get(n[1]))) || n.slice(1).some(hazard))
    if (epilogue.some(hazard)) return null
  }
  // Only worth the extract overhead if a costly op (a *2 transcendental or f64x2.sqrt) got lifted.
  const heavy = (n) => isArr(n) && ((n[0] === 'call' && /\$math\.(sin2|cos2|pow2|log_v|atan2_2|hypot_2|exp2_2|tan2)/.test(n[1])) || n[0] === 'f64x2.sqrt' || n.some(heavy))
  if (![...laneLifted.values()].some(heavy)) return null   // only cheap arithmetic lifted — not worth it

  // Exactly one i32.store, found anywhere in the epilogue (jz wraps `mem[off]=…` in a `(block …)`).
  let storeStmt = null
  const findStore = n => { if (STORE_OPS[n[0]]) { if (storeStmt) storeStmt = false; else if (storeStmt !== false) storeStmt = n } }
  for (const s of epilogue) walkAst(s, { enter: findStore })
  if (!storeStmt || storeStmt[0] !== 'i32.store') return null   // not exactly one u32 colour store
  // The store cell must differ per lane, i.e. its address must depend on a pixel IV — directly
  // (chladni's `px[j]`) or transitively through an epilogue local (interference's `mem[offset]`,
  // offset=w*y+x). Follow the address's reads through epilogue local definitions to a pixel IV.
  // Walk every child except a set's name slot (a def nested under an `(if … then)` must still be
  // recorded — the n.slice(2)-everywhere form would miss it, conservatively bailing a valid kernel).
  const epiDef = new Map()
  for (const s of epilogue) walkAst(s, { enter: n => { if (n[0] === 'local.set' && typeof n[1] === 'string' && !epiDef.has(n[1])) epiDef.set(n[1], n[2]) } })
  const feedsIV = (n, seen = new Set()) => isArr(n) && (n[0] === 'local.get'
    ? (pivType.has(n[1]) || (epiDef.has(n[1]) && !seen.has(n[1]) && (seen.add(n[1]), feedsIV(epiDef.get(n[1]), seen))))
    : n.some(c => feedsIV(c, seen)))
  if (!feedsIV(storeStmt[1])) return null   // store cell wouldn't vary per lane → can't pair

  // ---- epilogue safety (epilogueIsSafe, hoisted — byte-identical at all 3 outer-pixel call
  // sites): runs scalar per lane (each statement bumped to pixel j+k). It may read a lane local
  // (extracted below), an invariant/pixel-IV, or a value the epilogue itself computes — incl.
  // within-statement tees (e.g. the Infinity-guard temp inside an `(if … |0)` pack). ----
  if (!epilogueIsSafe(epilogue, loopNode, laneMap, pivType)) return null   // reads an in-loop value with no per-lane source
  const epiReads = [...laneMap.keys()].filter(v => epilogue.some(s => readsVar(s, v)))

  // ============================ emit ============================
  const newLocalDecls = [...laneMap.values()].map(n => ['local', n, 'v128'])
  const laneCompute = [...laneLifted.keys()].map(v => ['local.set', laneMap.get(v), laneLifted.get(v)])
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
