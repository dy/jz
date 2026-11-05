// Every @audio/decode codec written in JavaScript, run as JavaScript under V8 and as jz wasm.
// Package sources unchanged; the entry re-exports the package's own `decode`, and the same
// entry file is the JS baseline. Inputs are made by the family's own encoders (or the
// package's fixtures) outside the timer.
//
//   node bench/_audiojs/decoders.mjs           every case
//   node bench/_audiojs/decoders.mjs tta qoa   cases whose id starts with a name
//
// Each case runs in a fresh process: in one process, the V8 speculative wasm inlining a
// later case gets depends on the cases before it (CAF float32: 1.0× alone, 0.56× after pcm16).
//
// Codecs that are C compiled to wasm (aac, ac3, amr, ape, dts, eac3, flac, gsm, mod, mp3,
// mpc, opus, vorbis, wavpack, wma) are not here: there is no JavaScript to compile. The
// containers (avi, mp4, webm) are async and dispatch to those codecs by dynamic import().
//
// A failed build, run or comparison fails this command. SPEED=0 checks without timing.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FAMILY, OPT, build, instantiate, measure, signal, us, ratio, table, commit, scratch } from './lib.mjs'
import { channelsAgree, agrees } from './compare.mjs'

const DEC = join(FAMILY, 'decode/packages'), ENC = join(FAMILY, 'encode/packages')
const fixture = (pkg, f) => new Uint8Array(readFileSync(join(DEC, pkg, 'fixtures', f)))
const encoder = async (fmt, opts, sec = 10) => {
  const { default: enc } = await import(pathToFileURL(join(ENC, `encode-${fmt}/${fmt}-encode.js`)))
  const e = await enc({ sampleRate: 44100, ...opts })
  const head = e.encode(signal(sec * 44100)), tail = e.flush()
  return concat([head, tail].filter(b => b?.length))
}
const concat = parts => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

// DSF stream from decode-dsd's own test writer (2nd-order sigma-delta, DSF container), lifted verbatim.
async function dsf(sec) {
  const src = readFileSync(join(DEC, 'decode-dsd/test.js'), 'utf8')
  const lift = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error(`dsd test.js no longer has "${a}"`); return src.slice(i, j) }
  const file = join(scratch('jz-dsd-'), 'dsf.mjs')
  writeFileSync(file, lift('function concat', '// ── 5th-order') + lift('// bit[0] is the oldest', '// ── DFF') +
    'export { modulate2, buildDsf }')
  const { modulate2, buildDsf } = await import(pathToFileURL(file))
  const tone = f => t => 0.5 * Math.sin(2 * Math.PI * f * t)
  return buildDsf({ dsdRate: 2822400, bitsPerSample: 1, channelBits: [modulate2(2822400, sec, tone(1000)), modulate2(2822400, sec, tone(1500))] })
}

// ALAC frames from encode-alac's core: one buffer of frames plus their offsets.
async function alacStream(bitDepth, sec = 10) {
  const { createAlacEncoder } = await import(pathToFileURL(join(ENC, 'encode-alac/core.js')))
  const scale = 2 ** (bitDepth - 1), enc = createAlacEncoder({ sampleRate: 44100, channels: 2, bitDepth })
  const frames = [...enc.encode(signal(sec * 44100).map(c => Int32Array.from(c, x => Math.max(-scale, Math.min(scale - 1, Math.round(x * scale)))))), ...enc.flush()]
  const offs = new Int32Array(frames.length + 1)
  frames.forEach((f, i) => offs[i + 1] = offs[i] + f.length)
  const cookie = enc.cookie
  return { cookie: cookie.subarray(cookie.length - 24), bytes: concat(frames), offs }
}

const reexport = pkg => `export { default as decode } from '${join(DEC, pkg, pkg + '.js')}'`
// the host calls decodeFrame per frame through decode-aac: the entry walks the frames itself, a planar result
const ALAC_ENTRY = `import { createALAC } from '${join(DEC, 'decode-aac/alac.js')}'
export function decode(cookie, bytes, offs) {
  let dec = createALAC(cookie), n = offs.length - 1, ch = dec.config.numChannels, N = dec.config.frameLength
  let out = [], len = 0
  for (let c = 0; c < ch; c++) out.push(new Float32Array(n * N))
  for (let i = 0; i < n; i++) {
    let r = dec.decodeFrame(bytes.subarray(offs[i], offs[i + 1]))
    for (let c = 0; c < ch; c++) out[c].set(r.channelData[c], len)
    len += r.numSamples
  }
  return { channelData: out.map(o => o.subarray(0, len)), sampleRate: dec.config.sampleRate }
}`

// id: { pkg | entry, input: async () → args[] }
const CASES = {
  'wav pcm16': { pkg: 'decode-wav', input: async () => [await encoder('wav', { bitDepth: 16 })] },
  'wav pcm24': { pkg: 'decode-wav', input: async () => [await encoder('wav', { bitDepth: 24 })] },
  'wav float32': { pkg: 'decode-wav', input: async () => [await encoder('wav', { bitDepth: 32 })] },
  'wav ima-adpcm': { pkg: 'decode-wav', input: () => [fixture('decode-wav', 'ima_stereo.wav')], inner: 50 },
  'wav ms-adpcm': { pkg: 'decode-wav', input: () => [fixture('decode-wav', 'ms_stereo.wav')], inner: 50 },
  'wav mulaw': { pkg: 'decode-wav', input: () => [fixture('decode-wav', 'mulaw.wav')], inner: 200 },
  'aiff pcm16': { pkg: 'decode-aiff', input: async () => [await encoder('aiff', { bitDepth: 16 })] },
  'aiff pcm24': { pkg: 'decode-aiff', input: async () => [await encoder('aiff', { bitDepth: 24 })] },
  'aiff alaw': { pkg: 'decode-aiff', input: () => [fixture('decode-aiff', 'alaw.aifc')], inner: 200 },
  'caf pcm16': { pkg: 'decode-caf', input: async () => [await encoder('caf', { bitDepth: 16 })] },
  'caf float32': { pkg: 'decode-caf', input: async () => [await encoder('caf', { bitDepth: 32 })] },
  'caf ima4': { pkg: 'decode-caf', input: () => [fixture('decode-caf', 'ima4_stereo.caf')], inner: 20 },
  'qoa': { pkg: 'decode-qoa', input: async () => [await encoder('qoa', {})] },
  'tta 16-bit': { pkg: 'decode-tta', input: () => [fixture('decode-tta', 'multiframe16.tta')] },
  'tta 24-bit': { pkg: 'decode-tta', input: () => [fixture('decode-tta', 'stereo24.tta')] },
  'tta 6ch': { pkg: 'decode-tta', input: () => [fixture('decode-tta', 'surround6.tta')] },
  'dsd dsf64': { pkg: 'decode-dsd', input: async () => [await dsf(2)] },
  'alac 16-bit': { entry: ALAC_ENTRY, input: async () => { const a = await alacStream(16); return [a.cookie, a.bytes, a.offs] } },
  'alac 24-bit': { entry: ALAC_ENTRY, input: async () => { const a = await alacStream(24); return [a.cookie, a.bytes, a.offs] } },
}

const first = e => String(e?.message ?? e).split('\n')[0].slice(0, 160)
const timing = process.env.SPEED !== '0'
const LEVEL = OPT ? { optimize: OPT === '0' ? false : OPT } : {}

// One case in this process: prints its row as JSON. A case shares no process with another,
// since V8's speculative wasm inlining in one module depends on what ran before it.
async function run(id) {
  const k = CASES[id]
  let b
  try { b = build(k.entry ?? reexport(k.pkg), LEVEL) }
  catch (e) { return { ok: false, row: [id, '', '', '', `does not compile: ${first(e)}`, '', ''] } }
  const kb = (b.wasm.length / 1024).toFixed(0) + ' KB'
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(b.wasm)).map(i => i.name).filter(n => /^__(ext|dyn)_/.test(n)).join(' ')
  try {
    const args = await k.input()
    const js = await import(pathToFileURL(b.file))
    const { exports: wz, memory } = instantiate(b.wasm)
    const ref = js.decode(...args), got = wz.decode(...args)
    const note = got.sampleRate !== ref.sampleRate ? `sampleRate ${ref.sampleRate} vs ${got.sampleRate}` : channelsAgree(ref.channelData, got.channelData)
    memory.reset?.()
    if (!agrees(note)) return { ok: false, row: [id, '', '', '', note, kb, imports] }
    const t = timing ? measure({ js: () => js.decode(...args), jz: () => { wz.decode(...args); memory.reset?.() } }, { rounds: 30, warm: 4, inner: k.inner ?? 1, budget: 10000 }) : null
    return { ok: true, row: [id, t ? us(t.js) : '', t ? us(t.jz) : '', t ? ratio(t.js, t.jz) : '', `${note}, ${ref.channelData.length}×${ref.channelData[0]?.length ?? 0}`, kb, imports] }
  } catch (e) { return { ok: false, row: [id, '', '', '', `fails at run: ${first(e)}`, kb, imports] } }
}

if (process.env.DECODER_CASE) {
  console.log(JSON.stringify(await run(process.env.DECODER_CASE)))
} else {
  const { execFileSync } = await import('node:child_process')
  const want = process.argv.slice(2)
  const ids = Object.keys(CASES).filter(id => !want.length || want.some(w => id.startsWith(w)))
  if (!ids.length) throw new Error(`No decoder case matches: ${want.join(' ')}`)
  const git = dir => execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  const c = await commit()
  console.log(`jz ${c.jz}, @audio/decode ${git(join(FAMILY, 'decode'))}, node ${process.version}\n`)
  const rows = []
  let failed = false
  for (const id of ids) {
    console.error(`decoder: ${id}`)
    const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, DECODER_CASE: id }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 24 })
    const r = JSON.parse(out.trim().split('\n').pop())
    if (!r.ok) failed = true
    rows.push(r.row)
  }
  table(['case', 'V8', `jz${OPT ? ` ${OPT}` : ''}`, 'against V8', 'agreement', 'wasm', 'dynamic imports'], rows)
  if (timing) console.log('\nAgainst V8: V8 time over jz time, above 1× jz is faster. Minimum of interleaved runs, one process per case.')
  process.exitCode = failed ? 1 : 0
}
