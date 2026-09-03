/**
 * Link: the assembled module goes onto the IR tape, the whole-module passes
 * run, and the module comes back as WAT arrays for watr. In order: dead
 * functions and globals go (treeshake), the custom sections the interop
 * layer reads describe what survived, the throw runtime goes when nothing
 * can catch, functions order by call count, local names lose their scope
 * suffixes, repeated literals pool into globals.
 *
 * `facts` are the compile's whole-module facts, passed explicitly: the
 * resolved optimize config, the user's function and global names, the
 * schema list with its named uses and error classes, and the throw flags.
 *
 * @module link
 */
import { resetTape, fromWat, toWat, verify } from '../ir/tape.js'
import { treeshake } from './treeshake.js'
import { schemaSections } from './sections.js'
import { pruneUnusedThrowRuntime } from './throw-runtime.js'
import { orderFuncs } from './order.js'
import { stripLocalRenameSuffixes } from './rename-locals.js'
import { hoistConstantPool } from '../optimize/const-pool.js'

const DBG = typeof process !== 'undefined' && process.env?.JZ_DEBUG_INVARIANTS === '1'

const check = (root, when) => {
  const bad = verify(root)
  if (bad) throw new Error(`[link] module invalid ${when}: ${bad}`)
}

export function link(module, facts) {
  const cfg = facts.optimize
  resetTape()
  const root = fromWat(module)
  if (DBG) check(root, 'after decode')
  const callCount = treeshake(root, { removeDead: !cfg || cfg.treeshake !== false, userFuncs: facts.userFuncs, userGlobals: facts.userGlobals })
  schemaSections(root, facts)
  pruneUnusedThrowRuntime(root, facts)
  orderFuncs(root, callCount)
  stripLocalRenameSuffixes(root)
  if (!cfg || cfg.hoistConstantPool !== false) hoistConstantPool(root)
  if (DBG) check(root, 'after link')
  return toWat(root)
}
