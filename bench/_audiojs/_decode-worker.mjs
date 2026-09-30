// Fresh-process half of ffmpeg.mjs. Compiler loading/building belongs outside
// the measured process; both JS and Wasm use this same PCM output path.
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [mode, entry, interop, input, output] = process.argv.slice(2)
let decode
if (mode === 'javascript') ({ decode } = await import(pathToFileURL(entry)))
else if (mode === 'jz') {
  const { instantiate } = await import(pathToFileURL(interop))
  ;({ decode } = instantiate(readFileSync(entry)).exports)
} else throw new Error(`Unknown decoder: ${mode}`)

const { channelData, sampleRate } = await decode(new Uint8Array(readFileSync(input)))
const frames = channelData[0]?.length, channels = channelData.length
if (!frames || channelData.some(c => c.length !== frames)) throw new Error('Invalid decoded channel lengths')
const pcm = new Float32Array(frames * channels)
for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) pcm[i * channels + c] = channelData[c][i]
writeFileSync(output, new Uint8Array(pcm.buffer))
console.log(JSON.stringify({ frames, channels, sampleRate }))
