#!/usr/bin/env node
// why-census.mjs <case> [limit]: what the compiler declined on a bench case,
// as the advisories name it — every object layout the summary lost, in the
// order it lost them (the first is the root of a cascade), each property read
// left dynamic by function, and each class kept as closures. The case compiles
// as bench.mjs compiles it for the JS host, at the speed tier.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '../index.js'
import { resolveModuleGraph } from '../src/resolve.js'
import { GRAPH_CASES, graphSources } from '../bench/_lib/graph.js'

const [id, limit = '40'] = process.argv.slice(2)
if (!id) { console.error('usage: scripts/why-census.mjs <case> [limit]'); process.exit(2) }
const BENCH = resolve(fileURLToPath(import.meta.url), '../../bench'), LIB = join(BENCH, '_lib')
const c = { id, js: join(BENCH, id, `${id}.js`) }
const benchlib = readFileSync(join(LIB, 'benchlib.js'), 'utf8')
const watrSources = () => {
  const watr = resolve(BENCH, '../node_modules/watr/src'), read = (f) => readFileSync(join(watr, f), 'utf8')
  return { './watr-compile.js': `import compileWatr from '../../node_modules/watr/src/compile.js'\nexport const compile = (src) => compileWatr(src)\n`, '../../node_modules/watr/src/compile.js': read('compile.js'), './encode.js': read('encode.js'), './const.js': read('const.js'), './parse.js': read('parse.js'), './util.js': read('util.js') }
}
let code, modules, hostImports = {}
if (GRAPH_CASES.has(id)) {
  ;({ code, modules, imports: hostImports } = graphSources(c, resolveModuleGraph))
  modules[resolve(LIB, 'benchlib.js')] = benchlib
} else {
  code = readFileSync(c.js, 'utf8')
  modules = { '../_lib/benchlib.js': benchlib, ...(id === 'watr' ? watrSources() : {}) }
}
const warnings = { entries: [] }
compile(code, { jzify: GRAPH_CASES.has(id) || id === 'watr', modules, imports: { ...hostImports, env: { logResult: { params: 5 } }, performance: { now: { params: 0, returns: 'number' } } }, optimize: 'speed', alloc: false, warnings })
const by = (code) => warnings.entries.filter(e => e.code === code)
const fn = (e) => (e.fn ?? '?').replace(//g, '.').replace(/^m\d+_/, '')
const T = ''
const lost = by('shape-lost')
console.log(`${lost.length} layouts lost (the first ${Math.min(+limit, lost.length)}, in order):`)
for (const e of lost.slice(0, +limit)) console.log(`  ${String(e.sid).padStart(4)} ${fn(e).slice(0, 44).padEnd(44)} ${e.why}\n       ${e.message.replace(/^schema \d+ /, '').replace(/ is lost.*/, '')}${e.site ? '\n       at ' + e.site.replace(//g, '.').split(T).join('') : ''}`)
const reads = by('deopt-prop-read'), perFn = new Map()
for (const e of reads) perFn.set(fn(e), (perFn.get(fn(e)) ?? 0) + 1)
console.log(`\n${reads.length} property reads left dynamic, by function:`)
for (const [f, n] of [...perFn].sort((a, b) => b[1] - a[1]).slice(0, +limit)) console.log(`  ${String(n).padStart(4)} ${f}`)
const generic = by('class-generic')
console.log(`\n${generic.length} classes kept as closures:`)
for (const e of generic) console.log(`  ${e.message}`)
