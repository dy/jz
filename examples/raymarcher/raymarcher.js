// Raymarcher — SDF sphere field on the CPU. Per pixel: build a camera ray (eye
// at (0,0,−3.5) orbiting slowly), march up to 64 steps: p = ro + rd·tt; d = sdf(p);
// tt += d; stop when d<0.001 or tt>20. Scene: domain-repeated spheres
// (mod(p+2,4)−2) plus a ground plane. Normal by central differences, shaded by
// a single directional light + fog from step count, a sphere-traced soft shadow
// and a short normal-probe ambient occlusion so contact points actually read as
// contact (see softShadow / calcAO below).
//
// The march is a per-pixel recurrence (tt accumulates), so jz will roughly TIE
// V8 — this is the expected result for marched SDFs. No per-step divides.
// The normalise ray is done once per pixel with a precomputed inv-length.
// resize(w,h) → Uint32Array; frame(t) mutates px in place, returns nothing.

let W = 0, H = 0, px
let invW = 0, invH = 0, aspect = 0

// Sphere-field config in a Float64Array (so jz never i32-narrows these floats):
// [0]=radius  [1..3]=period x/y/z  [4..6]=1/period  [7..9]=period/2
let cfg = new Float64Array(10)
let setCfg = (r, pxp, pyp, pzp) => {
  cfg[0] = r; cfg[1] = pxp; cfg[2] = pyp; cfg[3] = pzp
  cfg[4] = 1.0 / pxp; cfg[5] = 1.0 / pyp; cfg[6] = 1.0 / pzp
  cfg[7] = pxp * 0.5; cfg[8] = pyp * 0.5; cfg[9] = pzp * 0.5
}

export let resize = (w, h) => {
  W = w; H = h
  invW = 1.0 / w
  invH = 1.0 / h
  aspect = w * invH                // w/h divide, done once at resize not per-pixel
  px = new Uint32Array(w * h)
  setCfg(0.55, 4.0, 3.0, 4.0)      // default lattice
  return px
}

// re-roll: a different ball composition — fatter/leaner spheres on a tighter/looser lattice
export let randomize = () => {
  setCfg(0.40 + Math.random() * 0.34, 3.0 + Math.random() * 2.6, 2.4 + Math.random() * 1.7, 3.0 + Math.random() * 2.6)
}

// ---- SDF helpers (no divides) -----------------------------------------------

// Smooth absolute value (for torus etc)
let absSDF = (x) => x < 0.0 ? -x : x

// Signed distance to a sphere of radius r centred at origin
let sdSphere = (px2, py, pz, r) => {
  let len = Math.sqrt(px2 * px2 + py * py + pz * pz)
  return len - r
}

// Ground plane at y = -1.4
let sdPlane = (py) => py + 1.4

// Domain-repeated sphere field: period 4 in x and z, repeat along y with period 3
let sdRepSpheres = (px2, py, pz) => {
  // mod(p + half, period) - half  →  fract-based centering, no divide
  let hx = 2.0, hy = 1.5, hz = 2.0
  let rx = px2 + hx
  let ry = py + hy
  let rz = pz + hz
  // floor via bit-trick not available in jz; use Math.floor (it's a stdlib call, not divide)
  rx = rx - 4.0 * Math.floor(rx * 0.25)   // 0.25 = reciprocal, precomputed as literal
  ry = ry - 3.0 * Math.floor(ry * 0.333333333)
  rz = rz - 4.0 * Math.floor(rz * 0.25)
  rx = rx - hx
  ry = ry - hy
  rz = rz - hz
  return sdSphere(rx, ry, rz, 0.55)
}

// Scene: union of sphere field and ground plane
let sdf = (px2, py, pz) => {
  let d1 = sdRepSpheres(px2, py, pz)
  let d2 = sdPlane(py)
  return d1 < d2 ? d1 : d2
}

// Surface normal by central differences (6 sdf calls per pixel hit, cheap)
let EPS = 0.002

// March along ray (ox,oy,oz) + dir*(dx,dy,dz). Returns the hit distance `tt`
// (a positive Number) on a hit, or -1 on a miss — so the fractional distance
// rides the f64 return value, never a module global. (jz narrows a scalar f64
// global that's only ever assigned an unproven-integer value to i32 for index
// speed, which would truncate `tt`; the step count IS an integer, so it travels
// safely in the `scratchSteps` i32 global, read right after the call.)
let scratchSteps = 0

let march = (ox, oy, oz, dx, dy, dz) => {
  let tt = 0.001
  let k = 0
  while (k < 64) {
    let px2 = ox + dx * tt
    let py = oy + dy * tt
    let pz = oz + dz * tt
    let d = sdf(px2, py, pz)
    if (d < 0.001) {
      scratchSteps = k
      return tt           // hit: positive distance
    }
    tt = tt + d
    if (tt > 20.0) {
      scratchSteps = k
      return -1.0         // miss
    }
    k++
  }
  scratchSteps = k
  return -1.0             // miss — step budget exhausted
}

// ---- Soft shadow + ambient occlusion (both are read-only probes off the same sdf) ----------

// Sphere-traced soft shadow (Quilez): march toward the light, tracking the tightest
// grazing angle seen (min of k·h/t) instead of a hard occluded/lit boolean — a near-miss
// narrows the penumbra continuously. Capped at 32 steps. res only ever shrinks from 1.0
// (never negative — h is ≥0.001 whenever we reach the k·h/t line, since a smaller h
// returns 0 immediately), so no clamp is needed on the way out.
//
// MAXT is deliberately ONE lattice period, not "a couple" (the previous 6.0 reached far
// enough to graze the NEXT repeated sphere layer — period 3 in y, and this light's climb
// rate is 0.577 — 3/0.577 ≈ 5.2 — producing thin hard-edged grazing streaks across the
// floor that read as scratches). The contact ellipses under each sphere are cast by
// same-layer neighbours and fully saturate by t≈3.5, so 4.0 keeps every real shadow and
// drops only the false next-layer contamination.
let SHADOW_K = 12.0
let SHADOW_STEPS = 32
let SHADOW_MAXT = 4.0
let SHADOW_FADE_START = 6.0     // camera-distance beyond which shadow eases back to 1.0
let SHADOW_HIT_MAXDIST = 9.0    // …and fully off (skip the march) — was a hard on/off
                                 // switch (a visible cliff: measured shadow jumping e.g.
                                 // 0.85→1.0 between adjacent pixels straddling this line,
                                 // not "without changing a single output pixel" as claimed).
                                 // Now the last SHADOW_FADE_START…HIT_MAXDIST stretch
                                 // smoothsteps the computed value back to 1.0, so it lands
                                 // exactly on the skipped region's constant with no seam —
                                 // same pixels do the march either way, so no cost added.

let softShadow = (ox, oy, oz, dx, dy, dz) => {
  let res = 1.0
  let t = 0.02
  let i = 0
  while (i < SHADOW_STEPS && t < SHADOW_MAXT) {
    let d = sdf(ox + dx * t, oy + dy * t, oz + dz * t)
    if (d < 0.001) return 0.0
    let v = SHADOW_K * d / t
    if (v < res) res = v
    t = t + d
    i++
  }
  return res
}

// Cheap ambient occlusion: 4 short probes stepping out along the normal, comparing the
// sdf's actual reading at each probe to the probe's nominal distance — reading closer than
// that means nearby geometry is crowding the surface (a crevice: sphere/floor seams, two
// lattice cells' near sides). 4 sdf() calls, same cost class as one more central-difference tap.
let calcAO = (px2, py, pz, nx, ny, nz) => {
  let occ = 0.0
  let sca = 1.0
  let i = 0
  while (i < 4) {
    let h = 0.02 + 0.06 * i
    let d = sdf(px2 + nx * h, py + ny * h, pz + nz * h)
    occ = occ + (h - d) * sca
    sca = sca * 0.6
    i++
  }
  let ao = 1.0 - 2.5 * occ
  if (ao < 0.0) ao = 0.0
  if (ao > 1.0) ao = 1.0
  return ao
}

// Eye passed as f64 args (a setter global gets narrowed to i32 in jz, freezing the
// camera); all-zero falls back to the built-in t-orbit.
export let frame = (t, eyeX, eyeY, eyeZ) => {
  if (eyeX === 0.0 && eyeY === 0.0 && eyeZ === 0.0) {
    let camAngle = t * 0.3
    eyeX = Math.sin(camAngle) * 3.5
    eyeY = 1.2 + Math.sin(t * 0.17) * 0.6
    eyeZ = Math.cos(camAngle) * 3.5
  }

  // Camera basis: look-at origin
  // Forward
  let invEyeLen = 1.0 / Math.sqrt(eyeX * eyeX + eyeY * eyeY + eyeZ * eyeZ)
  let fwdX = -eyeX * invEyeLen
  let fwdY = -eyeY * invEyeLen
  let fwdZ = -eyeZ * invEyeLen

  // Right = fwd × worldUp (0,1,0): (fwdZ*0 - fwdY*0, fwdY*0 - fwdZ*1, fwdZ*0 - fwdX*0)
  // simplified: right = (fwdZ, 0, -fwdX), then normalise
  let rtX = fwdZ
  let rtY = 0.0
  let rtZ = -fwdX
  let invRtLen = 1.0 / Math.sqrt(rtX * rtX + rtZ * rtZ)
  rtX = rtX * invRtLen
  rtZ = rtZ * invRtLen

  // Up = right × fwd
  let upX = rtY * fwdZ - rtZ * fwdY
  let upY = rtZ * fwdX - rtX * fwdZ
  let upZ = rtX * fwdY - rtY * fwdX

  // Light direction (fixed, normalised at frame start)
  let lx = 0.5774, ly = 0.5774, lz = 0.5774   // normalize(1,1,1) ≈ these literals

  let j = 0
  let py = 0
  while (py < H) {
    let vy = (py * invH - 0.5) * 2.0       // [-1, +1]
    let qx = 0
    while (qx < W) {
      let vx = (qx * invW - 0.5) * 2.0 * aspect   // account for aspect

      // Ray direction (not yet normalised)
      let rdX = fwdX + rtX * vx + upX * vy
      let rdY = fwdY + rtY * vx + upY * vy
      let rdZ = fwdZ + rtZ * vx + upZ * vy

      // Normalise ray direction — one divide (inv-length), done once per pixel
      let rdLen = Math.sqrt(rdX * rdX + rdY * rdY + rdZ * rdZ)
      let invRdLen = 1.0 / rdLen
      rdX = rdX * invRdLen
      rdY = rdY * invRdLen
      rdZ = rdZ * invRdLen

      let tt = march(eyeX, eyeY, eyeZ, rdX, rdY, rdZ)
      let steps = scratchSteps

      let r = 0, g = 0, bl = 0
      if (tt >= 0.0) {
        // Surface position
        let hx = eyeX + rdX * tt
        let hy = eyeY + rdY * tt
        let hz = eyeZ + rdZ * tt

        // Normal by central differences (no divide — EPS is a constant)
        let nx = sdf(hx + EPS, hy, hz) - sdf(hx - EPS, hy, hz)
        let ny = sdf(hx, hy + EPS, hz) - sdf(hx, hy - EPS, hz)
        let nz = sdf(hx, hy, hz + EPS) - sdf(hx, hy, hz - EPS)
        let invNLen = 1.0 / Math.sqrt(nx * nx + ny * ny + nz * nz)
        nx = nx * invNLen
        ny = ny * invNLen
        nz = nz * invNLen

        // Diffuse shading
        let diff = nx * lx + ny * ly + nz * lz
        if (diff < 0.0) diff = 0.0

        // Soft shadow toward the light — skip the march when the surface already
        // self-shadows (diff===0, so it would multiply to 0 regardless) or the hit is far
        // enough that fog mostly hides it anyway (SHADOW_HIT_MAXDIST) — same pixels run the
        // march either way, so this costs nothing extra. The last stretch before the cutoff
        // smoothsteps the result back to 1.0 so it meets the skipped region with no seam.
        let shadow = 1.0
        if (diff > 0.0 && tt < SHADOW_HIT_MAXDIST) {
          shadow = softShadow(hx + nx * 0.01, hy + ny * 0.01, hz + nz * 0.01, lx, ly, lz)
          if (tt > SHADOW_FADE_START) {
            let ft = (tt - SHADOW_FADE_START) / (SHADOW_HIT_MAXDIST - SHADOW_FADE_START)
            ft = ft * ft * (3.0 - 2.0 * ft)   // smoothstep — C1 continuous at both ends
            shadow = shadow + (1.0 - shadow) * ft
          }
        }
        let direct = diff * shadow

        // Ambient occlusion — darkens creases (sphere/floor seams, near-touching lattice cells).
        let ao = calcAO(hx, hy, hz, nx, ny, nz)

        // Fog by step count — distant surfaces fade toward the black sky
        let fog = 1.0 - steps * 0.01563   // 1/64 ≈ 0.015625
        if (fog < 0.0) fog = 0.0

        // Which surface did we hit? plane vs sphere = argmin of the scene SDF here.
        let dPlane = sdPlane(hy)
        let dSph = sdRepSpheres(hx, hy, hz)
        let val = 0.0
        if (dPlane < dSph) {
          // PLANE → ambient·AO + shadowed diffuse, fading to black toward the horizon
          val = 0.08 * ao + direct * 0.85
          if (val > 1.0) val = 1.0
          val = val * fog
        } else {
          // BALL → reflective gray: base gray + a mirror reflection of the white
          // floor (reflected ray pointing down) vs the black sky (up), plus a tight
          // specular glint toward the light — both the diffuse term and the specular
          // glint go dark together in shadow (env is indirect light, so it doesn't).
          let rdotn = rdX * nx + rdY * ny + rdZ * nz
          let reflX = rdX - 2.0 * rdotn * nx
          let reflY = rdY - 2.0 * rdotn * ny
          let reflZ = rdZ - 2.0 * rdotn * nz
          let env = -reflY
          if (env < 0.0) env = 0.0
          let spec = reflX * lx + reflY * ly + reflZ * lz
          if (spec < 0.0) spec = 0.0
          spec = spec * spec
          spec = spec * spec
          spec = spec * shadow
          val = 0.10 * ao + direct * 0.20 + env * 0.55 + spec * 0.7
          if (val > 1.0) val = 1.0
          val = val * fog
        }
        let v = (val * 255.0) | 0
        if (v > 255) v = 255
        if (v < 0) v = 0
        r = v; g = v; bl = v
      } else {
        // Atmosphere → black
        r = 0; g = 0; bl = 0
      }

      px[j] = (255 << 24) | (bl << 16) | (g << 8) | r
      j++; qx++
    }
    py++
  }
}
