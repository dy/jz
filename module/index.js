/**
 * Stdlib module manifest — the single import/re-export point autoload.js walks
 * to register every stdlib plugin. Order matters only for readability; each
 * module self-registers its handlers via the two registration dialects
 * (CONTRIBUTING.md "Stdlib registration"). Adding a stdlib module = add its
 * import + name here, nothing else.
 *
 * @module module/index
 */
import math from './math.js'
import core from './core.js'
import array from './array.js'
import object from './object.js'
import string from './string.js'
import number from './number.js'
import fn from './function.js'
import typedarray from './typedarray.js'
import collection from './collection.js'
import symbol from './symbol.js'
import console from './console.js'
import json from './json.js'
import atomics from './atomics.js'
import regex from './regex.js'
import timer from './timer.js'
import date from './date.js'
import simd from './simd.js'
import fs from './fs.js'
import web from './web.js'
import crypto from './crypto.js'
import navigator from './navigator.js'
export { math, core, array, object, string, number, fn, typedarray, collection, symbol, console, json, regex, timer, date, simd , atomics, fs, web, crypto, navigator }
