
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
import { cloneNode, walkAst } from '../ast.js'
import { _offsetLocalStride, constNum, firstAccess, hasGlobalSet, hasImpureCall, hasSideEffect, isI32Const, isLocalGet, matchInc1, matchIncN, matchLaneAddr } from './vectorize/addr-model.js'
import { hoistReductionInvariantsIn, slpPairsIn } from './vectorize/dot-slp.js'
import { LANE_COMPARE, LANE_PURE, LOAD_OPS, PPC_CALL2, STORE_OPS } from './vectorize/lane-tables.js'
import { liftExprV, liftFail, liftStmt, vecState } from './vectorize/lift.js'
import { tryGeneralMap, tryVectorize } from './vectorize/map.js'
import { forEachLocalDef, isArr } from './vectorize/node-utils.js'
import { CMP_LANE, CMP_NEG, bumpPixelIV, epilogueIsSafe, matchOuterPixelLoop, rampPixelIV, readsVar, writesName } from './vectorize/outer-scaffold.js'
import { tryGeneralReduce, tryReduce } from './vectorize/reduce.js'
import { canonicalizeIfBr, foldVecIdentities, matchBlockLoop, normalizeTransparentBlocks } from './vectorize/scaffold.js'
import { tryGeneralStencil, tryStencil } from './vectorize/stencil.js'
import { tryStrengthReduceIV } from './vectorize/strength-reduce.js'
export { inlinePureCallExpr, inlinePureFnsInFn } from './vectorize/inline-pure.js'
export { SIMD_PINNED } from './vectorize/lane-tables.js'

const MEMOP_STORES = {
  'f64.store':   { k: 3, loads: new Set(['f64.load']) },
  'i64.store':   { k: 3, loads: new Set(['i64.load']) },
  'f32.store':   { k: 2, loads: new Set(['f32.load']) },
  'i32.store':   { k: 2, loads: new Set(['i32.load']) },
  'i32.store16': { k: 1, loads: new Set(['i32.load16_u', 'i32.load16_s']) },
  'i32.store8':  { k: 0, loads: new Set(['i32.load8_u', 'i32.load8_s']) },
}

/**
 * Replace whole copy/fill loops with the engine's bulk-memory ops:
 *
 *   for (i < N) a[i] = b[i]   →  memory.copy (overlap-guarded)
 *   for (i < N) a[i] = 0      →  memory.fill 0    (any element width)
 *   for (i < N) u8[i] = C     →  memory.fill C    (byte stores only)
 *
 * V8 lowers memory.copy/fill to memmove/memset — typically several times the
 * throughput of even a SIMD lane loop, and a handful of bytes instead of one.
 * Runs BEFORE the lane vectorizer so these loops never pay the lift.
 *
 * Exactness:
 *  - COPY moves the same byte window the scalar loop wrote (same-width
 *    store←load pairs only — see MEMOP_STORES; f64 load/store round-trips are
 *    bit-exact per spec, so NaN payloads survive). memory.copy is memmove
 *    (as-if-buffered); the FORWARD loop differs from that exactly when the
 *    destination starts strictly inside the source window (dst reads bytes an
 *    earlier iteration already overwrote), so that case keeps the original
 *    loop behind a two-compare runtime guard — every other layout (disjoint,
 *    dst ≤ src, same array) is bit-identical.
 *  - FILL with 0 is width-agnostic (all-zero bytes; −0.0 is excluded — its
 *    sign bit is not zero). Non-zero fills only for byte stores with a
 *    loop-invariant constant ∈ [0,255].
 *  - The induction variable ends at `bound` exactly as the loop would leave
 *    it; a zero-trip range (i ≥ bound) leaves everything untouched.
 *  - In-bounds for the same reason the lane vectorizer's wide loads are: the
 *    moved window is exactly the byte range the scalar iterations touch.
 */
function tryMemCopyFill(bl, fnLocals, freshIdRef) {
  if (!bl || bl.preamble.length) return null   // no-preamble policy (was allowPreamble:false)
  const { loopNode, incVar, bound } = bl
  // Shape: [loop, $l, boundExit, (set,)? store, inc, br] — 1- or 2-statement body.
  if (loopNode.length !== 6 && loopNode.length !== 7) return null
  // Bound: const or an invariant local that is not the IV itself.
  if (!(isI32Const(bound) || (isArr(bound) && bound[0] === 'local.get' && typeof bound[1] === 'string' && bound[1] !== incVar))) return null

  // Body shapes (emit produces the two-statement form with a temp + shared
  // offset tee; fold/propagate sometimes collapse it to the bare store):
  //   1-stmt:  (T.store DADDR  CONST | (T.load SADDR))
  //   2-stmt:  (local.set $t (T.load SADDR)) (T.store DADDR (local.get $t))
  const addrLocals = new Map(), offsetTees = new Map()
  const laneAddr = (a) => {
    const m = matchLaneAddr(a, incVar, addrLocals, offsetTees)
    if (!m || m.viaLocal) return null
    if (m.offsetTeeName) offsetTees.set(m.offsetTeeName, m.strideLog2)
    if (!(isArr(m.base) && m.base[0] === 'local.get' && typeof m.base[1] === 'string' && m.base[1] !== incVar)) return null
    if (fnLocals.get(m.base[1]) !== 'i32') return null
    return m
  }
  let storeStmt, valNode, tempName = null
  if (loopNode.length === 6) {
    storeStmt = loopNode[3]
    if (!isArr(storeStmt) || storeStmt.length !== 3) return null
    valNode = storeStmt[2]
  } else {
    const s1 = loopNode[3]
    storeStmt = loopNode[4]
    if (!isArr(s1) || s1[0] !== 'local.set' || s1.length !== 3 || typeof s1[1] !== 'string') return null
    if (!isArr(storeStmt) || storeStmt.length !== 3) return null
    if (!(isArr(storeStmt[2]) && storeStmt[2][0] === 'local.get' && storeStmt[2][1] === s1[1])) return null
    tempName = s1[1]
    if (tempName === incVar) return null
    valNode = s1[2]
  }
  const entry = MEMOP_STORES[storeStmt[0]]
  if (!entry) return null

  // Classify VALUE first (the load side carries the offset tee in the 2-stmt form).
  let fillByte = null, srcM = null
  if (isArr(valNode) && valNode.length === 2 && (valNode[0] === 'i32.const' || valNode[0] === 'i64.const' || valNode[0] === 'f64.const' || valNode[0] === 'f32.const') && typeof valNode[1] === 'number') {
    if (valNode[1] === 0 && !Object.is(valNode[1], -0)) fillByte = 0
    else if (storeStmt[0] === 'i32.store8' && valNode[0] === 'i32.const' && Number.isInteger(valNode[1]) && valNode[1] >= 0 && valNode[1] <= 255) fillByte = valNode[1]
    else return null
  } else if (isArr(valNode) && valNode.length === 2 && entry.loads.has(valNode[0])) {
    srcM = laneAddr(valNode[1])
    if (!srcM || srcM.strideLog2 !== entry.k) return null
  } else return null

  const dstM = laneAddr(storeStmt[1])
  if (!dstM || dstM.strideLog2 !== entry.k) return null
  // Soundness for any shared offset tee resolved via `(local.get $T)` (see tryVectorize).
  for (const [name, k] of offsetTees) {
    if (_offsetLocalStride([loopNode[3], storeStmt], name, incVar) !== k) return null
  }

  const id = freshIdRef.next++
  const lenB = `$__mc${id}_len`, dstA = `$__mc${id}_dst`
  const newLocalDecls = [['local', lenB, 'i32'], ['local', dstA, 'i32']]
  const shl = (x) => entry.k === 0 ? x : ['i32.shl', x, ['i32.const', entry.k]]
  const boundC = () => cloneNode(bound)
  const setup = [
    ['local.set', lenB, shl(['i32.sub', boundC(), ['local.get', incVar]])],
    ['local.set', dstA, ['i32.add', ['local.get', dstM.base[1]], shl(['local.get', incVar])]],
  ]
  // Exact loop-exit state: i ends at bound; a matched offset tee holds the
  // LAST iteration's offset; the value temp holds the last element moved.
  const finish = [['local.set', incVar, boundC()]]
  const lastOff = () => shl(['i32.sub', boundC(), ['i32.const', 1]])
  for (const name of offsetTees.keys()) finish.push(['local.set', name, lastOff()])
  if (tempName != null && srcM) finish.push(['local.set', tempName,
    [valNode[0], ['i32.add', ['local.get', srcM.base[1]], lastOff()]]])
  if (tempName != null && srcM == null) finish.push(['local.set', tempName, cloneNode(valNode)])

  let action
  if (srcM == null) {
    action = [['memory.fill', ['local.get', dstA], ['i32.const', fillByte], ['local.get', lenB]], ...finish]
  } else {
    const srcA = `$__mc${id}_src`
    newLocalDecls.push(['local', srcA, 'i32'])
    setup.push(['local.set', srcA, ['i32.add', ['local.get', srcM.base[1]], shl(['local.get', incVar])]])
    // Forward-loop ≡ memmove unless dst starts strictly inside (src, src+len).
    action = [['if',
      ['i32.or',
        ['i32.le_u', ['local.get', dstA], ['local.get', srcA]],
        ['i32.ge_u', ['local.get', dstA], ['i32.add', ['local.get', srcA], ['local.get', lenB]]]],
      ['then',
        ['memory.copy', ['local.get', dstA], ['local.get', srcA], ['local.get', lenB]],
        ...finish],
      ['else', bl.blockNode]]]
  }

  const wrapper = ['block',
    ['if', ['i32.lt_s', ['local.get', incVar], boundC()],
      ['then', ...setup, ...action]]]
  return { wrapper, newLocalDecls }
}

// ---- Channel-reduction recognizer (RGBA box-filter accumulation) -----------
//
// The image-convolution hot shape: 4 adjacent-byte accumulators summed over a
// window, then divided + stored — `for k: sr+=src[p]; sg+=src[p+1]; …` (blur,
// box filters, separable convolutions). The 4 channels are 4 i32x4 lanes, the
// 4-byte load is one widening v128.load32_zero. We vectorize ONLY the inner
// accumulation (integer add → associative/exact → bit-identical) and extract the
// lane sums back to the scalars; the edge-clamp address math and the per-pixel
// divide+store stay scalar, untouched. So no float-reduction reordering, no
// lane-juggled divide — just the dense inner loop lifted, safely.
//
// Operates on the OUTER pixel-loop block: its body is [exit, 4×(acc=0), …setup,
// (block (loop INNER)), …uses-of-acc, inc, br]. INNER's body accumulates the 4
// channels off a shared base address.

// Match `(local.set $ACC (i32.add (local.get $ACC) (i32.load8_u ADDR)))` where
// ADDR is `(local.get $base)` or `(local.tee $base EXPR)` at byte offset `off`.
// Returns { acc, base, off, teeExpr? } or null.
function matchChannelAccum(stmt, off) {
  if (!isArr(stmt) || stmt[0] !== 'local.set' || stmt.length !== 3) return null
  const acc = stmt[1]
  const add = stmt[2]
  if (!isArr(add) || add[0] !== 'i32.add' || add.length !== 3) return null
  if (!isLocalGet(add[1], acc)) return null
  const load = add[2]
  if (!isArr(load) || load[0] !== 'i32.load8_u') return null
  // memarg offset: bare load → off 0; `i32.load8_u offset=N addr` → off N.
  let addr = load[1], loadOff = 0
  if (typeof load[1] === 'string' && /^offset=/.test(load[1])) { loadOff = +load[1].slice(7); addr = load[2] }
  if (loadOff !== off) return null
  if (isArr(addr) && addr[0] === 'local.tee' && addr.length === 3) return { acc, base: addr[1], off, teeExpr: addr[2] }
  if (isLocalGet(addr)) return { acc, base: addr[1], off }
  return null
}

// Recognize, inside the inner loop body, four consecutive channel accumulations
// `acc0+=base[0]; acc1+=base[1]; acc2+=base[2]; acc3+=base[3]` over ONE shared
// base. Returns { accs:[a0..a3], baseLocal, teeExpr, idx } (idx = position of the
// first accum stmt in `body`) or null.
function matchChannelGroup(body) {
  for (let i = 0; i + 3 < body.length; i++) {
    const m0 = matchChannelAccum(body[i], 0)
    if (!m0 || m0.teeExpr == null) continue   // first load carries the address tee
    const ms = [m0]
    let ok = true
    for (let c = 1; c < 4; c++) {
      const m = matchChannelAccum(body[i + c], c)
      if (!m || m.base !== m0.base || m.teeExpr != null) { ok = false; break }
      ms.push(m)
    }
    if (!ok) continue
    const accs = ms.map(m => m.acc)
    if (new Set(accs).size !== 4) continue   // four distinct accumulators
    return { accs, baseLocal: m0.base, teeExpr: m0.teeExpr, idx: i }
  }
  return null
}

// Class-A hoist (.work/research.md §BodyModel §1a/§5 slice 3): the init+inner-loop-locate scan
// tryBlurMultiPixel and tryChannelReduce each ran over their pixel-loop body — locate four
// consecutive `acc_c = 0` inits, then the `(block (loop))` immediately after them, then the
// channel-accumulation group inside it via matchChannelGroup, then verify the summed
// accumulators are exactly the four zero-inited ones. Functionally identical between the two
// callers (tryChannelReduce's z-push carried one extra `typeof s[1] === 'string'` guard that's
// always true for a `local.set`'s name slot — dead, not a behavior difference; the shared version
// below keeps it, matching the codebase's prevailing name-narrowing convention). Returns
// `{ initIdx, accInits, innerIdx, innerBlock, innerLoop, ilEnd, innerBody, grp }` or `null`.
function matchChannelReducePixelLoop(loopNode, bodyStart, bodyEnd) {
  // four `acc_c = 0` inits, consecutive
  let initIdx = -1, accInits = null
  for (let i = bodyStart; i + 3 <= bodyEnd; i++) {
    const z = []
    for (let c = 0; c < 4; c++) {
      const s = loopNode[i + c]
      if (isArr(s) && s[0] === 'local.set' && s.length === 3 && isI32Const(s[2]) && constNum(s[2]) === 0 && typeof s[1] === 'string') z.push(s[1])
      else break
    }
    if (z.length === 4 && new Set(z).size === 4) { initIdx = i; accInits = z; break }
  }
  if (initIdx < 0) return null

  // the inner accumulation loop: the (block (loop)) appearing after the inits
  let innerIdx = -1, innerBlock = null
  for (let i = initIdx + 4; i <= bodyEnd; i++) {
    const s = loopNode[i]
    if (isArr(s) && s[0] === 'block' && s.slice(1).some(c => isArr(c) && c[0] === 'loop')) { innerIdx = i; innerBlock = s; break }
    if (isArr(s) && s[0] === 'loop') { innerIdx = i; innerBlock = ['block', s]; break }
  }
  if (!innerBlock) return null
  const innerLoop = innerBlock.find(c => isArr(c) && c[0] === 'loop')
  if (!innerLoop) return null
  const ilEnd = innerLoop.length - 1
  if (!(isArr(innerLoop[ilEnd]) && innerLoop[ilEnd][0] === 'br')) return null
  const innerBody = innerLoop.slice(3, ilEnd - 1)

  const grp = matchChannelGroup(innerBody)
  if (!grp) return null
  // the four channels summed must be exactly the four that were zero-inited (any order)
  if (grp.accs.slice().sort().join('\x00') !== accInits.slice().sort().join('\x00')) return null

  return { initIdx, accInits, innerIdx, innerBlock, innerLoop, ilEnd, innerBody, grp }
}

// ---- Byte-map recognizer (ramp + widening loads) ---------------------------
//
// Vectorize `for (i = 0; i < N; i++) out[i] = NARROW(f_i32(…))` where the i32
// value is built from the induction variable used AS DATA (an i32x4 RAMP
// `[i, i+1, i+2, i+3]`) and/or WIDENED narrow loads (`u8[i]` zero-extended to
// i32x4). tryVectorize can't express either: it derives the lane type from an
// input load and ties the compute width to it, so a byte LUT-free map whose
// arithmetic overflows a byte (mul, shifts) — or that has no load at all —
// falls through to here, where everything lifts to i32x4 and narrow-stores.
//   • pure ramp (no loads, i8 store) → 16-wide pack (bytebeat)
//   • widening u8 loads → 4-wide (alpha blend, brightness/color/threshold)
//
// Matches the post-strength-reduction shape (the IV strength-reducer runs
// before this pass): the loop carries the logical IV (`i`, in the exit test,
// += 1) plus one or more strided output pointers (`p += C`). Each increment is
// scaled by LANES; the store narrows i32x4 back to the element width.
//
// Narrowing is truncation-exact for ANY i32 value (matching scalar store8/16):
// `i8x16.shuffle` selects the low byte of each lane — never saturates — so no
// value-range assumption is needed.
function tryRampMap(blockNode, fnLocals, freshIdRef) {
  // Strict envelope (identical to tryVectorize's) + trailing RUN of increments; the "every
  // increment shares the IV's name" check below is tryRampMap's own residual.
  const bl = matchBlockLoop(blockNode, { multiInc: true })
  if (!bl) return null
  const { incVar: ivName, bound, boundLocal, body, increments, hasGlobalSet: blHasGlobalSet, writes: blWrites, referenced: blReferenced, offsetTees } = bl
  // BodyModel fact (bl.offsetTees — see offsetTeesFromAddrTable, bl.addrTable's offset-kind
  // subset, computed once at the dispatch); combines below with this recognizer's own private
  // recordAddrTees map (genuinely private per the design's terminal verdict).
  if (!boundLocal && !isI32Const(bound)) return null
  if (!body.length) return null
  if (blHasGlobalSet) return null

  // Find exactly one store. Its address is the inline lane address
  // `base + (i << K)` — the IV strength-reducer runs AFTER this pass, so the
  // pointer is still expressed in terms of the IV. We keep the address verbatim
  // (scalar i32) and advance the IV by LANES, so `base + (i<<K)` lands on the
  // next group's first element each SIMD step — for any element width.
  // Collect every store. One store → the original single-map paths (ramp pack / widening /
  // 4-wide). Two or more independent store8s → a multi-channel in-place fade (boids' 4-channel
  // u8 trail), handled by the multi-store WIDEN16 branch below; one pass over memory, N widening
  // stores. Stores beyond the first don't reach the single-store paths.
  const storeStmts = []
  for (let i = 0; i < body.length; i++) {
    const s = body[i]
    if (isArr(s) && STORE_OPS[s[0]]) storeStmts.push({ stmt: s, idx: i })
  }
  if (!storeStmts.length) return null
  const storeStmt = storeStmts[0].stmt, storeIdx = storeStmts[0].idx
  const storeOp = storeStmt[0]
  if (storeStmt.length !== 3) return null
  const elemLog2 = { 'i32.store8': 0, 'i32.store': 2 }[storeOp]
  if (elemLog2 === undefined) return null
  if (increments.some(x => x.name !== ivName)) return null

  // CSE'd lane offsets: a local written ONLY as `i << K` (or bare `i`) is the
  // shared offset the IV stage threads across base pointers (src[i], dst[i],
  // out[i] all reuse one `(local.tee $p (local.get i))`). Resolve them so the
  // load/store address matchers accept the `(local.get $p)` reuses. BodyModel fact
  // (bl.offsetTees, destructured above).

  // CSE'd FULL lane address: an in-place map `a[i] = f(a[i])` shares one `(local.tee $A
  // (i32.add base i))` between the load and the store, reused as `(local.get $A)`. Without
  // resolving it the store/load address matchers reject the bare get (the empty-addrLocals
  // bug that kept every in-place trail-fade scalar). Record each such tee — its lifted
  // address (the tee) runs in the hoisted v128.load, so the store's get reads it back.
  const addrLocals = new Map()
  const recordAddrTees = n => {
    if (n[0] === 'local.tee' && typeof n[1] === 'string' && isArr(n[2]) && n[2][0] === 'i32.add') {
      const m = matchLaneAddr(n[2], ivName, addrLocals, offsetTees)
      if (m && m.teeName == null) addrLocals.set(n[1], { strideLog2: m.strideLog2, base: m.base })
    }
  }
  for (const s of body) walkAst(s, { enter: recordAddrTees })

  const storeAddr = storeStmt[1]
  const addrM = matchLaneAddr(storeAddr, ivName, addrLocals, offsetTees)
  if (!addrM || addrM.strideLog2 !== elemLog2) return null

  // Memory loads turn this into a widening byte-map: out[i] = narrow(f(widen(a[i])…)).
  // Only the u8 shape is supported — every load must be a narrow UNSIGNED u8 load
  // of the same 4 elements the store writes (base + i; the IV strength-reducer
  // runs later). Full-width i32 maps are tryVectorize's job; mixed widths bail.
  let hasLoads = false, loadsOk = true
  const checkLoad = (n) => {
    if (!isArr(n)) return
    if (LOAD_OPS[n[0]]) {
      hasLoads = true
      if (storeOp !== 'i32.store8' || n[0] !== 'i32.load8_u') { loadsOk = false; return }
      const m = matchLaneAddr(n[1], ivName, addrLocals, offsetTees)
      if (!m || m.strideLog2 !== 0) loadsOk = false
      return  // address validated; the IV-strided subtree is not data
    }
    for (let i = 1; i < n.length; i++) checkLoad(n[i])
  }
  for (const s of body) checkLoad(s)
  if (!loadsOk) return null

  // Every other body stmt must be `(local.set $lane EXPR)` — straight-line lane
  // locals feeding the store. Classify locals for the lift (writes/referenced: plan-level census).
  const writes = blWrites
  if (boundLocal && writes.has(boundLocal)) return null
  const referenced = blReferenced

  const localKind = new Map()
  for (const name of referenced) {
    if (name === ivName) continue
    if (writes.has(name)) {
      let firstKind = null
      for (const s of body) { const kAcc = firstAccess(s, name); if (kAcc) { firstKind = kAcc; break } }
      if (firstKind === 'read') return null   // loop-carried → reduction/stencil, not a pure map
      localKind.set(name, 'lane')
    } else {
      localKind.set(name, 'invariant')
    }
  }

  // Lift. lane type is always i32 (the ramp and all narrow stores compute in i32).
  const newLanedLocals = new Map()
  const extraLocals = []
  const freshV128 = (tag) => { const n = `$__${tag}${freshIdRef.next++}`; extraLocals.push(['local', n, 'v128']); return n }
  const ctx = { laneType: 'i32', incVar: ivName, rampVar: ivName, rampTemp: null, widenLoads: true, localKind, fnLocals: null, newLanedLocals, extraLocals, freshIdRef, fail: false, failReason: null }

  // A byte store fed by one value expression (inline, or via a single lane-local
  // temp `tw = EXPR; store(addr, tw)`) carries no loop-carried state, so we can
  // run the lane group 4× (16 samples) per iteration off four offset ramps and
  // pack the low bytes into ONE i8x16 v128.store — amortizing store + loop
  // overhead the way clang/zig's 16-wide NEON does. wideValueExpr is the
  // expression to lift per offset; null (i32 stores, multi-stmt bodies, or
  // widening loads — whose addresses would need per-offset advancing) → 4-wide.
  // The single byte-value expression feeding the store — inline, or via one lane-local
  // temp `tw = EXPR; store(addr, tw)`. Shared by both 16-wide paths below.
  const byteValueExpr = (() => {
    if (storeOp !== 'i32.store8') return null
    if (body.length === 1 && storeIdx === 0) return storeStmt[2]
    if (body.length === 2 && storeIdx === 1) {
      const set = body[0], sv = storeStmt[2]
      if (isArr(set) && set[0] === 'local.set' && set.length === 3 &&
          isLocalGet(sv, set[1]) && localKind.get(set[1]) === 'lane') return set[2]
    }
    return null
  })()
  // With u8 loads, the byte map can go 16-wide in i16x8 (the alpha-blend shape: out[i] =
  // (src[i]*A + dst[i]*B + bias) >> s) — load 16, extend_low/high, the affine arithmetic
  // in i16x8, byte-pack, store 16. Sound ONLY when every
  // intermediate provably fits u16 ([0,65535], so i16x8 mod-2^16 never wraps and shr_u ==
  // the scalar shr_s on a non-negative value) and the result fits a byte ([0,255], so
  // byte selection is exact). `byteValueRange` returns [min,max] or null when any node
  // is unanalyzable, can go negative, or exceeds u16. An invariant local of unknown
  // magnitude (local.get) → null → falls back to the bit-exact 4-wide path.
  const byteValueRange = (e) => {
    if (!isArr(e)) return null
    const op = e[0]
    let r
    if (op === 'i32.const') { const v = constNum(e); r = [v, v] }
    else if (op === 'i32.load8_u') r = [0, 255]
    else if (op === 'i32.add') { const a = byteValueRange(e[1]), b = byteValueRange(e[2]); if (!a || !b) return null; r = [a[0] + b[0], a[1] + b[1]] }
    else if (op === 'i32.sub') { const a = byteValueRange(e[1]), b = byteValueRange(e[2]); if (!a || !b) return null; r = [a[0] - b[1], a[1] - b[0]] }
    else if (op === 'i32.mul') { const a = byteValueRange(e[1]), b = byteValueRange(e[2]); if (!a || !b) return null; const p = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]]; r = [Math.min(...p), Math.max(...p)] }
    else if ((op === 'i32.shr_u' || op === 'i32.shr_s') && isI32Const(e[2])) { const a = byteValueRange(e[1]); if (!a || a[0] < 0) return null; const s = constNum(e[2]); if (s < 0 || s > 16) return null; r = [a[0] >> s, a[1] >> s] }
    else if (op === 'i32.and' && isI32Const(e[2])) { const a = byteValueRange(e[1]); if (!a) return null; const m = constNum(e[2]); if (m < 0) return null; r = [0, Math.min(a[1], m)] }
    else return null
    return (r[0] < 0 || r[1] > 65535) ? null : r
  }
  // The i16x8 widening byte-map emit for ONE store, factored so a multi-channel fade reuses it
  // per channel: load each u8 input once (v128.load 16), extend_low/high to two i16x8 halves,
  // run the affine map in i16x8 on each half, pack to i8x16, store 16. Each load is hoisted
  // (extend_low + extend_high share one load); loads run in source order, so an offset/address
  // `local.tee` in a load is set before the store's `local.get` reads it.
  const packWiden16 = (low, high) => {
    // `(u16Expr >> 8) & 255` is the HIGH byte of each u16 lane. Select it
    // directly instead of materializing the shifts. Portable Wasm has no
    // non-saturating add-high-narrow op, but this removes two vector shifts and
    // gives native backends one byte-deinterleave to select. Other proven byte
    // results select the low byte as before.
    const highByte = low[0] === 'i16x8.shr_u' && high[0] === 'i16x8.shr_u' &&
      isI32Const(low[2]) && constNum(low[2]) === 8 && isI32Const(high[2]) && constNum(high[2]) === 8
    if (highByte) { low = low[1]; high = high[1] }
    const b = highByte ? 1 : 0
    return ['i8x16.shuffle',
      String(b), String(b + 2), String(b + 4), String(b + 6),
      String(b + 8), String(b + 10), String(b + 12), String(b + 14),
      String(16 + b), String(18 + b), String(20 + b), String(22 + b),
      String(24 + b), String(26 + b), String(28 + b), String(30 + b), low, high]
  }
  const widen16Plan = (sAddr, valueExpr, byteOffset = 0) => {
    const loadTemps = new Map()
    const loadSets = []
    const at = (addr) => byteOffset
      ? ['i32.add', cloneNode(addr), ['i32.const', byteOffset]]
      : cloneNode(addr)
    const collectLoads = (e) => {
      if (!isArr(e)) return
      if (e[0] === 'i32.load8_u') {
        const k = JSON.stringify(e[1])
        if (!loadTemps.has(k)) { const t = freshV128('win'); loadTemps.set(k, t); loadSets.push(['local.set', t, ['v128.load', at(e[1])]]) }
      } else for (let i = 1; i < e.length; i++) collectLoads(e[i])
    }
    collectLoads(valueExpr)
    const liftW = (e, half) => {
      const op = e[0]
      if (op === 'i32.const') return ['i16x8.splat', e]
      if (op === 'i32.load8_u') return [`i16x8.extend_${half}_i8x16_u`, ['local.get', loadTemps.get(JSON.stringify(e[1]))]]
      if (op === 'i32.add') return ['i16x8.add', liftW(e[1], half), liftW(e[2], half)]
      if (op === 'i32.sub') return ['i16x8.sub', liftW(e[1], half), liftW(e[2], half)]
      if (op === 'i32.mul') return ['i16x8.mul', liftW(e[1], half), liftW(e[2], half)]
      if (op === 'i32.shr_u' || op === 'i32.shr_s') return ['i16x8.shr_u', liftW(e[1], half), e[2]]
      if (op === 'i32.and') return ['v128.and', liftW(e[1], half), ['i16x8.splat', e[2]]]
      return null   // byteValueRange already proved every op is one of the above
    }
    const addr = at(sAddr)
    const low = liftW(valueExpr, 'low'), high = liftW(valueExpr, 'high')
    // byteValueRange proved every shifted result in [0,255], so selecting each
    // i16 lane's low byte is exact. A saturating narrow states a stronger,
    // unnecessary operation and blocks native backends from selecting fused
    // shift/add+narrow instructions.
    return { loads: loadSets, addr, low, high,
      body: [['v128.store', addr, packWiden16(low, high)]] }
  }
  const widen16Emit = (sAddr, valueExpr, byteOffset = 0) => {
    const p = widen16Plan(sAddr, valueExpr, byteOffset)
    return [...p.loads, ...p.body]
  }

  let lifted, LANES
  if (storeStmts.length > 1) {
    // MULTI-CHANNEL in-place byte fade: N independent store8s in one loop (boids' 4-channel u8
    // trail). Each store must be a u8 store of a WIDEN16-eligible value (range ≤ 255); it emits
    // its own load→i16x8→narrow→store sequence, all concatenated into ONE 16-wide pass — so the
    // memory traffic stays single-pass (vs N separate vectorized loops). Every body statement
    // must be a store or the lane-local set feeding one; any other (shared/invariant) compute
    // bails to scalar, since it would be dropped.
    LANES = 16
    lifted = []
    const consumed = new Set()
    for (const { stmt, idx } of storeStmts) {
      if (stmt[0] !== 'i32.store8' || stmt.length !== 3) return null
      const a = matchLaneAddr(stmt[1], ivName, addrLocals, offsetTees)
      if (!a || a.strideLog2 !== 0) return null
      consumed.add(idx)
      let val = stmt[2]
      if (isArr(val) && val[0] === 'local.get' && typeof val[1] === 'string' && localKind.get(val[1]) === 'lane') {
        let setIdx = -1
        for (let j = 0; j < idx; j++) { const s = body[j]; if (isArr(s) && s[0] === 'local.set' && s[1] === val[1] && s.length === 3) { setIdx = j; val = s[2] } }
        if (setIdx < 0) return null
        consumed.add(setIdx)
      }
      const rng = byteValueRange(val)
      if (!rng || rng[1] > 255) return null   // not WIDEN16-eligible (overflows u16 or u8) → scalar
      lifted.push(...widen16Emit(stmt[1], val))
    }
    if (consumed.size !== body.length) return null
  } else {
    const wideValueExpr = (!hasLoads && byteValueExpr) ? byteValueExpr : null   // pure ramp → 16-wide pack
    const widenRange = (hasLoads && byteValueExpr) ? byteValueRange(byteValueExpr) : null
    const WIDEN16 = widenRange != null && widenRange[1] <= 255   // result fits a byte ⇒ byte-pack exact
    const WIDE16 = wideValueExpr != null
    LANES = (WIDE16 || WIDEN16) ? 16 : 4
    const ramp = (off) => ['i32x4.add', ['i32x4.splat', ['local.get', ivName]],
      ['v128.const', 'i32x4', String(off), String(off + 1), String(off + 2), String(off + 3)]]

    if (WIDEN16) {
      // wasm2c preserves Wasm's structured back-edge, which keeps clang from
      // applying its native multi-vector unroller. Schedule four independent
      // vectors here: one loop trip handles a cache-line-sized 64-byte span,
      // exposing the same memory-level parallelism as clang's scalar→NEON/AVX
      // path. The aligned SIMD bound plus the untouched scalar loop below cover
      // every remainder exactly, including spans shorter than 64 bytes.
      LANES = 64
      const plans = []
      for (let off = 0; off < LANES; off += 16) plans.push(widen16Plan(storeAddr, byteValueExpr, off))
      // Keep all group inputs live together. Without this phase split, watr
      // correctly coalesces each non-overlapping temp into one local and the C
      // backend sees four serial chains. Overlapping the load lifetimes forces
      // independent v128 values and lets the native scheduler interleave them.
      lifted = plans.flatMap(p => p.loads).concat(plans.flatMap(p => p.body))
    } else if (WIDE16) {
      lifted = []
      const vv = []
      for (let j = 0; j < 4; j++) {
        const rt = freshV128('ramp')
        lifted.push(['local.set', rt, ramp(j * 4)])
        ctx.rampTemp = rt
        const v = liftExprV(wideValueExpr, ctx)
        if (ctx.fail) return null
        const vn = freshV128('rampv')
        lifted.push(['local.set', vn, v])
        vv.push(vn)
      }
      // Pack the low byte of all 16 i32 lanes (4 vectors) into one i8x16, in order.
      const g = (n) => ['local.get', n]
      const sh = (a, b, idx) => ['i8x16.shuffle', ...idx.map(String), a, b]
      const lo = freshV128('ramplo'), hi = freshV128('ramphi')
      lifted.push(['local.set', lo, sh(g(vv[0]), g(vv[1]), [0, 4, 8, 12, 16, 20, 24, 28, 0, 0, 0, 0, 0, 0, 0, 0])])
      lifted.push(['local.set', hi, sh(g(vv[2]), g(vv[3]), [0, 4, 8, 12, 16, 20, 24, 28, 0, 0, 0, 0, 0, 0, 0, 0])])
      lifted.push(['v128.store', storeAddr, sh(g(lo), g(hi), [0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23])])
    } else {
      ctx.rampTemp = freshV128('ramp')
      // ramp = [i, i+1, i+2, i+3], computed once per SIMD iteration.
      lifted = [['local.set', ctx.rampTemp, ramp(0)]]
      for (let i = 0; i < body.length; i++) {
        if (i === storeIdx) {
          const vval = liftExprV(storeStmt[2], ctx)
          if (ctx.fail) return null
          lifted.push(buildRampStore(storeOp, storeAddr, vval, ctx))
        } else {
          const r = liftStmt(body[i], ctx)
          if (ctx.fail) return null
          if (r != null) { if (Array.isArray(r) && r[0] === '__seq__') lifted.push(...r.slice(1)); else lifted.push(r) }
        }
      }
    }
  }
  if (!lifted || !lifted.length) return null

  const id = freshIdRef.next++
  const simdBoundName = `$__simd_bound${id}`
  const simdBrkLabel = `$__simd_brk${id}`
  const simdLoopLabel = `$__simd_loop${id}`
  const boundExpr = boundLocal ? ['local.get', boundLocal] : bound

  const scaledIncs = increments.map(({ name, c }) =>
    ['local.set', name, ['i32.add', ['local.get', name], ['i32.const', c * LANES]]])

  const simdBlock = ['block', simdBrkLabel,
    ['loop', simdLoopLabel,
      ['br_if', simdBrkLabel, ['i32.eqz', ['i32.lt_s', ['local.get', ivName], ['local.get', simdBoundName]]]],
      ...lifted,
      ...scaledIncs,
      ['br', simdLoopLabel]]]
  // span-aligned (same entry≠0 hazard as tryVectorize's bound — see there)
  const boundSetup = ['local.set', simdBoundName,
    ['i32.add', ['local.get', ivName],
      ['i32.and', ['i32.sub', boundExpr, ['local.get', ivName]], ['i32.const', -LANES]]]]
  const wrapper = ['block', boundSetup, simdBlock, blockNode]
  const newLocalDecls = [
    ['local', simdBoundName, 'i32'],
    ...[...newLanedLocals.values()].map(laneName => ['local', laneName, 'v128']),
    ...extraLocals,
  ]
  return { wrapper, newLocalDecls }
}

// Build the store for a ramp-map iteration: i32x4 `vval` → element width of
// `storeOp` at scalar address `addr`. i32.store is the full vector; i32.store8
// truncates (low byte of each lane) via i8x16.shuffle — exactly matching scalar
// store8, with no value-range assumption (shuffle selects, never saturates).
// Narrowing-map store: pack a wider float lane vector `val` down to a narrower
// store element and write the low bytes (extract_lane 0 + scalar store, like
// buildRampStore). f64→f32 demotes (bit-exact vs scalar); f64→i32 truncates;
// f32→i16/i8 truncate to i32x4 then WRAP via i8x16.shuffle (low bytes = scalar
// store{8,16}, never saturates). Returns the store stmt or null (unsupported).
// Peel the scalar narrowing conversion off a store value, returning the inner float
// expr to lift (narrowStore then applies the SIMD narrow). f32 store: f32.demote_f64(X).
// int store: toI32's guarded select, wrapIntIR's ToIntN select (module/typedarray.js),
// or a bare trunc_sat. The inner X is the f64/f32 lane value computed before the cast.

function buildRampStore(storeOp, addr, vval, ctx) {
  if (storeOp === 'i32.store') return ['v128.store', addr, vval]   // 4 i32 lanes → 16 bytes
  // i32.store8: hoist vval to a temp so the shuffle reads it once; low byte of
  // each of 4 lanes → bytes 0..3 → one i32.store (4 bytes). Shuffle lane indices
  // are string tokens for watr's binary encoder.
  const tmp = `$__rampv${ctx.freshIdRef.next++}`
  ctx.extraLocals.push(['local', tmp, 'v128'])
  const g = ['local.get', tmp]
  const packed = ['i8x16.shuffle', ...[0, 4, 8, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0].map(String), g, g]
  return ['block', ['local.set', tmp, vval], ['i32.store', addr, ['i32x4.extract_lane', 0, packed]]]
}

// Pivot-stride analysis for the multi-pixel lift. The lift reads 16 source bytes
// (4 RGBA pixels) with ONE v128.load at the address for output pixel `pivot`, so the
// 4 outputs are correct ONLY if consecutive output pixels read consecutive source
// pixels — the load address must advance by EXACTLY 4 bytes per pivot step. Build, in
// program order, each local's value-delta per unit-pivot increment (`pivot` → 1, every
// other local → its assigned expr's delta, unknown/outer locals → 0 = pivot-invariant).
// `delta(e)` returns that constant byte-delta, or null when the dependence is non-
// constant (e.g. x*k) or uses an op we don't model — both of which must bail.
// Index arithmetic is often f64-lowered (JS number `*`): `(yi*ww + x)` becomes
// `(f64(yi)*ww + f64(x)) |0` = trunc_sat with a NaN-guard `select`. We model those
// passthrough/arith ops too, so a runtime-dimension vblur (x carried through f64)
// analyses the same as a literal-dimension one (x in plain i32). The select is the
// `|0` coercion (value branch when the index is finite — always so for an integer
// array index); we take the value branch's delta. Multiplies need a compile-time
// constant factor on the pivot-bearing side (else the stride isn't constant).
function buildPivotCoeff(loopNode, pivot) {
  const coeff = new Map([[pivot, 1]])
  const cval = (n) => isI32Const(n) ? constNum(n) : (isArr(n) && n[0] === 'f64.const' && n[1] != null ? Number(n[1]) : null)
  const delta = (e) => {
    if (isI32Const(e)) return 0
    if (isLocalGet(e)) return coeff.has(e[1]) ? coeff.get(e[1]) : 0
    if (!isArr(e)) return null
    const [op, a, b] = e
    switch (op) {
      case 'i32.add': case 'f64.add': { const x = delta(a), y = delta(b); return x == null || y == null ? null : x + y }
      case 'i32.sub': case 'f64.sub': { const x = delta(a), y = delta(b); return x == null || y == null ? null : x - y }
      case 'i32.shl': { const c = cval(b), x = delta(a); return c == null || x == null ? null : x << c }
      case 'i32.mul': case 'f64.mul': {
        const ca = cval(a), cb = cval(b), x = delta(a), y = delta(b)
        if (x == null || y == null) return null
        if (ca != null) return ca * y          // const × expr
        if (cb != null) return cb * x          // expr × const
        return x === 0 && y === 0 ? 0 : null    // var × var: pivot-dependent ⇒ non-constant
      }
      // value-preserving conversions: passthrough. `local.tee $v EXPR` yields EXPR.
      case 'f64.convert_i32_s': case 'f64.convert_i32_u': case 'i64.trunc_sat_f64_s':
      case 'i64.trunc_sat_f64_u': case 'i32.wrap_i64': case 'i64.extend_i32_s':
        return delta(a)
      case 'local.tee': return delta(b)
      // the `(expr)|0` NaN/Inf-guard `select(value, 0, finite?)`: take the value branch
      // (the index is a finite integer in any real blur). Only when the else-branch is
      // the const-0 guard — a general ternary index whose arms differ in stride bails.
      case 'select': return isI32Const(e[2]) && constNum(e[2]) === 0 ? delta(a) : null
      default: return null                     // any other op (and/or/div/…) ⇒ unanalyzable
    }
  }
  walkAst(loopNode, { enter: n => {
    if (isArr(n) && (n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') coeff.set(n[1], delta(n[2]))
  } })
  return delta
}

// Vectorize the inner accumulation of an RGBA box-filter pixel loop. See the
// matchChannelGroup header. Returns { wrapper, newLocalDecls } or null.
// Multi-pixel SIMD lift of a clamp-free RGBA box-filter interior (produced by the
// clamp-peel pass). Processes 4 output pixels per iteration: at tap k the 4 outputs
// read 4 CONSECUTIVE source pixels — one 16-byte v128.load whose lanes map DIRECTLY
// to the 4 accumulators (no shuffle). Sums (≤ win·255 < 2^16) accumulate in two
// i16x8 vectors; the divide+store reuses the scalar store templates per pixel.
// Validated bit-exact + 4.34× vs scalar. Bails (→ tryChannelReduce 1-pixel lift)
// unless the body is exactly: clamp-free `xi=x+k; p=(row+xi)<<2; acc_c += u8[base+c]`
// over a unit-stride x, then a 4-byte RGBA store `dst[ab1+c] = f(acc_c)`. r≥127 →
// i16 overflow → bail. Leaves a scalar remainder loop for the ≤3 trailing pixels.
// 4px/step tier of the unified CHANNEL-REDUCE recognizer (see `tryChannelReduce` below,
// the dispatch entry). Takes the ALREADY-COMPUTED `scan` (matchChannelReducePixelLoop),
// shared with the 1px/step tier (`tryChannelReduce1px`) so the dispatch entry runs the
// scan exactly once instead of each tier separately re-deriving it on a blur-tier bail
// (design §2 "CHANNEL-REDUCE … nearly free" merge).
function tryBlurMultiPixel(blockNode, fnLocals, freshIdRef, bl, scan) {
  // Loose-envelope scaffold, matched once at the dispatch (LoopPlan). The exit
  // guard below accepts NO label check and lt_s only (not lt_u), a strictly
  // narrower shape than matchExitBrIf, so it stays this recognizer's own
  // residual rather than folding into the shared scaffold.
  const { loopNode, endIdx } = bl
  // exit guard: br_if $brk (i32.eqz (i32.lt_s x BOUND))
  const exit = loopNode[2]
  if (!(isArr(exit) && exit[0] === 'br_if' && isArr(exit[2]) && exit[2][0] === 'i32.eqz'
    && isArr(exit[2][1]) && exit[2][1][0] === 'i32.lt_s' && isLocalGet(exit[2][1][1]))) return null
  const pivot = exit[2][1][1][1]          // pixel IV $x
  const bound = exit[2][1][2]              // interior bound (expr)
  const bodyEnd = endIdx - 1
  // increment must be `x = x + 1`
  const inc = loopNode[bodyEnd]
  if (!(isArr(inc) && inc[0] === 'local.set' && inc[1] === pivot && isArr(inc[2]) && inc[2][0] === 'i32.add'
    && isLocalGet(inc[2][1], pivot) && isI32Const(inc[2][2]) && constNum(inc[2][2]) === 1)) return null

  const { initIdx, accInits, innerIdx, innerBlock, innerLoop, ilEnd, innerBody, grp } = scan
  // CLAMP-FREE: nothing before the channel group may be an `if` (the edge clamp).
  for (let i = 0; i < grp.idx; i++) if (isArr(innerBody[i]) && innerBody[i][0] === 'if') return null
  // The tap loop must be the i32 form `k <= r`; extract the radius r (reused in the
  // runtime overflow guard below). f64-typed tap loops (f64 dims) bail to scalar.
  const ic = innerLoop[2]
  if (!(isArr(ic) && ic[0] === 'br_if' && isArr(ic[2]) && ic[2][0] === 'i32.eqz'
    && isArr(ic[2][1]) && ic[2][1][0] === 'i32.le_s' && isLocalGet(ic[2][1][1]))) return null
  const rBound = ic[2][1][2]
  if (!(isLocalGet(rBound) || isI32Const(rBound))) return null

  // the RGBA store: 4 i32.store8 at `ab1 + c`, ab1 tee'd in the first. jz's raw pre-watr
  // emission of `dst[o]=(sr/win)|0` materializes the divide into its own single-use temp
  // (`tw = sr/win; store(tw)`) — pre-watr propagateSingleUse runs AFTER the vectorizer
  // (ordered there so it doesn't scramble the dot-pair matcher), so this indirection is
  // never folded before this recognizer sees it, unlike the old post-watr pipeline where
  // watr's own copy-prop had already inlined it into the store operand. Resolve that one-hop
  // indirection here: if a store's value is a bare local.get and the statement immediately
  // before it is that local's SOLE def in the loop, substitute the def's RHS.
  const resolvedTemps = new Set()
  const resolveStoreVal = (idx, val) => {
    if (!(isArr(val) && val[0] === 'local.get')) return val
    const t = val[1], prev = loopNode[idx - 1]
    if (!(isArr(prev) && prev[0] === 'local.set' && prev.length === 3 && prev[1] === t)) return val
    let uses = 0
    walkAst(loopNode, { enter: n => { if (n[0] === 'local.get' && n[1] === t) uses++ } })
    if (uses !== 1) return val
    resolvedTemps.add(t)
    return prev[2]
  }
  let storeIdx = -1
  for (let i = innerIdx + 1; i + 3 <= bodyEnd; i++) {
    const s0 = loopNode[i]
    if (isArr(s0) && s0[0] === 'i32.store8' && s0.length === 3 && isArr(s0[1]) && s0[1][0] === 'local.tee') { storeIdx = i; break }
  }
  if (storeIdx < 0) return null
  const s0 = loopNode[storeIdx]
  const ab1 = s0[1][1], dstExpr = s0[1][2]      // ab1 local, its address expr
  const storeVals = [resolveStoreVal(storeIdx, s0[2])]
  let scanIdx = storeIdx + 1
  for (let c = 1; c < 4; c++) {
    if (isArr(loopNode[scanIdx]) && loopNode[scanIdx][0] === 'local.set') scanIdx++   // skip the next store's div-into-temp
    const s = loopNode[scanIdx]
    if (!(isArr(s) && s[0] === 'i32.store8' && s[1] === `offset=${c}` && isLocalGet(s[2], ab1))) return null
    storeVals.push(resolveStoreVal(scanIdx, s[3]))
    scanIdx++
  }
  // each store value must read its accumulator (the divided sum)
  for (let c = 0; c < 4; c++) if (!readsVar(storeVals[c], accInits[c])) return null

  // ── Soundness guards for the 4-pixels-per-load lift ──────────────────────────
  // Scope the stride analysis to THIS pixel loop. A peeled interior is one segment ⇒
  // one inner tap loop, so there is no sibling same-named-`p` ambiguity, and the scope
  // still captures the LICM preamble where the x-dependent index term is hoisted out of
  // the tap loop (e.g. `__li = f64(x)` — x is invariant w.r.t. the tap IV k).
  const pivotDelta = buildPivotCoeff(loopNode, pivot)
  // (a) Source unit-stride: the v128.load address (array base + byte index) must
  // advance by exactly 4 bytes (one RGBA pixel) per output-pixel step, else the
  // 16-byte load spans the wrong source pixels. Bails on strided indices
  // ((xi*2+row)<<2) and non-constant ones ((yi*W + x + k*x)<<2 → x*(1+k)).
  if (pivotDelta(grp.teeExpr) !== 4) return null
  // (b) No dropped pivot-dependent setup: statements before the inits (loopNode[3..
  // initIdx)) are NOT carried into the 4-pixel loop, so a per-pixel value computed
  // there (e.g. `x2 = x*2`) would go stale. Bail if any such statement is pivot-
  // dependent. (Statements between the inits and the inner loop ARE carried.)
  for (let i = 3; i < initIdx; i++) {
    let bad = false
    walkAst(loopNode[i], { enter: n => { if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string' && pivotDelta(n[2]) !== 0) bad = true } })
    if (bad) return null
  }
  // (c) Store values must read only the accumulators (set per-pixel by the epilogue)
  // and pivot-invariants — never a per-pixel local like the pivot itself, since the
  // store template is reused verbatim for all 4 pixels (`dst[o]=(sr+x)&255` would use
  // the group-base x for pixels 1-3).
  const perPixel = new Set()
  walkAst(loopNode, { enter: n => { if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') perPixel.add(n[1]) } })
  for (const a of grp.accs) perPixel.delete(a)   // accumulators are repopulated per pixel
  const readsPerPixel = (root) => {
    let found = false
    walkAst(root, { enter: n => { if (found) return false; if (n[0] === 'local.get' && perPixel.has(n[1])) { found = true; return false } } })
    return found
  }
  for (let c = 0; c < 4; c++) if (readsPerPixel(storeVals[c])) return null

  // ── Lift ───────────────────────────────────────────────────────────────────
  const id = freshIdRef.next++
  const accLo = `$__bmplo${id}`, accHi = `$__bmphi${id}`, b4 = `$__bmpb${id}`
  const newLocalDecls = [['local', accLo, 'v128'], ['local', accHi, 'v128'], ['local', b4, 'i32']]
  const Z = ['v128.const', 'i64x2', '0', '0']
  // inner body: 4 channel adds → 2 i16 widening adds off the same tee'd base.
  const newInner = []
  for (let i = 0; i < innerBody.length; i++) {
    if (i === grp.idx) {
      newInner.push(['local.set', accLo, ['i16x8.add', ['local.get', accLo], ['i16x8.extend_low_i8x16_u', ['v128.load', ['local.tee', grp.baseLocal, grp.teeExpr]]]]])
      newInner.push(['local.set', accHi, ['i16x8.add', ['local.get', accHi], ['i16x8.extend_high_i8x16_u', ['v128.load', ['local.get', grp.baseLocal]]]]])
    } else if (i > grp.idx && i <= grp.idx + 3) continue
    else newInner.push(innerBody[i])
  }
  const newInnerLoop = [...innerLoop.slice(0, 3), ...newInner, ...innerLoop.slice(ilEnd - 1)]
  const newInnerBlock = innerBlock.map(c => c === innerLoop ? newInnerLoop : c)
  // store epilogue: the o=(row+x)<<2 setup, then ab1, then per pixel j set acc_c to
  // its lane and reuse the scalar store template at byte offset j*4+c.
  // `o = (row+x)<<2` etc. — drop resolved-away div-into-temp defs (unused now; storeVals
  // carries their RHS directly), else a dead `tw15 = sr/win` reading a stale `sr` gets
  // carried into the 4-pixel loop (harmless — unused — but unnecessary bytes/work).
  const preStore = loopNode.slice(innerIdx + 1, storeIdx).filter(s => !(isArr(s) && s[0] === 'local.set' && resolvedTemps.has(s[1])))
  const epilogue = [...preStore, ['local.set', ab1, dstExpr]]
  for (let j = 0; j < 4; j++) {
    const vec = j < 2 ? accLo : accHi, base = (j % 2) * 4
    // lane base+c summed source byte at offset c → grp.accs[c] (the accumulator
    // tied to read-offset c), NOT accInits[c] (zero-init order); see tryChannelReduce.
    for (let c = 0; c < 4; c++) epilogue.push(['local.set', grp.accs[c], ['i16x8.extract_lane_u', String(base + c), ['local.get', vec]]])
    for (let c = 0; c < 4; c++) epilogue.push(['i32.store8', `offset=${j * 4 + c}`, ['local.get', ab1], storeVals[c]])
  }
  // 4-pixel loop body: splat inits, the tap-IV init, the lifted inner loop, the
  // lifted store, x += 4.
  const v4label = `$__bmpx${id}`, v4brk = `$__bmpe${id}`
  const fourBody = [
    ['br_if', v4brk, ['i32.eqz', ['i32.lt_s', ['local.get', pivot], ['local.get', b4]]]],
    ['local.set', accLo, Z], ['local.set', accHi, Z],
    ...loopNode.slice(initIdx + 4, innerIdx),
    newInnerBlock,
    ...epilogue,
    ['local.set', pivot, ['i32.add', ['local.get', pivot], ['i32.const', 4]]],
    ['br', v4label],
  ]
  // Deep-clone the 4-pixel loop: it reuses sub-trees (inner body, store templates,
  // dst expr) that also live in the scalar remainder below — sharing would let a
  // later pass mutating one corrupt the other.
  const dc = (n) => isArr(n) ? n.map(dc) : n
  const fourLoop = dc(['block', v4brk, ['loop', v4label, ...fourBody]])
  // b4 = x + (r<128 ? ((bound-x) & ~3) : 0): the 4-aligned end of the interior from
  // the entry x. The r<128 guard is the i16-overflow check (win·255 < 2^16 ⇔ r<128);
  // when r≥128 the 4-pixel loop runs zero iterations and the scalar remainder covers
  // the whole interior — sound for any runtime r, no duplicated loop body.
  const b4set = ['local.set', b4, ['i32.add', ['local.get', pivot],
    ['select', ['i32.and', ['i32.sub', dc(bound), ['local.get', pivot]], ['i32.const', -4]], ['i32.const', 0],
      ['i32.lt_s', dc(rBound), ['i32.const', 128]]]]]
  // The interior block may carry a LICM-hoisted invariant preamble (e.g. `k=-r`'s
  // value) that the lifted body reads but which the original sets only on block
  // entry — run a clone of it first so the 4-pixel loop sees it. Then b4 setup, the
  // 4-pixel loop, then the ORIGINAL block unchanged (the ≤3-pixel scalar remainder;
  // x continues from b4).
  const loopPos = blockNode.indexOf(loopNode)
  const preamble = blockNode.slice(2, loopPos).map(dc)
  const wrapper = ['block', ...preamble, b4set, fourLoop, blockNode]
  return { wrapper, newLocalDecls }
}

// 1px/step tier of the unified CHANNEL-REDUCE recognizer (see `tryChannelReduce` below,
// the dispatch entry) — the fallback of `tryBlurMultiPixel`'s 4px/step tier. Takes the
// ALREADY-COMPUTED `scan` (matchChannelReducePixelLoop), shared with the 4px tier.
// Loose envelope: LICM may hoist an invariant edge-clamp bound ahead of the loop when
// this pixel loop nests in an outer row loop; preserved verbatim by the wrapper rebuild.
// Unlike tryBlurMultiPixel this never validates the exit/inc shape — it trusts
// `bodyStart..bodyEnd` as the body outright. Loose scaffold from the dispatch.
function tryChannelReduce1px(blockNode, fnLocals, freshIdRef, bl, scan) {
  const { loopNode } = bl
  const { initIdx, innerIdx, innerBlock, innerLoop, ilEnd, innerBody, grp } = scan

  // ── Lift. accv (v128) holds the four channel sums.
  const id = freshIdRef.next++
  const accv = `$__chv${id}`
  const newLocalDecls = [['local', accv, 'v128']]
  // Zero-init → one splat.
  const zeroInit = ['local.set', accv, ['v128.const', 'i32x4', '0', '0', '0', '0']]
  // Inner accumulation: keep the address-producing stmts, replace the 4 channel
  // adds with one widening add off the shared base. The base address is the
  // tee'd expr of the first load (re-tee'd so any later `local.get base` still
  // resolves — though the other channel loads are gone).
  const widen = ['i32x4.extend_low_i16x8_u', ['i16x8.extend_low_i8x16_u',
    ['v128.load32_zero', ['local.tee', grp.baseLocal, grp.teeExpr]]]]
  const newInner = []
  for (let i = 0; i < innerBody.length; i++) {
    if (i === grp.idx) newInner.push(['local.set', accv, ['i32x4.add', ['local.get', accv], widen]])
    else if (i > grp.idx && i <= grp.idx + 3) continue   // drop the other 3 channel adds
    else newInner.push(innerBody[i])
  }
  // Rebuild the inner loop with the lifted body.
  const newInnerLoop = [...innerLoop.slice(0, 3), ...newInner, ...innerLoop.slice(ilEnd - 1)]
  const newInnerBlock = innerBlock.map(c => c === innerLoop ? newInnerLoop : c)
  // After the inner loop, extract the four lane sums back to the scalar
  // accumulators the divide+store code reads. Lane c summed source byte
  // `base+c`, so it must land in grp.accs[c] — the accumulator matchChannelGroup
  // tied to read-offset c — NOT accInits[c] (zero-init order). They coincide only
  // when the program inits/sums in offset order (every real blur); a channel-
  // permuted program (sums offset 0 into a var stored at a later offset) needs the
  // offset-order mapping or the lanes mis-map.
  const extracts = grp.accs.map((acc, c) => ['local.set', acc, ['i32x4.extract_lane', c, ['local.get', accv]]])

  // Reassemble the pixel-loop body: replace the 4 inits with the splat, the inner
  // block with the lifted one, and insert the extracts right after it.
  const newLoop = [...loopNode]
  newLoop.splice(innerIdx, 1, newInnerBlock, ...extracts)   // inner block → lifted + extracts
  newLoop.splice(initIdx, 4, zeroInit)                       // 4 inits → 1 splat (do last; lower index)
  const wrapper = blockNode.map(c => c === loopNode ? newLoop : c)
  return { wrapper, newLocalDecls }
}

// ---- Unified CHANNEL-REDUCE recognizer (dispatch entry) ---------------------
//
// One recognizer, two codegen tiers (design §2 "CHANNEL-REDUCE (#13-14) → 1 general
// recognizer … nearly free" — tryBlurMultiPixel's own doc already called itself "the
// fast tier of tryChannelReduce", bailing to it on any deviation). The ONE shared
// structural scan (matchChannelReducePixelLoop) runs ONCE here instead of each tier
// separately re-deriving it on a blur-tier bail (today's redundant double-scan when
// blurMP's own later guards — clamp-free interior, tap-loop shape, RGBA store match —
// fail after the scan already succeeded). Same dispatch order as before the merge
// (`(blurMP ? tryBlurMultiPixel(...) : null) ?? tryChannelReduce(...)`), so behavior
// is unchanged by construction — pure entry-point + shared-scan consolidation.
function tryChannelReduce(blockNode, fnLocals, freshIdRef, bl, blurMP) {
  if (!bl) return null
  const { loopNode, endIdx } = bl
  const bodyStart = 3, bodyEnd = endIdx - 1   // [exit] at 2, [inc?][br] at the end
  const scan = matchChannelReducePixelLoop(loopNode, bodyStart, bodyEnd)
  if (!scan) return null
  if (blurMP) {
    const r = tryBlurMultiPixel(blockNode, fnLocals, freshIdRef, bl, scan)
    if (r) return r
  }
  return tryChannelReduce1px(blockNode, fnLocals, freshIdRef, bl, scan)
}

/**
 * Divergent escape-time vectorizer — 2-wide f64x2, bit-exact with scalar f64.
 *
 * Recognizes the fractal escape-time nest (mandelbrot / julia / burning-ship / …):
 *
 *   for (qx = 0; qx < W; qx++) {              // outer pixel loop; ≥1 i32 pixel IVs
 *     cx = <expr in qx>                       // per-pixel coordinate(s)
 *     x = 0; y = 0; it = 0                     // loop-carried f64 + i32 counter
 *     while (it < MAXIT) {                     // inner escape loop (it-limited)
 *       <f64 updates to x,y (+ temps); one `if (|z|² > T) break`, ANY position>
 *       it++
 *     }
 *     <epilogue: store(it)  OR  smooth-colour(x,y,it) → store>
 *   }
 *
 * Two adjacent pixels run in f64x2 lockstep with a per-lane active mask. A lane is
 * frozen (v128.bitselect) the instant it would escape or reach MAXIT, so its
 * it/x/y stay bit-identical to the scalar loop — f64x2 add/sub/mul/abs are IEEE-
 * identical to scalar f64 (no FMA fusion). The body is emitted statement-by-
 * statement in source order, so the escape mask lands exactly where the scalar
 * `break` is (before OR after the z-update), and the per-lane state freezes at the
 * matching point. iter is kept as f64x2 (an i32 `it` is exact in f64), so the
 * limit compare and the (possibly fractional) colour math both stay bitwise-exact.
 *
 * Loop-carried vars (first body access is a READ) freeze via bitselect; within-
 * iteration temps (first access a WRITE — inlined squares, `xt`) recompute raw.
 * The colour epilogue runs scalar, twice — once per lane — reading each lane's
 * extracted x/y/it, with the pixel IVs advanced by +0/+1. Odd widths and extra
 * lanes fall through to the original scalar pixel loop (the exact tail).
 */

function tryDivergentEscapeVectorize(blockNode, fnLocals, freshIdRef, outer) {
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

// Math.sin/cos lower to `call $math.{sin,cos}_core` (the emit-time fast path, math.js:67); the
// public `$math.{sin,cos}` wrap the same core. Their f64x2 mirrors $math.sin2/$math.cos2 (the
// vectorized reduce+horner, module/math.js:543) are BIT-EXACT per lane to the scalar core — so we
// can lift the call straight to the *2 helper. Phase-2 adds pow/log/atan2 here (see PPC_CALL2).
// NOTE: scalar targets here must be kept out of watr's single-caller inlining — jz passes these
// keys (SIMD_PINNED, below) as watOptimize's `pin` list, else the call node is gone before this lift runs.

function tryPerPixelColor(blockNode, fnLocals, freshIdRef, pureFuncMap, outer) {
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
function tryOuterStripRest(blockNode, fnLocals, freshIdRef, pureFuncMap, outerStrip, outer) {
  return tryPerPixelColor(blockNode, fnLocals, freshIdRef, pureFuncMap, outer)
    ?? tryOuterStrip(blockNode, fnLocals, freshIdRef, outerStrip, outer)
    ?? tryIteratedReduce(blockNode, fnLocals, freshIdRef, outerStrip, outer)
    ?? tryConvColumn(blockNode, fnLocals, freshIdRef, outerStrip, outer)
}

// ---- Mixed-lane tone-map (tryToneMap, experimental) ------------------------
//
// Vectorizes the log-tonemap TAIL shared by fern / bifurcation / attractors:
//   while (i<n){ let v=dens[i]; if(v>0){ g = trunc(min(log(v+1)*S, 255)) }
//                px[i] = (255<<24)|(g<<16)|(g<<8)|g }
// A flat 1-D loop that loads an i32 density, lifts it to f64 for a log, truncates
// back to i32, packs an ARGB word, and stores it — i32 lanes wrapping an f64 ISLAND.
// The single-lane-type lift can't carry an f64 intermediate inside an i32 store
// (tryVectorize bails on `f64.mul: no lane-pure SIMD mapping for i32`), so this is a
// dedicated 2-wide (f64x2) hybrid: load 2 u32 (`v128.load64_zero` → i32x4 low lanes),
// `f64x2.convert_low_i32x4_s` into the island, `$math.log_v` + f64x2 arith + clamp,
// `i32x4.trunc_sat_f64x2_s_zero` back out, the i32 pack, then a masked
// `i64.store` of `i64x2.extract_lane 0` (the low 2 lanes = 2 pixels). 2 pixels/iter.
//
// BIT-EXACT by construction: each lane runs the scalar op (log_v is the per-lane
// extract/repack mirror; the clamp keeps L finite & in [0,255] so `trunc_sat == |0`,
// the ±Inf canon is a no-op and is dropped; the pack is element-wise). The conditional
// masks are emitted in the SAME lane width as the data they select (`v>0` is i32 and
// gates i32 stores/values; the `L>255` clamp is f64 and gates f64) — a width mismatch
// bails. No cross-lane reordering, so no ulp drift. Speculatively-evaluated arms are
// trap-free (log/convert/mul/min/trunc never trap; there is no div/rem). Gated until
// proven across the corpus, then promoted like the stencil/outer-strip wins.

const _toneStripTee = (n) => isArr(n) && n[0] === 'local.tee' && n.length === 3 ? n[2] : n

// `(i32.wrap_i64 (i64.trunc_sat_f64_{s,u} X))` or `(i32.trunc_sat_f64_{s,u} X)` — the
// f64→i32 `|0` bridge. Returns { inner, signed } (tee on X stripped) or null.
function matchTruncF64(expr) {
  if (!isArr(expr)) return null
  if (expr[0] === 'i32.wrap_i64' && isArr(expr[1])) {
    const t = expr[1]
    if (t[0] === 'i64.trunc_sat_f64_s') return { inner: _toneStripTee(t[1]), signed: true }
    if (t[0] === 'i64.trunc_sat_f64_u') return { inner: _toneStripTee(t[1]), signed: false }
  }
  if (expr[0] === 'i32.trunc_sat_f64_s') return { inner: _toneStripTee(expr[1]), signed: true }
  if (expr[0] === 'i32.trunc_sat_f64_u') return { inner: _toneStripTee(expr[1]), signed: false }
  return null
}

// The `|0` of a known-finite f64: `(select (trunc X) (i32.const 0) (f64.ne X' ±Inf))`.
// Since the tonemap clamps L into [0,255] before the trunc, the `≠Inf` guard is always
// true, so this lowers to a plain `trunc_sat` — returns the inner f64 to truncate.
function matchInfCanonTone(sel) {
  if (!isArr(sel) || sel[0] !== 'select' || sel.length !== 4) return null
  if (!(isI32Const(sel[2]) && constNum(sel[2]) === 0)) return null
  const c = sel[3]
  if (!(isArr(c) && c[0] === 'f64.ne' && isArr(c[2]) && c[2][0] === 'f64.const' && /inf/i.test(String(c[2][1])))) return null
  const tr = matchTruncF64(sel[1])
  return tr ? tr.inner : null
}

// Loads tryToneMap accepts as the f64-island input. `i32.load` is the original (stride-4, no
// widening). Narrow typed-array reads (Uint8/Int8/Uint16/Int16) are widened to the low two i32x4
// lanes before the f64x2.convert — exactly the F/B/T `dist` term over an 8-bit/16-bit buffer.
// `shift` = the address stride exponent (0/1/2). `over` = extra ELEMENTS the widening load reads
// past its lane pair (u8 reads 4 bytes via load32_zero for 2 lanes) — the SIMD bound is shrunk by
// it so the read never runs off the array; the scalar tail finishes the remainder. The widen step
// signedness matches the load op, so the i32x4 lanes hold the exact scalar value.
const TONE_LOAD = {
  'i32.load':     { shift: 2, widen: null, over: 0 },
  'i32.load8_u':  { shift: 0, widen: ['v128.load32_zero', ['i16x8.extend_low_i8x16_u', 'i32x4.extend_low_i16x8_u']], over: 2 },
  'i32.load8_s':  { shift: 0, widen: ['v128.load32_zero', ['i16x8.extend_low_i8x16_s', 'i32x4.extend_low_i16x8_s']], over: 2 },
  'i32.load16_u': { shift: 1, widen: ['v128.load32_zero', ['i32x4.extend_low_i16x8_u']], over: 0 },
  'i32.load16_s': { shift: 1, widen: ['v128.load32_zero', ['i32x4.extend_low_i16x8_s']], over: 0 },
}

// `base + (i << shift)` (shift 0 ⇒ bare `base + i`) with `base` a loop-invariant array pointer.
// The address shape for a load/store at its element stride: the u32 store uses shift 2 (stride-4 ⇒
// load64_zero/i64.store cover exactly 2 consecutive u32); a narrow load uses its own stride (0/1).
function matchToneAddrShift(addr, ind, shift) {
  if (!isArr(addr) || addr[0] !== 'i32.add' || addr.length !== 3) return null
  const pair = (baseN, offN) => {
    if (!isArr(baseN) || (baseN[0] !== 'local.get' && baseN[0] !== 'global.get')) return null
    if (baseN[0] === 'local.get' && baseN[1] === ind) return null
    if (shift === 0) return isLocalGet(offN, ind) ? baseN : null
    if (isArr(offN) && offN[0] === 'i32.shl' && offN.length === 3 && isLocalGet(offN[1], ind) && constNum(offN[2]) === shift) return baseN
    return null
  }
  return pair(addr[1], addr[2]) || pair(addr[2], addr[1])
}

const _toneUnwrapArm = (arm) => {  // arm = ['then'|'else', ...stmts]; unwrap a single nested block
  let body = arm.slice(1)
  if (body.length === 1 && isArr(body[0]) && body[0][0] === 'block') {
    const b = body[0]; let i = 1
    if (typeof b[i] === 'string' && b[i].startsWith('$')) i++
    if (isArr(b[i]) && b[i][0] === 'result') i++
    body = b.slice(i)
  }
  return body
}

const _toneAppears = (n, name) => {
  let found = false
  walkAst(n, { enter: x => {
    if (found) return false
    if ((x[0] === 'local.get' || x[0] === 'local.set' || x[0] === 'local.tee') && x[1] === name) { found = true; return false }
  } })
  return found
}

// First WRITE of `name`: returns { stmtIdx, nested } (nested = inside an `if`) or null.
function _toneFirstWrite(body, name) {
  for (let i = 0; i < body.length; i++) {
    let found = false, nested = false
    const w = (n, depth) => {
      if (found || !isArr(n)) return
      if ((n[0] === 'local.set' || n[0] === 'local.tee') && n[1] === name) { found = true; nested = depth > 0; return }
      const d = depth + (n[0] === 'if' ? 1 : 0)
      for (let j = 1; j < n.length; j++) w(n[j], d)
    }
    w(body[i], 0)
    if (found) return { stmtIdx: i, nested }
  }
  return null
}

// Mixed-lane log-tonemap: i32 dens[i] → f64 log → i32 pack → px[i]. See the block comment above.
function tryToneMap(bl, fnLocals, freshIdRef, enabled) {
  if (!enabled || !bl) return null
  const { incVar, bound, boundLocal, body, preamble, hasGlobalSet: blHasGlobalSet, writes: blWrites, referenced: blReferenced } = bl
  if (!boundLocal && !isI32Const(bound)) return null   // bound must be loop-invariant

  // Shape gate: exactly one i32.store + ≥1 i32.load, all at `base+(i<<2)`, plus the f64
  // island signature (`f64.convert_i32_*`). Any other-width load/store declines. The
  // f64-convert requirement is what distinguishes this from a plain i32 map (tryVectorize,
  // which runs earlier and already owns those).
  let hasConvert = false, storeCount = 0, loadCount = 0, overread = 0, ok = true
  const inspect = n => {
    if (!ok || !isArr(n)) return false
    const o = n[0]
    if (o === 'f64.convert_i32_s' || o === 'f64.convert_i32_u') hasConvert = true
    if (o === 'i32.store') {
      storeCount++
      if (!matchToneAddrShift(n[1], incVar, 2)) ok = false
      if (ok) walkAst(n[2], { enter: inspect })
      return false
    }
    const ld = TONE_LOAD[o]
    if (ld && n.length === 2) {   // i32 (stride-4) or a narrow typed-array read at its own stride
      loadCount++
      if (!matchToneAddrShift(n[1], incVar, ld.shift)) { ok = false; return false }
      if (ld.over > overread) overread = ld.over
      return false
    }
    if (LOAD_OPS[o] || STORE_OPS[o]) { ok = false; return false }  // any other-width memop → not this shape
  }
  for (const s of body) { walkAst(s, { enter: inspect }); if (!ok) break }
  // 1 store (unconditional, attractors) or 2 (the then/else arms of a conditional store,
  // bifurcation/fern — both write the same pixel and collapse to one masked store).
  if (!ok || !hasConvert || storeCount < 1 || storeCount > 2 || loadCount < 1) return null
  if (blHasGlobalSet) return null

  // Classify locals (mirrors tryVectorize): written ⇒ lane (first access must be a write,
  // else loop-carried), unwritten ⇒ invariant. writes/referenced: plan-level census (bl).
  const writes = blWrites
  if (boundLocal && writes.has(boundLocal)) return null
  const referenced = blReferenced
  const localKind = new Map()
  for (const name of referenced) {
    if (name === incVar) continue
    if (writes.has(name)) {
      let firstKind = null
      for (const s of body) { const k = firstAccess(s, name); if (k) { firstKind = k; break } }
      if (firstKind === 'read') return null   // loop-carried
      localKind.set(name, 'lane')
    } else localKind.set(name, 'invariant')
  }

  // Liveness gate: a lane local first ASSIGNED inside an `if` is set speculatively
  // (unconditionally) — sound only if it never leaks past that statement (else a false
  // lane would read a value scalar never produced). Bail otherwise.
  for (const [name, kind] of localKind) {
    if (kind !== 'lane') continue
    const fw = _toneFirstWrite(body, name)
    if (fw && fw.nested) {
      for (let i = 0; i < body.length; i++) if (i !== fw.stmtIdx && _toneAppears(body[i], name)) return null
    }
  }

  const newLanedLocals = new Map()       // origName → laneName (bare string; see getOrAllocLanedLocal)
  // SAME field set + ORDER as the ctx in tryVectorize / tryReduce / tryRampMap. The
  // self-compile kernel infers ONE struct layout per shared callee, and `liftFail` is shared with
  // liftExprV — so every ctx reaching it MUST have the identical shape, or the inferred layout is
  // wrong for some and field reads corrupt (a narrower ctx shape here previously broke the ENTIRE
  // self-compile vectorizer this way). tryToneMap itself only reads fail/failReason/extraLocals, but
  // the unused fields must still be present, in order.
  const ctx = { laneType: 'f64', incVar, rampVar: null, rampTemp: null, widenLoads: false, localKind, fnLocals: null, newLanedLocals, extraLocals: [], freshIdRef, fail: false, failReason: null }
  const toneSetBefore = new Set()         // lane locals already assigned (conditional-merge gate)
  const laned = (name) => { let ln = newLanedLocals.get(name); if (!ln) { ln = `${name}__v`; newLanedLocals.set(name, ln) } return ln }
  const freshMask = () => { const mt = `$__mask${freshIdRef.next++}`; ctx.extraLocals.push(['local', mt, 'v128']); return mt }

  // The ctx-using lifters are NESTED function declarations that CAPTURE the state above (like
  // scanForLoadsStores) — taking `ctx` as a param instead would make jz's self-compile inference
  // mistype the recursive lifter's `ctx` (the recursive call site can't agree on i32, so it
  // stays boxed f64 and its callers emit a bad i64.reinterpret_f64). Capturing sidesteps that.

  // Result lane width of a value expr ('i32' | 'f64' | 'x') — keeps a conditional's mask the
  // SAME width as the data it selects (a mismatch bails).
  function toneWidth(e) {
    if (!isArr(e)) return 'x'
    const o = e[0]
    if (o === 'f64.const' || o === 'f64.convert_i32_s' || o === 'f64.convert_i32_u' || o === 'call') return 'f64'
    if (o === 'i32.const' || o === 'i32.wrap_i64' || o === 'i32.trunc_sat_f64_s' || o === 'i32.trunc_sat_f64_u') return 'i32'
    if (o === 'local.get') return fnLocals.get(e[1]) === 'f64' ? 'f64' : 'i32'
    if (o === 'select') return toneWidth(e[1])
    if (o === 'if') return isArr(e[1]) && e[1][1] === 'f64' ? 'f64' : 'i32'
    if (o.startsWith('f64.')) return 'f64'
    if (o.startsWith('i32.')) return 'i32'
    return 'x'
  }

  // Lift one value expression to v128. Result lane type comes from the op (f64.* → f64x2,
  // i32.* → i32x4; convert/trunc bridge between them). Bit-exact per lane.
  function liftV(expr) {
    if (!isArr(expr)) return liftFail(ctx, 'tonemap: non-expression operand')
    const op = expr[0]
    if ((op === 'f64.convert_i32_s' || op === 'f64.convert_i32_u') && expr.length === 2) {
      const inner = expr[1]
      if (isArr(inner) && (inner[0] === 'global.get' || inner[0] === 'i32.const' ||
          (inner[0] === 'local.get' && localKind.get(inner[1]) === 'invariant')))
        return ['f64x2.splat', expr]   // loop-invariant convert: scalar-then-splat, bit-exact
      const a = liftV(inner); if (ctx.fail) return null
      return [op === 'f64.convert_i32_s' ? 'f64x2.convert_low_i32x4_s' : 'f64x2.convert_low_i32x4_u', a]
    }
    const tr = matchTruncF64(expr)   // f64 → i32 `|0` bridge
    if (tr) { const a = liftV(tr.inner); if (ctx.fail) return null; return [tr.signed ? 'i32x4.trunc_sat_f64x2_s_zero' : 'i32x4.trunc_sat_f64x2_u_zero', a] }
    if (TONE_LOAD[op] && expr.length === 2) {   // i32 → load64_zero (low 2 lanes); narrow → widen to i32x4 low lanes
      const w = TONE_LOAD[op].widen
      if (!w) return ['v128.load64_zero', expr[1]]   // address kept scalar
      let v = [w[0], expr[1]]
      for (let i = 0; i < w[1].length; i++) v = [w[1][i], v]
      return v
    }
    if (op === 'i32.const') return ['i32x4.splat', expr]
    if (op === 'f64.const') return ['f64x2.splat', expr]
    if (op === 'local.get' && typeof expr[1] === 'string') {
      const name = expr[1], kind = localKind.get(name)
      if (kind === 'lane') return ['local.get', laned(name)]
      if (kind === 'invariant') return [fnLocals.get(name) === 'f64' ? 'f64x2.splat' : 'i32x4.splat', expr]
      return liftFail(ctx, `tonemap: ${name} address/induction var used as lane data`)
    }
    if (op === 'local.tee' && typeof expr[1] === 'string' && expr.length === 3) {
      // `let v = X` reused in the same statement folds to `(local.tee $v X)`; lift it to set the
      // lane local AND yield it (bit-exact — the scalar tee sets $v and returns the same value).
      const name = expr[1]
      if (localKind.get(name) !== 'lane') return liftFail(ctx, `tonemap: tee of non-lane ${name}`)
      const v = liftV(expr[2]); if (ctx.fail) return null
      toneSetBefore.add(name)
      return ['local.tee', laned(name), v]
    }
    if (op === 'call' && PPC_CALL2[expr[1]]) {   // transcendental → its 2-wide mirror
      const args = []
      for (let i = 2; i < expr.length; i++) { const a = liftV(expr[i]); if (ctx.fail) return null; args.push(a) }
      return ['call', PPC_CALL2[expr[1]], ...args]
    }
    if (op === 'select' && expr.length === 4) {
      const inf = matchInfCanonTone(expr)
      if (inf) { const a = liftV(inf); if (ctx.fail) return null; return ['i32x4.trunc_sat_f64x2_s_zero', a] }
      return liftSel(expr[1], expr[2], expr[3])
    }
    if (op === 'if' && isArr(expr[1]) && expr[1][0] === 'result' && isArr(expr[3]) && expr[3][0] === 'then' && isArr(expr[4]) && expr[4][0] === 'else')
      return liftSel(expr[3][1], expr[4][1], expr[2])
    const insl = op.startsWith('f64.') ? 'f64' : (op.startsWith('i32.') ? 'i32' : 'x')
    const entry = LANE_PURE[insl]?.get(op)
    if (entry) {
      const a = liftV(expr[1]); if (ctx.fail) return null
      if (entry.shamtScalar) {
        const b = expr[2]
        if (!isI32Const(b) && !(isArr(b) && b[0] === 'local.get' && localKind.get(b[1]) === 'invariant'))
          return liftFail(ctx, `tonemap: ${op}: shift amount not constant/invariant`)
        return [entry.simd, a, b]
      }
      if (expr.length === 2) return [entry.simd, a]
      const b = liftV(expr[2]); if (ctx.fail) return null
      return [entry.simd, a, b]
    }
    return liftFail(ctx, `tonemap: ${op}: no lane mapping`)
  }

  // Lane-comparison mask, required to match the selected data width (a LOCAL `c` — never
  // reassign the param). Returns the mask expr or null on bail.
  function liftMask(cond, dataTy) {
    let c = cond
    if (isArr(c) && c[0] === 'i32.ne' && isI32Const(c[2]) && c[2][1] === 0) c = c[1]
    if (!isArr(c) || c.length !== 3) return liftFail(ctx, 'tonemap: condition is not a comparison')
    const condTy = c[0].startsWith('f64.') ? 'f64' : (c[0].startsWith('i32.') ? 'i32' : 'x')
    if (condTy !== dataTy) return liftFail(ctx, `tonemap: mask width ${condTy} ≠ data width ${dataTy}`)
    const cmp = LANE_COMPARE[condTy]?.[c[0]]
    if (!cmp) return liftFail(ctx, `tonemap: ${c[0]}: not a lane comparison`)
    const ca = liftV(c[1]); if (ctx.fail) return null
    const cb = liftV(c[2]); if (ctx.fail) return null
    return [cmp, ca, cb]
  }

  // `cond ? a : b` → bitselect(a, b, mask(cond)); mask in the branch's lane width.
  function liftSel(a, b, cond) {
    const m = liftMask(cond, toneWidth(a)); if (ctx.fail) return null
    const av = liftV(a); if (ctx.fail) return null
    const bv = liftV(b); if (ctx.fail) return null
    const mt = freshMask()
    return ['block', ['result', 'v128'], ['local.set', mt, m], ['v128.bitselect', av, bv, ['local.get', mt]]]
  }

  // Lift one statement, pushing v128 stmts into `out`. Sets ctx.fail on any bail.
  function liftS(stmt, out) {
    if (!isArr(stmt)) { liftFail(ctx, 'tonemap: non-array statement'); return }
    const op = stmt[0]
    if (op === 'block') {
      let i = 1
      if (typeof stmt[i] === 'string' && stmt[i].startsWith('$')) i++
      if (isArr(stmt[i]) && stmt[i][0] === 'result') i++
      for (const s of stmt.slice(i)) { liftS(s, out); if (ctx.fail) return }
      return
    }
    if (op === 'local.set' && typeof stmt[1] === 'string' && stmt.length === 3) {
      const name = stmt[1]
      if (localKind.get(name) !== 'lane') { liftFail(ctx, `tonemap: set of non-lane ${name}`); return }
      const v = liftV(stmt[2]); if (ctx.fail) return
      out.push(['local.set', laned(name), v]); toneSetBefore.add(name); return
    }
    if (STORE_OPS[op]) {   // i32.store ADDR VAL → masked i64.store of the low 2 lanes (2 pixels)
      if (op !== 'i32.store' || stmt.length !== 3) { liftFail(ctx, `tonemap: unsupported store ${op}`); return }
      const v = liftV(stmt[2]); if (ctx.fail) return
      out.push(['i64.store', stmt[1], ['i64x2.extract_lane', 0, v]]); return
    }
    if (op === 'if' && isArr(stmt[2]) && stmt[2][0] === 'then') {
      const hasElse = isArr(stmt[3]) && stmt[3][0] === 'else'
      const thenStmts = _toneUnwrapArm(stmt[2])
      const elseStmts = hasElse ? _toneUnwrapArm(stmt[3]) : null
      const thenLast = thenStmts[thenStmts.length - 1]
      const elseLast = elseStmts && elseStmts[elseStmts.length - 1]
      const thenStore = isArr(thenLast) && STORE_OPS[thenLast[0]] && thenLast.length === 3
      const elseStore = elseLast && isArr(elseLast) && STORE_OPS[elseLast[0]] && elseLast.length === 3
      // (a) Conditional STORE — both arms (or then-only) end in a store to the same address.
      if (thenStore && (elseStore || !hasElse)) {
        if (elseStore && JSON.stringify(thenLast[1]) !== JSON.stringify(elseLast[1])) { liftFail(ctx, 'tonemap: arms store to different addresses'); return }
        for (const s of thenStmts.slice(0, -1)) { liftS(s, out); if (ctx.fail) return }
        if (hasElse) for (const s of elseStmts.slice(0, -1)) { liftS(s, out); if (ctx.fail) return }
        const thenVal = liftV(thenLast[2]); if (ctx.fail) return
        const elseVal = elseStore ? liftV(elseLast[2]) : ['v128.load64_zero', thenLast[1]]
        if (ctx.fail) return
        const m = liftMask(stmt[1], 'i32'); if (ctx.fail) return
        const mt = freshMask()
        out.push(['local.set', mt, m],
          ['i64.store', thenLast[1], ['i64x2.extract_lane', 0, ['v128.bitselect', thenVal, elseVal, ['local.get', mt]]]])
        return
      }
      // (b) Conditional VALUE update — `if (cond) { L = …; … }` (no else) updating lane locals.
      if (!hasElse) {
        for (const s of thenStmts) {
          if (!(isArr(s) && s[0] === 'local.set' && typeof s[1] === 'string' && s.length === 3 && localKind.get(s[1]) === 'lane')) {
            liftFail(ctx, 'tonemap: no-else arm is not a lane update'); return
          }
          const name = s[1], ty = fnLocals.get(name) === 'f64' ? 'f64' : 'i32'
          const xv = liftV(s[2]); if (ctx.fail) return
          const ln = laned(name)
          if (toneSetBefore.has(name)) {
            const m = liftMask(stmt[1], ty); if (ctx.fail) return   // conditional merge
            const mt = freshMask()
            out.push(['local.set', mt, m], ['local.set', ln, ['v128.bitselect', xv, ['local.get', ln], ['local.get', mt]]])
          } else {
            out.push(['local.set', ln, xv]); toneSetBefore.add(name)   // first, unconditional (liveness-gated)
          }
        }
        return
      }
      liftFail(ctx, 'tonemap: unsupported if shape'); return
    }
    liftFail(ctx, `tonemap: unsupported statement ${op}`)
  }

  const lifted = []
  for (const s of body) { liftS(s, lifted); if (ctx.fail) return null }
  if (!lifted.length) return null

  // 2-wide SIMD wrapper (LANES=2, the f64x2 island's width). Scalar tail = original block.
  const LANES = 2
  const id = freshIdRef.next++
  const simdBoundName = `$__simd_bound${id}`, simdBrk = `$__simd_brk${id}`, simdLoop = `$__simd_loop${id}`
  const boundExpr = boundLocal ? ['local.get', boundLocal] : bound
  const simdBlock = ['block', simdBrk,
    ['loop', simdLoop,
      ['br_if', simdBrk, ['i32.eqz', ['i32.lt_s', ['local.get', incVar], ['local.get', simdBoundName]]]],
      ...lifted,
      ['local.set', incVar, ['i32.add', ['local.get', incVar], ['i32.const', LANES]]],
      ['br', simdLoop]]]
  // A widening narrow load reads more elements than its lane pair (u8: 4 bytes for 2 lanes), so shrink
  // the SIMD bound by that over-read — the widest load stays in-bounds and the scalar tail finishes the
  // remainder. (A negative bound from a tiny array just leaves the whole loop scalar — safe.)
  const boundExprAdj = overread > 0 ? ['i32.sub', boundExpr, ['i32.const', overread]] : boundExpr
  const boundSetup = ['local.set', simdBoundName, ['i32.and', boundExprAdj, ['i32.const', -LANES]]]
  const wrapper = ['block', ...preamble.map(cloneNode), boundSetup, simdBlock, bl.blockNode]
  const newLocalDecls = [
    ['local', simdBoundName, 'i32'],
    ...[...newLanedLocals.values()].map(laneName => ['local', laneName, 'v128']),
    ...ctx.extraLocals,
  ]
  return { wrapper, newLocalDecls }
}

// ---- Radix-2 butterfly 2-wide lift (tryButterfly) ----
//
// The Cooley-Tukey inner loop — the one shape the generic lane lift can never take:
// a DUAL-IV scaffold (`j++` carries the exit test, `k += STEP` walks the twiddle
// table) with an in-place complex-rotation update over four disjoint streams
// (re/im × a/b, b = a + HALF, twiddles wre/wim read-only). Lanes j and j+1:
//   - every a/b access is an ADJACENT pair → one v128.load / v128.store,
//   - the twiddle pair is strided by STEP → two scalar f64.loads + lane combine
//     (same load count as two scalar iterations),
//   - the +/−/× rotation lanes with NO reassociation and NO fusion — each lane
//     computes the exact scalar sequence, so the result is bit-identical and the
//     cross-engine checksum contract holds.
// LEGALITY. The strip body runs only while j+1 < half, so b = a + half ≥ a + 2:
// {a,a+1} and {b,b+1} never overlap — the b-pair stores cannot clobber lane 1's
// a-pair loads, and the single im[a] pair load legitimately serves both the
// im[b] store and the im[a] writeback (im[a] ∉ {im[b−1], im[b]}). re/im/wre/wim
// are distinct base locals under the vectorizer's standing distinct-base
// non-aliasing model. HALF/STEP and the four bases must not be written in the
// loop (checked); j/k are exactly reproduced for the scalar tail (each strip
// iteration consumes two scalar iterations), and the tail IS the original loop,
// so an odd half (or half < 2) falls through untouched.
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
