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

test('summary contract: prepare\'s postfix recovery keeps the operand\'s kind; an array literal reads its own cell', () => {
  const big = lit(9n), one = lit(1)
  const inc = ['=', ['.', 'o', 'n'], ['+1', ['.', 'o', 'n']]]
  const elem = ['=', ['[]', 'a', lit(0)], ['+1', ['[]', 'a', lit(0)]]]
  const funcs = [
    { name: 'member', sig: { params: [], results: ['f64'] }, body: ['{}', ['const', ['=', 'o', ['{}', [':', 'n', big]]]], ['return', ['-', inc, one]]] },
    { name: 'element', sig: { params: [], results: ['f64'] }, body: ['{}', ['const', ['=', 'a', ['[', big]]], ['return', ['-', elem, one]]] },
    { name: 'name', sig: { params: [], results: ['f64'] }, body: ['{}', ['let', ['=', 'n', big]], ['return', ['+', ['--', 'n'], one]]] },
    { name: 'plain', sig: { params: [], results: ['f64'] }, body: ['{}', ['let', ['=', 'n', big]], ['return', ['-', 'n', one]]] },
    { name: 'box', sig: { params: [{ name: 'v' }], results: ['f64'] }, body: ['[]', ['[', 'v'], lit(0)] },
  ]
  const summary = summarize([';', ['()', 'box', big], ['()', 'member', null], ['()', 'element', null], ['()', 'name', null], ['()', 'plain', null]], { funcs, schemas: [['n']], brandOf: () => null, imports: new Map(), exported: () => false })
  is(summary.resultContract('member').kind, kind(K.BIGINT), 'a member increment\'s old value is its own kind')
  is(summary.resultContract('element').kind, join(kind(K.BIGINT), kind(K.NUMBER)), 'an absent-capable element reads undefined too, whose ToNumeric is NaN')
  is(summary.resultContract('name').kind, kind(K.BIGINT), 'a name decrement\'s old value too')
  is(summary.resultContract('plain').kind, K.NONE, 'a genuine BigInt - Number never completes')
  is(summary.at('member').kindOfExpr(['-', inc, one]), kind(K.BIGINT), 'the query reads the recovery as the solver does')
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
    is(ctx.summary.resultOf('bit'), kind(K.NUMBER), 'Map construction retains entry value kinds')
    is(instantiate(onKernel() ? compile(src, { optimize }) : binary).exports.f(), 13, `O${optimize}`)
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
      const binary = _compileInProcess(src, { optimize })
      if (count <= 16) is(ctx.summary.resultOf('read'), kind(K.BIGINT), 'retained shapes agree on the field kind')
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
    const binary = _compileInProcess(src, {optimize})
    is(ctx.summary.resultOf('read'), kind(K.NUMBER), 'a discarded join creates no unknown caller')
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
