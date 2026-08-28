import { walkAst } from '../../ast.js'

export const isArr = n => Array.isArray(n)   // wrap, not alias: jz self-compile rejects a builtin used as a first-class value

export const forEachLocalDef = (roots, visit) => {
  const enter = n => {
    if (isArr(n) && (n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string')
      visit(n[1], n[2], n)
  }
  for (const root of roots) walkAst(root, { enter })
}

// Structural node equality — must be non-finite- AND bigint-safe: plain
// JSON.stringify maps Infinity/-Infinity/NaN→null and -0→0, so it would equate a
// `[Inf,-Inf]` lane pair and splat it (dropping -Inf). nodeEqual tags those.
export const localGetName = n => isArr(n) && n[0] === 'local.get' && typeof n[1] === 'string' ? n[1] : null
export const f64Zero = n => isArr(n) && n[0] === 'f64.const' && Number(n[1]) === 0

// jz wraps every NaN-producing float builtin (Math.sqrt/min/max/…) in a
// canonicalizing select so a non-canonical NaN never crosses to JS:
//   (select C X (T.ne X X))   — "use C where X is NaN, else X".
// The condition `X != X` is true iff X is NaN, so this shape is unambiguously
// the canonicalization idiom. C is the canonical-NaN value, materialized either
// inline (T.const) or hoisted into a const-pool global (global.get $__fcN) when
// reused. We splat C verbatim — faithful regardless of what C holds — so the
// recognizer never needs to resolve the global's value.
export const isSplatConst = (n, constOp) =>
  isArr(n) && (n[0] === constOp || n[0] === 'global.get')

// Match `(select C X (T.ne X X))`. Returns { val: X, C } or null.
