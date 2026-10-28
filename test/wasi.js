// WASI and console.log tests
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { run, oracle } from './util.js'
import { adaptI64, levels } from './_matrix.js'
import jz, { compile } from '../index.js'
import { wasi } from '../wasi.js'
import { writeFileSync } from 'fs'
import { execSync } from 'child_process'
import { format } from 'node:util'
import { targetProfileFor } from '../src/session.js'
import { ctx } from '../src/ctx.js'
import { legalizeForTarget } from '../src/optimize/watr-tail.js'

test('unused timer names do not initialize an absent timer queue', () => {
  for (const host of ['js', 'wasi']) for (const source of [
    'function unused() { setTimeout(() => {}, 0) }; export let f = () => 42',
    'const names = { setTimeout: 42 }; export let f = () => names.setTimeout',
    'let __timer_queue = 42; export let f = () => __timer_queue',
  ]) {
    const bytes = compile(source, { host })
    const module = new WebAssembly.Module(bytes)
    ok(!WebAssembly.Module.imports(module).some(i => i.name === 'clock_time_get'), 'no unused timer import')
    const { exports: e } = new WebAssembly.Instance(module)
    e._initialize?.()
    is(e.f(), 42)
  }
})

// === TargetProfile (audit P1) ===
// Pins the js/wasi policy objects src/session.js's beginSession derives from
// `host` — the single place ~24 scattered `ctx.transform.host === 'wasi'`
// checks across compile/emit/module now read a named field from instead.
// A field flip here means every consumer keyed on it flips too, so this is
// the one test that has to catch a wrong default.

test('TargetProfile: js vs wasi field values', () => {
  const js = targetProfileFor('js')
  const wasi_ = targetProfileFor('wasi')
  is(js.envImports, true, 'js: env.* host bridge available')
  is(js.jsStringInterop, true, 'js: wasm:js-string carrier usable')
  is(js.wasiShims, false, 'js: JS-host module shims, not WASI syscalls')
  is(js.commandEntry, false, 'js: no WASI command/reactor legalization')
  is(js.timerModel, 'host', 'js: host event loop drives timers')
  is(js.preserveClosureTable, false, 'js: closure table follows the call_indirect scan')

  is(wasi_.envImports, false, 'wasi: no JS host to satisfy env.__ext_*')
  is(wasi_.jsStringInterop, false, 'wasi: wasm:js-string needs a JS host')
  is(wasi_.wasiShims, true, 'wasi: WASI-syscall module shims')
  is(wasi_.commandEntry, true, 'wasi: command/reactor legalization required')
  is(wasi_.timerModel, 'blocking', 'wasi: no host scheduler, inline __timer_loop')
  is(wasi_.preserveClosureTable, true, 'wasi: table kept for embedder-supplied host fns')

  ok(Object.isFrozen(js), 'js profile is frozen')
  ok(Object.isFrozen(wasi_), 'wasi profile is frozen')
  is(targetProfileFor(undefined), js, 'undefined host resolves to the js profile object')
  is(targetProfileFor('bogus'), js, 'unrecognized host falls back to the js profile object')
})

// legalizeForTarget (src/optimize/watr-tail.js) now ports real WASI-only rewrites onto the
// assembled module tree (command-entry legalization + reactor `_initialize` conversion),
// both gated on targetProfile.commandEntry — false under js. Pin the js leg as an actual
// identity transform so a future rewrite that forgets to gate on commandEntry, or narrows
// its own gate, gets caught here instead of silently reshaping non-WASI output.

test('legalizeForTarget: identity transform under the js TargetProfile (same reference, untouched tree)', () => {
  const module = ['module',
    ['func', '$run', ['export', '"run"'], ['f64.const', 1]],
    ['func', '$__start', ['call', '$run']],
    ['start', '$__start']]
  const before = JSON.stringify(module)
  const result = legalizeForTarget(module, targetProfileFor('js'))
  is(result, module, 'js profile: legalizeForTarget returns the same array reference')
  is(JSON.stringify(module), before, 'js profile: module tree left byte-for-byte untouched')
})

test('host:js compile output carries no WASI command/reactor legalization artifacts', () => {
  // Same source shape that WOULD trigger both ported rewrites under host:'wasi'
  // (a run/_start export plus a top-level side effect needing __start) — under
  // host:'js' this must compile exactly as if legalizeForTarget did not exist.
  const wasm = compile(`console.log('boot')
export let run = () => { console.log('hi'); return 42 }`, { host: 'js' })
  const mod = new WebAssembly.Module(wasm)
  const exportNames = WebAssembly.Module.exports(mod).map(e => e.name)
  ok(!exportNames.includes('_initialize'), 'js profile: no reactor _initialize export')
  ok(!exportNames.includes('run') || WebAssembly.Module.exports(mod).find(e => e.name === 'run').kind === 'function',
    'run stays a plain function export')
  // Two js-host compiles of the identical source must be byte-identical (determinism through
  // legalizeForTarget's no-op path).
  const wasm2 = compile(`console.log('boot')
export let run = () => { console.log('hi'); return 42 }`, { host: 'js' })
  is(Buffer.from(wasm).toString('hex'), Buffer.from(wasm2).toString('hex'),
    'js profile: repeat compile of the same source is byte-identical')
})

test('TargetProfile: beginSession wires ctx.transform.targetProfile from host', () => {
  compile(`export let f = () => 1`, { host: 'js' })
  is(ctx.transform.targetProfile, targetProfileFor('js'), 'host:js compile installs the js profile')
  compile(`export let f = () => 1`, { host: 'wasi' })
  is(ctx.transform.targetProfile, targetProfileFor('wasi'), 'host:wasi compile installs the wasi profile')
})

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
    compile(`export let f = () => { console.log("x"); return 1 }`, { host: 'js' })
  )).map(i => i.module + '.' + i.name)
  ok(consoleImports.includes('env.print'), `expected env.print: ${consoleImports}`)
  ok(!consoleImports.includes('env.now'), `console.log should not import env.now: ${consoleImports}`)

  const timeImports = WebAssembly.Module.imports(new WebAssembly.Module(
    compile(`export let f = () => Date.now()`, { host: 'js' })
  )).map(i => i.module + '.' + i.name)
  ok(timeImports.includes('env.now'), `expected env.now: ${timeImports}`)
  ok(!timeImports.includes('env.print'), `Date.now should not import env.print: ${timeImports}`)
})

test('host:js top-level console.log decodes after memory attaches', () => {
  const originalLog = console.log
  const logged = []
  try {
    console.log = (...args) => logged.push(format(...args))   // as the host's console prints them
    jz(`console.log("boot", undefined, null); export let f = () => 1`, { host: 'js' })
  } finally {
    console.log = originalLog
  }
  is(logged.length, 1, `expected 1 console.log call, got ${logged.length}: ${JSON.stringify(logged)}`)
  is(logged[0], 'boot undefined null', `logged=${JSON.stringify(logged)}`)
})

// Under the JS host each argument reaches the host's console as the value it
// is, which the console formats as it formats its own: an object, an array, a
// collection, a typed array, -0, a format string, a BigInt, by the method called.
test('host:js console prints each argument as the host console prints it', () => {
  const src = `export const f = (x, o) => {
    console.log(); console.log('')
    console.log(-0, 0, NaN, 1e21, 0.1 + 0.2)
    console.log(\`t=\${x}!\`, \`\${x}\${x}\`, 'a=' + x + ' b', true, false, null, undefined)
    console.log('%s|%d', 'str', 7)
    console.warn({ w: [1, 'two'] })
    console.error('e', [o, { k: o }])
    console.info(new Map([[1, { a: [] }]]), new Set(['s']))
    const xs = [1, 2]
    console.log(...xs, 'end')
    console.debug(new Float64Array([1.5, -0]), [[1, [2, [3, [4]]]]], { s: 'q"uote', n: { m: { k: { deep: 1 } } } })
    console.log(10n, () => 1)
  }`
  const capture = (f) => {
    const out = [], saved = { ...console }
    for (const m of ['log', 'warn', 'error', 'info', 'debug']) console[m] = (...a) => out.push(m + ' ' + format(...a))
    try { f() } finally { Object.assign(console, saved) }
    return out
  }
  const want = capture(() => oracle(src).f(3, { h: 1 }))
  for (const optimize of levels(0, 2, 'size')) is(capture(() => jz(src, { host: 'js', optimize }).exports.f(3, { h: 1 })), want, `O${optimize}`)
})

// A console method passed as a value takes every argument its caller gives
// (`xs.forEach(console.log)`, `p.catch(console.warn)`), and a spread that ends
// the call prints its last value as a value, not joined to the line's end.
test('host:js console methods as values and a trailing spread print as the host console prints them', async () => {
  const src = `export const f = async (xs, o, p) => {
    xs.forEach(console.log)
    const log = console.info
    o.cb = console.debug
    o.cb(1, 'two', { a: 3 })
    console.log(...[5, { b: 1 }])
    console.log(...[])
    console.log('a', ...xs)
    await p.catch(console.warn)
    await Promise.resolve([7]).then(log)
  }`
  const capture = async (f) => {
    const out = [], saved = { ...console }
    for (const m of ['log', 'warn', 'error', 'info', 'debug']) console[m] = (...a) => out.push(m + ' ' + format(...a))
    try { await f() } finally { Object.assign(console, saved) }
    return out
  }
  const args = () => [['p', { q: 1 }], {}, Promise.reject('no')]
  const want = await capture(() => oracle(src).f(...args()))
  for (const optimize of levels(0, 2, 'size')) is(await capture(() => jz(src, { host: 'js', optimize }).exports.f(...args())), want, `O${optimize}`)
})

// A print line is the host's to format: a template (or a `'a=' + x` chain)
// whose parts are strings, numbers and booleans crosses as its parts, so the
// binary never links __to_str / ryu / __itoa / __str_concat for it. A part
// that prints through its own ToString (a class instance, an array) keeps
// the template as one string. Differential against the same source under JS.
const PRINT_SRC = `
  const pr = (a, b, c) => { console.log(\`a=\${a} b=\${b} c=\${c}\`) }
  export let f = (x, y) => {
    x = +x; y = +y
    pr(x, y | 0, x > y)
    console.log("n=" + x + " s=" + "q" + y, \`\${-0}|\${1 / 0}|\${NaN}\`, "" + (x + y))
    console.log(\`arr=\${[1, 2]} o=\${{ a: 1 }} t=\${true} u=\${undefined} n=\${null}\`, x > y, !x)
    return 1
  }`
const printRef = () => {
  const lines = [], orig = console.log
  console.log = (...a) => lines.push(a.join(' '))
  try {
    const pr = (a, b, c) => { console.log(`a=${a} b=${b} c=${c}`) }
    const f = (x, y) => {
      x = +x; y = +y
      pr(x, y | 0, x > y)
      console.log("n=" + x + " s=" + "q" + y, `${-0}|${1 / 0}|${NaN}`, "" + (x + y))
      console.log(`arr=${[1, 2]} o=${{ a: 1 }} t=${true} u=${undefined} n=${null}`, x > y, !x)
    }
    f(1.5, 2.7)
  } finally { console.log = orig }
  return lines.join('\n') + '\n'
}
// The exact-part subset alone links no string runtime.
const PRINT_EXACT = `
  const pr = (a, b, c) => { console.log(\`a=\${a} b=\${b} c=\${c}\`) }
  export let f = (x, y) => {
    x = +x; y = +y
    pr(x, y | 0, x > y)
    console.log("n=" + x + " s=" + "q" + y, \`\${-0}|\${1 / 0}|\${NaN}\`, "" + (x + y))
    return 1
  }`

test('host:js console.log: template parts print host-side, booleans as booleans', () => {
  const wat = compile(PRINT_EXACT, { host: 'js', wat: true })
  for (const fn of ['__to_str', '__itoa', '__ftoa', '__str_concat', '__strcat'])
    ok(!wat.includes(`$${fn}`), `${fn} linked for a print line`)
  const lines = [], orig = console.log
  console.log = (...a) => lines.push(a.join(' '))
  let ret
  try { ret = jz(PRINT_SRC, { host: 'js' }).exports.f(1.5, 2.7) } finally { console.log = orig }
  is(ret, 1)
  is(lines.join('\n') + '\n', printRef())
})

test('WASI console.log: template parts print per part', () => {
  const captured = []
  const imports = wasi({ write: (fd, text) => captured.push(text) })
  const wasm = compile(PRINT_SRC, { host: 'wasi' })
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod, imports)
  const exps = adaptI64(mod, inst.exports)
  imports._setMemory(exps.memory)
  is(exps.f(1.5, 2.7), 1)
  is(captured.join(''), printRef())
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
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod, imports)
  const e0 = adaptI64(mod, inst.exports)
  imports._setMemory(e0.memory)
  is(e0.f(), 1)
  is(captured.join('').trim(), fixture)
})

test('WASI polyfill: readStdin returns input beyond the initial buffer size', () => {
  const fixture = 'x'.repeat(70000)
  const encoder = new TextEncoder()
  const bytes = encoder.encode(fixture)
  let offset = 0
  const imports = wasi({
    read: (fd, buf) => {
      if (offset >= bytes.length) return 0
      const n = Math.min(buf.length, bytes.length - offset)
      buf.set(bytes.subarray(offset, offset + n))
      offset += n
      return n
    },
  })
  const wasm = compile(`export let f = () => readStdin().length`, { host: 'wasi' })
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod, imports)
  const exps = adaptI64(mod, inst.exports)
  imports._setMemory(exps.memory)

  is(exps.f(), fixture.length)
})

test('WASI polyfill: custom write receives output', () => {
  const captured = []
  const imports = wasi({ write: (fd, text) => captured.push([fd, text]) })
  const wasm = compile(`export let f = () => { console.log("custom"); console.warn("err"); return 1 }`, { host: 'wasi' })
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod, imports)
  const exps = adaptI64(mod, inst.exports)
  imports._setMemory(exps.memory)
  is(exps.f(), 1)
  is(captured.map(x => x[1]).join(''), 'custom\nerr\n')
  is(captured.filter(x => x[1] === 'custom')[0][0], 1)
  is(captured.filter(x => x[1] === 'err')[0][0], 2)
})

test('WASI console.log: boolean read from a container prints as boolean', () => {
  const captured = []
  const imports = wasi({ write: (fd, text) => captured.push(text) })
  const wasm = compile(`export let f = () => { let o = {}; o.b = false; console.log(o.b); return 1 }`, { host: 'wasi' })
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod, imports)
  const exps = adaptI64(mod, inst.exports)
  imports._setMemory(exps.memory)

  is(exps.f(), 1)
  is(captured.join(''), 'false\n')
})

// FIXED (.work/archive/todo.md §deletion-sweep Slice 5 site survey — LEAK C):
// module/console.js's writePart dispatched on a bare `valTypeOf(part)`
// STRING/NUMBER check with no runtime tag verification — a dict-census
// STRING/NUMBER claim ("every value ever written") on an ABSENT key fed
// raw UNDEF_NAN bits straight to `$__write_str`/`$__write_num`, which
// assume their argument really IS that kind (no nullish check of their
// own — unlike `$__write_val`, the generic fallback, which already
// dispatches on the actual runtime atom). Under `host:'js'` this is masked
// (console.log there decodes host-side off the raw i64, independent of
// what the compiler believed) — only reachable under `host:'wasi'`, where
// module/console.js's own WASI-syscall writers run. Gated writePart's
// STRING/NUMBER fast branches on `!censusMaybeUndefined(part)`, falling
// through to the existing, already-correct `$__write_val` general path.
test('WASI console.log: dict-census absent key prints as undefined, not empty/garbage (Slice 5 LEAK C)', () => {
  const captured = []
  const imports = wasi({ write: (fd, text) => captured.push(text) })
  const wasm = compile(`export let f = () => {
    const d = {}; const wk = 'a'; d[wk] = 'x'; const wk2 = 'b'; d[wk2] = 'y'; const rk = 'missing'
    console.log(d[rk])
    const n = {}; const nk = 'p'; n[nk] = 1; const nk2 = 'q'; n[nk2] = 2; const nrk = 'zzz'
    console.log(n[nrk] + 1)
    return 1
  }`, { host: 'wasi' })
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod, imports)
  const exps = adaptI64(mod, inst.exports)
  imports._setMemory(exps.memory)

  is(exps.f(), 1)
  is(captured.join(''), 'undefined\nNaN\n')
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
    const mod = new WebAssembly.Module(wasm)
    const inst = new WebAssembly.Instance(mod, imports)
    const exps = adaptI64(mod, inst.exports)
    imports._setMemory(exps.memory)
    result = exps.f()
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
  const exps = adaptI64(mod, inst.exports)
  is(exps.f(9), 81)
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
  try { compile(`export let f = () => myFn(1)`, { _interp: { myFn: () => 42 }, host: 'js' }) }
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
  try { compile(`export let f = () => globalThis`, { host: 'js' }) }
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

test('WASI: parseFloat lowers without env imports', () => {
  const wasm = compile(`export let f = () =>
    (parseFloat("  -1.25e2x") === -125) +
    (parseFloat("1e") === 1) +
    (parseFloat("0x10") === 0) +
    (Number.parseFloat(".5") === 0.5) +
    isNaN(parseFloat(""))`, { host: 'wasi' })
  is(envImports(wasm).length, 0)
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod, {})
  const exps = adaptI64(mod, inst.exports)
  is(exps.f(), 5)
})

test('WASI: parseInt lowers without env imports', () => {
  const wasm = compile(`export let f = () =>
    (parseInt("42") === 42) +
    (parseInt("0xff") === 255) +
    (parseInt("ff", 16) === 255) +
    (parseInt("-123") === -123) +
    (Number.parseInt("11", 2) === 3)`, { host: 'wasi' })
  is(envImports(wasm).length, 0)
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod, {})
  const exps = adaptI64(mod, inst.exports)
  is(exps.f(), 5)
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

test('WASI: non-callable own methods throw TypeError', () => {
  // JSON-derived shape: a non-callable field is a runtime TypeError.
  const wasm = compile(`
    export let f = () => {
      const o = JSON.parse('{"x":1}')
      try { o.x() } catch(e) { return e instanceof TypeError ? 1 : 0 }
      return 0
    }
  `, { host: 'wasi' })
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod, wasi())
  const exps = adaptI64(mod, inst.exports)
  is(exps.f(), 1)
})

// === WASI native runtime tests ===

function hasCmd(cmd) { try { execSync(`which ${cmd}`, { stdio: 'ignore' }); return true } catch { return false } }

test('WASI: command-mode entry returns void', () => {
  for (const name of ['run', '_start']) {
    const captured = []
    const imports = wasi({ write: (fd, text) => captured.push(text) })
    const wasm = compile(`export let ${name} = () => { console.log("hi"); return 42 }`, { host: 'wasi' })
    const mod = new WebAssembly.Module(wasm)
    const inst = new WebAssembly.Instance(mod, imports)
    const exps = adaptI64(mod, inst.exports)
    imports._setMemory(exps.memory)
    is(exps[name](), undefined, `${name}() should return undefined`)
    is(captured.join(''), 'hi\n', `${name} body should still execute`)
  }
})

test('WASI: command-mode entry returns void through export alias', () => {
  for (const name of ['run', '_start']) {
    const captured = []
    const imports = wasi({ write: (fd, text) => captured.push(text) })
    const wasm = compile(`const main = () => { console.log("hi"); return 42 }; export { main as ${name} }`, { host: 'wasi' })
    const mod = new WebAssembly.Module(wasm)
    const inst = new WebAssembly.Instance(mod, imports)
    const exps = adaptI64(mod, inst.exports)
    imports._setMemory(exps.memory)
    is(exps[name](), undefined, `${name} alias should return undefined`)
    is(captured.join(''), 'hi\n', `${name} alias body should still execute`)
  }
})

test('WASI: parametric run/_start keeps direct export', () => {
  // Parametric entries can't form a CLI-callable () -> () wrapper, so the
  // direct f64-returning export survives (caller needs a host that supplies args).
  const wasm = compile(`export let run = (n) => (n | 0) + 1`, { host: 'wasi' })
  const imports = wasi()
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod, imports)
  const exps = adaptI64(mod, inst.exports)
  imports._setMemory(exps.memory)
  is(exps.run(7), 8)
})

test('WASI: parametric run alias keeps direct export', () => {
  const wasm = compile(`const main = (n) => (n | 0) + 1; export { main as run }`, { host: 'wasi' })
  const imports = wasi()
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod, imports)
  const exps = adaptI64(mod, inst.exports)
  imports._setMemory(exps.memory)
  is(exps.run(7), 8)
})

test('WASI: non-entry exports keep their f64 return', () => {
  const wasm = compile(`export let run = () => 1; export let helper = (x) => x * 2`, { host: 'wasi' })
  const imports = wasi()
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod, imports)
  const exps = adaptI64(mod, inst.exports)
  imports._setMemory(exps.memory)
  is(exps.run(), undefined)
  is(exps.helper(21), 42)
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

// === fs — file IO over WASI preopens (module/fs.js) ===
// fs.read(path) → decoded UTF-8 text, fs.write(path, s) → UTF-8 bytes.
// Paths resolve against the first preopen (fd 3); errno throws as a number.
test('fs: read + write round-trip under node:wasi preopens', async () => {
  const { WASI } = await import('node:wasi')
  const { mkdtempSync, writeFileSync: wf, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'jz-fs-'))
  wf(join(dir, 'data.txt'), 'hello wasi files')
  wf(join(dir, 'Ā.txt'), '\uFEFFĀ😀')
  const wasm = compile(`
    export let f = () => fs.read("data.txt")
    export let unicode = () => {let s=fs.read("Ā.txt");fs.write("😀.txt",s);return s}
    export let w = () => { fs.write("out.txt", "len:" + fs.read("data.txt").length) }
    export let missing = () => { try { fs.read("nope.txt"); return -1 } catch (e) { return e } }`,
    { host: 'wasi' })
  const w = new WASI({ version: 'preview1', preopens: { '/': dir } })
  const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm), w.getImportObject())
  w.initialize(inst)
  const { memory } = await import('../interop.js')
  const mem = memory({ exports: inst.exports })
  is(mem.read(inst.exports.f()), 'hello wasi files')
  is(mem.read(inst.exports.unicode()), '\uFEFFĀ😀')
  is(readFileSync(join(dir, '😀.txt'), 'utf8'), '\uFEFFĀ😀')
  inst.exports.w()
  is(readFileSync(join(dir, 'out.txt'), 'utf8'), 'len:16')
  is(mem.read(inst.exports.missing()), 44)   // WASI errno 44 = NOENT
})

// fs.readSync/writeSync move raw bytes through fd 0/1, so the same source runs
// under Node and under WASI; Node's own fs is the reference for every value.
// Node runs the module and calls _start; WASI starts the compiled command, under
// node:wasi and, with `wasmtime` (a source with no try/catch: wasmtime 25 has no
// exception handling), under wasmtime when it is installed (`wt`, else null).
const runBoth = async (src, input, { wasmtime = false } = {}) => {
  const { WASI } = await import('node:wasi')
  const { mkdtempSync, writeFileSync: wf, readFileSync, openSync, closeSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'jz-fd-'))
  try {
    wf(join(dir, 'in'), input)
    wf(join(dir, 'm.mjs'), src + '\n_start()')
    const node = execSync(`node ${JSON.stringify(join(dir, 'm.mjs'))}`, { input })
    const wasm = compile(src, { host: 'wasi' })
    const stdin = openSync(join(dir, 'in'), 'r'), stdout = openSync(join(dir, 'out'), 'w')
    const w = new WASI({ version: 'preview1', stdin, stdout })
    w.start(new WebAssembly.Instance(new WebAssembly.Module(wasm), w.getImportObject()))
    closeSync(stdin); closeSync(stdout)
    let wt = null
    if (wasmtime && hasCmd('wasmtime')) {
      wf(join(dir, 'm.wasm'), wasm)
      wt = execSync(`wasmtime ${JSON.stringify(join(dir, 'm.wasm'))}`, { input })
    }
    return { node, jz: readFileSync(join(dir, 'out')), wt }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('fs: readSync/writeSync argument forms answer what Node answers', async () => {
  const { node, jz } = await runBoth(`import fs from 'fs'
    const tryIt = (f) => { try { return f() } catch (e) { return e.name } }
    export let _start = () => {
      const b = new Uint8Array(6), w = new Uint16Array(2), r = []
      r.push(fs.readSync(0, b), fs.readSync(0, b, 2, 3), fs.readSync(0, w), fs.readSync(0, b, 0, undefined), fs.readSync(0, b, 9, 0))
      r.push(tryIt(() => fs.readSync(0, b, 2, 5)), tryIt(() => fs.readSync(0, b, 0, -1)), tryIt(() => fs.readSync(0, [1, 2])))
      r.push(fs.writeSync(1, b), fs.writeSync(1, b, 4), fs.writeSync(1, b, 1, 2), fs.writeSync(1, b, 2, undefined), fs.writeSync(1, w), fs.writeSync(1, 'é😀'), fs.writeSync(1, 'ok'))
      r.push(fs.readSync(0, b.subarray(3)), fs.writeSync(1, b.subarray(3), 1), fs.writeSync(1, b.subarray(6)))
      r.push(tryIt(() => fs.writeSync(1, b, 7)), tryIt(() => fs.writeSync(1, 42)), tryIt(() => fs.writeSync(1, b, 1, 6)))
      r.push(fs.readSync(0, b, 0, 6), fs.readSync(0, b, 0, 6))
      fs.writeSync(1, '|' + r.join(','))
    }`, Buffer.from([0, 1, 2, 3, 200, 255, 10, 20, 30, 0x80, 0xc0, 0xfe, 0xff, 7, 8, 9, 0xaa, 0xbb, 0xcc]))
  ok(node.length > 0, 'node ran')
  is(Buffer.compare(jz, node), 0, `jz ${JSON.stringify(jz.toString('latin1'))} vs node ${JSON.stringify(node.toString('latin1'))}`)
})

// Node's options forms, readSync(fd, buffer, { offset, length, position }) and
// writeSync(fd, buffer, options), with their defaults (offset 0, length
// byteLength - offset), a third argument of null taken for options, and the
// errors of Node's checks (lib/fs.js, internal/fs/utils.js validateInteger,
// validateOffsetLengthRead/Write), named imports from node:fs.
test('fs: readSync/writeSync options forms answer what Node answers', async () => {
  const { node, jz } = await runBoth(`import { readSync, writeSync } from 'node:fs'
    const t = (f) => { try { return f() } catch (e) { return e.name } }
    const rd = (b, o, l) => readSync(0, b, o, l), ro = (b, l) => readSync(0, b, { length: l }), wo = (b, o) => writeSync(1, b, { offset: o })
    export let _start = () => {
      const b = new Uint8Array(6), w = new Uint16Array(2), e = new Uint8Array(0), r = []
      r.push(readSync(0, b, { offset: 0, length: b.length }), readSync(0, b, { offset: 2 }), readSync(0, b, { length: 2 }), readSync(0, b, {}), readSync(0, b, null), readSync(0, b, undefined))
      r.push(readSync(0, b, { offset: 1, length: 2, position: null }), readSync(0, b, { length: 2, offset: 3 }), readSync(0, b, null, 2), readSync(0, b, { offset: 1 }, 2), readSync(0, w, { offset: 1, length: 2 }))
      r.push(t(() => readSync(0, b, { offset: 7 })), t(() => readSync(0, b, { offset: -1 })), t(() => readSync(0, b, { offset: 1.5 })), t(() => readSync(0, b, { offset: '1' })), t(() => readSync(0, b, { offset: null })))
      r.push(t(() => readSync(0, b, { length: 7 })), readSync(0, b, { length: 0 }), readSync(0, e, {}), t(() => readSync(0, e, { length: 1 })), readSync(0, b, { length: undefined }), ro(b, undefined), ro(b, 1))
      r.push(t(() => rd(b, 1.5, 2)), rd(b, undefined, 2), t(() => rd(1.09375, 0, 1)), t(() => rd(b, NaN, 1)), t(() => rd(b, '1', 1)), rd(b, 0, '2'), rd(b, 9, 0), t(() => rd(b, -1, 0)))
      writeSync(1, '|')
      r.push(writeSync(1, b, { offset: 1, length: 2 }), writeSync(1, b, { offset: 4 }), writeSync(1, b, {}), writeSync(1, b, null), writeSync(1, b, { length: 1 }), writeSync(1, b, null, 2))
      r.push(writeSync(1, 'str', { offset: 1 }), writeSync(1, 'é', null), writeSync(1, 'x', undefined, 'utf8'), writeSync(1, b, 4, 0), t(() => writeSync(1, b, 7, 0)))
      r.push(t(() => writeSync(1, b, { offset: 7 })), t(() => writeSync(1, b, { length: 7 })), t(() => writeSync(1, b, { length: 1.5 })), t(() => writeSync(1, b, { length: -1 })), writeSync(1, b, { offset: null }), t(() => writeSync(1, b, { offset: '1' })), writeSync(1, b, { length: '2' }))
      r.push(writeSync(1, b, 1, '2'), t(() => writeSync(1, 1.09375)), wo(b, undefined), wo(b, 5), t(() => wo(b, 1.5)), writeSync(1, w, { offset: 1, length: 2 }))
      writeSync(1, '|' + r.join(','))
    }`, Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 255)))
  ok(/\|6,4,2,6,6,6,2,2,6,5,2,RangeError/.test(node.toString('latin1')), 'node ran the options forms')
  is(Buffer.compare(jz, node), 0, `jz ${JSON.stringify(jz.toString('latin1'))} vs node ${JSON.stringify(node.toString('latin1'))}`)
})

// The reporter's host (dy/jz discussion #116): a reader passed as a callback,
// `readSync(0, buf, { offset, length })` through named node:fs imports, bytes
// accumulated into a typed array at `start + got + i`. readSync's result is a
// Number, so the index is one and the store is the typed array's; the same
// source answers byte for byte under Node, node:wasi and wasmtime.
test('fs: a node:fs reader passed as a callback fills a typed array, no dynamic store', async () => {
  const src = `import { readSync, writeSync } from 'node:fs'
    function readFillExact(read, buf, start, n) {
      let got = 0
      while (got < n) {
        const tmp = new Uint8Array(n - got)
        const r = read(tmp)
        if (r === null || r <= 0) return false
        let i = 0
        while (i < r) { buf[start + got + i] = tmp[i]; i = i + 1 }
        got = got + r
      }
      return true
    }
    function nodeFsRead(buf) { return readSync(0, buf, { offset: 0, length: buf.length }) }
    function nodeFsWrite(buf) {
      let n = 0
      while (n < buf.length) { const w = writeSync(1, buf, n); if (w <= 0) return; n = n + w }
    }
    function serve(read, write) {
      const header = new Uint8Array(4)
      while (true) {
        if (!readFillExact(read, header, 0, 4)) return
        const len = header[0] + header[1] * 256 + header[2] * 65536 + header[3] * 16777216
        if (len === 0) return
        const out = new Uint8Array(4 + len)
        out[0] = len & 255; out[1] = len >> 8 & 255; out[2] = len >> 16 & 255; out[3] = len >> 24 & 255
        if (!readFillExact(read, out, 4, len)) return
        write(out)
      }
    }
    export let _start = () => serve(nodeFsRead, nodeFsWrite)`
  const warnings = []
  const wat = compile(src, { host: 'wasi', wat: true, warnings: w => warnings.push(w) })
  is(warnings.map(e => e.code), [], 'no deopt advisory')
  ok(!/__dyn_set|__dyn_get/.test(wat), 'no dynamic property access')
  const frame = (v) => { const b = Buffer.from(JSON.stringify(v)), h = Buffer.alloc(4); h.writeUInt32LE(b.length); return Buffer.concat([h, b]) }
  const input = Buffer.concat([frame({ a: 1 }), frame('é😀'.repeat(70)), frame([1, 'x']), Buffer.alloc(4), frame('unread')])
  const { node, jz, wt } = await runBoth(src, input, { wasmtime: true })
  is(node.length, input.length - 4 - frame('unread').length, 'node echoed the frames before the zero frame')
  is(Buffer.compare(jz, node), 0, 'node:wasi')
  if (wt) is(Buffer.compare(wt, node), 0, 'wasmtime')
  // one byte per fd_read: every read short, `got` carried across reads
  let off = 0
  const out = []
  const { instantiate } = await import('../interop.js')
  const inst = instantiate(compile(src, { host: 'wasi' }), {
    read: (fd, buf) => { if (off >= input.length || !buf.length) return 0; buf[0] = input[off++]; return 1 },
  })
  const { stdout } = globalThis.process, write = stdout.write
  stdout.write = (b) => { out.push(Buffer.from(b)); return true }
  try { inst.exports._start() } finally { stdout.write = write }
  is(Buffer.compare(Buffer.concat(out), node), 0, 'byte-at-a-time reads')
})

test('fs: a Native Messaging host echoes length-prefixed frames byte-exact', async () => {
  // Chrome's framing: a 32-bit length in native (little-endian) order, then UTF-8 JSON.
  const src = `import fs from 'fs'
    const readFull = (buf) => {
      let n = 0
      while (n < buf.length) { const r = fs.readSync(0, buf, n, buf.length - n); if (r === 0) return false; n += r }
      return true
    }
    export let _start = () => {
      const head = new Uint8Array(4)
      while (readFull(head)) {
        const body = new Uint8Array(head[0] | head[1] << 8 | head[2] << 16 | head[3] << 24)
        if (!readFull(body)) return
        const out = new TextEncoder().encode(JSON.stringify({ echo: JSON.parse(new TextDecoder().decode(body)) }))
        const h = new Uint8Array(4)
        h[0] = out.length; h[1] = out.length >> 8; h[2] = out.length >> 16; h[3] = out.length >> 24
        fs.writeSync(1, h); fs.writeSync(1, out)
      }
    }`
  const frame = (v) => { const b = Buffer.from(JSON.stringify(v)), h = Buffer.alloc(4); h.writeUInt32LE(b.length); return Buffer.concat([h, b]) }
  const input = Buffer.concat([frame({ a: 1 }), frame({ t: 'é😀'.repeat(60) }), frame([1, 'x'])])
  const { node, jz } = await runBoth(src, input)
  is(Buffer.compare(jz, node), 0)
  is(node.readUInt32LE(0), 16, 'first frame header')
  // empty input; a header with no body; a body cut short: the host stops, as Node's does
  for (const cut of [Buffer.alloc(0), input.subarray(0, 4), input.subarray(0, 10), input.subarray(0, 20 + 4 + 1)]) {
    const r = await runBoth(src, cut)
    is(Buffer.compare(r.jz, r.node), 0, `${cut.length}-byte input`)
  }
  // a reader that hands over one byte per fd_read: every frame split at every byte
  let off = 0
  const out = []
  const { instantiate } = await import('../interop.js')
  const inst = instantiate(compile(src, { host: 'wasi' }), {
    read: (fd, buf) => { if (off >= input.length || !buf.length) return 0; buf[0] = input[off++]; return 1 },
  })
  const { stdout } = globalThis.process, write = stdout.write
  stdout.write = (b) => { out.push(Buffer.from(b)); return true }
  try { inst.exports._start() } finally { stdout.write = write }
  is(Buffer.compare(Buffer.concat(out), node), 0, 'byte-at-a-time reads')
})

test('fs: readSync/writeSync reject what they cannot serve at compile', () => {
  const hint = (src, host = 'wasi') => { try { compile(src, { host }) } catch (x) { return x.message } return '' }
  ok(/as options/.test(hint(`export let f = () => fs.readSync(0, new Uint8Array(4), 1)`)), 'lone offset reads as Node options')
  ok(/position/.test(hint(`export let f = () => fs.writeSync(1, new Uint8Array(4), 0, 4, 2)`)), 'explicit position')
  ok(/position/.test(hint(`export let f = () => fs.readSync(0, new Uint8Array(4), { position: 0 })`)), 'position option')
  // options jz cannot read at compile time: an object held in a binding, a spread, an accessor
  for (const opts of ['o', '{ ...o }', '{ get length() { return 1 } }'])
    for (const m of ['readSync', 'writeSync'])
      ok(/object literal/.test(hint(`const o = { offset: 1 }; export let f = () => fs.${m}(1, new Uint8Array(4), ${opts}, 1)`)), `${m} ${opts}`)
  ok(/object literal/.test(hint(`const o = { offset: 1 }; export let f = () => fs.readSync(0, new Uint8Array(4), o)`)), 'readSync lone binding')
  // node:fs is the builtin unless the program supplies its own
  ok(/WASI host/.test(hint(`import { readSync } from 'node:fs'; export let f = () => readSync(0, new Uint8Array(4))`, 'js')), 'node:fs is fs')
  is(run(`import { readSync } from 'node:fs'; export let f = () => readSync(0, 1)`, { host: 'js', modules: { 'node:fs': 'export const readSync = (fd, n) => fd + n + 6' } }).f(), 7, 'own node:fs module')
  ok(/WASI host/.test(hint(`export let f = () => fs.readSync(0, new Uint8Array(4))`, 'js')), 'host js')
})

test('WASI polyfill: writes reach process.stdout as raw bytes', () => {
  const chunks = []
  const sink = { write: (b) => { chunks.push(b) } }
  const { result } = runWithCapturedFallback({ stdout: sink, stderr: sink },
    `export let f = () => { fs.writeSync(1, new Uint8Array([200, 0, 0, 0, 255])); return 1 }`)
  is(result, 1)
  is([...Buffer.concat(chunks)].join(), '200,0,0,0,255')
})

test('init: top-level WASI calls run via _initialize (reactor), not a start section', () => {
  // The p1 ABI forbids WASI calls inside the wasm start section — it runs during
  // `new WebAssembly.Instance`, before ANY host can wire memory, so a top-level
  // console.log/Date.now crashed the JS shim ("Cannot read properties of null").
  // host:'wasi' ships init as the standard `_initialize` reactor export instead.
  const mod = new WebAssembly.Module(compile(`console.log('init'); export let f = () => 1`, { host: 'wasi' }))
  ok(WebAssembly.Module.exports(mod).some(e => e.name === '_initialize'), '_initialize exported')
  const { exports: e } = jz(`console.log('init side effect'); let t = Date.now(); export let f = () => t > 0`, { host: 'wasi' })
  is(Number(e.f()), 1, 'init ran after memory wiring')
})

test('fs: host js rejects at compile with the wiring hint', () => {
  let e
  // host pinned: under the test:wasi leg the env default flips host to 'wasi',
  // where fs.read compiles fine — the premise here is the JS host's rejection.
  try { compile('export let f = () => fs.read("x")', { host: 'js' }) } catch (x) { e = x }
  ok(e && /WASI host/.test(e.message), `hint present: ${e?.message?.slice(0, 60)}`)
})

// REACTOR self-arming: a raw `new WebAssembly.Instance` embedder that never
// calls `_initialize` (wasmtime does it automatically; plain-JS consumers of
// the import-free wasi build don't) must still see seeded state — every
// exported function checks the once-guard. Without it, `_clear()` reset the
// heap from a zero `__heap_reset` and the next alloc wrote out of bounds
// (the color-space batch harness, jz 0.9.1 report).
test('init: exports self-arm without _initialize (raw-instance _clear + grow)', () => {
  const src = `
    let buf = new Float64Array(4)   // module-scope init: the start body exists
    export let alloc = (n) => { buf = new Float64Array(n * 3); return 1 }
    export let poke = (i, v) => { buf[i] = v; return buf[i] }`
  const bin = compile(src, { host: 'wasi', optimize: 'speed' })
  const ex = new WebAssembly.Instance(new WebAssembly.Module(bin), {}).exports
  ok(!!ex._initialize, 'reactor _initialize exported')
  // deliberately NO _initialize call
  if (ex._clear) ex._clear()
  const f2b = (x) => new BigInt64Array(new Float64Array([x]).buffer)[0]
  const arg = (x) => { try { ex.alloc.length } catch {} ; return x }
  const call1 = (fn, a) => { try { return fn(a) } catch (e) { if (/BigInt/.test(e.message)) return fn(f2b(a)); throw e } }
  const call2 = (fn, a, b) => { try { return fn(a, b) } catch (e) { if (/BigInt/.test(e.message)) return fn(f2b(a), f2b(b)); throw e } }
  const b2f = (v) => typeof v === 'bigint' ? new Float64Array(new BigInt64Array([v]).buffer)[0] : v
  is(b2f(call1(ex.alloc, 5000)), 1, 'alloc past one page succeeds')
  ok(ex.memory.buffer.byteLength > 65536, 'memory grew on demand')
  is(b2f(call2(ex.poke, 14999, 42)), 42, 'far element writes land')
})


test('WASI clocks own scratch storage without overwriting static strings', () => {
  const label = 'persistent UTF-16: Ā 😀'
  for (const optimize of levels(0, 1, 2, 3)) {
    const captured = [], imports = wasi({ write: (_, text) => captured.push(text) })
    const mod = new WebAssembly.Module(compile(`
      const label = ${JSON.stringify(label)}
      export let f = () => {
        if (Date.now() > 0 && performance.now() >= 0) console.log(label)
      }`, { host: 'wasi', optimize }))
    const inst = new WebAssembly.Instance(mod, imports)
    imports._setMemory(inst.exports.memory)
    inst.exports._initialize?.()
    inst.exports.f()
    inst.exports.f()
    is(captured.join(''), `${label}\n${label}\n`, `O${optimize}: clocks preserve literals across calls`)
  }
})


test('WASI integer output preserves signed and unsigned 32-bit values', () => {
  for (const optimize of levels(0, 1, 2, 3)) {
    const captured = [], imports = wasi({ write: (_, text) => captured.push(text) })
    const mod = new WebAssembly.Module(compile(
      'export let f = n => { n |= 0; console.log(n, n >>> 0, `signed=${n} unsigned=${n >>> 0}`) }',
      { host: 'wasi', optimize }))
    const inst = new WebAssembly.Instance(mod, imports)
    imports._setMemory(inst.exports.memory)
    const exps = adaptI64(mod, inst.exports)
    for (const n of [-2147483648, -1, 0, 2147483647]) exps.f(n)
    const expected = [-2147483648, -1, 0, 2147483647].map(n => `${n} ${n >>> 0} signed=${n} unsigned=${n >>> 0}\n`).join('')
    is(captured.join(''), expected, `O${optimize}: numeric output agrees with JS`)
  }
})
