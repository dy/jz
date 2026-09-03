/**
 * Local names after link: prepare's scope renaming leaves `$x<T>f3_1` style
 * suffixes (the private-use marker `T` from ast.js, a function id, a scope
 * id). Once one declaration per bare name survives in a function, and the
 * bare name itself is not declared, every occurrence goes back to the bare
 * name, so the text output reads as the source did. Names only; the binary
 * is unchanged.
 *
 * @module link/rename-locals
 */
import { T as MARK } from '../ast.js'
import { T, NONE, OP_STR, intern, text, walk } from '../ir/tape.js'

const isDigit = (c) => c >= 48 && c <= 57

/** `$x<MARK>f3_1<MARK>f4_2` → `$x`: every `<MARK>f<digits>_<digits>` run goes. */
function stripRenameRuns(s) {
  let i = s.indexOf(MARK)
  if (i < 0) return s
  let out = '', start = 0
  while (i >= 0) {
    let j = i + MARK.length
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
    i = s.indexOf(MARK, i + MARK.length)
  }
  return out + s.slice(start)
}

export function stripLocalRenameSuffixes(root) {
  const FUNC = intern('func'), LOCAL = intern('local'), PARAM = intern('param')
  for (let f = T.a[root]; f !== NONE; f = T.next[f]) {
    if (T.op[f] !== FUNC) continue
    const declared = new Set()
    for (let c = T.a[f]; c !== NONE; c = T.next[c]) {
      if (T.op[c] !== LOCAL && T.op[c] !== PARAM) continue
      const name = text(T.a[c])
      if (name !== null && name[0] === '$') declared.add(name)
    }
    if (!declared.size) continue
    const byBare = new Map()
    for (const d of declared) {
      const bare = stripRenameRuns(d)
      if (bare !== d && bare.length > 1) (byBare.get(bare) ?? byBare.set(bare, []).get(bare)).push(d)
    }
    const map = new Map()
    for (const [bare, list] of byBare) if (list.length === 1 && !declared.has(bare)) map.set(list[0], intern(bare))
    if (!map.size) continue
    walk(f, (id) => {
      if (T.op[id] !== OP_STR) return
      const to = map.get(T.syms[T.sym[id]])
      if (to !== undefined) T.sym[id] = to
    })
  }
}
