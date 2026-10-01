import test from 'tst'
import { is, throws } from 'tst/assert.js'
import { summarize, K, kind, join, hasTag, CARRIER, PRESENCE, contractVal } from '../src/summary/index.js'
import { VAL } from '../src/reps.js'
import { compile, _compileInProcess } from '../index.js'
import { ctx } from '../src/ctx.js'
import { instantiate } from '../interop.js'
import { execFileSync } from 'node:child_process'
import { onKernel, levels } from './_matrix.js'
import { BRAND } from '../src/ast.js'
import { oracle } from './util.js'

const lit = value => [null, value]
const typed = ['()', 'new.BigInt64Array', lit(0)]
const reduce = (callback, initial) => ['()', ['.', typed, 'reduce'], [',', callback, initial]]

test('summary queries: internal readers leave complete cached public views across repeated summaries', () => {
  let retained
  for (const value of [7, 7, 'changed', 7]) {
    const summary = summarize(['const', ['=', 'value', lit(value)]], {
      funcs: [
        { name: 'scale', sig: { params: [{ name: 'value' }] }, body: ['*', 'value', lit(2)] },
        { name: 'mixed', sig: { params: [{ name: 'value' }, { name: 'take' }] }, body: ['?:', 'take', lit(9n), 'value'] },
        { name: 'through', sig: { params: [{ name: 'value' }, { name: 'take' }] }, body: ['()', 'mixed', [',', 'value', 'take']] },
      ], schemas: [], brandOf: () => null, imports: new Map(), exported: () => true,
    })
    const q = summary.at('scale')
    is(q === summary.at('scale'), true, 'a scope reuses its completed view')
    is(q.numericDemand('value'), true, 'the internal demand reader keeps the parameter separate from the module binding')
    is(q.paramKindOf('value'), kind(K.NUMBER), 'the public view exposes the settled incoming parameter kind')
    is(summary.kindOf('value'), kind(typeof value === 'number' ? K.NUMBER : K.STRING), 'the module view retains its own binding')
    is(summary.resultContract('mixed').carrier, CARRIER.BOXED, 'the internal key reader preserves a BigInt beside an unknown result')
    is(summary.resultContract('through').carrier, CARRIER.BOXED, 'the internal callee reader propagates the BigInt result contract')
    q.alias('temporary', lit(true))
    is(q.kindOf('temporary'), kind(K.BOOL), 'public alias operations remain available')
    q.unalias('temporary')
    is(q.kindOf('temporary'), K.NONE, 'temporary aliases do not survive their scope')
    retained ??= summary
    is(retained.kindOf('value'), kind(K.NUMBER), 'later summaries leave retained public readers unchanged')
  }
  is(summarize(null, { funcs: [], schemas: [], brandOf: () => null, imports: new Map(), exported: () => false }).kindOf('value'), K.NONE, 'an empty summary has no stale view')
  is(retained.kindOf('value'), kind(K.NUMBER), 'empty work does not alter the retained view')
})

test('summary queries: single names and shared variants keep scoped and unscoped facts', () => {
  const values = [7, 'changed', true], tags = [K.NUMBER, K.STRING, K.BOOL]
  let retained
  for (const count of [1, 1, 3, 0, 1]) {
    const funcs = values.slice(0, count).map((value, i) => ({ name: 'fn' + i, sig: { params: [] },
      body: ['{}', [';', ['const', ['=', 'shared', lit(value)]], ['return', 'shared']]] }))
    const q = summarize(null, { funcs, schemas: [], brandOf: () => null, imports: new Map(), exported: () => true })
    is(q.kindOf('shared'), tags.slice(0, count).reduce((k, t) => join(k, kind(t)), K.NONE),
      'unscoped reads join every existing variant, including the first binding id')
    for (let i = 0; i < count; i++) is(q.at('fn' + i).kindOf('shared'), kind(tags[i]), 'scoped reads select one binding')
    is(q.held.get('shared'), count === 1 ? 7 : undefined, 'only an unambiguous definition supplies a held constant')
    retained ??= q
    is(retained.kindOf('shared'), kind(K.NUMBER), 'later variants and empty work preserve earlier readers')
  }
})

test('summary queries: cell lengths preserve zero, joins, init growth and retained snapshots', () => {
  const options = { funcs: [], schemas: [], brandOf: () => null, imports: new Map(), exported: () => false }
  const decl = (name, value) => ['const', ['=', name, value]]
  const array = n => ['[', ...Array.from({ length: n }, (_, i) => lit(i))]
  const names = ['fixed', 'alias', 'empty', 'grown', 'joined', 'written']
  const lengths = q => names.map(name => [q.fixedLenOf(name), q.frozenLenOf(name)])
  let retained
  for (const n of [2, 2, 0, 2]) {
    const q = summarize([';', decl('map', ['()', 'new.Map', null]),
      decl('fixed', array(n)), decl('alias', 'fixed'), decl('empty', array(0)),
      decl('grown', array(0)), ['()', ['.', 'grown', 'push'], lit(9)],
      decl('joined', ['?:', 'missing', array(n), array(n + 1)]),
      decl('written', array(n)), ['=', ['[]', 'written', lit(n)], lit(9)]], options)
    is(lengths(q), [[n, n], [n, n], [0, 0], [null, 1], [null, null], [null, null]],
      'dense cells distinguish fixed aliases, mixed extents, counted growth and a final-boundary store')
    retained ??= q
    is(lengths(retained), [[2, 2], [2, 2], [0, 0], [null, 1], [null, null], [null, null]],
      'A → A → different B → A leaves published facts unchanged')
  }
  is(summarize(null, options).fixedLenOf('fixed'), null, 'empty work has no earlier cell')
  is(retained.fixedLenOf('fixed'), 2, 'empty work preserves the retained cell')
})

test('summary queries: lazy traversal scratch preserves aliases, cycles and zero extents', () => {
  const options = { funcs: [], schemas: [], brandOf: () => null, imports: new Map(), exported: () => false }
  const decl = (name, value) => ['const', ['=', name, value]]
  const call = (name, ...args) => ['()', name, args.length === 1 ? args[0] : [',', ...args]]
  const read = (summary, name, index) => summary.kindOfExpr(['[]', name, lit(index)])
  const optionalNumber = join(kind(K.NUMBER), kind(K.ABSENT))
  let retained
  for (const length of [2, 2, 0, 2]) {
    const summary = summarize([';', decl('n', lit(length)), decl('alias', 'n'),
      decl('minimum', call('math.min', 'alias', 'alias')), decl('zero', lit(-0)),
      decl('negativeZero', call('math.min', 'zero', 'zero')), decl('unknown', 'missing'),
      decl('cyclicA', 'cyclicB'), decl('cyclicB', 'cyclicA'),
      decl('cyclicMath', call('math.min', 'cyclicA', lit(1))),
      decl('array', call('new.Float64Array', 'alias')), decl('copy', 'array'),
      decl('view', call('new.Uint32Array', ['.', 'copy', 'buffer']))], options)
    is(summary.held.get('minimum'), length, 'Math arguments independently traverse a shared alias chain')
    is(Object.is(summary.held.get('negativeZero'), -0), true, 'Math keeps the sign of zero')
    is(summary.held.has('unknown'), false, 'a missing definition supplies no held value')
    is(summary.held.has('cyclicA'), false, 'a cyclic definition supplies no held value')
    is(summary.held.has('cyclicMath'), false, 'Math cannot turn a cyclic argument into a fact')
    is(read(summary, 'copy', 0), length ? kind(K.NUMBER) : optionalNumber, 'an alias keeps zero and nonzero extents distinct')
    is(read(summary, 'copy', length), optionalNumber, 'the final array boundary remains absent')
    is(read(summary, 'view', length * 2 - 1), length ? kind(K.NUMBER) : optionalNumber, 'a buffer view derives its own element count')
    is(read(summary, 'view', length * 2), optionalNumber, 'the final view boundary remains absent')
    retained ??= summary
    is(read(retained, 'copy', 1), kind(K.NUMBER), 'a changed summary leaves a retained extent intact')
  }
  throws(() => summarize(null, { ...options, funcs: [{ name: 'bad', sig: { params: [] }, body: null }],
    exported: () => { throw new Error('query failure') } }), /query failure/)
  is(summarize(null, options).held.size, 0, 'empty work after an error has no held values')
  is(read(retained, 'copy', 1), kind(K.NUMBER), 'failed and empty summaries preserve the retained reader')
})

test('summary queries: stored-property provenance leaves unknown typed reads open', () => {
  const options = { funcs: [{ name: 'read', sig: { params: [{ name: 'key' }] }, body: ['[]', 'a', 'key'] }],
    schemas: [], brandOf: () => null, imports: new Map(), exported: () => true }
  let retained
  for (const value of [7n, 7n, 'changed', 7n]) {
    const stored = kind(typeof value === 'bigint' ? K.BIGINT : K.STRING)
    for (const ctor of [null, 'Int32Array', 'BigInt64Array']) {
      const element = kind(ctor === 'BigInt64Array' ? K.BIGINT : K.NUMBER)
      const array = ['[', lit(ctor === 'BigInt64Array' ? 1n : 1)]
      const init = ctor ? ['()', 'new.' + ctor, array] : array
      const summary = summarize([';', ['const', ['=', 'a', init]],
        ['=', ['.', 'a', 'extra'], lit(value)]], options)
      const q = summary.at('read'), receiver = q.kindOfExpr('a')
      is(q.elemOfKind(receiver), ctor ? kind(K.ANY) : element, 'the existing element query keeps its default contract')
      is(q.elemOfKind(receiver, true), join(element, stored), 'provenance includes independently stored named values')
      if (ctor) is(q.kindOfExpr(['[]', 'a', 'key']), kind(K.ANY), 'a fully unknown key still has an open read kind')
      retained ??= q
      is(retained.elemOfKind(retained.kindOfExpr('a'), true), join(kind(K.NUMBER), kind(K.BIGINT)), 'later queries preserve a retained storage view')
    }
  }
})

test('summary queries: declaration census keeps scope, missing writes and cold Boolean stores', () => {
  const options = { schemas: [['HIGH']], brandOf: () => null, imports: new Map(), exported: () => false }
  const build = value => {
    const ast = [';', ['let', 'high'], ['const', ['=', 'limits', ['{}', [':', 'HIGH', lit(typeof value === 'boolean' ? 19 : value)]]]],
      ['=', 'high', ['.', 'limits', 'HIGH']], ['let', 'flag'], ['??=', 'flag', lit(value)],
      ['const', ['=', 'dict', ['{}']]], ['=', ['[]', 'dict', ['str', 'entry']], lit(value)],
      ['const', ['=', 'copy', ['{}']]], ['()', 'Object.assign', [',', 'copy', 'dict']],
      ['const', ['=', 'fixed', ['[', lit(1), lit(2)]]]]
    const funcs = [{ name: 'cold', sig: { params: [{ name: 'p' }] }, body: [';',
      ['let', ['=', 'flag', lit(true)]], ['let', ['=', 'mixed', lit(false)]], ['++', 'mixed'],
      ['const', ['=', 'callback', ['=>', [], [';', ['let', ['=', 'flag', lit(false)]], ['return', 'flag']]]]],
      ['=', 'late', lit(value)], ['return', 'flag']] }]
    return summarize(ast, { ...options, funcs, moduleGlobals: new Map([['late', true]]) })
  }
  let retained
  for (const value of [7, 7, true, 7]) {
    const summary = build(value), q = summary.at(''), cold = summary.at('cold')
    is(summary.held.get('high'), typeof value === 'boolean' ? 19 : value, 'a bare module declaration keeps its one later initializer')
    is(q.boolStores('flag'), typeof value === 'boolean' ? 3 : 2, 'the implicit undefined and later write both count')
    is(cold.boolStores('flag'), 1, 'an unreachable body keeps its scoped Boolean syntax')
    is(cold.boolStores('mixed'), 3, 'compound mutation adds its numeric store beside a Boolean')
    is(cold.boolStores('p'), 2, 'a parameter keeps its incoming-value store')
    is(q.fixedLenOf('fixed'), 2, 'a literal declaration preserves its exact extent')
    is(hasTag(q.bindingKindOf('late'), K.NULLISH), true, 'a planned module binding starts missing until its conditional writer runs')
    is(q.kindOfExpr(['[]', 'dict', ['str', 'entry']]), join(kind(typeof value === 'boolean' ? K.BOOL : K.NUMBER), kind(K.ABSENT)), 'computed writes retain their dictionary root')
    retained ??= summary
    is(retained.held.get('high'), 7, 'another census leaves the published snapshot intact')
  }
  throws(() => summarize(null, { ...options, funcs: [{ name: 'bad', sig: { params: [] }, body: null }],
    exported: () => { throw new Error('census failure') } }), /census failure/)
  is(summarize(null, { ...options, funcs: [] }).at('').boolStores('flag'), 0, 'empty work after an error has no old stores')
  is(retained.held.get('high'), 7, 'an error does not alter a retained reader')
})

test('summary queries: unseen literal shapes follow live aliases without changing scalar reads', () => {
  const object = props => ['{}', ...props.map(name => [':', name, lit(1)])]
  const schemas = [['a'], ['b'], ['a', 'tail'], ['b', 'tail']]
  const ast = [';', ...['a', 'b', 'ca', 'cb'].map((name, i) => ['const', ['=', name, object(schemas[i])]]),
    ['const', ['=', 'x', lit(7)]]]
  const options = { funcs: [], schemas, brandOf: () => null, imports: new Map(), exported: () => false }
  const summary = summarize(ast, options), q = summary.at('')
  const unseen = ['{}', ['...', 'alias'], [':', 'tail', lit(0)]]
  for (const name of ['a', 'a', 'b', 'a']) {
    q.alias('alias', name)
    is(q.kindOfExpr(unseen), q.kindOf('c' + name), 'a retained literal query reads the current alias')
    is(q.kindOfExpr(['{}', 'a', [':', 'a', lit(2)]]), q.kindOf('a'), 'shorthand and duplicate keys share one layout')
    is(q.kindOfExpr('x'), kind(K.NUMBER), 'literal builders do not affect scalar facts')
    q.unalias('alias')
    is(q.kindOfExpr(unseen), kind(K.HASH), 'an unbound spread keeps the unknown layout')
  }
  summarize(null, { ...options, schemas: [] })
  is(q.kindOfExpr('x'), kind(K.NUMBER), 'a later empty summary leaves the reader intact')
})

test('summary queries: layout discovery restarts leave complete and retained readers independent', () => {
  const options = { funcs: [], schemas: [['a']], brandOf: () => null, imports: new Map(), exported: () => false }
  const input = value => [';',
    ['const', ['=', 'a', ['{}', [':', 'a', lit(value)]]]],
    ['const', ['=', 'b', ['{}', ['...', 'a'], [':', 'b', lit(2)]]]],
    ['const', ['=', 'c', ['{}', ['...', 'b'], [':', 'c', lit(3)]]]],
  ]
  const plain = summarize(input(1), options)
  is(plain.unnamedLayouts, [['a', 'b']], 'public summaries complete without a registry callback')
  const refused = summarize(input(1), { ...options, registerLayouts: () => false })
  is(refused.unnamedLayouts, plain.unnamedLayouts, 'a registry that adds nothing still gets complete facts')
  let retained
  for (const value of [1, 1, 'changed', 1]) {
    const schemas = [['a']], restarts = []
    let summary
    do summary = summarize(input(value), { ...options, schemas, registerLayouts: layouts => {
      const fresh = layouts.filter(names => !schemas.some(prior => prior.join() === names.join()))
      schemas.push(...fresh)
      if (fresh.length) restarts.push(fresh)
      return fresh.length > 0
    } })
    while (summary === null)
    is(restarts, [[['a', 'b']], [['a', 'b', 'c']]], 'nested spreads register one newly knowable layout at each restart')
    is(summary.unnamedLayouts, [], 'the final reader has every discovered layout')
    const expected = typeof value === 'number' ? K.NUMBER : K.STRING
    is(summary.at('').kindOfExpr(['.', 'c', 'a']), kind(expected), 'the nested copy keeps its source kind')
    retained ??= summary
    is(retained.at('').kindOfExpr(['.', 'c', 'a']), kind(K.NUMBER), 'later restarts preserve earlier readers')
  }
  throws(() => summarize(input(1), { ...options, registerLayouts: () => { throw new Error('registry failure') } }), /registry failure/)
  is(summarize(null, options).unnamedLayouts, [], 'empty work after an error has no leaked discovery state')
  is(retained.at('').kindOfExpr(['.', 'c', 'a']), kind(K.NUMBER), 'an error preserves a retained reader')
})

test('summary queries: alternating argument hull buffers preserve late calls and prior summaries', () => {
  let retained
  for (const last of [7, 7, 19, 7]) {
    const funcs = Array.from({ length: 12 }, (_, i) => ({ name: 'part' + i,
      sig: { params: [{ name: 'x' }] }, body: i ? ['()', 'part' + (i - 1), 'x'] : 'x' }))
    const ast = [';', ['()', 'part11', lit(3)], ['()', 'part11', lit(last)]]
    const summary = summarize(ast, { funcs, schemas: [], brandOf: () => null, imports: new Map(), exported: () => false })
    for (let i = 0; i < funcs.length; i++) is(summary.at('').paramRangesOf('part' + i), [[3, last]], 'argument bounds reach every callee')
    retained ??= summary
    is(retained.at('').paramRangesOf('part0'), [[3, 7]], 'a later summary cannot reuse a published hull buffer')
  }
})

test('summary queries: argument settling isolates empty, missing and recursively widening positions', () => {
  const options = { schemas: [], brandOf: () => null, imports: new Map(), exported: () => false }
  const fn = (name, params, body) => ({ name, sig: { params: params.map(name => ({ name })) }, body })
  let retained
  for (const value of [3, 3, 'changed', 19, 3]) {
    const funcs = [fn('zero', [], lit(1)), fn('pair', ['a', 'b'], ['+', 'a', 'b']),
      fn('cycle', ['n'], [';', ['()', 'cycle', ['+', 'n', lit(1)]], 'n']),
      fn('point', ['v'], ['*', 'v', lit(2)])]
    const summary = summarize([';', ['()', 'zero', null],
      ['()', 'pair', [',', lit(2), lit(value)]], ['()', 'pair', lit(4)],
      ['()', 'cycle', lit(0)], ['()', 'point', lit(value)]], { ...options, funcs })
    const q = summary.at('')
    is(q.paramRangesOf('zero'), [], 'a zero-parameter entry has an empty buffer')
    is(q.paramRangesOf('pair'), [[2, 4], null], 'a missing later argument opens only its own position')
    is(q.paramRangesOf('cycle'), [null], 'a changing recursive hull widens to unknown')
    is(q.paramRangesOf('point'), [typeof value === 'number' ? [value, value] : null], 'unrelated entries retain their own hull')
    retained ??= q
    is(retained.paramRangesOf('point'), [[3, 3]], 'later solves do not recycle a retained reader’s buffers')
  }
  is(summarize(null, { ...options, funcs: [] }).at('').paramRangesOf('point'), null, 'zero work has no previous argument registry')
  is(retained.paramRangesOf('pair'), [[2, 4], null], 'empty work leaves prior multi-position bounds intact')
})

test('summary queries: repeated point ranges preserve signed zero and late bounds', () => {
  const options = { schemas: [], brandOf: () => null, imports: new Map(), exported: () => false }
  let retained
  for (const end of [7, 7, 19, 7]) {
    const funcs = ['positive', 'negative', 'both', 'spread', 'missing'].map(name => ({ name,
      sig: { params: [{ name: 'x' }] }, body: 'x' }))
    const call = (name, value) => ['()', name, lit(value)]
    const ast = [';', call('positive', 0), call('negative', -0), call('both', 0), call('both', -0),
      ...Array.from({ length: 32 }, () => call('spread', 3)), call('spread', end),
      call('missing', 0), ['()', 'missing', null]]
    const summary = summarize(ast, { ...options, funcs })
    const ranges = name => summary.at('').paramRangesOf(name)
    is(ranges('positive').map(r => r.map(v => Object.is(v, 0))), [[true, true]], 'positive zero keeps both signs')
    is(ranges('negative').map(r => r.map(v => Object.is(v, -0))), [[true, true]], 'negative zero keeps both signs')
    is(Object.is(ranges('both')[0][0], -0), true, 'a mixed-zero hull keeps its lower sign')
    is(Object.is(ranges('both')[0][1], 0), true, 'a mixed-zero hull keeps its upper sign')
    is(ranges('spread'), [[3, end]], 'repeated identical calls do not hide a later bound')
    is(ranges('missing'), [null], 'a later missing argument opens a previously exact point')
    retained ??= summary
    is(retained.at('').paramRangesOf('spread'), [[3, 7]], 'subsequent summaries leave published bounds intact')
  }
  is(summarize(null, { ...options, funcs: [] }).unnamedLayouts, [], 'zero work has no retained range state')
})

test('summary queries: repeated record and primitive joins retain both operand orders', () => {
  for (const value of [300n, 300n, 'changed', 300n]) {
    const source = `export function read(flag) {
      let first = { value: ${typeof value === 'bigint' ? value + 'n' : JSON.stringify(value)} };
      let left = first; left = flag ? left : 0;
      let right = 0; right = flag ? first : right;
      let joined = flag ? left : right;
      return joined ? joined.value : undefined;
    }`
    const exports = instantiate(compile(source, { optimize: 0 })).exports
    is(exports.read(1), value, 'the object keeps its field through repeated mixed joins')
    is(exports.read(0), undefined, 'the primitive arm remains absent')
    is(exports.read(1), value, 'the object result survives an intervening primitive call')
  }
})

test('summary queries: held fields require every alias to remain read-only and unambiguous', () => {
  const options = { funcs: [], schemas: [['HIGH']], brandOf: () => null, imports: new Map(), exported: () => false }
  const decl = (name, value) => ['const', ['=', name, value]]
  const read = ['.', 'alias', 'HIGH']
  const ast = [';', ['const', ['=', 'limits', ['{}', [':', 'HIGH', lit(7)]]]],
    ['const', ['=', 'alias', 'limits']], ['const', ['=', 'high', read]]]
  const cases = [
    ['empty', null, [], false],
    ['read', ast, [], true],
    ['read again', ast, [], true],
    ['unrelated primitive and array bindings', [';', ...ast.slice(1),
      decl('number', lit(3)), decl('numberAlias', 'number'),
      decl('array', ['[', 'numberAlias']), decl('first', ['[]', 'array', lit(0)])], [], true],
    ['alias chain', [';', ...ast.slice(1, 3), decl('second', 'alias'),
      decl('high', ['.', 'second', 'HIGH'])], [], true],
    ['alias rebound to primitive', [';', ...ast.slice(1), ['=', 'alias', lit(3)]], [], false],
    ['root rebound to array', [';', ...ast.slice(1), ['=', 'limits', ['[', lit(3)]]], [], false],
    ['alias copied into array', [';', ...ast.slice(1), decl('values', ['[', 'alias'])], [], false],
    ['write through alias', [';', ...ast.slice(1), ['=', read, lit(9)]], [], false],
    ['increment root', [';', ...ast.slice(1), ['++', ['.', 'limits', 'HIGH']]], [], false],
    ['escape alias', [';', ...ast.slice(1), ['()', 'unknown', 'alias']], [], false],
    ['shadow root', ast, [{ name: 'f', sig: { params: [{ name: 'limits' }] }, body: ['.', 'limits', 'HIGH'] }], false],
    ['shadow alias', ast, [{ name: 'f', sig: { params: [{ name: 'alias' }] }, body: ['.', 'alias', 'HIGH'] }], false],
    ['read after changes', ast, [], true],
  ]
  let retained
  for (const [label, body, funcs, known] of cases) {
    const summary = summarize(body, { ...options, funcs })
    is(summary.held.get('high'), known ? 7 : undefined, label)
    if (known) retained ??= summary
    if (retained) is(retained.held.get('high'), 7, `${label}: later analyses preserve earlier facts`)
  }
})

test('summary queries: closure unions retain their members through the capacity boundary and reuse', () => {
  let retained
  for (const count of [0, 1, 1023, 1024, 1025, 1025, 1]) {
    const closures = Array.from({ length: count }, (_, i) => ['=>', [',', 'x'], ['+', 'x', lit(i)]])
    const ast = [';', ...closures.map((fn, i) => ['let', ['=', 'f' + i, fn]]),
      ['let', ['=', 'joined', count ? 'f0' : lit(0)]],
      ...closures.slice(1).map((_, i) => ['=', 'joined', 'f' + (i + 1)]),
      ['=', 'joined', count ? 'f0' : lit(0)]]
    const summary = summarize(ast, { funcs: [], schemas: [], brandOf: () => null, imports: new Map(), exported: () => false })
    const id = summary.at('').calleeOf(['()', 'joined', lit(2)])
    if (count && count <= 1024) {
      is(summary.closureMembers(id), Array.from({ length: count }, (_, i) => i), `${count}: the subset assignment retains the union`)
      if (count === 1024) retained = [summary, id]
    } else is(id, null, `${count}: no bounded dispatch table`)
    is([...summary.escaped], count > 1024 ? Array.from({ length: count }, (_, i) => i) : [], `${count}: only overflow escapes every member`)
    if (retained) is(retained[0].closureMembers(retained[1]), Array.from({ length: 1024 }, (_, i) => i), 'later summaries leave the retained union unchanged')
  }
})

test('summary queries: inherited methods agree with the solved function result', () => {
  const ast = [';', ['const', ['=', 'o', ['{}', [':', 'x', lit(1)]]]]]
  for (const [name, expected] of [['hasOwnProperty', VAL.BOOL], ['toString', VAL.STRING], ['valueOf', VAL.OBJECT]]) {
    const call = ['()', ['.', 'o', name], name === 'hasOwnProperty' ? ['str', 'x'] : null]
    const summary = summarize(ast, { funcs: [{ name: 'f', sig: { params: [] }, body: call }], schemas: [['x']], brandOf: () => null, imports: new Map(), exported: () => true })
    is(summary.resultVal('f'), expected, `${name} function result`)
    is(summary.at('f').valOfExpr(call), expected, `${name} expression result`)
  }
})

test('summary queries: disjoint objects use construction sites, including joins and folded layouts', () => {
  const object = n => ['{}', [':', 'x', lit(n)]]
  const ast = [';', ['const', ['=', 'a', object(1)]], ['const', ['=', 'b', object(2)]],
    ['const', ['=', 'alias', 'a']], ['let', ['=', 'joined', 'a']], ['=', 'joined', 'b']]
  const options = { funcs: [], schemas: [['x']], brandOf: () => null, imports: new Map(), exported: () => false }
  const first = summarize(ast, options).at('')
  is(first.objectsDisjoint('a', 'b'), true, 'equal layout, separate construction sites')
  is(first.objectsDisjoint('alias', 'b'), true, 'a stable alias keeps its construction identity')
  is(first.objectsDisjoint('a', 'alias'), false, 'same object')
  is(first.objectsDisjoint('a', 'joined'), false, 'a join can name either object')
  is(first.objectsDisjoint('a', 'unknown'), false, 'unknown origin')
  is(first.objectsDisjoint('a', lit(1)), false, 'not an object proof')
  const wide = [';', ...ast.slice(1), ...Array.from({ length: 70 }, (_, i) => ['=', 'joined', object(i + 3)])]
  const folded = summarize(wide, options).at('')
  is(folded.objectsDisjoint('a', 'b'), false, 'folding a layout removes its per-site distinction')
  is(first.objectsDisjoint('a', 'b'), true, 'a later summary cannot change a retained proof')
  const hosted = summarize(ast, { ...options, funcs: [{ name: 'give', sig: { params: [] }, body: 'a' }], exported: f => f.name === 'give' }).at('')
  is(hosted.objectsDisjoint('a', 'b'), false, 'host-visible identities stay conservative')
})

test('summary queries: an unresolved array index retains possible element and named-property kinds', () => {
  for (const values of [[], [['[', lit('x')]]]) {
    const read = ['[]', 'rows', 'key']
    const summary = summarize([';',
      ['const', ['=', 'rows', ['[', ...values]]],
      ['=', ['.', 'rows', 'note'], lit('named')]], {
      funcs: [{ name: 'pick', sig: { params: [{ name: 'key' }] }, body: read }],
      schemas: [], brandOf: () => null, imports: new Map(), exported: () => false,
    })
    const view = summary.at('pick'), k = view.kindOfExpr(read)
    is(view.kindOf('key'), K.NONE, 'the uncalled parameter has no incoming evidence')
    is(hasTag(k, K.ARRAY), values.length > 0, 'possible elements survive an unresolved key')
    is(hasTag(k, K.STRING), true, 'the key can name a side property')
    is(hasTag(k, K.NUMBER), true, 'the key can name length')
    is(hasTag(k, K.CLOSURE), true, 'the key can name an inherited method')
    is(hasTag(k, K.ABSENT), true, 'the key can also miss')
    is(view.kindOf('key'), K.NONE, 'queries do not mutate the solver')
  }
})

test('summary fields: empty and sparse schema tables retain independent readers', () => {
  const schemas = [['x'], [], ['unused'], ['data']]
  const options = { schemas, funcs: [], brandOf: () => null, imports: new Map(), exported: () => false }
  const empty = summarize(null, options)
  is(empty.fieldKind(3, 'data'), K.NONE)
  is(empty.fieldKind(-1, 'x'), K.NONE)
  is(empty.fieldKind(100, 'x'), K.NONE)
  is(empty.hasTypedFields, false)
  const ast = [';',
    ['let', ['=', 'a', ['{}', [':', 'data', ['()', 'new.Uint8Array', lit(0)]]]]],
    ['let', ['=', 'b', ['{}', [':', 'x', lit(7)]]]],
  ]
  for (let again = 0; again < 2; again++) {
    const first = summarize(ast, options)
    is(first.fieldVal(3, 'data'), VAL.TYPED)
    is(first.fieldKind(0, 'x'), kind(K.NUMBER))
    is(first.fieldKind(2, 'unused'), K.NONE)
    is(first.hasTypedFields, true)
    const other = summarize(['let', ['=', 'c', ['{}', [':', 'x', lit('s')]]]], options)
    is(other.fieldKind(0, 'x'), kind(K.STRING))
    is(other.hasTypedFields, false)
    is(first.fieldKind(0, 'x'), kind(K.NUMBER), 'later summaries do not overwrite retained storage')
    is(first.fieldVal(3, 'data'), VAL.TYPED)
  }
})

test('summary queries: atomic results retain their element kind without absence', () => {
  for (const [ctor, k] of [['Int32Array', K.NUMBER], ['BigInt64Array', K.BIGINT]]) {
    const ops = ['load', 'store', 'add', 'sub', 'and', 'or', 'xor', 'exchange', 'compareExchange']
    const reads = ops.map(op => ['()', 'Atomics.' + op, [',', 'a', lit(0),
      lit(k === K.BIGINT ? 1n : 1), lit(k === K.BIGINT ? 2n : 2)]])
    const summary = summarize([';', ['const', ['=', 'a', ['()', 'new.' + ctor, lit(2)]]],
      ...reads.map((read, i) => ['let', ['=', 'r' + i, read]])], {
      funcs: [], schemas: [], brandOf: () => null, imports: new Map(), exported: () => false,
    })
    for (let i = 0; i < reads.length; i++) {
      is(summary.kindOf('r' + i), kind(k), `${ctor}.${ops[i]} binding`)
      is(summary.at('').kindOfExpr(reads[i]), kind(k), `${ctor}.${ops[i]} expression`)
      is(summary.at('').mayBeNullishExpr(reads[i]), false, `${ctor}.${ops[i]} throws instead of returning undefined`)
    }
  }
})

function program() {
  const params = [',', 'acc', 'element']
  const ast = [';',
    ['const', ['=', 'callback', ['=>', params, 'acc']]],
    ['const', ['=', 'values', ['[', lit(7)]]],
  ]
  const summary = summarize(ast, {
    funcs: [{ name: 'result', sig: { params: [] }, body: reduce('callback', lit(1n)) }],
    schemas: [], brandOf: () => null, imports: new Map(), exported: () => true,
  })
  return { summary, params }
}

test('summary queries: numeric demand keeps the first parameter separate from its module namesake', () => {
  const summary = summarize(['const', ['=', 'value', lit('module')]], {
    funcs: [{ name: 'scale', sig: { params: [{ name: 'value' }] }, body: ['*', 'value', lit(2)] }],
    schemas: [], brandOf: () => null, imports: new Map(), exported: () => true,
  })
  is(summary.at('scale').numericDemand('value'), true)
  is(summary.at('scale').kindOf('value'), kind(K.NUMBER))
  is(summary.kindOf('value'), kind(K.STRING))
  is(summary.at('scale').kindOf('missing'), K.NONE)
  is(summary.at('scale').kindOfExpr('missing'), kind(K.ANY))
})

test('summary queries: guarded demand reuses structural writes without carrying them across summaries', () => {
  const arm = [';', ['return', 'x']]
  const body = ['{}', [';', ['if', ['!==', 'x', 'x'], arm], ['return', ['*', 'x', lit(2)]]]]
  const options = { funcs: [{ name: 'guarded', sig: { params: [{ name: 'x' }, { name: 'again' }] }, body }],
    schemas: [], brandOf: () => null, imports: new Map(), exported: () => true }
  const write = ['=', 'x', ['str', 'changed']]
  const mutations = [null, null, write, ['if', 'again', write],
    ['while', 'again', [';', write, ['=', 'again', lit(false)]]],
    ['const', ['=', 'change', ['=>', [], write]]],
    ['const', ['=', 'change', ['=>', [',', ['=', 'value', write]], 'value']]], null]
  let retained
  for (const mutation of mutations) {
    arm.splice(1, arm.length - 1, ...(mutation ? [mutation] : []), ['return', 'x'])
    const summary = summarize(null, options)
    is(summary.at('guarded').paramKindOf('x'), kind(mutation ? K.ANY : K.NUMBER),
      'direct, conditional, loop, capture and default writes invalidate the guarded return')
    retained ??= summary
    is(retained.at('guarded').paramKindOf('x'), kind(K.NUMBER), 'a later body revision leaves a published contract intact')
  }
  is(summarize(null, { ...options, funcs: [] }).at('').kindOf('x'), K.NONE, 'empty work has no earlier mutation list')
})

test('summary queries: default closures declare parameters and resolve their captured scope', () => {
  const params = [',', 'x']
  const fn = ['=>', params, ['*', 'x', 'n']]
  for (const anonymous of [false, true]) {
    const ast = [';', ['const', ['=', 'f', ['()', 'factory', lit(3)]]]]
    const funcs = [{ name: 'main', sig: { params: [] }, body: ['()', 'f', lit(5)] }]
    if (anonymous) ast.splice(1, 0, ['const', ['=', 'factory', ['=>', [',', 'n', ['=', 'fn', fn]], 'fn']]])
    else funcs.push({ name: 'factory', sig: { params: [{ name: 'n' }, { name: 'fn' }] }, defaults: { fn }, body: 'fn' })
    const summary = summarize(ast, {
      funcs, schemas: [], brandOf: () => null, imports: new Map(), exported: f => f.name === 'main',
    })
    is(summary.at(params).kindOf('x'), kind(K.NUMBER))
    is(summary.at(params).kindOf('n'), kind(K.NUMBER))
    is(summary.resultOf('main'), kind(K.NUMBER))
  }
})

test('summary queries: a hypothetical reduction cannot bind callback parameters', () => {
  const { summary, params } = program(), callback = summary.at(params)
  is(callback.paramKindOf('acc'), kind(K.BIGINT))
  const result = summary.resultOf('result')
  summary.kindOfExpr(reduce('callback', lit('different seed')))
  is(callback.paramKindOf('acc'), kind(K.BIGINT), 'reading a call cannot change the settled incoming accumulator')
  is(callback.kindOf('acc'), kind(K.BIGINT), 'nor the callback binding')
  is(summary.resultOf('result'), result)
})

test('summary queries: an unknown callback cannot escape queried array or closure arguments', () => {
  const { summary } = program()
  const values = summary.kindOf('values')
  is(summary.elemOfKind(values), kind(K.NUMBER))
  summary.kindOfExpr(reduce('unknownCallback', 'values'))
  is(summary.elemOfKind(values), kind(K.NUMBER), 'a query cannot poison an array cell')
  const escaped = [...summary.escaped]
  summary.kindOfExpr(reduce('unknownCallback', 'callback'))
  is([...summary.escaped], escaped, 'nor mark a closure as escaped')
})

test('summary queries: query order does not change retained facts or later answers', () => {
  const { summary, params } = program()
  const queries = [
    () => summary.at(params).paramKindOf('acc'),
    () => summary.elemOfKind(summary.kindOf('values')),
    () => summary.kindOfExpr(reduce('callback', lit('different seed'))),
    () => summary.kindOfExpr(reduce('unknownCallback', 'values')),
    () => summary.resultOf('result'),
  ]
  const before = queries.map(query => query())
  for (let i = queries.length - 1; i >= 0; i--) queries[i]()
  is(queries.map(query => query()), before)
})

test('summary queries: empty programs, missing facts, and nullish optional reads', () => {
  for (const ast of [null, [';']]) {
    const summary = summarize(ast, { funcs: [], schemas: [], brandOf: () => null, imports: new Map(), exported: () => false })
    is(summary.hasTypedFields, false)
    is(summary.resultOf('missing'), K.NONE)
    is(summary.fieldKind(0, 'missing'), K.NONE)
    is(summary.at(null).kindOf('missing'), K.NONE)
    is(summary.kindOfExpr('missing'), kind(K.ANY))
    for (const value of [null, undefined]) {
      is(summary.kindOfExpr(lit(value)), kind(K.NULLISH))
      is(summary.kindOfExpr(['?.', lit(value), 'length']), kind(K.NULLISH))
      is(summary.kindOfExpr(['()', ['?.', lit(value), 'reduce'], null]), kind(K.NULLISH))
    }
  }
})

test('summary queries: class methods and import kinds are retained by value', () => {
  const brand = BRAND + 'QueryReview'
  const methods = new Map([['value', 'method']]), classes = new Map([[brand, { methods }]])
  const imports = new Map([['foreign', 'number']])
  let allowBrandLookup = true
  const summary = summarize([';',
    ['const', ['=', 'record', ['{}', [':', brand, lit(true)], [':', 'x', lit(1)]]]],
    ['const', ['=', 'other', ['{}', [':', brand, lit(true)], [':', 'x', lit(2)]]]],
    ['const', ['=', 'choice', ['?', 'flag', 'record', 'other']]],
    ['()', ['.', 'record', 'value'], null],   // the method is reached
  ], {
    funcs: [{ name: 'method', sig: { params: [{ name: 'self' }] }, body: lit(7) }],
    schemas: [['x']], classes, imports, exported: () => false,
    brandOf: () => { if (!allowBrandLookup) throw new Error('reader consulted the live registry'); return brand },
  })
  const call = ['()', ['.', 'record', 'value'], null]
  is(summary.kindOfExpr(call), kind(K.NUMBER))
  is(summary.classCallee('record', 'value'), 'method')
  is(summary.classCallee('record', 'missing'), null)
  is(summary.classCallee('choice', 'value'), 'method', 'two allocations of the same class share method identity')
  is(summary.classCallee(['?', lit(true), 'record', lit(null)], 'value'), null, 'nullable receiver keeps dispatch')
  is(summary.kindOfExpr(['()', 'foreign', null]), kind(K.NUMBER))
  methods.set('value', 'different'); classes.clear(); imports.set('foreign', 'string')
  allowBrandLookup = false
  is(summary.kindOfExpr(call), kind(K.NUMBER), 'method target survives registry changes')
  is(summary.classCallee('record', 'value'), 'method', 'devirtualization uses retained metadata too')
  is(summary.kindOfExpr(['()', 'foreign', null]), kind(K.NUMBER), 'import result survives registry changes')
})

test('summary queries: scoped views and schema metadata survive later activity', () => {
  const schemas = [['value']]
  const summary = summarize([';',
    ['()', 'left', lit(3)], ['()', 'right', lit('text')],
    ['const', ['=', 'record', ['{}', [':', 'value', lit(7)]]]],
  ], {
    funcs: ['left', 'right'].map(name => ({ name, sig: { params: [{ name: 'x' }] }, body: 'x' })),
    schemas, brandOf: () => null, imports: new Map(), exported: () => false,
  })
  const left = summary.at('left'), right = summary.at('right')
  is(left.kindOf('x'), kind(K.NUMBER))
  is(right.kindOfExpr('x'), kind(K.STRING))
  is(left.paramKindOf('x'), kind(K.NUMBER), 'another view does not change this scope')
  is(summary.kindOf('x'), kind(K.NUMBER) | kind(K.STRING), 'unscoped lookup joins the declarations')
  is(summary.fieldKind(0, 'value'), kind(K.NUMBER))
  schemas[0][0] = 'different'
  is(summary.fieldKind(0, 'value'), kind(K.NUMBER), 'the caller no longer owns published schema metadata')
  is(summary.fieldKind(10, 'missing'), K.NONE)
  is(summary.at('missing').kindOf('x'), K.NONE)
})

test('summary queries: A→A→B→A preserves bytes, retained facts, and earlier outputs', () => {
  if (onKernel()) return // this test inspects the native compiler's analysis
  const A = 'export function make(){return {buf:new Float32Array(2),gain:3}} const api={make}; export function main(){return api.make().buf.length}'
  const B = 'export function main(){return {other:41}.other+1}'
  const options = { optimize: { level: 2, sourceInline: false, inlineFns: false } }
  const a = compile(A, options), saved = ctx.summary
  const sid = ctx.schema.list.findIndex(props => props.join() === 'buf,gain')
  const queries = [
    () => saved.fieldKind(sid, 'gain'),
    () => saved.fieldTypedCtor(sid, 'buf'),
    () => saved.resultOf('make'),
    () => saved.at('main').kindOfExpr(['()', 'make', null]),
    () => saved.hasTypedFields,
  ]
  const facts = queries.map(query => query())
  for (let i = queries.length - 1; i >= 0; i--) queries[i]()
  is([...compile(A, options)], [...a], 'queries between A compiles do not change bytes')
  const b = compile(B, options)
  const freshB = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { compile } from ${JSON.stringify(new URL('../index.js', import.meta.url).href)}
    process.stdout.write(Buffer.from(compile(${JSON.stringify(B)}, ${JSON.stringify(options)})).toString('base64'))
  `], { encoding: 'utf8', timeout: 60_000 })
  is([...b], [...Buffer.from(freshB, 'base64')], 'B after A matches a fresh process compiling B')
  is(queries.map(query => query()), facts, 'retained A facts survive B and its schema registry')
  const empty = compile('', options)
  is(typeof instantiate(empty).exports.main, 'undefined', 'zero-work module has no user entry')
  throws(() => compile('export function broken(', options), 'incomplete source must reject')
  is(queries.map(query => query()), facts, 'empty and failed compiles preserve retained facts')
  is([...compile(A, options)], [...a], 'A after B, empty, and failed compiles matches the first A')
  const execute = bytes => instantiate(bytes).exports.main()
  is(execute(a), 2, 'retained A still executes')
  is(execute(b), 42, 'retained B still executes')
})

// The result contract (src/summary/contract.js): kind, presence and the
// carrier the kind and the callable's ABI class decide, per function name,
// closure id and closure set.
const contractProgram = () => {
  const bigint = lit(7n), block = (...stmts) => ['{}', ...stmts]
  const funcs = [
    { name: 'direct', sig: { params: [], results: ['f64'] }, body: bigint },
    { name: 'exported', sig: { params: [], results: ['f64'] }, body: bigint },
    { name: 'valued', sig: { params: [], results: ['f64'] }, body: bigint },
    { name: 'dispatcher', sig: { params: [], results: ['f64'], dispatcher: true }, body: bigint },
    { name: 'number', sig: { params: [], results: ['f64'] }, body: lit(1) },
    { name: 'narrowed', sig: { params: [], results: ['i32'] }, body: lit(1) },
    { name: 'boolOrNumber', sig: { params: [{ name: 'c' }], results: ['f64'] }, body: ['?:', 'c', lit(1), ['<', lit(1), lit(2)]] },
    { name: 'bare', sig: { params: [{ name: 'c' }], results: ['f64'] }, body: block(['if', 'c', ['return', lit(1)]], ['return']) },
    { name: 'fallthrough', sig: { params: [{ name: 'c' }], results: ['f64'] }, body: block(['if', 'c', ['return', bigint]]) },
    { name: 'mixed', sig: { params: [{ name: 'c' }], results: ['f64'] }, body: ['?:', 'c', bigint, lit(1)] },
    { name: 'erased', sig: { params: [{ name: 'x' }], results: ['f64'] }, body: block(['if', 'x', ['return', bigint]], ['return', 'x']) },
    { name: 'through', sig: { params: [{ name: 'x' }], results: ['f64'] }, body: ['()', 'erased', 'x'] },
    { name: 'unbounded', sig: { params: [{ name: 'x' }], results: ['f64'] }, body: 'x' },
  ]
  const closureParams = [',', 'v'], numberParams = [',', 'w']
  const closure = ['=>', closureParams, bigint], numberClosure = ['=>', numberParams, lit(2)]
  const ast = [';',
    ['const', ['=', 'value', 'valued']],                 // `valued` read as a value: its callers are unknown
    ['const', ['=', 'cb', closure]],
    ['const', ['=', 'other', ['=>', 'unused', lit(3)]]],
    ['const', ['=', 'set', ['?:', lit(true), closure, numberClosure]]],
    ['const', ['=', 'table', ['[', closure, numberClosure]]],
    ['const', ['=', 'index', lit(0)]], // this call selects an element, not an arbitrary property
    ['()', 'cb', lit(1)], ['()', 'set', lit(1)], ['()', ['[]', 'table', 'index'], lit(1)],
    ['()', 'erased', lit('any')], ['()', 'through', lit('any')], ['()', 'unbounded', lit('any')],
    // the summary walks what the program reaches: each pinned function is called
    ['()', 'direct', null], ['()', 'value', null], ['()', 'number', null], ['()', 'narrowed', null],
    ['()', 'boolOrNumber', lit(1)], ['()', 'bare', lit(1)], ['()', 'fallthrough', lit(1)], ['()', 'mixed', lit(1)],
  ]
  const summary = summarize(ast, { funcs, schemas: [], brandOf: () => null, imports: new Map(), exported: f => f.name === 'exported' || f.name === 'erased' || f.name === 'through' || f.name === 'unbounded' })
  return { summary, closureParams, numberParams, funcs }
}

test('summary contract: void bodies differ from explicit nullish results', () => {
  const bodies = { empty: ['{}'], effect: ['{}', [';', ['()', 'Number', lit(1)]]], nil: lit(null), undef: ['{}', ['return', lit(undefined)]] }
  const funcs = Object.entries(bodies).map(([name, body]) => ({ name, body, sig: {params: [], results: ['f64']} }))
  const summary = summarize([';'], {funcs, schemas: [], brandOf: () => null, imports: new Map(), exported: () => true})
  for (const name of ['empty', 'effect']) is(summary.resultContract(name).voidResult, true, name)
  for (const name of ['nil', 'undef']) is(summary.resultContract(name).voidResult, false, name)
})

test('summary contract: a direct-only BigInt result crosses raw; an export, a value, a dispatcher and a closure cross boxed', () => {
  const { summary, closureParams } = contractProgram()
  const direct = summary.resultContract('direct')
  is(direct.kind, kind(K.BIGINT)); is(direct.presence, PRESENCE.PRESENT); is(direct.carrier, CARRIER.RAW_I64)
  is(direct.abi.results, ['f64'], 'the ABI half stays the signature\'s')
  for (const name of ['exported', 'valued', 'dispatcher']) {
    const c = summary.resultContract(name)
    is(c.kind, kind(K.BIGINT), name); is(c.carrier, CARRIER.BOXED, `${name}: callers unknown, the BigInt crosses boxed`)
  }
  const closure = summary.resultContract(closureParams)
  is(closure.kind, kind(K.BIGINT)); is(closure.carrier, CARRIER.BOXED, 'a closure result crosses its any slot boxed')
  is(closure.abi.results, ['f64'])
  is(summary.resultContract(summary.at(closureParams).calleeOf(['()', 'cb', lit(1)])), closure, 'a scope resolves a bare-name call to its closure')
  is(summary.resultContract('missing').kind, K.NONE); is(summary.resultContract('missing').carrier, CARRIER.ANY)
})

test('summary contract: Number, narrowed i32, Boolean-or-Number, bare return and fallthrough', () => {
  const { summary, funcs } = contractProgram()
  const number = summary.resultContract('number')
  is(number.kind, kind(K.NUMBER)); is(number.carrier, CARRIER.F64); is(contractVal(number), VAL.NUMBER)
  const narrowed = summary.resultContract('narrowed')
  is(narrowed.carrier, CARRIER.I32, 'the range half\'s i32 is the contract\'s carrier')
  funcs.find(f => f.name === 'narrowed').sig.results = ['f64']
  is(summary.resultContract('narrowed').carrier, CARRIER.F64, 'the ABI half follows the signature the narrowing writes')
  is(narrowed.carrier, CARRIER.I32, 'a contract read is a value, not a view')
  const boolOrNumber = summary.resultContract('boolOrNumber')
  is(boolOrNumber.kind, join(kind(K.BOOL), kind(K.NUMBER))); is(boolOrNumber.carrier, CARRIER.F64)
  is(contractVal(boolOrNumber), null, 'two value kinds name no single one')
  const bare = summary.resultContract('bare')
  is(bare.presence, PRESENCE.MAYBE_NULL, 'a bare return completes with undefined'); is(contractVal(bare), VAL.NUMBER)
  const fallthrough = summary.resultContract('fallthrough')
  is(fallthrough.presence, PRESENCE.MAYBE_NULL); is(fallthrough.carrier, CARRIER.BOXED, 'a BigInt beside undefined is boxed')
})

test('summary contract: a closure set with Number and BigInt members, a BigInt beside a Number, an unbounded result', () => {
  const { summary, closureParams, numberParams } = contractProgram()
  const set = summary.calleeContract(['()', 'set', lit(1)])
  is(set.kind, join(kind(K.BIGINT), kind(K.NUMBER))); is(set.carrier, CARRIER.BOXED)
  is(summary.calleeContract(['()', 'cb', lit(1)]), summary.resultContract(closureParams))
  is(summary.resultContract(numberParams).carrier, CARRIER.F64)
  is(summary.kindOfExpr(['()', ['[]', 'table', 'index'], lit(1)]), join(kind(K.BIGINT), kind(K.NUMBER)), 'a call through a callee expression joins the set\'s results')
  is(summary.calleeContract(['()', ['[]', 'table', 'index'], lit(1)]), set, 'the table holds the set the solver interned')
  is(summary.calleeOf(['()', ['?:', lit(true), 'other', 'set'], lit(1)]), null, 'a pair the solver never joined is no set')
  const mixed = summary.resultContract('mixed')
  is(mixed.carrier, CARRIER.BOXED); is(contractVal(mixed), null)
  is(summary.resultContract('unbounded').carrier, CARRIER.ANY, 'an unbounded result names no carrier')
  is(summary.resultContract('erased').carrier, CARRIER.BOXED, 'a BigInt return the join to ANY erased is still boxed')
  is(summary.resultContract('through').carrier, CARRIER.BOXED, 'through a call to such a callable')
})

test('summary contract: postfix keeps the numeric operand\'s kind; an array literal reads its own cell', () => {
  const big = lit(9n), one = lit(1)
  const inc = ['=', ['.', 'o', 'n'], ['+1', ['.', 'o', 'n']]]
  const elem = ['=', ['[]', 'a', lit(0)], ['+1', ['[]', 'a', lit(0)]]]
  const funcs = [
    { name: 'member', sig: { params: [], results: ['f64'] }, body: ['{}', ['const', ['=', 'o', ['{}', [':', 'n', big]]]], ['return', ['postfix', inc]]] },
    { name: 'element', sig: { params: [], results: ['f64'] }, body: ['{}', ['const', ['=', 'a', ['[', big]]], ['return', ['postfix', elem]]] },
    { name: 'name', sig: { params: [], results: ['f64'] }, body: ['{}', ['let', ['=', 'n', big]], ['return', ['postfix', ['--', 'n']]]] },
    { name: 'plain', sig: { params: [], results: ['f64'] }, body: ['{}', ['let', ['=', 'n', big]], ['return', ['-', 'n', one]]] },
    { name: 'box', sig: { params: [{ name: 'v' }], results: ['f64'] }, body: ['[]', ['[', 'v'], lit(0)] },
  ]
  const summary = summarize([';', ['()', 'box', big], ['()', 'member', null], ['()', 'element', null], ['()', 'name', null], ['()', 'plain', null]], { funcs, schemas: [['n']], brandOf: () => null, imports: new Map(), exported: () => false })
  is(summary.resultContract('member').kind, kind(K.BIGINT), 'a member increment\'s old value is its own kind')
  is(summary.resultContract('element').kind, kind(K.BIGINT), 'an element inside a literal\'s count is there: its own kind')
  is(summary.resultContract('name').kind, kind(K.BIGINT), 'a name decrement\'s old value too')
  is(summary.resultContract('plain').kind, K.NONE, 'a genuine BigInt - Number never completes')
  is(summary.at('member').kindOfExpr(['postfix', inc]), kind(K.BIGINT), 'the query reads the update as the solver does')
  is(summary.resultContract('box').carrier, CARRIER.RAW_I64, 'a literal tuple has its BigInt element zero present')
  is(summary.at('box').kindOfExpr(['[', 'v']), summary.at('box').kindOfExpr(['[', 'v']))
})

// The return edge converts to the contract's carrier (slice 2): the query
// answers the carrier at both ends of an edge, so a caller reads one carrier
// whatever the callee's tails produced.
test('summary contract: a call through a dispatch table crosses boxed; the direct-only function returning it crosses raw', () => {
  const nodes = 'nodes', block = (...stmts) => ['{}', ...stmts]
  const handlerParams = [',', nodes]
  const handler = ['=>', handlerParams, block(['let', ['=', 'n', ['()', ['.', nodes, 'shift'], null]]], ['>>=', 'n', lit(7n)], ['return', 'n'])]
  const funcs = [
    { name: 'encode', sig: { params: [{ name: 'imm' }, { name: nodes }], results: ['f64'] }, body: ['()', ['[]', 'HANDLER', 'imm'], nodes] },
    { name: 'f', sig: { params: [], results: ['f64'] }, body: block(['let', ['=', 'ns', ['[', lit(900n)]]], ['return', ['()', 'encode', [',', lit('i64'), 'ns']]]) },
  ]
  const ast = [';', ['const', ['=', 'HANDLER', ['{}', [':', 'i64', handler]]]]]
  const summary = summarize(ast, { funcs, schemas: [['i64']], brandOf: () => null, imports: new Map(), exported: f => f.name === 'f' })
  const call = summary.at('encode').calleeContract(['()', ['[]', 'HANDLER', 'imm'], nodes])
  is(call.carrier, CARRIER.BOXED, 'the table\'s closure crosses its any slot boxed')
  is(summary.resultContract(handlerParams).carrier, CARRIER.BOXED)
  const encode = summary.resultContract('encode')
  is(encode.kind, kind(K.BIGINT)); is(encode.carrier, CARRIER.RAW_I64, 'a direct-only function returning that call crosses raw: its return edge unboxes')
  is(summary.resultContract('f').carrier, CARRIER.BOXED, 'the export returning it crosses boxed: its return edge boxes')
})

test('summary contract: a typed array callback\'s parameter is unbounded, its result boxed, the reduce\'s the element domain', () => {
  const params = [',', 'x'], accParams = [',', 'a', 'b']
  const typedArr = ['()', 'new.BigInt64Array', ['[', lit(2n), lit(3n)]]
  const funcs = [
    { name: 'mapped', sig: { params: [], results: ['f64'] }, body: ['[]', ['()', ['.', typedArr, 'map'], ['=>', params, ['+', 'x', lit(1n)]]], lit(1)] },
    { name: 'reduced', sig: { params: [], results: ['f64'] }, body: ['()', ['.', typedArr, 'reduce'], ['=>', accParams, ['+', 'a', 'b']]] },
  ]
  const summary = summarize([';', ['()', 'mapped', null], ['()', 'reduced', null]], { funcs, schemas: [], brandOf: () => null, imports: new Map(), exported: () => false })
  is(summary.at(params).kindOf('x'), kind(K.ANY), 'the map callback escapes: its parameter is every kind')
  is(summary.resultContract(params).carrier, CARRIER.BOXED, 'a BigInt among a bounded result crosses the closure ABI boxed')
  is(summary.at(accParams).kindOf('a'), kind(K.BIGINT), 'the reduce callback is bound: accumulator and element are the element kind')
  is(summary.resultContract(accParams).carrier, CARRIER.BOXED)
  is(summary.resultContract('reduced').kind, kind(K.BIGINT)); is(summary.resultContract('reduced').carrier, CARRIER.RAW_I64, 'the reduce result stays in the element domain')
})

test('summary contract: the plan\'s result target is the contract\'s carrier, boxed for an export', async () => {
  if (onKernel()) return
  const { representationResultRep, BIGINT_REP_BOXED, BIGINT_REP_CLOSED, BIGINT_REP_RAW } = await import('../src/compile/representation-plan.js')
  compile(`
    function parse(n) { if (typeof n === 'string') n = BigInt(n); n >>= 7n; return n }
    function inner(x) { return parse(x) }
    export function f(k) { return inner(k) }
    export let g = () => inner('900')
  `, { optimize: false })
  is(ctx.summary.resultContract('parse').carrier, CARRIER.RAW_I64, 'a direct-only BigInt result')
  is(ctx.summary.resultContract('inner').carrier, CARRIER.RAW_I64, 'through a direct call')
  is(ctx.summary.resultContract('f').carrier, CARRIER.BOXED, 'an export crosses boxed')
  is(representationResultRep(ctx, ctx.funcs.map.get('inner')), BIGINT_REP_RAW | BIGINT_REP_CLOSED, 'the plan\'s result target is the contract\'s carrier')
  is(representationResultRep(ctx, ctx.funcs.map.get('f')), BIGINT_REP_BOXED | BIGINT_REP_CLOSED)
  is(representationResultRep(ctx, ctx.funcs.map.get('g')), BIGINT_REP_BOXED | BIGINT_REP_CLOSED)
})


test('summary tuples: aliases, mutation and unions invalidate positional kinds', () => {
  for (const change of ["alias[0]='changed'", "alias.reverse()", "alias.shift()", "alias.length=0", "const k=n;delete alias[k]", "a=n?[false,2]:a", "alias['0']='changed'"]) {
    const source = `export const f=n=>{let a=[1,'x'];const alias=a;${change};return typeof a[0]}`
    const js = oracle(source).f
    for (const optimize of levels(0, 2, 3)) {
      const f = instantiate(compile(source, {optimize})).exports.f
      for (const n of [0, 1]) is(f(n), js(n), `O${optimize}: ${change}, n=${n}`)
    }
  }
})

test('summary tuples: dynamic reads and mutation expose nested field writes', () => {
  for (const change of [
    "const picked = pair[n]; if (n === 0) picked.sig = { n: 'changed' }",
    "const alias = pair; if (n) alias.reverse(); if (!n) alias[0].sig = { n: 'changed' }",
    "pair = n ? [{ sig: { n: 'other' } }, 'key'] : pair",
    "const alias = pair; if (n) alias[0] = { sig: { n: 'replaced' } }",
  ]) {
    const source = `export function f(n) {
      let pair = [{ sig: { n: 2 } }, 'key']
      ${change}
      return typeof pair[0] === 'object' ? pair[0].sig.n : pair[0]
    }`
    const js = oracle(source).f
    for (const optimize of levels(0, 2, 3)) {
      const { f } = instantiate(compile(source, { optimize })).exports
      for (const n of [0, 1, 0]) is(f(n), js(n), `O${optimize}: ${change}, n=${n}`)
    }
  }
})

test('summary storage: numeric locals preserve observable missing assignment results', () => {
  const src = `export function f(n) {
    const a = new Float64Array(n)
    if (n) a[0] = 3
    let x = a[0]
    const initial = x * 2
    const assigned = (x = a[n])
    return [initial, assigned === undefined, Number.isNaN(x * 2)].join(',')
  }`
  const js = oracle(src).f
  for (const optimize of levels(0, 1, 2, 3)) {
    const f = instantiate(compile(src, { optimize })).exports.f
    for (const n of [0, 1, 4]) is(f(n), js(n), `O${optimize}, length ${n}`)
  }
})

test('summary entry: an explicit numeric prologue retains JavaScript coercion', () => {
  const src = 'export function f(x) { x = +x; if (x > 0) return x; return -x }'
  const js = oracle(src).f
  for (const optimize of levels(0, 1, 2, 3)) {
    const f = instantiate(compile(src, { optimize })).exports.f
    for (const x of [undefined, null, true, false, '-3', 'bad', -0, 7])
      is(Object.is(f(x), js(x)), true, `O${optimize}, ${String(x)}`)
  }
})

test('summary presence: a fixed typed extent proves only its constant in-bounds reads', () => {
  const body = [';', ['const', ['=', 'n', lit(4)]],
    ['const', ['=', 'a', ['()', 'new.Float64Array', 'n']]],
    ['let', ['=', 'b', ['()', 'new.Float64Array', lit(4)]]],
    ['=', 'b', ['()', 'new.Float64Array', lit(0)]]]
  const s = summarize(body, { funcs: [], schemas: [], brandOf: () => null, imports: new Map(), exported: () => false })
  is(s.kindOfExpr(['[]', 'a', lit(0)]), kind(K.NUMBER))
  is(s.kindOfExpr(['[]', 'a', lit(4)]), join(kind(K.NUMBER), kind(K.ABSENT)))
  is(s.kindOfExpr(['[]', 'b', lit(0)]), join(kind(K.NUMBER), kind(K.ABSENT)))
})

test('summary clones: record updates preserve fields across object and hash copies', () => {
  const src = `export function f() {
    const records = new Map()
    const update = fields => {
      const prev = records.get('x')
      const next = prev ? {...prev, ...fields} : {...fields}
      let size = 0
      for (const key in next) if (next[key] !== undefined) size++
      for (const key in fields) if (fields[key] === undefined) delete next[key]
      if (size) records.set('x', next)
      return size
    }
    const a = update({value: 'number'})
    const b = update({presence: 'present', cleared: undefined})
    return [a, b, records.get('x').value, records.get('x').presence].join(',')
  }`
  const expected = oracle(src).f()
  for (const optimize of levels(0, 1, 2, 3))
    is(instantiate(compile(src, { optimize })).exports.f(), expected, `O${optimize}`)
})

test('summary spreads: conditional keys retain dictionary representation', () => {
  const src = `export function f(flag) {
    const make = x => ({name: 'f', sig: {params: [1, 2]}, ...(x && {extra: 3})})
    const records = new Map([['f', make(flag)]])
    return [...records.values()].map(r => r.sig.params.length + (Object.keys(r).includes('extra') ? 10 : 0))[0]
  }`
  const js = oracle(src).f
  for (const optimize of levels(0, 1, 2, 3)) {
    const f = instantiate(compile(src, { optimize })).exports.f
    for (const flag of [false, true]) is(f(flag), js(flag), `O${optimize}, ${flag}`)
  }
})

test('summary cells: numeric reseeding retains constructor contents before later writes', () => {
  const src = `export function f(n) {
    const m = new Map([['first', 'text']])
    m.set('later', {sig: 7})
    return typeof m.get('first') + ':' + (n * 2)
  }`
  const js = oracle(src).f
  for (const optimize of levels(0, 1, 2, 3)) {
    const f = instantiate(compile(src, { optimize })).exports.f
    is(f(3), js(3), `O${optimize}`)
  }
})

test('summary containers: enum values and entry tuples feed numeric Map payloads', () => {
  const src = `const tags = Object.freeze({a: 'a', b: 'b'})
    const bits = new Map(Object.values(tags).map((name, i) => [name, 1 << i]))
    const bit = name => bits.get(name) || 0
    const pack = (mask, flag) => mask | (flag ? 8 : 0)
    export const f = () => pack(7 & ~bit(tags.b), true)`
  for (const optimize of levels(0, 1, 2, 3)) {
    const binary = _compileInProcess(src, { optimize })
    _compileInProcess(src, { optimize: { level: optimize, sourceInline: false, inlineFns: false } })
    is(ctx.summary.resultOf('bit'), kind(K.NUMBER), 'Map construction retains entry value kinds')
    is(instantiate(onKernel() ? compile(src, { optimize }) : binary).exports.f(), 13, `O${optimize}`)
  }
})

test('summary containers: mapped entry payloads settle after missing callback results', () => {
  const entries = [['1 << i', K.NUMBER], ['name + i', K.STRING], ['i === 0', K.BOOL]]
  let retained
  for (const [value, payload] of entries) for (const tags of ['{}', "{a:'a'}", "{a:'a'}", "{a:'a',b:'b'}", "{a:'a'}"])
    for (const optimize of levels(0, 1, 2, 3, 'size')) {
      const src = `const tags = ${tags}
        const bits = new Map(Object.values(tags).map((name, i) => [name, ${value}]))
        export function f() { return [bits.get('a'), bits.get('b'), bits.get('missing')] }`
      const binary = _compileInProcess(src, { optimize: { level: optimize, sourceInline: false } })
      if (tags !== '{}') {
        is(ctx.summary.at(null).elemKindOf('bits'), kind(payload), `${value}: the completed entry supplies its payload`)
        if (!retained) retained = ctx.summary
      }
      if (retained) is(retained.at(null).elemKindOf('bits'), kind(K.NUMBER), 'later solver rounds leave the published snapshot intact')
      const actual = instantiate(onKernel() ? compile(src, { optimize }) : binary).exports, expected = oracle(src)
      is(actual.f(), expected.f(), `${value}, ${tags}, O${optimize}`)
      is(actual.f(), expected.f(), 'same instance repeats the mapped entry read')
    }
})

test('summary spreads: a schema does not exclude properties added through aliases', () => {
  const src = `const extend = (env, key) => { const next = {...env}; next[key] = 1; return next }
    const merge = env => ({...env, done: true})
    export function f() {
      const a = extend({}, 'outer'), b = extend(a, 'inner'), c = merge(b)
      b.inner = 2
      return [Object.keys(a).sort().join(','), Object.keys(c).sort().join(','), c.inner].join(';')
    }`
  const js = oracle(src).f
  for (const optimize of levels(0, 1, 2, 3))
    is(instantiate(compile(src, { optimize })).exports.f(), js(), `O${optimize}`)
})

test('summary spreads: entry snapshots preserve duplicate keys and interleaved alias writes', () => {
  let retained
  for (const value of [300n, 300n, 'changed', 300n]) {
    const literal = typeof value === 'bigint' ? value + 'n' : JSON.stringify(value)
    const src = `export function f(key, mode) {
      let calls = 0
      const first = mode ? { value: 1, keep: 2 } : {}
      const alias = first
      const getter = { get value() { calls++; return ${literal} } }
      const copy = { ...first,
        marker: (alias[key] = ${literal}, alias.keep = 4, 7),
        ...first, ...(mode ? getter : {}), value: ${literal} }
      return [Object.keys(copy), Object.values(copy), Object.entries(copy),
        first[key], copy.value, copy.keep, calls]
    }`
    const js = oracle(src).f
    for (const level of levels(0, 2)) {
      const run = instantiate(compile(src, { optimize: level })).exports.f
      for (const [key, mode] of [['value', 0], ['value', 1], ['extra', 1], ['', 1], ['extra', 0], ['value', 1]])
        is(run(key, mode), js(key, mode), `O${level}: duplicate/spread/key=${JSON.stringify(key)}/mode=${mode}`)
      throws(() => compile('export const copy = { value: 0, ...{}, value: 1 }'), /duplicate object keys mixed with spread/, 'unsupported static duplicates fail before later reuse')
      retained ??= run
      const original = oracle(src.replaceAll(literal, '300n')).f
      is(retained('extra', 1), original('extra', 1), 'later compiles preserve an earlier copy implementation')
    }
  }
})

test('summary spreads: pending sources retain known sibling shapes', () => {
  const src = `const defaults=Object.freeze({number:{x:1},array:{x:2}})
    const carriers=Object.freeze({number:{x:3},array:{x:4}})
    function make(){return {...defaults,carriers}}
    export function f(){return make().number.x+make().carriers.array.x}`
  for (const optimize of levels(0, 1, 2, 3)) {
    // the summary read is of the program the plan rewrote: with the inliner on, `make` is spliced into `f` and reached no more
    _compileInProcess(src, { optimize: { level: optimize, sourceInline: false, inlineFns: false } })
    is(ctx.summary.resultVal('make'), VAL.OBJECT, 'spread settles to a record without escaping siblings')
    const binary = _compileInProcess(src, { optimize })
    const f = instantiate(onKernel() ? compile(src, { optimize }) : binary).exports.f
    is(f(), 5, `O${optimize}`)
    is(f(), 5, 'repeated call')
  }
})

test('summary modules: default values declare their imported object and callable facts', () => {
  const src = `import record from './record.js'; import scale from './scale.js'
    export const f = () => scale(record.value)`
  const modules = {
    './record.js': 'export const record={value:7}; export default record',
    './scale.js': 'const scale=x=>x*3; export default scale',
  }
  for (const optimize of levels(0, 1, 2, 3)) {
    const binary = _compileInProcess(src, { optimize, modules })
    is(ctx.summary.resultVal('f'), VAL.NUMBER, 'default imports participate in analysis')
    const f = instantiate(onKernel() ? compile(src, { optimize, modules }) : binary).exports.f
    is(f(), 21, `O${optimize}`)
    is(f(), 21, 'repeated call')
  }
})

test('summary shapes: bounded joins and their overflow keep BigInt fields readable', () => {
  for (const count of [2, 16, 17]) {
    const cases = Array.from({ length: count }, (_, i) =>
      `if(k===${i})return {field${i}:0,value:${i}n}`).join(';')
    const src = `function pick(k){${cases};return {field0:0,value:0n}}
      function read(k){return pick(k).value} export function f(k){return read(k)}`
    for (const optimize of levels(0, 1, 2, 3)) {
      // `read` answers as a function where the plan keeps it one: from O1 up it splices into `f`
      _compileInProcess(src, { optimize: { level: optimize, sourceInline: false, inlineFns: false } })
      if (count <= 16) is(ctx.summary.resultOf('read'), kind(K.BIGINT), 'retained shapes agree on the field kind')
      const binary = _compileInProcess(src, { optimize })
      const f = instantiate(onKernel() ? compile(src, { optimize }) : binary).exports.f
      for (const k of [0, 0, count - 1, 1, -1, 0])
        is(f(k), BigInt(k < 0 ? 0 : k), `${count} shapes, O${optimize}, input ${k}`)
    }
  }
})

test('summary objects: construction identity is separate from field layout', () => {
  const params = [',', 'context']
  const call = ['()', ['.', 'ops', 'value'], 'context']
  const ast = [';',
    ['const', ['=', 'ops', ['{}', [':', 'value', ['=>', params, ['.', 'context', 'count']]]]]],
    ['const', ['=', 'signature', ['{}', [':', 'value', ['{}', [':', 'count', lit('descriptor')]]]]]],
    ['const', ['=', 'context', ['{}', [':', 'count', lit(7)]]]],
    ['const', ['=', 'answer', call]],
  ]
  const summary = summarize(ast, {
    funcs: [], schemas: [['value'], ['count']], brandOf: () => null,
    imports: new Map(), exported: () => false,
  })
  is(summary.sidOf('ops'), summary.sidOf('signature'), 'both objects retain the same physical layout')
  is(summary.kindOf('answer'), kind(K.NUMBER), 'a descriptor object cannot erase an unrelated callable')
  is(summary.at(params).kindOf('context'), kind(K.OBJECT, 1), 'the known call retains its argument')
  is(summary.kindOfExpr(['.', 'context', 'count']), kind(K.NUMBER))
  is(summary.fieldKind(1, 'count'), join(kind(K.NUMBER), kind(K.STRING)), 'storage facts join every allocation using the layout')
  is(summary.escaped.size, 0, 'layout sharing does not escape values')
  const before = summary.kindOf('answer')
  summary.kindOfExpr(['.', ['{}', [':', 'count', lit(false)]], 'count'])
  is(summary.kindOf('answer'), before, 'hypothetical reads do not mutate retained facts')
})

test('summary objects: aliases write their allocation while unrelated records stay precise', () => {
  const ast = [';',
    ['const', ['=', 'a', ['{}', [':', 'value', lit(1)]]]],
    ['const', ['=', 'b', ['{}', [':', 'value', lit('b')]]]],
    ['const', ['=', 'alias', 'a']],
    ['=', ['.', 'alias', 'value'], lit(true)],
    ['const', ['=', 'joined', ['?', lit(true), 'a', 'b']]],
    ['=', ['.', 'joined', 'value'], lit(2n)],
  ]
  const summary = summarize(ast, {
    funcs: [], schemas: [['value']], brandOf: () => null,
    imports: new Map(), exported: () => false,
  })
  is(summary.kindOfExpr(['.', 'a', 'value']), join(join(kind(K.NUMBER), kind(K.BOOL)), kind(K.BIGINT)))
  is(summary.kindOfExpr(['.', 'b', 'value']), join(kind(K.STRING), kind(K.BIGINT)))
  is(summary.sidOf('joined'), 0, 'an allocation union can still have one layout')
  is(summary.fieldKind(0, 'value'), join(join(join(kind(K.NUMBER), kind(K.BOOL)), kind(K.STRING)), kind(K.BIGINT)))
})

test('summary objects: repeated factories, aliases, joins and unknown writes preserve JS values', () => {
  const src = `function make(v){return {value:v}}
    function read(o){return o.value}
    const ops={value:o=>o.count}, signature={value:{count:'descriptor'}}
    export function f(flag){
      const a=make(1), b=make('two'), alias=a, context={count:7}
      alias.value=3
      const joined=flag?a:b
      joined.value=5n
      return [String(read(a)),String(read(b)),ops.value(context),signature.value.count].join(':')
    }`
  const js = oracle(src).f
  for (const optimize of levels(0, 1, 2, 3)) {
    const f = instantiate(compile(src, {optimize})).exports.f
    for (const flag of [0, 0, 1, 0]) is(f(flag), js(flag), `O${optimize}, ${flag}`)
  }
})

test('summary objects: testing or discarding a callable does not open its arguments', () => {
  const src = `const ops={run:context=>context.value}
    function read(flag){
      const context={value:7}
      if(flag && ops.run) ops.run(context)
      flag ? ops.run : 0
      flag || ops.run
      return (flag ? ops.run : 0, ops.run(context))
    }
    export function f(flag){return read(flag)}`
  for (const optimize of levels(0, 1, 2, 3)) {
    // the summary read is of the program the plan rewrote: with the inliner on, `read` is spliced into `f` and reached no more
    _compileInProcess(src, { optimize: { level: optimize, sourceInline: false, inlineFns: false } })
    is(ctx.summary.resultOf('read'), kind(K.NUMBER), 'a discarded join creates no unknown caller')
    const binary = _compileInProcess(src, {optimize})
    const f = instantiate(onKernel() ? compile(src, {optimize}) : binary).exports.f
    for (const flag of [0, 0, 1, 0]) is(f(flag), 7)
  }
})

test('summary objects: allocation-set capacity and overflow keep storage conservative', () => {
  for (const count of [0, 1, 32, 33]) {
    const ast = [';', ['let', 'selected']]
    for (let i = 0; i < count; i++) {
      const name = 'record' + i
      ast.push(['const', ['=', name, ['{}', [':', 'value', lit(BigInt(i))]]]])
      ast.push(['=', 'selected', i ? ['?', 'flag', name, 'selected'] : name])
    }
    const summary = summarize(ast, {
      funcs: [], schemas: [['value']], brandOf: () => null,
      imports: new Map(), exported: () => false,
    })
    // Past the set's capacity the layout's sites fold into it: one shape, joined slots.
    is(summary.objectSidOfExpr('selected'), count ? 0 : null, `${count} construction sites`)
    is(summary.fieldKind(0, 'value'), count ? kind(K.BIGINT) : K.NONE)
    is(summary.opaqueSchema(0), count > 1, 'joined or lost allocations use tagged storage')
  }
})

test('summary objects: losing one allocation does not poison an unrelated record of the same layout', () => {
  const summary = summarize([';',
    ['const', ['=', 'a', ['{}', [':', 'value', lit(1)]]]],
    ['const', ['=', 'b', ['{}', [':', 'value', lit('b')]]]],
    ['()', 'Object.assign', [',', 'a', 'outside']],
    ['=', ['[]', 'outside', 'key'], lit(true)],
  ], {
    funcs: [], schemas: [['value']], brandOf: () => null,
    imports: new Map(), exported: () => false,
  })
  is(summary.kindOfExpr(['.', 'a', 'value']), kind(K.ANY))
  is(summary.kindOfExpr(['.', 'b', 'value']), kind(K.STRING))
  is(summary.fieldKind(0, 'value'), kind(K.ANY), 'the physical slot still accommodates either allocation')
})

test('summary reads: unknown keys revisit late nested fields across reseeding and reuse', () => {
  for (const read of [null, ['[]', 'outside', 'key'], ['()', 'Object.values', 'outside'], ['()', 'Object.entries', 'outside']]) {
    let retained
    for (const value of [1n, 1n, 'changed', 1n]) for (const reseed of [false, true]) {
      // Property order puts the innermost slots before their parent. Losing
      // the outer shape must revisit children discovered by the later walk.
      const ast = [';', ...(read ? [read, read] : []),
        ['const', ['=', 'leaf', ['{}', [':', 'value', lit(value)]]]],
        ['const', ['=', 'middle', ['{}', [':', 'child', 'leaf']]]],
        ['const', ['=', 'outer', ['{}', [':', 'item', 'middle']]]],
        ['const', ['=', 'lost', ['?', 'flag', 'outer', 'outside']]],
      ]
      const summary = summarize(ast, {
        funcs: reseed ? [{ name: 'scale', sig: { params: [{ name: 'n' }] }, body: ['*', 'n', lit(2)] }] : [],
        schemas: [['value'], ['child'], ['item']], brandOf: () => null, imports: new Map(), exported: () => true,
      })
      is(summary.opaqueSchema(0), !!read, 'an unknown field read exposes the late nested leaf')
      is(summary.opaqueSchema(1), !!read, 'the intermediate object is exposed too')
      is(summary.opaqueSchema(2), true, 'the outer object lost its shape at the unknown join')
      is(summary.fieldKind(0, 'value'), kind(typeof value === 'bigint' ? K.BIGINT : K.STRING), 'the stored field kind survives')
      if (reseed) is(summary.at('scale').kindOf('n'), kind(K.NUMBER), 'numeric demand reran kinds')
      retained ??= summary
      is(retained.fieldKind(0, 'value'), kind(K.BIGINT), 'later summaries do not mutate earlier readers')
    }
    is(summarize(null, { funcs: [], schemas: [], brandOf: () => null, imports: new Map(), exported: () => false }).unnamedLayouts,
      [], 'empty work after the sequence retains no read effect')
  }
})

test('summary reads: numeric unknown keys expose Number names without opening named closures', () => {
  const numeric = ['0', '-1', '1.5', 'NaN', 'Infinity', '-Infinity', '1e+21', '0.000001', '1e-7']
  const named = ['', '-0', '01', '+1', '1.0', '1e21', ' 1', 'encode', 'undefined', 'null']
  const props = [...numeric, ...named]
  const funcs = props.map((_, i) => ({ name: 'f' + i, sig: { params: [{ name: 'x' }] }, body: 'x' }))
  let retained
  for (const [key, narrow, exact] of [
    [lit(-0), true], [lit(NaN), true], [lit(Infinity), true], [['u+', 'outside'], true],
    ['outside', false], [['?', 'flag', lit(0), lit(undefined)], false],
    [['?', 'flag', lit(0), lit(null)], false], [['?', 'flag', lit(0), ['str', 'encode']], false],
    [['str', '0'], false, '0'], [['str', '-0'], false, '-0'],
  ]) for (const early of [false, true]) for (const reseed of [false, true]) {
    const read = ['var', ['=', 'read', ['[]', 'outside', key]]]
    const ast = [';', ...(early ? [read, read] : []),
      ['const', ['=', 'o', ['{}', ...props.map((p, i) => [':', p, 'f' + i])]]],
      ['const', ['=', 'lost', ['?', 'flag', 'o', 'outside']]],
      ...funcs.map(f => ['()', f.name, lit(1)]), ...(early ? [] : [read, read]),
    ]
    const summary = summarize(ast, {
      funcs: reseed ? [...funcs, { name: 'scale', sig: { params: [{ name: 'n' }] }, body: ['*', 'n', lit(2)] }] : funcs,
      schemas: [props], brandOf: () => null, imports: new Map(), exported: f => f.name === 'scale',
    })
    for (let i = 0; i < props.length; i++) {
      const exposed = exact === undefined ? !narrow || i < numeric.length : props[i] === exact
      is(summary.escaped.has('f' + i), exposed, `${props[i]}: numeric=${narrow}, early=${early}, reseed=${reseed}`)
      is(summary.at('f' + i).paramKindOf('x'), kind(exposed ? K.ANY : K.NUMBER), 'exposed closures admit unknown callers')
    }
    if (reseed) is(summary.at('scale').kindOf('n'), kind(K.NUMBER), 'numeric demand reran the effects')
    retained ??= summary
    is(retained.at('f' + numeric.length).paramKindOf('x'), kind(K.NUMBER), 'later broad effects leave the retained reader unchanged')
  }
})

test('summary reads: numeric unknown keys invoke numeric getters and expose their results', () => {
  const funcs = [
    { name: 'numeric', sig: { params: [] }, body: 'leaf' },
    { name: 'named', sig: { params: [] }, body: lit(0) },
    { name: 'setter', sig: { params: [{ name: 'x' }] }, body: 'x' },
    { name: 'leaf', sig: { params: [{ name: 'x' }] }, body: 'x' },
  ]
  const ast = [';',
    ['const', ['=', 'o', ['{}', [':', '0__get', 'numeric'], [':', 'name__get', 'named'], [':', '0__set', 'setter']]]],
    ['const', ['=', 'lost', ['?', 'flag', 'o', 'outside']]],
    ['var', ['=', 'read', ['[]', 'outside', ['u+', 'key']]]],
  ]
  const summary = summarize(ast, { funcs, schemas: [['0__get', 'name__get', '0__set']],
    brandOf: () => null, imports: new Map(), exported: () => false, accessors: new Set(['0', 'name']) })
  is(summary.escaped.has('numeric'), true, 'the numeric getter may run through the unknown receiver')
  is(summary.escaped.has('leaf'), true, 'its returned closure reaches an unknown caller')
  is(summary.escaped.has('named'), false, 'a numeric key cannot invoke a named getter')
  is(summary.escaped.has('setter'), false, 'reading the numeric property does not invoke its setter')
  const broad = ['var', ['=', 'read', ['[]', 'outside', 'key']]]
  for (const input of [[';', broad, ast], [';', ast, broad]]) {
    const joined = summarize(input, { funcs, schemas: [['0__get', 'name__get', '0__set']],
      brandOf: () => null, imports: new Map(), exported: () => false, accessors: new Set(['0', 'name']) })
    for (const f of funcs) is(joined.escaped.has(f.name), true, 'numeric and arbitrary key effects accumulate in either order')
  }
})

test('summary stores: repeated effects replay on late host shapes and after numeric reseeding', () => {
  for (const early of [false, true]) for (const numericFirst of [false, true]) for (const reseed of [false, true]) {
    const record = ['const', ['=', 'a', ['{}', [':', '0', lit(1)], [':', 'value', lit(2)]]]]
    const numeric = ['=', ['[]', 'outside', lit(0)], lit(true)]
    const named = ['=', ['[]', 'outside', 'key'], ['str', 'x']]
    const stores = numericFirst ? [numeric, named] : [named, numeric]
    const ast = [';', ...(early ? [record] : []), ...stores, ...stores, ...(early ? [] : [record]), ...stores]
    const summary = summarize(ast, {
      funcs: reseed ? [{ name: 'scale', sig: { params: [{ name: 'n' }] }, body: ['*', 'n', lit(2)] }] : [],
      schemas: [['0', 'value']], brandOf: () => null, imports: new Map(), exported: () => true, hostGlobals: ['a'],
    })
    is(summary.fieldKind(0, '0'), kind(K.ANY), `early=${early}, numericFirst=${numericFirst}, reseed=${reseed}: both effects reach the index`)
    is(summary.fieldKind(0, 'value'), join(kind(K.NUMBER), kind(K.STRING)), 'numeric stores leave named fields precise')
    if (reseed) is(summary.at('scale').kindOf('n'), kind(K.NUMBER), 'the demand pass reran kinds with a numeric parameter')
  }
})

test('summary stores: number keys reach every canonical number name and only those names', () => {
  const numeric = ['0', '-1', '1.5', 'NaN', 'Infinity', '-Infinity', '1e+21', '0.000001', '1e-7']
  const named = ['', '-0', '01', '+1', '1.0', '1e21', ' 1', 'value']
  const props = [...numeric, ...named]
  for (const host of [false, true]) for (const early of [false, true]) {
    const record = ['const', ['=', 'a', ['{}', ...props.map(p => [':', p, lit(true)])]]]
    const store = ['=', ['[]', host ? 'outside' : 'a', ['u+', 'key']], lit(5)]
    const summary = summarize([';', ...(early ? [store] : []), record, store], {
      funcs: [], schemas: [props], brandOf: () => null, imports: new Map(), exported: () => false,
      hostGlobals: host ? ['a'] : [],
    })
    for (const p of numeric) is(summary.fieldKind(0, p), kind(K.ANY), `host=${host}, early=${early}, ${p}`)
    for (const p of named) is(summary.fieldKind(0, p), kind(K.BOOL), `noncanonical ${JSON.stringify(p)} stays precise`)
  }
})

test('summary objects: exhausted site IDs retain conservative layout storage', () => {
  const schemas = Array.from({length: 1 << 15}, (_, i) => i ? [] : ['value'])
  const summary = summarize([';',
    ['const', ['=', 'a', ['{}', [':', 'value', lit(1)]]]],
    ['const', ['=', 'b', ['{}', [':', 'value', lit('text')]]]],
  ], {funcs: [], schemas, brandOf: () => null, imports: new Map(), exported: () => false})
  is(summary.sidOf('a'), 0)
  is(summary.sidOf('b'), null)
  is(summary.fieldKind(0, 'value'), kind(K.ANY), 'overflow cannot leave a numeric-only physical slot')
})
