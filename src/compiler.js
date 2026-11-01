/**
 * jz - JS subset → WASM compiler.
 *
 * # Pipeline stages + contracts
 *
 *   source (string)
 *     ↓  parse (subscript/jessie) — lexing + expression-oriented AST
 *   raw AST: nested arrays `[op, ...args]`, no ctx mutation
 *     ↓  jzify (provided by the full entry; the strict entry omits it) — lower full JS (var/function/class/switch) to jz-native
 *   desugared AST: arrow functions + let/const/if only
 *     ↓  prepare — validate (reject disallowed ops), normalize (++/--→+=/-=, scope rename),
 *        extract (functions→ctx.funcs.list with sig), resolve (imports→ctx.module.imports),
 *        track (object-literal schemas via ctx.schema.register)
 *   prepared AST: normalized, with `ctx.funcs.list` / `ctx.module.imports` / `ctx.schema.list`
 *     populated. Arrow bodies carry no type info yet.
 *     ↓  compile (src/compile/index.js) — whole-program summary and plan, then per function:
 *        analysis (locals/valTypes/captures/narrowing fixpoint) and IR generation via the
 *        emitter table (src/compile/emit.js).
 *        Writes: `ctx.func.valTypes`/`.locals`, `ctx.types.*`, `ctx.runtime.*`, `ctx.core.includes`.
 *        Module assembly (src/wat/assemble.js optimizeModule) runs jz's own per-function passes
 *        once — optimizeFunc (src/optimize/driver.js): address CSE, LICM, the fused peephole
 *        walk, auto-vectorization. All lowering, incl. SIMD, happens here, before watr.
 *     ↓  link (src/link) — tape passes: loop rotation, folds, arena rewind, treeshake, ordering.
 *   WAT IR: watr S-expression `['module', ...sections]`, every instruction node carries `.type`.
 *     ↓  watrTail (src/optimize/watr-tail.js; opt-out via opts.optimize=false) — watr's optimizer,
 *        the sole generic fixpoint (CSE, DCE, const fold, inline, coalesce), run once; then only
 *        narrow, idempotent jz proof repairs (stable pointer/cell hoists, masked-suffix guards).
 *     ↓  watrPrint (opts.wat=true) → WAT text, or watrCompile → Uint8Array binary
 *
 * # State
 * Single shared `ctx` (src/ctx.js). Reset per compile by beginSession (src/session.js).
 * Each subkey has a declared lifecycle + ownership — see ctx.js docstring for the table.
 *
 * # Extension
 * Modules in module/ register operator handlers on ctx.core.emit and stdlibs on ctx.core.stdlib.
 * Feature flags (ctx.features.*) gate conditional stdlib branches for dead-code elimination.
 * Capability hooks (ctx.schema.register, ctx.closure.make) are installed by capability modules.
 *
 * Interop host layer (memory marshaling, wrap, instantiate) lives in
 * interop.js; the `jz/interop` subpath (instantiate.js) exposes its
 * `instantiate` to hosts that run prebuilt jz wasm without the compiler.
 *
 * @module jz/compiler
 */

import { captureRuntimeInspect } from './compile/func-inspect.js'
import { configureFixedMemory, verifyFixedScratch, verifyFixedMemory } from './compile/fixed-memory.js'
import { DBG_INVARIANTS, assertCtxInvariants } from './debug.js'
import { parse } from './parse.js'
import watrCompile, { sourceMapURL } from "watr/compile";
import { annotateSource, completeSourceMap } from './source-map.js'
import { snapshotInit } from "./snapshot.js";
import watrPrint from "watr/print";
import { ctx, err, errorNode, warn, setLinkDemand, flushWarnings } from './ctx.js'
import { GLOBALS } from './prepare/index.js'
import { frontHalf } from './front.js'
import { configureDiagnostics, configureMemory, beginSession } from './session.js'
import { normalizeOptions, foldOptions } from './options.js'
import compile, { tailFacts } from './compile/index.js'
import { emitter, emissionHooks } from './compile/emit.js'
import { watrTail } from './optimize/watr-tail.js'

import { serialize } from './source-literal.js'

// A host import that's a JS function may hand back any value, including a host
// object — which arrives in wasm as a PTR.EXTERNAL ref. Constants/typed specs can't.
const importsMayReturnExternal = (imports) =>
  !!imports && Object.values(imports).some(mod =>
    Object.values(mod || {}).some(spec => typeof spec === 'function'))

// WHATWG URL resolution for compile-time import.meta lowering. Injected into
// ctx.transform (like parse/jzify) so prepare never references the `URL` global
// directly — keeps the self-compile kernel free of host-only built-ins.
const resolveUrl = (spec, base) => new URL(spec, base).href

// opts.define → a one-line `let K = V; …` prelude prepended to source. Kept on a
// single line (no trailing newline) so user line numbers past line 1 stay exact —
// same convention the template tag uses for hoisted literals. (foldOptions
// checked every key and value.)
const defineBindings = (define) => {
  const parts = Object.entries(define).map(([k, v]) => `let ${k} = ${serialize(v)}`)
  return parts.length ? parts.join('; ') + '; ' : ''
}

const nowMs = () => globalThis.performance?.now ? globalThis.performance.now() : Date.now()

const compileProfiler = (profile) => {
  if (profile == null) return null
  profile.entries ||= []
  profile.totals ||= {}
  return {
    time(name, fn) {
      const start = nowMs()
      try { return fn() }
      finally {
        const ms = nowMs() - start
        profile.entries.push({ name, ms })
        profile.totals[name] = (profile.totals[name] || 0) + ms
      }
    },
  }
}

const uleb = (n) => {
  const out = []
  do {
    let b = n & 0x7f
    n >>>= 7
    if (n) b |= 0x80
    out.push(b)
  } while (n)
  return out
}

const utf8Bytes = (s) => [...new TextEncoder().encode(s)]
const nameBytes = (s) => {
  const bytes = utf8Bytes(s)
  return [...uleb(bytes.length), ...bytes]
}

const watName = (s) => typeof s === 'string' && s.startsWith('$') ? s.slice(1) : null
const quotedName = (s) => typeof s === 'string' && /^".*"$/.test(s) ? s.slice(1, -1) : null

const importFuncName = (node) => {
  if (!Array.isArray(node) || node[0] !== 'import') return null
  const desc = node[3]
  if (!Array.isArray(desc) || desc[0] !== 'func') return null
  return watName(desc[1]) || quotedName(node[2])
}

const functionNameSection = (module) => {
  const entries = []
  let funcIdx = 0
  for (const node of module) {
    if (!Array.isArray(node)) continue
    if (node[0] === 'import') {
      const name = importFuncName(node)
      if (name != null) entries.push([funcIdx++, name])
    } else if (node[0] === 'func') {
      const name = watName(node[1])
      // A closure body carries its enclosing function: profiles read the source site.
      const owner = name != null ? ctx.closure.owner?.get(name) : null
      if (name != null) entries.push([funcIdx, owner ? `${name}@${owner}` : name])
      funcIdx++
    }
  }
  if (!entries.length) return null
  const map = [...uleb(entries.length)]
  for (const [idx, name] of entries) map.push(...uleb(idx), ...nameBytes(name))
  const payload = [...nameBytes('name'), 1, ...uleb(map.length), ...map]
  return Uint8Array.from([0, ...uleb(payload.length), ...payload])
}

const appendFunctionNames = (wasm, module) => {
  const section = functionNameSection(module)
  if (!section) return wasm
  const out = new Uint8Array(wasm.length + section.length)
  out.set(wasm)
  out.set(section, wasm.length)
  return out
}

// Test configuration shared by every compiler entry. The in-process entry
// remains available for tests inspecting native analysis state.
let compileTarget = null
export const setCompileTarget = fn => { const previous = compileTarget; compileTarget = fn; return previous }
const run = (code, flags, jzify) => compileTarget ? compileTarget(code, flags) : compileInProcess(code, flags, jzify)

/** The public entry: options held to the public contract (src/options.js normalizeOptions). */
export const compileSource = (code, opts, jzify = null) => run(code, normalizeOptions(opts), jzify)

/** The internal entry, which index.js does not export: the internal flags beside
 *  the public options (CONTRIBUTING.md, Public contract and ABI), for the CLI,
 *  the tests, the bench and the tools. */
export const compileInternal = (code, opts, jzify = null) => run(code, foldOptions(opts), jzify)

/** In-process entry for tests that inspect ctx, profiles, or analysis snapshots. */
export function compileInProcess(code, opts = {}, jzify = null) {
  opts = foldOptions(opts)
  try {
    return jzCompileInner(code, opts, jzify)
  } catch (e) {
    // Any uncaught native exception (TypeError, ReferenceError, etc.) is a jz
    // codegen leak — surface it as an internal compile error with the source
    // location we were standing on. err()-thrown errors already pass through.
    // (Option errors throw before this, from foldOptions.)
    if (e?.name === 'TypeError' || e?.name === 'ReferenceError' || e?.name === 'RangeError') {
      // Pass `e` as the cause so the original stack (the real codegen site) survives.
      err(`internal: ${e.message} (jz hit an unsupported case while compiling${ctx.error.node != null ? `, at ${errorNode()}` : ''}). This is a jz bug — please report.`, e)
    }
    throw e
  }
}

// Defaults the test matrix installs (test/_env.js, from JZ_TEST_OPTIMIZE,
// JZ_TEST_HOST and JZ_TEST_STRICT) for every compile of its process, an option the
// call passes winning. The compiler reads no environment of its own.
let compileDefaults = null
export const setCompileDefaults = (defaults) => { compileDefaults = defaults && Object.keys(defaults).length ? defaults : null }

// Shared front-half: reset ctx, wire opts → ctx.transform/memory/module/features,
// and inject parse/resolveUrl. Called by `jzCompileInner` (the only entry point
// today). The self-compile entry (scripts/self.js) drives reset itself rather than
// going through this path, since it needs only a minimal, interop-free setup.
const setupCtx = (code, opts, jzify) => {
  if (compileDefaults) {
    const merged = { ...opts }
    for (const k of Object.keys(compileDefaults)) if (merged[k] == null) merged[k] = compileDefaults[k]
    opts = merged
  }
  // Session lifecycle — shared verbatim with the self-compile kernel's setupSelf
  // (src/session.js): ctx reset, every cache clear, name-uids, warnings,
  // strict/host/optimize normalization, post-reset invariants. (foldOptions
  // checked host, sourceType, randomSeed and the memory limits.)
  beginSession({
    emitter, globals: GLOBALS, hooks: emissionHooks(),
    source: code, optimize: opts.optimize, warnings: opts.warnings, strict: opts.strict, host: opts.host, alloc: opts.alloc,
  })
  configureMemory(opts)
  configureFixedMemory(opts.fixedMemory)
  if (opts.modules) ctx.module.importSources = opts.modules
  if (opts.imports) {
    ctx.module.hostImports = opts.imports
    if (importsMayReturnExternal(opts.imports)) setLinkDemand('external')
  }
  // Parser for compile-time import bundling (prepareModule). Injected, not
  // imported by prepare — see ctx.transform.parse note in prepare/index.js.
  ctx.transform.parse = parse
  ctx.transform.resolveUrl = resolveUrl
  // jzify runs by default — accept the full JS subset (function/var/switch lowered to
  // arrows/let/if). `strict: true` skips it, so prepare rejects disallowed JS features
  // and the pure canonical subset is enforced. subscript handles ASI natively.
  if (!opts.strict) ctx.transform.jzify = jzify
  if (opts.noTailCall) ctx.transform.noTailCall = true
  // set before any runtime module initializes: its scans read it (compilePipeline below)
  if (opts.noSimd || opts.optimize?.noSimd) ctx.transform.noSimd = true
  if (opts.noEhAbort) ctx.transform.noEhAbort = true
  if (opts.inspect) ctx.transform.inspect = true
  if (opts.helperCounters) ctx.transform.helperCounters = true
  if (opts.helperCallsites) ctx.transform.helperCallsites = opts.helperCallsites
  // Internal self-compile artifact profile: compact the compiler kernel's own
  // collection tables without changing collection layout in user outputs.
  if (opts._compactCollections) ctx.transform.compactCollections = true
  if (opts.importMetaUrl) ctx.transform.importMetaUrl = String(opts.importMetaUrl)
  if (opts.randomSeed !== undefined) ctx.transform.randomSeed = opts.randomSeed
  if (opts._interp) {
    for (const [name, fn] of Object.entries(opts._interp)) {
      if (name.startsWith('__ext_')) continue
      if (!ctx.transform.targetProfile.envImports) throw new Error(`host:'wasi' does not support _interp['${name}']: env imports are unavailable in WASI. Implement it natively.`)
      setLinkDemand('external')
      const params = Array(fn.length).fill(['param', 'f64'])
      ctx.module.imports.push(['import', '"env"', `"${name}"`, ['func', `$${name}`, ...params, ['result', 'f64']]])
    }
  }
}

// One compilation at a time: the pipeline runs on the shared context, which a
// nested compile() would reset under it. Advisories reach their callback once
// the compilation is over (flushWarnings), so a callback may compile again.
let compiling = false
const jzCompileInner = (code, opts = {}, jzify) => {
  if (compiling) throw new Error('jz: compile() called while a compilation is active; warnings are delivered after it returns, and a warning callback may compile then')
  compiling = true
  try { return compilePipeline(code, opts, jzify) }
  finally { compiling = false; flushWarnings() }
}
const compilePipeline = (code, opts = {}, jzify) => {
  const mapOptions = opts.sourceMap || null, originalSource = code
  const prefix = opts.define ? defineBindings(opts.define) : ''
  if (prefix) code = prefix + code.replace(/^#![^\n\r\u2028\u2029]*/, text => ' '.repeat(text.length))
  if (mapOptions) opts = { ...opts, optimize: false }
  const profiler = compileProfiler(opts.profile)
  const time = (name, fn) => profiler ? profiler.time(name, fn) : fn()

  setupCtx(code, opts, jzify)   // post-reset invariants assert inside beginSession
  ctx.error.lead = prefix.length
  ctx.transform.sourceMap = !!mapOptions

  // The canonical front half (src/front.js): parse →
  // liftIIFEs → jzify → prepare → preEval — ONE function shared verbatim with
  // every self-compile kernel entry, so the two pipelines cannot drift (they did:
  // the kernel skipped preEval — audit P0 2026-07-25).
  let ast = frontHalf(code, {
    strict: opts.strict, sourceType: opts.sourceType || 'jz', jzify, time,
    afterPrepare: DBG_INVARIANTS ? () => assertCtxInvariants(ctx, 'post-prepare') : undefined,
    // Test-only (test/eager-stdlib-parity.js): force every stdlib module's
    // init(ctx) to run up front, the same eager load the region-arena front
    // round needs — proves module load alone (no region hooks involved) is
    // pure registration with no output effect. Never set by real callers.
    eagerStdlib: opts._eagerStdlib,
  })

  // opts.noSimd: force auto-vectorization off regardless of opt level — a
  // portability escape hatch for engines without the SIMD proposal (parallels
  // opts.noTailCall). Must suppress EVERY jz-emitted v128, which is two passes:
  // vectorizeLaneLocal (lane maps, reductions incl. reduceUnroll, byte scans) AND
  // the SLP store-pair packer (within-iteration f64x2). Both off, so `noSimd` is a
  // true scalar baseline — the oracle SIMD-vs-scalar correctness tests compare
  // against (missing one let an SLP miscompile pass as "SIMD == scalar"). Explicit
  // f32x4/i32x4 intrinsics in source are the user's own opt-in and stay. Applied
  // after auto-config so it wins over any re-resolved preset. The runtime's own
  // scans (module/string.js `__str_indexof`, a typed array's lane map) read
  // `ctx.transform.noSimd`, set in setupCtx for either spelling of the option.
  if (ctx.transform.noSimd) {
    ctx.transform.optimize.vectorizeLaneLocal = false
    ctx.transform.optimize.slp = false
  }

  configureDiagnostics(opts)

  const module = time('compile', () => compile(ast, profiler))
  if (DBG_INVARIANTS) assertCtxInvariants(ctx, 'post-compile')

  // host: 'wasi' — error if the wasm would import any env.__ext_* helper. Those exist
  // only to defer to a JS host's value-aware semantics; in a wasmtime/wasmer/deno
  // sandbox the imports either go unsatisfied or are stubbed out and silently produce
  // wrong output. Surface the gap at compile so the caller can pick a comparator,
  // type-annotate the receiver, or wait for native lowering. Read `extImports`
  // (populated in pullStdlib) — `core.includes` has had these removed by then.
  if (!ctx.transform.targetProfile.envImports && ctx.core.extImports?.size) {
    const ext = [...ctx.core.extImports].sort()
    err(
      `host: 'wasi' — compiled wasm would require JS-host imports that wasmtime/wasmer/deno cannot satisfy:\n  ` +
      ext.map(n => `env.${n}`).join('\n  ') +
      `\nThis happens when jz falls through to dynamic dispatch for a method or property without a native lowering. ` +
      `Either annotate the receiver type, switch to a natively-supported method, or compile with the default host.`)
  }

  const cfg = ctx.transform.optimize
  const facts = tailFacts(cfg)
  verifyFixedScratch(module, facts.fixedMemory)
  // The shared final-optimizer tail (src/optimize/watr-tail.js): watr options +
  // watr (the sole generic fixpoint, once) + the ONE narrow post-watr proof
  // repair (hoistGlobalPtrOffset — watr's inliner can merge stable-pointee
  // decodes into one caller past the multi-site hoist threshold; measured
  // load-bearing 2026-07-21, the other two repairs measured dead and deleted).
  // NO post-watr generic optimizer — re-running jz's leaf pipeline here
  // miscompiled (dropped a reassigned-param tee, corrupted divergent-escape
  // SIMD). Shared VERBATIM with scripts/self.js so kernel output cannot drift.
  const optimized = watrTail(module, cfg, { ...facts, time })
  // Snapshot the final, optimized module: run hermetic init once, bake its
  // globals/heap, and remove the spent start. With stable function indices the
  // probe's encoded bodies become the final binary; otherwise the baked AST
  // follows the ordinary encoder path. WAT output always uses that same AST.
  let snapshot
  if (cfg.snapshotInit) {
    snapshot = time('snapshotInit', () => snapshotInit(optimized, watrCompile, !opts.wat))
    if (!snapshot && opts.warnings) warn('snapshot-declined', 'init snapshot declined (host-touching, timer, or shared-memory init) — compiled without it')
  }
  verifyFixedMemory(optimized, facts.fixedMemory)
  if (opts.inspect) ctx.inspect.runtime = captureRuntimeInspect(optimized, ctx.memory.atomic)
  const mapContents = mapOptions ? annotateSource(optimized, originalSource, ctx.error.parts, mapOptions, prefix.length, opts.wat) : null
  try {
    if (opts.wat) {
      const wat = time('watrPrint', () => watrPrint(optimized))
      return opts.inspect ? { wat, inspect: ctx.inspect } : wat
    }
    const wasm = snapshot instanceof Uint8Array ? snapshot : time('watrCompile', () => watrCompile(optimized))
    let bytes = wasm
    // opts.names emits a wasm `name` custom section (symbols for profilers/debuggers).
    if (opts.names || mapOptions) bytes = appendFunctionNames(bytes, optimized)
    if (mapOptions) {
      const map = completeSourceMap(wasm.sourceMap, mapContents)
      if (mapOptions.url !== false) bytes = sourceMapURL(bytes, mapOptions.url ?? 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(map)))
      bytes.sourceMap = map
    }
    return opts.inspect ? { wasm: bytes, inspect: ctx.inspect } : bytes
  } catch (e) {
    // watr surfaces dangling identifiers as "Unknown local|func|global|table|memory $X".
    // That's always a jz codegen leak — we emitted IR that references something never
    // declared (typically: a built-in / stdlib we don't implement). Rewrite to a clean
    // user-facing message instead of leaking watr internals.
    const m = /Unknown (local|func|global|table|memory|type) \$?(\S+)/.exec(e?.message || '')
    if (m) {
      const [, kind, name] = m
      const friendly = kind === 'func' ? `'${name}' is not a known function or built-in`
        : kind === 'global' ? `'${name}' is not a known global or imported binding`
        : `'${name}' is not in scope`
      err(`${friendly} — jz emitted a reference it cannot resolve (likely an unsupported built-in or missing import).`)
    }
    throw e
  }
}

/**
 * Compile, instantiate, and wrap. Works as both jz('code') and jz`code ${val}`.
 * @param {string|TemplateStringsArray} code
 * @param {...any} args - Interpolation values (template tag) or options (string call)
 * @returns {{exports, memory, instance, module}}
 */
