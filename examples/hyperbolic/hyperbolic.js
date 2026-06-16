// Poincaré disk — hyperbolic plane tessellation in the "Circle Limit" style.
// The Poincaré disk model embeds the entire hyperbolic plane inside the unit disk;
// geodesics (straight lines in hyperbolic geometry) appear as circular arcs
// perpendicular to the boundary circle.
//
// We tile using the {∞,3} triangle group: start with an ideal triangle (vertices
// on the boundary), repeatedly invert each third vertex through the opposite
// geodesic edge. This generates the Farey-sequence / Ford-circle fractal of
// nested geodesic arcs converging to the boundary.
//
// jz rules obeyed:
//   · All persistent fractional state in Float64Array (module-level floats → i32)
//   · frame() args carry fractional parameters (f64 in wasm)
//   · resize() allocates; frame() never does
//   · Pixel layout: (255<<24)|(b<<16)|(g<<8)|r  (little-endian RGBA)
//
// resize(w,h) → Uint32Array   frame(t, rotAngle)

let W = 0, H = 0, px
// Persistent fractional state: [0]=cx_screen [1]=cy_screen [2]=R_screen [3..]=stack scratch
// Stack lives here: each entry = 7 doubles (u0x,u0y, u1x,u1y, u2x,u2y, depth)
let st           // Float64Array for stack
let f64          // Float64Array for misc fractional state [0]=cx [1]=cy [2]=R

const MAX_DEPTH = 7
const STACK_STRIDE = 7
const STACK_CAP = 6000   // 6000 triangles × 7 = 42000 floats

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  f64 = new Float64Array(4)
  st = new Float64Array(STACK_CAP * STACK_STRIDE)
  return px
}

// Additive pixel accumulation — clamp each channel
let addpix = (x, y, r, g, b) => {
  if (x < 0 || x >= W || y < 0 || y >= H) return
  let idx = (y | 0) * W + (x | 0)
  let p = px[idx]
  let rr = (p & 0xff) + r; if (rr > 255) rr = 255
  let gg = ((p >> 8) & 0xff) + g; if (gg > 255) gg = 255
  let bb = ((p >> 16) & 0xff) + b; if (bb > 255) bb = 255
  px[idx] = (255 << 24) | (bb << 16) | (gg << 8) | rr
}

// Draw a geodesic arc between two ideal (boundary) points u=(ux,uy), v=(vx,vy).
// Samples the orthogonal circle and plots points inside the unit disk.
let drawGeodesic = (ux, uy, vx, vy, R_scr, cx_scr, cy_scr, depth, cr, cg, cb) => {
  let dot = ux * vx + uy * vy
  let denom = 1.0 + dot
  if (denom < 0.0) denom = -denom
  let STEPS = 0
  if (denom < 1e-7) {
    // Nearly antipodal → diameter line
    STEPS = 200
    let i = 0
    while (i < STEPS) {
      let t2 = i / (STEPS - 1.0)
      let px2 = ux + (vx - ux) * t2
      let py2 = uy + (vy - uy) * t2
      let r2 = px2 * px2 + py2 * py2
      if (r2 < 0.999) {
        let sx = cx_scr + px2 * R_scr
        let sy = cy_scr - py2 * R_scr
        addpix(sx | 0, sy | 0, cr, cg, cb)
      }
      i++
    }
    return
  }
  let cx = (ux + vx) / (1.0 + dot)
  let cy = (uy + vy) / (1.0 + dot)
  let r2 = cx * cx + cy * cy - 1.0
  if (r2 < 0.0) r2 = 0.0
  let R = Math.sqrt(r2)

  // Arc length in screen pixels ≈ 2πR * R_scr; skip if too small
  let arcPx = 2.0 * 3.14159265 * R * R_scr
  if (arcPx < 1.5) return

  STEPS = (arcPx | 0) + 4
  if (STEPS > 800) STEPS = 800

  let i2 = 0
  while (i2 < STEPS) {
    let angle = i2 / STEPS * 6.28318530718
    let px2 = cx + R * Math.cos(angle)
    let py2 = cy + R * Math.sin(angle)
    // Only draw inside the open unit disk
    if (px2 * px2 + py2 * py2 < 0.999) {
      let sx = cx_scr + px2 * R_scr
      let sy = cy_scr - py2 * R_scr
      addpix(sx | 0, sy | 0, cr, cg, cb)
    }
    i2++
  }
}

// Invert point (px,py) in the geodesic circle for edge (ux,uy)-(vx,vy).
// The geodesic circle has center C=(cx,cy) and radius R; inversion maps p → C + R²(p-C)/|p-C|²
// We write result into result[0..1].
let invertPt = (ptx, pty, ux, uy, vx, vy, result) => {
  let dot = ux * vx + uy * vy
  let denom = 1.0 + dot
  if (denom < 0.0) denom = -denom
  if (denom < 1e-9) {
    // Diameter case: reflect through the perpendicular bisector line
    // The "reflection" in a diameter geodesic is Euclidean reflection through that diameter
    let len = Math.sqrt(ux * ux + uy * uy)
    if (len < 1e-12) { result[0] = ptx; result[1] = pty; return }
    // normal to diameter direction: rotate (ux,uy) by 90°
    let nx = -uy / len, ny = ux / len
    let proj = ptx * nx + pty * ny
    result[0] = ptx - 2.0 * proj * nx
    result[1] = pty - 2.0 * proj * ny
    return
  }
  let cx = (ux + vx) / (1.0 + dot)
  let cy = (uy + vy) / (1.0 + dot)
  let R2 = cx * cx + cy * cy - 1.0
  if (R2 < 0.0) R2 = 0.0
  let dx = ptx - cx
  let dy = pty - cy
  let d2 = dx * dx + dy * dy
  if (d2 < 1e-20) { result[0] = ptx; result[1] = pty; return }
  result[0] = cx + R2 * dx / d2
  result[1] = cy + R2 * dy / d2
}

export let frame = (t, rotAngle) => {
  // Clear to black inside the disk, dark gray outside
  let cx_scr = W * 0.5
  let cy_scr = H * 0.5
  let minD = W < H ? W : H
  let R_scr = minD * 0.47

  let n = W * H
  let i = 0
  while (i < n) { px[i] = 0xff000000 | 0; i++ }

  // Draw the boundary circle (bright white ring)
  let circSteps = 1200
  let k = 0
  while (k < circSteps) {
    let a = k / circSteps * 6.28318530718
    let sx = cx_scr + Math.cos(a) * R_scr
    let sy = cy_scr + Math.sin(a) * R_scr
    addpix(sx | 0, sy | 0, 200, 200, 200)
    k++
  }

  // Color table by depth: bright at depth 0, dimmer deeper, with hue shift
  // We'll use 8 depth levels. Each is (r,g,b).
  // Stored in Float64Array to avoid i32 narrowing of fractional RGB floats —
  // but since these are integers 0-255, plain const is fine.
  let result = f64   // reuse f64 scratch for inversion results [0],[1]

  // Three initial ideal vertices of the seed triangle, rotated by rotAngle
  let cos0 = Math.cos(rotAngle)
  let sin0 = Math.sin(rotAngle)

  // Base triangle: vertices at angles 0, 2π/3, 4π/3 on unit circle
  let a0 = rotAngle
  let a1 = rotAngle + 2.0943951023931953  // 2π/3
  let a2 = rotAngle + 4.1887902047863905  // 4π/3

  let v0x = Math.cos(a0), v0y = Math.sin(a0)
  let v1x = Math.cos(a1), v1y = Math.sin(a1)
  let v2x = Math.cos(a2), v2y = Math.sin(a2)

  // Stack: push initial triangle (depth 0)
  let top = 0
  st[top + 0] = v0x; st[top + 1] = v0y
  st[top + 2] = v1x; st[top + 3] = v1y
  st[top + 4] = v2x; st[top + 5] = v2y
  st[top + 6] = 0.0  // depth
  top += STACK_STRIDE

  while (top > 0) {
    top -= STACK_STRIDE
    let u0x = st[top + 0], u0y = st[top + 1]
    let u1x = st[top + 2], u1y = st[top + 3]
    let u2x = st[top + 4], u2y = st[top + 5]
    let depth = st[top + 6] | 0

    // Color by depth: 8 slots cycling
    let phase = depth % 8
    let cr = 0, cg = 0, cb = 0
    let bright = 255 - depth * 28
    if (bright < 40) bright = 40
    if (phase == 0) { cr = bright; cg = bright; cb = bright }
    else if (phase == 1) { cr = bright; cg = (bright * 0.4) | 0; cb = (bright * 0.2) | 0 }
    else if (phase == 2) { cr = (bright * 0.2) | 0; cg = bright; cb = (bright * 0.5) | 0 }
    else if (phase == 3) { cr = (bright * 0.3) | 0; cg = (bright * 0.6) | 0; cb = bright }
    else if (phase == 4) { cr = bright; cg = (bright * 0.85) | 0; cb = 0 }
    else if (phase == 5) { cr = (bright * 0.8) | 0; cg = 0; cb = bright }
    else if (phase == 6) { cr = 0; cg = bright; cb = bright }
    else             { cr = bright; cg = bright; cb = (bright * 0.4) | 0 }

    // Draw 3 geodesic edges
    drawGeodesic(u0x, u0y, u1x, u1y, R_scr, cx_scr, cy_scr, depth, cr, cg, cb)
    drawGeodesic(u1x, u1y, u2x, u2y, R_scr, cx_scr, cy_scr, depth, cr, cg, cb)
    drawGeodesic(u0x, u0y, u2x, u2y, R_scr, cx_scr, cy_scr, depth, cr, cg, cb)

    if (depth < MAX_DEPTH && top + 3 * STACK_STRIDE <= STACK_CAP * STACK_STRIDE) {
      // Reflect u2 in edge u0-u1 → new child triangle (u0,u1,w0)
      invertPt(u2x, u2y, u0x, u0y, u1x, u1y, result)
      let w0x = result[0], w0y = result[1]

      // Reflect u0 in edge u1-u2 → new child triangle (w1,u1,u2)
      invertPt(u0x, u0y, u1x, u1y, u2x, u2y, result)
      let w1x = result[0], w1y = result[1]

      // Reflect u1 in edge u0-u2 → new child triangle (u0,w2,u2)
      invertPt(u1x, u1y, u0x, u0y, u2x, u2y, result)
      let w2x = result[0], w2y = result[1]

      let nd = depth + 1
      st[top + 0] = u0x; st[top + 1] = u0y
      st[top + 2] = u1x; st[top + 3] = u1y
      st[top + 4] = w0x; st[top + 5] = w0y
      st[top + 6] = nd
      top += STACK_STRIDE

      st[top + 0] = w1x; st[top + 1] = w1y
      st[top + 2] = u1x; st[top + 3] = u1y
      st[top + 4] = u2x; st[top + 5] = u2y
      st[top + 6] = nd
      top += STACK_STRIDE

      st[top + 0] = u0x; st[top + 1] = u0y
      st[top + 2] = w2x; st[top + 3] = w2y
      st[top + 4] = u2x; st[top + 5] = u2y
      st[top + 6] = nd
      top += STACK_STRIDE
    }
  }
}
