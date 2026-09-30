import { createHash } from 'node:crypto'
import { rewriteModuleImports } from '../src/resolve.js'

// The resolver embeds absolute module IDs in import specifiers as well as keys.
// Normalize both for attestation, leaving ordinary string values untouched.
export function graphEntries(graph, keyOf, entry = 'scripts/self.js') {
  const keys = new Map(Object.keys(graph.modules).map(path => [path, keyOf(path)]))
  const unique = new Set([entry])
  for (const key of keys.values()) {
    if (unique.has(key)) throw new Error(`Duplicate canonical module key: ${key}`)
    unique.add(key)
  }
  const sourceOf = source => rewriteModuleImports(source, (match, spec) => {
    const key = keys.get(spec)
    if (key === undefined) return match
    const at = match.lastIndexOf(spec)
    return match.slice(0, at) + key + match.slice(at + spec.length)
  })
  return [[entry, sourceOf(graph.code)], ...Object.entries(graph.modules).map(([path, source]) => [keys.get(path), sourceOf(source)])]
}

export const contentHash = entries => createHash('sha256').update([...entries]
  .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  .map(([key, source]) => `${key}\0${Buffer.byteLength(source, 'utf8')}\0${source}`).join('\0')).digest('hex')
