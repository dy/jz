// Whole-task WAV decode comparison: original audiojs under Node, the same
// decoder compiled by jz, and FFmpeg. Every run starts a process, reads one
// WAV, and writes the complete interleaved f32 PCM file. Verify every output.
//
//   SPEED=0 node bench/_audiojs/ffmpeg.mjs 1       correctness smoke
//   JZ_OPT=speed node bench/_audiojs/ffmpeg.mjs 600 6
// OUT selects the JSON report; defaults to a new file in the system temp dir.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { cpus, endianness, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { machineState } from '../machine-state.mjs'
import { AUDIO, JZ_ROOT, OPT, build, commit, resolveModuleGraph, scratch, signal } from './lib.mjs'

const seconds = Number(process.argv[2] ?? 600), reps = Number(process.argv[3] ?? 6)
if (process.argv.length > 4 || !Number.isFinite(seconds) || seconds <= 0 || seconds > 3600 || !Number.isSafeInteger(reps) || reps < 1)
  throw new Error('Usage: node bench/_audiojs/ffmpeg.mjs [seconds: 0–3600] [reps: positive integer]')
const timing = process.env.SPEED !== '0'
const output = resolve(process.env.OUT || join(tmpdir(), `jz-audio-ffmpeg-${Date.now()}.json`))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const quiet = state => state.load1 != null && state.load1 <= 2 && state.swapUsedMB != null && state.swapUsedMB < 4096
const median = xs => { const sorted = [...xs].sort((a, b) => a - b), i = sorted.length >> 1; return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2 }
const report = {
  at: new Date().toISOString(), task: 'wav_decode_to_f32', seconds, reps: timing ? reps : 0,
  basis: 'fresh process, WAV read + decode + interleave + PCM file write + exit; compilation excluded',
  node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model,
  machine: [], results: {}, correctness: false, performance: 'not measured',
}

try {
  report.provenance = await commit()
  report.optimize = OPT ?? 'default'
  report.ffmpeg = execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0]
  const dir = scratch('jz-audio-ffmpeg-'), wav = join(dir, 'input.wav'), wasm = join(dir, 'decoder.wasm')
  const frames = Math.round(seconds * 44100)
  if (frames < 1) throw new Error('Duration must contain at least one audio frame')
  const { default: encoder } = await import(pathToFileURL(join(AUDIO, 'node_modules/@audio/encode-wav/wav-encode.js')))
  const enc = await encoder({ sampleRate: 44100, bitDepth: 16 })
  enc.encode(signal(frames))
  const inputBytes = enc.flush()
  writeFileSync(wav, inputBytes)
  report.input = { sha256: sha(inputBytes), bytes: inputBytes.length, frames, channels: 2, sampleRate: 44100, bitDepth: 16 }

  const built = build("export { default as decode } from '@audio/decode-wav'", { dir })
  writeFileSync(wasm, built.wasm)
  const graph = resolveModuleGraph(built.file, { resolveNode: true })
  report.sources = Object.fromEntries(Object.entries(graph.modules).map(([file, source]) => [file, sha(source)]))
  report.entrySha256 = sha(graph.code)
  report.wasm = { sha256: sha(built.wasm), bytes: built.wasm.length }
  const worker = fileURLToPath(new URL('./_decode-worker.mjs', import.meta.url))
  const interop = join(JZ_ROOT, 'interop.js'), format = endianness() === 'LE' ? 'f32le' : 'f32be'
  report.outputFormat = format
  const targets = {
    javascript: [process.execPath, [worker, 'javascript', built.file, interop, wav]],
    jz: [process.execPath, [worker, 'jz', wasm, interop, wav]],
    ffmpeg: ['ffmpeg', ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-i', wav, '-map', '0:a:0', '-f', format]],
  }
  let expected
  const run = (name, measured = false) => {
    const previouslyCorrect = report.correctness
    report.correctness = false
    const [bin, args] = targets[name], path = join(dir, `${name}.pcm`)
    const start = performance.now()
    const stdout = execFileSync(bin, [...args, path], { encoding: 'utf8', timeout: 600_000, maxBuffer: 1 << 20 })
    const ms = performance.now() - start
    const bytes = readFileSync(path), digest = sha(bytes)
    if (bytes.length !== frames * 2 * 4) throw new Error(`${name}: wrong PCM length ${bytes.length}`)
    if (name !== 'ffmpeg') {
      const meta = JSON.parse(stdout)
      if (meta.frames !== frames || meta.channels !== 2 || meta.sampleRate !== 44100) throw new Error(`${name}: wrong decoded format`)
    }
    expected ??= digest
    if (digest !== expected) throw new Error(`${name}: decoded PCM differs from the reference`)
    const result = report.results[name] ??= { sha256: digest, bytes: bytes.length, verifiedRuns: 0, samplesMs: [] }
    result.verifiedRuns++
    if (measured) result.samplesMs.push(ms)
    report.correctness = previouslyCorrect
  }

  // The first pass verifies all three outputs and warms their file pages.
  for (const name of Object.keys(targets)) run(name)
  report.correctness = true
  if (!timing) report.machine.push(machineState())
  if (timing) {
    const before = machineState(); report.machine.push(before)
    if (!quiet(before)) throw new Error('Timing requires load ≤ 2 and swap < 4096 MiB; use SPEED=0 for correctness only')
    const names = Object.keys(targets)
    for (let round = 0; round < reps; round++) {
      for (let i = 0; i < names.length; i++) run(names[(round + i) % names.length], true)
      const state = machineState(); report.machine.push(state)
      if (!quiet(state)) throw new Error('Machine load or swap invalidated this timing run')
    }
    for (const result of Object.values(report.results)) result.medianMs = median(result.samplesMs)
    report.performance = 'measured'
  }
} catch (e) {
  report.error = e.message
  process.exitCode = 1
} finally {
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  console.log(`WAV decode: ${report.correctness ? 'identical PCM from all three targets' : 'failed'}; performance ${report.performance}`)
  if (report.performance === 'measured') for (const [name, result] of Object.entries(report.results)) console.log(`${name}: ${result.medianMs.toFixed(1)} ms`)
  if (report.error) console.error(report.error)
  console.log(output)
}
