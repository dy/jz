import test from 'tst'
import { is, throws } from 'tst/assert.js'
import { summarize, K, kind, join, CARRIER, PRESENCE, contractVal } from '../src/summary/index.js'
import { VAL } from '../src/reps.js'
import { compile } from '../index.js'
import { ctx } from '../src/ctx.js'
import { instantiate } from '../interop.js'
import { execFileSync } from 'node:child_process'
import { onKernel } from './_matrix.js'
import { BRAND } from '../src/ast.js'

const lit = value => [null, value]
const typed = ['()', 'new.BigInt64Array', lit(0)]
const reduce = (callback, initial) => ['()', ['.', typed, 'reduce'], [',', callback, initial]]

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
  const summary = summarize(['const', ['=', 'record', ['{}', [':', brand, lit(true)], [':', 'x', lit(1)]]]], {
    funcs: [{ name: 'method', sig: { params: [{ name: 'self' }] }, body: lit(7) }],
    schemas: [['x']], classes, imports, exported: () => false,
    brandOf: () => { if (!allowBrandLookup) throw new Error('reader consulted the live registry'); return brand },
  })
  const call = ['()', ['.', 'record', 'value'], null]
  is(summary.kindOfExpr(call), kind(K.NUMBER))
  is(summary.classCallee('record', 'value'), 'method')
  is(summary.classCallee('record', 'missing'), null)
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
  const A = 'export function make(){return {buf:new Float32Array(2),gain:3}} export function main(){return make().buf.length}'
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
    ['const', ['=', 'set', ['?:', lit(true), closure, numberClosure]]],
    ['const', ['=', 'table', ['[', closure, numberClosure]]],
    ['()', 'cb', lit(1)], ['()', 'set', lit(1)], ['()', ['[]', 'table', lit(0)], lit(1)],
    ['()', 'erased', lit('any')], ['()', 'through', lit('any')], ['()', 'unbounded', lit('any')],
  ]
  const summary = summarize(ast, { funcs, schemas: [], brandOf: () => null, imports: new Map(), exported: f => f.name === 'exported' || f.name === 'erased' || f.name === 'through' || f.name === 'unbounded' })
  return { summary, closureParams, numberParams, funcs }
}

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
  is(summary.kindOfExpr(['()', ['[]', 'table', lit(0)], lit(1)]), join(kind(K.BIGINT), kind(K.NUMBER)), 'a call through a callee expression joins the set\'s results')
  is(summary.calleeContract(['()', ['[]', 'table', lit(0)], lit(1)]), set, 'the table holds the set the solver interned')
  is(summary.calleeOf(['()', ['?:', lit(true), 'cb', 'set'], lit(1)]), null, 'a pair the solver never joined is no set')
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
  const summary = summarize(['()', 'box', big], { funcs, schemas: [['n']], brandOf: () => null, imports: new Map(), exported: () => false })
  is(summary.resultContract('member').kind, kind(K.BIGINT), 'a member increment\'s old value is its own kind')
  is(summary.resultContract('element').kind, join(kind(K.BIGINT), kind(K.NUMBER)), 'an absent-capable element reads undefined too, whose ToNumeric is NaN')
  is(summary.resultContract('name').kind, kind(K.BIGINT), 'a name decrement\'s old value too')
  is(summary.resultContract('plain').kind, K.NONE, 'a genuine BigInt - Number never completes')
  is(summary.at('member').kindOfExpr(['-', inc, one]), kind(K.BIGINT), 'the query reads the recovery as the solver does')
  is(summary.resultContract('box').carrier, CARRIER.BOXED, 'an element of an array literal is its cell\'s kind, absent-capable')
  is(summary.at('box').kindOfExpr(['[', 'v']), summary.at('box').kindOfExpr(['[', 'v']))
})
