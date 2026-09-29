/**
 * A binding that only ever holds another binding's value is that binding.
 *
 * A spliced call leaves the names its seams had: the result binding every
 * return assigned the same array to (`inret = out` on each path), the local the
 * caller read it through (`parts = inret`), the parameter a closure was passed
 * by. Each is one value under two names, and the passes that ask what a name
 * holds (a literal only indices reach, a lambda only calls reach) see the
 * second name as a use of its own. Here every read of such a name reads the
 * first, and the name is gone.
 *
 * `b` is `a` when
 *   - every definition of `b` is the name `a`, and nothing else writes `b`;
 *   - `a` is a parameter nothing writes or a binding with one definition, its
 *     declaration, so what `b` took is what `a` holds;
 *   - `b` is declared with `a` or assigned before every read on every path
 *     (summary/definite.js): no read finds it undefined;
 *   - no closure mentions `b`: a closure reads at a time of its own.
 *
 * A binding whose every definition is one truth value or `undefined` is that
 * value the same way. With the names gone, what they decided is decided:
 *   - a member of a lambda the function made, read where nothing stores to the
 *     lambda's members or takes it as a value, is undefined unless a function
 *     has it (`typeof generator.next === 'function'` over a closure passed as
 *     the generator);
 *   - `typeof undefined` against a type, an equality of two truth values, a `||`
 *     or `&&` read as a test over a value that decides it, and the `if` or `?:`
 *     of a decided test are their answers, and the arm ruled out is no code.
 *
 * @module compile/plan/alias
 */
import { ctx } from '../../ctx.js'
import { MUTATE_OPS, TYPEOF } from '../../ast.js'
import { definitelyAssigned } from '../../summary/definite.js'
import { setFuncBody } from '../analyze/body-facts.js'
import { splitReassigned } from '../../prepare/split-bindings.js'
import { dropUnreadLocals } from './scratch.js'

const isArr = Array.isArray
// what a declaration with no declarator left stands for
const GONE = [';']

// A value that decides a test: a truth value, `undefined` or `null`. The answer it gives, else undefined.
const decider = (n) => isArr(n) && ((n[0] === 'bool' && n.length === 2) || (n[0] == null && n.length === 2 && (n[1] == null || typeof n[1] === 'boolean')))
const truth = (n) => n[0] === 'bool' ? !!n[1] : !!n[1]
const sameDecider = (a, b) => a[0] === 'bool' || b[0] === 'bool' ? typeof (a[0] === 'bool' ? !!a[1] : a[1]) === 'boolean' && typeof (b[0] === 'bool' ? !!b[1] : b[1]) === 'boolean' && truth(a) === truth(b) : a[1] === b[1]
const answer = (b) => ['bool', b ? 1 : 0]
const EQ = new Set(['===', '=='])
const NE = new Set(['!==', '!='])

// What a test over deciding values comes to; the node itself where it is open. A
// logical operator is decided only where it is a test (`test`): as a value it keeps
// its form, which the kinds of what it yields were read off.
const decide = (n, test) => {
  if (!isArr(n) || n[0] == null || n[0] === 'str' || n[0] === '=>') return n
  const op = n[0]
  if ((EQ.has(op) || NE.has(op)) && n.length === 3) {
    const [, a, b] = n
    // `typeof undefined` against a type's code
    const t = isArr(a) && a[0] === 'typeof' ? [a, b] : isArr(b) && b[0] === 'typeof' ? [b, a] : null
    if (t && isArr(t[0][1]) && t[0][1][0] == null && t[0][1].length === 2 && t[0][1][1] === undefined && isArr(t[1]) && t[1][0] == null && typeof t[1][1] === 'number')
      return answer((t[1][1] === TYPEOF.undefined) === EQ.has(op))
    // two truth values, or two of undefined and null under `===`
    if (decider(a) && decider(b) && (op === '===' || op === '!==') && (a[0] === 'bool' || typeof a[1] === 'boolean') === (b[0] === 'bool' || typeof b[1] === 'boolean'))
      return answer(sameDecider(a, b) === (op === '==='))
    return n
  }
  if (op === '!' && n.length === 2 && decider(n[1])) return answer(!truth(n[1]))
  if (test && (op === '||' || op === '&&') && n.length === 3) {
    if (decider(n[1])) return truth(n[1]) === (op === '||') ? answer(op === '||') : n[2]
    if (decider(n[2]) && truth(n[2]) !== (op === '||')) return n[1]   // `a && true`, `a || false`: the test is `a`
    return n
  }
  if ((op === '?:' || op === '?') && n.length === 4 && decider(n[1])) return truth(n[1]) ? n[2] : n[3]
  if (op === 'if' && decider(n[1])) return truth(n[1]) ? n[2] : n[3] ?? GONE
  return n
}
// The positions of `n` that are tests: what is read there is read for its truth.
const isTest = (n, i, test) => {
  const op = n[0]
  if (op === 'if' || op === '?:' || op === '?' || op === 'while') return i === 1
  if (op === 'for') return n.length === 5 && i === 2
  if (op === '!') return true
  if (op === '&&' || op === '||') return test
  return false
}
// `n` with every decided test its answer, inside out.
const decided = (n, test = false) => {
  if (!isArr(n) || n[0] == null || n[0] === 'str') return n
  let out = n
  for (let i = 1; i < n.length; i++) {
    const c = decided(n[i], isTest(n, i, test))
    if (c === n[i]) { if (out !== n) out.push(c); continue }
    if (out === n) out = n.slice(0, i)
    if (c === GONE && (n[0] === ';' || (n[0] === ',' && i < n.length - 1))) continue
    out.push(c)
  }
  return decide(out, test)
}

// What a function has of its own or by inheritance: a read of one of these names finds it.
const FUNCTION_MEMBERS = new Set(['length', 'name', 'prototype', 'call', 'apply', 'bind', 'caller', 'arguments', 'constructor', '__proto__',
  'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable'])
// The builtins that take a value and keep nothing of it: a lambda passed to one has the members it had.
const READS_ONLY = new Set(['__iter_arr'])

/** `body` with each read of a member no function has, off a lambda the body made and nothing could add one to, undefined. */
const lambdaMembers = (body) => {
  const made = new Map()   // name → its arrow
  const find = (n) => {
    if (!isArr(n) || n[0] === '=>' || n[0] === 'str') return
    if ((n[0] === 'const' || n[0] === 'let') && n.length >= 2) for (let i = 1; i < n.length; i++) { const d = n[i]; if (isArr(d) && d[0] === '=' && typeof d[1] === 'string' && isArr(d[2]) && d[2][0] === '=>') made.set(d[1], d[2]) }
    for (let i = 1; i < n.length; i++) find(n[i])
  }
  find(body)
  if (!made.size) return body
  const reads = new Set()   // the lambdas with a member read
  // every mention is a call of it, a read of a member, a `typeof`, or an argument of a builtin that keeps nothing
  const scan = (n, parent, at) => {
    if (typeof n === 'string') {
      if (!made.has(n)) return
      const p = parent?.[0]
      if (p === '()' && at === 1) return
      if ((p === '.' || p === '?.') && at === 1) { reads.add(n); return }
      if (p === 'typeof') return
      if ((p === 'const' || p === 'let' || p === '=') && at === 1) { if (p === '=') made.delete(n); return }
      made.delete(n)
      return
    }
    if (!isArr(n) || n[0] === 'str' || n[0] == null) return
    const op = n[0]
    if (op === '.' || op === '?.') { scan(n[1], n, 1); return }
    if (op === ':') { scan(n[2], n, 2); return }
    if (MUTATE_OPS.has(op) && isArr(n[1]) && (n[1][0] === '.' || n[1][0] === '?.' || n[1][0] === '[]') && typeof n[1][1] === 'string') made.delete(n[1][1])
    if (op === '[]' && typeof n[1] === 'string') made.delete(n[1])
    if (op === 'delete' && isArr(n[1]) && typeof n[1][1] === 'string') made.delete(n[1][1])
    if (op === '()' && typeof n[1] === 'string' && READS_ONLY.has(n[1])) { for (let i = 2; i < n.length; i++) if (typeof n[i] !== 'string') scan(n[i], n, i); return }
    if (op === '=' && typeof n[1] === 'string') { scan(n[1], n, 1); scan(n[2], n, 2); return }
    if (op === 'const' || op === 'let') { for (let i = 1; i < n.length; i++) { const d = n[i]; if (isArr(d) && d[0] === '=') { scan(d[1], ['const'], 1); scan(d[2], d, 2) } } return }
    for (let i = 1; i < n.length; i++) scan(n[i], n, i)
  }
  scan(body, null, 0)
  let any = false
  for (const name of reads) if (made.has(name)) any = true
  if (!any) return body
  const fold = (n) => {
    if (!isArr(n) || n[0] === 'str' || n[0] == null) return n
    if ((n[0] === '.' || n[0] === '?.') && typeof n[1] === 'string' && typeof n[2] === 'string' && made.has(n[1]) && reads.has(n[1]) && !FUNCTION_MEMBERS.has(n[2])) return [, undefined]
    let out = n
    for (let i = 1; i < n.length; i++) { const c = fold(n[i]); if (c !== n[i]) { if (out === n) out = n.slice(); out[i] = c } }
    return out
  }
  return fold(body)
}

// `n` with every read of a key of `to` its value; a store of one to itself and a declarator of one are gone.
const substitute = (n, to) => {
  if (typeof n === 'string') { const v = to.get(n); return v === undefined ? n : isArr(v) ? v.slice() : v }
  if (!isArr(n) || n[0] === 'str' || n[0] == null) return n
  const op = n[0]
  if (op === '=' && typeof n[1] === 'string' && to.has(n[1])) return substitute(n[2], to)
  if (op === '.' || op === '?.') { const o = substitute(n[1], to); return o === n[1] ? n : [op, o, ...n.slice(2)] }
  if (op === ':') { const v = substitute(n[2], to); return v === n[2] ? n : [op, n[1], v] }
  if (op === 'let' || op === 'const') {
    const out = [op]
    let same = true
    for (let i = 1; i < n.length; i++) {
      const d = n[i]
      if (typeof d === 'string') { if (to.has(d)) same = false; else out.push(d); continue }
      if (isArr(d) && d[0] === '=' && typeof d[1] === 'string') {
        if (to.has(d[1])) { same = false; continue }
        const v = substitute(d[2], to)
        if (v !== d[2]) same = false
        out.push(v === d[2] ? d : ['=', d[1], v])
        continue
      }
      const c = substitute(d, to)
      if (c !== d) same = false
      out.push(c)
    }
    return same ? n : out.length > 1 ? out : GONE
  }
  let out = n
  for (let i = 1; i < n.length; i++) {
    const c = substitute(n[i], to)
    if (c === n[i]) { if (out !== n) out.push(c); continue }
    if (out === n) out = n.slice(0, i)
    // A statement left as a bare name or as nothing is no statement of a list. In a
    // sequence a name is a value (an argument); only a declaration left empty goes,
    // and not from the last place, which is the sequence's value.
    if (op === ';' ? c === GONE || typeof c === 'string' || decider(c) : op === ',' && c === GONE && i < n.length - 1) continue
    out.push(c === GONE ? [';'] : c)
  }
  return out
}

const aliasesIn = (f) => {
  const body = f.body
  const params = new Set(f.sig.params.map(p => p.name))
  const declared = new Set(), defs = new Map(), bare = new Set(), written = new Set(), captured = new Set()
  const def = (name, v) => { let l = defs.get(name); if (!l) defs.set(name, l = []); l.push(v) }
  const scan = (n, inArrow) => {
    if (typeof n === 'string') { if (inArrow) captured.add(n); return }
    if (!isArr(n) || n[0] === 'str' || n[0] == null) return
    const op = n[0]
    if (op === '.' || op === '?.') { scan(n[1], inArrow); return }
    if (op === ':') { scan(n[2], inArrow); return }
    if (op === '=>') { scan(n[1], true); scan(n[2], true); return }
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (typeof d === 'string') { if (inArrow) captured.add(d); else { declared.add(d); bare.add(d) } }
        else if (isArr(d) && d[0] === '=' && typeof d[1] === 'string') {
          if (inArrow) captured.add(d[1]); else { declared.add(d[1]); def(d[1], d[2]) }
          scan(d[2], inArrow)
        } else scan(d, inArrow)
      }
      return
    }
    if (MUTATE_OPS.has(op) && typeof n[1] === 'string') {
      if (inArrow) { captured.add(n[1]); written.add(n[1]) }
      else if (op === '=') def(n[1], n[2])
      else written.add(n[1])
      for (let i = 2; i < n.length; i++) scan(n[i], inArrow)
      return
    }
    for (let i = 1; i < n.length; i++) scan(n[i], inArrow)
  }
  scan(body, false)
  if (f.defaults) for (const d of Object.values(f.defaults)) scan(d, true)

  const stable = (a) => !written.has(a) && (params.has(a) ? !defs.has(a) && a !== f.rest : declared.has(a) && !bare.has(a) && defs.get(a)?.length === 1)
  let assigned = null
  const to = new Map()
  for (const b of declared) {
    if (captured.has(b) || written.has(b) || params.has(b)) continue
    const l = defs.get(b)
    if (!l?.length) continue
    const a = l[0]
    if (typeof a === 'string' ? a === b || !l.every(v => v === a) || !stable(a) : !decider(a) || !l.every(v => decider(v) && JSON.stringify(v) === JSON.stringify(a))) continue
    if (bare.has(b) && !(assigned ??= definitelyAssigned(body)).has(b)) continue
    to.set(b, a)
  }
  if (!to.size) return body
  // a name that stands for one that stands for another reads the last
  for (const [b, a] of to) { let t = a, n = 0; while (typeof t === 'string' && to.has(t) && n++ < to.size) t = to.get(t); to.set(b, t) }
  return substitute(body, to)
}

/** Each list of each body split over the bindings it declares (prepare/split-bindings.js): a spliced
 *  call's statements are statements of its caller's lists. */
export const splitSplicedBindings = () => {
  if (ctx.transform.optimize?.splitBindings === false) return false
  let changed = false
  for (const f of ctx.funcs.list) {
    if (f.raw || !f.body) continue
    const body = splitReassigned(f, true)
    if (body !== f.body) { setFuncBody(f, body); changed = true }
  }
  return changed
}

export const resolveAliases = () => {
  let changed = false
  for (const f of ctx.funcs.list) {
    if (f.raw || !f.body || !isArr(f.body) || f.body[0] !== '{}') continue
    for (let round = 0; round < 8; round++) {
      const before = f.body
      let body = decided(lambdaMembers(before))
      if (body !== before) setFuncBody(f, body)
      body = decided(aliasesIn(f))
      if (body !== f.body) setFuncBody(f, body)
      if (f.body === before) break
      changed = true
    }
    // what a name stood for is read in its place: the name's own value has no reader
    const body = dropUnreadLocals(f.body)
    if (body !== f.body) { setFuncBody(f, body); changed = true }
  }
  return changed
}
