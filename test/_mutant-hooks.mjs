// The module-load hook behind test/_mutant.mjs: a module whose path ends with
// an edited suffix (on a path boundary) is served with its edits applied.
import { fileURLToPath } from 'node:url'
import { edit, matches } from './_self-overlay.js'

let edits = {}, applied = new Set()
export function initialize(data) { edits = data.edits }

export async function load(url, context, next) {
  const result = await next(url, context)
  if (!url.startsWith('file:')) return result
  const path = fileURLToPath(url)
  const suffix = Object.keys(edits).find(s => matches(path, s))
  if (!suffix) return result
  if (applied.has(suffix)) throw new Error(`_mutant: ${suffix} matched a second module: ${path}`)
  applied.add(suffix)
  const source = edit(suffix, String(result.source), edits[suffix])
  return { ...result, source, shortCircuit: true }
}
