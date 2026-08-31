#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { compile } from '../../index.js'
import { instantiate, toModule } from '../../interop.js'
import { resolveModuleGraph } from '../../src/resolve.js'

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
const verifyReuse = () => {
  const compiler = instantiate(compactModule, { memory: 1024, externref: false })
  const cases = [
    ['export let f=()=>7', [], 7],
    ['export let f=()=>7', [], 7],
    ['export let f=x=>{x=+x;return x*x}', [4], 16],
  ]
  const runCases = (optimize) => {
    let first = null
    const mode = optimize ? 'optimized ' : ''
    for (let i = 0; i < cases.length; i++) {
      const [source, args, expected] = cases[i]
      const sourcePtr = compiler.memory.String(source)
      const outputPtr = optimize
        ? compiler.exports.default(sourcePtr, compiler.memory.Object({ optimize: true }))
        : compiler.exports.default(sourcePtr)
      const output = compiler.memory.read(outputPtr)
      const value = new WebAssembly.Instance(new WebAssembly.Module(output)).exports.f(...args)
      if (!Object.is(value, expected)) throw new Error(`${mode}reuse case ${i}: got ${value}, expected ${expected}`)
      if (i === 0) first = output
      else if (i === 1 && !sameBytes(first, output)) throw new Error(`${mode}reuse case A to A changed output bytes`)
      compiler.instance.exports._clear()
    }
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
]

const median = (values) => {
  values.sort((a, b) => a - b)
  return values[values.length >> 1]
}

const compileOnce = (module, source, compact) => {
  const instance = instantiate(module, { memory: 1024, externref: false })
  const sourcePtr = instance.memory.String(source)
  return compact
    ? instance.memory.read(instance.exports.default(sourcePtr))
    : instance.memory.read(instance.exports.default(sourcePtr, 0, instance.memory.String('false')))
}

// One instance per case, reset after each compile. Source marshaling and reset stay
// outside the timed interval. This bounds memory and measures the compiler body.
const timedCompiler = (module, source, compact, runs = 17, warm = 5) => {
  const instance = instantiate(module, { memory: 1024, externref: false })
  const sample = () => {
    const sourcePtr = instance.memory.String(source)
    const optPtr = compact ? 0 : instance.memory.String('false')
    const start = performance.now()
    if (compact) instance.memory.read(instance.exports.default(sourcePtr))
    else instance.memory.read(instance.exports.default(sourcePtr, 0, optPtr))
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
