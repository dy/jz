/**
 * Whole-program fact collection — dyn keys, call sites, schema slots.
 * @module program-facts
 */
import { commaList, isFuncRef, isLiteralStr, ASSIGN_OPS, MUTATE_OPS } from '../ast.js'
import { ctx, err, getFactStore, DBG_INVARIANTS } from '../ctx.js'
import { VAL, lookupValType, repOf, updateGlobalRep, KIND_UNIVERSE } from '../reps.js'
import { valTypeOf, nullishArm } from '../kind.js'
import { extractParams, classifyParam, PARAM_KIND, collectAllBoundNames } from '../ast.js'
import { staticObjectProps, objLiteralSchemaId } from '../static.js'
import { intLevelChecker } from '../type.js'
import { typedStorageCtorFromContext } from '../typed-context.js'
import { analyzeBody } from './analyze.js'
import { withValueOverlay } from './flow-state.js'
import { safeReads } from './analyze-scans.js'


import { ARR_RESIZE_METHODS, collectBodyElemSids, effectiveWriteValue } from './program-facts/shared.js'
import { invalidateProgramFactsCache, resetProgramFactsCache } from './program-facts/cache.js'
import { applySlotWriteHazards, collectSlotWriteHazards } from './program-facts/slot-write-hazards.js'
import { observeProgramSlots } from './program-facts/slot-kind-census.js'
import { analyzeSchemaSlotIntCertain } from './program-facts/slot-int-census.js'
import { analyzeParamNeverGrown } from './program-facts/param-never-grown.js'
import { collectProgramFacts, observeNodeFacts } from './program-facts/walk-facts.js'


export { effectiveWriteValue, resetProgramFactsCache, invalidateProgramFactsCache, collectSlotWriteHazards, applySlotWriteHazards, observeProgramSlots, analyzeSchemaSlotIntCertain, analyzeParamNeverGrown, observeNodeFacts, collectProgramFacts }
