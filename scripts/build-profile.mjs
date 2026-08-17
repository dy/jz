#!/usr/bin/env node
/**
 * resolveSelfhostBuild — the ONE self-host build-config resolver shared by
 * scripts/build-dist.mjs and scripts/selfhost-build.mjs (architecture re-audit
 * item 2, .work/todo.md). Before this module, build-dist.mjs alone did the
 * CARRIER_BOX build-time source-literal injection (.work/carrier-representation-
 * design.md §32/§34) and the region-arena × inlinePtrOffsetFast gate
 * (.work/research.md §Region arena) — selfhost-build.mjs did NEITHER, so
 * JZ_CARRIER_BOX=0 silently had no effect on a selfhost-build.mjs kernel (the
 * env var was read at compile() call time, but src/ctx.js's own
 * `typeof process === 'undefined'` fold — see the CARRIER_BOX doc below — means
 * an un-injected self-hosted kernel always freezes CARRIER_BOX to `true`
 * regardless of the flag), and a region-live kernel built via selfhost-build.mjs
 * would carry inlinePtrOffsetFast's region hazard (module/core.js's
 * __region_exit relocation vs. watr's own CSE, same doc below) that build-dist.mjs
 * takes care to gate off. Two builders, two entry points, one config resolver:
 * this function is the only place either literal injection or the region-arena
 * derivation happens.
 *
 * @param {object} [p]
 * @param {boolean} [p.carrierBox]      Bake CARRIER_BOX as this literal boolean
 *   into the self-hosted src/ctx.js. Default: `process.env.JZ_CARRIER_BOX !== '0'`
 *   (this build process's own env var — matches build-dist.mjs's pre-existing
 *   default and is now ALSO selfhost-build.mjs's default, closing the
 *   inconsistency this item exists to fix).
 * @param {boolean} [p.debugInvariants] Bake DBG_INVARIANTS as this literal into
 *   the self-hosted src/ctx.js (same source-literal-injection mechanism as
 *   carrierBox — a live JZ_DEBUG_INVARIANTS env var cannot be observed by the
 *   running wasm kernel). Default false: debug-only invariant code folds out of
 *   production kernels; callers opt in explicitly for an instrumented build.
 * @param {boolean|null} [p.regionArena] Whether scripts/self.js's watrTail
 *   regionHooks are active for THIS build, controlling the inlinePtrOffsetFast
 *   gate (see the doc block below). `true`/`false` — an EXPLICIT profile
 *   override, always wins. `null`/`undefined` (default) — derive ONCE, here,
 *   from scripts/self.js's own `REGION_HOOKS_ACTIVE` marker (a literal string
 *   match, not a regex over the commented/uncommented `regionHooks:` object
 *   shape build-dist.mjs used to run independently).
 * @param {number|string|object|false} [p.optimize] optimize.level (or full
 *   per-pass object, or `false` to disable). Default 3 (both builders' existing
 *   measured self-host profile — see selfhost-build.mjs's own comment on why).
 * @param {boolean} [p.snapshot]  optimize.snapshotInit. Default true.
 * @param {boolean} [p.watrGuard] optimize.watrGuard. Default false (both
 *   builders already skip watr's size-revert guard on this controlled artifact).
 * @param {number} [p.memory]     memory pages. Default 8192 (both builders' value).
 * @param {boolean} [p.helperCounters]  compile() opts.helperCounters passthrough
 *   (selfhost-build.mjs's JZ_HELPER_COUNTERS diagnostic profiling knob; unused
 *   by build-dist.mjs, default false so its behavior is unchanged).
 * @param {boolean} [p.compactCollections] Build the compiler artifact's own
 *   Set/Map/HASH tables without the redundant 4-byte-per-slot probe lane.
 *   This is an outer-build option only: the compiled compiler still emits the
 *   normal fast-lane layout for user programs. Default true; set
 *   JZ_SELFHOST_COMPACT_COLLECTIONS=0 for the measured legacy baseline.
 * @param {boolean|string} [p.helperCallsites] compile() opts.helperCallsites
 *   passthrough (selfhost-build.mjs's JZ_HELPER_SITES knob; default false).
 * @returns {{
 *   graph: object,               // resolveModuleGraph(scripts/self.js) result — g.code/g.modules
 *                                 //   already carry the injected defines below
 *   defines: {CARRIER_BOX: boolean, DBG_INVARIANTS: boolean}, // literal defines actually applied
 *   regionArenaLive: boolean,    // resolved regionArena flag (explicit or marker-derived)
 *   optimize: object|false,      // full compile() optimize cfg, including the region-arena
 *                                 //   optimizer override folded in
 *   optimizerOverrides: object,  // just the delta from the plain {level,watrGuard,snapshotInit}
 *                                 //   shape (e.g. {inlinePtrOffsetFast:false}) — informational
 *   memory: number,
 *   compactCollections: boolean,
 *   helperCounters: boolean, helperCallsites: boolean|string,
 * }}
 */
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveModuleGraph } from '../src/resolve.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SELF_ENTRY = resolve(ROOT, 'scripts/self.js')

export function resolveSelfhostBuild({
  carrierBox = process.env.JZ_CARRIER_BOX !== '0',
  debugInvariants = false,
  regionArena = null,
  optimize = 3,
  snapshot = true,
  watrGuard = false,
  memory = 8192,
  compactCollections = process.env.JZ_SELFHOST_COMPACT_COLLECTIONS !== '0',
  helperCounters = false,
  helperCallsites = false,
} = {}) {
  const graph = resolveModuleGraph(SELF_ENTRY, { resolveNode: true })

  // ── CARRIER_BOX self-host build-time injection (.work/carrier-representation-
  // design.md §32 — the item-8/rawField() root cause; §34 flipped the default
  // ON). src/ctx.js declares `CARRIER_BOX = typeof process === 'undefined' ||
  // process.env?.JZ_CARRIER_BOX !== '0'` — a native-process host-capability
  // probe, correct when ctx.js runs NATIVELY. But when ctx.js's OWN SOURCE is
  // what's being self-hosted (compiled BY jz, below), jz's compiler —
  // CORRECTLY, per spec §13.5.3 (prepare/index.js staticTypeofString/
  // isUnresolvableBareIdent) — folds `typeof process` to the literal
  // 'undefined' for ANY compile, because `process` is never declared anywhere
  // in jz's own source or its GLOBALS table. That permanently folds
  // CARRIER_BOX to `true` inside ANY self-hosted kernel regardless of the flag
  // THIS build runs under (the OR's left arm always wins once `typeof
  // process` is a literal 'undefined'): the running kernel's own compiled
  // decisions (module/schema.js slotBigintBoxedBySid, src/ir.js
  // isSchemaSlotBigintPossible, etc.) can never observe a live env var — wasm
  // has no `process`. Bake THIS BUILD's actual flag value in as a source-text
  // literal before compiling, the standard technique for a build-time
  // constant that must survive into a self-hosted artifact (webpack
  // DefinePlugin / rustc cfg! precedent). Native runs (`node index.js`, every
  // test/*.js) read the real declaration, untouched.
  const CTX_PATH = Object.keys(graph.modules).find(p => p.endsWith('/src/ctx.js'))
  if (!CTX_PATH) throw new Error('resolveSelfhostBuild: src/ctx.js not found in self.js module graph — CARRIER_BOX injection site missing')
  const carrierNeedle = "export const CARRIER_BOX = typeof process === 'undefined' || process.env?.JZ_CARRIER_BOX !== '0'"
  if (!graph.modules[CTX_PATH].includes(carrierNeedle))
    throw new Error('resolveSelfhostBuild: CARRIER_BOX declaration shape changed in src/ctx.js — update this self-host injection to match')
  graph.modules[CTX_PATH] = graph.modules[CTX_PATH].replace(carrierNeedle, `export const CARRIER_BOX = ${!!carrierBox}`)

  // ── DBG_INVARIANTS injection — same host/runtime split as CARRIER_BOX.
  // Always inject the literal, including false: leaving the process.env probe in
  // a production self-host graph keeps every debug-only branch and helper body
  // reachable because the cross-module value is not folded early enough.
  const dbgNeedle = 'export const DBG_INVARIANTS = typeof process !== \'undefined\' && process.env?.JZ_DEBUG_INVARIANTS === \'1\''
  if (!graph.modules[CTX_PATH].includes(dbgNeedle))
    throw new Error('resolveSelfhostBuild: DBG_INVARIANTS declaration shape changed in src/ctx.js — update this self-host injection to match')
  const dbgDecl = `export const DBG_INVARIANTS = ${!!debugInvariants}`
  graph.modules[CTX_PATH] = graph.modules[CTX_PATH].replace(dbgNeedle, dbgDecl)

  if (!debugInvariants) {
    // A literal declaration in ctx.js is not enough: after module lowering its
    // imported binding is a wasm global, so consumers cannot constant-fold it
    // and the entire diagnostic implementation survives in the production
    // kernel. Specialize every self-host source before compilation instead.
    const dropDebugImport = (src) => src.replace(
      /import\s*\{([^}]*)\}\s*from\s*(['"][^'"]*\/src\/ctx\.js['"])/g,
      (whole, names, from) => {
        const imported = names.split(',').map(x => x.trim()).filter(Boolean)
        if (!imported.some(x => x.split(/\s+as\s+/)[0] === 'DBG_INVARIANTS')) return whole
        const kept = imported.filter(x => x.split(/\s+as\s+/)[0] !== 'DBG_INVARIANTS')
        return kept.length ? `import { ${kept.join(', ')} } from ${from}` : ''
      })
    const specialize = (src) => dropDebugImport(src).replace(/\bDBG_INVARIANTS\b/g, 'false')

    // Keep ctx.js's exported declaration syntactically intact while replacing
    // every use in its own body. Other modules have the named import removed
    // before their uses become literal false.
    const marker = 'export const __JZ_DBG_LITERAL__ = false'
    graph.modules[CTX_PATH] = specialize(graph.modules[CTX_PATH].replace(dbgDecl, marker)).replace(marker, dbgDecl)
    graph.code = specialize(graph.code)
    for (const path of Object.keys(graph.modules)) if (path !== CTX_PATH)
      graph.modules[path] = specialize(graph.modules[path])

    const remaining = [graph.code, ...Object.values(graph.modules)]
      .reduce((n, src) => n + (src.match(/\bDBG_INVARIANTS\b/g)?.length || 0), 0)
    if (remaining !== 1)
      throw new Error(`resolveSelfhostBuild: DBG_INVARIANTS specialization left ${remaining} references (expected only ctx.js's export)`)
  }

  // ── REGION-ARENA × inlinePtrOffsetFast (.work/research.md §Region arena,
  // ROOT-CAUSE ATTEMPT 2026-08-11 — confirmed by ablation, 7/7 banked fuzz
  // findings + both minimal repros clean ×3 reps with this flag off, kernel-
  // oracle 13/13×3, kernel-parity 33/33×3, dead on the full 200-seed sweep×3):
  // inlinePtrOffsetFast (src/passes.js:48) expands `(call $__ptr_offset X)`
  // into a loop-free, CSE-eligible i32.and/i64.shr_u/load expression AT EVERY
  // CALL SITE, precisely so watr's own optimizer can fold/hoist it like any
  // other pure op. That is exactly the hazard when regionHooks are wired
  // (scripts/self.js): a region_exit call relocates live heap objects and
  // re-derives their offsets through the SAME forwarding chase this inlined
  // form reproduces — but once inlined, the expansion LOOKS pure to every
  // downstream CSE, which has zero notion that a `$__region_exit` call
  // anywhere in between invalidates a previously-decoded offset. The
  // out-of-line `call $__ptr_offset` form is naturally conservative (a call
  // is a CSE barrier); the inlined form is not. The sound, compile-time gate
  // is therefore here, at the one config resolution point every self-host
  // build entry shares: force inlinePtrOffsetFast off for exactly a
  // region-live build. Every other compile — native, the test suite, jzify,
  // any user program, even a DORMANT self-host build — is untouched.
  //
  // regionArena resolution: an EXPLICIT profile field (p.regionArena) always
  // wins — "the caller says so", not a source guess. Left null/undefined
  // (both builders' default), derive ONCE from scripts/self.js's own
  // REGION_HOOKS_ACTIVE marker: a single literal-string match, not a regex
  // over the `regionHooks: {` object's commented/uncommented shape (the old
  // build-dist.mjs mechanism this replaces).
  const regionArenaLive = regionArena ?? graph.code.includes('export const REGION_HOOKS_ACTIVE = true')

  const optimizerOverrides = regionArenaLive ? { inlinePtrOffsetFast: false } : {}
  const optimizeCfg = optimize === false ? false : {
    level: optimize, watrGuard, snapshotInit: snapshot,
    ...optimizerOverrides,
  }

  return {
    graph,
    defines: { CARRIER_BOX: !!carrierBox, DBG_INVARIANTS: !!debugInvariants },
    regionArenaLive,
    optimize: optimizeCfg,
    optimizerOverrides,
    memory,
    compactCollections: !!compactCollections,
    helperCounters, helperCallsites,
  }
}
