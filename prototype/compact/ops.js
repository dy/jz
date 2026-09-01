// One classifier authority for every source operator accepted by the staged
// prototype. Consumers map these numeric classes to validation or WAT policy.

export const OP_NONE = -1
export const OP_ADD = 0
export const OP_SUB = 1
export const OP_MUL = 2
export const OP_DIV = 3
export const OP_MOD = 4
export const OP_POW = 5

export const CMP_EQ = 0
export const CMP_NE = 1
export const CMP_LT = 2
export const CMP_GT = 3
export const CMP_LE = 4
export const CMP_GE = 5

export const LOGIC_NONE = -1
export const LOGIC_AND = 0
export const LOGIC_OR = 1

export const BIT_NONE = -1
export const BIT_AND = 0
export const BIT_OR = 1
export const BIT_XOR = 2
export const BIT_SHL = 3
export const BIT_SHR = 4
export const BIT_USHR = 5
export const BIT_NOT = 6

export const BUILTIN_NONE = -1
export const BUILTIN_IMUL = 0
export const BUILTIN_CLZ32 = 1

export const arithmeticKind = (op) => op === '+' ? OP_ADD : op === '-' ? OP_SUB
  : op === '*' ? OP_MUL : op === '/' ? OP_DIV : op === '%' ? OP_MOD
  : op === '**' ? OP_POW : OP_NONE

export const hasScalarWatOpcode = (kind) => kind >= OP_ADD && kind <= OP_DIV

export const assignmentKind = (op) => op === '+=' ? OP_ADD : op === '-=' ? OP_SUB
  : op === '*=' ? OP_MUL : op === '/=' ? OP_DIV : OP_NONE

export const bitwiseKind = (op) => op === '&' ? BIT_AND : op === '|' ? BIT_OR
  : op === '^' ? BIT_XOR : op === '<<' ? BIT_SHL : op === '>>' ? BIT_SHR
  : op === '>>>' ? BIT_USHR : op === '~' ? BIT_NOT : BIT_NONE

export const bitwiseAssignmentKind = (op) => op === '&=' ? BIT_AND : op === '|=' ? BIT_OR
  : op === '^=' ? BIT_XOR : op === '<<=' ? BIT_SHL : op === '>>=' ? BIT_SHR
  : op === '>>>=' ? BIT_USHR : BIT_NONE

export const builtinKind = (callee) => {
  if (!Array.isArray(callee) || callee[0] !== '.' || callee[1] !== 'Math') return BUILTIN_NONE
  return callee[2] === 'imul' ? BUILTIN_IMUL : callee[2] === 'clz32' ? BUILTIN_CLZ32 : BUILTIN_NONE
}

export const comparisonKind = (op) => op === '==' || op === '===' ? CMP_EQ
  : op === '!=' || op === '!==' ? CMP_NE
  : op === '<' ? CMP_LT : op === '>' ? CMP_GT
  : op === '<=' ? CMP_LE : op === '>=' ? CMP_GE : OP_NONE

export const logicalKind = (op) => op === '&&' ? LOGIC_AND : op === '||' ? LOGIC_OR : LOGIC_NONE
