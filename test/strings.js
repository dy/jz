// Comprehensive string method tests
import test from 'tst'
import { is, ok, almost, throws } from 'tst/assert.js'
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

test('encodeURIComponent: leaves unescaped characters intact', () => {
  is(run(`export let f = () => encodeURIComponent("AZaz09-_.!~*'()")`).f(), "AZaz09-_.!~*'()")
})

test('encodeURIComponent: percent-encodes reserved and whitespace bytes', () => {
  is(run('export let f = () => encodeURIComponent("a b?x=1&y=/")').f(), 'a%20b%3Fx%3D1%26y%3D%2F')
})

test('encodeURIComponent: percent-encodes UTF-8 bytes', () => {
  is(run('export let f = () => encodeURIComponent("é ☃")').f(), '%C3%A9%20%E2%98%83')
})

test('encodeURIComponent: missing argument encodes undefined', () => {
  is(run('export let f = () => encodeURIComponent()').f(), 'undefined')
})

test('encodeURIComponent: dynamic value compiles without JS host imports under WASI', () => {
  const wat = compile('export let f = (s) => encodeURIComponent(s)', { host: 'wasi', wat: true })
  ok(!wat.includes('(import "env"'), 'encodeURIComponent should not import JS host helpers')
})

// === decodeURIComponent ===

test('decodeURIComponent: decodes escaped component bytes', () => {
  const mod = run('export let f = () => decodeURIComponent("%3B%2F%3F%3A%40%26%3D%2B%24%2C%23")')
  is(mod.memory.read(mod.f()), ';/?:@&=+$,#')
})

test('decodeURIComponent: accepts lowercase hex and UTF-8 bytes', () => {
  const mod = run('export let f = () => decodeURIComponent("%c3%a9%20%E2%98%83")')
  is(mod.memory.read(mod.f()), 'é ☃')
})

test('decodeURIComponent: leaves unescaped text unchanged', () => {
  const mod = run('export let f = (x) => decodeURIComponent(x)')
  is(mod.memory.read(mod.f(mod.memory.String('plain-value'))), 'plain-value')
})

test('decodeURIComponent: missing argument decodes undefined', () => {
  const mod = run('export let f = () => decodeURIComponent()')
  is(mod.memory.read(mod.f()), 'undefined')
})

test('decodeURIComponent: malformed escape throws', () => {
  const mod = run('export let f = () => decodeURIComponent("%xz")')
  throws(() => mod.f())
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
  is(run('export let f = () => "module" == "module"').f(), true)
})

test('string ==: concatenated string compares by value', () => {
  is(run('export let f = () => { let s = "mod" + "ule"; return s == "module" }').f(), true)
})

test('string !=: different contents compare unequal', () => {
  is(run('export let f = () => "module" != "memory"').f(), true)
})

// === string ordering: < > <= >= ===
// Pre-fix, NaN-boxed string pointers fell into f64.lt/gt which always returns 0
// (NaN comparisons in IEEE 754 are false). cmpOp now routes both-STRING operands
// through __str_cmp's three-way result.

test('string <: lex order', () => {
  is(run('export let f = () => "a" < "b"').f(), true)
  is(run('export let f = () => "b" < "a"').f(), false)
  is(run('export let f = () => "a" < "a"').f(), false)
})

test('string >: lex order', () => {
  is(run('export let f = () => "b" > "a"').f(), true)
  is(run('export let f = () => "a" > "b"').f(), false)
})

test('string <=: includes equality', () => {
  is(run('export let f = () => "a" <= "a"').f(), true)
  is(run('export let f = () => "a" <= "b"').f(), true)
  is(run('export let f = () => "b" <= "a"').f(), false)
})

test('string <: shared prefix, shorter sorts first', () => {
  is(run('export let f = () => "app" < "apple"').f(), true)
  is(run('export let f = () => "apple" < "app"').f(), false)
})

test('string <: empty sorts before non-empty', () => {
  is(run('export let f = () => "" < "a"').f(), true)
  is(run('export let f = () => "a" < ""').f(), false)
})

test('string < via variables', () => {
  const { f } = run(`export let f = () => {
    let x = "banana"; let y = "cherry"
    return x < y
  }`)
  is(f(), true)
})

// === mixed untyped/string-literal ordering ===
// When one operand is a known string literal and the other has no static type
// (e.g. a char read from an untyped string receiver), cmpOp can't pick lex-vs-
// numeric at compile time. Pre-fix it fell into the f64 path and compared the
// unknown side's NaN-boxed string bits as a float — always false — so `s[i] >= '0'`
// silently returned 0 and digit parsers broke. cmpOp now emits a runtime
// __is_str_key dispatch on the untyped side: string ⇒ __str_cmp three-way, else
// ToNumber both. Matches JS: relational is lexicographic only when both sides are
// strings, otherwise it ToNumbers both.

test('untyped char vs string literal: lexicographic when runtime value is a string', () => {
  // 'a' (97) >= '0' (48) lexicographically → true; the read comes off an untyped param.
  is(run('export let f = (s) => s[0] >= "0"').f('a'), true)
  is(run('export let f = (s) => s[0] >= "0"').f('7'), true)
})

test('isDigit on untyped char: && of two mixed relational compares', () => {
  const { f } = run('export let f = (s) => { let c = s[0]; return c >= "0" && c <= "9" }')
  is(f('5'), true)
  is(f('x'), false) // 'x'(120) <= '9'(57) is false
})

test('mixed relational dispatches on the runtime operand type, not the static one', () => {
  // Same function, two arg types: number → ToNumber both (10>=9 true);
  // string → lexicographic ('10' vs '9': '1'<'9' → false). One emit, both JS-correct.
  const { f } = run('export let f = (x) => x >= "9"')
  is(f(10), true)
  is(f('10'), false)
})

test('untyped number vs string literal: ToNumbers both sides', () => {
  const { f } = run('export let f = (x) => x >= "0"')
  is(f(7), true)   // 7 >= 0
  is(f(-5), false)  // -5 >= 0 is false
})

test('digit parser over untyped string receiver returns the parsed number', () => {
  // The closure-heavy parser from perf.js golden — depends on `c >= '0' && c <= '9'`
  // working on chars off an untyped receiver. Pre-fix it returned 0 for every input.
  const { f } = run(`export let f = (s) => {
    let i = 0, n = s.length
    let peek = () => i < n ? s[i] : ""
    let next = () => { let c = peek(); i++; return c }
    let isDigit = (c) => c >= "0" && c <= "9"
    let total = 0
    while (i < n) { let c = next(); if (isDigit(c)) total = total * 10 + (c.charCodeAt(0) - 48) }
    return total
  }`)
  is(f('1234'), 1234)
  is(f('a12b3'), 123)
  is(f(''), 0)
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

// === .slice token-views (no-copy) ===
// A non-escaping `let t = s.slice(...)` binding lowers to a view (SLICE_BIT
// pointer into the parent buffer) — no byte copy. The view only fires when the
// receiver is provably a string and the binding provably never escapes.

test('slice-view: fires for non-escaping local-string slice', () => {
  const wat = compile(`export let f = () => {
    let s = 'hello world'
    let t = s.slice(0, 5)
    return t === 'hello' ? 1 : 0
  }`, { wat: true })
  ok(wat.includes('__str_slice_view'), 'non-escaping slice should lower to a view')
  is(run(`export let f = () => {
    let s = 'hello world'
    let t = s.slice(0, 5)
    return t === 'hello' ? 1 : 0
  }`).f(), 1)
})

test('slice-view: length + charCodeAt on a view', () => {
  is(run(`export let f = () => {
    let s = 'abcdefghij'
    let t = s.slice(2, 7)
    return t.length * 100 + t.charCodeAt(0)
  }`).f(), 5 * 100 + 'c'.charCodeAt(0))
})

test('slice-view: negative indices', () => {
  is(run(`export let f = () => {
    let s = 'abcdefg'
    let t = s.slice(-3, -1)
    return t === 'ef' ? 1 : 0
  }`).f(), 1)
})

test('slice-view: empty and out-of-range slices', () => {
  is(run(`export let f = () => {
    let s = 'abcdefg'
    let t = s.slice(3, 3)
    return t.length
  }`).f(), 0)
  is(run(`export let f = () => {
    let s = 'abc'
    let t = s.slice(0, 100)
    return t === 'abc' ? 1 : 0
  }`).f(), 1)
})

test('slice-view: view of a view', () => {
  is(run(`export let f = () => {
    let s = 'abcdefghij'
    let t = s.slice(1, 9)
    let u = t.slice(2, 5)
    return u === 'def' ? 1 : 0
  }`).f(), 1)
})

test('slice-view: slice of a long heap string', () => {
  is(run(`export let f = () => {
    let s = 'abcdefghijklmnopqrstuvwxyz0123456789'
    let t = s.slice(10, 20)
    return t === 'klmnopqrst' ? 1 : 0
  }`).f(), 1)
})

test('slice-view: concat operand keeps view (read-only use)', () => {
  const wat = compile(`export let f = () => {
    let s = 'abcdefg'
    let t = s.slice(1, 4)
    return ('X' + t) === 'Xbcd' ? 1 : 0
  }`, { wat: true })
  ok(wat.includes('__str_slice_view'), 'a + operand is a read-only use — view stays')
  is(run(`export let f = () => {
    let s = 'abcdefg'
    let t = s.slice(1, 4)
    return ('X' + t) === 'Xbcd' ? 1 : 0
  }`).f(), 1)
})

test('slice-view: escaping slice copies — returned binding', () => {
  const wat = compile(`export let f = () => {
    let s = 'abcdefg'
    let t = s.slice(1, 4)
    return t
  }`, { wat: true })
  ok(!wat.includes('__str_slice_view'), 'a returned slice escapes — must copy')
  is(run(`export let f = () => {
    let s = 'abcdefg'
    let t = s.slice(1, 4)
    return t
  }`).f(), 'bcd')
})

test('slice-view: escaping slice copies — passed as argument', () => {
  const wat = compile(`let id = (x) => x
  export let f = () => {
    let s = 'abcdefg'
    let t = s.slice(1, 4)
    return id(t) === 'bcd' ? 1 : 0
  }`, { wat: true })
  ok(!wat.includes('__str_slice_view'), 'a slice passed to a call escapes — must copy')
  is(run(`let id = (x) => x
  export let f = () => {
    let s = 'abcdefg'
    let t = s.slice(1, 4)
    return id(t) === 'bcd' ? 1 : 0
  }`).f(), 1)
})

test('slice-view: escaping slice copies — reassigned binding', () => {
  const wat = compile(`export let f = () => {
    let s = 'abcdefg'
    let t = s.slice(1, 4)
    t = 'x'
    return t === 'x' ? 1 : 0
  }`, { wat: true })
  ok(!wat.includes('__str_slice_view'), 'a reassigned binding is not a stable view')
  is(run(`export let f = () => {
    let s = 'abcdefg'
    let t = s.slice(1, 4)
    t = 'x'
    return t === 'x' ? 1 : 0
  }`).f(), 1)
})

test('slice-view: fires for a provably-string function parameter', () => {
  const wat = compile(`let helper = (s) => {
    let t = s.slice(1, 4)
    return t === 'bcd' ? 1 : 0
  }
  export let f = () => helper('abcdefg')`, { wat: true })
  ok(wat.includes('__str_slice_view'), 'string-typed param receiver should lower to a view')
  is(run(`let helper = (s) => {
    let t = s.slice(1, 4)
    return t === 'bcd' ? 1 : 0
  }
  export let f = () => helper('abcdefg')`).f(), 1)
})

test('slice-view: no view when receiver type is unknown', () => {
  const wat = compile(`export let f = (s) => {
    let t = s.slice(1, 4)
    return t === 'bcd' ? 1 : 0
  }`, { wat: true })
  ok(!wat.includes('__str_slice_view'), 'unprovable string receiver must stay on the safe path')
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

// Empty separator: regression for infinite-loop when plen=0 (advance was
// `i += plen`, so i never moved). Per JS spec: split into individual chars,
// and "".split("") → [].
test('string: .split("") splits into chars', () => {
  is(run(`export let f = () => "abc".split("").length | 0`).f(), 3)
  is(run(`export let f = () => "abc".split("")[0].charCodeAt(0) | 0`).f(), 97)
  is(run(`export let f = () => "abc".split("")[2].charCodeAt(0) | 0`).f(), 99)
  is(run(`export let f = () => "".split("").length | 0`).f(), 0)
  is(run(`export let f = () => "x".split("").length | 0`).f(), 1)
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
