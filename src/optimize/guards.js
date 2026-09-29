// The guards of a specialized loop, decided once for many reads.
//
// A loop's specialized copy (optimize/specialize.js) tests each read that may
// miss where the read is: `(br_if $left (i32.eqz (i32.lt_u index length)))`.
// After the integer pass the indices are integer sums, and two things about
// them show:
//
//   - An index the loop leaves alone, or the loop's counter times a constant
//     plus what the loop leaves alone, is within its array for every round
//     when it is for the first and the last. The two are tested ahead of the
//     loop, once, and the loop as written runs where either fails.
//
//   - Reads of one array at `x`, `x + 1`, `x + 2` are all within it when the
//     first and the last are. The first guard tests both and the others go,
//     where the first runs whenever they do and leaves to the same statement.
//
// A test that fails ahead of its read leaves earlier than the read would:
// the loop as written decides the read then, as it does every read it runs.
// A read the program itself keeps within its array (a test of its index on the
// way to it) is left where it stands.
//
// Runs after the integer pass, over what the specialization built.

import { constBits, conditional } from './int-range.js'

const isArr = Array.isArray
const DECL = new Set(['param', 'local', 'result', 'export', 'type'])
const TAG = /(\.f\d+)$/
const clone = n => isArr(n) ? n.map(clone) : n
// (where a sum is read for the statements ahead of the loop, not for a node in it)
const AHEAD = Object.freeze(['ahead'])
const ANSWER = /^i(32|64)\.(eqz|eq|ne|[lg][te]_[su])$/
const typeOf = (n, types) => n[0] === 'local.get' ? types.get(n[1])
  : ANSWER.test(n[0]) || n[0] === 'i32.wrap_i64' ? 'i32' : n[0].startsWith('i64.extend') ? 'i64'
  : n[0].startsWith('i32.') ? 'i32' : n[0].startsWith('i64.') ? 'i64' : null

const combine = (loop, holder, tag, types) => {
  const prefix = `$__sp${tag}a`, slow = `$__sp${tag}s`
  // (`place` numbers the nodes as the loop is written: a node before its operands)
  const writes = new Map(), up = new Map(), place = new Map(), guards = []
  const census = (n) => {
    place.set(n, place.size)
    if (n[0] === 'local.set' || n[0] === 'local.tee') (writes.get(n[1]) ?? writes.set(n[1], []).get(n[1])).push(n)
    else if (n[0] === 'br_if' && n.length === 3 && typeof n[1] === 'string' && n[1].startsWith(prefix) && n[2]?.[0] === 'i32.eqz') guards.push(n)
    for (let i = 1; i < n.length; i++) if (isArr(n[i])) { up.set(n[i], [n, i]); census(n[i]) }
  }
  census(loop)
  if (!guards.length) return false
  const still = name => !writes.has(name)
  const word = name => types.get(name) === 'i32' || types.get(name) === 'i64'

  // The counter: one step at the end of every round, one test at the top.
  // (the copies a stretch takes of its locals stand ahead of the test)
  let first = 2
  while (loop[first]?.[0] === 'local.set' && loop[first][2]?.[0] === 'local.get' && /\.t\d+_\d+$/.test(loop[first][1])) first++
  const n = loop.length, top = loop[first], step = loop[n - 2], again = loop[n - 1]
  let counter = null, bound = null
  if (n > first + 2 && again?.[0] === 'br' && again[1] === loop[1] && step?.[0] === 'local.set' && types.get(step[1]) === 'i32' && writes.get(step[1]).length === 1 &&
      step[2]?.[0] === 'i32.add' && step[2][1]?.[0] === 'local.get' && step[2][1][1] === step[1] && step[2][2]?.[0] === 'i32.const' && Number(step[2][2][1]) === 1 &&
      top?.[0] === 'br_if' && top.length === 3) {
    const t = top[2]?.[0] === 'i32.eqz' && top[2][1]?.[0] === 'i32.lt_s' ? top[2][1] : top[2]?.[0] === 'i32.ge_s' ? top[2] : null
    const limit = t?.[2]
    if (t && t[1]?.[0] === 'local.get' && t[1][1] === step[1] &&
        (limit?.[0] === 'i32.const' || (limit?.[0] === 'local.get' && types.get(limit[1]) === 'i32' && still(limit[1])))) { counter = step[1]; bound = limit }
  }

  // Whether `a` runs before `b` in every round that reaches `b`: `a` stands
  // earlier in a run the two share, under nothing that may skip it.
  const chains = new Map()
  const chain = node => {
    let out = chains.get(node)
    if (!out) { out = []; for (let at = up.get(node); at; at = up.get(at[0])) out.unshift(at); chains.set(node, out) }
    return out
  }
  const runsBefore = (a, b) => {
    const p = chain(a), q = chain(b)
    let i = 0
    while (i < p.length && i < q.length && p[i][0] === q[i][0] && p[i][1] === q[i][1]) i++
    if (i >= p.length || i >= q.length || p[i][0] !== q[i][0] || p[i][1] >= q[i][1]) return false
    const shared = p[i][0]
    if (shared[0] === 'if' && shared[p[i][1]]?.[0] === 'then') return false   // the two arms
    for (let k = i + 1; k < p.length; k++) {
      const h = p[k][0]
      if (h[0] === 'then' || h[0] === 'else' || h[0] === 'loop') return false
      if (h[0] === 'block' && typeof h[1] === 'string') return false   // a branch to its end skips what follows in it
    }
    return true
  }
  // The write of `x` that `at` reads, where one write reaches it whatever
  // way the round took: the last one that runs before it, with no write
  // after that one which may have run.
  const holds = (w, at) => chain(at).some(([p]) => p === w)
  const defOf = (x, at) => {
    if (at === AHEAD) return null
    let d = null
    for (const w of writes.get(x)) {
      if (place.get(w) > place.get(at)) break
      if (!holds(w, at)) d = runsBefore(w, at) ? w : null   // (a write around `at` has not run yet)
    }
    return d
  }
  // What the statements ahead of the loop give the locals the loop leaves
  // alone (`$__li = p + 1`), each as the sum it is: `later` names the ones
  // not written yet where the walk of those statements stands.
  const later = new Set(), given = new Map()

  // `e` as c + a·counter + Σ k·term: a term is a local, or an expression of
  // locals that computes and reads nothing else. `moves` where a term is of
  // this round (a local the loop writes, the counter under an operator).
  const leaf = (key, node, type, moves) => ({ c: 0, a: 0, moves, terms: new Map([[key, { k: 1, node, type }]]) })
  const sum = (p, q, s) => {
    const terms = new Map(p.terms)
    for (const [x, t] of q.terms) { const k = (terms.get(x)?.k ?? 0) + s * t.k; if (k) terms.set(x, { k, node: t.node, type: t.type }); else terms.delete(x) }
    return { c: p.c + s * q.c, a: p.a + s * q.a, moves: p.moves || q.moves, terms }
  }
  const times = (p, k) => ({ c: p.c * k, a: p.a * k, moves: p.moves, terms: new Map([...p.terms].map(([x, t]) => [x, { k: t.k * k, node: t.node, type: t.type }])) })
  const small = p => Math.abs(p.c) < 2 ** 40 && Math.abs(p.a) < 2 ** 20 && p.terms.size < 8 && [...p.terms.values()].every(t => Math.abs(t.k) < 2 ** 20)
  const constant = p => !p.a && !p.terms.size
  // An expression that only computes, over locals that hold at `at`: what
  // names it ({ key, moves }: the locals by the writes they hold, `moves`
  // where one is of this round), or null.
  const COMPUTES = /^i(32|64)\.(add|sub|mul|and|or|xor|shl|shr_[su]|rem_[su]|div_[su]|wrap_i64|extend_i32_[su]|eqz|eq|ne|[lg][te]_[su])$/
  const plain = (e, at) => {
    if (!isArr(e)) return { key: String(e), moves: false }
    if (e[0] === 'local.get') {
      const x = e[1]
      if (!word(x) || later.has(x)) return null
      if (still(x)) return { key: x, moves: false }
      if (at === AHEAD) return null
      if (x === counter) return { key: x, moves: true }
      const d = defOf(x, at)
      return d ? { key: x + '@' + place.get(d), moves: true } : null
    }
    if (e[0] === 'i32.const' || e[0] === 'i64.const') return { key: e[0] + ' ' + e[1], moves: false }
    if (!COMPUTES.test(e[0])) return null
    // (a division by what may be zero traps where it stands)
    if (/(rem|div)_[su]$/.test(e[0]) && !((e[2]?.[0] === 'i32.const' || e[2]?.[0] === 'i64.const') && Number(e[2][1]) !== 0 && Number(e[2][1]) !== -1)) return null
    let key = '(' + e[0], moves = false
    for (let i = 1; i < e.length; i++) { const v = plain(e[i], at); if (!v) return null; key += ' ' + v.key; moves = moves || v.moves }
    return { key: key + ')', moves }
  }
  const linear = (e, at, deep = 0) => {
    if (!isArr(e) || deep > 12) return null
    const op = e[0]
    let r = null
    if (op === 'i32.const' || op === 'i64.const') {
      const bits = op === 'i64.const' ? constBits(e) : null
      const v = bits != null ? Number(BigInt.asIntN(64, bits)) : op === 'i32.const' && Number.isFinite(Number(e[1])) ? Number(e[1]) | 0 : NaN
      r = Number.isSafeInteger(v) ? { c: v, a: 0, moves: false, terms: new Map() } : null
    } else if (op === 'local.get') {
      const x = e[1]
      if (!word(x)) return null
      if (x === counter) r = at === AHEAD ? null : { c: 0, a: 1, moves: false, terms: new Map() }
      else if (still(x)) r = given.get(x) ?? (later.has(x) ? null : leaf(x, e, types.get(x), false))
      else { const d = defOf(x, at); r = d ? (linear(d[2], d, deep + 1) ?? leaf(x + '@' + place.get(d), e, types.get(x), true)) : null }
    } else if ((op === 'i32.add' || op === 'i32.sub' || op === 'i64.add' || op === 'i64.sub') && e.length === 3) {
      const p = linear(e[1], at, deep + 1), q = p && linear(e[2], at, deep + 1)
      r = q && sum(p, q, op.endsWith('add') ? 1 : -1)
    } else if ((op === 'i32.mul' || op === 'i64.mul') && e.length === 3) {
      const p = linear(e[1], at, deep + 1), q = p && linear(e[2], at, deep + 1)
      const k = q && (constant(p) ? p : constant(q) ? q : null)
      r = k && times(k === p ? q : p, k.c)
    } else if ((op === 'i32.shl' || op === 'i64.shl') && e.length === 3 && (e[2]?.[0] === 'i32.const' || e[2]?.[0] === 'i64.const')) {
      const p = linear(e[1], at, deep + 1)
      r = p && times(p, 2 ** (Number(e[2][1]) & (op === 'i32.shl' ? 31 : 63)))
    } else if ((op === 'i32.wrap_i64' || op === 'i64.extend_i32_s' || op === 'i64.extend_i32_u') && e.length === 2) r = linear(e[1], at, deep + 1)
    // (the sums are taken to 2^32, where an extension and a wrap are the value they take)
    if (!r && op !== 'local.get') {
      const v = plain(e, at), type = typeOf(e, types)
      r = v && type ? leaf(v.key, e, type, v.moves) : null
    }
    return r && small(r) ? r : null
  }
  // The sum as an i64, the counter at `j` (an i64 expression), plus `more`.
  const wide = (p, j, more = 0) => {
    let out = null
    const add = x => { out = out ? ['i64.add', out, x] : x }
    for (const t of p.terms.values()) {
      const v = t.type === 'i64' ? clone(t.node) : ['i64.extend_i32_s', clone(t.node)]
      add(t.k === 1 ? v : ['i64.mul', v, ['i64.const', String(t.k)]])
    }
    if (p.a) add(p.a === 1 ? j : ['i64.mul', j, ['i64.const', String(p.a)]])
    if (p.c + more || !out) add(['i64.const', String(p.c + more)])
    return out
  }
  // The sum as the word an index is.
  const narrow = (p, more = 0) => {
    const only = p.terms.size === 1 && !p.a ? [...p.terms.values()][0] : null
    if (only && only.k === 1 && only.type === 'i32') return p.c + more ? ['i32.add', clone(only.node), ['i32.const', p.c + more]] : clone(only.node)
    if (!p.terms.size && p.a === 1) return p.c + more ? ['i32.add', ['local.get', counter], ['i32.const', p.c + more]] : ['local.get', counter]
    return ['i32.wrap_i64', wide(p, ['i64.extend_i32_s', ['local.get', counter]], more)]
  }
  // (one write each, read in the order they are written: a local written
  // further on is not yet what its sum would say)
  const before = holder.slice(0, holder.indexOf(loop)).filter(st => isArr(st) && st[0] === 'local.set')
  const once = new Map()
  for (const st of before) { later.add(st[1]); once.set(st[1], (once.get(st[1]) ?? 0) + 1) }
  for (const st of before) {
    if (once.get(st[1]) !== 1) continue   // (it stays in `later`: no sum reads it)
    const form = still(st[1]) && word(st[1]) ? linear(st[2], AHEAD) : null
    later.delete(st[1])
    if (form) given.set(st[1], form)
  }
  const keyOf = p => JSON.stringify([p.a, p.c, [...p.terms].map(([x, t]) => [x, t.k]).sort((u, v) => u[0] < v[0] ? -1 : 1)])
  const less = (p, c) => ({ c, a: p.a, moves: p.moves, terms: p.terms })

  // A read the program keeps from an index it does not take (`i > 0 ? a[i - 1]
  // : 0`, a stencil's border) is tested where it stands: ahead of the test that
  // keeps it, its guard would leave on a round that reads nothing. Such a read
  // is one a test on the way to it shields: a conditional it is an arm of, or
  // a branch it comes after, that reads a local its index is made of.
  const expand = (e, out, deep = 0) => {
    if (!isArr(e)) return out
    if (e[0] === 'local.get' || e[0] === 'local.tee') {
      if (!out.has(e[1])) {
        out.add(e[1])
        if (deep < 4 && !still(e[1]) && e[1] !== counter) for (const w of writes.get(e[1])) expand(w[2], out, deep + 1)
      }
      if (e[0] === 'local.get') return out
    }
    for (let i = 1; i < e.length; i++) expand(e[i], out, deep)
    return out
  }
  const madeOf = form => {
    const out = new Set()
    if (form.a) out.add(counter)
    for (const t of form.terms.values()) expand(t.node, out)
    return out
  }
  // (a guard is no branch of the program's: where it leaves, the loop as written goes on)
  const guard = n => (n[0] === 'br_if' || n[0] === 'br') && typeof n[1] === 'string' && n[1].startsWith('$__sp')
  const leaves = n => isArr(n) && !guard(n) && (n[0] === 'br' || n[0] === 'br_if' || n[0] === 'br_table' || n[0] === 'return' || n.some(leaves))
  // (the tests of what stands in `n`: a branch's, a conditional's that holds one)
  const gather = (n, out) => {
    if (!isArr(n) || n === top || guard(n)) return
    if (n[0] === 'br_if') out.push(n[n.length - 1])
    else if (n[0] === 'if' && n.some(c => isArr(c) && (c[0] === 'then' || c[0] === 'else') && leaves(c))) out.push(conditional(n).test)
    for (let i = 1; i < n.length; i++) gather(n[i], out)
  }
  const crossed = (from, node) => {
    const out = [], q = chain(node), p = from ? chain(from) : []
    let i = 0
    while (i < p.length && i < q.length && p[i][0] === q[i][0] && p[i][1] === q[i][1]) i++
    for (let k = i; k < q.length; k++) {
      const [h, at] = q[k]
      if (h[0] === 'if') { if (h[at]?.[0] === 'then' || h[at]?.[0] === 'else') out.push(conditional(h).test); continue }
      for (let j = k === i && from ? p[i][1] + 1 : 1; j < at; j++) gather(h[j], out)
    }
    return out
  }
  const shielded = (from, g) => {
    const made = madeOf(g.index)
    if (!made.size) return false
    for (const t of crossed(from, g.by)) for (const x of expand(t, new Set())) if (made.has(x)) return true
    return false
  }

  // Each guard: its index less its constant, its length, what it leaves to.
  const read = []
  for (const by of guards) {
    let test = by[2][1]
    if (test?.[0] === 'local.get' && !still(test[1])) { const d = defOf(test[1], by); test = d ? d[2] : null }
    if (test?.[0] !== 'i32.lt_u' || test.length !== 3) continue
    const index = linear(test[1], by), length = index && linear(test[2], by)
    if (!length) continue
    read.push({ by, index, length, key: keyOf(less(index, 0)) + '<' + keyOf(length), c: index.c })
  }
  if (!read.length) return false

  // Ahead of the loop: the indices of no round, and the counter's.
  const ahead = new Map()
  for (const g of read) {
    if (g.index.moves || g.length.moves || g.length.a || shielded(null, g)) continue
    const at = ahead.get(g.key)
    if (at) { at.lo = Math.min(at.lo, g.c); at.hi = Math.max(at.hi, g.c) } else ahead.set(g.key, { g, lo: g.c, hi: g.c })
    g.done = true
    g.by.length = 0
    g.by.push('nop')
  }
  const tests = [], asked = new Set()
  const ask = test => { const key = JSON.stringify(test); if (!asked.has(key)) { asked.add(key); tests.push(['br_if', slow, test]) } }
  for (const { g, lo, hi } of ahead.values()) {
    const base = less(g.index, 0), len = wide(g.length, null)
    if (!base.a) {
      ask(['i64.ge_u', wide(base, null, lo), clone(len)])
      if (hi !== lo) ask(['i64.ge_u', wide(base, null, hi), len])
      continue
    }
    const first = ['i64.extend_i32_s', ['local.get', counter]], last = ['i64.sub', ['i64.extend_i32_s', clone(bound)], ['i64.const', '1']]
    ask(['i64.lt_s', wide(base, base.a > 0 ? first : last, lo), ['i64.const', '0']])
    ask(['i64.ge_s', wide(base, base.a > 0 ? clone(last) : clone(first), hi), len])
  }
  if (tests.length) holder.splice(holder.indexOf(loop), 0, ...tests)

  // In the round: the first guard of each run of one array's neighbours.
  const led = new Map()
  let merged = false
  for (const g of read) {
    if (g.done) continue
    const key = g.by[1] + ' ' + g.key, at = led.get(key)
    if (at && runsBefore(at.g.by, g.by) && !shielded(at.g.by, g)) { at.lo = Math.min(at.lo, g.c); at.hi = Math.max(at.hi, g.c); at.rest.push(g) }
    else led.set(key, { g, lo: g.c, hi: g.c, rest: [] })
  }
  for (const { g, lo, hi, rest } of led.values()) {
    if (!rest.length) continue
    const base = less(g.index, 0)
    const within = c => ['i32.lt_u', narrow(base, c), narrow(g.length)]
    g.by[2] = ['i32.eqz', lo === hi ? within(lo) : ['i32.and', within(lo), within(hi)]]
    for (const r of rest) { r.by.length = 0; r.by.push('nop') }
    merged = true
  }
  return merged || tests.length > 0
}

/** Combine the guards of the specialized loops of `fn`. Returns whether the
 *  function changed. */
export function combineGuards(fn) {
  if (!isArr(fn) || fn[0] !== 'func') return false
  const types = new Map()
  let bodyStart = 2
  for (; bodyStart < fn.length; bodyStart++) {
    const d = fn[bodyStart]
    if (!isArr(d) || !DECL.has(d[0])) break
    if ((d[0] === 'param' || d[0] === 'local') && typeof d[1] === 'string') types.set(d[1], d[2])
  }
  const loops = []
  const find = (n, holder) => {
    if (!isArr(n)) return
    if (n[0] === 'loop' && typeof n[1] === 'string' && TAG.test(n[1])) loops.push([n, holder])
    for (let i = 1; i < n.length; i++) find(n[i], n)
  }
  for (let i = bodyStart; i < fn.length; i++) find(fn[i], fn)
  let did = false
  for (const [loop, holder] of loops) if (combine(loop, holder, TAG.exec(loop[1])[1], types)) did = true
  return did
}
