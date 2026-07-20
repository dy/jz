// glyfparse.js — TrueType `glyf`-style outline decoding: flag runs with REPEAT counts,
// then variable-length coordinate deltas (short-unsigned-with-sign bit or long-16-bit or
// same-as-previous), accumulated to absolute positions — the byte-grammar every font
// stack (HarfBuzz, FreeType, fonttools) hot-loops over. The profile: unpredictable
// per-byte branches, variable-length records, bit tests, running accumulators — parser
// codegen without dragging in a whole compiler. Pure integer, bit-identical everywhere.
//
// The stream is synthesized once (deterministic xorshift) by the same rules, so parsing
// is validated by construction: the checksum covers decoded absolute coordinates and
// per-glyph point counts.
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, typed arrays, no class/async/regex.
//
// Reports: median ms across N_RUNS, FNV-1a checksum over decoded coordinates.

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const NG = 600               // glyphs
const MAXPTS = 120
const STREAM_CAP = 1 << 19
const N_ITERS = 12
const N_RUNS = 21
const N_WARMUP = 5

// flag bits (TrueType): 0x01 on-curve · 0x02 x-short · 0x04 y-short · 0x08 repeat ·
// 0x10 x-same/positive · 0x20 y-same/positive
const buildStream = (stream, glyphOff, glyphPts) => {
  let s = 0x8e1d3a5 | 0
  const rnd = () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return s >>> 0
  }
  let w = 0
  const flags = new Uint8Array(MAXPTS)
  for (let g = 0; g < NG; g++) {
    glyphOff[g] = w
    const np = 20 + (rnd() % (MAXPTS - 20 + 1))
    glyphPts[g] = np
    // decide per-point flags first
    for (let p = 0; p < np; p++) {
      const dxKind = rnd() % 3                  // 0 short, 1 long, 2 same
      const dyKind = rnd() % 3
      let f = rnd() & 1                         // on-curve
      if (dxKind === 0) f |= 0x02 | ((rnd() & 1) << 4)
      else if (dxKind === 2) f |= 0x10
      if (dyKind === 0) f |= 0x04 | ((rnd() & 1) << 5)
      else if (dyKind === 2) f |= 0x20
      flags[p] = f
    }
    // write flags with REPEAT compression
    let p = 0
    while (p < np) {
      let run = 1
      while (p + run < np && flags[p + run] === flags[p] && run < 255) run++
      if (run > 1) {
        stream[w++] = flags[p] | 0x08
        stream[w++] = run - 1
      } else {
        stream[w++] = flags[p]
      }
      p += run
    }
    // x deltas
    for (let p2 = 0; p2 < np; p2++) {
      const f = flags[p2]
      if (f & 0x02) stream[w++] = rnd() % 256
      else if (!(f & 0x10)) { const d = rnd() & 0xffff; stream[w++] = d >>> 8; stream[w++] = d & 255 }
    }
    // y deltas
    for (let p2 = 0; p2 < np; p2++) {
      const f = flags[p2]
      if (f & 0x04) stream[w++] = rnd() % 256
      else if (!(f & 0x20)) { const d = rnd() & 0xffff; stream[w++] = d >>> 8; stream[w++] = d & 255 }
    }
  }
  return w
}

// decode every glyph: flags (expanding repeats), then x accumulation, then y
const parseAll = (stream, glyphOff, glyphPts, flagBuf) => {
  let h = 0x811c9dc5 | 0
  for (let g = 0; g < NG; g++) {
    let r = glyphOff[g]
    const np = glyphPts[g]
    let p = 0
    while (p < np) {
      const f = stream[r++]
      flagBuf[p++] = f
      if (f & 0x08) {
        let rep = stream[r++]
        while (rep > 0) { flagBuf[p++] = f; rep-- }
      }
    }
    let x = 0
    let onCount = 0
    for (let i = 0; i < np; i++) {
      const f = flagBuf[i]
      if (f & 0x02) {
        const d = stream[r++]
        x = (f & 0x10) ? x + d : x - d
      } else if (!(f & 0x10)) {
        x = x + (((stream[r] << 8) | stream[r + 1]) << 16 >> 16)
        r += 2
      }
      h = mix(h, x)
      onCount += f & 1
    }
    let y = 0
    for (let i = 0; i < np; i++) {
      const f = flagBuf[i]
      if (f & 0x04) {
        const d = stream[r++]
        y = (f & 0x20) ? y + d : y - d
      } else if (!(f & 0x20)) {
        y = y + (((stream[r] << 8) | stream[r + 1]) << 16 >> 16)
        r += 2
      }
      h = mix(h, y)
    }
    h = mix(h, onCount)
  }
  return h
}

const runKernel = (stream, glyphOff, glyphPts, flagBuf) => {
  let h = 0
  for (let it = 0; it < N_ITERS; it++) h = mix(h, parseAll(stream, glyphOff, glyphPts, flagBuf))
  return h
}

export let main = () => {
  const stream = new Uint8Array(STREAM_CAP)
  const glyphOff = new Int32Array(NG)
  const glyphPts = new Int32Array(NG)
  const flagBuf = new Uint8Array(MAXPTS)
  buildStream(stream, glyphOff, glyphPts)

  let acc = 0
  for (let i = 0; i < N_WARMUP; i++) acc = mix(acc, runKernel(stream, glyphOff, glyphPts, flagBuf))

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    acc = mix(acc, runKernel(stream, glyphOff, glyphPts, flagBuf))
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), (acc >>> 0), NG * N_ITERS, 1, N_RUNS)
}
