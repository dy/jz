#!/usr/bin/env node
// Compile budget: wall time and peak memory of compiling real programs, each in
// a fresh process, against an optional baseline.
//
//   node scripts/compile-budget.mjs                       # table
//   node scripts/compile-budget.mjs --json > budget.json  # record
//   node scripts/compile-budget.mjs --baseline budget.json [--tolerance 0.10]
//   node scripts/compile-budget.mjs --root <other checkout> --json   # a baseline from a tag
//
// Entries are the ecosystem drivers (jessie, watr) plus any extra entry paths
// given on the command line. Peak memory is the child's maxRSS; time is the
// median of three compiles inside one child (the first is discarded as warm-up).
// With --baseline, a row more than `tolerance` slower or heavier than its
// baseline fails the run. This is the v1 gate for compile cost (PLAN.md).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const ROOT = flag('--root') ?? join(dirname(fileURLToPath(import.meta.url)), '..')
const json = args.includes('--json')
const baselinePath = flag('--baseline')
const tolerance = Number(flag('--tolerance') ?? 0.10)
const VALUE_FLAGS = new Set(['--baseline', '--tolerance', '--root'])
const extra = args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1]))

const driverDir = mkdtempSync(join(tmpdir(), 'jz-budget-'))
symlinkSync(join(ROOT, 'node_modules'), join(driverDir, 'node_modules'))
const driver = (name, src) => { const p = join(driverDir, name); writeFileSync(p, src); return p }
const entries = [
  ['jessie', driver('jessie-driver.js', `import { parse } from 'subscript/feature/jessie'\nexport let run = (s) => parse(s)`)],
  ['watr', driver('watr-driver.js', `import compile from 'watr/compile'\nexport let run = (s) => compile(s)`)],
  ...extra.map(p => [p.split('/').slice(-2).join('/'), p]),
]

const CHILD = `
import { resolveModuleGraph } from ${JSON.stringify(join(ROOT, 'src/resolve.js'))}
import { compile } from ${JSON.stringify(join(ROOT, 'index.js'))}
const entry = process.argv[2]
const g = resolveModuleGraph(entry, { resolveNode: true })
const opts = { modules: g.modules, memory: 8192, optimize: 2 }
const times = []
let bytes = 0
for (let i = 0; i < 4; i++) {
  const t = performance.now()
  bytes = compile(g.code, opts).length
  if (i) times.push(performance.now() - t)
}
times.sort((a, b) => a - b)
console.log(JSON.stringify({ ms: +times[1].toFixed(1), bytes, rssMB: +(process.resourceUsage().maxRSS / 1024).toFixed(0) }))
`
const childPath = driver('child.mjs', CHILD)
const rows = []
for (const [name, entry] of entries) {
  try {
    const out = execFileSync(process.execPath, [childPath, entry], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 })
    rows.push({ name, ...JSON.parse(out.trim().split('\n').pop()) })
  } catch (e) {
    rows.push({ name, error: String(e.stderr || e.message).split('\n').find(l => l.trim()) ?? 'failed' })
  }
}
if (json) { console.log(JSON.stringify(rows, null, 2)); process.exit(0) }

const baseline = baselinePath ? Object.fromEntries(JSON.parse(readFileSync(baselinePath, 'utf8')).map(r => [r.name, r])) : null
const pad = (s, n) => String(s).padEnd(n), num = (s, n) => String(s ?? '').padStart(n)
console.log(pad('entry', 32) + num('wasm B', 9) + num('ms', 9) + num('peak MB', 9) + (baseline ? num('ms Δ', 9) + num('MB Δ', 9) : ''))
let failed = false
for (const r of rows) {
  if (r.error) { console.log(pad(r.name, 32) + '  ' + r.error.slice(0, 100)); failed = true; continue }
  let delta = ''
  if (baseline?.[r.name] && !baseline[r.name].error) {
    const b = baseline[r.name]
    const dm = r.ms / b.ms - 1, dr = r.rssMB / b.rssMB - 1
    delta = num((dm * 100).toFixed(0) + '%', 9) + num((dr * 100).toFixed(0) + '%', 9)
    if (dm > tolerance || dr > tolerance) { delta += '  OVER BUDGET'; failed = true }
  }
  console.log(pad(r.name, 32) + num(r.bytes, 9) + num(r.ms, 9) + num(r.rssMB, 9) + delta)
}
process.exit(failed ? 1 : 0)
