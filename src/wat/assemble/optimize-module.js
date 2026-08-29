/**
 * Whole-module + per-function optimization passes, plus the module-level
 * arena-rewind escape analysis (`applyArenaRewind`) it drives per function.
 *
 * Split out of assemble.js (pipeline-minimality slice) — pure move, no
 * behavior change. See ../assemble.js for the stage contract and
 * `.work/assemble-outliers.md` §3-4: this is the one file in the split with
 * a real cross-seam call (`appendLateStdlib`, the late f64x2-vectorizer
 * stdlib top-up, lives in `./stdlib-pull.js`) — every other assemble/*.js
 * pair is fully independent.
 */

import parseWat from 'watr/parse'
import { ctx, HEAP, declGlobal } from '../../ctx.js'
import { T, walkAst } from '../../ast.js'
import { VAL } from '../../reps.js'
import {
  optimizeFunc, collectVolatileGlobals, collectReachableGlobalWrites, collectReachableMemoryWrites,
  hoistGlobalPtrOffset, hoistLoopGlobalPtrOffset, hoistStableGlobalConstLoads, guardMaskedVectorSuffix, hasIROp, stablePtrGlobalNames,
  hoistConstantPool, specializeMkptr, arenaRewindModule, buildPureFuncMap, inlinePureFnsInFn,
} from '../../optimize/index.js'
import { findBodyStart } from '../../ir.js'
import { dataLen } from '../../static-data.js'
import { assembleView } from '../../session-views.js'
import { appendLateStdlib } from './stdlib-pull.js'
// memory[HEAP.PTR_ADDR] holds the heap pointer only for shared memory (wasm globals are
// per-instance — see module/core.js comment). Non-shared memory uses $__heap.
const heapUsesMem = () => assembleView().memory.shared

const heapGetIR = () => heapUsesMem()
  ? ['i32.load', ['i32.const', HEAP.PTR_ADDR]]
  : ['global.get', '$__heap']

const heapSetIR = value => heapUsesMem()
  ? ['i32.store', ['i32.const', HEAP.PTR_ADDR], value]
  : ['global.set', '$__heap', value]

const ARENA_SAFE_CALLS = new Set([
  '$__alloc', '$__alloc_hdr', '$__alloc_hdr_n', '$__mkptr',
  '$__ptr_offset', '$__ptr_type', '$__ptr_aux',
  '$__len', '$__cap', '$__typed_shift', '$__typed_data',
])

function applyArenaRewind(func, fn, safeCallees) {
  if (ctx.transform.optimize?.arenaRewind === false) return false
  if (func.raw || func.sig.params.length !== 0 || func.sig.results.length !== 1) return false
  if (func.sig.ptrKind != null) return false
  if (func.sig.results[0] === 'f64' && func.valResult !== VAL.NUMBER) return false
  if (func.sig.results[0] !== 'f64' && func.sig.results[0] !== 'i32') return false

  const bodyStart = findBodyStart(fn)
  let hasAlloc = false
  let unsafe = false
  const scan = node => {
    if (unsafe) return false
    const op = node[0]
    if (op === 'global.set' || op === 'return_call' || op === 'call_indirect' || op === 'call_ref') { unsafe = true; return false }
    if (op === 'call') {
      const name = node[1]
      if (name === '$__alloc' || name === '$__alloc_hdr' || name === '$__alloc_hdr_n') hasAlloc = true
      if (!(safeCallees ?? ARENA_SAFE_CALLS).has(name)) { unsafe = true; return false }
    }
  }
  for (let i = bodyStart; i < fn.length; i++) walkAst(fn[i], { enter: scan })
  if (unsafe || !hasAlloc) return false

  let id = 0
  const hasLocal = name => fn.some(n => Array.isArray(n) && n[0] === 'local' && n[1] === name)
  while (hasLocal(`$${T}heap_save${id}`) || hasLocal(`$${T}arena_ret${id}`)) id++
  const save = `$${T}heap_save${id}`
  const ret = `$${T}arena_ret${id}`
  const restore = () => heapSetIR(['local.get', save])
  const resultType = func.sig.results[0]

  // Rewrite the return's VALUE, not the return: `return` is stack-polymorphic
  // (never falls through), so it validates in statement AND value position alike.
  // The old form — a value-typed block AROUND the return — reified `(result T)`
  // even where the return was a statement, leaving a phantom value on the stack
  // of a void enclosing frame (a `return` inside try_table failed validation:
  // "expected 0 elements on the stack for fallthru, found 1").
  const endsWithReturn = fn.at(-1)?.[0] === 'return' || fn.at(-1)?.[0] === 'return_call'
  // Retired onto walkAst (pipeline-minimality slice, `.work/assemble-outliers.md`
  // §5): a `return` node is replaced wholesale, never recursed into — its own
  // value can't itself contain a nested statement-position `return`, so
  // there is nothing further to rewrite inside it; every other node recurses
  // normally. `enter`'s `(parent, index)` gives a valid slot to reassign even
  // for a bare top-level `return` (walkAst visits every `fn[i]` from index 1,
  // a strict superset of the original `bodyStart`-based loop — `fn[i]` for
  // `i < bodyStart` are `local`/`param` decls, never `return`-shaped, so
  // visiting them too is a no-op).
  walkAst(fn, { enter: (node, parent, index) => {
    if (node[0] === 'return' && node.length > 1) {
      parent[index] = ['return', ['block',
        ['result', resultType],
        ['local.set', ret, node[1]],
        restore(),
        ['local.get', ret]]]
      return false
    }
  } })
  const newBodyStart = findBodyStart(fn)
  fn.splice(newBodyStart, 0,
    ['local', save, 'i32'],
    ['local', ret, resultType],
    ['local.set', save, heapGetIR()])
  if (!endsWithReturn) {
    const last = fn.pop()
    fn.push(['local.set', ret, last], restore(), ['local.get', ret])
  }
  return true
}

/**
 * Phase: whole-module + per-function optimization passes.
 */
export function optimizeModule(sec, profiler, regionHooks) {
  const t = profiler?.time ? (name, fn) => profiler.time(`optMod:${name}`, fn) : (_, fn) => fn()
  const cfg = ctx.transform.optimize
  if (!cfg || cfg.specializeMkptr !== false) t('specializeMkptr', () =>
    specializeMkptr([...sec.funcs, ...sec.stdlib, ...sec.start], wat => sec.stdlib.push(parseWat(wat)), parseWat, regionHooks))
  // (specializePtrBase and sortStrPoolByFreq deleted: byte-identical output with
  // both disabled across the bench + examples corpora AND the self-compile kernel at
  // every watr tier — watr's own inlining/offset folding subsumed them. ~350ms/corpus.)
  // (globalTypes backfill gone: declGlobal sets the type at declaration.)
  // Build global name→type map from ctx.scope.globalTypes (keys without $) for promoteGlobals
  const globalTypesMap = ctx.scope.globalTypes ? new Map([...ctx.scope.globalTypes].map(([k, v]) => [`$${k}`, v])) : null
  const allFuncs = [...sec.funcs, ...sec.stdlib, ...sec.start]
  const volatileGlobals = t('volatileGlobals', () => collectVolatileGlobals(allFuncs))
  const reachableWrites = t('reachableWrites', () => collectReachableGlobalWrites(allFuncs))
  // Offset-hoist BEFORE promoteGlobals (inside optimizeFunc): value-promoting a
  // stable-pointee global to a $_pg local would destroy the global.get pattern
  // this pass matches, reverting rfft/diffusion to per-iteration resolves. After
  // the hoist, the surviving global.get count is 1 (the entry snap) — naturally
  // below promoteGlobals' threshold, so the two passes compose either way.
  if (!cfg || cfg.hoistGlobalPtrOffset !== false) t('hoistGlobalPtr', () => {
    const stable = stablePtrGlobalNames()
    if (stable.size) for (const s of allFuncs) hoistGlobalPtrOffset(s, stable, reachableWrites)
  })
  // Per-loop complement: a function the whole-function pass above declined
  // (an unrelated call_indirect / write ANYWHERE in the function poisons
  // every global for it) may still have individual loops that are clean on
  // their own narrower scope — e.g. a char-scan loop inside a devirtualized
  // Pratt-loop trampoline that also inlines unrelated operator dispatch.
  if (!cfg || cfg.hoistLoopGlobalPtrOffset !== false) t('hoistLoopGlobalPtr', () => {
    const stable = stablePtrGlobalNames()
    if (stable.size) for (const s of allFuncs) hoistLoopGlobalPtrOffset(s, stable, reachableWrites)
  })
  // Build the pure-function map for tryPerPixelColor's Phase-2 lane inline BEFORE the
  // per-function vectorizer runs — the vectorizer is jz lowering (pre-watr), so it needs
  // its inline candidates now, not after watr. Bodies are still clean scalar here.
  if (cfg && cfg.vectorizeLaneLocal === true) {
    const pureFuncMap = buildPureFuncMap(allFuncs)
    if (pureFuncMap.size) {
      cfg._pureFuncMap = pureFuncMap
      // jz semantic inlining (LOWERING) — inline pure user functions into their call sites BEFORE the
      // vectorizer, so it sees the callee arithmetic (the pow/decode a colour helper hides). jz owns
      // this because the decision is purity+type-driven; watr keeps only mechanical residual inlining.
      // Gated to SINGLE-CALLER pure functions: inlining the sole call site is a guaranteed win (removes
      // the call AND the now-dead function, zero size cost). Multi-caller small helpers stay watr's
      // size-gated mechanical job at the speed tier — jz doesn't duplicate that.
      // SMALL single-caller only: inlining a small pure helper (a `spow`/`decode` colour term) into its
      // sole caller exposes its arithmetic to the vectorizer at zero size cost. Inlining a LARGE function
      // (a whole conversion loop) is neutral-to-harmful (worse layout/regalloc, measured on colorpq), and
      // watr's own inlineOnce already handles the mechanical single-caller case — so jz stays out of it.
      // OPT-IN (default off): correct + fuzz-clean, but inlining across the corpus changes a lot of
      // pinned output-shape assertions for no measured bench win (the current regressions are outer-strip/
      // widening recognition + watr wasm-opt-class, not inlining). Kept as the architectural home for
      // semantic inlining, enabled per-compile via `optimize.inlinePureFns: true`, until a real case pays.
      if (cfg.inlinePureFns === true) t('inlinePureFns', () => {
        const callCount = new Map()
        for (const s of allFuncs) walkAst(s, { enter: n => {
          if ((n[0] === 'call' || n[0] === 'return_call') && typeof n[1] === 'string') callCount.set(n[1], (callCount.get(n[1]) || 0) + 1)
        } })
        const nodeCount = (n) => { let c = 0; walkAst(n, { enter: () => { c++ } }); return c }
        const INLINE_MAX = 48
        const canInline = new Set([...pureFuncMap.keys()].filter(name =>
          callCount.get(name) === 1 && nodeCount(pureFuncMap.get(name)) <= INLINE_MAX))
        if (canInline.size) { const idRef = { next: 0 }; for (const s of allFuncs) inlinePureFnsInFn(s, pureFuncMap, idRef, canInline) }
      })
    }
  }
  // Candidate bodies for devirt arm inlining and block-narrowing
  // (devirtConstFnArrayCalls): the UNFILTERED name→fn map of const-fn-array
  // element bodies. Built here — the pass runs per-function inside optimizeFunc
  // and can't see sibling functions. No purity filter: the inliner enforces
  // straight-line shape itself, and an arm executes exactly when the original
  // call did, so side-effecting bodies substitute safely.
  if (ctx.scope.constFnArrays?.size) {
    const candNames = new Set()
    for (const list of ctx.scope.constFnArrays.values()) for (const c of list) candNames.add(`$${c.name}`)
    ctx.scope.dvArmFns = new Map(allFuncs.filter(f => Array.isArray(f) && candNames.has(f[1])).map(f => [f[1], f]))
  }
  t('optimizeFuncs', () => {
    let mark = null, batch = []
    for (let i = 0; i < allFuncs.length; i++) {
      if (regionHooks && mark == null) mark = regionHooks.mark()
      const s = allFuncs[i]
      optimizeFunc(s, cfg, globalTypesMap, volatileGlobals, reachableWrites)
      if (regionHooks) batch.push(s)
      if (regionHooks && (batch.length >= 16 || i === allFuncs.length - 1)) {
        ;[batch, ctx.scope, ctx.transform, ctx.types, ctx.schema, ctx.core.includes, ctx.runtime] =
          regionHooks.exit(mark, [batch, ctx.scope, ctx.transform, ctx.types, ctx.schema, ctx.core.includes, ctx.runtime])
        mark = null
        batch = []
      }
    }
  })
  if (!cfg || cfg.hoistGlobalConstLoads !== false || cfg.maskedSuffixGuard !== false) t('hoistGlobalConstLoads', () => {
    const wantLoads = cfg.hoistGlobalConstLoads !== false && !!ctx.scope.globalTypedLen?.size
    // The guarded form necessarily writes a declared v128 local. Keep scalar
    // programs on the old allocation-free path; only SIMD functions pay for
    // the DAG-safe deep opcode probe.
    const mayHaveMasks = cfg.maskedSuffixGuard !== false && allFuncs.some(fn =>
      fn.some(n => Array.isArray(n) && n[0] === 'local' && n[2] === 'v128'))
    const wantMasks = mayHaveMasks && hasIROp(allFuncs, 'v128.bitselect')
    if (!wantLoads && !wantMasks) return
    const memoryWrites = collectReachableMemoryWrites(allFuncs)
    for (const s of allFuncs) {
      if (wantLoads) hoistStableGlobalConstLoads(s, memoryWrites, reachableWrites)
      if (wantMasks) guardMaskedVectorSuffix(s, memoryWrites)
    }
  })
  // The lane vectorizer can inject f64x2 stdlib mirrors ($math.log_v, $math.cos2, …)
  // absent from the already-pulled+treeshaken module. Append any now-referenced mirror
  // body to sec.stdlib — the pre-watr analogue of index.js's post-watr appendLateStdlib.
  if (cfg && cfg.vectorizeLaneLocal === true) t('appendLateStdlib', () => appendLateStdlib(allFuncs, sec.stdlib))
  if (!cfg || cfg.arenaRewind !== false) {
    const safeCallees = arenaRewindModule([...sec.funcs, ...sec.stdlib, ...sec.start])
    const fnByName = new Map()
    for (const fn of sec.funcs) {
      if (Array.isArray(fn) && fn[0] === 'func' && typeof fn[1] === 'string')
        fnByName.set(fn[1], fn)
    }
    for (const func of ctx.funcs.list) {
      const fn = fnByName.get(`$${func.name}`)
      if (fn) applyArenaRewind(func, fn, safeCallees)
    }
  }
  if (!cfg || cfg.hoistConstantPool !== false)
    hoistConstantPool([...sec.funcs, ...sec.stdlib, ...sec.start], (name, lit) => declGlobal(name, 'f64', lit))

  // Second promoteGlobals pass disabled: promoting hoistConstantPool's __fc*
  // globals regressed the watr perf micro-pin (WASM compile time increased).
  // The __fc* globals are typically read 3-4 times; the local setup overhead
  // in large functions outweighs the per-read savings.  Left as a no-op hook
  // in case future analysis finds a profitable threshold or function-size gate.
  // if (!cfg || cfg.promoteGlobals !== false) {
  //   const globalTypesMap2 = ctx.scope.globalTypes ? new Map([...ctx.scope.globalTypes].map(([k, v]) => [`$${k}`, v])) : null
  //   for (const s of [...sec.funcs, ...sec.stdlib, ...sec.start]) promoteGlobals(s, globalTypesMap2)
  // }

  const dataBytes = dataLen()
  if (dataBytes > 1024 && !ctx.memory.shared) {
    // 64-byte heap-base alignment: the compiler's own vectorizer emits v128
    // stream loads/stores, and a heap base that isn't 64-byte aligned makes
    // every such access straddle cache lines on memory-bound kernels — a real,
    // measurable slowdown that a single unrelated prelude-size change can
    // trigger by shifting the base's alignment. Cache-line alignment makes
    // perf immune to prelude size changes — without it every stdlib edit
    // re-rolls the layout lottery.
    // Cost: ≤56 bytes of memory per module, zero code bytes.
    const heapBase = (dataBytes + 63) & ~63
    // Non-shared memory always carries a $__heap global — start it past the
    // static data so the bump allocator never overwrites a literal. `__heap_reset`
    // seeds to the same data end (its runtime value is overwritten by `__start`'s
    // tail capture for modules that init-allocate; this seed serves modules with no
    // `__start`, where the data end IS the correct rewind point). `__clear` reads
    // `$__heap_reset` directly, so no per-function constant patch is needed.
    declGlobal('__heap', 'i32', heapBase, { export: '__heap' })
    if (ctx.scope.globals.has('__heap_reset')) declGlobal('__heap_reset', 'i32', heapBase)
    if (ctx.scope.globals.has('__heap_start')) declGlobal('__heap_start', 'i32', heapBase)
  }
}
