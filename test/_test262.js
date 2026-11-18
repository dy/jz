// What the language runner (test/test262.js) and the built-ins runner
// (test/test262-builtins.js) share: the corpus checkout at the pinned commit, the
// walk over it, the $DONE shim and the fan-out over worker threads. How a test is
// run, which files are collected and how a worker tallies differ between the two.
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { Worker, workerData, parentPort } from 'worker_threads'
import { suiteJobs } from '../scripts/test-tasks.mjs'

export const TEST262 = join(import.meta.dirname, 'test262')

// The one committed lock both runners gate on: `corpus` is the tc39/test262 commit
// the checkout is pinned to, beside the pass floors measured on it. An unpinned
// shallow clone made the counts drift with whatever snapshot filled the cache.
// To bump: set `corpus` to the new upstream SHA, run `npm run test:262 && npm run
// test:262:builtins` (ensureTest262 re-pins an existing checkout), prune any
// EXPECTED_FAIL_FILES / LEGACY_LANG_LIMITATIONS entry reported as xpass, add a new
// out-of-scope fail as xfail with its reason, and refresh the floors here and the
// accepted-negative ledger (test262-neg-accepts.json) in the same commit.
export const LOCK = JSON.parse(readFileSync(join(import.meta.dirname, 'test262-baseline.json'), 'utf8'))

// The checkout at the pinned commit, cloned when missing: a single-commit fetch,
// which GitHub serves for any reachable SHA, not only a ref. Main thread only;
// workers read the same checkout.
export function ensureTest262(pin = LOCK.corpus) {
  const git = cmd => execSync(`git -C ${TEST262} ${cmd}`, { stdio: 'inherit' })
  const fetch = () => { git(`fetch --depth 1 origin ${pin}`); git('checkout -q FETCH_HEAD') }
  if (!existsSync(TEST262)) {
    console.log(`Cloning test262 @ ${pin.slice(0, 8)} (this may take a minute)...`)
    execSync(`git init -q ${TEST262}`, { stdio: 'inherit' })
    git('remote add origin https://github.com/tc39/test262.git')
    return fetch()
  }
  const head = execSync(`git -C ${TEST262} rev-parse HEAD`, { encoding: 'utf8' }).trim()
  if (head === pin) return
  console.log(`test262 checkout at ${head.slice(0, 8)}, pinning to ${pin.slice(0, 8)}...`)
  try { git(`checkout -q ${pin}`) } catch { fetch() }
}

export const FILTER = process.argv.find(a => a.startsWith('--filter='))?.split('=')[1]
const JOBS_ARG = process.argv.find(a => a.startsWith('--jobs='))?.slice(7)

export function* walk(dir) {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) yield* walk(full)
      else if (entry.name.endsWith('.js') && !entry.name.startsWith('.')) yield full
    }
  } catch { /* skip unreadable dirs */ }
}

export function countJs(dir) {
  let count = 0
  for (const _ of walk(dir)) count++
  return count
}

// flags:[async] tests call $DONE(err?): this module-level shim stands in for
// doneprintHandle.js, and the host polls __t262_check, each call draining the
// module's microtask queue at the boundary (timers ride the real setTimeout).
export const ASYNC_DONE_SHIM = `
let __t262d = 0
let __t262e = undefined
let $DONE = (e) => { if (__t262d) return; __t262d = 1; if (e != null && e !== false) __t262e = '' + e }
let asyncTest = (fn) => { fn().then(() => $DONE(), (e) => $DONE(e == null ? 'rejected' : e)) }
export let __t262_check = () => __t262d === 0 ? '@pending' : __t262e == null ? '@ok' : __t262e
`

// A worker thread runs the share it was dealt and posts its tallies back.
export const runWorker = runChunk => runChunk(workerData.items).then(r => parentPort.postMessage(r))

// The work dealt round-robin, so the heavy directories spread over every worker, to
// as many workers as a suite run has processes: --jobs=N or JZ_TEST_JOBS, else the
// idle cores, a worker to every 2 GiB (scripts/test-tasks.mjs suiteJobs). Each worker
// has its own module registry and jz resets its state every compile, so the
// tallies are those of one thread running the files in turn. `runner` is the
// runner's own file, which a worker loads to reach its runChunk.
export async function fanOut(runner, work) {
  const jobs = suiteJobs(JOBS_ARG ?? process.env.JZ_TEST_JOBS, Math.max(1, work.length))
  const chunks = Array.from({ length: jobs }, () => [])
  work.forEach((item, i) => chunks[i % jobs].push(item))
  console.log(`Running ${work.length} tests across ${jobs} worker${jobs > 1 ? 's' : ''}...`)
  return Promise.all(chunks.map(items => new Promise((resolve, reject) => {
    const w = new Worker(runner, { workerData: { items } })
    w.once('message', resolve)
    w.once('error', reject)
    w.once('exit', code => code === 0 || reject(new Error(`worker exited with code ${code}`)))
  })))
}
