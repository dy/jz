// Poincaré disk — the hyperbolic plane tiled by a (2, p, q) triangle group, in the black-and-white
// of Escher's Circle Limit. The disk model holds the whole hyperbolic plane inside the unit circle;
// its straight lines (geodesics) are circular arcs meeting the rim at right angles.
//
// Every pixel is folded into ONE fundamental triangle — angles π/p at the centre, π/q at a vertex,
// π/2 at the third — by reflecting it across the triangle's three mirrors until it lies inside: the
// real axis, the line through the origin at angle π/p, and the circle orthogonal to the rim that
// meets that line at π/q (centre d, radius r with d² = 1 + r², d·sin(π/p) = r·cos(π/q)). The count
// of reflections is the triangle's parity: even white, odd black, so neighbours always differ — the
// two-colour triangle-group tiling. Circle inversions stretch space by r²/|w−c|²; tracking that
// conformal factor turns each mirror distance into a distance in screen pixels, so every edge is
// anti-aliased at exactly one pixel, the {p, q} polygon edges are drawn as hairlines, and triangles
// smaller than a few pixels fade to grey toward the rim — the limit itself.
//
// The view is a hyperbolic translation: z ↦ (z + a)/(1 + āz) brings the point a to the centre, so
// moving a travels through the plane (the tiles swell from the rim and shrink back into it), followed
// by a rotation. resize(w,h) → Uint32Array; frame(t, ax, ay, rot, p, q).

let W = 0, H = 0, px

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  return px
}

export let frame = (t, ax, ay, rot, p, q) => {
  let cp = Math.cos(Math.PI / p), sp = Math.sin(Math.PI / p), cq = Math.cos(Math.PI / q)
  let d = cq / Math.sqrt(cq * cq - sp * sp)       // mirror circle: centre (d, 0), radius r
  let r = Math.sqrt(d * d - 1.0), r2 = r * r
  let cr = Math.cos(rot), sr = Math.sin(rot)
  let aa = 1.0 - ax * ax - ay * ay
  let R = (W < H ? W : H) * 0.47                  // disk radius, px
  let cx = W * 0.5, cy = H * 0.5, pw = 1.0 / R    // one pixel, in disk units
  let TRI = (d - r) * sp * 0.5                    // ~ the fundamental triangle's inradius

  let j = 0, iy = 0
  while (iy < H) {
    let zy = (cy - iy - 0.5) * pw
    let ix = 0
    while (ix < W) {
      let zx = (ix + 0.5 - cx) * pw
      let rr = zx * zx + zy * zy
      let v = 0.0
      if (rr < 1.0) {
        // hyperbolic translation a → 0: w = (z + a)/(1 + ā z), |dw/dz| = (1 − |a|²)/|1 + ā z|²
        let nx = zx + ax, ny = zy + ay
        let dx = 1.0 + ax * zx + ay * zy, dy = ax * zy - ay * zx
        let dd = dx * dx + dy * dy
        let ux = (nx * dx + ny * dy) / dd, uy = (ny * dx - nx * dy) / dd
        let sc = aa / dd
        let wx = ux * cr - uy * sr, wy = ux * sr + uy * cr
        // fold into the fundamental triangle
        let par = 0, it = 0, done = 0
        while (done === 0 && it < 60) {
          done = 1
          if (wy < 0.0) { wy = -wy; par = par ^ 1; done = 0 }
          let s = wy * cp - wx * sp                  // side of the line at angle π/p
          if (s > 0.0) { wx = wx + 2.0 * s * sp; wy = wy - 2.0 * s * cp; par = par ^ 1; done = 0 }
          let ex = wx - d, e2 = ex * ex + wy * wy
          if (e2 < r2) {                             // inside the mirror circle → invert
            let k = r2 / e2
            wx = d + ex * k; wy = wy * k; sc = sc * k
            par = par ^ 1; done = 0
          }
          it++
        }
        // distances to the three mirrors, in screen pixels
        let ps = pw * sc
        let dA = wy / ps
        let dL = (wx * sp - wy * cp) / ps
        let ex = wx - d
        let dC = (Math.sqrt(ex * ex + wy * wy) - r) / ps
        let m = dA < dL ? dA : dL
        m = m < dC ? m : dC
        let base = par === 0 ? 0.9 : 0.05
        let c = m * 2.0
        c = c > 1.0 ? 1.0 : c
        v = 0.47 + (base - 0.47) * c                // anti-aliased across every mirror
        let e = 1.0 - dC * 0.8                        // {p,q} polygon edges: a grey hairline
        if (e > 0.0) v = v + (0.47 - v) * e * 0.85
        let f = (TRI / ps - 1.2) * 0.4                // tiles under a few px melt to grey
        f = f < 0.0 ? 0.0 : f > 1.0 ? 1.0 : f
        v = 0.47 + (v - 0.47) * f
        let rim = (1.0 - Math.sqrt(rr)) * R           // the boundary circle, anti-aliased
        if (rim < 1.0) v = v * rim + 0.75 * (1.0 - rim)
      } else {
        let rim = (Math.sqrt(rr) - 1.0) * R
        if (rim < 1.0) v = 0.75 * (1.0 - rim)
      }
      let g = (v * 255.0) | 0
      px[j] = (255 << 24) | (g << 16) | (g << 8) | g
      j++; ix++
    }
    iy++
  }
}
