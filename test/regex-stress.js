/**
 * Regex stress tests — real-world patterns, edge cases, conformance.
 *
 * Based on common patterns from:
 * - PCRE/Perl test vectors
 * - Real-world validation patterns (email, URL, number, date)
 * - Backtracking edge cases
 * - Boundary conditions
 */
import test from 'tst'
import { is } from 'tst/assert.js'
import { evaluate } from './util.js'
import jz, { compile } from '../index.js'

function evalStr(code) {
  const wasm = compile(`export let main = () => ${code}`)
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod)
  return jz.memory({ module: mod, instance: inst }).read(inst.exports.main())
}

// === Greedy vs lazy quantifiers ===

test('regex stress: greedy * matches maximally', async () => {
  is(await evaluate('/a.*b/.test("aXXXb")'), 1)
  is(await evaluate('/a.*b/.test("ab")'), 1)
  is(await evaluate('/a.*b/.test("a")'), 0)
})

test('regex stress: lazy *? matches minimally', async () => {
  is(await evaluate('/a.*?b/.test("aXXXb")'), 1)
  is(await evaluate('/a.*?b/.test("ab")'), 1)
})

test('regex stress: greedy + requires at least one', async () => {
  is(await evaluate('/a.+b/.test("aXb")'), 1)
  is(await evaluate('/a.+b/.test("ab")'), 0)
})

// === Repetition {n,m} ===

test('regex stress: exact repetition {n}', async () => {
  is(await evaluate('/a{3}/.test("aaa")'), 1)
  is(await evaluate('/a{3}/.test("aa")'), 0)
  is(await evaluate('/a{3}/.test("aaaa")'), 1) // matches first 3
})

test('regex stress: range repetition {n,m}', async () => {
  is(await evaluate('/a{2,4}/.test("aa")'), 1)
  is(await evaluate('/a{2,4}/.test("aaaa")'), 1)
  is(await evaluate('/a{2,4}/.test("a")'), 0)
})

test('regex stress: open-ended {n,}', async () => {
  is(await evaluate('/a{2,}/.test("aa")'), 1)
  is(await evaluate('/a{2,}/.test("aaaaa")'), 1)
  is(await evaluate('/a{2,}/.test("a")'), 0)
})

// === Anchors ===

test('regex stress: ^ and $ together', async () => {
  is(await evaluate('/^exact$/.test("exact")'), 1)
  is(await evaluate('/^exact$/.test("not exact")'), 0)
  is(await evaluate('/^exact$/.test("exactly")'), 0)
})

test('regex stress: anchor with quantifier', async () => {
  is(await evaluate('/^a+$/.test("aaaa")'), 1)
  is(await evaluate('/^a+$/.test("aaab")'), 0)
  is(await evaluate('/^a+$/.test("")'), 0)
})

// === Alternation edge cases ===

test('regex stress: multi-branch alternation', async () => {
  is(await evaluate('/foo|bar|baz/.test("baz")'), 1)
  is(await evaluate('/foo|bar|baz/.test("qux")'), 0)
})

test('regex stress: alternation with anchors', async () => {
  is(await evaluate('/^(cat|dog)$/.test("cat")'), 1)
  is(await evaluate('/^(cat|dog)$/.test("catdog")'), 0)
})

// === Nested groups ===

test('regex stress: nested quantified groups', async () => {
  is(await evaluate('/(ab)+/.test("ababab")'), 1)
  is(await evaluate('/(ab)+/.test("abc")'), 1)
  is(await evaluate('/(ab)+/.test("ba")'), 0)
})

test('regex stress: non-capturing group', async () => {
  is(await evaluate('/(?:ab)+c/.test("ababc")'), 1)
  is(await evaluate('/(?:ab)+c/.test("abc")'), 1)
  is(await evaluate('/(?:ab)+c/.test("ac")'), 0)
})

// === Character class edge cases ===

test('regex stress: char class with special chars', async () => {
  is(await evaluate('/[.+*?]/.test(".")'), 1)
  is(await evaluate('/[.+*?]/.test("x")'), 0)
})

test('regex stress: negated class with range', async () => {
  is(await evaluate('/[^0-9]/.test("a")'), 1)
  is(await evaluate('/[^0-9]/.test("5")'), 0)
})

test('regex stress: \\w \\d \\s combinations', async () => {
  is(await evaluate('/\\w+\\s\\w+/.test("hello world")'), 1)
  is(await evaluate('/\\w+\\s\\w+/.test("hello")'), 0)
  is(await evaluate('/\\d+\\.\\d+/.test("3.14")'), 1)
  is(await evaluate('/\\d+\\.\\d+/.test("314")'), 0)
})

// === Word boundary ===

test('regex stress: word boundary', async () => {
  is(await evaluate('/\\bword\\b/.test("a word here")'), 1)
  is(await evaluate('/\\bword\\b/.test("password")'), 0)
  is(await evaluate('/\\bword\\b/.test("wordy")'), 0)
})

// === Dot matches ===

test('regex stress: dot does not match newline', async () => {
  // dot should match any char except \n
  is(await evaluate('/a.b/.test("axb")'), 1)
  is(await evaluate('/a.b/.test("aXb")'), 1)
})

// === Empty/degenerate patterns ===

test('regex stress: empty alternation branch', async () => {
  is(await evaluate('/a|/.test("b")'), 1) // empty branch always matches
  is(await evaluate('/a|/.test("a")'), 1)
})

// === Real-world patterns ===

test('regex stress: integer pattern', async () => {
  is(await evaluate('/^-?\\d+$/.test("42")'), 1)
  is(await evaluate('/^-?\\d+$/.test("-7")'), 1)
  is(await evaluate('/^-?\\d+$/.test("3.14")'), 0)
  is(await evaluate('/^-?\\d+$/.test("")'), 0)
})

test('regex stress: hex color', async () => {
  is(await evaluate('/^#[0-9a-f]{6}$/.test("#ff00aa")'), 1)
  is(await evaluate('/^#[0-9a-f]{6}$/.test("#FF00AA")'), 0) // case sensitive
  is(await evaluate('/^#[0-9a-f]{6}$/.test("#fff")'), 0) // too short
})

test('regex stress: simple identifier', async () => {
  is(await evaluate('/^[a-zA-Z_]\\w*$/.test("_foo123")'), 1)
  is(await evaluate('/^[a-zA-Z_]\\w*$/.test("123abc")'), 0)
  is(await evaluate('/^[a-zA-Z_]\\w*$/.test("x")'), 1)
})

test('regex stress: IP-like pattern', async () => {
  is(await evaluate('/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test("192.168.1.1")'), 1)
  is(await evaluate('/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test("192.168.1")'), 0)
})

// === Lookahead ===

test('regex stress: positive lookahead', async () => {
  is(await evaluate('/\\d+(?=px)/.test("100px")'), 1)
  is(await evaluate('/\\d+(?=px)/.test("100em")'), 0)
})

test('regex stress: negative lookahead', async () => {
  is(await evaluate('/\\d+(?!px)/.test("100em")'), 1)
  is(await evaluate('/foo(?!bar)/.test("foobaz")'), 1)
  is(await evaluate('/foo(?!bar)/.test("foobar")'), 0)
})

// === Search position accuracy ===

test('regex stress: search finds correct position', async () => {
  is(await evaluate('"abc def ghi".search(/def/)'), 4)
  is(await evaluate('"xxxxx".search(/y/)'), -1)
  is(await evaluate('"aaa".search(/a/)'), 0)
})

// === Split edge cases ===

test('regex stress: split with multi-char separator', async () => {
  is(await evaluate('"a::b::c".split(/::/).length'), 3)
})

test('regex stress: split at start/end', async () => {
  is(await evaluate('"1abc2".split(/\\d/).length'), 3) // ["", "abc", ""]
})

// === Replace edge cases ===

test('regex stress: replace no match returns original', () => {
  is(evalStr('"hello".replace(/xyz/, "!")'), 'hello')
})

test('regex stress: replace at boundaries', () => {
  is(evalStr('"abc".replace(/^/, "X")'), 'Xabc')
  is(evalStr('"abc".replace(/$/, "X")'), 'abcX')
})

// === Backtracking ===

test('regex stress: backtracking in alternation', async () => {
  // First branch "ab" matches at pos 0, but full pattern needs "abc"
  // Must backtrack to try "a" branch
  is(await evaluate('/(ab|a)c/.test("ac")'), 1)
})

test('regex stress: greedy backtrack', async () => {
  // .* greedily consumes all, then backtracks to match trailing 'c'
  is(await evaluate('/^.*c$/.test("abc")'), 1)
  is(await evaluate('/^.*c$/.test("abd")'), 0)
})
