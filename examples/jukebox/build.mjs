import { compile } from '../../index.js'
import fs from 'fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const { FLOATBEATS, moduleSrc } = await import(join(__dirname, 'floatbeats.js'))

fs.mkdirSync(join(__dirname, 'build'), { recursive: true })

for (let i = 0; i < FLOATBEATS.length; i++) {
  const wasm = compile(moduleSrc(FLOATBEATS[i].body))
  fs.writeFileSync(join(__dirname, 'build', `beat-${i}.wasm`), wasm)
  console.log(`Compiled beat-${i}: ${FLOATBEATS[i].name}`)
}
