/**
 * The optimizer's order: every pass, one entry each, in the order they run. The
 * four sequences are walks of this table: the module stage
 * (wat/assemble/optimize-module.js, around the function walk), each function's
 * passes (driver.js optimizeFunc), link's passes on the tape (link/index.js) and
 * the tail around watr (watr-tail.js). Each binds a runner to every entry of its
 * stage (`stage`) and walks them as listed; none holds an order of its own.
 *
 * An entry:
 *   id     the step, the runner's key (`pass.role` where one pass runs twice)
 *   at     its stage: 'module', 'func' (each function, the module's `optimizeFuncs`
 *          step), 'globalPtr' and 'globalLoads' (each function, their module
 *          steps), 'link', 'bodies' (each function on the tape, link's `bodies`),
 *          'tail'; a stage's entries follow the step that walks them
 *   on     the flags it runs under, all of them: `x` unless cfg.x is false, `+x`
 *          where it is true, `?x` where truthy, `!x` where falsy; `a|b` either
 *   after  the steps it follows where both run, each with why; `first` and `last`,
 *          before or after every other step of its stage but those it follows
 *   takes  what it reads beyond its IR: the compile's facts (optimize-module.js
 *          passFacts, link's and the tail's facts) and what an earlier step made
 *   makes  what it adds to them, or hands the steps after it in its function
 *   reads  the marks the emitter leaves on IR nodes (a property of the node's
 *          array, or a side table keyed by the node) that it reads
 *   drops  the marks it loses, rebuilding a node that carried one without it
 *          (measured, 2026-11-12: every bench case at three levels, the examples
 *          and the phase-4 review's features; other code may lose more)
 *   lost   the marks it reads that a step before it drops: it acts on those left
 *
 * `checkOrder` holds the table to it (test/pass-table.js): a step after the
 * steps it follows, after the step that makes what it takes, and no step that
 * drops a mark between the emitter and a reader of it unless the reader lists
 * the mark as `lost`.
 *
 * @module optimize/pass-table
 */

const P = (id, at, on, more) => ({ id, at, on: on || '', after: {}, first: false, last: false, takes: '', makes: '', reads: '', drops: '', lost: '', why: '', ...more })

export const PASSES = [
  // -- module, before the function walk ---------------------------------------------------------------
  P('dropStaticRoots', 'module', '', { takes: 'staticData exports globals' }),
  P('staticScratch', 'module', 'staticScratch', {
    after: { dropStaticRoots: 'a binding whose root line went is written once, at its declaration' },
    takes: 'staticData shared exports globals globalTypes consts userGlobals', why: 'reads the accesses as emitted, before a pass stages their bases in locals' }),
  P('specializeMkptr', 'module', 'specializeMkptr', { reads: 'schemaSid' }),
  P('hoistGlobalPtr', 'module', 'hoistGlobalPtrOffset|hoistLoopGlobalPtrOffset', { takes: 'globalValTypes', makes: 'stableGlobals reachableWrites' }),
  P('hoistGlobalPtrOffset', 'globalPtr', 'hoistGlobalPtrOffset', { takes: 'stableGlobals reachableWrites', makes: 'snapshots', why: 'before promoteGlobals hides global.get' }),
  P('hoistLoopGlobalPtrOffset', 'globalPtr', 'hoistLoopGlobalPtrOffset', {
    after: { hoistGlobalPtrOffset: 'shares its function-entry snapshots' }, takes: 'stableGlobals reachableWrites snapshots' }),
  P('pureFuncMap', 'module', '+vectorizeLaneLocal', { makes: 'pureFuncMap', why: 'the pure functions the lane lift may inline, as clean scalar bodies' }),
  P('inlinePureFns', 'module', '+vectorizeLaneLocal +inlinePureFns', { takes: 'pureFuncMap', why: 'the vectorizer sees the callee arithmetic' }),
  P('dvArmFns', 'module', '', { takes: 'constFnArrays', makes: 'dvArmFns', why: 'a function pass cannot see its siblings' }),
  P('optimizeFuncs', 'module', '', { makes: 'reachableWrites headerSafeFuncs', why: 'each function by the func entries below, the calls a loop may make without a header changing known' }),
  // -- each function --------------------------------------------------------------------------------------
  P('foldStaticArrReads', 'func', 'foldStaticArrReads', { first: true, takes: 'staticArrs arrResized nameEscapes', reads: 'saArr saBits', why: 'by the marks, which a pass that rebuilds a subtree drops' }),
  P('holdWordNumbers', 'func', 'fusedRewrite', { after: { foldStaticArrReads: 'beside it, by the mark as well' }, reads: 'wordOf', why: 'a word local only float code reads holds its number', drops: 'irange' }),
  P('promoteCells', 'func', 'promoteCells', {
    first: true, after: { foldStaticArrReads: 'by the marks, first', holdWordNumbers: 'the same' }, why: 'before every pass that reads locals: a cell no closure took is one of them' }),
  P('nanCanon', 'func', 'nanCanon', { why: 'before the lifts read the sums: a canon only arithmetic reads is its value' }),
  P('hoistPtrType', 'func', 'hoistPtrType', { why: 'its locals the fused walk sees in their final form' }),
  P('hoistInvariantPtrOffset', 'func', 'hoistInvariantPtrOffset'),
  P('hoistPtrOffset', 'func', 'hoistInvariantPtrOffset', { after: { hoistInvariantPtrOffset: 'the loop-invariant offsets first' } }),
  P('narrowLoopBound', 'func', 'narrowLoopBound', { why: 'the snapped i32 bound is a hoistable subtree for the LICM after it', drops: 'irange' }),
  P('hoistInvariantLoop', 'func', 'hoistInvariantLoop', {
    after: { narrowLoopBound: 'the snapped bound is a hard-op subtree an outer loop lifts' },
    takes: 'freshTypedGlobals headerSafeFuncs', reads: 'boundsOwner', why: 'the raw ToInt32, offset and arithmetic shapes, before the fused walk', drops: 'schemaSid irange provenWord' }),
  P('fusedRewrite', 'func', 'fusedRewrite', {
    after: { hoistPtrType: 'its locals in their final form', hoistInvariantLoop: 'the raw shapes it folds are hoisted first' },
    takes: 'hasBigint loweringLinks', reads: 'loweringLinks', drops: 'schemaSid irange unsigned mem' }),
  P('unswitchStringRepLoop', 'func', '+unswitchStringRepLoop', { takes: 'funcCount', drops: 'irange' }),
  P('shiftRemainder', 'func', 'shiftRemainder', { after: { fusedRewrite: 'the quotient and its scaling are in their i32 form' }, drops: 'irange' }),
  P('boolConvertToSelect', 'func', '+boolConvertToSelect'),
  P('hoistAddrBase', 'func', 'hoistAddrBase', { drops: 'irange' }),
  P('hoistInvariantLoop.late', 'func', 'hoistInvariantLoop', {
    after: { hoistAddrBase: 'the cell loads it stages', fusedRewrite: 'idempotent, at the second maturity point' },
    takes: 'freshTypedGlobals headerSafeFuncs', reads: 'boundsOwner' }),
  P('cseScalarLoad', 'func', 'cseScalarLoad', { drops: 'mem' }),
  P('forwardStores', 'func', 'forwardStores', {
    after: { hoistAddrBase: 'after the address hoists: a chained kernel\'s out-parameter results stay in the locals that staged them', hoistPtrOffset: 'the same' },
    reads: 'mem', drops: 'irange presentNumRead mem', lost: 'mem' }),
  P('sinkStores', 'func', '+sinkStores', { after: { forwardStores: 'on what forwarding left' }, reads: 'mem', lost: 'mem' }),
  P('earlyStores', 'func', '+earlyStores', { after: { forwardStores: 'on the stores forwarding kept' } }),
  P('promoteGlobals', 'func', 'promoteGlobals', {
    after: { hoistGlobalPtrOffset: 'the global pointer hoists read global.get, which this hides', hoistLoopGlobalPtrOffset: 'the same' },
    takes: 'globalRefTypes reachableWrites' }),
  P('unswitchTypedParamLoop', 'func', '+vectorizeLaneLocal unswitchTypedParamLoop', { takes: 'f16' }),
  P('vectorizeLaneLocal', 'func', '+vectorizeLaneLocal', {
    after: { nanCanon: 'the lifts read the sums, a canon only arithmetic reads gone', pureFuncMap: 'its inline candidates' },
    takes: 'pureFuncMap loweringLinks typedView warn', reads: 'loweringLinks cold', makes: 'vectorized', drops: 'loweringLinks irange' }),
  P('foldV128Memargs', 'func', '+vectorizeLaneLocal', { after: { vectorizeLaneLocal: 'the v128 memargs it made', fusedRewrite: 'whose memarg fold ran before the lift' } }),
  P('guardedUpdate', 'func', '+guardedUpdate', { after: { vectorizeLaneLocal: 'the vectorizer reads a conditional update in its branch form' }, drops: 'irange' }),
  P('typedDecode', 'func', '+typedDecode', { after: { unswitchTypedParamLoop: 'the accesses it left to the helpers', vectorizeLaneLocal: 'the same' }, takes: 'resizable', drops: 'irange' }),
  P('splitLoopPrivateScratch', 'func', '+splitScratch hoistInvariantLoop', { takes: 'freshTypedGlobals headerSafeFuncs', drops: 'schemaSid loweringLinks irange unsigned presentNumRead wrapSafe iterRelease elemKey mem dvProp wordOf saArr checkedTwin cold checkedNumRead provenWord boundsSnapshot dvObject boundsOwner' }),
  P('hoistInvariantLoop.scratch', 'func', '+splitScratch hoistInvariantLoop', {
    after: { splitLoopPrivateScratch: 'its moved invariants ride the LICM once more' }, takes: 'freshTypedGlobals headerSafeFuncs', reads: 'boundsOwner', lost: 'boundsOwner' }),
  P('devirtFnArrays', 'func', 'devirtFnArrays', {
    takes: 'constFnArrays dvArmFns staticArrs arrResized nameEscapes', reads: 'dvArr dvOpen dvKey dvKeyed',
    why: 'the table\'s candidates fill only when module init emits, after the bodies', drops: 'dvArr' }),
  P('devirtSchemaReads', 'func', 'devirtSchemaReads', { takes: 'schemas schemasByProp fieldKind includes icSite', reads: 'dvProp dvObject', lost: 'dvProp dvObject', drops: 'dvProp dvObject' }),
  P('lowerToInt32Tails', 'func', 'fusedRewrite inlineToNum', {
    after: { vectorizeLaneLocal: 'the lift reads the exact conversion as the kernel call', devirtFnArrays: 'the devirtualizations read emit\'s marks', devirtSchemaReads: 'the same' } }),
  P('specializeLoops', 'func', 'intNarrow +specializeLoops', {
    after: { lowerToInt32Tails: 'the loops specialized on reads that hit, after the conversion\'s tail' },
    reads: 'checkedNumRead holeNumRead checkedTwin boundsSnapshot irange presentNumRead', makes: 'copies plan', lost: 'checkedNumRead checkedTwin boundsSnapshot irange presentNumRead' }),
  P('narrowInts', 'func', 'intNarrow', { after: { specializeLoops: 'integer registers over its copies' }, takes: 'copies plan', reads: 'provenWord irange presentNumRead cold', drops: 'loweringLinks irange unsigned presentNumRead cold checkedTwin checkedNumRead provenWord', lost: 'provenWord irange presentNumRead cold' }),
  P('narrowWrappedWords', 'func', 'intNarrow wrappedWords', { after: { narrowInts: 'a wide integer read only for its low word' }, makes: 'wrapped', drops: 'loweringLinks cold' }),
  P('refoldMemargs', 'func', 'intNarrow wrappedWords', { after: { narrowWrappedWords: 'the addresses it narrowed' }, takes: 'wrapped' }),
  P('combineGuards', 'func', 'intNarrow combineGuards', { after: { narrowInts: 'over the integers: the guards of the copies' }, takes: 'copies', reads: 'irange presentNumRead', lost: 'irange presentNumRead' }),
  P('wideAccumulator', 'func', '+wideAccumulator', { after: { narrowInts: 'stronger signed-word proofs run first' }, drops: 'irange iterRelease' }),
  P('narrowFloat32', 'func', 'narrowFloat32', { after: { vectorizeLaneLocal: 'after the lane lift', devirtFnArrays: 'and the devirtualizations, whose marks its copied nodes keep', devirtSchemaReads: 'the same', narrowInts: 'single-precision locals after the integer registers' }, reads: 'irange presentNumRead', drops: 'loweringLinks presentNumRead', lost: 'irange presentNumRead' }),
  P('recursionUnroll', 'func', '+recursionUnroll', { after: { narrowInts: 'its size gate reads the body as it will be emitted' } }),
  P('foldLoadCasts', 'func', 'fusedRewrite', { after: { specializeLoops: 'the copies read hit elements bare' }, drops: 'schemaSid mem' }),
  P('reuseLoads', 'func', '+reuseLoads', { after: { forwardStores: 'after every pass that places loads', cseScalarLoad: 'the same', specializeLoops: 'the same' }, reads: 'mem', drops: 'unsigned presentNumRead wrapSafe mem cellI32', lost: 'mem' }),
  P('narrowByteLoads', 'func', '+reuseLoads', { after: { reuseLoads: 'a part of a word read alone, the narrow load of it' } }),
  P('settledTests', 'func', 'settledTests', { after: { combineGuards: 'over the guards every pass above left', specializeLoops: 'the same' } }),
  P('inlinePtrOffsetFast', 'func', '+inlinePtrOffsetFast', {
    last: true, why: 'the helper call is the form every pass above reasons about (LICM hoists it, unswitch and devirt recognize it); its inline fast path is lowering' }),
  // -- module, after the function walk ----------------------------------------------------------------
  P('vectorizedFns', 'module', '', { takes: 'vectorized', why: 'the functions the lane lift took, for the pins of watr\'s inliner' }),
  P('clearIcSites', 'module', '', { after: { devirtSchemaReads: 'the sites it made' }, takes: 'icSite' }),
  P('quietCopies', 'module', '', {
    after: { specializeLoops: 'a copy that allocates nothing as optimized' },
    takes: 'compactLoopLabels rewindLoopLabels includes imports stdlib', reads: 'iterRelease', makes: 'quietLoops', drops: 'iterRelease', lost: 'iterRelease' }),
  P('loopRewinds', 'module', '', {
    after: { vectorizeLaneLocal: 'a loop it lifted is a node the rewinds never see', quietCopies: 'no rewind around a quiet copy' },
    takes: 'rewindLoopLabels shared globals quietLoops' }),
  P('loopCompacts', 'module', '', {
    after: { quietCopies: 'no compaction around a quiet copy' },
    takes: 'compactLoopLabels shared memoryMax globals quietLoops compactSlack', why: 'the write closure counts its kernels as written before it goes in' }),
  P('forwardHops', 'module', 'hoistForwardHops', { after: { loopCompacts: 'a compacted loop is re-entered past the set before it' }, takes: 'imports reachableWrites globalTypes' }),
  P('hoistGlobalConstLoads', 'module', 'hoistGlobalConstLoads|maskedSuffixGuard', { takes: 'globalTypedLen', makes: 'reachableWrites masked memoryWrites' }),
  P('hoistStableGlobalConstLoads', 'globalLoads', 'hoistGlobalConstLoads', { takes: 'memoryWrites reachableWrites globalTypedLen globalTypedElem freshTypedGlobals' }),
  P('guardMaskedVectorSuffix', 'globalLoads', 'maskedSuffixGuard', { takes: 'masked memoryWrites' }),
  P('outlineToInt32', 'module', '?leanRuntime'),
  P('appendLateStdlib', 'module', '+vectorizeLaneLocal', { after: { vectorizeLaneLocal: 'the f64x2 mirrors the lift named' } }),
  // -- link, on the tape -----------------------------------------------------------------------------------
  P('bodies', 'link', ''),
  P('fold', 'bodies', 'fusedRewrite'),
  P('rotateLoops', 'bodies', '+rotateLoops', { after: { fold: 'fold before rotation' } }),
  P('reduceThrowHelpers', 'link', '', { takes: 'throws userThrows noEhAbort throwHelpers' }),
  P('arenaRewind', 'link', '', {
    after: { reduceThrowHelpers: 'a throw nothing observes allocates nothing' },
    takes: 'rewindable heapAddr exported censused closureTargets entry keeps keepsNothing', makes: 'arena', why: 'its proof at every level, the rewrite where the rewind is on' }),
  P('dropCompaction', 'link', '', { after: { arenaRewind: 'what each export keeps' }, takes: 'compact exportInner compactLoops arena' }),
  P('adviseKept', 'link', 'arenaRewind', { takes: 'adviseKept arena' }),
  P('treeshake', 'link', '', { after: { reduceThrowHelpers: 'reads their calls' }, takes: 'userFuncs userGlobals', makes: 'callCount' }),
  P('schemaSections', 'link', '', { after: { treeshake: 'the custom sections describe what survived' }, takes: 'schemas fieldContracts namedUses errorSids brandSids regexSids viewSids hostObjects' }),
  P('releaseSection', 'link', '', { after: { treeshake: 'the same' }, takes: 'exportInner arena copiedArgs asked numberResult' }),
  P('pruneThrowRuntime', 'link', '', { takes: 'throws userThrows rawAbi' }),
  P('sortLocalsByUse', 'link', 'sortLocalsByUse !watr', { why: 'watr\'s sortLocals orders them where watr runs' }),
  P('orderFuncs', 'link', '', { takes: 'callCount' }),
  P('renameLocals', 'link', ''),
  // -- the tail, around watr ----------------------------------------------------------------------------
  P('legalize', 'tail', '', { takes: 'targetProfile' }),
  P('shareSplitSlots', 'tail', 'splitBindings', { why: 'before watr: the generic optimizer then reads the function the source wrote' }),
  P('watrOptions', 'tail', '', { takes: 'funcCount boundaryPins', makes: 'watrOpts' }),
  P('foldWrappedWords', 'tail', '', { why: 'before watr: a wrapped word operation over extended words is the word operation' }),
  P('narrowBoxedLocals', 'tail', ''),
  P('stillLoads', 'tail', '+stillLoads'),
  P('watOptimize', 'tail', '?watr', { after: { shareSplitSlots: 'the function the source wrote', foldWrappedWords: 'the words', narrowBoxedLocals: 'the pointers', stillLoads: 'the loads ahead of the loop' }, takes: 'watrOpts' }),
  // (without watr's fixpoint: its cleanup passes, once)
  P('conditions', 'tail', '!watr chainConditions'),
  P('propagate', 'tail', '!watr propagateLocals'),
  P('bool', 'tail', '!watr fusedRewrite'),
  P('coalesceLocals', 'tail', '!watr coalesceLocals', { why: 'large recursive functions need compact frames even without the fixpoint' }),
  P('localReuse', 'tail', '!watr coalesceLocals|propagateLocals'),
  P('poolConstants', 'tail', '!watr hoistConstantPool'),
  P('postGlobalPtr', 'tail', 'hoistGlobalPtrOffset', { after: { watOptimize: 'watr\'s inliner can merge stable-pointee decodes into one caller' }, takes: 'stableGlobals' }),
  P('guardToInt32', 'tail', '+guardedToInt32', { after: { watOptimize: 'on what the optimizer left' } }),
  P('foldWrappedWords.late', 'tail', '', { after: { guardToInt32: 'over what the propagation and the truncation\'s lowering brought together' } }),
  P('narrowFlagLocals', 'tail', '', { after: { watOptimize: 'a flag of literals, read as the optimizer leaves it' } }),
  P('forwardChecked', 'tail', 'forwardChecked', { after: { watOptimize: 'the checked reads and stores watr left' } }),
  P('stripDeadLateData', 'tail', '', { after: { watOptimize: 'its inlining and folding expose the last dead call' }, takes: 'lazyDataSpans staticDataSpan dataRecords' }),
  P('unrollTrips', 'tail', '+unrollTrips', { after: { watOptimize: 'on the loops the optimizer leaves' } }),
  P('ringLaps', 'tail', '+ringLaps', { after: { unrollTrips: 'before the passes after it read a counted loop\'s counter' } }),
  P('pointerExits', 'tail', '+pointerExits', { after: { ringLaps: 'before the counters become pointer tests', watOptimize: 'the pointers its strength reduction left' } }),
  P('jumpPointers', 'tail', '+jumpPointers', { after: { watOptimize: 'the variables its strength reduction leaves for their jumps' } }),
  P('leadChains', 'tail', '+leadChains', { after: { watOptimize: 'its own passes would merge the split values back' } }),
  P('issueOrder', 'tail', '+issueOrder', { after: { leadChains: 'a run they leave as written' } }),
  P('maskOperands', 'tail', '+maskOperands'),
  P('truncChoice', 'tail', 'truncChoice'),
  P('selectArms', 'tail', 'selectArms', { after: { truncChoice: 'the arms the truncations brought together' } }),
  P('shareQuotients', 'tail', 'shareQuotients', { after: { selectArms: 'the selects the arms became' } }),
  P('testedChoices', 'tail', '+testedChoices'),
  P('selectBits', 'tail', '+selectBits', {
    after: { truncChoice: 'the passes that read a float select as one', selectArms: 'the same', testedChoices: 'the same' }, takes: 'noSimd' }),
  P('searchLoops', 'tail', '+searchLoops', { after: { watOptimize: 'its own passes would fold the scan\'s blocks back' } }),
  P('leadGathers', 'tail', '+leadGathers', { after: { watOptimize: 'its value numbering would read the gather back' } }),
  P('carryStores', 'tail', '+carryStores', { why: 'while each loop has one latch' }),
  P('skipLatches', 'tail', '+skipLatches', { after: { carryStores: 'the latch it reads is the loop\'s one', searchLoops: 'on the scans the passes above leave' } }),
  P('guardExtremes', 'tail', '+guardExtremes'),
  P('pairTests', 'tail', '+pairTests', { takes: 'noSimd' }),
  P('inlineTiny', 'tail', '+inlineTiny', { after: { searchLoops: 'after the passes that read the runtime\'s calls by name' }, takes: 'watrOpts userFuncs' }),
  P('unsignedDivision', 'tail', 'unsignedDivision', { after: { inlineTiny: 'every division, the inlined helpers\' among them' } }),
  P('constBases', 'tail', 'constBases', { after: { inlineTiny: 'the inliner\'s constant arguments', unsignedDivision: 'the passes that read an address as written' } }),
  P('poolFloats', 'tail', '+poolFloats', {
    after: { forwardChecked: 'the float literals the passes before it read as constants', guardExtremes: 'a running extreme\'s canonicalization reads its NaN as a literal', pairTests: 'the same', constBases: 'the same' } }),
  P('loopPasses', 'tail', '+loopPasses', { after: { inlineTiny: 'an inliner would splice a pass back into the function that runs once' }, takes: 'userFuncs' }),
  P('splitFuncs', 'tail', '+splitFuncs', { after: { inlineTiny: 'which would splice a single-caller arm back' } }),
  P('relaxExtremes', 'tail', '+relaxExtremes +relaxedSimd', { after: { splitFuncs: 'each vector loop where it will run', loopPasses: 'the same' }, takes: 'noSimd' }),
  P('hoistVectorConsts', 'tail', '+hoistVectorConsts', { last: true, why: 'on the vector loops every pass above left, each where it will run' }),
]

const words = (s) => s ? s.split(' ') : []
// An entry's flag tests, read once: each test a list of alternatives, each { name, how }.
for (const e of PASSES) {
  e.tests = words(e.on).map(t => t.split('|').map(a => a[0] === '+' || a[0] === '?' || a[0] === '!' ? { name: a.slice(1), how: a[0] } : { name: a, how: '' }))
  e.takes = words(e.takes); e.makes = words(e.makes); e.reads = words(e.reads); e.drops = words(e.drops); e.lost = words(e.lost)
}

/** Whether `e` runs under `cfg` (an absent cfg runs every step but the opt-in ones). */
export function on(e, cfg) {
  for (const alts of e.tests) {
    let any = false
    for (const { name, how } of alts) {
      const v = cfg?.[name]
      if (how === '+' ? v === true : how === '?' ? !!v : how === '!' ? !v : v !== false) { any = true; break }
    }
    if (!any) return false
  }
  return true
}

/** The entries of stage `at`, in order, each bound to its runner in `run` (id → function):
 *  a stage whose runners and entries differ fails where it loads. */
export function stage(at, run) {
  const steps = PASSES.filter(e => e.at === at)
  for (const e of steps) if (typeof run[e.id] !== 'function') throw new Error(`optimize/pass-table.js: ${at} step '${e.id}' has no runner`)
  for (const id of Object.keys(run)) if (!steps.some(e => e.id === id)) throw new Error(`optimize/pass-table.js: ${at} runner '${id}' has no entry`)
  return steps
}

/** Run `steps` (a stage's, `stage`) under `cfg`, each that is on by its runner in `run`,
 *  as `run[id](x, cfg, facts, st)`: `x` the stage's IR (a function, the module's sections,
 *  the tape's root), `st` what a step hands the steps after it. */
export function walk(steps, run, cfg, x, facts, st) {
  for (const e of steps) if (on(e, cfg)) run[e.id](x, cfg, facts, st)
}

/** What is wrong with the order of `table` (PASSES unless given), one line a fault; none, []. */
export function checkOrder(table = PASSES) {
  const out = [], at = new Map()
  table.forEach((e, i) => { if (at.has(e.id)) out.push(`'${e.id}' twice`); at.set(e.id, i) })
  const maker = new Map()
  table.forEach((e, i) => { for (const f of e.makes) if (!maker.has(f)) maker.set(f, i) })
  table.forEach((e, i) => {
    for (const id in e.after) {
      if (!at.has(id)) out.push(`'${e.id}' runs after '${id}', which is no step`)
      else if (at.get(id) > i) out.push(`'${e.id}' runs before '${id}', which it follows: ${e.after[id]}`)
    }
    for (const f of e.takes) if (maker.has(f) && maker.get(f) > i) out.push(`'${e.id}' takes '${f}' before '${table[maker.get(f)].id}' makes it`)
    for (let j = 0; j < table.length; j++) if (table[j].at === e.at && j !== i && !(table[j].id in e.after) &&
      (e.first && j < i || e.last && j > i)) out.push(`'${e.id}' runs ${e.first ? 'first' : 'last'} of its stage, but not before '${table[j].id}'`)
    for (const m of e.reads) for (let j = 0; j < i; j++)
      if (table[j].drops.includes(m) && !e.lost.includes(m)) out.push(`'${table[j].id}' drops the mark '${m}' before '${e.id}' reads it`)
  })
  return out
}
