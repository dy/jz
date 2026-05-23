import { compile } from '../../index.js';
import fs from 'fs';
import { songs, floatbeatModuleSrc, songSlug } from './songs.js';

let src = fs.readFileSync(new URL('rfft.js', import.meta.url), 'utf8');
let wasm = compile(src);
fs.writeFileSync(new URL('rfft.wasm', import.meta.url), wasm);
console.log("Compiled rfft (" + wasm.length + " bytes)");

const beatsDir = new URL('beats/', import.meta.url);
fs.mkdirSync(beatsDir, { recursive: true });
for (const song of songs) {
  const slug = songSlug(song);
  const bytes = compile(floatbeatModuleSrc(song));
  fs.writeFileSync(new URL(`${slug}.wasm`, beatsDir), bytes);
  console.log(`Compiled beat ${slug} (${bytes.length} bytes)`);
}
