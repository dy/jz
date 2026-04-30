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

import { parse } from 'subscript/jessie'
import { compile as watrCompile, print as watrPrint, optimize as watrOptimize } from "watr";
import { ctx, reset } from './src/ctx.js'
import prepare, { GLOBALS } from './src/prepare.js'
import compile, { emitter } from './src/compile.js'
import { optimizeFunc } from './src/optimize.js'
import jzify from './src/jzify.js'
import {
  memory as enhanceMemory, instantiate as instantiateRuntime,
} from './src/host.js'

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
 * @returns {Uint8Array|string}
 */
jz.compile = (code, opts = {}) => {
  reset(emitter, GLOBALS)
  ctx.error.src = code

  if (opts.memory) ctx.memory.shared = true
  if (opts.memoryPages) ctx.memory.pages = opts.memoryPages
  if (opts.modules) ctx.module.importSources = opts.modules
  if (opts.imports) { ctx.module.hostImports = opts.imports; ctx.features.external = true }
  // jzify: true → accept full JS subset (function/var/switch lowered to arrows/let/if).
  // Default: strict jz (prepare rejects disallowed JS features). subscript handles ASI natively.
  if (opts.jzify) ctx.transform.jzify = jzify
  if (opts.noTailCall) ctx.transform.noTailCall = true
  if (opts.strict) ctx.transform.strict = true

  if (opts._interp) {
    for (const [name, fn] of Object.entries(opts._interp)) {
      if (name.startsWith('__ext_')) continue;
      ctx.features.external = true
      const params = Array(fn.length).fill(['param', 'f64'])
      ctx.module.imports.push(['import', '"env"', `"${name}"`, ['func', `$${name}`, ...params, ['result', 'f64']]])
    }
  }

  let parsed = parse(code)
  if (opts.jzify) parsed = jzify(parsed)
  const ast = prepare(parsed)
  const module = compile(ast)

  const optimized = opts.optimize !== false ? watrOptimize(module) : module
  // Final peephole pass: watrOptimize's inliner can re-introduce rebox/unbox at boundaries
  // (e.g. inlined closure body's `i32.wrap_i64 (i64.reinterpret_f64 __env)` next to caller's
  // `boxPtrIR(g)` rebox). Our fusedRewrite folds these, watr's peephole doesn't.
  if (opts.optimize !== false) {
    for (const node of optimized) if (Array.isArray(node) && node[0] === 'func') optimizeFunc(node)
  }
  return opts.wat ? watrPrint(optimized) : watrCompile(optimized)
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
