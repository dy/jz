#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '../index.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BENCH = join(ROOT, 'bench')
const LIB = join(BENCH, '_lib')

const args = process.argv.slice(2)
const itersArg = args.find(a => a.startsWith('--iters='))
const iters = Math.max(1, Number(itersArg?.slice(8) || process.env.JZ_COMPILE_BENCH_ITERS || 5))
const requested = args.filter(a => !a.startsWith('--'))

const median = xs => {
  const a = [...xs].sort((x, y) => x - y)
  return a[a.length >> 1]
}

const fmt = n => n == null ? 'n/a' : n.toFixed(2)

const benchlibHostSource = () => {
  const src = readFileSync(join(LIB, 'benchlib.js'), 'utf8')
  const out = src.replace(`export let printResult = (medianUs, checksum, samples, stages, runs) => {
  console.log(\`median_us=\${medianUs} checksum=\${checksum} samples=\${samples} stages=\${stages} runs=\${runs}\`)
}`, `export let printResult = (medianUs, checksum, samples, stages, runs) => {
  env.logResult(medianUs, checksum, samples, stages, runs)
}`)
  if (out === src) throw Error('failed to patch benchlib printResult')
  return out
}

const watrModuleSources = () => ({
  './watr-compile.js': `import compileWatr from '../../node_modules/watr/src/compile.js'\nexport const compile = (src) => compileWatr(src)\n`,
  '../../node_modules/watr/src/compile.js': readFileSync(join(ROOT, 'node_modules/watr/src/compile.js'), 'utf8'),
  './encode.js': readFileSync(join(ROOT, 'node_modules/watr/src/encode.js'), 'utf8'),
  './const.js': readFileSync(join(ROOT, 'node_modules/watr/src/const.js'), 'utf8'),
  './parse.js': readFileSync(join(ROOT, 'node_modules/watr/src/parse.js'), 'utf8'),
  './util.js': readFileSync(join(ROOT, 'node_modules/watr/src/util.js'), 'utf8'),
})

const cases = readdirSync(BENCH, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('_') && existsSync(join(BENCH, d.name, `${d.name}.js`)))
  .map(d => d.name)
  .sort()

const selected = requested.length ? requested : cases
const benchlib = benchlibHostSource()

const optionsFor = id => ({
  modules: {
    '../_lib/benchlib.js': benchlib,
    ...(id === 'watr' ? watrModuleSources() : {}),
  },
  imports: {
    env: { logResult: { params: 5 } },
    performance: { now: { params: 0, returns: 'number' } },
  },
  optimize: { smallConstForUnroll: false, scalarTypedArrayLen: 8 },
  ...(id === 'watr' ? {
    jzify: true,
    memory: 4096,
    optimize: { watr: false, smallConstForUnroll: false },
  } : {}),
  alloc: false,
})

const runOnce = (id) => {
  const code = readFileSync(join(BENCH, id, `${id}.js`), 'utf8')
  const profile = {}
  const wasm = compile(code, { ...optionsFor(id), profile })
  const t = profile.totals || {}
  const plan = t.plan || 0
  const compileTotal = t.compile || 0
  return {
    total: (t.parse || 0) + (t.jzify || 0) + (t.prepare || 0) + compileTotal +
      (t.watrOptimize || 0) + (t.watrReopt || 0) + (t.watrPrint || 0) + (t.watrCompile || 0),
    parse: t.parse || 0,
    prepare: t.prepare || 0,
    plan,
    emit: Math.max(0, compileTotal - plan),
    watr: (t.watrOptimize || 0) + (t.watrReopt || 0) + (t.watrPrint || 0) + (t.watrCompile || 0),
    bytes: wasm.byteLength ?? Buffer.byteLength(wasm),
  }
}

console.log(`compile phase timing, iters=${iters}`)
console.log('case          first   median   parse prepare   plan   emit   watr   bytes')
for (const id of selected) {
  if (!cases.includes(id)) throw Error(`unknown benchmark case: ${id}`)
  const runs = []
  for (let i = 0; i < iters; i++) runs.push(runOnce(id))
  const med = key => median(runs.map(r => r[key]))
  console.log(
    `${id.padEnd(12)} ${fmt(runs[0].total).padStart(7)} ${fmt(med('total')).padStart(8)}` +
    `${fmt(med('parse')).padStart(8)}${fmt(med('prepare')).padStart(8)}` +
    `${fmt(med('plan')).padStart(7)}${fmt(med('emit')).padStart(7)}` +
    `${fmt(med('watr')).padStart(7)}${String(Math.round(med('bytes'))).padStart(8)}`
  )
}
