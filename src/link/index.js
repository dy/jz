/**
 * Link: the assembled module goes onto the IR tape, the body and
 * whole-module passes run, and the module comes back as WAT arrays for
 * watr. Bodies first: the fold and loop rotation, then the arena rewind.
 * Then the module's shape: dead functions and globals go (treeshake), the
 * custom sections the interop layer reads describe what survived, the
 * throw runtime goes when nothing can catch. Then the
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
import { resetTape, fromWat, toWat, verify, T, NONE, intern, text, remove } from '../ir/tape.js'
import { treeshake } from './treeshake.js'
import { schemaSections, releaseSection } from './sections.js'
import { pruneUnusedThrowRuntime, reduceThrowHelpers } from './throw-runtime.js'
import { orderFuncs } from './order.js'
import { stripLocalRenameSuffixes } from './rename-locals.js'
import { funcs } from '../optimize/fn.js'
import { rotateLoops } from '../optimize/rotate-loops.js'
import { fold } from '../optimize/fold.js'
import { arenaRewind } from '../optimize/arena-rewind.js'
import { sortLocalsByUse } from '../optimize/sort-locals.js'


const check = (root, when) => {
  const bad = verify(root)
  if (bad) throw new Error(`[link] module invalid ${when}: ${bad}`)
}

/** Remove the inline exports named in `names` (quoted) from the functions and globals that carry them. */
function dropExports(root, names) {
  const FUNC = intern('func'), GLOBAL = intern('global'), EXPORT = intern('export')
  for (let c = T.a[root]; c !== NONE; c = T.next[c]) {
    if (T.op[c] !== FUNC && T.op[c] !== GLOBAL) continue
    for (let e = T.a[c]; e !== NONE; e = T.next[e]) if (T.op[e] === EXPORT && names.has(text(T.a[e]))) { remove(c, e); break }
  }
}

export function link(module, facts) {
  resetTape()
  return linkTape(fromWat(module), facts)
}

/** Link the module already decoded onto the tape at `root`. */
export const linkTape = (root, facts) => { linkPasses(root, facts); return toWat(root) }

/** Link's passes over the module decoded onto the tape at `root`, the tape
 *  left for `toWat` to read back. Each pass is a phase where the compiler
 *  hosting the compile asks for one (`facts.phase`, scripts/self.js
 *  checkpointPhase): what a pass made and nothing reaches goes before the
 *  next one runs. */
export function linkPasses(root, facts) {
  const cfg = facts.optimize, phase = facts.phase ?? (run => run())
  if (DBG_INVARIANTS) check(root, 'after decode')
  // Fold before rotation; watr subsequently simplifies the resulting conditions.
  phase(() => {
    for (const f of funcs(root)) {
      if (!cfg || cfg.fusedRewrite !== false) fold(f)
      if (cfg && cfg.rotateLoops === true) rotateLoops(f)
    }
  })
  if (DBG_INVARIANTS) check(root, 'after the body passes')
  // A throw nothing can observe allocates nothing: its helpers reduce before the
  // rewind's proof and the treeshake read their calls.
  phase(() => reduceThrowHelpers(root, facts))
  // The rewind's proof runs at every level (the host's release of a call's
  // argument copies reads it); the rewrite only where the rewind is on.
  const rewind = !cfg || cfg.arenaRewind !== false
  const arena = phase(() => arenaRewind(root, { ...facts, rewrite: rewind }))
  // Compaction (module/core/compact.js) serves a module some call of which may
  // keep memory: one whose every export keeps nothing it made or was handed
  // (a result the host copies is released once copied) drops it.
  if (facts.compact && facts.exportInner && ![...facts.exportInner.values()].some(inner => !arena.releasable.has(inner) || arena.flagged.has(inner)))
    dropExports(root, new Set(facts.compactLoops ? ['"__compact"', '"__g_cost"'] : ['"__compact"', '"__g_cost"', '"__pin"', '"__viewed"']))
  // Which exports keep memory per call: the advisory reads the verdict itself.
  if (rewind) facts.adviseKept?.(arena)
  const callCount = phase(() => treeshake(root, { removeDead: !cfg || cfg.treeshake !== false, userFuncs: facts.userFuncs, userGlobals: facts.userGlobals }))
  phase(() => schemaSections(root, facts))
  if (facts.exportInner) phase(() => {
    const releases = new Map()
    for (const [name, inner] of facts.exportInner)
      if (arena.allocates(inner) || facts.copiedArgs?.has(name)) releases.set(name, inner)
    releaseSection(root, arena, releases, facts.asked, facts.numberResult)
  })
  phase(() => pruneUnusedThrowRuntime(root, facts))
  // watr's `sortLocals` orders the final body's declarations; the tape orders them only when watr does not run
  if ((!cfg || cfg.sortLocalsByUse !== false) && !(cfg && cfg.watr)) phase(() => sortLocalsByUse(root))
  phase(() => orderFuncs(root, callCount))
  phase(() => stripLocalRenameSuffixes(root))
  if (DBG_INVARIANTS) check(root, 'after link')
}
