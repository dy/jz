/**
 * A loop variable that jumps carries the address of the record it indexes
 * beside it (speed tier):
 *
 *   (loop $L
 *     (br_if $B (i32.ge_s (local.get $pc) (i32.const 8)))
 *     (local.set $op (i32.load (i32.add (i32.const 16) (i32.mul (local.get $pc) (i32.const 12)))))
 *     (local.set $b (i32.load offset=8 (i32.add (i32.const 16) (i32.mul (local.get $pc) (i32.const 12)))))
 *     (local.set $pc (block $j (result i32)
 *       … (br $j (i32.add (local.get $pc) (i32.const 1)))
 *       … (local.get $b)))
 *     (br $L))
 *
 * becomes
 *
 *   (local.set $p (i32.add (i32.mul (local.get $pc) (i32.const 12)) (i32.const 16)))
 *   (loop $L
 *     (br_if $B (i32.ge_s (local.get $pc) (i32.const 8)))
 *     (local.set $op (i32.load (local.get $p)))
 *     (local.set $b (i32.load offset=8 (local.get $p)))
 *     (local.set $pc (block $j (result i32)
 *       … (local.set $p (i32.add (local.get $p) (i32.const 12))) (br $j (i32.add (local.get $pc) (i32.const 1)))
 *       … (local.set $p (i32.add (i32.mul (local.get $b) (i32.const 12)) (i32.const 16))) (local.get $b)))
 *     (br $L))
 *
 * watr's strength reduction (`lsr`) gives an address affine in a counter a
 * pointer and leaves alone a variable any write of which is not a step: an
 * interpreter's instruction index steps to the next instruction and jumps to
 * a target it loads, a walk over linked records follows the link it reads.
 * Where such a variable addresses records at a stride an address cannot
 * scale by (three words: twelve bytes), every pass computes the record's
 * address again before its loads can issue, two instructions on x64 and
 * three on arm64. Here the pointer steps where the variable steps and is
 * computed again where it jumps, the one write a pass makes. A three-word
 * bytecode interpreter (vm) executes 106 x64 instructions a pass of its
 * five-instruction program loop where it executed 109, as clang's and
 * rustc's builds do (V8 13.6), and runs 0.97x its time on an Apple M4 (the
 * median of 40 paired rounds against the build without it).
 *
 * Exact. The pointer p is the address A(x) = k·x + Σ terms + c, every term
 * a local the loop never writes, in i32 arithmetic, so the relation holds
 * modulo 2^32: set before the loop and again at each write of x (advanced by
 * k·s for a value `x ± s`, A of the value otherwise; a write yielding values
 * from a block or an `if` sets p on each path to the value it yields), p
 * equals A(x) wherever the loop reads it. An address A(x) + d reads `p + d`.
 * A tee inside a replaced address goes where its value dies on the loop's
 * straight-line head, read only by replaced addresses; elsewhere the address
 * is evaluated and dropped, for the engine to remove.
 *
 * Declined: a write of x that is no statement of its own (a tee), one inside
 * a loop the loop holds, one yielding a value by a conditional branch; a body
 * some pass through which writes x twice; a variable that only steps (watr's
 * own) or only jumps (each jump forms the address anyway); an address an x64
 * index already scales (k of 1, 2, 4 or 8), or one formed nowhere on the
 * loop's straight-line head; a branch by depth.
 *
 * @module optimize/jump-pointers
 */

const isArr = Array.isArray
// (sets, not patterns: the compiler compiles itself, and its source keeps to plain string tests)
const BRANCH = new Set(['br', 'br_if', 'br_table'])
const LEAVE = new Set(['return', 'unreachable', 'throw', 'throw_ref', 'rethrow', 'return_call', 'return_call_indirect', 'return_call_ref'])
const HEADER = new Set(['export', 'import', 'type', 'param', 'result', 'local'])
const LISTS = new Set(['func', 'block', 'loop', 'then', 'else'])
const CONTROL = new Set(['block', 'loop', 'if', 'br', 'br_if', 'br_table', 'return', 'unreachable', 'throw', 'rethrow', 'try', 'try_table', 'return_call', 'return_call_indirect', 'return_call_ref'])
// a scale an x64 index forms in the address itself
const FOLDS = new Set([1, 2, 4, 8, -1, -2, -4, -8])

const constOf = (n) => isArr(n) && n[0] === 'i32.const' && n.length === 2 && Number.isInteger(Number(n[1])) ? Number(n[1]) | 0 : null
const label = (n) => typeof n[1] === 'string' && n[1][0] === '$' ? n[1] : null
const memOp = (op) => typeof op === 'string' && (op.includes('.load') || op.includes('.store')) && !op.includes('.atomic') && !op.startsWith('memory.')
const getOf = (n, x) => isArr(n) && n[0] === 'local.get' && n[1] === x && n.length === 2
const resultOf = (n) => n.some(c => isArr(c) && c[0] === 'result')

// Affine forms over i32: { c, t }, t a Map(local → coefficient), arithmetic modulo 2^32.
const form = (c, t = new Map()) => ({ c: c | 0, t })
const term = (key) => form(0, new Map([[key, 1]]))
const add = (a, b, s = 1) => {
  const t = new Map(a.t)
  for (const [key, k] of b.t) {
    const v = ((t.get(key) || 0) + Math.imul(s, k)) | 0
    if (v) t.set(key, v); else t.delete(key)
  }
  return form(a.c + Math.imul(s, b.c), t)
}
const scale = (a, s) => {
  const t = new Map()
  for (const [key, k] of a.t) { const v = Math.imul(k, s); if (v) t.set(key, v) }
  return form(Math.imul(a.c, s), t)
}
const same = (a, b) => {
  if (a.c !== b.c || a.t.size !== b.t.size) return false
  for (const [key, k] of a.t) if (b.t.get(key) !== k) return false
  return true
}
/** The terms of `a` as one key: the addresses one pointer serves agree on them, the constant aside. */
const groupKey = (a) => [...a.t].map(([key, k]) => key + '*' + k).sort().join('|')

/** The expression computing form `a`, its term `x` (when given) read as `xv`. */
const build = (a, x, xv) => {
  let acc = null
  for (const [key, k] of a.t) {
    const v0 = key === x && xv ? xv : ['local.get', key]
    const v = k === 1 ? v0 : ['i32.mul', v0, ['i32.const', k]]
    acc = acc ? ['i32.add', acc, v] : v
  }
  if (!acc) return ['i32.const', a.c]
  return a.c ? ['i32.add', acc, ['i32.const', a.c]] : acc
}

/** The step `s` of `x ± s` (s a constant), or null. */
const stepOf = (v, x) => {
  if (!isArr(v) || v.length !== 3) return null
  if (v[0] === 'i32.add') return getOf(v[1], x) ? constOf(v[2]) : getOf(v[2], x) ? constOf(v[1]) : null
  if (v[0] === 'i32.sub' && getOf(v[1], x)) { const s = constOf(v[2]); return s === null ? null : -s | 0 }
  return null
}

/**
 * The places value `V` of a write yields its value from: [list, index, node] with `node`
 * at `list[index]` either the value itself (the last of a block's or an arm's list) or a
 * `br` carrying it, the value its operand. A value is a block or `if` yielding values of
 * its own goes in whole. Null where a conditional branch yields one.
 */
const yieldsOf = (V, out = []) => {
  if (!isArr(V) || !resultOf(V) || (V[0] !== 'block' && V[0] !== 'if')) return null
  const lab = label(V)
  const arm = (list, from) => {
    if (list.length <= from) return false
    const i = list.length - 1, last = list[i]
    if (isArr(last) && (last[0] === 'block' || last[0] === 'if') && resultOf(last)) return yieldsOf(last, out) !== null
    out.push([list, i, last])
    return true
  }
  let ok = true
  const brs = (n, list) => {
    if (!isArr(n) || !ok) return
    if (BRANCH.has(n[0]) && lab && n.includes(lab)) {
      if (n[0] !== 'br' || n.length !== 3 || !list || list.indexOf(n) < 0) { ok = false; return }
      const Y = n[2]
      if (isArr(Y) && (Y[0] === 'block' || Y[0] === 'if') && resultOf(Y)) { if (!yieldsOf(Y, out)) ok = false }
      else out.push([list, list.indexOf(n), n])
      return
    }
    for (let i = 1; i < n.length; i++) brs(n[i], LISTS.has(n[0]) ? n : null)
  }
  if (V[0] === 'block') {
    let from = 1
    while (from < V.length && !(isArr(V[from]) && V[from][0] !== 'result' && V[from][0] !== 'type' && V[from][0] !== 'param')) from++
    for (let i = from; i < V.length; i++) brs(V[i], V)
    if (!ok || !arm(V, from)) return null
  } else {
    for (const c of V) if (isArr(c) && (c[0] === 'then' || c[0] === 'else')) {
      for (let i = 1; i < c.length; i++) brs(c[i], c)
      if (!ok || !arm(c, 1)) return null
    }
  }
  return ok ? out : null
}

/** The value a yield place carries: the operand of its `br`, or itself. */
const valueOf = ([, , y]) => isArr(y) && y[0] === 'br' ? y[2] : y

/** Rewrite the loops of function `fn`. */
const rewriteFunc = (fn) => {
  const names = new Set(), types = new Map()
  let byDepth = false
  const census = (n) => {
    if (!isArr(n)) return
    if (BRANCH.has(n[0]) && n.slice(1).some(c => typeof c === 'number' || typeof c === 'string' && c[0] >= '0' && c[0] <= '9')) byDepth = true
    for (let i = 1; i < n.length; i++) {
      const c = n[i]
      if (typeof c === 'string' && c[0] === '$') names.add(c)
      else census(c)
    }
  }
  census(fn)
  if (byDepth) return
  for (const c of fn) if (isArr(c) && (c[0] === 'local' || c[0] === 'param') && c.length === 3 && typeof c[1] === 'string') types.set(c[1], c[2])
  let uid = 0
  const fresh = () => {
    let s = `$__jp${uid++}`
    while (names.has(s)) s = `$__jp${uid++}`
    names.add(s)
    let at = 2
    while (at < fn.length && (typeof fn[at] === 'string' || isArr(fn[at]) && HEADER.has(fn[at][0]))) at++
    fn.splice(at, 0, ['local', s, 'i32'])
    types.set(s, 'i32')
    return s
  }

  // the locals written in `n`; `nested` gathers those written inside a loop within it
  const writes = (n, out, nested, deep) => {
    if (!isArr(n)) return
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') { out.add(n[1]); if (deep) nested.add(n[1]) }
    for (let i = 1; i < n.length; i++) if (isArr(n[i])) writes(n[i], out, nested, deep || n[i][0] === 'loop')
  }
  // the most writes of x one pass through `n` makes, Infinity where a write is no statement of a list
  const most = (n, x, list) => {
    if (!isArr(n)) return 0
    const op = n[0]
    if ((op === 'local.set' || op === 'local.tee') && n[1] === x && (op === 'local.tee' || !list)) return Infinity
    const inList = LISTS.has(op)
    if (op === 'if') {
      let cond = 0, arms = 0
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        if (isArr(c) && (c[0] === 'then' || c[0] === 'else')) arms = Math.max(arms, most(c, x, true))
        else cond += most(c, x, false)
      }
      return cond + arms
    }
    let sum = op === 'local.set' && n[1] === x ? 1 : 0
    for (let i = 1; i < n.length; i++) sum += most(n[i], x, inList)
    return sum
  }

  // innermost first; `up` holds the nodes enclosing the one visited, outermost first
  const visit = (n, up) => {
    const inner = [...up, n]
    for (const c of n.slice(1)) if (isArr(c)) visit(c, inner)
    if (n[0] === 'loop' && up.length && LISTS.has(up[up.length - 1][0])) loop(n, up[up.length - 1])
  }
  const loop = (L, parent) => {
    if (!label(L)) return
    const written = new Set(), nested = new Set()
    for (let i = 2; i < L.length; i++) if (isArr(L[i])) writes(L[i], written, nested, L[i][0] === 'loop')
    for (const x of written) {
      if (types.get(x) !== 'i32' || nested.has(x)) continue
      const plan = planFor(L, x, written)
      if (plan) { apply(L, parent, x, plan); return }
    }
  }

  // The addresses of loop L one pointer beside x serves and the writes it follows, or null.
  const planFor = (L, x, written) => {
    let per = 0
    for (let i = 2; i < L.length; i++) per += most(L[i], x, true)
    if (per !== 1) return null
    const stores = []
    const collect = (n) => { if (!isArr(n)) return; if (n[0] === 'local.set' && n[1] === x) stores.push(n); for (let i = 1; i < n.length; i++) collect(n[i]) }
    collect(L)
    const plans = []
    for (const w of stores) {
      if (stepOf(w[2], x) !== null) { plans.push({ w, step: true }); continue }
      const ys = yieldsOf(w[2])
      if (ys) plans.push({ w, ys })
      else if (isArr(w[2]) && (w[2][0] === 'block' || w[2][0] === 'if') && resultOf(w[2])) return null
      else plans.push({ w })
    }

    // a forward walk: each i32 local the loop writes holds a form while its value is known
    const sites = []
    const frames = [{ label: label(L), loop: true }]
    const target = (l) => { for (let i = frames.length - 1; i >= 0; i--) if (frames[i].label === l) return frames[i]; return null }
    const join = (envs) => {
      const live = envs.filter(e => !e.dead)
      if (!live.length) return { m: new Map(), dead: true }
      const m = new Map()
      for (const [y, a] of live[0].m) if (live.every(e => e.m.has(y) && same(e.m.get(y), a))) m.set(y, a)
      return { m, dead: false }
    }
    const copy = (env) => ({ m: new Map(env.m), dead: env.dead })
    const assign = (env, y, v) => {
      if (y === x) { for (const [z, a] of env.m) if (a.t.has(x)) env.m.delete(z) }
      else if (v && types.get(y) === 'i32') env.m.set(y, v)
      else env.m.delete(y)
    }
    let depth = 0, stmt = -1   // the constructs around the node walked (0: the loop's own list), the statement of that list
    const ev = (n, env) => {
      if (!isArr(n) || env.dead) return null
      const op = n[0]
      if (op === 'i32.const') { const c = constOf(n); return c === null ? null : form(c) }
      if (op === 'local.get') {
        const y = n[1]
        if (y === x) return term(x)
        if (!written.has(y) && types.get(y) === 'i32') return term(y)
        return env.m.get(y) || null
      }
      if (op === 'local.set' || op === 'local.tee') {
        const v = ev(n[2], env)
        if (env.dead) return null
        assign(env, n[1], v)
        return op === 'local.tee' ? (n[1] === x ? term(x) : v) : null
      }
      if (op === 'if') {
        let then = null, els = null
        for (let i = 1; i < n.length; i++) {
          const c = n[i]
          if (!isArr(c)) continue
          if (c[0] === 'then') then = c
          else if (c[0] === 'else') els = c
          else if (c[0] !== 'result' && c[0] !== 'param' && c[0] !== 'type') ev(c, env)
        }
        if (env.dead) return null
        const f = { label: label(n), snaps: [] }
        frames.push(f); depth++
        const arms = [then, els].map(arm => { const e = copy(env); if (arm) list(arm, 1, e); return e })
        frames.pop(); depth--
        const out = join([...arms, ...f.snaps])
        env.m = out.m; env.dead = out.dead
        return null
      }
      if (op === 'block' || op === 'loop') {
        const inner = new Set()
        if (op === 'loop') { writes(n, inner, inner, false); for (const y of inner) env.m.delete(y) }
        const f = { label: label(n), snaps: [], loop: op === 'loop' }
        frames.push(f); depth++
        list(n, 1, env)
        frames.pop(); depth--
        if (op === 'loop') for (const y of inner) env.m.delete(y)
        else { const out = join([env, ...f.snaps]); env.m = out.m; env.dead = out.dead }
        return null
      }
      if (BRANCH.has(op)) {
        const labels = []
        for (let i = 1; i < n.length; i++) { if (isArr(n[i])) ev(n[i], env); else labels.push(n[i]) }
        if (env.dead) return null
        for (const l of labels) { const f = target(l); if (f && !f.loop) f.snaps.push(copy(env)) }
        if (op !== 'br_if') env.dead = true
        return null
      }
      if (memOp(op)) {
        let first = true
        for (let i = 1; i < n.length; i++) {
          if (!isArr(n[i])) continue
          const v = ev(n[i], env)
          if (env.dead) return null
          if (first && v && v.t.has(x) && !FOLDS.has(v.t.get(x))) sites.push({ at: n, ai: i, v, head: depth === 0, stmt })
          first = false
        }
        return null
      }
      const vals = []
      for (let i = 1; i < n.length; i++) if (isArr(n[i])) { vals.push(ev(n[i], env)); if (env.dead) return null }
      if (LEAVE.has(op)) { env.dead = true; return null }
      if (vals.length === 2 && vals[0] && vals[1]) {
        const [a, b] = vals
        if (op === 'i32.add') return add(a, b)
        if (op === 'i32.sub') return add(a, b, -1)
        if (op === 'i32.mul' && !b.t.size) return scale(a, b.c)
        if (op === 'i32.mul' && !a.t.size) return scale(b, a.c)
        if (op === 'i32.shl' && !b.t.size) return scale(a, 2 ** (b.c & 31) | 0)
      }
      return null
    }
    const list = (n, from, env) => {
      for (let i = from; i < n.length && !env.dead; i++) {
        if (!isArr(n[i]) || n[i][0] === 'result' || n[i][0] === 'type' || n[i][0] === 'param') continue
        if (n === L) stmt = i
        ev(n[i], env)
      }
    }
    list(L, 2, { m: new Map(), dead: false })

    // one pointer: the group of addresses with the most sites, one of them on the head
    const groups = new Map()
    for (const s of sites) {
      const key = groupKey(s.v)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(s)
    }
    let best = null
    for (const g of groups.values()) if (g.some(s => s.head) && (!best || g.length > best.length)) best = g
    // the values x takes: a variable that only steps is strength reduction's, one that only
    // jumps forms the address again at each jump
    let steps = 0, jumps = 0
    for (const p of plans) for (const v of p.ys ? p.ys.map(valueOf) : [p.w[2]]) { if (stepOf(v, x) !== null) steps++; else jumps++ }
    if (!best || !steps || !jumps) return null
    return { sites: best, plans }
  }

  const apply = (L, parent, x, { sites, plans }) => {
    const p = fresh()
    // the pointer holds the most frequent constant: the other sites add their difference
    const freq = new Map()
    for (const s of sites) freq.set(s.v.c, (freq.get(s.v.c) || 0) + 1)
    let c0 = sites[0].v.c
    for (const [c, n] of freq) if (n > freq.get(c0)) c0 = c
    const base = form(c0, sites[0].v.t), k = base.t.get(x)
    const rest = form(c0, new Map([...base.t].filter(([key]) => key !== x)))
    // A of x, of the value xv, or of the constant c
    const at = (xv) => build(base, x, xv)
    const atConst = (c) => build(add(rest, form(Math.imul(k, c))))

    // the addresses: a tee holding one keeps its local, the pointer its value
    const replaced = new Set()
    for (const s of sites) {
      let node = s.at, i = s.ai
      while (isArr(node[i]) && node[i][0] === 'local.tee' && node[i].length === 3) { node = node[i]; i = 2 }
      const d = (s.v.c - c0) | 0
      s.node = node; s.i = i; s.ptr = d ? ['i32.add', ['local.get', p], ['i32.const', d]] : ['local.get', p]
      replaced.add(node[i])
    }
    // a local a replaced address tees: its value dies where the head writes it again,
    // read before that by replaced addresses alone (the subtrees of `replaced`)
    const reads = (n, y, skip) => {
      if (!isArr(n) || skip.has(n)) return 0
      let r = n[0] === 'local.get' && n[1] === y ? 1 : 0
      for (let i = 1; i < n.length; i++) r += reads(n[i], y, skip)
      return r
    }
    const control = (n, skip) => {
      if (!isArr(n) || skip.has(n)) return false
      if (CONTROL.has(n[0])) return true
      for (let i = 1; i < n.length; i++) if (control(n[i], skip)) return true
      return false
    }
    const dies = (s, y) => {
      if (!s.head) return false
      for (let j = s.stmt; j < L.length; j++) {
        const t = L[j]
        if (j > s.stmt && isArr(t) && t[0] === 'local.set' && t[1] === y) return !reads(t[2], y, replaced) && !control(t[2], replaced)
        if (reads(t, y, replaced) || control(t, replaced)) return false
      }
      return false
    }
    // a tee holding a replaced address whose value dies on the head goes with it
    for (const s of sites) s.dies = s.node[0] === 'local.tee' && dies(s, s.node[1])
    for (const s of sites) {
      const old = s.node[s.i], tees = new Set()
      const scan = (n) => {
        if (!isArr(n)) return
        if (n[0] === 'local.tee' || n[0] === 'local.set') tees.add(n[1])
        if (n[0] === 'call' || n[0] === 'call_indirect' || n[0] === 'call_ref') tees.add('')
        for (let i = 1; i < n.length; i++) scan(n[i])
      }
      scan(old)
      const gone = [...tees].every(y => y && dies(s, y))
      s.node[s.i] = gone ? s.ptr : ['block', ['result', 'i32'], ['drop', old], s.ptr]
    }

    // the pointer follows each write of x: before the value a path yields, or after the write
    for (const { w, step, ys } of plans) {
      const holder = (n) => { if (!isArr(n)) return null; for (let i = 1; i < n.length; i++) { if (n[i] === w) return n; const r = holder(n[i]); if (r) return r } return null }
      if (ys) {
        // last first: an insertion shifts the places after it in its list
        for (let j = ys.length - 1; j >= 0; j--) {
          const [lst, idx, y] = ys[j], isBr = isArr(y) && y[0] === 'br', Y = valueOf(ys[j])
          const s = stepOf(Y, x), c = constOf(Y)
          let upd
          if (s !== null) upd = ['i32.add', ['local.get', p], ['i32.const', Math.imul(k, s)]]
          else if (c !== null) upd = atConst(c)
          else if (isArr(Y) && Y[0] === 'local.get') upd = at(['local.get', Y[1]])
          else {
            // the value first, then the pointer of it
            const t = fresh()
            if (isBr) y[2] = ['local.get', t]; else lst[idx] = ['local.get', t]
            lst.splice(idx, 0, ['local.set', t, Y], ['local.set', p, at(['local.get', t])])
            continue
          }
          lst.splice(idx, 0, ['local.set', p, upd])
        }
        continue
      }
      const h = holder(L), i = h.indexOf(w), s = stepOf(w[2], x), c = constOf(w[2])
      h.splice(i + 1, 0, ['local.set', p, s !== null ? ['i32.add', ['local.get', p], ['i32.const', Math.imul(k, s)]] : c !== null ? atConst(c) : at(null)])
    }
    parent.splice(parent.indexOf(L), 0, ['local.set', p, at(null)])

    // a local only replaced addresses read keeps none of its tees
    const left = new Map()
    const count = (n) => { if (!isArr(n)) return; if (n[0] === 'local.get') left.set(n[1], (left.get(n[1]) || 0) + 1); for (let i = 1; i < n.length; i++) count(n[i]) }
    count(fn)
    for (const s of sites) if (s.node[0] === 'local.tee' && (s.dies || !left.get(s.node[1]))) {
      const strip = (n) => {
        if (!isArr(n)) return
        for (let i = 1; i < n.length; i++) {
          strip(n[i])
          if (n[i] === s.node) n[i] = s.node[2]
        }
      }
      strip(fn)
    }
  }

  visit(fn, [])
}

/** Give each loop of `ast` (a module) whose variable jumps and indexes records a pointer to its record. */
export function jumpPointers(ast) {
  if (!isArr(ast)) return ast
  for (const fn of ast) if (isArr(fn) && fn[0] === 'func') rewriteFunc(fn)
  return ast
}
