// A rejection names the construct that faulted: the module it sits in (when
// the program has several), its line and column, and that source line. A
// construct the compiler wrote itself (a lowering's node, a runtime module's)
// reports the nearest written one around it. Each row is a program jz rejects
// by design and the position it must report. Locations are host-side: the
// kernel compiles without the source text.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { compile } from '../index.js'
import { onKernel } from './_matrix.js'

const PRIVATE_USE = String.fromCharCode(0xe000)

// [label, source, where: 'line L:C' | 'file:L:C', opts]
const REJECTS = [
  // the program
  ['strict var', 'export let f = () => {\n  let a = 1\n  var x = 1\n  return x\n}', 'line 3:3', { strict: true }],
  ['with', 'export let f = (o) => {\n  with (o) { return x }\n}', 'line 2:3'],
  ['eval call', 'export let f = () => {\n  return eval("1")\n}', 'line 2:14'],
  ['const reassignment', 'const K = 1\nexport let f = () => {\n  K = 2\n  return K\n}', 'line 3:5'],
  ['static-key delete', 'let obj = { x: 1 }\nexport let f = () => {\n  delete obj.x\n}', 'line 3:3'],
  ['strict dynamic key', 'export let f = (k) => {\n  let p = { x: 1 }\n  p[k] = 2\n  return p[k]\n}', 'line 3:8', { strict: true }],
  // the parser and the early errors
  ['syntax error', 'export let f = () => {\n  let x = 1 +\n}', 'line 2:13'],
  ['unterminated comment', 'export let f = () => 1\n/* never closed', 'line 2:1'],
  ['control character', 'export let f = () => {\n  return 1 \u0001+ 2\n}', 'line 2:12'],
  ['duplicate declaration', 'let a = 1\nexport let f = () => {\n  let x = 1; let x = 2\n}', 'line 3:14'],
  ['duplicate at top level', 'let x = 1\nlet x = 2\nexport let f = () => x', 'line 2:1'],
  ['export without binding', 'let a = 1\nexport { y }', 'line 2:1'],
  // a construct a lowering rewrote: class, generator, async, parameters, switch, loop
  ['class method', 'class A {\n  m(o) {\n    with (o) { return 1 }\n  }\n}\nexport let f = () => new A().m({})', 'line 3:5'],
  ['generator body', 'let obj = { x: 1 }\nfunction* g() {\n  yield 1\n  delete obj.x\n}\nexport let f = () => g().next().value', 'line 4:3'],
  ['async body', 'let obj = { x: 1 }\nexport let f = async () => {\n  await 1\n  delete obj.x\n  return 1\n}', 'line 4:3'],
  ['across an await', 'export let f = async (o) => {\n  await 1\n  with (o) { return 1 }\n}', 'line 3:3'],
  ['destructured parameter', 'export let f = ({ a, b }) => {\n  var x = a\n  return x + b\n}', 'line 2:3', { strict: true }],
  ['parameter default', 'export let f = (a = eval("1")) => a', 'line 1:25'],
  ['switch case', 'export let f = (k, o) => {\n  switch (k) {\n    case 1: with (o) { return 1 }\n  }\n  return 0\n}', 'line 3:13'],
  ['for-of body', 'let obj = { x: 1 }\nexport let f = (xs) => {\n  for (const v of xs) {\n    delete obj.x\n  }\n}', 'line 4:5'],
  // after the async runtime (jz:async) joined the program: never a position inside it
  ['after the runtime, prepare', 'export let f = async (x) => await x + 1\nexport let g = (o) => {\n  with (o) { return 1 }\n}', 'line 3:3'],
  ['after the runtime, emit', 'export let g = async (x) => await x\nexport let f = () => {\n  let a = [() => f32x4.splat(1.0)]\n  return f32x4.lane(a[0](), 0)\n}', 'line 3:29'],
  // modules
  ['in a module', 'import { g } from "./m.js"\nexport let f = (o) => g(o)', './m.js:3:3',
    { modules: { './m.js': 'let a = 1\nexport let g = (o) => {\n  with (o) { return x }\n}' } }],
  ['syntax error in a module', 'import { g } from "./m.js"\nexport let f = () => g()', './m.js:2:13',
    { modules: { './m.js': 'export let g = () => {\n  let x = 1 +\n}' } }],
  ['early error in a module', 'import { g } from "./m.js"\nexport let f = () => g()', './m.js:2:14',
    { modules: { './m.js': 'export let g = () => {\n  let x = 1; let x = 2\n}' } }],
  ['a module a module imports', 'import { h } from "./a.js"\nexport let f = () => h()', './b.js:3:5',
    { modules: { './a.js': 'import { g } from "./b.js"\nexport let h = () => g() + 1', './b.js': 'const K = 1\nexport let g = () => {\n  K = 2\n  return K\n}' } }],
  ['a module with the runtime', 'import { g } from "./m.js"\nexport let f = () => g()', './m.js:4:3',
    { modules: { './m.js': 'export let h = async () => 1\nexport let g = () => {\n  let obj = { x: 1 }\n  delete obj.x\n}' } }],
  ['the program beside a module', 'import { g } from "./m.js"\nexport let f = (o) => {\n  with (o) { return g() }\n}', 'line 3:3',
    { modules: { './m.js': 'export let g = () => 1' } }],
  // text the compiler puts before the program
  ['define prelude', 'export let f = () => { var x = 1 }', 'line 1:24', { strict: true, define: { K: 5, S: 'text' } }],
  ['shebang', '#!/usr/bin/env node\nlet a = 1\nexport let f = (o) => { with (o) { return a } }', 'line 3:25'],
]

const sourceLine = (src, opts, where) => {
  const m = /^(?:line |(.+):)(\d+):\d+$/.exec(where)
  return (m[1] ? opts.modules[m[1]] : src).split('\n')[+m[2] - 1]
}

test('error location: every rejection names its module, line, column and source line', () => {
  if (onKernel()) return
  for (const [label, src, where, opts = {}] of REJECTS) {
    let error
    try { compile(src, opts) } catch (e) { error = e }
    ok(error, `${label}: rejected`)
    if (!error) continue
    const want = `\n  at ${where}\n  ${sourceLine(src, opts, where)}\n`
    ok(error.message.includes(want), `${label}: at ${where}, got ${JSON.stringify(error.message.split('\n').slice(0, 4).join(' | '))}`)
    ok(!error.message.includes('jz:'), `${label}: no position inside a runtime module`)
  }
})

test('error location: the caret stands under the column, a tab above a tab below', () => {
  if (onKernel()) return
  let error
  try { compile('export let f = (o) => {\n\t\twith (o) { return 1 }\n}') } catch (e) { error = e }
  ok(error?.message.includes('\n  at line 2:3\n  \t\twith (o) { return 1 }\n  \t\t^'), error?.message)
})

test('error location: a message shows the names the source wrote', () => {
  if (onKernel()) return
  let error
  // a function-local binding and a module binding are minted internally (rf64 + U+E000 + f1_2, __m_js$K)
  try { compile('import { g } from "./m.js"\nexport let f = () => g()', { modules: { './m.js': 'const K = 1\nexport let g = () => {\n  K = 2\n  return K\n}' } }) } catch (e) { error = e }
  ok(error?.message.startsWith("Assignment to const 'K'"), error?.message)
  ok(!error?.message.includes(PRIVATE_USE), 'no minted suffix')
})

test('error location: a syntax error stays a SyntaxError', () => {
  if (onKernel()) return
  let error
  try { compile('export let f = () => {\n  let x = 1 +\n}') } catch (e) { error = e }
  ok(error instanceof SyntaxError, `got ${error?.name}`)
})
