#!/usr/bin/env node
// Runs a WASI Preview-1 wasm (a Rust/Go/Zig/C rival compiled to wasm32-wasi) in
// node's V8 engine — the SAME wasm engine jz's output runs in, so the comparison
// is wasm-vs-wasm, apples-to-apples (not wasm-vs-native). The rival is a standalone
// self-timing program that prints `median_us=… checksum=…` to stdout, parsed by bench.mjs.
import { WASI } from 'node:wasi'
import { readFileSync } from 'node:fs'
import { passes } from './passes.js'

const file = process.argv[2]
if (!file) { console.error('usage: run-wasi.mjs <kernel.wasm>'); process.exit(2) }

const mod = await WebAssembly.compile(readFileSync(file))
// a pass is a fresh instance of the one compiled module (a WASI instance starts once)
await passes(() => {
  const wasi = new WASI({ version: 'preview1', returnOnExit: true })
  wasi.start(new WebAssembly.Instance(mod, wasi.getImportObject()))
})
