// glyfparse.as.ts — AssemblyScript translation of bench/glyfparse/glyfparse.js.
//
// TrueType `glyf`-style outline decoding: flag runs with REPEAT counts,
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
// Reports: median ms across N_RUNS, FNV-1a checksum over decoded coordinates.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const NG: i32 = 600               // glyphs
const MAXPTS: i32 = 120
const STREAM_CAP: i32 = 1 << 19
const N_ITERS: i32 = 12
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

// XorShift32 state threaded through a 1-cell array (AS has no primitive by-ref params).
function nextRnd(state: Int32Array): i32 {
  let s = unchecked(state[0])
  s ^= s << 13
  s ^= <i32>(<u32>s >>> 17)
  s ^= s << 5
  unchecked(state[0] = s)
  return s
}

function mix(h: i32, x: i32): i32 {
  return <i32>Math.imul(h ^ x, 0x01000193)
}

// flag bits (TrueType): 0x01 on-curve · 0x02 x-short · 0x04 y-short · 0x08 repeat ·
// 0x10 x-same/positive · 0x20 y-same/positive
function buildStream(stream: Uint8Array, glyphOff: Int32Array, glyphPts: Int32Array, rng: Int32Array): void {
  unchecked(rng[0] = 0x8e1d3a5)
  let w: i32 = 0
  const flags = new Uint8Array(MAXPTS)
  for (let g = 0; g < NG; g++) {
    unchecked(glyphOff[g] = w)
    const np: i32 = 20 + <i32>(<u32>nextRnd(rng) % <u32>(MAXPTS - 20 + 1))
    unchecked(glyphPts[g] = np)
    // decide per-point flags first
    for (let p = 0; p < np; p++) {
      const dxKind: i32 = <i32>(<u32>nextRnd(rng) % 3)
      const dyKind: i32 = <i32>(<u32>nextRnd(rng) % 3)
      let f: i32 = nextRnd(rng) & 1               // on-curve
      if (dxKind === 0) f |= 0x02 | ((nextRnd(rng) & 1) << 4)
      else if (dxKind === 2) f |= 0x10
      if (dyKind === 0) f |= 0x04 | ((nextRnd(rng) & 1) << 5)
      else if (dyKind === 2) f |= 0x20
      unchecked(flags[p] = <u8>f)
    }
    // write flags with REPEAT compression
    let p: i32 = 0
    while (p < np) {
      let run: i32 = 1
      while (p + run < np && unchecked(flags[p + run]) === unchecked(flags[p]) && run < 255) run++
      if (run > 1) {
        unchecked(stream[w++] = <u8>(flags[p] | 0x08))
        unchecked(stream[w++] = <u8>(run - 1))
      } else {
        unchecked(stream[w++] = flags[p])
      }
      p += run
    }
    // x deltas
    for (let p2 = 0; p2 < np; p2++) {
      const f: i32 = unchecked(flags[p2])
      if ((f & 0x02) !== 0) {
        unchecked(stream[w++] = <u8>(<u32>nextRnd(rng) % 256))
      } else if ((f & 0x10) === 0) {
        const d: i32 = nextRnd(rng) & 0xffff
        unchecked(stream[w++] = <u8>(<u32>d >>> 8))
        unchecked(stream[w++] = <u8>(d & 255))
      }
    }
    // y deltas
    for (let p2 = 0; p2 < np; p2++) {
      const f: i32 = unchecked(flags[p2])
      if ((f & 0x04) !== 0) {
        unchecked(stream[w++] = <u8>(<u32>nextRnd(rng) % 256))
      } else if ((f & 0x20) === 0) {
        const d: i32 = nextRnd(rng) & 0xffff
        unchecked(stream[w++] = <u8>(<u32>d >>> 8))
        unchecked(stream[w++] = <u8>(d & 255))
      }
    }
  }
}

// decode every glyph: flags (expanding repeats), then x accumulation, then y
function parseAll(stream: Uint8Array, glyphOff: Int32Array, glyphPts: Int32Array, flagBuf: Uint8Array): i32 {
  let h: i32 = 0x811c9dc5
  for (let g = 0; g < NG; g++) {
    let r: i32 = unchecked(glyphOff[g])
    const np: i32 = unchecked(glyphPts[g])
    let p: i32 = 0
    while (p < np) {
      const f: i32 = unchecked(stream[r++])
      unchecked(flagBuf[p++] = <u8>f)
      if ((f & 0x08) !== 0) {
        let rep: i32 = unchecked(stream[r++])
        while (rep > 0) { unchecked(flagBuf[p++] = <u8>f); rep-- }
      }
    }
    let x: i32 = 0
    let onCount: i32 = 0
    for (let i = 0; i < np; i++) {
      const f: i32 = unchecked(flagBuf[i])
      if ((f & 0x02) !== 0) {
        const d: i32 = unchecked(stream[r++])
        x = (f & 0x10) !== 0 ? x + d : x - d
      } else if ((f & 0x10) === 0) {
        // materialize as i32 locals before shifting — asc -O3 mistypes a shift
        // applied directly to an unchecked() Uint8Array read as an 8-bit op
        const hi: i32 = unchecked(stream[r])
        const lo: i32 = unchecked(stream[r + 1])
        x = x + (((hi << 8) | lo) << 16 >> 16)
        r += 2
      }
      h = mix(h, x)
      onCount += f & 1
    }
    let y: i32 = 0
    for (let i = 0; i < np; i++) {
      const f: i32 = unchecked(flagBuf[i])
      if ((f & 0x04) !== 0) {
        const d: i32 = unchecked(stream[r++])
        y = (f & 0x20) !== 0 ? y + d : y - d
      } else if ((f & 0x20) === 0) {
        // same i32-local workaround as the x pass above
        const hi: i32 = unchecked(stream[r])
        const lo: i32 = unchecked(stream[r + 1])
        y = y + (((hi << 8) | lo) << 16 >> 16)
        r += 2
      }
      h = mix(h, y)
    }
    h = mix(h, onCount)
  }
  return h
}

function runKernel(stream: Uint8Array, glyphOff: Int32Array, glyphPts: Int32Array, flagBuf: Uint8Array): i32 {
  let h: i32 = 0
  for (let it = 0; it < N_ITERS; it++) h = mix(h, parseAll(stream, glyphOff, glyphPts, flagBuf))
  return h
}

export function main(): void {
  const stream = new Uint8Array(STREAM_CAP)
  const glyphOff = new Int32Array(NG)
  const glyphPts = new Int32Array(NG)
  const flagBuf = new Uint8Array(MAXPTS)
  const rng = new Int32Array(1)
  buildStream(stream, glyphOff, glyphPts, rng)

  let acc: i32 = 0
  for (let i = 0; i < N_WARMUP; i++) acc = mix(acc, runKernel(stream, glyphOff, glyphPts, flagBuf))

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    acc = mix(acc, runKernel(stream, glyphOff, glyphPts, flagBuf))
    unchecked(samples[i] = perfNow() - t0)
  }

  const sorted = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) unchecked(sorted[i] = samples[i])
  for (let i = 1; i < N_RUNS; i++) {
    const v = unchecked(sorted[i])
    let j = i - 1
    while (j >= 0 && unchecked(sorted[j]) > v) {
      unchecked(sorted[j + 1] = sorted[j])
      j--
    }
    unchecked(sorted[j + 1] = v)
  }
  const medianMs = unchecked(sorted[(N_RUNS - 1) >> 1])
  logLine(<i32>(medianMs * 1000.0), <u32>acc, NG * N_ITERS, 1, N_RUNS)
}
