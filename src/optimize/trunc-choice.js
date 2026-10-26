/**
 * A choice of a float's ceiling below zero and its floor above is its
 * truncation: `x < 0 ? Math.ceil(x) : Math.floor(x)`, the way a library
 * writes `trunc` (stdlib's `@stdlib/math/base/special/trunc`, spliced into
 * every caller), is `f64.trunc(x)`, one rounding where the choice computed
 * both and picked. Every value agrees: -0 is no less than 0 and floors to
 * -0, a fraction above -1 ceils to -0, NaN floors to NaN. The test may be
 * `x <= 0` (0 ceils to 0) and its arms either way round (`x > 0 ? floor :
 * ceil`, `x >= 0 ? floor : ceil`), as a `select` or an `if` of values.
 *
 * @module optimize/trunc-choice
 */

const isArr = Array.isArray
const zero = (n) => isArr(n) && (n[0] === 'f64.const' || n[0] === 'f32.const') && Number(n[1]) === 0
// the local a node reads (a get, or a tee that sets it)
const readOf = (n) => isArr(n) && (n[0] === 'local.get' || n[0] === 'local.tee') && typeof n[1] === 'string' ? n[1] : null
// `test` compares the local with 0: below (`lt`/`le`) or above (`gt`/`ge`), else null
const side = (test, t) => {
  if (!isArr(test) || test.length !== 3 || typeof test[0] !== 'string' || !zero(test[2])) return null
  const op = test[0]
  if (op === `${t}.lt` || op === `${t}.le`) return 'below'
  if (op === `${t}.gt` || op === `${t}.ge`) return 'above'
  return null
}

/** The truncation a choice between `a` (the test holds) and `b` makes, or null. */
const truncOf = (a, b, test) => {
  if (!isArr(a) || !isArr(b) || a.length !== 2 || b.length !== 2 || typeof a[0] !== 'string' || typeof b[0] !== 'string') return null
  const t = a[0].slice(0, 3)
  if ((t !== 'f64' && t !== 'f32') || b[0].slice(0, 3) !== t) return null
  const s = side(test, t)
  if (!s) return null
  const [low, high] = s === 'below' ? [a, b] : [b, a]
  if (low[0] !== `${t}.ceil` || high[0] !== `${t}.floor`) return null
  // one value, read first where it is set: the test's read and the other arm's are gets of it
  const x = readOf(test[1]), ca = readOf(a[1]), cb = readOf(b[1])
  if (!x || ca !== x || cb !== x) return null
  // the first evaluated of the three (the `select`'s first arm, an `if`'s test) keeps any tee
  return { t, x }
}

/** Rewrite the truncations written as choices in every function of `ast` (a module). */
export function truncChoice(ast) {
  if (!isArr(ast)) return ast
  const visit = (n) => {
    for (let i = 1; i < n.length; i++) {
      const c = n[i]
      if (!isArr(c)) continue
      visit(c)
      // (select A B test): A first, so a tee in A sets the local the others read
      if (c[0] === 'select' && c.length === 4) {
        const r = truncOf(c[1], c[2], c[3])
        if (r && readOf(c[2][1]) && c[2][1][0] === 'local.get' && c[3][1][0] === 'local.get') n[i] = [`${r.t}.trunc`, c[1][1]]
      } else if (c[0] === 'if' && c.length === 5 && isArr(c[1]) && c[1][0] === 'result' && isArr(c[3]) && c[3][0] === 'then' && isArr(c[4]) && c[4][0] === 'else' && c[3].length === 2 && c[4].length === 2) {
        // (if (result t) test (then A) (else B)): the test first, a tee there sets the local
        const r = truncOf(c[3][1], c[4][1], c[2])
        if (r && c[3][1][1][0] === 'local.get' && c[4][1][1][0] === 'local.get') n[i] = [`${r.t}.trunc`, c[2][1]]
      }
    }
  }
  for (const fn of ast) if (isArr(fn) && fn[0] === 'func') visit(fn)
  return ast
}
