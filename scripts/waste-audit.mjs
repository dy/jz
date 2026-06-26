#!/usr/bin/env node
// Corpus-wide loop-waste auditor — the "cover the cases we did not cover" engine.
//
// For every real bench kernel (numeric ones; graph/parser cases skipped) it
// compiles at optimize:'speed' with whyNotSimd, then reports, per kernel:
//   - simd-why-not   : loops the auto-vectorizer declined + the blocking op
//                      (a loop ONE op from SIMD is the highest-value uncovered case)
//   - deopt-*        : generic-dispatch / dynamic fallbacks actually emitted
//   - loop f64 ops   : f64 arithmetic left inside a loop body (lost i32 narrowing)
//   - loop trunc_sat : per-iteration f64->int truncation (index not carried i32)
//   - loop ptr calls : un-hoisted __ptr_*/__typed_idx inside a loop (lost LICM)
//   - loopOps        : total loop-body op count (the per-iteration cost proxy)
//
// Runtime-independent: pure codegen facts, so a fix that lowers these is faster on
// V8, JSC AND wasmtime/Cranelift alike. Usage: node scripts/waste-audit.mjs [--wat=case]
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '../index.js'
import parseWat from 'watr/parse'

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..'
const BENCH = join(ROOT, 'bench')
const LIB = join(BENCH, '_lib')

// Graph/parser cases need jzify + a module graph — not numeric SIMD targets.
const SKIP = new Set(['jessie', 'jz', 'watr', 'web'])

const cases = readdirSync(BENCH, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('_') && !SKIP.has(d.name) && existsSync(join(BENCH, d.name, `${d.name}.js`)))
  .map(d => d.name)

const benchlib = readFileSync(join(LIB, 'benchlib.js'), 'utf8')

// Count selected op shapes lexically INSIDE any (loop …).
const loopProfile = (wat) => {
  let ops = 0, f64 = 0, trunc = 0, ptr = 0
  const PTR = /^(call)$/
  const walk = (n, inLoop) => {
    if (!Array.isArray(n)) return
    const here = inLoop || n[0] === 'loop'
    const op = n[0]
    if (here && typeof op === 'string') {
      ops++
      if (op.startsWith('f64.') && !/\.(load|store|const)/.test(op)) f64++
      if (/trunc_sat_f64/.test(op)) trunc++
      if (op === 'call' && typeof n[1] === 'string' && /^\$__(ptr_|typed_idx|str_idx|len)/.test(n[1])) ptr++
    }
    for (let i = 1; i < n.length; i++) walk(n[i], here)
  }
  walk(parseWat(wat), false)
  return { ops, f64, trunc, ptr }
}

const only = process.argv.find(a => a.startsWith('--wat='))?.slice(6)

const rows = []
for (const id of cases) {
  if (only && id !== only) continue
  const src = readFileSync(join(BENCH, id, `${id}.js`), 'utf8')
  const warnings = { entries: [] }
  let wat
  try {
    wat = compile(src, {
      optimize: 'speed',
      whyNotSimd: true,
      warnings,
      wat: true,
      modules: { '../_lib/benchlib.js': benchlib },
    })
  } catch (e) {
    rows.push({ id, error: e.message.slice(0, 120) })
    continue
  }
  if (only) { console.log(wat); process.exit(0) }
  const prof = loopProfile(wat)
  const whyNot = warnings.entries.filter(w => w.code === 'simd-why-not')
  const deopt = warnings.entries.filter(w => /^deopt/.test(w.code || ''))
  rows.push({ id, ...prof, whyNot, deopt })
}

// Rank by uncovered-SIMD count, then by scalar waste (f64+trunc+ptr in loops).
rows.sort((a, b) => {
  if (a.error || b.error) return a.error ? 1 : -1
  const wa = (a.whyNot?.length || 0), wb = (b.whyNot?.length || 0)
  if (wb !== wa) return wb - wa
  return (b.f64 + b.trunc + b.ptr) - (a.f64 + a.trunc + a.ptr)
})

const pad = (s, n) => String(s).padEnd(n)
console.log(pad('kernel', 14), pad('loopOps', 8), pad('f64', 5), pad('trunc', 6), pad('ptrCall', 8), 'why-not-simd / deopt')
console.log('─'.repeat(90))
for (const r of rows) {
  if (r.error) { console.log(pad(r.id, 14), 'ERROR:', r.error); continue }
  const tags = []
  for (const w of r.whyNot) tags.push(`simd⊘[${w.op || w.detail || w.message?.match(/:\s*(.+)$/)?.[1] || '?'}]`)
  for (const d of r.deopt) tags.push(d.code)
  console.log(pad(r.id, 14), pad(r.ops, 8), pad(r.f64, 5), pad(r.trunc, 6), pad(r.ptr, 8), tags.join(' '))
}
console.log('─'.repeat(90))
const tot = rows.filter(r => !r.error)
console.log(`${tot.length} kernels · ${tot.reduce((n, r) => n + (r.whyNot?.length || 0), 0)} declined-SIMD loops · ` +
  `${tot.reduce((n, r) => n + r.f64, 0)} loop-f64 · ${tot.reduce((n, r) => n + r.trunc, 0)} loop-trunc · ` +
  `${tot.reduce((n, r) => n + r.ptr, 0)} loop-ptrcall`)
