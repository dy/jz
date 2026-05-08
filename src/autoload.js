/** Runtime module autoload rules used by prepare(). */

import { ctx, err } from './ctx.js'
import * as mods from '../module/index.js'

const dict = obj => Object.assign(Object.create(null), obj)

export const PROP_MODULES = Object.assign(Object.create(null), {
  push: ['core', 'array'], pop: ['core', 'array'], shift: ['core', 'array'], unshift: ['core', 'array'],
  splice: ['core', 'array'], reverse: ['core', 'array'], sort: ['core', 'array'], fill: ['core', 'array'],
  map: ['core', 'array'], filter: ['core', 'array'], reduce: ['core', 'array'], reduceRight: ['core', 'array'],
  forEach: ['core', 'array'], find: ['core', 'array'], findIndex: ['core', 'array'],
  findLast: ['core', 'array'], findLastIndex: ['core', 'array'],
  every: ['core', 'array'], some: ['core', 'array'], flat: ['core', 'array'], flatMap: ['core', 'array'],
  join: ['core', 'array'], copyWithin: ['core', 'array'], at: ['core', 'array'],
  charAt: ['core', 'string'], charCodeAt: ['core', 'string'], codePointAt: ['core', 'string'],
  toUpperCase: ['core', 'string'], toLowerCase: ['core', 'string'], trim: ['core', 'string'],
  trimStart: ['core', 'string'], trimEnd: ['core', 'string'],
  split: ['core', 'string'], replace: ['core', 'string'], replaceAll: ['core', 'string'],
  repeat: ['core', 'string'], startsWith: ['core', 'string'], endsWith: ['core', 'string'],
  padStart: ['core', 'string'], padEnd: ['core', 'string'], normalize: ['core', 'string'],
  matchAll: ['core', 'string'], match: ['core', 'string'],
  substring: ['core', 'string'], substr: ['core', 'string'],
  add: ['core', 'collection'], clear: ['core', 'collection'],
  slice: ['core', 'string', 'array'], concat: ['core', 'string', 'array'],
  indexOf: ['core', 'string', 'array'], lastIndexOf: ['core', 'string', 'array'],
  includes: ['core', 'string', 'array'],
  length: ['core', 'string', 'array', 'typedarray'],
})

export const OP_MODULES = {
  '?.': ['core', 'string', 'collection'],
  '?.[]': ['core', 'array', 'collection'],
  '?.()': ['core', 'fn'],
  'u+': ['number', 'string'],
  'in': ['core', 'collection', 'string'],
  '==': ['core', 'string'],
  '!=': ['core', 'string'],
  'typeof': ['core', 'string'],
  '[': ['core', 'array'],
  '{': ['core', 'object', 'string', 'collection'],
  '//': ['core', 'string', 'regex'],
  '**': ['math'],
}

export const CALL_MODULES = dict({
  ArrayBuffer: ['core', 'typedarray'],
  DataView: ['core', 'typedarray'],
  BigInt64Array: ['core', 'typedarray'],
  BigUint64Array: ['core', 'typedarray'],
  parseFloat: ['number', 'string'],
  parseInt: ['number', 'string'],
  String: ['core', 'string', 'number'],
  Number: ['number', 'string'],
  Boolean: ['number'],
  TextEncoder: ['core', 'string'],
  TextDecoder: ['core', 'string'],
  Error: ['core', 'string'],
  BigInt: ['number'],
  'console.log': ['core', 'string', 'number', 'console'],
  'console.warn': ['core', 'string', 'number', 'console'],
  'console.error': ['core', 'string', 'number', 'console'],
  'Object.fromEntries': ['collection', 'string'],
  'Object.keys': ['core', 'object', 'string'],
  'Object.values': ['core', 'object', 'string'],
  'Object.entries': ['core', 'object', 'string'],
  'Object.assign': ['core', 'object'],
  'Object.create': ['core', 'object'],
  'Date.now': ['core', 'console'],
  'performance.now': ['core', 'console'],
  'String.fromCharCode': ['core', 'string'],
  'String.fromCodePoint': ['core', 'string'],
  'BigInt.asIntN': ['number'],
  'BigInt.asUintN': ['number'],
  'Float64Array.from': ['core', 'typedarray', 'array'],
  'Float32Array.from': ['core', 'typedarray', 'array'],
  'Int32Array.from': ['core', 'typedarray', 'array'],
  'Uint32Array.from': ['core', 'typedarray', 'array'],
  'Int16Array.from': ['core', 'typedarray', 'array'],
  'Uint16Array.from': ['core', 'typedarray', 'array'],
  'Int8Array.from': ['core', 'typedarray', 'array'],
  'Uint8Array.from': ['core', 'typedarray', 'array'],
  'ArrayBuffer.isView': ['core', 'typedarray'],
})

export const GENERIC_METHOD_MODULES = dict({
  toString: ['core', 'string', 'number'],
  toFixed: ['core', 'string', 'number'],
  toPrecision: ['core', 'string', 'number'],
  toExponential: ['core', 'string', 'number'],
  hasOwnProperty: ['core', 'object', 'string', 'collection'],
})

export const CTORS = ['Float64Array','Float32Array','Int32Array','Uint32Array','Int16Array','Uint16Array','Int8Array','Uint8Array','BigInt64Array','BigUint64Array','Set','Map']
export const TYPED_CTORS = ['Float64Array','Float32Array','Int32Array','Uint32Array','Int16Array','Uint16Array','Int8Array','Uint8Array','BigInt64Array','BigUint64Array','ArrayBuffer','DataView']
export const COLLECTION_CTORS = ['Set', 'Map']
export const TIMER_NAMES = new Set(['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'])

export const MOD_ALIAS = { Number: 'number', Array: 'array', Object: 'object', Symbol: 'symbol', JSON: 'json', BigInt: 'number', Error: 'core', TextEncoder: 'string', TextDecoder: 'string' }

const MOD_DEPS = {
  number: ['core', 'string'],
  string: ['core', 'number'],
  array: ['core'],
  object: ['core'],
  collection: ['core', 'number'],
  symbol: ['core'],
  json: ['core', 'string', 'number', 'collection'],
  console: ['core', 'string', 'number'],
  regex: ['core', 'string', 'array'],
}

export const hasModule = name => Boolean(mods[MOD_ALIAS[name] || name])

export const includeMods = (...names) => names.forEach(includeModule)

export const includeForOp = op => {
  const modules = OP_MODULES[op]
  if (!modules) return false
  includeMods(...modules)
  return true
}

export const includeForCallableValue = () => includeMods('core', 'fn')
export const includeForNumericCoercion = () => includeMods('number', 'string')
export const includeForStringValue = () => includeMods('core', 'string', 'number')
export const includeForStringOnly = () => includeMods('core', 'string')
export const includeForArrayLiteral = () => includeMods('core', 'array')
export const includeForArrayAccess = () => includeMods('core', 'array', 'collection')
export const includeForArrayPattern = includeForArrayAccess
export const includeForObjectLiteral = () => includeMods('core', 'object')
export const includeForObjectPattern = () => includeMods('core', 'object', 'string', 'collection')
export const includeForKnownKeyIteration = includeForStringOnly
export const includeForRuntimeKeyIteration = () => includeMods('core', 'string', 'collection')
export const includeForTimerRuntime = () => {
  ctx.features.timers = true
  includeModule('timer')
  includeModule('fn')
}

export const includeForNamedCall = callee => {
  const modules = CALL_MODULES[callee]
  if (!modules) return false
  includeMods(...modules)
  return true
}

export const includeForGenericMethod = prop => {
  const modules = GENERIC_METHOD_MODULES[prop]
  if (!modules) return false
  includeMods(...modules)
  return true
}

export const includeForProperty = prop => {
  if (prop === 'byteLength' || prop === 'byteOffset' || prop === 'buffer') includeMods('core', 'typedarray')
  if (typeof prop === 'string' && PROP_MODULES[prop]) includeMods(...PROP_MODULES[prop])
  else includeMods('core', 'object', 'array', 'string', 'collection')
}

export const runtimeCtorKind = name =>
  TYPED_CTORS.includes(name) ? 'typedarray' : COLLECTION_CTORS.includes(name) ? 'collection' : null

export const includeForRuntimeCtor = name => {
  const kind = runtimeCtorKind(name)
  if (kind === 'typedarray') includeMods('core', 'typedarray')
  else if (kind === 'collection') includeMods('core', 'collection')
  return kind
}

export function includeModule(name) {
  const modName = MOD_ALIAS[name] || name
  const init = mods[modName]
  if (!init) return err(`Module not found: ${name}`)
  if (ctx.module.modules[modName]) return
  ctx.module.modules[modName] = true
  for (const dep of MOD_DEPS[modName] || []) includeModule(dep)
  init(ctx)
}