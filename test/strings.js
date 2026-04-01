// Comprehensive string method tests
import test from 'tst'
import { is, ok, almost } from 'tst/assert.js'
import compile from '../index.js'
import compile_mem from '../index.js'

function run(code) {
  const wasm = compile(code)
  const mod = new WebAssembly.Module(wasm)
  return new WebAssembly.Instance(mod).exports
}

// ============================================
// STRING METHODS
// ============================================

// === .concat ===

test('string: .concat single', () => {
  is(run(`export let f = () => "hello".concat(" world").length`).f(), 11)
})

test('string: .concat two', () => {
  is(run(`export let f = () => "a".concat("b").length`).f(), 2)
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
