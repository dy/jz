/**
 * A loop's lane minima and maxima take the engine's own minimum and maximum, the
 * relaxed ones, checked once a round where those are not IEEE's (speed tier,
 * relaxed SIMD).
 *
 * `Math.min` and `Math.max` are f64x2.min and f64x2.max in a lane: a NaN of either
 * operand is the result, and -0 orders below +0. V8 lowers each on x64 to seven and
 * eight instructions, two minpd or maxpd and the steps that mend their NaN and
 * signed-zero answers, and on arm64 to one fmin or fmax. f64x2.relaxed_min is one
 * minpd on x64 and one fmin on arm64: the engine picks its answer where an operand
 * is NaN or the operands are zeros of two signs, the same way for as long as the
 * program runs (the core specification's relaxed parameters, fixed per execution).
 *
 * Over operands none of which is NaN, every such choice answers the minimum's value
 * and errs at most in the sign of a zero; so a tree of them over leaves none of which
 * is NaN answers every node's value, and a root that is not zero exactly. The round
 * computes its trees (the lane mins and maxes nested in one another, the operands
 * they meet the leaves) with the relaxed operators, into locals ahead of what reads
 * them, and tests one value: the sum of the leaves times every root, which is zero or
 * NaN where a leaf is NaN or a root is zero (and may be where a sum cancels or a
 * product underflows). Where it fails, a second test looks for a NaN reaching a root
 * or a leaf the chains below leave out, and for a -0 leaf, and only where it finds one
 * are the trees taken again with f64x2.min and f64x2.max from the same leaves: a clamp
 * to 0 or a color's zero channel makes a zero root, and no -0. With a quarter of hsl's
 * channels 0 at random, the exact trees after the first test alone took 1.07x to 1.12x
 * the time of f64x2.min on x64, the second test 0.88x to 0.90x.
 *
 * Each call asks the engine once, before its first statement, how it answers
 * relaxed_min and relaxed_max of a NaN and a number in both orders, the NaN read from
 * a global the engine cannot fold, and the loop runs as a copy for the answer. Both
 * NaN is IEEE's answer (arm64's fmin): a copy that tests nothing, its relaxed
 * operators exact, and none of the test's code in its round (on an Apple M4 that code,
 * never run there, made hwb's round run anywhere from 0.85x to 1.04x the time from
 * one process to the next). The other copy tests. Where the engine answers the second
 * operand (V8's minpd on x64) a NaN along a tree's chain of second operands reaches
 * its root, where it answers the first one along the chain of first operands; the
 * two chains part at the root, and each tree's operands are ordered for its chains to
 * end at leaves another tree's chains cover under the other answer, so a minimum and
 * a maximum of the same leaves leave one of them to the sum. Any other answer takes
 * the trees again every round.
 *
 * A tree is taken where it stands first in what its statement evaluates (nothing
 * before it writes a local or has an effect), and a later statement's tree moves up
 * to the first one past statements that neither branch nor call, write nothing it
 * reads or writes, read nothing it writes, and store nothing where it loads; the
 * test follows the last. Trees inside a construct of the round stay as they are, and a
 * tree writing a local an earlier tree's root is (`m = min(m, a); m = min(m, b)`): the
 * trees taken again in order would read a relaxed value or overwrite a later one.
 * hsl's round of a lane pair, rgb to hsl, takes its minimum and maximum of the three
 * channels so, and hwb's its four trees.
 *
 * @module optimize/relaxed-extremes
 */

const isArr = Array.isArray
const EXACT = new Set(['f64x2.min', 'f64x2.max'])
const RELAX = { 'f64x2.min': 'f64x2.relaxed_min', 'f64x2.max': 'f64x2.relaxed_max' }
const LABELLED = new Set(['block', 'loop', 'if', 'try', 'try_table'])
const LISTS = new Set(['func', 'block', 'loop', 'then', 'else'])
const HEADER = new Set(['export', 'param', 'result', 'local', 'type'])
const NAN = '$__rnan'

const isTree = (n) => isArr(n) && EXACT.has(n[0]) && n.length === 3
const local = (n) => isArr(n) && (n[0] === 'local.get' || n[0] === 'local.set' || n[0] === 'local.tee')
const stores = (h) => h.indexOf('store') >= 0 || h.indexOf('atomic') >= 0 || h.startsWith('memory.')
const control = (h) => LABELLED.has(h) || h.startsWith('call') || h.startsWith('br') || h.startsWith('return') ||
  h.startsWith('throw') || h === 'rethrow' || h === 'delegate' || h === 'unreachable' || h.startsWith('table.') ||
  h.endsWith('.set') && h !== 'local.set'

const fresh = () => ({ reads: new Set(), writes: new Set(), stores: false, control: false, loads: false })
/** What node `n` itself reads, writes and does, its operands aside, added into `s`. */
const own = (n, s) => {
  const h = n[0]
  if (h === 'local.get') s.reads.add(n[1])
  else if (h === 'local.set' || h === 'local.tee') s.writes.add(n[1])
  else if (typeof h === 'string') {
    if (control(h)) s.control = true
    else if (stores(h)) s.stores = true
    else if (h.indexOf('load') >= 0) s.loads = true
  }
  return s
}
/** What evaluating `n` reads, writes and does, added into `s`. */
const sum = (n, s = fresh()) => {
  if (!isArr(n)) return s
  for (let i = 1; i < n.length; i++) sum(n[i], s)
  return own(n, s)
}
const meets = (a, b) => { for (const x of a) if (b.has(x)) return true; return false }
const some = (n, f) => isArr(n) && (f(n) || n.some((c, i) => i > 0 && some(c, f)))

/** The first tree statement `s` evaluates and what it evaluates before it: { parent, at, before }, or null. */
const firstTree = (s) => {
  const before = fresh()
  let found = null
  const visit = (n, parent, at) => {
    if (found || !isArr(n)) return
    if (isTree(n)) { found = { parent, at, before }; return }
    if (LABELLED.has(n[0])) { before.control = true; return }
    for (let i = 1; i < n.length; i++) { visit(n[i], n, i); if (found) return }
    own(n, before)
  }
  visit(s, null, 0)
  return found
}

/** Take the trees of `loop`'s round with the relaxed operators, tested after the last one: the
 *  `if` choosing that loop where the engine is not IEEE's and an untested copy where it is, or null. */
function relaxLoop(loop, names) {
  let start = typeof loop[1] === 'string' ? 2 : 1
  if (loop.slice(start).some(c => isArr(c) && (c[0] === 'result' || c[0] === 'param' || c[0] === 'type'))) return null
  const trees = [], roots = new Set()   // { root, tree } in the order the round takes them
  let first = -1, pend = fresh()
  const out = []              // the round's statements, the trees taken out of them
  for (let i = start; i < loop.length; i++) {
    let s = loop[i]
    for (let f = firstTree(s); f; f = firstTree(s)) {
      const T = f.parent ? f.parent[f.at] : s, t = sum(T)
      const whole = !f.parent ? null : f.parent === s && s[0] === 'local.set' && f.at === 2 ? s[1] : null
      // (a root the round writes once: the exact trees, taken again in order, then read each other's)
      if (meets(t.writes, roots) || whole && (t.writes.has(whole) || roots.has(whole))) break
      if (whole) t.writes.add(whole)
      const here = !f.before.control && !f.before.stores && !f.before.writes.size && !meets(t.writes, f.before.reads)
      const moves = first < 0 || !pend.control && !(t.loads && pend.stores) && !meets(pend.writes, t.reads) &&
        !meets(pend.writes, t.writes) && !meets(pend.reads, t.writes)
      // (a store of a tree computes its address first, into a local of its own)
      const addr = !here && moves && f.parent && stores(s[0]) && s[0].indexOf('atomic') < 0 ? s.findIndex((c, k) => k > 0 && isArr(c)) : -1
      if (addr > 0 && typeof s[addr][0] === 'string' && s[addr][0].startsWith('i32.') && !sum(s[addr]).control && !sum(s[addr]).stores) {
        const a = names.i32(), set = ['local.set', a, s[addr]]
        s[addr] = ['local.get', a]
        out.push(set)
        if (first >= 0) sum(set, pend)
        continue
      }
      if (!f.parent || t.control || t.stores || !here || !moves) break
      if (first < 0) first = out.length
      const root = whole ?? names.v128()
      trees.push({ root, tree: T })
      roots.add(root)
      if (whole) { s = null; break }
      f.parent[f.at] = ['local.get', root]
    }
    if (s === null) continue
    out.push(s)
    if (first >= 0) sum(s, pend)
  }
  if (!trees.length) return null

  // (the leaves into locals that hold them through the test: the trees read locals alone)
  const seq = []              // { set, carrier, leaf } and { root, tree }, in evaluation order
  for (const e of trees) {
    const leaves = (n) => {
      for (const k of [1, 2]) {
        const c = n[k]
        if (isTree(c)) { leaves(c); continue }
        const item = { set: null, carrier: null, at: n, k }
        if (isArr(c) && c[0] === 'local.get' && typeof c[1] === 'string') item.carrier = c[1]
        else if (isArr(c) && c[0] === 'local.tee' && typeof c[1] === 'string') { item.carrier = c[1]; item.set = ['local.set', c[1], c[2]] }
        else { item.carrier = names.v128(); item.set = ['local.set', item.carrier, c] }
        seq.push(item)
      }
    }
    leaves(e.tree)
    seq.push(e)
  }
  const writes = (x) => x.tree ? new Set([x.root]) : x.set ? sum(x.set).writes : new Set()
  for (let i = 0; i < seq.length; i++) {
    const x = seq[i]
    if (x.tree || !seq.slice(i + 1).some(y => writes(y).has(x.carrier))) continue
    const keep = names.v128()
    x.set = ['local.set', keep, x.set ? ['local.tee', x.carrier, x.set[2]] : ['local.get', x.carrier]]
    x.carrier = keep
  }
  for (const x of seq) if (!x.tree) x.at[x.k] = ['local.get', x.carrier]

  // (a NaN reaches a tree's root along its chain of second operands where the engine answers the
  // second, as x64's minpd does, and of first operands where it answers the first: the chains part
  // at the root, each ordered to end at a leaf, so that a leaf one tree's chain covers under one
  // answer another's covers under the other)
  const second = new Set(trees.map(e => e.root)), first1 = new Set(second), keys = []
  const leafKeys = (n, acc = []) => { for (const k of [1, 2]) isTree(n[k]) ? leafKeys(n[k], acc) : acc.push(n[k][1]); return acc }
  const side = (n) => isTree(n) ? leafKeys(n) : [n[1]]
  const chain = (n, key, k) => {
    if (!isTree(n)) return n[1] === key
    if (chain(n[k], key, k)) return true
    if (!chain(n[3 - k], key, k)) return false
    const a = n[1]; n[1] = n[2]; n[2] = a
    return true
  }
  for (const e of trees) {
    const t = e.tree
    for (const k of leafKeys(t)) if (!keys.includes(k)) keys.push(k)
    const gain = (x, y) => (second.has(x) ? 0 : first1.has(x) ? 3 : 1) + (first1.has(y) ? 0 : second.has(y) ? 3 : 1)
    let best = null
    for (const [a, b, swap] of [[side(t[2]), side(t[1]), false], [side(t[1]), side(t[2]), true]])
      for (const x of a) for (const y of b) if (!best || gain(x, y) > best.g) best = { x, y, swap, g: gain(x, y) }
    if (best.swap) { const a = t[1]; t[1] = t[2]; t[2] = a }
    chain(t[2], best.x, 2); chain(t[1], best.y, 1)
    second.add(best.x); first1.add(best.y)
  }
  const covered = new Set([...second].filter(k => first1.has(k)))
  const relax = (n) => isTree(n) ? [RELAX[n[0]], relax(n[1]), relax(n[2])] : n
  const exact = (n) => isTree(n) ? [n[0], exact(n[1]), exact(n[2])] : ['local.get', n[1]]
  let c = null
  for (const k of keys) if (!covered.has(k)) c = c ? ['f64x2.add', c, ['local.get', k]] : ['local.get', k]
  for (const e of trees) c = c ? ['f64x2.mul', c, ['local.get', e.root]] : ['local.get', e.root]
  const bad = ['i32.ne', ['i64x2.bitmask', ['f64x2.gt', ['f64x2.abs', c], ['v128.const', 'i64x2', '0', '0']]], ['i32.const', 3]]
  // (where it fails, a zero root among them: a NaN reaching a root or a leaf outside the chains, or a -0 leaf)
  let n = null
  for (const k of keys) if (!covered.has(k)) n = n ? ['f64x2.add', n, ['local.get', k]] : ['local.get', k]
  for (const e of trees) n = n ? ['f64x2.add', n, ['local.get', e.root]] : ['local.get', e.root]
  const t = names.v128()
  let odd = ['f64x2.ne', ['local.tee', t, n], ['local.get', t]]
  for (const k of keys) odd = ['v128.or', odd, ['i64x2.eq', ['local.get', k], ['v128.const', 'i64x2', '-9223372036854775808', '-9223372036854775808']]]
  const fix = ['i32.or', ['local.get', names.fix], ['i64x2.bitmask', odd]]
  const region = []
  for (const x of seq) if (x.tree) region.push(['local.set', x.root, relax(x.tree)]); else if (x.set) region.push(x.set)
  const plain = [...out.slice(0, first), ...region, ...out.slice(first)]
  out.splice(first, 0, ...region, ['if', ['i32.or', ['local.get', names.fix], bad], ['then',
    ['if', fix, ['then', ...trees.map(e => ['local.set', e.root, exact(e.tree)])]]]])
  // (the round as an IEEE engine runs it, untested, its labels its own)
  const copy = relabel(clone([...loop.slice(0, start), ...plain]), names.label)
  loop.length = start
  loop.push(...out)
  return ['if', ['local.get', names.check], ['then', loop], ['else', copy]]
}

const clone = (n) => isArr(n) ? n.map(clone) : n
/** `n` with every label it declares renamed by `fresh`, and every branch to one. */
const relabel = (n, fresh) => {
  const to = new Map()
  const declare = (m) => {
    if (!isArr(m)) return
    if (LABELLED.has(m[0]) && typeof m[1] === 'string' && m[1][0] === '$') to.set(m[1], fresh(m[1]))
    for (let i = 1; i < m.length; i++) declare(m[i])
  }
  const rename = (m) => {
    if (!isArr(m)) return
    const branch = typeof m[0] === 'string' && (LABELLED.has(m[0]) || m[0].startsWith('br') || m[0] === 'delegate' || m[0] === 'rethrow')
    for (let i = 1; i < m.length; i++) {
      if (branch && typeof m[i] === 'string' && to.has(m[i])) m[i] = to.get(m[i])
      else rename(m[i])
    }
  }
  declare(n)
  rename(n)
  return n
}

/** Take the lane extremes of every loop of `ast` (a module) with the engine's relaxed operators, checked once a round. */
export function relaxExtremes(ast) {
  if (!isArr(ast)) return ast
  let any = false, firstFunc = -1
  for (let f = 0; f < ast.length; f++) {
    const fn = ast[f]
    if (!isArr(fn) || fn[0] !== 'func') continue
    if (firstFunc < 0) firstFunc = f
    // (most functions hold no lane extreme: one walk that stops at the first, nothing built)
    if (!some(fn, isTree)) continue
    let byIndex = false
    const taken = new Set(), labels = new Set()
    const scan = (n) => {
      if (!isArr(n)) return
      if (local(n) && typeof n[1] !== 'string') byIndex = true
      // (a branch by depth would reach another label once a loop is wrapped)
      if (typeof n[0] === 'string' && n[0].startsWith('br') && n.some((c, i) => i > 0 && (typeof c === 'number' || typeof c === 'string' && c[0] >= '0' && c[0] <= '9'))) byIndex = true
      if ((n[0] === 'local' || n[0] === 'param') && typeof n[1] === 'string') taken.add(n[1])
      if (LABELLED.has(n[0]) && typeof n[1] === 'string') labels.add(n[1])
      for (let i = 1; i < n.length; i++) scan(n[i])
    }
    scan(fn)
    if (byIndex) continue
    const decls = []
    let id = 0
    const name = (type) => {
      let x = `$__rx${id++}`
      while (taken.has(x)) x = `$__rx${id++}`
      taken.add(x)
      decls.push(['local', x, type])
      return x
    }
    let made = 0
    const label = (base) => {
      let x = `${base}_rx${made++}`
      while (labels.has(x)) x = `${base}_rx${made++}`
      labels.add(x)
      return x
    }
    const names = { v128: () => name('v128'), i32: () => name('i32'), label, check: null, fix: null }
    names.check = name('i32'); names.fix = name('i32')
    let done = false
    // innermost first; a loop holding one taken so stays as it is
    const walk = (n) => {
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        if (!isArr(c)) continue
        walk(c)
        if (c[0] !== 'loop' || !LISTS.has(n[0]) || some(c, m => m[0] === RELAX['f64x2.min'] || m[0] === RELAX['f64x2.max'])) continue
        const v = relaxLoop(c, names)
        if (v) { n[i] = v; done = true }
      }
    }
    walk(fn)
    if (!done) continue
    any = true
    // (how the engine answers relaxed_min and relaxed_max of a NaN and a number, each order a lane)
    const k = name('i32'), v = name('v128'), a = name('v128'), b = name('v128')
    const nanAt = (lane, other) => ['f64x2.replace_lane', lane, ['v128.const', 'f64x2', ...other], ['global.get', NAN]]
    const nans = (op, x, y) => ['i64x2.bitmask', ['f64x2.ne', ['local.tee', v, [op, x, y]], ['local.get', v]]]
    const ask = [
      ['local.set', names.check, ['i32.ne', ['local.tee', k, ['i32.or',
        nans('f64x2.relaxed_min', ['local.tee', a, nanAt(0, ['0', '1'])], ['local.tee', b, nanAt(1, ['1', '0'])]),
        ['i32.shl', nans('f64x2.relaxed_max', ['local.get', a], ['local.get', b]), ['i32.const', 2]]]], ['i32.const', 15]]],
      ['local.set', names.fix, ['i32.and', ['i32.ne', ['local.get', k], ['i32.const', 10]], ['i32.ne', ['local.get', k], ['i32.const', 5]]]],
    ]
    let at = typeof fn[1] === 'string' ? 2 : 1
    while (at < fn.length && isArr(fn[at]) && HEADER.has(fn[at][0])) at++
    fn.splice(at, 0, ...decls, ...ask)
  }
  if (any) ast.splice(firstFunc, 0, ['global', NAN, ['mut', 'f64'], ['f64.const', 'nan']])
  return ast
}
