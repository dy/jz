// Set instance method codegen
import { f64, wat } from './types.js'

// Set method handlers
export const SET_METHODS = {
  has(rw, args, ctx, gen) {
    if (args.length !== 1) throw new Error('Set.has() requires 1 argument')
    ctx.usedMemory = true
    ctx.usedStdlib.push('__set_has')
    return wat(`(call $__set_has ${rw} ${f64(gen(args[0]))})`, 'i32')
  },
  add(rw, args, ctx, gen) {
    if (args.length !== 1) throw new Error('Set.add() requires 1 argument')
    ctx.usedMemory = true
    ctx.usedStdlib.push('__set_add')
    return wat(`(call $__set_add ${rw} ${f64(gen(args[0]))})`, 'set')
  },
  delete(rw, args, ctx, gen) {
    if (args.length !== 1) throw new Error('Set.delete() requires 1 argument')
    ctx.usedMemory = true
    ctx.usedStdlib.push('__set_delete')
    return wat(`(call $__set_delete ${rw} ${f64(gen(args[0]))})`, 'i32')
  },
  clear(rw, args, ctx) {
    if (args.length !== 0) throw new Error('Set.clear() takes no arguments')
    ctx.usedMemory = true
    ctx.usedStdlib.push('__set_clear')
    return wat(`(call $__set_clear ${rw})`, 'set')
  }
}
