#!/usr/bin/env node
// Why a phase checkpoint declines: the compiler's own compile (jz × jz) through
// a kernel built with JZ_DEBUG_ESC=1, each site that wrote below an open
// phase's mark counted against that phase.
//
//   JZ_DEBUG_ESC=1 node scripts/self-compile-build.mjs k.wasm 2> k.notes
//   node scripts/phase-escapes.mjs k.wasm k.notes [--top 12] [--json out.json]
//
// The build lists every site it flags on stderr (`esc-note <id>: <function>
// <line>: <why>: <node>`); the kernel calls `env.__esc_note(id, before,
// target)` where one runs, `target` the address the site itself lowered the
// flag to (src/compile/emit/dispatch.js; zero for a write with no address, all
// ones for none). The open phases and their marks are read in the kernel's
// memory as each note arrives (scripts/phase-marks.js phaseOpenAddr); every
// verdict record carries its phase's serial (`verdictAt`). A kernel built
// without the notes still prints each verdict: its mark, the flag it read,
// whether the durable logs held.
import { readFileSync, writeFileSync } from 'node:fs'
import { instantiate } from '../interop.js'
import { readMarks } from './kernel-marks.mjs'
import { resolveSelfCompileBuild } from './build-profile.mjs'

const argv = process.argv.slice(2)
const valueOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null }
const [kernelPath, notesPath] = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'))
if (!kernelPath) { console.error('usage: phase-escapes.mjs kernel.wasm [notes] [--top n] [--json out.json]'); process.exit(2) }
const top = Number(valueOf('--top') ?? 12), jsonOut = valueOf('--json')

const kernel = readFileSync(kernelPath)
const noting = WebAssembly.Module.imports(new WebAssembly.Module(kernel)).some(i => i.name === '__esc_note')
const noteText = new Map()
if (notesPath) for (const line of readFileSync(notesPath, 'utf8').split('\n')) {
  const m = /^esc-note (\d+): (.*)$/.exec(line)
  if (m) noteText.set(+m[1], m[2])
}

// serial · 2^20 + note id → [count, first target]
const SERIAL = 1 << 20, hits = new Map()
let f64 = null, memory = null, openAt = 0, notes = 0
const _interp = noting ? {
  __esc_note: (id, before, target) => {
    notes++
    target >>>= 0
    if (target === 0xFFFFFFFF || openAt === 0) return
    if (f64 === null || f64.buffer !== memory.buffer) f64 = new Float64Array(memory.buffer)
    const depth = Math.min(f64[openAt], 64)
    for (let d = 0; d < depth; d++) {
      if (target >= f64[openAt + 3 + 2 * d]) continue
      const key = f64[openAt + 2 + 2 * d] * SERIAL + id, h = hits.get(key)
      if (h) h[0]++; else hits.set(key, [1, target])
    }
  },
} : undefined
const k = instantiate(kernel, { memory: 65536, externref: false, _interp })
memory = k.instance.exports.memory
if (noting && typeof k.exports.phaseOpenAddr !== 'function') { console.error('the kernel has no phaseOpenAddr: rebuild it'); process.exit(2) }
openAt = noting ? k.exports.phaseOpenAddr() >>> 3 : 0

const profile = resolveSelfCompileBuild()
const t0 = performance.now()
let error = null, bytes = null
try {
  const out = k.exports.default(k.memory.String(profile.graph.code), 0,
    k.memory.String(JSON.stringify(typeof profile.optimize === 'number' ? { level: profile.optimize } : profile.optimize)),
    k.memory.String(JSON.stringify(profile.graph.modules)), 0, 0,
    k.memory.String(JSON.stringify({ memory: profile.memory, compactCollections: profile.compactCollections })))
  const bin = k.memory.read(out)
  bytes = bin instanceof Uint8Array ? bin : new Uint8Array(bin)
} catch (e) { error = e.message }
const m = readMarks(k)
const MB = n => (n / 1048576).toFixed(0)
console.log(`jz × jz: ${((performance.now() - t0) / 1000).toFixed(0)} s, ${error ? 'error: ' + error.split('\n')[0] : bytes.length + ' bytes'}; heap ${MB(k.instance.exports.__heap.value >>> 0)} MB; ` +
  `checkpoints taken ${m.checkpoints}, declined ${m.declines}${noting ? `; ${notes} notes` : ''}`)
const rows = []
let prev = m.heapFront
m.phases.forEach((p, i) => {
  const row = { name: p.name, heap: p.heap, delta: p.heap - prev }
  prev = p.heap
  if (p.verdict) {
    Object.assign(row, p.verdict, { phase: m.phases.slice(i + 1).find(q => !q.name.startsWith('checkpoint:'))?.name })
    row.sites = [...hits].filter(([key]) => Math.floor(key / SERIAL) === row.serial)
      .map(([key, [count, target]]) => ({ id: key % SERIAL, count, target, at: noteText.get(key % SERIAL) ?? null }))
      .sort((a, b) => b.count - a.count)
  }
  rows.push(row)
})
for (const r of rows) {
  if (!r.sites) { console.log(`  ${r.name.padEnd(40)} heap ${MB(r.heap).padStart(5)} MB  ${r.delta >= 0 ? '+' : ''}${MB(r.delta)}`); continue }
  console.log(`  ${r.name.padEnd(40)} heap ${MB(r.heap).padStart(5)} MB  ${r.phase}: grew ${MB(r.heap - r.mark)} MB, flag ${r.flag === 0xFFFFFFFF ? 'clear' : r.flag}, ` +
    `durable logs ${r.durable ? 'held' : 'grew'}${noting ? `, ${r.sites.length} sites below its mark` : ''}`)
  for (const s of r.sites.slice(0, top)) console.log(`      ${String(s.count).padStart(9)}× → ${s.target}  ${(s.at ?? '#' + s.id).slice(0, 200)}`)
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ error, bytes: bytes?.length ?? null, notes, rows }, null, 1))
