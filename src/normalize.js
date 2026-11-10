/**
 * One loop form ahead of every reader of a loop.
 *
 * The readers (the summary, the plan, the emitter, the vectorizer) take a
 * counted loop by its written shape, so the same loop written another way
 * fell off them. This rewrites a prepared statement tree in place so that a
 * counted loop reaches them as
 *
 *   for (init; i < bound; ++i) body       `<=`, `>`, `>=`; `--i`, `i += K`, `i -= K`
 *
 * Each rewrite keeps the value, the order of evaluation and what is called:
 *
 *   - A step of a Number, as a statement or a `for` step: `i += 1`, `i = i + 1`,
 *     `i = 1 + i`, `i -= -1`, `i = i - -1` is `++i`; by minus one `--i`; by any
 *     other K, `i += K` or `i -= K` with K above zero. `(i + 1) | 0` wraps: it is
 *     another step.
 *   - A loop test with a counter on the right and none on the left is mirrored:
 *     `n > i` is `i < n`. Converting a Number calls nothing, so the order of the
 *     two conversions cannot be seen.
 *   - `while (true) { if (c) break; B }` is `while (!c) B`, `for (;;)` alike.
 *   - `!(a >= b)` is `a < b` where neither side can be NaN (`3 >= NaN` is false).
 *   - A do-while, which prepare lowered to `let F = true; while (F || c) {
 *     F = false; B }`, is `while (c) B` where its test holds on entry: as the
 *     whole of `if (c)`, the same test, or over the literals the statement
 *     before it declares and the constants.
 *
 * `isNumber(name)`: the name holds a Number, never NaN, wherever the tree reads
 * it. `valueOf(name)`: the number a constant holds, or null. A counter is a
 * Number that is no constant.
 *
 * @module normalize
 */
import { MUTATE_OPS, RELATIONAL_OPS, EQUALITY_OPS, REFS_THROUGH_ARROWS, noted, collectAssignedNames, isReassigned, refsName } from './ast.js'
import { constNumExpr } from './static.js'
import { ctx } from './ctx.js'

const MIRROR = new Map([['<', '>'], ['<=', '>='], ['>', '<'], ['>=', '<=']])
// A do-while's flag as its lowering names it: jzify's (jzify/names.js `doFlag`) or strict prepare's (`'do'`).
const DO_FLAG = /^[\uE000\uE002]do\d/
const NEGATE = new Map([['<', '>='], ['<=', '>'], ['>', '<='], ['>=', '<']])

const isArr = Array.isArray
/** A number literal's value, or null. */
const num = (n) => isArr(n) && n.length === 2 && n[0] == null && typeof n[1] === 'number' ? n[1] : null
/** A literal's truth, or null. */
const truth = (n) => !isArr(n) ? null : n[0] === 'bool' ? (typeof n[1] === 'number' ? !!n[1] : null)
  : n.length === 2 && n[0] == null ? !!n[1] : null
const mentions = (n, x) => refsName(n, x, REFS_THROUGH_ARROWS)
const hasArrow = (n) => isArr(n) && (n[0] === '=>' || n.some((c, i) => i > 0 && hasArrow(c)))
const same = (a, b) => {
  if (!isArr(a) || !isArr(b)) return Object.is(a, b)
  if (a.length !== b.length || (a[0] == null) !== (b[0] == null)) return false
  for (let i = a[0] == null ? 1 : 0; i < a.length; i++) if (!same(a[i], b[i])) return false
  return true
}
/** The one statement a `{}` or a one-statement `;` holds, or the statement. */
const only = (s) => {
  while (isArr(s) && s.length === 2 && (s[0] === '{}' || s[0] === ';')) s = s[1]
  return s
}

/** A write that leaves a Number a Number: `x++`, `x += K`, `x = K`, `x = x ± K`, `x = K + x`,
 *  each K finite by `fin`. */
const numericWrite = (n, fin) => {
  const [op, x, v] = n
  if (op === '++' || op === '--') return n.length === 2
  if (op === '+=' || op === '-=') return fin(v)
  if (op !== '=') return false
  if (fin(v)) return true
  return isArr(v) && v.length === 3 && (v[0] === '+' && (v[1] === x && fin(v[2]) || v[2] === x && fin(v[1])) ||
    v[0] === '-' && v[1] === x && fin(v[2]))
}

/** The names a function body holds Numbers in by its syntax alone, each declared
 *  once from a finite number (a literal, a constant of `outer`) and written only
 *  with finite numbers (those and its own constants) and steps of itself by them,
 *  every write in the function that declares it: never NaN. A name it never
 *  writes is a constant. `outer(name)`: the finite number a constant around the
 *  body holds, or null. → { isNumber, valueOf } */
export function numberNames(body, outer = () => null) {
  const home = new Map(), init = new Map(), bad = new Set(), written = new Set(), steps = []
  const given = (v) => { const k = num(v) ?? (typeof v === 'string' ? outer(v) : null); return k != null && Number.isFinite(k) ? k : null }
  const walk = (n, fn) => {
    if (!isArr(n)) return
    if (n[0] === '=>') fn = n
    if (n[0] === 'let' || n[0] === 'const') {
      for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (typeof d === 'string') { bad.add(d); continue }
        if (!isArr(d) || d[0] !== '=' || typeof d[1] !== 'string') { walk(d, fn); continue }
        const v = given(d[2])
        if (home.has(d[1]) || v == null) bad.add(d[1])
        else { home.set(d[1], fn); init.set(d[1], v) }
        walk(d[2], fn)
      }
      return
    }
    if (MUTATE_OPS.has(n[0]) && typeof n[1] === 'string') steps.push([n, fn])
    for (let i = 1; i < n.length; i++) walk(n[i], fn)
  }
  walk(body, null)
  for (const [n] of steps) written.add(n[1])
  const constant = (x) => home.has(x) && !bad.has(x) && !written.has(x)
  const fin = (v) => given(v) != null || typeof v === 'string' && constant(v)
  for (const [n, fn] of steps) if (home.get(n[1]) !== fn || !numericWrite(n, fin)) bad.add(n[1])
  const isNumber = (x) => home.has(x) && !bad.has(x)
  return { isNumber, valueOf: (x) => constant(x) ? init.get(x) : null }
}

/** The step and the test in the one form, over the Numbers `isNumber` names and the constants `valueOf` holds. */
const forms = (isNumber, valueOf) => {
  const value = (n) => num(n) ?? (typeof n === 'string' ? valueOf(n) : null)
  const counter = (n) => typeof n === 'string' && isNumber(n) && valueOf(n) == null
  const notNaN = (n) => typeof n === 'string' && isNumber(n) || value(n) != null && !Number.isNaN(value(n))

  /** The amount a statement steps a name by, else null. */
  const stepBy = (s) => {
    if (!isArr(s) || s.length !== 3 || typeof s[1] !== 'string') return null
    const [op, x, v] = s
    if (op === '+=') return value(v)
    if (op === '-=') { const k = value(v); return k == null ? null : -k }
    if (op !== '=' || !isArr(v) || v.length !== 3) return null
    if (v[0] === '+') return v[1] === x ? value(v[2]) : v[2] === x ? value(v[1]) : null
    if (v[0] === '-' && v[1] === x) { const k = value(v[2]); return k == null ? null : -k }
    return null
  }
  const step = (s) => {
    const k = stepBy(s)
    if (k == null || k === 0 || !Number.isFinite(k) || !isNumber(s[1])) return s
    const x = s[1]
    if (k === 1 || k === -1) return noted(s, [k > 0 ? '++' : '--', x])
    if (s[0] === (k > 0 ? '+=' : '-=') && num(s[2]) === Math.abs(k)) return s
    return noted(s, [k > 0 ? '+=' : '-=', x, [null, Math.abs(k)]])
  }
  const test = (c) => {
    if (!isArr(c)) return c
    const op = c[0]
    if ((op === '&&' || op === '||') && c.length === 3) { c[1] = test(c[1]); c[2] = test(c[2]); return c }
    if (op === '!' && c.length === 2) {
      const x = c[1]
      return isArr(x) && x.length === 3 && NEGATE.has(x[0]) && notNaN(x[1]) && notNaN(x[2]) ? test(noted(c, [NEGATE.get(x[0]), x[1], x[2]])) : c
    }
    return c.length === 3 && MIRROR.has(op) && counter(c[2]) && !counter(c[1]) && !isReassigned(c[1], c[2]) ? noted(c, [MIRROR.get(op), c[2], c[1]]) : c
  }
  return { step, test }
}

/** A test in the one form where `isNumber` holds its names Numbers, never NaN:
 *  the second caller's, a versioned copy whose guard holds them so
 *  (plan/integral-loops.js). Rewrites `c` in place where it can. */
export const normalTest = (c, isNumber, valueOf = () => null) => forms(isNumber, valueOf).test(c)

/** Rewrite `node`, a statement tree, into the one loop form. */
export function normalize(node, isNumber, valueOf = () => null) {
  const { step, test } = forms(isNumber, valueOf)
  // (a step's value unused: a postfix is its update)
  const steps = (s) => {
    if (!isArr(s) || s[0] !== ',') return step(s)
    for (let i = 1; i < s.length; i++) s[i] = step(isArr(s[i]) && s[i][0] === 'postfix' && s[i].length === 2 ? s[i][1] : s[i])
    return s
  }
  // (in a test: `!!c` is c)
  const not = (c) => isArr(c) && c[0] === '!' && c.length === 2 ? c[1] : ['!', c]

  /** The test of a leading `if (c) break` of a body, the statement taken out of it; else null. */
  const leadingBreak = (body) => {
    const list = isArr(body) && body[0] === '{}' ? body[1] : body
    if (!isArr(list) || list[0] !== ';' || list.length < 2) return null
    const s = list[1], b = isArr(s) && s[0] === 'if' && s.length === 3 ? only(s[2]) : null
    if (!isArr(b) || b[0] !== 'break' || b.length !== 1) return null
    list.splice(1, 1)
    return s[1]
  }
  const loop = (n) => {
    const [at, body] = n[0] === 'for' ? [2, 4] : [1, 2]
    if (n[at] == null || truth(n[at]) === true) { const c = leadingBreak(n[body]); if (c) n[at] = not(c) }
    if (n[at] != null) n[at] = test(n[at])
    if (n[0] === 'for') { visit(n[1]); n[3] = steps(n[3]) }
    visit(n[at])
    n[body] = step(n[body])
    visit(n[body])
  }

  /** prepare's lowered do-while, `let F = true` then `while (F || c) { F = false; B }`
   *  → { c, body: B }, else null. F is the flag the lowering minted: one the source
   *  wrote itself may be read after its loop. */
  const doLoop = (decl, w) => {
    const d = isArr(decl) && decl[0] === 'let' && decl.length === 2 ? decl[1] : null
    if (!isArr(d) || d[0] !== '=' || typeof d[1] !== 'string' || !DO_FLAG.test(d[1]) || truth(d[2]) !== true) return null
    const F = d[1], t = isArr(w) && w[0] === 'while' && w.length === 3 ? w[1] : null
    if (!isArr(t) || t[0] !== '||' || t.length !== 3 || t[1] !== F) return null
    const list = isArr(w[2]) && w[2][0] === '{}' ? w[2][1] : w[2], s = isArr(list) && list[0] === ';' ? list[1] : null
    if (!isArr(s) || s[0] !== '=' || s[1] !== F || truth(s[2]) !== false) return null
    const rest = list.slice(2)
    if (mentions(t[2], F) || rest.some(r => mentions(r, F))) return null
    return { c: t[2], body: rest.length === 1 ? rest[0] : [';', ...rest] }
  }
  /** The do-while a statement is the whole of, `[';', let F, while]`, else null. */
  const doOf = (s) => { s = only(s); return isArr(s) && s[0] === ';' && s.length === 3 ? doLoop(s[1], s[2]) : null }
  /** The test holds over the literals `prev` declares and the constants. */
  const holds = (c, prev) => {
    if (!isArr(c) || c.length !== 3 || !(RELATIONAL_OPS.has(c[0]) || EQUALITY_OPS.has(c[0]))) return false
    // (a name holds its literal on entry where every declaration after it in the statement
    // is of a literal too: another value may write the name on its way, `j = (i = v, 0)`)
    const lits = new Map()
    if (isArr(prev) && (prev[0] === 'let' || prev[0] === 'const'))
      for (let i = prev.length - 1; i >= 1; i--) {
        const d = prev[i]
        if (!isArr(d) || d[0] !== '=' || typeof d[1] !== 'string' || num(d[2]) == null) break
        lits.set(d[1], num(d[2]))
      }
    const at = (x) => lits.has(x) ? lits.get(x) : valueOf(x)
    const a = constNumExpr(c[1], at), b = constNumExpr(c[2], at), op = c[0]
    if (a == null || b == null) return false
    return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : op === '>=' ? a >= b
      : op === '===' || op === '==' ? a === b : a !== b
  }
  const block = (list) => {
    for (let k = 1; k < list.length; k++) {
      const s = list[k], prev = k > 1 ? list[k - 1] : null
      // (its two statements in the list, or a statement of them alone, strict prepare's, or a label's)
      const d = doLoop(s, list[k + 1]), [p, i] = isArr(s) && s[0] === 'label' ? [s, 2] : [list, k], l = d ? null : doOf(p[i])
      if (d && holds(d.c, prev)) list.splice(k, 2, ['while', d.c, d.body])
      else if (l && holds(l.c, prev)) p[i] = ['while', l.c, l.body]
      else if (isArr(s) && s[0] === 'if' && s.length === 3 && !hasArrow(s[1])) {
        const g = doOf(s[2])
        if (g && same(g.c, s[1])) list[k] = noted(s, ['while', g.c, g.body])
      }
      list[k] = step(list[k])
      visit(list[k])
    }
  }

  const visit = (n) => {
    if (!isArr(n)) return
    const op = n[0]
    if (op === ';') return block(n)
    if (op === 'while' && n.length === 3 || op === 'for' && n.length === 5) return loop(n)
    if (op === 'if') { n[2] = step(n[2]); if (n.length > 3) n[3] = step(n[3]) }
    else if (op === '{}' || op === 'label') n[n.length - 1] = step(n[n.length - 1])
    for (let i = 1; i < n.length; i++) visit(n[i])
  }
  visit(node)
  return node
}

/** The front end's normalization: every function body and module init, before
 *  anything reads a loop. Kinds are unknown here, so a Number is one by syntax
 *  (`numberNames`), and a module's constant one declared `const` from a literal. */
export function normalizeProgram(ast) {
  const inits = [';', ast, ...(ctx.module.moduleInits ?? [])], consts = moduleConstants(inits)
  const constOf = (x) => consts.get(x) ?? null, isConst = (x) => consts.has(x)
  const written = new Set()
  for (const f of ctx.funcs.list) {
    if (f.raw || !isArr(f.body)) continue
    collectAssignedNames(f.body, written)
    const { isNumber, valueOf } = numberNames(f.body, constOf)
    normalize(f.body, x => isNumber(x) || isConst(x), x => valueOf(x) ?? constOf(x))
  }
  // (a module's name any function writes, or the host, is no Number by the module's syntax)
  const { isNumber, valueOf } = numberNames(inits, constOf)
  const own = (x) => isNumber(x) && !written.has(x) && ctx.funcs.exports?.[x] == null
  normalize(inits, x => own(x) || isConst(x), x => (own(x) ? valueOf(x) : null) ?? constOf(x))
}

/** A module's constants: the names its statements declare `const` from finite
 *  numbers, literals and the constants before them, each declared once. */
const moduleConstants = (inits) => {
  const out = new Map(), seen = new Set()
  const each = (s) => {
    if (!isArr(s)) return
    if (s[0] === ';') { for (let i = 1; i < s.length; i++) each(s[i]); return }
    if (s[0] !== 'const' && s[0] !== 'let') return
    for (let i = 1; i < s.length; i++) {
      const d = s[i], x = isArr(d) && d[0] === '=' ? d[1] : d
      if (typeof x !== 'string') continue
      const v = s[0] === 'const' && !seen.has(x) && isArr(d) ? constNumExpr(d[2], y => out.get(y) ?? null) : null
      if (v != null && Number.isFinite(v)) out.set(x, v)
      else out.delete(x)
      seen.add(x)
    }
  }
  each(inits)
  return out
}
