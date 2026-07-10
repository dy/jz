/**
 * Cross-function neverGrown for array PARAMS (program-facts.js
 * analyzeParamNeverGrown → paramReps.neverGrown → module/array.js raw-base
 * element reads, no __ptr_offset per read).
 *
 * MEMORY-SAFETY CRITICAL — a wrongly-raw base read through a relocated array
 * corrupts memory, so the fail-closed directions get equal pinning: any
 * possibly-ARRAY growth in the body or a transitive callee, or any escape of
 * the param itself, must keep the forwarding-aware call.
 */
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { run } from './util.js'

const jsEval = (src) => {
  const exports = {}
  new Function('exports', src.replace(/export let (\w+) =/g, 'const $1 = exports.$1 ='))(exports)
  return exports
}

// The word-frequency shape: kernel reads `words[toks[i]]` per token while a
// dictionary receiver takes keyed writes and a clean helper is called.
const KERNEL = (extra = '') => `
const mix = (h, x) => (((h ^ x) * 16777619) | 0)
export let kernel = (words, toks) => {
  let h = 0x811c9dc5 | 0
  const counts = {}
  for (let i = 0; i < toks.length; i++) {
    const w = words[toks[i]]
    counts[w] = (counts[w] | 0) + 1
    h = mix(h, counts[w])
    ${extra}
  }
  return h >>> 0
}
export let main = () => {
  const words = []
  for (let i = 0; i < 16; i++) words.push('w' + i)
  const toks = new Int32Array(64)
  for (let i = 0; i < 64; i++) toks[i] = (i * 7) & 15
  return kernel(words, toks)
}`

test('never-grown: read-only array param reads raw base (no __ptr_offset per read)', () => {
  const src = KERNEL()
  const wat = jz.compile(src, { wat: true, optimize: 'speed' })
  const body = wat.split('(func ').find(c => /^\$kernel\b/.test(c)) || ''
  ok(body, 'kernel emitted')
  const loop = body.slice(body.indexOf('(loop'))
  ok(!/call \$__ptr_offset\b/.test(loop), 'token loop resolves no array base')
  is(run(src, { optimize: 'speed' }).main(), jsEval(src).main(), 'bit-matches plain JS')
})

test('never-grown: fail-closed when the body grows any possibly-array receiver', () => {
  // an indexed write on an untyped (possibly-ARRAY) second param — could grow
  const src = `
export let kernel = (words, out) => {
  let s = 0
  for (let i = 0; i < 8; i++) {
    s = (s + words[i].length) | 0
    out[i] = s
  }
  return s
}
export let main = () => {
  const words = []
  for (let i = 0; i < 8; i++) words.push('w' + i)
  const out = []
  return kernel(words, out) + out.length
}`
  const wat = jz.compile(src, { wat: true, optimize: 'speed' })
  const body = wat.split('(func ').find(c => /^\$kernel\b/.test(c)) || ''
  ok(/call \$__ptr_offset\b|__inl\d/.test(body), 'forwarding-aware base resolution kept')
  is(run(src, { optimize: 'speed' }).main(), jsEval(src).main(), 'value exact')
})

test('never-grown: fail-closed when a transitive callee grows arrays', () => {
  const src = `
const helper = (n) => { sink.push(n); return sink.length }
const sink = []
export let kernel = (words) => {
  let s = 0
  for (let i = 0; i < 8; i++) s = (s + words[i].length + helper(i)) | 0
  return s
}
export let main = () => {
  const words = []
  for (let i = 0; i < 8; i++) words.push('w' + i)
  return kernel(words)
}`
  const wat = jz.compile(src, { wat: true, optimize: 'speed' })
  const body = wat.split('(func ').find(c => /^\$kernel\b/.test(c)) || ''
  ok(/call \$__ptr_offset\b|__inl\d/.test(body), 'callee growth keeps forwarding-aware reads')
  is(run(src, { optimize: 'speed' }).main(), jsEval(src).main(), 'value exact')
})

test('never-grown: fail-closed when the param itself escapes', () => {
  // words leaks into a module global (directly or through the inlined helper)
  // — an alias the activation can't police, so safeReads must disqualify.
  const src = `
let sink2 = null
const grab = (a) => { sink2 = a; return a.length }
export let kernel = (words) => {
  let s = 0
  for (let i = 0; i < words.length; i++) s = (s + words[i].length) | 0
  return s + grab(words)
}
export let main = () => {
  const words = []
  for (let i = 0; i < 8; i++) words.push('w' + i)
  return kernel(words)
}`
  const wat = jz.compile(src, { wat: true, optimize: 'speed' })
  const body = wat.split('(func ').find(c => /^\$kernel\b/.test(c)) || ''
  ok(/call \$__ptr_offset\b|__inl\d/.test(body), 'escaping param keeps forwarding-aware reads')
  is(run(src, { optimize: 'speed' }).main(), jsEval(src).main(), 'value exact')
})
