import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { run, oracle } from './util.js'
import { levels, onKernel } from './_matrix.js'
import { parse, loopCount } from '../scripts/wat-probe.mjs'
import { forCounterBounds, forCounterRange, intExprRange } from '../src/static.js'

const compare = (source, inputs) => {
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const actual = run(source, { optimize }), expected = oracle(source)
    for (const args of inputs) is(actual.f(...args), expected.f(...args), `O${optimize}: ${args.join(', ')}`)
  }
}

test('counter width: square guards preserve their first test before any range theorem holds', () => {
  for (const start of ['65536', '-65536', '4294967296', '-1', '-0', '0.5', 'start']) {
    const source = `export function f(start) {
      let count = 0, last = 19, first = 19
      for (let i = ${start}; i * i < 16; i++) { count++; last = i; if (count === 1) first = i; if (count === 4) break }
      return [count, last, first]
    }`
    compare(source, [[65536], [-65536], [0], [1], [-1], [0.5], [NaN], [Infinity]])
  }
  compare(`export function f(start) {
    let i = start, count = 0
    while (i * i < 16) { count++; i++; if (count === 4) break }
    return [count, i]
  }`, [[65536], [-65536], [0], [1], [-1], [0.5]])
})

test('counter width: canonical square bounds retain strict, inclusive and mirrored edges', () => {
  for (const condition of ['i*i < B', 'i*i <= B', 'B > i*i', 'B >= i*i'])
    for (const bound of [0, 1, 1.0000000000000002, 3.9999999999999996, 4.000000000000001, 15, 16, 17, 1073741824]) {
      const source = `export function f() {
        let count = 0, last = -1
        for (let i = 0; ${condition.replace('B', String(bound))}; i++) { count++; last = i }
        return [count, last]
      }`
      compare(source, [[]])
    }
})

test('counter width: bounded variable steps retain both range and exact iteration sequence', () => {
  const source = `export function f(s, n) {
    const stride = (s & 7) + 1, limit = (n & 31) + 1
    const out = new Int32Array(32)
    let count = 0
    for (let j = 3; j < limit; j += stride) { out[count] = j; count = (count + 1) | 0 }
    return [count, out]
  }`
  compare(source, [-1, 0, 1, 7, 2147483647].flatMap(s => [-1, 0, 1, 3, 31].map(n => [s, n])))
  if (onKernel()) return
  const tree = parse(source, { level: 2, watr: false })
  ok(loopCount(tree, n => n[0] === 'i32.add') > 0, 'the bounded counter retains integer updates')
  is(loopCount(tree, n => n[0] === 'f64.lt'), 0, 'the bound and counter compare as integers')
})

test('counter width: a variable step includes final overshoot and rejects unbounded direction', () => {
  for (const [start, condition, step] of [
    [2147483647, 'j <= 2147483647', 'j += stride'],
    [-2147483648, 'j >= -2147483648', 'j -= stride'],
  ]) compare(`export function f(s) {
    const stride = (s & 3) + 1
    let count = 0, last = 0
    for (let j = ${start}; ${condition}; ${step}) { last = j; if (++count === 3) break }
    return [count, last]
  }`, [[0], [1], [3]])
  compare(`export function f(stride) {
    let count = 0, last = 0
    for (let j = 3; j < 16; j += stride) { last = j; if (++count === 3) break }
    return [count, last]
  }`, [[-1], [0], [0.5], [1], [2147483648], [NaN]])
  for (const update of ['stride = mode ? -2 : 2', 'reset()']) compare(`export function f(mode) {
    let stride = 1, count = 0, last = 0
    const reset = () => { stride = mode ? -2 : 2 }
    for (let j = -2147483648; j < 0; j += stride) { ${update}; last = j; if (++count === 3) break }
    return [count, last]
  }`, [[0], [1]])

})

test('counter width: width bounds never advertise a varying step as an exact stride', () => {
  if (onKernel()) return
  const init = ['let', ['=', 'j', [null, 3]]], cond = ['<', 'j', [null, 32]], step = ['+=', 'j', 'stride']
  const range = n => n === 'stride' ? [1, 8] : Array.isArray(n) && n[0] == null ? [n[1], n[1]] : null
  const bound = forCounterBounds(init, cond, step, 'j', range)
  is(bound.slice(), [3, 31], 'body values follow the guard')
  is(bound.test, [3, 39], 'the final largest step belongs to the lifetime hull')
  is(bound.step, null, 'no exact stride is claimed')
  is(forCounterRange(init, cond, step, 'j', range), null, 'trip-count consumers keep their exact-step contract')
  for (const bad of [[0, 8], [-1, 8], [0.5, 8], [1, Infinity]])
    is(forCounterBounds(init, cond, step, 'j', n => n === 'stride' ? bad : range(n)), null, `${bad} is no positive integer step hull`)
})

const countdown = (kind, init, body = 'out.push(i); if (++count === 4) break') => {
  if (kind === 'for') return `let out = [], count = 0; for (let i = ${init}; i--;) { ${body} }; return out`
  const loop = kind === 'do' ? `do { ${body} } while (--i)` : `while (${kind === 'post' ? 'i--' : '--i'}) { ${body} }`
  return `let out = [], count = 0, i = ${init}; ${loop}; return [out, i]`
}

test('counter width: bounded countdowns include the terminal update and early exit', () => {
  for (const kind of ['pre', 'post', 'for', 'do']) {
    const init = kind === 'post' || kind === 'for' ? 'start & 7' : '(start & 7) + 1'
    const source = `export function f(start) { ${countdown(kind, init)} }`
    compare(source, [[0], [1], [2], [6], [7], [-1]])
    if (!onKernel()) {
      const tree = parse(source, { level: 2, watr: false })
      is(loopCount(tree, n => n[0] === 'f64.sub'), 0, `${kind}: the bounded countdown stays integer`)
    }
  }
})

test('counter width: unknown countdown entries and additional writes retain Number semantics', () => {
  for (const kind of ['pre', 'post', 'for', 'do']) {
    compare(`export function f(start) { ${countdown(kind, 'start')} }`,
      [[0], [-0], [-1], [-2147483648], [2147483647], [2147483648], [4294967296], [0.5], [NaN], [Infinity]])
    for (const write of ['i = start', 'reset()']) compare(`export function f(start) {
      let i = 3, out = [], count = 0; const reset = () => { i = start }
      while (--i) { out.push(i); ${write}; if (++count === 3) break }
      return [out, i]
    }`, [[-2147483648], [4294967296], [0.5], [NaN]])
  }
  for (const value of ['0', '-2147483648']) for (const reset of [`i = ${value}`, `(() => { i = ${value} })()`, `invoke(() => { i = ${value} })`])
    compare(`function invoke(cb) { cb() }
      export function f() {
        let out = [], count = 0
        for (let i = 1, ignored = (${reset}); --i;) { out.push(i); if (++count === 3) break }
        return out
      }`, [[]])
  compare(`export function f(start) {
    let i = 4294967296, first = i, out = []
    for (i = 3; i--;) out.push(i)
    return [first, out, i]
  }`, [[]])
  compare(`export function f(start) {
    let i = 3, out = [], count = 0
    while (--i || start) { out.push(i); if (++count === 5) break }
    return [out, i]
  }`, [[0], [1]])
  compare(`export function f(start) {
    let i = 3, out = []; while (i--) out.push(i)
    while (i--) { out.push(i); if (out.length === 6) break }
    return [out, i]
  }`, [[]])
  compare(`export function f(start) {
    let i = 3, out = []
    for(let pass = 0; pass < 2; pass++) {
      let count = 0; while (i--) { out.push(i); if (++count === 4) break }
    }
    return [out, i]
  }`, [[]])
  compare(`export function f(start) {
    let out = []
    for(let pass = 0; pass < 2; pass++) { let i = (start & 3) + 1; while (--i) out.push(i) }
    return out
  }`, [[0], [1], [3]])
})

test('counter width: same-length typed method chains carry the countdown entry to helpers', () => {
  for (const suffix of ['', '.map(x => x + 1)', '.map(x => x + 1).map(x => x * 2)']) {
    const source = `const a = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8])${suffix}
      function gather(x) { const n = x.length; let i = n >>> 1, out = []; while (--i) out.push(x[i]); return out }
      export function f() { return gather(a) }`
    compare(source, [[]])
    if (!onKernel()) is(loopCount(parse(source, { level: 2, watr: false }), n => n[0] === 'f64.sub'), 0, `${suffix}: the helper receives a fixed positive entry`)
  }
  for (const suffix of ['.filter(x => x > 4)', '.slice(1, 3)', '.subarray(1, 3)', '.toReversed().map(x => x + 1)']) compare(`
    const a = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8])${suffix}
    function gather(x) { const n = x.length; let i = n >>> 1, out = []; while (i--) out.push(x[i]); return [out, i, n] }
    export function f() { return gather(a) }`, [[]])
})


test('counter width: unsigned shift tightens only within one monotone word interval', () => {
  if (onKernel()) return
  for (const [input, shift, expected] of [
    [[64, 64], 1, [32, 32]], [[0, 4294967295], 1, [0, 2147483647]],
    [[2147483648, 4294967295], 0, [2147483648, 4294967295]],
    [[-2147483648, -1], 1, [1073741824, 2147483647]],
    [[-1, 1], 1, [0, 2147483647]], [[-1, 1], 0, null],
    [[0, 4294967296], 1, [0, 2147483647]], [[64, 64], 33, [32, 32]],
  ]) is(intExprRange(['>>>', 'countdown_shift_input', [null, shift]], () => input), expected, `${input} >>> ${shift}`)
})
