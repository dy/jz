import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { evaluate, gc } from './util.js'

// String method tests - use .length and .charCodeAt() to verify results

test('string.substring', async () => {
  is(await evaluate('"hello".substring(1, 3).length'), 2)
  is(await evaluate('"hello".substring(1, 3).charCodeAt(0)'), 101) // 'e'
  is(await evaluate('"hello".substring(1, 3).charCodeAt(1)'), 108) // 'l'
  is(await evaluate('"hello".substring(2).length'), 3) // 'llo'
  is(await evaluate('"hello".substring(3, 1).length'), 2) // swaps, same as (1,3)
  is(await evaluate('"hello".substring(-1, 3).length'), 3) // negative clamped to 0
})

test('string.substr', async () => {
  is(await evaluate('"hello".substr(1, 3).length'), 3) // 'ell'
  is(await evaluate('"hello".substr(1, 3).charCodeAt(0)'), 101) // 'e'
  is(await evaluate('"hello".substr(2).length'), 3) // 'llo'
  is(await evaluate('"hello".substr(-2).length'), 2) // 'lo'
  is(await evaluate('"hello".substr(-2).charCodeAt(0)'), 108) // 'l'
  is(await evaluate('"hello".substr(1, 100).length'), 4) // clamped
  is(await evaluate('"hello".substr(1, 0).length'), 0) // zero length
})

test('string.toLowerCase', async () => {
  is(await evaluate('"HELLO".toLowerCase().length'), 5)
  is(await evaluate('"HELLO".toLowerCase().charCodeAt(0)'), 104) // 'h'
  is(await evaluate('"HELLO".toLowerCase().charCodeAt(4)'), 111) // 'o'
  is(await evaluate('"ABC".toLowerCase().charCodeAt(0)'), 97) // 'a'
  is(await evaluate('"".toLowerCase().length'), 0)
})

test('string.toUpperCase', async () => {
  is(await evaluate('"hello".toUpperCase().length'), 5)
  is(await evaluate('"hello".toUpperCase().charCodeAt(0)'), 72) // 'H'
  is(await evaluate('"hello".toUpperCase().charCodeAt(4)'), 79) // 'O'
  is(await evaluate('"abc".toUpperCase().charCodeAt(0)'), 65) // 'A'
  is(await evaluate('"".toUpperCase().length'), 0)
})

test('string.startsWith', async () => {
  is(await evaluate('"hello".startsWith(104)'), 1) // 'h' = 104
  is(await evaluate('"hello".startsWith(101)'), 0) // 'e' = 101
  is(await evaluate('"".startsWith(104)'), 0) // empty string
})

test('string.endsWith', async () => {
  is(await evaluate('"hello".endsWith(111)'), 1) // 'o' = 111
  is(await evaluate('"hello".endsWith(104)'), 0) // 'h' = 104
  is(await evaluate('"".endsWith(111)'), 0) // empty string
})

test('string.trim', async () => {
  is(await evaluate('"  hello  ".trim().length'), 5)
  is(await evaluate('"  hello  ".trim().charCodeAt(0)'), 104) // 'h'
  is(await evaluate('"hello".trim().length'), 5)
  is(await evaluate('"   ".trim().length'), 0)
})

test('string.trimStart', async () => {
  is(await evaluate('"  hello  ".trimStart().length'), 7) // 'hello  '
  is(await evaluate('"  hello  ".trimStart().charCodeAt(0)'), 104) // 'h'
  is(await evaluate('"hello".trimStart().length'), 5)
  is(await evaluate('"   ".trimStart().length'), 0)
})

test('string.trimEnd', async () => {
  is(await evaluate('"  hello  ".trimEnd().length'), 7) // '  hello'
  is(await evaluate('"  hello  ".trimEnd().charCodeAt(6)'), 111) // 'o'
  is(await evaluate('"hello".trimEnd().length'), 5)
  is(await evaluate('"   ".trimEnd().length'), 0)
})

test('string.repeat', async () => {
  is(await evaluate('"ab".repeat(3).length'), 6) // 'ababab'
  is(await evaluate('"ab".repeat(3).charCodeAt(0)'), 97) // 'a'
  is(await evaluate('"ab".repeat(3).charCodeAt(2)'), 97) // 'a'
  is(await evaluate('"x".repeat(5).length'), 5)
  is(await evaluate('"hello".repeat(0).length'), 0)
  is(await evaluate('"hi".repeat(1).length'), 2)
  is(await evaluate('"".repeat(10).length'), 0)
})

test('string.padStart', async () => {
  is(await evaluate('"5".padStart(3, 48).length'), 3) // '005'
  is(await evaluate('"5".padStart(3, 48).charCodeAt(0)'), 48) // '0'
  is(await evaluate('"5".padStart(3, 48).charCodeAt(2)'), 53) // '5'
  is(await evaluate('"hello".padStart(3, 32).length'), 5) // already longer
  is(await evaluate('"x".padStart(5, 45).length'), 5) // '----x'
  is(await evaluate('"x".padStart(5, 45).charCodeAt(0)'), 45) // '-'
})

test('string.padEnd', async () => {
  is(await evaluate('"5".padEnd(3, 48).length'), 3) // '500'
  is(await evaluate('"5".padEnd(3, 48).charCodeAt(0)'), 53) // '5'
  is(await evaluate('"5".padEnd(3, 48).charCodeAt(2)'), 48) // '0'
  is(await evaluate('"hello".padEnd(3, 32).length'), 5) // already longer
  is(await evaluate('"x".padEnd(5, 45).length'), 5) // 'x----'
  is(await evaluate('"x".padEnd(5, 45).charCodeAt(4)'), 45) // '-'
})

test('string.includes', async () => {
  is(await evaluate('"hello".includes(101)'), 1) // 'e' = 101
  is(await evaluate('"hello".includes(120)'), 0) // 'x' = 120
  is(await evaluate('"".includes(97)'), 0) // empty string
})

test('string.indexOf', async () => {
  is(await evaluate('"hello".indexOf(108)'), 2) // 'l' = 108
  is(await evaluate('"hello".indexOf(111)'), 4) // 'o' = 111
  is(await evaluate('"hello".indexOf(120)'), -1) // 'x' = 120 not found
  is(await evaluate('"".indexOf(97)'), -1) // empty string
})

test('string.slice', async () => {
  is(await evaluate('"hello".slice(1, 3).length'), 2)
  is(await evaluate('"hello".slice(1, 3).charCodeAt(0)'), 101) // 'e'
  is(await evaluate('"hello".slice(2).length'), 3)
  is(await evaluate('"hello".slice(-2).length'), 2) // 'lo'
  is(await evaluate('"hello".slice(-2).charCodeAt(0)'), 108) // 'l'
})

test('string.charCodeAt', async () => {
  is(await evaluate('"hello".charCodeAt(0)'), 104) // 'h'
  is(await evaluate('"hello".charCodeAt(1)'), 101) // 'e'
  is(await evaluate('"ABC".charCodeAt(0)'), 65) // 'A'
})

// Extended string tests - JS-compatible APIs

test('string.startsWith with string', async () => {
  is(await evaluate('"hello world".startsWith("hello")'), 1)
  is(await evaluate('"hello world".startsWith("world")'), 0)
  is(await evaluate('"hello".startsWith("hello")'), 1)
  is(await evaluate('"hello".startsWith("helloworld")'), 0) // search longer than str
  is(await evaluate('"".startsWith("")'), 1) // empty matches empty
  is(await evaluate('"hello".startsWith("")'), 1) // empty prefix always matches
})

test('string.endsWith with string', async () => {
  is(await evaluate('"hello world".endsWith("world")'), 1)
  is(await evaluate('"hello world".endsWith("hello")'), 0)
  is(await evaluate('"hello".endsWith("hello")'), 1)
  is(await evaluate('"hello".endsWith("helloworld")'), 0)
  is(await evaluate('"".endsWith("")'), 1)
  is(await evaluate('"hello".endsWith("")'), 1)
})

test('string.includes with string', async () => {
  is(await evaluate('"hello world".includes("wor")'), 1)
  is(await evaluate('"hello world".includes("xyz")'), 0)
  is(await evaluate('"hello".includes("ell")'), 1)
  is(await evaluate('"hello".includes("")'), 1) // empty always found
  is(await evaluate('"".includes("")'), 1)
})

test('string.indexOf with string', async () => {
  is(await evaluate('"hello world".indexOf("wor")'), 6)
  is(await evaluate('"hello world".indexOf("xyz")'), -1)
  is(await evaluate('"hello".indexOf("ell")'), 1)
  is(await evaluate('"hello".indexOf("")'), 0) // empty found at 0
  is(await evaluate('"hello hello".indexOf("ell")'), 1) // first occurrence
})

test('string.padStart with string', async () => {
  is(await evaluate('"5".padStart(4, "0").length'), 4)
  is(await evaluate('"5".padStart(4, "0").charCodeAt(0)'), 48) // '0'
  is(await evaluate('"5".padStart(4, "0").charCodeAt(3)'), 53) // '5'
  is(await evaluate('"abc".padStart(6, "123").length'), 6) // '123abc'
  is(await evaluate('"abc".padStart(6, "123").charCodeAt(0)'), 49) // '1'
  is(await evaluate('"abc".padStart(6, "123").charCodeAt(2)'), 51) // '3'
  is(await evaluate('"abc".padStart(10, "xy").length'), 10) // 'xyxyxyxabc'
  is(await evaluate('"abc".padStart(10, "xy").charCodeAt(0)'), 120) // 'x'
  is(await evaluate('"abc".padStart(10, "xy").charCodeAt(1)'), 121) // 'y'
})

test('string.padEnd with string', async () => {
  is(await evaluate('"5".padEnd(4, "0").length'), 4)
  is(await evaluate('"5".padEnd(4, "0").charCodeAt(0)'), 53) // '5'
  is(await evaluate('"5".padEnd(4, "0").charCodeAt(3)'), 48) // '0'
  is(await evaluate('"abc".padEnd(6, "123").length'), 6) // 'abc123'
  is(await evaluate('"abc".padEnd(6, "123").charCodeAt(3)'), 49) // '1'
  is(await evaluate('"abc".padEnd(10, "xy").length'), 10) // 'abcxyxyxyx'
  is(await evaluate('"abc".padEnd(10, "xy").charCodeAt(3)'), 120) // 'x'
})

test('string.split with string', async () => {
  is(await evaluate('"a,b,c".split(",").length'), 3)
  is(await evaluate('"a,b,c".split(",")[0].length'), 1) // 'a'
  is(await evaluate('"a,b,c".split(",")[0].charCodeAt(0)'), 97) // 'a'
  is(await evaluate('"a,b,c".split(",")[1].charCodeAt(0)'), 98) // 'b'
  is(await evaluate('"a,b,c".split(",")[2].charCodeAt(0)'), 99) // 'c'
  is(await evaluate('"hello".split("").length'), 5) // split into chars
  is(await evaluate('"hello".split("")[0].charCodeAt(0)'), 104) // 'h'
  is(await evaluate('"a::b::c".split("::").length'), 3)
  is(await evaluate('"a::b::c".split("::")[1].charCodeAt(0)'), 98) // 'b'
})

test('string.split with char code', async () => {
  is(await evaluate('"a,b,c".split(44).length'), 3) // 44 = ','
  is(await evaluate('"a,b,c".split(44)[0].charCodeAt(0)'), 97) // 'a'
  is(await evaluate('"a,b,c".split(44)[2].charCodeAt(0)'), 99) // 'c'
  is(await evaluate('"a-b-c".split(45).length'), 3) // 45 = '-'
})

test('string.replace with strings', async () => {
  is(await evaluate('"hello world".replace("world", "there").length'), 11)
  is(await evaluate('"hello world".replace("world", "there").charCodeAt(6)'), 116) // 't'
  is(await evaluate('"hello world".replace("world", "there").charCodeAt(10)'), 101) // 'e'
  is(await evaluate('"aaa".replace("a", "bb").length'), 4) // 'bbaaa' -> only first
  is(await evaluate('"aaa".replace("a", "bb").charCodeAt(0)'), 98) // 'b'
  is(await evaluate('"aaa".replace("a", "bb").charCodeAt(2)'), 97) // 'a'
  is(await evaluate('"hello".replace("x", "y").length'), 5) // no match, unchanged
  is(await evaluate('"abc".replace("abc", "xyz").length'), 3)
  is(await evaluate('"abc".replace("abc", "xyz").charCodeAt(0)'), 120) // 'x'
})
