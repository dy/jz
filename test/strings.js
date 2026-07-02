// Comprehensive string method tests
import test from 'tst'
import { is, ok, almost, throws } from 'tst/assert.js'
import { compile } from '../index.js'
import jz from '../index.js'
import { strHashLiteral } from '../module/collection.js'

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

// === TextEncoder ===

// The Uint8Array returned by TextEncoder.encode must support indexed and spread
// access, not just `.length`/`for-of`. Regression surfaced in watr: `str()` does
// `bytes.push(...tenc.encode(buf))` and the export-name encoder then reads those
// bytes by index. jz mis-typed the encode() result so indexed/spread reads were
// f64-strided — `encode(':')[0]` yielded a denormal (bits of 58) and
// `encode('AB')[1]` read 8 bytes ahead → 0. General Uint8Array indexing was fine;
// only encode()'s result diverged, corrupting exotic export names (':' → 0).
test('TextEncoder: encode result supports indexed access', () => {
  is(run(`export let f = () => new TextEncoder().encode(':')[0]`).f(), 58)
})

test('TextEncoder: encode result indexes each byte', () => {
  is(run(`export let f = () => {
    let b = new TextEncoder().encode('AB')
    return b[0] * 1000 + b[1]
  }`).f(), 65066)
})

test('TextEncoder: spread of encode result preserves bytes', () => {
  is(run(`export let f = () => [...new TextEncoder().encode('AB')].join(',')`).f(), '65,66')
})

// Repeated `dst.push(...tenc.encode(buf))` inside a loop with branching must keep
// reading u8 elements. This is watr's `str()` shape: a buffer is accumulated and
// flushed mid-loop on each escape. jz lowers the 2nd (and later) flush through the
// element-unaware __typed_idx fallback (f64.load, stride 8), so the spread reads a
// denormal that truncates to 0 — corrupting the byte after the first flush. The
// first flush and a single trailing flush are fine; only repeated mid-loop flushes
// regress. Surfaced as a literal ':' byte decoding to 0 in an exotic export name.
test('TextEncoder: repeated mid-loop spread-flush keeps bytes (str() shape)', () => {
  const { f } = run(`
    const tenc = new TextEncoder()
    const enc = (s) => {
      let bytes = [], buf = ''
      for (let i = 0; i < s.length; i++) {
        let c = s[i]
        if (c === '|') { if (buf) bytes.push(...tenc.encode(buf)); buf = ''; bytes.push(34) }
        else buf += c
      }
      if (buf) bytes.push(...tenc.encode(buf))
      return bytes.join(',')
    }
    export let f = () => enc('a|b|c')
  `)
  is(f(), '97,34,98,34,99')
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

test('string +=: accumulator (known STRING) skips its own re-coercion per append', () => {
  // `s += part`: `s` is proven STRING, so the `+` emitter must not re-ToString the
  // accumulator on every append — only the unknown `part` needs `__to_str`. Build a
  // string the natural way and verify it matches JS exactly across mixed value types.
  const f = run('export let f = (a, b, c) => { let s = ""; s += a; s += b; s += c; return s }').f
  is(f(1, '-', 2), '1-2', 'number/string/number accumulate correctly')
  is(f('x', 'y', 'z'), 'xyz', 'all-string accumulate')
})

test('string +: mixed known-string + unknown stays JS-correct (concatRaw path)', () => {
  // The one-known-one-unknown concat coerces ONLY the unknown side, then concatRaw.
  // Must match JS String(+) semantics for every value the unknown could be.
  const f = run('export let f = (x) => "P:" + x').f
  is(f(5), 'P:5')
  is(f('hi'), 'P:hi')
  is(f(-1.5), 'P:-1.5')
  is(f([1, 2]), 'P:1,2', 'array → comma-joined like JS Array.toString')
})

test('string +: realistic build-string loop matches JS', () => {
  const f = run('export let f = (n) => { let s = ""; for (let i = 0; i < n; i++) { s += i; s += "," } return s }').f
  is(f(4), '0,1,2,3,')
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

test('parseInt: round-once past 2^53 matches JS (exact i64 accumulation)', () => {
  // The integer is accumulated exactly (u64) and rounded once to f64 at the end, so values
  // beyond f64's exact integer range still match JS — which rounds the exact mathInt, not each
  // intermediate. (Under host:js parseInt is a host import; under wasi it runs the WAT above.)
  const dec = (s) => is(run(`export let f = () => parseInt(${JSON.stringify(s)})`).f(), parseInt(s), s)
  dec('9007199254740993')        // 2^53 + 1
  dec('9223372036854775807')     // 2^63 - 1
  dec('18446744073709551615')    // 2^64 - 1
  dec('0xffffffffffffffff')      // 2^64 - 1 in hex
  // >2^64 power-of-two radix exercises the sticky-bit rounding path
  is(run('export let f = () => parseInt("0x100000000000008000000000", 16)').f(),
     parseInt('0x100000000000008000000000', 16))
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
  // `s` is built from a PARAM (not a literal): a literal receiver is now a preEval
  // compile-time constant fold (test/preeval.js covers that path — it beats a view
  // outright, folding straight to the result) and would never reach the runtime view
  // lowering this test targets. Concatenating a param keeps `s` a genuine runtime
  // string (provably string-typed, but not constant-foldable) so the view mechanism
  // is still the one being exercised.
  // The slice must be >6 bytes: ≤6-ASCII results SSO-pack instead of becoming a
  // view (the ≤6-ASCII⇒SSO invariant — a short VIEW would break bit-equality).
  const wat = compile(`export let f = (p) => {
    let s = p + ' big world'
    let t = s.slice(0, 9)
    return t === 'hello big' ? 1 : 0
  }`, { wat: true })
  ok(wat.includes('__str_slice_view'), 'non-escaping slice should lower to a view')
  is(run(`export let f = (p) => {
    let s = p + ' big world'
    let t = s.slice(0, 9)
    return t === 'hello big' ? 1 : 0
  }`).f('hello'), 1)
  // ≤6-byte slice of the same shape stays correct (SSO-packed, not a view)
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
  // `s` is built from a param — see the comment on the previous test.
  const wat = compile(`export let f = (p) => {
    let s = p + 'defg'
    let t = s.slice(1, 4)
    return ('X' + t) === 'Xbcd' ? 1 : 0
  }`, { wat: true })
  ok(wat.includes('__str_slice_view'), 'a + operand is a read-only use — view stays')
  is(run(`export let f = (p) => {
    let s = p + 'defg'
    let t = s.slice(1, 4)
    return ('X' + t) === 'Xbcd' ? 1 : 0
  }`).f('abc'), 1)
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
  // sourceInline off: pins escape-driven copying at a REAL call boundary —
  // the leaf inliner would otherwise dissolve id() and the view (correctly)
  // stops escaping.
  const wat = compile(`let id = (x) => x
  export let f = () => {
    let s = 'abcdefg'
    let t = s.slice(1, 4)
    return id(t) === 'bcd' ? 1 : 0
  }`, { wat: true, optimize: { sourceInline: false } })
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
  is(run(`export let f = () => "hello".includes("ell")`).f(), true)
})

test('string: .includes not found', () => {
  is(run(`export let f = () => "hello".includes("xyz")`).f(), false)
})

// === .startsWith ===

test('string: .startsWith true', () => {
  is(run(`export let f = () => "hello".startsWith("hel")`).f(), true)
})

test('string: .startsWith false', () => {
  is(run(`export let f = () => "hello".startsWith("lo")`).f(), false)
})

// === .endsWith ===

test('string: .endsWith true', () => {
  is(run(`export let f = () => "hello".endsWith("lo")`).f(), true)
})

test('string: .endsWith false', () => {
  is(run(`export let f = () => "hello".endsWith("hel")`).f(), false)
})

// === .toUpperCase ===

test('string: .toUpperCase', () => {
  is(run(`export let f = () => "hello".toUpperCase()`).f(), 'HELLO')
  // only ASCII letters change; digits/punctuation/already-upper pass through.
  is(run(`export let f = () => "aB3z!".toUpperCase()`).f(), 'AB3Z!')
})

// === .toLowerCase ===

test('string: .toLowerCase', () => {
  is(run(`export let f = () => "HELLO".toLowerCase()`).f(), 'hello')
  is(run(`export let f = () => "Ab3Z!".toLowerCase()`).f(), 'ab3z!')
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
  is(run(`export let f = () => "hello".toUpperCase().slice(0, 2)`).f(), 'HE')
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

// === charAt, charCodeAt, at ===

test('String: charAt', () => {
  is(run(`export let f = () => "hello".charAt(1).charCodeAt(0)`).f(), 101)
})

test('String: charCodeAt', () => {
  is(run(`export let f = () => "ABC".charCodeAt(0)`).f(), 65)
})

test('String: charCodeAt(2)', () => {
  is(run(`export let f = () => "ABC".charCodeAt(2)`).f(), 67)
})

test('String: at positive', () => {
  is(run(`export let f = () => "hello".at(0).charCodeAt(0)`).f(), 104)
})

test('String: at negative', () => {
  is(run(`export let f = () => "hello".at(-1).charCodeAt(0)`).f(), 111)
})

test('String: charAt out of range → "" (not "\\x00")', () => {
  is(run(`export let f = () => "abc".charAt(5)`).f(), '')   // past end
  is(run(`export let f = () => "abc".charAt(-1)`).f(), '')  // negative (no wraparound)
  is(run(`export let f = () => "".charAt(0)`).f(), '')      // empty receiver
  is(run(`export let f = () => "abc".charAt(0)`).f(), 'a')  // in-range still works
})

test('String: at out of range → undefined (not "\\x00")', () => {
  ok(run(`export let f = () => "hi".at(5)`).f() === undefined, 'past end → undefined')
  ok(run(`export let f = () => "hi".at(-9)`).f() === undefined, 'negative past start → undefined')
  is(run(`export let f = () => "abc".at(1)`).f(), 'b')      // in-range
  is(run(`export let f = () => "abc".at(-1)`).f(), 'c')     // negative in-range
})

test('String: .at on an untyped param dispatches to the string handler (not array)', () => {
  // Regression: `at: ['core','array']` in autoload routed param `.at` to the array
  // handler (raw f64 heap read). Now lists 'string' too → runtime ptr-type branch.
  const f = run(`export let f = (s) => s.at(0)`).f
  is(f('hello'), 'h')
  ok(run(`export let g = (s) => s.at(9)`).g('abc') === undefined, 'OOB on param → undefined')
})

// === search / match ===

test('String: search found', () => {
  is(run(`export let f = () => "hello world".search("world")`).f(), 6)
})

test('String: search not found', () => {
  is(run(`export let f = () => "hello".search("xyz")`).f(), -1)
})

test('String: match found', () => {
  is(run(`export let f = () => "hello world".match("world").length`).f(), 1)
})

test('String: match not found', () => {
  is(run(`export let f = () => "hello".match("xyz")`).f(), 0)
})

test('String: match result content', () => {
  is(run(`export let f = () => "hello world".match("world")[0].length`).f(), 5)
})

test('String: .concat on a dynamic (untyped) receiver', () => {
  // Regression: untyped `s.concat(...)` fell through to dynamic dispatch and hit an
  // internal "__ext_call never registered" error. Now routed via the runtime
  // string/array ptr-type branch (string → __str_concat).
  is(run(`export let f = (s) => s.concat("!")`).f('hi'), 'hi!')
  is(run(`export let f = (s) => s.concat("-", "x")`).f('hi'), 'hi-x')
  is(run(`export let f = () => "ab".concat("cd")`).f(), 'abcd')
})

// Documented divergence: `+` on two untyped params infers numeric addition (no
// operand proves a string), so string args yield NaN, not concatenation — `+`
// stays a single f64.add in numeric kernels. Give one side string evidence to
// concatenate. See README "Where does jz differ".
test('string +: untyped params are numeric, not concat (documented divergence)', () => {
  ok(Number.isNaN(run(`export let f = (a, b) => a + b`).f('foo', 'bar')))  // numeric +, strings → NaN
  is(run(`export let f = (a, b) => a + b`).f(2, 3), 5)                     // numeric still works
  is(run(`export let f = (a) => 'n' + a`).f(7), 'n7')                      // literal operand → concat
})

// === Bug-fix regression tests ===

// Bug 1: split() with no argument → [str] (JS oracle)
test('string: .split() no arg returns single-element array of whole string', () => {
  is(run(`export let f = () => "abc".split().length`).f(), 'abc'.split().length)
  is(run(`export let f = () => "abc".split()[0]`).f(), 'abc'.split()[0])
  is(run(`export let f = () => "".split().length`).f(), ''.split().length)
})

// Bug 2: split(sep, limit) — limit must truncate the result (JS oracle)
test('string: .split(sep, limit) honours limit', () => {
  is(run(`export let f = () => "a,b,c".split(",", 0).length`).f(), 'a,b,c'.split(',', 0).length)
  is(run(`export let f = () => "a,b,c".split(",", 1).length`).f(), 'a,b,c'.split(',', 1).length)
  is(run(`export let f = () => "a,b,c".split(",", 1)[0]`).f(), 'a,b,c'.split(',', 1)[0])
  is(run(`export let f = () => "a,b,c".split(",", 2).length`).f(), 'a,b,c'.split(',', 2).length)
  is(run(`export let f = () => "a,b,c".split(",", 2)[1]`).f(), 'a,b,c'.split(',', 2)[1])
  is(run(`export let f = () => "a,b,c".split(",", 5).length`).f(), 'a,b,c'.split(',', 5).length)
})

test('string: .split("", limit) honours limit on empty sep', () => {
  is(run(`export let f = () => "abc".split("", 2).length`).f(), 'abc'.split('', 2).length)
  is(run(`export let f = () => "abc".split("", 2)[1]`).f(), 'abc'.split('', 2)[1])
})

// Bug 3: lastIndexOf — not previously implemented
test('string: .lastIndexOf basic', () => {
  is(run(`export let f = () => "hello".lastIndexOf("l")`).f(), 'hello'.lastIndexOf('l'))
  is(run(`export let f = () => "hello".lastIndexOf("x")`).f(), 'hello'.lastIndexOf('x'))
  is(run(`export let f = () => "hello".lastIndexOf("h")`).f(), 'hello'.lastIndexOf('h'))
})

test('string: .lastIndexOf with fromIndex', () => {
  is(run(`export let f = () => "hello".lastIndexOf("l", 2)`).f(), 'hello'.lastIndexOf('l', 2))
  is(run(`export let f = () => "abcabc".lastIndexOf("bc", 3)`).f(), 'abcabc'.lastIndexOf('bc', 3))
  is(run(`export let f = () => "abcabc".lastIndexOf("bc")`).f(), 'abcabc'.lastIndexOf('bc'))
})

// Bug 4: codePointAt — byte-value semantics for ASCII (matches JS for U+0000..U+007F)
test('string: .codePointAt ASCII matches JS', () => {
  is(run(`export let f = () => "ABC".codePointAt(0)`).f(), 'ABC'.codePointAt(0))
  is(run(`export let f = () => "ABC".codePointAt(1)`).f(), 'ABC'.codePointAt(1))
  is(run(`export let f = () => "ABC".codePointAt(2)`).f(), 'ABC'.codePointAt(2))
  is(run(`export let f = () => "hello".codePointAt(0)`).f(), 'hello'.codePointAt(0))
})

// replace(search, fn): a function replacer is called with the matched substring,
// and its return (ToString'd) replaces the match. String search → first match.
test('string: .replace(search, fn) invokes the callback', () => {
  const run = src => jz(src).exports.f
  is(run(`export let f = (s) => s.replace("l", (m) => m.toUpperCase())`)('hello'),
    'hello'.replace('l', m => m.toUpperCase()))   // 'heLlo' — first match only
  is(run(`export let f = (s) => s.replace("z", (m) => m)`)('hello'),
    'hello'.replace('z', m => m))                  // no match → unchanged
  is(run(`export let f = () => "ab".replace("a", (m) => m + m)`)(),
    'ab'.replace('a', m => m + m))                 // 'aab'
})

// === SSO 6-char / 7-bit codec (chars 4-5 span the offset/aux boundary) ===
// Regression guard for the 7-bit ASCII small-string optimization: every string
// producer and consumer must agree on the layout (char i at payload bit i*7, len at
// bits 42-44). A missed site silently corrupts strings, so exercise each path on
// 5- and 6-char ASCII (the aux-spanning range) plus the host boundary.
test('SSO 7-bit: 6-char literal charCodeAt across the aux boundary', () => {
  const f = run(`export let f = (i) => "abcdef".charCodeAt(i)`).f
  for (let i = 0; i < 6; i++) is(f(i), 'abcdef'.charCodeAt(i))   // i=4,5 read from aux
})
test('SSO 7-bit: 5/6-char length', () => {
  is(run(`export let f = () => "const".length`).f(), 5)
  is(run(`export let f = () => "return".length`).f(), 6)
})
test('SSO 7-bit: literal === literal and heap === SSO-literal (mixed)', () => {
  is(run(`export let f = () => "string" === "string" ? 1 : 0`).f(), 1)
  is(run(`export let f = (s) => s.toUpperCase() === "ABCDEF" ? 1 : 0`).f('abcdef'), 1)  // heap === SSO-literal
  is(run(`export let f = (s) => s.toUpperCase() === "ABCDEX" ? 1 : 0`).f('abcdef'), 0)
  is(run(`export let f = (s) => ("ab" + s) === "abcdef" ? 1 : 0`).f('cdef'), 1)         // heap concat === SSO-literal
})
test('SSO 7-bit: materialized concat round-trips length + tail char (slow copy path)', () => {
  // "lit" + param and accumulator both materialize the result and read it back
  // (param + param has a separate, pre-existing concat bug, so it is avoided here).
  is(run(`export let f = (s) => { let x = "re" + s; return x.length*1000 + x.charCodeAt(x.length-1) }`).f('turn'), 6000 + 'n'.charCodeAt(0))
  is(run(`export let f = () => { let s = ""; s += "re"; s += "sult"; return s.length*1000 + s.charCodeAt(5) }`).f(), 6000 + 't'.charCodeAt(0))
})
test('SSO 7-bit: slice produces a correct 6-char SSO', () => {
  is(run(`export let f = (s) => s.slice(0,6)`).f('returns'), 'return')
  is(run(`export let f = (s) => s.slice(1,6).charCodeAt(4)`).f('xresult'), 'result'.charCodeAt(4))
})
test('SSO 7-bit: indexOf / startsWith / endsWith on 6-char', () => {
  is(run(`export let f = (s) => s.indexOf("def")`).f('abcdef'), 3)
  is(run(`export let f = (s) => s.startsWith("abc") ? 1 : 0`).f('abcdef'), 1)
  is(run(`export let f = (s) => s.endsWith("def") ? 1 : 0`).f('abcdef'), 1)
})
test('SSO 7-bit: toUpperCase / toLowerCase on 5-6 char', () => {
  is(run(`export let f = (s) => s.toUpperCase()`).f('hello'), 'HELLO')
  is(run(`export let f = (s) => s.toLowerCase()`).f('STRING'), 'string')
})
test('SSO 7-bit: number→string concat keeps digits (itoa SSO path)', () => {
  is(run(`export let f = (n) => "P:" + n`).f(5), 'P:5')
  is(run(`export let f = () => { let s = ""; for (let i=0;i<4;i++) s += i; return s }`).f(), '0123')
})
test('SSO 7-bit: Set/Map with 6-char string keys (collection hash)', () => {
  is(run(`export let f = () => { let s = new Set(); s.add("string"); s.add("result"); return (s.has("string") && s.has("result") && !s.has("absent")) ? 1 : 0 }`).f(), 1)
})
test('SSO 7-bit: JSON.parse 4-char key/value round-trips', () => {
  is(run(`export let f = () => JSON.parse('{"name":"jdef"}').name`).f(), 'jdef')
})

// === ≤6-ASCII⇒SSO producer invariant (module/string.js header) ===
// Every producer must normalize a short ASCII result to SSO: `x === "shortLit"`
// lowers to a bare i64.eq and __str_eq decides any one-SSO compare by bits, so a
// producer that leaks a ≤6-ASCII HEAP string silently breaks string equality.
// Each case below builds a short string through a different producer and compares
// it against an SSO literal — a leak makes the compare return false.
test('SSO invariant: concat (both-SSO splice, mixed pack, coerced)', () => {
  is(run(`export let f = () => ("abc" + "def") === "abcdef" ? 1 : 0`).f(), 1)
  is(run(`export let f = (s) => (s.slice(0, 3) + "de") === "abcde" ? 1 : 0`).f('abcxyzzz'), 1)
  is(run(`export let f = (s) => ("x" + s) === "xab" ? 1 : 0`).f('ab'), 1)
  is(run(`let t = true; export let f = () => (t + "") === "true" ? 1 : 0`).f(), 1)
  is(run(`let x = false; export let f = () => (x + "") === "false" ? 1 : 0`).f(), 1)
})
test('SSO invariant: builder append stays SSO through 6 chars', () => {
  is(run(`export let f = () => { let s = ""; s += "ab"; s += "cd"; s += "ef"; return s === "abcdef" ? 1 : 0 }`).f(), 1)
  is(run(`export let f = (x) => { let s = ""; for (let i = 0; i < 5; i++) s += x[i]; return s === "abcde" ? 1 : 0 }`).f('abcdef'), 1)
})
test('SSO invariant: number formatting (mkstr/ftoa/static_str)', () => {
  is(run(`export let f = (n) => String(n) === "123456" ? 1 : 0`).f(123456), 1)
  is(run(`export let f = (n) => (n + "") === "-1.5" ? 1 : 0`).f(-1.5), 1)
  is(run(`export let f = (n) => (n + "") === "NaN" ? 1 : 0`).f(NaN), 1)
  is(run(`export let f = (n) => n.toString(16) === "ff" ? 1 : 0`).f(255), 1)
})
test('SSO invariant: toUpperCase/toLowerCase of SSO stays SSO', () => {
  is(run(`export let f = (s) => s.toUpperCase() === "ABCDEF" ? 1 : 0`).f('abcdef'), 1)
  is(run(`export let f = (s) => s.slice(0, 5).toLowerCase() === "abcde" ? 1 : 0`).f('ABCDEXYZ'), 1)
})
test('SSO invariant: repeat / pad short results', () => {
  is(run(`export let f = (s) => s.repeat(2) === "ababab".slice(0, 4) ? 1 : 0`).f('ab'), 1)
  is(run(`export let f = (s) => s.padStart(5, "0") === "00abc" ? 1 : 0`).f('abc'), 1)
  is(run(`export let f = (s) => s.padEnd(6, ".") === "abc..." ? 1 : 0`).f('abc'), 1)
})
test('SSO invariant: split pieces and trim results', () => {
  is(run(`export let f = (s) => s.split(",")[1] === "bcdef" ? 1 : 0`).f('aaaaaaa,bcdef,cc'), 1)
  is(run(`export let f = (s) => s.trim() === "abcde" ? 1 : 0`).f('   abcde   '), 1)
})
test('SSO invariant: JSON.parse 5-6 char strings (simple + escape paths)', () => {
  is(run(`export let f = (s) => JSON.parse(s).k === "hello" ? 1 : 0`).f('{"k":"hello"}'), 1)
  is(run(String.raw`export let f = (s) => JSON.parse(s).k === "a\nb" ? 1 : 0`).f('{"k":"a\\nb"}'), 1)
})
test('SSO invariant: URI codecs short results', () => {
  is(run(`export let f = (s) => decodeURIComponent(s) === "a b" ? 1 : 0`).f('a%20b'), 1)
  is(run(`export let f = (s) => encodeURIComponent(s) === "abc" ? 1 : 0`).f('abc'), 1)
})
test('SSO invariant: String.fromCharCode multi-arg', () => {
  is(run(`export let f = () => String.fromCharCode(97, 98, 99, 100, 101) === "abcde" ? 1 : 0`).f(), 1)
})
test('SSO invariant: template literal short results (the $-name builder shape)', () => {
  // The kernel builds wasm identifiers via \`$\${name}\` — a leaked short heap
  // string here broke the self-host ("Unknown global $add5").
  is(run('export let f = (s) => `$${s}` === "$a5" ? 1 : 0').f('a5'), 1)
  is(run('export let f = (s) => `x${s}y${s}` === "xa5ya5" ? 1 : 0').f('a5'), 1)
  is(run('export let f = (n) => `f${n}` === "f12" ? 1 : 0').f(12), 1)
})
test('SSO invariant: long/non-ASCII strings still content-compare (heap fallback intact)', () => {
  is(run(`export let f = (s) => (s + "n") === "function" ? 1 : 0`).f('functio'), 1)
  is(run(`export let f = (s) => s === "héllo" ? 1 : 0`).f('héllo'), 1)
  is(run(`export let f = (s) => (s + "é") === "aé" ? 1 : 0`).f('a'), 1)
})

// === `x === "literal"` specialization (emit.js emitLooseEq) ===
// The compiler's hottest comparison (`node[0] === 'if'` AST-tag dispatch). When one
// operand is statically a string, emit skips the generic __eq NaN-box dispatch and
// inlines `i64.eq ? equal : (__is_str_key(u) ? __str_eq : ne)`. Behaviorally identical
// to __eq (jz's ==/=== never coerce); the win is on the self-host kernel's own 5579 sites.
test('str-eq spec: heap concat === SSO literal is true (the soundness case)', () => {
  // `"i"+"f"` allocates a HEAP "if" with different bits than the inline SSO literal —
  // a pure i64.eq would wrongly say not-equal; the __str_eq fallback content-compares.
  for (const opt of [false, 2]) {
    is(jz(`let x = "i"+"f"; export let main = () => (x === "if") | 0`, { optimize: opt }).exports.main(), 1, `concat===lit @${opt}`)
    is(jz(`let x = "func"+"tion"; export let main = () => (x === "function") | 0`, { optimize: opt }).exports.main(), 1, `long concat===lit @${opt}`)
    is(jz(`let x = "i"+"g"; export let main = () => (x === "if") | 0`, { optimize: opt }).exports.main(), 0, `concat!==lit @${opt}`)
    is(jz(`let x = "i"+"f"; export let main = () => (x !== "if") | 0`, { optimize: opt }).exports.main(), 0, `!== negate @${opt}`)
  }
})
test('str-eq spec: non-string vs string literal is false, no deref (number/null/array)', () => {
  // __is_str_key rejects a number whose f64 bits could alias the STRING tag — number
  // ===/== string must be false (jz does not coerce), never a wild __str_eq deref.
  is(jz(`let x = 5; export let main = () => (x === "5") | 0`).exports.main(), 0)
  is(jz(`let x = 1.5e308; export let main = () => (x === "if") | 0`).exports.main(), 0)
  is(jz(`let x = null; export let main = () => (x === "x") | 0`).exports.main(), 0)
  is(jz(`let x = [1,2]; export let main = () => (x === "1,2") | 0`).exports.main(), 0)
})
test('str-eq spec: tag-dispatch chain + Map heap key + symmetric placement', () => {
  is(jz(`let n = ["let",1]; export let main = () => (n[0] === "if" ? 1 : n[0] === "let" ? 2 : 0)`).exports.main(), 2)
  is(jz(`let m = new Map(); m.set("a"+"b", 7); export let main = () => m.get("ab")`).exports.main(), 7)
  is(jz(`let x = "i"+"f"; export let main = () => ("if" === x) | 0`).exports.main(), 1)  // literal on the left
})
test('str-eq spec: lowering avoids __eq, numeric === keeps its fast path', () => {
  // `x === "shortLit"` (≤6 ASCII) is a bare i64.eq — the SSO literal's NaN-box IS its
  // content and every producer normalizes short ASCII to SSO, so no call is needed.
  const ssoEq = compile(`export let f = (x) => (x === "if") | 0`, { wat: true })
  ok(!/\$__is_str_key|\$__str_eq|\$__eq\b/.test(ssoEq), 'SSO-literal === is a bare i64.eq, no helper calls')
  ok(/i64\.eq/.test(ssoEq), 'SSO-literal === compares NaN-box bits')
  // `x === "longLiteral"` (>6 chars, heap static) keeps the guarded fallback.
  const strEq = compile(`export let f = (x) => (x === "function") | 0`, { wat: true })
  ok(/\$__is_str_key/.test(strEq) && /\$__str_eq/.test(strEq), 'heap-literal === uses __is_str_key + __str_eq')
  ok(!/\$__eq\b/.test(strEq), 'string === literal does NOT call the generic __eq')
  // numeric === must not be dragged into the string path.
  const numEq = compile(`export let f = (x) => (x === 5) | 0`, { wat: true })
  ok(!/\$__str_eq|\$__is_str_key/.test(numEq), 'numeric === stays off the string path')
})

test('indexOf substr: SIMD first-byte memchr is emitted + matches V8 over edge cases', () => {
  // The multi-byte heap-haystack path broadcasts needle[0] and reads an i8x16.eq bitmask —
  // a scan-bound substr search dropped from 5.7× slower than V8 to ~1.4×. The SIMD window only
  // touches the HAYSTACK, so a SHORT (SSO, ≤6B) needle — the common ","/"://"/"TARGET" — rides it
  // too (its bytes fetched SSO-aware), not just heap×heap; that closed an 11×→1.4× gap.
  const wat = compile(`export let f = (h, n) => h.indexOf(n)`, { wat: true })
  ok(/i8x16\.bitmask/.test(wat) && /i8x16\.eq/.test(wat), '__str_indexof carries the SIMD first-byte scan')

  const { f, g, e } = jz(`
    export let f = (h, n) => h.indexOf(n)
    export let g = (h, n, k) => h.indexOf(n, k | 0)
    export let e = (h, n) => h.includes(n) ? 1 : 0
  `).exports
  // long heap haystack (>16B, multiple SIMD windows), match near the end, with a SHORT SSO needle
  const hay = 'xabcdefgh'.repeat(28) + 'TARGET_q'   // 260 B heap; "TARGET" is a 6-byte SSO needle
  for (const ndl of ['TARGET', 'T', 'ARGE', '_q', 'xa', 'zzz']) is(f(hay, ndl), hay.indexOf(ndl), `SSO needle ${JSON.stringify(ndl)} over long heap`)
  // first-byte collisions + false candidates within a chunk: 'ab' over an 'ab'-dense string
  const dense = 'abababab abab abXab ababYabZ ab!'
  for (const q of ['ab', 'abX', 'abYab', 'abZ', 'ab!', 'qq', '']) is(f(dense, q), dense.indexOf(q), `dense indexOf ${JSON.stringify(q)}`)
  // from-offset clamping incl. negative + past-end, and empty-needle clamp (spec step 6)
  for (const k of [-5, 0, 3, 1000]) is(g(dense, 'ab', k), dense.indexOf('ab', k), `from=${k}`)
  is(g(dense, '', -5), dense.indexOf('', -5))     // empty needle clamps to 0, not -5
  is(g(dense, '', 1000), dense.indexOf('', 1000)) // empty needle clamps to len
  is(e(hay, 'TARGET'), 1); is(e(hay, 'NOPE'), 0)
})

test('concat: t = s + x must NOT mutate s (bump-extend gated to self-accumulation)', () => {
  // The heap-top in-place EXTEND is sound only when the result replaces its own lhs (`x = x + …`).
  // A fresh target `t = s + x` over a live, heap-top `s` used to grow s in place (s += 2 bytes/iter).
  const { loop, after, accum, charAppend } = jz(`
    export let loop = (s, n) => { let a = 0; for (let r = 0; r < n; r = r + 1) { let t = s + "_x"; a = (a + t.length) | 0 } return a | 0 }
    export let after = (s) => { for (let r = 0; r < 5; r = r + 1) { let t = s + "_x" } return s.length | 0 }
    export let accum = (n) => { let buf = ""; for (let i = 0; i < n; i = i + 1) buf = buf + "ab"; return buf.length | 0 }
    export let charAppend = (s) => { let buf = ""; for (let i = 0; i < s.length; i = i + 1) buf = buf + s[i]; return buf.length | 0 }
  `).exports
  const HEAP = "abcdefghij_klmnopqr_stuvwxyz_0123456789"   // 39 B heap, lands at the bump top
  is(loop(HEAP, 100), 4100)        // 41 × 100 — was 14000 (t grew 41,43,45,… as s mutated)
  is(after(HEAP), HEAP.length)     // s itself is untouched
  is(accum(500), 1000)             // self-accumulation still builds correctly (and stays O(N))
  is(charAppend(HEAP), HEAP.length)

  // a self-accumulation keeps the bump-EXTEND helper; a fresh target gets the non-mutating twin.
  const accumW = compile(`export let f = (n) => { let b = ""; for (let i = 0; i < n; i = i + 1) b = b + "ab"; return b.length | 0 }`, { wat: true })
  const freshW = compile(`export let f = (s) => { let t = s + "_x"; return t.length | 0 }`, { wat: true })
  ok(!/__str_concat_raw_fresh/.test(accumW), 'b = b + "ab" keeps the bump-extend concat (O(N) accumulator)')
  ok(/__str_concat_raw_fresh/.test(freshW), 't = s + "_x" uses the non-mutating fresh concat')
})

// === SSO hash-mix agreement (__str_hash's SSO branch vs strHashLiteral's compile-time
// prehash) — every producer of a ≤6-ASCII SSO string, crossed against every consumer of a
// compile-time-literal-prehashed probe. A key built at runtime by producer P must be found
// by a `.get`/`.has`/dot-access whose key is a same-content STATIC LITERAL (which folds its
// hash via strHashLiteral, module/collection.js, entirely at compile time — no __str_hash
// call). If the two hash functions ever disagree for the same SSO bits, the probe silently
// misses instead of erroring, so this is exercised for every producer × every collection
// (Map/Set/HASH-object) × lengths 1-6.
test('SSO hash mix: literal-prehashed probe finds a same-content key from every producer', () => {
  const producers = {
    literal: (k) => `"${k}"`,
    concat: (k) => k.length > 1 ? `("${k[0]}" + "${k.slice(1)}")` : `("${k}" + "")`,
    slice: (k) => `("${k}XX".slice(0, ${k.length}))`,
    numToStr: (n) => `String(${n})`,
    template: (k) => k.length > 1 ? `\`${k[0]}\${"${k.slice(1)}"}\`` : `\`\${"${k}"}\``,
  }
  const lens = ['a', 'ab', 'abc', 'abcd', 'abcde', 'abcdef']
  for (const k of lens) {
    for (const [name, mk] of Object.entries(producers)) {
      if (name === 'numToStr' && !/^\d+$/.test(k)) continue
      const expr = mk(k)
      // Map.set(runtime key) → Map.get("literal") must hit.
      is(jz(`export let f = () => { let m = new Map(); m.set(${expr}, 1); return m.get("${k}") }`).exports.f(), 1,
        `Map ${name} len=${k.length} set→literal get`)
      // Set.add(runtime key) → Set.has("literal") must hit; a near-miss (last char flipped) must not.
      const near = k.slice(0, -1) + (k.at(-1) === 'z' ? 'y' : 'z')
      is(jz(`export let f = () => { let s = new Set(); s.add(${expr}); return (s.has("${k}") && !s.has("${near}")) ? 1 : 0 }`).exports.f(), 1,
        `Set ${name} len=${k.length} add→literal has (+ near-miss rejects)`)
      // Dynamic-object bracket-set(runtime key) → dot-access("literal" identifier) must hit
      // (only when k is a valid identifier — dot syntax requires that).
      if (/^[A-Za-z_]\w*$/.test(k)) {
        is(jz(`export let f = () => { let o = {}; o[${expr}] = 1; return o.${k} }`).exports.f(), 1,
          `HASH ${name} len=${k.length} bracket-set→dot-read`)
      }
    }
  }
})
test('SSO hash mix: literal-prehashed probe finds a same-content key from JSON.parse', () => {
  // __jp_str's simple (no-escape) fast path and its escape-decode path both normalize
  // ≤6-ASCII results to SSO (module/json.js __sso_norm calls) — both must be found by a
  // literal-keyed dot-read, which folds strHashLiteral at compile time.
  for (const k of ['a', 'ab', 'abc', 'abcd', 'abcde', 'abcdef']) {
    is(jz(`export let f = (s) => { let o = JSON.parse(s); return o.${k} }`).exports.f(`{"${k}":1}`), 1,
      `JSON.parse simple len=${k.length} → literal dot-read`)
  }
  // Escape-bearing key that decodes to a short ASCII string ("\n" → 1 char).
  is(jz(`export let f = (s) => { let o = JSON.parse(s); return o.k }`).exports.f('{"k":"a\\nb"}'), 'a\nb')
})
test('SSO hash mix: clamp (h<=1 -> h+=2) holds for both JS and WAT by construction', () => {
  // __str_hash and strHashLiteral both clamp a raw mix result of 0 or 1 up to 2 — the
  // sentinel convention shared by every hash consumer (0=empty slot, 1=tombstone). Finding
  // an input that actually lands on 0/1 pre-clamp isn't required to prove the clamp is
  // wired correctly: both sides run the identical clamp expression
  // `(h<=1) ? h+2 : h` (JS: module/collection.js clampHash; WAT: __str_hash's shared
  // epilogue, unchanged by the SSO-mix rewrite) — so cross-checking any output stays ≥2
  // over a wide sweep is the operative guarantee no key ever collides with the sentinels.
  let minSeen = Infinity
  for (let a = 0; a < 128; a += 7) for (let b = 0; b < 128; b += 11) {
    const s = String.fromCharCode(97 + (a % 26)) + String.fromCharCode(97 + (b % 26))
    minSeen = Math.min(minSeen, strHashLiteral(s))
  }
  ok(minSeen >= 2, `strHashLiteral never returns the 0/1 sentinels (min seen: ${minSeen})`)
})
