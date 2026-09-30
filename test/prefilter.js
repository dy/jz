// Prefilter (vectorize/prefilter.js): a scan loop's first test runs on a whole
// span of lanes; spans where no lane holds are stepped over, and the loop's own
// statement runs from the first lane that holds to the end of its span.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { compile as compileWat } from 'watr'
import { tryPrefilter } from '../src/optimize/vectorize/prefilter.js'
import { levels } from './_matrix.js'
import { agree, wat } from './util.js'

const scans = src => /\.bitmask/.test(wat(src, { optimize: 3 }))
const check = (src, args, name) => {
  for (const optimize of levels(0, 2, 3, 'size')) agree(src, 'f', args, { optimize }, `${name} at ${optimize}`)
}

// `density` marks every density-th element; the walk behind the guard is the heavy work.
const scan = ({ ctor = 'Uint8Array', mark = 1, guard = 'a[i] === 1 && a[i - 1] === 0', work = '', from = 1 }) => `const N = 700
const walk = (a, i, n) => {
  let s = 0
  for (let k = i; k < n && k < i + 5; k++) s = (s * 31 + a[k] + k) | 0
  return s
}
export let f = (density, n) => {
  const a = new ${ctor}(N)
  for (let i = 0; i < N; i++) a[i] = density > 0 && i % density === 0 ? ${mark} : 0
  let h = 0
  for (let i = ${from}; i < n; i++) {
    if (${guard}) {
      h = (h * 33 + walk(a, i, n)) | 0
      ${work}
    }
  }
  for (let i = 0; i < N; i++) h = (h * 31 + a[i]) | 0
  return h
}`

const SIZES = [0, 1, 2, 15, 16, 17, 18, 32, 33, 47, 100, 699, 700]
const DENSITIES = [0, 1, 2, 3, 16, 17, 97]

test('prefilter: skipped spans retain the saved false predicate', () => {
  const build = vector => {
    const get = name => ['local.get', name], num = n => ['i32.const', n]
    const stmt = ['if', ['if', ['result', 'i32'],
      ['local.tee', '$saved', ['i32.eq', ['i32.load8_u', get('$i')], num(1)]],
      ['then', num(1)], ['else', get('$saved')]], ['then', ['call', '$work']]]
    const loop = ['block', '$done', ['loop', '$loop',
      ['br_if', '$done', ['i32.ge_s', get('$i'), get('$n')]], stmt,
      ['local.set', '$i', ['i32.add', get('$i'), num(1)]], ['br', '$loop']]]
    const lifted = vector ? tryPrefilter({ incVar: '$i', bound: get('$n'), boundLocal: '$n', body: [stmt], preamble: [], blockNode: loop }, new Map(), { next: 0 }) : null
    if (vector) ok(lifted, 'the saved-predicate form is recognized')
    const module = ['module', ['memory', ['export', '"memory"'], '1'], ['func', '$work'],
      ['func', '$f', ['export', '"f"'], ['param', '$n', 'i32'], ['result', 'i32'],
        ['local', '$i', 'i32'], ['local', '$saved', 'i32'], ...(lifted?.newLocalDecls ?? []),
        ['local.set', '$saved', num(77)], lifted?.wrapper ?? loop, get('$saved')]]
    return new WebAssembly.Instance(new WebAssembly.Module(compileWat(module))).exports
  }
  const scalar = build(false), vector = build(true)
  for (const marks of [[], [0], [15], [16], [31], [0, 16, 32]]) {
    for (const instance of [scalar, vector]) {
      const bytes = new Uint8Array(instance.memory.buffer)
      bytes.fill(0)
      for (const i of marks) bytes[i] = 1
    }
    for (const n of [0, 1, 15, 16, 17, 32, 33]) is(vector.f(n), scalar.f(n), `${marks}: n=${n}`)
  }
})

test('prefilter: a sparse byte guard over heavy work scans by spans', () => {
  const src = scan({})
  ok(scans(src), 'the first test runs on lanes')
  for (const d of DENSITIES) for (const n of SIZES) check(src, [d, n], `bytes(${d}, ${n})`)
})

test('prefilter: work that marks elements ahead is seen as the scalar loop sees it', () => {
  // The body marks the next element (the same span) and one forty ahead (a later span).
  const src = scan({ guard: 'a[i] === 1', work: 'if (i + 1 < N) a[i + 1] = 1 - a[i + 1]; if (i + 40 < N) a[i + 40] = 1', from: 0 })
  ok(scans(src), 'the first test runs on lanes')
  for (const d of [0, 1, 5, 16, 97, 300]) for (const n of [0, 16, 17, 100, 700]) check(src, [d, n], `marking(${d}, ${n})`)
})

test('prefilter: signed and wider elements, ordered and bare tests', () => {
  const cases = [
    { ctor: 'Int8Array', mark: -7, guard: 'a[i] === -7 && i > 2', from: 0 },
    { ctor: 'Int8Array', mark: -7, guard: 'a[i] < -3 && i > 2', from: 0 },
    { ctor: 'Uint8Array', mark: 200, guard: 'a[i] > 100 && i > 2', from: 0 },
    { ctor: 'Uint16Array', mark: 40000, guard: 'a[i] >= 40000 && i > 2', from: 0 },
    { ctor: 'Int16Array', mark: -300, guard: 'a[i] !== 0 && i > 2', from: 0 },
    { ctor: 'Int32Array', mark: -100000, guard: 'a[i] === -100000 && i > 2', from: 0 },
    { ctor: 'Uint8Array', mark: 9, guard: 'a[i] && i > 2', from: 0 },
    { ctor: 'Uint8Array', mark: 9, guard: '3 < a[i] && i > 2', from: 0 },
  ]
  for (const c of cases) {
    const src = scan(c)
    ok(scans(src), `${c.ctor} ${c.guard} runs on lanes`)
    for (const d of [0, 1, 7, 64]) for (const n of [0, 5, 16, 33, 700]) check(src, [d, n], `${c.ctor} ${c.guard} (${d}, ${n})`)
  }
})

test('prefilter: light work, a break, or a written counter keeps the scalar loop', () => {
  const light = `export let f = (density, n) => {
  const a = new Uint8Array(700)
  for (let i = 0; i < 700; i++) a[i] = density > 0 && i % density === 0 ? 1 : 0
  let h = 0
  for (let i = 1; i < n; i++) if (a[i] === 1 && a[i - 1] === 0) h = (h * 33 + i) | 0
  return h
}`
  ok(!scans(light), 'an update is not heavy work')
  for (const d of [0, 1, 7]) for (const n of [0, 17, 700]) check(light, [d, n], `light(${d}, ${n})`)
  const breaks = scan({ guard: 'a[i] === 1', work: 'if (h === 12345) break', from: 0 })
  ok(!scans(breaks), 'a break leaves the loop from inside the work')
  for (const d of [0, 3, 97]) for (const n of [0, 17, 700]) check(breaks, [d, n], `break(${d}, ${n})`)
  const skips = scan({ guard: 'a[i] === 1', work: 'i += 2', from: 0 })
  ok(!scans(skips), 'the work moves the counter')
  for (const d of [0, 3, 97]) for (const n of [0, 17, 700]) check(skips, [d, n], `skip(${d}, ${n})`)
})
