// A primitive beside an array (a parser's token or node, STRING|ARRAY): the
// summary keeps the array's cell through the join and answers a method on the
// union kind by kind (src/summary/index.js `primArray`, `method`). Each program
// runs against Node: a read, a store, a method, a spread or an iteration
// through the union reaches the array as the array does, the primitive as itself.
import test from 'tst'
import { is } from 'tst/assert.js'
import jz from '../index.js'
import { levels } from './_matrix.js'
import { oracle } from './util.js'

// A fresh module on each side per level: a program may keep state across calls.
const agreeAll = (src, seeds, label) => {
  for (const optimize of levels(0, 2, 3, 'size')) {
    const host = oracle(src), names = Object.keys(host), ex = jz(src, { optimize }).exports
    for (const name of names) for (const n of seeds) {
      let want, got
      try { want = String(host[name](n)) } catch { want = 'throws' }
      try { got = String(ex[name](n)) } catch { got = 'throws' }
      is(got, want, `O${optimize} ${label} ${name}(${n})`)
    }
  }
}

test('union kinds: a token-or-node through methods, reads, a tree walk and a work stack', () => {
  agreeAll(`const tok = (i) => (i % 3) === 0 ? 'ab' + i : [i, 'x' + i, [i + 1]]
  export const methods = (n) => {
    let s = 0
    for (let i = 0; i < n; i++) {
      const x = tok(i), t = x.slice(1)
      s += t.length + x.indexOf(i % 2 ? 'b' : i) + (x.includes('x' + i) ? 7 : 0) + String(x.at(-1)).length + x.concat('z').length
    }
    return s
  }
  export const arrayOnly = (n) => {
    let s = 0
    for (let i = 0; i < n; i++) {
      const x = tok(i)
      if (Array.isArray(x)) { const y = x.slice(); y.push(i); s += y.length + y.reverse()[0] + x.join('-').length }
      else s += x.toUpperCase().length
    }
    return s
  }
  const parse = (str) => {
    let i = 0
    const level = () => {
      const out = []
      let start = -1
      while (i < str.length) {
        const c = str.charCodeAt(i)
        if (c === 40) { if (start >= 0) { out.push(str.slice(start, i)); start = -1 } i++; out.push(level()) }
        else if (c === 41) { if (start >= 0) out.push(str.slice(start, i)); i++; return out }
        else if (c === 32) { if (start >= 0) { out.push(str.slice(start, i)); start = -1 } i++ }
        else { if (start < 0) start = i; i++ }
      }
      if (start >= 0) out.push(str.slice(start, i))
      return out
    }
    const r = level()
    return r.length === 1 ? r[0] : r
  }
  const walk = (node, depth) => {
    if (typeof node === 'string') return node.length * depth
    let s = node.length
    for (const child of node) s += walk(child, depth + 1)
    const [head, ...rest] = node
    return s + (typeof head === 'string' ? head.charCodeAt(0) : 1) + rest.length
  }
  const flatten = (node, out) => { if (Array.isArray(node)) { for (let k = 0; k < node.length; k++) flatten(node[k], out) } else out.push(node); return out }
  export const tree = (n) => {
    let s = 0
    for (let i = 0; i < n; i++) {
      const ast = parse('(module (func $f (param i32) (result i32) (i32.add (local.get 0) (i32.const ' + i + '))) (memory 1))')
      s += walk(ast, 1) + flatten(ast, []).length + (Array.isArray(ast) ? ast[0].length : 0)
      s += (Array.isArray(ast) ? [...ast] : [ast]).length
    }
    return s
  }
  export const mixedNumber = (n) => {
    let s = 0
    for (let i = 0; i < n; i++) {
      const v = i % 2 ? i : [i, i * 2]
      s += typeof v === 'number' ? v.toFixed(1).length : v[1] + v.length
      const w = i % 5 ? [i] : 'q'
      s += w.length + (w[0] === 'q' ? 3 : w[0])
    }
    return s
  }
  const stack = (nodes) => { const stk = nodes.slice().reverse(); let s = 0; while (stk.length) { const x = stk.pop(); s += typeof x === 'string' ? x.length : Array.isArray(x) ? (stk.push(...x), 1) : x } return s }
  export const work = (n) => { let s = 0; for (let i = 0; i < n; i++) s += stack(i % 2 ? ['a', ['bb', ['ccc', i]], i] : ['xyz' + i, i]); return s }`, [0, 1, 7, 13], 'battery')
})

// A cell one kind's method builds at the call (an array's slice) is not the
// call's value when the receiver may be a string (summary `joinedCalls`).
test('union kinds: a method call on the union is the join of each kind\'s call, not the array arm\'s construction', () => {
  agreeAll(`const pick = (i) => (i & 1) ? 'abcd' : ['a', 'b', 'c', 'd']
  export const f1 = (n) => { const x = pick(n), y = x.slice(1); return y[0] + y.length }
  export const f2 = (n) => pick(n).slice(1)[1]
  export const f3 = (n) => { const y = pick(n).concat('z'); return y.length + String(y[y.length - 1]) }
  export const f4 = (n) => { let s = 0; for (const c of pick(n).slice(1)) s += c.length; return s }
  export const f5 = (n) => { const y = pick(n).slice(1); return typeof y === 'string' ? y.toUpperCase() : y.join('-') }
  export const f6 = (n) => { const y = pick(n).slice(0, 2); return Array.isArray(y) ? y.length * 10 : y.length }
  export const f7 = (n) => { const x = pick(n); return x.at(-1) + x.indexOf('c') }
  export const f8 = (n) => { const z = pick(n).slice(1).slice(1); return z.length + (z[0] ?? 'u') }
  const tail = (x) => x.slice(1)
  export const loop = (n) => { let s = 0; for (let i = 0; i < 200 + n; i++) { const x = pick(i), t = tail(x); s += t.length + x.indexOf('c') + (x.includes('d') ? 1 : 0) } return s }`, [0, 1, 7, 13], 'call')
})

// A number joined with an array: the count holds until a resize reaches the
// cell through the join, and the reads see both kinds.
test('union kinds: a resize through the join reaches the array', () => {
  agreeAll(`const a = [1, 2, 3]
  export const push = (n) => { const v = n & 1 ? a : 5; if (v !== 5) v.push(n); return a.length + a[a.length - 1] }
  export const cut = (n) => { const b = [1, 2, 3, 4], v = n & 1 ? b : 'x'; if (typeof v !== 'string') v.length = 1; return b.length + String(v[0]) }
  const g = (v) => { if (Array.isArray(v)) v.pop(); return 0 }
  export const passed = (n) => { const b = [1, 2, 3]; return g(n & 1 ? b : 7) + b.length }
  export const held = (n) => { const b = [1, 2, 3], h = [n & 1 ? b : 'q'], e = h[0]; if (Array.isArray(e)) e.length = 1; return b.length + e.length }`, [0, 1, 7, 13], 'resize')
})
