// Test-only source overlays on a resolved module graph ({ code, modules }): each
// key selects one module by a path suffix on a path boundary (`scripts/self.js`
// is the entry, whose source is the graph's `code`), and each edit replaces one
// occurrence of a literal string. Selection fails closed: a suffix matching no
// module or more than one, a target occurring nowhere or more than once, or an
// edit that is not a pair of strings rejects the whole overlay, so an edit can
// never land somewhere other than where its author looked. The graph passed in
// is not modified. test/_self-overlay-build.mjs applies this to the self
// graph; test/self-build.js drives it on a synthetic graph.

const matches = (path, suffix) => path === suffix || path.endsWith('/' + suffix)
const occurrences = (src, find) => src.split(find).length - 1

const edit = (suffix, src, edits) => {
  if (!Array.isArray(edits)) throw new Error(`overlay: ${suffix}: edits must be a list of [find, replace] pairs`)
  for (const pair of edits) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string' || !pair[0])
      throw new Error(`overlay: ${suffix}: an edit is a [find, replace] pair of strings with a non-empty find, got ${JSON.stringify(pair)}`)
    const [find, replace] = pair
    const n = occurrences(src, find)
    if (n !== 1) throw new Error(`overlay: ${suffix} contains ${JSON.stringify(find)} ${n ? `${n} times` : 'nowhere'}`)
    src = src.replace(find, () => replace)   // a function: `$` in the replacement stays literal
  }
  return src
}

/**
 * @param {{code: string, modules: Record<string, string>}} graph
 * @param {Record<string, [string, string][]>} overlays  module suffix → edits
 * @param {string} entry  the entry module's path (the graph's `code`)
 */
export function applyOverlays(graph, overlays, entry) {
  let code = graph.code
  const modules = { ...graph.modules }
  const paths = [entry, ...Object.keys(modules)]
  for (const [suffix, edits] of Object.entries(overlays)) {
    const found = paths.filter(p => matches(p, suffix))
    if (found.length !== 1) throw new Error(`overlay: ${found.length ? `${found.length} modules end with ${suffix}: ${found.join(', ')}` : `no module ends with ${suffix}`}`)
    const [path] = found
    if (path === entry) code = edit(suffix, code, edits)
    else modules[path] = edit(suffix, modules[path], edits)
  }
  return { ...graph, code, modules }
}
