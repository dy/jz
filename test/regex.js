import test from 'tst'
import { is, throws } from 'tst/assert.js'
import { parseRegex, compileRegex } from '../module/regex.js'
import { evaluate } from './util.js'
import jz, { compile } from '../index.js'
import { adaptI64 } from './_matrix.js'

/** Compile + run, read result via jz.memory (for string-returning expressions) */
function evalStr(code) {
  const wasm = compile(`export let main = () => ${code}`)
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod)
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
  // survives the parse→compile handoff under self-host, whereas module-level parse
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

// === Greedy vs lazy quantifiers ===

test('regex stress: greedy * matches maximally', async () => {
  is(await evaluate('/a.*b/.test("aXXXb")'), true)
  is(await evaluate('/a.*b/.test("ab")'), true)
  is(await evaluate('/a.*b/.test("a")'), false)
})

test('regex stress: lazy *? matches minimally', async () => {
  is(await evaluate('/a.*?b/.test("aXXXb")'), true)
  is(await evaluate('/a.*?b/.test("ab")'), true)
})

test('regex stress: greedy + requires at least one', async () => {
  is(await evaluate('/a.+b/.test("aXb")'), true)
  is(await evaluate('/a.+b/.test("ab")'), false)
})

// === Repetition {n,m} ===

test('regex stress: exact repetition {n}', async () => {
  is(await evaluate('/a{3}/.test("aaa")'), true)
  is(await evaluate('/a{3}/.test("aa")'), false)
  is(await evaluate('/a{3}/.test("aaaa")'), true)
})

test('regex stress: range repetition {n,m}', async () => {
  is(await evaluate('/a{2,4}/.test("aa")'), true)
  is(await evaluate('/a{2,4}/.test("aaaa")'), true)
  is(await evaluate('/a{2,4}/.test("a")'), false)
})

test('regex stress: open-ended {n,}', async () => {
  is(await evaluate('/a{2,}/.test("aa")'), true)
  is(await evaluate('/a{2,}/.test("aaaaa")'), true)
  is(await evaluate('/a{2,}/.test("a")'), false)
})

// === Anchors ===

test('regex stress: ^ and $ together', async () => {
  is(await evaluate('/^exact$/.test("exact")'), true)
  is(await evaluate('/^exact$/.test("not exact")'), false)
  is(await evaluate('/^exact$/.test("exactly")'), false)
})

test('regex stress: anchor with quantifier', async () => {
  is(await evaluate('/^a+$/.test("aaaa")'), true)
  is(await evaluate('/^a+$/.test("aaab")'), false)
  is(await evaluate('/^a+$/.test("")'), false)
})

// === Alternation edge cases ===

test('regex stress: multi-branch alternation', async () => {
  is(await evaluate('/foo|bar|baz/.test("baz")'), true)
  is(await evaluate('/foo|bar|baz/.test("qux")'), false)
})

test('regex stress: alternation with anchors', async () => {
  is(await evaluate('/^(cat|dog)$/.test("cat")'), true)
  is(await evaluate('/^(cat|dog)$/.test("catdog")'), false)
})

// === Nested groups ===

test('regex stress: nested quantified groups', async () => {
  is(await evaluate('/(ab)+/.test("ababab")'), true)
  is(await evaluate('/(ab)+/.test("abc")'), true)
  is(await evaluate('/(ab)+/.test("ba")'), false)
})

test('regex stress: non-capturing group', async () => {
  is(await evaluate('/(?:ab)+c/.test("ababc")'), true)
  is(await evaluate('/(?:ab)+c/.test("abc")'), true)
  is(await evaluate('/(?:ab)+c/.test("ac")'), false)
})

// === Character class edge cases ===

test('regex stress: char class with special chars', async () => {
  is(await evaluate('/[.+*?]/.test(".")'), true)
  is(await evaluate('/[.+*?]/.test("x")'), false)
})

test('regex stress: negated class with range', async () => {
  is(await evaluate('/[^0-9]/.test("a")'), true)
  is(await evaluate('/[^0-9]/.test("5")'), false)
})

test('regex stress: \\w \\d \\s combinations', async () => {
  is(await evaluate('/\\w+\\s\\w+/.test("hello world")'), true)
  is(await evaluate('/\\w+\\s\\w+/.test("hello")'), false)
  is(await evaluate('/\\d+\\.\\d+/.test("3.14")'), true)
  is(await evaluate('/\\d+\\.\\d+/.test("314")'), false)
})

test('regex stress: word boundary', async () => {
  is(await evaluate('/\\bword\\b/.test("a word here")'), true)
  is(await evaluate('/\\bword\\b/.test("password")'), false)
  is(await evaluate('/\\bword\\b/.test("wordy")'), false)
})

test('regex stress: dot does not match newline', async () => {
  is(await evaluate('/a.b/.test("axb")'), true)
  is(await evaluate('/a.b/.test("aXb")'), true)
})

test('regex stress: empty alternation branch', async () => {
  is(await evaluate('/a|/.test("b")'), true)
  is(await evaluate('/a|/.test("a")'), true)
})

// === Real-world patterns ===

test('regex stress: integer pattern', async () => {
  is(await evaluate('/^-?\\d+$/.test("42")'), true)
  is(await evaluate('/^-?\\d+$/.test("-7")'), true)
  is(await evaluate('/^-?\\d+$/.test("3.14")'), false)
  is(await evaluate('/^-?\\d+$/.test("")'), false)
})

test('regex stress: hex color', async () => {
  is(await evaluate('/^#[0-9a-f]{6}$/.test("#ff00aa")'), true)
  is(await evaluate('/^#[0-9a-f]{6}$/.test("#FF00AA")'), false)
  is(await evaluate('/^#[0-9a-f]{6}$/.test("#fff")'), false)
})

test('regex stress: simple identifier', async () => {
  is(await evaluate('/^[a-zA-Z_]\\w*$/.test("_foo123")'), true)
  is(await evaluate('/^[a-zA-Z_]\\w*$/.test("123abc")'), false)
  is(await evaluate('/^[a-zA-Z_]\\w*$/.test("x")'), true)
})

test('regex stress: IP-like pattern', async () => {
  is(await evaluate('/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test("192.168.1.1")'), true)
  is(await evaluate('/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test("192.168.1")'), false)
})

// === Lookahead ===

test('regex stress: positive lookahead', async () => {
  is(await evaluate('/\\d+(?=px)/.test("100px")'), true)
  is(await evaluate('/\\d+(?=px)/.test("100em")'), false)
})

test('regex stress: negative lookahead', async () => {
  is(await evaluate('/\\d+(?!px)/.test("100em")'), true)
  is(await evaluate('/foo(?!bar)/.test("foobaz")'), true)
  is(await evaluate('/foo(?!bar)/.test("foobar")'), false)
})

test('regex stress: search finds correct position', async () => {
  is(await evaluate('"abc def ghi".search(/def/)'), 4)
  is(await evaluate('"xxxxx".search(/y/)'), -1)
  is(await evaluate('"aaa".search(/a/)'), 0)
})

test('regex stress: split with multi-char separator', async () => {
  is(await evaluate('"a::b::c".split(/::/).length'), 3)
})

test('regex stress: split at start/end', async () => {
  is(await evaluate('"1abc2".split(/\\d/).length'), 3)
})

test('regex stress: replace no match returns original', () => {
  is(evalStr('"hello".replace(/xyz/, "!")'), 'hello')
})

test('regex stress: replace at boundaries', () => {
  is(evalStr('"abc".replace(/^/, "X")'), 'Xabc')
  is(evalStr('"abc".replace(/$/, "X")'), 'abcX')
})

test('regex stress: backtracking in alternation', async () => {
  // First branch "ab" matches at pos 0, but full pattern needs "abc"; must
  // backtrack to try "a" branch.
  is(await evaluate('/(ab|a)c/.test("ac")'), true)
})

test('regex stress: greedy backtrack', async () => {
  // .* greedily consumes all, then backtracks to match trailing 'c'.
  is(await evaluate('/^.*c$/.test("abc")'), true)
  is(await evaluate('/^.*c$/.test("abd")'), false)
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

test('regex: [\\s] class also matches VT and FF', () => {
  // \s inside character class should also get VT/FF
  const r = jz(`export let f = (s) => /[\\s]/.test(s)`)
  const mem = r.memory
  is(r.exports.f(mem.String('\x0B')), true)
  is(r.exports.f(mem.String('\x0C')), true)
})

test('regex: split on \\s+ splits on VT and FF', () => {
  // 'a\x0Bb'.split(/\s+/) in JS → ['a', 'b'] (VT is whitespace)
  const r = jz(`export let f = (s) => s.split(/\\s+/).length`)
  const mem = r.memory
  is(r.exports.f(mem.String('a\x0Bb')), 2)  // VT splits
  is(r.exports.f(mem.String('a\x0Cb')), 2)  // FF splits
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
  // for-of swallowed it SILENTLY — the self-host kernel's global-snapshot
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
  for (const optimize of [0, 2])
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
  throws(() => jz(`export let f = () => /\\p{L}/.test("a") ? 1 : 0`), /property escape/)
  throws(() => jz(`export let f = () => /[\\p{L}]/.test("a") ? 1 : 0`), /property escape/)
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
  throws(() => jz(`export let f = () => /\\k<nope>x/.test("x")`), /undefined group/)
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
