// A module name that holds a method of `Object.prototype` for good is the
// method where it is called through `call` (src/compile/plan/scope.js
// resolveHeldMethods): `var toStr = Object.prototype.toString; … toStr.call( v )`
// is `Object.prototype.toString.call( v )`, the form jz has for the method named
// in place. A library tests a value's class this way from a module of its own
// (stdlib's utils/native-class, assert/has-own-property), so the name is
// resolved where the modules are one program. Every form answers what the host
// answers.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { levels, onKernel } from './_matrix.js'
import { oracle } from './util.js'

const VALUES = '[1, "s", [1, 2], { a: 1 }, null, undefined, true, 2.5, NaN]'
// [source, the exports called with no argument]
const programs = {
  'the class of a value': `var toStr = Object.prototype.toString
    const classOf = (v) => toStr.call(v)
    export let f = () => ${VALUES}.map(classOf).join(' ')`,
  'an own member': `var has = Object.prototype.hasOwnProperty
    const own = (o, k) => (o === void 0 || o === null) ? false : has.call(o, k)
    export let f = () => { const o = { a: 1, b: undefined }; return [own(o, 'a'), own(o, 'b'), own(o, 'c'), own(null, 'a'), own([7], 0), own([7], 1), own('st', 'length')] }`,
  'through a second name': `var toStr = Object.prototype.toString
    var cls = toStr
    const tag = cls
    export let f = () => tag.call([]) + cls.call(1) + toStr.call('s')`,
  'called at the level of the module': `var toStr = Object.prototype.toString
    var ARR = toStr.call([]), NUM = toStr.call(1)
    export let f = () => ARR + NUM`,
  'beside the method named in place': `var toStr = Object.prototype.toString
    export let f = () => toStr.call(1) === Object.prototype.toString.call(2) ? 1 : 0`,
}
// the modules of a library: [the modules, the main source]
const library = {
  './tostring.js': 'var toStr = Object.prototype.toString;\nexport default toStr;',
  './class.js': "import toStr from './tostring.js'\nfunction nativeClass(v) { return toStr.call(v) }\nexport default nativeClass",
  './has.js': "var has = Object.prototype.hasOwnProperty\nfunction hasOwnProp(value, property) { if (value === void 0 || value === null) { return false } return has.call(value, property) }\nexport default hasOwnProp",
  './isnumber.js': "import nativeClass from './class.js'\nexport default function isNumber(v) { return typeof v === 'number' || nativeClass(v) === '[object Number]' }",
}
const MAIN = `import nativeClass from './class.js'
  import hasOwnProp from './has.js'
  import isNumber from './isnumber.js'
  export let f = () => [nativeClass(1), nativeClass('s'), nativeClass([1]), nativeClass(null), hasOwnProp({ a: 1 }, 'a'), hasOwnProp({ a: 1 }, 'b'), hasOwnProp(null, 'a'), isNumber(2), isNumber('2')]`

test('held method: a name that holds a method of Object.prototype calls it', () => {
  for (const [name, src] of Object.entries(programs)) {
    const want = oracle(src).f()
    for (const optimize of levels(0, 2, 3)) is(jz(src, { optimize }).exports.f(), want, `${name} at ${optimize}`)
  }
})

test('held method: across the modules of a library', () => {
  const want = ['[object Number]', '[object String]', '[object Array]', '[object Null]', true, false, false, true, false]
  for (const optimize of levels(0, 2, 3)) is(jz(MAIN, { modules: library, optimize }).exports.f(), want, `at ${optimize}`)
})

test('held method: the name and its declaration are gone', () => {
  if (onKernel()) return
  for (const optimize of levels(2, 3)) {
    const text = compile(MAIN, { modules: library, optimize, wat: true })
    ok(!/toStr|\$__has_js\$has\b/.test(text), `at ${optimize}: no global of the name is left`)
  }
})

test('held method: a name a store may change, or used as a value, is not the method', () => {
  // the method as a value has no form in the target: the compile says so, as it did
  const open = {
    'a second store': 'var toStr = Object.prototype.toString\nexport let set = (g) => { toStr = g }\nexport let f = (v) => toStr.call(v)',
    'handed on as a value': 'var toStr = Object.prototype.toString\nconst apply = (g, v) => g.call(v)\nexport let f = (v) => apply(toStr, v)',
    'called with no receiver': 'var toStr = Object.prototype.toString\nexport let f = () => toStr.call()',
  }
  for (const [name, src] of Object.entries(open)) throws(() => compile(src), /Object\.prototype|not in scope|not supported/, name)
})

// A held builtin is any function of the target a name holds: a method of a prototype
// the target dispatches by the receiver's kind (String, Number, Boolean, Array beside
// Object), a function named bare or in a namespace (`Symbol`, `String.fromCharCode`).
// `name.call( recv, …args )` is the method on the receiver, `name( …args )` the function,
// `name.member` the member as prepare names one: a member the target does not serve
// (`Sym.toStringTag`, a well-known symbol) is undefined, as a missing property is.
const builtins = {
  'a method of String.prototype': `var lower = String.prototype.toLowerCase, sl = String.prototype.slice
    export let f = () => lower.call('AbC') + sl.call('abcdef', 1, 3)`,
  'a method of Number.prototype and Boolean.prototype': `var numStr = Number.prototype.toString, boolStr = Boolean.prototype.toString
    export let f = () => { const n = 255; return numStr.call(n, 16) + numStr.call(n - 248) + boolStr.call(n > 0) }`,
  'the prototype held whole': `var proto = Object.prototype
    var toStr = proto.toString
    const cls = (v) => proto.toString.call(v) + toStr.call(v)
    export let f = () => cls(1) + cls('s')`,
  'a primitive prototype method borrowed in place': `export let f = () => { const n = 255, s = 'abcdef', b = n > 0
    return Number.prototype.toString.call(n, 16) + String.prototype.slice.call(s, 1, 3) + Boolean.prototype.toString.call(b) + Number.prototype.toFixed.call(n / 8, 2) }`,
  'a method of Array.prototype': `var slice = Array.prototype.slice
    export let f = () => slice.call([1, 2, 3, 4], 2).length + slice.call([1, 2, 3, 4], 1, 2)[0]`,
  'a function of a namespace': `var fromCC = String.fromCharCode
    export let f = () => fromCC(65, 66) + fromCC.call(null, 67)`,
  'through a second name': `var fromCC = String.fromCharCode
    var fc2 = fromCC
    const fc3 = fc2
    export let f = () => fc3(68)`,
  'the Symbol constructor, held after a test of it': `var Sym = ( typeof Symbol === 'function' ) ? Symbol : void 0
    var hasSymbols = ( typeof Symbol === 'function' && typeof Symbol( 'foo' ) === 'symbol' )
    export let f = () => [typeof Sym('a'), Sym.for('k') === Sym.for('k'), Sym('a') === Sym('a'), hasSymbols].join(' ')`,
}

test('held builtin: a name that holds a function of the target calls it', () => {
  for (const [name, src] of Object.entries(builtins)) {
    const want = oracle(src).f()
    for (const optimize of levels(0, 2, 3)) is(jz(src, { optimize }).exports.f(), want, `${name} at ${optimize}`)
  }
})

// A member of a held namespace the target does not serve (`__defineGetter__`, a legacy
// accessor of Object.prototype) reads as undefined, where the host has a function:
// a library's polyfill of `Object.defineProperty` holds them and never runs.
test('held builtin: a member of a held namespace the target does not serve is undefined', () => {
  const src = `var proto = Object.prototype
    var getter = proto.__defineGetter__, lookup = proto.__lookupGetter__
    export let f = () => typeof getter + ' ' + typeof lookup + ' ' + proto.toString.call(2)`
  for (const optimize of levels(0, 2, 3)) is(jz(src, { optimize }).exports.f(), 'undefined undefined [object Number]', `at ${optimize}`)
})

test('held builtin: the name and its declaration are gone', () => {
  if (onKernel()) return
  for (const optimize of levels(2, 3)) {
    const text = compile(builtins['a function of a namespace'] + '\n' + builtins['the Symbol constructor, held after a test of it'].replace(/export let f/, 'export let g'), { optimize, wat: true })
    ok(!/fromCC|\$Sym\b/.test(text), `at ${optimize}: no global of the name is left`)
  }
})

// `__object_toString`, the class of a value, answers a string (kind-traits.js,
// summary/index.js): two of them added in a body spliced twice, once with a number and
// once with a string, added as numbers where the sum's kind had to be guessed (VT['+']
// takes an unknown side as a number), and the string site's sum was lost.
test('held method: the class of a value is a string where two are added', () => {
  const src = `const cls = (v) => Object.prototype.toString.call(v) + Object.prototype.toString.call(v)
    export let f = () => cls(1) + cls('s')`
  for (const optimize of levels(0, 2, 3, 'size')) is(jz(src, { optimize }).exports.f(), '[object Number][object Number][object String][object String]', `at ${optimize}`)
})

