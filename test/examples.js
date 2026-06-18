import test from 'tst';
import { is, ok } from 'tst/assert.js';
import jz from '../index.js';
import fs from 'fs';
import { FLOATBEATS, moduleSrc } from '../examples/jukebox/floatbeats.js';
import { OPT } from '../examples/build.mjs';

let mandelbrotSrc = fs.readFileSync(new URL('../examples/mandelbrot/mandelbrot.js', import.meta.url), 'utf8');

// Regression: examples/build.mjs once compiled with the DEFAULT options (no optimize), so the
// auto-SIMD vectorizers never ran and every demo shipped a scalar .wasm that lost to plain JS.
// The examples are perf demos, so the build MUST stay speed-optimized — assert a known-vectorizable
// kernel still emits SIMD under the exact options the build uses (so dropping `speed` fails here).
test('example: build options keep kernels vectorized (SIMD)', () => {
    let src = fs.readFileSync(new URL('../examples/burningship/burningship.js', import.meta.url), 'utf8');
    let wat = jz.compile(src, { ...OPT, wat: true });
    ok(/f64x2\./.test(wat), `burningship must vectorize under the examples build options (OPT=${JSON.stringify(OPT)})`);
});

// Achievement ratchet: the escape-time fractals BEAT V8 (Node, 800×500: burning-ship 1.46×, Julia
// 1.19×, mandelbrot vectorized) because the divergent escape vectorizer takes the BREAK-ON-FIRST
// fast path — f64x2 lanes with NO per-iteration v128.bitselect freeze. The old masked SIMD froze
// every escaped lane each step, which nearly cancelled the 2× and left jz ~0.9× V8 (slower). Wall-
// clock is machine-dependent (see the jukebox ratchet above), so pin the DETERMINISTIC CAUSE: each
// fractal must (1) vectorize, (2) carry no freeze, (3) emit the scalar tail. A regression to the
// masked path (re-adds bitselect) or to scalar (drops f64x2) trips this. Covers burning-ship
// (escape-after-update), Julia (compound guard + per-pixel z₀ + cached squares — vectorizes with
// NO kernel change), mandelbrot (escape-at-top).
test('example: escape-time fractals take the break-on-first FAST path (beats V8)', () => {
    for (const name of ['burningship', 'julia', 'mandelbrot']) {
        let wat = jz.compile(fs.readFileSync(new URL(`../examples/${name}/${name}.js`, import.meta.url), 'utf8'), { ...OPT, wat: true });
        ok(/f64x2\./.test(wat), `${name}: must vectorize (f64x2) under the examples build options`);
        ok(!/v128\.bitselect/.test(wat), `${name}: must take the FAST path — no per-iteration freeze (v128.bitselect)`);
        ok(/\$__esc\d+_tb\d+/.test(wat), `${name}: must emit the break-on-first scalar tail`);
    }
});

test('example: mandelbrot output natively matches WASM', () => {
    let nativeExports = (() => {
        let mem;
        const NUM_COLORS = 2048;
        return {
            resize: (w, h) => { mem = new Uint16Array(w * h); return mem; },
            computeLine: (y, width, height, limit) => {
                let translateX = width  * (1.0 / 1.6);
                let translateY = height * (1.0 / 2.0);
                let scale      = 10.0 / (3 * width < 4 * height ? 3 * width : 4 * height);
                let imaginary  = (y - translateY) * scale;
                let realOffset = translateX * scale;
                let stride     = y * width;
                let invLimit   = 1.0 / limit;
                let minIterations = 8 < limit ? 8 : limit;
                for (let x = 0; x < width; ++x) {
                    let real = x * scale - realOffset;
                    let ix = 0.0, iy = 0.0, ixSq = 0.0, iySq = 0.0;
                    let iteration = 0;
                    while ((ixSq = ix * ix) + (iySq = iy * iy) <= 4.0) {
                        iy = 2.0 * ix * iy + imaginary;
                        ix = ixSq - iySq + real;
                        if (iteration >= limit) break;
                        ++iteration;
                    }
                    while (iteration < minIterations) {
                        let ixNew = ix * ix - iy * iy + real;
                        iy = 2.0 * ix * iy + imaginary;
                        ix = ixNew;
                        ++iteration;
                    }
                    let col = NUM_COLORS - 1;
                    let sqd = ix * ix + iy * iy;
                    if (sqd > 1.0) {
                        let frac = Math.log2(0.5 * Math.log(sqd));
                        let val = (iteration + 1 - frac) * invLimit;
                        if (val < 0.0) val = 0.0;
                        if (val > 1.0) val = 1.0;
                        col = ((NUM_COLORS - 1) * val) | 0;
                    }
                    mem[stride + x] = col;
                }
            }
        };
    })();

    let w = 10, h = 10, l = 40;
    let nativeArr = nativeExports.resize(w, h);
    nativeExports.computeLine(0, w, h, l);

    let { exports, memory } = jz(mandelbrotSrc, { env: { 'Math.log': Math.log, 'Math.log2': Math.log2 }});
    let ptr = exports.resize(w, h);
    let wasmArr = memory.read(ptr);
    exports.computeLine(0, w, h, l);

    for (let i = 0; i < w * h; i++) {
        is(wasmArr[i], nativeArr[i]);
    }
});

let golSrc = fs.readFileSync(new URL('../examples/game-of-life/game-of-life.js', import.meta.url), 'utf8');

test('example: jukebox wasm assets are deployable', async () => {
    for (let i = 0; i < FLOATBEATS.length; i++) {
        const url = new URL(`../examples/jukebox/beat-${i}.wasm`, import.meta.url);
        ok(fs.existsSync(url), `missing ${url.pathname}`);

        const bytes = fs.readFileSync(url);
        is(bytes[0], 0x00);
        is(bytes[1], 0x61);
        is(bytes[2], 0x73);
        is(bytes[3], 0x6d);
        await WebAssembly.compile(bytes);
    }
});

// V8-parity ratchet. Every jukebox voice compiles faster than V8's JS-JIT of the same
// source (scripts/bench-all-jukebox.mjs) because jz proves the floatbeat math numeric
// and skips the per-sample `__to_num` boxing — which also lets the ToNumber string-parse
// stdlib treeshake, so V8 tiers the hot fill loop up properly. Wall-clock is machine-
// dependent (see test/perf-ratchet.js), so we pin the deterministic cause instead: the
// number of hot-path (`beat`/`fill`/closure) `__to_num` coercions. A lost numeric-typing
// optimization re-introduces per-sample boxing and trips this; the string-parsing voices
// (charCodeAt/Number) keep a small legitimate residue. Lower is always fine (`<=`).
test('example: jukebox floatbeats stay box-free (V8-parity ratchet)', () => {
    const BASELINE = {
        'Predestined Fate': 9, 'Please Exist': 0, 'Sunrise on Mars': 4,
        'Random melody with array': 0, 'Virtual Insanity': 0, 'Bitrot': 0,
        'Ambient Waves': 0, 'Sierpinski Chords': 0, 'Sine Rider': 0,
        'Digital Rain': 6, 'Neo-Noir Jazz Lounge': 0, 'Celesta Dreams': 0,
    };
    for (const fb of FLOATBEATS) {
        const wat = jz.compile(moduleSrc(fb.body), { optimize: 3, wat: true });
        let fn = '', n = 0;
        for (const line of wat.split('\n')) {
            const m = line.match(/\(func (\$[\w.]+)/); if (m) fn = m[1];
            if (/beat|fill|closure/.test(fn) && line.includes('call $__to_num')) n++;
        }
        ok(n <= BASELINE[fb.name],
            `${fb.name}: ${n} hot-path __to_num (baseline ${BASELINE[fb.name]}) — numeric-typing regression?`);
    }
});

test('example: game-of-life output natively matches WASM', () => {
    let nativeExports = (() => {
        let BGR_ALIVE = 0;
        let BGR_DEAD = 0;
        let BIT_ROT = 0;

        let width = 0, height = 0, offset = 0;
        let mem;

        let init = (w, h, alive, dead, rot_val) => {
            BGR_ALIVE = alive;
            BGR_DEAD = dead;
            BIT_ROT = rot_val;
            width = w;
            height = h;
            offset = w * h;
            mem = new Uint32Array(w * h * 2);

            for (let y = 0; y < h; ++y) {
                for (let x = 0; x < w; ++x) {
                    mem[offset + (y * width + x)] = Math.random() > 0.1
                        ? BGR_DEAD & 0x00ffffff
                        : (BGR_ALIVE | 0xff000000) >>> 0;
                }
            }
            return mem;
        };

        let rot = (x, y, v) => {
            let alpha = Math.max((v >>> 24) - BIT_ROT, 0);
            mem[offset + (y * width + x)] = ((alpha << 24) | (v & 0x00ffffff)) >>> 0;
        };

        let step = () => {
            let w = width, h = height;
            let hm1 = h - 1, wm1 = w - 1;

            for (let y = 0; y < h; ++y) {
                let ym1 = y == 0 ? hm1 : y - 1,
                    yp1 = y == hm1 ? 0 : y + 1;
                for (let x = 0; x < w; ++x) {
                    let xm1 = x == 0 ? wm1 : x - 1,
                        xp1 = x == wm1 ? 0 : x + 1;

                    let aliveNeighbors =
                        (mem[ym1 * w + xm1] & 1) + (mem[ym1 * w + x] & 1) + (mem[ym1 * w + xp1] & 1) +
                        (mem[y   * w + xm1] & 1)                          + (mem[y   * w + xp1] & 1) +
                        (mem[yp1 * w + xm1] & 1) + (mem[yp1 * w + x] & 1) + (mem[yp1 * w + xp1] & 1);

                    let self = mem[y * w + x];
                    if (self & 1) {
                        if ((aliveNeighbors & 0b1110) == 0b0010) rot(x, y, self);
                        else mem[offset + (y * width + x)] = (BGR_DEAD | 0xff000000) >>> 0;
                    } else {
                        if (aliveNeighbors == 3) mem[offset + (y * width + x)] = (BGR_ALIVE | 0xff000000) >>> 0;
                        else rot(x, y, self);
                    }
                }
            }
        };
        return { init, step };
    })();

    let w = 10, h = 10;
    // jz's Math.random is a built-in xorshift PRNG seeded from the host (entropy by
    // default, `randomSeed` for repro) — NOT the env import — so the two sides can't be
    // driven from a shared Math.random mock (the old mock silently never fired, and the
    // test only passed by luck of suite ordering). Compare the STEP rule — the actual
    // game-of-life logic (neighbour counts + alive/dead/rot transitions) — by seeding
    // BOTH from WASM's init grid, then checking one generation matches.
    let { exports, memory } = jz(golSrc, { env: { 'Math.max': Math.max } });
    let ptr = exports.init(w, h, 0xD392E6, 0xA61B85, 10);
    let wasmArr = memory.read(ptr);

    let nativeArr = nativeExports.init(w, h, 0xD392E6, 0xA61B85, 10);
    for (let i = 0; i < w * h * 2; i++) nativeArr[i] = wasmArr[i]; // both step from WASM's init grid
    for (let i = 0; i < w * h; i++) {                             // copy output region → input region
        nativeArr[i] = nativeArr[i + w * h];
        wasmArr[i] = wasmArr[i + w * h];
    }
    nativeExports.step();
    exports.step();

    for (let i = 0; i < w * h * 2; i++) {
        is(wasmArr[i], nativeArr[i]);
    }
});
