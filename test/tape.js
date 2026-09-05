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
import { arenaRewind } from '../src/optimize/arena-rewind.js'
import { sortLocalsByUse } from '../src/optimize/sort-locals.js'
import { foldLowWordMasks } from '../src/optimize/low-word-mask.js'
import { fold } from '../src/optimize/fold.js'
import { rotateLoops } from '../src/optimize/rotate-loops.js'
import { chainConditions } from '../src/optimize/cond-chains.js'
import { simplifyBoolContexts } from '../src/optimize/bool-contexts.js'
import { vacuum } from '../src/optimize/vacuum.js'
import { mergeBlocks } from '../src/optimize/merge-blocks.js'
import { funcs } from '../src/optimize/fn.js'
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

test('tape: a consuming decode empties the tree it reads; a shared subtree decodes once and copies after', () => {
  resetTape()
  const shared = ['i32.add', ['local.get', '$a'], ['i32.const', 1]]
  const m = ['module', ['func', '$f', ['drop', shared], ['drop', shared]]]
  const root = fromWat(m, true)
  is(verify(root), null, 'a tree, not a graph')
  ok(same(toWat(root), ['module', ['func', '$f', ['drop', ['i32.add', ['local.get', '$a'], ['i32.const', 1]]], ['drop', ['i32.add', ['local.get', '$a'], ['i32.const', 1]]]]]), 'both uses of the shared subtree are on the tape')
  is(m.length, 0, 'the source tree is consumed')
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

test('arena rewind on the tape: save at entry, restore around every return and the fall-through; unsafe callees veto', () => {
  const alloc = ['call', '$__alloc', ['i32.const', 8]]
  const m = ['module',
    ['func', '$helper', ['result', 'i32'], ['call', '$__alloc_hdr', ['i32.const', 1]]],
    ['func', '$f', ['export', '"f"'], ['result', 'f64'], ['local', '$x', 'i32'],
      ['if', ['i32.eqz', ['local.get', '$x']], ['then', ['return', ['f64.const', 1]]]],
      ['drop', ['call', '$helper']],
      ['f64.convert_i32_s', alloc]],
    ['func', '$g', ['result', 'i32'], ['drop', ['call', '$__alloc', ['i32.const', 8]]], ['global.set', '$k', ['i32.const', 1]], ['i32.const', 0]],
    ['func', '$h', ['result', 'i32'], ['call', '$__alloc', ['i32.const', 8]]],
  ]
  const [out] = onTape(m, root => arenaRewind(root, { rewindable: new Map([['$f', 'f64'], ['$g', 'i32']]), heapAddr: null }))
  const save = `$${MARK}heap_save0`, ret = `$${MARK}arena_ret0`
  ok(same(out[2], ['func', '$f', ['export', '"f"'], ['result', 'f64'], ['local', '$x', 'i32'],
    ['local', save, 'i32'], ['local', ret, 'f64'], ['local.set', save, ['global.get', '$__heap']],
    ['if', ['i32.eqz', ['local.get', '$x']], ['then', ['return', ['block', ['result', 'f64'],
      ['local.set', ret, ['f64.const', 1]], ['global.set', '$__heap', ['local.get', save]], ['local.get', ret]]]]],
    ['drop', ['call', '$helper']],
    ['local.set', ret, ['f64.convert_i32_s', alloc]], ['global.set', '$__heap', ['local.get', save]], ['local.get', ret]]),
    'f rewinds: a transitively safe helper is fine')
  ok(same(out[3], m[3]), 'a global.set vetoes')
  ok(same(out[4], m[4]), 'a function the records do not allow is untouched')
  const [shared] = onTape(m, root => arenaRewind(root, { rewindable: new Map([['$f', 'f64']]), heapAddr: 64 }))
  ok(same(shared[2][7], ['local.set', save, ['i32.load', ['i32.const', 64]]]), 'shared memory keeps the heap pointer in memory')
  const commented = ['module', ['func', '$t', ['result', 'i32'], ';; header\n', ['local', '$x', 'i32'], ['call', '$__alloc', ['i32.const', 8]], ';; trailing\n']]
  const [c] = onTape(commented, root => arenaRewind(root, { rewindable: new Map([['$t', 'i32']]), heapAddr: null }))
  ok(same(c[1], ['func', '$t', ['result', 'i32'], ';; header\n', ['local', '$x', 'i32'], ['local', save, 'i32'], ['local', `$${MARK}arena_ret0`, 'i32'], ['local.set', save, ['global.get', '$__heap']],
    ['local.set', `$${MARK}arena_ret0`, ['call', '$__alloc', ['i32.const', 8]]], ['global.set', '$__heap', ['local.get', save]], ['local.get', `$${MARK}arena_ret0`]]), 'comment atoms: transparent in the header, dropped after the last instruction')
})

test('locals sort on the tape: by type under 128 declarations, the hottest in the one-byte zone above; params stay', () => {
  const m = ['module', ['func', '$f', ['export', '"f"'], ['param', '$p', 'f64'], ['local', '$a', 'f64'], ['local', '$b', 'i32'], ['local', '$c', 'v128'], ['local', '$d', 'i32'], ['local.set', '$c', ['local.get', '$c']]]]
  const [out] = onTape(m, root => sortLocalsByUse(root))
  is(out[1].slice(3, 8).map(l => l[1]).join(' '), '$p $b $d $a $c', 'an exported function sorts too')
  const commented = ['module', ['func', '$t', ['local', '$a', 'f64'], ';; a template comment\n', ['local', '$b', 'i32'], ['nop']]]
  const [c] = onTape(commented, root => sortLocalsByUse(root))
  is(c[1].slice(2, 5).map(l => Array.isArray(l) ? l[1] : l).join(' '), '$b ;; a template comment\n $a', 'a comment atom in the header is transparent')
  const many = ['func', '$g', ['result', 'i32']]
  for (let i = 0; i < 130; i++) many.push(['local', `$l${i}`, i % 2 ? 'f64' : 'i32'])
  many.push(['drop', ['local.get', '$l129']], ['drop', ['local.get', '$l129']], ['drop', ['local.get', '$l7']], ['local.get', '$l0'])
  const [big] = onTape(['module', many], root => sortLocalsByUse(root))
  const names = big[1].slice(3, 133).map(l => l[1]), types = big[1].slice(3, 133).map(l => l[2])
  ok(names.indexOf('$l129') < 128 && names.indexOf('$l7') < 128 && names.indexOf('$l0') < 128, 'the used locals take one-byte indices')
  ok(types.slice(0, 128).join('').match(/^(i32)+(f64)+$/) && types.slice(128).join('').match(/^(i32)+(f64)+$|^(i32)+$|^(f64)+$/), 'each side of the boundary groups by type')
})

test('low-word mask fold on the tape', () => {
  const m = ['module', ['func', '$f', ['result', 'i32'],
    ['i32.add', ['i32.wrap_i64', ['i64.and', ['local.get', '$x'], ['i64.const', 0xFFFFFFFF]]],
      ['i32.wrap_i64', ['i64.and', ['local.get', '$y'], ['i64.const', '0xFFFFFFFF']]]],
    ['drop', ['i32.wrap_i64', ['i64.and', ['local.get', '$z'], ['i64.const', 0xFFFF]]]]]]
  const [out] = onTape(m, root => foldLowWordMasks(root))
  ok(same(out[1][3], ['i32.add', ['i32.wrap_i64', ['local.get', '$x']], ['i32.wrap_i64', ['local.get', '$y']]]), 'a full mask under wrap goes, number or text')
  ok(same(out[1][4], m[1][4]), 'a narrower mask stays')
})

// The body passes on the tape (src/optimize: fold, rotate-loops, cond-chains,
// bool-contexts): each takes a function and rewrites it in place.
const body = (mod, pass) => { resetTape(); const root = fromWat(mod); for (const f of funcs(root)) pass(f); is(verify(root), null); return toWat(root) }
const fn = (...stmts) => ['module', ['func', '$f', ['param', '$x', 'i32'], ['param', '$d', 'f64'], ['result', 'i32'], ['local', '$t', 'f64'], ['local', '$u', 'f64'], ...stmts]]
const INF = ['f64.const', Infinity]

test('fold on the tape: a finite value against an infinity or a NaN decides, a select on a constant takes its arm', () => {
  // the guard on a value jz converted itself: `select(v, 0, ne(convert(x), inf))` is v
  const guard = (v) => ['select', v, ['i32.const', 0], ['f64.ne', ['f64.convert_i32_s', ['local.get', '$x']], INF]]
  ok(same(body(fn(guard(['local.get', '$x'])), fold), fn(['local.get', '$x'])), 'a converted i32 is finite')
  // through a local every definition of which is finite
  const viaLocal = fn(['local.set', '$t', ['f64.convert_i32_s', ['local.get', '$x']]], ['select', ['local.get', '$x'], ['i32.const', 0], ['f64.ne', ['local.get', '$t'], INF]])
  ok(same(body(viaLocal, fold), fn(['local.set', '$t', ['f64.convert_i32_s', ['local.get', '$x']]], ['local.get', '$x'])), 'a local defined finite everywhere is finite')
  // a parameter, a local with one non-finite definition, a NaN constant: undecided
  const viaParam = fn(['select', ['local.get', '$x'], ['i32.const', 0], ['f64.ne', ['local.get', '$d'], INF]])
  ok(same(body(viaParam, fold), viaParam), 'a parameter may be anything')
  const mixed = fn(['local.set', '$t', ['f64.convert_i32_s', ['local.get', '$x']]], ['local.set', '$t', ['local.get', '$d']], ['select', ['local.get', '$x'], ['i32.const', 0], ['f64.ne', ['local.get', '$t'], INF]])
  ok(same(body(mixed, fold), mixed), 'one definition of any value keeps the guard')
  ok(same(body(fn(['f64.eq', ['f64.const', 2.5], ['f64.const', 'nan:0x8000000000000']]), fold), fn(['i32.const', 0])), 'eq against a NaN is 0')
  ok(same(body(fn(['i32.eqz', ['i32.const', 0]]), fold), fn(['i32.const', 1])))
  // the dropped arm must be inert
  const effect = fn(['select', ['local.get', '$x'], ['call', '$g'], ['i32.const', 1]])
  ok(same(body(effect, fold), effect), 'an arm with an effect is kept')
})

test('rotate loops on the tape: the top test becomes a guard and a fused back edge', () => {
  const loop = (cond) => ['block', '$brk', ['local.set', '$t', ['f64.const', 1]], ['loop', '$l', ['br_if', '$brk', cond], ['local.set', '$x', ['i32.add', ['local.get', '$x'], ['i32.const', 1]]], ['br', '$l']]]
  const cond = ['i32.ge_s', ['local.get', '$x'], ['i32.const', 10]]
  ok(same(body(fn(loop(cond)), rotateLoops), fn(['block', '$brk', ['local.set', '$t', ['f64.const', 1]], ['br_if', '$brk', cond], ['loop', '$l', ['local.set', '$x', ['i32.add', ['local.get', '$x'], ['i32.const', 1]]], ['br_if', '$l', ['i32.lt_s', ['local.get', '$x'], ['i32.const', 10]]]]])), 'the compare flips for the back edge')
  ok(same(body(fn(loop(['i32.eqz', ['local.get', '$x']])), rotateLoops)[1][7][4][3], ['br_if', '$l', ['local.get', '$x']]), 'an eqz strips')
  ok(same(body(fn(loop(['f64.lt', ['local.get', '$d'], ['f64.const', 1]])), rotateLoops)[1][7][4][3][2], ['i32.eqz', ['f64.lt', ['local.get', '$d'], ['f64.const', 1]]]), 'an f64 compare wraps: NaN')
  const cont = fn(['block', '$brk', ['loop', '$l', ['br_if', '$brk', cond], ['br_if', '$l', ['local.get', '$x']], ['br', '$l']]])
  ok(same(body(cont, rotateLoops), cont), 'a branch to the loop label keeps the top test')
})

test('condition chains on the tape: a diamond in a condition becomes branches, its temp goes', () => {
  const and = ['if', ['result', 'i32'], ['local.tee', '$c', ['local.get', '$x']], ['then', ['local.get', '$y']], ['else', ['local.get', '$c']]]
  const mod = ['module', ['func', '$f', ['param', '$x', 'i32'], ['param', '$y', 'i32'], ['local', '$c', 'i32'], ['if', and, ['then', ['call', '$g']]]]]
  ok(same(body(mod, chainConditions), ['module', ['func', '$f', ['param', '$x', 'i32'], ['param', '$y', 'i32'], ['block', '$__cc0', ['br_if', '$__cc0', ['i32.eqz', ['local.get', '$x']]], ['br_if', '$__cc0', ['i32.eqz', ['local.get', '$y']]], ['call', '$g']]]]), 'A && B: jump-if-false per operand, the tee\'s local dropped')
  const or = ['if', ['result', 'i32'], ['local.tee', '$c', ['local.get', '$x']], ['then', ['local.get', '$c']], ['else', ['local.get', '$y']]]
  const br = ['module', ['func', '$f', ['param', '$x', 'i32'], ['param', '$y', 'i32'], ['local', '$c', 'i32'], ['block', '$out', ['br_if', '$out', or], ['call', '$g']]]]
  ok(same(body(br, chainConditions), ['module', ['func', '$f', ['param', '$x', 'i32'], ['param', '$y', 'i32'], ['block', '$out', ['br_if', '$out', ['local.get', '$x']], ['br_if', '$out', ['local.get', '$y']], ['call', '$g']]]]), 'A || B in a br_if: jump-if-true per operand')
  const kept = ['module', ['func', '$f', ['param', '$x', 'i32'], ['param', '$y', 'i32'], ['local', '$c', 'i32'], ['if', and, ['then', ['call', '$g']]], ['drop', ['local.get', '$c']]]]
  ok(same(body(kept, chainConditions)[1][5], ['block', '$__cc0', ['br_if', '$__cc0', ['i32.eqz', ['local.tee', '$c', ['local.get', '$x']]]], ['br_if', '$__cc0', ['i32.eqz', ['local.get', '$y']]], ['call', '$g']]), 'a temp read elsewhere keeps its tee')
})

test('bool contexts on the tape: `x != 0` and a double eqz strip at a condition, not at a value', () => {
  const mod = fn(['if', ['i32.ne', ['local.get', '$x'], ['i32.const', 0]], ['then', ['nop']]], ['br_if', '$b', ['i32.eqz', ['i32.eqz', ['local.get', '$x']]]], ['i32.ne', ['local.get', '$x'], ['i32.const', 0]])
  ok(same(body(mod, simplifyBoolContexts), fn(['if', ['local.get', '$x'], ['then', ['nop']]], ['br_if', '$b', ['local.get', '$x']], ['i32.ne', ['local.get', '$x'], ['i32.const', 0]])))
})

test('vacuum on the tape: nops, drops of pure values, a tee under a drop, empty if arms', () => {
  const g = ['call', '$g']
  const mod = fn(['nop'], ['drop', ['i32.const', 1]], ['drop', ['i32.sub', ['local.tee', '$x', g], ['i32.const', 1]]], ['drop', ['i32.add', g, g]],
    ['if', ['local.get', '$x'], ['then'], ['else']], ['if', g, ['then'], ['else']], ['if', ['local.get', '$x'], ['then', ['nop']], ['else', g]], ['if', ['local.get', '$x'], ['then', g], ['else']],
    ['select', ['local.get', '$x'], ['local.get', '$x'], ['local.get', '$d']], ['select', g, g, ['local.get', '$x']])
  ok(same(body(mod, vacuum), fn(['local.set', '$x', g], ['block', ['drop', g], ['drop', g]],
    ['drop', g], ['if', ['i32.eqz', ['local.get', '$x']], ['then', g]], ['if', ['local.get', '$x'], ['then', g]],
    ['local.get', '$x'], ['select', g, g, ['local.get', '$x']])))
  // an op with no effect the function can observe leaves no statement; the bare number a
  // missing interned op once produced (a fuzz seed) is the case the `intern` calls guard
  ok(same(body(fn(['if', ['block', ['result', 'i32'], ['local.set', '$t', ['f64.const', 0]], ['i32.const', 1]], ['then'], ['else']]), vacuum), fn(['drop', ['block', ['result', 'i32'], ['local.set', '$t', ['f64.const', 0]], ['i32.const', 1]]])), 'an if with empty arms keeps its condition\'s effect under a drop')
})

test('merge blocks on the tape: a one-statement result block, a consumed result block, an untargeted block', () => {
  const g = ['call', '$g']
  const mod = fn(['drop', ['block', ['result', 'i32'], ['i32.const', 1]]],
    ['local.set', '$x', ['block', '$b', ['result', 'i32'], g, ['local.set', '$t', ['f64.const', 1]], ['i32.const', 2]]],
    ['block', '$c', g, ['block', ['nop']]],
    ['block', '$d', ['br_if', '$d', ['local.get', '$x']], g],
    ['block', '$e', ['result', 'i32'], ['br', '$e', ['i32.const', 3]]])
  ok(same(body(mod, mergeBlocks), fn(['drop', ['i32.const', 1]],
    g, ['local.set', '$t', ['f64.const', 1]], ['local.set', '$x', ['i32.const', 2]],
    g, ['nop'],
    ['block', '$d', ['br_if', '$d', ['local.get', '$x']], g],
    ['block', '$e', ['result', 'i32'], ['br', '$e', ['i32.const', 3]]])))
  const caught = fn(['block', '$h', ['try_table', ['catch_all', '$h'], g]])
  ok(same(body(caught, mergeBlocks), caught), 'a catch clause targets the label')
})

