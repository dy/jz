import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {pathToFileURL, fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
const root = resolve(process.env.JZ_FACT_ROOT || fileURLToPath(new URL('../..', import.meta.url)))
const {compile} = await import(pathToFileURL(resolve(root, 'index.js')).href)
// Snapshot at publication, preserving key types, holes, metadata and identities
// shared across ALL fact roots (including closure/signature/parameter/method maps).
function graph(root){
 const ids=new Map(),nodes=[]
 function value(v){
  if(v===null)return ['null']
  const t=typeof v
  if(t==='number')return ['number',Object.is(v,-0)?'-0':String(v)]
  if(t==='bigint')return ['bigint',String(v)]
  if(t==='undefined'||t==='string'||t==='boolean')return [t,v]
  if(t==='symbol'||t==='function')throw Error('unexpected fact '+t)
  if(ids.has(v))return ['ref',ids.get(v)]
  const id=nodes.length;ids.set(v,id);nodes.push(null)
  let data
  if(v instanceof Map)data=['Map',[...v].map(([k,x])=>[value(k),value(x)])]
  else if(v instanceof Set)data=['Set',[...v].map(value)]
  else {
   const props=Reflect.ownKeys(v).map(k=>{
    if(typeof k==='symbol')throw Error('symbol fact key')
    const d=Object.getOwnPropertyDescriptor(v,k)
    if(!('value' in d))throw Error('accessor fact '+k)
    return[k,d.enumerable,d.writable,d.configurable,value(d.value)]
   })
   data=[Array.isArray(v)?'Array':Object.getPrototypeOf(v)===null?'null-prototype':v.constructor?.name,props]
  }
  nodes[id]=data;return ['ref',id]
 }
 return {root:value(root),nodes}
}
const programs=JSON.parse(readFileSync(new URL('./programs.json',import.meta.url)))
const out={};let runs
for(const[name,{src,opts}]of Object.entries(programs)){
 runs=[];globalThis.captureFacts=f=>runs.push(graph(f))
 let bytes,error
 try{const b=compile(src,opts);if(!WebAssembly.validate(b))throw Error('invalid wasm');bytes={length:b.length,sha256:createHash('sha256').update(b).digest('hex')}}catch(e){error=e.message}
 out[name]={runs,bytes,error}
}
if (Object.values(out).reduce((n,p)=>n+p.runs.length,0) !== 27) throw Error('expected 27 intercepted publications')
writeFileSync(process.argv[2],JSON.stringify(out))
console.log(Object.keys(out).length,'programs',Object.values(out).reduce((n,p)=>n+p.runs.length,0),'full fact graphs')
