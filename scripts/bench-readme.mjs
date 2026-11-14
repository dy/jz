#!/usr/bin/env node
// Regenerate the numeric data in bench/README.md from bench/results.json — ONE source of truth.
//
// The per-case tables and the aggregate geomean table drift easily: `npm run bench` rewrites
// results.json but never the prose doc, so its numbers rot. This refreshes every standard
// per-case table (median · ×v8 · size · parity) and the V8/AS rows of the aggregate table
// IN PLACE — preserving each row's label, order, and the bold on the jz row. In the prose it
// rewrites only the figures marked `<!-- fig:KEY -->…<!-- /fig -->` (README.md, the landing
// index.html: FIGURES below); --check also emits a best-effort prose-ratio drift warning for
// the human/CI. test:claims runs --check: a marked figure the dataset does not give fails it.
//
//   node scripts/bench-readme.mjs           # rewrite bench/README.md and the marked figures in place
//   node scripts/bench-readme.mjs --check   # report drift, exit 1 if any (no write)
//
// NB: regenerate FROM the committed results.json. Do NOT `npm run bench` to refresh when zig/go
// aren't installed — that silently drops their columns and degrades the snapshot.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { correctBenchmarkRow, figure, newerDataset, timedBenchmarkRow } from '../assets/headline.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RESULTS = process.env.JZ_BENCH_RESULTS_JSON || join(ROOT, 'bench', 'results.json')
const README = process.env.JZ_BENCH_README || join(ROOT, 'bench', 'README.md')
const check = process.argv.includes('--check')

const r = JSON.parse(readFileSync(RESULTS, 'utf8'))
const C = r.cases

// label substring → results.json target id (first match wins; order matters)
const LABELS = [
  [/hand-WAT|wat2wasm/i, 'wat'],
  [/\bjz\b/i, 'jz'],
  [/V8 \(node\)|raw JS/i, 'v8'],
  [/AssemblyScript/i, 'as'],
  [/native C|clang/i, 'nat'],
  [/Rust/i, 'rust'],
  [/Zig/i, 'zig'],
  [/\bGo\b/i, 'go'],
  [/NumPy/i, 'numpy'],
  [/Porffor/i, 'porf-native'],
]
const targetOf = (label) => LABELS.find(([re]) => re.test(label))?.[1] ?? null

const fmtMs = (us) => (us / 1000).toFixed(2) + ' ms'
const fmtBytes = (b) => b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} kB`
const fmtX = (n) => n == null ? '–' : n.toFixed(2) + '×'
const geomean = (a) => a.length ? Math.exp(a.reduce((s, x) => s + Math.log(x), 0) / a.length) : null

const warnings = []
let changed = false

// ── per-case standard tables ──────────────────────────────────────────────
const STD_HEADER = '| target | median | ×v8 | size | parity |'
const lines = readFileSync(README, 'utf8').split('\n')
const out = []
let curCase = null
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  const h = line.match(/^###\s+([A-Za-z0-9_-]+)\s+[\u2013\u2014]/)
  if (h) { curCase = h[1]; out.push(line); continue }

  if (line.trim() === STD_HEADER && lines[i + 1]?.trim().startsWith('| ---')) {
    out.push(line, lines[i + 1])                 // header + separator: unchanged
    const tcase = C[curCase]
    const v8 = tcase?.targets?.v8
    const v8us = timedBenchmarkRow(v8) ? v8.medianUs : null
    let j = i + 2
    for (; j < lines.length && lines[j].trim().startsWith('|'); j++) {
      const row = lines[j]
      const cells = row.split('|').map((s) => s.trim())   // ['', label, median, ×v8, size, parity, '']
      const label = cells[1]
      const tid = targetOf(label)
      const t = tid ? tcase?.targets?.[tid] : null
      const bold = tid === 'jz' || /\*\*/.test(cells[2])
      const wrap = (s) => (bold ? `**${s}**` : s)
      if (t?.status === 'fail' || (t?.status != null && t.medianUs == null)) {
        const statusRow = `| ${label} | ${wrap('–')} | ${wrap('–')} | ${wrap('–')} | ${wrap(t.status)} |`
        if (statusRow !== row) changed = true
        out.push(statusRow)
        continue
      }
      if (!t || t.medianUs == null) {                     // not in this run → keep verbatim (earlier-run reference, per the doc note); warn
        out.push(row)
        if (curCase && tid) warnings.push(`${curCase}: "${label}" (${tid}) not in results.json; kept as earlier-run reference`)
        continue
      }
      const x = v8us && timedBenchmarkRow(t) ? fmtX(v8us / t.medianUs) : '–'
      const classification = t.status || t.parity || 'unclassified'
      const newRow = `| ${label} | ${wrap(fmtMs(t.medianUs))} | ${wrap(x)} | ${wrap(t.bytes != null ? fmtBytes(t.bytes) : '–')} | ${wrap(classification)} |`
      if (newRow !== row) changed = true
      out.push(newRow)
    }
    i = j - 1
    continue
  }
  out.push(line)
}
let text = out.join('\n')

// ── aggregate geomean table (V8 + AssemblyScript rows; Porffor needs its own subset, left alone) ──
const okCases = Object.keys(C).filter((c) => correctBenchmarkRow(C[c].targets?.jz))
const ratios = (t, metric) => okCases.map((c) => {
  const jz = C[c].targets.jz, o = C[c].targets[t]
  if (!correctBenchmarkRow(o)) return null
  return metric === 'speed'
    ? (timedBenchmarkRow(jz) && timedBenchmarkRow(o) ? jz.medianUs / o.medianUs : null)
    : (jz.bytes && o.bytes ? jz.bytes / o.bytes : null)
}).filter((x) => x != null)

const aggV8 = `| V8 (node) | **${fmtX(geomean(ratios('v8', 'speed')))}** | – |`
const aggAS = `| AssemblyScript | **${fmtX(geomean(ratios('as', 'speed')))}** | **${fmtX(geomean(ratios('as', 'size')))}** |`
for (const [re, repl] of [[/^\| V8 \(node\) \| .*\| [\u2013\u2014] \|$/m, aggV8], [/^\| AssemblyScript \| [^(]*\|.*\|$/m, aggAS]]) {
  if (re.test(text) && text.match(re)[0] !== repl) { text = text.replace(re, repl); changed = true }
}

// ── best-effort prose drift warning (does NOT auto-edit prose) ──
for (const c of Object.keys(C)) {
  const t = C[c]?.targets, jz = t?.jz?.medianUs, v8 = t?.v8?.medianUs
  if (!timedBenchmarkRow(t?.jz) || !timedBenchmarkRow(t?.v8)) continue
  const sec = text.split(new RegExp(`### ${c} [\\u2013\\u2014]`))[1]?.split('\n### ')[0]
  if (!sec) continue
  const m = sec.match(/jz (?:is ([\d.]+)× faster|beats V8(?: raw JS)? by ([\d.]+)×)/)   // "faster"/"beats", not "slower"
  const proseX = m ? parseFloat(m[1] || m[2]) : null
  if (proseX && Math.abs(proseX - v8 / jz) / (v8 / jz) > 0.1)
    warnings.push(`${c}: prose says ${m[1] || m[2]}× vs V8 but table is ${(v8 / jz).toFixed(2)}× — update the sentence`)
}

if (warnings.length) { console.error('warnings:'); for (const w of warnings) console.error('  • ' + w) }

// ── figures in the prose: `<!-- fig:KEY -->VALUE<!-- /fig -->` in README.md and the landing,
//    each KEY one figure by assets/headline.js `figure` of the dataset the landing's live cells
//    and the bench page's plain view read (headline.js newerDataset: the newer of results.json
//    and results-ci.json), so a prefilled cell is the figure it turns into. A key that dataset
//    cannot give writes a dash. ──
const CI = process.env.JZ_BENCH_RESULTS_CI_JSON || join(ROOT, 'bench', 'results-ci.json')
const ci = existsSync(CI) ? JSON.parse(readFileSync(CI, 'utf8')) : null
const d = newerDataset(r, ci) === 'ci' ? ci : r
const x2 = v => v > 0 ? `${v.toFixed(2)}×` : '–'
const xi = v => v > 0 ? `${Math.round(v)}×` : '–'
const asBytes = Object.values(d.cases).filter(c => correctBenchmarkRow(c.targets?.jz) && correctBenchmarkRow(c.targets?.as) && c.targets.jz.bytes > 0 && c.targets.as.bytes > 0)
  .map(c => c.targets.jz.bytes / c.targets.as.bytes)
const FIGURES = {
  'v8-speed': () => x2(figure(d, 'speed', 'v8')),
  'as-speed': () => x2(figure(d, 'speed', 'as')),
  'nat-speed': () => x2(figure(d, 'speed', 'nat')),
  'porf-memory': () => x2(figure(d, 'memory', 'porf-native', 'jz-w2c')),
  'as-size': () => x2(figure(d, 'size', 'as')),
  'as-size-geomean': () => x2(geomean(asBytes)),
  'as-size-cases': () => String(asBytes.length),
  'scriptc-speed': () => xi(figure(d, 'speed', 'scriptc')),
  'shermes-speed': () => xi(figure(d, 'speed', 'shermes')),
}
// (a run on another README, a test's, touches no other doc unless JZ_FIG_DOCS names it; a doc absent is passed over)
const FIG_DOCS = (process.env.JZ_FIG_DOCS ?? (process.env.JZ_BENCH_README ? '' : 'README.md,index.html')).split(',').filter(Boolean)
  .map(f => f.startsWith('/') ? f : join(ROOT, f)).filter(f => existsSync(f))
const FIG = /<!-- fig:([\w-]+) -->([\s\S]*?)<!-- \/fig -->/g
const stale = [], figText = new Map()
for (const doc of FIG_DOCS) {
  const src = readFileSync(doc, 'utf8')
  const out = src.replace(FIG, (all, key, was) => {
    if (!FIGURES[key]) { stale.push(`${doc}: unknown figure '${key}'`); return all }
    const now = FIGURES[key]()
    if (now !== was) stale.push(`${doc}: ${key} reads ${was}, the dataset gives ${now}`)
    return `<!-- fig:${key} -->${now}<!-- /fig -->`
  })
  figText.set(doc, out)
}
for (const s of stale) console.error('  • ' + s)

if (check) {
  console.log(changed ? '✗ bench/README.md tables are STALE vs results.json — run `npm run bench:readme`' : '✓ bench/README.md tables match results.json')
  console.log(stale.length ? `✗ ${stale.length} figure(s) in the prose are STALE vs results.json — run \`npm run bench:readme\`` : `✓ the prose's figures match results.json (${FIG_DOCS.map(d => d.slice(ROOT.length + 1) || d).join(', ')})`)
  process.exit(changed || stale.length ? 1 : 0)
}
writeFileSync(README, text)
for (const [doc, out] of figText) writeFileSync(doc, out)
console.log(changed ? '✓ regenerated bench/README.md tables from results.json' : '✓ bench/README.md already current')
console.log(stale.length ? `✓ rewrote ${stale.length} figure(s) in the prose from results.json` : '✓ the prose\'s figures already current')
