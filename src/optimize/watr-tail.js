import { foldWrappedWords, narrowBoxedLocals, narrowFlagLocals } from './int-narrow.js'
/**
 * The final-optimizer tail, shared VERBATIM by the host pipeline (index.js)
 * and the self-compile kernel (scripts/self.js): watr option construction +
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
import { shareSplitSlots } from './split-slots.js'
import watOptimize, { vacuum, mergeBlocks, propagate, mergeLocals, coalesceLocals, localReuse, bool, conditions, poolConstants } from 'watr/optimize'
import { ctx } from '../ctx.js'
import { constWords, hexHalf } from '../static-data.js'
import {
  SIMD_PINNED, LANE_PINS, collectReachableGlobalWrites, hoistGlobalPtrOffset,
} from './index.js'
import { pureKernel } from './pure-funcs.js'
import { guardToInt32 } from './to-int32.js'
import { poolFloatConstants } from './pool-floats.js'
import { selectBits } from './select-bits.js'
import { unsignedDivision } from './unsigned-div.js'
import { unrollTrips } from './unroll-trips.js'
import { hoistVectorConsts } from './vectorize/hoist-consts.js'
import { truncChoice } from './trunc-choice.js'
import { constBases } from './const-bases.js'
import { selectArms } from './select-arms.js'
import { shareQuotients } from './share-quotients.js'
import { maskOperands } from './mask-operands.js'
import { searchLoops } from './search-loops.js'
import { leadGathers } from './lead-gathers.js'
import { skipLatches } from './skip-latches.js'
import { guardExtremes } from './extreme-guards.js'
import { hoistStillLoads } from './still-loads.js'
import { pairTests } from './pair-tests.js'
import { foldTestedChoices } from './tested-choices.js'
import { carryStores } from './carry-stores.js'
import { pointerExits } from './pointer-exits.js'
import { jumpPointers } from './jump-pointers.js'
import { ringLaps } from './ring-laps.js'
import { leadChains } from './lead-chains.js'
import { issueOrder } from './issue-order.js'
import { splitFuncs, loopPasses } from './split-funcs.js'
import { inlineTiny } from './inline-tiny.js'
import { forwardCheckedElements } from './forward-checked.js'

// A runtime helper's cold half, split off so the engine inlines the hot head
// (module/core.js `__rem`, its long division `__rem_div`; the element heads,
// layout.js numTypedWat, the length dispatchers', `__str_eq`'s and a record
// store's, module/collection/record.js): the single-caller inliner would splice it back.
// Static seed data is live through this helper. Preserve that ownership edge
// until late data stripping; inlining would leave untracked raw addresses.
// The arena rewind's cold paths (optimize/arena-rewind.js): a frame's release
// and the outermost frame's entry, which every conditional frame would carry,
// and a loop's release that takes the flag over (module/core/reach.js
// `__iter_take`), which a loop's cold arm calls once per 64 KiB its iterations made.
const OUT_OF_LINE = ['$__rem_div', '$__len_tail', '$__length_tail', '$__length.value_tail', '$__typed_idx_tail',
  '$__typed_idx_tagged_tail', '$__arr_typed_set_idx_tail', '$__arr_typed_obj_set_idx_tail', '$__typed_set_idx_tagged_tail',
  '$__str_eq_tail', '$__rec_set_tail', '$__static_str', '$__frame_give', '$__frame_outer', '$__iter_take']

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
/**
 * The functions watr's single-caller inliner must leave intact, from the live
 * compile: JS-boundary vectorized functions (their `$name$exp` wrapper must
 * not swallow the body the host tests inspect) and the typed runtime the
 * typed-index proofs name. One list for both callers (index.js, scripts/self.js).
 */
export function programPins(cfg) {
  return [
    // The dynamic `+`'s cold path (ToPrimitive, concat or add) stays a call: spliced
    // into the hot arithmetic loops that reach it, it costs size for a path a
    // numeric program never takes.
    ...(ctx.core.includes.has('__add_slow') ? ['$__add_slow'] : []),
    // A loop its caller had no room for stays a function (plan/inline.js): the
    // single-caller inliner has no bound of its own.
    ...[...ctx.plans.keptKernels ?? []].map(name => `$${name}`),
    // A runtime throw only leaves: spliced into its one caller, a hot loop's
    // cold arm would carry the error's allocation and stores.
    ...[...ctx.runtime.throwHelpers].filter(name => ctx.core.includes.has(name.slice(1))),
    ...(cfg._vectorizedFnNames?.size
      ? [...cfg._vectorizedFnNames].filter(name => ctx.funcs.map.get(name.slice(1))?.exported)
      : []),
    ...(ctx.linkDemand.typedRuntime
      ? ['$__typed_idx', '$__typed_set_idx', '$__typed_idx_tagged', '$__typed_set_idx_tagged', '$__arr_typed_set_idx', '$__arr_typed_obj_set_idx']
        .filter(name => ctx.core.includes.has(name.slice(1))) : []),
  ]
}

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
  // watr loop strength reduction (speed tier): an address affine in a loop counter becomes a
  // pointer advanced with the counter. Generic Wasm; jz only enables it.
  if (cfg.watrLsr) {
    if (watrOpts === true) watrOpts = { lsr: true }
    else if (typeof watrOpts === 'object' && watrOpts.lsr === undefined) watrOpts.lsr = true
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
  // Deferring costly expressions duplicates their code across exclusive arms.
  // Enable that growth only where this tier explicitly waives the size guard.
  if (watrOpts.lazySelect === undefined) watrOpts.lazySelect = cfg.watrGuard === false
  // jz's promise is runtime speed, but watr's OWN profile default leans size — outline/
  // tailmerge/rettail fold repeated sequences into out-of-line calls (measured 1.433→1.316
  // on the self-compile kernel with them off, watr ≥5.2.0). Every speed-tier preset carries
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
  const pins = cfg.vectorizeLaneLocal ? [...SIMD_PINNED, ...LANE_PINS, ...OUT_OF_LINE] : [...SIMD_PINNED, ...OUT_OF_LINE]
  watrOpts.pin = watrOpts.pin ? [...watrOpts.pin, ...pins] : pins
  // Partial unrolling overlaps branch latency in compact codecs, but duplicates
  // too many cold compiler/parser loops in large module graphs and loses the
  // warm self-compile I-cache race. Users may still opt in explicitly.
  if (watrOpts.unroll2 == null && funcCount > 64) watrOpts.unroll2 = false
  // Keep only JS-boundary vectorized functions intact: their `$name$exp`
  // wrapper must not swallow the body/markers structural host tests inspect.
  // Internal lifted helpers remain inlineable — SIMD survives the splice,
  // while caller-level constant propagation and hot-call removal become live.
  if (boundaryPins.length) watrOpts.pin = [...watrOpts.pin, ...boundaryPins]
  if (cfg.propagateLocals === false && watrOpts.propagate === undefined) watrOpts.propagate = false
  if (cfg.coalesceLocals === false && watrOpts.coalesce === undefined) watrOpts.coalesce = false
  if (watrOpts.conditions === undefined) watrOpts.conditions = cfg.chainConditions !== false
  if (watrOpts.bool === undefined) watrOpts.bool = cfg.fusedRewrite !== false
  if (watrOpts.poolConstants === undefined) watrOpts.poolConstants = cfg.hoistConstantPool !== false
  // Value numbering and statement scheduling are generic Wasm (watr's); watrTail
  // vouches for the math runtime they may share and move.
  if (watrOpts.valueNumber === undefined) watrOpts.valueNumber = cfg.valueNumber !== false
  if (watrOpts.schedule === undefined) watrOpts.schedule = cfg.scheduleStatements !== false
  return watrOpts
}

/** Find a `['func', …]` node by its `$name`. */
function findFuncByName(module, name) {
  return module.find(n => Array.isArray(n) && n[0] === 'func' && n[1] === name)
}

const isExport = (x, name) => Array.isArray(x) && x[0] === 'export' && (name === undefined || x[1] === name)

/**
 * The function the program exports as a WASI entry (`"_start"`,
 * `"_initialize"`), and the thunk that takes the export off it: an inline
 * export (`export let _start = …`) or an alias's entry (`export { main as
 * _start }`). Its JS-boundary wrapper where it has one (`$name$exp`, which
 * carries the real arity). One that takes parameters, which no runtime
 * supplies, stays the export it is (`params`).
 */
function programEntry(module, name) {
  let target = null, unexport = null
  for (const n of module) {
    if (!Array.isArray(n) || n[0] !== 'func') continue
    const at = n.findIndex(x => isExport(x, name))
    if (at === -1) continue
    target = n[1]; unexport = () => n.splice(at, 1)
    break
  }
  if (target === null) {
    const at = module.findIndex(n => isExport(n, name) && Array.isArray(n[2]) && n[2][0] === 'func')
    if (at === -1) return null
    const node = module[at]
    target = node[2][1]; unexport = () => module.splice(module.indexOf(node), 1)
  }
  const func = findFuncByName(module, `${target}$exp`) || findFuncByName(module, target)
  if (!func) return null
  return { func, unexport, params: func.some(x => Array.isArray(x) && x[0] === 'param') }
}

/**
 * The statement that runs the program's jobs (std/async.js `__mt_drain`, the
 * export `__jz_mt_drain`) as a thunk, or null where it queues none.
 */
function drainCall(module) {
  let target = null
  for (const n of module) {
    if (!Array.isArray(n)) continue
    if (n[0] === 'export' && n[1] === '"__jz_mt_drain"' && Array.isArray(n[2]) && n[2][0] === 'func') { target = n[2][1]; break }
    if (n[0] === 'func' && n.some(x => isExport(x, '"__jz_mt_drain"'))) { target = n[1]; break }
  }
  const fn = target && findFuncByName(module, target)
  if (!fn) return null
  return fn.some(x => Array.isArray(x) && x[0] === 'result') ? () => ['drop', ['call', target]] : () => ['call', target]
}

/** A function calling `fn` with its own parameters, then `tail()`, its results kept across the tail. */
function callThen(fn, name, tail) {
  const f = ['func', name], args = [], results = []
  for (const x of fn) {
    if (!Array.isArray(x)) continue
    if (x[0] === 'param') for (const t of typeof x[1] === 'string' && x[1][0] === '$' ? [x[2]] : x.slice(1)) {
      const p = `$p${args.length}`
      f.push(['param', p, t])
      args.push(['local.get', p])
    }
    else if (x[0] === 'result') results.push(...x.slice(1))
  }
  if (results.length) f.push(['result', ...results], ...results.map((t, k) => ['local', `$r${k}`, t]))
  let call = ['call', fn[1], ...args]
  for (let k = results.length - 1; k >= 0; k--) call = ['local.set', `$r${k}`, call]
  f.push(call, tail(), ...results.map((_, k) => ['local.get', `$r${k}`]))
  return f
}

/** Each `(drop (call $name …))` statement under `node`, followed by `tail()`. */
function afterCalls(node, name, tail) {
  for (let i = 0; i < node.length; i++) {
    const x = node[i]
    if (!Array.isArray(x)) continue
    if (x[0] === 'drop' && Array.isArray(x[1]) && x[1][0] === 'call' && x[1][1] === name) node.splice(++i, 0, tail())
    else afterCalls(x, name, tail)
  }
}

/**
 * A WASI build runs its jobs as a JS host does, at the end of each turn: the
 * call a host makes into the module (init, `_start`, `_initialize`, any program
 * export) and each timer callback (module/timer.js `__timer_dispatch`). A
 * program export keeps its function, which the module's own calls reach, and
 * is exported as `$name$turn`, that call and then the drain; the host's
 * entries drain after the program's body (`entries`), and init drains where it
 * ends, so a command's `_start` runs the top-level code and its jobs, then the
 * program's own `_start` and its jobs, then each timer and its jobs.
 */
function wasiTurns(module, sFn, entries, turnEnd) {
  if (sFn) sFn.push(turnEnd())
  const dispatch = findFuncByName(module, '$__timer_dispatch')
  if (dispatch) afterCalls(dispatch, '$__invoke_closure', turnEnd)
  const programExport = (x) => isExport(x) && !x[1].startsWith('"__jz_') && x[1] !== '"memory"'
  const turns = new Map()
  const turnOf = (fn) => {
    let f = turns.get(fn)
    if (!f) { f = callThen(fn, `${fn[1]}$turn`, turnEnd); turns.set(fn, f); module.splice(module.indexOf(fn) + 1, 0, f) }
    return f
  }
  for (const n of [...module]) {
    if (!Array.isArray(n) || n === sFn || entries.includes(n) || turns.has(n)) continue
    if (n[0] === 'func' && n.some(programExport)) {
      const f = turnOf(n)
      for (let i = n.length - 1; i >= 2; i--) if (programExport(n[i])) f.splice(2, 0, ...n.splice(i, 1))
    }
    else if (programExport(n) && Array.isArray(n[2]) && n[2][0] === 'func') {
      const fn = findFuncByName(module, n[2][1])
      if (fn) n[2] = ['func', turnOf(fn)[1]]
    }
  }
}

/**
 * Module init as an export, not the wasm `start` section, which runs before
 * any host can wire the memory (the WASI p1 ABI forbids WASI calls there; a JS
 * host reads values through the memory). The program's own WASI entry is
 * honored: its `_initialize` or `_start` runs after init, under that one name
 * (`$_initialize$wasi`, `$_start$wasi`, each `() -> ()`).
 *
 * Under WASI the module is a command: `_start`, which wasmtime runs, is the
 * top-level code, then the program's own `_start` where it exports one, then
 * the timers they armed until none is pending (`__timer_loop`); the init alone
 * is `__jz_init`, for a JS host, which drives the timers from its own loop
 * (wasi.js attachTimers). A program that exports an `_initialize` and no
 * `_start` is a reactor instead: its `_initialize`, init then its body, is the
 * entry. Elsewhere init is the reactor's `_initialize`, which the interop calls
 * once the memory is wired. Every other exported function runs init first
 * where nothing has (`$__init_done`): an embedder that calls an export without
 * the entry (`wasmtime --invoke`, a bare `new WebAssembly.Instance`) still
 * sees seeded state. Under WASI each of these calls, and each timer callback,
 * ends by running the promise jobs it queued (`wasiTurns`).
 */
function legalizeInit(module, wasi) {
  const sFn = findFuncByName(module, '$__start')
  const ownInit = programEntry(module, '"_initialize"'), ownStart = wasi ? programEntry(module, '"_start"') : null
  const turnEnd = wasi ? drainCall(module) : null
  const entries = []
  // An entry: init, the program's body of that name (its results dropped) and its jobs, then `tail`
  const entry = (name, own, tail) => {
    const f = ['func', `$${name}$wasi`, ['export', `"${name}"`]]
    if (sFn) f.push(['call', '$__start'])
    if (own) {
      own.unexport()
      // a result goes: nested `local.set` folds consume a tuple's values one by one
      const results = own.func.flatMap(x => Array.isArray(x) && x[0] === 'result' ? x.slice(1) : [])
      let call = ['call', own.func[1]]
      for (let k = results.length - 1; k >= 0; k--) call = ['local.set', `$r${k}`, call]
      f.splice(3, 0, ...results.map((t, k) => ['local', `$r${k}`, t]))
      f.push(call)
      if (turnEnd) f.push(turnEnd())
    }
    f.push(...tail)
    module.splice(module.indexOf(sFn ?? own.func) + 1, 0, f)
    entries.push(f)
  }
  if (ownInit && !ownInit.params) entry('_initialize', ownInit, [])
  if (wasi && (ownStart ? !ownStart.params : sFn && !ownInit)) {
    // The timer loop stays exported through link (module/timer.js), that
    // treeshake keeps it; the command calls it now.
    const loop = findFuncByName(module, '$__timer_loop')
    if (loop) { const e = loop.findIndex(x => isExport(x)); if (e !== -1) loop.splice(e, 1) }
    entry('_start', ownStart, loop ? [['call', '$__timer_loop']] : [])
  }
  if (turnEnd) wasiTurns(module, sFn, entries, turnEnd)
  if (!sFn) return

  let at = 2
  while (at < sFn.length && Array.isArray(sFn[at]) && sFn[at][0] === 'local') at++
  sFn.splice(at, 0,
    ['if', ['global.get', '$__init_done'], ['then', ['return']]],
    ['global.set', '$__init_done', ['i32.const', 1]])
  // the init alone, where the program's `_initialize` does not hold it
  if (!ownInit || ownInit.params) sFn.splice(2, 0, ['export', wasi ? '"__jz_init"' : '"_initialize"'])

  const startDirIdx = module.findIndex(n => Array.isArray(n) && n[0] === 'start')
  if (startDirIdx !== -1) module.splice(startDirIdx, 1)

  for (const f of module) {
    if (!Array.isArray(f) || f[0] !== 'func' || f === sFn || entries.includes(f)) continue
    if (!f.some(x => isExport(x))) continue
    let g = 2
    while (g < f.length && Array.isArray(f[g]) &&
      (f[g][0] === 'export' || f[g][0] === 'param' || f[g][0] === 'result' || f[g][0] === 'local')) g++
    f.splice(g, 0, ['if', ['i32.eqz', ['global.get', '$__init_done']], ['then', ['call', '$__start']]])
  }

  // `$__init_done` goes right before the func region (globals immediately precede funcs).
  const firstFunc = module.findIndex(n => Array.isArray(n) && n[0] === 'func')
  module.splice(firstFunc, 0, ['global', '$__init_done', ['mut', 'i32'], ['i32.const', 0]])
}

/**
 * Target legalization (TargetProfile stage): module-level, target-conditional
 * rewrites of the fully assembled `['module', …]` tree, right before watr's
 * fixpoint, keyed off a TargetProfile (src/session.js targetProfileFor). A WASI
 * build is a command or, with the program's own `_initialize`, a reactor
 * (`commandEntry`); a JS-host module whose init reaches the host (a host global
 * it names, a member read or call on a host value, `__ext_*`, a host function's
 * throw) ships its init as `_initialize`, the program's own `_initialize` after
 * it; a pure module keeps its `start` section and instantiates bare.
 */
const HOST_ENV_GLOBALS = new Set(['WebAssembly', 'globalThis', 'self', 'window', 'global', 'process'])
const initTouchesHost = (module) => module.some(n => Array.isArray(n) && n[0] === 'import' && n[1] === '"env"' &&
  typeof n[2] === 'string' && (HOST_ENV_GLOBALS.has(n[2].slice(1, -1)) || n[2].startsWith('"__ext_'))) ||
  !!findFuncByName(module, '$__jz_throw_host')

export function legalizeForTarget(module, targetProfile) {
  if (targetProfile?.commandEntry) legalizeInit(module, true)
  else if (initTouchesHost(module)) legalizeInit(module, false)
  return module
}

const hexNibble = (c) => c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1

// A data segment's string, read in place (`"…"`, a byte a character or a `\xx`
// escape): the hosted compiler frees nothing within a compile, so the bytes
// are decoded once into a typed array and the kept pieces are slices of the
// string, never re-encoded a byte at a time.
/** The characters the escape at `i` of `t` takes. */
const escapeWidth = (t, i) => hexNibble(t.charCodeAt(i + 1)) >= 0 && hexNibble(t.charCodeAt(i + 2)) >= 0 ? 3 : 2
/** The bytes of a data string, or null for no string. */
function dataBytesOf(t) {
  if (typeof t !== 'string' || t.length < 2 || t.charCodeAt(0) !== 34) return null
  let n = 0
  for (let i = 1; i < t.length - 1; i += t.charCodeAt(i) === 92 ? escapeWidth(t, i) : 1) n++
  const out = new Uint8Array(n)
  n = 0
  for (let i = 1; i < t.length - 1;) {
    const c = t.charCodeAt(i)
    if (c !== 92) { out[n++] = c; i++; continue }
    const w = escapeWidth(t, i)
    if (w === 3) out[n++] = hexNibble(t.charCodeAt(i + 1)) * 16 + hexNibble(t.charCodeAt(i + 2))
    else { const e = t.charCodeAt(i + 1); out[n++] = e === 110 ? 10 : e === 114 ? 13 : e === 116 ? 9 : e }
    i += w
  }
  return out
}

const slebSize = (n) => { let size = 1; while (n >= 64 || n < -64) { n = Math.floor(n / 128); size++ } return size }

/** Flat [start, end) pairs sorted by start, overlapping and touching ones merged. */
function mergeRanges(pairs) {
  const idx = []
  for (let i = 0; i < pairs.length; i += 2) idx.push(i)
  idx.sort((a, b) => pairs[a] - pairs[b])
  const out = []
  for (let k = 0; k < idx.length; k++) {
    const lo = pairs[idx[k]], hi = pairs[idx[k] + 1]
    if (out.length && lo <= out[out.length - 1]) { if (hi > out[out.length - 1]) out[out.length - 1] = hi }
    else out.push(lo, hi)
  }
  return out
}

/** Merged `ranges` less merged `minus`, both sorted flat pairs. */
function subtractRanges(ranges, minus) {
  const out = []
  for (let i = 0; i < ranges.length; i += 2) {
    let lo = ranges[i]
    const hi = ranges[i + 1]
    for (let j = 0; j < minus.length && lo < hi; j += 2) {
      if (minus[j + 1] <= lo || minus[j] >= hi) continue
      if (minus[j] > lo) out.push(lo, minus[j])
      lo = Math.max(lo, minus[j + 1])
    }
    if (lo < hi) out.push(lo, hi)
  }
  return out
}

/** Whether `a` lies in one of the sorted, merged ranges. */
function inRanges(rs, a) {
  let lo = 0, hi = rs.length >> 1
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rs[mid * 2 + 1] <= a) lo = mid + 1; else hi = mid }
  return lo < rs.length >> 1 && rs[lo * 2] <= a
}

/**
 * Watr can erase a numeric conversion-table or the static number-string seed
 * only after inlining and folding expose its last dead call. Remove those exact
 * ranges when neither their owner nor an inlined address survives.
 *
 * The same holds for every literal the program laid out in the data segment
 * (`records`, static-data.js dataRecord: a string, a static array or object, a
 * table): the code that named it may be gone, a helper the link or watr
 * treeshake dropped, a function watr inlined and folded away. A literal
 * survives where a constant of the final code, or a word of the data that
 * survives, names a byte of it (an interior address too: watr folds a header
 * read into a constant of its own); the bytes of every other go where that
 * shrinks the module: the run they leave, zeros beside it included, at a
 * segment's edge, or inside one where it outweighs a segment's header.
 * Ranges stay at their original addresses, so no pointer rebasing is needed.
 * One pass over the code marks a byte map; nothing is made per node.
 */
function stripDeadLateData(module, lazySpans, staticSpan, records) {
  const spans = []
  if (lazySpans) for (let i = 0; i < lazySpans.length; i++) spans.push(lazySpans[i])
  if (staticSpan) spans.push(staticSpan)
  const recs = records || []
  if (!spans.length && !recs.length) return module
  const live = new Set()
  // Pow's two tables are addressed at folded interior offsets after inlining;
  // the base-global test below is exact only for EL/Ryū conversion tables.
  for (let i = 0; i < spans.length; i++)
    if (!spans[i].static && spans[i].global !== '__el_tbl' && spans[i].global !== '__ryu_tbl') live.add(spans[i])
  // the bytes below the literals' end a constant of the code names
  let limit = 0
  for (let i = 0; i < recs.length; i += 3) if (recs[i + 1] > limit) limit = recs[i + 1]
  const seen = new Uint8Array(limit)
  const add = (w) => { if (w >= 0 && w < limit) seen[w] = 1 }
  const scan = (node, parent, at) => {
    if (!Array.isArray(node) || node[0] === 'data') return
    const op = node[0]
    if (limit) constWords(node, parent, at, add)
    if (op === 'global' || op === 'global.get' || op === 'global.set') {
      for (let i = 0; i < spans.length; i++) if (node[1] === '$' + spans[i].global) live.add(spans[i])
    } else if (op === 'func') {
      for (let i = 0; i < spans.length; i++) if (node[1] === spans[i].fn) live.add(spans[i])
    } else if (op === 'i32.const') {
      if (spans.length) {
        const n = Number(node[1])
        for (let i = 0; i < spans.length; i++) {
          const s = spans[i], base = s.base == null ? s.start : s.base
          if (!s.static && (n === s.start || n === base)) live.add(s)
        }
      }
    } else if (op === 'f64.const' || op === 'i64.const') {
      const t = node[1]
      const from = !staticSpan || typeof t !== 'string' ? -1 : op === 'f64.const' ? (t.startsWith('nan:0x') ? 6 : -1) : (t.startsWith('0x') ? 2 : -1)
      if (from >= 0) {
        const hi = hexHalf(t, from, true), off = hexHalf(t, from, false)
        const tag = (hi >>> 15) & 15
        if (hi >= 0 && off >= 0 && ((hi >>> 16) & 0xFFF8) === 0x7FF8 && tag === 4 && !(hi & 0x4000) &&
            off >= staticSpan.start && off < staticSpan.end) live.add(staticSpan)
      }
    }
    for (let i = 0; i < node.length; i++) scan(node[i], op, i)
  }
  scan(module, null, 0)
  // the dead tables and seed: dropped whole
  const hard = []
  for (let i = 0; i < spans.length; i++) if (!live.has(spans[i])) hard.push(spans[i].start,
    spans[i].static ? spans[i].end : (spans[i].base == null ? spans[i].start : spans[i].base) + spans[i].bytes.length)
  // the active segments, each decoded once (one undecodable hides what its words name)
  const segs = []
  let opaque = false
  for (let ni = 0; ni < module.length; ni++) {
    const node = module[ni]
    if (!Array.isArray(node) || node[0] !== 'data') continue
    if (!Array.isArray(node[1]) || node[1][0] !== 'i32.const') {
      if (!(typeof node[1] === 'string' && node[1][0] === '$')) opaque = true
      continue
    }
    const base = Number(node[1][1]), bytes = node.length === 3 ? dataBytesOf(node[2]) : null
    if (!Number.isFinite(base) || !bytes) { opaque = true; continue }
    segs.push({ node, base, bytes })
  }
  const hardR = mergeRanges(hard)
  // the literals nothing that survives names, less the bytes of those it does
  let softR = []
  if (recs.length && !opaque) {
    const cover = []
    for (let i = 0; i < recs.length; i += 3) cover.push(recs[i], recs[i + 1])
    const covered = mergeRanges(cover)
    // The 4-aligned words the segments hold in [lo, hi). Data is never folded:
    // a word names a literal by its exact pointer, past a header of 4, 8 or 16
    // bytes (a string's length, an interned string's hash too, an array's).
    const held = new Uint8Array(limit + 1)
    let fresh = 0
    const words = (lo, hi, unowned) => {
      for (let si = 0; si < segs.length; si++) {
        const base = segs[si].base, bytes = segs[si].bytes
        let a = Math.max(lo, base)
        const end = Math.min(hi, base + bytes.length)
        a += (4 - a % 4) % 4
        for (; a + 4 <= end; a += 4) {
          if (unowned && (inRanges(covered, a) || inRanges(hardR, a))) continue
          const i = a - base, w = bytes[i] + bytes[i + 1] * 256 + bytes[i + 2] * 65536 + bytes[i + 3] * 16777216
          if (w <= limit && !held[w]) { held[w] = 1; fresh++ }
        }
      }
    }
    const heldIn = (lo, hi) => (lo + 4 <= hi && held[lo + 4]) || (lo + 8 <= hi && held[lo + 8]) || (lo + 16 <= hi && held[lo + 16])
    const named = (lo, hi) => { for (let a = lo; a < hi; a++) if (seen[a]) return true; return false }
    // data no literal owns survives: the words it holds name literals
    words(0, Infinity, true)
    const alive = new Uint8Array(recs.length / 3)
    for (let r = 0; r < alive.length; r++) if (named(recs[r * 3], recs[r * 3 + 1])) {
      alive[r] = 1
      if (!recs[r * 3 + 2]) words(recs[r * 3], recs[r * 3 + 1], false)
    }
    let grew = true
    while (grew) {
      fresh = 0
      for (let r = 0; r < alive.length; r++) {
        if (alive[r] || !heldIn(recs[r * 3], recs[r * 3 + 1])) continue
        alive[r] = 1
        if (!recs[r * 3 + 2]) words(recs[r * 3], recs[r * 3 + 1], false)
      }
      grew = fresh > 0
    }
    const dead = [], kept = []
    for (let r = 0; r < alive.length; r++) {
      if (alive[r]) kept.push(recs[r * 3], recs[r * 3 + 1])
      else dead.push(recs[r * 3], recs[r * 3 + 1])
    }
    softR = subtractRanges(mergeRanges(dead), mergeRanges(kept))
  }
  if (!hardR.length && !softR.length) return module
  const out = []
  let si = 0
  for (let ni = 0; ni < module.length; ni++) {
    const node = module[ni]
    if (si >= segs.length || segs[si].node !== node) { out.push(node); continue }
    const base = segs[si].base, bytes = segs[si].bytes, len = bytes.length
    si++
    // 1: a dead table's byte, 2: a dead literal's, 0: any other (in increasing order of `i`)
    let hp = 0, sp = 0
    const cls = (i) => {
      const a = base + i
      while (hp < hardR.length && hardR[hp + 1] <= a) hp += 2
      if (hp < hardR.length && hardR[hp] <= a) return 1
      while (sp < softR.length && softR[sp + 1] <= a) sp += 2
      return sp < softR.length && softR[sp] <= a ? 2 : 0
    }
    // a run of dead bytes and zeros: a table's goes, a literal's where it pays
    const cuts = []
    for (let i = 0; i < len;) {
      let c = cls(i)
      if (!c && bytes[i] !== 0) { i++; continue }
      let j = i, table = false, literal = false
      while (j < len && (c || bytes[j] === 0)) {
        if (c === 1) table = true
        else if (c === 2) literal = true
        j++
        if (j < len) c = cls(j)
      }
      const n = j - i
      if (table || literal && (j === len || (i === 0 ? n > slebSize(base + j) - slebSize(base) : n > 5 + slebSize(base + j)))) cuts.push(i, j)
      i = j
    }
    if (!cuts.length) { out.push(node); continue }
    // the kept pieces, sliced out of the segment's string at their bytes' characters
    const t = node[2], bounds = []   // the kept [start, end) pairs
    let from = 0
    for (let k = 0; k < cuts.length; k += 2) { if (cuts[k] > from) bounds.push(from, cuts[k]); from = cuts[k + 1] }
    if (from < len) bounds.push(from, len)
    const chars = []
    for (let i = 1, n = 0, k = 0; k < bounds.length;) {
      while (k < bounds.length && bounds[k] === n) { chars.push(i); k++ }
      if (i >= t.length - 1) break
      i += t.charCodeAt(i) === 92 ? escapeWidth(t, i) : 1
      n++
    }
    for (let k = 0; k + 1 < bounds.length; k += 2)
      out.push(['data', ['i32.const', String(base + bounds[k])], '"' + t.slice(chars[k], chars[k + 1]) + '"'])
  }
  module.length = 0
  for (let i = 0; i < out.length; i++) module.push(out[i])
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
export function watrTail(module, cfg, {
  funcCount = 0, boundaryPins = [], time = (n, f) => f(), targetProfile,
  lazyDataSpans = [], staticDataSpan = null, dataRecords = null, stableGlobals = null,
} = {}) {
  const legalized = legalizeForTarget(module, targetProfile)
  // A split binding of its predecessor's type takes that slot: the generic optimizer
  // then reads the function the source wrote.
  if (cfg.splitBindings !== false) time('shareSplitSlots', () => { for (const n of legalized) shareSplitSlots(n) })
  const watrOpts = resolveWatrOpts(cfg, { funcCount, boundaryPins })
  // The math runtime depends only on its operands and cannot trap (its loads read constant
  // tables, its truncations are guarded): value numbering and scheduling treat its calls
  // like arithmetic.
  if (watrOpts) watrOpts.pure = legalized.filter(n => Array.isArray(n) && n[0] === 'func' && pureKernel(n[1])).map(n => n[1])
  // (a wrapped word operation over extended words is the word operation: `avail & -avail` negates in the word)
  foldWrappedWords(legalized)
  // (a boxed pointer in a local the function only unboxes: the local holds the pointer)
  for (const n of legalized) narrowBoxedLocals(n)
  // (a loop that writes no memory and calls nothing: its reads every round runs, ahead of it)
  if (cfg.stillLoads === true) time('stillLoads', () => hoistStillLoads(legalized))
  // Generic local rewrites run only here, after link consumed JZ annotations.
  // Fast mode uses the same passes without the full module fixpoint.
  const optimized = watrOpts ? time('watOptimize', () => watOptimize(legalized, watrOpts))
    : time('watCleanup', () => {
      if (cfg.chainConditions !== false) conditions(legalized)
      const locals = cfg.propagateLocals !== false ? mergeLocals(propagate(legalized)) : legalized
      const cleaned = cfg.fusedRewrite !== false ? mergeBlocks(vacuum(bool(locals))) : locals
      // Large recursive functions need compact frames even without the fixpoint.
      const compact = cfg.coalesceLocals !== false ? coalesceLocals(cleaned) : cleaned
      if (cfg.coalesceLocals !== false || cfg.propagateLocals !== false) localReuse(compact)
      return cfg.hoistConstantPool !== false ? poolConstants(compact) : compact
    })
  if (cfg.hoistGlobalPtrOffset !== false) {
    const funcs = optimized.filter(node => Array.isArray(node) && node[0] === 'func')
    if (stableGlobals?.size) {
      const reach = collectReachableGlobalWrites(funcs)
      for (const node of funcs) hoistGlobalPtrOffset(node, stableGlobals, reach)
    }
  }
  if (cfg.guardedToInt32 === true) time('guardToInt32', () => guardToInt32(optimized, cfg.wordTruncation === 'add'))
  // (again, over what the optimizer's propagation and the truncation's lowering brought together:
  // a word converted to a Number and rounded back is the word; a flag of literals, read as the
  // optimizer leaves it, against literals, is a word)
  foldWrappedWords(optimized)
  for (const n of optimized) narrowFlagLocals(n)
  // (on the checked reads and stores watr left, before the float literals are pooled)
  if (cfg.forwardChecked !== false) time('forwardChecked', () => forwardCheckedElements(optimized))
  stripDeadLateData(optimized, lazyDataSpans, staticDataSpan, dataRecords)
  // (on the loops the optimizer leaves, before the passes below read a counted loop's counter)
  if (cfg.unrollTrips === true) time('unrollTrips', () => unrollTrips(optimized))
  // (on the counted loops the optimizer leaves, before their counters become pointer tests)
  if (cfg.ringLaps === true) time('ringLaps', () => ringLaps(optimized))
  // (on the pointers watr's strength reduction left beside their counters)
  if (cfg.pointerExits === true) time('pointerExits', () => pointerExits(optimized))
  // (on the variables that strength reduction leaves for their jumps: a pointer beside each)
  if (cfg.jumpPointers === true) time('jumpPointers', () => jumpPointers(optimized))
  // (on the loop bodies the optimizer leaves: its own passes would merge the split values back)
  if (cfg.leadChains === true) time('leadChains', () => leadChains(optimized))
  // (after them: a run they leave as written, an integrator's stages, the order the core issues soonest)
  if (cfg.issueOrder === true) time('issueOrder', () => issueOrder(optimized))
  if (cfg.maskOperands === true) time('maskOperands', () => maskOperands(optimized))
  // (before the float selects become selects of bits)
  if (cfg.truncChoice !== false) time('truncChoice', () => truncChoice(optimized))
  // (on the arms the truncations brought together: a select of their leaves, before the selects become bits)
  if (cfg.selectArms !== false) time('selectArms', () => selectArms(optimized))
  // (on the lanes the vectorizer converted and the selects the arms became: each arm's quotient one of a choice)
  if (cfg.shareQuotients !== false) time('shareQuotients', () => shareQuotients(optimized))
  // (before a float select of literals becomes a select of their bits: a test of it is a test of its condition)
  if (cfg.testedChoices === true) time('testedChoices', () => foldTestedChoices(optimized))
  // (after the passes that read a float select as one)
  if (cfg.selectBits === true) time('selectBits', () => selectBits(optimized, { simd: !ctx.transform.noSimd }))
  // (on the loops the optimizer leaves: its own passes would fold the scan's blocks back)
  if (cfg.searchLoops === true) time('searchLoops', () => searchLoops(optimized))
  // (on the loops the optimizer leaves: its value numbering would read the gather back where the round uses it)
  if (cfg.leadGathers === true) time('leadGathers', () => leadGathers(optimized))
  // (while each loop has one latch: a round's last store, read back first by the next round, through a local)
  if (cfg.carryStores === true) time('carryStores', () => carryStores(optimized))
  // (on the scans the passes above leave: a round that skips one takes the latch without a jump past it)
  if (cfg.skipLatches === true) time('skipLatches', () => skipLatches(optimized))
  // (on the loops the passes above leave, before the float literals are pooled: a running extreme's
  // canonicalization reads its NaN as a literal)
  if (cfg.guardExtremes === true) time('guardExtremes', () => guardExtremes(optimized))
  // (on the tests the optimizer joined, before the float literals are pooled)
  if (cfg.pairTests === true) time('pairTests', () => pairTests(optimized, { simd: !ctx.transform.noSimd }))
  // (an export's boundary wrapper, `$name$exp` (compile/boundary-wrap.js), is the program's own:
  // the body it calls once is inlined there)
  const user = name => ctx.funcs.map.has(name.slice(1)) || name.endsWith('$exp') && ctx.funcs.map.has(name.slice(1, -4))
  // (after the passes that read the runtime's calls by name: a helper of a few instructions joins
  // its callers, a larger one the program's loops)
  if (cfg.inlineTiny === true && watrOpts)
    time('inlineTiny', () => inlineTiny(optimized, { pin: watrOpts.pin, max: cfg.tinyNodes ?? 16, loop: cfg.loopNodes ?? 90, kernel: cfg.kernelNodes ?? 300, user }))
  // (on every division the passes above left, the vectorizer's epilogues and the inlined helpers' among them)
  if (cfg.unsignedDivision !== false) time('unsignedDivision', () => unsignedDivision(optimized))
  // (after the passes that read an access's address as written, the inliner's constant arguments among them)
  if (cfg.constBases !== false) time('constBases', () => constBases(optimized))
  // (last: the float literals every pass above reads as constants)
  if (cfg.poolFloats === true) time('poolFloatConstants', () => poolFloatConstants(optimized))
  // (after every pass that reads a function whole, the inliner above all, which would splice a
  // single-caller arm back)
  // (the same: an inliner would splice a pass back into the function that runs once)
  if (cfg.loopPasses === true) time('loopPasses', () => loopPasses(optimized, { user }))
  if (cfg.splitFuncs === true) time('splitFuncs', () => splitFuncs(optimized, { fnMin: cfg.splitFn, fnTo: cfg.splitTo, armMin: cfg.splitArm }))
  // (last: on the vector loops every pass above left, each where it will run)
  if (cfg.hoistVectorConsts === true) time('hoistVectorConsts', () => hoistVectorConsts(optimized))
  return optimized
}
