// A destructuring assignment to member targets (`({a: t.x} = o)`, `[t.x,
// u[i]] = arr`) writes through the reference it took before reading the
// source, as ES orders it. Such a write reaches an object outside its
// literal's layout, like any store through an alias or a helper's parameter:
// the module keeps it in the object's own dictionary (its header's, or for a
// durable object the table its offset keys), and the host used to decode the
// object from its layout's slots alone, so the property vanished on the way
// out, and a deleted slot stayed. The host now asks the module for both
// (module/collection.js __obj_props, __obj_deleted; interop.js mem.read).
import test from 'tst'
import { is } from 'tst/assert.js'
import jz from '../index.js'
import { levels, onWasi } from './_matrix.js'
import { oracle } from './util.js'

const show = (v) => JSON.stringify(v, (k, x) => x === undefined ? '<undefined>' : x)
const agree = (cases) => {
  for (const [name, src, ...args] of cases) for (const optimize of levels(0, 2, 3)) {
    // the hostless WASI boundary passes no object in and decodes none out
    if (onWasi()) continue
    is(show(jz(src, { optimize }).exports.f(...args)), show(oracle(src).f(...args)), `${name} O${optimize}`)
  }
}

test('member targets: saved numeric keys keep their value across RHS mutations and throws', () => {
  for (const array of ['[2,3]', 'new Float64Array([2,3])']) for (const captured of [false, true]) {
    const source = `export function f(start, next, mode) {
      const a=${array}; let index=${captured ? 'start' : 'start >>> 0'}, calls=0, caught=0
      function value() { calls++; ${captured ? 'index=next;' : ''} if(mode)throw 7; return 19 }
      try { a[index+0]=value() } catch(e) { caught=e }
      return [a[0],a[1],a[start+0],index,calls,caught]
    }`
    for (const optimize of levels(0,1,2,3,'size')) {
      const got=jz(source,{optimize:{level:optimize,sourceInline:false}}).exports.f, want=oracle(source).f
      for (const args of [[0,1,0],[0,1,0],[1,0,0],[0,1,1],[-0,1,0],[0.5,0,0],
        [2147483648,0,0],[4294967296,0,0],[NaN,0,0],[Infinity,0,0],[undefined,0,0],[0,1,0]])
        is(got(...args),want(...args),`O${optimize}, captured=${captured}, ${args}`)
    }
  }
  for (const source of [
    `export function f(mode) { const a=new Float64Array([1,2,3]);let i=1;
      a[i+1]=(i=mode,19);return[a,i] }`,
    `export function f(mode) { let a=new Float64Array([1,2]),i=0,calls=0;const old=a;
      function value(){calls++;if(mode)throw 7;return 19}
      try { a[(a=new Float64Array([5,6]),i++)]=value() }
      catch(e){return[old,a,i,calls,e]};return[old,a,i,calls,0] }`,
    `export function f(mode) { let a=new Float64Array([1,2]),i=0,calls=0;const old=a;
      function value(){calls++;a=new Float64Array(mode?0:2);return 19}
      a[i++]=value();return[old,a,i,calls] }`,
  ]) for (const optimize of levels(0,1,2,3,'size')) {
    const got=jz(source,{optimize:{level:optimize,sourceInline:false}}).exports.f, want=oracle(source).f
    for(const mode of [0,0,1,0])is(got(mode),want(mode),`O${optimize}, receiver and key snapshot, ${mode}`)
  }
})

test('member targets: scalar-replaced receivers preserve effectful stores', () => {
  const cases = [
    `function next(n){if(n<0)throw 7;return n+1}
      export function f(n){const o={x:n};try{o.x=next(n)}catch(e){return[o.x,e]}return[o.x]}`,
    ...['o.x', "o['x']"].map(target =>
      `function next(n){if(n<0)throw 7;return[n,n+1]}
        export function f(n){const o={x:[n]};try{${target}=[...next(n)]}
          catch(e){return[o.x,e]}return[o.x]}`),
    `function next(n){if(n<0)throw 7;return n+1}
      export function f(n){const a=[n];try{a[0]=next(n)}catch(e){return[a[0],e]}return[a[0]]}`,
  ]
  for (const src of cases) for (const level of [0,1,2,3,'size']) {
    const got=jz(src,{optimize:{level,sourceInline:false}}).exports.f, want=oracle(src).f
    for(const n of [1,1,0,5,-1,1])is(got(n),want(n),`O${level}, ${n}: ${src.slice(0,55)}`)
  }
})

test('member targets: a destructuring assignment writes through member targets', () => agree([
  ['object pattern', `export let f = (o) => { let t = {}; ({a: t.x, b: t.y} = o); return t }`, { a: 1, b: 2 }],
  ['array pattern', `export let f = (arr) => { let t = {}, u = [0, 0]; let i = 1; [t.x, u[i]] = arr; return [t, u] }`, [7, 8]],
  ['nested', `export let f = (o) => { let t = {}; ({a: {b: t.y}} = o); return t }`, { a: { b: 5 } }],
  ['a bracket key', `export let f = (o) => { let t = {}; ({a: t['x']} = o); return t }`, { a: 1 }],
  ['a computed key', `export let f = (o, k) => { let t = {}; ({a: t[k]} = o); return t }`, { a: 1 }, 'q'],
  ['module object', `let t = {}\nexport let f = (o) => { ({a: t.x} = o); return t }`, { a: 1 }],
  ['a default', `export let f = (o) => { let t = {}; ({a: t.x = 4} = o); return t }`, {}],
  ['an array default', `export let f = () => { let t = {}; [t.x = 5] = []; return t }`],
  ['returned inside', `export let f = (o) => { let t = {}; ({a: t.x} = o); return [t, { t }] }`, { a: 1 }],
]))

test('member targets: target references evaluate before the source is read', () => {
  const pre = `let log = []\nlet t = {}, u = [0, 0]\nlet getT = () => { log.push('t'); return t }\nlet getU = () => { log.push('u'); return u }\nlet key = (k) => { log.push('k' + k); return k }\n`
  agree([
    ['object', pre + `export let f = () => { let src = { get a() { log.push('get a'); return 1 }, get b() { log.push('get b'); return 2 } }
      ;({ a: getT()[key('x')], b: getU()[key(1)] } = src)
      return [log.join(), t, u] }`],
    ['a computed pattern key first', pre + `export let f = () => { let src = { get a() { log.push('get a'); return 1 } }
      ;({ [key('a')]: getT().x } = src)
      return [log.join(), t] }`],
    ['array', pre + `export let f = () => { let it = { i: 0, next() { log.push('next'); return this.i < 2 ? { value: ++this.i, done: false } : { value: undefined, done: true } }, [Symbol.iterator]() { return this } }
      ;[getT().x, getU()[key(1)]] = it
      return [log.join(), t, u] }`],
    ['a default after the read', pre + `export let f = () => { let src = { get a() { log.push('get a'); return undefined } }
      ;({ a: getT().x = (log.push('dflt'), 5) } = src)
      return [log.join(), t] }`],
  ])
})

test('member targets: the host sees every own property an object holds', () => agree([
  ['an alias write', `export let f = () => { let t = {a: 1}; let u = t; u.x = 2; return t }`],
  ['a helper parameter', `let set = (o) => { o.x = 1 }\nexport let f = () => { let t = {}; set(t); return t }`],
  ['a module object', `let t = { a: 1 }\nlet u = t\nu.y = 2\nexport let f = () => { let v = t; v.x = 3; return t }`],
  ['an accessor', `export let f = () => { let t = { a: 1, get b() { return 2 } }; let u = t; u.x = 3; return t }`],
  ['an accessor on a module object', `let t = { a: 1, get b() { return 2 } }\nexport let f = () => { let u = t; u.x = 3; return t }`],
  ['index keys first', `export let f = () => { let t = { a: 1 }; let u = t; u[2] = 'two'; u.x = 3; u[1] = 'one'; return t }`],
  ['a slot written again', `export let f = () => { let t = { a: 1 }; let u = t; u.x = 3; u.a = 5; return t }`],
  ['a deleted slot', `export let f = (k) => { let o = { a: 1, b: 2 }; delete o[k]; return [o, o.a] }`, 'a'],
]))


test('member targets: RHS calls and conversions keep the original receiver', () => {
  const rows = [
    ['fixed array', '[1]', '[9]', 'out[0]=rhs()', '[old[0],out[0]]'],
    ['growing array', '[]', '[9]', 'out[5]=rhs()', '[old[5],old.length,out[0],out.length]'],
    ['array length', '[1]', '[9]', 'out.length=rhs()', '[old.length,out.length,out[0]]'],
    ['object field', '{x:1}', '{x:9}', 'out.x=rhs()', '[old.x,out.x]'],
    ['object bracket', '{x:1}', '{x:9}', "out['x']=rhs()", '[old.x,out.x]'],
    ['setter', '{x:1,set y(v){this.x=v}}', '{x:9,set y(v){this.x=v}}', 'out.y=rhs()', '[old.x,out.x]'],
    ['typed element', 'new Int32Array([1])', 'new Int32Array([9])', 'out[0]=rhs()', '[old[0],out[0]]'],
    ['dictionary', '{}', '{}', 'out.x=rhs()', '[old.x,out.x]', 'out[String(mode)]=1;'],
  ]
  for (const [label, init, replacement, store, result, setup=''] of rows) {
    const src=`export function f(mode){let out=${init};${setup}const old=out;
      function rhs(){out=${replacement};if(mode===2)throw 7;return 3}
      try{${store};return ${result}}catch(e){return[e,${result}]}}`
    for (const optimize of [0,1,2,3,'size']) {
      const want=oracle(src), got=jz(src,{optimize}).exports
      for (const mode of [0,0,1,2,0,2]) is(got.f(mode),want.f(mode),`${label} O${optimize}, ${mode}`)
    }
  }
  const src=`export function f(mode){
    let out=[1];const old=out;
    const value={valueOf(){out=[9];if(mode)throw 7;return 2}};
    function helper(v){const n=+v;return n+1}
    try{out[0]=helper(value);return[old[0],out[0]]}
    catch(e){return[e,old[0],out[0]]}}
  `
  for (const optimize of [0,1,2,3,'size']) {
    const want=oracle(src), got=jz(src,{optimize}).exports
    for (const mode of [0,0,1,0,1,0]) is(got.f(mode),want.f(mode),`callee conversion O${optimize}, ${mode}`)
  }
})


test('member targets: plain writes preserve key, conversion and error order', () => {
  const cases = [
    `export function f(mode){let trace='',out=[1,2],index=0;const old=out;
      const value={valueOf(){trace+='v';out=[9];index=1;if(mode)throw 7;return 3},
        get x(){trace+='g';out=[9];index=1;if(mode)throw 7;return 3}};
      try{out[index]=mode===2?value.x:+value;return[old[0],old[1],out[0],trace]}
      catch(e){return[e,old[0],old[1],out[0],trace]}}`,
    `export function f(mode){let trace='',out=[1],index=0;const old=out;
      function key(){trace+='k';out=[9];return index++}
      function rhs(){trace+='r';index=5;if(mode)throw 7;return 3}
      try{out[key()]=rhs();return[old[0],out[0],index,trace]}
      catch(e){return[e,old[0],out[0],index,trace]}}`,
    `export function f(mode){let trace='',out=[1];const old=out;
      const key={toString(){trace+='k';out=[9];if(mode===2)throw 8;return '0'}};
      function rhs(){trace+='r';if(mode===1)throw 7;return 3}
      try{out[key]=rhs();return[old[0],out[0],trace]}
      catch(e){return[e,old[0],out[0],trace]}}`,
    ...['out.length=value', "out['length']=value", 'out[0]=value'].map(store =>
      `export function f(mode){let calls=0,out=${store==='out[0]=value'?'new Int32Array([1])':'[1]'};const old=out;
        const value={valueOf(){calls++;out=${store==='out[0]=value'?'new Int32Array([9])':'[9]'};if(mode===1)throw 7;return mode===2?calls:3}};
        try{${store};return[old[0],old.length,out[0],out.length,calls]}
        catch(e){return[e===7?7:e.name,old[0],old.length,out[0],out.length,calls]}}`),
    `export function f(mode){let calls=0,out=[1];const old=out,key=mode===2?'extra':'length';
      const value={valueOf(){calls++;out=[9];if(mode===1)throw 7;return 3}};
      try{out[key]=value;return[old.length,out.length,out[0],out.extra===value,calls]}
      catch(e){return[e,old.length,out.length,out[0],calls]}}`,
    `export function f(mode){let out=[1,2],i=mode&1;const old=out;
      out[i]=(out=[9],i=2,3);return[old[0],old[1],out[0],i]}`,
    `export function f(mode){let out=[1,2];const old=out;
      out[(out=[9],mode&1)]=3;return[old[0],old[1],out[0]]}`,
    ...['3', "'a'", 'true', '2n', 'null', 'undefined'].map(init =>
      `export function f(mode){'use strict';let calls=0;const out=${init};
        function rhs(){calls++;if(mode)throw 7;return 3}
        try{out[0]=rhs();return['ok',calls]}catch(e){return[e===7?7:e.name,calls]}}`),
  ]
  for (let i=0;i<cases.length;i++) for (const optimize of [0,1,2,3,'size']) {
    const src=cases[i], want=oracle(src), got=jz(src,{optimize}).exports
    for (const mode of [0,0,1,2,0,2]) is(got.f(mode),want.f(mode),`reference order ${i} O${optimize}, ${mode}`)
  }
})


test('member targets: primitive write errors follow property-key conversion', () => {
  for (const init of ['3', "'a'", 'true', '2n', 'null', 'undefined', '[{},3,null][mode%3]']) {
    const src=`export function f(mode){'use strict';let trace='';const out=${init};
      const key={toString(){trace+='k';if(mode>=3)throw 7;return 'x'}};
      function rhs(){trace+='r';if(mode===6)throw 8;return 3}
      try{out[key]=rhs();return['ok',trace,out.x]}
      catch(e){return[e===7?7:e===8?8:e.name,trace]}}`
    for (const optimize of [0,1,2,3,'size']) {
      const want=oracle(src), got=jz(src,{optimize}).exports
      for (const mode of [0,0,1,2,3,4,5,6,0]) is(got.f(mode),want.f(mode),`${init} O${optimize}, ${mode}`)
    }
  }
})

test('member targets: native sidecars retain identity and Symbol stores', () => {
  for(const init of ['new Date(10)','new Map()','new Set()','new ArrayBuffer(8)']) {
    const src=`export function f(mode){
      const object=${init},alias=object,key=Symbol('value');
      object[key]=7;object.value=11;alias[mode?'extra':'value']=13;
      return[object===alias,object[key],object.value,object.extra,alias[key]]
    }`
    for(const optimize of [0,1,2,3,'size']) {
      const got=jz(src,{optimize}).exports.f,want=oracle(src).f
      for(const mode of [0,0,1,0])is(got(mode),want(mode),`O${optimize}, ${init}, ${mode}`)
    }
  }
})
