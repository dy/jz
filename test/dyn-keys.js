// Dynamic-key dictionary semantics vs V8 (the lean-write/generic-read layout
// mismatch family — ledger 2026-07-22). The load-bearing pin: a LOOP-BUILT
// dict (keys from array elements — qualifies the ephemeral write layout
// unless reads disqualify it) read with a missing key must be undefined,
// never a trap and never a garbage hit.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { onKernel, withBigintStrict, levels, belowOpt } from './_matrix.js'
import { oracle, funcWat } from './util.js'

const run = (body) => jz('export let f = () => {' + body + '}', { jzify: true }).exports.f()

test('runtime keys read collection size after growth, deletion and clearing', () => {
  for (const ctor of ['Map', 'Set']) for (const optimize of [0, 2, 'speed']) {
    const put = ctor === 'Map' ? 'm.set(i,i)' : 'm.add(i)'
    const src = `export function f(k,n){const m=new ${ctor}();const empty=m[k];for(let i=0;i<n;i++)${put};
      const grown=m[k];m.delete(0);const removed=m[k];const present=k in m;m.clear();return empty+':'+grown+':'+removed+':'+m[k]+':'+present}`
    const f = jz(src, { optimize }).exports.f
    is(f('size', 0), '0:0:0:0:true', `${ctor} empty`)
    is(f('size', 40), '0:40:39:0:true', `${ctor} forwarded storage`)
    is(f('missing', 1), 'undefined:undefined:undefined:undefined:false', 'missing key')
    is(f('size', 1), '0:1:0:0:true', 'repeated instance')
  }
})

test('property dispatch preserves key effects, misses and array relocation', () => {
  const src = `export function f(mode,kind){
    const a=[3,5],d={};d['0']=7;const o=mode?d:a;o.label='owned';let calls=0;
    const key={toString(){calls++;if(kind===2)throw 29;
      if(kind===1){if(!mode)for(let i=0;i<40;i++)a.push(i);o[0]=11;return '0'}
      return kind===3?'absent':'label'}};
    try{return [o[key],calls,o[0]]}catch(e){return [e,calls,o[0]]}}
  `
  const expected = oracle(src).f
  for (const optimize of levels(0, 2, 3, 'size')) {
    const { f } = jz(src, { optimize }).exports
    for (const kind of [0, 1, 2, 3])
      for (const mode of [0, 0, 1, 0]) is(f(mode, kind), expected(mode, kind), `O${optimize}, ${mode}/${kind}`)
  }
})

test('typed BigInt keys and updates retain identity without BigInt literals', () => {
  // `key = '' + key`: the export boundary is numeric for a parameter used only
  // as a typed-array index (README, "Host boundary"); a program that wants the
  // host's property keys takes them as strings, JS's own ToPropertyKey.
  const src = `export function f(key,k) {
    key = '' + key
    const a=new BigInt64Array(3),d=new DataView(a.buffer)
    if(k){d.setUint32(8,1,true);d.setUint32(20,2146959362,true)}
    a.label='named'
    const old=a[key],items=[]
    items.push(old);items.unshift(a[1])
    return [typeof old,old,items,typeof a.length,a.length]
  }
  export function step(key) {
    key = '' + key
    const a=new BigInt64Array(2)
    const before=a[key]++,after=--a[key]
    return [before,after,a[key]]
  }`
  const js = oracle(src)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const wasm = jz(src, { optimize }).exports
    for (const [key,k] of [[0,0],[0,0],['1',1],['2',1],['length',0],['label',0],[3,0],[0,0]])
      is(wasm.f(key,k), js.f(key,k), `O${optimize}, key ${key}/${k}`)
    for (const key of [0,'1',0]) is(wasm.step(key), js.step(key), `O${optimize}, update ${key}`)
  }
})

test('typed-array property keys preserve named values and canonical numeric indexing', () => {
  const src = `export function f(key, value) {
    key = '' + key
    const a = new Int32Array([9, 11])
    const assigned = a[key] = value
    return [assigned, a[key], a['label'], a[0], a[1], a.length]
  }`
  const expected = oracle(src).f
  for (const optimize of [0, 2, 3, 'size']) {
    const { f } = jz(src, { optimize }).exports
    for (const key of ['label', '0', '01', '-0', '-1', '1.5', 'NaN', 'Infinity', '1e0', '', 'é', 'a\0b',
      '1.0', '+1', ' 1', '2147483647', '9007199254740993',
      null, undefined, false, 0, -0, -2, 1, 1.5, NaN, Infinity, 'label'])
      for (const value of [4294967294, 1.5, 'text', '17', true])
        is(f(key, value), expected(key, value), `O${optimize}: ${String(key)}, ${String(value)}`)
  }
})

// The export boundary (README, "Host boundary"): a parameter used only as a
// typed-array index takes an f64 slot, so the host's key converts as `+key` and
// the index coerces to i32 ("Array indices coerce to i32"). Property semantics
// for string keys hold wherever the program holds the key as a string: an
// internal helper whose callers pass strings.
test('exported typed-array index parameters take the numeric boundary; internal string keys keep property semantics', () => {
  for (const exports of [
    `export function get(key) { return a[key] }
     export function mixed(key) { return a[key] + (key | 0) }`,
    `export const get = key => a[key];
     export const mixed = key => a[key] + (key | 0);`
  ]) {
    const src = `const a = new Float64Array([3, 5]); ${exports}`
    const ref = new Float64Array([3, 5])
    const at = (key) => { const i = +key | 0; return i >= 0 && i < ref.length ? ref[i] : undefined }
    const expected = { get: at, mixed: (key) => at(key) + (key | 0) }
    for (const optimize of [...levels(0, 2, 3), 'size']) {
      const wasm = jz(src, { optimize }).exports
      for (const name of ['get', 'mixed'])
        for (const key of ['length', 'byteLength', 'byteOffset', 0, '1', '', 'length\0', 'length'])
          is(wasm[name](key), expected[name](key), `O${optimize}: ${name}(${key})`)
    }
  }
  const internal = `const a = new Float64Array([3, 5]);
    function get(key) { return a[key] }
    export function props() { return [get('length'), get('byteLength'), get('byteOffset'), get('1'), get(''), get('length\\0')] }`
  for (const optimize of [...levels(0, 2, 3), 'size'])
    is(jz(internal, { optimize }).exports.props(), [2, 16, 0, 5, undefined, undefined], `O${optimize}: string keys through an internal helper`)
})

test('exported typed-array stores take the numeric boundary for key and value; internal named keys stay properties', () => {
  const src = `const a = new Float64Array([3, 5]);
    export function put(key, value) { a[key] = value; }
    export function get(key) { return a[key]; }`
  for (const optimize of [...levels(0, 2, 3), 'size']) {
    const wasm = jz(src, { optimize }).exports, ref = new Float64Array([3, 5])
    const at = (key) => { const i = +key | 0; return i >= 0 && i < ref.length ? ref[i] : undefined }
    for (const [key, value] of [['note', 'text'], ['note', undefined], ['01', 9], [0, '11'], ['1', 13], ['', false]]) {
      wasm.put(key, value)
      const i = +key | 0
      if (i >= 0 && i < ref.length) ref[i] = +value
      for (const key of ['note', '01', 0, 1, '', 'length'])
        is(wasm.get(key), at(key), `O${optimize}: stored ${key}`)
    }
  }
  const internal = `const a = new Float64Array([3, 5]);
    function put(key, value) { a[key] = value }
    function get(key) { return a[key] }
    export function probe() { put('note', 'text'); put('01', 9); put('1', 13); return [get('note'), get('01'), get('1'), get('0'), get('length')] }`
  for (const optimize of [...levels(0, 2, 3), 'size'])
    // '01' is not a canonical numeric string: an ordinary property on the typed array, like 'note'.
    is(jz(internal, { optimize }).exports.probe(), ['text', 9, 13, 3, 2], `O${optimize}: named keys through internal helpers`)
})

test('typed-array named slots survive aliases, views, deletion and reuse', () => {
  const src = `const base = new Int32Array([3, 5, 7]);
    const view = base.subarray(1); const empty = new Int32Array(0);
    export function f(key, mode) {
      const a = mode ? view : empty, alias = a;
      a[key] = { n: 4294967294 };
      const first = alias[key].n;
      alias[key] = undefined;
      const present = key in a;
      delete a[key];
      const absent = !(key in alias);
      alias[key] = 7n;
      return [first, present, absent, a[key], base[0], base[1], base[2]];
    }
    export function missing() {
      const a = new Int32Array(1); a.undefined = 'missing';
      const b = new Int32Array(0); const index = b[0];
      return [a[b[0]], a[index]];
    }`
  const expected = oracle(src)
  for (const optimize of [...levels(0, 2, 3), 'size']) {
    const wasm = jz(src, { optimize }).exports
    for (const mode of [0, 1, 1, 0])
      for (const key of ['label', '01', 'é', undefined, null, false, 'label'])
        is(wasm.f(key, mode), expected.f(key, mode), `O${optimize}: view=${mode}, ${key}`)
    is(wasm.missing(), ['missing', 'missing'], 'missing typed index retains its named key through a local')
  }
})

test('proven integer index locals retain element dispatch after nullable summaries', () => {
  const src = `export function f() {
    const indices = new Int32Array([0, 1, 2]), values = new Int32Array(3);
    for (let i = 0; i < indices.length; i++) { const k = indices[i]; values[k] = (values[k] + 1) | 0 }
    return values[2];
  }`
  for (const optimize of [2, 'size']) {
    is(jz(src, { optimize }).exports.f(), 1)
    ok(!compile(src, { optimize, wat: true }).includes('(func $__dyn_get'), 'present integer keys need no property runtime')
  }
})

test('typed-array dynamic reads retain BigInt and Number arithmetic domains', () => {
  const src = `export function f(key) {
    key = '' + key
    const a = new BigInt64Array([9221120245631025152n]);
    a.note = '4'; a.zero = 0;
    return [a[key], a[key] - a[key], -a[key], ~a[key]];
  }`
  const expected = oracle(src).f
  for (const optimize of [...levels(0, 2, 3), 'size']) {
    const { f } = jz(src, { optimize }).exports
    for (const key of [0, '0', 1, 'note', 'zero', undefined, null, 'absent'])
      is(f(key), expected(key), `O${optimize}: ${String(key)}`)
  }
})

test('typed-array missing numeric keys need no named-property lookup on closed arrays', () => {
  const src = `export function f() {
    const a = new Int32Array([17]), b = new Int32Array(0);
    const key = b[0];
    return [a[b[0]], a[key]];
  }`
  for (const optimize of [...levels(0, 2, 3), 'size']) {
    is(jz(src, { optimize }).exports.f(), [undefined, undefined])
    ok(!compile(src, { optimize, wat: true }).includes('(func $__dyn_get'), 'existing index presence checks suffice')
  }
})

test('typed-array reads parse indices without the numeric string-conversion runtime', () => {
  const src = `function make() { return new Float64Array([1.5, 2.5, 3.5]) }
    export function f(key) { key = '' + key; const a = make(); return a[key] }`
  const expected = oracle(src).f
  for (const optimize of [...levels(0, 2, 3), 'size']) {
    const { f } = jz(src, { optimize }).exports
    for (const key of [0, '0', '2', '3', '01', '-0', '-1', '1.5', '1e0', 'NaN', 'Infinity',
      '2147483647', '2147483648', '9007199254740993', 'length', 'byteLength', 'byteOffset', '', null, undefined])
      is(f(key), expected(key), `O${optimize}: ${String(key)}`)
    const wat = compile(src, { optimize, wat: true })
    ok(!wat.includes('$__typed_key_idx') && !wat.includes('$__to_num'), 'reads need only an integer-index parser')
  }
})

test('typed-array string keys share checked reads and preserve presence', () => {
  for (const ctor of ['Float64Array', 'BigInt64Array']) {
    const values = ctor === 'Float64Array' ? '3, NaN' : '9221120245631025152n, -1n'
    const src = `const base = new ${ctor}([${values}]);
      const views = [base, new ${ctor}(0), base.subarray(1)];
      export function f(key, mode) { const a = views[mode]; return [a[key], key in a] }`
    const expected = oracle(src).f
    for (const optimize of levels(0, 1, 2, 3, 'size')) {
      const { f } = jz(src, { optimize }).exports
      for (const mode of [0, 0, 1, 2, 0])
        for (const key of ['0', '0', '1', '2', '-0', '-1', '01', '0\0', '2147483647',
          '2147483648', '4294967294', 'length', '', '0'])
          is(f(key, mode), expected(key, mode), `${ctor}, O${optimize}: ${mode}/${key}`)
    }
    const wat = compile(src, { optimize: { level: 2, watr: false }, wat: true })
    const read = funcWat(wat, '__dyn_get_t_h'), has = funcWat(wat, '__dyn_get_t_hm')
    ok(read.includes('call $__typed_idx'), 'value lookup delegates to the checked element reader')
    is((read.match(/call \$__len\b/g) || []).length, 0, 'value lookup does not repeat the bounds check')
    is((has.match(/call \$__len\b/g) || []).length, 1, 'presence still checks the element bounds')
  }
})

test('computed typed-array accessors follow own properties on owned, empty and view receivers', () => {
  const src = `const base = new Float64Array([3, 5, 7]);
    const views = [base, base.subarray(1), new Float64Array(0), new DataView(base.buffer, 8, 8),
      base.subarray(base.length), new DataView(base.buffer, base.byteLength, 0)];
    export function read(key, mode) { const a = views[mode]; return [a[key], key in a] }
    export function shadow(key, mode) {
      const a = views[mode], inherited = a[key];
      Object.defineProperty(a, key, { value: 99, configurable: true, writable: true });
      const own = a[key];
      Object.defineProperty(a, key, { value: undefined, configurable: true, writable: true });
      const value = a[key], present = key in a;
      delete a[key];
      return [inherited, own, value, present, a[key], key in a];
    }`
  const expected = oracle(src)
  for (const optimize of [...levels(0, 2, 3), 'size']) {
    const wasm = jz(src, { optimize }).exports
    for (const mode of [0, 0, 1, 2, 3, 4, 5, 0])
      for (const key of ['length', 'byteLength', 'byteOffset', 'length\0', 'byteLength\0']) {
        is(wasm.read(key, mode), expected.read(key, mode), `O${optimize}: ${key}, receiver=${mode}`)
        is(wasm.shadow(key, mode), expected.shadow(key, mode), `O${optimize}: shadow/delete ${key}, receiver=${mode}`)
      }
  }
})

test('typed payload provenance preserves missing receivers through locals and aliases', () => {
  const src = `export function read(which, key) {
      key = '' + key
      const xs = [new Float64Array([7])]; const a = xs[which], alias = a;
      return alias[key];
    }
    export function value(which) {
      const xs = [new Float64Array([7])]; const a = xs[which]; return a;
    }
    export function hole(which, key) {
      key = '' + key
      const xs = new Array(2); xs[0] = new Float64Array([7]); const a = xs[which]; return a[key];
    }
    export function effects(which, key) {
      key = '' + key
      let calls = 0; const xs = [new Float64Array([7])];
      try { const a = xs[which]; a[(calls++, key)]; }
      catch (e) { return [calls, e.name]; }
      return [calls, 'ok'];
    }`
  const expected = oracle(src)
  for (const optimize of [0, 2, 3, 'size']) {
    const wasm = jz(src, { optimize }).exports
    for (const which of [0, 0, 1, -1, 0]) {
      is(wasm.value(which), expected.value(which), `O${optimize}: value ${which}`)
      for (const key of [0, '0', -1, '-1', 'length', 'absent']) {
        is(wasm.effects(which, key), expected.effects(which, key), `O${optimize}: key effects ${which}, ${key}`)
        for (const name of ['read', 'hole']) {
          if (which !== 0) throws(() => wasm[name](which, key), TypeError, `O${optimize}: ${name}(${which}, ${key})`)
          else is(wasm[name](which, key), expected[name](which, key), `O${optimize}: ${name}(${which}, ${key})`)
        }
      }
    }
  }
})

test('direct nullable receivers preserve values, holes and field/index failures', () => {
  for (const [value, access] of [['{ x: 7 }', '.x'], ['{ length: 7 }', '.length'],
    ['new Float64Array([7])', '[0]'], ['new Float64Array([7])', '.length'],
    ['new BigInt64Array([7n])', '[0]']]) {
    const src = `export function read(i) {
      const xs = [${value}, null, undefined]; const a = xs[i], alias = a;
      return alias${access};
    }
    export function hole(i) {
      const xs = new Array(2); xs[0] = ${value}; const a = xs[i]; return a${access};
    }
    export function value(i) { const xs = [${value}]; const a = xs[i]; return a; }`
    const expected = oracle(src)
    for (const optimize of [0, 2, 3, 'size']) {
      const wasm = jz(src, { optimize }).exports
      for (const i of [0, 0, 1, 2, 3, -1, 0]) {
        is(wasm.value(i), expected.value(i), `O${optimize}: ${value}, value(${i})`)
        for (const name of ['read', 'hole']) {
          if (i === 0) is(wasm[name](i), expected[name](i), `O${optimize}: ${value}${access}`)
          else throws(() => wasm[name](i), TypeError, `O${optimize}: ${value}${access}, ${name}(${i})`)
        }
      }
    }
  }
})

test('nullable index guards retain the receiver and defer object-key conversion', () => {
  const src = `export function f(empty) {
    let events = 0, a = empty ? undefined : new Float64Array([7]);
    const key = { toString() { events = events * 10 + 3; return '0'; } };
    try {
      const result = a[(events = events * 10 + 1, a = new Float64Array([9]), events = events * 10 + 2, key)];
      return [result, events];
    } catch (e) { return [e.name, events]; }
  }`
  const expected = oracle(src).f
  for (const optimize of [0, 2, 3, 'size']) {
    const { f } = jz(src, { optimize }).exports
    for (const empty of [0, 0, 1, 1, 0]) is(f(empty), expected(empty), `O${optimize}: empty=${empty}`)
  }
})

test('nullable typed stores preserve assignment values and reject missing receivers', () => {
  for (const ctor of ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
    'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array']) {
    const big = ctor.startsWith('Big'), initial = big ? '3n' : '3', value = big ? '7n' : '7'
    const src = `export function f(which, key) {
      const base = new ${ctor}([${initial}, ${initial}]);
      const xs = [base, new ${ctor}(0), null, undefined, base.subarray(1)];
      const a = xs[which], index = key | 0;
      try { const assigned = (a[index] = ${value}); return [assigned, a[0], base[0], base[1]]; }
      catch (e) { return e.name; }
    }
    export function direct(which) {
      const a = [new ${ctor}([${initial}])][which];
      try { const assigned = (a[0] = ${value}); return [assigned, a[0]]; }
      catch (e) { return e.name; }
    }
    export function store(which) {
      const xs = [new ${ctor}([${initial}])], a = xs[which];
      a[0] = ${value}; return a[0];
    }`
    const expected = oracle(src).f
    for (const optimize of [0, 2, 3, 'size']) {
      const { f, direct, store } = jz(src, { optimize }).exports
      const directExpected = oracle(src).direct
      for (const which of [0, 0, 1, -1, 0])
        is(direct(which), directExpected(which), `O${optimize}: ${ctor}, direct receiver=${which}`)
      is(store(0), big ? 7n : 7, `O${optimize}: ${ctor}, known constructor`)
      throws(() => store(1), TypeError, `O${optimize}: ${ctor}, absent receiver`)
      is(store(0), big ? 7n : 7, `O${optimize}: ${ctor}, reuse after throw`)
      for (const which of [0, 0, 1, 2, 3, 4, 5, -1, 0])
        for (const key of [0, 1, 2, -1, 0])
          is(f(which, key), expected(which, key), `O${optimize}: ${ctor}, receiver=${which}, index=${key}`)
    }
  }
})

test('nullable typed stores capture the reference and evaluate RHS before rejecting it', () => {
  const src = `export function f(which, fail) {
    const original = new Float64Array([3]), replacement = new Float64Array([5]);
    let a = [original, null, undefined][which], events = 0;
    function rhs() { events = events * 10 + 2; if (fail) throw new RangeError('rhs'); return 7; }
    try {
      const assigned = a[(events = events * 10 + 1, a = replacement, 0)] = rhs();
      return [assigned, events, original[0], replacement[0]];
    } catch (e) { return [e.name, events, original[0], replacement[0]]; }
  }`
  const expected = oracle(src).f
  for (const optimize of [0, 2, 3, 'size']) {
    const { f } = jz(src, { optimize }).exports
    for (const which of [0, 0, 1, 2, 3, -1, 0])
      for (const fail of [0, 1, 0]) is(f(which, fail), expected(which, fail), `O${optimize}: ${which}, throw=${fail}`)
  }
})

test('runtime typed stores reject a missing receiver before value coercion', () => {
  for (const ctor of ['Float64Array', 'Float32Array', 'Uint8Array']) {
    const src = `export function f(which) {
      let events = 0; const a = [new ${ctor}([3]), new ${ctor}(0), null, undefined][which];
      function rhs() { events = events * 10 + 2; return { valueOf() { events = events * 10 + 3; return 7; } }; }
      try { a[(events = events * 10 + 1, 0)] = rhs(); return [events, a[0]]; }
      catch (e) { return [events, e.name]; }
    }`
    const expected = oracle(src).f
    for (const optimize of [0, 2, 3, 'size']) {
      const { f } = jz(src, { optimize }).exports
      for (const which of [0, 0, 1, 2, 3, 4, -1, 0]) is(f(which), expected(which), `O${optimize}: ${ctor}, receiver=${which}`)
    }
  }
})

test('nullable BigInt fields retain raw and boxed payloads through catch and optional reads', () => {
  for (const value of ['0n', '7n', '-7n', '9223372036854775807n', '-9223372036854775808n',
    '0x7ff8000200000000n', '0x7ffa800000000008n']) {
    for (const written of ['', `item.x = ${value};`]) {
      const src = `export function f(i) {
        const item = { x: ${value} }; ${written} const a = [item][i];
        try { const alias = a; return [a.x, alias['x'], a?.x]; } catch (e) { return e.name; }
      }
      export function direct(i) { const a = [{ x: ${value} }][i]; try { return a.x; } catch (e) { return e.name; } }
      export function expression(i) { try { return ([{ x: ${value} }][i]).x; } catch (e) { return e.name; } }
      export function optional(i) { const a = [{ x: ${value} }][i]; return a?.x; }`
      const expected = oracle(src)
      for (const optimize of [0, 2, 3, 'size']) {
        const wasm = jz(src, { optimize }).exports
        for (const name of ['f', 'direct', 'expression', 'optional'])
          for (const i of [0, 0, 1, -1, 0]) is(wasm[name](i), expected[name](i), `O${optimize}: ${name}, ${value}, i=${i}, write=${!!written}`)
      }
    }
  }
})

test('dynamic typed assignment results keep their tagged BigInt carrier', () => {
  const src = `export function f(i, key) {
    key = '' + key
    const a = [new BigInt64Array([3n])][i];
    try { const assigned = (a[key] = 7n); return [assigned, a[0]]; } catch (e) { return e.name; }
  }`
  const expected = oracle(src).f
  for (const optimize of [0, 2, 3, 'size']) {
    const { f } = jz(src, { optimize }).exports
    for (const i of [0, 0, 1, -1, 0])
      for (const key of [0, 1, -1, '0', 'label', '1.5']) is(f(i, key), expected(i, key), `O${optimize}: i=${i}, key=${key}`)
  }
})

test('expression field stores retain schema carriers and the original receiver', () => {
  for (const value of ['8n', '-9223372036854775808n', '0x7ffa800000000008n']) {
    const src = `export function direct(i) {
      const xs = [{ x: 7n }]; xs[0].x = ${value}; const a = xs[i];
      try { return a.x; } catch (e) { return e.name; }
    }
    export function effects(i) {
      let events = 0; const original = { x: 7n }, replacement = { x: 9n };
      const xs = [original, null, undefined];
      function rhs() { events++; xs[0] = replacement; return ${value}; }
      try { const assigned = (xs[i].x = rhs()); return [assigned, original.x, replacement.x, events]; }
      catch (e) { return [e.name, original.x, replacement.x, events]; }
    }
    export function bracket(i) {
      const xs = [{ x: 7n }]; xs[0]['x'] = ${value};
      try { return xs[i]['x']; } catch (e) { return e.name; }
    }`
    const expected = oracle(src)
    for (const optimize of [0, 2, 3, 'size']) {
      const wasm = jz(src, { optimize }).exports
      for (const name of ['direct', 'effects', 'bracket'])
        for (const i of [0, 0, 1, 2, 3, -1, 0]) is(wasm[name](i), expected[name](i), `O${optimize}: ${name}, ${value}, i=${i}`)
    }
  }
})

test('nullable typed reads keep missing elements distinct from numeric conversion', () => {
  for (const ctor of ['Float64Array', 'BigInt64Array']) {
    const src = `export function f(i, k) {
      const xs = [new ${ctor}([${ctor === 'BigInt64Array' ? '7n' : '7'}])]; const a = xs[i];
      return [a[0], a[-1], a[k]${ctor === 'Float64Array' ? ', a[k] - a[k]' : ''}];
    }`
    const expected = oracle(src).f
    for (const optimize of [0, 2, 3, 'size']) {
      const { f } = jz(src, { optimize }).exports
      for (const k of [0, 1, -1, 0]) {
        is(f(0, k), expected(0, k), `O${optimize}: ${ctor}, k=${k}`)
        throws(() => f(1, k), TypeError, `O${optimize}: ${ctor}, absent receiver`)
      }
    }
  }
})

test('nullable compound references throw before key coercion and the RHS', () => {
  const src = `export function f(empty) {
    let events = 0; const a = empty ? undefined : new Float64Array([7]);
    const key = { toString() { events = events * 10 + 2; return '0'; } };
    try {
      a[(events = events * 10 + 1, key)] += (events = events * 10 + 3, 2);
      return [events, a[0]];
    } catch (e) { return [events, e.name]; }
  }`
  // GetValue stores the converted key in the Reference (ECMA-262 6.2.5.5).
  // Node 25 converts it twice; test/to-primitive.js pins this divergence too.
  for (const optimize of [0, 2, 3, 'size']) {
    const { f } = jz(src, { optimize }).exports
    for (const empty of [0, 0, 1, 1, 0])
      is(f(empty), empty ? [1, 'TypeError'] : [123, 9], `O${optimize}: empty=${empty}`)
  }
})

test('compound writes retain the converted key through PutValue', () => {
  for (const op of ['+= 2', '++']) {
    const src = `export function f() {
      let calls = 0; const o = { x: 7, y: 100 };
      const key = { toString() { return ++calls === 1 ? 'x' : 'y'; } };
      const result = o[key] ${op}; return [result, o.x, o.y, calls];
    }`
    const expected = oracle(src.replace('const result = o[key]', 'const prop = String(key); const result = o[prop]')).f
    for (const optimize of [0, 2, 3, 'size']) {
      const { f } = jz(src, { optimize }).exports
      is(f(), expected(), `O${optimize}: ${op}`)
      is(f(), expected(), `O${optimize}: repeated ${op}`)
    }
  }
})

test('nullable receiver unions preserve non-number assignment keys', () => {
  for (const key of ['true', "({ toString() { return '0'; } })"]) {
    const src = `export function f(empty) {
      const a = empty ? undefined : new Float64Array([7]);
      try { const assigned = a[${key}] = 9; return [assigned, a[${key}], a[0]]; }
      catch (e) { return e.name; }
    }`
    const expected = oracle(src).f
    for (const optimize of [0, 2, 3, 'size']) {
      const { f } = jz(src, { optimize }).exports
      for (const empty of [0, 0, 1, 1, 0]) is(f(empty), expected(empty), `O${optimize}: ${key}, empty=${empty}`)
    }
  }
})

test('loop versioning does not inspect absent buffers on zero-work calls', () => {
  const src = `let p;
    export function init() { p = new Float64Array([2, 3, 4]); }
    export function sum(n) { let s = 0; for (let i = 0; i < n; i++) s += p[i]; return s; }
    export function nested(n) {
      let s = 0; for (let j = 0; j < n; j++) for (let i = 0; i < p.length; i++) s += p[i]; return s;
    }`
  for (const optimize of [0, 2, 3, 'size']) {
    const wasm = jz(src, { optimize }).exports, expected = oracle(src)
    for (const name of ['sum', 'nested']) {
      for (const n of [0, 0, -1, 1, 0]) {
        if (n > 0) throws(() => wasm[name](n), TypeError, `O${optimize}: ${name} before init`)
        else is(wasm[name](n), expected[name](n), `O${optimize}: ${name} zero work`)
      }
    }
    wasm.init(); expected.init()
    for (const name of ['sum', 'nested']) for (const n of [0, 1, 3, 0, 3])
      is(wasm[name](n), expected[name](n), `O${optimize}: ${name} after init`)
  }
})

test('loop receiver presence does not prove unrelated index bounds', () => {
  const src = `let a;
    export function init() { a = new Float64Array([2, 3, 4, 5]); }
    export function sum(n, k) {
      let s = 0; for (let i = 0; i < n; i++) { s += a[i & 3]; s += a[k]; } return s;
    }`
  for (const optimize of [0, 2, 3, 'size']) {
    const wasm = jz(src, { optimize }).exports, expected = oracle(src)
    is(wasm.sum(0, 100), 0)
    throws(() => wasm.sum(1, 0), TypeError)
    is(wasm.sum(0, 0), 0)
    wasm.init(); expected.init()
    for (const k of [0, 0, 3, 4, -1, 100, 0])
      is(wasm.sum(4, k), expected.sum(4, k), `O${optimize}: index ${k}`)
  }
})

test('loop guards reject buffer replacement through helper calls', () => {
  for (const replacement of ['undefined', 'null', 'new Float64Array([7])']) {
    const src = `let a;
      export function init() { a = new Float64Array([2, 3, 4, 5]); }
      function change(k) { if (k) a = ${replacement}; else a = new Float64Array(2); }
      function forward(k) { change(k); }
      export function sum(n) {
        let s = 0; for (let i = 0; i < n; i++) {
          s += a[i & 3]; if (i === 0) forward(1); s += a[(i + 1) & 3];
        } return s;
      }`
    for (const optimize of [0, 2, 3, 'size', { level: 2, sourceInline: false }, { level: 3, sourceInline: false }]) {
      const wasm = jz(src, { optimize }).exports, expected = oracle(src)
      for (let run = 0; run < 2; run++) {
        is(wasm.sum(0), 0)
        wasm.init(); expected.init()
        if (replacement.startsWith('new')) is(wasm.sum(2), expected.sum(2))
        else throws(() => wasm.sum(2), TypeError, `${JSON.stringify(optimize)}: ${replacement}`)
        is(wasm.sum(0), 0)
      }
    }
  }
})

test('loop guards account for Math argument coercion and captured receivers', () => {
  const sources = [
    `let a; export function init() { a = new Float64Array([2, 3, 4, 5]); }
     export function sum(n) {
       const k = { valueOf() { a = undefined; return 0; } };
       let s = 0; for (let i = 0; i < n; i++) { s += a[i & 3]; Math.abs(k); s += a[(i + 1) & 3]; } return s;
     }`,
    `export function init() {}
     export function sum(n) {
       let a = new Float64Array([2, 3, 4, 5]); const clear = () => { a = undefined; };
       let s = 0; for (let i = 0; i < n; i++) { s += a[i & 3]; clear(); s += a[(i + 1) & 3]; } return s;
     }`,
  ]
  for (const src of sources) for (const optimize of [0, 2, 3, 'size', { level: 3, sourceInline: false }]) {
    const wasm = jz(src, { optimize }).exports
    for (let run = 0; run < 2; run++) {
      wasm.init(); is(wasm.sum(0), 0)
      throws(() => wasm.sum(1), TypeError, JSON.stringify(optimize))
    }
  }
})

test('loop guards include helper defaults and loop-header writes', () => {
  for (const loop of [
    'for (let i = 0; i < n; i++) { s += a[i]; forward(); s += a[i + 1]; }',
    'for (let i = 0; i < n; i++, change()) s += a[i];',
    'for (let i = 0; i < n && (i === 0 || change()); i++) s += a[i];',
  ]) {
    const src = `let a;
      export function init() { a = new Float64Array([2, 3, 4, 5]); }
      function change() { a = undefined; return true; }
      function forward(k = change()) { return k; }
      export function sum(n) { let s = 0; ${loop} return s; }`
    for (const optimize of [0, 2, 3, { level: 3, sourceInline: false }]) {
      const wasm = jz(src, { optimize }).exports
      is(wasm.sum(0), 0)
      wasm.init(); throws(() => wasm.sum(2), TypeError)
      is(wasm.sum(0), 0)
    }
  }
})

test('loop guards reject changes to bounds, offsets and duplicate cursor steps', () => {
  const sources = [
    `let off = 0; function move() { off = 10; }
     export function sum(n) {
       off = 0; const a = new Float64Array([2, 3, 4, 5]); let s = 0;
       for (let i = 0; i < n; i++) { s += a[i + off]; move(); } return s;
     }`,
    ...['limit', 'limit + 1'].map(bound => `let limit = 0; function move() { limit = 5; }
     export function sum(n) {
       limit = n; const a = new Float64Array([2, 3, 4]); let s = 0;
       for (let i = 0; i < ${bound}; i++) { s += a[i]; move(); } return s;
     }`),
    `export function sum(n) {
       const a = new Float64Array([2, 3, 4]); let s = 0;
       for (let i = 0, k = 0; i < n; i++, k += 1, k += 1) s += a[k]; return s;
     }`,
  ]
  for (const src of sources) for (const optimize of [0, 2, 3, { level: 2, sourceInline: false }, { level: 3, sourceInline: false }]) {
    const wasm = jz(src, { optimize }).exports, expected = oracle(src)
    for (const n of [0, 0, 1, 2, 3, 0]) is(wasm.sum(n), expected.sum(n), JSON.stringify(optimize))
  }
})

test('cursor guards require an existing local whose writes stay in the body budget', () => {
  const sources = [
    ...['let', 'const'].map(decl => `function scan(a, indices, n) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        let t = 0;
        while (t < 2) { ${decl} c = indices[t]; s += a[c]; t++; }
      }
      return s;
    }
    export function run(n, last) {
      return scan(new Float64Array([7]), new Int32Array([0, last]), n);
    }`),
    `function scan(a, n) {
      let c = 0, s = 0;
      for (let i = 0; i < n && (c += 2) > 0; i++) s += a[c];
      return s;
    }
    export function run(n, last) { return scan(new Float64Array([7, 11, last]), n); }`,
    `let c = 0;
    function move() { c += 2; }
    function scan(a, n) {
      c = 0; let s = 0;
      for (let i = 0; i < n; i++) { move(); s += a[c]; }
      return s;
    }
    export function run(n, last) { return scan(new Float64Array([7, 11, last]), n); }`,
    `function scan(a, n) {
      let c = 0, s = 0;
      const move = () => { c += 2; };
      for (let i = 0; i < n; i++) { move(); s += a[c]; }
      return s;
    }
    export function run(n, last) { return scan(new Float64Array([7, 11, last]), n); }`,
  ]
  for (const src of sources) {
    const expected = oracle(src).run
    for (const optimize of levels(0, 2, 3, 'size', { level: 3, sourceInline: false })) {
      const { run } = jz(src, { optimize }).exports
      for (const [n, last] of [[0, 3], [1, 0], [1, 0], [1, 3], [2, -1], [3, 9], [0, 0]])
        is(run(n, last), expected(n, last), `O${JSON.stringify(optimize)}: ${n}/${last}`)
    }
  }
})

test('cached typed loads preserve absence separately from numeric arithmetic', () => {
  const src = `export function f(n) {
    const a = new Float64Array(n), value = a[0];
    return [value, value - value, value + 1];
  }`
  const expected = oracle(src).f
  for (const optimize of [...levels(0, 2, 3), 'size']) {
    const { f } = jz(src, { optimize }).exports
    for (const n of [0, 0, 1, 0, 1]) is(f(n), expected(n), `O${optimize}: n=${n}`)
  }
})

test('numeric local storage publishes the converted value kind', () => {
  const src = `export function f(n, positive) {
    const a = new Uint8Array(n);
    let r = 0, x = 7;
    if (positive) { const d = a[r++]; x = positive ? x + d : x - d }
    return x;
  }`
  const expected = oracle(src).f
  for (const optimize of [...levels(0, 2, 3), 'size']) {
    const { f } = jz(src, { optimize }).exports
    for (const n of [0, 1]) for (const positive of [0, 1])
      is(f(n, positive), expected(n, positive), `O${optimize}: n=${n}, positive=${positive}`)
    ok(!compile(src, { optimize, wat: true }).includes('(func $__str_concat'), 'numeric storage cannot concatenate')
  }
})

test('load reuse separates numeric conversion from raw typed-element identity', () => {
  for (const [ctor, values] of [['Float64Array', '2, 3'], ['BigInt64Array', '2n, 3n']]) {
    // Global receivers enter the load census before emission; the former
    // local-array fixture passed even when source load reuse was broken.
    const src = `const a = new ${ctor}([${values}]);
    export function f(i) {
      i |= 0;
      const first = a[i], difference = a[i] - a[i], last = a[i];
      const neg = -a[i], bits = ~a[i];
      let sum; sum = a[i] + a[i];
      return [first, difference, last, neg, bits, sum];
    }`
    const expected = oracle(src).f
    for (const optimize of [...levels(0, 2, 3), 'size', { level: 3, loadCSE: false }]) {
      const { f } = jz(src, { optimize }).exports
      for (const i of [2, 2, 0, 1, -1, 2, 0]) is(f(i), expected(i), `${ctor}, O${optimize}: i=${i}`)
    }
    if (ctor === 'Float64Array') {
      // valueNumber off: the WAT-level pass reuses these loads too, and the pin is the compile-level pass's own.
      const loads = loadCSE => (compile(src, { optimize: { level: 3, loadCSE, valueNumber: false }, wat: true }).match(/f64\.load/g) || []).length
      ok(loads(true) < loads(false), 'the regression exercises load reuse')
    }
  }
})

test('typed-array named slots can refer back to the receiver', () => {
  const src = `export function f() {
    const a = new Int32Array([9]); a.self = a;
    a.box = { inner: a }; a.box.inner.note = 17;
    return [a.self.note, a.self[0]];
  }`
  for (const optimize of [...levels(0, 2, 3), 'size'])
    is(jz(src, { optimize }).exports.f(), [17, 9])
})

test('typed-array numeric string membership works without element reads or writes', () => {
  const src = `export function f(key) { const a = new Int32Array(2); return key in a }`
  const expected = oracle(src).f
  for (const optimize of [...levels(0, 2, 3), 'size']) {
    const { f } = jz(src, { optimize }).exports
    for (const key of ['0', '1', '2', '-0', '01', 'NaN', '', 0, 2, undefined])
      is(f(key), expected(key), `O${optimize}: ${key}`)
  }
})

test('typed-array dynamic index stores respect empty and nonempty view boundaries', () => {
  const src = `export function f(key, end) {
    key = '' + key
    const base = new Int32Array([3, 5, 7]); const a = base.subarray(1, end);
    a[key] = 17;
    return [base[0], base[1], base[2], a.length];
  }`
  const expected = oracle(src).f
  for (const optimize of [...levels(0, 2, 3), 'size']) {
    const { f } = jz(src, { optimize }).exports
    for (const end of [1, 2])
      for (const key of [-2, -1, 0, 1, 2, '-2', '-1', '0', '1', '2', '1.5', 'NaN', 'label'])
        is(f(key, end), expected(key, end), `O${optimize}: ${key}, end=${end}`)
  }
})

test('typed-array invalid numeric keys still convert the RHS; named keys do not', () => {
  const src = `export function f(key) {
    key = '' + key
    const a = new BigInt64Array(1);
    try { a[key] = 4; return a[key] } catch (e) { return e.name }
  }
  export function g(key) {
    key = '' + key
    const a = new Int32Array(1);
    try { a[key] = 4n; return a[key] } catch (e) { return e.name }
  }`
  const expected = oracle(src)
  for (const optimize of [...levels(0, 2, 3), 'size']) {
    const wasm = jz(src, { optimize }).exports
    for (const key of ['label', '01', '0', '-0', '-2', 'NaN', 0, -2, 1.5, Infinity])
      for (const name of ['f', 'g']) is(wasm[name](key), expected[name](key), `O${optimize}: ${name}(${key})`)
  }
})

test('polymorphic indexed stores convert before bounds and preserve assignment values', () => {
  const src = `export function f(kind, n, value) {
    const a = kind ? new Int32Array(n) : [];
    const result = a[0] = value;
    return [result, a[0], a.length];
  }
  export function g(kind, n) {
    const a = kind ? new Int32Array(n) : [];
    try { a[0] = 7n; return a[0] } catch (e) { return e.name }
  }`
  const expected = oracle(src)
  for (const optimize of [...levels(0, 2, 3), 'size']) {
    const wasm = jz(src, { optimize }).exports
    const scalar = jz(src.slice(0, src.indexOf('export function g')), { optimize }).exports
    for (const kind of [0, 1]) for (const n of [0, 1]) {
      for (const value of ['17', true, null, undefined, 4294967294]) {
        is(wasm.f(kind, n, value), expected.f(kind, n, value), `O${optimize}: kind=${kind}, n=${n}, value=${value}`)
        is(scalar.f(kind, n, value), expected.f(kind, n, value), `O${optimize}: same conversion without BigInt support`)
      }
      is(wasm.g(kind, n), expected.g(kind, n), `O${optimize}: kind=${kind}, n=${n}, BigInt`)
    }
  }
})

test('typed stores retain a global receiver across direct and called RHS writes', () => {
  const src = `let a;
    function replace() { a = new Int32Array([7, 9]); return 11 }
    export function f(called) {
      a = new Int32Array([3, 5]); const original = a;
      if (called) a[0] = replace();
      else a[0] = (a = new Int32Array([7, 9]), 11);
      return [original[0], original[1], a[0], a[1]];
    }`
  const expected = oracle(src).f
  for (const optimize of [...levels(0, 2, 3), 'size']) {
    const { f } = jz(src, { optimize }).exports
    for (const called of [0, 0, 1, 0, 1]) is(f(called), expected(called), `O${optimize}: called=${called}`)
  }
})

test('typed-array dynamic stores preserve the reference before RHS effects', () => {
  const src = `export function f(key) {
    let a = new Int32Array([3, 5]); const original = a;
    a[key] = (a = new Int32Array([7, 9]), key = 'label', 11);
    return [original[0], original[1], original.label, a[0], a[1], a.label];
  }
  export function g(key) {
    const a = new Int32Array([3, 5]); let calls = 0;
    function rhs() { calls++; key = 'label'; return 13; }
    a[key] = rhs();
    return [a[0], a[1], a.label, calls];
  }
  export function h(key) {
    let a = new Int32Array([3, 5]); const original = a;
    a[(a = new Int32Array([7, 9]), key)] = 11;
    return [original[0], original[1], original.label, a[0], a[1], a.label];
  }`
  const expected = oracle(src)
  for (const optimize of [...levels(0, 2, 3), 'size']) {
    const wasm = jz(src, { optimize }).exports
    for (const key of [0, 1, 'label', '01', undefined])
      for (const name of ['f', 'g', 'h']) is(wasm[name](key), expected[name](key), `O${optimize}: ${name}(${key})`)
  }
})

test('schema lookup preserves content equality and slot lifetime for every key form', () => {
  const fields = { '': 1, a: 2, abcdef: 3, abcdefg: 4, é: 5, '😀': 6, 'a\0b': 7, secondLong: 8 }
  const src = `export function f(k, json) {
    if (typeof k === 'number') k = ['abcdefg', 'secondLong', 'absentLong'][k];
    const o = json ? JSON.parse(json) : ${JSON.stringify(fields)};
    let s = '' + o[k] + ':' + (k in o);
    o[k] = undefined; s += '|' + o[k] + ':' + (k in o);
    delete o[k]; s += '|' + o[k] + ':' + (k in o);
    o[k] = 9; return s + '|' + o[k] + ':' + (k in o) + '|' + Object.keys(o).length;
  }`
  const expected = oracle(src).f
  for (const optimize of [...levels(0, 2, 3), 'size']) {
    const { f } = jz(src, { optimize }).exports
    for (const json of ['', '{}', JSON.stringify(fields)])
      for (const key of [...Object.keys(fields), 'absent', 'abcdefX', 'abcdeg', '', 0, 1, 2]) {
        is(f(key, json), expected(key, json), `${optimize}: ${JSON.stringify(key)} on ${json || 'static schema'}`)
        is(f(key, json), expected(key, json), 'repeated call retains equality and presence')
      }
  }
})

test('Map value analysis follows aliases and calls without leaking between compiles', () => {
  for (const value of ['7', '"seven"', '7n']) {
    const src = `const m = new Map(); const alias = m;
      const put = (target, value) => target.set('x', value);
      export const f = n => { if (n) put(alias, ${value}); else m.delete('x'); return m.get('x') }`
    const js = oracle(src).f
    for (const optimize of levels(0, 2, 3)) {
      const f = jz(src, {optimize}).exports.f
      for (const n of [0, 1, 1, 0, 1]) is(f(n), js(n), `${value}: O${optimize}, n=${n}`)
    }
  }
})

test('static global initializers retain schemas at the host boundary', () => {
  for (const value of ['{a:7,b:undefined,c:null}', '{inner:{value:7}}', '[{value:7}]']) {
    const expected = Function(`return ${value}`)()
    for (const optimize of [0, 1, 'fast', {level:2,watr:false}, 2, 3]) {
      const f = jz(`const o = ${value}; export const f = () => o`, {optimize}).exports.f
      is(f(), expected, `${JSON.stringify(optimize)}: ${value}`)
      is(f(), expected, 'the hoisted value remains decodable on repeated calls')
    }
  }
})

test('dyn-keys: deletion invalidates static presence and enumeration through aliases', () => {
  for (const rewrite of ['', 'alias.a = undefined;', 'alias.a = 9;']) {
    const src = `const o = {a:1,b:2}; const alias = o; let k = 'a';
      delete o[k]; ${rewrite} let keys = ''; for (const p in o) keys += p;
      return ['a' in o, Object.hasOwn(o, 'a'), Object.keys(o).length,
        Object.values(o).length, Object.entries(o).length, keys.includes('a'), o.a]`
    const expected = Function(src)()
    for (const optimize of levels(0, 2, 3)) {
      const f = jz('export let f = () => {' + src + '}', {optimize}).exports.f
      is(f(), expected, `O${optimize}: ${rewrite || 'deleted'}`)
      is(f(), expected, 'a fresh invocation does not inherit object mutations')
    }
  }
})

test('dyn-keys: direct-write dict, present + missing keys', () => {
  is(run(`const d = {}; d['a'] = 1; return d['a']`), 1)
  is(run(`const d = {}; d['a'] = 1; return d['zz'] === undefined ? 1 : 0`), 1)
  is(run(`const d = {}; d['a'] = 1; return d['undefined'] === undefined ? 1 : 0`), 1)
})

test('dyn-keys: loop-built dict (element-sourced keys) — the trap class', () => {
  is(run(`const d = {}; const ks = ['a','b']; for (let i = 0; i < ks.length; i++) d[ks[i]] = i; return d['zz'] === undefined ? 1 : 0`), 1)
  is(run(`const d = {}; const ks = ['a','b']; for (let i = 0; i < ks.length; i++) d[ks[i]] = i; return d['b']`), 1)
  is(run(`const d = {}; const ks = ['if','for','while','x','y','(','{',':']; for (let i = 0; i < ks.length; i++) d[ks[i]] = i + 1; return (d['undefined'] === undefined ? 10 : 20) + (d['('] === 6 ? 1 : 2)`), 11)
})

test('dyn-keys: histogram RMW stays lean-eligible (the fused read is not a plain read)', () => {
  is(run(`const d = {}; const ks = ['a','b','a']; for (let i = 0; i < ks.length; i++) d[ks[i]] = (d[ks[i]] | 0) + 1; return (d['a'] | 0) * 10 + (d['b'] | 0)`), 21)
})

test('dictionary slot updates hash every string representation after key normalization', () => {
  const keys = `['', '0', 'a', 'abcdef', 'abcdefg', 'Ā🙂', 'long heap ' + n, ('prefix-tail-' + n).slice(7)]`
  for (const mode of ['fixed', 'growing', 'escaping']) {
    const src = `function count(keys,n){const d={};for(let i=0;i<n;i++){
      ${mode === 'growing' ? "keys.push('new-' + i);" : ''}
      const k=keys[i%keys.length];d[k]=(d[k]|0)+1
    }${mode === 'escaping' ? 'return d' : 'let s=0;for(let j=0;j<keys.length;j++)s=(Math.imul(s,31)+(d[keys[j]]|0))|0;return s'}}
    export function f(n){return count(${keys},n)}`
    const probe = mode === 'fixed' ? '__hash_slot_eph_fixed' : mode === 'growing' ? '__hash_slot_eph' : '__hash_slot'
    ok(new RegExp(`call \\$${probe}\\s`).test(compile(src, { wat: true, optimize: { level: 'speed', watr: false } })), `${mode}: exercises its slot probe`)
    const expected = oracle(src).f
    for (const optimize of levels(0, 2, 3, 'size')) {
      const { f } = jz(src, { optimize }).exports
      for (const n of [0, 1, 1, 17, 80, 0, 3]) is(f(n), expected(n), `${mode}, O${optimize}, n=${n}`)
    }
  }
})

test('dyn-keys: atom-vs-NaN key split (index contract preserved)', () => {
  // Real NaN keeps the documented i32-truncating index contract (a[NaN] → a[0]);
  // only ATOM boxes (undefined/null) stringify. The first ToPropertyKey arm
  // used f64.eq(k,k), which lumped real NaN in with the atoms and broke the
  // contract pin in array-methods.
  is(run(`const a = [11, 22]; const k = 0/0; return a[k]`), 11)
  is(run(`const d = {}; d['undefined'] = 7; const u = [, 1][0]; return d[u]`), 7)
})

test('dyn-keys: ToPropertyKey for atom keys (the prec[undefined] class)', () => {
  // V8 truth 2112: prec[undefined] reads key "undefined" — never index 0.
  is(run(`const prec = {}
    const keys = ['if', 'for', 'while', 'x', 'y', '(', '{', ':']
    for (let i = 0; i < keys.length; i++) prec[keys[i]] = i + 1
    const hole = [, 'k']
    const u = hole[0]
    return (prec[u] <= 5 ? 1000 : 2000) + (prec['('] === 6 ? 100 : 200) + (prec[u] === undefined ? 10 : 20) + (prec['nope'] <= 5 ? 1 : 2)`), 2112)
  is(run(`const d = {}; d['null'] = 8; return d[null]`), 8)
  // Dynamic booleans use ToPropertyKey just like static boolean keys.
  is(run(`const d = {}; d['true'] = 9; return d[true]`), 9)
  is(run(`const d = {}; d['true'] = 9; return d[true] === undefined ? 1 : 0`), 0)
  is(jz(`export let f = (b) => { const d = {}; d['true'] = 9; return d[b > 0] === undefined ? 1 : 0 }`).exports.f(1), 0)
})

// dyn-prop KEYING on a NUMERIC (non-string) key against an OBJECT receiver
// whose static type is fully unknown — repro A + sweep siblings, ledger
// 2026-07-29. Root: module/array.js's generic `arr[i]` fallback ("Unknown ->
// runtime dispatch") assumed a numeric key on an unproven receiver is always
// ARRAY/TYPED access, routing straight to __typed_idx — sound for ARRAY/TYPED,
// but __typed_idx has no object-property lookup: an
// empty-schema OBJECT with a literal-string-key write (`o={}; o['1']=9` — a
// LITERAL key, invisible to dynWriteVars, so `o` never qualifies as dict-mode
// HASH) silently read undefined instead of the stored value for ANY numeric
// key reached at runtime. First fixed ONLY on the runtime-is_str_key-dispatched
// arm (key kind ALSO unproven, not just the receiver); the sibling
// PROVEN-NUMBER-key fallback (last case below) was left unsound to protect a
// NAMED perf pin (test/perf.js "codegen: unknown-receiver index with NUMBER
// key skips __is_str_key dispatch") for the dominant `a[loopCounter]` hot-loop
// shape. Re-audit #5 finding #1 (2026-07-30) closed that gap too: selection
// between the typed-indexed read and the dyn-props read now depends on the
// RECEIVER pointer-kind (one tag test), not the key kind — the perf pin was
// rewritten to assert the guard shape instead of zero dispatch.
// `j` is a PARAMETER and `o`/`nums` are MODULE-LEVEL globals throughout (not
// jzify'd/wrapped locals) — load-bearing: a local `nums` can let `nums[j]`'s
// element kind get proven NUMBER, which exercises the SAME now-fixed
// receiver-kind guard rather than a different code path.
test('dyn-keys: numeric key on an unknown-type OBJECT receiver resolves through dyn-props', () => {
  // repro A: numeric key sourced from an array read (key kind unproven at the
  // outer `o[...]` site — is_str_key dispatch survives), receiver `o` has no
  // static val type (empty `{}`, literal-key-only writes).
  is(jz(`const o = {}; o['1'] = 9
    let nums = []; nums.push(1)
    export let f = (j) => o[nums[j]] | 0`).exports.f(0), 9)
  // WRITE-side sibling: a numeric key WRITE on the same shape (o[nums[j]]=v)
  // must land where the matching literal-key READ finds it.
  is(jz(`const o = {}
    let nums = []; nums.push(1)
    export let f = (j) => { o[nums[j]] = 5; return o['1'] | 0 }`).exports.f(0), 5)
  // `delete` sibling: same ToPropertyKey normalization on the removal path.
  is(jz(`const o = {}; o['1'] = 9
    let nums = []; nums.push(1)
    export let f = (j) => { delete o[nums[j]]; return o['1'] === undefined ? 1 : 0 }`).exports.f(0), 1)
  // `in` operator sibling (module/collection.js): a numeric key must
  // ToPropertyKey-probe an OBJECT's dyn-props the same way a string key
  // already does, not just check ARRAY/TYPED in-range membership.
  is(jz(`const o = {}; o['1'] = 9
    let nums = []; nums.push(1)
    export let f = (j) => (nums[j] in o) ? 1 : 0`).exports.f(0), 1)
  is(jz(`const o = {}; o['2'] = 9
    let nums = []; nums.push(1)
    export let f = (j) => (nums[j] in o) ? 1 : 0`).exports.f(0), 0)
  // Map keys are SameValueZero, NOT ToPropertyKey — must NOT be conflated
  // with the OBJECT/HASH dyn-props fix above (a Map's numeric key stays a
  // real number key, never coerced to a string).
  is(jz(`const m = new Map()
    let nums = []; nums.push(1)
    export let f = (j) => { m.set(nums[j], 'x'); return m.has('1') ? 1 : 0 }`).exports.f(0), 0)
  // Re-audit #5 finding #1 (2026-07-30): a numeric key PROVEN VAL.NUMBER at
  // compile time on an unknown receiver used to skip dispatch entirely and
  // route array-only (__typed_idx), silently reading undefined for an
  // OBJECT/HASH receiver. Fixed by a receiver-kind guard (module/array.js
  // "Proven-NUMBER key, receiver kind still unproven" arm): ARRAY/TYPED still
  // take the lean typed-array read (no runtime dispatch beyond one pointer-
  // kind tag test — no __is_str_key/__to_str call, since the key is already
  // proven non-string); OBJECT/HASH takes the SAME ToPropertyKey dyn-props
  // probe the runtime-dispatched sibling arm already used. `o[n]` for a
  // proven-number local `n` now reads the value stored under the literal
  // string key `o['1']`, matching JS.
  is(jz(`const o = {}; o['1'] = 9
    export let f = () => { let n = 1; return o[n] | 0 }`).exports.f(), 9)
})

// Presence is a schema fact, not a value fact. The old `in` path called
// __dyn_get and tested "non-nullish", conflating absent with present-null and
// present-undefined. For a precise non-escaping fixed-shape receiver the
// compiler already owns the complete key set: compare the dynamic key against
// that schema directly. This removes the dynamic-property runtime rather than
// growing it. Escaped/aliased or open shapes retain the conservative path.
// a string's index through a receiver of unknown kind: the generic property
// read ended a string's lookup at `length`, so `pick(k)['0']` was undefined
test('dyn-keys: an index key reads a string, a runtime length key an array', () => {
  const pick = `const pick = (k) => k ? 'ab' : { 0: 'z', 1: 'y' }`
  for (const [name, body] of [['runtime key', '(k, key) => pick(k)[key]'], ['literal key', "(k) => pick(k)['1'] + pick(k)['0']"],
    ['proven string key', "(k, n) => pick(k)[String(n)]"]]) {
    const src = `${pick}
export const run = ${body}`, want = oracle(src).run
    for (const optimize of levels(0, 2, 3)) {
      const got = jz(src, { optimize }).exports.run
      for (const args of [[1, '0'], [1, '1'], [1, 'length'], [1, '2'], [0, '0'], [0, '1'], [1, 0], [0, 1]])
        is(got(...args), want(...args), `${name} ${args} O${optimize}`)
    }
  }
  // keys the in-place digit test reads both ways: packed (short ASCII) and
  // heap (long, non-ASCII, a slice), canonical or not
  const edges = `const pick = (k) => k ? 'abcdefghijkl' : { 0: 'z', 1: 'y' }
    const keys = ['01', '', 'é', 'abcdefgh', '-0', '1.0', ' 1', '11', '12']
    export const run = (k, i) => [pick(k)[keys[i]], pick(k)[('éé' + i).slice(2)]]`
  const edgeWant = oracle(edges).run
  for (const optimize of levels(0, 2, 3)) for (const k of [0, 1]) for (let i = 0; i < 9; i++)
    is(jz(edges, { optimize }).exports.run(k, i), edgeWant(k, i), `edge key ${k} ${i} O${optimize}`)
  // a runtime 'length' key read an array's as undefined and absent (a typed
  // array's answered)
  const src = `const keys = ['length', '1', 'x']
    export const run = (k, i) => { const a = k ? new Float64Array(3) : [5, 6]; return [a[keys[i]], keys[i] in a] }`
  const want = oracle(src).run
  for (const optimize of levels(0, 2, 3)) for (const k of [0, 1]) for (const i of [0, 1, 2])
    is(jz(src, { optimize }).exports.run(k, i), want(k, i), `length key ${k} ${i} O${optimize}`)
})

test('in: a closed schema answers dynamic membership structurally, without __dyn_get', () => {
  const src = `export let f = (k) => {
    let o = { nil: null, undef: undefined, errorClasses: null, '1': undefined, undefined: null }
    return k in o
  }`
  for (const optimize of levels(0, 2, 3)) {
    const f = jz(src, { optimize }).exports.f
    is(f('nil'), true, `O${optimize}: null-valued field is present`)
    is(f('undef'), true, `O${optimize}: undefined-valued field is present`)
    is(f('errorClasses'), true, `O${optimize}: runtime heap-string key uses content equality`)
    is(f(1), true, `O${optimize}: ToPropertyKey numeric key reaches schema name '1'`)
    is(f(undefined), true, `O${optimize}: ToPropertyKey undefined key reaches schema name 'undefined'`)
    is(f('missing'), false, `O${optimize}: absent field stays absent`)
  }

  const wat = compile(src, { optimize: 3, wat: true })
  ok(!wat.includes('(func $__dyn_get') && !wat.includes('$__dyn_has'), 'closed-schema membership does not pull the dynamic getter family')
  ok(!wat.includes('$__dyn_props'), 'closed-schema membership does not pull sidecar/global dynamic-property storage')
  ok(wat.includes('$__str_eq'), 'a long schema name uses content equality')

  const ssoWat = compile(`export let f = (k) => {
    let o = { nil: null, undef: undefined }
    return k in o
  }`, { optimize: 3, wat: true })
  ok(!ssoWat.includes('(func $__dyn_get') && !ssoWat.includes('$__dyn_has'), 'SSO-only schema does not pull __dyn_get')
  ok(!ssoWat.includes('$__dyn_props'), 'SSO-only schema does not pull dynamic-property storage')
  ok(!ssoWat.includes('$__str_eq'), 'canonical SSO names compare by bits without __str_eq')
})

test('in: the closed-schema key expression is evaluated once before ToPropertyKey', () => {
  const src = `export let f = () => {
    let calls = 0
    let key = () => { calls++; return 1 }
    let o = { '1': null }
    let present = key() in o
    return calls * 10 + present
  }`
  for (const optimize of levels(0, 2, 3))
    is(jz(src, { optimize }).exports.f(), 11, `O${optimize}: one key call, then numeric ToPropertyKey`)
})

test('in: open, aliased, deleted, and large schemas retain runtime membership dispatch', () => {
  const cases = [
    ['alias', `let o = { fixed: undefined }; let alias = o; alias[k] = 1; return k in o`, 'added', true],
    ['computed write', `let o = { fixed: undefined }; o[k] = 1; return k in o`, 'added', true],
    ['computed delete', `let o = { fixed: undefined }; delete o[k]; return k in o`, 'fixed', false],
    ['large-schema budget', `let o = {
      a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9,
      j: 10, k: 11, l: 12, m: 13, n: 14, o: 15, p: 16, q: 17
    }; return k in o`, 'q', true],
  ]
  for (const [name, body, key, expected] of cases) {
    const src = `export let f = (k) => { ${body} }`
    for (const optimize of levels(0, 2, 3))
      is(jz(src, { optimize }).exports.f(key), expected, `O${optimize}: ${name}`)
    ok(compile(src, { optimize: 3, wat: true }).includes('$__dyn_has'),
      `${name} bypasses the closed-schema path`)
  }
  // A literal-key write outside the layout declares the key in the literal
  // (plan/declare-written-keys.js): the schema stays closed, membership too.
  const declared = `export let f = (k) => { let o = { fixed: undefined }; o.added = 1; return k in o }`
  for (const optimize of levels(0, 2, 3)) is(jz(declared, { optimize }).exports.f('added'), true, `O${optimize}: declared literal write`)
  ok(!compile(declared, { optimize: 3, wat: true }).includes('$__dyn_has'), 'a declared key keeps the closed-schema path')
})

// The runtime `in` (every receiver the closed-schema path cannot decide) read
// the property and reported "non-nullish", so a present null or undefined
// field was absent: watr's `node[1][0] in TRUNC_OF_CONVERT[op]` (a table whose
// values are null) never fired in the kernel, and the kernel kept
// `(i32.trunc_sat_f64_s (f64.convert_i32_s x))` where native folded it. The
// probe is the read's own lookup chain with a miss told apart from a stored
// value (`__dyn_has` over `__dyn_get_t_hm`), against the JS oracle.
test('in: runtime membership sees a present null or undefined field on every receiver', () => {
  const SRC = `const TABLE = {
    'i32.trunc_sat_f64_s': { 'f64.convert_i32_s': null },
    'i64.trunc_sat_f64_s': { 'f64.convert_i32_s': 'i64.extend_i32_s', 'f64.convert_i32_u': 'i64.extend_i32_u' },
  }
  const FLAT = { a: null, b: undefined, c: 0, d: 'x' }
  export const nested = (op, inner) => { const toc = TABLE[op]; return toc && inner in toc ? 1 : 0 }
  export const durable = (k) => k in FLAT ? 1 : 0
  export const durableWrite = (k) => { FLAT[k] = undefined; return (k in FLAT ? 1 : 0) + ('zz' in FLAT ? 2 : 0) }
  export const ephemeral = (k, v) => { const o = { fixed: 1 }; o[k] = v; o.n = null; return (k in o ? 1 : 0) + ('n' in o ? 2 : 0) + ('fixed' in o ? 4 : 0) + ('zz' in o ? 8 : 0) }
  export const deleted = (k) => { const o = { fixed: null }; o[k] = undefined; delete o[k]; return (k in o ? 1 : 0) + ('fixed' in o ? 2 : 0) }
  export const numeric = (n) => { const o = {}; o[n] = null; return (n in o ? 1 : 0) + (String(n) in o ? 2 : 0) + ((n + 1) in o ? 4 : 0) }
  export const onArray = (k) => { const a = [null, undefined]; a[k] = undefined; return (0 in a ? 1 : 0) + (1 in a ? 2 : 0) + (2 in a ? 4 : 0) + (k in a ? 8 : 0) + ('length' in a ? 16 : 0) }
  export const hashed = (k) => { const h = Object.fromEntries([['a', null], ['b', undefined]]); return (k in h ? 1 : 0) + ('zz' in h ? 2 : 0) }`
  const host = oracle(SRC)
  const calls = [
    ['nested', ['i32.trunc_sat_f64_s', 'f64.convert_i32_s']], ['nested', ['i32.trunc_sat_f64_s', 'f64.convert_i32_u']], ['nested', ['i64.trunc_sat_f64_s', 'f64.convert_i32_u']], ['nested', ['zz', 'f64.convert_i32_s']],
    ['durable', ['a']], ['durable', ['b']], ['durable', ['c']], ['durable', ['e']],
    ['durableWrite', ['c']], ['durableWrite', ['added']],
    ['ephemeral', ['u', undefined]], ['ephemeral', ['nil', null]], ['ephemeral', ['v', 1]],
    ['deleted', ['gone']], ['numeric', [1]], ['numeric', [-1]],
    ['onArray', ['prop']], ['onArray', [1]],
    ['hashed', ['a']], ['hashed', ['b']],
  ]
  for (const optimize of levels(0, 1, 2)) {
    const ex = jz(SRC, { optimize, memory: 64 }).exports
    for (const [fn, args] of calls) is(ex[fn](...args), host[fn](...args), `O${optimize}: ${fn}(${args.map(a => JSON.stringify(a)).join(', ')})`)
  }
})

// A deleted schema field keeps undefined in its slot (a static read is JS's
// `o.a` after the delete) and its absence in the object's header, the
// deleted-slot mask (layout.js): presence and enumeration tell a deleted field
// from a present undefined, `'a' in {a: undefined}`. Every receiver here is
// unkinded (`pick` returns several shapes), so `in`, hasOwnProperty, Object.keys
// and for-in take the runtime chain; the wide schema exercises the sticky bit
// past slot 31. Against the JS oracle at O0, O1 and O2.
test('in: a deleted field is absent, a present undefined field is present, through the runtime chain', () => {
  const SRC = `const has = (o, k) => k in o
  const own = (o, k) => o.hasOwnProperty(k)
  const keys = (o) => Object.keys(o).join(',')
  const count = (o) => { let n = 0; for (const k in o) n++; return n }
  const wide = () => ({ ${Array.from({ length: 34 }, (_, i) => `s${i}: ${i}`).join(', ')} })
  const pick = (n) => n === 0 ? { a: undefined, b: 1 } : n === 1 ? { c: 2 } : n === 2 ? [1, 2] : n === 3 ? wide() : new Map([['a', 1]])
  export const present = (n, k) => has(pick(n), k)
  export const presentOwn = (n, k) => own(pick(n), k)
  export const presentKeys = (n) => keys(pick(n))
  export const deleted = (n, k, q) => { const o = pick(n); delete o[k]; return has(o, q) }
  export const deletedOwn = (n, k, q) => { const o = pick(n); delete o[k]; return own(o, q) }
  export const deletedKeys = (n, k) => { const o = pick(n); delete o[k]; return keys(o) }
  export const deletedCount = (n, k) => { const o = pick(n); delete o[k]; return count(o) }
  export const deletedRead = (k) => { const o = { a: 5, b: 1 }; delete o[k]; return o.a === undefined }
  export const deletedJson = (n, k) => { const o = pick(n); delete o[k]; return JSON.stringify(o) }
  export const deletedClone = (n, k, q) => { const o = pick(n); delete o[k]; const c = { ...o }; return has(c, q) }
  export const rewritten = (n, k, v, q) => { const o = pick(n); delete o[k]; o[k] = v; return has(o, q) }
  export const rewrittenCount = (n, k, v) => { const o = pick(n); delete o[k]; o[k] = v; return count(o) }
  export const writtenUndefined = (n, k, q) => { const o = pick(n); o[k] = undefined; return has(o, q) }
  export const writtenUndefinedKeys = (n, k) => { const o = pick(n); o[k] = undefined; return keys(o) }`
  const host = oracle(SRC)
  const calls = [
    ['present', [0, 'a']], ['present', [0, 'b']], ['present', [0, 'z']], ['present', [1, 'a']], ['present', [3, 's33']],
    ['presentOwn', [0, 'a']], ['presentOwn', [0, 'z']], ['presentKeys', [0]],
    ['deleted', [0, 'a', 'a']], ['deleted', [0, 'a', 'b']], ['deleted', [0, 'b', 'b']], ['deleted', [3, 's33', 's33']], ['deleted', [3, 's33', 's32']], ['deleted', [3, 's5', 's5']],
    ['deletedOwn', [0, 'a', 'a']], ['deletedOwn', [0, 'a', 'b']],
    ['deletedKeys', [0, 'a']], ['deletedKeys', [0, 'b']], ['deletedKeys', [3, 's33']], ['deletedKeys', [3, 's0']],
    ['deletedCount', [0, 'a']], ['deletedCount', [3, 's32']], ['deletedRead', ['a']],
    ['deletedJson', [0, 'a']], ['deletedJson', [0, 'b']], ['deletedClone', [0, 'a', 'a']], ['deletedClone', [0, 'a', 'b']],
    ['rewritten', [0, 'a', 1, 'a']], ['rewritten', [0, 'a', undefined, 'a']], ['rewritten', [3, 's33', 7, 's33']], ['rewrittenCount', [0, 'a', 1]],
    ['writtenUndefined', [0, 'b', 'b']], ['writtenUndefined', [1, 'c', 'c']], ['writtenUndefined', [1, 'z', 'z']],
    ['writtenUndefinedKeys', [0, 'b']], ['writtenUndefinedKeys', [1, 'z']],
  ]
  for (const optimize of levels(0, 1, 2)) {
    const ex = jz(SRC, { optimize, memory: 64 }).exports
    for (const [fn, args] of calls) is(ex[fn](...args), host[fn](...args), `O${optimize}: ${fn}(${args.map(a => JSON.stringify(a)).join(', ')})`)
  }
})

// A schema id proves layout, not receiver identity. In each case below the
// queried name receives an already-aliased object through an inferred edge;
// writes happen through the source name. Per-name write facts on the queried
// alias are therefore empty, so the closed path must additionally require a
// direct-literal origin proof, not merely an inferred matching schema.
test('in: inferred-schema aliases cannot bypass source-side shape mutations', () => {
  const cases = [
    ['returned alias queried through result', `let source = { fixed: undefined }
      let get = () => source
      export let f = (k) => { let alias = get(); source[k] = 1; return k in alias }`],
    ['returned alias mutates literal source', `let source = { fixed: undefined }
      let get = () => source
      export let f = (k) => { let alias = get(); alias[k] = 1; return k in source }`],
    ['parameter alias', `let has = (k, alias) => k in alias
      export let f = (k) => { let source = { fixed: undefined }; source[k] = 1; return has(k, source) }`],
    ['container alias', `export let f = (k) => {
      let source = { fixed: undefined }, holder = [source], alias = holder[0]
      source[k] = 1
      return k in alias
    }`],
  ]
  for (const [name, src] of cases) for (const optimize of levels(0, 2, 3)) {
    is(jz(src, { optimize }).exports.f('added'), true, `O${optimize}: ${name}`)
    ok(compile(src, { optimize, wat: true }).includes('$__dyn_has'),
      `O${optimize}: ${name} retains runtime dispatch`)
  }
})

// A schema field lives in its slot only (module/collection.js
// buildObjectSchemaSetArm's invariant): a dynamic read of a schema key is the
// slot through the schema arm, so no literal mirrors its fields into the
// per-object sidecar and no dot write re-mirrors them, whatever the program's
// computed-key reach (`__dyn_set` is emitted for a computed-key WRITE only).
// The reach channel itself (collectSlotWriteHazards' hz.dynPointsTo,
// schemaDynReach, needsDynShadow) still gates a constant literal's shared
// static instance and a slot store's carrier width; the value pins below hold
// for both a reached and an unreached schema.
test('dyn-reach: a dyn-read schema and an untouched sibling both read through their slots, no mirror', () => {
  // b's OWN sid is the only entry a resolvable `b[k]` read adds to
  // dynPointsTo — a's sid (a DIFFERENT schema, never itself a `[]`/for-in
  // receiver) is not in it; neither construction mirrors anything.
  const src = `export let f = (k) => {
    let a = { aOnly: 1 }
    let b = { bOnly: 2 }
    let touched = b[k]
    a.aOnly = a.aOnly + 41
    return a.aOnly + (touched|0)
  }`
  for (const optimize of levels(0, 2, 3)) {
    is(jz(src, { optimize }).exports.f('bOnly'), 44, `O${optimize}: clean schema a reads/writes through the plain static path`)
    is(jz(src, { optimize }).exports.f('missing'), 42, `O${optimize}: clean schema a stays correct when the dyn read misses`)
  }
  // O0: no inlining to collapse call-site text, so a direct count is exact.
  const wat = compile(src, { optimize: 0, wat: true })
  is((wat.match(/\(call \$__dyn_set/g) || []).length, 0,
    'no __dyn_set call site: neither construction mirrors a field, and a\'s later dot write is a plain slot store')

  // for-in (prepare's `__keys_ro` lowering, the Object.keys scaffold) walks
  // the schema then the sidecar: every field enumerates without a mirror.
  const enumSrc = `export let f = (k) => {
    let b = { bOnly: 2, bTwo: 3 }
    let touched = b[k]
    let keys = ''
    for (let kk in b) keys += kk + ','
    return keys + '|' + touched
  }`
  for (const optimize of levels(0, 2, 3))
    is(jz(enumSrc, { optimize }).exports.f('bOnly'), 'bOnly,bTwo,|2', `O${optimize}: for-in over the dyn-reached schema enumerates every field`)

  // The historical corruption class (a stale construction-time sidecar copy
  // masked a later plain dot-write: "this silently dropped `p.then =
  // closure`..."): a dynamic read after a dot write sees the slot's value.
  const syncSrc = `export let f = (k) => {
    let b = { bOnly: 2 }
    let before = b[k]
    b.bOnly = 99
    let after = b[k]
    return before + '|' + after
  }`
  for (const optimize of levels(0, 2, 3))
    is(jz(syncSrc, { optimize }).exports.f('bOnly'), '2|99', `O${optimize}: a plain dot-write after construction stays visible to a later dynamic read`)
})

test('dyn-reach: an unresolvable dyn-key receiver fails closed to ALL, and still no schema mirrors', () => {
  // `o` is a raw, untyped parameter: sidOf(o) cannot resolve and o's kind
  // isn't provably non-OBJECT (KEYED_EXEMPT_VALS) either, so dynPointsTo
  // becomes the 'ALL' top sentinel — schemaDynReach then answers true for
  // EVERY sid, including a's, which `o[k]` never itself touches by name.
  // `a` must escape (returned) to rule out an unrelated, orthogonal
  // optimization (SRoA flat-object locals, src/compile/emit-assign.js) from
  // pre-empting the question entirely: a real heap object under ALL reach
  // is built from its slots alone.
  const src = `export let f = (o, k) => {
    let a = { aOnly: 1 }
    let touched = o[k]
    a.aOnly = a.aOnly + (touched|0)
    return a
  }`
  for (const optimize of levels(0, 2, 3))
    is(jz(src, { optimize }).exports.f(0, 'x').aOnly, 1, `O${optimize}: value correctness holds under the ALL-sentinel fallback`)

  const wat = compile(src, { optimize: 0, wat: true })
  is((wat.match(/\(call \$__dyn_set/g) || []).length, 0,
    'under the ALL sentinel a still mirrors nothing: its construction stores slots, its later write is a slot store')
})

// union points-to (dyn-reach slice 2, .work/archive/dyn-reach-slice.md's own NEXT):
// a bare-name dyn-key receiver that's a function PARAMETER with no single sid
// (sidOf's own fallbacks never bind a param name) used to fall straight to
// the whole-program 'ALL' sentinel above. resolveParamUnion
// (program-facts.js's collectSlotWriteHazards) resolves the UNION of schemas
// the param's OWN call sites actually pass instead — a `{}`-literal argument
// resolves via objLiteralSchemaId, a bare-name argument that is itself the
// caller's own parameter recurses; anything else unions that param to 'ALL'.
test('dyn-reach: union points-to — a polymorphic param reaches exactly its 2 call-site schemas; every schema reads through its slots', () => {
  // dispatch's `node` param has no single sid: callA passes a {tag,val}
  // literal, callB passes a DIFFERENT {tag,other} literal — two distinct
  // schemas, neither a single-sid answer. `c` is a third, sibling schema
  // never itself a [] read/for-in receiver anywhere — it must escape
  // (returned whole, not just a field) so it's a REAL heap object regardless
  // of any unrelated flat-local optimization.
  const src = `
    function dispatch(node, k) { return node[k] | 0 }
    function callA(k) { return dispatch({tag: 1, val: 10}, k) }
    function callB(k) { return dispatch({tag: 2, other: 20}, k) }
    export let f = (which, k) => {
      let c = { cOnly: 1 }
      let r = which === 1 ? callA(k) : callB(k)
      c.cOnly = c.cOnly + r
      return c
    }
  `
  for (const optimize of levels(0, 2, 3)) {
    is(jz(src, { optimize }).exports.f(1, 'val').cOnly, 11, `O${optimize}: schema A's field resolves through the polymorphic param`)
    is(jz(src, { optimize }).exports.f(2, 'other').cOnly, 21, `O${optimize}: schema B's field resolves through the SAME polymorphic param`)
    is(jz(src, { optimize }).exports.f(1, 'missing').cOnly, 1, `O${optimize}: an absent key still misses cleanly`)
  }
  // O0: no inlining to collapse call-site text, so a direct count is exact
  // (mirrors the fail-closed pin above).
  const wat = compile(src, { optimize: 0, wat: true })
  is((wat.match(/\(call \$__dyn_set/g) || []).length, 0,
    'no __dyn_set call: the reached schemas A and B read node[k] through the schema arm, c is untouched')
})

test('dyn-reach: union points-to — an unresolvable call-site argument degrades that param to ALL (fail closed)', () => {
  // callC passes a plain LOCAL VARIABLE `x` — bound to a literal, but not
  // itself a parameter of callC, so it's outside the two shapes
  // resolveParamUnion resolves (a `{}` literal argument; a bare name that is
  // itself the CALLER's own parameter). dispatch2's `node` param unions to
  // 'ALL': every schema in the program — including `c`, never itself a []
  // read/for-in receiver — is reachable, exactly the pre-existing
  // fail-closed behavior the previous test pins for a raw untyped param; the
  // values resolve through the slots either way.
  const src = `
    function dispatch2(node, k) { return node[k] | 0 }
    function callA(k) { return dispatch2({tag: 1, val: 10}, k) }
    function callC(k) { let x = { flag: 3, third: 30 }; return dispatch2(x, k) }
    export let f = (which, k) => {
      let c = { cOnly: 1 }
      let r = which === 1 ? callA(k) : callC(k)
      c.cOnly = c.cOnly + r
      return c
    }
  `
  for (const optimize of levels(0, 2, 3)) {
    is(jz(src, { optimize }).exports.f(1, 'val').cOnly, 11, `O${optimize}: schema A's field still resolves correctly under the ALL fallback`)
    is(jz(src, { optimize }).exports.f(2, 'third').cOnly, 31, `O${optimize}: the unresolvable call site's own schema still resolves correctly under the ALL fallback`)
  }
  const wat = compile(src, { optimize: 0, wat: true })
  is((wat.match(/\(call \$__dyn_set/g) || []).length, 0,
    'no __dyn_set call under ALL: schema A, x\'s schema and c are built from their slots, c\'s later plain write is a slot store')
})

// A literal is built from its slots alone, so its sidecar is installed on
// demand by the first computed-key write of a key outside the schema
// (__dyn_set, module/collection.js), whichever route the object took to get
// there. Each case is the JS oracle's own answer: the read of a schema key
// after a computed write, the read of the added key, and the enumeration
// order afterwards (schema keys in declaration order, then added keys in
// insertion order).
test('dyn-keys: a computed write reaches a slot-built literal through every route', () => {
  const SRC = `
    const mk = (v) => ({ x: v, y: v + 1 })
    const write = (o, k, v) => { o[k] = v; return o }
    class P { constructor(v) { this.x = v; this.y = v + 1 } }
    const probe = (o) => { let ks = ''; for (const k in o) ks += k + ':' + o[k] + ','; return ks }
    export const direct = (k, v) => { const o = { x: 1, y: 2 }; o[k] = v; return probe(o) + '|' + o.x + '|' + o[k] }
    export const viaCall = (k, v) => { const o = write(mk(10), k, v); return probe(o) + '|' + o.x + '|' + o[k] }
    export const viaArray = (k, v) => { const a = [mk(1), mk(2)]; a[1][k] = v; return probe(a[1]) + '|' + probe(a[0]) }
    export const viaClosure = (k, v) => { const o = mk(5); const set = () => { o[k] = v }; set(); return probe(o) + '|' + o.y }
    export const viaClass = (k, v) => { const p = new P(7); p[k] = v; return probe(p) + '|' + p.x + '|' + p[k] }
    export const viaAssign = (k, v) => { const o = Object.assign({ x: 0, y: 0 }, { x: 3 }); o[k] = v; return probe(o) + '|' + o.x }
    export const twice = (k, k2, v) => { const o = mk(1); o[k] = v; o[k2] = v + 1; o.x = 9; return probe(o) + '|' + Object.keys(o).length }`
  const host = oracle(SRC)
  const calls = [
    ['direct', ['x', 5]], ['direct', ['z', 5]],
    ['viaCall', ['y', 6]], ['viaCall', ['added', 6]],
    ['viaArray', ['x', 8]], ['viaArray', ['w', 8]],
    ['viaClosure', ['y', 4]], ['viaClosure', ['q', 4]],
    ['viaClass', ['x', 2]], ['viaClass', ['extra', 2]],
    ['viaAssign', ['y', 1]], ['viaAssign', ['n', 1]],
    ['twice', ['a', 'b', 1]], ['twice', ['x', 'b', 1]], ['twice', ['b', 'a', 1]],
  ]
  for (const optimize of levels(0, 2, 3)) {
    const ex = jz(SRC, { optimize }).exports
    for (const [fn, args] of calls) is(ex[fn](...args), host[fn](...args), `O${optimize}: ${fn}(${args.map(a => JSON.stringify(a)).join(', ')})`)
  }
})

// The deleted-slot mask (layout.js) marks a slot; the slot is the field's only
// home, so a plain slot store makes the field present again whether the store
// is static (`o.a = v`, which touches no mask) or dynamic (`o[k] = v`, which
// also clears the bit): a marked slot is deleted while it holds undefined. The
// probes take the runtime chain (`has`/`count` see two shapes); the write in
// `rewritten*` is the static slot store of a known-schema local. (A rewritten
// field enumerates in slot order, JS appends it: the mask commit's open, so
// the count is pinned, not the order.)
test('in: a deleted field written again through a static dot write is present', () => {
  const SRC = `const has = (o, k) => k in o
  const count = (o) => { let n = 0; for (const k in o) n++; return n }
  export const other = () => (has({ c: 3 }, 'c') ? 1 : 0) + count({ c: 3 })
  export const rewritten = (k, v) => { const o = { a: 1, b: 2 }; delete o[k]; o.a = v; return (has(o, 'a') ? 1 : 0) + (has(o, k) ? 2 : 0) + (o[k] === v ? 4 : 0) + count(o) * 8 }
  export const rewrittenDyn = (k, q, v) => { const o = { a: 1, b: 2 }; delete o[k]; o[q] = v; return (has(o, 'a') ? 1 : 0) + (has(o, k) ? 2 : 0) + count(o) * 8 }`
  const host = oracle(SRC)
  const calls = [['other', []], ['rewritten', ['a', 5]], ['rewritten', ['b', 5]],
    ['rewrittenDyn', ['a', 'a', 5]], ['rewrittenDyn', ['a', 'a', undefined]], ['rewrittenDyn', ['b', 'a', 5]]]
  for (const optimize of levels(0, 1, 2)) {
    const ex = jz(SRC, { optimize }).exports
    for (const [fn, args] of calls) is(ex[fn](...args), host[fn](...args), `O${optimize}: ${fn}(${args.map(a => JSON.stringify(a)).join(', ')})`)
  }
})

// The read-side reach (collectSlotWriteHazards' dynPointsTo) names a receiver
// sidOf cannot by the summary's kind per site, and classes a numeric key: a
// number addresses a schema slot only through its canonical-integer string,
// so `node[1]` on a parameter of unknown kind (the AST walker's shape) reaches
// the integer-named schemas alone. What the reach still gates: a constant
// private literal's shared static instance. Host-visible literals must allocate
// independently because memory.write can mutate them between calls.
test('dyn-reach: host-visible literals allocate regardless of dynamic-key reach', () => {
  const lits = `export const mk = () => ({ x: 1, y: 2 })\nexport const mk1 = () => ({ 1: 10, 2: 20 })\n`
  const cases = [
    ['numeric literal key', `export const first = (node) => node[1]`, true, true],
    ['numeric counter key', `export const scan = (src) => { let n = 0; for (let i = 0; i < src.length; i++) if (src[i] === 40) n++; return n }`, true, true],
    ['array receiver', `const T = [1, 2, 3]\nexport const at = (i) => T[i]`, true, true],
    ['string key', `export const get = (o, k) => o[k]`, true, true],
  ]
  for (const [name, fn, mkAllocs, mk1Allocs] of cases) {
    const src = lits + fn
    const wat = compile(src, { optimize: 0, wat: true })
    const body = (f) => { const i = wat.indexOf(`(func $${f}\n`); return wat.slice(i, wat.indexOf('\n  (func ', i + 1)) }
    is(/__alloc_hdr/.test(body('mk')), mkAllocs, `${name}: {x, y} ${mkAllocs ? 'allocates per evaluation' : 'is the shared static instance'}`)
    is(/__alloc_hdr/.test(body('mk1')), mk1Allocs, `${name}: {1, 2} ${mk1Allocs ? 'allocates per evaluation' : 'is the shared static instance'}`)
    const ex = jz(src, { optimize: 0 }).exports
    is(ex.mk().x + ex.mk().y, 3, `${name}: {x, y} reads`)
    is(ex.mk1()[1] + ex.mk1()[2], 30, `${name}: {1, 2} reads`)
  }
})

// audit P0 (1db8e55e revert, external bisection): the Map value-census .get()
// consumer promoted EVERY read on a proven-Map receiver to the exact VAL.*
// kind of every observed .set() write. Unsound two ways: (1) an ABSENT key
// reads real JS `undefined` at runtime — not a value of the observed kind;
// (2) the census scan keys observations by SYNTACTIC receiver name, so a
// write through an alias is invisible to a census keyed on the original
// name, leaving a stale kind in place after the alias write changes it.
// Both promote past what the actual runtime value is. Consumer reverted
// (kind.js mapValueKindOf, emit.js nullableOperand carve-out); these pin
// the bisected repros.
test('Map: .get() on an absent key behaves as real undefined, not the census kind (audit P0)', () => {
  is(run(`const m = new Map(); m.set('a', 1); return m.get('b') + 1`), NaN)  // undefined + 1 === NaN
  is(run(`const m = new Map(); m.set('a', 1); return String(m.get('b'))`), 'undefined')  // NOT "NaN"
})

test('Map: a write through an alias is not lost to a stale census kind (audit P0)', () => {
  // m.set('k', 1) alone would (wrongly) settle the census at NUMBER; the
  // syntactic-name scan never observes the alias.set() STRING write below,
  // so a sound consumer must not trust a stale NUMBER kind for m.get('k').
  is(run(`const m = new Map(); m.set('k', 1)
    const alias = m; alias.set('k', 'oops1')
    return m.get('k') - 0`), NaN)  // 'oops1' - 0 === NaN, same as plain JS
})

// FIXED (.work/archive/todo.md §deletion-sweep Slice 1, value-join): dictValueKindOf
// (kind.js, consumed by VT['[]']/VT['.']) had the SAME absent-key
// exact-promotion unsoundness as the reverted mapValueKindOf — the census is
// "every value ever WRITTEN", not "this key exists". Closed by
// `censusMaybeUndefined` (kind.js, promoted from emit.js's `nullableOperand`
// carve-out), wired into ir.js's toNumF64 (coerces through
// coerceNullishToNum: undefined→NaN) and module/string.js's `bind('String', …)`
// (falls through to the already-correct toStrI64/__to_str general arm). The
// dict-value-census consumer itself is UNCHANGED — still live, still returns
// the exact kind — only these two arithmetic/ToString chokepoints now ask
// "could this exact-kind claim be falsified by an absent key" first.
test('dict: .get()-equivalent read on an absent key behaves as real undefined (Slice 1, dict-census sibling of audit P0)', () => {
  is(run(`const d = {}; const wk = 'a'; d[wk] = 1; const rk = 'zz'; return d[rk] + 1`), NaN)  // undefined + 1 === NaN
  is(run(`const d = {}; const wk = 'a'; d[wk] = 1; const rk = 'zz'; return String(d[rk])`), 'undefined')
})

// FIXED (.work/archive/todo.md §deletion-sweep §2/Slice 3, nameEscapes alias gate):
// dictValueKindOf (the ALREADY-LIVE dict census consumer) had the SAME
// alias-write unsoundness as the reverted mapValueKindOf — the census keys
// observations by SYNTACTIC receiver name (analyze.js's dictValueTypeOf
// same-body scan), so a write through an alias (`const a = d; a[k] = v`) is
// invisible to a census keyed on `d`, leaving a stale exact-kind claim live
// after the alias write changes the real value's kind. Closed by gating
// `dictValueKindOf` on `ctx.types.nameEscapes.has(name)` (kind.js) — `d`
// lands in nameEscapes the moment it's read in a value position anywhere
// (here, the `const alias = d` initializer).
// LANDING FOUND AND FIXED A SECOND, PRE-EXISTING BUG this gate depends on:
// nameEscapes itself (program-facts.js) never marked a bare-name DECL
// initializer's RHS (`const alias = d`) at all — walkFacts' 'let'/'const'
// special case hand-walks each declarator instead of visiting the '='
// node through the normal recursive call, so observeNodeFacts' generic
// per-arg escape-marking loop (and the declEq exemption it pre-registers)
// never ran for decl form. A plain (non-decl) reassignment (`let alias;
// alias = d`) was NOT affected — that '=' node DOES reach observeNodeFacts
// via walkFacts' unconditional entry call. Confirmed by direct trace (both
// forms, live instrumentation): decl-form left 'd' OUT of nameEscapes;
// reassignment-form correctly marked it. This is the exact `const alias = m`
// shape the audit-P0 Map pins (above) and design §2's own worked example
// use — without this fix, the nameEscapes gate silently does NOT fire for
// the design's own canonical alias-creation idiom. Fixed by having the
// 'let'/'const' branch call `observeNodeFacts(decl, acc)` on each
// '='-shaped declarator explicitly (program-facts.js) — the pre-registered
// declEq exemption still protects the LHS binding slot; only the previously-
// invisible bare-name RHS case is newly (and correctly) marked.
// Repro confirmed red at HEAD (both with and without the kind.js gate alone
// — the nameEscapes bug meant the gate had nothing to consult): `jz =
// 'oops1'` (a raw NaN-boxed string pointer surviving `- 0` bit-for-bit,
// decoded back to the string by the host bridge) vs `JS = NaN`. Green only
// with BOTH fixes landed together.
// String() is NOT a distinguishing case here (unlike the Slice 1 absent-key
// repro above) — Slice 1's censusMaybeUndefined already routes ANY node
// where dictValueKindOf(name) is truthy through toStrI64/__to_str's fully
// general, runtime-tag-correct path for String(), regardless of whether the
// exact-kind claim itself was sound — confirmed this already returned
// 'oops1' correctly even at HEAD, pre-Slice-3. Only toNumF64's arithmetic
// fast return (`asF64(v)` unguarded by any runtime tag check) is exploitable
// by a wrong-but-unpoisoned exact-kind claim; kept below as a passing
// control, not a red→green pin.
test('dict: a write through an alias is not lost to a stale census kind (audit P0 sibling, Slice 3)', () => {
  is(run(`const d = {}; const wk = 'a'; d[wk] = 1
    const alias = d; const wk2 = 'k'; alias[wk2] = 'oops1'
    return d[wk2] - 0`), NaN)  // 'oops1' - 0 === NaN, same as plain JS
  is(run(`const d = {}; const wk = 'a'; d[wk] = 1
    const alias = d; const wk2 = 'k'; alias[wk2] = 'oops1'
    return String(d[wk2])`), 'oops1')  // already correct pre-Slice-3 (see comment above) — control, not a flip
})

// FIXED (.work/archive/todo.md §deletion-sweep Slice 5 site survey — LEAK A):
// emitLooseEq/emitStrictEq's (src/compile/emit.js) raw `f64.eq`/`f64.ne` fast
// path fired whenever EITHER side's static kind was VAL.NUMBER, with no
// runtime tag check — unlike arithmetic (toNumF64) and String(), this never
// called censusMaybeUndefined/coerceNullishToNum at all. IEEE-754 f64.eq is
// FALSE for any NaN operand, always — including two bit-identical NaN-boxed
// `undefined` sentinels — so `x === y` where BOTH x and y are genuinely
// `undefined` at runtime (one masquerading as a proven NUMBER via a dict
// census absent-key claim) wrongly read false; JS reads true. The relational
// family (`<`/`>`/`<=`/`>=`, cmpOp) does NOT have this bug — checked as part
// of the same survey: JS's `ToNumber(undefined) = NaN`, "compared to NaN" is
// always false, which is exactly what an UNGUARDED f64 relational op already
// returns for ANY NaN-boxed operand — no fix needed there (kept as a
// passing control below). Fixed by reusing `nullableOperand` (emit.js,
// already unifies the census carve-out with the unproven-typed-index-OOB
// carve-out) to gate emitLooseEq's `aSafe`/`bSafe` NUMBER-trust — a claim
// only counts as "safe" now when BOTH ===VAL.NUMBER AND non-nullable.
test('dict: strict/loose equality between two independently-maybe-undefined reads (Slice 5 LEAK A)', () => {
  // one side a real (non-census) undefined-holding local
  is(run(`const d = {}; const wk = 'a'; d[wk] = 1; const rk = 'zz'
    let u
    return d[rk] === u ? 1 : 0`), 1)
  // both sides independent absent-key dict reads
  is(run(`const d = {}; const wk = 'a'; d[wk] = 1; const rk = 'zz'; const rk2 = 'yy'
    return d[rk] === d[rk2] ? 1 : 0`), 1)
  // loose eq, one side NUMBER-census, other side an unrelated unproven boxed read
  is(run(`const d = {}; const wk = 'a'; d[wk] = 1; const rk = 'zz'
    const other = {}; const owk = 'p'; other[owk] = 1; other[owk] = 'str'
    const ork = 'q'
    return d[rk] == other[ork] ? 1 : 0`), 1)
  // literal `undefined`/`null` sentinel comparisons stay correct (pre-existing carve-out, control)
  is(run(`const d = {}; const wk = 'a'; d[wk] = 1; const rk = 'zz'
    return d[rk] === undefined ? 1 : 0`), 1)
  // relational family needs no fix — NaN-boxed operand already compares false, matching
  // JS's ToNumber(undefined)=NaN semantics (control, not a flip)
  is(run(`const d = {}; const wk = 'a'; d[wk] = 1; const rk = 'zz'
    return d[rk] > 5 ? 1 : 0`), 0)
})

// FIXED (.work/archive/todo.md §deletion-sweep Slice 5 site survey — LEAK B):
// ir.js's toStrI64 — the SAME function module/string.js's `bind('String', …)`
// already delegates to for the maybeUndefined-flagged case, on the stated
// belief it "falls through to the LAST branch... already correct" — had its
// OWN unguarded `vt === VAL.STRING` early return ABOVE that last branch.
// A dict census whose OBSERVED writes were all STRING (not NUMBER, the only
// kind Slice 1's own repro exercised) hit THIS branch instead: `asI64(v)`
// reinterpreted the absent key's raw UNDEF_NAN bits as a string i64 — which
// decodes host-side as the bare `undefined` VALUE, not the string
// `"undefined"` (a WORSE failure than a wrong string: wrong TYPE entirely).
// Reaches template-literal interpolation too (ir.js's toStrI64 is strcat's
// per-part fallback, module/string.js), contradicting the Slice 1 design's
// "template literals need no fix" claim — that claim was verified only
// against a NUMBER-kind census; the STRING-kind case was untested. Fixed at
// toStrI64 itself (the shared chokepoint), gating the `vt===VAL.STRING`
// return on `!censusMaybeUndefined(node)`.
test('dict: String() and template literals on a STRING-census absent key (Slice 5 LEAK B)', () => {
  is(run(`const d = {}; const wk = 'a'; d[wk] = 'x'; const wk2 = 'b'; d[wk2] = 'y'
    const rk = 'missing'
    return String(d[rk])`), 'undefined')
  is(run(`const d = {}; const wk = 'a'; d[wk] = 'x'; const wk2 = 'b'; d[wk2] = 'y'
    const rk = 'missing'
    return \`v=\${d[rk]}\``), 'v=undefined')
})

// audit-#8 P0-2: the Map/dict value census's same-body scan (analyze.js
// dictValueTypeOf/mapValueTypeOf) AND the whole-program {fresh:true} half
// (program-facts.js observeProgramSlots) both stopped dead at any nested `=>`
// — a write CAPTURED in a callback (`[0].forEach(() => m.set('y', 'oops'))`)
// was invisible to the census on either side, so a receiver written ONLY
// NUMBER at every syntactically-visible top-level site still read back a
// stale NUMBER census kind after a captured write actually stored a STRING —
// `m.get('y') + 1` compiled straight to f64.add and silently dropped the
// string, returning `'oops'` instead of JS's `'oops1'`. Fixed by observing
// THROUGH nested closures (more observations only ever tighten/poison the
// join, never loosen it), gated on collectAllBoundNames' shadow-bail so a
// nested closure that re-declares the receiver name doesn't misattribute ITS
// writes to the outer binding.
test('Map: a write captured in a nested callback is not lost to a stale census kind (audit-#8 P0-2)', () => {
  is(jz(`const m = new Map(); m.set('x', 1)
    export let f = () => { [0].forEach(() => m.set('y', 'oops')); return m.get('y') + 1 }`).exports.f(), 'oops1')
})
test('dict: a write captured in a nested callback is not lost to a stale census kind (audit-#8 P0-2, dict sibling)', () => {
  is(jz(`const d = {}; const wk = 'x'; d[wk] = 1
    export let f = () => { [0].forEach(() => { const wk2 = 'y'; d[wk2] = 'oops' }); const rk = 'y'; return d[rk] + 1 }`).exports.f(), 'oops1')
})
// Numeric captured-write control — the dominant real-world shape
// (`arr.forEach(v => m.set(k, v))`) — a functional-correctness pin only now
// (audit #9 P0-1, .work/archive/todo.md "audit-#9 P0-1 closed": the census consumer
// this comment originally described as "the census win, no fallback to the
// polymorphic-add path" is reverted/dormant, so EVERY `.get()`/dict read
// takes the polymorphic path unconditionally — there is no fast-path win
// left to keep. Historical note: pre-revert, this exact source was manually
// confirmed via a wasm byte-size diff (worktree at 8182e465) to take the
// narrower numeric codegen; that diff is no longer representative.
test('Map: a numeric-only write captured in a nested callback keeps working (control)', () => {
  is(run(`const m = new Map(); [1, 2, 3].forEach(v => m.set('k', v * 2)); return m.get('k') + 1`), 7)
})
// Shadow control: a nested function's OWN param/local reusing the receiver's
// name must NOT poison (or misattribute writes into) the outer census — the
// shadowed `m` inside `g` is a different binding entirely.
test('Map: a same-named local in a nested closure does not poison the outer census (shadow control)', () => {
  is(run(`const m = new Map(); m.set('k', 1)
    const g = (m) => { m.set('k', 'str') }
    g(new Map())
    m.set('k', 2)
    return m.get('k') + 1`), 3)
})
// Read-only capture control: a captured READ (no write) must not disqualify
// the census — only writes matter.
test('Map: a read-only capture does not disqualify the census (control)', () => {
  is(run(`const m = new Map(); m.set('x', 5)
    let s = 0; [0].forEach(() => { s += m.get('x') })
    return s + 1`), 6)
})

// audit-#8 P0-4 Part 3 (2026-08-03): unary '-'/'~' on a maybeUndefined-BIGINT
// receiver (Map.get() or a dict DYNAMIC-key read whose census claims BIGINT)
// used to i64-negate/complement the UNDEF_NAN sentinel's raw bits, producing a
// garbage bigint-shaped float. Real JS: unary ops ToNumeric a single operand —
// undefined's ToNumeric is the Number NaN, no TypeError (contrast the binary
// '+'/'-'/etc. case above, which DOES throw — a second operand's type to
// mismatch against). Fixed by emit.js's bigIntUnary (sibling of bigIntOperand):
// the maybeUndefined operand's runtime UNDEF_NAN check now selects the
// canonical NUMBER result (NaN for '-', -1 for '~') instead of doing raw i64
// math on the sentinel. A dict BRACKET-LITERAL-key read (`d['missing']`) was
// never affected by this bug in the first place — VT['[]']'s own array-vs-
// property disambiguation resolves a non-numeric string-literal key to `null`
// before ever reaching the dict census, so it already took the sound generic
// toNumF64 path; the dynamic-key case below is the one that actually exercised
// the raw-i64 branch.
// Present-key case — FIXED (Slice 5, .work/archive/todo.md §deletion-sweep
// §6/§12, the `presentKindUnboxed` family — the last named
// value-wrong family from the audit campaign). Root (re-confirmed live,
// unchanged from the Slice 4 finding below): bigIntUnary's runtime
// select/isUndef branch already computes the CORRECT i64 negate/complement
// internally (present key: isUndef false, selects the negate arm; `-5n`'s
// raw i64 bits are exact) — the corruption used to happen ONE step later, at
// the export boundary (compile/index.js synthesizeBoundaryWrappers): a
// dict/Map-census BIGINT result (bare read OR unary `-`/`~` of one) has no
// STATIC `func.valResult === VAL.BIGINT` proof (the value can genuinely be
// `undefined`/NaN/-1 at runtime), so it fell into the generic resultDynamic
// lane, whose host-side decode (interop.js) reinterprets unrecognized i64
// bits as a NaN-box-or-number — misreading a small BigInt's raw bits as a
// subnormal float (`2.5e-323`) instead of recognizing them as a BigInt.
// FIXED with a LANE/KIND-INFORMATION fix, not a representation change (the
// raw-i64 BigInt carrier doctrine stays as-is): `censusBigintSentinelKind`
// (kind.js) recognizes a census-BIGINT return tail — bare dict/Map read,
// call-result, or `-`/`~` wrapping one — and `synthesizeBoundaryWrappers`
// emits a NEW `jz:i64exp` result marker (`s`: 1 = bare read/call-result,
// sentinel bits = UNDEF_NAN → `undefined`; 2 = unary `-`, sentinel = NaN's
// bits → `NaN`; 3 = unary `~`, sentinel = `-1`'s bits → `-1`) instead of the
// generic `r` marker. interop.js's new `decodeBigintSentinel` checks the
// raw i64 result against exactly that sentinel's fixed bit pattern: a match
// decodes to the sentinel's real JS value, anything else is returned as a
// raw BigInt — no generic NaN-box/number decode, so a small BigInt's bits
// never get misread. TWO deeper bugs found and fixed en route (both
// independent of the export lane itself, both re-verified via full gates):
// (1) `valTypeOfWithLocals`'s unary BigInt-preserving family (kind.js) fell
// through to `numericUnaryVT`'s unconditionally-resolving optimistic-NUMBER
// default whenever the operand's kind was genuinely UNRESOLVED (not
// genuinely NUMBER) at narrowValResults' early whole-program pass — the SAME
// "unknown side → no claim" gap the pre-existing SOUND-`+` fix already
// closed for `+`, just never extended to `u- ~ ++ --`. Left unfixed,
// `export let f = () => -m.get('x')` claimed `func.valResult = VAL.NUMBER`
// and skipped i64 boundary wrapping ENTIRELY — a live miscompile, not just a
// missed optimization. (2) type.js's `exprType` (Phase E i32-result
// narrowing) had the identical class of gap for the bitwise family
// (`~ & | ^ << >>`): an unresolved (not proven-BIGINT) operand still
// defaulted to `'i32'`, narrowing an export's WASM signature away from f64
// even when the operand could genuinely be a census-BIGINT — fixed with a
// `censusShapedNode` guard that keeps the safe `'f64'` default specifically
// for that ambiguous case (ordinary, non-census operands are unaffected).
// THE STRICT-EQUALITY assertions were already correct pre-Slice-5 (Slice 4
// finding, unchanged): `-m.get('x') === -5n` statically proves BOTH sides
// BIGINT (numericUnaryVT + the BIGINT literal), so emitStrictEq takes the
// REF_EQ_KINDS raw i64-bit-compare path, never touching the export lane.
//
// TWO MORE GAPS FOUND, both closed, while reverting Slice 4's VT wiring
// (audit #10, §14): "numericUnaryVT/numericBinaryVT's own optimistic-NUMBER
// default" (named above for `valTypeOfWithLocals`'s narrower copy) turns out
// to ALSO live in the base VT['u-']/VT['~'] entries (kind.js) that this
// present-key test depends on — and those had ONLY ever resolved BIGINT
// correctly for a census operand because Slice 4's VT['[]']/['.']/['()']
// wiring made `valTypeOf(m.get(k))` itself prove BIGINT directly. Reverting
// that wiring regressed BOTH: (1) `-m.get('x')` (assertion 4 below) via
// compile/index.js's `_resultNumeric` boundary-wrap gate wrongly trusting
// the optimistic default and skipping the i64 wrap entirely, and (2)
// `-m.get('x') === -5n` (assertion 5) via emitStrictEq's REF_EQ_KINDS path
// no longer being reached at all. Both fixed the SAME way as emitNeg/`~`'s
// own OR-arm (§13's proactive hardening): `_resultNumeric` now also checks
// `censusBigintSentinelKind(e) === 0`, and VT['u-']/VT['~'] (kind.js) gained
// a `censusMaybeUndefinedKind`-direct OR-arm scoped to exactly the
// single-operand `u-`/`~` shape — VT-independent, so both stay correct with
// Slice 4 dormant. (`_resultNumeric`'s companion `_resultBigintSentinel`
// was already VT-independent per §13 — only `_resultNumeric` itself and
// emitStrictEq's dispatch had the gap.)
// BigInt retirement Slice 1 (.work/archive/bigint-retirement-design.md §4/§7): every
// shape in the 3 tests below stores a BigInt into a Map/dict
// (`m.set(k, 1n)`/`d[k]=1n`) — exactly the design's "collection" flow class
// (`d[k]=5n`/`map.set(k,5n)`, §4's table) — which now refuses to compile
// instead of materializing the value (boxed or raw) for a later unary op to
// observe. The unary-decay behavior these tests pinned is moot: there is no
// runtime value left to decay, correctly or not. Converted to expect-error,
// not deleted — the shape remains valuable negative-space coverage.
test('Map: unary "-"/"~" on a .get() absent key decays to NUMBER NaN/-1, not a garbage bigint (audit-#8 P0-4 Part 3) — BigInt-into-Map strict-mode (opt-in) collection diagnostic', () => {
  if (onKernel()) return
  throws(() => withBigintStrict(() => run(`const m = new Map(); m.set('x', 1n); return -m.get('missing')`)), /BigInt value at this collection/)
})
test('dict: unary "-"/"~" on a DYNAMIC-key absent read decays to NUMBER NaN/-1 (audit-#8 P0-4 Part 3, dict sibling) — BigInt-into-dict strict-mode (opt-in) collection diagnostic', () => {
  if (onKernel()) return
  throws(() => withBigintStrict(() => jz(`export let f = (k1, k2) => { const d = {}; d[k1] = 1n; return -d[k2] }`)), /BigInt value at this collection/)
})
test('dict: unary "-" on a LITERAL-key absent read (already sound — not this bug, structural control) — BigInt-into-dict strict-mode (opt-in) collection diagnostic', () => {
  if (onKernel()) return
  throws(() => withBigintStrict(() => run(`const d = {}; d['x'] = 1n; return -d['missing']`)), /BigInt value at this collection/)
})

// Slice 5 (.work/archive/todo.md §deletion-sweep §6/§12, presentKindUnboxed)
// repro 5 itself — the bare `m.get()`/`d[k]` read, no unary — closing the class
// this design named the whole audit campaign's last value-wrong family. Was
// KNOWN-FAIL: `m.set('x', 5n); export let f = () => m.get('x')` returned the host
// `2.5e-323` (5n's raw i64 bits misread as an f64 subnormal), not `5n`. Fixed by
// the same `s`-lane export marker the unary tests above exercise (sentinel kind 1:
// UNDEF_NAN → `undefined`, anything else a raw BigInt) — no in-wasm change, the
// bug was purely in which lane/decode the export took.
// BigInt retirement Slice 1 (.work/archive/bigint-retirement-design.md §4/§7): both
// tests below construct `m.set('x', 5n)`/`d[k1]=5n` — the "collection" flow
// class — which now refuses to compile (§4's table names this exact shape:
// "map.set(k, 5n)"/"d[k]=5n with an unresolvable key"). The whole export-
// boundary sentinel-lane machinery these tests exercised (Slice 5's own
// `_resultBigintSentinel`) has no remaining input to fire on — an
// unprovable BigInt never reaches a live value for it to decode. Converted
// to expect-error per the design's own suggested pattern (§7): "Convert
// is(mapMod.exports.f(), 5n)-style assertions to throws(() => jz(src),
// /collection.*BigInt/)-style assertions naming the new diagnostic."
test('Slice 5: bare Map/dict .get()/[] read materializes the true BigInt across the export boundary (repro 5, was KNOWN-FAIL) — BigInt-into-Map/dict strict-mode (opt-in) collection diagnostic', () => {
  if (onKernel()) return
  throws(() => withBigintStrict(() => jz(`export let f = () => { const m = new Map(); m.set('x', 5n); return m.get('x') }`, { jzify: true })), /BigInt value at this collection/)
  throws(() => withBigintStrict(() => jz(`export let f = (k1) => { const d = {}; d[k1] = 5n; return d[k1] }`, { jzify: true })), /BigInt value at this collection/)
})

// Negative controls (Slice 5): the mixed-kind-Map carve-out this pinned as
// "documented (unfixed)" is exactly the class Slice 1 eliminates at the root
// (same as test/data.js's audit-#11 P0-1 deletion) — `m.set('a', 5n)` alone
// refuses to compile before the mixed-kind question is ever reached. The
// statically-proven BigInt export negative control (no Map/dict involved at
// all) is unaffected — kept as-is.
test('Slice 5: negative controls — mixed-kind Map falls back to documented (unfixed) behavior; a statically-proven BigInt export is untouched', () => {
  if (onKernel()) return
  throws(() => withBigintStrict(() => jz(`export let f = (k) => { const m = new Map(); m.set('a', 5n); m.set('b', 6); return m.get(k) }`, { jzify: true })), /BigInt value at this collection/)
  // A statically-proven BigInt export (no census, no Map/dict) keeps taking
  // the ORIGINAL unmarked resultBigint lane, unaffected by this retirement —
  // structural pin against the new diagnostic over-firing on an already-sound case.
  is(jz(`export let f = () => 5n`).exports.f(), 5n)
  is(jz(`export let f = () => -5n`).exports.f(), -5n)
})

// Slice 6 (.work/archive/todo.md §deletion-sweep §14/§15, "begin the
// presentVal opt-in model"): a NEW `presentVal` REP field (reps.js) rides
// analyze.js's decl/reassign producer, poison-disciplined like `val` itself
// (NOT a spread-merge boolean like `mayBeUndefined`) — the KIND-carrying
// generalization one hop past a direct census read. First opt-in consumer
// found genuinely LIVE (not just representationally complete): kind.js
// `censusMaybeUndefinedKind`'s bare-name REP-fallback arm, which
// `censusBigintSentinelKind`/Slice 5's export-lane machinery already builds
// on directly — so a DECL-HOP present-key BigInt census read (`let x =
// m.get(k); return x`, one hop past Slice 5's own bare-read repro 5) now
// ALSO crosses the export boundary correctly, without any change to Slice
// 5's own lane/decode mechanism. Was silently wrong (`2.5e-323`, the exact
// repro-5 bit-pattern misread) at HEAD before this slice; confirmed via a
// direct stash diff, not assumed.
// BigInt retirement Slice 1 (.work/archive/bigint-retirement-design.md §4/§7): same
// "collection" flow class as the Slice 5 tests above, one decl-hop further.
// `m.set('a', 5n)`/`d[k]=5n` refuses to compile before the decl-hop's own
// presentVal machinery is ever reached.
test('Slice 6: decl-hop present-key BigInt census read materializes the true BigInt across the export boundary (one hop past repro 5) — BigInt-into-Map/dict strict-mode (opt-in) collection diagnostic', () => {
  if (onKernel()) return
  throws(() => withBigintStrict(() => jz(`export let f = () => { const m = new Map(); m.set('a', 5n); let x = m.get('a'); return x }`, { jzify: true })), /BigInt value at this collection/)
  throws(() => withBigintStrict(() => jz(`export let f = (k) => { const d = {}; d[k] = 5n; let x = d[k]; return x }`, { jzify: true })), /BigInt value at this collection/)
})

// Negative control (Slice 6): the mixed-kind-Map carve-out is eliminated at
// the root, same as the Slice 5 negative control above.
test('Slice 6: negative control — decl-hop through a mixed-kind Map stays the documented (unfixed) Slice 5 gap — BigInt-into-Map strict-mode (opt-in) collection diagnostic', () => {
  if (onKernel()) return
  throws(() => withBigintStrict(() => jz(`export let f = () => { const m = new Map(); m.set('a', 5n); m.set('b', 6); let x = m.get('a'); return x }`, { jzify: true })), /BigInt value at this collection/)
})

// FIXED (§14 point 4, audit #10's own "JOINT runtime domain dispatch" finding
// — .work/archive/todo.md §deletion-sweep §14): a present-key census-BIGINT
// value used in BINARY `+` with a NUMBER now throws the TypeError real JS
// gives for BigInt⊕Number mixing, instead of silently doing ordinary f64
// addition on the raw i64-as-f64 carrier bits. Root cause was exactly audit
// #10's own diagnosis: `bigintMixReject`/`bothBigIntOperands` are OPERAND-
// LOCAL guards, each deciding one operand's fate from a static claim alone —
// architecturally unable to distinguish "both absent" (NaN, no throw) from
// "one absent, one a real BigInt" (throw) from "a proven BigInt paired with a
// real, non-BigInt dynamic value" (throw). Fixed by emit.js's
// `bigIntJointDispatch`: evaluates both operands ONCE, classifies each
// operand's ACTUAL runtime domain (present-vs-absent for a census claim, the
// same subnormal-magnitude heuristic `typeof x === 'bigint'` already uses for
// a fully unresolved operand), then dispatches Number arithmetic / BigInt
// arithmetic / TypeError jointly — wired at all 9 binary arithmetic/bitwise
// ops (`+ - * / % & | ^ << >>`), not just `+`.
// BigInt retirement Slice 1 (.work/archive/bigint-retirement-design.md §4/§7):
// `m.set('x', 5n)` refuses to compile before the runtime TypeError this
// test pinned is ever reached.
test('§14 point 4: present-key census-BIGINT + NUMBER throws TypeError (was: silent NUMBER garbage) — BigInt-into-Map strict-mode (opt-in) collection diagnostic', () => {
  if (onKernel()) return
  throws(() => withBigintStrict(() => jz(`export let f = () => { const m = new Map(); m.set('x', 5n); return m.get('x') + 1 }`, { jzify: true })), /BigInt value at this collection/)
})

// §14 point 4 full presence×domain matrix, all 9 ops, verified against real
// JS for every cell (differential, not hand-picked): a census-BIGINT Map with
// two keys, one op at a time, over all four (present, absent) × (present,
// absent) combinations, PLUS a present-key mix against a proven NUMBER
// literal (the original audit-#10 repro's own shape). This is the audit's own
// named "core case" — `m.get(absent1) + m.get(absent2)` is NaN (both operands'
// ToNumeric is the Number NaN, no type mismatch to throw on), while
// `m.get(absent) + m.get(present5n)` throws (Number NaN vs a real BigInt IS a
// type mismatch) — the exact discrimination an operand-local guard cannot
// make, only a JOINT check evaluating both operands' actual runtime domains
// together can.
// BigInt retirement Slice 1 (.work/archive/bigint-retirement-design.md §4/§7): every
// cell of this matrix (both-present, both-absent, present+absent,
// census-mixed-with-literal) shares one precondition, `m.set('a'|'x', 6n)`,
// the "collection" flow class. All 9 ops now refuse to compile at that
// shared precondition, before any presence×domain distinction is ever
// reached — one throws() per op is enough to cover the class (looping the
// full matrix would just repeat the identical refusal).
test('§14 point 4: full presence×domain matrix over all 9 binary ops, differential against real JS — BigInt-into-Map strict-mode (opt-in) collection diagnostic', () => {
  if (onKernel()) return
  for (const op of ['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>'])
    throws(() => withBigintStrict(() => jz(`export let f = () => { const m = new Map(); m.set('a', 6n); m.set('b', 3n); let x = m.get('a'); let y = m.get('b'); return x ${op} y }`, { jzify: true })), /BigInt value at this collection/, `${op}: refuses to compile`)
})

// Documented, accepted, PERMANENT carrier-doctrine gap (not fixed, per this
// design's own doctrine — bigintMixReject's own "0n's carrier is bit-identical
// to the number 0.0" exemption is the SAME class): the bitwise family's
// "both absent" cell ToInt32(NaN)=0 on both sides, giving the NUMBER 0 in real
// JS — but 0's raw i64/f64 bit pattern is IDENTICAL to a genuine BigInt 0n's
// carrier, so the export lane (kind.js censusBigintSentinelKind kind 4, no
// sentinel exists or safely CAN exist for this specific value) cannot
// distinguish them and passes the bits through as a raw BigInt. The VALUE is
// numerically correct (0n == 0); only the TYPE tag is wrong. A real,
// documented divergence, not silently dropped — this codebase already accepts
// the identical ambiguity class elsewhere (0-literal BigInt/Number mixing).
// BigInt retirement Slice 1 (.work/archive/bigint-retirement-design.md §4/§7): same
// class as test/data.js's audit-#11 P0-1 (§7): a documented, "permanent,"
// accepted carrier-collision wrongness class, eliminated at the root once
// `m.set('a', 6n)` itself refuses to compile.
test('§14 point 4: documented gap — bitwise both-absent decodes as BigInt 0n, not Number 0 (carrier collision, permanent) — BigInt-into-Map strict-mode (opt-in) collection diagnostic', () => {
  if (onKernel()) return
  for (const op of ['&', '|', '^', '<<', '>>'])
    throws(() => withBigintStrict(() => jz(`export let f = () => { const m = new Map(); m.set('a', 6n); let x = m.get('m1'); let y = m.get('m2'); return x ${op} y }`, { jzify: true })), /BigInt value at this collection/, `${op}: refuses to compile`)
})

// AUDIT #10 BATTERY (.work/archive/todo.md §deletion-sweep §14): the full
// repro set the audit named as live consequences of Slice 4's global VT
// promotion — composed expressions, container storage, kind-specific
// dispatch, String `+` inversion, BigInt joint dispatch. Re-verified
// differentially against real JS with the census dormant (this revert):
// every row the audit named as broken by VT promotion is JS-correct again
// via the generic dynamic path — no new mechanism, the same "disable costs
// nothing, the generic path already handles it" finding every prior slice
// disable also confirmed. Every container is PRIMED with a same-kind write
// before the absent-key read (an empty census has no claim to promote in
// the first place, VT wired or not — priming is what actually exercises the
// bug class).
test('audit #10: composed expressions (ternary/&&/||/comma) around an absent census-NUMBER read are JS-correct with the census dormant', () => {
  const ternary = jz(`export let f = () => { const m = new Map(); m.set('present', 1); return (true ? m.get('missing') : 999) + 1 }`, { jzify: true }).exports.f
  is(ternary(), NaN, 'JS: (true ? undefined : 999) + 1 = NaN')
  const and = jz(`export let f = () => { const m = new Map(); m.set('present', 1); return (true && m.get('missing')) + 1 }`, { jzify: true }).exports.f
  is(and(), NaN, 'JS: (true && undefined) + 1 = NaN')
  const or = jz(`export let f = () => { const m = new Map(); m.set('present', 1); return (false || m.get('missing')) + 1 }`, { jzify: true }).exports.f
  is(or(), NaN, 'JS: (false || undefined) + 1 = NaN')
  const comma = jz(`export let f = () => { const m = new Map(); m.set('present', 1); let y = 0; return ((y = 1), m.get('missing')) + 1 }`, { jzify: true }).exports.f
  is(comma(), NaN, 'JS: (y=1, undefined) + 1 = NaN')
})
test('audit #10: container storage (array-literal index, object-literal prop) around an absent census read is JS-correct with the census dormant', () => {
  const arrIdx = jz(`export let f = () => { const m = new Map(); m.set('present', 1); return [m.get('missing'), 1][0] + 1 }`, { jzify: true }).exports.f
  is(arrIdx(), NaN, 'JS: [undefined, 1][0] + 1 = NaN')
  const objProp = jz(`export let f = () => { const m = new Map(); m.set('present', 1); return ({ x: m.get('missing') }).x + 1 }`, { jzify: true }).exports.f
  is(objProp(), NaN, 'JS: ({x: undefined}).x + 1 = NaN')
  const arrIdxStr = jz(`export let f = () => { const m = new Map(); m.set('present', 's'); return String([m.get('missing'), 1][0]) }`, { jzify: true }).exports.f
  is(arrIdxStr(), 'undefined')
  const objPropStr = jz(`export let f = () => { const m = new Map(); m.set('present', 's'); return String(({ x: m.get('missing') }).x) }`, { jzify: true }).exports.f
  is(objPropStr(), 'undefined')
})
test('audit #10: Array.isArray on an absent ARRAY-census read is JS-correct with the census dormant (was: TRUE)', () => {
  const f = jz(`export let f = () => { const m = new Map(); m.set('present', [1, 2]); return Array.isArray(m.get('missing')) }`, { jzify: true }).exports.f
  is(f(), false, 'JS: Array.isArray(undefined) = false — the audit-#10-live TRUE misfire is gone with the census dormant')
})
// FIXED (audit #10, this task): kind-specific member access / calls on a
// genuinely-undefined census read now get real ES TypeError semantics
// instead of a trap/garbage read/host-side dispatch Error. Mechanism: the
// SAME runtime arms that already existed for an unproven ("kind-unknown")
// receiver — module/core.js emitLengthAccess's `$__length` dispatch,
// emit.js's tryRuntimeStringFork/tryRuntimeNumberMethod/
// externalMethodFallback/emitGenericClosureCall — now check `isNullish`
// (ir.js, the reserved-sentinel-bit test) before falling to their old
// unguarded default, and throw a REAL TypeError object (ir.js
// throwTypeErrorIR, built via the exact `new TypeError(...)` construction
// path — module/core.js buildErrorObject, exposed as
// ctx.core.emit['TypeError']) through the ordinary `$__jz_err` channel — no
// new dispatch pass, no new emission machinery, no cost for a proven (non-
// census, statically-typed) receiver, which returns from one of the arms
// ABOVE these checks and never reaches them. A real Error object (not a bare
// numeric code) is what makes `instanceof TypeError` true in an in-source
// catch (the tag+schema arm of the Error model, audit-#8 P0-2 removed the
// numeric-code range arm as unsound) and what lets interop.js's decodeThrown
// resolve an uncaught throw to a real host TypeError — both paths already
// existed for a user's own `new TypeError()`, reused verbatim.
test('audit #10: kind-specific member access on a genuinely-undefined census read throws a real host-boundary TypeError', () => {
  const arrLen = jz(`export let f = () => { const m = new Map(); m.set('present', [1, 2]); return m.get('missing').length }`, { jzify: true }).exports.f
  let e1 = null; try { arrLen() } catch (e) { e1 = e }
  ok(e1 instanceof TypeError, "JS: TypeError reading 'length' off undefined (ARRAY census)")
  const call = jz(`export let f = () => { const m = new Map(); m.set('present', () => 1); return m.get('missing')() }`, { jzify: true }).exports.f
  let e2 = null; try { call() } catch (e) { e2 = e }
  ok(e2 instanceof TypeError, 'JS: TypeError — undefined is not a function (CLOSURE census)')
  const strLen = jz(`export let f = () => { const m = new Map(); m.set('present', 'hi'); return m.get('missing').length }`, { jzify: true }).exports.f
  let e3 = null; try { strLen() } catch (e) { e3 = e }
  ok(e3 instanceof TypeError, "JS: TypeError reading 'length' off undefined (STRING census)")
  const strSlice = jz(`export let f = () => { const m = new Map(); m.set('present', 'hi'); return m.get('missing').slice() }`, { jzify: true }).exports.f
  let e4 = null; try { strSlice() } catch (e) { e4 = e }
  ok(e4 instanceof TypeError, "JS: TypeError reading 'slice' off undefined (STRING census)")
  const numFixed = jz(`export let f = () => { const m = new Map(); m.set('present', 1); return m.get('missing').toFixed(2) }`, { jzify: true }).exports.f
  let e5 = null; try { numFixed() } catch (e) { e5 = e }
  ok(e5 instanceof TypeError, "JS: TypeError reading 'toFixed' off undefined (NUMBER census)")
})
test('audit #10: the same nullish-receiver checks are catchable IN-WASM, e instanceof TypeError', () => {
  const arrLen = jz(`export let f = () => { const m = new Map(); m.set('present', [1, 2]); try { m.get('missing').length; return false } catch (e) { return e instanceof TypeError } }`, { jzify: true }).exports.f
  is(arrLen(), true, 'catch(e){ e instanceof TypeError } — ARRAY census .length')
  const call = jz(`export let f = () => { const m = new Map(); m.set('present', () => 1); try { m.get('missing')(); return false } catch (e) { return e instanceof TypeError } }`, { jzify: true }).exports.f
  is(call(), true, 'catch(e){ e instanceof TypeError } — CLOSURE census call')
  const strLen = jz(`export let f = () => { const m = new Map(); m.set('present', 'hi'); try { m.get('missing').length; return false } catch (e) { return e instanceof TypeError } }`, { jzify: true }).exports.f
  is(strLen(), true, 'catch(e){ e instanceof TypeError } — STRING census .length')
  const strSlice = jz(`export let f = () => { const m = new Map(); m.set('present', 'hi'); try { m.get('missing').slice(); return false } catch (e) { return e instanceof TypeError } }`, { jzify: true }).exports.f
  is(strSlice(), true, 'catch(e){ e instanceof TypeError } — STRING census .slice()')
  const numFixed = jz(`export let f = () => { const m = new Map(); m.set('present', 1); try { m.get('missing').toFixed(2); return false } catch (e) { return e instanceof TypeError } }`, { jzify: true }).exports.f
  is(numFixed(), true, 'catch(e){ e instanceof TypeError } — NUMBER census .toFixed()')
})
test('audit #10: proven (non-census, statically-typed) receivers are unaffected — no trap, no throw, ordinary JS result', () => {
  const arr = jz(`export let f = () => { const a = [1, 2, 3]; return a.length }`, { jzify: true }).exports.f
  is(arr(), 3, 'a proven ARRAY receiver still reads .length directly, no guard')
  const clo = jz(`export let f = () => { const c = () => 42; return c() }`, { jzify: true }).exports.f
  is(clo(), 42, 'a proven, directly-bound closure call is unaffected')
  const str = jz(`export let f = () => { const s = 'hello'; return s.slice(1) }`, { jzify: true }).exports.f
  is(str(), 'ello', 'a proven STRING receiver still dispatches .slice() directly')
  const num = jz(`export let f = () => { const n = 3.14159; return n.toFixed(2) }`, { jzify: true }).exports.f
  is(num(), '3.14', 'a proven NUMBER receiver still dispatches .toFixed() directly')
})
// audit-#11 P0-3: the five nullish-receiver checks above were themselves
// gated on host:'wasi' being run via env-only (`test:wasi`'s JZ_TEST_HOST
// default), a real but indirect pin — explicit host:'wasi' compiles here so
// the parity holds regardless of how the suite is invoked. Root cause:
// externalMethodFallback (src/compile/emit.js, TOTAL last-resort strategy
// for method calls) had its own `!ctx.transform.targetProfile.envImports`
// early return (the wasi-no-`__ext_call` no-op) BEFORE the audit-#10
// isNullish check a few lines below it — under host:'wasi' (envImports
// always false) that return fired on EVERY call reaching this fallback, so
// the check was dead code for that host alone; `m.get('missing').toFixed(2)`
// read `undefined` under wasi while the identical js-host build correctly
// threw. Fixed by hoisting censusMaybeUndefined/isNullish to run BEFORE the
// envImports branch (RequireObjectCoercible precedes any dispatch-strategy
// choice, ES 13.3) — the other four families (emitLengthAccess,
// tryRuntimeStringFork, emitGenericClosureCall, and tryRuntimeNumberMethod's
// own internal check) never had a capability-nested check to begin with, so
// they were already host-neutral; audited here to confirm, not just assumed.
test('audit #11 P0-3: js/wasi host parity — the five nullish-receiver TypeError checks hold under host:wasi too', () => {
  const src = {
    length: `export let f = () => { const m = new Map(); m.set('present', [1, 2]); return m.get('missing').length }`,
    stringLength: `export let f = () => { const m = new Map(); m.set('present', 'hi'); return m.get('missing').length }`,
    slice: `export let f = () => { const m = new Map(); m.set('present', 'hi'); return m.get('missing').slice() }`,
    toFixed: `export let f = () => { const m = new Map(); m.set('present', 1); return m.get('missing').toFixed(2) }`,
    call: `export let f = () => { const m = new Map(); m.set('present', () => 1); return m.get('missing')() }`,
  }
  for (const [name, code] of Object.entries(src)) {
    for (const host of ['js', 'wasi']) {
      const f = jz(code, { jzify: true, host }).exports.f
      let e = null; try { f() } catch (err) { e = err }
      ok(e instanceof TypeError, `${name} (host:${host}) throws real TypeError`)
    }
  }
})
test('audit #11 P0-3: in-wasm catch parity under host:wasi — e instanceof TypeError for all five families', () => {
  const src = {
    length: `export let f = () => { const m = new Map(); m.set('present', [1, 2]); try { m.get('missing').length; return false } catch (e) { return e instanceof TypeError } }`,
    slice: `export let f = () => { const m = new Map(); m.set('present', 'hi'); try { m.get('missing').slice(); return false } catch (e) { return e instanceof TypeError } }`,
    toFixed: `export let f = () => { const m = new Map(); m.set('present', 1); try { m.get('missing').toFixed(2); return false } catch (e) { return e instanceof TypeError } }`,
    call: `export let f = () => { const m = new Map(); m.set('present', () => 1); try { m.get('missing')(); return false } catch (e) { return e instanceof TypeError } }`,
  }
  for (const [name, code] of Object.entries(src)) {
    const f = jz(code, { jzify: true, host: 'wasi' }).exports.f
    is(f(), true, `${name} (host:wasi) in-wasm catch sees instanceof TypeError`)
  }
})
test('audit #10: String `+` inversion — a STRING-census absent read through `+` is JS-correct with the census dormant (was: static concat "undefined1")', () => {
  const present = jz(`export let f = () => { const m = new Map(); m.set('a', 'x'); return m.get('a') + 1 }`, { jzify: true }).exports.f
  is(present(), 'x1', 'present-key STRING `+` NUMBER still concatenates (unaffected — a real STRING value, not a maybeUndefined coercion)')
  const absent = jz(`export let f = () => { const m = new Map(); m.set('a', 'x'); return m.get('missing') + 1 }`, { jzify: true }).exports.f
  is(absent(), NaN, 'JS: undefined + 1 = NaN, not "undefined1" — the audit-#10-live STATIC-concat-branch misfire is gone with the census dormant')
})
// FIXED (audit-#10 Error-bundle finding-1, 2026-08-04): was a compile-time
// CRASH (module/object.js:535's Object.assign, `internal: stdlib
// '__arr_set_idx_ptr' was requested but never registered`) — a literal `new
// TypeError('x')` used directly as Object.assign's TARGET (never bound to a
// name first) fell through `resolveSchema` unrecognized, routing into
// `emitObjectAssignDynamic`'s dynamic path, which never pulls the `array`
// module its own `__dyn_set` dependency needs. Root-fixed by teaching
// `resolveSchema` (module/object.js) the same literal `new X(...)`/`X(...)`
// Error-constructor-call shape `isErrorSchemaSource` already recognized for
// SOURCE position, now for TARGET position too (and mirrored into
// src/kind.js's `spreadSchema`, kept in sync per its own "must agree with
// resolveSchema" contract) — the schema becomes KNOWN, so Object.assign takes
// its ordinary fixed-schema fast path (mutates the target's own slots in
// place, returns the SAME pointer — Object.assign's real JS semantics: return
// the target, not a new object), never reaching the broken dynamic path at
// all. Object.assign returning the identical pointer it was given also
// preserves the Error's schema id (class identity), closing the provenance
// loss the crash was masking.
test('Object.assign onto a literal (unbound) Error instance mutates it in place, preserving instanceof (was KNOWN-FAIL, audit #10)', () => {
  const f = jz(`export let main = () => { const e = Object.assign(new TypeError('x'), {message: 'y'}); return e instanceof TypeError }`, { jzify: true }).exports.main
  is(f(), true, 'JS: true — Object.assign returns its target unchanged in class/identity')
  const g = jz(`export let main = () => Object.assign(new TypeError('x'), {message: 'y'}).message`, { jzify: true }).exports.main
  is(g(), 'y', 'the message slot was actually overwritten')
})

// Slice 3 (.work/archive/todo.md §deletion-sweep §4/§8 point 3): the
// chokepoint-sweep completion — bigintMixReject (emit.js, the compile-time
// BigInt/Number literal-mix TypeError check) and the `+` STRING-concat raw
// fast path now also consult censusMaybeUndefined (the SAME predicate every
// other chokepoint in this file already asks), the two gaps the design names
// as NEVER covered by the original chokepoint list. HONEST BOUNDARY (mirrors
// Slices 1/2's own §9/§10 finding, verified this session by direct trace):
// neither gap is reachable by ANY live compile today. `bigintMixReject`
// needs `valTypeOf(a) === VAL.BIGINT` to even ask the census question, but
// VT['()']'s own `.get()` dispatch (kind.js, ~line 730 "NO `.get` short-
// circuit here") never promotes a Map/dict read to an exact kind — so
// `valTypeOf` on a census-shaped node (direct or via a mayBeUndefined-
// flagged bare name, whose `val` Slice 1/2 confirmed never settles either)
// stays null, and `aBig`/`bBig` are false regardless of this fix. Same root
// cause blocks the `+` STRING-concat gate. Both fixes are representationally
// correct and become load-bearing the moment Slice 4 (VT re-enablement, §5)
// lands — pinned here as negative controls (genuine BigInt-mix / genuine
// STRING-concat behavior unchanged) so a regression in EITHER surfaces now,
// not silently at Slice 4.
test('Slice 3: bigintMixReject / `+` STRING-concat — negative controls (fix is representationally live, behaviorally inert pre-Slice-4)', () => {
  // genuine BigInt/Number literal mix still throws (bigintMixReject unaffected
  // for a PROVEN, non-census BIGINT operand — the new guard only excuses a
  // maybeUndefined-flagged claim, never a real one).
  let threw = false
  try { run(`return 1n + 1`) } catch (e) { threw = true }
  is(threw, true)
  // genuine BigInt + BigInt still adds normally (no false-positive reject).
  is(run(`return 1n + 2n`), 3n)
  // genuine proven-STRING + STRING concat still takes the raw fast path (no
  // spurious __to_str detour for an ordinary, non-census string operand).
  is(run(`const s = 'a'; const t = 'b'; return s + t`), 'ab')
  is(run(`let s = 'x'; s += 'y'; return s`), 'xy')
})

// Slice 3 acceptance repro table (task's audit-#9-table hop shapes) for a
// NON-'+' arithmetic operator: decl-hop / param-hop / capture-hop all
// ALREADY return JS-correct values at HEAD, independent of Slice 3's own
// two fixes above (neither touches '-') — the census being fully dormant
// (audit-#9 P0-1) means every hop already takes the generic dynamic path,
// which correctly ToNumber-coerces `undefined` to NaN with no static kind
// claim to falsify. Pinned here as a REGRESSION GUARD at this exact hop
// shape (decl/param/capture), not a red→green flip — verified red→green
// only means something once VT re-enables (Slice 4) and an exact kind
// claim starts riding these same hops.
test('Slice 3: decl/param/capture-hop arithmetic already JS-correct (regression pin, not a Slice-3 flip)', () => {
  const declMinus = jz(`export let f = (k) => { const m = new Map(); m.set('a', 1); let x = m.get(k); return x - 1 }`, { jzify: true }).exports.f
  is(declMinus('missing'), NaN)
  is(declMinus('a'), 0)
  const paramMinus = jz(`
    const g = (v) => v - 1
    export let f = (k) => { const m = new Map(); m.set('a', 1); return g(m.get(k)) }
  `, { jzify: true }).exports.f
  is(paramMinus('missing'), NaN)
  is(paramMinus('a'), 0)
  const captureMinus = jz(`export let f = (k) => { const m = new Map(); m.set('a', 1); let x = m.get(k); const h = () => x - 1; return h() }`, { jzify: true }).exports.f
  is(captureMinus('missing'), NaN)
  is(captureMinus('a'), 0)
})

// FIXED (audit, 2026-08): was KNOWN-FAIL — `const g = (v) => v + 1` called with a
// Map absent-key argument through a SEPARATE (non-inlined) function returned
// `undefined` instead of `NaN`. Root-caused past the earlier trace (`optimize:false`
// vs default byte-for-byte diff showed emit.js's `+` handler correctly emitting the
// SAFE runtime-dispatch form — `__is_str_key` guard + the NaN self-compare atom
// ladder — and the POST-optimize module having it collapsed to a bare `f64.add`):
// the eliminating pass is `foldStrDispatchF64` (src/optimize/index.js), gated on
// `vectorizeLaneLocal` (default-on at level 2+, so it fired even with `watr:false`
// — confirmed NOT a watr-package bug via per-pass bisection over every PASS_NAMES
// entry against `{level:2, watr:false}`). Its "proof" that a `(param $v f64)` can
// never carry a string/atom NaN-box is FALSE under jz's NaN-boxing ABI — every
// dynamically-typed value (string, undefined, null, a bool atom, a boxed object)
// is carried in an f64-typed local exactly like a genuine number, so a bare
// declared-f64 param proves nothing about its runtime domain. The fold's actual
// intended and ONLY sound use is `pureFuncMap`-driven inline substitution into a
// per-pixel-color SIMD lane loop (tryPerPixelColor, src/optimize/vectorize.js),
// where the substituted argument IS independently proven numeric (a per-lane
// typed-array read) — but it ran on (and mutated in place) the real, standalone,
// module-emitted function body too, both via `buildPureFuncMap` (src/wat/
// assemble.js) building `pureFuncMap` by folding `funcs` entries directly, and via
// a second, redundant direct call inside `optimizeFunc` before `vectorizeLaneLocal`.
// FIX: `buildPureFuncMap` now folds a deep CLONE per candidate (the clone alone
// populates `pureFuncMap`, used only by the lane-proven inline path); the second
// direct call inside `optimizeFunc` is removed outright (no lane-proven substitution
// context exists there — it was folding the callee's own declaration, the same
// unsound premise). Sibling shapes verified same-fix (see next test): dict absent-
// key param-hop, double param-hop, an in-loop param-hop, and an out-of-bounds array
// read all through the identical `(v) => v + 1`-shaped single-call-site guard.
test('single-call-site "+" param-hop: absent Map key through a separate callee is JS-correct (regression pin, was KNOWN-FAIL)', () => {
  const paramPlus = jz(`
    const g = (v) => v + 1
    export let f = (k) => { const m = new Map(); m.set('a', 1); return g(m.get(k)) }
  `, { jzify: true }).exports.f
  is(paramPlus('missing'), NaN)   // JS: undefined + 1 === NaN
  is(paramPlus('a'), 2)           // present-key stays correct
})

// Sibling sweep for the SAME foldStrDispatchF64/pureFuncMap fix (audit, 2026-08):
// every carrier-domain producer feeding the identical single-call-site "+"
// param-hop guard shape, not just Map.get. All were unsound before the fix
// (foldStrDispatchF64 mutated the real function regardless of producer) and are
// JS-correct after it (regression pins).
test('single-call-site "+" param-hop: sibling carrier-domain producers (regression pins)', () => {
  // dict (not Map) absent key
  is(jz(`
    const g = (v) => v + 1
    export let f = (k) => { const d = {}; d['a'] = 1; return g(d[k]) }
  `, { jzify: true }).exports.f('missing'), NaN)
  // two-hop param chain (g -> h, both single-call-site)
  is(jz(`
    const h = (v) => v + 1
    const g = (v) => h(v)
    export let f = (k) => { const m = new Map(); m.set('a', 1); return g(m.get(k)) }
  `, { jzify: true }).exports.f('missing'), NaN)
  // param used inside the callee's OWN loop, not just a leaf expression
  is(jz(`
    const g = (v) => { let s = 0; for (let i = 0; i < 3; i++) { s = s + v }; return s }
    export let f = (k) => { const m = new Map(); m.set('a', 1); return g(m.get(k)) }
  `, { jzify: true }).exports.f('missing'), NaN)
  // out-of-bounds array read
  is(jz(`
    const g = (v) => v + 1
    export let f = (k) => { const a = [1, 2, 3]; return g(a[k]) }
  `, { jzify: true }).exports.f(10), NaN)
})

// Slice 4 (.work/archive/todo.md §deletion-sweep §8, VT re-enablement) —
// dictValueKindOf/mapValueKindOf wired back into VT['[]']/VT['.']/VT['()'].
// §5 criterion 1's own acceptance shape: a census claim reaching a
// NON-chokepoint consumer through 2+ hops (decl → arg → return → use), not
// just the single-hop repros earlier slices pinned.
//
// REVERTED (audit #10, §14 — the four "Slice 4" pins below): VT['[]']/
// ['.']/['()']'s exact-kind promotion is dormant again, same reason as this
// file's audit-#9-era "RENAMED"/"RE-RENAMED" pins above. Kept exactly as
// written and STILL GREEN — every assertion here is a JS-VALUE correctness
// pin, not a WAT-codegen-shape pin, and the generic dynamic dispatch path
// (the only path live once the census stops claiming an exact kind) already
// produces the correct value for all four shapes — the audit's own finding,
// re-confirmed: "the generic dynamic paths handle it, that's been true at
// every prior disable."
test('Slice 4: multi-hop (decl -> call-arg -> return -> use) arithmetic stays JS-correct', () => {
  const f = jz(`
    const inner = (v) => v
    const relay = (v) => inner(v)
    export let f = (k) => {
      const m = new Map(); m.set('a', 1)
      let x = m.get(k)
      let y = relay(x)
      return y + 1
    }
  `, { jzify: true }).exports.f
  is(f('missing'), NaN)
  is(f('a'), 2)
})

// Slice 4 IDENTITY-fold acceptance, live for the first time (Slices 1-3 were
// representationally complete but inert here per their own honest-boundary
// notes — `val` never settled non-null at any hop while VT stayed dormant).
// Decl/param/capture-hop `=== undefined` on a bare name that traces to a
// census read.
test('Slice 4: decl/param/capture-hop identity compare (`=== undefined`) on a census-traced bare name', () => {
  const decl = jz(`export let f = (k) => { const m = new Map(); m.set('a', 1); let x = m.get(k); return x === undefined ? 1 : 0 }`, { jzify: true }).exports.f
  is(decl('missing'), 1)
  is(decl('a'), 0)
  const param = jz(`
    const g = (v) => v === undefined ? 1 : 0
    export let f = (k) => { const m = new Map(); m.set('a', 1); return g(m.get(k)) }
  `, { jzify: true }).exports.f
  is(param('missing'), 1)
  is(param('a'), 0)
  const capture = jz(`export let f = (k) => { const m = new Map(); m.set('a', 1); let x = m.get(k); const h = () => x === undefined ? 1 : 0; return h() }`, { jzify: true }).exports.f
  is(capture('missing'), 1)
  is(capture('a'), 0)
})

// Slice 4 gap found LIVE while walking §5 criterion 3's chokepoint-composition
// check (kind.js `callResultMayBeUndefinedKind`, new): a call to a
// non-inlined user function whose whole-program return-kind fixpoint
// (narrow.js narrowValResults, Slice 2) settled BOTH a definite `valResult`
// kind AND `valResultMayBeUndefined` is a census fact one call-hop removed.
// Before this fix, `g(k) === undefined` constant-folded to the SAME wrong
// boolean for a present AND an absent key (kind-traits.js calleeValType
// returns `f.valResult` with no accompanying mayBeUndefined signal, and
// nothing consulted `valResultMayBeUndefined` — it existed only for
// ctx.inspect, per reps.js's own doc comment). `g` must NOT be a
// single-expression arrow here — those inline before this check ever runs,
// which is exactly why this class survived the multi-hop test above
// unnoticed (relay/inner there both got inlined into a direct `.get()` node).
test('Slice 4: call-result identity compare (`g(k) === undefined`) through a non-inlined callee (regression pin, found live)', () => {
  const f = jz(`
    const m = new Map(); m.set('a', 1)
    const g = (k) => { let s = 0; for (let i = 0; i < 1; i++) s = s + i; return m.get(k) }
    export let f = (k) => g(k) === undefined ? 1 : 0
  `, { jzify: true }).exports.f
  is(f('missing'), 1)
  is(f('a'), 0)
})

// Slice 4 gap #2, found live continuing the SAME investigation: the
// ARITHMETIC sibling of the identity-fold gap above. `g(k) + 1` through a
// non-inlined callee whose result may be undefined silently returned JS
// `undefined` instead of `NaN` (ir.js toNumF64's `vt === VAL.NUMBER &&
// censusMaybeUndefined(node)` gate, :999-1012 — calleeValType already
// trusted `f.valResult` unconditionally; the fix above made
// censusMaybeUndefined see the call-result claim, but toNumF64's own
// `coerceNullishToNum` wrapper wasn't reachable through it yet either).
test('Slice 4: call-result arithmetic (`g(k) + 1`) through a non-inlined callee is JS-correct (regression pin, found live)', () => {
  const f = jz(`
    const m = new Map(); m.set('a', 1)
    const g = (k) => { let s = 0; for (let i = 0; i < 1; i++) s = s + i; return m.get(k) }
    export let f = (k) => g(k) + 1
  `, { jzify: true }).exports.f
  is(f('missing'), NaN)
  is(f('a'), 2)
})

// Slice 4 SOUNDNESS regression found and fixed while landing the two pins
// above: `coerceNullishToNum` (ir.js) is documented as requiring its input
// be side-effect-free — true for the ORIGINAL dict/Map-read and bare-name
// census arms (a pure read), but the NEW call-result arm can carry a
// genuinely side-effecting call (a captured-mutation counter, here). Before
// the fix (hoist into a temp before coerceNullishToNum's triplicating
// cloneIR, ir.js toNumF64), `g(k) + 1` where `g` mutates a captured local as
// a side effect ran `g` THREE TIMES instead of once — count/total-calls came
// out at 3x the correct value. This is the exact `audit-#8 P0-2`/e79b0647
// captured-mutation class, one call-hop further out.
test('Slice 4: call-result arithmetic does not triplicate a captured-mutation side effect (soundness regression pin)', () => {
  const f = jz(`
    export const main = (k) => {
      let count = 0
      const xs = [1, 2, 3, 4, 5]
      const at = (i) => { count = count + 1; return xs[i] }
      let s = 0
      for (let i = 0; i < xs.length; i++) s += at(i)
      return s * 1000 + count
    }
  `, { jzify: true }).exports.main
  is(f(0), 15005, 's=15 (sum of xs), count=5 (one increment per call) — not 15015 (count tripled)')
})

// Slice 7 (.work/archive/todo.md §deletion-sweep §14/§15, "widen the
// opt-in consumer chokepoints"): the arithmetic/coercion chokepoints
// (ir.js toNumF64, emit.js's binary `+` BigInt dispatch) gated on
// `valTypeOf(node)` FIRST and never saw a decl/direct census claim (`vt`
// stays permanently null for this shape, §14 point 3) — widened to also
// consult `censusMaybeUndefinedKind`/`presentVal` directly, the SAME
// discipline `nullableOperand`/`bigIntOperand`/`bigIntUnary` already had
// (found, while landing this slice, to NOT need widening — they already
// call the census predicate unconditionally, never gated on `vt` first).
//
// Real, live value-correctness win, found and verified (not assumed): a
// binary `+` between two decl-hop present-key BigInt census reads — NEITHER
// side separately provable (no literal, no unary wrapper) — fell through to
// the generic dynamic-NUMBER `+` dispatch, which did `f64.add` on the raw
// i64-reinterpreted-as-f64 BigInt carrier bits (nonsense float arithmetic on
// two tiny subnormals) AND, even had the i64 arithmetic itself been correct,
// the export-boundary decode (compile/index.js `_resultNumeric`/
// `_resultBigintSentinel`) had no way to know this `+` node's result was
// really a BigInt (VT['+']'s own "unknown operand → optimistic NUMBER"
// default). Both fixed together: emit.js's `bothBigIntOperands` (an AND, not
// an OR — see its own doc comment for why an OR would silently corrupt a
// BigInt-census-operand-paired-with-a-real-NUMBER mix, the exact §14 point 4
// out-of-scope class) routes the WASM computation through the correct i64
// `bigIntOperand`/`bigIntMixReject` machinery; VT['+']'s own both-census
// upgrade plus `censusBigintSentinelKind`'s new kind-4 arm (kind.js) teach
// the SAME both-census fact to the export lane, so the return crosses the
// boundary as a real i64 BigInt, not a misdecoded NUMBER.
// BigInt retirement Slice 1 (.work/archive/bigint-retirement-design.md §4/§7): every
// shape below shares the "collection" precondition `m.set(k, 5n)`/`d[k]=5n`.
test('Slice 7: decl-hop binary `+` between two present-key BigInt census reads crosses the export boundary correctly (was garbage NUMBER) — BigInt-into-Map/dict strict-mode (opt-in) collection diagnostic', () => {
  if (onKernel()) return
  throws(() => withBigintStrict(() => jz(`export let f = () => { const m = new Map(); m.set('a', 5n); m.set('b', 3n); let x = m.get('a'); let y = m.get('b'); return x + y }`, { jzify: true })), /BigInt value at this collection/)
  throws(() => withBigintStrict(() => jz(`export let f = (k, j) => { const d = {}; d[k] = 5n; d[j] = 3n; let x = d[k]; let y = d[j]; return x + y }`, { jzify: true })), /BigInt value at this collection/)
})

// Negative controls (Slice 7): a single census-BigInt operand paired with a
// PROVEN (non-census) side shares the same "collection" precondition. The
// genuine literal BigInt/Number mix (bigIntMixReject, arithmetic-core, a
// different mechanism) and genuine BigInt+BigInt arithmetic (no Map/dict
// involved at all) are unaffected — kept as-is.
test('Slice 7: negative controls — single-proven-side BigInt mixes and genuine literal mixes are unaffected', () => {
  if (onKernel()) return
  throws(() => withBigintStrict(() => jz(`export let f = () => { const m = new Map(); m.set('a', 5n); let x = m.get('a'); return x + 3n }`, { jzify: true })), /BigInt value at this collection/)
  let threw = false
  try { jz('export let f = () => { return 1n + 1 }', { jzify: true }) } catch (e) { threw = true }
  ok(threw, 'genuine BigInt/Number literal mix still throws at compile time')
  is(jz('export let f = () => { return 1n + 2n }', { jzify: true }).exports.f(), 3n, 'genuine BigInt+BigInt (no census involved) unaffected')
})

// GENERAL valTypeOfWithLocals gap CLOSED (round-7, follow-up to Slice 7/
// 38dd0dca): that entry pinned two DISTINCT sub-shapes together under one
// "pre-existing, general valTypeOfWithLocals gap" umbrella. Splitting them
// here, now that the root cause is actually understood:
//
//   (a) a LOCALLY-provable BigInt (`let x = BigInt(v)`, or any other decl
//       `analyzeBody` can settle a `valTypes` fact for) flowing through `-`/
//       `*`/`/`/`%`/the bitwise family — genuinely the `valTypeOfWithLocals`
//       gap the old comment named: its SOUND `+` arm computed `a`/`b` via
//       `rec` (the local resolver) but then DISCARDED them, falling through
//       to a blind `valTypeOf(expr)` re-derivation that can only see MODULE-
//       global facts, never a plain local — so a local proven BIGINT through
//       `rec` still locked in a WRONG `func.valResult`/`_resultNumeric`
//       NUMBER claim. Confirmed live even for `+` itself (contradicting the
//       old comment's premise that `+` was already immune — it wasn't; `rec`
//       and the final derivation just happened to agree whenever the operand
//       ALSO existed as a global). Fixed: every arm computes its result
//       DIRECTLY from `rec`'s own `a`/`b`, never re-derives blindly. See the
//       "FIXED" test below.
//   (b) a CENSUS-provable BigInt (`m.get(k)`, no `presentVal`/`valTypes` fact
//       — that machinery is a totally separate fact system `resolveLocal`
//       never consults) and a fully-opaque, zero-evidence PARAM (a plain
//       `export let f = (a, b) => a - b` called directly from the JS host,
//       no in-source call site or decl to prove anything). NEITHER is a
//       `valTypeOfWithLocals` gap — (a)'s fix doesn't and can't touch them.
//       (b-census) is FIXED below (§14 point 4, audit #10): emit.js's
//       `bigIntJointDispatch` (the joint runtime-domain dispatch superseding
//       the old per-op OR/AND gates) plus kind.js's `censusBigintBinaryVT`/
//       `censusBigintSentinelKind` generalization from `+`-only to all 9 ops
//       closes the WASM-computation AND export-decode halves together — a
//       census fact and a locally-resolved fact are different inputs to the
//       SAME function, and this slice adds the census-side arm valTypeOfWithLocals's
//       own local-side arm didn't touch. (b-param) remains pinned below,
//       unchanged, its own separate reason: architecturally out of reach of
//       ANY static-proof mechanism — an unboxed dynamic export param crossing
//       the JS↔wasm boundary has no runtime tag distinguishing "raw BigInt
//       carrier" from "a genuinely tiny subnormal float the program computed"
//       (interop.js's own `bits`/`i64ToF64` doc comments), so disambiguating
//       it needs NEW boxing infrastructure at the boundary (§6's
//       presentKindUnboxed/bigintBoxed producer gap), not a runtime-dispatch
//       fix — §14 point 4's own subnormal-magnitude heuristic (the SAME one
//       `typeof x === 'bigint'` uses) is exactly the tool `bigIntJointDispatch`
//       reuses for a param mixed with a PROVEN BigInt (see the FIXED test
//       further below) — but two ZERO-evidence params paired together have no
//       side to prove ANY bigint evidence in the first place, so the joint
//       dispatch never even activates (by design — §14 point 4's own "only
//       emits where the static analysis says domains CAN mix" scope).
// BigInt retirement Slice 1 (.work/archive/bigint-retirement-design.md §4/§7): same
// "collection" precondition (`m.set('a', 6n)`) as the §14 point 4 tests
// above.
test('§14 point 4 FIXED: the 9-op census-BigInt sub-case now crosses the export boundary as a real bigint (was: number) — BigInt-into-Map strict-mode (opt-in) collection diagnostic', () => {
  if (onKernel()) return
  for (const op of ['-', '*', '/', '%', '&'])
    throws(() => withBigintStrict(() => jz(`export let f = () => { const m = new Map(); m.set('a', 6n); m.set('b', 3n); let x = m.get('a'); let y = m.get('b'); return x ${op} y }`, { jzify: true })), /BigInt value at this collection/, `${op}: refuses to compile`)
})
test('zero-evidence host BigInt REJECTS at the wrapper (phase-c C4b correct-or-reject; was KNOWN-FAIL silent misdecode)', () => {
  // A plain, zero-evidence exported param pair is architecturally out of
  // reach of any static proof (see the block comment above) — the old
  // behavior silently misdecoded (returned a number where JS says 2n). The
  // ratified policy is correct-or-reject: the interop wrapper now throws a
  // typed error naming both remedies. Params WITH evidence take the tagged
  // ingress and work dynamically (the host-ingress test above).
  const plainSub = jz('export let f = (a, b) => a - b', { jzify: true }).exports.f
  throws(() => plainSub(5n, 3n), /BigInt argument at param 0 of f\(\) has no BigInt evidence/,
    'zero-evidence BigInt ingress refuses loudly instead of silently misdecoding')
})

// --- phase-c C4b: jz:hostabi — ONE per-export per-slot host-BigInt ingress
// policy authority, replacing jz:bigintbox's bare boolean membership
// (external audit P0 #1/#2). i64Arg (interop.js) now dispatches on an
// explicit enum per slot — raw | tag | (absent = reject) — instead of
// reading "absent from the box map" as "reject" with no way to represent a
// hypothetical proven-raw slot. The five states below are the full space the
// audit asked to pin; see each test for which are reachable.

test('phase-c C4b (1): proven-RAW BigInt export param is architecturally UNREACHABLE today — documented, not a regression', () => {
  // jz:hostabi's `raw` field is real wire format and interop.js's i64Arg
  // dispatches on it (a plain bigint would pass straight through, no box —
  // native wasm BigInt→i64 coercion) — but the current compiler never
  // populates it. Reachability proof (representation-plan.js): makeBoundaryData
  // sets `uncovered = isExported(...)` UNCONDITIONALLY for every exported
  // function's params — the JS host can call with ANY value regardless of
  // what the function body proves about its own internal call sites,
  // so the export boundary can never be "closed world" the way an
  // internal-only call graph can. `uncovered` forces `currentParamRep` to
  // ANY_BIGINT (never CLOSED) for any param that may touch bigint at all;
  // `targetRepFor` only returns RAW_BIGINT when `current` IS closed — with
  // `current` forced open, every path falls through to BOXED_BIGINT
  // instead. Verified empirically against the STRONGEST evidence shape
  // (direct bigint arithmetic on the param, no typeof guard at all) — even
  // stronger than the reachable "tagged" shape below — and it still produces
  // NO jz:hostabi entry whatsoever (the census's own optimistic NUMBER
  // default wins before RepresentationPlan's boundary logic would even get a
  // chance to choose BOXED over RAW): the export stays a zero-evidence f64
  // numeric slot, pin (3) below, not a raw-bigint acceptor.
  const td = new TextDecoder()
  const hostAbiOf = (src) => {
    const wasm = compile(src, { jzify: true })
    const secs = WebAssembly.Module.customSections(new WebAssembly.Module(wasm), 'jz:hostabi')
    return secs.length ? JSON.parse(td.decode(secs[0])) : null
  }
  is(hostAbiOf('export let f = (n) => n * 2n'), null,
    'direct bigint arithmetic on a zero-evidence param: no hostabi entry at all — not raw, not tagged')
  const tagged = hostAbiOf(`export let check = value => typeof value === 'bigint'`)
  is(tagged[0].raw, undefined, 'raw is never populated by the current compiler')
  ok(tagged[0].tag.includes(0), 'the one reachable evidenced state lands tag, never raw')
})

test('phase-c C4b (2): tagged (evidenced) BigInt param accepts plain bigint via the box path and computes correctly', () => {
  // The one REACHABLE evidenced state — jz:hostabi's `tag` array (formerly
  // jz:bigintbox's whole content). Broader coverage of this state: test/data.js
  // "RepresentationPlan: host ingress distinguishes JS BigInt from Number
  // bits". Result asserted via comparison, not a raw returned bigint: a
  // Number/BigInt-MIXED ternary RESULT has its own pre-existing, UNRELATED
  // egress gap (confirmed present on unmodified da831ded too, before any C4b
  // change — `value => typeof value==='bigint' ? value*3n : value*3` returns
  // a reinterpreted-float garbage number for the bigint arm, since the
  // export wrapper's resultDynamic/generic-decode lane can't tell a genuine
  // small raw BigInt's i64 bits from a NaN-box-reinterpreted float). That's
  // an EGRESS concern — this task redesigns INGRESS only — so the pin below
  // keeps the mixed value fully wasm-internal and crosses only an
  // unambiguous boolean, sidestepping it.
  const { exports: e } = jz(`
    export let check = value => typeof value === 'bigint'
    export let math = value => typeof value === 'bigint' ? value * 3n === 15n : value * 3 === 15
  `, { jzify: true })
  is(e.check(5n), true)
  is(e.check(2), false)
  is(e.math(5n), true, 'tagged BigInt ingress unboxes in wasm and computes correctly')
  is(e.math(5), true, 'the Number arm is unaffected')
  is(e.math(2), false, 'wrong magnitude correctly rejected (not a vacuous true)')
})

// (3) zero-evidence FIXED param rejects: the pre-existing test immediately above this block.

test('phase-c C4b (4) NEW: zero-evidence REST BigInt argument REJECTS — audit P0 #2, was silent decimal-string stringify', () => {
  // Before this fix, interop.js's rest path bypassed i64Arg entirely:
  // `mem.Array(args.slice(fixed))` ran every element through mem.wrapVal,
  // which turned a plain bigint into a decimal STRING
  // (`mem.String(v.toString())`) — silent-wrong, the worst class: no error,
  // a numeric consumer silently received a string instead of a computed
  // value or a thrown error.
  const f = jz('export let f = (...args) => args.length', { jzify: true }).exports.f
  is(f(1, 2, 3), 3, 'sanity: ordinary rest args unaffected')
  throws(() => f(5n, 3n), /BigInt argument in the rest arguments of f\(\) has no BigInt evidence/,
    'a zero-evidence BigInt rest element refuses loudly instead of silently stringifying')
})

test('phase-c C4b (5): rest-element BigInt evidence has no plan source today — rejects even alongside a tagged FIXED sibling', () => {
  // Rest elements are host-populated (interop's own mem.Array), never a
  // traceable in-program def site RepresentationPlan's provenance solver can
  // reach (zero "rest" references anywhere in representation-plan.js) — so
  // jz:hostabi's `rest` flag is never true today; documented unsupported,
  // not merely untested. Demonstrated against a function whose FIXED sibling
  // param IS evidenced (tagged, works) to show the two policies are
  // independent — evidence on one slot never leaks tag treatment onto
  // another.
  const f = jz(`
    export let f = (flag, ...args) => { if (typeof flag === 'bigint') return flag; return args.length }
  `, { jzify: true }).exports.f
  is(f(1, 2, 3), 2, 'sanity: fixed+rest split unaffected')
  is(f(5n), 5n, 'the FIXED param, evidenced, tags and computes correctly')
  // NEGATIVE tagged FIXED param (interop.js isBox fix, test/inference.js):
  // a raw negative host BigInt's two's-complement sign-extension used to
  // collide with isBox's sign-blind mask, so this exact box-then-passthrough
  // shape read back a garbage/zero value instead of the round-tripped -5n.
  is(f(-5n), -5n, 'the FIXED param, evidenced, tags and round-trips a NEGATIVE BigInt correctly too')
  throws(() => f(1, 5n), /BigInt argument in the rest arguments of f\(\) has no BigInt evidence/,
    'the REST element, zero-evidence, still rejects even though the sibling fixed slot is tagged')
})

// FIXED (round-7): `valTypeOfWithLocals`'s binary arms (kind.js) now settle
// BIGINT-vs-NUMBER directly from `rec`'s own locally-resolved operand kinds
// — for `+` (previously silently wrong for this exact shape despite the
// "SOUND +" framing, see above) and its `-`/`*`/`/`/`%`/`&`/`|`/`^`/`<<`/`>>`
// siblings (previously had no local-aware handling AT ALL, falling straight
// to the file-ending `valTypeOf(expr)` catch-all). `BigInt(v)` is a
// compile-time-KNOWN-BIGINT-returning callee (kind-traits.js CALLEE_VAL) —
// analyzeBody's decl-time `valTypes` tracker already recorded `x`/`y` as
// BIGINT; only the WITHOUT-locals re-derivation the export-lane decision
// depended on was blind to it.
// Native BigInt operator functions (no `eval` — this repo's own errors.js
// pins `eval` as a prohibited construct in COMPILED source; using it here to
// compute an expected value in the TEST HARNESS is a different concern, but
// explicit functions keep the oracle unambiguous either way).
const BIGINT_OP = {
  '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b,
  '/': (a, b) => a / b, '%': (a, b) => a % b,
  '&': (a, b) => a & b, '|': (a, b) => a | b, '^': (a, b) => a ^ b,
  '<<': (a, b) => a << b, '>>': (a, b) => a >> b,
}

test('round-7: local BigInt() decls through every binary arithmetic/bitwise op cross the export boundary correctly', () => {
  const ops = ['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>']
  const two = (op, v, w) => jz(`export let f = (v, w) => { let x = BigInt(v); let y = BigInt(w); return x ${op} y }`,
    { jzify: true }).exports.f(v, w)
  for (const op of ops) {
    const got = two(op, 6, 3)
    const want = BIGINT_OP[op](6n, 3n)
    is(got, want, `${op}: 6n ${op} 3n`)
    is(typeof got, 'bigint', `${op}: result is a real bigint`)
  }
  // Negative operands (sign-sensitive: division truncation, arithmetic right
  // shift, two's-complement bitwise) — the class the plain small-positive
  // pins above can't distinguish from a lucky subnormal-arithmetic coincidence.
  for (const op of ops) is(two(op, -7, 2), BIGINT_OP[op](-7n, 2n), `${op}: negative operand`)
  // `/` truncates TOWARD ZERO per BigInt division (ES2024 6.1.6.2.4), not
  // floor — the class that would silently disagree with Math.floor semantics.
  is(two('/', -7, 2), -3n, 'BigInt / truncates toward zero: -7n/2n === -3n, not -4n (floor)')
  is(two('/', 7, -2), -3n, 'BigInt / truncates toward zero: 7n/-2n === -3n, not -4n')
})

// round-7: `<<`/`>>` NEGATIVE shift amount — ES2024 13.2.9/13.2.10
// BigInt::leftShift/rightShift flip DIRECTION on a negative shift count
// (`x << -3n` === `x >> 3n`, exactly), unlike Number `<<`/`>>` (ToInt32 & 31,
// no direction flip) or WASM's native i64.shl/i64.shr_s (shift count mod 64,
// also no sign awareness — a naive port silently wraps `-3` to a 61-bit
// wrong-direction shift). Found live sweeping this fix's own acceptance
// criteria, fixed via bigIntShiftIR (emit.js) alongside the arms above.
test('round-7: BigInt `<<`/`>>` flips direction on a negative shift amount (JS spec 13.2.9/13.2.10)', () => {
  const shift = (op, v, w) => jz(`export let f = (v, w) => { let x = BigInt(v); let y = BigInt(w); return x ${op} y }`,
    { jzify: true }).exports.f(v, w)
  is(shift('<<', 6, -3), 6n << -3n); is(shift('<<', 6, -3), 0n)
  is(shift('>>', 6, -3), 6n >> -3n); is(shift('>>', 6, -3), 48n)
  is(shift('<<', -6, -3), -6n << -3n); is(shift('<<', -6, -3), -1n)
  is(shift('>>', -6, -3), -6n >> -3n); is(shift('>>', -6, -3), -48n)
  // `<<=`/`>>=` compound-assign shares the identical binary-op fix (emit.js).
  const compound = (op, v, w) => jz(`export let f = (v, w) => { let x = BigInt(v); x ${op} BigInt(w); return x }`,
    { jzify: true }).exports.f(v, w)
  is(compound('<<=', 6, -3), 0n); is(compound('>>=', 6, -3), 48n)
})

// round-7: comparisons (`<` `>` `<=` `>=`) over locally-proven-BigInt operands
// — verified, not assumed, per this fix's own sweep discipline. Already
// correct at HEAD (VT.bool/CMP_OPS ignore operand kind entirely — always
// VAL.BOOL — so there was never a static-claim gap here); pinned so a future
// change can't regress it silently.
test('round-7: comparisons over local BigInt() decls are (and stay) JS-correct', () => {
  const cmp = (op, v, w) => jz(`export let f = (v, w) => { let x = BigInt(v); let y = BigInt(w); return x ${op} y }`,
    { jzify: true }).exports.f(v, w)
  const CMP_OP = { '<': (a, b) => a < b, '>': (a, b) => a > b, '<=': (a, b) => a <= b, '>=': (a, b) => a >= b }
  for (const [op, v, w] of [['<', 5, 2], ['<', 2, 5], ['<', 5, 5], ['>', -5, 2], ['<=', 5, 5], ['>=', -5, -2]])
    is(cmp(op, v, w), CMP_OP[op](BigInt(v), BigInt(w)), `${op} ${v} ${w}`)
})

// FIXED (§14 point 4, audit #10): real JS throws TypeError mixing BigInt and
// Number in arithmetic (ES2024 6.1.6.2.20 step 6, "Type(lnum) is not
// Type(rnum)") — `bigintMixReject` (emit.js) already implemented this
// correctly at COMPILE TIME for a provable mix (one side a genuine BigInt,
// the other a numeric LITERAL — see the negative-controls test above), but
// had no RUNTIME check at all for a proven-BigInt side paired with a
// genuinely dynamic (zero-evidence) other operand. Fixed by
// `bigIntDomainsCanMix`/`bigIntJointDispatch` (emit.js): a proven-BigInt side
// paired with an UNRESOLVED other operand now runs the SAME runtime magnitude
// heuristic `typeof x === 'bigint'` already uses (finite, nonzero, subnormal
// abs) on the unresolved side — `w`'s raw bits (a genuine small Number, 2.0)
// are NOT subnormal-shaped, so the joint check correctly resolves a domain
// mismatch and throws, matching real JS. `valTypeOfWithLocals`'s own
// arithmetic/bitwise arm (kind.js, the round-7 general fix) already claimed
// BIGINT for this shape's export lane (one side statically proven BigInt is
// enough); this slice's own contribution is the WASM-computation half that
// claim needed to actually be sound.
test('§14 point 4 FIXED: a proven-local BigInt mixed with a zero-evidence dynamic param throws TypeError (was: silently wrong bigint)', () => {
  const f = jz('export let f = (v, w) => { let x = BigInt(v); return x - w }', { jzify: true }).exports.f
  let threw = null
  try { f(5, 2) } catch (e) { threw = e }
  ok(threw instanceof TypeError, 'JS: TypeError (Number 2 mixed with BigInt 5n)')
  // Negative control: two proven-local BigInts (no zero-evidence side at all)
  // stay on their existing, unaffected fast path — byte-identical structural
  // pin, verified by the "round-7: local BigInt() decls..." test suite above;
  // repeated here narrowly for this exact function shape.
  const both = jz('export let f = (v, w) => { let x = BigInt(v); let y = BigInt(w); return x - y }', { jzify: true }).exports.f
  is(both(5, 2), 3n)
  is(typeof both(5, 2), 'bigint')
})

// FLIPPED, for a MODULE-level (global) census receiver (§16→§18 "presentVal
// param producers", narrow.js's hardParamPresentVal): a PARAM now gets a
// `presentVal` producer — the inter-procedural, poison-on-disagreement
// call-site fold §15's own decl/reassign-only scope named as future work.
// A BigInt-census value passed as a call-site ARGUMENT into a callee that
// applies unary `-`/`~` to its own parameter now correctly seeds that
// param's `presentVal`, so `emitNeg`/`~`'s own OR-arm
// (censusMaybeUndefinedKind, already asking unconditionally — §16's own
// "needed NO widening" finding) sees VAL.BIGINT instead of null. The
// export-boundary decode ALSO needed its own fix, found live while flipping
// this: `censusBigintSentinelKind`'s new kind-5 arm (kind.js) recognizes a
// call whose callee is exactly this `(v) => -v`/`(v) => ~v` shape — the WASM
// computation was already correct once presentVal seeded the param, but
// narrowValResults' own return-kind join can't observe a param-hop fact for
// this same ordering reason (its own fixpoint runs before narrow.js's
// presentVal param propagation ever populates paramReps — the identical gap
// 15c789ac's own commit documented for mayBeUndefined's return-kind join),
// so the export decode needed a separate, self-contained structural check
// rather than reusing that join.
//
// The local-receiver sibling below now has its own straight-line proof and
// fail-closed rejection for control-dependent BigInt writes.
// BigInt retirement Slice 1 (.work/archive/bigint-retirement-design.md §4/§7): same
// "collection" precondition (`m.set('a', 5n)`, a module-level Map) as every
// other test in this file.
test('single-call-site unary `-` param-hop: present-key BigInt census value (module-level Map) through a callee is JS-correct (regression pin, was KNOWN-FAIL) — BigInt-into-Map strict-mode (opt-in) collection diagnostic', () => {
  if (onKernel()) return
  throws(() => withBigintStrict(() => jz(`
    const m = new Map(); m.set('a', 5n)
    const g = (v) => -v
    export let f = () => g(m.get('a'))
  `, { jzify: true })), /BigInt value at this collection/)
})
// Negative control — same precondition.
test('single-call-site unary `-` param-hop: absent Map key (module-level Map) through a callee is JS-correct — BigInt-into-Map strict-mode (opt-in) collection diagnostic', () => {
  if (onKernel()) return
  throws(() => withBigintStrict(() => jz(`
    const m = new Map(); m.set('a', 5n)
    const g = (v) => -v
    export let f = () => g(m.get('missing'))
  `, { jzify: true })), /BigInt value at this collection/)
})

// Plan-time has no caller localReps installed. A straight-line local Map proof
// therefore scans only the caller's top-level statement prefix: one new Map,
// literal-key set writes of one exact kind, no control flow, alias, delete, or
// dynamic key. Anything broader that may carry BigInt rejects instead of
// falling through to Number unary arithmetic.
test('local Map present-key BigInt crosses a unary parameter hop', () => {
  for (const optimize of levels(false, 2, 3)) {
    const { f } = jz(`
      const g = (v) => -v
      export let f = () => { const m = new Map(); m.set('a', 5n); return g(m.get('a')) }
    `, { optimize }).exports
    is(f(), -5n, `O${optimize || 0}: local Map BigInt remains BigInt through unary -`)
  }
})

test('control-dependent local Map BigInt unary hop preserves both domains', () => {
  const src = `
    const g = (v) => -v
    export let f = (cond) => {
      const m = new Map()
      if (cond) m.set('a', 5n)
      return g(m.get('a'))
    }
  `
  for (const optimize of levels(false, 2, 3)) {
    const { f } = jz(src, { optimize }).exports
    is(f(true), -5n, `O${optimize || 0}: present BigInt stays BigInt`)
    ok(Number.isNaN(f(false)), `O${optimize || 0}: absent value negates to NaN`)
    is(f(1), -5n)
    ok(Number.isNaN(f(0)))
  }
})

test('written literal keys: a literal-key write outside a literal-bound layout declares the slot', () => {
  // A function property the plan flattens (the parser idiom `parse.comment[...]`),
  // a `let` global and a bundled module's initializer each write a key their
  // literal lacks. The key is a slot of the literal, not a sidecar entry:
  // enumeration, `in`, JSON, values and reads agree with V8, and a for-in over
  // the alias `cm = parse.comment` unrolls to slot reads.
  const v8 = (src) => Function(src.replace(/export (let|function|const)/g, '$1') + '; return main')()()
  const probe = `let r = '', cm, s; for (s in cm = parse.comment) r += s + ':' + cm[s].length + ','; return r + Object.keys(parse.comment).join('|') + '|' + ('#!' in parse.comment) + '|' + JSON.stringify(parse.comment) + '|' + Object.values(parse.comment).length`
  const ns = `export let parse = () => 1; parse.space = () => 2; parse.comment = { '//': '\\n', '/*': '*/' }; parse.comment['#!'] = '\\n'; export function main() { ${probe} }`
  const bundled = { code: `import { parse } from './parse.js'; import './shebang.js'; export function main() { ${probe} }`, modules: {
    './parse.js': `export let parse = () => 1; parse.space = () => 2; parse.comment = { '//': '\\n', '/*': '*/' }`,
    './shebang.js': `import { parse } from './parse.js'; parse.comment['#!'] = '\\n'`,
  } }
  const bracket = `let o = { a: 1 }; o['zz'] = 2; export function main() { let r = ''; for (const k in o) r += k; return r + '|' + Object.keys(o).length + '|' + ('zz' in o) + '|' + o.zz }`
  // A store to a key the literal already declares must not take a boxed
  // namespace layout (materializeAutoBoxSchemas): it once overwrote the slot beside it.
  const declared = `export let parse = () => 1; parse.space = () => 2; parse.comment = { '//': '\\n', hb: 'x' }; parse.comment.hb = 'y'; export function main() { return JSON.stringify(parse.comment) + '|' + parse.comment.hb + '|' + parse.comment['//'] }`
  for (const optimize of levels(0, 2, 3)) {
    is(jz(ns, { optimize }).exports.main(), v8(ns), `O${optimize}: flattened property`)
    is(jz(bundled.code, { optimize, modules: bundled.modules }).exports.main(), v8(ns), `O${optimize}: bundled initializer`)
    is(jz(bracket, { optimize }).exports.main(), v8(bracket), `O${optimize}: bracket key on a let global`)
    is(jz(declared, { optimize }).exports.main(), v8(declared), `O${optimize}: declared key store`)
  }
  // Dot and bracket forms of the same write behave alike, and a key written on
  // one path only is NOT present until that path runs: `in`, hasOwnProperty,
  // for-in and Object.keys all read what JS reads. (They once read the key
  // before its store — a conditional write declared it on every object of the
  // literal, through two mechanisms; only a definite store may, through one.)
  const conditionalWrite = (write) => `let o = { a: 1 }; export function main(x) { if (x) ${write}; let r = ''; for (const k in o) r += k; return r + '|' + ('b' in o) + '|' + o.hasOwnProperty('b') + '|' + Object.keys(o).length }`
  for (const write of ["o['b'] = 2", 'o.b = 2']) for (const x of [0, 1]) {
    const src = conditionalWrite(write)
    const expected = Function(src.replace(/export (let|function|const)/g, '$1') + '; return main')()(x)
    for (const optimize of levels(0, 2)) is(jz(src, { optimize }).exports.main(x), expected, `${write} x=${x} at O${optimize}`)
  }
  // A top-level `??=` initializes a flattened property like a declaration: it
  // keeps a value already there, and a conditional top-level write is no
  // initializer: the property reads undefined until it runs.
  const kept = `export let parse = () => 1; parse.space = () => 2; parse.comment = { a: 1 }; parse.comment ??= { a: 2 }; export function main() { return parse.comment.a }`
  const conditional = `export let parse = () => 1; parse.space = () => 2; let on = 0; if (on) parse.comment = { a: 1 }; export function main() { return parse.comment === undefined ? 'unset' : parse.comment.a }`
  for (const optimize of levels(0, 2, 3)) {
    is(jz(kept, { optimize }).exports.main(), 1, `O${optimize}: ??= keeps the value already there`)
    is(jz(conditional, { optimize }).exports.main(), 'unset', `O${optimize}: a conditional top-level write is no initializer`)
  }
  if (onKernel()) return
  // The `??=` initialized property's reads in functions are slot reads, not
  // nullable dynamic gets, at every level.
  const lazy = `export let parse = () => 1; parse.space = () => 2; parse.comment ??= { a: 1 }; export function main() { return parse.comment.a }`
  ok(!funcWat(compile(lazy, { wat: true, optimize: 0 }), 'main').includes('$__dyn_get'), 'a ??= initialized property reads as a slot')
  if (belowOpt(1)) return   // the unroll is an optimization pass
  // The unroll and the slot reads are the codegen: no key list, no dynamic get.
  const loop = `export let parse = () => 1; parse.space = () => 2; parse.comment = { '//': '\\n', '/*': '*/' }; parse.comment['#!'] = '\\n'; export function main() { let n = 0, cm, s; for (s in cm = parse.comment) if (cm[s] === '\\n') n++; return n }`
  const body = funcWat(compile(loop, { wat: true }), 'main')
  ok(!body.includes('__keys_ro') && !body.includes('$__dyn_get'), 'for-in over the alias unrolls to slot reads')
  // The declared key's `undefined` is no value the slot holds when the next
  // statements store it (definite initialization through a bracket store):
  // `cm[s].length` is a string length, never the generic length dispatch.
  const len = funcWat(compile(loop.replace("if (cm[s] === '\\n') n++", 'n += cm[s].length'), { wat: true }), 'main')
  ok(len.includes('$__str_length') && !len.includes('$__length') && !len.includes('$__dyn_get'), 'a definitely stored key reads as a string')
})

// ── Declared keys across calls that cannot reach the literal ───────────────
// A literal-key store after registration calls (a bundled parser's
// `parse.comment ??= {…}` … `binary('+', 10)` … `parse.comment['#!'] = …`) is
// still definite when every call between is a direct call to a module
// function whose body, defaults and direct callees never mention the literal's
// name and never run what the pass cannot name; builtin methods count as
// harmless when no method of the program bears the name and no argument can
// be a function. Everything else keeps the key out of the literal – and the
// observable fact is `in` before the store.
const modulesOf = (main, extra = {}) => ({ './parse.js': `export const lookup = [], prec = {}\nexport const parse = (s) => s\nconst register = (d, c = d.op.charCodeAt(0), fn = lookup[c]) => lookup[c] = fn?.ops ? dispatch([d, ...fn.ops], fn.tail) : dispatch([d], fn)\nconst dispatch = (ops, tail, fn = (a, p) => { for (let i = 0; i < ops.length; i++) { const r = ops[i].map(a); if (r) return r } return tail?.(a, p) }) => (fn.ops = ops, fn.tail = tail, fn)\nexport const token = (op, p = 32, map) => register({ op, l: op.length, p: prec[op] = p, map, word: op.toUpperCase() !== op })\nexport const binary = (op, p) => token(op, p, (a, b) => a && [op, a, b])\nparse.comment ??= { '//': '\\n', '/*': '*/' }`, ...extra })
test('declared keys: registration calls between the literal and its store keep the layout closed', () => {
  const mods = { './ops.js': `import { binary } from './parse.js'\nbinary('+', 10)\nbinary('*', 11)`, './shebang.js': `import { parse } from './parse.js'\nparse.comment['#!'] = '\\n'` }
  const main = `import { parse } from './parse.js'\nimport './ops.js'\nimport './shebang.js'\nexport let keys = () => { let out = ''; for (const k in parse.comment) out += k + ';'; return out }\nexport let has = () => '#!' in parse.comment`
  const w = compile(main, { modules: modulesOf(main, mods), wat: true })
  ok(!/oednG|owloop/.test(w), 'no runtime enumeration: the layout closed')
  const { keys, has } = jz(main, { modules: modulesOf(main, mods) }).exports
  is(keys(), '//;/*;#!;'); is(has(), true)
})
test('declared keys stand down for a call that reaches the literal, an alias, a callback, a default', () => {
  const probeMod = { './probe.js': `import { parse } from './parse.js'\nexport const seen = []\nexport const look = () => seen.push('#!' in parse.comment)\nexport const noop = () => 0\nexport const withDefault = (o = parse.comment) => seen.push('#!' in o)\nexport const each = (arr, fn) => arr.forEach(fn)\nexport const viaLook = () => look()\nexport const hooks = [look]\nexport const fire = () => hooks[0]()` }
  for (const [name, between] of [
    ['reaching call', `look()`],
    ['call through a callee that reaches', `viaLook()`],
    ['call of a callee the census cannot see', `fire()`],
    ['alias', `const cm = parse.comment; noop(); seen.push('#!' in cm)`],
    ['callback argument', `each([1], () => seen.push('#!' in parse.comment))`],
    ['parameter default', `withDefault()`],
  ]) {
    const main = `import { parse } from './parse.js'\nimport { seen, look, noop, withDefault, each, viaLook, fire } from './probe.js'\n${between}\nparse.comment['#!'] = '\\n'\nexport let f = () => seen.join(',') + '|' + ('#!' in parse.comment)`
    is(jz(main, { modules: modulesOf(main, probeMod) }).exports.f(), 'false|true', name)
  }
})

// ── for-in over an open layout: the declared keys unrolled, the added keys after ──
test('for-in over an open layout lists the literal keys then the keys added later, break and continue included', () => {
  const src = `let cm = { a: 1, b: 2 }
export let add = (k, v) => { cm[k] = v }
export let all = () => { let out = ''; for (const k in cm) out += k + '=' + cm[k] + ';'; return out }
export let first = () => { let out = ''; for (const k in cm) { if (k === 'c') break; out += k + ';' } return out }
export let skip = () => { let out = ''; for (const k in cm) { if (k === 'b' || k === 'c') continue; out += k + ';' } return out }
export let last = () => { let s; for (s in cm) {} return s }`
  const want = oracle(src), got = jz(src).exports
  // an added array-index key enumerates ahead of the literal's strings: a
  // computed store may add one, so this layout keeps the runtime order
  for (const step of [null, ['c', 3], ['d', 4], ['0', 5], ['x', 6]]) {
    if (step) { want.add(...step); got.add(...step) }
    for (const fn of ['all', 'first', 'skip', 'last']) is(got[fn](), want[fn](), `${fn} after ${step?.[0] ?? 'nothing'}`)
  }
})
test('for-in over a layout with literal-key stores unrolls, with an index key or a number key it keeps the runtime order', () => {
  const lit = `let o = { a: 1, b: 2 }
export let add = () => { o.z = 3 }
export let keys = () => { let out = ''; for (const k in o) out += k; return out }`
  const idx = `let o = { a: 1, b: 2 }
export let add = () => { o['0'] = 3 }
export let keys = () => { let out = ''; for (const k in o) out += k; return out }`
  const num = `let o = { a: 1, b: 2 }
export let add = (i) => { o[i] = 3 }
export let keys = () => { let out = ''; for (const k in o) out += k; return out }`
  // the ordered runtime loop reads the schema row; the unrolled copies and their tail never do
  const keysFn = (src) => funcWat(compile(src, { wat: true, optimize: { watr: false } }), 'keys')
  ok(!/__schema_tbl/.test(keysFn(lit)), 'literal string keys: the declared keys unroll, the tail lists the added')
  ok(/__schema_tbl/.test(keysFn(idx)) && /__schema_tbl/.test(keysFn(num)), 'an index or number key keeps the ordered runtime loop')
  for (const [src, arg] of [[lit, undefined], [idx, undefined], [num, 0], [num, 7]]) {
    const want = oracle(src), got = jz(src).exports
    is(got.keys(), want.keys()); want.add(arg); got.add(arg); is(got.keys(), want.keys(), `after add(${arg})`)
  }
})
test('for-in sites alternate without evicting each other and see a global insert', () => {
  const src = `let a = { x: 1 }, b = { y: 2 }
export let add = (which, k, v) => { (which ? a : b)[k] = v }
export let sum = (n) => { let out = ''; for (let i = 0; i < n; i++) { for (const k in a) out += k; out += '|'; for (const k in b) out += k; out += ';' } return out }`
  const want = oracle(src), got = jz(src).exports
  is(got.sum(2), want.sum(2))
  want.add(1, 'z', 3); got.add(1, 'z', 3)
  is(got.sum(2), want.sum(2))
  want.add(0, 'w', 4); got.add(0, 'w', 4)
  is(got.sum(3), want.sum(3))
})
test('for-in at init sees a key the receiver gains right after, sidecar and global table alike', () => {
  const src = `const o = { a: 1 }
let first = ''
for (const k in o) first += k
o['b'] = 2
let second = ''
for (const k in o) second += k
export let add = (k) => { o[k] = 3 }
export let keys = () => { let out = ''; for (const k in o) out += k; return out }
export let init = () => first + '|' + second`
  const want = oracle(src), got = jz(src).exports
  is(got.init(), want.init())
  is(got.keys(), want.keys())
  want.add('c'); got.add('c')
  is(got.keys(), want.keys())
})

test('for-in: two literals of one layout keep their own added keys', () => {
  // the added-key facts are per construction site: an index key added to the
  // second literal alone keeps that one on the runtime order, the first unrolled
  const src = `let a = { x: 1, y: 2 }, b = { x: 3, y: 4 }
export let add = () => { b['0'] = 5 }
export let ka = () => { let s = ''; for (const k in a) s += k; return s }
export let kb = () => { let s = ''; for (const k in b) s += k; return s }`
  const want = oracle(src), got = jz(src).exports
  for (const fn of ['ka', 'kb']) is(got[fn](), want[fn](), fn)
  want.add(); got.add()
  for (const fn of ['ka', 'kb']) is(got[fn](), want[fn](), `${fn} after add`)
  const wat = compile(src, { wat: true, optimize: { watr: false } })
  ok(!/__schema_tbl/.test(funcWat(wat, 'ka')) && /__schema_tbl/.test(funcWat(wat, 'kb')), 'the untouched literal unrolls, the indexed one keeps the ordered loop')
})
