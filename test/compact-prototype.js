import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import compileCompact, { compileCompactAst } from '../prototype/compact/compiler.js'
import compileDirect from '../prototype/compact/direct.js'
import { generateDirectCallGraph } from '../prototype/compact/graph-corpus.js'
import { lowerProgram } from '../prototype/compact/lower.js'
import { prepareCompactAst } from '../prototype/compact/prepare.js'
import {
  ABI_RAW, I_ABI_MODE, I_EDGE_TARGET, I_EXACT_I32_OWNS_TYPE, I_EXACT_I32_TYPE_ID,
  I_EXACT_I32_WASM_ID,
  I_FN_EDGE_COUNT, I_FN_EDGE_START, I_FN_REACHABLE,
  I_FN_RESULT_REP, I_FN_TYPE_ID, I_FN_WASM_ID, I_TYPE_PARAM_COUNT, I_TYPE_RESULT_REP,
  REP_F64, REP_I32, REP_U32,
  buildProgramIndex, functionCount,
} from '../prototype/compact/program-index.js'
import { parse } from '../src/parse.js'
import { scalarCase, scalarCasesIn, SCALAR_CORE_CASES } from './_scalar-core-cases.js'

const instantiate = (source) => new WebAssembly.Instance(new WebAssembly.Module(compileCompact(source))).exports
const instantiateRaw = (source, options) => new WebAssembly.Instance(new WebAssembly.Module(
  compileCompact(source, { ...options, abi: 'raw' }),
)).exports
const sameNumber = (a, b) => Object.is(a, b) || Number.isNaN(a) && Number.isNaN(b)
const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i])

test('compact prototype: smallest module and ULEB count boundary', () => {
  const smallest = compileCompact('export let f=()=>0')
  is(smallest.length, 41)
  is(new WebAssembly.Instance(new WebAssembly.Module(smallest)).exports.f(), 0)

  const folded = compileCompact('export let f=()=>1+2*3')
  is(folded.length, 41)
  is(new WebAssembly.Instance(new WebAssembly.Module(folded)).exports.f(), 7)

  const pair = instantiate('export let a=()=>1;export let b=()=>2')
  is(pair.a(), 1)
  is(pair.b(), 2)

  for (const count of [127, 128]) {
    const params = Array.from({ length: count }, (_, i) => `p${i}`)
    const source = `export let f=(${params})=>{${params.map(p => `${p}=+${p}`).join(';')};return ${params[count - 1]}}`
    const f = instantiate(source).f
    is(f(...params.map((_, i) => i)), count - 1)
  }
})

test('compact prototype: explicit ToNumber boundary', () => {
  const { f } = instantiate('export let f=x=>{x=+x;return x}')
  is(f('4'), 4)
  is(f(null), 0)
  is(f(true), 1)
  ok(Number.isNaN(f()), 'a missing argument converts like undefined')
  ok(Object.is(f(-0), -0), 'signed zero is preserved')

  let calls = 0
  is(f({ valueOf() { calls++; return 4 } }), 4)
  is(calls, 1)

  const add = instantiate('export let f=(x,y)=>{x=+x;y=+y;return x+y}').f
  const order = []
  is(add(
    { valueOf() { order.push('x'); return 2 } },
    { valueOf() { order.push('y'); return 3 } },
  ), 5)
  is(order.join(','), 'x,y')

  throws(() => f(1n), error => error instanceof TypeError)
  throws(() => f(Symbol()), error => error instanceof TypeError)
})

test('compact prototype: direct calls and arithmetic updates', () => {
  const declared = instantiate('function zero(){return 0} export let f=()=>zero()')
  is(declared.f(), 0)

  const direct = instantiate('let mul=(x,y)=>x*y;export let f=(x,y)=>{x=+x;y=+y;return mul(x,y)+1}')
  is(direct.f(3, 4), 13)

  const updated = instantiate('export let f=x=>{x=+x;let y=x;y+=2;y*=3;y-=1;y/=2;return y}')
  is(updated.f(4), 8.5)
})

test('compact prototype: exact signed and unsigned 32-bit boundaries', () => {
  const source = `
    export let signed = (x) => x | 0
    export let unsigned = (x) => x >>> 0
    export let not = (x) => ~x
    export let and = (x, y) => x & y
    export let or = (x, y) => x | y
    export let xor = (x, y) => x ^ y
    export let shl = (x, y) => x << y
    export let shr = (x, y) => x >> y
    export let ushr = (x, y) => x >>> y
    export let imul = (x, y) => Math.imul(x, y)
    export let clz = (x) => Math.clz32(x)
  `
  const boundaries = [
    NaN, Infinity, -Infinity, 0, -0, 0.5, -0.5, 1, -1,
    2147483647, 2147483648, 4294967295, 4294967296,
    2 ** 63, -(2 ** 63), 2 ** 70 + 2 ** 20, Number.MAX_VALUE, Number.MIN_VALUE,
  ]
  const binaryInputs = []
  for (const x of boundaries) for (const y of [-1, 0, 1, 31, 32, 33, NaN, Infinity, 2654435761])
    binaryInputs.push([x, y])
  const bitBuffer = new ArrayBuffer(8), bitView = new DataView(bitBuffer)
  const bitInputs = []
  let bits = 0x123456789abcdef0n
  for (let i = 0; i < 512; i++) {
    bits = (bits * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn
    bitView.setBigUint64(0, bits, true)
    bitInputs.push([bitView.getFloat64(0, true)])
  }
  const compare = (label, inputs, actual, expected) => {
    let mismatch = ''
    for (const args of inputs) {
      const got = actual(...args), want = expected(...args)
      if (!sameNumber(got, want)) { mismatch = `${label}(${args.map(String).join(', ')}): ${got} != ${want}`; break }
    }
    ok(!mismatch, mismatch || `${label}: ${inputs.length} boundaries match JavaScript`)
  }
  for (const optimize of [false, true]) {
    const e = instantiateRaw(source, { optimize })
    const mode = optimize ? 'optimized' : 'plain'
    const unaryInputs = boundaries.map(x => [x])
    compare(`${mode} signed`, unaryInputs, e.signed, x => x | 0)
    compare(`${mode} unsigned`, unaryInputs, e.unsigned, x => x >>> 0)
    compare(`${mode} not`, unaryInputs, e.not, x => ~x)
    compare(`${mode} clz32`, unaryInputs, e.clz, Math.clz32)
    compare(`${mode} signed bit patterns`, bitInputs, e.signed, x => x | 0)
    compare(`${mode} unsigned bit patterns`, bitInputs, e.unsigned, x => x >>> 0)
    compare(`${mode} and`, binaryInputs, e.and, (x, y) => x & y)
    compare(`${mode} or`, binaryInputs, e.or, (x, y) => x | y)
    compare(`${mode} xor`, binaryInputs, e.xor, (x, y) => x ^ y)
    compare(`${mode} shl`, binaryInputs, e.shl, (x, y) => x << y)
    compare(`${mode} shr`, binaryInputs, e.shr, (x, y) => x >> y)
    compare(`${mode} ushr`, binaryInputs, e.ushr, (x, y) => x >>> y)
    compare(`${mode} imul`, binaryInputs, e.imul, Math.imul)
  }
})

test('compact prototype: i32 representations and local facts are disposable', () => {
  const source = 'let signed=x=>x|0;let unsigned=x=>x>>>0;export let f=x=>{let u=unsigned(x);return signed(x)+u}'
  const index = buildProgramIndex(prepareCompactAst(parse(source)), { abi: 'raw' })
  is(index[I_FN_RESULT_REP].join(','), `${REP_I32},${REP_U32},${REP_F64}`)
  is(index[I_FN_TYPE_ID].join(','), '0,0,1')
  is(index[I_TYPE_PARAM_COUNT].join(','), '1,1')
  is(index[I_TYPE_RESULT_REP].join(','), `${REP_I32},${REP_F64}`)
  is(index[I_EXACT_I32_WASM_ID], 3)
  is(index[I_EXACT_I32_TYPE_ID], 0)
  is(index[I_EXACT_I32_OWNS_TYPE], 0)
  const before = JSON.stringify(index)
  const metrics = {}
  const wat = lowerProgram(index, metrics)
  is(JSON.stringify(index), before)
  ok(metrics.maxRepresentationFacts >= 1, 'representation facts are reported from function scratch')
  ok(metrics.maxRangeFacts >= 1, 'range facts are reported from function scratch')
  is(metrics.exactI32HelperCount, 1, 'a module owns one exact conversion helper')
  let retainedFact = ''
  const checkFacts = (node) => {
    if (!Array.isArray(node)) return
    if (Object.hasOwn(node, 'rep') || Object.hasOwn(node, 'lo') || Object.hasOwn(node, 'hi')) retainedFact = node[0]
    for (let i = 1; i < node.length; i++) checkFacts(node[i])
  }
  checkFacts(wat)
  ok(!retainedFact, retainedFact ? `final WAT retained scratch facts at ${retainedFact}` : 'final WAT owns no scratch facts')
  const text = JSON.stringify(wat)
  ok(text.includes('["result","i32"]'), 'internal signed and unsigned results use i32 storage')
  ok(text.includes('f64.convert_i32_s'), 'signed result widens through signed conversion')
  ok(text.includes('f64.convert_i32_u'), 'unsigned result widens through unsigned conversion')
  is(new WebAssembly.Instance(new WebAssembly.Module(compileCompact(source, { abi: 'raw' }))).exports.f(-1), 4294967294)

  const localOnlySource = scalarCase('assignment-shl').source
  const localOnlyIndex = buildProgramIndex(prepareCompactAst(parse(localOnlySource)), { abi: 'raw' })
  is(localOnlyIndex[I_EXACT_I32_OWNS_TYPE], 1)
  const localOnlyWat = lowerProgram(localOnlyIndex)
  is(localOnlyWat.filter(node => Array.isArray(node) && node[0] === 'type').length, 1)
  ok(!JSON.stringify(localOnlyWat).includes('0x000fffffffffffff'), 'a proven i32 local emits no helper or helper-only type')

  const localWat = JSON.stringify(compileCompact('export let f=x=>{let u=x>>>0;return u}', { abi: 'raw', wat: true }))
  ok(localWat.includes('["local","$v1","i32"]'), 'a uint32-only local uses i32 storage')
  const mixedWat = JSON.stringify(compileCompact('export let f=()=>{let u=-1;u>>>=24;return u}', { abi: 'raw', wat: true }))
  ok(mixedWat.includes('["local","$v0","f64"]'), 'a mixed signed and unsigned local stays f64')
})

test('compact prototype: bitwise effects, compound assignments, and ABI conversions', () => {
  const effects = instantiateRaw('export let f=()=>{let x=1;let y=x++|x++;return x*10+y}').f
  is(effects(), 33)
  is(instantiateRaw('export let f=()=>{let x=1;x++|x++;return x}').f(), 3)
  const shifts = instantiateRaw(`export let f=()=>{
    let a=256;a>>=4
    let b=1;b<<=4
    let c=-1;c>>>=24
    let d=7;d&=3;d|=8;d^=2
    return a*1000000+b*10000+c*10+d
  }`).f
  is(shifts(), 16162559)

  const folded = compileCompact('export let f=()=>-1>>>0', { abi: 'raw', wat: true })
  ok(!JSON.stringify(folded).includes('i32.shr_u'), 'constant unsigned shift folds before lowering')
  is(instantiateRaw('export let f=()=>-1>>>0').f(), 4294967295)
  const exactWat = JSON.stringify(compileCompact('export let f=x=>x|0', { abi: 'raw', wat: true }))
  ok(exactWat.includes('i64.reinterpret_f64'), 'unknown f64 uses the exact bit-decomposition boundary')
  ok(exactWat.includes('0x000fffffffffffff'), 'exact conversion retains the f64 significand mask')
  const sharedWat = JSON.stringify(compileCompact('export let f=(x,y)=>(x|0)+(y>>>0)', { abi: 'raw', wat: true }))
  is((sharedWat.match(/0x000fffffffffffff/g) || []).length, 1, 'unknown conversions share one module-owned helper')

  const jsBoundary = instantiate('export let f=x=>{x=+x;return x>>>0}').f
  is(jsBoundary('-1'), 4294967295)
  is(jsBoundary(null), 0)
  throws(() => jsBoundary(1n), error => error instanceof TypeError)
  throws(() => compileCompact('export let f=x=>x>>>0'), /must normalize/)
  throws(() => compileCompact('export let f=x=>Math.imul(x)', { abi: 'raw' }), /has 1 arguments, expected 2/)
  throws(() => compileCompact('export let f=x=>Math.clz32(x,1)', { abi: 'raw' }), /has 2 arguments, expected 1/)
  throws(() => compileCompact('export let f=x=>Math.abs(x)', { abi: 'raw' }), /unsupported/)
})

test('compact prototype: conditionals and zero-iteration loops', () => {
  const abs = instantiate('export let f=x=>{x=+x;if((x>0))return x;else return -x}').f
  is(abs(-9), 9)

  const truthy = instantiate('export let f=x=>{x=+x;if(x)return 1;else return 2}').f
  is(truthy(NaN), 2)
  is(truthy(-0), 2)
  is(truthy(-3), 1)
  is(truthy(Infinity), 1)

  const negated = instantiate('export let f=x=>{x=+x;if(!x)return 1;else return 2}').f
  is(negated(NaN), 1)
  is(negated(3), 2)

  const choose = instantiate('export let f=x=>{x=+x;return x?x:7}').f
  is(choose(NaN), 7)
  is(choose(-2), -2)

  const sumFor = instantiate('export let f=n=>{n=+n;let s=0;for(let i=0;i<n;i++)s+=i;return s}').f
  const sumWhile = instantiate('export let f=n=>{n=+n;let s=0;let i=0;while(i<n){s+=i;i++}return s}').f
  for (const [input, expected] of [[0, 0], [1, 0], [100, 4950]]) {
    is(sumFor(input), expected)
    is(sumWhile(input), expected)
  }
})

test('compact prototype: staged watr and frozen direct control agree', () => {
  const cases = [
    ['export let f=()=>1+2*3', [], 7],
    ['export let f=x=>{x=+x;return x*x+1}', [4], 17],
    ['let twice=x=>x*2;export let f=x=>{x=+x;return twice(x)}', [5], 10],
    ['export let f=x=>{x=+x;if(x>0)return x;else return -x}', [-7], 7],
    ['export let f=n=>{n=+n;let s=0;for(let i=0;i<n;i++)s+=i;return s}', [10], 45],
    ['let fact=n=>{if(n<=1)return 1;else return n*fact(n-1)};export let f=n=>{n=+n;return fact(n)}', [5], 120],
  ]
  for (const [source, args, expected] of cases) {
    const staged = new WebAssembly.Instance(new WebAssembly.Module(compileCompact(source))).exports.f(...args)
    const direct = new WebAssembly.Instance(new WebAssembly.Module(compileDirect(source))).exports.f(...args)
    ok(sameNumber(staged, direct), `staged and direct agree for ${source}`)
    ok(sameNumber(staged, expected), `expected result for ${source}`)
  }
})

test('compact prototype: numeric index, reachability, and watr boundary', () => {
  const source = 'let dead=()=>99;let leaf=x=>x*2;export let f=x=>{x=+x;return leaf(x)+1}'
  const ast = parse(source)
  const astBefore = JSON.stringify(ast)
  const index = buildProgramIndex(prepareCompactAst(ast))
  is(functionCount(index), 3)
  is(index[I_FN_REACHABLE].join(','), '0,1,1')
  is(index[I_FN_WASM_ID].join(','), '-1,0,1')
  is(index[I_FN_TYPE_ID].join(','), '-1,0,0')
  is(index[I_TYPE_PARAM_COUNT].join(','), '1')
  is(index[I_FN_EDGE_COUNT].join(','), '0,0,1')
  is(index[I_EDGE_TARGET][index[I_FN_EDGE_START][2]], 1)

  const indexBefore = JSON.stringify(index)
  const wat = lowerProgram(index)
  is(JSON.stringify(ast), astBefore)
  is(JSON.stringify(index), indexBefore)
  const funcs = wat.filter(node => Array.isArray(node) && node[0] === 'func')
  is(funcs.length, 2)
  const diagnosticWat = compileCompact(source, { wat: true })
  is(diagnosticWat[0], 'module')
  is(diagnosticWat.filter(node => Array.isArray(node) && node[0] === 'func').length, 2)
  let call = null
  const visit = (node) => {
    if (!Array.isArray(node)) return
    if (node[0] === 'call') call = node
    for (let i = 1; i < node.length; i++) visit(node[i])
  }
  visit(wat)
  ok(call && typeof call[1] === 'number', 'lowered direct calls use final numeric function IDs')
  is(call[1], 0)

  const staged = new WebAssembly.Instance(new WebAssembly.Module(compileCompact(source))).exports.f
  const direct = new WebAssembly.Instance(new WebAssembly.Module(compileDirect(source))).exports.f
  const optimized = new WebAssembly.Instance(new WebAssembly.Module(compileCompact(source, { optimize: true }))).exports.f
  is(staged(7), 15)
  is(direct(7), 15)
  is(optimized(7), 15)
  throws(() => compileCompact('let dead=()=>missing();export let f=()=>0'), /unknown direct function/)
  throws(() => compileCompact('let dead=()=>"x";export let f=()=>0'), /unsupported/)
  throws(() => compileCompact('export let f=()=>{if(false)return missing();else return 1}', { abi: 'raw' }), /unknown direct function/)
  throws(() => compileCompact('export let f=()=>{while(false){return "x"}return 1}', { abi: 'raw' }), /unsupported/)
})

test('compact prototype: unmodified main-suite scalar corpus', () => {
  let calls = 0
  for (const entry of SCALAR_CORE_CASES) {
    if (!entry.calls.length) continue
    const exports = instantiateRaw(entry.source)
    for (const [name, args, expected] of entry.calls) {
      const actual = exports[name](...args)
      ok(sameNumber(actual, expected), `${entry.id}: ${name}(${args.map(String).join(', ')})`)
      calls++
    }
  }
  is(calls, 110)

  const numericWat = compileCompact(scalarCase('preeval-numeric-chain').source, { abi: 'raw', wat: true })
  const deadIfWat = compileCompact(scalarCase('preeval-dead-if').source, { abi: 'raw', wat: true })
  const deadWhileWat = compileCompact(scalarCase('preeval-while-false').source, { abi: 'raw', wat: true })
  const ops = (tree) => {
    const out = []
    const visit = (node) => {
      if (!Array.isArray(node)) return
      if (typeof node[0] === 'string') out.push(node[0])
      for (let i = 1; i < node.length; i++) visit(node[i])
    }
    visit(tree)
    return out
  }
  ok(!ops(numericWat).some(op => op === 'f64.add' || op === 'f64.sub' || op === 'f64.mul'), 'numeric chain has no runtime arithmetic')
  ok(!ops(deadIfWat).includes('f64.lt') && !JSON.stringify(deadIfWat).includes('["f64.const",20]'), 'constant if emits only its live branch')
  ok(!ops(deadWhileWat).includes('loop'), 'while(false) emits no loop')
  ok(!ops(compileCompact(scalarCase('minimal-numeric-fn').source, { abi: 'raw', wat: true })).includes('memory'), 'numeric module emits no memory')

  const rawSource = scalarCase('abi-add').source
  const rawAst = parse(rawSource)
  const rawIndex = buildProgramIndex(prepareCompactAst(rawAst), { abi: 'raw' })
  is(rawIndex[I_ABI_MODE], ABI_RAW)
  const rawAstModule = new WebAssembly.Module(compileCompactAst(rawAst, { abi: 'raw' }))
  is(new WebAssembly.Instance(rawAstModule).exports.add(2, 3), 5)
  throws(() => compileCompactAst(rawAst), /must normalize/)
  throws(() => compileCompact(rawSource), /must normalize/)
  throws(() => compileCompact(scalarCase('abi-add').source, { abi: 'opaque' }), /unknown ABI/)
})

test('compact prototype: scalar integers remain exact after watr optimization', () => {
  let calls = 0
  for (const entry of scalarCasesIn('integer')) {
    const exports = instantiateRaw(entry.source, { optimize: true })
    for (const [name, args, expected] of entry.calls) {
      ok(sameNumber(exports[name](...args), expected), `optimized ${entry.id}`)
      calls++
    }
  }
  is(calls, 41)
})

test('compact prototype: scalar control remains exact after watr optimization', () => {
  let calls = 0
  for (const entry of scalarCasesIn('control')) {
    const exports = instantiateRaw(entry.source, { optimize: true })
    for (const [name, args, expected] of entry.calls) {
      ok(sameNumber(exports[name](...args), expected), `optimized ${entry.id}`)
      calls++
    }
  }
  is(calls, 39)
})

test('compact prototype: control effects are single-evaluation and targets are lexical', () => {
  is(instantiateRaw('export let f=()=>{let y=0;let x=y++&&y++;return y*10+x}').f(), 10)
  is(instantiateRaw('export let f=()=>{let y=0;let x=y++||y++;return y*10+x}').f(), 21)
  is(instantiateRaw('export let f=()=>{let i=5;return i+++i}').f(), 11)

  const source = scalarCase('break-labeled-outer').source
  const index = buildProgramIndex(prepareCompactAst(parse(source)), { abi: 'raw' })
  const metrics = {}
  lowerProgram(index, metrics)
  ok(metrics.maxControlDepth >= 2, 'nested labeled loops record bounded control depth')
  const logicalIndex = buildProgramIndex(prepareCompactAst(parse(scalarCase('logical-and-chain').source)), { abi: 'raw' })
  const logicalMetrics = {}
  lowerProgram(logicalIndex, logicalMetrics)
  is(logicalMetrics.maxTemporaryLocals, 1, 'completed left-associative logic joins reuse one temporary local')
  const plainForWat = JSON.stringify(compileCompact(scalarCase('for-sum').source, { abi: 'raw', wat: true }))
  const continueForWat = JSON.stringify(compileCompact(scalarCase('continue-skip').source, { abi: 'raw', wat: true }))
  ok(!plainForWat.includes('$continue'), 'a for-loop without continue pays no continue block')
  ok(continueForWat.includes('$continue'), 'a for-loop with continue owns an explicit step target')

  throws(() => compileCompact('export let f=()=>{break;return 0}', { abi: 'raw' }), /break outside loop/)
  throws(() => compileCompact('export let f=()=>{continue;return 0}', { abi: 'raw' }), /continue outside a loop/)
  throws(() => compileCompact('export let f=()=>{break missing;return 0}', { abi: 'raw' }), /unknown break label/)
  throws(() => compileCompact('export let f=()=>{out:{continue out}return 0}', { abi: 'raw' }), /does not name a loop/)
  throws(() => compileCompact('export let f=()=>{const x=1;return x++}', { abi: 'raw' }), /const local/)
  throws(() => compileCompact('export let f=()=>{let x=0;0&&(x="bad");return x}', { abi: 'raw' }), /unsupported/)
})

test('compact prototype: main-suite scalar compiler reuse A to A to B', () => {
  const a = scalarCase('abi-add')
  const b = scalarCase('determinism-poly')
  for (const optimize of [false, true]) {
    const options = { abi: 'raw', optimize }
    const referenceB = compileCompact(b.source, options)
    const firstA = compileCompact(a.source, options)
    const secondA = compileCompact(a.source, options)
    const afterA = compileCompact(b.source, options)
    const mode = optimize ? 'optimized' : 'plain'
    ok(sameBytes(firstA, secondA), `${mode} scalar A to A is byte-identical`)
    ok(sameBytes(referenceB, afterA), `${mode} scalar B is independent of prior A compiles`)
    is(new WebAssembly.Instance(new WebAssembly.Module(firstA)).exports.add(2, 3), 5)
    is(new WebAssembly.Instance(new WebAssembly.Module(secondA)).exports.add(2, 3), 5)
    is(new WebAssembly.Instance(new WebAssembly.Module(afterA)).exports.poly(2, 3, 4), 671950)
  }
})

test('compact prototype: integer compiler reuse A to A to B', () => {
  const a = scalarCase('unsigned-local-return')
  const b = scalarCase('differential-fnv-i32')
  for (const optimize of [false, true]) {
    const options = { abi: 'raw', optimize }
    const referenceB = compileCompact(b.source, options)
    const firstA = compileCompact(a.source, options)
    const secondA = compileCompact(a.source, options)
    const afterA = compileCompact(b.source, options)
    const mode = optimize ? 'optimized' : 'plain'
    ok(sameBytes(firstA, secondA), `${mode} integer A to A is byte-identical`)
    ok(sameBytes(referenceB, afterA), `${mode} integer B is independent of prior A compiles`)
    is(new WebAssembly.Instance(new WebAssembly.Module(firstA)).exports.main(-1), 4294967295)
    is(new WebAssembly.Instance(new WebAssembly.Module(afterA)).exports.f(1, 2, 3), 5689143)
  }
})

test('compact prototype: main-suite scalar differential sources', () => {
  const jsRef = source => new Function(`${source.replace(/export\s+let\s+f\s*=/, 'let f =')}\n;return f`)()
  const inputs = [-98765.4321, -3, -0, 0, 0.5, 7, 12345.678, Infinity]
  for (const entry of scalarCasesIn('differential')) {
    const wasm = instantiateRaw(entry.source).f
    const js = jsRef(entry.source)
    if (entry.id === 'differential-loop-accumulate') {
      for (const a of inputs) for (const b of inputs) ok(sameNumber(wasm(a, b), js(a, b)), `${entry.id}(${a}, ${b})`)
    } else if (entry.id === 'differential-newton-sqrt') {
      for (const input of inputs) {
        const a = Math.abs(input) + 0.25
        ok(sameNumber(wasm(a), js(a)), `${entry.id}(${a})`)
      }
    } else {
      for (let i = 0; i < inputs.length; i++) {
        const args = Array.from({ length: js.length }, (_, j) => inputs[(i + j * 3) % inputs.length])
        ok(sameNumber(wasm(...args), js(...args)), `${entry.id}(${args.map(String).join(', ')})`)
      }
    }
  }
})

test('compact prototype: generated call graphs stay byte-identical and scratch plateaus', () => {
  for (const count of [8, 128]) {
    const graph = generateDirectCallGraph(count)
    const ast = parse(graph.source)
    const index = buildProgramIndex(prepareCompactAst(ast))
    const metrics = {}
    const wat = lowerProgram(index, metrics)
    const staged = compileCompact(graph.source)
    const direct = compileDirect(graph.source)
    ok(sameBytes(staged, direct), `${count} functions emit the direct-control bytes`)
    is(functionCount(index), count)
    is(index[I_FN_REACHABLE].reduce((sum, value) => sum + value, 0), count)
    is(wat.filter(node => Array.isArray(node) && node[0] === 'func').length, count)
    is(metrics.maxScratchSlots, 1)
    is(metrics.maxLoopLabels, 0)
    is(metrics.maxControlDepth, 0)
    is(metrics.maxTemporaryLocals, 0)
    is(metrics.maxFunctionWatNodes, 18)
    is(new WebAssembly.Instance(new WebAssembly.Module(staged)).exports.run(...graph.args), graph.expected)
  }
})

test('compact prototype: nested loops own independent function scratch', () => {
  const nestedFor = 'export let f=n=>{n=+n;let s=0;for(let i=0;i<n;i++){for(let j=0;j<n;j++)s+=1}return s}'
  const optimizedFor = compileCompact(nestedFor, { optimize: true })
  is(new WebAssembly.Instance(new WebAssembly.Module(optimizedFor)).exports.f(4), 16)
  const unoptimizedFor = compileCompact(nestedFor, { optimize: false })
  is(new WebAssembly.Instance(new WebAssembly.Module(unoptimizedFor)).exports.f(3), 9)

  const nestedWhile = 'export let f=n=>{n=+n;let s=0;let i=0;while(i<n){let j=0;while(j<n){s+=1;j++}i++}return s}'
  const optimizedWhile = compileCompact(nestedWhile, { optimize: true })
  is(new WebAssembly.Instance(new WebAssembly.Module(optimizedWhile)).exports.f(4), 16)
})

test('compact prototype: compiler reuse A to A to B', () => {
  const sourceA = 'export let f=x=>{x=+x;return x+1}'
  const sourceB = 'export let f=x=>{x=+x;return x*x}'
  const firstA = compileCompact(sourceA)
  const secondA = compileCompact(sourceA)
  const b = compileCompact(sourceB)
  ok(sameBytes(firstA, secondA), 'A to A is byte-identical')
  is(new WebAssembly.Instance(new WebAssembly.Module(firstA)).exports.f(4), 5)
  is(new WebAssembly.Instance(new WebAssembly.Module(secondA)).exports.f(4), 5)
  is(new WebAssembly.Instance(new WebAssembly.Module(b)).exports.f(4), 16)

  const firstOptimizedA = compileCompact(sourceA, { optimize: true })
  const secondOptimizedA = compileCompact(sourceA, { optimize: true })
  const optimizedB = compileCompact(sourceB, { optimize: true })
  ok(sameBytes(firstOptimizedA, secondOptimizedA), 'optimized A to A is byte-identical')
  is(new WebAssembly.Instance(new WebAssembly.Module(firstOptimizedA)).exports.f(4), 5)
  is(new WebAssembly.Instance(new WebAssembly.Module(optimizedB)).exports.f(4), 16)
})

test('compact prototype: numeric expression differential', () => {
  let seed = 0x12345678
  const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)
  const expression = (depth) => {
    if (!depth) return rand() & 1 ? 'x' : String((rand() % 19) - 9)
    const op = ['+', '-', '*', '/'][rand() & 3]
    return `(${expression(depth - 1)} ${op} ${expression(depth - 1)})`
  }
  const inputs = [-3, -0, 0, 0.5, 7, NaN, Infinity]
  let mismatch = ''
  outer: for (let i = 0; i < 32; i++) {
    const expr = expression(3)
    const wasm = instantiate(`export let f=x=>{x=+x;return ${expr}}`).f
    const js = new Function('x', `x=+x;return ${expr}`)
    for (const input of inputs) if (!sameNumber(wasm(input), js(input))) {
      mismatch = `${expr} at ${input}`
      break outer
    }
  }
  ok(!mismatch, mismatch || '32 expressions match JavaScript at seven numeric boundaries')
})

test('compact prototype: lexical hazards reject', () => {
  is(instantiate('export let f=()=>{const x=1;return x}').f(), 1)
  throws(() => compileCompact('export let f=()=>{const x=1;x=2;return x}'), /const local/)
  throws(() => compileCompact('export let f=()=>{const x=1;x+=2;return x}'), /const local/)
  throws(() => compileCompact('export let f=()=>{const x=1;x++;return x}'), /const local/)
  throws(() => compileCompact('let g=()=>1;export let f=()=>{let g=2;return g()}'), /dynamic call through local/)
  throws(() => compileCompact('export let f=()=>{let y=x;let x=1;return y}'), /before its declaration/)
  throws(() => compileCompact('export let f=()=>{{let x=1}return x}'), /before its declaration/)
})

test('compact prototype: empty modules compile and unsupported programs reject', () => {
  const empty = compileCompact('')
  is(empty.length, 8)
  is(WebAssembly.Module.exports(new WebAssembly.Module(empty)).length, 0)
  is(JSON.stringify(compileCompact('', { wat: true })), '["module"]')
  is(compileCompact('', { optimize: true }).length, 8)
  is(compileCompactAst(null, null).length, 8)
  is(JSON.stringify(compileCompactAst(null, { abi: 'raw', optimize: true, wat: true })), '["module"]')
  is(compileCompact('let f=()=>0').length, 8)
  throws(() => compileCompact('export let f=x=>x+1'), /must normalize/)
  throws(() => compileCompact('export let f=()=>"1"'), /unsupported/)
  throws(() => compileCompact('export let f=x=>{x=+x;return Math.sin(x)}'), /unsupported/)
  throws(() => compileCompact('export let f=x=>x%3', { abi: 'raw' }), /unsupported/)
  throws(() => compileCompact('export let f=x=>x**2', { abi: 'raw' }), /unsupported/)
  throws(() => compileCompact('export let f=(x,y)=>{x=+x;y=+y;return x<y}'), /supported only as a condition/)
  throws(() => compileCompact('export let f=x=>{x=+x;return !x}'), /unsupported/)
  throws(() => compileCompact('export let f=()=>{}'), /does not return/)
  throws(() => compileCompact('export let f=()=>missing()'), /unknown direct function/)
  throws(() => compileCompact('let g=x=>x;export let f=()=>g()'), /has 0 arguments, expected 1/)
  throws(() => compileCompact('export function f(){return 0}'), /constructable/)
  throws(() => compileCompact('export let π=()=>0'), /non-ASCII export name/)
})
