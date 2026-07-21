/**
 * WASM IR post-emission optimizations.
 *
 * # Stage contract
 *   IN:  WAT-as-array IR (function body or module-level).
 *   OUT: equivalent WAT-as-array IR (same semantics, smaller encoding).
 *   INVARIANTS: semantics-preserving IR→IR rewrites. Leaf passes are context-free;
 *        explicitly documented module-proof passes may read immutable ctx facts. No ctx writes.
 *        No new top-level declarations except those surfaced via `addGlobal`.
 *
 * Each pass is orthogonal. Apply order matters: structural hoists (hoistPtrType) introduce
 * new locals before the fused walk, which mixes peephole rebox folds, ptr-helper inlining,
 * and memarg-offset folding in one bottom-up traversal.
 *
 * Passes:
 *   hoistPtrType      — repeated `(call $__ptr_type X)` on same X → single local.tee + local.get reuse
 *   fusedRewrite      — peephole rebox folds + inline ptr/is_* helpers + memarg-offset fold (one walk)
 *   sortLocalsByUse   — reorder local decls so hot ones get 1-byte LEB128 indices
 *   specializeMkptr   — `(call $__mkptr (i32.const T) (i32.const A) X)` → per-combo specialized helper (~4 B/site)
 *   hoistConstantPool — frequently-repeated f64.const values → mutable globals (~7 B/reuse)
 *   treeshake         — drop func decls unreachable from exports / start / elem / ref.func roots
 *
 * Per-function passes run over sec.funcs + sec.stdlib + sec.start.
 * Whole-module passes see the full function list + globals map.
 *
 * @module optimize
 */

import { LAYOUT, ctx } from '../ctx.js'
import { VAL } from '../reps.js'
import { findBodyStart, buildRefcount, nextLocalId, verifyFn, isPureIR, f64Range, I32_MIN, I32_MAX } from '../ir.js'

// Debug-mode IR structural check (JZ_DEBUG_INVARIANTS=1). Zero production cost.
const DBG_IR = typeof process !== 'undefined' && process.env?.JZ_DEBUG_INVARIANTS === '1'
const DBG_DSR = typeof process !== 'undefined' && !!process.env?.JZ_DBG_DSR
const DBG_UNSWITCH = typeof process !== 'undefined' && (process.env?.JZ_DBG_UNSWITCH || null)
import { T, isLeaf, stableNodeKey } from '../ast.js'
import { vectorizeLaneLocal, inlinePureCallExpr } from './vectorize.js'
import { recursionUnroll } from './recurse.js'
export { SIMD_PINNED, inlinePureFnsInFn } from './vectorize.js'
import { nanPrefixHex, atomNanHex, STR_INTERN_BIT, ptrBits, i64Hex, PTR, TYPED_ELEM_CODE, TYPED_ELEM_VIEW_FLAG } from '../../layout.js'

const MEMOP = /^[fi](32|64)\.(load|store)(\d+(_[su])?)?$/
const NAN_BITS = nanPrefixHex()
const NULL_BITS = atomNanHex(1)
const UNDEF_BITS = atomNanHex(2)
const FALSE_BITS = atomNanHex(4)

// IR is usually a tree but optimizer nodes may share large subgraphs. Keep
// feature probes linear rather than recursively revisiting a shared DAG.
export function hasIROp(roots, opcode) {
  const stack = Array.isArray(roots) ? [...roots] : [roots], seen = new Set()
  while (stack.length) {
    const node = stack.pop()
    if (!Array.isArray(node) || seen.has(node)) continue
    seen.add(node)
    if (node[0] === opcode) return true
    for (let i = 1; i < node.length; i++) if (Array.isArray(node[i])) stack.push(node[i])
  }
  return false
}

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
 */
export const PASS_NAMES = [
  'watr',                     // third-party WAT-level CSE/DCE/inlining (heaviest)
  'devirtIndirect',           // call_indirect w/ known closure consts → guarded direct calls (WAT-level, grows bytes)
  'speculateSchemaBranches',  // one schema guard around multi-field tagged-union branch bodies (speed-for-size)
  'hoistPtrType',
  'hoistInvariantPtrOffset',
  'hoistInvariantLoop',       // unified LICM (subsumes the former ToInt32/PtrOffsetLoop/CellLoads hoists)
  'narrowLoopBound',          // f64 loop bound → hoisted i32 (unblocks the lane-vectorizer)
  'splitCharScan',            // charCodeAt scan loops: split at min(N, s.length) → i32 char carrier (plan-level)
  // Pre-analyze loop-shape transforms — applied in compile/index.js (NOT this pass pipeline), but
  // gated by these flags. Listing them here is load-bearing: ALL_OFF sets them false so level 0/1
  // (the self-host fast path) actually skip them, instead of `undefined !== false` running them
  // unconditionally at every level. ALL_ON keeps them on at level 2+ where they belong.
  // REPRESENTATION passes (audit decision: optimize false/0/1 is the
  // representation-free REFERENCE tier — plain layouts, an independent oracle
  // for three-way differentials; `{ level: 0, unionInline: true }` re-enables):
  'structInline',             // Array<S> packed inline cells (whole-program SRoA)
  'unionInline',              // closed heterogeneous-record union carrier + cursor clones
  'loopIVDivMod',             // strength-reduce per-iter `i%w` / `(i/w)|0` → incremental i32 counters
  'loopSquare',               // bounded `i*i < CONST` → Math.imul (i32 product chain)
  'unrollRecurrence',         // unit-stride DP/scan: scalar-replace arr[j-1]/arr[j] recurrence + ×2 unroll
  'clampPeel',                // edge-clamp stencil: split into clamp-free interior (vectorizes) + edges
  'hoistGlobalPtrOffset',     // stable typed GLOBALS: __ptr_offset resolve → once per function (post-watr, module-level)
  'hoistGlobalConstLoads',    // immutable fixed global typed cells → function-entry locals
  'maskedSuffixGuard',        // all-false SIMD masks skip large pure producer suffixes
  'hoistLoopGlobalPtrOffset', // per-loop complement: narrower write/call scan lets a clean loop hoist inside an otherwise-poisoned function
  'fusedRewrite',             // peephole + ptr-helper inline + memarg fold
  'hoistAddrBase',
  'boolConvertToSelect',      // f64 ± (cond?1:0) → branchless select (kills i32↔f64 domain cross on recurrences)
  'cseScalarLoad',
  'unswitchTypedParamLoop',   // Float64Array param loop-unswitch → base-hoisted f64.load/store fast path (vectorizes)
  'unswitchStringRepLoop',    // leaf char scans: hoist invariant SSO/heap selection out of the byte loop
  'propagateSingleUse',       // forward-substitute single-def/single-use pure temps (watr's "propagate")
  'foldSetToTee',             // sink a single-def local's RHS into its first use as a tee (simplify-locals watr leaves)
  'promoteGlobals',          // read-only global.get → local for multi-read globals
  'sortLocalsByUse',
  'specializeMkptr',
  'internStrings',            // slice/substring results probe the static-literal pool: equal-content → canonical bits (bit-eq fast paths)
  'hoistConstantPool',
  'sourceInline',
  'smallConstForUnroll',
  'nestedSmallConstForUnroll',
  'splitScratch',             // SSA-split scalar scratch from unrolled loop copies, then LICM
  'vectorizeLaneLocal',       // SIMD-128 lift for lane-pure typed-array loops
  'recursionUnroll',          // inline a single non-tail self-call to depth N (tree-recursion call-overhead)
  'arenaRewind',              // per-call heap rewind for no-arg scalar allocator kernels
  'treeshake',
  'jsstring',                 // boundary opt-in: flip exported string params to externref
  // Registry completion (architecture plan Stage 0): every flag a call site
  // reads MUST be listed here — an unlisted name is `undefined !== false` and
  // silently runs at O0, breaking the representation-free reference tier.
  // test/passes.js greps every gate read against this list + TUNING_KEYS.
  'loadCSE',                  // straight-line typed element-load CSE (compile-level, pre-analyze)
  'intDivLower',              // i32/i32 constant-divisor strength lowering
  'forInUnroll',              // for-in over a static schema → key-literal-substituted body copies
  'versionTypedBounds',       // typed-bounds loop versioning (guarded fast arm + checked twin)
  'hoistConstLit',            // loop-invariant const array/object literal hoist (allocate once)
  'unrollScalarChain',        // serial-chain (address-carried scalar) ×2 pairing — speed-only
  'selectArmUpdates',         // disjoint-arm update chain → select accumulation — speed-only
  // WAT-pipeline passes previously gated only by `undefined !== false` inside
  // optimizeFunc (found by the registry-coverage gate on its first run):
  'foldStaticArrReads',       // const-index reads of static-data arrays → immediates
  'blurMultiPixel',           // stencil vectorizer's multi-pixel mode
  'experimentalStencil',      // stencil vectorizer (bit-exact pure win; listed for the O0 contract)
  'experimentalOuterStrip',   // outer-loop strip-mining vectorizer
  'experimentalToneMap',      // tone-map reduction vectorizer
  'experimentalSlp',          // superword-level parallelism (adjacent-scalar packing)
  'devirtFnArrays',           // const fn-array call_indirect → guarded direct calls
  'devirtSchemaReads',        // megamorphic dyn-get probe → br_table over registered schemas
  'inlineDevirtArms',         // inline the devirt guard's direct-call arms
]

/** Numeric/string tuning knobs the presets may set — legal config keys that are
 *  NOT on/off passes. The registry-coverage test accepts these; anything else
 *  read off the optimize object is an unregistered flag and fails the gate. */
export const TUNING_KEYS = [
  'level', 'arrayMinCap', 'hashSmallInitCap', 'watrProfile', 'watrGuard', 'watrLicm',
  'reduceUnroll', 'relaxedSimd', 'inlineFns', 'rotateLoops', 'leanCheckedIdx', 'watrIfset',
  'scalarTypedLoopUnroll', 'scalarTypedNestedUnroll', 'scalarTypedArrayLen',
  'snapshotInit',
  'rationalConst',            // SEMANTIC precision lowering (rational constant carry — pinned
                              // by the precision suite at EVERY tier incl. O0), opt-out only:
                              // not a level-gated optimization, so not in PASS_NAMES/ALL_OFF
  'whyNotSimd',               // diagnostic: print vectorizer rejection reasons
  'crPow',                    // opt-in experimental pow vectorization
  'inlinePureFns',            // opt-in pure-function WAT inlining (assemble)
]

const ALL_ON = Object.freeze(Object.fromEntries(PASS_NAMES.map(n => [n, true])))
const ALL_OFF = Object.freeze(Object.fromEntries(PASS_NAMES.map(n => [n, false])))
const LEVEL_PRESETS = Object.freeze({
  0: ALL_OFF,
  1: Object.freeze({ ...ALL_OFF, treeshake: true, sortLocalsByUse: true, fusedRewrite: true }),
  // Default (level 2 / 'balanced'): every stable pass + full watr. Pre-4.6.9 had to
  // force 'light' mode here (inline / inlineOnce / coalesce all off) to dodge the
  // W1a/W1b miscompiles; watr 4.6.9 fixes both, and the L2 default now runs the full
  // watr pipeline. `inline` stays off by watr's own default — opt-in only.
  // boolConvertToSelect off at the default level: it's a latency-for-size trade (adds a
  // const + op per site) that only pays off on serial recurrences — speed-tier only.
  2: Object.freeze({ ...ALL_ON, nestedSmallConstForUnroll: 'auto', splitScratch: false, boolConvertToSelect: false, speculateSchemaBranches: false, recursionUnroll: false, unswitchStringRepLoop: false, unrollScalarChain: false, selectArmUpdates: false, watrProfile: 'speed' }),
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
  // `cfg.experimentalStencil !== false` at the call site, not a speed-only size/precision trade.)
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
  // self-host kernel's computed member access `obj[numVar]` misreads a numeric VARIABLE
  // index against an object (returns undefined — literal `obj[2]` is fine), so a bare
  // `LEVEL_PRESETS[opt]`/`[baseLevel]` would drop the level-2 default to ALL_ON and
  // (worse, via the partial result) leave `watr` unset — disabling watOptimize.
  if (typeof opt === 'number' || typeof opt === 'string') return { ...(LEVEL_PRESETS[String(opt)] || LEVEL_PRESETS[2]) }
  if (typeof opt === 'object') {
    const baseLevel = typeof opt.level === 'number' || typeof opt.level === 'string' ? opt.level : 2
    const base = LEVEL_PRESETS[String(baseLevel)] || ALL_ON
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
    // Preserve non-pass tuning keys (e.g. plan.js thresholds)
    for (const k of Object.keys(opt)) if (!PASS_NAMES.includes(k)) out[k] = opt[k]
    // noSimd: suppress EVERY jz-emitted v128 — both the lane vectorizer AND the SLP
    // store-pair packer. First-class here so `{ level:'speed', noSimd:true }` is a TRUE
    // scalar baseline whether passed nested or via the top-level opts.noSimd flag; the
    // SIMD-vs-scalar correctness oracles depend on it actually disabling SLP.
    if (out.noSimd) { out.vectorizeLaneLocal = false; out.experimentalSlp = false }
    return out
  }
  return { ...ALL_ON }
}

/**
 * CSE repeated `(call $__ptr_type X)` on same X across stable regions.
 *
 * A stable region for var X is a maximal CFG segment where X is not written.
 * Within each region, the first `__ptr_type X` becomes `(local.tee $__ptN ...)`,
 * subsequent ones become `(local.get $__ptN)`. One hoist local per X is shared
 * across regions (each region's tee re-initializes it).
 *
 * Region boundaries:
 *   - `local.set` / `local.tee` of X → close region, alive[X] = false
 *   - `if` arms processed independently from the if-entry alive state; on merge,
 *     a var is alive after the `if` only if alive in BOTH arms with the same region
 *     (so the same tee was reachable on every path).
 *   - `loop` body walks with empty alive (next iteration may re-enter after a write)
 *   - `block` is sequential (br jumps out, never in)
 *
 * Threshold: a region is committed only when it has ≥2 sites. Singleton regions
 * (one tee with no follow-up gets) are pure cost and skipped.
 *
 * Safety: __ptr_type extracts type tag bits, which never change for a given
 * NaN-boxed f64. Caching is safe inside any region where X isn't rewritten.
 * (Contrast __ptr_offset, which has a forwarding loop for ARRAY — caching its
 * result is unsafe across realloc, so it isn't hoisted here.)
 */
export function hoistPtrType(fn) {
  return regionTrackCSE(fn, {
    matchSite(node) {
      // (call $__ptr_type (i64.reinterpret_f64 (local.get X))) — key is X, dep is X.
      if (node[0] !== 'call' || node[1] !== '$__ptr_type' || node.length !== 3) return null
      const arg = node[2]
      const inner = (Array.isArray(arg) && arg[0] === 'i64.reinterpret_f64' && arg.length === 2) ? arg[1] : arg
      if (!Array.isArray(inner) || inner[0] !== 'local.get' || typeof inner[1] !== 'string') return null
      const x = inner[1]
      return { key: x, deps: [x] }
    },
    localPrefix: 'pt',
    localType: 'i32',
  })
}

/** Region-tracking CSE skeleton shared by hoistPtrType and hoistAddrBase.
 *  Walks `fn`, accumulating "regions" — sequences of structurally-identical
 *  sites along straight-line control flow where the site's value is invariant
 *  (no writes to its dependent locals between sites). Per region with ≥2 sites,
 *  allocates one `$__<prefix><id>` local and rewrites the first site to
 *  `local.tee` and the rest to `local.get`.
 *
 *  Control-flow semantics:
 *    - `local.set/tee X` closes every region whose dep set includes X.
 *    - `if`/`else` arms walk independently from the if-entry open set; after
 *      the if, a region is open iff it was open on BOTH arms (same region ref).
 *    - `loop` clears open before AND after — back edges may skip the original tee.
 *    - `block` / func body — sequential walk.
 *
 *  `matchSite(node, parent, pi)` returns `{ key, deps }` for a CSE-able site
 *  (key is a stable string; deps lists locals whose writes invalidate this key)
 *  or null. Match-arm sites don't recurse into children. */
function regionTrackCSE(fn, { matchSite, localPrefix, localType }) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // Per key: array of regions; each region is array of {parent, idx, role: 'tee'|'get'}.
  const regions = new Map()
  // Currently-open region per key. Presence ⇔ alive.
  const open = new Map()
  // local-name → keys depending on it (so `local.set X` closes all dependent keys).
  const localToKeys = new Map()

  const addDep = (name, key) => {
    let s = localToKeys.get(name)
    if (!s) { s = new Set(); localToKeys.set(name, s) }
    s.add(key)
  }
  const closeForLocal = (name) => {
    const s = localToKeys.get(name)
    if (!s) return
    for (const k of s) open.delete(k)
    localToKeys.delete(name)
  }

  const walk = (node, parent, pi) => {
    if (!Array.isArray(node)) return
    const op = node[0]

    const m = matchSite(node, parent, pi)
    if (m) {
      let region = open.get(m.key)
      if (!region) {
        region = []
        let regs = regions.get(m.key)
        if (!regs) { regs = []; regions.set(m.key, regs) }
        regs.push(region)
        open.set(m.key, region)
        for (const d of m.deps) addDep(d, m.key)
        region.push({ parent, idx: pi, role: 'tee' })
      } else {
        region.push({ parent, idx: pi, role: 'get' })
      }
      return  // children are local.gets — they're reads, not interesting
    }

    if ((op === 'local.set' || op === 'local.tee') && typeof node[1] === 'string') {
      const x = node[1]
      // Walk value first — it may contain a site referencing pre-write X.
      for (let i = 2; i < node.length; i++) walk(node[i], node, i)
      closeForLocal(x)
      return
    }

    if (op === 'if') {
      let i = 1
      while (i < node.length && Array.isArray(node[i]) && node[i][0] === 'result') i++
      if (i < node.length) walk(node[i], node, i)
      i++
      let thenArm = null, elseArm = null
      for (; i < node.length; i++) {
        const c = node[i]
        if (Array.isArray(c)) {
          if (c[0] === 'then') thenArm = c
          else if (c[0] === 'else') elseArm = c
        }
      }
      const beforeArms = new Map(open)
      let afterThen = beforeArms
      if (thenArm) {
        for (let j = 1; j < thenArm.length; j++) walk(thenArm[j], thenArm, j)
        afterThen = new Map(open)
      }
      open.clear()
      for (const [k, v] of beforeArms) open.set(k, v)
      let afterElse = beforeArms
      if (elseArm) {
        for (let j = 1; j < elseArm.length; j++) walk(elseArm[j], elseArm, j)
        afterElse = new Map(open)
      }
      // Merge: alive after if iff alive on BOTH paths with same region ref.
      open.clear()
      for (const [k, vT] of afterThen) {
        if (afterElse.get(k) === vT) open.set(k, vT)
      }
      return
    }

    if (op === 'loop') {
      open.clear()
      for (let i = 1; i < node.length; i++) walk(node[i], node, i)
      open.clear()
      return
    }

    for (let i = 0; i < node.length; i++) walk(node[i], node, i)
  }

  for (let i = bodyStart; i < fn.length; i++) walk(fn[i], fn, i)

  if (regions.size === 0) return

  // Commit: ≥2 sites per region to be worthwhile (a singleton is pure cost).
  let hoistId = nextLocalId(fn, localPrefix)
  const locals = []
  for (const [, regs] of regions) {
    let usable = false
    for (const r of regs) if (r.length >= 2) { usable = true; break }
    if (!usable) continue
    const tLocal = `$__${localPrefix}${hoistId++}`
    locals.push(['local', tLocal, localType])
    for (const r of regs) {
      if (r.length < 2) continue
      for (let i = 0; i < r.length; i++) {
        const { parent, idx, role } = r[i]
        if (role === 'tee') parent[idx] = ['local.tee', tLocal, parent[idx]]
        else parent[idx] = ['local.get', tLocal]
      }
    }
  }
  if (locals.length) fn.splice(bodyStart, 0, ...locals)
}

/**
 * CSE repeated `(i32.add (local.get $A) (i32.shl (local.get $B) (i32.const K)))`
 * — the shape jz emits for `arr[idx + k]` typed-array reads after foldMemargOffsets
 * absorbs the constant K into `offset=`. The remaining base expression is
 * recomputed once per `arr[…]` read; biquad's inner cascade has 9 such reads
 * sharing 2 base shapes per iteration. V8's CSE usually catches this, but emitting
 * the share explicitly avoids relying on tier-up and helps wasm2c / wasm-opt too.
 *
 * Same region-tracking discipline as hoistPtrType: open region per key, closed
 * by re-assignment to either A or B; loop entry/exit clears all open regions.
 *
 * Must run AFTER fusedRewrite — relies on shl-distribution + assoc-lift +
 * foldMemargOffsets having normalized the base shape.
 */
// Pure i32 ops whose value is a function of locals/consts alone — no memory read,
// no call, no global. A subscript expression built only from these is invariant
// between two sites as long as none of its local deps is rewritten between them,
// so CSE-ing the WHOLE address (base + shl(idx)) is value-safe — even when `idx`
// is a compound stencil offset like `(i32.sub (i32.add idx W) 1)` for `arr[idx+W-1]`.
const PURE_I32_ADDR_OPS = new Set([
  'i32.add', 'i32.sub', 'i32.mul', 'i32.shl', 'i32.shr_s', 'i32.shr_u',
  'i32.and', 'i32.or', 'i32.xor', 'i32.wrap_i64',
])
// Serialize a pure-i32 subscript to a stable key, accumulating its local deps.
// Returns null if any leaf isn't a local.get / i32.const / pure-i32 op (a load,
// call, or global.get could change between sites — not CSE-safe by local tracking).
function pureI32AddrKey(node, deps) {
  if (!Array.isArray(node)) return null
  const op = node[0]
  if (op === 'local.get' && typeof node[1] === 'string') { deps.add(node[1]); return `$${node[1]}` }
  if (op === 'i32.const' && typeof node[1] === 'number') return `#${node[1]}`
  if (!PURE_I32_ADDR_OPS.has(op)) return null
  let key = op + '('
  for (let i = 1; i < node.length; i++) {
    const sub = pureI32AddrKey(node[i], deps)
    if (sub == null) return null
    key += sub + ','
  }
  return key + ')'
}

export function hoistAddrBase(fn) {
  return regionTrackCSE(fn, {
    matchSite(node) {
      if (node[0] !== 'i32.add' || node.length !== 3) return null
      const a = node[1], b = node[2]
      // Two orderings: (add (get A) (shl IDX (const K))) or (add (shl …) (get A))
      let baseGet, shlNode
      if (Array.isArray(a) && a[0] === 'local.get' && typeof a[1] === 'string' &&
          Array.isArray(b) && b[0] === 'i32.shl' && b.length === 3) {
        baseGet = a; shlNode = b
      } else if (Array.isArray(b) && b[0] === 'local.get' && typeof b[1] === 'string' &&
                 Array.isArray(a) && a[0] === 'i32.shl' && a.length === 3) {
        baseGet = b; shlNode = a
      } else return null
      const idx = shlNode[1], shamt = shlNode[2]
      if (!Array.isArray(shamt) || shamt[0] !== 'i32.const' || typeof shamt[1] !== 'number') return null
      // idx may be a plain `local.get` (the original biquad case) or any compound
      // pure-i32 subscript (stencil neighbour `arr[idx+W-1]`); both CSE the same way.
      const deps = new Set([baseGet[1]])
      const idxKey = pureI32AddrKey(idx, deps)
      if (idxKey == null) return null
      return { key: `${baseGet[1]}|${idxKey}|${shamt[1]}`, deps: [...deps] }
    },
    localPrefix: 'ab',
    localType: 'i32',
  })
}

// wasm comparison ops — each yields an i32 that is exactly 0 or 1.
const BOOL_RESULT_OPS = new Set([
  'i32.eqz', 'i64.eqz',
  'i32.eq', 'i32.ne', 'i32.lt_s', 'i32.lt_u', 'i32.gt_s', 'i32.gt_u', 'i32.le_s', 'i32.le_u', 'i32.ge_s', 'i32.ge_u',
  'i64.eq', 'i64.ne', 'i64.lt_s', 'i64.lt_u', 'i64.gt_s', 'i64.gt_u', 'i64.le_s', 'i64.le_u', 'i64.ge_s', 'i64.ge_u',
  'f32.eq', 'f32.ne', 'f32.lt', 'f32.gt', 'f32.le', 'f32.ge',
  'f64.eq', 'f64.ne', 'f64.lt', 'f64.gt', 'f64.le', 'f64.ge',
])

/**
 * `f64 ± (cond ? 1 : 0)` → branchless f64 `select`, killing the i32↔f64 domain cross.
 *
 * `err = old - (old >= t)` and friends compile to `f64.sub(X, f64.convert_i32_s(cmp))`.
 * The convert (cvtsi2sd) round-trips the comparison result out of a GPR back into an
 * XMM register — a domain-crossing op that sits ON the value's def chain. In the
 * per-pixel error-diffusion sweeps (Floyd–Steinberg / Atkinson / JJN) and scalar IIR
 * thresholds this chain is the loop-carried critical path, so that one cross roughly
 * doubles the per-step latency (V8 keeps the JS threshold entirely in the FP domain).
 *
 * `X - (B?1:0) ≡ (B ? X-1 : X) ≡ select(X-1, X, B)`  (likewise `+` → `select(X+1, X, B)`),
 * which never leaves the f64 domain. `select` evaluates BOTH arms, so X must be a
 * side-effect-free duplicable leaf (a `local.get`/const); B is the i32 condition,
 * evaluated once (exactly as the convert did). A pure win on latency-bound recurrences;
 * speed-gated (it adds a const + an arithmetic op — a size↔speed trade) — off at 'size'.
 */
function boolConvertToSelect(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  // Pass 1 — a local whose SOLE definition is a comparison carries a value ∈ {0,1};
  // `err = old - on` (on reused by putBW) reaches us as `convert(local.get $on)`.
  // A param is EXCLUDED even if reassigned once by a comparison: its incoming arg is
  // unconstrained, so a read before the reassignment isn't 0/1. (A plain local read
  // before its def is safe — wasm zero-inits it to 0 = false, which select preserves.)
  const params = new Set()
  for (let i = 2; i < fn.length; i++) if (Array.isArray(fn[i]) && fn[i][0] === 'param') params.add(fn[i][1])
  const defCount = new Map(), defIsCmp = new Map()
  const scan = (n) => {
    if (!Array.isArray(n)) return
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') {
      defCount.set(n[1], (defCount.get(n[1]) || 0) + 1)
      const cmp = Array.isArray(n[2]) && BOOL_RESULT_OPS.has(n[2][0])
      defIsCmp.set(n[1], (defIsCmp.has(n[1]) ? defIsCmp.get(n[1]) : true) && cmp)
    }
    for (let i = 1; i < n.length; i++) scan(n[i])
  }
  scan(fn)
  const boolLocals = new Set()
  for (const [name, c] of defCount) if (c === 1 && defIsCmp.get(name) && !params.has(name)) boolLocals.add(name)

  const isBool01 = (n) => Array.isArray(n) &&
    (BOOL_RESULT_OPS.has(n[0]) || (n[0] === 'local.get' && boolLocals.has(n[1])))
  const dup = (n) => Array.isArray(n) ? n.map(dup) : n

  // Pass 2 — bottom-up rewrite.
  const rewrite = (n) => {
    if (!Array.isArray(n)) return n
    for (let i = 1; i < n.length; i++) n[i] = rewrite(n[i])
    if ((n[0] === 'f64.sub' || n[0] === 'f64.add') && n.length === 3) {
      const conv = (m) => Array.isArray(m) && (m[0] === 'f64.convert_i32_s' || m[0] === 'f64.convert_i32_u') && isBool01(m[1])
      // `X - bool`, `X + bool`, or (add is commutative) `bool + X`.
      let X = null, B = null
      if (conv(n[2]) && isLeaf(n[1])) { X = n[1]; B = n[2][1] }
      else if (n[0] === 'f64.add' && conv(n[1]) && isLeaf(n[2])) { X = n[2]; B = n[1][1] }
      if (X) return ['select', [n[0], dup(X), ['f64.const', 1]], dup(X), B]
    }
    return n
  }
  rewrite(fn)
}

/**
 * Hoist `(call $__ptr_offset (local.get $X))` to a function-entry snapshot
 * when X is an f64-NaN-boxed parameter that's never reassigned and only ever
 * passed to known-pure helpers. Aos-style hot loops read `rows[i]` once per
 * iteration; without this, V8 keeps re-extracting the offset each time.
 *
 * Safety: __ptr_offset on an Array follows the realloc-forwarding chain. Once
 * a function commits to "this param won't realloc inside me", caching is
 * sound for the duration. The whitelist below is the read-only set
 * (no mutation possible); any other callee touching X invalidates hoisting.
 */
// Read-only i32-returning calls: safe to hoist when operands are invariant,
// and their presence in a loop must not block other hoists (hasUnsafeCall).
// __jss_* are wasm:js-string host builtins over IMMUTABLE JS strings — pure by
// the same argument as the __ptr_* helpers (charCodeAt won't itself hoist —
// its index varies — but whitelisting it keeps hasUnsafeCall false so the
// loop-invariant __jss_length in the same loop condition CAN hoist).
const SAFE_OFFSET_CALLS = new Set(['$__ptr_offset', '$__ptr_type', '$__ptr_aux', '$__len', '$__jss_length', '$__jss_charCodeAt'])

// wasm comparison-op mantissas (the part after the `.`): they yield i32 regardless of
// operand width (i64.eq, f64.lt, i32.ge_s, …). `eq`/`ne` are sign-agnostic; the ordered
// compares carry `_s`/`_u` for the integer types and none for f64. Used by resultType to
// type a hoisted subtree by its root op. A Set membership test, NOT a regex
// (`/^(eq|ne|lt|gt|le|ge)(_[su])?$/`): the regex mis-anchored under self-host −O2 — `nearest`
// (the f64.nearest mantissa, from Math.round) starts with `ne`, and the embedded −O2 build
// matched it as a comparison → the LICM hoist local got typed i32, so `local.set $__li
// (f64.nearest …)` emitted invalid wasm (f64 into i32) only in the kernel. Explicit string
// membership is both self-host-robust and cheaper in this LICM-hot path.
const CMP_MANTISSA = new Set([
  'eqz', 'eq', 'ne', 'lt', 'gt', 'le', 'ge',
  'lt_s', 'lt_u', 'gt_s', 'gt_u', 'le_s', 'le_u', 'ge_s', 'ge_u',
])

// Calls that don't modify EXISTING heap memory: they may allocate (bump the heap
// pointer) or do tag dispatch, but they never write to an address a hoisted
// __typed_idx/__str_idx element read would revisit. Their presence must not
// block readonly-mem-call LICM (else any `s += unknown` — which dispatches via
// __is_str_key/__str_concat — would pin every invariant array element in-loop:
// the jagged-array `grid[i][j]` deopt).
// $__mkptr is pure bit-packing over its i32 args (no memory access at all) — its
// only loop-body producer is the in-place replace-store's re-boxed result, which
// otherwise pinned the loop's `__ptr_offset(arr)` base resolution in-body (the
// immutable-update kernel paid the full forwarding+bounds dance per iteration).
const NON_MUTATING_CALLS = new Set(['$__is_str_key', '$__str_concat', '$__to_num', '$__to_str', '$__str_byteLen', '$__mkptr'])

// Read-only HEAP-MEMORY calls: like SAFE_OFFSET_CALLS but they read element
// storage that a direct f64.store/i32.store in the loop could alias. Safe to
// hoist only when the loop has no mutating call AND no direct store at all (we
// can't do alias analysis at WAT level). __typed_idx/__str_idx read arr[i] /
// s[i]; plain-array element writes go through calls (caught by hasUnsafeCall),
// and typed-array writes are direct stores (caught by hasDirectStore) — so the
// guard covers both. This is what lets LICM hoist `grid[i]` out of a read-only
// `for(j) { ... grid[i][j] ... }` inner loop (the jagged-array deopt).
const READONLY_MEM_CALLS = new Set(['$__typed_idx', '$__str_idx'])

// PURE FUNCTION calls — result is a function of the ARGUMENTS alone, with no
// dependence on mutable state: math reads no memory; the string search/compare
// helpers read only their operands' bytes, and jz strings are IMMUTABLE, so their
// content can't change under the loop's stores. So on loop-invariant args the
// RESULT is loop-invariant regardless of anything else the loop does (unlike a
// READONLY_MEM_CALLS element read, which an aliasing store could invalidate — no
// !hasDirectStore guard is needed here). Speculative pre-header execution can't
// trap: math returns NaN/∞ rather than trapping, and a value reaching .indexOf/===
// is a valid string (in-bounds reads). This is the LICM V8's wasm tier won't do —
// it treats every call as opaque and recomputes the search/transcendental each
// iteration. (Math.random is INLINED — it mutates a global PRNG seed, never a
// `$math.` call — but exclude it by name defensively; $__str_eq_cold is the cold
// half of __str_eq, equally pure.) $__length stays OUT: it is polymorphic over
// MUTABLE arrays (push changes it), so it isn't arg-pure. $__str_byteLen is IN:
// its operand is a string (immutable), and the one in-place length mutator —
// the heap-top bump-extend twins (module/string.js) — is only emitted where the
// OLD string value is provably dead, so a live, loop-invariant operand's length
// cannot change under the loop (`for (j = 0; j < line.length; j++)` hoists to
// one call instead of one per character — the strbuild row-scan shape).
const PURE_CALL_I32 = new Set(['$__str_indexof', '$__str_lastindexof', '$__str_eq', '$__str_eq_cold', '$__is_str_key', '$__str_byteLen'])
const isPureFnCall = (callee) =>
  typeof callee === 'string' &&
  ((callee.startsWith('$math.') && !callee.startsWith('$math.random')) || PURE_CALL_I32.has(callee))

export function hoistInvariantPtrOffset(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  const params = new Set()
  for (let i = 2; i < fn.length; i++) {
    const c = fn[i]
    if (!Array.isArray(c)) continue
    if (c[0] !== 'param') continue
    if (typeof c[1] === 'string' && c[2] === 'f64') params.add(c[1])
  }
  if (!params.size) return

  const sites = new Map()
  const unsafe = new Set()

  const walk = (node, parent, pi) => {
    if (!Array.isArray(node)) return
    const op = node[0]

    if (op === 'local.set' || op === 'local.tee') {
      if (typeof node[1] === 'string' && params.has(node[1])) unsafe.add(node[1])
      for (let i = 2; i < node.length; i++) walk(node[i], node, i)
      return
    }

    if (op === 'call') {
      const callee = node[1]
      if (callee === '$__ptr_offset' && node.length === 3) {
        const a = node[2]
        // Post-i64 migration: arg may be (i64.reinterpret_f64 (local.get X)).
        const inner = (Array.isArray(a) && a[0] === 'i64.reinterpret_f64' && a.length === 2) ? a[1] : a
        if (Array.isArray(inner) && inner[0] === 'local.get' && typeof inner[1] === 'string' && params.has(inner[1])) {
          let arr = sites.get(inner[1])
          if (!arr) { arr = []; sites.set(inner[1], arr) }
          arr.push({ parent, idx: pi })
          return
        }
      }
      const isSafe = SAFE_OFFSET_CALLS.has(callee)
      for (let i = 2; i < node.length; i++) {
        const arg = node[i]
        const inner = (Array.isArray(arg) && arg[0] === 'i64.reinterpret_f64' && arg.length === 2) ? arg[1] : arg
        if (Array.isArray(inner) && inner[0] === 'local.get' && typeof inner[1] === 'string' && params.has(inner[1])) {
          if (!isSafe) unsafe.add(inner[1])
          continue
        }
        walk(arg, node, i)
      }
      return
    }

    if (op === 'call_indirect' || op === 'call_ref') {
      for (let i = 1; i < node.length; i++) {
        const arg = node[i]
        if (Array.isArray(arg) && arg[0] === 'local.get' && typeof arg[1] === 'string' && params.has(arg[1])) {
          unsafe.add(arg[1])
          continue
        }
        walk(arg, node, i)
      }
      return
    }

    for (let i = 0; i < node.length; i++) walk(node[i], node, i)
  }

  for (let i = bodyStart; i < fn.length; i++) walk(fn[i], fn, i)

  if (sites.size === 0) return

  let hoistId = nextLocalId(fn, 'po')

  const newLocals = []
  const snaps = []
  for (const [X, arr] of sites) {
    if (unsafe.has(X)) continue
    if (arr.length < 2) continue
    const tLocal = `$__po${hoistId++}`
    newLocals.push(['local', tLocal, 'i32'])
    snaps.push(['local.set', tLocal, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', X]]]])
    for (const { parent, idx } of arr) {
      parent[idx] = ['local.get', tLocal]
    }
  }

  if (newLocals.length) fn.splice(bodyStart, 0, ...newLocals, ...snaps)
}


// Non-trapping, side-effect-free ops whose result is a pure function of their
// operands. Hoisting one to the pre-header is sound iff its operands are loop-
// invariant: same value every iteration, no traps, no memory/global effects.
// DELIBERATELY EXCLUDES trapping ops — i32/i64 div_s/u & rem_s/u (trap on 0),
// non-saturating trunc_f64 (trap on overflow/NaN) — because hoisting a trap to
// the pre-header would fire it even when the loop runs zero times. Loads and
// calls are NOT here; they are admitted by `pureGiven` only under the loop's
// effect-summary barriers (cell loads with no aliasing store/call; the read-only
// __ptr_* call whitelist with no other call).
// Boxed-capture cells are `freshLocal`-generated, so the name carries the T
// (U+E000) prefix: `$<T>cell_<var>`. Built from the constant — a hand-typed
// `'$cell_'` literal silently omits the invisible T and never matches.
const CELL_PREFIX = '$' + T + 'cell_'

// Ops V8's wasm tier (TurboFan) will NOT hoist out of a loop itself: saturating
// f64→int truncation and `select` are not LICM-eligible there, memory loads are
// blocked by conservative aliasing, and calls are opaque. These are the ONLY
// things worth hoisting — V8 already does general arithmetic LICM, and hoisting
// pure arithmetic ourselves only bloats the body and breaks the lane-vectorizer's
// straight-line pattern match. So a subtree is hoisted only if it contains one.
const HARD_OPS = new Set([
  'i64.trunc_sat_f64_s', 'i64.trunc_sat_f64_u', 'i32.trunc_sat_f64_s', 'i32.trunc_sat_f64_u',
  'select', 'f64.load', 'i32.load', 'call',
])
const hasHardOp = (n) => Array.isArray(n) && (HARD_OPS.has(n[0]) || n.some((c, i) => i > 0 && hasHardOp(c)))

// The inline typed-array base decode `(i32.wrap_i64 (i64.and (i64.reinterpret_f64
// (local|global X)) 0xFFFFFFFF))` — what `typedBase` emits for a NaN-boxed pointer.
// V8's wasm tier does NOT reliably LICM this i64 reinterpret chain, and it carries no
// HARD_OP, so without this it stays per-element inside the loop. It is the typed-read
// equivalent of the `__ptr_offset` call (a HARD_OP) that hoistGlobalPtrOffset hoists at
// function scope; admitting it here also covers a pointer reassigned ELSEWHERE in the
// function (the ping-pong double-buffer `a = b` in wireworld / any CA), where the base
// is invariant within each loop but not function-wide.
const isPtrBaseDecode = (n) =>
  Array.isArray(n) && n[0] === 'i32.wrap_i64' && n.length === 2 &&
  Array.isArray(n[1]) && n[1][0] === 'i64.and' && n[1].length === 3 &&
  Array.isArray(n[1][2]) && n[1][2][0] === 'i64.const' &&
  (typeof n[1][2][1] === 'string' ? Number(n[1][2][1]) : n[1][2][1]) === LAYOUT.OFFSET_MASK &&
  Array.isArray(n[1][1]) && n[1][1][0] === 'i64.reinterpret_f64' && n[1][1].length === 2 &&
  Array.isArray(n[1][1][1]) && (n[1][1][1][0] === 'local.get' || n[1][1][1][0] === 'global.get')

const PURE_LICM_OPS = new Set([
  'f64.add', 'f64.sub', 'f64.mul', 'f64.div', 'f64.neg', 'f64.abs', 'f64.sqrt',
  'f64.min', 'f64.max', 'f64.ceil', 'f64.floor', 'f64.trunc', 'f64.nearest', 'f64.copysign',
  'i32.add', 'i32.sub', 'i32.mul', 'i32.and', 'i32.or', 'i32.xor',
  'i32.shl', 'i32.shr_s', 'i32.shr_u', 'i32.rotl', 'i32.rotr', 'i32.clz', 'i32.ctz', 'i32.popcnt', 'i32.eqz',
  'i64.add', 'i64.sub', 'i64.mul', 'i64.and', 'i64.or', 'i64.xor',
  'i64.shl', 'i64.shr_s', 'i64.shr_u', 'i64.rotl', 'i64.rotr', 'i64.eqz',
  'f64.eq', 'f64.ne', 'f64.lt', 'f64.gt', 'f64.le', 'f64.ge',
  'i32.eq', 'i32.ne', 'i32.lt_s', 'i32.lt_u', 'i32.gt_s', 'i32.gt_u', 'i32.le_s', 'i32.le_u', 'i32.ge_s', 'i32.ge_u',
  'i64.eq', 'i64.ne', 'i64.lt_s', 'i64.lt_u', 'i64.gt_s', 'i64.gt_u', 'i64.le_s', 'i64.le_u', 'i64.ge_s', 'i64.ge_u',
  'f64.convert_i32_s', 'f64.convert_i32_u', 'f64.convert_i64_s', 'f64.convert_i64_u',
  'i32.trunc_sat_f64_s', 'i32.trunc_sat_f64_u', 'i64.trunc_sat_f64_s', 'i64.trunc_sat_f64_u',
  'i32.wrap_i64', 'i64.extend_i32_s', 'i64.extend_i32_u',
  'f64.reinterpret_i64', 'i64.reinterpret_f64', 'f32.reinterpret_i32', 'i32.reinterpret_f32',
  'f64.promote_f32', 'f32.demote_f64', 'select',
])

// Resolve a load/store address back to the single typed-array PARAM it derives from — through
// `local.get`, the arithmetic in PURE_LICM_OPS, and single-def snap locals ($__li/$__ab) — or
// null if not exactly one / unprovable (a multi-def or unknown local in the address). Built once
// per function over the proven-distinct `distinctParams` set; the alias substrate both LICM
// passes query to hoist a read-only input load across a distinct-buffer store (raytrace's spheres
// vs framebuffer — the alias-analysis LICM rust/clang get for free).
function buildBaseParamOf(fn, bodyStart, distinctParams) {
  if (!distinctParams) return () => null
  const paramNames = new Set()
  for (let i = 2; i < bodyStart; i++)
    if (Array.isArray(fn[i]) && fn[i][0] === 'param' && typeof fn[i][1] === 'string') paramNames.add(fn[i][1])
  const singleDef = new Map(), defCount = new Map()
  const scanDefs = (n) => {
    if (!Array.isArray(n)) return
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') {
      defCount.set(n[1], (defCount.get(n[1]) || 0) + 1); singleDef.set(n[1], n[2]); scanDefs(n[2]); return
    }
    for (let i = 1; i < n.length; i++) scanDefs(n[i])
  }
  for (let i = bodyStart; i < fn.length; i++) scanDefs(fn[i])
  for (const [k, c] of defCount) if (c > 1) singleDef.delete(k)   // multi-def → can't trust the resolution
  return (addr) => {
    const found = new Set(); const seen = new Set(); let bad = false
    const walk = (n) => {
      if (bad || !Array.isArray(n)) return
      if (n[0] === 'local.get' && typeof n[1] === 'string') {
        if (paramNames.has(n[1])) found.add(n[1])
        else if (singleDef.has(n[1]) && !seen.has(n[1])) { seen.add(n[1]); walk(singleDef.get(n[1])) }
        else bad = true   // a written/unknown local in the address → base unprovable
        return
      }
      for (let i = 1; i < n.length; i++) walk(n[i])
    }
    walk(addr)
    return !bad && found.size === 1 ? [...found][0] : null
  }
}

// Per-loop invariance/purity analysis — the single proven predicate both LICM passes share.
// Scans the loop into an effect summary (locals/globals it writes, cells/buffers it stores to,
// whether it has any call / unsafe call / direct store / v128 op), then closes `pureGiven(node,
// bound)` over it: true iff `node` is side-effect-free AND loop-invariant, given that the locals
// in `bound` are private to the candidate (a `local.get` of a bound local reads the in-subtree
// teed invariant; a free `local.get` must be unwritten by the loop). Memory leaves are admitted
// only under the summary: a `$__cell_`/distinct-param load iff no aliasing store + no call; a
// SAFE_OFFSET/READONLY_MEM call iff no unsafe call (+ no direct store for heap reads).
function loopInvariance(loopNode, { distinctParams, baseParamOf, allowPrivateSets = false }) {
  const locals = new Set(), globals = new Set(), storedCells = new Set(), storedBases = new Set()
  let hasUnsafeCall = false, hasAnyCall = false, hasDirectStore = false, hasV128 = false
  const scan = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    // A vectorized loop (lane/v128 ops) is already register-tight and hand-tuned;
    // extra scalar hoisting there only adds spill pressure — keep it conservative.
    if (op.startsWith('v128.') || /^[if]\d+x\d+\./.test(op)) hasV128 = true
    if (op === 'local.set' || op === 'local.tee') { if (typeof node[1] === 'string') locals.add(node[1]); for (let i = 2; i < node.length; i++) scan(node[i]); return }
    if (op === 'global.set') { if (typeof node[1] === 'string') globals.add(node[1]); for (let i = 2; i < node.length; i++) scan(node[i]); return }
    if (op === 'call') { hasAnyCall = true; if (!SAFE_OFFSET_CALLS.has(node[1]) && !READONLY_MEM_CALLS.has(node[1]) && !NON_MUTATING_CALLS.has(node[1]) && !isPureFnCall(node[1])) hasUnsafeCall = true; for (let i = 2; i < node.length; i++) scan(node[i]); return }
    if (op === 'call_ref' || op === 'call_indirect') { hasAnyCall = hasUnsafeCall = true; for (let i = 1; i < node.length; i++) scan(node[i]); return }
    if ((op === 'f64.store' || op === 'i32.store') && node.length >= 3) {
      hasDirectStore = true
      const a = node[1]
      if (Array.isArray(a) && a[0] === 'local.get' && typeof a[1] === 'string' && a[1].startsWith(CELL_PREFIX)) storedCells.add(a[1])
      if (distinctParams) { const sb = baseParamOf(a); if (sb) storedBases.add(sb) }   // alias: which buffers this loop writes
    }
    for (let i = 1; i < node.length; i++) scan(node[i])
  }
  for (let i = 1; i < loopNode.length; i++) scan(loopNode[i])

  const pureGiven = (node, bound) => {
    if (!Array.isArray(node)) return true   // bare operand string/number
    const op = node[0]
    if (op === 'i32.const' || op === 'i64.const' || op === 'f64.const' || op === 'f32.const') return true
    if (op === 'local.get') return typeof node[1] === 'string' && (bound.has(node[1]) || !locals.has(node[1]))
    // A global is invariant only if not set directly AND no UNSAFE call in the loop —
    // an unproven callee may mutate it (no interprocedural effect analysis). SAFE_OFFSET/
    // READONLY_MEM/NON_MUTATING/pure calls are jz's own runtime helpers, audited to never
    // touch a user global, so they don't block this the way an arbitrary call does — same
    // distinction READONLY_MEM_CALLS purity already makes below. (Locals are frame-private,
    // so calls can't touch them; only direct local.set matters.)
    if (op === 'global.get') return typeof node[1] === 'string' && !globals.has(node[1]) && !hasUnsafeCall
    if (op === 'local.tee') {
      if (typeof node[1] !== 'string') return false
      // The operand is evaluated BEFORE the tee writes $X, so a `local.get $X`
      // inside it reads the loop-carried value, not the newly written one.
      const inner = bound.has(node[1]) ? new Set([...bound].filter(b => b !== node[1])) : bound
      return pureGiven(node[2], inner)
    }
    if (op === 'local.set') {
      if (!allowPrivateSets || typeof node[1] !== 'string' || !bound.has(node[1])) return false
      const inner = new Set([...bound].filter(b => b !== node[1]))
      return pureGiven(node[2], inner)
    }
    if ((op === 'f64.load' || op === 'i32.load') && node.length === 2) {
      const a = node[1]
      if (Array.isArray(a) && a[0] === 'local.get' && typeof a[1] === 'string' && a[1].startsWith(CELL_PREFIX)
        && !hasAnyCall && !storedCells.has(a[1]) && (bound.has(a[1]) || !locals.has(a[1]))) return true
      // Alias-analysis LICM: a load from a typed-array param PROVEN distinct from every buffer
      // this loop writes (base ∉ storedBases) is loop-invariant when its address is invariant —
      // even across the loop's stores, because they can't alias it. This is what lets rust/clang
      // hoist read-only input arrays out of a write loop (raytrace's spheres vs the framebuffer).
      // `pureGiven(a, bound)` proves the address itself invariant (base param unwritten + invariant
      // offset); the calls guard rules out callee memory mutation.
      if (distinctParams && !hasAnyCall) {
        const base = baseParamOf(a)
        if (base && distinctParams.has(base) && !storedBases.has(base) && pureGiven(a, bound)) return true
      }
      return false
    }
    if (op === 'call') {
      // Pure-function call: invariant iff its ARGS are. No effect-summary barrier —
      // its result depends on nothing the loop can mutate (math: no memory; string
      // search/compare: immutable operands), so neither a store nor another call
      // can invalidate it. This hoists the loop-invariant transcendental / substr
      // search V8's wasm tier recomputes every iteration.
      if (isPureFnCall(node[1]))
        return node.slice(2).every(c => pureGiven(c, bound))
      if (SAFE_OFFSET_CALLS.has(node[1]))
        return !hasUnsafeCall && node.slice(2).every(c => pureGiven(c, bound))
      // Read-only heap reads: additionally require no direct store (alias-safe).
      if (READONLY_MEM_CALLS.has(node[1]))
        return !hasUnsafeCall && !hasDirectStore && node.slice(2).every(c => pureGiven(c, bound))
      return false
    }
    // A value-producing block with private scratch sets is pure when every
    // statement is pure. This is the canonical-NaN wrapper shape emitted for
    // `const ox = -typed[i]`: block(result f64, set tmp, select …). The caller's
    // bound/private-use proof is what makes moving the internal set sound.
    if (op === 'block' && allowPrivateSets) {
      for (let i = 1; i < node.length; i++) {
        const c = node[i]
        if (!Array.isArray(c) || c[0] === 'result') continue
        if (!pureGiven(c, bound)) return false
      }
      return true
    }
    // A value-producing `if` whose condition and both arms are pure is itself
    // pure — the tag-dispatch idiom `(if (result f64) tag-check (then read-A)
    // (else read-B))` that wraps __typed_idx/__str_idx element access.
    if (op === 'if') {
      for (let i = 1; i < node.length; i++) {
        const c = node[i]
        if (!Array.isArray(c)) continue
        if (c[0] === 'result') continue
        if (c[0] === 'then' || c[0] === 'else') { if (!c.slice(1).every(x => pureGiven(x, bound))) return false }
        else if (!pureGiven(c, bound)) return false   // the condition
      }
      return true
    }
    if (PURE_LICM_OPS.has(op)) return node.slice(1).every(c => pureGiven(c, bound))
    return false
  }
  return { pureGiven, locals, globals, storedCells, storedBases, hasUnsafeCall, hasAnyCall, hasDirectStore, hasV128 }
}

/**
 * Unified loop-invariant code motion. One principle replaces the three former
 * pattern hoists (ToInt32 / __ptr_offset / cell-load): a MAXIMAL pure subtree
 * whose every free input is loop-invariant is computed once before the loop, in
 * a fresh snap local.
 *
 * Invariance/purity (`pureGiven`) is closed over PURE_LICM_OPS plus two memory-
 * touching leaves admitted only under the loop's effect summary (`collectMutations`):
 *   - (f64.load (local.get $cell_X))   iff no f64.store to $cell_X and no call in loop
 *   - (call $__ptr_offset|__ptr_type|__ptr_aux|__len …)  iff no non-whitelisted call
 * — exactly the old per-pass barriers, generalized. A subtree may also WRITE a
 * local via (local.tee P E) iff P is private to the subtree (occurs nowhere else
 * in the loop); this hoists the guarded-ToInt32 form
 *   (select (i32.wrap_i64 (i64.trunc_sat_f64_s (local.tee P E))) 0 (f64.ne (get P) G))
 * as a unit — which the old leaf-only matcher could not (it needed a bare local).
 *
 * Bottom-up (inner loops first → progressive climbing), refcount-guarded against
 * watr's shared CSE subtrees, snaps spliced before the loop, decls at bodyStart.
 * Idempotent: re-running sees only `(local.get $__liN)` and finds nothing to do.
 */
// SSA-split loop-private straight-line multi-def scratch so the LICM below can hoist
// the invariant versions. jz's unroller MERGES each unrolled iteration's `const x`
// into one multi-def local (e.g. raytrace's sphere loop unrolls 8× sharing $ox/$c),
// which the LICM cannot hoist — so the per-sphere invariant `c_i = sx_i²+sy_i²+sz_i²
// −sr_i²` recomputes every pixel instead of once (the 1.24× rust-wasm gap; rust/LLVM
// keeps them as distinct SSA values and hoists each). Renaming each def to its own
// version makes them single-def → hoistInvariantLoop lifts the loop-invariant ones.
//
// BIT-EXACT: pure renaming + invariant code motion — the same value computed fewer
// times, no reassociation. Gated to loops with NO v128, so it never disturbs a
// vectorized loop (whose unrolled shared names the lane/dot vectorizer relies on).
//
// SOUND only for a local that, within the loop body, (a) is referenced NOWHERE else in
// the function (loop-local lifetime — else a post-loop read of the merged name breaks),
// (b) has every occurrence STRAIGHT-LINE (never under a nested if/block/loop, so a
// linear walk assigns each use its unique dominating def), (c) is first accessed by a
// WRITE (no value carried across the back-edge), (d) is only ever `local.set` (never
// `local.tee`/conditionally defined). Each condition rejects a class that would miscompile.
export function splitLoopPrivateScratch(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return
  const SCALAR = new Set(['i32', 'i64', 'f64', 'f32'])
  const UNROLLED_PREFIXES = [`$${T}ul`, `$${T}us`]
  const isUnrolledScratch = name => UNROLLED_PREFIXES.some(p => name.startsWith(p))
  const localTypes = new Map()
  let hasUnrolledScratch = false
  for (let i = 2; i < bodyStart; i++) {
    const c = fn[i]
    if (Array.isArray(c) && (c[0] === 'param' || c[0] === 'local') && typeof c[1] === 'string') {
      localTypes.set(c[1], c[2])
      if (isUnrolledScratch(c[1])) hasUnrolledScratch = true
    }
  }
  // Demand-driven: ordinary functions retain the allocation-free optimizer
  // path. Only loops expanded by the AST/emitter unrollers mint these names.
  if (!hasUnrolledScratch) return
  // Whole-function reference count per local (to verify a candidate is loop-local).
  const fnRefs = new Map()
  const countRefs = (n) => {
    if (!Array.isArray(n)) return
    if ((n[0] === 'local.get' || n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string')
      fnRefs.set(n[1], (fnRefs.get(n[1]) || 0) + 1)
    for (let i = 1; i < n.length; i++) countRefs(n[i])
  }
  for (let i = bodyStart; i < fn.length; i++) countRefs(fn[i])
  // Same proven alias substrate hoistInvariantLoop uses (re-attached after watOptimize, so it
  // survives into this 'post' pass) — lets pureGiven prove a read-only input-array load distinct
  // from the loop's output store, the SOUND replacement for the old address-local-disjointness
  // heuristic (which assumed two loads/stores in different locals never alias — false in general).
  const distinctParams = fn.distinctParams || null
  const baseParamOf = buildBaseParamOf(fn, bodyStart, distinctParams)

  const hasV128 = (n) => {
    let f = false
    const w = (x) => { if (f || !Array.isArray(x)) return; const o = x[0]; if (typeof o === 'string' && (o.startsWith('v128') || /x(2|4|8|16)\b/.test(o) || o.includes('x2.') || o.includes('x4.') || o.includes('x8.') || o.includes('x16.'))) { f = true; return } for (let i = 1; i < x.length; i++) w(x[i]) }
    w(n); return f
  }
  let minted = 0
  const newDecls = []

  const processLoop = (loop, parent, idx) => {
    if (loop[0] !== 'loop' || hasV128(loop)) return
    // Candidate names: locals set somewhere directly in the loop's statement list.
    const seen = new Set()
    for (let i = 2; i < loop.length; i++) {
      const s = loop[i]
      if (Array.isArray(s) && s[0] === 'local.set' && typeof s[1] === 'string' && isUnrolledScratch(s[1])) seen.add(s[1])
    }
    // Stage 1 — collect SAFE candidates (loop-local, straight-line, first-write, set-only,
    // ≥2 defs) and record each one's def RHS list for the invariance fixpoint.
    const cand = new Map()  // name → { defs: [rhs…] }
    for (const name of seen) {
      if (!SCALAR.has(localTypes.get(name))) continue
      let inLoop = 0
      const cnt = (n) => { if (!Array.isArray(n)) return; if ((n[0] === 'local.get' || n[0] === 'local.set' || n[0] === 'local.tee') && n[1] === name) inLoop++; for (let i = 1; i < n.length; i++) cnt(n[i]) }
      cnt(loop)
      if (inLoop !== (fnRefs.get(name) || 0)) continue
      let safe = true, first = null, defs = []
      const scan = (n, depth) => {
        if (!safe || !Array.isArray(n)) return
        const op = n[0]
        if (op === 'local.tee' && n[1] === name) { safe = false; return }
        if (op === 'local.set' && n[1] === name) {
          if (depth > 0) { safe = false; return }
          if (first === null) first = 'w'
          defs.push(n[2])
          scan(n[2], depth)
          return
        }
        if (op === 'local.get' && n[1] === name) {
          if (depth > 0) { safe = false; return }
          if (first === null) first = 'r'
          return
        }
        const ctrl = op === 'if' || op === 'then' || op === 'else' || op === 'block' || op === 'loop'
        for (let i = 1; i < n.length; i++) scan(n[i], depth + (ctrl ? 1 : 0))
      }
      for (let i = 2; i < loop.length; i++) scan(loop[i], 0)
      if (safe && first === 'w' && defs.length >= 1) cand.set(name, defs)
    }
    if (!cand.size) return
    // Stage 2 — invariance fixpoint over the SHARED proven predicate. `pureGiven(def, hoistable)`
    // decides loop-invariance with hoistInvariantLoop's exact model: a `$__cell_`/distinct-param
    // read-only load is invariant across the loop's stores (sound alias analysis), a global is
    // invariant only without a loop write or call, and the `bound` set (here `hoistable`) carries
    // the cascade — a def reading an already-split sibling is invariant once that sibling moves out
    // (c = ox²+… invariant only after ox hoists). `motionSafe` adds the one extra obligation a
    // whole-assignment MOTION needs beyond value-invariance: no `local.tee` writing a local read
    // elsewhere (pureGiven already rejects set/store/global.set/unsafe-call). This replaces the old
    // address-local-disjointness load test, which was unsound in general (two distinct locals can
    // hold the same address) and only worked by luck on the bench shapes.
    const { pureGiven } = loopInvariance(loop, { distinctParams, baseParamOf, allowPrivateSets: true })
    const motionSafe = (n) => { if (!Array.isArray(n)) return true; if (n[0] === 'local.tee') return false; for (let i = 1; i < n.length; i++) if (!motionSafe(n[i])) return false; return true }
    const countName = (n, name) => {
      if (!Array.isArray(n)) return 0
      let c = ((n[0] === 'local.get' || n[0] === 'local.set' || n[0] === 'local.tee') && n[1] === name) ? 1 : 0
      for (let i = 1; i < n.length; i++) c += countName(n[i], name)
      return c
    }
    const privateInternalWrites = (def, base) => {
      const bound = new Set(base), writes = new Set()
      const gather = n => {
        if (!Array.isArray(n)) return
        if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') writes.add(n[1])
        for (let i = 1; i < n.length; i++) gather(n[i])
      }
      gather(def)
      for (const name of writes) {
        if (countName(loop, name) !== countName(def, name)) return null
        bound.add(name)
      }
      return bound
    }
    const hoistable = new Set()
    let changed = true
    while (changed) {
      changed = false
      for (const [name, defs] of cand) {
        if (hoistable.has(name)) continue
        if (defs.every(d => {
          const bound = privateInternalWrites(d, hoistable)
          return bound && motionSafe(d) && pureGiven(d, bound)
        })) { hoistable.add(name); changed = true }
      }
    }
    // Stage 3 — one linear pass over the loop body: each hoistable def is RENAMED to a
    // fresh version and MOVED OUT of the loop (before it), in source order so the cascade's
    // data deps stay intact (c = ox²+… emitted after ox). The cheap arithmetic AND the load
    // both leave the loop; gets stay, rebound to the moved version. (hoistInvariantLoop only
    // snapshots expensive subexprs, not whole invariant assignments — so we do the motion.)
    const curOf = new Map()
    const rewriteGets = (n) => {
      if (!Array.isArray(n)) return n
      if (n[0] === 'local.get' && curOf.has(n[1])) return ['local.get', curOf.get(n[1])]
      return n.map((c, i) => i === 0 ? c : rewriteGets(c))
    }
    const hoisted = []
    const kept = loop.slice(0, 2)  // 'loop' + label
    for (let i = 2; i < loop.length; i++) {
      const s = loop[i]
      if (Array.isArray(s) && s[0] === 'local.set' && hoistable.has(s[1])) {
        const name = s[1], ty = localTypes.get(name)
        const nv = `$${name.replace(/^\$/, '')}__sr${minted++}`
        newDecls.push(['local', nv, ty]); localTypes.set(nv, ty)
        hoisted.push(['local.set', nv, rewriteGets(s[2])])
        curOf.set(name, nv)
      } else {
        kept.push(rewriteGets(s))
      }
    }
    loop.length = 0
    for (const x of kept) loop.push(x)
    parent.splice(idx, 0, ...hoisted)
  }
  const walk = (parent, idx) => {
    const n = parent[idx]
    if (!Array.isArray(n)) return
    // Recurse first so an inner loop's hoists land before we process the outer loop.
    for (let i = 1; i < n.length; i++) walk(n, i)
    if (n[0] === 'loop') processLoop(n, parent, idx)
  }
  for (let i = bodyStart; i < fn.length; i++) walk(fn, i)
  if (newDecls.length) fn.splice(bodyStart, 0, ...newDecls)
}

export function hoistInvariantLoop(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // Cheap early-out: no loop ⇒ nothing to hoist (skip the buildRefcount walk).
  let hasLoop = false
  const scanLoop = (n) => {
    if (!Array.isArray(n) || hasLoop) return
    if (n[0] === 'loop') { hasLoop = true; return }
    for (let i = 1; i < n.length && !hasLoop; i++) scanLoop(n[i])
  }
  for (let i = bodyStart; i < fn.length && !hasLoop; i++) scanLoop(fn[i])
  if (!hasLoop) return

  // Result wasm type of a hoistable node (for the snap local decl). null ⇒ can't
  // type it ⇒ don't hoist. Param/local types come from the func header.
  const localTypes = new Map()
  for (let i = 2; i < bodyStart; i++) {
    const c = fn[i]
    if (Array.isArray(c) && (c[0] === 'param' || c[0] === 'local') && typeof c[1] === 'string') localTypes.set(c[1], c[2])
  }
  const resultType = (node) => {
    if (!Array.isArray(node)) return null
    const op = node[0]
    if (op === 'select') return resultType(node[1])
    if (op === 'if') {
      // (if (result T) cond (then ...) (else ...)) — type is the result clause.
      for (let i = 1; i < node.length; i++) {
        const c = node[i]
        if (Array.isArray(c) && c[0] === 'result') return c[1]
      }
      return null
    }
    if (op === 'block') {
      for (let i = 1; i < node.length; i++) {
        const c = node[i]
        if (Array.isArray(c) && c[0] === 'result') return c[1]
      }
      return null
    }
    if (op === 'call') {
      // SAFE_OFFSET_CALLS all return i32; READONLY_MEM_CALLS return f64 (NaN-boxed element)
      if (SAFE_OFFSET_CALLS.has(node[1])) return 'i32'
      if (READONLY_MEM_CALLS.has(node[1])) return 'f64'
      if (PURE_CALL_I32.has(node[1])) return 'i32'        // string search/compare → i32
      if (typeof node[1] === 'string' && node[1].startsWith('$math.')) return 'f64'   // transcendentals → f64
      return null
    }
    if (op === 'local.get' || op === 'local.tee') return localTypes.get(node[1]) ?? null
    const dot = op.indexOf('.')
    if (dot < 0) return null
    // Comparisons and `eqz` yield i32 regardless of operand type (i64.eq, f64.lt,
    // i64.eqz, …) — so the operand-type prefix would mistype them. Catch first.
    const m = op.slice(dot + 1)
    if (CMP_MANTISSA.has(m)) return 'i32'
    const p = op.slice(0, dot)
    if (p === 'i32' || p === 'i64' || p === 'f64' || p === 'f32') return p
    return null
  }

  // Collision-proof snap ids: skip EVERY existing $__li id, not just start at the
  // lowest free one. watr can renumber/coalesce locals between the pre- and
  // post-watr optimize phases, leaving a non-contiguous $__li set; a lowest-free +
  // sequential-increment scheme would then re-issue an in-use id (Duplicate local).
  const usedLi = new Set()
  const scanLi = (n) => {
    if (!Array.isArray(n)) return
    if (n[0] === 'local' && typeof n[1] === 'string' && n[1].startsWith('$__li')) {
      const t = n[1].slice(5); if (/^\d+$/.test(t)) usedLi.add(+t)
    }
    for (let i = 0; i < n.length; i++) scanLi(n[i])
  }
  scanLi(fn)
  let snapCounter = 0
  const freshSnap = () => { while (usedLi.has(snapCounter)) snapCounter++; const id = snapCounter++; usedLi.add(id); return `$__li${id}` }
  const newLocals = []
  const refcount = buildRefcount(fn)

  // Alias-analysis substrate for hoisting typed-array PARAM element loads across distinct-base
  // stores. `distinctParams` (stamped by compile/index.js from the param-distinctness pass) is the
  // set of typed-array params PROVEN to be mutually-distinct buffers at every call site. To use it,
  // resolve a load/store address back to the single param it derives from — through `local.get`,
  // `i32.add/sub`, and single-def snap locals ($__li/$__ab from prior ptr-offset hoisting).
  const distinctParams = fn.distinctParams || null
  const baseParamOf = buildBaseParamOf(fn, bodyStart, distinctParams)

  const processLoop = (loopNode, nested) => {
    // Inner loops first (bottom-up) — an inner hoist creates a local.get the
    // outer level can hoist further. Children run in a nested context.
    for (let i = 1; i < loopNode.length; i++)
      if (Array.isArray(loopNode[i])) processNode(loopNode[i], loopNode, i, true)

    // The loop's effect summary + the proven invariance/purity predicate (shared with
    // splitLoopPrivateScratch — see loopInvariance). `locals` is the loop's whole write-set.
    const { pureGiven, locals, hasV128 } = loopInvariance(loopNode, { distinctParams, baseParamOf })

    // Per-subtree local-occurrence counts and write-sets, memoized bottom-up —
    // the tee-privacy check queries them for EVERY candidate node, and the old
    // per-query re-walk (countIn/gatherBound) was quadratic on watr-scale loop
    // bodies (the single largest compile-time hotspot, ~200ms/compile). All
    // queries happen during `collect`, before any splice mutates the loop, so
    // the memo cannot go stale; it is dropped with this processLoop frame.
    const countsMemo = new Map()  // node → Map(local → occurrences in subtree)
    const writesMemoL = new Map() // node → Set(locals written in subtree)
    const EMPTY_COUNTS = new Map(), EMPTY_WRITES = new Set()
    const countsOf = (node) => {
      if (!Array.isArray(node)) return EMPTY_COUNTS
      let m = countsMemo.get(node)
      if (m) return m
      m = new Map()
      const op = node[0]
      if ((op === 'local.get' || op === 'local.set' || op === 'local.tee') && typeof node[1] === 'string')
        m.set(node[1], 1)
      for (let i = 1; i < node.length; i++)
        for (const [k, v] of countsOf(node[i])) m.set(k, (m.get(k) || 0) + v)
      countsMemo.set(node, m)
      return m
    }
    const writesIn = (node) => {
      if (!Array.isArray(node)) return EMPTY_WRITES
      let s = writesMemoL.get(node)
      if (s) return s
      s = new Set()
      if ((node[0] === 'local.set' || node[0] === 'local.tee') && typeof node[1] === 'string') s.add(node[1])
      for (let i = 1; i < node.length; i++) for (const w of writesIn(node[i])) s.add(w)
      writesMemoL.set(node, s)
      return s
    }
    // Whole-loop counts (the former countLocals walk) — one memoized query.
    const localCount = new Map()
    for (let i = 1; i < loopNode.length; i++)
      for (const [k, v] of countsOf(loopNode[i])) localCount.set(k, (localCount.get(k) || 0) + v)

    const isHoistable = (node) => {
      if (!Array.isArray(node)) return false
      const op = node[0]
      // Skip trivial leaves: hoisting a bare get/const buys nothing.
      if (op === 'local.get' || op === 'global.get' || op === 'i32.const' || op === 'i64.const' || op === 'f64.const' || op === 'f32.const') return false
      const bound = writesIn(node)
      // Every local the subtree writes must be private to it (no other use in the
      // loop) — else moving the write to the pre-header changes another reader.
      for (const b of bound) if (localCount.get(b) !== countsOf(node).get(b)) return false
      // Top-level loops: only hoist what V8's wasm tier won't — a HARD_OP or the
      // inline typed-array base decode — and leave plain pure arithmetic to V8's own
      // LICM (which handles single-level loops well). NESTED (inner) loops are
      // different: V8's wasm tier under-hoists invariants out of them (a nested
      // rasterizer/convolution recomputes triangle/row-invariant subexpressions every
      // iteration), so hoist any pure-invariant subtree there. Soundness is unchanged —
      // `pureGiven` already proves the subtree is loop-invariant and side-effect-free.
      return ((nested && !hasV128) || hasHardOp(node) || isPtrBaseDecode(node)) && pureGiven(node, bound)
    }

    // Maximal extraction: take the largest hoistable subtree; don't descend into
    // it. Dedup structurally so a repeated invariant expr shares one snap local.
    const sites = new Map()  // structural key → [{ parent, idx, node }]
    const collect = (node, parent, idx) => {
      if (!Array.isArray(node)) return
      if (node[0] === 'loop') return  // already processed bottom-up
      if (isHoistable(node) && (refcount.get(node) || 0) <= 1 && (refcount.get(parent) || 0) <= 1) {
        // stableNodeKey: hoistable boxed-pointer subtrees carry i64.const NaN-box
        // prefixes (BigInt) that plain JSON.stringify can't serialize, and it also
        // collapses Infinity/-Infinity/NaN→null & -0→0 — both would dedup distinct
        // invariants. (A replacer-based stringify was silently replacer-less
        // in-kernel — the recursive keyer behaves identically host and kernel.)
        const key = stableNodeKey(node)
        let arr = sites.get(key); if (!arr) { arr = []; sites.set(key, arr) }
        arr.push({ parent, idx, node })
        return
      }
      for (let i = 0; i < node.length; i++) collect(node[i], node, i)
    }
    for (let i = 1; i < loopNode.length; i++) collect(loopNode[i], loopNode, i)

    const snaps = []
    for (const [, arr] of sites) {
      const type = resultType(arr[0].node)
      if (type == null) continue
      const snapName = freshSnap()
      newLocals.push(['local', snapName, type])
      snaps.push(['local.set', snapName, arr[0].node])  // reuse first node verbatim
      for (const { parent, idx } of arr) parent[idx] = ['local.get', snapName]
    }
    return snaps
  }

  const processNode = (node, parent, idx, nested = false) => {
    if (!Array.isArray(node)) return
    if (node[0] === 'loop') {
      const snaps = processLoop(node, nested)
      if (snaps.length) parent.splice(idx, 0, ...snaps)
      return
    }
    for (let i = 0; i < node.length; i++) processNode(node[i], node, i, nested)
  }

  for (let i = bodyStart; i < fn.length; i++) processNode(fn[i], fn, i, false)
  if (newLocals.length) fn.splice(bodyStart, 0, ...newLocals)
}

/**
 * Narrow an f64 loop bound to i32. `for (let i = 0; i < n; i++)` with an f64
 * param `n` emits `(f64.lt (f64.convert_i32_s $i) (local.get $n))` — an f64
 * convert+compare every iteration that ALSO blocks the lane-vectorizer (it
 * requires an i32-governed trip count). The naive-DSP export shape
 * `(ptr, n) => { for (i = 0; i < n; i++) … }` therefore never vectorized
 * without a hand-written `n|0`. This pass is that annotation, as a proof.
 *
 * When $i is a proven-non-negative i32 counter and $n is loop-invariant:
 *   convert_i32_s(i) < n  ⟺  i < trunc_sat(ceil(n))      for all i ≥ 0
 *   - fractional n rounds up (i < 5.5 ⟺ i < 6); integral n exact
 *   - NaN: ceil→NaN, trunc_sat→0 ⇒ `i < 0` false — matches the false f64 compare
 *     (THIS case is why i ≥ 0 must be proven: a negative i would flip it true)
 *   - n ≤ −2³¹ saturates to INT32_MIN ⇒ always false — matches
 *   - n ≥ 2³¹ saturates to INT32_MAX ⇒ terminates after 2³¹−1 iterations where
 *     the original wrapped $i negative and spun forever — the only divergence,
 *     pathological in both versions (a JS double counter would keep counting).
 * Non-negativity proof: $i is a non-param i32 local whose EVERY write in the
 * function (counters get re-zeroed between loops) is a non-negative i32.const
 * or `$i + positive-const`. Wrap-around past 2³¹ needs 2³¹ agreeing iterations
 * first, so trajectories are identical in every non-pathological program.
 *
 * Snap `(local.set $__lbK (i32.trunc_sat_f64_s (f64.ceil (local.get $n))))`
 * goes in the loop pre-header (re-snapped per outer iteration when nested —
 * trunc_sat/ceil are total, safe even for zero-trip loops); the compare becomes
 * `(i32.lt_s $i $__lbK)` — the exact shape the lane-vectorizer matches.
 * Bottom-up, refcount-guarded, idempotent (rewritten conds no longer match).
 */
export function narrowLoopBound(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // Cheap early-out: no loop ⇒ nothing to narrow.
  let hasLoop = false
  const scanLoop = (n) => {
    if (!Array.isArray(n) || hasLoop) return
    if (n[0] === 'loop') { hasLoop = true; return }
    for (let i = 1; i < n.length && !hasLoop; i++) scanLoop(n[i])
  }
  for (let i = bodyStart; i < fn.length && !hasLoop; i++) scanLoop(fn[i])
  if (!hasLoop) return

  // Header types. Params are excluded as counters: their init is caller-supplied,
  // so non-negativity is unprovable.
  const localTypes = new Map(), params = new Set()
  for (let i = 2; i < bodyStart; i++) {
    const c = fn[i]
    if (!Array.isArray(c) || typeof c[1] !== 'string') continue
    if (c[0] === 'param') params.add(c[1])
    if (c[0] === 'param' || c[0] === 'local') localTypes.set(c[1], c[2])
  }

  // Every write per local across the WHOLE function — not just in-loop: a counter
  // reused by a later loop is re-zeroed between them, and a negative write
  // anywhere voids the proof.
  const writes = new Map()
  const collectWrites = (n) => {
    if (!Array.isArray(n)) return
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') {
      let arr = writes.get(n[1]); if (!arr) writes.set(n[1], arr = [])
      arr.push(n[2])
    }
    for (let i = 1; i < n.length; i++) collectWrites(n[i])
  }
  for (let i = bodyStart; i < fn.length; i++) collectWrites(fn[i])

  const constVal = (n) => Array.isArray(n) && n[0] === 'i32.const' ? Number(n[1]) : NaN
  const nonNegCounter = (name) => {
    if (params.has(name) || localTypes.get(name) !== 'i32') return false
    const ws = writes.get(name)
    if (!ws) return true  // never written ⇒ stays at default 0
    return ws.every(v => {
      if (!Array.isArray(v)) return false
      if (v[0] === 'i32.const') return Number(v[1]) >= 0
      if (v[0] !== 'i32.add') return false
      if (Array.isArray(v[1]) && v[1][0] === 'local.get' && v[1][1] === name) return constVal(v[2]) > 0
      if (Array.isArray(v[2]) && v[2][0] === 'local.get' && v[2][1] === name) return constVal(v[1]) > 0
      return false
    })
  }

  // Collision-proof snap ids (same scheme as hoistInvariantLoop's $__li).
  const usedLb = new Set()
  const scanLb = (n) => {
    if (!Array.isArray(n)) return
    if (n[0] === 'local' && typeof n[1] === 'string' && n[1].startsWith('$__lb')) {
      const t = n[1].slice(5); if (/^\d+$/.test(t)) usedLb.add(+t)
    }
    for (let i = 0; i < n.length; i++) scanLb(n[i])
  }
  scanLb(fn)
  let lbCounter = 0
  const freshLb = () => { while (usedLb.has(lbCounter)) lbCounter++; const id = lbCounter++; usedLb.add(id); return `$__lb${id}` }
  const newLocals = []
  const refcount = buildRefcount(fn)

  // `i <  bound` as `(f64.lt (convert i) bound)` or mirrored `(f64.gt bound (convert i))`.
  // `i <= bound` as `(f64.le (convert i) bound)` or mirrored `(f64.ge bound (convert i))`.
  const match = (n) => {
    const lt = n[0] === 'f64.lt', gt = n[0] === 'f64.gt', le = n[0] === 'f64.le', ge = n[0] === 'f64.ge'
    const conv = lt || le ? n[1] : gt || ge ? n[2] : null
    const bnd = lt || le ? n[2] : gt || ge ? n[1] : null
    if (!Array.isArray(conv) || conv[0] !== 'f64.convert_i32_s') return null
    const ig = conv[1]
    if (!Array.isArray(ig) || ig[0] !== 'local.get' || typeof ig[1] !== 'string') return null
    if (!Array.isArray(bnd) || bnd[0] !== 'local.get' || typeof bnd[1] !== 'string') return null
    return { ctr: ig[1], bound: bnd[1], op: le || ge ? 'le' : 'lt' }
  }

  const processLoop = (loopNode) => {
    // Inner loops first — their sites belong to their own pre-header (the bound
    // may be written by THIS loop between inner runs).
    for (let i = 1; i < loopNode.length; i++)
      if (Array.isArray(loopNode[i])) processNode(loopNode[i], loopNode, i)

    // Locals written anywhere in this loop (incl. nested) — bound invariance.
    const written = new Set()
    const scanW = (n) => {
      if (!Array.isArray(n)) return
      if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') written.add(n[1])
      for (let i = 1; i < n.length; i++) scanW(n[i])
    }
    for (let i = 1; i < loopNode.length; i++) scanW(loopNode[i])

    const sites = []
    const collect = (node) => {
      if (!Array.isArray(node)) return
      if (node[0] === 'loop') return  // already processed bottom-up
      const m = match(node)
      if (m && (refcount.get(node) || 0) <= 1
            && localTypes.get(m.bound) === 'f64' && !written.has(m.bound)
            && nonNegCounter(m.ctr)) { sites.push({ node, m }); return }
      for (let i = 1; i < node.length; i++) collect(node[i])
    }
    for (let i = 1; i < loopNode.length; i++) collect(loopNode[i])

    // One snap per distinct (bound, op): `i < n` and `i <= n` of the SAME bound
    // need different snapped i32 values (ceil vs floor).
    const snapFor = new Map()
    const snaps = []
    const I32_MIN = -2147483648
    for (const { node, m } of sites) {
      const key = `${m.bound}|${m.op}`
      let snap = snapFor.get(key)
      if (!snap) {
        snap = freshLb()
        snapFor.set(key, snap)
        newLocals.push(['local', snap, 'i32'])
        // `i < n`  ⟺ `i < ceil(n)`: trunc_sat(NaN)=0 makes `i<0` false — matches `i<NaN`;
        //   ±Inf → I32_MAX/I32_MIN, both correct. NaN-safe for free.
        // `i <= n` ⟺ `i <= floor(n)`, BUT trunc_sat(floor(NaN))=0 would make `i<=0` run
        //   one iteration at i=0, while JS (`i<=NaN` is false) runs zero. Guard the NaN
        //   case to I32_MIN (below any non-negative counter ⇒ zero iterations). ±Inf are
        //   already correct (floor(+Inf)→I32_MAX, floor(-Inf)→I32_MIN; Inf==Inf is true).
        snaps.push(['local.set', snap, m.op === 'le'
          ? ['select',
              ['i32.trunc_sat_f64_s', ['f64.floor', ['local.get', m.bound]]],
              ['i32.const', I32_MIN],
              ['f64.eq', ['local.get', m.bound], ['local.get', m.bound]]]
          : ['i32.trunc_sat_f64_s', ['f64.ceil', ['local.get', m.bound]]]])
      }
      node.length = 3
      node[0] = m.op === 'le' ? 'i32.le_s' : 'i32.lt_s'
      node[1] = ['local.get', m.ctr]; node[2] = ['local.get', snap]
    }
    return snaps
  }

  const processNode = (node, parent, idx) => {
    if (!Array.isArray(node)) return
    // Break-block idiom `(block $brk (loop …))`: snaps go BEFORE the block —
    // any statement between the block label and the loop is "foreign content"
    // to the lane-vectorizer's matcher and would defeat the whole point.
    if (node[0] === 'block' && typeof node[1] === 'string' && node.length === 3
        && Array.isArray(node[2]) && node[2][0] === 'loop') {
      const snaps = processLoop(node[2])
      if (snaps.length) parent.splice(idx, 0, ...snaps)
      return
    }
    if (node[0] === 'loop') {
      const snaps = processLoop(node)
      if (snaps.length) parent.splice(idx, 0, ...snaps)
      return
    }
    for (let i = 0; i < node.length; i++) processNode(node[i], node, i)
  }

  for (let i = bodyStart; i < fn.length; i++) processNode(fn[i], fn, i)
  if (newLocals.length) fn.splice(bodyStart, 0, ...newLocals)
}

/**
 * CSE for `(f64.load offset=K (local.get $X))` over straight-line regions
 * where $X is an i32-typed local (an unboxed pointer in jz's value model).
 *
 * Aos hot path: `let p = rows[i]; xs[i] = p.x + p.y*0.25 + r;
 *                ys[i] = p.y - p.z*0.5;
 *                zs[i] = p.z + p.x*0.125`
 * — emits 6 f64.load on $p (each of x/y/z twice); collapses to 3 unique loads
 * shared via tee'd snap locals.
 *
 * Safety: candidacy is the emit-side `cseSafeLoadBases` whitelist (src/analyze.js),
 * stamped onto the func node as `fn.cseLoadBases`. Every base in it is a
 * bound-once unboxed pointer used solely as a member-read receiver whose
 * allocation kind is disjoint from every store the function performs. So
 * `(f64.store ADDR ...)` anywhere in the body cannot touch addresses reachable
 * via `$X + K` for a whitelisted $X — the proof is carried from emit, where the
 * VAL kinds and binding shapes are still known, never re-guessed at WAT level.
 *
 * Region boundaries that flush the table:
 *   - branch (br/br_if/br_table/return/unreachable)
 *   - non-pure call
 *   - loop / if  (control flow)
 *   - local.set/local.tee on a tracked $X (invalidates that X's entries)
 *   - store whose address tree references a tracked $X (defence-in-depth —
 *     the whitelist already guarantees this never happens)
 * Blocks are treated as transparent — recurse into children.
 */
export function cseScalarLoad(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // Soundness gate: only the emit-proven non-aliasing bases. Absent the stamp
  // (e.g. a post-watrOptimize re-run on rebuilt nodes) the set is empty and the
  // pass is a strict no-op — never a speculative CSE.
  const bases = fn.cseLoadBases
  if (!(bases instanceof Set) || bases.size === 0) return

  let snapId = nextLocalId(fn, 'cs')
  const newLocals = []

  // CSE table: key `${X}|${K}` → { snapName | null, anchorParent, anchorIdx }
  const table = new Map()

  const invalidateLocal = (X) => {
    for (const key of table.keys()) {
      if (key.startsWith(`${X}|`)) table.delete(key)
    }
  }

  // Scan a node's subtree and return the set of tracked bases referenced via local.get.
  const collectGets = (node, out) => {
    if (!Array.isArray(node)) return
    if (node[0] === 'local.get' && typeof node[1] === 'string' && bases.has(node[1])) {
      out.add(node[1])
      return
    }
    for (let i = 1; i < node.length; i++) collectGets(node[i], out)
  }

  // Parse f64.load shape; returns { K, addrIdx } or null.
  const parseLoad = (node) => {
    if (!Array.isArray(node) || node[0] !== 'f64.load') return null
    let K = 0, addrIdx = 1
    if (typeof node[1] === 'string' && node[1].startsWith('offset=')) {
      K = parseInt(node[1].slice(7), 10) | 0
      addrIdx = 2
    }
    if (node.length <= addrIdx) return null
    return { K, addrIdx }
  }

  const walk = (node, parent, idx) => {
    if (!Array.isArray(node)) return
    const op = node[0]

    // Control-flow boundaries: clear table.
    if (op === 'br' || op === 'br_if' || op === 'br_table' || op === 'return' || op === 'unreachable') {
      // Process args first (a br_if value, br arg, etc. could still benefit from current table)
      for (let i = 1; i < node.length; i++) walk(node[i], node, i)
      table.clear()
      return
    }

    if (op === 'loop' || op === 'if') {
      // Recurse with a cleared table, then clear after (the compound may have
      // written). SIBLING ARMS ARE EXCLUSIVE PATHS: a CSE anchor minted in the
      // then-arm does not dominate the else-arm — an entry surviving into the
      // sibling reads a $__cs local that was never set on this path (wrong
      // value, or the zero-init). Each then/else arm gets its own fresh table.
      table.clear()
      for (let i = 1; i < node.length; i++) {
        if (Array.isArray(node[i]) && (node[i][0] === 'then' || node[i][0] === 'else')) table.clear()
        walk(node[i], node, i)
      }
      table.clear()
      return
    }

    if (op === 'call') {
      const callee = node[1]
      // Process args first.
      for (let i = 2; i < node.length; i++) walk(node[i], node, i)
      if (!SAFE_OFFSET_CALLS.has(callee)) table.clear()
      return
    }

    if (op === 'call_ref' || op === 'call_indirect') {
      for (let i = 1; i < node.length; i++) walk(node[i], node, i)
      table.clear()
      return
    }

    if (op === 'local.set' || op === 'local.tee') {
      // Process value first.
      for (let i = 2; i < node.length; i++) walk(node[i], node, i)
      const X = node[1]
      if (typeof X === 'string') invalidateLocal(X)
      return
    }

    // Stores: process operands first; if address tree references any tracked X,
    // invalidate that X's entries.
    if (op === 'f64.store' || op === 'i32.store' || op === 'i64.store'
        || op === 'i32.store8' || op === 'i32.store16'
        || op === 'i64.store8' || op === 'i64.store16' || op === 'i64.store32'
        || op === 'f32.store') {
      // Address may be node[1] (raw) or node[2] (when node[1] is offset=/align= attr).
      let addrIdx = 1
      if (typeof node[1] === 'string' && (node[1].startsWith('offset=') || node[1].startsWith('align='))) {
        addrIdx = 2
      }
      for (let i = 1; i < node.length; i++) walk(node[i], node, i)
      const dirty = new Set()
      collectGets(node[addrIdx], dirty)
      for (const X of dirty) invalidateLocal(X)
      return
    }

    // f64.load: try CSE.
    const lp = parseLoad(node)
    if (lp) {
      const addr = node[lp.addrIdx]
      if (Array.isArray(addr) && addr[0] === 'local.get' && typeof addr[1] === 'string' && bases.has(addr[1])) {
        const X = addr[1]
        const key = `${X}|${lp.K}`
        const entry = table.get(key)
        if (entry) {
          if (!entry.snapName) {
            const snapName = `$__cs${snapId++}`
            entry.snapName = snapName
            newLocals.push(['local', snapName, 'f64'])
            // Wrap anchor with (local.tee $snap originalLoad).
            const orig = entry.anchorParent[entry.anchorIdx]
            entry.anchorParent[entry.anchorIdx] = ['local.tee', snapName, orig]
          }
          parent[idx] = ['local.get', entry.snapName]
          return
        } else {
          table.set(key, { snapName: null, anchorParent: parent, anchorIdx: idx })
          // Don't recurse; (local.get $X) has no children of interest.
          return
        }
      }
      // Non-CSE'able address; recurse to find inner loads.
      for (let i = 1; i < node.length; i++) walk(node[i], node, i)
      return
    }

    // Default: recurse.
    for (let i = 0; i < node.length; i++) walk(node[i], node, i)
  }

  for (let i = bodyStart; i < fn.length; i++) walk(fn[i], fn, i)

  if (newLocals.length) fn.splice(bodyStart, 0, ...newLocals)
}

/**
 * CSE for pure f64 binary ops on local-only operands.
 *
 * Mandelbrot loop: condition computes `(f64.mul $zx $zx)` and `(f64.mul $zy $zy)`;
 * body recomputes both inside `tx = zx*zx - zy*zy + cx`. Pure ops on locals can't
 * alias memory — only `local.set/tee X` invalidates entries referencing X. Unlike
 * `cseScalarLoad`, br_if doesn't need to clear (no memory aliasing concern).
 *
 * Targets nodes of shape `(OP A B)` where OP ∈ {f64.mul, f64.add, f64.sub} and
 * A,B ∈ `(local.get X)` | `(f64.const N)`. Commutative ops (mul, add) sort
 * operand keys for canonical form.
 *
 * Region boundaries:
 *   - `local.set/tee X` → invalidates entries referencing X
 *   - `loop`, `if` → recurse with cleared table; clear after (compound may have written)
 *   - `call`, `call_ref`, `call_indirect` → no clear (calls don't write locals directly;
 *     the surrounding `local.set/tee` handles that)
 *   - `br/br_if/br_table/return/unreachable` → NO clear (pure values still valid)
 */
/**
 * Forward-substitute a single-def / single-use local into its sole use, eliminating the local,
 * its `local.set` and its `local.get`. This is watr's "propagate": jz emits short-lived address/
 * index temps (`set $t (i32.add …); … (load $t) …`) that the WAT optimizer folds away — the
 * dominant slice of the watr-optimizer-OFF size gap (a matmul carries ~14 such temps, ≈ the whole
 * delta). Closing it lets jz lean on its own optimizer instead of watr's.
 *
 * SOUND only when moving the def's RHS `E` to the use can't change order or value:
 *   - `E` is PURE — reads only locals (no load/store/call/global/memory): its value is a function
 *     of its read-locals alone, and it has no side effects to reorder past intervening statements.
 *   - the use is at the SAME loop nesting — never under a deeper `loop` than the def (which would
 *     re-evaluate `E` per iteration and could read a clobbered input).
 *   - no read-local of `E` is written between the def and the use (incl. the use statement itself).
 * Anything it can't prove safe is left untouched.
 */
export function propagateSingleUse(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // Leave a vectorized function alone: it carries v128 lane sequences that are already register-tight,
  // and forward-substituting into them only adds pressure (mirrors hoistInvariantLoop's hasV128 gate).
  let hasV128 = false
  const scanV = (n) => { if (hasV128 || !Array.isArray(n)) return; const op = n[0]; if (typeof op === 'string' && (op.startsWith('v128.') || /^[if]\d+x\d+\./.test(op))) { hasV128 = true; return } for (let i = 1; i < n.length; i++) scanV(n[i]) }
  for (let i = bodyStart; i < fn.length && !hasV128; i++) scanV(fn[i])
  if (hasV128) return

  // def/use tally over the whole body. A `local.tee` is both a read and a write — exclude any
  // tee'd local from candidacy rather than reason about it.
  const setN = new Map(), getN = new Map(), teed = new Set()
  const tally = (n) => {
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op === 'local.set' && typeof n[1] === 'string') setN.set(n[1], (setN.get(n[1]) || 0) + 1)
    else if (op === 'local.tee' && typeof n[1] === 'string') teed.add(n[1])
    else if (op === 'local.get' && typeof n[1] === 'string') getN.set(n[1], (getN.get(n[1]) || 0) + 1)
    for (let i = 1; i < n.length; i++) tally(n[i])
  }
  for (let i = bodyStart; i < fn.length; i++) tally(fn[i])

  const cand = new Set()
  for (const [name, c] of setN) if (c === 1 && getN.get(name) === 1 && !teed.has(name)) cand.add(name)
  if (!cand.size) return

  const movablePure = (n) => {
    if (!Array.isArray(n)) return true
    const op = n[0]
    if (op === 'local.get') return true
    if (op === 'local.set' || op === 'local.tee' || op === 'call' || op === 'call_indirect' || op === 'call_ref'
      || op === 'global.get' || op === 'global.set' || op === 'memory.size' || op === 'memory.grow'
      || op === 'memory.copy' || op === 'memory.fill') return false
    if (typeof op === 'string' && (op.includes('.load') || op.includes('.store') || op.includes('.atomic'))) return false
    for (let i = 1; i < n.length; i++) if (!movablePure(n[i])) return false
    return true
  }
  const readsOf = (n, out) => { if (!Array.isArray(n)) return; if (n[0] === 'local.get' && typeof n[1] === 'string') out.add(n[1]); for (let i = 1; i < n.length; i++) readsOf(n[i], out) }
  const writesAny = (n, R) => { if (!Array.isArray(n)) return false; if ((n[0] === 'local.set' || n[0] === 'local.tee') && R.has(n[1])) return true; for (let i = 1; i < n.length; i++) if (writesAny(n[i], R)) return true; return false }
  // Locate the (local.get $t) within `root`'s subtree (not root itself); flag if it sits under a
  // `loop` relative to root (→ would re-evaluate the moved RHS each iteration).
  const locateUse = (root, t) => {
    let found = null
    const rec = (node, underLoop) => {
      if (found || !Array.isArray(node)) return
      for (let i = 1; i < node.length; i++) {
        if (found) return
        const c = node[i]
        if (Array.isArray(c) && c[0] === 'local.get' && c[1] === t) { found = { parent: node, idx: i, underLoop }; return }
        rec(c, underLoop || node[0] === 'loop')
      }
    }
    rec(root, false)
    return found
  }

  const removed = new Set()
  const optimizeList = (list, start) => {
    for (let i = start; i < list.length; i++) {
      const s = list[i]
      if (!Array.isArray(s)) continue
      // s.length === 3: an explicit-RHS `(local.set $t E)`. A bare `(local.set $t)` (length 2)
      // binds a value already on the stack — e.g. the try_table catch payload — and has no RHS to
      // move; treating its undefined RHS as movable would substitute `undefined` into the use.
      if (s[0] === 'local.set' && s.length === 3 && typeof s[1] === 'string' && cand.has(s[1]) && movablePure(s[2])) {
        const t = s[1], E = s[2], R = new Set(); readsOf(E, R)
        for (let j = i + 1; j < list.length; j++) {
          const sj = list[j]
          const u = Array.isArray(sj) ? locateUse(sj, t) : null
          if (u) {                                       // found the sole use's statement
            if (!u.underLoop && !writesAny(sj, R)) {     // same nesting + read-locals intact
              u.parent[u.idx] = E
              list.splice(i, 1)
              cand.delete(t); removed.add(t)
              i--                                        // re-process from the freed slot (forward chains)
            }
            break                                        // use located — stop scanning this candidate
          }
          if (writesAny(sj, R)) break                    // a read-local clobbered before the use → can't move
        }
        if (removed.has(s[1])) continue
      }
      // recurse into nested statement lists
      if (s[0] === 'block' || s[0] === 'loop') {
        let k = 1; while (k < s.length && Array.isArray(s[k]) && s[k][0] === 'result') k++
        optimizeList(s, k)
      } else if (s[0] === 'if') {
        for (let k = 1; k < s.length; k++) { const c = s[k]; if (Array.isArray(c) && (c[0] === 'then' || c[0] === 'else')) optimizeList(c, 1) }
      }
    }
  }
  optimizeList(fn, bodyStart)

  // drop the now-orphaned decls (deferred so the body walk above sees stable indices)
  if (removed.size) for (let i = fn.length - 1; i >= 2; i--) { const c = fn[i]; if (Array.isArray(c) && c[0] === 'local' && removed.has(c[1])) fn.splice(i, 1) }
}

/**
 * Sink a single-def local's RHS to its FIRST use as a `local.tee` (the simplify-locals
 * transform watr's use-count propagate doesn't do, confirmed by diffing jz+watr vs Binaryen):
 *
 *   (local.set $t (call $f ...))           ⇒   (i64.store a (local.tee $t (call $f ...)))
 *   (i64.store a (local.get $t))                ... later (local.get $t) ...
 *   ... later (local.get $t) ...
 *
 * — removes the standalone `set` statement + the first `local.get` (~2–4 B/site). For a
 * SINGLE-use local the RHS is forwarded outright (no tee, decl dropped) — this also catches
 * effectful single-use temps (`call`/`load` RHS) that `propagateSingleUse` skips. Runs after
 * `propagateSingleUse`, so it sees only the cases that one leaves: multi-use, and effectful.
 *
 * Correctness rests on `scanUse`, an eval-order walk that flags a conflict BEFORE the use:
 *   - a write to any local the RHS reads (R),
 *   - a control-flow transfer (br/return/throw/…) that could skip the use while a later use lives,
 *   - for a memory-reading RHS, an intervening memory/global WRITE,
 *   - for a memory-writing RHS (incl. any call), ANY intervening memory/global access.
 * Plus: a multi-use fold (and an effectful single-use forward) requires the use to be
 * UNCONDITIONALLY reached (not under if/loop/block) so the tee always runs before later reads;
 * never sink under a `loop` (would re-evaluate / re-effect the RHS per iteration).
 */
export function foldSetToTee(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // v128 lane sequences are already register-tight — folding only adds pressure (mirrors propagateSingleUse).
  let hasV128 = false
  const scanV = (n) => { if (hasV128 || !Array.isArray(n)) return; const op = n[0]; if (typeof op === 'string' && (op.startsWith('v128.') || /^[if]\d+x\d+\./.test(op))) { hasV128 = true; return } for (let i = 1; i < n.length; i++) scanV(n[i]) }
  for (let i = bodyStart; i < fn.length && !hasV128; i++) scanV(fn[i])
  if (hasV128) return

  const setN = new Map(), getN = new Map(), teed = new Set()
  const tally = (n) => {
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op === 'local.set' && typeof n[1] === 'string') setN.set(n[1], (setN.get(n[1]) || 0) + 1)
    else if (op === 'local.tee' && typeof n[1] === 'string') teed.add(n[1])
    else if (op === 'local.get' && typeof n[1] === 'string') getN.set(n[1], (getN.get(n[1]) || 0) + 1)
    for (let i = 1; i < n.length; i++) tally(n[i])
  }
  for (let i = bodyStart; i < fn.length; i++) tally(fn[i])

  const cand = new Set()
  for (const [name, c] of setN) if (c === 1 && (getN.get(name) || 0) >= 1 && !teed.has(name)) cand.add(name)
  if (!cand.size) return

  const readsOf = (n, out) => { if (!Array.isArray(n)) return; if (n[0] === 'local.get' && typeof n[1] === 'string') out.add(n[1]); for (let i = 1; i < n.length; i++) readsOf(n[i], out) }
  const noLocalWrite = (n) => {
    if (!Array.isArray(n)) return true
    if (n[0] === 'local.set' || n[0] === 'local.tee') return false
    for (let i = 1; i < n.length; i++) if (!noLocalWrite(n[i])) return false
    return true
  }
  const isWriteOp = (op) => op === 'call' || op === 'call_indirect' || op === 'call_ref' || op === 'return_call'
    || op === 'return_call_indirect' || op === 'global.set' || op === 'memory.grow' || op === 'memory.copy'
    || op === 'memory.fill' || (typeof op === 'string' && (op.includes('.store') || op.includes('.atomic')))
  const isReadOp = (op) => op === 'global.get' || op === 'memory.size' || (typeof op === 'string' && op.includes('.load'))
  const isCF = (op) => op === 'if' || op === 'loop' || op === 'block' || op === 'try' || op === 'try_table'
  const isTransfer = (op) => op === 'br' || op === 'br_if' || op === 'br_table' || op === 'return'
    || op === 'return_call' || op === 'return_call_indirect' || op === 'unreachable' || op === 'throw' || op === 'rethrow'
  const rhsKind = (n) => {                              // 'writes' | 'reads' | 'pure'
    let w = false, r = false
    const rec = (x) => { if (!Array.isArray(x)) return; if (isWriteOp(x[0])) w = true; else if (isReadOp(x[0])) r = true; for (let i = 1; i < x.length; i++) rec(x[i]) }
    rec(n)
    return w ? 'writes' : r ? 'reads' : 'pure'
  }
  // Walk `root` in eval order for the first `(local.get t)`; return {use, conflict}.
  // `conflict` reflects only what is evaluated strictly BEFORE the use (or the whole node if no use).
  const scanUse = (root, t, mode, R) => {
    let use = null, conflict = false
    const rec = (node, underLoop, underCond) => {
      if (use || conflict || !Array.isArray(node)) return
      const op = node[0]
      for (let i = 1; i < node.length; i++) {
        if (use || conflict) return
        const c = node[i]
        if (Array.isArray(c) && c[0] === 'local.get' && c[1] === t) { use = { parent: node, idx: i, underLoop, underCond }; return }
        // an `if`'s CONDITION (child 1) and all `select` operands evaluate UNCONDITIONALLY when
        // the construct is reached — only then/else bodies are conditional. Treating the condition
        // as conditional would wrongly refuse the common `if ((local.tee $t E) …)` fold.
        const childCond = (op === 'if' && i === 1) || op === 'select' ? underCond : underCond || isCF(op)
        rec(c, underLoop || op === 'loop', childCond)
      }
      if (use || conflict) return
      // post-order: this node's own effect, relative to the RHS we want to move past it
      if ((op === 'local.set' || op === 'local.tee') && R.has(node[1])) conflict = true
      else if (isTransfer(op)) conflict = true
      else if (mode === 'writes' && (isWriteOp(op) || isReadOp(op))) conflict = true
      else if (mode === 'reads' && isWriteOp(op)) conflict = true
    }
    rec(root, false, false)
    return { use, conflict }
  }

  const removed = new Set()
  const optimizeList = (list, start) => {
    for (let i = start; i < list.length; i++) {
      const s = list[i]
      if (!Array.isArray(s)) continue
      let folded = false
      if (s[0] === 'local.set' && s.length === 3 && typeof s[1] === 'string' && cand.has(s[1]) && noLocalWrite(s[2])) {
        const t = s[1], E = s[2], R = new Set(); readsOf(E, R)
        if (!R.has(t)) {                                  // self-ref RHS reads the very local — leave it
          const single = (getN.get(t) || 0) === 1
          const mode = rhsKind(E)
          for (let j = i + 1; j < list.length; j++) {
            const sj = list[j]
            if (!Array.isArray(sj)) continue
            const { use, conflict } = scanUse(sj, t, mode, R)
            if (conflict) break                           // unsafe to move RHS this far
            if (use) {
              // effectful single-use, or any multi-use, must reach the use unconditionally;
              // never sink under a loop (re-eval / re-effect).
              const okCond = (single && mode !== 'writes') ? true : !use.underCond
              if (!use.underLoop && okCond) {
                use.parent[use.idx] = single ? E : ['local.tee', t, E]
                list.splice(i, 1); cand.delete(t); if (single) removed.add(t); i--; folded = true
              }
              break
            }
          }
        }
      }
      if (folded) continue                                // re-process from the freed slot
      // recurse into nested statement lists
      if (s[0] === 'block' || s[0] === 'loop') {
        let k = 1; while (k < s.length && Array.isArray(s[k]) && s[k][0] === 'result') k++
        optimizeList(s, k)
      } else if (s[0] === 'if') {
        for (let k = 1; k < s.length; k++) { const c = s[k]; if (Array.isArray(c) && (c[0] === 'then' || c[0] === 'else')) optimizeList(c, 1) }
      }
    }
  }
  optimizeList(fn, bodyStart)

  if (removed.size) for (let i = fn.length - 1; i >= 2; i--) { const c = fn[i]; if (Array.isArray(c) && c[0] === 'local' && removed.has(c[1])) fn.splice(i, 1) }
}

/**
 * Module-wide scan for "volatile" globals — those mutated (`global.set`) in any
 * function other than `$__start`. Globals written only in `$__start` are
 * init-once: `$__start` runs to completion before any other function, so they
 * are effectively read-only afterwards and stay promotable.
 *
 * promoteGlobals uses this to avoid caching a callee-mutable global into a
 * function-entry local across a call (which would leave the local stale).
 *
 * @param {Array<Array>} funcs - all module function IR nodes
 * @returns {Set<string>} volatile global names (with leading `$`)
 */
export function collectVolatileGlobals(funcs) {
  const volatile = new Set()
  const scan = (node) => {
    if (!Array.isArray(node)) return
    if (node[0] === 'global.set') {
      if (typeof node[1] === 'string') volatile.add(node[1])
      for (let i = 2; i < node.length; i++) scan(node[i])
      return
    }
    for (let i = 1; i < node.length; i++) scan(node[i])
  }
  for (const fn of funcs) {
    if (!Array.isArray(fn) || fn[0] !== 'func' || fn[1] === '$__start') continue
    for (let i = 2; i < fn.length; i++) scan(fn[i])
  }
  return volatile
}

/**
 * Transitive global-write sets per function: name → Set of globals the function
 * writes directly OR through any (transitively) called function. The precise
 * complement to `collectVolatileGlobals`' coarse module-wide set — a global
 * written only by `init` is volatile module-wide, yet perfectly stable inside
 * a function whose call graph never reaches `init`.
 *
 * Unknown callees (imports — absent from the module's func list) write nothing:
 * wasm imports cannot touch module globals. `call_indirect`/`call_ref` targets
 * are unknown wasm functions — treat as writing every global any function
 * writes (the sound over-approximation).
 */
export function collectReachableGlobalWrites(funcs) {
  const writes = new Map(), callees = new Map(), indirect = new Set(), all = new Set()
  for (const fn of funcs) {
    if (!Array.isArray(fn) || fn[0] !== 'func' || typeof fn[1] !== 'string') continue
    const w = new Set(), c = new Set()
    const scan = (n) => {
      if (!Array.isArray(n)) return
      if (n[0] === 'global.set' && typeof n[1] === 'string') { w.add(n[1]); all.add(n[1]) }
      else if ((n[0] === 'call' || n[0] === 'return_call') && typeof n[1] === 'string') c.add(n[1])
      else if (n[0] === 'call_indirect' || n[0] === 'call_ref' || n[0] === 'return_call_indirect') indirect.add(fn[1])
      for (let i = 1; i < n.length; i++) scan(n[i])
    }
    for (let i = 2; i < fn.length; i++) scan(fn[i])
    writes.set(fn[1], w); callees.set(fn[1], c)
  }
  // Worklist fixpoint over the call graph.
  let changed = true
  while (changed) {
    changed = false
    for (const [name, w] of writes) {
      const before = w.size
      if (indirect.has(name)) for (const g of all) w.add(g)
      for (const callee of callees.get(name)) {
        const cw = writes.get(callee)
        if (cw) for (const g of cw) w.add(g)
      }
      if (w.size !== before) changed = true
    }
  }
  return writes
}

/**
 * Hoist `__ptr_offset` resolution of stable typed-array GLOBALS to one resolve
 * per function. Locals get their pointer unboxed once at bind time, but a
 * module-global typed array (`let x; init = () => { x = new Float64Array(n) }`
 * — the idiomatic DSP-state shape: rfft, game-of-life, diffusion)
 * re-resolves on EVERY element access:
 *   (call $__ptr_offset (i64.reinterpret_f64 (global.get $x)))
 * — 68 such calls in rfft's transform alone, ~7× slower than V8. LICM can't
 * hoist them out of loops: its global-invariance rule requires a call-free
 * loop, and the resolve itself is a call. promoteGlobals can't either: `init`
 * writes the global, so it's volatile module-wide.
 *
 * The precise facts make it sound here: TYPED pointees never forward (only
 * ARRAY/SET/MAP do — same bits ⇒ same offset), so the snapshot is stable iff
 * the global's VALUE is stable through the function — i.e. the function
 * neither writes G itself nor (transitively) calls anything that does
 * (`collectReachableGlobalWrites`). The entry-time resolve is total
 * (`__ptr_offset` bounds-checks garbage to itself), so hoisting past a
 * zero-trip loop or an early return is safe.
 *
 * @param {Array} fn - func IR node
 * @param {Set<string>} stablePtrGlobals - '$name's of VAL.TYPED module globals
 * @param {Map<string,Set<string>>} reachableWrites - from collectReachableGlobalWrites
 */
// Never-forwarding pointee kinds: every PTR tag outside __ptr_offset's
// forwarding set {ARRAY, HASH, SET, MAP} — same bits ⇒ same offset.
export const STABLE_PTR_VALS = new Set([VAL.TYPED, VAL.STRING, VAL.OBJECT, VAL.BUFFER, VAL.CLOSURE])

/** '$name' set of stable-pointee module globals (hoistGlobalPtrOffset targets). */
export const stablePtrGlobalNames = () => {
  const out = new Set()
  if (ctx.scope.globalValTypes)
    for (const [k, v] of ctx.scope.globalValTypes) if (STABLE_PTR_VALS.has(v)) out.add(`$${k}`)
  return out
}

export function hoistGlobalPtrOffset(fn, stablePtrGlobals, reachableWrites) {
  if (!Array.isArray(fn) || fn[0] !== 'func' || !stablePtrGlobals?.size) return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // `(i64.reinterpret_f64 (global.get $G))` → G, or null.
  const reintGlobal = (n) =>
    Array.isArray(n) && n[0] === 'i64.reinterpret_f64'
      && Array.isArray(n[1]) && n[1][0] === 'global.get' && typeof n[1][1] === 'string'
      ? n[1][1] : null
  // A stable-pointee global's byte-base reaches us in two interchangeable shapes:
  //   • forwarding-aware  `(call $__ptr_offset (i64.reinterpret_f64 (global.get $G)))`
  //   • inline typed read `(i32.wrap_i64 (i64.and (i64.reinterpret_f64 (global.get $G)) MASK))`
  // The inline form is what typed-array reads emit (a fixed-size typed array never
  // relocates, so they skip __ptr_offset's forwarding follow — see module/typedarray.js
  // `typedBase`). For a never-forwarding pointee both yield the identical offset, so
  // either site hoists to the one `__ptr_offset` entry snapshot. Matching only the
  // call form left typed-array globals re-decoding the NaN-box per element in stencil
  // sweeps (watercolor's pressure solve: 5 reads/cell × millions of cells). → G, or null.
  const siteGlobal = (n) => {
    if (!Array.isArray(n)) return null
    if (n[0] === 'call' && n[1] === '$__ptr_offset' && n.length === 3) return reintGlobal(n[2])
    if (n[0] === 'i32.wrap_i64' && n.length === 2 && Array.isArray(n[1]) && n[1][0] === 'i64.and' && n[1].length === 3) {
      const mask = n[1][2]
      if (Array.isArray(mask) && mask[0] === 'i64.const'
          && (typeof mask[1] === 'string' ? Number(mask[1]) : mask[1]) === LAYOUT.OFFSET_MASK)
        return reintGlobal(n[1][1])
    }
    return null
  }

  // Per-global: static site count AND whether any site sits inside a loop. A
  // single in-loop site is a per-ITERATION resolve (lenia's convolution reads
  // each of kdx/kdy/kw at one site × ~14M taps/frame), so loop placement beats
  // site count as the hoist criterion.
  const counts = new Map(), inLoop = new Set(), ownWrites = new Set(), ownCallees = new Set()
  // Globals seen via the `__ptr_offset` call form (vs. only the inline typed mask).
  // The snapshot reuses an EXISTING form so it never resurrects a treeshaken helper:
  // a typed-array-only module emits no `__ptr_offset` call, so snapping one in would
  // reference a function that isn't in the module.
  const ptrOffsetForm = new Set()
  let hasIndirect = false
  const scan = (n, loopDepth) => {
    if (!Array.isArray(n)) return
    const g = siteGlobal(n)
    if (g != null) {
      counts.set(g, (counts.get(g) || 0) + 1)
      if (loopDepth > 0) inLoop.add(g)
      if (n[0] === 'call') ptrOffsetForm.add(g)
      return
    }
    if (n[0] === 'global.set' && typeof n[1] === 'string') ownWrites.add(n[1])
    else if ((n[0] === 'call' || n[0] === 'return_call') && typeof n[1] === 'string') ownCallees.add(n[1])
    else if (n[0] === 'call_indirect' || n[0] === 'call_ref' || n[0] === 'return_call_indirect') hasIndirect = true
    const d = n[0] === 'loop' ? loopDepth + 1 : loopDepth
    for (let i = 1; i < n.length; i++) scan(n[i], d)
  }
  for (let i = bodyStart; i < fn.length; i++) scan(fn[i], 0)
  if (!counts.size) return

  const calleeWrites = (g) => {
    if (hasIndirect) return true  // unknown targets — assume they write
    for (const c of ownCallees) if (reachableWrites?.get(c)?.has(g)) return true
    return false
  }

  // Collision-proof snap ids (same scheme as hoistInvariantLoop's $__li).
  const used = new Set()
  const scanIds = (n) => {
    if (!Array.isArray(n)) return
    if (n[0] === 'local' && typeof n[1] === 'string' && n[1].startsWith('$__go')) {
      const t = n[1].slice(5); if (/^\d+$/.test(t)) used.add(+t)
    }
    for (let i = 0; i < n.length; i++) scanIds(n[i])
  }
  scanIds(fn)
  let idCounter = 0
  const freshId = () => { while (used.has(idCounter)) idCounter++; const id = idCounter++; used.add(id); return `$__go${id}` }

  const chosen = new Map()  // global → snap local
  for (const [g, c] of counts) {
    if ((c < 2 && !inLoop.has(g)) || !stablePtrGlobals.has(g) || ownWrites.has(g) || calleeWrites(g)) continue
    chosen.set(g, freshId())
  }
  if (!chosen.size) return

  const replace = (n) => {
    if (!Array.isArray(n)) return
    for (let i = 1; i < n.length; i++) {
      const g = siteGlobal(n[i])
      if (g != null && chosen.has(g)) n[i] = ['local.get', chosen.get(g)]
      else replace(n[i])
    }
  }
  for (let i = bodyStart; i < fn.length; i++) replace(fn[i])

  const decls = [], snaps = []
  for (const [g, name] of chosen) {
    decls.push(['local', name, 'i32'])
    // Match an existing site's form so we never reference a treeshaken helper.
    // For a never-forwarding pointee both forms compute the same offset, so the
    // inline mask is a safe (and call-free) snapshot when no __ptr_offset site exists.
    const snap = ptrOffsetForm.has(g)
      ? ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['global.get', g]]]
      : ['i32.wrap_i64', ['i64.and', ['i64.reinterpret_f64', ['global.get', g]], ['i64.const', LAYOUT.OFFSET_MASK]]]
    snaps.push(['local.set', name, snap])
  }
  fn.splice(bodyStart, 0, ...decls, ...snaps)
}

// Constant element reads from a fixed typed-array global are immutable for the
// dynamic extent of a function when neither that function nor any reachable
// callee stores through the same global base. Cache those cells once at entry.
// This is load-CSE across the call/loop boundary: ordinary CSE cannot retain a
// memory value past an unrelated store (for example, writes to an output
// buffer), even when both bases are proven-distinct module allocations.
const typedGlobalByteLengths = () => {
  const widths = new Map([
    ['new.Int8Array', 1], ['new.Uint8Array', 1], ['new.Uint8ClampedArray', 1],
    ['new.Int16Array', 2], ['new.Uint16Array', 2],
    ['new.Int32Array', 4], ['new.Uint32Array', 4], ['new.Float32Array', 4],
    ['new.BigInt64Array', 8], ['new.BigUint64Array', 8], ['new.Float64Array', 8],
  ])
  const out = new Map()
  for (const [name, len] of ctx.scope.globalTypedLen || []) {
    const width = widths.get(ctx.scope.globalTypedElem?.get(name))
    if (width && Number.isInteger(len) && len >= 0) out.set(`$${name}`, len * width)
  }
  return out
}

const irI32Const = n => {
  if (!Array.isArray(n)) return null
  if (n[0] === 'i32.const' && Number.isInteger(n[1])) return n[1]
  if (n.length !== 3) return null
  const a = irI32Const(n[1]), b = irI32Const(n[2])
  if (a == null || b == null) return null
  if (n[0] === 'i32.add') return (a + b) | 0
  if (n[0] === 'i32.sub') return (a - b) | 0
  if (n[0] === 'i32.mul') return Math.imul(a, b)
  if (n[0] === 'i32.shl') return a << b
  return null
}
const globalBaseAliases = fn => {
  const aliases = new Map(), assigns = [], poisoned = new Set()
  const scan = n => {
    if (!Array.isArray(n)) return
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') assigns.push([n[1], n[2]])
    for (let i = 1; i < n.length; i++) scan(n[i])
  }
  scan(fn)
  const resolve = rhs => {
    // Snapshot shape emitted by hoistGlobalPtrOffset:
    // i32.wrap_i64(i64.and(i64.reinterpret_f64(global.get $G), MASK))
    const g = Array.isArray(rhs) && rhs[0] === 'i32.wrap_i64' &&
      Array.isArray(rhs[1]) && rhs[1][0] === 'i64.and' &&
      Array.isArray(rhs[1][1]) && rhs[1][1][0] === 'i64.reinterpret_f64' &&
      Array.isArray(rhs[1][1][1]) && rhs[1][1][1][0] === 'global.get'
      ? rhs[1][1][1][1] : null
    if (typeof g === 'string') return { global: g, offset: 0 }
    if (Array.isArray(rhs) && rhs[0] === 'local.get') return aliases.get(rhs[1]) || null
    if (Array.isArray(rhs) && rhs[0] === 'i32.add') {
      const a = rhs[1], b = rhs[2], ac = irI32Const(a), bc = irI32Const(b)
      if (bc != null) {
        const base = resolve(a); return base && { global: base.global, offset: base.offset == null ? null : base.offset + bc }
      }
      if (ac != null) {
        const base = resolve(b); return base && { global: base.global, offset: base.offset == null ? null : base.offset + ac }
      }
      const ra = resolve(a), rb = resolve(b)
      if (ra && !rb) return { global: ra.global, offset: null }
      if (rb && !ra) return { global: rb.global, offset: null }
    }
    return null
  }
  // All writes to an address alias must resolve to the same global+offset.
  // Conflicting or non-address writes poison it rather than retaining the first.
  for (let changed = true; changed;) {
    changed = false
    for (const [name, rhs] of assigns) {
      if (poisoned.has(name)) continue
      const rec = resolve(rhs)
      if (!rec) continue
      const old = aliases.get(name)
      if (old && (old.global !== rec.global || old.offset !== rec.offset)) { aliases.delete(name); poisoned.add(name); changed = true }
      else if (!old) { aliases.set(name, rec); changed = true }
    }
  }
  // A write that never resolved as an address conflicts with any inferred alias
  // unless it is the snapshot expression itself waiting on no local fact.
  for (const [name, rhs] of assigns) if (aliases.has(name) && !resolve(rhs)) aliases.delete(name)
  return aliases
}

const memAddress = n => {
  let i = 1, offset = 0
  while (typeof n[i] === 'string' && (n[i].startsWith('offset=') || n[i].startsWith('align='))) {
    if (n[i].startsWith('offset=')) offset += Number(n[i].slice(7)) || 0
    i++
  }
  let addr = n[i]
  // Address-base CSE often materializes a constant address with a tee on its
  // first load, followed by local.get uses. Preserve the embedded offset.
  if (Array.isArray(addr) && addr[0] === 'local.tee' && addr.length === 3) addr = addr[2]
  if (Array.isArray(addr) && addr[0] === 'i32.add') {
    const a = addr[1], b = addr[2], ac = irI32Const(a), bc = irI32Const(b)
    if (bc != null) { addr = a; offset += bc }
    else if (ac != null) { addr = b; offset += ac }
  }
  return { addr, offset }
}
const plainLoadOp = op => typeof op === 'string' &&
  /^(?:v128|f32|f64|i32|i64)\.load(?:8|16|32)?(?:_[su])?$/.test(op)
const memGlobal = (n, aliases) => {
  const { addr, offset } = memAddress(n)
  if (Array.isArray(addr) && addr[0] === 'local.get' && aliases.has(addr[1])) {
    const rec = aliases.get(addr[1])
    return { global: rec.global, offset: rec.offset == null ? offset : rec.offset + offset, exact: rec.offset != null }
  }
  const found = new Set()
  const bases = x => {
    if (!Array.isArray(x)) return
    if (x[0] === 'local.get' && aliases.has(x[1])) { found.add(aliases.get(x[1]).global); return }
    for (let i = 1; i < x.length; i++) bases(x[i])
  }
  bases(addr)
  return { global: found.size === 1 ? [...found][0] : null, offset, exact: false }
}

/** Per-function transitive set of typed globals written through memory; `*` is unknown aliasing. */
export function collectReachableMemoryWrites(funcs) {
  const direct = new Map(), calls = new Map(), names = new Set()
  for (const fn of funcs) if (Array.isArray(fn) && fn[0] === 'func' && typeof fn[1] === 'string') names.add(fn[1])
  for (const fn of funcs) {
    if (!Array.isArray(fn) || fn[0] !== 'func' || typeof fn[1] !== 'string') continue
    const aliases = globalBaseAliases(fn), writes = new Set(), callees = new Set()
    const scan = n => {
      if (!Array.isArray(n)) return
      const op = n[0]
      if (typeof op === 'string' && (op.endsWith('.store') || op.includes('.store8') || op.includes('.store16') || op.includes('.store32'))) {
        const { global } = memGlobal(n, aliases)
        writes.add(global || '*')
      } else if (op === 'memory.copy' || op === 'memory.fill' || op === 'memory.init') writes.add('*')
      else if ((op === 'call' || op === 'return_call') && typeof n[1] === 'string') {
        // A missing target is a host import. It can observe an exported memory
        // through its JS closure and mutate arbitrary bytes: fail closed.
        if (names.has(n[1])) callees.add(n[1]); else writes.add('*')
      } else if (op === 'call_indirect' || op === 'call_ref' || op === 'return_call_indirect') writes.add('*')
      for (let i = 1; i < n.length; i++) scan(n[i])
    }
    scan(fn)
    direct.set(fn[1], writes); calls.set(fn[1], callees)
  }
  let changed = true
  while (changed) {
    changed = false
    for (const [name, writes] of direct) {
      const before = writes.size
      for (const callee of calls.get(name) || []) for (const g of direct.get(callee) || ['*']) writes.add(g)
      if (writes.size !== before) changed = true
    }
  }
  return direct
}

export function hoistStableGlobalConstLoads(fn, reachableMemoryWrites, reachableGlobalWrites) {
  if (!Array.isArray(fn) || fn[0] !== 'func' || typeof fn[1] !== 'string') return
  const aliases = globalBaseAliases(fn)
  if (!aliases.size) return
  const byteLens = typedGlobalByteLengths()
  if (!byteLens.size) return
  const writes = reachableMemoryWrites?.get(fn[1]) || new Set(['*'])
  const globalWrites = reachableGlobalWrites?.get(fn[1]) || new Set(['*'])
  if (writes.has('*') || globalWrites.has('*')) return
  const opWidth = op => op.startsWith('v128.') ? 16
    : op.startsWith('f64.') || op.startsWith('i64.') ? 8
    : op.includes('load8') ? 1 : op.includes('load16') ? 2 : 4
  const sites = new Map()
  const scan = (n, depth = 0) => {
    if (!Array.isArray(n)) return
    const d = n[0] === 'loop' ? depth + 1 : depth
    const op = n[0]
    if (plainLoadOp(op)) {
      const { global, offset, exact } = memGlobal(n, aliases)
      const width = opWidth(op), limit = byteLens.get(global)
      if (global && exact && !writes.has(global) && Number.isInteger(offset) && offset >= 0 && offset + width <= limit) {
        // Keep sign/zero-extending loads distinct even at the same cell.
        const key = `${op}|${global}|${offset}`
        let rec = sites.get(key)
        if (!rec) sites.set(key, rec = { nodes: [], op, global, offset, depth: 0, type: op.startsWith('f64.') ? 'f64' : op.startsWith('f32.') ? 'f32' : op.startsWith('i64.') ? 'i64' : op.startsWith('v128.') ? 'v128' : 'i32' })
        rec.nodes.push(n); rec.depth = Math.max(rec.depth, d)
        return
      }
    }
    for (let i = 1; i < n.length; i++) scan(n[i], d)
  }
  scan(fn)
  const baseByGlobal = new Map()
  for (const [name, rec] of aliases) if (rec.offset === 0 && !baseByGlobal.has(rec.global)) baseByGlobal.set(rec.global, name)
  const chosen = [...sites.values()].filter(rec =>
    (rec.nodes.length >= 2 || rec.depth > 0) && baseByGlobal.has(rec.global) && !globalWrites.has(rec.global))
  if (!chosen.length) return

  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return
  const used = new Set()
  const ids = n => { if (Array.isArray(n)) { if (n[0] === 'local' && typeof n[1] === 'string') used.add(n[1]); for (let i = 1; i < n.length; i++) ids(n[i]) } }
  ids(fn)
  let seq = 0
  const fresh = () => {
    let n = `$__gl${seq++}`
    while (used.has(n)) n = `$__gl${seq++}`
    used.add(n)
    return n
  }
  const copy = n => Array.isArray(n) ? n.map(copy) : n
  const chosenGlobals = new Set(chosen.map(rec => rec.global))
  // A base snapshot may originally live inside the first load's local.tee.
  // Since that load is about to become a cached local.get, materialize every
  // chosen base explicitly before its cache initializers.
  const baseInits = []
  for (const global of chosenGlobals) {
    const base = baseByGlobal.get(global)
    baseInits.push(['local.set', base,
      ['i32.wrap_i64', ['i64.and', ['i64.reinterpret_f64', ['global.get', global]], ['i64.const', LAYOUT.OFFSET_MASK]]]])
  }
  // Address-base CSE locals whose defining tees disappear with the replaced
  // loads are initialized canonically from the stable global snapshot.
  const aliasInits = []
  for (const [name, rec] of aliases) {
    if (!chosenGlobals.has(rec.global)) continue
    const base = baseByGlobal.get(rec.global)
    if (rec.offset == null || name === base) continue
    const addr = rec.offset === 0 ? ['local.get', base]
      : ['i32.add', ['local.get', base], ['i32.const', rec.offset]]
    aliasInits.push(['local.set', name, addr])
  }
  const decls = [], inits = [], cachedLoads = new Set()
  for (const rec of chosen) {
    const name = fresh(), base = baseByGlobal.get(rec.global)
    const init = rec.offset === 0 ? [rec.op, ['local.get', base]]
      : [rec.op, `offset=${rec.offset}`, ['local.get', base]]
    cachedLoads.add(name)
    decls.push(['local', name, rec.type]); inits.push(['local.set', name, init])
    for (const n of rec.nodes) { n.length = 2; n[0] = 'local.get'; n[1] = name }
  }

  // Vector kernels commonly broadcast a fixed scalar configuration cell on
  // every helper invocation. Once the cell itself is cached above, its pure
  // splat/conversion is invariant too; cache that v128 value rather than doing
  // f64→f32+splat in every inner iteration.
  const broadcasts = new Map()
  const scanBroadcasts = (n, depth = 0) => {
    if (!Array.isArray(n)) return
    const d = n[0] === 'loop' ? depth + 1 : depth
    let load = null
    if (n[0] === 'f32x4.splat' && Array.isArray(n[1]) && n[1][0] === 'f32.demote_f64' &&
        Array.isArray(n[1][1]) && n[1][1][0] === 'local.get' && cachedLoads.has(n[1][1][1])) load = n[1][1][1]
    else if (n[0] === 'f64x2.splat' && Array.isArray(n[1]) && n[1][0] === 'local.get' && cachedLoads.has(n[1][1])) load = n[1][1]
    if (load) {
      const key = `${n[0]}|${load}`
      let rec = broadcasts.get(key)
      if (!rec) broadcasts.set(key, rec = { nodes: [], depth: 0, exemplar: copy(n) })
      rec.nodes.push(n); rec.depth = Math.max(rec.depth, d)
      return
    }
    for (let i = 1; i < n.length; i++) scanBroadcasts(n[i], d)
  }
  scanBroadcasts(fn)
  for (const rec of broadcasts.values()) {
    if (rec.nodes.length < 2 && rec.depth === 0) continue
    const name = fresh()
    decls.push(['local', name, 'v128']); inits.push(['local.set', name, rec.exemplar])
    for (const n of rec.nodes) { n.length = 2; n[0] = 'local.get'; n[1] = name }
  }

  fn.splice(bodyStart, 0, ...decls)
  // Explicit base/alias initialization above is self-contained, so place the
  // cache at true function entry. Waiting for arbitrary original alias sets can
  // put initialization after a use when an address temp is minted mid-body.
  fn.splice(bodyStart + decls.length, 0, ...baseInits, ...aliasInits, ...inits)
}

// Turn a large, pure SIMD producer ending in
//   out = bitselect(value, fallback, mask)
// into a guarded suffix when `mask` is derived from state produced by an
// earlier convergence loop. If every lane selects the fallback, none of the
// expensive producer (normal/shadow/AO-style vector work) needs to run. Mixed
// groups retain the exact original bitselect and lane semantics.
export function guardMaskedVectorSuffix(fn, reachableMemoryWrites) {
  if (!Array.isArray(fn) || fn[0] !== 'func' || !hasIROp(fn, 'v128.bitselect')) return
  const copy = n => Array.isArray(n) ? n.map(copy) : n
  const aliases = globalBaseAliases(fn), byteLens = typedGlobalByteLengths()
  const memoryWrites = reachableMemoryWrites?.get(fn[1]) || new Set(['*'])
  const safeLoad = n => {
    if (memoryWrites.has('*')) return false
    const { global, offset, exact } = memGlobal(n, aliases)
    const op = n[0]
    if (!plainLoadOp(op)) return false
    const width = op.startsWith('v128.') ? 16 : op.startsWith('f64.') || op.startsWith('i64.') ? 8
      : op.includes('load8') ? 1 : op.includes('load16') ? 2 : 4
    return global && exact && !memoryWrites.has(global) && Number.isInteger(offset) &&
      offset >= 0 && offset + width <= (byteLens.get(global) ?? -1)
  }
  const reads = (n, out = new Set()) => {
    if (!Array.isArray(n)) return out
    if (n[0] === 'local.get' && typeof n[1] === 'string') out.add(n[1])
    for (let i = 1; i < n.length; i++) reads(n[i], out)
    return out
  }
  const writes = (n, out = new Set()) => {
    if (!Array.isArray(n)) return out
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') out.add(n[1])
    for (let i = 1; i < n.length; i++) writes(n[i], out)
    return out
  }
  const nodeCount = n => Array.isArray(n) ? 1 + n.slice(1).reduce((s, x) => s + nodeCount(x), 0) : 0
  const safeRegion = region => {
    const defs = new Set(), refs = []
    const scan = n => {
      if (!Array.isArray(n)) return true
      const op = n[0]
      if ((op === 'block' || op === 'loop') && typeof n[1] === 'string') defs.add(n[1])
      if ((op === 'br' || op === 'br_if') && typeof n[1] === 'string') refs.push(n[1])
      if (op === 'call' || op === 'return_call' || op === 'call_indirect' || op === 'call_ref' ||
          op === 'return' || op === 'unreachable' || op === 'global.set' ||
          (typeof op === 'string' && (op === 'memory.grow' || op.startsWith('memory.') ||
            /^(?:i32|i64)\.(?:div|rem|trunc_f)/.test(op))) ||
          (typeof op === 'string' && (op.includes('.store') || (op.includes('.load') && !safeLoad(n))))) return false
      for (let i = 1; i < n.length; i++) if (!scan(n[i])) return false
      return true
    }
    for (const n of region) if (!scan(n)) return false
    return refs.every(label => defs.has(label))
  }
  const processLoop = loop => {
    // Work from the end so replacing one suffix cannot invalidate earlier indices.
    for (let end = loop.length - 1; end >= 2; end--) {
      const stmt = loop[end]
      if (!Array.isArray(stmt) || stmt[0] !== 'local.set' || typeof stmt[1] !== 'string') continue
      const rhs = stmt[2]
      if (!Array.isArray(rhs) || rhs[0] !== 'v128.bitselect' || rhs.length !== 4) continue
      const mask = rhs[3]
      if (!Array.isArray(mask) || !/^f(?:32x4|64x2)\./.test(mask[0]) || !/(?:eq|ne|lt|le|gt|ge)$/.test(mask[0])) continue
      // The guard evaluates the mask once before the original bitselect. A tee
      // in the comparison would therefore write twice on the true path.
      if (writes(mask).size) continue
      const maskReads = reads(mask)
      let boundary = -1
      for (let i = 2; i < end; i++) {
        const ws = writes(loop[i])
        for (const name of maskReads) if (ws.has(name)) boundary = i
      }
      if (boundary < 2 || boundary + 1 >= end) continue
      const start = boundary + 1, region = loop.slice(start, end + 1)
      if (nodeCount(region) < 300 || !safeRegion(region)) continue
      const regionWrites = new Set(); for (const n of region) writes(n, regionWrites)
      // A suffix write observed before `start` is loop-carried into the next
      // iteration. Skipping it would leave stale state even if no same-iteration
      // use follows the bitselect.
      const outsideReads = new Set(), overwritten = new Set()
      for (let i = 2; i < start; i++) {
        const stmtReads = reads(loop[i])
        for (const name of stmtReads) if (!overwritten.has(name)) outsideReads.add(name)
        // Only an unconditional top-level set definitely kills the prior
        // iteration's value before any later read. Nested/conditional writes
        // remain fail-closed.
        const s = loop[i]
        if (Array.isArray(s) && s[0] === 'local.set' && typeof s[1] === 'string') overwritten.add(s[1])
      }
      for (let i = end + 1; i < loop.length; i++) reads(loop[i], outsideReads)
      let escapes = false
      for (const name of regionWrites) if (name !== stmt[1] && outsideReads.has(name)) { escapes = true; break }
      // The all-false arm skips the region, so its fallback must not depend on
      // a value produced inside that region.
      if (!escapes) for (const name of reads(rhs[2])) if (regionWrites.has(name)) { escapes = true; break }
      if (escapes) continue
      const guarded = ['if', ['v128.any_true', copy(mask)], ['then', ...region],
        ['else', ['local.set', stmt[1], copy(rhs[2])]]]
      loop.splice(start, region.length, guarded)
      end = start
    }
  }
  const walk = n => {
    if (!Array.isArray(n)) return
    for (let i = 1; i < n.length; i++) walk(n[i])
    if (n[0] === 'loop') processLoop(n)
  }
  walk(fn)
}

/**
 * Loop-scoped complement to `hoistGlobalPtrOffset`. That pass requires the
 * WHOLE FUNCTION to be clean w.r.t. a global (no write anywhere, no
 * call_indirect/call_ref anywhere) — one unrelated indirect call ANYWHERE in
 * a large function (e.g. a devirtualized Pratt-loop trampoline that inlines
 * many operator handlers) poisons every stable-pointee global for the WHOLE
 * function, even a tight char-scan loop inside it that touches nothing
 * unsafe itself. This pass re-tries per LOOP, narrowing the write/call scan
 * to just that loop's own subtree (including nested loops, whose dynamic
 * extent is part of the enclosing loop's).
 *
 * Soundness (route (a) from the design note — the simplest sound design):
 * a global's base is hoisted to a loop's preheader iff, within that loop's
 * subtree, (1) the global is never `global.set`, (2) no `call_indirect` /
 * `call_ref` appears at all (fail-closed: an unknown target could write
 * anything), and (3) every DIRECTLY-called function does not (transitively,
 * via `reachableWrites` — `collectReachableGlobalWrites`, itself fail-closed
 * the same way) write the global. No route (b) (re-derive-at-write /
 * generation guard) — a loop that fails (1)-(3) is left exactly as
 * `hoistGlobalPtrOffset` left it.
 *
 * One extra idiom this pass alone needs: the durable-receiver override probe
 * (`sidecarOverride`, src/ir.js) reads a global ONCE per iteration into a
 * local for a NaN/tag check, then reuses that SAME local for the base-decode
 * a few nodes downstream — `local.tee $vo (global.get $cur)` feeding a later
 * `(i64.reinterpret_f64 (local.get $vo))`. hoistGlobalPtrOffset's site
 * matcher only recognizes a DIRECT `global.get`, missing this alias.
 * `buildLocalGlobalAlias` resolves it: `$vo` aliases `$cur` when every write
 * to `$vo` within the loop is textually `(global.get $cur)` — since `$cur`
 * is already proven unwritten in the loop, every such tee assigns the same
 * invariant value, so any downstream read of `$vo` is as invariant as
 * `global.get $cur` itself.
 *
 * Runs immediately after `hoistGlobalPtrOffset` in the same module pass: any
 * site the function-wide pass already hoisted is now `local.get $__goN`, so
 * `siteGlobal` no longer matches it there — the two passes can't double-hoist
 * the same read.
 *
 * @param {Array} fn - func IR node
 * @param {Set<string>} stablePtrGlobals - '$name's of never-forwarding module globals
 * @param {Map<string,Set<string>>} reachableWrites - from collectReachableGlobalWrites
 */
export function hoistLoopGlobalPtrOffset(fn, stablePtrGlobals, reachableWrites) {
  if (!Array.isArray(fn) || fn[0] !== 'func' || !stablePtrGlobals?.size) return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // Per-loop: locals whose every write in `loopNode` is exactly `(global.get
  // $G)` for one consistent G — a conflicting write (different G, or any
  // other expression) poisons the name for this loop.
  const buildLocalGlobalAlias = (loopNode) => {
    const alias = new Map(), poisoned = new Set()
    const scan = (n) => {
      if (!Array.isArray(n)) return
      if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') {
        const name = n[1], rhs = n[2]
        if (!poisoned.has(name)) {
          const g = Array.isArray(rhs) && rhs[0] === 'global.get' && typeof rhs[1] === 'string' ? rhs[1] : null
          if (g != null && (!alias.has(name) || alias.get(name) === g)) alias.set(name, g)
          else { poisoned.add(name); alias.delete(name) }
        }
        scan(rhs)
        return
      }
      for (let i = 1; i < n.length; i++) scan(n[i])
    }
    for (let i = 1; i < loopNode.length; i++) scan(loopNode[i])
    return alias
  }

  // `(i64.reinterpret_f64 X)` → stable-pointee global name, or null. X is a
  // direct `(global.get $G)`, or a `(local.get $X)` resolved through `alias`.
  const reintGlobal = (n, alias) => {
    if (!Array.isArray(n) || n[0] !== 'i64.reinterpret_f64' || n.length !== 2) return null
    const x = n[1]
    if (Array.isArray(x) && x[0] === 'global.get' && typeof x[1] === 'string') return x[1]
    if (Array.isArray(x) && x[0] === 'local.get' && typeof x[1] === 'string') return alias.get(x[1]) ?? null
    return null
  }
  // Same two interchangeable shapes as hoistGlobalPtrOffset.siteGlobal — see
  // that function's comment for why both forms hoist to one snapshot.
  const siteGlobal = (n, alias) => {
    if (!Array.isArray(n)) return null
    if (n[0] === 'call' && n[1] === '$__ptr_offset' && n.length === 3) return reintGlobal(n[2], alias)
    if (n[0] === 'i32.wrap_i64' && n.length === 2 && Array.isArray(n[1]) && n[1][0] === 'i64.and' && n[1].length === 3) {
      const mask = n[1][2]
      if (Array.isArray(mask) && mask[0] === 'i64.const'
          && (typeof mask[1] === 'string' ? Number(mask[1]) : mask[1]) === LAYOUT.OFFSET_MASK)
        return reintGlobal(n[1][1], alias)
    }
    return null
  }

  // Collision-proof snap ids — shared `$__goN` numbering space with
  // hoistGlobalPtrOffset so re-running either pass never collides.
  const used = new Set()
  const scanIds = (n) => {
    if (!Array.isArray(n)) return
    if (n[0] === 'local' && typeof n[1] === 'string' && n[1].startsWith('$__go')) {
      const t = n[1].slice(5); if (/^\d+$/.test(t)) used.add(+t)
    }
    for (let i = 0; i < n.length; i++) scanIds(n[i])
  }
  scanIds(fn)
  let idCounter = 0
  const freshId = () => { while (used.has(idCounter)) idCounter++; const id = idCounter++; used.add(id); return `$__go${id}` }

  const newDecls = []

  // Attempt one loop; returns preheader statements to splice just before it
  // (possibly empty). Outer-first (top-down): if the outer loop's hoist
  // succeeds, `replace` below rewrites every matching site in its ENTIRE
  // subtree — including nested loops — so a later independent attempt on a
  // nested loop finds nothing left to do for that global (no double-hoist,
  // no redundant inner snapshot of an outer-invariant value).
  const processLoop = (loopNode) => {
    const alias = buildLocalGlobalAlias(loopNode)
    const sites = new Map(), ownWrites = new Set(), ownCallees = new Set(), ptrOffsetForm = new Set()
    let hasIndirect = false
    const scan = (n) => {
      if (!Array.isArray(n)) return
      const g = siteGlobal(n, alias)
      if (g != null) {
        let arr = sites.get(g); if (!arr) { arr = []; sites.set(g, arr) }
        arr.push(n)
        if (n[0] === 'call') ptrOffsetForm.add(g)
        return
      }
      if (n[0] === 'global.set' && typeof n[1] === 'string') ownWrites.add(n[1])
      else if ((n[0] === 'call' || n[0] === 'return_call') && typeof n[1] === 'string') ownCallees.add(n[1])
      else if (n[0] === 'call_indirect' || n[0] === 'call_ref' || n[0] === 'return_call_indirect') hasIndirect = true
      for (let i = 1; i < n.length; i++) scan(n[i])
    }
    for (let i = 1; i < loopNode.length; i++) scan(loopNode[i])

    const preheader = []
    if (sites.size && !hasIndirect) {
      const calleeWrites = (g) => {
        for (const c of ownCallees) if (reachableWrites?.get(c)?.has(g)) return true
        return false
      }
      const chosen = new Map()
      for (const g of sites.keys()) {
        if (!stablePtrGlobals.has(g) || ownWrites.has(g) || calleeWrites(g)) continue
        chosen.set(g, freshId())
      }
      if (chosen.size) {
        const replace = (n) => {
          if (!Array.isArray(n)) return
          for (let i = 1; i < n.length; i++) {
            const g = siteGlobal(n[i], alias)
            if (g != null && chosen.has(g)) n[i] = ['local.get', chosen.get(g)]
            else replace(n[i])
          }
        }
        for (let i = 1; i < loopNode.length; i++) replace(loopNode[i])
        for (const [g, name] of chosen) {
          newDecls.push(['local', name, 'i32'])
          const snap = ptrOffsetForm.has(g)
            ? ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['global.get', g]]]
            : ['i32.wrap_i64', ['i64.and', ['i64.reinterpret_f64', ['global.get', g]], ['i64.const', LAYOUT.OFFSET_MASK]]]
          preheader.push(['local.set', name, snap])
        }
      }
    }
    return preheader
  }

  // Walk every statement-bearing container; splice a loop's preheader into
  // its own parent array right before it, then recurse into the loop body
  // (nested loops get their own independent, narrower attempt).
  const walk = (node) => {
    if (!Array.isArray(node)) return
    for (let i = 1; i < node.length; i++) {
      const c = node[i]
      if (Array.isArray(c) && c[0] === 'loop') {
        const pre = processLoop(c)
        if (pre.length) { node.splice(i, 0, ...pre); i += pre.length }
        walk(c)
      } else {
        walk(c)
      }
    }
  }
  walk(fn)
  if (newDecls.length) fn.splice(bodyStart, 0, ...newDecls)
}

/**
 * Promote read-only globals to locals within each function.
 *
 * When a global is only read (never written) within a function and read ≥ 2 times,
 * load it once at function entry into a fresh local and replace all global.get with local.get.
 *
 * This eliminates repeated global.get instructions (5 bytes each with LEB128 idx) in
 * favour of cheaper local.get (1–2 bytes), and helps V8's TurboFan by reducing the
 * number of load-from-global operations it must track.
 *
 * Only promotes globals that appear read-only in the function body. Globals that are
 * also written (global.set) are left untouched — the promotion would be unsound if
 * the global changes between reads.
 *
 * A within-function read-only check is NOT sufficient: a callee can mutate the
 * global between two reads in this function. `volatileGlobals` (globals written
 * anywhere outside `$__start`) gates that case — a volatile global is not
 * promoted in any function that makes a call. Init-once globals (written only in
 * `$__start`) stay promotable everywhere.
 *
 * @param {Array} fn - Function IR (WAT-as-array)
 * @param {Map<string,string>} [globalTypes] - Optional: global name → wasm type ('i32'|'f64'|'i64'|'funcref')
 * @param {Set<string>} [volatileGlobals] - Optional: globals mutated outside `$__start` (see collectVolatileGlobals)
 */
export function promoteGlobals(fn, globalTypes, volatileGlobals, reachableWrites) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // Collect global.get counts, detect any global.set, and note whether the
  // function makes a call (a callee may mutate a volatile global between reads).
  const getCounts = new Map()  // globalName → count
  const written = new Set(), callees = new Set()
  let hasCall = false, hasIndirect = false

  const scan = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === 'global.get' && typeof node[1] === 'string') {
      getCounts.set(node[1], (getCounts.get(node[1]) || 0) + 1)
      return  // don't recurse into the name string
    }
    if (op === 'global.set') {
      if (typeof node[1] === 'string') written.add(node[1])
      if (node[2]) scan(node[2])
      return
    }
    if (op === 'call' || op === 'return_call') { hasCall = true; if (typeof node[1] === 'string') callees.add(node[1]) }
    else if (op === 'call_indirect' || op === 'call_ref' || op === 'return_call_indirect') { hasCall = true; hasIndirect = true }
    for (let i = 1; i < node.length; i++) scan(node[i])
  }

  for (let i = bodyStart; i < fn.length; i++) scan(fn[i])

  // Build replacement map: globalName → { localName, type } for globals read ≥ 3 times, not written.
  // Threshold 3 avoids size regressions in tiny functions where local setup cost dominates.
  // Find the highest existing $_pg index to avoid duplicate local names on re-runs.
  let localIdx = 0
  for (let i = 2; i < bodyStart; i++) {
    const c = fn[i]
    if (Array.isArray(c) && c[0] === 'local' && typeof c[1] === 'string') {
      const m = c[1].match(/^\$_pg(\d+)$/)
      if (m) localIdx = Math.max(localIdx, parseInt(m[1], 10) + 1)
    }
  }
  const replacements = new Map()
  for (const [gName, count] of getCounts) {
    if (count < 3 || written.has(gName)) continue
    // Unsound to cache a callee-mutable global across a call in this function.
    // With reachableWrites the test is exact per call edge (a global written
    // only by init stays promotable in functions whose call graph never
    // reaches init); without it, fall back to the coarse module-wide set.
    if (hasCall && (reachableWrites
      ? (hasIndirect || [...callees].some(c => reachableWrites.get(c)?.has(gName)))
      : volatileGlobals?.has(gName))) continue
    // Determine type: use provided map, or infer from context
    const type = globalTypes?.get(gName) || inferTypeFromContext(fn, gName, bodyStart)
    if (!type) continue  // can't determine type, skip
    const lName = `$_pg${localIdx++}`
    replacements.set(gName, { lName, type })
  }
  if (!replacements.size) return

  // Inject local declarations for promoted globals
  for (const [, { lName, type }] of replacements) {
    fn.splice(bodyStart, 0, ['local', lName, type])
  }
  // After all splices, bodyStart has shifted
  const newBodyStart = bodyStart + replacements.size

  // Insert local.set at the very start of the body (after the new locals)
  let insertIdx = newBodyStart
  for (const [gName, { lName }] of replacements) {
    fn.splice(insertIdx, 0, ['local.set', lName, ['global.get', gName]])
    insertIdx++
  }

  // Replace all global.get with local.get (only for promoted globals)
  const replace = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === 'global.get' && typeof node[1] === 'string') {
      const info = replacements.get(node[1])
      if (info) { node[0] = 'local.get'; node[1] = info.lName }
      return
    }
    for (let i = 1; i < node.length; i++) replace(node[i])
  }
  for (let i = insertIdx; i < fn.length; i++) replace(fn[i])
}

/**
 * Infer a global's type from its first usage context within a function body.
 * Looks at how the global.get result is consumed:
 *   - wrapped in i32.wrap_i64 → global is i64 (but jz doesn't use i64 globals)
 *   - used as arg to i32 ops (i32.add, i32.store, etc.) → i32
 *   - stored to i32-typed local → i32
 *   - otherwise → f64 (default for NaN-boxing scheme)
 */
function inferTypeFromContext(fn, gName, bodyStart) {
  let inferred = null
  const check = (node, parent, idx) => {
    if (!Array.isArray(node) || inferred) return
    if (node[0] === 'global.get' && node[1] === gName) {
      // Check parent context
      if (Array.isArray(parent)) {
        const pOp = parent[0]
        // If parent is an i32 op that takes this as operand, likely i32
        if (typeof pOp === 'string') {
          if (pOp.startsWith('i32.') && pOp !== 'i32.wrap_i64' && pOp !== 'i32.trunc_f64') {
            inferred = 'i32'
            return
          }
          if (pOp === 'i32.store' && idx === 2) { inferred = 'i32'; return }  // addr
          if (pOp === 'f64.store' && idx === 2) { inferred = 'f64'; return }  // addr can be i32, but value is f64
          // i32 comparisons already matched the `i32.` prefix above; a `local.set`
          // parent tells us nothing here — both fall through to the f64 default.
        }
      }
      // Default: f64 (the NaN-boxing carrier)
      if (!inferred) inferred = 'f64'
      return
    }
    for (let i = 0; i < node.length; i++) {
      if (Array.isArray(node[i])) check(node[i], node, i)
      if (inferred) return
    }
  }
  for (let i = bodyStart; i < fn.length && !inferred; i++) check(fn[i], null, i)
  return inferred
}

/**
 * Hoist frequently-repeated f64 constants into mutable globals.
 * f64.const is 9 bytes; global.get with idx<128 is 2 bytes — saves 7 B per reuse.
 * Pool entries sorted by usage descending, so hottest get lowest indices (1-byte LEB128).
 * Break-even: N ≥ 2 uses (pool cost: 11 B global decl + 2N bytes vs 9N original).
 *
 * Mutates `funcs` in place; writes new global decls via `addGlobal(name, constLiteral)`.
 */
// `String(number)` keeps only ~9 significant digits in the self-host kernel (jz's number
// formatter — see README "differences"). The old pool keyed constants by `n:${c[1]}` (a toString)
// and emitted them via that same string, so in the kernel a constant both LOST precision
// (0.041666666666666664 → 0x1.5555558325751p-5) and could MERGE with a distinct value sharing its
// 9-digit prefix. Key by the exact 64 bits instead (a Float64Array/Uint32Array union — the
// numHashLiteral pattern, which self-hosts; the sign bit distinguishes -0/+0 for free) and emit
// the original NUMBER, which `declGlobal` lowers to a binary `f64.const` (exact, no string).
const _FCB = new Float64Array(1), _FCBu = new Uint32Array(_FCB.buffer)
const f64BitsKey = (n) => { _FCB[0] = n; return `n:${_FCBu[0]}:${_FCBu[1]}` }

export function hoistConstantPool(funcs, addGlobal) {
  const MIN_USES = 2
  // Single walk: count occurrences AND record each f64.const site for direct rewrite.
  // Avoids a second full-AST traversal in the rewrite phase.
  const counts = new Map()
  // NOTE: not `valueOf` — a local named like an Object method self-host-miscompiles (the
  // kernel's dynamic dispatch confuses it). key → exact original c[1] (number, or source string).
  const exactVal = new Map()
  const sites = []  // { parent, idx, key }
  const walk = (node) => {
    if (!Array.isArray(node)) return
    for (let i = 0; i < node.length; i++) {
      const c = node[i]
      if (Array.isArray(c) && c[0] === 'f64.const' && (typeof c[1] === 'number' || typeof c[1] === 'string')) {
        const k = typeof c[1] === 'number' ? f64BitsKey(c[1]) : `s:${c[1]}`
        counts.set(k, (counts.get(k) || 0) + 1)
        if (!exactVal.has(k)) exactVal.set(k, c[1])
        sites.push({ parent: node, idx: i, key: k })
      }
      walk(c)
    }
  }
  for (let i = 0; i < funcs.length; i++) walk(funcs[i])

  const hoist = new Map()
  const sorted = [...counts].filter(([, n]) => n >= MIN_USES).sort((a, b) => b[1] - a[1])
  let gId = 0
  for (const [k] of sorted) {
    const name = `__fc${gId++}`
    // The EXACT original c[1] (a number → binary f64.const; or a source hex/decimal string),
    // never the lossy k-derived toString.
    addGlobal(name, exactVal.get(k))
    hoist.set(k, name)
  }
  if (!hoist.size) return

  // Rewrite recorded sites directly. Idempotent: if parent[idx] is no longer the
  // f64.const we recorded (shared subtrees), skip.
  for (let i = 0; i < sites.length; i++) {
    const { parent, idx, key } = sites[i]
    const g = hoist.get(key)
    if (!g) continue
    const c = parent[idx]
    if (!Array.isArray(c) || c[0] !== 'f64.const') continue
    parent[idx] = ['global.get', `$${g}`]
  }
}

/**
 * Specialize `(call $F arg1 arg2 …)` call sites by literal-arg signature.
 *
 * For each call target with a stable (param-types, result-type) signature,
 * scan all call sites and group by "literal-arg signature" (which args are
 * `i32.const N` literals vs runtime-dynamic). For groups with ≥ MIN_USES, emit
 * a specialized trampoline `$F_L1_L2_…` that bakes literals into the call:
 *
 *   (func $F_L1_L2 (param $a2 T2) (result R)
 *     (call $F (i32.const L1) (local.get $a2)))
 *
 * Call sites are rewritten `(call $F (i32.const L1) a2)` → `(call $F_L1_L2 a2)`.
 * Savings per site: ~2 B per dropped literal arg.
 *
 * For `$__mkptr`, every combo has type+aux literal so we special-case the body:
 * fold the prefix into `(i64.const TEMPLATE)` instead of a trampoline call —
 * avoids a runtime indirection for the hottest path.
 *
 * @param funcs    — flat list of func IR nodes (sec.funcs + sec.stdlib + sec.start)
 * @param addFunc  — callback `(watString) => void` to register new helpers
 * @param parseWat — `wat → IR` parser (injected to avoid circular imports)
 */
export function specializeMkptr(funcs, addFunc, parseWat) {
  // Per-target specification: param-types, result-type. Threshold tuned so helper cost amortizes.
  // Any target not listed here is left untouched. Order matters only for readability.
  const SPECS = {
    '$__mkptr':     { params: ['i32', 'i32', 'i32'], result: 'f64', inline: true },
    '$__alloc_hdr':   { params: ['i32', 'i32'],        result: 'i32' },
    '$__alloc_hdr_n': { params: ['i32', 'i32', 'i32'], result: 'i32' },
    '$__typed_idx': { params: ['i64', 'i32'],        result: 'f64' },
    '$__str_idx':   { params: ['i64', 'i32'],        result: 'f64' },
  }
  // 4 is the measured break-even: a specialized helper (trampoline / inline i64.const
  // template) costs ~12 B to define and saves ~2–4 B per site, so 4 sites amortize it.
  // Lower (3) net-inflates the watr self-host; 5 leaves 4-use combos on the table. The
  // threshold (20) is already optimal — its combos cluster far
  // above 20 (the ~2 k-site $__strBase relativization) with nothing in the 5–19 band.
  const MIN_USES = 4

  // Build literal-arg signature key for a call node. Returns null if no args are literal.
  // Key format: 'T:V' per literal arg, 'D' per dynamic; indexed by position.
  const sigKey = (call, nParams) => {
    const key = []
    let anyLit = false
    for (let i = 0; i < nParams; i++) {
      const a = call[2 + i]
      if (Array.isArray(a) && a[0] === 'i32.const' && typeof a[1] === 'number') { key.push('L:' + a[1]); anyLit = true }
      else key.push('D')
    }
    return anyLit ? key.join('|') : null
  }

  // Pass 1: count per (target, sig) AND record candidate site locations for direct
  // rewrite in pass 3. Pre-order push means nested candidates appear later in `sites`,
  // so reverse iteration in pass 3 yields leaf-first rewrite order (inner before outer).
  const counts = new Map()  // 'target##sig' → count
  const sites = []  // { parent, idx, fullKey, parts }
  const walk = (node, parent, idx) => {
    if (!Array.isArray(node)) return
    if (parent && node[0] === 'call' && typeof node[1] === 'string' && SPECS[node[1]]) {
      const spec = SPECS[node[1]]
      if (node.length === 2 + spec.params.length) {
        const k = sigKey(node, spec.params.length)
        if (k) {
          const fullKey = node[1] + '##' + k
          counts.set(fullKey, (counts.get(fullKey) || 0) + 1)
          sites.push({ parent, idx, fullKey, parts: k.split('|') })
        }
      }
    }
    for (let i = 0; i < node.length; i++) walk(node[i], node, i)
  }
  for (let i = 0; i < funcs.length; i++) walk(funcs[i], null, 0)

  // Pass 2: for each eligible (target, sig), emit helper.
  const specialized = new Set()
  for (const [k, n] of counts) if (n >= MIN_USES) specialized.add(k)
  if (!specialized.size) return

  const variantName = (target, sigParts) => target.slice(1) + '_' + sigParts
    .map(p => p === 'D' ? 'd' : p.slice(2)).join('_')

  for (const fullKey of specialized) {
    const [target, sig] = fullKey.split('##')
    const parts = sig.split('|')
    const spec = SPECS[target]
    const name = variantName(target, parts)

    // $__mkptr inline fast path: bake (type, aux) literals into i64.const template.
    if (target === '$__mkptr' && spec.inline && parts[0].startsWith('L:') && parts[1].startsWith('L:')) {
      const type = +parts[0].slice(2), aux = +parts[1].slice(2)
      const tmpl = ptrBits(type, aux)  // box prefix (offset OR'd in at runtime below)
      // Third arg (offset) may also be literal — emit (f64.const nan:…) then.
      if (parts[2].startsWith('L:')) {
        // Fully literal: all sites can be f64.const — no helper needed, handled in rewrite below.
        continue
      }
      addFunc(`(func $${name} (param $o i32) (result f64)
        (f64.reinterpret_i64 (i64.or (i64.const 0x${tmpl.toString(16).toUpperCase()}) (i64.extend_i32_u (local.get $o)))))`)
      continue
    }

    // Generic trampoline: (func $F_LITS (param …dyn) (result R) (call $F lits+dyn))
    const dynArgs = []
    const callArgs = []
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith('L:')) {
        callArgs.push(`(i32.const ${parts[i].slice(2)})`)
      } else {
        dynArgs.push(`(param $a${i} ${spec.params[i]})`)
        callArgs.push(`(local.get $a${i})`)
      }
    }
    addFunc(`(func $${name} ${dynArgs.join(' ')} (result ${spec.result}) (call ${target} ${callArgs.join(' ')}))`)
  }

  // Pass 3: rewrite recorded sites in reverse (leaf-first since pass 1 was pre-order).
  // Iterating the captured site list avoids a second full-AST walk.
  // Idempotency guard: shared subtrees in the IR cause the same (parent, idx) to be
  // recorded as multiple sites. The first visit rewrites; subsequent visits see the
  // rewritten call (target no longer in SPECS) and skip — same behavior as the
  // recursive rewrite this replaces.
  for (let i = sites.length - 1; i >= 0; i--) {
    const { parent, idx, fullKey, parts } = sites[i]
    if (!specialized.has(fullKey)) continue
    const c = parent[idx]
    const target = c[1]
    const spec = SPECS[target]
    if (!spec || c.length !== 2 + spec.params.length) continue

    // $__mkptr fully literal (rare — mkPtrIR usually folds these ahead of us, but defensive):
    if (target === '$__mkptr' && parts[0].startsWith('L:') && parts[1].startsWith('L:') && parts[2].startsWith('L:')) {
      const type = +parts[0].slice(2), aux = +parts[1].slice(2), off = +parts[2].slice(2)
      const n = ['f64.const', 'nan:' + i64Hex(ptrBits(type, aux, off))]
      n.type = 'f64'
      parent[idx] = n
      continue
    }

    const name = variantName(target, parts)
    const dynArgs = []
    for (let j = 0; j < parts.length; j++) if (parts[j] === 'D') dynArgs.push(c[2 + j])
    const newCall = ['call', '$' + name, ...dynArgs]
    newCall.type = spec.result
    parent[idx] = newCall
  }
}


/**
 * Fold dead string-dispatch blocks when the tested operand is a proven-f64 local.
 *
 * jz's `+` emitter produces, for every binary addition whose right operand has an
 * unresolved valType, the pattern:
 *
 *   (block (result f64)
 *     (local.set $B EXPR_A)
 *     (if (result f64)
 *       (call $__is_str_key (i64.reinterpret_f64 (local.tee $C (local.get $P))))
 *       (then (call $__str_concat …))
 *       (else (f64.add (local.get $B) (local.get $C)))))
 *
 * When $P is a proven-f64 local (an f64 param, or an f64-typed local provably set
 * only from f64 arithmetic) it can never hold a string-key NaN-box, so the
 * `$__is_str_key` test is provably false and the `then` branch is dead.
 * Replace the whole block with `(f64.add EXPR_A (local.get $P))`.
 *
 * SOUND: f64 params can never hold a string-key NaN-box by construction (jz
 * only allows strings in f64 slots via explicit mkptr boxing, never a bare
 * param). This fold is additive/gated (only runs when vectorizeLaneLocal is on)
 * and only removes provably-dead string-dispatch overhead.
 *
 * Called in the 'post' phase of optimizeFunc, before vectorizeLaneLocal, so the
 * cleaned IR is what the vectorizer pattern-matches.
 */
// Build the "pure for SIMD lane-inline" map consumed by tryPerPixelColor's Phase-2
// user-function inline (cfg._pureFuncMap). A user function qualifies when its body has
// no side effects: no global.set, no memory store, and no call except $math.* / $__to_num
// (a pure numeric coercion the lane lift strips). foldStrDispatchF64 runs first
// (idempotent) so the purity check sees the folded body — dead __is_str_key dispatch on a
// proven-f64 param would otherwise read as impure. Built in the emit phase (optimizeModule),
// BEFORE the per-function lane vectorizer runs, so callee bodies are still clean scalar.
export function buildPureFuncMap(funcs) {
  const pureFuncMap = new Map()
  const hasSideEffect = (node) => {
    if (!Array.isArray(node)) return false
    const op = node[0]
    if (op === 'global.set') return true
    if (typeof op === 'string' && (op.endsWith('.store') || op.startsWith('memory.'))) return true
    if (op === 'call' && typeof node[1] === 'string' && !node[1].startsWith('$math.') && node[1] !== '$__to_num') return true
    if (op === 'call_indirect' || op === 'call_ref') return true
    return node.some((c, i) => i > 0 && hasSideEffect(c))
  }
  for (const fn of funcs) {
    if (!Array.isArray(fn) || fn[0] !== 'func') continue
    const name = fn[1]
    if (typeof name !== 'string' || name.startsWith('$math.') || name.startsWith('$__')) continue
    foldStrDispatchF64(fn)
    const bodyStart = findBodyStart(fn)
    if (bodyStart < 0) continue
    let pure = true
    for (let i = bodyStart; i < fn.length; i++) if (hasSideEffect(fn[i])) { pure = false; break }
    if (pure) pureFuncMap.set(name, fn)
  }
  return pureFuncMap
}

export function foldStrDispatchF64(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // Collect all f64 params — provably never hold a string-key NaN-box.
  const rawF64 = new Set()
  for (let i = 2; i < bodyStart; i++) {
    const d = fn[i]
    if (Array.isArray(d) && d[0] === 'param' && typeof d[1] === 'string' && d[2] === 'f64')
      rawF64.add(d[1])
  }
  if (!rawF64.size) return  // no f64 params → nothing to fold

  // Transitively extend rawF64: an f64 local set only via f64 arithmetic over rawF64
  // members is itself provably non-string. One forward pass suffices for DAG-shaped
  // straight-line code (the common case); a fixed-point loop covers rare mutual defs.
  // Collect local types first.
  const localTypeMap = new Map()
  for (let i = 2; i < bodyStart; i++) {
    const d = fn[i]
    if (Array.isArray(d) && (d[0] === 'param' || d[0] === 'local') && typeof d[1] === 'string')
      localTypeMap.set(d[1], d[2])
  }
  // An expression is rawF64-valued if it only uses ops that stay in f64 and
  // reads only rawF64 locals (or f64.const). Stops early — we only need the
  // closed set for the pattern's $P operand.
  const isRawF64Expr = (n) => {
    if (!Array.isArray(n)) return false
    const op = n[0]
    if (op === 'f64.const') return true
    if (op === 'local.get' && typeof n[1] === 'string') return rawF64.has(n[1])
    if (op === 'local.tee' && typeof n[1] === 'string') return rawF64.has(n[1]) && isRawF64Expr(n[2])
    if (op === 'f64.add' || op === 'f64.sub' || op === 'f64.mul' || op === 'f64.div' ||
        op === 'f64.neg' || op === 'f64.abs' || op === 'f64.sqrt') {
      return n.slice(1).every(isRawF64Expr)
    }
    return false
  }

  // Single forward pass: a local.set $v EXPR where EXPR is rawF64-valued makes $v rawF64.
  // Repeat until stable (handles ordering edge cases in non-DAG code).
  let changed = true
  while (changed) {
    changed = false
    const scan = (node) => {
      if (!Array.isArray(node)) return
      if ((node[0] === 'local.set' || node[0] === 'local.tee') && typeof node[1] === 'string' &&
          localTypeMap.get(node[1]) === 'f64' && !rawF64.has(node[1]) && isRawF64Expr(node[2])) {
        rawF64.add(node[1]); changed = true
      }
      for (let i = 1; i < node.length; i++) scan(node[i])
    }
    for (let i = bodyStart; i < fn.length; i++) scan(fn[i])
  }

  // Pattern-match and fold in-place (bottom-up recursive walk so nested blocks resolve).
  const foldNode = (node) => {
    if (!Array.isArray(node)) return node
    // Recurse children first (bottom-up).
    for (let i = 0; i < node.length; i++) {
      const c = node[i]
      if (Array.isArray(c)) node[i] = foldNode(c)
    }
    // Match:
    //   ['block', ['result','f64'],
    //     ['local.set', $B, EXPR_A],
    //     ['if', ['result','f64'],
    //       ['call','$__is_str_key', ['i64.reinterpret_f64', ['local.tee',$C,['local.get',$P]]]],
    //       ['then', ['call','$__str_concat',...]],
    //       ['else', ['f64.add', ['local.get',$B], ['local.get',$C]]]]]
    if (node[0] !== 'block') return node
    if (!Array.isArray(node[1]) || node[1][0] !== 'result' || node[1][1] !== 'f64') return node
    if (node.length !== 4) return node
    const setStmt = node[2], ifStmt = node[3]
    if (!Array.isArray(setStmt) || setStmt[0] !== 'local.set' || typeof setStmt[1] !== 'string') return node
    const B = setStmt[1], exprA = setStmt[2]
    if (!Array.isArray(ifStmt) || ifStmt[0] !== 'if') return node
    // if must have: (result f64), cond, then, else — total 5 elements
    if (ifStmt.length !== 5) return node
    if (!Array.isArray(ifStmt[1]) || ifStmt[1][0] !== 'result' || ifStmt[1][1] !== 'f64') return node
    const cond = ifStmt[2], thenB = ifStmt[3], elseB = ifStmt[4]
    // cond: ['call','$__is_str_key',['i64.reinterpret_f64',['local.tee',$C,['local.get',$P]]]]
    if (!Array.isArray(cond) || cond[0] !== 'call' || cond[1] !== '$__is_str_key' || cond.length !== 3) return node
    const reinterpArg = cond[2]
    if (!Array.isArray(reinterpArg) || reinterpArg[0] !== 'i64.reinterpret_f64' || reinterpArg.length !== 2) return node
    const teeNode = reinterpArg[1]
    if (!Array.isArray(teeNode) || teeNode[0] !== 'local.tee' || typeof teeNode[1] !== 'string' || teeNode.length !== 3) return node
    const C = teeNode[1]
    const getP = teeNode[2]
    if (!Array.isArray(getP) || getP[0] !== 'local.get' || typeof getP[1] !== 'string') return node
    const P = getP[1]
    // $P must be a proven f64 local (never a string-key NaN-box)
    if (!rawF64.has(P)) return node
    // then: ['then', ['call','$__str_concat',...]]
    if (!Array.isArray(thenB) || thenB[0] !== 'then') return node
    // else: ['else', ['f64.add', ['local.get',$B], ['local.get',$C]]]
    // Each operand may be wrapped in emit '+' numSide's atom-coercion guard —
    // `(if (f64.eq $X $X) (then $X) (else <atom select ladder>))` — which is dead
    // once the operand is proven rawF64; unwrap to the inner local.get.
    const unwrapGuard = (n) => {
      if (!Array.isArray(n) || n[0] !== 'if' || n.length !== 5) return n
      const [, res, cnd, thn] = n
      if (!Array.isArray(res) || res[0] !== 'result' || res[1] !== 'f64') return n
      if (!Array.isArray(cnd) || cnd[0] !== 'f64.eq') return n
      if (!Array.isArray(thn) || thn[0] !== 'then' || thn.length !== 2) return n
      const inner = thn[1]
      if (!Array.isArray(inner) || inner[0] !== 'local.get') return n
      if (!Array.isArray(cnd[1]) || cnd[1][0] !== 'local.get' || cnd[1][1] !== inner[1]) return n
      return inner
    }
    if (!Array.isArray(elseB) || elseB[0] !== 'else' || elseB.length !== 2) return node
    const addExpr = elseB[1]
    if (!Array.isArray(addExpr) || addExpr[0] !== 'f64.add' || addExpr.length !== 3) return node
    // The two operands of f64.add must be local.get $B and local.get $C (in either order)
    const [lhsAdd, rhsAdd] = [unwrapGuard(addExpr[1]), unwrapGuard(addExpr[2])]
    const lhsIsB = Array.isArray(lhsAdd) && lhsAdd[0] === 'local.get' && lhsAdd[1] === B
    const rhsIsC = Array.isArray(rhsAdd) && rhsAdd[0] === 'local.get' && rhsAdd[1] === C
    const lhsIsC = Array.isArray(lhsAdd) && lhsAdd[0] === 'local.get' && lhsAdd[1] === C
    const rhsIsB = Array.isArray(rhsAdd) && rhsAdd[0] === 'local.get' && rhsAdd[1] === B
    if (!((lhsIsB && rhsIsC) || (lhsIsC && rhsIsB))) return node
    // Match confirmed. Fold to: (f64.add EXPR_A (local.get $P))
    return ['f64.add', exprA, ['local.get', P]]
  }

  for (let i = bodyStart; i < fn.length; i++) fn[i] = foldNode(fn[i])
}

/**
 * Loop-unswitch a polymorphic typed-array PARAM loop on the pointer type so the
 * Float64Array case hoists its base and vectorizes.
 *
 * `export function f(buf,n){ for(let i=0;i<n;i++) buf[i]=g(buf[i],i) }` emits a
 * per-iteration POLYMORPHIC store `(drop (if tag(buf)==ARRAY (then __arr_set_idx_ptr;
 * local.set $buf) (else f64.store __ptr_offset(buf)+i<<3)))` and a read
 * `__to_num(reinterpret(__typed_idx(reinterpret(buf), i)))` — re-decoding the NaN-box
 * base every iteration. The `local.set $buf` realloc reassign marks the param unsafe,
 * so hoistInvariantPtrOffset bails and the loop never vectorizes.
 *
 * Insert a ONCE-before-loop test "is buf a (non-BigInt) Float64Array?": yes → a fast
 * loop with the base hoisted to an i32 local, the read collapsed to `f64.load`, and the
 * polymorphic store replaced by a direct `f64.store` (no calls) — which vectorizeLaneLocal
 * then lifts to f64x2. no → the original block verbatim (bit-exact fallback for ARRAY and
 * every other element width). Float64Array (owned aux=7 or view aux=15) is the ONLY gated
 * type: the else-branch f64.store is 8-byte, valid only for f64 elements; Int32Array /
 * Uint8Array / BigInt64Array (aux 4 / 1 / 23) all fall to the verbatim path. The global-
 * Float64Array path already lowers reads to f64.load, proving f64.load == the __to_num
 * read for f64 elements (bit-exact, incl. NaN). All helpers are nested function decls
 * (no ctx param) per the self-host discipline.
 */
export function unswitchTypedParamLoop(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  // JZ_DBG_UNSWITCH=<substr>: dump matching fns entering this pass (DBG_DSR-style).
  if (DBG_UNSWITCH && String(fn[1]).includes(DBG_UNSWITCH)) console.error(JSON.stringify(fn))
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return
  const f64Params = new Set()
  for (let i = 2; i < bodyStart; i++) {
    const c = fn[i]
    if (Array.isArray(c) && c[0] === 'param' && typeof c[1] === 'string' && c[2] === 'f64') f64Params.add(c[1])
  }
  if (!f64Params.size) return

  const F64 = TYPED_ELEM_CODE.Float64Array, F64V = F64 | TYPED_ELEM_VIEW_FLAG
  const newLocals = []
  let baseId = nextLocalId(fn, 'utb')

  const clone = (n) => Array.isArray(n) ? n.map(clone) : n
  const has = (n, pred) => Array.isArray(n) && (pred(n) || n.some((c, i) => i > 0 && has(c, pred)))
  const writes = (n, name) => has(n, (x) => (x[0] === 'local.set' || x[0] === 'local.tee') && x[1] === name)
  const reintParam = (n, p) => Array.isArray(n) && n[0] === 'i64.reinterpret_f64' && Array.isArray(n[1]) && n[1][0] === 'local.get' && n[1][1] === p
  const typedIdx = (n, p) => Array.isArray(n) && n[0] === 'call' && n[1] === '$__typed_idx' && n.length >= 4 && reintParam(n[2], p)

  // Clone, collapsing the typed-array read to a direct f64.load(base + IND<<3):
  //   __to_num(reinterpret(__typed_idx(reinterpret P, IND)))  — and the bare form too.
  function cloneRead(n, p, base) {
    if (!Array.isArray(n)) return n
    if (n[0] === 'call' && n[1] === '$__to_num' && n.length === 3
        && Array.isArray(n[2]) && n[2][0] === 'i64.reinterpret_f64' && typedIdx(n[2][1], p))
      return ['f64.load', ['i32.add', ['local.get', base], ['i32.shl', clone(n[2][1][3]), ['i32.const', 3]]]]
    if (typedIdx(n, p))
      return ['f64.load', ['i32.add', ['local.get', base], ['i32.shl', clone(n[3]), ['i32.const', 3]]]]
    return n.map((c, i) => i === 0 ? c : cloneRead(c, p, base))
  }

  function processBlock(blockNode, parent, idx) {
    if (!Array.isArray(blockNode) || blockNode[0] !== 'block') return
    let loopNode = null, blockLabel = null
    const preamble = []
    for (let i = 1; i < blockNode.length; i++) {
      const c = blockNode[i]
      if (i === 1 && typeof c === 'string' && c.startsWith('$')) { blockLabel = c; continue }
      if (Array.isArray(c) && c[0] === 'loop') { if (loopNode) return; loopNode = c }
      else if (Array.isArray(c) && c[0] === 'local.set' && !loopNode) preamble.push(c)
      else if (Array.isArray(c)) return
    }
    if (!loopNode || !blockLabel) return
    const loopLabel = typeof loopNode[1] === 'string' && loopNode[1].startsWith('$') ? loopNode[1] : null
    if (!loopLabel) return
    const endIdx = loopNode.length - 1
    if (!(Array.isArray(loopNode[endIdx]) && loopNode[endIdx][0] === 'br' && loopNode[endIdx][1] === loopLabel)) return
    const incNode = loopNode[endIdx - 1]
    if (!Array.isArray(incNode) || incNode[0] !== 'local.set' || !Array.isArray(incNode[2]) || incNode[2][0] !== 'i32.add') return
    const incVar = incNode[1], inc = incNode[2]
    if (!(Array.isArray(inc[1]) && inc[1][0] === 'local.get' && inc[1][1] === incVar && Array.isArray(inc[2]) && inc[2][0] === 'i32.const' && inc[2][1] === 1)) return
    // Pre-watr, jz wraps every multi-statement expression-group in `(block (result T) …)`
    // — as a dropped expression-statement (drop follows) or as an if-arm's tail value.
    // watr's own vacuum/mergeBlocks used to flatten this post-hoc (when this pass ran
    // post-watr); now it runs pre-watr and must see through the wrapper itself. Unlabeled
    // ⇒ not a branch target (the normalizeTransparentBlocks convention, generalized here to
    // result-carrying blocks since these are unambiguous STATEMENT-LIST positions — never
    // operand slots), so a flattened VIEW is exactly equivalent. Non-mutating: the matched
    // `if` node is shared with the verbatim blockNode preserved as the bit-exact else-
    // fallback, so the scan must not restructure it in place.
    const flattenStmts = (arr, from) => {
      const out = []
      for (let i = from; i < arr.length; i++) {
        const c = arr[i]
        if (Array.isArray(c) && c[0] === 'block' && Array.isArray(c[1]) && c[1][0] === 'result') out.push(...flattenStmts(c, 2))
        else out.push(c)
      }
      return out
    }
    const body = flattenStmts(loopNode, 3).slice(0, -2)  // drop the trailing incNode/br (already validated above)
    if (body.length < 4) return

    // Find the polymorphic-store `if` by scanning (it's followed by a `drop` of its
    // f64 result; in the IR the two are separate statements, not (drop (if …))).
    let storeIdx = -1, paramName = null, elseStore = null
    for (let i = 0; i < body.length; i++) {
      const c = body[i]
      if (!Array.isArray(c) || c[0] !== 'if' || !Array.isArray(c[1]) || c[1][0] !== 'result' || c[1][1] !== 'f64') continue
      let thenArm = null, elseArm = null
      for (let k = 2; k < c.length; k++) { const a = c[k]; if (Array.isArray(a)) { if (a[0] === 'then') thenArm = a; else if (a[0] === 'else') elseArm = a } }
      if (!thenArm || !elseArm) continue
      const thenStmts = flattenStmts(thenArm, 1)
      let p = null
      for (const a of thenStmts) {
        if (Array.isArray(a) && a[0] === 'local.set' && f64Params.has(a[1]) && Array.isArray(a[2]) &&
            (a[2][0] === 'local.get' || (a[2][0] === 'call' && a[2][1] === '$__arr_set_idx_ptr'))) p = a[1]
      }
      if (!p || !has(thenArm, (x) => x[0] === 'call' && x[1] === '$__arr_set_idx_ptr')) continue
      // The bare `f64.store(__ptr_offset(o)+i<<3)` is the non-ARRAY fallback. It may be
      // nested under an OBJECT/HASH → __dyn_set guard (emitPolymorphicElementStore's
      // dyn-prop safety fork) — descend to find it; the fast path replaces the whole
      // store with a direct f64.load/store anyway (a proven Float64Array is never an
      // OBJECT, so its dyn arm is dead there). Still bail on the 3-way __typed_set_idx
      // form (mixed element widths — the f64.store fallback isn't the sole non-ARRAY case).
      const findRawStore = (n) => {
        if (!Array.isArray(n)) return null
        if (n[0] === 'f64.store' && Array.isArray(n[1]) && n[1][0] === 'i32.add' &&
            Array.isArray(n[1][2]) && n[1][2][0] === 'i32.shl' &&
            has(n[1], (x) => x[0] === 'call' && x[1] === '$__ptr_offset')) return n
        for (let k = 1; k < n.length; k++) { const r = findRawStore(n[k]); if (r) return r }
        return null
      }
      if (has(elseArm, (x) => x[0] === 'call' && x[1] === '$__typed_set_idx')) continue
      const es = findRawStore(elseArm)
      if (!es) continue
      storeIdx = i; paramName = p; elseStore = es; break
    }
    if (storeIdx < 0) return
    const shiftIdx = elseStore[1][2][1]  // the index from the store's (i32.shl IDX 3)
    // The read uses the IV directly; the store uses a snapshot `$asi = $iv`. Emit the
    // store against the IV too so the vectorizer unifies the load/store lanes — bit-exact
    // ($asi == $iv). Bail if the store index isn't the IV or a snapshot of it.
    let storeIdxName = null
    if (Array.isArray(shiftIdx) && shiftIdx[0] === 'local.get') storeIdxName = shiftIdx[1]
    if (storeIdxName !== incVar &&
        !body.some((st) => Array.isArray(st) && st[0] === 'local.set' && st[1] === storeIdxName && Array.isArray(st[2]) && st[2][0] === 'local.get' && st[2][1] === incVar)) return
    // The store-if pushes f64; a following `drop` (bare string in stack-style IR, or a
    // `['drop', …]` node) pops it. The fast store pushes nothing, so the drop must go too.
    const isDrop = (s) => s === 'drop' || (Array.isArray(s) && s[0] === 'drop')
    const hasDrop = storeIdx + 1 < body.length && isDrop(body[storeIdx + 1])

    // The stored value is the else-store's operand (a local the body computed); take it
    // from the store itself, not by guessing which local reads buf — the read may be
    // nested in a split computation (`$t = buf[i]; $v = $t*2`) whose result is a DIFFERENT
    // local. cloneRead rewrites any buf reads in that computation to f64.load.
    if (!(Array.isArray(elseStore[2]) && elseStore[2][0] === 'local.get')) return
    const valName = elseStore[2][1]
    // GUARD: param reassigned ONLY inside the matched store-if (else the hoisted base goes stale).
    for (let i = 0; i < body.length; i++) { if (i === storeIdx) continue; if (writes(body[i], paramName)) return }
    for (const s of preamble) { if (writes(s, paramName)) return }

    const base = `$__utb${baseId++}`
    newLocals.push(['local', base, 'i32'])
    const reint = () => ['i64.reinterpret_f64', ['local.get', paramName]]
    const tag = ['i32.and', ['i32.wrap_i64', ['i64.shr_u', reint(), ['i64.const', LAYOUT.TAG_SHIFT]]], ['i32.const', LAYOUT.TAG_MASK]]
    const auxOf = () => ['i32.and', ['i32.wrap_i64', ['i64.shr_u', reint(), ['i64.const', LAYOUT.AUX_SHIFT]]], ['i32.const', LAYOUT.AUX_MASK]]
    const gate = ['i32.and', ['i32.eq', tag, ['i32.const', PTR.TYPED]],
      ['i32.or', ['i32.eq', auxOf(), ['i32.const', F64]], ['i32.eq', auxOf(), ['i32.const', F64V]]]]
    const baseSnap = ['local.set', base, ['call', '$__ptr_offset', reint()]]
    const fastStore = ['f64.store', ['i32.add', ['local.get', base], ['i32.shl', ['local.get', incVar], ['i32.const', 3]]], ['local.get', valName]]
    // Fast body: keep every statement except the store-if (→ fastStore) and its trailing
    // drop (the fast store pushes nothing), with the typed-array read collapsed to f64.load.
    const fastStmts = []
    for (let i = 0; i < body.length; i++) {
      if (i === storeIdx) { fastStmts.push(fastStore); continue }
      if (hasDrop && i === storeIdx + 1) continue
      fastStmts.push(cloneRead(body[i], paramName, base))
    }
    const fastLoop = ['block', blockLabel, ...preamble.map(clone),
      ['loop', loopLabel, clone(loopNode[2]), ...fastStmts, clone(incNode), clone(loopNode[endIdx])]]
    parent[idx] = ['if', gate, ['then', baseSnap, fastLoop], ['else', blockNode]]
  }

  function walk(node, parent, idx) {
    if (!Array.isArray(node)) return
    if (node[0] === 'block') {
      const before = parent[idx]
      processBlock(node, parent, idx)
      if (parent[idx] !== before) return
    }
    for (let i = 0; i < node.length; i++) walk(node[i], node, i)
  }
  for (let i = bodyStart; i < fn.length; i++) walk(fn[i], fn, i)
  if (newLocals.length) fn.splice(bodyStart, 0, ...newLocals)
}

/** Hoist the SSO/heap choice out of a leaf byte-scan loop.
 *
 * `emitDecompCharRead` deliberately makes both select arms trap-free: SSO
 * routes the speculative heap load to memory[0+idx], while heap receivers may
 * harmlessly evaluate the packed-byte shift. A loop-invariant select is still
 * paid per byte, however. For a compact call-free loop, version the loop once
 * on `$param$ccsso` and fold every matching select in each clone. This is a
 * representation-level loop unswitch, not a source/benchmark special case.
 * Large or call-bearing parser loops fail closed to avoid I-cache growth. */
function unswitchStringRepLoop(fn) {
  const clone = n => Array.isArray(n) ? n.map(clone) : n
  const size = n => !Array.isArray(n) ? 1 : 1 + n.slice(1).reduce((s, x) => s + size(x), 0)
  const containsName = (n, name) => {
    if (!Array.isArray(n)) return false
    if (n[0] === 'local.get' && n[1] === name) return true
    for (let i = 1; i < n.length; i++) if (containsName(n[i], name)) return true
    return false
  }
  const match = n => {
    if (!Array.isArray(n) || n[0] !== 'select' || n.length !== 4) return null
    const c = n[3]
    if (!Array.isArray(c) || c[0] !== 'local.get' || typeof c[1] !== 'string' || !c[1].endsWith('$ccsso')) return null
    const stem = c[1].slice(0, -6)
    if (!containsName(n[1], `${stem}$ccp64`) || !containsName(n[2], `${stem}$ccldb`)) return null
    return c[1]
  }
  const hasCallOrWrite = (n, flag) => {
    if (!Array.isArray(n)) return false
    if (n[0] === 'call' || n[0] === 'call_indirect' || n[0] === 'return_call' ||
        ((n[0] === 'local.set' || n[0] === 'local.tee') && n[1] === flag)) return true
    for (let i = 1; i < n.length; i++) if (hasCallOrWrite(n[i], flag)) return true
    return false
  }
  const collect = (n, out, nested = false) => {
    if (!Array.isArray(n)) return
    if (nested && n[0] === 'loop') return
    const m = match(n)
    if (m) out.push(m)
    for (let i = 1; i < n.length; i++) collect(n[i], out, nested || n[0] === 'loop')
  }
  const choose = (n, flag, arm) => {
    if (!Array.isArray(n)) return n
    if (match(n) === flag) return choose(n[arm], flag, arm)
    return n.map(x => choose(x, flag, arm))
  }
  const visit = (n, parent, idx) => {
    if (!Array.isArray(n)) return
    if (n[0] === 'loop' && parent && size(n) <= 250 &&
        !n.some(x => Array.isArray(x) && (x[0] === 'result' || x[0] === 'param'))) {
      const flags = []
      collect(n, flags)
      const flag = flags[0]
      if (flag && flags.every(x => x === flag) && !hasCallOrWrite(n, flag)) {
        parent[idx] = ['if', ['local.get', flag],
          ['then', choose(clone(n), flag, 1)],
          ['else', choose(clone(n), flag, 2)]]
        return
      }
    }
    for (let i = 1; i < n.length; i++) visit(n[i], n, i)
  }
  visit(fn, null, -1)
}

/**
 * Run all per-function IR optimizations on a single function node.
 * hoistPtrType runs first — it introduces new locals (`$__ptN`) that the fused
 * walk should see in their final form. fusedRewrite then collapses rebox/unbox
 * round-trips, inlines tiny ptr/is_* helpers, and folds (i32.add base const)
 * into memarg offset= form, all in a single bottom-up traversal — and
 * piggybacks local-ref counting so sortLocalsByUse skips its own walk.
 *
 * @param fn  func IR node
 * @param cfg optional resolved config from resolveOptimize() — when omitted, all on.
 * @param globalTypes optional global name → wasm type map (for promoteGlobals)
 * @param volatileGlobals optional set of callee-mutable globals (see collectVolatileGlobals)
 * (The former 'post' phase and its csePureExprLoop arm are deleted, and the
 * straight-line csePureExpr followed in the 2026-07 ablation sweeps — watr's
 * write-clock CSE reaches a smaller fixpoint on its own; jz's optimizer runs
 * exactly once, before watr. splitLoopPrivateScratch remains as the flag-gated
 * migration seed; see the splitScratch gate below.)
 */
export function optimizeFunc(fn, cfg, globalTypes, volatileGlobals, reachableWrites) {
  // Entry verify attributes an invalid-IR failure to EMIT (already bad here)
  // vs an optimizer pass (bad only at the exit check) — the jzify free-name
  // `local.get $__it_drain` class was pinned this way. Debug-only cost.
  if (DBG_IR) { const bad = verifyFn(fn); if (bad) throw new Error(`[ir verify] fn ${fn[1]} invalid at optimizeFunc ENTRY (emit-produced): ${bad}`) }
  if (cfg && cfg.hoistPtrType === false &&
      cfg.hoistInvariantPtrOffset === false &&
      cfg.hoistInvariantLoop === false &&
      cfg.narrowLoopBound === false &&
      cfg.fusedRewrite === false &&
      cfg.hoistAddrBase === false &&
      cfg.cseScalarLoad === false &&
      cfg.unswitchStringRepLoop === false &&
      cfg.propagateSingleUse === false &&
      cfg.promoteGlobals === false &&
      cfg.sortLocalsByUse === false &&
      cfg.vectorizeLaneLocal === false) return
  // Static-const-array base/len fold runs FIRST: it matches the exact emit shape
  // via node tags (.saArr/.saBits), and any later pass that rebuilds a subtree
  // (CSE, fused rewrite, LICM temp-splitting) strips array properties — the tag
  // only survives untouched nodes.
  if (!cfg || cfg.foldStaticArrReads !== false) foldStaticConstArrayReads(fn)
  // Recursion-unrolling runs first in 'pre': self-calls are still clean `call`
  // nodes (watr's inliner hasn't reshaped them) and the freshly-inlined body then
  // rides every pass below (LICM, fold, sort). Speed-tier only; 'pre' only (so the
  // post-watr re-optimize doesn't unroll a second time).
  if (cfg && cfg.recursionUnroll === true) recursionUnroll(fn)
  if (!cfg || cfg.hoistPtrType !== false) hoistPtrType(fn)
  if (!cfg || cfg.hoistInvariantPtrOffset !== false) hoistInvariantPtrOffset(fn)
  // Before LICM: the snapped i32 bound is itself a hoistable hard-op subtree, so
  // an outer loop's LICM can lift it further when the bound is outer-invariant.
  if (!cfg || cfg.narrowLoopBound !== false) narrowLoopBound(fn)
  // Unified LICM (replaces hoistInvariantToInt32 / PtrOffsetLoop / CellLoads).
  // Run at both maturity points (idempotent): pre-fusedRewrite catches the raw
  // ToInt32/ptr-offset/arithmetic shapes; post-hoistAddrBase catches cell loads.
  if (!cfg || cfg.hoistInvariantLoop !== false) hoistInvariantLoop(fn)
  const counts = new Map()
  if (!cfg || cfg.fusedRewrite !== false) fusedRewrite(fn, counts)
  if (cfg && cfg.unswitchStringRepLoop === true && ctx.func.list.length <= 64 &&
      fn.some(n => Array.isArray(n) && n[0] === 'local' && typeof n[1] === 'string' && n[1].endsWith('$ccsso')))
    unswitchStringRepLoop(fn)
  if (cfg && cfg.boolConvertToSelect === true) boolConvertToSelect(fn)
  if (!cfg || cfg.hoistAddrBase !== false) hoistAddrBase(fn)
  if (!cfg || cfg.hoistInvariantLoop !== false) hoistInvariantLoop(fn)
  if (!cfg || cfg.cseScalarLoad !== false) cseScalarLoad(fn)
  if (!cfg || cfg.promoteGlobals !== false) promoteGlobals(fn, globalTypes, volatileGlobals, reachableWrites)
  if (cfg && cfg.vectorizeLaneLocal === true) {
    // Vectorization is jz LOWERING — it always runs pre-watr (never in a post-watr
    // re-optimize). watr is the sole optimizer that runs after, and it preserves the
    // v128 the lift produces. `phase === 'post'` is now vestigial (no post caller).
    // Phase 1: fold dead string-dispatch blocks on proven-f64 locals BEFORE
    // the vectorizer pattern-matches — dead __is_str_key calls in $fbm-style
    // functions (param f64 + op f64) block liftPPC from recognizing them as pure.
    if (!cfg || cfg.unswitchTypedParamLoop !== false) unswitchTypedParamLoop(fn)
    foldStrDispatchF64(fn)
    if (vectorizeLaneLocal(fn, {
      multiAcc: cfg.reduceUnroll === true,
      relaxedFma: cfg.relaxedSimd === true,
      blurMP: cfg.blurMultiPixel !== false,
      whyNot: cfg.whyNotSimd === true,
      stencil: cfg.experimentalStencil !== false,
      outerStrip: cfg.experimentalOuterStrip !== false,
      pureFuncMap: cfg._pureFuncMap || null,
      toneMap: cfg.experimentalToneMap !== false,
      slp: cfg.experimentalSlp !== false,  // SLP default-on (testing single-use fix)
      crPow: cfg.crPow === true,
    }) && typeof fn[1] === 'string') (cfg._vectorizedFnNames ??= new Set()).add(fn[1])
    // The vectorizer emits `v128.load/store (i32.add base K)` for the unrolled
    // multi-accumulator reduction (a[i],a[i+2],a[i+4]…) and stencil/strided reads.
    // fusedRewrite's memarg fold already ran (above, before vectorize), so fold the
    // freshly-created v128 memargs now — one fewer i32.add per accumulator per
    // iteration, the hot-loop waste audit-fixpoint.mjs flagged on dot/sum.
    foldV128Memargs(fn)
  }
  // Preserve source-unrolled SSA scratch before propagation sinks its single
  // definition into a local.tee. The transform is gated while it matures; when
  // enabled, its moved invariants ride the normal LICM pass once more below.
  if (cfg && cfg.splitScratch === true && (!cfg || cfg.hoistInvariantLoop !== false)) {
    splitLoopPrivateScratch(fn)
    hoistInvariantLoop(fn)
  }
  // Forward-substitute single-use temps — AFTER the vectorizer, never before: it pattern-matches a
  // STRAIGHT-LINE `s += a[i]*2`, and folding an address/index temp out scrambles it (the typed-array
  // loop fell from a SIMD body to a scalar unroll, +231 B). For watr:false the whole pipeline is the
  // 'pre' phase (no 'post' re-run), so vectorize already ran above; for full watr the vectorizer is
  // deferred to 'post', so skip 'pre' here to stay after it. (propagateSingleUse itself skips any
  // function the vectorizer already lifted to v128.)
  // Forward-substitute single-use temps AFTER the vectorizer (which now always runs in
  // 'pre', above) — propagateSingleUse itself skips any function already lifted to v128.
  if (!cfg || cfg.propagateSingleUse !== false) propagateSingleUse(fn)
  // Then sink single-def RHS into first use as a tee — captures the simplify-locals slack
  // watr's use-count propagate leaves (set→tee fold, incl. effectful single-use forward).
  if (!cfg || cfg.foldSetToTee !== false) foldSetToTee(fn)
  // A second idempotent sweep catches fresh opportunities exposed by
  // propagation/fold-to-tee. The first sweep above does the important work
  // while source-level SSA names are still explicit.
  if (cfg && cfg.splitScratch === true && (!cfg || cfg.hoistInvariantLoop !== false)) {
    splitLoopPrivateScratch(fn)
    hoistInvariantLoop(fn)
  }
  // Const-fn-array dispatch devirt: emit tagged the call_indirect of
  // `constOps[idx](args)` (the decl's candidate set only fills when module init
  // emits, AFTER function bodies) — rewrite to a br_table of direct calls with
  // the original call_indirect as the always-sound default arm.
  if (!cfg || cfg.devirtFnArrays !== false) devirtConstFnArrayCalls(fn, cfg)
  if (!cfg || cfg.devirtSchemaReads !== false) devirtSchemaReads(fn)
  // Loop rotation — the LAST shape pass. Runs in the pre phase (the only phase now); the
  // vectorizer above has already formed the v128 loops it skips. Speed-tier: it duplicates the
  // loop condition for a fused conditional back-edge (1.35× on the lz/qoi scalar scans). watr's
  // loopify is disabled when vectorizing, so nothing downstream reverts the rotation.
  if (cfg && cfg.rotateLoops === true) rotateLoops(fn)
  // Canonicalize boolean conditions (strip redundant `!= 0` / double-`eqz`) — after
  // rotateLoops so its fused back-edges get cleaned too. Tied to the peephole pass.
  if (!cfg || cfg.fusedRewrite !== false) simplifyBoolContexts(fn)
  if (!cfg || cfg.sortLocalsByUse !== false) sortLocalsByUse(fn, cfg && cfg.fusedRewrite !== false ? counts : null)
  // An optimizer pass that emits a malformed local — the class that otherwise dies
  // as an opaque watr "Duplicate/Unknown local $x" several phases on — is caught
  // here, pinned to the function and the bad name.
  if (DBG_IR) { const bad = verifyFn(fn); if (bad) throw new Error(`[ir verify] optimize produced invalid IR in ${fn[1]}: ${bad}`) }
}

// Fold `(v128.load/store (i32.add base K) …)` → `(… offset=K base …)`. Same logic as
// walkRewrite's scalar foldMemargOffsets (MEMOP path), but for the v128 loads/stores the
// lane vectorizer creates AFTER fusedRewrite has already run — so they'd otherwise keep a
// per-iteration i32.add. Bottom-up, in place; an addr already in offset=/align= form is left.
function foldV128Memargs(node) {
  if (!Array.isArray(node)) return
  const op = node[0]
  if (op === 'v128.load' || op === 'v128.store') {
    const m1 = node[1]
    if (!(typeof m1 === 'string' && (m1.startsWith('offset=') || m1.startsWith('align='))) &&
        Array.isArray(m1) && m1[0] === 'i32.add' && m1.length === 3) {
      const a = m1[1], b = m1[2]
      let base, offset
      if (Array.isArray(b) && b[0] === 'i32.const' && typeof b[1] === 'number' && b[1] >= 0 && b[1] < 0x100000000) { base = a; offset = b[1] }
      else if (Array.isArray(a) && a[0] === 'i32.const' && typeof a[1] === 'number' && a[1] >= 0 && a[1] < 0x100000000) { base = b; offset = a[1] }
      if (base != null) { node[1] = `offset=${offset}`; node.splice(2, 0, base) }
    }
  }
  for (let i = 1; i < node.length; i++) foldV128Memargs(node[i])
}

// i32 comparison/eqz negations — used to flip a break-condition into the
// loop-continue condition. f64 compares are deliberately ABSENT: ¬(a<b) ≠ (a≥b)
// across NaN, so those fall through to the `i32.eqz` wrap below.
const ROT_NEG = {
  'i32.eqz': null, // sentinel: strip the eqz (handled specially)
  'i32.eq': 'i32.ne', 'i32.ne': 'i32.eq',
  'i32.lt_s': 'i32.ge_s', 'i32.ge_s': 'i32.lt_s', 'i32.gt_s': 'i32.le_s', 'i32.le_s': 'i32.gt_s',
  'i32.lt_u': 'i32.ge_u', 'i32.ge_u': 'i32.lt_u', 'i32.gt_u': 'i32.le_u', 'i32.le_u': 'i32.gt_u',
}

// Boolean-context canonicalization. At a true zero/nonzero position — a `br_if`,
// `if`, `i32.eqz`, or `select` CONDITION — these are all equivalent to the inner
// value: `i32.ne(X, 0) → X`, `i32.ne(0, X) → X`, `i32.eqz(i32.eqz(X)) → X`. jz
// emits the redundant compare from `while (x !== 0)` lowering and from rotateLoops'
// `negate` (which strips one `eqz` but leaves the `i32.ne`). V8 happens to fold it,
// but JSC/wasmtime needn't — so strip it for MINIMAL output regardless of engine.
// Only applied at proven boolean positions (never on a value-position `ne`/`eqz`,
// which produce a real 0/1).
const boolSimp = (n) => {
  for (;;) {
    if (!Array.isArray(n)) return n
    if (n[0] === 'i32.ne' && n.length === 3) {
      if (Array.isArray(n[2]) && n[2][0] === 'i32.const' && n[2][1] === 0) { n = n[1]; continue }
      if (Array.isArray(n[1]) && n[1][0] === 'i32.const' && n[1][1] === 0) { n = n[2]; continue }
    }
    if (n[0] === 'i32.eqz' && Array.isArray(n[1]) && n[1][0] === 'i32.eqz' && n[1].length === 2) { n = n[1][1]; continue }
    return n
  }
}
function simplifyBoolContexts(fn) {
  const walk = (node) => {
    if (!Array.isArray(node)) return
    for (let i = 1; i < node.length; i++) walk(node[i])
    const op = node[0]
    if (op === 'br_if' && node.length === 3) node[2] = boolSimp(node[2])
    else if (op === 'i32.eqz' && node.length === 2) node[1] = boolSimp(node[1])
    else if (op === 'if') { const ci = (Array.isArray(node[1]) && node[1][0] === 'result') ? 2 : 1; if (Array.isArray(node[ci])) node[ci] = boolSimp(node[ci]) }
    else if (op === 'select' && node.length === 4 && Array.isArray(node[3])) node[3] = boolSimp(node[3])
  }
  const bodyStart = findBodyStart(fn)
  for (let i = bodyStart; i < fn.length; i++) walk(fn[i])
}

/**
 * Loop rotation (loop inversion). Convert jz's top-test loop idiom
 *   (block $brk (loop $loop (br_if $brk ¬C) BODY… (br $loop)))
 * into a guarded bottom-test loop with a FUSED conditional back-edge:
 *   (block $brk (br_if $brk ¬C) (loop $loop BODY… (br_if $loop C)))
 *
 * V8/TurboFan lowers the fused `br_if $loop C` to one hardware loop branch — the
 * shape LLVM gives rust/zig, and the reason their hot scalar loops (lz's greedy
 * match-scan, qoi's run-length scan) beat jz's top-test form, which compiles to a
 * forward exit-branch PLUS a separate unconditional back-jump. Measured 1.35× on
 * the lz inner loop; nothing else jz runs reaches this shape — watr's `loopify`
 * collapses to `loop { if C { …; br } }`, whose back-jump stays UNfused (no win).
 *
 * Evaluation count of C is unchanged: guard-once + one back-edge per iteration ==
 * the top-test form's once-per-loop-top — so it's sound even when C has side
 * effects (a `local.tee` recurrence, a call). The condition is duplicated only in
 * the EMITTED text (guard + back-edge), a small size-for-speed trade — speed-tier.
 *
 * Conservative skips:
 *   - any v128/SIMD op in the loop — already register-tight; reshaping risks
 *     disturbing the lane structure (mirrors hoistInvariantLoop's hasV128 guard).
 *   - a body that branches to $loop: a `continue` with no step lands on the loop
 *     label, which after rotation sits BEFORE the back-edge test — rotating would
 *     skip it. (jz wraps continue-with-step in a `$cont` block → targets that, not
 *     $loop → still rotatable.)
 */
function rotateLoops(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  const clone = (n) => Array.isArray(n) ? n.map(clone) : n
  // Break-condition C → loop-continue condition ¬C for the back-edge. Fold the
  // i32 forms so the back-edge stays ONE fused compare-and-branch (a wrapping
  // `i32.eqz` would add an op inside the hot loop); everything else wraps.
  const negate = (c) => {
    if (Array.isArray(c) && c[0] === 'i32.eqz' && c.length === 2) return c[1]
    if (Array.isArray(c) && c.length === 3 && ROT_NEG[c[0]]) return [ROT_NEG[c[0]], c[1], c[2]]
    return ['i32.eqz', c]
  }
  const targetsLabel = (n, label) => {
    if (!Array.isArray(n)) return false
    const op = n[0]
    if (op === 'br' || op === 'br_if') { if (n[1] === label) return true }
    else if (op === 'br_table') { for (let i = 1; i < n.length; i++) if (n[i] === label) return true }
    for (let i = 1; i < n.length; i++) if (targetsLabel(n[i], label)) return true
    return false
  }
  const hasV128 = (n) => Array.isArray(n) && (
    (typeof n[0] === 'string' && (n[0].startsWith('v128.') || /^[if]\d+x\d+\./.test(n[0]))) ||
    n.some((c, i) => i > 0 && hasV128(c)))

  const tryRotate = (blk) => {
    let bi = 1, blockLabel = null
    if (typeof blk[1] === 'string' && blk[1][0] === '$') { blockLabel = blk[1]; bi = 2 }
    if (!blockLabel) return null
    // The loop must be the block's final child; LICM may hoist invariant snaps into
    // a `local.set` pre-header before it — keep those ahead of the guard (the guard
    // condition can read them). Bail on anything else (typed blocks, side computations).
    const preamble = []
    let loop = null
    for (let i = bi; i < blk.length; i++) {
      const c = blk[i]
      if (Array.isArray(c) && c[0] === 'loop') { if (loop || i !== blk.length - 1) return null; loop = c }
      else if (Array.isArray(c) && c[0] === 'local.set' && !loop) preamble.push(c)
      else return null
    }
    if (!loop) return null
    let li = 1, loopLabel = null
    if (typeof loop[1] === 'string' && loop[1][0] === '$') { loopLabel = loop[1]; li = 2 }
    if (!loopLabel) return null
    const loopHeader = []
    while (li < loop.length) {
      const c = loop[li]
      if (Array.isArray(c) && c[0] === 'type') { loopHeader.push(c); li++; continue }
      if (Array.isArray(c) && (c[0] === 'param' || c[0] === 'result')) return null
      break
    }
    const body = loop.slice(li)
    if (body.length < 2) return null
    const head = body[0], tail = body[body.length - 1]
    if (!(Array.isArray(head) && head[0] === 'br_if' && head[1] === blockLabel && head.length === 3)) return null
    if (!(Array.isArray(tail) && tail[0] === 'br' && tail[1] === loopLabel && tail.length === 2)) return null
    const inner = body.slice(1, -1)
    if (inner.some((s) => targetsLabel(s, loopLabel))) return null   // continue → loop top: unsafe
    if (hasV128(head) || inner.some(hasV128)) return null            // vectorized: leave tight
    const cond = head[2]
    return ['block', blockLabel, ...preamble,
      ['br_if', blockLabel, clone(cond)],
      ['loop', loopLabel, ...loopHeader, ...inner, ['br_if', loopLabel, negate(cond)]]]
  }

  // Rotate a (block …) at container[i] in place, else descend. Returns true if it fired.
  const tryAt = (container, i) => {
    const c = container[i]
    if (!Array.isArray(c) || c[0] !== 'block') return false
    const rot = tryRotate(c)
    if (!rot) return false
    container[i] = rot
    walk(rot)
    return true
  }
  const walk = (node) => {
    if (!Array.isArray(node)) return
    for (let i = 0; i < node.length; i++) if (!tryAt(node, i)) walk(node[i])
  }
  // Top-level statements (a loop block can BE fn[i], not just nested under one).
  for (let i = bodyStart; i < fn.length; i++) if (!tryAt(fn, i)) walk(fn[i])
}

// The i32 form of an integer-valued f64 expression, or null. Used to push ToInt32
// through a conditional and to collapse the f64 round-trip on integer `+`/`-`.
// Lossless by construction: `convert_i32(X) → X`; integer `f64.const → i32.const`
// (ToInt32); `f64.add/sub` of i32-valued operands → `i32.add/sub` (mod-2³² is a ring
// homomorphism, and each i32±i32 < 2³² < 2⁵³ so the f64 op is exact). EXCLUDES `mul`
// (products can exceed 2⁵³, so the f64 op loses precision and i32.mul wouldn't match)
// and anything non-integer or unprovable. Address `local.tee`s inside operands are
// preserved (kept as-is in the returned i32 tree).
function toI32(n) {
  if (!Array.isArray(n)) return null
  const op = n[0]
  if ((op === 'f64.convert_i32_s' || op === 'f64.convert_i32_u') && n.length === 2) return n[1]
  // i32-range consts only: keeps every leaf within i32 so f64 add/sub of leaves stays exact
  // (< 2^53) and ToInt32-homomorphic. A larger const would round in f64.add or saturate in
  // trunc_sat differently from JS `|0`, breaking the fold.
  if (op === 'f64.const' && typeof n[1] === 'number' && (n[1] | 0) === n[1]) return ['i32.const', n[1]]
  if ((op === 'f64.add' || op === 'f64.sub') && n.length === 3) {
    const a = toI32(n[1]), b = toI32(n[2])
    if (a && b) return [op === 'f64.add' ? 'i32.add' : 'i32.sub', a, b]
  }
  // ToInt32 distributes through a conditional: ToInt32(if C A B) == if(result i32) C
  // ToInt32(A) ToInt32(B). Recursive — a nested integer `?:` like `((3<a)?(2&a):((7<a)?a:1))|0`
  // narrows whole to i32 (each arm folded by toI32, incl. nested ifs), so the lane vectorizer
  // lifts it as i32x4 bitselect instead of bailing on the f64 result. Only reached from
  // ToInt32 sinks (the select idiom / toI32 recursion), so the i32 result is always wanted.
  if (op === 'if' && Array.isArray(n[1]) && n[1][0] === 'result' && n[1][1] === 'f64'
      && Array.isArray(n[3]) && n[3][0] === 'then' && n[3].length === 2
      && Array.isArray(n[4]) && n[4][0] === 'else' && n[4].length === 2) {
    const t = toI32(n[3][1]), e = toI32(n[4][1])
    if (t && e) return ['if', ['result', 'i32'], n[2], ['then', t], ['else', e]]
  }
  return null
}

// Fused bottom-up walk applying three orthogonal pattern sets at each node:
//   inlinePtrType  — call $__ptr_type / __ptr_aux / __is_nullish / __is_null / __is_truthy
//                    (skipped inside $__ptr_*/__is_* helper bodies themselves)
//   peephole       — rebox/unbox round-trips: i64.reinterpret_f64 / f64.reinterpret_i64 /
//                    i32.wrap_i64 over (i64.extend_i32_u/_s X) or (i64.or HIGH_ONLY extend X)
//   foldMemarg     — (load/store (i32.add base (i32.const N)) …) → (load/store offset=N base …)
// They discriminate on node[0] and don't overlap, so one visit suffices for all three.
function fusedRewrite(fn, counts) {
  if (!Array.isArray(fn) || fn[0] !== 'func') {
    if (Array.isArray(fn)) {
      for (let i = 0; i < fn.length; i++) {
        const c = fn[i]
        if (Array.isArray(c)) fn[i] = walkRewrite(c, true, counts, null, null)
      }
    }
    return
  }
  // Skip __ptr_*/is_* bodies for inline pattern (they ARE the helpers).
  const name = typeof fn[1] === 'string' ? fn[1] : null
  const skipInline = !!(name && (name.startsWith('$__ptr_') || name === '$__is_nullish' || name === '$__is_truthy' || name === '$__is_null'))
  const bodyStart = findBodyStart(fn)
  // i64 scratch allocator for the literal-eq inline: any-shaped operand is
  // tee'd once instead of duplicated. Decls splice in after the walk.
  const newDecls = []
  // pre+post phases both run this pass — continue numbering past any scratch
  // locals the earlier phase already declared, or the decls collide.
  let scratchN = 0
  for (let i = 2; i < fn.length; i++) {
    const d = fn[i]
    if (Array.isArray(d) && d[0] === 'local' && typeof d[1] === 'string') {
      const m = d[1].match(/^\$__eq[tf](\d+)$/)
      if (m) scratchN = Math.max(scratchN, +m[1] + 1)
    }
  }
  const freshI64 = () => { const n = `$__eqt${scratchN++}`; newDecls.push(['local', n, 'i64']); return n }
  const freshF64 = () => { const n = `$__eqf${scratchN++}`; newDecls.push(['local', n, 'f64']); return n }
  // Single-textual-def locals → their defining value node, so the trunc_sat range fold (below)
  // can see through the temps inlining introduces when proving an index/packed value fits i32.
  // Multi-def (incl. loop-carried self-referential) locals are excluded: their value is not the
  // one def's, so its range wouldn't bound them. PARAMS are excluded outright: a param carries an
  // IMPLICIT entry def the textual scan can't see, and it is the one local class whose pre-write
  // value is externally controlled — `f = (p) => { use(1 >>> Math.abs(p)); p = 0 }` resolved p→0,
  // claimed range [0,0], and the collapsed bare trunc_sat saturated an incoming -Infinity to a
  // 31-lane shift (ToUint32(∞) is 0; the fuzzer's seed-6465 miscompile). Non-param pre-def reads
  // can only be the zero/undef-NaN init, and trunc_sat maps BOTH exactly as ToInt32 does, so the
  // textual rule stays sound for every other local. Pure read of the IR — value-preserving
  // rewrites during this same walk keep the captured def's RANGE intact, so a lazily-built map
  // stays sound. Built on first query only.
  let defVal
  const get = (name) => {
    if (defVal === undefined) {
      defVal = new Map(); const defCnt = new Map()
      for (let i = 2; i < fn.length; i++) {
        const d = fn[i]
        if (Array.isArray(d) && d[0] === 'param' && typeof d[1] === 'string') defCnt.set(d[1], 2)
      }
      const scanDefs = (n) => {
        if (!Array.isArray(n)) return
        if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') { defCnt.set(n[1], (defCnt.get(n[1]) || 0) + 1); defVal.set(n[1], n[2]) }
        for (let i = 1; i < n.length; i++) scanDefs(n[i])
      }
      for (let i = bodyStart; i < fn.length; i++) scanDefs(fn[i])
      for (const [k, c] of defCnt) if (c > 1) defVal.delete(k)
    }
    return defVal.get(name) || null
  }
  for (let i = bodyStart; i < fn.length; i++) {
    const c = fn[i]
    if (Array.isArray(c)) fn[i] = walkRewrite(c, !skipInline, counts, freshI64, freshF64, get)
  }
  if (newDecls.length) fn.splice(bodyStart, 0, ...newDecls)
}

function walkRewrite(node, doInline, counts, freshI64, freshF64, get) {
  if (!Array.isArray(node)) return node
  for (let i = 0; i < node.length; i++) {
    const c = node[i]
    if (Array.isArray(c)) node[i] = walkRewrite(c, doInline, counts, freshI64, freshF64, get)
  }
  const op = node[0]
  // Piggyback local-ref counting for sortLocalsByUse. `counts` may be undefined
  // when fusedRewrite is called outside optimizeFunc (whole-module pass).
  if (counts && (op === 'local.get' || op === 'local.set' || op === 'local.tee') && typeof node[1] === 'string')
    counts.set(node[1], (counts.get(node[1]) || 0) + 1)

  // Generic-equality bit-eq fast path: $__eq's own first branch hoisted to the
  // site when both args duplicate cheaply (local.get / reinterpret of one).
  // Identical bits ⇒ equal-unless-canonical-NaN; static-literal dedup + SSO +
  // slice interning make the hit dominant in tree-walking code (tag compares),
  // so most sites skip the call. The else arm keeps the original call.
  if (doInline && op === 'call' && (node[1] === '$__eq' || node[1] === '$__str_eq')
      && node.length === 4 && !node._eqFast) {
    const cheap = (n) => Array.isArray(n) &&
      (n[0] === 'local.get' ||
        (n[0] === 'i64.reinterpret_f64' && Array.isArray(n[1]) && n[1][0] === 'local.get'))
    // i64.const whose bits decode to a CANONICAL interned string (STRING tag,
    // INTERN_BIT set, SSO/SLICE clear) — i.e. a static-literal operand.
    const internedLit = (n) => {
      // (i64.const 0x…) or its f64-carrier form (i64.reinterpret_f64 (f64.const nan:0x…))
      let tok = null
      if (Array.isArray(n) && n[0] === 'i64.const') tok = n[1]
      else if (Array.isArray(n) && n[0] === 'i64.reinterpret_f64' && Array.isArray(n[1])
        && n[1][0] === 'f64.const' && typeof n[1][1] === 'string' && n[1][1].startsWith('nan:'))
        tok = n[1][1].slice(4)
      if (tok == null) return false
      let v
      try { v = BigInt(tok) } catch { return false }
      if (v < 0n) v += 1n << 64n
      if (((v >> 47n) & 0xFn) !== 4n) return false
      return ((v >> 32n) & 0x6001n) === BigInt(STR_INTERN_BIT)
    }
    // Literal-vs-X inline: bit-eq → 1; X carrying the canonical aux pattern →
    // 0 (only a canonical string can content-equal a canonical literal, and
    // canonicals are deduped; every NON-string kind is ≠ a string under ===
    // as well, so answering 0 on the pattern is sound for ANY value). Slices,
    // SSO, fresh heap strings and NaN fall through to the call. This is what
    // makes `op === 'literal'` dispatch ladders cost ~3 ops per rung instead
    // of a helper call — the V8 interned-pointer-compare equivalent.
    const a = node[2], b = node[3]
    const lit = internedLit(b) ? b : internedLit(a) ? a : null
    const x = lit === b ? a : b
    if (lit && (cheap(x) || freshI64)) {
      node._eqFast = true
      // Cheap operands duplicate; anything else evaluates ONCE into an i64
      // scratch (tee in the first use), so the inline applies to un-hoisted
      // shapes like `node[0] === 'lit'` too.
      let first = x, reuse = x
      if (!cheap(x)) {
        const t = freshI64()
        first = ['local.tee', t, x]
        reuse = ['local.get', t]
        node[2] = lit === b ? reuse : lit
        node[3] = lit === b ? lit : reuse
      }
      const auxPat = ['i32.eq',
        ['i32.and', ['i32.wrap_i64', ['i64.shr_u', reuse, ['i64.const', 32]]], ['i32.const', 0x6001]],
        ['i32.const', STR_INTERN_BIT]]
      return ['if', ['result', 'i32'],
        ['i64.eq', first, lit],
        ['then', ['i32.const', 1]],
        ['else', ['if', ['result', 'i32'], auxPat,
          ['then', ['i32.const', 0]],
          ['else', node]]]]
    }
    if (node[1] === '$__eq' && cheap(a) && cheap(b)) {
      node._eqFast = true   // pre+post phases both run this walk — wrap once
      return ['if', ['result', 'i32'],
        ['i64.eq', a, b],
        ['then', ['i64.ne', a, ['i64.const', NAN_BITS]]],
        ['else', node]]
    }
  }

  // Inline-ptr-helpers: $__ptr_type / $__ptr_aux / $__is_nullish / $__is_null / $__is_truthy
  if (doInline && op === 'call' && node.length === 3 && typeof node[1] === 'string') {
    const fname = node[1]
    if (fname === '$__ptr_type') return ['i32.and',
      ['i32.wrap_i64', ['i64.shr_u', node[2], ['i64.const', LAYOUT.TAG_SHIFT]]],
      ['i32.const', LAYOUT.TAG_MASK]]
    if (fname === '$__ptr_aux') return ['i32.and',
      ['i32.wrap_i64', ['i64.shr_u', node[2], ['i64.const', LAYOUT.AUX_SHIFT]]],
      ['i32.const', LAYOUT.AUX_MASK]]
    if (fname === '$__is_null') return ['i64.eq', node[2], ['i64.const', NULL_BITS]]
    if (fname === '$__is_nullish' && Array.isArray(node[2]) && node[2][0] === 'i64.reinterpret_f64'
        && Array.isArray(node[2][1]) && node[2][1][0] === 'local.get') return ['i32.or',
      ['i64.eq', node[2], ['i64.const', NULL_BITS]],
      ['i64.eq', node[2], ['i64.const', UNDEF_BITS]]]
    // Expression-arg __is_truthy: evaluate once into an f64 scratch via tee —
    // the local.tee form below then expands inline (covers `(c = next()) || …`
    // and every condition the emitter didn't pre-hoist).
    if (fname === '$__is_truthy' && freshF64 && Array.isArray(node[2]) && node[2][0] === 'i64.reinterpret_f64'
        && Array.isArray(node[2][1])
        && node[2][1][0] !== 'local.get' && node[2][1][0] !== 'local.tee') {
      node[2] = ['i64.reinterpret_f64', ['local.tee', freshF64(), node[2][1]]]
    }
    if (fname === '$__is_truthy' && Array.isArray(node[2]) && node[2][0] === 'i64.reinterpret_f64'
        && Array.isArray(node[2][1]) && (node[2][1][0] === 'local.get' || node[2][1][0] === 'local.tee')) {
      // `local.tee $x SRC` evaluates SRC once, stores to $x, returns the value —
      // hot for `a || b` lowering (`__is_truthy(local.tee $t …)`). Keep the tee
      // as the first use (the `if` condition runs before then/else, and f64.eq's
      // left operand runs first), so $x is set before every `local.get` repeat.
      const ref = node[2][1]
      const lname = ref[1]
      const lget = ['local.get', lname]
      const first = ref[0] === 'local.tee' ? ref : lget
      const bits = ['i64.reinterpret_f64', lget]
      // Mirror $__is_truthy (module/core.js) exactly: FIVE falsy patterns —
      // canonical NaN, null, undefined, the empty SSO string, AND boolean
      // false. Omitting FALSE made inlined `x || y` treat false as truthy.
      return ['if', ['result', 'i32'],
        ['f64.eq', first, lget],
        ['then', ['f64.ne', lget, ['f64.const', 0]]],
        ['else', ['i32.and',
          ['i32.and',
            ['i32.and',
              ['i64.ne', bits, ['i64.const', NAN_BITS]],
              ['i64.ne', bits, ['i64.const', NULL_BITS]]],
            ['i32.and',
              ['i64.ne', bits, ['i64.const', UNDEF_BITS]],
              ['i64.ne', bits, ['i64.const', '0x7FFA400000000000']]]],
          ['i64.ne', bits, ['i64.const', FALSE_BITS]]]]]
    }
  }

  // Peephole: rebox/unbox round-trips
  if ((op === 'f64.convert_i32_s' || op === 'f64.convert_i32_u') && node.length === 2) {
    const a = node[1]
    if (Array.isArray(a) && a[0] === 'i32.const') {
      const n = typeof a[1] === 'number' ? a[1] : typeof a[1] === 'string' ? Number(a[1]) : NaN
      if (Number.isFinite(n)) return ['f64.const', op === 'f64.convert_i32_u' ? n >>> 0 : n]
    }
  }
  if (op === 'f64.mul' && node.length === 3) {
    const a = node[1], b = node[2]
    const isTwo = x => Array.isArray(x) && x[0] === 'f64.const' && x[1] === 2
    const isCheapF64 = x => Array.isArray(x) &&
      ((x[0] === 'local.get' && typeof x[1] === 'string') ||
       (x[0] === 'f64.const' && typeof x[1] === 'number'))
    if (isTwo(a) && isCheapF64(b)) return ['f64.add', b, b]
    if (isTwo(b) && isCheapF64(a)) return ['f64.add', a, a]
  }
  if (op === 'i32.trunc_sat_f64_s' && node.length === 2) {
    const a = node[1]
    if (Array.isArray(a) && a[0] === 'f64.convert_i32_s' && a.length === 2) return a[1]
  }
  if (op === 'i64.trunc_sat_f64_s' && node.length === 2) {
    const a = node[1]
    if (Array.isArray(a) && a[0] === 'f64.convert_i32_s' && a.length === 2) return ['i64.extend_i32_s', a[1]]
    if (Array.isArray(a) && a[0] === 'f64.convert_i32_u' && a.length === 2) return ['i64.extend_i32_u', a[1]]
  }
  // Rep-specific folds (NaN-box layout-aware reinterpret/wrap simplifications under
  // the nanbox preset). See abi/number/<rep>.js — each rep owns the rules that
  // depend on its own carrier layout. The universal `i32.wrap_i64 (i64.extend_i32_*)`
  // fold below stays here because it's pure WASM bit-pattern, ABI-agnostic.
  if (op === 'i64.reinterpret_f64' || op === 'f64.reinterpret_i64' || op === 'i32.wrap_i64') {
    const repFold = ctx.abi?.number?.peephole(node)
    if (repFold != null) return repFold
  }
  if (op === 'i32.wrap_i64' && node.length === 2) {
    const a = node[1]
    if (Array.isArray(a) && (a[0] === 'i64.extend_i32_u' || a[0] === 'i64.extend_i32_s') && a.length === 2)
      return a[1]
  }

  // Push ToInt32 through integer expressions and conditionals. The universal value model
  // computes integer `+`/`-` and `?:` in f64, then ToInt32-clamps — emitting
  //   (select (i32.wrap_i64 (i64.trunc_sat_f64_s [local.tee T] X)) FALLBACK COND)
  // whose three arms all compute ToInt32(X). When X is an integer-valued f64 expression,
  // ToInt32(X) == its i32 form (exact); and ToInt32 distributes through a conditional:
  //   ToInt32(if C A B) == if(result i32) C ToInt32(A) ToInt32(B).
  // Folding here drops the f64 round-trip AND turns int `s += a[i]` reductions and
  // `a[i] = cond ? … : …` conditional maps into pure i32 the vectorizer lifts (i32x4.add /
  // i32x4 bitselect). FALLBACK/COND (which recompute the same ToInt32 from T) are dropped.
  if (op === 'select' && node.length >= 4) {
    const v = node[1]
    if (Array.isArray(v) && v[0] === 'i32.wrap_i64' && Array.isArray(v[1]) && v[1][0] === 'i64.trunc_sat_f64_s' && v[1].length === 2) {
      let inner = v[1][1]
      if (Array.isArray(inner) && inner[0] === 'local.tee' && inner.length === 3) inner = inner[2]
      // ToInt32(integer-valued f64 expr) → its i32 form: covers (i32±i32)|0 sums AND the
      // conditional `?:` (toI32 distributes through `(if result f64)`, recursively).
      const i = toI32(inner)
      if (i) return i
      // Range fallback for the NON-integer-ring values toI32 rejects (`floor(scale·v)`,
      // `base + scale·v` — every grid/lattice/colour index): when the def chain — resolved
      // through single-def inlining temps via `get` — provably yields a finite i32-range value,
      // the +∞ guard is dead AND trunc_sat can't saturate, so the whole guarded select collapses
      // to one `i32.trunc_sat_f64_s`. SOUND: f64Range admits only pure nodes and proves
      // finiteness (kills the guard) + in-range (kills saturation), so the result is identical
      // ToInt32 on every value the program can produce. Drops the i64 round-trip + guard on all
      // runtimes (this is the post-inline twin of the emit-time fold at ir.js toI32).
      const rng = f64Range(inner, get)
      if (rng && rng.lo >= I32_MIN && rng.hi <= I32_MAX) return ['i32.trunc_sat_f64_s', inner]
    }
  }
  // (i32.or X 0) / (i32.or 0 X) → X — drops the redundant source-level `|0` clamp left
  // after the fold above, so the accumulator update is a bare i32.add the recognizer matches.
  if (op === 'i32.or' && node.length === 3) {
    const a = node[1], b = node[2]
    if (Array.isArray(b) && b[0] === 'i32.const' && b[1] === 0) return a
    if (Array.isArray(a) && a[0] === 'i32.const' && a[1] === 0) return b
  }

  // if→select for a value-producing f64 `if` with PURE arms: (if (result f64) COND (then A)
  // (else B)) → (select A B COND). This is the branchless `cmov` lowering LLVM/clang apply to
  // every `cond ? a : b` — it removes the conditional branch (and its misprediction cost on
  // data-unpredictable conditions) on the whole class of float sign/clamp/reflect ternaries.
  // The flagship: noise's gradient `(h & 1) === 0 ? x : -x` (8 per perlin × 5 octaves × 65k px).
  // SOUND: wasm `select` evaluates BOTH arms unconditionally, and `isPureIR` admits only
  // side-effect-free, non-trapping ops (no load/call/div/rem) — so eager evaluation is safe; it
  // is the exact predicate emit.js uses for the same fold at emit time, now applied post-watr
  // where the arms (e.g. `f64.neg (local.get $x)`) are clean after canon-DCE. Gated to NOT fire
  // when BOTH arms are i32-narrowable — those stay an `if` for the ToInt32-through-if fold +
  // the i32x4-bitselect conditional-map vectorizer (don't steal the integer path).
  if (op === 'if' && node.length === 5 && Array.isArray(node[1]) && node[1][0] === 'result' && node[1][1] === 'f64'
      && Array.isArray(node[3]) && node[3][0] === 'then' && node[3].length === 2
      && Array.isArray(node[4]) && node[4][0] === 'else' && node[4].length === 2) {
    const a = node[3][1], b = node[4][1], cond = node[2]
    // The COND must also be pure: `if` evaluates cond FIRST then one arm, but wasm `select`
    // evaluates its arms BEFORE the cond. A short-circuit lowering like `a || b` =
    // `(if (result f64) is_truthy(local.tee $t a) (then get $t)(else b))` hides a `tee` in the
    // cond that the then-arm reads — reordering it after the arms reads $t stale. Requiring
    // isPureIR(cond) excludes every tee/call/short-circuit cond while admitting the pure
    // comparison conds of real float ternaries (noise's `(h & 1) === 0`).
    if (isPureIR(a) && isPureIR(b) && isPureIR(cond) && !(toI32(a) && toI32(b))) return ['select', a, b, cond]
  }

  // f64.CMP(convert_i32 A, convert_i32 B) → i32.CMP(A, B). Comparing two i32 values is
  // identical whether done in exact f64 or in i32 (the converts are lossless and
  // order-preserving), so an integer comparison over typed-array loads (reads are f64)
  // drops its f64 round-trip. eq/ne are sign-agnostic; ordered compares need matching
  // signedness; an integer comparand constant works for the signed case. Both operands
  // are kept, so any address `local.tee` inside them survives. Prerequisite for i32
  // conditional-lane vectorization (the mask becomes an i32x4 compare).
  if (op === 'f64.eq' || op === 'f64.ne' || op === 'f64.lt' || op === 'f64.gt' || op === 'f64.le' || op === 'f64.ge') {
    const base = op.slice(4)
    const cv = (x) => Array.isArray(x) && (x[0] === 'f64.convert_i32_s' || x[0] === 'f64.convert_i32_u') && x.length === 2 ? x : null
    const intK = (x) => Array.isArray(x) && x[0] === 'f64.const' && Number.isInteger(x[1]) && x[1] >= -2147483648 && x[1] <= 2147483647 ? x[1] : null
    const a = node[1], b = node[2], ca = cv(a), cb = cv(b)
    if (ca && cb) {
      const sa = ca[0] === 'f64.convert_i32_s', sb = cb[0] === 'f64.convert_i32_s'
      if (base === 'eq' || base === 'ne') return ['i32.' + base, ca[1], cb[1]]
      if (sa === sb) return ['i32.' + base + (sa ? '_s' : '_u'), ca[1], cb[1]]
    } else if (ca && ca[0] === 'f64.convert_i32_s') {
      const k = intK(b)
      if (k != null) return base === 'eq' || base === 'ne' ? ['i32.' + base, ca[1], ['i32.const', k]] : ['i32.' + base + '_s', ca[1], ['i32.const', k]]
    } else if (cb && cb[0] === 'f64.convert_i32_s') {
      const k = intK(a)
      if (k != null) return base === 'eq' || base === 'ne' ? ['i32.' + base, ['i32.const', k], cb[1]] : ['i32.' + base + '_s', ['i32.const', k], cb[1]]
    }
  }

  // shl-distribute-over-add: (i32.shl (i32.add x (i32.const K)) (i32.const S))
  // → (i32.add (i32.shl x S) (i32.const K<<S)). Overflow-safe — both forms wrap
  // mod 2^32 identically. Unlocks memarg offset= folding for biquad-style
  // `arr[c+K0..KN]` reads where idx is precomputed but K is a small literal.
  if (op === 'i32.shl' && node.length === 3) {
    const a = node[1], b = node[2]
    // shl-shl-merge: (i32.shl (i32.shl x K1) K2) → (i32.shl x (K1+K2))
    // when K1+K2 < 32. Biquad: `sb = s<<2` then `__ab1 = state + (sb<<3)` ⇒
    // `s<<5` directly.
    if (Array.isArray(a) && a[0] === 'i32.shl' && a.length === 3 &&
        Array.isArray(b) && b[0] === 'i32.const' && typeof b[1] === 'number' &&
        Array.isArray(a[2]) && a[2][0] === 'i32.const' && typeof a[2][1] === 'number') {
      const sum = a[2][1] + b[1]
      if (sum >= 0 && sum < 32) return ['i32.shl', a[1], ['i32.const', sum]]
    }
    if (Array.isArray(a) && a[0] === 'i32.add' && a.length === 3 &&
        Array.isArray(b) && b[0] === 'i32.const' && typeof b[1] === 'number' && b[1] >= 0 && b[1] < 32) {
      const ka = a[1], kb = a[2]
      let inner, k
      if (Array.isArray(kb) && kb[0] === 'i32.const' && typeof kb[1] === 'number') { inner = ka; k = kb[1] }
      else if (Array.isArray(ka) && ka[0] === 'i32.const' && typeof ka[1] === 'number') { inner = kb; k = ka[1] }
      if (inner != null) {
        const shifted = (k * (1 << b[1])) | 0
        return ['i32.add', ['i32.shl', inner, b], ['i32.const', shifted]]
      }
    }
  }

  // assoc-lift-const-add: (i32.add A (i32.add B (i32.const K))) → (i32.add (i32.add A B) (i32.const K))
  // and mirror for left side. Lifts constant to top level so foldMemargOffsets
  // recognizes the canonical (i32.add base const) shape.
  if (op === 'i32.add' && node.length === 3) {
    const a = node[1], b = node[2]
    if (Array.isArray(b) && b[0] === 'i32.add' && b.length === 3) {
      const bb1 = b[1], bb2 = b[2]
      if (Array.isArray(bb2) && bb2[0] === 'i32.const') return ['i32.add', ['i32.add', a, bb1], bb2]
      if (Array.isArray(bb1) && bb1[0] === 'i32.const') return ['i32.add', ['i32.add', a, bb2], bb1]
    }
    if (Array.isArray(a) && a[0] === 'i32.add' && a.length === 3) {
      const aa1 = a[1], aa2 = a[2]
      if (Array.isArray(aa2) && aa2[0] === 'i32.const') return ['i32.add', ['i32.add', aa1, b], aa2]
      if (Array.isArray(aa1) && aa1[0] === 'i32.const') return ['i32.add', ['i32.add', aa2, b], aa1]
    }
  }

  // foldMemargOffsets: (load/store (i32.add base const) ...) → (load/store offset=N base ...)
  if (typeof op === 'string' && MEMOP.test(op)) {
    const m1 = node[1]
    if (!(typeof m1 === 'string' && (m1.startsWith('offset=') || m1.startsWith('align=')))) {
      const addr = m1
      if (Array.isArray(addr) && addr[0] === 'i32.add' && addr.length === 3) {
        const a = addr[1], b = addr[2]
        let base, offset
        if (Array.isArray(b) && b[0] === 'i32.const' && typeof b[1] === 'number' && b[1] >= 0 && b[1] < 0x100000000) { base = a; offset = b[1] }
        else if (Array.isArray(a) && a[0] === 'i32.const' && typeof a[1] === 'number' && a[1] >= 0 && a[1] < 0x100000000) { base = b; offset = a[1] }
        if (base != null) {
          node[1] = `offset=${offset}`
          node.splice(2, 0, base)
        }
      }
    }
  }
  return node
}

/**
 * Dead-code elimination: remove func decls not reachable from any entry point.
 * Roots: `(start $X)`, `(export "n" (func $X))`, `(elem … $X …)`, `(ref.func $X)`.
 * Iteratively adds funcs called from reachable ones. Mutates arrays in place.
 * Typical win: watr's optimize.js has orphan top-level consts (e.g. `hoist` = 26 KB).
 *
 * @param funcSections — array of { arr, isStartContainer? }. Each `arr` holds func IR nodes
 *                       (may be interleaved with other nodes like `(start $X)` for sec.start).
 * @param allModuleNodes — flat iterable of all module-level nodes for root discovery
 *                          (exports, elem, start directive are elsewhere than funcSections).
 * @param opts — optional `{ removeDead: bool }`. When `removeDead` is false, the
 *               reachability walk still runs (so `callCount` is populated for the
 *               funcidx sort downstream) but unreachable funcs are kept. Default true.
 */
export function treeshake(funcSections, allModuleNodes, opts) {
  const removeDead = !opts || opts.removeDead !== false
  const funcByName = new Map()
  const allFuncs = []
  for (const { arr } of funcSections)
    for (const n of arr)
      if (Array.isArray(n) && n[0] === 'func') {
        allFuncs.push(n)
        if (typeof n[1] === 'string') funcByName.set(n[1], n)
      }

  const reachable = new Set()
  const stack = []
  const addRoot = (name) => { if (funcByName.has(name) && !reachable.has(name)) { reachable.add(name); stack.push(name) } }

  // Named funcs with inline `(export "name")` are module-export roots.
  for (const [name, fn] of funcByName)
    for (let i = 2; i < fn.length; i++)
      if (Array.isArray(fn[i]) && fn[i][0] === 'export') { addRoot(name); break }

  // When user funcs are NOT being reclaimed (O0/O1 keep declared-but-uncalled ones), they
  // all survive — so they're roots for the *internal*-func reachability below. Otherwise an
  // unreachable user func that's kept would still call a `__helper`, yet that helper would be
  // pruned as unreached-from-exports, leaving a dangling `call $__helper`.
  if (!removeDead && opts && opts.userFuncs)
    for (const name of opts.userFuncs) addRoot(name)

  const findRoots = (node) => {
    if (!Array.isArray(node)) return
    if (node[0] === 'start' && typeof node[1] === 'string') addRoot(node[1])
    else if (node[0] === 'export' && Array.isArray(node[2]) && node[2][0] === 'func') addRoot(node[2][1])
    else if (node[0] === 'elem') for (const c of node) if (typeof c === 'string' && c.startsWith('$')) addRoot(c)
    for (const c of node) findRoots(c)
  }
  for (const n of allModuleNodes) findRoots(n)

  // Side-output: per-callee call counts over all reachable + anonymous funcs.
  // Caller uses this to sort funcs by hotness for low-LEB128-funcidx packing.
  // Counting here is free — we already visit every node in these funcs.
  const callCount = new Map()
  const CALL_OPS = new Set(['call', 'return_call', 'ref.func'])
  const visitCalls = (node) => {
    if (!Array.isArray(node)) return
    if (CALL_OPS.has(node[0]) && typeof node[1] === 'string') {
      addRoot(node[1])
      if (node[0] === 'call' || node[0] === 'return_call')
        callCount.set(node[1], (callCount.get(node[1]) || 0) + 1)
    }
    for (const c of node) visitCalls(c)
  }
  // Anonymous funcs can't be pruned (no name) — walk them to seed roots.
  for (const fn of allFuncs) if (typeof fn[1] !== 'string') visitCalls(fn)
  while (stack.length) visitCalls(funcByName.get(stack.pop()))

  // Compiler-internal funcs (stdlib helpers, allocator wrappers — everything not in the
  // user's own `ctx.func.list`) carry no source meaning, so an unreachable one is reclaimed
  // at EVERY opt level: it's never a live-coding aid, just over-production (e.g. `s + '!'`
  // pulls the alloc trio's `__alloc_hdr`, which string concat never calls, and a dead-branch
  // dep like `__str_len`). User funcs are reclaimed only when DCE is on, so O0/O1 keep a
  // declared-but-uncalled user function. Absent the set, fall back to gating everything.
  const userFuncs = opts && opts.userFuncs
  const isUserFunc = (name) => userFuncs ? userFuncs.has(name) : true
  let removed = 0
  if (removeDead || userFuncs) {
    for (const { arr } of funcSections) {
      for (let i = arr.length - 1; i >= 0; i--) {
        const n = arr[i]
        if (Array.isArray(n) && n[0] === 'func' && typeof n[1] === 'string' && !reachable.has(n[1]) &&
            (removeDead || !isUserFunc(n[1]))) {
          arr.splice(i, 1); removed++
        }
      }
    }
  }

  // Dead-global elimination: drop `(global $g …)` decls that nothing references
  // (a `global.get`/`global.set` in a remaining func, a kept global's init expr, a
  // data/elem offset, or an `(export … (global $g))`). Imported globals live in
  // `allModuleNodes`, not in `opts.globals`, so they're never touched. Fixpoint: a
  // kept global's init may reference another global.
  //
  // Compiler-internal globals (support state the user never wrote — e.g. core's
  // `__heap_start` or the math module's `rng_state`, declared eagerly but read
  // only by specific fast paths) are reclaimed at *every* level: leaving an
  // unreferenced one in the output is pure noise, never a live-coding aid. User
  // globals are reclaimed only when DCE is on, so O0/O1 still preserve declared-
  // but-unused user bindings. `userGlobals` (names sans `$`) draws the line; absent
  // it, fall back to the `$__` reserved-prefix heuristic.
  const userGlobals = opts && opts.userGlobals
  const isUserGlobal = (name) => userGlobals ? userGlobals.has(name.slice(1)) : !name.startsWith('$__')
  const globals = opts && Array.isArray(opts.globals) ? opts.globals : null
  if (globals) {
    const collectGlobalRefs = (node, refd) => {
      if (!Array.isArray(node)) return
      if ((node[0] === 'global.get' || node[0] === 'global.set') && typeof node[1] === 'string') refd.add(node[1])
      else if (node[0] === 'export' && Array.isArray(node[2]) && node[2][0] === 'global' && typeof node[2][1] === 'string') refd.add(node[2][1])
      for (const c of node) collectGlobalRefs(c, refd)
    }
    let changed = true
    while (changed) {
      changed = false
      const refd = new Set()
      for (const { arr } of funcSections) for (const n of arr) collectGlobalRefs(n, refd)
      for (const n of allModuleNodes) collectGlobalRefs(n, refd)
      for (const g of globals) collectGlobalRefs(g, refd)
      for (let i = globals.length - 1; i >= 0; i--) {
        const g = globals[i]
        if (!Array.isArray(g) || g[0] !== 'global' || typeof g[1] !== 'string' || refd.has(g[1])) continue
        // An inline `(export …)` on the decl pins it — it's part of the module's
        // JS-host surface (e.g. `__heap`), referenced from outside the wasm.
        if (g.some(c => Array.isArray(c) && c[0] === 'export')) continue
        if (removeDead || !isUserGlobal(g[1])) { globals.splice(i, 1); changed = true }
      }
    }
  }

  return { removed, callCount }
}

/**
 * Reorder non-param local decls by reference count (hot locals first).
 * WASM `local.get/set/tee` encode local idx as ULEB128 — 1 B for idx < 128, else 2 B.
 * Only the decl order changes; refs by name are unchanged and re-resolved by watr.
 * Params are fixed (their slot defines the call ABI) — only `(local …)` nodes move.
 */
/** `o.x` on a statically-unknown receiver — the megamorphic property read
 *  (shapes bench: 8 record variants at one site, every field load a ~50-op
 *  __dyn_get_any_t_h hash probe). The module's registered schema list is known
 *  and bounded once emission completes: switch on the box's aux schemaId via
 *  br_table into direct slot loads for every schema CARRYING the field — the
 *  static mirror of a polymorphic inline cache. Non-OBJECT tags, alien sids and
 *  schemas lacking the field all take the original call (default arm): a
 *  schema slot is authoritative for its own fields (dyn writes to schema keys
 *  mirror into the slot — buildObjectSchemaSetArm), so the direct load is
 *  bit-identical where it fires. Emit tagged the call (.dvProp) because
 *  schema.list is still growing while function bodies emit. */
export function devirtSchemaReads(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const schemas = ctx.schema?.list
  if (!schemas || !schemas.length || schemas.length > 24) return
  if (!ctx.core.includes.has('__ptr_type')) return
  let uid = null
  const newDecls = []
  // Receiver-stable sid cache: a devirt read whose receiver is a bare local that
  // is NEVER written in this function (param or single-init const — this pass
  // runs before watr inlining, so `measure(o)`-style helpers still have their
  // own frame) has a CONSTANT schemaId for the whole body: the sid lives in the
  // box's aux bits and a jz OBJECT's shape never changes (dyn writes go to the
  // sidecar, not the aux). Compute `sid | -1(non-OBJECT)` ONCE at body start;
  // every read on that receiver drops its per-read __ptr_type guard + aux
  // extract and br_tables on the cached local (-1 wraps u32-huge → default arm).
  const assigned = new Set()
  const scanAssigns = (n) => {
    if (!Array.isArray(n)) return
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') assigned.add(n[1])
    for (let k = 1; k < n.length; k++) scanAssigns(n[k])
  }
  scanAssigns(fn)
  // receiver expr → { name, bits } for a bare never-written local (f64 local
  // wrapped in reinterpret, or an already-i64 local), else null (keep the
  // per-read spill+guard path)
  const stableRecv = (r) => {
    if (Array.isArray(r) && r[0] === 'i64.reinterpret_f64' &&
      Array.isArray(r[1]) && r[1][0] === 'local.get' && typeof r[1][1] === 'string' &&
      !assigned.has(r[1][1])) return { name: r[1][1], bits: r }
    if (Array.isArray(r) && r[0] === 'local.get' && typeof r[1] === 'string' &&
      !assigned.has(r[1])) return { name: r[1], bits: r }
    return null
  }
  const sidCache = new Map()  // receiver local name → sid i32 local
  const sidInit = []
  const recvReads = new Map()  // receiver local name → tagged-read count (pre-scan)
  const recvAllObject = new Map() // every tagged read already proves OBJECT by static VAL
  const clone = (n) => Array.isArray(n) ? n.map(clone) : n
  // select(aux, -1, tag==OBJECT) — both operands pure, no branch
  const sidExprFor = (bits, objectKnown = false) => objectKnown
    ? ['i32.wrap_i64', ['i64.and',
        ['i64.shr_u', clone(bits), ['i64.const', LAYOUT.AUX_SHIFT]],
        ['i64.const', LAYOUT.AUX_MASK]]]
    : ['select',
        ['i32.wrap_i64', ['i64.and',
          ['i64.shr_u', clone(bits), ['i64.const', LAYOUT.AUX_SHIFT]],
          ['i64.const', LAYOUT.AUX_MASK]]],
        ['i32.const', -1],
        ['i32.eq',
          ['i32.wrap_i64', ['i64.and',
            ['i64.shr_u', clone(bits), ['i64.const', LAYOUT.TAG_SHIFT]],
            ['i64.const', LAYOUT.TAG_MASK]]],
          ['i32.const', PTR.OBJECT]]]
  // ≥2 reads on the receiver: amortize into an entry-hoisted local. A single
  // read inlines the select at its site instead — an eager entry compute would
  // tax every call of a function whose lone read sits on a cold path (the
  // self-host kernel's shape; measured 0.9% compile-time regression).
  const sidRead = (stable) => {
    const objectKnown = recvAllObject.get(stable.name) === true
    if ((recvReads.get(stable.name) || 0) < 2) return sidExprFor(stable.bits, objectKnown)
    let sidT = sidCache.get(stable.name)
    if (!sidT) {
      sidT = `$__dsrs${uid++}`
      newDecls.push(['local', sidT, 'i32'])
      sidInit.push(['local.set', sidT, sidExprFor(stable.bits, objectKnown)])
      sidCache.set(stable.name, sidT)
    }
    return ['local.get', sidT]
  }
  // Evaluation-order safety class shared by the rewrite and the duplicate-read
  // memo: arms/reuse evaluate ONLY the receiver (or nothing); the original call
  // also evaluates key/tag/hash operands. All must be pure for the paths to be
  // observationally identical (they are in practice: local reads + constants —
  // the emitDynGetAnyTyped shape). `call $__ptr_type` is a pure bit extract.
  const PURE_I64 = new Set(['i64.const', 'i64.reinterpret_f64', 'f64.reinterpret_i64',
    'i64.and', 'i64.or', 'i64.xor', 'i64.shr_u', 'i64.shl', 'i64.eq', 'i64.ne', 'i64.eqz',
    'i64.extend_i32_u', 'i64.extend_i32_s',
    'i32.const', 'i32.wrap_i64', 'i32.and', 'i32.or', 'i32.xor', 'i32.shr_u', 'i32.shl',
    'i32.add', 'i32.sub', 'i32.eq', 'i32.ne', 'i32.eqz'])
  const pureOp = (n) => !Array.isArray(n) ? true
    : n[0] === 'call' && n[1] === '$__ptr_type' ? n.slice(2).every(pureOp)
    : PURE_I64.has(n[0]) ? n.slice(1).every(pureOp)
    : isPureIR(n)
  const rewrite = (parent, i) => {
    const node = parent[i]
    const prop = node.dvProp
    const withProp = []
    for (let sid = 0; sid < schemas.length; sid++) {
      const slot = schemas[sid].indexOf(prop)
      if (slot >= 0) withProp.push([sid, slot])
    }
    if (!withProp.length) return
    // `local.tee` operands (foldSetToTee folds shared tag/CSE
    // locals into the FIRST read's call, possibly nested) are hoisted to
    // standalone sets before the dispatch, innermost first — the original call
    // evaluated them unconditionally, so unconditional sets are observationally
    // identical, later readers of those locals still see them, and the arms
    // (which skip the default call) stay sound.
    const teeHoists = []
    const extractTees = (n) => {
      if (!Array.isArray(n)) return n
      if (n[0] === 'local.tee' && typeof n[1] === 'string') {
        teeHoists.push(['local.set', n[1], extractTees(n[2])])
        return ['local.get', n[1]]
      }
      return n.map((c, k) => k === 0 ? c : extractTees(c))
    }
    const operands = node.slice(2).map(extractTees)
    for (const op of operands) if (!pureOp(op)) { if (DBG_DSR) console.error('[dsr-bail]', prop, 'impure operand:', JSON.stringify(op).slice(0, 200)); return }
    for (const h of teeHoists) if (!pureOp(h[2])) { if (DBG_DSR) console.error('[dsr-bail]', prop, 'impure tee:', JSON.stringify(h).slice(0, 200)); return }
    // the dispatch's generic arm — the original call over the tee-free operands
    const genericCall = [node[0], node[1], ...operands]
    if (uid === null) uid = nextLocalId(fn, '$__dsr')
    const stable = stableRecv(genericCall[2])
    const id = uid++
    const rT = stable ? null : `$__dsr${id}r`
    if (rT) newDecls.push(['local', rT, 'i64'])
    // receiver bits for arms/default: the stable local read inline (fresh clone
    // per use — IR nodes must not alias), or the spill
    const recvBits = () => stable ? clone(stable.bits) : ['local.get', rT]
    const out = `$__dsro${id}`, dflt = `$__dsrd${id}`
    const lo = withProp[0][0], hi = withProp[withProp.length - 1][0]
    const bySid = new Map(withProp)
    // Discriminant-field collapse: when EVERY compile-time schema has the prop
    // at the SAME slot (the canonical tag-field pattern — `.k`/`.type`/`.kind`
    // as first key of every variant literal), a known-schema OBJECT resolves to
    // that slot with no dispatch at all: `(u32)sid < count ? load : generic`.
    // The unsigned compare routes BOTH the -1 non-OBJECT sentinel and any
    // runtime-registered alien sid (__jp_obj / host-marshaled shapes mint sids
    // past the compile-time list) to the generic arm.
    if (stable && withProp.length === schemas.length &&
      withProp.every(([, slot]) => slot === withProp[0][1])) {
      const slot = withProp[0][1]
      const dispatch = ['if', ['result', 'i64'],
        ['i32.lt_u', sidRead(stable), ['i32.const', schemas.length]],
        ['then', ['i64.load',
          ['i32.add', ['i32.wrap_i64', recvBits()], ['i32.const', slot * 8]]]],
        ['else', genericCall]]
      parent[i] = teeHoists.length
        ? ['block', out, ['result', 'i64'], ...teeHoists, dispatch]
        : dispatch
      return
    }
    const labels = Array.from({ length: hi - lo + 1 }, (_, k) => bySid.has(lo + k) ? `$__dsr${id}_${lo + k}` : dflt)
    // arms in sid order: each closes its block, loads its slot, brs out; the
    // innermost block (first arm's label) carries the br_table — selecting on
    // the hoisted sid cache when the receiver is stable (its -1 non-OBJECT
    // sentinel wraps u32-huge → default arm, so no separate tag guard), else
    // on a per-read aux extract behind a per-read tag guard.
    const armSids = withProp.map(([sid]) => sid)
    let inner = ['br_table', ...labels, dflt,
      ['i32.sub',
        stable ? sidRead(stable)
          : ['i32.wrap_i64', ['i64.and',
            ['i64.shr_u', ['local.get', rT], ['i64.const', LAYOUT.AUX_SHIFT]],
            ['i64.const', LAYOUT.AUX_MASK]]],
        ['i32.const', lo]]]
    inner = ['block', `$__dsr${id}_${armSids[0]}`,
      ...(stable ? [] : [['br_if', dflt, ['i32.ne',
        ['call', '$__ptr_type', ['local.get', rT]],
        ['i32.const', PTR.OBJECT]]]]),
      inner]
    for (let k = 0; k < armSids.length; k++) {
      const sid = armSids[k], slot = bySid.get(sid)
      const arm = ['br', out, ['i64.load',
        ['i32.add', ['i32.wrap_i64', recvBits()], ['i32.const', slot * 8]]]]
      const nextLabel = k + 1 < armSids.length ? `$__dsr${id}_${armSids[k + 1]}` : dflt
      inner = ['block', nextLabel, inner, arm]
    }
    const dfltCall = [...genericCall]
    if (!stable) dfltCall[2] = ['local.get', rT]
    parent[i] = ['block', out, ['result', 'i64'],
      ...teeHoists,
      ...(stable ? [] : [['local.set', rT, genericCall[2]]]),
      inner,
      dfltCall]
  }
  let seen = 0
  // pre-scan: count tagged reads per stable receiver (sidRead's entry-hoist
  // choice) AND per (receiver, prop) key — only keys read ≥2× tee their result
  // for the duplicate-read memo below (a lone read must not pay a local write)
  const keyReads = new Map()
  const memoKey = (c) => {
    const st = stableRecv(c[2])
    return st && c.dvProp != null ? `${st.name} ${c.dvProp}` : null
  }
  const countScan = (n) => {
    if (!Array.isArray(n)) return
    if (n[0] === 'call' && n.dvProp) {
      const st = stableRecv(n[2])
      if (st) {
        recvReads.set(st.name, (recvReads.get(st.name) || 0) + 1)
        recvAllObject.set(st.name, (recvAllObject.get(st.name) ?? true) && n.dvObject === true)
        const k = `${st.name} ${n.dvProp}`
        keyReads.set(k, (keyReads.get(k) || 0) + 1)
      }
    }
    for (let i = 1; i < n.length; i++) countScan(n[i])
  }
  countScan(fn)
  // Duplicate-read elimination riding the rewrite walk: a SECOND tagged read
  // of the SAME (stable receiver, prop) in the same straight-line region
  // reuses the first read's tee'd i64 — the whole sid-dispatch + slot load
  // drops (measure()'s `imul(o.r, imul(o.r, 3))` pays one read). Soundness:
  // the receiver is a never-written local and a jz OBJECT's shape never
  // changes, so only an intervening WRITE could change the value — any
  // non-readonly call, store, global.set or memory.grow clears the memo.
  // Conditional regions (if arms, labeled blocks a br may skip) keep entries
  // born inside them local: snapshot on entry, restore on exit (outer entries
  // stay usable inside — the first read dominates). A LOOP whose body clobbers
  // clears up front: an entry born before iteration 1's clobber must not serve
  // iteration 2. Replacing a read drops its operand evaluation — legal for
  // exactly the pure class rewrite() enforces; tee'd operands refuse (their
  // set would vanish).
  const READONLY_CALL = /^\$(__dyn_get|__ptr_type$|math\.)/
  const isClobberNode = (x) => {
    const op = x[0]
    if (op === 'call' && !x.dvProp && typeof x[1] === 'string' && !READONLY_CALL.test(x[1])) return true
    return typeof op === 'string' && (op.includes('.store') || op === 'global.set' || op === 'memory.grow')
  }
  const hasClobber = (x) => {
    if (!Array.isArray(x)) return false
    if (isClobberNode(x)) return true
    for (let i = 1; i < x.length; i++) if (hasClobber(x[i])) return true
    return false
  }
  const noTee = (x) => !Array.isArray(x) ? true
    : x[0] === 'local.tee' ? false
    : x.slice(1).every(noTee)
  const memo = new Map()
  let clobbers = 0
  const scoped = (walkBody) => {
    const snap = new Map(memo), pre = clobbers
    walkBody()
    memo.clear()
    if (clobbers === pre) for (const [k, v] of snap) memo.set(k, v)
  }
  const visitChild = (n, i) => {
    const c = n[i]
    if (!Array.isArray(c)) return
    walkDSR(c)
    if (c[0] === 'call' && c.dvProp) {
      seen++
      const key = memoKey(c)
      const hit = key && memo.get(key)
      if (hit && c.slice(2).every(o => pureOp(o) && noTee(o))) { n[i] = ['local.get', hit]; return }
      rewrite(n, i)
      if (key && (keyReads.get(key) || 0) >= 2 && Array.isArray(n[i])) {
        if (uid === null) uid = nextLocalId(fn, '$__dsr')
        const L = `$__dsrm${uid++}`
        newDecls.push(['local', L, 'i64'])
        n[i] = ['local.tee', L, n[i]]
        memo.set(key, L)
      }
      return
    }
    if (isClobberNode(c)) { memo.clear(); clobbers++ }
  }
  const walkDSR = (n) => {
    if (!Array.isArray(n)) return
    if (n[0] === 'if') {
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        if (!Array.isArray(c)) continue
        if (c[0] === 'then' || c[0] === 'else') scoped(() => walkDSR(c))
        else visitChild(n, i)
      }
      return
    }
    if (n[0] === 'loop') {
      if (hasClobber(n)) { memo.clear(); clobbers++ }
      scoped(() => { for (let i = 1; i < n.length; i++) visitChild(n, i) })
      return
    }
    if (n[0] === 'block' && typeof n[1] === 'string') {
      scoped(() => { for (let i = 1; i < n.length; i++) visitChild(n, i) })
      return
    }
    for (let i = 1; i < n.length; i++) visitChild(n, i)
  }
  walkDSR(fn)
  if (DBG_DSR && String(fn[1]).includes('measure')) console.error('[dsr]', fn[1], 'schemas:', schemas.length, 'tagged seen:', seen)
  if (newDecls.length) {
    let at = typeof fn[1] === 'string' ? 2 : 1
    while (at < fn.length && Array.isArray(fn[at]) &&
      (fn[at][0] === 'export' || fn[at][0] === 'type' || fn[at][0] === 'param' || fn[at][0] === 'result' || fn[at][0] === 'local')) at++
    // sid-cache computations go right after the decls, before the first body
    // statement — stable receivers are never-written names (params), so their
    // value at body start equals their value at every read
    fn.splice(at, 0, ...newDecls, ...sidInit)
  }
}

/** Fold the base/len ceremony of `constArr[i]` element reads whose receiver is a
 *  STATIC array literal bound to a const global (module/array.js tags `.saArr` /
 *  `.saBits` on the read IR; the decl registers ctx.scope.staticArrs). The
 *  data-segment offset and length are compile-time constants, so the per-read
 *  `__ptr_offset` call + header len load collapse to literals — decisive in
 *  loops containing calls, where a callee may write memory and watr's LICM must
 *  keep the loads in place (the devirt'd operator-table dispatch loop is the
 *  canonical victim). Facts gate: any indexed write, resizing method call, or
 *  bare value use of the name anywhere in the program (ctx.types.arrResized /
 *  nameEscapes, collectProgramFacts) keeps the generic form — an alias or a
 *  grow could relocate the payload (header forwarding) or change len, and a
 *  folded base would read stale memory. */
export function foldStaticConstArrayReads(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const sa = ctx.scope.staticArrs
  if (!sa || !sa.size) return
  // Facts must EXIST to fold — an absent fact set means the program was never
  // walked for resize/escape, not that the name is safe.
  const resized = ctx.types.arrResized, escapes = ctx.types.nameEscapes
  if (!resized || !escapes) return
  const rewrite = (node) => {
    const st = sa.get(node.saArr)
    if (!st) return
    // A bits-form tag (receiver folded to a const box at emit) must match the decl's
    // recorded bits; a name-form tag (receiver read `global.get $name` directly) IS
    // the identity — global names are unique.
    if (node.saBits != null && st.bits !== node.saBits) return
    if (resized.has(node.saArr) || escapes.has(node.saArr)) return
    // The base derives from the GLOBAL, not a baked constant: assemble's
    // static-prefix-strip rebases every static pointer AFTER this pass runs, so a
    // baked absolute offset goes stale (caught by the module-const table tests).
    // `global.get` is the strip-safe anchor — the global's init is rebased in
    // place, jz never folds immutable global reads, and watr (which runs after
    // the strip) propagates the rebased init into a final constant memarg. The
    // win stands regardless: the `__ptr_offset` CALL (whose forwarding follow the
    // never-resized proof makes dead) and the len header load both drop.
    const baseIR = () => ['i32.wrap_i64', ['i64.reinterpret_f64', ['global.get', `$${node.saArr}`]]]
    const isBaseIR = (n) => Array.isArray(n) && n[0] === 'i32.wrap_i64' &&
      Array.isArray(n[1]) && n[1][0] === 'i64.reinterpret_f64' &&
      Array.isArray(n[1][1]) && n[1][1][0] === 'global.get' && n[1][1][1] === `$${node.saArr}`
    // 1) base tee → global-derived base: (local.tee $b (call $__ptr_offset …)) → baseIR
    let baseLocal = null
    const subBase = (n) => {
      if (!Array.isArray(n)) return
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        if (!Array.isArray(c)) continue
        if (c[0] === 'local.tee' && Array.isArray(c[2]) && c[2][0] === 'call' && c[2][1] === '$__ptr_offset') {
          baseLocal = c[1]
          n[i] = baseIR()
          continue
        }
        subBase(c)
      }
    }
    subBase(node)
    if (!baseLocal) return
    // 2) len header load over the folded base → literal len (position-independent);
    //    remaining base reads → box-derived base
    const subLen = (n) => {
      if (!Array.isArray(n)) return
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        if (!Array.isArray(c)) continue
        if (c[0] === 'i32.load' && Array.isArray(c[1]) && c[1][0] === 'i32.sub' &&
            isBaseIR(c[1][1]) &&
            Array.isArray(c[1][2]) && c[1][2][0] === 'i32.const' && +c[1][2][1] === 8) {
          n[i] = ['i32.const', st.len]
          continue
        }
        if (c[0] === 'local.get' && c[1] === baseLocal) { n[i] = baseIR(); continue }
        subLen(c)
      }
    }
    subLen(node)
  }
  const walk = (n) => {
    if (!Array.isArray(n)) return
    if (n.saArr != null) rewrite(n)
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  walk(fn)
}

/** `constOps[idx](args)` — data-driven dispatch through a module-const array of
 *  capture-free arrows (operator tables, strategy maps, bytecode handlers). The
 *  generic lowering pays call_indirect's bounds + signature checks per call and
 *  blocks V8 from inlining the tiny bodies. Emit tagged the call_indirect
 *  (`.dvArr` = receiver name); this pass switches on the closure box's OWN
 *  funcIdx (aux bits) via br_table into direct uniform-ABI calls — an AOT
 *  polymorphic inline cache. The untouched original call_indirect is the
 *  default arm, so any runtime divergence (an element overwritten through an
 *  alias, an out-of-range index yielding the UNDEF box) takes the generic path:
 *  semantics are bit-identical regardless of the candidate set. */
export function devirtConstFnArrayCalls(fn, cfg) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const cfa = ctx.scope.constFnArrays
  if (!cfa || !cfa.size) return
  const armInline = !cfg || cfg.inlineDevirtArms !== false
  let uid = null
  const newDecls = []
  // ONE inline-temp counter for the whole function: two dispatch SITES can share
  // a `uid` (a const-folded receiver spills nothing, leaving uid untouched), so a
  // per-site counter would mint the same `$__dvi{uid}_0` twice — duplicate local.
  const inlRef = { next: 0 }
  const rewrite = (parent, i) => {
    const node = parent[i]
    const cands = cfa.get(node.dvArr)
    if (!cands) return
    // shape (module/function.js closure.call inline path):
    // [call_indirect, [type,$ftN], envExpr, [i32.const,n], ...W slots, idxExtract]
    if (!Array.isArray(node[1]) || node[1][0] !== 'type') return
    const env = node[2], argc = node[3]
    if (!Array.isArray(argc) || argc[0] !== 'i32.const') return
    const idxExtract = node[node.length - 1]
    const slots = node.slice(4, node.length - 1)
    const lo = Math.min(...cands.map(c => c.idx)), hi = Math.max(...cands.map(c => c.idx))
    if (hi - lo > 32) return
    if (uid === null) uid = nextLocalId(fn, '$__dv')
    // Spill env + every non-constant slot once; both the arms and the default read the spills.
    // An arg that is itself `f64.convert_i32_s(E)` spills the i32 E and re-materializes the
    // convert at each use — the convert then sits SYNTACTICALLY at every consumer, so the
    // inlined arms' `trunc∘convert` round-trips and `ne(convert, impossible-const)` guards
    // fold away (watr identities). Behind an f64 spill local the value-flow is invisible.
    const spills = []
    const spill = (expr, tag) => {
      if (Array.isArray(expr) && (expr[0] === 'f64.const' || expr[0] === 'local.get')) return expr
      if (Array.isArray(expr) && expr[0] === 'f64.convert_i32_s' && Array.isArray(expr[1])) {
        const name = `$__dv${uid++}${tag}`
        newDecls.push(['local', name, 'i32'])
        spills.push(['local.set', name, expr[1]])
        return ['f64.convert_i32_s', ['local.get', name]]
      }
      const name = `$__dv${uid++}${tag}`
      newDecls.push(['local', name, 'f64'])
      spills.push(['local.set', name, expr])
      return ['local.get', name]
    }
    const envG = spill(env, 'e')
    const slotGs = slots.map((sl, k) => spill(sl, 'a' + k))
    const out = `$__dvo${uid}`, dflt = `$__dvd${uid}`
    const byOff = new Map(cands.map(c => [c.idx - lo, c]))
    const labels = Array.from({ length: hi - lo + 1 }, (_, k) => byOff.has(k) ? `$__dv${uid}_${k}` : dflt)
    // idxExtract reads the env box — after spilling, re-point its env reference:
    // the extraction shape is wrap(and(shr(reinterpret(ENV))...)); rebuild it on the spill.
    const extract = ['i32.sub',
      ['i32.wrap_i64', ['i64.and',
        ['i64.shr_u', ['i64.reinterpret_f64', envG], ['i64.const', LAYOUT.AUX_SHIFT]],
        ['i64.const', LAYOUT.AUX_MASK]]],
      ['i32.const', lo]]
    let inner = ['br_table', ...labels, dflt, extract]
    const armOffsets = [...byOff.keys()].sort((a, b) => a - b)
    inner = ['block', labels[armOffsets[0]], inner]
    // Tiny straight-line body → inline it straight into the arm: the uniform-ABI
    // call (env + argc + W padded f64 slots) vanishes and the arm becomes the
    // operator body itself — the AOT equivalent of the switch a JIT synthesizes
    // for a hot polymorphic table. The UNFILTERED candidate map: an arm executes
    // exactly when the original call did, so a straight-line body with a side
    // effect (closure0's cold string-concat branch inside a polymorphic `+`) is
    // safe to substitute verbatim — inlinePureCallExpr itself enforces the
    // straight-line shape and read-only params, and returns null for anything it
    // can't prove (the call stays). Purity mattered only for value-motion uses.
    const bodies = ctx.scope.dvArmFns
    const nodeCount = (n) => !Array.isArray(n) ? 0 : 1 + n.reduce((a, c, k) => a + (k > 0 ? nodeCount(c) : 0), 0)
    // i32 block-narrow: when the receiver is a facts-qualified STATIC table (the
    // same never-resized/never-aliased gate as foldStaticConstArrayReads — its
    // elements are exactly the original arrows, forever) and EVERY candidate body
    // exits through `f64.convert_i32_s` (a ToInt32'd result), the dispatch value
    // is int-valued on every path: arms br the raw i32 (their convert stripped),
    // call-formed arms and the generic call_indirect wrap in i32.trunc_sat_f64_s
    // (exact on int-valued f64), and ONE convert re-boxes the block. The
    // loop-carried receiver of `x = ops[i](x, k)` then has a syntactic-convert
    // def — watr's narrowLocals retypes it and the x-side ToInt32 guard dies the
    // same way the k-side did (watr intguard).
    const convertTopped = (fnNode) => {
      if (!Array.isArray(fnNode)) return false
      const exits = []
      let last = null
      const walkR = (n) => {
        if (!Array.isArray(n)) return
        if (n[0] === 'return') { exits.push(n.length === 2 ? n[1] : null); return }
        for (let k = 1; k < n.length; k++) walkR(n[k])
      }
      for (let k = 2; k < fnNode.length; k++) {
        const s = fnNode[k]
        if (!Array.isArray(s) || s[0] === 'param' || s[0] === 'result' || s[0] === 'local' || s[0] === 'export' || s[0] === 'type') continue
        last = s
        walkR(s)
      }
      if (last && last[0] !== 'return') exits.push(last)
      return exits.length > 0 && exits.every(e => Array.isArray(e) && e[0] === 'f64.convert_i32_s')
    }
    const sa = ctx.scope.staticArrs?.get(node.dvArr)
    const fns = ctx.scope.dvArmFns
    const narrow = !!(sa && fns && ctx.types.arrResized && ctx.types.nameEscapes &&
      !ctx.types.arrResized.has(node.dvArr) && !ctx.types.nameEscapes.has(node.dvArr) &&
      cands.every(c => convertTopped(fns.get(`$${c.name}`))))
    const intOf = (v) => {
      if (Array.isArray(v) && v[0] === 'f64.convert_i32_s') return v[1]
      if (Array.isArray(v) && v[0] === 'block' && Array.isArray(v[1]) && v[1][0] === 'result' && v[1][1] === 'f64') {
        const vl = v[v.length - 1]
        if (Array.isArray(vl) && vl[0] === 'f64.convert_i32_s')
          return ['block', ['result', 'i32'], ...v.slice(2, -1), vl[1]]
      }
      return ['i32.trunc_sat_f64_s', v]
    }
    for (let k = 0; k < armOffsets.length; k++) {
      const cand = byOff.get(armOffsets[k])
      const call = ['call', `$${cand.name}`, envG, argc, ...slotGs]
      let armVal = null
      const bodyFn = armInline ? bodies?.get(`$${cand.name}`) : null
      if (bodyFn && nodeCount(bodyFn) <= 96)
        armVal = inlinePureCallExpr(call, bodies, inlRef, newDecls, 'f64', '$__dvi')
      const armExpr = armVal ?? call
      const arm = ['br', out, narrow ? intOf(armExpr) : armExpr]
      const nextLabel = k + 1 < armOffsets.length ? labels[armOffsets[k + 1]] : dflt
      inner = ['block', nextLabel, inner, arm]
    }
    // default: the original call_indirect on the spilled operands
    const generic = ['call_indirect', node[1], envG, argc, ...slotGs, node[node.length - 1]]
    parent[i] = narrow
      ? ['f64.convert_i32_s', ['block', out, ['result', 'i32'], ...spills, inner, ['i32.trunc_sat_f64_s', generic]]]
      : ['block', out, ['result', 'f64'], ...spills, inner, generic]
  }
  const walkDV = (n) => {
    if (!Array.isArray(n)) return
    for (let i = 1; i < n.length; i++) {
      const c = n[i]
      if (!Array.isArray(c)) continue
      if (c[0] === 'call_indirect' && c.dvArr) { walkDV(c); rewrite(n, i); continue }
      walkDV(c)
    }
  }
  walkDV(fn)
  if (newDecls.length) {
    let at = typeof fn[1] === 'string' ? 2 : 1
    while (at < fn.length && Array.isArray(fn[at]) &&
      (fn[at][0] === 'export' || fn[at][0] === 'type' || fn[at][0] === 'param' || fn[at][0] === 'result' || fn[at][0] === 'local')) at++
    fn.splice(at, 0, ...newDecls)
  }
}

export function sortLocalsByUse(fn, precomputedCounts) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const localIdxs = []
  let totalDecls = 0
  let i
  for (i = 2; i < fn.length; i++) {
    const c = fn[i]
    if (!Array.isArray(c)) continue
    if (c[0] === 'param' || c[0] === 'result') { totalDecls++; continue }
    if (c[0] === 'local') { localIdxs.push(i); totalDecls++; continue }
    break
  }
  if (localIdxs.length < 2) return
  if (totalDecls <= 128) {
    // Every index fits 1-byte LEB, so ordering is free for the body — group
    // same-type runs so the binary locals vector squashes to one (n, type)
    // entry per type instead of a run per interleaving (wasm-opt emits two
    // groups here; watr's encoder merges only CONSECUTIVE same-type runs).
    // Stable within a type: original declaration order.
    const TYPE_ORDER = { i32: 0, i64: 1, f32: 2, f64: 3, v128: 4 }
    const keyed = localIdxs.map((i, k) => [fn[i], k])
    keyed.sort((a, b) => ((TYPE_ORDER[a[0][a[0].length - 1]] ?? 9) - (TYPE_ORDER[b[0][b[0].length - 1]] ?? 9)) || (a[1] - b[1]))
    localIdxs.forEach((i, k) => { fn[i] = keyed[k][0] })
    return
  }
  let counts = precomputedCounts
  if (!counts) {
    counts = new Map()
    const visit = (n) => {
      if (!Array.isArray(n)) return
      if ((n[0] === 'local.get' || n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string')
        counts.set(n[1], (counts.get(n[1]) || 0) + 1)
      for (const c of n) visit(c)
    }
    for (let i = totalDecls + 2; i < fn.length; i++) visit(fn[i])
  }
  const locals = localIdxs.map(i => fn[i])
  const TYPE_ORDER = { i32: 0, i64: 1, f32: 2, f64: 3, v128: 4 }
  // Hot-first for 1-byte LEB coverage; equal counts tie-break by type so the
  // locals vector still squashes into runs where frequency permits.
  locals.sort((a, b) => ((counts.get(b[1]) || 0) - (counts.get(a[1]) || 0)) ||
    ((TYPE_ORDER[a[a.length - 1]] ?? 9) - (TYPE_ORDER[b[b.length - 1]] ?? 9)))
  localIdxs.forEach((i, k) => { fn[i] = locals[k] })
}

/**
 * Module-level arena rewind: transitive escape analysis.
 *
 * Per-function `applyArenaRewind` in compile.js is limited to a static whitelist
 * of internal helpers. This pass generalizes by building a call graph and
 * propagating "arena-safe callee" status via fixed-point iteration.
 *
 * A function is an arena-safe callee if:
 *   - no global.set, call_indirect, call_ref in body
 *   - all user-function calls are to other arena-safe callees
 *
 * A function is arena-rewindable (gets heap save/restore injected) if:
 *   - single scalar result (f64 or i32)
 *   - contains allocation ($__alloc / $__alloc_hdr)
 *   - no global.set, return_call, call_indirect, call_ref
 *   - all user-function calls are to arena-safe callees
 *   - does NOT return a pointer (checked via ptrTypes map from compile.js)
 *
 * Unlike the per-function pass, this does NOT require 0 params.
 *
 * @param {Array[]} fns - Array of func IR nodes (sec.funcs + sec.stdlib + sec.start)
 * @param {boolean} sharedMemory - Whether memory is shared (affects heap get/set IR)
 * @param {Map<string, {ptrKind: *}|null>} [ptrTypes] - Map from func name to ptrKind info.
 *   Functions with ptrKind != null return pointers and cannot be rewound.
 *   If omitted, no pointer-return check is done (conservative: fewer functions rewound).
 */
export function arenaRewindModule(fns) {
  const BUILTIN_SAFE = new Set([
    '$__alloc', '$__alloc_hdr', '$__alloc_hdr_n', '$__mkptr',
    '$__ptr_offset', '$__ptr_type', '$__ptr_aux',
    '$__len', '$__cap', '$__typed_shift', '$__typed_data',
  ])

  // Phase 1: collect per-function metadata
  const fnMap = new Map()
  for (const fn of fns) {
    if (!Array.isArray(fn) || fn[0] !== 'func') continue
    const name = fn[1]
    if (typeof name !== 'string') continue

    let results = [], hasGlobalSet = false, hasReturnCall = false
    let hasCallIndirect = false, hasCallRef = false, hasAlloc = false
    const calls = new Set()
    const bodyStart = findBodyStart(fn)

    for (let i = 2; i < fn.length; i++) {
      const c = fn[i]
      if (!Array.isArray(c)) continue
      if (c[0] === 'result') { results.push(c[1] || c[2]); continue }
      if (i >= bodyStart) break
    }

    const scan = node => {
      if (!Array.isArray(node)) return
      const op = node[0]
      if (op === 'global.set') hasGlobalSet = true
      else if (op === 'return_call') hasReturnCall = true
      else if (op === 'call_indirect') hasCallIndirect = true
      else if (op === 'call_ref') hasCallRef = true
      else if (op === 'call') {
        const callee = node[1]
        if (callee === '$__alloc' || callee === '$__alloc_hdr' || callee === '$__alloc_hdr_n') hasAlloc = true
        if (typeof callee === 'string' && !BUILTIN_SAFE.has(callee)) calls.add(callee)
      }
      for (let i = 1; i < node.length; i++) scan(node[i])
    }
    for (let i = bodyStart; i < fn.length; i++) scan(fn[i])

    fnMap.set(name, {
      fn, results,
      hasGlobalSet, hasReturnCall, hasCallIndirect, hasCallRef, hasAlloc,
      calls: [...calls],
    })
  }

  // Phase 2: fixed-point transitive safety analysis
  const safeCallees = new Set(BUILTIN_SAFE)
  let changed = true
  while (changed) {
    changed = false
    for (const [name, info] of fnMap) {
      if (safeCallees.has(name)) continue
      if (info.hasGlobalSet || info.hasCallIndirect || info.hasCallRef) continue
      if (info.calls.every(c => safeCallees.has(c) || !fnMap.has(c))) {
        safeCallees.add(name)
        changed = true
      }
    }
  }

  return safeCallees
}
