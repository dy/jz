// Slime mold (Physarum) — TWO competing colonies, each growing its own transport network over
// its own pheromone trail map. Every agent senses OWN colony's trail MINUS k·OTHER colony's
// trail at three sensors (ahead, ahead-left, ahead-right) — colonies are drawn to their own
// trail and steer away from the rival's, so instead of merging into one network the two
// contest territory: borders between them writhe as each colony's growth pushes back the
// other's. Colonies differ slightly in sensor angle/speed so their networks have a different
// character (A: longer, smoother strands; B: tighter, twitchier mesh). Motor parameters follow
// Jones's Physarum model (Artificial Life 16(2), 2010: sensor angle 22.5°, turn 45°, sensor offset
// 9, step 1), including its crowding rule — one agent per cell: an agent blocked by another turns
// to a random heading and deposits nothing, which is what keeps the network fine instead of
// collapsing every agent into a few thick tubes; the trail diffuses only part-way toward its 3×3 mean each step, so strands stay the
// fine veins of a real plasmodium instead of blurring into blobs, and the render maps trail strength
// through 1 − e^(−k·v), so every vein reads in graded light. resize(w,h) → Uint32Array; frame()
// steps both colonies' agents + both trail maps and renders.

let W = 0, H = 0, px
let axA, ayA, ahA          // colony A agent x, y, heading
let axB, ayB, ahB          // colony B agent x, y, heading
let naA = 0, naB = 0
let taA, tbA                // colony A trail map ping-pong
let taB, tbB                // colony B trail map ping-pong
let flip = 0                 // shared — both trail maps march together
let occ                      // Uint8Array — agents per cell (the crowding rule allows one)

// Per-colony sensor/motor parameters — B senses wider and turns harder for a different
// network character (tighter, more tangled mesh vs A's longer, smoother strands).
let SA_A = 0.3927, SD_A = 9.0, TA_A = 0.7854, SP_A = 1.0     // 22.5°, 9, 45°, 1 — Jones's canonical set
let SA_B = 0.52, SD_B = 7.0, TA_B = 0.6, SP_B = 1.1
let REPEL = 1.2               // "sense own − REPEL·other" — territorial pressure
let DECAY = 0.93
let DIFF = 0.35               // how far each step diffuses toward the 3×3 mean (1 = a full box blur)

export let resize = (w, h) => {
  W = w; H = h
  let n = w * h
  taA = new Float64Array(n); tbA = new Float64Array(n)
  taB = new Float64Array(n); tbB = new Float64Array(n)
  px = new Uint32Array(n)
  occ = new Uint8Array(n)
  let na = (n * 0.14) | 0          // ~14% of cells are agents, split across both colonies
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
    let x = cx + Math.cos(ang) * r, y = cy + Math.sin(ang) * r
    if (x < 0.0) x += W; else if (x >= W) x -= W
    if (y < 0.0) y += H; else if (y >= H) y -= H
    ax[a] = x; ay[a] = y
    ah[a] = ang
    let c = (y | 0) * W + (x | 0)
    if (occ[c] < 255) occ[c] = occ[c] + 1
    a++
  }
}

// Fresh soup of BOTH colonies: opposite sides of the field so they start apart and grow
// toward each other (and around the torus) — territory to contest from the first frame.
export let seed = () => {
  let n = W * H, i = 0
  while (i < n) { taA[i] = 0.0; tbA[i] = 0.0; taB[i] = 0.0; tbB[i] = 0.0; occ[i] = 0; i++ }
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
    let c0 = (y | 0) * W + (x | 0), c = (ny | 0) * W + (nx | 0)
    if (c !== c0 && occ[c] > 0) {
      ah[a] = Math.random() * 6.283185307179586      // blocked: turn anywhere, deposit nothing
    } else {
      if (c !== c0) { occ[c0] = occ[c0] - 1; occ[c] = occ[c] + 1 }
      ax[a] = nx; ay[a] = ny; ah[a] = h
      own[c] = own[c] + 0.3
    }
    a++
  }
}

// Partial diffusion toward the 3×3 mean + decay, src → dst (toroidal wrap). Shared by both colonies.
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
      dst[rc + x] = (src[rc + x] * (1.0 - DIFF) + s * 0.11111111 * DIFF) * DECAY
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

  // ---- render: monochrome — colony A in white light, colony B a step dimmer, so the two networks
  // stay legible without colour; each through 1 − e^(−k·v), so veins grade from faint to bright ----
  let n = W * H, i = 0
  while (i < n) {
    let va = 1.0 - Math.exp(-dstA[i] * 0.9)
    let vb = 1.0 - Math.exp(-dstB[i] * 0.9)
    let v = va * 250.0 + vb * 150.0
    if (v > 255.0) v = 255.0
    let vi = v | 0
    px[i] = (255 << 24) | (vi << 16) | (vi << 8) | vi
    i++
  }
}
