/**
 * Dead-code elimination on the tape: a function survives when it is reached
 * from a root (an exported function, `(start $f)`, an `elem` entry, or a
 * `ref.func`) through `call`, `return_call` and `ref.func`; an unexported
 * global survives when a surviving node reads or writes it (to a fixpoint,
 * since a global's initializer may name another). With `removeDead` off the
 * user's functions and globals are roots and only runtime ones go.
 *
 * Returns the call count per callee over the reachable functions, which the
 * function order pass uses.
 *
 * @module link/treeshake
 */
import { T, NONE, intern, text, walk, remove } from '../ir/tape.js'

export function treeshake(root, { removeDead, userFuncs, userGlobals }) {
  const FUNC = intern('func'), GLOBAL = intern('global'), EXPORT = intern('export'), START = intern('start'), ELEM = intern('elem')
  const CALL = intern('call'), RETURN_CALL = intern('return_call'), REF_FUNC = intern('ref.func')
  const GLOBAL_GET = intern('global.get'), GLOBAL_SET = intern('global.set')

  const funcByName = new Map()
  for (let c = T.a[root]; c !== NONE; c = T.next[c]) {
    if (T.op[c] !== FUNC) continue
    const name = text(T.a[c])
    if (name !== null) funcByName.set(name, c)
  }

  const reachable = new Set()
  const stack = []
  const addRoot = (name) => { if (funcByName.has(name) && !reachable.has(name)) { reachable.add(name); stack.push(name) } }

  for (const [name, f] of funcByName)
    for (let c = T.next[T.a[f]]; c !== NONE; c = T.next[c]) if (T.op[c] === EXPORT) { addRoot(name); break }
  if (!removeDead && userFuncs) for (const name of userFuncs) addRoot(name)
  for (let c = T.a[root]; c !== NONE; c = T.next[c]) {
    if (T.op[c] === FUNC) continue
    walk(c, (id) => {
      const op = T.op[id]
      if (op === START) { const name = text(T.a[id]); if (name !== null) addRoot(name) }
      else if (op === EXPORT) { const target = T.next[T.a[id]]; if (target !== NONE && T.op[target] === FUNC) { const name = text(T.a[target]); if (name !== null) addRoot(name) } }
      else if (op === ELEM) for (let e = T.a[id]; e !== NONE; e = T.next[e]) { const name = text(e); if (name !== null && name[0] === '$') addRoot(name) }
    })
  }

  const callCount = new Map()
  const recordCalls = (f) => walk(f, (id) => {
    const op = T.op[id]
    if (op !== CALL && op !== RETURN_CALL && op !== REF_FUNC) return
    const name = text(T.a[id])
    if (name === null) return
    addRoot(name)
    if (op !== REF_FUNC) callCount.set(name, (callCount.get(name) || 0) + 1)
  })
  for (let c = T.a[root]; c !== NONE; c = T.next[c]) if (T.op[c] === FUNC && text(T.a[c]) === null) recordCalls(c)
  while (stack.length) recordCalls(funcByName.get(stack.pop()))

  const isUserFunc = (name) => userFuncs ? userFuncs.has(name) : true
  for (let c = T.a[root], next; c !== NONE; c = next) {
    next = T.next[c]
    if (T.op[c] !== FUNC) continue
    const name = text(T.a[c])
    if (name !== null && !reachable.has(name) && (removeDead || !isUserFunc(name))) remove(root, c)
  }

  const isUserGlobal = (name) => userGlobals ? userGlobals.has(name.slice(1)) : !name.startsWith('$__')
  let changed = true
  while (changed) {
    changed = false
    const refd = new Set()
    walk(root, (id) => {
      const op = T.op[id]
      if (op === GLOBAL_GET || op === GLOBAL_SET) { const name = text(T.a[id]); if (name !== null) refd.add(name) }
      else if (op === EXPORT) { const target = T.next[T.a[id]]; if (target !== NONE && T.op[target] === GLOBAL) { const name = text(T.a[target]); if (name !== null) refd.add(name) } }
    })
    for (let c = T.a[root], next; c !== NONE; c = next) {
      next = T.next[c]
      if (T.op[c] !== GLOBAL) continue
      const name = text(T.a[c])
      if (name === null || refd.has(name)) continue
      let exported = false
      for (let e = T.next[T.a[c]]; e !== NONE; e = T.next[e]) if (T.op[e] === EXPORT) { exported = true; break }
      if (exported) continue
      if (removeDead || !isUserGlobal(name)) { remove(root, c); changed = true }
    }
  }
  return callCount
}
