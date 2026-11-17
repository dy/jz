import test, { formats } from 'tst'
import { collect } from './_gc.js'

const cpu = () => { const { user, system } = process.cpuUsage(); return (user + system) / 1e6 }
// The tests registered so far: a run whose grep matches no name runs none and counts each skipped.
const registered = async () => (await test.run({ grep: /(?!)/, mute: true, parallel: false, format: { summary() {} } })).skipped

// With `costs`, the result also holds each file's [CPU seconds, tests, assertions]: its
// import, then its tests from the end of the previous file's last test to the end of its
// own, collection included. tst runs the tests in the order the files register them, so
// a test is its file's by its place; a run that skips any test cannot be read that way.
export async function runFiles(files, { costs = false } = {}) {
  // Loading a slow file must not let tst start with only a partial test list.
  test.manual = true
  const spent = [], ends = [], assertions = files.map(() => 0)
  let last = cpu(), done = 0, at = 0
  for (const file of files) {
    await import(file)
    if (!costs) continue
    ends.push(await registered())
    spent.push(cpu() - last)
    last = cpu()
  }
  const charge = count => {
    done++
    while (ends[at] < done) at++
    assertions[at] += count
    if (ends[at] === done) { const now = cpu(); spent[at] += now - last; last = now }
  }

  // Wasm memories live outside the JS heap. Collect after batches of completed
  // tests, when their instances are dead; collecting during imports is too early.
  // Keep one process so compiler state leaks remain observable across files.
  const base = formats[process.env.TST_FORMAT || 'pretty']
  if (!base) throw new Error(`Unknown test format: ${process.env.TST_FORMAT}`)
  const completed = fn => function (name, outcome, count, ...rest) {
    fn.call(this, name, outcome, count, ...rest)
    collect()
    if (costs) charge(count)
  }
  // A failure's BigInt values print as BigInts: a reporter that serializes them
  // as JSON (tap) throws on one, and the throw ended the whole run there.
  const shown = v => typeof v === 'bigint' ? `${v}n` : Array.isArray(v) ? v.map(shown) : v
  const failed = fn => function (name, error, ...rest) {
    if (error && (typeof error.actual === 'bigint' || typeof error.expected === 'bigint' || Array.isArray(error.actual) || Array.isArray(error.expected)))
      error = Object.assign(Object.create(Object.getPrototypeOf(error)), error, { message: error.message, actual: shown(error.actual), expected: shown(error.expected) })
    return fn.call(this, name, error, ...rest)
  }
  last = cpu()
  const result = await test.run({ ...costs && { parallel: false }, format: {
    ...base,
    testPass: completed(base.testPass),
    testFail: completed(failed(base.testFail)),
  } })
  collect(true)
  if (costs && done !== (ends.at(-1) ?? 0)) throw new Error(`costs: ${(ends.at(-1) ?? 0) - done} registered tests did not run (a grep, only, skip, todo or bail), so a test's place no longer names its file`)
  if (costs) result.costs = files.map((_, i) => [spent[i], ends[i] - (ends[i - 1] ?? 0), assertions[i]])
  return result
}
