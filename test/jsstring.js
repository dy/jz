/**
 * `wasm:js-string` boundary opt-in tests.
 *
 * The narrower (src/narrow.js phase J) flips an exported function's string
 * param from f64 (NaN-boxed SSO carrier) to externref when:
 *   - every use of the param maps to a `wasm:js-string` builtin
 *   - at least one use is string-discriminating (`.charCodeAt`) or a call-site
 *     proves STRING — `.length`-only stays polymorphic to preserve the
 *     "number → undefined, array → length" tolerant semantics
 *   - `.charCodeAt(i)` uses are provably in-bounds (scanBoundedLoops) — the
 *     wasm:js-string builtin traps on OOB; we can only flip when safe
 *   - no reassignment / `++` / `--` / closure capture of the param
 *
 * When the opt-in fires:
 *   - boundary wrapper takes `(param externref)` — JS strings flow through
 *     directly, zero copy, zero transcoding
 *   - `.length` lowers to `(call $__jss_length …)`
 *   - in-bounds `.charCodeAt` lowers to `(call $__jss_charCodeAt …)`
 *   - interop.js attaches a JS polyfill for the `wasm:js-string` imports so
 *     engines without native builtin support still work
 */
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { run } from './util.js'

test('jsstring opt-in: bounded charCodeAt + length flips to externref', () => {
  const wat = jz.compile(`
    export const sum = (s) => {
      let n = 0
      for (let i = 0; i < s.length; i++) n += s.charCodeAt(i)
      return n
    }
  `, { wat: true, optimize: { watr: false } })
  ok(/\(func \$sum[\s\S]*?\(param \$s externref\)/.test(wat), 'inner $sum should take externref')
  ok(wat.includes('(call $__jss_length'), 'should call wasm:js-string.length')
  ok(wat.includes('(call $__jss_charCodeAt'), 'should call wasm:js-string.charCodeAt')
  ok(wat.includes('(import "wasm:js-string" "length"'), 'should import wasm:js-string.length')
  ok(wat.includes('(import "wasm:js-string" "charCodeAt"'), 'should import wasm:js-string.charCodeAt')
  ok(wat.includes('"jz:extparam"'), 'should record externref params in jz:extparam custom section')
})

test('jsstring opt-in: runtime correctness — sum of char codes', () => {
  const { sum } = run(`
    export const sum = (s) => {
      let n = 0
      for (let i = 0; i < s.length; i++) n += s.charCodeAt(i)
      return n
    }
  `)
  // Pass a JS string directly — interop should pass it through as externref.
  is(sum('abc'), 97 + 98 + 99)
  is(sum(''), 0)
  is(sum('abcdefghij'), [97,98,99,100,101,102,103,104,105,106].reduce((a,b) => a+b, 0))
})

test('jsstring opt-in: .length alone stays polymorphic (number → undefined)', () => {
  // `.length` alone is not string-discriminating: arrays/typed-arrays have it
  // too. The narrower keeps this f64 / __length path so `f(42).length` still
  // returns undefined (the tolerant pre-opt-in semantic).
  const wat = jz.compile(`
    export const len = (s) => s.length
  `, { wat: true, optimize: { watr: false } })
  ok(!/\(func \$len[\s\S]*?\(param \$s externref\)/.test(wat),
    '.length-only should NOT flip to externref (polymorphic vs string/array/typed)')
  ok(!wat.includes('(call $__jss_length'),
    '.length-only should NOT call wasm:js-string.length')
})

test('jsstring opt-in: unbounded charCodeAt stays SSO (trap risk)', () => {
  // `.charCodeAt(i)` with an unbounded `i` would trap under wasm:js-string
  // (JS spec returns NaN). The narrower refuses to flip in this case.
  const wat = jz.compile(`
    export const at = (s, i) => s.charCodeAt(i)
  `, { wat: true, optimize: { watr: false } })
  ok(!/\(func \$at[\s\S]*?\(param \$s externref\)/.test(wat),
    'unbounded charCodeAt should NOT flip to externref (would trap on OOB)')
})

test('jsstring opt-in: reassignment rejects', () => {
  const wat = jz.compile(`
    export const f = (s) => {
      s = 'x'
      return s.length
    }
  `, { wat: true, optimize: { watr: false } })
  ok(!/\(func \$f[\s\S]*?\(param \$s externref\)/.test(wat),
    'reassigned param should NOT flip to externref')
})

test('jsstring opt-in: closure capture rejects', () => {
  const wat = jz.compile(`
    export const f = (s) => {
      const cb = () => s.length
      return cb()
    }
  `, { wat: true, optimize: { watr: false } })
  ok(!/\(func \$f[\s\S]*?\(param \$s externref\)/.test(wat),
    'captured-by-closure param should NOT flip to externref')
})

test('jsstring opt-in: param escape (concat) rejects', () => {
  const wat = jz.compile(`
    export const f = (s) => s + 'x'
  `, { wat: true, optimize: { watr: false } })
  ok(!/\(func \$f[\s\S]*?\(param \$s externref\)/.test(wat),
    'param flowing into a non-builtin op should NOT flip to externref')
})

test('jsstring opt-in: string-literal default is string-discriminating proof', () => {
  // `s = ''` declares intent — even without `.charCodeAt`, the explicit string
  // default proves the param is meant to be a string. Flip to externref; the
  // interop wrapper substitutes the default JS-side when caller passes undef.
  const wat = jz.compile(`
    export const len = (s = '') => s.length
  `, { wat: true, optimize: { watr: false } })
  ok(/\(func \$len[\s\S]*?\(param \$s externref\)/.test(wat),
    '.length-only with string-literal default should flip to externref')
  ok(wat.includes('(call $__jss_length'), 'should call wasm:js-string.length')
  ok(wat.includes('jz:extparam') && wat.includes('\\"d\\"'),
    'should record JS-side default in jz:extparam')
})

test('jsstring opt-in: string default substituted JS-side on undefined', () => {
  const { len } = run(`
    export const len = (s = 'fallback') => s.length
  `)
  is(len('hi'), 2, 'explicit string passes through')
  is(len(), 8, 'undefined → JS-side substitutes "fallback" (length 8)')
  is(len(undefined), 8, 'explicit undefined also substitutes')
})

test('jsstring opt-in: non-string default still skips opt-in', () => {
  // A numeric default would need a different boundary carrier — don't try.
  const wat = jz.compile(`
    export const f = (n = 0) => n + 1
  `, { wat: true, optimize: { watr: false } })
  ok(!/\(func \$f[\s\S]*?\(param \$n externref\)/.test(wat),
    'numeric default should NOT trigger jsstring opt-in')
})
