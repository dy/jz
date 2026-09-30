// One host ABI and module graph for speed and size measurements.
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '../../index.js'
import { resolveModuleGraph } from '../../src/resolve.js'
import { GRAPH_CASES, LOWERED_CASES, graphSources } from './graph.js'

const LIB = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(LIB, '../..')

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

export const watrModuleSources = () => ({
  './watr-compile.js': `import compileWatr from '../../node_modules/watr/src/compile.js'\nexport const compile = (src) => compileWatr(src)\n`,
  '../../node_modules/watr/src/compile.js': readFileSync(join(ROOT, 'node_modules/watr/src/compile.js'), 'utf8'),
  './encode.js': readFileSync(join(ROOT, 'node_modules/watr/src/encode.js'), 'utf8'),
  './const.js': readFileSync(join(ROOT, 'node_modules/watr/src/const.js'), 'utf8'),
  './parse.js': readFileSync(join(ROOT, 'node_modules/watr/src/parse.js'), 'utf8'),
  './util.js': readFileSync(join(ROOT, 'node_modules/watr/src/util.js'), 'utf8'),
})

// Build a case's host wasm at a given optimize level. `level: 'speed'` is the
// row's timed/run build; `level: 'size'` is the -Os build the size column reads.
// Both offload formatting via env.logResult (the benchlibHostSource patch), so
// the comparison to AS — which offloads via @external logLine — is like-for-like.
export const compileJzAt = (c, optimize, compiler = compile) => {
  const isWatr = c.id === 'watr'
  // Graph cases resolve their whole import graph (GRAPH_CASES), then swap the
  // real benchlib for the env.logResult-patched host build.
  const isGraph = GRAPH_CASES.has(c.id)
  let code, modules, hostImports = {}
  if (isGraph) {
    ;({ code, modules, imports: hostImports } = graphSources(c, resolveModuleGraph))
    modules[resolve(LIB, 'benchlib.js')] = benchlibHostSource()
  } else {
    code = readFileSync(c.js, 'utf8')
    modules = {
      '../_lib/benchlib.js': benchlibHostSource(),
      ...(isWatr ? watrModuleSources() : {}),
    }
  }
  return compiler(code, {
    host: 'js',
    jzify: isWatr || isGraph || LOWERED_CASES.has(c.id),
    modules,
    imports: {
      ...hostImports,
      env: { logResult: { params: 5 } },
      performance: { now: { params: 0, returns: 'number' } },
    },
    optimize,
    alloc: false,
    // Preserve the self-benchmark's standalone runtime memory contract.
    ...(c.id === 'jz' ? { memory: 65536 } : {}),
  })
}

// The compiler graph can exhaust V8's heap. Both harnesses isolate its build
// so a crash is a failed row and the remaining cases can still be measured.
export const compileJzSelf = (hostOut, sizeOut) => {
  const timeout = 10 * 60 * 1000
  const r = spawnSync(process.execPath, ['--max-old-space-size=8192', join(LIB, 'compile-jz-self.mjs'), hostOut || '-', sizeOut || '-'],
    { cwd: ROOT, encoding: 'utf8', timeout })
  const detail = (r.stderr || r.stdout || '').trim()
  if (r.error?.code === 'ETIMEDOUT') throw Error(`compiler benchmark build exceeded ${timeout / 1000}s`)
  if (r.signal) throw Error(`compiler benchmark build terminated by ${r.signal}: ${detail}`)
  if (r.error) throw r.error
  if (r.status !== 0) throw Error(`compiler benchmark build exited ${r.status}: ${detail}`)
}
