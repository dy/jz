#!/usr/bin/env node
// v1 ledger: the rows where jz is not yet the fastest wasm and not yet smaller
// than AssemblyScript, from a bench results file (default bench/results.json).
//
//   node scripts/v1-ledger.mjs [results.json] [--json]
//
// v1 ships when this prints no rows. A row is red when a wasm lane with parity
// runs faster than jz, or AS with parity emits fewer bytes. Ratios are jz over
// the rival, so 1.50x means jz takes 1.5x the time (or bytes).
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const path = args.find(a => !a.startsWith('--')) ?? new URL('../bench/results.json', import.meta.url).pathname
const json = args.includes('--json')
const { cases, meta } = JSON.parse(readFileSync(path, 'utf8'))
const WASM = ['as', 'rust-wasm', 'go-wasm', 'zig-wasm', 'c-wasm', 'tinygo', 'moonbit', 'javy', 'wat']

const ok = (t) => t && t.parity === 'ok'
const speed = [], size = []
let total = 0
for (const [name, c] of Object.entries(cases)) {
  const t = c.targets, jz = t.jz
  if (!ok(jz)) continue
  total++
  const rivals = WASM.filter(l => ok(t[l]) && t[l].medianUs < jz.medianUs)
    .map(l => ({ lane: l, ratio: jz.medianUs / t[l].medianUs }))
    .sort((a, b) => b.ratio - a.ratio)
  if (rivals.length) speed.push({ name, jzUs: jz.medianUs, worst: rivals[0], rivals })
  if (ok(t.as) && t.as.bytes < jz.bytes) size.push({ name, jz: jz.bytes, as: t.as.bytes, ratio: jz.bytes / t.as.bytes })
}
speed.sort((a, b) => b.worst.ratio - a.worst.ratio)
size.sort((a, b) => b.ratio - a.ratio)
if (json) { console.log(JSON.stringify({ meta: { date: meta?.date, commit: meta?.commit }, total, speed, size }, null, 2)); process.exit(0) }

console.log(`${path}  (${meta?.date ?? '?'}, ${meta?.commit ?? '?'}): ${total} cases with jz parity`)
console.log(`\nspeed: ${speed.length} rows where a wasm lane beats jz`)
for (const r of speed) console.log(`  ${r.name.padEnd(12)} ${r.worst.ratio.toFixed(2)}x vs ${r.worst.lane.padEnd(9)} ${r.rivals.map(x => `${x.lane} ${x.ratio.toFixed(2)}x`).join(', ')}`)
console.log(`\nsize: ${size.length} rows where AS is smaller`)
for (const r of size) console.log(`  ${r.name.padEnd(12)} ${r.ratio.toFixed(2)}x  ${r.jz} B vs ${r.as} B`)
process.exit(speed.length || size.length ? 1 : 0)
