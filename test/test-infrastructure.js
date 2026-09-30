import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { suiteArgs, suiteOf, SUITES } from './_suites.js'
import { testJobs } from './_jobs.js'
import { sharedKernel, kernelHash } from './_shared-kernel.js'
import { collector } from './_gc.js'
import { runTasks, matrixTasks, invariantTask, extendedTasks, legEnv } from '../scripts/test-tasks.mjs'

const root = join(import.meta.dirname, '..')
const clean = env => Object.fromEntries(Object.entries({ ...process.env, ...legEnv(env) }).filter(([, v]) => v != null))
const list = (suite, env) => {
  const r = spawnSync(process.execPath, ['test/index.js', '--list', `--suite=${suite}`], { cwd: root, env: clean(env), encoding: 'utf8', timeout: 30000 })
  if (r.error || r.status !== 0) throw Error(r.error?.message || r.stderr)
  return r.stdout.trim().split('\n').filter(Boolean)
}

test('test suites: every file has exactly one owner, and listing compiles nothing', () => {
  const all = list('all'), owned = SUITES.flatMap(s => list(s))
  is(owned.length, all.length)
  is(new Set(owned).size, all.length)
  is(owned.toSorted(), all.toSorted())
  for (const name of list('core')) is(suiteOf(name), 'core')
  for (const name of ['self-compile', 'self-checkpoint', 'kernel-oracle', 'kernel-parity']) is(suiteOf(name), 'bootstrap')
  for (const name of ['fuzz', 'wat-invariants', 'perf-ratchet']) is(suiteOf(name), 'generated')
  const hosted = list('all', { JZ_TEST_TARGET: 'jz.wasm', JZ_KERNEL: '/no-kernel-listing-must-not-read' })
  ok(hosted.includes('fuzz') && hosted.includes('wat-invariants'), 'hosted suite retains the generated checks')
  ok(!hosted.some(n => suiteOf(n) === 'bootstrap'), 'no recursive bootstrap test registration')
})

test('test suites: explicit files and full sweeps remain available; invalid options fail', () => {
  is(suiteArgs(['test/dyn-keys.js', '--list']), { suite: 'core', list: true, files: ['dyn-keys'] })
  is(suiteArgs([], true).suite, 'all')
  for (const args of [['--suite=nope'], ['--suite=core', '--suite=all'], ['--unknown'], ['math', 'math.js']]) throws(() => suiteArgs(args))
  const source = `import { ownedLevels } from './test/_matrix.js'; console.log(JSON.stringify(ownedLevels(0, 2, 'speed', 'size')))`
  const values = env => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: root, env: clean(env), encoding: 'utf8', timeout: 30000 })
    if (r.status !== 0) throw Error(r.stderr)
    return JSON.parse(r.stdout)
  }
  is(values({}), [2, 'size'])
  is(values({ JZ_TEST_OPTIMIZE: '0' }), [0])
  is(values({ JZ_TEST_OPTIMIZE: '3' }), ['speed'])
  for (const env of [{ JZ_TEST_HOST: 'wasi' }, { JZ_TEST_TARGET: 'jz.wasm' }, { JZ_TEST_SWEEP: '1' }])
    is(values(env), [0, 2, 'speed', 'size'], 'explicit sweeps retain all host/profile combinations')
  is(matrixTasks().length, 4)
  is(matrixTasks()[2].env.JZ_DEBUG_INVARIANTS, undefined, 'release O3 remains a distinct check')
  is(invariantTask().env.JZ_DEBUG_INVARIANTS, '1', 'battery also retains the armed O3 check')
  is(extendedTasks().filter(t => t.name.startsWith('generated')).length, 2)
})

test('test workers: automatic count is bounded by memory and CPUs, explicit values validate', () => {
  const gib = 1024 ** 3
  is(testJobs(undefined, 100, 64, 64 * gib), 2)
  is(testJobs(undefined, 100, 64, 2 * gib), 1)
  is(testJobs(undefined, 100, 1, 64 * gib), 1)
  is(testJobs('4', 100, 64, 2 * gib), 4)
  is(testJobs('4', 2), 2)
  is(testJobs(undefined, 0), 1)
  for (const v of ['', '0', '-1', '1.5', 'NaN', 'Infinity']) throws(() => testJobs(v, 100))
})

test('test reporter: BigInt failures preserve later failures and the final result', () => {
  const fixture = `import test from ${JSON.stringify(import.meta.resolve('tst'))};
    import { is } from ${JSON.stringify(import.meta.resolve('tst/assert.js'))};
    test('scalar BigInt', () => is(7n, 8n));
    test('nested BigInt array', () => is([1, [2n]], [1, [3n]]));
    test('after failures', () => is(1, 1));`
  const source = `import { runFiles } from './test/_run.js';
    const r = await runFiles([${JSON.stringify('data:text/javascript,' + encodeURIComponent(fixture))}]);
    console.log('failures=' + r.failed.length); process.exitCode = r.failed.length ? 1 : 0;`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root, env: clean({ TST_FORMAT: 'tap', TST_GREP: undefined, TST_BAIL: undefined }), encoding: 'utf8', timeout: 30000,
  })
  is(r.status, 1)
  ok(r.stdout.includes('"7n"') && r.stdout.includes('"3n"'), 'both assertion values print')
  ok(r.stdout.includes('ok 3 - after failures'), 'reporting continues after each failure')
  ok(r.stdout.includes('failures=2'), 'the runner returns all failures')
  is(r.stderr, '')
})

test('test collection: batched checkpoints and forced final cleanup', () => {
  let calls = 0
  const collect = collector(() => calls++)
  for (let i = 0; i < 31; i++) collect()
  is(calls, 0)
  collect(); is(calls, 1)
  collect(true); is(calls, 2)
})

test('shared test kernel: one fresh fallback, validated explicit bytes, sticky failures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jz-shared-test-'))
  const bytes = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), path = join(dir, 'kernel.wasm')
  let builds = 0
  const fresh = () => { builds++; return bytes }
  try {
    const own = sharedKernel(fresh, {})
    is(own(), bytes); is(own(), bytes); is(builds, 1)
    writeFileSync(path, bytes)
    const env = { JZ_SELF_TEST_KERNEL: path, JZ_SELF_TEST_KERNEL_SHA256: kernelHash(bytes) }
    const shared = sharedKernel(fresh, env)
    is(Object.keys(new WebAssembly.Instance(new WebAssembly.Module(shared())).exports), [], 'minimal valid module has no exports')
    ok(shared() === shared(), 'A → A reads the artifact once')
    // A second valid artifact exports value() = 22; a loader owns its first
    // artifact, not later writes to the same path or another loader's result.
    const other = Buffer.from([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,9,1,5,118,97,108,117,101,0,0,10,6,1,4,0,65,22,11])
    writeFileSync(path, other)
    const second = sharedKernel(fresh, { ...env, JZ_SELF_TEST_KERNEL_SHA256: kernelHash(other) })
    is(new WebAssembly.Instance(new WebAssembly.Module(second())).exports.value(), 22)
    is(shared(), bytes, 'A → B → A: existing loader keeps A, new loader executes B')
    for (const invalid of [Buffer.alloc(0), bytes.subarray(0, -1), other.subarray(0, -1)]) {
      writeFileSync(path, invalid)
      throws(sharedKernel(fresh, { ...env, JZ_SELF_TEST_KERNEL_SHA256: kernelHash(invalid) }), WebAssembly.CompileError)
    }
    writeFileSync(path, bytes)
    is(builds, 1, 'sharing does not rebuild')
    for (const partial of [{ JZ_SELF_TEST_KERNEL: path }, { JZ_SELF_TEST_KERNEL_SHA256: kernelHash(bytes) }])
      throws(sharedKernel(fresh, partial), /both/)
    const bad = sharedKernel(fresh, { ...env, JZ_SELF_TEST_KERNEL_SHA256: 'wrong' })
    throws(bad, /SHA256/); throws(bad, /SHA256/)
    rmSync(path)
    const missing = sharedKernel(fresh, env)
    throws(missing)
    writeFileSync(path, bytes)
    throws(missing, /ENOENT/, 'a repaired file cannot erase this invocation\'s failed build/read')
    writeFileSync(path, 'not wasm')
    throws(sharedKernel(fresh, { ...env, JZ_SELF_TEST_KERNEL_SHA256: kernelHash(Buffer.from('not wasm')) }))
    is(builds, 1, 'invalid shared bytes never fall back to an old dist or another build')
    const failure = new Error('fresh build failed')
    let attempts = 0
    const failed = sharedKernel(() => { attempts++; throw failure }, {})
    for (let i = 0; i < 2; i++) {
      let caught
      try { failed() } catch (e) { caught = e }
      ok(caught === failure, 'a fresh-build failure remains the same error')
    }
    is(attempts, 1, 'failed fresh builds are not retried')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('bootstrap: one private artifact, isolated child environments, cleanup on success and failure', () => {
  // Stub the expensive build and task execution, not bootstrap's orchestration
  // or legEnv. This is transaction evidence, not self-compiler codegen evidence.
  const dir = mkdtempSync(join(tmpdir(), 'jz-bootstrap-test-')), preload = join(dir, 'preload.mjs')
  const tasksUrl = new URL('../scripts/test-tasks.mjs', import.meta.url).href
  try {
    writeFileSync(preload, `
      import { registerHooks } from 'node:module'
      registerHooks({ load(url, context, next) {
        if (url === ${JSON.stringify(new URL('../scripts/private-build.mjs', import.meta.url).href)}) return {
          format: 'module', shortCircuit: true,
          source: "import fs from 'node:fs'; export function privateBuild() { fs.appendFileSync(process.env.RECORD + '.builds', 'build'); return {bytes: Buffer.from([0,97,115,109,1,0,0,0]), ms: 0} }"
        }
        if (url === ${JSON.stringify(tasksUrl)}) return {
          format: 'module', shortCircuit: true,
          source: ${JSON.stringify(`
            export { legEnv } from '${tasksUrl}?actual'
            import fs from 'node:fs'
            export async function runTasks(tasks, options) {
              const path = tasks[0].env.JZ_SELF_TEST_KERNEL
              new WebAssembly.Module(fs.readFileSync(path))
              fs.writeFileSync(process.env.RECORD, JSON.stringify({tasks, options, path}))
              if (process.env.OUTCOME === 'throw') throw new Error('task fixture failed')
              return tasks.map(() => ({code: process.env.OUTCOME === 'fail' ? 7 : 0}))
            }
          `)}
        }
        return next(url, context)
      } })
    `)
    for (const [name, args, outcome] of [
      ['normal', [], 'pass'], ['recursive', ['--recursive'], 'pass'], ['full', ['--full'], 'pass'],
      ['fail', ['--full'], 'fail'], ['throw', ['--full'], 'throw'], ['invalid', ['--unknown'], 'fail'],
    ]) {
      const record = join(dir, name + '.json')
      const r = spawnSync(process.execPath, ['--import', preload, 'test/bootstrap.mjs', ...args], {
        cwd: root, encoding: 'utf8', timeout: 30000, env: clean({ RECORD: record, OUTCOME: outcome,
          JZ_KERNEL: 'stale-kernel', JZ_SELF_TEST_KERNEL: 'stale-shared', JZ_SELF_TEST_KERNEL_SHA256: 'stale-hash' }),
      })
      is(r.status, outcome === 'pass' ? 0 : 1, r.stderr)
      if (name === 'invalid') { is(existsSync(record + '.builds'), false, 'invalid arguments do not build'); continue }
      is(readFileSync(record + '.builds', 'utf8'), 'build', 'exactly one fresh normal build')
      const { tasks, options, path } = JSON.parse(readFileSync(record, 'utf8'))
      is(options.jobs, 1)
      is(tasks.map(t => t.name), ['self-roundtrip', 'kernel-parity', 'checkpoint',
        ...(args.includes('--full') ? ['hosted-suite'] : []), ...(args.length ? ['recursive'] : [])])
      for (const { env } of tasks.slice(0, 3)) {
        is(env.JZ_SELF_TEST_KERNEL, path)
        is(env.JZ_SELF_TEST_KERNEL_SHA256, kernelHash(Buffer.from([0,97,115,109,1,0,0,0])))
        is(env.JZ_KERNEL, undefined, 'stale external kernel cannot override the fresh artifact')
      }
      for (const { name, env } of tasks.slice(3)) {
        is(env.JZ_SELF_TEST_KERNEL, undefined, 'hosted build-failure fixtures must not inherit the shared-build override')
        is(env.JZ_SELF_TEST_KERNEL_SHA256, undefined)
        is(env.JZ_KERNEL, name === 'hosted-suite' ? path : undefined)
      }
      is(existsSync(dirname(path)), false, 'private directory removed after success, nonzero exit or task exception')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('compile counts: filtered populations do no work; argument tables reuse their fixture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jz-count-test-'))
  try {
    for (const [file, grep, calls, assertions] of [
      ['perf-ratchet', '^nothing selected$', 0, 0], ['perf-ratchet', '^perf-ratchet: int ', 40, 1],
      ['pow', '^nothing selected$', 0, 0], ['pow', '^Math.pow runtime', 1, null],
      ['dyn-keys', 'an index key reads a string', 5, 72],
    ]) {
      const path = join(dir, 'calls.json')
      const r = spawnSync(process.execPath, ['--import', './test/_hashes.mjs', 'test/index.js', file], {
        cwd: root, encoding: 'utf8', timeout: 60000,
        env: clean({ JZ_HASHES: path, TST_GREP: grep, TST_FORMAT: 'tap' }),
      })
      is(r.status, 0, r.stderr || r.stdout)
      is(JSON.parse(readFileSync(path, 'utf8')).meta.calls, calls, `${file}, ${grep}: actual compile calls`)
      if (assertions != null) ok(r.stdout.includes(`# assertions ${assertions}\n`), 'semantic assertions still execute')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('compile recorder: the active entry records duplicate calls and effective matrix options', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jz-hash-test-'))
  try {
    const records = []
    for (const optimize of [undefined, '0']) {
      const path = join(dir, `${optimize ?? 'default'}.json`)
      const r = spawnSync(process.execPath, ['--import', './test/_hashes.mjs', '--input-type=module', '-e', `
        import { compile } from './index.js'
        for (let i = 0; i < 2; i++) compile('export const f = () => 42')
      `], { cwd: root, env: clean({ JZ_HASHES: path, JZ_TEST_OPTIMIZE: optimize }), encoding: 'utf8', timeout: 60000 })
      is(r.status, 0, r.stderr)
      const record = JSON.parse(readFileSync(path, 'utf8'))
      is(record.meta.calls, 2); is(record.meta.keys, 1)
      is(Object.values(record.measurements)[0].calls, 2)
      ok(Object.values(record.measurements)[0].ms > 0)
      records.push(record)
    }
    ok(Object.keys(records[0].entries)[0] !== Object.keys(records[1].entries)[0], 'O0 and default are not incorrectly counted as duplicate work')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('test tasks: bounded concurrency, logs, and nonzero/spawn/timeout failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jz-task-test-')), events = join(dir, 'events')
  try {
    const tasks = Array.from({ length: 4 }, (_, i) => ({ name: `job-${i}`, args: ['-e', `
      const fs = require('fs'), path = ${JSON.stringify(events)}
      fs.appendFileSync(path, '+${i}\\n')
      console.log('job ${i}')
      setTimeout(() => fs.appendFileSync(path, '-${i}\\n'), 100)
    `] }))
    const results = await runTasks(tasks, { jobs: 2, logDir: dir, timeout: 10000 })
    is(results.map(r => r.code), [0, 0, 0, 0])
    let active = 0, peak = 0
    for (const line of readFileSync(events, 'utf8').trim().split('\n')) {
      active += line[0] === '+' ? 1 : -1
      peak = Math.max(peak, active)
      ok(active >= 0 && active <= 2)
    }
    is(active, 0); is(peak, 2)
    ok(readFileSync(results[0].log, 'utf8').includes('job 0'))
    const failed = await runTasks([
      { name: 'exit', args: ['-e', 'process.exit(7)'] },
      { name: 'spawn', command: join(dir, 'absent'), args: [] },
      { name: 'timeout', args: ['-e', 'setInterval(() => {}, 1000)'], timeout: 100 },
    ], { jobs: 1, logDir: dir })
    is(failed[0].code, 7); ok(failed[1].error); is(failed[2].timedOut, true)
    ok(failed.every(r => r.code !== 0))
    if (process.platform !== 'win32') {
      const marker = join(dir, 'orphan')
      const child = `process.on('SIGTERM', () => {}); setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'orphan'), 3500)`
      const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], {stdio:'ignore'}); setInterval(()=>{},1000)`
      const [r] = await runTasks([{ name: 'descendant', args: ['-e', parent], timeout: 300 }], { logDir: dir })
      is(r.timedOut, true)
      await new Promise(r => setTimeout(r, 1600))
      is(existsSync(marker), false, 'timeout terminates even a nested worker that ignores SIGTERM')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, { timeout: 30000 })
