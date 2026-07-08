// Schwarzschild black hole — gravitational lensing + a Keplerian accretion disk. Real GR, not
// a fake warp: spherical symmetry means every photon path is planar, so per pixel we build the
// camera ray, find ITS orbital plane (spanned by the camera position and the ray direction),
// and reduce the geodesic to u(φ)=1/r via the Binet equation u'' = −u + (3/2)·r_s·u² (RK4,
// fixed step) marched outward in φ from the camera. Three ways a ray ends: CAPTURE (u reaches
// 1/r_s — past the horizon → black), ESCAPE (r grows past the starfield shell), or — checked
// every step regardless — it may cross the disk's plane with r∈[r_in,r_out] and pick up disk
// light. A ray can cross more than once: the direct disk, the far side lensed above/below the
// shadow, and fainter higher-order rings all fall out of the SAME loop, for free. Nothing is
// drawn — only integrated.
//
// Disk shading at each crossing: an r^-3-ish falloff (soft ramps at both edges, no hard rings),
// Doppler beaming from the exact local Keplerian orbital speed
// (v(r) = √(r_s/2r) / √(1−r_s/r) — this hits precisely 0.5c at the ISCO, the textbook value)
// boosting the approaching limb by δ³ and dimming by gravitational redshift √(1−r_s/r), times a
// turbulence texture rotating at the local Keplerian rate Ω(r)=√(r_s/2r³) — inner streaks
// visibly shear past outer ones, like a real differentially-rotating disk. Escaping rays sample
// a hash-based starfield keyed on the FINAL bent direction, so the sky's own Einstein-ring
// distortion reads without any separate lensing pass.
//
// jz typing notes: module-level `let`s that must stay fractional live in Float64Array (texSeed);
// everything else here is either a `const` literal (never i32-narrowed) or a function-local
// `let` (locals get proper per-function f64/i32 inference, see fern.js's note). No closures over
// mutable locals — every helper is a pure module-level arrow taking explicit args.
//
// resize(w,h) → Uint32Array (ARGB). frame(t, incl, azim): incl/azim orbit the camera (driver
// drags them); the disk's own rotation (turbulence advection + Doppler asymmetry) runs off real
// time t regardless, so the view stays alive with no input. randomize() re-rolls the disk's
// turbulence seed.

let W = 0, H = 0, px
let invW = 0, invH = 0, aspect = 0
let texSeed = new Float64Array(3)

const RS = 1.0            // Schwarzschild radius — the unit of length for everything below
const R_IN = 3.0          // disk inner edge — the ISCO, 3·r_s
const R_OUT = 11.0        // disk outer edge
const R_ESCAPE = 22.0     // beyond this the remaining deflection is negligible — "sky" (margin over DIST matters: must clear the camera by enough that a grazing ray can't trivially "escape" on step 1)
const DIST = 14.0         // camera distance from the hole
const FOVSCALE = 0.80     // narrows the pixel span to a tighter, telephoto frame
const DPHI = 0.22         // Binet-equation step, radians of orbital-plane angle — coarse, but the
                          // ODE is smooth away from the photon sphere, so this costs nothing visible
                          // (checked side-by-side against 4x finer) while cutting the dominant cost:
                          // most on-screen rays graze the disk region for several radians of φ, not
                          // a quick in-and-out, so per-step cost × pixel count dominates the budget.
const MAXSTEPS = 27       // integration cap/pixel (~5.9 rad ≈ 0.94 turn — covers the primary image +
                          // the over/under lensed arc); tuned for <10ms/frame at the driver's ~70k-px budget
const BRIGHT = 15.0       // overall disk exposure
const ORBIT_RATE = 6.0    // disk-texture time scale (artistic — real Ω would read as frozen)

export let resize = (w, h) => {
  W = w; H = h
  invW = 1.0 / w; invH = 1.0 / h
  aspect = w * invH
  px = new Uint32Array(w * h)
  texSeed[0] = Math.random() * 100.0
  texSeed[1] = Math.random() * 100.0
  texSeed[2] = Math.random() * 100.0
  return px
}

// re-roll: a fresh turbulence pattern (driver also re-rolls the camera inclination/azimuth)
export let randomize = () => {
  texSeed[0] = Math.random() * 100.0
  texSeed[1] = Math.random() * 100.0
  texSeed[2] = Math.random() * 100.0
}

// explicit seed (bypasses Math.random) — the one non-deterministic input isolated behind a
// setter, so a driven render is otherwise fully deterministic/diffable JS↔jz.
export let setSeed = (a, b, c) => { texSeed[0] = a; texSeed[1] = b; texSeed[2] = c }

// Deterministic integer hash → [0,1) (dithering.js's scramble — bit-exact across JS and jz).
let hash01 = (x, y) => {
  let h = (x * 1103515245 + 12345) ^ (y * 12820163 + 9301)
  h = h & 0x7fffffff
  return (h % 4096) / 4096.0
}

// Sparse lensed starfield: hash a fine (θ,φ) grid over the escape DIRECTION. Most cells are
// empty; a lit one gets a hashed magnitude. Keyed on the final BENT direction, so the Einstein
// ring and repeated star images fall out for free — no separate sky-lensing pass.
let starField = (dx, dy, dz) => {
  let theta = Math.acos(dy)
  let phi = Math.atan2(dz, dx)
  let gx = Math.floor(phi * 130.0) | 0
  let gy = Math.floor(theta * 130.0) | 0
  let h = hash01(gx, gy)
  if (h > 0.0035) return 0.0
  let b = hash01(gx * 7 + 3, gy * 13 + 11)
  return 0.25 + b * 0.75
}

// Disk brightness profile: ~r^-3 with smoothstep ramps at both edges (no hard rings at r_in/r_out).
let diskFalloff = (r) => {
  let x = r / R_IN
  let base = 1.0 / (x * x * x)
  let ir = (r - R_IN) / 0.55
  if (ir < 0.0) ir = 0.0; else if (ir > 1.0) ir = 1.0
  ir = ir * ir * (3.0 - 2.0 * ir)
  let os = R_OUT - R_OUT * 0.8
  let orr = (R_OUT - r) / os
  if (orr < 0.0) orr = 0.0; else if (orr > 1.0) orr = 1.0
  orr = orr * orr * (3.0 - 2.0 * orr)
  return base * ir * orr
}

// Turbulence: a few sine terms in r and azimuth, phase advected at the LOCAL Keplerian rate
// Ω(r) — inner streaks visibly outrun outer ones, shearing frame to frame like a real disk.
let diskTexture = (r, phiWorld, t) => {
  let omega = Math.sqrt(RS / (2.0 * r * r * r))
  let ph = phiWorld - omega * t * ORBIT_RATE
  let v = 1.0
  v += 0.22 * Math.sin(ph * 3.0 + r * 1.7 + texSeed[0])
  v += 0.14 * Math.sin(ph * 7.0 - r * 0.9 + texSeed[1])
  v += 0.09 * Math.sin(ph * 2.0 + r * 3.1 + texSeed[2])
  if (v < 0.25) v = 0.25
  return v
}

export let frame = (t, incl, azim) => {
  // Camera position on a sphere of radius DIST around the hole (Y = polar axis = disk normal).
  let camY = DIST * Math.cos(incl)
  let sinIncl = Math.sin(incl)
  let camX = DIST * sinIncl * Math.cos(azim)
  let camZ = DIST * sinIncl * Math.sin(azim)
  let rhX = camX / DIST, rhY = camY / DIST, rhZ = camZ / DIST   // r̂ — unit position vector

  // Look-at-origin camera basis (same construction as raymarcher.js).
  let fwX = -rhX, fwY = -rhY, fwZ = -rhZ
  let rtX = fwZ, rtY = 0.0, rtZ = -fwX
  let rtLen = Math.sqrt(rtX * rtX + rtZ * rtZ)
  let invRt = 1.0 / rtLen
  rtX *= invRt; rtZ *= invRt
  let upX = rtY * fwZ - rtZ * fwY, upY = rtZ * fwX - rtX * fwZ, upZ = rtX * fwY - rtY * fwX

  let cosD = Math.cos(DPHI), sinD = Math.sin(DPHI)   // one Δφ rotation step, shared by every pixel

  let j = 0, py = 0
  while (py < H) {
    let vy = (py * invH - 0.5) * 2.0 * FOVSCALE
    let qx = 0
    while (qx < W) {
      let vx = (qx * invW - 0.5) * 2.0 * aspect * FOVSCALE

      let rdX = fwX + rtX * vx + upX * vy
      let rdY = fwY + rtY * vx + upY * vy
      let rdZ = fwZ + rtZ * vx + upZ * vy
      let rdLen = Math.sqrt(rdX * rdX + rdY * rdY + rdZ * rdZ)
      let invLen = 1.0 / rdLen
      rdX *= invLen; rdY *= invLen; rdZ *= invLen

      // Decompose the ray at the camera into radial (cosψ) + tangential (sinψ) parts, within
      // its own orbital plane — r̂ (radial) and φ̂ (tangential, in-plane) span that plane.
      let cospsi = rdX * rhX + rdY * rhY + rdZ * rhZ
      let tnX = rdX - cospsi * rhX, tnY = rdY - cospsi * rhY, tnZ = rdZ - cospsi * rhZ
      let tnLen = Math.sqrt(tnX * tnX + tnY * tnY + tnZ * tnZ)

      let val = 0.0, tint = 0.0

      // tnLen≈0 ⇒ a ray aimed almost exactly at/away from the centre — the (r,φ) parametrization
      // is singular there (dφ→0), but that sliver is always deep inside the shadow anyway (the
      // shadow's angular radius ≫ this threshold), so it's safe to just call it captured.
      if (tnLen >= 0.02) {
        let phX = tnX / tnLen, phY = tnY / tnLen, phZ = tnZ / tnLen   // φ̂ — unit tangential vector
        let sinpsi = tnLen

        let u = 1.0 / DIST
        // du/dφ|0 = −u·√(1−r_s·u)·cotψ (from the null-geodesic orbit equation (du/dφ)² =
        // 1/b² − u²(1−r_s·u) with b = r·sinψ/√(1−r_s/r), the impact parameter fixed by the
        // camera's local orthonormal tetrad).
        let up = -u * Math.sqrt(1.0 - RS * u) * cospsi / sinpsi
        let cosPhi = 1.0, sinPhi = 0.0
        let rPrev = DIST, hgtPrev = camY
        let diskBright = 0.0, diskTint = 0.0
        let escaped = 0, exX = 0.0, exY = 0.0, exZ = 0.0
        let steps = 0

        while (steps < MAXSTEPS) {
          // RK4 on the Binet equation u'' = −u + (3/2)·r_s·u².
          let k1u = up, k1v = -u + 1.5 * RS * u * u
          let u2 = u + 0.5 * DPHI * k1u, v2 = up + 0.5 * DPHI * k1v
          let k2u = v2, k2v = -u2 + 1.5 * RS * u2 * u2
          let u3 = u + 0.5 * DPHI * k2u, v3 = up + 0.5 * DPHI * k2v
          let k3u = v3, k3v = -u3 + 1.5 * RS * u3 * u3
          let u4 = u + DPHI * k3u, v4 = up + DPHI * k3v
          let k4u = v4, k4v = -u4 + 1.5 * RS * u4 * u4

          let uNext = u + (DPHI / 6.0) * (k1u + 2.0 * k2u + 2.0 * k3u + k4u)
          let upNext = up + (DPHI / 6.0) * (k1v + 2.0 * k2v + 2.0 * k3v + k4v)
          if (uNext < 0.0) uNext = 0.0

          // φ advances by the SAME fixed Δφ every step — an exact rotation, no per-step trig.
          let cosPhiNext = cosPhi * cosD - sinPhi * sinD
          let sinPhiNext = sinPhi * cosD + cosPhi * sinD
          let rNext = uNext > 1e-8 ? 1.0 / uNext : 1e8
          let hgtNext = rNext * (cosPhiNext * rhY + sinPhiNext * phY)   // height above the disk plane

          if (hgtPrev * hgtNext < 0.0) {   // crossed the equatorial plane this step
            let tc = hgtPrev / (hgtPrev - hgtNext)
            let rCross = rPrev + (rNext - rPrev) * tc
            if (rCross >= R_IN && rCross <= R_OUT) {
              let cPc = cosPhi + (cosPhiNext - cosPhi) * tc
              let sPc = sinPhi + (sinPhiNext - sinPhi) * tc
              let wx = rCross * (cPc * rhX + sPc * phX)
              let wz = rCross * (cPc * rhZ + sPc * phZ)
              let phiWorld = Math.atan2(wz, wx)

              // Photon's local propagation direction at the crossing (d(position)/dφ, unit —
              // pos(φ)=r(φ)·(cosφ·r̂+sinφ·φ̂), differentiated and re-normalized).
              let drdphi = -upNext / (uNext * uNext)
              let cA = drdphi * cosPhiNext - rNext * sinPhiNext
              let cB = drdphi * sinPhiNext + rNext * cosPhiNext
              let ddx = cA * rhX + cB * phX, ddy = cA * rhY + cB * phY, ddz = cA * rhZ + cB * phZ
              let ddlen = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz)
              let ndx = ddx / ddlen, ndy = ddy / ddlen, ndz = ddz / ddlen

              // Local Keplerian orbital velocity (prograde, counterclockwise viewed from +Y) —
              // exact circular-orbit speed in Schwarzschild coords, 0.5c at the ISCO.
              let fvx = -wz / rCross, fvz = wx / rCross
              let vorb = Math.sqrt(RS / (2.0 * rCross)) / Math.sqrt(1.0 - RS / rCross)
              // cosα uses the direction FROM the disk TO the camera, the reverse of our
              // camera→disk integration direction (ndx,ndy,ndz) — hence the minus sign.
              let cosalpha = -(ndx * fvx + ndz * fvz)
              let gam = 1.0 / Math.sqrt(1.0 - vorb * vorb)
              let dopp = 1.0 / (gam * (1.0 - vorb * cosalpha))       // relativistic Doppler factor
              let ggrav = Math.sqrt(1.0 - RS / rCross)                // gravitational redshift factor
              let gfac = ggrav * dopp

              let contrib = diskFalloff(rCross) * gfac * gfac * gfac * diskTexture(rCross, phiWorld, t) * BRIGHT
              diskBright += contrib
              diskTint += contrib * (dopp - 1.0)   // >0 approaching (→blue), <0 receding (→red)
            }
          }

          if (uNext >= 1.0) break   // horizon: r ≤ r_s (=1 in these units) — captured

          if (rNext > R_ESCAPE) {
            escaped = 1
            let drdphiE = -upNext / (uNext * uNext)
            let cAe = drdphiE * cosPhiNext - rNext * sinPhiNext
            let cBe = drdphiE * sinPhiNext + rNext * cosPhiNext
            exX = cAe * rhX + cBe * phX; exY = cAe * rhY + cBe * phY; exZ = cAe * rhZ + cBe * phZ
            let exLen = Math.sqrt(exX * exX + exY * exY + exZ * exZ)
            exX /= exLen; exY /= exLen; exZ /= exLen
            break
          }

          u = uNext; up = upNext; cosPhi = cosPhiNext; sinPhi = sinPhiNext
          rPrev = rNext; hgtPrev = hgtNext
          steps++
        }

        val = diskBright
        tint = diskTint
        if (escaped === 1) val += starField(exX, exY, exZ)
      }

      if (val < 0.0) val = 0.0
      val = val / (val + 0.5)   // soft (Reinhard-style) compression — keeps texture/gradient in the hot disk instead of crushing to flat white
      // Grayscale: the Doppler asymmetry already lives in `val` (the δ³ beaming brightens the
      // approaching limb), so the disk stays physically lopsided in luminance without any hue.
      let gi = (val * 255.0) | 0
      px[j] = (255 << 24) | (gi << 16) | (gi << 8) | gi
      j++; qx++
    }
    py++
  }
}
