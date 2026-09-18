// Library workloads share one graph/host contract across timing and audit tools.
export const GRAPH_CASES = new Set(['jessie', 'jz', 'webaudio'])
export const HOST_ADAPTERS = { webaudio: ['@audio/decode', '@audio/decode-ape', '@audio/speaker', '@audio/mic', 'pcm-convert'] }
const EXTERNALS = { webaudio: HOST_ADAPTERS.webaudio }
// The worklet host loads processor code through `new Function` and a
// MessageChannel, which no compiled module can carry; every context still
// constructs its AudioWorklet, so a stub of the same shape stands in.
const SOURCES = { webaudio: { 'src/AudioWorklet.js': `
export class AudioWorkletProcessor { constructor() {} }
export class AudioWorkletNode { constructor() { throw new Error('AudioWorkletNode is not available in the bench host') } }
export class AudioWorklet { constructor(context) { this.context = context } addModule() { return Promise.resolve() } }
` } }

// Offline rendering never calls the device/codec adapters.
// Pass the resolver from the measured checkout, including when auditing a ref.
export function graphSources(c, resolveModuleGraph) {
  const g = resolveModuleGraph(c.js, { resolveNode: c.id === 'jz' || c.id in EXTERNALS, external: EXTERNALS[c.id], sources: SOURCES[c.id] })
  const imports = {}
  for (const [k, names] of Object.entries(g.externals ?? {}))
    imports[k] = Object.fromEntries(names.map(n => [n, { params: 8 }]))
  return { code: g.code, modules: g.modules, imports }
}
