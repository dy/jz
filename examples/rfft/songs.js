// Floatbeat tunes for the rfft demo — plain JS bodies, jz-compatible subset.
// Each body is `(t) => { ... }` with TAU inlined (no free variables).

export const TAU = 6.283185307179586

export const songs = [
  { name: 'lofi jazz', body:
`(t) => {
  // ii–V–I–vi in C: Dm7 G7 Cmaj7 Am7, two seconds each, with a soft arpeggio
  const prog = [[2,5,9,12],[7,11,14,17],[0,4,7,11],[9,12,16,19]]
  const ch = prog[(t*.5|0) % 4]
  let pad = 0
  for (let i = 0; i < 4; i++) pad += Math.sin(t*${TAU}*130.8 * 2**(ch[i]/12))
  const a = (t*4) % 1
  const arp = Math.sin(t*${TAU}*523.3 * 2**(ch[(t*4|0)%4]/12)) * Math.exp(-a*5)
  const bass = Math.sin(t*${TAU}*65.4 * 2**(ch[0]/12))
  return Math.tanh(pad*.16 + arp*.35 + bass*.5)
}` },
  { name: 'rhodes', body:
`(t) => {
  // the four chords, I–V–vi–IV: Cmaj7 G7 Am7 Fmaj7 on a warm FM Rhodes that swells
  const prog = [[0,4,7,11],[7,11,14,17],[9,12,16,19],[5,9,12,16]]
  const ch = prog[(t*.5|0) % 4]
  const sw = Math.exp(-((t*.5)%1) * .7)
  let v = 0
  for (let i = 0; i < 4; i++) { const f = 261.6 * 2**(ch[i]/12); v += Math.sin(t*${TAU}*f + 1.8*Math.sin(t*${TAU}*f)) }
  const bass = Math.sin(t*${TAU}*65.4 * 2**(ch[0]/12))
  return Math.tanh(v*.16*sw + bass*.5)
}` },
  { name: 'bossa', body:
`(t) => {
  // bossa nova — maj7/m7 comp pushed off the beat over a soft root–fifth bass
  const prog = [[0,4,7,11],[2,5,9,12],[7,11,14,17],[0,4,7,11]]
  const ch = prog[(t*.5|0) % 4]
  let comp = 0
  for (let i = 0; i < 4; i++) comp += Math.sin(t*${TAU}*261.6 * 2**(ch[i]/12))
  const hit = Math.exp(-((t*2)%1) * 6) * (((t*2|0)%2) ? 1 : .45)
  const bass = Math.sin(t*${TAU}*98 * 2**(ch[0]/12)) * (((t*4|0)%2) ? .6 : 1)
  return Math.tanh(comp*.15*hit + bass*.5)
}` },
  { name: 'dream pad', body:
`(t) => {
  // slow lush pad — Cmaj9 ⇄ Am9, shimmering detune, breathing very gently
  const prog = [[0,4,7,11,14],[9,12,16,19,23]]
  const ch = prog[(t*.25|0) % 2]
  let v = 0
  for (let i = 0; i < 5; i++) { const f = 130.8 * 2**(ch[i]/12); v += Math.sin(t*${TAU}*f) + Math.sin(t*${TAU}*f*1.003) }
  const breath = .6 + .4*Math.sin(t*${TAU}*.125)
  return Math.tanh(v*.11 * breath)
}` },
  { name: 'blue waltz', body:
`(t) => {
  // minor jazz waltz in 3/4 — Cm9 Fm7 G7 Cm9, a wistful lilt
  const prog = [[0,3,7,10,14],[5,8,12,15],[7,11,14,17],[0,3,7,10,14]]
  const ch = prog[(t*.5|0) % 4]
  const beat = (t*3) % 1
  let pad = 0
  for (let i = 0; i < ch.length; i++) pad += Math.sin(t*${TAU}*130.8 * 2**(ch[i]/12))
  const pluck = Math.sin(t*${TAU}*523.3 * 2**(ch[(t*3|0)%ch.length]/12)) * Math.exp(-beat*4)
  const bass = Math.sin(t*${TAU}*65.4 * 2**(ch[0]/12)) * (((t*3|0)%3===0) ? 1 : .5)
  return Math.tanh(pad*.13 + pluck*.3 + bass*.5)
}` },
]

/** Source shown in the demo code panel (readable TAU name). */
export const songDisplaySrc = (song) =>
  song.body.replaceAll(String(TAU), 'TAU')

/** jz/JS callable body — already has TAU numeric. */
export const songBeatSrc = (song) => song.body

/** Compile a floatbeat module: beat(t) + fill(out,len,sr). */
export const floatbeatModuleSrc = (song) => {
  const body = songBeatSrc(song)
  return `export let beat = ${body}
export let fill = (out, len, sr) => { let i = 0; while (i < len) { out[i] = beat(i / sr); i++ } }`
}

/** Filesystem slug for prebuilt beat wasm (`beats/lofi-jazz.wasm`, …). */
export const songSlug = (song) =>
  song.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
