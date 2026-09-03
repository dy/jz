/**
 * Whole-module f64 constant pooling, on the tape.
 *
 * `f64.const` is 9 bytes; `global.get` with an index under 128 is 2 bytes, so
 * a value used N ≥ 2 times pools into a global (11 bytes of declaration
 * against 7 bytes saved per reuse). Pool entries sort by use count, hottest
 * first, so the hottest get the 1-byte indices; equal counts keep module
 * order. A value is keyed by its exact 64 bits (a Float64Array/Uint32Array
 * union): `String(number)` keeps ~9 digits in the self-compiled kernel and
 * would both lose precision and merge distinct values, and a Map key would
 * merge every NaN payload and -0 with +0. The number itself is emitted, so
 * the global's initializer is the exact literal.
 *
 * Soundness: a `global.get` of an immutable-by-use global reads the same
 * bits the literal carried; only bodies of `func` nodes are rewritten, never
 * a global initializer or a data segment.
 *
 * @module optimize/const-pool
 */
import { T, NONE, OP_NUM, OP_STR, intern, node, str, num, push, replace, insertAfter, walk } from '../ir/tape.js'

const _FCB = new Float64Array(1), _FCBu = new Uint32Array(_FCB.buffer)
const f64BitsKey = (n) => { _FCB[0] = n; return `n:${_FCBu[0]}:${_FCBu[1]}` }

const MIN_USES = 2

/** Pool repeated `f64.const` literals of the module at `root` into globals. */
export function hoistConstantPool(root) {
  const F64_CONST = intern('f64.const'), FUNC = intern('func'), GLOBAL = intern('global')
  const counts = new Map()   // key → uses
  const first = new Map()    // key → the literal atom of the first site
  const sites = []           // parent, node, key per site, flat
  for (let f = T.a[root]; f !== NONE; f = T.next[f]) {
    if (T.op[f] !== FUNC) continue
    walk(f, (id, parent) => {
      if (T.op[id] !== F64_CONST) return
      const lit = T.a[id]
      if (lit === NONE) return
      const key = T.op[lit] === OP_NUM ? f64BitsKey(T.imm[lit]) : T.op[lit] === OP_STR ? `s:${T.syms[T.sym[lit]]}` : null
      if (key === null) return
      counts.set(key, (counts.get(key) || 0) + 1)
      if (!first.has(key)) first.set(key, lit)
      sites.push(parent, id, key)
    })
  }
  const pooled = [...counts].filter(([, n]) => n >= MIN_USES).sort((a, b) => b[1] - a[1])
  if (!pooled.length) return

  // Declarations go after the last global, before the first function.
  let at = NONE, prev = NONE
  for (let c = T.a[root]; c !== NONE; c = T.next[c]) {
    if (T.op[c] === GLOBAL) at = c
    else if (T.op[c] === FUNC) break
    if (at === NONE) prev = c
  }
  if (at === NONE) at = prev
  const names = new Map()
  for (const [key] of pooled) {
    const name = `$__fc${names.size}`
    names.set(key, name)
    const g = node(GLOBAL)
    push(g, str(name))
    push(push(g, node(intern('mut'))), str('f64'))
    const lit = first.get(key)
    push(push(g, node(F64_CONST)), T.op[lit] === OP_NUM ? num(T.imm[lit]) : str(T.syms[T.sym[lit]]))
    insertAfter(root, at, g)
    at = g
  }
  const GLOBAL_GET = intern('global.get')
  for (let i = 0; i < sites.length; i += 3) {
    const name = names.get(sites[i + 2])
    if (name === undefined) continue
    const get = node(GLOBAL_GET)
    push(get, str(name))
    replace(sites[i], sites[i + 1], get)
  }
}
