// Pure scalar constant evaluation shared by validation and lowering. A null
// result means the expression is not a supported compile-time scalar.

import {
  BIT_AND, BIT_NONE, BIT_NOT, BIT_OR, BIT_SHL, BIT_SHR, BIT_USHR, BIT_XOR,
  BUILTIN_CLZ32, BUILTIN_IMUL, BUILTIN_NONE,
  CMP_EQ, CMP_GE, CMP_GT, CMP_LE, CMP_LT, CMP_NE,
  OP_ADD, OP_DIV, OP_MOD, OP_MUL, OP_NONE, OP_POW, OP_SUB,
  arithmeticKind, bitwiseKind, builtinKind, comparisonKind,
} from './ops.js'
import { REP_F64, REP_I32, REP_U32 } from './reps.js'

export const isBooleanLiteral = (node) => Array.isArray(node) && node[0] === 'bool' &&
  node.length === 2 && (node[1] === 0 || node[1] === 1)

const callArgs = (node) => node == null ? []
  : Array.isArray(node) && node[0] === ',' ? node.slice(1) : [node]

export const constantScalar = (node) => {
  if (!Array.isArray(node)) return null
  if (node[0] == null && node.length === 2 && typeof node[1] === 'number') return [node[1], REP_F64]
  if (node[0] === '()' && node.length === 2) return constantScalar(node[1])

  const bitwise = bitwiseKind(node[0])
  if (bitwise !== BIT_NONE) {
    const a = constantScalar(node[1])
    if (!a) return null
    if (bitwise === BIT_NOT && node.length === 2) return [~a[0], REP_I32]
    if (node.length !== 3) return null
    const b = constantScalar(node[2])
    if (!b) return null
    const value = bitwise === BIT_AND ? a[0] & b[0] : bitwise === BIT_OR ? a[0] | b[0]
      : bitwise === BIT_XOR ? a[0] ^ b[0] : bitwise === BIT_SHL ? a[0] << b[0]
      : bitwise === BIT_SHR ? a[0] >> b[0] : bitwise === BIT_USHR ? a[0] >>> b[0]
      : undefined
    return value === undefined ? null : [value, bitwise === BIT_USHR ? REP_U32 : REP_I32]
  }

  if (node[0] === '()') {
    const builtin = builtinKind(node[1])
    if (builtin !== BUILTIN_NONE) {
      const args = callArgs(node[2])
      const expected = builtin === BUILTIN_IMUL ? 2 : 1
      if (args.length !== expected) return null
      const values = new Array(args.length)
      for (let i = 0; i < args.length; i++) {
        const value = constantScalar(args[i])
        if (!value) return null
        values[i] = value[0]
      }
      return [builtin === BUILTIN_IMUL ? Math.imul(values[0], values[1]) : Math.clz32(values[0]), REP_I32]
    }
  }

  const kind = arithmeticKind(node[0])
  if (kind === OP_NONE) return null
  const a = constantScalar(node[1])
  if (!a) return null
  if (node.length === 2) return kind === OP_ADD ? [+a[0], a[1]]
    : kind === OP_SUB ? [-a[0], REP_F64] : null
  if (node.length !== 3) return null
  const b = constantScalar(node[2])
  if (!b) return null
  return [kind === OP_ADD ? a[0] + b[0] : kind === OP_SUB ? a[0] - b[0]
    : kind === OP_MUL ? a[0] * b[0] : kind === OP_DIV ? a[0] / b[0]
    : kind === OP_MOD ? a[0] % b[0] : kind === OP_POW ? a[0] ** b[0] : undefined, REP_F64]
}

export const constantNumber = (node) => constantScalar(node)?.[0]

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
    const a = constantScalar(node[1]), b = constantScalar(node[2])
    if (!a || !b) return undefined
    return comparison === CMP_EQ ? +(a[0] === b[0]) : comparison === CMP_NE ? +(a[0] !== b[0])
      : comparison === CMP_LT ? +(a[0] < b[0]) : comparison === CMP_GT ? +(a[0] > b[0])
      : comparison === CMP_LE ? +(a[0] <= b[0]) : comparison === CMP_GE ? +(a[0] >= b[0]) : undefined
  }
  const number = constantScalar(node)
  return number ? +!!number[0] : undefined
}
