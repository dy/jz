// Comprehensive string method tests
import test from 'tst'
import { is, ok, almost } from 'tst/assert.js'
import { compile } from '../index.js'
import jz from '../index.js'

function run(code) {
  return jz(code).exports
}

// ============================================
// STRING METHODS
// ============================================

// === String.fromCharCode ===

test('String.fromCharCode: A', () => {
  is(run('export let f = () => String.fromCharCode(65).length').f(), 1)
})

// === + operator on strings ===

test('string +: concat', () => {
  is(run('export let f = () => ("hello" + " world").length').f(), 11)
})

test('string +=: append', () => {
  is(run('export let f = () => { let s = "a"; s = s + "bc"; return s.length }').f(), 3)
})

test('string +: known string operands skip generic toString helper', () => {
  const wat = compile('export let f = () => { let s = ""; s = s + "abc"; return s.length }', { wat: true })
  ok(!wat.includes('$__to_str'))
  ok(!wat.includes('$__static_str'))
})

test('string ==: compares by value', () => {
  is(run('export let f = () => "module" == "module"').f(), 1)
})

test('string ==: concatenated string compares by value', () => {
  is(run('export let f = () => { let s = "mod" + "ule"; return s == "module" }').f(), 1)
})

test('string !=: different contents compare unequal', () => {
  is(run('export let f = () => "module" != "memory"').f(), 1)
})

// === string ordering: < > <= >= ===
// Pre-fix, NaN-boxed string pointers fell into f64.lt/gt which always returns 0
// (NaN comparisons in IEEE 754 are false). cmpOp now routes both-STRING operands
// through __str_cmp's three-way result.

test('string <: lex order', () => {
  is(run('export let f = () => "a" < "b"').f(), 1)
  is(run('export let f = () => "b" < "a"').f(), 0)
  is(run('export let f = () => "a" < "a"').f(), 0)
})

test('string >: lex order', () => {
  is(run('export let f = () => "b" > "a"').f(), 1)
  is(run('export let f = () => "a" > "b"').f(), 0)
})

test('string <=: includes equality', () => {
  is(run('export let f = () => "a" <= "a"').f(), 1)
  is(run('export let f = () => "a" <= "b"').f(), 1)
  is(run('export let f = () => "b" <= "a"').f(), 0)
})

test('string <: shared prefix, shorter sorts first', () => {
  is(run('export let f = () => "app" < "apple"').f(), 1)
  is(run('export let f = () => "apple" < "app"').f(), 0)
})

test('string <: empty sorts before non-empty', () => {
  is(run('export let f = () => "" < "a"').f(), 1)
  is(run('export let f = () => "a" < ""').f(), 0)
})

test('string < via variables', () => {
  const { f } = run(`export let f = () => {
    let x = "banana"; let y = "cherry"
    return x < y
  }`)
  is(f(), 1)
})

// === localeCompare ===
// Byte-wise variant — not locale-aware. Returns -1/0/1.

test('.localeCompare: returns -1/0/1', () => {
  is(run('export let f = () => "a".localeCompare("b")').f(), -1)
  is(run('export let f = () => "a".localeCompare("a")').f(), 0)
  is(run('export let f = () => "b".localeCompare("a")').f(), 1)
})

test('.localeCompare: shared prefix tiebreaks by length', () => {
  is(run('export let f = () => "app".localeCompare("apple")').f(), -1)
  is(run('export let f = () => "apple".localeCompare("app")').f(), 1)
})

// === parseInt ===

test('parseInt: decimal', () => {
  is(run('export let f = () => parseInt("42")').f(), 42)
})

test('parseInt: hex 0x', () => {
  is(run('export let f = () => parseInt("0xff")').f(), 255)
})

test('parseInt: radix 16', () => {
  is(run('export let f = () => parseInt("ff", 16)').f(), 255)
})

test('parseInt: negative', () => {
  is(run('export let f = () => parseInt("-123")').f(), -123)
})

test('parseInt: number passthrough', () => {
  is(run('export let f = () => parseInt(3.14)').f(), 3)
})

test('parseInt: large hex integer > 53 bits', () => {
  // parseInt must preserve rounding for hex integers beyond f64 exact range.
  // 0x2000000000000100000000001 = 2^97 + 2^44 + 1 → rounds to 2^97 + 2^45.
  const val = run('export let f = () => parseInt("0x2000000000000100000000001")').f()
  const buf = new ArrayBuffer(8), u8 = new Uint8Array(buf)
  u8.set([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46])
  const expected = new Float64Array(buf)[0]
  is(val, expected, `got ${val}, expected ${expected}`)
})

// === .concat ===

test('string: .concat single', () => {
  is(run(`export let f = () => "hello".concat(" world").length`).f(), 11)
})

test('string: .concat two', () => {
  is(run(`export let f = () => "a".concat("b").length`).f(), 2)
})

test('template literal: fused concat returns string and skips concat helper', () => {
  const src = 'export let f = (a, b, c) => `a${a}b${b}c${c}d`'
  const result = jz(src)
  is(result.memory.read(result.exports.f(1, 2, 3)), 'a1b2c3d')
  const wat = compile(src, { wat: true })
  const start = wat.indexOf('(func $f')
  const end = wat.indexOf('\n  (func ', start + 1)
  ok(!wat.slice(start, end).includes('call $__str_concat'))
})

// === .slice ===

test('string: .slice basic', () => {
  const { f } = run(`export let f = () => {
    let s = "hello"
    return s.slice(1, 4).length
  }`)
  is(f(), 3)  // "ell"
})

test('string: .slice negative', () => {
  is(run(`export let f = () => "hello".slice(-3).length`).f(), 3)  // "llo"
})

test('string: .slice no args', () => {
  is(run(`export let f = () => "hello".slice().length`).f(), 5)
})

// === .substring ===

test('string: .substring basic', () => {
  const { f } = run(`export let f = () => {
    let s = "hello"
    return s.substring(1, 4).length
  }`)
  is(f(), 3)
})

// === .indexOf ===

test('string: .indexOf found', () => {
  is(run(`export let f = () => "hello".indexOf("l")`).f(), 2)
})

test('string: .indexOf not found', () => {
  is(run(`export let f = () => "hello".indexOf("x")`).f(), -1)
})

test('string: literal startsWith/endsWith', () => {
  const { f } = run(`export let f = () => {
    let a = "memory.store"
    let b = "xstore"
    let c = "memory.x"
    return (a.startsWith("memory.") ? 10 : 0) + (a.endsWith("store") ? 1 : 0)
      + (b.startsWith("memory.") ? 100 : 0) + (b.endsWith("store") ? 1 : 0)
      + (c.startsWith("memory.") ? 10 : 0) + (c.endsWith("store") ? 100 : 0)
  }`)
  is(f(), 22)
})

test('string: startsWith/endsWith coerce non-string args via ToString', () => {
  // Per spec, the search arg goes through ToString. Without coercion, a numeric
  // arg's __str_byteLen reads as 0, the suffix loop runs zero iterations, and
  // the function falls through to "match" — `"100".endsWith(99)` would lie.
  is(run(`export let f = () => "100".endsWith(99) ? 1 : 0`).f(), 0)
  is(run(`export let f = () => "199".endsWith(99) ? 1 : 0`).f(), 1)
  is(run(`export let f = () => "9foo".startsWith(9) ? 1 : 0`).f(), 1)
})

test('string: .toString and .valueOf return the receiver', () => {
  // Spec 21.1.3.27/28 — both are identity for primitive strings.
  is(run(`export let f = () => "hi".toString().length`).f(), 2)
  is(run(`export let f = () => "world".valueOf().length`).f(), 5)
  is(run(`export let f = () => { let s = "abc"; return s.toString() === s ? 1 : 0 }`).f(), 1)
})

test('string index: out-of-range returns undefined', () => {
  ok(run(`export let f = () => "hello"[99]`).f() === undefined)
})

// === .includes ===

test('string: .includes found', () => {
  is(run(`export let f = () => "hello".includes("ell")`).f(), 1)
})

test('string: .includes not found', () => {
  is(run(`export let f = () => "hello".includes("xyz")`).f(), 0)
})

// === .startsWith ===

test('string: .startsWith true', () => {
  is(run(`export let f = () => "hello".startsWith("hel")`).f(), 1)
})

test('string: .startsWith false', () => {
  is(run(`export let f = () => "hello".startsWith("lo")`).f(), 0)
})

// === .endsWith ===

test('string: .endsWith true', () => {
  is(run(`export let f = () => "hello".endsWith("lo")`).f(), 1)
})

test('string: .endsWith false', () => {
  is(run(`export let f = () => "hello".endsWith("hel")`).f(), 0)
})

// === .toUpperCase ===

test('string: .toUpperCase', () => {
  is(run(`export let f = () => "hello".toUpperCase().length`).f(), 5)
})

// === .toLowerCase ===

test('string: .toLowerCase', () => {
  is(run(`export let f = () => "HELLO".toLowerCase().length`).f(), 5)
})

test('string: .toLocaleLowerCase', () => {
  is(run(`export let f = () => "HELLO".toLocaleLowerCase().length`).f(), 5)
})

test('string: .toLocaleLowerCase ignores locale args', () => {
  is(run(`export let f = () => "HELLO".toLocaleLowerCase("tr").length`).f(), 5)
})

// === .trim ===

test('string: .trim', () => {
  is(run(`export let f = () => " hello ".trim().length`).f(), 5)
})

test('string: .trimStart', () => {
  is(run(`export let f = () => " hello ".trimStart().length`).f(), 6)
})

test('string: .trimEnd', () => {
  is(run(`export let f = () => " hello ".trimEnd().length`).f(), 6)
})

// === .repeat ===

test('string: .repeat', () => {
  is(run(`export let f = () => "ab".repeat(3).length`).f(), 6)  // "ababab"
})

// === .replace ===

test('string: .replace first only', () => {
  is(run(`export let f = () => "hello hello".replace("hello", "hi").length`).f(), 8)  // "hi hello"
})

// === .replaceAll ===

test('string: .replaceAll', () => {
  is(run(`export let f = () => "a_b_c".replaceAll("_", "-").length`).f(), 5)  // "a-b-c"
})

test('string: .replaceAll removes all', () => {
  is(run(`export let f = () => "a__b__c".replaceAll("__", "").length`).f(), 3)  // "abc"
})

// === .split ===

test('string: .split basic', () => {
  const { f } = run(`export let f = () => {
    let a = "a,b,c".split(",")
    return a.length
  }`)
  is(f(), 3)
})

// === .padStart ===

test('string: .padStart', () => {
  is(run(`export let f = () => "5".padStart(3, "0").length`).f(), 3)
})

// === .padEnd ===

test('string: .padEnd', () => {
  is(run(`export let f = () => "5".padEnd(3, "0").length`).f(), 3)
})

// === Chaining ===

test('string: chain .toUpperCase.slice', () => {
  is(run(`export let f = () => "hello".toUpperCase().slice(0, 2).length`).f(), 2)
})

// === Tagged template literals ===

test('tagged template: receives strings array and values', () => {
  const { f } = run(`export let f = () => {
    let tag = (strs, val) => strs[0].length * 100 + val
    return tag\`hello \${42} world\`
  }`)
  is(f(), 642)  // 'hello '.length=6 → 600 + 42
})

test('tagged template: strings.length === exprs.length + 1', () => {
  const { f } = run(`export let f = () => {
    let tag = (strs, a, b) => strs.length * 10 + a + b
    return tag\`x=\${1}, y=\${2}.\`
  }`)
  is(f(), 33)  // 3 strings → 30 + 1 + 2
})

test('tagged template: leading interpolation has empty first string', () => {
  const { f } = run(`export let f = () => {
    let tag = (strs, val) => strs[0].length === 0 ? val : -1
    return tag\`\${7}rest\`
  }`)
  is(f(), 7)
})

test('tagged template: trailing interpolation has empty last string', () => {
  const { f } = run(`export let f = () => {
    let tag = (strs, val) => strs[strs.length - 1].length === 0 ? val : -1
    return tag\`rest\${9}\`
  }`)
  is(f(), 9)
})

test('tagged template: no interpolation', () => {
  const { f } = run(`export let f = () => {
    let tag = (strs) => strs[0].length
    return tag\`bare\`
  }`)
  is(f(), 4)
})
