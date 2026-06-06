/**
 * jz - JS subset → WASM compiler.
 *
 * # Pipeline stages + contracts
 *
 *   source (string)
 *     ↓  parse (subscript/jessie) — lexing + expression-oriented AST
 *   raw AST: nested arrays `[op, ...args]`, no ctx mutation
 *     ↓  jzify (default-on; skipped under opts.strict) — lower full-JS subset (var/function/class/switch) to jz-native
 *   desugared AST: arrow functions + let/const/if only
 *     ↓  prepare — validate (reject disallowed ops), normalize (++/--→+=/-=, scope rename),
 *        extract (functions→ctx.func.list with sig), resolve (imports→ctx.module.imports),
 *        track (object-literal schemas via ctx.schema.register)
 *   prepared AST: normalized, with `ctx.func.list` / `ctx.module.imports` / `ctx.schema.list`
 *     populated. Arrow bodies carry no type info yet.
 *     ↓  compile — drives per-function emit, interleaves analysis (locals/valTypes/captures/
 *        narrowing fixpoint) with IR generation via the emitter table (src/compile/emit.js).
 *        Writes: `ctx.func.valTypes`/`.locals`, `ctx.types.*`, `ctx.runtime.*`, `ctx.core.includes`.
 *        Also calls optimizeFunc (src/optimize/index.js): `hoistPtrType` + fused peephole/inline/memarg walk.
 *   WAT IR: watr S-expression `['module', ...sections]`, every instruction node carries `.type`.
 *     ↓  watOptimize (opt-out via opts.optimize=false) — CSE, DCE, const folding at WAT level
 *     ↓  optimizeFunc 2nd pass — re-folds rebox/unbox roundtrips that watOptimize's inliner
 *        re-introduces at inline boundaries (caller's boxPtrIR meets callee's
 *        i32.wrap_i64(i64.reinterpret_f64 __env)). watr's peephole doesn't cover this.
 *     ↓  watrPrint (opts.wat=true) → WAT text, or watrCompile → Uint8Array binary
 *
 * # State
 * Single shared `ctx` (src/ctx.js). Reset at compile() entry via `reset(emitter, GLOBALS)`.
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
 * @module jz
 */

import { parse } from './src/parse.js'
import watrCompile from "watr/compile";
import watrPrint from "watr/print";
import watOptimize from "./src/wat/optimize.js";
import { ctx, reset, err, initWarnings, assertCtxInvariants } from './src/ctx.js'
import prepare, { GLOBALS } from './src/prepare/index.js'
import compile from './src/compile/index.js'
import { resetProgramFactsCache } from './src/compile/program-facts.js'
import { emit, emitter, emitVoid as flat, emitBlockBody as body, emitBoolStr as bool, emitIndex as idx, buildArrayWithSpreads as spread } from './src/compile/emit.js'
import { optimizeFunc, collectVolatileGlobals, resolveOptimize } from './src/optimize/index.js'
import jzify from './jzify/index.js'
import { T } from './src/ast.js'
import {
  memory as enhanceMemory, instantiate as instantiateRuntime,
} from './interop.js'

// A host import that's a JS function may hand back any value, including a host
// object — which arrives in wasm as a PTR.EXTERNAL ref. Constants/typed specs can't.
const importsMayReturnExternal = (imports) =>
  !!imports && Object.values(imports).some(mod =>
    Object.values(mod || {}).some(spec => typeof spec === 'function'))

// WHATWG URL resolution for compile-time import.meta lowering. Injected into
// ctx.transform (like parse/jzify) so prepare never references the `URL` global
// directly — keeps the self-host kernel free of host-only built-ins.
const resolveUrl = (spec, base) => new URL(spec, base).href

const nowMs = () => globalThis.performance?.now ? globalThis.performance.now() : Date.now()

const compileProfiler = (profile) => {
  if (profile == null) return null
  if (typeof profile !== 'object') throw new TypeError('opts.profile must be an object sink; use { profile: { names: true } } to emit a wasm name section')
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
      if (name != null) entries.push([funcIdx, name])
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
 * jz — JS subset → WASM compiler.
 *
 * jz('code') or jz`code` → { exports, memory, instance, module }
 * jz.compile('code') → Uint8Array (raw WASM binary)
 * jz.compile('code', { wat: true }) → string (WAT text)
 * jz.memory([src]) → enhanced WebAssembly.Memory (read/write JS↔WASM values)
 *
 * @example
 * const { exports: { add } } = jz('export let add = (a, b) => a + b')
 * add(2, 3)  // 5
 */
jz.memory = enhanceMemory

/**
 * Compile jz source to WASM binary or WAT text. Low-level — no instantiation.
 * @param {string} code - jz source
 * @param {object} [opts]
 * @param {boolean} [opts.wat] - Return WAT text instead of binary
 * @param {boolean} [opts.strict] - Enforce the pure canonical subset: skip jzify
 *   (so full-JS syntax like var/function/class is rejected, not lowered) and reject
 *   dynamic features (obj[k], for-in, unknown receiver method calls) at compile time.
 *   Avoids pulling dynamic-dispatch stdlib into output; large size win for static programs.
 * @param {WebAssembly.Memory|number} [opts.memory] - Shared memory import, or
 *   initial page count. Prefer `memory: N` for owned memory.
 * @param {boolean} [opts.alloc=true] - Export raw allocator helpers
 *   (`_alloc`, `_clear`) for JS memory wrapping. Set false for standalone host-run
 *   modules that only call exported wasm functions.
 * @param {boolean|number|object} [opts.optimize] - Optimization level/config.
 *   - `false` / `0`: nothing. Fastest compile, largest output (live coding).
 *   - `1`: encoding-compactness only (treeshake + sortLocalsByUse + fusedRewrite-inline).
 *   - `true` / `2` (default): every stable jz pass + full watr (inlineOnce +
 *     coalesce on; `inline` stays off per watr's own default).
 *   - `3` / `'speed'`: level 2 + larger array/hash initial caps (`arrayMinCap`,
 *     `hashSmallInitCap`) + `hoistConstantPool` off (inline `f64.const` over
 *     mutable globals); trades size for speed.
 *   - `{ level?: 0|1|2|3, watr?: bool, hoistAddrBase?: bool, ... }`: per-pass
 *     overrides on top of the chosen level. See PASS_NAMES in src/optimize.js.
 * @param {object} [opts.warnings] - Optional mutable warning sink populated with
 *   `entries: [{ code, message, fn?, line?, column? }]`. Heap-growth advisories
 *   fire when a module uses the bump allocator and an export or loop retains
 *   allocations without a host-side memory.reset().
 * @param {object} [opts.profile] - Optional mutable profile sink populated with
 *   `entries` and `totals` for parse / jzify / prepare / compile / plan / watr phases.
 *   Set `profile.names = true` to also emit a standard wasm `name` custom section
 *   for profiler/debugger symbolication.
 * @param {boolean} [opts.profileNames] - Legacy alias for `profile.names`.
 * @param {Object<string,string>} [opts.modules] - Map of module specifier → source
 *   for compile-time `import`/`export` bundling: jz resolves the module graph
 *   in-process from this map instead of reading from disk.
 * @param {boolean} [opts.noTailCall] - Disable proper-tail-call emission (self/mutual
 *   recursion uses ordinary call frames). For engines/tools without the tail-call proposal.
 * @param {boolean} [opts.nativeTimers] - Emit a blocking `__timer_loop` in `_start` so
 *   setTimeout/setInterval fire under a standalone runtime (e.g. the wasmtime CLI) that
 *   has no host event loop. Default: timers defer to the JS host.
 * @param {string} [opts.importMetaUrl] - Module URL used to lower `import.meta.url`
 *   and static `import.meta.resolve("...")` expressions.
 * @param {number|boolean} [opts.randomSeed] - Seed for `Math.random`. Default: seeded
 *   once from host entropy on first use (crypto under `host:'js'`, `random_get` under
 *   WASI) — non-reproducible. Pass a number for a fixed, reproducible seed; `true` forces
 *   entropy explicitly. The randomness syscall is emitted only when `Math.random` is used.
 * @param {boolean} [opts.inspect] - When true, return `{ wasm, inspect }`
 *   (or `{ wat, inspect }` with `opts.wat`) instead of the bare output.
 *   `inspect` carries per-function inferred shapes (params, locals, JSON shapes,
 *   cross-call paramReps) for editor hosts to drive inlay hints / hover types
 *   without re-running the analyzer. Pays a small serialization cost; off by default.
 * @returns {Uint8Array|string|{wasm: Uint8Array, inspect: object}|{wat: string, inspect: object}}
 */
// Test-only compile target. When set (by test/index.js under JZ_TEST_TARGET=jz.wasm)
// every jz.compile / compile / jz() call routes through it instead of the in-process
// compiler — used to run the whole suite against dist/jz.wasm (the jz compiler
// compiled to wasm by jz). null in production: one boolean check on a cold path.
let compileTarget = null
export const _setCompileTarget = (fn) => { compileTarget = fn }
jz.compile = (code, opts = {}) => {
  if (compileTarget) return compileTarget(code, opts)
  try {
    return jzCompileInner(code, opts)
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

// =============================================================================
// Optimization auto-tuning: scan prepared AST + ctx.func.list to infer program
// properties, then emit per-pass overrides. When the user does not explicitly
// configure individual passes, the result is merged in before resolveOptimize()
// so the compiler self-tunes.
// =============================================================================

const AUTO_CFG_LOOP_OPS = new Set(['for', 'while', 'do', 'do-while'])
const AUTO_CFG_TYPED_CTORS = new Set([
  'new.Float32Array', 'new.Float64Array', 'new.Int8Array', 'new.Int16Array',
  'new.Int32Array', 'new.Uint8Array', 'new.Uint16Array', 'new.Uint32Array',
  'new.Uint8ClampedArray',
])

const autoCfgNodeSize = (node) => {
  if (!Array.isArray(node)) return 1
  let n = 1
  for (let i = 1; i < node.length; i++) n += autoCfgNodeSize(node[i])
  return n
}

const autoCfgScanNode = (node, stats, loopDepth) => {
  if (!Array.isArray(node)) return
  const op = node[0]
  if (AUTO_CFG_LOOP_OPS.has(op)) {
    stats.loopCount++
    const d = loopDepth + 1
    if (d > stats.maxLoopDepth) stats.maxLoopDepth = d
    for (let i = 1; i < node.length; i++) autoCfgScanNode(node[i], stats, d)
    return
  }
  if (op === '()') {
    stats.callSites++
    const callee = node[1]
    if (typeof callee === 'string' && AUTO_CFG_TYPED_CTORS.has(callee)) {
      stats.typedArrayCount++
      const args = node[2]
      const argList = args == null ? [] : (Array.isArray(args) && args[0] === ',') ? args.slice(1) : [args]
      const lenLit = typeof argList[0] === 'number' ? argList[0] : null
      if (lenLit != null && lenLit > stats.maxTypedArrayLen) stats.maxTypedArrayLen = lenLit
    }
  }
  if (op === 'str') stats.stringLiteralCount++
  if (op === '=>') stats.closureCount++
  for (let i = 1; i < node.length; i++) autoCfgScanNode(node[i], stats, loopDepth)
}

/** Detect optimization config from source characteristics.
 *  Returns an object of pass overrides; empty object means "use defaults". */
const detectOptimizeConfig = (ast, code) => {
  const s = {
    sourceChars: code?.length || 0,
    funcCount: 0, maxFuncBodySize: 0,
    loopCount: 0, maxLoopDepth: 0,
    typedArrayCount: 0, maxTypedArrayLen: 0,
    stringLiteralCount: 0, closureCount: 0, callSites: 0,
  }
  if (ctx.func?.list) {
    s.funcCount = ctx.func.list.length
    for (const f of ctx.func.list) {
      if (f.body) {
        const sz = autoCfgNodeSize(f.body)
        if (sz > s.maxFuncBodySize) s.maxFuncBodySize = sz
        autoCfgScanNode(f.body, s, 0)
      }
    }
  }
  if (ast) autoCfgScanNode(ast, s, 0)

  const cfg = {}
  // Machine-generated or large code: watr's WAT-level CSE/DCE/inline fights
  // jz's already-optimized IR and inflates output. Disable it automatically.
  const isLarge = s.sourceChars > 4000 || s.funcCount > 40 || s.maxFuncBodySize > 300
  const isMachineLike = s.callSites > 300 && s.stringLiteralCount < 10
  if (isLarge || isMachineLike) cfg.watr = false
  // Typed-array heavy: tighten scalarization thresholds when we see large
  // fixed-size arrays; keep defaults for small/dynamic ones.
  if (s.typedArrayCount > 0 && s.maxTypedArrayLen > 0) {
    cfg.scalarTypedArrayLen = Math.min(32, Math.max(8, s.maxTypedArrayLen + 4))
    cfg.scalarTypedLoopUnroll = s.maxLoopDepth > 1 ? 8 : 16
    cfg.scalarTypedNestedUnroll = s.maxLoopDepth > 1 ? 32 : 128
  }
  // String-heavy: ensure pool sorting is on (already default, but explicit).
  if (s.stringLiteralCount > 30) cfg.sortStrPoolByFreq = true
  // Closure-heavy: ptr hoists pay off.
  if (s.closureCount > 4) {
    cfg.hoistPtrType = true
    cfg.hoistInvariantPtrOffset = true
  }
  return cfg
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
// today). The self-host entry (scripts/self.js) drives reset itself rather than
// going through this path, since it needs only a minimal, interop-free setup.
const setupCtx = (code, opts) => {
  if (HAS_TEST_ENV) {
    const merged = { ...opts }
    for (const k of Object.keys(TEST_ENV_DEFAULTS)) if (merged[k] == null) merged[k] = TEST_ENV_DEFAULTS[k]
    opts = merged
  }
  reset(emitter, GLOBALS, { emit, flat, body, bool, idx, spread })
  resetProgramFactsCache()
  ctx.error.src = code
  initWarnings(opts.warnings)
  if (typeof opts.memory === 'number') ctx.memory.pages = opts.memory
  else if (opts.memory) ctx.memory.shared = true
  if (opts.modules) ctx.module.importSources = opts.modules
  if (opts.imports) {
    ctx.module.hostImports = opts.imports
    if (importsMayReturnExternal(opts.imports)) ctx.features.external = true
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
  if (opts.strict) ctx.transform.strict = true
  if (opts.host) {
    if (opts.host === 'gc') err(`host:'gc' is reserved for a planned wasm-gc backend, not yet implemented. Use 'js' (default — JS host with externref/js-string interop) or 'wasi' (standalone runtimes — no env imports).`)
    if (opts.host !== 'js' && opts.host !== 'wasi') err(`Invalid host '${opts.host}'. Expected 'js' (default) or 'wasi'.`)
    ctx.transform.host = opts.host
  }
  if (opts.alloc === false) ctx.transform.alloc = false
  if (opts.inspect) ctx.transform.inspect = true
  if (opts.importMetaUrl) ctx.transform.importMetaUrl = String(opts.importMetaUrl)
  if (opts.randomSeed !== undefined) {
    if (opts.randomSeed !== true && !Number.isFinite(opts.randomSeed))
      err(`opts.randomSeed must be a finite number (fixed seed — reproducible) or true (seed Math.random from host entropy on first use); got ${typeof opts.randomSeed}`)
    ctx.transform.randomSeed = opts.randomSeed
  }
  if (opts.nativeTimers) ctx.features.blockingTimers = true  // wasmtime CLI: include __timer_loop in _start
  ctx.transform.optimize = resolveOptimize(opts.optimize)
  if (opts._interp) {
    for (const [name, fn] of Object.entries(opts._interp)) {
      if (name.startsWith('__ext_')) continue
      if (ctx.transform.host === 'wasi') throw new Error(`host:'wasi' does not support _interp['${name}']: env imports are unavailable in WASI. Implement it natively.`)
      ctx.features.external = true
      const params = Array(fn.length).fill(['param', 'f64'])
      ctx.module.imports.push(['import', '"env"', `"${name}"`, ['func', `$${name}`, ...params, ['result', 'f64']]])
    }
  }
}

// U+E000 (T) prefixes every jz-generated local. The JS spec forbids it in
// identifiers, but subscript's parser is lenient and accepts it — so a user name
// carrying it could silently alias a compiler temp. Reject it in identifier
// position on the RAW parse (before jzify, which legitimately mints T-prefixed
// temps of its own). String-literal nodes are `[null, …]` and skipped, so
// `"……"` data is fine; only walked when the char is present in source.
const rejectReservedPrefix = (node) => {
  if (!Array.isArray(node)) return
  if (node.length === 2 && node[0] == null) return   // [null, X] — value literal, not an identifier
  for (let i = 1; i < node.length; i++) {
    const v = node[i]
    if (typeof v === 'string') {
      if (v.includes(T)) err(`identifier '${v.split(T).join('\\uE000')}' contains the reserved compiler prefix (U+E000) — jz uses it for generated locals; rename it`)
    } else rejectReservedPrefix(v)
  }
}

const jzCompileInner = (code, opts = {}) => {
  const profiler = compileProfiler(opts.profile)
  const time = (name, fn) => profiler ? profiler.time(name, fn) : fn()

  setupCtx(code, opts)
  assertCtxInvariants('post-reset')

  let parsed = time('parse', () => parse(code))
  if (typeof code === 'string' && code.includes(T)) rejectReservedPrefix(parsed)
  if (!opts.strict) parsed = time('jzify', () => jzify(parsed))
  const ast = time('prepare', () => prepare(parsed))
  assertCtxInvariants('post-prepare')

  // Auto-detect optimization tuning from source characteristics when the user
  // hasn't provided any optimize option. detectOptimizeConfig has two *live*
  // overrides over the level-2 preset: the typed-array scalarization thresholds,
  // and `watr: false` for large/machine-generated code (whose WAT-level CSE/DCE
  // fights jz's already-optimized IR and inflates output). watr is ON at level 2,
  // so that switch is a real override — run the scan when the program either
  // touches typed arrays or is large enough for the machine-code heuristic to
  // bite. `code.length` is the one signal free without scanning; gating on it
  // keeps small programs (the common case) on the no-scan fast path.
  if (opts.optimize == null && (ctx.module.modules.typedarray || code.length > 4000)) {
    const autoCfg = detectOptimizeConfig(ast, code)
    if (Object.keys(autoCfg).length) {
      ctx.transform.optimize = resolveOptimize(autoCfg)
    }
  }

  const module = time('compile', () => compile(ast, profiler))
  assertCtxInvariants('post-compile')

  // host: 'wasi' — error if the wasm would import any env.__ext_* helper. Those exist
  // only to defer to a JS host's value-aware semantics; in a wasmtime/wasmer/deno
  // sandbox the imports either go unsatisfied or are stubbed out and silently produce
  // wrong output. Surface the gap at compile so the caller can pick a comparator,
  // type-annotate the receiver, or wait for native lowering. Read `extImports`
  // (populated in pullStdlib) — `core.includes` has had these removed by then.
  if (ctx.transform.host === 'wasi' && ctx.core.extImports?.size) {
    const ext = [...ctx.core.extImports].sort()
    err(
      `host: 'wasi' — compiled wasm would require JS-host imports that wasmtime/wasmer/deno cannot satisfy:\n  ` +
      ext.map(n => `env.${n}`).join('\n  ') +
      `\nThis happens when jz falls through to dynamic dispatch for a method or property without a native lowering. ` +
      `Either annotate the receiver type, switch to a natively-supported method, or compile with the default host.`)
  }

  const cfg = ctx.transform.optimize
  let watrOpts = typeof cfg.watr === 'object' ? { ...cfg.watr } : true
  if (cfg.vectorizeLaneLocal) {
    if (watrOpts === true) watrOpts = { loopify: false }
    else if (typeof watrOpts === 'object' && watrOpts.loopify === undefined) watrOpts.loopify = false
  }
  const optimized = cfg.watr ? time('watOptimize', () => watOptimize(module, watrOpts)) : module
  // Final peephole pass: watOptimize's inliner can re-introduce rebox/unbox at boundaries
  // (e.g. inlined closure body's `i32.wrap_i64 (i64.reinterpret_f64 __env)` next to caller's
  // `boxPtrIR(g)` rebox). Our fusedRewrite folds these, watr's peephole doesn't.
  // Only valuable to re-run when watr ran (watr is what re-introduces the boundaries).
  if (cfg.watr) {
    // Build global name→type map from ctx.scope.globalTypes for promoteGlobals
    const globalTypesMap = ctx.scope.globalTypes ? new Map([...ctx.scope.globalTypes].map(([k, v]) => [`$${k}`, v])) : null
    time('watrReopt', () => {
      const funcs = optimized.filter(node => Array.isArray(node) && node[0] === 'func')
      const volatileGlobals = collectVolatileGlobals(funcs)
      for (const node of funcs) optimizeFunc(node, cfg, globalTypesMap, volatileGlobals, 'post')
    })
  }
  try {
    if (opts.wat) {
      const wat = time('watrPrint', () => watrPrint(optimized))
      return opts.inspect ? { wat, inspect: ctx.inspect } : wat
    }
    const wasm = time('watrCompile', () => watrCompile(optimized))
    let bytes = wasm
    if (opts.profileNames || opts.profile?.names) bytes = appendFunctionNames(bytes, optimized)
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
export default function jz(code, ...args) {
  // Template tag: jz`code ${val}` — numbers, functions, strings, arrays, objects
  if (Array.isArray(code)) {
    const interp = {}, data = {}, hoisted = []

    // Serialize JS value to jz source literal. Returns null if not serializable.
    const serialize = (v) => {
      if (v === undefined) return 'undefined'  // else falls through → treated as a
      // host object → memory.Object(undefined) → Object.keys(undefined) crash
      if (typeof v === 'number' || typeof v === 'boolean') return String(v)
      if (v === null) return 'null'
      if (typeof v === 'string') return JSON.stringify(v)
      if (Array.isArray(v)) {
        const elems = v.map(serialize)
        return elems.every(e => e !== null) ? `[${elems.join(', ')}]` : null
      }
      if (typeof v === 'object') {
        const props = Object.keys(v).map(k => {
          const s = serialize(v[k])
          return s !== null ? `${k}: ${s}` : null
        })
        return props.every(p => p !== null) ? `{${props.join(', ')}}` : null
      }
      return null
    }

    let src = code[0]
    for (let i = 0; i < args.length; i++) {
      const v = args[i]
      if (typeof v === 'function') {
        const key = `$$${i}`; interp[key] = v; src += key
      } else {
        const s = serialize(v)
        if (s !== null && (typeof v === 'number' || typeof v === 'boolean')) {
          // Scalars inline directly
          src += s
        } else if (s !== null) {
          // Strings, arrays, objects — hoist as compile-time literal
          const key = `$$${i}`
          hoisted.push(`let ${key} = ${s}`)
          src += key
        } else {
          // Non-serializable (host objects, etc.) — post-instantiation getter
          const key = `$$${i}`, ref = { ptr: 0 }
          data[key] = { val: v, ref }; interp[key] = () => ref.ptr
          src += `${key}()`
        }
      }
      src += code[i + 1]
    }
    if (hoisted.length) src = hoisted.join('; ') + '; ' + src
    const hasInterp = Object.keys(interp).length
    const tplOpts = { _interp: hasInterp ? interp : null }
    const result = instantiateRuntime(jz.compile(src, tplOpts), tplOpts)
    // Patch data getters: allocate values in WASM memory, update closure refs
    for (const [, { val, ref }] of Object.entries(data)) {
      if (typeof val === 'string') ref.ptr = result.memory.String(val)
      else if (Array.isArray(val)) ref.ptr = result.memory.Array(val)
      else ref.ptr = result.memory.Object(val)
    }
    return result
  }

  // String call: jz('code', opts?) — compile + instantiate + wrap
  const callOpts = args[0] || {}
  const out = jz.compile(code, callOpts)
  const wasm = out && typeof out === 'object' && 'wasm' in out ? out.wasm : out
  const result = instantiateRuntime(wasm, callOpts)
  const extra = {}
  if (callOpts.inspect && out && typeof out === 'object' && 'inspect' in out) extra.inspect = out.inspect
  if (callOpts.warnings) extra.warnings = callOpts.warnings.entries
  return Object.keys(extra).length ? Object.assign(result, extra) : result
}

export { jz }
const jzCompile = jz.compile
export { jzCompile as compile }
