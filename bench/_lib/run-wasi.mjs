#!/usr/bin/env node
// Runs a WASI Preview-1 wasm (a Rust/Go/Zig/C rival compiled to wasm32-wasi) in
// node's V8 engine — the SAME wasm engine jz's output runs in, so the comparison
// is wasm-vs-wasm, apples-to-apples (not wasm-vs-native). The rival is a standalone
// self-timing program that prints `median_us=… checksum=…` to stdout, parsed by bench.mjs.
import { WASI } from 'node:wasi'
import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) { console.error('usage: run-wasi.mjs <kernel.wasm>'); process.exit(2) }

const wasi = new WASI({ version: 'preview1', returnOnExit: true })
const mod = await WebAssembly.compile(readFileSync(file))
const inst = await WebAssembly.instantiate(mod, wasi.getImportObject())
wasi.start(inst)
