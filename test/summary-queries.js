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
    ['()', 'cb', lit(1)], ['()', 'set', lit(1)], ['()', ['[]', 'table', 'index'], lit(1)],
    ['()', 'erased', lit('any')], ['()', 'through', lit('any')], ['()', 'unbounded', lit('any')],
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
  const summary = summarize([';'], { funcs, schemas: [], brandOf: () => null, imports: new Map(), exported: () => false })
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
    const js = Function(source.replace('export ', '') + ';return f')()
    for (const optimize of [0, 2, 3]) {
      const f = instantiate(compile(source, {optimize})).exports.f
      for (const n of [0, 1]) is(f(n), js(n), `O${optimize}: ${change}, n=${n}`)
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
  const js = Function(src.replace('export ', '') + ';return f')()
  for (const optimize of [0, 1, 2, 3]) {
    const f = instantiate(compile(src, { optimize })).exports.f
    for (const n of [0, 1, 4]) is(f(n), js(n), `O${optimize}, length ${n}`)
  }
})

test('summary entry: an explicit numeric prologue retains JavaScript coercion', () => {
  const src = 'export function f(x) { x = +x; if (x > 0) return x; return -x }'
  const js = Function(src.replace('export ', '') + ';return f')()
  for (const optimize of [0, 1, 2, 3]) {
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
  const expected = Function(src.replace('export ', '') + ';return f')()()
  for (const optimize of [0, 1, 2, 3])
    is(instantiate(compile(src, { optimize })).exports.f(), expected, `O${optimize}`)
})

test('summary spreads: conditional keys retain dictionary representation', () => {
  const src = `export function f(flag) {
    const make = x => ({name: 'f', sig: {params: [1, 2]}, ...(x && {extra: 3})})
    const records = new Map([['f', make(flag)]])
    return [...records.values()].map(r => r.sig.params.length + (Object.keys(r).includes('extra') ? 10 : 0))[0]
  }`
  const js = Function(src.replace('export ', '') + ';return f')()
  for (const optimize of [0, 1, 2, 3]) {
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
  const js = Function(src.replace('export ', '') + ';return f')()
  for (const optimize of [0, 1, 2, 3]) {
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
  for (const optimize of [0, 1, 2, 3]) {
    const binary = compile(src, { optimize })
    is(ctx.summary.resultOf('bit'), kind(K.NUMBER), 'Map construction retains entry value kinds')
    is(instantiate(binary).exports.f(), 13, `O${optimize}`)
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
  const js = Function(src.replace('export ', '') + ';return f')()
  for (const optimize of [0, 1, 2, 3])
    is(instantiate(compile(src, { optimize })).exports.f(), js(), `O${optimize}`)
})
