#!/usr/bin/env node
// Runs a Javy-built wasm (embedded QuickJS) under node's WASI — same V8 wasm
// engine as every other wasm rival. Javy routes `console.log` to stderr, so map
// the guest's stdout AND stderr to host fd 1, letting bench.mjs parse the
// `median_us=… checksum=…` line off stdout regardless of which fd Javy picks.
import { WASI } from 'node:wasi'
import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) { console.error('usage: run-javy.mjs <kernel.wasm>'); process.exit(2) }

const wasi = new WASI({ version: 'preview1', returnOnExit: true, stdout: 1, stderr: 1 })
const mod = await WebAssembly.compile(readFileSync(file))
const inst = await WebAssembly.instantiate(mod, wasi.getImportObject())
wasi.start(inst)
