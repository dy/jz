// Ulam spiral — prime numbers arranged on a square spiral reveal surprising diagonal streaks.
// Integer n=1 sits at center; the spiral walks outward in runs of 1,1,2,2,3,3,… steps,
// turning left each run. Every n that is prime lights up white. The unexpected diagonals
// emerge because quadratic polynomials land many primes. Progressive reveal: frame(t, speed)
// uncovers numbers up to N(t)=floor(t*speed) so you watch the structure crystallize.
//
// resize(w,h) → Uint32Array; frame(t, speed) renders incrementally.

let W = 0, H = 0, px
let isComp                       // Uint8Array sieve

// direction vectors: right,up,left,down
let DX = new Int32Array([1, 0, -1, 0])
let DY = new Int32Array([0, -1, 0, 1])

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)

  // fill background opaque black
  let i = 0
  while (i < w * h) { px[i] = (255 << 24); i++ }

  // sieve of Eratosthenes up to w*h+1
  let N = w * h + 2
  isComp = new Uint8Array(N)
  isComp[0] = 1; isComp[1] = 1
  let p = 2
  while (p * p < N) {
    if (!isComp[p]) {
      let m = p * p
      while (m < N) { isComp[m] = 1; m += p }
    }
    p++
  }
  return px
}

export let frame = (t, speed) => {
  let total = W * H
  let target = (t * speed) | 0
  if (target < 1) target = 1
  if (target > total) target = total

  // Re-walk the WHOLE spiral up to `target` every frame (like mandelbrot recomputes every pixel),
  // instead of the old incremental ~50-cells/frame reveal. Two wins: (1) the ms readout reflects
  // real per-frame work — O(target) — so it's a fair JS-vs-jz race instead of pinned at ≈0; and
  // (2) a far higher reveal rate fills the spiral in seconds. The sieve is precomputed in resize.
  let i = 0
  while (i < total) { px[i] = (255 << 24); i++ }   // clear to black

  let ax = W >> 1, ay = H >> 1
  let dir = 0, steps = 0, runLen = 1, half = 0
  let n = 1
  while (n <= target) {
    // paint this cell — prime → white (background already cleared to black)
    if (ax >= 0 && ax < W && ay >= 0 && ay < H) {
      if (n >= 2 && !isComp[n]) px[ay * W + ax] = (255 << 24) | (255 << 16) | (255 << 8) | 255
    }

    // advance spiral one step: move, then turn left after each run; lengthen every two runs
    ax = ax + DX[dir]
    ay = ay + DY[dir]
    steps++
    if (steps >= runLen) {
      steps = 0
      dir = (dir + 1) & 3
      if (half == 0) { half = 1 } else { half = 0; runLen++ }
    }
    n++
  }
}
