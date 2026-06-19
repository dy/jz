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

// Achievement ratchet: the per-pixel-color vectorizer (tryPerPixelColor) lifts pixel kernels that
// compute an f64 value from the index (cos/sin/sqrt…) and pack it to a u32 colour into f64x2 lanes —
// two adjacent pixels at once, transcendentals via the bit-exact $math.*2 mirrors, the pack scalar
// per lane. chladni hits 2.28× V8 (the two per-row + per-pixel Math.cos → $math.cos2), interference
// 1.14× (sin+sqrt 2-wide, the sRGB `a**γ` via $math.pow2). Pin the deterministic cause — each must
// take the path ($__ppc tail) and emit its f64x2 mirror; the bit-exactness gate lives in test/simd.js.
test('example: per-pixel-color kernels vectorize (chladni cos, interference sin/sqrt/pow)', () => {
    const w = (name) => jz.compile(fs.readFileSync(new URL(`../examples/${name}/${name}.js`, import.meta.url), 'utf8'), { ...OPT, wat: true });
    const ch = w('chladni');
    ok(/\$__ppc\d+/.test(ch), 'chladni must take the per-pixel-color path');
    ok(/call \$math\.cos2/.test(ch), 'chladni per-pixel Math.cos → f64x2 $math.cos2');
    const it = w('interference');
    ok(/\$__ppc\d+/.test(it), 'interference must take the per-pixel-color path');
    ok(/call \$math\.sin2/.test(it) && /call \$math\.pow2/.test(it), 'interference: sin → $math.sin2, a**γ → $math.pow2');
});

// Stencil vectorizer (experimental): waves is a 2-D 5-point sweep over two height
// buffers swapped each frame. With experimentalStencil the inner x-loop lifts to f64x2
// (neighbour loads a[c±1] / a[rn+x], derived IV c=rc+x). It must be BIT-EXACT to the
// scalar pipeline end-to-end — the swap is outside the loop so the in-loop read/write
// bases stay distinct (no aliasing); a lane-parallel stencil reorders nothing per lane.
test('example: waves 5-point stencil vectorizes f64x2 and stays bit-exact', () => {
    const src = fs.readFileSync(new URL('../examples/waves/waves.js', import.meta.url), 'utf8');
    // experimentalStencil is now default-on at speed (the build options), so the SCALAR baseline
    // turns it explicitly off; the vectorized side is the plain build.
    const base = (jz.compile(src, { ...OPT, experimentalStencil: false, wat: true }).match(/f64x2\./g) || []).length;
    const sten = (jz.compile(src, { ...OPT, wat: true }).match(/f64x2\./g) || []).length;
    ok(sten > base, `waves frame vectorizes via the stencil pass (${base} → ${sten} f64x2)`);
    const run = (opts) => {
        const { exports } = jz(src, opts);
        const px = exports.resize(40, 30);
        exports.drop(20, 15, 9, 6.0); exports.drop(10, 8, 5, 3.0);
        for (let f = 0; f < 25; f++) exports.frame(f);
        return Array.from(px);
    };
    const simd = run({ ...OPT }), scal = run({ ...OPT, experimentalStencil: false });
    is(simd.length, scal.length);
    is(simd.filter((v, i) => v !== scal[i]).length, 0, 'waves SIMD stencil bit-exact vs scalar (1200 px, 25 frames)');
});

// Outer-loop strip-mine (experimental): metaballs sums an inverse-square field over every blob
// per pixel — the outer W×H pixel loops are independent, the inner blob loop is a reduction. With
// experimentalOuterStrip, two adjacent pixels (xi, xi+1) run as f64x2 lanes (cx → ramp, blob loads
// → splat, sum → per-lane f64x2), then each lane packs its colour. BIT-EXACT: each lane accumulates
// in the same scalar order (a per-lane reduction reorders nothing). The odd-width column + the rest
// of the frame run via the kept scalar tail.
test('example: metaballs inner reduction outer-strips to f64x2 and stays bit-exact', () => {
    const src = fs.readFileSync(new URL('../examples/metaballs/metaballs.js', import.meta.url), 'utf8');
    // experimentalOuterStrip is now default-on at speed; SCALAR baseline turns it explicitly off.
    const base = (jz.compile(src, { ...OPT, experimentalOuterStrip: false, wat: true }).match(/f64x2\./g) || []).length;
    const os = (jz.compile(src, { ...OPT, wat: true }).match(/f64x2\./g) || []).length;
    ok(os > base, `metaballs field loop outer-strips (${base} → ${os} f64x2)`);
    const run = (opts) => {
        const { exports } = jz(src, opts);
        const px = exports.resize(48, 32);
        exports.init();
        for (let f = 0; f < 15; f++) exports.frame(f);
        return Array.from(px);
    };
    const simd = run({ ...OPT }), scal = run({ ...OPT, experimentalOuterStrip: false });
    is(simd.length, scal.length);
    is(simd.filter((v, i) => v !== scal[i]).length, 0, 'metaballs outer-strip bit-exact vs scalar (1536 px, 15 frames)');
});

// Stencil with float-derived index + f32 widening: schrodinger's stepR/stepI are 2-D 5-point
// Laplacians where the row base `y*w` is computed in f64 (so idx = trunc(y*w + x), recognized as
// i32-affine since trunc(C+x)=trunc(C)+x), and the potential V is a Float32Array (f32 load promoted
// to f64). With experimentalStencil both lift to f64x2 (f64 loads → v128.load, V → promote_low_f32x4
// of load64_zero). BIT-EXACT — lane-parallel stencil, no reassociation; the float→int index is
// stride-1 by construction.
test('example: schrodinger float-index + f32-widening stencil vectorizes and stays bit-exact', () => {
    const src = fs.readFileSync(new URL('../examples/schrodinger/schrodinger.js', import.meta.url), 'utf8');
    // experimentalStencil is now default-on at speed; SCALAR baseline turns it explicitly off.
    const base = (jz.compile(src, { ...OPT, experimentalStencil: false, wat: true }).match(/f64x2\./g) || []).length;
    const wat = jz.compile(src, { ...OPT, wat: true });
    const sten = (wat.match(/f64x2\./g) || []).length;
    ok(sten > base, `schrodinger stepR/stepI vectorize via the stencil pass (${base} → ${sten} f64x2)`);
    ok(/promote_low_f32x4/.test(wat), 'the f32 potential V widens via f64x2.promote_low_f32x4');
    const run = (opts) => {
        const { exports } = jz(src, opts);
        const px = exports.resize(48, 32);
        if (exports.init) exports.init();
        for (let f = 0; f < 12; f++) exports.frame(f);
        return Array.from(px);
    };
    const simd = run({ ...OPT }), scal = run({ ...OPT, experimentalStencil: false });
    is(simd.length, scal.length);
    is(simd.filter((v, i) => v !== scal[i]).length, 0, 'schrodinger float-index stencil bit-exact vs scalar (1536 px, 12 frames)');
});

// Toroidal-wrap stencils: diffusion's 5-point Gray-Scott and slime's 3×3 diffuse blur both index
// neighbours with a torus wrap (`xw = x>0 ? x-1 : w-1`). The wrap-select is stride-1 in the interior
// (1 ≤ x ≤ w-2); tryStencil treats it as a coeff-1 derived IV and PEELS the boundaries — scalar x=0
// before the SIMD, the SIMD capped at `min(bound, rightWrapBoundary) - (lanes-1)` so no chunk reaches
// a wrap column, the kept scalar tail finishing them. A nested-loop GUARD stops the OUTER y-loop from
// matching (its body holds the inner x-loop). BIT-EXACT (lane-parallel stencil, no reassoc). NOTE:
// slime seeds agents from Math.random, so a fixed randomSeed is required to compare SIMD vs scalar.
test('example: toroidal-wrap stencils (diffusion, slime) vectorize and stay bit-exact', () => {
    const cases = [
        { name: 'diffusion', min: 40, drive: (e) => { const p = e.resize(64, 48); if (e.seedRect) e.seedRect(20, 15, 40, 30); for (let f = 0; f < 8; f++) e.frame(); return [...p]; } },
        { name: 'slime', min: 10, drive: (e) => { const p = e.resize(64, 48); e.seed(); for (let f = 0; f < 20; f++) e.frame(f); return [...p]; } },
    ];
    for (const { name, min, drive } of cases) {
        const src = fs.readFileSync(new URL(`../examples/${name}/${name}.js`, import.meta.url), 'utf8');
        const sten = (jz.compile(src, { ...OPT, wat: true }).match(/f64x2\./g) || []).length;
        ok(sten >= min, `${name} wrap-stencil vectorizes (${sten} f64x2)`);
        const run = (opts) => drive(jz(src, { ...opts, randomSeed: 42 }).exports);
        const simd = run({ ...OPT }), scal = run({ ...OPT, noSimd: true });
        is(simd.length, scal.length);
        is(simd.filter((v, i) => v !== scal[i]).length, 0, `${name} wrap-stencil bit-exact vs scalar (3072 px)`);
    }
});

// Pure-function inline into the per-pixel-color lift: plasma's per-pixel value is fbm(...) ×3 (a
// 5-octave sine helper). foldStrDispatchF64 first removes the dead string-dispatch from $fbm's `+`
// (its params are raw-f64, so the is-string branch can never fire), making $fbm pure; then liftPPC
// inlines the call — substituting lifted lane args for params and lifting the body — so the sines
// become $math.sin2. BIT-EXACT (extract-repack mirror + lane-parallel arithmetic).
test('example: plasma fbm inlines into the per-pixel-color lift (sin → sin2)', () => {
    const src = fs.readFileSync(new URL('../examples/plasma/plasma.js', import.meta.url), 'utf8');
    const wat = jz.compile(src, { ...OPT, wat: true });
    ok((wat.match(/f64x2\./g) || []).length > 80, `plasma vectorizes (${(wat.match(/f64x2\./g) || []).length} f64x2)`);
    ok((wat.match(/\$math\.sin2/g) || []).length >= 6, 'fbm sines lift to $math.sin2');
    // foldStrDispatchF64 removed $fbm's dead `+` string-dispatch (a string-dispatch $fbm would be
    // impure ⇒ never inlined ⇒ no sin2). Other functions may keep legit polymorphic dispatch.
    const fbmStart = wat.indexOf('(func $fbm');
    const fbmRegion = wat.slice(fbmStart, wat.indexOf('(func ', fbmStart + 10));
    ok(!/__is_str_key/.test(fbmRegion), '$fbm is string-dispatch-free (foldStrDispatchF64)');
    const run = (opts) => { const { exports } = jz(src, opts); const px = exports.resize(48, 32); for (let f = 0; f < 4; f++) exports.frame(f * 0.1); return [...px]; };
    const simd = run({ ...OPT }), scal = run({ ...OPT, noSimd: true });
    is(simd.filter((v, i) => v !== scal[i]).length, 0, 'plasma fbm-inline bit-exact vs scalar (1536 px)');
});

// Divergent-escape with per-lane OUTCOME tracking: newton's inner loop converges to one of N roots
// and records which via `(then (local.set $root K) (br))` — a 2-statement break the recognizer now
// accepts, tracking each lane's root in an i32x4 via bitselect on the newly-escaped mask. The
// achievement-ratcheted escape fractals (break-on-first fast path) are untouched. BIT-EXACT.
test('example: newton divergent-escape tracks per-lane outcomes (f64x2) bit-exact', () => {
    const src = fs.readFileSync(new URL('../examples/newton/newton.js', import.meta.url), 'utf8');
    ok((jz.compile(src, { ...OPT, wat: true }).match(/f64x2\./g) || []).length > 0, 'newton vectorizes');
    const run = (opts) => { const { exports } = jz(src, opts); const px = exports.resize(48, 32); if (exports.frame) exports.frame(0); return [...px]; };
    const simd = run({ ...OPT }), scal = run({ ...OPT, noSimd: true });
    is(simd.filter((v, i) => v !== scal[i]).length, 0, 'newton outcome-tracking bit-exact vs scalar (1536 px)');
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

// Transcendental mirror + convert-splat perf wins. domain-color's per-pixel field is atan2/hypot/sin
// of a complex map; the 2-wide $math.atan2_2 + $math.hypot_2 mirrors (extract-repack, bit-exact like
// pow2) let tryPerPixelColor lift it to f64x2. rfft's cepstrum `cep[i]=x[i]/N` (N an i32 global) maps
// once f64.convert_i32_s(invariant) splats. Both are bit-exact by construction.
test('example: domain-color atan2/hypot mirrors vectorize and stay bit-exact', () => {
    const src = fs.readFileSync(new URL('../examples/domain-color/domain-color.js', import.meta.url), 'utf8');
    const wat = jz.compile(src, { ...OPT, wat: true });
    ok((wat.match(/f64x2\./g) || []).length > 20, `domain-color vectorizes via the per-pixel-color pass (${(wat.match(/f64x2\./g) || []).length} f64x2)`);
    ok(/\$math\.atan2_2/.test(wat) && /\$math\.hypot_2/.test(wat), 'atan2 → $math.atan2_2, hypot → $math.hypot_2');
    const run = (opts) => { const { exports } = jz(src, opts); const px = exports.resize(48, 32); if (exports.frame) exports.frame(0); return Array.from(px); };
    const simd = run({ ...OPT }), scal = run({ ...OPT, noSimd: true });
    is(simd.length, scal.length);
    is(simd.filter((v, i) => v !== scal[i]).length, 0, 'domain-color mirror lift bit-exact vs scalar (1536 px)');
});

test('example: rfft cepstrum map vectorizes via convert-splat', () => {
    const src = fs.readFileSync(new URL('../examples/rfft/rfft.js', import.meta.url), 'utf8');
    ok((jz.compile(src, { ...OPT, wat: true }).match(/f64x2\./g) || []).length > 0, 'rfft gains f64x2 (cep[i]=x[i]/N maps once convert(N) splats)');
});
