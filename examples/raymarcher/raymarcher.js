// Raymarcher — SDF sphere field on the CPU. Per pixel: build a camera ray (eye
// at (0,0,−3.5) orbiting slowly), march up to 64 steps: p = ro + rd·tt; d = sdf(p);
// tt += d; stop when d<0.001 or tt>20. Scene: domain-repeated spheres
// (mod(p+2,4)−2) plus a ground plane. Normal by central differences, shaded by
// a single directional light + fog from step count.
//
// The march is a per-pixel recurrence (tt accumulates), so jz will roughly TIE
// V8 — this is the expected result for marched SDFs. No per-step divides.
// The normalise ray is done once per pixel with a precomputed inv-length.
// resize(w,h) → Uint32Array; frame(t) mutates px in place, returns nothing.

let W = 0, H = 0, px
let invW = 0, invH = 0, aspect = 0

export let resize = (w, h) => {
  W = w; H = h
  invW = 1.0 / w
  invH = 1.0 / h
  aspect = w * invH                // w/h divide, done once at resize not per-pixel
  px = new Uint32Array(w * h)
  return px
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

export let frame = (t) => {
  // Camera: orbit around origin, eye at radius 3.5
  let camAngle = t * 0.3
  let eyeX = Math.sin(camAngle) * 3.5
  let eyeY = 1.2 + Math.sin(t * 0.17) * 0.6
  let eyeZ = Math.cos(camAngle) * 3.5

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

        // Ambient + diffuse
        let bright = 0.12 + diff * 0.88

        // Fog by step count — heavier = more steps = more distant
        let fog = 1.0 - steps * 0.01563   // 1/64 ≈ 0.015625
        if (fog < 0.0) fog = 0.0
        bright = bright * fog

        // Colour: teal-ish (r=0.4, g=0.85, b=1.0) surface shading
        let rf = bright * 0.4
        let gf = bright * 0.85
        let bf = bright * 1.0

        r = (rf * 255.0) | 0
        g = (gf * 255.0) | 0
        bl = (bf * 255.0) | 0
        if (r > 255) r = 255
        if (g > 255) g = 255
        if (bl > 255) bl = 255
      } else {
        // Sky gradient — top cool blue, bottom warm orange, no divide
        let skyT = vy * 0.5 + 0.5     // [0..1], no divide (vy already in [-1,+1])
        let skyT2 = skyT * skyT
        // Sky: lerp from warm horizon (255,180,100) to cool zenith (30,60,120)
        r = (255 - skyT2 * 230.0) | 0
        g = (180 - skyT2 * 130.0) | 0
        bl = (100 + skyT2 * 30.0) | 0
        if (r < 0) r = 0
        if (g < 0) g = 0
        if (bl < 0) bl = 0
        // Sun glow: if ray near light dir, boost
        let sunDot = rdX * lx + rdY * ly + rdZ * lz
        if (sunDot > 0.992) {
          let sg = ((sunDot - 0.992) * 125.0 * 255.0) | 0
          if (sg > 255) sg = 255
          r = r + sg; if (r > 255) r = 255
          g = g + sg; if (g > 255) g = 255
          bl = bl + (sg >> 1); if (bl > 255) bl = 255
        }
      }

      px[j] = (255 << 24) | (bl << 16) | (g << 8) | r
      j++; qx++
    }
    py++
  }
}
