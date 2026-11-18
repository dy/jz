#!/usr/bin/env node
// Runs a MoonBit module (`moon build --target wasm`) in node's V8, the engine jz's wasm
// runs in, with the host moonrun gives it: WASI's fd_write for the result line and
// moonrun's monotonic clock (`__moonbit_time_unstable`: an opaque instant, and the
// seconds since one), the only imports the corpus's ports have. moonrun itself
// instantiates a module once and calls its `_start`, with no hook for another pass.
import { WASI } from 'node:wasi'
import { readFileSync } from 'node:fs'
import { passes } from './passes.js'

const file = process.argv[2]
if (!file) { console.error('usage: run-moonbit.mjs <case.wasm>'); process.exit(2) }

const mod = await WebAssembly.compile(readFileSync(file))
const clock = { instant_now: () => performance.now(), instant_elapsed_as_secs_f64: t => (performance.now() - t) / 1000 }
// a pass is a fresh instance of the one compiled module (a WASI instance starts once)
await passes(() => {
  const wasi = new WASI({ version: 'preview1', returnOnExit: true })
  wasi.start(new WebAssembly.Instance(mod, { ...wasi.getImportObject(), __moonbit_time_unstable: clock }))
})
