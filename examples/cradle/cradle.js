// Newton's cradle — a row of pendulum balls that pass kinetic energy through the line by
// elastic collisions. Each ball is a pendulum (angle θ, angular velocity ω) integrated as
// a small oscillator; when two adjacent balls overlap and are closing, equal masses just
// exchange velocities, so a ball swinging in stops dead and launches the ball at the far
// end. Click to lift and release the end balls.
//
// Render: polished chrome in a black studio. Every ball pixel reflects the view ray off the sphere
// into a studio environment (an overhead softbox, two vertical strip lights, a dark room), plus the
// key light's specular glint; a reflected ray that strikes a neighbouring ball takes one more bounce
// off it, so each ball carries its neighbours in its flanks. Silhouettes are anti-aliased by pixel
// coverage, the frame is chrome cylinders shaded the same way, and a glossy black base mirrors the
// whole cradle. resize(w,h) → Uint32Array; frame() runs.

let W = 0, H = 0, px
let N = 6
let th = new Float64Array(N)      // angle (rad)
let om = new Float64Array(N)      // angular velocity
let pvx = new Float64Array(N)     // pivot x (px)
let bxs = new Float64Array(N)     // ball centres this frame (px)
let bys = new Float64Array(N)
let pvy = 0, L = 0, R = 0, sp = 0, base = 0, fl = 0, fr = 0, rod = 0
let W0 = 0.05                      // pendulum angular frequency

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  R = W * 0.35 / N                 // touching at rest: spacing 2R
  if (R > H * 0.08) R = H * 0.08
  sp = 2.0 * R                     // ball spacing
  pvy = H * 0.14
  L = H * 0.6
  base = pvy + L + R * 1.35        // top face of the glossy base
  rod = R * 0.12 > 2.0 ? R * 0.12 : 2.0   // chrome frame tube half-width
  let ox = (W - (N - 1) * sp) * 0.5
  let reach = L * 0.68 + R * 1.4                     // clear of a ball lifted ~0.75 rad
  fl = ox - reach; fr = ox + (N - 1) * sp + reach    // uprights
  if (fl < W * 0.04) { fl = W * 0.04; fr = W * 0.96 }
  let i = 0
  while (i < N) { pvx[i] = ox + i * sp; th[i] = 0.0; om[i] = 0.0; i++ }
  th[0] = -0.7                     // lift the left ball to start
  W0 = Math.sqrt(9.8 / (L / H)) * 0.0016
  return px
}

export let init = () => {
  let i = 0
  while (i < N) { th[i] = 0.0; om[i] = 0.0; i++ }
  th[0] = -0.7
}

// re-roll: lift every ball to a random angle → a chaotic clatter instead of the tidy single swing
export let randomize = () => {
  let i = 0
  while (i < N) { th[i] = (Math.random() - 0.5) * 1.2; om[i] = 0.0; i++ }
}

let grabbed = -1

// grab the ball nearest the cursor; drag sets its angle; release lets it swing
export let grab = (sx, sy) => {
  let best = 1e18, bi = -1, i = 0
  while (i < N) {
    let bx = pvx[i] + Math.sin(th[i]) * L, by = pvy + Math.cos(th[i]) * L
    let dx = bx - sx, dy = by - sy, d = dx * dx + dy * dy
    if (d < best) { best = d; bi = i }
    i++
  }
  if (best < (2.0 * R) * (2.0 * R)) grabbed = bi
}
export let dragTo = (sx) => {
  if (grabbed < 0) return 0.0
  let s = (sx - pvx[grabbed]) / L
  if (s > 0.95) s = 0.95
  if (s < -0.95) s = -0.95
  th[grabbed] = Math.asin(s); om[grabbed] = 0.0
  return 0.0
}
export let release = () => { grabbed = -1 }

let ballX = (i) => pvx[i] + Math.sin(th[i]) * L

let clamp01 = (v) => v < 0.0 ? 0.0 : v > 1.0 ? 1.0 : v
let smooth = (a, b, v) => { let u = clamp01((v - a) / (b - a)); return u * u * (3.0 - 2.0 * u) }

// The studio, seen along unit direction (dx, up, dz) (dz > 0 = back toward the camera): a dark room,
// an overhead softbox, two tall strip lights left and right, a faint horizon; plus the key light.
let env = (dx, up, dz) => {
  let room = up > 0.0 ? 0.07 + up * 0.05 : 0.04 - up * 0.02
  room += 0.12 * (1.0 - smooth(0.0, 0.18, up < 0.0 ? -up : up))              // horizon glow
  let box = smooth(0.25, 0.4, up) * (1.0 - smooth(0.45, 0.62, dx < 0.0 ? -dx : dx)) * smooth(-0.35, -0.1, dz)
  let strip = smooth(0.62, 0.74, dx < 0.0 ? -dx : dx) * (1.0 - smooth(0.35, 0.55, up < 0.0 ? -up : up))
  let kx = -0.42, ku = 0.62, kz = 0.66                                         // key light, upper left front
  let c = dx * kx + up * ku + dz * kz
  let spec = 0.0
  if (c > 0.9) { let c2 = c * c, c8 = c2 * c2 * c2 * c2, c16 = c8 * c8, c64 = c16 * c16 * c16 * c16; spec = c64 * c16 * c8 * c2 * 1.6 }   // c⁹⁰
  return room + box * 0.95 + strip * 0.8 + spec
}

// Chrome at a sphere point with normal (nx, ny, nz) (ny down, nz toward the camera) of ball i:
// reflect the view ray; if it strikes a neighbouring ball, bounce once more off that ball.
let chrome = (i, nx, ny, nz, cx, cy) => {
  let dx = 2.0 * nz * nx, dy = 2.0 * nz * ny, dz = 2.0 * nz * nz - 1.0
  let k = 0.9 + 0.1 * (1.0 - nz)                                               // chrome: near-mirror at every angle
  let j = dx < 0.0 ? i - 1 : i + 1
  if (j >= 0 && j < N) {
    // ray from p = (cx + R nx, cy + R ny, R nz) along d; hit sphere j (z = 0) where the ray meets it
    let ox = cx + R * nx - bxs[j], oy = cy + R * ny - bys[j], oz = R * nz
    let b = ox * dx + oy * dy + oz * dz
    let c = ox * ox + oy * oy + oz * oz - R * R
    let disc = b * b - c
    if (disc > 0.0) {
      let tt = -b - Math.sqrt(disc)
      if (tt > 0.0) {
        let hx = (ox + dx * tt) / R, hy = (oy + dy * tt) / R, hz = (oz + dz * tt) / R
        let dn = dx * hx + dy * hy + dz * hz
        let ex = dx - 2.0 * dn * hx, ey = dy - 2.0 * dn * hy, ez = dz - 2.0 * dn * hz
        return env(ex, -ey, ez) * k * 0.85
      }
    }
  }
  return env(dx, -dy, dz) * k
}

// grey level 0‥1 (soft-clipped) → opaque pixel
let grey = (v) => {
  let g = v < 1.0 ? v : 1.0 - 0.25 / (v + 0.25) + 0.2
  if (g > 1.0) g = 1.0
  let c = (g * 255.0) | 0
  return (255 << 24) | (c << 16) | (c << 8) | c
}
let blend = (p, v, a) => {
  let o = px[p] & 255
  let g = v < 1.0 ? v : 1.0 - 0.25 / (v + 0.25) + 0.2
  if (g > 1.0) g = 1.0
  let c = (o + (g * 255.0 - o) * a) | 0
  px[p] = (255 << 24) | (c << 16) | (c << 8) | c
}

// one chrome ball, anti-aliased by coverage at the silhouette
let ball = (i) => {
  let cx = bxs[i], cy = bys[i]
  let x0 = (cx - R - 1.0) | 0, x1 = (cx + R + 2.0) | 0, y0 = (cy - R - 1.0) | 0, y1 = (cy + R + 2.0) | 0
  if (x0 < 0) x0 = 0
  if (y0 < 0) y0 = 0
  if (x1 > W) x1 = W
  if (y1 > H) y1 = H
  let y = y0
  while (y < y1) {
    let x = x0
    while (x < x1) {
      let ux = (x + 0.5 - cx) / R, uy = (y + 0.5 - cy) / R
      let d2 = ux * ux + uy * uy
      let a = clamp01((1.0 - Math.sqrt(d2)) * R + 0.5)
      if (a > 0.0) {
        let q = d2 < 1.0 ? d2 : 1.0
        blend(y * W + x, chrome(i, ux, uy, Math.sqrt(1.0 - q), cx, cy), a)
      }
      x++
    }
    y++
  }
}

// chrome tube along x (horiz) or y, centred on the line, half-width rod: shaded as a cylinder
let tube = (x0, y0, x1, y1, horiz) => {
  let ya = horiz ? (y0 - rod - 1.0) | 0 : y0 | 0, yb = horiz ? (y0 + rod + 2.0) | 0 : y1 | 0
  let xa = horiz ? x0 | 0 : (x0 - rod - 1.0) | 0, xb = horiz ? x1 | 0 : (x0 + rod + 2.0) | 0
  if (xa < 0) xa = 0
  if (ya < 0) ya = 0
  if (xb > W) xb = W
  if (yb > H) yb = H
  let y = ya
  while (y < yb) {
    let x = xa
    while (x < xb) {
      let u = horiz ? (y + 0.5 - y0) / rod : (x + 0.5 - x0) / rod
      let au = u < 0.0 ? -u : u
      let a = clamp01((1.0 - au) * rod + 0.5)
      if (a > 0.0) {
        let q = au < 1.0 ? u : u < 0.0 ? -1.0 : 1.0
        let nz = Math.sqrt(1.0 - q * q)
        let v = horiz ? env(0.0, -2.0 * nz * q, 2.0 * nz * nz - 1.0) : env(2.0 * nz * q, 0.0, 2.0 * nz * nz - 1.0)
        blend(y * W + x, v * 0.9, a)
      }
      x++
    }
    y++
  }
}

// anti-aliased hairline: a coverage splat every half pixel along the segment
let hair = (x0, y0, x1, y1, v) => {
  let dx = x1 - x0, dy = y1 - y0
  let n = (Math.sqrt(dx * dx + dy * dy) * 2.0 | 0) + 1, k = 0
  while (k < n) {
    let fx = x0 + dx * k / n - 0.5, fy = y0 + dy * k / n - 0.5
    let ix = Math.floor(fx), iy = Math.floor(fy), ux = fx - ix, uy = fy - iy
    if (ix >= 0 && ix < W - 1 && iy >= 0 && iy < H - 1) {
      let p = iy * W + ix
      blend(p, v, (1.0 - ux) * (1.0 - uy) * 0.7)
      blend(p + 1, v, ux * (1.0 - uy) * 0.7)
      blend(p + W, v, (1.0 - ux) * uy * 0.7)
      blend(p + W + 1, v, ux * uy * 0.7)
    }
    k++
  }
}

export let frame = (t) => {
  // integrate each pendulum (a few substeps for stable collisions)
  let s = 0
  while (s < 4) {
    let i = 0
    while (i < N) { if (i !== grabbed) { om[i] += -W0 * W0 * Math.sin(th[i]); th[i] += om[i] } i++ }
    // Elastic collision: adjacent overlapping + closing → equal masses exchange angular velocity
    // (this is what carries the kinetic energy through the row). Position is fixed up separately.
    i = 0
    while (i < N - 1) {
      if (ballX(i + 1) - ballX(i) < 2.0 * R) {
        let va = om[i], vb = om[i + 1]
        if (va > vb) { om[i] = vb; om[i + 1] = va }       // closing → swap
      }
      i++
    }
    // Positional non-overlap — the balls are a rigid chain, never interpenetrate. Crucially this
    // also makes DRAGGING a middle ball PUSH its neighbours instead of passing through them: a
    // grabbed ball is pinned (yields nothing), so the overlap is taken entirely by the other ball,
    // and N sweeps propagate that shove all the way down the row it pushes into.
    let pass = 0
    while (pass < N) {
      i = 0
      while (i < N - 1) {
        let gap = ballX(i + 1) - ballX(i)
        if (gap < 2.0 * R) {
          let corr = (2.0 * R - gap) / L
          if (i === grabbed) { th[i + 1] += corr }         // pinned left → push right neighbour
          else if (i + 1 === grabbed) { th[i] -= corr }    // pinned right → push left neighbour
          else { th[i] -= corr * 0.5; th[i + 1] += corr * 0.5 }
        }
        i++
      }
      pass++
    }
    s++
  }

  // render: black studio, chrome frame + balls, then the glossy base mirrors everything above it
  let n = W * H, k = 0
  while (k < n) { px[k] = (255 << 24); k++ }
  let i = 0
  while (i < N) { bxs[i] = ballX(i); bys[i] = pvy + Math.cos(th[i]) * L; i++ }
  tube(fl, pvy - rod * 2.0, fl, base, false)                                 // uprights
  tube(fr, pvy - rod * 2.0, fr, base, false)
  tube(fl - rod, pvy, fr + rod, pvy, true)                                   // top bar
  i = 0
  while (i < N) {
    let sx0 = pvx[i], sx1 = bxs[i], sy1 = bys[i]
    let dl = Math.sqrt((sx1 - sx0) * (sx1 - sx0) + (sy1 - pvy) * (sy1 - pvy))
    let f = (dl - R) / dl                                                    // string ends at the ball top
    hair(sx0, pvy, sx0 + (sx1 - sx0) * f, pvy + (sy1 - pvy) * f, 0.55)
    i++
  }
  i = 0
  while (i < N) { ball(i); i++ }

  // the base: a thin bright lip, then a black mirror — each row below reflects the row the same
  // distance above, dimming with depth
  let yb = base | 0
  if (yb >= 0 && yb < H) {
    let x = (fl - rod * 3.0) | 0, xe = (fr + rod * 3.0) | 0
    if (x < 0) x = 0
    if (xe > W) xe = W
    while (x < xe) { px[yb * W + x] = grey(0.62); x++ }
  }
  let y = yb + 1
  while (y < H) {
    let sy = 2 * yb - y
    let f = 0.3 * (1.0 - (y - yb) / (H - yb + 1.0))
    if (sy >= 0) {
      let x = 0
      while (x < W) {
        let c = ((px[sy * W + x] & 255) * f) | 0
        px[y * W + x] = (255 << 24) | (c << 16) | (c << 8) | c
        x++
      }
    }
    y++
  }
}
