import { parse, normalize } from './parser.js'
import { generateExpression } from './codegen.js'

export function compile(code) {
  code = preprocess(code)
  const ast = normalize(parse(code))
  return { exprWat: generateExpression(ast) }
}

// Convert JS numeric literal prefixes that subscript doesn't handle
function preprocess(code) {
  if (typeof code !== 'string') return code
  return code
    .replace(/\b0[bB]([01]+)\b/g, (_, b) => String(parseInt(b, 2)))
    .replace(/\b0[oO]([0-7]+)\b/g, (_, o) => String(parseInt(o, 8)))
    .replace(/\b0[xX]([0-9a-fA-F]+)\b/g, (_, h) => String(parseInt(h, 16)))
}
