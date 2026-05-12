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

test('regression: semicolon before leading-paren IIFE after object initializer', () => {
  const exports = run(`let state = 0
    const table = {};
    (function populate(value) { state = value })(7)
    export let _run = () => state`)
  is(exports._run(), 7, 'object initializer and following IIFE stay separate statements')
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
// Unicode identifier escapes — fixed in subscript 10.3.4
// Source: test262 identifiers/start-unicode-*-escaped.js, part-unicode-*-escaped.js
// `\u{XXXX}` in identifiers used to fail before subscript parsed identifier escapes.
// ============================================================================

test('regression: unicode escape in identifier (test262 start-unicode-*-escaped)', () => {
  const exports = run(`export let _run = () => { var \\u{0860} = 1; return \\u{0860} }`)
  is(exports._run(), 1, 'unicode identifier escape compiles and runs')
})

test('regression: non-ASCII identifier (test262 start-unicode-*)', () => {
  // Non-ASCII identifiers work fine — the test262 failures are stack overflow
  // from files with 8000+ declarations, not a correctness bug.
  const exports = run(`export let _run = () => { var ࡠ = 1; return ࡠ }`)
  is(exports._run(), 1, 'non-ASCII identifier works correctly')
})

test('regression: jzify hoists var initializer assignment', () => {
  const exports = run(`export let _run = () => { var x = 1; return x }`)
  is(exports._run(), 1, 'var initializer compiles as assignment to the declared name')
})

test('regression: jzify hoists for-var-in declaration', () => {
  const exports = run(`export let _run = () => {
    let o = { a: 1, b: 2 }
    let n = 0
    for (var k in o) n += 1
    return n
  }`)
  is(exports._run(), 2, 'for (var k in obj) compiles')
})

test('regression: jzify preserves new Array length constructor', () => {
  const exports = run(`export let _run = () => {
    let a = new Array(4)
    return a.length
  }`)
  is(exports._run(), 4, 'new Array(n) allocates expected length')

  const wasm = compile(`export let _run = () => {
    let a = new Array(4).fill(2)
    return a.length + a[0]
  }`, { jzify: true })
  ok(wasm.byteLength > 0, 'new Array(n).fill(...) compiles through jzify')
})

test('regression: jzify lowers destructured arrow params with expression object body', () => {
  const exports = run(`export let _run = () =>
    [[1, 2]].map(([a, b]) => ({ sum: a + b }))[0].sum
  `)
  is(exports._run(), 3, 'destructured arrow callback returning object literal compiles')
})

test('regression: jzify folds static esbuild export helper', () => {
  const exports = run(`
    var __defProp = Object.defineProperty;
    var __export = (target, all) => {
      for (var name in all)
        __defProp(target, name, { get: all[name], enumerable: true });
    };
    var src_exports = {};
    __export(src_exports, { default: () => mod_default });
    function impl() { return 42 }
    var mod_default = impl;
    export let _run = () => src_exports?.default();
  `)
  is(exports._run(), 42, 'static export object reads rewrite to the live local binding')
})

test('regression: for-in with let as identifier (test262 identifier-let-allowed)', () => {
  const exports = run(`export let _run = () => { for (let in {}) {} return 1 }`)
  is(exports._run(), 1, 'for-in with let as identifier compiles and runs')
})

test('test262 lexical grammar: ASI, comments, whitespace, line terminators, directive prologue', () => {
  const exports = run(`"use strict";
    export let _run = () => {
      let a = 1	/* multi-line comment */
      let b = 2 // single-line comment
      return a +
        b
    }`)
  is(exports._run(), 3, 'lexical grammar basics compile and run')
})

test('test262 comments: hashbang is accepted as a first-line comment', () => {
  const exports = run(`#! /usr/bin/env jz
export let _run = () => 1`)
  is(exports._run(), 1, 'hashbang comment compiles')
})

test('test262 debugger statement: parse and ignore at runtime', () => {
  const exports = run(`export let _run = () => { let x = 1; debugger; return x + 1 }`)
  is(exports._run(), 2, 'debugger is a no-op statement')
})

test('test262 delete operator: parser accepted but jz fixed-shape objects reject it', () => {
  let err
  try { compile(`export let _run = () => { let o = { x: 1 }; delete o.x; return o.x }`, { jzify: true }) }
  catch (e) { err = e }
  ok(err?.message.includes('object shape is fixed'), `delete should remain prohibited: ${err?.message?.slice(0, 80)}`)
})

test('test262 computed property names: static keys map to fixed-shape object slots', () => {
  const exports = run(`export let _run = () => {
    let o = { ['x']: 1, [1 + 1]: 2, [true ? 3 : 4]: 5 }
    if (o.x !== 1) return 0
    if (o[2] !== 2) return 0
    if (o[String(3)] !== 5) return 0
    return 1
  }`)
  is(exports._run(), 1, 'static computed keys resolve as fixed object properties')
})

test('test262 computed property names: dynamic keys stay unsupported for fixed-shape objects', () => {
  let err
  try { compile(`export let _run = () => { let x = 1; let o = { [x = 2]: 3 }; return o[2] }`, { jzify: true }) }
  catch (e) { err = e }
  ok(err?.message.includes('computed property name not supported'), `dynamic computed key should be explicit: ${err?.message?.slice(0, 80)}`)
})

test('test262 computed property names: effectful coercion is not folded as a static key', () => {
  let err
  try { compile(`export let _run = () => { let x = 0; let o = { [String(1, x = 1)]: 2 }; return x + o[1] }`, { jzify: true }) }
  catch (e) { err = e }
  ok(err?.message.includes('computed property name not supported'), `effectful computed key should not be folded away: ${err?.message?.slice(0, 80)}`)
})

test('test262 arguments object: jzify supports no-formal trailing-comma cases', () => {
  const exports = run(`export let _run = () => {
    let assert = (cond, msg) => { if (!cond) throw msg }
    assert.sameValue = (a, b, msg) => { if (a != b && !(a != a && b != b)) throw msg }
    var callCount = 0
    function ref() {
      assert.sameValue(arguments.length, 2)
      assert.sameValue(arguments[0], 42)
      assert.sameValue(arguments[1], 'TC39')
      callCount = callCount + 1
    }
    ref(42, 'TC39',)
    assert.sameValue(callCount, 1)
    return 1
  }`)
  is(exports._run(), 1, 'test262-shaped no-formal arguments case lowers through jzify rest params')
})

test('test262 arguments object: default initializer can reference arguments', () => {
  const exports = run(`export let _run = () => {
    function ref(a = arguments.length) { return a }
    return ref() + ref(7) * 10
  }`)
  is(exports._run(), 70, 'arguments in default params triggers rest-arguments lowering')
})
