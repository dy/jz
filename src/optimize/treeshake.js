/**
 * Whole-module dead-code elimination — invoked from src/wat/assemble.js.
 *
 * @module optimize/treeshake
 */
import { walkAst } from '../ast.js'

/**
 * Dead-code elimination: remove func decls not reachable from any entry point.
 * Roots: `(start $X)`, `(export "n" (func $X))`, `(elem … $X …)`, `(ref.func $X)`.
 * Iteratively adds funcs called from reachable ones. Mutates arrays in place.
 * Typical win: watr's optimize.js has orphan top-level consts (e.g. `hoist` = 26 KB).
 *
 * @param funcSections — array of { arr, isStartContainer? }. Each `arr` holds func IR nodes
 *                       (may be interleaved with other nodes like `(start $X)` for sec.start).
 * @param allModuleNodes — flat iterable of all module-level nodes for root discovery
 *                          (exports, elem, start directive are elsewhere than funcSections).
 * @param opts — optional `{ removeDead: bool }`. When `removeDead` is false, the
 *               reachability walk still runs (so `callCount` is populated for the
 *               funcidx sort downstream) but unreachable funcs are kept. Default true.
 */
export function treeshake(funcSections, allModuleNodes, opts) {
  const removeDead = !opts || opts.removeDead !== false
  const funcByName = new Map()
  const allFuncs = []
  for (const { arr } of funcSections)
    for (const n of arr)
      if (Array.isArray(n) && n[0] === 'func') {
        allFuncs.push(n)
        if (typeof n[1] === 'string') funcByName.set(n[1], n)
      }

  const reachable = new Set()
  const stack = []
  const addRoot = (name) => { if (funcByName.has(name) && !reachable.has(name)) { reachable.add(name); stack.push(name) } }

  // Named funcs with inline `(export "name")` are module-export roots.
  for (const [name, fn] of funcByName)
    for (let i = 2; i < fn.length; i++)
      if (Array.isArray(fn[i]) && fn[i][0] === 'export') { addRoot(name); break }

  // When user funcs are NOT being reclaimed (O0/O1 keep declared-but-uncalled ones), they
  // all survive — so they're roots for the *internal*-func reachability below. Otherwise an
  // unreachable user func that's kept would still call a `__helper`, yet that helper would be
  // pruned as unreached-from-exports, leaving a dangling `call $__helper`.
  if (!removeDead && opts && opts.userFuncs)
    for (const name of opts.userFuncs) addRoot(name)

  const findRoots = (node) => {
    if (node[0] === 'start' && typeof node[1] === 'string') addRoot(node[1])
    else if (node[0] === 'export' && Array.isArray(node[2]) && node[2][0] === 'func') addRoot(node[2][1])
    else if (node[0] === 'elem') for (const c of node) if (typeof c === 'string' && c.startsWith('$')) addRoot(c)
  }
  for (const n of allModuleNodes) walkAst(n, { enter: findRoots })

  // Side-output: per-callee call counts over all reachable + anonymous funcs.
  // Caller uses this to sort funcs by hotness for low-LEB128-funcidx packing.
  // Counting here is free — we already visit every node in these funcs.
  const callCount = new Map()
  const CALL_OPS = new Set(['call', 'return_call', 'ref.func'])
  const recordCall = node => {
    if (!Array.isArray(node) || !CALL_OPS.has(node[0]) || typeof node[1] !== 'string') return
    addRoot(node[1])
    if (node[0] === 'call' || node[0] === 'return_call')
      callCount.set(node[1], (callCount.get(node[1]) || 0) + 1)
  }
  // Anonymous funcs can't be pruned (no name) — walk them to seed roots.
  for (const fn of allFuncs) if (typeof fn[1] !== 'string') walkAst(fn, { enter: recordCall })
  while (stack.length) walkAst(funcByName.get(stack.pop()), { enter: recordCall })

  // Compiler-internal funcs (stdlib helpers, allocator wrappers — everything not in the
  // user's own `ctx.funcs.list`) carry no source meaning, so an unreachable one is reclaimed
  // at EVERY opt level: it's never a live-coding aid, just over-production (e.g. `s + '!'`
  // pulls the alloc trio's `__alloc_hdr`, which string concat never calls, and a dead-branch
  // dep like `__str_len`). User funcs are reclaimed only when DCE is on, so O0/O1 keep a
  // declared-but-uncalled user function. Absent the set, fall back to gating everything.
  const userFuncs = opts && opts.userFuncs
  const isUserFunc = (name) => userFuncs ? userFuncs.has(name) : true
  let removed = 0
  if (removeDead || userFuncs) {
    for (const { arr } of funcSections) {
      for (let i = arr.length - 1; i >= 0; i--) {
        const n = arr[i]
        if (Array.isArray(n) && n[0] === 'func' && typeof n[1] === 'string' && !reachable.has(n[1]) &&
            (removeDead || !isUserFunc(n[1]))) {
          arr.splice(i, 1); removed++
        }
      }
    }
  }

  // Dead-global elimination: drop `(global $g …)` decls that nothing references
  // (a `global.get`/`global.set` in a remaining func, a kept global's init expr, a
  // data/elem offset, or an `(export … (global $g))`). Imported globals live in
  // `allModuleNodes`, not in `opts.globals`, so they're never touched. Fixpoint: a
  // kept global's init may reference another global.
  //
  // Compiler-internal globals (support state the user never wrote — e.g. core's
  // `__heap_start` or the math module's `rng_state`, declared eagerly but read
  // only by specific fast paths) are reclaimed at *every* level: leaving an
  // unreferenced one in the output is pure noise, never a live-coding aid. User
  // globals are reclaimed only when DCE is on, so O0/O1 still preserve declared-
  // but-unused user bindings. `userGlobals` (names sans `$`) draws the line; absent
  // it, fall back to the `$__` reserved-prefix heuristic.
  const userGlobals = opts && opts.userGlobals
  const isUserGlobal = (name) => userGlobals ? userGlobals.has(name.slice(1)) : !name.startsWith('$__')
  const globals = opts && Array.isArray(opts.globals) ? opts.globals : null
  if (globals) {
    const collectGlobalRefs = (node, refd) => {
      walkAst(node, { enter: n => {
        if ((n[0] === 'global.get' || n[0] === 'global.set') && typeof n[1] === 'string') refd.add(n[1])
        else if (n[0] === 'export' && Array.isArray(n[2]) && n[2][0] === 'global' && typeof n[2][1] === 'string') refd.add(n[2][1])
      } })
    }
    let changed = true
    while (changed) {
      changed = false
      const refd = new Set()
      for (const { arr } of funcSections) for (const n of arr) collectGlobalRefs(n, refd)
      for (const n of allModuleNodes) collectGlobalRefs(n, refd)
      for (const g of globals) collectGlobalRefs(g, refd)
      for (let i = globals.length - 1; i >= 0; i--) {
        const g = globals[i]
        if (!Array.isArray(g) || g[0] !== 'global' || typeof g[1] !== 'string' || refd.has(g[1])) continue
        // An inline `(export …)` on the decl pins it — it's part of the module's
        // JS-host surface (e.g. `__heap`), referenced from outside the wasm.
        if (g.some(c => Array.isArray(c) && c[0] === 'export')) continue
        if (removeDead || !isUserGlobal(g[1])) { globals.splice(i, 1); changed = true }
      }
    }
  }

  return { removed, callCount }
}
