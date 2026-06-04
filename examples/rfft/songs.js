// The rfft demo's floatbeat voice — one evolving tune. A plain JS body
// (jz-compatible subset) with TAU inlined, so the very same source compiles to
// wasm (jz) and runs under V8 (new Function). The chord progression is not a fixed
// loop: it's a random WALK over a jazz chord-transition graph (functional harmony —
// ii→V→I, V→vi deceptive, vi→ii, etc.), baked once at build time into a long,
// non-repeating sequence so the same chord resolves different ways each time it recurs.

export const TAU = 6.283185307179586

// ── chord vocabulary — diatonic 7 of C major, extended jazz voicings ───────────
// [root, 5 voicing tones as semitones above the root]: 3·5·7·9 plus one upper-structure
// extension — 13 on the major/dominant chords, 11 on the minors, ♯11 (Lydian) on IV — each
// picked to sit above the chord without the natural-11-vs-3rd clash.
const CHORDS = [
  [0, 4, 7, 11, 14, 21],   // I    Cmaj13
  [2, 3, 7, 10, 14, 17],   // ii   Dm11
  [4, 3, 7, 10, 14, 17],   // iii  Em11
  [5, 4, 7, 11, 14, 18],   // IV   Fmaj9♯11 (Lydian)
  [7, 4, 7, 10, 14, 21],   // V    G13   (dominant)
  [9, 3, 7, 10, 14, 17],   // vi   Am11
  [11, 3, 6, 10, 13, 17],  // viiø Bm11♭5 (half-diminished)
]

// ── transition graph — where each chord likes to go (jazz functional harmony) ──
// [nextChord, baseWeight]. Base weights bias the common cadences (ii→V, V→I). Indices
// match CHORDS.
const TRANS = [
  [[3, 2], [5, 2], [1, 1], [2, 1], [4, 1]],   // I    → IV vi (·2) ii iii V
  [[4, 3], [6, 1]],                           // ii   → V (·3) viiø   (predominant → dominant)
  [[5, 2], [3, 1], [1, 1]],                   // iii  → vi (·2) IV ii
  [[4, 3], [1, 1], [0, 1]],                   // IV   → V (·3) ii I
  [[0, 2], [5, 2]],                           // V    → I / vi  (resolve or deceptive, equally)
  [[1, 2], [3, 1], [4, 1], [2, 1]],           // vi   → ii (·2) IV V iii  (vi→ii starts a ii–V–I)
  [[0, 1], [2, 1]],                           // viiø → I iii
]

const NB = 24          // bars in the walk before it loops (× barLen = the loop length)

// Deterministic walk over the graph, but each step is weighted by RECENCY as well as the
// base bias: a candidate's weight is baseWeight × (bars since it was last heard)², so a
// just-used chord (especially the tonic) is strongly suppressed until the others have had a
// turn — serialism-flavoured "always reach for something new", inside the legal jazz moves.
// Capped with a ii–V turnaround so the loop point resolves back to bar 0's tonic.
const walkIdx = (seed) => {
  let s = (seed >>> 0) || 1
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296
  const idx = [0]
  const lastSeen = [0, -99, -99, -99, -99, -99, -99]   // bar each chord last sounded
  let cur = 0
  while (idx.length < NB - 2) {
    const bar = idx.length, opts = TRANS[cur]
    let total = 0
    const w = opts.map(([o, bw]) => { const age = bar - lastSeen[o]; const ww = bw * age * age; total += ww; return ww })
    let r = rnd() * total, cho = opts[0][0]
    for (let i = 0; i < opts.length; i++) { r -= w[i]; if (r <= 0) { cho = opts[i][0]; break } }
    cur = cho; lastSeen[cur] = bar; idx.push(cur)
  }
  idx.push(1, 4)       // … ii V | (loops to I)
  return idx
}

const SEQ_IDX = walkIdx(7)
const SEQ = SEQ_IDX.map(i => CHORDS[i])
const seqLit = '[' + SEQ.map(c => `[${c.join(', ')}]`).join(', ') + ']'

// Readable chord names for the live label (in C; the demo plays seed 0 → key C).
const CHORD_NAMES = ['Cmaj13', 'Dm11', 'Em11', 'Fmaj9♯11', 'G13', 'Am11', 'Bm11♭5']

export const songs = [
  { name: 'after hours', body:
`(t, sd) => {
  // A warm detuned pad walking a ${NB}-bar jazz chord graph (baked above), each chord
  // crossfading into the next so nothing clicks. Voicings are rootless and extended
  // (3·5·7·9 + a 13/11/♯11); a soft sub traces the root. The seed transposes the key and
  // rotates the entry point, so a different seed drops you elsewhere in the same walk.
  const seq = ${seqLit}
  const NB = ${NB}
  const barLen = 4
  const fb = t / barLen, bar = fb | 0, ph = fb - bar
  const key = (sd | 0) % 12, rot = ((sd | 0) * 5) % NB
  const A = seq[(bar + rot) % NB], B = seq[(bar + 1 + rot) % NB]
  // crossfade the last 28% of each bar into the next chord (smoothstep — no click)
  let xf = ph < 0.72 ? 0 : (ph - 0.72) / 0.28
  xf = xf * xf * (3 - 2 * xf)
  let padA = 0, padB = 0
  for (let k = 1; k <= 5; k++) {
    const fa = 130.81 * 2 ** ((key + A[0] + A[k]) / 12)   // C3 reference
    padA += Math.sin(t*${TAU}*fa) + Math.sin(t*${TAU}*fa*1.003)   // two slightly detuned sines = warmth
    const fc = 130.81 * 2 ** ((key + B[0] + B[k]) / 12)
    padB += Math.sin(t*${TAU}*fc) + Math.sin(t*${TAU}*fc*1.003)
  }
  const pad = padA * (1 - xf) + padB * xf
  const ba = 65.41 * 2 ** ((key + A[0]) / 12), bc = 65.41 * 2 ** ((key + B[0]) / 12)   // C2 sub
  const bass = Math.sin(t*${TAU}*ba) * (1 - xf) + Math.sin(t*${TAU}*bc) * xf
  const breath = 0.72 + 0.28 * Math.sin(t*${TAU}*0.05)   // slow swell, ~20 s
  return Math.tanh((pad * 0.042 + bass * 0.42) * breath)
}` },
]

/** Bars in the chord walk — the loop spans `barsInWalk * barLen` seconds. */
export const barsInWalk = NB
/** Seconds per chord/bar (matches the floatbeat body). */
export const barLen = 4
/** The walked chord-index sequence + readable names, for the live current-chord label. */
export const chordSequence = SEQ_IDX
export const chordNames = CHORD_NAMES

/** Source shown in the demo code panel (readable TAU name). */
export const songDisplaySrc = (song) =>
  song.body.replaceAll(String(TAU), 'TAU')

/** jz/JS callable body — already has TAU numeric. */
export const songBeatSrc = (song) => song.body

/** Compile a floatbeat module: beat(t, sd) + fill(out, len, sr, off, sd). */
export const floatbeatModuleSrc = (song) => {
  const body = songBeatSrc(song)
  return `export let beat = ${body}
export let fill = (out, len, sr, off, sd) => { let i = 0; while (i < len) { out[i] = beat(off + i / sr, sd); i++ } }`
}

/** Filesystem slug for prebuilt beat wasm (`beats/after-hours.wasm`). */
export const songSlug = (song) =>
  song.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
