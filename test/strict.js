import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import strict, { compile as compileStrict } from '../strict.js'
import { compile, _setCompileTarget } from '../index.js'
import { instantiate } from '../interop.js'
import { levels } from './_matrix.js'

test('strict export: the canonical subset shares the main compiler pipeline', () => {
  is(strict, compileStrict)
  const programs = [
    ['export const f = x => x*x + 1', [7]],
    ['export const f = n => { let x = 0; for (let i=0; i<n; i++) x += i; return x }', [17]],
    ['export const f = x => { const a = new Float64Array(4); a[1] = x; return a[1] }', [2.5]],
    ['import {twice} from "./helper.js"; export const f = x => twice(x)', [3]],
  ]
  for (const optimize of levels(0, 2, 3)) for (const [source, args] of programs) {
    const options = { optimize, modules: { './helper.js': 'export const twice = x => x*2' } }
    const actual = strict(source, options), expected = compile(source, { ...options, strict: true })
    is(actual, expected, `identical bytes at ${optimize}`)
    is(instantiate(actual).exports.f(...args), instantiate(expected).exports.f(...args))
    is(strict(source, { ...options, wat: true }), compile(source, { ...options, strict: true, wat: true }))
  }
})

test('strict export: lowering and dynamic fallbacks remain rejected', () => {
  for (const source of [
    'export function f(x) { return x }',
    'var x=1; export const f=()=>x',
    'export const f=x=>{switch(x){case 1:return 2;default:return 3}}',
    'export const f=(o,k)=>o[k]',
  ]) throws(() => strict(source, { strict: false }), /strict|function|var|switch|dynamic/i)
})

test('strict export: public optimizer and memory options, maps and repeated calls work', () => {
  const source = 'export const f = x => { const a = new Float32Array(8); a[0] = x; return a[0] }'
  const options = { memory: { initial: 2, maximum: 3 }, optimize: { level: 2, simd: false, tailCall: false, exceptions: false } }
  const before = JSON.stringify(options)
  for (let i=0; i<3; i++) {
    const result = instantiate(strict(source, options))
    is(result.exports.f(i + 0.5), i + 0.5)
    is(result.memory.buffer.byteLength, 2 * 65536)
  }
  is(JSON.stringify(options), before, 'the caller options stay unchanged')
  const bytes = strict(source, { sourceMap: { source: 'strict-input.js', url: false } })
  ok(bytes.sourceMap.sources.includes('strict-input.js'))
})


test('strict export: compiler targets and frontend state are shared with the main entry', () => {
  const bytes = new Uint8Array([1,2,3])
  let observed
  const previous = _setCompileTarget((source, options) => { observed = [source, options]; return bytes })
  try {
    is(strict('probe', { strict: false, optimize: { simd: false } }), bytes)
    is(observed[0], 'probe')
    is(observed[1].strict, true)
    is(observed[1].noSimd, true)
  } finally { _setCompileTarget(previous) }
  const source = 'export function f(x) { return x*x }'
  throws(() => strict(source))
  is(instantiate(compile(source)).exports.f(3), 9)
  is(instantiate(strict('export const f = x => x*x')).exports.f(3), 9)
})
