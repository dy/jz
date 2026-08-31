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
 *   the self-compiled src/ctx.js (source-literal injection — a live
 *   JZ_DEBUG_INVARIANTS env var cannot be observed by the running wasm
 *   kernel). Default false: debug-only invariant code folds out of
 *   production kernels; callers opt in explicitly for an instrumented build.
 * @param {number|string|object|false} [p.optimize] optimize.level (or full
 *   per-pass object, or `false` to disable). Default 1: the compiler artifact
 *   keeps essential cleanup without spending its finite heap optimizing its
 *   own optimizer; user programs still receive their requested profile.
 * @param {boolean} [p.snapshot]  optimize.snapshotInit. Default true — KEPT ON
 *   (self-compile-memory campaign, .work/self-compile-memory.md, measured
 *   2026-08-29). snapshotInit's own probe (a full extra watrCompile() of the
 *   ~18 MB kernel, instantiated and run just to read back __start's post-init
 *   values) does cost 90.6 s and a transient +478.9 MB RSS bump on the ONE-TIME
 *   hosted build, and has zero effect on the in-wasm jz×jz recursive ceiling
 *   either way (scripts/self.js's compileSelf() never calls snapshotInit, so
 *   this flag only ever governs how dist/jz.wasm itself gets BUILT). A first
 *   pass turned this off by default on exactly that basis — wrong: it traded
 *   a one-time build cost for a per-INSTANTIATION cost every consumer of
 *   dist/jz.wasm pays forever after (the website REPL, every kernel test file,
 *   scripts/bench-self-compile.mjs — anyone who instantiates the kernel now
 *   re-runs __start's table-building/atom-interning/GLOBALS-registry work
 *   every time instead of paying for it once at build time). That every
 *   self-compile TIMING GATE happens to exclude instantiate() from its timed
 *   region (test/self-compile-perf.js, scripts/bench-self-compile.mjs — see
 *   their own header comments) is a gap in what those gates measure, not
 *   evidence the cost is actually free; optimizing to what a gate excludes
 *   instead of the real recurring cost was the mistake. Reverted — snapshot
 *   stays on by default. The engineering fix that's actually worth landing is
 *   making the bake itself cheap (avoid the SECOND full watrCompile: encode
 *   once, instantiate that exact binary, run __start, then patch the
 *   already-encoded module's data/start sections directly instead of
 *   re-running the whole optimizer+encoder pipeline) — tracked in
 *   .work/self-compile-memory.md, not yet landed here. `snapshot: false` /
 *   `JZ_SELF_COMPILE_SNAPSHOT=0` remains available for diagnostic A/B use.
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
 * @param {boolean} [p.inPlaceWatrCleanup] Specialize watr's normalization
 *   clone to consume the compiler's one-shot IR in place. Default true.
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
const SELF_ENTRY = resolve(ROOT, 'scripts/self.js')

export function resolveSelfCompileBuild({
  debugInvariants = false,
  optimize = 1,
  snapshot = true,
  watrGuard = false,
  arrayMinCap = 2,
  arrayLiteralMinCap = 2,
  hashSmallInitCap = 2,
  collectionInitCap = 2,
  inPlaceWatrCleanup = true,
  memory = 1024,
  compactCollections = process.env.JZ_SELF_COMPILE_COMPACT_COLLECTIONS !== '0',
  helperCounters = false,
  helperCallsites = false,
} = {}) {
  const graph = resolveModuleGraph(SELF_ENTRY, { resolveNode: true })

  const CTX_PATH = Object.keys(graph.modules).find(p => p.endsWith('/src/ctx.js'))
  if (!CTX_PATH) throw new Error('resolveSelfCompileBuild: src/ctx.js not found in self.js module graph — DBG_INVARIANTS injection site missing')

  // ── DBG_INVARIANTS injection — a build-time constant baked in as a
  // source-text literal (webpack DefinePlugin / rustc cfg! precedent).
  // Why injection instead of the env probe: ctx.js's declaration guards on
  // `typeof process`, which jz — CORRECTLY, per spec §13.5.3 (prepare/index.js
  // staticTypeofString/isUnresolvableBareIdent) — folds to the literal
  // 'undefined' for ANY self-compile (`process` is never declared in jz's own
  // source or GLOBALS), so a self-compiled kernel could never observe a live
  // env var — wasm has no `process`. Native runs (`node index.js`, every
  // test/*.js) read the real declaration, untouched.
  // Always inject the literal, including false: leaving the process.env probe in
  // a production self-compile graph keeps every debug-only branch and helper body
  // reachable because the cross-module value is not folded early enough.
  const dbgNeedle = 'export const DBG_INVARIANTS = typeof process !== \'undefined\' && process.env?.JZ_DEBUG_INVARIANTS === \'1\''
  if (!graph.modules[CTX_PATH].includes(dbgNeedle))
    throw new Error('resolveSelfCompileBuild: DBG_INVARIANTS declaration shape changed in src/ctx.js — update this self-compile injection to match')
  const dbgDecl = `export const DBG_INVARIANTS = ${!!debugInvariants}`
  graph.modules[CTX_PATH] = graph.modules[CTX_PATH].replace(dbgNeedle, dbgDecl)

  if (!debugInvariants) {
    // A literal declaration in ctx.js is not enough: after module lowering its
    // imported binding is a wasm global, so consumers cannot constant-fold it
    // and the entire diagnostic implementation survives in the production
    // kernel. Specialize every self-compile source before compilation instead.
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
      throw new Error(`resolveSelfCompileBuild: DBG_INVARIANTS specialization left ${remaining} references (expected only ctx.js's export)`)
  }

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

  // The self kernel hands watr a one-shot assembled IR tree and never reads it
  // after encoding. watr@5.10.1's generic cleanup defensively filter()+map()
  // clones every node, requiring a second module-sized heap generation. Use an
  // output-equivalent in-place normalizer only in this hermetic build graph;
  // the host API and dependency source remain the published watr implementation.
  if (inPlaceWatrCleanup) {
    const watrCompilePath = Object.keys(graph.modules).find(p => p.endsWith('/node_modules/watr/src/compile.js'))
    if (!watrCompilePath) throw new Error('resolveSelfCompileBuild: watr/src/compile.js missing from self graph')
    const src = graph.modules[watrCompilePath]
    const start = src.indexOf('const cleanup = (node, result) => {')
    const end = src.indexOf('\n\n// string literal node:', start)
    if (start < 0 || end < 0) throw new Error('resolveSelfCompileBuild: watr cleanup shape changed — update the one-shot in-place specialization')
    const cleanup = `const cleanup = (node, result) => {
  if (typeof node === 'string') return (
    node[0] === '$' && node[1] === '"' ? (node.includes('\\\\') ? '$' + unescape(node.slice(1)) : '$' + node.slice(2, -1)) :
    node[0] === '"' ? str(node) :
    node[0] === ';' ? loc(node) :
    node
  )
  if (!Array.isArray(node)) return node
  const sourceLoc = node.loc
  let write = 0
  for (let i = 0; i < node.length; i++) {
    const child = node[i]
    if (isDroppable(child)) continue
    node[write++] = cleanup(child)
  }
  node.length = write
  node.loc = sourceLoc
  return node.length === 1 && node[0]?.[0] === 'module' ? node[0] : node
}`
    let specialized = src.slice(0, start) + cleanup + src.slice(end)
    const rewrites = [
      ["  ctx.metadata = {} // code metadata storage: { type: [[funcIdx, [[pos, data]...]]] }", "  ctx.metadata = {} // code metadata storage: { type: [[funcIdx, [[pos, data]...]]] }\n  ctx.normalizePartsPool = []\n  ctx.normalizeDepth = 0"],
      ["      const parts = node.slice(1)", "      const parts = takeNormalizeParts(node, ctx)\n      try {"],
      ["      }\n    } else out.push(node)", "      }\n      } finally { releaseNormalizeParts(parts, ctx) }\n    } else out.push(node)"],
    ]
    for (const [from, to] of rewrites) {
      if (!specialized.includes(from)) throw new Error(`resolveSelfCompileBuild: watr one-shot rewrite missing: ${from}`)
      specialized = specialized.replace(from, to)
    }
    const normalizeAt = specialized.indexOf('function normalize(nodes, ctx, out = [], owned = false) {')
    if (normalizeAt < 0) throw new Error('resolveSelfCompileBuild: watr normalize shape changed')
    const pool = `const takeNormalizeParts = (node, ctx) => {
  const depth = ctx.normalizeDepth
  let parts = ctx.normalizePartsPool[depth]
  if (!parts) {
    parts = new Array(node.length - 1)
    parts.length = 0
    ctx.normalizePartsPool[depth] = parts
  }
  ctx.normalizeDepth = depth + 1
  parts.length = node.length - 1
  for (let i = 1; i < node.length; i++) parts[i - 1] = node[i]
  return parts
}
const releaseNormalizeParts = (parts, ctx) => {
  parts.length = 0
  ctx.normalizeDepth--
}

`
    specialized = specialized.slice(0, normalizeAt) + pool + specialized.slice(normalizeAt)
    graph.modules[watrCompilePath] = specialized
  }

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
