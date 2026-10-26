/**
 * The kernel's heap diagnostics: the heap pointer after each stage of a compile
 * and after every phase compileAst times, each phase recorded by name. The
 * arena is a bump allocator with no reclaim before the checkpoint, so a mark
 * minus the mark before it is the allocation between the two completions.
 *
 * A record is two typed-array slots, an id and a heap pointer, and a phase name
 * is its index in PHASE_NAMES (`other` for a name not listed): the typed arrays
 * are written in place and a Map lookup allocates nothing, so recording a phase
 * allocates nothing, first or repeated, and neither does reading the records
 * back. Every piece of state here, the count and the capacity included, is a
 * typed-array slot: the arrays are allocated at module init, below the mark the
 * arena rewind (`_clear`, and the checkpoint through `__park_rewind`) returns to,
 * and a rewind restores module globals to their post-init values but leaves
 * typed-array contents alone, so the records hold through a trap, a thrown
 * compile error, the checkpoint and `_clear`; they hold no pointer into a
 * compile's own allocations. Every kernel entry resets them (setupSelf). Phases
 * past `phaseCapacity` are counted, not recorded; the host may lower the
 * capacity (up to PHASE_RECORDS) to exercise that through this recorder.
 * scripts/kernel-marks.mjs reads the records; test/kernel-marks.js drives this
 * module compiled on its own.
 */

// Every phase compileAst times: its top-level phases, plan's sweeps and the
// module optimizer's steps (src/compile/index.js, src/compile/plan/index.js,
// src/wat/assemble/optimize-module.js). test/kernel-marks.js checks a compile's
// profile against it.
export const PHASE_NAMES = [
  'other',
  'summary', 'foldAggregates', 'plan', 'analyzeFuncs', 'structInline', 'unionInline', 'unionClones',
  'finalizeVariantIdentities', 'finalizeConcreteFunctionIds', 'publishParameterAbi', 'emitFuncs', 'emitClosures',
  'buildStart', 'resolveDynFnTables', 'pullStdlib', 'optimizeModule', 'link',
  'plan:moduleGlobalKinds', 'plan:unboxConstTypedGlobals', 'plan:inferModuleIntGlobals', 'plan:strictBoundaryTypeCheck', 'plan:foldKindTests', 'plan:collectFacts',
  'plan:classifyHashDictGlobals', 'plan:flattenFuncNamespaces', 'plan:declareWrittenKeys', 'plan:declareUnseenKeys', 'plan:devirtGlobalCalls', 'plan:devirtClassCalls', 'plan:indexArrayPatterns', 'plan:viewGuardedTyped',
  'plan:bindNestedRowLengths', 'plan:peelClampedStencil', 'plan:strengthReduceLoopDivMod', 'plan:jamLoopItems', 'plan:reciprocalLoopDivisors', 'plan:unrollRowLenPadLoops', 'plan:unrollRecurrences', 'plan:callChosenFunctions', 'plan:specializeCalledArgs', 'plan:inlineHotInternalCalls', 'plan:inlineLocalLambdas',
  'plan:specializeFixedRestCalls', 'plan:splitMapPairs', 'plan:hoistObjectReads', 'plan:hoistSiteReceivers', 'plan:promoteLoopFields', 'plan:guardConstants', 'plan:canonicalizeCountedLoops', 'plan:splitCharScan', 'plan:laneRecordParams', 'plan:scalarizeModuleScratch', 'plan:resolveAliases', 'plan:splitSplicedBindings', 'plan:propagateConstants', 'plan:resolveHeldMethods', 'plan:scalarizeArrayLiterals', 'plan:scalarizeObjectLiterals',
  'plan:promoteIntArrayLiterals', 'plan:scalarizeTypedArrays', 'plan:adoptLoopCounters', 'plan:forwardConditions', 'plan:unswitchLoops', 'plan:splitLoopKinds', 'plan:versionIntegralLoops', 'plan:synthesizeComputedDispatchCallSites',
  'plan:synthesizeMemberDispatchCallSites', 'plan:releaseLiftedAddressTakenNames', 'plan:buildProgramIndex', 'plan:dropUnreadGlobals',
  'plan:materializeAutoBoxSchemas', 'plan:resolveClosureWidth', 'plan:applyExportTypedArrayAbi', 'plan:splitByListKinds',
  'plan:collectSlotConstants', 'plan:narrowSignatures', 'plan:analyzeParamDistinctness', 'plan:analyzeFreshTypedGlobals', 'plan:refineSlotWriteHazards',
  'plan:analyzeParamNeverGrown', 'plan:scanInplaceStores', 'plan:specializeBimorphicTyped', 'plan:specializeValKindDichotomy',
  'plan:speculateTypedParams', 'plan:refineDynKeys', 'plan:refineSlotIntCensus',
  'optMod:specializeMkptr', 'optMod:volatileGlobals', 'optMod:reachableWrites', 'optMod:hoistGlobalPtr',
  'optMod:hoistLoopGlobalPtr', 'optMod:inlinePureFns', 'optMod:optimizeFuncs', 'optMod:hoistGlobalConstLoads', 'optMod:appendLateStdlib',
  'frameEffects', 'frameEffectsRefresh', 'optMod:loopRewinds', 'optMod:dropStaticRoots', 'optMod:staticScratch', 'analyzeClosures', 'shareSplitSlots', 'guardToInt32', 'forwardChecked', 'poolFloatConstants', 'truncChoice', 'selectBits', 'ringLaps', 'pointerExits', 'leadChains', 'issueOrder', 'maskOperands', 'searchLoops', 'inlineTiny', 'loopPasses', 'splitFuncs',
  // a phase checkpoint's verdict (scripts/self.js checkpointPhase), recorded before the phase's own record
  'checkpoint:taken', 'checkpoint:unsafe', 'checkpoint:unparkable', 'checkpoint:unworthy',
  // what a declined phase kept once compacted (module/core.js `__gc_phase`), recorded after its verdict
  'checkpoint:compacted',
]
const PHASE_IDS = new Map(PHASE_NAMES.map((name, id) => [name, id]))
export const PHASE_RECORDS = 256
const ids = new Float64Array(PHASE_RECORDS)
const heaps = new Float64Array(PHASE_RECORDS)
// The stage marks: after the front, after emit and link, after watr, after the checkpoint.
export const STAGE_FRONT = 0, STAGE_EMIT = 1, STAGE_OPTIMIZE = 2, STAGE_CHECKPOINT = 3
const stages = new Float64Array(4)
// The tape after link: its node count and the column capacity it grew to.
const tape = new Float64Array(2)
// The count of phases recorded, the capacity, the phase checkpoints taken and the ones declined: [done, capacity, checkpoints, declines]
const counts = new Float64Array(4)
counts[1] = PHASE_RECORDS

// A phase checkpoint's verdict beside its record (scripts/self.js checkpointPhase):
// the phase's mark, the escape flag the verdict read, whether the durable logs
// held, and the phase's serial among the phases opened since the entry.
const verdicts = new Float64Array(PHASE_RECORDS * 4)
// The open phase checkpoints, innermost last, for a diagnostic host that reads
// memory as a site lowers the flag (JZ_DEBUG_ESC builds): [depth, serials so far, (serial, mark)…].
const OPEN_DEPTH = 64
const open = new Float64Array(2 + 2 * OPEN_DEPTH)

export const resetMarks = () => { counts[0] = 0; counts[2] = 0; counts[3] = 0; for (let i = 0; i < 4; i++) stages[i] = 0; tape[0] = 0; tape[1] = 0; open[0] = 0; open[1] = 0 }
/** A phase checkpoint opens at `mark`: its serial. */
export const openPhase = (mark) => {
  const depth = open[0], serial = open[1] + 1
  open[1] = serial
  if (depth < OPEN_DEPTH) { open[2 + 2 * depth] = serial; open[3 + 2 * depth] = mark }
  open[0] = depth + 1
  return serial
}
export const closePhase = () => { if (open[0] > 0) open[0] = open[0] - 1 }
/** A verdict's record with what it judged by. */
export const recordVerdict = (verdict, mark, esc, durable, serial) => {
  const done = counts[0]
  if (done < counts[1] && done < PHASE_RECORDS) { verdicts[4 * done] = mark; verdicts[4 * done + 1] = esc; verdicts[4 * done + 2] = durable; verdicts[4 * done + 3] = serial }
  recordPhase(verdict)
}
/** What a verdict record judged by (0: its mark, 1: the flag, 2: durable logs held, 3: its serial); 0 for any other record. */
export const verdictAt = (i, k) => i >= 0 && i < recorded() && i === Math.floor(i) && k >= 0 && k < 4 && k === Math.floor(k) ? verdicts[4 * i + k] : 0
/** The address of the open phases' slots, for a host reading them in place. */
export const phaseOpenAddr = () => __ptr_offset(open) >>> 0
export const recordPhase = (name) => {
  const done = counts[0]
  if (done < counts[1] && done < PHASE_RECORDS) { ids[done] = PHASE_IDS.get(name) ?? 0; heaps[done] = __heap_mark() >>> 0 }
  counts[0] = done + 1
}
export const markStage = (stage) => { stages[stage] = __heap_mark() >>> 0 }
export const markTape = (nodes, columns) => { tape[0] = nodes; tape[1] = columns }
/** Start a new recording at an integer capacity; negative/NaN inputs disable it.
 *  Reset so increasing the limit cannot expose slots dropped by the old limit. */
export const setPhaseCapacity = (n) => {
  resetMarks()
  counts[1] = n > 0 ? n >= PHASE_RECORDS ? PHASE_RECORDS : Math.floor(n) : 0
}
export const phaseCapacity = () => counts[1]
export const phasesDone = () => counts[0]
/** A phase checkpoint taken (scripts/self.js checkpointPhase): the phase's result parked, the arena rewound to the phase's mark;
 *  or declined: the phase grew past the threshold but wrote into older storage, or its result cannot be parked. */
export const countCheckpoint = () => { counts[2] = counts[2] + 1 }
export const countDecline = () => { counts[3] = counts[3] + 1 }
export const phaseCheckpoints = () => counts[2]
export const phaseDeclines = () => counts[3]
const recorded = () => counts[0] < counts[1] ? counts[0] : counts[1]
export const phaseNameAt = (i) => i >= 0 && i < recorded() && i === Math.floor(i) ? PHASE_NAMES[ids[i]] : ''
export const phaseHeapAt = (i) => i >= 0 && i < recorded() && i === Math.floor(i) ? heaps[i] : 0
export const stageHeap = (stage) => stage >= 0 && stage < 4 && stage === Math.floor(stage) ? stages[stage] : 0
export const tapeNodes = () => tape[0]
export const tapeCapacity = () => tape[1]
