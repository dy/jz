// The rfft demo's kernel, and each floatbeat tune compiled to beats/<slug>.wasm: the modules
// its jz synthesis path loads (JS mode builds them at runtime via new Function, so only jz needs
// these prebuilt). `npm run build:examples` runs this; after editing songs.js:
//   node examples/rfft/build.mjs
import { compile } from '../../index.js'
import { buildKernel } from '../build.mjs'
import { writeWasm } from '../../scripts/portable.mjs'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { songs, floatbeatModuleSrc, songSlug } from './songs.js'

buildKernel('rfft', 'rfft')
const out = join(dirname(fileURLToPath(import.meta.url)), 'beats')
mkdirSync(out, { recursive: true })
for (const song of songs) {
  const wasm = writeWasm(join(out, `${songSlug(song)}.wasm`), compile, floatbeatModuleSrc(song))
  console.log(`beat: ${songSlug(song).padEnd(18)} ${wasm.length} B`)
}
