/**
 * Optimization passes, partitioned by phase. The `level` presets pick which
 * passes are on by default; the user can override individual passes via an
 * object form (`{ level: 1, hoistAddrBase: true }`).
 *
 * Levels:
 *   0 — nothing. Fastest compile, largest output. Useful for live coding.
 *   1 — encoding-compactness only (treeshake + sortLocalsByUse + fusedRewrite-inline).
 *       Cheap, no IR rewrites that perturb V8's tier-up shape.
 *   2 — default. All stable jz passes + full watr (treeshake / dedupe / dedupTypes /
 *       coalesce / propagate / packData / fold / peephole / vacuum / mergeBlocks /
 *       brif / loopify / inlineOnce / …). `inline` stays off (watr's own default —
 *       opt-in only; can duplicate bodies).
 *   3 — level 2 + larger array/hash initial caps + `hoistConstantPool` off
 *       (inline `f64.const` over mutable globals); trades size for speed.
 *
 * String presets (the size↔speed tradeoff lives entirely in the unroll/scalar
 * knobs; watr is on for both):
 *   'size'  — loop/const unroll + lane vectorization off, tight scalar-replacement
 *             caps. Smallest wasm.
 *   'speed' — full nested unroll + lane vectorization (= level 3).
 * The default (level 2) has no string name — omit `optimize` or pass `2`.
 *
 * # Two-layer contract (this file vs watr/optimize)
 * Both layers walk the same S-expression IR; the boundary is KNOWLEDGE, not
 * representation:
 *   - THIS layer owns every pass that needs jz semantics — NaN-box layout
 *     (fusedRewrite's rebox folds, hoistPtrType), emit-side proofs stamped on
 *     func nodes (cseScalarLoad's cseLoadBases whitelist), loop shapes as emit
 *     produces them (narrowLoopBound, hoistInvariantLoop, vectorizeLaneLocal),
 *     and ctx-derived module facts (hoistGlobalPtrOffset's typed-global set).
 *   - watr/optimize owns generic structural rewrites — const folding,
 *     copy-prop, branch/DCE/vacuum, dedupe, treeshake, and inlineOnce. One
 *     deliberate exception: guardRefine lives there despite NaN-box knowledge,
 *     because the dead tag-dispatch shapes it folds only EXIST after that
 *     layer's inlining, and its output feeds that layer's fold/branch cleanup
 *     within the same fixpoint rounds.
 * Sequencing: optimizeFunc runs ONCE, in the 'pre' phase (src/wat/assemble.js
 * optimizeModule), then watOptimize is the sole generic fixpoint optimizer. We never
 * re-run optimizeFunc after watr — doing so dropped reassigned-param tees and corrupted
 * SIMD frames. index.js may run only narrow whole-module proof repairs after watr
 * (stable pointer/cell hoists and masked pure-suffix guarding); those are idempotent,
 * fail-closed, and exist because watr can expose their final address/control shape.
 *
 * @module optimize/config
 */
// The registry lives in src/passes.js (single authority, zero imports — ctx.js
// derives the hot bitmask from the same lists). Re-exported from index.js so
// existing consumers (test/passes.js, test/optimizer.js) keep their import site.
import { PASS_NAMES, TUNING_KEYS } from '../passes.js'
import { OPTF } from '../ctx.js'
export { PASS_NAMES, TUNING_KEYS }

// Registry↔bitmask coherence: every hot flag (ctx.js OPTF/HOT_PASSES — this
// file cannot be imported there, cycle) must be REGISTERED — a level-gated
// pass (PASS_NAMES) or a tuning mode (TUNING_KEYS) — so a flag added on one
// side but forgotten on the other fails at load, not as a silently-dead (or
// silently-always-off) optimization.
for (const n of Object.keys(OPTF)) if (!PASS_NAMES.includes(n) && !TUNING_KEYS.includes(n))
  throw new Error(`OPTF flag '${n}' is not registered (PASS_NAMES / TUNING_KEYS) — register it or remove the flag`)

const ALL_ON = Object.freeze(Object.fromEntries(PASS_NAMES.map(n => [n, true])))
const ALL_OFF = Object.freeze(Object.fromEntries(PASS_NAMES.map(n => [n, false])))
// Default (level 2) preset body — shared with 'fast' below, which derives from it.
const L2_PRESET = Object.freeze({ ...ALL_ON, nestedSmallConstForUnroll: 'auto', splitScratch: false, boolConvertToSelect: false, speculateSchemaBranches: false, recursionUnroll: false, unswitchStringRepLoop: false, unrollScalarChain: false, selectArmUpdates: false, watrProfile: 'speed', inlinePtrOffsetFast: false })

const LEVEL_PRESETS = Object.freeze({
  0: ALL_OFF,
  1: Object.freeze({ ...ALL_OFF, treeshake: true, sortLocalsByUse: true, fusedRewrite: true,
    // The formerly-implicit emit-time transforms ran at every truthy cfg — L1 keeps them.
    inlineToNum: true, hashRmwFusion: true, inplaceStore: true,
    devirtClosureTables: true, devirtDynProps: true }),
  // Default (level 2 / 'balanced'): every stable pass + full watr. Pre-4.6.9 had to
  // force 'light' mode here (inline / inlineOnce / coalesce all off) to dodge the
  // W1a/W1b miscompiles; watr 4.6.9 fixes both, and the L2 default now runs the full
  // watr pipeline. `inline` stays off by watr's own default — opt-in only.
  // boolConvertToSelect off at the default level: it's a latency-for-size trade (adds a
  // const + op per site) that only pays off on serial recurrences — speed-tier only.
  2: L2_PRESET,
  // 'fast': COMPILE-BUDGET preset — level-2 shapes with watr (the final WAT
  // fixpoint) and splitCharScan off. ~2-3× faster compiles on large inputs at
  // ~+30% output size (measured). This is the EXPLICIT form of the retired
  // hidden auto-tuner that used to flip watr:false past AST-size thresholds
  // (dead code changed retained code's bytes — the default must name ONE
  // stable pipeline). For REPL/bundler feedback loops, not shipping builds.
  fast: Object.freeze({ ...L2_PRESET, watr: false, splitCharScan: false }),
  // L3/'speed' trades a bit of heap headroom for fewer __arr_grow / __hash growth
  // cycles. arrayMinCap=16 means `[]` and `new Array()` skip the first two doublings
  // (0→2→4→8→16); hashSmallInitCap=8 keeps per-object __dyn_props at the same load
  // factor as the global __hash_new on first set, avoiding the 2→4→8 grow chain.
  // Net cost: ~128 B per empty array, ~144 B per per-object hash. Net win on the
  // watr.compile profile: __arr_grow ~6.7% → ~3%, and lower __ihash_get_local
  // probe depth from a denser-load global hash.
  // L3/'speed' also turns hoistConstantPool OFF: pooling repeated `f64.const`
  // into `(mut f64)` globals is a pure size win (~7 B/reuse) but a speed loss —
  // a mutable global can't be constant-folded by V8 (any call may mutate it), so
  // every use becomes a load, and promoteGlobals then snapshots the pool into
  // `_pg` locals at each hot function's entry (register pressure in the big
  // closures). Inline `f64.const` is the minimal lowering: V8 CSEs identical
  // constants for free. Measured −3% on jessie parse for +14% binary — exactly
  // the size↔speed trade 'speed' exists to make.
  3: Object.freeze({ ...ALL_ON, hoistConstantPool: false, arrayMinCap: 16, hashSmallInitCap: 8, reduceUnroll: true, relaxedSimd: true, inlineFns: true, rotateLoops: true, watrLicm: true, watrProfile: 'speed', watrGuard: false, unrollScalarChain: true, selectArmUpdates: true }),
  // 'size' tightens scalar/unroll caps; 'speed' = level 3. There is no 'balanced'
  // preset — it was a pure synonym for the default level 2 (omit `optimize` or pass 2).
  size: Object.freeze({
    ...ALL_ON,
    watrProfile: null,        // keep watr's OWN size-leaning default (outline/tailmerge/rettail on) — the one tier where those size-for-speed folds belong
    smallConstForUnroll: false, nestedSmallConstForUnroll: false, splitScratch: false, vectorizeLaneLocal: false, splitCharScan: false,
    hoistGlobalConstLoads: false, maskedSuffixGuard: false,
    recursionUnroll: false,   // body tripling is a size regression — speed-only
    unrollRecurrence: false,  // ×2 body duplication is a size regression — speed-only
    unrollScalarChain: false, // ×2 body duplication is a size regression — speed-only
    selectArmUpdates: false,  // latency-for-predictability trade — speed-only
    forInUnroll: false,       // one body copy per schema key — speed-only
    clampPeel: false,         // edge-clamp peel triples a stencil loop (clamp-free interior + 2 edges) to vectorize — speed-only
    versionTypedBounds: false,// typed-bounds loop versioning duplicates every proven nest (guarded fast arm + checked twin, ×1.5-3 on small kernels) — the branchless checked reads alone are the size-tier lowering; speed-only trade
    leanCheckedIdx: true,     // unproven typed reads emit the if-form (guard → direct load, else undefined) — ~6 ops/site smaller than the select-clamp form, which exists only so SPEED-tier kernel bodies stay branch-free for the SIMD lift (off here)

    boolConvertToSelect: false,  // adds a const + op per site — speed-only latency trade
    inlinePtrOffsetFast: false,  // ~15 ops/site vs. one call — speed-only trade
    unswitchStringRepLoop: false, // duplicates the scan loop for SSO/heap — speed-only
    speculateSchemaBranches: false, // duplicates the dynamic fallback body — speed-only tagged-union PIC
    devirtIndirect: false,    // guards + duplicated args grow bytes — speed-only trade
    internStrings: false,     // the intern index costs ~16 B per eligible literal — speed-only trade
    promoteGlobals: false,    // snapshots a multi-read global into an entry local — pure speed (V8 can't CSE a mutable global); the snapshot is dead size weight at -Os
    hoistInvariantLoop: false,// LICM: hoists loop-invariants to entry temps — a speed/latency trade whose entry cost outweighs the per-iter saving in bytes
    scalarTypedLoopUnroll: 4, scalarTypedNestedUnroll: 8, scalarTypedArrayLen: 8,
    watrIfset: true,          // one-armed if→select IS a size win (~2 B/site — the block framing); wasm-opt -Oz does it too. Speed keeps it via boolConvertToSelect.
  }),
  // 'speed' === level 3: full watr (inlining on) + L3 cap/hash tuning, pool off.
  // reduceUnroll: vectorize reductions with N independent accumulators (ILP/latency
  // hiding, ~3x on dot/FIR sums) — a size↔speed trade like the pool-off above, so
  // speed-only; level 2 / balanced / size keep the single-accumulator reduce.
  // relaxedSimd: fold f64x2 dot-pairs to f64x2.relaxed_madd (single fused VFMADD,
  // one rounding) — faster + more accurate, but the fused result diverges bit-for-bit
  // from the non-fused JS/native reference (bench `fma` parity class). speed-only.
  // (The stencil + outer-strip vectorizers are NOT level-gated here: they're bit-exact pure wins
  // like the base lane vectorizer, so they run whenever it does — default-on at level 2+ via
  // `cfg.stencil !== false` at the call site, not a speed-only size/precision trade.)
  speed: Object.freeze({ ...ALL_ON, hoistConstantPool: false, arrayMinCap: 16, hashSmallInitCap: 8, reduceUnroll: true, relaxedSimd: true, inlineFns: true, rotateLoops: true, watrLicm: true, watrProfile: 'speed', watrGuard: false, unrollScalarChain: true, selectArmUpdates: true }),
})

/**
 * Normalize the user's `opts.optimize` value into a flat config object.
 *
 *   resolveOptimize(undefined | true)         → level 2 stable defaults
 *   resolveOptimize(false | 0)                → all off
 *   resolveOptimize(1 | 2 | 3)                → preset for that level
 *   resolveOptimize('size' | 'speed')         → named preset ('speed' = level 3)
 *   resolveOptimize({ level: 1, watr: true }) → level 1 base, with watr forced on
 *   resolveOptimize({ level: 'size', vectorizeLaneLocal: true }) → 'size' base, override
 *   resolveOptimize({ hoistAddrBase: false }) → level 2 base, hoistAddrBase off
 */
export function resolveOptimize(opt) {
  if (opt === false || opt === 0) return { ...ALL_OFF }
  if (opt === true || opt == null) return { ...LEVEL_PRESETS[2] }
  // String() the level key: LEVEL_PRESETS has integer-literal keys (0..3), and the
  // self-compile kernel's computed member access `obj[numVar]` misreads a numeric VARIABLE
  // index against an object (returns undefined — literal `obj[2]` is fine), so a bare
  // `LEVEL_PRESETS[opt]`/`[baseLevel]` would drop the level-2 default to ALL_ON and
  // (worse, via the partial result) leave `watr` unset — disabling watOptimize.
  if (typeof opt === 'number' || typeof opt === 'string') {
    const p = LEVEL_PRESETS[String(opt)]
    // Unknown preset used to silently mean level 2 — a typo ('sped') then shipped
    // the wrong pipeline with no signal. Levels: 0-3, 'size', 'speed'.
    if (!p) throw new Error(`Unknown optimize preset '${opt}' — valid: 0, 1, 2, 3, 'size', 'speed', 'fast'`)
    return { ...p }
  }
  if (typeof opt === 'object') {
    // Legacy aliases: the four vectorizer passes shipped default-on under an
    // `experimental*` prefix; canonical names dropped it. Old keys stay accepted
    // (normalized here, before validation) so existing configs keep working.
    for (const [legacy, canon] of [['experimentalStencil', 'stencil'], ['experimentalOuterStrip', 'outerStrip'], ['experimentalToneMap', 'toneMap'], ['experimentalSlp', 'slp']])
      if (legacy in opt && !(canon in opt)) { opt = { ...opt, [canon]: opt[legacy] }; delete opt[legacy] }
      else if (legacy in opt) { opt = { ...opt }; delete opt[legacy] }
    const baseLevel = typeof opt.level === 'number' || typeof opt.level === 'string' ? opt.level : 2
    const base = LEVEL_PRESETS[String(baseLevel)]
    if (!base) throw new Error(`Unknown optimize level '${opt.level}' — valid: 0, 1, 2, 3, 'size', 'speed', 'fast'`)
    const out = { ...base }
    for (const n of PASS_NAMES) {
      if (!(n in opt)) continue
      const v = opt[n]
      // Preserve sentinel value `nestedSmallConstForUnroll: 'auto'`
      // (resolved by a heuristic at emit time).
      if (n === 'nestedSmallConstForUnroll' && v === 'auto') out[n] = 'auto'
      else if (n === 'watr' && typeof v === 'object') out[n] = v
      else out[n] = !!v
    }
    // Tuning keys carry through — but ONLY registered ones. Every read site is
    // enumerated in TUNING_KEYS; an unregistered key would otherwise pass through
    // silently as a no-op, masking typos, so an unknown key must fail loudly with
    // the nearest registered name instead.
    for (const k of Object.keys(opt)) {
      if (PASS_NAMES.includes(k)) continue
      if (!TUNING_KEYS.includes(k)) {
        const dist = (a, b) => { if (Math.abs(a.length - b.length) > 2) return 9
          let d = 0; for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) d++
          return d }
        const all = [...PASS_NAMES, ...TUNING_KEYS]
        const near = all.reduce((m, n) => dist(k, n) < dist(k, m) ? n : m, all[0])
        throw new Error(`Unknown optimize key '${k}'${dist(k, near) <= 3 ? ` — did you mean '${near}'?` : ''} (registered passes: PASS_NAMES, tuning: TUNING_KEYS in src/optimize/index.js)`)
      }
      out[k] = opt[k]
    }
    // noSimd: suppress EVERY jz-emitted v128 — both the lane vectorizer AND the SLP
    // store-pair packer. First-class here so `{ level:'speed', noSimd:true }` is a TRUE
    // scalar baseline whether passed nested or via the top-level opts.noSimd flag; the
    // SIMD-vs-scalar correctness oracles depend on it actually disabling SLP.
    if (out.noSimd) { out.vectorizeLaneLocal = false; out.slp = false }
    return out
  }
  return { ...ALL_ON }
}
