import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { medianUs } from './benchlib.js'
import { passes } from './passes.js'

/** Shared wat2wasm bench driver — config per case in bench/<name>/run-wat.mjs */
export async function runWatBench({
  name,
  wat = `${name}.wat`,
  wasmName,
  nRuns = 21,
  nWarmup = 5,
  setup,
  beforeRun,
  run,
  checksum,
  samples,
  stages,
}) {
  const libDir = dirname(fileURLToPath(import.meta.url))
  const benchDir = join(libDir, '..', name)
  const here = (...p) => join(benchDir, ...p)
  const buildDir = process.env.JZ_BENCH_BUILD_DIR || join(tmpdir(), 'jz-bench', name)
  fs.mkdirSync(buildDir, { recursive: true })

  const outWasm = wasmName || `${name}-wat.wasm`
  const wasmPath = join(buildDir, outWasm)
  execSync(`wat2wasm ${JSON.stringify(here(wat))} -o ${JSON.stringify(wasmPath)}`, { stdio: 'pipe' })
  const mod = await WebAssembly.compile(fs.readFileSync(wasmPath))

  // a pass is a fresh instance of the one compiled module
  await passes(() => {
    const instance = new WebAssembly.Instance(mod, {})
    const exp = instance.exports
    setup?.(exp, instance)
    for (let i = 0; i < nWarmup; i++) {
      beforeRun?.(exp, instance, i)
      run(exp, instance, i, true)
    }

    const samplesArr = new Float64Array(nRuns)
    for (let i = 0; i < nRuns; i++) {
      beforeRun?.(exp, instance, i)
      const t0 = performance.now()
      run(exp, instance, i, false)
      samplesArr[i] = performance.now() - t0
    }

    const cs = checksum(exp, instance) >>> 0
    console.log(`median_us=${medianUs(samplesArr)} checksum=${cs} samples=${samples} stages=${stages} runs=${nRuns}`)
  })
}
