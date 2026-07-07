// Verify every repro: expected (node) vs actual (jz). Exit 1 if any still fails.
import { readFileSync } from 'node:fs'
import jz from '../../index.js'

const here = new URL('.', import.meta.url).pathname
const read = f => readFileSync(here + f, 'utf8')
let fails = 0
const check = (name, expected, actual) => {
  const ok = JSON.stringify(expected) === JSON.stringify(actual)
  if (!ok) fails++
  console.log(`${ok ? '  ok' : 'FAIL'} ${name}: node=${JSON.stringify(expected)} jz=${JSON.stringify(actual)}`)
}

// 1. export-alias — compile must succeed
try {
  const { exports } = jz(read('export-alias.js'), { modules: { './export-alias-lib.js': read('export-alias-lib.js') } })
  check('export-alias', 6, exports.f(3))
} catch (e) { fails++; console.log('FAIL export-alias: compile —', e.message.split('\n')[0]) }

// 2. typedarray-copy
{
  const { exports, memory } = jz(read('typedarray-copy.js'))
  check('typedarray-copy', 1, Number(exports.default(memory.Float64Array([1, 2]))))
}

// 3. heap-map
{
  const { exports, memory } = jz(read('heap-map.js'))
  let v = exports.f(memory.Array([10, 20]))
  if (typeof v === 'bigint') v = memory.read(v)
  check('heap-map', [{ v: 10 }, { v: 20 }], v)
}

// 4. nested-array
{
  const { exports, memory } = jz(read('nested-array.js'))
  let v = exports.default(memory.Object({ order: 4, delta: 100 }))
  if (typeof v === 'bigint') v = memory.read(v)
  check('nested-array', 400, v)
}

// 5. math-kernel-precision — report only (tolerance question, not pass/fail)
{
  const { exports } = jz(read('math-kernel-precision.js'))
  const mod = await import(here + 'math-kernel-precision.js')
  for (const [name, args] of [['sin1', []], ['b0', [1000, 44100]]]) {
    const n = mod[name](...args), j = exports[name](...args)
    console.log(`  info math-kernel ${name}: node=${n} jz=${j} rel=${Math.abs((j - n) / n).toExponential(1)}`)
  }
}

process.exit(fails ? 1 : 0)
