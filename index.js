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
 *        The emit phase (src/wat/assemble.js optimizeModule) then runs jz's ONLY optimizer pass —
 *        optimizeFunc (src/optimize/index.js): `hoistPtrType` + fused peephole/inline/memarg walk +
 *        auto-vectorization. All lowering, incl. SIMD, happens here — BEFORE watr.
 *   WAT IR: watr S-expression `['module', ...sections]`, every instruction node carries `.type`.
 *     ↓  watOptimize (opt-out via opts.optimize=false) — the SOLE, FINAL optimizer: CSE, DCE, const
 *        fold, inline, coalesce. Runs ONCE, as a fixpoint. No jz pass touches WAT after it (bar the
 *        stable-global-offset hoist, a phase-2 watr-migration candidate). See .work/research.md.
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
import { snapshotInit } from "./src/snapshot.js";
import watrPrint from "watr/print";
import watOptimize from "watr/optimize";
// Required capability since watr ^5.7.11 (locked): determinism of warm
// recompiles depends on this reset — a missing export must fail LOUDLY at
// import, not silently degrade (the pre-5.7.11 optional-property fallback
// masked exactly that hole).
import { resetNameUids } from "watr/optimize";
import { ctx, reset, err, warn, initWarnings, assertCtxInvariants, optFlagsOf } from './src/ctx.js'
import prepare, { GLOBALS } from './src/prepare/index.js'
import { liftIIFEs } from './src/prepare/lift-iife.js'
import { preEval } from './src/prepare/pre-eval.js'
import compile from './src/compile/index.js'
import { resetProgramFactsCache } from './src/compile/program-facts.js'
import { resetBodyFactsCache } from './src/compile/analyze.js'
import { emit, emitter, emitVoid as flat, emitBlockBody as body, emitBoolStr as bool, emitIndex as idx, buildArrayWithSpreads as spread } from './src/compile/emit.js'
import { resolveOptimize } from './src/optimize/index.js'
import { resolveWatrOpts, watrTail } from './src/optimize/watr-tail.js'
export { resolveWatrOpts }
import { VAL } from './src/reps.js'
import jzify from './jzify/index.js'
import { T } from './src/ast.js'
import {
  memory as enhanceMemory, instantiate as instantiateRuntime, toModule,
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

// Serialize a JS value to a jz source literal (numbers/booleans/strings/null/
// undefined + literal arrays/objects). Returns null for anything not expressible
// as a compile-time literal (functions, host objects, circular). Shared by the
// `jz\`…${val}\`` template tag (hoists complex args) and opts.define.
const serialize = (v) => {
  if (v === undefined) return 'undefined'
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
 * jz.pool(source, opts) — SPMD worker pool over ONE shared memory (Workers v1).
 *
 * Compiles `source` with { sharedMemory: true }, instantiates it on the main
 * thread AND in `threads` node worker_threads, all linked to the same
 * WebAssembly.Memory({ shared: true }). Kernels coordinate through shared
 * typed arrays + Atomics (module/atomics.js); strings/objects stay
 * thread-local by the v1 contract.
 *
 * Worker instances link `env.memory` ONLY — a kernel needing other host
 * imports fails instantiation loudly (pure-compute contract).
 *
 *   const p = await jz.pool(src, { threads: 4, pages: 16, maxPages: 256 })
 *   p.exports.setup(...)                    // main-thread instance
 *   await p.run('tile')                     // every worker: tile(workerIndex, threads)
 *   await p.run('tile', a, b)               // extra args broadcast to each worker
 *   p.memory                                // the shared, jz-enhanced memory
 *   await p.terminate()
 *
 * @param {string} source - jz source (compiled once; module shared with workers)
 * @param {object} [opts] - { threads=4, pages=16, maxPages=16384, ...compile opts }
 * @returns {Promise<{exports, memory, module, threads, run, terminate}>}
 */
jz.pool = async function pool(source, opts = {}) {
  const { threads = 4, pages = 16, maxPages = 16384, ...rest } = opts
  const memory = new WebAssembly.Memory({ initial: pages, maximum: maxPages, shared: true })
  const main = jz(source, { ...rest, sharedMemory: true, memory })
  // Computed specifier keeps bundlers (esbuild web dist) from resolving the
  // node builtin statically; browsers get a clear v1 error instead.
  const { Worker } = await import('node:' + 'worker_threads').catch(() => {
    throw new Error('jz.pool v1 runs on node worker_threads; browser Worker support is a follow-up')
  })
  // The worker shim honors the jz:i64exp lane map (exact-bits ABI): an i64 lane
  // takes a BigInt — scalars convert to their f64 bits, boxed pointers (BigInt
  // args from jz.memory.* on the main thread) pass through; i64 results
  // reinterpret back to numbers (v1 kernels return scalars).
  const workerSrc = `
    const { parentPort, workerData } = require('node:worker_threads')
    const inst = new WebAssembly.Instance(workerData.module, { env: { memory: workerData.memory } })
    const dv = new DataView(new ArrayBuffer(8))
    const bits = (x) => (dv.setFloat64(0, x), dv.getBigUint64(0))
    const unbits = (b) => (dv.setBigUint64(0, BigInt.asUintN(64, b)), dv.getFloat64(0))
    const lanes = new Map()
    for (const s of WebAssembly.Module.customSections(workerData.module, 'jz:i64exp'))
      try { for (const e of JSON.parse(new TextDecoder().decode(s))) lanes.set(e.name, e) } catch {}
    parentPort.on('message', (m) => {
      try {
        const sig = lanes.get(m.fn), p = new Set(sig?.p || [])
        const args = m.args.map((x, i) => p.has(i) && typeof x === 'number' ? bits(x) : x)
        let r = inst.exports[m.fn](...args)
        if (sig?.r && typeof r === 'bigint') r = unbits(r)
        parentPort.postMessage({ id: m.id, r })
      } catch (e) { parentPort.postMessage({ id: m.id, e: String(e) }) }
    })
    parentPort.postMessage({ ready: true })`
  const workers = Array.from({ length: threads }, () =>
    new Worker(workerSrc, { eval: true, workerData: { module: main.module, memory } }))
  await Promise.all(workers.map(w => new Promise((res, rej) => {
    w.once('message', res); w.once('error', rej)
  })))
  let seq = 0
  const call = (w, fn, args) => new Promise((res, rej) => {
    const id = seq++
    const on = (m) => { if (m.id !== id) return; w.off('message', on); m.e ? rej(new Error(m.e)) : res(m.r) }
    w.on('message', on)
    w.postMessage({ id, fn, args })
  })
  return {
    exports: main.exports, memory: main.memory, module: main.module, threads,
    run: (fn, ...args) => Promise.all(workers.map((w, i) => call(w, fn, [i, threads, ...args]))),
    terminate: () => Promise.all(workers.map(w => w.terminate())),
  }
}

/**
 * Compile jz source to WASM binary or WAT text. Low-level — no instantiation.
 * @param {string} code - jz source
 * @param {object} [opts]
 * @param {boolean} [opts.wat] - Return WAT text instead of binary
 * @param {boolean} [opts.strict] - Enforce the pure canonical subset: skip jzify
 *   (so full-JS syntax like var/function/class is rejected, not lowered) and reject
 *   dynamic features (obj[k], for-in, unknown receiver method calls) at compile time.
 *   Avoids pulling dynamic-dispatch stdlib into output; large size win for static programs.
 * @param {WebAssembly.Memory|number} [opts.memory] - Owned memory's initial page
 *   count (`memory: N`, 64 KiB/page), or a `WebAssembly.Memory` to share across modules.
 * @param {number} [opts.maxMemory] - Maximum memory pages — emits a ceiling on the
 *   memory type so growth traps past it (sandbox cap). Must be ≥ the initial size.
 *   Default: unbounded.
 * @param {boolean} [opts.sharedMemory] - Import `env.memory` as a SHARED memory (wasm
 *   threads): atomic heap bump, `shared` memtype (max defaults to the 4 GiB ceiling).
 *   Link with `new WebAssembly.Memory({ initial, maximum, shared: true })`.
 * @param {boolean} [opts.importMemory] - Import `env.memory` instead of exporting an
 *   owned memory. For embedding into a host that provides the memory.
 * @param {boolean} [opts.alloc=true] - Export raw allocator helpers
 *   (`_alloc`, `_clear`) for JS memory wrapping. Set false for standalone host-run
 *   modules that only call exported wasm functions.
 * @param {Object<string,*>} [opts.define] - Compile-time constants injected as
 *   top-level bindings before parse, e.g. `{ DEBUG: false, PORT: 8080 }`. Values may
 *   be numbers, booleans, strings, null, or literal arrays/objects.
 * @param {boolean|number|string|object} [opts.optimize] - Optimization level/config.
 *   - `false` / `0`: nothing. Fastest compile, largest output (live coding).
 *   - `1`: encoding-compactness only (treeshake + sortLocalsByUse + fusedRewrite-inline).
 *   - `true` / `2` (default): every stable jz pass + full watr (inlineOnce +
 *     coalesce on; `inline` stays off per watr's own default).
 *   - `3` / `'speed'`: level 2 + larger array/hash initial caps (`arrayMinCap`,
 *     `hashSmallInitCap`) + `hoistConstantPool` off (inline `f64.const` over
 *     mutable globals); trades size for speed.
 *   - `'size'`: full passes with unrolling/SIMD off and tight scalar caps — smallest wasm.
 *   - `{ level?, <pass>?: bool, ... }`: per-pass overrides on top of a base level.
 *     INTERNAL/unstable — pass names track compiler internals (PASS_NAMES in
 *     src/optimize/index.js) and change between versions; prefer the level/string forms.
 * @param {boolean} [opts.noSimd] - Disable auto-vectorization (no jz-emitted v128) for
 *   engines without the SIMD proposal. Explicit f32x4/i32x4 intrinsics still compile.
 * @param {boolean} [opts.whyNotSimd] - Diagnostic: emit a `simd-why-not` warning (via
 *   opts.warnings) for each canonical loop the auto-vectorizer declined, naming the
 *   first blocking op. Finds loops one op away from SIMD. Noisy — off by default.
 * @param {boolean} [opts.experimentalStencil] - Opt-in: vectorize neighbour-load
 *   stencils (`b[i]=f(a[i-1],a[i],a[i+1])`, 2-D 5-point) to f64x2. Bit-exact vs scalar.
 *   Unstable — off by default until proven across the corpus.
 * @param {boolean} [opts.experimentalOuterStrip] - Opt-in: strip-mine a pixel loop whose
 *   per-pixel value is an inner reduction (metaballs-shape) into f64x2 lanes (2 pixels at
 *   once). Bit-exact vs scalar. Unstable — off by default.
 * @param {boolean} [opts.experimentalToneMap] - Mixed-lane log-tonemap vectorizer: a flat
 *   `i32 dens[i] → f64 Math.log → i32 pack → px[i]` loop lifts to a 2-wide f64x2 island
 *   (fern/bifurcation/attractors). Bit-exact vs scalar; default-on at speed, pass `false` to disable.
 * @param {object} [opts.warnings] - Optional mutable warning sink populated with
 *   `entries: [{ code, message, fn?, line?, column? }]`. Heap-growth advisories
 *   fire when a module uses the bump allocator and an export or loop retains
 *   allocations without a host-side memory.reset().
 * @param {object} [opts.profile] - Optional mutable profile sink populated with
 *   `entries` and `totals` for parse / jzify / prepare / compile / plan / watr phases.
 * @param {boolean} [opts.names] - Emit a standard wasm `name` custom section (function
 *   symbols) for profiler/debugger symbolication. (Legacy: `profile.names = true`.)
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
  resetNameUids()         // watr's generated-name counters (inline/outline/…): per-compile, else warm recompiles emit history-dependent WAT text (__inl5 → __inl15)
  resetBodyFactsCache()   // explicit-lifecycle body-facts cache (analyze.js) — per-compile, else a long-lived process retains every analyzed body AST
  ctx.error.src = code
  initWarnings(opts.warnings)
  if (typeof opts.memory === 'number') ctx.memory.pages = opts.memory
  else if (opts.memory) ctx.memory.shared = true
  if (opts.importMemory) ctx.memory.shared = true   // import env.memory instead of exporting own
  // True cross-thread sharing (Workers v1): import env.memory declared with the
  // wasm `shared` memtype and switch the heap bump to atomic RMW. Distinct from
  // importMemory — a plain imported (non-shared) Memory must NOT declare shared
  // or linking fails in the other direction.
  if (opts.sharedMemory) { ctx.memory.shared = true; ctx.memory.atomic = true }
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
  if (opts.helperCounters) ctx.transform.helperCounters = true
  if (opts.helperCallsites) ctx.transform.helperCallsites = opts.helperCallsites
  if (opts.importMetaUrl) ctx.transform.importMetaUrl = String(opts.importMetaUrl)
  if (opts.randomSeed !== undefined) {
    if (opts.randomSeed !== true && !Number.isFinite(opts.randomSeed))
      err(`opts.randomSeed must be a finite number (fixed seed — reproducible) or true (seed Math.random from host entropy on first use); got ${typeof opts.randomSeed}`)
    ctx.transform.randomSeed = opts.randomSeed
  }
  if (opts.nativeTimers) ctx.features.blockingTimers = true  // wasmtime CLI: include __timer_loop in _start
  ctx.transform.optimize = resolveOptimize(opts.optimize)
  ctx.transform.optFlags = optFlagsOf(ctx.transform.optimize)
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

// resolveWatrOpts + the post-watr proof repair moved to src/optimize/watr-tail.js
// (ONE final-optimizer tail shared verbatim with the self-host kernel — the two
// pipelines previously drifted); re-exported above for scripts/audit-fixpoint.mjs.

const jzCompileInner = (code, opts = {}) => {
  if (opts.define) code = defineBindings(opts.define) + code
  const profiler = compileProfiler(opts.profile)
  const time = (name, fn) => profiler ? profiler.time(name, fn) : fn()

  setupCtx(code, opts)
  assertCtxInvariants('post-reset')

  let parsed = time('parse', () => parse(code))
  if (typeof code === 'string' && code.includes(T)) rejectReservedPrefix(parsed)
  // Lambda-lift immediately-invoked arrow literals to typed direct calls — lets SIMD
  // flow through the f64-only closure ABI and drops the closure for every IIFE. Runs
  // BEFORE jzify so it only sees USER arrow IIFEs, not jzify's synthetic wrapper IIFEs
  // (named/recursive function expressions, method shorthand), which keep the closure
  // path. A no-op when there are none.
  parsed = time('liftIIFE', () => liftIIFEs(parsed))
  if (!opts.strict) parsed = time('jzify', () => jzify(parsed))
  let ast = time('prepare', () => prepare(parsed))
  assertCtxInvariants('post-prepare')
  // preEval: fold every statically-evaluable construct (numeric/string/bool chains,
  // pure Math.* calls, zero-arg pure calls incl. lift-iife's IIFEs) down to literals,
  // over the prepared AST + every ctx.func.list body, before compile ever sees them.
  ast = time('preEval', () => preEval(ast))

  // Hidden AST-shape auto-configuration REMOVED (2026-07-22): the default tier
  // silently flipped watr:false / retuned thresholds past size heuristics, so
  // DEAD code changed the optimization of retained code (+30% output size
  // measured at the threshold crossing) and "default" named no stable pipeline.
  // Default now IS the level-2 preset, always. Compile budget is an explicit
  // choice: `optimize: 'fast'` (level-2 shapes with watr off — the former auto
  // behavior, ~2-3× faster compiles on large inputs, bigger/slower output).

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
    ctx.transform.optimize.experimentalSlp = false
  }

  // opts.whyNotSimd (CLI --why-not-simd): emit a `simd-why-not` warning per
  // canonical loop that the auto-vectorizer declined, naming the blocking op —
  // a diagnostic to find loops that are "one op away" from SIMD. Rides the
  // resolved optimize cfg to the vectorizer; off by default (the report is noisy).
  if (opts.whyNotSimd && ctx.transform.optimize) ctx.transform.optimize.whyNotSimd = true

  // opts.experimentalStencil: the neighbour-load stencil vectorizer (a[i±1] / 2-D 5-point).
  // Now default-on at optimize:'speed' (proven bit-exact corpus-wide); the opt is two-way so an
  // explicit `false` can still disable it (e.g. to A/B against the scalar path).
  if (opts.experimentalStencil !== undefined && ctx.transform.optimize) ctx.transform.optimize.experimentalStencil = !!opts.experimentalStencil

  // opts.experimentalOuterStrip: the outer-loop strip-mine vectorizer (2 adjacent pixels in f64x2
  // lanes over an inner reduction). Default-on at speed; two-way like experimentalStencil.
  if (opts.experimentalOuterStrip !== undefined && ctx.transform.optimize) ctx.transform.optimize.experimentalOuterStrip = !!opts.experimentalOuterStrip

  // opts.experimentalToneMap: the mixed-lane log-tonemap vectorizer (i32 dens[i] → f64 log →
  // i32 pack → px[i], 2-wide f64x2 island). Default-on at speed; two-way like the others.
  if (opts.experimentalToneMap !== undefined && ctx.transform.optimize) ctx.transform.optimize.experimentalToneMap = !!opts.experimentalToneMap

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
  // The shared final-optimizer tail (src/optimize/watr-tail.js): watr options +
  // watr (the sole generic fixpoint, once) + the ONE narrow post-watr proof
  // repair (hoistGlobalPtrOffset — watr's inliner can merge stable-pointee
  // decodes into one caller past the multi-site hoist threshold; measured
  // load-bearing 2026-07-21, the other two repairs measured dead and deleted).
  // NO post-watr generic optimizer — re-running jz's leaf pipeline here
  // miscompiled (dropped a reassigned-param tee, corrupted divergent-escape
  // SIMD). Shared VERBATIM with scripts/self.js so kernel output cannot drift.
  const optimized = watrTail(module, cfg, {
    funcCount: ctx.func.list.length,
    boundaryPins: cfg._vectorizedFnNames?.size
      ? [...cfg._vectorizedFnNames].filter(name => ctx.func.map.get(name.slice(1))?.exported)
      : [],
    time,
  })
  // NO post-watr generic optimizer. jz does all lowering — including auto-vectorization — before
  // watr (src/wat/assemble.js optimizeModule → optimizeFunc); watr is the sole generic fixpoint and
  // runs exactly once. Re-running jz's leaf pipeline here dropped a reassigned-param local.tee and
  // corrupted divergent-escape SIMD. The proof repair above is the deliberately narrow exception.
  // Pre-eval tier 3 — module-init snapshotting (src/snapshot.js): run __start once
  // NOW, bake the post-init heap image + global values into the artifact, delete
  // __start. Opt-in (optimize.snapshotInit); declined cleanly (dynamically-proven
  // hermeticity) when init touches the host, loops forever, or memory is shared.
  // Stays HERE (post-watr, post-repair), not grouped earlier with pre-watr passes: it calls
  // watrCompile(optimized) to instantiate a real probe module, and the shape it must instantiate,
  // decline-check, and bake IS the shipped shape — the fully watr-optimized, repair-hoisted module.
  // `sec` inside src/wat/assemble.js optimizeModule (where the pre-watr repair copies live) is not
  // an assembled module at all (bare {funcs, stdlib, start} arrays, no imports/exports/data
  // sections) — watrCompile can't consume it, so snapshotInit has no earlier valid point to run at.
  // Running it before watOptimize instead (module is valid there too) is possible but would change
  // what watr's own fixpoint sees (baked constants vs a live __start) and shift output bytes for
  // every snapshotInit-enabled compile — a real pipeline-order change, not a duplicate-work delete,
  // and out of this increment's scope.
  if (cfg.snapshotInit) {
    const took = time('snapshotInit', () => snapshotInit(optimized, watrCompile))
    if (!took && opts.warnings) warn('snapshot-declined', 'init snapshot declined (host-touching, timer, or shared-memory init) — compiled without it')
  }
  try {
    if (opts.wat) {
      const wat = time('watrPrint', () => watrPrint(optimized))
      return opts.inspect ? { wat, inspect: ctx.inspect } : wat
    }
    const wasm = time('watrCompile', () => watrCompile(optimized))
    let bytes = wasm
    // opts.names emits a wasm `name` custom section (symbols for profilers/
    // debuggers). opts.profile.names is the older spelling — still honored.
    if (opts.names || opts.profile?.names) bytes = appendFunctionNames(bytes, optimized)
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

/**
 * Compile source to a cached `WebAssembly.Module` (compile + validate once).
 * Pair with `instantiate(module, opts)` to spin up many instances without
 * re-validating the bytes each time — the AOT compile is paid once, so repeated
 * instantiation is cheap. Returns a `WebAssembly.Module`, built with the native
 * `wasm:js-string` builtins fast path where the engine supports it.
 *
 *   import { compileModule, instantiate } from 'jz'
 *   const mod = compileModule('export let f = x => x * 2')
 *   const { exports } = instantiate(mod)   // repeat cheaply, no recompile
 *
 * @param {string} code
 * @param {object} [opts] - same options as `compile()`
 * @returns {WebAssembly.Module}
 */
export const compileModule = (code, opts = {}) => {
  const out = jzCompile(code, opts)
  return toModule(out && typeof out === 'object' && 'wasm' in out ? out.wasm : out)
}

export { instantiateRuntime as instantiate }

/**
 * jzify as a standalone source→source transform: full JS in, canonical jz out.
 * Same jzify/ module the compiler runs on every parse (default-on) — re-exported
 * here so browser bundles (dist/jz.js: REPL auto-jzify on paste) and node users
 * (`import { transform } from 'jz'`, also `jz/transform`) share one lowering.
 */
export { default as transform } from './transform.js'
