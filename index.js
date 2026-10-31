/** Compile and instantiate JavaScript, with host value interop. */
import { compileSource, compileInternal } from './src/compiler.js'
import { normalizeOptions } from './src/options.js'
import { serialize } from './src/source-literal.js'
import jzify from './jzify/index.js'
import { instantiate, memory } from './interop.js'

/**
 * Compile jz source to a WASM binary, or WAT text with `wat: true`.
 * Options are index.d.ts CompileOptions; any other key throws a TypeError.
 *
 * @param {string} code
 * @param {object} [opts]
 * @returns {Uint8Array|string}
 */
export const compile = (code, opts) => compileSource(code, opts, jzify)

export { instantiate }

jz.memory = memory

// The options jz() hands to instantiate alone (index.d.ts Jz: those of
// InstantiateOptions that are no compile option).
const INSTANTIATE_ONLY = ['wasi']

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
    // the interpolated functions are env imports, an internal flag (src/options.js)
    const tplOpts = { _interp: hasInterp ? interp : null, ...(Object.keys(define).length && { define }) }
    const result = instantiate(compileInternal(src, tplOpts, jzify), tplOpts)
    // Patch data getters: allocate values in WASM memory, update closure refs
    for (const [, { val, ref }] of Object.entries(data)) {
      if (typeof val === 'string') ref.ptr = result.memory.String(val)
      else if (Array.isArray(val)) ref.ptr = result.memory.Array(val)
      else ref.ptr = result.memory.Object(val)
    }
    return result
  }

  // String call: jz('code', opts?) — compile options to compile, the rest to instantiate
  const opts = args[0] ?? {}, own = {}, run = {}
  if (typeof opts !== 'object') throw new TypeError(`options take an object; got ${typeof opts}`)
  for (const k of Object.keys(opts)) (INSTANTIATE_ONLY.includes(k) ? run : own)[k] = opts[k]
  if (own.wat) throw new TypeError('jz() instantiates; use compile(src, { wat: true }) for text')
  const flags = normalizeOptions(own)
  const wasm = compileInternal(code, flags, jzify)
  if (flags.imports) run.imports = flags.imports
  const linked = linkedMemory(flags, wasm)
  if (linked) run.memory = linked
  return instantiate(wasm, run)
}

// The memory a module compiled to import one links: the caller's (a jz.memory(),
// a WebAssembly.Memory), else one made to the limits the module declares
// (`memory: { import: true }`, a shared descriptor), its initial pages covering
// the static data. None for a module that owns its memory or needs none.
const linkedMemory = (o, wasm) => {
  const limits = memoryImport(wasm)
  if (!limits) return undefined
  return o.memory instanceof WebAssembly.Memory ? o.memory : memory(limits)
}

// The limits of the memory a module imports (`env.memory`), read off its import section, or null.
const memoryImport = (bytes) => {
  let i = 8
  const leb = () => { let r = 0, s = 0, b; do { b = bytes[i++]; r += (b & 0x7f) * 2 ** s; s += 7 } while (b & 0x80); return r }
  const name = () => { const n = leb(), t = String.fromCharCode(...bytes.subarray(i, i + n)); i += n; return t }
  while (i < bytes.length) {
    const id = bytes[i++], size = leb(), end = i + size
    if (id !== 2) { i = end; continue }
    for (let n = leb(); n > 0; n--) {
      const module = name(), field = name(), kind = bytes[i++]
      if (kind === 0) leb()                                                      // func: its type
      else if (kind === 1) { i++; if (bytes[i++] & 1) leb(); leb() }             // table: reftype, limits
      else if (kind === 2) {                                                     // memory: limits
        const flags = bytes[i++], initial = leb(), maximum = flags & 1 ? leb() : undefined
        if (module === 'env' && field === 'memory') return { initial, maximum, shared: !!(flags & 2) }
      }
      else if (kind === 3) i += 2                                                // global: type, mutability
      else if (kind === 4) { i++; leb() }                                        // tag: attribute, type
    }
    return null
  }
  return null
}
