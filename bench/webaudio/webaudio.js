// webaudio.js — an offline Web Audio render through the web-audio-api engine
// (the whole library, 120 modules: nodes, params, automation, DSP), the
// library jz is developed against. The graph: a sawtooth oscillator with a
// vibrato LFO on its frequency → biquad lowpass → gain → stereo panner →
// destination, one second at 44.1 kHz in stereo; the engine's own benchmark
// scenarios, composed. `startRendering` renders synchronously inside its
// promise and dispatches `complete` first, so the buffer is read off the
// event and the promise is never awaited: one timed region per run.
//
// Reports: median ms across N_RUNS, the checksum of the output as 16-bit PCM
// over both channels (the engine's oscillators and filters run through
// Math.sin/cos/exp, which differ by an ulp between hosts; the PCM a listener
// gets does not).

import { OfflineAudioContext } from '../../node_modules/web-audio-api/index.js'
import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const SAMPLE_RATE = 44100
const SECONDS = 1
const LENGTH = SAMPLE_RATE * SECONDS
const N_RUNS = 11
const N_WARMUP = 2

const render = () => {
  const ctx = new OfflineAudioContext(2, LENGTH, SAMPLE_RATE)
  const osc = ctx.createOscillator()
  osc.type = 'sawtooth'
  osc.frequency.value = 220
  const lfo = ctx.createOscillator()
  lfo.frequency.value = 5
  const depth = ctx.createGain()
  depth.gain.value = 6
  lfo.connect(depth).connect(osc.frequency)
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 1200
  filter.Q.value = 4
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.5, 0)
  gain.gain.linearRampToValueAtTime(0.25, SECONDS)
  const pan = ctx.createStereoPanner()
  pan.pan.value = 0.3
  osc.connect(filter).connect(gain).connect(pan).connect(ctx.destination)
  osc.start(0)
  lfo.start(0)
  let out = null
  ctx.addEventListener('complete', (e) => { out = e.renderedBuffer })
  ctx.startRendering()
  return out
}

const checksum = (buffer) => {
  let h = 0x811c9dc5 | 0
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch)
    for (let i = 0; i < d.length; i++) h = mix(h, Math.round(Math.max(-1, Math.min(1, d[i])) * 32767))
  }
  return h >>> 0
}

const run = () => {
  let out
  for (let i = 0; i < N_WARMUP; i++) out = render()
  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    out = render()
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksum(out), LENGTH, 2, N_RUNS)
}

export let main = () => {
  run()
}
