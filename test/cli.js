// CLI tests
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { execFileSync } from 'child_process'
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

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

test('cli: -e expression', () => {
  const out = cli('-e', '1 + 2')
  is(out.trim(), '3')
})

test('cli: -e arithmetic', () => {
  is(cli('-e', '2 * 21').trim(), '42')
  is(cli('-e', '10 - 3').trim(), '7')
})

test('cli: -e file', () => {
  const file = join(tmp, 'eval.js')
  writeFileSync(file, 'export let main = () => 99')
  const out = cli('-e', file)
  // Should output exports object or the value
  ok(out.includes('main'), 'exports main')
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
  is(inst.exports.add(3, 4), 7)

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

test('cli: supplies import.meta.url for entry file', () => {
  const input = join(tmp, 'meta.js')
  const output = join(tmp, 'meta.wat')
  writeFileSync(input, 'export let f = () => import.meta.url')
  cli(input, '--wat', '-o', output)

  const wat = readFileSync(output, 'utf8')
  ok(wat.includes(pathToFileURL(input).href), 'WAT contains entry file URL')

  unlinkSync(output)
})

test('cli: -e with console.log (WASI)', () => {
  const file = join(tmp, 'wasi-eval.js')
  writeFileSync(file, 'export let main = () => { console.log(42); return 0 }')
  // Should not crash — CLI provides WASI imports
  const out = cli('-e', file)
  ok(out.includes('42') || out.includes('main'), 'WASI eval produces output')
})

test('cli: bad input exits 1', () => {
  const { status } = cliFail('-e', '???:::')
  is(status, 1)
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

test('cli: --resolve resolves bare modules from input directory', () => {
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

  cli(mainFile, '--resolve', '-o', outFile)

  const wasm = readFileSync(outFile)
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod)
  is(inst.exports.f(), 42)
})

// Cleanup temp files
test('cli: cleanup', () => {
  try { unlinkSync(join(tmp, 'wasi-eval.js')) } catch {}
  try { unlinkSync(join(tmp, 'eval.js')) } catch {}
  try { unlinkSync(join(tmp, 'add.js')) } catch {}
  try { unlinkSync(join(tmp, 'mul.js')) } catch {}
  try { unlinkSync(join(tmp, 'def.js')) } catch {}
})
