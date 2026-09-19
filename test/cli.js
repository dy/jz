// CLI tests
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { execFileSync, spawnSync } from 'child_process'
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { belowOpt, adaptI64 } from './_matrix.js'

const CLI = new URL('../cli.js', import.meta.url).pathname

function cli(...args) {
  return execFileSync('node', [CLI, ...args], { encoding: 'utf8', timeout: 10000 })
}

function cliFail(...args) {
  try {
    execFileSync('node', [CLI, ...args], { encoding: 'utf8', timeout: 10000, stdio: 'pipe' })
    throw new Error('Expected non-zero exit')
  } catch (e) {
    if (e.message === 'Expected non-zero exit') throw e
    return { stderr: e.stderr, status: e.status }
  }
}

// spawnSync variant — captures stderr even on success (for --why).
function cliBoth(...args) {
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8', timeout: 10000 })
  return { stdout: r.stdout, stderr: r.stderr, status: r.status }
}

const flat = (s) => s.replace(/\s+/g, ' ')

// Temp dir for test files
const tmp = mkdtempSync(join(tmpdir(), 'jz-cli-'))

test('cli: no args shows help', () => {
  const out = cli()
  ok(out.includes('jz'), 'shows jz in help')
  ok(out.includes('Usage'), 'shows usage')
})

test('cli: --help shows help', () => {
  const out = cli('--help')
  ok(out.includes('Usage'), 'shows usage')
})

test('cli: --version shows version', () => {
  const out = cli('--version')
  // Version format: semver like 0.2.1
  ok(/^\d+\.\d+\.\d+/.test(out.trim()), 'shows semver version')
})

test('cli: -v shows version', () => {
  const out = cli('-v')
  ok(/^\d+\.\d+\.\d+/.test(out.trim()), '-v shows semver version')
})

test('cli: compile .js → .wasm', () => {
  const input = join(tmp, 'add.js')
  const output = join(tmp, 'add.wasm')
  writeFileSync(input, 'export let add = (a, b) => a + b')
  cli(input, '-o', output)

  const wasm = readFileSync(output)
  ok(wasm.byteLength > 0, 'wasm file not empty')
  // Validate it's actual WASM (magic number \0asm)
  is(wasm[0], 0x00)
  is(wasm[1], 0x61)
  is(wasm[2], 0x73)
  is(wasm[3], 0x6d)

  // Validate it runs
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod)
  is(adaptI64(mod, inst.exports).add(3, 4), 7)

  unlinkSync(output)
})

test('cli: compile .js → .wat', () => {
  const input = join(tmp, 'mul.js')
  const output = join(tmp, 'mul.wat')
  writeFileSync(input, 'export let mul = (a, b) => a * b')
  cli(input, '-o', output)

  const wat = readFileSync(output, 'utf8')
  ok(wat.includes('module'), 'wat contains module')
  ok(wat.includes('func'), 'wat contains func')
  ok(wat.includes('mul'), 'wat contains export name')

  unlinkSync(output)
})

test('cli: compile default output name', () => {
  const input = join(tmp, 'def.js')
  const output = join(tmp, 'def.wasm')
  writeFileSync(input, 'export let x = () => 1')
  cli(input)

  const wasm = readFileSync(output)
  ok(wasm.byteLength > 0, 'default output created')

  unlinkSync(output)
})

test('cli: supplies import.meta.url for entry file', async () => {
  const input = join(tmp, 'meta.js')
  const output = join(tmp, 'meta.wasm')
  writeFileSync(input, 'export let f = () => import.meta.url')
  cli(input, '-o', output)

  const { instantiate } = await import('../interop.js')
  const mod = instantiate(readFileSync(output))
  is(mod.memory.read(mod.exports.f()), pathToFileURL(input).href, 'compiled entry file URL')

  unlinkSync(output)
})

test('cli: bad input exits 1', () => {
  const file = join(tmp, 'bad.js')
  writeFileSync(file, '???:::')
  const { status } = cliFail(file)
  is(status, 1)
})

test('cli: unknown option exits 1', () => {
  const file = join(tmp, 'bad.js')
  const { stderr, status } = cliFail(file, '--bogus')
  is(status, 1)
  ok(/unknown option/.test(stderr), 'names the option')
})

test('cli: missing file exits 1', () => {
  const { status } = cliFail(join(tmp, 'nonexistent.js'))
  is(status, 1)
})

// Regression: CLI should resolve transitive filesystem imports automatically.
// README says "Transitive imports work" and "CLI resolves filesystem imports automatically",
// but the CLI only scans top-level imports with a regex, missing nested imports.
test('cli: transitive filesystem imports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jz-transitive-'))
  const mainFile = join(dir, 'main.js')
  const mathFile = join(dir, 'math.js')
  const utilsFile = join(dir, 'utils.js')
  const outFile = join(dir, 'main.wasm')

  writeFileSync(mainFile, 'import { add } from "./math.js"; export let f = (a, b) => add(a, b)')
  writeFileSync(mathFile, 'import { sq } from "./utils.js"; export let add = (a, b) => a + b')
  writeFileSync(utilsFile, 'export let sq = (x) => x * x')

  // This should work per README, but currently fails with:
  // Error: Unknown module './utils.js'
  cli(mainFile, '-o', outFile)

  const wasm = readFileSync(outFile)
  ok(wasm.byteLength > 0, 'transitive import wasm produced')

  unlinkSync(outFile)
  unlinkSync(mainFile)
  unlinkSync(mathFile)
  unlinkSync(utilsFile)
})

test('cli: bare specifiers resolve through node_modules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jz-bare-resolve-'))
  const pkgDir = join(dir, 'node_modules', 'pkg')
  const mainFile = join(dir, 'main.js')
  const modFile = join(pkgDir, 'index.js')
  const pkgFile = join(pkgDir, 'package.json')
  const outFile = join(dir, 'main.wasm')

  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(pkgFile, JSON.stringify({ type: 'module', main: './index.js' }))
  writeFileSync(modFile, 'export let val = () => 42')
  writeFileSync(mainFile, 'import { val } from "pkg"; export let f = () => val()')

  cli(mainFile, '-o', outFile)

  const wasm = readFileSync(outFile)
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod)
  is(adaptI64(mod, inst.exports).f(), 42)
})

test('cli: --memory sets initial and maximum pages', () => {
  const input = join(tmp, 'mem.js')
  const output = join(tmp, 'mem.wat')
  // Dynamic-length typed array can't be scalarized away, so it genuinely needs
  // linear memory (a const read-only array now compiles memory-free).
  writeFileSync(input, 'export let f = (n) => { let a = new Float64Array(n); a[0] = 1.5; return a[0] }')
  cli(input, '--wat', '--memory', '4:16', '-o', output)
  ok(flat(readFileSync(output, 'utf8')).includes('(memory (export "memory") 4 16'), 'memory min/max emitted')
  unlinkSync(output)
})

test('cli: --memory maximum below initial fails', () => {
  const input = join(tmp, 'mem.js')
  const { status } = cliFail(input, '--memory', '10:4', '-o', join(tmp, 'x.wasm'))
  is(status, 1)
})

test('cli: -D / --define injects a compile-time constant', () => {
  const input = join(tmp, 'def-const.js')
  const output = join(tmp, 'def-const.wasm')
  writeFileSync(input, 'export let f = () => N')
  cli(input, '-D', 'N=42', '-o', output)
  const mod = new WebAssembly.Module(readFileSync(output))
  const inst = new WebAssembly.Instance(mod)
  inst.exports._initialize?.()  // wasi leg: reactor init (js leg ran the start section)
  is(adaptI64(mod, inst.exports).f(), 42)
  unlinkSync(output)
})

test('cli: --no-simd disables auto-vectorization', () => {
  // The CLI inherits the run's JZ_TEST_OPTIMIZE: below level 2 the default doesn't
  // auto-vectorize, so the "default vectorizes (sanity)" baseline can't hold.
  if (belowOpt(2)) return
  const input = join(tmp, 'vec.js')
  const dflt = join(tmp, 'vec.wat')
  const nosimd = join(tmp, 'vec-nosimd.wat')
  writeFileSync(input, 'export let f = (n) => { let a = new Float64Array(n); let i = 0; for (i = 0; i < n; i++) a[i] = a[i] * 2; return a[0] }')
  cli(input, '--wat', '-o', dflt)
  cli(input, '--wat', '--no-simd', '-o', nosimd)
  ok(/v128|f64x2|i32x4|f32x4/.test(readFileSync(dflt, 'utf8')), 'default vectorizes (sanity)')
  ok(!/v128|f64x2|i32x4|f32x4/.test(readFileSync(nosimd, 'utf8')), '--no-simd emits no v128')
  unlinkSync(dflt); unlinkSync(nosimd)
})

test('cli: --no-tail-call uses ordinary call frames', () => {
  const input = join(tmp, 'tc.js')
  const dflt = join(tmp, 'tc.wat')
  const notc = join(tmp, 'tc-no.wat')
  writeFileSync(input, 'export let sum = (n, acc) => n == 0 ? acc : sum(n - 1, acc + n)')
  cli(input, '--wat', '-o', dflt)
  cli(input, '--wat', '--no-tail-call', '-o', notc)
  ok(/return_call/.test(readFileSync(dflt, 'utf8')), 'default emits return_call (sanity)')
  ok(!/return_call/.test(readFileSync(notc, 'utf8')), '--no-tail-call emits no return_call')
  unlinkSync(dflt); unlinkSync(notc)
})

// audit-#11: --host native's TargetProfile (src/session.js) forces the SAME
// noTailCall policy --no-tail-call sets explicitly — the wasm2c/native-lowering
// lane (scripts/native/) needs it without every caller remembering the flag.
// Pins the profile's own field, not just the pre-existing explicit-override path
// the test above already covers.
test('cli: --host native uses ordinary call frames (wasm2c return_call workaround)', () => {
  const input = join(tmp, 'tcn.js')
  const native = join(tmp, 'tcn-native.wat')
  writeFileSync(input, 'export let sum = (n, acc) => n == 0 ? acc : sum(n - 1, acc + n)')
  cli(input, '--wat', '--host', 'native', '-o', native)
  ok(!/return_call/.test(readFileSync(native, 'utf8')), '--host native emits no return_call')
  unlinkSync(native)
})

test('cli: --host native accepted, rejects unknown host', () => {
  const input = join(tmp, 'tcn2.js')
  writeFileSync(input, 'export let f = () => 1')
  ok(cli(input, '--wat', '--host', 'native', '-o', '-').includes('module'), '--host native compiles')
  const { stderr, status } = cliFail(input, '--wat', '--host', 'bogus', '-o', '-')
  is(status, 1)
  ok(/Invalid host/.test(stderr), 'unknown host still rejected')
})

test('cli: --names emits a wasm name section', () => {
  const input = join(tmp, 'names.js')
  const withNames = join(tmp, 'names-on.wasm')
  const without = join(tmp, 'names-off.wasm')
  writeFileSync(input, 'export let addup = (a, b) => a + b')
  cli(input, '--names', '-o', withNames)
  cli(input, '-o', without)
  const a = readFileSync(withNames), b = readFileSync(without)
  ok(a.byteLength > b.byteLength, 'name section adds bytes')
  ok(new TextDecoder().decode(a).includes('addup'), 'function name present in section')
  unlinkSync(withNames); unlinkSync(without)
})

test('cli: -Os, -O3, -O0 and an optimize object all compile', () => {
  const input = join(tmp, 'opt.js')
  const output = join(tmp, 'opt.wasm')
  writeFileSync(input, 'export let f = (a, b) => a + b')
  cli(input, '-Os', '-o', output); ok(readFileSync(output).byteLength > 0, '-Os compiles')
  cli(input, '-O3', '-o', output); ok(readFileSync(output).byteLength > 0, '-O3 compiles')
  cli(input, '-O0', '-o', output); ok(readFileSync(output).byteLength > 0, '-O0 compiles')
  cli(input, '-O', '{"level":"size","tailCall":false}', '-o', output); ok(readFileSync(output).byteLength > 0, '-O object compiles')
  const { status, stderr } = cliFail(input, '-O1', '-o', output)
  is(status, 1); ok(/unknown optimization level/.test(stderr), 'unlisted level is refused')
  unlinkSync(output)
})

test('cli: -O object switches SIMD off like --no-simd', () => {
  if (belowOpt(2)) return
  const input = join(tmp, 'vec2.js')
  const out = join(tmp, 'vec2.wat')
  writeFileSync(input, 'export let f = (n) => { let a = new Float64Array(n); let i = 0; for (i = 0; i < n; i++) a[i] = a[i] * 2; return a[0] }')
  cli(input, '--wat', '-O', '{"simd":false}', '-o', out)
  ok(!/v128|f64x2|i32x4|f32x4/.test(readFileSync(out, 'utf8')), 'no v128 through the optimize object')
  unlinkSync(out)
})

test('cli: --why reports declined loops on stderr', () => {
  if (belowOpt(2)) return
  const input = join(tmp, 'why.js')
  const output = join(tmp, 'why.wasm')
  // a loop-carried dependency: the vectorizer must decline and say why
  writeFileSync(input, 'export let f = (n) => { let a = new Float64Array(n); for (let i = 1; i < n; i++) a[i] = a[i - 1] + 1; return a[0] }')
  const { stderr, status } = cliBoth(input, '--why', '-o', output)
  is(status, 0)
  ok(/warning\[(simd-why-not|rewind-why-not)\]/.test(stderr), 'why-not report on stderr')
  unlinkSync(output)
})

// Cleanup temp files
test('cli: cleanup', () => {
  for (const f of ['bad.js', 'add.js', 'mul.js', 'def.js', 'mem.js', 'def-const.js',
    'vec.js', 'vec2.js', 'tc.js', 'tcn.js', 'tcn2.js', 'names.js', 'opt.js', 'why.js'])
    try { unlinkSync(join(tmp, f)) } catch {}
})
