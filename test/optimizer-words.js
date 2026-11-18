// Integers kept as words: ToInt32 and division lowering, the integer narrowing and
// its range facts, conversions the peephole folds, charCodeAt and single-character
// reads, and the intervals wordRanges computes.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { onKernel, levels, belowOpt, ownedLevels } from './_matrix.js'
import { optimizeFunc } from '../src/optimize/index.js'
import { lowerToInt32Tails } from '../src/optimize/peephole.js'
import parseWat from 'watr/parse'
import encodeWat from 'watr/compile'
import { peelNarrowConv } from '../src/optimize/vectorize/lift.js'
import { wordRanges, loopTrips } from '../src/optimize/word-ranges.js'
import { foldWords, funcWat, run, oracle, jz, compile } from './util.js'
import { parse, loopCount, count, walk } from '../scripts/wat-probe.mjs'
import { findFunc, exactToInt32 } from './_optimizer.js'
import { narrowFlagLocals } from '../src/optimize/int-narrow.js'

test('SIMD store conversion peeling requires matching guards and both value arms', () => {
  const get = name => ['local.get', name], x = get('$x'), y = get('$y')
  const wrap = v => ['i32.wrap_i64', ['i64.trunc_sat_f64_s', v]]
  const guarded = (limit, hit, miss) => ['if', ['result', 'i32'],
    ['f64.lt', ['f64.abs', x], ['f64.const', limit]], ['then', hit], ['else', ['call', '$__to_int32', miss]]]
  is(peelNarrowConv(guarded(2 ** 63, wrap(x), x), 'i32'), x)
  const inverse = guarded(2 ** 63, wrap(x), x)
  inverse[2][0] = 'f64.ge'
  ;[inverse[3][1], inverse[4][1]] = [inverse[4][1], inverse[3][1]]
  is(peelNarrowConv(inverse, 'i32'), x, 'the slow-first guard is the same conversion')
  for (const val of [guarded(2 ** 63, ['i32.const', 7], x), guarded(2 ** 64, wrap(x), x),
    guarded(2 ** 63, wrap(y), x), guarded(2 ** 63, wrap(x), y),
    ['select', wrap(x), ['i32.const', 0], ['f64.ne', y, ['f64.const', Infinity]]]])
    is(peelNarrowConv(val, 'i32'), null, 'a different guard or value is not a conversion')
  const captured = guarded(2 ** 63, wrap(get('$t')), get('$t'))
  captured[2][1][1] = ['local.tee', '$t', ['f64.add', x, ['f64.const', 0.5]]]
  is(peelNarrowConv(captured, 'i32'), captured[2][1][1][2], 'the capture executes once')
})

test('late integer conversion preserves parameters whose names match its temporaries', () => {
  const ir = parseWat(`(module
    (import "env" "convert" (func $__to_int32 (param f64) (result i32)))
    (func $f (export "f") (param $__ti0 f64) (result i32)
      (i32.add
        (call $__to_int32 (f64.add (local.get $__ti0) (f64.const 0.5)))
        (i32.trunc_sat_f64_s (local.get $__ti0)))))`)
  const imports = { env: { convert: n => n | 0 } }
  const before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir)), imports).exports.f
  lowerToInt32Tails(ir[2])
  const once = encodeWat(ir)
  lowerToInt32Tails(ir[2])
  is(encodeWat(ir), once, 'lowering twice adds no guards or locals')
  const after = new WebAssembly.Instance(new WebAssembly.Module(once), imports).exports.f
  for (const n of [0, 1, 1, -7, 1, 127.5, -(2 ** 31), 2 ** 31, 2 ** 32,
    -(2 ** 63), 2 ** 63, 1e30, NaN, Infinity, -Infinity]) is(after(n), before(n), `n=${n}`)
})

test('trunc-range fold: a WRITTEN param must not resolve to its later write (ToUint32(Infinity) = 0)', () => {
  // The single-textual-def map behind the bare-trunc_sat range fold saw `p0 = 0` and
  // resolved p0 -> [0,0] at a USE BEFORE the write — but a param's entry value is the
  // caller's: `1 >>> Math.abs(-Infinity)` must shift by ToUint32(Inf) = 0, not by a
  // saturated 31.
  const s1 = `export let f = (p0, p1, p2) => { p1 = (1 >>> Math.abs(p0)); p0 = 0; return p1; }`
  const s2 = `export let f = (p0, p1, p2) => { let v0 = p0; let i4 = 0; while (i4 < 14) { p2 = 0; p0 = 0; i4 = (i4 + 1); } return (1 >> Math.abs(v0)); }`
  for (const o of ownedLevels(1, 2, 'speed')) {
    is(run(s1, { optimize: o }).f(-Infinity, 0.5, 3520.439785003662), 1, `s1 opt=${o}`)
    is(run(s2, { optimize: o }).f(-Infinity, 0.5, 3520.439785003662), 1, `s2 opt=${o}`)
    is(run(s1, { optimize: o }).f(NaN, 0, 0), 1, `s1 NaN opt=${o}`)
    is(run(s1, { optimize: o }).f(33, 0, 0), 0, `s1 in-range opt=${o}`)
  }
})

test('known numeric coercions elide __to_num', () => {
  const wat = compile(`
    export const main = (buf) => {
      const a = new Float64Array(buf)
      return Number(a[0]) + +(a[1] + 1) + isNaN(a[2]) + isFinite(a[3])
    }
  `, { wat: true })
  const calls = (wat.match(/\(call \$__to_num/g) || []).length
  is(calls, 0)
})

test('cross-call param narrowing: local typed-array elem arg narrows callee param to i32', () => {
  // nqueens shape: a helper called only with elements of a LOCAL typed array
  // (`const sizes = new Int32Array(…)`). exprType's arg-type query must see the
  // caller's local typed arrays (not just module globals / typed PARAMS), else
  // the param stays f64, `1 << n` coerces via __to_num, and that single call
  // transitively links the ENTIRE string↔number stdlib (__ftoa/__dec_to_f64/…) —
  // ~8 KB of otherwise-dead code.
  const wat = compile(`
    const countN = (n) => (1 << n) - 1
    export const main = () => {
      const sizes = new Int32Array(20)
      for (let q = 0; q < 20; q++) sizes[q] = q + 8
      let t = 0
      for (let q = 0; q < 20; q++) t = t + countN(sizes[q])
      return t | 0
    }
  `, { wat: true, optimize: { level: 'speed' } })
  ok(!/\(func \$__to_num/.test(wat), 'no __to_num: param narrowed from local typed-array elem arg')
  ok(!/\(func \$__ftoa/.test(wat), 'no __ftoa: float formatter not transitively pulled')
  ok(!/\(func \$__dec_to_f64/.test(wat), 'no __dec_to_f64: Eisel-Lemire EL table not pulled')
})

test('cross-call param narrowing: runtime correctness preserved', () => {
  const { main } = run(`
    const countN = (n) => (1 << n) - 1
    export const main = () => {
      const sizes = new Int32Array(5)
      for (let q = 0; q < 5; q++) sizes[q] = q + 8
      let t = 0
      for (let q = 0; q < 5; q++) t = t + countN(sizes[q])
      return t | 0
    }
  `)
  // sum of (1<<(q+8))-1 for q=0..4 = (255)+(511)+(1023)+(2047)+(4095) = 7931
  is(main(), 7931)
})

test('peephole: i32/f64 signed roundtrips fold post-emit', () => {
  const fn = ['func', '$p',
    ['param', '$x', 'i32'],
    ['result', 'i32'],
    ['i32.trunc_sat_f64_s', ['f64.convert_i32_s', ['local.get', '$x']]]]
  optimizeFunc(fn, { fusedRewrite: true })
  is(JSON.stringify(fn).includes('f64.convert_i32_s'), false)
  is(JSON.stringify(fn).includes('i32.trunc_sat_f64_s'), false)
  is(JSON.stringify(fn.at(-1)), JSON.stringify(['local.get', '$x']))
})

test('peephole: i64/f64/i32 roundtrips fold to direct extension', () => {
  const fn = ['func', '$p',
    ['param', '$x', 'i32'],
    ['result', 'i32'],
    ['i32.wrap_i64', ['i64.trunc_sat_f64_s', ['f64.convert_i32_u', ['local.get', '$x']]]]]
  optimizeFunc(fn, { fusedRewrite: true })
  const s = JSON.stringify(fn)
  is(s.includes('f64.convert_i32_u'), false)
  is(s.includes('i64.trunc_sat_f64_s'), false)
  is(JSON.stringify(fn.at(-1)), JSON.stringify(['local.get', '$x']))
})

test('peephole: i32 constants widen directly to f64 constants', () => {
  const fn = ['func', '$p',
    ['result', 'f64'],
    ['f64.add',
      ['f64.convert_i32_s', ['i32.const', -2]],
      ['f64.convert_i32_u', ['i32.const', '-1']]]]
  optimizeFunc(fn, { fusedRewrite: true })
  const s = JSON.stringify(fn)
  is(s.includes('f64.convert_i32_'), false)
  ok(s.includes('["f64.const",-2]'))
  ok(s.includes('["f64.const",4294967295]'))
})

test('peephole: f64 multiply by two uses addition for cheap operands', () => {
  const fn = ['func', '$p',
    ['param', '$x', 'f64'],
    ['result', 'f64'],
    ['f64.mul', ['f64.const', 2], ['local.get', '$x']]]
  optimizeFunc(fn, { fusedRewrite: true })
  const s = JSON.stringify(fn)
  is(s.includes('f64.mul'), false)
  ok(s.includes('f64.add'))
})

test('unknown coercions still use __to_num', () => {
  const wat = compile(`
    export const main = (x) => Number(x) + +x + isNaN(x) + isFinite(x)
  `, { wat: true })
  ok(/\(call \$__to_num\b/.test(wat))
})

test('typed-array assignment statement does not materialize assigned value', () => {
  const wat = compile(`
    export const main = (x) => {
      const a = new Uint32Array(1)
      a[0] = x | 0
      return 1
    }
  `, { wat: true, optimize: { watr: false } })
  const mainBody = funcWat(wat, 'main')
  ok(/\(i32\.store/.test(mainBody), 'expected typed-array store')
  is(/f64\.convert_i32_[su]/.test(mainBody), false)
  const storeAt = mainBody.indexOf('(i32.store')
  const storePrefix = mainBody.slice(Math.max(0, storeAt - 120), storeAt)
  is(/\(block\s+\(result f64\)/.test(storePrefix), false)
})

test('byte transform `out[i] = table[in[j]]` stores i32 directly — no f64 round-trip', () => {
  // An integer typed-array element READ materializes as `f64.convert_i32_*(load8_u …)`, but when its
  // only consumer is an integer typed-array STORE the value is integer-backed: store the i32 low bits
  // via `store8` and skip the sign-branch + i64-trunc + wrap. General: any `dst[i] = src[j]` of int
  // elements. xform is INTERNAL (its array params are typed Uint8Array via main's `new Uint8Array` call
  // sites) and called twice so it survives as a function to inspect.
  const SRC = `
    const xform = (src, table, out, n) => { for (let i = 0; i < n; i++) out[i] = table[src[i]] }
    export const main = () => {
      const src = new Uint8Array(8), table = new Uint8Array(256), out = new Uint8Array(8)
      for (let i = 0; i < 256; i++) table[i] = (i * 7) & 0xff
      for (let i = 0; i < 8; i++) src[i] = (i * 31) & 0xff
      xform(src, table, out, 8); xform(src, table, out, 8)
      return out[3] | 0
    }
  `
  const wat = compile(SRC, { wat: true })
  // xform inlines into main$exp; the whole user function (transform + fills) is integer-only.
  const body = funcWat(wat, 'main')
  ok(/i32\.store8/.test(body), 'stores the byte directly via i32.store8')
  is(/i64\.trunc_sat|f64\.lt/.test(body), false, 'no f64→i32 trunc / sign-branch in the byte transform')
  is(jz(SRC).exports.main(), ((((3 * 31) & 0xff) * 7) & 0xff), 'byte transform result correct (table[src[3]])')
})

test('integer === integer compares in i32 — no f64.eq widen', () => {
  // `a[i] === b[j]` (two u8 reads) and `intLocal === b[j]` (the levenshtein DP cell) materialize
  // operands as f64 under the universal value model, but the equality must lower to i32.eq, not
  // widen both to f64 and `f64.eq`. Bit-exact.
  const SRC = `
    const eqcount = (a, b, n) => {
      let c = 0
      for (let i = 1; i <= n; i++) { const ai = a[i - 1]; if (ai === b[i - 1]) c++ }   // i32 local vs u8 read (mixed sign)
      for (let i = 0; i < n; i++) if (a[i] === b[i]) c++                                 // u8 read vs u8 read (same sign)
      return c
    }
    export const main = () => {
      const a = new Uint8Array(16), b = new Uint8Array(16)
      for (let i = 0; i < 16; i++) { a[i] = (i * 7) & 7; b[i] = (i * 5) & 7 }
      return eqcount(a, b, 16) + eqcount(b, a, 16)
    }
  `
  // eqcount is called twice with distinct arguments → stays its own function (value numbering
  // computes one call for two identical ones, and watr inlines a function with one caller).
  // (words folded: the guarded ToInt32 of the counter has an `else` of its own)
  const wat = foldWords(compile(SRC, { wat: true }))
  const body = funcWat(wat, 'eqcount')
  // Root F versions the param-bound loops: the cold checked twin legitimately
  // compares f64 (a checked read is number|undefined), and a guard between the
  // loops tests a Number — the pin measures the fast arms: the first loop of
  // each label (its twin, the checked copy, follows under the same label).
  const fastLoops = [], labels = new Set()
  walk(parseWat(body), n => { if (n[0] === 'loop' && !labels.has(n[1])) { labels.add(n[1]); fastLoops.push(n) } })
  ok(fastLoops.length > 0, 'the loops are found')
  is(fastLoops.reduce((k, fast) => k + count(fast, x => x[0] === 'f64.eq' || x[0] === 'f64.ne'), 0), 0, 'no f64 equality — integer operands compare in i32')
  ok(fastLoops.some(fast => count(fast, x => x[0] === 'i32.eq') > 0), 'lowers to i32.eq')
  const ref = (() => { const a = [], b = []; for (let i = 0; i < 16; i++) { a[i] = (i * 7) & 7; b[i] = (i * 5) & 7 }
    let f = (n) => { let c = 0; for (let i = 1; i <= n; i++) if (a[i - 1] === b[i - 1]) c++; for (let i = 0; i < n; i++) if (a[i] === b[i]) c++; return c }; return f(16) + f(16) })()
  is(jz(SRC).exports.main(), ref, 'eqcount result bit-exact vs JS')
})

test('Math.floor(bounded)|0 → one exact word, no +∞ guard', () => {
  // f64Range maps through f64.floor: Math.floor(u8 * scale) is a finite value, so toI32 emits
  // i32.wrap_i64(i64.trunc_sat_f64_s) with no (select … f64.ne ∞) guard. The default tier
  // keeps that i64 form (V8 arm64's fastest; bytebeat 1521 → 1370 µs against the bare
  // i32.trunc_sat this used to pin); the speed tier takes the word of the bounded integer by
  // the add (its 1.5·2^52 sum read as bits), no conversion at all: x64 4.1 → 1.0 ns, arm64
  // within 0.1 ns (bench/lowering.mjs). Bit-exact.
  const SRC = `
    const f = (buf, out, n) => { for (let i = 0; i < n; i++) out[i] = (Math.floor(buf[i] * 0.5) | 0) & 255 }
    export const main = () => { const buf = new Uint8Array(8), out = new Int32Array(8); for (let i = 0; i < 8; i++) buf[i] = i * 31; f(buf, out, 8); f(buf, out, 8); return out[3] | 0 }
  `
  ok(/i32\.wrap_i64\s*\(i64\.trunc_sat_f64_s/.test(compile(SRC, { wat: true, optimize: 2 })), 'the default tier: the i64 truncation, wrapped')
  const wat = compile(SRC, { wat: true, optimize: { level: 'speed' } })
  ok(/6755399441055744/.test(wat) && !/trunc_sat_f64_s/.test(wat), 'the speed tier: the add, no truncation')
  is(/i32\.trunc_sat_f64_s/.test(wat), false, 'no bare i32 trunc_sat for the bounded floor')
  is(/f64\.const inf/.test(wat), false, 'no +∞ guard for the bounded floor')
  const ref = (() => { const buf = [], out = []; for (let i = 0; i < 8; i++) buf[i] = (i * 31) & 255
    const f = (b, o, n) => { for (let i = 0; i < n; i++) o[i] = (Math.floor(b[i] * 0.5) | 0) & 255 }; f(buf, out, 8); f(buf, out, 8); return out[3] | 0 })()
  is(jz(SRC, { optimize: { level: 'speed' } }).exports.main(), ref, 'floor result bit-exact vs JS')
})

test('charCodeAt: returns i32 — no f64 widen/truncate of the char code itself', () => {
  // `let c = s.charCodeAt(i)` should leave $c as i32 — no __to_num, no
  // f64.convert_i32_u of the char code. Inspect jz's type decisions before
  // watr `coalesceLocals` renames `$c`.
  //
  // P0-2 ledger (2026-08-02): the digit accumulator `n = n*10 + (c-48)` is a
  // loop-carried, unbounded local (reassigned every iteration — never a
  // never-reassigned decl, so it never gets a range-rep fact either) — `n*10`
  // no longer qualifies for `i32.mul` under the corrected, bilateral-bound
  // `mulFitsI32` (10 alone bounding the product used to be enough; now `n`'s
  // side needs a bound too, and a general loop accumulator has none). `n`
  // itself is genuinely value-correct either way (verified below, incl. an
  // input long enough to overflow i32 — `n` stays exact up to the f64 safe-
  // integer range, matching JS; the OLD i32-wraps-throughout codegen was only
  // accidentally correct here because EVERY use of `n` before the final `|0`
  // stays inside the +/× ring — proving that in general needs a "closed loop-
  // carried ring under a terminal ToInt32" analysis nothing in jz does today,
  // so it's not reproduced here). The trade is one `i64.trunc_sat_f64_s` at
  // the final `n|0` (was 0) instead of a same-signed local the whole way —
  // `c` itself, this test's actual subject, is unaffected.
  const wat = compile(`
    export const main = (s) => {
      let n = 0
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i)
        if (c >= 48 && c <= 57) n = n * 10 + (c - 48)
      }
      return n | 0
    }
  `, { wat: true, optimize: { watr: false } })
  const main = findFunc(parseWat(wat), '$main')
  ok(main, 'expected compiled $main function')
  ok(/\(local \$c i32\)/.test(wat), 'expected $c declared as i32')
  is(count(main, n => n[0] === 'call' && n[1] === '$__to_num'), 0,
    'the user function does not coerce the i32 char code')
  is(count(main, n => /^f64\.convert_i32_[su]$/.test(n[0]) && n[1]?.[0] === 'local.get' && n[1]?.[1] === '$c'), 0,
    'the char code itself is never widened to f64')
  is(count(main, n => n[0] === 'i64.trunc_sat_f64_s' && n[1]?.[0] === 'local.get' && n[1]?.[1] === '$n'), 1,
    'one final n|0 trunc consumes the accumulator; unrelated host-boundary conversions do not count')
})

test('charCodeAt: runtime correctness — digit parse', () => {
  const { main } = run(`
    export const main = (s) => {
      let n = 0
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i)
        if (c >= 48 && c <= 57) n = n * 10 + (c - 48)
      }
      return n | 0
    }
  `)
  is(main('abc12345xyz'), 12345)
  is(main('  9  '), 9)
})

// P0-2 ledger: without the final `|0`, the accumulator's exact value must
// escape as a genuine JS number — this is where the OLD i32.mul admission
// (bounding only the literal `10` side, not `n`) would have wrapped mod 2^32
// once the digit string grew past i32 range. Host JS is the authority (plain
// `n=n*10+digit` repeated — exact IEEE-754 double arithmetic, no ToInt32
// anywhere without the `|0`); '99999999999' (11 nines) accumulates well past
// 2^31-1 (~2.147e9) but stays exact in f64 (well under 2^53).
test('charCodeAt: digit parse stays exact past i32 range without a truncating sink', () => {
  const { main } = run(`
    export const main = (s) => {
      let n = 0
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i)
        if (c >= 48 && c <= 57) n = n * 10 + (c - 48)
      }
      return n
    }
  `)
  const jsRef = (s) => { let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c >= 48 && c <= 57) n = n * 10 + (c - 48) } return n }
  is(main('99999999999'), jsRef('99999999999'))
  is(main('99999999999'), 99999999999)
})

test('single-char string index equality skips materialized char string', () => {
  const wat = compile(`
    export const main = (x) => x[0] === '$'
  `, { wat: true, optimize: { watr: false } })
  const mainBody = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] || ''
  ok(!/\(call \$__str_idx\b/.test(mainBody), 'char equality should compare string bytes directly')
  ok(/i32.load16_u/.test(mainBody) && !/\(call \$__(?:char_at|str_length)\b/.test(mainBody), 'expected an inline unit read, no length or char call')
})

test('single-char string index equality keeps array fallback semantics', () => {
  const { main } = run(`
    const hit = x => x[0] === '$'
    export const main = () => {
      return hit('$abc')
        + hit('abc') * 2
        + hit('') * 4
        + hit(['$', 1]) * 8
        + hit([1, 2]) * 16
    }
  `)
  is(main(), 9)
})

test('single-char index equality: non-literal int index (loop variable)', () => {
  const wat = compile(`
    export const main = (s) => {
      let i = 0
      while (i < s.length && s[i] === ' ') i++
      return i
    }
  `, { wat: true, optimize: { watr: false } })
  const mainBody = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] || ''
  ok(!/\(call \$__str_idx\b/.test(mainBody), 'loop-variable char equality should skip __str_idx materialization')
  ok(/i32.load16_u/.test(mainBody) && !/\(call \$__(?:char_at|str_length)\b/.test(mainBody), 'expected an inline unit read, no length or char call')
})

test('single-char index equality: the unit read answers alone, inline, for every string storage', () => {
  // inline short strings, heap strings, empty, non-ASCII units, an embedded NUL,
  // indices before, inside and past each one; NUL as the literal keeps its length test
  const src = `
    const words = ['$name', '"str"', ';; c', '$"q"', 'i32.add', '(; x ;)', 'local.get', '$x', '', 'é$', 'a\\u0000b', 'xxxxxxxxxxxxxxxx$']
    const at = (w, i) => (w[i] === '$') + (w[i] === '"') * 2 + (w[i] !== ';') * 4 + (w[i] === '\\u0000') * 8
    export const main = () => {
      let s = 0
      for (let k = 0; k < words.length; k++) for (let i = -1; i < 18; i++) s = (s * 31 + at(words[k], i)) | 0
      return s
    }`
  is(run(src).main(), oracle(src).main())
  // `at` inlines into main; no other code of the module reads a string
  const body = compile(src, { wat: true, optimize: { level: 2, watr: false } })
  is((body.match(/call \$__char_at\b/g) || []).length, 1, 'only the NUL literal reads through __char_at')
  is((body.match(/call \$__str_length\b/g) || []).length, 1, 'only the NUL literal tests the length')
  const lean = compile(src, { wat: true, optimize: { level: 'size', watr: false } })
  is((lean.match(/call \$__char_at\b/g) || []).length, 4, 'the size tier reads each unit by one call')
  is((lean.match(/call \$__str_length\b/g) || []).length, 2, 'the size tier tests a length for NUL, and `__char_at` reads one')
  is(run(src, { optimize: 'size' }).main(), oracle(src).main(), 'the size tier agrees')
})

test('single-char index equality: for-loop runtime correctness', () => {
  const { main } = run(`
    export const main = (s) => {
      let n = 0
      for (let i = 0; i < s.length; i++) if (s[i] === '"') n++
      return n
    }
  `)
  is(main('a"b"c"'), 3)
  is(main(''), 0)
  is(main('no quotes'), 0)
})

test('single-char index equality: !== with loop variable', () => {
  const { main } = run(`
    export const main = (s) => {
      let i = 0
      while (i < s.length && s[i] !== ' ') i++
      return i
    }
  `)
  is(main('abc def'), 3)
  is(main('   '), 0)
  is(main('abc'), 3)
})

// ToInt32 is reduction mod 2^32; {+,−,×} are ring ops under it, so exact-int f64
// trees compute in i32 with no trunc/Infinity guard. `/`/`%` narrow with const
// divisors (`/` only at the ToInt32 root; `%` peels faithful converts at emit).

test('narrowI32: const-divisor div/mod/mul loops run pure i32', () => {
  for (const stmt of [
    's = (s + ((a[i] / 4) | 0)) | 0',
    's = (s + (a[i] % 10)) | 0',
    's = (s + a[i] * 3) | 0',
  ]) {
    const src = `export let f = (p, n) => {
      let a = new Int32Array(p)
      let s = 0
      for (let i = 0; i < n; i++) ${stmt}
      return s
    }`
    const wat = compile(src, { wat: true, optimize: 3 })
    let body = funcWat(wat, 'f')
    // Root F versioning: the cold checked twin (else arm) legitimately round-trips
    // f64 (checked reads are number|undefined) — measure the FAST arm's loop.
    if (body.includes('(else')) body = body.slice(0, body.indexOf('(else'))
    const loop = body.slice(body.indexOf('(loop'))
    ok(!/f64\.(add|sub|mul|div|trunc)/.test(loop.slice(0, loop.indexOf('(br '))),
      `no f64 round-trip in loop for: ${stmt}`)
  }
})

test('narrowI32: differential vs JS across wrap/sign edges', () => {
  const exprs = [
    ['(x * -1000000) | 0',           x => (x * -1000000) | 0],
    ['(x / -1) | 0',                 x => (x / -1) | 0],          // INT_MIN/−1: no trap, wraps
    ['(x % -7) | 0',                 x => (x % -7) | 0],
    ['(x * 3 + x * 5 - 9) | 0',      x => (x * 3 + x * 5 - 9) | 0],
    ['((x % 10) + (x / 2 | 0)) | 0', x => ((x % 10) + (x / 2 | 0)) | 0],
    ['(-x) | 0',                     x => (-x) | 0],
  ]
  const vals = [0, 1, -1, 2147483647, -2147483648, 1234567890, -1234567891]
  for (const [e, ref] of exprs) {
    const src = `export let f = (p) => { let a = new Int32Array(p); return ${e.replace(/x/g, 'a[0]')} }`
    const { f } = run(src)
    for (const v of vals) is(f(new Int32Array([v])), ref(v | 0), `${e} at x=${v}`)
  }
})

test('narrowI32: f64 edges (NaN/±Inf/fraction) keep exact ToInt32 semantics', () => {
  const exprs = [
    ['(x + 5) | 0',   x => (x + 5) | 0],
    ['(x / 4) | 0',   x => (x / 4) | 0],
    ['(x % 10) | 0',  x => (x % 10) | 0],
    ['(x + 0.5) | 0', x => (x + 0.5) | 0],
  ]
  // |x| ≥ 2^63 excluded: toI32's documented saturation boundary (asm.js-style).
  const vals = [0.5, -3.7, NaN, Infinity, -Infinity, 2**31, 2**52, 42]
  for (const [e, ref] of exprs) {
    const { f } = run(`export let f = (x) => ${e}`)
    for (const v of vals) is(f(v), ref(v), `${e} at x=${v}`)
  }
})

// An element of a plain array whose numbers the summary bounds to words (module/array.js
// numHullOf) is a leaf of the ring, as an integer typed array's element is: `s += v[i]` in a
// loop's integer copy and `(s + v[i]) | 0` as written add words. With the sum's own truncation
// between one trip and the next (a conversion each way, the addition, a rounding and its test)
// such a loop ran at fifteen times Node's time.
test('narrowI32: an integer element of a plain array adds as a word', () => {
  // (the function's first loop, whole: the integer copy where the loop is versioned)
  const loopOf = (src, optimize) => {
    const body = funcWat(compile(src, { wat: true, optimize }), 'f'), at = body.indexOf('(loop')
    let depth = 0, end = at
    for (; end < body.length; end++) { if (body[end] === '(') depth++; else if (body[end] === ')' && --depth === 0) break }
    return body.slice(at, end + 1)
  }
  const sum = (table, stmt) => `const v = ${table}\nexport let f = (n) => { let s = 0; for (let i = 0; i < n; i++) ${stmt}; return s }`
  // (a count of flags: a sum the loop's integer copy holds as a word, plan/integral-loops.js)
  const WORDS = '[3, -1, 4, 1, -5, 9, 2, -6]', FLAGS = '[0, 1, 0, 1, 1, 0, 1, 1]'
  for (const [label, table, stmt] of [
    ['a compound count of flags', FLAGS, 's += v[i & 7]'],
    ['a sum under | 0', WORDS, 's = (s + v[i & 7]) | 0'],
    ['a difference of a product', WORDS, 's = (s + v[i & 7] * 3 - v[(i + 3) & 7]) | 0'],
    ['a sum under a mask', WORDS, 's = (s + v[i & 7]) & 0xffff'],
  ]) {
    const src = sum(table, stmt), host = oracle(src)
    for (const optimize of levels(0, 1, 2, 3, 'size', 'speed')) { const f = run(src, { optimize }).f; for (const n of [0, 1, 7, 8, 1000]) is(f(n), host.f(n), `${label}, f(${n}) at ${optimize}`) }
    if (belowOpt(2)) continue
    for (const optimize of ownedLevels(2, 3)) {
      const loop = loopOf(src, optimize)
      ok(/i32\.add/.test(loop) && !/f64\.convert_i32_s|f64\.trunc\b/.test(loop), `${label} at ${optimize}: the sum adds words, with no conversion of it and no rounding`)
    }
  }
  // what is no word, or no exact sum, answers as Node: a fraction under a sum that goes below zero
  // (`(-3 + 0.5) | 0` is -2), a hole (`(s + undefined) | 0` is 0), words at the ends, integers
  // past a word, a product of three integers past 2^53, where the float product has rounded
  // (and below 2^63, where `| 0` is exact: README, "Bitwise operands under 2^63")
  for (const [label, table, stmt] of [
    ['a fraction among the elements', '[-7.5, 0.5, 2, 0.25, -3, 0.75, 1, -0.5]', 's = (s + v[i & 7]) | 0'],
    ['a hole among the elements', '[1, 2, , 4, 5, 6, 7, 8]', 's = (s + v[i & 7]) | 0'],
    ['words at their ends', '[2147483647, -2147483648, 2147483647, 1, -1, 2147483647, 5, -2147483648]', 's = (s + v[i & 7]) | 0'],
    ['integers past a word', '[2147483648, 4294967301, -8589934592, 1, 2, 3, 4, 9007199254740991]', 's = (s + v[i & 7]) | 0'],
    ['a product of three integers', '[1048573, -1048571, 1048559, 65537, -99991, 1048549, 3, -7]', 's = (s + v[i & 7] * v[(i + 1) & 7] * v[(i + 2) & 7]) | 0'],
    ['a compound sum of fractions', '[-7.5, 0.5, 2, 0.25, -3, 0.75, 1, -0.5]', 's += v[i & 7]'],
  ]) {
    const src = sum(table, stmt), host = oracle(src)
    for (const optimize of levels(0, 1, 2, 3, 'size', 'speed')) { const f = run(src, { optimize }).f; for (const n of [1, 2, 3, 8, 9, 100]) is(f(n), host.f(n), `${label}, f(${n}) at ${optimize}`) }
  }
  // an array a store elsewhere gives a fraction is no array of words
  const stored = `const v = ${WORDS}\nexport let put = (k, x) => { v[k & 7] = x }\nexport let f = (n) => { let s = 0; for (let i = 0; i < n; i++) s = (s + v[i & 7]) | 0; return s }`
  for (const optimize of levels(0, 1, 2, 3, 'size', 'speed')) {
    const a = run(stored, { optimize }), b = oracle(stored)
    a.put(1, -0.5); b.put(1, -0.5); a.put(4, 2.75); b.put(4, 2.75)
    for (const n of [1, 2, 5, 16, 100]) is(a.f(n), b.f(n), `an element stored a fraction, f(${n}) at ${optimize}`)
  }
})

// A signed division or remainder of a value the intervals prove non-negative by a positive one is
// the unsigned one: an engine divides an unsigned word by a constant with a multiply-high and a
// shift, the signed one adds a negative quotient's correction.
test('unsignedDivision: a non-negative dividend divides unsigned', () => {
  const src = `export let f = (n) => {
    const src = new Uint8Array(256), out = new Int32Array(256)
    for (let i = 0; i < 256; i++) src[i] = (i * 37 + 11) & 255
    let t = 0
    for (let x = 0; x < n; x++) {
      const s = src[x & 255] + src[(x + 1) & 255] + src[(x + 2) & 255]
      out[x & 255] = (s / 3) | 0
      t += out[x & 255] + src[(x + 5) & 255] % 7 + (((src[x & 255] - 128) / 3) | 0) + ((src[x & 255] - 128) % 5)
    }
    return t
  }`
  const host = oracle(src).f
  for (const optimize of ownedLevels('speed', 2, 1)) { const f = run(src, { optimize }).f; for (const n of [0, 1, 5, 300]) is(f(n), host(n), `O${optimize} n=${n}`) }
  if (onKernel()) return
  for (const o of ownedLevels('speed', 2)) {
    const body = funcWat(compile(src, { wat: true, optimize: o }), 'f')
    ok(/\(i32\.div_u/.test(body) && /\(i32\.rem_u/.test(body), `O${o}: the byte sum's quotient and the byte's remainder are unsigned`)
    ok(/\(i32\.div_s/.test(body) && /\(i32\.rem_s/.test(body), `O${o}: a dividend that may be negative stays signed`)
  }
})

test('a bare let assigned on every path before its reads is typed by its assignments', () => {
  if (onKernel() || belowOpt(2)) return
  const src = 'export let f = (n) => { let sum = 0; for (let i = 0; i < 1000; i++) { let x; if ((i & 1) === 0) x = (i + 1) | 0; else x = Math.imul(i, 3); sum = (sum + x) | 0 } return sum }'
  const wat = compile(src, { wat: true, optimize: 'speed' })
  is(loopCount(parseWat(wat), n => /^f64\./.test(n[0])), 0, 'the loop computes in i32')
  is(run(src, { optimize: 'speed' }).f(0), oracle(src).f(0))
  // a read some path reaches unassigned keeps its undefined
  const may = 'export let f = (c) => { let x; if (c) x = 1; return x === undefined ? -1 : x }'
  for (const c of [0, 1]) is(run(may, { optimize: 'speed' }).f(c), oracle(may).f(c), `c=${c}`)
})

test('int-div-lower: (a/b)|0 with i32 a,b → i32.div_s, bit-exact incl b=0 / INT_MIN÷-1', () => {
  // The JS integer-division idiom.
  const constSrc = `export let f = (x0) => { let x = x0|0; return (x/9)|0 }`
  const runSrc = `export let f = (x0, v0) => { let x = x0|0, v = v0|0; return (x/v)|0 }`
  ok(/i32\.div_s/.test(compile(constSrc, { wat: true, optimize: 'speed' })), 'constant divisor → i32.div_s')
  ok(/i32\.div_s/.test(compile(runSrc, { wat: true, optimize: 'speed' })), 'runtime divisor → guarded i32.div_s')
  ok(!/i32\.div_s/.test(compile(runSrc, { wat: true, optimize: { level: 'speed', intDivLower: false } })), 'off when disabled')
  // f64 dividend must NOT lower (could be fractional) — stays f64.div
  ok(!/i32\.div_s/.test(compile(`export let f = (x) => (x/9)|0`, { wat: true, optimize: 'speed' })), 'f64 operand not lowered')

  const { f } = run(runSrc, { optimize: 'speed' })
  const IM = -2147483648, IX = 2147483647
  for (const x of [0, 1, -1, 2, -2, 9, 256, IM, IX, -7, 12345, -99999])
    for (const v of [0, 1, -1, 2, -2, 9, 256, IM, IX, -7])
      is(f(x, v), (x / v) | 0, `(${x}/${v})|0`)
})

test('local-const fold: a chained const divisor becomes a literal (magic-multipliable)', () => {
  // A function-local `const` built from earlier consts (the blur window `2*rr+1`) folds to
  // a compile-time i32, so the int-divide lowering hands the wasm backend a CONSTANT
  // divisor (i32.const) — which V8 magic-multiplies — instead of a runtime `local.get`.
  const chain = `export let f = (x0) => { let x = x0|0; const rr = 4|0; const win = 2*rr+1; return (x/win)|0 }`
  const w = compile(chain, { wat: true, optimize: 'speed' })
  ok(/i32\.div_s\s+\([^)]*\)\s*\(i32\.const 9\)|i32\.const 9/.test(w), 'win folds to the literal 9')
  ok(!/i32\.div_s\s+\([^)]*\)\s*\(local\.get \$win/.test(w), 'divisor is not a runtime local')
  const { f } = run(chain, { optimize: 'speed' })
  for (const x of [0, 1, 8, 9, 17, 2295, 100000, -50]) is(f(x), (x / 9) | 0, `(${x}/9)`)
  // a reassigned `let` must NOT fold (its value isn't constant)
  const reassigned = `export let f = (x0) => { let x = x0|0; let d = 9|0; d = 3; return (x/d)|0 }`
  const { f: g } = run(reassigned, { optimize: 'speed' })
  for (const x of [0, 9, 30, 100]) is(g(x), (x / 3) | 0, `reassigned (${x}/3)`)
  // bitwise/shift fold too (R|0, 1<<s)
  is(run(`export let f = (x0) => { let x = x0|0; const m = 1 << 3; return (x/m)|0 }`, { optimize: 'speed' }).f(100), 12)
})

test('int-div-lower: a bounded-product chain (mask → ternary → sum-of-products) proves i32.shr_u, not the f64 round-trip', () => {
  // The delayline q16 split (bench/delayline/delayline.js runPass): raw = lfo & mask
  // (bitwise, provably [0,mask]) → tri = a ternary of two range-provable arms → dq =
  // DMIN*65536 + tri*DSPAN (a magnitude-BOUND product against a NAMED module const, not
  // just exprType's magnitude-blind `+`) → (dq/65536)|0, dq also feeding a second, real
  // (non-`|0`) division for the fractional part. Mirrors the real file's shape exactly
  // (module-level named consts, dual dq use, loop-scoped decls) — a same-looking
  // single-use/literal-only variant reaches a DIFFERENT, still-open bare-escape gap and
  // must not be conflated with what this pin covers.
  const src = `
    const DMIN = 96
    const DSPAN = 2000
    export let f = (n0) => {
      let lfo = 0, acc = 0
      const n = n0 | 0
      for (let i = 0; i < n; i++) {
        lfo = (lfo + 977) | 0
        const raw = lfo & 0x1ffff
        const tri = raw < 0x10000 ? raw : 0x20000 - raw
        const dq = DMIN * 65536 + tri * DSPAN
        const dInt = (dq / 65536) | 0
        const dFrac = (dq - dInt * 65536) / 65536.0
        acc = acc + dInt + dFrac
      }
      return acc
    }
  `
  const w = compile(src, { wat: true, optimize: exactToInt32('speed') })
  ok(/i32\.shr_u/.test(w), 'power-of-two divisor with a proven-nonneg dividend strength-reduces to i32.shr_u')
  // i64.trunc_sat_f64_s is the ordinary NaN-boxed param-unboxing ABI boundary (n0's
  // own coercion) — unrelated to the div lever.
  ok(!/i32\.trunc_sat_f64_s/.test(w), 'no f64 round-trip survives for the div')
  const { f } = run(src, { optimize: 'speed' })
  const ref = (n) => {
    let lfo = 0, acc = 0
    for (let i = 0; i < n; i++) {
      lfo = (lfo + 977) | 0
      const raw = lfo & 0x1ffff
      const tri = raw < 0x10000 ? raw : 0x20000 - raw
      const dq = 96 * 65536 + tri * 2000
      const dInt = (dq / 65536) | 0
      const dFrac = (dq - dInt * 65536) / 65536.0
      acc = acc + dInt + dFrac
    }
    return acc
  }
  for (const n of [0, 1, 5, 37, 200]) is(f(n), ref(n), `n=${n}`)
})

test('Pass-D range-proof exemption: bare-literal-only bounded chain stays i32 (delayline residual)', () => {
  // The "same-looking single-use/literal-only variant" the test above's own comment
  // flags as a DIFFERENT, still-open gap: no NAMED module const, `dq` fed by a bare
  // literal (`raw + 5000`) instead of a named DSPAN/DMIN, read once via `(dq/65536)|0`
  // and never compared anywhere. widenLocalTypes' Pass D (analyze.js) demotes any
  // level-1-classified (`+`/`-`/`*`, magnitude-open) i32 local with a bare escape to
  // f64 UNCONDITIONALLY — it never consulted `repOf(name)?.range`, even though
  // processDecl (same file, same top-down walk, runs before widenLocalTypes) already
  // stamps a real closed hull for any never-reassigned decl `intExprRange` can bound.
  // `dq` here is exactly that: `raw` is bitwise-bounded ([0,0x1ffff]), `dq = raw+5000`
  // closes to [5000, 0x1ffff+5000] — well inside i32 — so the bare `(dq/65536)|0` read
  // can never see a wrapped value.
  const src = `
    export let f = (n0) => {
      let lfo = 0, acc = 0
      const n = n0 | 0
      for (let i = 0; i < n; i++) {
        lfo = (lfo + 977) | 0
        const raw = lfo & 0x1ffff
        const dq = raw + 5000
        const dInt = (dq / 65536) | 0
        acc = acc + dInt
      }
      return acc
    }
  `
  const w = compile(src, { wat: true, optimize: exactToInt32('speed') })
  ok(/i32\.shr_u/.test(w), 'power-of-two divisor over a range-proven bare-literal chain strength-reduces to i32.shr_u')
  ok(!/i32\.trunc_sat_f64_s/.test(w), 'no f64 round-trip survives for the div')
  const { f } = run(src, { optimize: 'speed' })
  const ref = (n) => {
    let lfo = 0, acc = 0
    for (let i = 0; i < n; i++) {
      lfo = (lfo + 977) | 0
      const raw = lfo & 0x1ffff
      const dq = raw + 5000
      const dInt = (dq / 65536) | 0
      acc = acc + dInt
    }
    return acc
  }
  for (const n of [0, 1, 5, 37, 200]) is(f(n), ref(n), `n=${n}`)

  // Negative control: a REASSIGNED (level-1, no processDecl range stamp — the
  // `!isReassigned` gate excludes it) accumulator with no governing comparison must
  // still demote to f64 exactly as before — the FFT-butterfly KNOWN-FAIL shape this
  // pass exists for is untouched by the exemption.
  const unbounded = `
    export let g = (n0) => {
      let id = 1
      const n = n0 | 0
      for (let i = 0; i < n; i++) id = id * 3
      return id + 0.5
    }
  `
  const { g } = run(unbounded, { optimize: 'speed' })
  const refG = (n) => { let id = 1; for (let i = 0; i < n; i++) id = id * 3; return id + 0.5 }
  for (const n of [0, 1, 5, 12]) is(g(n), refG(n), `unbounded g n=${n}`)
})

test('co-induction accumulator fact: base64 op-counter recovers i32 storage (INDUCTION-VARIABLE FACT project)', () => {
  // `op` is declared BEFORE the loop, stepped only by a body literal (`op += 4`),
  // guarded by a SHIFTED loop bound (`i + 3 <= N`) — the exact base64 encode/decode
  // shape f95b56bc/efe34b1c/d6460bce/c8700daa all named as "no existing slot in any
  // current channel".
  const N = 3072
  const src = `
    const N = ${N}
    const encode = (src, out) => {
      let op = 0
      for (let i = 0; i + 3 <= N; i += 3) {
        out[op] = src[i]
        out[op + 1] = src[i + 1]
        out[op + 2] = src[i + 2]
        op += 4
      }
      return op
    }
    export let f = () => {
      const src = new Uint8Array(N)
      const out = new Uint8Array((N / 3) * 4)
      for (let i = 0; i < N; i++) src[i] = (i * 7 + 3) & 0xff
      const op = encode(src, out)
      let cs = op
      for (let i = 0; i < out.length; i++) cs = (cs * 31 + out[i]) | 0
      return cs
    }
  `
  const w = compile(src, { wat: true, optimize: 'speed' })
  ok(/\(local \$\S*op i32\)/.test(w), 'op local promoted to i32 storage')
  // No f64 round-trip on any `local.get $…op` use specifically (module-wide
  // trunc_sat_f64_s isn't itself a signal — an unrelated stdlib helper can carry
  // one for a totally different reason; scope the check to op's own local).
  ok(!/i32\.trunc_sat_f64_s\s*\n\s*\(local\.get \$\S*op\)/.test(w), 'no f64 round-trip survives for op-indexed stores')
  const { f } = run(src, { optimize: 'speed' })
  const got = f()
  const ref = (() => {
    const src2 = new Uint8Array(N)
    const out2 = new Uint8Array((N / 3) * 4)
    for (let i = 0; i < N; i++) src2[i] = (i * 7 + 3) & 0xff
    let op = 0
    for (let i = 0; i + 3 <= N; i += 3) {
      out2[op] = src2[i]; out2[op + 1] = src2[i + 1]; out2[op + 2] = src2[i + 2]
      op += 4
    }
    let cs = op
    for (let i = 0; i < out2.length; i++) cs = (cs * 31 + out2[i]) | 0
    return cs
  })()
  is(got, ref, 'encode checksum matches reference bit-for-bit')

  // A conditional step whose two arms carry DIFFERENT deltas: the arm maximum
  // budgets the hull (`[0, 2N]`, maxAdvanceBudget), so the counter keeps i32
  // storage; the value is the same at every tier.
  const condStep = `
    const N = ${N}
    const encode = (src, out) => {
      let op = 0
      for (let i = 0; i < N; i++) {
        if (src[i] > 0) op += 1
        else op += 2
      }
      return op
    }
    export let f = (src, out) => encode(src, out)
  `
  const wCond = compile(condStep, { wat: true, optimize: 'speed' })
  ok(/\(local \$\S*op i32\)/.test(wCond), 'conditional differing-delta accumulator takes the arm-max budget (i32)')
  {
    const src3 = new Uint8Array(N); for (let i = 0; i < N; i++) src3[i] = (i * 7 + 3) & 0xff
    let expect = 0; for (let i = 0; i < N; i++) expect += src3[i] > 0 ? 1 : 2
    for (const O of levels(0, 'size', 'speed')) is(jz(condStep, { optimize: O }).exports.f(src3, new Uint8Array(4)), expect, `budgeted counter O${O}`)
  }

  // Negative control 2: a write to `op` OUTSIDE the loop body — no fact. The
  // write sits in an arm: one in the function's own statement list declares a
  // binding of its own (prepare/split-bindings.js), and `op` keeps its fact.
  const outsideWrite = `
    const N = ${N}
    const encode = (src, out) => {
      let op = 0
      for (let i = 0; i < N; i++) { out[op] = src[i]; op += 1 }
      if (src[0] > 0) op += 1
      return op
    }
    export let f = (src, out) => encode(src, out)
  `
  // (the counted loop's landing, `clc + (trips | 0)`, is an integer: the counter, `op` or a splice's
  // `…_op`, not the allocator's `$top`, may hold an i64 word, never the fact's i32)
  const wOutside = compile(outsideWrite, { wat: true, optimize: 'speed' })
  ok(/\(local \$(?:\S*_)?op (f64|i64)\)/.test(wOutside) && !/\(local \$(?:\S*_)?op i32\)/.test(wOutside), 'accumulator written outside the loop takes no i32 (no fact)')
  {
    const src4 = new Uint8Array(N).map((_, i) => i & 1)
    for (const O of levels(0, 'size', 'speed')) is(jz(outsideWrite, { optimize: O }).exports.f(src4, new Uint8Array(N)), N, `outside write O${O}`)
  }

  // Negative control 3: unbounded trip count (a dynamic, unproven loop bound) —
  // no fact; forCounterRange itself returns null so nothing downstream fires.
  const unboundedTrip = `
    const encode = (src, out, m) => {
      let op = 0
      for (let i = 0; i < m; i++) { out[op] = src[i]; op += 1 }
      return op
    }
    export let f = (src, out, m) => encode(src, out, m)
  `
  const wUnbounded = compile(unboundedTrip, { wat: true, optimize: 'speed' })
  ok(/\(local \$\S*op f64\)/.test(wUnbounded), 'unbounded-trip loop accumulator stays f64 (no fact)')

  // Negative control 4: overflow-adjacent — init + step*trips exceeds i32 range.
  // The soundness floor: a huge but FINITE hull must still fail escapeInRangeI32's
  // i32-fit check, not get silently clamped into a false admission.
  const overflowAdjacent = `
    const encode = (src, out) => {
      let op = 0
      for (let i = 0; i < 1000000; i++) { out[0] = src[i]; op += 3000 }
      return op
    }
    export let f = (src, out) => encode(src, out)
  `
  // (no int32 admission: a Number, or the exact i64 a counted wide accumulator carries)
  const wOverflow = compile(overflowAdjacent, { wat: true, optimize: 'speed' })
  ok(!/\(local \$(?:\S*_)?op i32\)/.test(wOverflow), 'overflow-adjacent accumulator is no int32 (no unsound admission)')
  is(jz(overflowAdjacent, { optimize: 'speed' }).exports.f(new Uint8Array(4), new Uint8Array(1)), 3000000000, 'overflow-adjacent accumulator is exact')
})

test('range-narrowing: ToInt32 of a bounded value through a reused local drops the +∞ guard', () => {
  if (onKernel()) return  // asserts emitted-WAT shape (no i64 round-trip in the loop) at the 'speed' level — a host-codegen assertion the kernel's fixed pipeline doesn't reproduce
  // `xi` (= floor of a [0,255]-bounded Uint8Array read × const) is read twice, so it stays
  // a local; ToInt32(local.get $xi) emits the guarded select(wrap(i64.trunc_sat), 0,
  // f64.ne(x, Inf)). f64Range — resolving $xi's single textual def through the trunc_sat
  // fold (src/optimize/index.js) — proves it ∈ [0, 7], so the +∞ guard is dead: the wrapped
  // i64 truncation alone, no guard, no bare i32 trunc_sat (the slower form on V8).
  const src = `export let f = (n) => {
    const buf = new Uint8Array(256)
    for (let i = 0; i < 256; i++) buf[i] = (i * 37) & 255
    let s = 0
    for (let i = 0; i < n; i++) {
      let v = buf[i & 255]
      let xi = Math.floor(v * 0.03125)
      s = (s + (xi & 255) + (xi & 127)) | 0
    }
    return s
  }`
  const t = parse(src, 'speed')
  // INVARIANT: the bounded index path carries no +∞ guard and no bare i32 trunc_sat — the wrapped i64 truncation.
  is(loopCount(t, n => n[0] === 'f64.const' && n[1] === 'Infinity'), 0, 'no +∞ guard in loop')
  is(loopCount(t, n => n[0] === 'i32.trunc_sat_f64_s'), 0, 'no bare i32 trunc_sat in loop')
  ok(loopCount(t, n => n[0] === 'i64.trunc_sat_f64_s') >= 1, 'bounded index truncated through i64')
  // Bit-exact vs JS over the full input range.
  const { f } = run(src)
  const ref = (n) => {
    const buf = new Uint8Array(256)
    for (let i = 0; i < 256; i++) buf[i] = (i * 37) & 255
    let s = 0
    for (let i = 0; i < n; i++) { let v = buf[i & 255]; let xi = Math.floor(v * 0.03125); s = (s + (xi & 255) + (xi & 127)) | 0 }
    return s
  }
  for (const n of [0, 1, 7, 256, 1000]) is(f(n), ref(n), `f(${n}) bit-exact vs JS`)
})

test('int narrowing: bounded typed-array element products use i32.mul (faithful), bit-exact', () => {
  // `int8[i] * int8[j]` (and i8/u8/i16 pairs, plus i16×u16) — the int-conv / correlation /
  // quantised-MAC shape — has a product that provably fits SIGNED i32. Rides the i32 ABI (one op,
  // no convert→f64.mul→convert round-trip) on V8 / JSC / wasmtime alike. u16×u16 (65535² > 2^31)
  // must STAY f64 — unfaithful.
  const i8sum = `export let f = (n) => {
    const a = new Int8Array(64); const b = new Int8Array(64)
    for (let i = 0; i < 64; i++) { a[i] = (i % 13) - 6; b[i] = (i % 7) - 3 }
    let s = 0; for (let i = 0; i < n; i++) s = s + a[i & 63] * b[i & 63]; return s
  }`
  // Scoped to $f's loop: a module-wide /i32\.mul/ match was vacuous (it matched
  // __alloc_hdr_n's cap*stride until watr's param specialization removed it, which
  // is how this pin went red while the user loop had SILENTLY never narrowed —
  // `.typed:[]` hands `*` pre-converted operands; the emit gate now peels them).
  ok(loopCount(findFunc(parse(i8sum, 'speed'), '$f'), n => n[0] === 'i32.mul') >= 1, 'i8×i8 product narrows to i32.mul')

  // u16×u16 stays f64 (the exact product can exceed signed i32 → i32.mul would be unfaithful).
  const u16sq = `export let f = (n) => {
    const a = new Uint16Array(8); for (let i = 0; i < 8; i++) a[i] = 60000 + i
    let s = 0; for (let i = 0; i < n; i++) s = s + a[i & 7] * a[(i + 1) & 7]; return s
  }`
  const u16f = findFunc(parse(u16sq, 'speed'), '$f')
  ok(loopCount(u16f, n => n[0] === 'f64.mul') >= 1, 'u16×u16 product stays f64.mul (faithfulness-excluded)')
  ok(loopCount(u16f, n => n[0] === 'i32.mul') === 0, 'u16×u16 never rides i32.mul')

  // Bit-exact vs JS across contexts: i8 reduction (f64 value), i16×u16 (boundary), u16×u16 (excluded).
  const cases = [
    [i8sum, [0, 1, 100, 1000]],
    [`export let f = (n) => { const a = new Int16Array(8); const b = new Uint16Array(8); for (let i=0;i<8;i++){a[i]=-30000+i;b[i]=60000+i} let s=0; for (let i=0;i<n;i++) s=s+a[i&7]*b[i&7]; return s }`, [0, 1, 8, 50]],
    [u16sq, [0, 1, 8, 50]],
  ]
  for (const [src, ns] of cases) {
    const { f } = run(src)
    const ref = new Function('n', '"use strict";' + src.replace(/^export let f = /, 'const f = ').replace(/return s\s*}$/, 'return s }') + '; return f(n)')
    for (const n of ns) is(f(n), ref(n), `bit-exact vs JS at n=${n}`)
  }
})

test('scalar range facts: q16 chain stays i32 end-to-end (delayline class)', () => {
  // Module-const names (DSPAN) failed the product-i32 rule's literal check, so
  // the whole q16 chain fell to f64 (f64.div + trunc per sample). intExprRange
  // chains const names + ranged decl reps (mask → ternary hull → bounded
  // product); the divide strength-reduces to a shift (or, since the P0-2 fix
  // below, an exact-reciprocal f64 multiply) and the f64 fraction split
  // multiplies by the exact reciprocal.
  //
  // P0-2 ledger (2026-08-02): `t*DSPAN`'s admission now requires a magnitude BOUND
  // on BOTH operands (not `DSPAN`'s literal bound alone — the old rule's
  // unsoundness). `d` is still computed in native i32 (`i32.add`/`i32.mul`,
  // confirmed below) and every value below is exact — this is a lost
  // shift-strength-reduction, not a correctness gap. Flagged for a follow-up; not
  // fixed here (would mean reordering or duplicating an existing whole-function
  // analysis pass, out of scope for the mulFitsI32 fix).
  const src = `
const DMIN = 96, DSPAN = 2000
export let f = (p) => {
  const r = p & 0x1ffff
  const t = r < 0x10000 ? r : 0x20000 - r
  const d = DMIN * 65536 + t * DSPAN
  const di = (d / 65536) | 0
  const fr = (d - di * 65536) / 65536.0
  return di + fr
}`
  const jsF = (p) => { const r = p & 0x1ffff; const t = r < 0x10000 ? r : 0x20000 - r; const d = 96 * 65536 + t * 2000; const di = (d / 65536) | 0; return di + (d - di * 65536) / 65536.0 }
  for (const optimize of levels(0, 2, 'speed')) {
    const { f } = run(src, { optimize })
    for (const p of [0, 1, 0xffff, 0x10000, 0x1ffff, 0x20000, -1, -123456, 2147483647])
      is(f(p), jsF(p), `O${optimize} p=${p}: q16 split exact`)
  }
  const wat = compile(src, { wat: true, optimize: 'speed' })
  const fn = wat.split('(func ').find(c => c.startsWith('$f')) || ''
  ok(!/f64\.div|i32\.div/.test(fn), 'no divides anywhere in the chain')
  ok(/i32\.add\b/.test(fn) && /i32\.mul\b/.test(fn), 'd itself (DMIN*65536 + t*DSPAN) still computes in native i32')
})

test('sign-bit mask yields no non-negative hull (x & 0x80000000 can be negative)', () => {
  // `&` is ToInt32: a mask with bit 31 set produces 0 or -2^31, never [0, m].
  // The unguarded hull let div→shr_u strength-reduce a negative dividend (wasm
  // 32768 vs JS -32768). (Products that EXCEED i32 under such masks are outside
  // the i32 contract — the fuzzer's "i32 contract exceeded" exclusion — so only
  // in-range results are pinned.)
  const src = `export let f = (x) => ((x & 0x80000000) / 65536) | 0`
  for (const optimize of levels(0, 2, 'speed')) {
    const { f } = run(src, { optimize })
    for (const x of [-1, 0x80000000, -2147483648, 5, 0])
      is(f(x), ((x & 0x80000000) / 65536) | 0, `O${optimize} x=${x}: sign-bit mask divide`)
  }
})

test('f64 power-of-two division folds to exact reciprocal multiply', () => {
  const src = `export let f = (x) => x / 1024`
  const { f } = run(src, { optimize: 2 })
  for (const x of [0, -0, 1, 3.7, -5.25, 1e300, -1e-300, NaN, Infinity, -Infinity])
    is(Object.is(f(x), x / 1024), true, `x=${x} exact`)
  const wat = compile(src, { wat: true, optimize: 2 })
  const fn = wat.split('(func ').find(c => c.startsWith('$f')) || ''
  ok(!/f64\.div/.test(fn) && /f64\.mul/.test(fn), 'div-by-2^k emitted as multiply')
})


test('a word converted to a Number and rounded back is the word; a flag of literals is a word', () => {
  // hashjoin's insert, inlined with the loop counter as its value: the value is a word
  // the callee's Number parameter converted and truncated back (int-narrow.js
  // foldWrappedWords), and the inliner's done flag a word of literals (narrowFlagLocals):
  // the probe loops compute in integers alone.
  const src = `const MASK = 1023
    const put = (keys, vals, k, v) => {
      let h = (Math.imul(k, 0x9e3779b1) >>> 0) & MASK
      while (keys[h] !== -1) { if (keys[h] === k) { vals[h] = v; return } h = (h + 1) & MASK }
      keys[h] = k; vals[h] = v
    }
    const get = (keys, vals, k) => {
      let h = (Math.imul(k, 0x9e3779b1) >>> 0) & MASK
      while (keys[h] !== -1) { if (keys[h] === k) return vals[h]; h = (h + 1) & MASK }
      return 0
    }
    export let main = (count) => {
      const keys = new Int32Array(MASK + 1).fill(-1), vals = new Int32Array(MASK + 1)
      const n = count | 0
      let s = 7
      for (let i = 0; i < n; i++) { s = Math.imul(s ^ (s >>> 13), 0x5bd1e995); put(keys, vals, s & 0x7fffffff, i) }
      let acc = 0
      s = 7
      for (let i = 0; i < n; i++) { s = Math.imul(s ^ (s >>> 13), 0x5bd1e995); acc = (acc + get(keys, vals, s & 0x7fffffff)) | 0 }
      return acc
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) for (const n of [0, 5, 300]) is(run(src, { optimize }).main(n), js.main(n), `${n} at ${optimize}`)
  if (onKernel() || belowOpt(2)) return
  const w = funcWat(compile(src, { wat: true, optimize: 'speed' }), 'main')
  is(loopCount(parseWat(w), n => n[0] === 'f64.const' && String(n[1]) === '6755399441055744'), 0, 'no rounding of a word in the loops')
  is(loopCount(parseWat(w), n => /^(?:f64|i64)\./.test(n[0])), 0, 'the loops compute in words')
})

test('a flag of literals: a write nested in another write\'s value is a write of its own', () => {
  // `for (let i = 0, d; (d = ops[i++]); )`: the counter's step sits inside the test's
  // assignment.
  const src = `const mk = (ops, fn = (a) => { for (let i = 0, d; (d = ops[i++]); ) { if (d === a) return i } return 0 }) => fn
    export let main = () => mk([3, 4, 5])(4)`
  for (const optimize of levels(0, 2, 'speed')) is(run(src, { optimize }).main(), 2, `at ${optimize}`)
})

// The interval each i32 value holds where it is computed (optimize/word-ranges.js),
// read off control flow: a counter under its loop test, a mask, a byte; a sum a word
// could wrap in has none.
const WORD_KERNELS = [
  // an insertion sort: a counter stepped down past zero, `a[j + 1]` at j = -1
  `export let f = () => {
    const a = new Float64Array(21)
    let s = 7
    for (let i = 0; i < 21; i++) { s = (s * 1103515245 + 12345) | 0; a[i] = (s >>> 8) % 1000 }
    for (let i = 1; i < 21; i++) { const v = a[i]; let j = i - 1; while (j >= 0 && a[j] > v) { a[j + 1] = a[j]; j-- } a[j + 1] = v }
    let h = 0
    for (let i = 0; i < 21; i++) h = (h * 31 + a[i]) | 0
    return h
  }`,
  // a hash table: masked probes, a counter that wraps, unsigned tests
  `export let f = () => {
    const keys = new Int32Array(256), vals = new Int32Array(256)
    let h = 0, x = 12345
    for (let i = 0; i < 200; i++) {
      x = (x * 1664525 + 1013904223) | 0
      let k = x >>> 20, p = (Math.imul(k, 2654435761) >>> 24) & 255
      while (keys[p] !== 0 && keys[p] !== k + 1) p = (p + 1) & 255
      keys[p] = k + 1; vals[p] = (vals[p] + i) | 0
    }
    for (let i = 255; i >= 0; i -= 3) h = (h ^ vals[i]) * 16777619 | 0
    return h
  }`,
  // nested loops, a break, a counter read past its loop
  `export let f = () => {
    const g = new Uint8Array(64 * 64)
    let n = 0, last = 0
    for (let y = 0; y < 64; y++) {
      let x = 0
      for (; x < 64; x++) { if (((x * y) & 31) === 7) break; g[y * 64 + x] = (x ^ y) & 255 }
      last = x
      for (let k = 63; k > x; k -= 2) n = (n + g[y * 64 + k]) | 0
    }
    return n * 64 + last
  }`,
]
const wordInstrument = (fn, ranges) => {
  let checks = 0
  const wrap = (n) => {
    for (let i = 1; i < n.length; i++) {
      const c = n[i]
      if (!Array.isArray(c)) continue
      wrap(c)
      const r = ranges.get(c)
      if (!r || c[0] === 'i32.const') continue
      checks++
      n[i] = ['block', ['result', 'i32'], ['local.set', '$__chk', c],
        ['if', ['i32.or', ['i32.lt_s', ['local.get', '$__chk'], ['i32.const', r.lo]], ['i32.gt_s', ['local.get', '$__chk'], ['i32.const', r.hi]]], ['then', ['unreachable']]],
        ['local.get', '$__chk']]
    }
  }
  wrap(fn)
  let at = 2
  while (Array.isArray(fn[at]) && ['param', 'result', 'local', 'export', 'type'].includes(fn[at][0])) at++
  fn.splice(at, 0, ['local', '$__chk', 'i32'])
  return checks
}
test('wordRanges: every interval holds where its value is computed', () => {
  for (const src of WORD_KERNELS) {
    const want = oracle(src).f()
    const mod = parseWat(compile(src, { wat: true, optimize: 'speed' }))
    let checks = 0
    for (const fn of mod) if (Array.isArray(fn) && fn[0] === 'func') {
      const ranges = wordRanges(fn)
      ok(ranges, `${fn[1]}: the walk follows the function`)
      if (ranges) checks += wordInstrument(fn, ranges)
    }
    ok(checks > 20, `${checks} values checked`)
    is(new WebAssembly.Instance(new WebAssembly.Module(encodeWat(mod))).exports.f(), want, 'no value leaves its interval')
  }
  // the facts themselves: a counter, its step, a mask, a byte, a param, a sum that may wrap
  const g = (n) => ['local.get', n], k = (v) => ['i32.const', v]
  const i0 = g('$i'), i1 = g('$i'), step = ['i32.add', i1, k(1)], tee = ['local.tee', '$i', step], param = g('$p')
  const mask = ['i32.and', ['i32.add', param, i0], k(63)], byte = ['i32.load8_u', mask], sum = ['i32.add', g('$s'), byte]
  const back = ['br_if', '$L', ['i32.lt_s', tee, k(64)]], loop = ['loop', '$L', ['local.set', '$s', sum], back]
  const fn = ['func', '$f', ['param', '$p', 'i32'], ['result', 'i32'], ['local', '$i', 'i32'], ['local', '$s', 'i32'],
    ['block', '$B', ['br_if', '$B', ['i32.ge_s', g('$i'), k(64)]], loop], g('$s')]
  const r = wordRanges(fn)
  is(r.get(i0), { lo: 0, hi: 63 }, 'the counter under its test')
  is(r.get(step), { lo: 1, hi: 64 }, 'its step')
  is(r.get(mask), { lo: 0, hi: 63 }, 'a mask')
  is(r.get(byte), { lo: 0, hi: 255 }, 'a byte')
  is(r.get(param) ?? null, null, 'a parameter: no interval')
  is(r.get(sum) ?? null, null, 'a sum stepped without bound: no interval')
  is(loopTrips(loop, r), 65, 'the loop runs a pass per value of its counter at the step, and one more')
  loop[2] = ['br_if', '$L', g('$s')]
  is(loopTrips(loop, wordRanges(fn)), Infinity, 'a loop no counter stops has no bound')
})

// The walk holds the locals' intervals at a point as a value, shared between points
// in runs of 32: a write costs a run and a join the runs that differ. The bound is
// the old cost with a wide margin.
test('wordRanges: a write costs a run of locals, not every local of the function', () => {
  const N = 6000, g = (n) => ['local.get', n], k = (v) => ['i32.const', v]
  const fn = ['func', '$f', ['param', '$p', 'i32'], ['result', 'i32']]
  for (let i = 0; i < N; i++) fn.push(['local', `$v${i}`, 'i32'])
  for (let i = 0; i < N; i++) fn.push(['if', ['i32.lt_s', g('$p'), k(i)], ['then', ['local.set', `$v${i}`, k(i & 255)]], ['else', ['local.set', `$v${i}`, k(7)]]])
  const first = g('$v0'), mid = g('$v3000'), last = g(`$v${N - 1}`), unset = ['local.get', '$p']
  fn.push(['i32.add', ['i32.add', first, mid], ['i32.add', last, unset]])
  const t0 = performance.now(), r = wordRanges(fn), ms = performance.now() - t0
  is(r.get(first), { lo: 0, hi: 7 }, 'the first local: its two arms joined')
  is(r.get(mid), { lo: 7, hi: 3000 & 255 }, 'one in the middle')
  is(r.get(last), { lo: 7, hi: (N - 1) & 255 }, 'the last')
  // (the parameter each test bounds on either side: the two arms joined, any word again)
  is(r.get(unset), { lo: -2147483648, hi: 2147483647 }, 'a parameter the arms bound apart holds any word after them')
  ok(ms < 2000, `${N} locals written under ${N} tests: ${ms.toFixed(0)} ms`)
})

// A flag local is narrowed where every read follows a write on its path: the
// writes of each local were a list that each later write and read walked, so a
// local written in each of 20,000 arms (a guard list of assignments) took the
// square of the arms. The writes are a set each read's chain walks up through.
test('flag locals: a local written in 20,000 arms is narrowed in a time in the arms', () => {
  const n = 20000, g = (l) => ['local.get', l]
  // (each arm writes the flag and tests it: no write dominates another)
  const arms = Array.from({ length: n }, (_, i) => ['if', ['f64.eq', g('$x'), ['f64.const', String(i)]],
    ['then', ['local.set', '$r', ['f64.const', String(i % 3)]], ['br_if', '$L', ['f64.eq', g('$r'), ['f64.const', '1']]], ['br', '$L']]])
  const fn = ['func', '$f', ['param', '$x', 'f64'], ['local', '$r', 'f64'], ['block', '$L', ...arms]]
  const t0 = performance.now(), changed = narrowFlagLocals(fn), ms = performance.now() - t0
  ok(changed, 'the flag is narrowed')
  ok(ms < 1500, `${n} arms in ${ms.toFixed(0)} ms`)
  is(JSON.stringify(fn[3]), '["local","$r","i32"]')
  is(fn[4][2][2][2][2][0], 'i32.eq', 'its test an integer comparison')
})
