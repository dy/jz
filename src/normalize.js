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
 *
 * `isNumber(name)`: the name holds a Number, never NaN, wherever the tree reads
 * it. `valueOf(name)`: the number a constant holds, or null. A counter is a
 * Number that is no constant.
 *
 * @module normalize
 */
import { MUTATE_OPS, noted, collectAssignedNames, isReassigned } from './ast.js'
import { constNumExpr } from './static.js'
import { ctx } from './ctx.js'

const MIRROR = new Map([['<', '>'], ['<=', '>='], ['>', '<'], ['>=', '<=']])

const isArr = Array.isArray
/** A number literal's value, or null. */
const num = (n) => isArr(n) && n.length === 2 && n[0] == null && typeof n[1] === 'number' ? n[1] : null

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
    return c.length === 3 && MIRROR.has(op) && counter(c[2]) && !counter(c[1]) && !isReassigned(c[1], c[2]) ? noted(c, [MIRROR.get(op), c[2], c[1]]) : c
  }
  return { step, test }
}

/** Rewrite `node`, a statement tree, into the one loop form. */
export function normalize(node, isNumber, valueOf = () => null) {
  const { step, test } = forms(isNumber, valueOf)
  // (a step's value unused: a postfix is its update)
  const steps = (s) => {
    if (!isArr(s) || s[0] !== ',') return step(s)
    for (let i = 1; i < s.length; i++) s[i] = step(isArr(s[i]) && s[i][0] === 'postfix' && s[i].length === 2 ? s[i][1] : s[i])
    return s
  }
  const loop = (n) => {
    const [at, body] = n[0] === 'for' ? [2, 4] : [1, 2]
    if (n[at] != null) n[at] = test(n[at])
    if (n[0] === 'for') { visit(n[1]); n[3] = steps(n[3]) }
    visit(n[at])
    n[body] = step(n[body])
    visit(n[body])
  }
  const block = (list) => {
    for (let k = 1; k < list.length; k++) {
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
