// CLI tests
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { execFileSync, execSync } from 'child_process'
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

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

// Cleanup temp files
test('cli: cleanup', () => {
  try { unlinkSync(join(tmp, 'wasi-eval.js')) } catch {}
  try { unlinkSync(join(tmp, 'eval.js')) } catch {}
  try { unlinkSync(join(tmp, 'add.js')) } catch {}
  try { unlinkSync(join(tmp, 'mul.js')) } catch {}
  try { unlinkSync(join(tmp, 'def.js')) } catch {}
})
