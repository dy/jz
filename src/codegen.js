export const operatorMap = {
  '+': 'f64.add',
  '-': 'f64.sub',
  '*': 'f64.mul',
  '/': 'f64.div',
  '%': 'f64.rem',
  '**': 'f64.pow',
  
  '==': 'f64.eq',
  '!=': 'f64.ne',
  '===': 'f64.eq',
  '!==': 'f64.ne',
  '<': 'f64.lt',
  '<=': 'f64.le',
  '>': 'f64.gt',
  '>=': 'f64.ge',
  
  '&&': 'f64.and',
  '||': 'f64.or',
  '??': 'f64.coalesce',
  
  '!': 'f64.not',
  '~': 'f64.bitnot',
  '+': 'f64.pos',
  '-': 'f64.neg',
  
  '&': 'f64.bitand',
  '|': 'f64.bitor',
  '^': 'f64.bitxor',
  '<<': 'f64.shl',
  '>>': 'f64.shr',
  '>>>': 'f64.shr_u'
}

export function generate(ast) {
  const wat = generateWat(ast)
  return wat
}

export function generateWat(ast) {
  const mainCode = generateExpression(ast)
  
  return `(module
  (memory 1 10)
  
  ${generateStdLib()}
  
  (func $main (result f64)
    ${mainCode}
  )
  
  (export "main" (func $main))
  (export "memory" (memory 0))
)`
}

export function generateExpression(ast) {
  return '(f64.const 0)' // TODO: Implement AST to WAT conversion
}

export function generateStdLib() {
  return '' // TODO: Implement stdlib generation
}