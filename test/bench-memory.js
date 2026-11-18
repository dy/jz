import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { MEMORY_CASES, memoryFloor } from './_memory-floor.js'
import { linuxSwapUsedMB } from '../bench/machine-state.mjs'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  is(memoryFloor(evidence()), { missing: [], losses: [], held: [], rows: MEMORY_CASES.map(name => [name, 64, 64]) })
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

test('memory evidence: a named band holds its case and fails past it', () => {
  const cases = evidence(), bands = new Map([['watr', { band: 1.1 }]])
  cases.watr.targets.jz.memKb = 70
  is(memoryFloor(cases, bands), { missing: [], losses: [], held: [['watr', 70 / 64]], rows: MEMORY_CASES.map(name => [name, name === 'watr' ? 70 : 64, 64]) })
  cases.watr.targets.jz.memKb = 71
  is(memoryFloor(cases, bands).losses, [['watr', 71 / 64]])
  cases.webaudio.targets.jz.memKb = 65
  is(memoryFloor(cases, bands).losses, [['watr', 71 / 64], ['webaudio', 65 / 64]], 'a band names one case')
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
    return { status: 0, stdout: 'median_us=10 checksum=633180752 samples=1 stages=1 runs=1\\npasses=1\\n',
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

// The pass rule (bench/_lib/passes.js) as the harness reads it: one line a pass, the last
// counted and the first kept, memory from a process of the first pass alone, every pass's
// checksum the first's but where the source's main carries state, the count printed, and
// the old protocol by its switch, never merged with the new.
test('pass rule: the last pass is counted, the first kept beside it, memory of one pass', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'jz bench passes '))
  try {
    const hook = join(scratch, 'passes.mjs'), json = join(scratch, 'results.json')
    writeFileSync(hook, `import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
const spawn = cp.spawnSync, ref = 633180752
// JZ_TEST_RSS_STEP: each process of one pass peaks 1 kB above the last, from 50
let ones = 0
const line = (us, cs = ref) => 'median_us=' + us + ' checksum=' + cs + ' samples=1 stages=1 runs=1\\n'
cp.spawnSync = (cmd, args, opts) => {
  const lane = args.find(a => /\\/run-(v8|jz-host)\\.mjs$/.test(a))
  if (lane) {
    const mode = (opts.env ?? process.env).JZ_BENCH_PASSES, n = mode === 'first' ? 1 : +mode || 3
    const { JZ_TEST_STATE: state, JZ_TEST_WRONG: wrong, JZ_TEST_LOST: lost } = process.env
    // state: the source's main answers another checksum on each call, under any engine (fabrik's
    // step); wrong: a pass after the first answers wrong where the source carries none, never
    // under Node's interpreter (a tier's miscompile); lost: 'silent', the passes after the first
    // print to nowhere, 'exit', the process ends after the first
    const calls = lane.endsWith('/run-v8.mjs'), jitless = args.includes('--jitless')
    const cs = k => k && (state && calls || wrong && !jitless) ? k : ref
    const stdout = n > 1 && lost === 'silent' ? line(30) + 'passes=3\\n' : n > 1 && lost === 'exit' ? line(30)
      : [30, 12, 10].slice(0, n).map((us, k) => line(us, cs(k))).join('') + 'passes=' + n + '\\n'
    return { status: 0, stdout, stderr: 'Maximum resident set size (kbytes): ' + (n > 1 ? 99 : process.env.JZ_TEST_RSS_STEP ? 50 + ones++ : 50) }
  }
  if (cmd === '/usr/bin/time') return { status: 0 }
  return spawn(cmd, args, opts)
}
syncBuiltinESMExports()
`)
    const bench = (args, env = {}) => spawnSync(process.execPath, ['--import', hook, fileURLToPath(new URL('../bench/bench.mjs', import.meta.url)),
      '--cases=alpha', '--no-web', `--json=${json}`, ...args], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...env, JZ_BENCH_BUILD_DIR: join(scratch, 'build'), JZ_BENCH_WEB_DIR: join(scratch, 'web') },
    })
    const read = () => JSON.parse(readFileSync(json, 'utf8'))
    let r = bench(['--targets=v8'])
    is(r.status, 0, r.stderr)
    const { v8 } = read().cases.alpha.targets
    is([v8.medianUs, v8.firstUs, v8.passes, v8.memKb, v8.parity, v8.settled], [10, 30, 3, 50, 'ok', undefined], 'the last pass, the first beside it, the memory of the first alone')
    is(read().meta.passes, { settleMs: 300, firstMs: 2400 }, 'the dataset names its protocol')

    r = bench(['--targets=v8'], { JZ_TEST_STATE: '1' })
    is(r.status, 0, r.stderr)
    is(read().cases.alpha.targets.v8, { medianUs: 30, firstUs: 30, passes: 1, settled: false, bytes: read().cases.alpha.targets.v8.bytes, memKb: 50, parity: 'ok' },
      'a main that answers otherwise on its next call is timed on its first pass, marked')
    ok(r.stderr.includes('as its source does under Node\'s interpreter'), r.stderr)
    r = bench(['--targets=v8', '--paired=3'], { JZ_TEST_RSS_STEP: '1' })
    is(r.status, 0, r.stderr)
    is(read().cases.alpha.targets.v8.memKb, 52.5,
      'paired memory: a first-pass process a counted run (50 to 55), the median of the rounds\' pair means, none in the warm round')
    r = bench(['--targets=jz,v8', '--paired=2'], { JZ_TEST_STATE: '1' })
    is(r.status, 0, r.stderr)
    is(read().cases.alpha.paired['jz/v8'], { ratios: [1, 1], median: 1 },
      'the paired verdict sets jz\'s first pass (30) against the unsettled lane\'s, not its counted one (10)')
    r = bench(['--targets=v8'], { JZ_TEST_WRONG: '1' })
    is(r.status, 0, r.stderr)
    let row = read().cases.alpha.targets.v8
    is([row.status, row.reason], ['fail', 'pass checksums differ: 633180752, 1, 2, where two calls of the source\'s main answer alike under Node\'s interpreter'],
      'a later tier\'s wrong answer fails the lane, never passes for state the source does not carry')
    r = bench(['--targets=jz'], { JZ_TEST_WRONG: '1' })
    is(r.status, 0, r.stderr)
    row = read().cases.alpha.targets.jz
    is([row.status, row.reason], ['fail', 'pass checksums differ: 633180752, 1, 2'], 'a fresh instance that answers otherwise fails')

    // a run whose count disagrees with its lines fails, never reads as one long first pass
    for (const [lost, lane, reason] of [['silent', 'jz', 'the pass rule ran 3 passes, 1 printed a result'],
      ['exit', 'v8', 'the pass rule printed no count after 1 result: the process ended before the rule did']]) {
      r = bench([`--targets=${lane}`], { JZ_TEST_LOST: lost })
      is(r.status, 0, r.stderr)
      row = read().cases.alpha.targets[lane]
      is([row.status, row.reason], ['fail', reason], `${lost}: ${lane} fails with what it printed`)
    }

    r = bench(['--targets=v8', '--passes=first'])
    is(r.status, 0, r.stderr)
    is([read().cases.alpha.targets.v8.medianUs, read().cases.alpha.targets.v8.firstUs, read().meta.passes], [30, 30, 'first'], 'the switch gives the first pass alone back')
    r = bench(['--targets=v8', '--merge', '--allow-unanchored'])
    is(r.status, 1, 'two protocols never merge')
    ok(r.stderr.includes('pass protocol'), r.stderr)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('paired benchmarks: a failed lane stops immediately without dropping siblings or later cases', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'jz paired failures '))
  try {
    const hook = join(scratch, 'runner.mjs'), json = join(scratch, 'results.json'), counts = join(scratch, 'counts.json')
    writeFileSync(hook, `import cp from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const spawn = cp.spawnSync, counts = {}
cp.spawnSync = (cmd, args, opts) => {
  if (cmd === '/usr/bin/time') return { status: 1 }
  const v8 = args.some(a => a.endsWith('/run-v8.mjs')), shell = cmd === 'fixture-jsc'
  if (v8 || shell) {
    const name = args.at(-1).includes('alpha') ? 'alpha' : 'mat4', key = (v8 ? 'v8/' : 'jsc/') + name
    counts[key] = (counts[key] || 0) + 1
    writeFileSync(${JSON.stringify(counts)}, JSON.stringify(counts))
    if (key === 'v8/alpha' && counts[key] === Number(process.env.JZ_TEST_FAIL_AT))
      return { status: 1, stderr: 'intentional lane failure' }
    return { status: 0, stdout: 'median_us=10 checksum=' + (name === 'alpha' ? 633180752 : 2929747182) + ' samples=1 stages=1 runs=1\\npasses=1\\n', stderr: '' }
  }
  return spawn(cmd, args, opts)
}
syncBuiltinESMExports()
`)
    for (const failAt of [2, 3]) {
      execFileSync(process.execPath, ['--import', hook, fileURLToPath(new URL('../bench/bench.mjs', import.meta.url)),
        '--cases=alpha,mat4', '--targets=v8,jsc', '--paired=2', `--json=${json}`], {
        encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, JSC_BIN: 'fixture-jsc', JZ_TEST_FAIL_AT: String(failAt),
          JZ_BENCH_BUILD_DIR: join(scratch, 'build'), JZ_BENCH_WEB_DIR: join(scratch, 'web') },
      })
      const { cases } = JSON.parse(readFileSync(json, 'utf8'))
      is(JSON.parse(readFileSync(counts, 'utf8')), { 'v8/alpha': failAt, 'jsc/alpha': 5, 'v8/mat4': 5, 'jsc/mat4': 5 })
      is(cases.alpha.targets.v8.status, 'fail', 'either counted position retains a failure')
      is(cases.alpha.targets.v8.medianUs, undefined, 'incomplete observations cannot establish a timing')
      is(cases.alpha.paired, undefined, 'a failed lane has no paired ratio')
      is(cases.alpha.targets.jsc.parity, 'ok', 'the other lane still completes')
      is(cases.mat4.targets.v8.parity, 'ok', 'failure does not leak into the next case')
    }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('JS benchmark runners: module and bundled self-compiler entries have native heap adapters', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'jz native self bench '))
  try {
    const hook = join(scratch, 'shell.mjs'), json = join(scratch, 'results.json'), builds = join(scratch, 'builds')
    // Execute the shell bundle in a fresh Node process: no installed JSC or
    // globals from the test process can hide a missing runtime adapter.
    writeFileSync(hook, `import cp from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const spawn = cp.spawnSync
cp.spawnSync = (cmd, args, opts) => {
  if (cmd === '/usr/bin/time') return { status: 1 }
  if (args.some(a => a.endsWith('/compile-jz-self.mjs'))) {
    appendFileSync(${JSON.stringify(builds)}, 'build\\n')
    return { status: 1, stderr: 'intentional self-build failure' }
  }
  return cmd === 'fixture-jsc' ? spawn(process.execPath, args, opts) : spawn(cmd, args, opts)
}
syncBuiltinESMExports()
`)
    const out = execFileSync(process.execPath, ['--import', hook, fileURLToPath(new URL('../bench/bench.mjs', import.meta.url)),
      '--cases=jz', '--targets=jz,v8,jsc', '--paired=1', `--json=${json}`], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, JSC_BIN: 'fixture-jsc',
        JZ_BENCH_BUILD_DIR: join(scratch, 'build'), JZ_BENCH_WEB_DIR: join(scratch, 'web') },
    })
    const { jz, v8, jsc } = JSON.parse(readFileSync(json, 'utf8')).cases.jz.targets
    is(readFileSync(builds, 'utf8'), 'build\n', 'a failed build is attempted once across warm and counted rounds')
    is(jz.status, 'fail', 'the build failure remains visible beside successful siblings')
    is(v8.status, undefined, JSON.stringify(v8))
    is(jsc.status, undefined, JSON.stringify(jsc))
    const checksums = [...out.matchAll(/\[paired\]\s+(?:v8|jsc)\b[^\n]*\bcs=(\d+)/g)].map(m => Number(m[1]))
    is(checksums.length, 2, 'both runners completed and hashed the repeated compilations')
    is(checksums[0], checksums[1], 'bundled and module runners compile the same bytes')
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

// A shell with no DOM events (JSC's) runs webaudio, whose contexts extend EventTarget,
// on the events jz itself compiles, and answers V8's checksum.
test('JS benchmark runners: a shell without EventTarget runs the webaudio engine', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'jz shell events '))
  try {
    const hook = join(scratch, 'shell.mjs'), bare = join(scratch, 'bare.mjs'), json = join(scratch, 'results.json')
    writeFileSync(bare, 'delete globalThis.EventTarget; delete globalThis.Event; delete globalThis.CustomEvent\n')
    writeFileSync(hook, `import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
const spawn = cp.spawnSync
cp.spawnSync = (cmd, args, opts) => {
  if (cmd === '/usr/bin/time') return { status: 1 }
  return cmd === 'fixture-jsc' ? spawn(process.execPath, ['--import', ${JSON.stringify(bare)}, ...args], opts) : spawn(cmd, args, opts)
}
syncBuiltinESMExports()
`)
    execFileSync(process.execPath, ['--import', hook, fileURLToPath(new URL('../bench/bench.mjs', import.meta.url)),
      '--cases=webaudio', '--targets=v8,jsc', `--json=${json}`], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, JSC_BIN: 'fixture-jsc', JZ_BENCH_BUILD_DIR: join(scratch, 'build'), JZ_BENCH_WEB_DIR: join(scratch, 'web') },
    })
    const { v8, jsc } = JSON.parse(readFileSync(json, 'utf8')).cases.webaudio.targets
    is([v8.parity, jsc.parity], ['ok', 'ok'], `the shell renders what V8 renders: ${JSON.stringify(jsc)}`)
    const flat = readFileSync(join(scratch, 'build/webaudio/webaudio-flat.js'), 'utf8')
    is(flat.match(/\bprintResult = /g)?.length, 1, 'the bundle carries the benchlib helpers once')
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('reference evidence: CI paths retain corpus, memory and native release gates', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'jz reference gates '))
  try {
    const root = fileURLToPath(new URL('../', import.meta.url))
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const watr = JSON.parse(readFileSync(join(root, 'node_modules/watr/package.json'), 'utf8')).version
    // every case of the corpus, as the claims gate lists it (bench-claims.js), not
    // the committed snapshot's, which a case added since its last run lacks
    const names = readdirSync(join(root, 'bench'), { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('_') && existsSync(join(root, 'bench', d.name, `${d.name}.js`))).map(d => d.name)
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
