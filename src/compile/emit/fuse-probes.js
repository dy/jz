/**
 * One probe for a statement that asks a Map or a Set about a key and then
 * stores it: `if (!m.has(k)) { m.set(k, v); … }`, `if (!s.has(k)) { s.add(k);
 * … }`, `if (!m.has(k) || g) m.set(k, v)` with `m.get(k)` read in `g`. The
 * statement finds the key once first (module/collection.js `__slot_open`: its
 * entry, or the empty bucket a miss ended at); the test reads whether it
 * missed, `g`'s `m.get(k)` the entry, and the store writes the entry or
 * inserts at that bucket, where each was a probe of its own.
 *
 * The bucket holds between the find and the store because nothing runs
 * between them that could change the table: the value and `g` run no code
 * (literals, names, operators over plain kinds, an array or object literal
 * of such, `m.get(k)` itself), the store is the arm's first statement, the receiver and the key
 * are names the statement does not assign, and the receiver is a present Set
 * or Map with no own `has`, `get`, `set` or `add`.
 *
 * @module compile/emit/fuse-probes
 */
import { ctx } from '../../ctx.js'
import { isReassigned } from '../../ast.js'
import { freshId } from '../../ir.js'
import { K, tagOf, core } from '../../summary/kind.js'
import { VAL } from '../../reps.js'

const isArr = Array.isArray
const PURE_OPS = new Set(['+', '-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>', '~', '!',
  '&&', '||', '??', '?:', '==', '===', '!=', '!==', '<', '<=', '>', '>=', 'u-', 'u+', 'void', 'typeof', '()'])

/** `recv.method(...)` → its arguments, else null. */
const methodCall = (n, recv, method) =>
  isArr(n) && n[0] === '()' && isArr(n[1]) && n[1][0] === '.' && n[1][1] === recv && n[1][2] === method
    ? n[2] == null ? [] : isArr(n[2]) && n[2][0] === ',' ? n[2].slice(1) : [n[2]] : null

const sameKey = (a, b) => a === b || isArr(a) && isArr(b) && a[0] == null && b[0] == null && a[1] === b[1]

// the kinds an operator takes without running code or throwing (no object's
// valueOf, no BigInt mixed with a Number)
const PLAIN = [K.NUMBER, K.STRING, K.BOOL, K.NULLISH, K.ABSENT]
const plain = (view, n) => {
  let k
  try { k = view.kindOfExpr(n) } catch { return false }
  return k != null && tagOf(core(k)) !== K.ANY && PLAIN.includes(tagOf(core(k)))
}

/** An expression that runs no code and reads nothing of `m` but `m.get(k)`
 *  (where `get` allows it): a literal, a name, an operator over operands of
 *  plain kinds, an array or object literal of such. `get` collects the reads it
 *  allows; `top` marks an operand no operator converts. */
const quiet = (n, m, k, get, view, top = true) => {
  if (!isArr(n)) return typeof n !== 'string' || n !== m && (top || plain(view, n))
  const op = n[0]
  if (op == null || op === 'str' || op === 'bool') return true
  // a literal of quiet parts allocates and runs nothing (no spread, no computed key)
  if (op === '[') {
    const items = n.length === 2 && isArr(n[1]) && n[1][0] === ',' ? n[1].slice(1) : n.slice(1)
    return items.every(e => quiet(e, m, k, get, view))
  }
  if (op === '{}') {
    const props = n.length === 2 && isArr(n[1]) && n[1][0] === ',' ? n[1].slice(1) : n.slice(1)
    return props.every(p => typeof p === 'string' ? p !== m : isArr(p) && p[0] === ':' && typeof p[1] === 'string' && quiet(p[2], m, k, get, view))
  }
  if (get) { const args = methodCall(n, m, 'get'); if (args && args.length === 1 && sameKey(args[0], k)) { get.push(n); return top || plain(view, n) } }
  if (op === '()' || !PURE_OPS.has(op)) return false
  // these take their operands as they are (no conversion runs code); the rest convert
  const plainOperands = !KEEPS.has(op)
  for (let i = 1; i < n.length; i++) if (!quiet(n[i], m, k, get, view, !plainOperands)) return false
  return true
}
const KEEPS = new Set(['===', '!==', '!', 'typeof', 'void', '&&', '||', '??', '?:'])

/** The statements of an arm, and how to put them back. */
const armStatements = (arm) => {
  if (isArr(arm) && arm[0] === '{}' && arm.length === 2) {
    const inner = arm[1]
    if (isArr(inner) && inner[0] === ';') return [inner.slice(1), (stmts) => ['{}', [';', ...stmts]]]
    return [[inner], (stmts) => ['{}', stmts.length === 1 ? stmts[0] : [';', ...stmts]]]
  }
  if (isArr(arm) && arm[0] === ';') return [arm.slice(1), (stmts) => [';', ...stmts]]
  return [[arm], (stmts) => stmts.length === 1 ? stmts[0] : [';', ...stmts]]
}

/** The rewritten `if` of a fusable statement, or null. */
export function fuseProbeIf(cond, then, els) {
  if (ctx.transform.optimize?.leanRuntime) return null
  // the test: `!m.has(k)`, alone or as the first of a disjunction
  let first = cond, rest = null
  if (isArr(cond) && cond[0] === '||' && cond.length === 3) { first = cond[1]; rest = cond[2] }
  if (!isArr(first) || first[0] !== '!') return null
  const has = first[1]
  if (!isArr(has) || has[0] !== '()' || !isArr(has[1]) || has[1][0] !== '.' || has[1][2] !== 'has') return null
  const m = has[1][1], hasArgs = methodCall(has, m, 'has')
  if (typeof m !== 'string' || hasArgs?.length !== 1) return null
  const k = hasArgs[0]
  if (!(typeof k === 'string' || isArr(k) && k[0] == null && (typeof k[1] === 'number' || typeof k[1] === 'string'))) return null
  const view = ctx.summary?.at(ctx.func.current)
  if (!view) return null
  let kind
  try { kind = view.kindOfExpr(m) } catch { return null }
  const tag = tagOf(core(kind))
  if (tag !== K.MAP && tag !== K.SET) return null
  if (view.mayBeNullishExpr(m) !== false) return null
  const vt = tag === K.MAP ? VAL.MAP : VAL.SET
  for (const name of ['has', 'get', 'set', 'add']) if (ctx.summary.memberMayBeOwnOn(name, vt)) return null
  // the arm's first statement stores the key: `m.set(k, v)` or `s.add(k)`
  const [stmts, rebuild] = armStatements(then)
  const store = stmts[0], args = methodCall(store, m, tag === K.MAP ? 'set' : 'add')
  if (!args || !sameKey(args[0], k) || args.length !== (tag === K.MAP ? 2 : 1)) return null
  const value = args[1]
  // nothing between the probe and the store runs code or reads the table
  const gets = []
  if (rest && !quiet(rest, m, k, tag === K.MAP ? gets : null, view)) return null
  if (value !== undefined && !quiet(value, m, k, null, view)) return null
  // the receiver and a named key keep their values through the statement
  const whole = ['if', cond, then, els]
  if (isReassigned(whole, m) || typeof k === 'string' && isReassigned(whole, k)) return null
  const id = [null, freshId(ctx)], es = [null, tag === K.MAP ? 24 : 16]
  const call = (name, ...a) => ['()', name, [',', ...a]]
  const fresh = call('__slot_new', m, id)
  const subst = (n) => !isArr(n) ? n : gets.includes(n) ? call('__slot_val', m, id) : n.map((c, i) => i === 0 ? c : subst(c))
  const test = rest ? ['||', fresh, subst(rest)] : fresh
  const arm = rebuild([call('__slot_put', m, tag === K.MAP ? value : [null, 0], id), ...stmts.slice(1)])
  return { open: call('__slot_open', m, k, id, es), test, arm }
}

/** The receiver `m` and key `k` of a fusable probe `m.<method>(k)`, or null:
 *  a present Set or Map (as `tags`) with no own probe members, a named or
 *  literal key. */
const fusable = (call, method, tags) => {
  if (!isArr(call) || call[0] !== '()' || !isArr(call[1]) || call[1][0] !== '.' || call[1][2] !== method) return null
  const m = call[1][1], args = methodCall(call, m, method)
  if (typeof m !== 'string' || args?.length !== 1) return null
  const k = args[0]
  if (!(typeof k === 'string' || isArr(k) && k[0] == null && (typeof k[1] === 'number' || typeof k[1] === 'string'))) return null
  const view = ctx.summary?.at(ctx.func.current)
  if (!view) return null
  let kind
  try { kind = view.kindOfExpr(m) } catch { return null }
  const tag = tagOf(core(kind))
  if (!tags.includes(tag) || view.mayBeNullishExpr(m) !== false) return null
  const vt = tag === K.MAP ? VAL.MAP : VAL.SET
  for (const name of ['has', 'get', 'set', 'add']) if (ctx.summary.memberMayBeOwnOn(name, vt)) return null
  return { m, k, tag, view }
}

const JUMPS = new Set(['continue', 'break', 'return'])

/** Adjacent statements that probe one key and store it, rewritten in `stmts`
 *  (a block's own copy) to probe once, as fuseProbeIf does for one statement:
 *  - `let x = m.get(k)` and `if (<test of x>) { <quiet assignments>; m.set(k, v); … }`
 *    (get-or-insert: the test is kept, so a present key holding undefined is stored too)
 *  - `const l = <quiet over m.get(k)>` and `m.set(k, v)` (a read, then a store)
 *  - `if (s.has(k)) <continue|break|return>` and `s.add(k)` (a Set's first sight). */
export function fuseProbePairs(stmts) {
  if (ctx.transform.optimize?.leanRuntime) return
  const call = (name, ...a) => ['()', name, [',', ...a]]
  for (let i = 0; i + 1 < stmts.length; i++) {
    const s = stmts[i], next = stmts[i + 1]
    if (!isArr(s) || !isArr(next)) continue
    // a binding from a read: `let|const x = <init>`, one declarator
    const decl = (s[0] === 'let' || s[0] === 'const') && s.length === 2 && isArr(s[1]) && s[1][0] === '=' && typeof s[1][1] === 'string' ? s[1] : null
    if (decl) {
      const x = decl[1], init = decl[2]
      // get-or-insert: the read is the whole initializer
      const p = fusable(init, 'get', [K.MAP])
      if (p && next[0] === 'if' && next.length === 3 && quiet(next[1], p.m, p.k, null, p.view)) {
        const [arm, rebuild] = armStatements(next[2])
        let j = 0
        while (j < arm.length && isArr(arm[j]) && arm[j][0] === '=' && typeof arm[j][1] === 'string' && arm[j][1] !== p.m && arm[j][1] !== p.k &&
          quiet(arm[j][2], p.m, p.k, null, p.view)) j++
        const args = methodCall(arm[j], p.m, 'set')
        if (args?.length === 2 && sameKey(args[0], p.k) && quiet(args[1], p.m, p.k, null, p.view) &&
            x !== p.m && x !== p.k && !isReassigned(next, p.m) && !(typeof p.k === 'string' && isReassigned(next, p.k))) {
          const id = [null, freshId(ctx)]
          stmts[i] = [s[0], ['=', x, call('__slot_get', p.m, p.k, id, [null, 24])]]
          stmts[i + 1] = ['if', next[1], rebuild([...arm.slice(0, j), call('__slot_put', p.m, args[1], id), ...arm.slice(j + 1)])]
          i++
          continue
        }
      }
      // a read, then a store of the same key
      const gets = []
      const q = initialRead(init)
      if (q && quiet(init, q.m, q.k, gets, q.view) && gets.length === 1) {
        const args = methodCall(next, q.m, 'set')
        if (args?.length === 2 && sameKey(args[0], q.k) && quiet(args[1], q.m, q.k, null, q.view) && x !== q.m && x !== q.k) {
          const id = [null, freshId(ctx)]
          const subst = (n) => !isArr(n) ? n : n === gets[0] ? call('__slot_get', q.m, q.k, id, [null, 24]) : n.map((c, k) => k === 0 ? c : subst(c))
          stmts[i] = [s[0], ['=', x, subst(init)]]
          stmts[i + 1] = call('__slot_put', q.m, args[1], id)
          i++
          continue
        }
      }
      continue
    }
    // a Set's first sight: `if (s.has(k)) <jump>` then `s.add(k)`
    if (s[0] === 'if' && s.length === 3 && isArr(s[2]) && (JUMPS.has(s[2][0]) || JUMPS.has(s[2]))) {
      const p = fusable(s[1], 'has', [K.SET])
      const args = p && methodCall(next, p.m, 'add')
      if (args?.length === 1 && sameKey(args[0], p.k)) {
        const id = [null, freshId(ctx)]
        stmts[i] = [';', call('__slot_open', p.m, p.k, id, [null, 16]), ['if', ['!', call('__slot_new', p.m, id)], s[2]]]
        stmts[i + 1] = call('__slot_put', p.m, [null, 0], id)
        i++
      }
    }
  }
}

/** The one `m.get(k)` a quiet expression reads, as fusable sees it, or null. */
const initialRead = (n) => {
  if (!isArr(n)) return null
  const p = fusable(n, 'get', [K.MAP])
  if (p) return p
  if (n[0] === '()' || n[0] == null || n[0] === 'str') return null
  for (let i = 1; i < n.length; i++) { const r = initialRead(n[i]); if (r) return r }
  return null
}
