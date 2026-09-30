// A statement list is read by one call, a statement per pass (src/parse.js, over
// subscript's feature/asi.js, which reads the statements after a boundary by a
// call inside the call that read the one before and stops at 2000 deep). The
// depth of a parse is the nesting of its source, whatever the count of its
// statements: a library bundled into one file parses. The trees are subscript's,
// node for node: TREES holds what subscript 10.8.1 gives for each source.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { parse } from '../src/parse.js'
import { onKernel } from './_matrix.js'

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
