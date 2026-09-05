import test from 'tst'
import { ok, is, throws } from 'tst/assert.js'
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import childProcess, { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import compile from 'watr/compile'
import { selfBuild } from './_self-build.js'

const wasm = value => compile(`(module (func (export "value") (result i32) (i32.const ${value})))`)
const A = wasm(11), B = wasm(22)
const result = bytes => new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.value()
const output = bytes => `writeFileSync(process.argv[2], new Uint8Array(${JSON.stringify([...bytes])}))`

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'jz-self-build-test-'))
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'dist'))
  const stale = join(root, 'dist/jz.wasm')
  writeFileSync(stale, A)
  writeFileSync(join(root, 'attempts'), '')
  const builder = body => writeFileSync(join(root, 'scripts/self-compile-build.mjs'), `
    import { appendFileSync, writeFileSync } from 'node:fs'
    appendFileSync('attempts', process.argv[2] + '\\n')
    ${body}
  `)
  const attempts = () => readFileSync(join(root, 'attempts'), 'utf8').trim().split('\n').filter(Boolean)
  try {
    fn({ root, stale, builder, attempts })
    for (const out of attempts()) ok(!existsSync(dirname(out)), 'temporary build output was removed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('self-build: failed build cannot use a valid stale artifact or retry in the same run', () => {
  fixture(({ root, stale, builder, attempts }) => {
    builder(`console.error('build failed deliberately'); process.exit(7)`)
    const load = selfBuild(root)
    throws(load, /self-compile build exit 7[\s\S]*build failed deliberately/)
    builder(output(B))
    throws(load, /self-compile build exit 7/, 'later tests see the original failure')
    is(attempts().length, 1, 'one attempt, even after the builder recovers')
    is(result(readFileSync(stale)), 11, 'old artifact was not changed')
    is(result(selfBuild(root)()), 22, 'a new run can build after recovery')
    is(attempts().length, 2)
  })
})

test('self-build: a successful exit without output cannot fall back to dist', () => {
  fixture(({ root, stale, builder, attempts }) => {
    builder('process.exit(0)')
    const load = selfBuild(root)
    throws(load, /ENOENT/)
    throws(load, /ENOENT/)
    is(attempts().length, 1)
    is(result(readFileSync(stale)), 11)
  })
})

test('self-build: a signalled builder cannot certify its output', () => {
  fixture(({ root, builder, attempts }) => {
    builder(`${output(B)}; process.kill(process.pid, 'SIGTERM')`)
    const load = selfBuild(root)
    throws(load, /self-compile build exit null \(SIGTERM\)/)
    throws(load, /SIGTERM/)
    is(attempts().length, 1)
  })
})

test('self-build: a subprocess error rejects even an exit-zero artifact', () => {
  fixture(({ root, builder, attempts }) => {
    builder(output(B))
    const load = selfBuild(root), original = childProcess.spawnSync
    // Node can report status 0 AND ETIMEDOUT when SIGTERM is handled with exit(0).
    // Inject that result after a real successful build, without a timing-dependent test.
    childProcess.spawnSync = (...args) => {
      const r = original(...args)
      is(r.status, 0, 'the builder completed and wrote valid output')
      return { ...r, error: new Error('spawnSync ETIMEDOUT fixture') }
    }
    syncBuiltinESMExports()
    try { throws(load, /ETIMEDOUT fixture/) }
    finally { childProcess.spawnSync = original; syncBuiltinESMExports() }
    throws(load, /ETIMEDOUT fixture/, 'later callers retain the failure after subprocess recovery')
    is(attempts().length, 1)
  })
})

for (const [file, failure] of [
  ['kernel-target.js', 'exit-zero subprocess'], ['kernel-target.js', 'read'],
  ['kernel-target.js', 'invalid wasm'], ['../scripts/bench-self-compile.mjs', 'exit-zero subprocess'],
]) test(`self-build: ${file} retains its ${failure} failure`, () => {
  // Isolate builtin mocks and the kernel module cache from the native test process.
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import cp from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'
    const exists = fs.existsSync, read = fs.readFileSync
    const artifact = path => typeof path === 'string' && path.endsWith(${JSON.stringify(join('dist', 'jz.wasm'))})
    let spawns = 0, reads = 0, present = ${failure !== 'exit-zero subprocess'}, recovered = false
    fs.existsSync = path => artifact(path) ? present : exists(path)
    fs.readFileSync = (path, ...args) => {
      if (artifact(path)) {
        reads++
        if (!recovered && ${failure === 'read'}) throw new Error('ENOENT fixture')
        if (!recovered && ${failure === 'invalid wasm'}) return new Uint8Array()
        return Buffer.from(${JSON.stringify([...A])})
      }
      return read(path, ...args)
    }
    cp.spawnSync = () => { spawns++; present = true; return { status: 0, signal: null, error: new Error('ETIMEDOUT fixture') } }
    syncBuiltinESMExports()
    let mod, error
    try {
      mod = await import(${JSON.stringify(new URL(file, import.meta.url).href)})
      ${file === 'kernel-target.js' ? "mod.compileViaKernel('')" : ''}
    } catch (e) { error = e }
    ${failure === 'invalid wasm' ? 'assert.ok(error instanceof WebAssembly.CompileError)' : `assert.match(error?.message || '', /${failure === 'read' ? 'ENOENT' : 'ETIMEDOUT'} fixture/)`}
    ${file === 'kernel-target.js' ? `
    recovered = true
    cp.spawnSync = () => { spawns++; return { status: 0, signal: null } }
    syncBuiltinESMExports()
    for (const [source, available] of [['export let main=()=>11', false], ['export let main=()=>11', true], ['export let main=()=>22', true]]) {
      present = available
      assert.throws(() => mod.compileViaKernel(source), e => e === error, 'the original load failure survives missing/present artifacts and different programs')
    }` : `await assert.rejects(import(${JSON.stringify(new URL(file, import.meta.url).href)}), e => e === error)`}
    assert.equal(spawns, ${failure === 'exit-zero subprocess' ? 1 : 0})
    assert.equal(reads, ${failure === 'exit-zero subprocess' ? 0 : 1})
    console.log('failed closed')
  `], { encoding: 'utf8', timeout: 60_000 })
  ok(out.endsWith('failed closed\n'), `${file}: ${failure} failure cannot turn into a later success`)
})

test('self-build: kernel cache fixture preserves empty→empty→A→A→B→error→A outputs', () => {
  // A tiny fixture compiler, not bootstrap evidence: selects known output bytes
  // and traps on instance reuse. This isolates the adapter's cache/error boundary.
  const source = `let calls=0; export default function compile(source) {
    calls++; if(calls!==1) throw 'fixture instance reused';
    if(source==='!') throw 'fixture compile error';
    return new Uint8Array(source==='B'?${JSON.stringify([...B])}:source===''?${JSON.stringify([...compile('(module)')])}:${JSON.stringify([...A])})
  }`
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import cp from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'
    import { compile } from ${JSON.stringify(new URL('../index.js', import.meta.url).href)}
    import { instantiate } from ${JSON.stringify(new URL('../interop.js', import.meta.url).href)}
    const fixture = compile(${JSON.stringify(source)}, { optimize: false, host: 'js' })
    const probe = instantiate(fixture, { memory: 64 })
    probe.exports.default(probe.memory.String('A'))
    assert.throws(() => probe.exports.default(probe.memory.String('A')), /fixture instance reused/)
    const exists = fs.existsSync, read = fs.readFileSync
    const artifact = path => typeof path === 'string' && path.endsWith(${JSON.stringify(join('dist', 'jz.wasm'))})
    let reads = 0
    fs.existsSync = path => artifact(path) ? true : exists(path)
    fs.readFileSync = (path, ...args) => { if (artifact(path)) { reads++; return fixture } return read(path, ...args) }
    cp.spawnSync = () => { throw new Error('must reuse the selected artifact') }
    syncBuiltinESMExports()
    const { compileViaKernel } = await import(${JSON.stringify(new URL('./kernel-target.js', import.meta.url).href)})
    const retained = []
    const check = (source, bytes) => {
      const exports = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports
      if (source === '') assert.deepEqual(Object.keys(exports), [])
      else assert.equal(exports.value(), source === 'B' ? 22 : 11)
    }
    for (const source of ['', '', 'A', 'A', 'B', '!', 'A']) {
      if (source === '!') { assert.throws(() => compileViaKernel(source), /fixture compile error/); continue }
      const bytes = compileViaKernel(source)
      const expected = source === '' ? ${JSON.stringify([...compile('(module)')])} : source === 'B' ? ${JSON.stringify([...B])} : ${JSON.stringify([...A])}
      assert.deepEqual([...bytes], expected)
      check(source, bytes)
      retained.push([source, bytes, expected])
    }
    for (const [source, bytes, expected] of retained) { assert.deepEqual([...bytes], expected); check(source, bytes) }
    assert.equal(reads, 1, 'cache the module, not a compiler instance or a program failure')
    console.log('cache fixture passed')
  `], { encoding: 'utf8', timeout: 60_000 })
  ok(out.endsWith('cache fixture passed\n'), 'selected artifact read once; exact outputs survive later calls and errors')
})

test('self-build: empty, truncated, and invalid output fail validation without retry', () => {
  for (const bytes of [new Uint8Array(), compile('(module)').slice(0, -1), B.slice(0, -1), new Uint8Array([1, 2, 3])]) {
    fixture(({ root, builder, attempts }) => {
      builder(output(bytes))
      const load = selfBuild(root)
      throws(load, WebAssembly.CompileError)
      throws(load, WebAssembly.CompileError)
      is(attempts().length, 1)
    })
  }
})

test('self-build: an empty valid module is a successful build', () => {
  fixture(({ root, builder, attempts }) => {
    const empty = compile('(module)')
    builder(output(empty))
    const load = selfBuild(root)
    is([...load()], [...empty])
    is(Object.keys(new WebAssembly.Instance(new WebAssembly.Module(load())).exports), [])
    is(attempts().length, 1)
  })
})

test('self-build: writes split before or at the final byte retain the complete module', () => {
  for (const split of [B.length - 1, B.length]) fixture(({ root, builder, attempts }) => {
    builder(`${output(B.slice(0, split))}; appendFileSync(process.argv[2], new Uint8Array(${JSON.stringify([...B.slice(split)])}))`)
    const load = selfBuild(root)
    is([...load()], [...B])
    is(result(load()), 22, `split ${split}: the completed module executes`)
    is(attempts().length, 1)
  })
})

test('self-build: setup and cleanup failures stay failed after the filesystem recovers', () => {
  for (const operation of ['mkdtempSync', 'rmSync']) fixture(({ root, builder, attempts }) => {
    builder(output(B))
    const load = selfBuild(root), original = fs[operation]
    let calls = 0
    fs[operation] = () => { calls++; throw new Error(`injected ${operation} failure`) }
    syncBuiltinESMExports()
    try { throws(load, new RegExp(`injected ${operation} failure`)) }
    finally {
      fs[operation] = original
      syncBuiltinESMExports()
      // A deliberately failed cleanup leaves the private directory for this test.
      for (const out of attempts()) rmSync(dirname(out), { recursive: true, force: true })
    }
    throws(load, new RegExp(`injected ${operation} failure`), 'no retry or cached success after recovery')
    is(calls, 1)
    is(attempts().length, operation === 'mkdtempSync' ? 0 : 1)
  })
})

test('self-build: successful bytes survive output cleanup and independent later builds', () => {
  fixture(({ root, stale, builder, attempts }) => {
    builder(output(A))
    const load = selfBuild(root), a1 = load(), a2 = load()
    is(a1, a2, 'one build shared by consumers in this run')
    builder(output(B))
    const b = selfBuild(root)()
    is(result(b), 22, 'new run receives B, not the valid stale A')
    is(result(load()), 11, 'earlier run retains its own output')
    is(result(a1), 11)
    is(result(a2), 11)
    is(result(readFileSync(stale)), 11, 'gate builds do not overwrite dist')
    is(attempts().length, 2)
  })
})
