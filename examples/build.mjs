import { compile } from '../index.js'
import { resolveModuleGraph } from '../src/resolve.js'
import fs from 'fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Examples are perf demos (JS ⇄ jz toggle), so the artifact MUST be speed-optimized — that's what
// turns on auto-SIMD (the escape-time / lane vectorizers). Default `compile(src)` skips it, which is
// why burningship shipped a scalar .wasm and ran slower than JS.
export const OPT = { optimize: 'speed' }

/** Compile examples/<name>/<name>.js → examples/<name>/<name>.wasm (a single artifact). */
export function buildExample(name) {
  const dir = join(fileURLToPath(new URL('.', import.meta.url)), name)
  const build = join(dir, 'build.mjs')
  if (fs.existsSync(build)) {
    execFileSync(process.execPath, [build], { cwd: dir, stdio: 'inherit' })
    return
  }
  buildKernel(name, name)
}

/** Compile a specific kernel file examples/<dir>/<kernel>.js → <kernel>.wasm
 *  (for variants like a SIMD sibling alongside the scalar example). */
export function buildKernel(exampleDir, kernel) {
  const dir = join(fileURLToPath(new URL('.', import.meta.url)), exampleDir)
  const { code, modules } = resolveModuleGraph(join(dir, `${kernel}.js`))
  const wasm = compile(code, { ...OPT, modules })
  fs.writeFileSync(join(dir, `${kernel}.wasm`), wasm)
  console.log(`Compiled ${exampleDir}/${kernel}`)
}

/** Compile the gallery, sibling kernels and standalone demos. Custom build scripts
 *  also prepare their browser assets (three.js sources, generated jukebox kernels). */
export async function buildAll() {
  const { examples } = await import('./examples.js')
  for (const e of examples) {
    buildExample(e.name)
    for (const k of e.kernels || []) buildKernel(e.name, k)
  }
  // Standalone demos not in the gallery descriptor:
  for (const name of ['rfft', 'zzfx', 'jukebox']) buildExample(name)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const name = process.argv[2]
  if (name === 'all' || name === '--all') {
    await buildAll()
  } else if (name) {
    buildExample(name)
  } else {
    console.error('usage: node examples/build.mjs <example-name|all>')
    process.exit(1)
  }
}
