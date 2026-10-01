// Truthiness alone proves no width. A successful checked pop bounds the fast
// copy's pointer by the stack's length, including the later pushes. The original
// fallback keeps its full Number; values are differentials against the host.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { agree, wat, funcWat as funcWatOf } from './util.js'
import { belowOpt } from './_matrix.js'
import parseWat from 'watr/parse'

const funcWat = (text, name) => funcWatOf(text, name) || funcWatOf(text, `${name}$exp`)
// The storage holds once the optimizer ran; every leg runs the differentials.
const storage = (src, name) => {
  if (belowOpt(2)) return null
  const m = new RegExp(`\\(local \\$(?:\\w+_)?${name} (i32|f64)\\)`).exec(funcWat(wat(src), 'f'))
  return m ? m[1] : null
}

const fastWord = src => {
  if (belowOpt(2)) return
  const text = funcWat(wat(src), 'f')
  const words = new Set([...text.matchAll(/\(local (\$[^\s()]*sp(?:\.f\d+)?) i32\)/g)].map(m => m[1]))
  const operations = new Map()
  const scan = (n, inLoop = false) => {
    if (!Array.isArray(n)) return
    inLoop ||= n[0] === 'loop'
    if (inLoop && (n[0] === 'local.set' || n[0] === 'local.tee') && words.has(n[1]) && /^i32\.(?:add|sub)$/.test(n[2]?.[0])) {
      const ops = operations.get(n[1]) ?? operations.set(n[1], new Set()).get(n[1])
      ops.add(n[2][0])
    }
    for (let i = 1; i < n.length; i++) scan(n[i], inLoop)
  }
  scan(parseWat(text))
  ok([...operations.values()].some(ops => ops.has('i32.add') && ops.has('i32.sub')),
    'the guarded traversal pops and pushes through the same i32 pointer')
}

// A worklist over an implicit binary tree of n nodes: every node is visited once.
const WALK = (test) => `export let f = (n) => {
  const stack = new Int32Array(n + 2), seen = new Uint8Array(n)
  let sp = 0, count = 0, sum = 0
  if (n > 0) stack[sp++] = 0
  ${test} {
    const v = stack[--sp]
    if (seen[v]) continue
    seen[v] = 1
    count++
    sum += v
    if (v * 2 + 2 < n) stack[sp++] = v * 2 + 2
    if (v * 2 + 1 < n) stack[sp++] = v * 2 + 1
  }
  return count * 100000 + sum }`

test('tested counter: while (sp) keeps the guarded stack pointer an i32', () => {
  const src = WALK('while (sp)')
  fastWord(src)
  for (const n of [0, -0, 1, 2, 7, 100, 0.5, 2.5, NaN]) agree(src, 'f', [n])
})

test('tested counter: the forms of a truthiness test', () => {
  for (const t of ['while (sp !== 0)', 'while (sp > 0)', 'while (!!sp)', 'while (sp && count < 1000)', 'for (; sp;)']) {
    const src = WALK(t)
    fastWord(src)
    for (const n of [0, 3, 40]) agree(src, 'f', [n])
  }
})

test('tested counter: if, ?: and ! test a countdown', () => {
  const src = `export let f = (n) => {
    const a = new Int32Array(16)
    let left = n | 0, i = 0, s = 0
    for (let k = 0; k < 40; k++) {
      if (left) { a[i & 15] = left; left--; i++ }
      s += (left ? 1 : 2) + (!left ? 10 : 0) + a[k & 15]
    }
    return s }`
  ok(storage(src, 'left') !== 'f64', 'left keeps its i32')
  for (const n of [0, 1, 5, 39, 64]) agree(src, 'f', [n])
})

test('tested counter: a fraction still widens', () => {
  const src = `export let f = (n) => { let x = n; let k = 0; while (x) { x = x > 1 ? x - 1.5 : 0; if (x < 0) x = 0; k++ } return k }`
  ok(storage(src, 'x') !== 'i32', 'x keeps the number')
  for (const n of [0, 1, 3, 4.5, 10]) agree(src, 'f', [n])
})

test('tested counter: a returned accumulator with no test still widens', () => {
  // The bare-escape rule this leaves alone (test/inference.js, the FFT butterfly):
  // an unbounded integer read bare and never governed keeps its magnitude.
  const src = `export let f = (n) => { let id = 1; for (let i = 0; i < n; i++) id *= 100000; return id }`
  for (const n of [0, 1, 2, 3]) agree(src, 'f', [n])
})
