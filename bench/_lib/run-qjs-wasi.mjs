#!/usr/bin/env node
// Runs QuickJS-NG's WASI command build (the release's qjs-wasi.wasm) on a flat
// script under node's WASI, the same V8 wasm engine as the other wasm rows: the
// script's directory is preopened as /case and its path is qjs's argument.
// `--version` in place of the script prints the engine's version.
import { WASI } from 'node:wasi'
import { readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'

const [engine, script] = process.argv.slice(2)
if (!engine || !script) { console.error('usage: run-qjs-wasi.mjs <qjs-wasi.wasm> <script.js | --version>'); process.exit(2) }

const wasi = new WASI({ version: 'preview1', returnOnExit: true, ...script === '--version' ? { args: ['qjs', script] }
  : { args: ['qjs', `/case/${basename(script)}`], preopens: { '/case': dirname(script) } } })
const mod = await WebAssembly.compile(readFileSync(engine))
const inst = await WebAssembly.instantiate(mod, wasi.getImportObject())
process.exitCode = wasi.start(inst)
