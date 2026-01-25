// Map instance method codegen
import { f64, wat } from './types.js'

// Map method handlers
export const MAP_METHODS = {
  has(rw, args, ctx, gen) {
    if (args.length !== 1) throw new Error('Map.has() requires 1 argument')
    ctx.usedMemory = true
    ctx.usedStdlib.push('__map_has')
    return wat(`(call $__map_has ${rw} ${f64(gen(args[0]))})`, 'i32')
  },
  get(rw, args, ctx, gen) {
    if (args.length !== 1) throw new Error('Map.get() requires 1 argument')
    ctx.usedMemory = true
    ctx.usedStdlib.push('__map_get')
    return wat(`(call $__map_get ${rw} ${f64(gen(args[0]))})`, 'f64')
  },
  set(rw, args, ctx, gen) {
    if (args.length !== 2) throw new Error('Map.set() requires 2 arguments')
    ctx.usedMemory = true
    ctx.usedStdlib.push('__map_set')
    return wat(`(call $__map_set ${rw} ${f64(gen(args[0]))} ${f64(gen(args[1]))})`, 'map')
  },
  delete(rw, args, ctx, gen) {
    if (args.length !== 1) throw new Error('Map.delete() requires 1 argument')
    ctx.usedMemory = true
    ctx.usedStdlib.push('__map_delete')
    return wat(`(call $__map_delete ${rw} ${f64(gen(args[0]))})`, 'i32')
  },
  clear(rw, args, ctx) {
    if (args.length !== 0) throw new Error('Map.clear() takes no arguments')
    ctx.usedMemory = true
    ctx.usedStdlib.push('__map_clear')
    return wat(`(call $__map_clear ${rw})`, 'map')
  }
}
