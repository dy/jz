// An assignment that is a statement of a function's own list declares its value
// as a binding of its own, which the statements after it read
// (src/prepare/split-bindings.js, pass `splitBindings`). Each binding then holds
// one value and has its kind: an integer assigned after a float is an integer, a
// parameter the list reassigns is never written. A write nested in the list (an
// arm, a loop) assigns the binding of its place; a binding a closure names stays
// whole. Both forms answer what the host answers.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { T } from '../src/ast.js'
import { splitReassigned } from '../src/prepare/split-bindings.js'
import { parse } from '../src/parse.js'
import { belowOpt, levels } from './_matrix.js'
import { compile } from '../index.js'
import { oracle, run, wat } from './util.js'

const ARGS = [[1, 3], [5, 3], [-2, 3], [0.5, -7], [1e3, 0]]

const programs = {
  'a split binding split again after folding an arm': 'export let f = (x, y) => { y = -x; let v = y; if (Math.round(3)) { y = v ? 0 : v } else { y = 0 } return ~y }',
  'a split binding split again with its old value still live': 'export let f = (x, y) => { y = -x; let v = y; if (Math.round(3)) { y = v ? x + 1 : v } else { y = 0 } return y + v }',
  'a parameter reassigned, compounds after it': 'export let f = (x, y) => { x = x < 0 ? -x : x; y += x; x *= 2; return x + y }',
  'a float, then its integer part, then a shift': 'export let f = (x) => { let y = x * 0.5; y = y | 0; y = y >>> 3; return y }',
  'a binding declared bare, assigned after': 'export let f = (x) => { let h; h = x | 0; h &= 0xff; return h }',
  'a hash: xor, shift and imul in turn': 'export let f = (x) => { let h = x | 0; h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0 }',
  'every compound operator': 'export let f = (x, y) => { let a = x; a += y; a -= 1; a *= 3; a /= 2; a %= 7; a **= 2; let b = x | 0; b &= 0xffff; b |= 0x10; b ^= 0x3; b <<= 2; b >>= 1; b >>>= 1; return a * 1e6 + b }',
  'a swap through a third': 'export let f = (a, b) => { let t = a; a = b; b = t; return a * 10 + b }',
  'a loop after the assignment writes the new binding': 'export let f = (n) => { let s = 0; s = n * 2; for (let i = 0; i < 4; i++) s += i; s = s + 1; return s }',
  'an arm after the assignment writes the new binding': 'export let f = (x, y) => { let r = x; r = r * 2; if (y > 0) r = r + y; else r -= 1; r += 0.5; return r }',
  'an assignment inside an expression': 'export let f = (x) => { let y = 0; y = x + 1; let z = (y = y * 2) + y; y += z; return y }',
  'a pattern assignment between two': 'export let f = (a, b) => { a = a + 1; [a, b] = [b, a]; b -= 1; return a * 10 + b }',
  'try, catch and finally': 'export let f = (x) => { let r = 0; r = x * 2; try { if (x > 3) throw 1; r += 1 } catch (e) { r = -r } finally { r += 100 } r *= 2; return r }',
  'a labeled loop': 'export let f = (x) => { let s = 0; s = x; out: for (let i = 0; i < 5; i++) { for (let j = 0; j < 5; j++) { if (j > x) continue out; s += 1 } } s = s * 2; return s }',
  'a string, then its length': 'export let f = (x) => { let v = "a" + x; v = v.length; v = v * 2; return v }',
  'a number, then a string of it': 'export let f = (x) => { let v = x * 2; v = "n" + v; v = v + "!"; return v }',
  'an absent value, then its default': 'export let f = (x) => { let u; u = x > 0 ? 1 : undefined; u = u ?? 7; return u }',
  'a key and a property of its name': 'export let f = (x) => { x = x + 1; const o = { x: 5, y: x }; return o.x * 100 + o.y }',
  'a shorthand property': 'export let f = (x) => { x = x + 1; const o = { x }; return o.x }',
  'a default that reads a parameter reassigned': 'const g = (a, b = a + 1) => { a = a * 2; return a + b }\nexport let f = (x) => g(x) + g(x, 1)',
  'a rest parameter reassigned': 'const g = (a, ...r) => { r = r.length; a += r; return a }\nexport let f = (x) => g(x, 1, 2)',
  'a generator between its yields': 'function* g(x) { x = x + 1; yield x; x = x * 2; yield x }\nexport let f = (x) => { let s = 0; for (const v of g(x)) s = s * 100 + v; return s }',
  'a callee with a loop that reads the argument': 'const acc = (v, n) => { let r = 0; for (let i = 0; i < n; i++) r = r + v; return r }\nexport let f = (x, y) => { x = acc(x, 3); y = acc(y, 2) + x; return x * 100 + y }',
  'a callee that returns out of its loop': 'const first = (v) => { for (let i = 1; i < 5; i++) { if (v * i > 4) return v * i } return v }\nexport let f = (x) => { x = first(x); x = first(x) + 1; return x }',
  'a loop that rereads the binding it writes': 'export let f = (x, y) => { let s = x; s = s * 2; let t = 0; for (let i = 0; i < 3; i++) { t += s; s = s + y } s = t + s; return s }',
  'a callee of a parameter reassigned': 'function helper(u) { if (u > 100) { return helper(u - 100) } return u + 1 }\nfunction half(v) { v = v * 0.5; return helper(v) }\nexport let f = (a) => half(a)',
}

// A closure reads the cell its calls share: an assignment after it is made reaches it.
const captured = {
  'a closure made before the assignment': 'export let f = (x) => { let a = 1; const g = () => a; a = x; return g() }',
  'a closure made between two assignments': 'export let f = (x) => { let a = 1; a = x + 1; const g = () => a; a = a * 2; return g() }',
  'a closure that writes': 'export let f = (x) => { let a = 1; const inc = () => { a += 1 }; inc(); a = a + x; inc(); return a }',
  'a closure over a parameter': 'export let f = (x) => { const g = () => x * 2; x = x + 1; return g() }',
  'a closure made in a loop': 'export let f = (x) => { let a = 0; const gs = []; for (let i = 0; i < 3; i++) gs.push(() => a + i); a = x; return gs[2]() }',
}

const agreeAll = (table, opts) => {
  for (const [name, src] of Object.entries(table)) {
    const host = oracle(src)
    for (const optimize of levels(0, 2, 3)) {
      const m = run(src, { optimize: opts ? { level: optimize, ...opts } : optimize })
      for (const args of ARGS) is(m.f(...args), host.f(...args), `${name} at ${optimize}: f(${args.join(', ')})`)
    }
  }
}

test('split bindings: a list of reassignments answers what the host answers', () => agreeAll(programs))
test('split bindings: a binding a closure names is one cell', () => agreeAll(captured))
test('split bindings: the bindings left whole answer the same', () => agreeAll({ ...programs, ...captured }, { splitBindings: false }))

test('split bindings: an integer assigned after a float is held as one', () => {
  if (belowOpt(2)) return
  const src = programs['a float, then its integer part, then a shift']
  // the float converts once; whole, the binding is a float and every integer crosses it
  const conversions = (text) => (text.match(/i64\.trunc_sat_f64_s/g) || []).length
  const split = wat(src, { optimize: 3 }), whole = wat(src, { optimize: { level: 3, splitBindings: false } })
  is(conversions(split), 1, 'one conversion from the float')
  is((split.match(/f64\.convert_i32_[su]/g) || []).length, 1, 'only the export converts back to Number')
  ok(/\(f64\.convert_i32_[su]\s+\(i32\.shr_u/.test(split), 'the final shift stays integer through the export conversion')
  ok(conversions(whole) > 1, 'the binding left whole converts again')
})

test('split bindings: a parameter the list reassigns reads its constant argument', () => {
  if (belowOpt(2)) return
  const src = 'const step = (x, k) => { k = k + 1; return x * k }\nexport const a = (x) => step(x, 7)\nexport const b = (x) => step(x, 7) + 1'
  const text = wat(src, { optimize: 3 })
  ok(/f64\.const 8\b/.test(text), 'k + 1 is 8')
  ok(!/\$k\b/.test(text), 'no parameter k is left')
  const host = oracle(src), m = run(src, { optimize: 3 })
  for (const x of [0, 1.5, -3]) { is(m.a(x), host.a(x), `a(${x})`); is(m.b(x), host.b(x), `b(${x})`) }
})

// What an exported parameter is used as is read off the split bindings: a read as a
// string flows back through the sum that made the value (src/summary demand, `STR`).
const strings = {
  'doubled, then sliced': 'export let f = (s) => { let x = s; x = x + x; x = x.slice(1); return x }',
  'a prefix added, then its length': 'export let f = (s, t) => { let x = s; x = t + x; x = x + "!"; return x.length }',
  'joined with a second, then searched': 'export let f = (s, t) => { let x = s; x += t; return x.indexOf("b") * 10 + x.charCodeAt(0) }',
  'through a helper that slices': 'const tail = (v) => v.slice(1)\nexport let f = (s) => { let x = s; x = x + x; return tail(x) }',
  'a copy of a sum, upper case': 'export let f = (s, t) => { let x = s + t; let y = x; y = y.toUpperCase(); return y }',
}

test('split bindings: a parameter read as a string through a sum is one', () => {
  for (const [name, src] of Object.entries(strings)) {
    const host = oracle(src)
    for (const optimize of levels(0, 2, 3)) {
      const m = run(src, { optimize })
      for (const args of [['ab', 'cd'], ['+1_000', 'b'], ['', 'xyz'], ['b', '']]) is(m.f(...args), host.f(...args), `${name} at ${optimize}: f(${args.map(a => JSON.stringify(a)).join(', ')})`)
    }
  }
})

// A parameter never read as a string is a number at the boundary (README, "Numeric export
// parameters"), whatever the level: the split is a form of the source, no pass of a level.
test('split bindings: the boundary reads a parameter the same at every level', () => {
  const src = 'export let f = (s) => { let x = s; x = x + x; return x }\nexport let g = (a, b) => { a = a + 1; b += a; return a + b }'
  const at = (optimize) => { const m = run(src, { optimize }); return [m.f('ab'), m.f(3), m.f('7'), m.g(1, 2), m.g('1', '2')] }
  const base = at(0)
  for (const optimize of [1, 2, 3, 'size']) is(at(optimize), base, `level ${optimize} answers as level 0`)
  is(base[1], 6, 'a number doubles')
})

// A binding of the type of the one it continues takes its slot
// (src/optimize/split-slots.js): the split costs no local and no byte.
test('split bindings: a binding of its predecessor\'s type takes its slot', () => {
  if (belowOpt(2)) return
  const rows = {
    'a parameter made a number': 'export let f = x => { x = +x; if (x > 0) return x; else return -x }',
    'two parameters made numbers': 'let mul = (x, y) => x * y\nexport let f = (x, y) => { x = +x; y = +y; return mul(x, y) + 1 }',
    'a count made a number before its loop': 'export let f = n => { n = +n; let s = 0; for (let i = 0; i < n; i++) s += i; return s }',
    'a float scaled in turn': 'export let f = (x) => { let y = x * 0.5; y = y + 1; y = y * y; return y }',
  }
  for (const [name, src] of Object.entries(rows)) {
    for (const level of ['size', 3]) {
      const text = wat(src, { optimize: level })
      ok(!new RegExp(`\\(local \\$\\w*${T}s\\d+ `).test(text), `${name} at ${level}: no local of the split`)
    }
    is(compile(src, { optimize: 'size' }).length, compile(src, { optimize: { level: 'size', splitBindings: false } }).length, `${name}: the bytes of the binding left whole`)
  }
})

// The transformation on a body: [the parameters, the statements, the statements it leaves].
const lit = (v) => [, v]
const N = (name, k) => `${name}${T}s${k}`
const bodies = {
  'an assignment declares, the rest reads it': [['x'],
    [['=', 'x', ['*', 'x', lit(2)]], ['return', 'x']],
    [['let', ['=', N('x', 0), ['*', 'x', lit(2)]]], ['return', N('x', 0)]]],
  'a compound reads the binding before it': [['x'],
    [['let', ['=', 'a', lit(1)]], ['+=', 'a', 'x'], ['>>>=', 'a', lit(3)], ['return', 'a']],
    [['let', ['=', 'a', lit(1)]], ['let', ['=', N('a', 0), ['+', 'a', 'x']]], ['let', ['=', N('a', 1), ['>>>', N('a', 0), lit(3)]]], ['return', N('a', 1)]]],
  'a nested write assigns the binding of its place': [['x', 'c'],
    [['=', 'x', ['+', 'x', lit(1)]], ['if', 'c', ['=', 'x', lit(0)]], ['return', 'x']],
    [['let', ['=', N('x', 0), ['+', 'x', lit(1)]]], ['if', 'c', ['=', N('x', 0), lit(0)]], ['return', N('x', 0)]]],
  'a property and a key of the name stay': [['x', 'o'],
    [['=', 'x', ['.', 'o', 'x']], ['return', ['{}', [':', 'x', 'x']]]],
    [['let', ['=', N('x', 0), ['.', 'o', 'x']]], ['return', ['{}', [':', 'x', N('x', 0)]]]]],
  'a binding a closure names stays': [['x'],
    [['let', ['=', 'g', ['=>', [], 'x']]], ['=', 'x', lit(1)], ['return', ['()', 'g']]],
    null],
  'a binding of the module stays': [['x'],
    [['=', 'G', ['+', 'x', lit(1)]], ['return', 'G']],
    null],
  'a store to a member stays': [['o'],
    [['=', ['.', 'o', 'v'], lit(1)], ['return', 'o']],
    null],
}

test('split bindings: the statements it leaves', () => {
  for (const [name, [params, list, want]] of Object.entries(bodies)) {
    const body = ['{}', [';', ...list]]
    const out = splitReassigned({ body, sig: { params: params.map(p => ({ name: p })) } })
    if (want === null) is(out, body, `${name}: the body itself`)
    else is(JSON.stringify(out), JSON.stringify(['{}', [';', ...want]]), name)
  }
})

test('split bindings: statement renaming takes linear work', () => {
  for (const count of [0, 1, 128]) {
    let reads = 0
    const value = new Proxy(['[]', 'a', lit(0)], {
      get(target, key, receiver) {
        if (key === '0' || key === '1' || key === '2') reads++
        return Reflect.get(target, key, receiver)
      }
    })
    const list = [';', ['let', ['=', 'sum', lit(0)]]]
    for (let i = 0; i < count; i++) {
      const stmt = ['+=', 'sum', value]
      stmt.loc = i + 10
      list.push(stmt)
    }
    list.push(['return', 'sum'])
    const body = ['{}', list], before = JSON.stringify(body)
    reads = 0
    const out = splitReassigned({ body, sig: { params: [{ name: 'a' }] } })
    // Every assignment used to rename the whole remaining suffix: 65,792
    // reads at 128 statements. Allow a constant number of visits per node.
    ok(reads <= count * 32 + 32, `${count} reassignments: bounded traversal (${reads} reads)`)
    const want = [';', list[1]]
    for (let i = 0; i < count; i++) want.push(['let', ['=', N('sum', i), ['+', i ? N('sum', i - 1) : 'sum', value]]])
    want.push(['return', count ? N('sum', count - 1) : 'sum'])
    is(JSON.stringify(out), JSON.stringify(['{}', want]), `${count} reassignments: every RHS reads its predecessor`)
    is(JSON.stringify(body), before, `${count} reassignments: input is unchanged`)
    for (let i = 0; i < count; i++) {
      is(out[1][i + 2].loc, i + 10, 'rewritten statement retains its position')
      ok(out[1][i + 2][1][2][2] === value, 'unchanged indexed read retains its identity')
    }
  }
})

test('split bindings: repeated and changed compilations preserve effects and prior modules', () => {
  const source = count => `
    let calls = 0
    function key() { calls++; return 0 }
    export function f(x) {
      calls = 0
      const a = new Float64Array(1)
      a[0] = x
      let sum = 0
      ${'sum += a[key()];'.repeat(count)}
      return sum
    }
    export function effects() { return calls }
  `
  const retained = []
  for (const count of [0, 1, 32, 32, 7, 32]) {
    if (count === 7) throws(() => compile('export function f( {'), /./, 'a failed compile between repeated inputs')
    const m = run(source(count))
    retained.push([m, count])
    for (const x of [0, 3, -2]) {
      is(m.f(x), count * x || 0, `${count} indexed additions of ${x}`)
      is(m.effects(), count, 'each key is evaluated once, including zero work')
    }
  }
  for (const [m, count] of retained) {
    is(m.f(5), count * 5, 'an earlier module still computes its own body')
    is(m.effects(), count, 'an earlier module keeps its own effects')
  }
})

// The lists inside a body (`nested`, after the splices): [the parameters, the body, the body wanted or null for the body itself]
const s = (name, k) => `${name}${T}s${k}`
const loop = (...stmts) => ['for', ['let', ['=', 'i', lit(0)]], ['<', 'i', 'n'], ['++', 'i'], ['{}', [';', ...stmts]]]
const inside = {
  'a body that is a loop alone': [['n', 'y'],
    ['{}', loop(['let', ['=', 'v', 'i']], ['=', 'v', ['+', 'v', 'y']], ['=', ['[]', 'out', 'i'], 'v'])],
    ['{}', [';', loop(['let', ['=', 'v', 'i']], ['let', ['=', s('v', 0), ['+', 'v', 'y']]], ['=', ['[]', 'out', 'i'], s('v', 0)])]]],
  'a binding declared bare ahead of the list that alone mentions it': [['n', 'y'],
    ['{}', [';', ['let', 'o'], loop(['=', 'o', ['*', 'i', 'y']], ['=', ['[]', 'out', 'i'], 'o'])]],
    ['{}', [';', ['let', 'o'], loop(['let', ['=', s('o', 0), ['*', 'i', 'y']]], ['=', ['[]', 'out', 'i'], s('o', 0)])]]],
  'assigned twice in the list': [['n', 'y'],
    ['{}', [';', ['let', 'o'], loop(['=', 'o', 'y'], ['=', 'o', ['+', 'o', 'i']], ['=', ['[]', 'out', 'i'], 'o'])]],
    ['{}', [';', ['let', 'o'], loop(['let', ['=', s('o', 0), 'y']], ['let', ['=', s('o', 1), ['+', s('o', 0), 'i']]], ['=', ['[]', 'out', 'i'], s('o', 1)])]]],
  'read in the list ahead of its assignment': [['n', 'y'],
    ['{}', [';', ['let', 'o'], loop(['=', ['[]', 'out', 'i'], 'o'], ['=', 'o', ['*', 'i', 'y']])]],
    null],
  'assigned from itself': [['n', 'y'],
    ['{}', [';', ['let', 'o'], loop(['=', 'o', ['+', 'o', 'y']], ['=', ['[]', 'out', 'i'], 'o'])]],
    null],
  'assigned by a compound': [['n', 'y'],
    ['{}', [';', ['let', 'o'], loop(['+=', 'o', 'y'], ['=', ['[]', 'out', 'i'], 'o'])]],
    null],
  'read after the list': [['n', 'y'],
    ['{}', [';', ['let', 'o'], loop(['=', 'o', ['*', 'i', 'y']], ['=', ['[]', 'out', 'i'], 'o']), ['return', 'o']]],
    null],
  'declared with a value': [['n', 'y'],
    ['{}', [';', ['let', ['=', 'o', lit(1)]], loop(['=', 'o', ['*', 'i', 'y']], ['=', ['[]', 'out', 'i'], 'o'])]],
    null],
  'a parameter': [['n', 'y'],
    ['{}', [';', loop(['=', 'y', ['*', 'i', lit(2)]], ['=', ['[]', 'out', 'i'], 'y'])]],
    null],
  'a closure mentions it': [['n', 'y'],
    ['{}', [';', ['let', 'o'], loop(['=', 'o', ['*', 'i', 'y']], ['=', ['[]', 'out', 'i'], ['()', ['=>', [], 'o']]])]],
    null],
}

test('split bindings: the lists inside a body', () => {
  for (const [name, [params, body, want]] of Object.entries(inside)) {
    const out = splitReassigned({ body, sig: { params: params.map(p => ({ name: p })) } }, true)
    if (want === null) is(out, body, `${name}: the body itself`)
    else is(JSON.stringify(out), JSON.stringify(want), name)
  }
  const lone = inside['a body that is a loop alone'][1]
  is(splitReassigned({ body: lone, sig: { params: [{ name: 'n' }, { name: 'y' }] } }), lone, 'the function\'s own list alone: a body of one statement has none to split')
})

// A statement the pass rewrites (the declaration it makes, the ones it renames the binding in) keeps the position the parser noted (`loc`): a source map reads it.
test('split bindings: a rewritten statement keeps its source position', () => {
  const fn = parse('function f(x) { let y = x + 2; y = y * x; if (y > 5) { y = y - 1 } return y }')
  const before = fn[3].slice(1).map(st => st.loc)
  const out = splitReassigned({ body: ['{}', fn[3]], sig: { params: [{ name: 'x' }] } })
  const list = out[1]
  is(list.length, fn[3].length, 'one statement per statement')
  ok(list[2][0] === 'let' && list[2][1][1].startsWith('y'), 'the reassignment became a declaration')
  is(list.slice(1).map(st => st.loc), before, 'every statement, the declaration too, at the position of the one it stands for')
  const positioned = (n) => !Array.isArray(n) || n[0] == null || (typeof n.loc === 'number' && n.slice(1).every(positioned))
  ok(list.slice(3).every(positioned), 'the statements renamed inside keep every node\'s position')
})
