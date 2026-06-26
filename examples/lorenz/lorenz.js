// Lorenz attractor — the canonical chaotic ODE that started it all (σ=10, ρ=28, β=8/3, RK4).
//
// The whole trajectory lives as a ring buffer of 3D points; EVERY frame the entire buffer is
// re-projected at the current rotation into a fresh energy field. Because nothing is accumulated in
// screen space across frames, the butterfly rotates as one solid 3D body — no rotational smearing.
// Density does the shading: where the orbit crowds (the spiral cores) the points pile up and glow
// white; the sparse outer loops stay dim. The newest points form a brighter comet head that traces
// the live orbit. The projection uses ONE uniform scale, so the butterfly keeps its true proportions
// at any window aspect (it centres with margins on a wide screen rather than stretching).
//
// All fractional persistent state is in Float64Array (scalar f64 globals are i32-narrowed in jz).

let W = 0, H = 0, px
let energy        // Float32Array — per-pixel intensity, rebuilt every frame
// [x, y, z, _, scX, scY, offX, offY]
let st = new Float64Array(8)
// theme colours: [paperR,G,B, inkR,G,B] — host feeds them; default = black paper, white ink
let col = new Float64Array(6)
col[0] = 0.0; col[1] = 0.0; col[2] = 0.0; col[3] = 240.0; col[4] = 240.0; col[5] = 240.0

const SIG = 10.0, RHO = 28.0, BETA = 8.0 / 3.0
const DT = 0.006
const STEPS = 14          // trajectory substeps advanced per frame → a slow, trackable comet head
const HMAX = 90000        // 3D history length — dense enough to draw a SOLID glowing attractor
const DEPOSIT = 0.022     // energy per segment pixel — low, since the connecting LINES touch far more
                         // pixels than sparse splats did; overlaps in the crowded cores still glow white
const HEADN = 2400        // the newest HEADN points get a brighter, tapering comet head
const HEADADD = 0.16

// 3D trajectory ring buffer (module scope — never reallocated, so resize can't detach the px view)
let hx = new Float64Array(HMAX), hy = new Float64Array(HMAX), hz = new Float64Array(HMAX)
let hhead = 0, hcount = 0

let dx = (x, y, z) => SIG * (y - x)
let dy = (x, y, z) => x * (RHO - z) - y
let dz = (x, y, z) => x * y - BETA * z

// one RK4 step on st[0..2]
let rk4 = () => {
  let x = st[0], y = st[1], z = st[2]
  let k1x = dx(x, y, z), k1y = dy(x, y, z), k1z = dz(x, y, z)
  let ax = x + DT * 0.5 * k1x, ay = y + DT * 0.5 * k1y, az = z + DT * 0.5 * k1z
  let k2x = dx(ax, ay, az), k2y = dy(ax, ay, az), k2z = dz(ax, ay, az)
  let bx = x + DT * 0.5 * k2x, by = y + DT * 0.5 * k2y, bz = z + DT * 0.5 * k2z
  let k3x = dx(bx, by, bz), k3y = dy(bx, by, bz), k3z = dz(bx, by, bz)
  let cx = x + DT * k3x, cy = y + DT * k3y, cz = z + DT * k3z
  let k4x = dx(cx, cy, cz), k4y = dy(cx, cy, cz), k4z = dz(cx, cy, cz)
  st[0] = x + (DT / 6.0) * (k1x + 2.0 * k2x + 2.0 * k3x + k4x)
  st[1] = y + (DT / 6.0) * (k1y + 2.0 * k2y + 2.0 * k3y + k4y)
  st[2] = z + (DT / 6.0) * (k1z + 2.0 * k2z + 2.0 * k3z + k4z)
}

let push = () => {
  let h = hhead
  hx[h] = st[0]; hy[h] = st[1]; hz[h] = st[2]
  hhead = h + 1; if (hhead >= HMAX) hhead = 0
  if (hcount < HMAX) hcount = hcount + 1
}

export let resize = (w, h) => {
  W = w; H = h
  energy = new Float32Array(w * h)
  px = new Uint32Array(w * h)
  // ONE uniform scale (based on the shorter side) → the butterfly keeps its true x:z proportions at
  // any window aspect, centred. x spans ≈ ±20, z spans ≈ 0..48 (centre ≈ 24).
  let S = w < h ? w : h
  st[4] = S * 0.022                 // scX (wide enough to separate the two wing-spirals)
  st[5] = S * 0.017                 // scY
  st[6] = w * 0.5                   // offX — horizontal centre
  st[7] = h * 0.5 + 24.0 * st[5]    // offY — z≈24 lands at mid-frame
  return px
}

export let init = () => {
  st[0] = 0.1; st[1] = 0.0; st[2] = 0.0
  // discard the spiral-in transient (it isn't on the attractor)
  let w0 = 0
  while (w0 < 1500) { rk4(); w0++ }
  // pre-fill the ring so the butterfly is fully drawn from frame 1
  hhead = 0; hcount = 0
  let i = 0
  while (i < HMAX) { rk4(); push(); i++ }
  let n = W * H, j = 0
  while (j < n) { energy[j] = 0.0; j++ }
}

// theme palette (paper = background, ink = trail). The harness fixes this to black/white.
export let setTheme = (pr, pg, pb, ir, ig, ib) => {
  col[0] = pr; col[1] = pg; col[2] = pb; col[3] = ir; col[4] = ig; col[5] = ib
}

// soft cross splat → the orbit reads as a substantial surface, not vanishing single pixels
let plot = (ix, iy, add) => {
  if (ix < 1 || ix >= W - 1 || iy < 1 || iy >= H - 1) return
  let c = iy * W + ix
  energy[c] = energy[c] + add
  energy[c - 1] = energy[c - 1] + add * 0.4
  energy[c + 1] = energy[c + 1] + add * 0.4
  energy[c - W] = energy[c - W] + add * 0.4
  energy[c + W] = energy[c + W] + add * 0.4
}

// single-pixel energy deposit (the body of a connecting segment)
let dep = (ix, iy, add) => {
  if (ix < 0 || ix >= W || iy < 0 || iy >= H) return
  let c = iy * W + ix
  energy[c] = energy[c] + add
}

// connect two consecutive projected samples with a thin segment → the orbit reads as one
// continuous glowing CURVE instead of a stipple of dots (crowding still builds the density glow)
let plotLine = (x0, y0, x1, y1, add) => {
  let ddx = x1 - x0, ddy = y1 - y0
  let adx = ddx < 0 ? -ddx : ddx
  let ady = ddy < 0 ? -ddy : ddy
  let steps = adx > ady ? adx : ady
  if (steps < 1) { plot(x0, y0, add); return 0.0 }
  if (steps > 64) steps = 64                       // guard a rare long jump across the lobes
  let ux = ddx / steps, uy = ddy / steps
  let fx = x0 + 0.0, fy = y0 + 0.0, s = 0
  while (s <= steps) {
    dep(fx | 0, fy | 0, add)
    fx = fx + ux; fy = fy + uy
    s++
  }
  return 0.0
}

export let frame = (t, theta) => {
  // advance the live orbit a little
  let k = 0
  while (k < STEPS) { rk4(); push(); k++ }

  // clear the field — it is rebuilt fresh at the current rotation (no screen-space smear)
  let n = W * H, i = 0
  while (i < n) { energy[i] = 0.0; i++ }

  // re-project the whole 3D history at the current rotation; newest first → comet head
  let cosT = Math.cos(theta), sinT = Math.sin(theta)
  let scX = st[4], scY = st[5], offX = st[6], offY = st[7]
  let newest = hhead - 1
  if (newest < 0) newest = HMAX - 1
  let psx = 0, psy = 0, hasPrev = 0
  let j = 0
  while (j < hcount) {
    let idx = newest - j
    if (idx < 0) idx = idx + HMAX
    let X = hx[idx], Y = hy[idx], Z = hz[idx]
    let isx = ((X * cosT - Y * sinT) * scX + offX) | 0
    let isy = (offY - Z * scY) | 0
    let add = DEPOSIT
    if (j < HEADN) add = add + HEADADD * (1.0 - j / HEADN)   // bright, tapering comet head
    if (hasPrev != 0) plotLine(psx, psy, isx, isy, add)      // join consecutive samples → curve
    else plot(isx, isy, add)
    if (j < HEADN) plot(isx, isy, add)                       // extra glow on the comet head
    psx = isx; psy = isy; hasPrev = 1
    j++
  }

  // composite: every pixel = lerp(paper, ink, intensity) — opaque, so the bg is exactly the paper
  let pr = col[0], pg = col[1], pb = col[2], ir = col[3], ig = col[4], ib = col[5]
  i = 0
  while (i < n) {
    let e = energy[i]; if (e > 1.0) e = 1.0
    let r = (pr + (ir - pr) * e) | 0
    let g = (pg + (ig - pg) * e) | 0
    let b = (pb + (ib - pb) * e) | 0
    px[i] = (255 << 24) | (b << 16) | (g << 8) | r
    i++
  }
}
