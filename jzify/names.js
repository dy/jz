/**
 * Synthetic temp-name factory for jzify lowering passes.
 *
 * Namespaces use private-use Unicode prefixes so they never collide with user code.
 *
 * @module jzify/names
 */

import { T } from '../src/ast.js'

/** @returns fresh name counters, all reset together at jzify entry. */
export function createNames() {
  let swIdx = 0
  let argsIdx = 0
  let doIdx = 0
  let classIdx = 0
  let objThisIdx = 0
  let staticClassIdx = 0
  let classBaseIdx = 0

  return {
    reset() {
      swIdx = argsIdx = doIdx = classIdx = objThisIdx = staticClassIdx = classBaseIdx = 0
    },
    switchDisc: () => `${T}sw${swIdx++}`,
    switchStart: () => `${T}swst${swIdx++}`,
    switchBreak: () => `${T}swbrk${swIdx++}`,
    arg: () => `\uE001arg${argsIdx++}`,
    doFlag: () => `\uE002do${doIdx++}`,
    objThis: () => `\uE003obj${objThisIdx++}`,
    classSelf: () => `\uE003self${classIdx++}`,
    classBase: () => `\uE003base${classBaseIdx++}`,
    classStatic: () => `\uE003class${staticClassIdx++}`,
    classSuperArg: i => `\uE003superArg${classIdx}_${i}`,
    classSuper: i => `\uE003super${classIdx}_${i}`,
    genTemp: (tag) => `\uE004${tag}${swIdx++}`,
  }
}
