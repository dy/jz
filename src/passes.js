/**
 * THE pass/tuning registry — the single authority for optimization policy names
 * (audit P2: two hand-maintained lists lived in optimize/index.js and ctx.js and
 * could drift despite the load-time assert). Pure metadata, ZERO imports — both
 * src/ctx.js (hot bitmask) and src/optimize/index.js (presets, validation)
 * consume it, so no cycle can form. Presets, unknown-key validation, ALL_ON/OFF
 * generation, and the OPTF bitmask are all DERIVED from these lists.
 *
 * @module src/passes
 */
export const PASS_NAMES = [
  'watr',                     // third-party WAT-level CSE/DCE/inlining (heaviest)
  'devirtIndirect',           // call_indirect w/ known closure consts → guarded direct calls (WAT-level, grows bytes)
  // Formerly-implicit emit-time transformations, gated on BARE `ctx.transform.optimize`
  // truthiness — which resolveOptimize(0)'s all-false OBJECT still satisfied, so they
  // silently ran at O0 and weakened it as the representation-free oracle (audit P1).
  // Named here so ALL_OFF genuinely disables them; L1 keeps them (pre-existing tier
  // behavior — they ran at every truthy cfg).
  'inlineToNum',              // inline NaN-check ToNumber fast path (O0: compact __to_num call)
  'hashRmwFusion',            // lean-dict layout + d[k]=f(d[k]) single-probe RMW fusion (one representation feature)
  'inplaceStore',             // in-place replace store on the inline-cell layout
  'devirtClosureTables',      // dyn fn-table candidates: scan + call-site tags + resolve
  'devirtDynProps',           // megamorphic prop-read devirt markers (dvProp/dvObject)
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
  'inlinePtrOffsetFast',      // speed-tier only: inline __ptr_offset's loop-free body (mask+tag
                              // test+forwarding bounds/sentinel check) at each surviving call site
                              // — the cold relocation-chase call ($__ptr_offset_fwd) stays out-of-
                              // line. Its own late pass (inlinePtrOffsetFastPass, optimize/index.js),
                              // run AFTER unswitchTypedParamLoop/vectorizeLaneLocal so their raw-call
                              // pattern match still gets first pick. Trades bytes/site for the
                              // dominant self-host helper call (17.9M/compile, 2026-07-28 helper-
                              // rank audit); opt-in like boolConvertToSelect (off at 'size'/level 2,
                              // on at 'speed'/level 3).
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
  'stencil',                  // stencil vectorizer (bit-exact pure win; listed for the O0 contract)
  'outerStrip',               // outer-loop strip-mining vectorizer
  'toneMap',                  // tone-map reduction vectorizer
  'slp',                      // superword-level parallelism (adjacent-scalar packing)
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
  'approxPow',                // opt-in low-precision pow fifthroot gate (module/math.js emitPow)
  'noSimd',                   // suppress every jz-emitted v128 (lane vectorizer + SLP) — true scalar baseline
  'valKindDominance',         // specializeValKindDichotomy's landslide threshold (fraction of resolved
                              // call sites a VAL kind must dominate to earn a pinned clone) — default 0.9
]

// Hot per-node pass flags: ONE list generates both the bitmask constants and the
// cfg→mask mapping (src/ctx.js OPTF/optFlagsOf), so a flag cannot exist in one
// and be missed in the other. Order = bit position — append-only. Every name
// must also be registered above; optimize/index.js asserts that at module load.
export const HOT_PASSES = ['inlineToNum', 'hashRmwFusion', 'inplaceStore',
  'devirtClosureTables', 'devirtDynProps', 'leanCheckedIdx']
