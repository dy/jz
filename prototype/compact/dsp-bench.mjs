#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import compileCompact from './compiler.js'
import { compileWat } from './backend.js'

const LENGTH = 4097
const SOURCE = `const a=new Float64Array(${LENGTH});const b=new Float64Array(${LENGTH})
export let setup=(seed)=>{for(let i=0;i<a.length;i++)a[i]=(seed+i)*0.25;return a[a.length-1]}
export let map=(scale,bias)=>{for(let j=0;j<b.length;j++)b[j]=a[j]*scale+bias;return b[0]+b[${LENGTH - 1}]}`
const sha256 = value => createHash('sha256').update(value).digest('hex')
const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i])

const build = (simd) => {
  const wat = compileCompact(SOURCE, { abi: 'raw', simd, wat: true })
  const text = JSON.stringify(wat)
  if (simd !== text.includes('v128')) throw new Error(`${simd ? 'SIMD' : 'scalar'} WAT shape mismatch`)
  wat.push(['export', '"memory"', ['memory', 0]])
  return { bytes: compileWat(wat), wat: text }
}

const scalar = build(false), vector = build(true)
const instantiate = bytes => new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports
const scalarExports = instantiate(scalar.bytes), vectorExports = instantiate(vector.bytes)
const seed = 3.25, scale = -1.5, bias = 0.125
const expectedSetup = (seed + LENGTH - 1) * 0.25
const expectedMap = (seed * 0.25) * scale + bias + ((seed + LENGTH - 1) * 0.25) * scale + bias
if (!Object.is(scalarExports.setup(seed), expectedSetup) || !Object.is(vectorExports.setup(seed), expectedSetup))
  throw new Error('setup result mismatch')
const scalarResult = scalarExports.map(scale, bias), vectorResult = vectorExports.map(scale, bias)
if (!Object.is(scalarResult, expectedMap) || !Object.is(vectorResult, expectedMap))
  throw new Error(`map result mismatch scalar=${scalarResult} SIMD=${vectorResult} expected=${expectedMap}`)
const byteLength = LENGTH * 16
const scalarMemory = new Uint8Array(scalarExports.memory.buffer, 0, byteLength)
const vectorMemory = new Uint8Array(vectorExports.memory.buffer, 0, byteLength)
if (!sameBytes(scalarMemory, vectorMemory)) throw new Error('SIMD memory differs from scalar memory')

const median = values => {
  values.sort((a, b) => a - b)
  return values[values.length >> 1]
}
const measure = (fn, batches = 31, iterations = 40) => {
  for (let i = 0; i < 20; i++) fn(scale, bias)
  const samples = []
  for (let batch = 0; batch < batches; batch++) {
    const start = performance.now()
    for (let i = 0; i < iterations; i++) fn(scale, bias)
    samples.push((performance.now() - start) / iterations)
  }
  return median(samples)
}
const scalarMs = measure(scalarExports.map)
const vectorMs = measure(vectorExports.map)
const speedup = scalarMs / vectorMs

console.log(`source SHA-256: ${sha256(SOURCE)}`)
console.log(`length: ${LENGTH}, scalar bytes: ${scalar.bytes.length}, SIMD bytes: ${vector.bytes.length}`)
console.log(`scalar map: ${scalarMs.toFixed(4)} ms, SIMD map: ${vectorMs.toFixed(4)} ms, speedup: ${speedup.toFixed(2)}x`)
console.log('result and 65,552 memory bytes are identical')
if (!(speedup > 1)) {
  console.error('SIMD did not beat scalar on the positive kernel')
  process.exitCode = 1
}
if (process.platform === 'darwin') {
  const swap = execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' }).trim()
  console.log(`machine swap: ${swap}; runtime timing is directional, not release evidence`)
}
