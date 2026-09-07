import test from 'tst'
import { is, throws } from 'tst/assert.js'
import { summarize, K, kind } from '../src/summary/index.js'
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
