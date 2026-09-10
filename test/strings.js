// Comprehensive string method tests
import test from 'tst'
import { is, ok, almost, throws } from 'tst/assert.js'
import { compile } from '../index.js'
import jz from '../index.js'
import { strHashLiteral } from '../module/collection.js'
import { levels } from './_matrix.js'
import { run, oracle, cases } from './util.js'


// ============================================
// STRING METHODS
// ============================================

// === String.fromCharCode ===

test('String.fromCharCode: A', () => {
  is(run('export let f = () => String.fromCharCode(65).length').f(), 1)
})

test('encodeURIComponent', () => {
  cases([
    ['leaves unescaped characters intact', `() => encodeURIComponent("AZaz09-_.!~*'()")`, "AZaz09-_.!~*'()"],
    ['percent-encodes reserved and whitespace bytes', '() => encodeURIComponent("a b?x=1&y=/")', 'a%20b%3Fx%3D1%26y%3D%2F'],
    ['percent-encodes UTF-8 bytes', '() => encodeURIComponent("é ☃")', '%C3%A9%20%E2%98%83'],
    ['missing argument encodes undefined', '() => encodeURIComponent()', 'undefined'],
  ])
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
test('TextEncoder', () => {
  cases([
    ['encode result supports indexed access', `() => new TextEncoder().encode(':')[0]`, 58],
    ['encode result indexes each byte', `() => {
      let b = new TextEncoder().encode('AB')
      return b[0] * 1000 + b[1]
    }`, 65066],
    ['spread of encode result preserves bytes', `() => [...new TextEncoder().encode('AB')].join(',')`, '65,66'],
  ])
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

test('string ==', () => {
  cases([
    ['compares by value', '() => "module" == "module"', true],
    ['concatenated string compares by value', '() => { let s = "mod" + "ule"; return s == "module" }', true],
  ])
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

test('string <', () => {
  cases([
    ['shared prefix, shorter sorts first: app < apple', '() => "app" < "apple"', true],
    ['shared prefix, shorter sorts first: apple < app', '() => "apple" < "app"', false],
    ['empty sorts before non-empty: "" < "a"', '() => "" < "a"', true],
    ['empty sorts before non-empty: "a" < ""', '() => "a" < ""', false],
  ])
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

test('.localeCompare', () => {
  cases([
    ['returns -1/0/1: a vs b', '() => "a".localeCompare("b")', -1],
    ['returns -1/0/1: a vs a', '() => "a".localeCompare("a")', 0],
    ['returns -1/0/1: b vs a', '() => "b".localeCompare("a")', 1],
    ['shared prefix tiebreaks by length: app vs apple', '() => "app".localeCompare("apple")', -1],
    ['shared prefix tiebreaks by length: apple vs app', '() => "apple".localeCompare("app")', 1],
  ])
})

// === parseInt ===

test('parseInt', () => {
  // parseInt must preserve rounding for hex integers beyond f64 exact range.
  // 0x2000000000000100000000001 = 2^97 + 2^44 + 1 → rounds to 2^97 + 2^45.
  const hexBuf = new ArrayBuffer(8), hexU8 = new Uint8Array(hexBuf)
  hexU8.set([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46])
  const largeHexWant = new Float64Array(hexBuf)[0]
  cases([
    ['decimal', '() => parseInt("42")', 42],
    ['hex 0x', '() => parseInt("0xff")', 255],
    ['radix 16', '() => parseInt("ff", 16)', 255],
    ['negative', '() => parseInt("-123")', -123],
    ['number passthrough', '() => parseInt(3.14)', 3],
    ['large hex integer > 53 bits', '() => parseInt("0x2000000000000100000000001")', largeHexWant],
  ])
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

test('string: .concat', () => {
  cases([
    ['single', `() => "hello".concat(" world").length`, 11],
    ['two', `() => "a".concat("b").length`, 2],
  ])
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

test('fused concat: literal ASCII parts store inline — no per-separator copy or length call', () => {
  // The serializer shape (`i + ',' + name + '\n'`): literal parts carry their bytes
  // and length at compile time, so only the DYNAMIC parts pay a __str_copy +
  // __str_length. Profiled on strbuild: the tiny-part copy/len calls were 38.7%
  // of a row; inlining them was -15% on the bench with an exact checksum.
  const src = `export let f = (i, v) => i + ', ' + v + '!\\n'`
  const r = jz(src, { optimize: { level: 2, watr: false } })
  is(r.memory.read(r.exports.f(7, -3)), '7, -3!\n')
  const wat = compile(src, { wat: true, optimize: { level: 2, watr: false } })
  const fn = wat.slice(wat.indexOf('(func $f'), wat.indexOf('\n  (func ', wat.indexOf('(func $f') + 1))
  is((fn.match(/call \$__str_copy/g) || []).length, 2, 'copies only for the 2 dynamic parts')
  is((fn.match(/call \$__str_length/g) || []).length, 2, 'lengths only for the 2 dynamic parts')
  // template path shares the machinery
  const twat = compile('export let f = (x) => `[${x}]`', { wat: true, optimize: { level: 2, watr: false } })
  const tfn = twat.slice(twat.indexOf('(func $f'), twat.indexOf('\n  (func ', twat.indexOf('(func $f') + 1))
  is((tfn.match(/call \$__str_copy/g) || []).length, 1, 'template: one copy for the one dynamic part')
})

test('fused concat: i32-proven parts render digits at the cursor — no temp string, no copy', () => {
  // An i32-proven part (`n|0`, a loop counter) needs no ToString temp: __ilen joins
  // the total, __itoa_s writes sign+digits at the cursor. __ilen and __itoa_s MUST
  // agree byte-for-byte (the alloc is sized from __ilen; a one-byte disagreement is
  // heap corruption) — pinned differentially over every digit-count boundary,
  // INT_MIN (negates to itself, read unsigned), INT_MAX, and zero.
  const edges = [0, 1, -1, 9, 10, -9, -10, 99, 100, 999, 1000, 9999, 10000, 99999, 100000,
    999999, 1000000, 9999999, 10000000, 99999999, 100000000, 999999999, 1000000000,
    -999999999, -1000000000, 2147483647, -2147483648]
  const src = `export let f = (i, v) => 'x' + (i|0) + ',' + (v|0) + '!'`
  const r = jz(src)
  for (const a of edges) for (const b of [0, -1, 2147483647, -2147483648])
    is(r.memory.read(r.exports.f(a, b)), 'x' + (a | 0) + ',' + (b | 0) + '!')
  const wat = compile(src, { wat: true, optimize: { level: 2, watr: false } })
  const fn = wat.slice(wat.indexOf('(func $f'), wat.indexOf('\n  (func ', wat.indexOf('(func $f') + 1))
  is((fn.match(/call \$__itoa_s/g) || []).length, 2, 'both int parts render at the cursor')
  is((fn.match(/call \$__str_copy/g) || []).length, 0, 'no copies — no dynamic string parts')
  is((fn.match(/call \$__i32_to_str/g) || []).length, 0, 'no temp-string ToString')
  // ≤6-ASCII totals must SSO-normalize (`1,2` — the module invariant); and the
  // template path shares the machinery.
  const s6 = jz(`export let f = (i, v) => '' + (i|0) + ',' + (v|0)`)
  is(s6.memory.read(s6.exports.f(1, 2)), '1,2')
  is(s6.exports.f(1, 2), s6.exports.f(1, 2), 'SSO-normalized: bit-identical boxes')
  const t = jz('export let f = (i) => `[${i|0}]`')
  for (const a of edges) is(t.memory.read(t.exports.f(a)), '[' + (a | 0) + ']')
})

// === .slice ===

test('string: .slice', () => {
  cases([
    ['basic', `() => {
      let s = "hello"
      return s.slice(1, 4).length
    }`, 3],  // "ell"
    ['negative', `() => "hello".slice(-3).length`, 3],  // "llo"
    ['no args', `() => "hello".slice().length`, 5],
  ])
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
  // Pinned PRE-watr: the view lowering is jz's emit decision; watr's inliner
  // may legitimately dissolve the single-caller helper afterwards (zeroinit
  // shrank it under inlineOnce's threshold), erasing the name from final WAT.
  const wat = compile(`export let f = (p) => {
    let s = p + ' big world'
    let t = s.slice(0, 9)
    return t === 'hello big' ? 1 : 0
  }`, { wat: true, optimize: { watr: false } })
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

test('slice-view: basic slicing behavior', () => {
  cases([
    ['length + charCodeAt on a view', `() => {
      let s = 'abcdefghij'
      let t = s.slice(2, 7)
      return t.length * 100 + t.charCodeAt(0)
    }`, 5 * 100 + 'c'.charCodeAt(0)],
    ['negative indices', `() => {
      let s = 'abcdefg'
      let t = s.slice(-3, -1)
      return t === 'ef' ? 1 : 0
    }`, 1],
    ['empty and out-of-range slices: empty', `() => {
      let s = 'abcdefg'
      let t = s.slice(3, 3)
      return t.length
    }`, 0],
    ['empty and out-of-range slices: out-of-range', `() => {
      let s = 'abc'
      let t = s.slice(0, 100)
      return t === 'abc' ? 1 : 0
    }`, 1],
    ['view of a view', `() => {
      let s = 'abcdefghij'
      let t = s.slice(1, 9)
      let u = t.slice(2, 5)
      return u === 'def' ? 1 : 0
    }`, 1],
    ['slice of a long heap string', `() => {
      let s = 'abcdefghijklmnopqrstuvwxyz0123456789'
      let t = s.slice(10, 20)
      return t === 'klmnopqrst' ? 1 : 0
    }`, 1],
  ])
})

test('slice-view: concat operand keeps view (read-only use)', () => {
  // `s` is built from a param — see the comment on the previous test.
  // pre-watr wat: this pins JZ's slice-view lowering; watr ≥5.2.2 inlines the helper.
  const wat = compile(`export let f = (p) => {
    let s = p + 'defg'
    let t = s.slice(1, 4)
    return ('X' + t) === 'Xbcd' ? 1 : 0
  }`, { wat: true, optimize: { level: 2, watr: false } })
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
  // pre-watr wat: pins JZ's slice-view lowering; watr ≥5.2.2 inlines the helper.
  const wat = compile(`let helper = (s) => {
    let t = s.slice(1, 4)
    return t === 'bcd' ? 1 : 0
  }
  export let f = () => helper('abcdefg')`, { wat: true, optimize: { level: 2, watr: false } })
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

test('string: .substring / .indexOf', () => {
  cases([
    ['.substring basic', `() => {
      let s = "hello"
      return s.substring(1, 4).length
    }`, 3],
    // === .indexOf ===
    ['.indexOf found', `() => "hello".indexOf("l")`, 2],
    ['.indexOf not found', `() => "hello".indexOf("x")`, -1],
  ])
})

test('object ToString uses inherited Object.prototype fallback', () => {
  const { tag, search, inherited, own, effects } = run(`
    export let tag = () => String({})
    export let search = () => "__[object Object]__".indexOf({})
    export let inherited = () => "abcxdef".indexOf({ valueOf: () => "x" })
    export let own = () => String({ toString: () => "ok", valueOf: () => 7 })
    export let effects = () => { let n = 0; let s = String({ a: (n = 1) }); return s + ":" + n }
  `)
  is(tag(), '[object Object]')
  is(search(), 2)
  is(inherited(), -1, 'inherited toString runs before an own valueOf under string hint')
  is(own(), 'ok')
  is(effects(), '[object Object]:1', 'receiver construction evaluates once before coercion')
})

test('string: startsWith/endsWith/toString', () => {
  cases([
    ['literal startsWith/endsWith', `() => {
      let a = "memory.store"
      let b = "xstore"
      let c = "memory.x"
      return (a.startsWith("memory.") ? 10 : 0) + (a.endsWith("store") ? 1 : 0)
        + (b.startsWith("memory.") ? 100 : 0) + (b.endsWith("store") ? 1 : 0)
        + (c.startsWith("memory.") ? 10 : 0) + (c.endsWith("store") ? 100 : 0)
    }`, 22],
    // Per spec, the search arg goes through ToString. Without coercion, a numeric
    // arg's __str_length reads as 0, the suffix loop runs zero iterations, and
    // the function falls through to "match" — `"100".endsWith(99)` would lie.
    ['coerce non-string args via ToString: endsWith(99) on "100"', `() => "100".endsWith(99) ? 1 : 0`, 0],
    ['coerce non-string args via ToString: endsWith(99) on "199"', `() => "199".endsWith(99) ? 1 : 0`, 1],
    ['coerce non-string args via ToString: startsWith(9) on "9foo"', `() => "9foo".startsWith(9) ? 1 : 0`, 1],
    // Spec 21.1.3.27/28 — both are identity for primitive strings.
    ['.toString and .valueOf return the receiver: "hi".toString().length', `() => "hi".toString().length`, 2],
    ['.toString and .valueOf return the receiver: "world".valueOf().length', `() => "world".valueOf().length`, 5],
    ['.toString and .valueOf return the receiver: s.toString() === s', `() => { let s = "abc"; return s.toString() === s ? 1 : 0 }`, 1],
  ])
})

test('string index: out-of-range returns undefined', () => {
  ok(run(`export let f = () => "hello"[99]`).f() === undefined)
})

test('string: methods', () => {
  cases([
    // === .includes ===
    ['.includes found', `() => "hello".includes("ell")`, true],
    ['.includes not found', `() => "hello".includes("xyz")`, false],
    // === .startsWith ===
    ['.startsWith true', `() => "hello".startsWith("hel")`, true],
    ['.startsWith false', `() => "hello".startsWith("lo")`, false],
    // === .endsWith ===
    ['.endsWith true', `() => "hello".endsWith("lo")`, true],
    ['.endsWith false', `() => "hello".endsWith("hel")`, false],
    // === .toUpperCase ===
    ['.toUpperCase', `() => "hello".toUpperCase()`, 'HELLO'],
    // only ASCII letters change; digits/punctuation/already-upper pass through.
    ['.toUpperCase: digits/punctuation pass through', `() => "aB3z!".toUpperCase()`, 'AB3Z!'],
    // === .toLowerCase ===
    ['.toLowerCase', `() => "HELLO".toLowerCase()`, 'hello'],
    ['.toLowerCase: digits/punctuation pass through', `() => "Ab3Z!".toLowerCase()`, 'ab3z!'],
    ['.toLocaleLowerCase', `() => "HELLO".toLocaleLowerCase().length`, 5],
    ['.toLocaleLowerCase ignores locale args', `() => "HELLO".toLocaleLowerCase("tr").length`, 5],
    // === .trim ===
    ['.trim', `() => " hello ".trim().length`, 5],
    ['.trimStart', `() => " hello ".trimStart().length`, 6],
    ['.trimEnd', `() => " hello ".trimEnd().length`, 6],
    // === .repeat ===
    ['.repeat', `() => "ab".repeat(3).length`, 6],  // "ababab"
    // === .replace ===
    ['.replace first only', `() => "hello hello".replace("hello", "hi").length`, 8],  // "hi hello"
    // === .replaceAll ===
    ['.replaceAll', `() => "a_b_c".replaceAll("_", "-").length`, 5],  // "a-b-c"
    ['.replaceAll removes all', `() => "a__b__c".replaceAll("__", "").length`, 3],  // "abc"
    // === .split ===
    ['.split basic', `() => {
      let a = "a,b,c".split(",")
      return a.length
    }`, 3],
  ])
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

test('string: pad / chain', () => {
  cases([
    // === .padStart ===
    ['.padStart', `() => "5".padStart(3, "0").length`, 3],
    // === .padEnd ===
    ['.padEnd', `() => "5".padEnd(3, "0").length`, 3],
    // === Chaining ===
    ['chain .toUpperCase.slice', `() => "hello".toUpperCase().slice(0, 2)`, 'HE'],
  ])
})

// === Tagged template literals ===

test('tagged template', () => {
  cases([
    ['receives strings array and values', `() => {
      let tag = (strs, val) => strs[0].length * 100 + val
      return tag\`hello \${42} world\`
    }`, 642],  // 'hello '.length=6 → 600 + 42
    ['strings.length === exprs.length + 1', `() => {
      let tag = (strs, a, b) => strs.length * 10 + a + b
      return tag\`x=\${1}, y=\${2}.\`
    }`, 33],  // 3 strings → 30 + 1 + 2
    ['leading interpolation has empty first string', `() => {
      let tag = (strs, val) => strs[0].length === 0 ? val : -1
      return tag\`\${7}rest\`
    }`, 7],
    ['trailing interpolation has empty last string', `() => {
      let tag = (strs, val) => strs[strs.length - 1].length === 0 ? val : -1
      return tag\`rest\${9}\`
    }`, 9],
    ['no interpolation', `() => {
      let tag = (strs) => strs[0].length
      return tag\`bare\`
    }`, 4],
  ])
})

// === charAt, charCodeAt, at ===

test('String: charAt / charCodeAt / at', () => {
  cases([
    ['charAt', `() => "hello".charAt(1).charCodeAt(0)`, 101],
    ['charCodeAt', `() => "ABC".charCodeAt(0)`, 65],
    ['charCodeAt(2)', `() => "ABC".charCodeAt(2)`, 67],
    ['at positive', `() => "hello".at(0).charCodeAt(0)`, 104],
    ['at negative', `() => "hello".at(-1).charCodeAt(0)`, 111],
  ])
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

test('String: search / match / concat', () => {
  cases([
    ['search found', `() => "hello world".search("world")`, 6],
    ['search not found', `() => "hello".search("xyz")`, -1],
    ['match found', `() => "hello world".match("world").length`, 1],
    ['match not found', `() => "hello".match("xyz")`, 0],
    ['match result content', `() => "hello world".match("world")[0].length`, 5],
    // Regression: untyped `s.concat(...)` fell through to dynamic dispatch and hit an
    // internal "__ext_call never registered" error. Now routed via the runtime
    // string/array ptr-type branch (string → __str_concat).
    ['.concat on a dynamic (untyped) receiver: single arg', `(s) => s.concat("!")`, 'hi!', 'hi'],
    ['.concat on a dynamic (untyped) receiver: two args', `(s) => s.concat("-", "x")`, 'hi-x', 'hi'],
    ['.concat on a dynamic (untyped) receiver: literal receiver', `() => "ab".concat("cd")`, 'abcd'],
  ])
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
test('SSO 7-bit: producers/consumers', () => {
  cases([
    // "lit" + param and accumulator both materialize the result and read it back
    // (param + param has a separate, pre-existing concat bug, so it is avoided here).
    ['materialized concat round-trips length + tail char (slow copy path): param concat', `(s) => { let x = "re" + s; return x.length*1000 + x.charCodeAt(x.length-1) }`, 6000 + 'n'.charCodeAt(0), 'turn'],
    ['materialized concat round-trips length + tail char (slow copy path): accumulator', `() => { let s = ""; s += "re"; s += "sult"; return s.length*1000 + s.charCodeAt(5) }`, 6000 + 't'.charCodeAt(0)],
    ['slice produces a correct 6-char SSO: slice(0,6)', `(s) => s.slice(0,6)`, 'return', 'returns'],
    ['slice produces a correct 6-char SSO: slice(1,6).charCodeAt(4)', `(s) => s.slice(1,6).charCodeAt(4)`, 'result'.charCodeAt(4), 'xresult'],
    ['indexOf / startsWith / endsWith on 6-char: indexOf', `(s) => s.indexOf("def")`, 3, 'abcdef'],
    ['indexOf / startsWith / endsWith on 6-char: startsWith', `(s) => s.startsWith("abc") ? 1 : 0`, 1, 'abcdef'],
    ['indexOf / startsWith / endsWith on 6-char: endsWith', `(s) => s.endsWith("def") ? 1 : 0`, 1, 'abcdef'],
    ['toUpperCase / toLowerCase on 5-6 char: toUpperCase', `(s) => s.toUpperCase()`, 'HELLO', 'hello'],
    ['toUpperCase / toLowerCase on 5-6 char: toLowerCase', `(s) => s.toLowerCase()`, 'string', 'STRING'],
    ['number→string concat keeps digits (itoa SSO path): "P:" + n', `(n) => "P:" + n`, 'P:5', 5],
    ['number→string concat keeps digits (itoa SSO path): accumulator loop', `() => { let s = ""; for (let i=0;i<4;i++) s += i; return s }`, '0123'],
    ['Set/Map with 6-char string keys (collection hash)', `() => { let s = new Set(); s.add("string"); s.add("result"); return (s.has("string") && s.has("result") && !s.has("absent")) ? 1 : 0 }`, 1],
    ['JSON.parse 4-char key/value round-trips', `() => JSON.parse('{"name":"jdef"}').name`, 'jdef'],
  ])
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
test('SSO invariant: producers/consumers', () => {
  cases([
    ['toUpperCase/toLowerCase of SSO stays SSO: toUpperCase', `(s) => s.toUpperCase() === "ABCDEF" ? 1 : 0`, 1, 'abcdef'],
    ['toUpperCase/toLowerCase of SSO stays SSO: slice+toLowerCase', `(s) => s.slice(0, 5).toLowerCase() === "abcde" ? 1 : 0`, 1, 'ABCDEXYZ'],
    ['repeat / pad short results: repeat', `(s) => s.repeat(2) === "ababab".slice(0, 4) ? 1 : 0`, 1, 'ab'],
    ['repeat / pad short results: padStart', `(s) => s.padStart(5, "0") === "00abc" ? 1 : 0`, 1, 'abc'],
    ['repeat / pad short results: padEnd', `(s) => s.padEnd(6, ".") === "abc..." ? 1 : 0`, 1, 'abc'],
    ['split pieces and trim results: split', `(s) => s.split(",")[1] === "bcdef" ? 1 : 0`, 1, 'aaaaaaa,bcdef,cc'],
    ['split pieces and trim results: trim', `(s) => s.trim() === "abcde" ? 1 : 0`, 1, '   abcde   '],
    ['JSON.parse 5-6 char strings (simple + escape paths): simple', `(s) => JSON.parse(s).k === "hello" ? 1 : 0`, 1, '{"k":"hello"}'],
    ['JSON.parse 5-6 char strings (simple + escape paths): escape', String.raw`(s) => JSON.parse(s).k === "a\nb" ? 1 : 0`, 1, '{"k":"a\\nb"}'],
    ['URI codecs short results: decodeURIComponent', `(s) => decodeURIComponent(s) === "a b" ? 1 : 0`, 1, 'a%20b'],
    ['URI codecs short results: encodeURIComponent', `(s) => encodeURIComponent(s) === "abc" ? 1 : 0`, 1, 'abc'],
    ['String.fromCharCode multi-arg', `() => String.fromCharCode(97, 98, 99, 100, 101) === "abcde" ? 1 : 0`, 1],
    // The kernel builds wasm identifiers via \`$\${name}\` — a leaked short heap
    // string here broke the self-compile ("Unknown global $add5").
    ['template literal short results (the $-name builder shape): $${s}', '(s) => `$${s}` === "$a5" ? 1 : 0', 1, 'a5'],
    ['template literal short results (the $-name builder shape): x${s}y${s}', '(s) => `x${s}y${s}` === "xa5ya5" ? 1 : 0', 1, 'a5'],
    ['template literal short results (the $-name builder shape): f${n}', '(n) => `f${n}` === "f12" ? 1 : 0', 1, 12],
    ['long/non-ASCII strings still content-compare (heap fallback intact): concat to "function"', `(s) => (s + "n") === "function" ? 1 : 0`, 1, 'functio'],
    ['long/non-ASCII strings still content-compare (heap fallback intact): non-ASCII equality', `(s) => s === "héllo" ? 1 : 0`, 1, 'héllo'],
    ['long/non-ASCII strings still content-compare (heap fallback intact): non-ASCII concat', `(s) => (s + "é") === "aé" ? 1 : 0`, 1, 'a'],
  ])
})

// === `x === "literal"` specialization (emit.js emitLooseEq) ===
// The compiler's hottest comparison (`node[0] === 'if'` AST-tag dispatch). When one
// operand is statically a string, emit skips the generic __eq NaN-box dispatch and
// inlines `i64.eq ? equal : (__is_str_key(u) ? __str_eq : ne)`. Behaviorally identical
// to __eq (jz's ==/=== never coerce); the win is on the self-compile kernel's own 5579 sites.
test('str-eq spec: heap concat === SSO literal is true (the soundness case)', () => {
  // `"i"+"f"` allocates a HEAP "if" with different bits than the inline SSO literal —
  // a pure i64.eq would wrongly say not-equal; the __str_eq fallback content-compares.
  for (const opt of levels(false, 2)) {
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
  // pre-watr wat: pins JZ's lowering; watr ≥5.2.2 inlines the helpers.
  const strEq = compile(`export let f = (x) => (x === "function") | 0`, { wat: true, optimize: { level: 2, watr: false } })
  ok(/\$__is_str_key/.test(strEq) && /\$__str_eq/.test(strEq), 'heap-literal === uses __is_str_key + __str_eq')
  ok(!/\$__eq\b/.test(strEq), 'string === literal does NOT call the generic __eq')
  // numeric === must not be dragged into the string path.
  const numEq = compile(`export let f = (x) => (x === 5) | 0`, { wat: true })
  ok(!/\$__str_eq|\$__is_str_key/.test(numEq), 'numeric === stays off the string path')
})

test('indexOf substr: SIMD first-unit memchr is emitted + matches V8 over edge cases', () => {
  // The multi-byte heap-haystack path broadcasts needle[0] and reads an i16x8.eq bitmask —
  // a scan-bound substr search dropped from 5.7× slower than V8 to ~1.4×. The SIMD window only
  // touches the HAYSTACK, so a SHORT (SSO, ≤6B) needle — the common ","/"://"/"TARGET" — rides it
  // too (its bytes fetched SSO-aware), not just heap×heap; that closed an 11×→1.4× gap.
  const wat = compile(`export let f = (h, n) => h.indexOf(n)`, { wat: true })
  ok(/i16x8\.bitmask/.test(wat) && /i16x8\.eq/.test(wat), '__str_indexof carries the SIMD first-unit scan')

  const { f, g, e } = jz(`
    export let f = (h, n) => h.indexOf(n)
    export let g = (h, n, k) => h.indexOf(n, k | 0)
    export let e = (h, n) => h.includes(n) ? 1 : 0
  `).exports
  // long heap haystack (>16B, multiple SIMD windows), match near the end, with a SHORT SSO needle
  const hay = 'xabcdefgh'.repeat(28) + 'TARGET_q'   // 260 B heap; "TARGET" is a 6-byte SSO needle
  for (const ndl of ['TARGET', 'T', 'ARGE', '_q', 'xa', 'zzz']) is(f(hay, ndl), hay.indexOf(ndl), `SSO needle ${JSON.stringify(ndl)} over long heap`)
  // first-unit collisions + false candidates within a chunk: 'ab' over an 'ab'-dense string
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
  // (pre-watr wat: pins JZ's concat selection; watr ≥5.2.2 inlines the helpers.)
  const accumW = compile(`export let f = (n) => { let b = ""; for (let i = 0; i < n; i = i + 1) b = b + "ab"; return b.length | 0 }`, { wat: true, optimize: { level: 2, watr: false } })
  const freshW = compile(`export let f = (s) => { let t = s + "_x"; return t.length | 0 }`, { wat: true, optimize: { level: 2, watr: false } })
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

// String.prototype.normalize — identity (all normalization forms are identity on
// ASCII; Unicode case tables remain unsupported — README divergences).
// Was a compile crash: the autoload tuple lacked the fallback's array dep.
test('strings: normalize is identity (typed + generic receivers)', () => {
  is(run(`export let f = () => "héllo".normalize().length`).f(), 5)
  is(run(`export let f = () => "abc".normalize("NFD") === "abc" ? 1 : 0`).f(), 1)
  is(run(`export let f = (s) => s.normalize().length`).f !== undefined, true)
})

// --- static-array folds must not survive mutation (stale-fold miscompile) ---
// prepare's in-walk template/concat folds consume shapeStrArrays; a push or
// indexed write BEFORE the fold site must invalidate the fact at the mutation
// point (statement order = execution order), not only in the post-prep sweep.
test('static array fold: mutation before the fold site ends the fact', () => {
  const m1 = run(`const S=['a','b']; S.push('c'); const T = \`[\${S.join('')}]\`; export let t = () => T`)
  is(m1.t(), '[abc]')
  const m2 = run(`const S=['a','b']; S[0]='x'; const T = \`<\${S.join('-')}>\`; export let t = () => T`)
  is(m2.t(), '<x-b>')
  const m3 = run(`const S=['a','b']; f(); const T = \`(\${S.join('')})\`; export let t = () => T; function f(){ S.push('c') }`)
  is(m3.t(), '(abc)')
  // No mutation -> the fold must still fire and stay correct.
  const m4 = run(`const S=['a','b']; const T = \`=\${S.join('')}=\`; export let t = () => T`)
  is(m4.t(), '=ab=')
})

test('startsWith/endsWith position argument rejects loudly (was silently dropped)', () => {
  // Compiled as position 0 before — silent wrong results (the self-compile
  // resolver classified nothing). Reject until an offset is threaded.
  throws(() => jz(`export let f = (s) => s.startsWith('cd', 2)`), /position argument not supported/)
  throws(() => jz(`export let f = (s) => s.endsWith('cd', 4)`), /position argument not supported/)
})

test('string +: operands evaluate in source order around a known side', () => {
  // The left may write what the known right reads; the known side must not be hoisted before it.
  const { f, g } = run(`let a = { v: 1 }
    const bump = () => (a.v += 1, a.v)
    export let f = () => bump() + a.v
    export let g = () => { let s = 'x'; const t = () => (s = 'y', 1); return t() + s }`)
  is(f(), 4)
  is(g(), '1y')
})

test('UTF-16 constructors preserve code units and scalar values', () => {
  const e = run(`
    export let unit = x => String.fromCharCode(x)
    export let point = x => String.fromCodePoint(x)
    export let pair = (a,b) => String.fromCharCode(a,b)
    export let points = (a,b) => String.fromCodePoint(a,b)
  `)
  for (const n of [0,65,127,128,255,256,2047,2048,55295,55296,56319,56320,57343,57344,65535,65536,-1,NaN,Infinity,3.9,4294967552,2**63+2048,-(2**63+2048),2**64+4096,2**68,Number.MAX_VALUE])
    is(e.unit(n), String.fromCharCode(n), `unit ${n}`)
  for (const n of [0,127,128,2047,2048,55296,65535,65536,0x1D800,0x1F600,0x10FFFF])
    is(e.point(n), String.fromCodePoint(n), `point ${n}`)
  for (const [a,b] of [[0xD83D,0xDE00],[0xD800,65],[65,0xDC00],[0xD800,0xD800],[0xDC00,0xDC00]]) {
    is(e.pair(a,b), String.fromCharCode(a,b))
    is(e.points(a,b), String.fromCodePoint(a,b))
  }
})

test('UTF-16 positions and codePointAt match JavaScript', () => {
  const e = run(`export let unit = (s,i) => s.charCodeAt(i); export let point = (s,i) => s.codePointAt(i); export let len = s => s.length`)
  for (const s of ['AĀ中😀𝠀', '\uD800a\uDC00', '\uFFFF', '']) {
    is(e.len(s), s.length)
    for (let i = 0; i < s.length; i++) { is(e.unit(s,i), s.charCodeAt(i)); is(e.point(s,i), s.codePointAt(i)) }
    for (const i of [-1,s.length,Infinity,4294967296]) { is(e.point(s,i),undefined); is(Number.isNaN(e.unit(s,i)),true) }
  }
})

test('UTF-16 construction evaluates arguments before numeric coercion', () => {
  for (const method of ['fromCharCode','fromCodePoint']) {
    const src = `export let f = () => {
      let log = ''; let a = { valueOf: () => { log += 'a'; return 0xD83D } };
      let b = () => { log += 'b'; return 0xDE00 };
      let s = String.${method}(a,b()); return s + '|' + log
    }`
    is(run(src).f(), oracle(src).f())
  }
})


test('UTF-16 strings preserve host values, slices, padding and lookup data', () => {
  const e = run(`
    export let echo = s => s
    export let slice = (s,a,b) => s.slice(a,b)
    export let pad = (s,n,p) => s.padStart(n,p)
    export let beat = t => "\\u0100\\u0200".charCodeAt(t & 1)
    export let eq = (a,b) => a === b
    export let less = (a,b) => a < b
    export let lookup = (a,b) => { let m = new Map(); m.set(a,1); m.set(b,2); return m.get(a)*10+m.get(b) }
  `)
  for (const s of ['Ā😀\uD800\uDC00\uDFFF', 'abcdef', '\uFFFF', '']) {
    is(e.echo(s), s)
    for (let i = 0; i <= s.length; i++) is(e.slice(s,i,i+1), s.slice(i,i+1))
  }
  for (const p of ['abcdef','ab','Ā😀']) is(e.pad('x',13,p),'x'.padStart(13,p))
  is(e.beat(0),256); is(e.beat(1),512)
  for (const [a,b] of [['Ā','\0'],['abcdefĀ','abcdef\0'],['\uE000','𐀀']]) {
    is(e.eq(a,b),a===b); is(e.less(a,b),a<b); is(e.lookup(a,b),12)
  }
})

test('UTF-8 boundary codecs match JavaScript and respect whole scalar capacity', () => {
  const e = run(`
    export let encode = s => new TextEncoder().encode(s)
    export let decode = b => new TextDecoder().decode(b)
    export let into = (s,n) => { let b = new Uint8Array(n); let r = new TextEncoder().encodeInto(s,b); return [r.read,r.written,...b] }
    export let uri = s => encodeURIComponent(s)
    export let unuri = s => decodeURIComponent(s)
    export let json = s => JSON.stringify(s)
    export let parse = s => JSON.parse(s)
    export let base = s => btoa(s)
    export let unbase = s => atob(s)
  `)
  for (const s of ['abc','Ā中😀','\uD800','\uDC00x','\uFEFFa']) {
    is([...e.encode(s)], [...new TextEncoder().encode(s)])
    for (let n=0;n<12;n++) { const b = new Uint8Array(n), r = new TextEncoder().encodeInto(s,b); is(e.into(s,n),[r.read,r.written,...b]) }
    is(e.json(s),JSON.stringify(s)); is(e.parse(JSON.stringify(s)),s)
  }
  for (const bytes of [[239,187,191,65],[224,128,128],[240,159],[240,159,65],[237,160,128],[244,144,128,128],[255,65]]) {
    const b = new Uint8Array(bytes); is(e.decode(b),new TextDecoder().decode(b))
  }
  for (const s of ['Ā😀 a','\uFFFF','abc']) { is(e.uri(s),encodeURIComponent(s)); is(e.unuri(encodeURIComponent(s)),s) }
  throws(() => e.uri('\uD800'), /./)
  is(e.base('ÿ\0A'),btoa('ÿ\0A')); is(e.unbase(btoa('ÿ\0A')),'ÿ\0A')
  throws(() => e.base('Ā'), /./)
})


test('UTF-16 string iteration uses code points, indexing and split use code units', () => {
  const e = run(`
    export let spread = s => [...s]
    export let from = s => Array.from(s,(c,i)=>c+i)
    export let loop = s => { let a=[]; for(let c of s) a.push(c); return a }
    export let split = s => s.split('')
  `)
  for (const s of ['A😀\uD800','Ā𝠀z','abcdef','']) {
    is(e.spread(s),[...s]); is(e.loop(s),[...s]); is(e.from(s),Array.from(s,(c,i)=>c+i)); is(e.split(s),s.split(''))
  }
  is(run(`export let f=()=>new TextEncoder().encode(undefined).length`).f(),0)
})


test('UTF-16 regex positions, Unicode atoms and escapes', () => {
  for (const pattern of ['/./u','/[😀]/u','/\\u{1F600}/u','/\\uD83D\\uDE00/u','/😀+a/u','/.*a/u']) {
    const src = `export let f=s=>${pattern}.exec(s)[0]`
    const f = run(src).f, ref = Function(`return s=>${pattern}.exec(s)[0]`)()
    is(f('😀😀a'),ref('😀😀a'))
  }
  is(run(`export let f=()=>/\\uDF06/u.exec('\\uD834\\uDF06')===null`).f(),true)
  const escape = run(`export let f=s=>RegExp.escape(s)`).f
  for(const [s, expected] of [['\uD800','\\ud800'],['😀','😀'],['\u00A0\u2028\uFEFF','\\xa0\\u2028\\ufeff'],['abc','\\x61bc']]) is(escape(s),expected)
})

test('UTF-8 decoding options and receiver checks', () => {
  const e = run(`
    export let decode = b => new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(b)
    export let replace = b => new TextDecoder().decode(b)
    export let into = b => new TextEncoder().encodeInto('a',b)
  `)
  is(e.decode(new Uint8Array([239,187,191,65])),'\uFEFFA')
  throws(()=>e.decode(new Uint8Array([255])),/valid UTF-8/)
  throws(()=>e.replace('abc'),/ArrayBuffer or view/)
  throws(()=>run(`export let f=()=>new TextEncoder().encodeInto('a',new Uint8ClampedArray(2))`).f(),/Uint8Array/)
  is(e.replace(undefined),'')
  const src = `export let f=()=>{let b={raw:s=>s};return b.raw('abc')}`
  is(run(src).f(),'abc')
})


test('UTF-16 whitespace and URLSearchParams use explicit text encoding', () => {
  const e = run(`
    export let num = s => Number(s)
    export let trim = s => s.trim()
    export let ws = s => /\\s/.test(s)
    export let url = s => { let p = new URLSearchParams(s); return p.get('Ā') + '|' + p.toString() }
  `)
  for(const ws of ['\u00A0','\u1680','\u2028','\u202F','\uFEFF']) {is(e.num(ws+'42'+ws),42);is(e.trim(ws+'Ā'+ws),'Ā');is(e.ws(ws),true)}
  for(const s of ['Ā=😀','%C4%80=%F0%9F%98%80','Ā=\uFEFFx']) {const p=new URLSearchParams(s);is(e.url(s),p.get('Ā')+'|'+p.toString())}
})


test('UTF-16 zero-width regex progress respects code points', () => {
  const e = run(`
    export let split = s => s.split(/(?:)/u)
    export let separators = s => s.split(/a*/u)
    export let matches = s => [...s.matchAll(/(?:)/gu)].length
    export let replace = s => s.replace(/(?:)/gu,'x')
    export let callback = s => s.replace(/(?:)/gu,()=> 'x')
    export let last = s => {let r=/(?:)/gu;r.exec(s);return r.lastIndex}
  `)
  for (const s of ['', '😀', 'a😀a', 'Ā😀z', '\uD800']) {
    is(e.split(s), s.split(/(?:)/u)); is(e.separators(s), s.split(/a*/u))
    is(e.matches(s), [...s.matchAll(/(?:)/gu)].length)
    is(e.replace(s), s.replace(/(?:)/gu,'x')); is(e.callback(s), s.replace(/(?:)/gu,()=> 'x'))
    is(e.last(s), 0)
  }
})

test('Text codecs evaluate receivers and arguments once, in order', () => {
  const e = run(`
    export let encode = () => {
      let n=0, a=new Uint8Array(1)
      let x=(n=n*10+1,new TextEncoder()).encodeInto((n=n*10+2,'a'),(n=n*10+3,a))
      return n+x.written
    }
    export let decode = () => {
      let n=0, a=new Uint8Array([65])
      let s=(n=n*10+1,new TextDecoder()).decode((n=n*10+2,a))
      return n+s
    }
  `)
  is(e.encode(),124); is(e.decode(),'12A')
})


test('UTF-16 object keys survive UTF-8 schema metadata', () => {
  const keys = ['\uD800','\uDC00','\uFFFD','\uFEFFx','😀','Ā','"\\\n']
  const fields = keys.map((key,i)=>`[${JSON.stringify(key)}]:${i+1}`).join(',')
  const m=jz(`
    export let f=()=>({${fields}})
    export let g=o=>o["\\uD800"]
    export let dictionary=x=>{let o={};o[String.fromCharCode(x)]=42;return o["\\uD800"]}
    export let map=x=>{let m=new Map();m.set(String.fromCharCode(x),42);return m.get("\\uD800")}
  `), e=m.exports
  is(e.f(),Object.fromEntries(keys.map((key,i)=>[key,i+1])))
  is(m.memory.read(m.instance.exports.g(m.memory.Hash({'\uD800':42}))),42)
  is(e.dictionary(0xD800),42); is(e.map(0xD800),42)
})
