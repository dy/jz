// Chladni plate — now the REAL experiment: sand grains that physically migrate to the nodal lines.
// A plate driven at an eigenmode is still along its NODAL LINES; here they're the zero set of
//   F(x,y) = cos(nπx)·cos(mπy) − cos(mπx)·cos(nπy),
// drawn as a faint field wash ("black is space, white is sound"). n is the number of half-waves
// ACROSS the plate, m the number DOWN — so the figure is literally the COMBINATION of an x-axis
// standing wave and a y-axis one. The host maps horizontal cursor travel to n and vertical to m.
//
// The mechanism: every grain is kicked each frame by an amount proportional to the LOCAL vibration
// amplitude |F| sampled under it — thrown far on an antinode, barely nudged on a node — plus a small
// bias down the |F| gradient (the kick alone would settle it eventually; the bias just keeps a live
// demo's convergence snappy). No special-casing for a mode change: n,m simply feed a different F, so
// grains parked on what is now a fresh antinode get thrown and drift back down — "scatter and
// re-collect" is the SAME mechanism, not a separate reset.
//
// Grains deposit into a fast-decaying brightness trail (bright where sand DWELLS — nodes — because
// a settled grain revisits nearly the same pixel every frame; a stale trail fades in a few frames,
// so a mode change reads as a clean scatter, not a smear). The fine per-pixel F is ALSO rendered as
// a faint background wash so the plate itself still reads under the grains — the sand IS the figure
// now, the wash is just context.
//
// jz typing: grain positions are persistent FRACTIONAL state → Float64Array (bare `let` module
// globals get i32-narrowed — see examples/fern/fern.js). A Math.imul-based LCG (never Math.random)
// drives every kick, so the JS import and the compiled wasm stay bit-exact given the same seed.
//
// Perf: the per-pixel field+composite pass below is UNCHANGED in shape from the original (still the
// two-cos-per-row / two-cos-per-pixel ridge) so it keeps taking jz's per-pixel-color path (f64x2,
// $math.cos2). Grains sample a separately precomputed COARSE field grid (a few hundred px across,
// not display resolution) — cheap, and it keeps the expensive display-resolution cos() count from
// doubling.
let W = 0, H = 0, px, SC = 0, cx = 0, cy = 0   // uniform plate scale + viewport centre
let SHARP = 14.0                               // nodal-line sharpness (≈ inverse half-width)

// ---- coarse field grid: F sampled every FSTEP display pixels, cheap enough for grains to read
// every frame without paying the full per-pixel cos() cost a second time. ----
let FSTEP = 1, FW = 1, FH = 1
let fld = new Float64Array(1)                  // Float64Array FW*FH — reallocated in resize()

// ---- grains: sand specks that migrate to the nodal lines ----
const NG = 45000                               // grain count
let gx = new Float64Array(NG), gy = new Float64Array(NG)
let acc = new Float64Array(1)                  // decaying per-pixel grain-brightness trail

const KICK = 0.013      // random-kick gain: kick_px ≈ KICK · √|F| · min(W,H) (sqrt: see updateGrains)
const GRAD = 0.22       // gradient-descent gain, relative to KICK — small, secondary bias
const DECAY = 0.86      // per-frame trail decay — a stale figure clears in a few frames
const BOOST = 1.0 - DECAY   // per-grain-visit deposit; a steadily-revisited pixel saturates to white
const ACC_MAX = 1.5     // trail-deposit ceiling: several nodal lines can cross at one pixel (the
                        // plate centre, for odd n,m) and keep depositing long past white — capped,
                        // that spot decays on the same clock as everywhere else once grains move on,
                        // instead of leaving a stale bright ghost through the next mode change
const AXIS_KICK = 0.6       // fixed kick_px/kickS near the centre row/column — see updateGrains
const AXIS_BAND_CELLS = 2.0 // width of that "near", in coarse cells either side of the axis

const LCG_MUL = 1664525, LCG_ADD = 1013904223   // Numerical-Recipes LCG constants
let seed = 0x2545f491 | 0                       // Math.imul LCG state — never Math.random (bit-exact JS⇆jz)

let rnd = () => {                               // → uniform in [-1, 1)
  seed = (Math.imul(seed, LCG_MUL) + LCG_ADD) | 0
  return (seed >>> 8) * (1.0 / 8388608.0) - 1.0
}

let scatter = () => {
  let i = 0
  while (i < NG) { gx[i] = (rnd() * 0.5 + 0.5) * W; gy[i] = (rnd() * 0.5 + 0.5) * H; i++ }
}

export let resize = (w, h) => {
  // Map pixels to plate space with ONE uniform scale (no stretch): the unit plate [0,1]² fills the
  // shorter screen side and the longer side extends the periodic figure — so the canvas can be
  // full-screen at any aspect and the nodal lines stay perfectly square.
  W = w; H = h; SC = 1.0 / (w < h ? w : h); cx = w * 0.5; cy = h * 0.5
  px = new Uint32Array(w * h)
  // Float64 (not Float32): a same-4-byte-stride array read alongside the px[] store here would let
  // the compiler CSE their shared `j*stride` byte-offset into one local — hiding the store address's
  // pixel-IV dependency from the per-pixel-color vectorizer's (jz's tryPerPixelColor) safety check,
  // which traces that dependency through `local.set` defs only, not the `local.tee` CSE introduces.
  // A different stride sidesteps it entirely (also: more headroom before the trail saturates).
  acc = new Float64Array(w * h)

  let short = w < h ? w : h
  FSTEP = Math.ceil(short / 200) | 0
  if (FSTEP < 1) FSTEP = 1
  FW = ((w / FSTEP) | 0) + 1
  FH = ((h / FSTEP) | 0) + 1
  fld = new Float64Array(FW * FH)
  return px
}

// Deterministic reseed + full rescatter — the differential JS⇆jz check drives both engines from
// here so grain trajectories match bit-for-bit. Also the harness's dice-button fallback.
export let init = () => { seed = 0x2545f491 | 0; scatter() }
// A "fresh" re-roll for the live dice button: still deterministic (never Math.random), just mixes
// the CURRENT (already-evolved) LCG state with a constant instead of resetting it.
export let randomize = () => { seed = (seed + 0x9e3779b9) | 0; scatter() }

// F sampled on the coarse grid (SAME plate mapping as the fine per-pixel pass, subsampled every
// FSTEP px) — this frame's amplitude field for the grains below to read.
let computeField = (nP, mP) => {
  let fy = 0, fj = 0
  while (fy < FH) {
    let y = (fy * FSTEP - cy) * SC + 0.5
    let cyn = Math.cos(nP * y), cym = Math.cos(mP * y)
    let fx = 0
    while (fx < FW) {
      let x = (fx * FSTEP - cx) * SC + 0.5
      fld[fj] = Math.cos(nP * x) * cym - Math.cos(mP * x) * cyn
      fj++; fx++
    }
    fy++
  }
}

let decayAcc = () => {
  let n = W * H, i = 0
  while (i < n) { acc[i] = acc[i] * DECAY; i++ }
}

// Kicked by an amount ∝ the LOCAL |F| under each grain (the actual Chladni mechanism — an antinode
// throws its grains, a node barely nudges them) plus a small bias down the |F| gradient.
let updateGrains = (nP, mP) => {
  // Whenever n AND m are BOTH odd, cos(nπ·0.5) and cos(mπ·0.5) are both ~0 — a symmetry of this
  // particular F, not a discretization fluke — so F(x, 0.5) and F(0.5, y) come out ~0 for EVERY x
  // / every y: the plate's centre ROW and COLUMN are nodal along their ENTIRE length, unlike an
  // ordinary nodal curve, which is zero only at an isolated (x,y). A grain anywhere near either
  // axis then reads a coarse aC that's near-zero no matter WHERE along the axis it is, so its kick
  // collapses and it freezes at whatever x (or y) it drifted in with — given enough frames that
  // fills the full width/height solid: a hard, perfectly straight bright cross no real (curved,
  // localized) nodal line produces.
  let cN = Math.cos(nP * 0.5); cN = cN < 0.0 ? -cN : cN
  let cM = Math.cos(mP * 0.5); cM = cM < 0.0 ? -cM : cM
  let bothOdd = cN < 0.15 && cM < 0.15
  let band = FSTEP * AXIS_BAND_CELLS

  let S = W < H ? W : H
  let kickS = KICK * S
  let gradS = kickS * GRAD
  let i = 0
  while (i < NG) {
    let x = gx[i], y = gy[i]
    let cxi = (x / FSTEP) | 0, cyi = (y / FSTEP) | 0
    if (cxi < 0) cxi = 0; else if (cxi > FW - 1) cxi = FW - 1
    if (cyi < 0) cyi = 0; else if (cyi > FH - 1) cyi = FH - 1
    let c = cyi * FW + cxi

    let v = fld[c];                    let aC = v < 0.0 ? -v : v
    v = fld[cxi > 0 ? c - 1 : c];       let aL = v < 0.0 ? -v : v
    v = fld[cxi < FW - 1 ? c + 1 : c];  let aR = v < 0.0 ? -v : v
    v = fld[cyi > 0 ? c - FW : c];      let aU = v < 0.0 ? -v : v
    v = fld[cyi < FH - 1 ? c + FW : c]; let aD = v < 0.0 ? -v : v

    // sqrt(amplitude), not amplitude itself: several nodal lines cross at a shared point (e.g. the
    // plate centre, for odd n,m), so being near ANY one of them keeps |F| small over a wider patch
    // there than along a lone line elsewhere — a LINEAR kick lets grains stall in that wider patch,
    // piling into a soft blob instead of the sharp crossing a real plate shows. sqrt boosts the kick
    // right where it's smallest, enough to sweep that patch clean without disturbing the crisp settle
    // on an ordinary (single-line) stretch, where |F| — and so the correction — is already tiny.
    //
    // Near the degenerate axis, DON'T feed that sqrt from aC at all: aC there is a coincidental
    // near-zero (cos() evaluated at a multiple of π/2), and jz's polynomial cos vs V8's native cos
    // agree only to ~1e-7 that close to a zero — not the ~1e-16 they otherwise track to (see the
    // Math.round note in frame()) — a gap sqrt() would blow up into a real, engine-dependent
    // position split that compounds every frame after. A FIXED kick sidesteps the read entirely:
    // bothOdd/dRow/dCol/band are plain arithmetic on n, m, FSTEP, cx, cy, never a value that came
    // out of a near-zero cos — so which grains get it, and by how much, is bit-identical between
    // engines even though aC itself isn't.
    let dRow = y - cy; dRow = dRow < 0.0 ? -dRow : dRow
    let dCol = x - cx; dCol = dCol < 0.0 ? -dCol : dCol
    let nearAxis = bothOdd && (dRow < band || dCol < band)
    let kick = nearAxis ? kickS * AXIS_KICK : Math.sqrt(aC) * kickS
    let nx = x + rnd() * kick - (aR - aL) * gradS
    let ny = y + rnd() * kick - (aD - aU) * gradS

    // reflect off the plate edge (a clamp alone would pile grains onto a false bright border)
    if (nx < 0.0) nx = -nx; else if (nx > W - 1) nx = 2.0 * (W - 1) - nx
    if (ny < 0.0) ny = -ny; else if (ny > H - 1) ny = 2.0 * (H - 1) - ny
    if (nx < 0.0) nx = 0.0; else if (nx > W - 1) nx = W - 1
    if (ny < 0.0) ny = 0.0; else if (ny > H - 1) ny = H - 1
    gx[i] = nx; gy[i] = ny

    // capped (ACC_MAX): several nodal lines crossing at one pixel would otherwise deposit past
    // white every frame and take many extra frames to decay back down once the grains move on.
    let idx = (ny | 0) * W + (nx | 0)
    let deposit = acc[idx] + BOOST
    acc[idx] = deposit > ACC_MAX ? ACC_MAX : deposit
    i++
  }
}

// n = half-waves across (x), m = half-waves down (y); the host drives them from cursor x/y.
export let frame = (n, m) => {
  let PI = Math.PI
  let nP = n * PI, mP = m * PI
  let K = SHARP

  computeField(nP, mP)
  decayAcc()
  updateGrains(nP, mP)

  // ---- composite: faint field wash + accumulated grain brightness. UNCHANGED shape from the
  // original per-pixel ridge (two cos/row hoisted + two cos/pixel, one store) — this is what takes
  // jz's per-pixel-color path (f64x2, $math.cos2); the acc[] read below is scalar epilogue, safe. ----
  let j = 0, py = 0
  while (py < H) {
    let y = (py - cy) * SC + 0.5
    let cyn = Math.cos(nP * y)     // y-only terms — hoist once per row
    let cym = Math.cos(mP * y)
    let qx = 0
    while (qx < W) {
      let x = (qx - cx) * SC + 0.5
      let f = Math.cos(nP * x) * cym - Math.cos(mP * x) * cyn
      // Divide-free ridge: a faint white core + a wider, softer glow — a HINT of the plate, dimmed
      // well below grain brightness (the sand is the figure now).
      let fk = f * K
      let q = 1.0 - fk * fk
      // Math.round (not `|0` truncate): near the plate's own symmetry axes, n or m odd puts a whole
      // ROW/COLUMN exactly on a coincidental zero of cos(), where jz's polynomial $math.cos2 and
      // V8's native Math.cos agree only to ~1e-7 (not the ~1e-16 two independent correctly-rounded
      // implementations usually share) — enough to nudge q a hair under 1.0 in one engine only.
      // Truncating that hair-below-C value rounds DOWN a full count (255→254); round() recovers the
      // same integer in both engines since the gap is far under 0.5. (Was invisible pre-grains: the
      // old core*255/glow*180 saturated `g` to 255 at those pixels either way, masking the ±1; the
      // dimmer wash here no longer saturates there, so it needs this to stay bit-exact.)
      let core = q > 0.0 ? Math.round(q * q * 55.0) | 0 : 0
      let fkg = f * (K * 0.25)
      let qg = 1.0 - fkg * fkg
      let glow = qg > 0.0 ? Math.round(qg * 34.0) | 0 : 0
      let bg = core + ((glow * 90) >> 8)

      let a = acc[j]                              // this pixel's grain-trail brightness, 0..ACC_MAX
      let g = bg + ((255 - bg) * a) | 0            // lerp bg → white as grain density rises
      if (g > 255) g = 255
      px[j] = (255 << 24) | (g << 16) | (g << 8) | g     // white on black
      j++; qx++
    }
    py++
  }
}
