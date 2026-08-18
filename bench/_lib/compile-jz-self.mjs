#!/usr/bin/env node
// Part 3 (jz×jz self-compile row) isolation shim. bench.mjs's `jz` target
// normally calls compileJzHost/compileJzSize IN-PROCESS (compiling any other
// case's tiny source is cheap). The `jz` CASE is the one self-referential
// exception: its source (bench/jz/jz.js) pulls in scripts/self.js — the
// WHOLE jz compiler — so this specific cell asks jz to compile itself, then
// RUN the result, which itself compiles 3 more programs 45 times over (see
// bench/jz/jz.js's own memory note: the host version already watermarks
// ~0.5 GB with no intermediate free). Without the region-arena allocator
// (concurrent work — the actual unlock for this row), that can spike well
// past a gigabyte or hang. Doing this compile IN bench.mjs's own process (as
// every other case does) means a blowup there takes the WHOLE bench run down
// with it, not just this one cell.
//
// This script is that same compile, byte-for-byte (mirrors compileJzAt's
// options for the `jz` case: jzify:true, resolveNode:true for self.js's bare
// `watr`/`watr/print` imports, the benchlib env.logResult host patch, no
// allocator exports), but run as bench.mjs's OWN child process
// (--max-old-space-size caps it explicitly; bench.mjs also wraps the spawn in
// a wall-clock timeout) — so a crash/OOM/hang here is just a subprocess
// exiting non-zero or getting killed, caught by tryRun like any other build
// failure, and reported as one honest per-cell reason instead of an outage.
//
// The moment the region build lands, this cell keeps working unmodified —
// same compile, same isolation — it should just start succeeding.
import { writeFileSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '../../index.js'
import { resolveModuleGraph } from '../../src/resolve.js'

const BENCH_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const LIB = join(BENCH_DIR, '_lib')
const jsPath = join(BENCH_DIR, 'jz', 'jz.js')
const [, , hostOut, sizeOut] = process.argv
if (!hostOut || !sizeOut) {
  console.error('usage: compile-jz-self.mjs <host.wasm out> <size.wasm out>')
  process.exit(2)
}

// Same benchlib patch compileJzAt's host builds apply everywhere (offload
// printResult to env.logResult so the host can read median/checksum/etc).
const benchlibHostSource = () => {
  const src = readFileSync(join(LIB, 'benchlib.js'), 'utf8')
  const out = src.replace(`export let printResult = (medianUs, checksum, samples, stages, runs) => {
  console.log(\`median_us=\${medianUs} checksum=\${checksum} samples=\${samples} stages=\${stages} runs=\${runs}\`)
}`, `export let printResult = (medianUs, checksum, samples, stages, runs) => {
  env.logResult(medianUs, checksum, samples, stages, runs)
}`)
  if (out === src) throw Error('failed to patch benchlib printResult for jz')
  return out
}

// resolveNode:true — jz.js → scripts/self.js → bare `watr`/`watr/print`
// specifiers need node_modules resolution (see bench.mjs's graphSources,
// which this mirrors for exactly the `jz` case: GRAPH_CASES.has('jz') with
// resolveNode: c.id === 'jz').
const { code, modules } = resolveModuleGraph(jsPath, { resolveNode: true })
modules[resolve(LIB, 'benchlib.js')] = benchlibHostSource()

const opts = optimize => ({
  jzify: true,
  modules,
  imports: {
    env: { logResult: { params: 5 } },
    performance: { now: { params: 0, returns: 'number' } },
  },
  optimize,
  alloc: false,
  // The wasm32 ceiling (65536 pages = 4 GiB), not the general case's small
  // fixed floor: this module's OWN runtime workload is jz compiling 3
  // programs 45 times with a bump allocator that never frees (see the header
  // comment) — give it the whole address space rather than depend on
  // memory.grow succeeding indefinitely under an allocator not yet built for
  // this scale. Revisit once the region-arena build lands.
  memory: 65536,
})

writeFileSync(hostOut, compile(code, opts({ level: 'speed', ...(process.env.JZ_SIMD ? { vectorizeLaneLocal: true } : {}) })))
writeFileSync(sizeOut, compile(code, opts({ level: 'size' })))
