// Penrose P3 tiling via Robinson triangle deflation (substitution). φ=(1+√5)/2 governs
// two triangle shapes — fat (36° apex, gold rhombus fill) and thin (108° apex, indigo fill).
// A "sun" of 10 fat triangles seeds 7 rounds of deflation (~128× triangle count), filling a
// large enough patch to pan/zoom across without seeing the edge. All geometry is pre-computed
// once in resize(); frame(t, cx, cy, zoom) transforms, rasterizes, and draws 1-px black tile
// edges — making the aperiodic structure immediately legible.
//
// Interaction: drag to pan, scroll to zoom, double-click to reset (via panZoom in index.html).
// Idle: slow rotation LFO so the pattern is alive with no input.
//
// Color: fat Robinson triangles → warm gold (hue≈0.12), thin → deep indigo (hue≈0.70).
// Edge outlines: each triangle's three edges are drawn as 1-px darkened lines after fill,
// revealing the clean P3 rhombus and dart/kite geometry.
//
// Float64Array storage for all triangle coords — jz narrows plain let-globals to i32.
// resize(w,h) → Uint32Array; frame(t, cx, cy, zoom) renders.

let W = 0, H = 0, px

let MAX_TRI = 500000
let buf0 = new Float64Array(MAX_TRI * 7)
let buf1 = new Float64Array(MAX_TRI * 7)
let triCount = 0

// ── HSL → 0xAABBGGRR (jz-safe: Math.floor decomposition, no float %) ──
let hslColor = (h, s, l) => {
  let c = (1.0 - Math.abs(2.0 * l - 1.0)) * s
  let h6 = h * 6.0
  let hm2 = h6 - 2.0 * Math.floor(h6 * 0.5)
  let x = c * (1.0 - Math.abs(hm2 - 1.0))
  let r1 = 0.0, g1 = 0.0, b1 = 0.0
  if (h6 < 1.0) { r1 = c; g1 = x } else if (h6 < 2.0) { r1 = x; g1 = c } else if (h6 < 3.0) { g1 = c; b1 = x } else if (h6 < 4.0) { g1 = x; b1 = c } else if (h6 < 5.0) { r1 = x; b1 = c } else { r1 = c; b1 = x }
  let m = l - c * 0.5
  let r = ((r1 + m) * 255.0) | 0, g = ((g1 + m) * 255.0) | 0, b = ((b1 + m) * 255.0) | 0
  return (255 << 24) | (b << 16) | (g << 8) | r
}

// ── colors ──
// fat triangle  → warm gold   hue≈0.12, sat 0.88, lit 0.58
// thin triangle → deep indigo hue≈0.67, sat 0.70, lit 0.42
let FAT_COLOR  = 0
let THIN_COLOR = 0
let EDGE_COLOR = 0   // 1-px black outline

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)

  FAT_COLOR  = hslColor(0.115, 0.88, 0.58)   // warm gold
  THIN_COLOR = hslColor(0.675, 0.70, 0.42)   // deep indigo-blue
  EDGE_COLOR = (255 << 24) | 0               // opaque black edge

  let phi = (1.0 + Math.sqrt(5.0)) * 0.5
  let inv = phi - 1.0   // 1/φ = φ−1

  // Seed: 10 fat triangles arranged as "sun" (5-fold symmetry)
  let count = 0
  let n = 10
  for (let i = 0; i < n; i++) {
    let a1 = i * Math.PI / 5.0
    let a2 = (i + 1) * Math.PI / 5.0
    let bx = Math.cos(a1), by = Math.sin(a1)
    let cx = Math.cos(a2), cy = Math.sin(a2)
    let base = count * 7
    if (i % 2 === 0) {
      buf0[base]   = 0
      buf0[base+1] = 0; buf0[base+2] = 0
      buf0[base+3] = bx; buf0[base+4] = by
      buf0[base+5] = cx; buf0[base+6] = cy
    } else {
      buf0[base]   = 0
      buf0[base+1] = 0; buf0[base+2] = 0
      buf0[base+3] = cx; buf0[base+4] = cy
      buf0[base+5] = bx; buf0[base+6] = by
    }
    count++
  }

  // 7 levels of deflation (≈1280 triangles → rich detail at zoom)
  let LEVELS = 7
  let src = buf0, dst = buf1, srcN = count
  for (let lvl = 0; lvl < LEVELS; lvl++) {
    let dstN = 0
    let ok = 1
    for (let i = 0; i < srcN; i++) {
      if (dstN + 2 > MAX_TRI) { ok = 0; break }
      let base = i * 7
      let type = src[base]
      let ax = src[base+1], ay = src[base+2]
      let bx2 = src[base+3], by2 = src[base+4]
      let cx2 = src[base+5], cy2 = src[base+6]

      if (type === 0) {
        // FAT: P = A + (B−A)·inv (1/φ from A along AB)
        let px2 = ax + (bx2 - ax) * inv
        let py2 = ay + (by2 - ay) * inv
        // child 1: FAT  apex=C
        let d1 = dstN * 7
        dst[d1]   = 0; dst[d1+1] = cx2; dst[d1+2] = cy2
        dst[d1+3] = px2; dst[d1+4] = py2; dst[d1+5] = bx2; dst[d1+6] = by2
        dstN++
        // child 2: THIN apex=P
        let d2 = dstN * 7
        dst[d2]   = 1; dst[d2+1] = px2; dst[d2+2] = py2
        dst[d2+3] = cx2; dst[d2+4] = cy2; dst[d2+5] = ax; dst[d2+6] = ay
        dstN++
      } else {
        // THIN: Q = B + (A−B)·inv (1/φ from B along BA)
        let qx = bx2 + (ax - bx2) * inv
        let qy = by2 + (ay - by2) * inv
        // child 1: THIN apex=C
        let d1 = dstN * 7
        dst[d1]   = 1; dst[d1+1] = cx2; dst[d1+2] = cy2
        dst[d1+3] = ax; dst[d1+4] = ay; dst[d1+5] = qx; dst[d1+6] = qy
        dstN++
        // child 2: FAT  apex=Q
        let d2 = dstN * 7
        dst[d2]   = 0; dst[d2+1] = qx; dst[d2+2] = qy
        dst[d2+3] = bx2; dst[d2+4] = by2; dst[d2+5] = cx2; dst[d2+6] = cy2
        dstN++
      }
    }
    if (ok === 0) { srcN = dstN; break }
    // ping-pong
    let tmp = src; src = dst; dst = tmp
    srcN = dstN
  }

  if (src !== buf0) {
    for (let i = 0; i < srcN * 7; i++) buf0[i] = src[i]
  }
  triCount = srcN

  return px
}

// ── Bresenham line (1 px, clips to canvas) ──
let drawLine = (x0f, y0f, x1f, y1f, col) => {
  let x = x0f | 0, y = y0f | 0, xe = x1f | 0, ye = y1f | 0
  let dx = xe - x, dy = ye - y
  let ax = dx < 0 ? -dx : dx, ay = dy < 0 ? -dy : dy
  let sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1
  let err = ax - ay, guard = 0
  while (guard < 8000) {
    if (x >= 0 && x < W && y >= 0 && y < H) px[y * W + x] = col
    if (x === xe && y === ye) break
    let e2 = err * 2
    if (e2 > -ay) { err -= ay; x += sx }
    if (e2 < ax) { err += ax; y += sy }
    guard++
  }
}

// frame(t, cx, cy, zoom) — cx/cy are world-space pan offsets passed from panZoom in index.html.
// zoom is the half-height scale factor from the view object.
export let frame = (t, cx, cy, zoom) => {
  let total = W * H
  let i = 0
  while (i < total) { px[i] = (255 << 24); i++ }

  // slow idle rotation — makes the five-fold symmetry dance gently
  let rot = t * 0.007

  // scale: world radius ~1 maps to half the min dimension
  let S = (W < H ? W : H)
  let scale = S * 0.46 / zoom

  let cosr = Math.cos(rot)
  let sinr = Math.sin(rot)

  let cxScreen = W * 0.5
  let cyScreen = H * 0.5

  let n = triCount
  let i2 = 0

  while (i2 < n) {
    let base = i2 * 7
    let type = buf0[base]
    let ax = buf0[base+1], ay = buf0[base+2]
    let bx = buf0[base+3], by = buf0[base+4]
    let cx2 = buf0[base+5], cy2 = buf0[base+6]

    // Rotate then translate by pan offset (cx,cy are in world units)
    let rax = ax - cx, ray = ay - cy
    let rbx = bx - cx, rby = by - cy
    let rcx = cx2 - cx, rcy = cy2 - cy

    let sax = (rax * cosr - ray * sinr) * scale + cxScreen
    let say = (rax * sinr + ray * cosr) * scale + cyScreen
    let sbx = (rbx * cosr - rby * sinr) * scale + cxScreen
    let sby = (rbx * sinr + rby * cosr) * scale + cyScreen
    let scx = (rcx * cosr - rcy * sinr) * scale + cxScreen
    let scy = (rcx * sinr + rcy * cosr) * scale + cyScreen

    // Bounding box
    let minX = sax | 0, maxX = sax | 0
    let minY = say | 0, maxY = say | 0
    let v1 = sbx | 0; if (v1 < minX) minX = v1; if (v1 > maxX) maxX = v1
    let v2 = scx | 0; if (v2 < minX) minX = v2; if (v2 > maxX) maxX = v2
    let v3 = sby | 0; if (v3 < minY) minY = v3; if (v3 > maxY) maxY = v3
    let v4 = scy | 0; if (v4 < minY) minY = v4; if (v4 > maxY) maxY = v4
    // Expand by 1 pixel to ensure full coverage
    minX = minX - 1; maxX = maxX + 1; minY = minY - 1; maxY = maxY + 1

    // Clip to canvas
    if (minX < 0) minX = 0
    if (minY < 0) minY = 0
    if (maxX >= W) maxX = W - 1
    if (maxY >= H) maxY = H - 1

    // Skip triangles fully off-screen
    if (maxX < 0 || minX >= W || maxY < 0 || minY >= H) { i2++; continue }

    let color = type === 0 ? FAT_COLOR : THIN_COLOR

    // Rasterize triangle
    let py = minY
    while (py <= maxY) {
      let pxc = minX
      while (pxc <= maxX) {
        let d0 = (pxc - sbx) * (say - sby) - (sax - sbx) * (py - sby)
        let d1 = (pxc - scx) * (sby - scy) - (sbx - scx) * (py - scy)
        let d2 = (pxc - sax) * (scy - say) - (scx - sax) * (py - say)
        let has_neg = (d0 < 0) | (d1 < 0) | (d2 < 0)
        let has_pos = (d0 > 0) | (d1 > 0) | (d2 > 0)
        if (!(has_neg & has_pos)) {
          px[py * W + pxc] = color
        }
        pxc++
      }
      py++
    }

    i2++
  }

  // Second pass: draw 1-px black edges over filled triangles (makes rhombus structure clear)
  let i3 = 0
  while (i3 < n) {
    let base = i3 * 7
    let ax = buf0[base+1], ay = buf0[base+2]
    let bx = buf0[base+3], by = buf0[base+4]
    let cx2 = buf0[base+5], cy2 = buf0[base+6]

    let rax = ax - cx, ray = ay - cy
    let rbx = bx - cx, rby = by - cy
    let rcx = cx2 - cx, rcy = cy2 - cy

    let sax = (rax * cosr - ray * sinr) * scale + cxScreen
    let say = (rax * sinr + ray * cosr) * scale + cyScreen
    let sbx = (rbx * cosr - rby * sinr) * scale + cxScreen
    let sby = (rbx * sinr + rby * cosr) * scale + cyScreen
    let scx = (rcx * cosr - rcy * sinr) * scale + cxScreen
    let scy = (rcx * sinr + rcy * cosr) * scale + cyScreen

    // Only draw edges for triangles near screen (rough clip by bounding box center)
    let cx3 = (sax + sbx + scx) * 0.333
    let cy3 = (say + sby + scy) * 0.333
    if (cx3 > -scale && cx3 < W + scale && cy3 > -scale && cy3 < H + scale) {
      drawLine(sax, say, sbx, sby, EDGE_COLOR)
      drawLine(sbx, sby, scx, scy, EDGE_COLOR)
      drawLine(scx, scy, sax, say, EDGE_COLOR)
    }

    i3++
  }
}
