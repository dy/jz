// Stable backend boundary. JZ owns semantic lowering through WAT; watr owns
// whole-module WAT optimization and binary encoding.

import watrCompile from 'watr/compile'
import watrOptimize, { resetNameUids } from 'watr/optimize'

export function optimizeWat(wat, options) {
  if (options?.optimize !== true) return wat
  resetNameUids()
  return watrOptimize(wat, options?.watr ?? true)
}

export function compileWat(wat) {
  return watrCompile(wat)
}
