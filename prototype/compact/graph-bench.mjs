#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { compileWat } from './backend.js'
import { compileDirectAst } from './direct.js'
import { generateDirectCallGraph } from './graph-corpus.js'
import { lowerProgram } from './lower.js'
import { prepareCompactAst } from './prepare.js'
import {
  I_FN_REACHABLE,
  buildProgramIndex,
  functionCount,
} from './program-index.js'
import { parse } from '../../src/parse.js'

const SIZES = [128, 512, 2048]
const here = fileURLToPath(import.meta.url)
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const sameNumber = (a, b) => Object.is(a, b) || Number.isNaN(a) && Number.isNaN(b)

const memorySample = () => {
  globalThis.gc()
  globalThis.gc()
  const m = process.memoryUsage()
  return { heap: m.heapUsed, external: m.external, arrays: m.arrayBuffers, rss: m.rss }
}

const phaseRunner = (baseline, phases) => (name, fn) => {
  const start = performance.now()
  const value = fn()
  const elapsed = performance.now() - start
  const memory = memorySample()
  phases[name] = {
    ms: elapsed,
    heap: memory.heap,
    heapDelta: memory.heap - baseline.heap,
    external: memory.external,
    arrays: memory.arrays,
    rss: memory.rss,
  }
  return value
}

const treeStats = (root) => {
  const stack = [root]
  let arrays = 0, atoms = 0
  while (stack.length) {
    const node = stack.pop()
    if (!Array.isArray(node)) { atoms++; continue }
    arrays++
    for (let i = 1; i < node.length; i++) stack.push(node[i])
  }
  return { arrays, atoms, nodes: arrays + atoms }
}

const runWorker = (backend, count, compilerHash) => {
  if (typeof globalThis.gc !== 'function') throw new Error('graph worker requires --expose-gc')
  const graph = generateDirectCallGraph(count)
  let source = graph.source
  const sourceHash = sha256(source)
  const baseline = memorySample()
  const phases = {}
  const phase = phaseRunner(baseline, phases)
  let ast = phase('parse', () => parse(source))
  let prepared = null, index = null, wat = null, watStats = null
  let lowerMetrics = null
  let bytes

  if (backend === 'staged') {
    prepared = phase('prepare', () => prepareCompactAst(ast))
    index = phase('index', () => buildProgramIndex(prepared))
    if (functionCount(index) !== count) throw new Error(`index has ${functionCount(index)} functions, expected ${count}`)
    const reachable = index[I_FN_REACHABLE].reduce((sum, value) => sum + value, 0)
    if (reachable !== count) throw new Error(`index has ${reachable} reachable functions, expected ${count}`)
    lowerMetrics = {}
    wat = phase('lower', () => lowerProgram(index, lowerMetrics))
    watStats = treeStats(wat)
    bytes = phase('watr', () => compileWat(wat))
  } else if (backend === 'direct') {
    bytes = phase('direct', () => compileDirectAst(ast))
  } else {
    throw new Error(`unknown graph backend '${backend}'`)
  }

  let module = new WebAssembly.Module(bytes)
  let instance = new WebAssembly.Instance(module)
  const result = instance.exports[graph.exportName](...graph.args)
  if (!sameNumber(result, graph.expected)) throw new Error(`${backend}/${count}: got ${result}, expected ${graph.expected}`)
  if (WebAssembly.Module.exports(module).filter(item => item.kind === 'function').length !== 1)
    throw new Error(`${backend}/${count}: expected one function export`)

  const outputHash = sha256(bytes)
  const outputBytes = bytes.length
  const retainedWatHeap = backend === 'staged' ? phases.lower.heap - phases.index.heap : 0
  const phaseValues = Object.values(phases)
  const peakHeapDelta = Math.max(0, ...phaseValues.map(item => item.heapDelta))
  const peakRss = Math.max(baseline.rss, ...phaseValues.map(item => item.rss))
  const totalMs = phaseValues.reduce((sum, item) => sum + item.ms, 0)

  source = ast = prepared = index = wat = module = instance = null
  const outputOnly = memorySample()
  return {
    backend,
    count,
    compilerHash,
    sourceHash,
    outputHash,
    sourceBytes: graph.source.length,
    outputBytes,
    expected: graph.expected,
    result,
    phases,
    totalMs,
    baseline,
    peakHeapDelta,
    peakRss,
    retainedWatHeap,
    outputOnlyHeapDelta: outputOnly.heap - baseline.heap,
    wat: watStats,
    scratch: lowerMetrics,
  }
}

const compilerGraphHash = async (entry) => {
  const { resolveModuleGraph } = await import('../../src/resolve.js')
  const graph = resolveModuleGraph(fileURLToPath(new URL(entry, import.meta.url)), { resolveNode: true })
  const hash = createHash('sha256')
  hash.update(graph.code)
  const names = Object.keys(graph.modules).sort()
  for (const name of names) hash.update('\0').update(name).update('\0').update(graph.modules[name])
  return hash.digest('hex')
}

const slope = (rows, field) => {
  const meanX = rows.reduce((sum, row) => sum + row.count, 0) / rows.length
  const meanY = rows.reduce((sum, row) => sum + row[field], 0) / rows.length
  let numerator = 0, denominator = 0
  for (const row of rows) {
    const x = row.count - meanX
    numerator += x * (row[field] - meanY)
    denominator += x * x
  }
  return numerator / denominator
}

const formatBytes = (value) => {
  const sign = value < 0 ? '-' : ''
  value = Math.abs(value)
  if (value >= 1024 * 1024) return `${sign}${(value / (1024 * 1024)).toFixed(2)}M`
  if (value >= 1024) return `${sign}${(value / 1024).toFixed(1)}K`
  return `${sign}${Math.round(value)}B`
}

const printResults = (rows, hashes) => {
  console.log(`staged compiler hash: ${hashes.staged}`)
  console.log(`direct compiler hash: ${hashes.direct}`)
  console.log('worker stack: 8 MiB, required by the parser for the synthetic 2,048-declaration source')
  console.log('functions  backend    parse   prepare   index   lower/encode   watr    total   peak heap   WAT heap   output')
  console.log('-'.repeat(112))
  for (const row of rows) {
    const p = row.phases
    const lower = p.lower?.ms ?? p.direct?.ms ?? 0
    console.log(
      `${String(row.count).padStart(9)}  ${row.backend.padEnd(8)}` +
      `${(p.parse?.ms ?? 0).toFixed(2).padStart(8)}` +
      `${(p.prepare?.ms ?? 0).toFixed(2).padStart(10)}` +
      `${(p.index?.ms ?? 0).toFixed(2).padStart(8)}` +
      `${lower.toFixed(2).padStart(15)}` +
      `${(p.watr?.ms ?? 0).toFixed(2).padStart(8)}` +
      `${row.totalMs.toFixed(2).padStart(9)}` +
      `${formatBytes(row.peakHeapDelta).padStart(12)}` +
      `${formatBytes(row.retainedWatHeap).padStart(11)}` +
      `${formatBytes(row.outputBytes).padStart(9)}`,
    )
    console.log(`           source ${row.sourceHash.slice(0, 16)}  output ${row.outputHash.slice(0, 16)}  result ${row.result}`)
    if (row.scratch) console.log(`           max scratch ${row.scratch.maxScratchSlots} slot, ${row.scratch.maxControlDepth} control depth, ${row.scratch.maxTemporaryLocals} temps, ${row.scratch.maxLoopRangeFacts || 0} loop ranges, ${row.scratch.maxPointerTemps || 0} pointers, ${row.scratch.simdLoopCount || 0} SIMD loops, ${row.scratch.maxFunctionWatNodes} function WAT nodes`)
  }
  console.log('')
  for (const backend of ['staged', 'direct']) {
    const group = rows.filter(row => row.backend === backend)
    console.log(`${backend} slopes: ${formatBytes(slope(group, 'peakHeapDelta'))}/function retained peak, ${formatBytes(slope(group, 'outputBytes'))}/function output, ${slope(group, 'totalMs').toFixed(4)} ms/function`)
  }
  for (const count of SIZES) {
    const staged = rows.find(row => row.backend === 'staged' && row.count === count)
    const direct = rows.find(row => row.backend === 'direct' && row.count === count)
    console.log(`${count}: staged/direct peak ${(staged.peakHeapDelta / direct.peakHeapDelta).toFixed(2)}x, output ${(staged.outputBytes / direct.outputBytes).toFixed(3)}x, time ${(staged.totalMs / direct.totalMs).toFixed(2)}x`)
  }
}

const workerAt = process.argv.indexOf('--worker')
if (workerAt >= 0) {
  const backend = process.argv[workerAt + 1]
  const count = Number(process.argv[workerAt + 2])
  const compilerHash = process.argv[workerAt + 3]
  process.stdout.write(JSON.stringify(runWorker(backend, count, compilerHash)))
} else {
  const hashes = {
    staged: await compilerGraphHash('./compiler.js'),
    direct: await compilerGraphHash('./direct.js'),
  }
  const rows = []
  for (const count of SIZES) for (const backend of ['staged', 'direct']) {
    const child = spawnSync(process.execPath, ['--expose-gc', '--stack-size=8192', here, '--worker', backend, String(count), hashes[backend]], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
    if (child.status !== 0) {
      process.stderr.write(child.stdout)
      process.stderr.write(child.stderr)
      process.exit(child.status || 1)
    }
    rows.push(JSON.parse(child.stdout))
  }
  const jsonOutput = process.argv.includes('--json')
  if (jsonOutput) process.stdout.write(`${JSON.stringify({ hashes, rows }, null, 2)}\n`)
  else printResults(rows, hashes)

  if (process.platform === 'darwin') {
    const swap = execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' }).trim()
    const message = `machine swap: ${swap}; graph timings are directional until measured on an exclusive machine`
    if (jsonOutput) process.stderr.write(`${message}\n`)
    else console.log(message)
  }
}
