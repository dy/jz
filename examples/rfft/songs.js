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

// The pad plays a ROOTLESS CLOSE voicing — the 5 upper tones folded into one octave (pitch
// class) over the low root — so two chords' shared pitch-classes are literally HELD notes (same
// frequency), not just shared classes in different octaves. shared() counts those held notes;
// the walk favours transitions that hold more of them (smoother voice-leading).
const PCS = CHORDS.map(c => { const s = new Set(); for (let k = 1; k < c.length; k++) s.add((c[0] + c[k]) % 12); return s })
const shared = (a, b) => { let n = 0; for (const p of PCS[a]) if (PCS[b].has(p)) n++; return n }

// ── transition graph — biased to the descending-fifths circle (the jazz "circle of fifths"
// turnaround). [nextChord, baseWeight]. Each chord's circle successor (I→IV→viiø→iii→vi→ii→V→I)
// carries weight ·3, so the walk takes long fifth-falling paths; a lighter alt keeps it varied.
// viiø is reachable only via IV (and IV→V dominates), so the unstable half-dim stays a rare colour.
const TRANS = [
  [[3, 3], [5, 1], [4, 1]],   // I    → IV (circle) vi V
  [[4, 3], [0, 1]],           // ii   → V (circle) I
  [[5, 3], [1, 1]],           // iii  → vi (circle) ii
  [[4, 3], [6, 1], [0, 1]],   // IV   → V viiø(rare) I   — V dominates, half-dim is a rare colour
  [[0, 3], [5, 1]],           // V    → I (circle) vi (deceptive)
  [[1, 3], [3, 1]],           // vi   → ii (circle) IV
  [[2, 3], [0, 1]],           // viiø → iii (circle) I
]

const NB = 29          // bars in the walk before it loops (× barLen 4 s = 116 s loop)

// Deterministic walk over the graph. Each candidate's weight = base × recency × voiceLead:
//   base      — the circle-of-fifths bias from TRANS.
//   recency   — a 5-bar cooldown: a just-used chord is blocked (a tiny weight that, among the
//               blocked, prefers the OLDEST — never the most recent) and only frees up after 5
//               bars, so the walk takes long fifth-falling paths and never doubles back quickly.
//   voiceLead — (held notes − 1): every diatonic pair holds ≥2 in the rootless voicing, so this
//               stays positive and just nudges toward the smoothest move.
// Capped with a ii–V turnaround so the loop point resolves (…ii V | I).
const COOL = 5
const walkIdx = (seed) => {
  let s = (seed >>> 0) || 1
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296
  const idx = [0]
  const lastSeen = [0, -99, -99, -99, -99, -99, -99]   // bar each chord last sounded
  let cur = 0
  while (idx.length < NB - 2) {
    const bar = idx.length, opts = TRANS[cur]
    let total = 0
    const w = opts.map(([o, bw]) => {
      const age = bar - lastSeen[o]
      const rec = age <= COOL ? age * 0.02 : 1     // blocked for COOL bars (oldest preferred), then free
      const ww = bw * rec * (shared(cur, o) - 1)
      total += ww; return ww
    })
    let r = rnd() * total, cho = opts[0][0]
    for (let i = 0; i < opts.length; i++) { r -= w[i]; if (r <= 0) { cho = opts[i][0]; break } }
    cur = cho; lastSeen[cur] = bar; idx.push(cur)
  }
  idx.push(1, 4)       // … ii V | (loops to I)
  return idx
}

const SEQ_IDX = walkIdx(2)
const SEQ = SEQ_IDX.map(i => CHORDS[i])
const seqLit = '[' + SEQ.map(c => `[${c.join(', ')}]`).join(', ') + ']'

// Readable chord names for the live label (in C; the demo plays seed 0 → key C).
const CHORD_NAMES = ['Cmaj13', 'Dm11', 'Em11', 'Fmaj9♯11', 'G13', 'Am11', 'Bm11♭5']

export const songs = [
  { name: 'after hours', body:
`(t, sd) => {
  // A warm detuned pad walking a ${NB}-bar jazz chord graph (baked above), each chord
  // crossfading into the next so nothing clicks. The pad is a ROOTLESS CLOSE voicing — the 5
  // upper tones folded into one octave — so neighbouring chords share HELD notes (2–4 of them):
  // smooth voice-leading, never a jump to all-new pitches. A soft sub traces the root below it.
  // The seed transposes the key and rotates the entry point, so a different seed drops you
  // elsewhere in the same walk.
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
    const fa = 261.63 * 2 ** (((key + A[0] + A[k]) % 12) / 12)   // fold to [C4,C5) — rootless close voicing
    padA += Math.sin(t*${TAU}*fa) + Math.sin(t*${TAU}*fa*1.003)  // two slightly detuned sines = warmth
    const fc = 261.63 * 2 ** (((key + B[0] + B[k]) % 12) / 12)
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
