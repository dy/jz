import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { oracle } from './util.js'

test('runner: the source oracle preserves module strictness and fresh state', async () => {
  const source = `let count = 0
    export function step() { return ++count }
    export function receiver() { return (function () { return this === undefined })() }
    export function write() { try { 'ab'[0] = 9; return 'stored' } catch (e) { return e.name } }
    const alias = () => count
    export { alias as read }`
  const module = await import('data:text/javascript,' + encodeURIComponent(source))
  const reference = oracle(source)
  for (const key of ['receiver', 'write', 'step', 'step', 'read'])
    is(reference[key](), module[key](), `${key} follows the actual module`)
  is(oracle(source).read(), 0, 'another oracle starts from its own initialization')
  is(oracle('').missing, undefined, 'zero exports produce an empty namespace')
})

function fixture(sources, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jz-runner-'))
  try {
    const files = sources.map((source, i) => {
      const file = join(dir, `${i}.mjs`)
      writeFileSync(file, `import test from ${JSON.stringify(import.meta.resolve('tst'))}\n${source}`)
      return pathToFileURL(file).href
    })
    const childEnv = { ...process.env }
    for (const key of Object.keys(childEnv)) if (key.startsWith('TST_')) delete childEnv[key]
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { runFiles } from ${JSON.stringify(new URL('./_run.js', import.meta.url).href)}
      const result = await runFiles(${JSON.stringify(files)})
      process.exit(result.failed.length ? 1 : 0)
    `], { env: { ...childEnv, ...env }, encoding: 'utf8', timeout: 60000 })
    if (result.error) throw result.error
    return { status: result.status, output: result.stdout + result.stderr }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('runner: slow imports complete before tests run, with shared state across files', () => {
  const r = fixture([
    `test('first', ({ is }) => { is(globalThis.loaded, true); globalThis.shared = 7 })`,
    `await new Promise(r => setTimeout(r, 100))
     globalThis.loaded = true
     test('second', ({ is }) => is(globalThis.shared, 7))`,
  ])
  is(r.status, 0, r.status === 0 ? 'child suite passed' : r.output)
  ok(r.output.includes('# pass 2'), 'both files executed')
})

test('runner: failures propagate while later tests still run', () => {
  const r = fixture([
    `test('failure', ({ is }) => is(1, 2))`,
    `test('later', ({ is }) => is(7, 7))`,
  ], { TST_FORMAT: 'tap' })
  is(r.status, 1)
  const failed = r.output.includes('not ok 1 - failure')
  const continued = r.output.includes('ok 2 - later')
  ok(failed, failed ? 'TAP records the failing test' : r.output)
  ok(continued, continued ? 'TAP records the later passing test' : r.output)
  ok(r.output.includes('1..2'), 'one complete TAP plan')
})

test('runner: grep and only select across the complete file list', () => {
  const sources = [
    `test('early', () => { throw Error('must not run') })`,
    `await new Promise(r => setTimeout(r, 100))
     test.only('chosen', ({ is }) => is(1, 1))
     test.skip('skipped', () => { throw Error('must not run') })`,
  ]
  for (const env of [{}, { TST_GREP: '^chosen$', TST_MUTE: '1' }]) {
    const r = fixture(sources, env)
    is(r.status, 0, r.status === 0 ? 'child suite passed' : r.output)
    ok(r.output.includes('# pass 1'), 'only the selected test runs')
  }
})

test('runner: completed tests release unreachable Wasm memories', () => {
  const r = fixture([`
    test('allocate', () => { globalThis.dead = new WeakRef(new WebAssembly.Memory({ initial: 1 })) })
    for (let i = 0; i < 40; i++) test('advance ' + i, () => {})
    test('reclaimed', ({ is }) => is(globalThis.dead.deref(), undefined))
  `])
  is(r.status, 0, r.status === 0 ? 'child suite passed' : r.output)
  ok(r.output.includes('# pass 42'), 'the lifecycle check ran')
})
