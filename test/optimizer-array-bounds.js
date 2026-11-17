// The length proofs of array reads that calls, aliases, conversions, captures,
// getters and rebinding must invalidate.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { onKernel, levels } from './_matrix.js'
import { funcWat, run, oracle, compile } from './util.js'

test('array bounds: aliases, calls, coercions and later initializers cannot keep a stale length proof', () => {
  const cases = {
    alias: `const b = a; for (let i=0;i<a.length;i++) { b.length=0; reads++; return a[i].x }`,
    computed: `const b = a, key = flag ? 'length' : 'other'; for (let i=0;i<a.length;i++) { b[key]=0; reads++; return a[i].x }`,
    called: `const cut = () => { a.length=0 }; for (let i=0;i<a.length;i++) { cut(); reads++; return a[i].x }`,
    transitive: `function cut(xs){xs.length=0} function relay(xs){cut(xs)} for(let i=0;i<a.length;i++){relay(a);reads++;return a[i].x}`,
    defaultCall: `function cut(xs, x=(xs.length=0)){} for(let i=0;i<a.length;i++){cut(a);reads++;return a[i].x}`,
    rebound: `let b=a; function cut(){b=[]} for(let i=0;i<b.length;i++){cut();reads++;return b[i].x}`,
    capturedCounter: `for(let i=0;i<a.length;i++){function cut(){i=7} cut();reads++;return a[i].x}`,
    recursive: `function cut(xs,n){if(n)cut(xs,n-1);else xs.length=0} for(let i=0;i<a.length;i++){cut(a,2);reads++;return a[i].x}`,
    callback: `function cut(fn){fn()} for(let i=0;i<a.length;i++){cut(()=>{a.length=0});reads++;return a[i].x}`,
    method: `for (let i=0;i<a.length;i++) { a.pop(); reads++; return a[i].x }`,
    accessor: `const o = {get value(){a.length=0;return 0}}; for (let i=0;i<a.length;i++) { reads+=o.value+1; return a[i].x }`,
    conversion: `const o = {valueOf(){a.length=0;return 0}}; for (let i=0;i<a.length;i++) { reads+=+o+1; return a[i].x }`,
    mathConversion: `const o = {valueOf(){a.length=0;return 1}}; for (let i=0;i<a.length;i++) { reads+=Math.imul(o,1); return a[i].x }`,
    mathAccessor: `const o = {get value(){a.length=0;return 1}}; for (let i=0;i<a.length;i++) { reads+=Math.imul(o.value,1); return a[i].x }`,
    hoisted: `for (let i=0,len=a.length,cut=(a.length=0);i<len;i++) { reads++; return a[i].x }`,
    counter: `for (let i=0,cut=(i=-1);i<a.length;i++) { reads++; return a[i].x }`,
    charCounter: `const s='x'; for (let i=0,cut=(i=-1);i<s.length;i++) return s.charCodeAt(i)`,
  }
  for (const [name, body] of Object.entries(cases)) {
    const src = `export function f(flag) {
      const a=[]; if(flag) a.push({x:3}); let reads=0
      try { ${body}; return 'none:'+reads }
      catch(e) { return e.name+':'+reads }
    }`
    const expected=oracle(src)
    for (const optimize of levels(0,1,2,3,'size')) {
      const actual=run(src,{optimize:{level:optimize,sourceInline:false}})
      for (const flag of [0,1,1,0,1]) is(actual.f(flag),expected.f(flag),`${name}, O${optimize}, flag=${flag}`)
    }
  }
})

// A module array a function's loop reads under its own length is truncated by a
// conversion the loop runs (`+o` with `o.valueOf` holding the array), or by a
// call that rebinds it: neither leaves a present read behind.
test('array bounds: a module array keeps no stale length proof across conversions and rebinding calls', () => {
  const cases = {
    conversion: `let arr = []; const o = { valueOf() { arr.length = 0; return 0 } }
      export function f(flag) { arr = []; if (flag) arr.push({x:3}); let reads = 0
        try { for (let i = 0; i < arr.length; i++) { reads += +o + 1; return arr[i].x }; return 'none:' + reads } catch (e) { return e.name + ':' + reads } }`,
    rebound: `let arr = []; function cut() { arr = [] }
      export function f(flag) { arr = []; if (flag) arr.push({x:3}); let reads = 0
        try { for (let i = 0; i < arr.length; i++) { cut(); reads++; return arr[i].x }; return 'none:' + reads } catch (e) { return e.name + ':' + reads } }`,
  }
  for (const [name, src] of Object.entries(cases)) {
    const expected = oracle(src)
    for (const optimize of levels(0, 1, 2, 3, 'size')) {
      const actual = run(src, { optimize: { level: optimize, sourceInline: false } })
      for (const flag of [0, 1, 1, 0, 1]) is(actual.f(flag), expected.f(flag), `${name}, O${optimize}, flag=${flag}`)
    }
  }
})

// A local array a closure captures is truncated by the call that runs it: by a
// store to its length, by a method of its own (`splice`), or through another name
// (`cut(h.a)`).
test('array bounds: a captured array keeps no stale length proof across calls and getter reads', () => {
  const loops = {
    closureLen: 'function cut() { a.length = 0 } for (let i = 0; i < a.length; i++) { cut(); reads++; return a[i].x }',
    closureSplice: 'function cut() { a.splice(0) } for (let i = 0; i < a.length; i++) { cut(); reads++; return a[i].x }',
    passedLen: 'function cut(z) { z.length = 0 } const h = { a }; for (let i = 0; i < a.length; i++) { cut(h.a); reads++; return a[i].x }',
    accessor: 'const o = { get value() { a.length = 0; return 0 } }; for (let i = 0; i < a.length; i++) { reads += o.value + 1; return a[i].x }',
    mathAccessor: 'const o = { get value() { a.length = 0; return 1 } }; for (let i = 0; i < a.length; i++) { reads += Math.imul(o.value, 1); return a[i].x }',
  }
  for (const [name, loop] of Object.entries(loops)) {
    const src = `export function f(flag) { const a = []; if (flag) a.push({x:3}); let reads = 0; try { ${loop}; return 'none:' + reads } catch (e) { return e.name + ':' + reads } }`
    const expected = oracle(src)
    for (const optimize of levels(0, 1, 2, 3, 'size')) {
      const actual = run(src, { optimize: { level: optimize, sourceInline: false } })
      for (const flag of [0, 1, 1, 0, 1]) is(actual.f(flag), expected.f(flag), `${name}, O${optimize}, flag=${flag}`)
    }
  }
})

test('array bounds: resolved callees may write fields and typed storage without changing extents', () => {
  const src = `class Node {
      constructor(){this.buf=new Float64Array(1);this.count=0}
      write(x){this.buf[0]=x;this.count++;return this.buf[0]}
    }
    function visit(node,x){return node.write(x)}
    function sweep(nodes){let sum=0;for(let i=0;i<nodes.length;i++){
      sum+=visit(nodes[i],i)+nodes[i].count
    }return sum}
    export function f(n){const nodes=[];for(let i=0;i<n;i++)nodes.push(new Node());return sweep(nodes)}`
  for (const source of [src, src.replace('i<nodes.length', 'i<len').replace('let i=0;', 'let i=0,len=nodes.length;')]) {
    const want=oracle(source).f
    for(const level of levels(0,1,2,3,'size')){
      const f=run(source,{optimize:{level,sourceInline:false}}).f
      for(const n of [0,1,1,5,0,3])is(f(n),want(n),`O${level}: ${n} nodes`)
    }
    if(onKernel())continue
    const body=funcWat(compile(source,{wat:true,optimize:{level:2,sourceInline:false,watr:false}}),'sweep')
    ok(body.includes('call $visit'), 'the proof crosses an actual call boundary')
    ok(!body.includes('i32.lt_u') && !body.includes('call $__typed_idx'), 'callee writes retain direct in-bounds array reads')
  }
})
