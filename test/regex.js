import test, { is, throws } from 'tst'
import { parseRegex, compileRegex } from '../src/regex.js'

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
  is(parseRegex('[a-]'), ['[]', 'a', '-']) // dash at end is literal
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
  // Groups numbered in order of opening paren (left to right)
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
  // Email-like: \w+@\w+\.\w+
  const email = parseRegex('\\w+@\\w+\\.\\w+')
  is(email[0], 'seq')
  is(email[1], ['+', ['\\w']])

  // Number: -?\d+\.?\d*
  const num = parseRegex('-?\\d+\\.?\\d*')
  is(num[0], 'seq')

  // Hex color: #[0-9a-fA-F]{6}
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
  is(wat.includes('i32.const 97'), true)  // 'a'
  is(wat.includes('i32.const 98'), true)  // 'b'
  is(wat.includes('i32.const 99'), true)  // 'c'
})

test('regex: compile char class', () => {
  const ast = parseRegex('[a-z]')
  const wat = compileRegex(ast)
  is(wat.includes('i32.ge_u'), true)  // range check
  is(wat.includes('i32.le_u'), true)
})

test('regex: compile quantifier', () => {
  const ast = parseRegex('a+')
  const wat = compileRegex(ast)
  is(wat.includes('loop'), true)  // repetition loop
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

test('regex: compile lookahead', () => {
  const ast = parseRegex('a(?=b)')
  const wat = compileRegex(ast)
  is(wat.includes('local.set $save'), true)  // position save
})

test('regex: compile \\d', () => {
  const ast = parseRegex('\\d+')
  const wat = compileRegex(ast)
  is(wat.includes('i32.const 48'), true)   // '0'
  is(wat.includes('i32.const 57'), true)   // '9'
})

test('regex: compile word boundary', () => {
  const ast = parseRegex('\\bword\\b')
  const wat = compileRegex(ast)
  is(wat.includes('i32.xor'), true)  // boundary detection
})

test('regex: compile backreference', () => {
  const ast = parseRegex('(.)\\1')
  const wat = compileRegex(ast)
  is(wat.includes('$g1_start'), true)
  is(wat.includes('$g1_end'), true)
  is(wat.includes('$br_i'), true)  // backref loop counter
})

// Integration tests - regex in jz code
import { evaluate } from './util.js'

test('regex integration: basic test()', async () => {
  is(await evaluate('/abc/.test("hello abc world")'), 1)
  is(await evaluate('/abc/.test("hello xyz world")'), 0)
})

test('regex integration: anchors', async () => {
  is(await evaluate('/^hello/.test("hello world")'), 1)
  is(await evaluate('/^world/.test("hello world")'), 0)
  is(await evaluate('/world$/.test("hello world")'), 1)
})

test('regex integration: quantifiers', async () => {
  is(await evaluate('/ab*c/.test("ac")'), 1)
  is(await evaluate('/ab*c/.test("abc")'), 1)
  is(await evaluate('/ab+c/.test("ac")'), 0)
  is(await evaluate('/ab+c/.test("abc")'), 1)
  is(await evaluate('/ab?c/.test("ac")'), 1)
})

test('regex integration: character classes', async () => {
  is(await evaluate('/[abc]/.test("b")'), 1)
  is(await evaluate('/[abc]/.test("d")'), 0)
  is(await evaluate('/[a-z]/.test("m")'), 1)
  is(await evaluate('/[^abc]/.test("d")'), 1)
})

test('regex integration: alternation', async () => {
  is(await evaluate('/cat|dog/.test("I have a cat")'), 1)
  is(await evaluate('/cat|dog/.test("I have a dog")'), 1)
  is(await evaluate('/cat|dog/.test("I have a bird")'), 0)
})

test('regex integration: escape sequences', async () => {
  is(await evaluate('/\\d/.test("abc123")'), 1)
  is(await evaluate('/\\d/.test("abc")'), 0)
  is(await evaluate('/\\w/.test("_test")'), 1)
  is(await evaluate('/\\s/.test("hello world")'), 1)
})

test('regex integration: stored in variable', async () => {
  is(await evaluate('let r = /abc/; r.test("xabcy")'), 1)
  is(await evaluate('let r = /xyz/; r.test("abc")'), 0)
})

// str.search(regex) tests
test('regex integration: str.search()', async () => {
  is(await evaluate('"hello world".search(/world/)'), 6)
  is(await evaluate('"hello world".search(/xyz/)'), -1)
  is(await evaluate('"abc123def".search(/\\d+/)'), 3)
  is(await evaluate('"test".search(/^test$/)'), 0)
})

// str.split(regex) tests
test('regex integration: str.split(regex)', async () => {
  is(await evaluate('"a1b2c3".split(/\\d/).length'), 4)  // ["a", "b", "c", ""]
  is(await evaluate('"one  two   three".split(/\\s+/).length'), 3)
  is(await evaluate('"a,b;c".split(/[,;]/).length'), 3)
})

// str.replace(regex, str) tests
test('regex integration: str.replace(regex, str)', async () => {
  is(await evaluate('"hello world".replace(/world/, "there")'), 'hello there')
  is(await evaluate('"abc123".replace(/\\d+/, "NUM")'), 'abcNUM')
  is(await evaluate('"foo bar".replace(/o/, "0")'), 'f0o bar')  // only first match
})

// regex.exec(str) tests
test('regex integration: regex.exec()', async () => {
  // Basic match returns array with full match
  is(await evaluate('/abc/.exec("xabcy")[0]'), 'abc')
  // No match returns null (0)
  is(await evaluate('/xyz/.exec("abc")'), 0)
})

// str.match(regex) tests
test('regex integration: str.match(regex)', async () => {
  // Basic match
  is(await evaluate('"hello world".match(/world/)[0]'), 'world')
  // No match returns null
  is(await evaluate('"hello".match(/xyz/)'), 0)
})
