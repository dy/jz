import test from 'tst'
import { is } from 'tst/assert.js'
import jz from '../index.js'

const same = src => is(jz(src).exports.f(), Function(src.replace('export ', '') + '; return f()')())

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
