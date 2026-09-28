// L-system fractals — an axiom string rewritten by production rules again and again (string
// substitution), then read as turtle-graphics commands: F (or A/B where marked) draws a step, + and −
// turn, [ and ] push and pop the turtle. Tiny rule tables give self-similar curves and plants.
// Eight classics, one table: Koch snowflake, Heighway dragon, Sierpiński arrowhead, fractal plant,
// Hilbert curve, Gosper flowsnake, Lévy C curve, and a bush.
//
// Render: every step is an anti-aliased segment, coverage from its exact distance to each pixel, and
// overlaps keep the brighter ink (max, not sum). A curve brightens along its length, so the order in
// which it folds is legible; a plant's strokes taper with branch depth, trunk to twig; a glowing pen
// marks the tip while it grows. Once grown, current runs through it: pulses travel the string in its
// drawing order — along a curve end to end, up each branch of a plant — lighting a fading tail, and
// spark(fx, fy) fires one from the stroke nearest a touch.
//
// Symbol encoding: 0=F 1=+ 2=− 3=[ 4=] 5=X 6=Y 7=A 8=B
// resize(w,h) → Uint32Array; frame(t, systemIdx, progress) renders.

let W = 0, H = 0, px

let NSYS = 8, NSYM = 9
// per system: axiom, rules (symbol → replacement), turn angle (deg), depth, start heading (deg,
// screen y down), draws A/B too, is a plant (strokes taper with branch depth)
let AX = ['F++F++F', 'FX', 'A', 'X', 'A', 'A', 'F', 'F']
let ANG = new Float64Array([60, 90, 60, 25, 90, 60, 45, 22.5])
let DEP = new Int32Array([5, 12, 8, 6, 6, 4, 12, 4])
let HEAD = new Float64Array([0, 0, 0, -90, 0, 0, 0, -90])
let DRAWAB = new Int32Array([0, 0, 1, 0, 0, 1, 0, 0])
let PLANT = new Int32Array([0, 0, 0, 1, 0, 0, 0, 1])
// rules as [system, symbol, replacement] — symbols absent here rewrite to themselves
let RULES = [
  0, 'F', 'F-F++F-F',
  1, 'X', 'X+YF+', 1, 'Y', '-FX-Y',
  2, 'A', 'B-A-B', 2, 'B', 'A+B+A',
  3, 'X', 'F+[[X]-X]-F[-FX]+X', 3, 'F', 'FF',
  4, 'A', '+BF-AFA-FB+', 4, 'B', '-AF+BFB+FA-',
  5, 'A', 'A-B--B+A++AA+B-', 5, 'B', '+A-BB--B-A++A+B',
  6, 'F', '+F--F+',
  7, 'F', 'FF+[+F-F-F]-[-F+F+F]',
]

let code = (c) => c === 'F' ? 0 : c === '+' ? 1 : c === '-' ? 2 : c === '[' ? 3 : c === ']' ? 4 : c === 'X' ? 5 : c === 'Y' ? 6 : c === 'A' ? 7 : 8

// the rule table, flattened: rule (si, sym) is rdat[roff[k] .. roff[k] + rlen[k]), k = si·NSYM + sym
let roff = new Int32Array(NSYS * NSYM), rlen = new Int32Array(NSYS * NSYM), rdat = new Uint8Array(256)
let tableBuilt = 0
let buildTable = () => {
  let n = 0, i = 0
  while (i < RULES.length) {
    let k = RULES[i] * NSYM + code(RULES[i + 1])
    let s = RULES[i + 2]
    roff[k] = n; rlen[k] = s.length
    let j = 0
    while (j < s.length) { rdat[n] = code(s[j]); n++; j++ }
    i += 3
  }
  tableBuilt = 1
}

// Two string buffers for ping-pong expansion
let CAP = 1800000
let lstr = new Uint8Array(CAP)
let lbuf = new Uint8Array(CAP)
let slen = 0
let curSys = -1

let tstack = new Float64Array(4 * 256)  // turtle push/pop stack: x, y, heading, depth
let bounds = new Float64Array(4)        // turtle-space extent: minX, maxX, minY, maxY
let segs = 0                            // drawing steps in the expanded string
let NA = 6                              // ambient pulses, evenly spaced along the drawing order
let MAXS = 24
let spk = new Float64Array(MAXS), ns = 0   // touch pulses: their position along the drawing order
let tgt = new Float64Array(3)           // a pending touch (x, y px, armed)

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  return px
}

let draws = (si, sym) => sym === 0 || (DRAWAB[si] === 1 && (sym === 7 || sym === 8))

// Expand system si, then walk it once (unit steps) for its extent and step count.
let expand = (si) => {
  if (tableBuilt === 0) buildTable()
  let ax = AX[si]
  slen = ax.length
  let i = 0
  while (i < slen) { lstr[i] = code(ax[i]); i++ }
  let d = 0
  while (d < DEP[si]) {
    let n = 0
    i = 0
    while (i < slen && n < CAP - 32) {
      let sym = lstr[i], k = si * NSYM + sym, l = rlen[k]
      if (l === 0) { lbuf[n] = sym; n++ }
      else { let o = roff[k], j = 0; while (j < l) { lbuf[n] = rdat[o + j]; n++; j++ } }
      i++
    }
    slen = n
    i = 0
    while (i < slen) { lstr[i] = lbuf[i]; i++ }
    d++
  }
  let ang = ANG[si] * Math.PI / 180.0
  let x = 0.0, y = 0.0, h = HEAD[si] * Math.PI / 180.0, sp = 0
  bounds[0] = 0.0; bounds[1] = 0.0; bounds[2] = 0.0; bounds[3] = 0.0
  segs = 0
  i = 0
  while (i < slen) {
    let sym = lstr[i]
    if (draws(si, sym)) {
      x += Math.cos(h); y += Math.sin(h); segs++
      if (x < bounds[0]) bounds[0] = x
      if (x > bounds[1]) bounds[1] = x
      if (y < bounds[2]) bounds[2] = y
      if (y > bounds[3]) bounds[3] = y
    } else if (sym === 1) h -= ang
    else if (sym === 2) h += ang
    else if (sym === 3) { if (sp < 256) { tstack[sp * 4] = x; tstack[sp * 4 + 1] = y; tstack[sp * 4 + 2] = h; sp++ } }
    else if (sym === 4) { if (sp > 0) { sp--; x = tstack[sp * 4]; y = tstack[sp * 4 + 1]; h = tstack[sp * 4 + 2] } }
    i++
  }
  curSys = si
}

// ink v at coverage a, keeping the brighter of what is there
let ink = (p, v) => {
  let g = (v * 255.0) | 0
  if (g > (px[p] & 255)) px[p] = (255 << 24) | (g << 16) | (g << 8) | g
}

// anti-aliased segment of width w: coverage from each pixel's exact distance to the segment
let seg = (x0, y0, x1, y1, w, v) => {
  let hw = w * 0.5
  let xa = Math.floor((x0 < x1 ? x0 : x1) - hw - 1.0), xb = Math.ceil((x0 > x1 ? x0 : x1) + hw + 1.0)
  let ya = Math.floor((y0 < y1 ? y0 : y1) - hw - 1.0), yb = Math.ceil((y0 > y1 ? y0 : y1) + hw + 1.0)
  if (xa < 0) xa = 0
  if (ya < 0) ya = 0
  if (xb > W - 1) xb = W - 1
  if (yb > H - 1) yb = H - 1
  let dx = x1 - x0, dy = y1 - y0
  let l2 = dx * dx + dy * dy + 1e-12
  let y = ya
  while (y <= yb) {
    let x = xa
    while (x <= xb) {
      let qx = x + 0.5 - x0, qy = y + 0.5 - y0
      let u = (qx * dx + qy * dy) / l2
      u = u < 0.0 ? 0.0 : u > 1.0 ? 1.0 : u
      let ex = qx - dx * u, ey = qy - dy * u
      let a = hw + 0.5 - Math.sqrt(ex * ex + ey * ey)
      if (a > 0.0) ink(y * W + x, v * (a > 1.0 ? 1.0 : a))
      x++
    }
    y++
  }
}

// the pen: a soft glow at the growing tip
let pen = (cx, cy, r) => {
  let ri = (r | 0) + 1, oy = -ri
  while (oy <= ri) {
    let ox = -ri
    while (ox <= ri) {
      let ix = (cx | 0) + ox, iy = (cy | 0) + oy
      if (ix >= 0 && ix < W && iy >= 0 && iy < H) {
        let d = Math.sqrt((ix + 0.5 - cx) * (ix + 0.5 - cx) + (iy + 0.5 - cy) * (iy + 0.5 - cy)) / r
        if (d < 1.0) ink(iy * W + ix, (1.0 - d) * (1.0 - d))
      }
      ox++
    }
    oy++
  }
}

// a touch: the next frame fires a pulse from the stroke nearest (fx, fy) ∈ 0..1
export let spark = (fx, fy) => { tgt[0] = fx * W; tgt[1] = fy * H; tgt[2] = 1.0 }

export let frame = (t, systemIdx, progress) => {
  let si = (systemIdx | 0) % NSYS
  if (si < 0) si += NSYS
  if (curSys !== si) { expand(si); ns = 0 }

  let n = W * H, i = 0
  while (i < n) { px[i] = (255 << 24); i++ }
  if (segs === 0) return

  // fit the extent into 88% of the frame, uniform scale
  let spanX = bounds[1] - bounds[0], spanY = bounds[3] - bounds[2]
  if (spanX < 0.0001) spanX = 0.0001
  if (spanY < 0.0001) spanY = 0.0001
  let sx = W * 0.88 / spanX, sy = H * 0.88 / spanY
  let scale = sx < sy ? sx : sy
  let offX = (W - (bounds[1] + bounds[0]) * scale) * 0.5
  let offY = (H - (bounds[3] + bounds[2]) * scale) * 0.5

  let upto = (progress * segs) | 0
  if (upto > segs) upto = segs
  let wb = (W < H ? W : H) / 720.0
  if (wb < 1.0) wb = 1.0
  let plant = PLANT[si] === 1
  let ang = ANG[si] * Math.PI / 180.0
  // pulses: the ambient ones glide on the clock once the drawing is grown; touch pulses advance and expire
  let grown = upto >= segs
  let spd = segs / 900.0 > 0.4 ? segs / 900.0 : 0.4     // a pulse crosses the whole drawing in ~15 s
  let tail = segs * 0.025 + 6.0
  let a0 = t * 60.0 * spd
  i = 0
  while (i < ns) {
    spk[i] = spk[i] + spd
    if (spk[i] - tail > segs) { ns--; spk[i] = spk[ns]; i-- }
    i++
  }
  let bestK = -1, bestD = 1e30
  let x = offX, y = offY, h = HEAD[si] * Math.PI / 180.0, sp = 0, dep = 0, k = 0
  i = 0
  while (i < slen && k < upto) {
    let sym = lstr[i]
    if (draws(si, sym)) {
      let nx = x + Math.cos(h) * scale, ny = y + Math.sin(h) * scale
      let w = plant ? wb * 3.4 * Math.pow(0.7, dep) : wb * 1.1
      let v = plant ? 0.6 : 0.22 + 0.4 * k / segs
      // the brightest pulse tail over this stroke
      let hot = 0.0
      if (grown) {
        let j = 0
        while (j < NA) {
          let d = a0 + j * segs / NA - k
          d = d - Math.floor(d / segs) * segs
          if (d < tail) { let e = 1.0 - d / tail; if (e > hot) hot = e }
          j++
        }
      }
      let j = 0
      while (j < ns) {
        let d = spk[j] - k
        if (d >= 0.0 && d < tail) { let e = 1.0 - d / tail; if (e > hot) hot = e }
        j++
      }
      seg(x, y, nx, ny, w * (1.0 + 0.8 * hot), v + (1.0 - v) * hot)
      if (tgt[2] > 0.5) {
        let ddx = nx - tgt[0], ddy = ny - tgt[1], dd = ddx * ddx + ddy * ddy
        if (dd < bestD) { bestD = dd; bestK = k }
      }
      x = nx; y = ny; k++
    } else if (sym === 1) h -= ang
    else if (sym === 2) h += ang
    else if (sym === 3) { if (sp < 256) { tstack[sp * 4] = x; tstack[sp * 4 + 1] = y; tstack[sp * 4 + 2] = h; tstack[sp * 4 + 3] = dep; sp++; dep++ } }
    else if (sym === 4) { if (sp > 0) { sp--; x = tstack[sp * 4]; y = tstack[sp * 4 + 1]; h = tstack[sp * 4 + 2]; dep = tstack[sp * 4 + 3] | 0 } }
    i++
  }
  if (upto < segs) pen(x, y, wb * 7.0)
  if (tgt[2] > 0.5) { tgt[2] = 0.0; if (bestK >= 0 && ns < MAXS) { spk[ns] = bestK; ns++ } }
}
