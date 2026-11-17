#!/usr/bin/env node
import fs from 'node:fs'
import { wasi } from '../../wasi.js'
import { passes } from './passes.js'

const file = process.argv[2]
if (!file) { console.error('usage: run-wasm.mjs <kernel.wasm>'); process.exit(2) }

const mod = await WebAssembly.compile(fs.readFileSync(file))
// a pass is a fresh instance of the one compiled module
await passes(() => {
  const w = wasi()
  const instance = new WebAssembly.Instance(mod, { ...w, env: { __ext_has: () => 0, __ext_set: () => 0 } })
  w._setMemory(instance.exports.memory)
  if (typeof instance.exports.main !== 'function') {
    console.error('wasm has no exported main()')
    process.exit(2)
  }
  instance.exports.main()
})
