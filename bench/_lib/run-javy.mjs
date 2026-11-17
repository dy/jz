#!/usr/bin/env node
// Runs a Javy-built wasm (embedded QuickJS) under node's WASI — same V8 wasm
// engine as every other wasm rival. Javy routes `console.log` to stderr, so map
// the guest's stdout AND stderr to host fd 1, letting bench.mjs parse the
// `median_us=… checksum=…` line off stdout regardless of which fd Javy picks.
import { WASI } from 'node:wasi'
import { readFileSync } from 'node:fs'
import { passes } from './passes.js'

const file = process.argv[2]
if (!file) { console.error('usage: run-javy.mjs <kernel.wasm>'); process.exit(2) }

const mod = await WebAssembly.compile(readFileSync(file))
// a pass is a fresh instance of the one compiled module: the interpreter's wasm keeps
// what V8 compiled, the script starts over
await passes(() => {
  const wasi = new WASI({ version: 'preview1', returnOnExit: true, stdout: 1, stderr: 1 })
  wasi.start(new WebAssembly.Instance(mod, wasi.getImportObject()))
})
