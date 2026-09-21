// The program summary (src/summary): one kind per binding, slot and result,
// joined over the whole program before per-function analysis. The tests read
// the summary after a compile and pin what it answers, then the codegen it
// unlocks: a record with a typed-array field read through a parameter, a
// factory result, a class instance, a method closure over the instance.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile, _compileInProcess } from '../index.js'
import { ctx } from '../src/ctx.js'
import { K, kind, join, orNull, tagOf, paramOf, isNullable, hasTag, UNKNOWN } from '../src/summary/index.js'
import { T as MARK } from '../src/ast.js'
import { onKernel, OPT_LEVEL, levels } from './_matrix.js'
import { oracle } from './util.js'

// Bindings carry prepare's scope suffix; find one by function and bare name.
const binding = (fn, bare) => {
  const f = ctx.funcs.list.find(f => f.name === fn)
  const names = new Set(f.sig.params.map(p => p.name))
  const walk = (n) => { if (typeof n === 'string') names.add(n); else if (Array.isArray(n)) n.forEach(walk) }
  walk(f.body)
  for (const n of names) if (n.startsWith(bare + MARK)) return n
  throw new Error(`no binding ${bare} in ${fn}`)
}
const kindOf = (fn, bare) => ctx.summary.at(fn).kindOf(binding(fn, bare))
const sidOf = (props) => ctx.schema.list.findIndex(s => s.join() === props.join())
// The summary read after a compile is of the program the plan rewrote; these tests
// pin the source's own functions, so the inliner is off (the speed tier splices callees)
// and so is the record-parameter lane pass (it replaces a field-reading callee).
const summarize = (src) => { _compileInProcess(src, { optimize: { level: OPT_LEVEL, sourceInline: false, inlineFns: false, laneRecords: false } }); return ctx.summary }

test('summary: testing data fields does not lose the argument shape at an open join', () => {
  for (const condition of ['!!x?.enabled', "x?.name === 'f'", "typeof x?.nested === 'object'", 'x?.nested?.enabled === true']) {
    const src = `function predicate(x) { return ${condition} }
      function test(x) { return predicate(x) }
      export function f(other, key) {
        const cfg = { enabled: true, name: 'f', nested: { enabled: true, value: 7 } }
        other[key] = false
        test(other)
        test(cfg)
        return cfg.nested.value
      }`
    const summary = summarize(src)
    const sid = sidOf(['enabled', 'name', 'nested'])
    is(tagOf(summary.fieldKind(sid, 'nested')), K.OBJECT, condition + ': unrelated nested shape survives')
    is(tagOf(summary.fieldKind(sidOf(['enabled', 'value']), 'value')), K.NUMBER, condition + ': nested value stays numeric')
  }
})

test('summary: unused field values do not merge unrelated collection contents', () => {
  for (const access of ['options.locals', "options['locals']"]) {
    const src = `function read(ctx) { return ctx.value }
      function enabled(options) { return !!${access} }
      export function f(flag) {
        const table = { locals: new Map() }, options = { locals: false }
        table.locals.set('read', read)
        enabled(flag ? table : options)
        const context = { value: 7 }
        return read(context)
      }`
    const summary = summarize(src)
    is(summary.resultOf('read'), kind(K.NUMBER), access + ': testing the Map must not open its callable values')
    const f = jz(src).exports.f
    for (const flag of [0, 1, 1, 0]) is(f(flag), 7, access)
  }
})

test('summary: forwarding through defaults and spreads preserves writes through aliases', () => {
  for (const wrapper of [
    'function update(x, alias = x) { alias.value = "changed"; return !!x.value }',
    'function write(alias) { alias.value = "changed" } function update(x) { return write(...[x]) }',
    'function write(alias) { alias.value = "changed" } function update(x, n = 1) { if (n) return update(x, n - 1); write(x); return !!x.value }',
  ]) {
    const src = `${wrapper} export function f() {
      const cfg = { value: 7 }
      update({ value: false }); update(cfg)
      return cfg.value
    }`
    for (const optimize of levels(0, 1, 2, 3)) {
      const f = jz(src, { optimize }).exports.f
      for (let i = 0; i < 2; i++) is(f(), 'changed', `O${optimize}: ${wrapper}`)
    }
  }
})

test('summary: field predicates retain getter effects and escaping or reassigned receivers', () => {
  const cases = [
    `const state = { value: 7 }; function receiver() { state.value = 'receiver'; return { enabled: false } }
     export function f() { if (receiver().enabled) return 'wrong'; return state.value }`,
    `function test(x) { return !!x?.enabled }
     export function f() {
       const cfg = { nested: { value: 7 }, get enabled() { this.nested.value = 'getter'; return true } }
       test({ enabled: false }); test(cfg)
       return cfg.nested.value
     }`,
    `class Box {
       constructor() { this.nested = { value: 7 } }
       get enabled() { this.nested.value = 'class getter'; return true }
     }
     function test(x) { return !!x?.enabled }
     export function f() { const cfg = new Box(); test({ enabled: false }); test(cfg); return cfg.nested.value }`,
    `function read(x) { return x.nested }
     export function f() { const cfg = { nested: { value: 7 } }; const alias = read(cfg); alias.value = 'alias'; return cfg.nested.value }`,
    `function test(x, other) { x = other; return !!x?.enabled }
     export function f() { return test({ enabled: true }, { enabled: false }) }`,
    `function test(x) { x.enabled = 'written'; return !!x.enabled }
     export function f() { const cfg = { enabled: true }; test(cfg); return cfg.enabled }`,
  ]
  for (const src of cases) for (const optimize of levels(0, 1, 2, 3)) {
    const f = jz(src, { optimize }).exports.f, js = oracle(src).f
    for (let i = 0; i < 2; i++) is(f(), js(), `O${optimize}: ${src}`)
  }
})

test('summary: imported constant initializers are folded before analysis', () => {
  const source = `import { PI, EPSILON } from 'constants'; export const probe = x => x * PI + EPSILON`
  const modules = { constants: 'export const PI = Math.PI, EPSILON = Number.EPSILON' }
  _compileInProcess(source, { modules })
  const view = ctx.summary.at('')
  is(tagOf(view.kindOf('constants$PI')), K.NUMBER)
  is(tagOf(view.kindOf('constants$EPSILON')), K.NUMBER)
  is(jz(source, { modules }).exports.probe(2), 2 * Math.PI + Number.EPSILON)
})

test('summary: kinds flow through calls, fields and results; the host boundary is ANY', () => {
  summarize(`const mk = (n, g) => ({ buf: new Float32Array(n), gain: g })
    const proc = (o) => { const b = o.buf, k = o.gain; return b[0] * k }
    export const run = (n) => { const o = mk(n, 0.5); return proc(o) + proc({ buf: new Float32Array(2), gain: 1 }) }`)
  const sid = sidOf(['buf', 'gain'])
  is(tagOf(kindOf('proc', 'o')), K.OBJECT, 'a parameter takes the join of its arguments'); is(paramOf(kindOf('proc', 'o')), sid)
  is(tagOf(kindOf('proc', 'b')), K.TYPED, 'a field read has the slot kind'); ok(!isNullable(kindOf('proc', 'b')))
  is(ctx.summary.fieldTypedCtor(sid, 'buf'), 'new.Float32Array')
  is(tagOf(kindOf('proc', 'k')), K.NUMBER, 'number literal and number parameter join to number')
  is(tagOf(kindOf('run', 'n')), K.ANY, 'an exported parameter read only as a typed-array size stays ANY: the constructor copies an array')
  ok(!ctx.summary.at('run').numericDemand(binding('run', 'n')))
  is(tagOf(ctx.summary.resultOf('mk')), K.OBJECT, 'a result is the join of its returns')
  summarize(`export const h = (s, k, o, p, q) => { const t = s + ''; return t.length + k * 2 + o.x + (p + 1) + (q < 3 ? 1 : 0) }`)
  is(tagOf(kindOf('h', 's')), K.ANY, 'a parameter concatenated with a string comes from the host as ANY')
  is(tagOf(kindOf('h', 'k')), K.NUMBER, 'a parameter multiplied is demanded'); ok(ctx.summary.at('h').numericDemand(binding('h', 'k')))
  is(tagOf(kindOf('h', 'o')), K.ANY, 'a parameter read as an object is not')
  is(tagOf(kindOf('h', 'p')), K.NUMBER, 'a parameter added to a number is compatible'); ok(!ctx.summary.at('h').numericDemand(binding('h', 'p')))
  is(tagOf(kindOf('h', 'q')), K.NUMBER, 'a parameter compared against a number is demanded'); ok(ctx.summary.at('h').numericDemand(binding('h', 'q')))
  // Demand follows a store into a slot and a destructured read out of it.
  summarize(`const mk = (g) => ({ gain: g })
    const use = (o) => { const { gain } = o; return gain * 2 }
    const use2 = ({ gain }) => gain + ''
    export const times = (g) => use(mk(g))
    export const text = (g) => use2(mk(g))`)
  is(tagOf(kindOf('times', 'g')), K.ANY, 'the slot is also read as a string elsewhere: not demanded')
  summarize(`const mk = (g) => ({ gain: g })
    const use = (o) => { const { gain } = o; return gain * 2 }
    export const times = (g) => use(mk(g))`)
  is(tagOf(kindOf('times', 'g')), K.NUMBER, 'stored into a slot every read of which multiplies: demanded')
  is(jz(`const mk = (g) => ({ gain: g })
    const use = (o) => { const { gain } = o; return gain * 2 }
    export const times = (g) => use(mk(g))`).exports.times('4'), 8, 'the host string converts at the boundary')
  // A demand is evidence of a ToNumber read, never its absence: a value the
  // program stores and never reads rests where the host reads it back.
  summarize(`export const mk = (x, y) => ({ x, y })`)
  is(tagOf(kindOf('mk', 'x')), K.ANY, 'a slot with no read demands nothing')
  is(jz(`function RegExp(x) { return { x } }
    export let regexp = x => new RegExp(x).x`).exports.regexp('r'), 'r', 'a slot returned as it is keeps the host value')
  summarize(`export const get = (a, k) => a[k]`)
  is(tagOf(kindOf('get', 'k')), K.ANY, 'an index is a property key, not a ToNumber context')
  is(jz(`export const get = (k) => { const a = [10, 20, 30]; return a[k] }`).exports.get('1.0'), undefined, "a['1.0'] is no element")
})

test('summary: result kinds keep payload, presence, typed elements, and resolved method producers separate', () => {
  summarize(`
    function sub(a, b) { return a - b }
    export function partial(c) { if (c) return 1n }
    export function reduced() { return new BigInt64Array([2n, 3n]).reduce((a, b) => a + b) }
    export function reducedIndex() { return new Float64Array([1, 2, 3]).reduce((a, b, i) => i) }
    export function reducedArray() { return new Float64Array([1, 2, 3]).reduce((a, b, i, value) => value.length) }
    export function optionalReduced(c) {
      let value = c ? new BigInt64Array([2n, 3n]) : null
      return value?.reduce((a, b) => a + b)
    }
    export function mixed(c) { return c ? sub(3n, 1n) : sub(3, 1) }
    export function checkedPairAdd(i) { let value = new BigInt64Array([7n]); return value[i] + value[i] }
    export function ownArrayMethod() { let value = []; value.includes = () => 7n; return value.includes() }
  `)
  const partial = ctx.summary.resultOf('partial')
  ok(hasTag(partial, K.BIGINT) && hasTag(partial, K.NULLISH), 'implicit fallthrough is presence, not a BigInt payload')
  const reduced = ctx.summary.resultOf('reduced')
  is(tagOf(reduced), K.BIGINT, 'typed reduce follows the callback recurrence and element kind')
  ok(!isNullable(reduced), 'direct reduce has no optional absence arm')
  is(tagOf(ctx.summary.resultOf('reducedIndex')), K.NUMBER, 'typed reduce supplies a numeric callback index')
  is(tagOf(ctx.summary.resultOf('reducedArray')), K.NUMBER, 'typed reduce supplies the typed-array callback receiver')
  const optional = ctx.summary.resultOf('optionalReduced')
  ok(hasTag(optional, K.BIGINT) && hasTag(optional, K.NULLISH), 'optional reduce keeps BigInt and absence')
  const value = binding('optionalReduced', 'value')
  is(ctx.summary.at('optionalReduced').typedCtorOfExpr(value), null, 'presence-sensitive typed query declines a nullable value')
  is(ctx.summary.at('optionalReduced').typedPayloadCtorOfExpr(value), 'new.BigInt64Array', 'payload query retains its typed constructor')
  const mixed = ctx.summary.resultOf('mixed')
  ok(hasTag(mixed, K.NUMBER) && hasTag(mixed, K.BIGINT), 'mixed call paths retain both numeric domains')
  const pair = ctx.summary.resultOf('checkedPairAdd')
  ok(hasTag(pair, K.NUMBER) && hasTag(pair, K.BIGINT), 'two absent-capable BigInt operands retain their Number completion')
  is(tagOf(ctx.summary.resultOf('ownArrayMethod')), K.ANY, 'an own array method is not classified by its builtin-looking name')
})

test('summary: join is a lattice join, so the fixpoint terminates', () => {
  // Every element and its nullable form; ANY absorbs the bit (the flagship
  // oscillated between ANY and nullable ANY for 64 rounds and stopped short).
  const base = [K.NONE, kind(K.NUMBER), kind(K.STRING), kind(K.NULLISH), kind(K.OBJECT, 1), kind(K.OBJECT, 2), kind(K.OBJECT, UNKNOWN), kind(K.ARRAY, 0), kind(K.CLOSURE, 3), kind(K.ANY)]
  const all = [...base, ...base.map(orNull)]
  for (const a of all) for (const b of all) {
    const j = join(a, b)
    is(join(b, a), j, 'commutative')
    is(join(a, j), j, 'absorbing: the join is above its operands')
    is(join(j, b), j)
    for (const c of all) is(join(join(a, b), c), join(a, join(b, c)), 'associative')
  }
  is(join(kind(K.ANY), kind(K.NULLISH)), kind(K.ANY), 'ANY absorbs nullish')
  is(join(orNull(K.NONE), kind(K.NUMBER)), orNull(kind(K.NUMBER)), 'nullable bottom joins as nullish')
  is(join(kind(K.OBJECT, 1), orNull(kind(K.OBJECT, 2))), orNull(kind(K.OBJECT, UNKNOWN)), 'two shapes join to the tag')
})

test('summary: two closures joined are a set; a call through the join calls each member', () => {
  // A dispatch table's members are called through the table: each binds the arguments.
  summarize(`const tbl = [(x) => x.length, (x) => x * 2]
    const T = { a: (s) => s.length, b: (s) => s + '!' }
    const g = (k) => T[k]('abc')
    export const f = (i, v) => tbl[i & 1](v) + g('a')`)
  for (const id of [0, 1, 2, 3]) ok(!ctx.summary.escaped.has(id), `closure ${id} is called through the table, not escaped`)
  is(tagOf(ctx.summary.resultOf('g')), K.ANY, 'a computed key on a known shape reads one of its slots: the call is the join of the members\' results (a number, a string), and may miss')
  is(jz(`const T = { a: (s) => s.length, b: (s) => s + '!' }
    export const g = (k) => T[k]('abc')`).exports.g('b'), 'abc!')
  is(jz(`const tbl = [(x) => x.length, (x) => x * 2]
    export const f = (i, v) => tbl[i & 1](v)`).exports.f(0, 'abc'), 3)
})

test('summary: dynamic literals analyze callbacks after spreads and computed keys', () => {
  for (const first of ['...base', '[key]: 1']) {
    const src = `const base = {}; const key = 'x'
      const table = { ${first}, f(ctor) {
        let name = ctor
        while (Array.isArray(name) && name[0] === '()' && name.length === 2) name = name[1]
        if (name === 'ok') name = 'yes'
        return JSON.stringify(name)
      } }
      export const probe = () => table.f(['()', 'ok'])`
    const expected = oracle(src).probe()
    for (const optimize of levels(0, 2, 3))
      is(jz(src, { optimize }).exports.probe(), expected, `${first}, O${optimize}`)
  }
})

test('summary: stores join into the slot; a differing store or a computed write poisons it', () => {
  summarize(`const mk = () => ({ a: new Float32Array(4), b: new Float32Array(4), c: 1 })
    export const f = (k) => { const o = mk(); o.a = new Float32Array(8); o.b = new Float64Array(8); o[k] = 2; return o.a[0] + o.b[0] + o.c }`)
  const sid = sidOf(['a', 'b', 'c'])
  is(ctx.summary.fieldTypedCtor(sid, 'a'), null, 'a computed-key write poisons every slot of the schema')
  summarize(`const mk = () => ({ a: new Float32Array(4), b: new Float32Array(4) })
    export const f = () => { const o = mk(); o.a = new Float32Array(8); o.b = new Float64Array(8); return o.a[0] + o.b[0] }`)
  const s2 = sidOf(['a', 'b'])
  is(ctx.summary.fieldTypedCtor(s2, 'a'), 'new.Float32Array', 'a store of the same kind keeps the slot typed')
  is(ctx.summary.fieldTypedCtor(s2, 'b'), null, 'a store of another element type does not')
  is(tagOf(ctx.summary.fieldKind(s2, 'b')), K.TYPED, 'still a typed array, of unknown element')
})

test('summary: internal aliases retain identity; unknown calls and Object.assign lose what they touch', () => {
  summarize(`const g = (o) => o.a
    const h = (o) => o.a
    const mk = () => ({ a: 1 })
    export const f = (arr) => { const o = mk(); const fn = g; Object.assign(o, { a: 'x' }); return fn(o) + h(o) + arr.map(h).length }`)
  is(tagOf(kindOf('f', 'o')), K.OBJECT, 'the local keeps its shape')
  is(ctx.summary.fieldVal(sidOf(['a']), 'a'), null, 'Object.assign may store any kind into the object')
  ok(!ctx.summary.escaped.has('g'), 'a local function alias stays internal')
  ok(ctx.summary.escaped.has('h'), 'an unknown receiver may retain its callback')
})

test('summary: definite initialization excludes the declared undefined; a later read of an unassigned field keeps it', () => {
  summarize(`const mk = (n) => { let self = { buf: undefined, tail: undefined }; self.buf = new Float32Array(n); return self }
    export const f = (n) => { const o = mk(n); o.tail = new Float32Array(1); return o.buf[0] + o.tail[0] }`)
  const sid = sidOf(['buf', 'tail'])
  is(ctx.summary.fieldTypedCtor(sid, 'buf'), 'new.Float32Array', 'assigned before the object is used')
  is(ctx.summary.fieldTypedCtor(sid, 'tail'), null, 'assigned only after the object escaped the factory: nullable')
  ok(isNullable(ctx.summary.fieldKind(sid, 'tail')))
})

test('summary: delete, a host import, for-of, a binding read before its assignment', () => {
  summarize(`const mk = () => ({ a: new Float32Array(2), b: 1 })
    export const f = (n, k) => { const o = mk(); delete o[k]; const t = new Float32Array(n); let s = 0; for (const x of t) s += x; for (const x of [1, 2]) s += x; return s + g(o) }
    const g = (o) => later(o.b) + later(3)
    const later = (v) => v * two
    const two = 2`)
  const sid = sidOf(['a', 'b'])
  is(ctx.summary.fieldTypedCtor(sid, 'a'), null, 'a computed-key delete may remove any slot')
  is(ctx.summary.fieldVal(sid, 'b'), null)
  is(tagOf(kindOf('f', 'x')), K.NUMBER, 'for-of over a typed array and a number array binds a number')
  // ECMAScript: a deleted property reads as undefined (a computed-key delete
  // may remove any slot), so the slot's number gains absence, not every kind.
  is(tagOf(kindOf('later', 'v')), K.NUMBER, 'the deleted-from slot reaches later as its number, joined with the literal')
  ok(isNullable(kindOf('later', 'v')), 'and as possibly absent, since the delete may have removed it')
  is(tagOf(kindOf('g', 'o')), K.OBJECT, 'a function declared after its caller binds through the fixpoint')
  is(tagOf(ctx.summary.resultOf('later')), K.NUMBER)
  _compileInProcess(`import { log } from 'host'\nconst mk = () => ({ a: new Float32Array(2) })\nexport const f = () => { const o = mk(); log(o); return o.a[0] }`,
    { imports: { host: { log: { params: 1 } } } })
  is(ctx.summary.fieldTypedCtor(sidOf(['a']), 'a'), 'new.Float32Array', 'an object passed to a host import keeps its field kinds (the boundary is a contract)')
})

test('summary: array cells join every store; two arrays joined share one cell', () => {
  summarize(`const mk = () => ({ v: 1 })
    const fill = (a, v) => { a[0] = v }
    export const f = (k) => { const arr = [mk()]; arr.push({ v: 2 }); const o = arr[0]; const two = k ? [1] : ['s']; const nums = [1]; const strs = ['a']; fill(nums, 2); fill(strs, 'b'); const n = nums[0]; return o.v + two.length + (k ? two[0] : n) }`)
  is(tagOf(kindOf('f', 'o')), K.OBJECT, 'a push of the same shape keeps the element shape'); ok(isNullable(kindOf('f', 'o')), 'an element read may be out of range')
  ok(paramOf(kindOf('f', 'two')) !== UNKNOWN, 'two arrays joined name one cell'); is(tagOf(ctx.summary.at('f').kindOfExpr(['[]', 'two', 0])), K.ANY, 'whose elements are the join')
  is(tagOf(kindOf('f', 'n')), K.ANY, 'a store through a parameter both arrays flow into reaches both')
  is(tagOf(join(kind(K.NUMBER), kind(K.BOOL))), K.ANY, 'two tags read as ANY through the one-tag API'); ok(hasTag(join(kind(K.NUMBER), kind(K.BOOL)), K.BOOL) && !hasTag(join(kind(K.NUMBER), kind(K.BOOL)), K.STRING), 'and keep their set')
})

// Every construction of an array owns a cell, like a literal: the constructors,
// `Array.of`, `Array.from`, a string's `split`, an array's `concat` and `splice`,
// `JSON.parse` of a string the program holds. A method that builds a fresh array
// leaves the receiver's cell alone; one that stores into the receiver joins the
// stored kinds; a length store extends with holes.
test('summary: array constructions own cells; concat, splice, split, JSON.parse and Array(n) holes', () => {
  const elemOf = (fn, bare) => ctx.summary.at(fn).elemKindOf(binding(fn, bare))
  summarize(`const S = '[3,4]'
    export const f = (k) => {
      const holes = Array(3); holes[0] = 1
      const empty = Array(); const pair = Array(1, 2); const one = Array('x')
      const of = Array.of(1, 2); const chars = Array.from('xy'); const copy = Array.from([1, 2]); const made = Array.from({ length: 2 }, (_, i) => i)
      const parts = 'x,y'.split(','); parts.unshift(1)
      const nums = [1, 2]; const both = nums.concat(['y'])
      const spliced = [1, 2]; const removed = spliced.splice(1, 0, 'y')
      const json = JSON.parse('[1,2]'); json.push('y')
      const rows = JSON.parse('[[1,2],[3]]'); const row = rows[0]
      const named = JSON.parse(S); const bools = JSON.parse('[true]')
      const grown = [1, 2]; grown.length = 4
      return [holes[k], empty[k], pair[k], one[k], of[k], chars[k], copy[k], made[k], parts[k], both[k], removed[k], json[k], row[k], named[k], bools[k], grown[k]]
    }`)
  is(tagOf(elemOf('f', 'holes')), K.NUMBER, 'Array(n) filled by index holds numbers'); ok(hasTag(elemOf('f', 'holes'), K.ABSENT), 'and holes: an unwritten slot reads undefined')
  is(tagOf(elemOf('f', 'empty')), K.NONE, 'Array() is empty')
  is(tagOf(elemOf('f', 'pair')), K.NUMBER, 'Array(a, b) holds its arguments'); ok(!hasTag(elemOf('f', 'pair'), K.ABSENT))
  is(tagOf(elemOf('f', 'one')), K.STRING, 'Array(x) of no number holds x')
  is(tagOf(elemOf('f', 'of')), K.NUMBER, 'Array.of holds its arguments')
  is(tagOf(elemOf('f', 'chars')), K.STRING, 'Array.from of a string holds its characters')
  is(tagOf(elemOf('f', 'copy')), K.NUMBER, 'Array.from of an array holds its elements')
  is(tagOf(elemOf('f', 'made')), K.NUMBER, 'Array.from with a callback holds what the callback makes')
  is(tagOf(elemOf('f', 'parts')), K.ANY, 'split holds strings; an unshift joins the number'); ok(hasTag(elemOf('f', 'parts'), K.STRING) && hasTag(elemOf('f', 'parts'), K.NUMBER))
  is(tagOf(elemOf('f', 'nums')), K.NUMBER, 'concat leaves the receiver alone')
  is(tagOf(elemOf('f', 'both')), K.ANY, 'and its result joins the arguments\' elements'); ok(hasTag(elemOf('f', 'both'), K.STRING))
  is(tagOf(elemOf('f', 'spliced')), K.ANY, 'splice stores its items into the receiver')
  is(tagOf(elemOf('f', 'removed')), K.ANY, 'and returns the receiver\'s elements')
  is(tagOf(elemOf('f', 'json')), K.ANY, 'a JSON array is a cell: the push joins'); ok(hasTag(elemOf('f', 'json'), K.NUMBER) && hasTag(elemOf('f', 'json'), K.STRING))
  is(tagOf(elemOf('f', 'row')), K.NUMBER, 'a nested JSON array has its own cell')
  is(tagOf(elemOf('f', 'named')), K.NUMBER, 'a module const string parses too')
  is(tagOf(elemOf('f', 'bools')), K.BOOL, 'a JSON boolean is a boolean')
  ok(hasTag(elemOf('f', 'grown'), K.ABSENT), 'a length store extends with holes')
  // `Array(x)` sizes by a number and holds anything else: the argument is no evidence for the demand pass.
  summarize(`export const f = (n) => { const a = Array(n); for (let i = 0; i < n; i++) a[i] = i; return a[0] }`)
  is(tagOf(kindOf('f', 'n')), K.NUMBER, 'a compared parameter that also sizes an array is demanded')
  is(tagOf(elemOf('f', 'a')), K.NUMBER, 'so Array(n) has holes, not an element of any kind'); ok(hasTag(elemOf('f', 'a'), K.ABSENT))
  summarize(`export const f = (n) => Array(n).length`)
  is(tagOf(kindOf('f', 'n')), K.ANY, 'a parameter read only there stays ANY: the host may pass an element')
  // A method that reads the receiver leaves its cell alone: a reduce binds its
  // callback, a copy owns a fresh cell; a spread reads its source's elements,
  // and a parameter from a spread argument on takes any element, a later
  // argument or nothing.
  summarize(`const g = (u, v) => v
    export const f = (k) => {
      const nums = [1, 2]; const sum = nums.reduce((p, x) => p + x, 0)
      const rev = nums.toReversed(); const srt = nums.toSorted((x, y) => x - y); const wth = nums.with(0, 's'); const flat = [[1], [2]].flat(); const spl = nums.toSpliced(0, 1, 's')
      const lit = [...nums, 9]; const pushed = []; pushed.push(...nums)
      const tagged = [1, 2]; Object.assign(tagged, { name: 's' }); const indexed = [1, 2]; Object.assign(indexed, { 0: 's' })
      const last = g(...nums)
      return [nums[k], rev[k], srt[k], wth[k], flat[k], spl[k], lit[k], pushed[k], tagged[k], indexed[k], sum + last]
    }`)
  is(tagOf(elemOf('f', 'nums')), K.NUMBER, 'reduce, the copies, the spreads and Object.assign leave the receiver\'s cell alone')
  is(tagOf(kindOf('f', 'sum')), K.NUMBER, 'reduce binds its callback and joins the accumulator')
  is(tagOf(elemOf('f', 'rev')), K.NUMBER, 'toReversed copies the elements'); is(tagOf(elemOf('f', 'srt')), K.NUMBER, 'toSorted too')
  is(tagOf(elemOf('f', 'wth')), K.ANY, 'with joins the value'); is(tagOf(elemOf('f', 'flat')), K.NUMBER, 'flat holds the elements\' elements'); is(tagOf(elemOf('f', 'spl')), K.ANY, 'toSpliced joins the items')
  is(tagOf(elemOf('f', 'lit')), K.NUMBER, 'a spread into a literal reads the source\'s elements'); is(tagOf(elemOf('f', 'pushed')), K.NUMBER, 'a spread push too')
  is(tagOf(elemOf('f', 'tagged')), K.NUMBER, 'Object.assign of a named property is no element'); is(tagOf(elemOf('f', 'indexed')), K.ANY, 'of an index-named one is')
  is(tagOf(kindOf('g', 'v')), K.NUMBER, 'a parameter after a spread argument takes the elements'); ok(hasTag(kindOf('g', 'v'), K.NULLISH), 'or nothing')
})

test('summary codegen: a typed field read through a parameter, a factory, a class, a method closure lowers to typed storage', () => {
  if (onKernel()) return
  const shapes = {
    param: `const proc = (o) => { const b = o.buf, g = o.gain; for (let i = 0; i < b.length; i++) b[i] = b[i] * g; return b[0] }
      export const run = (n) => { const o = { buf: new Float32Array(n), gain: 0.5 }; o.buf[0] = 2; proc(o); return proc(o) }`,
    factory: `const mk = (n, gain) => ({ buf: new Float32Array(n), gain })
      const proc = (o) => { const b = o.buf, g = o.gain; for (let i = 0; i < b.length; i++) b[i] = b[i] * g; return b[0] }
      export const run = (n) => { const o = mk(n, 0.5); o.buf[0] = 2; proc(o); return proc(o) }`,
    class: `export class Gain { constructor(n, gain) { this.buf = new Float32Array(n); this.gain = gain }
      process() { const b = this.buf, g = this.gain; for (let i = 0; i < b.length; i++) b[i] = b[i] * g; return b[0] } }
      export const run = (n) => { const g = new Gain(n, 0.5); g.buf[0] = 2; g.process(); return g.process() }`,
  }
  for (const [name, src] of Object.entries(shapes)) {
    const wat = compile(src, { wat: true, optimize: { level: 2, watr: false } })
    // The loop that stores into the buffer: raw f32 storage, no runtime dispatch on the element.
    const at = wat.indexOf('f32.store')
    ok(at > 0, `${name}: the loop stores f32`)
    const loop = wat.slice(wat.lastIndexOf('(loop', at), at)
    // The factory shape still versions its loop on the receiver's runtime kind: the
    // parameter's representation follows the summary in the next slice (PLAN.md step 3).
    if (name !== 'factory') ok(!/__typed_idx|__typed_set_idx|__dyn_get|__arr_typed/.test(loop), `${name}: no element dispatch in the loop`)
    is(jz(src).exports.run(64), 0.5, `${name}: 2 * 0.5 * 0.5`)
  }
})

test('summary codegen: a method called through an array of instances, an exported constructor parameter stored to a numeric slot', () => {
  if (onKernel()) return
  const src = `class Gain {
      constructor(n, gain) { this.buf = new Float64Array(n); this.gain = gain }
      process(input) { const b = this.buf, g = this.gain; for (let i = 0; i < b.length; i++) b[i] = input[i] * g; return b }
    }
    const mkChain = (n, count) => { const nodes = []; for (let k = 0; k < count; k++) nodes.push(new Gain(n, 0.5 + k)); return nodes }
    const render = (input, nodes) => { let x = input; for (let k = 0; k < nodes.length; k++) x = nodes[k].process(x); return x }
    export const run = (n) => { const input = new Float64Array(n); input[1] = 2; return render(input, mkChain(n, 3))[1] }`
  // level 2: below it the method's dispatcher, dead here, is not shaken
  if (OPT_LEVEL === 2) ok(!/__dyn_get|__hash|__to_str/.test(compile(src, { wat: true })), 'the method comes from the element\'s schema slot, the method parameter is a typed array')
  is(jz(src).exports.run(4), 2 * 0.5 * 1.5 * 2.5)
  // Nullish receiver checks retain the private error signal: 3060 → 3132 B.
  // A control build omitting only those checks restores 3060; keep the same slack.
  // Known-array reads and lengths take their forwarding hop inline in the
  // speed tiers (src/ir/pointers.js fwdOffsetIR): 3132 → 3184 B, two hops.
  // The `jz:brand` custom section names the class for interop: 3184 → 3235 B.
  if (OPT_LEVEL === 2) ok(compile(src).length < 3275, `the typed tier's size class (${compile(src).length} B)`)
  // An exported class: its constructor parameter is read only through a slot
  // every read of which multiplies, so the f64 boundary is the coercion.
  const cls = `export class Gain { constructor(n, gain) { this.buf = new Float32Array(n); this.gain = gain }
      process() { const b = this.buf, g = this.gain; for (let i = 0; i < b.length; i++) b[i] = b[i] * g; return b[0] } }
    export const run = (n, gain) => { const g = new Gain(n, gain); g.buf[0] = 2; g.process(); return g.process() }`
  if (OPT_LEVEL === 2) ok(!/__to_str/.test(compile(cls, { wat: true })), 'no string machinery: the gain slot is read only as a number')
  is(jz(cls).exports.run(8, 0.5), 0.5)
  is(jz(cls).exports.run(8, '0.5'), 0.5, 'the host string converts at the boundary')
  // The same required receiver check adds 72 B to the exported-class case.
  // The `jz:brand` custom section names the exported class for interop: 2072 → 2084 B.
  if (OPT_LEVEL === 2) ok(compile(cls).length < 2124, `bytes: ${compile(cls).length}`)
})

test('summary: a module global is the join of every store; the declaration\'s claim yields', () => {
  // The declaration says number, a function stores a string: `g + 1` concatenates as JS does.
  const m = jz(`let g = 1; export let f = () => { g = 'abc'; return g.length }; export let h = () => g + 1`)
  is(m.exports.h(), 2); is(m.exports.f(), 3); is(m.exports.h(), 'abc1')
  // A `let` assigned a typed array in an initializer is typed, nullable until then; a const
  // bound to a factory's record has its schema; an exported `let` keeps its kind.
  const src = `let mem, W = 0; const P = mk(4); export let n = 0
    const mk = (k) => ({ x: new Float32Array(k), y: k })
    export const init = (w) => { W = w; mem = new Float64Array(W * 2) }
    export const at = (i) => mem[i] + P.x[0] + P.y + n`
  _compileInProcess(src)
  is(ctx.scope.globalTypedElem.get('mem'), 'new.Float64Array'); ok(ctx.scope.globalReps.get('mem').nullable)
  is(ctx.scope.globalValTypes.get('W'), 'number', 'a host parameter every read of which converts is a number')
  is(ctx.schema.vars.get('P'), ctx.schema.list.findIndex(s => s.join() === 'x,y'))
  is(ctx.scope.globalValTypes.get('n'), 'number')
  const m2 = jz(src); m2.exports.init(3); is(m2.exports.at(0), 4)
})

test('summary: a numeric-compatible parameter arrives as a number (README.md#experimental-abi)', () => {
  // `row += W` is a `+` operand, `xi < W` a compare against a number: W is a number and so is `w`.
  const src = `let W = 0, H = 0; export let resize = (w, h) => { W = w; H = h }
    export let area = () => { let row = 0, y = 0; while (y < H) { let x = 0; while (x < W) x++; row += W; y++ } return row }`
  _compileInProcess(src); is(ctx.scope.globalValTypes.get('W'), 'number')
  if (OPT_LEVEL === 2) ok(!/__to_str|__str_concat/.test(compile(src, { wat: true })), 'no string machinery')
  const m = jz(src); m.exports.resize(3, 4); is(m.exports.area(), 12)
  // A typed array's size: ToIndex of a number; a negative or heap-sized count traps, on both the
  // boxed path (a parameter read only there copies an array) and the numeric one.
  const m2 = jz(`export let f = (n) => { let a = new Float64Array(n); return a.length }`)
  is(m2.exports.f(4), 4); is(m2.exports.f(2.5), 2, 'ToIndex truncates'); is(m2.exports.f(NaN), 0)
  let err; try { m2.exports.f(-1) } catch (e) { err = e }
  ok(err instanceof WebAssembly.RuntimeError, 'a negative size traps (JS: a RangeError)')
  err = null; try { m2.exports.f(2 ** 34) } catch (e) { err = e }
  ok(err instanceof WebAssembly.RuntimeError, 'a size past the heap traps (JS: a RangeError)')
  is(m2.exports.f(new Uint8Array([1, 2, 3])), 3, 'an array copies')
  const m3 = jz(`export let f = (n) => { let a = new Float64Array(n * 1); return a.length }`)
  is(m3.exports.f(2.5), 2)
  err = null; try { m3.exports.f(2 ** 29) } catch (e) { err = e }
  ok(err instanceof WebAssembly.RuntimeError, 'the numeric path traps too (before: a wrapped byte count, length 0)')
})

test('summary: a parameter read before its reassignment has its incoming kind', () => {
  // subscript's parse: `cur = s` precedes `s = expr()`, so `cur` is the argument's string.
  _compileInProcess(`let cur = ''; const parse = (s) => (cur = s, s = [1, 2], s.length); export const run = () => parse('abc') + cur.length`)
  is(ctx.scope.globalValTypes.get('cur'), 'string')
  is(tagOf(kindOf('parse', 's')), K.ANY, 'the parameter itself joins its reassignment')
  // A loop that assigns the parameter, and a closure that does, end the region.
  const loop = jz(`const h = (p) => { let a = p; for (let i = 0; i < 2; i++) { a = a + p; p = 'x' } return a }; export const f = () => h(1)`)
  is(loop.exports.f(), '2x')
  const clos = jz(`export const f = (p) => { const g = () => { p = 5 }; g(); return p * 2 }`)
  is(clos.exports.f(1), 10)
})

test('summary: flow facts unwind across branches and reset across functions', () => {
  const src = `
    const first = (x, flag) => {
      if (typeof x === 'string') {
        if (flag) x = x.length;
        else x = x + '!';
      } else x = x + 2;
      return x;
    };
    const second = (x) => { x = String(x); return x.length };
    export const run = (flag) => [first('abc', flag), first(5, flag), second(12)];
  `
  const f = jz(src).exports.run
  is(f(0), ['abc!', 7, 2])
  is(f(1), [3, 7, 2])
  is(f(0), ['abc!', 7, 2], 'a later call retains neither branch refinement nor assignment fact')
})

test('summary: a binding is keyed by its function; a specialized variant has its own kinds', () => {
  _compileInProcess(`const sum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s }
    export const f = () => sum(new Float32Array(4)) + sum(new Float64Array(4))`)
  const variants = ctx.funcs.list.filter(fn => fn.name.startsWith('sum$'))
  is(variants.length, 2, 'the bimorphic typed split made two variants')
  const ctors = variants.map(fn => ctx.summary.at(fn.sig).typedCtorOf(fn.sig.params[0].name)).sort()
  is(ctors.join(), 'new.Float32Array,new.Float64Array', 'each variant\'s parameter has its own constructor, though the name is shared')
  is(ctx.summary.at(null).typedCtorOf(variants[0].sig.params[0].name), null, 'a reader naming no scope sees the join over the variants')
  is(ctx.summary.at(variants[0].name).kindOf('nosuch'), K.NONE)
})

test('summary: the parameter records take their value kinds from the summary (narrow/index.js seedParamKinds)', () => {
  if (onKernel()) return   // kernel: jz.compile routes through the kernel, which never returns `inspect`
  // A parameter's record: the kind's value, schema, constructor and element facts, the tag set, the nullish tags.
  const src = `const mk = () => ({ v: 1 })
    const takes = (o, t, rows, mixed, maybe, arr) => o.v + t[0] + rows[0].v + (mixed ? 1 : 0) + (maybe == null ? 0 : maybe.v) + arr.length
    export const run = (k) => { const rows = [mk(), mk()]; return takes(mk(), new Float32Array(2), rows, k ? 1 : true, k ? mk() : null, [1, 2]) + takes(mk(), new Float32Array(1), rows, 0, mk(), [3]) }`
  const insp = _compileInProcess(src, { wat: true, inspect: true, optimize: { level: OPT_LEVEL, sourceInline: false, inlineFns: false } }).inspect
  const P = insp.functions.takes.callerReps, sid = sidOf(['v'])
  is(P[0].val, 'object'); is(P[0].schemaId, sid)
  is(P[1].val, 'typed'); is(P[1].typedCtor, 'new.Float32Array')
  is(P[2].val, 'array'); is(P[2].arrayElemSchema, sid, 'the element schema, though an element read past the end would be absent')
  is(P[3]?.val, undefined, 'number and boolean join to no one kind')
  is(P[4]?.val, undefined, 'a null argument leaves the reads dynamic'); ok(P[4].nullable, 'and the nullish test live')
  is(P[5].val, 'array'); is(P[5].arrayElemValType, 'number')
  is(jz(src).exports.run(0), 9)
  // Nullish narrowing: a guard proves its name on the path it guards (`if (out) write(out)`,
  // `if (x == null) return`, `x && f(x)`), so the callee's parameter keeps the kind alone.
  const guarded = _compileInProcess(`const write = (buf, x) => { buf.push(x); return buf }
    const relay = (buf, v, out) => { buf.push(v); if (out) write(out, v); return buf }
    const early = (o) => { if (o == null) return 0; return write(o, 1).length }
    const both = (o) => o && write(o, 2)
    export const main = () => { const a = [], b = []; relay(a, 1, b); relay(a, 2); return early(b) + early(null) + (both(a) ? 1 : 0) + (both(null) ? 1 : 0) }`,
    { wat: true, inspect: true, optimize: { level: OPT_LEVEL, sourceInline: false, inlineFns: false } }).inspect
  is(guarded.functions.write.callerReps[0].val, 'array', 'the parameter out is nullish from the short call, an array inside its guard')
  ok(!guarded.functions.write.callerReps[0].nullable)
  // A binding declared without a value is absent until assigned: the callee's nullish test stays live.
  const m = jz(`const f = (c) => { let x; if (c) x = 1; return x }
    const g = (v) => v == null ? -1 : v + 1
    export const run = (c) => g(f(c))`)
  is(m.exports.run(1), 2); is(m.exports.run(0), -1, 'the undefined of the untaken path reaches the callee')
  // The bundled modules' top-level statements are part of the program: a call from an init table binds the callee.
  const b = jz('import { T } from "./t.jz"; export let go = (k, n) => T[k ? "x2" : "x3"](n)',
    { modules: { './t.jz': 'export let hex = (v) => v.toString(16)\nexport const T = { x2: (x) => hex(BigInt(x) * 2n), x3: (x) => hex(BigInt(x) * 3n) }' }, memory: 64 })
  is(b.exports.go(1, 255), (510n).toString(16))
})

test('summary: the result kinds are the summary\'s (narrow/results.js seedResultKinds); a map\'s values, a typeof guard, a try that returns', () => {
  if (onKernel()) return   // kernel: jz.compile routes through the kernel, which never returns `inspect`
  const src = `const cache = new Map()
    const mk = (n) => ({ tw: new Float64Array(n) })
    const plan = (n) => { let p = cache.get(n); if (p === undefined) { p = mk(n); cache.set(n, p) } return p }
    const sum = (tw, n) => { let s = 0; for (let i = 0; i < n; i++) s += tw[i]; return s }
    const norm = (v) => typeof v === 'bigint' ? v : BigInt(v)
    const caught = (x) => { try { if (x) throw new TypeError('t') ; return x > 0 } catch (e) { return e instanceof TypeError } }
    const first = (a) => a[0]
    export const run = (n) => sum(plan(n).tw, n) + Number(norm(2) + norm(3n)) + (caught(1) ? 1 : 0) + first([7])`
  const insp = _compileInProcess(src, { wat: true, inspect: true, optimize: { level: OPT_LEVEL, sourceInline: false, inlineFns: false } }).inspect
  const F = insp.functions
  is(F.plan.valResult, 'object', 'a map\'s value cell: get reads what set stored (with the miss as presence)')
  is(F.sum.callerReps[0].typedCtor, 'new.Float64Array', 'the plan\'s field reaches the kernel typed')
  is(F.norm.valResult, 'bigint', 'the typeof guard proves the taken arm')
  is(F.caught.valResult, 'boolean', 'a try whose block and catch both return does not fall through')
  is(F.first.valResult, 'number'); ok(!F.first.valResultMayBeUndefined, 'the only caller supplies an immutable tuple with element zero present')
  is(jz(src).exports.run(4), 0 + 5 + 1 + 7)
})

test('summary: a literal is allocated as the runtime allocates it; emission reads a local\'s kind from the summary', () => {
  // module/object.js `{}`: a declared `{}` takes its binding's schema (`o.a = 1` merges `a` into it),
  // an empty `{}` declared into a computed-key binding with no schema is a HASH, an argument or a
  // spread literal is not a HASH for certain (the runtime builds an OBJECT with a dyn sidecar, or a
  // dictionary when a spread source's key set is unknown).
  summarize(`const rd = (o) => o.kk
    export const f = (k, x) => {
      let d = {}; d[k] = 1
      let s = {}; s.a = 2; s.b = 3
      const w = rd({ ...(x && { kk: 4 }) })
      return d[k] + s.a + s.b + w + rd(((t) => (t[k] = 5, t))({}))
    }`)
  is(tagOf(kindOf('f', 'd')), K.HASH, 'an empty literal declared into a computed-key binding is a dictionary')
  is(tagOf(kindOf('f', 's')), K.HASH, 'a written empty literal without a materialized schema is a dictionary')
  ok(!isNullable(kindOf('rd', 'o')) && tagOf(kindOf('rd', 'o')) === K.ANY && hasTag(kindOf('rd', 'o'), K.OBJECT) && hasTag(kindOf('rd', 'o'), K.HASH), 'a spread literal or an argument literal is an object or a dictionary')
  for (const optimize of levels(false, 2)) is(jz(`export const f = (k, x) => { let o = {}; o.a = 1; o.b = 2; const t = { [k]: 3 }; return o.a + o.b + t[k] + (new Set([1]).length === undefined ? 10 : 0) }`, { optimize }).exports.f('z', 1), 16, `O${optimize || 0}: the literal reads through the summary's kind`)
})

test('summary: an absent tag joins a union without widening it; a callback drops its surplus arguments', () => {
  summarize(`export const f = (i) => { const a = [4611686018427387903n]; a[0]++; const b = [1n, 2n]; const m = b.map(x => x + 1n); return a[0] + m[i] }`)
  const v = ctx.summary.at('f')
  const read = v.kindOfExpr(['[]', binding('f', 'a'), 0])
  ok(hasTag(read, K.NUMBER) && hasTag(read, K.BIGINT) && hasTag(read, K.ABSENT) && !hasTag(read, K.STRING), 'an element updated by ++ reads as Number, BigInt or absent')
  is(tagOf(v.elemKindOf(binding('f', 'b'))), K.BIGINT, 'the receiver of map keeps its cell: the callback never sees the array it is not bound to')
  is(tagOf(v.elemKindOf(binding('f', 'm'))), K.BIGINT, 'and the mapped cell is the callback result')
})

test('summary: a one-parameter arrow answers through its parameter name; a string method escapes its arguments', () => {
  summarize(`const up = (m) => m.toUpperCase()
    export const f = (k) => { const p = k ? v => BigInt(String(v)) : v => +v; const r = p('300'); return String(typeof r) + 'ab'.replace(/a/, up) }`)
  const f = ctx.funcs.list.find(f => f.name === 'f')
  const arrows = []; const walk = n => { if (Array.isArray(n)) { if (n[0] === '=>' && typeof n[1] === 'string') arrows.push(n); n.forEach(walk) } }; walk(f.body)
  for (const arrow of arrows) is(tagOf(ctx.summary.at(arrow[1]).kindOf(arrow[1])), K.STRING, 'the closure sees its argument through its parameter name')
  ok(ctx.summary.escaped.has('up'), 'a function handed to replace escapes: the summary does not model the call')
})



test('summary: named callable values share closure argument and result analysis', () => {
  const builder = `function put(n,a=[]){if(n===0)return a;a.push(n);return put(n-1,a)}`
  for (const use of ['put(n)', 'ops.put(n)', 'ops[key](n)']) {
    const src = `${builder} export function count(n,key){const ops={put};return [...${use}].length}`
    summarize(src)
    ok(!ctx.summary.escaped.has('put'), 'internal namespace does not escape its function')
    is(tagOf(ctx.summary.resultOf('put')), K.ARRAY, 'recursive default-array result survives a callable value')
    for (const level of levels(0, 2, 3)) {
      const { count } = jz(src, { optimize: { level, sourceInline: false } }).exports
      is(count(0, 'put'), 0)
      is(count(5, 'put'), 5)
    }
  }
  const mixed = `function twice(x){return x*2}
    export function result(n,key){const table={twice, plus:x=>x+3};return table[key](n)}`
  for (const level of levels(0, 2, 3)) {
    const { result } = jz(mixed, { optimize: { level, sourceInline: false } }).exports
    is(result(4, 'twice'), 8)
    is(result(4, 'plus'), 7)
  }
  summarize(`function identity(x){return x} export function get(){return {identity}}`)
  ok(ctx.summary.escaped.has('identity'), 'a host-visible namespace opens its callable parameters')
})

test('summary: joins that never read through a value keep its shapes', () => {
  // `must` only tests its argument: objects and booleans meet there without
  // losing the shapes. A rest parameter is a tuple of its arguments by
  // position. Set elements are followed. A dictionary joined with an object
  // keeps the dictionary cell, its shapes riding on it.
  summarize(`const must = (c, m) => { if (!c) throw new Error(m) }
    const rest = (...args) => args[1]
    export const f = (n) => {
      const cfg = { list: [1, 2], name: 'a' }
      must(cfg, 'cfg'); must(n > 1, 'n')
      const got = rest(n, cfg)
      const s = new Set(); s.add({ k: n })
      let picked = null
      for (const o of s) picked = o
      const src = n > 2 ? { list: [1], name: 'a' } : { name: 'b', list: [2], z: 1 }
      const records = []
      records.push({ ...src, extra: 1 }); records.push({ list: [3], name: 'b' })
      const r = records[0]
      return cfg.list.length + got.list.length + picked.k + r.list.length
    }`)
  is(tagOf(kindOf('f', 'cfg')), K.OBJECT, 'the passive test keeps the literal shape')
  ok(paramOf(kindOf('f', 'cfg')) !== UNKNOWN, 'the shape stays named')
  is(tagOf(kindOf('f', 'got')), K.OBJECT, 'the rest tuple hands back the argument by position')
  ok(paramOf(kindOf('f', 'got')) !== UNKNOWN, 'with its shape')
  is(tagOf(kindOf('f', 'picked')), K.OBJECT, 'iterating a Set yields its elements')
  ok(hasTag(kindOf('f', 'r'), K.HASH) && hasTag(kindOf('f', 'r'), K.OBJECT), 'a dictionary joined with an object keeps both')
  is(jz(`const must = (c, m) => { if (!c) throw new Error(m) }
    export const f = (n) => { const cfg = { list: [1, 2], name: 'a' }; must(cfg, 'x'); must(n > 1, 'n'); return cfg.list.length + n }`).exports.f(5), 7)
})

test('summary: tuple positions keep nested records through literals, rest and collection entries', () => {
  for (const expression of [
    "['key', record][1]",
    "rest('key', record)[1]",
    "[...new Map([['key', record]])][0][1]",
    "[...new Map([['key', record]]).entries()][0][1]",
    "[...new Set(new Map([['key', record]]))][0][1]",
    "[...new Set([record]).entries()][0][1]",
  ]) {
    const src = `const rest = (...args) => args
      export const store = (o, k, v) => { o[k] = v }
      export const f = () => {
        const record = { sig: { params: [2] } }
        const got = ${expression}
        return got.sig.params[0]
      }`
    summarize(src)
    const sid = sidOf(['sig'])
    is(tagOf(ctx.summary.fieldKind(sid, 'sig')), K.OBJECT, expression)
    for (const level of levels(0, 2, 3)) is(jz(src, { optimize: level }).exports.f(), 2, `O${level}: ${expression}`)
  }
})

test('summary: tuples expose nested objects and callables to host effects', () => {
  summarize(`function identity(v) { return v }
    const state = ['key', { items: [1], call: identity }]
    export function get() { return state }
    export function read() { return state[1].items[0] }
    export function seed() { return identity(2) }`)
  ok(ctx.summary.hostSchema(sidOf(['items', 'call'])), 'a nested tuple record uses host-visible field storage')
  ok(ctx.summary.escaped.has('identity'), 'a tuple callable can receive host arguments')
  is(tagOf(ctx.summary.resultOf('read')), K.ANY, 'a retained nested array can be changed between calls')
})

test('summary: a decided condition prunes its dead arm; a nullish receiver read throws', () => {
  // `x === undefined` on a binding that is never nullish walks only the live
  // arm, so a defaulted destructuring keeps the argument's shape. A read
  // through a nullish receiver is a throwing call, not an unknown value.
  summarize(`const mk = (opts) => { const o = opts === undefined ? {} : opts; const sig = o.sig === undefined ? null : o.sig; return { current: sig } }
    export const f = () => { const frame = mk({ sig: { params: [1], results: [] } }); return frame.current.params.length }`)
  is(tagOf(kindOf('mk', 'o')), K.OBJECT, 'the never-undefined argument skips the {} default')
  ok(paramOf(kindOf('mk', 'o')) !== UNKNOWN, 'and keeps its shape')
  is(jz(`const mk = (opts) => { const o = opts === undefined ? {} : opts; const sig = o.sig === undefined ? null : o.sig; return { current: sig } }
    export const f = () => { const frame = mk({ sig: { params: [1], results: [] } }); return frame.current.params.length }`).exports.f(), 1)
})

test('summary: a destructuring reads through its source', () => {
  // An object pattern's names read the source's members, a default merges in
  // when the member may be undefined; an array pattern reads by position.
  const src = `const mk = (opts) => { const { sig = null, body = null, uniq = 0 } = opts; return { current: sig, body, uniq } }
    const rows = [[new Map([[1, 2]]), 'x'], [new Map(), 'y']]
    export const f = () => { const frame = mk({ sig: { params: [1, 2], results: [] } }); return frame.current.params.length + frame.uniq }
    export const g = () => { let n = 0; for (const [m, k] of rows) n += m.size + k.length; const [first, , third = 7] = [1, 2]; return n + first + third }`
  summarize(src)
  is(tagOf(kindOf('mk', 'sig')), K.OBJECT, 'a defaulted object-pattern name keeps the argument member shape')
  ok(isNullable(kindOf('mk', 'sig')), 'and the null default')
  is(tagOf(kindOf('g', 'm')), K.MAP, 'a pattern over a row array reads the row position')
  is(tagOf(kindOf('g', 'k')), K.STRING, 'each position keeps its own kind')
  const js = oracle(src)
  for (const level of levels(0, 2)) { is(jz(src, { optimize: level }).exports.f(), js.f(), `O${level}: object pattern`); is(jz(src, { optimize: level }).exports.g(), js.g(), `O${level}: array pattern`) }
})

test('summary: a static string key is the literal key', () => {
  // `o[KEY]` with `const KEY = 'k'` is the slot access `o.k` compiles to: prepare
  // folds the key, so no dynamic read or store remains.
  const src = `const K = 'sig'
    export const f = (n) => { const o = { sig: 1, body: 2 }; const field = 'body'; o[field] = n; return o[K] + o[field] }`
  const wat = compile(src, { optimize: 1, wat: true })
  ok(!/__dyn_get|__hash_get/.test(typeof wat === 'string' ? wat : wat.wat ?? ''), 'no dynamic read for a const string key')
  is(jz(src).exports.f(5), oracle(src).f(5))
})

test('summary: a container hands out its members only by enumeration', () => {
  // A record stored as a map key or set member beside an unknown one keeps its
  // shape while the map is read by get/has; enumerating the keys loses it.
  const src = `const byRec = new Map(), seen = new Set()
    export const f = (k) => { const r = { sig: { params: [1] } }; byRec.set(k, 1); byRec.set(r, 2); seen.add(k); seen.add(r); return byRec.get(r) + (seen.has(r) ? r.sig.params.length : 0) }
    export const g = (k) => { const r = { tag: { params: [1] } }; const m = new Map([[k, 1], [r, 2]]); let n = 0; for (const key of m.keys()) n += key === r ? 1 : 0; return n + r.tag.params.length }`
  summarize(src)
  ok(!ctx.summary.opaqueSchema(sidOf(['sig'])), 'a key read only by get/has keeps its shape')
  ok(ctx.summary.opaqueSchema(sidOf(['tag'])), 'an enumerated key is lost')
  const js = oracle(src)
  for (const level of levels(0, 2)) { is(jz(src, { optimize: level }).exports.f('a'), js.f('a'), `O${level}: map key`); is(jz(src, { optimize: level }).exports.g('a'), js.g('a'), `O${level}: enumerated`) }
})

test('summary: a wrapper hands back what its closure argument returns', () => {
  // The result at a call is the argument's result, not the join over every
  // callback the wrapper ever ran; a wrapper passing its parameter on forwards.
  const src = `const t = (_, fn) => fn()
    const timed = (name, fn) => { const r = fn(); return r }
    const phase = (p, name, fn) => p?.time ? p.time(name, fn) : fn()
    export const f = () => { const o = t('a', () => ({ a: 1 })); const m = t('b', () => new Map([[1, 2]])); const q = timed('c', () => ({ b: 2 })); const w = phase(null, 'd', () => ({ c: 3 })); return o.a + m.size + q.b + w.c }`
  summarize(src)
  is(tagOf(kindOf('f', 'o')), K.OBJECT, 'an expression-bodied wrapper forwards')
  is(tagOf(kindOf('f', 'm')), K.MAP, 'each call site reads its own argument')
  is(tagOf(kindOf('f', 'q')), K.OBJECT, 'a passive local returned untouched forwards')
  is(tagOf(kindOf('f', 'w')), K.OBJECT, 'a wrapper passing its parameter to another forwards through it')
  is(tagOf(ctx.summary.resultOf('t')), K.ANY, 'away from a call site a forwarded result is unknown')
  for (const level of levels(0, 2)) is(jz(src, { optimize: level }).exports.f(), oracle(src).f(), `O${level}`)
})

test('summary: Object.assign onto a shape stores each source slot; a shape beside primitives keeps its identity', () => {
  const src = `export const f = (flag) => {
    const target = { a: 1, b: 2 }, extra = flag ? { a: 3, c: 4 } : { a: 5, d: 6 }
    Object.assign(target, extra)
    const rec = { sig: { params: [1, 2] } }
    const fn = typeof flag === 'boolean' && rec
    const n = fn ? fn.sig.params.length : 0
    return target.a + n
  }`
  summarize(src)
  is(tagOf(ctx.summary.fieldKind(sidOf(['a', 'b']), 'a')), K.NUMBER, 'a source slot stores into the target slot')
  ok(!ctx.summary.opaqueSchema(sidOf(['a', 'b'])), 'the target keeps its shape')
  is(tagOf(kindOf('f', 'n')), K.NUMBER, 'a record joined with a boolean is read through the join')
  for (const level of levels(0, 2)) is(jz(src, { optimize: level }).exports.f(true), oracle(src).f(true), `O${level}`)
})
