#!/usr/bin/env node
// Runs a js2wasm JS-host build (<case>.wasm and its generated <case>.imports.js)
// in node's V8. The helper takes its shared host glue from the bare `js2wasm`
// specifier, resolved here to the runtime beside the compiler that built it.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [wasm, runtime] = process.argv.slice(2)
if (!wasm || !runtime) { console.error('usage: run-js2wasm.mjs <case.wasm> <js2wasm dist/runtime.js>'); process.exit(2) }
const helper = readFileSync(wasm.replace(/\.wasm$/, '.imports.js'), 'utf8')
  .replace(/from\s+["']js2wasm["']/, `from ${JSON.stringify(pathToFileURL(runtime).href)}`)
const { instantiateBytes } = await import('data:text/javascript,' + encodeURIComponent(helper))
await instantiateBytes(readFileSync(wasm))
