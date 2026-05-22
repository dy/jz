import { compile } from '../../index.js';
import fs from 'fs';

let src = fs.readFileSync(new URL('rfft.js', import.meta.url), 'utf8');
let wasm = compile(src);
fs.writeFileSync(new URL('rfft.wasm', import.meta.url), wasm);
console.log("Compiled rfft (" + wasm.length + " bytes)");
