// Paper marbling (suminagashi / ebru) — ink floating on a still bath. Dropping ink lays a
// blob; dragging a stylus (a "tine") shears the whole field along the stroke with a
// distance falloff f = Z/(Z+d), so ink swirls into the characteristic non-mixing filaments.
// Each drag does a backward-mapped bilinear resample of the ink field — a gather over every
// pixel, memory-bound work for jz. Grayscale ink on white paper. resize(w,h) → Uint32Array.

let W = 0, H = 0, px
let ink, tmp          // ink shade field (0 = paper)
let shade = 0.25      // next drop's shade, cycles for contrast

export let resize = (w, h) => {
  W = w; H = h
  ink = new Float64Array(w * h); tmp = new Float64Array(w * h)
  px = new Uint32Array(w * h)
  return px
}
export let clear = () => { let n = W * H, i = 0; while (i < n) { ink[i] = 0.0; i++ } shade = 0.25 }

// drop a disc of ink; each drop a different shade so the swirls read
export let drop = (cx, cy, r) => {
  shade += 0.21; if (shade > 0.95) shade = 0.28
  let x0 = cx - r | 0, x1 = cx + r | 0, y0 = cy - r | 0, y1 = cy + r | 0
  if (x0 < 0) x0 = 0
  if (y0 < 0) y0 = 0
  if (x1 > W - 1) x1 = W - 1
  if (y1 > H - 1) y1 = H - 1
  let r2 = r * r, y = y0
  while (y <= y1) {
    let dy = y - cy, row = y * W, x = x0
    while (x <= x1) {
      let dx = x - cx
      if (dx * dx + dy * dy <= r2) ink[row + x] = shade
      x++
    }
    y++
  }
}

let sample = (fx, fy) => {
  if (fx < 0.0) fx = 0.0; else if (fx > W - 1.001) fx = W - 1.001
  if (fy < 0.0) fy = 0.0; else if (fy > H - 1.001) fy = H - 1.001
  let i0 = fx | 0, j0 = fy | 0, sx = fx - i0, sy = fy - j0
  let a = ink[j0 * W + i0], b = ink[j0 * W + i0 + 1], c = ink[(j0 + 1) * W + i0], d = ink[(j0 + 1) * W + i0 + 1]
  return a * (1.0 - sx) * (1.0 - sy) + b * sx * (1.0 - sy) + c * (1.0 - sx) * sy + d * sx * sy
}

// stylus stroke A→B shears the ink along (ux,uy) with falloff by distance to the segment
export let tine = (ax, ay, bx, by) => {
  let ux = bx - ax, uy = by - ay
  let len2 = ux * ux + uy * uy + 0.0001
  let Z = (W < H ? W : H) * 0.16
  let y = 0
  while (y < H) {
    let row = y * W, x = 0
    while (x < W) {
      // distance from (x,y) to segment A-B
      let t = ((x - ax) * ux + (y - ay) * uy) / len2
      if (t < 0.0) t = 0.0; else if (t > 1.0) t = 1.0
      let cxp = ax + ux * t, cyp = ay + uy * t
      let ddx = x - cxp, ddy = y - cyp
      let d = Math.sqrt(ddx * ddx + ddy * ddy)
      let f = Z / (Z + d)
      tmp[row + x] = sample(x - ux * f, y - uy * f)     // backward map
      x++
    }
    y++
  }
  let s = ink; ink = tmp; tmp = s
}

// autonomous flow — the bath is never still: a slow time-varying curl field advects the
// ink so the pattern keeps drifting and swirling on its own (screensaver), drag still combs.
let flowStep = (t) => {
  let amp = 0.8, y = 0
  while (y < H) {
    let row = y * W, x = 0
    while (x < W) {
      let vx = amp * Math.sin(y * 0.045 + t * 0.7)
      let vy = amp * Math.cos(x * 0.045 + t * 0.5)
      tmp[row + x] = sample(x - vx, y - vy)
      x++
    }
    y++
  }
  let s = ink; ink = tmp; tmp = s
}

export let frame = (t) => {
  flowStep(t)
  let n = W * H, i = 0
  while (i < n) {
    let v = ink[i]
    let g = (255.0 - v * 255.0) | 0                       // white paper, dark ink
    if (g < 0) g = 0
    px[i] = (255 << 24) | (g << 16) | (g << 8) | g
    i++
  }
}
