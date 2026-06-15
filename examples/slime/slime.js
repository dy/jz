// Slime mold (Physarum) — thousands of agents crawl over a pheromone trail map. Each
// step an agent samples the trail at three sensors (ahead, ahead-left, ahead-right),
// steers toward the strongest, moves, and deposits a little trail. The map then diffuses
// and decays. From these tiny local rules, transport networks self-organize. It's a mix
// of scattered-memory agent updates and a grid stencil — a good combined workout for jz.
// resize(w,h) → Uint32Array; frame() steps agents + map and renders.

let W = 0, H = 0, px
let ax, ay, ah            // agent x, y, heading
let na = 0
let ta, tb                // trail map ping-pong
let flip = 0

let SA = 0.5              // sensor angle (rad)
let SD = 9.0             // sensor distance (px)
let TA = 0.4              // turn step (rad)
let SP = 1.0             // move speed (px/step)
let DECAY = 0.90

export let resize = (w, h) => {
  W = w; H = h
  let n = w * h
  ta = new Float64Array(n); tb = new Float64Array(n)
  px = new Uint32Array(n)
  na = (n * 0.10) | 0          // ~10% of cells are agents
  ax = new Float64Array(na); ay = new Float64Array(na); ah = new Float64Array(na)
  flip = 0
  return px
}

export let seed = () => {
  let n = W * H, i = 0
  while (i < n) { ta[i] = 0.0; tb[i] = 0.0; i++ }
  // start agents in a disc, headings outward → an expanding colony
  let cx = W * 0.5, cy = H * 0.5, rad = (W < H ? W : H) * 0.28
  let a = 0
  while (a < na) {
    let ang = Math.random() * 6.283185307179586
    let r = Math.sqrt(Math.random()) * rad
    ax[a] = cx + Math.cos(ang) * r
    ay[a] = cy + Math.sin(ang) * r
    ah[a] = ang
    a++
  }
  flip = 0
}

// Drag deposits a blob of trail the colony is drawn toward (into both buffers).
export let poke = (cx, cy, r) => {
  let x0 = cx - r | 0, x1 = cx + r | 0, y0 = cy - r | 0, y1 = cy + r | 0
  if (x0 < 0) x0 = 0
  if (y0 < 0) y0 = 0
  if (x1 > W - 1) x1 = W - 1
  if (y1 > H - 1) y1 = H - 1
  let r2 = r * r
  let y = y0
  while (y <= y1) {
    let dy = y - cy, row = y * W, x = x0
    while (x <= x1) {
      let dx = x - cx
      if (dx * dx + dy * dy <= r2) { ta[row + x] = 1.6; tb[row + x] = 1.6 }
      x++
    }
    y++
  }
}

// sample the current trail map at (px,py) with wrap
let sample = (src, fx, fy) => {
  let xi = fx | 0, yi = fy | 0
  if (xi < 0) xi += W; else if (xi >= W) xi -= W
  if (yi < 0) yi += H; else if (yi >= H) yi -= H
  return src[yi * W + xi]
}

export let frame = (t) => {
  let src = flip === 0 ? ta : tb
  let dst = flip === 0 ? tb : ta

  // ---- agents: sense → steer → move → deposit (into src) ----
  let a = 0
  while (a < na) {
    let h = ah[a], x = ax[a], y = ay[a]
    let f = sample(src, x + Math.cos(h) * SD, y + Math.sin(h) * SD)
    let l = sample(src, x + Math.cos(h - SA) * SD, y + Math.sin(h - SA) * SD)
    let r = sample(src, x + Math.cos(h + SA) * SD, y + Math.sin(h + SA) * SD)
    if (f >= l && f >= r) { /* keep heading */ }
    else if (l > r) h = h - TA
    else if (r > l) h = h + TA
    else h = h + (Math.random() - 0.5) * TA * 2.0
    let nx = x + Math.cos(h) * SP
    let ny = y + Math.sin(h) * SP
    if (nx < 0.0) nx += W; else if (nx >= W) nx -= W
    if (ny < 0.0) ny += H; else if (ny >= H) ny -= H
    ax[a] = nx; ay[a] = ny; ah[a] = h
    let c = (ny | 0) * W + (nx | 0)
    src[c] = src[c] + 0.6
    a++
  }

  // ---- trail map: 3×3 blur (diffuse) + decay → dst ----
  let w = W, h = H, y = 0
  while (y < h) {
    let yn = y > 0 ? y - 1 : h - 1
    let ys = y < h - 1 ? y + 1 : 0
    let rc = y * w, rn = yn * w, rs = ys * w
    let x = 0
    while (x < w) {
      let xw = x > 0 ? x - 1 : w - 1
      let xe = x < w - 1 ? x + 1 : 0
      let s = src[rn + xw] + src[rn + x] + src[rn + xe]
            + src[rc + xw] + src[rc + x] + src[rc + xe]
            + src[rs + xw] + src[rs + x] + src[rs + xe]
      dst[rc + x] = (s * 0.11111111) * DECAY
      x++
    }
    y++
  }
  flip = 1 - flip

  // ---- render dst → dark-navy → warm-white ramp ----
  let n = w * h, i = 0
  while (i < n) {
    let v = dst[i] * 1.6
    if (v > 1.0) v = 1.0
    let g = (v * 255.0) | 0
    px[i] = (255 << 24) | (g << 16) | (g << 8) | g
    i++
  }
}
