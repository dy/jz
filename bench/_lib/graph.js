// Library workloads share one graph/host contract across timing and audit tools.
export const GRAPH_CASES = new Set(['jessie', 'jz', 'webaudio'])
export const HOST_ADAPTERS = { webaudio: ['@audio/decode', '@audio/decode-ape', '@audio/speaker', '@audio/mic', 'pcm-convert'] }
const EXTERNALS = { webaudio: [...HOST_ADAPTERS.webaudio, 'src/AudioWorklet.js'] }

// Offline rendering never calls the device/codec adapters or worklet host.
// Pass the resolver from the measured checkout, including when auditing a ref.
export function graphSources(c, resolveModuleGraph) {
  const g = resolveModuleGraph(c.js, { resolveNode: c.id === 'jz' || c.id in EXTERNALS, external: EXTERNALS[c.id] })
  const imports = {}
  for (const [k, names] of Object.entries(g.externals ?? {}))
    imports[k] = Object.fromEntries(names.map(n => [n, { params: 8 }]))
  return { code: g.code, modules: g.modules, imports }
}
