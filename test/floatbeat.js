import test from 'tst'
import { is, ok, almost } from 'tst/assert.js'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { compile } from '../index.js'
import { instantiate } from '../interop.js'

const processorSource = readFileSync(new URL('../floatbeat/processor.js', import.meta.url), 'utf8').replace(/^import .*\n/, '')
test('floatbeat: worklet UTF-8 fallback matches native decoding, including malformed bytes', () => {
  const src = readFileSync(new URL('../utf8.js', import.meta.url), 'utf8').replace('export function', 'function')
  const decode = runInNewContext(src + '\ndecodeUtf8')
  const native = new TextDecoder('utf-8', { ignoreBOM: true })
  const pairs = new Uint8Array(256 * 256 * 3)
  for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) {
    const i = (a * 256 + b) * 3
    pairs[i] = a; pairs[i + 1] = b
  }
  is(decode(pairs), native.decode(pairs), 'all byte pairs, separated by ASCII')
  for (const bytes of [
    [0xEF, 0xBB, 0xBF, 65], [0xE0, 0xA0, 0x80], [0xED, 0xA0, 0x80],
    [0xF0, 0x90, 0x80, 0x80], [0xF4, 0x8F, 0xBF, 0xBF],
    [0xF4, 0x90, 0x80, 0x80], [0xF0, 0x90, 0x80],
  ]) {
    const input = Uint8Array.from(bytes)
    is(decode(input), native.decode(input))
    is(decode(input, false), new TextDecoder().decode(input))
  }
  const text = 'metadata: Ελληνικά, 日本語, 😀, \\ud800'
  is(decode(new TextEncoder().encode(text)), text)
})

const processor = program => {
  let Processor
  runInNewContext(processorSource, {
    instantiate, sampleRate: 48000,
    AudioWorkletProcessor: class { constructor() { this.messages = []; this.port = { postMessage: m => this.messages.push(m) } } },
    registerProcessor: (_name, value) => { Processor = value },
  })
  const p = new Processor({ processorOptions: { program } })
  return { p, send: data => p.port.onmessage({ data }), render: () => {
    const out = new Float32Array(128)
    p.process([], [[out]])
    return out
  } }
}

test('floatbeat: worklet resampling crosses blocks and preserves live-edit time', () => {
  const source = 't => Math.sin(t / 20) * 0.5'
  const bytes = compile(`export let fill = (n, off) => {
    const a = new Float64Array(n)
    for(let i=0;i<n;i++) a[i]=Math.sin((off+i)/20)*0.5
    return a
  }`)
  for (const kind of ['jz', 'js']) for (const rate of [8000, 44100, 96000]) {
    const { p, send, render } = processor({ bytes, source, bare: true, kind, rate, restart: true })
    let frame = 0
    for (let b = 0; b < 12; b++) {
      const out = render()
      for (let i = 0; i < out.length; i++, frame++) {
        const pos = frame * rate / 48000, t = Math.floor(pos), f = pos - t
        const want = (Math.sin(t / 20) * (1 - f) + Math.sin((t + 1) / 20) * f) * 0.5
        if (Math.abs(out[i] - want) > 1e-6) throw new Error(`${kind}/${rate}: frame ${frame} differs`)
      }
    }
    ok(true, `${kind}/${rate}: every sample across 12 render blocks agrees`)
    send({ type: 'kernel', bytes, source, bare: true, kind, rate })
    almost(render()[0], Math.sin(frame * rate / 48000 / 20) * 0.5, 0.001, 'edit keeps musical time')
    send({ type: 'stop' }); is(render().every(x => x === 0), true, 'stop is silent')
    send({ type: 'play', rate }); is(render()[0], 0, 'restart begins at frame zero')
    is(p.messages.filter(m => m.type === 'error').length, 0)
  }
})

test('floatbeat: malformed fill output stops playback and reports one error', () => {
  const { p, send, render } = processor()
  const bytes = compile('export let fill = () => new Float64Array(0)')
  send({ type: 'kernel', bytes, source: '', bare: false, kind: 'jz', rate: 48000 })
  send({ type: 'play', rate: 48000 })
  is(render().every(x => x === 0), true)
  is(render().every(x => x === 0), true)
  is(p.messages.filter(m => m.type === 'error').length, 1)
})
