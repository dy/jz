#!/usr/bin/env node
// Runs QuickJS-NG's WASI command build (the release's qjs-wasi.wasm) on a flat
// script under node's WASI, the same V8 wasm engine as the other wasm rows: the
// script's directory is preopened as /case and its path is qjs's argument.
// `--version` in place of the script prints the engine's version.
import { WASI } from 'node:wasi'
import { readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { passes } from './passes.js'

const [engine, script] = process.argv.slice(2)
if (!engine || !script) { console.error('usage: run-qjs-wasi.mjs <qjs-wasi.wasm> <script.js | --version>'); process.exit(2) }

const options = { version: 'preview1', returnOnExit: true, ...script === '--version' ? { args: ['qjs', script] }
  : { args: ['qjs', `/case/${basename(script)}`], preopens: { '/case': dirname(script) } } }
const mod = await WebAssembly.compile(readFileSync(engine))
const run = () => {
  const wasi = new WASI(options)
  return wasi.start(new WebAssembly.Instance(mod, wasi.getImportObject()))
}
// a pass is a fresh instance of the engine's module, which runs the script again; a
// pass that exits otherwise than 0 ends the process with its status
if (script === '--version') process.exitCode = run()
else await passes(() => { const status = run(); if (status) process.exit(status) })
