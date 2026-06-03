// The rfft demo's floatbeat voice — one evolving tune, seeded. A plain JS body
// (jz-compatible subset) with TAU inlined, so the very same source compiles to
// wasm (jz) and runs under V8 (new Function). The 🎲 reseeds it: same instrument
// and changes, a different key and starting chord — switch the chord, not the song.

export const TAU = 6.283185307179586

export const songs = [
  { name: 'after hours', body:
`(t, sd) => {
  // A warm detuned pad over an 8-bar jazz cycle — Cmaj9 Am9 Fmaj9 G9 Em9 Am9 Dm9 G9
  // (I vi IV V iii vi ii V), each chord crossfading into the next so nothing clicks.
  // Every voicing is rootless (3·5·7·9) for that open, smoky colour; a soft sub
  // traces the root. The seed transposes the key and rotates the starting chord,
  // so a shuffle drops you on a fresh harmony in the same voice.
  const seq = [
    [0, 4, 7, 11, 14],   // Cmaj9
    [9, 3, 7, 10, 14],   // Am9
    [5, 4, 7, 11, 14],   // Fmaj9
    [7, 4, 7, 10, 14],   // G9  (dominant)
    [4, 3, 7, 10, 14],   // Em9
    [9, 3, 7, 10, 14],   // Am9
    [2, 3, 7, 10, 14],   // Dm9
    [7, 4, 7, 10, 14],   // G9  (dominant)
  ]
  const barLen = 4
  const fb = t / barLen, bar = fb | 0, ph = fb - bar
  const key = (sd | 0) % 12, rot = ((sd | 0) * 3) % 8
  const A = seq[(bar + rot) % 8], B = seq[(bar + 1 + rot) % 8]
  // crossfade the last 28% of each bar into the next chord (smoothstep — no click)
  let xf = ph < 0.72 ? 0 : (ph - 0.72) / 0.28
  xf = xf * xf * (3 - 2 * xf)
  let padA = 0, padB = 0
  for (let k = 1; k <= 4; k++) {
    const fa = 130.81 * 2 ** ((key + A[0] + A[k]) / 12)   // C3 reference
    padA += Math.sin(t*${TAU}*fa) + Math.sin(t*${TAU}*fa*1.003)   // two slightly detuned sines = warmth
    const fc = 130.81 * 2 ** ((key + B[0] + B[k]) / 12)
    padB += Math.sin(t*${TAU}*fc) + Math.sin(t*${TAU}*fc*1.003)
  }
  const pad = padA * (1 - xf) + padB * xf
  const ba = 65.41 * 2 ** ((key + A[0]) / 12), bc = 65.41 * 2 ** ((key + B[0]) / 12)   // C2 sub
  const bass = Math.sin(t*${TAU}*ba) * (1 - xf) + Math.sin(t*${TAU}*bc) * xf
  const breath = 0.72 + 0.28 * Math.sin(t*${TAU}*0.05)   // slow swell, ~20 s
  return Math.tanh((pad * 0.05 + bass * 0.42) * breath)
}` },
]

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
