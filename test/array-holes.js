import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { levels } from './_matrix.js'
import { oracle, funcWat } from './util.js'

const tiers = () => levels(0, 1, 2, 3, 'size')
const signature = `function sig(a) { return [a.length, Object.keys(a), Object.values(a), Object.entries(a)] }`
const runCases = (src, calls) => {
  for (const optimize of tiers()) {
    const js = oracle(src), wasm = jz(src, { optimize }).exports
    for (const [name, args] of calls) is(wasm[name](...args), js[name](...args), `${name} ${args} O${optimize}`)
  }
}

test('array holes: literals, gaps, deletion and length changes retain own undefined', () => {
  const src = `${signature}
    export function f(mode) {
      const a = mode === 0 ? [] : mode === 1 ? new Array(4) : mode === 3 ? [,] : mode === 4 ? [undefined] : [, undefined, 7, ,];
      const before = sig(a);
      a[5] = undefined;
      const grown = sig(a);
      delete a[2]; delete a[20];
      const deleted = sig(a);
      a[0] = undefined; a[2] = 9;
      const inserted = sig(a);
      a.length = 1; a.length = 4;
      return [before, grown, deleted, inserted, sig(a),
        0 in a, 1 in a, '0' in a, '1' in a, Object.hasOwn(a, 0), Object.hasOwn(a, 1),
        a.hasOwnProperty('0'), a.hasOwnProperty('1'), a[1], a['1'], a.at(1)];
    }`
  runCases(src, [0, 0, 1, 2, 3, 4, 0].map(n => ['f', [n]]))
})

test('array holes: value iteration visits undefined while property callbacks skip absent cells', () => {
  const src = `${signature}
    export function f(n) {
      const a = new Array(n); if (n > 1) a[1] = undefined; if (n > 3) a[3] = 9;
      let count = 0, sum = 0, found = 0; const visited = [];
      const mapped = a.map((v, i) => {count++; return i});
      a.forEach((v, i) => {sum += i});
      a.find((v, i) => {found++; return false});
      for (const v of a) visited.push(v);
      let reduced; try { reduced = a.reduce((acc, v) => acc) } catch (e) { reduced = e instanceof TypeError }
      return [count, sum, found, sig(mapped), sig(a.filter(v => true)),
        a.some(v => true), a.every(v => false), a.reduce((acc, v, i) => acc + i, 0),
        a.reduceRight((acc, v, i) => acc + i, 0), reduced,
        a.indexOf(undefined), a.lastIndexOf(undefined), a.includes(undefined),
        a.findIndex(v => v === undefined), a.findLastIndex(v => v === undefined),
        [...a.keys()], [...a.values()], [...a.entries()], visited];
    }`
  runCases(src, [0, 0, 1, 4, 2, 0].map(n => ['f', [n]]))
})

test('array holes: callbacks observe deletion, growth and reinserted later indices', () => {
  const src = `${signature}
    export function f(mode) {
      const a = [1, undefined, 3, 4], seen = [];
      const out = a.map((v, i, source) => {
        seen.push(i);
        if (i === 0) { delete source[1]; if (mode) source[2] = undefined; else source.length = 2; source[3] = 8; source[8] = 12 }
        if (i === 2) { delete source[3]; source[3] = undefined }
        return v;
      });
      return [seen, sig(out), sig(a)];
    }`
  runCases(src, [0, 0, 1, 0].map(n => ['f', [n]]))
})

test('array holes: raw copies preserve occupancy and value copies densify', () => {
  const src = `${signature}
    export function f(mode) {
      const a = mode ? [, undefined, 3, , 1] : [];
      const sliced = a.slice(), cat = a.concat(a), copied = a.slice(); copied.copyWithin(1, 0, 3);
      const rev = a.slice().reverse(), sorted = a.slice().sort();
      const removed = a.slice(); const tail = removed.splice(1, 2);
      const fill = a.slice().fill(undefined, 1, 3);
      const dense = [Array.from(a), [...a], a.toSorted(), a.toReversed(), a.toSpliced(1, 2)];
      if (mode) dense.push(a.with(0, 8));
      const pushed = []; pushed.push(...a); const shifted = []; shifted.unshift(...a);
      return [sig(a), sig(sliced), sig(cat), sig(copied), sig(rev), sig(sorted), sig(removed), sig(tail), sig(fill),
        dense.map(x => sig(x)), sig(pushed), sig(shifted), sig([, ...a, , undefined]),
        sig([, a, , [undefined, , 2]].flat()), sig(a.flatMap(x => [, x])),
        a.join('|'), JSON.stringify(a)];
    }`
  runCases(src, [0, 0, 1, 0, 1].map(n => ['f', [n]]))
})

test('array holes: reads normalize absence before primitive use and recover from property errors', () => {
  const src = `export function f(mode) { const a = [, undefined, {x: 7}]; const k = mode | 0;
      if (k === 3) return [a.pop().x, a.shift(), a.pop()];
      return [a[k] === undefined, typeof a[k], String(a[k]), Number(a[k]), a.at(k)]; }
    export function read(k) { const a = [, {x: 7}]; return a[k | 0].x }`
  for (const optimize of tiers()) {
    const js = oracle(src), wasm = jz(src, { optimize }).exports
    for (const k of [0, 0, 1, 3, -1, 0]) is(wasm.f(k), js.f(k), `value ${k} O${optimize}`)
    for (const k of [0, 0, 1, 2, 1]) {
      if (k === 1) is(wasm.read(k), js.read(k))
      else throws(() => wasm.read(k), TypeError)
    }
  }
})

test('array holes: dense direct reads retain their existing load path', () => {
  const wat = compile('export function f(i) { const a = [2, 3, 4]; return a[i | 0] }', { wat: true, optimize: 2, watr: false })
  ok(!/\(call \$__arr_value\b/.test(wat), 'proven dense indexed read needs no absent-cell normalization')
})

test('array holes: aliased deletes invalidate dense reads and no-seed fusion finds a present slot', () => {
  const src = `${signature}
    function remove(a) { delete a[0] }
    export function f(flag) {
      const a = [1, 2], b = flag ? a : {};
      delete b[0]; remove(a);
      const c = [, 5, , 9, ,];
      return [a[0], sig(a), c.map(x => x * 2).reduce((x, y) => x + y),
        c.reduce((x, y) => x - y), c.reduceRight((x, y) => x - y),
        c.filter(x => true).reduce((x, y) => x + y)];
    }
    export function empty() { return [,].map(x => x).reduce((x, y) => x + y) }`
  for (const optimize of tiers()) {
    const js = oracle(src), wasm = jz(src, { optimize }).exports
    for (const flag of [0, 0, 1, 0]) {
      is(wasm.f(flag), js.f(flag))
      throws(() => wasm.empty(), TypeError)
    }
  }
})

test('array holes: compiled Array+ mutations preserve host occupancy and reuse', () => {
  const src = `${signature}
    export function f(a, mode) {
      const before = sig(a);
      a.push(undefined);
      if (mode) delete a[0]; else a[1] = undefined;
      a.length += 2;
      return [before, sig(a)];
    }`
  for (const optimize of tiers()) {
    const js = oracle(src), wasm = jz(src, { optimize }).exports
    const a = [, undefined, 7], b = [, undefined, 7];
    let retained;
    for (const mode of [0, 0, 1, 0]) {
      const expected = js.f(a, mode), got = wasm.f(b, mode)
      is(got, expected)
      is(Object.keys(b), Object.keys(a), 'copy-back keeps own undefined and absent slots distinct')
      is(b, a)
      if (retained) is(retained[0], retained[1], 'earlier decoded results survive later calls')
      retained = [got, expected]
    }
  }
})

test('array holes: numeric absence converts once without broad ToNumber and mixed values still coerce', () => {
  const numeric = `export function f(n) {
    const a = [1, 2, 3], b = a; b[0] = n;
    a.forEach((x, i) => { a[i] = x * 2 });
    let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s;
  }
  export function hole(k) { const a = [1, 2]; a[4] = 3; const x = a[k | 0]; return x * 2 }`
  const mixed = `export function f(k) {
    const a = [1, null, true, '6', {valueOf(){return 8}}, undefined];
    const x = a[k | 0]; return x * 2;
  }`
  for (const optimize of tiers()) {
    const js = oracle(numeric), wasm = jz(numeric, {optimize}).exports
    for (const n of [0, 0, 7, -3, 0]) is(wasm.f(n), js.f(n))
    for (const k of [0, 2, 2, 4, 9, 0]) is(wasm.hole(k), js.hole(k))
    const expected = oracle(mixed), actual = jz(mixed, {optimize}).exports
    for (const k of [0, 1, 2, 3, 4, 5, 9, 0]) is(actual.f(k), expected.f(k))
    const wat = compile('export function f(k) { const a = [1, 2]; a[4] = 3; const x = a[k | 0]; return x * 2 }', {optimize, wat:true})
    ok(!/\$__to_num[ )]/.test(wat), `Number|absent keeps the existing no-ToNumber bar O${optimize}`)
  }
})

test('array holes: dense length growth and BigInt payloads keep separate value and presence bits', () => {
  const src = `${signature}
    export function f(n) {
      const a = [1]; a.length = n;
      const assigned = [1]; Object.assign(assigned, {length: n});
      let visits = 0; assigned.forEach(x => { visits++ });
      const b = [, 0x7ff87fffffffffffn, undefined, NaN];
      return [sig(a), a[1], 1 in a, sig(assigned), assigned[1] === undefined, visits, sig(b), sig([...b]), sig(b.map(x => x))];
    }
    export function dynamic(key, n) {
      const a = [1]; Object.assign(a, {[String(key)]: n});
      let visits = 0; a.forEach(x => {visits++});
      return [sig(a), a[1] === undefined, visits];
    }`
  runCases(src, [1, 1, 4, 0, 2, 1].map(n => ['f', [n]]))
  runCases(src, [['length', 4], ['length', 4], ['4', 7], ['length', 0], ['length', 1]].map(args => ['dynamic', args]))
})

test('array holes: structured cloning preserves nested occupancy and shared children', () => {
  const src = `${signature}
    export function f(mode) {
      const child = [, undefined, mode], a = [child, , child, undefined];
      const b = structuredClone(a); b[0][2] = 8;
      return [sig(a), sig(b), sig(b[0]), b[0] === b[2], b[0] === child, child[2]];
    }`
  runCases(src, [0, 0, 1, 0].map(n => ['f', [n]]))
})

test('array holes: a fixed sparse literal keeps find callbacks nullable', () => {
  const src = `export function f() { const a = [, 2];
    return [a.findIndex(v => v === undefined), a.find(v => v === undefined),
      a.findLastIndex(v => typeof v === 'undefined'), a.every(v => v !== undefined)]; }`
  runCases(src, [['f', []], ['f', []]])
})

test('array holes: materialized absent values remain present callback arguments', () => {
  const src = `${signature}
    export function f(mode) {
      const holes = [,], read = holes[0];
      const a = mode === 0 ? [read, 1] : mode === 1 ? [] : mode === 2 ? [1, 2] : Array.from(holes);
      if (mode === 1) a.push(read, 1);
      if (mode === 2) a[0] = read;
      const seen = []; a.forEach(x => seen.push(x === undefined ? 5 : x));
      return [sig(a), a.map(x => x === undefined ? 5 : x), a.filter(x => x === undefined), seen,
        a.reduce((s, x) => s + (x === undefined ? 5 : x), 0), a.every(x => x !== undefined)];
    }`
  runCases(src, [0, 0, 1, 2, 3, 0].map(n => ['f', [n]]))
})

test('array holes: typed numeric reads fold only their missing arm', () => {
  for (const Ctor of ['Float32Array', 'Float64Array', 'Int16Array']) {
    const src = `const a = new ${Ctor}([1, 2, 3, 4]);
      export function read(i) { return a[i] * 2 }
      export function sum(offset, count) { let s = 0; for (let i = 0; i < count; i++) s += a[offset + i] * 2; return s }`
    for (const optimize of tiers()) {
      const js = oracle(src), wasm = jz(src, {optimize}).exports
      for (const i of [0, 0, 3, 4, -1, .5, NaN, Infinity, 1]) is(wasm.read(i), js.read(i))
      for (const args of [[0, 0], [0, 0], [0, 4], [1, 3], [3, 2], [-1, 2], [0, 4]]) is(wasm.sum(...args), js.sum(...args))
      const wat = compile(src, {optimize, wat: true, watr: false})
      ok(!/\(i64.eq\b/.test(funcWat(wat, 'read')), `${Ctor} O${optimize}: the miss arm folds without a sentinel comparison`)
    }
  }
})
