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
 * interop.js — also exported as the standalone `jz/interop` subpath for
 * hosts that want to run prebuilt jz wasm without pulling the compiler.
 *
 * @module jz/compiler
 */

import { captureRuntimeInspect } from './compile/func-inspect.js'
import { configureFixedMemory, verifyFixedScratch, verifyFixedMemory } from './compile/fixed-memory.js'
import { DBG_INVARIANTS, assertCtxInvariants } from './debug.js'
import { parse } from './parse.js'
import watrCompile, { sourceMapURL } from "watr/compile";
import { sourceMapOptions, annotateSource, completeSourceMap } from './source-map.js'
import { snapshotInit } from "./snapshot.js";
import watrPrint from "watr/print";
import { ctx, err, warn, setLinkDemand, flushWarnings } from './ctx.js'
import { GLOBALS } from './prepare/index.js'
import { frontHalf } from './front.js'
import { configureDiagnostics, beginSession } from './session.js'
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
// same convention the template tag uses for hoisted literals.
const defineBindings = (define) => {
  const parts = []
  for (const [k, v] of Object.entries(define)) {
    const s = serialize(v)
    if (s === null) err(`opts.define['${k}'] is not a compile-time constant — use a number, boolean, string, null, or a literal array/object`)
    parts.push(`let ${k} = ${s}`)
  }
  return parts.length ? parts.join('; ') + '; ' : ''
}

const nowMs = () => globalThis.performance?.now ? globalThis.performance.now() : Date.now()

const compileProfiler = (profile) => {
  if (profile == null) return null
  if (typeof profile !== 'object') throw new TypeError('opts.profile must be an object sink (populated with compile-phase entries/totals); for a wasm name section use opts.names')
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

/**
 * Public option objects → internal flags (see jz.compile's doc). Idempotent; the
 * caller's object is never mutated. Every advanced knob lives inside `memory` and
 * `optimize`, so the top-level surface stays eleven keys.
 */
export const normalizeOptions = (opts) => {
  if (!opts) return {}
  if (opts._normalized) return opts
  const o = { ...opts, _normalized: true }
  const m = o.memory
  if (m && typeof m === 'object' && !(m instanceof WebAssembly.Memory)) {
    // WebAssembly.MemoryDescriptor plus `import` and the `fixed` export contract.
    if (m.initial != null) o.memory = m.initial; else delete o.memory
    if (m.maximum != null) o.maxMemory = m.maximum
    if (m.fixed != null) o.fixedMemory = m.fixed
    if (m.shared) o.sharedMemory = true
    if (m.import) o.importMemory = true
  } else if (m instanceof WebAssembly.Memory && typeof SharedArrayBuffer !== 'undefined' && m.buffer instanceof SharedArrayBuffer) {
    o.sharedMemory = true   // a shared Memory links only against the `shared` memtype
  }
  const opt = o.optimize
  if (opt && typeof opt === 'object') {
    const { simd, tailCall, exceptions, alloc, ...passes } = opt
    if (simd === false) o.noSimd = true
    if (tailCall === false) o.noTailCall = true
    if (exceptions === false) o.noEhAbort = true
    if (alloc === false) o.alloc = false
    o.optimize = passes
  }
  if (typeof o.warnings === 'function') o.warnings = { entries: [], onWarning: o.warnings }
  if (o.why) {
    o.whyNotSimd = true
    o.whyNotRewind = true
    if (!o.warnings) o.warnings = { entries: [] }
  }
  return o
}

// Test configuration shared by every public compiler entry. The in-process
// entry remains available for tests inspecting native analysis state.
let compileTarget = null
export const setCompileTarget = fn => { const previous = compileTarget; compileTarget = fn; return previous }
export const compileSource = (code, options = {}, jzify = null) => {
  const opts = normalizeOptions(options)
  return compileTarget ? compileTarget(code, opts) : compileInProcess(code, opts, jzify)
}

/** In-process entry for tests that inspect ctx, profiles, or analysis snapshots. */
export function compileInProcess(code, opts = {}, jzify = null) {
  try {
    return jzCompileInner(code, opts, jzify)
  } catch (e) {
    // Any uncaught native exception (TypeError, ReferenceError, etc.) is a jz
    // codegen leak — surface it as an internal compile error with the source
    // location we were standing on. err()-thrown errors already pass through.
    if (e?.name === 'TypeError' || e?.name === 'ReferenceError' || e?.name === 'RangeError') {
      // Pass `e` as the cause so the original stack (the real codegen site) survives.
      err(`internal: ${e.message} (jz hit an unsupported case while compiling${ctx.error.node ? '; the AST node above shows the trigger' : ''}). This is a jz bug — please report.`, e)
    }
    throw e
  }
}

// Test-matrix bridge: when JZ_TEST_* env vars are set, inject them as default
// opts so the npm test suite can be re-run under varying configurations (opt
// levels, host, jzify, …) without source changes. User-supplied opts always win
// — env defaults fill only what the caller left unset. Resolved once at module
// load; no-op (single boolean check) when the env is empty (production path).
const TEST_ENV_DEFAULTS = (() => {
  // Guard bare `process` — the compiler bundle must load in browsers/Workers too
  // (this IIFE runs at module import; an unguarded ref throws ReferenceError there).
  const e = (typeof process !== 'undefined' && process.env) || {}
  const out = {}
  if (e.JZ_TEST_OPTIMIZE != null) {
    const v = e.JZ_TEST_OPTIMIZE
    out.optimize = /^-?\d+$/.test(v) ? Number(v) : v === 'false' ? false : v
  }
  if (e.JZ_TEST_HOST) out.host = e.JZ_TEST_HOST
  if (e.JZ_TEST_STRICT) out.strict = e.JZ_TEST_STRICT === '1'
  return out
})()
const HAS_TEST_ENV = Object.keys(TEST_ENV_DEFAULTS).length > 0

// Shared front-half: reset ctx, wire opts → ctx.transform/memory/module/features,
// and inject parse/resolveUrl. Called by `jzCompileInner` (the only entry point
// today). The self-compile entry (scripts/self.js) drives reset itself rather than
// going through this path, since it needs only a minimal, interop-free setup.
const setupCtx = (code, opts, jzify) => {
  if (HAS_TEST_ENV) {
    const merged = { ...opts }
    for (const k of Object.keys(TEST_ENV_DEFAULTS)) if (merged[k] == null) merged[k] = TEST_ENV_DEFAULTS[k]
    opts = merged
  }
  // Session lifecycle — shared verbatim with the self-compile kernel's setupSelf
  // (src/session.js): ctx reset, every cache clear, name-uids, warnings,
  // strict/host/optimize normalization, post-reset invariants.
  if (opts.sourceType != null && opts.sourceType !== 'jz' && opts.sourceType !== 'script' && opts.sourceType !== 'module')
    err(`Invalid sourceType '${opts.sourceType}'. Expected 'jz', 'script', or 'module'.`)
  if (opts.host && opts.host !== 'js' && opts.host !== 'wasi' && opts.host !== 'native') {
    if (opts.host === 'gc') err(`host:'gc' is reserved for a planned wasm-gc backend, not yet implemented. Use 'js' (default — JS host with externref/js-string interop), 'wasi' (standalone runtimes — no env imports), or 'native' (wasm2c/native-lowering lane).`)
    err(`Invalid host '${opts.host}'. Expected 'js' (default), 'wasi', or 'native'.`)
  }
  beginSession({
    emitter, globals: GLOBALS, hooks: emissionHooks(),
    source: code, optimize: opts.optimize, warnings: opts.warnings, strict: opts.strict, host: opts.host, alloc: opts.alloc,
  })
  if (typeof opts.memory === 'number') ctx.memory.pages = opts.memory
  else if (opts.memory) ctx.memory.shared = true
  if (opts.importMemory) ctx.memory.shared = true   // import env.memory instead of exporting own
  // True cross-thread sharing (Workers v1): import env.memory declared with the
  // wasm `shared` memtype and switch the heap bump to atomic RMW. Distinct from
  // importMemory — a plain imported (non-shared) Memory must NOT declare shared
  // or linking fails in the other direction.
  if (opts.sharedMemory) { ctx.memory.shared = true; ctx.memory.atomic = true }
  configureFixedMemory(opts.fixedMemory)
  if (opts.maxMemory != null) {
    if (!Number.isInteger(opts.maxMemory) || opts.maxMemory < 1)
      err(`opts.maxMemory must be a positive integer page count (each page is 64 KiB); got ${opts.maxMemory}`)
    const initialPages = ctx.memory.pages || 1
    if (opts.maxMemory < initialPages)
      err(`opts.maxMemory (${opts.maxMemory}) is below the initial memory size (${initialPages} pages)`)
    ctx.memory.max = opts.maxMemory
  }
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
  if (opts.noEhAbort) ctx.transform.noEhAbort = true
  if (opts.inspect) ctx.transform.inspect = true
  if (opts.helperCounters) ctx.transform.helperCounters = true
  if (opts.helperCallsites) ctx.transform.helperCallsites = opts.helperCallsites
  // Internal self-compile artifact profile: compact the compiler kernel's own
  // collection tables without changing collection layout in user outputs.
  if (opts._compactCollections) ctx.transform.compactCollections = true
  if (opts.importMetaUrl) ctx.transform.importMetaUrl = String(opts.importMetaUrl)
  if (opts.randomSeed !== undefined) {
    if (opts.randomSeed !== true && !Number.isFinite(opts.randomSeed))
      err(`opts.randomSeed must be a finite number (fixed seed — reproducible) or true (seed Math.random from host entropy on first use); got ${typeof opts.randomSeed}`)
    ctx.transform.randomSeed = opts.randomSeed
  }
  if (opts.nativeTimers) ctx.features.blockingTimers = true  // wasmtime CLI: include __timer_loop in _start
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
  const mapOptions = sourceMapOptions(opts.sourceMap, opts.optimize), originalSource = code
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
  // after auto-config so it wins over any re-resolved preset.
  if (opts.noSimd) {
    ctx.transform.optimize.vectorizeLaneLocal = false
    ctx.transform.optimize.slp = false
  }

  configureDiagnostics(opts)

  // opts.stencil: the neighbour-load stencil vectorizer (a[i±1] / 2-D 5-point).
  // Now default-on at optimize:'speed' (proven bit-exact corpus-wide); the opt is two-way so an
  // explicit `false` can still disable it (e.g. to A/B against the scalar path).
  { const v = opts.stencil !== undefined ? opts.stencil : opts.experimentalStencil; if (v !== undefined && ctx.transform.optimize) ctx.transform.optimize.stencil = !!v }

  // opts.outerStrip: the outer-loop strip-mine vectorizer (2 adjacent pixels in f64x2
  // lanes over an inner reduction). Default-on at speed; two-way like stencil.
  { const v = opts.outerStrip !== undefined ? opts.outerStrip : opts.experimentalOuterStrip; if (v !== undefined && ctx.transform.optimize) ctx.transform.optimize.outerStrip = !!v }

  // opts.toneMap: the mixed-lane log-tonemap vectorizer (i32 dens[i] → f64 log →
  // i32 pack → px[i], 2-wide f64x2 island). Default-on at speed; two-way like the others.
  { const v = opts.toneMap !== undefined ? opts.toneMap : opts.experimentalToneMap; if (v !== undefined && ctx.transform.optimize) ctx.transform.optimize.toneMap = !!v }

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
  verifyFixedScratch(module)
  // The shared final-optimizer tail (src/optimize/watr-tail.js): watr options +
  // watr (the sole generic fixpoint, once) + the ONE narrow post-watr proof
  // repair (hoistGlobalPtrOffset — watr's inliner can merge stable-pointee
  // decodes into one caller past the multi-site hoist threshold; measured
  // load-bearing 2026-07-21, the other two repairs measured dead and deleted).
  // NO post-watr generic optimizer — re-running jz's leaf pipeline here
  // miscompiled (dropped a reassigned-param tee, corrupted divergent-escape
  // SIMD). Shared VERBATIM with scripts/self.js so kernel output cannot drift.
  const optimized = watrTail(module, cfg, { ...tailFacts(cfg), time })
  // Snapshot the final, optimized module: run hermetic init once, bake its
  // globals/heap, and remove the spent start. With stable function indices the
  // probe's encoded bodies become the final binary; otherwise the baked AST
  // follows the ordinary encoder path. WAT output always uses that same AST.
  let snapshot
  if (cfg.snapshotInit) {
    snapshot = time('snapshotInit', () => snapshotInit(optimized, watrCompile, !opts.wat))
    if (!snapshot && opts.warnings) warn('snapshot-declined', 'init snapshot declined (host-touching, timer, or shared-memory init) — compiled without it')
  }
  verifyFixedMemory(optimized)
  if (opts.inspect) ctx.inspect.runtime = captureRuntimeInspect(optimized, ctx.memory.atomic)
  const mapContents = mapOptions ? annotateSource(optimized, originalSource, ctx.error.parts, mapOptions, prefix.length, opts.wat) : null
  try {
    if (opts.wat) {
      const wat = time('watrPrint', () => watrPrint(optimized))
      return opts.inspect ? { wat, inspect: ctx.inspect } : wat
    }
    const wasm = snapshot instanceof Uint8Array ? snapshot : time('watrCompile', () => watrCompile(optimized))
    let bytes = wasm
    // opts.names emits a wasm `name` custom section (symbols for profilers/
    // debuggers). opts.profile.names is the older spelling — still honored.
    if (opts.names || opts.profile?.names || mapOptions) bytes = appendFunctionNames(bytes, optimized)
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
