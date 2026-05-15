import { compile } from '../../index.js';
import fs from 'fs';

let src = fs.readFileSync(new URL('interference.js', import.meta.url), 'utf8');
let wasm = compile(src);
fs.writeFileSync(new URL('build/optimized.wasm', import.meta.url), wasm);
fs.writeFileSync(new URL('build/release.wasm', import.meta.url), wasm);
fs.writeFileSync(new URL('interference.wasm', import.meta.url), wasm);
console.log("Compiled interference");
