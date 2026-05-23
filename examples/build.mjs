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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const name = process.argv[2]
  if (!name) {
    console.error('usage: node examples/build.mjs <example-name>')
    process.exit(1)
  }
  buildExample(name)
}
