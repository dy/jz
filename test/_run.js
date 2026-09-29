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
  const result = await test.run({ format: {
    ...base,
    testPass: completed(base.testPass),
    testFail: completed(base.testFail),
  } })
  collect(true)
  return result
}
