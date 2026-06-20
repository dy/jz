// Lorenz attractor — the canonical chaotic ODE that started it all.
// σ=10, ρ=28, β=8/3. RK4 integration, many fine substeps per frame.
// A per-pixel ENERGY field decays each frame and the trajectory deposits into it; the field is
// then composited paper→ink, so the butterfly glows in whatever colour the page theme is wearing
// (light ink on dark paper, dark ink on light paper) — and the background is ALWAYS exactly the
// paper, so no faded-to-black smudges linger on a light page.
//
// Float64Array for ALL fractional persistent state (x,y,z,θ,scale,offsets)
// — scalar f64 module globals would be i32-narrowed in jz.

let W = 0, H = 0, px
let energy        // Float32Array — per-pixel trail intensity, decays + accumulates
// [x, y, z, θ, scX, scY, offX, offY]
let st = new Float64Array(8)
// theme colours: [paperR,paperG,paperB, inkR,inkG,inkB] — host feeds them; default = dark theme
let col = new Float64Array(6)
col[0] = 0.0; col[1] = 0.0; col[2] = 0.0; col[3] = 240.0; col[4] = 240.0; col[5] = 240.0
const SIG = 10.0, RHO = 28.0, BETA = 8.0 / 3.0
const DT = 0.00121, STEPS = 1400   // ~1.65× the substeps of before at the same trajectory pace
                                   // (DT·STEPS held ≈ 1.7) → a denser stippled surface
const FADE = 0.95                  // per-frame energy decay → trails persist ~70 frames
const DEPOSIT = 0.5                // energy added per substep hit

// Lorenz derivatives
let dx = (x, y, z) => SIG * (y - x)
let dy = (x, y, z) => x * (RHO - z) - y
let dz = (x, y, z) => x * y - BETA * z

export let resize = (w, h) => {
  W = w; H = h
  // allocate the energy field FIRST, then px LAST and return it — so no later allocation can grow
  // wasm memory and detach the px view the host just received.
  energy = new Float32Array(w * h)
  px = new Uint32Array(w * h)
  // Projection fit: Lorenz x,y span ≈ ±20..27 and z spans ≈ 0..48. Map z=0 near the
  // bottom (offY = 0.9h) rising to z≈48 near the top, and ±x across ~70% of the width —
  // so the whole butterfly sits centered in frame instead of flying off the top edge.
  st[4] = w * 0.022  // scX (wide enough to separate the two wing-spirals at x≈±8.5)
  st[5] = h * 0.017  // scY
  st[6] = w * 0.5    // offX
  st[7] = h * 0.90   // offY (z=0 sits low; rising z climbs the frame)
  return px
}

export let init = () => {
  st[0] = 0.1; st[1] = 0.0; st[2] = 0.0  // x,y,z
  st[3] = 0.0                               // θ
  let n = W * H, i = 0
  while (i < n) { energy[i] = 0.0; i++ }
}

// Set the theme palette (paper = background, ink = trail). The harness calls this on load and
// whenever the light/dark theme toggles, so the butterfly re-tints live.
export let setTheme = (pr, pg, pb, ir, ig, ib) => {
  col[0] = pr; col[1] = pg; col[2] = pb; col[3] = ir; col[4] = ig; col[5] = ib
}

// deposit energy at (ix,iy) — overlaps build up, fade later turns it into a glow
let plot = (ix, iy, add) => {
  if (ix < 0 || ix >= W || iy < 0 || iy >= H) return
  energy[iy * W + ix] = energy[iy * W + ix] + add
}

export let frame = (t, theta) => {
  let x = st[0], y = st[1], z = st[2]
  let cosT = Math.cos(theta), sinT = Math.sin(theta)
  let scX = st[4], scY = st[5], offX = st[6], offY = st[7]

  // decay the whole energy field
  let n = W * H, i = 0
  while (i < n) { energy[i] = energy[i] * FADE; i++ }

  // integrate & plot
  let k = 0
  while (k < STEPS) {
    // RK4
    let k1x = dx(x, y, z), k1y = dy(x, y, z), k1z = dz(x, y, z)
    let ax = x + DT * 0.5 * k1x, ay = y + DT * 0.5 * k1y, az = z + DT * 0.5 * k1z
    let k2x = dx(ax, ay, az), k2y = dy(ax, ay, az), k2z = dz(ax, ay, az)
    let bx = x + DT * 0.5 * k2x, by = y + DT * 0.5 * k2y, bz = z + DT * 0.5 * k2z
    let k3x = dx(bx, by, bz), k3y = dy(bx, by, bz), k3z = dz(bx, by, bz)
    let cx = x + DT * k3x, cy = y + DT * k3y, cz = z + DT * k3z
    let k4x = dx(cx, cy, cz), k4y = dy(cx, cy, cz), k4z = dz(cx, cy, cz)
    x = x + (DT / 6.0) * (k1x + 2.0 * k2x + 2.0 * k3x + k4x)
    y = y + (DT / 6.0) * (k1y + 2.0 * k2y + 2.0 * k3y + k4y)
    z = z + (DT / 6.0) * (k1z + 2.0 * k2z + 2.0 * k3z + k4z)

    // project: rotate in XY plane, use z as vertical
    let sx = (x * cosT - y * sinT) * scX + offX
    let sy = offY - z * scY

    // a single fine 1px point — the high substep count makes the trail dense without
    // fattening each dot, so the wings read as a delicate stippled surface, not a ribbon.
    plot(sx | 0, sy | 0, DEPOSIT)
    k++
  }

  st[0] = x; st[1] = y; st[2] = z

  // composite: every pixel = lerp(paper, ink, intensity). Writing all pixels (opaque) means the
  // background is exactly the paper colour in any theme — no transparent gaps, no stale smudges.
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
