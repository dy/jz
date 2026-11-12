/**
 * A choice between two quotients that share a divisor is one quotient of a choice:
 *
 *   (v128.bitselect (f64x2.div a d) (f64x2.add k (f64x2.div b d)) m)
 *     → (v128.bitselect q (f64x2.add k q) m),  q = (f64x2.div (v128.bitselect a b m) d)
 *
 * and so for a shared dividend, and for a `select` of scalar quotients. A lane (a select)
 * takes the arm its mask picks, and there q is that arm's own quotient: each arm computes
 * what it did. A choice runs both its arms, so the branch the vectorizer converted divided
 * once per arm, where it now divides once. Color-space's hue sector is three arms over one
 * divisor (`(g - b) / delta`, `2 + (b - r) / delta`, `4 + (r - g) / delta`) and its
 * saturation two over one dividend (`delta / (max + min)` against `delta / (2 - max - min)`):
 * hsl lifted 9 divisions a pair of pixels, 6 remain, and a core whose divider bounds the
 * loop takes the difference (EPYC 9V74 and the M4 a tenth of the loop each; the Ice Lake
 * divider has room to spare and leaves the time where it was).
 *
 * Each arm holds exactly one division of the choice's kind, an earlier merge's quotient
 * counting as one, whatever the arm computes around it. The statement runs its tees
 * first, each a set before it in the order they evaluated, so the merged quotient reads
 * only values already computed: a statement that reads a local before a tee writes it,
 * or calls, branches or stores within, stays as written.
 *
 * @module optimize/share-quotients
 */
import { findBodyStart } from '../ir.js'
import { nodeEqual } from '../ast.js'

const isArr = Array.isArray
// a choice → the divisions its arms may share
const DIVS = { 'v128.bitselect': new Set(['f64x2.div', 'f32x4.div']), select: new Set(['f64.div', 'f32.div']) }
const RESULT = { 'f64x2.div': 'v128', 'f32x4.div': 'v128', 'f64.div': 'f64', 'f32.div': 'f32' }
const MASK = { 'v128.bitselect': 'v128', select: 'i32' }
// what a statement whose tees run first may not hold
const OPAQUE = /^(?:call|return|br|if|block|loop|try|throw|rethrow|unreachable|global\.set|local\.set|memory\.|table\.)|\.store|\.atomic\./
const STATEMENT = /^(?:local\.set|drop|(?:[if](?:32|64)|v128)\.store(?:8|16|32)?)$/
const LEAF = new Set(['local.get', 'global.get', 'f64.const', 'f32.const', 'i32.const', 'i64.const', 'v128.const'])

// one value, computed nowhere: a local or global read, a literal, a splat of one
const leaf = n => isArr(n) && (LEAF.has(n[0]) || n.length === 2 && n[0].endsWith('.splat') && leaf(n[1]))
const has = (n, test) => isArr(n) && (test(n) || n.some(c => has(c, test)))

export function shareQuotients(module) {
  if (!isArr(module)) return module
  for (const fn of module) if (isArr(fn) && fn[0] === 'func') shareIn(fn)
  return module
}

function shareIn(fn) {
  const body = findBodyStart(fn)
  const names = new Set()
  for (let i = 2; i < body; i++) if (isArr(fn[i]) && typeof fn[i][1] === 'string') names.add(fn[i][1])
  const added = []
  let next = 0
  const fresh = type => { let n = `$__qt${next++}`; while (names.has(n)) n = `$__qt${next++}`; names.add(n); added.push(['local', n, type]); return n }
  const visit = (list, from) => {
    for (let i = from; i < list.length; i++) {
      const s = list[i]
      if (!isArr(s)) continue
      if (s[0] === 'block' || s[0] === 'loop') { visit(s, 1); continue }
      if (s[0] === 'if') { for (const a of s) if (isArr(a) && (a[0] === 'then' || a[0] === 'else')) visit(a, 1); continue }
      const out = shareStatement(s, fresh)
      if (!out) continue
      list.splice(i, 1, ...out)
      i += out.length - 1
    }
  }
  visit(fn, body)
  if (added.length) fn.splice(body, 0, ...added)
}

// The statement as its tees' sets, the quotients its choices share and itself, or null
function shareStatement(s, fresh) {
  if (!STATEMENT.test(s[0]) || !has(s, n => DIVS[n[0]])) return null
  let divs = 0
  if (!has(s, n => { if (RESULT[n[0]]) divs++; return divs > 1 })) return null
  for (let k = 1; k < s.length; k++) if (has(s[k], n => typeof n[0] === 'string' && OPAQUE.test(n[0]))) return null
  // The tees first, in the order they evaluate: each a set before what holds it (the
  // statement, the set of the tee it is nested in). A read there reads the last such set
  // of its local, so it must come after every tee of that local within: one still to
  // come (`left`, per enclosing tee) would hand it the later value.
  const tees = n => { const m = new Map(); has(n, x => { if (x[0] === 'local.tee') m.set(x[1], (m.get(x[1]) || 0) + 1); return false }); return m }
  const pre = [], left = [tees(s)]
  let hazard = false
  const lin = n => {
    if (!isArr(n)) return n
    if (n[0] === 'local.get' && left.at(-1).get(n[1])) hazard = true
    if (n[0] !== 'local.tee') return n.map((c, k) => k ? lin(c) : c)
    left.push(tees(n[2]))
    const v = lin(n[2])
    left.pop()
    for (const m of left) m.set(n[1], m.get(n[1]) - 1)
    pre.push(['local.set', n[1], v])
    return ['local.get', n[1]]
  }
  const stmt = s.map((c, k) => k ? lin(c) : c)
  if (hazard) return null
  // each statement's choices bottom-up, then its quotients and the masks they share before it
  const out = []
  let shared = 0
  for (const t of [...pre, stmt]) {
    const quotients = new Map(), masks = []
    let id = 0
    const within = (n, kinds, acc = []) => {
      if (!isArr(n)) return acc
      if (n[0] === '__qt') { if (!acc.some(d => d.q === n[1])) acc.push({ q: n[1], ...quotients.get(n[1]) }); return acc }
      if (kinds.has(n[0]) && n.length === 3) acc.push({ node: n, div: n[0], num: n[1], den: n[2] })
      for (let k = 1; k < n.length; k++) within(n[k], kinds, acc)
      return acc
    }
    const swap = (n, from, q) => !isArr(n) ? n
      : n === from.node || n[0] === '__qt' && n[1] === from.q ? ['__qt', q]
      : n.map((c, k) => k ? swap(c, from, q) : c)
    const share = n => {
      if (!isArr(n)) return n
      n = n.map((c, k) => k ? share(c) : c)
      const kinds = DIVS[n[0]]
      if (!kinds || n.length !== 4) return n
      const a = within(n[1], kinds), b = within(n[2], kinds)
      if (a.length !== 1 || b.length !== 1 || a[0].div !== b[0].div) return n
      const x = a[0], y = b[0]
      const byDen = leaf(x.den) && nodeEqual(x.den, y.den)
      if (!byDen && !(leaf(x.num) && nodeEqual(x.num, y.num)) || has(n[3], c => c[0] === '__qt')) return n
      let m = n[3]
      if (!leaf(m)) { const name = fresh(MASK[n[0]]); masks.push(['local.set', name, m]); m = ['local.get', name] }
      const q = id++
      quotients.set(q, byDen ? { div: x.div, num: [n[0], x.num, y.num, m], den: x.den } : { div: x.div, num: x.num, den: [n[0], x.den, y.den, m] })
      if (x.q != null) quotients.delete(x.q)
      if (y.q != null) quotients.delete(y.q)
      shared++
      return [n[0], swap(n[1], x, q), swap(n[2], y, q), m]
    }
    const w = t.map((c, k) => k ? share(c) : c)
    const local = new Map()
    for (const [q, { div }] of quotients) local.set(q, fresh(RESULT[div]))
    const read = n => !isArr(n) ? n : n[0] === '__qt' ? ['local.get', local.get(n[1])] : n.map((c, k) => k ? read(c) : c)
    out.push(...masks)
    for (const [q, { div, num, den }] of quotients) out.push(['local.set', local.get(q), [div, read(num), read(den)]])
    out.push(read(w))
  }
  return shared ? out : null
}
