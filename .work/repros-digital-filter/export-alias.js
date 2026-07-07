// jz: "'bar' is not in scope". Live instance: digital-filter/iir/butterworth.js:38
// `export { butterworthPoles as poles }`, imported by linkwitz-riley.js/iirdesign.js.
import foo from './export-alias-lib.js'
export function f(x) { return foo(x) }
