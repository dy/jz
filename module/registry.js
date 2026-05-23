/**
 * Stdlib module registry — names and paths only (no eager imports).
 *
 * @module module/registry
 */

export const MOD_ALIAS = {
  Number: 'number', Array: 'array', Object: 'object', Symbol: 'symbol',
  JSON: 'json', Date: 'date', BigInt: 'number', Error: 'core',
  TextEncoder: 'string', TextDecoder: 'string',
}

export const MOD_PATHS = Object.assign(Object.create(null), {
  math: './math.js',
  core: './core.js',
  array: './array.js',
  object: './object.js',
  string: './string.js',
  number: './number.js',
  fn: './function.js',
  typedarray: './typedarray.js',
  collection: './collection.js',
  symbol: './symbol.js',
  console: './console.js',
  json: './json.js',
  regex: './regex.js',
  timer: './timer.js',
  date: './date.js',
})

export const hasModName = name => Boolean(MOD_PATHS[MOD_ALIAS[name] || name])
