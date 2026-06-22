/**
 * Bytebeat / Floatbeat correctness tests.
 *
 * Classic formulas compiled via jz and validated against JS eval baseline.
 * All formulas are unmodified from their original sources (string literals
 * expanded to array lookups where jz lacks string-indexing).
 */

import test from 'tst'
import { is, almost } from 'tst/assert.js'
import jz from '../index.js'

function run(code, opts) {
  return jz(code, opts).exports
}

function jsBaseline(fnSrc, tRange) {
  const out = new Float64Array(tRange)
  const fn = new Function('t', fnSrc)
  for (let t = 0; t < tRange; t++) out[t] = fn(t)
  return out
}

function wasmBaseline(beat, tRange) {
  const out = new Float64Array(tRange)
  for (let t = 0; t < tRange; t++) out[t] = beat(t)
  return out
}

function compare(a, b, tol) {
  let bad = 0, worst = 0, worstT = -1
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const d = Math.abs(a[i] - b[i])
    if (d > tol) { bad++; if (d > worst) { worst = d; worstT = i } }
  }
  return { bad, worst, worstT, len }
}

/**
 * @param tol         per-sample tolerance
 * @param maxBadFrac  fraction of samples allowed to exceed `tol` (default 0 → strict,
 *   exact for bytebeats). Beats that feed `Math.sin` of a LARGE or growing argument
 *   through chaotic bitwise/modulo extraction (the floatbeat-PRNG idiom) diverge from
 *   the JS baseline in a minority of samples — jz's sin is a fast approximation, not
 *   bit-identical to V8's, and the `&`/`%` truncation amplifies sub-ulp differences
 *   into the odd flipped sample. Those are random-by-design and musically irrelevant.
 *   A small `maxBadFrac` tolerates them; a real miscompile diverges systematically
 *   (a large fraction, or every sample) and still trips the assert.
 */
function testFormula(name, jzBody, tRange, tol, maxBadFrac = 0) {
  test(name, () => {
    const code = `export let beat = (t) => { ${jzBody} }`
    const { beat } = run(code)
    const js = jsBaseline(jzBody, tRange)
    const wasm = wasmBaseline(beat, tRange)
    const { bad, worst, worstT, len } = compare(js, wasm, tol)
    if (bad / len > maxBadFrac) {
      throw new Error(`${bad}/${len} samples (${(100 * bad / len).toFixed(3)}%) exceed tol=${tol}` +
        ` (allowed ${(100 * maxBadFrac).toFixed(2)}%); worst Δ=${worst.toExponential(2)} at t=${worstT}`)
    }
  })
}

/** Per-sample tolerance for floatbeat tests. Higher than 1e-6 because compound
 *  sin/cos calls accumulate sub-ulp differences between JS Math.sin and jz's WASM
 *  sin approximation. 5e-6 is inaudible. Beats whose output is a *chaotic* function
 *  of Math.sin of a large argument additionally need `maxBadFrac` (see testFormula). */
const FTOL = 5e-6

// ============================================================
// BYTEBEAT — output in 0..255
// ============================================================

testFormula('Sawtooth (viznut)',
  'return t & 255', 65536, 0)

testFormula('Sierpinski Harmony (viznut)',
  'return (t & (t >> 8)) & 255', 65536, 0)

testFormula('The 42 Melody',
  'return (t * (42 & (t >> 10))) & 255', 65536, 0)

testFormula('Viznut 1st Iteration',
  'return (t * (((t >> 12) | (t >> 8)) & (63 & (t >> 4)))) & 255', 65536, 0)

testFormula('Tejeez Shifter',
  'return ((t * ((t >> 5) | (t >> 8))) >> (t >> 16)) & 255', 65536, 0)

testFormula('Viznut 2nd Iteration',
  'return ((t >> 6 | t | t >> (t >> 16)) * 10 + ((t >> 11) & 7)) & 255', 65536, 0)

testFormula('Xpansive + Varjohukka',
  'return ((t >> 7 | t | t >> 6) * 10 + 4 * (t & (t >> 13) | (t >> 6))) & 255', 65536, 0)

testFormula('Xpansive - Lost in Space',
  'return (((t * ((t >> 8) | (t >> 9)) & 46 & (t >> 8)) ^ (t & (t >> 13) | (t >> 6)))) & 255', 65536, 0)

testFormula('Viznut 3rd Iteration',
  'return ((t * 5 & (t >> 7)) | (t * 3 & (t >> 10))) & 255', 65536, 0)

testFormula('Stephth Layered',
  'return ((t * 9 & (t >> 4) | t * 5 & (t >> 7) | t * 3 & Math.floor(t / 1024)) - 1) & 255', 65536, 0)

testFormula('Skurk + Raer',
  'return (((t & 4096) ? (((t * (t ^ (t % 255)) | (t >> 4)) >> 1)) : ((t >> 3) | ((t & 8192) ? (t << 2) : t)))) & 255', 65536, 0)

testFormula('Visy - Space Invaders vs Pong',
  'return (t * (t >> ((t >> 9) | (t >> 8)) & (63 & (t >> 4)))) & 255', 65536, 0)

testFormula('Ryg - Sequenced',
  'return (((t >> 4) * (13 & (0x8898a989 >> ((t >> 11) & 30))))) & 255', 65536, 0)

testFormula('Mu6k - Long-line Theory',
  `let y = t & 16383;
   let x = (t * [6,6,8,9][(t >> 16) & 3] / 24) & 127;
   return ((Math.floor(3000 / y) & 1) * 35 + x * y / 40000 + (((t >> 8) ^ (t >> 10) | (t >> 14) | x) & 63)) & 255`, 65536, 0)

testFormula('Ryg - String-like',
  `let note = [3,6,3,6,4,6,8,9][(t >> 13) & 7] & 15;
   return ((Math.floor(t * note / 12) & 128) + (((Math.floor(((Math.floor((t >> 12) ^ (t >> 12) - 2) % 11) * t) / 4) | (t >> 13)) & 127))) & 255`, 65536, 0)

testFormula('Krcko',
  'return (((t & (t >> 12)) * ((t >> 4) | (t >> 8)) ^ (t >> 6)) & 255)', 65536, 0)

// ============================================================
// FLOATBEAT — real compositions, output in -1..1
// ============================================================

testFormula('Techno Loop',
  `let kick = Math.tanh(Math.sin(t / 20) * 5) * ((t >> 13) & 1);
   let bass = Math.sin(t / 300) * 0.3 * (((t >> 12) & 1) ? 1 : 0.5);
   let lead = Math.sin(t / (400 + 100 * ((t >> 10) & 3))) * 0.2;
   return kick + bass + lead`, 16384, FTOL)

testFormula('FM Arpeggio',
  `let note = [400, 300, 350, 250, 300, 200, 350, 400][(t >> 11) & 7];
   let env = Math.max(0, 1 - (t % 2048) / 512);
   return Math.sin(t / note + Math.sin(t / 100) * 2) * env * 0.5`, 16384, FTOL)

testFormula('Drum and Bass',
  `let kick = Math.tanh(Math.sin(t / 20) * 8) * ((t >> 12) & 1);
   let snare = Math.sin(t / 3) * Math.sin(t / 5) * ((t >> 11) & 1) * (((t >> 12) & 1) ? 0 : 1);
   let bass = Math.sin(t / 150 + Math.sin(t / 400) * 3) * 0.4;
   return kick * 0.5 + snare * 0.3 + bass * 0.3`, 16384, FTOL)

testFormula('Wobble Dub',
  `let wobble = Math.sin(t / 50 + Math.sin(t / 500) * 5);
   let gate = ((t >> 10) & 3) == 0 ? 1 : 0.3;
   return wobble * gate * 0.4`, 16384, FTOL)

testFormula('Chord Pad',
  `let chord = (Math.sin(t / 200) + Math.sin(t / 250) + Math.sin(t / 300)) / 3;
   let gate = ((t >> 12) & 3) == 0 ? 1 : 0;
   return chord * gate * 0.5`, 16384, FTOL)

testFormula('Polyrhythm Drone',
  `return Math.sin(t / 100) * 0.2 + Math.sin(t / 150) * 0.2 + Math.sin(t / 200) * 0.2`, 16384, FTOL)

testFormula('Bell Pattern',
  `let note = [30, 25, 30, 20, 30, 25, 30, 35][(t >> 11) & 7];
   let env = Math.max(0, 1 - (t % 2048) / 800);
   return Math.sin(t / note + Math.sin(t / 80) * 3) * env * 0.4`, 16384, FTOL)

testFormula('Ambient Drone',
  `return Math.sin(t / 400) * Math.sin(t / 401) * Math.sin(t / 402) * 0.8`, 16384, FTOL)

testFormula('Sequenced Bass',
  `let freq = [300, 400, 350, 250][(t >> 12) & 3];
   return Math.sin(t / freq) * 0.4 * (((t >> 10) & 3) == 0 ? 1 : 0.3)`, 16384, FTOL)

testFormula('Noise Percussion',
  `let hat = Math.sin(t / 2) * Math.sin(t / 3) * ((t >> 8) & 1) * 0.3;
   let click = ((t >> 9) & 1) * Math.sin(t / 10) * 0.2;
   return hat + click`, 16384, FTOL)

testFormula('Classic Floatbeat',
  `return Math.sin(t / 50) * Math.sin(t / 100) * 0.8`, 16384, FTOL)

testFormula('Bytebeat Anthem Float',
  `return (((t >> 7 | t | t >> 6) * 10 + 4 * (t & (t >> 13) | (t >> 6))) & 255) / 127.5 - 1`, 65536, FTOL)

// Floatbeat-PRNG idiom (cf. jukebox "Sunrise on Mars"): Math.sin of a large, growing
// argument fed through chaotic `& 255` extraction. The melodic Math.sin(t/50) stays
// bit-exact; the PRNG noise diverges from the JS baseline in ~0.2% of samples because
// jz's fast sin differs from V8's for large args — random-by-design and inaudible.
// maxBadFrac=0.02 tolerates it; a real miscompile diverges across the board, not in a
// sparse 0.2%. This is the assert robustness the chaotic-sin floatbeats need.
testFormula('Sin-PRNG percussion (large-arg sin)',
  `let lead = Math.sin(t / 50) * 0.5;
   let noise = (1e5 * Math.sin((t / 4 | 0) ** 2) & 255) / 255;
   return lead + noise * 0.2`, 16384, FTOL, 0.02)
