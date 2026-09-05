#!/usr/bin/env node
/** Full jz×jz gate: the wasm-hosted compiler compiles its complete source graph. */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { instantiate } from '../interop.js'
import { resolveSelfCompileBuild } from './build-profile.mjs'

const ROOT = resolve(new URL('..', import.meta.url).pathname)
const kernel = readFileSync(resolve(ROOT, 'dist/jz.wasm'))
const profile = resolveSelfCompileBuild()
const self = instantiate(kernel, { memory: 65536, externref: false })
const ex = self.instance.exports
const heap = () => ex.__heap.value >>> 0
const memoryBytes = () => ex.memory.buffer.byteLength
const inputBytes = profile.graph.code.length + Object.values(profile.graph.modules).reduce((n, source) => n + source.length, 0)

const source = self.memory.String(profile.graph.code)
const optimize = self.memory.String(JSON.stringify(profile.optimize))
const modules = self.memory.String(JSON.stringify(profile.graph.modules))
const build = self.memory.String(JSON.stringify({
  memory: profile.memory,
  compactCollections: profile.compactCollections,
}))

// The kernel's stage marks (scripts/self.js): the heap pointer after the front,
// the compile phases, link, watr and the checkpoint; the tape's node count and
// column capacity. Read after a trap too: what the compiler had allocated
// by the last stage it finished is the evidence the trap leaves.
const marks = () => ({
  heapFront: ex.heapFront.value, heapPlan: ex.heapPlan.value, heapEmitFuncs: ex.heapEmitFuncs.value, heapEmitClosures: ex.heapEmitClosures.value,
  heapOptimizeModule: ex.heapOptimizeModule.value, heapLinkStart: ex.heapLinkStart.value, heapEmit: ex.heapEmit.value,
  heapOptimize: ex.heapOptimize.value, heapCheckpoint: ex.heapCheckpoint.value,
  tapeNodes: ex.tapeNodes.value, tapeCapacity: ex.tapeCapacity.value,
})
const started = Date.now()
let output
try { output = self.exports.default(source, 0, optimize, modules, 0, 0, build) }
catch (e) {
  console.log(JSON.stringify({ outcome: 'trap', message: e.message, heap: heap(), memoryBytes: memoryBytes(), elapsedMs: Date.now() - started, ...marks() }))
  process.exit(1)
}
const elapsedMs = Date.now() - started
new WebAssembly.Module(output)

// Prove the recursively-produced artifact is a working compiler, not merely a
// valid wasm module with the right section shape.
const recursive = instantiate(output, { memory: 65536, externref: false })
const probe = recursive.exports.default(
  recursive.memory.String('export let f = x => x * 3 - 2'),
  0,
  recursive.memory.String('2'),
  0, 0, 0, 0,
)
new WebAssembly.Module(probe)
const probeInstance = instantiate(probe)
if (probeInstance.exports.f(7) !== 19) throw new Error('recursive compiler probe returned the wrong value')

const headroom = 0x100000000 - heap()
const minimumHeadroom = 64 * 1024 * 1024
if (headroom < minimumHeadroom)
  throw new Error(`recursive compiler left only ${headroom} bytes of wasm32 headroom; minimum is ${minimumHeadroom}`)

if (process.env.JZ_RECURSIVE_OUTPUT) writeFileSync(process.env.JZ_RECURSIVE_OUTPUT, output)
console.log(JSON.stringify({
  outcome: 'ok',
  modules: Object.keys(profile.graph.modules).length,
  inputBytes,
  outputBytes: output.length,
  heap: heap(),
  headroom,
  memoryBytes: memoryBytes(),
  elapsedMs,
  ...marks(),
}))
