#!/usr/bin/env node
// Bounded landing battery. `fast` means only the semantic matrix: no hidden
// bootstrap, generated population sweep, or timing run. Full retains those
// checks, with the memory-heavy bootstrap run alone after the native work.
// `landing` is the landing check (npm run test:landing): its legs one at a time, each
// timed and held to a budget, the whole to an hour (scripts/test-tasks.mjs landingTasks).
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { availableParallelism, cpus, loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runTasks, matrixTasks, extendedTasks, landingTasks, timed, cpuSeconds, landingVerdict, landingRecord, formatCosts, legEnv, positiveInteger, suiteJobs, LANDING_PER_PROCESS } from './test-tasks.mjs'

const LEG_TIMEOUT = 14_400_000
const args = process.argv.slice(2)
let mode = 'full', list = false, recordArg = false, base = 'main'
for (const arg of args) {
  if (arg === 'fast' || arg === 'landing') mode = arg
  else if (arg === '--list') list = true
  else if (arg === '--record') recordArg = true
  // the ref the landing check's hosted and bench legs read the change against
  else if (arg.startsWith('--base=') && arg.length > 7) base = arg.slice(7)
  // the processes each suite leg spreads its files over; the legs run in turn
  else if (arg.startsWith('--jobs=')) process.env.JZ_TEST_JOBS = String(positiveInteger(arg.slice(7), 'jobs'))
  else throw new Error(`Unknown battery argument '${arg}'; use [fast|landing] [--jobs=N] [--list] [--record] [--base=<ref>]`)
}
if ((recordArg || base !== 'main') && mode !== 'landing') throw new Error('--record and --base belong to the landing check: use them with landing')

if (mode === 'landing') await landing()
else await battery()

async function battery() {
  // Level 3 armed in place of plain (scripts/test-tasks.mjs matrixTasks): CI runs the plain.
  const tasks = matrixTasks('core', { armed: true })
  if (mode !== 'fast') tasks.push(...extendedTasks({ armed: true }),
    { name: 'fuzz-extended', args: ['test/fuzz.js'], env: legEnv({ JZ_DEBUG_INVARIANTS: '1' }) },
    { name: 'fixpoint', args: ['scripts/audit-fixpoint.mjs'], env: legEnv() },
  )
  const bootstrap = { name: 'bootstrap', args: ['test/bootstrap.mjs', '--full'], env: legEnv(), timeout: 14_400_000 }
  if (list) return tasks.concat(mode !== 'fast' ? [bootstrap] : []).forEach(t => console.log(`${t.name}: node ${t.args.join(' ')}`))
  const start = performance.now()
  const results = await runTasks(tasks)
  // A failing native run is not a reason to start hours of self-hosted work.
  if (mode !== 'fast' && results.every(r => r.code === 0)) results.push(...await runTasks([bootstrap]))
  const failures = results.filter(r => r.code !== 0)
  console.log(`BATTERY ${failures.length ? 'RED: ' + failures.map(r => r.name).join(', ') : 'GREEN'} (${((performance.now() - start) / 60000).toFixed(1)} min)`)
  process.exitCode = failures.length ? 1 : 0
}

// A leg's budget comes from its CPU seconds in the last run `--record` wrote at the same
// JZ_TEST_JOBS (scripts/test-tasks.mjs landingVerdict): CPU seconds, not wall, so another
// program's load on the machine moves no leg past it. Each leg spends JZ_TEST_JOBS
// processes, the cores less two unless it is set; the populations and the core's dear sweeps
// run at one program in 4 (JZ_TEST_SAMPLE, unless it is set), whole on CI on every push.
async function landing() {
  process.env.JZ_TEST_JOBS ||= String(suiteJobs(undefined, Infinity, availableParallelism(), 1))
  process.env.JZ_TEST_SAMPLE ??= '4'
  const jobs = process.env.JZ_TEST_JOBS, sample = process.env.JZ_TEST_SAMPLE
  const tasks = landingTasks({ base })
  if (list) return tasks.forEach(t => console.log(`${t.name}: ${t.command || 'node'} ${t.args.join(' ')}`))
  if (!existsSync('/usr/bin/time')) throw new Error('the landing check times its legs with /usr/bin/time, which this machine lacks')
  const COSTS = new URL('../test/native-costs.json', import.meta.url)
  const record = JSON.parse(readFileSync(COSTS, 'utf8')).landing ?? {}
  const git = (...a) => spawnSync('git', a, { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }).stdout?.trim() ?? ''
  const tree = `${git('rev-parse', '--short', 'HEAD')}${git('status', '--porcelain', '--untracked-files=no') ? ' with changes not committed' : ''}`
  const logDir = mkdtempSync(join(tmpdir(), 'jz-landing-')), load = loadavg()[0], legs = []
  console.log(`landing check of ${tree} against ${base}, JZ_TEST_JOBS=${jobs}, JZ_TEST_SAMPLE=${sample}, load average ${Math.round(load)}`)
  let stopped = false, refused = null
  const stop = () => { stopped = true }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  for (const task of tasks) {
    if (stopped || refused) { legs.push({ name: task.name, code: 1, wall: 0, cpu: null, skipped: true }); continue }
    // (a leg has the four hours a bootstrap task has; each process within it keeps JZ_TEST_TIMEOUT)
    let [r] = await runTasks([timed(task)], { logDir, timeout: LEG_TIMEOUT }), again = false
    // a wall-time gate's failure under load, run again alone before it is believed
    if (task.rerun && r.code && !stopped) { console.log(`${task.name}: failed, run again`); [r] = await runTasks([timed({ ...task, name: `${task.name}-again` })], { logDir, timeout: LEG_TIMEOUT }); again = true }
    const cpu = r.log ? cpuSeconds(readFileSync(r.log, 'utf8')) : null
    legs.push({ name: task.name, code: r.code, wall: (r.ms ?? 0) / 1000, cpu, whole: !r.timedOut && !stopped && cpu != null, again })
    console.log(`${task.name}: ${((r.ms ?? 0) / 1000).toFixed(1)} s wall, ${cpu?.toFixed(1) ?? 'no'} CPU s${again ? ', its second run' : ''}`)
    if (task.refuses && r.code) refused = task.name
  }
  process.off('SIGINT', stop); process.off('SIGTERM', stop)
  if (refused) {
    console.log(`LANDING REFUSED: ${refused} failed or moved the tree, and the check would test a tree the commit does not hold (log ${join(logDir, `${refused}.log`)})`)
    process.exitCode = 1
    return
  }
  const { rows, wall, reasons, targets } = landingVerdict(legs, record, { jobs, sample })
  const cell = (v, w) => String(v).padStart(w)
  console.log(`\n${'leg'.padEnd(18)}${cell('wall s', 9)}${cell('was', 7)}${cell('CPU s', 9)}${cell('budget', 9)}  state`)
  for (const r of rows) console.log(`${r.name.padEnd(18)}${cell(r.wall.toFixed(0), 9)}${cell(r.recordedWall?.toFixed(0) ?? '-', 7)}${cell(r.cpu?.toFixed(0) ?? '-', 9)}${cell(r.budget?.toFixed(0) ?? '-', 9)}  ${r.state}${r.again ? ' (its second run: the first failed)' : ''}`)
  console.log(`${'total'.padEnd(18)}${cell(wall.toFixed(0), 9)}${cell('', 7)}${cell(legs.reduce((s, l) => s + (l.cpu ?? 0), 0).toFixed(0), 9)}${cell('', 9)}  ${(wall / 60).toFixed(1)} of 60 min`)
  const at = `JZ_TEST_JOBS=${jobs}, JZ_TEST_SAMPLE=${sample}, load average ${Math.round(load)} at the start and ${Math.round(loadavg()[0])} at the end`
  const scaled = [...new Set(rows.filter(r => r.from != null && String(r.from) !== jobs).map(r => r.from))]
  if (scaled.length) console.log(`budgets: ${rows.filter(r => r.from != null && String(r.from) !== jobs).map(r => r.name).join(', ')} from the record${scaled.length > 1 ? 's' : ''} at ${scaled.join(', ')} processes, scaled by ${LANDING_PER_PROCESS * 100}% a process to ${jobs}`)
  // what the legs that report more than a verdict say: the listings, the hosted files, the bench bytes, the examples
  for (const t of tasks) if (t.report) {
    const log = join(logDir, `${t.name}${legs.find(l => l.name === t.name)?.again ? '-again' : ''}.log`)
    const line = existsSync(log) ? readFileSync(log, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter(l => t.report.test(l)).at(-1) : null
    if (line) console.log(`${t.name}: ${line.trim()}`)
  }
  if (recordArg) {
    const table = JSON.parse(readFileSync(COSTS, 'utf8'))
    const { landing, refused: declined } = landingRecord(table.landing, legs, { jobs, sample, measured: `${new Date().toISOString().slice(0, 10)} at ${tree} on ${cpus()[0]?.model}, ${at}` })
    if (declined.length) console.log(`--record: refused, ${declined.join(', ')} did not pass; test/native-costs.json is unchanged`)
    else {
      writeFileSync(COSTS, formatCosts({ ...table, landing }))
      console.log(`--record: the budgets at ${jobs} processes written to test/native-costs.json`)
    }
  }
  for (const t of targets) console.log(`TARGET: ${t}`)
  console.log(`LANDING ${reasons.length ? 'RED: ' + reasons.join('; ') : 'GREEN'} (${at}; logs ${logDir})`)
  process.exitCode = reasons.length ? 1 : 0
}
