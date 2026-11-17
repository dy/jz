// A function's properties are the function value's own: they live in the table
// its pointer keys (module/collection.js __dyn_set), so a function read as a
// value stays callable, `typeof` says 'function', and every name for it sees
// one set of properties. Where the function never escapes, the plan dissolves
// them into module globals (plan/scope.js flattenFuncNamespaces).
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { levels, belowOpt, onWasi, onKernel } from './_matrix.js'
import { oracle, jz, compile } from './util.js'

const show = (v) => JSON.stringify(v, (k, x) => x === undefined ? '<undefined>' : x)
const agree = (cases) => {
  for (const [name, src, ...args] of cases) for (const optimize of levels(0, 2, 3))
    is(show(jz(src, { optimize }).exports.f(...args)), show(oracle(src).f(...args)), `${name} O${optimize}`)
}

test('function properties: a function with a property stays a function read as a value', () => agree([
  ['called through a binding', `function g(x) { return g.k * x }\nlet set = () => { g.k = 3 }\nexport let f = () => { set(); let v = g; return v(4) }`],
  ['a property set at the top', `function g(x) { return g.k * x }\ng.k = 3\nexport let f = () => { let v = g; return [typeof v, v.k, v(4)] }`],
  ['typeof by name', `function g(x) { return x * 2 }\ng.k = 3\nexport let f = () => [typeof g, g.k, g(4)]`],
  ['an arrow at the top', `let g = (x) => g.k * x\ng.k = 3\nexport let f = () => { let v = g; return v(4) }`],
  ['a callback', `function g(x) { return g.k * x }\ng.k = 3\nexport let f = () => [1, 2].map(g)`],
  ['in a literal', `function g(x) { return g.k * x }\ng.k = 3\nlet o = () => ({ g })\nexport let f = () => [o().g(4), o().g.k, typeof o().g]`],
  ['in an array', `function g(x) { return x }\ng.k = 3\nlet arr = [g]\nexport let f = () => [arr[0].k, arr[0](5), typeof arr[0]]`],
  ['stored through an alias', `function g(x) { return x }\ng.k = 3\nexport let f = () => { let h = g; h.k = 7; return [g.k, h.k] }`],
  ['a counter', `function g(x) { return x }\ng.count = 0\nlet inc = () => { g.count++ }\nexport let f = () => { inc(); inc(); let v = g; return [g.count, v.count] }`],
  ['a computed key', `function g(x) { return x }\ng.k = 3\nexport let f = (key) => [g[key], g.k, 'k' in g, 'z' in g]`, 'k'],
  ['an argument', `function g(x) { return x }\ng.k = 3\nlet h = (fn) => fn.k\nexport let f = () => h(g)`],
]))

test('function properties: a namespace written inside functions reads as module globals', () => {
  const src = `function g(x) { return g.k * x }\nlet set = () => { g.k = 3 }\nexport let f = () => { set(); return g(4) }`
  for (const optimize of levels(0, 2, 3)) is(jz(src, { optimize }).exports.f(), 12, `O${optimize}`)
  if (belowOpt(2)) return
  ok(!/\$__dyn_(get|set)/.test(compile(src, { wat: true })), 'no property table')
})

test('function properties: a function lists no properties to Object.keys, as a closure does not', () => {
  throws(() => compile(`function g(x) { return x }\ng.k = 3\nexport let f = () => Object.keys(g)`), /Object\.keys\/getOwnPropertyNames on a function value is not supported/)
})

test('function properties: a lazily imported module sets a property on its own function', async () => {
  if (onWasi() || onKernel()) return   // the promise crosses to the host
  const modules = { './m.js': `export function g(x) { return g.k * x }\ng.k = 3\nexport let set = () => { g.k = 5 }` }
  for (const optimize of levels(0, 2, 3)) {
    const { f } = jz(`export let f = async () => { const m = await import('./m.js'); const a = m.g(4) + m.g.k; m.set(); return [a, m.g(2)] }`, { modules, optimize }).exports
    is(await f(), [15, 10], `O${optimize}`)
  }
})

// A property written once at top level with a function (`kw.scale = function`)
// is the function prepare lifted (`kw$scale`): a call of it is a direct call
// from the plan on, so its parameters take their callers' kinds.
test('function properties: a call of a property defined once is a call of its function', () => {
  const src = `const kw = function (d) { return d }
    kw.scale = function (a, k) { let s = 0; for (let i = 0; i < a.length; i++) { s += a[i] * k; if (s > 1e9) s = 0 } return s }
    let A = new Float32Array(16)
    for (let i = 0; i < 16; i++) A[i] = i * 0.25
    export let f = (k) => kw.scale(A, k) + kw.scale(A, 2)`
  const want = oracle(src).f(3)
  for (const optimize of levels(0, 2, 3)) is(jz(src, { optimize }).exports.f(3), want, `O${optimize}`)
  if (belowOpt(2)) return
  ok(!/\$__typed_idx/.test(compile(src, { wat: true, optimize: { sourceInline: false, inlineFns: false } })), 'the element reads take the callers\' Float32Array')
})

// A property defined once that is also read as a value (`parse.prop && parse.prop(x)`,
// subscript's keyword guard) is a module global its one store writes: undefined
// where it is read before the store runs, the function after; its calls stay direct.
test('function properties: a property read as a value and called reads a global, undefined before its store', () => {
  const src = `function parse(x) { return parse.prop ? parse.prop(x) : -1 }
    const before = parse(3)
    parse.prop = (x) => x * 2
    const after = parse(3)
    export let f = (x) => [before, after, parse(x), parse.prop && parse.prop(x + 1)]`
  // only tested (a condition, `!`, a chain a test reads): the global holds 1, the
  // function a callee alone; read as a value (`typeof`, `||`'s result), it holds the function
  const tested = `function parse(x) { return parse.prop ? parse.prop(x) : -1 }
    const before = [parse(3), !parse.prop, (parse.prop && 2) || 3]
    parse.prop = (x) => x * 2
    export let f = (x) => [before, parse(x), !parse.prop, (parse.prop && 2) || 3, parse.prop && parse.prop(x)]`
  const valued = `function parse(x) { return parse.prop ? parse.prop(x) : -1 }
    parse.prop = (x) => x * 2
    export let f = (x) => [parse(x), typeof parse.prop, typeof (parse.prop || 0)]`
  agree([['before and after its store', src, 5], ['a fraction', src, 0.5], ['only tested', tested, 4], ['read as a value', valued, 4]])
  if (belowOpt(2)) return
  ok(!/\$__dyn_(get|set)/.test(compile(src, { wat: true })), 'no property table')
})

// A namespace property becomes a module global; read while the module initializes,
// ahead of its first store, it is undefined there.
test('function properties: a property read during initialization before its first store is undefined', () => agree([
  ['stored twice', `function parse(x) { return parse.p ? parse.p(x) : -1 }\nconst before = parse(3)\nparse.p = (x) => x * 2\nparse.p = (x) => x * 3\nconst after = parse(3)\nexport let f = (x) => [before, after, parse(x)]`, 5],
  ['through a callback', `function parse(x) { return parse.p ? parse.p(x) : -1 }\nconst before = [3].map((x) => parse(x))[0]\nparse.p = (x) => x * 2\nparse.p = (x) => x * 4\nexport let f = (x) => [before, parse(x)]`, 5],
  ['through a closure an object holds', `function parse(x) { return parse.p ? parse.p(x) : -1 }\nconst o = { run: (x) => parse(x) }\nconst before = o.run(3)\nparse.p = (x) => x * 2\nparse.p = (x) => x * 4\nexport let f = (x) => [before, o.run(x)]`, 5],
  ['a first store by ??=', `function g() { return g.cfg.k }\ng.cfg ??= { k: 4 }\nexport let f = () => [g(), g.cfg.k]`],
  ['through a getter', `function parse(x) { return parse.p ? parse.p(x) : -1 }\nclass P { get v() { return parse(3) } }\nconst before = new P().v\nparse.p = (x) => x * 2\nparse.p = (x) => x * 4\nexport let f = (x) => [before, parse(x)]`, 5],
  ['through a conversion', `function parse(x) { return parse.p ? parse.p(x) : -1 }\nclass Q { valueOf() { return parse(3) } }\nconst before = new Q() + 0\nparse.p = (x) => x * 2\nparse.p = (x) => x * 4\nexport let f = (x) => [before, parse(x)]`, 5],
]))

// The builtin calls initialization makes ahead of a property's first store: a
// method of an element, of an assignment's or a choice's value, of a receiver
// holding an own member of the name, a for-of, an object a builtin calls a
// member of. Each but the last two reaches the reader, so the property is
// undefined there; the last two run nothing of the program.
test('function properties: initialization reaches a reader through a builtin call on an element, a choice or an own member', () => {
  const p = `function parse(x) { return parse.p ? parse.p(x) : -1 }\n`, after = `parse.p = (x) => x * 2\nparse.p = (x) => x * 4\n`
  agree([
    ['an element\'s method', p + `const hs = [{ run: (x) => parse(x) }]\nconst before = hs[0].run(3)\n` + after + `export let f = (x) => [before, hs[0].run(x)]`, 5],
    ['an element of a table built by stores', p + `const by = []\nby[2] = { run: (x) => parse(x) }\nconst before = by[2].run(3)\n` + after + `export let f = (x) => [before, by[2].run(x)]`, 5],
    ['an assignment\'s value', p + `let o\nconst before = (o ||= { run: (x) => parse(x) }).run(3)\n` + after + `export let f = (x) => [before, o.run(x)]`, 5],
    ['a choice\'s second arm', p + `const a = { run: (x) => 0 }, b = { run: (x) => parse(x) }\nlet on = 0\nconst before = (on ? a : b).run(3)\n` + after + `export let f = (x) => [before, b.run(x)]`, 5],
    ['a logical\'s right operand', p + `const b = { run: (x) => parse(x) }\nlet z = null\nconst before = (z || b).run(3)\n` + after + `export let f = (x) => [before, b.run(x)]`, 5],
    ['an own member named like a table method', p + `const hs = []\nhs.push = (x) => parse(x)\nconst before = hs.push(3)\n` + after + `export let f = (x) => [before, hs.push(x)]`, 5],
    ['an own member named like a builtin method', p + `const hs = []\nhs.map = (x) => parse(x)\nconst before = hs.map(3)\n` + after + `export let f = (x) => [before, hs.map(x)]`, 5],
    ['an own member of an element', p + `const by = [[]]\nby[0].push = (x) => parse(x)\nconst before = by[0].push(3)\n` + after + `export let f = (x) => [before, by[0].push(x)]`, 5],
    ['a for-of over closures', p + `const hs = [(x) => parse(x)]\nlet before = 0\nfor (const h of hs) before = h(3)\n` + after + `export let f = (x) => [before, hs[0](x)]`, 5],
    ['a for-of over an iterable of the program', p + `const it = { *[Symbol.iterator]() { yield parse(3) } }\nlet before = 0\nfor (const v of it) before = v\n` + after + `export let f = (x) => [before, parse(x)]`, 5],
    ['a callback over a table built by stores', p + `const by = []\nby[2] = [(x) => parse(x)]\nlet before = 0\nby.forEach(l => { before = l[0](3) })\n` + after + `export let f = (x) => [before, by[2][0](x)]`, 5],
    ['a closure pushed, then called', p + `const hs = []\nhs.push((x) => parse(x))\nconst before = hs[0](3)\n` + after + `export let f = (x) => [before, hs[0](x)]`, 5],
    ['an object a builtin calls a member of', p + `const o = { toJSON: () => parse(3) }\nconst before = JSON.stringify(o)\n` + after + `export let f = (x) => [before, parse(x)]`, 5],
    ['a closure pushed, never called', p + `const hs = []\nhs.push((x) => parse(x))\nconst before = hs.length\n` + after + `export let f = (x) => [before, hs[0](x)]`, 5],
    ['a number handed to a string method', p + `let i = 1\nconst before = 'abc'.charCodeAt(i)\n` + after + `export let f = (x) => [before, parse(x)]`, 5],
  ])
})

// The parser's operator table (subscript's dispatcher filed by second char):
// a call during initialization that runs none of the program's code keeps a
// later property initialized, and a for-in over it unrolls. Each of these
// calls made the walk take every function made so far as run, the comment
// reader among them, and the property nullable everywhere.
test('function properties: a builtin call during initialization that runs nothing of the program keeps a later property initialized', () => {
  const reader = `const parse = (s) => parse.space(s)\nparse.space = (s) => s.length\n`
  const tail = `const run = build(['+=', '++', '-'])\nparse.comment = { '//': 1, '/*': 2 }\nconst space = parse.space\nparse.space = (s) => { let n = space(s); for (const k in parse.comment) n += parse.comment[k] * k.length; return n }\nexport let f = (s) => run(s)\n`
  const table = (body) => reader + `const build = (ops) => { ${body} }\n` + tail
  const rows = [
    ['an element\'s method', table(`const by = []; for (let i = 0; i < ops.length; i++) { const c = ops[i].charCodeAt(0); if (!by[c]) by[c] = []; by[c].push(ops[i]) } return (s) => parse(s) + by.length`), 'ab'],
    ['an assignment\'s value', table(`const by = []; for (let i = 0; i < ops.length; i++) (by[ops[i].charCodeAt(0)] ||= []).push(ops[i]); return (s) => parse(s) + by.length`), 'ab'],
    ['a for-of over an array', table(`const by = [[], []]; for (const l of by) l.push(ops[0]); return (s) => parse(s) + by.length`), 'ab'],
    ['a table method handed an object', table(`const by = []; for (let i = 0; i < ops.length; i++) { const d = { op: ops[i] }; (by[ops[i].length] ||= []).push(d) } return (s) => parse(s) + by.length`), 'ab'],
    ['a number handed to a string method', table(`let n = 0; for (let i = 0; i < ops.length; i++) { const s = ops[i]; for (let k = 0; k < s.length; k++) n += s.charCodeAt(k) } return (s) => parse(s) + n`), 'ab'],
  ]
  agree(rows)
  if (onKernel() || belowOpt(1)) return   // the unroll is an optimization pass
  for (const [name, src] of rows) ok(!/call \$__(prop_order|keys_ro|keys_dyn)\b/.test(compile(src, { wat: true })), `${name}: the for-in unrolls`)
})
