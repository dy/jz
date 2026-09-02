#!/usr/bin/env node
// Library census: compile real programs and report what it cost.
//
//   node scripts/library-census.mjs <entry.js>... [--json]
//
// Per entry: status, wasm bytes, compile time, export lanes (f64 numeric slots
// against i64 dynamic ones), realized runtime functions, and warning counts by
// code. A failure prints the first error line. This is the v1 gate for "real
// programs" (PLAN.md): every class it surfaces gets a fix or a documented
// rejection.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { compile } from '../index.js'
import { resolveModuleGraph } from '../src/resolve.js'

const args = process.argv.slice(2)
const json = args.includes('--json')
const entries = args.filter(a => !a.startsWith('--'))
if (!entries.length) {
  console.error('usage: node scripts/library-census.mjs <entry.js>... [--json]')
  process.exit(2)
}

const customSection = (bytes, name) => {
  const s = WebAssembly.Module.customSections(new WebAssembly.Module(bytes), name)
  return s.length ? JSON.parse(new TextDecoder().decode(s[0])) : null
}

const census = (entry) => {
  const path = resolve(entry)
  const row = { entry, status: 'ok' }
  let graph
  try {
    graph = resolveModuleGraph(path, { resolveNode: true })
  } catch (e) {
    return { ...row, status: 'resolve', error: String(e.message).split('\n')[0] }
  }
  row.modules = 1 + Object.keys(graph.modules).length
  row.sourceBytes = graph.code.length + Object.values(graph.modules).reduce((n, s) => n + s.length, 0)
  const warnings = {}
  const t = performance.now()
  let bytes
  try {
    bytes = compile(graph.code, { modules: graph.modules, optimize: 2, warnings, whyNotSimd: true })
  } catch (e) {
    return { ...row, status: 'compile', ms: +(performance.now() - t).toFixed(1), error: String(e.message).split('\n')[0].slice(0, 160) }
  }
  row.ms = +(performance.now() - t).toFixed(1)
  row.bytes = bytes.length
  try {
    const mod = new WebAssembly.Module(bytes)
    const exports = WebAssembly.Module.exports(mod).filter(e => e.kind === 'function')
    const lanes = customSection(bytes, 'jz:i64exp') ?? []
    let dyn = 0, boxedResults = 0
    for (const e of lanes) { dyn += e.p?.length ?? 0; if (e.r || e.m) boxedResults++ }
    row.exports = exports.length
    row.dynamicParams = dyn
    row.boxedResults = boxedResults
  } catch (e) {
    row.status = 'invalid'
    row.error = String(e.message).split('\n')[0].slice(0, 160)
  }
  try {
    const wat = compile(graph.code, { modules: graph.modules, optimize: 2, wat: true })
    const names = [...wat.matchAll(/\(func \$([^\s)]+)/g)].map(m => m[1])
    row.functions = names.length
    row.runtimeFunctions = names.filter(n => n.startsWith('__') || n.includes('.')).length
  } catch {}
  const byCode = {}
  for (const w of warnings.entries ?? []) byCode[w.code] = (byCode[w.code] || 0) + 1
  row.warnings = byCode
  return row
}

const rows = entries.map(census)
if (json) { console.log(JSON.stringify(rows, null, 2)); process.exit(0) }

const pad = (s, n) => String(s).padEnd(n)
const num = (s, n) => String(s ?? '').padStart(n)
console.log(pad('entry', 44) + pad('status', 9) + num('src B', 8) + num('wasm B', 8) + num('ms', 7) + num('exp', 5) + num('dyn', 5) + num('box', 5) + num('fn', 5) + num('rt', 5) + '  warnings')
for (const r of rows) {
  const warn = Object.entries(r.warnings ?? {}).map(([k, v]) => `${k}:${v}`).join(' ')
  console.log(pad(r.entry.slice(-43), 44) + pad(r.status, 9) + num(r.sourceBytes, 8) + num(r.bytes, 8) + num(r.ms, 7) + num(r.exports, 5) + num(r.dynamicParams, 5) + num(r.boxedResults, 5) + num(r.functions, 5) + num(r.runtimeFunctions, 5) + '  ' + (r.error ? r.error : warn))
}
