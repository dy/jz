import test from 'tst'
import { is } from 'tst/assert.js'
import { MEMORY_CASES, memoryFloor } from './_memory-floor.js'
import { linuxSwapUsedMB } from '../bench/machine-state.mjs'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const evidence = () => Object.fromEntries(MEMORY_CASES.map(name => [name, {
  targets: { jz: { parity: 'ok', memKb: 64 }, v8: { parity: 'ok', memKb: 64 } },
}]))

test('memory evidence: Linux swap is measured, including a host with swap disabled', () => {
  is(linuxSwapUsedMB('SwapTotal: 2048 kB\nSwapFree: 512 kB\n'), 1.5)
  is(linuxSwapUsedMB('SwapTotal: 0 kB\nSwapFree: 0 kB\n'), 0)
  for (const text of ['', 'SwapTotal: 1024 kB', 'SwapTotal: 1 kB\nSwapFree: 2 kB', 'SwapTotal: 1 MB\nSwapFree: 0 kB', 'SwapTotal: 999999999999999999999 kB\nSwapFree: 0 kB'])
    is(linuxSwapUsedMB(text), null, 'missing or invalid data is not reported as zero swap')
})

test('memory evidence: parity, complete coverage and finite RSS precede comparison', () => {
  is(memoryFloor({}).missing, MEMORY_CASES)
  is(memoryFloor(evidence()), { missing: [], losses: [], rows: MEMORY_CASES.map(name => [name, 64, 64]) })
  for (const target of ['jz', 'v8']) for (const bad of [undefined, null, 0, -1, NaN, Infinity]) {
    const cases = evidence()
    cases.watr.targets[target].memKb = bad
    is(memoryFloor(cases).missing, ['watr'], `${target}: ${bad} cannot establish a memory result`)
  }
  for (const parity of ['mismatch', 'unknown', undefined]) {
    const cases = evidence()
    cases.jessie.targets.jz = { parity, memKb: 1 }
    is(memoryFloor(cases).missing, ['jessie'], 'a small incorrect result cannot win')
  }
})

test('memory evidence: a win elsewhere cannot hide one allocation-heavy loss', () => {
  const cases = evidence()
  cases.jessie.targets.jz.memKb = 32
  cases.watr.targets.jz.memKb = 65
  is(memoryFloor(cases).losses, [['watr', 65 / 64]])
  cases.watr.targets.jz.memKb = 64
  is(memoryFloor(cases).losses, [])
})

test('memory evidence: paired runs use both positions and reject incomplete RSS', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'jz bench memory '))
  try {
    const hook = join(scratch, 'rss.mjs'), json = join(scratch, 'results.json')
    writeFileSync(hook, `import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
const spawn = cp.spawnSync, samples = JSON.parse(process.env.JZ_TEST_RSS)
cp.spawnSync = (cmd, args, opts) => {
  if (args.some(a => a.endsWith('/run-v8.mjs'))) {
    const rss = samples.shift()
    return { status: 0, stdout: 'median_us=10 checksum=633180752 samples=1 stages=1 runs=1',
      stderr: rss == null ? '' : 'Maximum resident set size (kbytes): ' + rss }
  }
  if (cmd === '/usr/bin/time') return { status: 0 }
  return spawn(cmd, args, opts)
}
syncBuiltinESMExports()
`)
    for (const [samples, want] of [
      [[900, 10, 90, 20, 80], 50], // warm, then two forward/reverse pairs
      [[900, 10, null, 20, 80], null],
      [[900, 10, 90, 0, 80], null],
    ]) {
      execFileSync(process.execPath, ['--import', hook, fileURLToPath(new URL('../bench/bench.mjs', import.meta.url)),
        '--cases=alpha', '--targets=v8', '--paired=2', `--json=${json}`], {
        encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, JZ_TEST_RSS: JSON.stringify(samples),
          JZ_BENCH_BUILD_DIR: join(scratch, 'build'), JZ_BENCH_WEB_DIR: join(scratch, 'web') },
      })
      is(JSON.parse(readFileSync(json, 'utf8')).cases.alpha.targets.v8.memKb, want)
    }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('reference evidence: CI paths retain corpus, memory and native release gates', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'jz reference gates '))
  try {
    const root = fileURLToPath(new URL('../', import.meta.url))
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const watr = JSON.parse(readFileSync(join(root, 'node_modules/watr/package.json'), 'utf8')).version
    const names = Object.keys(JSON.parse(readFileSync(join(root, 'bench/results.json'), 'utf8')).cases)
    const fresh = () => ({ meta: { commit, versions: { watr }, machineState: { swapUsedMB: 0 } },
      cases: Object.fromEntries(names.map(name => [name, { targets: Object.fromEntries(
        ['jz', 'v8', 'jz-w2c'].map(target => [target, { parity: 'ok', medianUs: 1, memKb: 64 }])) }])) })
    const json = join(scratch, 'reference.json'), memory = join(scratch, 'memory.json')
    for (const [label, edit, want, separate = true] of [
      ['complete fresh evidence', () => {}, 0],
      ['one snapshot supplies speed and memory by default', () => {}, 0, false],
      ['missing corpus member', r => { delete r.cases.alpha }, 1],
      ['missing memory row', (_, m) => { delete m.cases.watr.targets.v8 }, 1],
      ['memory loss', (_, m) => { m.cases.watr.targets.jz.memKb = 65 }, 1],
      ['partial memory run', (_, m) => { m.meta.partial = true }, 1],
      ['unknown row commit', (_, m) => { m.cases.watr.targets.jz.measuredAt = '0000000' }, 1],
      ['unknown V8 memory commit', (_, m) => { m.cases.watr.targets.v8.measuredAt = '0000000' }, 1],
      ['empty row commit does not borrow fresh metadata', (_, m) => { m.cases.watr.targets.v8.measuredAt = '' }, 1],
      ['RSS provenance without a timing', (_, m) => {
        delete m.cases.watr.targets.jz.medianUs
        m.cases.watr.targets.jz.measuredAt = '0000000'
      }, 1],
      ['valid RSS without timing', (_, m) => {
        for (const name of MEMORY_CASES) for (const target of ['jz', 'v8']) delete m.cases[name].targets[target].medianUs
      }, 0],
      ['invalid snapshot commit', (_, m) => { m.meta.commit = 'HEAD' }, 1],
      ['missing machine state', (_, m) => { delete m.meta.machineState }, 1],
      ['swap below the cap', (_, m) => { m.meta.machineState.swapUsedMB = 4095 }, 0],
      ['swap at the cap', (_, m) => { m.meta.machineState.swapUsedMB = 4096 }, 1],
      ['different codegen dependency', (_, m) => { m.meta.versions.watr = '0.0.0' }, 1],
      ['native per-case loss', r => { r.cases.alpha.targets['jz-w2c'].medianUs = 3.6 }, 1],
      ['native geomean loss', r => { for (const c of Object.values(r.cases)) c.targets['jz-w2c'].medianUs = 1.36 }, 1],
      ['native coverage hole', r => { for (const name of names.slice(1)) delete r.cases[name].targets['jz-w2c'] }, 1],
    ]) {
      const r = fresh(), m = fresh()
      edit(r, m)
      writeFileSync(json, JSON.stringify(r))
      writeFileSync(memory, JSON.stringify(m))
      const child = spawnSync(process.execPath, [join(root, 'test/bench-claims.js')], {
        cwd: root, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, JZ_BENCH_RESULTS: json, JZ_MEMORY_RESULTS: separate ? memory : '',
          TST_GREP: '^claims: (reference evidence covers|memory evidence is fresh|allocation-heavy|jz-w2c)' },
      })
      is(child.status, want, child.status === want ? label : `${label}: ${child.error || child.stdout.slice(-300)}`)
    }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
