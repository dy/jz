// Times the exports of one kernel file under V8 and jz, interleaved minimum, and checks they agree.
//
//   node bench/_audiojs/repro/decode/run.mjs ring.js            every export
//   node bench/_audiojs/repro/decode/run.mjs pcm.js k1r k1      named exports
//
// `init` runs once first; an export named with a leading `_` is not run. Every other export
// is called with the same host bytes: interleaved stereo, float32 words kept finite (pcm.js
// reads them; the other kernels ignore the argument).
// One file per process: in one process, V8's wasm inlining depends on what ran before.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build, instantiate, measure, us } from '../../lib.mjs'
import { channelsAgree } from '../../compare.mjs'

const [file, ...names] = process.argv.slice(2)
const path = resolve(import.meta.dirname, file)
const b = build(readFileSync(path, 'utf8'))
const js = await import(pathToFileURL(b.file))
const { exports: wz, memory } = instantiate(b.wasm)
js.init?.(); wz.init?.()

const buf = new Uint8Array(441000 * 4)
for (let i = 0, s = 1; i < buf.length; i++) { s = (s * 1103515245 + 12345) >>> 0; buf[i] = s >>> 24 }
for (let i = 0; i < buf.length; i += 4) { buf[i] &= 0x3f; buf[i + 3] &= 0x3f }
buf[0] = 2; buf[1] = buf[2] = buf[3] = 0

const same = (a, z) => Array.isArray(a) ? channelsAgree(a, z) : a === z ? 'same' : `js ${a}, jz ${z}`
for (const f of names.length ? names : Object.keys(js).filter(k => k !== 'init' && k[0] !== '_' && typeof js[k] === 'function')) {
  const note = same(js[f](buf), wz[f](buf)); memory.reset?.()
  const t = measure({ js: () => js[f](buf), jz: () => { wz[f](buf); memory.reset?.() } }, { rounds: 25, warm: 3, budget: 6000 })
  console.log(f.padEnd(8), 'V8', us(t.js).padEnd(9), 'jz', us(t.jz).padEnd(9), (t.js / t.jz).toFixed(2) + '×', note)
}
