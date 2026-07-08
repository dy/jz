// Progressive Monte Carlo path tracer — a Cornell box (floor/ceiling/back/left/right walls,
// left/right subtly tinted, rest neutral gray), one rectangular area light in the ceiling, a
// mirror sphere, a glass sphere (refraction + Schlick Fresnel) and a small diffuse sphere.
//
// Integrator: iterative (no recursion) path tracing, up to MAXDEPTH bounces, cosine-weighted
// hemisphere sampling for diffuse, next-event estimation (a shadow ray straight at the light,
// solid-angle-weighted) at every diffuse vertex, plus BSDF sampling for specular/dielectric
// vertices (which have no NEE — a delta BSDF's shadow ray would integrate to zero). NEE is what
// makes a small light converge fast instead of relying on lucky BSDF bounces to find it.
//
// The room fills the canvas at ANY aspect, not just square: the camera's horizontal FOV already
// widens with aspect (frame()'s vx term), so the left/right walls widen to match (see `widen` /
// `roomHW`) — a 16:9 canvas gets a wider room, not pillarboxed black bars beside a square one.
// Vertical framing (ceiling/floor/back-wall depth, FOV) never changes; only x-extent does.
//
// Each frame() adds exactly ONE more sample per pixel into `accum` (a running f64 sum of linear
// radiance); the displayed pixel is accum/spp tone-mapped (exposure, Reinhard, gamma via a LUT).
// So the image is noisy at spp=1 and converges to a clean render as spp climbs — the point of
// the demo IS watching that convergence, which is why the camera never auto-moves: motion would
// reset the very thing being shown. Dragging moves the light instead (resize/randomize/setLight
// all reset the accumulator; see `reset`).
//
// Determinism: every random number is `hash(pixel index, sample index, draw index)` — an integer
// avalanche mix (Math.imul + xor/shift, all i32-wrapping), never Math.random — so JS and the
// compiled jz/wasm module produce bit-identical frames. Math.random is used only in randomize()
// (a one-shot re-roll of the scene, not part of the deterministic render path).
//
// jz typing notes: the box/material numbers below are `const` (fixed for the program's life —
// matches lorenz.js's SIG/RHO/BETA). The one INTERACTIVE fractional value (the light's ceiling
// position) lives in a Float64Array (`lgt`), not a bare module `let`, for the same reason
// fern.js's chaos-game point does — a persistent module scalar reassigned from outside risks
// i32-narrowing; a typed-array cell never does.

let W = 0, H = 0, px
let invW = 0, invH = 0, aspect = 0

let accum          // Float64Array(w*h*3) — running (r,g,b) radiance sum per pixel
let spp = 0        // samples accumulated so far; this frame contributes one more

// ---- room -------------------------------------------------------------------------------
// The room is a XH-half-width cube at aspect 1, but a canvas is rarely square — a fixed XH would
// pillarbox a wide (e.g. 16:9) canvas, since the camera's horizontal FOV already grows with
// aspect (see frame()'s vx) while the room stayed square. So the LEFT/RIGHT walls (and the
// content between them) widen with aspect instead: `widen` grows past 1 only when the canvas is
// wider than tall, `roomHW` is the room's actual current half-width (= XH at aspect ≤ 1). Both
// are resize()-time-only (never per-pixel), recomputed whenever the canvas resizes.
const XH = 1.0                    // half-width at aspect 1 — also the unit `widen` scales content by
let widen = 1.0                   // horizontal stretch factor: max(1, aspect)
let roomHW = XH                   // current room half-width = XH * widen
const YT = 2.0                    // ceiling:     y ∈ [0, YT]  (floor at y=0)
const ZB = 2.0                    // depth:       z ∈ [0, ZB]  (open front at z=0 — no wall there)
const LY = YT - 0.01              // light plane, a hair below the ceiling (wins the tie at that x,z)

const EPS = 1.0e-3                // ray-origin offset along a normal/direction, avoids self-hit acne
const TMIN = 1.0e-4                // minimum valid hit distance
const INF = 1.0e30
const MAXDEPTH = 3   // verified visually ≈ depth 5 for this box (diminishing energy per bounce);
                     // depth 2 under-serves the mirror/glass spheres — a specular bounce also
                     // spends one unit of the SAME budget, so it needs 2 more to shade properly
const INV_PI = 0.3183098861837907

// Hit ids (what intersect()/occluded() found)
const H_FLOOR = 0, H_CEIL = 1, H_BACK = 2, H_LEFT = 3, H_RIGHT = 4, H_LIGHT = 5
const H_MIRROR = 6, H_GLASS = 7, H_DIFF = 8

// Wall albedo — most surfaces neutral gray; only left/right carry the classic Cornell tint,
// muted rather than the saturated red/green of the textbook scene.
const NEU_R = 0.760, NEU_G = 0.745, NEU_B = 0.715           // floor / ceiling / back
const LEFT_R = 0.660, LEFT_G = 0.270, LEFT_B = 0.230        // muted terracotta
const RIGHT_R = 0.250, RIGHT_G = 0.520, RIGHT_B = 0.290     // muted sage

const MIRR_R = 0.92, MIRR_G = 0.92, MIRR_B = 0.92           // mirror sphere tint (not perfectly white)
const GLASS_IOR = 1.5

const LE_R = 15.0, LE_G = 13.6, LE_B = 11.0                 // light emission, slightly warm

// Camera: fixed, axis-aligned (forward=+z, right=+x, up=+y) — a look-at basis isn't needed
// since the interaction moves the LIGHT, never the camera (see file header).
const EYEX = 0.0, EYEY = 1.0, EYEZ = -3.6
const TANFOV = 0.30

// Tone map: exposure → Reinhard (x/(1+x), bounded so an HDR light never just clips) → gamma,
// the gamma step via a LUT, built once at module load (exposure never changes, so unlike
// buddhabrot's adaptive peak this table never needs rebuilding). Gamma is 2.0, not the more usual
// 2.2 — deliberately, so the curve is exactly Math.sqrt (x^(1/2)), which jz computes bit-identical
// to V8's; Math.pow(x, 1/2.2) is jz's general exp(c·log x) path and is NOT bit-identical to V8's
// (confirmed: differs on ~2046/2048 entries at this table's size) — it would have silently broken
// the JS≡jz guarantee this whole kernel is built around. 2.0 vs 2.2 is visually indistinguishable
// and is itself a common gamma choice (many real-time renderers use exactly 2.0, a single sqrt).
const EXPOSURE = 1.5
const LUTN = 2048
let tlut = new Int32Array(LUTN)
let lutI = 0
while (lutI < LUTN) {
  let v = (Math.sqrt(lutI / (LUTN - 1)) * 255.0) | 0
  if (v > 255) v = 255
  if (v < 0) v = 0
  tlut[lutI] = v
  lutI = lutI + 1
}

// ---- scene state (mutable) ---------------------------------------------------------------
let lgt = new Float64Array(4)     // [cx, cz, halfW, halfZ] — light rectangle on the ceiling

let spx = new Float64Array(3)     // spheres: 0=mirror, 1=glass, 2=diffuse
let spy = new Float64Array(3)
let spz = new Float64Array(3)
let spr = new Float64Array(3)
let dcol = new Float64Array(3)    // diffuse sphere's albedo (r,g,b) — only sphere 2 uses this

// ---- deterministic hash-based RNG ---------------------------------------------------------
// per-pixel-per-sample stream: rngPix/rngSpp identify the sample, rngN is the draw index within
// it (incremented on every rnd() call) — together they key an integer avalanche hash, so the
// exact same three integers always yield the exact same float, in JS and in jz alike.
let rngPix = 0, rngSpp = 0, rngN = 0

// lowbias32 (Chris Wellons, "Prospecting for Hash Functions") — full avalanche in 2 imul's.
let hash32 = (n) => {
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d)
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b)
  n = n ^ (n >>> 16)
  return n
}

let rnd = () => {
  let h = Math.imul(rngPix, 0x9e3779b1) ^ Math.imul(rngSpp, 0x85ebca77) ^ Math.imul(rngN, 0xc2b2ae3d)
  rngN = rngN + 1
  h = hash32(h)
  return (h >>> 0) * 2.3283064365386963e-10   // → [0,1)
}

// ---- intersection ---------------------------------------------------------------------------
let HIT = -1   // set by intersect()/occluded(); read immediately after the call, never across one

// Nearest hit across the whole scene: 5 room planes (each bounded to its actual finite rectangle,
// so a ray that exits through the open front — untested here — correctly falls through to a
// miss instead of "hitting" some infinite extension of a side wall), the light rectangle, then
// the 3 spheres. Returns t; sets HIT to one of the H_* ids above, or -1 on a miss.
let intersect = (ox, oy, oz, dx, dy, dz, tmax) => {
  let minT = tmax
  let hit = -1

  if (dy > 1.0e-12) {
    let t = (YT - oy) / dy
    if (t > TMIN && t < minT) {
      let hx = ox + dx * t, hz = oz + dz * t
      if (hx > -roomHW && hx < roomHW && hz > 0.0 && hz < ZB) { minT = t; hit = H_CEIL }
    }
    // light plane sits a hair below the ceiling — its own bounded rectangle, its own t
    let tl = (LY - oy) / dy
    if (tl > TMIN && tl < minT) {
      let hx = ox + dx * tl, hz = oz + dz * tl
      if (hx > lgt[0] - lgt[2] && hx < lgt[0] + lgt[2] && hz > lgt[1] - lgt[3] && hz < lgt[1] + lgt[3]) { minT = tl; hit = H_LIGHT }
    }
  } else if (dy < -1.0e-12) {
    let t = (0.0 - oy) / dy
    if (t > TMIN && t < minT) {
      let hx = ox + dx * t, hz = oz + dz * t
      if (hx > -roomHW && hx < roomHW && hz > 0.0 && hz < ZB) { minT = t; hit = H_FLOOR }
    }
  }

  if (dx > 1.0e-12) {
    let t = (roomHW - ox) / dx
    if (t > TMIN && t < minT) {
      let hy = oy + dy * t, hz = oz + dz * t
      if (hy > 0.0 && hy < YT && hz > 0.0 && hz < ZB) { minT = t; hit = H_RIGHT }
    }
  } else if (dx < -1.0e-12) {
    let t = (-roomHW - ox) / dx
    if (t > TMIN && t < minT) {
      let hy = oy + dy * t, hz = oz + dz * t
      if (hy > 0.0 && hy < YT && hz > 0.0 && hz < ZB) { minT = t; hit = H_LEFT }
    }
  }

  if (dz > 1.0e-12) {
    let t = (ZB - oz) / dz
    if (t > TMIN && t < minT) {
      let hx = ox + dx * t, hy = oy + dy * t
      if (hx > -roomHW && hx < roomHW && hy > 0.0 && hy < YT) { minT = t; hit = H_BACK }
    }
  }
  // dz<0 → ray heads for the open front (z=0): no wall there, nothing to test

  let s = 0
  while (s < 3) {
    let ux = ox - spx[s], uy = oy - spy[s], uz = oz - spz[s]
    let b = ux * dx + uy * dy + uz * dz
    let c = ux * ux + uy * uy + uz * uz - spr[s] * spr[s]
    let disc = b * b - c
    if (disc >= 0.0) {
      let sq = Math.sqrt(disc)
      let t = -b - sq
      if (t < TMIN) t = -b + sq        // origin inside the sphere (glass, refracted ray) → far root
      if (t > TMIN && t < minT) { minT = t; hit = H_MIRROR + s }
    }
    s = s + 1
  }

  HIT = hit
  return minT
}

// Any-hit shadow test toward the light. Only the 3 spheres can ever occlude: the room is a
// convex box and both ray endpoints (a surface point, a point on the ceiling) lie inside/on it,
// so the segment between them never crosses a wall — testing walls here would only cost time.
let occluded = (ox, oy, oz, dx, dy, dz, tmax) => {
  let s = 0
  while (s < 3) {
    let ux = ox - spx[s], uy = oy - spy[s], uz = oz - spz[s]
    let b = ux * dx + uy * dy + uz * dz
    let c = ux * ux + uy * uy + uz * uz - spr[s] * spr[s]
    let disc = b * b - c
    if (disc >= 0.0) {
      let t = -b - Math.sqrt(disc)
      if (t > TMIN && t < tmax) return 1.0
    }
    s = s + 1
  }
  return 0.0
}

// ---- path trace one primary ray → radiance, written to RAD[0..2] (never read across a call) ---
let RAD = new Float64Array(3)

let trace = (ox, oy, oz, dx, dy, dz) => {
  let radR = 0.0, radG = 0.0, radB = 0.0
  let thrR = 1.0, thrG = 1.0, thrB = 1.0
  let cox = ox, coy = oy, coz = oz, cdx = dx, cdy = dy, cdz = dz
  let specBounce = 1     // camera/specular vertex: a light hit here must ADD emission (no prior NEE)
  let depth = 0

  while (depth < MAXDEPTH) {
    let tHit = intersect(cox, coy, coz, cdx, cdy, cdz, INF)
    let h = HIT
    if (h < 0) break                                   // escaped through the open front → black
    let hx = cox + cdx * tHit, hy = coy + cdy * tHit, hz = coz + cdz * tHit

    if (h === H_LIGHT) {
      if (specBounce === 1) { radR = radR + thrR * LE_R; radG = radG + thrG * LE_G; radB = radB + thrB * LE_B }
      break                                             // the light doesn't reflect
    }

    if (h === H_MIRROR) {
      let invr = 1.0 / spr[0]
      let nx = (hx - spx[0]) * invr, ny = (hy - spy[0]) * invr, nz = (hz - spz[0]) * invr
      let dn = cdx * nx + cdy * ny + cdz * nz
      let ndx = cdx - 2.0 * dn * nx, ndy = cdy - 2.0 * dn * ny, ndz = cdz - 2.0 * dn * nz
      thrR = thrR * MIRR_R; thrG = thrG * MIRR_G; thrB = thrB * MIRR_B
      cox = hx + nx * EPS; coy = hy + ny * EPS; coz = hz + nz * EPS
      cdx = ndx; cdy = ndy; cdz = ndz
      specBounce = 1
      depth = depth + 1
      continue
    }

    if (h === H_GLASS) {
      // Dielectric sphere: Schlick-approximated Fresnel picks reflect vs refract stochastically
      // (the standard "Ray Tracing in One Weekend" dielectric — the branch probability equals
      // the branch weight, so no explicit throughput scaling is needed beyond the choice itself).
      let invr = 1.0 / spr[1]
      let onx = (hx - spx[1]) * invr, ony = (hy - spy[1]) * invr, onz = (hz - spz[1]) * invr   // outward normal
      let ddn = cdx * onx + cdy * ony + cdz * onz
      let frontFace = ddn < 0.0
      let nnx = frontFace ? onx : -onx, nny = frontFace ? ony : -ony, nnz = frontFace ? onz : -onz
      let eta = frontFace ? (1.0 / GLASS_IOR) : GLASS_IOR
      let cosTheta = -(cdx * nnx + cdy * nny + cdz * nnz)
      if (cosTheta > 1.0) cosTheta = 1.0
      let sin2 = 1.0 - cosTheta * cosTheta
      let sinTheta = sin2 > 0.0 ? Math.sqrt(sin2) : 0.0
      let cannotRefract = eta * sinTheta > 1.0
      let r0 = (1.0 - eta) / (1.0 + eta); r0 = r0 * r0
      let m = 1.0 - cosTheta
      let reflectance = r0 + (1.0 - r0) * m * m * m * m * m
      let ndx = 0.0, ndy = 0.0, ndz = 0.0
      if (cannotRefract || reflectance > rnd()) {
        let dn = cdx * nnx + cdy * nny + cdz * nnz
        ndx = cdx - 2.0 * dn * nnx; ndy = cdy - 2.0 * dn * nny; ndz = cdz - 2.0 * dn * nnz
      } else {
        let rpx = eta * (cdx + cosTheta * nnx), rpy = eta * (cdy + cosTheta * nny), rpz = eta * (cdz + cosTheta * nnz)
        let par = 1.0 - (rpx * rpx + rpy * rpy + rpz * rpz)
        let sq = par > 0.0 ? Math.sqrt(par) : 0.0
        ndx = rpx - sq * nnx; ndy = rpy - sq * nny; ndz = rpz - sq * nnz
      }
      // nudge along the OUTGOING direction (not the normal) — correct whether it bent inward
      // (refraction) or stayed outward (reflection/TIR); a normal-offset would push a refracted
      // ray back across the surface it just crossed.
      cox = hx + ndx * EPS; coy = hy + ndy * EPS; coz = hz + ndz * EPS
      cdx = ndx; cdy = ndy; cdz = ndz
      specBounce = 1
      depth = depth + 1
      continue
    }

    // ---- diffuse: walls (floor/ceiling/back/left/right) or the small diffuse sphere ----
    let nx = 0.0, ny = 0.0, nz = 0.0, ar = 0.0, ag = 0.0, ab = 0.0
    if (h === H_FLOOR) { nx = 0.0; ny = 1.0; nz = 0.0; ar = NEU_R; ag = NEU_G; ab = NEU_B }
    else if (h === H_CEIL) { nx = 0.0; ny = -1.0; nz = 0.0; ar = NEU_R; ag = NEU_G; ab = NEU_B }
    else if (h === H_BACK) { nx = 0.0; ny = 0.0; nz = -1.0; ar = NEU_R; ag = NEU_G; ab = NEU_B }
    else if (h === H_LEFT) { nx = 1.0; ny = 0.0; nz = 0.0; ar = LEFT_R; ag = LEFT_G; ab = LEFT_B }
    else if (h === H_RIGHT) { nx = -1.0; ny = 0.0; nz = 0.0; ar = RIGHT_R; ag = RIGHT_G; ab = RIGHT_B }
    else {
      let invr = 1.0 / spr[2]
      nx = (hx - spx[2]) * invr; ny = (hy - spy[2]) * invr; nz = (hz - spz[2]) * invr
      ar = dcol[0]; ag = dcol[1]; ab = dcol[2]
    }

    // Next-event estimation: sample a point uniformly on the light rectangle, add its
    // solid-angle-weighted contribution if it's on the right side of both surface and light and
    // unoccluded (only spheres can occlude — see occluded()).
    let u1 = rnd(), u2 = rnd()
    let lpx = lgt[0] + (u1 - 0.5) * 2.0 * lgt[2]
    let lpz = lgt[1] + (u2 - 0.5) * 2.0 * lgt[3]
    let tlx = lpx - hx, tly = LY - hy, tlz = lpz - hz
    let d2 = tlx * tlx + tly * tly + tlz * tlz
    let dist = Math.sqrt(d2)
    let invDist = 1.0 / dist
    let wx = tlx * invDist, wy = tly * invDist, wz = tlz * invDist
    let cosS = nx * wx + ny * wy + nz * wz
    let cosL = wy                                       // light normal is fixed (0,-1,0) — see header derivation
    if (cosS > 0.0 && cosL > 0.0) {
      if (occluded(hx + nx * EPS, hy + ny * EPS, hz + nz * EPS, wx, wy, wz, dist - 2.0 * EPS) === 0.0) {
        let area = (2.0 * lgt[2]) * (2.0 * lgt[3])
        let geo = cosS * cosL * area / d2
        radR = radR + thrR * ar * INV_PI * LE_R * geo
        radG = radG + thrG * ag * INV_PI * LE_G * geo
        radB = radB + thrB * ab * INV_PI * LE_B * geo
      }
    }

    // BSDF sample: cosine-weighted hemisphere direction around the normal (Malley's method) via a
    // branchless orthonormal basis (Duff et al. 2017). For a Lambertian BRDF under cosine-weighted
    // sampling the cosine and π cancel, so throughput just multiplies by albedo.
    //
    // The unit-disk point Malley's method needs is sampled by REJECTION (retry inside the unit
    // square until inside the circle) rather than the usual r=sqrt(u), phi=2πu, (cos φ, sin φ)
    // polar form — jz's Math.sin/cos are a polynomial approximation, verified NOT bit-identical to
    // V8's (differs on virtually every input), which would silently break JS≡jz here. Rejection
    // sampling uses only rnd()/multiply/compare/sqrt, all proven bit-identical, at the cost of a
    // variable (~1.27 on average) number of rnd() draws — harmless for determinism, since both
    // engines draw from the same hash stream and always take the same number of tries.
    let lcx = 0.0, lcy = 0.0, d2disk = 2.0
    while (d2disk > 1.0) {
      lcx = 2.0 * rnd() - 1.0
      lcy = 2.0 * rnd() - 1.0
      d2disk = lcx * lcx + lcy * lcy
    }
    let lcz2 = 1.0 - d2disk
    let lcz = lcz2 > 0.0 ? Math.sqrt(lcz2) : 0.0
    let sgn = nz >= 0.0 ? 1.0 : -1.0
    let aco = -1.0 / (sgn + nz)
    let bco = nx * ny * aco
    let tx = 1.0 + sgn * nx * nx * aco, ty = sgn * bco, tz = -sgn * nx
    let bx = bco, by = sgn + ny * ny * aco, bz = -ny
    let ndx = lcx * tx + lcy * bx + lcz * nx
    let ndy = lcx * ty + lcy * by + lcz * ny
    let ndz = lcx * tz + lcy * bz + lcz * nz

    thrR = thrR * ar; thrG = thrG * ag; thrB = thrB * ab
    cox = hx + nx * EPS; coy = hy + ny * EPS; coz = hz + nz * EPS
    cdx = ndx; cdy = ndy; cdz = ndz
    specBounce = 0
    depth = depth + 1
  }

  RAD[0] = radR; RAD[1] = radG; RAD[2] = radB
}

// ---- scene setup / re-roll ------------------------------------------------------------------
let clearAccum = () => {
  let n = W * H * 3, i = 0
  while (i < n) { accum[i] = 0.0; i = i + 1 }
  spp = 0
}

let setupScene = () => {
  // x-positions and the light's x half-width scale with `widen` — hand-placed at aspect 1 (widen=1,
  // unchanged from before), spreading proportionally as the room widens so a 16:9 canvas doesn't
  // leave the wider floor/walls looking bare with everything still bunched at the old, narrower
  // spacing. Depth (z), radii and the light's z half-width don't depend on aspect, so stay fixed.
  lgt[0] = 0.0; lgt[1] = 1.0; lgt[2] = 0.24 * widen; lgt[3] = 0.20
  // hand-placed so no two spheres (or a sphere and a wall) ever touch
  spr[0] = 0.38; spx[0] = -0.44 * widen; spz[0] = 1.05; spy[0] = spr[0]     // mirror, left-mid
  spr[1] = 0.34; spx[1] = 0.42 * widen; spz[1] = 1.45; spy[1] = spr[1]      // glass, right-mid
  spr[2] = 0.20; spx[2] = 0.05 * widen; spz[2] = 0.55; spy[2] = spr[2]      // diffuse, front-center
  dcol[0] = 0.72; dcol[1] = 0.62; dcol[2] = 0.42                    // pale gold
}

export let resize = (w, h) => {
  W = w; H = h
  invW = 1.0 / w; invH = 1.0 / h
  aspect = w * invH
  widen = aspect > 1.0 ? aspect : 1.0
  roomHW = XH * widen
  px = new Uint32Array(w * h)
  accum = new Float64Array(w * h * 3)
  spp = 0
  return px
}

export let init = () => {
  setupScene()
  clearAccum()
}

// Move the light (ceiling position, world units); the driver clamps to stay inset from the
// walls and calls reset() right after, so the moved light re-converges from noise.
export let setLight = (x, z) => {
  let hw = lgt[2], hz = lgt[3]
  let xmin = -roomHW + hw + 0.05, xmax = roomHW - hw - 0.05
  let zmin = hz + 0.05, zmax = ZB - hz - 0.05
  if (x < xmin) x = xmin
  if (x > xmax) x = xmax
  if (z < zmin) z = zmin
  if (z > zmax) z = zmax
  lgt[0] = x; lgt[1] = z
}

export let reset = () => {
  clearAccum()
}

// Re-roll sphere size/position (rejection-sampled so none overlap each other or clip a wall,
// bounded retries with an always-safe fallback) and the diffuse sphere's pastel tint.
export let randomize = () => {
  let i = 0
  while (i < 3) {
    let r = i === 2 ? (0.16 + Math.random() * 0.12) : (0.26 + Math.random() * 0.16)
    let tries = 0, gx = 0.0, gz = 0.0, placed = 0
    while (tries < 24) {
      let xlo = -roomHW + r + 0.08, xhi = roomHW - r - 0.08
      let zlo = r + 0.08, zhi = ZB - r - 0.08
      let x = xlo + Math.random() * (xhi - xlo)
      let z = zlo + Math.random() * (zhi - zlo)
      let ok = 1, k = 0
      while (k < i) {
        let ddx = x - spx[k], ddz = z - spz[k], need = r + spr[k] + 0.10
        if (ddx * ddx + ddz * ddz < need * need) ok = 0
        k = k + 1
      }
      if (ok === 1) { gx = x; gz = z; placed = 1; tries = 24 } else { tries = tries + 1 }
    }
    if (placed === 0) { gx = -0.4 + i * 0.4; gz = 0.7 + i * 0.35 }
    spr[i] = r; spx[i] = gx; spy[i] = r; spz[i] = gz
    i = i + 1
  }
  dcol[0] = 0.32 + Math.random() * 0.5
  dcol[1] = 0.32 + Math.random() * 0.5
  dcol[2] = 0.32 + Math.random() * 0.5
  clearAccum()
}

// ---- render one more sample per pixel, tone-map the running average --------------------------
export let frame = () => {
  rngSpp = spp
  let invN = 1.0 / (spp + 1)
  let j = 0, py = 0
  while (py < H) {
    let qx = 0
    while (qx < W) {
      rngPix = j
      rngN = 0
      let jx = rnd(), jy = rnd()                          // free antialiasing: jitter within the pixel
      let vx = ((qx + jx) * invW - 0.5) * 2.0 * TANFOV * aspect
      let vy = (0.5 - (py + jy) * invH) * 2.0 * TANFOV
      let rdx = vx, rdy = vy, rdz = 1.0
      let invLen = 1.0 / Math.sqrt(rdx * rdx + rdy * rdy + rdz * rdz)
      rdx = rdx * invLen; rdy = rdy * invLen; rdz = rdz * invLen

      trace(EYEX, EYEY, EYEZ, rdx, rdy, rdz)

      let base = j * 3
      let ar = accum[base] + RAD[0], ag = accum[base + 1] + RAD[1], ab = accum[base + 2] + RAD[2]
      accum[base] = ar; accum[base + 1] = ag; accum[base + 2] = ab

      let re = ar * invN * EXPOSURE, ge = ag * invN * EXPOSURE, be = ab * invN * EXPOSURE
      let rt = re / (1.0 + re), gt = ge / (1.0 + ge), bt = be / (1.0 + be)
      let ri = (rt * (LUTN - 1)) | 0, gi = (gt * (LUTN - 1)) | 0, bi = (bt * (LUTN - 1)) | 0
      if (ri > LUTN - 1) ri = LUTN - 1
      if (gi > LUTN - 1) gi = LUTN - 1
      if (bi > LUTN - 1) bi = LUTN - 1
      let R = tlut[ri], G = tlut[gi], B = tlut[bi]
      px[j] = (255 << 24) | (B << 16) | (G << 8) | R

      j = j + 1; qx = qx + 1
    }
    py = py + 1
  }
  spp = spp + 1
}
