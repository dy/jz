// Analytic ray tracer — five objects on a checkered floor under one (softly shadowed)
// directional light. Per pixel: build a look-at camera ray, intersect the scene
// (closed-form ray/sphere + ray/plane), then shade with ambient + diffuse + a Blinn
// specular highlight, a JITTERED soft shadow ray toward the light, and one
// mirror-reflection bounce off the four opaque spheres. The fifth sphere is glass:
// Snell refraction in, an analytic straight line to the far side (the "one internal
// bounce" point), Snell refraction back out — Schlick Fresnel blends the outer
// reflection against the refracted-through color at both faces, and total internal
// reflection at the exit face is handled by reflecting once instead of transmitting.
// Misses fall through to a vertical sky gradient.
//
// All math is plain f64 multiply/add with a handful of per-pixel divides (ray
// normalise, plane t, sphere normal) — no per-pixel transcendentals, no Math.sin/cos/pow
// (jz's polynomial approximations for those are NOT bit-identical to V8's — see rnd()
// below). The work is embarrassingly parallel: every pixel is independent, so jz keeps
// pace with V8. resize(w,h) → Uint32Array; frame(t) mutates px in place, returns nothing.

let W = 0, H = 0, px
let invW = 0, invH = 0, aspect = 0

// Scene: 5 spheres (center xyz + radius) and their base colors — indices 0..3 are
// opaque (diffuse + a little mirror), index GLASS_IDX is the refractive one (its
// cr/cg/cb are unused: shadeGlassSphere never reads them, glass has no albedo).
let OPAQUE_N = 4
let GLASS_IDX = 4
let NSPHERES = 5
let PLANE_HIT = 5       // hit id for the floor — was the literal 3 when there were only 3
                         // spheres; now that sphere index 3 is a real object, the floor's id
                         // must move past every valid sphere index (0..NSPHERES-1)
let sx = new Float64Array(5)
let sy = new Float64Array(5)
let sz = new Float64Array(5)
let sr = new Float64Array(5)
let cr = new Float64Array(5)
let cg = new Float64Array(5)
let cb = new Float64Array(5)
let GLASS_IOR = 1.5

let PY = -0.5                                   // ground plane height
let LX = 0.3939, LY = 0.7878, LZ = -0.4727     // normalize(0.5, 1.0, -0.6) — light dir

// Tangent basis perpendicular to L (cross with world-up, re-cross for orthonormality),
// so the shadow ray can be jittered within the light's angular disk (soft shadows).
// Fixed constants → this folds to literals at compile time, zero per-frame cost.
let Tx = LY * 0.0 - LZ * 1.0, Ty = LZ * 0.0 - LX * 0.0, Tz = LX * 1.0 - LY * 0.0
let Tinv = 1.0 / Math.sqrt(Tx * Tx + Ty * Ty + Tz * Tz)
Tx = Tx * Tinv; Ty = Ty * Tinv; Tz = Tz * Tinv
let Bx = LY * Tz - LZ * Ty, By = LZ * Tx - LX * Tz, Bz = LX * Ty - LY * Tx
let LIGHT_RADIUS = 0.14
let SHADOW_SAMPLES = 4

// Deterministic per-pixel-per-sample hash RNG (lowbias32, Chris Wellons) — used ONLY to
// jitter shadow-ray samples. Never Math.random: rngPix/rngN key an integer avalanche mix,
// so JS and the compiled jz module draw the exact same "random" sequence and stay
// bit-exact. rngPix is set once per pixel in frame() (and stays put across the reflection/
// refraction bounce's own shadow rays); rngN advances on every draw within that pixel.
let rngPix = 0, rngN = 0

let hash32 = (n) => {
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d)
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b)
  n = n ^ (n >>> 16)
  return n
}

let rnd = () => {
  let h = Math.imul(rngPix, 0x9e3779b1) ^ Math.imul(rngN, 0xc2b2ae3d)
  rngN = rngN + 1
  h = hash32(h)
  return (h >>> 0) * 2.3283064365386963e-10   // → [0,1)
}

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
  // extra small sphere, foreground-right, for composition
  sx[3] = 0.15;  sy[3] = -0.30; sz[3] = 0.85;  sr[3] = 0.20
  // monochrome: distinct grays (B&W scene)
  cr[0] = 0.92; cg[0] = 0.92; cb[0] = 0.92     // bright
  cr[1] = 0.58; cg[1] = 0.58; cb[1] = 0.58     // mid
  cr[2] = 0.36; cg[2] = 0.36; cb[2] = 0.36     // dark
  cr[3] = 0.70; cg[3] = 0.70; cb[3] = 0.70     // light
  // glass sphere — front-and-center "hero" object, closer to camera than the opaque cluster
  // and clear of their shadows (placing it IN another sphere's shadow was tried first: the
  // refracted view then mostly showed dark, shadowed floor — technically correct but an ugly
  // composition). x=0.25, not 0.0: dead-center sits exactly on a checkerboard grid seam
  // (Math.floor(hx*1.5) flips sign at hx=0), so a face-on view refracted a stark clean
  // black/white bisection instead of a distorted checker pattern; nudging off the seam fixes
  // it at every orbit angle, not just the ones that happen to look past it. Fixed, like the
  // opaque spheres above; randomize() doesn't touch it.
  sx[GLASS_IDX] = 0.25; sy[GLASS_IDX] = -0.08; sz[GLASS_IDX] = 1.60; sr[GLASS_IDX] = 0.42
}

// re-roll: scatter the opaque spheres at fresh spots, sizes and grays (all still resting on
// the floor); the glass sphere is a fixed centerpiece and isn't touched here.
export let randomize = () => {
  let i = 0
  while (i < OPAQUE_N) {
    let r = 0.20 + Math.random() * 0.30
    sx[i] = (Math.random() - 0.5) * 2.3
    sz[i] = (Math.random() - 0.5) * 1.3
    sr[i] = r
    sy[i] = PY + r
    let g = 0.30 + Math.random() * 0.64
    cr[i] = g; cg[i] = g; cb[i] = g
    i++
  }
}

// Any-hit test for shadow rays against the OPAQUE spheres — early-out, leaves HIT untouched.
// The glass sphere casts no hard shadow (a correct hard occlusion test for a refractive
// object needs to trace through it, which is exactly what shadeGlassSphere already does for
// primary/reflected rays that hit it directly — a plain boolean any-hit would just wrongly
// paint a solid dark disc under it).
let occluded = (ox, oy, oz, dx, dy, dz, tmax) => {
  let s = 0
  while (s < OPAQUE_N) {
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

// Soft shadow: SHADOW_SAMPLES jittered rays toward the (disk-shaped, angular radius
// LIGHT_RADIUS) area light, hash-jittered per (pixel, sample) — see rnd() — averaged into a
// continuous 0 (fully shadowed) .. 1 (fully lit) factor instead of occluded()'s hard boolean.
let softShadow = (ox, oy, oz) => {
  let lit = 0.0
  let s = 0
  while (s < SHADOW_SAMPLES) {
    let jx = rnd() - 0.5, jy = rnd() - 0.5
    let ldx = LX + (Tx * jx + Bx * jy) * LIGHT_RADIUS
    let ldy = LY + (Ty * jx + By * jy) * LIGHT_RADIUS
    let ldz = LZ + (Tz * jx + Bz * jy) * LIGHT_RADIUS
    let ilen = 1.0 / Math.sqrt(ldx * ldx + ldy * ldy + ldz * ldz)
    ldx = ldx * ilen; ldy = ldy * ilen; ldz = ldz * ilen
    if (occluded(ox, oy, oz, ldx, ldy, ldz, 50.0) === 0.0) lit = lit + 1.0
    s++
  }
  return lit * 0.25   // SHADOW_SAMPLES fixed at 4 — a clean constant reciprocal, no divide
}

// Sky gradient for ray misses → packed gray.
let sky = (dy) => {
  let tsky = dy * 0.5 + 0.5
  if (tsky < 0.0) tsky = 0.0
  if (tsky > 1.0) tsky = 1.0
  let s = 0.72 - 0.42 * tsky          // gray gradient: lighter at the horizon
  return packc(s, s, s)
}

// Local shading (ambient + diffuse + soft shadow + Blinn specular) → packed color.
let localShade = (hx, hy, hz, nx, ny, nz, br, bg, bb, dx, dy, dz) => {
  let ndl = nx * LX + ny * LY + nz * LZ
  if (ndl < 0.0) ndl = 0.0
  let shFrac = softShadow(hx + nx * 0.003, hy + ny * 0.003, hz + nz * 0.003)
  let lit = ndl * shFrac
  let amb = 0.2
  // Blinn-Phong specular via half-vector H = normalize(L - rd)
  let hvx = LX - dx, hvy = LY - dy, hvz = LZ - dz
  let hl = 1.0 / Math.sqrt(hvx * hvx + hvy * hvy + hvz * hvz)
  let nh = (nx * hvx + ny * hvy + nz * hvz) * hl
  if (nh < 0.0) nh = 0.0
  let spec = nh * nh; spec = spec * spec; spec = spec * spec; spec = spec * spec   // ^16
  spec = spec * shFrac
  let k = amb + lit * 0.85
  return packc(br * k + spec * 0.7, bg * k + spec * 0.7, bb * k + spec * 0.7)
}

// Nearest-hit across the scene; returns t, sets HIT (0..NSPHERES-1 = sphere index, one of
// which — GLASS_IDX — the caller dispatches to shadeGlassSphere instead of localShade;
// PLANE_HIT = the floor; -1 = miss). intersect() only cares about geometry, not material.
let intersect = (ox, oy, oz, dx, dy, dz, tmax) => {
  let minT = tmax
  let hit = -1
  let s = 0
  while (s < NSPHERES) {
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
    if (tp > 0.001 && tp < minT) { minT = tp; hit = PLANE_HIT }
  }
  HIT = hit
  return minT
}

// Schlick's approximation for Fresnel reflectance (cosTheta = cos of the incidence angle on
// the INCOMING side, eta = n_incident / n_transmitted).
let schlick = (cosTheta, eta) => {
  let r0 = (1.0 - eta) / (1.0 + eta)
  r0 = r0 * r0
  let m = 1.0 - cosTheta
  return r0 + (1.0 - r0) * m * m * m * m * m
}

// Shade a ray that hit the glass sphere: Snell refraction at the entry face, an analytic
// straight line through the sphere to the far face (the near/far roots of the SAME
// quadratic — since the segment starts ON the sphere, c≈0 and the two roots are 0 and the
// exit distance, so this is the "one internal bounce" point), Snell refraction back out.
// Schlick Fresnel blends the entry face's outer reflection against whatever the far-face
// ray finds. If the far face is beyond the critical angle (total internal reflection), it
// reflects once off the inside wall and makes ONE more exit attempt from there — never
// past that (a ray direction pointing back into the sphere can't be handed to the generic
// rayColor/intersect, which assume ray origins outside every sphere); if that ALSO TIRs
// (rare — a doubly-grazing entry), it gives up chasing further bounces and shows the outer
// reflection alone, per the task's "one internal bounce" cap. (Mutual recursion with
// rayColor below is fine — neither is CALLED until frame() runs, well after the whole
// module has finished defining both.)
//
// Sign note: the vector refraction formula needs the normal ANTI-parallel to the incident
// ray (dot(d,n) < 0). At the entry face n1 already is (it's the outward normal, and the ray
// arrives from outside, against it) — but at an exit face the ray travels from INSIDE, i.e.
// WITH the outward normal (dot(d2,n2) > 0), so the formula there subtracts the normal term
// instead of adding it (equivalent to negating n2 first). Verified against both a head-on
// and an oblique ray in scratch before landing on this (the +n2 version silently produced a
// non-unit, wrongly-bent exit ray — the glass sphere rendered as a flat black disc).
let shadeGlassSphere = (ox, oy, oz, dx, dy, dz, t1) => {
  let cx = sx[GLASS_IDX], cy = sy[GLASS_IDX], cz = sz[GLASS_IDX], r = sr[GLASS_IDX]
  let invr = 1.0 / r
  let p1x = ox + dx * t1, p1y = oy + dy * t1, p1z = oz + dz * t1
  let n1x = (p1x - cx) * invr, n1y = (p1y - cy) * invr, n1z = (p1z - cz) * invr

  let ddn1 = dx * n1x + dy * n1y + dz * n1z
  let rx = dx - 2.0 * ddn1 * n1x, ry = dy - 2.0 * ddn1 * n1y, rz = dz - 2.0 * ddn1 * n1z

  let eta1 = 1.0 / GLASS_IOR                    // air -> glass (never TIRs entering)
  let cosI1 = -ddn1
  let sin2t1 = eta1 * eta1 * (1.0 - cosI1 * cosI1)
  let cosT1 = sin2t1 < 1.0 ? Math.sqrt(1.0 - sin2t1) : 0.0
  let fres1 = schlick(cosI1, eta1)
  let kk1 = eta1 * cosI1 - cosT1
  let d2x = eta1 * dx + kk1 * n1x, d2y = eta1 * dy + kk1 * n1y, d2z = eta1 * dz + kk1 * n1z

  // straight line to the far side: origin p1 is ON the sphere (|u|≈r so c≈0), moving inward
  // along d2 — the two roots of the quadratic are ~0 (p1 itself) and -2b (the far side).
  let qox = p1x + d2x * 0.0015, qoy = p1y + d2y * 0.0015, qoz = p1z + d2z * 0.0015
  let ux = qox - cx, uy = qoy - cy, uz = qoz - cz
  let b2 = ux * d2x + uy * d2y + uz * d2z
  let c2 = ux * ux + uy * uy + uz * uz - r * r
  let disc2 = b2 * b2 - c2
  let sq2 = disc2 > 0.0 ? Math.sqrt(disc2) : 0.0
  let t2 = -b2 + sq2
  let p2x = qox + d2x * t2, p2y = qoy + d2y * t2, p2z = qoz + d2z * t2
  let n2x = (p2x - cx) * invr, n2y = (p2y - cy) * invr, n2z = (p2z - cz) * invr

  let ddn2 = d2x * n2x + d2y * n2y + d2z * n2z    // > 0: d2 exits through the outward normal
  let eta2 = GLASS_IOR                            // glass -> air
  let sin2t2 = eta2 * eta2 * (1.0 - ddn2 * ddn2)

  let ex = 0.0, ey = 0.0, ez = 0.0, epx = p2x, epy = p2y, epz = p2z, fres2 = 1.0, exited = 1
  if (sin2t2 >= 1.0) {
    let ibx = d2x - 2.0 * ddn2 * n2x, iby = d2y - 2.0 * ddn2 * n2y, ibz = d2z - 2.0 * ddn2 * n2z
    let rox = p2x + ibx * 0.0015, roy = p2y + iby * 0.0015, roz = p2z + ibz * 0.0015
    let vx = rox - cx, vy = roy - cy, vz = roz - cz
    let b3 = vx * ibx + vy * iby + vz * ibz
    let c3 = vx * vx + vy * vy + vz * vz - r * r
    let disc3 = b3 * b3 - c3
    let sq3 = disc3 > 0.0 ? Math.sqrt(disc3) : 0.0
    let t3 = -b3 + sq3
    let p3x = rox + ibx * t3, p3y = roy + iby * t3, p3z = roz + ibz * t3
    let n3x = (p3x - cx) * invr, n3y = (p3y - cy) * invr, n3z = (p3z - cz) * invr
    let ddn3 = ibx * n3x + iby * n3y + ibz * n3z
    let sin2t3 = eta2 * eta2 * (1.0 - ddn3 * ddn3)
    if (sin2t3 >= 1.0) {
      exited = 0                                  // doubly-grazing — cap the bounce chase here
    } else {
      // exit refraction: the incident-side normal here is -n3 (n3 is OUTWARD, but the ray
      // travels from inside, i.e. WITH n3, not against it) — the vector refraction formula
      // needs the normal term subtracted, not added, whenever the incident ray already runs
      // the same way as the normal it's refracting through (see the header note above).
      let cosT3 = Math.sqrt(1.0 - sin2t3)
      let kk3 = eta2 * ddn3 - cosT3
      ex = eta2 * ibx - kk3 * n3x; ey = eta2 * iby - kk3 * n3y; ez = eta2 * ibz - kk3 * n3z
      epx = p3x; epy = p3y; epz = p3z
      fres2 = schlick(ddn3, eta2)
    }
  } else {
    // same sign note as the P3 exit above: subtract the normal term at an exit face.
    let cosT2 = Math.sqrt(1.0 - sin2t2)
    let kk2 = eta2 * ddn2 - cosT2
    ex = eta2 * d2x - kk2 * n2x; ey = eta2 * d2y - kk2 * n2y; ez = eta2 * d2z - kk2 * n2z
    fres2 = schlick(ddn2, eta2)
  }

  let reflCol = rayColor(p1x + n1x * 0.003, p1y + n1y * 0.003, p1z + n1z * 0.003, rx, ry, rz)
  let refrCol = reflCol
  let w = 1.0
  if (exited === 1) {
    refrCol = rayColor(epx + ex * 0.003, epy + ey * 0.003, epz + ez * 0.003, ex, ey, ez)
    // refrCol only gets the fraction that survives BOTH faces (1-fres1)*(1-fres2); everything
    // that doesn't make it through — entry reflection + the exit face's own Fresnel loss —
    // is approximated as showing the outer reflection (w is reflCol's weight).
    w = 1.0 - (1.0 - fres1) * (1.0 - fres2)
  }
  let rr = ((reflCol >> 16) & 255) * w + ((refrCol >> 16) & 255) * (1.0 - w)
  let gg = ((reflCol >> 8) & 255) * w + ((refrCol >> 8) & 255) * (1.0 - w)
  let bb = (reflCol & 255) * w + (refrCol & 255) * (1.0 - w)
  return ((rr | 0) << 16) | ((gg | 0) << 8) | (bb | 0)
}

// Shade the nearest hit of a ray, no further bounces (except the glass sphere's own
// entry/exit rays, handled inside shadeGlassSphere) → packed color.
let rayColor = (ox, oy, oz, dx, dy, dz) => {
  let t = intersect(ox, oy, oz, dx, dy, dz, 50.0)
  let h = HIT
  if (h < 0) return sky(dy)
  let hx = ox + dx * t, hy = oy + dy * t, hz = oz + dz * t
  if (h === PLANE_HIT) {
    // checkerboard floor
    let cf = Math.floor(hx * 1.5) + Math.floor(hz * 1.5)
    let chk = cf - 2.0 * Math.floor(cf * 0.5)
    let g = chk < 0.5 ? 0.62 : 0.18
    return localShade(hx, hy, hz, 0.0, 1.0, 0.0, g, g, g, dx, dy, dz)
  }
  if (h === GLASS_IDX) return shadeGlassSphere(ox, oy, oz, dx, dy, dz, t)
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

      rngPix = j; rngN = 0   // this pixel's deterministic jitter stream (see rnd())

      let tt = intersect(eyeX, eyeY, eyeZ, rdX, rdY, rdZ, 50.0)
      let h = HIT
      let col = 0
      if (h < 0) {
        col = sky(rdY)
      } else if (h === GLASS_IDX) {
        col = shadeGlassSphere(eyeX, eyeY, eyeZ, rdX, rdY, rdZ, tt)
      } else {
        let hx = eyeX + rdX * tt, hy = eyeY + rdY * tt, hz = eyeZ + rdZ * tt
        let nx = 0.0, ny = 0.0, nz = 0.0, br = 0.0, bg = 0.0, bb = 0.0, refl = 0.0
        if (h === PLANE_HIT) {
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
