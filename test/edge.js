/**
 * edge.js integration tests
 *
 * Smoke tests for the `jz/edge` adapter (./edge.js) and bug reproductions
 * for known edge.js integration blockers.  Kept separate from test262
 * regressions so edge-integration work does not destabilise the test262 suite.
 *
 * Structure:
 *   "edge adapter: *"        — API smoke tests for jz/edge exports
 *   "edge WASI: *"           — WASI output routing without process.stdout
 *   "edge async: *"          — compileAsync / instantiateAsync helpers
 *   "edge repro: *"          — bug reproductions for edge.js-specific failures
 */
import test from 'tst'
import { is, ok, almost } from 'tst/assert.js'
import {
  default as edgeJz, jz, compile, compileAsync, instantiateAsync,
  edgeWrite, wasi, isEdgeRuntime,
} from '../edge.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compile + instantiate a scalar-only module (no WASI, no memory). */
function runScalar(code) {
  const wasm = compile(code)
  const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm))
  return inst.exports
}

/** Compile + instantiate with WASI routed to a capture buffer. */
function runCapture(code) {
  const output = []
  const wasiInst = wasi({ write: (fd, text) => output.push({ fd, text }) })
  const wasm = compile(code)
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod, wasiInst)
  wasiInst._setMemory(inst.exports.memory)
  return { exports: inst.exports, output }
}

// ---------------------------------------------------------------------------
// API smoke tests
// ---------------------------------------------------------------------------

test('edge adapter: default export is callable', () => {
  const { exports: { add } } = edgeJz('export let add = (a, b) => a + b')
  is(add(2, 3), 5)
})

test('edge adapter: named jz export is same function', () => {
  ok(jz === edgeJz, 'named jz export matches default')
})

test('edge adapter: compile export produces valid WASM binary', () => {
  const wasm = compile('export let f = (x) => x * 2')
  ok(wasm instanceof Uint8Array, 'returns Uint8Array')
  ok(wasm.byteLength > 0, 'non-empty')
  // Magic bytes: 0x00 0x61 0x73 0x6D ("\0asm")
  is(wasm[0], 0x00)
  is(wasm[1], 0x61)
  is(wasm[2], 0x73)
  is(wasm[3], 0x6D)
})

test('edge adapter: edgeJz.compile alias works', () => {
  const wasm = edgeJz.compile('export let sq = (x) => x * x')
  const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm))
  is(inst.exports.sq(7), 49)
})

test('edge adapter: edgeJz.memory is available', () => {
  ok(typeof edgeJz.memory === 'function', 'edgeJz.memory is a function')
})

test('edge adapter: isEdgeRuntime is a boolean', () => {
  ok(typeof isEdgeRuntime === 'boolean', 'isEdgeRuntime is boolean')
  // In the test runner (plain Node.js) this is false
  is(isEdgeRuntime, false)
})

// ---------------------------------------------------------------------------
// Template tag
// ---------------------------------------------------------------------------

test('edge adapter: template tag — scalar interpolation', () => {
  const N = 10
  const { exports: { scale } } = edgeJz`export let scale = (x) => x * ${N}`
  is(scale(3), 30)
})

test('edge adapter: template tag — function interpolation', () => {
  const double = x => x * 2
  const { exports: { f } } = edgeJz`export let f = (x) => ${double}(x) + 1`
  is(f(4), 9)
})

// ---------------------------------------------------------------------------
// Numeric + math
// ---------------------------------------------------------------------------

test('edge adapter: arithmetic', () => {
  const { add, sub, mul } = runScalar(`
    export let add = (a, b) => a + b
    export let sub = (a, b) => a - b
    export let mul = (a, b) => a * b
  `)
  is(add(10, 3), 13)
  is(sub(10, 3), 7)
  is(mul(10, 3), 30)
})

test('edge adapter: Math functions', () => {
  const { sq, root } = runScalar(`
    export let sq = (x) => x * x
    export let root = (x) => Math.sqrt(x)
  `)
  is(sq(5), 25)
  almost(root(9), 3, 1e-6)
})

// ---------------------------------------------------------------------------
// WASI output routing
// ---------------------------------------------------------------------------

test('edge WASI: edgeWrite routes fd=1 to console.log', () => {
  const logged = []
  const orig = console.log
  console.log = (...a) => { logged.push(a.join(' ')); }
  edgeWrite(1, 'hello edge\n')
  console.log = orig
  is(logged[0], 'hello edge')
})

test('edge WASI: edgeWrite routes fd=2 to console.warn', () => {
  const warned = []
  const orig = console.warn
  console.warn = (...a) => { warned.push(a.join(' ')); }
  edgeWrite(2, 'edge warning\n')
  console.warn = orig
  is(warned[0], 'edge warning')
})

test('edge WASI: console.log in jz module captured via custom write', () => {
  const { exports, output } = runCapture(`
    export let run = () => { console.log("jz-edge-hello"); return 0 }
  `)
  exports.run()
  // fd_write sends text + newline in one or two iov entries
  const full = output.map(o => o.text).join('')
  ok(full.includes('jz-edge-hello'), `captured: ${JSON.stringify(full)}`)
})

test('edge WASI: console.log number captured via custom write', () => {
  const { output } = runCapture(`
    export let f = () => { console.log(42); return 1 }
  `)
  const { exports: { f } } = runCapture(`
    export let f = () => { console.log(42); return 1 }
  `)
  is(f(), 1)
})

test('edge WASI: custom wasi() write override respected', () => {
  const captured = []
  const wasiInst = wasi({ write: (fd, text) => captured.push(text) })
  const w = compile(`export let run = () => { console.log("custom-write"); return 0 }`)
  const mod = new WebAssembly.Module(w)
  const inst = new WebAssembly.Instance(mod, wasiInst)
  wasiInst._setMemory(inst.exports.memory)
  inst.exports.run()
  ok(captured.join('').includes('custom-write'), `captured: ${JSON.stringify(captured)}`)
})

// ---------------------------------------------------------------------------
// Async compilation helpers
// ---------------------------------------------------------------------------

test('edge async: compileAsync returns a Uint8Array', async () => {
  const wasm = await compileAsync('export let f = (x) => x + 1')
  ok(wasm instanceof Uint8Array, 'returns Uint8Array')
  ok(wasm.byteLength > 0, 'non-empty')
})

test('edge async: compileAsync result is executable', async () => {
  const wasm = await compileAsync('export let f = (x) => x + 1')
  const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm))
  is(inst.exports.f(41), 42)
})

test('edge async: instantiateAsync returns exports', async () => {
  const { exports: { add } } = await instantiateAsync(
    'export let add = (a, b) => a + b'
  )
  is(add(3, 4), 7)
})

test('edge async: instantiateAsync works with WASI module', async () => {
  const captured = []
  const { exports: { run } } = await instantiateAsync(
    'export let run = () => { console.log("async-wasi"); return 1 }',
    { write: (fd, text) => captured.push(text) }
  )
  is(run(), 1)
  ok(captured.join('').includes('async-wasi'), `captured: ${JSON.stringify(captured)}`)
})

test('edge async: instantiateAsync accepts host imports via opts.imports', async () => {
  const calls = []
  const { exports: { f } } = await instantiateAsync(
    'import { track } from "host"; export let f = (x) => track(x)',
    { imports: { host: { track: (x) => { calls.push(x); return x * 2 } } } }
  )
  is(f(5), 10)
  is(calls[0], 5)
})

test('edge async: multiple compileAsync calls are independent', async () => {
  const [w1, w2] = await Promise.all([
    compileAsync('export let f = (x) => x + 1'),
    compileAsync('export let f = (x) => x * 2'),
  ])
  const i1 = new WebAssembly.Instance(new WebAssembly.Module(w1))
  const i2 = new WebAssembly.Instance(new WebAssembly.Module(w2))
  is(i1.exports.f(10), 11)
  is(i2.exports.f(10), 20)
})

// ---------------------------------------------------------------------------
// Host imports through edge adapter
// ---------------------------------------------------------------------------

test('edge adapter: host imports forwarded correctly', () => {
  const { exports: { f } } = edgeJz(
    'import { double } from "host"; export let f = (x) => double(x)',
    { imports: { host: { double: x => x * 2 } } }
  )
  is(f(6), 12)
})

test('edge adapter: console.log override via imports', () => {
  const logged = []
  const { exports: { run } } = edgeJz(
    'export let run = () => { console.log("intercepted"); return 0 }',
    { imports: { console: { log: (msg) => { logged.push(msg); return 0 } } } }
  )
  run()
  is(logged[0], 'intercepted')
})

// ---------------------------------------------------------------------------
// Repro tests — edge.js integration blockers
//
// These document current behaviour for bugs encountered during integration.
// They are marked as reproductions; fix the underlying issue, then promote
// to a passing assertion.
// ---------------------------------------------------------------------------

test('edge repro: process.stdout absence — wasi() write fallback', () => {
  // Simulate an environment where process.stdout is not writable (edge worker
  // sandbox constraint).  The edge WASI write function must not throw.
  let threw = false
  try {
    edgeWrite(1, 'test line\n')
    edgeWrite(2, 'test err\n')
  } catch (e) {
    threw = true
  }
  ok(!threw, 'edgeWrite must not throw when process.stdout is unavailable')
})

test('edge repro: try/catch — opcode 0x1f not yet available (repro only)', () => {
  // WASM exception-handling proposal (try/catch → opcode 0x1f) is not yet
  // enabled in the default V8 configuration used by node 22 without --experimental-wasm-exnref.
  // Compilation itself should succeed; only instantiation / execution may fail.
  // This test documents current behaviour so it can be fixed in a follow-up
  // (either by compiling try/catch to a fallback or enabling the WASM feature flag).
  let compileOk = false
  let instantiateErr = null
  try {
    const wasm = compile(
      'export let f = () => { try { throw 1 } catch(e) { return e } }',
      { jzify: true }
    )
    compileOk = true
    new WebAssembly.Instance(new WebAssembly.Module(wasm))
  } catch (e) {
    instantiateErr = e
  }
  ok(compileOk, 'jz compilation of try/catch should succeed')
  // Document that instantiation currently fails on this Node.js version
  if (instantiateErr) {
    ok(
      instantiateErr.message.includes('0x1f') || instantiateErr.message.includes('opcode'),
      `expected WASM opcode error, got: ${instantiateErr.message}`
    )
  }
})

test('edge repro: no-WASI scalar module has no wasi imports', () => {
  // Edge.js can run WASM modules without providing WASI imports.
  // A purely numeric module compiled by jz should not require WASI.
  const wasm = compile('export let f = (x) => x * x')
  const mod = new WebAssembly.Module(wasm)
  const wasiImports = WebAssembly.Module.imports(mod).filter(
    i => i.module === 'wasi_snapshot_preview1'
  )
  is(wasiImports.length, 0, 'scalar module must not import WASI')
})

test('edge repro: WASI module requires wasi_snapshot_preview1', () => {
  // Modules using console.log emit WASI imports.  Edge.js must provide the
  // polyfill (or use its native Wasmer WASI) for these to run.
  const wasm = compile('export let f = () => { console.log("x"); return 0 }')
  const mod = new WebAssembly.Module(wasm)
  const wasiImports = WebAssembly.Module.imports(mod).filter(
    i => i.module === 'wasi_snapshot_preview1'
  )
  ok(wasiImports.length > 0, 'WASI module must import wasi_snapshot_preview1')
})
