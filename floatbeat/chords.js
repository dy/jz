// "After Hours" — a soft jazz-pad mood-setter. The chord progression is a random WALK
// over a functional-harmony graph (ii→V→I, deceptive V→vi, vi→ii, …), borrowed from the
// rfft demo. Here we BAKE the walk into a visible `seq` array at load time, so the floatbeat
// stays a pure `(t) => sample` formula — no per-sample state, the JS⇄jz toggle still applies,
// and you can read the harmonic journey right in the source. Reload for a fresh wander.

// pitch-class set masks of the 7 diatonic chords → harmonic distance (shared tones)
const PCS_MASK = [2196, 689, 2756, 657, 2596, 2197, 564]
const popcount = (x) => { let c = 0; while (x > 0) { x &= x - 1; c++ } return c }
const shared = (a, b) => popcount(PCS_MASK[a] & PCS_MASK[b])

// One step of the seeded walk: weighted by functional-harmony transitions, shared tones,
// and a recency penalty (avoid repeating a chord too soon). Returns the chord index at `bar`.
const chordAt = (bar, seed) => {
  let s = (seed >>> 0) || 1
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296
  const seen = [-99, -99, -99, -99, -99, -99, -99]
  let cur = 0; seen[0] = 0
  // transition graph: from each chord, [primary, ...alternates] with weights
  const NEXT = [
    [[3, 3], [5, 1], [4, 1]], [[4, 3], [0, 1]], [[5, 3], [1, 1]],
    [[6, 3], [4, 1], [0, 1]], [[0, 3], [5, 1]], [[1, 3], [3, 1]], [[2, 3], [0, 1]],
  ]
  for (let idx = 0; idx < bar; idx++) {
    const opts = NEXT[cur], nb = idx + 1, w = []
    let total = 0
    for (const [nx, wt] of opts) {
      const age = nb - seen[nx]
      const am = age <= 3 ? age * 0.05 : 1.0
      const ww = wt * am * (shared(cur, nx) - 1)
      w.push(ww); total += ww
    }
    let r = rnd() * total, pick = opts[0][0], acc = 0
    for (let i = 0; i < opts.length; i++) { acc += w[i]; if (r <= acc) { pick = opts[i][0]; break } }
    cur = pick; seen[cur] = nb
  }
  return cur
}

// Generate a baked chord-index sequence for `bars` bars from a random seed.
const genSeq = (seed, bars) => Array.from({ length: bars }, (_, i) => chordAt(i, seed))

// Produce a fresh, randomized "After Hours" formula body (a bare `(t) => sample`).
export const makeChordBody = () => {
  const seed = Math.floor(Math.random() * 1e6) || 1
  const seq = genSeq(seed, 48)              // 48 bars × 4 s ≈ 3.2 min before it loops
  return `(t) => {
  // After Hours — soft jazz pads wandering a functional-harmony graph (ii–V–I, deceptive…).
  // \`seq\` is the baked chord walk (indices into CH); reload the tune for a new wander.
  let TAU = 6.283185307179586
  let sr = 44100
  let T = t / sr
  let barLen = 4                                   // seconds per chord
  let fb = T / barLen
  let bar = fb | 0
  let ph = fb - bar                                // 0..1 within the bar
  let seq = [${seq.join(', ')}]
  let CH = [
    [0, 4, 7, 11, 14, 16],   // I    Cmaj9
    [2, 3, 7, 10, 14, 17],   // ii   Dm11
    [4, 3, 7, 10, 14, 17],   // iii  Em11
    [5, 4, 7, 11, 14, 16],   // IV   Fmaj9
    [7, 4, 7, 10, 14, 16],   // V    G9
    [9, 3, 7, 10, 14, 17],   // vi   Am11
    [11, 3, 6, 10, 15, 17]   // vii  Bm11b5
  ]
  let cA = CH[seq[bar % 48]]
  let cB = CH[seq[(bar + 1) % 48]]
  // smoothstep crossfade over the last 28% of the bar — gapless chord changes
  let xf = ph < 0.72 ? 0 : (ph - 0.72) / 0.28
  xf = xf * xf * (3 - 2 * xf)
  // detuned pad: each of 5 voices doubled +0.3% for a slow chorus shimmer
  let padA = 0
  let padB = 0
  for (let k = 1; k <= 5; k++) {
    let fa = 261.63 * Math.pow(2, ((cA[0] + cA[k]) % 12) / 12)
    padA += Math.sin(T * TAU * fa) + Math.sin(T * TAU * fa * 1.003)
    let fc = 261.63 * Math.pow(2, ((cB[0] + cB[k]) % 12) / 12)
    padB += Math.sin(T * TAU * fc) + Math.sin(T * TAU * fc * 1.003)
  }
  let pad = padA * (1 - xf) + padB * xf
  let ba = 65.41 * Math.pow(2, cA[0] / 12)
  let bc = 65.41 * Math.pow(2, cB[0] / 12)
  let bass = Math.sin(T * TAU * ba) * (1 - xf) + Math.sin(T * TAU * bc) * xf
  let breath = 0.72 + 0.28 * Math.sin(T * TAU * 0.05)   // slow swell, ~20 s
  return Math.tanh((pad * 0.042 + bass * 0.42) * breath)
}`
}
