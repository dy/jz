// Incremental binary/value evidence; no timing or allocation claim.
import {writeFileSync,readFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {compile,instantiate} from '../../index.js'
const hash=x=>createHash('sha256').update(x).digest('hex')
const cases=[]
const add=(name,body,args=[['6','2'],['6','0'],['-9223372036854775808','-1'],['bad','2'],['6','2']])=>
  cases.push({name,source:`let trace=0;export const state=()=>trace;export function f(a,b){trace=1;${body}}`,args})
for(const op of ['/','%']) {
  add('number-'+op,`const x=Number(a) ${op} Number(b);trace=2;return x`)
  add('number-catch-'+op,`try{const x=a ${op} b;trace=2;return x}catch(e){return 0}`,[[6,2],[6,0],[0,0],[6,2]])
  for(const right of ['2n','-1n','0n']) add('constant-'+op+right,`return 6n ${op} ${right}`,[[]])
  for(const use of ['VALUE','typeof VALUE','(VALUE,9)'])
    add(op+':'+use,`const x=${use.replace('VALUE',`(BigInt(a) ${op} BigInt(b))`)};trace=2;return x`)
  add('compound-'+op,`let x=BigInt(a);x ${op}= BigInt(b);trace=2;return x`)
  add('catch-'+op,`try{BigInt(a) ${op} BigInt(b);trace=2;return 'ok'}catch(e){trace=3;return e.name}`)
}
add('primitive','throw 214',[[]])
add('nullish-read','const m=new Map();m.set(1,[3]);return m.get(a).length',[[1],[0],[1]])
add('nullish-call','const m=new Map();m.set(1,()=>3);return m.get(a)()',[[1],[0],[1]])
const norm=x=>[typeof x,typeof x==='number' && Object.is(x,-0)?'-0':String(x)]
const observe=(e,args,wasm)=>{
  let result
  try {const x=e.f(...args);result=['return',norm(typeof x==='bigint'?BigInt.asIntN(64,x):x)]}
  catch(e){result=['throw',norm(wasm && e?.name==='Error' && Object.hasOwn(e,'thrown')?e.thrown:e?.name??e)]}
  return [result,norm(e.state())]
}
const rows=[]
for(const c of cases)for(const optimize of [false,1,2,3]) {
  const oracle=Function(c.source.replaceAll('export ','')+';return {f,state}')()
  const bytes=compile(c.source,{optimize}),valid=WebAssembly.validate(bytes)
  if(!valid)throw Error('invalid: '+c.name)
  const e=instantiate(bytes.slice()).exports
  const actual=c.args.map(a=>observe(e,a,true)),expected=c.args.map(a=>observe(oracle,a,false))
  rows.push({...c,optimize,sourceHash:hash(c.source),bytes:bytes.length,hash:hash(bytes),valid,
    actual,expected,matches:actual.map((v,i)=>isDeepStrictEqual(v,expected[i]))})
}
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim()
writeFileSync(process.argv[2],JSON.stringify({head:git('rev-parse','HEAD'),patchHash:hash(git('diff')),
  loader:process.env.NODE_OPTIONS||'',watrHash:hash(readFileSync(new URL('../../node_modules/watr/src/optimize.js',import.meta.url))),rows},null,2)+'\n')
