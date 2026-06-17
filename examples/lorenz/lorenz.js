// Lorenz attractor — the canonical chaotic ODE that started it all.
// σ=10, ρ=28, β=8/3. RK4 integration, ~200 substeps per frame.
// Persistent pixel buffer fades each frame (×0.93), each substep projects
// the 3D point onto 2D with a slow rotation and paints a bright dot.
// → glowing butterfly trail that never repeats.
//
// Float64Array for ALL fractional persistent state (x,y,z,θ,scale,offsets)
// — scalar f64 module globals would be i32-narrowed in jz.

let W = 0, H = 0, px
// [x, y, z, θ, scX, scY, offX, offY]
let st = new Float64Array(8)
const SIG = 10.0, RHO = 28.0, BETA = 8.0 / 3.0
const DT = 0.005, STEPS = 340

// Lorenz derivatives
let dx = (x, y, z) => SIG * (y - x)
let dy = (x, y, z) => x * (RHO - z) - y
let dz = (x, y, z) => x * y - BETA * z

export let resize = (w, h) => {
  W = w; H = h
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
}

// add a gray dot (R=G=B) at (ix,iy), saturating — the fade later turns it into a glow
let plot = (ix, iy, add) => {
  if (ix < 0 || ix >= W || iy < 0 || iy >= H) return
  let idx = iy * W + ix
  let nc = (px[idx] & 0xff) + add; if (nc > 255) nc = 255
  px[idx] = (255 << 24) | (nc << 16) | (nc << 8) | nc
}

export let frame = (t, theta) => {
  let x = st[0], y = st[1], z = st[2]
  let cosT = Math.cos(theta), sinT = Math.sin(theta)
  let scX = st[4], scY = st[5], offX = st[6], offY = st[7]

  // fade all pixels by 0.93 per channel (packed ABGR: only touch RGB bytes)
  let n = W * H, i = 0
  while (i < n) {
    let p = px[i]
    if (p & 0xffffff) {
      let r = ((p & 0xff) * 249) >> 8          // slow fade ≈ ×0.973 → trails persist ~4× longer = denser
      let g = (((p >> 8) & 0xff) * 249) >> 8
      let b = (((p >> 16) & 0xff) * 249) >> 8
      px[i] = (255 << 24) | (b << 16) | (g << 8) | r
    }
    i++
  }

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

    // 2×2 splat (bright centre, dimmer neighbours) → a 2px ribbon instead of a 1px thread,
    // so the wings read as a dense surface rather than a sparse wire.
    let ix = sx | 0, iy = sy | 0
    plot(ix, iy, 170)
    plot(ix + 1, iy, 95)
    plot(ix, iy + 1, 95)
    plot(ix + 1, iy + 1, 55)
    k++
  }

  st[0] = x; st[1] = y; st[2] = z
}
