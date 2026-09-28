/**
 * Cross-function neverGrown for array PARAMS (program-facts.js
 * analyzeParamNeverGrown → paramReps.neverGrown → module/array.js raw-base
 * element reads, no __ptr_offset per read).
 *
 * MEMORY-SAFETY CRITICAL — a wrongly-raw base read through a relocated array
 * corrupts memory, so the fail-closed directions get equal pinning: any
 * possibly-ARRAY growth in the body or a transitive callee, or any escape of
 * the param itself, must keep the forwarding-aware call.
 */
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { _compileInProcess } from '../index.js'
import { run, oracle } from './util.js'
import { scanBindingUses, scanObjectArrayFacts, arrayUsesSafe, BINDING_USE_USES, BINDING_USE_KIND, BINDING_USE_STORE, USE } from '../src/compile/analyze-scans.js'

test('array census: reads, calls, writes and escapes have distinct safety policies', () => {
  _compileInProcess('export const empty = () => 0')
  const index = (key = [null, 0]) => ['[]', 'a', key]
  const prop = key => ['.', 'a', key]
  const call = (callee, arg = [null, 1]) => ['()', callee, arg]
  const rows = [
    [null, true, true], [index(), true, true], [index(['str', 'extra']), true, true],
    [prop('length'), true, true], [prop('extra'), false, false],
    [call(prop('length')), false, false], [call(index()), false, false],
    [call(prop('push')), false, true], [call(['?.', 'a', 'push']), false, false],
    [call(['.', index(), 'push']), true, true],
    [['=', index(), [null, 2]], false, true], [['+=', index(), [null, 2]], false, false],
    [['=', prop('length'), [null, 0]], false, true],
    [['=', prop('extra'), [null, 0]], false, false],
    [['=', index(), 'a'], false, false], [index('a'), false, false],
    [['return', 'a'], false, true], [['let', ['=', 'b', 'a']], false, false],
    [call('consume', 'a'), false, false], [['...', 'a'], false, false],
    [['=>', [], index()], false, false], [['delete', index()], false, false],
  ]
  for (const [node, read, own] of rows) {
    const body = [';', ['let', ['=', 'a', ['[']]], node]
    const census = scanBindingUses(body), uses = census.get('a')
    is(scanBindingUses(body), census, 'the unchanged body reuses its census')
    is(arrayUsesSafe(uses), read, JSON.stringify(node))
    is(arrayUsesSafe(uses, true), own, 'own: ' + JSON.stringify(node))
    const facts = scanObjectArrayFacts(body)
    is(facts[2].has('a'), read, 'never-relocated classification')
    is(facts[3].has('a'), own && !read, 'current-pointer classification')
  }
  const body = [';', call(prop('length'))]
  const uses = scanBindingUses(body, new Set(['a'])).get('a')
  is(uses[BINDING_USE_USES][0][BINDING_USE_KIND], USE.MEMBER_CALL, 'parameter member call is retained')
  is(arrayUsesSafe(uses), false, 'parameter proof rejects a member call')
})

test('binding census: only discarded indexed assignments record a word-store candidate', () => {
  _compileInProcess('export const empty = () => 0')
  const target=['[]','a','i'], store=['=',target,'v']
  const rows=[
    [[';',store],true], [['{}',store],true], [['if','p',store],true],
    [['while','p',store],true], [['for',store,'p',null,[';']],true],
    [['return',store],false], [['let',['=','x',store]],false],
    [['?:','p',store,[null,0]],false], [store,false],
    [['=>',[],store],false], [['+=',target,'v'],false],
  ]
  for(const [body,discarded] of rows){
    const uses=scanBindingUses(body,new Set(['v'])).get('v')?.[BINDING_USE_USES]
    is(uses?.length,1,'the RHS use is retained')
    is(uses[0][BINDING_USE_STORE]===target,discarded,JSON.stringify(body))
  }
})


// The word-frequency shape: kernel reads `words[toks[i]]` per token while a
// dictionary receiver takes keyed writes and a clean helper is called.
const KERNEL = (extra = '') => `
const mix = (h, x) => (((h ^ x) * 16777619) | 0)
export let kernel = (words, toks) => {
  let h = 0x811c9dc5 | 0
  const counts = {}
  for (let i = 0; i < toks.length; i++) {
    const w = words[toks[i]]
    counts[w] = (counts[w] | 0) + 1
    h = mix(h, counts[w])
    ${extra}
  }
  return h >>> 0
}
export let main = () => {
  const words = []
  for (let i = 0; i < 16; i++) words.push('w' + i)
  const toks = new Int32Array(64)
  for (let i = 0; i < 64; i++) toks[i] = (i * 7) & 15
  return kernel(words, toks)
}`

test('never-grown: read-only array param reads raw base (no __ptr_offset per read)', () => {
  const src = KERNEL()
  const wat = jz.compile(src, { wat: true, optimize: 'speed' })
  const body = wat.split('(func ').find(c => /^\$kernel\b/.test(c)) || ''
  ok(body, 'kernel emitted')
  const loop = body.slice(body.indexOf('(loop'))
  ok(!/call \$__ptr_offset\b/.test(loop), 'token loop resolves no array base')
  is(run(src, { optimize: 'speed' }).main(), oracle(src).main(), 'bit-matches plain JS')
})

test('never-grown: a parameter whose caller passes a pointer another callee relocated reads through forwarding', () => {
  // `a.toArray(arr)` grows `arr` inside V.toArray; run's binding still boxes
  // the old block, and V.fromArray receives that box: a read-only param, an
  // array-growth-free body, and a stale pointer (the proof's condition (c)).
  const src = `
class V { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this }
  fromArray(a, o = 0) { this.x = a[o]; this.y = a[o + 1]; this.z = a[o + 2]; return this }
  toArray(a = [], o = 0) { a[o] = this.x; a[o + 1] = this.y; a[o + 2] = this.z; return a } }
class SH { constructor() { this.coefficients = []; for (let i = 0; i < 9; i++) this.coefficients.push(new V()) }
  fromArray(array, offset = 0) { const c = this.coefficients; for (let i = 0; i < 9; i++) c[i].fromArray(array, offset + (i * 3)); return this }
  toArray(array = [], offset = 0) { const c = this.coefficients; for (let i = 0; i < 9; i++) c[i].toArray(array, offset + (i * 3)); return array }
  static fill9(normal, shBasis) { for (let i = 0; i < 9; i++) shBasis[i] = normal.x + i } }
const s3 = v => v.x + v.y * 3 + v.z * 7
export let main = () => { const a = new SH(), basis = [0, 0, 0, 0, 0, 0, 0, 0, 0], arr = []
  for (let i = 0; i < 9; i++) a.coefficients[i].set(i, i * 0.5, -i)
  SH.fill9(new V(0, 0.6, 0.8), basis); a.toArray(arr)
  return s3(new SH().fromArray(arr).coefficients[8]) }`
  for (const optimize of [1, 2, 'speed']) is(run(src, { optimize }).main(), oracle(src).main(), `value exact (optimize:${optimize})`)
  const wat = jz.compile(src, { wat: true, optimize: { level: 2, sourceInline: false, watr: false } })
  const body = wat.split('(func ').find(c => /^\$V\S*fromArray\b/.test(c)) || ''
  ok(body, 'V.fromArray emitted outlined (no source or WAT inlining)')
  ok(/__ptr_offset_fwd|call \$__ptr_offset\b/.test(body), 'its reads of the parameter follow forwarding')
})

test('never-grown: a builder\'s result and an own-name-current local arrive live', () => {
  // condition (c)'s positive side: a call whose every return is its own literal, and a
  // local grown only through its own name, both pass a live pointer, so the kernel's
  // read-only param keeps the raw base
  const src = `
const build = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(i * 3); return a }
const kernel = (xs, ys) => { let s = 0; for (let i = 0; i < 8; i++) s = (s + xs[i] * ys[i]) | 0; return s }
export let main = () => { const xs = build(8), ys = []; for (let i = 0; i < 8; i++) ys.push(i + 1); return kernel(xs, ys) }`
  const wat = jz.compile(src, { wat: true, optimize: { level: 'speed', sourceInline: false, watr: false } })
  const body = wat.split('(func ').find(c => /^\$kernel\b/.test(c)) || ''
  ok(body, 'kernel emitted outlined')
  ok(!/__ptr_offset/.test(body.slice(body.indexOf('(loop'))), 'the loop resolves no array base')
  is(run(src, { optimize: 'speed' }).main(), oracle(src).main(), 'value exact')
})

test('never-grown: fail-closed when the body grows any possibly-array receiver', () => {
  // an indexed write on an untyped (possibly-ARRAY) second param — could grow
  const src = `
export let kernel = (words, out) => {
  let s = 0
  for (let i = 0; i < 8; i++) {
    s = (s + words[i].length) | 0
    out[i] = s
  }
  return s
}
export let main = () => {
  const words = []
  for (let i = 0; i < 8; i++) words.push('w' + i)
  const out = []
  return kernel(words, out) + out.length
}`
  const wat = jz.compile(src, { wat: true, optimize: 'speed' })
  const body = wat.split('(func ').find(c => /^\$kernel\b/.test(c)) || ''
  ok(/call \$__(?:ptr_offset|arr_typed_(?:obj_)?set_idx)\b|__inl\d|__poff\d/.test(body), 'forwarding-aware base resolution kept')
  is(run(src, { optimize: 'speed' }).main(), oracle(src).main(), 'value exact')
})

test('never-grown: fail-closed when a transitive callee grows arrays', () => {
  const src = `
const helper = (n) => { sink.push(n); return sink.length }
const sink = []
export let kernel = (words) => {
  let s = 0
  for (let i = 0; i < 8; i++) s = (s + words[i].length + helper(i)) | 0
  return s
}
export let main = () => {
  const words = []
  for (let i = 0; i < 8; i++) words.push('w' + i)
  return kernel(words)
}`
  const wat = jz.compile(src, { wat: true, optimize: 'speed' })
  const body = wat.split('(func ').find(c => /^\$kernel\b/.test(c)) || ''
  ok(/call \$__ptr_offset\b|call \$__typed_idx\b|__inl\d|__poff\d/.test(body), 'callee growth keeps forwarding-aware reads')
  is(run(src, { optimize: 'speed' }).main(), oracle(src).main(), 'value exact')
})

test('never-grown: fail-closed when the param itself escapes', () => {
  // words leaks into a module global (directly or through the inlined helper)
  // — an alias the activation can't police, so arrayUsesSafe must disqualify.
  const src = `
let sink2 = null
const grab = (a) => { sink2 = a; return a.length }
export let kernel = (words) => {
  let s = 0
  for (let i = 0; i < words.length; i++) s = (s + words[i].length) | 0
  return s + grab(words)
}
export let main = () => {
  const words = []
  for (let i = 0; i < 8; i++) words.push('w' + i)
  return kernel(words)
}`
  const wat = jz.compile(src, { wat: true, optimize: 'speed' })
  const body = wat.split('(func ').find(c => /^\$kernel\b/.test(c)) || ''
  ok(/call \$__ptr_offset\b|__inl\d|__poff\d/.test(body), 'escaping param keeps forwarding-aware reads')
  is(run(src, { optimize: 'speed' }).main(), oracle(src).main(), 'value exact')
})
