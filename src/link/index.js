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
import { stage, walk } from '../optimize/pass-table.js'


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

// Each function's body passes on the tape (the 'bodies' steps of optimize/pass-table.js).
const BODIES = { fold: (f) => fold(f), rotateLoops: (f) => rotateLoops(f) }
const BODY_STEPS = stage('bodies', BODIES)

// Each step of link, `(root, cfg, facts, st)`: `st` holds the phase runner, the arena's
// verdict and the call counts the treeshake leaves.
const LINK = {
  // Fold before rotation; watr subsequently simplifies the resulting conditions.
  bodies: (root, cfg, facts, st) => {
    st.phase(() => { for (const f of funcs(root)) walk(BODY_STEPS, BODIES, cfg, f, facts, null) })
    if (DBG_INVARIANTS) check(root, 'after the body passes')
  },
  // A throw nothing can observe allocates nothing: its helpers reduce before the
  // rewind's proof and the treeshake read their calls.
  reduceThrowHelpers: (root, cfg, facts, st) => st.phase(() => reduceThrowHelpers(root, facts)),
  // The rewind's proof runs at every level (the host's release of a call's
  // argument copies reads it); the rewrite only where the rewind is on.
  arenaRewind: (root, cfg, facts, st) => { st.arena = st.phase(() => arenaRewind(root, facts)) },
  // Compaction (module/core/compact.js) serves a module some call of which may
  // keep memory: one whose every export keeps nothing it made or was handed
  // (a result the host copies is released once copied) drops it.
  dropCompaction: (root, cfg, facts, st) => {
    const arena = st.arena
    if (facts.compact && facts.exportInner && ![...facts.exportInner.values()].some(inner => !arena.releasable.has(inner) || arena.flagged.has(inner)))
      dropExports(root, new Set(facts.compactLoops ? ['"__jz_compact"', '"__jz_g_cost"'] : ['"__jz_compact"', '"__jz_g_cost"', '"__jz_pin"', '"__jz_viewed"']))
  },
  // Which exports keep memory per call: the advisory reads the verdict itself.
  adviseKept: (root, cfg, facts, st) => facts.adviseKept?.(st.arena),
  treeshake: (root, cfg, facts, st) => { st.callCount = st.phase(() => treeshake(root, { removeDead: !cfg || cfg.treeshake !== false, userFuncs: facts.userFuncs, userGlobals: facts.userGlobals })) },
  schemaSections: (root, cfg, facts, st) => st.phase(() => schemaSections(root, facts)),
  releaseSection: (root, cfg, facts, st) => {
    const arena = st.arena
    if (facts.exportInner) st.phase(() => {
      const releases = new Map()
      for (const [name, inner] of facts.exportInner)
        if (arena.allocates(inner) || facts.copiedArgs?.has(name)) releases.set(name, inner)
      releaseSection(root, arena, releases, facts.asked, facts.numberResult)
    })
  },
  pruneThrowRuntime: (root, cfg, facts, st) => st.phase(() => pruneUnusedThrowRuntime(root, facts)),
  // watr's `sortLocals` orders the final body's declarations; the tape orders them only when watr does not run
  sortLocalsByUse: (root, cfg, facts, st) => st.phase(() => sortLocalsByUse(root)),
  orderFuncs: (root, cfg, facts, st) => st.phase(() => orderFuncs(root, st.callCount)),
  renameLocals: (root, cfg, facts, st) => st.phase(() => stripLocalRenameSuffixes(root)),
}
const LINK_STEPS = stage('link', LINK)

/** Link's passes over the module decoded onto the tape at `root`, the tape
 *  left for `toWat` to read back: a walk of the 'link' steps of the pass table
 *  (optimize/pass-table.js). Each pass is a phase where the compiler
 *  hosting the compile asks for one (`facts.phase`, scripts/self.js
 *  checkpointPhase): what a pass made and nothing reaches goes before the
 *  next one runs. */
export function linkPasses(root, facts) {
  if (DBG_INVARIANTS) check(root, 'after decode')
  walk(LINK_STEPS, LINK, facts.optimize, root, facts, { phase: facts.phase ?? (run => run()), arena: null, callCount: null })
  if (DBG_INVARIANTS) check(root, 'after link')
}
