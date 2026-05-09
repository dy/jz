// WASI and console.log tests
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { run } from './util.js'
import jz, { compile } from '../index.js'
import { wasi } from '../wasi.js'
import { writeFileSync } from 'fs'
import { execSync } from 'child_process'

// === console.log ===

test('console.log: string', () => {
  is(run(`export let f = () => { console.log("ok"); return 1 }`).f(), 1)
})

test('console.log: number', () => {
  is(run(`export let f = () => { console.log(42); return 1 }`).f(), 1)
})

test('console.log: multiple args', () => {
  is(run(`export let f = () => { console.log("x", 1, "y"); return 1 }`).f(), 1)
})

test('host:js console/time imports are demand-driven', () => {
  const consoleImports = WebAssembly.Module.imports(new WebAssembly.Module(
    compile(`export let f = () => { console.log("x"); return 1 }`)
  )).map(i => i.module + '.' + i.name)
  ok(consoleImports.includes('env.print'), `expected env.print: ${consoleImports}`)
  ok(!consoleImports.includes('env.now'), `console.log should not import env.now: ${consoleImports}`)

  const timeImports = WebAssembly.Module.imports(new WebAssembly.Module(
    compile(`export let f = () => Date.now()`)
  )).map(i => i.module + '.' + i.name)
  ok(timeImports.includes('env.now'), `expected env.now: ${timeImports}`)
  ok(!timeImports.includes('env.print'), `Date.now should not import env.print: ${timeImports}`)
})

test('host:js top-level console.log decodes after memory attaches', () => {
  const originalLog = console.log
  const logged = []
  try {
    console.log = (...args) => logged.push(args.join(' '))
    jz(`console.log("boot", undefined, null); export let f = () => 1`)
  } finally {
    console.log = originalLog
  }
  is(logged.length, 1, `expected 1 console.log call, got ${logged.length}: ${JSON.stringify(logged)}`)
  is(logged[0], 'boot undefined null', `logged=${JSON.stringify(logged)}`)
})

test('WASI polyfill: fd_read returns stdin bytes via opts.read', () => {
  const fixture = '{"a":1}'
  const encoder = new TextEncoder()
  const bytes = encoder.encode(fixture)
  let offset = 0
  const captured = []
  const imports = wasi({
    read: (fd, buf) => {
      if (offset >= bytes.length) return 0
      const n = Math.min(buf.length, bytes.length - offset)
      buf.set(bytes.subarray(offset, offset + n))
      offset += n
      return n
    },
    write: (fd, text) => captured.push(text),
  })
  const wasm = compile(`export let f = () => { console.log(readStdin()); return 1 }`, { host: 'wasi' })
  const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm), imports)
  imports._setMemory(inst.exports.memory)
  is(inst.exports.f(), 1)
  is(captured.join('').trim(), fixture)
})

test('WASI polyfill: custom write receives output', () => {
  const captured = []
  const imports = wasi({ write: (fd, text) => captured.push([fd, text]) })
  const wasm = compile(`export let f = () => { console.log("custom"); console.warn("err"); return 1 }`, { host: 'wasi' })
  const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm), imports)
  imports._setMemory(inst.exports.memory)
  is(inst.exports.f(), 1)
  is(captured.map(x => x[1]).join(''), 'custom\nerr\n')
  is(captured.filter(x => x[1] === 'custom')[0][0], 1)
  is(captured.filter(x => x[1] === 'err')[0][0], 2)
})

function runWithCapturedFallback(processValue, source) {
  const originalProcess = globalThis.process
  const originalLog = console.log
  const originalWarn = console.warn
  const logged = []
  const warned = []
  let result
  try {
    Object.defineProperty(globalThis, 'process', { value: processValue, configurable: true })
    console.log = msg => logged.push(msg)
    console.warn = msg => warned.push(msg)
    const imports = wasi()
    const wasm = compile(source, { host: 'wasi' })
    const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm), imports)
    imports._setMemory(inst.exports.memory)
    result = inst.exports.f()
  } finally {
    Object.defineProperty(globalThis, 'process', { value: originalProcess, configurable: true })
    console.log = originalLog
    console.warn = originalWarn
  }
  return { result, logged, warned }
}

test('WASI polyfill: falls back when process is missing', () => {
  const { result, logged, warned } = runWithCapturedFallback(
    undefined,
    `export let f = () => { console.log("no-process"); console.warn("no-stderr"); return 1 }`
  )
  is(result, 1)
  is(logged.join(''), 'no-process')
  is(warned.join(''), 'no-stderr')
})

test('WASI polyfill: falls back when streams are missing', () => {
  const { result, logged, warned } = runWithCapturedFallback(
    {},
    `export let f = () => { console.log("no-stdout"); console.error("no-stderr"); return 1 }`
  )
  is(result, 1)
  is(logged.join(''), 'no-stdout')
  is(warned.join(''), 'no-stderr')
})

test('WASI polyfill: falls back when stream write throws', () => {
  const processValue = {
    stdout: { write() { throw Error('stdout blocked') } },
    stderr: { write() { throw Error('stderr blocked') } },
  }
  const { result, logged, warned } = runWithCapturedFallback(
    processValue,
    `export let f = () => { console.log("blocked-out"); console.error("blocked-err"); return 1 }`
  )
  is(result, 1)
  is(logged.join(''), 'blocked-out')
  is(warned.join(''), 'blocked-err')
})

test('EdgeJS smoke: scalar module has no imports', () => {
  const wasm = compile('export let f = (x) => x * x')
  const mod = new WebAssembly.Module(wasm)
  is(WebAssembly.Module.imports(mod).length, 0)
  const inst = new WebAssembly.Instance(mod)
  is(inst.exports.f(9), 81)
})

// === WASI guardrails for unsupported host-bound constructs ===
// _interp[name] and bare host-global refs both push raw env imports into the wasm.
// The post-compile __ext_* check at index.js doesn't see them (they're not __ext_*),
// so they slip past and produce wasm that fails to instantiate under wasmtime/wasmer.
// Reject at compile time with a construct-specific message.

function throwsCompile(code, opts, match) {
  let error
  try { compile(code, opts) } catch (e) { error = e }
  ok(error && error.message.includes(match), `expected "${match}", got "${error?.message}"`)
}

test('WASI: _interp option throws with construct-specific message', () => {
  throwsCompile(
    `export let f = () => myFn(1)`,
    { host: 'wasi', _interp: { myFn: () => 42 } },
    `_interp['myFn']`
  )
})

test('WASI: _interp does not throw under host:js', () => {
  // The reject is wasi-only; host:'js' is the existing _interp use case.
  let error
  try { compile(`export let f = () => myFn(1)`, { _interp: { myFn: () => 42 } }) }
  catch (e) { error = e }
  is(error, undefined)
})

test('WASI: bare host-global reference throws', () => {
  throwsCompile(
    `export let f = () => globalThis`,
    { host: 'wasi' },
    'globalThis'
  )
})

test('WASI: WebAssembly host-global reference throws', () => {
  throwsCompile(
    `export let f = () => WebAssembly`,
    { host: 'wasi' },
    'WebAssembly'
  )
})

test('WASI: host-global reference does not throw under host:js', () => {
  // host:'js' continues to auto-import host globals as before.
  let error
  try { compile(`export let f = () => globalThis`) }
  catch (e) { error = e }
  is(error, undefined)
})

// === WASI typed-fallback (no JS-host env imports for unknown-type access) ===
// host:'wasi' values are always JSON-derived — PTR.EXTERNAL never appears, so the
// EXTERNAL arm of dynamic prop/method dispatch is dead code. Take the typed path
// directly so the wasm has no unsatisfiable env imports.

function envImports(wasm) {
  return WebAssembly.Module.imports(new WebAssembly.Module(wasm)).filter(i => i.module === 'env')
}

test('WASI: prop access on unknown-type receiver — no env imports', () => {
  const wasm = compile(`export let f = (x) => x.foo`, { host: 'wasi' })
  is(envImports(wasm).length, 0)
})

test('WASI: prop assignment on unknown-type receiver — no env imports', () => {
  const wasm = compile(`export let f = (x, v) => { x.foo = v; return 1 }`, { host: 'wasi' })
  is(envImports(wasm).length, 0)
})

test('WASI: method call on unknown-type receiver — no env imports', () => {
  const wasm = compile(`export let f = (x) => { x.run(); return 1 }`, { host: 'wasi' })
  is(envImports(wasm).length, 0)
})

test('WASI: optional-chain prop access on unknown-type receiver — no env imports', () => {
  const wasm = compile(`export let f = (x) => x?.foo ?? 0`, { host: 'wasi' })
  is(envImports(wasm).length, 0)
})

test('WASI: typed-fallback method dispatch returns undefined on non-callable', () => {
  // Closure-only dispatch: when the resolved property isn't a CLOSURE, return undefined
  // rather than __ext_call'ing it. JSON-derived shape, so the prop resolves to a number.
  const wasm = compile(`
    export let f = () => {
      const o = JSON.parse('{"x":1}')
      const r = o.x()
      return r === undefined ? 1 : 0
    }
  `, { host: 'wasi' })
  const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm), wasi())
  is(inst.exports.f(), 1)
})

// === WASI native runtime tests ===

function hasCmd(cmd) { try { execSync(`which ${cmd}`, { stdio: 'ignore' }); return true } catch { return false } }

test('WASI: command-mode entry returns void', () => {
  for (const name of ['run', '_start']) {
    const captured = []
    const imports = wasi({ write: (fd, text) => captured.push(text) })
    const wasm = compile(`export let ${name} = () => { console.log("hi"); return 42 }`, { host: 'wasi' })
    const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm), imports)
    imports._setMemory(inst.exports.memory)
    is(inst.exports[name](), undefined, `${name}() should return undefined`)
    is(captured.join(''), 'hi\n', `${name} body should still execute`)
  }
})

test('WASI: parametric run/_start keeps direct export', () => {
  // Parametric entries can't form a CLI-callable () -> () wrapper, so the
  // direct f64-returning export survives (caller needs a host that supplies args).
  const wasm = compile(`export let run = (n) => (n | 0) + 1`, { host: 'wasi' })
  const imports = wasi()
  const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm), imports)
  imports._setMemory(inst.exports.memory)
  is(inst.exports.run(7), 8)
})

test('WASI: non-entry exports keep their f64 return', () => {
  const wasm = compile(`export let run = () => 1; export let helper = (x) => x * 2`, { host: 'wasi' })
  const imports = wasi()
  const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm), imports)
  imports._setMemory(inst.exports.memory)
  is(inst.exports.run(), undefined)
  is(inst.exports.helper(21), 42)
})

test('WASI: wasmtime native', () => {
  if (!hasCmd('wasmtime')) return
  const wasm = compile(`export let _start = () => { console.log("jz-wasmtime"); return 0 }`, { host: 'wasi' })
  writeFileSync('/tmp/jz_wasi_test.wasm', wasm)
  const out = execSync('wasmtime /tmp/jz_wasi_test.wasm 2>/dev/null', { encoding: 'utf-8' })
  ok(out.includes('jz-wasmtime'))
})

// === Date.now / performance.now ===

test('Date.now: returns reasonable timestamp', () => {
  const t = run('export let f = () => Date.now()').f()
  ok(t > 1700000000000 && t < 2000000000000, `Date.now ${t} in range`)
})

test('performance.now: monotonic', () => {
  const { f } = run('export let f = () => performance.now()')
  const a = f(), b = f()
  ok(b >= a, `${b} >= ${a}`)
})

test('WASI: wasmer native', () => {
  if (!hasCmd('wasmer')) return
  const wasm = compile(`export let _start = () => { console.log("jz-wasmer"); return 0 }`, { host: 'wasi' })
  writeFileSync('/tmp/jz_wasi_test.wasm', wasm)
  const out = execSync('wasmer /tmp/jz_wasi_test.wasm 2>/dev/null', { encoding: 'utf-8' })
  ok(out.includes('jz-wasmer'))
})
