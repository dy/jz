// Penrose P3 tiling via Robinson triangle subdivision (deflation). φ=(1+√5)/2; the
// golden ratio governs the two triangle shapes — fat (36° apex) and thin (108° apex).
// Starting from a "sun" of 10 fat triangles, 6 rounds of deflation grow ~2^6=64× the
// triangle count. All geometry is pre-computed in resize(); frame() just transforms
// and rasterizes. fractional globals (phi, inv_phi, scale coords) live in Float64Array
// so jz doesn't narrow them to i32.
//
// Pixel format: (255<<24)|(b<<16)|(g<<8)|r  (little-endian, R in low byte)
// resize(w,h) → Uint32Array; frame(t, rot, zoom) renders.

let W = 0, H = 0, px

// Triangle storage: each triangle = 7 floats (type, ax, ay, bx, by, cx, cy).
// Float64Array keeps coordinates fractional — jz narrows plain let-globals to i32.
// Two ping-pong buffers; each deflation level roughly doubles the count.
let MAX_TRI = 200000
let buf0 = new Float64Array(MAX_TRI * 7)
let buf1 = new Float64Array(MAX_TRI * 7)
let triCount = 0

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)

  let phi = (1.0 + Math.sqrt(5.0)) * 0.5
  let inv = phi - 1.0   // 1/φ = φ-1; local let is fine — resize runs once, no reassignment

  // Seed: 10 fat triangles arranged as "sun" (5-fold rotational symmetry)
  // Each pair of fat triangles shares the origin as apex and spans 36°.
  let count = 0
  let n = 10
  for (let i = 0; i < n; i++) {
    let a1 = i * Math.PI / 5.0
    let a2 = (i + 1) * Math.PI / 5.0
    let bx = Math.cos(a1), by = Math.sin(a1)
    let cx = Math.cos(a2), cy = Math.sin(a2)
    let base = count * 7
    // Alternate orientation so adjacent triangles share edges cleanly
    if (i % 2 === 0) {
      buf0[base]   = 0  // fat
      buf0[base+1] = 0; buf0[base+2] = 0   // apex A = center
      buf0[base+3] = bx; buf0[base+4] = by // B
      buf0[base+5] = cx; buf0[base+6] = cy // C
    } else {
      buf0[base]   = 0  // fat
      buf0[base+1] = 0; buf0[base+2] = 0   // apex A = center
      buf0[base+3] = cx; buf0[base+4] = cy // B (swapped)
      buf0[base+5] = bx; buf0[base+6] = by // C (swapped)
    }
    count++
  }

  // 6 levels of deflation
  let LEVELS = 6
  let src = buf0, dst = buf1, srcN = count
  for (let lvl = 0; lvl < LEVELS; lvl++) {
    let dstN = 0
    for (let i = 0; i < srcN; i++) {
      let base = i * 7
      let type = src[base]
      let ax = src[base+1], ay = src[base+2]
      let bx2 = src[base+3], by2 = src[base+4]
      let cx2 = src[base+5], cy2 = src[base+6]

      if (dstN + 2 > MAX_TRI) break  // guard overflow

      if (type === 0) {
        // FAT triangle (36° apex at A, base BC)
        // P = A + (B-A)*inv  [on AB at 1/φ from A]
        let px2 = ax + (bx2 - ax) * inv
        let py2 = ay + (by2 - ay) * inv
        // child 1: FAT  apex=C, base=P,B
        let d1 = dstN * 7
        dst[d1]   = 0
        dst[d1+1] = cx2;  dst[d1+2] = cy2
        dst[d1+3] = px2;  dst[d1+4] = py2
        dst[d1+5] = bx2;  dst[d1+6] = by2
        dstN++
        // child 2: THIN apex=P, base=C,A
        let d2 = dstN * 7
        dst[d2]   = 1
        dst[d2+1] = px2;  dst[d2+2] = py2
        dst[d2+3] = cx2;  dst[d2+4] = cy2
        dst[d2+5] = ax;   dst[d2+6] = ay
        dstN++
      } else {
        // THIN triangle (108° apex at A, base BC)
        // Q = B + (A-B)*inv  [on BA at 1/φ from B]
        let qx = bx2 + (ax - bx2) * inv
        let qy = by2 + (ay - by2) * inv
        // child 1: THIN apex=C, base=A,Q
        let d1 = dstN * 7
        dst[d1]   = 1
        dst[d1+1] = cx2;  dst[d1+2] = cy2
        dst[d1+3] = ax;   dst[d1+4] = ay
        dst[d1+5] = qx;   dst[d1+6] = qy
        dstN++
        // child 2: FAT  apex=Q, base=B,C
        let d2 = dstN * 7
        dst[d2]   = 0
        dst[d2+1] = qx;   dst[d2+2] = qy
        dst[d2+3] = bx2;  dst[d2+4] = by2
        dst[d2+5] = cx2;  dst[d2+6] = cy2
        dstN++
      }
    }
    // ping-pong
    let tmp = src; src = dst; dst = tmp
    srcN = dstN
  }

  // Copy final result into buf0 (src may be buf1 after odd number of swaps)
  if (src !== buf0) {
    for (let i = 0; i < srcN * 7; i++) buf0[i] = src[i]
  }
  triCount = srcN

  return px
}

export let frame = (t, rot, zoom) => {
  // Clear to opaque black
  let total = W * H
  let i = 0
  while (i < total) { px[i] = (255 << 24); i++ }

  let r = rot
  let z = zoom

  let scale = (W < H ? W : H) * 0.46 * z
  let cxc = W * 0.5
  let cyc = H * 0.5
  let cosr = Math.cos(r)
  let sinr = Math.sin(r)

  let n = triCount
  let i2 = 0
  while (i2 < n) {
    let base = i2 * 7
    let type = buf0[base]
    let ax = buf0[base+1], ay = buf0[base+2]
    let bx = buf0[base+3], by = buf0[base+4]
    let cx2 = buf0[base+5], cy2 = buf0[base+6]

    // Rotate and scale to screen coordinates
    let sax = (ax * cosr - ay * sinr) * scale + cxc
    let say = (ax * sinr + ay * cosr) * scale + cyc
    let sbx = (bx * cosr - by * sinr) * scale + cxc
    let sby = (bx * sinr + by * cosr) * scale + cyc
    let scx = (cx2 * cosr - cy2 * sinr) * scale + cxc
    let scy = (cx2 * sinr + cy2 * cosr) * scale + cyc

    // Bounding box — ceil maxes, floor mins for pixel coverage
    let minX = sax | 0, maxX = (sax + 1.0) | 0
    let minY = say | 0, maxY = (say + 1.0) | 0
    let v1 = sbx | 0; if (v1 < minX) minX = v1
    let v2 = (sbx + 1.0) | 0; if (v2 > maxX) maxX = v2
    v1 = scx | 0; if (v1 < minX) minX = v1
    v2 = (scx + 1.0) | 0; if (v2 > maxX) maxX = v2
    v1 = sby | 0; if (v1 < minY) minY = v1
    v2 = (sby + 1.0) | 0; if (v2 > maxY) maxY = v2
    v1 = scy | 0; if (v1 < minY) minY = v1
    v2 = (scy + 1.0) | 0; if (v2 > maxY) maxY = v2

    // Clip to canvas
    if (minX < 0) minX = 0
    if (minY < 0) minY = 0
    if (maxX >= W) maxX = W - 1
    if (maxY >= H) maxY = H - 1

    // Color: fat=gold (R=255,G=215,B=0), thin=steel blue (R=120,G=160,B=255)
    let color = 0
    if (type === 0) {
      color = (255 << 24) | (0 << 16) | (215 << 8) | 255
    } else {
      color = (255 << 24) | (255 << 16) | (160 << 8) | 120
    }

    // Point-in-triangle via sign function: sign(P, V0, V1) = (px-v1x)*(v0y-v1y) - (v0x-v1x)*(py-v1y)
    // Inside if all three have the same sign (no sign mixing).
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
}
