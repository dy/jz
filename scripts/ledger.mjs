#!/usr/bin/env node
// The speed ledger: one line per measured run in bench/ledger.jsonl, so a case's
// history on each machine is read, never retold.
//
//   ledger.mjs pull <run-id>           download a CI run's bench JSON and add it
//   ledger.mjs add <bench.json> [--run=<label>] [--kind=reference|probe|ab|local]
//   ledger.mjs status [--cpu=<text>]   every case's worst claim ratio per machine
//   ledger.mjs show <case> [--cpu=<text>]   one case's history against each rival
//   ledger.mjs diff <run> <run> [--min=<percent>]   what moved between two runs of one machine
//
// A row is evidence for the machine it names and no other. A run with `jz-base`
// rows is an A/B: both compilers measured in alternating rounds on one machine.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLAIM_CLASSES, WASM_BAND_TOL } from '../bench/claims.mjs'
import { MEMORY_CASES } from '../test/_memory-floor.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LEDGER = process.env.JZ_LEDGER || join(ROOT, 'bench/ledger.jsonl')

const timed = t => t && t.status !== 'fail' && t.parity === 'ok' && t.medianUs > 0
const rows = () => existsSync(LEDGER)
  ? readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  : []
const flag = (args, name) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)

/** A bench JSON as one ledger row: valid timings, the memory cases' RSS, jz/as bytes. */
const rowOf = (bench, run, kind) => {
  const cases = {}
  for (const [id, c] of Object.entries(bench.cases)) {
    const us = {}, entry = { us }
    for (const [tid, t] of Object.entries(c.targets || {})) if (timed(t)) us[tid] = t.medianUs
    if (!Object.keys(us).length) continue
    if (MEMORY_CASES.includes(id)) {
      const kb = {}
      for (const tid of ['jz', 'v8']) if (c.targets[tid]?.memKb > 0) kb[tid] = Math.round(c.targets[tid].memKb)
      if (Object.keys(kb).length) entry.kb = kb
    }
    const bytes = {}
    for (const tid of ['jz', 'jz-base', 'as']) if (c.targets[tid]?.bytes > 0 && c.targets[tid].parity === 'ok') bytes[tid] = c.targets[tid].bytes
    if (Object.keys(bytes).length) entry.bytes = bytes
    cases[id] = entry
  }
  const m = bench.meta
  return {
    run, kind: kind || (m.base ? 'ab' : Object.keys(cases).length >= 50 ? 'reference' : 'probe'),
    date: m.date, commit: m.commit, ...(m.base && { base: m.base }),
    cpu: m.host?.cpu ?? null, os: m.host?.platform ?? null,
    versions: { watr: m.versions?.watr, node: m.versions?.node },
    ...(m.machineState?.swapUsedMB != null && { swapMB: Math.round(m.machineState.swapUsedMB) }),
    ...(m.machineState?.load1 != null && { load: +m.machineState.load1.toFixed(1) }),
    cases,
  }
}

const add = (file, run, kind) => {
  const row = rowOf(JSON.parse(readFileSync(file, 'utf8')), run, kind)
  if (!row.commit || !row.cpu) throw Error(`${file}: no commit or CPU in meta`)
  if (rows().some(r => String(r.run) === String(row.run))) throw Error(`run ${row.run} is already in the ledger`)
  appendFileSync(LEDGER, JSON.stringify(row) + '\n')
  console.log(`added ${row.kind} ${row.run}: ${row.commit}${row.base ? ` vs ${row.base}` : ''} on ${row.cpu}, ${Object.keys(row.cases).length} cases`)
}

const findJson = dir => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { const f = findJson(p); if (f) return f }
    else if (name === 'reference.json' || name === 'probe.json') return p
  }
  return null
}

/** The worst ratio a claim class holds against jz on one case: [ratio, rival]. */
const worst = (us, rivals) => {
  let best = null
  if (!(us?.jz > 0)) return best
  for (const r of rivals) if (us[r] > 0 && (!best || us.jz / us[r] > best[0])) best = [us.jz / us[r], r]
  return best
}
const claimWorst = (id, us) => {
  let best = null
  for (const [, rivals, exempt] of CLAIM_CLASSES) {
    if (exempt.includes(id)) continue
    const w = worst(us, rivals)
    if (w && (!best || w[0] > best[0])) best = w
  }
  return best
}
const mark = r => r < 1 ? ' ' : r <= WASM_BAND_TOL ? '~' : '!'
const cell = w => w ? `${w[0].toFixed(3)}${mark(w[0])} ${w[1]}` : '-'
const shortCpu = cpu => cpu.replace(/^(AMD|Intel\(R\)|Apple) /, '').replace(/ \d+-Core Processor$/, '')
const byCpu = (all, want) => {
  const m = new Map()
  for (const r of all) {
    if (want && !r.cpu.toLowerCase().includes(want.toLowerCase())) continue
    ;(m.get(r.cpu) ?? m.set(r.cpu, []).get(r.cpu)).push(r)
  }
  return m
}

const status = cpuWant => {
  // The claim verdict needs the whole corpus: the latest two full runs per machine.
  const groups = byCpu(rows().filter(r => Object.keys(r.cases).length >= 50), cpuWant)
  if (!groups.size) return console.log('no full-corpus run in the ledger')
  const cols = [...groups].map(([cpu, rs]) => ({ cpu, prev: rs[rs.length - 2], last: rs[rs.length - 1] }))
  console.log(`worst jz/rival ratio over the claim classes; ! loss, ~ tie within ${WASM_BAND_TOL}, blank lead\n`)
  console.log('case'.padEnd(12) + cols.map(c => `${shortCpu(c.cpu)}  ${c.prev ? c.prev.commit + ' → ' : ''}${c.last.commit}`.padEnd(44)).join(''))
  const ids = new Set(cols.flatMap(c => Object.keys(c.last.cases)))
  const lines = []
  for (const id of ids) {
    const ws = cols.map(c => [c.prev && claimWorst(id, c.prev.cases[id]?.us), claimWorst(id, c.last.cases[id]?.us)])
    const top = Math.max(...ws.map(([, w]) => w ? w[0] : 0))
    lines.push([top, id.padEnd(12) + ws.map(([p, w]) => `${p ? cell(p) + ' → ' : ''}${cell(w)}`.padEnd(44)).join('')])
  }
  lines.sort((a, b) => b[0] - a[0])
  for (const [top, line] of lines) if (top >= 1) console.log(line)
  console.log(`\n${lines.filter(l => l[0] < 1).length} of ${lines.length} cases lead on every machine listed`)
  for (const c of cols) {
    const open = Object.keys(c.last.cases).filter(id => (claimWorst(id, c.last.cases[id].us)?.[0] ?? 0) >= 1)
    const mem = MEMORY_CASES.map(id => [id, c.last.cases[id]?.kb]).filter(([, kb]) => kb?.jz && kb?.v8)
      .map(([id, kb]) => `${id} ${(kb.jz / kb.v8).toFixed(3)}${mark(kb.jz / kb.v8)}`)
    console.log(`${shortCpu(c.cpu)} @ ${c.last.commit}: ${open.length} open; peak RSS jz/v8 ${mem.join(', ') || '-'}`)
  }
}

const show = (id, cpuWant) => {
  const groups = byCpu(rows().filter(r => r.cases[id]), cpuWant)
  if (!groups.size) return console.log(`no row holds ${id}`)
  for (const [cpu, rs] of groups) {
    const rivals = [...new Set(rs.flatMap(r => Object.keys(r.cases[id].us)))].filter(t => t !== 'jz')
    console.log(`\n${id} on ${cpu}`)
    console.log('run'.padEnd(15) + 'kind'.padEnd(11) + 'commit'.padEnd(10) + 'load'.padStart(5) + 'jz µs'.padStart(8) + rivals.map(t => t.slice(0, 9).padStart(10)).join(''))
    for (const r of rs) {
      const us = r.cases[id].us
      console.log(String(r.run).padEnd(15) + r.kind.padEnd(11) + r.commit.padEnd(10) + String(r.load ?? '-').padStart(5) + String(us.jz ?? '-').padStart(8) +
        rivals.map(t => (us.jz > 0 && us[t] > 0 ? (us.jz / us[t]).toFixed(3) + mark(us.jz / us[t]) : '-').padStart(10)).join(''))
    }
  }
}

const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN }

/** jz's change between two runs of one machine, beside the rivals' median change on
 *  the same case: the rivals did not change, so their drift is the machine's. */
const diff = (a, b, min) => {
  const all = rows(), A = all.find(r => String(r.run) === a), B = all.find(r => String(r.run) === b)
  if (!A || !B) return console.log('no such run')
  if (A.cpu !== B.cpu) return console.log(`different machines: ${A.cpu} / ${B.cpu}`)
  console.log(`${shortCpu(A.cpu)}: ${A.commit} → ${B.commit}; jz change net of the rivals' drift, |change| ≥ ${min}%\n`)
  console.log('case'.padEnd(12) + 'jz µs'.padStart(16) + 'jz'.padStart(9) + 'rivals'.padStart(9) + 'net'.padStart(9))
  const out = []
  for (const [id, c] of Object.entries(B.cases)) {
    const p = A.cases[id]
    if (!p || !(p.us.jz > 0) || !(c.us.jz > 0)) continue
    const drift = median(Object.keys(c.us).filter(t => t !== 'jz' && t !== 'jz-base' && t !== 'jz-w2c' && p.us[t] > 0).map(t => c.us[t] / p.us[t]))
    const own = c.us.jz / p.us.jz, net = own / (drift || 1)
    if (Math.abs(net - 1) * 100 >= min) out.push([net, id.padEnd(12) + `${p.us.jz} → ${c.us.jz}`.padStart(16) +
      pct(own).padStart(9) + pct(drift).padStart(9) + pct(net).padStart(9)])
  }
  out.sort((x, y) => x[0] - y[0])
  for (const [, line] of out) console.log(line)
  if (!out.length) console.log('nothing moved')
}
const pct = r => Number.isFinite(r) ? `${r >= 1 ? '+' : ''}${((r - 1) * 100).toFixed(1)}%` : '-'

const [cmd, ...args] = process.argv.slice(2)
const pos = args.filter(a => !a.startsWith('--'))
if (cmd === 'add' && pos[0]) add(pos[0], flag(args, 'run') ?? `local-${Date.now()}`, flag(args, 'kind'))
else if (cmd === 'pull' && pos[0]) {
  const dir = mkdtempSync(join(tmpdir(), 'jz-ledger-'))
  execFileSync('gh', ['run', 'download', pos[0], '-D', dir], { cwd: ROOT, stdio: 'inherit' })
  const file = findJson(dir)
  if (!file) throw Error(`run ${pos[0]} holds no reference.json or probe.json`)
  add(file, +pos[0], flag(args, 'kind'))
}
else if (cmd === 'status') status(flag(args, 'cpu'))
else if (cmd === 'show' && pos[0]) show(pos[0], flag(args, 'cpu'))
else if (cmd === 'diff' && pos[1]) diff(pos[0], pos[1], +(flag(args, 'min') ?? 2))
else console.log('usage: ledger.mjs pull <run-id> | add <bench.json> [--run=] [--kind=] | status [--cpu=] | show <case> [--cpu=] | diff <run> <run> [--min=]')
