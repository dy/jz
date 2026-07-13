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
// per lane. chladni hits 2.28× V8 (the two per-row + per-pixel Math.cos → $math.cos2). interference's
// sRGB `a**γ` (constant γ) lowers at emit-time to exp(γ·log a) (module/math.js emitPow), so the pixel
// is sin+sqrt — TRUE 2-wide ($math.sin2 / f64x2.sqrt), not a per-lane-scalar mirror. Pin the
// deterministic cause — chladni takes the per-pixel-color path ($__ppc tail); interference's
// N-source grating has an inner per-source reduction, which per-pixel-color declines by design,
// so it must take the OUTER-STRIP path ($__os) and lift the reduction to f64x2 there. The
// bit-exactness gate lives in test/simd.js.
test('example: per-pixel-color kernels vectorize (chladni cos, interference sin/sqrt)', () => {
    const w = (name) => jz.compile(fs.readFileSync(new URL(`../examples/${name}/${name}.js`, import.meta.url), 'utf8'), { ...OPT, wat: true });
    const ch = w('chladni');
    ok(/\$__ppc\d+/.test(ch), 'chladni must take the per-pixel-color path');
    ok(/call \$math\.cos2/.test(ch), 'chladni per-pixel Math.cos → f64x2 $math.cos2');
    const it = w('interference');
    ok(/\$__os\d+/.test(it), 'interference (N-source grating) must take the outer-strip path');
    ok(/call \$math\.sin2/.test(it) && /f64x2\.sqrt/.test(it),
      'interference: per-source reduction lifts to f64x2 — sin → $math.sin2, sqrt → native f64x2.sqrt');
    ok(!/call \$math\.pow2/.test(it), 'interference never needs the per-lane-scalar $math.pow2 mirror');
});

// Stencil vectorizer (experimental): watercolor's curl / vorticity-confinement / divergence /
// gradient-subtract / capillary-bleed sweeps are 2-D neighbour stencils over f64 fields (the
// Gauss–Seidel pressure loop is loop-carried and rightly stays scalar). With experimentalStencil
// the pure sweeps lift to f64x2 (neighbour loads f[c±1] / f[c±w], derived IV c=r+x). It must be
// BIT-EXACT to the scalar pipeline end-to-end — a lane-parallel stencil reorders nothing per lane.
test('example: watercolor fluid stencils vectorize f64x2 and stay bit-exact', () => {
    const src = fs.readFileSync(new URL('../examples/watercolor/watercolor.js', import.meta.url), 'utf8');
    // experimentalStencil is now default-on at speed (the build options), so the SCALAR baseline
    // turns it explicitly off; the vectorized side is the plain build.
    const base = (jz.compile(src, { ...OPT, experimentalStencil: false, wat: true }).match(/f64x2\./g) || []).length;
    const sten = (jz.compile(src, { ...OPT, wat: true }).match(/f64x2\./g) || []).length;
    ok(sten > base, `watercolor sweeps vectorize via the stencil pass (${base} → ${sten} f64x2)`);
    const run = (opts) => {
        const { exports } = jz(src, opts);
        const px = exports.resize(64, 48);
        exports.clear();
        exports.paint(32, 20, 6, 1.2, 0.4); exports.paint(16, 30, 5, -0.8, 0.2); exports.stir(48, 30, 10, 0.5, -0.9);
        for (let f = 0; f < 30; f++) exports.frame(f);
        return Array.from(px);
    };
    const simd = run({ ...OPT }), scal = run({ ...OPT, experimentalStencil: false });
    is(simd.length, scal.length);
    ok(simd.filter(v => v & 0xffffff).length > 300, `watercolor renders a live field (${simd.filter(v => v & 0xffffff).length} lit) — bit-exact below isn't vacuous`);
    is(simd.filter((v, i) => v !== scal[i]).length, 0, 'watercolor SIMD stencils bit-exact vs scalar (3072 px, 30 frames)');
});

// Stencil vectorizer: waves is the 2-D wave equation — a 9-point sweep over two height
// buffers swapped each frame. With experimentalStencil the inner x-loop lifts to f64x2
// (neighbour loads a[c±1] / a[rn+x], derived IV c=rc+x). BIT-EXACT end-to-end — the swap
// is outside the loop so the in-loop read/write bases stay distinct (no aliasing); the
// caustics splat and tone map are untouched scalar.
test('example: waves wave-equation stencil vectorizes f64x2 and stays bit-exact', () => {
    const src = fs.readFileSync(new URL('../examples/waves/waves.js', import.meta.url), 'utf8');
    const base = (jz.compile(src, { ...OPT, experimentalStencil: false, wat: true }).match(/f64x2\./g) || []).length;
    const sten = (jz.compile(src, { ...OPT, wat: true }).match(/f64x2\./g) || []).length;
    ok(sten > base, `waves frame vectorizes via the stencil pass (${base} → ${sten} f64x2)`);
    const run = (opts) => {
        const { exports } = jz(src, opts);
        // the field must outsize the edge sponge (MARGIN 18 a side) or the render crushes to black
        const px = exports.resize(128, 96);
        exports.clear();
        exports.drop(64, 48); exports.drop(44, 56);
        for (let f = 0; f < 60; f++) exports.frame(f / 60, 150);
        return Array.from(px);
    };
    const simd = run({ ...OPT }), scal = run({ ...OPT, experimentalStencil: false });
    is(simd.length, scal.length);
    // non-vacuous: the caustic map must show real contrast — white fold filaments (red channel
    // saturates only at the caustic highlights) AND deep-teal shadow cells
    const red = simd.map(v => v & 0xff);
    ok(red.filter(v => v > 180).length > 30 && red.filter(v => v < 25).length > 30,
        `waves renders caustic contrast (${red.filter(v => v > 180).length} bright, ${red.filter(v => v < 25).length} dark)`);
    is(simd.filter((v, i) => v !== scal[i]).length, 0, 'waves SIMD stencil bit-exact vs scalar (12288 px, 60 frames)');
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

// Iterated-map reduction (tryIteratedReduce): lyapunov runs a per-pixel logistic recurrence over
// two inner loops (warmup + accumulate), gathers a forcing sequence seq[si] (scalar index), selects
// the rate r = seq[si]<1 ? a : b, and accumulates λ += log|r·(1−2x)| under a per-lane guard. Two
// adjacent pixels strip-mine to f64x2 lanes: x/λ recurrences per-lane, seq/counters scalar, the
// rate-select a v128-typed branch, the log via $math.log_v, the conditional accumulate a bitselect.
// BIT-EXACT — per-lane IEEE arithmetic + the log_v mirror reorder nothing. (Flips a 1.4× warm-V8
// LOSS into a ~1.6× win — the inner reduction is latency-bound, unlike a cheap pixel map.) Isolated
// via the experimentalOuterStrip toggle (the iterated-reduce gate).
test('example: lyapunov iterated-map reduction vectorizes to f64x2 and stays bit-exact', () => {
    const src = fs.readFileSync(new URL('../examples/lyapunov/lyapunov.js', import.meta.url), 'utf8');
    const base = (jz.compile(src, { ...OPT, experimentalOuterStrip: false, wat: true }).match(/f64x2\./g) || []).length;
    const wat = jz.compile(src, { ...OPT, wat: true });
    ok((wat.match(/f64x2\./g) || []).length > base && /\$math\.log_v/.test(wat), `lyapunov iterated-reduce adds f64x2 + log_v (${base} → ${(wat.match(/f64x2\./g) || []).length})`);
    const run = (opts) => {
        const { exports } = jz(src, opts);
        const px = exports.resize(96, 64);
        exports.setSeq(0b10100, 5);
        for (let f = 0; f < 10; f++) exports.frame(f, 0.1, 0.2, 1.5);
        return Array.from(px);
    };
    const simd = run({ ...OPT }), scal = run({ ...OPT, experimentalOuterStrip: false });
    is(simd.length, scal.length);
    ok(simd.filter(v => v & 0xffffff).length > 50, `lyapunov renders a real field (${simd.filter(v => v & 0xffffff).length} lit) — bit-exact below isn't vacuous`);
    is(simd.filter((v, i) => v !== scal[i]).length, 0, 'lyapunov iterated-reduce bit-exact vs scalar (6144 px, 10 frames)');
});

// Achievement ratchet: examples that once shipped scalar (and lost to V8) each gained a SIMD lift
// this cycle. Pin the DETERMINISTIC CAUSE — the op must appear under the exact build options — so a
// compiler regression that drops it fails CI immediately, not via a user's slow demo. (Bit-exactness
// of each lift is gated in test/simd.js + the differential fuzz; here we guard the perf cause.)
test('example: regressed kernels keep their vectorization (byte-fade / pmax / narrow)', () => {
    const watOf = (name) => jz.compile(fs.readFileSync(new URL(`../examples/${name}/${name}.js`, import.meta.url), 'utf8'), { ...OPT, wat: true });
    // nbody + boids: the in-place u8 trail fade `(ink[i]*k)>>8` lifts 16-wide (i16x8 widen → narrow_u).
    for (const name of ['nbody', 'boids']) {
        const w = watOf(name);
        ok(/i16x8\.mul/.test(w) && /i8x16\.narrow_i16x8_u/.test(w), `${name}: trail fade must lift to the 16-wide byte path (i16x8 widen + narrow_u)`);
    }
    // buddhabrot: the density peak-find `if (d > m) m = d` lifts to f64x2.pmax (NaN-exact, relaxedSimd).
    ok(/f64x2\.pmax/.test(watOf('buddhabrot')), 'buddhabrot: density peak-find must lift to f64x2.pmax');
    // fern: the f64→i32 ToInt32 map (`(…)|0`) lifts via the saturating narrow (relaxedSimd).
    ok(/i32x4\.trunc_sat_f64x2_s_zero/.test(watOf('fern')), 'fern: ToInt32 map must lift to i32x4.trunc_sat narrow');
});

// Outer-strip LEGALITY (regression): a per-sample loop whose body is an iterated f64 RECURRENCE
// (lorenz RK4: x/y/z carried across samples, never re-seeded per sample) is NOT a per-pixel
// reduction — its "accumulators" are loop-carried across the outer loop, so strip-mining two
// adjacent samples into f64x2 lanes runs both lanes from the SAME seed and halves the real work,
// producing a WRONG (and bogus-fast) result. The strip-miner must reject it. Bit-exact speed-vs-
// scalar is the guard; the chaotic recurrence amplifies any 1-ulp divergence into a visible delta.
test('outer-strip rejects loop-carried recurrences (lorenz) — speed ≡ scalar', () => {
    const src = `
const xs = new Float64Array(4096)
export let run = () => {
  let x = 0.1, y = 0.0, z = 0.0
  const DT = 0.002, H = DT * 0.5, S = DT / 6, SIGMA = 10.0, RHO = 28.0, BETA = 8.0 / 3.0
  for (let s = 0; s < 4096; s++) {
    for (let i = 0; i < 16; i++) {
      const k1x = SIGMA*(y-x), k1y = x*(RHO-z)-y, k1z = x*y-BETA*z
      const ax = x+k1x*H, ay = y+k1y*H, az = z+k1z*H
      const k2x = SIGMA*(ay-ax), k2y = ax*(RHO-az)-ay, k2z = ax*ay-BETA*az
      const bx = x+k2x*H, by = y+k2y*H, bz = z+k2z*H
      const k3x = SIGMA*(by-bx), k3y = bx*(RHO-bz)-by, k3z = bx*by-BETA*bz
      const cx = x+k3x*DT, cy = y+k3y*DT, cz = z+k3z*DT
      const k4x = SIGMA*(cy-cx), k4y = cx*(RHO-cz)-cy, k4z = cx*cy-BETA*cz
      x = x+S*(k1x+2*k2x+2*k3x+k4x); y = y+S*(k1y+2*k2y+2*k3y+k4y); z = z+S*(k1z+2*k2z+2*k3z+k4z)
    }
    xs[s] = x + y + z
  }
  let h = 0.0, j = 0
  while (j < 4096) { h = h + xs[j] * (j + 1); j++ }
  return h
}`;
    const speed = jz(src, { ...OPT }).exports.run();
    const scalar = jz(src, { optimize: 0 }).exports.run();
    is(speed, scalar, 'lorenz recurrence: speed result bit-identical to scalar (no illegal outer-strip)');
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
    // frame is (t, are, aim, vcx, vcy, vscale) — the gallery pan/zoom refactor added the view + the
    // animated polynomial coefficient (are≈1.32, aim≈0 at the home phase). Driving frame(0) alone
    // leaves are/aim/view undefined→NaN → an all-black field, which makes the bit-exact check vacuous
    // (scalar-NaN == SIMD-NaN). Pass real args AND assert a real field so it can't silently degenerate.
    const run = (opts) => { const { exports } = jz(src, opts); const px = exports.resize(48, 32); if (exports.frame) exports.frame(0, 1.32, 0.0, 0, 0, 1.6); return [...px]; };
    const simd = run({ ...OPT }), scal = run({ ...OPT, noSimd: true });
    ok(simd.filter(v => v & 0xffffff).length > 1000, `newton renders a real field (${simd.filter(v => v & 0xffffff).length}/1536 lit), not blank`);
    is(simd.filter((v, i) => v !== scal[i]).length, 0, 'newton outcome-tracking bit-exact vs scalar (1536 px)');
});

// lorenz renders an f32 energy field then composites it paper→ink. It was refactored from a
// conditional trail-fade store (`if (p & 0xffffff) px[i] = fade(p)`) to an UNCONDITIONAL opaque
// composite (every pixel written = exactly the paper colour where dark, so no faded smudges linger
// on a light theme). The standalone conditional-store→bitselect lift it used to exercise is now
// unit-covered in test/simd.js ("conditional STORE form"); here we pin the refactored example's
// correctness + scalar/SIMD agreement. NOTE: the unconditional composite (clamp f32 energy → lerp
// → pack ARGB → store) does NOT vectorize yet — the per-pixel-color pass only lifts the u32-density
// tonemap shape — so this is also the regression guard for vectorizing it (it must stay bit-exact).
test('example: lorenz energy composite renders + stays bit-exact scalar↔SIMD', () => {
    const src = fs.readFileSync(new URL('../examples/lorenz/lorenz.js', import.meta.url), 'utf8');
    const run = (opts) => { const { exports } = jz(src, { ...opts, randomSeed: 5 }); const px = exports.resize(80, 60); if (exports.init) exports.init(); for (let f = 0; f < 30; f++) exports.frame(f * 0.05, 0.3); return [...px]; };
    const simd = run({ ...OPT }), scal = run({ ...OPT, noSimd: true });
    ok(simd.filter(v => v & 0xffffff).length > 200, `lorenz renders a real attractor (${simd.filter(v => v & 0xffffff).length} lit px), not blank`);
    is(simd.filter((v, i) => v !== scal[i]).length, 0, 'lorenz composite bit-exact vs scalar (4800 px, 30 frames)');
});

// Mixed-lane log-tonemap (tryToneMap): fern / attractors both end in a flat loop that
// loads an i32 density, lifts it to f64 for `Math.log(d+1)*S`, clamps, truncates back to i32, packs an
// ARGB word, and (conditionally) stores it — i32 lanes wrapping an f64 ISLAND that the single-lane lift
// can't carry. The 2-wide hybrid loads 2 u32 (load64_zero → i32x4 low lanes), `f64x2.convert_low_i32x4_s`
// into the island, `$math.log_v` + clamp, `i32x4.trunc_sat_f64x2_s_zero` back out, packs, and masked-
// stores the low 2 lanes. BIT-EXACT per lane (log_v is the per-lane mirror; clamp keeps L finite so
// trunc_sat == |0; masks match their data width). fern seeds dens via Math.random ⇒ fixed randomSeed.
// (bifurcation deliberately tonemaps via a precomputed LUT — the per-pixel log was slower than scalar —
// so it no longer takes this path and isn't a case here.)
test('example: log-tonemap (fern/attractors) vectorizes mixed-lane f64x2 + bit-exact', () => {
    const cases = [
        // fern is (t, sway, panX, panY, zoom) — the pan/zoom refactor added the last three; driving
        // frame(f, 0.2) left them undefined→NaN → a blank field (bit-exact vacuously true). Pass the home view.
        { name: 'fern',        w: 37, h: 49, drive: (e) => { const px = e.resize(37, 49); if (e.init) e.init(); for (let f = 0; f < 4; f++) e.frame(f, 0.2, 0, 0, 1); return [...px]; } },
        // attractors is (a, b, c, d, iters, panX, panY, zoom) — the pan/zoom refactor added the last
        // three; driving without them left them undefined→NaN → a blank field. Pass the home view.
        { name: 'attractors',  w: 45, h: 37, drive: (e) => { const px = e.resize(45, 37); for (let f = 0; f < 3; f++) e.frame(1.4, -2.3, 2.4, -2.1, 15000, 0, 0, 1); return [...px]; } },
    ];
    for (const { name, drive } of cases) {
        const src = fs.readFileSync(new URL(`../examples/${name}/${name}.js`, import.meta.url), 'utf8');
        // experimentalToneMap is default-on at speed; the SCALAR baseline turns it explicitly off.
        const base = (jz.compile(src, { ...OPT, experimentalToneMap: false, wat: true }).match(/f64x2\./g) || []).length;
        const wat = jz.compile(src, { ...OPT, wat: true });
        const tm = (wat.match(/f64x2\./g) || []).length;
        ok(tm > base, `${name} tonemap vectorizes (${base} → ${tm} f64x2)`);
        ok(/call \$math\.log_v/.test(wat), `${name} lifts Math.log → the f64x2 mirror $math.log_v`);
        const run = (opts) => drive(jz(src, { ...opts, randomSeed: 7 }).exports);
        const simd = run({ ...OPT }), scal = run({ ...OPT, experimentalToneMap: false });
        is(simd.length, scal.length);
        ok(simd.filter(v => v & 0xffffff).length > 50, `${name} renders a real field (${simd.filter(v => v & 0xffffff).length} lit), not blank — bit-exact below isn't vacuous`);
        is(simd.filter((v, i) => v !== scal[i]).length, 0, `${name} mixed-lane tonemap bit-exact vs scalar (${cases.find(c => c.name === name).w * cases.find(c => c.name === name).h} px)`);
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

// Every jukebox voice must compile to valid, instantiable wasm — the bytes
// examples/jukebox/build.mjs writes and pages.yml deploys (compile(moduleSrc(body),
// {optimize:3}), identical here). Compiled in-memory rather than read off disk: the
// .wasm artifacts are gitignored build output (built by build:examples, AFTER this
// suite runs), so a disk read fails in CI and from a clean checkout. This tests the
// real property — each floatbeat lowers to deployable wasm — order-independently.
test('example: jukebox floatbeats compile to deployable wasm', async () => {
    for (let i = 0; i < FLOATBEATS.length; i++) {
        const bytes = jz.compile(moduleSrc(FLOATBEATS[i].body), { optimize: 3 });
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
        // Digital Rain 6→12: watr's inlineWrappers (speed tier) dissolves the
        // closure-ABI trampoline by DUPLICATING the beat body into it — the
        // standalone stays for direct calls, so static __to_num sites double
        // while per-sample boxing is unchanged (each call runs one copy).
        'Digital Rain': 12, 'Neo-Noir Jazz Lounge': 0, 'Celesta Dreams': 0,
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

        let width = 0, height = 0, offset = 0;
        let mem;

        let init = (w, h, alive, dead, rot_val) => {
            BGR_ALIVE = alive;
            BGR_DEAD = dead;
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

                    // clean binary Life: alive (2-3 neighbours) → full-bright, else → background
                    let self = mem[y * w + x];
                    let live = (self & 1) ? ((aliveNeighbors & 0b1110) == 0b0010) : (aliveNeighbors == 3);
                    mem[offset + (y * width + x)] = live ? (BGR_ALIVE | 0xff000000) >>> 0 : (BGR_DEAD | 0xff000000) >>> 0;
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
    // Pass a REAL constant c (cx,cy ≠ 0) AND a finite scale — frame(0) alone left every pixel 0
    // (cx=cy=0 is a degenerate field), so a SIMD-all-zero miscompile read "bit-exact" against
    // scalar-all-zero and slipped through. frame is (t, cx, cy, panX, panY, scale): omitting scale
    // leaves it undefined→NaN, which also blacks the whole field (every mode), masking the real test.
    const run = (opts) => { const { exports } = jz(src, opts); const px = exports.resize(48, 32); if (exports.frame) exports.frame(0, 0.37, 0.21, 0, 0, 1.5); return Array.from(px); };
    const simd = run({ ...OPT }), scal = run({ ...OPT, noSimd: true });
    is(simd.length, scal.length);
    ok(simd.filter(v => v & 0xffffff).length > 1400, `domain-color SIMD renders a real field, not all-black (${simd.filter(v => v & 0xffffff).length}/1536 lit)`);
    is(simd.filter((v, i) => v !== scal[i]).length, 0, 'domain-color mirror lift bit-exact vs scalar (1536 px)');
});

test('example: rfft cepstrum map vectorizes via convert-splat', () => {
    const src = fs.readFileSync(new URL('../examples/rfft/rfft.js', import.meta.url), 'utf8');
    ok((jz.compile(src, { ...OPT, wat: true }).match(/f64x2\./g) || []).length > 0, 'rfft gains f64x2 (cep[i]=x[i]/N maps once convert(N) splats)');
});
