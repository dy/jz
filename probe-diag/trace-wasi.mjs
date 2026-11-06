// trace-wasi.mjs <rival.wasm>: run-wasi.mjs with each monotonic clock read kept, the timed pairs printed
import { WASI } from 'node:wasi'
import { readFileSync } from 'node:fs'
const wasi = new WASI({ version: 'preview1', returnOnExit: true })
const mod = await WebAssembly.compile(readFileSync(process.argv[2]))
const io = wasi.getImportObject(), ts = []
const clock = io.wasi_snapshot_preview1.clock_time_get
io.wasi_snapshot_preview1.clock_time_get = (id, p, ptr) => { const r = clock(id, p, ptr); if (id === 1) ts.push(performance.now()); return r }
const inst = await WebAssembly.instantiate(mod, io)
wasi.start(inst)
const d = []
for (let i = 0; i + 1 < ts.length; i += 2) d.push(Math.round((ts[i + 1] - ts[i]) * 1000))
console.error('samples_us', d.join(' '))
