import { instantiate } from '../dist/interop.js'

const clock = () => globalThis.performance?.now() ?? Date.now()

class FloatbeatProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super()
    this.playing = false
    this.kind = 'jz'
    this.rate = sampleRate
    this.reset()
    this.port.onmessage = ({ data }) => {
      try {
        if (data.type === 'kernel') {
          this.load(data)
        } else if (data.type === 'kind') {
          this.kind = data.kind
          this.offset = Math.floor(this.position); this.buffer = null; this.ready = false
        } else if (data.type === 'play') {
          this.rate = data.rate; this.reset(); this.playing = true
        } else if (data.type === 'stop') this.playing = false
      } catch (e) { this.fail(e) }
    }
    this.port.onmessageerror = () => this.fail(new Error('Could not load the audio program'))
    // The initial program arrives with construction, before the first render
    // quantum. Later edits travel through the message port.
    try { if (options.processorOptions?.program) this.load(options.processorOptions.program) }
    catch (e) { this.fail(e) }
  }

  load(data) {
    const kernel = instantiate(data.bytes)
    if (typeof kernel.exports.fill !== 'function') throw new Error('export fill not found')
    const js = data.bare ? new Function('t', `return (${data.source})(t)`) : null
    this.kernel = kernel; this.js = js; this.kind = data.kind; this.rate = data.rate
    if (data.restart) { this.reset(); this.playing = true }
    // Keep musical time when editing; discard only samples from the old kernel.
    this.offset = Math.floor(this.position)
    this.buffer = null; this.ready = false
  }

  reset() {
    this.offset = 0; this.position = 0; this.phase = 0
    this.buffer = null; this.index = 0; this.ready = false
    this.elapsed = 0; this.chunks = 0
  }

  fail(error) {
    this.playing = false
    this.port.postMessage({ type: 'error', message: String(error.message || error) })
  }

  next() {
    if (!this.buffer || this.index === this.buffer.length) {
      const start = clock(), size = 512
      if (this.kind === 'js' && this.js) {
        this.buffer = new Float64Array(size)
        for (let i = 0; i < size; i++) this.buffer[i] = this.js(this.offset + i)
      } else {
        this.buffer = Float64Array.from(this.kernel.exports.fill(size, this.offset))
        this.kernel.memory.reset()
      }
      if (this.buffer.length !== size) throw new Error('fill must return one sample per frame')
      this.offset += size; this.index = 0
      this.elapsed += clock() - start
      if (++this.chunks === 32) {
        this.port.postMessage({ type: 'meter', ms: this.elapsed / this.chunks })
        this.elapsed = 0; this.chunks = 0
      }
    }
    const value = this.buffer[this.index++]
    return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0
  }

  process(_inputs, outputs) {
    const out = outputs[0]?.[0]
    if (!out || !this.playing || !this.kernel) return true
    try {
      if (!this.ready) { this.a = this.next(); this.b = this.next(); this.ready = true }
      const ratio = this.rate / sampleRate
      for (let i = 0; i < out.length; i++) {
        out[i] = this.a + (this.b - this.a) * this.phase
        this.phase += ratio; this.position += ratio
        while (this.phase >= 1) { this.a = this.b; this.b = this.next(); this.phase-- }
      }
    } catch (e) { out.fill(0); this.fail(e) }
    return true
  }
}

registerProcessor('jz-floatbeat', FloatbeatProcessor)
