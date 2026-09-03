/**
 * The tape stage: the assembled module goes onto the IR tape, the tape
 * passes run, the module comes back as WAT arrays for watr. Runs once per
 * compile, after the last WAT-array pass and before watr; shared by
 * index.js and the self-hosted kernel through `watrTail`.
 *
 * @module optimize/tape
 */
import { resetTape, fromWat, toWat, verify } from '../ir/tape.js'
import { hoistConstantPool } from './const-pool.js'

const DBG = typeof process !== 'undefined' && process.env?.JZ_DEBUG_INVARIANTS === '1'

const check = (root, when) => {
  const bad = verify(root)
  if (bad) throw new Error(`[tape] module invalid ${when}: ${bad}`)
}

/** @param module assembled WAT-array module  @param cfg resolved optimize config */
export function tapeStage(module, cfg) {
  resetTape()
  const root = fromWat(module)
  if (DBG) check(root, 'after decode')
  if (!cfg || cfg.hoistConstantPool !== false) hoistConstantPool(root)
  if (DBG) check(root, 'after passes')
  return toWat(root)
}
