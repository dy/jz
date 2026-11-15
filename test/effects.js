// What a call does is one summary (src/optimize/effects.js), solved once a module: its rows
// as the bodies show them, the helpers' hand facts held to the bodies they stand for, a
// payload store kept off the header words, the passes that ask it answering by it, and no
// file of src/optimize closing over the call graph for itself.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import parseWat from 'watr/parse'
import { compile, funcWat, jz } from './util.js'
import { solveEffects, HELPERS, helper } from '../src/optimize/effects.js'
import { HEADER_STORE_FREE, headerStore } from '../src/optimize/address.js'
import { forwardStores } from '../src/optimize/forward-store.js'
import { numberValues, LOAD_AT } from '../src/optimize/numbering.js'
const reuseLoads = (fn, fx) => numberValues(fn, LOAD_AT, fx)
import { forwardCheckedElements } from '../src/optimize/forward-checked.js'
import { earlyStores } from '../src/optimize/early-stores.js'
import { promoteGlobals } from '../src/optimize/globals.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const count = (n, op) => !Array.isArray(n) ? 0 : (n[0] === op ? 1 : 0) + n.reduce((s, c) => s + count(c, op), 0)
const funcsOf = (text) => parseWat(text).filter(n => Array.isArray(n) && (n[0] === 'func' || n[0] === 'import'))

test('effects: a callee\'s row joins its caller\'s, the host does everything, a shim what it says', () => {
  const funcs = [
    ['func', '$set', ['global.set', '$g', ['i32.const', 1]]],
    ['func', '$put', ['param', '$p', 'i32'], ['f64.store', ['local.get', '$p'], ['f64.const', 1]]],
    ['func', '$len', ['param', '$p', 'i32'], ['i32.store', ['local.get', '$p'], ['i32.const', 1]]],
    ['func', '$viaTail', ['return_call', '$set']],
    ['func', '$viaHost', ['call', '$cb']],
    ['func', '$viaShim', ['call', '$__now', ['i32.const', 0]], ['drop']],
    ['func', '$viaRandom', ['call', '$__env_random', ['i32.const', 0], ['i32.const', 8]]],
    ['func', '$fails', ['call', '$__alloc', ['i32.const', 8]], ['drop'], ['throw', '$e']],
    ['func', '$__alloc', ['param', '$n', 'i32'], ['result', 'i32'], ['global.set', '$__heap', ['i32.const', 8]], ['i32.store', ['i32.const', 0], ['i32.const', 0]], ['i32.const', 0]],
  ]
  const fx = solveEffects(funcs, { callsNothing: new Set(['$__now', '$__env_random']) })
  ok(fx.sets('$viaTail', '$g'), 'a tail call is an edge')
  ok(fx.writes('$put') && !fx.header('$put'), 'a payload store writes memory and no header word')
  ok(fx.header('$len'), 'a word store may write a header')
  ok(fx.sets('$viaHost', '$g') && fx.sets('$viaHost', '$__heap') && fx.header('$viaHost') && fx.host('$viaHost'), 'a function the user imports does what any function does')
  ok(!fx.setsAny('$viaShim') && !fx.writes('$viaShim'), 'a shim of the runtime\'s own calls no export')
  ok(fx.writes('$viaRandom') && !fx.setsAny('$viaRandom') && !fx.header('$viaRandom'), 'the entropy shim writes the bytes it is handed')
  ok(!fx.returns('$fails') && fx.throws('$fails'), 'a function that ends in a throw never returns')
  ok(fx.sets('$fails', '$__heap') && !fx.writes('$fails'), 'the allocator moves the heap\'s top and writes only the block it returns')
  ok(fx.sets('$later', '$g') && fx.header('$later'), 'a name the module does not define is the host')
  ok(solveEffects(funcs, { later: new Map([['$put', ['$set']]]) }).sets('$put', '$g'), 'a callee a later pass puts in counts already')
})

// The programs whose runtime the hand facts are held to: strings, arrays and their growth,
// typed arrays, records, a throw, the math runtime, the durable log and the escape flags.
const PROGRAMS = [
  `export let f = (s, n) => { let t = ''; for (let i = 0; i < n; i++) t += s[i % s.length] + i; return t.indexOf('3') + t.lastIndexOf('1') + (t === s ? 1 : 0) + t.length }`,
  `export let f = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(Math.sin(i) * Math.exp(i / n) + Math.log(i + 1)); return a.length + a[n >> 1] }`,
  `export let f = (n) => { const t = new Float64Array(n), u = new Int32Array(n); for (let i = 0; i < n; i++) { t[i] = Math.pow(i, 1.5); u[i] = i * 3 } return t.reduce((s, x) => s + x, 0) + u[n - 1] }`,
  `export let f = (o, k) => { const r = { a: 1, b: [1, 2] }; r[k] = o; if (o == null) throw new TypeError('x'); return JSON.stringify(r).length + o.x }`,
  `const keep = []; export let f = (n) => { const a = [n, n + 1]; keep.push(a); return keep.length }`,
  `let log = []; export let f = (x) => { const o = { v: x }; log = [o]; return log[0].v }`,
]

test('effects: every hand fact holds where the module holds the helper\'s body', () => {
  const seen = new Set()
  for (const src of PROGRAMS) for (const optimize of [0, 2]) {
    const funcs = funcsOf(compile(src, { optimize, wat: true }))
    const raw = solveEffects(funcs.filter(n => n[0] === 'func'), { raw: true })
    for (const fn of funcs) {
      const e = fn[0] === 'func' && helper(fn[1])
      if (!e?.[1]) continue
      seen.add(e[0])
      const name = fn[1], kind = e[1]
      if (kind === 'pure' || kind === 'header')
        ok(!raw.writes(name) && !raw.setsAny(name) && !raw.host(name) && raw.returns(name), `${name} (${kind}) writes, sets and calls out nothing (${e[2]})`)
      if (kind === 'pure' && e[0].startsWith('$__ptr_') || e[0] === '$__mkptr')
        is(count(fn, 'i32.load') + count(fn, 'i64.load') + count(fn, 'f64.load'), 0, `${name} reads no memory`)
      // (the block it writes is its own, which no body shows: what one shows is that it calls out to nothing)
      if (kind === 'fresh' || kind === 'log') ok(!raw.host(name), `${name} (${kind}) reaches no host and no indirect call (${e[2]})`)
      if (kind === 'throw') ok(!raw.returns(name), `${name} never returns`)
    }
  }
  // (held to no body here: the engine's string builtins, imports; the concatenation a user's
  // toString may run, and the roots' log of a frame the arena rewinds, which these programs pull none of)
  is(HELPERS.filter(e => e[1] && !seen.has(e[0])).map(e => e[0]), ['$__jss_*', '$__str_concat', '$__root'], 'the entries held to no body')
})

// A header word of a block is the length at -8 and the forward word at -4 of its pointer: jz
// writes those with i32.store alone (the allocator too, ahead of the pointer it returns), so a wide
// store (HEADER_STORE_FREE) writes none, and the passes that take it as no header write
// (LICM, the pointer hoists, forwardHops) hold. Every solve checks it under JZ_DEBUG_INVARIANTS;
// here, over the programs above at three levels.
test('effects: a wide store writes no header word (HEADER_STORE_FREE)', () => {
  let stores = 0
  for (const src of PROGRAMS) for (const optimize of [0, 2, 'speed']) {
    for (const fn of funcsOf(compile(src, { optimize, wat: true }))) {
      if (fn[0] !== 'func') continue
      const walk = (n) => {
        if (!Array.isArray(n)) return
        if (HEADER_STORE_FREE.has(n[0])) { stores++; ok(!headerStore(n), `${fn[1]}: ${JSON.stringify(n).slice(0, 120)}`) }
        for (let i = 1; i < n.length; i++) walk(n[i])
      }
      walk(fn)
    }
  }
  ok(stores > 100, `${stores} wide stores read`)
  ok(headerStore(['i64.store', ['i32.sub', ['local.get', '$p'], ['i32.const', 12]], ['i64.const', 0]]), 'a store across the length word is one')
  ok(headerStore(['v128.store', ['i32.sub', ['local.get', '$p'], ['i32.const', 16]], ['v128.const', 'i64x2', 0, 0]]), 'a vector over the header is one')
  ok(!headerStore(['i64.store', ['i32.sub', ['local.get', '$p'], ['i32.const', 16]], ['i64.const', 0]]), 'the word before the header is none')
})

test('effects: no file of src/optimize closes over the call graph for itself', () => {
  // (a fixpoint over what each function calls, kept by its name: the six closures it replaced,
  // in globals.js, forward-hops.js, forward-checked.js, licm.js and static-scratch.js, read so)
  const files = []
  const walk = (dir) => { for (const f of readdirSync(dir, { withFileTypes: true })) f.isDirectory() ? walk(join(dir, f.name)) : f.name.endsWith('.js') && files.push(join(dir, f.name)) }
  walk(join(ROOT, 'src/optimize'))
  for (const file of files) {
    const name = file.slice(file.lastIndexOf('/') + 1)
    if (name === 'effects.js') continue
    const text = readFileSync(file, 'utf8')
    const graph = /\.set\([\][\w]+,\s*\{?\s*(calls|callees)\b|callees\.set\(|calls\.set\(/.test(text)
    const fixpoint = /changed = true|grew = true/.test(text)
    ok(!(graph && fixpoint), `${name} closes over the call graph: ask optimize/effects.js`)
  }
})

// D11: memory outlives the activation, so a store a throw may follow is no dead store, though
// the slot is stored again past the throw: the caller's catch reads what it left.
test('effects: a store before a call that may throw stays (forwardStores)', () => {
  const thrower = ['func', '$__throw_x', ['throw', '$__jz_err', ['f64.const', 0]]]
  const fn = () => ['func', '$f', ['param', '$p', 'i32'], ['param', '$c', 'i32'],
    ['f64.store', ['local.get', '$p'], ['f64.const', 1]],
    ['if', ['local.get', '$c'], ['then', ['call', '$__throw_x'], ['drop', ['unreachable']]]],
    ['f64.store', ['local.get', '$p'], ['f64.const', 2]]]
  const f = fn()
  forwardStores(f, solveEffects([f, thrower]))
  is(count(f, 'f64.store'), 2, 'the first store stays')
  // without the guard the first store is dead
  const g = fn(); g.splice(4, 1)
  forwardStores(g, solveEffects([g, thrower]))
  is(count(g, 'f64.store'), 1, 'overwritten unread, it goes')
})

// D7: a global is no memory. A slot whose address reads no global keeps its value across a
// global's write; one whose address reads that global does not.
test('effects: a global\'s write ends no remembered memory but what its address reads (forwardStores)', () => {
  const f = ['func', '$f', ['param', '$p', 'i32'], ['local', '$x', 'f64'],
    ['f64.store', ['local.get', '$p'], ['f64.const', 1]],
    ['global.set', '$g', ['i32.const', 3]],
    ['local.set', '$x', ['f64.load', ['local.get', '$p']]]]
  forwardStores(f, solveEffects([f]))
  is(count(f, 'f64.load'), 0, 'the load reads the stored value')
  const g = ['func', '$f', ['local', '$x', 'f64'],
    ['f64.store', ['global.get', '$a'], ['f64.const', 1]],
    ['global.set', '$a', ['i32.const', 64]],
    ['f64.store', ['global.get', '$a'], ['f64.const', 2]],
    ['local.set', '$x', ['f64.load', ['global.get', '$a']]]]
  forwardStores(g, solveEffects([g]))
  is(count(g, 'f64.store'), 2, 'a store at the old address is no dead store')
})

test('effects: a global\'s write leaves the memory a load named (forwardChecked)', () => {
  const store = ['if', ['i32.lt_u', ['local.get', '$i'], ['i32.shr_u', ['i32.load', ['i32.sub', ['local.get', '$b'], ['i32.const', 8]]], ['i32.const', 2]]],
    ['then', ['i32.store', ['i32.add', ['local.get', '$b'], ['i32.shl', ['local.get', '$i'], ['i32.const', 2]]], ['local.get', '$w']]]]
  const load = () => ['if', ['result', 'f64'], ['i32.lt_u', ['local.get', '$i'], ['i32.shr_u', ['i32.load', ['i32.sub', ['local.get', '$b'], ['i32.const', 8]]], ['i32.const', 2]]],
    ['then', ['f64.convert_i32_s', ['i32.load', ['i32.add', ['local.get', '$b'], ['i32.shl', ['local.get', '$i'], ['i32.const', 2]]]]]], ['else', ['f64.const', 'nan']]]
  const f = ['func', '$f', ['param', '$b', 'i32'], ['param', '$i', 'i32'], ['param', '$w', 'i32'], ['result', 'f64'],
    store, ['global.set', '$n', ['i32.const', 1]], load()]
  const m = ['module', f]
  forwardCheckedElements(m, solveEffects([f]))
  ok(JSON.stringify(f).includes('$__fw'), 'the load takes the word the store left')
})

// D2: a call whose result is a function of its operands writes nothing.
test('effects: a pure call ends no remembered load (reuseLoads)', () => {
  const f = ['func', '$f', ['param', '$p', 'i32'], ['local', '$x', 'f64'], ['local', '$y', 'f64'],
    ['local.set', '$x', ['f64.load', ['local.get', '$p']]],
    ['drop', ['call', '$math.sin', ['local.get', '$x']]],
    ['local.set', '$y', ['f64.load', ['local.get', '$p']]]]
  reuseLoads(f, solveEffects([f]))
  is(count(f, 'f64.load'), 1, 'the second load reads the first')
  const g = ['func', '$f', ['param', '$p', 'i32'], ['local', '$x', 'f64'], ['local', '$y', 'f64'],
    ['local.set', '$x', ['f64.load', ['local.get', '$p']]],
    ['call', '$w', ['local.get', '$p']],
    ['local.set', '$y', ['f64.load', ['local.get', '$p']]]]
  const w = ['func', '$w', ['param', '$p', 'i32'], ['f64.store', ['local.get', '$p'], ['f64.const', 0]]]
  reuseLoads(g, solveEffects([g, w]))
  is(count(g, 'f64.load'), 2, 'a call that writes memory ends it')
  // (one that writes nothing too, but a pure one: a forward hop reads its word by its shape, forward-hops.js)
  const h = ['func', '$f', ['param', '$p', 'i32'], ['local', '$x', 'i32'], ['local', '$y', 'i32'],
    ['local.set', '$x', ['i32.load', ['local.get', '$p']]],
    ['drop', ['call', '$__ptr_offset_fwd', ['local.get', '$p']]],
    ['local.set', '$y', ['i32.load', ['local.get', '$p']]]]
  reuseLoads(h, solveEffects([h]))
  is(count(h, 'i32.load'), 2, 'a header read ends it as well')
})

test('effects: a store goes ahead of a pure call and of a global\'s write (earlyStores)', () => {
  // (f64.div and the call: the work a store crosses to start early)
  const work = ['local.set', '$t', ['f64.div', ['f64.div', ['f64.div', ['local.get', '$v'], ['f64.const', 3]], ['f64.const', 5]], ['call', '$math.sin', ['local.get', '$v']]]]
  const f = ['func', '$f', ['param', '$o', 'i32'], ['param', '$v', 'f64'], ['local', '$t', 'f64'],
    work, ['global.set', '$n', ['i32.const', 1]], ['f64.store', ['local.get', '$o'], ['local.get', '$v']]]
  f.distinctParams = new Set(['$o'])
  earlyStores(f, solveEffects([f]))
  is(f.findIndex(n => Array.isArray(n) && n[0] === 'f64.store'), 5, 'the store stands first')
})

// A global its function as a whole keeps no copy of (the function calls the host, which may
// call an export that sets it) a loop that calls nothing keeps, read as the loop is entered.
test('effects: a loop keeps a copy of a global its function cannot (promoteGlobals)', () => {
  const body = (call) => `import { cb } from 'host'
let g = 1.5
export let bump = () => { g = g + 1 }
export let f = (n) => { cb(); let s = 0; for (let i = 0; i < n; i++) { ${call} s += g * i + g } return s }`
  // the reads of g inside a loop
  const inLoop = (src) => {
    const text = funcWat(compile(src, { optimize: 2, wat: true, imports: { host: { cb: () => {} } } }), 'f')
    let depth = 0, reads = 0
    const loops = []
    for (let i = 0; i < text.length; i++) {
      if (text.startsWith('(loop', i)) loops.push(depth)
      if (text[i] === '(') depth++
      else if (text[i] === ')') { depth--; if (loops.length && depth === loops[loops.length - 1]) loops.pop() }
      if (loops.length && text.startsWith('global.get $g)', i)) reads++
    }
    return reads
  }
  is(inLoop(body('')), 0, 'the loop reads its copy')
  ok(inLoop(body('cb();')) > 0, 'a loop that calls the host reads the global')
  // (cb bumps g: once ahead of the loop, 2.5 each round, 15; in the loop too, 3.5 4.5 5.5, 29)
  for (const [call, want] of [['', 15], ['cb();', 29]]) {
    const ex = {}, m = jz(body(call), { optimize: 2, imports: { host: { cb: () => ex.bump() } } }).exports
    ex.bump = m.bump
    is(m.f(3), want, `${call || 'no call'} in the loop`)
  }
  // (a loop the emitter wraps in a block of its own copies ahead of that block, where LICM's
  // lifts of the copy read it set: the host replaces the array between the outer rounds)
  const arr = `import { cb } from 'host'
let g = [7, 6, 5]
export let m = () => { g = [3, 4, 5] }
export let f = (k) => { let s = 0; for (let i = 0; i < 2; i++) { cb(); s += g[0]; for (let j = 0; j < k + 1; j++) { s += g.length; s += g[1]; s += g[0] } }; return s }`
  for (const optimize of [2, 'speed']) {
    const ex = {}, m = jz(arr, { optimize, imports: { host: { cb: () => ex.m() } } }).exports
    ex.m = m.m
    is([m.f(1), m.f(0)], [46, 26], `an array the host replaces, at ${optimize}`)
  }
  // (a copy is paid as the loop is entered and repaid a round: a global read once, in a loop
  // that follows a chain and mostly runs one round, gets no copy; read three times, the
  // function's threshold, it gets one; read once in a counted loop, whose rounds repay it, too)
  const chase = (reads) => ['func', '$f', ['param', '$o', 'i32'], ['result', 'i32'],
    ['block', '$done', ['loop', '$l',
      ...Array.from({ length: reads }, () => ['br_if', '$done', ['i32.gt_u', ['local.get', '$o'], ['global.get', '$end']]]),
      ['br_if', '$l', ['local.tee', '$o', ['i32.load', ['local.get', '$o']]]]]],
    ['local.get', '$o']]
  const copies = (fn) => { promoteGlobals(fn, new Map([['$end', 'i32']]), solveEffects([fn])); return fn.filter(n => Array.isArray(n) && n[0] === 'local' && /^\$_pg/.test(n[1])).length }
  is(copies(chase(1)), 0, 'one read in a loop: no copy')
  is(copies(chase(3)), 1, 'three reads: a copy')
  const counted = ['func', '$f', ['param', '$n', 'i32'], ['local', '$i', 'i32'], ['local', '$s', 'i32'], ['result', 'i32'],
    ['block', '$brk', ['loop', '$l', ['br_if', '$brk', ['i32.eqz', ['i32.lt_s', ['local.get', '$i'], ['local.get', '$n']]]],
      ['local.set', '$s', ['i32.add', ['local.get', '$s'], ['i32.load', ['i32.add', ['global.get', '$end'], ['local.get', '$i']]]]],
      ['local.set', '$i', ['i32.add', ['local.get', '$i'], ['i32.const', 1]]], ['br', '$l']]],
    ['local.get', '$s']]
  is(copies(counted), 1, 'one read in a counted loop: a copy')
})
