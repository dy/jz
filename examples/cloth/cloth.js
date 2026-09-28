// Spring-mass cloth — a grid of point masses linked by distance constraints, integrated with
// Verlet (position-only) and relaxed by several constraint passes per frame, in 3D. Structural
// links (right + down) hold shape; a softer diagonal shear brace stops the lattice collapsing into
// slivers when twisted; a soft skip-one bending link keeps folds round instead of creased.
// The sheet hangs as a curtain: its top row is gathered onto anchors closer together than the rest
// spacing, so the spare fabric has nowhere to go but out of the plane — pleats at the rail that
// fan into long folds below. Gravity pulls down, a slow gusting wind billows it in depth, and you
// can grab and swing it. The constraint relaxation is pointer-chasing over the node grid — a
// memory-layout stress for jz, unlike the flat pixel kernels.
// Render: every cell is two z-buffered triangles, Gouraud-shaded from per-node normals — two-sided
// satin under a key light from the upper left (Lambert + a broad Blinn sheen), back faces a shade
// darker. resize(w,h) → Uint32Array; frame(t) steps; grab/drag/release to interact.

let W = 0, H = 0, px, zb
let GX = 120, GY = 48      // grid resolution — recomputed responsively from the screen in resize()
let N = GX * GY
let nx, ny, nz, ox, oy, oz // node pos + previous pos (Verlet)
let sh                     // per-node shade 0..1, from its normal
let pin                    // 1 = pinned
let L = 1.0                // rest length (px) — structural (axis) links
let LD = 1.0               // rest length (px) — diagonal (shear) links = L·√2
let LB = 2.0               // rest length (px) — bending (skip-one) links = 2L
let R = 0                  // grab pick radius (px) — set from screen, not grid
let grabbed = -1
let ITER = 8               // relaxation passes per frame
let GATHER = 0.55          // rail width ÷ rest width: how tightly the top is gathered
let PS = 4                 // top-row nodes per anchor: one pleat between neighbouring anchors

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  zb = new Float32Array(w * h)
  // A curtain whose gathered rail spans ~0.62 of the width, hanging to ~0.86 of the height.
  let m = w < h ? w : h
  L = m / 64
  LD = L * 1.4142135623730951   // √2 — diagonal of a square L×L cell
  LB = L * 2.0
  GX = (Math.round(w * 0.62 / GATHER / L) + 1) | 0
  GY = (Math.round(h * 0.74 / L) + 1) | 0
  if (GX > 160) GX = 160
  if (GX < 12) GX = 12
  if (GY > 120) GY = 120
  if (GY < 9) GY = 9
  GX = ((GX - 1) / PS | 0) * PS + 1   // the last column lands on an anchor
  N = GX * GY
  nx = new Float64Array(N); ny = new Float64Array(N); nz = new Float64Array(N)
  ox = new Float64Array(N); oy = new Float64Array(N); oz = new Float64Array(N)
  sh = new Float64Array(N)
  pin = new Int32Array(N)
  init()
  return px
}

// Lay the sheet already gathered: x squeezed toward the centre, z folded into a sine of the pleat
// period whose amplitude makes each link roughly its rest length — so it starts near equilibrium.
export let init = () => {
  R = (W < H ? W : H) * 0.1                                       // grab radius in px so finer grids stay grabbable
  let span = (GX - 1) * L * GATHER
  let x0 = (W - span) * 0.5, y0 = H * 0.08
  let amp = L * Math.sqrt(1.0 - GATHER * GATHER) * PS * 0.5
  let j = 0
  while (j < GY) {
    let i = 0
    while (i < GX) {
      let k = j * GX + i
      nx[k] = x0 + i * L * GATHER; ny[k] = y0 + j * L * 0.98
      nz[k] = Math.sin(i * 3.141592653589793 / PS) * amp
      ox[k] = nx[k]; oy[k] = ny[k]; oz[k] = nz[k]
      pin[k] = (j === 0 && i % PS === 0) ? 1 : 0                  // top row: anchors every PS nodes
      k++
      i++
    }
    j++
  }
  grabbed = -1
}

// grab the nearest node to (gx,gy)
export let grab = (gx, gy) => {
  let best = 1e18, bi = -1, i = 0
  while (i < N) {
    let dx = nx[i] - gx, dy = ny[i] - gy, d = dx * dx + dy * dy
    if (d < best) { best = d; bi = i }
    i++
  }
  if (best < R * R) grabbed = bi
}
export let drag = (gx, gy) => { if (grabbed >= 0) { nx[grabbed] = gx; ny[grabbed] = gy; ox[grabbed] = gx; oy[grabbed] = gy; oz[grabbed] = nz[grabbed] } }
export let release = () => { grabbed = -1 }

let relax = (a, b, rest, stiff) => {
  let dx = nx[b] - nx[a], dy = ny[b] - ny[a], dz = nz[b] - nz[a]
  let d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.0001
  let diff = (d - rest) / d * stiff
  let mx = dx * diff, my = dy * diff, mz = dz * diff
  let pa = pin[a] | (a === grabbed ? 1 : 0)
  let pb = pin[b] | (b === grabbed ? 1 : 0)
  if (pa === 0 && pb === 0) { nx[a] += mx; ny[a] += my; nz[a] += mz; nx[b] -= mx; ny[b] -= my; nz[b] -= mz }
  else if (pa === 0) { nx[a] += mx * 2.0; ny[a] += my * 2.0; nz[a] += mz * 2.0 }
  else if (pb === 0) { nx[b] -= mx * 2.0; ny[b] -= my * 2.0; nz[b] -= mz * 2.0 }
}

// Per-node shade from the normal (right − left) × (down − up): two-sided satin. Light from the upper
// left, toward the viewer; the viewer looks down −z, so the Blinn half-vector is normalize(l + ẑ).
let LX = -0.48, LY = -0.56, LZ = 0.67
let HX = -0.24, HY = -0.28, HZ = 0.93   // ≈ normalize(l + (0,0,1))
let shade = () => {
  let j = 0
  while (j < GY) {
    let ju = j > 0 ? j - 1 : 0, jd = j < GY - 1 ? j + 1 : GY - 1
    let i = 0
    while (i < GX) {
      let il = i > 0 ? i - 1 : 0, ir = i < GX - 1 ? i + 1 : GX - 1
      let a = j * GX + il, b = j * GX + ir, c = ju * GX + i, d = jd * GX + i
      let ux = nx[b] - nx[a], uy = ny[b] - ny[a], uz = nz[b] - nz[a]
      let vx = nx[d] - nx[c], vy = ny[d] - ny[c], vz = nz[d] - nz[c]
      let cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx
      let inv = 1.0 / (Math.sqrt(cx * cx + cy * cy + cz * cz) + 1e-9)
      cx *= inv; cy *= inv; cz *= inv
      let back = 1.0
      if (cz < 0.0) { cx = -cx; cy = -cy; cz = -cz; back = 0.72 }
      let dif = cx * LX + cy * LY + cz * LZ
      if (dif < 0.0) dif = 0.0
      let sp = cx * HX + cy * HY + cz * HZ
      sp = sp > 0.0 ? sp * sp : 0.0
      sp = sp * sp; sp = sp * sp; sp = sp * sp                    // ⁱ¹⁶ — a broad satin sheen
      sh[j * GX + i] = (0.06 + dif * 0.72) * back + sp * 0.34
      i++
    }
    j++
  }
}

// z-buffered, Gouraud-shaded triangle
let tri = (a, b, c) => {
  let ax = nx[a], ay = ny[a], bx = nx[b], by = ny[b], cx = nx[c], cy = ny[c]
  let area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
  if (area > -0.0001 && area < 0.0001) return 0
  let ia = 1.0 / area
  let x0 = Math.floor(Math.min(ax, Math.min(bx, cx))), x1 = Math.ceil(Math.max(ax, Math.max(bx, cx)))
  let y0 = Math.floor(Math.min(ay, Math.min(by, cy))), y1 = Math.ceil(Math.max(ay, Math.max(by, cy)))
  if (x0 < 0) x0 = 0
  if (y0 < 0) y0 = 0
  if (x1 > W - 1) x1 = W - 1
  if (y1 > H - 1) y1 = H - 1
  let za = nz[a], zb0 = nz[b], zc = nz[c], sa = sh[a], sb = sh[b], sc = sh[c]
  let y = y0
  while (y <= y1) {
    let fy = y + 0.5
    let x = x0
    while (x <= x1) {
      let fx = x + 0.5
      let w1 = ((cx - ax) * (fy - ay) - (cy - ay) * (fx - ax)) * -ia
      let w2 = ((bx - ax) * (fy - ay) - (by - ay) * (fx - ax)) * ia
      let w0 = 1.0 - w1 - w2
      if (w0 >= 0.0 && w1 >= 0.0 && w2 >= 0.0) {
        let z = za * w0 + zb0 * w1 + zc * w2
        let p = y * W + x
        if (z > zb[p]) {
          zb[p] = z
          let v = sa * w0 + sb * w1 + sc * w2
          let g = v < 1.0 ? (v * 238.0) | 0 : 238
          px[p] = (255 << 24) | (g << 16) | (g << 8) | g
        }
      }
      x++
    }
    y++
  }
  return 0
}

export let frame = (t) => {
  // Verlet integrate — gravity + a smooth wind: a slow envelope (waxes/wanes over ~1min) gates
  // gusts that push the sheet in depth, their phase drifting across and down it, so a gust rolls
  // through the folds rather than shoving the whole curtain at once.
  let gust = 0.5 + 0.5 * Math.sin(t * 0.09)
  let i = 0
  while (i < N) {
    if (pin[i] === 0 && i !== grabbed) {
      // 0.96 velocity retention — motion dies like heavy fabric
      let vx = (nx[i] - ox[i]) * 0.96, vy = (ny[i] - oy[i]) * 0.96, vz = (nz[i] - oz[i]) * 0.96
      let ph = t * 0.7 + nx[i] * 0.012 + ny[i] * 0.02
      let wz = Math.sin(ph) * 0.1 * gust + 0.03 * gust
      let wx = Math.sin(ph * 0.61 + 1.3) * 0.05 * gust
      ox[i] = nx[i]; oy[i] = ny[i]; oz[i] = nz[i]
      nx[i] += vx + wx; ny[i] += vy + 0.42; nz[i] += vz + wz   // wind + gravity
    }
    i++
  }
  // satisfy structural constraints (right + down, soft), a softer diagonal shear brace, and a soft
  // skip-one bend link. Low stiffness is the softening knob: each pass only partially corrects,
  // never overshoots, so the solve stays unconditionally stable.
  let k = 0
  while (k < ITER) {
    let j = 0
    while (j < GY) {
      let ii = 0
      while (ii < GX) {
        let a = j * GX + ii
        if (ii < GX - 1) relax(a, a + 1, L, 0.42)
        if (j < GY - 1) relax(a, a + GX, L, 0.42)
        if (ii < GX - 1 && j < GY - 1) {
          relax(a, a + GX + 1, LD, 0.08)          // "\" diagonal
          relax(a + 1, a + GX, LD, 0.08)          // "/" diagonal
        }
        if (ii < GX - 2) relax(a, a + 2, LB, 0.05)
        if (j < GY - 2) relax(a, a + GX + GX, LB, 0.05)
        ii++
      }
      j++
    }
    k++
  }

  // render: black ground, then the satin sheet through the z-buffer
  let n = W * H, p = 0
  while (p < n) { px[p] = (255 << 24); zb[p] = -1e30; p++ }
  shade()
  let j2 = 0
  while (j2 < GY - 1) {
    let ii = 0
    while (ii < GX - 1) {
      let a = j2 * GX + ii
      tri(a, a + 1, a + GX)
      tri(a + 1, a + GX + 1, a + GX)
      ii++
    }
    j2++
  }
}
