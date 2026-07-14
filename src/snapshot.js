/**
 * Pre-eval tier 3 — module-init snapshotting (V8-snapshot style).
 *
 * Runs the module's OWN top-level init (`__start`) once at COMPILE TIME and
 * bakes the result into the artifact: the post-init heap image becomes the data
 * segment, every mutable global's post-init value becomes its declared
 * initializer, and `__start` is deleted. Instantiation then costs zero init —
 * the init-built tables (watr's OPCODE/IMM dicts, interned atoms, schema
 * registries, lookup tables) are pure data, and the init-vs-runtime storage
 * bug class (durable-dangler landmines) loses its init half entirely.
 *
 * Soundness is proven DYNAMICALLY, not assumed:
 *  - the probe instance's env imports are throwing stubs — if init calls ANY
 *    host function, instantiation throws and the snapshot is declined (the
 *    module compiles exactly as before);
 *  - modules whose `__start` textually reads an IMPORTED GLOBAL are declined
 *    statically (a read can't be made to throw);
 *  - non-returning starts (the `__timer_loop` tail) and shared memories are
 *    declined statically.
 * Determinism: everything `__start` can reach without the host is arithmetic
 * over the module's own statics — Date/random/imports all live behind the env
 * boundary the stubs seal.
 *
 * The capture round-trips exact bits: f64 globals are read back through a
 * Float64Array view (a JS number preserves any payload as long as no
 * arithmetic touches it) and re-emitted as `nan:0x…` literals when NaN-boxed,
 * `-0`-aware decimal otherwise.
 *
 * Host-only by construction (needs WebAssembly instantiation of the probe):
 * the self-host kernel never passes the flag; a typeof guard declines cleanly.
 */
import { i64Hex } from '../layout.js'

const findNode = (mod, pred) => mod.find(n => Array.isArray(n) && pred(n))
const findAll = (mod, pred) => mod.filter(n => Array.isArray(n) && pred(n))

// Per-byte escape for a watr data-segment string literal (mirror of
// compile/index.js's escBytes, over raw bytes instead of charCodes).
const escImage = (bytes) => {
  let esc = ''
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]
    if (c >= 32 && c < 127 && c !== 34 && c !== 92) esc += String.fromCharCode(c)
    else esc += '\\' + c.toString(16).padStart(2, '0')
  }
  return esc
}

const f64BitsLit = (bits) => {
  bits = BigInt.asUintN(64, bits)
  if ((bits & 0x7FF0000000000000n) === 0x7FF0000000000000n && (bits & 0xFFFFFFFFFFFFFn) !== 0n)
    return `nan:${i64Hex(bits)}`                    // NaN (boxed or plain): exact payload
  const v = new Float64Array(new BigUint64Array([bits]).buffer)[0]
  if (Object.is(v, -0)) return '-0'
  if (v === Infinity) return 'inf'
  if (v === -Infinity) return '-inf'
  return String(v)                                  // shortest round-trip = exact
}
const f32BitsLit = (bits) => {
  const v = new Float32Array(new Int32Array([bits | 0]).buffer)[0]
  if ((bits & 0x7F800000) === 0x7F800000 && (bits & 0x7FFFFF) !== 0)
    return `nan:0x${(bits >>> 0).toString(16)}`
  if (Object.is(v, -0)) return '-0'
  if (v === Infinity) return 'inf'
  if (v === -Infinity) return '-inf'
  return String(v)
}

/** Mutates `module` (the final watr AST) in place. Returns true if snapshotted,
 *  false if declined (module untouched). */
export function snapshotInit(module, watrCompile) {
  if (typeof WebAssembly === 'undefined') return false
  if (!Array.isArray(module) || module[0] !== 'module') return false

  // Init lives in a `(start)` directive (js host) or, under the WASI reactor
  // convention, in a func exported as `_initialize` (host: 'wasi' never emits a
  // start section — the p1 ABI forbids WASI calls there).
  const startDir = findNode(module, n => n[0] === 'start')
  const startFn = startDir
    ? findNode(module, n => n[0] === 'func' && n[1] === startDir[1])
    : findNode(module, n => n[0] === 'func' && n.some(c => Array.isArray(c) && c[0] === 'export' && c[1] === '"_initialize"'))
  if (!startFn) return false                                       // nothing to snapshot
  const startName = startFn[1]
  const startText = JSON.stringify(startFn)
  if (startText.includes('__timer_loop')) return false             // non-returning start

  // Shared/imported memory: the image belongs to the host — decline.
  const memNode = findNode(module, n => n[0] === 'memory')
  if (!memNode) return false
  const imports = findAll(module, n => n[0] === 'import')
  if (imports.some(n => JSON.stringify(n).includes('"memory"'))) return false

  // Imported GLOBALS read during init can't be stub-detected — decline statically.
  const importedGlobals = imports
    .filter(n => n.some(c => Array.isArray(c) && c[0] === 'global'))
    .map(n => n.find(c => Array.isArray(c) && c[0] === 'global')?.[1])
    .filter(Boolean)
  if (importedGlobals.some(g => startText.includes(`"${g}"`) || startText.includes(`${g}"`))) return false

  const globals = findAll(module, n => n[0] === 'global' && typeof n[1] === 'string')

  // ── probe: synthesize a bit-exact GETTER per global, encode, instantiate with
  // sealing stubs. Direct `WebAssembly.Global.value` reads are useless for the
  // f64 globals that matter most: the JS API canonicalizes NaN payloads at the
  // boundary, wiping every NaN-boxed pointer. An exported func returning
  // `i64.reinterpret_f64` crosses as BigInt — payload intact. f32 → i32 for the
  // same reason; i32/i64 read direct.
  const gtype = (g) => {
    const m = g.find(c => Array.isArray(c) && c[0] === 'mut')
    return m ? m[1] : g.find(c => typeof c === 'string' && c !== g[1] && ['i32', 'i64', 'f32', 'f64', 'v128'].includes(c))
  }
  const getters = []
  for (const g of globals) {
    const ty = gtype(g)
    if (!ty || ty === 'v128') continue
    const body = ty === 'f64' ? ['i64.reinterpret_f64', ['global.get', g[1]]]
      : ty === 'f32' ? ['i32.reinterpret_f32', ['global.get', g[1]]]
      : ['global.get', g[1]]
    getters.push(['func', ['export', `"__snapg${g[1]}"`], ['result', ty === 'f64' ? 'i64' : ty === 'f32' ? 'i32' : ty], body])
  }
  module.push(...getters)
  let inst
  try {
    const bytes = watrCompile(module)
    const stubs = {}
    for (const imp of imports) {
      const fn = imp.find(c => Array.isArray(c) && c[0] === 'func')
      const gl = imp.find(c => Array.isArray(c) && c[0] === 'global')
      const modName = JSON.parse(imp[1]), name = JSON.parse(imp[2])  // keyed by import module: env AND wasi_snapshot_preview1
      if (fn) (stubs[modName] ||= {})[name] = () => { throw new Error('__hermetic__') }
      else if (gl) (stubs[modName] ||= {})[name] = new WebAssembly.Global({ value: 'i64' }, 0n)
    }
    inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), stubs)
    // Reactor form: init doesn't run at instantiation — drive it explicitly so the
    // hermeticity stubs get their chance to throw (start-section form ran above).
    if (!startDir) inst.exports._initialize()
  } catch (e) {
    module.length -= getters.length                                // restore, decline
    return false
  }

  // ── capture ──
  const ex = inst.exports
  const heapFn = ex['__snapg$__heap']
  if (!heapFn) { module.length -= getters.length; return false }
  const heapTop = Number(heapFn())
  const image = new Uint8Array(ex.memory.buffer.slice(0, heapTop))

  const captured = new Map()
  for (const g of globals) {
    const snap = ex[`__snapg${g[1]}`]
    if (snap) captured.set(g[1], snap())                           // i64→BigInt (bit-exact), i32→number
  }

  // ── bake ──
  module.length -= getters.length                                  // drop probe getters
  for (const g of globals) {
    if (!captured.has(g[1])) continue
    const mutIdx = g.findIndex(c => Array.isArray(c) && c[0] === 'mut')
    if (mutIdx === -1) continue                                    // immutable: init already exact
    const ty = g[mutIdx][1]
    const v = captured.get(g[1])                                   // f64 arrives as raw i64 BITS (BigInt)
    const lit = ty === 'f64' ? f64BitsLit(BigInt(v))
      : ty === 'f32' ? f32BitsLit(Number(v))
      : ty === 'i64' ? String(BigInt(v))
      : String(Number(v) | 0)
    g[g.length - 1] = [`${ty}.const`, lit]
  }
  // data segment ← post-init image (contains the original statics as its prefix)
  const dataNode = findNode(module, n => n[0] === 'data' && Array.isArray(n[1]) && n[1][0] === 'i32.const' && Number(n[1][1]) === 0)
  const imageStr = '"' + escImage(image) + '"'
  if (dataNode) dataNode[2] = imageStr
  else module.push(['data', ['i32.const', '0'], imageStr])
  // memory floor must cover the image
  const pages = Math.max(1, Math.ceil(image.length / 65536))
  for (let i = 1; i < memNode.length; i++)
    if (typeof memNode[i] === 'string' && /^\d+$/.test(memNode[i])) { if (Number(memNode[i]) < pages) memNode[i] = String(pages); break }
    else if (typeof memNode[i] === 'number') { if (memNode[i] < pages) memNode[i] = pages; break }
  // __start is spent
  if (startDir) module.splice(module.indexOf(startDir), 1)
  module.splice(module.indexOf(startFn), 1)
  // Reactor form: WASI command wrappers self-init via a void `call $__start` —
  // init is baked into the image now, so those calls must go with the func.
  const stripCalls = (n) => {
    for (let i = n.length - 1; i >= 0; i--) {
      const c = n[i]
      if (!Array.isArray(c)) continue
      if (c[0] === 'call' && c[1] === startName && c.length === 2) n.splice(i, 1)
      else stripCalls(c)
    }
  }
  for (const f of findAll(module, n => n[0] === 'func')) stripCalls(f)
  return true
}
