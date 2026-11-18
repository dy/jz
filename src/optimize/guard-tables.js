/**
 * A run of guarded exits on one word is a dispatch, and it takes a table:
 *
 *   (if (i32.eq (local.get $s) (i32.const K1)) (then A1 … leaves))
 *   (if (i32.eq (local.get $s) (i32.const K2)) (then A2 … leaves))   …
 *
 * statements one after another, each arm leaving (a branch, a return, a throw),
 * each K its own: the arm of the one K the word holds runs, or none, and the
 * statement after the run follows. With the keys dense it becomes
 *
 *   (block $e (block $aN … (block $a1 (br_table $a1 … $e (i32.sub (local.get $s) (i32.const L))))
 *     A1 …) … AN …)
 *
 * a key the run lacks and a word outside the keys going to $e. watr builds the
 * same table from the dispatch written as an else-if chain (optimize.js
 * chainTable), which src/list-form.js and jzify/switch.js write as a run once it
 * passes LEN links: the walks after the parse recurse down a chain. This is
 * chainTable for the run, after watr, where the word is narrowed and read
 * through one local, and under its gates: CHAIN_MIN arms, keys dense (their span
 * at most twice their count), and no table where every arm is light and one
 * loads (a compare chain, each test biased, predicts better than the table's
 * indirect branch). A `(br_if $l test)` is an arm whose body is `(br $l)`.
 *
 * A table nests a block an arm, so a run of more than WIDTH arms takes a table
 * a WIDTH of its keys, in turn: the walks after this one recurse a few frames a
 * block, as those before it did a link.
 *
 * @module optimize/guard-tables
 */

const isArr = Array.isArray
const CHAIN_MIN = 5, LIGHT_ARM_CAP = 48, WIDTH = 512
const ENDS = new Set(['unreachable', 'return', 'br', 'br_table', 'throw', 'throw_ref', 'rethrow', 'return_call', 'return_call_indirect', 'return_call_ref'])
// (the branches and handlers whose label a new block would move, were it a depth)
const LABELED = new Set(['br', 'br_if', 'br_table', 'rethrow', 'delegate', 'catch', 'catch_ref', 'catch_all', 'catch_all_ref'])

// A key: a constant, or an immutable global of one (watr pools a constant the
// function repeats, the arm's own `start = K` beside its test among them).
let pooled = new Map()
const keyOf = (n) => {
  if (!isArr(n) || n.length !== 2) return null
  if (n[0] === 'global.get') return pooled.get(n[1]) ?? null
  return n[0] === 'i32.const' && Number.isInteger(+n[1]) ? +n[1] | 0 : null
}
// The word a test compares and the key: `(i32.eq W K)` either way round, `(i32.eqz W)`;
// W a `local.get`, or a `local.tee` (the run's first test alone may write it).
const testOf = (c) => {
  if (!isArr(c)) return null
  if (c[0] === 'i32.eqz' && c.length === 2) return wordOf(c, 1, 0)
  if (c[0] !== 'i32.eq' || c.length !== 3) return null
  const kb = keyOf(c[2])
  if (kb != null) return wordOf(c, 1, kb)
  const ka = keyOf(c[1])
  return ka != null ? wordOf(c, 2, ka) : null
}
const wordOf = (c, at, k) => {
  const w = c[at]
  if (!isArr(w) || typeof w[1] !== 'string') return null
  if (w[0] === 'local.get' && w.length === 2) return { s: w[1], k, tee: null }
  if (w[0] === 'local.tee' && w.length === 3) return { s: w[1], k, tee: { c, at } }
  return null
}

// Whether every branch and handler in `n` names its label: a depth would move.
const named = (n) => {
  const todo = [n]
  while (todo.length) {
    const m = todo.pop()
    if (!isArr(m)) continue
    if (LABELED.has(m[0])) for (let i = 1; i < m.length; i++) if (typeof m[i] === 'number' || typeof m[i] === 'string' && m[i][0] !== '$') return false
    for (let i = 1; i < m.length; i++) if (isArr(m[i])) todo.push(m[i])
  }
  return true
}

// An arm of a run: its word, key and body (the instructions it runs), or null.
const armOf = (n) => {
  if (!isArr(n)) return null
  if (n[0] === 'br_if' && n.length === 3 && typeof n[1] === 'string') {
    const t = testOf(n[2])
    return t && { ...t, body: [['br', n[1]]], node: n }
  }
  if (n[0] !== 'if' || n.length < 3 || n.length > 4) return null
  const thn = n[2], els = n[3]
  if (!isArr(thn) || thn[0] !== 'then' || thn.length < 2) return null
  if (els != null && !(isArr(els) && els[0] === 'else' && els.length === 1)) return null
  const last = thn[thn.length - 1]
  if (!isArr(last) || !ENDS.has(last[0])) return null
  const t = testOf(n[1])
  return t && { ...t, body: thn.slice(1), node: n }
}

// chainTable's cost gate: an arm of loads and arithmetic only, of a few nodes
// (the branch that leaves the run apart: the chain's arm had none).
const light = (body) => {
  let count = 0
  const todo = body.length && isArr(body[body.length - 1]) && body[body.length - 1][0] === 'br' && body[body.length - 1].length === 2 ? body.slice(0, -1) : body.slice()
  while (todo.length) {
    const x = todo.pop()
    if (!isArr(x)) continue
    const o = x[0]
    if (typeof o === 'string' && (o === 'call' || o === 'call_indirect' || o === 'loop' || o === 'if' || o === 'br_table' || o.includes('.store') || o.startsWith('memory.'))) return false
    if (++count > LIGHT_ARM_CAP) return false
    for (let i = 1; i < x.length; i++) todo.push(x[i])
  }
  return true
}
const loads = (body) => {
  const todo = body.slice()
  while (todo.length) {
    const x = todo.pop()
    if (!isArr(x)) continue
    if (typeof x[0] === 'string' && x[0].includes('.load')) return true
    for (let i = 1; i < x.length; i++) todo.push(x[i])
  }
  return false
}

let uid = 0
// The table of `arms` (sorted by key, dense), or null where the gate keeps them.
const table = (arms, s) => {
  if (arms.length < CHAIN_MIN) return null
  if (arms.every(a => light(a.body)) && arms.some(a => loads(a.body))) return null
  const lo = arms[0].k, hi = arms[arms.length - 1].k
  if (hi - lo + 1 > arms.length * 2) return null
  const id = uid++, end = `$__gt${id}e`, labels = arms.map((_, i) => `$__gt${id}_${i}`)
  const at = new Map(arms.map((a, i) => [a.k, i]))
  const targets = []
  for (let v = lo; v <= hi; v++) targets.push(at.has(v) ? labels[at.get(v)] : end)
  const index = lo === 0 ? ['local.get', s] : ['i32.sub', ['local.get', s], ['i32.const', String(lo)]]
  let core = ['block', labels[0], ['br_table', ...targets, end, index]]
  for (let i = 0; i < arms.length; i++) core = ['block', i + 1 < arms.length ? labels[i + 1] : end, core, ...arms[i].body]
  return core
}

// The arms of the run in `list` from `i`: one word, each key its own, each arm
// named; the first may write the word.
const runAt = (list, i) => {
  const first = armOf(list[i])
  if (!first || !named(first.node)) return null
  const run = [first], keys = new Set([first.k])
  for (let j = i + 1; j < list.length; j++) {
    const a = armOf(list[j])
    if (!a || a.s !== first.s || a.tee || keys.has(a.k) || !named(a.node)) break
    run.push(a)
    keys.add(a.k)
  }
  return run.length >= CHAIN_MIN ? run : null
}

// What a run is written as, or null where no table takes it: the first test's
// write, then the tables a WIDTH of keys each and the arms none took, as they were.
const lowered = (run) => {
  const s = run[0].s, sorted = run.slice().sort((a, b) => a.k - b.k), kept = new Set(run), tables = []
  for (let k = 0; k < sorted.length; k += WIDTH) {
    const chunk = sorted.slice(k, k + WIDTH), tab = table(chunk, s)
    if (!tab) continue
    tables.push(tab)
    for (const a of chunk) kept.delete(a)
  }
  if (!tables.length) return null
  const out = [], t = run[0].tee
  if (t) { out.push(['local.set', s, t.c[t.at][2]]); t.c[t.at] = ['local.get', s] }
  for (const tab of tables) out.push(tab)
  for (const a of run) if (kept.has(a)) out.push(a.node)
  return out
}

/** Lower each run of guarded exits on one word with dense keys to a table, in every function. */
export function guardTables(module) {
  uid = 0
  pooled = new Map()
  for (const g of module) if (isArr(g) && g[0] === 'global' && typeof g[1] === 'string' && g[2] === 'i32' && g.length === 4) {
    const k = isArr(g[3]) && g[3][0] === 'i32.const' && g[3].length === 2 && Number.isInteger(+g[3][1]) ? +g[3][1] | 0 : null
    if (k != null) pooled.set(g[1], k)
  }
  for (const fn of module) {
    if (!isArr(fn) || fn[0] !== 'func') continue
    // the nodes, each before what it holds; then lowered in the other order, a
    // run inside an arm before the run it is in moves it
    const order = [], seen = new Set(), todo = [fn]
    while (todo.length) {
      const n = todo.pop()
      if (seen.has(n)) continue
      seen.add(n)
      order.push(n)
      for (let i = 1; i < n.length; i++) if (isArr(n[i])) todo.push(n[i])
    }
    for (let k = order.length - 1; k >= 0; k--) {
      const n = order[k]
      for (let i = 1; i < n.length; i++) {
        const run = runAt(n, i)
        if (!run) continue
        const out = lowered(run)
        if (!out) { i += run.length - 1; continue }
        n.splice(i, run.length, ...out)
        i += out.length - 1
      }
    }
  }
  return module
}
