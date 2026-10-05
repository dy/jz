// A Number's canonical-NaN step whose value only arithmetic reads is dead.
//
//   (block (result f64) (local.set $t V) (select (f64.const nan) (local.get $t) (f64.ne (local.get $t) (local.get $t))))
//
// The emitter folds any NaN a negation, a root or a sum produces back to the one
// NaN bit pattern (ir/sentinels.js canonicalNumberIR, emit/arithmetic.js): a
// sign-flipped NaN lies in the NaN-boxed value space, where `===` and `typeof`
// would read it as a tagged value. An f64 arithmetic operator propagates every
// NaN alike, and its own result is canonicalized where it escapes; a comparison
// answers the same for every NaN; a saturating truncation yields zero for every
// NaN. So a canon whose value only such operators consume guards nothing. The
// emitter strips the ones it can link at the consumer (emit/arithmetic.js
// stripCanon); a value through a local loses the link: a gradient's sign-select
// (`const u = h & 1 ? x : -x; … u + v`), a sum's accumulator the next sum reads.
// This pass finds the rest. A value flows up through the arms of a conditional,
// a block's result, a unary operator and a reinterpretation to its consumer, or
// into a local, every read of which must flow so too, through locals alike (a
// cycle, an accumulator's, holds). Then the canon is its value.
import { walkAst } from '../ast.js'

const isArr = Array.isArray
// NaN-propagating consumers whose result is canonical where it escapes, or no Number
const PROPAGATES = new Set(['f64.add', 'f64.sub', 'f64.mul', 'f64.div', 'f64.min', 'f64.max',
  'f64.eq', 'f64.ne', 'f64.lt', 'f64.gt', 'f64.le', 'f64.ge', 'i64.trunc_sat_f64_s', 'i64.trunc_sat_f64_u', 'i32.trunc_sat_f64_s', 'i32.trunc_sat_f64_u'])
// (a unary operator passes a NaN on to its consumer, a reinterpretation the bits: that consumer decides)
const THROUGH = new Set(['f64.neg', 'f64.abs', 'f64.sqrt', 'f64.floor', 'f64.ceil', 'f64.trunc', 'f64.nearest', 'i64.reinterpret_f64', 'f64.reinterpret_i64'])

/** The value a canon normalizes, or null: the block form, and the tee form a propagation leaves. */
const canonValue = (n) => {
  if (!isArr(n)) return null
  if (n[0] === 'block' && n.length === 4 && n[1]?.[0] === 'result' && n[1][1] === 'f64' && n[2]?.[0] === 'local.set' && typeof n[2][1] === 'string' && isCanonSelect(n[3], n[2][1])) return n[2][2]
  if (n[0] === 'select' && isCanonSelect(n, null)) return n[2][2]
  return null
}
const isNaN_ = (n) => isArr(n) && n[0] === 'f64.const' && (n[1] === 'nan' || Number.isNaN(n[1]))
const isGet = (n, t) => isArr(n) && n[0] === 'local.get' && n[1] === t
const isCanonSelect = (s, t) => {
  if (!isArr(s) || s[0] !== 'select' || s.length !== 4 || !isNaN_(s[1])) return false
  const v = s[2]
  if (t == null) { if (!isArr(v) || v[0] !== 'local.tee' || typeof v[1] !== 'string') return false; t = v[1] }
  else if (!isGet(v, t)) return false
  const ne = s[3]
  return isArr(ne) && ne[0] === 'f64.ne' && isGet(ne[1], t) && isGet(ne[2], t)
}

/** Where the value of `chain[i]` goes: 'ok' (a propagating consumer, or dropped), a local's name, or 'escape'. */
const sinkOf = (chain, i) => {
  for (let k = i; k > 0; k--) {
    const node = chain[k].node, idx = chain[k].idx, parent = chain[k - 1].node, op = parent[0]
    if (PROPAGATES.has(op)) return 'ok'
    if (op === 'drop') return 'ok'
    if (op === 'local.set' || op === 'local.tee') return typeof parent[1] === 'string' ? parent[1] : 'escape'
    if (THROUGH.has(op)) continue
    if (op === 'select' && (idx === 1 || idx === 2)) continue
    if ((op === 'then' || op === 'else') && idx === parent.length - 1) continue
    if (op === 'if' && node[0] !== 'then' && node[0] !== 'else') return 'escape'   // the condition
    if (op === 'if') continue
    if (op === 'block' && idx === parent.length - 1 && isArr(parent[1]) && parent[1][0] === 'result') continue
    return 'escape'
  }
  return 'escape'
}

export function stripDeadCanons(fn) {
  if (!isArr(fn) || fn[0] !== 'func') return false
  const reads = new Map()     // local → the sinks of its reads
  const canons = new Map()    // canon node → the sinks of its positions (a node two parents share has two)
  const chain = []
  const visit = (node, parent, idx) => {
    if (!isArr(node)) return
    chain.push({ node, idx })
    const op = node[0]
    if ((op === 'local.get' || op === 'local.tee') && typeof node[1] === 'string') {
      const s = sinkOf(chain, chain.length - 1)
      const l = reads.get(node[1]); if (l) l.push(s); else reads.set(node[1], [s])
    }
    if (canonValue(node) != null && parent) { const s = sinkOf(chain, chain.length - 1); const l = canons.get(node); if (l) l.push(s); else canons.set(node, [s]) }
    for (let i = 1; i < node.length; i++) visit(node[i], node, i)
    chain.pop()
  }
  for (let i = 1; i < fn.length; i++) visit(fn[i], fn, i)
  if (!canons.size) return false
  // (a local every read of which flows to a propagating consumer, or to such a local)
  const bad = new Set()
  let grew = true
  while (grew) {
    grew = false
    for (const [name, sinks] of reads) {
      if (bad.has(name)) continue
      if (sinks.some(s => s === 'escape' || (s !== 'ok' && bad.has(s)))) { bad.add(name); grew = true }
    }
  }
  const dead = (s) => s === 'ok' || (s !== 'escape' && !bad.has(s))
  // (bottom up, in the tree as it stands: a canon in the value of another is
  // replaced there first, and one two parents share is replaced under each)
  let changed = false
  const replace = (n) => {
    if (!isArr(n)) return n
    for (let i = 1; i < n.length; i++) n[i] = replace(n[i])
    const sinks = canons.get(n)
    if (sinks == null || !sinks.every(dead)) return n
    changed = true
    return canonValue(n)
  }
  for (let i = 1; i < fn.length; i++) fn[i] = replace(fn[i])
  if (!changed) return false
  // The emitter's sum lands in a temp the canon reads into its accumulator
  // (`num = acc + p; acc = canon(num)`): with the canon gone the temp is a copy,
  // read once, which the lifts would not see through. The value lands directly.
  const once = (t) => (reads.get(t)?.length ?? 0) === 1
  const fold = (list, from) => {
    for (let i = from; i + 1 < list.length; i++) {
      const a = list[i], b = list[i + 1]
      if (isArr(a) && a[0] === 'local.set' && isArr(b) && b[0] === 'local.set' && isGet(b[2], a[1]) && once(a[1])) { list.splice(i, 2, ['local.set', b[1], a[2]]); i-- }
    }
  }
  walkAst(fn, { enter: (n) => {
    if (n[0] === 'func') fold(n, 1)
    else if (n[0] === 'loop' || n[0] === 'block') fold(n, 1)
    else if (n[0] === 'then' || n[0] === 'else') fold(n, 1)
  } })
  return true
}
