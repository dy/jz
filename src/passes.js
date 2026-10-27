/**
 * THE pass/tuning registry — the single authority for optimization policy names,
 * so optimize/index.js and ctx.js can't hold divergent hand-maintained lists.
 * Pure metadata, ZERO imports — both
 * src/ctx.js (hot bitmask) and src/optimize/index.js (presets, validation)
 * consume it, so no cycle can form. Presets, unknown-key validation, ALL_ON/OFF
 * generation, and the OPTF bitmask are all DERIVED from these lists.
 *
 * @module src/passes
 */
export const PASS_NAMES = [
  'watr',                     // third-party WAT-level CSE/DCE/inlining (heaviest)
  'devirtIndirect',           // call_indirect w/ known closure consts → guarded direct calls (WAT-level, grows bytes)
  // These emit-time transformations must be gated on individual pass flags, not on
  // BARE `ctx.transform.optimize` truthiness — resolveOptimize(0)'s all-false OBJECT
  // is still truthy, so a bare-truthiness gate would silently run them at O0 and
  // weaken it as the representation-free oracle. Named here so ALL_OFF genuinely
  // disables them; L1 keeps them (pre-existing tier behavior — they ran at every
  // truthy cfg).
  'inlineToNum',              // inline NaN-check ToNumber fast path (O0: compact __to_num call)
  'hashRmwFusion',            // lean-dict layout + dictionary/Map single-probe updates
  'inplaceStore',             // in-place replace store on the inline-cell layout
  'devirtClosureTables',      // dyn fn-table candidates: scan + call-site tags + resolve
  'devirtDynProps',           // megamorphic prop-read devirt markers (dvProp/dvObject)
  'speculateSchemaBranches',  // one schema guard around multi-field tagged-union branch bodies (speed-for-size)
  'hoistPtrType',
  'hoistInvariantPtrOffset',
  'hoistInvariantLoop',       // unified LICM (subsumes the former ToInt32/PtrOffsetLoop/CellLoads hoists)
  'narrowLoopBound',          // f64 loop bound → hoisted i32 (unblocks the lane-vectorizer)
  'wideAccumulator',          // f64 integer accumulator carried as i64 under a runtime magnitude guard (versioned loop)
  'intNarrow',                // integer-valued f64 locals and arithmetic in i32/i64 where the interval proves them exact (optimize/int-narrow.js)
  'wrappedWords',             // an i64 local read only for its low word: an i32 local, its addresses refolded (int-narrow.js narrowWrappedWords)
  'specializeLoops',          // a copy of a loop for reads that hit and integers that are integers, beside the loop as written (optimize/specialize.js)
  'combineGuards',            // the guards of a specialized loop: one test ahead of the loop or of a run of reads decides many (optimize/guards.js)
  'splitCharScan',            // charCodeAt scan loops: split at min(N, s.length) → i32 char carrier (plan-level)
  'countedLoops',             // cursors, computed starts and unrolled bodies → one counter from 0, unit stride versioned (plan/counted-loops.js)
  // Pre-analyze loop-shape transforms — applied in compile/index.js (NOT this pass pipeline), but
  // gated by these flags. Listing them here is load-bearing: ALL_OFF sets them false so level 0/1
  // (the self-compile fast path) actually skip them, instead of `undefined !== false` running them
  // unconditionally at every level. ALL_ON keeps them on at level 2+ where they belong.
  // REPRESENTATION passes (optimize false/0/1 is the representation-free
  // REFERENCE tier — plain layouts, an independent oracle for three-way
  // differentials; `{ level: 0, unionInline: true }` re-enables):
  'structInline',             // Array<S> packed inline cells (whole-program SRoA)
  'unionInline',              // closed heterogeneous-record union carrier + cursor clones
  'loopIVDivMod',             // strength-reduce per-iter `i%w` / `(i/w)|0` → incremental i32 counters
  'loopSquare',               // bounded `i*i < CONST` → Math.imul (i32 product chain)
  'unrollRecurrence',         // unit-stride DP/scan: scalar-replace arr[j-1]/arr[j] recurrence + ×2 unroll
  'clampPeel',                // edge-clamp stencil: split into clamp-free interior (vectorizes) + edges
  'hoistGlobalPtrOffset',     // stable typed GLOBALS: __ptr_offset resolve → once per function (post-watr, module-level)
  'hoistGlobalConstLoads',    // immutable fixed global typed cells → function-entry locals
  'maskedSuffixGuard',        // all-false SIMD masks skip large pure producer suffixes
  'guardedToInt32',           // ToInt32 tests the 32-bit range first: the narrow truncation, the exact form past it (post-watr)
  'hoistLoopGlobalPtrOffset', // per-loop complement: narrower write/call scan lets a clean loop hoist inside an otherwise-poisoned function
  'fusedRewrite',             // peephole + ptr-helper inline + memarg fold
  'chainConditions',          // `&&`/`||` diamonds in a condition position → jump-if-false/true branch chains
  'inlinePtrOffsetFast',      // speed-tier only: inline __ptr_offset's loop-free body (mask+tag
                              // test+forwarding bounds/sentinel check) at each surviving call site
                              // — the cold relocation-chase call ($__ptr_offset_fwd) stays out-of-
                              // line. Its own late pass (inlinePtrOffsetFastPass, optimize/index.js),
                              // run AFTER unswitchTypedParamLoop/vectorizeLaneLocal so their raw-call
                              // pattern match still gets first pick. Trades bytes/site for
                              // __ptr_offset, self-compile's dominant helper call by invocation count;
                              // opt-in like boolConvertToSelect (off at 'size'/level 2,
                              // on at 'speed'/level 3).
  'hoistAddrBase',
  'boolConvertToSelect',      // f64 ± (cond?1:0) → branchless select (kills i32↔f64 domain cross on recurrences)
  'cseScalarLoad',
  'reuseLoads',               // a load an earlier one read with no store between: its local (optimize/reuse-loads.js)
  'forwardStores',            // straight-line store-to-load forwarding + dead-store elimination
  'staticScratch',            // a static typed array only constant indices reach: stores forward to loads of any width, unread stores go (optimize/static-scratch.js)
  'moduleScratch',            // a module array of numbers only constant indices reach is locals of each function that uses it (plan/scratch.js)
  'aliases',                  // a binding that only ever holds another binding's value is that binding; a local nothing reads is not declared (plan/alias.js)
  'constants',                // a binding read where it holds a literal is the literal, a test of literals its answer (plan/constants.js)
  'valueNumber',              // value numbering over straight-line regions: one computation per value, through locals (watr's valueNumber)
  'scheduleStatements',       // straight-line statements in order of the work depending on them: independent kernel calls start together (watr's schedule)
  'unswitchTypedParamLoop',   // Float64Array param loop-unswitch → base-hoisted f64.load/store fast path (vectorizes)
  'unswitchStringRepLoop',    // leaf char scans: hoist invariant SSO/heap selection out of the byte loop
  'propagateLocals',          // watr local propagation after link, including the fast cleanup profile
  'coalesceLocals',           // watr shares non-overlapping local slots, including level 1
  'promoteGlobals',          // read-only global.get → local for multi-read globals
  'sortLocalsByUse',
  'specializeMkptr',
  'internStrings',            // slice/substring results probe the static-literal pool: equal-content → canonical bits (bit-eq fast paths)
  'hoistConstantPool',
  'sourceInline',
  'valKindClones',            // a function whose parameter's call sites disagree on its kind is cloned per kind (narrow/specialize.js)
  'laneRecords',              // record parameters read field by field become scalar lanes (plan/lanes.js)
  'sourceInlineDup',          // allow source-body duplication across calls or beside an export (speed-for-size)
  'smallConstForUnroll',
  'nestedSmallConstForUnroll',
  'splitScratch',             // SSA-split scalar scratch from unrolled loop copies, then LICM
  'vectorizeLaneLocal',       // SIMD-128 lift for lane-pure typed-array loops
  'recursionUnroll',          // inline a single non-tail self-call to depth N (tree-recursion call-overhead)
  'arenaRewind',              // per-call heap rewind for functions whose allocations stay in the frame
  'rewindGuard',              // a rewound frame compares the heap with its mark before it asks anything at a return: a call that allocated nothing skips the release (speed-for-size)
  'arenaReach',               // a call that ran an escape keeps what the escape reaches, not all it allocated (links the walk, ~2 KB)
  'iterationRelease',         // a loop whose escapes the frame flags gives back each iteration's memory by the flag and the walk (needs arenaReach)
  'compact',                  // the host compacts what the module keeps as the outermost call returns (module/core/compact.js, ~3 KB)
  'loopCompact',              // a loop whose iteration keeps some of what it allocates compacts it in place (optimize/loop-compact.js; needs compact)
  'placeLargeBlocks',         // a block of 4 KiB or more starts a quarter page past the last such block, mod 4096: streams of consecutive arrays share no low address bits (module/core.js __alloc)
  'versionArrayPatterns',     // an array pattern over a value that may be an array reads by position behind Array.isArray, the protocol beside it (plan/index-array-patterns.js)
  'treeshake',
  'refreshGrown',             // after a call that may grow an array, the caller's binding of it takes the new block (compile/emit/call.js), off at the size tier
  'truncChoice',              // a choice of a float's ceiling below zero and its floor above is its truncation (optimize/trunc-choice.js)
  'selectArms',               // a choice whose arms compute one tree: the tree over a select of the leaves they differ in (optimize/select-arms.js)
  'splitFuncs',               // a large function's conditional arms become functions of their own: V8 compiles what runs (optimize/split-funcs.js), speed-only
  'loopPasses',               // in a function that runs once, each pass of a loop that runs a loop is a call: V8 replaces code between calls only (optimize/split-funcs.js), speed-only
  'jsstring',                 // boundary opt-in: flip exported string params to externref
  // Registry completion (architecture plan Stage 0): every flag a call site
  // reads MUST be listed here — an unlisted name is `undefined !== false` and
  // silently runs at O0, breaking the representation-free reference tier.
  // test/passes.js greps every gate read against this list + TUNING_KEYS.
  'declareUnseenKeys',        // a key stored on objects nothing asks for their keys: a slot of their literals (plan/declare-unseen-keys.js)
  'promoteLoopFields',        // a field a loop reads and writes through one receiver: a local for the loop (plan/loop-fields.js)
  'numericArrays',            // an array the program proves holds only Numbers keeps them raw: no canonicalization, no hole test (compile/numeric-arrays.js)
  'callChosenFunctions',      // a local holding one of several functions and only called: the choice of direct calls (plan/chosen-calls.js)
  'specializeCalledArgs',     // a parameter only called, given a named function: a copy calling it by name (plan/called-args.js)
  'hoistObjectReads',         // a key a loop reads of an object the function made and only reads: one read where it is made (plan/object-reads.js)
  'hoistSiteReceivers',       // a store's unreadable receiver at a statement's head is read into a local the site then names (plan/site-receivers.js)
  'versionIntegralLoops',     // a loop indexing by numbers of unknown integrality: a copy over their int32s where they are ones (plan/integral-loops.js), speed-for-size
  'adoptLoopCounters',        // a `for` adopts a counter declared outside it and read nowhere else (plan/counted-loops.js)
  'forwardConditions',        // a boolean declared once from a condition for the `if` right after it: the `if` tests the condition (plan/forward-conditions.js)
  'unswitchLoops',            // a loop testing a name it never writes: a copy for each answer (plan/unswitch-loops.js), speed-for-size
  'reciprocalDivisors',       // a loop dividing by a name it never writes: a copy multiplying by the reciprocal where the divisor is a power of two (plan/reciprocal-loops.js), speed-for-size
  'splitLoopKinds',           // a loop reading a name of several kinds, a typed array among them: a copy where it holds that array (plan/kind-split.js), speed-for-size
  'loadCSE',                  // straight-line typed element-load CSE (compile-level, pre-analyze)
  'intDivLower',              // i32/i32 constant-divisor strength lowering
  'forInUnroll',              // for-in over a static schema → key-literal-substituted body copies
  'versionTypedBounds',       // typed-bounds loop versioning (guarded fast arm + checked twin)
  'sentinelGuards',           // one range test versions a sentinel-bounded cursor's reads (compile/sentinel-guard.js)
  'twinLocals',               // a versioned counted loop's checked twin writes locals of its own (compile/twin-locals.js)
  'carryElements',            // an element a loop stores for its next pass stays in a local (compile/carry-elements.js)
  'arrayViews',               // a slice read only as a spread source keeps its array and a range (compile/array-view.js)
  'wordLocals',               // a local every read of which re-applies ToInt32 holds its word (compile/analyze-scans.js narrowWordLocals)
  'intervalRanges',           // whole-binding and interprocedural interval fixpoints; omitted by the compile-budget tiers
  'guardViews',               // a typed array a guard proves is read through a view of its constructor (compile/plan/guard-views.js)
  'staticLocals',             // a typed array a function makes at a literal length and keeps to itself: static storage, its address a constant (compile/fixed-memory.js)
  'hoistConstLit',            // loop-invariant const array/object literal hoist (allocate once)
  'unrollScalarChain',        // serial-chain (address-carried scalar) ×2 pairing — speed-only
  'selectArmUpdates',         // disjoint-arm update chain → select accumulation — speed-only
  'guardedUpdate',            // a data-dependent last conjunct folds into the update it guards (optimize/guarded-update.js) — speed-only
  'typedDecode',              // a typed receiver of open kind decodes once per loop (optimize/typed-decode.js)
  'shiftRemainder',           // a remainder rebuilt from its shifted quotient is a mask (optimize/shift-remainder.js)
  'narrowFloat32',            // `fround` of an operator over `fround`s runs in single precision (optimize/float32.js)
  // WAT-pipeline passes previously gated only by `undefined !== false` inside
  // optimizeFunc (found by the registry-coverage gate on its first run):
  'foldStaticArrReads',       // const-index reads of static-data arrays → immediates
  'nanCanon',                 // a Number's canonical-NaN step only arithmetic reads is its value (optimize/nan-canon.js)
  'blurMultiPixel',           // stencil vectorizer's multi-pixel mode
  'stencil',                  // stencil vectorizer (bit-exact pure win; listed for the O0 contract)
  'outerStrip',               // outer-loop strip-mining vectorizer
  'toneMap',                  // tone-map reduction vectorizer
  'pairIterations',           // two items' inner float recurrences run side by side (optimize/vectorize/pair-iterations.js), speed-for-size
  'forwardChecked',           // an element load under a guard takes the word a store or load under that guard left (optimize/forward-checked.js)
  'slp',                      // superword-level parallelism (adjacent-scalar packing)
  'devirtFnArrays',           // const fn-array call_indirect → guarded direct calls
  'devirtSchemaReads',        // megamorphic dyn-get probe → br_table over registered schemas
  'inlineDevirtArms',         // inline the devirt guard's direct-call arms
]

/** Numeric/string tuning knobs the presets may set — legal config keys that are
 *  NOT on/off passes. The registry-coverage test accepts these; anything else
 *  read off the optimize object is an unregistered flag and fails the gate. */
export const TUNING_KEYS = [
  'level', 'arrayMinCap', 'arrayLiteralMinCap', 'hashSmallInitCap', 'collectionInitCap', 'watrProfile', 'watrGuard', 'watrLicm',
  'watrLsr',                  // watr's loop strength reduction: addresses affine in a counter become pointers (speed tier)
  'compactStubs',             // entries of the stub log a loop's compaction reads (module/core/stub-log.js); default 65536
  'compactSlack',             // bytes a loop's kept memory grows past twice the last walk before it compacts (module/core/stub-log.js)
  'splitFn', 'splitTo', 'splitArm', // the instruction nodes past which a function splits, it is brought down to, and an arm must reach to move (optimize/split-funcs.js)
  'wordTruncation',           // how a truncation keeps its word: 'wide' | 'narrow' | 'add' (optimize/int-narrow.js)
  'coldTrap',                 // diagnostic: a versioned loop's arm as written throws its version's number (plan/integral-loops.js)
  'reduceUnroll', 'relaxedSimd', 'inlineFns', 'rotateLoops', 'leanCheckedIdx', 'watrIfset', 'poolFloats', 'selectBits',
  'maskOperands',             // a byte or halfword mask over `^`/`|` moves onto the operand it narrows (optimize/mask-operands.js, speed tier)
  'inlineTiny', 'tinyNodes',  // a function of at most tinyNodes instructions joins every caller (optimize/inline-tiny.js, speed tier)
  'searchLoops',              // a loop whose body is a guarded loop scans for its guard in an innermost loop (optimize/search-loops.js, speed tier)
  'pointerExits',             // a loop keeping a counter only to stop stops by the pointer strength reduction steps beside it (optimize/pointer-exits.js, speed tier)
  'ringLaps',                 // a counted loop stepping a cursor around a ring runs a lap at a time (optimize/ring-laps.js, speed tier)
  'earlyStores',              // a store ready before a long computation it does not read goes ahead of it (optimize/early-stores.js, speed tier)
  'leadChains',               // a loop body of arithmetic computes its chain a few links ahead of the work hanging off it (optimize/lead-chains.js, speed tier)
  'issueOrder',               // a loop body of floating-point arithmetic is written in the order that issues its chain soonest (optimize/issue-order.js, speed tier)
  'jamItems',                 // two items of a loop over independent items run their inner loops side by side (compile/loop-jam.js, speed tier)
  'leanRuntime',              // size tier: runtime walks link their simplest correct body (no hot/cold
                              // split, no chunked scan, no per-site hash fast arms) — the -Os profile
                              // of the string equality/hash family
  'scalarTypedLoopUnroll', 'scalarTypedNestedUnroll', 'scalarTypedArrayLen',
  'snapshotInit',
  'rationalConst',            // SEMANTIC precision lowering (rational constant carry — pinned
                              // by the precision suite at EVERY tier incl. O0), opt-out only:
                              // not a level-gated optimization, so not in PASS_NAMES/ALL_OFF
  'splitBindings',            // an assignment of a function's own statement list declares its value as a
                              // binding of its own (prepare/split-bindings.js). A normal form of the
                              // source, at EVERY tier: what a parameter is used as (README, "Numeric
                              // export parameters") is read off it, and may not differ by level.
                              // Opt-out only, for a test of what a second write does to a binding.
  'whyNotSimd',               // diagnostic: print vectorizer rejection reasons
  'crPow',                    // opt-in experimental pow vectorization
  'inlinePureFns',            // opt-in pure-function WAT inlining (assemble)
  'approxPow',                // opt-in low-precision pow fifthroot gate (module/math.js emitPow)
  'noSimd',                   // suppress every jz-emitted v128 (lane vectorizer + SLP) — true scalar baseline
]

// Hot per-node pass flags: ONE list generates both the bitmask constants and the
// cfg→mask mapping (src/ctx.js OPTF/optFlagsOf), so a flag cannot exist in one
// and be missed in the other. Order = bit position — append-only. Every name
// must also be registered above; optimize/index.js asserts that at module load.
export const HOT_PASSES = ['inlineToNum', 'hashRmwFusion', 'inplaceStore',
  'devirtClosureTables', 'devirtDynProps', 'leanCheckedIdx']
