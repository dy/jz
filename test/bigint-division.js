import test from 'tst'
import {is} from 'tst/assert.js'
import jz, {compile} from '../index.js'

const levels = [false, 1, 2, 3]
const oracle = source => Function(source.replaceAll('export ', '') + ';return {f,state}')()
const observe = (f, args, wasm) => {
  try { return ['return', f(...args)] }
  catch (e) { return ['throw', wasm && e?.name === 'Error' && Object.hasOwn(e, 'thrown') ? e.thrown : e?.name ?? e] }
}
const wrapped = result => result[0] === 'return' && typeof result[1] === 'bigint'
  ? ['return', BigInt.asIntN(64, result[1])] : result

for (const op of ['/', '%']) for (const consumer of ['VALUE', 'typeof VALUE',
  'typeof VALUE === "bigint"', '(VALUE,9)'])
test(`BigInt ${op}: ${consumer} preserves zero errors, operand order and recovery`, () => {
  const value = `(left(a,stage) ${op} right(b,stage))`
  const source = `let trace=0
    function left(n,stage){trace=trace*10+1;if(stage===1)throw 1;return BigInt(n)}
    function right(n,stage){trace=trace*10+2;if(stage===2)throw 2;return BigInt(n)}
    export function f(a,b,stage){trace=0;const v=${consumer.replace('VALUE',value)};trace=trace*10+3;return v}
    export const state=()=>trace`
  for (const optimize of levels) {
    const expected = oracle(source), actual = jz(source,{optimize}).exports
    for (const args of [['6','2',0], ['6','0',0], ['0','0',0], ['-7','2',0],
      ['-9223372036854775808','-1',0], ['6','0',1], ['6','0',2],
      ['bad','0',0], ['6','bad',0], ['6','2',0]]) {
      is(observe(actual.f,args,true), wrapped(observe(expected.f,args,false)), `O${optimize || 0}: ${args}`)
      is(actual.state(),expected.state(),'left → right → operation → continuation, exactly once')
    }
  }
})

for (const op of ['/', '%']) test(`BigInt ${op}=: failed writes preserve RHS state, not the arithmetic result`, () => {
  const source = `let value=6n,trace=0
    function rhs(input,stage){trace=trace*10+2;value=99n;if(stage===2)throw 2;return BigInt(input)}
    export function f(input,stage){value=6n;trace=1;const result=(value ${op}= rhs(input,stage));trace=trace*10+3;return result}
    export const state=()=>[String(value),trace]`
  for (const optimize of levels) {
    const expected = oracle(source), actual = jz(source,{optimize}).exports
    for (const args of [['2',0], ['0',0], ['0',2], ['bad',0], ['2',0]]) {
      is(observe(actual.f,args,true), observe(expected.f,args,false), `O${optimize || 0}: ${args}`)
      is(actual.state(),expected.state(),'RHS writes 99; zero failure must not overwrite it')
    }
  }
})

for (const op of ['/', '%']) test(`BigInt ${op}=: signed-i64 overflow boundary in local storage`, () => {
  for (const target of ['value', '((value))']) {
    const source = `export function f(a,b){let value=BigInt(a);${target} ${op}= BigInt(b);return value}
      export const state=()=>0`
    for (const optimize of levels) {
      const expected=oracle(source),actual=jz(source,{optimize}).exports
      for (const args of [['-9223372036854775808','-1'], ['-9223372036854775808','1'],
        ['9223372036854775807','-1'], ['0','-1'], ['6','0'], ['6','2']])
        is(observe(actual.f,args,true),wrapped(observe(expected.f,args,false)), `${target} O${optimize || 0}: ${args}`)
    }
  }
})

for (const op of ['/', '%']) test(`BigInt ${op}: call-free catch and finally remain reachable`, () => {
  for (const expression of [`6n ${op} (zero?0n:2n)`, `value ${op}= (zero?0n:2n)`]) {
    const source = `let trace=0
      export function f(zero){trace=0;let value=6n
        try { ${expression};trace=1;return 'ok' }
        catch(e){trace=2;return e.name}
        finally{trace=trace*10+3}}
      export const state=()=>trace`
    for (const optimize of levels) {
      const expected = oracle(source), actual = jz(source,{optimize}).exports
      for (const args of [[false],[true],[false]]) {
        is(observe(actual.f,args,true),observe(expected.f,args,false), `${expression} O${optimize || 0}: ${args}`)
        is(actual.state(),expected.state(),'finally runs after both normal and caught completion')
      }
    }
  }
})

for (const op of ['/', '%']) test(`BigInt ${op}: zero errors are branded, not reserved user numbers`, () => {
  for (const handler of ['', 'catch(e){throw e}', 'finally{trace=trace*10+3}']) {
    const body = `trace=1;if(which)throw 214;trace=12;return 6n ${op} BigInt(input)`
    const source = `let trace=0
      export function f(which,input){${handler ? `try{${body}}${handler}` : body}}
      export const state=()=>trace`
    for (const optimize of levels) {
      const expected=oracle(source),actual=jz(source,{optimize}).exports
      for (const args of [[false,'2'],[false,'0'],[true,'0'],[false,'0'],[true,'2'],[false,'2']]) {
        is(observe(actual.f,args,true),observe(expected.f,args,false), `${handler} O${optimize || 0}: ${args}`)
        is(actual.state(),expected.state(),'observe each error before the next call')
      }
    }
  }
  const source=`export function f(input){try{6n ${op} BigInt(input)}catch(e){return e instanceof RangeError}return false}`
  for (const optimize of levels) {
    const {f}=jz(source,{optimize}).exports
    is([f('2'),f('0'),f('2')],[false,true,false],'catch receives a real RangeError')
  }
})

for (const op of ['/', '%']) test(`BigInt ${op}: implicit error census precedes consumers and ignores constructor shadowing`, () => {
  for (const shadow of ['', 'function RangeError(){throw 3}']) {
    const source=`${shadow}
      function describe(e){return e.name+': '+e.message}
      export function f(input){try{divide(input);return 'ok'}catch(e){return describe(e)}}
      function divide(input){return 6n ${op} BigInt(input)}`
    for (const optimize of levels) {
      const {f}=jz(source,{optimize}).exports
      is([f('2'),f('0'),f('2')],['ok','RangeError: Division by zero','ok'])
    }
  }
  const source=`function classify(e){return e instanceof Error && e instanceof RangeError && !(e instanceof TypeError)}
    export function f(input){try{divide(input)}catch(e){return classify(e)}return false}
    function divide(input){return 6n ${op} BigInt(input)}`
  for (const optimize of levels) {
    const {f}=jz(source,{optimize}).exports
    is([f('2'),f('0'),f('2')],[false,true,false])
  }
})

test('BigInt division and remainder: constant nonzero divisors demand no error runtime', () => {
  // The export's BigInt result crosses boxed (its result contract), so the
  // module owns memory for the cell; the error runtime (the exception tag)
  // stays out.
  for (const optimize of levels) for (const op of ['/', '%']) for (const divisor of ['2n','-1n']) {
    const bytes=compile(`export function f(){return -9223372036854775808n ${op} ${divisor}}`,{optimize})
    const mod=new WebAssembly.Module(bytes)
    is(WebAssembly.Module.exports(mod).some(e=>e.kind==='tag'),false,`${op} ${divisor} O${optimize || 0}`)
  }
})

test('Number division and remainder: nonthrowing catches cost no output bytes', () => {
  for (const optimize of levels) for (const op of ['/', '%'])
    is(compile(`export function f(a,b){try{return a ${op} b}catch(e){return 0}}`,{optimize}),
      compile(`export function f(a,b){return a ${op} b}`,{optimize}), `${op} O${optimize || 0}`)
})

for (const op of ['/', '%']) test(`joint ${op}: Number zero stays numeric; mixed zero is TypeError, not RangeError`, () => {
  const source = `export function f(a,b,ab,bb){
    const x=ab?BigInt(a):Number(a),y=bb?BigInt(b):Number(b);return x ${op} y}
    export const state=()=>0`
  for (const optimize of levels) {
    const expected=oracle(source),actual=jz(source,{optimize}).exports
    for (const args of [['6','0',true,true], ['6','0',true,false], ['6','0',false,true],
      ['6','0',false,false], ['-6','0',false,false], ['0','0',false,false], ['6','2',true,true]])
      is(observe(actual.f,args,true),observe(expected.f,args,false), `O${optimize || 0}: ${args}`)
  }
})
