import { cloneNode, walkAst } from '../../ast.js'
import { constNum, hasBranchOrReturn, isI32Const, isLocalGet } from './addr-model.js'
import { isArr } from './node-utils.js'
import { matchBlockLoop } from './scaffold.js'

// ---- Secondary counters as functions of the exit counter ---------------------
//
// An output cursor steps beside the loop counter:
//   for (let i = 0; i < n; i++) { …; out[op] = u; op += 2 }
// Every recognizer reads addresses affine in ONE counter, so the cursor makes the
// loop a recurrence to them. But a counter that only its own constant step moves
// is the exit counter scaled and shifted: inside the body `op = B + c·i`, with
// `B = op − c·i` taken before the loop. The rewrite says so: an address through
// the cursor becomes `P + (i << k)` over a base computed once, any other read
// becomes `B + c·i`, the step leaves the loop, and the cursor lands on its value
// after the block. The body holds no branch, so the block is left only through
// its exit test, where the relation still holds.
//
// The rewrite is built on a copy and used only when a lift takes it.

const LOAD_STORE = /^(?:i32|i64|f32|f64|v128)\.(?:load|store)/

/** `base + ((op + k) << s)` over the counter `op`, as { base, k, s }, or null. */
function cursorAddr(addr, op, writes) {
  if (!isArr(addr) || addr[0] !== 'i32.add' || addr.length !== 3) return null
  const invariant = n => {
    let ok = true
    walkAst(n, { enter: c => {
      if (c[0] === 'local.get' ? writes.has(c[1]) : !(c[0] === 'i32.const' || c[0] === 'global.get' || c[0] === 'i32.add' || c[0] === 'i32.sub' || c[0] === 'i32.shl' || c[0] === 'i32.mul')) ok = false
    } })
    return ok
  }
  const index = n => {
    let s = 0
    if (isArr(n) && n[0] === 'i32.shl' && n.length === 3 && isI32Const(n[2])) { s = constNum(n[2]) & 31; n = n[1] }
    if (isLocalGet(n, op)) return { k: 0, s }
    if (isArr(n) && n[0] === 'i32.add' && n.length === 3) {
      if (isLocalGet(n[1], op) && isI32Const(n[2])) return { k: constNum(n[2]), s }
      if (isLocalGet(n[2], op) && isI32Const(n[1])) return { k: constNum(n[1]), s }
    }
    return null
  }
  for (const [b, x] of [[addr[1], addr[2]], [addr[2], addr[1]]]) {
    const ix = index(x)
    if (ix && invariant(b)) return { base: b, ...ix }
  }
  return null
}

/**
 * The loop of `node` with its constant-step secondary counters rewritten over the
 * exit counter: { node, setup, landing, decls }, or null when there is none to
 * rewrite. `setup` runs before the block, `landing` after it.
 */
export function canonicalizeCounters(node, fnLocals, freshIdRef) {
  const run = matchBlockLoop(node, { allowPreamble: true, allowInlinedLi: true, ivRun: true })
  if (!run || !run.ivs.length) return null
  const { incVar, body, ivs, writes } = run
  if (body.some(hasBranchOrReturn)) return null
  for (const iv of ivs) {
    if (!isI32Const(iv.step) || constNum(iv.step) === 0 || fnLocals.get(iv.name) !== 'i32') return null
    // Only its step moves the counter.
    let written = false
    for (const s of body) walkAst(s, { enter: c => { if ((c[0] === 'local.set' || c[0] === 'local.tee') && c[1] === iv.name) written = true } })
    if (written) return null
  }

  const copy = cloneNode(node)
  const loop = copy.find(c => isArr(c) && c[0] === 'loop')
  const setup = [], landing = [], decls = []
  const fresh = (tag) => { const name = `$__c${tag}${freshIdRef.next++}`; decls.push(['local', name, 'i32']); return name }
  const i = () => ['local.get', incVar]

  for (const { name: op, step } of ivs) {
    const c = constNum(step)
    const B = fresh('b')
    const scaled = () => ['i32.mul', i(), ['i32.const', c]]
    setup.push(['local.set', B, ['i32.sub', ['local.get', op], scaled()]])
    landing.push(['local.set', op, ['i32.add', ['local.get', B], scaled()]])
    // The step leaves the loop.
    for (let j = loop.length - 1; j >= 3; j--) {
      const st = loop[j]
      if (isArr(st) && st[0] === 'local.set' && st[1] === op && isArr(st[2]) && st[2][0] === 'i32.add' && isLocalGet(st[2][1], op)) { loop.splice(j, 1); break }
    }
    const bases = new Map()   // address shape → its base local
    const visit = n => {
      if (!isArr(n)) return
      if (LOAD_STORE.test(n[0])) {
        let a = 1
        while (typeof n[a] === 'string') a++
        const m = cursorAddr(n[a], op, writes)
        const stride = m && Math.imul(c, 1 << m.s)
        if (m && stride > 0 && (stride & (stride - 1)) === 0) {
          const key = JSON.stringify([m.base, m.k, m.s])
          let P = bases.get(key)
          if (!P) {
            P = fresh('p')
            bases.set(key, P)
            const lead = m.k ? ['i32.add', ['local.get', B], ['i32.const', m.k]] : ['local.get', B]
            setup.push(['local.set', P, ['i32.add', cloneNode(m.base), m.s ? ['i32.shl', lead, ['i32.const', m.s]] : lead]])
          }
          const k = 31 - Math.clz32(stride)
          n[a] = ['i32.add', ['local.get', P], k ? ['i32.shl', i(), ['i32.const', k]] : i()]
          for (let j = a + 1; j < n.length; j++) visit(n[j])
          return
        }
      }
      for (let j = 1; j < n.length; j++) {
        if (isLocalGet(n[j], op)) n[j] = ['i32.add', ['local.get', B], scaled()]
        else visit(n[j])
      }
    }
    for (let j = 3; j < loop.length; j++) visit(loop[j])
  }
  return { node: copy, setup, landing, decls }
}
