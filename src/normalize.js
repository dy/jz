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
 *     other K, `i += K` or `i -= K` with K above zero; by a value no constant
 *     holds, `i = i + v` is `i += v` and `i = i - v` is `i -= v`, and `i = v + i`
 *     is `i += v` where v is a Number too. `(i + 1) | 0` wraps: it is another step.
 *   - A loop test with a counter on the right and none on the left is mirrored:
 *     `n > i` is `i < n`. Converting a Number calls nothing, so the order of the
 *     two conversions cannot be seen.
 *   - `while (true) { if (c) break; B }` is `while (!c) B`, `for (;;)` alike.
 *   - `!(a >= b)` is `a < b` where neither side can be NaN (`3 >= NaN` is false).
 *   - A `for` counting an integer up by one, declared by the loop from an integer
 *     literal, tested against a constant B: `i <= B` is `i < floor(B) + 1`, and
 *     `i !== B` is `i < B` where B is an integer at or above the start.
 *   - `do B while (c)` is lowered here, the one place: `while (c) B` where its
 *     test holds on entry (as the whole of `if (c)`, the same test, or over the
 *     literals the statement before it declares and the constants), else
 *     `let F = true; while (F || c) { F = false; B }`.
 *
 * `isNumber(name)`: the name holds a Number wherever the tree reads it; `isReal`,
 * never NaN either. `valueOf(name)`: the number a constant holds, or null. A
 * counter is a Number the tree writes that is no constant. It runs twice
 * (`normalizeProgram`): before the summary, a Number one by syntax, then once
 * kinds are known, a local the summary holds a Number too.
 *
 * @module normalize
 */
import { MUTATE_OPS, RELATIONAL_OPS, EQUALITY_OPS, REFS_THROUGH_ARROWS, T, noted, collectAssignedNames, collectParamName, extractParams, isReassigned, refsName } from './ast.js'
import { constNumExpr } from './static.js'
import { ctx } from './ctx.js'
import { K, tagOf, NULL_BITS } from './summary/kind.js'

const MIRROR = new Map([['<', '>'], ['<=', '>='], ['>', '<'], ['>=', '<=']])
const NEGATE = new Map([['<', '>='], ['<=', '>'], ['>', '<='], ['>=', '<']])
// (the do-whiles' flags, apart in a program; and the rewrites made, which tell the
// second call whether a tree changed)
let doFlags = 0, rewrites = 0
const note = (from, to) => { rewrites++; return noted(from, to) }

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
 *  body holds, or null. `homeOf(name)`: the arrow declaring a local no other arrow
 *  writes (null: the body's own function, whose parameters are `params`), else
 *  undefined; a local an arrow writes is a cell a call may write (.work/architecture.md 3c).
 *  → { isNumber, valueOf, homeOf } */
export function numberNames(body, outer = () => null, params = []) {
  const home = new Map(), decl = new Map(params.map(p => [p, null])), init = new Map(), bad = new Set(), written = new Set(), steps = []
  const given = (v) => { const k = num(v) ?? (typeof v === 'string' ? outer(v) : null); return k != null && Number.isFinite(k) ? k : null }
  const walk = (n, fn) => {
    if (!isArr(n)) return
    if (n[0] === '=>') { fn = n; const ps = new Set(); for (const p of extractParams(n[1])) collectParamName(p, ps); for (const p of ps) decl.set(p, n) }
    if (n[0] === 'let' || n[0] === 'const') {
      for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (typeof d === 'string') { bad.add(d); decl.set(d, fn); continue }
        if (!isArr(d) || d[0] !== '=' || typeof d[1] !== 'string') { walk(d, fn); continue }
        const v = given(d[2])
        decl.set(d[1], fn)
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
  for (const [n, fn] of steps) { written.add(n[1]); if (decl.get(n[1]) !== fn) decl.delete(n[1]) }
  const constant = (x) => home.has(x) && !bad.has(x) && !written.has(x)
  const fin = (v) => given(v) != null || typeof v === 'string' && constant(v)
  for (const [n, fn] of steps) if (home.get(n[1]) !== fn || !numericWrite(n, fin)) bad.add(n[1])
  const isNumber = (x) => home.has(x) && !bad.has(x)
  return { isNumber, valueOf: (x) => constant(x) ? init.get(x) : null, homeOf: (x) => decl.get(x) }
}

/** The step and the test in the one form, over the Numbers `isNumber` names (`isReal`
 *  those never NaN) and the constants `valueOf` holds; a counter is one of them the
 *  tree writes (`written`, where given: a parameter no write moves is no counter). */
const forms = (isNumber, valueOf, isReal = isNumber, written = null) => {
  const value = (n) => num(n) ?? (typeof n === 'string' ? valueOf(n) : null)
  const counter = (n) => typeof n === 'string' && isNumber(n) && valueOf(n) == null && (!written || written.has(n))
  const notNaN = (n) => typeof n === 'string' && isReal(n) || value(n) != null && !Number.isNaN(value(n))

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
    if (!isArr(s) || s.length !== 3 || typeof s[1] !== 'string' || !isNumber(s[1])) return s
    const [op, x, v] = s, k = stepBy(s)
    if (k == null) {
      // (by a value no constant holds: `x + v` adds as `x += v` does, whatever v is; `v + x` only where v is a Number)
      if (op !== '=' || !isArr(v) || v.length !== 3 || (v[0] !== '+' && v[0] !== '-')) return s
      if (v[1] === x) return note(s, [v[0] + '=', x, v[2]])
      return v[0] === '+' && v[2] === x && typeof v[1] === 'string' && isNumber(v[1]) ? note(s, ['+=', x, v[1]]) : s
    }
    if (k === 0 || !Number.isFinite(k)) return s
    if (k === 1 || k === -1) return note(s, [k > 0 ? '++' : '--', x])
    if (op === (k > 0 ? '+=' : '-=') && num(v) === Math.abs(k)) return s
    return note(s, [k > 0 ? '+=' : '-=', x, [null, Math.abs(k)]])
  }
  const test = (c) => {
    if (!isArr(c)) return c
    const op = c[0]
    if ((op === '&&' || op === '||') && c.length === 3) { c[1] = test(c[1]); c[2] = test(c[2]); return c }
    if (op === '!' && c.length === 2) {
      const x = c[1]
      return isArr(x) && x.length === 3 && NEGATE.has(x[0]) && notNaN(x[1]) && notNaN(x[2]) ? test(note(c, [NEGATE.get(x[0]), x[1], x[2]])) : c
    }
    return c.length === 3 && MIRROR.has(op) && counter(c[2]) && !counter(c[1]) && !isReassigned(c[1], c[2]) ? note(c, [MIRROR.get(op), c[2], c[1]]) : c
  }
  return { step, test }
}

/** A test in the one form where `isNumber` holds its names Numbers, never NaN:
 *  a versioned copy whose guard holds them so (plan/integral-loops.js).
 *  Rewrites `c` in place where it can. */
export const normalTest = (c, isNumber, valueOf = () => null) => forms(isNumber, valueOf).test(c)

/** Rewrite `node`, a statement tree, into the one loop form. */
export function normalize(node, isNumber, valueOf = () => null, isReal = isNumber) {
  const { step, test } = forms(isNumber, valueOf, isReal, collectAssignedNames(node, new Set()))
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
    rewrites++
    return s[1]
  }
  /** A `for` counting an integer up by one toward a constant: its test as `i < B`.
   *  The counter is declared by the loop from an integer literal and written by
   *  its step alone, so it is an integer: `i <= B` is `i < floor(B) + 1`, and
   *  `i !== B` stops where `i < B` does where B is an integer at or above the start. */
  const counted = (n) => {
    const [, init, c, s, body] = n
    if (!isArr(c) || c.length !== 3 || typeof c[1] !== 'string' || !(c[0] === '<=' || c[0] === '!==' || c[0] === '!=')) return
    const i = c[1], d = isArr(init) && init[0] === 'let' ? init.slice(1).find(d => isArr(d) && d[0] === '=' && d[1] === i) : null
    const start = d ? num(d[2]) : null, B = constNumExpr(c[2], valueOf)
    if (!Number.isInteger(start) || B == null || !Number.isFinite(B) || Math.abs(B) >= 2 ** 52 ||
        !isArr(s) || s[0] !== '++' || s[1] !== i || isReassigned(body, i) || isReassigned(c[2], i) ||
        init.some(e => isArr(e) && e[0] === '=' && e[1] !== i && mentions(e[2], i))) return
    if (c[0] === '<=') n[2] = note(c, ['<', i, [null, Math.floor(B) + 1]])
    else if (Number.isInteger(B) && start <= B) n[2] = note(c, ['<', i, c[2]])
  }
  const loop = (n) => {
    const [at, body] = n[0] === 'for' ? [2, 4] : [1, 2]
    if (n[at] == null || truth(n[at]) === true) { const c = leadingBreak(n[body]); if (c) n[at] = not(c) }
    if (n[at] != null) n[at] = test(n[at])
    if (n[0] === 'for') { visit(n[1]); n[3] = steps(n[3]); counted(n) }
    visit(n[at])
    n[body] = stmt(n[body])
    visit(n[body])
  }

  /** A statement in the one form: a step its normal step; a do-while (under its labels)
   *  `while (c) B` where its test holds on entry over the literals `prev` declares, else
   *  `let F = true; while (F || c) { F = false; B }`, a flag no stage reads as one: the
   *  analyses take it for the loop it is (a countdown `c` in its arm keeps its range,
   *  analyze-scans.js stampCountdowns). A `continue` reaches the test of either. */
  const stmt = (s, prev) => {
    let holder = null, d = s
    while (isArr(d) && d[0] === 'label' && d.length === 3) { holder = d; d = d[2] }
    if (!isArr(d) || d[0] !== 'do' || d.length !== 3) return step(s)
    rewrites++
    const [, body, c] = d, F = `${T}do${doFlags++}`
    const low = prev !== undefined && holds(c, prev) ? ['while', c, body]
      : [';', ['let', ['=', F, [null, true]]], ['while', ['||', F, c], ['{}', [';', ['=', F, [null, false]], body]]]]
    if (!holder) return low
    holder[2] = low
    return s
  }
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
      // (a do-while the whole of `if (c)` with the same test: it holds on entry)
      const s = list[k], g = isArr(s) && s[0] === 'if' && s.length === 3 && !hasArrow(s[1]) ? only(s[2]) : null
      if (isArr(g) && g[0] === 'do' && g.length === 3 && same(g[2], s[1])) list[k] = note(s, ['while', g[2], g[1]])
      list[k] = stmt(list[k], k > 1 ? list[k - 1] : null)
      visit(list[k])
    }
  }

  const visit = (n) => {
    if (!isArr(n)) return
    const op = n[0]
    if (op === ';') return block(n)
    if (op === 'while' && n.length === 3 || op === 'for' && n.length === 5) return loop(n)
    if (op === 'if') { n[2] = stmt(n[2]); if (n.length > 3) n[3] = stmt(n[3]) }
    else if (op === '{}' || op === 'label') n[n.length - 1] = stmt(n[n.length - 1])
    // (a do-while in any other place a statement stands: a case's, a catch's)
    else for (let i = 1; i < n.length; i++) if (isArr(n[i]) && (n[i][0] === 'do' || n[i][0] === 'label')) n[i] = stmt(n[i])
    for (let i = 1; i < n.length; i++) visit(n[i])
  }
  visit(node)
  return node
}

/** Every function body and module init in the one loop form: before the summary
 *  (src/front.js), over the Numbers of the syntax (`numberNames`) and the module's
 *  constants, and once it knows kinds (src/compile/index.js, `summary` given), over
 *  a local it holds a Number too, whatever it was declared from (a parameter, a
 *  call, another name), where no arrow but its own writes it. A kind does not rule
 *  out NaN: a negated test keeps the syntactic facts. → { ast: the module's
 *  statement, replaced where it was a do-while, changed: whether a tree changed } */
export function normalizeProgram(ast, summary = null) {
  if (!summary) doFlags = 0
  const was = rewrites, inits = [';', ast, ...(ctx.module.moduleInits ?? [])], consts = moduleConstants(inits)
  const constOf = (x) => consts.get(x) ?? null, written = new Set()
  const each = (body, params, scope, own = () => true) => {
    const { isNumber, valueOf, homeOf } = numberNames(body, constOf, params)
    const real = (x) => isNumber(x) && own(x) || consts.has(x)
    const kind = (x, at = homeOf(x)) => { const k = at !== undefined && own(x) ? summary.at(at?.[2] ?? scope).kindOfExpr(x) : 0; return tagOf(k) === K.NUMBER && !(k & NULL_BITS) }
    normalize(body, summary ? (x) => real(x) || kind(x) : real, (x) => (own(x) ? valueOf(x) : null) ?? constOf(x), real)
  }
  for (const f of ctx.funcs.list) {
    if (f.raw || !isArr(f.body)) continue
    collectAssignedNames(f.body, written)
    each(f.body, (f.sig?.params ?? []).map(p => p.name), f.sig)
  }
  // (a module's name a function writes, or the host, is no Number of the module's own)
  each(inits, [], '', (x) => !written.has(x) && ctx.funcs.exports?.[x] == null)
  const mods = ctx.module.moduleInits ?? []
  for (let i = 0; i < mods.length; i++) mods[i] = inits[i + 2]
  return { ast: inits[1], changed: rewrites !== was }
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
