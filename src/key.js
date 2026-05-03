/** Static property-key evaluation for computed member names. */

const NO_VALUE = Symbol('no-static-property-key')

export function staticPropertyKey(node) {
  const value = staticValue(node)
  return value === NO_VALUE ? null : String(value)
}

function staticValue(node) {
  if (node === undefined) return undefined
  if (node === null || typeof node === 'number' || typeof node === 'string' || typeof node === 'boolean') return node
  if (!Array.isArray(node)) return NO_VALUE

  const [op, ...args] = node
  if (op == null) return args.length ? args[0] : undefined
  if (op === 'str') return args[0]
  if (op === '[]' && args.length === 1) return staticValue(args[0])
  if (op === '()' && args[0] === 'String' && args.length === 2) {
    const value = staticValue(args[1])
    return value === NO_VALUE ? NO_VALUE : String(value)
  }
  if (op === '()' && args[0] === 'Number' && args.length === 2) {
    const value = staticValue(args[1])
    return value === NO_VALUE ? NO_VALUE : Number(value)
  }
  if (op === '?:' || op === '?') {
    const cond = staticValue(args[0])
    return cond === NO_VALUE ? NO_VALUE : staticValue(cond ? args[1] : args[2])
  }
  if (op === '&&' || op === '||') {
    const left = staticValue(args[0])
    if (left === NO_VALUE) return NO_VALUE
    return op === '&&' ? (left ? staticValue(args[1]) : left) : (left ? left : staticValue(args[1]))
  }
  if (op === '??') {
    const left = staticValue(args[0])
    return left === NO_VALUE ? NO_VALUE : left == null ? staticValue(args[1]) : left
  }

  if (args.length === 1) {
    const value = staticValue(args[0])
    if (value === NO_VALUE) return NO_VALUE
    if (op === 'u+') return +value
    if (op === 'u-') return -value
    if (op === '!') return !value
    if (op === '~') return ~value
    return NO_VALUE
  }

  if (args.length === 2) {
    const left = staticValue(args[0])
    const right = staticValue(args[1])
    if (left === NO_VALUE || right === NO_VALUE) return NO_VALUE
    switch (op) {
      case '+': return typeof left === 'string' || typeof right === 'string' ? String(left) + String(right) : Number(left) + Number(right)
      case '-': return Number(left) - Number(right)
      case '*': return Number(left) * Number(right)
      case '/': return Number(left) / Number(right)
      case '%': return Number(left) % Number(right)
      case '**': return Number(left) ** Number(right)
      case '&': return Number(left) & Number(right)
      case '|': return Number(left) | Number(right)
      case '^': return Number(left) ^ Number(right)
      case '<<': return Number(left) << Number(right)
      case '>>': return Number(left) >> Number(right)
      case '>>>': return Number(left) >>> Number(right)
      default: return NO_VALUE
    }
  }

  return NO_VALUE
}