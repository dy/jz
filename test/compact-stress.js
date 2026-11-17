// The compaction's stress form (JZ_DEBUG_COMPACT=1, read as the compiler and interop.js load,
// module/core/stub-log.js DBG_COMPACT): a word of slack, a loop walks at the next round that
// allocates past its move, and the host walks at every outermost return, so a pointer a walk left
// stale shows where, compacting rarely, it would hide. The files that move memory run again under
// it here, each in a process of its own (the switch is read as the modules load), their answers
// held as they are; what is policy there (how often a walk comes, how much memory a call keeps or
// the memory grows) is skipped under `stressed()` (test/_matrix.js). Each runs at level 2 alone
// (the default leg's level; a leg that names one keeps its own), a population its first seed and
// a file of many configurations a sample of them: the plain run of each, in its own suite, covers
// the rest. The files run one at a time in a suite's process (its JZ_TEST_JOBS), over the idle
// cores, at most four, when this file runs alone.
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
// [file, the tests it runs under the switch (TST_GREP), or all]
const FILES = [
  ['compact'], ['iteration-release'], ['frame-effects'], ['call-release'], ['growth'],
  ['reset-population', FIRST_SEED], ['start-population', FIRST_SEED], ['store-population', FIRST_SEED],
  ['reentry-population', FIRST_SEED], ['elem-population', FIRST_SEED],
  ['map-population'], ['durable-join-population'], ['finalizer-population'], ['plain-lift-population'],
  // a handler's frames, one in a loop, and what a compaction between them keeps
  ['handler-population', 'handler population: (a handler,|a finalizer in a loop,|what a compaction keeps)'],
]
// A file's run, at most this long: a hang fails here.
const LIMIT = 900000
const runner = fileURLToPath(new URL('./index.js', import.meta.url))

// One file under the switch: its failed tests' lines, or why it gave no answer.
const run = (file, grep) => new Promise(done => {
  const env = { ...process.env, JZ_DEBUG_COMPACT: '1', JZ_TEST_JOBS: '1', TST_FORMAT: 'tap' }
  env.JZ_TEST_OPTIMIZE ??= '2'
  if (grep) env.TST_GREP = grep
  else delete env.TST_GREP
  const p = spawn(process.execPath, [runner, file], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { out += d })
  const timer = setTimeout(() => { p.kill('SIGKILL'); out += `\nno answer in ${LIMIT / 1000} s` }, LIMIT)
  p.on('close', (code, signal) => {
    clearTimeout(timer)
    const lines = out.split('\n'), failed = []
    for (let i = 0; i < lines.length && failed.length < 40; i++) if (/^not ok |^no answer in /.test(lines[i]))
      for (let j = i; j < Math.min(lines.length, i + 6) && (j === i || !/^(not )?ok /.test(lines[j])); j++) failed.push(lines[j])
    if (code !== 0 && !failed.length) failed.push(`exit ${code}${signal ? ' ' + signal : ''}`, ...lines.slice(-6))
    done(failed)
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
  FILES.forEach(([file, grep], i) => ok(!results[i].length, `${file}${grep ? ` (${grep})` : ''} under JZ_DEBUG_COMPACT=1${results[i].length ? '\n' + results[i].join('\n') : ''}`))
})
