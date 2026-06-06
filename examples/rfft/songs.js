// The rfft demo's floatbeat voice — one evolving tune. A plain JS body
// (jz-compatible subset) with TAU inlined, so the very same source compiles to
// wasm (jz) and runs under V8 (new Function). The chord progression is not a fixed
// loop: it's a random WALK over a jazz chord-transition graph (functional harmony —
// ii→V→I, V→vi deceptive, vi→ii, etc.) generated dynamically.

export const TAU = 6.283185307179586

export const PCS_MASK = [2196, 689, 2756, 657, 2596, 2197, 564]

export const popcount = (x) => {
  let count = 0, temp = x
  while (temp > 0) { temp &= temp - 1; count++ }
  return count
}

export const shared = (a, b) => popcount(PCS_MASK[a] & PCS_MASK[b])

export const getChordIdx = (bar, sd) => {
  let s = (sd >>> 0) || 1
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296
  
  let lastSeen0 = -99, lastSeen1 = -99, lastSeen2 = -99, lastSeen3 = -99
  let lastSeen4 = -99, lastSeen5 = -99, lastSeen6 = -99
  
  let cur = 0
  lastSeen0 = 0
  
  let idx = 0
  while (idx < bar) {
    let opt0_next = 0, opt0_w = 0
    let opt1_next = -1, opt1_w = 0
    let opt2_next = -1, opt2_w = 0
    
    if (cur === 0) {
      opt0_next = 3; opt0_w = 3.0
      opt1_next = 5; opt1_w = 1.0
      opt2_next = 4; opt2_w = 1.0
    } else if (cur === 1) {
      opt0_next = 4; opt0_w = 3.0
      opt1_next = 0; opt1_w = 1.0
    } else if (cur === 2) {
      opt0_next = 5; opt0_w = 3.0
      opt1_next = 1; opt1_w = 1.0
    } else if (cur === 3) {
      opt0_next = 6; opt0_w = 3.0
      opt1_next = 4; opt1_w = 1.0
      opt2_next = 0; opt2_w = 1.0
    } else if (cur === 4) {
      opt0_next = 0; opt0_w = 3.0
      opt1_next = 5; opt1_w = 1.0
    } else if (cur === 5) {
      opt0_next = 1; opt0_w = 3.0
      opt1_next = 3; opt1_w = 1.0
    } else if (cur === 6) {
      opt0_next = 2; opt0_w = 3.0
      opt1_next = 0; opt1_w = 1.0
    }
    
    let nextBar = idx + 1
    
    const age0 = opt0_next === 0 ? lastSeen0 : opt0_next === 1 ? lastSeen1 : opt0_next === 2 ? lastSeen2 : opt0_next === 3 ? lastSeen3 : opt0_next === 4 ? lastSeen4 : opt0_next === 5 ? lastSeen5 : lastSeen6
    const ageMultiplier0 = nextBar - age0 <= 3 ? (nextBar - age0) * 0.05 : 1.0
    let ww0 = opt0_w * ageMultiplier0 * (shared(cur, opt0_next) - 1)
    
    let ww1 = 0.0
    if (opt1_next !== -1) {
      const age1 = opt1_next === 0 ? lastSeen0 : opt1_next === 1 ? lastSeen1 : opt1_next === 2 ? lastSeen2 : opt1_next === 3 ? lastSeen3 : opt1_next === 4 ? lastSeen4 : opt1_next === 5 ? lastSeen5 : lastSeen6
      const ageMultiplier1 = nextBar - age1 <= 3 ? (nextBar - age1) * 0.05 : 1.0
      ww1 = opt1_w * ageMultiplier1 * (shared(cur, opt1_next) - 1)
    }
    
    let ww2 = 0.0
    if (opt2_next !== -1) {
      const age2 = opt2_next === 0 ? lastSeen0 : opt2_next === 1 ? lastSeen1 : opt2_next === 2 ? lastSeen2 : opt2_next === 3 ? lastSeen3 : opt2_next === 4 ? lastSeen4 : opt2_next === 5 ? lastSeen5 : lastSeen6
      const ageMultiplier2 = nextBar - age2 <= 3 ? (nextBar - age2) * 0.05 : 1.0
      ww2 = opt2_w * ageMultiplier2 * (shared(cur, opt2_next) - 1)
    }
    
    let total = ww0 + ww1 + ww2
    let r = rnd() * total
    let nextChord = opt0_next
    
    if (r <= ww0) {
      nextChord = opt0_next
    } else if (r <= ww0 + ww1) {
      nextChord = opt1_next
    } else {
      nextChord = opt2_next
    }
    
    cur = nextChord
    if (cur === 0) lastSeen0 = nextBar
    else if (cur === 1) lastSeen1 = nextBar
    else if (cur === 2) lastSeen2 = nextBar
    else if (cur === 3) lastSeen3 = nextBar
    else if (cur === 4) lastSeen4 = nextBar
    else if (cur === 5) lastSeen5 = nextBar
    else lastSeen6 = nextBar
    
    idx++
  }
  return cur
}

const CHORDS = [
  [0, 4, 7, 11, 14, 16],   // I    Cmaj9
  [2, 3, 7, 10, 14, 17],   // ii   Dm11
  [4, 3, 7, 10, 14, 17],   // iii  Em11
  [5, 4, 7, 11, 14, 16],   // IV   Fmaj9
  [7, 4, 7, 10, 14, 16],   // V    G9 (dominant)
  [9, 3, 7, 10, 14, 17],   // vi   Am11
  [11, 3, 6, 10, 15, 17],  // viiø Bm11♭5 (half-diminished)
]

export const songs = [
  { name: 'after hours', body:
`(t, sd) => {
  // Use a global cache to avoid recalculating the walk on every single sample in JS!
  let cache = globalThis.__rfft_cache || (globalThis.__rfft_cache = { lastBar: -1, curSd: -1, cA_idx: 0, cb_idx: 0 });
  const barLen = 4;
  const fb = t / barLen, bar = fb | 0, ph = fb - bar;
  const key = (sd | 0) % 12;

  const PCS_MASK = [2196, 689, 2756, 657, 2596, 2197, 564];

  const popcount = (x) => {
    let count = 0, temp = x;
    while (temp > 0) { temp &= temp - 1; count++; }
    return count;
  };
  const shared = (a, b) => popcount(PCS_MASK[a] & PCS_MASK[b]);

  const getChordIdx = (bar, sd) => {
    let s = (sd >>> 0) || 1;
    let lastSeen0 = -99, lastSeen1 = -99, lastSeen2 = -99, lastSeen3 = -99;
    let lastSeen4 = -99, lastSeen5 = -99, lastSeen6 = -99;
    let cur = 0;
    lastSeen0 = 0;
    let idx = 0;
    while (idx < bar) {
      let opt0_next = 0, opt0_w = 0;
      let opt1_next = -1, opt1_w = 0;
      let opt2_next = -1, opt2_w = 0;
      if (cur === 0) {
        opt0_next = 3; opt0_w = 3.0;
        opt1_next = 5; opt1_w = 1.0;
        opt2_next = 4; opt2_w = 1.0;
      } else if (cur === 1) {
        opt0_next = 4; opt0_w = 3.0;
        opt1_next = 0; opt1_w = 1.0;
      } else if (cur === 2) {
        opt0_next = 5; opt0_w = 3.0;
        opt1_next = 1; opt1_w = 1.0;
      } else if (cur === 3) {
        opt0_next = 6; opt0_w = 3.0;
        opt1_next = 4; opt1_w = 1.0;
        opt2_next = 0; opt2_w = 1.0;
      } else if (cur === 4) {
        opt0_next = 0; opt0_w = 3.0;
        opt1_next = 5; opt1_w = 1.0;
      } else if (cur === 5) {
        opt0_next = 1; opt0_w = 3.0;
        opt1_next = 3; opt1_w = 1.0;
      } else if (cur === 6) {
        opt0_next = 2; opt0_w = 3.0;
        opt1_next = 0; opt1_w = 1.0;
      }
      let nextBar = idx + 1;
      const age0 = opt0_next === 0 ? lastSeen0 : opt0_next === 1 ? lastSeen1 : opt0_next === 2 ? lastSeen2 : opt0_next === 3 ? lastSeen3 : opt0_next === 4 ? lastSeen4 : opt0_next === 5 ? lastSeen5 : lastSeen6;
      const ageMultiplier0 = nextBar - age0 <= 3 ? (nextBar - age0) * 0.05 : 1.0;
      let ww0 = opt0_w * ageMultiplier0 * (shared(cur, opt0_next) - 1);
      let ww1 = 0.0;
      if (opt1_next !== -1) {
        const age1 = opt1_next === 0 ? lastSeen0 : opt1_next === 1 ? lastSeen1 : opt1_next === 2 ? lastSeen2 : opt1_next === 3 ? lastSeen3 : opt1_next === 4 ? lastSeen4 : opt1_next === 5 ? lastSeen5 : lastSeen6;
        const ageMultiplier1 = nextBar - age1 <= 3 ? (nextBar - age1) * 0.05 : 1.0;
        ww1 = opt1_w * ageMultiplier1 * (shared(cur, opt1_next) - 1);
      }
      let ww2 = 0.0;
      if (opt2_next !== -1) {
        const age2 = opt2_next === 0 ? lastSeen0 : opt2_next === 1 ? lastSeen1 : opt2_next === 2 ? lastSeen2 : opt2_next === 3 ? lastSeen3 : opt2_next === 4 ? lastSeen4 : opt2_next === 5 ? lastSeen5 : lastSeen6;
        const ageMultiplier2 = nextBar - age2 <= 3 ? (nextBar - age2) * 0.05 : 1.0;
        ww2 = opt2_w * ageMultiplier2 * (shared(cur, opt2_next) - 1);
      }
      let total = ww0 + ww1 + ww2;
      s = (s * 1664525 + 1013904223) | 0;
      let r = (s >>> 0) / 4294967296 * total;
      let nextChord = opt0_next;
      if (r <= ww0) {
        nextChord = opt0_next;
      } else if (r <= ww0 + ww1) {
        nextChord = opt1_next;
      } else {
        nextChord = opt2_next;
      }
      cur = nextChord;
      if (cur === 0) lastSeen0 = nextBar;
      else if (cur === 1) lastSeen1 = nextBar;
      else if (cur === 2) lastSeen2 = nextBar;
      else if (cur === 3) lastSeen3 = nextBar;
      else if (cur === 4) lastSeen4 = nextBar;
      else if (cur === 5) lastSeen5 = nextBar;
      else lastSeen6 = nextBar;
      idx++;
    }
    return cur;
  };

  if (cache.lastBar !== bar || cache.curSd !== sd) {
    cache.lastBar = bar;
    cache.curSd = sd;
    cache.cA_idx = getChordIdx(bar, sd);
    cache.cB_idx = getChordIdx(bar + 1, sd);
  }

  const CHORDS = [
    [0, 4, 7, 11, 14, 16],
    [2, 3, 7, 10, 14, 17],
    [4, 3, 7, 10, 14, 17],
    [5, 4, 7, 11, 14, 16],
    [7, 4, 7, 10, 14, 16],
    [9, 3, 7, 10, 14, 17],
    [11, 3, 6, 10, 15, 17]
  ];

  const cA = CHORDS[cache.cA_idx];
  const cB = CHORDS[cache.cB_idx];

  // crossfade the last 28% of each bar into the next chord (smoothstep — no click)
  let xf = ph < 0.72 ? 0 : (ph - 0.72) / 0.28;
  xf = xf * xf * (3 - 2 * xf);
  
  let padA = 0, padB = 0;
  for (let k = 1; k <= 5; k++) {
    const fa = 261.63 * 2 ** (((key + cA[0] + cA[k]) % 12) / 12);
    padA += Math.sin(t * 6.283185307179586 * fa) + Math.sin(t * 6.283185307179586 * fa * 1.003);
    const fc = 261.63 * 2 ** (((key + cB[0] + cB[k]) % 12) / 12);
    padB += Math.sin(t * 6.283185307179586 * fc) + Math.sin(t * 6.283185307179586 * fc * 1.003);
  }
  const pad = padA * (1 - xf) + padB * xf;
  const ba = 65.41 * 2 ** ((key + cA[0]) / 12), bc = 65.41 * 2 ** ((key + cB[0]) / 12);
  const bass = Math.sin(t * 6.283185307179586 * ba) * (1 - xf) + Math.sin(t * 6.283185307179586 * bc) * xf;
  const breath = 0.72 + 0.28 * Math.sin(t * 6.283185307179586 * 0.05);
  return Math.tanh((pad * 0.042 + bass * 0.42) * breath);
}` },
]

export const barsInWalk = 28
export const barLen = 4
export const chordSequence = Array.from({ length: 28 }, (_, i) => getChordIdx(i, 2))
export const chordNames = ['Cmaj9', 'Dm11', 'Em11', 'Fmaj9', 'G9', 'Am11', 'Bm11♭5']

export const songDisplaySrc = (song) =>
  song.body.replaceAll('6.283185307179586', 'TAU')

export const songBeatSrc = (song) => song.body

export const floatbeatModuleSrc = (song) => {
  let body = songBeatSrc(song)
  body = body.replace(
    'let cache = globalThis.__rfft_cache || (globalThis.__rfft_cache = { lastBar: -1, curSd: -1, cA_idx: 0, cb_idx: 0 });',
    ''
  )
  body = body.replaceAll('cache.lastBar', 'lastBar')
  body = body.replaceAll('cache.curSd', 'curSd')
  body = body.replaceAll('cache.cA_idx', 'cA_idx')
  body = body.replaceAll('cache.cB_idx', 'cB_idx')

  return `let lastBar = -1;
let curSd = -1;
let cA_idx = 0;
let cB_idx = 0;

export let beat = ${body}
export let fill = (out, len, sr, off, sd) => { let i = 0; while (i < len) { out[i] = beat(off + i / sr, sd); i++ } }`
}

export const songSlug = (song) =>
  song.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
