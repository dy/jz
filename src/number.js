// Number instance method codegen
import { f64, i32, wat } from './types.js'

// Number method handlers
// receiver = wat object with .type
export const NUMBER_METHODS = {
  toFixed(receiver, args, ctx, gen) {
    ctx.usedStdlib.push('toFixed')
    ctx.usedMemory = true
    const digits = args.length >= 1 ? i32(gen(args[0])) : '(i32.const 0)'
    return wat(`(call $toFixed ${f64(receiver)} ${digits})`, 'string')
  },
  toString(receiver, args, ctx, gen) {
    ctx.usedMemory = true
    if (args.length >= 1) {
      ctx.usedStdlib.push('toString')
      return wat(`(call $toString ${f64(receiver)} ${i32(gen(args[0]))})`, 'string')
    }
    ctx.usedStdlib.push('numToString')
    return wat(`(call $numToString ${f64(receiver)})`, 'string')
  },
  toExponential(receiver, args, ctx, gen) {
    ctx.usedStdlib.push('toExponential')
    ctx.usedMemory = true
    const frac = args.length >= 1 ? i32(gen(args[0])) : '(i32.const 6)'
    return wat(`(call $toExponential ${f64(receiver)} ${frac})`, 'string')
  },
  toPrecision(receiver, args, ctx, gen) {
    ctx.usedStdlib.push('toPrecision')
    ctx.usedMemory = true
    const prec = args.length >= 1 ? i32(gen(args[0])) : '(i32.const 6)'
    return wat(`(call $toPrecision ${f64(receiver)} ${prec})`, 'string')
  }
}
