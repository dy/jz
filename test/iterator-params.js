import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { ctx } from '../src/ctx.js'
import { oracle, batch } from './util.js'
import { levels } from './_matrix.js'

const same = src => is(jz(src).exports.f(), oracle(src).f())

// Batch several standalone `export let f = ...` programs (self-contained, no
// module-level state) into ONE compiled module — one compile instead of one
// per program. `sameMany` mirrors `same`'s oracle comparison per program;
// `runMany` hands back the callable exports themselves for tests that need
// to invoke `f` with different arguments.
const sameMany = (srcs) => batch(srcs).forEach((f, i) => is(f(), oracle(srcs[i]).f()))
const runMany = batch

test('pattern parameters: positional bindings avoid a synthetic rest array', () => {
  const src = `function pick([key, value]) { return key.length + value.n }
    export function f() {
      return [['a', {n: 2}], ['bb', {n: 5}]].map(pick).join(',')
    }`
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const j = jz(src, { optimize })
    is(j.exports.f(), '3,7', 'callback index and collection arguments remain unobserved')
    const pick = ctx.funcs.list.find(f => f.name === 'pick')
    ok(pick && !pick.rest && pick.sig.params.length === 1, 'one positional argument, no rest packing')
  }
  sameMany([
    `export let f = () => { let log = ''; function g([a = (log += 'a', 2)] = [], {b = (log += 'b', a + 1)} = {}, c = (log += 'c', b + 1)) { return [a,b,c,log].join(',') } return g() }`,
    `export let f = () => { function g({x}, y = x + 1) { return [x, y, arguments.length, arguments[2]].join(',') } return g({x: 3}, undefined, 9) }`,
    `export let f = () => { function g([x], ...[y, z]) { return x + y + z } return g([1], 2, 3, 99) }`,
    `export let f = () => { function g([]) { return 1 } try { g(null); return 'missed' } catch (e) { return e.name } }`,
  ])
})

test('iterator records: module-init reuse cannot overwrite a new allocation after clear', () => {
  const src = `const make = v => ({[Symbol.iterator]: () => ({
      next: () => ({value: v, done: false}), return: () => ({})
    })});
    const [seed] = make(7);
    export function f(n) {
      const a = new Uint8Array(n); a.fill(99);
      const [[x, y]] = make([5, 6]);
      let s = x + y + seed;
      for (let i = 0; i < a.length; i++) s += a[i];
      return s;
    }`
  for (const level of levels(0, 1, 2, 3, 'size')) for (const snapshotInit of [false, true]) {
    const ex = jz(src, { optimize: { level, snapshotInit } }).exports
    for (const n of [0, 4096, 0, 8192, 8192]) {
      is(ex.f(n), 18 + 99 * n, `O${level}, snapshot=${snapshotInit}, n=${n}: new buffer is intact`)
      ex._clear()
    }
  }
})

test('iterator records: nested close, errors, reuse and arena reset preserve the protocol', () => {
  const src = `let log = ''; const pair = [5, 6];
    const source = mode => ({ [Symbol.iterator]: () => {
      if (mode === 1) throw new Error('acquire');
      return {
        get next() {
          if (mode === 2) throw new Error('getter');
          return () => {
            if (mode === 3) throw new Error('step');
            return { value: mode >= 6 ? undefined : 7, done: mode === 4 };
          };
        },
        return() {
          const [a, b] = pair; log += a + ':' + b + ';';
          if (mode === 5 || mode === 7) throw new Error('close');
          return {};
        }
      };
    } });
    const fail = () => { throw new Error('default') };
    export function f(mode) {
      log = '';
      try {
        const [[x, y]] = [pair];
        if (mode === 8) { const [] = source(0); return log }
        if (mode === 9) { const [a, b] = '😀x'; return a + b }
        const [v = fail()] = source(mode);
        return x + ':' + y + ':' + v + '|' + log;
      } catch (e) { return e.message + '|' + log }
    }`
  const modes = [0, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8, 9]
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const ex = jz(src, { optimize }).exports
    for (let cycle = 0; cycle < 2; cycle++) {
      const js = oracle(src)
      is(modes.map(n => ex.f(n)), modes.map(n => js.f(n)), `O${optimize}: cycle ${cycle}`)
      ex._clear()
    }
  }
})

test('iterator parameters: acquisition and stepping fail at call time', () => {
  for (const kind of ['function', 'function*', 'async function*']) {
    for (const phase of ['acquire', 'step']) same(`
      let entered = false, closed = false;
      let source = { [Symbol.iterator]: () => {
        if ('${phase}' === 'acquire') throw new Error('acquire');
        return { next: () => { throw new Error('step') }, return: () => { closed = true; return {} } };
      } };
      ${kind} g([x]) { entered = true }
      export let f = () => { try { g(source) } catch (e) { return e.message + '|' + entered + '|' + closed } return 'missing error' };
    `)
  }
})

test('iterator parameters: pulls, elisions, defaults and close stay ordered', () => {
  for (const kind of ['function', 'function*', 'async function*']) same(`
    let log = '', i = 0;
    let source = { [Symbol.iterator]: () => {
      log += 'open;';
      return { next: () => { log += 'next;'; i++; return { value: undefined, done: false } },
        return: () => { log += 'close;'; return {} } };
    } };
    let value = 0;
    ${kind} g([, x = (log += 'default;', 4)], y = (log += 'later;', x + 1)) { value = y }
    export let f = () => { g(source); return log + '|' + i };
  `)
})

test('iterator parameters: binding error closes and keeps the original error', () => {
  for (const closeThrows of [false, true]) same(`
    let closed = 0;
    let source = { [Symbol.iterator]: () => ({
      next: () => ({ value: undefined, done: false }),
      return: () => { closed++; if (${closeThrows}) throw new Error('close'); return {} }
    }) };
    let fail = () => { throw new Error('default') };
    function* g([x = fail()]) {}
    export let f = () => { try { g(source) } catch(e) { return e.message + '|' + closed } return 'missing error' };
  `)
})

test('iterator parameters: rest drains once, exhaustion suppresses later pulls and close', () => {
  for (const pattern of ['[x, ...rest]', '[x, y, z, last = 9]']) same(`
    let pulls = 0, closed = 0;
    let source = { [Symbol.iterator]: () => ({
      next: () => { pulls++; return { value: pulls, done: pulls > 2 } },
      return: () => { closed++; return {} }
    }) };
    function g(${pattern}) { return x }
    export let f = () => { return g(source) + '|' + pulls + '|' + closed };
  `)
})

test('iterator parameters: nested array bindings and later parameters see earlier values', () => same(`
  let closed = 0;
  let source = { [Symbol.iterator]: () => ({ next: () => ({ value: [3, undefined], done: false }), return: () => { closed++; return {} } }) };
  function g([[x, y = x + 2]], z = y + 1, ...tail) { return x + y + z + tail.length }
  export let f = () => { return g(source, undefined, 10, 20) + '|' + closed };
`))

test('iterator parameters: arrays and typed arrays retain the indexed fallback', () => {
  for (const value of ['[3, 5]', 'new Uint8Array([3, 5])', '"35"']) same(`
    function* marker() {}
    function g([x, y], z = y) { return '' + x + y + z }
    export let f = () => g(${value});
  `)
})

test('iterator parameters: empty pattern acquires and closes without pulling', () => same(`
  let log = '';
  let source = { [Symbol.iterator]: () => { log += 'open;'; return {
    next: () => { log += 'next;'; return { done: false } }, return: () => { log += 'close;'; return {} }
  } } };
  function* g([]) {}
  export let f = () => { g(source); return log };
`))

test('iterator parameters: iterator methods retain their object receiver', () => same(`
  let iterator = { i: 0, next() { this.i++; return { value: this.i, done: false } }, return() { this.i += 10; return {} } };
  let source = { [Symbol.iterator]: () => iterator };
  function g([x, y]) { return x + y }
  export let f = () => { return g(source) + '|' + iterator.i };
`))

test('iterator parameters: arguments capture does not defer parameter initialization', () => same(`
  let opened = 0;
  let source = { [Symbol.iterator]: () => { opened++; throw new Error('open') } };
  function* g([x], y = arguments.length) { yield y }
  export let f = () => { try { g(source) } catch(e) { return e.message + '|' + opened } return 'missing error' };
`))

test('iterator parameters: consuming a throwing generator leaves it closed', () => same(`
  let first = 0;
  let iter = (function*() { first++; throw new Error('step') })();
  async function* g([...x] = iter) {}
  export let f = () => {
    let message = '';
    try { g() } catch(e) { message = e.message }
    let result = iter.next();
    return message + '|' + first + '|' + result.done;
  };
`))

test('iterator parameters: malformed iterator records throw TypeError', () => {
  for (const iterator of ['3', '{ next: 3 }', '{ next: () => 3 }', '{ next: () => ({done:false}), return: () => 3 }']) same(`
    let source = { [Symbol.iterator]: () => (${iterator}) };
    function g([x]) {}
    export let f = () => { try { g(source) } catch(e) { return e.name } return 'missing error' };
  `)
})

test('iterator parameters: next is captured before defaults can replace it', () => same(`
  let calls = 0, closed = 0;
  let iter = { next: () => { calls++; return { value: undefined, done: false } }, return: () => { closed++; return {} } };
  let source = { [Symbol.iterator]: () => iter };
  function g([x = (iter.next = () => { throw new Error('replaced') }, 1), y = 2]) { return x + y }
  export let f = () => g(source) + '|' + calls + '|' + closed;
`))

test('iterator parameters: renamed object bindings and nested rest patterns declare their targets', () => same(`
  let i = 0;
  let source = { [Symbol.iterator]: () => ({ next: () => { i++; return { value: i === 1 ? {p: 3} : 5, done: i > 2 } } }) };
  function g([{p: x}, ...[y]]) { return x + y }
  export let f = () => g(source);
`))

test('iterator parameters: DataView is not an indexed iterable', () => {
  for (const ctor of ['DataView', 'Int8Array', 'Uint8Array']) same(`
    function* marker() {}
    function g([x]) { return x }
    export let f = () => {
      let b = new ArrayBuffer(4), bytes = new Uint8Array(b); bytes[1] = 23;
      try { return g(new ${ctor}(b, 1, 2)) }
      catch (e) { return e instanceof TypeError ? 'type error' : 'wrong error' }
    }
  `)
})

test('iterator destructuring: declarations and assignments preserve pulls and closing', () => {
  sameMany(['let [a = (log += "default;", 4),, b] = source', 'const [a = (log += "default;", 4),, b] = source', 'var [a = (log += "default;", 4),, b] = source', 'let a, b; ([a = (log += "default;", 4),, b] = source)'].map(binding => `
    export let f = () => {
      let log = '', n = 0;
      let source = { [Symbol.iterator]: () => {
        log += 'open;';
        return {next: () => { log += 'pull;'; n++; return {value: undefined, done: false} },
          return: () => { log += 'close;'; return {} }};
      }};
      ${binding};
      return log + a + '|' + b + '|' + n;
    };
  `))
})

test('iterator destructuring: empty, rest, nested object and Unicode string patterns', () => {
  sameMany([
    ...['let [] = source', 'let [a, ...rest] = source', 'let {p: [a, ...rest]} = {p: source}', 'let a, rest; ({p: [a, ...rest]} = {p: source})'].map(stmt => `
    export let f = () => {
      let log = '', n = 0;
      let source = { [Symbol.iterator]: () => ({next: () => { n++; log += 'n'; return {value: n, done: n > 3} }, return: () => { log += 'r'; return {} }}) };
      ${stmt}; return log;
    };
  `),
    `export let f = () => { let [a, b, ...c] = '😀éab'; return a + '|' + b + '|' + c.join('') };`,
  ])
})

test('iterator destructuring: assignment returns its source and evaluates it once', () => same(`
  export let f = () => {
    let n = 0, a, b;
    let source = { [Symbol.iterator]: () => ({next: () => ({value: ++n, done: false}), return: () => ({})}) };
    let get = () => { n += 10; return source };
    let result = ([a,b] = get()); return (result === source) + '|' + a + '|' + b + '|' + n;
  };
`))

test('iterator destructuring: binding errors close, step errors do not', () => {
  sameMany(['default', 'step'].map(phase => `
    export let f = () => {
      let closed = 0;
      let fail = () => { throw new Error('default') };
      let source = { [Symbol.iterator]: () => ({next: () => {
        if ('${phase}' === 'step') throw new Error('step'); return {value: undefined, done: false};
      }, return: () => { closed++; throw new Error('close') }}) };
      try { let [x = fail()] = source } catch (e) { return e.message + '|' + closed }
      return 'missing error';
    };
  `))
})

test('iterator destructuring: assignment references precede each pull', () => same(`
  export let f = () => {
    let log = '', target = [0];
    let key = () => { log += 'key;'; return 0 };
    let source = { [Symbol.iterator]: () => ({next: () => { log += 'next;'; return {value: undefined, done: false} }, return: () => { log += 'close;'; return {} }}) };
    [target[key()] = (log += 'default;', 2)] = source;
    return log + target[0];
  };
`))

test('iterator destructuring: source calls and defaults are prepared once', () => {
  sameMany([
    `export let f = () => { const [a, b = '#fallback'] = 'x'.split('##'); return a + b };`,
    `export let f = () => { let source = []; let [a = (source.push(7), 3), b] = source; return a + '|' + b };`,
    `export let f = () => { let source = [undefined, 2]; let [a = (source = [9,9], 1), b] = source; return a + '|' + b };`,
  ])
})

test('iterator parameters: array nested in an object initializes before generator starts', () => same(`
  let opened = 0;
  let source = { [Symbol.iterator]: () => { opened++; throw new Error('open') } };
  function* g({p: [x]}) { yield x }
  export let f = () => { try { g({p: source}) } catch(e) { return e.message + '|' + opened } return 'missing error' };
`))


test('iterator destructuring: native collection views and non-iterable rejection', () => {
  sameMany([
    `export let f = () => { let [a, ...b] = new Set([3,4,5]); return a + '|' + b.join(',') };`,
    `export let f = () => { let [[k,v]] = new Map([['x',7]]); return k + v };`,
    `export let f = () => { try { let [a] = {0: 3, length: 1} } catch(e) { return e.name } return 'missing error' };`,
  ])
})


test('iterator destructuring: initially undefined bindings still coerce later strings', () => {
  sameMany(['1', 'bad', ''].map(value => `export let f = () => {
    let source = ['${value}']; let [x] = source;
    return isNaN(x) + '|' + isFinite(x) + '|' + (x * 2) + '|' + (+x);
  };`))
})


test('numeric-only initialization and nullable booleans preserve ToNumber', () => {
  const values = ['true', 'false', '5']
  const lastSrc = `export let f = () => { let x; return x };`
  const fns = runMany([...values.map(value => `export let f = c => { let x; if(c) x=${value}; return x*2 }`), lastSrc])
  values.forEach((value, i) => {
    const f = fns[i]
    is(Number.isNaN(f(0)), true)
    is(f(1), Number(value === 'true' ? true : value === 'false' ? false : 5) * 2)
  })
  is(fns[values.length](), oracle(lastSrc).f())
})
