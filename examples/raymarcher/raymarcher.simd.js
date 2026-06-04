// Raymarcher — 4-wide SIMD (f32x4), same image as raymarcher.js. Four neighbouring
// rays march in masked lockstep: each step advances every still-active lane, freezing a
// lane (via bitselect) once it hits (d<0.001) or misses (tt>20), until all four are done.
// The SDF, the central-difference normal, and the shading all run 4 lanes at once, so jz
// emits wasm SIMD and beats warm V8 scalar (no auto-SIMD for this divergent loop). The
// camera basis is scalar (once per frame). Bare f32x4.* are native in jz; under plain V8
// the harness installs examples/lib/simd.js. Output is grayscale (r=g=b=v).
let W = 0, H = 0, px;
let invW = 0, invH = 0, aspect = 0;

export let resize = (w, h) => {
  W = w; H = h; invW = 1.0 / w; invH = 1.0 / h; aspect = w * invH;
  px = new Uint32Array(w * h);
  return px;
};
export let dataOffset = () => px;

const EPS = 0.002;

// Domain-repeated sphere field (period 4 in x/z, 3 in y), 4 lanes.
let sdRep = (x, y, z) => {
  let rx = f32x4.add(x, f32x4.splat(2.0));
  rx = f32x4.sub(f32x4.sub(rx, f32x4.mul(f32x4.splat(4.0), f32x4.floor(f32x4.mul(rx, f32x4.splat(0.25))))), f32x4.splat(2.0));
  let ry = f32x4.add(y, f32x4.splat(1.5));
  ry = f32x4.sub(f32x4.sub(ry, f32x4.mul(f32x4.splat(3.0), f32x4.floor(f32x4.mul(ry, f32x4.splat(0.333333333))))), f32x4.splat(1.5));
  let rz = f32x4.add(z, f32x4.splat(2.0));
  rz = f32x4.sub(f32x4.sub(rz, f32x4.mul(f32x4.splat(4.0), f32x4.floor(f32x4.mul(rz, f32x4.splat(0.25))))), f32x4.splat(2.0));
  let len = f32x4.sqrt(f32x4.add(f32x4.add(f32x4.mul(rx, rx), f32x4.mul(ry, ry)), f32x4.mul(rz, rz)));
  return f32x4.sub(len, f32x4.splat(0.55));
};
// Scene = min(sphere field, ground plane y=-1.4), 4 lanes.
let sdf = (x, y, z) => f32x4.min(sdRep(x, y, z), f32x4.add(y, f32x4.splat(1.4)));

export let frame = (t) => {
  let camAngle = t * 0.3;
  let eyeX = Math.sin(camAngle) * 3.5;
  let eyeY = 1.2 + Math.sin(t * 0.17) * 0.6;
  let eyeZ = Math.cos(camAngle) * 3.5;
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
      let fog = f32x4.max(zero, f32x4.sub(one, f32x4.mul(f32x4.convertI32(steps), f32x4.splat(0.01563))));
      // plane vs sphere = argmin of the scene SDF at the hit
      let isPlane = f32x4.lt(f32x4.add(hy, f32x4.splat(1.4)), sdRep(hx, hy, hz));
      // ball: reflection env + specular
      let rdotn = f32x4.add(f32x4.add(f32x4.mul(rdX, nx), f32x4.mul(rdY, ny)), f32x4.mul(rdZ, nz));
      let rflX = f32x4.sub(rdX, f32x4.mul(f32x4.mul(two, rdotn), nx));
      let rflY = f32x4.sub(rdY, f32x4.mul(f32x4.mul(two, rdotn), ny));
      let rflZ = f32x4.sub(rdZ, f32x4.mul(f32x4.mul(two, rdotn), nz));
      let env = f32x4.max(zero, f32x4.neg(rflY));
      let spec = f32x4.max(zero, f32x4.add(f32x4.add(f32x4.mul(rflX, lxv), f32x4.mul(rflY, lyv)), f32x4.mul(rflZ, lzv)));
      spec = f32x4.mul(spec, spec); spec = f32x4.mul(spec, spec);
      let ballVal = f32x4.mul(f32x4.min(one, f32x4.add(f32x4.add(f32x4.add(f32x4.splat(0.15), f32x4.mul(diff, f32x4.splat(0.18))), f32x4.mul(env, f32x4.splat(0.6))), f32x4.mul(spec, f32x4.splat(0.7)))), fog);
      let val = v128.bitselect(fog, ballVal, isPlane);
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
