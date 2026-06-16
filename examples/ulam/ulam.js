// Ulam spiral — prime numbers arranged on a square spiral reveal surprising diagonal streaks.
// Integer n=1 sits at center; the spiral walks outward in runs of 1,1,2,2,3,3,… steps,
// turning left each run. Every n that is prime lights up white. The unexpected diagonals
// emerge because quadratic polynomials land many primes. Progressive reveal: frame(t, speed)
// uncovers numbers up to N(t)=floor(t*speed) so you watch the structure crystallize.
//
// resize(w,h) → Uint32Array; frame(t, speed) renders incrementally.

let W = 0, H = 0, px
// spiral cursor state in Int32Array: [ax, ay, dir, run, runLen, remaining, n]
// dir: 0=right,1=up,2=left,3=down
let st = new Int32Array(8)       // [ax,ay,dir,run,runLen,remaining,n, _pad]
let revealed = 0                 // how many numbers have been placed so far
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

  // reset spiral: center at (cx,cy), n=1, dir=right, run state
  let cx = (w >> 1), cy = (h >> 1)
  st[0] = cx; st[1] = cy   // ax, ay
  st[2] = 0                // dir (right)
  st[3] = 0                // steps taken in current run
  st[4] = 1                // runLen (current run length)
  st[5] = 0                // which half of pair (0 or 1)
  st[6] = 1                // n (number at current position)

  revealed = 0
  return px
}

export let frame = (t, speed) => {
  let spd = speed | 0
  let target = (t * spd) | 0
  if (target < 1) target = 1
  let total = W * H
  if (target > total) target = total

  // place all numbers from revealed+1 up to target
  while (revealed < target) {
    let ax = st[0], ay = st[1]
    let n = st[6]

    // paint this cell
    if (ax >= 0 && ax < W && ay >= 0 && ay < H) {
      let idx = ay * W + ax
      if (n >= 2 && !isComp[n]) {
        // prime — color faintly by n value for depth, white-hot at core
        let hue = (n * 7) & 255
        let r = 180 + ((hue * 3) & 75)
        let g = 180 + ((hue * 5) & 75)
        let b = 200 + ((hue * 2) & 55)
        if (r > 255) r = 255
        if (g > 255) g = 255
        if (b > 255) b = 255
        px[idx] = (255 << 24) | (b << 16) | (g << 8) | r
      } else {
        px[idx] = (255 << 24)  // opaque black (composite)
      }
    }

    revealed++
    if (revealed >= target) break

    // advance spiral
    let dir = st[2]
    let steps = st[3]
    let runLen = st[4]
    let half = st[5]

    st[0] = ax + DX[dir]
    st[1] = ay + DY[dir]
    steps++

    if (steps >= runLen) {
      // end of this run — turn left
      steps = 0
      dir = (dir + 1) & 3
      // after 2 runs of same length, increase length
      if (half == 0) {
        half = 1
      } else {
        half = 0
        runLen++
      }
      st[2] = dir; st[3] = steps; st[4] = runLen; st[5] = half
    } else {
      st[3] = steps
    }

    st[6] = n + 1
  }
}
