// A scanner's position its closures capture and advance under a test of a
// string's length (type/bounded-counters.js): each step leaves the binding a
// word, so its cell stays i32 (compile/analyze-for-emit.js). Every program runs
// against Node; the ones whose counter no test bounds, or whose bound a call or
// a write may outrun, keep their cell a Number and their full magnitude.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { levels } from './_matrix.js'
import { oracle } from './util.js'

// Runs sweep this leg's levels; the WAT checks, compile-only, read every level.
const ALL = [0, 2, 3, 'size']

const agreeAll = (src, seeds) => {
  for (const optimize of levels(...ALL)) {
    const host = oracle(src), ex = jz(src, { optimize }).exports
    for (const name of Object.keys(host)) for (const n of seeds) is(ex[name](n), host[name](n), `O${optimize} ${name}(${n})`)
  }
}

// The widths the loads and stores of the binding `i`'s cell use at a level
// (none where the cell is gone: its closures inlined, the binding a local).
// A Number cell takes no word access; a word cell's first store, the
// placeholder before any value, still fills all 8 bytes.
const cellWidths = (src, optimize) => new Set([...compile(src, { optimize, wat: true })
  .matchAll(/\b(f64|i32)\.(?:load|store)\s*\(local\.get \$\ue000cell_i\)/g)].map(m => m[1]))

const SCAN = `const text = ('(module (func $f (param i32) (result i32) (i32.add (local.get 0) (i32.const 7))) ;; c\\n').repeat(4)
const scan = (str) => {
  let i = 0, start = -1, q = 0, n = 0
  const commit = () => { if (start >= 0) { n += i - start; start = -1 } }
  const level = () => {
    for (let c; i < str.length;) {
      c = str.charCodeAt(i)
      if (q === 34) { i++; if (c === 34) { commit(); q = 0 } }
      else if (c === 34) { commit(); start = i; q = 34; i++ }
      else if (c === 40) { commit(); i++; level() }
      else if (c === 41) { commit(); i++; return }
      else if (c <= 32) { commit(); i++ }
      else { if (start < 0) start = i; i++ }
    }
    commit()
  }
  level()
  return n * 1000 + i
}
export const f = (k) => scan(text.slice(k)) + scan('"a b" (x y) ' + k)`

test('captured counters: a scanner position its closures advance under a length test', () => {
  agreeAll(SCAN, [0, 1, 7, 40])
})

test('captured counters: the position cell keeps its word in the scanner', () => {
  const wat = compile(SCAN, { optimize: 3, wat: true }).replace(/\ue000/g, '')
  const scanner = wat.split(/\n(?=  \(func )/).find(p => /\(func \$closure\d+\b/.test(p) && /i32\.load16_u/.test(p)) ?? ''
  ok(scanner && !/f64\.store/.test(scanner), 'no Number store in the scanning closure: its cells are words')
})

// Scanners shaped like the one above, small: each step of `i` runs under a test
// of a string's length, with no call between that may move `i`.
const WORD = {
  walk: `export const f = (k) => { let i = 0; const s = 'abc'.repeat(k + 1)
    const walk = () => { while (i < s.length) i++ }
    walk(); return i }`,
  nest: `export const f = (k) => { let i = 0, d = 0; const s = '(a(b)c)'.repeat(k + 1)
    const lvl = () => { for (; i < s.length;) { const c = s.charCodeAt(i); i++; if (c === 40) { d++; lvl() } else if (c === 41) return } }
    lvl(); return i * 100 + d }`,
  pairs: `export const f = (k) => { let i = 0, n = 0; const s = 'abcdefg'.repeat(k + 1)
    const sum = () => { while (s.length > i && n < 1e9) { n += s.charCodeAt(i); i = i + 2 } }
    sum(); return i * 1000 + n }`,
}

test('captured counters: a step under a length test keeps the cell a word', () => {
  for (const [name, src] of Object.entries(WORD)) {
    agreeAll(src, [0, 1, 9])
    const held = ALL.map(o => cellWidths(src, o)).filter(w => w.size)
    ok(held.length && held.every(w => w.has('i32')), `${name}: the cell is a word wherever it is left`)
  }
})

// Where no test bounds a step, a call or a write between the test and the step
// may move the binding (a closure that writes it, known or escaped; a later
// conjunct of the test itself), the steps since the test add past the budget or
// no constant, or the bound is an array's length (`new Array(n)` may hold one no
// element fills), the cell keeps a Number.
const KEEP = {
  unbounded: `export const f = (k) => { let i = 2147483000; const bump = () => { i += 1000 }; for (let j = 0; j < 3 + k; j++) bump(); return i }`,
  big: `export const f = (k) => { let i = 2147483640; const s = 'xy'
    const scan = () => { while (i < s.length) i++ }
    scan(); i += k; return i + 10 }`,
  outrun: `export const f = (k) => { let i = 0; const s = 'abcdef'.repeat(k + 1)
    const adv = () => { while (i < s.length) i++ }
    const go = () => { while (i < s.length) { adv(); i++ } }
    go(); return i }`,
  escaped: `export const f = (k) => { let i = 0; const s = 'abc'.repeat(k + 2)
    const step = () => { while (i < s.length) i++ }
    const run = (g) => { while (i < s.length) { g(); i++ } }
    run(step); return i }`,
  late: `export const f = (k) => { let i = 0; const s = 'ab'
    const w = () => { while (i < s.length && (i = 2147483647)) { i++; break } }
    w(); return i + k }`,
  lateCall: `export const f = (k) => { let i = 0; const s = 'ab'
    const jump = () => { i = 2147483647; return true }
    const w = () => { while (i < s.length && jump()) { i++; break } }
    w(); return i + k }`,
  typed: `export const f = (k) => { let i = 0; const b = new Uint8Array(10 + k)
    const walk = () => { while (i < b.length) i++ }
    walk(); return i }`,
  array: `export const f = (k) => { let i = 0, n = 0; const a = Array.from({ length: 10 + k }, (_, j) => j)
    const sum = () => { while (i < a.length) { n += a[i]; i++ } }
    sum(); return i * 1000 + n }`,
  stride: `export const f = (k) => { let i = 0; const s = 'abcdefgh'.repeat(k + 1)
    const walk = () => { while (i < s.length) i += k + 1 }
    walk(); return i }`,
  huge: `export const f = (k) => { let i = 0; const s = 'ab'.repeat(k + 1)
    const walk = () => { while (i < s.length) i += 3e9 }
    walk(); return i }`,
  budget: `export const f = (k) => { let i = 0; const s = 'ab'.repeat(k + 1)
    const walk = () => { while (i < s.length) { i += 200; i += 100 } }
    walk(); return i }`,
  down: `export const f = (k) => { let i = 0; const s = 'abc'.repeat(k + 1)
    const walk = () => { while (i < s.length && i > -5) i-- }
    walk(); return i }`,
}

test('captured counters: an unbounded or outrun counter keeps its magnitude', () => {
  for (const [name, src] of Object.entries(KEEP)) {
    agreeAll(src, [0, 1, 9])
    ok(cellWidths(src, 0).size, `${name}: the cell is left at O0`)
    for (const o of ALL) ok(!cellWidths(src, o).has('i32'), `${name} O${o}: the cell stays a Number`)
  }
})
