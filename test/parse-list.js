// A statement list is read by one call, a statement per pass (src/parse.js, over
// subscript's feature/asi.js, which reads the statements after a boundary by a
// call inside the call that read the one before and stops at 2000 deep). The
// depth of a parse is the nesting of its source, whatever the count of its
// statements: a library bundled into one file parses. The trees are subscript's,
// node for node: TREES holds what subscript 10.8.1 gives for each source.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { parse } from '../src/parse.js'
import { LEN } from '../src/list-form.js'
import { onKernel } from './_matrix.js'
import { jz, run, oracle } from './util.js'

// [source, the tree as JSON]
const TREES = [
  ['a\nb',
    '[";","a","b"]'],
  ['a;\nb',
    '[";","a","b"]'],
  ['a; b\nc',
    '[";","a","b","c"]'],
  ['a;\nb;\nc;',
    '[";","a","b","c",null]'],
  ['a\nb\nc\nd',
    '[";","a","b","c","d"]'],
  ['let a = 1\nlet b = 2\na + b',
    '[";",["let",["=","a",[null,1]]],["let",["=","b",[null,2]]],["+","a","b"]]'],
  ['function f(x) {\n  return x\n}\nvar g = f\n\nvar h = g',
    '[";",["function","f","x",["return","x"]],["var",["=","g","f"]],["var",["=","h","g"]]]'],
  ['function f(a) {\n  return g\n  function g(x) {\n    if (x > a) {\n      return 1\n    }\n    return 2\n  }\n}\nf(1)',
    '[";",["function","f","a",[";",["return","g"],["function","g","x",[";",["if",[">","x","a"],["return",[null,1]]],["return",[null,2]]]]]],["()","f",[null,1]]]'],
  ['if (c) { a }\n(x)',
    '[";",["if","c","a"],["()","x"]]'],
  ['if (c) a\nelse b\nd',
    '[";",["if","c","a","b"],"d"]'],
  ['let a\n[x] = y',
    '[";",["let","a"],["=",["[]","x"],"y"]]'],
  ['a\n(b)',
    '["()","a","b"]'],
  // the one tree that departs from subscript's: a postfix `++` takes no line
  // terminator before it (ECMA-262 §13.4, a restricted production; §12.10.1),
  // so the `++` starts the next statement, as Node reads it
  ['a = b\n++c',
    '[";",["=","a","b"],["++","c"]]'],
  ['let f = () => {\n  a\n  b\n}\nf()',
    '[";",["let",["=","f",["=>",["()",null],["{}",[";","a","b"]]]]],["()","f",null]]'],
  ['for (let i = 0; i < 3; i++) {\n  a\n  b\n}\nc',
    '[";",["for",[";",["let",["=","i",[null,0]]],["<","i",[null,3]],["++","i",null]],[";","a","b"]],"c"]'],
  ['while (x) x--\ny',
    '[";",["while","x",["--","x",null]],"y"]'],
  ['switch (k) {\n  case 1:\n    a\n    b\n    break\n  default:\n    c\n}\nd\ne',
    '[";",["switch","k",["case",[null,1],[";","a","b",["break"]]],["default","c"]],"d","e"]'],
  ['try {\n  a\n  b\n} catch (e) {\n  c\n} finally {\n  d\n}\ne',
    '[";",["try",[";","a","b"],["catch","e","c"],["finally","d"]],"e"]'],
  ['const o = {\n  a: 1,\n  b: 2\n}\no.a',
    '[";",["const",["=","o",["{}",[",",[":","a",[null,1]],[":","b",[null,2]]]]]],[".","o","a"]]'],
  ['x = [\n  1,\n  2\n]\ny',
    '[";",["=","x",["[]",[",",[null,1],[null,2]]]],"y"]'],
  ['a = b +\n  c\nd',
    '[";",["=","a",["+","b","c"]],"d"]'],
  ['a = b\n  .c\n  .d()\ne',
    '[";",["=","a",["()",[".",[".","b","c"],"d"],null]],"e"]'],
  ['label: for (;;) {\n  break label\n}\nz',
    '[";",[":","label",["for",[";",null,null,null],["break","label"]]],"z"]'],
  ['{\n  a\n  b\n}\n{\n  c\n}',
    '[";",["{}",[";","a","b"]],["{}","c"]]'],
  ['a; b; c',
    '[";","a","b","c"]'],
  ['a\n;b',
    '[";","a","b"]'],
  ['export let f = (x) => {\n  x = x + 1\n  return x\n}\nexport const g = 2',
    '[";",["export",["let",["=","f",["=>",["()","x"],["{}",[";",["=","x",["+","x",[null,1]]],["return","x"]]]]]]],["export",["const",["=","g",[null,2]]]]]'],
  ['import { a } from "m"\nimport b from "n"\na(b)',
    '[";",["import",["from",["{}","a"],[null,"m"]]],["import",["from","b",[null,"n"]]],["()","a","b"]]'],
  ['class A {\n  m() {\n    a\n    b\n  }\n}\nnew A',
    '[";",["class","A",null,[":","m",["function",null,null,[";","a","b"]]]],["new","A"]]'],
  ['do {\n  a\n  b\n} while (c)\nd',
    '[";",["do",[";","a","b"],"c"],"d"]'],
  ['`t`\nb',
    '[";",[null,"t"],"b"]'],
  ['async function f() {\n  await a\n  b\n}\nf()',
    '[";",["async",["function","f",null,[";",["await","a"],"b"]]],["()","f",null]]'],
  ['function* g() {\n  yield a\n  yield b\n}\ng()',
    '[";",["function*","g",null,[";",["yield","a"],["yield","b"]]],["()","g",null]]'],
  ['a ? b : c\nd',
    '[";",["?","a","b","c"],"d"]'],
  ['throw a\nb',
    '[";",["throw","a"],"b"]'],
  ['if (a) {\n  b\n} else if (c) {\n  d\n  e\n} else {\n  f\n}\ng',
    '[";",["if","a","b",["if","c",[";","d","e"],"f"]],"g"]'],
]

test('parse list: a statement list reads as subscript reads it', () => {
  for (const [src, tree] of TREES) is(JSON.stringify(parse(src)), tree, JSON.stringify(src))
})

// A bundle's statements: a function with a list of its own, a binding of it, a call.
const unit = (i) => `function f${i}(x) {\n  var y = x + ${i}\n  if (y > 3) {\n    y = y - 1\n    return y\n  }\n  return g${i}\n  function g${i}(z) {\n    var w = z * 2\n    return w + ${i}\n  }\n}\nvar h${i} = f${i}\n`

test('parse list: the count of statements sets no depth', () => {
  for (const n of [1, 1000, 2500, 6000]) {
    const src = Array.from({ length: n }, (_, i) => unit(i)).join('\n') + `\nvar last = h${n - 1}(1)`
    const tree = parse(src)
    is(tree[0], ';', `${n} units: a list`)
    is(tree.length, 1 + 2 * n + 1, `${n} units: every statement in one list`)
    const f = tree[tree.length - 3]
    is(JSON.stringify(f), JSON.stringify(parse(unit(n - 1))[1]), `${n} units: the last function reads as it reads alone`)
  }
})

test('parse list: a block deep in a long list closes', () => {
  // the shape that read as `Unclosed {`: past 2000 statements, a block of two
  const head = Array.from({ length: 2400 }, (_, i) => `function p${i}(x) {\n  return x\n}\nvar q${i} = p${i}`).join('\n')
  const src = head + '\nfunction wrap(alpha, beta) {\n  return inner\n  function inner(x, y) {\n    if (x > y) {\n      return alpha * x + beta * y\n    }\n    return beta * x + alpha * y\n  }\n}\nvar made = wrap(1, 0.5)'
  const tree = parse(src)
  is(JSON.stringify(tree[tree.length - 2]), JSON.stringify(parse('function wrap(alpha, beta) {\n  return inner\n  function inner(x, y) {\n    if (x > y) {\n      return alpha * x + beta * y\n    }\n    return beta * x + alpha * y\n  }\n}')), 'the function after 4800 statements')
})

test('parse list: a program of 2500 functions compiles and runs', () => {
  if (onKernel()) return
  const n = 2500
  const src = Array.from({ length: n }, (_, i) => `function s${i}(x) {\n  var y = x + ${i}\n  return y * 2\n}`).join('\n') +
    `\nexport function f(x) {\n  var a = s0(x)\n  var b = s${n - 1}(x)\n  return a + b\n}`
  const want = ((x) => (x + 0) * 2 + (x + n - 1) * 2)
  const { f } = jz(src, { jzify: true }).exports
  for (const x of [0, 1.5, -7]) is(f(x), want(x), `f(${x})`)
})

// The early errors find the line before an `else` or a `while` by scanning back
// from it; a kind of line terminator the source lacks sent the scan to the
// source's start, so the time went with the square of the lines: 16,000 if-else
// statements took 77 s to parse (4,000 took 5.0 s), 0.3 to 0.5 s once the scan
// stays on its line.
test('parse list: the early errors take a time in the lines, not their square', () => {
  const src = `export let f = (x) => { let s = 0\n${Array.from({ length: 16000 }, (_, i) => `if (x === ${i}) s += 1\nelse s -= 1`).join('\n')}\nreturn s }`
  const t0 = performance.now()
  parse(src)
  const ms = performance.now() - t0
  ok(ms < 5000, `16,000 if-else statements parsed in ${ms.toFixed(0)} ms`)
})

// A method shorthand is read only in the braces of an object literal or a class
// body. Tried at every call, it read a call's arguments as parameters and again
// as arguments, at each level of nested calls: 24 levels took 3.8 s to parse, 26
// some four times that. At the program's own level a call before a block on the
// next line read as a method (a labelled function, rejected).
test('parse list: nested calls parse once a level; a call then a block is two statements', () => {
  const src = `export let f = (x) => ${'g('.repeat(26)}x${')'.repeat(26)}`
  const t0 = performance.now(), tree = parse(src), ms = performance.now() - t0
  ok(ms < 2000, `26 nested calls parsed in ${ms.toFixed(0)} ms`)
  let n = tree[1][1][2][2], depth = 0
  while (Array.isArray(n) && n[0] === '()' && n[1] === 'g') { depth++; n = n[2] }
  is(depth, 26, 'the calls nest 26 deep')
  is(JSON.stringify(parse('f(a)\n{ x }')), '[";",["()","f","a"],["{}","x"]]')
  is(JSON.stringify(parse('x = { f(a) { return 1 } }')), '["=","x",["{}",[":","f",["function",null,"a",["return",[null,1]]]]]]')
  is(JSON.stringify(parse('class C { f(a) { return 1 } }')), '["class","C",null,[":","f",["function",null,"a",["return",[null,1]]]]]')
})

// An else-if chain, a `?:` chain down its alternates and the statements of a
// `;` list are read in a loop, a link a pass (src/parse.js), to the trees the
// recursion built: PINS holds each tree with every node's position as the
// recursive reader gave it ([position, op, ...operands]). The `;` reader took a
// call a statement, so a one-line list of 1,500 overflowed it.
const shown = n => Array.isArray(n) ? [n.loc ?? null, ...Array.from(n, x => x === undefined ? '<u>' : shown(x))] : n
const PINS = [
  ["if (a) b; else if (c) d; else e","[0,\"if\",\"a\",\"b\",[15,\"if\",\"c\",\"d\",\"e\"]]"],
  ["if (a) { b } else if (c) { d } else { e }","[0,\"if\",\"a\",\"b\",[18,\"if\",\"c\",\"d\",\"e\"]]"],
  ["if (a) b\nelse if (c) d\nelse if (e) f","[0,\"if\",\"a\",\"b\",[14,\"if\",\"c\",\"d\",[28,\"if\",\"e\",\"f\"]]]"],
  ["if (a) b; else if (c) d; else if (e) f; else g; h; i","[46,\";\",[0,\"if\",\"a\",\"b\",[15,\"if\",\"c\",\"d\",[30,\"if\",\"e\",\"f\",\"g\"]]],\"h\",\"i\"]"],
  ["L: if (a) b; else if (c) d","[1,\":\",\"L\",[3,\"if\",\"a\",\"b\",[18,\"if\",\"c\",\"d\"]]]"],
  ["if (a) if (b) c; else d; else e","[0,\"if\",\"a\",[7,\"if\",\"b\",\"c\",\"d\"],\"e\"]"],
  ["if (a) {} else if (b) {}\nx()","[null,\";\",[0,\"if\",\"a\",null,[15,\"if\",\"b\",null]],[26,\"()\",\"x\",null]]"],
  ["x = a ? b : c ? d : e","[2,\"=\",\"x\",[6,\"?\",\"a\",\"b\",[14,\"?\",\"c\",\"d\",\"e\"]]]"],
  ["x = a ? b : c ? d : e = f","[2,\"=\",\"x\",[6,\"?\",\"a\",\"b\",[14,\"?\",\"c\",\"d\",[22,\"=\",\"e\",\"f\"]]]]"],
  ["x = a ? b : c ?? d ? e : f","[2,\"=\",\"x\",[6,\"?\",\"a\",\"b\",[19,\"?\",[14,\"??\",\"c\",\"d\"],\"e\",\"f\"]]]"],
  ["f(a ? b : c ? d : e, g)","[1,\"()\",\"f\",[19,\",\",[4,\"?\",\"a\",\"b\",[12,\"?\",\"c\",\"d\",\"e\"]],\"g\"]]"],
  ["x = a ? b : c\n? d : e","[2,\"=\",\"x\",[6,\"?\",\"a\",\"b\",[14,\"?\",\"c\",\"d\",\"e\"]]]"],
  ["a ? b : c ? d : e ? f : g","[2,\"?\",\"a\",\"b\",[10,\"?\",\"c\",\"d\",[18,\"?\",\"e\",\"f\",\"g\"]]]"],
  ["x = a ? (b, c) : d ? e : f","[2,\"=\",\"x\",[6,\"?\",\"a\",[8,\"()\",[10,\",\",\"b\",\"c\"]],[19,\"?\",\"d\",\"e\",\"f\"]]]"],
  ["x = a ? b : c ? d : e, y = 1","[21,\",\",[2,\"=\",\"x\",[6,\"?\",\"a\",\"b\",[14,\"?\",\"c\",\"d\",\"e\"]]],[25,\"=\",\"y\",[null,\"<u>\",1]]]"],
  ["x = a ? b : c ? d : e ? f : g || h","[2,\"=\",\"x\",[6,\"?\",\"a\",\"b\",[14,\"?\",\"c\",\"d\",[22,\"?\",\"e\",\"f\",[30,\"||\",\"g\",\"h\"]]]]]"],
  ["a; b; c","[1,\";\",\"a\",\"b\",\"c\"]"],
  ["a;; b","[1,\";\",\"a\",null,\"b\"]"],
  ["a; b;","[1,\";\",\"a\",\"b\",null]"],
  ["for (;;) {}","[0,\"for\",[5,\";\",null,null,null],null]"],
  ["for (a; b; c) d","[0,\"for\",[6,\";\",\"a\",\"b\",\"c\"],\"d\"]"],
  ["{ a; b } c; d","[null,\";\",[0,\"{}\",[3,\";\",\"a\",\"b\"]],\"c\",\"d\"]"],
  ["switch (x) { case 1: a; b; case 2: c }","[0,\"switch\",\"x\",[null,\"case\",[null,\"<u>\",1],[null,\";\",\"a\",\"b\"]],[null,\"case\",[null,\"<u>\",2],\"c\"]]"],
  ["class C { x = 1; y = 2; m() { a; b } }","[0,\"class\",\"C\",null,[15,\";\",[12,\"=\",\"x\",[null,\"<u>\",1]],[19,\"=\",\"y\",[null,\"<u>\",2]],[25,\":\",\"m\",[null,\"function\",null,null,[31,\";\",\"a\",\"b\"]]]]]"],
  ["var a = 1; let b = 2; const c = 3","[9,\";\",[0,\"var\",[6,\"=\",\"a\",[null,\"<u>\",1]]],[11,\"let\",[17,\"=\",\"b\",[null,\"<u>\",2]]],[22,\"const\",[30,\"=\",\"c\",[null,\"<u>\",3]]]]"],
  ["do a; while (b); c","[15,\";\",[0,\"do\",\"a\",\"b\"],\"c\"]"],
  ["function f() { a; b; return c }; g()","[31,\";\",[0,\"function\",\"f\",null,[16,\";\",\"a\",\"b\",[21,\"return\",\"c\"]]],[34,\"()\",\"g\",null]]"],
  ["x = () => { a; b }; y","[18,\";\",[2,\"=\",\"x\",[7,\"=>\",[4,\"()\",null],[10,\"{}\",[13,\";\",\"a\",\"b\"]]]],\"y\"]"],
]

test('parse list: chains read in a loop make the trees the recursion made', () => {
  for (const [src, tree] of PINS) is(JSON.stringify(shown(parse(src))), tree, src)
})

test('parse list: 10,000 statements on one line', () => {
  const tree = parse(`let s = 0; ${Array.from({ length: 10000 }, (_, i) => `s += ${i}`).join('; ')}; s`)
  is(tree.length, 10003, 'a list of the declaration, 10,000 statements and the last')
  is(JSON.stringify(tree[10001]), '["+=","s",[null,9999]]')
})

// A chain longer than LEN links is written as a list of the same meaning
// (src/list-form.js); jz answers what Node answers on the source as written.
// Each kind at LEN + 1 and at 100 links, and the programs that break a careless
// list form: break, continue and a labeled break in arms; a chain in a switch
// case, a generator, a for-update clause, an arm of another chain; a sum that
// turns to a string; an optional chain; a reference at the top of a chain; facts
// a guard proves that must not reach past its list.
const R = (n, f) => Array.from({ length: n }, (_, i) => f(i))
const KINDS = {
  elseif: n => `export let f = (x) => { ${R(n, i => `if (x === ${i}) return ${i * 3}`).join('\n else ')}\n return -1 }`,
  elseifa: n => `export let f = (x) => { let r = 0\n ${R(n, i => `if (x === ${i}) r = ${i * 3}`).join('\n else ')}\n else r = -1\n return r + 1 }`,
  switch: n => `export let f = (x) => { switch (x) { ${R(n, i => `case ${i}: return ${i * 3};`).join(' ')} } return -1 }`,
  switchb: n => `export let f = (x) => { let r = 0; switch (x) { ${R(n, i => `case ${i}: r = ${i * 3}; break;`).join(' ')} default: r = -1 } return r + 1 }`,
  plus: n => `export let f = (x) => ${R(n, i => `x * ${i}`).join(' + ')}`,
  minus: n => `export let f = (x) => { return ${R(n, i => `x * ${i}`).join(' - ')} }`,
  concat: n => `export let f = (x) => '' + ${R(n, i => `'k${i % 10}' + x`).join(' + ')}`,
  flip: n => `export let f = (x) => ${R(n, i => i === n >> 1 ? `'|'` : `x * ${i}`).join(' + ')}`,
  and: n => `export let f = (x) => ${R(n, i => `(x + ${i})`).join(' && ')}`,
  or: n => `export let f = (x) => ${R(n - 1, i => `(x === ${i + 1000} && ${i})`).join(' || ')} || x + 7`,
  orright: n => `export let f = (x) => ${R(n - 1, i => `(x === ${i} && ${i + 1} || `).join('')}-1${')'.repeat(n - 1)}`,
  nullish: n => `export let f = (x) => { let a = x > 100 ? 1 : null\n return ${R(n, () => 'a').join(' ?? ')} ?? (x || 5) }`,
  paren: n => `export let f = (x) => ${'('.repeat(n - 1)}x * 0${R(n - 1, i => ` + x * ${i + 1})`).join('')}`,
  tern: n => `export let f = (x) => ${R(n, i => `x === ${i} ? ${i * 3} :`).join(' ')} -1`,
  ternexpr: n => `export let f = (x) => { const v = 1 + (${R(n, i => `x === ${i} ? ${i * 3} :`).join(' ')} -1)\n return v * 2 }`,
  ternstmt: n => `export let f = (x) => { let r = 0\n r = ${R(n, i => `x === ${i} ? ${i * 3} :`).join(' ')} -1\n return r }`,
  calls: n => `export let f = (x) => { const o = { s: 0, add(v) { this.s += v; return this } }\n return o${R(n, i => `.add(${i % 7})`).join('')}.s + x }`,
  members: n => `export let f = (x) => { const o = { v: x }; o.a = o\n return o${'.a'.repeat(n)}.v }`,
  optional: n => `export let f = (x) => { const o = x > 50 ? null : { v: x }; if (o) o.a = o\n return o?.a${'.a'.repeat(n - 1)}.v }`,
  target: n => `export let f = (x) => { const o = { v: x }; o.a = o\n o${'.a'.repeat(n)}.v = x * 2; o${'.a'.repeat(n)}.v += 1\n return o.v }`,
  module: n => `const k = 2\nconst s = ${R(n, i => `k * ${i}`).join(' + ')}\nexport let f = (x) => s + x`,
  param: n => `export let f = (x, y = ${R(n, i => `x * ${i}`).join(' + ')}) => y`,
  twice: n => `export let f = (x) => { let s = 0\n for (let i = 0; i < 3; i++) s += ${R(n, j => `(x + i) * ${j}`).join(' + ')}\n return s + (${R(n, j => `x === ${j} ? ${j} :`).join(' ')} -1) }`,
}
const XS = [3, 0, 64, 99, -1, 2.5, 120]

test('parse list: a chain past LEN links answers as written, each kind', () => {
  for (const [kind, gen] of Object.entries(KINDS)) for (const n of [LEN + 1, 100]) {
    const src = gen(n), want = oracle(src).f, got = run(src).f
    for (const x of XS) is(got(x), want(x), `${kind} of ${n} links, f(${x})`)
  }
})

// Before the list form a walk ran out of stack near 500 links of an else-if
// chain or a switch, 800 of a sum, 280 of a call chain and some 800 of `&&` or
// `?:` (the early errors).
test('parse list: chains of 1,000 links compile', () => {
  for (const kind of ['elseif', 'switch', 'plus', 'tern', 'calls', 'and']) {
    const src = KINDS[kind](1000), want = oracle(src).f, got = run(src).f
    for (const x of [3, 999, -1]) is(got(x), want(x), `${kind} of 1,000 links, f(${x})`)
  }
})

// [name, source, the argument lists to call f with]
const N = 100, xs = (...a) => a.map(v => [v])
const PROGRAMS = [
  // break and continue in the arms of a chain inside a loop
  ['loop arms', `export let f = (x) => { let s = 0
    for (let i = 0; i < ${N + 5}; i++) { ${R(N, j => j === 2 ? `if (i === x) break` : j === 3 ? `if (i === ${N + 1}) continue` : j === 4 ? `if (i === 4) { s += 100 }` : `if (i === ${j + 7}) s += ${j}`).join('\n else ')}\n else s += i; s += 1000 }
    return s }`, xs(0, 3, 50, -1)],
  // the chain in a labeled block, arms leaving it
  ['labeled block', `export let f = (x) => { let s = 0
    L: { ${R(N, j => j % 3 === 0 ? `if (x === ${j}) break L` : j % 3 === 1 ? `if (x === ${j}) { s = ${j} }` : `if (x === ${j}) { s = ${j}; break L }`).join('\n else ')}\n else s = -3; s += 10 }
    return s }`, xs(0, 1, 2, 3, 4, 5, 99, 500)],
  // the chain in a switch case: the guard's break beside a switch break, and a fall through
  ['switch case', `export let f = (x, y) => { let s = 0
    switch (x) { case 1: ${R(N, j => j === 1 ? `if (y === 1) { s = 50; break }` : `if (y === ${j}) s = ${j}`).join('\n else ')}\n else s = 4; s += 10; case 2: s += 1000; break; default: s = -1 }
    return s }`, [[1, 0], [1, 1], [1, 2], [1, 99], [1, 500], [2, 0], [3, 3]]],
  // yield in the arms
  ['generator arms', `function* g(x) { let s = 0
    ${R(N, j => `if (x === ${j}) s = (yield ${j}) * ${j % 5}`).join('\n else ')}\n else s = yield -1
    yield s + 100 }
    export let f = (x) => { const it = g(x); const a = it.next().value; const b = it.next(5).value; return a * 1000 + b }`, xs(0, 7, 99, 300)],
  // a ?: chain in a for-update clause: the flag form starts over at each evaluation
  ['for update', `export let f = (x) => { let s = 0
    for (let i = 0; i < 200; i += (${R(N, j => `i === ${j} ? ${(j % 3) + 1} :`).join(' ')} 50)) s += i + x
    return s }`, xs(0, 1)],
  // an expression-bodied arrow whose ?: chain recurses
  ['recursive arrow', `export let f = (x) => ${R(N, j => `x === ${j} ? ${j < 3 ? j : `f(${j - 3}) + ${j * 10}`} :`).join(' ')} -1`, xs(0, 2, 4, 50, 99, 100)],
  // a chain in an arm of another chain, both past LEN, both in expressions
  ['inner chain', `export let f = (x, y) => 1 + (${R(N, j => j === 0 ? `x === 0 ? (${R(N, k => `y === ${k} ? ${k + 500} :`).join(' ')} 8) :` : `x === ${j} ? ${j} :`).join(' ')} -1)`, [[0, 0], [0, 99], [0, 300], [5, 0], [99, 1], [200, 1]]],
  // else-if chains, each arm another chain, nested: each guard list takes its own label
  ['nested guard lists', `export let f = (x, y) => { let s = 0
    ${R(N, j => j === 7 ? `if (x === 7) { ${R(N, k => `if (y === ${k}) s = ${k}`).join('; else ')}; else s = -7 }` : `if (x === ${j}) s = ${j * 2}`).join('\n else ')}\n else s = -1
    return s }`, [[7, 0], [7, 50], [7, 500], [3, 0], [500, 0]]],
  // what a guard proves stays inside the list
  ['facts: null', `export let f = (k) => { const o = k > 0 ? { v: k } : null; let s = 0
    ${R(N, j => j === 0 ? `if (o === null) s = -1` : `if (k === ${j + 1000}) s = ${j}`).join('\n else ')}\n else s = o.v
    return o === null ? 7 + s : s + o.v }`, xs(3, -2, 0)],
  ['facts: typeof', `export let f = (k) => { const v = k > 0 ? 'abc' : k; let s = 0
    ${R(N, j => j === 0 ? `if (typeof v === 'string') s = 1` : `if (v === ${j + 1000}) s = 2`).join('\n else ')}\n else s = v * 2
    return typeof v === 'string' ? v.length + 100 + s : s + v }`, xs(3, -2, 0)],
  ['facts: range', `export let f = (k) => { k = k | 0; let s = 0
    ${R(N, j => j === 0 ? `if (k > 100) s = 1` : j === 1 ? `if (k < 0) s = 2` : `if (k === ${j + 1000}) s = 3`).join('\n else ')}\n else s = k
    return k > 100 ? 1000 + s : k < 0 ? 2000 + s : s }`, xs(3, 200, -5)],
  // a left operand held across a yield, as JavaScript holds it
  ['yield in a sum', `let t = 0
    function* g(x) { t = 1; const r = ${R(N, j => j === N - 1 ? '(yield 5)' : `t * ${j}`).join(' + ')}; return r }
    export let f = (x) => { const it = g(x); it.next(); t = 100; return it.next(10).value }`, xs(0)],
]

test('parse list: chains past LEN links in the places a list form can go wrong', () => {
  for (const [name, src, args] of PROGRAMS) {
    const want = oracle(src).f, got = run(src).f
    for (const a of args) is(got(...a), want(...a), `${name}: f(${a.join(', ')})`)
  }
})

// The guard list wraps an arm in a block: an arm that is a declaration stays the
// early error it is (the source is checked as written), at LEN links and past.
test('parse list: a declaration arm is an early error at any length', () => {
  for (const n of [3, LEN + 1]) for (const decl of ['let y = 1', 'const y = 1', 'class C {}', 'function g() {}'])
    throws(() => jz(`export let f = (x) => { ${R(n, j => j === 1 ? `if (x === 1) ${decl}` : `if (x === ${j}) x = ${j}`).join('; else ')}; return x }`), /requires a block in statement position/, `${decl} at ${n} links`)
})

// A line of `;`-joined statements, the lines apart by line breaks: each line's
// list went back to the loop over lines only at the file's end, so each line was
// read inside the one before, and 600 lines ran out of stack ("nesting too deep").
test('parse list: 10,000 lines of two statements each', () => {
  const tree = parse(`let s = 0, t = 0\n${R(10000, i => `s += ${i}; t += 1`).join('\n')}\ns + t`)
  is(tree.length, 20003, 'a list of the declaration, 20,000 statements and the last')
  is(JSON.stringify(tree[20000]), '["+=","s",[null,9999]]')
  is(JSON.stringify(tree[20001]), '["+=","t",[null,1]]')
  const src = `export let f = (x) => { let s = 0, t = 0\n${R(700, i => `s += x * ${i}; t += 1`).join('\n')}\nreturn s + t }`
  is(run(src).f(3), oracle(src).f(3), '700 lines in a function body answer as Node')
})

// The early errors look for a lexical name declared twice in a scope: a nested
// comparison of each name with those before it, so a body of 10,000 `const`
// declarations took 3.1 s to parse (2,500 took 0.19 s); 70 ms with a set.
test('parse list: a scope of 10,000 declarations is checked in a time in its names', () => {
  const src = `export let f = (x) => { const a0 = x\n${R(9999, i => `const a${i + 1} = a${i} + 1`).join('\n')}\nreturn a9999 }`
  const t0 = performance.now()
  parse(src)
  const ms = performance.now() - t0
  ok(ms < 1500, `10,000 declarations parsed in ${ms.toFixed(0)} ms`)
  throws(() => parse(`export let f = (x) => { ${R(40, i => `const a${i} = ${i}`).join('\n')}\nconst a7 = 1 }`), /duplicate lexical declaration 'a7'/)
})
