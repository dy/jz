// Method dispatch - maps type + method name to implementation
import * as array from './array.js'
import * as string from './string.js'

export const arrayMethods = {
  fill: array.fill, map: array.map, reduce: array.reduce, filter: array.filter,
  find: array.find, findIndex: array.findIndex, indexOf: array.indexOf, includes: array.includes,
  every: array.every, some: array.some, slice: array.slice, reverse: array.reverse,
  push: array.push, pop: array.pop, forEach: array.forEach, concat: array.concat, join: array.join
}

export const stringMethods = {
  charCodeAt: string.charCodeAt, slice: string.slice, indexOf: string.indexOf, substring: string.substring,
  toLowerCase: string.toLowerCase, toUpperCase: string.toUpperCase, includes: string.includes,
  startsWith: string.startsWith, endsWith: string.endsWith, trim: string.trim,
  split: string.split, replace: string.replace
}
