#!/usr/bin/env node
// Bounded landing battery. `fast` means only the semantic matrix: no hidden
// bootstrap, generated population sweep, or timing run. Full retains those
// checks, with the memory-heavy bootstrap run alone after the native work.
import { runTasks, matrixTasks, invariantTask, extendedTasks, legEnv, positiveInteger } from './test-tasks.mjs'

const args = process.argv.slice(2)
let fast = false, list = false, jobs = process.env.JZ_TEST_JOBS || 1
for (const arg of args) {
  if (arg === 'fast') fast = true
  else if (arg === '--list') list = true
  else if (arg.startsWith('--jobs=')) jobs = arg.slice(7)
  else throw new Error(`Unknown battery argument '${arg}'; use [fast] [--jobs=N] [--list]`)
}
jobs = positiveInteger(jobs, 'jobs')
const tasks = [...matrixTasks(), invariantTask()]
if (!fast) tasks.push(...extendedTasks(), invariantTask('integration'),
  { name: 'fuzz-extended', args: ['test/fuzz.js'], env: legEnv({ JZ_DEBUG_INVARIANTS: '1' }) },
  { name: 'fixpoint', args: ['scripts/audit-fixpoint.mjs'], env: legEnv() },
)
const bootstrap = { name: 'bootstrap', args: ['test/bootstrap.mjs', '--full'], env: legEnv(), timeout: 14_400_000 }
if (list) {
  for (const t of [...tasks, ...(!fast ? [bootstrap] : [])]) console.log(`${t.name}: node ${t.args.join(' ')}`)
} else {
  const start = performance.now()
  const results = await runTasks(tasks, { jobs })
  // A failing native run is not a reason to start hours of self-hosted work.
  if (!fast && results.every(r => r.code === 0)) results.push(...await runTasks([bootstrap], { jobs: 1 }))
  const failures = results.filter(r => r.code !== 0)
  console.log(`BATTERY ${failures.length ? 'RED: ' + failures.map(r => r.name).join(', ') : 'GREEN'} (${((performance.now() - start) / 60000).toFixed(1)} min)`)
  process.exitCode = failures.length ? 1 : 0
}
