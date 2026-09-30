// The hot kernels of audio's cross-tool bench (audio/bench/bench.js), taken from the real
// packages and run two ways: as JavaScript under V8 and as jz wasm. Package sources are
// unchanged; each kernel gets a small entry that fixes the ABI (what the host calls), and the
// same entry file is the JS baseline.
//
//   node bench/_audiojs/kernels.mjs            all kernels
//   node bench/_audiojs/kernels.mjs fft mel    named kernels
//
// Compile and compare the unchanged packages. A failed build, run or comparison
// fails this command. SPEED=0 runs correctness checks without timing.
//
// Each kernel is compiled at jz's default level and at optimize: 'speed', and the three
// contenders are timed interleaved in one process. JZ_OPT narrows the run to one level.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AUDIO, FAMILY, OPT, build, instantiate, measure, signal, us, ratio, table, commit } from './lib.mjs'
import { agreement, exactAgreement, channelsAgree, agrees } from './compare.mjs'

const lift = (file, from, to) => { const s = readFileSync(join(AUDIO, file), 'utf8'), a = s.indexOf(from), b = s.indexOf(to, a); if (a < 0 || b < 0) throw new Error(`lift: ${file} no longer has "${from}" … "${to}"`); return s.slice(a, b) }
// ── Kernels ─────────────────────────────────────────────────────────────────────────────
// entry: the module both contenders run. drive(js, wz, memory) → { js, jz, check } where
// js and jz run one timed pass and check() returns the agreement of their results.
const BS = 1024
const live = (memory, get) => { let v = get(); return () => v.buffer === memory.buffer ? v : (v = get()) }

const KERNELS = {
  kweight: {
    what: 'K-weighting mean square, BS.1770 inner loop (@audio/weighting-k), 256×1024 stereo',
    rows: 'every decode and stat row',
    entry: `import kWeighting from '@audio/weighting-k'
let k = { fs: 44100 }, out = new Float64Array(2)
let L = new Float32Array(${BS}), R = new Float32Array(${BS})
export let bufL = () => L
export let bufR = () => R
export let run = () => kWeighting.ms([L, R], k, out)`,
    drive(js, wz, memory) {
      const NB = 256, [L, R] = signal(BS * NB)
      const jl = js.bufL(), jr = js.bufR(), wl = live(memory, wz.bufL), wr = live(memory, wz.bufR)
      const blk = (a, b) => a.subarray(b * BS, b * BS + BS)
      const A = new Float64Array(NB * 2), B = new Float64Array(NB * 2)
      for (let b = 0; b < NB; b++) {
        jl.set(blk(L, b)); jr.set(blk(R, b)); A.set(js.run(), b * 2)
        wl().set(blk(L, b)); wr().set(blk(R, b)); B.set(wz.run(), b * 2)
      }
      return {
        js: () => { for (let b = 0; b < NB; b++) { jl.set(blk(L, b)); jr.set(blk(R, b)); js.run() } },
        jz: () => { for (let b = 0; b < NB; b++) { wl().set(blk(L, b)); wr().set(blk(R, b)); wz.run() } },
        check: () => agreement(A, B),
      }
    },
  },

  'kweight-host': {
    what: 'the same kernel on blocks the host passes in (allocated in wasm memory, no copy)',
    rows: 'every decode and stat row',
    entry: `import kWeighting from '@audio/weighting-k'
let k = { fs: 44100 }, out = new Float64Array(2)
export let run = (l, r) => kWeighting.ms([l, r], k, out)`,
    drive(js, wz, memory) {
      const NB = 256, [L, R] = signal(BS * NB)
      const pl = memory.allocTyped(Float32Array, BS), pr = memory.allocTyped(Float32Array, BS)
      const pv = b => b.view.buffer === memory.buffer ? b.view : (b.view = memory.read(b.box))
      const blk = (a, b) => a.subarray(b * BS, b * BS + BS)
      const A = new Float64Array(NB * 2), B = new Float64Array(NB * 2)
      for (let b = 0; b < NB; b++) {
        A.set(js.run(blk(L, b), blk(R, b)), b * 2)
        pv(pl).set(blk(L, b)); pv(pr).set(blk(R, b)); B.set(wz.run(pl.box, pr.box), b * 2)
      }
      return {
        js: () => { for (let b = 0; b < NB; b++) js.run(blk(L, b), blk(R, b)) },
        jz: () => { for (let b = 0; b < NB; b++) { pv(pl).set(blk(L, b)); pv(pr).set(blk(R, b)); wz.run(pl.box, pr.box) } },
        check: () => agreement(A, B),
      }
    },
  },

  statcore: {
    what: 'block stats: min, max, dc, clipping, ms, correlation (audio/fn/stat.js core), 256×1024 stereo',
    rows: 'every decode and stat row',
    entry: () => lift('core.js', 'export const FULL =', '\n') + '\n' + lift('fn/stat.js', 'const FULL2 =', "audio.stat('min'") + `
let L = new Float32Array(${BS}), R = new Float32Array(${BS}), out = new Float64Array(11)
export let bufL = () => L
export let bufR = () => R
export let run = () => {
  let r = core([L, R])
  out[0] = r.min[0]; out[1] = r.min[1]; out[2] = r.max[0]; out[3] = r.max[1]; out[4] = r.dc[0]; out[5] = r.dc[1]
  out[6] = r.clipping[0]; out[7] = r.clipping[1]; out[8] = r.ms[0]; out[9] = r.ms[1]; out[10] = r.correlation
  return out
}`,
    drive(js, wz, memory) {
      const NB = 256, [L, R] = signal(BS * NB)
      const jl = js.bufL(), jr = js.bufR(), wl = live(memory, wz.bufL), wr = live(memory, wz.bufR)
      const blk = (a, b) => a.subarray(b * BS, b * BS + BS)
      const A = new Float64Array(NB * 11), B = new Float64Array(NB * 11)
      for (let b = 0; b < NB; b++) {
        jl.set(blk(L, b)); jr.set(blk(R, b)); A.set(js.run(), b * 11)
        wl().set(blk(L, b)); wr().set(blk(R, b)); B.set(wz.run(), b * 11)
      }
      return {
        js: () => { for (let b = 0; b < NB; b++) { jl.set(blk(L, b)); jr.set(blk(R, b)); js.run() } },
        // the record and its five arrays are allocated per block, as in JS: dropped once per pass
        jz: () => { for (let b = 0; b < NB; b++) { wl().set(blk(L, b)); wr().set(blk(R, b)); wz.run() } memory.reset() },
        check: () => agreement(A, B),
      }
    },
  },

  'decode-wav': {
    what: 'WAV decode, 16-bit stereo, 10 s in one buffer (@audio/decode-wav)',
    rows: 'wav decode, and every row that reads the fixture',
    entry: `export { default as decode } from '@audio/decode-wav'`,
    async drive(js, wz, memory) {
      const wav = await wavFile(16)
      const ref = js.decode(wav), got = wz.decode(wav)
      const note = channelsAgree(ref.channelData, got.channelData)
      memory.reset()
      return { js: () => js.decode(wav), jz: () => { wz.decode(wav); memory.reset() }, check: () => note }
    },
  },

  'encode-wav': {
    what: 'WAV encode, stereo, 6×65536 frames, streamed (@audio/encode-wav)',
    rows: 'normalize, resample, stretch, pitch (every row that writes a file)',
    // the host cannot call closures returned inside an object: the instance stays in the module
    entry: `import wav from '@audio/encode-wav'
let enc = null
export let open = async (sampleRate, bitDepth) => { enc = await wav({ sampleRate, bitDepth, stream: true }); return 1 }
export let encode = (l, r) => enc.encode([l, r])`,
    variants: [16, 24, 32], labels: { 16: '16-bit', 24: '24-bit', 32: 'float' },
    async drive(js, wz, memory, bits) {
      const BLK = 65536, [L, R] = signal(BLK * 6)
      await js.open(44100, bits); await wz.open(44100, bits)
      const l = memory.allocTyped(Float32Array, BLK), r = memory.allocTyped(Float32Array, BLK)
      const pv = b => b.view.buffer === memory.buffer ? b.view : (b.view = memory.read(b.box))
      let note = 'bit-exact'
      for (let o = 0; o + BLK <= L.length; o += BLK) {
        const a = js.encode(L.subarray(o, o + BLK), R.subarray(o, o + BLK))
        pv(l).set(L.subarray(o, o + BLK)); pv(r).set(R.subarray(o, o + BLK))
        const g = exactAgreement(a, wz.encode(l.box, r.box))
        if (g !== 'bit-exact') note = g
      }
      return {
        js: () => { for (let o = 0; o + BLK <= L.length; o += BLK) js.encode(L.subarray(o, o + BLK), R.subarray(o, o + BLK)) },
        jz: () => { for (let o = 0; o + BLK <= L.length; o += BLK) { pv(l).set(L.subarray(o, o + BLK)); pv(r).set(R.subarray(o, o + BLK)); wz.encode(l.box, r.box) } },
        check: () => note, rounds: 16,
      }
    },
  },

  alac: {
    what: 'ALAC encode, 16-bit stereo, 2 s, pure-JS port of the reference encoder (@audio/encode-alac core)',
    rows: 'none: a compressed codec written in JavaScript, where the WAV pair is a copy',
    // frames are counted and folded into one checksum inside the module: an array of frames is not compared across the boundary
    entry: () => `import { createAlacEncoder } from '${join(FAMILY, 'encode/packages/encode-alac/core.js')}'
let enc = null, out = new Float64Array(3)
export let open = () => { enc = createAlacEncoder({ sampleRate: 44100, channels: 2, bitDepth: 16 }); return 1 }
export let encode = (l, r) => {
  let frames = enc.encode([l, r]), bytes = 0, h = 2166136261
  for (let f of frames) { bytes += f.length; for (let i = 0; i < f.length; i++) h = Math.imul(h ^ f[i], 16777619) >>> 0 }
  out[0] = frames.length; out[1] = bytes; out[2] = h
  return out
}`,
    drive(js, wz, memory) {
      const N = 88200, [L, R] = signal(N)
      js.open(); wz.open()
      const l = memory.allocTyped(Float32Array, N), r = memory.allocTyped(Float32Array, N)
      const pv = b => b.view.buffer === memory.buffer ? b.view : (b.view = memory.read(b.box))
      pv(l).set(L); pv(r).set(R)
      const a = [...js.encode(L, R)], g = [...wz.encode(l.box, r.box)]
      const note = a.join() === g.join() ? `same bytes (${a[0]} frames, ${a[1]} B)` : `js ${a.join(' ')}, jz ${g.join(' ')}`
      return {
        js: () => { js.open(); js.encode(L, R) },
        jz: () => { wz.open(); pv(l).set(L); pv(r).set(R); wz.encode(l.box, r.box) },
        check: () => note, rounds: 12, warm: 3,
      }
    },
  },

  tta: {
    what: 'TTA decode, 16-bit stereo fixture, pure JavaScript (@audio/decode-tta)',
    rows: 'none: a compressed codec written in JavaScript',
    entry: () => `export { default as decode } from '${join(FAMILY, 'decode/packages/decode-tta/decode-tta.js')}'`,
    drive(js, wz, memory) {
      const file = new Uint8Array(readFileSync(join(FAMILY, 'decode/packages/decode-tta/fixtures/multiframe16.tta')))
      const ref = js.decode(file), got = wz.decode(file)
      const note = channelsAgree(ref.channelData, got.channelData)
      memory.reset()
      return { js: () => js.decode(file), jz: () => { wz.decode(file); memory.reset() }, check: () => note, rounds: 20 }
    },
  },

  fft: {
    what: 'FFT 2048 (fourier-transform): magnitude spectrum; forward + inverse round trip, 64 frames',
    rows: 'fft, mfcc, beat, stretch, pitch',
    // `rfft(x, out)`, the optional output buffer, traps today, so the internal buffer is read
    entry: `import rfft, { fft, ifft } from 'fourier-transform'
let inp = new Float64Array(2048)
export let input = () => inp
export let spectrum = () => rfft(inp)
export let roundtrip = () => { let c = fft(inp); return ifft(c[0], c[1]) }`,
    variants: ['spectrum', 'roundtrip'], labels: { spectrum: 'magnitude', roundtrip: 'forward + inverse' },
    drive(js, wz, memory, fn) {
      const N = 2048, FR = 64, [L] = signal(N * FR)
      const ji = js.input(), wi = live(memory, wz.input)
      ji.set(L.subarray(0, N)); wi().set(L.subarray(0, N))
      const note = agreement(js[fn]().slice(), wz[fn]().slice())
      return {
        js: () => { for (let f = 0; f < FR; f++) { ji.set(L.subarray(f * N, f * N + N)); js[fn]() } },
        jz: () => { for (let f = 0; f < FR; f++) { wi().set(L.subarray(f * N, f * N + N)); wz[fn]() } },
        check: () => note,
      }
    },
  },

  stretch: {
    what: 'phase-locked vocoder time stretch ×0.8, 2 s mono (@audio/stretch-pvoc-lock + stft + spectral-pvoc)',
    rows: 'stretch, pitch',
    entry: `import pvocLock from '@audio/stretch-pvoc-lock'
let inp = new Float32Array(88200)
export let input = () => inp
export let run = (factor) => pvocLock(inp, { factor, fs: 44100, sampleRate: 44100 })`,
    drive(js, wz, memory) {
      const [L] = signal(88200)
      js.input().set(L); wz.input().set(L)
      const note = agreement(js.run(0.8), wz.run(0.8))
      memory.reset(); wz.input().set(L)
      return { js: () => js.run(0.8), jz: () => { wz.run(0.8); memory.reset() }, check: () => note, rounds: 12, warm: 3 }
    },
  },

  tempo: {
    what: 'comb-filter tempo, 10 s mono (@audio/beat-tempo: spectral flux + comb)',
    rows: 'beat',
    entry: `import combTempo from '@audio/beat-tempo/comb'
let inp = new Float32Array(441000)
export let input = () => inp
export let run = () => combTempo(inp, { fs: 44100 }).bpm`,
    drive(js, wz, memory) {
      const [, R] = signal(441000)
      js.input().set(R); wz.input().set(R)
      const a = js.run(), b = wz.run()
      memory.reset(); wz.input().set(R)
      return { js: () => js.run(), jz: () => { wz.run(); memory.reset(); }, check: () => a === b ? `same (${a} bpm)` : `js ${a} bpm, jz ${b} bpm`, rounds: 8, warm: 2 }
    },
  },

  resample: {
    what: 'linear-interpolation resample 44.1k→48k, 1 s mono (audio/plan.js resample)',
    rows: 'resample',
    entry: () => lift('plan.js', '/** Linear interpolation resample', '// Instances currently being rendered') + `
let SRC = new Float32Array(44102), DST = new Float32Array(48000)
export let src = () => SRC
export let run = () => { resample(SRC, DST, 0, 48000, 44100 / 48000, 0); return DST }`,
    drive(js, wz) {
      const [L] = signal(44102)
      js.src().set(L); wz.src().set(L)
      const note = agreement(js.run().slice(), wz.run().slice())
      return { js: () => js.run(), jz: () => wz.run(), check: () => note, rounds: 80 }
    },
  },

  mel: {
    what: 'mel spectrum (40 bands) and MFCC (13), 64×1024 (audio/fn/spectrum.js, cepstrum.js cores)',
    rows: 'fft, mfcc',
    entry: () => lift('fn/spectrum.js', "import fft from 'fourier-transform'", '// ── Block analysis helper') + lift('fn/cepstrum.js', '/**\n * Compute MFCCs', '// ── Stat registration') + `
let blk = new Float32Array(1024)
export let input = () => blk
export let mel = () => melSpectrum(blk, 44100, { bins: 40, weight: false })
export let cep = () => mfcc(blk, 44100, { bins: 13 })`,
    variants: ['mel', 'cep'], labels: { mel: 'spectrum', cep: 'mfcc' },
    drive(js, wz, memory, fn) {
      const NB = 64, [L] = signal(1024 * NB)
      const ji = js.input(), wi = live(memory, wz.input)
      ji.set(L.subarray(0, 1024)); wi().set(L.subarray(0, 1024))
      const note = agreement(js[fn]().slice(), wz[fn]().slice())
      return {
        js: () => { for (let f = 0; f < NB; f++) { ji.set(L.subarray(f * 1024, f * 1024 + 1024)); js[fn]() } },
        jz: () => { for (let f = 0; f < NB; f++) { wi().set(L.subarray(f * 1024, f * 1024 + 1024)); wz[fn]() } },
        check: () => note,
      }
    },
  },
}

async function wavFile(bits, sec = 10) {
  const { default: wav } = await import(pathToFileURL(join(AUDIO, 'node_modules/@audio/encode-wav/wav-encode.js')))
  const enc = await wav({ sampleRate: 44100, bitDepth: bits })
  enc.encode(signal(sec * 44100))
  return enc.flush()
}

const first = e => String(e?.message ?? e).split('\n')[0].slice(0, 140)
const want = process.argv.slice(2)
for (const id of want) if (!(id in KERNELS)) throw new Error(`Unknown audio kernel: ${id}`)
const LEVELS = OPT ? [OPT] : ['default', 'speed']
const rows = []
const timing = process.env.SPEED !== '0'
let failed = false
const c = await commit()
console.log(`jz ${c.jz}, audio ${c.audio}, node ${process.version}\n`)

for (const [id, k] of Object.entries(KERNELS)) {
  if (want.length && !want.includes(id)) continue
  console.error(`audio kernel: ${id}`)
  const builds = []
  try { for (const l of LEVELS) builds.push(build(typeof k.entry === 'function' ? k.entry() : k.entry, { ...(l !== 'default' && !OPT && { optimize: l }) })) }
  catch (e) { failed = true; rows.push([id, '', ...LEVELS.flatMap(() => ['', '']), `does not compile: ${first(e)}`, '']); continue }
  // a fresh JavaScript instance beside each compiled one: a kernel with state must start from the same state
  const jsFor = i => import(pathToFileURL(builds[0].file) + `?instance=${i}`)
  const kb = builds.map(b => (b.wasm.length / 1024).toFixed(0)).join(' / ') + ' KB'
  for (const v of k.variants || [undefined]) {
    const name = v === undefined ? id : `${id} ${k.labels[v]}`
    try {
      const fns = {}, checks = []
      let rounds = 40, warm = 6
      for (let i = 0; i < builds.length; i++) {
        const { exports: wz, memory } = instantiate(builds[i].wasm)
        const d = await k.drive(await jsFor(`${v ?? ''}-${i}`), wz, memory, v)
        fns.js ??= d.js
        fns[LEVELS[i]] = d.jz
        checks.push(d.check())
        rounds = d.rounds ?? rounds; warm = d.warm ?? warm
      }
      const correct = checks.every(agrees)
      if (!correct) failed = true
      const t = timing && correct ? measure(fns, { rounds, warm, budget: 12000 }) : null
      rows.push([name, t ? us(t.js) : '', ...LEVELS.flatMap(l => t ? [us(t[l]), ratio(t.js, t[l])] : ['', '']), [...new Set(checks)].join(' / '), kb])
    } catch (e) { failed = true; rows.push([name, '', ...LEVELS.flatMap(() => ['', '']), `fails at run: ${first(e)}`, kb]) }
  }
}
table(['kernel', 'V8', ...LEVELS.flatMap(l => [`jz, ${l} level`, 'against V8']), 'agreement', 'wasm'], rows)
if (timing) console.log('\nAgainst V8: V8 time over jz time, above 1× jz is faster. Times are the minimum of interleaved runs.')
for (const [id, k] of Object.entries(KERNELS)) if (!want.length || want.includes(id)) console.log(`  ${id}: ${k.what}. Bench rows: ${k.rows}`)
process.exitCode = failed ? 1 : 0
