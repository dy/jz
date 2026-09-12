/**
 * The throw runtime after link: when the program declares the `$__jz_err`
 * tag but no surviving function can catch (no `try_table`, `catch` or
 * `catch_all` anywhere, which also covers jz's own `finally` lowering), every
 * `throw` becomes `unreachable` and the tag goes. An uncatchable throw is a
 * trap inside wasm, and the tag alone forces every consumer (wasmtime,
 * wasm2c, wabt) to enable the exceptions proposal just to parse the module.
 * A user `throw` keeps the runtime (the host may inspect it) unless
 * `noEhAbort` asks for the trap; the catch scan still guards that path.
 *
 * `__jz_last_err_bits` stays while referenced: a plain mutable i64, written before every
 * throw site, it is the one signal that survives the trap to the host, and
 * interop's decodeThrown reads it to name the error class. Under the raw
 * ABI (`alloc: false`) no decoder can read it, so its store becomes a `drop`
 * of the operand.
 *
 * @module link/throw-runtime
 */
import { T, NONE, intern, text, walk, node, replace, remove } from '../ir/tape.js'

export function pruneUnusedThrowRuntime(root, { throws, userThrows, noEhAbort, rawAbi }) {
  if (!throws) return
  if (userThrows && !noEhAbort) return
  const FUNC = intern('func'), TAG = intern('tag'), GLOBAL = intern('global'), EXPORT = intern('export')
  const TRY_TABLE = intern('try_table'), CATCH = intern('catch'), CATCH_ALL = intern('catch_all')
  const THROW = intern('throw'), UNREACHABLE = intern('unreachable'), GLOBAL_GET = intern('global.get'), GLOBAL_SET = intern('global.set'), DROP = intern('drop')
  let caught = false, errorRef = false
  for (let f = T.a[root]; f !== NONE; f = T.next[f])
    if (T.op[f] === FUNC) walk(f, (id) => {
      const op = T.op[id]
      if (op === TRY_TABLE || op === CATCH || op === CATCH_ALL) caught = true
      if ((op === GLOBAL_GET || op === GLOBAL_SET) && text(T.a[id]) === '$__jz_last_err_bits') errorRef = true
    })
  // An exported signal is normally a reachability root. Compiler-generated
  // guards that all disappeared have no signal to expose; source throws keep it.
  if (!errorRef && !userThrows) for (let c = T.a[root], next; c !== NONE; c = next) {
    next = T.next[c]
    if ((T.op[c] === GLOBAL && text(T.a[c]) === '$__jz_last_err_bits') ||
        (T.op[c] === EXPORT && text(T.a[c]) === '"__jz_last_err_bits"')) remove(root, c)
  }
  if (caught) return
  for (let f = T.a[root]; f !== NONE; f = T.next[f]) {
    if (T.op[f] !== FUNC) continue
    walk(f, (id, parent) => {
      const op = T.op[id]
      if (op === THROW) { replace(parent, id, node(UNREACHABLE)); return false }
      if (rawAbi && op === GLOBAL_SET && text(T.a[id]) === '$__jz_last_err_bits') { T.op[id] = DROP; T.a[id] = T.next[T.a[id]] }
    })
  }
  for (let c = T.a[root], next; c !== NONE; c = next) {
    next = T.next[c]
    if (T.op[c] === TAG && text(T.a[c]) === '$__jz_err') remove(root, c)
  }
}
