/**
 * Split out of assemble.js (pipeline-minimality slice) — pure move, no
 * behavior change. Standalone late-stage phase (compile/index.js:3430, well
 * after section ordering), unrelated to every other assemble/*.js group —
 * see `.work/archive/assemble-outliers.md` §4.
 */

import { T, walkAst } from '../../ast.js'

/** WAT display names: totalRename mints `name<T>f<fnId>_<n>` for EVERY local
 *  (the BindingId — see prepare). Strip the suffix wherever the bare spelling
 *  is unambiguous within its function, so debug WAT, name-matching passes, and
 *  WAT-shape tests read like the source. Purely textual — binaries carry no
 *  name section; genuinely-shadowed locals keep their suffix (two `x`s in one
 *  function must stay distinct tokens). */
// Remove every `<T>f<digits>_<digits>` run from a token (suffix may sit
// MID-token: `$s<T>f1_0$ccsso` — the charCodeAt decomposition composes past
// the rename). Manual scan, no regex: this runs per compile inside the
// self-compiled kernel, where regex execution is interpreter-grade.
const isDigit = (c) => c >= 48 && c <= 57
function stripRenameRuns(s) {
  let i = s.indexOf(T)
  if (i < 0) return s
  // ENCODING-AGNOSTIC index math: the self-compiled kernel's strings are UTF-8
  // bytes (T = '' spans 3 there, 1 natively) — advance by T.length and
  // derive every position from indexOf/scan results, never hardcoded +1.
  // The scanned run body ('f' digits '_' digits) is pure ASCII — identical
  // under both encodings.
  const TL = T.length
  let out = ''
  let start = 0
  while (i >= 0) {
    let j = i + TL
    if (s.charCodeAt(j) === 102) {
      j++
      const d0 = j
      while (isDigit(s.charCodeAt(j))) j++
      if (j > d0 && s.charCodeAt(j) === 95) {
        j++
        const d1 = j
        while (isDigit(s.charCodeAt(j))) j++
        if (j > d1) { out += s.slice(start, i); start = j }
      }
    }
    i = s.indexOf(T, i + TL)
  }
  return out + s.slice(start)
}

export function stripLocalRenameSuffixes(funcs) {
  for (const fn of funcs) {
    if (!Array.isArray(fn) || fn[0] !== 'func') continue
    const declared = new Set()
    for (const c of fn)
      if (Array.isArray(c) && (c[0] === 'local' || c[0] === 'param') && typeof c[1] === 'string' && c[1][0] === '$')
        declared.add(c[1])
    if (!declared.size) continue
    const byBare = new Map()
    for (const d of declared) {
      const bare = stripRenameRuns(d)
      if (bare !== d && bare.length > 1) (byBare.get(bare) ?? byBare.set(bare, []).get(bare)).push(d)
    }
    const map = new Map()
    for (const [bare, list] of byBare)
      if (list.length === 1 && !declared.has(bare)) map.set(list[0], bare)
    if (!map.size) continue
    walkAst(fn, { enter: n => {
      for (let i = 0; i < n.length; i++) if (typeof n[i] === 'string' && map.has(n[i])) n[i] = map.get(n[i])
    } })
  }
}
