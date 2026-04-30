#!/usr/bin/env node
// Runs an AssemblyScript-built wasm with two host imports:
//   env.perfNow()                                    : f64 (ms since some epoch)
//   env.logLine(medianUs, checksum, samples, stages, runs)  → prints bench line
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'

const file = process.argv[2]
if (!file) { console.error('usage: run-as.mjs <case.wasm>'); process.exit(2) }

const bytes = fs.readFileSync(file)
const imports = {
  env: {
    perfNow: () => performance.now(),
    logLine: (medianUs, checksum, samples, stages, runs) => {
      const cs = checksum >>> 0
      console.log(`median_us=${medianUs} checksum=${cs} samples=${samples} stages=${stages} runs=${runs}`)
    },
    abort: (msg, file, line, col) => { throw new Error(`AS abort at ${line}:${col}`) },
    seed: () => Date.now() * Math.random(),
  },
}
const { instance } = await WebAssembly.instantiate(bytes, imports)
if (typeof instance.exports.main !== 'function') {
  console.error('wasm has no exported main()')
  process.exit(2)
}
instance.exports.main()
