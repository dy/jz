/**
 * jz - JS subset → WASM compiler.
 *
 * # Pipeline stages + contracts
 *
 *   source (string)
 *     ↓  parse (subscript/jessie) — lexing + expression-oriented AST
 *   raw AST: nested arrays `[op, ...args]`, no ctx mutation
 *     ↓  jzify (opt-in via opts.jzify) — lower full-JS subset (var/function/class/switch) to jz-native
 *   desugared AST: arrow functions + let/const/if only
 *     ↓  prepare — validate (reject disallowed ops), normalize (++/--→+=/-=, scope rename),
 *        extract (functions→ctx.func.list with sig), resolve (imports→ctx.module.imports),
 *        track (object-literal schemas via ctx.schema.register)
 *   prepared AST: normalized, with `ctx.func.list` / `ctx.module.imports` / `ctx.schema.list`
 *     populated. Arrow bodies carry no type info yet.
 *     ↓  compile — drives per-function emit, interleaves analysis (locals/valTypes/captures/
 *        narrowing fixpoint) with IR generation via the emitter table (src/emit.js).
 *        Writes: `ctx.func.valTypes`/`.locals`, `ctx.types.*`, `ctx.runtime.*`, `ctx.core.includes`.
 *        Also calls optimizeFunc (src/optimize.js): `hoistPtrType` + fused peephole/inline/memarg walk.
 *   WAT IR: watr S-expression `['module', ...sections]`, every instruction node carries `.type`.
 *     ↓  watrOptimize (opt-out via opts.optimize=false) — CSE, DCE, const folding at WAT level
 *     ↓  optimizeFunc 2nd pass — re-folds rebox/unbox roundtrips that watrOptimize's inliner
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
 * Interop host layer (memory marshaling, wrap, instantiate) lives in src/host.js.
 *
 * @module jz
 */

import { parse } from 'subscript/feature/jessie'
import { compile as watrCompile, print as watrPrint, optimize as watrOptimize } from "watr";
import { ctx, reset, err } from './src/ctx.js'
import prepare, { GLOBALS } from './src/prepare.js'
import compile from './src/compile.js'
import { emitter } from './src/emit.js'
import { optimizeFunc, resolveOptimize } from './src/optimize.js'
import jzify from './src/jzify.js'
import {
  memory as enhanceMemory, instantiate as instantiateRuntime,
} from './src/host.js'

const importSpecMayReturnExternal = (spec) => {
  if (typeof spec === 'function') return true
  return false
}

const importsMayReturnExternal = (imports) => {
  if (!imports) return false
  for (const mod of Object.values(imports))
    for (const spec of Object.values(mod || {}))
      if (importSpecMayReturnExternal(spec)) return true
  return false
}

const nowMs = () => globalThis.performance?.now ? globalThis.performance.now() : Date.now()

const compileProfiler = (profile) => {
  if (!profile) return null
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
 * @param {boolean} [opts.strict] - Reject dynamic features (obj[k], for-in, unknown
 *   receiver method calls) at compile time. Avoids pulling dynamic-dispatch stdlib
 *   into output; large size win for static programs.
 * @param {boolean} [opts.runtimeExports=true] - Export runtime allocator helpers
 *   (`_alloc`, `_clear`) for JS memory wrapping. Set false for standalone host-run
 *   modules that only call exported wasm functions.
 * @param {boolean|number|object} [opts.optimize] - Optimization level/config.
 *   - `false` / `0`: nothing. Fastest compile, largest output (live coding).
 *   - `1`: encoding-compactness only (treeshake + sortLocalsByUse + fusedRewrite-inline).
 *   - `true` / `2` (default): all current passes (watr CSE/DCE/inline + every jz pass).
 *   - `3`: reserved for future aggressive passes (currently == 2).
 *   - `{ level?: 0|1|2|3, watr?: bool, hoistAddrBase?: bool, ... }`: per-pass
 *     overrides on top of the chosen level. See PASS_NAMES in src/optimize.js.
 * @param {object} [opts.profile] - Optional mutable profile sink populated with
 *   `entries` and `totals` for parse / jzify / prepare / compile / plan / watr phases.
 * @param {boolean} [opts.profileNames] - Emit a standard wasm `name` custom
 *   section for profiler/debugger symbolication. Off by default to keep release
 *   artifacts small.
 * @param {string} [opts.importMetaUrl] - Module URL used to lower `import.meta.url`
 *   and static `import.meta.resolve("...")` expressions.
 * @returns {Uint8Array|string}
 */
jz.compile = (code, opts = {}) => {
  const profiler = compileProfiler(opts.profile)
  const time = (name, fn) => profiler ? profiler.time(name, fn) : fn()

  reset(emitter, GLOBALS)
  ctx.error.src = code

  if (opts.memory) ctx.memory.shared = true
  if (opts.memoryPages) ctx.memory.pages = opts.memoryPages
  if (opts.modules) ctx.module.importSources = opts.modules
  if (opts.imports) {
    ctx.module.hostImports = opts.imports
    if (importsMayReturnExternal(opts.imports)) ctx.features.external = true
  }
  // jzify: true → accept full JS subset (function/var/switch lowered to arrows/let/if).
  // Default: strict jz (prepare rejects disallowed JS features). subscript handles ASI natively.
  if (opts.jzify) ctx.transform.jzify = jzify
  if (opts.noTailCall) ctx.transform.noTailCall = true
  if (opts.strict) ctx.transform.strict = true
  if (opts.host) {
    if (opts.host !== 'js' && opts.host !== 'wasi') err(`Invalid host '${opts.host}'. Expected 'js' or 'wasi'.`)
    ctx.transform.host = opts.host
  }
  if (opts.runtimeExports === false) ctx.transform.runtimeExports = false
  if (opts.importMetaUrl) ctx.transform.importMetaUrl = String(opts.importMetaUrl)
  if (opts.nativeTimers) ctx.features.blockingTimers = true  // wasmtime CLI: include __timer_loop in _start
  ctx.transform.optimize = resolveOptimize(opts.optimize)

  if (opts._interp) {
    for (const [name, fn] of Object.entries(opts._interp)) {
      if (name.startsWith('__ext_')) continue;
      if (ctx.transform.host === 'wasi') throw new Error(`host:'wasi' does not support _interp['${name}']: env imports are unavailable in WASI. Implement it natively.`)
      ctx.features.external = true
      const params = Array(fn.length).fill(['param', 'f64'])
      ctx.module.imports.push(['import', '"env"', `"${name}"`, ['func', `$${name}`, ...params, ['result', 'f64']]])
    }
  }

  let parsed = time('parse', () => parse(code))
  if (opts.jzify) parsed = time('jzify', () => jzify(parsed))
  const ast = time('prepare', () => prepare(parsed))
  const module = time('compile', () => compile(ast, profiler))

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
  const optimized = cfg.watr ? time('watrOptimize', () => watrOptimize(module)) : module
  // Final peephole pass: watrOptimize's inliner can re-introduce rebox/unbox at boundaries
  // (e.g. inlined closure body's `i32.wrap_i64 (i64.reinterpret_f64 __env)` next to caller's
  // `boxPtrIR(g)` rebox). Our fusedRewrite folds these, watr's peephole doesn't.
  // Only valuable to re-run when watr ran (watr is what re-introduces the boundaries).
  if (cfg.watr) {
    const postCfg = { ...cfg, __phase: 'post' }
    time('watrReopt', () => {
      for (const node of optimized) if (Array.isArray(node) && node[0] === 'func') optimizeFunc(node, postCfg)
    })
  }
  if (opts.wat) return time('watrPrint', () => watrPrint(optimized))
  const wasm = time('watrCompile', () => watrCompile(optimized))
  return opts.profileNames ? appendFunctionNames(wasm, optimized) : wasm
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
    const result = instantiateRuntime(jz.compile, src, { _interp: hasInterp ? interp : null })
    // Patch data getters: allocate values in WASM memory, update closure refs
    for (const [, { val, ref }] of Object.entries(data)) {
      if (typeof val === 'string') ref.ptr = result.memory.String(val)
      else if (Array.isArray(val)) ref.ptr = result.memory.Array(val)
      else ref.ptr = result.memory.Object(val)
    }
    return result
  }

  // String call: jz('code', opts?) — compile + instantiate + wrap
  return instantiateRuntime(jz.compile, code, args[0] || {})
}

export { jz }
const jzCompile = jz.compile
export { jzCompile as compile }
