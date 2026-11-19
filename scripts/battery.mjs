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
import { runTasks, matrixTasks, extendedTasks, landingTasks, timed, cpuSeconds, landingVerdict, landingBudget, formatCosts, legEnv, positiveInteger, suiteJobs } from './test-tasks.mjs'

const args = process.argv.slice(2)
let mode = 'full', list = false, record = false
for (const arg of args) {
  if (arg === 'fast' || arg === 'landing') mode = arg
  else if (arg === '--list') list = true
  else if (arg === '--record') record = true
  // the processes each suite leg spreads its files over; the legs run in turn
  else if (arg.startsWith('--jobs=')) process.env.JZ_TEST_JOBS = String(positiveInteger(arg.slice(7), 'jobs'))
  else throw new Error(`Unknown battery argument '${arg}'; use [fast|landing] [--jobs=N] [--list] [--record]`)
}
if (record && mode !== 'landing') throw new Error('--record writes the landing check\'s budgets: use it with landing')

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

// A leg's budget comes from its CPU seconds in the last run `--record` wrote (scripts/
// test-tasks.mjs landingBudget): CPU seconds, not wall, so another program's load on the
// machine moves no leg past it. Each leg spends JZ_TEST_JOBS processes, the cores less two
// unless it is set; the populations and the core's dear sweeps run at one program in 4
// (JZ_TEST_SAMPLE, unless it is set), whole on CI on every push.
async function landing() {
  process.env.JZ_TEST_JOBS ||= String(suiteJobs(undefined, Infinity, availableParallelism(), 1))
  process.env.JZ_TEST_SAMPLE ??= '4'
  const tasks = landingTasks()
  if (list) return tasks.forEach(t => console.log(`${t.name}: ${t.command || 'node'} ${t.args.join(' ')}`))
  if (!existsSync('/usr/bin/time')) throw new Error('the landing check times its legs with /usr/bin/time, which this machine lacks')
  const COSTS = new URL('../test/native-costs.json', import.meta.url)
  const recorded = JSON.parse(readFileSync(COSTS, 'utf8')).landing?.legs ?? {}
  const logDir = mkdtempSync(join(tmpdir(), 'jz-landing-')), load = loadavg()[0], legs = []
  let stopped = false
  const stop = () => { stopped = true }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  for (const task of tasks) {
    if (stopped) { legs.push({ name: task.name, code: 1, wall: 0, cpu: null, skipped: true }); continue }
    const [r] = await runTasks([timed(task)], { logDir })
    const cpu = r.log ? cpuSeconds(readFileSync(r.log, 'utf8')) : null, budget = recorded[task.name] && landingBudget(recorded[task.name][0])
    legs.push({ name: task.name, code: r.code, wall: (r.ms ?? 0) / 1000, cpu, whole: !r.timedOut && !stopped && cpu != null })
    console.log(`${task.name}: ${((r.ms ?? 0) / 1000).toFixed(1)} s wall, ${cpu?.toFixed(1) ?? 'no'} CPU s${budget ? ` of ${Math.round(budget)}` : ''}`)
  }
  process.off('SIGINT', stop); process.off('SIGTERM', stop)
  const { rows, wall, reasons } = landingVerdict(legs, recorded)
  const cell = (v, w) => String(v).padStart(w)
  console.log(`\n${'leg'.padEnd(18)}${cell('wall s', 9)}${cell('CPU s', 9)}${cell('budget', 9)}  state`)
  for (const r of rows) console.log(`${r.name.padEnd(18)}${cell(r.wall.toFixed(0), 9)}${cell(r.cpu?.toFixed(0) ?? '-', 9)}${cell(r.budget?.toFixed(0) ?? '-', 9)}  ${r.state}`)
  console.log(`${'total'.padEnd(18)}${cell(wall.toFixed(0), 9)}${cell(legs.reduce((s, l) => s + (l.cpu ?? 0), 0).toFixed(0), 9)}${cell('', 9)}  ${(wall / 60).toFixed(1)} of 60 min`)
  const at = `JZ_TEST_JOBS=${process.env.JZ_TEST_JOBS}, JZ_TEST_SAMPLE=${process.env.JZ_TEST_SAMPLE}, load average ${Math.round(load)} at the start and ${Math.round(loadavg()[0])} at the end`
  if (record) {
    // A leg that ran to its end is recorded, failing or not (its state says which); a leg
    // stopped by its time limit or by a signal keeps the figure it had.
    const table = JSON.parse(readFileSync(COSTS, 'utf8')), mine = legs.filter(l => l.whole)
    const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }).stdout?.trim() || 'an unknown commit'
    const failed = mine.filter(l => l.code).map(l => l.name), kept = legs.filter(l => !l.whole && table.landing?.legs[l.name]).map(l => l.name)
    table.landing = {
      measured: `${new Date().toISOString().slice(0, 10)} at ${commit} on ${cpus()[0]?.model}, ${at}${failed.length ? `; ${failed.join(', ')} failed` : ''}${kept.length ? `; ${kept.join(', ')} kept from the record before (${table.landing.measured})` : ''}`,
      legs: { ...table.landing?.legs, ...Object.fromEntries(mine.map(l => [l.name, [Math.round(l.cpu * 10) / 10, Math.round(l.wall * 10) / 10]])) },
    }
    writeFileSync(COSTS, formatCosts(table))
    console.log(`--record: ${mine.map(l => l.name).join(', ')} written to test/native-costs.json`)
  }
  console.log(`LANDING ${reasons.length ? 'RED: ' + reasons.join('; ') : 'GREEN'} (${at}; logs ${logDir})`)
  process.exitCode = reasons.length ? 1 : 0
}
