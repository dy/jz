import { compile } from '../../index.js';
import { readFileSync, writeFileSync } from 'fs';

let src = readFileSync('./examples/mandelbrot/mandelbrot.js', 'utf8');
let wasm = compile(src);
let mod = new WebAssembly.Instance(new WebAssembly.Module(wasm), {
    env: {
        'Math.log2': Math.log2,
        'Math.log': Math.log
    }
});

let computeLine = mod.exports.computeLine;

// We need a way to verify execution
let mem = new Uint16Array(mod.exports.memory.buffer);
// computeLine(y, width, height, limit, mem)
computeLine(0, 10, 10, 40, mem); // Wait, jz passes arguments.
// To use jz typed arrays properly, wait. Let's look at `examples/mandelbrot/mandelbrot.js` again.
console.log(mem.slice(0, 10));

