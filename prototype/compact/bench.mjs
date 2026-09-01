#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { compile } from '../../index.js'
import { instantiate, toModule } from '../../interop.js'
import { resolveModuleGraph } from '../../src/resolve.js'
import { scalarCase } from '../../test/_scalar-core-cases.js'

const ROOT = new URL('../..', import.meta.url).pathname
const FULL_BYTES = readFileSync(ROOT + '/dist/jz.wasm')
const ENTRY = new URL('./compiler.js', import.meta.url).pathname
const graph = resolveModuleGraph(ENTRY, { resolveNode: true })
const inputBytes = graph.code.length + Object.values(graph.modules).reduce((n, source) => n + source.length, 0)

const builtAt = performance.now()
const compactBytes = compile(graph.code, {
  modules: graph.modules,
  memory: 1024,
  optimize: 1,
  _compactCollections: true,
})
const buildMs = performance.now() - builtAt
const compactModule = toModule(compactBytes)
const fullModule = toModule(FULL_BYTES)
const artifactShrink = FULL_BYTES.length / compactBytes.length

const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i])
// mem.read returns typed-array views into compiler memory. Copy before _clear()
// so retained-output checks cannot alias the next compile's arena.
const readBytes = (instance, ptr) => new Uint8Array(instance.memory.read(ptr))
const verifyReuse = () => {
  const compiler = instantiate(compactModule, { memory: 1024, externref: false })
  const a = scalarCase('abi-add'), b = scalarCase('determinism-poly')
  const power = scalarCase('preeval-constant-power'), remainder = scalarCase('preeval-constant-remainder')
  const comma = scalarCase('comma-effects'), control = scalarCase('continue-labeled-outer')
  const unsigned = scalarCase('unsigned-accumulator-wrap'), integer = scalarCase('differential-fnv-i32')
  const cases = [
    [a.source, 'add', [2, 3], 5],
    [a.source, 'add', [2, 3], 5],
    [b.source, 'poly', [2, 3, 4], 671950],
    [power.source, 'f', [], 1024],
    [remainder.source, 'f', [], 1],
    [comma.source, 'f', [], 2],
    [control.source, 'f', [], 30],
    [unsigned.source, 'main', [], 4],
    [integer.source, 'f', [1, 2, 3], 5689143],
  ]
  const runCases = (optimize) => {
    let first = null, firstSnapshot = null
    const mode = optimize ? 'optimized ' : ''
    const reference = instantiate(compactModule, { memory: 1024, externref: false })
    const referenceSource = reference.memory.String(b.source)
    const referenceOptions = reference.memory.Object(optimize ? { abi: 'raw', optimize: true } : { abi: 'raw' })
    const referenceB = readBytes(reference, reference.exports.default(referenceSource, referenceOptions))
    reference.instance.exports._clear()
    for (let i = 0; i < cases.length; i++) {
      const [source, exportName, args, expected] = cases[i]
      const sourcePtr = compiler.memory.String(source)
      const optionsPtr = compiler.memory.Object(optimize ? { abi: 'raw', optimize: true } : { abi: 'raw' })
      const output = readBytes(compiler, compiler.exports.default(sourcePtr, optionsPtr))
      const value = new WebAssembly.Instance(new WebAssembly.Module(output)).exports[exportName](...args)
      if (!Object.is(value, expected)) throw new Error(`${mode}reuse case ${i}: got ${value}, expected ${expected}`)
      if (i === 0) { first = output; firstSnapshot = new Uint8Array(output) }
      else if (i === 1 && !sameBytes(first, output)) throw new Error(`${mode}reuse case A to A changed output bytes`)
      else if (i === 2 && !sameBytes(referenceB, output)) throw new Error(`${mode}reuse case B changed after A to A`)
      compiler.instance.exports._clear()
    }
    if (!sameBytes(first, firstSnapshot)) throw new Error(`${mode}retained output aliases compiler memory`)
    const emptySource = compiler.memory.String('')
    const emptyOptions = compiler.memory.Object(optimize ? { abi: 'raw', optimize: true } : { abi: 'raw' })
    const empty = readBytes(compiler, compiler.exports.default(emptySource, emptyOptions))
    const emptyModule = new WebAssembly.Module(empty)
    if (empty.length !== 8 || WebAssembly.Module.exports(emptyModule).length)
      throw new Error(`${mode}reuse empty source did not produce the canonical empty module`)
    compiler.instance.exports._clear()
  }
  runCases(false)
  runCases(true)
}
verifyReuse()

const CASES = [
  ['constant', 'export let f = () => 1 + 2 * 3', [], 7],
  ['nan-fold', 'export let f = () => 0 / 0', [], NaN],
  ['arithmetic', 'export let f = x => { x=+x; return x*x*0.5+3 }', [8], 35],
  ['direct-call', 'let mul=(x,y)=>x*y; export let f=(x,y)=>{x=+x;y=+y;return mul(x,y)+1}', [3, 4], 13],
  ['conditional', 'export let f=x=>{x=+x;if(x>0)return x;else return -x}', [-9], 9],
  ['for-loop', 'export let f=n=>{n=+n;let s=0;for(let i=0;i<n;i++)s+=i;return s}', [100], 4950],
  ['while-loop', 'export let f=n=>{n=+n;let s=0;let i=0;while(i<n){s+=i;i++}return s}', [100], 4950],
  ['bitwise', scalarCase('differential-fnv-i32').source, [1, 2, 3], 5689143],
]

const median = (values) => {
  values.sort((a, b) => a - b)
  return values[values.length >> 1]
}

const compileOnce = (module, source, compact) => {
  const instance = instantiate(module, { memory: 1024, externref: false })
  const sourcePtr = instance.memory.String(source)
  return compact
    ? readBytes(instance, instance.exports.default(sourcePtr, instance.memory.Object({ abi: 'raw' })))
    : readBytes(instance, instance.exports.default(sourcePtr, 0, instance.memory.String('false')))
}

// One instance per case, reset after each compile. Source marshaling and reset stay
// outside the timed interval. This bounds memory and measures the compiler body.
const timedCompiler = (module, source, compact, runs = 17, warm = 5) => {
  const instance = instantiate(module, { memory: 1024, externref: false })
  const sample = () => {
    const sourcePtr = instance.memory.String(source)
    const optPtr = compact ? instance.memory.Object({ abi: 'raw' }) : instance.memory.String('false')
    const start = performance.now()
    if (compact) readBytes(instance, instance.exports.default(sourcePtr, optPtr))
    else readBytes(instance, instance.exports.default(sourcePtr, 0, optPtr))
    const elapsed = performance.now() - start
    instance.instance.exports._clear()
    return elapsed
  }
  for (let i = 0; i < warm; i++) sample()
  const values = []
  for (let i = 0; i < runs; i++) values.push(sample())
  return median(values)
}

let ratioLog = 0
let emittedRatioLog = 0
let minimumSpeedup = Infinity
console.log(`compact staged prototype: ${Object.keys(graph.modules).length} modules, ${inputBytes} source bytes`)
console.log(`staged build:    ${compactBytes.length} bytes in ${buildMs.toFixed(1)} ms`)
console.log(`full compiler:   ${FULL_BYTES.length} bytes`)
console.log(`artifact ratio:  ${artifactShrink.toFixed(2)}x smaller\n`)
console.log('case          compact ms   full ms   speedup   compact B   jz-size B   shrink')
console.log('-'.repeat(82))

for (const [name, source, args, expected] of CASES) {
  const compactOut = compileOnce(compactModule, source, true)
  const fullOut = compileOnce(fullModule, source, false)
  const compactProgram = new WebAssembly.Instance(new WebAssembly.Module(compactOut))
  const fullProgram = instantiate(fullOut)
  const compactValue = compactProgram.exports.f(...args)
  const fullValue = fullProgram.exports.f(...args)
  if (!Object.is(compactValue, expected) || !Object.is(fullValue, expected))
    throw new Error(`${name}: result mismatch compact=${compactValue} full=${fullValue} expected=${expected}`)

  const compactMs = timedCompiler(compactModule, source, true)
  const fullMs = timedCompiler(fullModule, source, false)
  if (!(compactMs > 0) || !Number.isFinite(compactMs) || !(fullMs > 0) || !Number.isFinite(fullMs))
    throw new Error(`${name}: invalid timing compact=${compactMs} full=${fullMs}`)
  const speedup = fullMs / compactMs
  const jzSize = compile(source, { optimize: 'size', alloc: false }).length
  const shrink = jzSize / compactOut.length
  ratioLog += Math.log(speedup)
  emittedRatioLog += Math.log(shrink)
  if (speedup < minimumSpeedup) minimumSpeedup = speedup
  console.log(`${name.padEnd(13)}${compactMs.toFixed(3).padStart(9)}${fullMs.toFixed(3).padStart(11)}${speedup.toFixed(2).padStart(9)}x${String(compactOut.length).padStart(12)}${String(jzSize).padStart(12)}${shrink.toFixed(2).padStart(9)}x`)
}

const speedup = Math.exp(ratioLog / CASES.length)
const shrink = Math.exp(emittedRatioLog / CASES.length)
console.log('-'.repeat(82))
console.log(`geomean compile speedup: ${speedup.toFixed(2)}x`)
console.log(`minimum compile speedup: ${minimumSpeedup.toFixed(2)}x`)
console.log(`geomean emitted shrink:  ${shrink.toFixed(2)}x`)
const passed = artifactShrink >= 2 && minimumSpeedup >= 2
console.log(`threshold: ${passed ? 'PASS' : 'FAIL'} (compiler artifact and every compile case must improve by at least 2x)`)
if (!passed) process.exitCode = 1

if (process.platform === 'darwin') {
  const swap = execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' }).trim()
  console.log(`machine swap: ${swap}; timings are prototype evidence only, not release evidence`)
}
