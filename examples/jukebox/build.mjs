import { compile } from '../../index.js'
import { writeWasm } from '../../scripts/portable.mjs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const { FLOATBEATS, moduleSrc } = await import(join(__dirname, 'floatbeats.js'))

for (let i = 0; i < FLOATBEATS.length; i++) {
  writeWasm(join(__dirname, `beat-${i}.wasm`), compile, moduleSrc(FLOATBEATS[i].body), { optimize: 'speed' })
  console.log(`Compiled beat-${i}: ${FLOATBEATS[i].name}`)
}
