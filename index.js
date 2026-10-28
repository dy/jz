/** Compile and instantiate JavaScript, with host value interop. */
import { compileSource, normalizeOptions } from './src/compiler.js'
import { serialize } from './src/source-literal.js'
import jzify from './jzify/index.js'
import { instantiate, memory } from './interop.js'

/**
 * Compile jz source to a WASM binary, or WAT text with `wat: true`.
 * Options are index.d.ts; the internal flags tests and tools pass are listed in
 * CONTRIBUTING.md (Public contract and ABI).
 *
 * @param {string} code
 * @param {object} [opts]
 * @returns {Uint8Array|string}
 */
export const compile = (code, opts = {}) => compileSource(code, opts, jzify)

export { instantiate }

jz.memory = memory

/**
 * Compile and instantiate: jz('code', opts) or jz`code ${value}`.
 * jz.memory(descriptor?) makes a memory several modules share, its values read and written from the host.
 *
 * @example
 * const { exports: { add } } = jz('export let add = (a, b) => a + b')
 * add(2, 3)  // 5
 *
 * @returns {{exports, memory, instance, module}}
 */
export default function jz(code, ...args) {
  // Template tag: jz`code ${val}` — numbers, functions, strings, arrays, objects
  if (Array.isArray(code)) {
    const interp = {}, data = {}, define = {}

    let src = code[0]
    for (let i = 0; i < args.length; i++) {
      const v = args[i]
      if (typeof v === 'function') {
        const key = `$$${i}`; interp[key] = v; src += key
      } else {
        const s = serialize(v)
        if (s !== null && (typeof v === 'number' || typeof v === 'boolean')) {
          // Parentheses keep a negative literal from joining the preceding operator.
          src += `(${s})`
        } else if (s !== null) {
          // Strings, arrays, objects — hoist as compile-time literal
          const key = `$$${i}`
          define[key] = v
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
    const hasInterp = Object.keys(interp).length
    const tplOpts = { _interp: hasInterp ? interp : null, ...(Object.keys(define).length && { define }) }
    const result = instantiate(compile(src, tplOpts), tplOpts)
    // Patch data getters: allocate values in WASM memory, update closure refs
    for (const [, { val, ref }] of Object.entries(data)) {
      if (typeof val === 'string') ref.ptr = result.memory.String(val)
      else if (Array.isArray(val)) ref.ptr = result.memory.Array(val)
      else ref.ptr = result.memory.Object(val)
    }
    return result
  }

  // String call: jz('code', opts?) — compile + instantiate + wrap
  const callOpts = normalizeOptions(args[0])
  const out = compile(code, callOpts)
  // The internal `inspect` flag returns { wasm, inspect }: the analysis rides on the result
  const inspected = out && typeof out === 'object' && 'wasm' in out
  const result = instantiate(inspected ? out.wasm : out, callOpts)
  if (inspected) result.inspect = out.inspect
  if (callOpts.warnings) result.warnings = callOpts.warnings.entries
  return result
}
