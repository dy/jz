// Compile-time advisories (opts.warnings / ctx.warn). See .work/todo.md.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt } from './_opt.js'
import jz, { compile } from '../index.js'

function warningsFor(code, opts = {}) {
  const warnings = { entries: [] }
  compile(code, { ...opts, warnings })
  return warnings.entries
}

test('warnings: no sink → no advisories emitted', () => {
  is(warningsFor('export let f = () => [1, 2, 3]').length, 0)
})

test('warnings: heap-return on exported pointer result', () => {
  const ws = warningsFor('export let f = () => { let a = [1, 2, 3]; return a }')
  is(ws.length, 1)
  is(ws[0].code, 'heap-return')
  ok(/memory\.reset\(\)/.test(ws[0].message))
})

test('warnings: small inline array return is scalarized — no heap advisory', () => {
  is(warningsFor('export let f = () => [1, 2, 3]').length, 0)
})

test('warnings: heap-loop when a loop body allocates', () => {
  const ws = warningsFor(`
    export let f = (n) => {
      let xs = []
      for (let i = 0; i < n; i++) xs.push(i)
      return xs.length
    }
  `)
  is(ws.length, 1)
  is(ws[0].code, 'heap-loop')
})

test('warnings: arena-rewind-skipped on parametric export that allocates', () => {
  const ws = warningsFor('export let f = (n) => { let xs = []; xs.push(n); return xs.length }')
  is(ws.length, 1)
  is(ws[0].code, 'arena-rewind-skipped')
})

test('warnings: arena-rewindable zero-arg scalar export stays quiet', () => {
  const ws = warningsFor('export let f = () => { let a = [1, 2, 3]; return a.length }')
  is(ws.length, 0)
})

test('warnings: pure scalar module stays quiet', () => {
  is(warningsFor('export let add = (a, b) => a + b').length, 0)
})

test('warnings: alloc:false modules stay quiet', () => {
  const ws = warningsFor('export let f = () => [1, 2, 3]', { alloc: false })
  is(ws.length, 0)
})

test('warnings: jz() surfaces advisories on the runtime result', () => {
  const warnings = { entries: [] }
  const { warnings: surfaced } = jz('export let f = () => { let a = [1]; return a }', { warnings })
  is(surfaced.length, 1)
  is(surfaced[0].code, 'heap-return')
})

test('warnings: untagged instanceof on Error types (jzify)', () => {
  const ws = warningsFor('export let f = (e) => e instanceof TypeError', { jzify: true })
  is(ws.length, 1)
  is(ws[0].code, 'untagged-instanceof')
})

test('warnings: set-map-order on JSON.stringify(map)', () => {
  const ws = warningsFor('export let f = () => JSON.stringify(new Map())')
  is(ws.length, 1)
  is(ws[0].code, 'set-map-order')
})

test('warnings: jsstring-declined when concat blocks externref carrier', () => {
  if (belowOpt(2)) return  // jsstring ABI (and its decline advisory) is engaged at optimize >= 2
  const ws = warningsFor(`export let f = (s = '') => s + '!'`)
  is(ws.length, 1)
  is(ws[0].code, 'jsstring-declined')
  ok(/concatenation/.test(ws[0].message))
})

test('warnings: jsstring-declined when param is reassigned', () => {
  if (belowOpt(2)) return  // jsstring ABI (and its decline advisory) is engaged at optimize >= 2
  const ws = warningsFor(`export let f = (s = '') => { s = s; return s.length }`)
  is(ws.length, 1)
  is(ws[0].code, 'jsstring-declined')
  ok(/reassign/.test(ws[0].message))
})

test('warnings: simd-loop-carried on reduction-style loop', () => {
  if (belowOpt(2)) return  // advisory only emitted when vectorizeLaneLocal runs (optimize >= 2)
  const ws = warningsFor(`
    export let f = (xs) => {
      let s = 0
      for (let i = 0; i < xs.length; i++) s ^= xs[i]
      return s
    }
  `)
  ok(ws.some(w => w.code === 'simd-loop-carried'))
})

test('warnings: simd-aos-stride on interleaved index', () => {
  if (belowOpt(2)) return  // advisory only emitted when vectorizeLaneLocal runs (optimize >= 2)
  const ws = warningsFor(`
    export let f = (a) => {
      for (let i = 0; i < 10; i++) a[i * 3] = 1
      return 0
    }
  `)
  ok(ws.some(w => w.code === 'simd-aos-stride'))
})
