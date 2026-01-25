import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { evaluate } from './util.js'

// SSO (Short String Optimization) tests
// Strings ≤6 ASCII chars are packed in pointer (no memory allocation)
// Longer strings or non-ASCII use heap allocation

// SSO boundary: exactly 6 chars
test('SSO - 6 char string (max SSO)', async () => {
  is(await evaluate('"abcdef".length'), 6)
  is(await evaluate('"abcdef".charCodeAt(0)'), 97)  // 'a'
  is(await evaluate('"abcdef".charCodeAt(5)'), 102) // 'f'
})

test('SSO - 5 char string', async () => {
  is(await evaluate('"hello".length'), 5)
  is(await evaluate('"hello".charCodeAt(0)'), 104) // 'h'
  is(await evaluate('"hello".charCodeAt(4)'), 111) // 'o'
})

test('SSO - 1 char string', async () => {
  is(await evaluate('"x".length'), 1)
  is(await evaluate('"x".charCodeAt(0)'), 120)
})

test('SSO - empty string', async () => {
  is(await evaluate('"".length'), 0)
})

// Heap strings: >6 chars
test('Heap - 7 char string (min heap)', async () => {
  is(await evaluate('"abcdefg".length'), 7)
  is(await evaluate('"abcdefg".charCodeAt(0)'), 97)  // 'a'
  is(await evaluate('"abcdefg".charCodeAt(6)'), 103) // 'g'
})

test('Heap - long string', async () => {
  is(await evaluate('"hello world".length'), 11)
  is(await evaluate('"hello world".charCodeAt(6)'), 119) // 'w'
})

// SSO to heap conversion (via string methods that need memory)
test('SSO slice to SSO', async () => {
  // "hello" (SSO) → slice(0,3) → "hel" (SSO)
  is(await evaluate('"hello".slice(0, 3).length'), 3)
  is(await evaluate('"hello".slice(0, 3).charCodeAt(0)'), 104) // 'h'
})

test('SSO slice to heap', async () => {
  // "abcdef" (SSO) concat with more → heap
  is(await evaluate('"abcdef".repeat(2).length'), 12)
  is(await evaluate('"abcdef".repeat(2).charCodeAt(6)'), 97) // 'a'
})

test('Heap slice to SSO', async () => {
  // "hello world" (heap) → slice(0,5) → "hello" (could be SSO or heap)
  is(await evaluate('"hello world".slice(0, 5).length'), 5)
  is(await evaluate('"hello world".slice(0, 5).charCodeAt(0)'), 104)
})

// SSO comparison
test('SSO equality - same string', async () => {
  is(await evaluate('"abc" === "abc"'), 1)
  is(await evaluate('"abcdef" === "abcdef"'), 1)
})

test('SSO equality - different strings', async () => {
  is(await evaluate('"abc" === "abd"'), 0)
  is(await evaluate('"abc" === "ab"'), 0)
})

// Heap comparison
test('Heap equality - same string', async () => {
  is(await evaluate('"hello world" === "hello world"'), 1)
})

test('Heap equality - different strings', async () => {
  is(await evaluate('"hello world" === "hello worlx"'), 0)
})

// SSO vs heap comparison - proper value comparison
test('SSO vs heap equality', async () => {
  // Same literal compares equal (same interned pointer - fast path)
  is(await evaluate('"hello" === "hello"'), 1)
  // Slice result vs literal - now compares by value!
  is(await evaluate('"hello world".slice(0, 5) === "hello"'), 1)
  // Different content
  is(await evaluate('"hello world".slice(0, 4) === "hello"'), 0)
})

test('String equality - cross SSO/heap', async () => {
  // SSO (6 chars) vs heap slice result
  is(await evaluate('"abcdefghij".slice(0, 6) === "abcdef"'), 1)
  // Heap (7 chars) vs heap slice result
  is(await evaluate('"abcdefghij".slice(0, 7) === "abcdefg"'), 1)
  // SSO vs SSO with same content
  is(await evaluate('{ let a = "test"; let b = "te" + "st"; a === "test" }'), 1)
})

test('String inequality - value based', async () => {
  is(await evaluate('"hello world".slice(0, 5) !== "world"'), 1)
  is(await evaluate('"hello world".slice(0, 5) !== "hello"'), 0)
  is(await evaluate('"abc" !== "abd"'), 1)
})

test('String equality - empty strings', async () => {
  is(await evaluate('"" === ""'), 1)
  is(await evaluate('"test".slice(0, 0) === ""'), 1)
  is(await evaluate('"" === "a"'), 0)
})

// String operations that force SSO→heap conversion
test('SSO toLowerCase', async () => {
  is(await evaluate('"HELLO".toLowerCase().length'), 5)
  is(await evaluate('"HELLO".toLowerCase().charCodeAt(0)'), 104)
})

test('SSO toUpperCase', async () => {
  is(await evaluate('"hello".toUpperCase().length'), 5)
  is(await evaluate('"hello".toUpperCase().charCodeAt(0)'), 72)
})

test('SSO trim (no change)', async () => {
  is(await evaluate('"hello".trim().length'), 5)
})

test('SSO concat', async () => {
  // "abc" + "def" = "abcdef" (6 chars, max SSO)
  is(await evaluate('("abc" + "def").length'), 6)
  // "abc" + "defg" = "abcdefg" (7 chars, heap)
  is(await evaluate('("abc" + "defg").length'), 7)
})

// Edge cases
test('SSO - all ASCII boundaries', async () => {
  // Test char code 127 (DEL, max ASCII for SSO)
  // Note: SSO only supports 7-bit ASCII (0-127)
  is(await evaluate('"~".charCodeAt(0)'), 126) // '~' is 126
})

test('SSO vs heap - variable assignment', async () => {
  // SSO string assigned to variable
  is(await evaluate('{ let s = "abc"; s.length }'), 3)
  is(await evaluate('{ let s = "abc"; s.charCodeAt(0) }'), 97)
  
  // Heap string assigned to variable
  is(await evaluate('{ let s = "hello world"; s.length }'), 11)
  is(await evaluate('{ let s = "hello world"; s.charCodeAt(0) }'), 104)
})

// Replace operations (forces SSO to heap)
// Note: replace returns a NEW string, original is immutable
// replace(charCode, "string") - replaces first occurrence of char with string
test('SSO replace char with string', async () => {
  // Replace 'e' (101) with "a" in "hello" → "hallo"
  is(await evaluate('"hello".replace(101, "a").length'), 5)
  is(await evaluate('"hello".replace(101, "a").charCodeAt(1)'), 97) // 'a'
})

test('SSO replace char with longer string', async () => {
  // Replace 'e' (101) with "EE" in "hello" → "hEEllo"
  is(await evaluate('"hello".replace(101, "EE").length'), 6)
  is(await evaluate('"hello".replace(101, "EE").charCodeAt(1)'), 69) // 'E'
  is(await evaluate('"hello".replace(101, "EE").charCodeAt(2)'), 69) // 'E'
})

test('Heap replace', async () => {
  is(await evaluate('"hello world".replace(111, 48).length'), 11) // 'o'→'0'
})

// Split (SSO source)
test('SSO split by char', async () => {
  // "a-b" split by '-' = ["a", "b"]
  is(await evaluate('"a-b-c".split(45).length'), 3) // 45 = '-'
  is(await evaluate('"a-b-c".split(45)[0].length'), 1)
})
