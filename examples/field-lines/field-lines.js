// Field lines: the electric field of twelve charges, with no line traced. Every pixel decides
// for itself whether it lies on one.
//
// The charges are line charges seen end-on, the electrostatics of the plane: E = Σ nₖ·dₖ/|dₖ|²,
// dₖ = z − zₖ. Away from the charges that field has no divergence, so it has a stream function
//   ψ(z) = Σ nₖ·arg(z − zₖ)
// constant along every field line: the lines are the level curves of ψ. Charge k is given an
// integer count nₖ of lines (negative: they end on it), which makes e^{iψ} single-valued, and the
// picture is the level set ψ ≡ 0 (mod 2π): exactly |nₖ| lines leave each charge, evenly spread
// around it, and because the plane conserves flux their density anywhere is the field's strength.
//
// No arctangent per charge: e^{iψ} = Π uₖ^nₖ with uₖ the unit vector from charge k (its conjugate
// for a negative one), a product of complex numbers. The powers share their squarings: with the
// counts written in binary, plane b holds the charges whose count has bit b set, and
//   e^{iψ} = (…((P₅)²·P₄)²·…·P₁)²·P₀,   P_b = the product of plane b's unit vectors,
// one complex multiply per set bit of a count and one normalisation per plane. The field takes the
// same walk, doubling where the phase squares: E = (…(G₅·2 + G₄)·2 + …)·2 + G₀, G_b = Σ ±d/|d|²
// over plane b. A count that is a power of two costs one multiply and one divide per pixel.
//
// |∇ψ| = |E| (ψ is the potential's harmonic conjugate), so a pixel's distance to the nearest
// line is the phase's distance to zero over |E|: each line is anti-aliased at one width, which
// grows with the frame, and where lines crowd closer than that resolves they melt into their
// share of the area.
//
// The picture is still until a charge changes, so it is drawn once: frame() returns at once while
// the cast is as last drawn. A change is answered within the frame by a draft, one sample for each
// block of pixels, as many samples as a frame affords. Once the cast has held still the rows are
// redrawn pixel by pixel, a frame's worth per call. The draft is the same picture through larger
// pixels: a line narrower than its block inks its share of it, lines closer than blocks melt.
//
// charges() is the state, shared with the host: x, y (fractions of the frame) and the signed line
// count of each charge. The host drags a charge by writing its x, y and flips it by negating its
// count. init() rolls a new cast. resize(w,h) → Uint32Array; frame() renders.

let W = 0, H = 0, px
let inited = 0

const N = 12                        // charges
const BITS = 6                      // line counts up to 63
let cs = new Float64Array(N * 3)    // x, y, n per charge; n = 0 is no charge

// the planes (plan()): plane b lists, in pixels, the charges whose count has bit b set, each with its sign
let bx = new Float64Array(BITS * N), by = new Float64Array(BITS * N), bs = new Float64Array(BITS * N)
let pn = new Int32Array(BITS)       // members per plane
let top = -1                        // the highest plane in use

const THIN = 0.65                   // the least half-width of a line, px
let hw = THIN                       // a line's half-width, px: 1/1500 of the frame's mean side
const PI = 3.141592653589793

const WORK = 360000                 // pixels a frame places: the draft's samples, the sharp pass's rows
const WAIT = 6                      // frames a cast holds still before it is drawn sharp
let seen = new Float64Array(N * 3)  // the cast as last drawn
let stale = 1                       // the frame holds no picture of it
let step = 1                        // the draft's block, px
let still = 0                       // frames the cast has held still
let row = 0                         // rows drawn sharp; H is the finished picture

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  hw = Math.sqrt(w * h) / 1500.0
  if (hw < THIN) hw = THIN
  step = Math.ceil(Math.sqrt(w * h / WORK)) | 0
  if (step < 1) step = 1
  stale = 1
  if (!inited) init()
  return px
}

export let charges = () => cs

// A new cast: twelve charges kept apart, of two kinds, each kind with its sign and its line count
// (the first 16 or 32, the second 4, 8, 16 or 32). So a roll is one of: opposite charges, equal or
// unequal; one sign throughout; strong charges among weak ones.
export let init = () => {
  inited = 1
  let a = H > 0 ? W / H : 1.6       // the frame's aspect: distances are measured in frame heights
  let i = 0, tries = 0
  while (i < N) {
    let x = 0.06 + Math.random() * 0.88, y = 0.09 + Math.random() * 0.82
    let near = 0, k = 0
    while (k < i) {
      let dx = (x - cs[k * 3]) * a, dy = y - cs[k * 3 + 1]
      if (dx * dx + dy * dy < 0.035) near = 1
      k++
    }
    if (near && tries < 200) tries++
    else { cs[i * 3] = x; cs[i * 3 + 1] = y; i++; tries = 0 }
  }
  let sa = Math.random() < 0.5 ? 1 : -1
  let sb = Math.random() < 0.6 ? -sa : sa
  let na = sa * (16 << ((Math.random() * 2) | 0))
  let nb = sb * (4 << ((Math.random() * 4) | 0))
  let ka = 4 + ((Math.random() * 5) | 0)
  i = 0
  while (i < N) { cs[i * 3 + 2] = i < ka ? na : nb; i++ }
}

// Each charge → the planes of its count's binary digits.
let plan = () => {
  let b = 0
  while (b < BITS) { pn[b] = 0; b++ }
  top = -1
  let i = 0
  while (i < N) {
    let n = cs[i * 3 + 2] | 0
    let m = n < 0 ? -n : n, s = n < 0 ? -1.0 : 1.0
    if (m > 63) m = 63
    b = 0
    while (b < BITS) {
      if ((m >> b) & 1) {
        let at = b * N + pn[b]
        bx[at] = cs[i * 3] * W - 0.5; by[at] = cs[i * 3 + 1] * H - 0.5   // pixel (qx, py) is centred on (qx + ½, py + ½)
        bs[at] = s
        pn[b] = pn[b] + 1
        if (b > top) top = b
      }
      b++
    }
    i++
  }
}

// A charge's mark, over the lines, on rows ya..yb − 1: a black disc in a ring, + or − inside; red is
// positive, blue negative.
let mark = (x, y, n, r, ya, yb) => {
  let cr = n > 0 ? 255.0 : 72.0, cg = n > 0 ? 80.0 : 140.0, cb = n > 0 ? 64.0 : 255.0
  let rw = r * 0.28, arm = r * 0.42                 // ring width; the sign's half-length
  let sw = rw / 3.0                                 // the sign's half-width: a line's at least
  if (sw < hw) sw = hw
  let x0 = Math.floor(x - r - 1.0) | 0, x1 = Math.ceil(x + r + 1.0) | 0
  let y0 = Math.floor(y - r - 1.0) | 0, y1 = Math.ceil(y + r + 1.0) | 0
  if (x0 < 0) x0 = 0
  if (y0 < ya) y0 = ya
  if (x1 > W - 1) x1 = W - 1
  if (y1 > yb - 1) y1 = yb - 1
  let py = y0
  while (py <= y1) {
    let qx = x0
    while (qx <= x1) {
      let dx = qx - x, dy = py - y
      let d = Math.sqrt(dx * dx + dy * dy)
      let a = r + 0.5 - d                           // the disc
      if (a > 0.0) {
        if (a > 1.0) a = 1.0
        let ink = rw * 0.5 + 0.5 - Math.abs(d - r + rw * 0.5)         // the ring, inside the disc's rim
        let ax = Math.abs(dx), ay = Math.abs(dy)
        let bar = (sw + 0.5 - ay) * (arm + 0.5 - ax)                 // −
        if (ay > sw + 0.5 || ax > arm + 0.5) bar = 0.0
        if (n > 0) {                                                 // + adds the upright
          let up = (sw + 0.5 - ax) * (arm + 0.5 - ay)
          if (ax > sw + 0.5 || ay > arm + 0.5) up = 0.0
          if (up > bar) bar = up
        }
        if (bar > ink) ink = bar
        ink = ink < 0.0 ? 0.0 : ink > 1.0 ? 1.0 : ink
        let j = py * W + qx, p = px[j], k = 1.0 - a
        let r8 = ((p & 255) * k + cr * ink * a) | 0
        let g8 = (((p >> 8) & 255) * k + cg * ink * a) | 0
        let b8 = (((p >> 16) & 255) * k + cb * ink * a) | 0
        px[j] = (255 << 24) | (b8 << 16) | (g8 << 8) | r8
      }
      qx++
    }
    py++
  }
}

// Every charge's mark, on rows ya..yb − 1.
let marks = (ya, yb) => {
  let r = Math.sqrt(W * H) / 85.0                   // the marks keep their size against the frame
  if (r < 5.0) r = 5.0
  let i = 0
  while (i < N) {
    let n = cs[i * 3 + 2]
    if (n != 0.0) mark(cs[i * 3] * W - 0.5, cs[i * 3 + 1] * H - 0.5, n, r, ya, yb)
    i++
  }
}

// The lines on rows y0..y1 − 1, one sample for each s×s block: the block is the pixel a line is
// weighed against, s = 1 the pixel itself.
let draw = (y0, y1, s) => {
  let w = W, hi = top
  let half = (s - 1) * 0.5                          // a block's centre from its corner
  let is = 1.0 / s, cap = 2.0 * hw * is             // the most of a block a line narrower than it inks
  if (cap > 1.0) cap = 1.0
  let unit = hw / THIN                              // what tells two lines apart: their own width, or the block
  if (unit < s) unit = s
  let py = y0
  while (py < y1) {
    let y = py + half, j = py * w, qx = 0
    while (qx < w) {
      let x = qx + half
      // e^{iψ} = (rx, ry) and E = (ex, ey), plane by plane from the top bit down
      let rx = 1.0, ry = 0.0, ex = 0.0, ey = 0.0, b = hi
      while (b >= 0) {
        let sq = rx * rx - ry * ry
        ry = 2.0 * rx * ry; rx = sq
        ex = 2.0 * ex; ey = 2.0 * ey
        let m = b * N, end = m + pn[b]
        if (m < end) {
          let ax = 1.0, ay = 0.0
          while (m < end) {
            let dx = x - bx[m], dy = y - by[m], sg = bs[m]
            let inv = sg / (dx * dx + dy * dy + 1e-9)
            ex += dx * inv; ey += dy * inv
            dy *= sg
            let tx = ax * dx - ay * dy
            ay = ax * dy + ay * dx; ax = tx
            m++
          }
          let u = 1.0 / Math.sqrt(ax * ax + ay * ay + 1e-300)
          ax *= u; ay *= u
          let tx = rx * ax - ry * ay
          ry = rx * ay + ry * ax; rx = tx
        }
        b--
      }
      let e = Math.sqrt(ex * ex + ey * ey) + 1e-12
      // distance to the line ψ = 0, px: 2·tan(ψ/2)/|E|, which is |ψ|/|E| for a small phase and takes no arctangent
      let d = 2.0 * Math.abs(ry) / ((1.0 + rx + 1e-12) * e)
      let c = (hw + 0.5 * s - d) * is
      c = c < 0.0 ? 0.0 : c > cap ? cap : c
      // lines are 2π/|E| apart: resolved from 4 units, merged by 2 into the share of the block they ink
      let mean = hw * e / PI
      if (mean > 1.0) mean = 1.0
      let f = PI / (e * unit) - 1.0
      f = f < 0.0 ? 0.0 : f > 1.0 ? 1.0 : f
      let gi = ((mean + (c - mean) * f) * 255.0) | 0
      let v = (255 << 24) | (gi << 16) | (gi << 8) | gi
      let xe = qx + s
      if (xe > w) xe = w
      while (qx < xe) { px[j] = v; j++; qx++ }
    }
    let ye = py + s
    if (ye > y1) ye = y1
    let k = py + 1
    while (k < ye) {                                // the block's other rows repeat its first
      let a = py * w, o = k * w, end = a + w
      while (a < end) { px[o] = px[a]; a++; o++ }
      k++
    }
    py = ye
  }
}

export let frame = () => {
  let moved = stale, i = 0
  while (i < N * 3) {
    if (cs[i] != seen[i]) { seen[i] = cs[i]; moved = 1 }
    i++
  }
  if (moved) {                                      // the draft, whole
    stale = 0; still = 0
    plan()
    draw(0, H, step); marks(0, H)
    row = step > 1 ? 0 : H
  } else if (row < H) {
    still++
    if (still > WAIT) {                             // the next rows, sharp
      let end = row + (Math.ceil(WORK / W) | 0)
      if (end > H) end = H
      draw(row, end, 1); marks(row, end)
      row = end
    }
  }
}
