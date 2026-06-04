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
// Repeated entries weight the common cadences (ii→V, V→I) higher. Indices match CHORDS.
const TRANS = [
  [3, 5, 1, 2, 4],     // I    → IV vi ii iii V   (tonic wanders)
  [4, 4, 6],           // ii   → V  V  viiø        (predominant → dominant)
  [5, 3, 1],           // iii  → vi IV ii
  [4, 4, 1, 0],        // IV   → V  V  ii I        (subdominant → dominant / plagal)
  [0, 0, 5],           // V    → I  I  vi          (resolve, or deceptive to vi)
  [1, 3, 4, 2],        // vi   → ii IV V  iii       (vi→ii starts a ii–V–I)
  [0, 2],              // viiø → I  iii
]

const NB = 24          // bars in the walk before it loops (× barLen = the loop length)

// Deterministic walk: start on I, follow the graph by a seeded LCG, and cap with a
// ii–V turnaround so the loop point resolves cleanly back to bar 0's tonic.
const walkChords = (seed) => {
  let s = (seed >>> 0) || 1
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296
  const idx = [0]
  let cur = 0
  while (idx.length < NB - 2) {
    const opts = TRANS[cur]
    cur = opts[(rnd() * opts.length) | 0]
    idx.push(cur)
  }
  idx.push(1, 4)       // … ii V | (loops to I)
  return idx.map(i => CHORDS[i])
}

const SEQ = walkChords(7)
const seqLit = '[' + SEQ.map(c => `[${c.join(', ')}]`).join(', ') + ']'

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
