// ToPrimitive (ECMA-262 7.1.1) calls an object's `[Symbol.toPrimitive]` before
// OrdinaryToPrimitive (7.1.1.1): looked up once (GetMethod: undefined and null mean
// none, any other value not callable is a TypeError), called with the hint "number",
// "string" or "default", its object result a TypeError. Date's own method
// (Date.prototype [ %Symbol.toPrimitive% ], test262's sec-date.prototype-@@toprimitive)
// reads "default" as "string".
// Every operator that converts, against Node, over a method of each origin: an object
// literal's, an arrow under the key, one stored later, a class's, one inherited from a
// base, an override, a getter's value, beside valueOf/toString, undefined and null,
// one that throws, one that returns an object, one that is not callable; read through
// an array of unknown kind and by name. Each method records its hint, so the trace
// shows the hint each operator passes and the order of the calls.
import test from 'tst'
import { is } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { funcWat, oracle, run, wat } from './util.js'

const PRELUDE = `const T = { s: '' }
const note = (s) => { T.s += s + ';' }
class A { [Symbol.toPrimitive](hint) { note('A' + hint); return hint === 'number' ? 7 : hint === 'string' ? 'str' : 'dfl' } }
class B extends A {}
class C extends A { [Symbol.toPrimitive](hint) { note('C' + hint); return hint === 'number' ? 8 : hint === 'string' ? 'cs' : 'cd' } }
class G { get [Symbol.toPrimitive]() { note('G'); return (hint) => { note('g' + hint); return hint === 'number' ? 9 : 'gs' } } }
const lit = { [Symbol.toPrimitive](hint) { note('L' + hint); return hint === 'number' ? 6 : hint === 'string' ? 'ls' : 'ld' } }
const arrow = { [Symbol.toPrimitive]: (hint) => { note('R' + hint); return hint === 'number' ? 5 : hint === 'string' ? 'rs' : 'rd' } }
const later = { k: 1 }
later[Symbol.toPrimitive] = (hint) => { note('N' + hint + later.k); return hint === 'number' ? 4 : 'ns' }
const both = { valueOf() { note('v'); return 1 }, toString() { note('t'); return 'ts' }, [Symbol.toPrimitive](hint) { note('P' + hint); return hint === 'default' ? 'pd' : 3 } }
const off = { [Symbol.toPrimitive]: undefined, valueOf() { note('v'); return 2 } }
const nul = { [Symbol.toPrimitive]: null, toString() { note('t'); return 'nt' } }
const thrower = { [Symbol.toPrimitive](hint) { note('X' + hint); throw new RangeError('x') } }
const objret = { [Symbol.toPrimitive](hint) { note('O' + hint); return {} }, valueOf() { note('v'); return 1 } }
const notfn = { [Symbol.toPrimitive]: 1, valueOf() { note('v'); return 1 } }
const a = new A(), b = new B(), c = new C(), g = new G()
const V = [lit, arrow, later, a, b, c, g, both, off, nul, thrower, objret, notfn]
const KEYS = { str: 'S', dfl: 'D', ls: 'LS', rs: 'RS', ns: 'NS', cs: 'CS', gs: 'GS', nt: 'NT', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine' }
const show = (f) => { T.s = ''; let r
  try { const v = f(); r = typeof v + ':' + String(v) } catch (e) { r = e instanceof TypeError ? 'TypeError' : e instanceof RangeError ? 'RangeError' : 'other' }
  return r + '|' + T.s }
`
const NAMES = ['lit', 'arrow', 'later', 'a', 'b', 'c', 'g', 'both', 'off', 'nul', 'thrower', 'objret', 'notfn']

// An operator a form, `o` its operand: the hint each passes is Node's to answer.
const FORMS = {
  // number
  uplus: '+o', uminus: '-o', sub: 'o - 1', mul: 'o * 2', div: 'o / 2', mod: 'o % 5', pow: 'o ** 2',
  or: 'o | 0', and: 'o & 3', xor: 'o ^ 1', shl: 'o << 1', shr: 'o >> 1', ushr: 'o >>> 0', not: '~o',
  lt: 'o < 8', le: 'o <= 7', gt: 'o > 6', ge: 'o >= 7', rlt: '9 > o', inc: '{ let x = o; x++; return x }',
  Number: 'Number(o)', BigInt: 'BigInt(o)', max: 'Math.max(o, 1)', isNaN: 'isNaN(o)',
  // default
  addn: 'o + 1', nadd: '1 + o', adds: "o + 's'", sadd: "'s' + o",
  eqn: 'o == 7', eqs: "o == 'dfl'", ne: "o != 'ld'", neq: '7 == o',
  // string
  tpl: '`${o}`', tpl2: '`<${o}|${o}>`', String: 'String(o)', key: 'KEYS[o]', in: 'o in KEYS',
  store: '{ const h = {}; h[o] = 1; return Object.keys(h).join() }', join: "[o, 1].join('-')", parseInt: 'parseInt(o)',
}
const body = (expr) => expr.startsWith('{') ? expr : `{ return ${expr} }`
const program = () => PRELUDE + Object.entries(FORMS).map(([name, expr]) =>
  // through an array of unknown kind, and by the name of each receiver
  `const f_${name} = (o) => ${body(expr)}
export let any_${name} = () => { let out = ''; for (let i = 0; i < V.length; i++) out += show(() => f_${name}(V[i])) + ','; return out }
export let known_${name} = () => ${NAMES.map(n => `show(() => ${body(expr.replace(/\bo\b/g, n)).replace(/^\{ return (.*) \}$/, '$1')})`).join(" + ',' + ")}`).join('\n')

// Where both sides convert: left first, each with the hint of its operator.
const PAIRS = `${PRELUDE}
export let pairs = () => [() => lit < arrow, () => arrow >= lit, () => lit + arrow, () => lit - a, () => \`\${lit}\${a}\`,
  () => lit == arrow, () => lit == 'ld', () => [lit, arrow, a].join(), () => Math.max(lit, arrow, a), () => a ** lit,
  () => V[0] < V[3], () => V[3] + V[0], () => V[5] * V[1], () => V[0] == V[0], () => V[10] < V[0], () => V[0] < V[10],
  () => lit + thrower, () => objret < lit].map(show).join(',')`

// A Date's own method: its time for the number hint, its string for the others.
const DATES = `const d = new Date(5)
const D = [d, 1]
export let date = () => [+d, d - 1, d < 6, d == String(d), typeof (d + 1), \`\${d}\` === String(d),
  [d].join() === String(d), Number(d), Math.max(d, 1), typeof (D[0] + 1), D[0] == String(d), +D[0], D[0] > 4].join()`

// Each export's items against Node's, every one that differs listed.
const agreeAll = (src, label) => {
  const host = oracle(src)
  for (const optimize of levels(false, 1, 2, 3)) {
    const m = run(src, { optimize }), bad = []
    for (const name of Object.keys(host)) {
      const want = String(host[name]()).split(','), got = String(m[name]()).split(',')
      const receivers = name.startsWith('known_') || name.startsWith('any_')
      for (let k = 0; k < Math.max(want.length, got.length); k++) if (want[k] !== got[k])
        bad.push(`${name}[${receivers ? NAMES[k] : k}]: jz ${got[k]} node ${want[k]}`)
    }
    is(bad, [], `${label} at ${optimize}`)
  }
}

test('symbol-to-primitive: every converting operator passes its hint, as Node', () => agreeAll(program(), 'forms'))
test('symbol-to-primitive: both sides convert left first, a throw and an object result stop the conversion', () => agreeAll(PAIRS, 'pairs'))
test('symbol-to-primitive: a Date takes the string hint for the default one', () => agreeAll(DATES, 'dates'))

// A conversion runs the program's code: what the method writes is read after it,
// in a loop and beside a read before it, as the frame's effects must say.
const EFFECTS = `const st = { n: 0 }
let count = 0
const o = { [Symbol.toPrimitive](h) { count++; st.n += 2; return 1 } }
class K { [Symbol.toPrimitive](h) { count += 10; return h === 'number' ? 2 : 'k' } }
const k = new K()
const a = [1, 2, 3, 4]
export let f = () => { count = 0; let s = 0; for (let i = 0; i < 3; i++) s += +o + count; return s }
export let g = () => { st.n = 0; let s = 0; for (let i = 0; i < 4; i++) { const before = st.n; s += a[i] * o + before + st.n } return s }
export let h = () => { count = 0; let s = 0; for (let i = 0; i < 3; i++) s += (k < 5) + count; return s }
export let m = () => { count = 0; const t = count; const x = \`\${k}\`; return t + ':' + count + x }
export let n = () => { count = 0; let s = ''; for (let i = 0; i < 2; i++) s += k + count; return s }`
test('symbol-to-primitive: the method runs as a call, its writes seen after it', () => agreeAll(EFFECTS, 'effects'))

// The step is linked only where the program spells the key: jzify writes every
// `[Symbol.toPrimitive]` as the member `@@toPrimitive`, and the census of members
// (src/member-uses.js) finds it among those defined or stored. A program with
// valueOf alone keeps the two hints' functions, each with its two lookups, and no
// third; with the key, each looks up three members and the default hint has its own.
test('symbol-to-primitive: a program with no [Symbol.toPrimitive] links no lookup and no default-hint function', () => {
  const lookups = (text, name) => funcWat(text, name).split('call $__dyn_get_t_hm').length - 1
  const plain = wat(`const o = { valueOf() { return 2 } }
export let f = (x) => [x][0] + o`, { optimize: false })
  is([lookups(plain, '__jz_tp_str'), lookups(plain, '__jz_tp_num'), funcWat(plain, '__jz_tp_dflt')], [2, 2, ''], 'valueOf alone')
  const exotic = wat(`const o = { [Symbol.toPrimitive](h) { return h.length } }
export let f = (x) => [x][0] + o`, { optimize: false })
  is([lookups(exotic, '__jz_tp_str'), lookups(exotic, '__jz_tp_num'), lookups(exotic, '__jz_tp_dflt')], [3, 3, 3], 'a [Symbol.toPrimitive]')
})

// An Error's message is ToString of its argument: a literal or a binding with the key
// converts through it, where its keys alone read as a closed object with no method.
const ERRORS = `const held = { k: 1, [Symbol.toPrimitive](hint) { return 'h:' + hint } }
export let errs = () => [new Error({ [Symbol.toPrimitive](hint) { return 'l:' + hint } }).message,
  new TypeError(held).message, new RangeError({ k: 2 }).message].join()`
test('symbol-to-primitive: an Error message converts its argument with the string hint', () => agreeAll(ERRORS, 'errors'))
