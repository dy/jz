import { compile } from '../index.js'
import fs from 'fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Compile examples/<name>/<name>.js → wasm artifacts. */
export function buildExample(name) {
  const dir = join(fileURLToPath(new URL('.', import.meta.url)), name)
  const src = fs.readFileSync(join(dir, `${name}.js`), 'utf8')
  const wasm = compile(src)
  fs.mkdirSync(join(dir, 'build'), { recursive: true })
  for (const out of ['build/optimized.wasm', 'build/release.wasm', `${name}.wasm`]) {
    fs.writeFileSync(join(dir, out), wasm)
  }
  console.log(`Compiled ${name}`)
}

/** Compile a specific kernel file examples/<dir>/<kernel>.js → <kernel>.wasm
 *  (for variants like a SIMD sibling alongside the scalar example). */
export function buildKernel(exampleDir, kernel) {
  const dir = join(fileURLToPath(new URL('.', import.meta.url)), exampleDir)
  const wasm = compile(fs.readFileSync(join(dir, `${kernel}.js`), 'utf8'))
  fs.writeFileSync(join(dir, `${kernel}.wasm`), wasm)
  console.log(`Compiled ${exampleDir}/${kernel}`)
}

/** Compile every example in the descriptor (plus any extra `kernels`, e.g. SIMD siblings). */
export async function buildAll() {
  const { examples } = await import('./examples.js')
  for (const e of examples) {
    buildExample(e.name)
    for (const k of e.kernels || []) buildKernel(e.name, k)
  }
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
