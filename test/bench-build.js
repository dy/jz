import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { instantiate } from '../interop.js'
import { compileJzAt } from '../bench/_lib/compile.js'
import { agreement, exactAgreement, channelsAgree, agrees } from '../bench/_audiojs/compare.mjs'

const ROOT = join(import.meta.dirname, '..')

test('audio comparison: every channel and encoded byte contributes to the verdict', () => {
  const left = Float32Array.of(1, 2), right = Float32Array.of(3, 4)
  is(agrees(channelsAgree([left, right], [left, right.slice()])), true)
  is(agrees(channelsAgree([left, right], [left, Float32Array.of(3, 5)])), false, 'a matching left channel cannot hide a wrong right channel')
  is(agrees(channelsAgree([left, right], [left])), false, 'a missing channel fails')
  const bytes = new Uint8Array(1 << 20).fill(255), changed = bytes.slice()
  changed[changed.length - 1]--
  is(agrees(agreement(bytes, changed)), true, 'this single-byte difference lies above the DSP rounding threshold')
  is(agrees(exactAgreement(bytes, changed)), false, 'encoded bytes still require exact parity')
  is(agrees(exactAgreement(bytes, bytes.slice())), true)
})

test('audio comparison: rounding, zero and invalid results have explicit verdicts', () => {
  is(agrees(agreement(Float64Array.of(1, 2), Float64Array.of(1, 2 + 1e-10))), true)
  is(agrees(agreement(Float64Array.of(1, 2), Float64Array.of(1, 3))), false)
  is(agrees(agreement(Float64Array.of(0), Float64Array.of(-0))), true, 'signed zero has zero numerical error')
  is(agrees(agreement(Float64Array.of(1), Float64Array.of(NaN))), false)
  is(agrees(agreement(Float64Array.of(1, 2), Float64Array.of(1))), false)
  is(agrees(agreement(Float64Array.of(1), Float64Array.of(1 + 10 ** (-99.9 / 20)))), false, 'rounding the reported dB cannot cross the acceptance threshold')
  is(agrees('99 dB'), false)
  is(agrees('100 dB'), true)
})

for (const id of ['worley', 'stdlib-erf']) test(`bench build: ${id} size binary agrees with the unchanged JavaScript workload`, async () => {
  const entry = join(ROOT, 'bench', id, `${id}.js`)
  const bytes = compileJzAt({ id, js: entry }, { level: 'size' })
  let actual, expected
  const wasm = instantiate(bytes, { imports: {
    env: { logResult: (...row) => { actual = row; actual[1] >>>= 0 } },
    performance: { now: () => performance.now() },
  } }).exports
  const node = await import(entry)
  const log = console.log
  console.log = line => {
    const m = /^median_us=(\d+) checksum=(\d+) samples=(\d+) stages=(\d+) runs=(\d+)$/.exec(line)
    if (!m) throw Error(`unexpected bench output: ${line}`)
    expected = m.slice(1).map(Number)
  }
  try { node.main() } finally { console.log = log }
  wasm.main()
  ok(actual && expected, 'both targets reported')
  is(actual.slice(1), expected.slice(1), 'checksum and workload metadata agree')
})

test('bench build: a failed size compilation fails the command and names the cause', () => {
  const script = join(ROOT, 'scripts/bench-size.mjs')
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    const read = fs.readFileSync
    fs.readFileSync = (path, ...args) => String(path).endsWith('/bench/lz/lz.js')
      ? 'export let main = () => {' : read(path, ...args)
    syncBuiltinESMExports()
    process.argv = [process.execPath, ${JSON.stringify(script)}, 'lz', '--json']
    await import(${JSON.stringify(new URL('../scripts/bench-size.mjs', import.meta.url).href)})
  `], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: '' } })
  if (result.error) throw result.error
  is(result.status, 1, 'a blank size cannot be a successful run')
  ok(result.stderr.includes('lz: jz compilation failed:'), 'the failing case and compiler error are visible')
  ok(result.stdout.includes('SIZE lz jz= '), 'the record retains the failed case')
})

test('bench build: an isolated compiler crash preserves the failure and later size rows', () => {
  const script = join(ROOT, 'scripts/bench-size.mjs')
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import cp from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'
    const spawn = cp.spawnSync
    cp.spawnSync = (cmd, args, opts) => args?.some(a => a.endsWith('/compile-jz-self.mjs'))
      ? { status: null, signal: 'SIGABRT', stderr: 'heap exhausted' } : spawn(cmd, args, opts)
    syncBuiltinESMExports()
    process.argv = [process.execPath, ${JSON.stringify(script)}, 'jz', 'lz', '--json']
    await import(${JSON.stringify(new URL('../scripts/bench-size.mjs', import.meta.url).href)})
  `], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: '' } })
  if (result.error) throw result.error
  is(result.status, 1, 'the crashed row fails the whole command')
  ok(result.stderr.includes('jz: jz compilation failed: compiler benchmark build terminated by SIGABRT: heap exhausted'), 'case, signal and cause survive')
  ok(result.stdout.includes('SIZE jz jz= '), 'the crashed case remains in the results')
  ok(/SIZE lz jz=\d+ /.test(result.stdout), 'the following case still compiles')
})
