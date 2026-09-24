import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { onWasi } from './_matrix.js'

const cases = {
identity: `const o={v:3,m(){'use strict';return this}}; const m=o.m; return [o.m()===o,m()===undefined,m.call(null)===null,m.call(false)===false,m.call(0)===0,m.call()===undefined,m.apply()===undefined]`,
ordering: `let o={v:3,m(x){return this.v+x}}, p={v:7,m:o.m}; let k='m'; return [o.m((o=p,1)),o[k]((o={v:9,m:p.m},2)),o[k]?.((o=p,3))]`,
args: `const o={v:3,m(...xs){let s=this.v;for(const x of xs)s+=x;return s}};const m=o.m;return [o.m(1,2,3,4,5,6,7,8),o.m(...[1,2]),m.apply({v:8},[1,2]),m.call({v:4},2,3)]`,
accessor: `const o={v:7,get m(){return this.v},set m(x){this.v=x}};o.m=8;return [o.m,o.v]`,
coercion: `const o={v:7,toString(){return ''+this.v},valueOf(){return this.v}};return [String(o),Number(o),o+1]`,
callbacks: `const o={m(){'use strict';return this===undefined}};return [[1,2].map(o.m),new Float64Array([1,2]).map(o.m)[0]]`,
forwarded: `const o={v:9,m(){return this.v}};const a={v:4,m:o.m};return a.m()`,
opt_null: `let count=0;const o={v:8,m(x){return this.v+x}};const z=null;return [z?.m?.(++count),o?.m?.(1),o.missing?.(++count),count]`,
reentry:`const o={v:3,m(f){f();return this.v}},p={v:7,m:o.m};return o.m(()=>p.m(()=>0))`,
gen:`const o={v:3,*m(){yield this.v;yield this.v+1}};const p={v:7,m:o.m};const a=o.m(),b=p.m();return [a.next().value,b.next().value,a.next().value,b.next().value,a.next().done,b.next().done]`,
async:`const o={v:3,async m(){await 0;return this.v}};const m=o.m;return [await o.m(),await m.call({v:8})]`,
arrow:`const o={v:3,m(){return ()=>this.v}};const m=o.m;return [o.m()(),m.call({v:8})()]`,
abi:`function add(a,b){return a+b}const o={v:3,m(x){return this.v+x}};const fs=[x=>x*2,add,o.m];return [fs[0](4),fs[1](2,5),o.m(4),fs[2].call({v:7},5)]`,
get_method:`const o={v:3,m(){return this.v}},p={v:7,get m(){return o.m}};return p.m()`,
};
for (const [name, body] of Object.entries(cases)) test(`method receiver: ${name}`, async () => {
  const src = `export ${name === 'async' ? 'async ' : ''}function f(){${body}}`
  const native = new Function('"use strict";' + src.replace('export ', '') + ';return f')()
  const compiled = jz(src).exports.f
  for (let i = 0; i < 2; i++) is(await compiled(), await native(), name)
})

test('method receiver: detached generator observes undefined', () => {
  const src = `export function f() {
    let seen = null
    const m = {*m() {'use strict'; seen = this}}.m
    const it = m()
    const before = seen === null
    const first = it.next(), last = it.next()
    return [before, seen === undefined, first.done, first.value, last.done]
  }`
  is(jz(src).exports.f(), [true, true, true, undefined, true])
})

test('method receiver: ABI resets between compiles', () => {
  const plain = 'export function f(n){const fs=[x=>x+1,x=>x*2];return fs[n&1](n)}'
  const before = compile(plain)
  is(jz('export function f(){const o={v:3,m(){return this.v}};return o.m()}').exports.f(), 3)
  is(compile(plain), before)
  is(compile(plain), before)
  ok(!compile(plain, {wat:true}).includes('$__this'))
})

test('method receiver: captured iterator operations keep the protocol receiver', () => {
  for (const pattern of ['[]', '[a,b]', '[...a]']) {
    const body = `let log='';
      const iterator={i:0,next(){log+='n'+this.i;return {value:++this.i,done:this.i>2}},
        return(){log+='r'+this.i;return {}}};
      const methods={open(){log+='o';return this.it}};
      const source={it:iterator,[Symbol.iterator]:methods.open};
      let ${pattern}=source;return log+'|'+iterator.i`
    is(jz(`export function f(){${body}}`).exports.f(), new Function(body)(), pattern)
  }
})

test('method receiver: spread callback arguments retain thisArg', () => {
  const body = `const o={n:2,m(x){return x===this.n}};
    return [[1,2].some(...[o.m,o]),[1,2].find(...[o.m,o]),
      new Uint8Array([1,2]).every(...[o.m,o]),[1,2].map(...[o.m,o])]`
  is(jz(`export function f(){${body}}`).exports.f(), new Function(body)())
})

test('method receiver: optional calls retain the reference through a continuation', () => {
  const { f } = jz(`export function f() {
    const a = {b(x = 0, y = 0) {return {c: this._b.c + x + y}}, _b: {c:42}}
    const absent = {b:null}
    let n = 0
    return [a?.b().c, (a?.b)().c, a.b?.().c, (a.b)?.().c,
      a?.b?.().c, (a?.b)?.().c, a.b?.(2, 3).c, a.b?.(...[4, 5]).c,
      absent.b?.(++n).c, n]
  }`).exports
  is(f(), [42, 42, 42, 42, 42, 42, 47, 51, undefined, 0])
})

test('method receiver: timer trampolines pass an undefined receiver', async () => {
  if (onWasi()) return
  const { start, seen } = jz(`let seenTimeout = false, seenFrame = false
    const o = {
      timeout() {seenTimeout = this === undefined},
      frame(t) {seenFrame = this === undefined && t > 0}
    }
    export function start() {setTimeout(o.timeout, 0); requestAnimationFrame(o.frame)}
    export function seen() {return [seenTimeout, seenFrame]}
  `).exports
  start()
  await new Promise(resolve => setTimeout(resolve, 80))
  is(seen(), [true, true])
})

test('method receiver: collection callbacks use their explicit thisArg', () => {
  for (const arr of ['[1,2,3]', 'new Float64Array([1,2,3])', 'new Int16Array([1,2,3])', '[]', 'new Float64Array(0)'])
    for (const method of ['map', 'filter', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'forEach']) {
      const body = `const o={n:2,s:0,m(x){this.s+=x;return x===this.n}};
        const r=${arr}.${method}(o.m,o);return [${method === 'forEach' ? '0' : 'r'},o.s]`
      const want = new Function('"use strict";' + body)()
      is(jz(`export function f(){${body}}`).exports.f(), want, arr + '.' + method)
    }
  const body = `const o={v:4,s:0,m(x,k,a){this.s+=x+k+a.size}};
    new Map([[1,2],[3,4]]).forEach(o.m,o);
    new Set([1,2]).forEach(o.m,o);
    return [o.s,Array.from([1,2],{m(x){return x+this.v}}.m,o)]`
  is(jz(`export function f(){${body}}`).exports.f(), new Function('"use strict";' + body)())
})

test('method receiver: thisArg evaluates before callback validation, even on empty inputs', () => {
  const body = `let n=0;const o={m(x){return this.v+x}};
    const a=[1].map(o.m,(n++,{v:2}));
    const b=[1].map(x=>x*2,(n++,{v:4}));
    const c=Array.from([3],undefined,n++);
    try{[].map(null,n++)}catch(e){n+=e.name==='TypeError'?10:100}
    return [a,b,c,n]`
  is(jz(`export function f(){${body}}`).exports.f(), new Function('"use strict";' + body)())
})

test('method receiver: proven closure calls keep argument order without a receiver slot', () => {
  const body = `let n=0;const box={f:x=>x*2};
    const value=box.f.call((n=n*10+1),(n=n*10+2));return [value,n]`
  for (const strict of [false, true])
    is(jz(`export const f=()=>{${body}}`, {strict}).exports.f(), [24,12])
})


test('method receiver: optional builtin calls prove the receiver family before arguments', () => {
  const src = `export function f(k) {
    let n = 0
    const values = [NaN, 1n, false, 0, null, undefined, 'ban', ['ban'], [],
      new Uint8Array([1]), {}, {indexOf(x) {return x === 'ban' ? 42 : -1}}]
    const value = values[k]?.indexOf?.((n++, 'ban'))
    return [value, n]
  }`
  const native = new Function(src.replace('export ', '') + ';return f')()
  for (const optimize of [0, 2, 3]) {
    const { f } = jz(src, { optimize }).exports
    for (const k of [0, 0, 6, 7, 8, 9, 10, 11, 4, 5, 1, 2, 3, 6])
      is(f(k), native(k), `O${optimize}, receiver ${k}`)
  }
})

test('method receiver: nonoptional missing builtins evaluate arguments then throw', () => {
  const src = `export function f(k) {
    let n = 0
    const values = [NaN, 1n, false, 0, {}, 'ban', ['ban']]
    try {return [values[k].indexOf((n++, 'ban')), n]}
    catch(e) {return [e.name, n]}
  }`
  const native = new Function(src.replace('export ', '') + ';return f')()
  for (const optimize of [0, 2, 3]) {
    const { f } = jz(src, { optimize }).exports
    for (const k of [0, 0, 1, 2, 3, 4, 5, 6, 0]) is(f(k), native(k), `O${optimize}, receiver ${k}`)
  }
})

test('method receiver: search arguments run once before length and position conversion', () => {
  for (const method of ['indexOf', 'lastIndexOf', 'includes']) {
    const src = `export function f(n) {
      let count = 0
      const a = []
      for (let i = 0; i < n; i++) a.push(i)
      const from = {valueOf() {return count}}
      const found = a.${method}((count++, 2), from)
      return [found, count]
    }`
    const native = new Function(src.replace('export ', '') + ';return f')()
    const { f } = jz(src).exports
    for (const n of [0, 0, 1, 4, 0]) is(f(n), native(n), `${method}, length ${n}`)
  }
})


test('method receiver: optional call does not make its property read optional', () => {
  for (const call of ["values[k].indexOf((n++, 'a'))", "values[k].indexOf?.((n++, 'a'))"]) {
    const src = `export function f(k) {
      let n = 0
      const values = [null, undefined, NaN, 'a']
      try {return [${call}, n]} catch(e) {return [e.name, n]}
    }`
    const native = new Function(src.replace('export ', '') + ';return f')()
    for (const optimize of [0, 2, 3]) {
      const { f } = jz(src, { optimize }).exports
      for (const k of [0, 0, 1, 2, 3, 0]) is(f(k), native(k), `O${optimize}, receiver ${k}`)
    }
  }
})


test('method receiver: inherited object methods accept erased receiver families', () => {
  const src = `const values = [{}, JSON.parse('{"x":1}'), 'ab', [3], 7, NaN, true, 1n]
    export function f(i, key) {return values[i].hasOwnProperty(key)}`
  const native = new Function(src.replace('export ', '') + ';return f')()
  const f = jz(src).exports.f
  for (const i of [0, 0, 1, 2, 3, 4, 5, 6, 7, 0])
    for (const key of ['x', '0', 'length', 'missing', 'toString'])
      is(f(i, key), native(i, key), `receiver ${i}, key ${key}`)
})
