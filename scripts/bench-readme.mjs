#!/usr/bin/env node
// Regenerate the numeric data in bench/README.md from bench/results.json — ONE source of truth.
//
// The per-case tables and the aggregate geomean table drift easily: `npm run bench` rewrites
// results.json but never the prose doc, so its numbers rot. This refreshes every standard
// per-case table (median · ×v8 · size · parity) and the V8/AS rows of the aggregate table
// IN PLACE — preserving each row's label, order, and the bold on the jz row. It does NOT
// rewrite prose; --check emits a best-effort prose-ratio drift warning for the human/CI.
//
//   node scripts/bench-readme.mjs           # rewrite bench/README.md in place
//   node scripts/bench-readme.mjs --check   # report drift, exit 1 if any (no write)
//
// NB: regenerate FROM the committed results.json. Do NOT `npm run bench` to refresh when zig/go
// aren't installed — that silently drops their columns and degrades the snapshot.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RESULTS = join(ROOT, 'bench', 'results.json')
const README = join(ROOT, 'bench', 'README.md')
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
  [/Porffor/i, 'porf'],
]
const targetOf = (label) => LABELS.find(([re]) => re.test(label))?.[1] ?? null

const fmtMs = (us) => (us / 1000).toFixed(2) + ' ms'
const fmtBytes = (b) => b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} kB`
const fmtX = (n) => n.toFixed(2) + '×'
const geomean = (a) => Math.exp(a.reduce((s, x) => s + Math.log(x), 0) / a.length)

const warnings = []
let changed = false

// ── per-case standard tables ──────────────────────────────────────────────
const STD_HEADER = '| target | median | ×v8 | size | parity |'
const lines = readFileSync(README, 'utf8').split('\n')
const out = []
let curCase = null
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  const h = line.match(/^###\s+([A-Za-z0-9_-]+)\s+—/)
  if (h) { curCase = h[1]; out.push(line); continue }

  if (line.trim() === STD_HEADER && lines[i + 1]?.trim().startsWith('| ---')) {
    out.push(line, lines[i + 1])                 // header + separator: unchanged
    const tcase = C[curCase]
    const v8us = tcase?.targets?.v8?.medianUs
    let j = i + 2
    for (; j < lines.length && lines[j].trim().startsWith('|'); j++) {
      const row = lines[j]
      const cells = row.split('|').map((s) => s.trim())   // ['', label, median, ×v8, size, parity, '']
      const label = cells[1]
      const tid = targetOf(label)
      const t = tid ? tcase?.targets?.[tid] : null
      if (!t || t.medianUs == null) {                     // not in this run → keep verbatim (earlier-run reference, per the doc note); warn
        out.push(row)
        if (curCase && tid) warnings.push(`${curCase}: "${label}" (${tid}) not in results.json — kept as earlier-run reference`)
        continue
      }
      const bold = tid === 'jz' || /\*\*/.test(cells[2])
      const wrap = (s) => (bold ? `**${s}**` : s)
      const x = v8us ? fmtX(v8us / t.medianUs) : '—'
      const newRow = `| ${label} | ${wrap(fmtMs(t.medianUs))} | ${wrap(x)} | ${wrap(t.bytes != null ? fmtBytes(t.bytes) : '—')} | ${wrap(t.parity || 'ok')} |`
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
const okCases = Object.keys(C).filter((c) => C[c].targets?.jz?.parity === 'ok')
const ratios = (t, metric) => okCases.map((c) => {
  const jz = C[c].targets.jz, o = C[c].targets[t]
  if (!o) return null
  return metric === 'speed'
    ? (jz.medianUs && o.medianUs ? jz.medianUs / o.medianUs : null)
    : (jz.bytes && o.bytes ? jz.bytes / o.bytes : null)
}).filter((x) => x != null)

const aggV8 = `| V8 (node) | **${fmtX(geomean(ratios('v8', 'speed')))}** | — |`
const aggAS = `| AssemblyScript | **${fmtX(geomean(ratios('as', 'speed')))}** | **${fmtX(geomean(ratios('as', 'size')))}** |`
for (const [re, repl] of [[/^\| V8 \(node\) \| .*\| — \|$/m, aggV8], [/^\| AssemblyScript \| [^(]*\|.*\|$/m, aggAS]]) {
  if (re.test(text) && text.match(re)[0] !== repl) { text = text.replace(re, repl); changed = true }
}

// ── best-effort prose drift warning (does NOT auto-edit prose) ──
for (const c of Object.keys(C)) {
  const t = C[c]?.targets, jz = t?.jz?.medianUs, v8 = t?.v8?.medianUs
  if (!jz || !v8) continue
  const sec = text.split(`### ${c} —`)[1]?.split('\n### ')[0]
  if (!sec) continue
  const m = sec.match(/jz (?:is ([\d.]+)× faster|beats V8(?: raw JS)? by ([\d.]+)×)/)   // "faster"/"beats", not "slower"
  const proseX = m ? parseFloat(m[1] || m[2]) : null
  if (proseX && Math.abs(proseX - v8 / jz) / (v8 / jz) > 0.1)
    warnings.push(`${c}: prose says ${m[1] || m[2]}× vs V8 but table is ${(v8 / jz).toFixed(2)}× — update the sentence`)
}

if (warnings.length) { console.error('warnings:'); for (const w of warnings) console.error('  • ' + w) }

if (check) {
  console.log(changed ? '✗ bench/README.md tables are STALE vs results.json — run `npm run bench:readme`' : '✓ bench/README.md tables match results.json')
  process.exit(changed ? 1 : 0)
}
writeFileSync(README, text)
console.log(changed ? '✓ regenerated bench/README.md tables from results.json' : '✓ bench/README.md already current')
