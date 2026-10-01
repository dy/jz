#!/usr/bin/env node
// Run the host benchmark ABI through the same initialization and value codec
// as every prebuilt jz module. Each workload times its kernel internally.
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import { instantiate } from '../../interop.js'

const file = process.argv[2]
if (!file) { console.error('usage: run-jz-host.mjs <case.wasm>'); process.exit(2) }

const module = await WebAssembly.compile(fs.readFileSync(file))
const imports = {
  env: {
    logResult: (medianUs, checksum, samples, stages, runs) => {
      console.log(`median_us=${medianUs} checksum=${checksum >>> 0} samples=${samples} stages=${stages} runs=${runs}`)
    },
  },
  performance: { now: () => performance.now() },
}

// Absent graph modules still answer undefined. Runtime imports are wired by
// interop, including host property reads and calls and the console decoder.
for (const { module: m, name, kind } of WebAssembly.Module.imports(module)) {
  if (kind !== 'function' || imports[m]?.[name] ||
      m === 'env' && /^(?:__ext_|parseInt$|parseFloat$|print$)/.test(name)) continue
  ;(imports[m] ??= {})[name] = () => undefined
}
const { exports } = instantiate(module, { imports })
if (typeof exports.main !== 'function') {
  console.error('wasm has no exported main()')
  process.exit(2)
}
exports.main()
