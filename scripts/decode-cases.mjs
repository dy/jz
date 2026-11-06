// The @audio/decode bench cases (bench/decode-<codec>/decode-<codec>.js): a decoder
// of the family bundled into one file by esbuild (scope-hoisted, unminified: the
// package's own code with the module seams gone, nothing rewritten), then a driver
// that times whole decodes. Inputs are made outside the timed region: in the program
// (WAV's PCM, DSD's sigma-delta stream) or embedded as base64 from the family's own
// encoders and fixtures (QOA, ALAC, TTA), so every target decodes the same bytes.
//
//   node scripts/decode-cases.mjs [family=../@audio]
//
// Regenerate the cases here, never edit them.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FAMILY = resolve(process.argv[2] ?? join(ROOT, '../@audio'))
const DEC = join(FAMILY, 'decode/packages'), ENC = join(FAMILY, 'encode/packages')
const rev = execFileSync('git', ['-C', join(FAMILY, 'decode'), 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()

// The bench signal: a tone stack with shaped noise, a pulse on the right (bench/_audiojs/lib.mjs).
const signal = (n, sr = 44100) => {
  const L = new Float32Array(n), R = new Float32Array(n)
  let seed = 0x9e3779b9 >>> 0, lp = 0
  const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1 }
  for (let i = 0; i < n; i++) {
    const t = i / sr, tone = 0.25 * Math.sin(2 * Math.PI * 220 * t) + 0.18 * Math.sin(2 * Math.PI * 440 * t) + 0.12 * Math.sin(2 * Math.PI * 880 * t)
    lp = lp * 0.96 + rand() * 0.04
    const noise = lp * 0.5, phase = (t * 2) % 1, kick = Math.exp(-phase * 40) * Math.sin(2 * Math.PI * 60 * t) * 0.6
    L[i] = tone + noise
    R[i] = 0.25 * Math.sin(2 * Math.PI * 221 * t) + 0.18 * Math.sin(2 * Math.PI * 442 * t) + noise + kick
  }
  return [L, R]
}
const concat = (parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length } return out }
const b64 = (bytes) => Buffer.from(bytes).toString('base64')
// a base64 string as one literal (a chain of `+` that wrapped it ran the compiler out of stack)
const literal = (bytes) => `'${b64(bytes)}'`

/** One package entry bundled; its export named `name` bound to `as`. */
async function bundle(entry, name, as) {
  const { build } = await import('esbuild')
  const r = await build({
    stdin: { contents: `export { ${name} } from '${entry}'`, resolveDir: dirname(entry), loader: 'js', sourcefile: 'entry.js' },
    bundle: true, format: 'esm', platform: 'neutral', target: 'es2020', write: false, minify: false, legalComments: 'none',
    mainFields: ['module', 'main'],
  })
  const js = r.outputFiles[0].text
  const tail = js.match(new RegExp(`\\nexport \\{\\s*(\\w+) as ${name}\\s*\\};?\\s*$`)) ?? js.match(new RegExp(`\\nexport \\{\\s*(${name})\\s*\\};?\\s*$`))
  if (!tail) throw new Error(`${entry}: no export ${name} in the bundle`)
  return js.slice(0, tail.index).trim() + (tail[1] === as ? '' : `\n\nconst ${as} = ${tail[1]}`)
}

// The driver every case shares: the decode timed N_RUNS times after N_WARMUP, its
// channels hashed (every 128th word of each channel, the channels mixed in order).
const driver = ({ input, decode, reps }) => `
const N_RUNS = 21
const N_WARMUP = 5
const REPS = ${reps}

${input}

const checksum = (channels) => {
  let h = 0x811c9dc5 | 0
  for (let c = 0; c < channels.length; c++) h = mix(h, checksumU32(new Uint32Array(channels[c].buffer, channels[c].byteOffset, channels[c].length)))
  return h >>> 0
}

const run = () => {
  const src = input()
  let out = null
  const once = () => { for (let r = 0; r < REPS; r++) out = ${decode} }
  for (let i = 0; i < N_WARMUP; i++) once()
  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    once()
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksum(out.channelData), out.channelData.length * out.channelData[0].length * REPS, 1, N_RUNS)
}

export { run as main }
`

// base64 to bytes, in the program: the embedded inputs are decoded before the timed region
const UNBASE64 = `const unbase64 = (s) => {
  const t = new Uint8Array(128), A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  for (let i = 0; i < 64; i++) t[A.charCodeAt(i)] = i
  const pad = s.charCodeAt(s.length - 1) === 61 ? s.charCodeAt(s.length - 2) === 61 ? 2 : 1 : 0
  const n = (s.length >> 2) * 3 - pad, out = new Uint8Array(n)
  for (let i = 0, o = 0; i < s.length; i += 4) {
    const v = t[s.charCodeAt(i)] << 18 | t[s.charCodeAt(i + 1)] << 12 | t[s.charCodeAt(i + 2)] << 6 | t[s.charCodeAt(i + 3)]
    if (o < n) out[o++] = v >> 16 & 255
    if (o < n) out[o++] = v >> 8 & 255
    if (o < n) out[o++] = v & 255
  }
  return out
}`

const header = (id, what, pkg, license, inputs) => `// ${id}.js — ${what}: ${pkg} from @audio/decode ${rev} (${license}), bundled by
// scripts/decode-cases.mjs: the package's own code with the module seams gone, nothing
// rewritten. ${inputs}
// Regenerate the case there, never edit it.
import { checksumU32, medianUs, mix, printResult } from '../_lib/benchlib.js'
`

const CASES = {
  async 'decode-wav'() {
    const code = await bundle(join(DEC, 'decode-wav/decode-wav.js'), 'default', 'decode')
    // a 16-bit stereo WAV of the bench signal, 10 s at 44.1 kHz, written in the program
    const input = `const input = () => {
  const n = 441000, data = n * 4, b = new Uint8Array(44 + data), dv = new DataView(b.buffer)
  const tag = (o, s) => { for (let i = 0; i < 4; i++) b[o + i] = s.charCodeAt(i) }
  tag(0, 'RIFF'); dv.setUint32(4, 36 + data, true); tag(8, 'WAVE'); tag(12, 'fmt ')
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, 44100, true)
  dv.setUint32(28, 44100 * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); tag(36, 'data'); dv.setUint32(40, data, true)
  let s = 0x1234abcd | 0, lp = 0
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    lp = lp * 0.96 + ((s >>> 0) / 4294967296 * 2 - 1) * 0.04
    const t = i / 44100, l = 0.4 * Math.sin(2 * Math.PI * 220 * t) + lp, r = 0.4 * Math.sin(2 * Math.PI * 330 * t) - lp
    dv.setInt16(44 + i * 4, Math.round(l * 32767), true); dv.setInt16(46 + i * 4, Math.round(r * 32767), true)
  }
  return b
}`
    return header('decode-wav', 'WAV decode, 16-bit stereo PCM', '@audio/decode-wav', 'MIT',
      'Input: a 10 s 16-bit stereo WAV the program writes (two tones over shaped noise).') +
      `\n${code}\n${driver({ input, decode: 'decode(src)', reps: 1 })}`
  },

  async 'decode-qoa'() {
    const code = await bundle(join(DEC, 'decode-qoa/decode-qoa.js'), 'default', 'decode')
    const { default: qoa } = await import(pathToFileURL(join(ENC, 'encode-qoa/qoa-encode.js')))
    const enc = await qoa({ sampleRate: 44100 }), head = enc.encode(signal(88200)), file = concat([head, enc.flush()].filter(b => b?.length))
    return header('decode-qoa', 'QOA decode, stereo', '@audio/decode-qoa (with qoa-format)', 'MIT',
      `Input: 2 s of the bench signal encoded by @audio/encode-qoa (${file.length} bytes), embedded.`) +
      `\n${code}\n\n${UNBASE64}\n${driver({ input: `const QOA =\n  ${literal(file)}\nconst input = () => unbase64(QOA)`, decode: 'decode(src)', reps: 2 })}`
  },

  async 'decode-tta'() {
    const code = await bundle(join(DEC, 'decode-tta/decode-tta.js'), 'default', 'decode')
    const file = new Uint8Array(readFileSync(join(DEC, 'decode-tta/fixtures/stereo16.tta')))
    return header('decode-tta', 'TTA decode, 16-bit stereo', '@audio/decode-tta', 'MIT',
      `Input: the package's fixture stereo16.tta (${file.length} bytes), embedded.`) +
      `\n${code}\n\n${UNBASE64}\n${driver({ input: `const TTA =\n  ${literal(file)}\nconst input = () => unbase64(TTA)`, decode: 'decode(src)', reps: 4 })}`
  },

  async 'decode-alac'() {
    // alac.js is the decoder alone: a port of Apple's reference decoder under its own Apache-2.0 notice
    const code = await bundle(join(DEC, 'decode-aac/alac.js'), 'createALAC', 'createALAC')
    const { createAlacEncoder } = await import(pathToFileURL(join(ENC, 'encode-alac/core.js')))
    const enc = createAlacEncoder({ sampleRate: 44100, channels: 2, bitDepth: 16 })
    const frames = [...enc.encode(signal(44100).map(c => Int32Array.from(c, x => Math.max(-32768, Math.min(32767, Math.round(x * 32768)))))), ...enc.flush()]
    const cookie = enc.cookie.subarray(enc.cookie.length - 24), offs = [0]
    for (const f of frames) offs.push(offs[offs.length - 1] + f.length)
    const input = `const ALAC =\n  ${literal(concat(frames))}\nconst COOKIE = '${b64(cookie)}'
const OFFS = new Int32Array([${offs.join(', ')}])
const input = () => ({ cookie: unbase64(COOKIE), bytes: unbase64(ALAC) })
// the frames decoded in turn into one planar output, as the family's decode-aac does
const decodeAll = (src) => {
  const dec = createALAC(src.cookie), n = OFFS.length - 1, ch = dec.config.numChannels, N = dec.config.frameLength
  const out = []
  let len = 0
  for (let c = 0; c < ch; c++) out.push(new Float32Array(n * N))
  for (let i = 0; i < n; i++) {
    const r = dec.decodeFrame(src.bytes.subarray(OFFS[i], OFFS[i + 1]))
    for (let c = 0; c < ch; c++) out[c].set(r.channelData[c], len)
    len += r.numSamples
  }
  return { channelData: out.map(o => o.subarray(0, len)), sampleRate: dec.config.sampleRate }
}`
    return header('decode-alac', 'ALAC decode, 16-bit stereo', 'the ALAC decoder of @audio/decode-aac (alac.js)', 'Apache-2.0, a port of Apple\'s ALAC reference decoder',
      `Input: 1 s of the bench signal encoded by @audio/encode-alac's core (${frames.length} frames), embedded.`) +
      `\n${code}\n\n${UNBASE64}\n${driver({ input, decode: 'decodeAll(src)', reps: 1 })}`
  },

  async 'decode-dsd'() {
    const code = await bundle(join(DEC, 'decode-dsd/decode-dsd.js'), 'default', 'decode')
    // a DSF of two tones through a second-order sigma-delta modulator, written in the program (decode-dsd's test writer)
    const input = `const input = () => {
  const rate = 2822400, n = rate >> 2, block = 4096, nb = Math.ceil((n >> 3) / block)
  const data = new Uint8Array(nb * block * 2)
  for (let c = 0; c < 2; c++) {
    let x1 = 0, x2 = 0, y = -1
    for (let i = 0; i < n; i++) {
      const xin = 0.5 * Math.sin(2 * Math.PI * (c ? 1500 : 1000) * i / rate)
      x1 += xin - y; x2 += x1 - y; y = x2 >= 0 ? 1 : -1
      const byte = i >> 3
      if (y > 0) data[(((byte / block) | 0) * 2 + c) * block + byte % block] |= 1 << (i & 7)
    }
  }
  const b = new Uint8Array(28 + 52 + 12 + data.length), dv = new DataView(b.buffer)
  const tag = (o, s) => { for (let i = 0; i < 4; i++) b[o + i] = s.charCodeAt(i) }
  const u64 = (o, v) => { dv.setUint32(o, v >>> 0, true); dv.setUint32(o + 4, Math.floor(v / 4294967296), true) }
  tag(0, 'DSD '); u64(4, 28); u64(12, b.length); u64(20, 0)
  tag(28, 'fmt '); u64(32, 52); dv.setUint32(40, 1, true); dv.setUint32(44, 0, true); dv.setUint32(48, 2, true); dv.setUint32(52, 2, true)
  dv.setUint32(56, rate, true); dv.setUint32(60, 1, true); u64(64, n); dv.setUint32(72, block, true); dv.setUint32(76, 0, true)
  tag(80, 'data'); u64(84, 12 + data.length); b.set(data, 92)
  return b
}`
    return header('decode-dsd', 'DSD decode, DSF DSD64 stereo to 88.2 kHz PCM', '@audio/decode-dsd', 'MIT',
      'Input: a 0.25 s DSD64 DSF of two tones through a second-order sigma-delta modulator, written in the program.') +
      `\n${code}\n${driver({ input, decode: 'decode(src, { sampleRate: 88200 })', reps: 1 })}`
  },
}

for (const [id, make] of Object.entries(CASES)) {
  const dir = join(ROOT, 'bench', id)
  mkdirSync(dir, { recursive: true })
  const src = await make()
  writeFileSync(join(dir, id + '.js'), src)
  console.log(`${id}: ${(src.length / 1024).toFixed(0)} KB`)
}
