#!/usr/bin/env node
// The committed listings, rewritten from the tree, and whether that moved them: the landing
// check's first leg (scripts/battery.mjs landing). A listing a change moves and nobody
// rewrote fails its own test later, on CI (land-k); rewritten here first, it moves the tree,
// and the check stops before its legs test a tree the commit does not hold. Each rewrite is a
// process of its own, JZ_TEST_JOBS at a time. Exits 1 when a file moved, naming it.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runTasks, legEnv } from './test-tasks.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
export const LISTINGS = [
  { name: 'data-forms', args: ['test/data-forms.js', '--update'], env: legEnv(), writes: 'test/data-forms.json' },
  { name: 'spellings', args: ['test/spellings.js', '--update'], env: legEnv(), writes: 'test/spellings.json' },
  // (its two hosts write one file: one after the other, in one task)
  { name: 'perf-ratchet', command: 'sh', args: ['-c', 'node test/perf-ratchet.js --update && JZ_TEST_HOST=wasi node test/perf-ratchet.js --update'], env: legEnv(), writes: 'test/perf-ratchet.json' },
  { name: 'vector-coverage', args: ['test/vector-coverage.js', '--update'], env: legEnv(), writes: 'test/vector-coverage.json' },
]

// the listings' contents, by the hash git gives them
const contents = () => {
  const files = [...new Set(LISTINGS.map(l => l.writes))]
  const r = spawnSync('git', ['hash-object', '--', ...files], { cwd: root, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git hash-object failed: ${r.stderr}`)
  return new Map(r.stdout.trim().split('\n').map((h, i) => [files[i], h]))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const before = contents()
  const results = await runTasks(LISTINGS, { jobs: Number(process.env.JZ_TEST_JOBS) || 1, cwd: root })
  const after = contents()
  const moved = [...after.keys()].filter(f => before.get(f) !== after.get(f))
  if (moved.length) console.log(`listings: the rewrite moved ${moved.join(', ')}: commit the listings, then land`)
  else console.log('listings: none moved')
  process.exitCode = moved.length || results.some(r => r.code) ? 1 : 0
}
