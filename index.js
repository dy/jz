/**
 * jz - JS subset → WASM compiler.
 *
 * Pipeline: parse(subscript) → prepare(AST) → compile(AST) → watr → binary
 * State: shared ctx object (src/ctx.js), reset per call
 * Extension: modules register emitters on ctx.core.emit (see module/)
 *
 * Interop runtime (memory marshaling, wrap, instantiate) lives in src/runtime.js.
 *
 * @module jz
 */

import { parse } from 'subscript/jessie'
import { compile as watrCompile, print as watrPrint, optimize as watrOptimize } from "watr";
import { ctx, reset } from './src/ctx.js'
import prepare, { GLOBALS } from './src/prepare.js'
import compile, { emitter } from './src/compile.js'
import jzify from './src/jzify.js'
import {
  UNDEF_NAN, NULL_NAN, ptr as makePtr, offset as getOffset, type as getType, aux as getAux,
  memory as enhanceMemory, wrap as wrapExports, instantiate as instantiateRuntime,
} from './src/runtime.js'

/**
 * jz — JS subset → WASM compiler.
 *
 * jz('code') or jz`code` → { exports, memory, instance, module }
 * jz.compile('code') → Uint8Array (raw WASM binary)
 * jz.compile('code', { wat: true }) → string (WAT text)
 * jz.wrap(mod, inst) → wrapped exports (defaults, rest params)
 * jz.memory([src]) → enhanced WebAssembly.Memory (read/write JS↔WASM values)
 *
 * @example
 * const { exports: { add } } = jz('export let add = (a, b) => a + b')
 * add(2, 3)  // 5
 */
jz.UNDEF_NAN = UNDEF_NAN
jz.NULL_NAN = NULL_NAN
jz.ptr = makePtr
jz.offset = getOffset
jz.type = getType
jz.aux = getAux
jz.memory = enhanceMemory
jz.wrap = wrapExports
jz.instantiate = (code, opts = {}) => instantiateRuntime(jz.compile, code, opts)

/**
 * Compile jz source to WASM binary or WAT text. Low-level — no instantiation.
 * @param {string} code - jz source
 * @param {object} [opts]
 * @param {boolean} [opts.wat] - Return WAT text instead of binary
 * @returns {Uint8Array|string}
 */
jz.compile = (code, opts = {}) => {
  reset(emitter, GLOBALS)
  ctx.error.src = code

  if (opts.memory) ctx.memory.shared = true
  if (opts.memoryPages) ctx.memory.pages = opts.memoryPages
  if (opts.modules) ctx.module.importSources = opts.modules
  if (opts.imports) ctx.module.hostImports = opts.imports
  // jzify: true → accept full JS subset (function/var/switch lowered to arrows/let/if).
  // Default: strict jz (prepare rejects disallowed JS features). subscript handles ASI natively.
  if (opts.jzify) ctx.transform.jzify = jzify

  if (opts._interp) {
    for (const [name, fn] of Object.entries(opts._interp)) {
      if (name.startsWith('__ext_')) continue;
      const params = Array(fn.length).fill(['param', 'f64'])
      ctx.module.imports.push(['import', '"env"', `"${name}"`, ['func', `$${name}`, ...params, ['result', 'f64']]])
    }
  }

  let parsed = parse(code)
  if (opts.jzify) parsed = jzify(parsed)
  const ast = prepare(parsed)
  const module = compile(ast)

  const optimized = opts.optimize !== false ? watrOptimize(module) : module
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
    const result = jz.instantiate(src, { _interp: hasInterp ? interp : null })
    // Patch data getters: allocate values in WASM memory, update closure refs
    for (const [, { val, ref }] of Object.entries(data)) {
      if (typeof val === 'string') ref.ptr = result.memory.String(val)
      else if (Array.isArray(val)) ref.ptr = result.memory.Array(val)
      else ref.ptr = result.memory.Object(val)
    }
    return result
  }

  // String call: jz('code', opts?) — compile + instantiate + wrap
  return jz.instantiate(code, args[0] || {})
}

export { jz }
const jzCompile = jz.compile
export { jzCompile as compile }
