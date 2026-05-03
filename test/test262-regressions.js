// Reproductions of test262 failures — tracked for upstream fixes
// Categories:
//   - table-index: FIXED — guarded dynamic property closure calls with __ptr_type check
//   - unicode-escapes: subscript parser gap — \u{XXXX} escapes not supported
//   - scaling: test262 files with 8000+ identifiers blow parser stack (not a correctness bug)

import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { compile } from '../index.js'

function run(code, opts) {
  const wasm = compile(code, { jzify: true, ...opts })
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod)
  return inst.exports
}

// ============================================================================
// table index out of bounds — FIXED in src/emit.js by guarding dynamic
// property closure calls with a __ptr_type check.
// Source: test262 S13.2_A7_T1, S13.2_A7_T2
// `(function(){}).hasOwnProperty('caller')` used to crash with "table index is
// out of bounds" because __dyn_get_expr_t returned NULL_NAN for missing props
// and call_indirect blindly used it as a table index.
// ============================================================================

test('regression: IIFE property access — caller (test262 S13.2_A7_T1)', () => {
  const exports = run(`export let _run = () => { (function(){}).hasOwnProperty('caller'); return 1 }`)
  is(exports._run(), 1, 'IIFE .hasOwnProperty(caller) no longer crashes')
})

test('regression: IIFE property access — arguments (test262 S13.2_A7_T2)', () => {
  const exports = run(`export let _run = () => { (function(){}).hasOwnProperty('arguments'); return 1 }`)
  is(exports._run(), 1, 'IIFE .hasOwnProperty(arguments) no longer crashes')
})

// ============================================================================
// .caller / .callee prohibition — compile-time error for bad practice
// ============================================================================

test('prohibited: .caller property access', () => {
  let err
  try { compile(`export let f = () => { let g = ()=>42; return g.caller }`, { jzify: true }) }
  catch (e) { err = e }
  ok(err?.message.includes('caller'), `.caller should be prohibited: ${err?.message?.slice(0, 60)}`)
})

test('prohibited: .callee property access', () => {
  let err
  try { compile(`export let f = () => { let g = ()=>42; return g.callee }`, { jzify: true }) }
  catch (e) { err = e }
  ok(err?.message.includes('callee'), `.callee should be prohibited: ${err?.message?.slice(0, 60)}`)
})

// ============================================================================
// Unicode identifier escapes — subscript parser bug
// Source: test262 identifiers/start-unicode-*-escaped.js, part-unicode-*-escaped.js
// `\u{XXXX}` in identifiers → "Unclosed {" (parser doesn't support unicode escapes)
// Non-ASCII identifiers (ࡠ, etc.) → "Maximum call stack size exceeded"
// Tracked in ~/projects/subscript/ — reproducing here for visibility
// ============================================================================

test('regression: unicode escape in identifier (test262 start-unicode-*-escaped)', () => {
  let err
  try { compile(`export let _run = () => { var \\u{0860} = 1; return \\u{0860} }`, { jzify: true }) }
  catch (e) { err = e }
  ok(err?.message.includes('Unclosed {'), `unicode \\u{} escape: ${err?.message?.slice(0, 60)}`)
})

test('regression: non-ASCII identifier (test262 start-unicode-*)', () => {
  // Non-ASCII identifiers work fine — the test262 failures are stack overflow
  // from files with 8000+ declarations, not a correctness bug.
  const exports = run(`export let _run = () => { var ࡠ = 1; return ࡠ }`)
  is(exports._run(), 1, 'non-ASCII identifier works correctly')
})

test('regression: for-in with let as identifier (test262 identifier-let-allowed)', () => {
  let err
  try { compile(`export let _run = () => { for (let in {}) {} return 1 }`, { jzify: true }) }
  catch (e) { err = e }
  ok(err, `for-in with let identifier: ${err?.message?.slice(0, 80)}`)
})
