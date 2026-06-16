// Buddhabrot — density histogram of complex trajectories that escape the Mandelbrot set.
// Unlike Mandelbrot (color = escape time for THIS pixel's c), Buddhabrot counts how many
// trajectories PASS THROUGH each pixel. The result accumulates across many frames into a
// luminous nebula. Call clear() to restart.
let W = 0, H = 0, px, dens
let MAXIT = 200
// trajectory scratch: store (x,y) pairs for up to MAXIT steps
let traj  // Float64Array of length 2*MAXIT

export let resize = (w, h) => {
  W = w; H = h
  dens = new Uint32Array(w * h)
  px = new Uint32Array(w * h)
  traj = new Float64Array(400)  // fixed size: 2*200
  return px
}

export let init = () => {
  let i = 0, n = W * H
  while (i < n) { dens[i] = 0; i++ }
}

export let clear = () => {
  let i = 0, n = W * H
  while (i < n) { dens[i] = 0; i++ }
}

export let frame = (t) => {
  let samples = 30000
  let s = 0
  while (s < samples) {
    // random point in c-plane (bounding box of Mandelbrot)
    let cx = Math.random() * 3.0 - 2.0   // [-2.0, 1.0]
    let cy = Math.random() * 3.0 - 1.5   // [-1.5, 1.5]
    // iterate z = z^2 + c, storing trajectory
    let x = 0.0, y = 0.0
    let it = 0
    // store trajectory in scratch
    while (it < MAXIT) {
      let nx = x * x - y * y + cx
      let ny = 2.0 * x * y + cy
      x = nx; y = ny
      traj[it * 2] = x
      traj[it * 2 + 1] = y
      if (x * x + y * y > 4.0) break
      it++
    }
    // only plot escaped trajectories
    if (it < MAXIT) {
      // replay trajectory up to escape
      let k = 0
      while (k < it) {
        let tx = traj[k * 2]
        let ty = traj[k * 2 + 1]
        // map to pixel coords: x in [-2,1], y in [-1.5,1.5]
        let ix = ((tx + 2.0) / 3.0 * W) | 0
        let iy = ((ty + 1.5) / 3.0 * H) | 0
        if (ix >= 0 && ix < W && iy >= 0 && iy < H) {
          let idx = iy * W + ix
          dens[idx] = dens[idx] + 1
        }
        // mirror point (symmetric about real axis)
        let iym = ((-ty + 1.5) / 3.0 * H) | 0
        if (ix >= 0 && ix < W && iym >= 0 && iym < H) {
          let idxm = iym * W + ix
          dens[idxm] = dens[idxm] + 1
        }
        k++
      }
    }
    s++
  }

  // tone-map density → pixels (warm nebula palette)
  let i = 0, n = W * H
  while (i < n) {
    let d = dens[i]
    let r = 0, g = 0, b = 0
    if (d > 0) {
      let v = Math.log(d + 1.0) * 45.0
      if (v > 255.0) v = 255.0
      r = (v * 1.0) | 0
      g = (Math.max(0.0, v - 80.0) * 1.5) | 0
      b = (Math.max(0.0, v - 150.0) * 3.0) | 0
      if (r > 255) r = 255
      if (g > 255) g = 255
      if (b > 255) b = 255
    }
    px[i] = (255 << 24) | (b << 16) | (g << 8) | r
    i++
  }
}
