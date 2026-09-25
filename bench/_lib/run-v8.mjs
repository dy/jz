#!/usr/bin/env node
import { pathToFileURL } from 'node:url'

// The self-compiler uses heap diagnostics in Wasm. JS hosts own their memory
// and need no arena checkpoint (same adapter as test/self-compile-perf.js).
globalThis.__heap_mark ??= () => 0
globalThis.__heap_large ??= () => false

const file = process.argv[2]
if (!file) { console.error('usage: run-v8.mjs <case.js>'); process.exit(2) }
const mod = await import(pathToFileURL(file))
mod.main()
