import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { run, oracle } from './util.js'
import { levels, onKernel } from './_matrix.js'
import { ctx } from '../src/ctx.js'
import { exprType } from '../src/type.js'
import { parse, loopCount } from '../scripts/wat-probe.mjs'

const compare = (source, inputs) => {
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const actual = run(source, { optimize }), expected = oracle(source)
    for (const args of inputs) is(actual.f(...args), expected.f(...args), `O${optimize}: ${args.join(', ')}`)
  }
}

test('index width: index-only arithmetic retains the full key across local writes', () => {
  for (const body of [
    'let x = 65536; x *= 65536',
    'let x = mode ? 65536 : 0; x *= 65536',
    'let x = 0; if (mode) x = 65536; x = x * 65536',
    'let x = mode ? 2147483647 : -1; x += 1; x *= 2',
    'let x = mode ? -2147483648 : 0; x -= 2147483648',
    'let seed = mode ? 65536 : 0; let offset = seed * 65536; let x = offset',
  ]) for (const ctor of ['Float32Array', 'Int32Array']) compare(`export function f(mode) {
    const a = new ${ctor}([2, 3]); ${body}
    const read = a[x]
    let effects = 0
    const assigned = a[x] = (++effects, 9)
    return [read, assigned, effects, a[0], a[1]]
  }`, [[0], [1], [1], [0]])
})

test('index width: a closed small result does not bound an arithmetic feeder', () => {
  compare(`export function f(mode) {
    const a = new Float32Array([2, 3])
    let x = mode ? 65536 : 0; x *= 65536
    const small = x - 4294967296
    const read = a[small]
    a[small] = 9
    return [read, a[0], a[1]]
  }`, [[0], [1], [0], [1]])
  compare(`export function f(mode) {
    const a = new Float64Array([2, 3])
    let x = mode ? 65536 : 0; x *= 65536
    return [a[x], a[x | 0]]
  }`, [[0], [1]])
})

test('index width: zero and repeated loop updates preserve out-of-range reads and stores', () => {
  compare(`export function f(rounds, len) {
    const a = new Float32Array(len)
    for (let i = 0; i < len; i++) a[i] = i + 2
    let x = 1
    for (let i = 0; i < rounds; i++) x *= 65536
    const before = a[x]
    a[x] = 9
    return [before, a]
  }`, [0, 1, 2, 3].flatMap(n => [0, 1, 2].map(len => [n, len])))
})

test('index width: global and captured keys retain full magnitude between calls', () => {
  for (const source of [
    `let x = 1; const a = new Float32Array([2, 3])
     export function f(mode) { if (mode) x *= 65536; else x = 1; return a[x] }`,
    `function make() { let x = 1; const a = new Float32Array([2, 3])
       return mode => { if (mode) x *= 65536; else x = 1; return a[x] } }
     const next = make(); export function f(mode) { return next(mode) }`,
  ]) compare(source, [[0], [1], [1], [1], [0], [1], [1]])
})

test('index width: bounded affine locals retain integer indexing', () => {
  const source = `export function f(n) {
    const a = new Float32Array(32)
    for (let i = 0; i < a.length; i++) a[i] = i + 0.25
    let sum = 0
    for (let i = 0; i < (n & 15); i++) { const x = i * 2; sum += a[x] }
    return sum
  }`
  compare(source, [[0], [1], [15], [-1], [2147483647], [4294967295], [0]])
  if (onKernel()) return
  const tree = parse(source, { level: 2, watr: false })
  ok(loopCount(tree, n => n[0] === 'i32.mul' || n[0] === 'i32.shl' &&
    n[1]?.[0] === 'local.get' && n[2]?.[0] === 'i32.const' && Number(n[2][1]) === 1) > 0,
  'the bounded affine product is an integer multiply or its strength-reduced shift')
  is(loopCount(tree, n => n[0] === 'f64.mul'), 0, 'the bounded index needs no floating product')
  is(loopCount(tree, n => n[0] === 'i32.trunc_sat_f64_s'), 0, 'the bounded index needs no per-access float conversion')
})


test('index width: a boxed cell type belongs only to its active storage map', () => {
  if (onKernel()) return
  const frame = ctx.func, { locals, boxed, cellTypes } = frame
  try {
    frame.locals = new Map([['value', 'i32']])
    frame.boxed = new Map([['value', 'value']])
    frame.cellTypes = null
    is(exprType('value', frame.locals), 'f64', 'the pointer addresses an f64 payload')
    is(exprType('value', new Map([['value', 'i32']])), 'i32', 'another body keeps its own local type')
    frame.cellTypes = new Set(['value'])
    is(exprType('value', frame.locals), 'i32', 'an explicitly narrowed cell returns its word')
    is(exprType('value', new Map([['value', 'f64']])), 'f64', 'another body cannot borrow the active cell width')
  } finally { frame.locals = locals; frame.boxed = boxed; frame.cellTypes = cellTypes }
})


test('index width: bounded magnitude never discards a producer negative zero', () => {
  for (const expression of ['-(k & 7)', '(k & 7) * -1', '((k & 7) - 3) * (k & 1)', '-((k & 7) - 3)', '((k & 7) - 3) % 3']) {
    const source = `export function f(k) { const a = new Float64Array([2]); let i = ${expression}, j = i; const stored = new Float64Array([j]); return [i, 1 / i, 1 / stored[0], a[j]] }`
    for (const optimize of levels(0, 1, 2, 3, 'size')) {
      const actual = run(source, { optimize }), expected = oracle(source)
      for (const k of [0, 1, 2, 3, 4, 7, -1]) is(actual.f(k), expected.f(k), `${expression}, ${k}, O${optimize}`)
    }
  }
})


test('index width: reassigned and captured bounded indices retain both zero signs', () => {
  for (const storage of ['local', 'captured', 'global']) {
    const source = storage === 'global' ? `let i = 0; const a = new Float64Array([2]); export function f(k) { i = -(k & 7); return [i, 1/i, a[i]] }`
      : `export function f(k) { const a = new Float64Array([2]); let i = 0; ${storage === 'captured' ? 'const set = () => { i = -(k & 7) }; set()' : 'i = -(k & 7)'}; return [i, 1/i, a[i]] }`
    compare(source, [[0], [0], [3], [0], [-1]])
  }
})
