/**
 * Static-string(-array) value extraction and indexed-const-literal hoisting: the
 * bindStaticConst/bindStaticGlobal/deleteStaticGlobal/invalidateMutatedArray family
 * plus hoistIndexedConstLiterals and the staticStringExpr/constNum lookup helpers.
 *
 * @module prepare/literals
 */

import { walkAst } from '../ast.js'
import { includeForStringValue } from '../autoload.js'
import { ctx } from '../ctx.js'
import { MUTATING_ARRAY_METHODS, stringValue } from './const-fold.js'
import { isDeclared, resolveScope } from './scope.js'
import { STATIC_ARRAYS, STATIC_CONSTS, STATIC_STRINGS, mutatedArrayNames, scopes, staticConstScopes } from './state.js'



export function staticStringArrayValues(expr) {
  if (!Array.isArray(expr) || expr[0] !== '[]' || expr.length !== 2) return null
  const raw = Array.isArray(expr[1]) && expr[1][0] === ',' ? expr[1].slice(1) : [expr[1]]
  const out = []
  for (const item of raw) {
    const s = staticStringExpr(item)
    if (s == null) return null
    out.push(s)
  }
  return out
}

function immediateStaticStringExpr(node) {
  const lit = stringValue(node)
  if (lit != null) return lit
  if (Array.isArray(node) && node[0] === 'str' && typeof node[1] === 'string') return node[1]
  if (!Array.isArray(node)) return null
  const [op, ...args] = node
  if (op === '+') {
    const a = immediateStaticStringExpr(args[0])
    const b = immediateStaticStringExpr(args[1])
    return a != null && b != null ? a + b : null
  }
  if (op === '`') {
    let out = ''
    for (const part of args) {
      const s = immediateStaticStringExpr(part)
      if (s == null) return null
      out += s
    }
    return out
  }
  return null
}

function immediateStaticStringArrayValues(expr) {
  if (!Array.isArray(expr) || expr[0] !== '[]' || expr.length !== 2) return null
  const raw = Array.isArray(expr[1]) && expr[1][0] === ',' ? expr[1].slice(1) : [expr[1]]
  const out = []
  for (const item of raw) {
    const s = immediateStaticStringExpr(item)
    if (s == null) return null
    out.push(s)
  }
  return out
}

function eachTopLevelStatement(node, fn) {
  if (Array.isArray(node) && node[0] === ';') {
    for (let i = 1; i < node.length; i++) fn(node[i])
  } else {
    fn(node)
  }
}

function collectAssignmentWrites(node, writes, mutated) {
  if (!Array.isArray(node)) return
  const [op, lhs] = node
  const bump = (name) => writes.set(name, (writes.get(name) || 0) + 1)
  if (op === '=' && typeof lhs === 'string') bump(lhs)
  if ((op === '++' || op === '--') && typeof lhs === 'string') bump(lhs)
  // Element/length writes and mutating method calls are writes too — a seeded
  // static array whose values change after init would serve stale folds. The
  // `mutated` census gates the const-decl and first-assign binds: execution
  // order (hoisted function bodies, call-before-decl) can run any of these
  // before a later fold site, so ANY such op anywhere ends the name's
  // static-array eligibility outright.
  if (op === '=' && Array.isArray(lhs) && (lhs[0] === '[]' || (lhs[0] === '.' && lhs[2] === 'length')) && typeof lhs[1] === 'string') { bump(lhs[1]); mutated?.add(lhs[1]) }
  if (op === '()' && Array.isArray(lhs) && lhs[0] === '.' && typeof lhs[1] === 'string' && MUTATING_ARRAY_METHODS.has(lhs[2])) { bump(lhs[1]); mutated?.add(lhs[1]) }
  for (let i = 1; i < node.length; i++) collectAssignmentWrites(node[i], writes, mutated)
}

function collectTopLevelStaticAssignments(node, facts) {
  if (!Array.isArray(node)) return
  if (node[0] === ',') {
    for (let i = 1; i < node.length; i++) collectTopLevelStaticAssignments(node[i], facts)
    return
  }
  if (node[0] !== '=' || typeof node[1] !== 'string') return
  const str = immediateStaticStringExpr(node[2])
  const arr = immediateStaticStringArrayValues(node[2])
  if (str != null || arr) facts.set(node[1], { str, arr })
}

/** `[c0,c1,…][i]` inside a function body allocates the literal PER EVALUATION —
 *  the '[' static-data lowering is module-scope-gated because a NAMED local
 *  literal could leak per-instance mutations across calls. A literal in the
 *  RECEIVER position of its own read can neither escape nor be written, so
 *  hoist it to a synthetic module-level const: one shared data segment + the
 *  staticArrs base/len fold, with duplicates interned by content (beat-style
 *  samplers read several such tables per sample — 3×144 B allocs/sample in the
 *  Sierpinski floatbeat; a const index rides the same path and folds all the
 *  way to a constant). Elements: number literals (incl. unary minus) only —
 *  exactly the static-extractable set the '[' lowering takes. */
export function hoistIndexedConstLiterals(root) {
  const lits = new Map()   // content key → synthetic const name
  const decls = []
  // Parse shapes: number literal = [null, n]; unary minus = ['-', lit];
  // array literal = ['[]', elems] (unary '[]'), elems = [',', ...] | one lit | undefined;
  // subscript = ['[]', receiver, index] (binary '[]').
  const numLitVal = (e) => Array.isArray(e) && e.length === 2 && e[0] == null && typeof e[1] === 'number' ? e[1]
    : Array.isArray(e) && e[0] === '-' && e.length === 2 ? (v => v === null ? null : -v)(numLitVal(e[1]))
    : null
  // A literal read in WRITE position (`[1,2][0] = 5`, `[1,2][k]++`, `delete [1,2][0]`,
  // destructuring targets) must keep its fresh per-evaluation array — rewriting it
  // would mutate the shared segment under every other read interned to the same
  // content. Post-order rewrites children before the parent assign is visible, so
  // collect banned '[]' nodes in a first pass over every assignment-target subtree.
  const banned = new Set()
  const banIn = (t) => walkAst(t, { enter: (n) => { if (n[0] === '[]') banned.add(n) } })
  walkAst(root, { enter: (node) => {
    const op = node[0]
    if (typeof op === 'string' && (op === '++' || op === '--' || op === 'delete' || op === '=' ||
        (op.length >= 2 && op.endsWith('=') && !['==', '===', '!=', '!==', '<=', '>='].includes(op))))
      banIn(node[1])
  } })
  walkAst(root, { exit: node => {
    if (node[0] !== '[]' || node.length !== 3 || banned.has(node)) return
    const lit = node[1]
    if (!Array.isArray(lit) || lit[0] !== '[]' || lit.length !== 2) return
    const inner = lit[1]
    const elems = Array.isArray(inner) && inner[0] === ',' ? inner.slice(1) : inner === undefined ? [] : [inner]
    if (!elems.length) return
    const vals = elems.map(numLitVal)
    if (vals.some(v => v === null)) return
    const key = vals.join(',')
    let name = lits.get(key)
    if (name == null) {
      name = `__salit${lits.size}`
      lits.set(key, name)
      decls.push(['const', ['=', name, lit]])
    }
    node[1] = name
  } })
  if (!decls.length) return root
  if (Array.isArray(root) && root[0] === ';') { root.splice(1, 0, ...decls); return root }
  return [';', ...decls, root]
}

export function seedStaticGlobalAssignments(node) {
  // jzify hoists function declarations ahead of `var` initializer assignments.
  // Seed one-write static globals before preparing those function bodies so
  // compile-time-only consumers (for example `new RegExp(`${PART}`)`) can still
  // resolve the same constants they would see after module initialization.
  const writes = new Map()
  const facts = new Map()
  collectAssignmentWrites(node, writes, mutatedArrayNames)
  eachTopLevelStatement(node, stmt => collectTopLevelStaticAssignments(stmt, facts))
  for (const [name, fact] of facts) {
    if (writes.get(name) === 1) bindStaticGlobal(name, fact.str, fact.arr)
  }
}

export function stringArrayValues(expr) {
  if (!Array.isArray(expr) || expr[0] !== '[' || expr.length === 1) return null
  const out = []
  for (const item of expr.slice(1)) {
    if (!Array.isArray(item) || item[0] !== 'str' || typeof item[1] !== 'string') return null
    out.push(item[1])
  }
  return out
}

export function staticString(value) {
  includeForStringValue()
  return ['str', value]
}

function lookupStaticString(name) {
  const resolved = scopes.length && isDeclared(name) ? resolveScope(name) : (ctx.scope.chain[name] || name)
  for (let i = staticConstScopes.length - 1; i >= 0; i--) {
    const v = staticConstScopes[i][STATIC_STRINGS]?.get(resolved)
    if (v != null) return v
  }
  return ctx.scope.shapeStrs?.get(resolved) ?? ctx.scope.constStrs?.get(resolved) ?? null
}

function lookupStaticStringArray(name) {
  const resolved = scopes.length && isDeclared(name) ? resolveScope(name) : (ctx.scope.chain[name] || name)
  for (let i = staticConstScopes.length - 1; i >= 0; i--) {
    const v = staticConstScopes[i][STATIC_ARRAYS]?.get(resolved)
    if (v) return v
  }
  return ctx.scope.shapeStrArrays?.get(resolved) ?? null
}

/** Evaluate a constant numeric expression (number literals + basic arithmetic) for
 *  compile-time string/template folding. Returns null when it isn't a pure-number
 *  constant — string `+` and dynamic parts fall through to the caller's runtime path. */
function constNum(node) {
  if (Array.isArray(node) && node[0] == null && typeof node[1] === 'number') return node[1]
  if (!Array.isArray(node)) return null
  const [op, a, b] = node
  if ((op === 'u-' || op === '-' || op === '+') && b === undefined) {
    const x = constNum(a)
    return x == null ? null : op === 'u-' || op === '-' ? -x : +x
  }
  const x = constNum(a), y = constNum(b)
  if (x == null || y == null) return null
  switch (op) {
    case '+': return x + y
    case '-': return x - y
    case '*': return x * y
    case '/': return y === 0 ? null : x / y
    case '%': return y === 0 ? null : x % y
    case '**': return x ** y
  }
  return null
}

export function staticStringExpr(node) {
  const lit = stringValue(node)
  if (lit != null) return lit
  if (Array.isArray(node) && node[0] === 'str' && typeof node[1] === 'string') return node[1]
  if (typeof node === 'string') return lookupStaticString(node)
  if (!Array.isArray(node)) return null
  const [op, ...args] = node
  if (op === '+') {
    const a = staticStringExpr(args[0])
    const b = staticStringExpr(args[1])
    // Accumulate from a fresh empty string (`'' + a + b`) rather than concatenating two
    // source-derived substrings directly. Under self-compile the latter can yield a string
    // backed by transient parse-time storage that's invalid by the time emit['//'] reads
    // it for regex compilation (OOB); forcing a fresh allocation, as the template-literal
    // path already does, keeps it stable. Identical value in both legs.
    return a != null && b != null ? '' + a + b : null
  }
  if (op === '`') {
    let out = ''
    for (const part of args) {
      let s = staticStringExpr(part)
      // A numeric interpolation (`${123}`, `${1+2}`) is a constant in string context —
      // ToString it so a fully-static template folds to one literal instead of a runtime
      // concat. (Only the template case stringifies numbers; `+` stays polymorphic.)
      if (s == null) { const n = constNum(part); if (n != null) s = String(n) }
      if (s == null) return null
      out += s
    }
    return out
  }
  if (op === '()' && Array.isArray(args[0]) && args[0][0] === '.' && args[0][2] === 'join' && typeof args[0][1] === 'string') {
    const arr = lookupStaticStringArray(args[0][1])
    if (!arr) return null
    const sep = args.length > 1 && args[1] != null ? staticStringExpr(args[1]) : ','
    return sep != null ? arr.join(sep) : null
  }
  return null
}

export function bindStaticConst(name, str, arr) {
  const frame = staticConstScopes.at(-1)
  if (!frame || typeof name !== 'string') return
  if (str != null) (frame[STATIC_STRINGS] ||= new Map()).set(name, str)
  if (arr) (frame[STATIC_ARRAYS] ||= new Map()).set(name, arr)
}

export function bindStaticGlobal(name, str, arr) {
  if (typeof name !== 'string') return
  if (str != null) (ctx.scope.shapeStrs ||= new Map()).set(name, str)
  if (arr) (ctx.scope.shapeStrArrays ||= new Map()).set(name, arr)
}

export function deleteStaticGlobal(name) {
  ctx.scope.shapeStrs?.delete(name)
  ctx.scope.shapeStrArrays?.delete(name)
}

// A mutation observed mid-walk — indexed write (`S[0] = x`), `.length` write,
// or mutating method call (`S.push(…)`) — ends the name's static-array fact
// NOW, in every scope that could serve a later fold: the in-walk folds
// (`S.join('')`, concat parts) must not consume pre-mutation values. Statement
// order equals execution order here (jzify hoists function declarations the
// way JS does), so invalidating at the mutation point is exact, not
// conservative. Whole-name reassignment already invalidates at the `=` depth-0
// site; the post-prep reassignment sweep still covers compile-phase consumers
// — this closes the in-walk fold window those two leave open.
export function invalidateMutatedArray(name) {
  if (typeof name !== 'string') return
  for (const s of staticConstScopes) s[STATIC_ARRAYS]?.delete(name)
  ctx.scope.shapeStrArrays?.delete(name)
}