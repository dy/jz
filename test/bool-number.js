// A value that is a Boolean on one path and a Number on another keeps its
// identity wherever it is held: a local, a binding a closure reads or writes, a
// module binding, a parameter, an object field, an array element, a result.
// Its Booleans ride as their atoms (kind.js boolTagged, the summary's kind or,
// where the kind is open or absent, a Boolean store reaching the binding), and
// every read computes as JavaScript does: typeof, strict and loose equality,
// ToNumber (true is 1) at arithmetic and comparisons, ToString ("false", not
// "0"), JSON, truth, a store and read back, a return to the host, an argument.
// References: ECMA-262 13.13 (`&&`, `||`, `??` yield an operand unconverted),
// 13.5.3 typeof, 7.2.15 IsStrictlyEqual, 7.2.14 IsLooselyEqual, 7.1.4 ToNumber,
// 7.1.17 ToString, 25.5.2.2 SerializeJSONProperty. The expected values are
// Node's (util.js oracle).
import test from 'tst'
import { is } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { run, oracle } from './util.js'
import jz from '../index.js'

// What each export returns of the value at `v`.
const OPS = {
  type: v => `typeof ${v}`,
  isTrue: v => `${v} === true`, isFalse: v => `${v} === false`, isOne: v => `${v} === 1`, notFalse: v => `${v} !== false`,
  eqOne: v => `${v} == 1`, eqTrue: v => `${v} == true`, eqZero: v => `${v} == 0`,
  add: v => `${v} + 1`, mul: v => `${v} * 2`, neg: v => `-${v}`, int: v => `${v} | 0`, lt: v => `${v} < 1`, ge: v => `${v} >= 1`,
  floor: v => `Math.floor(${v})`, typed: v => `new Float64Array([${v}])[0]`,
  str: v => `String(${v})`, tpl: v => '`<${' + v + '}>`', cat: v => `'x' + ${v}`, json: v => `JSON.stringify([${v}, { v: ${v} }])`,
  method: v => `(${v}).toString()`, search: v => `[true, false, 1, 0].includes(${v})`,
  truth: v => `${v} ? 'y' : 'n'`, not: v => `!${v}`, or: v => `${v} || 5`, nullish: v => `${v} ?? 5`,
  inArray: v => `typeof [${v}][0]`, inObject: v => `({ w: ${v} }).w`, ret: v => v, arg: v => `(x => typeof x)(${v})`,
}
// Where the value lives. `E` is true, false or the number n; `pre` is declared
// once per export, its names suffixed so the exports do not share them.
const E = 'k > 0 ? k > 1 : n'
const AT = {
  local: v => ({ fn: `(k, n) => { let v = ${E}; return ${v('v')} }` }),
  and: v => ({ fn: `(k, n) => { let x = n * 1, v = k > 0 && k < 9 && x; return ${v('v')} }` }),
  paths: v => ({ fn: `(k, n) => { let v; if (k > 1) v = true; else if (k > 0) v = false; else v = n; return ${v('v')} }` }),
  closureRead: v => ({ fn: `(k, n) => { let v = ${E}; let g = () => ${v('v')}; return g() }` }),
  closureWrite: v => ({ fn: `(k, n) => { let v = 0; let s = () => { v = ${E} }; s(); return ${v('v')} }` }),
  module: (v, i) => ({ pre: `let m${i} = 0`, fn: `(k, n) => { m${i} = ${E}; return ${v('m' + i)} }` }),
  param: (v, i) => ({ pre: `let h${i} = (v) => ${v('v')}`, fn: `(k, n) => k > 0 ? h${i}(k > 1) : h${i}(n)` }),
  field: v => ({ fn: `(k, n) => { let o = { v: 0 }; o.v = ${E}; return ${v('o.v')} }` }),
  element: v => ({ fn: `(k, n) => { let a = [0]; a[0] = ${E}; return ${v('a[0]')} }` }),
  result: (v, i) => ({ pre: `let r${i} = (k, n) => { if (k > 0) return k > 1; return n }`, fn: `(k, n) => ${v(`r${i}(k, n)`)}` }),
  logical: v => ({ fn: `(k, n) => { let v = k > 0 ? 0 : n; v ||= k > 1; return ${v('v')} }` }),
  paramDefault: (v, i) => ({ pre: `let d${i} = (k, v = k > 1) => ${v('v')}`, fn: `(k, n) => k > 0 ? d${i}(k) : d${i}(k, n)` }),
  destructured: v => ({ fn: `(k, n) => { let { v } = { v: ${E} }; return ${v('v')} }` }),
  moduleField: (v, i) => ({ pre: `let t${i} = { v: 0 }`, fn: `(k, n) => { t${i}.v = ${E}; return ${v(`t${i}.v`)} }` }),
  paramField: (v, i) => ({ pre: `let p${i} = (v, k) => { if (k > 0) v = k > 1; let q = { w: v }; return ${v('q.w')} }`, fn: `(k, n) => p${i}(n, k)` }),
  // every call passes an integer carrier (a comparison, a literal): no i32 parameter
  paramInt: (v, i) => ({ pre: `let q${i} = (v) => { let s = 0; for (let j = 0; j < 3; j++) s += v; return [s, ${v('v')}] }`, fn: `(k, n) => k > 0 ? q${i}(k > 1) : q${i}(7)` }),
}
const ARGS = [[2, 5], [1, 5], [0, 5], [0, 0], [0, 1], [2, 0], [1, 1], [0, NaN], [0, 2.5]]

// One module per place: an export per operation.
const program = (at) => Object.entries(OPS).map(([name, op], i) => {
  const { pre, fn } = AT[at](op, i)
  return `${pre ? pre + '\n' : ''}export let ${name} = ${fn}`
}).join('\n')

for (const optimize of levels(0, 2, 3))
  for (const at of Object.keys(AT))
    test(`bool or number: held by ${at}, read like JavaScript at ${optimize}`, () => {
      const src = program(at), want = oracle(src), got = run(src, { optimize })
      for (const name of Object.keys(OPS)) for (const args of ARGS)
        is(got[name](...args), want[name](...args), `${at} ${name}(${args}) at ${optimize}`)
    })

// The same places inside closures an async factory returns: the value its
// promise settles with sits beside every other promise's value, and the
// methods run through that join (summary: a call through a mixed or unknown
// receiver reaches the closure the shapes hold under the name).
const factory = (at) => {
  const entries = Object.entries(OPS).map(([name, op], i) => AT[at](op, i))
  const pre = entries.map(e => e.pre).filter(Boolean)
  const shared = at === 'module' ? pre : []
  return `${shared.join('\n')}
let make = async () => { ${at === 'module' ? '' : pre.join('; ')}; return { ${Object.keys(OPS).map((name, i) => `${name}: ${entries[i].fn}`).join(', ')} } }
let inst = null
export let init = async () => { inst = await make(); return 1 }
${Object.keys(OPS).map(name => `export let ${name} = (k, n) => inst.${name}(k, n)`).join('\n')}`
}
for (const optimize of levels(0, 2, 3))
  test(`bool or number: in an async factory's closures, read like JavaScript at ${optimize}`, async () => {
    for (const at of ['local', 'and', 'paths', 'closureWrite', 'module', 'field']) {
      const src = factory(at), want = oracle(src), got = run(src, { optimize })
      await want.init(); await got.init()
      for (const name of Object.keys(OPS)) for (const args of ARGS)
        is(got[name](...args), want[name](...args), `async ${at} ${name}(${args}) at ${optimize}`)
    }
  })

// A Boolean alone: its own `toString`, and its number where rounding or a
// slot's arithmetic asks for one (the slot holds its atom); `includes`
// compares by SameValueZero (`[false].includes(0)` finds nothing).
test('bool or number: a Boolean alone prints its name, rounds to its number and is found only as itself', () => {
  const src = `let keep = []
export let f = (x) => { let b = x > 1, o = { a: b }; keep.push(o)
  return [b.toString(), Math.floor(b), Math.floor(o.a), o.a * 2, [x > 1 ? 1 : 0].includes(b), [false].includes(0)] }`
  for (const optimize of levels(0, 2, 3)) {
    const want = oracle(src).f, { f } = run(src, { optimize })
    for (const x of [0, 2]) is(f(x), want(x), `f(${x}) at ${optimize}`)
  }
})

// The binding stays a number where every read converts, and a Boolean where
// every store is one: the atoms cost nothing there.
test('bool or number: a binding every read of which converts keeps the raw carrier', () => {
  const wat = jz.compile(`export let f = (k, n) => { let v = k > 0 && n; return v * 2 + (v | 0) }`, { wat: true })
  is(/nan:0x7FF800050/.test(wat) || /nan:0x7FF800040/.test(wat), false, 'no Boolean atom in a numeric-only binding')
})

// @audio/encode-wav's header, reduced (bench/_audiojs/repro/bool-or-number.js):
// `rf64` is false, or the number `junk`, in a closure an async factory returns.
const WAV = `export default async function wav(opts) {
  let { sampleRate, bitDepth = 16, stream } = opts
  let nch = 0, chunks = [], sent = false, exact = null, known = null
  return { encode, flush, free, head }
  function encode(ch) {}
  function declared() {}
  function header(data) {
    let x = 0, junk = known == null ? 36 : 0
    let h = new Uint8Array(12 + junk + 24 + x + 8), dv = new DataView(h.buffer)
    let ch = nch || opts.channels || 1, pad = data & 1, fixed = data !== 0xFFFFFFFF
    let riff = fixed ? h.length - 8 + data + pad : 0xFFFFFFFF
    let rf64 = fixed && riff > 0xFFFFFFFF && junk
    dv.setUint32(0, rf64 ? 0x52463634 : 0x52494646)
    let off = 36 + junk
    dv.setUint32(off + 4, rf64 || data > 0xFFFFFFFF ? 0xFFFFFFFF : data, true)
    return h
  }
  function head() { return exact }
  function flush() {
    if (stream) {
      let h = sent ? null : (sent = true, header(declared()))
      let out = new Uint8Array(h.length + 1); out.set(h); return out
    }
    for (let i = 0; i < chunks.length; i++) {}
  }
  function free() {}
}`
test('bool or number: the reduced encode-wav header compiles and writes RIFF', async () => {
  jz.compile(WAV)
  const entry = `import wav from './wav.js'
let enc = null
export let open = async () => { enc = await wav({ sampleRate: 44100, stream: true }); return 1 }
export let flush = () => [...enc.flush().slice(0, 8)]`
  const enc = await new Function(WAV.replace('export default ', '') + '\nreturn wav')()({ sampleRate: 44100, stream: true })
  const want = [...enc.flush().slice(0, 8)]
  for (const optimize of levels(0, 2, 3)) {
    const { exports } = jz(entry, { optimize, modules: { './wav.js': WAV } })
    await exports.open()
    const got = exports.flush()
    is(String.fromCharCode(...got.slice(0, 4)), 'RIFF', `RIFF at ${optimize}`)
    is(got, want, `header bytes at ${optimize}`)
  }
})
