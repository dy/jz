// Gaussian primes — primes in the complex integers ℤ[i]. A Gaussian integer a+bi is prime
// iff: |a|=0 and |b| is a rational prime ≡3 mod 4 (or vice versa), or a≠0,b≠0 and
// a²+b² is a rational prime. Plotting them on the integer lattice reveals 8-fold symmetry
// (the Gaussian units ±1,±i act as symmetry group). The constellation is simultaneously
// sparse and rich — a visual proof that primality extends into 2D.
//
// Drag to pan, scroll to zoom (the lattice spacing scales).
// resize(w,h) → Uint32Array; frame(t, panX, panY, zoom) renders.

let W = 0, H = 0, px
let isComp          // Uint8Array — rational prime sieve
let SIEVE_N = 0
// floating-point pan state
let st = new Float64Array(4)  // [panX, panY, _, _]

let sieve = (n) => {
  let s = new Uint8Array(n + 1)
  s[0] = 1; s[1] = 1
  let p = 2
  while (p * p <= n) {
    if (!s[p]) {
      let m = p * p
      while (m <= n) { s[m] = 1; m += p }
    }
    p++
  }
  return s
}

let isPrime = (n) => {
  if (n < 2) return 0
  if (n >= SIEVE_N) return 0
  return isComp[n] ? 0 : 1
}

let isGaussPrime = (a, b) => {
  let aa = a < 0 ? -a : a
  let bb = b < 0 ? -b : b
  if (aa == 0) {
    // purely imaginary: |b| must be rational prime ≡ 3 mod 4
    return (isPrime(bb) && (bb & 3) == 3) ? 1 : 0
  }
  if (bb == 0) {
    // purely real: |a| must be rational prime ≡ 3 mod 4
    return (isPrime(aa) && (aa & 3) == 3) ? 1 : 0
  }
  // general: a²+b² must be rational prime
  let norm = aa * aa + bb * bb
  return isPrime(norm) ? 1 : 0
}

// Draw a filled disk of radius r at (cx,cy) with color c
let disk = (cx, cy, rr, color) => {
  let x0 = (cx - rr) | 0, x1 = (cx + rr) | 0
  let y0 = (cy - rr) | 0, y1 = (cy + rr) | 0
  if (x0 < 0) x0 = 0; if (x1 >= W) x1 = W - 1
  if (y0 < 0) y0 = 0; if (y1 >= H) y1 = H - 1
  let r2 = rr * rr
  let y = y0
  while (y <= y1) {
    let dy = y - cy
    let x = x0
    while (x <= x1) {
      let dx = x - cx
      if (dx * dx + dy * dy <= r2) px[y * W + x] = color
      x++
    }
    y++
  }
}

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  SIEVE_N = w * w + h * h + 4   // covers all norms visible
  isComp = sieve(SIEVE_N)
  st[0] = 0.0; st[1] = 0.0
  return px
}

export let frame = (t, panX, panY, zoom) => {
  // store pan in Float64Array so it stays fractional
  st[0] = panX; st[1] = panY

  // lattice spacing in px; scroll scales the zoom (≈6px at zoom 1)
  let z = zoom > 0.0 ? zoom : 1.0
  let step = 6.0 * z

  // clear black
  let total = W * H
  let i = 0
  while (i < total) { px[i] = (255 << 24); i++ }

  let cx = W * 0.5 + st[0]
  let cy = H * 0.5 + st[1]
  let diskR = step * 0.26; if (diskR < 1.2) diskR = 1.2   // dots scale with the spacing

  // range of lattice points visible
  let aMin = ((-cx) / step) | 0
  let aMax = ((W - cx) / step) | 0
  let bMin = ((-cy) / step) | 0
  let bMax = ((H - cy) / step) | 0
  // pad by 2
  aMin -= 2; aMax += 2; bMin -= 2; bMax += 2

  let a = aMin
  while (a <= aMax) {
    let b = bMin
    while (b <= bMax) {
      if (isGaussPrime(a, b)) {
        let px2 = (cx + a * step) | 0
        let py2 = (cy + b * step) | 0
        // solid white dot on black
        let color = (255 << 24) | (255 << 16) | (255 << 8) | 255
        disk(px2, py2, diskR, color)
      }
      b++
    }
    a++
  }
}
