// A test that failed stays failed. `(if T (then … leaves))` lets control past
// only where T is false, and T of locals and constants keeps its answer until
// one of its locals is written: a later `if` of the same T never takes its arm.
// The receiver guards of one binding are the shape (`doc.length`, then `doc[k]`
// twice: three tests for undefined, the first of them in the loop's condition).
//
// The walk follows evaluation order and carries the settled tests and what
// each local holds, so a guard on a capture (`$ai = $doc`) is the guard on the
// binding. A fact holds where it dominates: down into arms and loops that
// leave its locals alone, and past an `if` or a block only by every way out.

const isArr = Array.isArray
const PURE = /^(?:i32|i64|f64)\.(?:const|eq|ne|eqz|and|or|lt_[su]|le_[su]|gt_[su]|ge_[su]|lt|le|gt|ge|wrap_i64|reinterpret_[fi]\d\d)$/
const ENDS = new Set(['unreachable', 'return', 'br', 'br_table', 'throw', 'throw_ref', 'rethrow', 'return_call', 'return_call_indirect', 'return_call_ref'])
const TRY = new Set(['try', 'try_table'])
// (each map is copied at every branch: bounded, the walk stays linear)
const MAX_FACTS = 64

const writesOf = (n, out = new Set()) => {
  if (!isArr(n)) return out
  if (n[0] === 'local.set' || n[0] === 'local.tee') out.add(n[1])
  for (let i = 1; i < n.length; i++) writesOf(n[i], out)
  return out
}
const branchesTo = (n, label) => {
  if (!isArr(n)) return false
  if ((n[0] === 'br' || n[0] === 'br_if') && n[1] === label || n[0] === 'br_table' && n.includes(label)) return true
  for (let i = 1; i < n.length; i++) if (branchesTo(n[i], label)) return true
  return false
}
// Control never runs past the arm's or the block's last statement.
const leaves = n => {
  if (!isArr(n)) return false
  if (ENDS.has(n[0])) return true
  if (n[0] === 'block' && typeof n[1] === 'string' && branchesTo(n, n[1])) return false
  return (n[0] === 'drop' || n[0] === 'block' || n[0] === 'then' || n[0] === 'else') && leaves(n[n.length - 1])
}

const copy = s => ({ failed: new Map(s.failed), holds: new Map(s.holds), seen: s.seen })
const killName = (s, name) => {
  s.holds.delete(name)
  for (const [k, v] of s.holds) if (v.reads.has(name)) s.holds.delete(k)
  for (const [k, reads] of s.failed) if (reads.has(name)) s.failed.delete(k)
}
const meet = (s, a, b) => {
  const failed = new Map(), holds = new Map()
  for (const [k, v] of a.failed) if (b.failed.has(k)) failed.set(k, v)
  for (const [k, v] of a.holds) if (b.holds.get(k)?.key === v.key) holds.set(k, v)
  s.failed = failed
  s.holds = holds
}

// An expression evaluated in order: its writes applied as they run, and, where
// it computes over locals and constants alone, its text and the locals it
// reads, seen through what they hold (a tee reads as its value).
const evalIn = (n, s) => {
  if (!isArr(n)) return null
  const op = n[0]
  if (op === 'local.get') return s.holds.get(n[1]) ?? { key: n[1], reads: new Set([n[1]]) }
  if (op === 'local.set' || op === 'local.tee') {
    const v = evalIn(n[2], s)
    killName(s, n[1])
    if (v && !v.reads.has(n[1]) && s.holds.size < MAX_FACTS) s.holds.set(n[1], v)
    return op === 'local.tee' ? v : null
  }
  if (!PURE.test(op)) { walk(n, s); return null }
  if (op.endsWith('.const')) return { key: `${op}:${n[1]}`, reads: new Set() }
  let key = op, pure = true
  const reads = new Set()
  for (let i = 1; i < n.length; i++) {
    const v = evalIn(n[i], s)
    if (!v) { pure = false; continue }
    key += ` (${v.key})`
    for (const r of v.reads) reads.add(r)
  }
  return pure ? { key, reads } : null
}
// A test's parts in order (`a | b` failed where each part did).
const partsIn = (n, s) => isArr(n) && n[0] === 'i32.or' ? [...partsIn(n[1], s), ...partsIn(n[2], s)] : [evalIn(n, s)]

// The writes of a pure test in order, each of a value read through the ones before.
const teesOf = (n, out = []) => {
  if (!isArr(n)) return out
  for (let i = 1; i < n.length; i++) teesOf(n[i], out)
  if (n[0] === 'local.tee') out.push(['local.set', n[1], untee(n[2])])
  return out
}
const untee = n => !isArr(n) ? n : n[0] === 'local.tee' ? ['local.get', n[1]] : n.map((c, i) => i ? untee(c) : c)

const walkAll = (n, from, s) => { for (let i = from; i < n.length; i++) walk(n[i], s) }

function walk(n, s) {
  if (!isArr(n)) return
  const op = n[0]
  if (op === 'local.set' || op === 'local.tee') { evalIn(n, s); return }
  if (op === 'if') {
    let at = 1
    while (isArr(n[at]) && n[at][0] === 'result') at++
    const cond = n[at], yes = n[at + 1], no = n[at + 2]
    const parts = partsIn(cond, s)
    // (a node two parents share answers for both: it goes only if it was reached once)
    s.seen.set(n, s.seen.has(n) ? false : !no && at === 1 && parts.every(v => v && s.failed.has(v.key)))
    if (s.seen.get(n)) return
    const a = copy(s)
    walk(yes, a)
    if (leaves(yes)) {
      // (a part that reads a local the test itself writes says nothing past it)
      const written = writesOf(cond)
      for (const v of parts) if (v && ![...v.reads].some(r => written.has(r)) && (s.failed.size < MAX_FACTS || s.failed.has(v.key))) s.failed.set(v.key, v.reads)
    }
    if (no) walk(no, s)
    if (leaves(yes)) return
    if (no && leaves(no)) { s.failed = a.failed; s.holds = a.holds; return }
    meet(s, a, s)
    return
  }
  if (op === 'loop' || TRY.has(op)) {
    for (const name of writesOf(n)) killName(s, name)
    const inner = copy(s)
    if (op === 'loop') walkAll(n, 1, inner)
    else for (let i = 1; i < n.length; i++) walk(n[i], copy(s))
    return
  }
  if (op === 'block' && typeof n[1] === 'string' && branchesTo(n, n[1])) {
    const entry = copy(s)
    walkAll(n, 1, s)
    for (const name of writesOf(n)) killName(entry, name)
    s.failed = entry.failed; s.holds = entry.holds
    return
  }
  walkAll(n, 1, s)
}

/** Drop the `if`s a dominating `if` of the same test already settled. */
export function dropSettledTests(fn) {
  const s = { failed: new Map(), holds: new Map(), seen: new Map() }
  for (let i = 2; i < fn.length; i++) walk(fn[i], s)
  // (the test computes alone: it goes, its tees stay)
  for (const [n, drop] of s.seen) if (drop) n.splice(0, n.length, 'block', ...teesOf(n[1]))
}
