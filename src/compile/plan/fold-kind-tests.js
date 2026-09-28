/**
 * A test the summary decides takes one arm on every run. The summary holds
 * each binding to the kinds all its values have; `x instanceof Float32Array`
 * of a binding every value of which is a Float32Array is true, of one that
 * holds no typed array false, and so is `Array.isArray(x)` of the same. The
 * arm the test never takes is dead: it compiles to nothing, and the values it
 * would pass on join nothing (an overloaded parameter, a buffer from one
 * caller and an options object from another, keeps the options' shape where
 * only the buffer's path runs).
 *
 * Decided: `instanceof` of a typed-array class, Array, Map, Set or
 * ArrayBuffer, and `Array.isArray`, of a name (reading it has no effect to
 * keep), under `!`, `&&` and `||`; in an `if` and a `?:`. A kind that may be
 * missing leaves `instanceof` open unless every other value decides it false.
 *
 * @module compile/plan/fold-kind-tests
 */
import { ctx } from '../../ctx.js'
import { K, tagOf, core, hasTag, isNullable, typedAux, UNKNOWN } from '../../summary/kind.js'
import { ctorFromElemAux } from '../../../layout.js'
import { typedCtorName } from '../../typed-provenance.js'

const isArr = Array.isArray
const TYPED_CLASSES = new Set(['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'])
const CLASS_TAG = new Map([['Array', K.ARRAY], ['Map', K.MAP], ['Set', K.SET], ['ArrayBuffer', K.BUFFER]])

/** Grouping parentheses `(x)` are a one-child call node. */
const unparen = (n) => { while (isArr(n) && n[0] === '()' && n.length === 2) n = n[1]; return n }

/** Whether every value of `name` is an instance of `cls` (true), none is (false), or either (null). */
const instanceOf = (view, name, cls) => {
  const k = view.kindOf(name)
  if (k === K.NONE) return null
  if (TYPED_CLASSES.has(cls)) {
    if (!hasTag(k, K.TYPED)) return false
    const aux = typedAux(k)
    if (isNullable(k) || tagOf(core(k)) !== K.TYPED || aux === UNKNOWN) return null
    const own = typedCtorName(ctorFromElemAux(aux))
    return own == null ? null : own === cls
  }
  const tag = CLASS_TAG.get(cls)
  if (tag == null) return null
  if (!hasTag(k, tag)) return false
  return !isNullable(k) && tagOf(core(k)) === tag ? true : null
}

/** The truth of a test on every run, or null. */
const truth = (view, n) => {
  n = unparen(n)
  if (!isArr(n)) return null
  const op = n[0]
  if (op === '!') { const t = truth(view, n[1]); return t == null ? null : !t }
  // decided by the first operand, or by the second where the first is decided
  // too: an open first operand still runs, and folding would drop it
  if (op === '&&' || op === '||') {
    const a = truth(view, n[1])
    return a == null ? null : a === (op === '||') ? a : truth(view, n[2])
  }
  if (op === 'instanceof' && typeof n[1] === 'string' && typeof n[2] === 'string') return instanceOf(view, n[1], n[2])
  if (op === '()' && n.length === 3 && typeof n[2] === 'string' &&
      (n[1] === 'Array.isArray' || isArr(n[1]) && n[1][0] === '.' && n[1][1] === 'Array' && n[1][2] === 'isArray'))
    return instanceOf(view, n[2], 'Array')
  return null
}

/** Fold every decided `if` and `?:` in the program's functions. Returns whether any folded. */
export const foldKindTests = () => {
  let changed = false
  const walk = (n, view) => {
    if (!isArr(n)) return
    if (n[0] === '=>') { walk(n[2], ctx.summary.at(n[1])); return }
    for (let j = 1; j < n.length; j++) {
      const c = n[j]
      if (!isArr(c)) continue
      if (c[0] === 'if' || c[0] === '?:' || c[0] === '?') {
        const t = truth(view, c[1])
        if (t != null) {
          // the arm taken, or an empty statement (`null`) for an `if` with none
          n[j] = (t ? c[2] : c[3]) ?? null
          changed = true
          j--
          continue
        }
      }
      walk(c, view)
    }
  }
  for (const f of ctx.funcs.list) if (f.body && !f.raw) walk(f.body, ctx.summary.at(f.sig))
  return changed
}
