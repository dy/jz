// L-system fractals — Koch snowflake, Dragon curve, Sierpinski arrowhead, Fractal plant.
// An L-system rewrites an axiom string by applying production rules repeatedly (string
// substitution), then interprets the result as turtle-graphics commands. This gives
// self-similar fractal curves from tiny rule tables.
//
// Symbol encoding: 0=F 1=+ 2=- 3=[ 4=] 5=X 6=Y 7=A 8=B
// resize(w,h) → Uint32Array; frame(t, systemIdx, progress) renders.

let W = 0, H = 0, px

// Two large string buffers for ping-pong L-system expansion — typed arrays avoid i32 narrowing
let lstr = new Uint8Array(2000000)   // current expanded string
let lbuf = new Uint8Array(2000000)   // expansion workspace
let llen = new Int32Array(1)         // actual string length

// Track current system to detect changes
let curSys = new Float64Array(1)     // -1 means "not yet expanded"

// Turtle state (fractional → Float64Array to avoid i32 narrowing)
let tstate = new Float64Array(3)     // [x, y, heading]
let tstack = new Float64Array(3 * 200) // push/pop stack (200 levels)
let tdepth = new Int32Array(1)       // stack depth

// Bounds from pre-pass
let bounds = new Float64Array(4)     // [minX, maxX, minY, maxY]

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  curSys[0] = -1.0  // force re-expansion on first frame
  return px
}

// Expand L-system for the given system index into lstr/llen
let expandSystem = (si) => {
  // --- System parameters (encoded as integer symbol arrays) ---

  // Axiom arrays — we'll write them into lstr directly
  // Koch: F++F++F  (F=0, +=1)
  // Dragon: FX  (F=0, X=5)
  // Sierpinski: A  (A=7)
  // Plant: X  (X=5)

  // Rule for each symbol (result is a sequence of codes)
  // We'll interpret si to pick axiom and rules

  // Clear and write axiom
  let alen = 0
  if (si == 0) {
    // Koch: axiom = F++F++F
    lstr[0] = 0; lstr[1] = 1; lstr[2] = 1
    lstr[3] = 0; lstr[4] = 1; lstr[5] = 1; lstr[6] = 0
    alen = 7
  } else if (si == 1) {
    // Dragon: axiom = FX
    lstr[0] = 0; lstr[1] = 5
    alen = 2
  } else if (si == 2) {
    // Sierpinski: axiom = A
    lstr[0] = 7
    alen = 1
  } else {
    // Plant: axiom = X
    lstr[0] = 5
    alen = 1
  }

  llen[0] = alen

  // depth per system
  let depth = 4
  if (si == 1) depth = 11
  if (si == 2) depth = 6
  if (si == 3) depth = 5

  let d = 0
  while (d < depth) {
    // Expand: read lstr[0..llen[0]], write rewritten to lbuf
    let rlen = 0
    let cap = 1800000
    let i = 0
    let clen = llen[0]
    while (i < clen) {
      let sym = lstr[i]
      // Check if we have room
      if (rlen >= cap) { i = clen; break }

      if (si == 0) {
        // Koch rules: F → F-F++F-F, + → +, - → -
        if (sym == 0) {
          // F → F - F + + F - F  (codes: 0,2,0,1,1,0,2,0)
          if (rlen + 8 > cap) { i = clen; break }
          lbuf[rlen] = 0; lbuf[rlen+1] = 2; lbuf[rlen+2] = 0; lbuf[rlen+3] = 1
          lbuf[rlen+4] = 1; lbuf[rlen+5] = 0; lbuf[rlen+6] = 2; lbuf[rlen+7] = 0
          rlen = rlen + 8
        } else {
          lbuf[rlen] = sym; rlen++
        }
      } else if (si == 1) {
        // Dragon rules: F → F, X → X+YF+, Y → -FX-Y
        if (sym == 5) {
          // X → X + Y F +  (codes: 5,1,6,0,1)
          if (rlen + 5 > cap) { i = clen; break }
          lbuf[rlen] = 5; lbuf[rlen+1] = 1; lbuf[rlen+2] = 6; lbuf[rlen+3] = 0; lbuf[rlen+4] = 1
          rlen = rlen + 5
        } else if (sym == 6) {
          // Y → - F X - Y  (codes: 2,0,5,2,6)
          if (rlen + 5 > cap) { i = clen; break }
          lbuf[rlen] = 2; lbuf[rlen+1] = 0; lbuf[rlen+2] = 5; lbuf[rlen+3] = 2; lbuf[rlen+4] = 6
          rlen = rlen + 5
        } else {
          lbuf[rlen] = sym; rlen++
        }
      } else if (si == 2) {
        // Sierpinski: A → B-A-B, B → A+B+A
        if (sym == 7) {
          // A → B - A - B  (codes: 8,2,7,2,8)
          if (rlen + 5 > cap) { i = clen; break }
          lbuf[rlen] = 8; lbuf[rlen+1] = 2; lbuf[rlen+2] = 7; lbuf[rlen+3] = 2; lbuf[rlen+4] = 8
          rlen = rlen + 5
        } else if (sym == 8) {
          // B → A + B + A  (codes: 7,1,8,1,7)
          if (rlen + 5 > cap) { i = clen; break }
          lbuf[rlen] = 7; lbuf[rlen+1] = 1; lbuf[rlen+2] = 8; lbuf[rlen+3] = 1; lbuf[rlen+4] = 7
          rlen = rlen + 5
        } else {
          lbuf[rlen] = sym; rlen++
        }
      } else {
        // Plant: X → F+[[X]-X]-F[-FX]+X, F → FF
        if (sym == 5) {
          // X → F + [ [ X ] - X ] - F [ - F X ] + X
          // codes: 0,1,3,3,5,4,2,5,4,2,0,3,2,0,5,4,1,5
          if (rlen + 18 > cap) { i = clen; break }
          lbuf[rlen]    = 0; lbuf[rlen+1]  = 1; lbuf[rlen+2]  = 3; lbuf[rlen+3]  = 3
          lbuf[rlen+4]  = 5; lbuf[rlen+5]  = 4; lbuf[rlen+6]  = 2; lbuf[rlen+7]  = 5
          lbuf[rlen+8]  = 4; lbuf[rlen+9]  = 2; lbuf[rlen+10] = 0; lbuf[rlen+11] = 3
          lbuf[rlen+12] = 2; lbuf[rlen+13] = 0; lbuf[rlen+14] = 5; lbuf[rlen+15] = 4
          lbuf[rlen+16] = 1; lbuf[rlen+17] = 5
          rlen = rlen + 18
        } else if (sym == 0) {
          // F → FF
          if (rlen + 2 > cap) { i = clen; break }
          lbuf[rlen] = 0; lbuf[rlen+1] = 0
          rlen = rlen + 2
        } else {
          lbuf[rlen] = sym; rlen++
        }
      }
      i++
    }

    // Copy lbuf back to lstr
    llen[0] = rlen
    let j = 0
    while (j < rlen) { lstr[j] = lbuf[j]; j++ }

    d++
  }
}

// Turtle walk: doPass=0 → bounds only, doPass=1 → draw
// Returns total drawing segments counted (only meaningful in bounds pass)
let addpix = (x, y, rr, gg, bb) => {
  if (x < 0 || x >= W || y < 0 || y >= H) return
  let idx = y * W + x
  let p = px[idx]
  let r = (p & 0xff) + rr
  let g = ((p >> 8) & 0xff) + gg
  let b = ((p >> 16) & 0xff) + bb
  if (r > 255) r = 255
  if (g > 255) g = 255
  if (b > 255) b = 255
  px[idx] = (255 << 24) | (b << 16) | (g << 8) | r
}

let line = (x0, y0, x1, y1, rr, gg, bb) => {
  let dx = x1 - x0, dy = y1 - y0
  let adx = dx < 0.0 ? -dx : dx, ady = dy < 0.0 ? -dy : dy
  let steps = (adx > ady ? adx : ady) | 0
  if (steps < 1) steps = 1
  let xi = dx / steps, yi = dy / steps
  let x = x0, y = y0, s = 0
  while (s <= steps) { addpix(x | 0, y | 0, rr, gg, bb); x += xi; y += yi; s++ }
}

export let frame = (t, systemIdx, progress) => {
  let si = (systemIdx | 0) % 4

  // Re-expand string if system changed
  if (curSys[0] != si) {
    curSys[0] = si
    expandSystem(si)
  }

  // Clear canvas
  let n = W * H
  let ci = 0
  while (ci < n) { px[ci] = (255 << 24); ci++ }

  // Angle per system (in radians stored as f64)
  let ang = 0.0
  if (si == 0) ang = 1.0471975511965976  // 60° = PI/3
  if (si == 1) ang = 1.5707963267948966  // 90° = PI/2
  if (si == 2) ang = 1.0471975511965976  // 60°
  if (si == 3) ang = 0.4363323129985824  // 25° = PI/180*25

  // Single gray for all systems — palette button recolors
  let cr = 200, cg = 200, cb = 200

  let slen = llen[0]

  // Count total drawing segments (F for most, A+B for Sierpinski)
  let totalSegs = 0
  let ii = 0
  while (ii < slen) {
    let sym = lstr[ii]
    if (sym == 0) totalSegs++                       // F always draws
    if (si == 2 && (sym == 7 || sym == 8)) totalSegs++ // A,B for Sierpinski
    ii++
  }

  if (totalSegs == 0) return

  // --- Bounds pass ---
  // We need a turtle walk to find the extent of the curve
  // Use separate local vars (f64) for turtle state in this pass
  let bx = 0.0, by = 0.0, bh = 0.0
  let minX = 0.0, maxX = 0.0, minY = 0.0, maxY = 0.0
  let first = 1

  // Reset stack
  tdepth[0] = 0

  let bi = 0
  while (bi < slen) {
    let sym = lstr[bi]
    let draws = 0
    if (sym == 0) draws = 1
    if (si == 2 && (sym == 7 || sym == 8)) draws = 1

    if (draws == 1) {
      let nx = bx + Math.cos(bh)
      let ny = by + Math.sin(bh)
      if (first == 1) {
        minX = bx; maxX = bx; minY = by; maxY = by; first = 0
      }
      if (nx < minX) minX = nx
      if (nx > maxX) maxX = nx
      if (ny < minY) minY = ny
      if (ny > maxY) maxY = ny
      bx = nx; by = ny
    } else if (sym == 1) {
      bh = bh - ang   // turn left
    } else if (sym == 2) {
      bh = bh + ang   // turn right
    } else if (sym == 3) {
      // push
      let sp = tdepth[0]
      if (sp < 200) {
        tstack[sp * 3]     = bx
        tstack[sp * 3 + 1] = by
        tstack[sp * 3 + 2] = bh
        tdepth[0] = sp + 1
      }
    } else if (sym == 4) {
      // pop
      let sp = tdepth[0] - 1
      if (sp >= 0) {
        bx = tstack[sp * 3]
        by = tstack[sp * 3 + 1]
        bh = tstack[sp * 3 + 2]
        tdepth[0] = sp
      }
    }
    bi++
  }

  // Compute scale/offset to fit 90% of canvas
  let spanX = maxX - minX
  let spanY = maxY - minY
  if (spanX < 0.0001) spanX = 0.0001
  if (spanY < 0.0001) spanY = 0.0001

  let scaleX = W * 0.9 / spanX
  let scaleY = H * 0.9 / spanY
  let scale = scaleX < scaleY ? scaleX : scaleY  // uniform scale

  let offX = (W - (maxX + minX) * scale) * 0.5
  let offY = (H - (maxY + minY) * scale) * 0.5

  // --- Draw pass ---
  let drawUpTo = (progress * totalSegs) | 0
  if (drawUpTo > totalSegs) drawUpTo = totalSegs

  let dx = 0.0, dy = 0.0, dh = 0.0
  tdepth[0] = 0
  let segCount = 0

  // starting orientation for each system
  // Koch: heading = 0 (right)
  // Dragon: heading = 0
  // Sierpinski: depends on depth parity — we use 0
  // Plant: heading = -PI/2 (upward, since sin heading goes Y-down in screen coords)
  // Actually let's use heading=PI*1.5 for plant so it grows upward (screen Y increases downward)
  if (si == 3) {
    dh = -1.5707963267948966  // -PI/2: heading up (y decreases)
  } else {
    dh = 0.0
  }
  dx = offX + minX * scale  // start at transformed origin
  dy = offY + minY * scale

  // Actually start turtle at canvas-projected (0,0) equivalent:
  // The bounds pass started at (0,0) in turtle space → screen = (offX, offY)
  // Wait: the initial turtle pos in bounds pass is (0,0), so screen = (0*scale+offX, 0*scale+offY)
  dx = offX
  dy = offY

  // Re-init heading correctly for draw pass (bounds pass had dh=0 for all, same start)
  if (si == 3) {
    dh = -1.5707963267948966
    // The bounds pass used dh=0 for plant — we need to redo bounds with same heading.
    // Re-run bounds with plant heading = -PI/2
    bx = 0.0; by = 0.0; bh = -1.5707963267948966
    minX = 0.0; maxX = 0.0; minY = 0.0; maxY = 0.0; first = 1
    tdepth[0] = 0

    let pi2 = 0
    while (pi2 < slen) {
      let sym2 = lstr[pi2]
      let draws2 = 0
      if (sym2 == 0) draws2 = 1

      if (draws2 == 1) {
        let nx2 = bx + Math.cos(bh)
        let ny2 = by + Math.sin(bh)
        if (first == 1) {
          minX = bx; maxX = bx; minY = by; maxY = by; first = 0
        }
        if (bx < minX) minX = bx
        if (bx > maxX) maxX = bx
        if (by < minY) minY = by
        if (by > maxY) maxY = by
        if (nx2 < minX) minX = nx2
        if (nx2 > maxX) maxX = nx2
        if (ny2 < minY) minY = ny2
        if (ny2 > maxY) maxY = ny2
        bx = nx2; by = ny2
      } else if (sym2 == 1) {
        bh = bh - ang
      } else if (sym2 == 2) {
        bh = bh + ang
      } else if (sym2 == 3) {
        let sp2 = tdepth[0]
        if (sp2 < 200) {
          tstack[sp2 * 3]     = bx
          tstack[sp2 * 3 + 1] = by
          tstack[sp2 * 3 + 2] = bh
          tdepth[0] = sp2 + 1
        }
      } else if (sym2 == 4) {
        let sp2 = tdepth[0] - 1
        if (sp2 >= 0) {
          bx = tstack[sp2 * 3]
          by = tstack[sp2 * 3 + 1]
          bh = tstack[sp2 * 3 + 2]
          tdepth[0] = sp2
        }
      }
      pi2++
    }

    spanX = maxX - minX
    spanY = maxY - minY
    if (spanX < 0.0001) spanX = 0.0001
    if (spanY < 0.0001) spanY = 0.0001

    scaleX = W * 0.9 / spanX
    scaleY = H * 0.9 / spanY
    scale = scaleX < scaleY ? scaleX : scaleY

    offX = (W - (maxX + minX) * scale) * 0.5
    offY = (H - (maxY + minY) * scale) * 0.5
  }

  // Reset turtle for draw pass
  dx = offX
  dy = offY
  dh = si == 3 ? -1.5707963267948966 : 0.0
  tdepth[0] = 0
  segCount = 0

  let di = 0
  while (di < slen) {
    let sym = lstr[di]
    let draws = 0
    if (sym == 0) draws = 1
    if (si == 2 && (sym == 7 || sym == 8)) draws = 1

    if (draws == 1) {
      if (segCount < drawUpTo) {
        let nx = dx + Math.cos(dh) * scale
        let ny = dy + Math.sin(dh) * scale
        line(dx, dy, nx, ny, cr, cg, cb)
        dx = nx; dy = ny
      } else {
        // Still advance position even if not drawing (for correct state)
        dx = dx + Math.cos(dh) * scale
        dy = dy + Math.sin(dh) * scale
      }
      segCount++
    } else if (sym == 1) {
      dh = dh - ang
    } else if (sym == 2) {
      dh = dh + ang
    } else if (sym == 3) {
      let sp = tdepth[0]
      if (sp < 200) {
        tstack[sp * 3]     = dx
        tstack[sp * 3 + 1] = dy
        tstack[sp * 3 + 2] = dh
        tdepth[0] = sp + 1
      }
    } else if (sym == 4) {
      let sp = tdepth[0] - 1
      if (sp >= 0) {
        dx = tstack[sp * 3]
        dy = tstack[sp * 3 + 1]
        dh = tstack[sp * 3 + 2]
        tdepth[0] = sp
      }
    }
    di++
  }
}
