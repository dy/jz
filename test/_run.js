import test, { formats } from 'tst'
import { collect } from './_gc.js'

export async function runFiles(files) {
  // Loading a slow file must not let tst start with only a partial test list.
  test.manual = true
  for (const file of files) await import(file)

  // Wasm memories live outside the JS heap. Collect after batches of completed
  // tests, when their instances are dead; collecting during imports is too early.
  // Keep one process so compiler state leaks remain observable across files.
  const base = formats[process.env.TST_FORMAT || 'pretty']
  if (!base) throw new Error(`Unknown test format: ${process.env.TST_FORMAT}`)
  const completed = fn => function (...args) {
    fn.apply(this, args)
    collect()
  }
  // A failure's BigInt values print as BigInts: a reporter that serializes them
  // as JSON (tap) throws on one, and the throw ended the whole run there.
  const shown = v => typeof v === 'bigint' ? `${v}n` : Array.isArray(v) ? v.map(shown) : v
  const failed = fn => function (name, error, ...rest) {
    if (error && (typeof error.actual === 'bigint' || typeof error.expected === 'bigint' || Array.isArray(error.actual) || Array.isArray(error.expected)))
      error = Object.assign(Object.create(Object.getPrototypeOf(error)), error, { message: error.message, actual: shown(error.actual), expected: shown(error.expected) })
    return fn.call(this, name, error, ...rest)
  }
  const result = await test.run({ format: {
    ...base,
    testPass: completed(base.testPass),
    testFail: completed(failed(base.testFail)),
  } })
  collect(true)
  return result
}
