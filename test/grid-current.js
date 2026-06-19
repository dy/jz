// The hero's grid-current field (assets/grid-current.js) ships as a real jz program, and the homepage flips a
// live JS⇄JZ switch between the jz-compiled wasm and the SAME source run as plain JS — so the two MUST render
// byte-identical frames or the switch would visibly desync the animation. The field is PROCEDURAL: every pulse
// position is a pure function of time, so parity rests on two rules — (1) the only persisted state is the
// Float64Array F (never an integer-initialized module `let` global, which jz would narrow to i32 and truncate);
// (2) all per-line variety comes from the stateless integer hash on integer line/pulse indices. A fractional
// global, or a hash key built from a non-bit-identical quantity, would diverge here within a few frames.
import test from 'tst'
import { ok } from 'tst/assert.js'
import jz from '../index.js'
import fs from 'fs'

const src = fs.readFileSync(new URL('../assets/grid-current.js', import.meta.url), 'utf8')
// the SAME source as plain JS: strip the ESM `export` keywords and hand back the four exports.
const asJs = () => new Function(`${src.replace(/export\s+let\s+/g, 'let ')}\nreturn { resize, configure, frame, spawn, param }`)()

const W = 384, H = 256, SCALE = 1.333   // fractional scale → DPR-style spacing an i32-narrowed global would truncate
const CLICKS = [[0.37, 0.5], [0.62, 0.31], [0.18, 0.77], [0.83, 0.22], [0.5, 0.5], [0.91, 0.66], [0.045, 0.12]]

for (const optimize of [0, 3]) {
  test(`grid-current: jz wasm renders byte-identical to plain JS (optimize ${optimize})`, () => {
    const a = jz(src, { optimize }).exports
    const b = asJs()
    const pa = a.resize(W, H); a.configure(0, SCALE)
    const pb = b.resize(W, H); b.configure(0, SCALE)
    let t = 0, badFrame = -1, badIdx = -1, lit = 0
    for (let f = 0; f < 360 && badFrame < 0; f++) {
      t += 0.0166 + (f % 7) * 0.0003              // wobbly dt
      if (f === 40) for (let pi = 0; pi < 7; pi++) { const v = 0.3 + (pi % 3) * 0.7; a.param(pi, v); b.param(pi, v) }  // tunables must stay in step
      if (f > 20 && f % 50 === 13) {              // repeated clicks pile up bursts (the ring), not override
        const [nx, ny] = CLICKS[((f / 50) | 0) % CLICKS.length]
        a.spawn(nx, ny); b.spawn(nx, ny)
      }
      a.frame(t); b.frame(t)
      for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) { badFrame = f; badIdx = i; break }
    }
    ok(badFrame < 0, badFrame < 0 ? 'byte-identical across 360 frames + clicks'
      : `diverged at frame ${badFrame}, pixel ${badIdx}: jz ${pa[badIdx]} ≠ js ${pb[badIdx]}`)
    for (let i = 0; i < pa.length; i++) if (pa[i]) lit++   // and it must actually paint (no trivial empty-buffer pass)
    ok(lit > 0, lit > 0 ? `field paints (${lit} lit px)` : 'the field drew nothing after 360 frames')
  })
}

// Behavioural invariant the user cares about: pulses ENTER from the screen edges and the current fills IN over
// time — they never materialise mid-screen. A regression that seeds a line's pulses at a phase offset (so a line
// is ~full of pulses from t=0) would make the lit-pixel count flat from the start instead of climbing. This pins
// the climb: an early frame must be well short of the filled-in steady state. (The phi→delay fix is what this
// guards; parity alone would not have caught it, since a wrongly-placed pulse is still placed identically JS/JZ.)
const litAfter = (seconds) => {
  const m = asJs()
  const p = m.resize(W, H); m.configure(0, SCALE)
  let t = 0
  while (t < seconds) { t += 0.0166; m.frame(t) }
  let lit = 0; for (let i = 0; i < p.length; i++) if (p[i]) lit++
  return lit
}

test('grid-current: the current fills IN from the edges over time (no mid-screen materialisation)', () => {
  const early = litAfter(1.0), filled = litAfter(6.0)
  ok(early > 0, 'the edges should already be lit shortly after start')
  ok(filled > early * 1.8, `the field must fill IN over time, not appear full at once: early=${early}, filled=${filled}`)
})

// A click fires four pulses out of the nearest major intersection, and the arms pointing OUTWARD past the cursor
// must be brighter than the opposite arms (intensity biased by the cursor's offset). A sign flip here would not
// break parity — both engines would draw the same wrong thing — so pin the direction explicitly.
// The tunables must actually reach the field — a dial wired to the wrong F slot would still pass parity (both
// engines would be wrong identically). Pin that the brightness dial moves the lit-pixel count.
test('grid-current: param() dials move the field (brightness wired through)', () => {
  const glowWithBrightness = (bri) => {
    const m = asJs(); const p = m.resize(W, H); m.configure(0, SCALE); m.param(4, bri)   // 4 = Brightness
    let t = 0, glow = 0; for (let f = 0; f < 220; f++) { t += 0.016; m.frame(t) }
    for (let i = 0; i < p.length; i++) glow += (p[i] >>> 24) & 255   // total alpha = how bright the field is
    return glow
  }
  const dim = glowWithBrightness(0.35), bright = glowWithBrightness(2.0)
  ok(bright > dim * 1.4, `the brightness dial must change the field: dim=${dim}, bright=${bright}`)
})

test('grid-current: click burst — arms away from the cursor are the bright ones', () => {
  const m = asJs(), major = 80 * SCALE
  const p = m.resize(W, H); m.configure(0, SCALE)
  let t = 0; for (let f = 0; f < 30; f++) { t += 0.016; m.frame(t) }
  // a known interior junction (2·major is also on the 40-subgrid, where spawn() now snaps); the click offset
  // is sized to the SUBGRID cell (½·major) so it still rounds to THIS junction — cursor right + down of it
  const jx = Math.round(2 * major), jy = Math.round(1 * major)
  m.spawn((jx + major * 0.17) / W, (jy + major * 0.13) / H)   // +0.17·major = +0.34 of a subgrid cell → rounds to the junction
  t += 0.016; m.frame(t); for (let f = 0; f < 25; f++) { t += 0.016; m.frame(t) }
  const a = (x, y) => (p[(y | 0) * W + (x | 0)] >>> 24) & 255, D = (major * 0.4) | 0
  const right = a(jx + D, jy), left = a(jx - D, jy), down = a(jx, jy + D), up = a(jx, jy - D)
  ok(left > right + 20 && up > down + 20, `away arms must dominate (cursor sits right+down, so left+up fly furthest): right=${right} left=${left}, down=${down} up=${up}`)
})

test('grid-current: click burst snaps to the SUBGRID (40-grid), not only the major grid', () => {
  const m = asJs(), major = 80 * SCALE
  const p = m.resize(W, H); m.configure(0, SCALE)
  let t = 0; for (let f = 0; f < 30; f++) { t += 0.016; m.frame(t) }
  // click dead-on a SUB-ONLY junction: 2.5·major = 5·mid sits on the 40-grid but NOT the 80-grid, so a
  // major-only snap would round it to (3·major, 2·major) — a different column+row — landing the arms there.
  const sx = Math.round(2.5 * major), sy = Math.round(1.5 * major)   // where a SUBGRID snap fires
  const mx = Math.round(3 * major),   my = Math.round(2 * major)     // where a MAJOR-only snap would fire
  m.spawn(sx / W, sy / H)
  t += 0.016; m.frame(t); for (let f = 0; f < 25; f++) { t += 0.016; m.frame(t) }
  const a = (x, y) => (p[(y | 0) * W + (x | 0)] >>> 24) & 255, D = (major * 0.4) | 0
  const onSub = a(sx, sy - D), onMajor = a(mx, my - D)   // each candidate junction's upward vertical arm
  ok(onSub > onMajor + 30, `burst must land on the subgrid junction (${sx},${sy}), not the major (${mx},${my}): onSub=${onSub} onMajor=${onMajor}`)
})
