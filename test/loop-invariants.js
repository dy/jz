// A declaration in a loop of a Number the loop never changes moves before the loop
// (src/compile/plan/loop-invariants.js). The remainder here has a fast path that branches
// to the runtime, so watr's LICM, which takes pure expression trees, leaves it where it is
// and V8 moves no computation out of a wasm loop. Every form answers what the host answers;
// the reference is the host itself.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, run, wat } from './util.js'

const SPEED = { level: 'speed' }
const SPECIALS = [0, -0, 1, -1, 2.5, 100, 1e-9, -3.75, 1e300, NaN, Infinity, -Infinity]
const CELL = '((h - 1e-9) % 100 + 100) % 100 / 2.5 - 1'
const SWEEP = `export let f = (h, v, n) => {
  let s = 0
  for (let i = 0; i < n; i++) {
    const c = ${CELL}
    const w = c * c + v * (v + 1)
    s += c * i + w
  }
  return s
}\n`

const agrees = (src, name, argsOf) => {
  const host = oracle(src)
  for (const optimize of levels(false, 2, 3, SPEED)) {
    const fns = run(src, { optimize })
    for (const args of argsOf) is(fns[name](...args), host[name](...args), `${name}(${args}) at ${JSON.stringify(optimize)}`)
  }
}
/** Whether the first loop of `text` leaves `op` to the code ahead of it. */
const movedOut = (text, op) => text.slice(0, text.indexOf('(loop')).includes(op) && !text.slice(text.indexOf('(loop')).includes(op)

/** The text of each loop of `text` with no loop in it. */
const innermost = (text) => {
  const out = []
  for (let at = text.indexOf('(loop'); at >= 0; at = text.indexOf('(loop', at + 1)) {
    let depth = 0, end = at
    do { if (text[end] === '(') depth++; else if (text[end] === ')') depth--; end++ } while (depth)
    const body = text.slice(at, end)
    if (body.indexOf('(loop', 1) < 0) out.push(body)
  }
  return out
}

test('loop invariants: a value of what the loop never changes moves ahead of it', () => {
  agrees(SWEEP, 'f', SPECIALS.flatMap(h => [[h, 2, 4], [h, NaN, 3], [h, 2, 0]]))
  if (belowOpt(3)) return
  ok(movedOut(funcWat(wat(SWEEP, { optimize: SPEED }), 'f'), '$__rem'), 'the remainder runs once')
  ok(!movedOut(funcWat(wat(SWEEP, { optimize: { ...SPEED, loopInvariants: false } }), 'f'), '$__rem'), 'and each pass without the pass')
})

test('loop invariants: the value moves out of every loop that leaves it alone', () => {
  const src = `export let f = (a, n) => {
    let s = 0
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const c = a * a % 7 + 1; s += c * j }
    return s
  }\n`
  agrees(src, 'f', SPECIALS.map(a => [a, 3]))
  if (belowOpt(3)) return
  ok(movedOut(funcWat(wat(src, { optimize: SPEED }), 'f'), '$__rem'))
})

test('loop invariants: a value of an outer index stops at the inner loop', () => {
  const src = `export let f = (a, n) => {
    let s = 0
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const c = a * i % 7 + 1; s += c * j }
    return s
  }\n`
  agrees(src, 'f', SPECIALS.map(a => [a, 4]))
  if (belowOpt(3)) return
  const text = funcWat(wat(src, { optimize: SPEED }), 'f')
  ok(innermost(text).length > 0 && innermost(text).every(l => !l.includes('$__rem')), 'out of the inner loop')
  ok(text.lastIndexOf('$__rem') > text.indexOf('(loop'), 'and in the outer one')
})

test('loop invariants: a loop in an arm, under a label, or that runs first', () => {
  const src = `export let arm = (a, b, n) => { let s = 0; if (a > 0) for (let i = 0; i < n; i++) { const c = a * b % 7 + 1; s += c * i } return s }
  export let lab = (a, n) => { let s = 0; outer: for (let i = 0; i < n; i++) { const c = a * a % 7 + 1; for (let j = 0; j < n; j++) { const d = c * a % 5 - 2; if (j > i) continue outer; s += d * j } } return s }
  export let post = (a, n) => { let s = 0, i = 0; do { const c = a * a % 7 + 1; s += c; i++ } while (i < n); return s }\n`
  agrees(src, 'arm', SPECIALS.map(a => [a, 3, 4]))
  agrees(src, 'lab', SPECIALS.map(a => [a, 4]))
  agrees(src, 'post', SPECIALS.flatMap(a => [[a, 0], [a, 5]]))
})

test('loop invariants: a declaration past the end of a pass runs as it did', () => {
  const src = `export let f = (a, n) => {
    let s = 0
    for (let i = 0; i < n; i++) {
      if (i % 2) continue
      const c = a * a % 7 + 1
      if (i > 5) break
      s += c * i
    }
    return s
  }\n`
  agrees(src, 'f', SPECIALS.flatMap(a => [[a, 0], [a, 1], [a, 9]]))
})

test('loop invariants: the moved name leaves a module name of the same spelling alone', () => {
  const src = `const x = 5
  export let f = (a, n) => { let s = 0; for (let i = 0; i < n; i++) { const x = a * a % 7 + 1; s += x } return s + x }\n`
  agrees(src, 'f', [[2, 3], [2, 0], [NaN, 2]])
})

test('loop invariants: what the loop writes stays', () => {
  const src = `export let f = (h, n) => { let s = 0; for (let i = 0; i < n; i++) { const c = h % 7 + 1; s += c; h += 1 } return s }\n`
  agrees(src, 'f', SPECIALS.map(h => [h, 9]))
  if (belowOpt(3)) return
  ok(!movedOut(funcWat(wat(src, { optimize: SPEED }), 'f'), '$__rem'))
})

test('loop invariants: what a closure writes stays, a module binding a call writes too', () => {
  const src = `let m = 1
  const up = () => { m += 1 }
  export let local = (n) => { let k = 1; const bump = () => { k += 1 }; let s = 0; for (let i = 0; i < n; i++) { const c = k * 3 % 7 + 1; bump(); s += c } return s }
  export let mod = (n) => { m = 1; let s = 0; for (let i = 0; i < n; i++) { const c = m * 3 % 7 + 1; up(); s += c } return s }\n`
  agrees(src, 'local', [[0], [1], [9]])
  agrees(src, 'mod', [[0], [1], [9]])
})

test('loop invariants: a value that is no Number stays', () => {
  const src = `export let f = (t, n) => { let s = 0; for (let i = 0; i < n; i++) { const c = t + 1 + 2; s += c.length } return s }\n`
  agrees(src, 'f', [['a', 3], ['abc', 0]])
})

test('loop invariants: a random draw stays in its pass', () => {
  const src = `export let f = (n) => { let hi = -1, lo = 2; for (let i = 0; i < n; i++) { const r = Math.random() * 0.5 + 0.25; if (r > hi) hi = r; if (r < lo) lo = r } return hi - lo }\n`
  for (const optimize of levels(false, 2, 3, SPEED)) ok(run(src, { optimize }).f(64) > 0, 'each pass draws')
})

test('loop invariants: a name written twice, declared twice, or read before its declaration stays', () => {
  const src = `export let twice = (a, n) => { let s = 0; for (let i = 0; i < n; i++) { let c = a * a % 7 + 1; if (i > 1) c = i; s += c } return s }
  export let both = (a, n) => { let s = 0; for (let i = 0; i < n; i++) { const c = a * a % 7 + 1; s += c } for (let i = 0; i < n; i++) { const c = a * a % 5 + 1; s += c } return s }\n`
  agrees(src, 'twice', SPECIALS.map(a => [a, 5]))
  agrees(src, 'both', SPECIALS.map(a => [a, 5]))
})
