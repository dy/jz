// The compaction's stress form (JZ_DEBUG_COMPACT=1, read as the compiler and interop.js load,
// module/core/stub-log.js DBG_COMPACT): a word of slack, a loop walks at the next round that
// allocates past its move, and the host walks at every outermost return, so a pointer a walk left
// stale shows where, compacting rarely, it would hide. The files that move memory run again under
// it here, each in a process of its own (the switch is read as the modules load), their answers
// held as they are; what is policy there (how often a walk comes, how much memory a call keeps or
// the memory grows) is skipped under `stressed()` (test/_matrix.js).
// The generated suite runs a cut, 4.5 minutes one file after another on 14 cores at a load of 14
// (2026-11-17): each file at level 2 alone (the default leg's level; a leg that names one keeps its
// own), a population its first seed. It leaves out the map, store, element and plain-lift
// populations, the reentry population's 400 generated programs, the handler and finalizer
// populations but for a handler's compaction and a finalizer in a loop, compact.js's full stub log,
// loop in a closure and garbage below the loop after it, and iteration-release's five slowest (a
// released loop inside another, a store outside the loop, a release after the loop's own
// compaction, the binding the next iteration replaces, a receiver made before the loop): together
// 16 of the 20 minutes the files took one after another, at a load of 12, each population its first
// seed. JZ_STRESS_FULL=1 runs the whole form: every file whole, every seed, at the
// leg's levels (JZ_TEST_SWEEP=1 adds every level a file sweeps). The files run one at a time in a
// suite's process (its JZ_TEST_JOBS), over the idle cores, at most four, when this file runs
// alone: `JZ_STRESS_FULL=1 node test/index.js compact-stress`.
// Found through it: an array kept in a module array by a loop that compacts was freed (the escape
// log the move leaves full, module/core/compact.js `__gc_move`, in 1.0.3 too); a dictionary grown
// at start and again in a round read the round's table after a reset (the last stub of a chain,
// `__gc_mark`); a shifted array's base record listed as a stub forwarded to itself, and the next
// access never returned (`__gc_update`, in 1.0.3 too); a value stored into a module array of the
// static data was freed, and its stub there trapped the walk (the static data walked, in 1.0.3
// too); a grown array whose properties went to the global table, its header's word taken for a
// shift's mark, read empty after the walk moved it (`__gc_canon`, in 1.0.3 too).
import test from 'tst'
import { ok } from 'tst/assert.js'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { onWasi, onKernel } from './_matrix.js'
import { suiteJobs } from '../scripts/test-tasks.mjs'

const FIRST_SEED = '^(?!.*seed [2-9])'
const FULL = process.env.JZ_STRESS_FULL === '1'
// [file, what the cut runs of it: a TST_GREP of its tests, all of it (true) or nothing (false)]
const FILES = [
  ['compact', '^(?!.*(a full stub log declines|a loop in a closure compacts|a loop that drops what it makes leaves no garbage))'],
  ['iteration-release', '^(?!.*(a released loop inside another|a store into a binding outside the loop|a release after a compaction|a binding the next iteration replaces|a receiver made before the loop))'],
  ['frame-effects', true], ['call-release', true], ['growth', true],
  ['reset-population', FIRST_SEED], ['start-population', FIRST_SEED], ['durable-join-population', true],
  ['reentry-population', '^(?!.*generated programs)'],
  ['handler-population', 'what a compaction keeps'], ['finalizer-population', 'a finalizer in a loop'],
  ['store-population', false], ['elem-population', false], ['map-population', false], ['plain-lift-population', false],
].filter(([, cut]) => FULL || cut !== false).map(([file, cut]) => [file, FULL || cut === true ? '' : cut])
// A file's run, at most this long: a hang fails here (a whole population under the switch, an hour:
// store-population took 850 to 980 seconds on a loaded machine)
const LIMIT = FULL ? 3600000 : 900000
const runner = fileURLToPath(new URL('./index.js', import.meta.url))

// One file under the switch: its failed tests' lines, or why it gave no answer.
const run = (file, grep) => new Promise(done => {
  const env = { ...process.env, JZ_DEBUG_COMPACT: '1', JZ_TEST_JOBS: '1', TST_FORMAT: 'tap' }
  if (!FULL) env.JZ_TEST_OPTIMIZE ??= '2'
  if (grep) env.TST_GREP = grep
  else delete env.TST_GREP
  const p = spawn(process.execPath, [runner, file], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const t0 = Date.now()
  let out = ''
  p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { out += d })
  const timer = setTimeout(() => { p.kill('SIGKILL'); out += `\nno answer in ${LIMIT / 1000} s` }, LIMIT)
  p.on('close', (code, signal) => {
    clearTimeout(timer)
    const lines = out.split('\n'), failed = []
    for (let i = 0; i < lines.length && failed.length < 40; i++) if (/^not ok |^no answer in /.test(lines[i]))
      for (let j = i; j < Math.min(lines.length, i + 6) && (j === i || !/^(not )?ok /.test(lines[j])); j++) failed.push(lines[j])
    if (code !== 0 && !failed.length) failed.push(`exit ${code}${signal ? ' ' + signal : ''}`, ...lines.slice(-6))
    done({ failed, s: Math.round((Date.now() - t0) / 1000) })
  })
})

// (an async test's time is held to tst's five seconds unless it states its own: every file's limit)
test('compact stress: the files that move memory, every chance to compact taken', { timeout: FILES.length * LIMIT }, async () => {
  // the host's compaction is the JS host's, and the kernel compiles none of the switch's code
  if (onWasi() || onKernel()) return
  const jobs = Math.min(4, suiteJobs(process.env.JZ_TEST_JOBS || undefined, FILES.length))
  const results = new Array(FILES.length)
  let next = 0
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (next < FILES.length) { const i = next++; results[i] = await run(...FILES[i]) }
  }))
  // every file's line, the ones that answered first: a failed assertion ends the test
  const bad = []
  FILES.forEach(([file, grep], i) => {
    const { failed, s } = results[i], name = `${file}${grep ? ` (${grep})` : ''} under JZ_DEBUG_COMPACT=1, ${s} s`
    if (failed.length) bad.push(name + '\n' + failed.join('\n'))
    else ok(true, name)
  })
  ok(!bad.length, `${bad.length} of ${FILES.length} files differ or give no answer${bad.length ? ':\n' + bad.join('\n') : ''}`)
})
