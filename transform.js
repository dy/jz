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
import { initWarnings, warn } from './src/ctx.js'

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

// Canonical equality — converter-only (the compile path keeps JS-loose `==`).
// jz's `==` follows JS: statically-known mixed types coerce (`1 == "1"` is
// true), so a blanket `===` swap would change behavior. Rewrite by proof:
//   x == null / == undefined → x === null || x === undefined  (exact, incl. dynamic)
//   typeof x == "s", same-type literals → strict op            (provably identical)
//   mixed-type literals → folded constant                      (the JS loose result)
//   anything else → strict op + `eqeq` advisory                (identical unless
//     the operands mix types at runtime — the case Crockford bans `==` over)
// jzify-synthesized comparisons carry no source `loc` and rewrite silently.
const isLit = n => Array.isArray(n) && n.length === 2 && n[0] == null
const isNullish = n => n === 'null' || n === 'undefined' || (isLit(n) && n[1] == null)
const isTypeof = n => Array.isArray(n) && n[0] === 'typeof'
const isStrLit = n => isLit(n) && typeof n[1] === 'string'
// Re-evaluable without effects — jz has no getters/proxies, so member and
// index reads are pure; calls and assignments are not.
const isPure = n => typeof n === 'string' || isLit(n)
  || (Array.isArray(n) && (n[0] === '.' || n[0] === '?.') && isPure(n[1]))
  || (Array.isArray(n) && (n[0] === '[]' || n[0] === '?.[]') && n.length === 3 && isPure(n[1]) && isPure(n[2]))

let eqTemp = 0
function canonEqNode(node, source) {
  const [op, a, b] = node, eq = op === '=='
  const strict = eq ? '===' : '!=='
  if (isNullish(a) && isNullish(b)) return [null, eq]
  if (isNullish(a) || isNullish(b)) {
    const x = isNullish(a) ? b : a
    const test = v => eq ? ['||', ['===', v, 'null'], ['===', v, 'undefined']]
                         : ['&&', ['!==', v, 'null'], ['!==', v, 'undefined']]
    if (isPure(x)) return test(x)
    const t = `eq${eqTemp++}`   // effectful operand — bind once
    return ['()', ['=>', t, test(t)], x]
  }
  if ((isTypeof(a) && (isTypeof(b) || isStrLit(b))) || (isTypeof(b) && isStrLit(a)))
    return [strict, a, b]
  if (isLit(a) && isLit(b)) {
    if (typeof a[1] === typeof b[1]) return [strict, a, b]
    const r = +a[1] === +b[1]   // JS loose result for mixed number/string/boolean/bigint literals
    return [null, eq ? r : !r]
  }
  // `.prototype` comparisons are bundler idioms jzify folds away — no advisory.
  const protoish = n => Array.isArray(n) && n[0] === '.' && (n[2] === 'prototype' || protoish(n[1]))
  if (source != null && node.loc != null && !protoish(a) && !protoish(b)) {
    const before = source.slice(0, node.loc)
    warn('eqeq', `\`${eq ? '==' : '!='}\` rewritten to \`${strict}\` — identical unless the operands mix types at runtime (loose \`${eq ? '==' : '!='}\` coerces, e.g. \`1 == "1"\`); review if coercion was intended`,
      { line: before.split('\n').length, column: node.loc - before.lastIndexOf('\n') })
  }
  return [strict, a, b]
}

// Two passes: pre-jzify on the raw parse (source locs intact → advisories point
// at real lines) and post-jzify silent (`source: null`) — jzify both rebuilds
// user nodes (dropping loc) and synthesizes its own `==`/`!=` (dispose guards,
// protocol probes, prepended runtimes), all of which must still canonicalize.
function canonEq(n, source) {
  if (!Array.isArray(n) || n[0] == null) return n
  for (let i = 1; i < n.length; i++) n[i] = canonEq(n[i], source)
  return (n[0] === '==' || n[0] === '!=') ? canonEqNode(n, source) : n
}

// AST fingerprint for no-change detection (bigints aren't JSON-stringifiable)
const key = (ast) => JSON.stringify(ast, (_, v) => typeof v === 'bigint' ? v + 'n' : v)

/**
 * @param {string} code - full-JS source
 * @param {object} [opts]
 * @param {boolean} [opts.onlyLowered] - return null when jzify changes nothing
 *   (source is already canonical jz) — lets a REPL keep the user's original
 *   bytes, comments and formatting intact, and rewrite only real lowerings.
 * @param {{entries: Array}} [opts.warnings] - advisory sink (mirrors compile's
 *   `opts.warnings`) — collects `eqeq` rewrite advisories etc.
 * @returns {string|null} canonical jz source
 */
export default function transform(code, { onlyLowered = false, warnings = null } = {}) {
  initWarnings(warnings)
  eqTemp = 0
  try {
    if (onlyLowered) {
      const before = key(parse(code))
      const lowered = canonEq(jzify(canonEq(parse(code), code)), null)   // fresh parse — jzify mutates its input
      if (key(lowered) === before) return null
      return codegen(renameSynthetic(lowered))
    }
    return codegen(renameSynthetic(canonEq(jzify(canonEq(parse(code), code)), null)))
  } finally { initWarnings(null) }
}
