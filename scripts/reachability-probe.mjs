#!/usr/bin/env node
/**
 * reachability-probe.mjs — ProgramIndex reachability soundness over the
 * refactor-oracle corpus.
 *
 * For every specimen compiled at O3, every user function that survives in
 * the optimized output must be reachable in ProgramIndex. An emitted but
 * index-unreachable function is a missing root or edge class, and gating
 * analysis or emission on that index would drop live code. This is the first
 * gate of the M4 reachability slice (the retired staged-migration record, "Immediate next
 * slice") and stays useful afterwards as the census-completeness pin.
 *
 *   node scripts/reachability-probe.mjs [--only <substring>] [--full]
 *
 * Exits 1 when any specimen reports an unsound function.
 */
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCorpus, loadRoot } from './refactor-oracle.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null
const full = args.includes('--full')

const { compile } = await loadRoot(ROOT)
const { ctx } = await import(pathToFileURL(join(ROOT, 'src/ctx.js')).href)
let specs = await buildCorpus(ROOT, { full })
if (only) specs = specs.filter(s => s.name.includes(only))

let unsoundTotal = 0, compiled = 0, failed = 0
for (const spec of specs) {
  let wat
  try { wat = String(compile(spec.code, { ...spec.opts, optimize: 3, wat: true })) }
  catch (e) { failed++; console.log(`  ${spec.name}: compile error (${String(e?.message || e).slice(0, 60)})`); continue }
  compiled++
  const index = ctx.plans.programIndex
  const emitted = new Set([...wat.matchAll(/\(func \$([^ )\n]+)/g)].map(m => m[1]))
  const unsound = []
  for (const func of ctx.funcs.list) {
    if (func.raw) continue
    const gid = index.graphFunctionIdOfName(func.name)
    if (gid >= 0 && !index.isGraphReachable(gid) && emitted.has(func.name)) unsound.push(func.name)
  }
  if (unsound.length) {
    unsoundTotal += unsound.length
    console.log(`  ${spec.name}: ${unsound.length} emitted but index-unreachable: ${unsound.slice(0, 6).join(', ')}${unsound.length > 6 ? ', …' : ''}`)
  }
}
console.log(`[reachability-probe] ${compiled} specimens compiled, ${failed} compile errors, ${unsoundTotal} unsound functions`)
process.exit(unsoundTotal ? 1 : 0)
