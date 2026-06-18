import { compile } from '../index.js'
import fs from 'fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Examples are perf demos (JS ⇄ jz toggle), so the artifact MUST be speed-optimized — that's what
// turns on auto-SIMD (the escape-time / lane vectorizers). Default `compile(src)` skips it, which is
// why burningship shipped a scalar .wasm and ran slower than JS.
export const OPT = { optimize: 'speed' }

/** Compile examples/<name>/<name>.js → examples/<name>/<name>.wasm (a single artifact). */
export function buildExample(name) {
  const dir = join(fileURLToPath(new URL('.', import.meta.url)), name)
  const src = fs.readFileSync(join(dir, `${name}.js`), 'utf8')
  fs.writeFileSync(join(dir, `${name}.wasm`), compile(src, OPT))
  console.log(`Compiled ${name}`)
}

/** Compile a specific kernel file examples/<dir>/<kernel>.js → <kernel>.wasm
 *  (for variants like a SIMD sibling alongside the scalar example). */
export function buildKernel(exampleDir, kernel) {
  const dir = join(fileURLToPath(new URL('.', import.meta.url)), exampleDir)
  const wasm = compile(fs.readFileSync(join(dir, `${kernel}.js`), 'utf8'), OPT)
  fs.writeFileSync(join(dir, `${kernel}.wasm`), wasm)
  console.log(`Compiled ${exampleDir}/${kernel}`)
}

/** Compile every gallery example in the descriptor (plus any extra `kernels`, e.g. SIMD
 *  siblings) and the standalone demos. This is the single shared build — no per-example
 *  build scripts, no duplicate one-liners. */
export async function buildAll() {
  const { examples } = await import('./examples.js')
  for (const e of examples) {
    buildExample(e.name)
    for (const k of e.kernels || []) buildKernel(e.name, k)
  }
  // Standalone demos not in the gallery descriptor:
  buildExample('rfft')
  buildExample('zzfx')
  await import('./jukebox/build.mjs')   // custom: compiles beat-*.wasm from floatbeats.js
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
