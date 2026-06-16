// 2D Ising model — classical statistical mechanics on a square lattice.
// Each site holds a spin s∈{+1,-1}. The Metropolis algorithm flips spins
// probabilistically: favorable flips (ΔE≤0) are always accepted; unfavorable
// flips (ΔE>0) are accepted with probability exp(-ΔE/T). The only possible
// positive ΔE values are 4 and 8 (from the ±1 neighbor sum), so exp(-4/T)
// and exp(-8/T) are precomputed once per frame call.
//
// At the critical temperature Tc≈2.269 the system undergoes a phase transition:
// below Tc, large ordered ferromagnetic domains form; above Tc, disorder wins.
// Sweeping T over time crosses this boundary visibly — islands of order melt and freeze.
//
// resize(w,h) → Uint32Array; frame(t, T) runs 3 Metropolis sweeps and renders.
// Spin grid is Int32Array. No module-level floats that persist — all persistent
// state is integer, so no i32-narrowing trap.

let W = 0, H = 0, px
let spin   // Int32Array, values +1 or -1

export let resize = (w, h) => {
  W = w; H = h
  spin = new Int32Array(w * h)
  px = new Uint32Array(w * h)
  init()
  return px
}

// Random ±1 initialization
export let init = () => {
  let n = W * H, i = 0
  while (i < n) {
    spin[i] = Math.random() < 0.5 ? 1 : -1
    i++
  }
}

// One full Metropolis sweep at temperature T
let sweep = (T) => {
  let w = W, h = H
  let e4 = Math.exp(-4.0 / T)
  let e8 = Math.exp(-8.0 / T)
  let n = w * h, i = 0
  while (i < n) {
    let x = i % w
    let y = (i / w) | 0
    let up    = y === 0     ? (h - 1) * w + x : (y - 1) * w + x
    let down  = y === h - 1 ? x               : (y + 1) * w + x
    let left  = x === 0     ? y * w + w - 1   : y * w + x - 1
    let right = x === w - 1 ? y * w           : y * w + x + 1
    let s = spin[i]
    let nb = spin[up] + spin[down] + spin[left] + spin[right]
    let dE = 2 * s * nb
    if (dE <= 0) {
      spin[i] = -s
    } else if (dE === 4) {
      if (Math.random() < e4) spin[i] = -s
    } else {
      // dE === 8
      if (Math.random() < e8) spin[i] = -s
    }
    i++
  }
}

export let frame = (t, T) => {
  // 3 sweeps per frame for visible evolution
  sweep(T)
  sweep(T)
  sweep(T)

  // Render: +1 spin → warm white, -1 spin → dark cool
  let n = W * H, i = 0
  while (i < n) {
    let s = spin[i]
    if (s > 0) {
      // warm white: slightly warm tint
      px[i] = (255 << 24) | (230 << 16) | (240 << 8) | 255
    } else {
      // dark cool: deep blue-black
      px[i] = (255 << 24) | (40 << 16) | (20 << 8) | 10
    }
    i++
  }
}
