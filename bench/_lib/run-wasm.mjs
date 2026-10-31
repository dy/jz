#!/usr/bin/env node
import fs from 'node:fs'
import { wasi } from '../../wasi.js'

const file = process.argv[2]
if (!file) { console.error('usage: run-wasm.mjs <kernel.wasm>'); process.exit(2) }

const bytes = fs.readFileSync(file)
const w = wasi()
const imports = {
  ...w,
  env: {
    __ext_has: () => 0,
    __ext_set: () => 0,
  },
}
const { instance } = await WebAssembly.instantiate(bytes, imports)
w._setMemory(instance.exports.memory)
if (typeof instance.exports.main !== 'function') {
  console.error('wasm has no exported main()')
  process.exit(2)
}
instance.exports.main()
