// Raymarcher — 4-wide SIMD (f32x4), same image as raymarcher.js. Four neighbouring
// rays march in masked lockstep: each step advances every still-active lane, freezing a
// lane (via bitselect) once it hits (d<0.001) or misses (tt>20), until all four are done.
// The SDF, the central-difference normal, and the shading all run 4 lanes at once, so jz
// emits wasm SIMD and beats warm V8 scalar (no auto-SIMD for this divergent loop). The
// camera basis is scalar (once per frame). Bare f32x4.* are native in jz; under plain V8
// the harness installs examples/lib/simd.js. Output is grayscale (r=g=b=v).
//
// Soft shadow (softShadow) and ambient occlusion (calcAO) mirror raymarcher.js's algorithm
// exactly (same constants), just lane-wise: the shadow march reuses the primary march's
// active/hit masked-lockstep idiom (a per-lane early exit on hit or on passing SHADOW_MAXT),
// the AO probe is a fixed 4-tap unrolled loop (no divergence, so no masking needed). f32
// lanes vs f64 scalar means a few ULPs of difference, never a visible one.
let W = 0, H = 0, px;
let invW = 0, invH = 0, aspect = 0;

// Sphere-field config in a Float64Array (so jz never i32-narrows these floats):
// [0]=radius  [1..3]=period x/y/z  [4..6]=1/period  [7..9]=period/2
let cfg = new Float64Array(10);
let setCfg = (r, pxp, pyp, pzp) => {
  cfg[0] = r; cfg[1] = pxp; cfg[2] = pyp; cfg[3] = pzp;
  cfg[4] = 1.0 / pxp; cfg[5] = 1.0 / pyp; cfg[6] = 1.0 / pzp;
  cfg[7] = pxp * 0.5; cfg[8] = pyp * 0.5; cfg[9] = pzp * 0.5;
};

export let resize = (w, h) => {
  W = w; H = h; invW = 1.0 / w; invH = 1.0 / h; aspect = w * invH;
  px = new Uint32Array(w * h);
  setCfg(0.55, 4.0, 3.0, 4.0);   // default lattice
  return px;
};
export let dataOffset = () => px;

// re-roll: a different ball composition — fatter/leaner spheres on a tighter/looser lattice
export let randomize = () => {
  setCfg(0.40 + Math.random() * 0.34, 3.0 + Math.random() * 2.6, 2.4 + Math.random() * 1.7, 3.0 + Math.random() * 2.6);
};

const EPS = 0.002;

// Domain-repeated sphere field (period & radius from cfg), 4 lanes.
let sdRep = (x, y, z) => {
  let rx = f32x4.add(x, f32x4.splat(cfg[7]));
  rx = f32x4.sub(f32x4.sub(rx, f32x4.mul(f32x4.splat(cfg[1]), f32x4.floor(f32x4.mul(rx, f32x4.splat(cfg[4]))))), f32x4.splat(cfg[7]));
  let ry = f32x4.add(y, f32x4.splat(cfg[8]));
  ry = f32x4.sub(f32x4.sub(ry, f32x4.mul(f32x4.splat(cfg[2]), f32x4.floor(f32x4.mul(ry, f32x4.splat(cfg[5]))))), f32x4.splat(cfg[8]));
  let rz = f32x4.add(z, f32x4.splat(cfg[9]));
  rz = f32x4.sub(f32x4.sub(rz, f32x4.mul(f32x4.splat(cfg[3]), f32x4.floor(f32x4.mul(rz, f32x4.splat(cfg[6]))))), f32x4.splat(cfg[9]));
  let len = f32x4.sqrt(f32x4.add(f32x4.add(f32x4.mul(rx, rx), f32x4.mul(ry, ry)), f32x4.mul(rz, rz)));
  return f32x4.sub(len, f32x4.splat(cfg[0]));
};
// Scene = min(sphere field, ground plane y=-1.4), 4 lanes.
let sdf = (x, y, z) => f32x4.min(sdRep(x, y, z), f32x4.add(y, f32x4.splat(1.4)));

// Eye passed as f64 args (a setter global gets narrowed to i32 in jz, freezing the
// camera); all-zero falls back to the built-in t-orbit.
export let frame = (t, eyeX, eyeY, eyeZ) => {
  if (eyeX === 0.0 && eyeY === 0.0 && eyeZ === 0.0) {
    let camAngle = t * 0.3;
    eyeX = Math.sin(camAngle) * 3.5;
    eyeY = 1.2 + Math.sin(t * 0.17) * 0.6;
    eyeZ = Math.cos(camAngle) * 3.5;
  }
  let invEyeLen = 1.0 / Math.sqrt(eyeX * eyeX + eyeY * eyeY + eyeZ * eyeZ);
  let fwdX = -eyeX * invEyeLen, fwdY = -eyeY * invEyeLen, fwdZ = -eyeZ * invEyeLen;
  let rtX = fwdZ, rtZ = -fwdX;
  let invRtLen = 1.0 / Math.sqrt(rtX * rtX + rtZ * rtZ);
  rtX = rtX * invRtLen; rtZ = rtZ * invRtLen;
  let upX = -rtZ * fwdY, upY = rtZ * fwdX - rtX * fwdZ, upZ = rtX * fwdY;
  let lx = 0.5774, ly = 0.5774, lz = 0.5774;

  // per-frame splats (loop-invariant)
  let eXv = f32x4.splat(eyeX), eYv = f32x4.splat(eyeY), eZv = f32x4.splat(eyeZ);
  let lxv = f32x4.splat(lx), lyv = f32x4.splat(ly), lzv = f32x4.splat(lz);
  let eps = f32x4.splat(EPS), zero = f32x4.splat(0.0), one = f32x4.splat(1.0), two = f32x4.splat(2.0);
  let lane = f32x4.lanes(0.0, 1.0, 2.0, 3.0);

  let py = 0;
  while (py < H) {
    let vy = (py * invH - 0.5) * 2.0;
    let vyv = f32x4.splat(vy);
    let base = py * W;
    let qx = 0;
    while (qx < W) {
      // vx for the 4 lanes: ((qx+0..3)*invW - 0.5) * 2 * aspect
      let vx = f32x4.mul(f32x4.sub(f32x4.mul(f32x4.add(f32x4.splat(qx), lane), f32x4.splat(invW)), f32x4.splat(0.5)), f32x4.splat(2.0 * aspect));
      let rdX = f32x4.add(f32x4.add(f32x4.splat(fwdX), f32x4.mul(f32x4.splat(rtX), vx)), f32x4.mul(f32x4.splat(upX), vyv));
      let rdY = f32x4.add(f32x4.splat(fwdY), f32x4.mul(f32x4.splat(upY), vyv));
      let rdZ = f32x4.add(f32x4.add(f32x4.splat(fwdZ), f32x4.mul(f32x4.splat(rtZ), vx)), f32x4.mul(f32x4.splat(upZ), vyv));
      let inv = f32x4.div(one, f32x4.sqrt(f32x4.add(f32x4.add(f32x4.mul(rdX, rdX), f32x4.mul(rdY, rdY)), f32x4.mul(rdZ, rdZ))));
      rdX = f32x4.mul(rdX, inv); rdY = f32x4.mul(rdY, inv); rdZ = f32x4.mul(rdZ, inv);

      // march all 4 in lockstep
      let tt = f32x4.splat(0.001), active = i32x4.splat(-1), res = f32x4.splat(-1.0), steps = i32x4.splat(0);
      let k = 0;
      while (k < 64) {
        if (v128.anyTrue(active)) {
          let d = sdf(f32x4.add(eXv, f32x4.mul(rdX, tt)), f32x4.add(eYv, f32x4.mul(rdY, tt)), f32x4.add(eZv, f32x4.mul(rdZ, tt)));
          let hit = v128.and(active, f32x4.lt(d, f32x4.splat(0.001)));
          res = v128.bitselect(tt, res, hit);
          steps = v128.bitselect(i32x4.splat(k), steps, hit);
          active = v128.and(active, v128.not(hit));
          tt = v128.bitselect(f32x4.add(tt, d), tt, active);
          let miss = v128.and(active, f32x4.gt(tt, f32x4.splat(20.0)));
          steps = v128.bitselect(i32x4.splat(k), steps, miss);
          active = v128.and(active, v128.not(miss));
          k++;
        } else { k = 64; }
      }
      steps = v128.bitselect(i32x4.splat(64), steps, active);   // exhausted → miss

      // shade (all lanes; miss lanes blacked out at the end)
      let hx = f32x4.add(eXv, f32x4.mul(rdX, res)), hy = f32x4.add(eYv, f32x4.mul(rdY, res)), hz = f32x4.add(eZv, f32x4.mul(rdZ, res));
      let nx = f32x4.sub(sdf(f32x4.add(hx, eps), hy, hz), sdf(f32x4.sub(hx, eps), hy, hz));
      let ny = f32x4.sub(sdf(hx, f32x4.add(hy, eps), hz), sdf(hx, f32x4.sub(hy, eps), hz));
      let nz = f32x4.sub(sdf(hx, hy, f32x4.add(hz, eps)), sdf(hx, hy, f32x4.sub(hz, eps)));
      let ninv = f32x4.div(one, f32x4.sqrt(f32x4.add(f32x4.add(f32x4.mul(nx, nx), f32x4.mul(ny, ny)), f32x4.mul(nz, nz))));
      nx = f32x4.mul(nx, ninv); ny = f32x4.mul(ny, ninv); nz = f32x4.mul(nz, ninv);
      let diff = f32x4.max(zero, f32x4.add(f32x4.add(f32x4.mul(nx, lxv), f32x4.mul(ny, lyv)), f32x4.mul(nz, lzv)));

      // soft shadow, inlined (a v128 helper with internal control flow can't cross a jz
      // function boundary — only simple single-expression v128 functions can, like sdf/
      // sdRep above; so this mirrors the primary march's own masked-lockstep shape, just
      // toward the light instead of along the view ray). shadowActive gates entry per lane
      // (diff>0 & hit close enough) — mirrors raymarcher.js's `if (diff>0.0 && tt<9.0)`
      // early-out, a free win when a whole group of 4 fails the gate together. Constants
      // (k=12, 32 steps, maxT=6, bias=0.01) match raymarcher.js exactly.
      let shadowActive = v128.and(f32x4.gt(diff, zero), f32x4.lt(res, f32x4.splat(9.0)));
      let nb = f32x4.splat(0.01);
      let sox = f32x4.add(hx, f32x4.mul(nx, nb)), soy = f32x4.add(hy, f32x4.mul(ny, nb)), soz = f32x4.add(hz, f32x4.mul(nz, nb));
      let shadow = f32x4.splat(1.0), st = f32x4.splat(0.02), sact = shadowActive;
      let si = 0;
      while (si < 32) {
        if (v128.anyTrue(sact)) {
          let sd = sdf(f32x4.add(sox, f32x4.mul(lxv, st)), f32x4.add(soy, f32x4.mul(lyv, st)), f32x4.add(soz, f32x4.mul(lzv, st)));
          let shit = v128.and(sact, f32x4.lt(sd, f32x4.splat(0.001)));
          shadow = v128.bitselect(zero, shadow, shit);
          sact = v128.and(sact, v128.not(shit));
          let sv = f32x4.div(f32x4.mul(f32x4.splat(12.0), sd), st);
          shadow = v128.bitselect(f32x4.min(shadow, sv), shadow, sact);
          st = v128.bitselect(f32x4.add(st, sd), st, sact);
          let spast = v128.and(sact, f32x4.ge(st, f32x4.splat(6.0)));
          sact = v128.and(sact, v128.not(spast));
          si++;
        } else { si = 32; }
      }
      let direct = f32x4.mul(diff, shadow);

      // ambient occlusion, inlined — fixed 4-tap unrolled probe, no early exit so no
      // masking needed (every lane always takes all 4 taps, matching the always-shade-
      // then-blend style the rest of this file already uses for miss lanes).
      let aocc = f32x4.splat(0.0), asca = f32x4.splat(1.0);
      let ai = 0;
      while (ai < 4) {
        let ah = f32x4.splat(0.02 + 0.06 * ai);
        let ad = sdf(f32x4.add(hx, f32x4.mul(nx, ah)), f32x4.add(hy, f32x4.mul(ny, ah)), f32x4.add(hz, f32x4.mul(nz, ah)));
        aocc = f32x4.add(aocc, f32x4.mul(f32x4.sub(ah, ad), asca));
        asca = f32x4.mul(asca, f32x4.splat(0.6));
        ai++;
      }
      let ao = f32x4.min(one, f32x4.max(zero, f32x4.sub(one, f32x4.mul(f32x4.splat(2.5), aocc))));

      let fog = f32x4.max(zero, f32x4.sub(one, f32x4.mul(f32x4.convertI32(steps), f32x4.splat(0.01563))));
      // plane vs sphere = argmin of the scene SDF at the hit
      let isPlane = f32x4.lt(f32x4.add(hy, f32x4.splat(1.4)), sdRep(hx, hy, hz));
      // ball: reflection env + specular (both diffuse and specular go dark together in
      // shadow — env is indirect light off the floor/sky, so it doesn't)
      let rdotn = f32x4.add(f32x4.add(f32x4.mul(rdX, nx), f32x4.mul(rdY, ny)), f32x4.mul(rdZ, nz));
      let rflX = f32x4.sub(rdX, f32x4.mul(f32x4.mul(two, rdotn), nx));
      let rflY = f32x4.sub(rdY, f32x4.mul(f32x4.mul(two, rdotn), ny));
      let rflZ = f32x4.sub(rdZ, f32x4.mul(f32x4.mul(two, rdotn), nz));
      let env = f32x4.max(zero, f32x4.neg(rflY));
      let spec = f32x4.max(zero, f32x4.add(f32x4.add(f32x4.mul(rflX, lxv), f32x4.mul(rflY, lyv)), f32x4.mul(rflZ, lzv)));
      spec = f32x4.mul(spec, spec); spec = f32x4.mul(spec, spec);
      spec = f32x4.mul(spec, shadow);
      let planeVal = f32x4.mul(f32x4.min(one, f32x4.add(f32x4.mul(f32x4.splat(0.08), ao), f32x4.mul(direct, f32x4.splat(0.85)))), fog);
      let ballVal = f32x4.mul(f32x4.min(one, f32x4.add(f32x4.add(f32x4.add(f32x4.mul(f32x4.splat(0.10), ao), f32x4.mul(direct, f32x4.splat(0.20))), f32x4.mul(env, f32x4.splat(0.55))), f32x4.mul(spec, f32x4.splat(0.7)))), fog);
      let val = v128.bitselect(planeVal, ballVal, isPlane);
      // grayscale 0..255, then black out the misses (res < 0)
      let v = f32x4.min(f32x4.splat(255.0), f32x4.max(zero, f32x4.mul(val, f32x4.splat(255.0))));
      v = v128.bitselect(v, zero, f32x4.ge(res, zero));

      // pack each in-bounds lane (grayscale → ABGR)
      if (qx < W)     { let g = f32x4.lane(v, 0) | 0; px[base + qx]     = -16777216 | (g << 16) | (g << 8) | g; }
      if (qx + 1 < W) { let g = f32x4.lane(v, 1) | 0; px[base + qx + 1] = -16777216 | (g << 16) | (g << 8) | g; }
      if (qx + 2 < W) { let g = f32x4.lane(v, 2) | 0; px[base + qx + 2] = -16777216 | (g << 16) | (g << 8) | g; }
      if (qx + 3 < W) { let g = f32x4.lane(v, 3) | 0; px[base + qx + 3] = -16777216 | (g << 16) | (g << 8) | g; }
      qx = qx + 4;
    }
    py++;
  }
};
