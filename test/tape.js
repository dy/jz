// The IR tape (src/ir/tape.js): a module as parallel typed arrays. Link
// (src/link) decodes the assembled module onto it, runs the whole-module
// passes, and encodes it back for watr; a pass ported to the tape deletes its
// array version. Decode∘encode is the identity on the WAT arrays watr reads
// (op, children, `.type`, `.schemaSid`), the verifier catches a broken link,
// and each link pass has its direct test here.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { compile } from '../index.js'
import { T, NONE, resetTape, fromWat, toWat, verify, walk, intern, node, str, push, replace } from '../src/ir/tape.js'
import { hoistConstantPool } from '../src/optimize/const-pool.js'
import { treeshake } from '../src/link/treeshake.js'
import { orderFuncs } from '../src/link/order.js'
import { pruneUnusedThrowRuntime } from '../src/link/throw-runtime.js'
import { stripLocalRenameSuffixes } from '../src/link/rename-locals.js'
import { schemaSections } from '../src/link/sections.js'
import { T as MARK } from '../src/ast.js'

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
  const tagged = ['i32.const', 3]; tagged.schemaSid = 4
  const blob = ['module', ['@custom', '"jz:schema"', [12, 0, 255]], ['func', '$f', ['drop', tagged]]]
  resetTape()
  const b2 = toWat(fromWat(blob))
  ok(same(blob, b2) && b2[1][2][0] === 12 && b2[2][2][1].schemaSid === 4, 'a byte blob is one atom, a schema id is a column')
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

const onTape = (m, f) => { resetTape(); const root = fromWat(m); const r = f(root); is(verify(root), null); return [toWat(root), r] }
const names = (m) => m.filter(n => n[0] === 'func').map(n => n[1])

test('link: treeshake keeps what a root reaches, drops the rest, counts calls from reachable code', () => {
  const m = ['module',
    ['global', '$__dead', ['mut', 'i32'], ['i32.const', 0]],
    ['global', '$__a', ['mut', 'i32'], ['global.get', '$__b']],
    ['global', '$__b', ['mut', 'i32'], ['i32.const', 1]],
    ['global', '$__c', ['mut', 'i32'], ['i32.const', 2]],
    ['func', '$__rt', ['call', '$__leaf']],
    ['func', '$__leaf', ['drop', ['global.get', '$__a']]],
    ['func', '$__orphan', ['call', '$__leaf'], ['drop', ['global.get', '$__dead']]],
    ['func', '$main', ['export', '"main"'], ['call', '$__rt'], ['call', '$__leaf']],
    ['func', '$viaStart', ['drop', ['global.get', '$__c']]],
    ['func', '$viaElem', ['nop']],
    ['func', '$viaRef', ['nop']],
    ['func', '$refs', ['export', '"refs"'], ['drop', ['ref.func', '$viaRef']]],
    ['elem', ['i32.const', 0], 'func', '$viaElem'],
    ['start', '$viaStart'],
  ]
  const [out, calls] = onTape(m, root => treeshake(root, { removeDead: true }))
  is(names(out).join(' '), '$__rt $__leaf $main $viaStart $viaElem $viaRef $refs', 'orphan gone; export, start, elem and ref.func are roots')
  is(out.filter(n => n[0] === 'global').map(n => n[1]).join(' '), '$__a $__b $__c', 'a global read only by a dead function goes; one read by a live initializer stays')
  is(calls.get('$__leaf'), 2, 'calls from the orphan are not counted')
  is(calls.get('$__rt'), 1)
  const [kept] = onTape(m, root => treeshake(root, { removeDead: false, userFuncs: new Set(['$main', '$refs']), userGlobals: new Set() }))
  is(names(kept).join(' '), '$__rt $__leaf $main $viaStart $viaElem $viaRef $refs', 'with removal off a dead runtime function still goes')
})

test('link: functions order by call count, runtime ties by name, user functions keep source order', () => {
  const m = ['module', ['memory', 1],
    ['func', '$__z', ['nop']], ['func', '$__a', ['nop']], ['func', '$user2', ['nop']], ['func', '$user1', ['nop']], ['func', '$hot', ['nop']],
    ['elem', ['i32.const', 0], 'func', '$hot'],
  ]
  const [out] = onTape(m, root => orderFuncs(root, new Map([['$hot', 5], ['$user2', 1], ['$user1', 1]])))
  is(names(out).join(' '), '$hot $user2 $user1 $__a $__z')
  is(out[1][0], 'memory'); is(out.at(-1)[0], 'elem', 'the functions stay between memory and elem')
})

test('link: the throw runtime goes when nothing can catch; a catch anywhere keeps it', () => {
  const m = ['module', ['tag', '$__jz_err', ['param', 'f64']],
    ['func', '$f', ['global.set', '$__jz_last_err_bits', ['i64.const', 7]], ['throw', '$__jz_err', ['f64.const', 1]]]]
  const [out] = onTape(m, root => pruneUnusedThrowRuntime(root, { throws: true, userThrows: false, noEhAbort: false, rawAbi: false }))
  ok(same(out, ['module', ['func', '$f', ['global.set', '$__jz_last_err_bits', ['i64.const', 7]], ['unreachable']]]), 'throw → unreachable, tag gone, the carrier store stays')
  const [raw] = onTape(m, root => pruneUnusedThrowRuntime(root, { throws: true, userThrows: false, noEhAbort: false, rawAbi: true }))
  ok(same(raw[1][2], ['drop', ['i64.const', 7]]), 'the raw ABI drops the carrier store')
  const caught = ['module', ['tag', '$__jz_err', ['param', 'f64']], ['func', '$g', ['try_table', ['catch', '$__jz_err', 0], ['nop']]], ...m.slice(2)]
  const [keep] = onTape(caught, root => pruneUnusedThrowRuntime(root, { throws: true, userThrows: false, noEhAbort: false, rawAbi: false }))
  ok(same(keep, caught), 'a catch in another function keeps every throw')
  const [user] = onTape(m, root => pruneUnusedThrowRuntime(root, { throws: true, userThrows: true, noEhAbort: false, rawAbi: false }))
  ok(same(user, m), 'a user throw keeps the runtime')
})

test('link: scope suffixes strip when the bare name is unambiguous in its function', () => {
  const x1 = `$x${MARK}f3_1`, x2 = `$x${MARK}f3_2`, y1 = `$y${MARK}f3_1`
  const m = ['module', ['func', '$f', ['local', x1, 'i32'], ['local', x2, 'i32'], ['local', y1, 'f64'], ['local.set', y1, ['f64.const', 1]], ['drop', ['local.get', x1]]],
    ['func', '$g', ['param', y1, 'f64'], ['local', '$y', 'f64'], ['drop', ['local.get', y1]]]]
  const [out] = onTape(m, root => stripLocalRenameSuffixes(root))
  ok(same(out[1], ['func', '$f', ['local', x1, 'i32'], ['local', x2, 'i32'], ['local', '$y', 'f64'], ['local.set', '$y', ['f64.const', 1]], ['drop', ['local.get', x1]]]), 'two x declarations keep their suffixes, the lone y loses its')
  ok(same(out[2], m[2]), 'a declared bare name blocks the strip')
})

test('link: the schema section lists only surviving schemas, by tag or by named use', () => {
  const tagged = ['i32.const', 1]; tagged.schemaSid = 1
  const m = ['module', ['func', '$f', ['export', '"f"'], ['drop', tagged]], ['func', '$mk', ['nop']]]
  const facts = { schemas: [['a'], [null, ['t', 'b']], ['c']], namedUses: [{ sid: 2, funcName: 'mk' }, { sid: 0, funcName: 'gone' }], errorSids: [[1, 'RangeError'], [0, 'TypeError']] }
  const [out] = onTape(m, root => schemaSections(root, facts))
  const schema = out.find(n => n[0] === '@custom' && n[1] === '"jz:schema"')[2]
  is(schema.join(','), [3, 1, 2, 1, 48, 2, 0, 1, 2, 1, 98, 1, 2, 1, 99].join(','), 'schema 0 shrinks to its id, 1 is tagged, 2 is used by name')
  is(out.find(n => n[0] === '@custom' && n[1] === '"jz:errcls"')[2].join(','), [1, 1, 10, 82, 97, 110, 103, 101, 69, 114, 114, 111, 114].join(','), 'only the surviving error class')
})
