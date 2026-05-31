// Compile each floatbeat tune to beats/<slug>.wasm — the modules the rfft demo
// loads for its jz synthesis path (JS mode builds them at runtime via new Function,
// so only jz needs these prebuilt). Run after editing songs.js:
//   node examples/rfft/build-beats.mjs
import { compile } from '../../index.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { songs, floatbeatModuleSrc, songSlug } from './songs.js'

const dir = dirname(fileURLToPath(import.meta.url))
const out = join(dir, 'beats')
mkdirSync(out, { recursive: true })
for (const song of songs) {
  const wasm = compile(floatbeatModuleSrc(song))
  writeFileSync(join(out, `${songSlug(song)}.wasm`), wasm)
  console.log(`beat: ${songSlug(song).padEnd(18)} ${wasm.length} B`)
}
