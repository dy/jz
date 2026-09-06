// Bounded value/byte comparison, not a timing, heap or bootstrap benchmark.
import {writeFileSync, readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {isDeepStrictEqual} from 'node:util'
import {compile, instantiate} from '../../index.js'
const hash = value => createHash('sha256').update(value).digest('hex')
const root = new URL('../../', import.meta.url)
const controls = [
  'return 7', 'return n*n+2*n+1', 'return n/3-0.25', 'return (n>>>0)/2',
  'let s=0;for(let i=0;i<n;i++)s+=i;return s', 'return (n<<3)^17',
  'const a=new Float64Array(4);a[1]=n;return a[1]*2',
  'const a=new Int32Array([2,3,5]);return a[1]+n',
  'const o={x:n,y:2};return o.x+o.y', 'const a=[n,2,3];return a[0]+a[2]',
  'const m=new Map();m.set(1,n);return m.get(1)',
  'return String(n).length', 'return "abc".charCodeAt(1)+n',
  'const f=x=>x+1;return f(n)', 'return n>1?3:4',
  'return Math.sqrt(n+1)', 'return (n,n+1)', 'return typeof n',
  'const a=[1,2,3];return a.reduce((s,x)=>s+x,n)',
  'let v=n;v|=3;return v'
]
const rows = controls.map((body,i) => ({name:'control-'+i, source:`export function f(n){${body}}`, args:[[0],[1],[3]]}))
for (const op of ['|','^','<<','>>']) rows.push({name:'bigint-'+op,
  source:`export function f(n){let t=0;const a=BigInt(n);const v=(t++,a) ${op} (t++,1n);return [v,t]}`,
  args:[['0'],['6'],['-1']]})
for (const type of ['number','bigint','object']) rows.push({name:'typeof-bigint-'+type,
  source:`export function f(n){let t=0;const v=typeof (t++,BigInt(n))==='${type}';return [v,t]}`,
  args:[['6'],['-1'],['bad']]})
// Also isolate direct results from the independently broken mixed-array ABI.
for (const row of rows.slice(20)) rows.push({...row, name:row.name+'-direct', state:true,
  source:row.source.replace('export function f(n){let t=0;',
    'let t=0;export const state=()=>t;export function f(n){t=0;').replace('return [v,t]', 'return v')})
rows.push({name:'typeof-effect',source:'export function f(n){let t=0;const v=typeof (t++,BigInt(n));return [v,t]}',args:[['6'],['0'],['bad']]})
rows.push({name:'nullable-result',source:'export const f=n=>(n,n?6n:null)',args:[[0],[1],[0]]})
rows.push({name:'nullable-number',source:'export const f=n=>Number((n,n?6n:null))',args:[[0],[1],[0]]})
rows.push({name:'typeof-object',source:'export const f=n=>typeof (n,n) === "object"',args:[[null],[undefined],[0]]})
rows.push({name:'stored-bigint-object',source:'const m=new Map();m.set(0,6n);m.set(1,null);export const f=n=>typeof m.get(n)==="object"',args:[[0],[1],[2]]})
const normalize = value => {
  if (Array.isArray(value)) return ['array', value.map(normalize)]
  if (typeof value === 'number') return ['number', Object.is(value,-0) ? '-0' : String(value)]
  return [typeof value, String(value)]
}
const observe = (fn,args,wasm) => {
  try { return ['return',normalize(fn(...args))] }
  catch(e) { return ['throw', normalize(wasm && e?.name==='Error' && Object.hasOwn(e,'thrown') ? e.thrown : e?.name ?? e)] }
}
const output = []
for (const row of rows) for (const optimize of [false,1,2,3]) {
  const oracle = Function(row.source.replaceAll('export ','')+`;return ${row.state ? '{f,state}' : '{f}'}`)()
  const bytes = compile(row.source,{optimize}), valid = WebAssembly.validate(bytes)
  if (!valid) throw Error('invalid output: '+row.name)
  const exports = instantiate(bytes.slice()).exports
  const run = (exports,args,wasm) => {
    const result = observe(exports.f,args,wasm)
    return row.state ? [result,normalize(exports.state())] : result
  }
  const actual = row.args.map(args=>run(exports,args,true))
  const expected = row.args.map(args=>run(oracle,args,false))
  output.push({name:row.name,optimize,source:hash(row.source),bytes:bytes.length,hash:hash(bytes),valid,
    actual,expected,matches:actual.map((x,i)=>isDeepStrictEqual(x,expected[i]))})
}
const git = args => execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim()
writeFileSync(process.argv[2],JSON.stringify({head:git(['rev-parse','HEAD']),
  patch:hash(git(['diff'])),loader:process.env.NODE_OPTIONS || '',
  watr:hash(readFileSync(new URL('node_modules/watr/src/optimize.js',root))),rows:output},null,2)+'\n')
