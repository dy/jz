import test from 'tst'
import { is, throws } from 'tst/assert.js'
import { parseRegex, compileRegex } from '../module/regex.js'
import { evaluate } from './util.js'
import jz, { compile } from '../index.js'

/** Compile + run, read result via jz.memory (for string-returning expressions) */
function evalStr(code) {
  const wasm = compile(`export let main = () => ${code}`)
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod)
  const m = jz.memory({ module: mod, instance: inst })
  return m.read(inst.exports.main())
}

// === Parser tests ===

test('regex: literal chars', () => {
  is(parseRegex('a'), ['seq', 'a'])
  is(parseRegex('abc'), ['seq', 'a', 'b', 'c'])
})

test('regex: alternation', () => {
  is(parseRegex('a|b'), ['|', 'a', 'b'])
  is(parseRegex('a|b|c'), ['|', 'a', 'b', 'c'])
  is(parseRegex('ab|cd'), ['|', ['seq', 'a', 'b'], ['seq', 'c', 'd']])
})

test('regex: quantifiers', () => {
  is(parseRegex('a*'), ['*', 'a'])
  is(parseRegex('a+'), ['+', 'a'])
  is(parseRegex('a?'), ['?', 'a'])
  is(parseRegex('a*?'), ['*?', 'a'])
  is(parseRegex('a+?'), ['+?', 'a'])
  is(parseRegex('ab*'), ['seq', 'a', ['*', 'b']])
  is(parseRegex('a+b'), ['seq', ['+', 'a'], 'b'])
})

test('regex: repetition {n,m}', () => {
  is(parseRegex('a{3}'), ['{}', 'a', 3, 3])
  is(parseRegex('a{2,5}'), ['{}', 'a', 2, 5])
  is(parseRegex('a{2,}'), ['{}', 'a', 2, Infinity])
  is(parseRegex('a{2,}?'), ['{}?', 'a', 2, Infinity])
})

test('regex: character classes', () => {
  is(parseRegex('[abc]'), ['[]', 'a', 'b', 'c'])
  is(parseRegex('[a-z]'), ['[]', ['-', 'a', 'z']])
  is(parseRegex('[a-zA-Z]'), ['[]', ['-', 'a', 'z'], ['-', 'A', 'Z']])
  is(parseRegex('[^abc]'), ['[^]', 'a', 'b', 'c'])
  is(parseRegex('[a-]'), ['[]', 'a', '-'])
})

test('regex: escapes', () => {
  is(parseRegex('\\d'), ['\\d'])
  is(parseRegex('\\w'), ['\\w'])
  is(parseRegex('\\s'), ['\\s'])
  is(parseRegex('\\D'), ['\\D'])
  is(parseRegex('\\n'), ['seq', '\n'])
  is(parseRegex('\\t'), ['seq', '\t'])
  is(parseRegex('\\.'), ['seq', '.'])
  is(parseRegex('\\\\'), ['seq', '\\'])
})

test('regex: escapes in class', () => {
  is(parseRegex('[\\d]'), ['[]', ['\\d']])
  is(parseRegex('[\\n]'), ['[]', '\n'])
  is(parseRegex('[\\]]'), ['[]', ']'])
})

test('regex: anchors', () => {
  is(parseRegex('^a'), ['seq', ['^'], 'a'])
  is(parseRegex('a$'), ['seq', 'a', ['$']])
  is(parseRegex('^a$'), ['seq', ['^'], 'a', ['$']])
})

test('regex: dot', () => {
  is(parseRegex('.'), ['.'])
  is(parseRegex('a.b'), ['seq', 'a', ['.'], 'b'])
  is(parseRegex('.*'), ['*', ['.']])
})

test('regex: groups', () => {
  is(parseRegex('(a)'), ['()', 'a', 1])
  is(parseRegex('(ab)'), ['()', ['seq', 'a', 'b'], 1])
  is(parseRegex('(?:a)'), ['(?:)', 'a'])
  is(parseRegex('(a|b)'), ['()', ['|', 'a', 'b'], 1])
  is(parseRegex('(a)+'), ['+', ['()', 'a', 1]])
})

test('regex: nested groups', () => {
  is(parseRegex('((a))'), ['()', ['()', 'a', 2], 1])
  is(parseRegex('(a(b)c)'), ['()', ['seq', 'a', ['()', 'b', 2], 'c'], 1])
})

test('regex: lookahead', () => {
  is(parseRegex('a(?=b)'), ['seq', 'a', ['(?=)', 'b']])
  is(parseRegex('a(?!b)'), ['seq', 'a', ['(?!)', 'b']])
})

test('regex: lookbehind', () => {
  is(parseRegex('(?<=a)b'), ['seq', ['(?<=)', 'a'], 'b'])
  is(parseRegex('(?<!a)b'), ['seq', ['(?<!)', 'a'], 'b'])
})

test('regex: backreference', () => {
  is(parseRegex('(a)\\1'), ['seq', ['()', 'a', 1], ['\\1']])
  is(parseRegex('(.)\\1'), ['seq', ['()', ['.'], 1], ['\\1']])
})

test('regex: complex patterns', () => {
  const email = parseRegex('\\w+@\\w+\\.\\w+')
  is(email[0], 'seq')
  is(email[1], ['+', ['\\w']])

  const num = parseRegex('-?\\d+\\.?\\d*')
  is(num[0], 'seq')

  const hex = parseRegex('#[0-9a-fA-F]{6}')
  is(hex[0], 'seq')
  is(hex[1], '#')
  is(hex[2][0], '{}')
  is(hex[2][2], 6)
})

test('regex: flags stored', () => {
  const ast = parseRegex('abc', 'gi')
  is(ast.flags, 'gi')
})

test('regex: group count', () => {
  const ast = parseRegex('(a)(b)(c)')
  is(ast.groups, 3)

  const ast2 = parseRegex('(?:a)(b)')
  is(ast2.groups, 1)
})

test('regex: errors', () => {
  throws(() => parseRegex('[abc'), /Unclosed/)
  throws(() => parseRegex('(abc'), /Unclosed/)
  throws(() => parseRegex('(?abc)'), /Invalid group/)
})

test('regex: empty pattern', () => {
  is(parseRegex(''), ['seq'])
})

test('regex: word boundary', () => {
  is(parseRegex('\\b'), ['\\b'])
  is(parseRegex('\\bword\\b'), ['seq', ['\\b'], 'w', 'o', 'r', 'd', ['\\b']])
})

test('regex: hex/unicode escapes', () => {
  is(parseRegex('\\x41'), ['seq', 'A'])
  is(parseRegex('\\u0041'), ['seq', 'A'])
  is(parseRegex('[\\x41-\\x5A]'), ['[]', ['-', 'A', 'Z']])
})

// === Codegen tests ===

test('regex: compile literal', () => {
  const ast = parseRegex('abc')
  const wat = compileRegex(ast)
  is(wat.includes('func $regex_match'), true)
  is(wat.includes('i32.const 97'), true)
  is(wat.includes('i32.const 98'), true)
  is(wat.includes('i32.const 99'), true)
})

test('regex: compile char class', () => {
  const ast = parseRegex('[a-z]')
  const wat = compileRegex(ast)
  is(wat.includes('i32.ge_u'), true)
  is(wat.includes('i32.le_u'), true)
})

test('regex: compile quantifier', () => {
  const ast = parseRegex('a+')
  const wat = compileRegex(ast)
  is(wat.includes('loop'), true)
})

test('regex: compile alternation', () => {
  const ast = parseRegex('a|b')
  const wat = compileRegex(ast)
  is(wat.includes('block $alt'), true)
})

test('regex: compile capture group', () => {
  const ast = parseRegex('(a)')
  const wat = compileRegex(ast)
  is(wat.includes('$g1_start'), true)
  is(wat.includes('$g1_end'), true)
})

test('regex: compile \\d', () => {
  const ast = parseRegex('\\d+')
  const wat = compileRegex(ast)
  is(wat.includes('i32.const 48'), true)
  is(wat.includes('i32.const 57'), true)
})

test('regex: compile word boundary', () => {
  const ast = parseRegex('\\bword\\b')
  const wat = compileRegex(ast)
  is(wat.includes('i32.xor'), true)
})

test('regex: compile backreference', () => {
  const ast = parseRegex('(.)\\1')
  const wat = compileRegex(ast)
  is(wat.includes('$g1_start'), true)
  is(wat.includes('$g1_end'), true)
  is(wat.includes('$br_i'), true)
})

// === Integration tests ===

test('regex: basic test()', async () => {
  is(await evaluate('/abc/.test("hello abc world")'), 1)
  is(await evaluate('/abc/.test("hello xyz world")'), 0)
})

test('regex: module-level variable test()', () => {
  const r = jz('const re = /abc/; export let f = (s) => re.test(s)')
  const m = r.memory
  is(r.exports.f(m.String('xabcx')), 1)
  is(r.exports.f(m.String('xyz')), 0)
})

test('regex: anchors', async () => {
  is(await evaluate('/^hello/.test("hello world")'), 1)
  is(await evaluate('/^world/.test("hello world")'), 0)
  is(await evaluate('/world$/.test("hello world")'), 1)
})

test('regex: quantifiers', async () => {
  is(await evaluate('/ab*c/.test("ac")'), 1)
  is(await evaluate('/ab*c/.test("abc")'), 1)
  is(await evaluate('/ab+c/.test("ac")'), 0)
  is(await evaluate('/ab+c/.test("abc")'), 1)
  is(await evaluate('/ab?c/.test("ac")'), 1)
})

test('regex: character classes', async () => {
  is(await evaluate('/[abc]/.test("b")'), 1)
  is(await evaluate('/[abc]/.test("d")'), 0)
  is(await evaluate('/[a-z]/.test("m")'), 1)
  is(await evaluate('/[^abc]/.test("d")'), 1)
})

test('regex: alternation', async () => {
  is(await evaluate('/cat|dog/.test("I have a cat")'), 1)
  is(await evaluate('/cat|dog/.test("I have a dog")'), 1)
  is(await evaluate('/cat|dog/.test("I have a bird")'), 0)
})

test('regex: escape sequences', async () => {
  is(await evaluate('/\\d/.test("abc123")'), 1)
  is(await evaluate('/\\d/.test("abc")'), 0)
  is(await evaluate('/\\w/.test("_test")'), 1)
  is(await evaluate('/\\s/.test("hello world")'), 1)
})

test('regex: stored in variable', () => {
  const wasm1 = compile('export let test = () => { let r = /abc/; return r.test("xabcy") }')
  is(new WebAssembly.Instance(new WebAssembly.Module(wasm1)).exports.test(), 1)
  const wasm2 = compile('export let test = () => { let r = /xyz/; return r.test("abc") }')
  is(new WebAssembly.Instance(new WebAssembly.Module(wasm2)).exports.test(), 0)
})

test('regex: str.search()', async () => {
  is(await evaluate('"hello world".search(/world/)'), 6)
  is(await evaluate('"hello world".search(/xyz/)'), -1)
  is(await evaluate('"abc123def".search(/\\d+/)'), 3)
  is(await evaluate('"test".search(/^test$/)'), 0)
})

test('regex: str.replace(regex, str)', () => {
  is(evalStr('"hello world".replace(/world/, "there")'), 'hello there')
  is(evalStr('"abc123".replace(/\\d+/, "NUM")'), 'abcNUM')
  is(evalStr('"foo bar".replace(/o/, "0")'), 'f0o bar')
})

test('regex: str.replace(str, str) fallback through __str_replace', () => {
  // search arg is a non-regex value → resolveRegex returns null and the
  // .string:replace emitter falls through to __str_replace, which takes
  // (i64, i64, i64). Args must be passed as i64 string handles, not f64.
  const wasm = compile(`
    let s = "hello world", q = "world", r = "there"
    export let a = () => s.replace(q, r)
    export let b = () => "abc123def".replace("123", "-")
  `)
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod)
  const m = jz.memory({ module: mod, instance: inst })
  is(m.read(inst.exports.a()), 'hello there')
  is(m.read(inst.exports.b()), 'abc-def')
})

test('regex: str.split(regex)', async () => {
  is(await evaluate('"a1b2c3".split(/\\d/).length'), 4)
  is(await evaluate('"one  two   three".split(/\\s+/).length'), 3)
  is(await evaluate('"a,b;c".split(/[,;]/).length'), 3)
})

test('regex: regex.exec()', async () => {
  is(evalStr('/abc/.exec("xabcy")[0]'), 'abc')
  is(await evaluate('/xyz/.exec("abc")'), 0)
})

test('regex: str.match(regex)', async () => {
  is(evalStr('"hello world".match(/world/)[0]'), 'world')
  is(await evaluate('"hello".match(/xyz/)'), 0)
})
