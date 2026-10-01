// An object literal's accessor lowers to the slots `x__get`/`x__set`
// (jzify/classes.js); every builtin that lists or copies properties, and a
// computed key, sees the one property `x` (src/ast.js layoutView), read
// through its getter. JSON.stringify calls a value's toJSON
// (src/compile/emit/to-json.js). Each program runs against the host, at every
// level, on fresh module state. Value-returning exports use f: WASI reserves
// a zero-argument run as its void command entry.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { levels, onKernel, onWasi } from './_matrix.js'
import { ptrBits, PTR } from '../layout.js'
import { oracle } from './util.js'

const agree = (cases) => {
  for (const [name, src, args = []] of cases) for (const optimize of levels(0, 2, 3))
    is(jz(src, { optimize }).exports.entry(...args), oracle(src).entry(...args), `${name} O${optimize}`)
}
const O = `{ a: 1, get g() { return 7 }, set s(v) { this.a = v } }`

test('literal accessors: dynamic layouts reject instead of exposing internal slots', () => {
  for (const props of [
    '[k]: 1, get g() { return 7 }', 'get g() { return 7 }, [k]: 1',
    '[k]: 1, set g(v) {}', '...x, get g() { return 7 }',
    'get g() { return 7 }, ...x', '...x, set g(v) {}',
  ]) for (const optimize of levels(0, 2, 3))
    throws(() => compile(`export function f(k) { const x = {}; x[k] = 1; return {${props}} }`, { optimize }),
      /object literal accessors require statically known property names/)
  agree([
    ['known spread with accessor', `export const entry = () => { const o = { ...{ a: 1 }, get g() { return 7 } }; return JSON.stringify([o.g, Object.keys(o)]) }`],
    ['dynamic spread copies accessor values', `export const entry = k => { const x = {}; x[k] = 1; const o = { ...x, ...{ get g() { return 7 } } }; return JSON.stringify([o.g, Object.keys(o)]) }`, ['a']],
  ])
})

test('literal accessors: dynamic spread copies visible keys and reads each getter once', () => agree([
  ...['false', 'true'].map(cond => ['conditional ' + cond, `export const entry = k => {
    let calls = 0; const x = {}; x[k] = 1
    const o = { ...x, ...(${cond} && { 2: 20, a: 3, get 1() { calls++; return 10 }, set z(v) {} }) }
    return JSON.stringify([Object.keys(o), Object.values(o), calls])
  }`, ['b']]),
  ['getter effects precede later properties', `export const entry = k => {
    let calls = 0; const x = {}; x[k] = 1
    const o = { ...x, ...{ get g() { calls++; return 7 } }, after: calls }
    return JSON.stringify([o.g, o.g, o.after, calls, Object.keys(o)])
  }`, ['a']],
]))

test('literal accessors: dynamic spread preserves throws and repeated-call state', () => {
  const src = `let calls = 0, after = 0
    export function entry(k, fail) {
      const x = {}; x[k] = 1
      try {
        const o = { ...x, ...{ get g() { calls++; if (fail) throw 11; return calls } }, after: ++after }
        return [o.g, o.g, o.after, calls, Object.keys(o).join()].join('|')
      } catch (e) { return ['throw', e, calls, after].join('|') }
    }`
  for (const optimize of levels(0, 2, 3)) {
    const got = jz(src, { optimize }).exports, want = oracle(src)
    for (const [k, fail] of [['a', false], ['a', false], ['', true], ['g', false], ['', false]])
      is(got.entry(k, fail), want.entry(k, fail), `${k}, throw=${fail}, O${optimize}`)
  }
})

test('literal accessors: the builtins list and read them by name', () => agree([
  // each listed `g__get`/`s__set`, read the getter's closure, or dropped the key
  ['keys', `export const entry = () => JSON.stringify(Object.keys(${O}))`],
  ['keys of a binding', `export const entry = () => { const o = ${O}; return JSON.stringify(Object.keys(o)) }`],
  ['values', `export const entry = () => { const o = ${O}; return JSON.stringify(Object.values(o)) }`],
  ['entries', `export const entry = () => JSON.stringify(Object.entries(${O}))`],
  ['for-in', `export const entry = () => { const o = ${O}; let s = ''; for (const k in o) s += k + '=' + o[k] + ';'; return s }`],
  ['JSON.stringify', `export const entry = () => { const o = ${O}; return JSON.stringify(o) }`],
  ['Object.assign', `export const entry = () => { const t = Object.assign({}, ${O}); return JSON.stringify([t, 's' in t]) }`],
  ['assign into a binding', `export const entry = () => { const t = { a: 0, g: 0 }; Object.assign(t, ${O}); return JSON.stringify(t) }`],
  ['fromEntries', `export const entry = () => JSON.stringify(Object.fromEntries(Object.entries(${O})))`],
  ['structuredClone', `export const entry = () => JSON.stringify(structuredClone(${O}))`],
  ['hasOwnProperty', `export const entry = () => [({ get g() { return 1 } }).hasOwnProperty('g'), ({ get g() { return 1 } }).hasOwnProperty('h')].join()`],
  // a receiver whose layout the compiler cannot name enumerates at runtime
  ['unknown receiver', `const pick = (k) => k > 0 ? { a: 1, get g() { return 7 } } : { a: 2 }
export const entry = (k) => JSON.stringify([Object.keys(pick(k)), Object.values(pick(k)), Object.keys(pick(0))])`, [1]],
  ['parameter receiver', `const ks = (o) => Object.keys(o).join('|') + '/' + Object.values(o).join('|')
export const entry = () => ks({ a: 1, get g() { return 7 } }) + ' ' + ks({ b: 2 })`],
]))

test('literal accessors: definition order, index keys first', () => agree([
  ['setter first', `export const entry = () => JSON.stringify(Object.keys({ set x(v) {}, a: 1, get x() { return 2 } }))`],
  ['index key', `export const entry = () => JSON.stringify(Object.keys({ b: 1, get 2() { return 5 }, a: 3 }))`],
  // a later definition replaces an earlier one in place
  ['data replaces a getter', `export const entry = () => { const o = { get x() { return 1 }, y: 2, x: 3 }; return JSON.stringify([Object.keys(o), Object.values(o)]) }`],
  ['a setter replaces data', `export const entry = () => { const o = { x: 3, set x(v) {} }; return JSON.stringify([Object.keys(o), Object.values(o)]) }`],
]))

test('literal accessors: a getter runs where JS reads the property, once', () => agree([
  ['in order', `export const entry = () => { let log = ''; const o = { get p() { log += 'p'; return 1 }, q: 2, get r() { log += 'r'; return 3 } }; const v = Object.values(o); return log + JSON.stringify(v) }`],
  ['with this', `export const entry = () => JSON.stringify(Object.entries({ a: 4, get dbl() { return this.a * 2 } }))`],
  // spread copied the getter itself, which then ran on every later read
  ['spread copies the value', `export const entry = () => { let c = 0; const src = { get g() { c++; return 7 } }; const o = { ...src }; const v1 = o.g, v2 = o.g; return [c, v1, v2, Object.keys(o).join()].join() }`],
  ['an unused spread still reads', `export const entry = () => { let c = 0; const src = { get g() { c++; return 1 } }; const o = { ...src }; return c }`],
  ['spread of an unknown layout', `const mk = (k) => k ? { a: 1, get g() { return 7 } } : { b: 2 }
export const entry = (k) => { const o = { ...mk(k) }; return JSON.stringify([o, Object.keys(o)]) }`, [1]],
  ['keys and in run no getter', `export const entry = () => { let c = 0; const o = { get g() { c++; return 1 } }; const k = Object.keys(o); return [c, 'g' in o, c].join() }`],
  ['a clone keeps the cycle', `export const entry = () => { const o = { a: 1, get self() { return o } }; const c = structuredClone(o); return [c.self === c, c.a, Object.keys(c).join()].join() }`],
  ['a clone is deep', `export const entry = () => { const o = { a: 1, get g() { return { deep: [1, 2] } } }; const c = structuredClone(o); c.g.deep.push(3); return JSON.stringify([c, o.g]) }`],
]))

test('literal accessors: Object.assign stores through a setter and reads a getter once', () => agree([
  // the setter was replaced by data, or a data slot stored beside it
  ['a literal target', `export const entry = () => { let log = 0; const r = Object.assign({ set x(v) { log = v } }, { x: 5 }); return JSON.stringify([log, Object.keys(r), String(r.x)]) }`],
  ['a bound target', `export const entry = () => { let log = 0; const t = { a: 1, set x(v) { log = v } }; Object.assign(t, { x: 5, y: 6 }); return JSON.stringify([log, Object.keys(t), String(t.x), t.y]) }`],
  ['a pair', `export const entry = () => { let v = 1; const t = { get x() { return v }, set x(n) { v = n * 2 } }; Object.assign(t, { x: 5 }); return t.x }`],
  // the target took the getter itself, which then ran at each read
  ['a getter into a binding', `export const entry = () => { let n = 0; const t = { a: 0 }; Object.assign(t, { get g() { n++; return 7 } }); return JSON.stringify([t.g, t.g, n, Object.keys(t)]) }`],
  ['a setter alone copies undefined', `export const entry = () => { const t = { a: 0 }; Object.assign(t, { set s(v) {} }); return JSON.stringify([Object.keys(t), 's' in t, String(t.s)]) }`],
]))

// A getter or setter is a call: a typed element load cached before it read
// the value from before its store (load CSE, analyze/frame-effects.js runsAccessor).
test('literal accessors: a load after one reads what it stored', () => {
  const O = `{ buf: buf, get g() { this.buf[0] = 9; return 1 }, set s(v) { this.buf[0] = v } }`
  const inBody = (between) => `const g = (buf, o, k) => { const a = buf[0]; ${between}; const b = buf[0]; return a * 100 + b }
export const entry = (k) => { const buf = new Float64Array(2); buf[0] = 1; const o = ${O}; return g(buf, o, k) }`
  const acrossCall = (h) => `const h = ${h}
const g = (buf, o, k) => { const a = buf[0]; const v = h(o, k); const b = buf[0]; return a * 100 + b }
export const entry = (k) => { const buf = new Float64Array(2); buf[0] = 1; const o = ${O}; return g(buf, o, k) }`
  agree([
    ['a member read', inBody('const v = o.g'), ['g']], ['a member store', inBody('o.s = 7'), ['g']],
    ['a computed read', inBody('const v = o[k]'), ['g']], ['a computed store', inBody('o[k] = 7'), ['s']],
    ['a spread', inBody('const v = { ...o }'), ['g']],
    ['across a call', acrossCall('(o, k) => o[k]'), ['g']], ['across a member read', acrossCall('(o, k) => o.g'), ['g']],
    ['across a spread', acrossCall('(o, k) => ({ ...o }).g'), ['g']], ['across a store', acrossCall('(o, k) => { o.s = 7; return 0 }'), ['g']],
  ])
})

test('literal accessors: a computed key reaches them', () => agree([
  // `o[k]` read undefined and `o[k] = v` stored beside the setter
  ['read', `export const entry = (k) => { const o = { a: 1, get g() { return 7 } }; return String(o[k]) }`, ['g']],
  ['read in a loop', `export const entry = () => { const o = { a: 1, get g() { return 7 } }; return ['a', 'g'].map(k => o[k]).join() }`],
  ['store', `export const entry = (k) => { const o = { a: 1, set s(v) { this.a = v } }; o[k] = 5; return o.a }`, ['s']],
  ['in', `export const entry = (k) => { const o = { a: 1, get g() { return 7 } }; return [k in o, 'a' in o, (k + 'x') in o, 'g' in o].join() }`, ['g']],
  // the slots that carry an accessor list no names of their own
  ['no slot names', `export const entry = (k) => { const o = { a: 1, get g() { return 7 } }; return JSON.stringify([Object.getOwnPropertyNames(o), Object.entries(o), k in o]) }`, ['g']],
]))

test('literal accessors: an object returned to the host lists them by name, read once', () => {
  // the host decoded the slots: `g__get` holding the getter, no `g` (interop.js through __view_data)
  const host = (r) => JSON.stringify([Object.keys(r), Object.values(r)])
  for (const [name, src, args = []] of [
    ['a getter', `export const entry = () => ({ a: 1, get g() { return 7 } })`],
    ['nested', `export const entry = () => ({ inner: { get g() { return 7 } } })`],
    ['with this', `export const entry = (n) => ({ n, get dbl() { return this.n * 2 } })`, [4]],
    ['a setter alone', `export const entry = () => ({ a: 1, set s(v) {} })`],
    ['in an array', `export const entry = () => [{ get g() { return 1 } }, { get g() { return 2 } }]`],
  ]) for (const optimize of levels(0, 2, 3))
    is(host(jz(src, { optimize }).exports.entry(...args)), host(oracle(src).entry(...args)), `${name} O${optimize}`)
})

test('JSON.stringify calls toJSON with the key', () => agree([
  ['class', `class P { toJSON() { return { v: 1 } } }
export const entry = () => JSON.stringify(new P())`],
  ['nested and in arrays', `class P { toJSON(k) { return 'k=' + k } }
export const entry = () => JSON.stringify({ a: new P(), list: [new P(), new P()] }) + JSON.stringify(new P())`],
  ['with fields', `class P { constructor(x) { this.x = x } toJSON() { return { double: this.x * 2 } } }
export const entry = () => JSON.stringify([new P(1), new P(5)])`],
  ['undefined omits the key', `class P { toJSON() { return undefined } }
export const entry = () => JSON.stringify({ a: 1, b: new P(), c: [new P()] }) + '|' + String(JSON.stringify(new P()))`],
  ['inherited', `class A { toJSON() { return 'A' } } class B extends A { }
export const entry = () => JSON.stringify([new A(), new B()])`],
  ['overridden', `class A { toJSON() { return 'A' } } class B extends A { toJSON() { return 'B' } }
export const entry = () => JSON.stringify([new A(), new B()])`],
  // was rejected at compile time
  ['a literal\'s own', `export const entry = () => JSON.stringify({ a: 1, toJSON() { return 'lit' } })`],
  ['a literal\'s own, keyed', `export const entry = () => JSON.stringify({ outer: { toJSON(k) { return k.toUpperCase() } } })`],
  ['with this', `export const entry = () => { const o = { n: 3, toJSON() { return this.n + 1 } }; return JSON.stringify([o, { o }]) }`],
  ['not a function', `export const entry = () => JSON.stringify({ toJSON: 5, a: 1 })`],
  ['through a getter', `export const entry = () => JSON.stringify({ get g() { return { toJSON() { return 'g!' } } } })`],
  ['a Date', `export const entry = () => JSON.stringify({ d: new Date(0) })`],
]))

test('literal accessors: delete through a computed key removes them', () => agree([
  // returned false and kept the accessor; a static read then called its cleared slot
  ['delete', `export const entry = (k) => { const o = { a: 1, get g() { return 7 } }; const r = delete o[k]; return JSON.stringify([r, Object.keys(o), k in o, String(o[k])]) }`, ['g']],
  ['a getter and setter', `export const entry = (k) => { const o = { a: 1, get g() { return 7 }, set g(v) {} }; delete o[k]; return JSON.stringify([Object.keys(o), Object.values(o), JSON.stringify(o)]) }`, ['g']],
  ['a static read after', `export const entry = (k) => { const o = { a: 1, get g() { return 7 } }; delete o[k]; return String(o.g) }`, ['g']],
  ['a store re-adds data', `export const entry = (k) => { const o = { a: 1, get g() { return 7 } }; delete o[k]; o[k] = 5; return JSON.stringify([Object.keys(o), o[k], o.g, JSON.stringify(o)]) }`, ['g']],
  ['a static store after', `export const entry = (k) => { let seen = 0; const o = { a: 1, set s(v) { seen = v } }; delete o[k]; o.s = 5; return JSON.stringify([seen, o.s, Object.keys(o)]) }`, ['s']],
  ['another key leaves them', `export const entry = (k) => { const o = { a: 1, get g() { return 7 } }; delete o[k]; return JSON.stringify([Object.keys(o), o.g * 2]) }`, ['a']],
]))

// Views run only where code the program lowers builds such a literal
// (module/schema.js viewsOn), and toJSON only where it names JSON: an accessor in
// a function nothing calls put the view row beside every enumerated key, and a
// class's toJSON was lowered for a walker that never runs.
test('literal accessors and toJSON cost nothing where no code reaches them', () => {
  const src = (expr, tail = '') => `const pick = (k) => k ? { a: 1 } : { b: 2 }
class P { constructor(x) { this.x = x } get() { return this.x } toJSON() { return { v: this.x } } }
export const entry = (k) => { const o = pick(k); let s = ''; for (const key in o) s += key + o[key]; return s + new P(k).get()${expr} }
${tail}`
  const wat = (s) => compile(s, { wat: true, optimize: 0 })
  const lowersToJSON = (s) => /\(func \$\S*toJSON\b/.test(wat(s))
  const dead = src('', 'const unused = () => ({ get g() { return 7 } })')
  ok(!wat(dead).includes('__schema_view'), 'an unreached accessor literal reads no view')
  ok(wat(src(' + (k > 5 ? ({ get g() { return 7 } }).g : 0)')).includes('__schema_view'), 'a reached one does')
  ok(!lowersToJSON(dead), 'a program that never names JSON lowers no toJSON')
  ok(lowersToJSON(src(' + JSON.stringify(new P(k))')), 'one that stringifies does')
  agree([['reached', src(' + (k > 5 ? ({ get g() { return 7 } }).g : 0) + JSON.stringify(new P(k))'), [7]]])
})

// a shorthand property beside a method that reads `this` was rejected (jzify/classes.js lowerObjectLiteralThis)
test('a literal\'s method reads this beside a shorthand property', () => agree([
  ['method', `export const entry = (n) => ({ n, m() { return this.n * 2 } }).m()`, [4]],
  ['getter', `export const entry = (n) => ({ n, get dbl() { return this.n * 2 } }).dbl`, [4]],
]))

// a class kept as closures (declared in a function, or an expression with
// statics) puts its members on each instance as slots; each builtin listed
// `m` and `g__get`, and a copy carried them (module/schema.js hides them)
const inFn = `const make = (v) => { class C { constructor(x) { this.x = x; this.y = 2 } m() { return this.x } get g() { return this.x * 2 } set g(v) { this.x = v } } return new C(v) }`
const expr = `const C = class { static z = 1; constructor(x) { this.x = x } m() { return this.x } }; const make = (v) => new C(v)`
const members = (cls, op) => `${cls}\nexport const entry = () => { const o = make(3); return JSON.stringify(${op}) }`
test('closure-lowered class members are not own properties', () => agree([
  ['keys', members(inFn, 'Object.keys(o)')],
  ['values', members(inFn, 'Object.values(o)')],
  ['entries', members(inFn, 'Object.entries(o)')],
  ['for-in', members(inFn, '(() => { const r = []; for (const k in o) r.push(k); return r })()')],
  ['spread', members(inFn, '[Object.keys({ ...o }), typeof { ...o }.m]')],
  ['assign', members(inFn, 'Object.keys(Object.assign({}, o))')],
  ['calls', members(inFn, "[o.m(), typeof o.m, 'm' in o, 'g' in o, o.g, (o.g = 5, o.x)]")],
  ['expression', members(expr, "[Object.keys(o), o.m(), 'm' in o]")],
]))

test('property copies snapshot keys and recheck presence before each getter', () => {
  for (const operation of ['Object.assign({},source)', '({...source})', '({...source,tail:3})', 'Object.values(source)', 'Object.entries(source)', 'structuredClone(source)']) {
    const src=`export function f(mode){let log='';const source={
      get a(){log+='a';
        if(mode===1)delete source['b'];
        if(mode===2){delete source['b'];source.b=17}
        if(mode===3){source.b=undefined;source.added=23}
        if(mode===4){delete source['c'];source.c=19}
        if(mode===5){source.b=21;throw new RangeError('getter')}
        if(mode===6)delete source['a'];
        return 7},
      b:9,get c(){log+='c';return 11},u:undefined};
      try{const out=${operation};return [out,Object.keys(out),log]}
      catch(e){return [e.name,e.message,log]}}
      export function empty(){const source={};return ${operation}}`
    for(const optimize of levels(0,1,2,3,'size')){
      const got=jz(src,{optimize,sourceInline:false}).exports,want=oracle(src)
      is(got.empty(),want.empty(),`${operation} empty O${optimize}`)
      const kept=got.f(0),expected=want.f(0)
      for(const mode of [0,0,1,2,3,4,5,0,6,1,0])
        is(got.f(mode),want.f(mode),`${operation}, mode=${mode}, O${optimize}`)
      is(kept,expected,`${operation} retained prior copy O${optimize}`)
    }
  }
})

test('property copies keep snapshot order across dynamic table growth and reinsertion', () => {
  for(const operation of ['Object.assign({},source)','({...source})','Object.values(source)','Object.entries(source)']){
    const src=`export function f(mode){let log='';const source={get a(){log+='a';
      if(mode===1)delete source['later'];
      if(mode===2){delete source['later'];source.later=17}
      if(mode===3)for(let i=0;i<40;i++)source['new'+i]=i;
      source.last=23;return 7}};
      source.later=9;source.last=11;const out=${operation};return[out,Object.keys(out),log]}`
    for(const optimize of levels(0,1,2,3,'size')){
      const got=jz(src,{optimize,sourceInline:false}).exports.f,want=oracle(src).f
      for(const mode of [0,0,1,2,3,0])is(got(mode),want(mode),`${operation}, sidecar mode=${mode}, O${optimize}`)
    }
  }
})

test('Object.assign reads indexed sources after each target setter', () => {
  for(const constructor of ['[7,9,11]','new Int32Array([7,9,11])','new BigInt64Array([7n,9n,11n])']){
    const src=`export function f(mode){let log='';const source=${constructor};
      const target={set 0(v){log+='s';if(mode===1)source[1]=source[2];if(mode===2)delete source[1]},end:0};
      const out=Object.assign(target,source);return[out[1],out[2],Object.hasOwn(out,'1'),log]}`
    for(const optimize of levels(0,1,2,3,'size')){
      const got=jz(src,{optimize,sourceInline:false}).exports.f,want=oracle(src).f
      for(const mode of [0,0,1,0])is(got(mode),want(mode),`${constructor}, mode=${mode}, O${optimize}`)
      if(constructor[0]==='[')is(got(2),want(2),`deleted index O${optimize}`)
    }
  }
})

test('property copies preserve initial reinsertion order, Symbols, and nested clone effects', () => {
  for(const operation of ['Object.assign({},source)','({...source})','Object.values(source)','Object.entries(source)']){
    const src=`export function f(mode){let log='';const key=Symbol.for('copy');const source={
      get a(){log+='a';if(mode===1)delete source[key];if(mode===2){delete source['b'];source.b=17};return 7},
      b:9,get c(){log+='c';return 11}};
      delete source['b'];source.b=13;source[key]=19;
      const keys=Object.keys(source),before=log;const out=${operation};
      return[out,Object.keys(out),out[key],Object.hasOwn(out,key),keys,before,log]}`
    for(const optimize of levels(0,1,2,3,'size')){
      const got=jz(src,{optimize,sourceInline:false}).exports.f,want=oracle(src).f
      for(const mode of [0,0,1,2,0])is(got(mode),want(mode),`${operation}, initial reinsert mode=${mode}, O${optimize}`)
    }
  }
  const src=`export function f(mode){let log='';const source={get a(){log+='a';
    delete source['b'];source.b=17;if(mode)throw new RangeError('nested');return 7},b:9};
    const holder={items:[source]};holder.self=holder;
    try{const out=structuredClone(holder);return[out.items,Object.keys(out.items[0]),out.self===out,log]}
    catch(e){return[e.name,e.message,log]}}`
  for(const optimize of levels(0,1,2,3,'size')){
    const got=jz(src,{optimize,sourceInline:false}).exports.f,want=oracle(src).f
    for(const mode of [0,0,1,0])is(got(mode),want(mode),`nested clone mode=${mode}, O${optimize}`)
  }
})


test('property copies never parse Symbol identity payloads as index strings', () => {
  if(onKernel())return
  const a=ptrBits(PTR.ATOM,18,0xf0000010),b=ptrBits(PTR.ATOM,16384,0x10)
  for(const constructor of ['[]','new Int32Array(0)']){
    const src=`export function f(a,b){const source=${constructor};source[a]=7;source[b]=9;
      const out=Object.assign({},source),spread={...source};
      return[out[a],out[b],spread[a],spread[b],Object.keys(out),Object.hasOwn(out,a)]}`
    for(const optimize of levels(0,1,2,3,'size')){
      const mod=jz(src,{optimize,sourceInline:false})
      for(const pair of [[a,b],[a,b],[b,a],[a,b]])
        is(mod.memory.read(mod.instance.exports.f(...pair)),[7,9,7,9,[],true],`${constructor}, raw keys O${optimize}`)
    }
  }
})

test('property copies skip a deleted own key matching a prototype name', () => {
  for(const operation of ['Object.assign({},source)','({...source})','Object.values(source)','Object.entries(source)']){
    const src=`export function f(mode){let log='';const source={get a(){log+='a';if(mode)delete source['toString'];return 7},toString:9};
      const out=${operation};return[out,Object.keys(out),log]}`
    for(const optimize of levels(0,1,2,3,'size')){
      const got=jz(src,{optimize,sourceInline:false}).exports.f,want=oracle(src).f
      for(const mode of [0,0,1,0])is(got(mode),want(mode),`${operation}, prototype name mode=${mode}, O${optimize}`)
    }
  }
})

test('property copies reach nested dynamically named getters', () => {
  for(const constructor of ['{}',"Object.fromEntries([['seed',0]])"]){
    const src=`export function f(k,fail){k=String(k);let log='';const source={y:9},outer=${constructor};
      outer[k]={get x(){log+='x';delete source['y'];source.y=17;if(fail)throw new RangeError('nested');return 7}};
      try{const out=structuredClone(outer);return[out[k],source.y,Object.hasOwn(source,'y'),log]}
      catch(e){return[e.name,source.y,Object.hasOwn(source,'y'),log]}}`
    for(const optimize of levels(0,1,2,3,'size')){
      const got=jz(src,{optimize,sourceInline:false}).exports.f,want=oracle(src).f
      for(const args of [['a',false],['a',false],['b',false],['b',true],['a',false]])
        is(got(...args),want(...args),`${constructor}, key=${args[0]}, fail=${args[1]}, O${optimize}`)
    }
  }
})


test('property copies recheck host descriptors without reading skipped getters', () => {
  if(onWasi() || onKernel())return
  const symbol=Symbol.for('copy-presence-host'),referenced={kept:29},array=[37]
  const callable=new Proxy(function(){return 31},{get(fn,key,receiver){
    if(key==='name'||key==='length')throw new Error('copied callable metadata')
    return Reflect.get(fn,key,receiver)}})
  const fixture=mode=>{
    const log=[]
    const source={get a(){log.push('getter:a');
      if(mode===1)delete source.toString
      if(mode===2)Object.defineProperty(source,'b',{enumerable:false})
      if(mode===3)Object.defineProperty(source,'hidden',{enumerable:true})
      if(mode===4)delete source[symbol]
      if(mode===5)throw new RangeError('getter')
      source.added=23
      return 7},toString:9,get b(){log.push('getter:b');return 11}}
    Object.defineProperty(source,'hidden',{value:17,enumerable:false,configurable:true})
    source[symbol]=19;source.fn=callable;source.ref=referenced;source.array=array
    const proxy=new Proxy(source,{
      ownKeys(obj){log.push('keys');return Reflect.ownKeys(obj)},
      getOwnPropertyDescriptor(obj,key){log.push('descriptor:'+String(key));
        if(mode===6 && key==='b')throw new TypeError('descriptor')
        return Object.getOwnPropertyDescriptor(obj,key)},
      get(obj,key,receiver){if(Object.hasOwn(obj,key))log.push('read:'+String(key));return Reflect.get(obj,key,receiver)}
    })
    return {proxy,log}
  }
  for(const operation of ['Object.assign({},load())','({...load()})']){
    const src=`import {load} from 'host';export function f(){try{return ${operation}}catch(e){return[e.name,e.message]}}`
    for(const optimize of levels(0,1,2,3,'size')){
      let current
      const got=jz(src,{optimize,sourceInline:false,imports:{host:{load:()=>current}}}).exports.f
      for(const mode of [0,0,1,2,3,4,5,6,0]){
        const actual=fixture(mode),expected=fixture(mode);current=actual.proxy
        let want
        try{want=operation.startsWith('Object')?Object.assign({},expected.proxy):{...expected.proxy}}
        catch(e){want=[e.name,e.message]}
        const result=got()
        is(result,want,`${operation}, host mode=${mode}, O${optimize}`)
        if(mode!==5 && mode!==6)ok(result.fn===callable && result.ref===referenced && result.array===array,'copies retain exact callable/object/array identities')
        is(actual.log,expected.log,`${operation}, descriptor/get order mode=${mode}, O${optimize}`)
      }
    }
  }
})
