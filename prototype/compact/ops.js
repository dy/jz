// One classifier authority for every source operator accepted by the staged
// prototype. Consumers map these numeric classes to validation or WAT policy.

export const OP_NONE = -1
export const OP_ADD = 0
export const OP_SUB = 1
export const OP_MUL = 2
export const OP_DIV = 3

export const CMP_EQ = 0
export const CMP_NE = 1
export const CMP_LT = 2
export const CMP_GT = 3
export const CMP_LE = 4
export const CMP_GE = 5

export const arithmeticKind = (op) => op === '+' ? OP_ADD : op === '-' ? OP_SUB
  : op === '*' ? OP_MUL : op === '/' ? OP_DIV : OP_NONE

export const assignmentKind = (op) => op === '+=' ? OP_ADD : op === '-=' ? OP_SUB
  : op === '*=' ? OP_MUL : op === '/=' ? OP_DIV : OP_NONE

export const comparisonKind = (op) => op === '==' || op === '===' ? CMP_EQ
  : op === '!=' || op === '!==' ? CMP_NE
  : op === '<' ? CMP_LT : op === '>' ? CMP_GT
  : op === '<=' ? CMP_LE : op === '>=' ? CMP_GE : OP_NONE
