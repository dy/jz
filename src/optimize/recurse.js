/**
 * Accumulator-fusion recursion unrolling — for a self-recursive function whose
 * single recursive call feeds an accumulator (`acc = acc + self(…)` — the
 * backtracking / tree-search / divide-and-conquer sum), inline one level of the
 * call and FUSE its accumulator into the caller's: the inlined loop adds straight
 * into `acc`, and the base case becomes a cheap `acc += const`. No call frame, no
 * result block, no second accumulator.
 *
 * Plain inlining alone wins nothing here — V8 already inlines hot wasm calls, and
 * a `(block (result T) … br)` costs what the call did. The measured speedup comes
 * from the fusion: `acc = acc + (Σ inner)` ⇒ `for each inner: acc += inner`
 * (associativity), which removes the per-level accumulator and its final add.
 *
 * WAT-IR layer, speed-tier only (-O3). Strictly gated: exactly one non-tail
 * self-call, consumed by `acc = acc ± self(…)` where `acc` is a local; a small
 * body; only soundly-cloneable constructs. Off at -O2/-Os.
 *
 * @module optimize/recurse
 */

const isArr = (x) => Array.isArray(x)   // wrapped: jz self-host rejects a builtin used as a value

const UNROLL_DEPTH = 2
const MAX_BODY_NODES = 110
const ADD_OPS = new Set(['i32.add', 'i64.add', 'f64.add', 'f32.add'])
// Replay per-frame zero-init for the callee's NON-accumulator locals (the acc is
// shared with the caller and must NOT be reset). dropDeadZeroInit removes the
// redundant ones (locals written before read) in a later pass. A function (not an
// object) keeps it on jz's self-host subset and returns a fresh node each call.
const ZERO = (t) => t === 'i32' ? ['i32.const', 0] : t === 'i64' ? ['i64.const', 0]
  : t === 'f64' ? ['f64.const', 0] : t === 'f32' ? ['f32.const', 0] : null

const deepClone = (n) => {
  if (!isArr(n)) return n
  const c = n.map(deepClone)
  if (n.type !== undefined) c.type = n.type
  return c
}

const nodeCount = (n) => {
  if (!isArr(n)) return 1
  let c = 1
  for (let i = 1; i < n.length; i++) c += nodeCount(n[i])
  return c
}

// Clone a body subtree with fusion rewrites:
//   • locals/labels renamed (except `acc`, which stays shared with the caller)
//   • `return acc`        → `br $skip`              (acc already holds the sum)
//   • `return V`          → `acc = acc + V; br $skip` (base case folds into acc)
function cloneFuse(node, c) {
  if (!isArr(node)) return node
  const op = node[0]
  let out
  if (op === 'return') {
    if (node.length === 1) { out = ['br', c.skip] }
    else if (isArr(node[1]) && node[1][0] === 'local.get' && node[1][1] === c.acc) { out = ['br', c.skip] }
    else {
      const v = cloneFuse(node[1], c)
      out = ['block', ['local.set', c.acc, [c.add, ['local.get', c.acc], v]], ['br', c.skip]]
    }
  } else if (op === 'local.get') {
    out = ['local.get', node[1] === c.acc ? c.acc : (c.names.get(node[1]) || node[1])]
  } else if (op === 'local.set' || op === 'local.tee') {
    out = [op, node[1] === c.acc ? c.acc : (c.names.get(node[1]) || node[1]), cloneFuse(node[2], c)]
  } else if ((op === 'block' || op === 'loop') && typeof node[1] === 'string' && node[1][0] === '$') {
    out = [op, c.labels.get(node[1]) || node[1]]
    for (let i = 2; i < node.length; i++) out.push(cloneFuse(node[i], c))
  } else if (op === 'br' || op === 'br_if') {
    out = [op, c.labels.get(node[1]) || node[1]]
    for (let i = 2; i < node.length; i++) out.push(cloneFuse(node[i], c))
  } else {
    out = [op]
    for (let i = 1; i < node.length; i++) out.push(cloneFuse(node[i], c))
  }
  if (node.type !== undefined) out.type = node.type
  return out
}

// Find `(local.set A (ADD (local.get A) (call $self …)))` (either operand order).
// That statement IS the recursive call's only consumer — the fusion site.
function findAccConsume(root, self) {
  if (!isArr(root)) return null
  for (let i = 1; i < root.length; i++) {
    const c = root[i]
    if (isArr(c) && c[0] === 'local.set' && typeof c[1] === 'string' && isArr(c[2]) && ADD_OPS.has(c[2][0])) {
      const A = c[1], add = c[2]
      const isAcc = (e) => isArr(e) && e[0] === 'local.get' && e[1] === A
      const isCall = (e) => isArr(e) && e[0] === 'call' && e[1] === self
      if (isAcc(add[1]) && isCall(add[2])) return { parent: root, idx: i, acc: A, add: add[0], call: add[2] }
      if (isAcc(add[2]) && isCall(add[1])) return { parent: root, idx: i, acc: A, add: add[0], call: add[1] }
    }
    const r = findAccConsume(c, self)
    if (r) return r
  }
  return null
}

const freshen = (orig, level, used) => {
  let name = `${orig}_ru${level}`
  while (used.has(name)) name += 'x'
  used.add(name)
  return name
}

/** Fuse-unroll a self-recursive accumulator function's recursive call. */
export function recursionUnroll(fn) {
  if (!isArr(fn) || fn[0] !== 'func') return

  const self = fn[1]
  const params = [], locals = [], names = new Set()
  let resultType = null, bodyStart = 2
  for (let i = 2; i < fn.length; i++) {
    const d = fn[i]
    if (!isArr(d)) { bodyStart = i; break }
    if (d[0] === 'param') { params.push([d[1], d[2]]); names.add(d[1]); bodyStart = i + 1 }
    else if (d[0] === 'local') { locals.push([d[1], d[2]]); names.add(d[1]); bodyStart = i + 1 }
    else if (d[0] === 'result') { resultType = d[1]; bodyStart = i + 1 }
    else if (d[0] === 'export' || d[0] === 'import' || d[0] === 'type') { bodyStart = i + 1 }
    else { bodyStart = i; break }
  }
  if (resultType == null) return

  // Gate: exactly one non-tail self-call, only soundly-cloneable constructs.
  let selfCalls = 0, bail = false
  const labelNames = new Set()
  const scan = (n) => {
    if (!isArr(n)) return
    const op = n[0]
    if (op === 'call' && n[1] === self) selfCalls++
    else if (op === 'return_call' || op === 'return_call_indirect' || op === 'return_call_ref') bail = true
    else if (op === 'br_table') bail = true
    else if ((op === 'br' || op === 'br_if') && typeof n[1] !== 'string') bail = true
    else if ((op === 'block' || op === 'loop') && typeof n[1] === 'string' && n[1][0] === '$') labelNames.add(n[1])
    for (let i = 1; i < n.length; i++) scan(n[i])
  }
  for (let i = bodyStart; i < fn.length; i++) scan(fn[i])
  if (bail || selfCalls !== 1) return

  // The recursive call must be consumed by `acc = acc ± self(…)`, acc a local.
  const consume = findAccConsume(fn, self)
  if (!consume) return
  const accName = consume.acc
  if (!locals.some(([n]) => n === accName)) return      // acc must be a local, not a param
  if (!ZERO(resultType)) return                          // need a typed add for the base-case fold
  // Non-accumulator locals must be re-zeroable (they get fresh per-level copies).
  for (const [ln, lt] of locals) if (ln !== accName && !ZERO(lt)) return

  const template = []
  for (let i = bodyStart; i < fn.length; i++) template.push(deepClone(fn[i]))
  let bodyNodes = 0
  for (const s of template) bodyNodes += nodeCount(s)
  if (bodyNodes > MAX_BODY_NODES) return

  let loc = consume
  const newDecls = []
  for (let level = 1; level <= UNROLL_DEPTH; level++) {
    const args = loc.call.slice(2)
    const nameMap = new Map(), labelMap = new Map()
    const skip = freshen('$__ru_skip', level, names)
    for (const [pn, pt] of params) { const f = freshen(pn, level, names); nameMap.set(pn, f); newDecls.push(['local', f, pt]) }
    for (const [ln, lt] of locals) {
      if (ln === accName) continue                       // accumulator is shared with the caller
      const f = freshen(ln, level, names); nameMap.set(ln, f); newDecls.push(['local', f, lt])
    }
    for (const lb of labelNames) labelMap.set(lb, freshen(lb, level, names))

    const c = { acc: accName, add: consume.add, skip, names: nameMap, labels: labelMap }
    const cloned = template.map(s => cloneFuse(s, c))
    const binds = params.map(([pn], k) => ['local.set', nameMap.get(pn), args[k]])
    const zeros = locals.filter(([ln]) => ln !== accName).map(([ln, lt]) => ['local.set', nameMap.get(ln), ZERO(lt)])
    // Void block: the inlined body accumulates straight into `accName`; `$skip`
    // is the early-out for the base case. Replaces the whole `acc = acc + call`.
    const block = ['block', skip, ...binds, ...zeros, ...cloned]

    loc.parent[loc.idx] = block
    const next = findAccConsume(block, self)             // inner fusion site, for the next level
    if (!next) break
    loc = next
  }
  fn.splice(bodyStart, 0, ...newDecls)
}
