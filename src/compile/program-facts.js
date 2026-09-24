/** Program-wide call sites, write hazards, slot ranges and literal tags.
 * Value kinds and container contents belong to the program summary. */
export { observeNodeFacts, collectProgramFacts, synthesizeComputedDispatchCallSites, synthesizeMemberDispatchCallSites } from './program-facts/walk-facts.js'
export { invalidateProgramFactsCache } from './program-facts/cache.js'
export { collectSlotConstants } from './program-facts/slot-constants.js'
export { analyzeSchemaSlotIntCertain } from './program-facts/slot-int-census.js'
export { collectSlotWriteHazards } from './program-facts/slot-write-hazards.js'
export { analyzeParamNeverGrown } from './program-facts/param-never-grown.js'
export { readonlyParamReps, freezeCallSites, assertProgramFactsShape } from './program-facts/freeze.js'
