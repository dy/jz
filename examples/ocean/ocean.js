// Tessendorf FFT ocean — the technique behind essentially every film/game ocean since 2000.
// A Phillips-spectrum wave field is synthesized in Fourier space and turned into a real
// heightfield by a 2D inverse FFT, every frame:
//
//   h̃₀(k) = (ξr + iξi)/√2 · √P(k)                     Phillips-weighted complex Gaussian, per k
//   P(k)   = A·exp(−1/(kL)²)/k⁴ · |k̂·ŵ|² · exp(−k²l²)   ŵ = wind dir, L = V²/g, l = small-wave cutoff
//   h̃(k,t) = h̃₀(k)e^{iωt} + h̃₀*(−k)e^{−iωt},  ω = √(g|k|)  deep-water dispersion: long swells
//                                                          outrun short chop — the signature realism
//   h = IFFT{h̃},  ∂h/∂x = IFFT{i·kx·h̃},  ∂h/∂y = IFFT{i·ky·h̃}     spectral slopes → exact normals
//
// h̃(k,t) is assembled directly from a conjugate-mirrored bin pair (k and −k), so it is exactly
// Hermitian — every IFFT below comes out exactly real, no residual imaginary part to discard
// (up to float rounding). The Gaussian field ξ is drawn once per reseed() via an in-kernel
// seeded PRNG (Box–Muller over a mulberry32 stream — never Math.random, so JS and jz stay
// bit-exact); dragging (setWind) only reshapes P(k) over the SAME ξ, so the sea morphs smoothly
// as the wind turns instead of flickering to a new texture every drag frame.
//
// Grid N=256, iterative radix-2 Cooley–Tukey (rows then columns, precomputed twiddle table, no
// runtime trig in the butterfly), 3 fields (h, ∂h/∂x, ∂h/∂y) × 2 passes = 6 FFT passes/frame.
// The patch is periodic by construction (an FFT is exact on a torus), so it tiles seamlessly.
//
// Render: a moonlit night sea, not a top-down plot. A low tilted camera looks out at a horizon
// in the upper frame; each screen row below it looks down at its own angle — shallow (far,
// compressed) near the horizon, steep (near, stretched) at the bottom — so the heightfield is
// sampled along perspective rays, not a flat grid (cheap: per-row angle → depth → world position,
// bilinearly sampled off the periodic patch). Shading is Lambertian off a low sun/moon + a tight
// Blinn glint, foam blended in where a steepness proxy |∇h|² crosses a threshold. The camera's
// forward direction is locked to the light's azimuth, so its glint concentrates into the classic
// glitter path running from the horizon to the viewer — the one feature that reads as "water" at
// a glance. A faint sky glow above the horizon (fading to black) matches a haze the sea fades
// into near the horizon line. Grayscale ink-on-black throughout. Drag sets wind direction &
// speed; re-roll reseeds ξ and the moon's position.

// ── grid / physical constants ──────────────────────────────────────────────────────────────
const N = 256                       // FFT resolution (power of two)
const N2 = N * N
const HALF = N >> 1
const MASK = N - 1
const TWO_PI = 6.283185307179586
const G = 9.81                      // gravity — deep-water dispersion ω = √(g|k|)
// LPATCH must be large relative to the dominant wavelength (8.886·L, the Phillips peak) so
// MANY bins fall under the peak — otherwise only 1-5 bins carry any energy and the "sea" is
// really just a couple of clean sinusoids (measured: the old LPATCH=250 put >95% of the energy
// in 5 bins at moderate wind). At 1500, the wind range below spans ~11 to ~90 meaningfully-lit
// bins across its range — a genuine broadband mix of long roll + short chop.
const LPATCH = 1500.0                // simulated patch size (world units)
const DK = TWO_PI / LPATCH           // fundamental wavenumber step

// ── camera: a low tilted 2.5D view, not top-down — a horizon in the upper frame, near rows
// stretched (perspective), far rows compressed toward it. Camera forward is locked to the
// sun/moon's azimuth (see camFwd, set in reseed) so its glitter path always runs dead ahead,
// horizon to viewer — the single feature that reads as "water" at a glance. ──────────────────
const HORIZON_FRAC = 0.32     // horizon sits this far down from the top of the frame
const FOV_DOWN_MIN = 0.035    // look angle (rad) below horizontal at the horizon row (avoids ∞ depth)
const FOV_DOWN_MAX = 0.75     // look angle (rad) below horizontal at the bottom row (~43°, steep/near)
const FOV_H = 0.5             // horizontal half-angle (rad, ~28.6°) — lateral spread at each row
const TAN_FOV_H = Math.tan(FOV_H)
const CAM_H = 230.0           // camera height above the water (world units) — sets the depth scale:
                               // ≈0.16×LPATCH at the bottom row, ≈4.4×LPATCH at the horizon row
const SKY_GLOW = 0.085         // brightness at the horizon (shared by the sky glow and the sea's haze)
const SKY_FALLOFF = 4.0       // sky glow → black by the top of the frame at this rate
const SKY_WIDTH = 2.2         // lateral falloff of the glow around the sun's azimuth (screen-centered)
const FOG_RATE = 3.2          // sea rows fade in from the horizon haze at this rate, going down

// Wind-speed range setWind clamps into. Narrower than the textbook 0-30+ m/s range on purpose:
// a single (LPATCH, N) grid can't resolve both dead-calm ripples and a full gale's much-longer
// swell at once (no cascade of grids here — one FFT, one scale) — see the sweep in this
// example's verification notes. 5..18 keeps the peak inside a well-sampled part of the grid
// at both ends (measured: 11-90+ bins carry >10% of the peak's energy throughout the range).
const MINV = 5.0, MAXV = 18.0
const A_PHILLIPS = 1400.0            // Phillips amplitude — tuned so mid wind reads as a lively sea
// Suppress only genuinely sub-grid noise near Nyquist, NOT the mid/high-k chop that gives the
// broadband mix its texture (half-damping at ~0.8× Nyquist, ≈ the shortest 2-3 grid cells).
const SUPPRESS_L = 0.35 * (LPATCH / N)
const SUPPRESS_L2 = SUPPRESS_L * SUPPRESS_L
const KMIN2 = 1e-10                  // guards the DC bin's 1/k⁴
// Extra boost for the lowest few bins — real seas are often bimodal (a local wind-sea peak
// PLUS a longer-period swell from distant weather); a pure single-wind Phillips spectrum has
// no such second hump, and its longest waves are barely visible within the camera's near-field
// window (only a fraction of one cycle fits). This adds back a distant-swell-like hump under
// the wind peak so the near camera shows genuine rolling swell, not just wind chop.
const SWELL_K = 2.4 * DK             // e-folding wavenumber of the boost (a few of the lowest bins)
const SWELL_BOOST = 3.0              // extra energy multiplier at k→0, tapering to 1 by ~SWELL_K

// ── shading constants ──────────────────────────────────────────────────────────────────────
// Calibrated against the ACTUAL glitter-path geometry, not just RMS slope: calm water has
// much LESS slope variance, so a much BIGGER contiguous swath sits near the exact reflecting
// tilt at the sweet-spot row — a real, physically-correct effect (smooth water gives a broad
// bright moon-road; chop breaks it into sparse glints), measured at 5-6× more clipped-white
// coverage for calm vs strong wind at any single (SHIN, SPEC_K). Tuned so even that wider calm
// path stays a graceful glow rather than a blown-out slab, while chop still glints sparsely.
const AMBIENT = 0.05
const DIFFUSE_K = 0.32
const SPEC_K = 2.0
// Blinn exponent, fixed at 384 = 3·2⁷ so the hot loop raises to the power by 7 squarings + one
// ×3 (below) instead of an exp/log Math.pow — high ⇒ tight sparkle, not a broad sheen.
const HEIGHT_K = 0.012               // subtle crest-brightening straight from the height field
const FOAM_LO = 0.9, FOAM_HI = 1.9   // steepness (|∇h|²) band that ramps whitecaps in
const DEFAULT_SEED = 1

// ── module state ────────────────────────────────────────────────────────────────────────────
let W = 0, H = 0, px            // canvas
let inited = 0

let xir, xii                    // seeded Gaussian field ξ (N²) — the ocean's persistent "identity"
let h0r, h0i                    // Phillips-weighted spectrum h̃₀ = ξ/√2 · √P(k), rebuilt on wind change
let omega                       // dispersion ω(k) (N²) — grid-fixed, wind-independent, built once
let kOf                         // per-index wavenumber component (length N; kx=kOf[i], ky=kOf[j])
let Hr, Hi                      // this-frame height spectrum → IFFT in place → real heightfield
let Dxr, Dxi, Dyr, Dyi          // slope spectra (i·kx·h̃, i·ky·h̃) → IFFT in place → ∂h/∂x, ∂h/∂y
let twC, twS                    // precomputed FFT twiddle table (length N/2)
let rowRe, rowIm                // scratch row/column buffer (length N), reused by every FFT pass

let wind = new Float64Array(3)  // [dirX, dirY, L] — persistent fractional cells (not bare `let`s)
let sun = new Float64Array(3)   // [Lx, Ly, Lz] unit sun direction — low elevation, random azimuth
// Camera forward = the sun's horizontal azimuth (cos(az), sin(az)), so the camera always looks
// straight at the moon/sun — the glitter path it casts runs dead ahead, horizon to viewer, the
// one feature that makes any rendered water read as water at a glance.
let camFwd = new Float64Array(2)   // [cos(az), sin(az)]
let camRight = new Float64Array(2) // perpendicular to camFwd — the screen's lateral axis

let rngState = 1                 // mulberry32 state — pure integer, safe as a bare i32 global

// ── seeded PRNG (mulberry32) + Box–Muller — deterministic, no host Math.random ─────────────
let rnd = () => {
  rngState = (rngState + 0x6D2B79F5) | 0
  let t = rngState
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

let seedXi = () => {
  let i = 0
  while (i < N2) {
    let u1 = rnd(); if (u1 < 1e-12) u1 = 1e-12
    let u2 = rnd()
    let r = Math.sqrt(-2.0 * Math.log(u1))
    let th = TWO_PI * u2
    xir[i] = r * Math.cos(th)
    xii[i] = r * Math.sin(th)
    i++
  }
}

// ── one-time grid setup: wavenumber axis, dispersion table, FFT twiddle table ──────────────
let buildK = () => {
  let i = 0
  while (i < N) {
    let ki = i <= HALF ? i : i - N          // wrapped frequency index: 0..N/2, then −N/2+1..−1
    kOf[i] = ki * DK
    i++
  }
}

let buildOmega = () => {
  let j = 0
  while (j < N) {
    let ky = kOf[j], row = j * N
    let i = 0
    while (i < N) {
      let kx = kOf[i]
      omega[row + i] = Math.sqrt(G * Math.sqrt(kx * kx + ky * ky))
      i++
    }
    j++
  }
}

let buildTwiddle = () => {
  let half = N >> 1, m = 0
  while (m < half) {
    let ang = TWO_PI * m / N
    twC[m] = Math.cos(ang)
    twS[m] = Math.sin(ang)
    m++
  }
}

// ── Phillips spectrum: reshape h̃₀ over the SAME ξ whenever the wind changes ────────────────
let buildH0 = () => {
  let wdx = wind[0], wdy = wind[1], L = wind[2]
  let j = 0
  while (j < N) {
    let ky = kOf[j], row = j * N
    let i = 0
    while (i < N) {
      let kx = kOf[i]
      let k2 = kx * kx + ky * ky
      let idx = row + i
      if (k2 < KMIN2) {
        h0r[idx] = 0.0; h0i[idx] = 0.0        // DC: no mean offset, and 1/k⁴ would blow up
      } else {
        let k = Math.sqrt(k2)
        let kL = k * L
        let base = A_PHILLIPS * Math.exp(-1.0 / (kL * kL)) / (k2 * k2)
        let dot = (kx * wdx + ky * wdy) / k    // k̂ · ŵ
        let damp = Math.exp(-k2 * SUPPRESS_L2)
        let swell = 1.0 + SWELL_BOOST * Math.exp(-(k / SWELL_K) * (k / SWELL_K))
        let amp = Math.sqrt(base * dot * dot * damp * swell * 0.5)   // combines the /√2 with √P
        h0r[idx] = xir[idx] * amp
        h0i[idx] = xii[idx] * amp
      }
      i++
    }
    j++
  }
}

// ── this-frame spectra: the Hermitian h̃(k,t) pair + spectral slope multipliers i·kx, i·ky ──
let buildSpectrum = (t) => {
  let j = 0
  while (j < N) {
    let ky = kOf[j], row = j * N, mj = (N - j) & MASK, mrow = mj * N
    let i = 0
    while (i < N) {
      let kx = kOf[i]
      let mi = (N - i) & MASK
      let idx = row + i, midx = mrow + mi
      let a = h0r[idx], b = h0i[idx]          // h̃₀(k)
      let c = h0r[midx], d = h0i[midx]        // h̃₀(−k)
      let ph = omega[idx] * t
      let cw = Math.cos(ph), sw = Math.sin(ph)
      // h̃(k,t) = h̃₀(k)e^{iωt} + conj(h̃₀(−k))e^{−iωt}, expanded to real/imag:
      let hr = (a + c) * cw - (b + d) * sw
      let hi = (a - c) * sw + (b - d) * cw
      Hr[idx] = hr; Hi[idx] = hi
      Dxr[idx] = -kx * hi; Dxi[idx] = kx * hr   // i·kx·h̃
      Dyr[idx] = -ky * hi; Dyi[idx] = ky * hr   // i·ky·h̃
      i++
    }
    j++
  }
}

// ── iterative radix-2 IFFT, length N, in place on the shared scratch (rowRe, rowIm) ────────
let fftInverse = () => {
  let j = 0, i = 0
  while (i < N) {                             // bit-reversal permutation
    if (i < j) {
      let tr = rowRe[i]; rowRe[i] = rowRe[j]; rowRe[j] = tr
      let ti = rowIm[i]; rowIm[i] = rowIm[j]; rowIm[j] = ti
    }
    let m = N >> 1
    while (m >= 1 && j >= m) { j -= m; m >>= 1 }
    j += m
    i++
  }
  let len = 2, step = N >> 1                  // step = N/len, halves as len doubles
  while (len <= N) {
    let half = len >> 1
    let i2 = 0
    while (i2 < N) {
      let mIdx = 0, k = 0
      while (k < half) {
        let cw = twC[mIdx], sw = twS[mIdx]     // inverse transform uses exp(+iθ): +sin
        let idx1 = i2 + k, idx2 = idx1 + half
        let tr = rowRe[idx2] * cw - rowIm[idx2] * sw
        let ti = rowRe[idx2] * sw + rowIm[idx2] * cw
        rowRe[idx2] = rowRe[idx1] - tr; rowIm[idx2] = rowIm[idx1] - ti
        rowRe[idx1] = rowRe[idx1] + tr; rowIm[idx1] = rowIm[idx1] + ti
        mIdx += step
        k++
      }
      i2 += len
    }
    len <<= 1
    step >>= 1
  }
}

// 2D IFFT (rows then columns) of one complex field, in place, with the 1/N² normalization.
let ifft2d = (Xr, Xi) => {
  let y = 0
  while (y < N) {
    let off = y * N, x = 0
    while (x < N) { rowRe[x] = Xr[off + x]; rowIm[x] = Xi[off + x]; x++ }
    fftInverse()
    x = 0
    while (x < N) { Xr[off + x] = rowRe[x]; Xi[off + x] = rowIm[x]; x++ }
    y++
  }
  let cx = 0
  while (cx < N) {
    let y2 = 0
    while (y2 < N) { rowRe[y2] = Xr[y2 * N + cx]; rowIm[y2] = Xi[y2 * N + cx]; y2++ }
    fftInverse()
    y2 = 0
    while (y2 < N) { Xr[y2 * N + cx] = rowRe[y2]; Xi[y2 * N + cx] = rowIm[y2]; y2++ }
    cx++
  }
  let invN2 = 1.0 / N2, m = 0
  while (m < N2) { Xr[m] *= invN2; Xi[m] *= invN2; m++ }
}

// ── render: tilted 2.5D camera — sky glow, then the sea perspective-projected onto the
// periodic heightfield, shaded relief + Blinn glint (the glitter path) + foam ────────────────
let render = () => {
  let w = W, h = H
  let Lx = sun[0], Ly = sun[1], Lz = sun[2]
  let fx = camFwd[0], fy = camFwd[1], rx = camRight[0], ry = camRight[1]
  let horizonRow = (HORIZON_FRAC * h) | 0
  if (horizonRow < 1) horizonRow = 1
  if (horizonRow > h - 2) horizonRow = h - 2
  let seaRowsInv = 1.0 / (h - 1 - horizonRow)

  // ── sky: above the horizon, no ocean sample — a glow toward the moon/sun's azimuth,
  // fading to black upward; matches the sea's horizon haze below for a seamless join.
  let sy = 0
  while (sy < horizonRow) {
    let distFromHorizon = (horizonRow - sy) / horizonRow   // 0 at the horizon, 1 at the top
    let rowbase = sy * w
    let sx = 0
    while (sx < w) {
      let lat = (sx / (w - 1)) * 2.0 - 1.0                 // -1..1, 0 = straight at the moon/sun
      let g = (SKY_GLOW * Math.exp(-(distFromHorizon * SKY_FALLOFF + lat * lat * SKY_WIDTH)) * 255.0) | 0
      px[rowbase + sx] = (255 << 24) | (g << 16) | (g << 8) | g
      sx++
    }
    sy++
  }

  // ── sea: horizon row to the bottom. Each row looks down at its own angle theta(t) — shallow
  // (far, compressed) near the horizon, steep (near, stretched) at the bottom — so one row of
  // screen pixels covers a growing swath of world as t→0, the classic ground-plane perspective.
  sy = horizonRow
  while (sy < h) {
    let t = (sy - horizonRow) * seaRowsInv                 // 0 at the horizon, 1 at the bottom (near)
    let theta = FOV_DOWN_MIN + t * (FOV_DOWN_MAX - FOV_DOWN_MIN)
    let ct = Math.cos(theta), st = Math.sin(theta)
    let d = CAM_H * ct / st                                // ground distance this row samples
    let latHalf = d * TAN_FOV_H
    let fog = Math.exp(-t * FOG_RATE); if (fog > 1.0) fog = 1.0
    let rowbase = sy * w
    let sx = 0
    while (sx < w) {
      let lat = ((sx / (w - 1)) * 2.0 - 1.0) * latHalf
      let wx = rx * lat + fx * d, wy = ry * lat + fy * d
      let gv = ((wy / LPATCH) * N) % N; if (gv < 0.0) gv += N
      let v0 = gv | 0, fv = gv - v0
      let v1 = v0 + 1; if (v1 >= N) v1 = 0
      let gu = ((wx / LPATCH) * N) % N; if (gu < 0.0) gu += N
      let u0 = gu | 0, fu = gu - u0
      let u1 = u0 + 1; if (u1 >= N) u1 = 0

      let i00 = v0 * N + u0, i10 = v0 * N + u1, i01 = v1 * N + u0, i11 = v1 * N + u1
      let w00 = (1.0 - fu) * (1.0 - fv), w10 = fu * (1.0 - fv)
      let w01 = (1.0 - fu) * fv, w11 = fu * fv

      let dxv = Dxr[i00] * w00 + Dxr[i10] * w10 + Dxr[i01] * w01 + Dxr[i11] * w11
      let dyv = Dyr[i00] * w00 + Dyr[i10] * w10 + Dyr[i01] * w01 + Dyr[i11] * w11
      let hgt = Hr[i00] * w00 + Hr[i10] * w10 + Hr[i01] * w01 + Hr[i11] * w11

      let nx = -dxv, ny = -dyv, nz = 1.0              // heightfield normal
      let ninv = 1.0 / Math.sqrt(nx * nx + ny * ny + nz * nz)
      nx *= ninv; ny *= ninv; nz *= ninv

      let diff = nx * Lx + ny * Ly + nz * Lz; if (diff < 0.0) diff = 0.0
      // TRUE per-pixel view vector (surface → camera at (0,0,CAM_H)) — the lateral component
      // is what carves the moon-road: off-path columns' half-vectors swing away from the
      // light's azimuth and the ^384 glint dies, leaving a bright wedge under the moon that
      // widens toward the viewer. A per-row (lat=0) approximation smears the glint uniformly
      // across the width.
      let vpx = -wx, vpy = -wy, vpz = CAM_H
      let vinv = 1.0 / Math.sqrt(vpx * vpx + vpy * vpy + vpz * vpz)
      let hxv = Lx + vpx * vinv, hyv = Ly + vpy * vinv, hzv = Lz + vpz * vinv
      let hinv = 1.0 / Math.sqrt(hxv * hxv + hyv * hyv + hzv * hzv)
      let ndoth = (nx * hxv + ny * hyv + nz * hzv) * hinv; if (ndoth < 0.0) ndoth = 0.0
      // ndoth^384 via 7 squarings (→^128) + a cube — the Blinn glint, tight and cheap
      // (no exp/log Math.pow)
      let spec = ndoth * ndoth
      spec *= spec; spec *= spec; spec *= spec
      spec *= spec; spec *= spec; spec *= spec
      spec = spec * spec * spec

      let steep = dxv * dxv + dyv * dyv                // cheap steepness proxy → foam
      let foam = (steep - FOAM_LO) / (FOAM_HI - FOAM_LO)
      if (foam < 0.0) foam = 0.0; else if (foam > 1.0) foam = 1.0
      foam = foam * foam * (3.0 - 2.0 * foam)          // smoothstep

      let v = AMBIENT + DIFFUSE_K * diff + SPEC_K * spec + HEIGHT_K * hgt
      if (v < 0.0) v = 0.0
      v = v * (1.0 - foam) + foam
      v = v * (1.0 - fog) + SKY_GLOW * fog             // blend into the horizon haze as t→0
      if (v > 1.0) v = 1.0
      let g = (v * 255.0) | 0
      px[rowbase + sx] = (255 << 24) | (g << 16) | (g << 8) | g
      sx++
    }
    sy++
  }
}

// ── exports ─────────────────────────────────────────────────────────────────────────────────

// Fresh sea: redraw the Gaussian field ξ and pick a new low-sun azimuth/elevation, both from
// the SAME deterministic stream (never Math.random — keeps JS and jz bit-exact).
export let reseed = (seed) => {
  rngState = seed | 0; if (rngState === 0) rngState = 1
  seedXi()
  let az = rnd() * TWO_PI, el = 0.18 + rnd() * 0.22
  let caz = Math.cos(az), saz = Math.sin(az)
  sun[0] = caz * Math.cos(el)
  sun[1] = saz * Math.cos(el)
  sun[2] = Math.sin(el)
  camFwd[0] = caz; camFwd[1] = saz
  camRight[0] = -saz; camRight[1] = caz
  buildH0()
}

// Wind from a canvas-space vector (drag position relative to center): the kernel owns the unit
// conversion (drag-to-edge ⇒ full MINV..MAXV range) so the driver just forwards raw pixels.
export let setWind = (vx, vy) => {
  let mag = Math.sqrt(vx * vx + vy * vy)
  let half = (W < H ? W : H) * 0.5; if (half < 1.0) half = 1.0
  let f = mag / half; if (f > 1.0) f = 1.0
  let speed = MINV + (MAXV - MINV) * f
  if (mag > 1e-6) { wind[0] = vx / mag; wind[1] = vy / mag }   // else: keep the last direction
  wind[2] = speed * speed / G
  buildH0()
}

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  if (!inited) {
    inited = 1
    xir = new Float64Array(N2); xii = new Float64Array(N2)
    h0r = new Float64Array(N2); h0i = new Float64Array(N2)
    omega = new Float64Array(N2)
    kOf = new Float64Array(N)
    Hr = new Float64Array(N2); Hi = new Float64Array(N2)
    Dxr = new Float64Array(N2); Dxi = new Float64Array(N2)
    Dyr = new Float64Array(N2); Dyi = new Float64Array(N2)
    twC = new Float64Array(N >> 1); twS = new Float64Array(N >> 1)
    rowRe = new Float64Array(N); rowIm = new Float64Array(N)
    buildK(); buildTwiddle(); buildOmega()
    wind[0] = Math.cos(0.35); wind[1] = Math.sin(0.35); wind[2] = 9.0 * 9.0 / G   // default breeze
    reseed(DEFAULT_SEED)
  }
  return px
}

export let frame = (t) => {
  buildSpectrum(t)
  ifft2d(Hr, Hi)
  ifft2d(Dxr, Dxi)
  ifft2d(Dyr, Dyi)
  render()
}
