/**
 * jz/transform — full JS source → canonical jz source.
 *
 * Parses, lowers full-JS forms (var/function/class/switch/==/undefined/…) into the
 * jz subset via jzify, and pretty-prints back to jz source. The compile path runs
 * jzify on the AST directly (default-on); this is the standalone source→source tool
 * for tooling and REPLs ("clean my JS to the subset", auto-transform on paste).
 *
 * @module jz/transform
 */
import { parse } from './src/parse.js'
import jzify from './jzify/index.js'
import { codegen } from './src/wat/codegen.js'

// jzify mints temps under private-use-area prefixes (jzify/names.js) so they can
// never collide with user names — but printed source must be plain identifiers
// (the compiler REJECTS the reserved prefix in user code). Strip the prefix and
// uniquify against every name present in the program.
const PUA = /^[-]/
function renameSynthetic(ast) {
  const names = new Set(), synth = new Set()
  const collect = (n) => {
    if (typeof n === 'string') (PUA.test(n) ? synth : names).add(n)
    else if (Array.isArray(n) && n[0] != null) for (let i = 0; i < n.length; i++) collect(n[i])
  }
  collect(ast)
  if (!synth.size) return ast
  const map = new Map()
  for (const s of synth) {
    let base = s.replace(PUA, ''), name = base
    for (let i = 2; names.has(name); i++) name = base + '_' + i
    names.add(name); map.set(s, name)
  }
  const rename = (n) => {
    if (Array.isArray(n) && n[0] != null)
      for (let i = 0; i < n.length; i++) {
        if (typeof n[i] === 'string' && map.has(n[i])) n[i] = map.get(n[i])
        else rename(n[i])
      }
    return n
  }
  return rename(ast)
}

// AST fingerprint for no-change detection (bigints aren't JSON-stringifiable)
const key = (ast) => JSON.stringify(ast, (_, v) => typeof v === 'bigint' ? v + 'n' : v)

/**
 * @param {string} code - full-JS source
 * @param {object} [opts]
 * @param {boolean} [opts.onlyLowered] - return null when jzify changes nothing
 *   (source is already canonical jz) — lets a REPL keep the user's original
 *   bytes, comments and formatting intact, and rewrite only real lowerings.
 * @returns {string|null} canonical jz source
 */
export default function transform(code, { onlyLowered = false } = {}) {
  if (onlyLowered) {
    const before = key(parse(code))
    const lowered = jzify(parse(code))   // fresh parse — jzify mutates its input
    if (key(lowered) === before) return null
    return codegen(renameSynthetic(lowered))
  }
  return codegen(renameSynthetic(jzify(parse(code))))
}
