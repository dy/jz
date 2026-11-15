
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




import { DBG_INVARIANTS } from '../../debug.js'
import { findBodyStart, writtenLocals } from '../../ir.js'
import { walkAst } from '../../ast.js'
import { channelScan, tryBlurMultiPixel, tryChannelReduce1px } from './blur-channel.js'
import { canonicalizeCounters } from './counter-run.js'
import { tryDivergentEscapeVectorize } from './divergent-escape.js'
import { hoistReductionInvariantsIn, slpPairsIn } from './dot-slp.js'
import { vecState } from './lift.js'
import { tryGeneralMap, tryVectorize } from './map.js'
import { tryGatherMap } from './gather-map.js'
import { hoistStripSplats } from './hoist-splats.js'
import { tryMemCopyFill } from './memcpy.js'
import { forEachLocalDef, isArr } from './node-utils.js'
import { matchOuterPixelLoop } from './outer-scaffold.js'
import { tryPairIterations } from './pair-iterations.js'
import { tryConvColumn, tryIteratedReduce, tryOuterStrip } from './outer-strip.js'
import { tryPerPixelColor } from './per-pixel-color.js'
import { tryRampMap } from './ramp.js'
import { tryPrefilter } from './prefilter.js'
import { tryGeneralReduce, tryReduceBitExact, tryReduceReassoc } from './reduce.js'
import { arrayPointers } from './alias.js'
import { countsSigned, legal, localsHold } from './legality.js'
import { canonicalizeIfBr, describeLoop, foldVecIdentities, matchBlockLoop, normalizeTransparentBlocks, stripScaffold, strips } from './scaffold.js'
import { passCost } from './cost-model.js'
import { irSize } from '../../growth.js'
import { tryGeneralStencil, tryStencil } from './stencil.js'
import { tryStrengthReduceIV } from './strength-reduce.js'
import { tryToneMap } from './tone-map.js'

// ---- Pass entry ------------------------------------------------------------

/**
 * Walk a function looking for vectorizable (block (loop)) pairs, in-place.
 * Adds new locals to the function header.
 */
// opts gates the recognizer set + lift variants (all default-safe so a bare
// `vectorizeLaneLocal(fn)` is the conservative scalar-preserving pass):
//   multiAcc, relaxedFloat, relaxedSimd, blurMP, whyNot, stencil, outerStrip, pureFuncMap, toneMap;
// and the facts of the compile it reads: `links` (each emitted loop's block → what the
// emitter proved of it, src/ir/control.js), `typedView` (a typed view of another's
// buffer exists, which the store pairing does not model) and `warn` (the advisory sink).
export function vectorizeLaneLocal(fn, opts = {}) {
  const { multiAcc = false, relaxedFloat = false, relaxedSimd = false, blurMP = true, whyNot = false,
    stencil = false, outerStrip = false, pureFuncMap = null, toneMap = false, slp = false, crPow = false,
    pairIterations = false, links = null, typedView = false, warn = null } = opts
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

  // A distinct parameter retains its allocation identity only while unwritten
  // (a static one's entry write is the address every call passes, compile/emit-func.js).
  const distinctParams = fn.distinctParams ? new Set(fn.distinctParams) : null
  if (distinctParams) for (const n of writtenLocals(fn)) distinctParams.delete(n)
  let pointerOf = null

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
  const env = { fnLocals, distinct: distinctParams, pointerOf: () => pointerOf ??= arrayPointers(fn) }

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
  // mat4 prologue trick). Reassociates the float sum, so tied to the relaxedFloat tier;
  // runs BEFORE the dot-pair vectorizer so a hoisted dot drops below DOT_UNROLL steps
  // and stays scalar (faster here than the pack/extract SIMD form — see the lab).
  if (relaxedFloat) hoistReductionInvariantsIn(fn, fnLocals, freshIdRef, newLocalDeclsAll)
  // Unified SLP packer (dot-sequence tier, then element-store tier) — see slpPairsIn.
  // (a fused dot pair is both: the relaxed opcode and its one rounding)
  slpPairsIn(fn, fnLocals, freshIdRef, newLocalDeclsAll, relaxedFloat && relaxedSimd, slp && !typedView)
  if (newLocalDeclsAll.length) simdFired = true

  // The locals live out of the loop at the end of `chain` ([parent, idx]
  // pairs from the body root down): read along the continuation before a
  // write reaches them. Reads count from anywhere; a write kills only for
  // the rest of its own straight line (a branch, block or loop body scans
  // with its own copy of the kills, so a write one path may skip never
  // kills past it); an enclosing loop's body is a continuation too (its
  // back edge). `exact`, the scan the legality asks (legality.js): an `if`'s
  // other arm is no continuation of the arm taken, and a write on both arms
  // of an `if` kills past it. The recognizers' own declines read the coarser
  // scan they were measured against, so no loop they decline today lifts.
  function liveOutOf(chain, exact) {
    const live = new Set()
    const scan = (n, kills) => {
      if (!isArr(n)) return
      const op = n[0]
      if (op === 'local.get') { if (typeof n[1] === 'string' && !kills.has(n[1])) live.add(n[1]); return }
      if (op === 'local.set' || op === 'local.tee') {
        for (let i = 2; i < n.length; i++) scan(n[i], kills)
        if (typeof n[1] === 'string') kills.add(n[1])
        return
      }
      if (op === 'if' && !exact) { scan(n[1], kills); scan(n[2], kills); for (let i = 3; i < n.length; i++) scan(n[i], new Set(kills)); return }
      if (op === 'if') {
        let i = 1
        for (; i < n.length && !(isArr(n[i]) && (n[i][0] === 'then' || n[i][0] === 'else')); i++) scan(n[i], kills)
        const arms = []
        for (; i < n.length; i++) { const k = new Set(kills); for (let j = 1; j < n[i].length; j++) scan(n[i][j], k); arms.push(k) }
        if (arms.length === 2) for (const x of arms[0]) if (arms[1].has(x)) kills.add(x)
        return
      }
      if (op === 'block' || op === 'loop' || op === 'then' || op === 'else') { const k = new Set(kills); for (let i = 1; i < n.length; i++) scan(n[i], k); return }
      for (let i = 1; i < n.length; i++) scan(n[i], kills)
    }
    const kills = new Set()
    for (let d = chain.length - 1; d >= 0; d--) {
      const [parent, idx] = chain[d]
      const arm = exact && parent[0] === 'if' && isArr(parent[idx]) && (parent[idx][0] === 'then' || parent[idx][0] === 'else')
      if (!arm) for (let i = idx + 1; i < parent.length; i++) scan(parent[i], kills)
      if (parent[0] === 'loop') for (let i = 1; i < parent.length; i++) scan(parent[i], new Set(kills))
    }
    return live
  }

  // Walk body recursively. Process inner-most matches first (post-order)
  // so we don't try to vectorize an outer loop whose inner is the lane-local one.
  function walk(parent, idx, chain = []) {
    const node = parent[idx]
    if (!isArr(node)) return
    const here = [...chain, [parent, idx]]
    for (let i = 0; i < node.length; i++) {
      if (isArr(node[i])) walk(node, i, here)
    }
    // (a cold loop runs for the values a guard rejected, compile/emit/control-flow.js: no lift)
    if (node[0] === 'block' && !node.some(c => isArr(c) && c[0] === 'loop' && c.cold === true)) {
      if (vecState.whyNotActive) vecState.whyNotReason = null
      // Recognition layer: match the canonical (block (loop)) scaffold ONCE; the
      // inner-scaffold lifters (memcpy/map/reduce) consume the descriptor instead of
      // each re-matching. The outer-pixel + special-shape recognizers (outer-strip
      // family, ramp-map, channel-reduce) do their own matching on the raw node.
      // allowInlinedLi: accept an inlined LICM preamble (`$__inl*___li*`) too — jz's
      // LICM hoists ToInt32/casts of loop-invariant params just before the loop (e.g.
      // `a[i] & m` with a runtime `m`), and after inlining the snap is renamed off the
      // bare `$__li*` form. The preamble is pure & loop-invariant by construction
      // (hasSideEffect-guarded) and cloned ahead of the SIMD block, so this only widens
      // which loops the recognizers see, never changes a lifted result.
      // The loop's one description (scaffold.js describeLoop): its counter, step and exit
      // test, from the emitter's lowering link where it has one (ir/control.js), checked
      // against the WAT under JZ_DEBUG_INVARIANTS. Every scaffold below is a view of it: the
      // canonical one (`i < bound`, a step of one up), its envelope variants, and where that
      // refuses the loop, the strips' own (stripScaffold: a test `<=` or shifted, a loop
      // counting down), whose end a `setup` sets ahead of the lift.
      const desc = describeLoop(node, links?.get(node))
      const canonical = matchBlockLoop(node, { allowPreamble: true, allowInlinedLi: true }, desc)
      // (a canonical loop's test reads the emitter's own counter: checked across the battery)
      if (DBG_INVARIANTS && canonical && desc.own != null && desc.own !== canonical.incVar)
        throw new Error(`loop ${node[1]} counter diverges from WAT: link ${desc.own}, WAT ${canonical.incVar}`)
      const bl = canonical ?? stripScaffold(desc, { allowPreamble: true, allowInlinedLi: true }, freshIdRef)
      const down = bl?.dir === -1
      // A lane-local the function reads outside this loop (`last = a[i]`
      // returned after it) is live out: the lift's v128 shadow never lands in
      // the scalar local, and the scalar tail runs only past the lanes. Every
      // recognizer classifies through laneAccess with this set — the ramp map
      // builds its own scaffold, so it takes the set directly.
      // Scanned on the first query: the scan reads the whole continuation, and
      // most blocks never reach a recognizer that asks.
      let live = null, exact = null
      const outsideReads = { has: (name) => (live ??= liveOutOf(here, false)).has(name) }
      const liveAfter = { has: (name) => (exact ??= liveOutOf(here, true)).has(name) }
      if (bl) bl.outsideReads = outsideReads
      // LoopPlan classification (stage-3 slice 1): the OUTER-pixel scaffold is
      // matched ONCE here — the five outer-family recognizers consume this
      // descriptor (with its inner-loop census) instead of each re-matching.
      // `bl` (inner scaffold) + `op` (outer scaffold) together are the loop's
      // plan; a recognizer whose scaffold is null skips without walking.
      const op = matchOuterPixelLoop(node, desc)
      // Loose-envelope variant of the same scaffold (any non-loop content tolerated), for
      // blur-multi-pixel and channel-reduce; matched once, on first read.
      let blLoose, blLooseComputed = false
      const getBlLoose = () => blLooseComputed ? blLoose
        : (blLooseComputed = true, blLoose = matchBlockLoop(node, { envelope: 'loose' }, desc))
      // The counter-run variant (secondary counters `k += step` beside the exit one), for
      // the general map, which gathers through them; the plain scaffold when it declines.
      const getBlRun = () => {
        const run = matchBlockLoop(node, { allowPreamble: true, allowInlinedLi: true, ivRun: true }, desc)
        if (run) run.outsideReads = outsideReads
        return run ?? bl
      }
      // A loop counting down reaches only the recognizers whose strips run it with the shared
      // control (scaffold.js simdLoop, simdBound: the strip lifted at its lowest iteration),
      // the map, the reductions and the general map, and the bulk copy, whose overlap test
      // answers for either order. The others build their own strip control or run an epilogue
      // in the loop's order, and are offered `up`, null for it. A lift made of the strips'
      // own scaffold takes its setup with it (below).
      const up = down ? null : bl
      const of = (x) => { if (x && bl && !canonical) x.scaffold = bl; return x }
      // The one chooser. Every lowering is asked of the loop; each lift it makes passes the one
      // legality (legality.js: what it leaves in the locals the loop writes, the order of the
      // bytes its strips touch; bases nothing proves apart may be one array, and the strip
      // opens past a test of it) and is costed by one measure read off its own code
      // (cost-model.js passCost: the weighted ops of a pass of the loop). The cheapest is
      // emitted; of two that cost the same, the smaller, and of two the same size the first
      // asked: such lifts are one code under two names. An output cursor beside the counter
      // (`op += 2`) reads as a recurrence to every lowering; rewritten over the exit counter
      // (counter-run.js) the loop is offered to them again, its rewrite kept with a lift of it.
      // A strip wider than every entry's trips (the emitter's `trips`, loop-model.js) never
      // runs: such a lift is bytes for nothing (a remainder loop of at most four passes).
      const lifts = [], trips = desc?.facts?.trips
      const runs = (x) => { let ok = true; if (trips != null) walkAst(x.wrapper, { enter: n => { const at = strips.get(n); if (at && at.lanes > trips) ok = false } }); return ok }
      const take = (name, x, over = node) => {
        if (!x || !runs(x)) return
        const y = legal(x, over, liveAfter, env)
        if (!y) return
        y.lowering = name
        y.cost = passCost(y, over.find(c => isArr(c) && c[0] === 'loop'))
        y.size = irSize(y.wrapper)
        lifts.push(y)
      }
      take('tryDivergentEscapeVectorize', tryDivergentEscapeVectorize(node, fnLocals, freshIdRef, op))
      take('tryMemCopyFill', of(tryMemCopyFill(bl, fnLocals, freshIdRef)))
      take('tryVectorize', of(tryVectorize(bl, fnLocals, freshIdRef, pureFuncMap, constLocals)))
      take('tryReduceReassoc', of(tryReduceReassoc(bl, fnLocals, freshIdRef, multiAcc)))
      take('tryReduceBitExact', of(tryReduceBitExact(bl, fnLocals, freshIdRef)))
      take('tryStencil', of(tryStencil(node, fnLocals, freshIdRef, stencil, up)))
      take('tryRampMap', tryRampMap(node, fnLocals, freshIdRef, outsideReads))
      const loose = getBlLoose(), channels = channelScan(loose)
      if (channels && blurMP) take('tryBlurMultiPixel', tryBlurMultiPixel(node, fnLocals, freshIdRef, loose, channels))
      if (channels) take('tryChannelReduce1px', tryChannelReduce1px(node, fnLocals, freshIdRef, loose, channels))
      take('tryPerPixelColor', tryPerPixelColor(node, fnLocals, freshIdRef, pureFuncMap, op))
      take('tryOuterStrip', tryOuterStrip(node, fnLocals, freshIdRef, outerStrip, op))
      take('tryIteratedReduce', tryIteratedReduce(node, fnLocals, freshIdRef, outerStrip, op))
      take('tryConvColumn', tryConvColumn(node, fnLocals, freshIdRef, outerStrip, op))
      take('tryToneMap', of(tryToneMap(up, fnLocals, freshIdRef, toneMap)))
      take('tryGeneralMap', of(tryGeneralMap(node, fnLocals, freshIdRef, getBlRun())))
      take('tryGeneralStencil', of(tryGeneralStencil(node, fnLocals, freshIdRef, stencil, up)))
      take('tryGeneralReduce', of(tryGeneralReduce(bl, fnLocals, freshIdRef, multiAcc)))
      take('tryGatherMap', of(tryGatherMap(up, fnLocals, freshIdRef, distinctParams)))
      const canon = canonicalizeCounters(node, fnLocals, freshIdRef, desc)
      const cbl = canon && matchBlockLoop(canon.node, { allowPreamble: true, allowInlinedLi: true })
      if (cbl) {
        for (const d of canon.decls) fnLocals.set(d[1], d[2])
        cbl.outsideReads = outsideReads
        const rewritten = (x) => x && { ...x, wrapper: ['block', ...canon.setup, x.wrapper, ...canon.landing], newLocalDecls: [...canon.decls, ...x.newLocalDecls] }
        take('retry:tryMemCopyFill', rewritten(tryMemCopyFill(cbl, fnLocals, freshIdRef)), canon.node)
        take('retry:tryVectorize', rewritten(tryVectorize(cbl, fnLocals, freshIdRef, pureFuncMap, constLocals)), canon.node)
        take('retry:tryGeneralMap', rewritten(tryGeneralMap(canon.node, fnLocals, freshIdRef, cbl)), canon.node)
        // a cursor beside a reduction (`s += x[ix]; ix += 1`, dasum's shape)
        take('retry:tryReduceReassoc', rewritten(tryReduceReassoc(cbl, fnLocals, freshIdRef, multiAcc)), canon.node)
        take('retry:tryReduceBitExact', rewritten(tryReduceBitExact(cbl, fnLocals, freshIdRef)), canon.node)
        take('retry:tryGeneralReduce', rewritten(tryGeneralReduce(cbl, fnLocals, freshIdRef, multiAcc)), canon.node)
      }
      let r = null
      for (const y of lifts) if (!r || y.cost < r.cost || (y.cost === r.cost && y.size < r.size)) r = y
      // Past that test, a splat no pass of a strip changes is computed where the strip opens.
      if (r) r.newLocalDecls = [...r.newLocalDecls, ...hoistStripSplats(r.wrapper, freshIdRef, outsideReads)]
      // The strips' end, where their scaffold set one (stripScaffold), ahead of them.
      if (r?.scaffold?.setup.length) r = { ...r, wrapper: ['block', ...r.scaffold.setup, r.wrapper], newLocalDecls: [...r.scaffold.decls, ...r.newLocalDecls] }
      // A guard whose first test the lanes can answer, over work too heavy to be common: it
      // keeps the order of every access, and answers for its locals as a lift does. It and the
      // pairing below lift no pass's work (the loop as written runs it): no cost of theirs
      // compares with a lift's, and they are asked where no lowering lifts the loop.
      if (!r) { r = tryPrefilter(canonical, fnLocals, freshIdRef); if (r && !(localsHold(r, node, liveAfter) && countsSigned(r, node))) r = null }
      // Not a lane lift: two items' inner loops run side by side (pair-iterations.js).
      const paired = r ? null : legal(tryPairIterations(node, fnLocals, freshIdRef, op, outsideReads, pairIterations), node, liveAfter, env)
      // --why-not-simd: a canonical loop-shaped candidate that no SIMD pass took.
      // Reported BEFORE the scalar strength-reduce fallback (which fires on most
      // affine loops and would otherwise mask "didn't vectorize"). Diagnostic only.
      // Reuses `op` (already matched above) instead of re-running matchOuterPixelLoop.
      if (!r && vecState.whyNotActive && (canonical || op)) {
        whyNotN++
        warn?.('simd-why-not',
          `${fnName.replace(/^\$/, '')}: loop #${whyNotN} not vectorized — ${vecState.whyNotReason || 'no SIMD-liftable shape (loop-carried dependency, non-affine address, or unsupported control flow)'}`,
          { fn: `${fnName}#${whyNotN}` })
      }
      if (r) simdFired = true   // one of the real SIMD recognizers above matched
      if (paired) r = paired
      if (r) {
        // Mark the consumed subtree: the wrapper REUSES these nodes (scalar tail, and the
        // lane splats alias the original load nodes), so a deferred strength-reduce must
        // never rewrite inside them — it would mutate the lifted lanes through the alias.
        walkAst(node, { enter: n => { srConsumed.add(n) } })
        parent[idx] = r.wrapper
        newLocalDeclsAll.push(...r.newLocalDecls)
      } else if (canonical) {
        // Scalar IV strength-reduction is a non-SIMD fallback — DEFERRED to after the
        // whole walk. Applied eagerly here (post-order = innermost first) it rewrites an
        // inner reduction loop into its wrapper before the ENCLOSING loop's outer
        // recognizers (outer-strip / iterated-reduce / conv-column / tone-map) ever run,
        // and they bail on the non-canonical inner shape — metaballs' pixel loop lost its
        // whole f64x2 outer-strip to an eager strength-reduce of the blob loop.
        deferredSR.push([node, parent, idx, canonical])
      }
    }
  }
  const deferredSR = [], srConsumed = new Set()
  vecState.whyNotActive = whyNot
  vecState.fn = fn
  vecState.onceRead = null
  vecState.relaxF32 = relaxedFloat
  vecState.relaxedSimd = relaxedSimd
  vecState.crPow = crPow
  for (let i = bodyStart; i < fn.length; i++) walk(fn, i)
  vecState.whyNotActive = false
  vecState.fn = null
  vecState.onceRead = null
  vecState.relaxF32 = false
  vecState.relaxedSimd = false
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
