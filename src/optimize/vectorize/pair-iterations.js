import { cloneNode, walkAst } from '../../ast.js'
import { readsBeforeWrite } from './addr-model.js'
import { isArr } from './node-utils.js'
import { bumpPixelIV } from './outer-scaffold.js'

/**
 * Two pixels' inner loops, run side by side.
 *
 *   for (qx = 0; qx < W; qx++) {           // independent items
 *     …setup…
 *     if (c) { …; while (…) { x = f(x) … break … }; … }   // an inner loop carrying a float recurrence
 *     …px[j] = …
 *   }
 *
 * Each step of such an inner loop waits on the one before (`x = f(x)`): the core
 * idles behind one chain while the next pixel's chain, independent of it, has
 * not started. Here two adjacent items run as lanes A (pixel qx) and B (qx+1):
 * A's work up to its inner loop, B's, then one loop stepping whichever lanes are
 * still running, then A's work after the loop, then B's. The two chains overlap
 * in the core. No escape-time lift took the loop (the f64x2 one comes first):
 * its body branches, calls, or exits in ways lanes of a vector cannot.
 *
 * Every lane runs its own statements in its own order, so each value is the one
 * the loop as written computes. What moves is one lane's work against the
 * other's, which is unobservable when the items are independent:
 *   • no local the body writes carries a value from one item to the next (each
 *     read follows a write in the same item) or is read after the loop;
 *   • the body calls only pure helpers, writes no global, and stores only after
 *     its inner loop, through a base no load of the body reads (distinct bases
 *     are distinct arrays: the vectorizer's standing model);
 *   • nothing in it traps but what the loop as written would trap on alike (no
 *     division by a variable, no trapping truncation), and it branches only to
 *     labels of its own.
 * Lane B reads the pixel counters one ahead and writes locals of its own; an odd
 * last item runs the loop as written, which follows.
 */

const PURE_MATH_EXCEPT = new Set(['$math.random'])
const NO_PAIR_OPS = new Set(['return', 'return_call', 'return_call_indirect', 'unreachable', 'throw', 'throw_ref', 'try_table', 'try', 'call_indirect', 'call_ref',
  'br_table', 'global.set', 'memory.grow', 'memory.fill', 'memory.copy', 'memory.init', 'data.drop',
  'i32.trunc_f64_s', 'i32.trunc_f64_u', 'i32.trunc_f32_s', 'i32.trunc_f32_u', 'i64.trunc_f64_s', 'i64.trunc_f64_u', 'i64.trunc_f32_s', 'i64.trunc_f32_u'])
const DIVS = new Set(['i32.div_s', 'i32.div_u', 'i32.rem_s', 'i32.rem_u', 'i64.div_s', 'i64.div_u', 'i64.rem_s', 'i64.rem_u'])
const isStore = (op) => typeof op === 'string' && /^(i32|i64|f32|f64|v128)\.store/.test(op)
const isLoad = (op) => typeof op === 'string' && /^(i32|i64|f32|f64|v128)\.load/.test(op)
const isLabel = (s) => typeof s === 'string' && s[0] === '$'
// a constant divisor that neither is zero nor, signed, -1 (INT_MIN / -1 traps)
const safeDivisor = (op, d) => isArr(d) && (d[0] === 'i32.const' || d[0] === 'i64.const') &&
  Number(d[1]) !== 0 && !(op.endsWith('div_s') && Number(d[1]) === -1)
const MAX_NODES = 12000

// `(if label? (result …)? cond (then …) (else …)?)` → its parts, or null for a typed or labeled if
const ifParts = (n) => {
  let i = 1
  if (isLabel(n[i])) return null
  if (isArr(n[i]) && n[i][0] === 'result') return null
  const cond = n[i], then = n[i + 1], els = n[i + 2]
  if (!isArr(then) || then[0] !== 'then') return null
  if (els != null && !(isArr(els) && els[0] === 'else')) return null
  if (n.length > i + 3) return null
  return { cond, then, els }
}

const hasLoop = (n) => {
  let has = false
  walkAst(n, { enter: x => { if (has) return false; if (x[0] === 'loop') has = true } })
  return has
}

// The block holding the inner loop, as the last of its statements, and the path of
// `if` arms down to it from the body: [{ list, idx, arm }] (arm: 'then' | 'else' | null).
// A loop in an `if`'s condition (an inlined scan: `if (ys.includes(i))`) runs before
// either arm, and no arm holds it: the body has no inner loop to pair.
function findInner(obody) {
  let loops = 0
  for (const s of obody) walkAst(s, { enter: n => { if (n[0] === 'loop') loops++ } })
  if (loops !== 1) return null
  const search = (list, path) => {
    for (let i = 0; i < list.length; i++) {
      const s = list[i]
      if (!isArr(s) || !hasLoop(s)) continue
      if (s[0] === 'block') {
        const last = s[s.length - 1]
        if (!isLabel(s[1]) || !isArr(last) || last[0] !== 'loop' || !isLabel(last[1])) return null
        if (s.some(c => isArr(c) && (c[0] === 'result' || c[0] === 'param'))) return null
        if (last.some(c => isArr(c) && (c[0] === 'result' || c[0] === 'param'))) return null
        return { block: s, path: [...path, { list, idx: i, arm: null }] }
      }
      if (s[0] === 'if') {
        const p = ifParts(s)
        if (!p || hasLoop(p.cond)) return null
        // (the one loop is in an arm: then, or else, which therefore exists)
        const inThen = hasLoop(p.then)
        return search((inThen ? p.then : p.els).slice(1), [...path, { list, idx: i, arm: inThen ? 'then' : 'else', node: s, parts: p }])
      }
      return null
    }
    return null
  }
  return search(obody, [])
}

// Whether every read of a local the body writes follows a write of it in the same
// item, on every path; `W` the body's written locals. Branch exits carry what is
// assigned where they leave; an unreachable point (after `br`) assigns everything.
function itemPrivate(obody, W) {
  const ALL = null
  const meet = (a, b) => a === ALL ? b : b === ALL ? a : new Set([...a].filter(x => b.has(x)))
  const copy = (d) => d === ALL ? ALL : new Set(d)
  const exits = new Map()
  let ok = true
  const leave = (label, d) => { if (exits.has(label)) exits.set(label, meet(exits.get(label), copy(d))) }
  const seq = (list, from, d) => { for (let i = from; i < list.length && ok; i++) d = walk(list[i], d); return d }
  const walk = (n, d) => {
    if (!ok || !isArr(n)) return d
    const op = n[0]
    if (op === 'local.get') { if (W.has(n[1]) && d !== ALL && !d.has(n[1])) ok = false; return d }
    if (op === 'local.set' || op === 'local.tee') { d = seq(n, 2, d); if (d !== ALL) d.add(n[1]); return d }
    if (op === 'if') {
      const label = isLabel(n[1]) ? n[1] : null
      let i = 1
      while (isLabel(n[i]) || (isArr(n[i]) && (n[i][0] === 'result' || n[i][0] === 'param'))) i++
      d = walk(n[i], d)
      if (label) exits.set(label, ALL)
      const arm = (a) => isArr(a) && (a[0] === 'then' || a[0] === 'else') ? seq(a, 1, copy(d)) : copy(d)
      let end = meet(arm(n[i + 1]), arm(n[i + 2]))
      if (label) { end = meet(end, exits.get(label)); exits.delete(label) }
      return end
    }
    if (op === 'block' || op === 'loop') {
      const label = isLabel(n[1]) ? n[1] : null
      if (op === 'block' && label) exits.set(label, ALL)
      let end = seq(n, 1, copy(d))
      if (op === 'block' && label) { end = meet(end, exits.get(label)); exits.delete(label) }
      return end
    }
    if (op === 'br') { leave(n[1], d); return ALL }
    if (op === 'br_if') { d = seq(n, 2, d); leave(n[1], d); return d }
    return seq(n, 1, d)
  }
  seq(obody, 0, new Set())
  return ok
}

// The base locals a store's address names, past single-definition copies.
function rootsOf(expr, defs, out, depth = 0) {
  walkAst(expr, { enter: n => {
    if (n[0] !== 'local.get' && n[0] !== 'global.get') return
    const d = n[0] === 'local.get' ? defs.get(n[1]) : null
    if (d && depth < 8) rootsOf(d, defs, out, depth + 1)
    else out.add(n[0] + ' ' + n[1])
  } })
  return out
}

/**
 * The paired loop for the outer pixel loop `node` (matched as `op`, see
 * matchOuterPixelLoop), or null. `outsideReads` answers which locals the function
 * reads past the loop.
 */
export function tryPairIterations(node, fnLocals, freshIdRef, op, outsideReads, enabled) {
  if (!enabled || !op) return null
  const { obody, pixelIVs, pivType, preamble, oExit, widthBound } = op
  let size = 0
  for (const s of obody) walkAst(s, { enter: () => { size++ } })
  if (size > MAX_NODES) return null
  const inner = findInner(obody)
  if (!inner) return null
  const B = inner.block, bLabel = B[1], loop = B[B.length - 1], cLabel = loop[1]
  const X = B.slice(2, B.length - 1), Y = loop.slice(2)

  // ---- what makes the lanes independent ----
  const W = new Set(), labels = new Set(), defsCount = new Map(), defs = new Map()
  let bad = false
  const branchTargets = []
  for (const s of obody) walkAst(s, { enter: n => {
    if (bad) return false
    const o = n[0]
    if (NO_PAIR_OPS.has(o)) { bad = true; return false }
    if (o === 'call') { if (typeof n[1] !== 'string' || !n[1].startsWith('$math.') || PURE_MATH_EXCEPT.has(n[1])) { bad = true; return false } }
    if (DIVS.has(o) && !safeDivisor(o, n[2])) { bad = true; return false }
    if ((o === 'local.set' || o === 'local.tee') && typeof n[1] === 'string') {
      W.add(n[1]); defsCount.set(n[1], (defsCount.get(n[1]) || 0) + 1); defs.set(n[1], n[2])
    }
    if ((o === 'block' || o === 'loop' || o === 'if') && isLabel(n[1])) labels.add(n[1])
    if (o === 'br' || o === 'br_if') branchTargets.push(n[1])
  } })
  if (bad) return null
  for (const t of branchTargets) if (!labels.has(t)) return null
  for (const p of pixelIVs) if (W.has(p.name)) return null
  for (const x of W) if (outsideReads.has(x) || !fnLocals.has(x)) return null
  // a label inside the inner block named like its own two would capture their branches
  let shadow = false
  for (const s of [...X, ...Y]) walkAst(s, { enter: n => { if ((n[0] === 'block' || n[0] === 'loop' || n[0] === 'if') && (n[1] === bLabel || n[1] === cLabel)) shadow = true } })
  if (shadow) return null
  // the inner block's branches stay inside it: they are retargeted to the step's own labels
  const innerLabels = new Set()
  walkAst(B, { enter: n => { if ((n[0] === 'block' || n[0] === 'loop' || n[0] === 'if') && isLabel(n[1])) innerLabels.add(n[1]) } })
  let escapes = false
  walkAst(B, { enter: n => { if ((n[0] === 'br' || n[0] === 'br_if') && !innerLabels.has(n[1])) escapes = true } })
  if (escapes) return null
  // The inner loop carries a float recurrence (an f64 it reads before writing) and leaves
  // on a test of it: its trip count is the data's, so the core cannot run ahead into the
  // next item past an exit it mispredicts. A counted loop (fbm octaves) it can; paired, it
  // only pays for the second copy.
  const tainted = new Set()
  // (a counter stepped by a constant, f64 or not, is no recurrence: its loop is counted)
  const counter = (x) => {
    let only = true
    for (const s of Y) walkAst(s, { enter: n => {
      if (!only || (n[0] !== 'local.set' && n[0] !== 'local.tee') || n[1] !== x) return
      const v = n[2]
      if (!(isArr(v) && (v[0] === 'f64.add' || v[0] === 'f64.sub') && v.length === 3 && isArr(v[1]) && v[1][0] === 'local.get' && v[1][1] === x && isArr(v[2]) && v[2][0] === 'f64.const')) only = false
    } })
    return only
  }
  for (const x of W) if (fnLocals.get(x) === 'f64' && readsBeforeWrite(Y, x) && !counter(x)) tainted.add(x)
  if (!tainted.size) return null
  const readsTainted = (e) => { let hit = false; walkAst(e, { enter: n => { if (hit) return false; if (n[0] === 'local.get' && tainted.has(n[1])) hit = true } }); return hit }
  // (what the test's value is built from, and what a branch on it decides: a flag set under it)
  const condAt = (n) => { let c = 1; while (isLabel(n[c]) || (isArr(n[c]) && (n[c][0] === 'result' || n[c][0] === 'param' || n[c][0] === 'type'))) c++; return c }
  for (let grew = true; grew;) {
    grew = false
    const taint = (n, under) => {
      if (!isArr(n)) return
      if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string' && !tainted.has(n[1]) && (under || readsTainted(n[2]))) { tainted.add(n[1]); grew = true }
      if (n[0] === 'if') {
        const c = condAt(n)
        taint(n[c], under)
        const u = under || readsTainted(n[c])
        for (let i = c + 1; i < n.length; i++) taint(n[i], u)
        return
      }
      for (let i = 1; i < n.length; i++) taint(n[i], under)
    }
    for (const s of Y) taint(s, false)
  }
  const branchesOut = (n) => { let hit = false; walkAst(n, { enter: x => { if (hit) return false; if ((x[0] === 'br' || x[0] === 'br_if') && (x[1] === bLabel || x[1] === cLabel)) hit = true } }); return hit }
  let floatExit = false
  for (const s of Y) walkAst(s, { enter: n => {
    if (floatExit) return false
    if (n[0] === 'br_if' && (n[1] === bLabel || n[1] === cLabel) && readsTainted(n[2])) floatExit = true
    else if (n[0] === 'if') { const c = condAt(n); if (readsTainted(n[c]) && n.slice(c + 1).some(branchesOut)) floatExit = true }
  } })
  if (!floatExit) return null
  if (!itemPrivate(obody, W)) return null

  // stores: only after the inner loop, through bases no load reads
  for (const [name, c] of defsCount) if (c !== 1) defs.delete(name)
  for (const s of preamble) if (isArr(s) && s[0] === 'local.set' && typeof s[1] === 'string' && !defs.has(s[1]) && !W.has(s[1])) defs.set(s[1], s[2])
  const storeRoots = new Set(), loadRoots = new Set()
  let storeEarly = false
  const scanMem = (s, early) => walkAst(s, { enter: n => {
    if (isStore(n[0])) { if (early) storeEarly = true; rootsOf(n[n.length - 2], defs, storeRoots) }
    else if (isLoad(n[0])) rootsOf(n[n.length - 1], defs, loadRoots)
  } })
  for (const step of inner.path) {
    step.list.forEach((s, i) => {
      if (i < step.idx) scanMem(s, true)
      else if (i > step.idx) scanMem(s, false)
    })
    if (step.arm === 'then' && step.parts.els) scanMem(step.parts.els, true)
    if (step.arm === 'else') scanMem(step.parts.then, true)
    if (step.arm) scanMem(step.parts.cond, true)
  }
  for (const s of [...X, ...Y]) scanMem(s, true)
  if (storeEarly) return null
  for (const p of pixelIVs) { storeRoots.delete('local.get ' + p.name); loadRoots.delete('local.get ' + p.name) }
  for (const r of storeRoots) {
    if (loadRoots.has(r)) return null
    const name = r.slice(r.indexOf(' ') + 1)
    if (W.has(name)) return null
  }

  // ---- the lanes ----
  const id = freshIdRef.next++
  const decls = []
  const fresh = (base, type) => { const n = `$__pi${id}_${base}`; decls.push(['local', n, type]); return n }
  const renameB = new Map([...W].map(x => [x, `${x}__pi${id}`]))
  for (const [x, y] of renameB) decls.push(['local', y, fnLocals.get(x)])
  const laneLabels = new Map([...labels].map(l => [l, `${l}__pi${id}`]))
  const laneCopy = (n, k) => {
    let c = cloneNode(n)
    if (k === 0) return c
    c = bumpPixelIV(pivType, c, 1)
    const walk = (x) => {
      if (!isArr(x)) return
      for (let i = 0; i < x.length; i++) {
        const v = x[i]
        if (isArr(v)) walk(v)
        else if (typeof v === 'string' && i === 1 && (x[0] === 'local.get' || x[0] === 'local.set' || x[0] === 'local.tee') && renameB.has(v)) x[i] = renameB.get(v)
        else if (typeof v === 'string' && i === 1 && (x[0] === 'block' || x[0] === 'loop' || x[0] === 'if' || x[0] === 'br' || x[0] === 'br_if') && laneLabels.has(v)) x[i] = laneLabels.get(v)
      }
    }
    walk(c)
    return c
  }
  // branches to the inner block or loop, retargeted
  const retarget = (n, map) => {
    if (!isArr(n)) return n
    if ((n[0] === 'br' || n[0] === 'br_if') && map.has(n[1])) n[1] = map.get(n[1])
    for (let i = 1; i < n.length; i++) retarget(n[i], map)
    return n
  }
  const lane = (k) => {
    const L = (l) => k === 0 ? l : laneLabels.get(l)
    const act = fresh(`act${k}`, 'i32')
    // Down the path to the inner block, each level's statements ahead of it run
    // where the levels above took the path (`on`, a 0/1 local; the top level
    // always). An arm's condition lands in a 0/1 local of its own, read again
    // for what follows the block in that arm, which runs after the loop.
    const pre = [], levels = []
    let on = null
    const under = (flag, stmts) => !stmts.length ? [] : flag ? [['if', ['local.get', flag], ['then', ...stmts]]] : stmts
    for (const step of inner.path) {
      pre.push(...under(on, step.list.slice(0, step.idx).map(s => laneCopy(s, k))))
      levels.push({ on, rest: step.list.slice(step.idx + 1).map(s => laneCopy(s, k)) })
      if (!step.arm) break
      const cv = fresh(`cv${k}_${levels.length}`, 'i32'), next = fresh(`on${k}_${levels.length}`, 'i32')
      const cond = ['i32.ne', laneCopy(step.parts.cond, k), ['i32.const', 0]]
      pre.push(['local.set', cv, on ? ['if', ['result', 'i32'], ['local.get', on], ['then', cond], ['else', ['i32.const', 0]]] : cond])
      // `cv` holds "on the path and the condition holds"; the other answer is "on, and not cv"
      const yes = ['local.get', cv], no = on ? ['i32.and', ['local.get', on], ['i32.eqz', ['local.get', cv]]] : ['i32.eqz', ['local.get', cv]]
      const [here, there] = step.arm === 'then' ? [yes, no] : [no, yes]
      pre.push(['local.set', next, here])
      const other = step.arm === 'then' ? step.parts.els : step.parts.then
      if (other && other.length > 1) pre.push(['if', there, ['then', ...other.slice(1).map(s => laneCopy(s, k))]])
      on = next
    }
    // entry statements of the inner block: a branch to its label skips the loop
    const xs = `$__pi${id}_xs${k}`, xd = `$__pi${id}_xd${k}`
    pre.push(['local.set', act, on ? ['local.get', on] : ['i32.const', 1]])
    if (X.length) pre.push(['block', xd, ['br_if', xd, ['i32.eqz', ['local.get', act]]],
      ['block', xs, ...X.map(s => retarget(laneCopy(s, k), new Map([[L(bLabel), xs]]))), ['br', xd]],
      ['local.set', act, ['i32.const', 0]]])
    // one step of the inner loop: continuing keeps the lane, leaving it (or falling off) stops it
    const kend = `$__pi${id}_end${k}`, kexit = `$__pi${id}_exit${k}`, kcont = `$__pi${id}_cont${k}`
    const step = ['block', kend, ['br_if', kend, ['i32.eqz', ['local.get', act]]],
      ['block', kexit,
        ['block', kcont, ...Y.map(s => retarget(laneCopy(s, k), new Map([[L(cLabel), kcont], [L(bLabel), kexit]]))), ['br', kexit]],
        ['br', kend]],
      ['local.set', act, ['i32.const', 0]]]
    // after the loop, innermost level first, each under its own path flag
    const post = []
    for (let i = levels.length - 1; i >= 0; i--) post.push(...under(levels[i].on, levels[i].rest))
    return { pre, act, step, post }
  }
  const A = lane(0), Bl = lane(1)
  const jb = `$__pi${id}_jb`, jl = `$__pi${id}_jl`
  const jam = ['block', jb, ['loop', jl,
    ['br_if', jb, ['i32.eqz', ['i32.or', ['local.get', A.act], ['local.get', Bl.act]]]],
    A.step, Bl.step,
    ['br', jl]]]

  // both items in range: the exit's counter one ahead still under the bound
  const iv = pixelIVs.find(p => p.name === oExit.ind)
  const ahead = iv.type === 'f64'
    ? ['f64.lt', ['f64.add', ['local.get', iv.name], ['f64.const', 1]], cloneNode(widthBound)]
    : [oExit.cmpOp, ['i32.add', ['local.get', iv.name], ['i32.const', 1]], cloneNode(widthBound)]
  const po = `$__pi${id}_po`, pl = `$__pi${id}_pl`
  const bumps = pixelIVs.map(p => ['local.set', p.name, p.type === 'f64'
    ? ['f64.add', ['local.get', p.name], ['f64.const', 2]]
    : ['i32.add', ['local.get', p.name], ['i32.const', 2]]])
  const paired = ['block', po, ['loop', pl,
    ['br_if', po, ['i32.eqz', ahead]],
    ...A.pre, ...Bl.pre, jam, ...A.post, ...Bl.post,
    ...bumps,
    ['br', pl]]]
  return { wrapper: ['block', ...preamble.map(cloneNode), paired, node], newLocalDecls: decls }
}
