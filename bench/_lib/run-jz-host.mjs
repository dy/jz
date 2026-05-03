#!/usr/bin/env node
// Runs a jz-built wasm with host imports for env.logResult and performance.now
// (mirrors AssemblyScript's env.perfNow/env.logLine approach for fair size comparison)
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'

const file = process.argv[2]
if (!file) { console.error('usage: run-jz-host.mjs <case.wasm>'); process.exit(2) }

const bytes = fs.readFileSync(file)
const imports = {
  env: {
    logResult: (medianUs, checksum, samples, stages, runs) => {
      console.log(`median_us=${medianUs} checksum=${checksum >>> 0} samples=${samples} stages=${stages} runs=${runs}`)
    },
    __ext_prop: () => 0,
    __ext_has: () => 0,
    __ext_set: () => 0,
    __ext_call: () => { throw new Error('__ext_call called in host-import bench') },
  },
  performance: {
    now: () => performance.now(),
  },
}

const { instance } = await WebAssembly.instantiate(bytes, imports)
if (typeof instance.exports.main !== 'function') {
  console.error('wasm has no exported main()')
  process.exit(2)
}
instance.exports.main()
