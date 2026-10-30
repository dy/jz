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

// A graph case's standalone (`--host wasi`) build, for the wasmtime and native
// lanes: the module graph the host build compiles, each host adapter a module
// whose exports throw (a native binary imports nothing but WASI), the real
// benchlib printing through fd_write. The CLI resolves the graph without the
// case's adapters and stubs: webaudio's reached the codec packages.
export const compileJzWasi = (c, optimize, compiler = compile) => {
  const { code, modules, imports } = graphSources(c, resolveModuleGraph)
  for (const [spec, names] of Object.entries(imports))
    modules[spec] = `const unavailable = () => { throw new Error('${spec} is a host adapter') }\n` +
      Object.keys(names).map(n => n === 'default' ? 'export default unavailable\n' : `export const ${n} = unavailable\n`).join('')
  return compiler(code, { host: 'wasi', jzify: true, modules, optimize })
}

// The compiler graph can exhaust V8's heap. Both harnesses isolate its builds
// so a crash is a failed row and the remaining cases can still be measured.
// One process and 90 minutes per artifact: the build grows with the compiler it
// compiles, and the speed and size builds in one process outgrew a shared hour
// on the reference runner (EPYC 7763, 2026-10: about 59 minutes at a841739a,
// past 60 at 2c8f08ac and 825566d4). The speed build is about 72% of the work
// (20.5 of 28.3 T instructions at a841739a, 21.8 of 30.0 at 007669bf: Apple M4
// Max): about 45 minutes there by that share, half its 90.
export const compileJzSelf = (hostOut, sizeOut) => {
  for (const [level, out] of [['speed', hostOut], ['size', sizeOut]]) if (out) buildJzSelf(level, out)
}
const buildJzSelf = (level, out) => {
  const timeout = 90 * 60 * 1000
  const r = spawnSync(process.execPath, ['--max-old-space-size=8192', join(LIB, 'compile-jz-self.mjs'), level, out],
    { cwd: ROOT, encoding: 'utf8', timeout })
  const detail = (r.stderr || r.stdout || '').trim()
  if (r.error?.code === 'ETIMEDOUT') throw Error(`compiler benchmark ${level} build exceeded ${timeout / 1000}s`)
  if (r.signal) throw Error(`compiler benchmark ${level} build terminated by ${r.signal}: ${detail}`)
  if (r.error) throw r.error
  if (r.status !== 0) throw Error(`compiler benchmark ${level} build exited ${r.status}: ${detail}`)
}
