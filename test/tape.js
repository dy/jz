// The IR tape (src/ir/tape.js): a module as parallel typed arrays. The tape
// stage decodes the assembled module after the last WAT-array pass, runs the
// tape passes, and encodes it back for watr; a pass ported to the tape deletes
// its array version. Decode∘encode is the identity on the WAT arrays watr
// reads (op, children, `.type`), the verifier catches a broken link, and the
// constant pool is the first tape pass.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { compile } from '../index.js'
import { T, NONE, resetTape, fromWat, toWat, verify, walk, intern, node, str, push, replace } from '../src/ir/tape.js'
import { hoistConstantPool } from '../src/optimize/const-pool.js'

const same = (a, b) => {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.type === b.type && a.every((x, i) => same(x, b[i]))
  return Object.is(a, b)
}

test('tape: decode then encode is the identity on a WAT module, atoms and `.type` included', () => {
  const body = ['f64.add', ['local.get', '$x'], ['f64.const', 0.5]]
  body.type = 'f64'
  const m = ['module',
    ['global', '$g', ['mut', 'i64'], ['i64.const', 123456789012345678n]],
    ['func', '$f', ['param', '$x', 'f64'], ['result', 'f64'], body, [null, 'lit'], ['f64.const', 'nan:0x8'], ['i32.const', -0]],
    ['@custom', '"jz:i64exp"', true, undefined, null],
  ]
  resetTape()
  const root = fromWat(m)
  is(verify(root), null)
  const back = toWat(root)
  ok(same(m, back), 'structure, atoms and types round-trip')
  is(back[2][4].type, 'f64')
  is(back[1][3][1], 123456789012345678n)
  ok(Object.is(back[2][7][1], -0), 'negative zero survives')
  let n = 0
  walk(root, () => { n++ })
  is(n, T.n, 'every node reached once')
})

test('tape: the verifier catches a broken link and a cycle', () => {
  resetTape()
  const root = fromWat(['module', ['func', '$f', ['nop']]])
  const fn = T.a[root], name = T.a[fn], nop = T.next[name]
  T.next[name] = 999
  ok(/out of range/.test(verify(root)))
  T.next[name] = nop
  T.next[nop] = name
  ok(/cycle/.test(verify(root)))
  T.next[nop] = NONE
  is(verify(root), null)
})

test('tape: replace keeps the child position', () => {
  resetTape()
  const root = fromWat(['i32.add', ['i32.const', 1], ['i32.const', 2], ['i32.const', 3]])
  const kids = []
  for (let c = T.a[root]; c !== NONE; c = T.next[c]) kids.push(c)
  const fresh = node(intern('local.get')); push(fresh, str('$k'))
  replace(root, kids[1], fresh)
  ok(same(toWat(root), ['i32.add', ['i32.const', 1], ['local.get', '$k'], ['i32.const', 3]]))
  replace(root, kids[0], node(intern('nop')))
  ok(same(toWat(root), ['i32.add', ['nop'], ['local.get', '$k'], ['i32.const', 3]]))
  is(verify(root), null)
})

test('const pool on the tape: a literal used twice pools, hottest first, exact bits, functions only', () => {
  const wat = compile(`export let f = (x) => x * 0.041666666666666664 + 0.041666666666666664 * x + 2.5 * x + 2.5 + 2.5`, { wat: true, optimize: 2 })
  ok(/global \$__fc0 f64\n\s+\(f64\.const 2\.5\)/.test(wat), 'the three-use literal takes index 0')
  ok(/global \$__fc1 f64\n\s+\(f64\.const 0\.041666666666666664\)/.test(wat), 'the two-use literal keeps its 17 digits')
  is((wat.match(/\(f64\.const 2\.5\)/g) || []).length, 1, 'only the global initializer carries the literal')
  const one = compile(`export let f = (x) => x * 7.25`, { wat: true, optimize: 2 })
  ok(!/__fc/.test(one), 'a single use is not pooled')
  const off = compile(`export let f = (x) => x * 2.5 + 2.5`, { wat: true, optimize: 3 })
  ok(!/__fc/.test(off), 'the speed tier leaves literals inline')
})

test('const pool on the tape: function bodies only, declaration placement, exact-bit keys', () => {
  const pool = (m) => { resetTape(); const root = fromWat(m); hoistConstantPool(root); is(verify(root), null); return toWat(root) }
  // A global initializer is not a site: it keeps its literal and is not counted.
  const m1 = pool(['module',
    ['global', '$g', ['mut', 'f64'], ['f64.const', 2.5]],
    ['func', '$f', ['drop', ['f64.const', 2.5]], ['drop', ['f64.const', 2.5]]],
  ])
  ok(same(m1, ['module',
    ['global', '$g', ['mut', 'f64'], ['f64.const', 2.5]],
    ['global', '$__fc0', ['mut', 'f64'], ['f64.const', 2.5]],
    ['func', '$f', ['drop', ['global.get', '$__fc0']], ['drop', ['global.get', '$__fc0']]],
  ]), 'the pool global goes after the last global; the initializer literal stays')
  // No globals: the declaration goes before the first function.
  const m2 = pool(['module', ['memory', 1], ['func', '$f', ['drop', ['f64.const', 'nan:0x8']], ['drop', ['f64.const', 'nan:0x8']]]])
  ok(same(m2, ['module', ['memory', 1],
    ['global', '$__fc0', ['mut', 'f64'], ['f64.const', 'nan:0x8']],
    ['func', '$f', ['drop', ['global.get', '$__fc0']], ['drop', ['global.get', '$__fc0']]],
  ]), 'a string literal pools by its text')
  // Keys are the 64 bits: -0 and 0 are distinct values, and so are NaN payloads.
  const m3 = pool(['module', ['func', '$f',
    ['drop', ['f64.const', 0]], ['drop', ['f64.const', -0]], ['drop', ['f64.const', 0]], ['drop', ['f64.const', -0]],
    ['drop', ['f64.const', NaN]], ['drop', ['f64.const', NaN]]]])
  const globals = m3.filter(n => n[0] === 'global')
  is(globals.length, 3, 'three pools: +0, -0, NaN')
  ok(Object.is(globals[0][3][1], 0) && Object.is(globals[1][3][1], -0), 'first-seen order among equal counts, exact signs')
  // A single use and an empty module leave the tape untouched.
  ok(same(pool(['module', ['func', '$f', ['drop', ['f64.const', 1.5]]]]), ['module', ['func', '$f', ['drop', ['f64.const', 1.5]]]]))
  ok(same(pool(['module']), ['module']))
})
