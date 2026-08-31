// Pure scalar constant evaluation shared by validation and lowering. Undefined
// is the sentinel because every supported constant result is a number or bool.

import {
  CMP_EQ, CMP_GE, CMP_GT, CMP_LE, CMP_LT, CMP_NE,
  OP_ADD, OP_DIV, OP_MOD, OP_MUL, OP_NONE, OP_POW, OP_SUB,
  arithmeticKind, comparisonKind,
} from './ops.js'

export const isBooleanLiteral = (node) => Array.isArray(node) && node[0] === 'bool' &&
  node.length === 2 && (node[1] === 0 || node[1] === 1)

export const constantNumber = (node) => {
  if (!Array.isArray(node)) return undefined
  if (node[0] == null && node.length === 2 && typeof node[1] === 'number') return node[1]
  if (node[0] === '()' && node.length === 2) return constantNumber(node[1])
  const kind = arithmeticKind(node[0])
  if (kind === OP_NONE) return undefined
  const a = constantNumber(node[1])
  if (a === undefined) return undefined
  if (node.length === 2) return kind === OP_ADD ? +a : kind === OP_SUB ? -a : undefined
  if (node.length !== 3) return undefined
  const b = constantNumber(node[2])
  if (b === undefined) return undefined
  return kind === OP_ADD ? a + b : kind === OP_SUB ? a - b
    : kind === OP_MUL ? a * b : kind === OP_DIV ? a / b
    : kind === OP_MOD ? a % b : kind === OP_POW ? a ** b : undefined
}

export const constantTruth = (node) => {
  if (!Array.isArray(node)) return undefined
  if (node[0] === '()' && node.length === 2) return constantTruth(node[1])
  if (isBooleanLiteral(node)) return node[1]
  if (node[0] === '!' && node.length === 2) {
    const value = constantTruth(node[1])
    return value === undefined ? undefined : value ? 0 : 1
  }
  const comparison = comparisonKind(node[0])
  if (comparison !== OP_NONE && node.length === 3) {
    const a = constantNumber(node[1]), b = constantNumber(node[2])
    if (a === undefined || b === undefined) return undefined
    return comparison === CMP_EQ ? +(a === b) : comparison === CMP_NE ? +(a !== b)
      : comparison === CMP_LT ? +(a < b) : comparison === CMP_GT ? +(a > b)
      : comparison === CMP_LE ? +(a <= b) : comparison === CMP_GE ? +(a >= b) : undefined
  }
  const number = constantNumber(node)
  return number === undefined ? undefined : +!!number
}
