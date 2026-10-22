/**
 * An element load in a guarded arm takes the word a store or a load under that guard left.
 *
 *   grid[nb] += topples          // (if C (then (i32.store A w)))
 *   if (grid[nb] >= 4) push(nb)  // (if (result f64) C (then (f64.convert_i32_s (i32.load A))) (else nan))
 *
 * A load of A in the arm a guard opens runs only where the guard holds; if C is the guard
 * (or a conjunct of it), C on the same values ran the store before it, nothing between
 * writing memory: the element holds `w`, which the load takes from a local the store
 * tees once a load takes it. Where C fails the arm does not run (the read's other arm is
 * `undefined`). A load of A directly in C's arm (under the whole of C) leaves its word the
 * same way, for later loads under C (`grid[c] >= 4`, then `grid[c] >> 2`, then
 * `grid[c] -= …`), until a write, a loop, the end of a block a branch leaves to (which may
 * skip the load), or the end of an arm the store or the load's `if` sits in: past it the
 * arm may not have run.
 *
 * "The same" is by value: every pure expression is numbered as it is evaluated, a local
 * holding one carries its number, and a load's or a global read's number names the memory
 * it read (a store, a global write, or a call to a function that may write either starts
 * new memory). The store is a 4-byte element's under its array's bound check
 * (`i < header >> 2`): it writes inside the array's elements, so the header the later
 * check loads is the one the store's loaded.
 *
 * Then a comparison of a checked signed integer element read with an integral constant
 * compares words: `(f64.ge (if (result f64) c (then (f64.convert_i32_s x)) (else nan)) 4)`
 * is `(if (result i32) c (then (i32.ge_s x 4)) (else 0))`, a missing element (NaN)
 * failing every ordered comparison and passing `ne`.
 *
 * Post-watr, on the if-form watr leaves a checked read and store in, before the float
 * literals are pooled.
 *
 * @module optimize/forward-checked
 */

const isArr = Array.isArray
// what changes a value a load or a global read named
const memWrite = (op) => typeof op === 'string' && (/^(i32|i64|f32|f64|v128)\.(store|atomic)/.test(op) || op.startsWith('memory.') || op.startsWith('table.') || op === 'global.set')
// a call that never returns to the code after it (the runtime's throws) ends nothing
const noReturn = (callee) => typeof callee === 'string' && callee.startsWith('$__throw_')
const INDIRECT = new Set(['call_indirect', 'call_ref', 'return_call_indirect', 'return_call_ref'])
// The functions a call to which may change memory or a global: an import, one that writes
// either or calls indirectly, one that calls such a function or one the module lacks.
// A call to any other (`__to_int32`, the math runtime) leaves both as they were.
const writers = (module) => {
  const funcs = new Map(), may = new Set()
  for (const n of module) {
    if (!isArr(n)) continue
    if (n[0] === 'func' && typeof n[1] === 'string') (n.some(x => isArr(x) && x[0] === 'import') ? may.add(n[1]) : funcs.set(n[1], n))
    else if (n[0] === 'import' && isArr(n[3]) && n[3][0] === 'func' && typeof n[3][1] === 'string') may.add(n[3][1])
  }
  const callees = new Map()
  for (const [name, f] of funcs) {
    const out = new Set()
    const walk = (x) => {
      if (!isArr(x)) return
      if (memWrite(x[0]) || INDIRECT.has(x[0])) may.add(name)
      else if ((x[0] === 'call' || x[0] === 'return_call') && typeof x[1] === 'string') out.add(x[1])
      for (let i = 1; i < x.length; i++) walk(x[i])
    }
    walk(f)
    callees.set(name, out)
  }
  for (let grew = true; grew;) {
    grew = false
    for (const [name, out] of callees) if (!may.has(name) && [...out].some(c => may.has(c) || !funcs.has(c))) { may.add(name); grew = true }
  }
  return may
}
const STORE_LOAD = { 'i32.store': 'i32.load', 'i64.store': 'i64.load', 'f32.store': 'f32.load', 'f64.store': 'f64.load' }
const LOAD = /^(i32|i64|f32|f64|v128)\.load/
const UNKEYED = new Set(['call', 'call_indirect', 'call_ref', 'block', 'loop', 'if', 'br', 'br_if', 'br_table', 'return', 'unreachable',
  'local.set', 'global.set', 'memory.grow', 'memory.size', 'throw', 'try_table', 'drop', 'nop'])
const CMP = { 'f64.lt': 'i32.lt_s', 'f64.le': 'i32.le_s', 'f64.gt': 'i32.gt_s', 'f64.ge': 'i32.ge_s', 'f64.eq': 'i32.eq', 'f64.ne': 'i32.ne' }
const SWAP = { 'i32.lt_s': 'i32.gt_s', 'i32.le_s': 'i32.ge_s', 'i32.gt_s': 'i32.lt_s', 'i32.ge_s': 'i32.le_s' }
const isNaNConst = (n) => isArr(n) && n[0] === 'f64.const' && (typeof n[1] === 'string' ? /^[-+]?nan/.test(n[1]) : Number.isNaN(n[1]))
const intConst = (n) => {
  if (!isArr(n) || n[0] !== 'f64.const') return null
  const v = typeof n[1] === 'number' ? n[1] : Number(n[1])
  return Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 && !Object.is(v, -0) ? v : null
}
// a node's memarg strings (offset=, align=) and its operands
const isLabel = (x) => typeof x === 'string' && x[0] === '$'
// whether a branch inside `n` names `label`
const targets = (n, label) => {
  if (!isArr(n)) return false
  if ((n[0] === 'br' || n[0] === 'br_if') && n[1] === label) return true
  if (n[0] === 'br_table' && n.includes(label)) return true
  for (let i = 1; i < n.length; i++) if (targets(n[i], label)) return true
  return false
}
// `(i32.add BASE (i32.shl IDX (i32.const 2)))`: a 4-byte element's address (a header's is BASE − 8)
const elementAddr = (a) => isArr(a) && a[0] === 'i32.add' && a.length === 3 && isArr(a[2]) && a[2][0] === 'i32.shl' && a[2].length === 3 &&
  isArr(a[2][2]) && a[2][2][0] === 'i32.const' && Number(a[2][2][1]) === 2
const split = (n) => { let i = 1; while (typeof n[i] === 'string') i++; return [n.slice(1, i), n.slice(i)] }

/** A comparison of a checked signed integer element read with an integral constant, in words;
 *  a read a block yields after its statements (a receiver's guard) compares inside the block. */
function foldCompare(n) {
  const w = CMP[n[0]]
  if (!w || n.length !== 3) return null
  let read = n[1], k = intConst(n[2]), swap = false
  if (k == null) { read = n[2]; k = intConst(n[1]); swap = true }
  if (k == null) return null
  const op = swap ? (SWAP[w] ?? w) : w
  const fold = (r) => {
    if (isArr(r) && r[0] === 'block' && r.length >= 3 && isArr(r[1]) && r[1][0] === 'result' && r[1][1] === 'f64') {
      const last = fold(r[r.length - 1])
      return last && ['block', ['result', 'i32'], ...r.slice(2, -1), last]
    }
    if (!isArr(r) || r[0] !== 'if' || r.length !== 5 || !isArr(r[1]) || r[1][0] !== 'result' || r[1][1] !== 'f64') return null
    const then = r[3], els = r[4]
    if (!isArr(then) || then[0] !== 'then' || then.length !== 2 || !isArr(els) || els[0] !== 'else' || els.length !== 2 || !isNaNConst(els[1])) return null
    const conv = then[1]
    if (!isArr(conv) || conv[0] !== 'f64.convert_i32_s' || conv.length !== 2) return null
    return ['if', ['result', 'i32'], r[2], ['then', [op, conv[1], ['i32.const', k]]], ['else', ['i32.const', n[0] === 'f64.ne' ? 1 : 0]]]
  }
  return fold(read)
}

export function forwardCheckedElements(module) {
  const may = writers(module)
  // a call that may write starts new memory; one that never returns ends nothing
  const callsOut = (n) => ((n[0] === 'call' || n[0] === 'return_call') && !noReturn(n[1]) && may.has(n[1])) || INDIRECT.has(n[0])
  for (const fn of module) if (isArr(fn) && fn[0] === 'func') forwardIn(fn, callsOut)
  return module
}

function forwardIn(fn, callsOut) {
  let bodyStart = typeof fn[1] === 'string' ? 2 : 1
  while (bodyStart < fn.length && isArr(fn[bodyStart]) && ['export', 'import', 'param', 'result', 'local', 'type'].includes(fn[bodyStart][0])) bodyStart++
  const names = new Map(), decls = []
  for (let i = 1; i < bodyStart; i++) if (isArr(fn[i]) && (fn[i][0] === 'local' || fn[i][0] === 'param') && typeof fn[i][1] === 'string') names.set(fn[i][1], fn[i][2])
  let fresh = 0
  const freshLocal = (type) => { let n; do { n = `$__fw${fresh++}` } while (names.has(n)); names.set(n, type); decls.push(['local', n, type]); return n }

  let version = 0, epoch = 0, depth = 0
  const held = []             // the enclosing then arms: { keys: their guard's numbers and its conjuncts', depth, c: the whole guard's }
  const loads = new Map()     // `cond|addr` → { c, a, load, w, arm }: a load at the top of guard c's arm, its word for later loads under c
  const key = new Map()       // local → the number of the value it holds
  const known = new Map()     // `cond|addr` → { c, a, st, w }: a store whose word a load may take
  // The one address a write left as it was: the header of the array a bound-checked store
  // wrote inside (that store's own base, by number), read since at the epoch before it.
  let kept = null, keptEpoch = 0
  // a value's number: each distinct shape of operation and operand numbers gets one
  const numbers = new Map()
  const num = (shape) => { let v = numbers.get(shape); if (v == null) { v = `#${numbers.size}`; numbers.set(shape, v) } return v }
  // a node's number as it was evaluated: a local the expression sets again later names the
  // value it held there (`(i32.and (local.tee $v (f64.eq …)) (… (local.tee $v (i32.sub …))))`)
  const vn = new WeakMap()
  const keyOf = (e) => {
    if (!isArr(e)) return typeof e === 'string' || typeof e === 'number' ? num(String(e)) : null
    if (vn.has(e)) return vn.get(e)
    const op = e[0]
    if (op === 'local.get' || op === 'local.tee') return key.get(e[1]) ?? num(`${e[1]}@0`)
    // the value an if picks, every part of it pure (a truncation's two arms)
    if (op === 'if' && e.length === 5 && isArr(e[1]) && e[1][0] === 'result' && isArr(e[3]) && e[3][0] === 'then' && e[3].length === 2 && isArr(e[4]) && e[4][0] === 'else' && e[4].length === 2) {
      const c = keyOf(e[2]), a = keyOf(e[3][1]), b = keyOf(e[4][1])
      return c != null && a != null && b != null ? num(`if ${c} ${a} ${b}`) : null
    }
    if (typeof op !== 'string' || UNKEYED.has(op) || memWrite(op)) return null
    if (op.endsWith('.const')) return num(`${op} ${e[1]}`)
    const parts = []
    for (let i = 1; i < e.length; i++) { const k = keyOf(e[i]); if (k == null) return null; parts.push(k) }
    if (!LOAD.test(op) && op !== 'global.get') return num(`${op} ${parts.join(' ')}`)
    return num(`${op}@${parts[parts.length - 1] === kept ? keptEpoch : epoch} ${parts.join(' ')}`)
  }
  const set = (name, value) => { key.set(name, keyOf(value) ?? num(`${name}@${++version}`)) }
  const wrote = () => { epoch++; known.clear(); loads.clear(); kept = null }
  // a later load under C takes the word a store or a load under C left
  const take = (e) => {
    if (!e.w) {
      e.w = freshLocal('i32')
      if (e.st) e.st[e.st.length - 1] = ['local.tee', e.w, e.st[e.st.length - 1]]
      // (the load node itself becomes the tee: a fold may have moved it under a new parent)
      else { const load = e.load.slice(); e.load.length = 0; e.load.push('local.tee', e.w, load) }
    }
    return ['local.get', e.w]
  }
  const guarding = (c) => held.some(h => h.keys.has(c))
  // `(i32.lt_u IDX (i32.shr_u (i32.load H) (i32.const 2)))`, alone or the last conjunct of an
  // `i32.and`, H the base's header (base − 8): the bound check of a 4-byte element at
  // `(i32.add BASE (i32.shl IDX (i32.const 2)))` → the header's key, else null
  const boundedHeader = (cond, addr) => {
    const b = isArr(cond) && cond[0] === 'i32.and' && cond.length === 3 ? cond[2] : cond
    if (!isArr(b) || b[0] !== 'i32.lt_u' || b.length !== 3) return null
    const len = b[2]
    if (!isArr(len) || len[0] !== 'i32.shr_u' || len.length !== 3 || keyOf(len[2]) !== num('i32.const 2')) return null
    const ld = len[1]
    if (!isArr(ld) || ld[0] !== 'i32.load' || ld.length !== 2) return null
    if (!isArr(addr) || addr[0] !== 'i32.add' || addr.length !== 3) return null
    const sh = addr[2]
    if (!isArr(sh) || sh[0] !== 'i32.shl' || sh.length !== 3 || keyOf(sh[2]) !== num('i32.const 2')) return null
    const base = keyOf(addr[1]), idx = keyOf(sh[1]), hdr = keyOf(ld[1])
    return base && idx && idx === keyOf(b[1]) && hdr === num(`i32.sub ${base} ${num('i32.const 8')}`) ? hdr : null
  }
  // what a construct wrote: its locals hold new values, a write to memory starts new memory
  const forget = (n) => {
    let mem = false
    const walk = (x) => {
      if (!isArr(x)) return
      if ((x[0] === 'local.set' || x[0] === 'local.tee') && typeof x[1] === 'string') key.set(x[1], num(`${x[1]}@${++version}`))
      else if (memWrite(x[0]) || callsOut(x)) mem = true
      for (let i = 1; i < x.length; i++) walk(x[i])
    }
    walk(n)
    if (mem) wrote()
  }

  // An expression, in evaluation order: operands, then the node's own write or call.
  const expr = (n) => {
    if (!isArr(n)) return n
    const op = n[0]
    if (op === 'block' || op === 'loop' || op === 'if') return stmt(n)
    for (let i = 1; i < n.length; i++) {
      n[i] = expr(n[i])
      // an element load an enclosing guard runs: its word, for later loads under that guard
      const x = n[i]
      // (under the whole guard: one conjunct true does not run the arm)
      const h = held[held.length - 1]
      if (isArr(x) && x[0] === 'i32.load' && x.length === 2 && elementAddr(x[1]) && h && h.depth === depth && h.c != null) {
        const a = keyOf(x[1])
        if (a != null && !loads.has(`${h.c}|${a}`)) loads.set(`${h.c}|${a}`, { c: h.c, a, load: x, w: null, arm: h })
      }
    }
    // an element load where an enclosing guard is the condition a store or a load ran under: its word
    if (op === 'i32.load' && n.length === 2 && held.length) {
      const a = keyOf(n[1])
      if (a != null) for (const e of [...known.values(), ...loads.values()]) if (e.a === a && guarding(e.c)) { const w = take(e); vn.set(w, keyOf(n)); return w }
    }
    const f = foldCompare(n)
    if (f) return f
    if ((op === 'local.set' || op === 'local.tee') && typeof n[1] === 'string') { set(n[1], n[2]); vn.set(n, key.get(n[1])) }
    else { vn.set(n, keyOf(n)); if (memWrite(op) || callsOut(n)) wrote() }
    return n
  }

  const stmt = (n) => {
    if (!isArr(n)) return n
    const op = n[0]
    if (op !== 'block' && op !== 'loop' && op !== 'if') return expr(n)
    let i = 1
    if (typeof n[i] === 'string') i++
    while (isArr(n[i]) && (n[i][0] === 'result' || n[i][0] === 'param' || n[i][0] === 'type')) i++
    if (op === 'loop') {
      // the back edge brings what the body writes: none of it holds at the top
      forget(n); wrote()
      depth++
      for (let j = i; j < n.length; j++) n[j] = stmt(n[j])
      depth--
      forget(n); wrote()
      return n
    }
    if (op === 'block') {
      // a branch to the block's end from the middle meets it: past such a block what the block
      // wrote holds on no path, nor a word a load inside it took; a block nothing leaves early
      // ran straight through
      const before = new Map(loads)
      depth++
      for (let j = i; j < n.length; j++) n[j] = stmt(n[j])
      depth--
      if (isLabel(n[1]) && targets(n, n[1])) {
        for (const k of [...loads.keys()]) if (!before.has(k)) loads.delete(k)
        forget(n)
      }
      return n
    }
    n[i] = expr(n[i])
    const cond = n[i], then = n[i + 1], els = n[i + 2]
    // a checked store: (if C (then (STORE A W)))
    const st = isArr(then) && then[0] === 'then' && then.length === 2 && els == null && !(isArr(n[1]) && n[1][0] === 'result') ? then[1] : null
    if (isArr(st) && STORE_LOAD[st[0]]) {
      const [args, ops] = split(st)
      if (ops.length === 2) {
        const at = st.length - 2
        st[at] = expr(st[at]); st[at + 1] = expr(st[at + 1])
        const c = keyOf(cond), a = keyOf(st[at])
        // a store the bound check keeps inside its array leaves that array's header as it was
        const hdr = st[0] === 'i32.store' && !args.length ? boundedHeader(cond, st[at]) : null
        const before = epoch
        wrote()
        if (hdr && c != null && a != null) {
          kept = hdr; keptEpoch = before
          known.set(`${c}|${a}`, { c, a, st, w: null })
        }
        return n
      }
    }
    // the guard and its conjuncts: where the then arm runs, each held
    const guards = isArr(cond) && cond[0] === 'i32.and' && cond.length === 3 ? [cond, cond[2], cond[1]] : [cond]
    const gkeys = new Set(guards.map(keyOf).filter(k => k != null))
    const savedKey = new Map(key), savedKnown = new Map(known), savedLoads = new Map(loads), savedEpoch = epoch, savedKept = kept, savedKeptEpoch = keptEpoch
    const restore = () => {
      key.clear(); for (const [k, v] of savedKey) key.set(k, v)
      known.clear(); for (const [k, v] of savedKnown) known.set(k, v)
      loads.clear(); for (const [k, v] of savedLoads) loads.set(k, v)
      epoch = savedEpoch; kept = savedKept; keptEpoch = savedKeptEpoch
    }
    // what an arm learned ends with it, but for a load the then arm runs at its top: the
    // guard true later (the same value, the same memory) means it ran
    const arm = { keys: gkeys, depth: depth + 1, c: keyOf(cond) }
    let armsWrote = false, ran = []
    depth++
    for (let j = i + 1; j < n.length; j++) {
      restore()
      const guarded = gkeys.size && isArr(n[j]) && n[j][0] === 'then'
      if (guarded) held.push(arm)
      if (isArr(n[j])) for (let k = 1; k < n[j].length; k++) n[j][k] = stmt(n[j][k])
      if (guarded) { held.pop(); ran = [...loads].filter(([, e]) => e.arm === arm) }
      if (epoch !== savedEpoch) armsWrote = true
    }
    depth--
    restore()
    for (const [k, e] of ran) loads.set(k, e)
    for (let j = i + 1; j < n.length; j++) forget(n[j])
    if (armsWrote) wrote()
    return n
  }
  for (let i = bodyStart; i < fn.length; i++) fn[i] = stmt(fn[i])
  if (decls.length) fn.splice(bodyStart, 0, ...decls)
}
