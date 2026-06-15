// Analytic ray tracer — three spheres on a checkered floor under one directional
// light. Per pixel: build a look-at camera ray, intersect the scene (closed-form
// ray/sphere + ray/plane), then shade with ambient + diffuse + a Blinn specular
// highlight, a hard shadow ray toward the light, and one mirror-reflection bounce
// off the spheres. Misses fall through to a vertical sky gradient.
//
// All math is plain f64 multiply/add with a handful of per-pixel divides (ray
// normalise, plane t, sphere normal) — no per-pixel transcendentals. The work is
// embarrassingly parallel: every pixel is independent, so jz keeps pace with V8.
// resize(w,h) → Uint32Array; frame(t) mutates px in place, returns nothing.

let W = 0, H = 0, px
let invW = 0, invH = 0, aspect = 0

// Scene: 3 spheres (center xyz + radius) and their base colors.
let sx = new Float64Array(3)
let sy = new Float64Array(3)
let sz = new Float64Array(3)
let sr = new Float64Array(3)
let cr = new Float64Array(3)
let cg = new Float64Array(3)
let cb = new Float64Array(3)

let PY = -0.5                                   // ground plane height
let LX = 0.3939, LY = 0.7878, LZ = -0.4727     // normalize(0.5, 1.0, -0.6) — light dir

let HIT = -1            // set by intersect(), read immediately after (never across a call)

// pack 0..1 rgb → 0xRRGGBB int, so shading functions return color as one value
// (no mutable color globals read across calls — that diverged between jz and js).
let packc = (r, g, b) => {
  let ir = (r * 255.0) | 0, ig = (g * 255.0) | 0, ib = (b * 255.0) | 0
  if (ir > 255) ir = 255
  if (ir < 0) ir = 0
  if (ig > 255) ig = 255
  if (ig < 0) ig = 0
  if (ib > 255) ib = 255
  if (ib < 0) ib = 0
  return (ir << 16) | (ig << 8) | ib
}

export let resize = (w, h) => {
  W = w; H = h
  invW = 1.0 / w; invH = 1.0 / h
  aspect = w * invH
  px = new Uint32Array(w * h)
  return px
}

export let init = () => {
  // big pearl + blue + warm sphere, each resting on the floor (cy = PY + r)
  sx[0] = 0.0;   sy[0] = 0.0;   sz[0] = 0.0;   sr[0] = 0.5
  sx[1] = 0.92;  sy[1] = -0.22; sz[1] = 0.15;  sr[1] = 0.28
  sx[2] = -0.85; sy[2] = -0.18; sz[2] = -0.25; sr[2] = 0.32
  // monochrome: three distinct grays (B&W scene)
  cr[0] = 0.92; cg[0] = 0.92; cb[0] = 0.92     // bright
  cr[1] = 0.58; cg[1] = 0.58; cb[1] = 0.58     // mid
  cr[2] = 0.36; cg[2] = 0.36; cb[2] = 0.36     // dark
}

// Any-hit test for shadow rays — early-out, leaves HIT untouched.
let occluded = (ox, oy, oz, dx, dy, dz, tmax) => {
  let s = 0
  while (s < 3) {
    let ux = ox - sx[s], uy = oy - sy[s], uz = oz - sz[s]
    let b = ux * dx + uy * dy + uz * dz
    let c = ux * ux + uy * uy + uz * uz - sr[s] * sr[s]
    let disc = b * b - c
    if (disc >= 0.0) {
      let tt = -b - Math.sqrt(disc)
      if (tt > 0.002 && tt < tmax) return 1.0
    }
    s++
  }
  return 0.0
}

// Sky gradient for ray misses → packed gray.
let sky = (dy) => {
  let tsky = dy * 0.5 + 0.5
  if (tsky < 0.0) tsky = 0.0
  if (tsky > 1.0) tsky = 1.0
  let s = 0.72 - 0.42 * tsky          // gray gradient: lighter at the horizon
  return packc(s, s, s)
}

// Local shading (ambient + diffuse + shadow + Blinn specular) → packed color.
let localShade = (hx, hy, hz, nx, ny, nz, br, bg, bb, dx, dy, dz) => {
  let ndl = nx * LX + ny * LY + nz * LZ
  if (ndl < 0.0) ndl = 0.0
  let sh = occluded(hx + nx * 0.003, hy + ny * 0.003, hz + nz * 0.003, LX, LY, LZ, 50.0)
  let lit = ndl * (1.0 - sh)
  let amb = 0.2
  // Blinn-Phong specular via half-vector H = normalize(L - rd)
  let hvx = LX - dx, hvy = LY - dy, hvz = LZ - dz
  let hl = 1.0 / Math.sqrt(hvx * hvx + hvy * hvy + hvz * hvz)
  let nh = (nx * hvx + ny * hvy + nz * hvz) * hl
  if (nh < 0.0) nh = 0.0
  let spec = nh * nh; spec = spec * spec; spec = spec * spec; spec = spec * spec   // ^16
  spec = spec * (1.0 - sh)
  let k = amb + lit * 0.85
  return packc(br * k + spec * 0.7, bg * k + spec * 0.7, bb * k + spec * 0.7)
}

// Nearest-hit across the scene; returns t, sets HIT (0..2 sphere, 3 plane, -1 miss).
let intersect = (ox, oy, oz, dx, dy, dz, tmax) => {
  let minT = tmax
  let hit = -1
  let s = 0
  while (s < 3) {
    let ux = ox - sx[s], uy = oy - sy[s], uz = oz - sz[s]
    let b = ux * dx + uy * dy + uz * dz
    let c = ux * ux + uy * uy + uz * uz - sr[s] * sr[s]
    let disc = b * b - c
    if (disc >= 0.0) {
      let tt = -b - Math.sqrt(disc)
      if (tt > 0.001 && tt < minT) { minT = tt; hit = s }
    }
    s++
  }
  if (dy < -0.000001 || dy > 0.000001) {
    let tp = (PY - oy) / dy
    if (tp > 0.001 && tp < minT) { minT = tp; hit = 3 }
  }
  HIT = hit
  return minT
}

// Shade the nearest hit of a ray, no further bounces → packed color.
let rayColor = (ox, oy, oz, dx, dy, dz) => {
  let t = intersect(ox, oy, oz, dx, dy, dz, 50.0)
  let h = HIT
  if (h < 0) return sky(dy)
  let hx = ox + dx * t, hy = oy + dy * t, hz = oz + dz * t
  if (h === 3) {
    // checkerboard floor
    let cf = Math.floor(hx * 1.5) + Math.floor(hz * 1.5)
    let chk = cf - 2.0 * Math.floor(cf * 0.5)
    let g = chk < 0.5 ? 0.62 : 0.18
    return localShade(hx, hy, hz, 0.0, 1.0, 0.0, g, g, g, dx, dy, dz)
  }
  let inv = 1.0 / sr[h]
  let nx = (hx - sx[h]) * inv, ny = (hy - sy[h]) * inv, nz = (hz - sz[h]) * inv
  return localShade(hx, hy, hz, nx, ny, nz, cr[h], cg[h], cb[h], dx, dy, dz)
}

// Camera eye is passed as f64 args (not a global) so jz never narrows it to i32 —
// that's what kept jz's camera/rays in sync with js.
export let frame = (eyeX, eyeY, eyeZ) => {
  // Look-at camera: eye → origin, world-up (0,1,0).
  let invEyeLen = 1.0 / Math.sqrt(eyeX * eyeX + eyeY * eyeY + eyeZ * eyeZ)
  let fwdX = -eyeX * invEyeLen, fwdY = -eyeY * invEyeLen, fwdZ = -eyeZ * invEyeLen
  let rtX = fwdZ, rtZ = -fwdX
  let invRt = 1.0 / Math.sqrt(rtX * rtX + rtZ * rtZ)
  rtX = rtX * invRt; rtZ = rtZ * invRt
  let upX = -rtZ * fwdY, upY = rtZ * fwdX - rtX * fwdZ, upZ = rtX * fwdY

  let j = 0, py = 0
  while (py < H) {
    let vy = (py * invH - 0.5) * 2.0
    let qx = 0
    while (qx < W) {
      let vx = (qx * invW - 0.5) * 2.0 * aspect
      let rdX = fwdX + rtX * vx + upX * vy
      let rdY = fwdY + upY * vy             // right vector has no Y component
      let rdZ = fwdZ + rtZ * vx + upZ * vy
      let inv = 1.0 / Math.sqrt(rdX * rdX + rdY * rdY + rdZ * rdZ)
      rdX = rdX * inv; rdY = rdY * inv; rdZ = rdZ * inv

      let tt = intersect(eyeX, eyeY, eyeZ, rdX, rdY, rdZ, 50.0)
      let h = HIT
      let col = 0
      if (h < 0) {
        col = sky(rdY)
      } else {
        let hx = eyeX + rdX * tt, hy = eyeY + rdY * tt, hz = eyeZ + rdZ * tt
        let nx = 0.0, ny = 0.0, nz = 0.0, br = 0.0, bg = 0.0, bb = 0.0, refl = 0.0
        if (h === 3) {
          nx = 0.0; ny = 1.0; nz = 0.0
          let cf = Math.floor(hx * 1.5) + Math.floor(hz * 1.5)
          let chk = cf - 2.0 * Math.floor(cf * 0.5)
          let gg = chk < 0.5 ? 0.62 : 0.18
          br = gg; bg = gg; bb = gg; refl = 0.0
        } else {
          let invr = 1.0 / sr[h]
          nx = (hx - sx[h]) * invr; ny = (hy - sy[h]) * invr; nz = (hz - sz[h]) * invr
          br = cr[h]; bg = cg[h]; bb = cb[h]; refl = 0.32
        }
        col = localShade(hx, hy, hz, nx, ny, nz, br, bg, bb, rdX, rdY, rdZ)
        if (refl > 0.0) {
          let rdotn = rdX * nx + rdY * ny + rdZ * nz
          let rx = rdX - 2.0 * rdotn * nx
          let ry = rdY - 2.0 * rdotn * ny
          let rz = rdZ - 2.0 * rdotn * nz
          let rc = rayColor(hx + rx * 0.003, hy + ry * 0.003, hz + rz * 0.003, rx, ry, rz)
          let mr = ((col >> 16) & 255) * (1.0 - refl) + ((rc >> 16) & 255) * refl
          let mg = ((col >> 8) & 255) * (1.0 - refl) + ((rc >> 8) & 255) * refl
          let mb = (col & 255) * (1.0 - refl) + (rc & 255) * refl
          col = ((mr | 0) << 16) | ((mg | 0) << 8) | (mb | 0)
        }
      }

      let ir = (col >> 16) & 255, ig = (col >> 8) & 255, ib = col & 255
      if (ir > 255) ir = 255
      if (ig > 255) ig = 255
      if (ib > 255) ib = 255
      if (ir < 0) ir = 0
      if (ig < 0) ig = 0
      if (ib < 0) ib = 0
      px[j] = (255 << 24) | (ib << 16) | (ig << 8) | ir
      j++; qx++
    }
    py++
  }
}
