// Iteration protocol edges — for-of over nullish THROWS (ES: "x is not
// iterable"), it does not silently iterate zero times. The silent form masked
// two real self-compile miscompiles (a strictSentinel-folded undefined guard and
// a never-armed matchAll both fed undefined into for-of and vanished) before
// they were caught. Known-vt receivers pay nothing — the guard lives only in
// __iter_arr's unknown-receiver arm (module/collection.js).
import test, { is } from 'tst'
import { throws } from 'tst/assert.js'
import jz from '../index.js'
import { run, oracle } from './util.js'
import { levels } from './_matrix.js'

test('for-of reads the live array length through direct and helper mutations', () => {
  const src = `
    export function grow(n) {
      const a = n ? [1] : []
      function append(x) { a.push(x) }
      const out = []
      for (const x of a) {
        out.push(x)
        if (x < n) append(x + 1)
      }
      return out
    }
    export function shrink(n) {
      const a = [1, 2, 3, 4], alias = a, out = []
      function resize() { alias.length = n }
      for (const x of a) {
        out.push(x)
        if (x === 1) resize()
      }
      return out
    }
    export function direct() {
      const a = [1], out = []
      for (const x of a) {
        if (x < 3) { a.push(x + 1); continue }
        out.push(x)
        break
      }
      return out
    }
    export function planned() {
      const nodes = [['~', ['~', 0]]], seen = new WeakSet()
      function plan(node) { nodes.push(node) }
      let n = 0
      for (const node of nodes) {
        if (Array.isArray(node[1])) plan(node[1])
        seen.add(node)
        n++
      }
      return [n, seen.has(nodes[1])]
    }
  `
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const actual = run(src, { optimize }), expected = oracle(src)
    for (const n of [0, 1, 1, 4, 2, 0, 4]) {
      is(actual.grow(n), expected.grow(n), `append ${n}, O${optimize}`)
      is(actual.shrink(n), expected.shrink(n), `shrink ${n}, O${optimize}`)
    }
    is(actual.direct(), expected.direct(), `continue and break, O${optimize}`)
    is(actual.planned(), expected.planned(), `newly planned nodes, O${optimize}`)
  }
})

test('for-of captures its source once while observing holes and later element writes', () => {
  const src = `
    export function f(mode) {
      let source = [1, 2], calls = 0
      const original = source, out = []
      function read() { calls++; return source }
      for (const x of read()) {
        out.push(x)
        if (out.length === 1) {
          source = [9]
          if (mode === 1) original[2] = 3
          if (mode === 2) { original.length = 4; original[3] = 4 }
          if (mode === 3) { original[1] = 5; original.length = 1 }
        }
      }
      return [calls, out, source, original]
    }
  `
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const actual = run(src, { optimize }), expected = oracle(src)
    for (const mode of [0, 0, 1, 2, 3, 0])
      is(actual.f(mode), expected.f(mode), `source capture ${mode}, O${optimize}`)
  }
})

test('for-of over nullish throws (catchable), iterables unaffected', async () => {
  const SRC = `
  export const probe = (which) => {
    const src = which > 0 ? [1, 2, 3] : which < 0 ? null : undefined
    let n = 0
    try { for (const x of src) n += x } catch (e) { return 'threw' }
    return 'sum:' + n
  }
  export const spreadable = () => {
    const s = new Set([1, 2])
    let n = 0
    for (const x of s) n += x
    return n
  }`
  for (const optimize of levels(false, 2)) {
    const m = await run(SRC, { memory: 256, optimize })
    is(m.probe(1), 'sum:6', `optimize:${optimize} array iterates`)
    is(m.probe(0), 'threw', `optimize:${optimize} undefined throws`)
    is(m.probe(-1), 'threw', `optimize:${optimize} null throws`)
    is(m.spreadable(), 3, `optimize:${optimize} Set iterates`)
  }
})

test('Set/Map constructors: nullish iterable is an EMPTY collection, for-of still throws', () => {
  // ES: the CONSTRUCTOR skips iteration for undefined/null (new Set(undefined)
  // is empty — GetIterator never runs), while for-of/spread over nullish is a
  // TypeError. The ctor path used to route through the for-of normalizer and
  // threw — natively masked (host JS semantics), self-compiled it broke the
  // compiler's own `new Set(maybeUndefined)` (the census-row class).
  const { f } = run(`export let f = (use) => {
    const base = use ? new Set(['x']) : undefined
    const s = new Set(base)
    const m = new Map(use ? undefined : null)
    return (s.has('x') ? 1 : 0) + m.size * 10
  }`).exports ?? run(`export let f = (use) => {
    const base = use ? new Set(['x']) : undefined
    const s = new Set(base)
    const m = new Map(use ? undefined : null)
    return (s.has('x') ? 1 : 0) + m.size * 10
  }`)
  is(Number(f(1)), 1)
  is(Number(f(0)), 0)
})

test('for-of over an iterable of unknown kind resolves it at runtime (a host typed array, a Set, a Map)', async () => {
  // The summary knows a for-of's iterable only when the program built it: a host
  // encoder's bytes are of no kind it names, so the loop dispatches on the value
  // (the self-hosted compiler read its custom-section bytes as f64s once).
  const SRC = `
  const utf8 = new TextEncoder()
  export const bytes = (s) => { const out = []; for (const x of utf8.encode(s)) out.push(x); return out[0] * 1000 + out[1] }
  export const colls = () => { const out = []; for (const x of new Set([3, 4])) out.push(x); for (const [k, v] of new Map([[1, 2]])) out.push(k * 10 + v); return out[0] * 1000 + out[1] * 100 + out[2] }`
  for (const optimize of levels(false, 2)) {
    const m = await run(SRC, { optimize })
    is(m.bytes('ab'), 97098, `optimize:${optimize} the encoder's bytes iterate as bytes`)
    is(m.colls(), 3412, `optimize:${optimize} a Set and a Map iterate as arrays`)
  }
})


test('iteration rejects noniterables through spread, calls, loops and collection constructors', () => {
  const src = `function args(...xs) { return xs }
    export function f(which, mode) {
      const sources = [3, -0, NaN, Infinity, false, true, 17n, 0x7ff8000100000000n,
        {}, {length: 1, 0: 3}, () => 1, new Date(0), new ArrayBuffer(0), new ArrayBuffer(8),
        new DataView(new ArrayBuffer(8)), null, undefined, [], [1, 2], 'a𝄞', new Int16Array([3, 4])];
      const x = sources[which];
      try {
        if (mode === 0) return [...x];
        if (mode === 1) return [1].concat(...x);
        if (mode === 2) return args(...x);
        if (mode === 3) { let n = 0; for (const v of x) n++; return n }
        return new Set(x).size;
      } catch (e) { return [e.name, e instanceof TypeError] }
    }`
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const got = jz(src, { optimize }).exports, want = oracle(src), retained = []
    for (const which of [17, 17, ...Array.from({length: 17}, (_, i) => i), 18, 19, 20, 17, 3, 18])
      for (let mode = 0; mode < 5; mode++) {
        const actual = got.f(which, mode), expected = want.f(which, mode)
        is(actual, expected, `O${optimize}: source ${which}, operation ${mode}`)
        if (which >= 17 && mode < 3) retained.push([actual, expected])
      }
    for (const [actual, expected] of retained) is(actual, expected, 'subsequent throws preserve retained results')
  }
})

test('iteration rejects statically known noniterables and decodes host TypeErrors', () => {
  const values = ['3', 'false', '17n', '0x7ff8000100000000n', '{}', '{length: 1, 0: 3}',
    'new Date(0)', 'new ArrayBuffer(0)', 'new DataView(new ArrayBuffer(0))']
  for (const optimize of levels(0, 1, 2, 3, 'size')) for (const value of values) {
    const src = `export function f() { return [...(${value})] }
      export function valid() { return [...[1, 2]] }`
    const got = jz(src, { optimize }).exports, want = oracle(src)
    for (let i = 0; i < 2; i++) {
      throws(() => got.f(), TypeError, `O${optimize}: ${value}`)
      throws(() => want.f(), TypeError)
      is(got.valid(), want.valid(), 'same instance recovers after failed iteration')
    }
  }
})

test('iteration retains indexed, collection and custom protocol sources', () => {
  const src = `export function f(n) {
      const custom = { [Symbol.iterator]() { let i = 0; return { next() { return i < n ? {value: ++i, done: false} : {done: true} } } } };
      const out = []; for (const v of custom) out.push(v);
      return [out, [...custom], [0].concat(...custom), [...new Set([1, 2])], [...new Map([[1, 2]])],
        [...new BigInt64Array([3n])], [...new Uint8Array([4])], [...new Set(new Int16Array([3, 3, 4]))],
        [...new Set(new BigInt64Array([3n, 3n, 4n]))], [...'a𝄞'], [...[, undefined]],
        Array.from({length: 2, 0: 7}), Array.from(3),
        Object.groupBy(new BigInt64Array([3n, 4n]), x => typeof x).bigint,
        Map.groupBy(new BigInt64Array([3n, 4n]), x => typeof x).get('bigint')]
    }`
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const got = jz(src, { optimize }).exports, want = oracle(src)
    for (const n of [0, 0, 1, 3, 0, 2]) is(got.f(n), want.f(n), `O${optimize}: valid iterator ${n}`)
  }
})


test('Map construction validates iterable sources and object entries', () => {
  const src = `export function f(which) {
      const sources = [undefined, null, [], new Map(), '', new Int16Array(0),
        3, false, 17n, 0x7ff8000100000000n, {}, new Date(0), new ArrayBuffer(0), new DataView(new ArrayBuffer(0)),
        [3], [NaN], ['ab'], [null], [undefined], [,], new Int16Array([1]), new BigInt64Array([0x7ff8000100000000n]), 'ab',
        [['a', 1], ['b', 2], ['a', 3]], [{0: 'a', 1: 2n}, {0: 'b'}],
        new Set([['a', 1], ['b', 2]]), [new Int16Array([3, 4])], [new BigInt64Array([3n, 4n])],
        [new DataView(new ArrayBuffer(8))]];
      try { return [...new Map(sources[which])] } catch (e) { return [e.name, e instanceof TypeError] }
    }
    export function direct() { function pair(){}; pair[0] = 'fn'; pair[1] = 3;
      return [...new Map([{0: 'key', 1: 7n}, pair])] }
    export function invalid() { return new Map([3]) }`
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const got = jz(src, { optimize }).exports, want = oracle(src), retained = []
    for (const which of [0, 0, ...Array.from({length: 29}, (_, i) => i), 23, 6, 23, 0]) {
      const actual = got.f(which), expected = want.f(which)
      is(actual, expected, `O${optimize}: constructor source ${which}`)
      if (which >= 23) retained.push([actual, expected])
    }
    for (const [actual, expected] of retained) is(actual, expected, 'retained maps survive later failed construction')
    throws(() => got.invalid(), TypeError); throws(() => want.invalid(), TypeError)
    is(got.direct(), want.direct(), 'object pair fields preserve tagged BigInt identity after error')
  }
})

test('Map construction reads entry properties in order and keeps its array iterator live', () => {
  const src = `export function f(mode) { let log = ''; const entries = [];
      const first = {get 0() { log += 'k'; if (mode === 0) entries.push(['c', 3]);
          if (mode === 1) entries.length = 1; return 'a' },
        get 1() { log += 'v'; if (mode === 2) throw new Error('entry'); return 1 } };
      entries.push(first, {get 0(){log += 'K';return 'b'}, get 1(){log += 'V';if (mode === 3) throw new Error('later');return 2}});
      try { return [[...new Map(entries)], log] } catch (e) { return [log, e.message, e instanceof Error] }
    }
    export function copy(n) { const source = new Map([['a', 1], ['b', 2], ['c', 3]]); source.note = 7;
      if (n) source.delete('b'); const copy = new Map(source); copy.set('a', 5); copy.set('d', 4);
      return [[...source], [...copy], copy.note, source.note] }`
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const got = jz(src, { optimize }).exports, want = oracle(src)
    for (const mode of [0, 0, 1, 2, 3, 1, 0]) is(got.f(mode), want.f(mode), `O${optimize}: entry effects ${mode}`)
    for (const n of [0, 0, 1, 0]) is(got.copy(n), want.copy(n), 'Map-copy fast path preserves order and independence')
  }
})

test('collection constructors stream custom iterators and close only unfinished abrupt iteration', () => {
  const src = `export function f(map, mode, count) {
    let trace = '', index = 0;
    const iterator = {
      get next() {
        trace += 'g';
        if (mode === 9) throw new Error('next getter');
        if (mode === 10) return 3;
        return () => {
          trace += 'n' + index;
          if (mode === 1) throw new Error('next');
          if (index >= count) return {done:true};
          const at = index++;
          return {
            get done(){trace += 'd' + at;if(mode === 2) throw new Error('done');return false},
            get value(){trace += 'v' + at;if(mode === 3) throw new Error('value');
              if (!map) return at;
              if (mode === 4 || mode === 7 || mode === 8) return 3;
              return {get 0(){trace += 'k' + at;if(mode === 5)throw new Error('key');return 'k' + at},
                get 1(){trace += 'x' + at;if(mode === 6)throw new Error('entry value');return at + 10}}
            }
          }
        }
      },
      get return(){trace += 'r';if(mode === 8)return 3;return () => {trace += 'c';if(mode === 7)throw new Error('close');return {done:true}}}
    };
    const source = {get [Symbol.iterator](){trace += 'i';if(mode === 11)return 3;
      return () => {trace += 'o';return mode === 12 ? 3 : iterator}}};
    try { const out = map ? new Map(source) : new Set(source);return [[...out], trace] }
    catch(e){return [e.name, trace]}
  }`
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const got = jz(src, {optimize, sourceInline:false}).exports, want = oracle(src)
    const held = []
    for (const map of [true, false]) for (const mode of [0,0,1,2,3,4,5,6,7,8,9,10,11,12,0]) {
      const count = mode === 0 ? held.length % 3 : 2;
      const actual = got.f(map, mode, count), expected = want.f(map, mode, count);
      is(actual, expected, `O${optimize}: ${map ? 'Map' : 'Set'}, mode ${mode}, count ${count}`)
      held.push([actual, expected])
    }
    for (const [actual, expected] of held) is(actual, expected, 'later errors and iteration preserve earlier results')
  }
})

test('collection constructors honor iterator overrides, generators and shadowed constructors', () => {
  const src = `function* entries(n){for(let i = 0; i < n; i++) yield ['k' + i, i + 2]}
    function* values(n){for(let i = 0; i < n; i++) yield i % 2}
    export function generated(n){return [[...new Map(entries(n))], [...new Set(values(n))],
      typeof entries(0)[Symbol.iterator]]}
    export function overridden(which, map) {
      let trace = '';
      const a = which === 0 ? [['original', 3]] : which === 1 ? new Map([['original', 3]]) : new Set([3]);
      a[Symbol.iterator] = () => {trace += 'o';let i = 0;return {next(){trace += 'n';return i++ ? {done:true} : {done:false,value:map ? ['custom',7] : 7}}}};
      return [map ? [...new Map(a)] : [...new Set(a)], trace]
    }
    export function invalid(mode){const a = [1];a[Symbol.iterator] = mode ? null : undefined;
      try{return [...new Set(a)]}catch(e){return e.name}}
    export function bare(){try{return [...new Set({next(){return{done:true}}})]}catch(e){return e.name}}
    export function shadow(){class Map{constructor(x){this.x=x} }return new Map(7).x}
    export function extra(){let calls=0;const out=new Set(values(2),calls++);return[[...out],calls]}
    function* args(n){yield entries(n)}
    export function spread(n){return [...new Map(...args(n))]}
    class Source { constructor(n){this.n=n} *[Symbol.iterator](){for(let i=0;i<this.n;i++)yield ['c'+i,i]} }
    export function classes(n){return [...new Map(new Source(n))]}
    export function subclasses(n){class SourceMap extends Map { *[Symbol.iterator](){for(let i=0;i<n;i++)yield ['s'+i,i]} }
      return [...new Map(new SourceMap())]}
    export function argumentOrder(){let trace='';const source = {[Symbol.iterator](){trace+='old';return{next(){return{done:true}}}}};
      function extra(){trace+='arg';source[Symbol.iterator]=()=>{trace+='new';return{next(){trace+='n';return{done:true}}}}}
      const out = new Map(source,extra());return [out.size,trace]}`
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const got = jz(src, {optimize, sourceInline:false}).exports, want = oracle(src)
    for (const n of [0,0,1,4,0]) is(got.generated(n), want.generated(n), `O${optimize}: generator length ${n}`)
    for (const which of [0,0,1,2,0]) for (const map of [true,false])
      is(got.overridden(which,map), want.overridden(which,map), 'own iterator overrides builtin iteration')
    for (const mode of [0,1,0]) is(got.invalid(mode), want.invalid(mode), 'an own nullish method does not select the builtin iterator')
    is(got.bare(), want.bare(), 'a next-only object is not iterable')
    is(got.shadow(), want.shadow(), 'a shadowed constructor keeps its own behavior')
    is(got.extra(), want.extra(), 'ignored constructor arguments still evaluate')
    for (const n of [0,1,3,0]) {
      is(got.spread(n), want.spread(n), 'spread constructor arguments consume their iterator first')
      is(got.classes(n), want.classes(n), 'class iterator methods keep their receiver')
      is(got.subclasses(n), want.subclasses(n), 'collection subclasses retain their iterator override')
    }
    is(got.argumentOrder(), want.argumentOrder(), 'ignored arguments finish before the iterator method is read')
  }
  const plain = `const a = new Map([['a', 1]]), b = new Set([1,2]);export function f(){return [new Map(a).size,new Set(b).size]}`
  is(jz.compile(plain, {wat:true, optimize:0}).includes('__it_open'), false, 'a later native-only compilation does not link protocol records')
  is(jz(plain).exports.f(), oracle(plain).f(), 'native copies remain exact after compiling protocol users')
})

test('iterator records accept callable objects and release records after empty binding', () => {
  const src = `export function f() {
    let calls = 0;
    function iterator(){}
    iterator.next = () => {function step(){};step.done = calls > 0;step.value = ['a', 7];calls++;return step};
    const source = {[Symbol.iterator](){return iterator}};
    return [[...new Map(source)], calls]
  }
  export function close(empty) {
    let trace = '';
    const source = {[Symbol.iterator](){return {next(){trace+='n';return{done:false,value:3}},
      return(){trace+='r';return ()=>0}}}};
    if (empty) { const [] = source } else { const [first] = source;trace += first }
    return trace
  }`
  for (const optimize of levels(0,1,2,3,'size')) {
    const got = jz(src, {optimize, sourceInline:false}).exports, want = oracle(src)
    for (const empty of [true,true,false,true]) {
      is(got.f(), want.f(), `O${optimize}: callable iterator and result objects`)
      is(got.close(empty), want.close(empty), 'a callable return result is an object, including zero-work close')
    }
  }
})

test('held collection methods keep identity and receive the explicit call receiver', () => {
  const src = `
    const saved = new Map().set
    function held(m, fn = m.get) { return fn }
    export function f(n) {
      const m = new Map(), other = new Map(), s = new Set(), otherSet = new Set()
      const set = m.set, get = held(m), add = s['add'], has = otherSet.has
      const out = [set === saved, set === other.set, add === otherSet.add,
        s.keys === s.values, m.keys === m.values, typeof set, typeof add]
      for (let i = 0; i < n; i++) {
        out.push(set.call(other, i, BigInt(i) + 17n) === other)
        out.push(add.apply(otherSet, [i]) === otherSet)
      }
      out.push(m.size, s.size, other.size, otherSet.size,
        get.call(other, 0), get.call(other, n), has.call(otherSet, 0))
      const keys = other.keys, values = other.values, entries = other.entries
      out.push(Array.from(keys.call(other)), Array.from(values.call(other)), Array.from(entries.call(other)))
      const del = other.delete, clear = otherSet.clear
      out.push(del.call(other, 0), del.call(other, n), clear.call(otherSet), otherSet.size)
      let total = 0
      const each = other.forEach
      each.call(other, (value, key) => { total += Number(value) + key })
      out.push(total)
      return out
    }
    export function prototype() {
      const m = new Map(), s = new Set()
      Map.prototype.set.call(m, 'x', 7)
      Set.prototype.add.call(s, 8)
      return [m.get('x'), s.has(8), m.set === Map.prototype.set, s.add === Set.prototype.add,
        m.set.length,m.get.length,m.clear.length,m.forEach.length,s.add.length,s.keys.length]
    }
  `
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const got = jz(src, { optimize }).exports, want = oracle(src), retained = []
    for (const n of [0, 1, 1, 4, 0, 4, 1]) {
      const value = got.f(n), expected = want.f(n)
      is(value, expected, `O${optimize}, n=${n}`)
      retained.push([value, expected])
    }
    for (const [value, expected] of retained) is(value, expected, `retained O${optimize}`)
    is(got.prototype(), want.prototype(), `prototype O${optimize}`)
  }
})

test('held collection methods preserve own values, getters, receiver effects and optional reads', () => {
  const src = `
    let log = ''
    class Own extends Map {
      get set() { log += 'g'; return this.extra }
    }
    function read(value) { log += 'r'; return value }
    export function f(mode) {
      log = ''
      const m = new Map()
      let value = m
      if (mode === 1) m.set = undefined
      if (mode === 2) m.set = (key, value) => { log += 'c'; return key + value }
      if (mode === 3) { value = new Own(); value.extra = (key, value) => { log += 'o'; return key + value } }
      if (mode === 4) value = null
      if (mode === 5) value = { get set() { log += 'p'; return 7 } }
      const fn = read(value)?.set
      let result = typeof fn
      if (typeof fn === 'function') result = fn.call(value, 'x', 3)
      return [result === value ? 'receiver' : result, log, m.size]
    }
    export function bracket(flag) {
      const m = flag ? new Map() : undefined
      return typeof m?.['set']
    }
  `
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const got = jz(src, { optimize }).exports, want = oracle(src)
    for (const mode of [0, 0, 1, 2, 3, 4, 5, 0, 3]) is(got.f(mode), want.f(mode), `own O${optimize}, ${mode}`)
    for (const flag of [0, 0, 1, 0, 1]) is(got.bracket(flag), want.bracket(flag), `optional O${optimize}, ${flag}`)
  }
})

test('held collection methods reject incompatible receivers after evaluating arguments', () => {
  const src = `
    const m = new Map(), s = new Set()
    export function f(mode) {
      let log = ''
      function arg(value) { log += 'a'; return value }
      const set = m.set, add = s.add
      try {
        if (mode === 0) set(arg('x'), arg(3))
        if (mode === 1) set.call(s, arg('x'), arg(3), arg(4))
        if (mode === 2) add.call(m, arg(2))
        if (mode === 3) set.call(null, arg('x'), arg(3))
        if (mode === 4) add.call(7, arg(2))
        if (mode === 5) add.call(17n, arg(2))
        if (mode === 6) set.call(m, arg('x'), arg(3))
        return ['ok', log, m.get('x')]
      } catch (e) { return [e instanceof TypeError, log] }
    }
  `
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const got = jz(src, { optimize }).exports, want = oracle(src)
    for (const mode of [0, 0, 1, 2, 3, 4, 5, 6, 0, 6]) is(got.f(mode), want.f(mode), `receiver O${optimize}, ${mode}`)
  }
})

test('held collection method helpers do not resolve user shadowed builtin names', () => {
  const src = `class Map { get() { return 3 } }
    class Set { add() { return 4 } }
    class TypeError { constructor() { throw 9 } }
    export function f() { const a = new Map(), b = new Set(), get = a.get, add = b.add; return [get(), add()] }
  `
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const got = jz(src, { optimize }).exports, want = oracle(src)
    is(got.f(), want.f(), `shadow O${optimize}`)
    is(got.f(), want.f(), `shadow repeat O${optimize}`)
  }
})

test('held collection method reads preserve continued optional chains and grouped throws', () => {
  const src = `export function f(flag){const m=flag?new Map():null;let grouped;
    try{grouped=(m?.set).extra}catch(e){grouped=e instanceof TypeError}
    return[typeof m?.set,m?.set.extra,typeof m?.['set'],m?.['set'].extra,grouped]}
    export function own(){const m=new Map(),fn=m.set;fn.extra=7;return[m.set.extra,new Map().set.extra]}`
  for(const optimize of levels(0,1,2,3,'size')){
    const got=jz(src,{optimize}).exports,want=oracle(src)
    for(const flag of [0,0,1,0,1])is(got.f(flag),want.f(flag),`chain O${optimize}, ${flag}`)
    // Avoid mutating Node's shared native method from the oracle: the identity
    // invariant here is the same method read through distinct receivers.
    is(got.own(),[7,7],`method own field O${optimize}`)
    is(got.f(1),['function',7,'function',7,7],`retained method own field O${optimize}`)
    is(got.own(),[7,7],`repeated method own field O${optimize}`)
  }
})


test('held collection method demand follows helpers, defaults and closure scopes across compiles', () => {
  const a = `function make(){return new Map()}
    function choose(m, fn=m.set){return fn}
    export function f(n){const m=make(),read=()=>m.set,a=read(),b=choose(m);
      a.call(m,'x',n);return[a===b,m.get('x'),typeof make().set]}`
  const b = `export function f(n){const row={get:n},read=()=>row.get;return read()+2}`
  for(const optimize of levels(0,1,2,3,'size')){
    const retained=[]
    for(const src of [a,a,b,a]){
      const got=jz(src,{optimize,sourceInline:false}).exports,want=oracle(src)
      for(const n of [0,0,7,-1,0])is(got.f(n),want.f(n),`scope O${optimize}, ${n}`)
      retained.push([got,want])
    }
    for(const [got,want] of retained)is(got.f(4),want.f(4),`retained compiler result O${optimize}`)
  }
})


test('collection subclasses pass their receiver to captured super methods', () => {
  const src = `let trace='';
    class M extends Map{set(k,v){trace+='m';return super.set(k,v+1)}
      clear(){trace+='c';super.clear();return this.size}}
    class N extends M{set(k,v){trace+='n';return super.set(k,v+2)}}
    class S extends Set{add(v){trace+='s';return super.add(v+1)}}
    export function f(n){trace='';const m=new N(),s=new S();
      for(let i=0;i<n;i++){m.set(i,i);s.add(i)}
      const out=[Array.from(m.entries()),Array.from(s.values()),trace,m.size,s.size];
      out.push(m.clear(),m.size,trace);return out}
    export function ordinary(n){class A{constructor(){this.v=1}add(n){this.v+=n;return this.v}}
      class B extends A{add(n){return super.add(n)+1}}
      const b=new B();return[b.add(n),b.add(n),b.v]}`
  for(const optimize of levels(0,1,2,3,'size')){
    const got=jz(src,{optimize}).exports,want=oracle(src),retained=[]
    for(const n of [0,0,1,3,0,1]){
      const value=got.f(n),expected=want.f(n);is(value,expected,`super O${optimize}, ${n}`)
      retained.push([value,expected]);is(got.ordinary(n),want.ordinary(n),`bound base O${optimize}, ${n}`)
    }
    for(const [value,expected] of retained)is(value,expected,`retained super O${optimize}`)
  }
})

test('collection subclasses install the most-derived methods before population and fields', () => {
  const src = `let trace='';
    class A extends Map {
      base=(trace+='f',1)
      constructor(source=[]){trace+='p';super(source);trace+='a'}
      set(k,v){trace+='A'+String(this.base);return super.set(k,v+1)}
    }
    class B extends A {
      child=(trace+='g',2)
      constructor(source){trace+='q';super(source);trace+='b'}
      set(k,v){trace+='B'+String(this.child);return super.set(k,v+2)}
    }
    class S extends Set {field=(trace+='f',3);add(v){trace+='s'+String(this.field);return super.add(v+1)}}
    export function f(n){trace='';const entries=[];for(let i=0;i<n;i++)entries.push([i,i]);
      const b=new B(entries);return[Array.from(b.entries()),trace,b.base,b.child,
        b instanceof A,b instanceof B,b instanceof Map,b.constructor===B,Object.keys(b)]}
    export function set(n){trace='';const values=[];for(let i=0;i<n;i++)values.push(i);
      const s=new S(values);return[Array.from(s.values()),trace,s.field,s instanceof S,s instanceof Set]}`
  for(const optimize of levels(0,1,2,3,'size')){
    const got=jz(src,{optimize}).exports,want=oracle(src),retained=[]
    for(const n of [0,0,1,3,0,1]){
      const value=got.f(n),expected=want.f(n);is(value,expected,`population O${optimize}, ${n}`)
      retained.push([value,expected]);is(got.set(n),want.set(n),`Set population O${optimize}, ${n}`)
    }
    for(const [value,expected] of retained)is(value,expected,`retained population O${optimize}`)
  }
})

test('collection subclass constructors capture the adder before opening and close abrupt iteration', () => {
  const src = `let trace='',mode=0;
    class G extends Map {
      get set(){trace+='g';if(mode===1)throw 1;if(mode===2)return 7;if(this.override)return this.override;
        return (k,v)=>{trace+='s';if(mode===3||mode===7)throw 3;
          if(mode===6)this.override=()=>{trace+='z'};return Map.prototype.set.call(this,k,v)}}
    }
    function source(){return{[Symbol.iterator](){trace+='o';let i=0;
      return{next(){trace+='n';if(mode===4)throw 4;if(i++>(mode===6?1:0)||mode===9)return{done:true};
        return{done:false,value:{get 0(){trace+='k';if(mode===5)throw 5;return 'x'},get 1(){trace+='v';return 7}}}},
        return(){trace+='r';if(mode===7)throw 8;return{done:true}}}}}}
    export function f(m){mode=m;trace='';try{const g=new G(m===8?null:source());return[Array.from(g.entries()),trace]}
      catch(e){return[e instanceof TypeError?'TypeError':e,trace]}}
    let input;
    class Grow extends Map {set(k,v){if(k===0)input.push([2,8]);return super.set(k,v)}}
    export function live(){input=[[0,3]];return Array.from(new Grow(input).entries())}`
  for(const optimize of levels(0,1,2,3,'size')){
    const got=jz(src,{optimize,sourceInline:false}).exports,want=oracle(src)
    for(const mode of [0,0,1,0,2,0,3,0,4,0,5,0,6,7,8,9,0])is(got.f(mode),want.f(mode),`adder O${optimize}, ${mode}`)
    is(got.live(),want.live(),`native live iteration O${optimize}`)
    is(got.live(),want.live(),`native repeated live iteration O${optimize}`)
  }
})


test('collection subclass initializers retain captured local scopes and shadowed class names', () => {
  const src = `class M extends Map{set(k,v){return super.set(k,v+100)}}
    class S extends Set{add(v){return super.add(v+100)}}
    function first(n){class M extends Map{set(k,v){return super.set(k,v+n)}}class N extends M{}
      const m=new N([['x',3]]);return[m.get('x'),m instanceof M,m instanceof N,m instanceof Map]}
    function second(n){class M extends Set{add(v){return super.add(v+n)}}class N extends M{}
      const s=new N([3]);return[Array.from(s.values()),s instanceof M,s instanceof N,s instanceof Set]}
    export function f(n){return[first(n),second(n),new M([['x',1]]).get('x')]}
    export function shadow(Map,Set){class D extends M{set(k,v){return super.set(k,v+1)}peek(){return super.get('x')}}
      class T extends S{add(v){return super.add(v+1)}has(v){return super.has(v)}}
      return[new D([['x',1]]).peek(),new T([1]).has(102)]}
    export function custom(){class Map{constructor(source){this.source=source}read(){return this.source}}
      class N extends Map{read(){return super.read()+1}}const n=new N(7);return n.read()}`
  for(const optimize of levels(0,1,2,3,'size')){
    const got=jz(src,{optimize}).exports,want=oracle(src),retained=[]
    for(const n of [0,0,3,-1,0]){const value=got.f(n),expected=want.f(n);
      is(value,expected,`local O${optimize}, ${n}`);retained.push([value,expected])}
    for(const [value,expected] of retained)is(value,expected,`retained local O${optimize}`)
    is(got.custom(),want.custom(),`shadowed constructor O${optimize}`)
    for(const n of [0,1,0])is(got.shadow(n,n),want.shadow(n,n),`shadowed native family O${optimize}`)
  }
})
