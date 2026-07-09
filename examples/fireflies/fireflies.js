// Fireflies — the Kuramoto model made visible. Each firefly is a phase oscillator with its own
// natural frequency ω_i (a Gaussian spread around a common firefly-like rate); it is coupled only
// to NEIGHBOURS within a small radius, never to the whole field:
//
//   dθ_i/dt = ω_i + (K/n_i) · Σ_{j∈neighbours} sin(θ_j − θ_i)
//
// No firefly sees the far side of the meadow directly — sync can only spread hop-by-hop through
// local neighbourhoods. That's what turns instant mean-field lock into something worth watching:
// patches of coherence nucleate at random, fronts of synchrony travel between them, and where fronts
// collide out of step a phase defect (a little vortex in the timing) spins before dissolving. Given
// long enough, one sync wave outruns the rest and the whole meadow ends up flashing as one — until an
// occasional perturbation (a drag, a lantern flash, the auto-perturb) knocks it loose again.
//
// Neighbours are found via a uniform grid (cell size = coupling radius R, so a 3×3 cell search is
// PROVABLY complete: a displacement of at most R moves each axis's floor(x/R) cell index by at
// most 1, so any two points within Euclidean distance R always share a cell or sit Chebyshev-
// adjacent). Positions barely move (a slow per-firefly Lissajous wander around a jittered-grid
// home, √2 x:y frequency ratio so it never retraces); the grid is rebuilt once a frame and reused
// across several fixed-dt phase substeps — the honest per-neighbour sin() sum, no shortcuts.
//
// Render: brightness is a two-sided Gaussian in phase, peaking at θ=0 (fast attack, slower decay,
// like a real bioluminescent flash), floored at an EMBER so no firefly ever goes fully dark. Each
// firefly splats a small cubic core + a softer quadratic halo (no per-pixel transcendentals — same
// divide-free-falloff spirit as chladni's ridge). Colour is grayscale except right at the flash peak,
// where it warms a hair (firefly-motivated, not literal bioluminescence green). You watch synchrony
// rise from scattered noise to travelling waves of collective flashing across the whole meadow.
//
// Interaction: click = a lantern flash — pulls nearby phases toward the flash instant, seeding a
// wave. Drag = a desync brush — scatters nearby phases toward fresh random targets. Both taper
// smoothly to the edge of their radius (a soft brush, not a hard stencil).
//
// jz typing: every persistent FRACTIONAL scalar (radius, clock, coupling gain…) lives in the ST
// Float64Array — bare `let` module globals get i32-narrowed unless provably fractional (see
// examples/fern/fern.js). Integer state (W, H, count, grid dims) stays plain `let`. A custom seeded
// LCG (`rnd`, same recurrence as examples/boids/boids.js) drives ALL randomness — never Math.random —
// so init()/randomize()/scatter() are bit-exact identical between the JS import and the compiled wasm
// when driven with the same call sequence.

let W = 0, H = 0, px
let glow                                // Float32Array W*H — per-pixel brightness, rebuilt every frame

const MAXN = 3200
let count = 2600                        // current N (randomize varies it in [2200,3200))
let fx = new Float64Array(MAXN), fy = new Float64Array(MAXN)      // current position
let hx = new Float64Array(MAXN), hy = new Float64Array(MAXN)      // wander home
let theta = new Float64Array(MAXN)                                // phase θ_i, kept in [0, 2π)
let omega = new Float64Array(MAXN)                                // natural frequency ω_i (rad/s)
let dth = new Float64Array(MAXN)                                  // scratch: dθ/dt (synchronous update)
let wfreq = new Float64Array(MAXN), wphase = new Float64Array(MAXN)  // per-firefly wander rate + phase

// grid spatial binning (linked-list buckets): cell size == coupling radius R, so a 3×3 cell
// search around any firefly is provably complete (see header). Rebuilt every frame from scratch.
let gridCols = 1, gridRows = 1
let ghead = new Int32Array(1)           // per-cell head index, -1 = empty; sized in recalcGeometry()
let gnext = new Int32Array(MAXN)        // per-firefly "next in this cell" link

// persistent FRACTIONAL scalars (Float64Array — see header)
const I_R = 0, I_R2 = 1, I_CELL = 2, I_SPACING = 3, I_K = 4, I_CLOCK = 5, I_FLASHR2 = 6, I_SCATR2 = 7, I_WAMP = 8
let ST = new Float64Array(9)

let SEED = 0                            // custom LCG seed (i32) — never Math.random, see header


const TWO_PI = 6.283185307179586
const PI = 3.141592653589793
const SQRT2 = 1.4142135623730951

const SUBSTEPS = 4                      // several fixed-dt substeps per frame (synchronous Euler)
const FRAME_DT = 1.0 / 60.0             // simulated seconds advanced per frame() call (self-paced)
const DT = FRAME_DT / SUBSTEPS

const MEAN_HZ = 0.75, SIGMA_HZ = 0.12   // natural flash rate ~ Gaussian(0.75 Hz, 0.12 Hz)
const RADIUS_SPACINGS = 3.0             // coupling radius, in units of average firefly spacing
const K_BASE = 5.5                      // coupling gain (mean-field-equivalent; ~4.5x critical)

const JITTER_FRAC = 0.40                // jittered-grid scatter, fraction of cell spacing
const WANDER_FRAC = 0.26                // wander amplitude, fraction of spacing
const WANDER_FMIN = 0.10, WANDER_FSPAN = 0.20   // per-firefly wander angular rate (rad / sim-second)

const EMBER = 0.06                      // resting glow floor — never fully dark
const SIG_ATTACK = 0.22, SIG_DECAY = 0.44     // flash pulse phase width (fast attack, slower decay)

const CORE_R = 1.7, INV_CORE_R2 = 1.0 / (CORE_R * CORE_R)   // bright 2-4px core, cubic falloff
const HALO_R = 3.4, INV_HALO_R2 = 1.0 / (HALO_R * HALO_R)   // soft halo, quadratic falloff
const HALO_AMT = 0.40

const FLASH_FRAC = 0.16, SCATTER_FRAC = 0.12   // interaction radii, fraction of min(W,H)

// ── deterministic PRNG (LCG, i32) — see examples/boids/boids.js: init()/randomize()/scatter()
// never touch Math.random, so JS and compiled-wasm stay bit-exact given the same call sequence. ──
let rnd = () => {
  SEED = (SEED * 1103515245 + 12345) | 0
  return ((SEED >>> 8) & 0xffff) / 65536.0
}

// standard Box-Muller — one Gaussian sample from two uniforms
let gauss = () => {
  let u1 = rnd()
  if (u1 < 1e-9) u1 = 1e-9
  let u2 = rnd()
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(TWO_PI * u2)
}

// Recompute every size that derives from (W, H, count): spacing → coupling radius → grid cell
// size + dims, wander amplitude, interaction radii. Called after resize() and after any re-seed
// (randomize() may change count). Cheap (a handful of scalars + a small Int32Array alloc).
let recalcGeometry = () => {
  let spacing = Math.sqrt((W * H) / count)
  let r = RADIUS_SPACINGS * spacing
  ST[I_SPACING] = spacing
  ST[I_R] = r
  ST[I_R2] = r * r
  ST[I_CELL] = r
  ST[I_WAMP] = spacing * WANDER_FRAC
  let s = W < H ? W : H
  let fr = s * FLASH_FRAC, sr = s * SCATTER_FRAC
  ST[I_FLASHR2] = fr * fr
  ST[I_SCATR2] = sr * sr
  gridCols = Math.ceil(W / r) | 0; if (gridCols < 1) gridCols = 1
  gridRows = Math.ceil(H / r) | 0; if (gridRows < 1) gridRows = 1
  ghead = new Int32Array(gridCols * gridRows)
}

// Jittered-grid scatter across the whole field: a natural-looking meadow, not a rigid lattice.
// Draws a fresh N∈[1200,2000), positions, phases, Gaussian frequencies, wander params and the
// coupling gain K — everything randomize()/init() touch, in one coherent re-seed.
let scatterField = () => {
  count = 2200 + ((rnd() * 1000) | 0)
  let cols = Math.round(Math.sqrt((count * W) / H)) | 0
  if (cols < 1) cols = 1
  let rows = Math.ceil(count / cols) | 0
  if (rows < 1) rows = 1
  let spX = W / cols, spY = H / rows
  let i = 0
  while (i < count) {
    let cx = i % cols, cy = (i / cols) | 0
    let jx = (rnd() - 0.5) * 2.0 * JITTER_FRAC * spX
    let jy = (rnd() - 0.5) * 2.0 * JITTER_FRAC * spY
    let x = (cx + 0.5) * spX + jx
    let y = (cy + 0.5) * spY + jy
    hx[i] = x; hy[i] = y; fx[i] = x; fy[i] = y
    theta[i] = rnd() * TWO_PI
    let fHz = MEAN_HZ + gauss() * SIGMA_HZ
    if (fHz < 0.15) fHz = 0.15
    omega[i] = fHz * TWO_PI
    wfreq[i] = WANDER_FMIN + rnd() * WANDER_FSPAN
    wphase[i] = rnd() * TWO_PI
    i++
  }
  ST[I_K] = K_BASE * (0.82 + rnd() * 0.55)
  ST[I_CLOCK] = 0.0
  recalcGeometry()
}

// Gentle per-firefly wander: a Lissajous loop around its home point, √2 x:y frequency ratio so the
// path never retraces (same "irrational ratio avoids periodicity" idea as phyllotaxis' golden
// angle). Positions update once per frame — the phase substeps below reuse this frame's grid.
let updatePositions = () => {
  let clk = ST[I_CLOCK] + FRAME_DT
  ST[I_CLOCK] = clk
  let wamp = ST[I_WAMP]
  let i = 0
  while (i < count) {
    let a = clk * wfreq[i] + wphase[i]
    let nx = hx[i] + Math.cos(a) * wamp
    let ny = hy[i] + Math.sin(a * SQRT2 + wphase[i]) * wamp
    if (nx < 0.0) nx = 0.0; else if (nx > W - 1) nx = W - 1
    if (ny < 0.0) ny = 0.0; else if (ny > H - 1) ny = H - 1
    fx[i] = nx; fy[i] = ny
    i++
  }
}

let rebuildGrid = () => {
  let n = gridCols * gridRows, c = 0
  while (c < n) { ghead[c] = -1; c++ }
  let cell = ST[I_CELL]
  let i = 0
  while (i < count) {
    let gx = (fx[i] / cell) | 0
    let gy = (fy[i] / cell) | 0
    if (gx < 0) gx = 0; else if (gx >= gridCols) gx = gridCols - 1
    if (gy < 0) gy = 0; else if (gy >= gridRows) gy = gridRows - 1
    let c2 = gy * gridCols + gx
    gnext[i] = ghead[c2]
    ghead[c2] = i
    i++
  }
}

// One synchronous (parallel) Euler substep of the Kuramoto ODE: dθ_i/dt = ω_i + (K/n_i)Σsin(θj-θi),
// neighbours found via the 3×3 grid search. Two-phase — compute every dθ from the OLD phases first,
// THEN commit — so no firefly's update leaks into another's sum within the same substep.
let integrate = () => {
  let r2 = ST[I_R2], k = ST[I_K], cell = ST[I_CELL]
  let i = 0
  while (i < count) {
    let xi = fx[i], yi = fy[i], thi = theta[i]
    let gx = (xi / cell) | 0, gy = (yi / cell) | 0
    if (gx < 0) gx = 0; else if (gx >= gridCols) gx = gridCols - 1
    if (gy < 0) gy = 0; else if (gy >= gridRows) gy = gridRows - 1
    let sum = 0.0, n = 0
    let cy = gy - 1
    while (cy <= gy + 1) {
      if (cy >= 0 && cy < gridRows) {
        let cx = gx - 1
        while (cx <= gx + 1) {
          if (cx >= 0 && cx < gridCols) {
            let j = ghead[cy * gridCols + cx]
            while (j >= 0) {
              if (j != i) {
                let dx = fx[j] - xi, dy = fy[j] - yi
                if (dx * dx + dy * dy < r2) { sum += Math.sin(theta[j] - thi); n++ }
              }
              j = gnext[j]
            }
          }
          cx++
        }
      }
      cy++
    }
    dth[i] = omega[i] + (n > 0 ? (k / n) * sum : 0.0)
    i++
  }
  let m = 0
  while (m < count) {
    let th = theta[m] + DT * dth[m]
    if (th >= TWO_PI) th -= TWO_PI
    else if (th < 0.0) th += TWO_PI
    theta[m] = th
    m++
  }
}

// Two-sided Gaussian pulse in phase, peaking at θ=0 (fast attack, slower decay), floored at EMBER
// so a resting firefly still shows a faint mark. Only ~N calls/frame — Math.exp here is fine; the
// per-PIXEL splat below avoids transcendentals entirely (that's the hot O(N·pixels) loop).
let brightness = (th) => {
  let d = th > PI ? th - TWO_PI : th
  let sig = d < 0.0 ? SIG_ATTACK : SIG_DECAY
  let p = Math.exp(-(d * d) / (2.0 * sig * sig))
  return EMBER + (1.0 - EMBER) * p
}

// Cubic-core + quadratic-halo splat — divide-free falloff (same spirit as chladni's ridge), no
// per-pixel transcendentals. Loop bounds are clipped (not skipped) so edge fireflies still show.
let splat = (fxp, fyp, b) => {
  let ix = fxp | 0, iy = fyp | 0
  let x0 = ix - 3, x1 = ix + 3, y0 = iy - 3, y1 = iy + 3
  if (x0 < 0) x0 = 0
  if (y0 < 0) y0 = 0
  if (x1 > W - 1) x1 = W - 1
  if (y1 > H - 1) y1 = H - 1
  let py = y0
  while (py <= y1) {
    let dy = py - fyp, dy2 = dy * dy
    let pxk = x0
    while (pxk <= x1) {
      let dx = pxk - fxp
      let d2 = dx * dx + dy2
      let core = 1.0 - d2 * INV_CORE_R2
      core = core > 0.0 ? core * core * core : 0.0
      let halo = 1.0 - d2 * INV_HALO_R2
      halo = halo > 0.0 ? halo * halo : 0.0
      let add = b * (core + halo * HALO_AMT)
      if (add > 0.0) { let idx = py * W + pxk; glow[idx] = glow[idx] + add }
      pxk++
    }
    py++
  }
}

// glow → px: grayscale, warming only right at the flash peak (v³ gate keeps the ember/mid range
// neutral) — "near-white flashes with the faintest warm tint; grayscale otherwise."
let composite = () => {
  let n = W * H, i = 0
  while (i < n) {
    let v = glow[i]; if (v > 1.0) v = 1.0
    let v3 = v * v * v
    let r = (v * 255.0) | 0
    let g = (v * 255.0 - v3 * 6.0) | 0
    let b = (v * 255.0 - v3 * 24.0) | 0
    if (g < 0) g = 0
    if (b < 0) b = 0
    px[i] = (255 << 24) | (b << 16) | (g << 8) | r
    i++
  }
}

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  glow = new Float32Array(w * h)
  recalcGeometry()
  return px
}

export let init = () => {
  SEED = 1234567
  scatterField()
}

export let randomize = () => {
  SEED = (SEED + 0x2545f491) | 0
  scatterField()
}

// A lantern flash: pulls nearby phases toward the flash instant (θ=0), tapering smoothly to the
// edge of the radius — seeds a synchrony wave that then propagates through the local coupling.
export let flash = (mx, my) => {
  let r2 = ST[I_FLASHR2]
  let i = 0
  while (i < count) {
    let dx = fx[i] - mx, dy = fy[i] - my
    let d2 = dx * dx + dy * dy
    if (d2 < r2) {
      let k = 1.0 - d2 / r2
      let th = theta[i]; if (th > PI) th -= TWO_PI      // signed distance from θ=0
      th = th * (1.0 - k)
      if (th < 0.0) th += TWO_PI
      theta[i] = th
    }
    i++
  }
}

// A desync brush: pulls nearby phases toward a fresh random target along the shorter arc,
// tapering to the edge of the radius — scatters a patch of order back into chaos.
export let scatter = (mx, my) => {
  let r2 = ST[I_SCATR2]
  let i = 0
  while (i < count) {
    let dx = fx[i] - mx, dy = fy[i] - my
    let d2 = dx * dx + dy * dy
    if (d2 < r2) {
      let k = 1.0 - d2 / r2
      let th = theta[i]
      let target = rnd() * TWO_PI
      let diff = target - th
      if (diff > PI) diff -= TWO_PI; else if (diff < -PI) diff += TWO_PI
      th = th + diff * k
      if (th < 0.0) th += TWO_PI; else if (th >= TWO_PI) th -= TWO_PI
      theta[i] = th
    }
    i++
  }
}

export let frame = (t) => {
  updatePositions()
  rebuildGrid()
  let s = 0
  while (s < SUBSTEPS) { integrate(); s++ }

  let n = W * H, i = 0
  while (i < n) { glow[i] = 0.0; i++ }
  i = 0
  while (i < count) { splat(fx[i], fy[i], brightness(theta[i])); i++ }
  composite()
}
