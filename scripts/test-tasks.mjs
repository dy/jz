// Bounded subprocess runner. Logs go to disk, not an ever-growing parent string.
// A timeout or cancellation kills the process group, including nested builders.
import { spawn } from 'node:child_process'
import { openSync, closeSync, readSync, fstatSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir, availableParallelism, cpus, totalmem } from 'node:os'
import { join } from 'node:path'

export function positiveInteger(value, name) {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`)
  return n
}

// Cores at work over a fifth of a second. The load average is no measure of it:
// for a minute after a run ends it still counts that run, and the next would
// start narrow.
function busyCores(ms = 200) {
  const times = () => cpus().map(c => c.times)
  const before = times()
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  return times().reduce((busy, t, i) => {
    let total = 0
    for (const k in t) total += t[k] - before[i][k]
    return total > 0 ? busy + 1 - (t.idle - before[i].idle) / total : busy
  }, 0)
}

// The processes one suite run spreads its files over: an explicit count, or the
// cores idle now. One core stays free and the cores other work holds stay with
// it, so two runs started together share the machine; a process to every 2 GiB.
export function suiteJobs(requested, count = Infinity, cores = availableParallelism(), busy, memory = totalmem()) {
  const jobs = requested != null ? positiveInteger(requested, 'jobs')
    : Math.min(cores - 1 - Math.round(busy ?? busyCores()), Math.floor(memory / (2 * 1024 ** 3)))
  return Math.max(1, Math.min(jobs, count))
}

// Tasks run one at a time unless the caller counts the jobs: a suite leg spends
// JZ_TEST_JOBS itself, on runs of its own files (test/index.js). The count is taken
// once, here, and handed to every task.
export async function runTasks(tasks, {
  jobs = 1,
  timeout = positiveInteger(process.env.JZ_TEST_TIMEOUT || 3_600_000, 'JZ_TEST_TIMEOUT'),
  logDir = mkdtempSync(join(tmpdir(), 'jz-tests-')),
  cwd = process.cwd(),
} = {}) {
  positiveInteger(jobs, 'jobs'); positiveInteger(timeout, 'timeout')
  if (new Set(tasks.map(t => t.name)).size !== tasks.length) throw new Error('Duplicate task name')
  for (const t of tasks) {
    if (!/^[\w-]+$/.test(t.name)) throw new Error(`Invalid task name '${t.name}'`)
    if (t.timeout != null) positiveInteger(t.timeout, 'task timeout')
  }
  const active = new Map(), results = new Array(tasks.length)
  let next = 0, cancelled = false
  const kill = (p, signal) => {
    if (!p.pid) return
    try { process.platform === 'win32' ? p.kill(signal) : process.kill(-p.pid, signal) }
    catch (e) { if (e.code !== 'ESRCH') throw e }
  }
  const cancel = () => {
    cancelled = true
    for (const stop of active.values()) stop()
  }
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel)
  const budget = process.env.JZ_TEST_JOBS || String(suiteJobs())
  console.log(`test logs: ${logDir} (jobs=${jobs})`)
  const run = task => new Promise(resolve => {
    const started = performance.now(), path = join(logDir, `${task.name}.log`)
    const fd = openSync(path, 'w')
    const env = { ...process.env, JZ_TEST_JOBS: budget, TST_FORMAT: 'tap', ...task.env }
    for (const k of Object.keys(env)) if (env[k] == null) delete env[k]
    let p
    try {
      p = spawn(task.command || process.execPath, task.args, {
        cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', fd, fd],
      })
    } finally { closeSync(fd) }
    let error = null, timedOut = false, stopped
    const stop = () => stopped ||= new Promise(done => {
      kill(p, 'SIGTERM')
      // Do not cancel this when the parent exits: a grandchild may ignore TERM.
      setTimeout(() => { kill(p, 'SIGKILL'); done() }, 2000)
    })
    active.set(p, stop)
    p.on('error', e => { error = e.message })
    const timer = setTimeout(() => { timedOut = true; stop() }, task.timeout || timeout)
    p.on('close', async (code, signal) => {
      clearTimeout(timer)
      if (stopped) await stopped
      active.delete(p)
      const result = { name: task.name, code: error || timedOut || signal || cancelled ? 1 : code ?? 1, signal, error, timedOut, log: path, ms: performance.now() - started }
      console.log(`${result.code ? 'FAIL' : 'PASS'} ${task.name} ${(result.ms / 1000).toFixed(1)}s${timedOut ? ' (timeout)' : ''}${error ? ': ' + error : ''}`)
      if (result.code) {
        // the failed assertions by name and their diagnostics, wherever they fell in the log (the tail only has the totals)
        const lines = readFileSync(path, 'utf8').split('\n'), failed = []
        for (let i = 0; i < lines.length && failed.length < 200; i++) if (/\u2717|^not ok \d/u.test(lines[i]))
          for (let j = i; j < Math.min(lines.length, i + 8) && (j === i || /^\s/.test(lines[j])); j++) failed.push(lines[j])
        if (failed.length) console.error(failed.join('\n'))
        const fd = openSync(path, 'r')
        try {
          const n = Math.min(4096, fstatSync(fd).size), tail = Buffer.alloc(n)
          readSync(fd, tail, 0, n, fstatSync(fd).size - n)
          console.error(`${tail}\nlog: ${path}`)
        } finally { closeSync(fd) }
      }
      resolve(result)
    })
  })
  try {
    await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, async () => {
      while (!cancelled && next < tasks.length) {
        const i = next++
        try { results[i] = await run(tasks[i]) }
        catch (e) { results[i] = { name: tasks[i].name, code: 1, error: e.message }; console.error(e) }
      }
    }))
  } finally {
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel)
  }
  return tasks.map((t, i) => results[i] || { name: t.name, code: 1, skipped: true, error: 'cancelled' })
}

// Every leg starts with a clean matrix environment; explicit task options win.
export const legEnv = (env = {}) => ({
  JZ_TEST_OPTIMIZE: undefined, JZ_TEST_HOST: undefined, JZ_TEST_TARGET: undefined,
  JZ_TEST_SWEEP: undefined, JZ_DEBUG_INVARIANTS: undefined, JZ_KERNEL: undefined,
  JZ_SELF_TEST_KERNEL: undefined, JZ_SELF_TEST_KERNEL_SHA256: undefined, ...env,
})
// The leg a process runs, named by the environment it compiles under: `default`,
// `opt0`, `wasi`, `opt3-invariants` (the armed level 3), `sample4` (one program in 4 of
// each population, test/_population.js).
export const legOf = (env = process.env) => [
  env.JZ_TEST_OPTIMIZE != null && `opt${env.JZ_TEST_OPTIMIZE}`, env.JZ_TEST_HOST,
  env.JZ_TEST_SWEEP === '1' && 'sweep', env.JZ_DEBUG_INVARIANTS === '1' && 'invariants',
  Number(env.JZ_TEST_SAMPLE) > 1 && `sample${Number(env.JZ_TEST_SAMPLE)}`,
].filter(Boolean).join('-') || 'default'
// Level 3 runs plain, the path users ship (CI's matrix, test:matrix), or `armed` with the
// invariant checks (the landing battery). The two compile the same bytes; the armed one
// also fails a pass that breaks a contract the bytes do not show, as in 16 tests the
// plain leg passed (650e3f5b9).
export const matrixTasks = (suite = 'core', { armed = false } = {}) => [
  { name: `${suite}-default`, args: ['test/index.js', `--suite=${suite}`], env: legEnv() },
  { name: `${suite}-opt0`, args: ['test/index.js', `--suite=${suite}`], env: legEnv({ JZ_TEST_OPTIMIZE: '0' }) },
  armed ? invariantTask(suite) : { name: `${suite}-opt3`, args: ['test/index.js', `--suite=${suite}`], env: legEnv({ JZ_TEST_OPTIMIZE: '3' }) },
  { name: `${suite}-wasi`, args: ['test/index.js', `--suite=${suite}`], env: legEnv({ JZ_TEST_HOST: 'wasi' }) },
]
export const invariantTask = (suite = 'core') => ({ name: `${suite}-invariants`, args: ['test/index.js', `--suite=${suite}`], env: legEnv({ JZ_TEST_OPTIMIZE: '3', JZ_DEBUG_INVARIANTS: '1' }) })
export const extendedTasks = ({ armed = false } = {}) => [
  ...matrixTasks('integration', { armed }),
  { name: 'generated-default', args: ['test/index.js', '--suite=generated'], env: legEnv() },
  { name: 'generated-wasi', args: ['test/index.js', '--suite=generated'], env: legEnv({ JZ_TEST_HOST: 'wasi' }) },
]

// The landing check (npm run test:landing, scripts/battery.mjs landing): what a change
// passes before it lands, a leg at a time, each step one a landing once went wrong without.
// The listings are rewritten first, and a tree they move is not checked (`refuses`). WASI
// runs first of the core's legs, the one a writer runs least (land-k's two tests failed
// only CI's). Level 3 runs armed in place of plain, as in the battery. The hosted suite's
// files the change touched run on a fresh kernel, and the bench corpus's bytes are read
// against the base's (scripts/bench-bytes.mjs), both against the merge base with `base`.
// The examples' timing (examples/bench.mjs, V8 against jz) is a wall-time gate: a failure
// is run again, alone, before it is believed (`rerun`). What CI runs and this does not:
// integration at level 0, at level 3 armed and on WASI, the generated suite on WASI and
// whole, the 5,000-seed fuzz (test.yml), the whole hosted suite and recursive compilation
// (self-compile.yml).
export const landingTasks = ({ base = 'main' } = {}) => {
  const [defaults, opt0, invariants, wasi] = matrixTasks('core', { armed: true })
  return [
    { name: 'listings', args: ['scripts/listings.mjs'], env: legEnv(), refuses: true, report: /^listings: (none moved|the rewrite moved)/ },
    { name: 'lint', command: 'npm', args: ['run', '-s', 'lint:imports'], env: legEnv() },
    { name: 'audit', command: 'npm', args: ['run', '-s', 'audit:files'], env: legEnv() },
    wasi, defaults, invariants, opt0,
    { name: 'generated', args: ['test/index.js', '--suite=generated'], env: legEnv() },
    { name: 'integration', args: ['test/index.js', '--suite=integration'], env: legEnv() },
    { name: 'test262', args: ['--expose-gc', 'test/test262.js'], env: legEnv() },
    { name: 'test262-builtins', args: ['--expose-gc', 'test/test262-builtins.js'], env: legEnv() },
    { name: 'self', args: ['test/self-compile.js'], env: legEnv() },
    { name: 'hosted', args: ['test/bootstrap.mjs', `--touched=${base}`], env: legEnv(), report: /^bootstrap: the hosted suite's files touched/ },
    { name: 'bench-bytes', args: ['scripts/bench-bytes.mjs', `--base=${base}`], env: legEnv(), report: /^bench bytes against/ },
    { name: 'examples', args: ['examples/bench.mjs'], env: legEnv(), rerun: true, report: /geomean/ },
  ]
}
// A task run under the POSIX `time -p`, which writes the CPU seconds of the task and every
// process it waited for to the end of its log; cpuSeconds reads them back.
export const timed = task => ({ ...task, command: '/usr/bin/time', args: ['-p', task.command || process.execPath, ...task.args] })
export function cpuSeconds(log) {
  const last = key => [...log.matchAll(new RegExp(`^${key}\\s+([\\d.]+)\\s*$`, 'gm'))].at(-1)?.[1]
  const user = last('user'), sys = last('sys')
  return user == null || sys == null ? null : Number(user) + Number(sys)
}
// A leg of the landing check passes when its tests pass and its CPU seconds stay within its
// budget: a quarter over and ten seconds (a leg of a few seconds needs them for its start)
// past what the leg spent in the last run `--record` wrote at the same number of processes
// (test/native-costs.json `landing`, a record a JZ_TEST_JOBS). A process more spends about 2%
// more CPU on the same work (V8 warms up the compiler in each): level 0 spent 1,850 and 1,851
// CPU s at 2 processes, 1,936 at 4, 2,017 and 1,990 at 6. So a run at a count with no record
// is held to the nearest count's, scaled by 2% a process, until `--record` writes its own;
// never to a record of another JZ_TEST_SAMPLE. Wall time is no verdict: other work on the
// machine moves it, and a process past its limit (JZ_TEST_TIMEOUT) fails already. The hour
// for the whole and a leg past twice its recorded wall are targets: printed, never red.
export const LANDING_SECONDS = 3600
export const LANDING_PER_PROCESS = 0.02
export const landingBudget = seconds => seconds * 1.25 + 10
export function landingVerdict(legs, record = {}, { jobs, sample } = {}) {
  if (!(Number(jobs) > 0)) throw new Error('landingVerdict: the run\'s JZ_TEST_JOBS picks its record')
  const counts = Object.keys(record).filter(k => /^\d+$/.test(k)).map(Number), J = Number(jobs)
  const same = counts.filter(k => sample == null || String(record[k].sample) === String(sample))
    .toSorted((a, b) => (a !== J) - (b !== J) || Math.abs(a - J) - Math.abs(b - J) || b - a)
  const rows = legs.map(leg => {
    // the record of this count that holds the leg, else the nearest count's that does
    const from = same.find(k => record[k].legs[leg.name]), rec = from == null ? null : record[from].legs[leg.name]
    const budget = rec ? landingBudget(rec[0] * (1 + LANDING_PER_PROCESS * (J - from))) : null
    const state = leg.skipped ? 'NOT RUN' : leg.code ? 'FAIL' : leg.cpu == null ? 'NO CPU' : budget == null ? 'NO BUDGET' : leg.cpu > budget ? 'OVER' : 'PASS'
    return { ...leg, budget, from: from ?? null, recordedWall: from === J ? rec[1] : null, state }
  })
  const wall = legs.reduce((sum, leg) => sum + leg.wall, 0)
  const none = !same.length && counts.length ? `has no budget at JZ_TEST_SAMPLE=${sample}: the records at ${counts.join(', ')} processes are of another`
    : 'has no recorded budget (--record)'
  const over = r => `is over its budget, ${Math.round(r.cpu)} of ${Math.round(r.budget)} CPU s${r.from !== J ? ` (the record at ${r.from} processes, scaled to ${J})` : ''}`
  const why = r => ({ 'NOT RUN': 'did not run', FAIL: 'failed', 'NO CPU': 'left no CPU time', 'NO BUDGET': none })[r.state] ?? over(r)
  const reasons = rows.filter(r => r.state !== 'PASS').map(r => `${r.name} ${why(r)}`)
  const targets = rows.filter(r => r.recordedWall != null && r.wall > 2 * r.recordedWall + 60)
    .map(r => `${r.name} took ${Math.round(r.wall)} s, past twice the ${Math.round(r.recordedWall)} s recorded`)
  if (wall > LANDING_SECONDS) targets.push(`${(wall / 60).toFixed(1)} of 60 min; the longest legs: ${rows.toSorted((a, b) => b.wall - a.wall).slice(0, 3).map(r => `${r.name} ${(r.wall / 60).toFixed(1)}`).join(', ')} min`)
  return { rows, wall, reasons, targets }
}
// What `--record` writes: the run's legs as the record at its JZ_TEST_JOBS, the records of
// other counts kept. A run with a leg that failed, stopped or left no CPU time is refused
// whole (`refused` names those legs): its figure would be a budget the next healthy run goes over.
export function landingRecord(landing = {}, legs, { jobs, sample, measured }) {
  const refused = legs.filter(l => l.code || l.skipped || !l.whole || l.cpu == null).map(l => l.name)
  if (refused.length) return { landing, refused }
  const round = x => Math.round(x * 10) / 10
  return { landing: { ...landing, [jobs]: { measured, sample: Number(sample), legs: Object.fromEntries(legs.map(l => [l.name, [round(l.cpu), round(l.wall)]])) } }, refused }
}

// test/native-costs.json as written: one item to a line, a file's figures on its own.
export const formatCosts = table => JSON.stringify(table, null, 1).replace(/\[\n\s+([^\]]*?)\n\s+\]/g, (_, items) => `[${items.split(/,\n\s+/).join(', ')}]`) + '\n'
