// jz/interop — standalone host-side boundary bridge.
//
// Validates that prebuilt jz wasm bytes can be instantiated and called using
// ONLY the `jz/interop` subpath (no compiler / parser / watr dep). The wasm is
// produced once via the full jz pipeline, then handed to the subpath as bytes.
//
// We import the subpath via its package specifier (`jz/interop`) — Node
// resolves it through the package.json exports map, exactly as a downstream
// consumer would. That doubles as a check that the exports map is correct.

import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import * as interop from 'jz/interop'
import { onWasi, onKernel, levels, belowOpt } from './_matrix.js'
import { HEAP } from '../layout.js'
import { oracle } from './util.js'
import { compile as wasm } from 'watr'

// ── subpath surface ─────────────────────────────────────────────────────────

test('interop: host throws enter source catch without changing their values', () => {
  const src=`import {fail} from 'host';let calls=0;
    export function caught(){try{return fail()}catch(e){return e}finally{calls++}}
    export function ignored(){try{fail()}catch{}return 7}
    export function count(){return calls}
    export function arithmetic(){try{fail()}catch(e){try{return e+1}catch(x){return x.name}}}
    export function uncaught(){return fail()}`
  for(const optimize of [...levels(0,1,2,3,'size'),{level:1,arenaRewind:true,arenaReach:false}]) {
    let value, shouldThrow=true
    const got=interop.instantiate(compile(src,{optimize,imports:{host:{fail:{params:0}}}}),
      {imports:{host:{fail(){if(shouldThrow)throw value;return 17}}}})
    const object=new class{valueOf(){throw 99}toString(){throw 98}}, symbol=Symbol('thrown')
    const foreign=new WebAssembly.Exception(new WebAssembly.Tag({parameters:['i32']}),[7])
    Object.defineProperty(foreign,'is',{get(){throw new Error('unexpected exception member')}})
    const forged=new Float64Array(new BigUint64Array([0x7ffd800000000001n,0x7ffb000000000001n,0xfffc800000000001n]).buffer)
    const values=[undefined,null,false,true,0,-0,NaN,...forged,Infinity,-Infinity,3n,-4n,
      'x','a thrown string longer than SSO',object,symbol,new RangeError('host error'),
      foreign]
    for(const thrown of values) {
      value=thrown
      ok(Object.is(got.exports.caught(),value),`identity ${typeof value} O${optimize}`)
      is(got.exports.ignored(),7,`unused catch O${optimize}`)
    }
    is(got.exports.count(),values.length,`finally once O${optimize}`)
    shouldThrow=false
    is(got.exports.caught(),17,`success after errors O${optimize}`)
    shouldThrow=true;value=object
    ok(got.exports.caught()===object,`error after success O${optimize}`)
    value=new TypeError('uncaught')
    throws(()=>got.exports.uncaught(),e=>e===value,`uncaught Error identity O${optimize}`)
    value=23
    throws(()=>got.exports.uncaught(),e=>e.thrown===23,`existing arbitrary-throw API O${optimize}`)
    is(got.exports.ignored(),7,`reuse after uncaught O${optimize}`)
    value=7n
    is(got.exports.arithmetic(),'TypeError',`host BigInt retains mixed-arithmetic rejection O${optimize}`)
    ok(typeof got.instance.exports.__jz_throw_host==='function',`integer ingress O${optimize}`)
  }
  // The bridge is not emitted for a closed source exception or an import with
  // no source handler. An otherwise scalar ignored catch can still accept any value.
  for(const source of ['export function f(x){try{if(x)throw x}catch{}return 7}',
    `import {fail} from 'host';export function f(){return fail()}`]) {
    const mod=new WebAssembly.Module(compile(source,{imports:{host:{fail:{params:0}}}}))
    ok(!WebAssembly.Module.exports(mod).some(e=>e.name==='__jz_throw_host'),'no unused host bridge')
  }
  const ignored=interop.instantiate(compile(`import {fail} from 'host';export function f(){try{fail()}catch{}return 7}`,
    {imports:{host:{fail:{params:0}}}}),{imports:{host:{fail(){throw 7n}}}})
  is(ignored.exports.f(),7,'scalar source catch accepts heap-backed host BigInt')
})

test('interop: legacy host calls keep their object-key-arguments ABI', () => {
  const bytes=wasm(`(module
    (import "env" "__ext_call" (func $call (param i64 i64 i64) (result i64)))
    (import "env" "__ext_prop" (func $read (param i64 i64) (result i64)))
    (memory (export "memory") 1)
    (func (export "read") (param i64 i64) (result i64) (call $read (local.get 0) (local.get 1)))
    (func (export "invoke") (param i64 i64 i64) (result i64)
      (call $call (local.get 0) (local.get 1) (local.get 2))))`)
  const {instance,memory}=interop.instantiate(bytes)
  let gets=0
  const object={value:4,get run(){gets++;return function(x){return this.value+x}}}
  const receiver=memory.External(object),args=memory.Array([3])
  is(memory.read(instance.exports.invoke(receiver,memory.String('run'),args)),7,'legacy method receiver')
  is(gets,1,'legacy method getter runs once')
  const bound=instance.exports.read(receiver,memory.String('run'))
  is(memory.read(instance.exports.invoke(bound,interop.UNDEF_NAN,args)),7,'legacy property method remains bound')
  is(gets,2,'legacy property getter runs once')
  const plain=memory.External(function(x){return this===undefined?x+2:-1})
  is(memory.read(instance.exports.invoke(plain,interop.UNDEF_NAN,args)),5,'legacy direct function')
  throws(()=>instance.exports.invoke(receiver,memory.String('missing'),args),TypeError,'missing legacy method throws')
})

test('interop: duplicate import records wrap a host slot once', () => {
  const bytes=wasm(`(module
    (import "host" "fail" (func $first)) (import "host" "fail" (func $second))
    (tag $error (param f64))
    (memory (export "memory") 1)
    (global $last (export "__jz_last_err_bits") (mut i64) (i64.const 0))
    (func (export "__jz_throw_host") (param i64)
      (global.set $last (local.get 0)) (throw $error (f64.reinterpret_i64 (local.get 0))))
    (func (export "first") (call $first))
    (func (export "second") (call $second)))`)
  const value=Symbol('same slot');let calls=0
  const {exports}=interop.instantiate(bytes,{imports:{host:{fail(){calls++;throw value}}}})
  for(const name of ['first','second','first'])throws(()=>exports[name](),e=>e.thrown===value,'same thrown Symbol')
  is(calls,3,'each import calls host exactly once')
})

test('interop: host property and method errors retain class, identity and effects', () => {
  if(onWasi()||onKernel())return // native host objects are the JS-host contract
  const src=`import {get,arg} from 'host';
    export function read(){try{return get().x}catch(e){return e}}
    export function write(){try{get().x=7;return 0}catch(e){return e}}
    export function keyed(k){try{get()[k]=7;return 0}catch(e){return e}}
    export function method(){try{return get().run(arg())}catch(e){return e}}
    export function computed(k){try{return get()[k](arg())}catch(e){return e}}
    export function optional(k){try{return get()[k]?.(arg())}catch(e){return e}}
    export function direct(){const fn=get();try{return fn(arg())}catch(e){return e}}
    export function alternate(useHost){const o=useHost?get():{run(x){return x+2}};try{return o.run(arg())}catch(e){return e}}
    export function dateMethod(){try{return get().getTime(arg())}catch(e){return e}}
    export function callMethod(){try{return get().call(arg())}catch(e){return e}}
    export function applyMethod(){try{return get().apply(arg())}catch(e){return e}}
    export function badMethod(){try{return get().bad(arg())}catch(e){return e instanceof TypeError}}
    export function typed(){try{return get().read()}catch(e){return e}}
    export function classify(){try{return get().x}catch(e){return [e.name,e.message,e instanceof Error,e instanceof RangeError,e instanceof TypeError]}}
    export function brand(x){return [x instanceof Error,x instanceof RangeError]}`
  for(const optimize of levels(0,1,2,3,'size')) {
    let trace='',value=new RangeError('getter'),fail=true,getterFails=false
    const method=function(n){trace+='m';if(fail)throw value;return this===object?12+n:-1}
    for(const key of ['name','length','bind','apply'])Object.defineProperty(method,key,{get(){throw new Error(`unexpected method ${key}`)}})
    const object=new class{
      get x(){trace+='r';if(fail)throw value;return 11}
      set x(v){trace+='w'+v;if(fail)throw value}
      get run(){trace+='q';if(getterFails)throw value;return method}
      get getTime(){return this.run}
      get call(){return this.run}
      get apply(){return this.run}
      get bad(){trace+='b';return 7}
    }
    let receiver=object
    const instance=interop.instantiate(compile(src,{optimize,imports:{host:{get:{params:0},arg:{params:0}}}}),
      {imports:{host:{get(){trace+='g';return receiver},arg(){trace+='a';return 1}}}})
    const got=instance.exports
    for(const [name,want] of [['read','gr'],['write','gw7'],['keyed','gw7'],['method','gqam']]) {
      trace='';ok(got[name]('x')===value,`${name} identity O${optimize}`)
      is(trace,want,`${name} once/order O${optimize}`)
    }
    is(got.classify(),['RangeError','getter',true,true,false],`Error brand O${optimize}`)
    value={name:'RangeError',message:'plain'}
    is(got.classify(),['RangeError','plain',false,false,false],`plain shape is not an Error O${optimize}`)
    for(const other of [7,-0,NaN,Symbol(),null,undefined,value])
      is(got.brand(other),[false,false],`non-Error brand O${optimize}`)
    fail=false;is(got.read(),11,`read reuse O${optimize}`)
    trace='';is(got.method(),13,`method reuse O${optimize}`);is(trace,'gqam',`method getter before arguments O${optimize}`)
    trace='';is(got.computed('run'),13,`computed method receiver O${optimize}`);is(trace,'gqam',`computed method getter before arguments O${optimize}`)
    trace='';is(got.optional('run'),13,`optional computed receiver O${optimize}`);is(trace,'gqam',`optional computed method order O${optimize}`)
    trace='';is(got.optional('missing'),undefined,`optional absent method O${optimize}`);is(trace,'g',`optional absent method skips arguments O${optimize}`)
    const key=new class{toString(){trace+='k';return 'run'}}
    trace='';is(got.computed(key),13,`computed key coercion O${optimize}`);is(trace,'gkqam',`computed key before getter O${optimize}`)
    trace='';is(got.alternate(true),13,`closure fork host O${optimize}`);is(trace,'gqam',`closure fork getter before arguments O${optimize}`)
    trace='';is(got.alternate(false),3,`closure fork internal O${optimize}`);is(trace,'a',`internal arguments once O${optimize}`)
    trace='';is(got.dateMethod(),13,`Date fork host O${optimize}`);is(trace,'gqam',`Date fork getter before arguments O${optimize}`)
    for(const name of ['callMethod','applyMethod']) {
      trace='';is(got[name](),13,`${name} host O${optimize}`);is(trace,'gqam',`${name} getter before arguments O${optimize}`)
    }
    getterFails=true;trace='';ok(got.method()===value,`method getter throw O${optimize}`);is(trace,'gq',`getter throw skips arguments O${optimize}`)
    trace='';ok(got.computed('run')===value,`computed getter throw O${optimize}`);is(trace,'gq',`computed getter throw skips arguments O${optimize}`)
    trace='';is(got.badMethod(),true,`non-callable method TypeError O${optimize}`);is(trace,'gba',`non-callable check follows arguments O${optimize}`)
    const typed=new BigInt64Array([6n]);typed.read=function(){return this[0]}
    receiver=instance.memory.External(typed)
    is(got.typed(),6n,`captured method keeps typed BigInt receiver evidence O${optimize}`)
    receiver=function(n){trace+='d';return this===undefined?n+3:-1}
    trace='';is(got.direct(),4,`held function has no receiver O${optimize}`);is(trace,'gad',`held function arguments once O${optimize}`)
  }
})

test('interop: host exception transport survives callbacks and module initialization', () => {
  const src=`import {call,fail} from 'host';let initialized;
    try{call(()=>{fail()})}catch(e){initialized=e}
    export function init(){return initialized}
    export function local(){const value={n:7};try{call(()=>{throw value})}catch(e){return [e===value,e.n]}}
    export function primitive(){try{call(()=>{throw -0})}catch(e){return e}}
    export function nested(){const value={n:9};try{call(()=>call(()=>{throw value}))}catch(e){return [e===value,e.n]}}
    export function fresh(){try{call(()=>{throw {n:11}})}catch(e){return e.n}}
    export function allocate(){const a=new Float64Array(256);a[0]=91;return a}
    export function caught(){try{return fail()}catch(e){return e}}
    export function raw(){throw -0}`
  for(const optimize of [...levels(0,1,2,3,'size'),{level:1,arenaRewind:true,arenaReach:false}]) {
    const initial=Symbol('initial');let value=initial,seen=0,after
    const options={imports:{host:{call:{params:1},fail:{params:0}}}}
    const bytes=compile(src,{optimize,...options})
    const instance=interop.instantiate(bytes,{imports:{host:{call(callback){seen++;try{return callback()}catch(error){after?.();throw error}},fail(){throw value}}}})
    const got=instance.exports
    ok(got.init()===initial,`initial callback transport O${optimize}`)
    is(seen,1,`initializer once O${optimize}`)
    for(let i=0;i<2;i++) {
      is(got.local(),[true,7],`source object callback identity O${optimize}`)
      ok(Object.is(got.primitive(),-0),`source -0 callback identity O${optimize}`)
      is(got.nested(),[true,9],`nested callback identity O${optimize}`)
    }
    for(value of [19,initial,undefined,19])ok(Object.is(got.caught(),value),`A/A/B reuse O${optimize}`)
    after=()=>instance.instance.exports.raw()
    ok(Object.is(got.primitive(),-0),`raw same-tag callback rethrow O${optimize}`)
    after=()=>is(got.allocate()[0],91,`reentrant allocation O${optimize}`)
    is(got.fresh(),11,`fresh callback throw survives intervening allocation O${optimize}`)
    instance.memory.reset()
    is(got.fresh(),11,`callback throw after reset O${optimize}`)
    const escaping=new RangeError('initialization')
    const initBytes=compile(`import {fail} from 'host';try{fail()}finally{};export function f(){return 7}`,
      {optimize,imports:{host:{fail:{params:0}}}})
    throws(()=>interop.instantiate(initBytes,{imports:{host:{fail(){throw escaping}}}}),e=>e===escaping,`uncaught init O${optimize}`)
  }
})

test('interop: host property reads preserve unbound values and method receivers', () => {
  if(onWasi()||onKernel())return
  const src=`import {get,arg} from 'host';
    export function read(k){return get()[k]}
    export function named(){return get().run}
    export function same(){const o=get();return o.run===o.run}
    export function held(){const fn=get().run;return fn(arg())}
    export function borrowed(k){const o=get(),fn=o[k];return fn.call(o,arg())}
    export function method(){return get().run(arg())}
    export function computed(k){return get()[k](arg())}
    export function optional(k){return get()[k]?.(arg())}
    export function caught(k){try{return get()[k]}catch(e){return e}}
    export function nested(){return get().child.value}
    export function length(){return get().items.length}
    export function sum(){const a=get().items;return a[0]+a[1]}
    export function pushed(){return get().items.push(5)}`
  for(const optimize of levels(0,1,2,3,'size')) {
    let trace='',failure
    const fn=function(n){trace+='f';return this===undefined?n:this===object?n+10:-1}
    for(const key of ['name','length','bind','apply'])Object.defineProperty(fn,key,{get(){throw new Error(`unexpected ${key}`)}})
    const child={value:9},items=[2,4],symbol=Symbol('value')
    const object=new class{
      get run(){trace+='r';return fn}
      get bad(){trace+='b';throw failure}
      child=child;items=items;symbol=symbol
    }
    const options={optimize,imports:{host:{get:{params:0},arg:{params:0}}}}
    const {exports:g,memory}=interop.instantiate(compile(src,options),{imports:{host:{get(){trace+='g';return object},arg(){trace+='a';return 3}}}})
    for(let i=0;i<2;i++) {
      trace='';ok(g.named()===fn,'named function identity');is(trace,'gr','named getter once')
      trace='';ok(g.read('run')===fn,'computed function identity');is(trace,'gr','computed getter once')
      trace='';is(g.same(),true,'repeated property reads retain identity');is(trace,'grr','both reads occur')
      trace='';is(g.held(),3,'extracted call has undefined receiver');is(trace,'graf','extracted call order')
      trace='';is(g.borrowed('run'),13,'an extracted function accepts an explicit receiver');is(trace,'graf','explicit receiver call order')
      for(const name of ['method','computed','optional']) {
        trace='';is(g[name]('run'),13,`${name} retains receiver`);is(trace,'graf',`${name} order`)
      }
      ok(g.read('child')===child,'nested object identity');is(g.read('items'),items,'array retains native marshalling')
      ok(g.read('symbol')===symbol,'Symbol identity')
      is(g.nested(),9,'nested property access')
      is(g.length(),2,'nested array length');is(g.sum(),6,'nested array indexed reads');is(g.pushed(),3,'native array method on marshalled value')
    }
    failure=new RangeError('get');trace=''
    throws(()=>g.read('bad'),e=>e===failure,'uncaught property error identity');is(trace,'gb','throwing getter once')
    ok(g.caught('bad')===failure,'caught property error identity')
    memory.reset();ok(g.named()===fn,'identity after reset')
    const bare=interop.instantiate(compile(`import {get,arg} from 'host';export function f(k){const o=get(),fn=o[k];return [fn===o[k],fn(arg()),o[k](arg())]}`,options),
      {imports:{host:{get(){trace+='g';return object},arg(){trace+='a';return 3}}}})
    trace='';is(bare.exports.f('run'),[true,3,13],'same calls without any source handler');is(trace,'grrafraf','bare calls preserve evaluation order')
    ok(!bare.instance.exports.__jz_throw_host,'unbound reads do not require exception ingress')
  }
})

test('interop: unused host parameters do not convert or copy their arguments', () => {
  const src=`export function one(k){return 7}
    export function two(k,v){return v}
    export function three(a,b,c){return b}
    export function four(a,b,c,d){return b}
    export function heap(k,v){return [v,v+1]}
    export function rest(v,...unused){return [v]}
    export function text(k){return 'k'}`
  for(const optimize of levels(0,1,2,3,'size')) {
    const got=interop.instantiate(compile(src,{optimize})).exports
    let touched=0
    const hostile={get valueOf(){touched++;throw 9},get toString(){touched++;throw 8}}
    const array=[1];Object.defineProperty(array,0,{get(){touched++;throw 7}})
    for(const value of [Symbol('ignored'),1n,-1n,0x7ffb000000000001n,hostile,array,null,undefined]) {
      is(got.one(value),7,`one O${optimize}`)
      is(got.two(value,7),7,`two O${optimize}`)
      is(got.three(value,7,value),7,`three O${optimize}`)
      is(got.four(value,7,value,value),7,`general O${optimize}`)
      is(got.heap(value,7),[7,8],`heap O${optimize}`)
      is(got.rest(7,value,value),[7],`unused rest O${optimize}`)
      is(got.text(value),'k',`literal name O${optimize}`)
      is(got.heap(value,7,value),[7,8],`ignored extra O${optimize}`)
    }
    is(touched,0,`no argument read O${optimize}`)
    let trace=''
    const argument=()=>{trace+='a';return hostile}, result=()=>{trace+='b';return 7}
    is(got.two(argument(),result()),7,`arguments evaluated O${optimize}`)
    is(trace,'ab',`argument order O${optimize}`)
    throws(()=>got.two((()=>{throw 6})(),result()),e=>e===6,`argument error O${optimize}`)
    is(got.two(Symbol(),7),7,`reuse O${optimize}`)
  }
})

test('interop: unused ingress preserves defaults and live parameter observations', () => {
  const src=`let calls=0,fail=0;function init(){calls++;if(fail)throw 9;return 1}
    export function setup(n){fail=n}
    export function ignored(k=init(),v=7){return [v,calls]}
    export function type(k){return typeof k}
    export function capture(k){const read=()=>typeof k;return read()}
    export function fromDefault(k,v=k){return typeof v}
    export function key(k){const o={};o[k]=7;return o[k]}
    export function numeric(k){return k*2}`
  for(const optimize of levels(0,1,2,3,'size')) {
    const got=interop.instantiate(compile(src,{optimize})).exports,want=oracle(src)
    for(const value of [Symbol(),undefined,null,1n,undefined])
      is(got.ignored(value,7),want.ignored(value,7),`default presence O${optimize}`)
    got.setup(1);want.setup(1)
    throws(()=>got.ignored(),e=>e.thrown===9,`default throws O${optimize}`)
    throws(()=>want.ignored(),e=>e===9)
    got.setup(0);want.setup(0)
    is(got.ignored(),want.ignored(),`default reuse O${optimize}`)
    for(const value of [Symbol(),7,null,undefined])for(const name of ['type','capture','fromDefault','key'])
      is(got[name](value),want[name](value),`live ${name} O${optimize}`)
    let count=0
    is(got.numeric({valueOf(){count++;return 3}}),6,`live conversion O${optimize}`)
    is(count,1,`live conversion once O${optimize}`)
    throws(()=>got.numeric({valueOf(){throw 8}}),e=>e===8,`live conversion throws O${optimize}`)
    is(got.numeric(4),8,`live conversion reuse O${optimize}`)
  }
})

test('interop: ignored extras leave arguments, rest and default captures observable', () => {
  const src=`export function zero(){return 7}
    export function arity(){return arguments.length}
    export function indexed(){return typeof arguments[2]}
    export function named(a){return [arguments.length,typeof arguments[1],a]}
    export function rest(v,...xs){return [xs.length,typeof xs[0],v]}
    export function captured(k,read=()=>typeof k){return read()}`
  for(const optimize of levels(0,1,2,3,'size')) {
    const got=interop.instantiate(compile(src,{optimize})).exports,want=oracle(src)
    const hostile={valueOf(){throw 9},toString(){throw 8}}
    is(got.zero(Symbol(),hostile,1n),7,`zero arity ignores extras O${optimize}`)
    for(const tail of [[],[Symbol()],[hostile,Symbol(),null]]) {
      for(const name of ['arity','indexed','named','rest'])
        is(got[name](7,...tail),want[name](7,...tail),`argument observation ${name} O${optimize}`)
      is(got.captured(tail[0]),want.captured(tail[0]),`default capture O${optimize}`)
    }
  }
})

test('interop: grown collections decode live entries in insertion order', () => {
  const src = `
    export function array(n){const a=[];for(let i=0;i<n;i++)a.push('k'+i);return a}
    export function dict(n,edit){const d={};for(let i=0;i<n;i++){const k=i%7?'k'+i:''+i;d[k]=(d[k]|0)+i}
      if(edit&&n>1){const k='k1';delete d[k];d[k]=n*2}return d}
    export function map(n,edit){const m=new Map();for(let i=0;i<n;i++)m.set(i%7?'k'+i:i,i);
      if(edit&&n>1){m.delete('k1');m.set('k1',n*2)}if(edit===2)m.clear();return m}
    export function set(n,edit){const s=new Set();for(let i=0;i<n;i++)s.add(i%7?'k'+i:i);
      if(edit&&n>1){s.delete('k1');s.add('k1')}if(edit===2)s.clear();return s}`
  const native = oracle(src)
  for (const optimize of levels(0, 2, 3, 'size')) {
    const compiled = interop.instantiate(compile(src, { optimize })).exports
    for (const n of [0, 1, 1, 6, 7, 8, 9, 13, 80, 0, 3]) {
      is(compiled.array(n), native.array(n), `O${optimize}, array n=${n}`)
      for (const edit of [0, 1, 2]) {
        is(Object.entries(compiled.dict(n, edit)), Object.entries(native.dict(n, edit)), `O${optimize}, dictionary n=${n}, edit=${edit}`)
        is([...compiled.map(n, edit)], [...native.map(n, edit)], `O${optimize}, Map n=${n}, edit=${edit}`)
        is([...compiled.set(n, edit)], [...native.set(n, edit)], `O${optimize}, Set n=${n}, edit=${edit}`)
      }
    }
  }
})

test('interop: subpath surface matches expected exports', () => {
  for (const name of ['instantiate', 'toModule', 'memory', 'wrap', 'ptr', 'offset', 'type', 'aux',
                      'i64ToF64', 'f64ToI64', 'coerce', 'NULL_NAN', 'UNDEF_NAN']) {
    ok(name in interop, `jz/interop missing export: ${name}`)
  }
})

test('interop: instantiate works on baseline wasm', () => {
  const wasm = compile(`export let f = (x) => x + 1`)
  const { exports } = interop.instantiate(wasm)
  is(exports.f(41), 42)
})

test('package: root and every public subpath ship declarations; pointer carriers are bigint', async () => {
  const { readFileSync, existsSync } = await import('node:fs')
  const root = new URL('../', import.meta.url)
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
  for (const subpath of ['.', './interop']) {
    const entry = pkg.exports[subpath]
    ok(entry && typeof entry === 'object' && entry.types, `${subpath} has a types export`)
    ok(existsSync(new URL(entry.types.replace(/^\.\//, ''), root)), `${entry.types} exists`)
    ok(pkg.files.includes(entry.types.replace(/^\.\//, '')), `${entry.types} ships in npm files`)
  }
  const rootTypes = readFileSync(new URL('index.d.ts', root), 'utf8')
  ok(rootTypes.includes('export type JzPointer = bigint'), 'public pointer carrier is bigint')
  ok(!/String\(str: string\): number/.test(rootTypes), 'string allocator is not mistyped as number')
  for (const name of ['interop.d.ts'])
    ok(readFileSync(new URL(name, root), 'utf8').length > 0, `${name} is non-empty`)
})

test('interop: subpath stays compiler-free with only host and codec dependencies', async () => {
  // The whole point of the subpath: it can be loaded without dragging in the
  // compiler. Enforce it as a static contract — `jz/interop` may import only
  // host linking, layout, error metadata and the UTF-8 codec for worklet hosts.
  // Compiler dependencies must never enter this path.
  const { readFileSync } = await import('node:fs')
  const url = await import.meta.resolve('jz/interop')
  const src = readFileSync(new URL(url), 'utf8')
  const imports = [...src.matchAll(/^import\s.*?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1])
  const allowed = new Set(['./wasi.js', './layout.js', './err-codes.js', './utf8.js'])
  for (const imp of imports) {
    ok(allowed.has(imp), `jz/interop imports ${imp} — only ${[...allowed].join(', ')} are allowed`)
    for (const forbidden of ['subscript', 'watr', './src/', './index.js', './module/']) {
      ok(!imp.includes(forbidden), `jz/interop must not import '${forbidden}'`)
    }
  }
})

// ── prebuilt-wasm round-trip ────────────────────────────────────────────────
// Compile once via the full pipeline, then drive the resulting bytes through
// the subpath alone. Mirrors what a downstream "ship the .wasm" consumer does.

test('interop: instantiate prebuilt wasm — scalar args & return', () => {
  const wasm = compile(`export let add = (a, b) => a + b`)
  const { exports } = interop.instantiate(wasm)
  is(exports.add(2, 3), 5)
  is(exports.add(0.5, 0.25), 0.75)
})

test('interop: instantiate prebuilt wasm — string in, length out', () => {
  const wasm = compile(`export let len = (s) => s.length`)
  const { exports, memory } = interop.instantiate(wasm)
  is(exports.len(memory.String('hello')), 5)
  is(exports.len(memory.String('')), 0)
  // ASCII-range coverage is enough for the interop test — multi-byte/codepoint
  // string semantics belong with the string suite.
  is(exports.len(memory.String('abcdefghij')), 10)
})

test('interop: instantiate prebuilt wasm — array in, reduce out', () => {
  const wasm = compile(`export let sum = (a) => a.reduce((s, x) => s + x, 0)`)
  const { exports, memory } = interop.instantiate(wasm)
  is(exports.sum(memory.Array([1, 2, 3, 4])), 10)
  is(exports.sum(memory.Array([])), 0)
})

test('interop: instantiate prebuilt wasm — object schema round-trip', () => {
  if (onWasi()) return  // wasi: external object
  // Plain arithmetic to keep the test about object marshaling, not pow precision.
  const wasm = compile(`export let f = (p) => p.x * 10 + p.y`)
  const { exports, memory } = interop.instantiate(wasm)
  is(exports.f(memory.Object({ x: 3, y: 4 })), 34)
})

test('interop: instantiate prebuilt wasm — typed array in, scalar out', () => {
  // Returning a typed array crosses into jz-semantics territory (covered in
  // test/mem.js). Here we just prove a typed array marshals IN correctly.
  const wasm = compile(`export let sum = (buf) => buf[0] + buf[1] + buf[2]`)
  const { exports, memory } = interop.instantiate(wasm)
  is(exports.sum(memory.Float64Array([1.5, 2.5, 3])), 7)
})

test('interop: instantiate accepts a WebAssembly.Module directly', () => {
  const wasm = compile(`export let f = (x) => x + 1`)
  const mod = new WebAssembly.Module(wasm)
  const { exports } = interop.instantiate(mod)
  is(exports.f(41), 42)
})

test('interop: instantiate accepts ArrayBuffer', () => {
  const wasm = compile(`export let f = () => 7`)
  // Slice into a fresh ArrayBuffer that's NOT a Uint8Array view
  const ab = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength)
  const { exports } = interop.instantiate(ab)
  is(exports.f(), 7)
})

test('interop: imports option still routes through subpath', () => {
  if (onKernel()) return  // kernel: host {imports} option doesn't reach the single-source self-compile
  const wasm = compile(`import { dbl } from "h"; export let f = (x) => dbl(x) + 1`,
    { imports: { h: { dbl: { params: 1 } } } })
  const { exports } = interop.instantiate(wasm, { imports: { h: { dbl: x => x * 2 } } })
  is(exports.f(20), 41)
})

test('interop: null/undefined sentinels round-trip', () => {
  const wasm = compile(`export let f = (x) => x`)
  const { exports } = interop.instantiate(wasm)
  is(exports.f(null), null)
  is(exports.f(undefined), undefined)
  is(exports.f(42), 42)
})

test('interop: property dispatch converts once regardless of declaration order', () => {
  if (onWasi() || onKernel()) return
  const named = `export function named(){return get().value}`
  const computed = `export function f(k){let calls=0;const key={toString(){calls++;return k}};
    const o=get();return [o[key],calls]}`
  for (const declarations of [[computed, named], [named, computed], [computed]])
  for (const optimize of levels(0, 2, 3, 'size')) {
    let value = 7, reads = 0
    const object = new class { get value() { reads++; return value } }
    const src = `import {get} from 'host'; ${declarations.join('\n')}`
    const bytes = compile(src, { optimize, imports: { host: { get: { params: 0 } } } })
    const { exports } = interop.instantiate(bytes, { imports: { host: { get: () => object } } })
    for (const next of [7, 7, 13, undefined, 7]) {
      value = next
      is(exports.f('value'), [value, 1], `O${optimize}: computed host property`)
      is(exports.f('absent'), [undefined, 1], `O${optimize}: missing host property`)
      if (exports.named) is(exports.named(), value, `O${optimize}: prehashed host property`)
    }
    is(reads, exports.named ? 10 : 5, 'one host getter invocation per present-key read')
  }
})

test('interop: computed stores reach the host receiver for string and Symbol keys', () => {
  if (onWasi() || onKernel()) return
  const src = `import {get} from 'host';
    export function f(key,value){const o=get();const assigned=o[key]=value;
      return [assigned,o[key],key in o,delete o[key],key in o]}
    export function own(value){const o=get(),key=Symbol('key');o[key]=value;
      return [key,o[key],key in o,delete o[key],key in o]}`
  for (const optimize of levels(0,1,2,3,'size')) {
    let current, watched
    const events = [], keys = ['field','',0,-1,1.5,4294967296,Symbol.for('external store'),Symbol('same'),Symbol('same')]
    const receiver = () => new Proxy(new class {}, {
      get(o,k){if(k===watched)events.push('g');return Reflect.get(o,k)},
      set(o,k,v){events.push('s');return Reflect.set(o,k,typeof v==='number'?v+1:v)},
      has(o,k){events.push('h');return Reflect.has(o,k)},
      deleteProperty(o,k){events.push('d');return Reflect.deleteProperty(o,k)}
    })
    const a=receiver(),b=receiver()
    const got=interop.instantiate(compile(src,{optimize,imports:{host:{get:{params:0}}}}),
      {imports:{host:{get:()=>current}}}).exports
    for(const object of [a,a,b,a]) for(const key of keys) for(const value of [7,'text',null,undefined,Symbol.for('value')]) {
      current=object;watched=typeof key==='symbol'?key:String(key);events.length=0
      is(got.f(key,value),[value,typeof value==='number'?value+1:value,true,true,false],`O${optimize}: host result ${String(key)}`)
      is(events.join(''),'sghdh','one host set, read, membership, delete, membership')
    }
    const symbols=[]
    current=a
    for(let i=0;i<3;i++) {
      events.length=0
      const result=got.own(i)
      is(typeof result[0],'symbol','a compiled Symbol remains a host property key')
      is(result.slice(1),[i+1,true,true,false],'compiled Symbol writes share the host property')
      ok(!symbols.includes(result[0]),'each call keeps its fresh Symbol identity')
      symbols.push(result[0])
    }
  }
})

test('interop: computed host stores preserve reference, key and RHS effects', () => {
  if (onWasi() || onKernel()) return
  const src=`import {get,key,value} from 'host';export function f(){const o=get();return o[key()]=value()}`
  for(const optimize of levels(0,1,2,3,'size')) {
    let state
    const got=interop.instantiate(compile(src,{optimize,imports:{host:{get:{params:0},key:{params:0},value:{params:0}}}}),
      {imports:{host:{get:()=>state.get(),key:()=>state.key(),value:()=>state.value()}}}).exports
    const run=(call,mode,symbol)=>{
      const trace=[],before={},after={},property=symbol?Symbol('key'):'field'
      let active
      const target=new Proxy(new class {},{set(o,k,v){trace.push('s');
        if(mode===5)throw new RangeError('setter');if(mode===6)return false;before[k]=v;return true}})
      active=target
      state={
        get(){trace.push('r');if(mode===1)throw new RangeError('receiver');return mode===7?null:active},
        key(){trace.push('q');if(mode===2)throw new RangeError('key expression');
          return{[Symbol.toPrimitive](hint){trace.push(hint);if(mode===4)throw new RangeError('key conversion');active=after;return property}}},
        value(){trace.push('v');if(mode===3)throw new RangeError('RHS');active=after;return 19}
      }
      let answer
      try{answer=['value',call()]}catch(e){answer=['error',e.name,e.message]}
      return [answer,trace,before[property],Reflect.ownKeys(after).length]
    }
    const plain=()=>{const o=state.get();return o[state.key()]=state.value()}
    for(const mode of [0,0,1,2,3,4,5,6,7,0])for(const symbol of [false,true]) {
      const actual=run(()=>got.f(),mode,symbol),expected=run(plain,mode,symbol)
      // Native engines choose their own TypeError text for rejected writes.
      if(actual[0][0]==='error')actual[0].length=2
      if(expected[0][0]==='error')expected[0].length=2
      is(actual,expected,`O${optimize}: order/error ${mode}, Symbol ${symbol}`)
    }
  }
})

test('interop: write-only host stores link their own external dispatch', () => {
  if (onWasi() || onKernel()) return
  for(const optimize of levels(0,1,2,3,'size'))for(const target of ['o[k]','o[0]','o.field']) {
    const src=`import {get} from 'host';export function f(k,v){const o=get();return ${target}=v}`
    let calls=0
    const object=new Proxy(new class {},{set(o,k,v){calls++;return Reflect.set(o,k,v)}})
    const got=interop.instantiate(compile(src,{optimize,imports:{host:{get:{params:0}}}}),
      {imports:{host:{get:()=>object}}}).exports
    for(const key of ['field','',-1,1.5,4294967296,Symbol('key')])for(const value of [7,undefined]) {
      const actualKey=target==='o[0]'?'0':target==='o.field'?'field':key
      const before=calls
      is(got.f(target==='o[k]'?key:0,value),value,`O${optimize}: assignment returns RHS`)
      is(calls,before+1,`${target}: host setter invoked once without a read forcing host demand`)
      ok(Object.hasOwn(object,actualKey),'the host has the stored property even for undefined')
      is(object[actualKey],value,'the host holds the assigned value')
    }
  }
})

test('interop: computed host reads preserve empty keys, errors and optional receivers', () => {
  if (onWasi() || onKernel()) return
  const src = `export function read(o,k){return o[k]}
    export function optional(o,k){return o?.[k]}`
  for (const optimize of levels(0, 2, 3, 'size')) {
    const { exports } = interop.instantiate(compile(src, { optimize }))
    const a = new class { get value() { return 7 } get bad() { throw new RangeError('host getter') } }
    const b = new class { get value() { return 13 } }
    a[''] = 9
    for (const obj of [a, a, b, a]) {
      for (const key of ['value', '', 'missing']) {
        is(exports.read(obj, key), obj[key], `O${optimize}: direct ${key}`)
        is(exports.optional(obj, key), obj?.[key], `O${optimize}: optional ${key}`)
      }
    }
    for (const obj of [null, undefined]) {
      is(exports.optional(obj, 'value'), undefined, `O${optimize}: optional nullish`)
      throws(() => exports.read(obj, 'value'), TypeError, `O${optimize}: nullish receiver`)
    }
    throws(() => exports.read(a, 'bad'), RangeError, 'host getter failure propagates')
    is(exports.read(a, 'value'), 7, 'same instance works after a throwing getter')
    for (const src of [
      `export function f(){let k='Math';return globalThis[k].PI}`,
      `function read(o,k){return o[k]} export function f(){return read(globalThis,'Math').PI}`,
      `function read(o,k){return o[k].PI} export function f(){return read(globalThis,'Math')}`
    ]) {
      const global = interop.instantiate(compile(src, { optimize }))
      is(global.exports.f(), Math.PI, 'host-global ingress reaches a reader emitted before its caller')
    }
  }
})

// ── NaN-box codec helpers (used by tooling around prebuilt wasm) ────────────

test('interop: ptr/offset/type/aux codec round-trips', () => {
  // type=4 (string), aux=0, offset=128
  const p = interop.ptr(4, 0, 128)
  is(interop.type(p), 4)
  is(interop.aux(p), 0)
  is(interop.offset(p), 128)
})

test('interop: i64ToF64 / f64ToI64 are bit-cast inverses', () => {
  // ptr() now yields the i64 carrier directly (a BigInt) — no NaN-box ever materializes as f64.
  const box = interop.ptr(6, 3, 1024)
  is(typeof box, 'bigint')
  // i64→f64→i64 round-trips the bits losslessly (the f64 form is intact on V8).
  is(interop.f64ToI64(interop.i64ToF64(box)), box)
  // and the plain-number direction is a clean inverse.
  is(interop.i64ToF64(interop.f64ToI64(3.5)), 3.5)
})

test('interop: boxes carry as i64 BigInt, never an f64 NaN-box (JSC-safe codec)', () => {
  // The Safari fix in one assertion: a box must never become a JS number (f64), or JSC
  // canonicalizes its NaN payload mid-decode. Every box-producing codec entry yields a BigInt,
  // and numbers stay numbers. (Reverting the codec to an f64 representation fails this.)
  is(typeof interop.ptr(4, 0, 1024), 'bigint')
  for (const atom of [interop.NULL_NAN, interop.UNDEF_NAN, interop.TRUE_NAN, interop.FALSE_NAN]) is(typeof atom, 'bigint')
  const { memory, exports } = interop.instantiate(compile('export let f = () => "hello world"'))
  is(typeof memory.String('hello world'), 'bigint')
  is(typeof memory.Array([1, 2, 3]), 'bigint')
  is(typeof memory.Uint8Array([1, 2]), 'bigint')
  is(typeof interop.coerce(null), 'bigint')      // null/undefined coerce to atom boxes
  is(interop.coerce(1.5), 1.5)                   // a number is left a number
  is(exports.f(), 'hello world')                 // and the boxed result still decodes correctly
})

// ── zero-copy I/O: allocTyped + Uint8Array memcpy ───────────────────────────

test('interop: Uint8Array arg crosses via native memcpy (correct for stride-1)', () => {
  // Regression: the inbound TypedArray path gated the fast `.set` memcpy on stride>=2,
  // so a Uint8Array (stride 1, e.g. a whole audio file) fell to a per-byte DataView
  // loop — slow, and a silent miscompile would surface here as a wrong sum.
  const { exports } = interop.instantiate(compile(`
    export let sum = (b) => { let n = b.length, s = 0; for (let i = 0; i < n; i++) s += b[i]; return s }
  `))
  const data = new Uint8Array(1000)
  for (let i = 0; i < data.length; i++) data[i] = i & 0xff
  let expect = 0; for (let i = 0; i < data.length; i++) expect += i & 0xff
  is(exports.sum(data), expect)
})

test('interop: memory.allocTyped gives a live view + box for zero-copy input', () => {
  const { exports, memory } = interop.instantiate(compile(`
    export let dec = (b) => { let n = b.length, o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = b[i] / 255; return o }
  `))
  const { view, box } = memory.allocTyped(Uint8Array, 4)
  ok(view instanceof Uint8Array, 'view is a Uint8Array')
  ok(view.buffer === memory.buffer, 'view aliases wasm memory (zero-copy)')
  ok(typeof box === 'bigint', 'box is an i64 carrier')
  view.set([0, 64, 128, 255])               // fill the wasm-memory region directly
  const out = exports.dec(box)              // decoder reads in place — no 2nd copy
  ok(out.buffer === memory.buffer, 'result is a zero-copy view over wasm memory')
  is(out[0], 0); is(Math.round(out[3] * 255), 255)
  // matches the ordinary marshaled path
  const out2 = exports.dec(new Uint8Array([0, 64, 128, 255]))
  is(out2[2], out[2])
})

// decodeThrown / jz:schema (watr downstream CI, 2026-08): a thrown Error's
// `.message` decodes through mem.read's generic OBJECT case, which indexes
// `mem.schemas[sid]` positionally (compile/index.js's jz:schema writer:
// "entry index === schema id"). The reader used to merge incoming entries
// into `mem.schemas` by CONTENT alone (`props.join(',')`) — sound for
// ordinary object schemas (content really does mean "same shape" there),
// unsound for the 7 built-in Error classes, which module/schema.js
// deliberately keeps as SEPARATE compile-time ids sharing the identical
// physical prop list ['message','name'] (distinguished only by a `salt`
// — the class name — folded into ctx.schema.register's dedup key, never
// serialized into the jz:schema bytes themselves). Registering 2+ of the
// 7 collapsed every one after the first into ONE runtime index, shifting
// every later sid's position — so the SECOND (and later) Error class
// registered in a program decoded its thrown `.message` as `undefined`
// (mem.schemas[sid] resolves to some OTHER, unrelated, usually zero-field
// schema). This is the live-schema sibling of the dead-schema collision
// compile/index.js's jz:schema writer already names and fixes (its
// `[String(id)]` placeholder covers only entries with no salt to lose).
// Root cause: interop.js's read-side dedup key didn't mirror
// ctx.schema.register's write-side key (which folds in `salt`) — fixed by
// reading jz:errcls first and computing the identical salted key while
// merging jz:schema.
//
// This exact shape was watr's own downstream CI failure ("case: error on
// unknown instruction: should throw", compile.js's `err()` — a SECOND
// built-in Error class had already been registered elsewhere in the
// program by the time this one threw, e.g. `err()`'s own — the corruption
// throws off every Error class after the first one used anywhere in the
// module, not just at this call site).
for (const optimize of levels(false, 2, 3)) {
  const lbl = `O${optimize || 0}`
  test(`interop: decodeThrown recovers .message for EVERY built-in Error class in one module, not just the first (${lbl})`, () => {
    const { exports } = interop.instantiate(compile(`
      export let f = (which) => {
        if (which === 0) throw new TypeError('type problem')
        if (which === 1) throw new RangeError('range problem')
        if (which === 2) throw new SyntaxError('syntax problem')
        throw Error('generic problem')
      }
    `, { optimize }))
    const expect = [
      ['TypeError', 'type problem'],
      ['RangeError', 'range problem'],
      ['SyntaxError', 'syntax problem'],
      ['Error', 'generic problem'],
    ]
    expect.forEach(([name, message], which) => {
      try {
        exports.f(which)
        ok(false, `${name}: should throw`)
      } catch (e) {
        is(e.constructor.name, name, `${name}: class`)
        is(e.message, message, `${name}: message survives (not the empty-schema collision)`)
      }
    })
  })
}

test('interop: allocTyped rejects an unsupported ctor', () => {
  const { memory } = interop.instantiate(compile('export let f = () => 1'))
  throws(() => memory.allocTyped(Array, 4))
})

// ── numeric export boundary ─────────────────────────────────────────────────
// A proven-numeric param is an f64 slot; every box-capable param takes the i64
// lane (jz:i64exp). The wrapper hands an f64 slot the host value untouched, so the
// WebAssembly JS-API's ToNumber at the call is the exact JS coercion.

test('interop: an f64 slot receives the host value raw — ToNumber semantics of the JS-API', () => {
  const { exports } = interop.instantiate(compile(`
    export let dbl = (x) => x * 2
    export let neg = (x) => -x
    export let dec = (x) => x - 1
    export let poly = (x) => x * x * 0.5 + 3`))
  is(exports.dbl(null), 0)
  ok(Number.isNaN(exports.dbl(undefined)))
  is(exports.dbl('8'), 16)
  is(exports.dbl(true), 2)
  is(exports.dbl([4]), 8)
  is(exports.dbl({ valueOf: () => 21 }), 42)
  ok(Number.isNaN(exports.dbl('abc')))
  is(Object.is(exports.neg(null), -0), true, '-null is -0 in JS')
  is(exports.dec(null), -1)
  is(exports.poly('8'), 35)
  is(exports.poly(), NaN)
  throws(() => exports.dbl(1n), TypeError, 'a plain BigInt into a numeric slot is a TypeError, as in JS')
})

test('interop: the `x = +x` guard on a numeric export is free', () => {
  // The guard used to route through __to_num on the raw bits and pull the whole
  // ToNumber string-parse runtime (~18 KB) into a 40-byte kernel. The unary plus on a
  // proven number is identity; the host already applied ToNumber at the f64 slot.
  const guarded = compile(`export let f = x => { x = +x; return x * x * 0.5 + 3 }`)
  const bare = compile(`export let f = x => x * x * 0.5 + 3`)
  ok(guarded.length <= bare.length + 8, `guarded ${guarded.length} B vs bare ${bare.length} B`)
  ok(!/__to_num/.test(compile(`export let f = x => { x = +x; return x * x * 0.5 + 3 }`, { wat: true })), 'no ToNumber runtime')
  const { exports } = interop.instantiate(guarded)
  is(exports.f('8'), 35)
  is(exports.f(null), 3)
  ok(Number.isNaN(exports.f(undefined)))
})

test('interop: a box-capable export param never rides the f64 lane', () => {
  // `Math.sumPrecise` takes an iterable, `x >= "9"` compares strings lexicographically:
  // neither is a numeric proof, so the param crosses as i64 and the wrapper boxes it.
  const lanes = (src) => {
    const s = WebAssembly.Module.customSections(interop.toModule(compile(src)), 'jz:i64exp')
    return s.length ? JSON.parse(new TextDecoder().decode(s[0])).find(e => e.name === 'f')?.p ?? [] : []
  }
  is(lanes(`export let f = (a) => Math.sumPrecise(a)`)[0], 0, 'sumPrecise arg is i64')
  is(lanes(`export let f = (x) => x >= "9"`)[0], 0, 'string-literal relational partner is i64')
  is(lanes(`export let f = (x) => x >= 9`).length, 0, 'numeric relational partner stays f64')
  is(lanes(`export let f = (x) => Math.sin(x)`).length, 0, 'Math.sin arg stays f64')
  const { exports } = interop.instantiate(compile(`export let f = (x) => x >= "9"`))
  is(exports.f(10), true)
  is(exports.f('10'), false)
})

// ── numeric array-like export parameters ────────────────────────────────────
// A parameter the body only indexes, measures, writes by element, forwards to
// a function that does the same, or returns, is a numeric array-like: the
// wrapper normalizes the host value to a Float64Array copy at entry and, when
// the body writes it, copies the storage back after the call. The body reads
// and writes typed storage directly: no receiver fork, no ToNumber runtime.

test('interop: a numeric array-like parameter is typed storage inside, any array-like outside', () => {
  const src = `function sum(w, t) { let s = 0; for (let i = 0; i < t.length; i++) s += w[i] * t[i]; return s }
    export let fit = (target) => { let w = new Float64Array(target.length); for (let i = 0; i < w.length; i++) w[i] = i; return sum(w, target) }
    export let first = (a) => a[1] * 10 + a.length`
  const bytes = compile(src)
  if (!belowOpt(2)) ok(bytes.length < 2000, `${bytes.length} bytes: no fork, no ToNumber runtime`)
  const lanes = JSON.parse(new TextDecoder().decode(WebAssembly.Module.customSections(interop.toModule(bytes), 'jz:i64exp')[0]))
  is(lanes.find(e => e.name === 'fit').t['0'], 'Float64Array')
  const { exports } = interop.instantiate(bytes)
  is(exports.fit([1, 2, 3]), 8)
  is(exports.fit(new Float64Array([1, 2, 3])), 8)
  is(exports.fit(new Float32Array([1, 2, 3])), 8)
  is(exports.fit(new Uint8Array([1, 2, 3])), 8)
  is(exports.first([5, 6, 7]), 63)
  throws(() => exports.fit(null), TypeError, 'null is not array-like, as JS would throw on null.length')
})

test('interop: a written array-like parameter copies its storage back to the host', () => {
  const src = `export let scale = (a, k) => { for (let i = 0; i < a.length; i++) a[i] *= k; return a }`
  const { exports, memory } = interop.instantiate(compile(src))
  const arr = [1, 2, 3], f64 = new Float64Array([1, 2, 3]), f32 = new Float32Array([1, 2, 3])
  const out = exports.scale(arr, 2)
  is(arr.join(), '2,4,6', 'a plain array is written back')
  is(out.join(), '2,4,6', 'the returned storage holds the result')
  exports.scale(f64, 3)
  is(f64.join(), '3,6,9')
  exports.scale(f32, 10)
  is(f32.join(), '10,20,30', 'another element kind is written back through set')
  const buf = memory.Float64Array([1, 2, 3])
  exports.scale(buf, 5)
  is(Array.from(memory.read(buf)).join(), '5,10,15', 'a jz buffer stays a live view')
})

test('interop: numeric output-only buffers use typed storage and copy back on repeated calls', () => {
  const src = `export let fill = (out, n) => { for (let i = 0; i < n; i++) out[i] = i * 0.5 + 1 }`
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const bytes = compile(src, { optimize })
    const lanes = JSON.parse(new TextDecoder().decode(WebAssembly.Module.customSections(interop.toModule(bytes), 'jz:i64exp')[0]))
    is(lanes.find(e => e.name === 'fill').t['0'], 'Float64Array+', 'numeric stores prove an output buffer without an element read')
    const wat = compile(src, { optimize, wat: true })
    ok(!/\(func \$__(?:arr_typed_obj_set_idx|to_str|dyn_set)\b/.test(wat), 'a proven output buffer links no object/key conversion runtime')
    const { exports } = interop.instantiate(bytes)
    const a = [9, 9, 9], b = new Float32Array([8, 8])
    exports.fill(a, 0)
    is(a.join(), '9,9,9', 'zero work preserves storage')
    exports.fill(a, 2)
    is(a.join(), '1,1.5,9', 'partial fill preserves the tail')
    exports.fill(a, 3)
    is(a.join(), '1,1.5,2', 'A to A fills the final element')
    exports.fill(b, 2)
    is(b.join(), '1,1.5', 'A to different B copies back to the new receiver')
    const empty = []
    exports.fill(empty, 0)
    is(empty.length, 0, 'empty output remains empty')
    throws(() => exports.fill(null, 1), TypeError)
  }
})

// The host array is the one the function mutated: a store past its end grows
// it, a length store shrinks it, and the function returns it, as in JS.
test('interop: a plain array written past its end comes back grown, and shrunk by a length store', () => {
  const src = `export function set(out, o, v) { out[o] = v; return out }
    export function trim(out, n) { out.length = n; return out }`
  for (const optimize of levels(0, 2, 3)) {
    const { exports } = interop.instantiate(compile(src, { optimize }))
    const a = [0, 0]
    is(exports.set(a, 5, 7), a, 'the argument comes back')
    is(a.length, 6, 'grown to hold the store')
    is(a[5], 7); is(a[0], 0); is(a[3], undefined, 'the gap is empty')
    is(exports.set(a, 1, 3), a); is(a.join(), '0,3,,,,7', 'an in-range store keeps the rest')
    is(exports.trim(a, 1), a); is(a.length, 1, 'a length store shrinks it'); is(a[0], 0)
    const empty = []
    exports.set(empty, 0, 1)
    is(empty.join(), '1', 'an empty array grows from nothing')
  }
})

test('interop: one numeric store cannot type an otherwise unknown output buffer', () => {
  const src = `export let mixed = (out, v) => { out[0] = 1; out[1] = v }
    export let copy = (out, src) => { for (let i = 0; i < 2; i++) out[i] = src[i] }
    export let unstable = (out, v) => { let x = 1; x = v; out[0] = x }
    export let boolean = (out, v) => { out[0] = v > 0 ? true : 1 }
    export let nullable = (out, v) => { out[0] = v > 0 ? null : 1 }`
  const bytes = compile(src)
  const lanes = JSON.parse(new TextDecoder().decode(WebAssembly.Module.customSections(interop.toModule(bytes), 'jz:i64exp')[0]))
  for (const name of ['mixed', 'copy', 'unstable', 'boolean', 'nullable'])
    is(lanes.find(e => e.name === name).t?.['0'], 'Array+', `${name}: unknown stored values retain the generic boundary`)
})

// The generic boundary copies a plain array in, so a body that may store into
// it hands the numbers back: the caller's array reads as JS leaves it.
test('interop: a plain array the body stores into takes its numbers back', () => {
  const src = `
    const put = (out) => { out[0] = 5; return out }
    export let add = (out, a, b) => { out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2]; return out }
    export let copy = (out, a) => { out[0] = a[0]; out[1] = a[1]; return 0 }
    export let viaHelper = (out) => { put(out); return 1 }
    export let nested = (ps, k) => { for (let i = 0; i < ps.length; i++) { const p = ps[i]; p[0] = p[0] + k; p[1] = p[1] + p[0] } return ps.length }
    export let partial = (out, a) => { out[1] = a[0] + a[1]; return 0 }
    export let special = (out, a) => { out[0] = a[0] + a[1]; out[1] = a[2] + a[2]; return 0 }
    export let reads = (a, b) => a[0] + b[1]`
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const bytes = compile(src, { optimize })
    const lanes = Object.fromEntries(JSON.parse(new TextDecoder().decode(WebAssembly.Module.customSections(interop.toModule(bytes), 'jz:i64exp')[0])).map(e => [e.name, e.t ?? null]))
    is(lanes.add['1'], undefined, 'an array the body only reads is not copied back')
    is(lanes.reads, null)
    const { exports } = interop.instantiate(bytes)
    const out = [0, 0, 0], a = [1, 2, 3], b = [4, 5, 6]
    is(exports.add(out, a, b), out, 'the returned argument is the caller\'s own array')
    is(out.join(), '5,7,9')
    is(a.join() + ';' + b.join(), '1,2,3;4,5,6', 'the operands are untouched')
    const two = [0, 0]
    exports.copy(two, [7, 8])
    is(two.join(), '7,8', 'a copied element')
    const h = [0, 0, 0]
    exports.viaHelper(h)
    is(h.join(), '5,0,0', 'a store made in a callee')
    const ps = [[1, 2], [3, 4]], first = ps[0]
    is(exports.nested(ps, 10), 2)
    is(JSON.stringify(ps), '[[11,13],[13,17]]', 'an array held by the array')
    is(ps[0], first, 'which stays the caller\'s own')
    const mixed = ['keep', 0, 'tail']
    exports.partial(mixed, [2, 3])
    is(mixed.join(), 'keep,5,tail', 'other elements stay the host\'s')
    const sp = [1, 1]
    exports.special(sp, [Infinity, -Infinity, -0])
    ok(sp[0] !== sp[0] && Object.is(sp[1], -0), 'NaN and negative zero cross as themselves')
    const typed = new Float64Array(2)
    exports.copy(typed, new Float64Array([2, 3]))
    is(typed.join(), '2,3', 'a typed host array takes its storage back')
  }
})

test('interop: numeric input contracts propagate to output buffers independently of parameter order', () => {
  const src = `export let map = (out, input, n) => {
    for (let i = 0; i < n; i++) out[i] = input[i] + input[i] * 0.5
  }`
  const bytes = compile(src)
  const lanes = JSON.parse(new TextDecoder().decode(WebAssembly.Module.customSections(interop.toModule(bytes), 'jz:i64exp')[0]))
  const entry = lanes.find(e => e.name === 'map')
  is(entry.t['0'], 'Float64Array+', 'output is typed after the input contract settles')
  is(entry.t['1'], 'Float64Array', 'input elements are numeric')
  const { exports } = interop.instantiate(bytes)
  const out = [7, 7, 7]
  exports.map(out, new Float32Array([2, 4, 6]), 0)
  is(out.join(), '7,7,7')
  exports.map(out, new Float32Array([2, 4, 6]), 3)
  is(out.join(), '3,6,9')
})

test('interop: typed views, typed methods and accumulators keep an array-like parameter typed', () => {
  const src = `export let head = (data, n) => { let h = data.subarray(0, n); let s = 0; for (let i = 0; i < h.length; i++) s += h[i]; return s }
    export let fillz = (data) => { data.fill(0); data[0] = 7; return data.length }
    export let copy = (dst, src) => { dst.set(src); return dst[1] * 2 }
    export let keyed = (o, k) => o[k]
    export let chars = (s) => { let buf = ''; for (let i = 0; i < s.length; i++) buf = buf + s[i]; return buf.length }`
  const bytes = compile(src)
  const lanes = Object.fromEntries(JSON.parse(new TextDecoder().decode(WebAssembly.Module.customSections(interop.toModule(bytes), 'jz:i64exp')[0])).map(e => [e.name, e.t ?? null]))
  is(lanes.head['0'], 'Float64Array', 'a subarray view of the parameter is the same storage')
  is(lanes.fillz['0'], 'Float64Array+', 'fill writes, so the storage copies back')
  is(lanes.copy['0'], 'Float64Array+')
  is(lanes.keyed, null, 'an unproven key is the dictionary idiom')
  is(lanes.chars, null, 'a string indexed into a concat stays a string')
  const { exports } = interop.instantiate(bytes)
  is(exports.head(new Float32Array([1, 2, 3, 4]), 3), 6)
  is(exports.head([1, 2, 3, 4], 2), 3)
  const z = [5, 6, 7]
  is(exports.fillz(z), 3)
  is(z.join(), '7,0,0')
  const dst = new Float64Array(3)
  is(exports.copy(dst, [4, 5, 6]), 10)
  is(dst.join(), '4,5,6')
  is(exports.chars('banana'), 6)
})

// Two classes of one field list are two schemas: the compiler brands each
// (module/schema.js), and the `jz:brand` section carries the brand, so
// interop keeps their sids and field contracts apart within a module and
// across the modules sharing one memory. A plain object matches a plain shape
// first; among classes alone it is ambiguous.
test('interop: classes of one field list keep their identity through the sections', () => {
  if (onWasi() || onKernel()) return
  const one = jz(`class A { constructor(x) { this.x = x } }\nclass B { constructor(x) { this.x = x } }
export let a = () => new A(1), b = () => new B('s'), ra = (o) => o.x, rb = (o) => o.x, plain = () => ({ x: 2 })`)
  is(one.exports.ra(one.exports.a()), 1); is(one.exports.rb(one.exports.b()), 's')
  is(one.memory.schemas.filter(s => s.join() === 'x').length, 3, 'two branded shapes and the plain one')
  is(one.exports.ra(one.exports.plain()), 2)
  // another module's class C would bind at a fourth id while its pointers carry id 0: rejected
  throws(() => jz(`class C { constructor(x) { this.x = x } }\nexport let c = () => new C(true), rc = (o) => o.x`, { memory: one.memory }), /schema 0 \{x\} of this module binds as schema 3/)
})

test('interop: modules sharing a memory bind their schemas at the same ids or are rejected', () => {
  if (onWasi() || onKernel()) return
  const src = `export let mk = () => ({ p: 1, q: 'a' }), rp = (o) => o.p, rq = (o) => o.q`
  const one = jz(src)
  // a module of other names, slot orders and representations: its schema 0 would bind as schema 1
  throws(() => jz(`export let mk = () => ({ s: true, r: 2 }), rs = (o) => o.s`, { memory: one.memory }), /schema 0 \{[rs], [rs]\} of this module binds as schema 1/)
  // the same module again binds at the same ids: the instances' exports alternate
  const two = jz(src, { memory: one.memory })
  is(two.exports.rp(one.exports.mk()), 1); is(one.exports.rq(two.exports.mk()), 'a')
  is(JSON.stringify(two.memory.read(one.exports.mk())), '{"p":1,"q":"a"}')
  is(JSON.stringify(one.memory.read(two.exports.mk())), '{"p":1,"q":"a"}')
  // a module without schemas shares any memory
  const plain = jz('export let inc = (x) => x + 1', { memory: one.memory })
  is(plain.exports.inc(one.exports.rp(one.exports.mk())), 2)
})

// The rejection comes before the module links: instantiated first, its start
// function would have copied its static data into the shared heap and run its
// module scope, and its tables would have been half committed (the Error
// classes first, then the schemas up to the one that binds elsewhere).
test('interop: a rejected module leaves the memory it would share untouched', () => {
  if (onWasi() || onKernel()) return
  const memory = jz.memory()
  const one = jz(`export let mk = () => ({ p: 1, q: 'a longer static string' }), rq = (o) => o.q`, { memory })
  const o = one.exports.mk()
  const tables = () => JSON.stringify([memory.schemas, [...memory._schemaKeyToId], [...memory.errorSidToClass], [...memory.brandOfSid], memory.fieldContracts])
  const heap = () => new DataView(memory.buffer).getUint32(HEAP.PTR_ADDR, true)
  const before = tables(), ptr = heap()
  // static data, module-scope allocation, Error classes and another shape: its schema 0 would bind as schema 1
  throws(() => jz(`let cache = ['static text of another module', 'more static text']
    export let mk = () => ({ s: true, r: cache[0] }), fail = (w) => { if (w) throw new RangeError('out'); throw new TypeError('bad') }`, { memory }),
    /schema 0 \{[^}]*\} of this module binds as schema 1/)
  is(tables(), before, 'the tables did not change')
  is(heap(), ptr, 'nothing was allocated')
  is(one.exports.rq(o), 'a longer static string')
  is(JSON.stringify(memory.read(o)), '{"p":1,"q":"a longer static string"}')
})

test('interop: numeric host imports preserve zero, NaN, infinities and hidden constants', () => {
  for (const head of ["import { value } from 'env'", "import { named as value } from 'env'", "import value from 'env'"]) {
    const source = `${head}; export let f = () => value`
    for (const value of [0, -0, NaN, Infinity, -Infinity, 7, 7, 0]) {
      const env = Object.defineProperties({}, {value: {value}, named: {value}, default: {value}})
      const f = jz(source, {imports: {env}}).exports.f
      is(Object.is(f(), value), true, `constant ${String(value)}`)
      is(Object.is(f(), value), true, 'repeated call')
    }
    throws(() => jz(source, {imports: {env: {}}}), /not declared/, 'missing remains an error')
  }
  is(jz('export let f = () => 7', {imports: {}}).exports.f(), 7, 'empty imports after numeric modules')
})

// The box codec moves bits through one 8-byte cell: every tag, aux and offset
// comes back as built, a number's bits survive both ways, and a BigInt takes
// its value mod 2^64 (a negative one sign-extended, as the i64 lane carries it).
test('interop: the NaN-box codec keeps every bit', () => {
  const { ptr, type, aux, offset, f64ToI64, i64ToF64 } = interop
  for (const [t, a, o] of [[0, 0, 0], [3, 7, 16], [15, 0x7fff, 0xffffffff], [6, 0x4000, 0x80000000], [1, 1, 1]]) {
    const p = ptr(t, a, o)
    is([type(p), aux(p), offset(p)], [t, a, o], `ptr(${t}, ${a}, ${o})`)
    ok(p >= 0n && p < 2n ** 64n, 'an unsigned 64-bit value')
  }
  for (const n of [0, -0, 1.5, -2.25, 1e308, 5e-324, Infinity, -Infinity, Math.PI]) ok(Object.is(i64ToF64(f64ToI64(n)), n), `${n} round trips`)
  is(f64ToI64(1), 0x3ff0000000000000n)
  is([offset(-5n), type(-5n), aux(-5n)], [2 ** 32 - 5, 15, 0x7fff], 'a negative BigInt reads as its two\'s complement bits')
})

test('interop: Symbols retain identity through arguments, results, containers and resets', () => {
  if(onKernel())return // Requires the candidate host ABI metadata and runtime counter.
  const key='jz:registry:\uD800',other='jz:registry:other'
  const source=`const shared=Symbol.for(${JSON.stringify(key)}),other=Symbol.for(${JSON.stringify(other)})
    let held=Symbol('initial')
    export function fresh(){return Symbol('fresh')}
    export function registry(){return [shared,other]}
    export function exchange(v){const prior=held;held=v;return prior}
    export function same(a,b){return a===b}
    export function nested(v){return {value:v,array:[v,v],map:new Map([[v,v]]),set:new Set([v,v])}}
    export function property(v){const out={};out[v]=7;return out}
    export function fail(v){throw v}`
  for(const optimize of levels(0,1,2,3,'size')){
    const bytes=compile(source,{optimize}),a=interop.instantiate(bytes),b=interop.instantiate(bytes)
    const f=a.exports,first=f.fresh(),second=f.fresh(),foreign=b.exports.fresh()
    is(typeof first,'symbol',`O${optimize} decoded Symbol`)
    ok(first!==second && first!==foreign,'factories and independent instances retain distinct identities')
    is(f.registry(),[Symbol.for(key),Symbol.for(other)],'registry keys retain exact strings, including lone surrogates')
    is(b.exports.registry(),f.registry(),'the host registry is shared across instances')
    const prior=f.exchange(first)
    is(typeof prior,'symbol','module initializer Symbol decodes')
    const host=Symbol('host'),otherHost=Symbol('host'),retained=[]
    // Each observation uses identity, not descriptions or stringification.
    let expected=first
    for(const value of [host,host,otherHost,Symbol.for(key),foreign,first,host]){
      is(f.exchange(value),expected,'the previous identity survives the next call')
      expected=value
      const out=f.nested(value)
      is(out.value,value,'object value')
      is(out.array,[value,value],'array values')
      is([...out.map],[[value,value]],'Map key and value')
      is([...out.set],[value],'Set identity')
      const keyed=f.property(value)
      is(Reflect.ownKeys(keyed),[value],'returned property keys decode as the same Symbol')
      is(keyed[value],7)
      ok(!f.same(value,f.fresh()),'host and Wasm allocation share one counter')
      retained.push([out,value])
    }
    let error
    try{f.fail(host)}catch(e){error=e}
    is(error?.thrown,host,'thrown Symbol retains the existing thrown-value transport')
    is(f.exchange(first),host,'error recovery leaves the instance reusable')
    a.memory.reset()
    is(f.exchange(host),prior,'heap reset restores the original module Symbol')
    ok(![first,second,foreign,host,otherHost].includes(f.fresh()),'heap reset never reissues a held identity')
    for(const [out,value] of retained){is(out.value,value);is(out.array[0],value);is([...out.map.keys()][0],value)}
  }
})

test('interop: Symbol property keys marshal through explicit dictionaries and host objects', () => {
  if(onKernel())return
  const mem=interop.memory(),a=Symbol('same'),b=Symbol('same'),registry=Symbol.for('jz:key')
  for(const value of [{},{[a]:7,[b]:9,[registry]:11,a:13},{[b]:undefined},{}]){
    const out=mem.read(mem.Hash(value))
    is(Reflect.ownKeys(out),Reflect.ownKeys(value),'own string and Symbol keys retain order')
    for(const key of Reflect.ownKeys(value))is(out[key],value[key],'key identity and value survive')
  }
  const effects={get first(){delete this[b];return 1},[a]:undefined,[b]:9}
  Object.defineProperty(effects,registry,{value:11,enumerable:false})
  const changed=mem.read(mem.Hash(effects))
  is(Reflect.ownKeys(changed),['first',a],'earlier getters affect later Symbol presence; hidden keys stay hidden')
  is(changed[a],undefined,'present undefined retains its Symbol key')
  is(mem.read(mem.Hash('ab')),{'0':'a','1':'b'},'primitive string boxing is preserved')
  throws(()=>mem.Hash(null),TypeError)
  if(onWasi())return // External object imports belong to the JS host.
  const src=`import {get} from 'host';export function f(key){const o=get();return [o[key],key in o,delete o[key],key in o]}
    export function value(){return get().token}`
  for(const optimize of levels(0,1,2,3,'size')){
    const object={},bytes=compile(src,{optimize,imports:{host:{get:{params:0}}}})
    const {exports}=interop.instantiate(bytes,{imports:{host:{get:()=>object}}})
    for(const key of [a,a,b,registry,a]){
      object[key]=17;object.token=key
      is(exports.value(),key,'a host property Symbol enters through the same codec')
      is(exports.f(key),[17,true,true,false],`O${optimize} external Symbol key`)
      is(Object.hasOwn(object,key),false,'delete affected the exact host key')
    }
  }
})


test('interop: memoryless Symbol codecs retain identity and reject numeric field carriers', () => {
  if(onKernel())return
  const source=String.raw`(module
    (global $id (export "__symbol_id") (mut i64) (i64.const 0x7ff8001000000000))
    (func (export "fresh") (result i64)
      (global.set $id (i64.add (global.get $id) (i64.const 1))) (global.get $id))
    (func (export "echo") (param i64) (result i64) (local.get 0))
    (func (export "registry") (result i64) (i64.const 0x7ff8001000000000))
    (@custom "jz:symbols" "[[\"jz:memoryless\",16]]")
    (@custom "jz:i64exp" "[{\"name\":\"fresh\",\"r\":true},{\"name\":\"echo\",\"p\":[0],\"r\":true},{\"name\":\"registry\",\"r\":true}]"))`
  const a=interop.instantiate(wasm(source)),b=interop.instantiate(wasm(source)),f=a.exports
  is(a.memory,null,'fixture has no linear memory')
  const first=f.fresh(),foreign=b.exports.fresh(),host=Symbol('host')
  is(typeof first,'symbol');ok(first!==foreign,'memoryless instances keep separate identities')
  for(const value of [first,first,host,foreign,Symbol.for('jz:memoryless'),first])
    is(f.echo(value),value,'memoryless ingress and egress share their identity table')
  is(f.registry(),Symbol.for('jz:memoryless'))
  const raw=a.instance.exports.fresh(),reader=interop.memory(a),held=reader.read(raw)
  is(interop.memory(a).read(raw),held,'rebuilding a memoryless adapter reuses its codec')
  is(interop.wrap(a).echo(first),first,'another export wrapper shares identity')
  ok(f.fresh()!==host,'host ingress advances the runtime counter')
  a.instance.exports.__symbol_id.value=0x7ff87ffffffffffen
  for(let i=0;i<2;i++)throws(()=>f.echo(Symbol()),RangeError,'host identity exhaustion never wraps')
  is(f.echo(first),first,'known identities remain usable after allocation errors')
  for(const optimize of levels(0,1,2,3,'size')){
    const numeric=interop.instantiate(compile('export function f(){return {value:1}}',{optimize})).memory
    throws(()=>numeric.Object({value:host}),TypeError,'a Symbol cannot enter a proved numeric field')
    const generic=interop.instantiate(compile('export function f(v){return {value:v}}',{optimize})).memory
    is(generic.read(generic.Object({value:host})).value,host,'an unknown field admits Symbol identity')
  }
})
