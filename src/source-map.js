/** Statement locations for debug builds. The encoder owns Wasm byte offsets. */
const BODY = new Set(['func', 'block', 'loop', 'then', 'else', 'try', 'try_table', 'catch', 'catch_all'])
const DECL = new Set(['param', 'result', 'local', 'type', 'export', 'import', 'catch', 'catch_ref', 'catch_all', 'catch_all_ref'])

export function sourceMapOptions(value, optimize) {
  if (!value) return null
  if (value !== true && (typeof value !== 'object' || Array.isArray(value)))
    throw new TypeError('sourceMap must be true or an options object')
  if (optimize != null && optimize !== false && optimize !== 0)
    throw new TypeError('sourceMap requires optimize: false; optimized source maps are not supported')
  const source = value.source ?? 'input.js', url = value.url
  if (typeof source !== 'string' || !source || url != null && url !== false && typeof url !== 'string')
    throw new TypeError('sourceMap.source must be a nonempty string; sourceMap.url must be a string or false')
  return { source, url }
}

export function annotateSource(module, source, parts, options, prefix = 0, wat = false) {
  const entries = [{ file: options.source, src: source, base: prefix, end: source.length + prefix }, ...(parts || [])]
  const contents = new Map(entries.map(p => [p.file, p.src]))
  const indexes = entries.map(p => {
    const starts = [0]
    for (let i = 0; i < p.src.length; i++) {
      const c = p.src.charCodeAt(i)
      if (c === 13 && p.src.charCodeAt(i + 1) === 10) i++
      if (c === 10 || c === 13 || c === 8232 || c === 8233) starts.push(i + 1)
    }
    return { ...p, starts }
  })
  const clear = () => wat ? ';;@' : ['@loc']
  const marker = loc => {
    const p = indexes.find(p => loc >= p.base && loc < p.end)
    if (!p) return clear()
    const offset = loc - p.base
    let lo = 0, hi = p.starts.length
    while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (p.starts[mid] <= offset) lo = mid; else hi = mid }
    if (wat) {
      if (/[\r\n]/.test(p.file)) throw new TypeError('WAT source-map filenames cannot contain line breaks')
      return `;;@ ${p.file}:${lo + 1}:${offset - p.starts[lo]}`
    }
    return ['@loc', p.file, lo + 1, offset - p.starts[lo]]
  }
  const origin = n => {
    if (!Array.isArray(n)) return null
    if (n.sourceLoc != null) return n.sourceLoc
    for (let i = 1; i < n.length; i++) { const at = origin(n[i]); if (at != null) return at }
    return null
  }
  const walk = (n, inherited = null) => {
    if (!Array.isArray(n)) return n
    const loc = n.sourceLoc ?? inherited, list = BODY.has(n[0]), out = [n[0]]
    for (let i = 1; i < n.length; i++) {
      const child = n[i]
      if (list && Array.isArray(child) && !DECL.has(child[0])) out.push(marker(origin(child) ?? loc))
      out.push(walk(child, loc))
    }
    return out
  }
  for (let i = 1; i < module.length; i++) {
    if (module[i]?.[0] !== 'func') continue
    module[i] = walk(module[i])
    // Each function has its own unmapped runtime prologue and epilogue.
    module[i].push(clear())
  }
  return contents
}

export function completeSourceMap(map, contents) {
  map ??= { version: 3, sources: [], names: [], mappings: '' }
  return { ...map, sourcesContent: map.sources.map(file => contents.get(file) ?? null) }
}
