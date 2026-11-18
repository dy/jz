import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { suiteArgs, suiteOf, splits, SUITES, QUICK } from './_suites.js'
import { shards, plan, slices, measured, estimated } from './_jobs.js'
import { sharedKernel, kernelHash } from './_shared-kernel.js'
import { collector } from './_gc.js'
import { runTasks, suiteJobs, matrixTasks, invariantTask, extendedTasks, legEnv, legOf } from '../scripts/test-tasks.mjs'

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

test('quick tier: a few of core\'s files, run by --suite=quick, within its budget', () => {
  const core = list('core'), quick = list('quick')
  is(quick, core.filter(f => QUICK.has(f)), 'core\'s files, in the suite\'s order')
  is(quick.length, QUICK.size, 'each name a core file the default leg runs')
  const { files } = JSON.parse(readFileSync(join(root, 'test/native-costs.json'), 'utf8')).runs['core-default']
  const cost = quick.reduce((sum, f) => sum + (files[f]?.[0] ?? Infinity), 0)
  ok(cost <= 600, `${Math.round(cost)} CPU seconds on the default leg's row, of 600: under two minutes at 8 jobs`)
})

test('test suites: explicit files and full sweeps remain available; invalid options fail', () => {
  is(suiteArgs(['test/dyn-keys.js', '--list']), { suite: 'core', list: true, files: ['dyn-keys'], jobs: undefined, costs: false })
  is(suiteArgs(['--jobs=4']).jobs, 4)
  is(suiteArgs(['--costs']).costs, true)
  is(suiteArgs([], true).suite, 'all')
  is(suiteArgs(['--suite=quick']).suite, 'quick')
  for (const args of [['--suite=nope'], ['--suite=core', '--suite=all'], ['--unknown'], ['math', 'math.js'], ['--jobs=0'], ['--jobs='], ['--jobs=2', '--jobs=3']]) throws(() => suiteArgs(args))
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
  is(matrixTasks()[2].env.JZ_DEBUG_INVARIANTS, undefined, 'test:matrix runs level 3 plain, as CI does')
  is(matrixTasks('core', { armed: true })[2], invariantTask(), 'armed, the matrix runs the invariant leg in its place')
  is(extendedTasks().filter(t => t.name.startsWith('generated')).length, 2)
  // The landing battery runs level 3 armed and never plain: the two compile the same bytes.
  const battery = args => {
    const r = spawnSync(process.execPath, ['scripts/battery.mjs', ...args, '--list'], { cwd: root, env: clean(), encoding: 'utf8', timeout: 30000 })
    if (r.status !== 0) throw Error(r.stderr)
    return r.stdout.trim().split('\n').map(line => line.split(':')[0])
  }
  for (const args of [['fast'], []]) {
    const names = battery(args)
    ok(names.includes('core-invariants') && !names.includes('core-opt3'), `battery ${args.join(' ')}: ${names.join(', ')}`)
  }
  ok(battery([]).includes('integration-invariants') && !battery([]).includes('integration-opt3'), 'the full battery runs integration at level 3 armed only')
  // the legs' names, the keys of test/native-costs.json
  is([...matrixTasks(), invariantTask()].map(t => legOf(t.env)), ['default', 'opt0', 'opt3', 'wasi', 'opt3-invariants'])
  is(legOf({ JZ_TEST_OPTIMIZE: '0', JZ_TEST_HOST: 'wasi', JZ_TEST_SWEEP: '1' }), 'opt0-wasi-sweep')
  is([legOf({ JZ_TEST_SAMPLE: '4' }), legOf({ JZ_TEST_HOST: 'wasi', JZ_TEST_SAMPLE: '4' }), legOf({ JZ_TEST_SAMPLE: '1' })], ['sample4', 'wasi-sample4', 'default'])
  // --costs times whole native files: a grep or the kernel is refused before anything loads
  for (const env of [{ TST_GREP: 'x' }, { JZ_TEST_TARGET: 'jz.wasm', JZ_KERNEL: '/no-kernel-listing-must-not-read' }]) {
    const r = spawnSync(process.execPath, ['test/index.js', '--list', '--costs'], { cwd: root, env: clean(env), encoding: 'utf8', timeout: 30000 })
    ok(r.status !== 0 && r.stderr.includes('--costs'), JSON.stringify(env))
  }
})

test('populations: JZ_TEST_SAMPLE keeps one program in n, the same ones every run, and the name says so', () => {
  const ten = JSON.stringify([...Array(10).keys()])
  const pick = (env) => {
    const source = `import { sample, sampled } from './test/_population.js'
console.log(JSON.stringify([sample(${ten}, 'a'), sample(${ten}, 'a'), sample(${ten}, 'b'), sample([7], 'a'), sample([], 'a'), sampled('t')]))`
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: root, env: clean(env), encoding: 'utf8', timeout: 60000 })
    return r.status === 0 ? JSON.parse(r.stdout) : r.stderr
  }
  const all = JSON.parse(ten)
  is(pick({ JZ_TEST_SAMPLE: undefined }), [all, all, all, [7], [], 't'])
  const [a, again, b, one, none, name] = pick({ JZ_TEST_SAMPLE: '4' })
  is(a.length, 3, 'the ceiling of one in four')
  is(again, a, 'the same places on every call')
  ok(a.every((x, i) => all.includes(x) && (i === 0 || x > a[i - 1])), `kept in their order: ${a}`)
  ok(a.join() !== b.join(), `another list's label keeps other places: ${a} and ${b}`)
  is([one, none, name], [[7], [], 't (one program in 4, seed 1)'])
  for (const bad of ['0', '2.5', 'x']) ok(String(pick({ JZ_TEST_SAMPLE: bad })).includes(`JZ_TEST_SAMPLE must be a whole number of 1 or more, not '${bad}'`), bad)
})

test('suite processes: the idle cores, contiguous runs of near-equal weight, only where files share nothing', () => {
  const gib = 1024 ** 3
  is(suiteJobs(undefined, 100, 14, 3.4, 36 * gib), 10, 'a core stays free, busy cores stay with their work')
  is(suiteJobs(undefined, 100, 14, 20, 36 * gib), 1, 'a busy machine gets one process')
  const measured = suiteJobs(undefined, 1000)
  ok(Number.isInteger(measured) && measured >= 1 && measured <= 1000, 'the busy cores are measured when not given')
  is(suiteJobs(undefined, 100, 64, 0, 8 * gib), 4, 'a process to every 2 GiB')
  is(suiteJobs(undefined, 3, 64, 0, 64 * gib), 3, 'never more processes than files')
  is(suiteJobs('6', 100, 2, 9, gib), 6, 'an explicit count is honored')
  for (const v of ['', '0', '1.5']) throws(() => suiteJobs(v, 100))
  const weight = { a: 5, b: 1, c: 1, d: 1, e: 4 }, files = Object.keys(weight)
  is(shards(files, f => weight[f], 3), [['a'], ['b', 'c', 'd'], ['e']])
  is(shards(['a', 'b'], f => weight[f], 8), [['a'], ['b']], 'more runs asked than files')
  is(shards([], f => weight[f], 3), [])
  // every file in exactly one run, in order, whatever the count and the weights
  for (const w of [f => weight[f], () => 0, f => f === 'e' ? 99 : 1]) for (let n = 1; n <= 7; n++) {
    const runs = shards(files, w, n)
    is(runs.flat(), files)
    ok(runs.length <= n && runs.every(r => r.length))
  }
  is(['core', 'generated', 'quick', 'integration', 'bootstrap', 'all'].map(splits), [true, true, true, false, false, false])
  // --jobs is refused where a run cannot split; an empty JZ_TEST_JOBS is unset
  const listed = (args, env) => spawnSync(process.execPath, ['test/index.js', '--list', ...args], { cwd: root, env: clean(env), encoding: 'utf8', timeout: 30000 })
  is(listed(['--jobs=2']).status, 0)
  is(listed(['--jobs=2'], { JZ_TEST_JOBS: '' }).stdout, listed([]).stdout)
  for (const args of [['--jobs=2', 'math'], ['--jobs=2', '--suite=integration'], ['--jobs=2', '--suite=all']]) ok(listed(args).status !== 0, args.join(' '))
})

// The recorded costs of the suites a run splits (test/native-costs.json), by leg.
const splitRows = () => {
  const { runs } = JSON.parse(readFileSync(join(root, 'test/native-costs.json'), 'utf8'))
  const rows = Object.entries(runs).filter(([run]) => splits(run.split('-')[0]))
  if (!rows.some(([run]) => run === 'core-default')) throw Error('test/native-costs.json: the default core leg is not timed')
  return rows
}

test('suite processes: weighed by the leg\'s CPU seconds, an untimed file by its bytes; none far over the mean', () => {
  const bytes = { a: 100, b: 300, x: 200 }
  is(['a', 'b', 'x'].map(estimated(['a', 'b', 'x'], { a: 2, b: 6 }, f => bytes[f])), [2, 6, 4], 'an untimed file weighs its bytes at the seconds a byte of the timed: 8 s for 400 bytes')
  is(estimated(['x'], { a: 2 }, f => bytes[f])('x'), 200, 'none of the list timed: the bytes alone')
  is(estimated(['a', 'x'], { a: 0 }, f => bytes[f])('a'), 0, 'a file timed at nothing is timed')
  const weight = { a: 5, b: 1, c: 1, d: 1, e: 4 }
  is(plan(Object.keys(weight), f => weight[f], 1), [{ files: ['a'], weight: 5 }, { files: ['e'], weight: 4 }, { files: ['b', 'c', 'd'], weight: 3 }], 'three runs to a process, the dearest first')
  // On each split suite's recorded costs, at 4 and at 12 processes and at every seed, each
  // next run to the first process free as runTasks gives them: the dearest process within
  // 1.3 of the mean, or no dearer than the dearest file where that file alone is more (no
  // plan splits a file).
  for (const [run, { files }] of splitRows()) {
    const names = Object.keys(files), cost = f => files[f][0], total = names.reduce((sum, f) => sum + cost(f), 0)
    const file = Math.max(...names.map(cost))
    for (const jobs of [4, 12]) {
      let dearest = 0, worst = 0
      for (let seed = 0; seed < names.length; seed++) {
        const loads = Array(jobs).fill(0)
        for (const r of plan(names, cost, jobs, seed)) loads[loads.indexOf(Math.min(...loads))] += r.weight
        if (Math.max(...loads) > dearest) [dearest, worst] = [Math.max(...loads), seed]
      }
      ok(dearest <= Math.max(1.3 * total / jobs, file), `${run}, ${jobs} processes: the dearest is ${(dearest * jobs / total).toFixed(2)} of the mean at seed ${worst}${dearest === file ? ', one file' : ''}`)
    }
  }
})

test('suite processes: a seed moves every boundary, so each file starts a process and each pair of neighbours meets in one', () => {
  const weight = { a: 5, b: 1, c: 1, d: 1, e: 4 }, files = Object.keys(weight), w = f => weight[f]
  is(plan(files, w, 1, 0), plan(files, w, 1), 'seed 0 cuts the list as it stands')
  is(plan(files, w, 1, 5), plan(files, w, 1), 'the seed counts files round the ring')
  is(plan(['a', 'b', 'c', 'd', 'e', 'f'], () => 1, 1, 1).map(r => r.files), [['b', 'c'], ['d', 'e'], ['f', 'a']], 'seed 1 starts the ring at the second file')
  is(shards(['a', 'b', 'e'], w, 3), [['a'], ['b'], ['e']], 'a file of a run\'s weight or more runs alone')
  // On each split suite's recorded costs at 3 processes (CI's runner) and 4: every plan is
  // arcs of the ring holding each file once; over the seeds each file starts a run, and two
  // neighbours share one unless one of them weighs a run or more and runs alone.
  for (const [run, { files }] of splitRows()) {
    const names = Object.keys(files), cost = f => files[f][0], total = names.reduce((sum, f) => sum + cost(f), 0)
    const at = new Map(names.map((f, i) => [f, i]))
    for (const jobs of [3, 4]) {
      const starts = new Set(), met = new Set(), broken = []
      for (let seed = 0; seed < names.length; seed++) {
        const runs = plan(names, cost, jobs, seed)
        if (runs.flatMap(r => r.files).toSorted().join() !== names.toSorted().join()) broken.push(seed)
        for (const { files: r } of runs) {
          starts.add(r[0])
          for (let i = 1; i < r.length; i++) {
            if ((at.get(r[i - 1]) + 1) % names.length !== at.get(r[i])) broken.push(seed)
            met.add(r[i])
          }
        }
      }
      const alone = f => cost(f) * jobs * 3 >= total
      const apart = names.slice(1).filter((f, i) => !met.has(f) && !alone(f) && !alone(names[i]))
      is(broken, [], `${run}, ${jobs} processes: every plan is arcs of the ring, each file once`)
      is(names.filter(f => !starts.has(f)), [], `${run}, ${jobs} processes: every file starts a run at some seed`)
      is(apart, [], `${run}, ${jobs} processes: every file meets the one before it at some seed`)
    }
  }
})

test('suite processes: a split run cuts its runs where the seed and the leg\'s costs say', () => {
  // A split generated or quick run whose grep matches no test: each run imports its files
  // and runs none of their tests (about 3 CPU seconds a run of the suite).
  const split = (seed, suite = 'generated') => spawnSync(process.execPath, ['test/index.js', `--suite=${suite}`, '--jobs=2'], {
    cwd: root, env: clean({ TST_GREP: '^no test has this name$', JZ_TEST_SEED: seed }), encoding: 'utf8', timeout: 120000,
  })
  const ran = r => [...r.stdout.matchAll(/^PASS (\S+) /gm)].map(m => m[1]).toSorted()
  const planned = (seed, suite = 'generated', row = 'generated-default') => {
    const selected = list(suite)
    const timed = Object.fromEntries(Object.entries(JSON.parse(readFileSync(join(root, 'test/native-costs.json'), 'utf8')).runs[row].files).map(([f, [s]]) => [f, s]))
    const weight = estimated(selected, timed, f => statSync(join(root, 'test', `${f}.js`)).size)
    return plan(selected, weight, 2, seed).map(r => `${suite}-${r.files[0]}`).toSorted()
  }
  const quick = split('7', 'quick')
  is(quick.status, 0, quick.stderr)
  is(ran(quick), planned(7, 'quick', 'core-default'), 'the quick tier\'s runs, cut by the core row its files have')
  for (const seed of [7, 30]) {
    const r = split(String(seed))
    is(r.status, 0, r.stderr)
    ok(r.stdout.includes(`# seed ${seed}: JZ_TEST_SEED=${seed} repeats these runs`), 'the header names the seed')
    is(ran(r), planned(seed), `seed ${seed}: the runs the plan cuts by the generated-default row`)
  }
  ok(planned(7).join() !== planned(30).join(), 'two seeds cut different runs')
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout
  ok(split(undefined).stdout.includes(`# seed ${parseInt(head.slice(0, 8), 16)}:`), 'unset, the seed is the commit checked out')
  const bad = split('x')
  ok(bad.status !== 0 && bad.stderr.includes('JZ_TEST_SEED'), 'a seed that is no whole number is refused')
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

// test/bootstrap.mjs with the expensive build and task execution stubbed, not its
// orchestration, its listing of the hosted suite or legEnv: each run returns its
// exit status, its builds and every runTasks call it made. This is transaction
// evidence, not self-compiler codegen evidence.
function bootstrapFixture(dir) {
  const preload = join(dir, 'preload.mjs'), tasksUrl = new URL('../scripts/test-tasks.mjs', import.meta.url).href
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
          export { legEnv, suiteJobs, positiveInteger } from '${tasksUrl}?actual'
          import fs from 'node:fs'
          export async function runTasks(tasks, options) {
            const path = tasks[0].env.JZ_SELF_TEST_KERNEL ?? tasks[0].env.JZ_KERNEL
            new WebAssembly.Module(fs.readFileSync(path))
            fs.appendFileSync(process.env.RECORD, JSON.stringify({tasks, options, path}) + '\\n')
            if (process.env.OUTCOME === 'throw') throw new Error('task fixture failed')
            return tasks.map(() => ({code: process.env.OUTCOME === 'fail' ? 7 : 0}))
          }
        `)}
      }
      return next(url, context)
    } })
  `)
  return (name, args, outcome = 'pass') => {
    const record = join(dir, name + '.jsonl')
    const r = spawnSync(process.execPath, ['--import', preload, 'test/bootstrap.mjs', ...args], {
      cwd: root, encoding: 'utf8', timeout: 30000, env: clean({ RECORD: record, OUTCOME: outcome,
        JZ_KERNEL: 'stale-kernel', JZ_SELF_TEST_KERNEL: 'stale-shared', JZ_SELF_TEST_KERNEL_SHA256: 'stale-hash' }),
    })
    const read = path => existsSync(path) ? readFileSync(path, 'utf8') : ''
    return { status: r.status, stderr: r.stderr, builds: read(record + '.builds'), calls: read(record).split('\n').filter(Boolean).map(l => JSON.parse(l)) }
  }
}

test('bootstrap: one private artifact, isolated child environments, cleanup on success and failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jz-bootstrap-test-'))
  try {
    const run = bootstrapFixture(dir)
    for (const [name, args, outcome] of [
      ['normal', [], 'pass'], ['recursive', ['--recursive'], 'pass'], ['full', ['--full'], 'pass'], ['slice', ['--hosted=2/3'], 'pass'],
      ['fail', ['--full'], 'fail'], ['throw', ['--full'], 'throw'],
      ['invalid', ['--unknown'], 'fail'], ['slice-zero', ['--hosted=0/3'], 'fail'], ['slice-past', ['--hosted=4/3'], 'fail'],
      ['slice-form', ['--hosted=1'], 'fail'], ['two-modes', ['--hosted=1/3', '--full'], 'fail'],
    ]) {
      const { status, stderr, builds, calls } = run(name, args, outcome)
      is(status, outcome === 'pass' ? 0 : 1, stderr)
      if (outcome === 'fail' && name !== 'fail') { is(builds, '', `${name}: invalid arguments do not build`); continue }
      is(builds, 'build', 'exactly one fresh normal build')
      // the parts first, one at a time; then the hosted files, unless the parts threw
      is(calls.length, { normal: 1, recursive: 1, full: 2, slice: 1, fail: 2, throw: 1 }[name], `${name}: runTasks calls`)
      const [parts, hosted] = name === 'slice' ? [null, calls[0]] : calls
      if (parts) {
        is(parts.options.jobs, 1)
        is(parts.tasks.map(t => t.name), ['self-roundtrip', 'kernel-parity', 'checkpoint', ...(args.length ? ['recursive'] : [])])
        for (const { env } of parts.tasks.slice(0, 3)) {
          is(env.JZ_SELF_TEST_KERNEL, parts.path)
          is(env.JZ_SELF_TEST_KERNEL_SHA256, kernelHash(Buffer.from([0,97,115,109,1,0,0,0])))
          is(env.JZ_KERNEL, undefined, 'stale external kernel cannot override the fresh artifact')
        }
      }
      for (const { name: task, env } of [...(parts?.tasks.slice(3) ?? []), ...(hosted?.tasks ?? [])]) {
        is(env.JZ_SELF_TEST_KERNEL, undefined, 'hosted build-failure fixtures must not inherit the shared-build override')
        is(env.JZ_SELF_TEST_KERNEL_SHA256, undefined)
        is(env.JZ_KERNEL, task.startsWith('hosted-') ? calls[0].path : undefined)
        if (task.startsWith('hosted-')) is(env.JZ_TEST_TARGET, 'jz.wasm')
      }
      if (hosted) ok(hosted.tasks.length && hosted.tasks.every(t => t.name.startsWith('hosted-')), 'a file of the hosted suite to a task')
      for (const { path } of calls) is(existsSync(dirname(path)), false, 'private directory removed after success, nonzero exit or task exception')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('hosted suite: the slices CI runs are disjoint and together run what the one-process run runs', () => {
  const one = list('all', { JZ_TEST_TARGET: 'jz.wasm' })
  // The packing: every file in exactly one slice, at every count.
  const weight = { a: 5, b: 1, c: 1, d: 1, e: 4 }, files = Object.keys(weight)
  is(slices(files, f => weight[f], 2), [{ files: ['a', 'c'], weight: 6 }, { files: ['b', 'd', 'e'], weight: 6 }])
  is(slices(['a'], f => weight[f], 3).map(s => s.files), [['a'], [], []], 'more slices asked than files')
  is(measured(['a', 'x'], { a: 5, b: 9 })('x'), 5, 'an untimed file weighs as the dearest timed file of the list')
  is(measured(['x'], {})('x'), 1)
  const cost = measured(one, JSON.parse(readFileSync(join(root, 'test/hosted-costs.json'), 'utf8')).seconds)
  for (let n = 1; n <= 12; n++) {
    const parts = slices(one, cost, n)
    is(parts.length, n)
    is(parts.flatMap(s => s.files).toSorted(), one.toSorted(), `${n} slices: every file once`)
  }
  // CI's matrix, through test/bootstrap.mjs itself: slice i of n for every i the
  // workflow names, against the hosted files of --full and of the one-process listing.
  const workflow = readFileSync(join(root, '.github/workflows/self-compile.yml'), 'utf8')
  const matrix = JSON.parse(workflow.match(/^\s+slice: (\[[\d, ]+\])$/m)?.[1] ?? '[]'), n = matrix.length
  ok(n > 1, 'the workflow names its slices')
  is(matrix, Array.from({ length: n }, (_, i) => i + 1), 'the matrix names slices 1 to n')
  ok(workflow.includes('npm run test:bootstrap -- --hosted=${{ matrix.slice }}/${{ strategy.job-total }}'), 'each job runs its slice of as many as the matrix has')
  ok(workflow.includes('npm run test:bootstrap -- --recursive'), 'a job of its own runs the round-trip, parity, checkpoint and recursive checks')
  const dir = mkdtempSync(join(tmpdir(), 'jz-hosted-slices-test-'))
  try {
    const run = bootstrapFixture(dir), owner = new Map()
    const ran = call => call.tasks.map(t => { is(t.args.slice(0, -1), ['--stack-size=1968', 'test/index.js']); return t.args.at(-1) })
    for (const i of matrix) {
      const { status, stderr, calls } = run(`slice-${i}`, [`--hosted=${i}/${n}`])
      is(status, 0, stderr)
      is(calls.length, 1, 'a slice job runs its hosted files alone')
      for (const f of ran(calls[0])) {
        ok(!owner.has(f), `${f} runs in slices ${owner.get(f)} and ${i}`)
        owner.set(f, i)
      }
    }
    is([...owner.keys()].toSorted(), one.toSorted(), 'the slices together run every file of the one-process run')
    const full = run('full', ['--full'])
    is(ran(full.calls[1]).toSorted(), one.toSorted(), '--full runs every file of the one-process run')
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
    // The count is taken once a command and handed to every task: unset, both
    // tasks read one number; set, they read it; a task's own value wins.
    const told = async (jobs, env) => {
      const prev = process.env.JZ_TEST_JOBS
      if (jobs == null) delete process.env.JZ_TEST_JOBS; else process.env.JZ_TEST_JOBS = jobs
      try {
        const print = ['-e', 'console.log("jobs=" + process.env.JZ_TEST_JOBS)']
        const rs = await runTasks([{ name: 'told-a', args: print }, { name: 'told-b', args: print, env }], { logDir: dir })
        return rs.map(r => readFileSync(r.log, 'utf8').match(/jobs=(.*)/)[1])
      } finally { if (prev == null) delete process.env.JZ_TEST_JOBS; else process.env.JZ_TEST_JOBS = prev }
    }
    const [a, b] = await told()
    ok(/^[1-9]\d*$/.test(a) && a === b, `unset: one count for both tasks (${a}, ${b})`)
    is(await told('3'), ['3', '3'])
    is(await told('3', { JZ_TEST_JOBS: '1' }), ['3', '1'])
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
