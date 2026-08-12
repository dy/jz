/**
 * The final-optimizer tail, shared VERBATIM by the host pipeline (index.js)
 * and the self-host kernel (scripts/self.js): watr option construction +
 * the single post-watr proof repair. One module so the two pipelines cannot
 * drift — the kernel previously duplicated a subset of the option logic and
 * omitted ifset tiering, inlineWrappers, watr LICM, the size-guard policy,
 * the large-module unroll2 rule, boundary pins, and the pointer repair,
 * so kernel O2/O3 output diverged from native on the same source.
 *
 * Cycle-free: imports only watr and src/optimize (no index.js, no ctx-heavy
 * compile modules) — safe for the kernel's minimal module graph.
 *
 * @module optimize/watr-tail
 */
import watOptimize from 'watr/optimize'
import {
  SIMD_PINNED, collectReachableGlobalWrites, hoistGlobalPtrOffset, stablePtrGlobalNames,
} from './index.js'

/**
 * Compute the watr optimizer options for a resolved jz `optimize` config (see
 * `resolveOptimize`) — the single source of truth for "which watr passes does THIS
 * jz tier ask for". A caller that already holds a resolved cfg (e.g.
 * scripts/audit-fixpoint.mjs, re-running watr on jz's own output to check
 * idempotence) builds the IDENTICAL options jz's own pipeline used, instead
 * of drifting to watr's bare defaults — which lean size (outline/tailmerge/rettail
 * ON) and would misreport a deliberate speed-tier trade as a missed rewrite.
 * `funcCount`/`boundaryPins` are the two refinements that need live compile ctx
 * (module function count, JS-boundary vectorized fn names) — omit them for a
 * cfg-only approximation (fine for small/synthetic corpora).
 * @returns {Object|false} watr options, or `false` when `cfg.watr` is off.
 */
export function resolveWatrOpts(cfg, { funcCount = 0, boundaryPins = [] } = {}) {
  if (!cfg.watr) return false
  let watrOpts = typeof cfg.watr === 'object' ? { ...cfg.watr } : true
  if (cfg.vectorizeLaneLocal) {
    // Off at the speed tier: watr's loopify collapses the while-idiom to
    // `loop { if C { …; br } }` (an UNfused back-jump — no win) AND would mangle the
    // lane-vectorizer's loop shape. jz's own `rotateLoops` (optimize/index.js, post
    // phase) does the rotation instead, emitting the FUSED `br_if $loop C` back-edge.
    if (watrOpts === true) watrOpts = { loopify: false }
    else if (typeof watrOpts === 'object' && watrOpts.loopify === undefined) watrOpts.loopify = false
  }
  if (cfg.devirtIndirect) {
    if (watrOpts === true) watrOpts = { devirt: true }
    else if (typeof watrOpts === 'object' && watrOpts.devirt === undefined) watrOpts.devirt = true
  }
  // Multi-caller small-function inlining (size-for-speed): on at the 'speed'/level-3
  // tier only, like devirt above. Removes call overhead from hot inner loops at the
  // cost of duplicating tiny bodies; level 2 (and the size budgets measured there)
  // stay untouched.
  if (cfg.inlineFns) {
    if (watrOpts === true) watrOpts = { inline: 'simd' }
    else if (typeof watrOpts === 'object' && watrOpts.inline === undefined) watrOpts.inline = 'simd'
  }
  // Wrapper elision (speed tier): dissolve adapter frames — closure-ABI
  // trampolines for functions-as-values, thin dispatch heads like
  // __dyn_get_expr — into their target at the wrapper site. The recorded
  // "table entries native against ftN" restructure, done mechanically in the
  // optimizer instead of per-case emit surgery (one wrapper = one duplicated
  // target; treeshake collects whichever copy ends up unreferenced).
  if (cfg.inlineFns) {
    if (typeof watrOpts === 'object' && watrOpts.inlineWrappers === undefined) watrOpts.inlineWrappers = true
  }
  // watr LICM (speed tier): hoist loop-invariant pure arithmetic AFTER watr's inlining exposes it
  // (the raytrace per-iteration NaN/Inf guard pairs). Mechanical — lives in watr, jz just enables it.
  if (cfg.watrLicm) {
    if (watrOpts === true) watrOpts = { licm: true }
    else if (typeof watrOpts === 'object' && watrOpts.licm === undefined) watrOpts.licm = true
  }
  // guardRefine folds jz's NaN-box tag reads — default-off in watr (general WAT
  // never matches it), so jz always enables it explicitly.
  if (watrOpts === true) watrOpts = { guardRefine: true }
  else if (typeof watrOpts === 'object' && watrOpts.guardRefine === undefined) watrOpts.guardRefine = true
  // watr's ifset (one-armed conditional update → select) rides jz's select
  // tiering: an unconditional-update trade belongs to the speed tier exactly
  // like boolConvertToSelect. jz's DEFAULT tier also passes watrProfile:'speed'
  // (for the outline/tailmerge shape), which would enable ifset via the
  // profile — the explicit flag here overrides it in both directions.
  if (typeof watrOpts === 'object' && watrOpts.ifset === undefined)
    watrOpts.ifset = cfg.boolConvertToSelect === true || cfg.watrIfset === true
  // jz's promise is runtime speed, but watr's OWN profile default leans size — outline/
  // tailmerge/rettail fold repeated sequences into out-of-line calls (measured 1.433→1.316
  // on the self-host kernel with them off, watr ≥5.2.0). Every speed-tier preset carries
  // watrProfile:'speed' (src/optimize/index.js LEVEL_PRESETS); the 'size' preset keeps
  // watr's size-leaning default. An explicit user profile always wins.
  if (watrOpts.profile === undefined && cfg.watrProfile) watrOpts.profile = cfg.watrProfile
  // Speed tier waives watr's size-revert guard (two full binary encodes per
  // optimize — its costliest fixed overhead): inlining growth is the shape this
  // tier asks for, and jz's own perf/size gates own the size budget. Level 2
  // (default) and 'size' keep the guard — watr's never-inflate contract stands
  // where the user didn't opt into speed-for-size.
  if (watrOpts.guard === undefined && cfg.watrGuard === false) watrOpts.guard = false
  // Pin jz's scalar transcendentals (the PPC_CALL2 keys the auto-vectorizer rewrites to f64x2
  // mirrors) so watr's inline passes don't dissolve the call nodes the lift needs. The protection
  // policy lives here in jz — watr just honours the `pin` list (no jz names hardcoded in watr).
  if (watrOpts === true) watrOpts = {}
  watrOpts.pin = watrOpts.pin ? [...watrOpts.pin, ...SIMD_PINNED] : SIMD_PINNED
  // Partial unrolling overlaps branch latency in compact codecs, but duplicates
  // too many cold compiler/parser loops in large module graphs and loses the
  // warm self-host I-cache race. Users may still opt in explicitly.
  if (watrOpts.unroll2 == null && funcCount > 64) watrOpts.unroll2 = false
  // Keep only JS-boundary vectorized functions intact: their `$name$exp`
  // wrapper must not swallow the body/markers structural host tests inspect.
  // Internal lifted helpers remain inlineable — SIMD survives the splice,
  // while caller-level constant propagation and hot-call removal become live.
  if (boundaryPins.length) watrOpts.pin = [...watrOpts.pin, ...boundaryPins]
  return watrOpts
}

/**
 * Find a `['func', …]` node by its `$name` (the name lives at index 1 when the func
 * is named; a raw-WAT stdlib func like module/core.js's `_alloc`/`_clear` has no
 * name — index 1 is its `['export', …]` node directly instead).
 */
function findFuncByName(module, name) {
  return module.find(n => Array.isArray(n) && n[0] === 'func' && n[1] === name)
}

/** True when `funcNode` declares any wasm param — the () -> () command-entry rewrite
 *  skips parametric entries (a CLI invocation has no way to supply args). */
function hasParams(funcNode) {
  return funcNode.some(n => Array.isArray(n) && n[0] === 'param')
}

/**
 * Insert a newly-legalized func node at the position it would hold had it been
 * pushed to `sec.funcs` in src/compile/index.js's `compile()` — immediately after
 * every already-compiled user/closure func and immediately before whichever comes
 * first, in the now-assembled/sorted tree, of: a pullStdlib raw-WAT func (unnamed —
 * `_alloc`/`_clear` from module/core.js, pulled in by `compile()` strictly AFTER
 * where this rewrite used to run) or `$__start` (always last into the pre-sort
 * array, via the `sortedFuncs` concat in `compile()`). Both are zero-call-count
 * ties under the `byCalls` sort (nothing `call`s an export-only leaf), and
 * `Array.prototype.sort` is stable, so a zero-tied node keeps its PRE-sort
 * insertion order — landing it here reproduces the exact func-section byte
 * position `compile()` used to give it, confirmed against the WASI test corpus
 * (see this function's caller's doc comment for the verification method).
 */
function insertLikeCompileFuncsPush(module, funcNode) {
  const first = module.findIndex(n => Array.isArray(n) && n[0] === 'func')
  if (first === -1) { module.push(funcNode); return }
  let i = first
  while (i < module.length && Array.isArray(module[i]) && module[i][0] === 'func') {
    const name = module[i][1]
    if (typeof name !== 'string' || name === '$__start') break
    i++
  }
  module.splice(i, 0, funcNode)
}

// Command-mode export names iterated in this fixed order when a source exports both
// — src/compile/index.js used to walk `Object.entries(ctx.funcs.exports)` (source
// declaration order); no WASI test declares both `run` and `_start` as aliases of the
// same target, so this fixed order is an intentional, disclosed narrowing (see
// legalizeForTarget's doc comment), not a rediscovery of that removed ctx read.
const WASI_COMMAND_ENTRIES = ['run', '_start']

/**
 * WASI command-mode export legalization: `run`/`_start` must export as `() -> ()` —
 * wasmtime/wasmer reject f64-returning functions under those names. Ported from
 * src/compile/index.js's (removed) pre-assembly rewrite onto the assembled tree:
 * finds the target func by name instead of mutating `sec.funcs` in place. The
 * target is discovered structurally, not via `ctx.funcs.exports` — a direct
 * `export let run = …` shows up as an inline `['export', '"run"']` on the func
 * node itself; `export { main as run }` shows up as a customs alias entry
 * `['export', '"run"', ['func', '$main']]` (src/compile/index.js's "Named export
 * aliases" loop, which no longer skips WASI entries — see its updated comment).
 */
function legalizeCommandEntries(module) {
  for (const exportName of WASI_COMMAND_ENTRIES) {
    const wantExport = `"${exportName}"`
    let targetName = null
    let removeExport = null // () => void — strips whatever currently carries `wantExport`

    // Direct: `export let run = …` / `export function run() {…}` — inline export on the func itself.
    for (let i = 1; i < module.length; i++) {
      const n = module[i]
      if (!Array.isArray(n) || n[0] !== 'func') continue
      const expIdx = n.findIndex(x => Array.isArray(x) && x[0] === 'export' && x[1] === wantExport)
      if (expIdx === -1) continue
      targetName = typeof n[1] === 'string' ? n[1] : null
      removeExport = () => n.splice(expIdx, 1)
      break
    }
    // Alias: `export { main as run }` — a customs entry pointing at the real func.
    if (targetName === null) {
      const idx = module.findIndex(n => Array.isArray(n) && n[0] === 'export' &&
        n[1] === wantExport && Array.isArray(n[2]) && n[2][0] === 'func')
      if (idx !== -1) {
        targetName = module[idx][2][1]
        removeExport = () => module.splice(idx, 1)
      }
    }
    if (targetName === null) continue

    // Call through the JS-boundary `$name$exp` wrapper when one exists (it carries the
    // real JS arity — a closure-convention `$name` would always show 0 params). Fall
    // back to `$name` directly for a non-boundary-wrapped export.
    const expFunc = findFuncByName(module, `${targetName}$exp`)
    const inner = expFunc ? `${targetName}$exp` : targetName
    const innerFunc = expFunc || findFuncByName(module, targetName)
    if (!innerFunc || hasParams(innerFunc)) continue // parametric entries keep their direct f64 export

    removeExport()
    insertLikeCompileFuncsPush(module,
      ['func', `$${exportName}$wasi`, ['export', wantExport], ['drop', ['call', inner]]])
  }
}

/**
 * WASI reactor `_initialize` conversion: the p1 ABI forbids WASI calls inside the wasm
 * `start` section (no host can service `fd_write` etc. before `new WebAssembly.Instance`
 * finishes wiring memory — a top-level console.log/Date.now crashed with "Cannot read
 * properties of null"). Ships module init as the `_initialize` export instead, self-armed
 * from every other export via a `$__init_done` once-guard (a raw-instance embedder that
 * never calls `_initialize` — wasmtime does; a bare `new WebAssembly.Instance` doesn't —
 * must still see seeded state). Ported from src/compile/index.js's (removed) late-`compile()`
 * rewrite onto the assembled tree: finds `$__start` by name instead of reading `sec.start`.
 *
 * Must run AFTER legalizeCommandEntries in the same legalizeForTarget call (matching the
 * original in-`compile()` ordering) — its guard-injection loop below has to see any
 * `$run$wasi`/`$_start$wasi` wrapper already in the tree so those self-arm too.
 */
function legalizeReactorInit(module) {
  const sFn = findFuncByName(module, '$__start')
  if (!sFn) return

  let at = 2
  while (at < sFn.length && Array.isArray(sFn[at]) && sFn[at][0] === 'local') at++
  sFn.splice(at, 0,
    ['if', ['global.get', '$__init_done'], ['then', ['return']]],
    ['global.set', '$__init_done', ['i32.const', 1]])
  sFn.splice(2, 0, ['export', '"_initialize"'])

  const startDirIdx = module.findIndex(n => Array.isArray(n) && n[0] === 'start')
  if (startDirIdx !== -1) module.splice(startDirIdx, 1)

  // REACTOR self-arming: every OTHER exported function ensures init ran first (`$__start`
  // guards itself via the once-check spliced in above, not this call-guard — visiting it
  // here too would splice a self-call into its own body).
  for (const f of module) {
    if (!Array.isArray(f) || f[0] !== 'func' || f === sFn) continue
    if (!f.some(x => Array.isArray(x) && x[0] === 'export')) continue
    let g = 2
    while (g < f.length && Array.isArray(f[g]) &&
      (f[g][0] === 'export' || f[g][0] === 'param' || f[g][0] === 'result' || f[g][0] === 'local')) g++
    f.splice(g, 0, ['if', ['i32.eqz', ['global.get', '$__init_done']], ['then', ['call', '$__start']]])
  }

  // `$__init_done` — appended after the existing globals in the original flow
  // (`sec.globals.push`, before assembly); insert right before the func region here,
  // which is the same position (globals immediately precede funcs in `sections`).
  const firstFunc = module.findIndex(n => Array.isArray(n) && n[0] === 'func')
  module.splice(firstFunc, 0, ['global', '$__init_done', ['mut', 'i32'], ['i32.const', 0]])
}

/**
 * Target legalization (audit P1, TargetProfile stage): the seam for module-level,
 * target-conditional rewrites — the fully assembled `['module', …]` tree, right
 * before watr's fixpoint runs — keyed off a TargetProfile (src/session.js
 * targetProfileFor), not a raw host string. Called unconditionally from watrTail
 * below, on both pipelines, so a future rewrite lands once here instead of being
 * re-derived per call site.
 *
 * Ports the two WASI-only, module-level rewrites the site inventory found (grepping
 * every `ctx.transform.host` read, ~24 sites): legalizeCommandEntries (`run`/`_start`
 * as `() -> ()`) and legalizeReactorInit (`start` → `_initialize`). Both used to run
 * inside src/compile/index.js's `compile()`, mutating the pre-assembly `sec.funcs`/
 * `sec.start` — one BEFORE `optimizeModule`+treeshake+the funcidx `byCalls` sort, one
 * between treeshake and that sort. Relocating them here is a real pipeline-order
 * change (this file's own `snapshotInit` placement comment in index.js declines a
 * structurally identical reorder for the same reason: moving a target-conditional
 * rewrite across `optimizeModule` or the final sort changes what those passes
 * observe, not merely where the code lives) — resolved per rewrite:
 *
 *   - legalizeReactorInit never adds/removes a func node and never touches a local
 *     (only a global + call-instructions), and in the ORIGINAL pipeline already ran
 *     AFTER treeshake's callCount computation and AFTER optimizeModule — so `compile()`
 *     never observed its output there either. The `byCalls` sort's stable ties are
 *     computed from a Map lookup keyed by name, unaffected by body mutations. Nothing
 *     it does can change a single byte of what optimizeModule, treeshake, or the sort
 *     produce — verified by direct comparison, not merely argued (see below).
 *   - legalizeCommandEntries DOES add new func nodes (the wrapper) that used to
 *     participate in the `byCalls` sort as zero-call-count ties — moving it here
 *     means that sort has already run. insertLikeCompileFuncsPush (above)
 *     reconstructs the same tie position from the invariant that ties preserve
 *     PRE-sort insertion order and the wrapper was always inserted immediately after
 *     the compiled user/closure funcs, before anything `compile()` pushes later
 *     (pullStdlib's raw-WAT funcs, `$__start`).
 *
 * Byte-identity is the actual arbiter, not this argument: verified by hashing
 * compiled .wasm/.wat for the full test/wasi.js source corpus (command/reactor/
 * alias/parametric/mixed-export/fs/optimize-tier variants) before and after this
 * function grew real behavior — all hashes match. `test:wasi` (40/40) stays green.
 */
export function legalizeForTarget(module, targetProfile) {
  if (!targetProfile?.commandEntry) return module
  legalizeCommandEntries(module)
  legalizeReactorInit(module)
  return module
}

/**
 * Run the whole final-optimizer tail on an assembled `['module', …]` tree:
 * target legalization, then watr (the sole generic fixpoint, exactly once),
 * then the one narrow post-watr proof repair. See index.js's call-site comments
 * for why the repair exists (watr's inliner can merge stable-pointee decodes
 * into one caller past the multi-site hoist threshold) and why there is NO
 * post-watr generic optimizer. `time` is the host profiler hook; the kernel
 * passes none. `targetProfile` (src/session.js targetProfileFor) is threaded
 * through from both callers so a real legalization can consult it once landed.
 */
export function watrTail(module, cfg, { funcCount = 0, boundaryPins = [], time = (n, f) => f(), targetProfile, regionHooks } = {}) {
  const legalized = legalizeForTarget(module, targetProfile)
  const watrOpts = resolveWatrOpts(cfg, { funcCount, boundaryPins })
  // Region-arena Slice 1 (.work/research.md §Region arena): per-round mark/exit around
  // watOptimize's fixpoint round loop, ON for kernel/self-host compiles only. The
  // ONLY caller that ever passes `regionHooks` is scripts/self.js's optimizeTail —
  // that file is NEVER imported/run as native JS (it's fed to jz's compiler purely
  // as source text, to become dist/jz.wasm), so its literal `__region_mark()`/
  // `__region_exit()` calls only ever exist as compiled wasm calls, never as bare
  // native identifiers. index.js's host pipeline (native compiles) never supplies
  // regionHooks, so `watrOpts.regionMark`/`regionExit` stay unset there — watr's
  // own `opts.regionMark?.()` hook (additive, opt-in, see node_modules/watr) is
  // then simply never invoked, zero behavior change for the native path.
  if (watrOpts && regionHooks) { watrOpts.regionMark = regionHooks.mark; watrOpts.regionExit = regionHooks.exit }
  const optimized = watrOpts ? time('watOptimize', () => watOptimize(legalized, watrOpts)) : legalized
  if (cfg.hoistGlobalPtrOffset !== false) {
    const funcs = optimized.filter(node => Array.isArray(node) && node[0] === 'func')
    const stableGlobals = stablePtrGlobalNames()
    if (stableGlobals.size) {
      const reach = collectReachableGlobalWrites(funcs)
      for (const node of funcs) hoistGlobalPtrOffset(node, stableGlobals, reach)
    }
  }
  return optimized
}
