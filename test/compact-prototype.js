import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import compileCompact, { compileCompactAst } from '../prototype/compact/compiler.js'

const instantiate = (source) => new WebAssembly.Instance(new WebAssembly.Module(compileCompact(source))).exports
const sameNumber = (a, b) => Object.is(a, b) || Number.isNaN(a) && Number.isNaN(b)
const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i])

test('compact prototype: smallest module and ULEB count boundary', () => {
  const smallest = compileCompact('export let f=()=>0')
  is(smallest.length, 41)
  is(new WebAssembly.Instance(new WebAssembly.Module(smallest)).exports.f(), 0)

  const folded = compileCompact('export let f=()=>1+2*3')
  is(folded.length, 41)
  is(new WebAssembly.Instance(new WebAssembly.Module(folded)).exports.f(), 7)

  const pair = instantiate('export let a=()=>1;export let b=()=>2')
  is(pair.a(), 1)
  is(pair.b(), 2)

  for (const count of [127, 128]) {
    const params = Array.from({ length: count }, (_, i) => `p${i}`)
    const source = `export let f=(${params})=>{${params.map(p => `${p}=+${p}`).join(';')};return ${params[count - 1]}}`
    const f = instantiate(source).f
    is(f(...params.map((_, i) => i)), count - 1)
  }
})

test('compact prototype: explicit ToNumber boundary', () => {
  const { f } = instantiate('export let f=x=>{x=+x;return x}')
  is(f('4'), 4)
  is(f(null), 0)
  is(f(true), 1)
  ok(Number.isNaN(f()), 'a missing argument converts like undefined')
  ok(Object.is(f(-0), -0), 'signed zero is preserved')

  let calls = 0
  is(f({ valueOf() { calls++; return 4 } }), 4)
  is(calls, 1)

  const add = instantiate('export let f=(x,y)=>{x=+x;y=+y;return x+y}').f
  const order = []
  is(add(
    { valueOf() { order.push('x'); return 2 } },
    { valueOf() { order.push('y'); return 3 } },
  ), 5)
  is(order.join(','), 'x,y')

  throws(() => f(1n), error => error instanceof TypeError)
  throws(() => f(Symbol()), error => error instanceof TypeError)
})

test('compact prototype: direct calls and arithmetic updates', () => {
  const declared = instantiate('function zero(){return 0} export let f=()=>zero()')
  is(declared.f(), 0)

  const direct = instantiate('let mul=(x,y)=>x*y;export let f=(x,y)=>{x=+x;y=+y;return mul(x,y)+1}')
  is(direct.f(3, 4), 13)

  const updated = instantiate('export let f=x=>{x=+x;let y=x;y+=2;y*=3;y-=1;y/=2;return y}')
  is(updated.f(4), 8.5)
})

test('compact prototype: conditionals and zero-iteration loops', () => {
  const abs = instantiate('export let f=x=>{x=+x;if((x>0))return x;else return -x}').f
  is(abs(-9), 9)

  const truthy = instantiate('export let f=x=>{x=+x;if(x)return 1;else return 2}').f
  is(truthy(NaN), 2)
  is(truthy(-0), 2)
  is(truthy(-3), 1)
  is(truthy(Infinity), 1)

  const negated = instantiate('export let f=x=>{x=+x;if(!x)return 1;else return 2}').f
  is(negated(NaN), 1)
  is(negated(3), 2)

  const choose = instantiate('export let f=x=>{x=+x;return x?x:7}').f
  is(choose(NaN), 7)
  is(choose(-2), -2)

  const sumFor = instantiate('export let f=n=>{n=+n;let s=0;for(let i=0;i<n;i++)s+=i;return s}').f
  const sumWhile = instantiate('export let f=n=>{n=+n;let s=0;let i=0;while(i<n){s+=i;i++}return s}').f
  for (const [input, expected] of [[0, 0], [1, 0], [100, 4950]]) {
    is(sumFor(input), expected)
    is(sumWhile(input), expected)
  }
})

test('compact prototype: compiler reuse A to A to B', () => {
  const sourceA = 'export let f=x=>{x=+x;return x+1}'
  const sourceB = 'export let f=x=>{x=+x;return x*x}'
  const firstA = compileCompact(sourceA)
  const secondA = compileCompact(sourceA)
  const b = compileCompact(sourceB)
  ok(sameBytes(firstA, secondA), 'A to A is byte-identical')
  is(new WebAssembly.Instance(new WebAssembly.Module(firstA)).exports.f(4), 5)
  is(new WebAssembly.Instance(new WebAssembly.Module(secondA)).exports.f(4), 5)
  is(new WebAssembly.Instance(new WebAssembly.Module(b)).exports.f(4), 16)
})

test('compact prototype: numeric expression differential', () => {
  let seed = 0x12345678
  const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)
  const expression = (depth) => {
    if (!depth) return rand() & 1 ? 'x' : String((rand() % 19) - 9)
    const op = ['+', '-', '*', '/'][rand() & 3]
    return `(${expression(depth - 1)} ${op} ${expression(depth - 1)})`
  }
  const inputs = [-3, -0, 0, 0.5, 7, NaN, Infinity]
  let mismatch = ''
  outer: for (let i = 0; i < 32; i++) {
    const expr = expression(3)
    const wasm = instantiate(`export let f=x=>{x=+x;return ${expr}}`).f
    const js = new Function('x', `x=+x;return ${expr}`)
    for (const input of inputs) if (!sameNumber(wasm(input), js(input))) {
      mismatch = `${expr} at ${input}`
      break outer
    }
  }
  ok(!mismatch, mismatch || '32 expressions match JavaScript at seven numeric boundaries')
})

test('compact prototype: lexical hazards reject', () => {
  is(instantiate('export let f=()=>{const x=1;return x}').f(), 1)
  throws(() => compileCompact('export let f=()=>{const x=1;x=2;return x}'), /const local/)
  throws(() => compileCompact('export let f=()=>{const x=1;x+=2;return x}'), /const local/)
  throws(() => compileCompact('export let f=()=>{const x=1;x++;return x}'), /const local/)
  throws(() => compileCompact('let g=()=>1;export let f=()=>{let g=2;return g()}'), /dynamic call through local/)
  throws(() => compileCompact('export let f=()=>{let y=x;let x=1;return y}'), /before its declaration/)
  throws(() => compileCompact('export let f=()=>{{let x=1}return x}'), /before its declaration/)
})

test('compact prototype: empty and unsupported programs reject', () => {
  throws(() => compileCompact(''), /module has no functions/)
  throws(() => compileCompactAst(null), /module has no functions/)
  throws(() => compileCompact('let f=()=>0'), /no exported function/)
  throws(() => compileCompact('export let f=x=>x+1'), /must normalize/)
  throws(() => compileCompact('export let f=()=>"1"'), /unsupported/)
  throws(() => compileCompact('export let f=x=>{x=+x;return Math.sin(x)}'), /unsupported/)
  throws(() => compileCompact('export let f=()=>{}'), /does not return/)
  throws(() => compileCompact('export let f=()=>missing()'), /unknown direct function/)
  throws(() => compileCompact('let g=x=>x;export let f=()=>g()'), /has 0 arguments, expected 1/)
  throws(() => compileCompact('export function f(){return 0}'), /constructable/)
  throws(() => compileCompact('export let π=()=>0'), /non-ASCII export name/)
})
