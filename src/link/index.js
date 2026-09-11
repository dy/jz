/**
 * Link: the assembled module goes onto the IR tape, the body and
 * whole-module passes run, and the module comes back as WAT arrays for
 * watr. Bodies first: the fold and loop rotation, then the low-word mask fold and the arena
 * rewind. Then the module's shape: dead functions and globals go
 * (treeshake), the custom sections the interop layer reads describe what
 * survived, the throw runtime goes when nothing can catch. Then the
 * encoding: locals order by use when watr does not follow to order them,
 * functions by call count, local names lose their scope suffixes.
 *
 * `facts` are the compile's whole-module facts, passed explicitly: the
 * resolved optimize config, the user's function and global names, the
 * rewindable functions and the heap pointer's home, the schema list with
 * its named uses and error classes, and the throw flags.
 *
 * @module link
 */
import { DBG_INVARIANTS } from '../debug.js'
import { resetTape, fromWat, toWat, verify } from '../ir/tape.js'
import { treeshake } from './treeshake.js'
import { schemaSections } from './sections.js'
import { pruneUnusedThrowRuntime } from './throw-runtime.js'
import { orderFuncs } from './order.js'
import { stripLocalRenameSuffixes } from './rename-locals.js'
import { funcs } from '../optimize/fn.js'
import { rotateLoops } from '../optimize/rotate-loops.js'
import { fold } from '../optimize/fold.js'
import { foldLowWordMasks } from '../optimize/low-word-mask.js'
import { arenaRewind } from '../optimize/arena-rewind.js'
import { sortLocalsByUse } from '../optimize/sort-locals.js'


const check = (root, when) => {
  const bad = verify(root)
  if (bad) throw new Error(`[link] module invalid ${when}: ${bad}`)
}

export function link(module, facts) {
  const cfg = facts.optimize
  resetTape()
  const root = fromWat(module)
  if (DBG_INVARIANTS) check(root, 'after decode')
  // Fold before rotation; watr subsequently simplifies the resulting conditions.
  for (const f of funcs(root)) {
    if (!cfg || cfg.fusedRewrite !== false) fold(f)
    if (cfg && cfg.rotateLoops === true) rotateLoops(f)
  }
  if (DBG_INVARIANTS) check(root, 'after the body passes')
  if (!cfg || cfg.fusedRewrite !== false) foldLowWordMasks(root)
  if (!cfg || cfg.arenaRewind !== false) arenaRewind(root, facts)
  const callCount = treeshake(root, { removeDead: !cfg || cfg.treeshake !== false, userFuncs: facts.userFuncs, userGlobals: facts.userGlobals })
  schemaSections(root, facts)
  pruneUnusedThrowRuntime(root, facts)
  // watr's `sortLocals` orders the final body's declarations; the tape orders them only when watr does not run
  if ((!cfg || cfg.sortLocalsByUse !== false) && !(cfg && cfg.watr)) sortLocalsByUse(root)
  orderFuncs(root, callCount)
  stripLocalRenameSuffixes(root)
  if (DBG_INVARIANTS) check(root, 'after link')
  return toWat(root)
}
