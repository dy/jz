// Ulam spiral — primes on a square outward spiral, coloured by diagonal family.
// Integer 1 at center; the spiral walks right, up, left, down in runs 1,1,2,2,3,3,…
// Primes light up in 8 vivid hues — one per diagonal family. The "whoa": spontaneous
// diagonal streaks arising because quadratic polynomials of the form 4n²+bn+c land
// disproportionately many primes, so entire lattice-lines of the spiral glow.
//
// COLOR: 8 diagonal families (two directions × 4 phases) each get a distinct hue,
// making the crossing streaks instantly readable. Composites: deep teal background.
//
// Pan+zoom: cx, cy (world-cell units, 0,0 = spiral center), scale (pixels/cell),
// passed as f64 frame args. Sieve fixed at 8 000 003 — far beyond any canvas at 1×,
// so you can scroll deep and the diagonal lattice persists and sharpens into millions.
//
// resize(w,h) → Uint32Array; frame(t, cx, cy, scale)

let W = 0, H = 0, px
let isPrime                  // Uint8Array sieve: 1 = prime, 0 = composite

let SIEVE_N = 8000003

// ── HSL → 0xAABBGGRR (verified jz-safe) ──
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

// ── Spiral coordinate → integer n ──
// For cell (dx,dy) relative to spiral center, returns which integer n sits there.
// Shell k = max(|dx|,|dy|). Shell k holds n from (2k-1)²+1 to (2k+1)².
// Sides (checking bottom first so corner dx=k,dy=k lands on bottom not right):
//   bottom: dy=k,  dx from -k+1 to k     → positions 6k..8k-1
//   right:  dx=k,  dy from k-1 down to -k → positions 0..2k-1
//   top:    dy=-k, dx from k-1 down to -k → positions 2k..4k-1
//   left:   dx=-k, dy from -k+1 up to k-1 → positions 4k..6k-1
let spiralN = (dx, dy) => {
  let ax = dx, ay = dy
  if (ax < 0) ax = -ax
  if (ay < 0) ay = -ay
  let k = ax
  if (ay > k) k = ay
  if (k === 0) return 1
  let start = (2*k - 1) * (2*k - 1) + 1
  let pos = 0
  if (dy === k) {
    pos = 6*k + dx + k - 1
  } else if (dx === k) {
    pos = (k - 1) - dy
  } else if (dy === -k) {
    pos = 2*k + (k - 1) - dx
  } else {
    pos = 4*k + dy + k - 1
  }
  return start + pos
}

// ── Diagonal family (0..7) ──
// Two sets of diagonals cross the spiral at ±45°.
// All odd primes land on even-parity diagonals only (odd primes are odd, which maps to
// even residues in spiral coordinates). Within each set, further split by half-diagonal
// gives 4 families per direction = 8 total, each with roughly equal prime density.
//   sm = (dx - dy) >> 1  (always integer since dx-dy is even for odd primes)
//   sp = (dx + dy) >> 1
// Family = ((sm mod 4 + 4) mod 4) * 2 + ((sp mod 2 + 2) mod 2)  → 0..7
let diagFamily = (dx, dy) => {
  let sm = (dx - dy) >> 1
  let sp = (dx + dy) >> 1
  let smp4 = sm - 4 * Math.floor(sm * 0.25)    // sm mod 4, always ≥ 0
  let sp2  = sp - 2 * Math.floor(sp * 0.5)      // sp mod 2, always ≥ 0
  return smp4 * 2 + sp2
}

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)

  // Sieve of Eratosthenes — fixed large independent of canvas size
  isPrime = new Uint8Array(SIEVE_N)
  let i = 2
  while (i < SIEVE_N) { isPrime[i] = 1; i++ }
  let p = 2
  while (p * p < SIEVE_N) {
    if (isPrime[p]) {
      let m = p * p
      while (m < SIEVE_N) { isPrime[m] = 0; m += p }
    }
    p++
  }

  return px
}

// frame(t, cx, cy, scale)
//   cx, cy  — world-space center of view (spiral cell units; 0,0 = spiral center)
//   scale   — pixels per spiral cell (zoom level)
// Maps each canvas pixel → world cell → integer n → primality → color.
export let frame = (t, cx, cy, scale) => {
  let halfW = W * 0.5
  let halfH = H * 0.5
  let invScale = 1.0 / scale

  // Composite background color (deep teal)
  let bg = (255 << 24) | (38 << 16) | (32 << 8) | 22

  let py = 0
  while (py < H) {
    let ppx = 0
    while (ppx < W) {
      // pixel → world cell (round to nearest integer grid point)
      let wx = (ppx - halfW) * invScale + cx
      let wy = (py - halfH) * invScale + cy
      let dx = Math.floor(wx + 0.5) | 0
      let dy = Math.floor(wy + 0.5) | 0

      let n = spiralN(dx, dy)
      let col = bg
      if (n >= 0 && n < SIEVE_N) {
        if (n >= 2 && isPrime[n]) {
          // vivid prime — hue by diagonal family
          let fam = diagFamily(dx, dy)
          let hue = fam * 0.125       // 0, 0.125, 0.25, … 0.875 (8 evenly-spaced hues)
          col = hslColor(hue, 0.88, 0.68)
        }
        // else composite → leave bg
      } else {
        // outside sieve range — pure black
        col = (255 << 24)
      }
      px[py * W + ppx] = col
      ppx++
    }
    py++
  }
}
