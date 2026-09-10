import test from 'tst'
import { is, throws } from 'tst/assert.js'
import { parseRegex, compileRegex } from '../module/regex.js'
import { evaluate, cases } from './util.js'
import jz, { compile } from '../index.js'
import { adaptI64, onKernel, levels } from './_matrix.js'

/** Compile + run, read result via jz.memory (for string-returning expressions) */
function evalStr(code) {
  const wasm = compile(`export let main = () => ${code}`)
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod)
  inst.exports._initialize?.()  // wasi leg: reactor init (js leg ran the start section)
  const m = jz.memory({ module: mod, instance: inst })
  return m.read(adaptI64(mod, inst.exports).main())
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

test('regex: left brace literals', () => {
  is(parseRegex('a{'), ['seq', 'a', '{'])
  is(parseRegex('a{b'), ['seq', 'a', '{', 'b'])
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

test('regex: named capture groups', () => {
  const ast = parseRegex('(?<word>\\w+)')
  // The capture name rides the group node itself (4th element) — the AST structure
  // survives the parse→compile handoff under self-compile, whereas module-level parse
  // state (the groupNames array) does not. ast.groupNames stays populated too.
  is(ast, ['()', ['+', ['\\w']], 1, 'word'])
  is(ast.groups, 1)
  is(ast.groupNames[1], 'word')
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
  is(await evaluate('/abc/.test("hello abc world")'), true)
  is(await evaluate('/abc/.test("hello xyz world")'), false)
})

test('regex: module-level variable test()', () => {
  const r = jz('const re = /abc/; export let f = (s) => re.test(s)')
  const m = r.memory
  is(r.exports.f(m.String('xabcx')), true)
  is(r.exports.f(m.String('xyz')), false)
})

test('regex: RegExp constructor accepts const string expressions', () => {
  const r = jz(`
    const prefix = "ab"
    const flags = "i"
    const re = new RegExp("^" + prefix + "c$", flags)
    export let f = () => re.test("ABC") * 10 + re.test("xbc")
  `)
  is(r.exports.f(), 10)
})

test('regex: RegExp constructor folds template with const array join', () => {
  const r = jz(`
    export let f = () => {
      const codes = ["PB", "PC"]
      const re = new RegExp(\`^(\${codes.join("|")})$\`)
      return re.test("PB") * 10 + re.test("PX")
    }
  `)
  is(r.exports.f(), 10)
})

test('regex: RegExp constructor folds jzified var string assignment', () => {
  const r = jz(`
    var source = "cat|dog"
    export let f = () => new RegExp(source).test("dog")
  `, { jzify: true })
  is(r.exports.f(), true)
})

test('regex: RegExp constructor folds jzified hoisted var template parts', () => {
  const r = jz(`
    var left = "cat"
    var right = "dog"
    function matches(value) {
      return new RegExp(\`^(\${left}|\${right})$\`, "i").test(value)
    }
    export let f = () => matches("DOG") * 10 + matches("bird")
  `, { jzify: true })
  is(r.exports.f(), 10)
})

test('regex: anchors', async () => {
  is(await evaluate('/^hello/.test("hello world")'), true)
  is(await evaluate('/^world/.test("hello world")'), false)
  is(await evaluate('/world$/.test("hello world")'), true)
})

test('regex: quantifiers', async () => {
  is(await evaluate('/ab*c/.test("ac")'), true)
  is(await evaluate('/ab*c/.test("abc")'), true)
  is(await evaluate('/ab+c/.test("ac")'), false)
  is(await evaluate('/ab+c/.test("abc")'), true)
  is(await evaluate('/ab?c/.test("ac")'), true)
})

test('regex: left brace literal test()', async () => {
  is(await evaluate('/a{/.test("a{")'), true)
  is(await evaluate('/a{b/.test("a{b")'), true)
  is(await evaluate('/a{2}/.test("aa")'), true)
})

test('regex: character classes', async () => {
  is(await evaluate('/[abc]/.test("b")'), true)
  is(await evaluate('/[abc]/.test("d")'), false)
  is(await evaluate('/[a-z]/.test("m")'), true)
  is(await evaluate('/[^abc]/.test("d")'), true)
})

test('regex: alternation', async () => {
  is(await evaluate('/cat|dog/.test("I have a cat")'), true)
  is(await evaluate('/cat|dog/.test("I have a dog")'), true)
  is(await evaluate('/cat|dog/.test("I have a bird")'), false)
})

test('regex: escape sequences', async () => {
  is(await evaluate('/\\d/.test("abc123")'), true)
  is(await evaluate('/\\d/.test("abc")'), false)
  is(await evaluate('/\\w/.test("_test")'), true)
  is(await evaluate('/\\s/.test("hello world")'), true)
})

test('regex: stored in variable', () => {
  is(jz('export let f = () => { let r = /abc/; return r.test("xabcy") }').exports.f(), true)
  is(jz('export let f = () => { let r = /xyz/; return r.test("abc") }').exports.f(), false)
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
  inst.exports._initialize?.()  // wasi leg: reactor init (js leg ran the start section)
  const m = jz.memory({ module: mod, instance: inst })
  const exports = adaptI64(mod, inst.exports)
  is(m.read(exports.a()), 'hello there')
  is(m.read(exports.b()), 'abc-def')
})

test('regex: str.split(regex)', async () => {
  is(await evaluate('"a1b2c3".split(/\\d/).length'), 4)
  is(await evaluate('"one  two   three".split(/\\s+/).length'), 3)
  is(await evaluate('"a,b;c".split(/[,;]/).length'), 3)
})

test('regex: regex.exec()', async () => {
  is(evalStr('/abc/.exec("xabcy")[0]'), 'abc')
  // exec() returns null on no-match (matches JS; was 0 before exec() returned NULL_NAN)
  is(await evaluate('/xyz/.exec("abc")'), null)
})

test('regex: regex.exec() named capture groups', async () => {
  is(evalStr('/^(?<kind>\\w+)-(?<id>\\d+)$/.exec("item-42").groups.kind'), 'item')
  is(evalStr('/^(?<kind>\\w+)-(?<id>\\d+)$/.exec("item-42").groups.id'), '42')
  is(await evaluate('/(?<a>a).|(?<x>x)/.exec("ab").groups.x'), undefined)
})

test('regex: str.match(regex)', async () => {
  is(evalStr('"hello world".match(/world/)[0]'), 'world')
  is(await evaluate('"hello".match(/xyz/)'), 0)
})

test('regex: str.match(regex) named capture groups', () => {
  is(evalStr('"item:abc-123".match(/^item:(?<slug>[\\w-]+)$/).groups.slug'), 'abc-123')
})

// ============================================================================
// Stress tests — real-world patterns, edge cases, conformance
// (PCRE/Perl test vectors, validation patterns, backtracking edges)
// ============================================================================

test('regex stress: quantifiers / anchors / alternation / groups / classes', () => {
  cases([
    // === Greedy vs lazy quantifiers ===
    ['greedy * matches maximally: aXXXb', '() => /a.*b/.test("aXXXb")', true],
    ['greedy * matches maximally: ab', '() => /a.*b/.test("ab")', true],
    ['greedy * matches maximally: a', '() => /a.*b/.test("a")', false],
    ['lazy *? matches minimally: aXXXb', '() => /a.*?b/.test("aXXXb")', true],
    ['lazy *? matches minimally: ab', '() => /a.*?b/.test("ab")', true],
    ['greedy + requires at least one: aXb', '() => /a.+b/.test("aXb")', true],
    ['greedy + requires at least one: ab', '() => /a.+b/.test("ab")', false],
    // === Repetition {n,m} ===
    ['exact repetition {n}: aaa', '() => /a{3}/.test("aaa")', true],
    ['exact repetition {n}: aa', '() => /a{3}/.test("aa")', false],
    ['exact repetition {n}: aaaa', '() => /a{3}/.test("aaaa")', true],
    ['range repetition {n,m}: aa', '() => /a{2,4}/.test("aa")', true],
    ['range repetition {n,m}: aaaa', '() => /a{2,4}/.test("aaaa")', true],
    ['range repetition {n,m}: a', '() => /a{2,4}/.test("a")', false],
    ['open-ended {n,}: aa', '() => /a{2,}/.test("aa")', true],
    ['open-ended {n,}: aaaaa', '() => /a{2,}/.test("aaaaa")', true],
    ['open-ended {n,}: a', '() => /a{2,}/.test("a")', false],
    // === Anchors ===
    ['^ and $ together: exact', '() => /^exact$/.test("exact")', true],
    ['^ and $ together: not exact', '() => /^exact$/.test("not exact")', false],
    ['^ and $ together: exactly', '() => /^exact$/.test("exactly")', false],
    ['anchor with quantifier: aaaa', '() => /^a+$/.test("aaaa")', true],
    ['anchor with quantifier: aaab', '() => /^a+$/.test("aaab")', false],
    ['anchor with quantifier: empty', '() => /^a+$/.test("")', false],
    // === Alternation edge cases ===
    ['multi-branch alternation: baz', '() => /foo|bar|baz/.test("baz")', true],
    ['multi-branch alternation: qux', '() => /foo|bar|baz/.test("qux")', false],
    ['alternation with anchors: cat', '() => /^(cat|dog)$/.test("cat")', true],
    ['alternation with anchors: catdog', '() => /^(cat|dog)$/.test("catdog")', false],
    // === Nested groups ===
    ['nested quantified groups: ababab', '() => /(ab)+/.test("ababab")', true],
    ['nested quantified groups: abc', '() => /(ab)+/.test("abc")', true],
    ['nested quantified groups: ba', '() => /(ab)+/.test("ba")', false],
    ['non-capturing group: ababc', '() => /(?:ab)+c/.test("ababc")', true],
    ['non-capturing group: abc', '() => /(?:ab)+c/.test("abc")', true],
    ['non-capturing group: ac', '() => /(?:ab)+c/.test("ac")', false],
    // === Character class edge cases ===
    ['char class with special chars: dot', '() => /[.+*?]/.test(".")', true],
    ['char class with special chars: x', '() => /[.+*?]/.test("x")', false],
    ['negated class with range: a', '() => /[^0-9]/.test("a")', true],
    ['negated class with range: 5', '() => /[^0-9]/.test("5")', false],
  ])
})

test('regex stress: \\w \\d \\s combinations', async () => {
  is(await evaluate('/\\w+\\s\\w+/.test("hello world")'), true)
  is(await evaluate('/\\w+\\s\\w+/.test("hello")'), false)
  is(await evaluate('/\\d+\\.\\d+/.test("3.14")'), true)
  is(await evaluate('/\\d+\\.\\d+/.test("314")'), false)
})

test('regex stress: word boundary / dot / empty alternation', () => {
  cases([
    ['word boundary: a word here', '() => /\\bword\\b/.test("a word here")', true],
    ['word boundary: password', '() => /\\bword\\b/.test("password")', false],
    ['word boundary: wordy', '() => /\\bword\\b/.test("wordy")', false],
    ['dot does not match newline: axb', '() => /a.b/.test("axb")', true],
    ['dot does not match newline: aXb', '() => /a.b/.test("aXb")', true],
    ['empty alternation branch: b', '() => /a|/.test("b")', true],
    ['empty alternation branch: a', '() => /a|/.test("a")', true],
  ])
})

// === Real-world patterns ===

test('regex stress: integer pattern', async () => {
  is(await evaluate('/^-?\\d+$/.test("42")'), true)
  is(await evaluate('/^-?\\d+$/.test("-7")'), true)
  is(await evaluate('/^-?\\d+$/.test("3.14")'), false)
  is(await evaluate('/^-?\\d+$/.test("")'), false)
})

test('regex stress: real-world patterns / lookahead / search / split', () => {
  cases([
    // === Real-world patterns ===
    ['hex color: valid lowercase', '() => /^#[0-9a-f]{6}$/.test("#ff00aa")', true],
    ['hex color: uppercase rejected', '() => /^#[0-9a-f]{6}$/.test("#FF00AA")', false],
    ['hex color: too short', '() => /^#[0-9a-f]{6}$/.test("#fff")', false],
    ['simple identifier: leading underscore', '() => /^[a-zA-Z_]\\w*$/.test("_foo123")', true],
    ['simple identifier: leading digit rejected', '() => /^[a-zA-Z_]\\w*$/.test("123abc")', false],
    ['simple identifier: single letter', '() => /^[a-zA-Z_]\\w*$/.test("x")', true],
    ['IP-like pattern: full', '() => /^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test("192.168.1.1")', true],
    ['IP-like pattern: incomplete', '() => /^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test("192.168.1")', false],
    // === Lookahead ===
    ['positive lookahead: matches', '() => /\\d+(?=px)/.test("100px")', true],
    ['positive lookahead: no match', '() => /\\d+(?=px)/.test("100em")', false],
    ['negative lookahead: no px', '() => /\\d+(?!px)/.test("100em")', true],
    ['negative lookahead: not followed by bar', '() => /foo(?!bar)/.test("foobaz")', true],
    ['negative lookahead: followed by bar rejected', '() => /foo(?!bar)/.test("foobar")', false],
    ['search finds correct position: middle', '() => "abc def ghi".search(/def/)', 4],
    ['search finds correct position: no match', '() => "xxxxx".search(/y/)', -1],
    ['search finds correct position: at start', '() => "aaa".search(/a/)', 0],
    ['split with multi-char separator', '() => "a::b::c".split(/::/).length', 3],
    ['split at start/end', '() => "1abc2".split(/\\d/).length', 3],
  ])
})

test('regex stress: replace no match returns original', () => {
  is(evalStr('"hello".replace(/xyz/, "!")'), 'hello')
})

test('regex stress: replace at boundaries', () => {
  is(evalStr('"abc".replace(/^/, "X")'), 'Xabc')
  is(evalStr('"abc".replace(/$/, "X")'), 'abcX')
})

test('regex stress: backtracking', () => {
  cases([
    // First branch "ab" matches at pos 0, but full pattern needs "abc"; must
    // backtrack to try "a" branch.
    ['backtracking in alternation', '() => /(ab|a)c/.test("ac")', true],
    // .* greedily consumes all, then backtracks to match trailing 'c'.
    ['greedy backtrack: abc', '() => /^.*c$/.test("abc")', true],
    ['greedy backtrack: abd', '() => /^.*c$/.test("abd")', false],
  ])
})

// === new RegExp() with literal pattern ===
// `new RegExp("[a-z]+")` and `new RegExp("foo", "i")` lower to the same path
// as `/[a-z]+/` and `/foo/i`. Dynamic patterns can't be compiled at build time
// and must surface a clean error.

test('new RegExp() with literal pattern', () => {
  const r = jz(`export let f = (s) => { let re = new RegExp("[a-z]+"); return re.test(s) }`)
  const m = r.memory
  is(r.exports.f(m.String('abc')), true)
  is(r.exports.f(m.String('123')), false)
})

test('new RegExp() with literal flags', () => {
  const r = jz(`export let f = (s) => { let re = new RegExp("foo", "i"); return re.test(s) }`)
  const m = r.memory
  is(r.exports.f(m.String('FOO')), true)
  is(r.exports.f(m.String('BAR')), false)
})

test('new RegExp(dynamic) errors clearly', () => {
  throws(
    () => jz(`export let f = (s) => { let re = new RegExp(s); return re.test("abc") }`),
    /string-literal pattern|dynamic regex/i
  )
})

// === Regression: exec() /g lastIndex advancement ===

test('regex: exec /g loop collects all matches', () => {
  // JS oracle: while ((m = /ab/g.exec(s))) loop → 3 matches in 'ab cd ab ef ab'
  // Before fix: lastIndex never advanced → infinite loop (count hit safety limit)
  const r = jz(`
    let re = /ab/g
    export let f = (s) => {
      let count = 0, m = re.exec(s)
      while (m !== null) { count++; if (count > 10) return -1; m = re.exec(s) }
      return count
    }
  `)
  const mem = r.memory
  is(r.exports.f(mem.String('ab cd ab ef ab')), 3)  // JS gives 3
  is(r.exports.f(mem.String('xabx')), 1)             // 1 match
  is(r.exports.f(mem.String('no match here')), 0)    // 0 matches; also resets lastIndex
  // After reset, a subsequent call should start fresh
  is(r.exports.f(mem.String('ab')), 1)
})

test('regex: exec /g returns null on no-match (not 0)', async () => {
  // Matches JS: /xyz/.exec("abc") === null
  is(await evaluate('/xyz/.exec("abc")'), null)
})

test('regex: source writes to lastIndex reject instead of splitting state', () => {
  throws(() => compile(`let re = /a/g; re.lastIndex = 2; export let f = () => re.exec('a')`),
    /RegExp.lastIndex assignment is not supported/)
  const { f } = jz(`let o = { lastIndex: 0 }; o.lastIndex = 2; export let f = () => o.lastIndex`).exports
  is(f(), 2, 'ordinary object properties named lastIndex remain writable')
})

test('regex: exec /g lastIndex advances correctly', () => {
  // lastIndex should advance to end of each match
  const r = jz(`
    let re = /\\d+/g
    export let f = (s) => {
      let total = 0, m = re.exec(s)
      while (m !== null) {
        total += m[0].length
        if (total > 100) return -1
        m = re.exec(s)
      }
      return total
    }
  `)
  const mem = r.memory
  // '12 345 6' → matches '12'(len 2), '345'(len 3), '6'(len 1) → total 6
  const jsOracle = (() => { const re = /\d+/g, s = '12 345 6'; let t = 0, m; while ((m = re.exec(s))) t += m[0].length; return t })()
  is(r.exports.f(mem.String('12 345 6')), jsOracle)
})

// === Regression: \s missing VT (0x0B) and FF (0x0C) ===

test('regex: \\s matches VT (\\x0B) and FF (\\x0C)', () => {
  // JS: /\s/.test('\x0B') === true, /\s/.test('\x0C') === true
  // Before fix: only matched SP TAB LF CR
  const r = jz(`export let f = (s) => /\\s/.test(s)`)
  const mem = r.memory
  is(r.exports.f(mem.String('\x0B')), true)  // VT — was false before fix
  is(r.exports.f(mem.String('\x0C')), true)  // FF — was false before fix
  is(r.exports.f(mem.String(' ')),   true)   // SP still matches
  is(r.exports.f(mem.String('\t')),  true)   // TAB still matches
  is(r.exports.f(mem.String('\n')),  true)   // LF still matches
  is(r.exports.f(mem.String('\r')),  true)   // CR still matches
  is(r.exports.f(mem.String('a')),   false)  // non-whitespace still fails
})

test('regex: \\s class / split on VT and FF', () => {
  cases([
    // \s inside character class should also get VT/FF
    ['[\\s] class also matches VT and FF: VT', '(s) => /[\\s]/.test(s)', true, '\x0B'],
    ['[\\s] class also matches VT and FF: FF', '(s) => /[\\s]/.test(s)', true, '\x0C'],
    // 'a\x0Bb'.split(/\s+/) in JS → ['a', 'b'] (VT is whitespace)
    ['split on \\s+ splits on VT and FF: VT', '(s) => s.split(/\\s+/).length', 2, 'a\x0Bb'],
    ['split on \\s+ splits on VT and FF: FF', '(s) => s.split(/\\s+/).length', 2, 'a\x0Cb'],
  ])
})

test('regex: replace with a function replacer (single + /g)', () => {
  const run = src => jz(src).exports.f
  is(run('export let f = (s) => s.replace(/l/, (m) => m.toUpperCase())')('hello'),
    'hello'.replace(/l/, m => m.toUpperCase()))        // 'heLlo' — first match
  is(run('export let f = (s) => s.replace(/l/g, (m) => m.toUpperCase())')('hello'),
    'hello'.replace(/l/g, m => m.toUpperCase()))        // 'heLLo' — all matches
  is(run('export let f = (s) => s.replace(/[aeiou]/g, (v) => "[" + v + "]")')('hello'),
    'hello'.replace(/[aeiou]/g, v => '[' + v + ']'))    // 'h[e]ll[o]'
  is(run('export let f = (s) => s.replace(/z/g, (m) => m)')('hello'),
    'hello'.replace(/z/g, m => m))                       // no match → unchanged
})

test('regex: replace callback receives capture groups + offset + string (ES 22.1.3.19)', () => {
  const run = src => jz(src).exports.f
  // Was: only the match was passed — groups read `undefined` (the self-compile
  // kernel's decodeIdent errs on any regex literal with \uXXXX because of it).
  is(run('export let f = (s) => s.replace(/Q([0-9a-fA-F]{4})/g, (m, p, o, str) => m + "|" + p + "|" + o + "|" + str)')('xQ0041y'),
    'xQ0041y'.replace(/Q([0-9a-fA-F]{4})/g, (m, p, o, str) => m + '|' + p + '|' + o + '|' + str))
  // Unmatched alternation group arrives as undefined (the decodeIdent shape).
  is(run('export let f = (s) => s.replace(/Q\\{([0-9a-fA-F]+)\\}|Q([0-9a-fA-F]{4})/g, (m, b, p) => String.fromCodePoint(parseInt(b || p, 16)))')('AQ0042B'),
    'AQ0042B'.replace(/Q\{([0-9a-fA-F]+)\}|Q([0-9a-fA-F]{4})/g, (m, b, p) => String.fromCodePoint(parseInt(b || p, 16))))
  // Optional group unmatched mid-string; non-/g replaces the first match only.
  is(run('export let f = (s) => s.replace(/X(b)?/, (m, g) => "[" + (g === undefined ? "-" : g) + "]")')('aXbXc'),
    'aXbXc'.replace(/X(b)?/, (m, g) => '[' + (g === undefined ? '-' : g) + ']'))
  is(run('export let f = (s) => s.replace(/X(b)?/g, (m, g) => "[" + (g === undefined ? "-" : g) + "]")')('aXbXcX'),
    'aXbXcX'.replace(/X(b)?/g, (m, g) => '[' + (g === undefined ? '-' : g) + ']'))
  // String-search callback form gets (match, offset, string).
  is(run('export let f = (s) => s.replace("world", (m, o, str) => m.toUpperCase() + "@" + o + "/" + str.length)')('hello world'),
    'hello world'.replace('world', (m, o, str) => m.toUpperCase() + '@' + o + '/' + str.length))
})

test('regex: quantifier capture reset / \\uXXXX escapes', () => {
  cases([
    // A later iteration matching the OTHER alternation branch clears the group.
    ['quantifier attempts reset contained captures (ES RepeatMatcher): alternation clears group',
      '(s) => { let m = /(?:(a)|b)+/.exec(s); return typeof m[1] }', 'undefined', 'ab'],
    // A failed extra attempt restores the last successful iteration's capture.
    ['quantifier attempts reset contained captures (ES RepeatMatcher): failed attempt restores capture',
      '(s) => { let m = /(b)+x/.exec(s); return m[1] }', 'b', 'bbx'],
    // Failed-branch partial writes must not leak into later matches (/g walk).
    ['quantifier attempts reset contained captures (ES RepeatMatcher): failed-branch writes do not leak',
      '(s) => s.replace(/(a)(z)?|X/g, (m, g1, g2) => "[" + g1 + "," + g2 + "]")',
      'abXcd'.replace(/(a)(z)?|X/g, (m, g1, g2) => '[' + g1 + ',' + g2 + ']'), 'abXcd'],
    // The pattern atom keeps raw \uHHHH from the parser; decodeIdent normalizes
    // it via IDESC replace — the shape that failed in-kernel before groups flowed.
    ['\\uXXXX escapes in regex literals compile and match: matches', '(s) => /\\u0041B/.test(s) ? 1 : 0', 1, 'xABy'],
    ['\\uXXXX escapes in regex literals compile and match: no match', '(s) => /\\u0041B/.test(s) ? 1 : 0', 0, 'xaBy'],
    ['\\uXXXX escapes in regex literals compile and match: class range replace',
      '(s) => s.replace(/[\\u0030-\\u0039]+/g, "#")', 'a12b345c'.replace(/[0-9]+/g, '#'), 'a12b345c'],
  ])
})

test('regex: matchAll collects all matches', () => {
  const run = src => jz(src).exports.f
  is(run('export let f = (s) => [...s.matchAll(/\\d+/g)].length')('a1b22c333'), 3)
  is(run('export let f = (s) => { let o = ""; for (const m of s.matchAll(/\\d+/g)) o = o + m[0] + ","; return o }')('a1b22c333'),
    '1,22,333,')
  // capture groups: each match array carries [full, g1, g2, …]
  is(run('export let f = (s) => { let a = [...s.matchAll(/(\\w)(\\d)/g)]; return a[0][1] + a[0][2] + a[1][1] + a[1][2] }')('a1b2'),
    'a1b2')
  is(run('export let f = (s) => [...s.matchAll(/z/g)].length')('hello'), 0)
})

test('regex: matchAll on an UNTYPED receiver (the generic-twin dispatch)', () => {
  // A receiver the static types can't pin (dyn-table read, typeof-continue
  // narrowing) must still scan: with only the `.string:` emitter registered,
  // the untyped path fell to the dyn-prop probe, yielded undefined, and
  // for-of swallowed it SILENTLY — the self-compile kernel's global-snapshot
  // sweep scanned zero templates (byte-parity divergence root #2).
  const src = `
const table = { a: '(global.set $__heap_end) call $__memgrow', b: () => '(global.set $__heap)' }
export let sweep = () => {
  let out = ''
  for (const name of ['a', 'b', 'c']) {
    let src = table[name]
    if (typeof src === 'function') src = src()
    if (typeof src !== 'string') continue
    for (const m of src.matchAll(/\\(global\\.set \\$([A-Za-z0-9_.$]+)/g)) out += m[1] + ' '
  }
  return out
}`
  for (const optimize of levels(0, 2))
    is(jz(src, { optimize }).exports.sweep(), '__heap_end __heap ', `O${optimize}: untyped receiver scans`)
})

// ============================================================================
// Sticky /y anchoring + \p rejection + matchAll /g gate (2026-07-10).
// /y previously scanned forward like /g (silently identical); \p{…} silently
// matched the literal text "p{…}"; matchAll without /g scanned like /g instead
// of the spec TypeError. All three were silent-wrong — now anchored/rejected.
// ============================================================================

test('regex: sticky /y anchors at lastIndex, no forward scan', () => {
  is(jz(`let re = /a/y; export let f = () => re.test("ba") ? 1 : 0`).exports.f(), 0)
  is(jz(`let re = /a/y; export let f = () => re.test("ab") ? 1 : 0`).exports.f(), 1)
  // exec advances lastIndex per match; third attempt sits on 'x' and fails
  is(jz(`let re = /\\d/y; export let f = () => {
    let a = re.exec("12x"); let b = re.exec("12x"); let c = re.exec("12x")
    return (a ? 1 : 0) * 100 + (b ? 1 : 0) * 10 + (c ? 1 : 0) }`).exports.f(), 110)
  // /g keeps scanning
  is(jz(`let re = /a/g; export let f = () => re.test("ba") ? 1 : 0`).exports.f(), 1)
})

test('regex: \p property escapes reject (both contexts)', () => {
  // audit-#11 item 7 sub-4 (test:wasm classification): a compile-time error's
  // MESSAGE TEXT does not survive the self-compiled kernel's wasm-ABI round
  // trip — only the error CLASS does (same "internal errors are still codes"
  // boundary the Error-object model documents elsewhere for RUNTIME errors;
  // this is the compile-time-error analog, since the kernel's own compile()
  // call runs the throw INSIDE wasm too). The kernel leg checks SyntaxError
  // fires; native additionally pins the exact wording.
  const expected = onKernel() ? new SyntaxError() : /property escape/
  throws(() => jz(`export let f = () => /\\p{L}/.test("a") ? 1 : 0`), expected)
  throws(() => jz(`export let f = () => /[\\p{L}]/.test("a") ? 1 : 0`), expected)
})

test('regex: matchAll requires /g at compile time', () => {
  throws(() => jz(`export let f = () => "a1".matchAll(/\\d/).length`), /\/g flag/)
  is(jz(`export let f = () => "a1b2".matchAll(/\\d/g).length`).exports.f(), 2)
})

// Named backreferences \k<name> (2026-07-11, Ring 2): resolved at parse time to
// the group's NUMBERED backref node (the VM's existing \1-\9 machinery), so
// forward references work and undefined names reject cleanly.
test('regex: \\k<name> named backreferences', () => {
  is(jz(`export let f = () => /(?<a>x)\\k<a>/.test("xx") ? 1 : 0`).exports.f(), 1)
  is(jz(`export let f = () => /(?<a>x)\\k<a>/.test("xy") ? 1 : 0`).exports.f(), 0)
  is(jz(`export let f = () => /(?<q>['"]).*?\\k<q>/.test("say 'hi' ok") ? 1 : 0`).exports.f(), 1)  // quote-matching idiom
  is(jz(`export let f = () => /\\k<a>(?<a>x)/.test("x") ? 1 : 0`).exports.f(), 1)  // forward ref
  // audit-#11 item 7 sub-4: see the property-escapes test above — compile-time
  // error message text doesn't survive the kernel's wasm-ABI round trip.
  throws(() => jz(`export let f = () => /\\k<nope>x/.test("x")`), onKernel() ? new SyntaxError() : /undefined group/)
})

// RegExp.escape (ES2025): spec escape sets over UTF-8 bytes — first-char alnum
// and other-punctuators/space → \xHH (lowercase), SyntaxCharacter+/ → \-prefix,
// t/n/v/f/r → control escapes. Verified against host RegExp.escape.
test('regex: RegExp.escape', () => {
  const j = (code) => jz(code).exports.f()
  is(j(`export let f = () => RegExp.escape("a.b*c")`), '\\x61\\.b\\*c')
  is(j(`export let f = () => RegExp.escape("(hi)|[ok]")`), '\\(hi\\)\\|\\[ok\\]')
  is(j(`export let f = () => RegExp.escape("1a")`), '\\x31a')          // leading digit
  is(j(`export let f = () => RegExp.escape("a\tb")`), '\\x61\\tb')     // real TAB → \t
  is(j(`export let f = () => RegExp.escape("a b'")`), '\\x61\\x20b\\x27')
  is(j(`export let f = () => RegExp.escape("_zZ9")`), '_zZ9')          // non-first alnum passthrough
  is(j(`export let f = () => RegExp.escape("").length`), 0)
})
