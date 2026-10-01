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
