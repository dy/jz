#!/usr/bin/env node
/**
 * resolveSelfCompileBuild — the one self-compile build-config resolver shared by
 * scripts/build-dist.mjs and scripts/self-compile-build.mjs. Build-time literal
 * specialization lives here so both builders always agree. (The CARRIER_BOX injection this resolver was born for is gone —
 * the boxed carrier became the unconditional representation and the flag was
 * deleted, .work/archive/carrier-representation-design.md §34's own end state.)
 *
 * @param {object} [p]
 * @param {boolean} [p.debugInvariants] Bake DBG_INVARIANTS as this literal into
 *   the self-compiled src/debug.js (source-literal injection — a live
 *   JZ_DEBUG_INVARIANTS env var cannot be observed by the running wasm
 *   kernel). Default false: debug-only invariant code folds out of
 *   production kernels; callers opt in explicitly for an instrumented build.
 * @param {number|string|object|false} [p.optimize] optimize.level (or full
 *   per-pass object, or `false` to disable). Default 1: the compiler artifact
 *   keeps essential cleanup without spending its finite heap optimizing its
 *   own optimizer; user programs still receive their requested profile.
 * @param {boolean} [p.snapshot] optimize.snapshotInit. Default true: pay for
 *   module initialization once at build time. The snapshot probe's encoded
 *   function bodies are reused; only declarations and the captured heap are
 *   encoded again. This changes build cost, not the hosted compiler's runtime
 *   pipeline. `snapshot: false` / `JZ_SELF_COMPILE_SNAPSHOT=0` is diagnostic.
 * @param {boolean} [p.watrGuard] optimize.watrGuard. Default false (both
 *   builders already skip watr's size-revert guard on this controlled artifact).
 * @param {number} [p.arrayMinCap] Dynamic-array capacity floor for the compiler
 *   artifact itself. Default 2: compiler ASTs favor compact tiny arrays over
 *   the user speed preset's 16-slot growth floor.
 * @param {number} [p.arrayLiteralMinCap] Literal-array capacity floor for the
 *   compiler artifact. Default 2; user programs retain the normal default 4.
 * @param {number} [p.hashSmallInitCap] Small HASH sidecar capacity floor for
 *   the compiler artifact. Default 2; most compiler metadata sidecars are tiny.
 * @param {number} [p.collectionInitCap] Set/Map initial capacity for the
 *   compiler artifact. Default 2 instead of the user runtime's speed-tuned 8.
 * @param {number} [p.memory]     memory pages — the kernel's declared INITIAL commitment; $__memgrow extends on demand (no max). Default 1024 (64 MiB): small graphs stay near their true need instead of paying the old flat 8192-page/512 MiB floor (census 2026-08-18: jessie's real working set is ~150 MB, 70.7% of the old commitment was never touched).
 * @param {boolean} [p.helperCounters]  compile() opts.helperCounters passthrough
 *   (self-compile-build.mjs's JZ_HELPER_COUNTERS diagnostic profiling knob; unused
 *   by build-dist.mjs, default false so its behavior is unchanged).
 * @param {boolean} [p.compactCollections] Build the compiler artifact's own
 *   Set/Map/HASH tables without the redundant 4-byte-per-slot probe lane.
 *   This is an outer-build option only: the compiled compiler still emits the
 *   normal fast-lane layout for user programs. Default true; set
 *   JZ_SELF_COMPILE_COMPACT_COLLECTIONS=0 for the measured legacy baseline.
 * @param {boolean|string} [p.helperCallsites] compile() opts.helperCallsites
 *   passthrough (self-compile-build.mjs's JZ_HELPER_SITES knob; default false).
 * @returns {{
 *   graph: object,               // resolveModuleGraph(scripts/self.js) result — g.code/g.modules
 *                                 //   already carry the injected defines below
 *   defines: {CARRIER_BOX: boolean, DBG_INVARIANTS: boolean}, // literal defines actually applied
 *   optimize: object|false,      // full compile() optimize cfg
 *   memory: number,
 *   compactCollections: boolean,
 *   helperCounters: boolean, helperCallsites: boolean|string,
 * }}
 */
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveModuleGraph } from '../src/resolve.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SELF_ENTRY = resolve(ROOT, 'scripts/self.js')

// Specialize before either bundler analyzes imports, so diagnostic-only imports
// and helpers are unreachable in both the JS bundle and the hosted compiler.
export function specializeInvariants(source, enabled = false) {
  const declaration = /^export const DBG_INVARIANTS = .+$/m
  const marker = 'export const __JZ_DBG_LITERAL__ = false'
  const hasDeclaration = declaration.test(source)
  if (enabled) return source.replace(declaration, 'export const DBG_INVARIANTS = true')
  source = source.replace(declaration, marker).replace(
    /import\s*\{([^}]*)\}\s*from\s*(['"][^'"]*\/debug\.js['"])/g,
    (whole, names, from) => {
      const kept = names.split(',').map(x => x.trim()).filter(x => x && x !== 'DBG_INVARIANTS')
      return kept.length ? `import { ${kept.join(', ')} } from ${from}` : ''
    })
  source = source.replace(/\bDBG_INVARIANTS\b/g, 'false')
  return hasDeclaration ? source.replace(marker, 'export const DBG_INVARIANTS = false') : source
}

export function resolveSelfCompileBuild({
  debugInvariants = false,
  optimize = 1,
  snapshot = true,
  watrGuard = false,
  arrayMinCap = 2,
  arrayLiteralMinCap = 2,
  hashSmallInitCap = 2,
  collectionInitCap = 2,
  memory = 1024,
  compactCollections = process.env.JZ_SELF_COMPILE_COMPACT_COLLECTIONS !== '0',
  helperCounters = false,
  helperCallsites = false,
} = {}) {
  const graph = resolveModuleGraph(SELF_ENTRY, { resolveNode: true })

  const DEBUG_PATH = Object.keys(graph.modules).find(p => p.endsWith('/src/debug.js'))
  if (!DEBUG_PATH) throw new Error('resolveSelfCompileBuild: src/debug.js not found in self.js module graph — DBG_INVARIANTS injection site missing')

  graph.code = specializeInvariants(graph.code, debugInvariants)
  for (const path of Object.keys(graph.modules))
    graph.modules[path] = specializeInvariants(graph.modules[path], debugInvariants)

  // ── snapshot.js host-capability specialization — same build-time-literal
  // technique as DBG_INVARIANTS. `WebAssembly` is a modeled HOST global
  // (emit.js HOST_GLOBALS), so `typeof WebAssembly === 'undefined'` stays a
  // RUNTIME probe in the kernel — correct in general (a host could inject it),
  // but snapshotInit's hermetic-instantiation tail is host-API-only machinery
  // the kernel can never run, and its `new WebAssembly.Global(..., 0n)` is a
  // BigInt crossing an unknown host boundary — exactly the flow class the
  // strict BigInt contract refuses. Fold the guard true for the SELF-COMPILE
  // graph; prepare's constant-if fold + unreachable-tail pruning then drop the
  // whole tail before analysis. Kernel behavior: snapshotInit declines (no
  // snapshot optimization for programs the kernel compiles) — same result the
  // runtime probe would produce, decided at build time.
  const SNAP_PATH = Object.keys(graph.modules).find(p => p.endsWith('/src/snapshot.js'))
  if (SNAP_PATH) {
    const snapNeedle = "if (typeof WebAssembly === 'undefined') return false"
    if (!graph.modules[SNAP_PATH].includes(snapNeedle))
      throw new Error('resolveSelfCompileBuild: snapshot.js host guard shape changed — update this specialization to match')
    graph.modules[SNAP_PATH] = graph.modules[SNAP_PATH].replace(snapNeedle, 'if (true) return false')
  }

  // Keep watr's printer flatness check in the self-host subset's proven loop
  // form. The callback form is semantically identical on a native host but an
  // O1-built compiler widened its boolean callback carrier and printed a flat
  // `(memory (export …) 1)` over three lines.
  const watrPrintPath = Object.keys(graph.modules).find(p => p.endsWith('/node_modules/watr/src/print.js'))
  if (!watrPrintPath) throw new Error('resolveSelfCompileBuild: watr/src/print.js missing from self graph')
  const printRewrites = [
    ['let flat = !!newline && node.length < 4 && !node.some(n => typeof n === \'string\' && n[0] === \';\' && n[1] === \';\')',
      `let flat = !!newline && node.length < 4
    if (flat) for (let j = 0; j < node.length; j++) {
      const value = node[j]
      if (typeof value === 'string' && value[0] === ';' && value[1] === ';') { flat = false; break }
    }`],
    ['if (flat) flat = sub.every(sub => !Array.isArray(sub))',
      `if (flat) for (let j = 0; j < sub.length; j++) if (Array.isArray(sub[j])) { flat = false; break }`],
  ]
  for (const [from, to] of printRewrites) {
    if (!graph.modules[watrPrintPath].includes(from)) throw new Error(`resolveSelfCompileBuild: watr print shape changed: ${from}`)
    graph.modules[watrPrintPath] = graph.modules[watrPrintPath].replace(from, to)
  }
  const memoryPrintPoint = "    let afterLineComment = false // track if we just printed a line comment"
  if (!graph.modules[watrPrintPath].includes(memoryPrintPoint)) throw new Error('resolveSelfCompileBuild: watr memory print insertion point changed')
  graph.modules[watrPrintPath] = graph.modules[watrPrintPath].replace(memoryPrintPoint,
    `${memoryPrintPoint}
    if (content === 'memory' && node.length === 3)
      return \`(memory \${printNode(node[1], level)} \${node[2]})\``)

  const optimizeCfg = optimize === false ? false : {
    ...(typeof optimize === 'object' ? optimize : { level: optimize }),
    watrGuard,
    snapshotInit: snapshot,
    arrayMinCap: typeof optimize === 'object' && optimize.arrayMinCap != null ? optimize.arrayMinCap : arrayMinCap,
    arrayLiteralMinCap: typeof optimize === 'object' && optimize.arrayLiteralMinCap != null ? optimize.arrayLiteralMinCap : arrayLiteralMinCap,
    hashSmallInitCap: typeof optimize === 'object' && optimize.hashSmallInitCap != null ? optimize.hashSmallInitCap : hashSmallInitCap,
    collectionInitCap: typeof optimize === 'object' && optimize.collectionInitCap != null ? optimize.collectionInitCap : collectionInitCap,
  }

  return {
    graph,
    defines: { DBG_INVARIANTS: !!debugInvariants },
    optimize: optimizeCfg,
    memory,
    compactCollections: !!compactCollections,
    helperCounters, helperCallsites,
  }
}
