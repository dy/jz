// Staged compact compiler prototype.
//
// parse -> prepare -> ProgramIndex -> per-function scalar WAT -> watr

import { parse } from '../../src/parse.js'
import { compileWat, optimizeWat } from './backend.js'
import { lowerProgram } from './lower.js'
import { prepareCompactAst } from './prepare.js'
import { buildProgramIndex } from './program-index.js'

export function compileCompactAst(ast, options) {
  const prepared = prepareCompactAst(ast)
  const index = buildProgramIndex(prepared)
  const wat = optimizeWat(lowerProgram(index), options)
  return options?.wat ? wat : compileWat(wat)
}

export default function compileCompact(source, options) {
  return compileCompactAst(parse(source), options)
}
