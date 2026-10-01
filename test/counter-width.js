import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { run, oracle } from './util.js'
import { levels, onKernel } from './_matrix.js'
import { parse, loopCount } from '../scripts/wat-probe.mjs'
import { forCounterBounds, forCounterRange, intExprRange } from '../src/static.js'
import { typedStaticLen } from '../src/type/loop-versioning.js'
import { minAdvanceBudget, maxAdvanceBudget } from '../src/type/canonical-bounds.js'
import { MUTATE_OPS } from '../src/ast.js'
import { scanIntervalIdx } from '../src/type/interval-proof.js'
import { ctx } from '../src/ctx.js'
import { createActiveFunction } from '../src/compile/active-function.js'

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


test('counter width: exact typed constructor identity owns static method-chain lengths', () => {
  compare(`function Float64Array(n) { return { length: n + 1 } }
    export function f() { const a = new Float64Array(4); return a.length }`, [[]])
  if (onKernel()) return
  for (const ctor of ['Array', 'MyArray', 'ArrayBuffer', 'DataView']) {
    const source = ['()', 'new.' + ctor, [null, 4]]
    is(typedStaticLen(source), null, `${ctor}: no typed constructor length`)
    is(typedStaticLen(['()', ['.', source, 'map'], 'callback']), null, `${ctor}: no typed method length`)
  }
  is(typedStaticLen(['()', ['.', ['()', 'new.Float64Array', [null, 4]], 'map'], 'callback']), 4, 'known typed constructor retains its count')
})


test('counter width: interval binding hulls include every stable read and write', () => {
  if (onKernel()) return
  const loop = ['while', ['<', 'i', 4], ['++', 'i']]
  const cases = [
    ['landing', [';', ['let', ['=', 'i', 0]], loop, ['return', 'i']], [0, 7]],
    ['zero work', [';', ['let', ['=', 'i', 5]], loop, ['return', 'i']], [5, 5]],
    ['unknown word producer', [';', ['let', ['=', 'i', ['|', 'unknown', 0]]], ['return', 'i']], [-2147483648, 2147483647]],
    ['late unknown write', [';', ['let', ['=', 'i', 0]], loop, ['=', 'i', 'unknown']], null],
    ['earlier missing read', [';', ['return', 'i'], ['let', ['=', 'i', 0]], loop], null],
    ['bare declaration', [';', ['let', 'i'], ['=', 'i', 0], loop], null],
    ['conditional initializer', [';', ['if', 'flag', ['let', ['=', 'i', 0]]], ['return', 'i']], null],
    ['conditional receiver', [';', ['if', 'flag', ['let', ['=', 'i', 0]]], ['[]', 'i', 0]], null],
    ['unknown step', [';', ['let', ['=', 'i', 0]], ['while', ['<', 'i', 4], ['+=', 'i', 'step']]], null],
    ['overflowing final update', [';', ['let', ['=', 'i', 2147483647]], ['while', ['<=', 'i', 2147483647], ['++', 'i']]], null],
    ['captured write', [';', ['let', ['=', 'i', 0]], ['=>', [], ['=', 'i', 1.5]], loop], null],
    ['unknown destructured write', [';', ['let', ['=', 'i', 0]], ['=', ['[', 'i'], 'unknown']], null],
    ['exceptional exit', [';', ['let', ['=', 'i', 0]], ['catch', [';', ['=', 'i', 2], ['()', 'call']], [';', ['return', 'i']]]], null],
  ]
  for (const [name, body, expected] of cases) {
    const prior = ctx.func, bindings = new Map([['i', undefined]])
    ctx.func = createActiveFunction({ body })
    try { scanIntervalIdx(body, null, () => null, null, null, null, null, null, bindings) }
    finally { ctx.func = prior }
    is(bindings.get('i'), expected, name)
  }
})

test('counter width: bounded while lifetimes retain integer storage before loop optimization', () => {
  for (const limit of [0, 1, 31, 64]) {
    const source = `export function f(stop) {
      let i = 0, sum = 0
      while (i < ${limit}) { if (i === stop) break; sum = (sum + i) | 0; i++ }
      return [sum, i]
    }`
    compare(source, [[-1], [0], [1], [30], [64]])
    if (!onKernel()) {
      const tree = parse(source, { level: 2, watr: false })
      is(loopCount(tree, n => n[0] === 'f64.add'), 0, `${limit}: the full counter stays integer`)
      is(loopCount(tree, n => n[0] === 'f64.lt'), 0, `${limit}: the loop test stays integer`)
    }
  }
})

test('counter width: lifetime hulls reject overflow, missing entries and conditional wide writes', () => {
  compare(`export function f(step, mode) {
    let i = 2147483646, count = 0
    while (i <= 2147483647) { i += step; if (mode) i = 4294967296; if (++count === 3) break }
    return [i, count]
  }`, [[0, 0], [1, 0], [2, 0], [0.5, 0], [NaN, 0], [1, 1]])
  compare(`export function f(mode) {
    if (mode) var i = 0
    while (i < 4) i++
    return [i, 1 / i]
  }`, [[0], [1], [1], [0]])
  compare(`export function f(mode) {
    let i = 0
    while (i < 4) { if (mode) { i = -0; break } i++ }
    return [i, 1 / i]
  }`, [[0], [1], [1], [0]])
})


test('counter width: guarded ring copies prove full cursor lifetime and preserve fallback inputs', () => {
  const source = `export function f(start, count, offset, limit) {
    const a = new Float64Array([2, 3, 5, 7, 11, 13, 17, 19])
    let idx = start, N = count, off = offset, sum = 0, seen = 0
    for (let k = 0; k < N; k++) {
      sum += a[idx + off]
      idx = idx === 0 ? N - 1 : idx - 1
      if (++seen === limit) break
    }
    return [sum, idx, seen, 1 / idx]
  }`
  compare(source, [
    [0, 4, 0, 4], [4, 3, -1, 3], [0, 0, 0, 3], [0, -1, 0, 3],
    [-1, 3, 0, 3], [-2147483648, 3, 0, 3], [2147483647, 3, 0, 3],
    [0, -2147483648, 0, 3], [0, 2147483647, 0, 3], [0, 2147483648, 0, 3],
    [0.5, 4, 0, 3], [0, 3.5, 0, 3], [NaN, 4, 0, 3], [0, NaN, 0, 3],
    [-0, 3, 0, 3], [-0, 0, 0, 3], [0, 4, -2147483648, 3], [0, 4, 2147483647, 3],
  ])
})

test('counter width: guarded words preserve mutation order and object coercion on zero work', () => {
  const source = `export function f(n) {
    let calls = 0, index = 0
    const key = { valueOf() { calls++; return index++ } }
    const a = new Float64Array([2, 3, 5, 7])
    let cursor = key, N = n, sum = 0
    for (let k = 0; k < N; k++) { sum += a[cursor]; cursor = cursor === 0 ? N - 1 : cursor - 1 }
    return [sum, calls, index]
  }`
  compare(source, [[0], [1], [2], [4], [0]])
  compare(`export function f(mode) {
    const a = new Float64Array([2, 3, 5, 7])
    let cursor = 0, N = 4, sum = 0
    for (let k = 0; k < N; k++) {
      sum += a[cursor]
      cursor = cursor === 0 ? N - 1 : cursor - 1
      if (mode) { N = 4294967296; cursor = -2147483648 }
      if (k === 2) break
    }
    return [sum, cursor, N]
  }`, [[0], [1]])
})


test('counter width: companion while cursors need progress on every continuing path', () => {
  const options = { constInt: x => typeof x === 'number' ? x : null,
    evRange: x => typeof x === 'number' ? [x, x] : null, closureWrites: new Set(), MUTATE_OPS }
  const cases = [
    ['unit', ['++', 'i'], 1],
    ['sequence', [';', ['++', 'i'], ['+=', 'i', 2]], 3],
    ['branches', ['if', 'mode', ['++', 'i'], ['+=', 'i', 2]], 1],
    ['conditional skip', ['if', 'mode', ['++', 'i']], 0],
    ['short circuit', ['&&', 'mode', ['++', 'i']], 0],
    ['nullish skip', ['??', 'mode', ['++', 'i']], 0],
    ['optional call', ['?.()', 'fn', ['++', 'i']], null],
    ['optional key', ['?.[]', 'obj', ['++', 'i']], null],
    ['continued optional call', ['()', ['?.', 'obj', 'fn'], ['++', 'i']], null],
    ['continued optional key', ['[]', ['?.', 'obj', 'a'], ['++', 'i']], null],
    ['continue skips progress', [';', ['if', 'mode', ['continue']], ['++', 'i']], null],
    ['break', [';', ['++', 'i'], ['break']], null],
    ['nested loop', ['while', 'mode', ['++', 'i']], null],
    ['decrement', ['--', 'i'], null],
    ['unknown write', ['=', 'i', 'mode'], null],
  ]
  for (const [label, body, want] of cases)
    is(minAdvanceBudget(body, 'i', options), want, label)
  is(maxAdvanceBudget(['??', 'mode', ['++', 'i']], 'i', options), 1, 'optional advance still contributes to the upper budget')

  const trial = (advance, start = 0, bound = 4, before = null) => {
    const read = ['[]', 'a', ['postfix', ['++', 'op']]]
    const body = [';', ['let', ['=', 'ip', 0], ['=', 'op', start]],
      ['while', ['<', 'ip', bound], [';', ...(before ? [before] : []), read, advance]]]
    const proven = new Set(), hulls = new Map([['op', undefined]])
    const prior = ctx.func
    ctx.func = createActiveFunction({ body })
    try { scanIntervalIdx(body, proven, name => name === 'a' ? 4 : null, null, null, null, null, null, hulls) }
    finally { ctx.func = prior }
    return { hit: proven.has(read), hull: hulls.get('op') }
  }
  is(trial(['++', 'ip']), { hit: true, hull: [0, 4] }, 'post-increment read excludes the final landing')
  const consts = ctx.scope.consts, constInts = ctx.scope.constInts, globals = ctx.scope.globalTypes
  try {
    ctx.scope.consts = new Set(['BOUND'])
    ctx.scope.constInts = new Map([['BOUND', 4]])
    ctx.scope.globalTypes = new Map([['BOUND', 'i32']])
    is(trial(['++', 'ip'], 0, 'BOUND'), { hit: true, hull: [0, 4] }, 'an immutable module bound remains stable')
  } finally { ctx.scope.consts = consts; ctx.scope.constInts = constInts; ctx.scope.globalTypes = globals }
  is(trial(['if', 'mode', ['++', 'ip'], ['++', 'ip']]), { hit: true, hull: [0, 4] }, 'both arms make progress')
  is(trial(['if', 'mode', ['++', 'ip']]), { hit: false, hull: null }, 'one skipped step removes the finite trip budget')
  is(trial(['++', 'ip'], 2147483647), { hit: false, hull: null }, 'final landing outside int32 rejects narrowing')
  is(trial(['++', 'ip'], -0), { hit: false, hull: null }, 'initial negative zero remains observable')
  is(trial(['++', 'ip'], 0, 4, ['if', 'mode', ['continue']]), { hit: false, hull: null }, 'continue cannot hide unbounded companion advances')
})

test('counter width: bounded companion while cursors preserve outputs and final values', () => {
  for (const bound of [0, 1, 4, 5]) for (const start of ['0', '-0', '2147483647']) {
    const source = `export function f(mode) {
      const a = new Uint8Array([3, 5, 7, 11]), out = new Uint8Array(4)
      let ip = 0, op = ${start}, first = 1 / op
      while (ip < ${bound}) {
        out[op++] = a[ip]
        if (mode) ip++; else ip++
      }
      return [out.join(), ip, op, first]
    }`
    compare(source, [[0], [0], [1], [0]])
  }
  // The first loop can skip its tested advance. The second must not inherit
  // its companion's rejected range, and each invocation starts fresh.
  compare(`export function f(mode) {
    const a = new Uint8Array([3, 5, 7, 11]), out = new Uint8Array(8)
    let ip = 0, op = 0
    while (ip < 4) { out[op++] = a[ip]; if (mode || op > 4) ip++ }
    let tail = op
    while (ip < 6) { tail++; ip++ }
    return [out.join(), ip, op, tail]
  }`, [[0], [0], [1], [0]])
})

test('counter width: loop budgets cannot hide writes through module bindings', () => {
  const prior = ctx.func, globals = ctx.scope.globalTypes
  try {
    for (const global of ['ip', 'op']) {
      const read = ['[]', 'a', ['postfix', ['++', 'op']]]
      const body = [';', ['=', 'ip', 0], ['=', 'op', 0],
        ['while', ['<', 'ip', 4], [';', read, ['()', 'mutate', null], ['++', 'ip']]]]
      ctx.func = createActiveFunction({ body })
      ctx.scope.globalTypes = new Map([[global, 'f64']])
      const proven = new Set(), hulls = new Map([['op', undefined]])
      scanIntervalIdx(body, proven, name => name === 'a' ? 4 : null, null, null, null, null, null, hulls)
      ok(!proven.has(read), `${global}: the call can invalidate the trip or cursor budget`)
      is(hulls.get('op'), null, 'the complete lifetime remains unknown')
    }
  } finally { ctx.func = prior; ctx.scope.globalTypes = globals }

  for (const head of ['while (ip < 4)', 'for (; ip < 4;)']) compare(`
    let ip = 0, calls = 0
    function mutate() { if (++calls < 8) ip = 0 }
    export function f() {
      ip = 0; calls = 0
      const a = new Uint8Array([3, 5, 7, 11]); let op = 0, sum = 0
      ${head} { sum += a[op++]; mutate(); ip++ }
      return [sum, ip, op, calls]
    }`, [[], [], []])
  compare(`let op = 0
    function mutate() { op = 4294967296 }
    export function f() {
      op = 0; let ip = 0, sum = 0
      const a = new Uint8Array([3, 5, 7, 11])
      while (ip < 4) { sum += a[op++]; mutate(); ip++ }
      return [sum, ip, op]
    }`, [[], [], []])
  for (const head of ['while (ip < bound)', 'for (; ip < bound;)']) compare(`let bound = 4
    function mutate() { bound = 8 }
    export function f() {
      bound = 4; let ip = 0, sum = 0
      const a = new Uint8Array([3, 5, 7, 11])
      ${head} { sum += a[ip]; mutate(); ip++ }
      return [sum, ip]
    }`, [[], [], []])
})
