// Slime mold (Physarum) — TWO competing colonies, each growing its own transport network over
// its own pheromone trail map. Every agent senses OWN colony's trail MINUS k·OTHER colony's
// trail at three sensors (ahead, ahead-left, ahead-right) — colonies are drawn to their own
// trail and steer away from the rival's, so instead of merging into one network the two
// contest territory: borders between them writhe as each colony's growth pushes back the
// other's. Colonies differ slightly in sensor angle/speed so their networks have a different
// character (A: longer, smoother strands; B: tighter, twitchier mesh). resize(w,h) →
// Uint32Array; frame() steps both colonies' agents + both trail maps and renders.

let W = 0, H = 0, px
let axA, ayA, ahA          // colony A agent x, y, heading
let axB, ayB, ahB          // colony B agent x, y, heading
let naA = 0, naB = 0
let taA, tbA                // colony A trail map ping-pong
let taB, tbB                // colony B trail map ping-pong
let flip = 0                 // shared — both trail maps march together

// Per-colony sensor/motor parameters — B senses wider and turns harder for a different
// network character (tighter, more tangled mesh vs A's longer, smoother strands).
let SA_A = 0.5, SD_A = 9.0, TA_A = 0.4, SP_A = 1.0
let SA_B = 0.65, SD_B = 7.5, TA_B = 0.5, SP_B = 1.15
let REPEL = 2.0               // "sense own − REPEL·other" — territorial pressure
let DECAY = 0.90

export let resize = (w, h) => {
  W = w; H = h
  let n = w * h
  taA = new Float64Array(n); tbA = new Float64Array(n)
  taB = new Float64Array(n); tbB = new Float64Array(n)
  px = new Uint32Array(n)
  let na = (n * 0.10) | 0          // ~10% of cells are agents, split across both colonies
  naA = na >> 1
  naB = na - naA
  axA = new Float64Array(naA); ayA = new Float64Array(naA); ahA = new Float64Array(naA)
  axB = new Float64Array(naB); ayB = new Float64Array(naB); ahB = new Float64Array(naB)
  flip = 0
  return px
}

// Scatter one colony's agents into a disc, headings outward — an expanding colony.
let scatterColony = (ax, ay, ah, na, cx, cy, rad) => {
  let a = 0
  while (a < na) {
    let ang = Math.random() * 6.283185307179586
    let r = Math.sqrt(Math.random()) * rad
    ax[a] = cx + Math.cos(ang) * r
    ay[a] = cy + Math.sin(ang) * r
    ah[a] = ang
    a++
  }
}

// Fresh soup of BOTH colonies: opposite sides of the field so they start apart and grow
// toward each other (and around the torus) — territory to contest from the first frame.
export let seed = () => {
  let n = W * H, i = 0
  while (i < n) { taA[i] = 0.0; tbA[i] = 0.0; taB[i] = 0.0; tbB[i] = 0.0; i++ }
  let cx = W * 0.5, cy = H * 0.5, rad = (W < H ? W : H) * 0.22
  let ox = (W < H ? W : H) * 0.18
  scatterColony(axA, ayA, ahA, naA, cx - ox, cy, rad)
  scatterColony(axB, ayB, ahB, naB, cx + ox, cy, rad)
  flip = 0
}

// Drag deposits a blob of trail BOTH colonies are drawn toward — an instant contested prize
// (into all four buffers so it shows regardless of which half is currently "read").
export let poke = (cx, cy, r) => {
  let x0 = cx - r | 0, x1 = cx + r | 0, y0 = cy - r | 0, y1 = cy + r | 0
  if (x0 < 0) x0 = 0
  if (y0 < 0) y0 = 0
  if (x1 > W - 1) x1 = W - 1
  if (y1 > H - 1) y1 = H - 1
  let r2 = r * r
  let y = y0
  while (y <= y1) {
    let dy = y - cy, row = y * W, x = x0
    while (x <= x1) {
      let dx = x - cx
      if (dx * dx + dy * dy <= r2) {
        taA[row + x] = 1.6; tbA[row + x] = 1.6
        taB[row + x] = 1.6; tbB[row + x] = 1.6
      }
      x++
    }
    y++
  }
}

// Sample a trail map at (fx,fy) with toroidal wrap.
let sample = (src, fx, fy) => {
  let xi = fx | 0, yi = fy | 0
  if (xi < 0) xi += W; else if (xi >= W) xi -= W
  if (yi < 0) yi += H; else if (yi >= H) yi -= H
  return src[yi * W + xi]
}

// One colony's agent step: sense OWN trail minus REPEL·OTHER trail at 3 sensors, steer toward
// the strongest, move, wrap, deposit into own. Shared by both colonies — only the array
// bindings and per-colony sensor/motor constants differ (mirrors sample()'s param-array style).
let stepColony = (own, other, ax, ay, ah, na, sang, sdist, tstep, spd) => {
  let a = 0
  while (a < na) {
    let h = ah[a], x = ax[a], y = ay[a]
    let ffx = x + Math.cos(h) * sdist, ffy = y + Math.sin(h) * sdist
    let lfx = x + Math.cos(h - sang) * sdist, lfy = y + Math.sin(h - sang) * sdist
    let rfx = x + Math.cos(h + sang) * sdist, rfy = y + Math.sin(h + sang) * sdist
    let f = sample(own, ffx, ffy) - REPEL * sample(other, ffx, ffy)
    let l = sample(own, lfx, lfy) - REPEL * sample(other, lfx, lfy)
    let r = sample(own, rfx, rfy) - REPEL * sample(other, rfx, rfy)
    if (f >= l && f >= r) { /* keep heading */ }
    else if (l > r) h = h - tstep
    else if (r > l) h = h + tstep
    else h = h + (Math.random() - 0.5) * tstep * 2.0
    let nx = x + Math.cos(h) * spd
    let ny = y + Math.sin(h) * spd
    if (nx < 0.0) nx += W; else if (nx >= W) nx -= W
    if (ny < 0.0) ny += H; else if (ny >= H) ny -= H
    ax[a] = nx; ay[a] = ny; ah[a] = h
    let c = (ny | 0) * W + (nx | 0)
    own[c] = own[c] + 0.6
    a++
  }
}

// 3×3 box blur + decay, src → dst (toroidal wrap). Shared by both colonies' trail maps.
let blurDecay = (src, dst) => {
  let w = W, h = H, y = 0
  while (y < h) {
    let yn = y > 0 ? y - 1 : h - 1
    let ys = y < h - 1 ? y + 1 : 0
    let rc = y * w, rn = yn * w, rs = ys * w
    let x = 0
    while (x < w) {
      let xw = x > 0 ? x - 1 : w - 1
      let xe = x < w - 1 ? x + 1 : 0
      let s = src[rn + xw] + src[rn + x] + src[rn + xe]
            + src[rc + xw] + src[rc + x] + src[rc + xe]
            + src[rs + xw] + src[rs + x] + src[rs + xe]
      dst[rc + x] = (s * 0.11111111) * DECAY
      x++
    }
    y++
  }
}

export let frame = (t) => {
  let srcA = flip === 0 ? taA : tbA
  let dstA = flip === 0 ? tbA : taA
  let srcB = flip === 0 ? taB : tbB
  let dstB = flip === 0 ? tbB : taB

  // ---- agents: sense (own − REPEL·other) → steer → move → deposit into own's src ----
  stepColony(srcA, srcB, axA, ayA, ahA, naA, SA_A, SD_A, TA_A, SP_A)
  stepColony(srcB, srcA, axB, ayB, ahB, naB, SA_B, SD_B, TA_B, SP_B)

  // ---- trail maps: 3×3 blur (diffuse) + decay, independently per colony ----
  blurDecay(srcA, dstA)
  blurDecay(srcB, dstB)
  flip = 1 - flip

  // ---- render: colony A bright/white, colony B dimmer/cool-tinted; contested zones (both
  // present) get an extra glow so borders read as a distinct shimmering seam ----
  let n = W * H, i = 0
  while (i < n) {
    let va = dstA[i] * 1.6
    if (va > 1.0) va = 1.0
    let vb = dstB[i] * 1.6
    if (vb > 1.0) vb = 1.0
    let ov = va < vb ? va : vb
    let r = va * 255.0 + vb * 110.0 + ov * 70.0
    let g = va * 255.0 + vb * 165.0 + ov * 70.0
    let b = va * 255.0 + vb * 220.0 + ov * 100.0
    if (r > 255.0) r = 255.0
    if (g > 255.0) g = 255.0
    if (b > 255.0) b = 255.0
    px[i] = (255 << 24) | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0)
    i++
  }
}
