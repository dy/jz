// Lorenz attractor — the canonical chaotic ODE that started it all (σ=10, ρ=28, β=8/3, RK4).
//
// A SECOND trajectory — the twin — starts one instant behind the main one, at the identical point
// plus a ~1e-5 nudge (EPS): the butterfly's wingbeat. Same equations, same RK4, same rotation; it
// is drawn from its OWN history ring, tinted a cool electric blue where it shows. Because the twin's
// entire past (up to the moment it's seeded) is copied verbatim from the main trail, the two curves
// are pixel-identical at first — then the chaos amplifies that 1e-5 and the twin's comet head visibly
// peels away from the main head over the following seconds. The tint is masked by the main channel's
// own brightness, so it only shows where the twin ISN'T already hiding under the white main line —
// invisible while they overlap, revealed exactly as they diverge.
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
let energy        // Float32Array — main-trajectory intensity, rebuilt every frame
let energyT       // Float32Array — twin-trajectory intensity, rebuilt every frame
// [x, y, z, _, scX, scY, offX, offY]
let st = new Float64Array(8)
let st2 = new Float64Array(3)    // twin's [x, y, z] — a perturbed copy of st, integrated in lockstep
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
const EPS = 1.0e-5        // the twin's initial perturbation — "a butterfly flaps its wings in Brazil…"
const TINT_R = 70.0, TINT_G = 150.0, TINT_B = 255.0   // cool electric-blue the twin reveals once it
                                                        // peels away from the main line (see composite)
const EXC_GAIN = 2.2      // a freshly-diverged strand hasn't had 540 time-units of crowding to build
                          // density the way the baked-in history has, so it reads faint at DEPOSIT's
                          // native weight — this boosts the (already-zero-when-coincident) excess
                          // signal so the split reads clearly without touching the shared trail at all

// 3D trajectory ring buffers (module scope — never reallocated, so resize can't detach the px view).
// Main (hx/hy/hz) and twin (hx2/hy2/hz2) share ONE head/count — both are stepped and pushed together
// every substep, so the same ring index always names the same instant in both trajectories.
let hx = new Float64Array(HMAX), hy = new Float64Array(HMAX), hz = new Float64Array(HMAX)
let hx2 = new Float64Array(HMAX), hy2 = new Float64Array(HMAX), hz2 = new Float64Array(HMAX)
let hhead = 0, hcount = 0

let dx = (x, y, z) => SIG * (y - x)
let dy = (x, y, z) => x * (RHO - z) - y
let dz = (x, y, z) => x * y - BETA * z

// one RK4 step on state cell s[0..2] — shared by the main trajectory and its perturbed twin
let rk4 = (s) => {
  let x = s[0], y = s[1], z = s[2]
  let k1x = dx(x, y, z), k1y = dy(x, y, z), k1z = dz(x, y, z)
  let ax = x + DT * 0.5 * k1x, ay = y + DT * 0.5 * k1y, az = z + DT * 0.5 * k1z
  let k2x = dx(ax, ay, az), k2y = dy(ax, ay, az), k2z = dz(ax, ay, az)
  let bx = x + DT * 0.5 * k2x, by = y + DT * 0.5 * k2y, bz = z + DT * 0.5 * k2z
  let k3x = dx(bx, by, bz), k3y = dy(bx, by, bz), k3z = dz(bx, by, bz)
  let cx = x + DT * k3x, cy = y + DT * k3y, cz = z + DT * k3z
  let k4x = dx(cx, cy, cz), k4y = dy(cx, cy, cz), k4z = dz(cx, cy, cz)
  s[0] = x + (DT / 6.0) * (k1x + 2.0 * k2x + 2.0 * k3x + k4x)
  s[1] = y + (DT / 6.0) * (k1y + 2.0 * k2y + 2.0 * k3y + k4y)
  s[2] = z + (DT / 6.0) * (k1z + 2.0 * k2z + 2.0 * k3z + k4z)
}

let push = () => {
  let h = hhead
  hx[h] = st[0]; hy[h] = st[1]; hz[h] = st[2]
  hx2[h] = st2[0]; hy2[h] = st2[1]; hz2[h] = st2[2]
  hhead = h + 1; if (hhead >= HMAX) hhead = 0
  if (hcount < HMAX) hcount = hcount + 1
}

export let resize = (w, h) => {
  W = w; H = h
  energy = new Float32Array(w * h)
  energyT = new Float32Array(w * h)
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
  while (w0 < 1500) { rk4(st); w0++ }
  // pre-fill the ring so the butterfly is fully drawn from frame 1 (the twin isn't seeded yet —
  // push() writes zeros into hx2/hy2/hz2 here, harmlessly overwritten by the copy right below)
  hhead = 0; hcount = 0
  let i = 0
  while (i < HMAX) { rk4(st); push(); i++ }
  // the twin is born THIS instant: the main position plus EPS. Its past is a verbatim copy of the
  // main trail, so on the first frame the two read as ONE curve — then live stepping (frame()) pulls
  // them apart, and the comet heads visibly separate.
  st2[0] = st[0] + EPS; st2[1] = st[1]; st2[2] = st[2]
  let k = 0
  while (k < HMAX) { hx2[k] = hx[k]; hy2[k] = hy[k]; hz2[k] = hz[k]; k++ }
  let n = W * H, j = 0
  while (j < n) { energy[j] = 0.0; energyT[j] = 0.0; j++ }
}

// theme palette (paper = background, ink = trail). The harness fixes this to black/white.
export let setTheme = (pr, pg, pb, ir, ig, ib) => {
  col[0] = pr; col[1] = pg; col[2] = pb; col[3] = ir; col[4] = ig; col[5] = ib
}

// soft cross splat → the orbit reads as a substantial surface, not vanishing single pixels.
// `fld` is whichever energy field (main or twin) the caller is depositing into.
let plot = (ix, iy, fld, add) => {
  if (ix < 1 || ix >= W - 1 || iy < 1 || iy >= H - 1) return
  let c = iy * W + ix
  fld[c] = fld[c] + add
  fld[c - 1] = fld[c - 1] + add * 0.4
  fld[c + 1] = fld[c + 1] + add * 0.4
  fld[c - W] = fld[c - W] + add * 0.4
  fld[c + W] = fld[c + W] + add * 0.4
}

// single-pixel energy deposit (the body of a connecting segment)
let dep = (ix, iy, fld, add) => {
  if (ix < 0 || ix >= W || iy < 0 || iy >= H) return
  let c = iy * W + ix
  fld[c] = fld[c] + add
}

// connect two consecutive projected samples with a thin segment → the orbit reads as one
// continuous glowing CURVE instead of a stipple of dots (crowding still builds the density glow)
let plotLine = (x0, y0, x1, y1, fld, add) => {
  let ddx = x1 - x0, ddy = y1 - y0
  let adx = ddx < 0 ? -ddx : ddx
  let ady = ddy < 0 ? -ddy : ddy
  let steps = adx > ady ? adx : ady
  if (steps < 1) { plot(x0, y0, fld, add); return 0.0 }
  if (steps > 64) steps = 64                       // guard a rare long jump across the lobes
  let ux = ddx / steps, uy = ddy / steps
  let fx = x0 + 0.0, fy = y0 + 0.0, s = 0
  while (s <= steps) {
    dep(fx | 0, fy | 0, fld, add)
    fx = fx + ux; fy = fy + uy
    s++
  }
  return 0.0
}

export let frame = (t, theta) => {
  // advance the live orbit a little — main and twin in lockstep, same substep count
  let k = 0
  while (k < STEPS) { rk4(st); rk4(st2); push(); k++ }

  // clear both fields — they are rebuilt fresh at the current rotation (no screen-space smear)
  let n = W * H, i = 0
  while (i < n) { energy[i] = 0.0; energyT[i] = 0.0; i++ }

  // re-project the whole 3D history (both rings share the rotation + scale) at the current rotation;
  // newest first → comet head
  let cosT = Math.cos(theta), sinT = Math.sin(theta)
  let scX = st[4], scY = st[5], offX = st[6], offY = st[7]
  let newest = hhead - 1
  if (newest < 0) newest = HMAX - 1
  let psx = 0, psy = 0, ptx = 0, pty = 0, hasPrev = 0
  let j = 0
  while (j < hcount) {
    let idx = newest - j
    if (idx < 0) idx = idx + HMAX

    let X = hx[idx], Y = hy[idx], Z = hz[idx]
    let isx = ((X * cosT - Y * sinT) * scX + offX) | 0
    let isy = (offY - Z * scY) | 0

    let Xt = hx2[idx], Yt = hy2[idx], Zt = hz2[idx]
    let itx = ((Xt * cosT - Yt * sinT) * scX + offX) | 0
    let ity = (offY - Zt * scY) | 0

    let add = DEPOSIT
    if (j < HEADN) add = add + HEADADD * (1.0 - j / HEADN)   // bright, tapering comet head

    if (hasPrev != 0) { plotLine(psx, psy, isx, isy, energy, add); plotLine(ptx, pty, itx, ity, energyT, add) }
    else { plot(isx, isy, energy, add); plot(itx, ity, energyT, add) }
    if (j < HEADN) { plot(isx, isy, energy, add); plot(itx, ity, energyT, add) }   // extra head glow

    psx = isx; psy = isy; ptx = itx; pty = ity; hasPrev = 1
    j++
  }

  // composite: main = lerp(paper, ink, e) as before — unchanged, so the long-shared history (main
  // and twin still pixel-identical there) reads exactly as one plain trail. The twin then lerps
  // toward a cool tint weighted by its EXCESS over the main density at this pixel (et−e, floored at
  // 0): that excess is ~0 wherever the two trails still coincide (same ring index, same projected
  // pixel — the common case everywhere except near the heads) and only rises where the diverged
  // twin visits pixels the main trail no longer does. A plain et·(1−e) mask would react to ordinary
  // mid-density overlap too (most of the trail isn't fully saturated), tinting the WHOLE butterfly —
  // the excess form isolates true divergence instead.
  let pr = col[0], pg = col[1], pb = col[2], ir = col[3], ig = col[4], ib = col[5]
  i = 0
  while (i < n) {
    let e = energy[i]; if (e > 1.0) e = 1.0
    let et = energyT[i]; if (et > 1.0) et = 1.0
    let r = pr + (ir - pr) * e
    let g = pg + (ig - pg) * e
    let b = pb + (ib - pb) * e
    let exc = et - e; if (exc < 0.0) exc = 0.0
    exc = exc * EXC_GAIN; if (exc > 1.0) exc = 1.0
    r = r + (TINT_R - r) * exc
    g = g + (TINT_G - g) * exc
    b = b + (TINT_B - b) * exc
    px[i] = (255 << 24) | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0)
    i++
  }
}
