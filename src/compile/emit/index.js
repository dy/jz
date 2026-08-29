/**
 * Assembles the `emitter` table from every family module's op group, in the
 * original file's own section order. Mirrors src/optimize/vectorize/index.js's
 * role as the split's assembly point, but the job here is pure object-spread,
 * not a dispatch chain — see .work/emit-split.md's "Central deviation" section
 * for why the emitter object couldn't be relocated as one atomic unit.
 *
 * Spread/Object.assign concatenate each source object's own key order, and every
 * AST-op string is used as a key in exactly one family (mutually exclusive
 * dispatch names — no two sections define the same key), so section order below
 * is not behavior-sensitive — kept matching the original file for readability.
 *
 * @module compile/emit/index
 */

import { spreadOp, statementOps } from './statements.js'
import { assignmentOps } from './assignment.js'
import { incdecOps } from './incdec.js'
import { arithmeticOps } from './arithmetic.js'
import { comparisonOps } from './comparisons.js'
import { logicalOps } from './logical.js'
import { bitwiseOps } from './bitwise.js'
import { controlFlowOps } from './control-flow.js'
import { callOps } from './call.js'

// === Core emitter dispatch table ===
// ctx.core.emit is seeded with a flat copy of this object on reset;
// language modules add or override ops on ctx.core.emit directly.

/**
 * Core emitter table. Maps AST ops to WASM IR generators.
 * @type {Record<string, (...args: any[]) => Array>}
 */
export const emitter = {
  ...spreadOp,
  ...statementOps,
  ...assignmentOps,
  ...incdecOps,
  ...arithmeticOps,
  ...comparisonOps,
  ...logicalOps,
  ...bitwiseOps,
  ...controlFlowOps,
  ...callOps,
}
