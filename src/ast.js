/**
 * Shared Jessie/subscript AST shape helpers and walks.
 *
 * Cycle-free: no ctx/analyze/ir imports. Shared with abi/* and ir.js.
 *
 * @module ast
 */

/** Template placeholder in prepared AST (prepare.js). */
export const T = '\uE000'

// === Atom sentinels (shared by prepare + emit \u2014 keeps the stage boundary
// import-clean: emit must not reach into prepare for a constant) ===

// `null` and `undefined` are distinct NaN-box atoms (aux 1 vs 2), so they get
// distinct sentinels \u2014 collapsing both to one made `cond ? undefined : x`
// surface as `null` (the value flows through emit's symbol case, which can
// only carry one atom).
export const JZ_NULL = Symbol('null')
export const JZ_UNDEF = Symbol('undefined')

/** `typeof` comparison codes, keyed by the JS typeof string — negative so they
 *  can't collide with positive user-supplied PTR kinds in the same compare slot
 *  (prepare folds `typeof x == "number"` to `[op, ['typeof', x], [, TYPEOF.number]]`;
 *  emit's emitTypeofCmp and flow-types' refinements dispatch on the codes).
 *  Null-proto: prepare indexes it with arbitrary user strings — a plain literal
 *  would leak `constructor`/`toString` through the lookup. */
export const TYPEOF = Object.freeze(Object.assign(Object.create(null), {
  number: -1, string: -2, undefined: -3, boolean: -4, object: -5, 'function': -6, bigint: -7,
}))

/** Match a `typeof name <op> lit` predicate. Returns `{ name, code, eq }` —
 *  `name` is the typeof's operand binding, `code` is either the raw type
 *  string ('string'|'number'|'function'|…) or the prepare-normalized typeof
 *  code (TYPEOF, above), and `eq` is true for `==`/`===` (false for `!=`/
 *  `!==`). Returns null when the node isn't a typeof predicate.
 *
 *  Two consumers — src/compile/infer.js's notStringEvidence (body-walk
 *  evidence) and src/compile/flow-types.js's extractRefinements/
 *  closureBodyReturnKind (flow-sensitive refinement) — used to re-implement
 *  this independently with diverging tolerances for the literal form (raw
 *  `'string'` vs prepare-normalized typeof-code `-2`). Lives here (not in
 *  infer.js, its original home) because it's a pure AST-shape predicate with
 *  no ctx/reps dependency, and module/function.js's closure return-kind
 *  pre-pass needs it through flow-types.js without pulling in infer.js's own
 *  autoload.js import — that edge closed a real cycle (module/function.js →
 *  flow-types.js → infer.js → autoload.js → module/index.js →
 *  module/function.js). ast.js is the shared cycle-free leaf both sides
 *  already import. */
export function typeofPredicate(node) {
  if (!Array.isArray(node)) return null
  const op = node[0]
  if (op !== '==' && op !== '===' && op !== '!=' && op !== '!==') return null
  const a = node[1], b = node[2]
  const typeofSide = Array.isArray(a) && a[0] === 'typeof' && typeof a[1] === 'string' ? a
    : Array.isArray(b) && b[0] === 'typeof' && typeof b[1] === 'string' ? b : null
  if (!typeofSide) return null
  const litSide = typeofSide === a ? b : a
  const code = Array.isArray(litSide) && litSide[0] == null ? litSide[1] : null
  if (code == null) return null
  return { name: typeofSide[1], code, eq: op === '==' || op === '===' }
}

// === Numeric range (shared by analyze + ir) ===

export const I32_MIN = -2147483648
export const I32_MAX = 2147483647
export const isI32 = (v) => Number.isInteger(v) && v >= I32_MIN && v <= I32_MAX && !Object.is(v, -0)

// === Statement / block-body classification ===

/** Statement operators — distinguish block bodies from object literals. */
export const STMT_OPS = new Set([';', 'let', 'const', 'return', 'if', 'for', 'for-in', 'while', 'break', 'continue', 'switch',
  '=', '+=', '-=', '*=', '/=', '%=', '**=', '&=', '|=', '^=', '>>=', '<<=', '>>>=', '||=', '&&=', '??=',
  'throw', 'try', 'catch', 'finally', '++', '--', '()'])

/** jzify superset: pre-lowered JS shapes before prepare strips them. */
export const JZ_BLOCK_OPS = new Set([...STMT_OPS, 'var', 'for-of', 'do', 'function', 'class', 'import', 'export', 'label', 'case', 'default'])

/** Valid labeled-statement bodies in jzify. */
export const LABEL_BODY_OPS = new Set([';', 'if', 'for', 'for-in', 'for-of', 'while', 'do', 'switch', 'try', 'throw'])

/** Statement-only ops: heads that can never be a concise arrow *value* body.
 *  A concise-body arrow with one of these can only have come from method/function
 *  shorthand the parser unwrapped (`m(){ if … }` → `['=>', p, ['if', …]]`), so it
 *  must be re-blocked. Excludes `function`/`class` (those ARE expression bodies,
 *  e.g. `() => function(){}`), assignment/update/call, and switch-internal
 *  `case`/`default`. */
export const STMT_ONLY_OPS = new Set([';', 'if', 'for', 'for-in', 'for-of', 'while', 'do', 'switch',
  'return', 'break', 'continue', 'throw', 'try', 'let', 'const', 'var', 'label'])

/** Distinguish a function block body `{ … }` from an expression object literal `({a:1})`. */
export const isBlockBody = (body) =>
  Array.isArray(body) && body[0] === '{}' && (body.length === 1 || STMT_OPS.has(body[1]?.[0]))

// === AST node classifiers ===

export const isLiteralStr = idx => Array.isArray(idx) && idx[0] === 'str' && typeof idx[1] === 'string'
export const isFuncRef = (node, funcNames) => typeof node === 'string' && funcNames.has(node)

/** A value-leaf IR instruction — `local.get`/`global.get`/any `*.const`. Cheap and
 *  side-effect-free, so safe to duplicate without spilling to a temp. The one
 *  source of truth for "is this trivially duplicatable" across ir/abi/optimize. */
export const isLeaf = n => Array.isArray(n) && (n[0] === 'local.get' || n[0] === 'global.get' || n[0].endsWith('.const'))

// === Shared traversal ===

/** Pre-order walk over an array AST/IR tree.
 *
 * `enter(node, parent, index)` sees each array node. Returning `false` prunes
 * that node's children. `boundary`, when supplied, runs after `enter` and
 * prunes children when it returns true. Primitive operands are not visited;
 * callers inspect them through their containing node.
 * The root has `parent === null` and `index === -1`; array opcode slots (`[0]`)
 * are not visited separately because `enter` already receives their node.
 *
 * The walk deliberately keeps no visited set: AST is a tree, and optimizer IR
 * may share a subtree whose occurrences must each retain their original visit. */
export function walkAst(node, { enter, boundary } = {}) {
  const visit = (value, parent, index) => {
    if (!Array.isArray(value)) return
    if (enter && enter(value, parent, index) === false) return
    if (boundary && boundary(value, parent, index)) return
    for (let i = 1; i < value.length; i++) visit(value[i], value, i)
  }
  visit(node, null, -1)
  return node
}

// === Assignment / reassignment ===

/** Assignment operators — shared across analyze, plan, emit, abi. */
export const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '&=', '|=', '^=', '>>=', '<<=', '>>>=', '||=', '&&=', '??='])

/** Every op that writes its first operand: assignments plus ++/--. */
export const MUTATE_OPS = new Set([...ASSIGN_OPS, '++', '--'])

/** Detect whether `name` is written to (=, +=, ++, --, etc.) anywhere within `body`.
 *
 *  Emission-scoped memo: emit-time callers query this against the SAME enclosing
 *  body once per relevant declaration/reference — O(decls × |body|) unmemoized,
 *  which is what turned module-sized synthetic default functions (m86_math$default,
 *  24 closure registrations in one 175K-char body) into a 3.2 GB wasm-arena blowup
 *  (.work/research.md §emitFunc blowup). The emit driver brackets its stages with
 *  begin/endAssignedMemo — sound there because emission never mutates the source
 *  AST (post-analyze freeze). Outside that window (plan/analyze callers, which DO
 *  interleave AST mutation) the original always-fresh walk runs unchanged. */
let assignedMemo = null
export const beginAssignedMemo = () => { assignedMemo = new Map() }
export const endAssignedMemo = () => { assignedMemo = null }
// One-pass collection of every name written (=, +=, ++, --, …) anywhere in the
// subtree — the exact same tree contract as the walk below: a `let`/`const`
// declarator's own `=` binds rather than writes (only its initializer is
// scanned); mutation targets that aren't bare names contribute nothing
// themselves but their subexpressions are scanned.
const collectAssignedNames = (body, out) => {
  if (!Array.isArray(body)) return out
  const op = body[0]
  if (op === 'let' || op === 'const') {
    for (let i = 1; i < body.length; i++) {
      const d = body[i]
      if (Array.isArray(d) && d[0] === '=' && d[2] != null) collectAssignedNames(d[2], out)
    }
    return out
  }
  if (MUTATE_OPS.has(op) && typeof body[1] === 'string') out.add(body[1])
  for (let i = 1; i < body.length; i++) collectAssignedNames(body[i], out)
  return out
}
export function isReassigned(body, name) {
  if (!Array.isArray(body)) return false
  if (assignedMemo) {
    let s = assignedMemo.get(body)
    if (!s) assignedMemo.set(body, s = collectAssignedNames(body, new Set()))
    return s.has(name)
  }
  const op = body[0]
  if (MUTATE_OPS.has(op) && body[1] === name) return true
  if (op === 'let' || op === 'const') {
    for (let i = 1; i < body.length; i++) {
      const d = body[i]
      if (Array.isArray(d) && d[0] === '=' && d[2] != null && isReassigned(d[2], name)) return true
    }
    return false
  }
  for (let i = 1; i < body.length; i++) if (isReassigned(body[i], name)) return true
  return false
}

/** First reference to `name` in EVALUATION order: 'write' (an unconditional
 *  plain assignment reached before any read — definitely-assigned), 'read'
 *  (a read, a compound/inc write — those read first — or ANY reference inside
 *  conditionally-executed code: if/ternary/short-circuit arms, loop bodies and
 *  steps, switch cases, try/catch regions, closures), or null (no reference).
 *  Drives the uninit-`let` maybeNullish flag: only a first-ref 'write' proves
 *  the binding never reads its `undefined` init (`let s; while ((s = …) < K)`). */
export function firstRefKind(n, name) {
  const hasRef = (m) => m === name || (Array.isArray(m) && m.slice(1).some(hasRef))
  const condRef = (...parts) => parts.some(hasRef) ? 'read' : null
  const walk = (m) => {
    if (m === name) return 'read'
    if (!Array.isArray(m)) return null
    const op = m[0]
    if (op === '=>') return condRef(m)                       // body runs at call time
    if (op === '=' && m[1] === name) return walk(m[2]) ?? 'write'   // rhs evaluates first
    if (MUTATE_OPS.has(op) && m[1] === name) return 'read'
    if (op === 'let' || op === 'const') {
      for (let k = 1; k < m.length; k++) {
        const d = m[k]
        if (d === name) return null                          // the decl itself, not a read
        if (Array.isArray(d) && d[0] === '=' && d[1] === name) return walk(d[2]) ?? 'write'
        const r = walk(d)
        if (r) return r
      }
      return null
    }
    if (op === 'if' || op === '?:') {
      const c = walk(m[1])
      if (c) return c
      // two-armed if/ternary where BOTH arms' first ref is an unconditional
      // write: the join is definitely-assigned (`let s; if (c) s = a; else
      // s = b` — the mandelbrot setView preamble shape)
      if (m.length === 4 && m[3] !== undefined) {
        const t = walk(m[2]), e = walk(m[3])
        if (t === 'write' && e === 'write') return 'write'
        return (t || e) ? 'read' : null
      }
      return condRef(...m.slice(2))
    }
    if (op === '&&' || op === '||' || op === '??') return walk(m[1]) ?? condRef(m[2])
    if (op === 'while') return walk(m[1]) ?? condRef(m[2])   // cond evaluates ≥ once
    if (op === 'for' && m.length === 5)                      // init + first cond eval run once
      return walk(m[1]) ?? walk(m[2]) ?? condRef(m[3], m[4])
    if (op === 'for-of' || op === 'for-in') return walk(m[2]) ?? condRef(m[1], m[3])
    if (op === 'switch') return walk(m[1]) ?? condRef(...m.slice(2))
    if (op === 'try' || op === 'catch' || op === 'finally' || op === '?.') return condRef(m)
    for (let k = 1; k < m.length; k++) { const r = walk(m[k]); if (r) return r }
    return null
  }
  return walk(n)
}

// A deeply-constant array literal (every element a compile-time literal), safe to
// allocate once and share. At emit time an array literal is `['[', e0, e1, …]` (flat
// elements); an INDEX access is `['[]', base, idx]` (op `[]`) — NOT a literal.
export function isConstLiteral(node) {
  if (!Array.isArray(node)) return false
  const op = node[0]
  if (op == null) return true                                   // [null, n] / [,bool] / [null,null] primitive
  if (op === '[') { for (let i = 1; i < node.length; i++) if (!isConstLiteral(node[i])) return false; return true }
  return false
}

// Is `node` a pure reference-projection of a tainted name? (`t`, `t[i]`, `t.p`, chained) —
// a value that aliases into the shared literal, so it must be tracked too.
const isProjection = (node, tainted) => {
  if (typeof node === 'string') return tainted.has(node)
  return Array.isArray(node) && (node[0] === '[]' || node[0] === '.') && node.length === 3 && isProjection(node[1], tainted)
}
const baseIsTainted = (m, tainted) => isProjection(m, tainted)   // m is a [] / . access node

// Could a single shared allocation of `name` be observed to differ from per-iteration
// allocation within `body`? It can't iff `name` and every alias derived from it by pure
// reference-projection is only ever READ (as a `[]`/`.` base) — never written through,
// method-called, or escaped (bare value, call arg, return, comparison). Then hoisting the
// allocation out of a loop is sound. Conservative: any use it can't classify as a read
// bails out (returns true = "not hoistable").
export function constLiteralHoistable(body, name) {
  const decls = []
  ;(function collect(n) {
    if (!Array.isArray(n)) return
    if (n[0] === 'const' || n[0] === 'let')
      for (let i = 1; i < n.length; i++) { const d = n[i]; if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') decls.push(d) }
    for (let i = 1; i < n.length; i++) collect(n[i])
  })(body)
  const tainted = new Set([name])
  for (let changed = true; changed;) {
    changed = false
    for (const d of decls) if (!tainted.has(d[1]) && isProjection(d[2], tainted)) { tainted.add(d[1]); changed = true }
  }
  // unsafe use of any tainted name?
  return !(function bad(node) {
    if (typeof node === 'string') return tainted.has(node)                       // bare tainted value = escape
    if (!Array.isArray(node)) return false
    const op = node[0]
    // decl: the bound names are bindings, not uses — only the initializer values matter
    if (op === 'const' || op === 'let') {
      for (let i = 1; i < node.length; i++) { const d = node[i]; if (Array.isArray(d) && d[0] === '=') { if (bad(d[2])) return true } else if (bad(d)) return true }
      return false
    }
    // read of a tainted base (`t[i]` / `t.p`): base is fine, only the index expr can be unsafe
    if ((op === '[]' || op === '.') && node.length === 3 && typeof node[1] === 'string' && tainted.has(node[1]))
      return op === '[]' ? bad(node[2]) : false
    if (ASSIGN_OPS.has(op) && typeof node[1] === 'string' && tainted.has(node[1])) return true                                                       // reassign the binding
    if (ASSIGN_OPS.has(op) && Array.isArray(node[1]) && (node[1][0] === '[]' || node[1][0] === '.') && baseIsTainted(node[1], tainted)) return true   // write through
    if ((op === '++' || op === '--') && typeof node[1] === 'string' && tainted.has(node[1])) return true
    if (op === '()' && Array.isArray(node[1]) && node[1][0] === '.' && baseIsTainted(node[1], tainted)) return true                                   // method call
    for (let i = 1; i < node.length; i++) if (bad(node[i])) return true
    return false
  })(body)
}

// Sound over-approximation: could `name`'s array length change anywhere in `body`?
// True if it is reassigned, has a length-mutating method called on it (push/pop/shift/
// unshift/splice), is assigned through (`name.x = …` / `name[i] = …`, the latter may grow),
// or is handed to a call as an argument (a callee might push to it). Lets a plain array's
// `arr.length` loop bound be hoisted when this is false (see immutableLenBound).
export function mutatesArrayLength(body, name) {
  if (!Array.isArray(body)) return false
  const op = body[0]
  if (MUTATE_OPS.has(op) && body[1] === name) return true
  // write through `name` (`name.x = …`, `name[i] = …` — index write may extend length)
  if (ASSIGN_OPS.has(op) && Array.isArray(body[1]) && (body[1][0] === '.' || body[1][0] === '[]') && body[1][1] === name) return true
  if (op === '()') {
    // method call on `name` (`name.push(…)` etc.) — any method, to stay sound
    if (Array.isArray(body[1]) && body[1][0] === '.' && body[1][1] === name) return true
    // `name` passed as a call argument — the callee could mutate it
    for (let i = 2; i < body.length; i++) if (body[i] === name) return true
  }
  for (let i = 1; i < body.length; i++) if (mutatesArrayLength(body[i], name)) return true
  return false
}

/** Normalize a call's raw arg slot: null → [], comma-group → elems, else singleton. */
export function commaList(raw) {
  if (raw == null) return []
  return Array.isArray(raw) && raw[0] === ',' ? raw.slice(1) : [raw]
}

/** Args of a `['()', callee, raw]` node, or null when `node` is not a call. */
export function callArgs(node) {
  if (!Array.isArray(node) || node[0] !== '()') return null
  return commaList(node[2])
}

/** Write normalized args back onto a call node. */
export function setCallArgs(node, args) {
  node[2] = args.length === 0 ? null : args.length === 1 ? args[0] : [',', ...args]
}

/** Unwrap handler/rest `args` when the sole element is a comma-group. */
export function spreadArgs(args) {
  if (args.length === 1 && Array.isArray(args[0]) && args[0][0] === ',') return args[0].slice(1)
  return args
}

export const isSeq = node => Array.isArray(node) && node[0] === ';'

/** Statement list inside a block `{…}`; null when `body` is not a block. */
export function blockStmts(body) {
  if (!Array.isArray(body) || body[0] !== '{}') return null
  const inner = body[1]
  if (!Array.isArray(inner)) return inner == null ? [] : [inner]
  return inner[0] === ';' ? inner.slice(1) : [inner]
}

/** Flatten a block/seq/single-stmt body into a statement array. */
export function stmtList(body) {
  if (!Array.isArray(body)) return body == null ? [] : [body]
  if (body[0] === '{}') return stmtList(body[1])
  if (body[0] === ';') return body.slice(1)
  return [body]
}

/** Handler/rest args with comma unwrap and null drop (jzify/prepare). */
export function handlerArgs(args) {
  return spreadArgs(args).filter(a => a != null)
}

/** Early-exit walk; skips into `=>` bodies by default. */
const someNode = (node, pred, skipArrow) => {
  if (!Array.isArray(node)) return false
  if (pred(node)) return true
  if (skipArrow && node[0] === '=>') return false
  for (let i = 1; i < node.length; i++) if (someNode(node[i], pred, skipArrow)) return true
  return false
}

export function some(node, pred, opts) {
  return someNode(node, pred, opts?.skipArrow !== false)
}

/** Options for {@link refsName} / {@link refsAny}. */
// skipArrow (default true): stop at `=>` boundaries — matches `some()`.
// skipStr: don't descend into `str` literal nodes.
// skipBindingPositions: on `.`/`?.` recurse only the receiver; on `:` only the value.

/** Shared option records: callers never allocate `{skipArrow:false}` in hot scans. */
export const REFS_THROUGH_ARROWS = { skipArrow: false }
/** Expression-position name refs: descends into `=>`, skips literal keys and `str`. */
export const REFS_IN_EXPR = { skipArrow: false, skipStr: true, skipBindingPositions: true }

/** True if bare identifier `name` appears anywhere in `node`. */
export function refsName(node, name, opts = {}) {
  const skipArrow = opts.skipArrow !== false
  if (typeof node === 'string') return node === name
  if (!Array.isArray(node)) return false
  const op = node[0]
  if (skipArrow && op === '=>') return false
  if (opts.skipStr && op === 'str') return false
  if (opts.skipBindingPositions) {
    if (op === '.' || op === '?.') return refsName(node[1], name, opts)
    if (op === ':') return refsName(node[2], name, opts)
  }
  for (let i = 1; i < node.length; i++) if (refsName(node[i], name, opts)) return true
  return false
}

/** True if any name in `names` (Set) appears in `node`. Same options as refsName. */
export function refsAny(node, names, opts = {}) {
  if (!names?.size) return false
  if (typeof node === 'string') return names.has(node)
  if (!Array.isArray(node)) return false
  const op = node[0]
  if (opts.skipArrow !== false && op === '=>') return false
  if (opts.skipStr && op === 'str') return false
  if (opts.skipBindingPositions) {
    if (op === '.' || op === '?.') return refsAny(node[1], names, opts)
    if (op === ':') return refsAny(node[2], names, opts)
  }
  for (let i = 1; i < node.length; i++) if (refsAny(node[i], names, opts)) return true
  return false
}

/** True if evaluating `node` may itself YIELD `name`'s own reference — narrower
 *  than `refsName`: only descends through value-forwarding positions (`?:`'s
 *  both arms, `&&`/`||`'s both operands, `,`'s last element) where the
 *  operand's identity passes through unchanged. A property/element read,
 *  arithmetic, or call CONSUMES `name` without forwarding it, so those don't
 *  count — deliberately not a general "does this reference appear" scanner.
 *  Used to detect aliasing/escape through a return or assignment RHS. */
export function carriesName(node, name) {
  if (node === name) return true
  if (!Array.isArray(node)) return false
  if (node[0] === '?:') return carriesName(node[2], name) || carriesName(node[3], name)
  if (node[0] === '&&' || node[0] === '||') return carriesName(node[1], name) || carriesName(node[2], name)
  if (node[0] === ',') return carriesName(node[node.length - 1], name)
  return false
}

const CONTROL_TRANSFER = new Set(['return', 'throw', 'break', 'continue'])

/** Does `body` contain return/throw/break/continue (not inside nested `=>`)? */
export function hasControlTransfer(body) {
  if (!Array.isArray(body)) return false
  if (CONTROL_TRANSFER.has(body[0])) return true
  if (body[0] === '=>') return false
  for (let i = 1; i < body.length; i++) if (hasControlTransfer(body[i])) return true
  return false
}

/** Does `body` contain a `continue` that targets THIS loop? */
export function hasOwnContinue(body) {
  if (!Array.isArray(body)) return false
  const op = body[0]
  if (op === 'continue') return true
  if (op === 'for' || op === 'while' || op === 'do') return false
  for (let i = 1; i < body.length; i++) if (hasOwnContinue(body[i])) return true
  return false
}

/** Does `body` contain `continue <label>` targeting the given label? Descends through nested
 *  loops (a labeled continue crosses loop boundaries) but not into closures. */
export function hasLabeledContinueTo(body, label) {
  if (!Array.isArray(body)) return false
  const op = body[0]
  if (op === 'continue' && body[1] === label) return true
  if (op === '=>') return false
  for (let i = 1; i < body.length; i++) if (hasLabeledContinueTo(body[i], label)) return true
  return false
}

export function hasOwnBreakOrContinue(body) {
  if (!Array.isArray(body)) return false
  const op = body[0]
  if (op === 'break' || op === 'continue') return true
  if (op === 'for' || op === 'while' || op === 'do' || op === '=>') return false
  for (let i = 1; i < body.length; i++) if (hasOwnBreakOrContinue(body[i])) return true
  return false
}

// === Arrow param normalization ===


export function extractParams(rawParams) {
  let p = rawParams
  if (Array.isArray(p) && p[0] === '()') p = p[1]
  return p == null ? [] : Array.isArray(p) ? (p[0] === ',' ? p.slice(1) : [p]) : [p]
}

export const PARAM_KIND = 0
export const PARAM_NAME = 1
export const PARAM_DEFAULT = 2
export const PARAM_PATTERN = 3

export function classifyParam(r) {
  if (Array.isArray(r) && r[0] === '...') return ['rest', r[1]]
  if (Array.isArray(r) && r[0] === '=') {
    if (typeof r[1] === 'string') return ['default', r[1], r[2]]
    return ['destruct-default', undefined, r[2], r[1]]
  }
  if (Array.isArray(r) && (r[0] === '[]' || r[0] === '{}')) return ['destruct', undefined, undefined, r]
  return ['plain', r]
}

export function collectParamNames(raw, out = new Set()) {
  for (const r of raw) {
    if (typeof r === 'string') out.add(r)
    else if (Array.isArray(r)) {
      if (r[0] === '=' && typeof r[1] === 'string') out.add(r[1])
      else if (r[0] === '...' && typeof r[1] === 'string') out.add(r[1])
      else if (r[0] === '=' && Array.isArray(r[1])) collectParamNames([r[1]], out)
      else if (r[0] === '[]' || r[0] === '{}' || r[0] === ',') collectParamNames(r.slice(1), out)
    }
  }
  return out
}

/** Every name bound ANYWHERE inside `node` — an arrow PARAM or a nested
 *  `let`/`const`/`var` declaration TARGET — recursing through further-nested
 *  arrows too. Position-insensitive on purpose (a mid-body shadow counts for
 *  the WHOLE subtree): a shadow-detection helper for census walks that observe
 *  INTO a captured closure (compile/analyze.js's dictValueTypeOf/
 *  mapValueTypeOf, compile/program-facts.js's observeProgramSlots) — once a
 *  name comes back in this set, a write to that name anywhere in `node` might
 *  be through the LOCAL binding rather than the outer captured one, so the
 *  caller must not attribute it to the outer receiver. Over-bailing only
 *  forfeits a census fact, never unsound — same precedent as analyze.js's
 *  scanBindingUses CAPTURE rule (that file's doc comment, ~line 65). */
export function collectAllBoundNames(node, out = new Set()) {
  if (!Array.isArray(node)) return out
  const op = node[0]
  if (op === '=>') collectParamNames(extractParams(node[1]), out)
  else if (op === 'let' || op === 'const' || op === 'var') {
    for (let i = 1; i < node.length; i++) {
      const d = node[i]
      collectParamNames([Array.isArray(d) && d[0] === '=' ? d[1] : d], out)
    }
  }
  for (let i = 1; i < node.length; i++) collectAllBoundNames(node[i], out)
  return out
}

// === Return-path queries (narrowing) ===

const collectReturnExprs = (node, out) => {
  if (!Array.isArray(node)) return
  const [op, ...args] = node
  if (op === '=>') return
  if (op === 'return') { if (args[0] != null) out.push(args[0]); return }
  for (const a of args) collectReturnExprs(a, out)
}

export const alwaysReturns = (n) => {
  if (!Array.isArray(n)) return false
  const op = n[0]
  if (op === '=>') return false
  if (op === 'return' || op === 'throw') return true
  if (op === '{}' || op === ';') return alwaysReturns(n[n.length - 1])
  if (op === 'if') return n.length >= 4 && alwaysReturns(n[2]) && alwaysReturns(n[3])
  return false
}

export const hasBareReturn = (n) => {
  if (!Array.isArray(n)) return false
  if (n[0] === '=>') return false
  if (n[0] === 'return' && n[1] == null) return true
  return n.some(hasBareReturn)
}

export const returnExprs = (body) => {
  if (isBlockBody(body)) {
    const out = []
    collectReturnExprs(body, out)
    return out
  }
  return [body]
}

// === Clone / compare / module body / bare refs ===

/** Deep-clone an AST node (arrays only; primitives pass through). */
export function cloneNode(node) {
  if (node == null || typeof node !== 'object') return node
  if (!Array.isArray(node)) return node
  return node.map(cloneNode)
}

/** Structural equality via JSON. AST nodes are JSON-serializable except i64.const
 *  BigInt payloads (NaN-box prefixes — dcbb433 routes pointer offsets through boxed
 *  forms); the replacer stringifies those as `<n>n` (cf. formatErrorNode in ctx.js). */
// Replacer for structural node-equality / dedup keys. JSON.stringify is the fast
// path, but it silently collapses values it can't round-trip: bigint throws, and —
// the subtle one — Infinity / -Infinity / NaN ALL stringify to `null` while -0
// stringifies to `0`. Two nodes differing ONLY in such a constant then serialize
// identically and compare equal — an unsound merge (SLP packs `[Inf,-Inf]` as one
// splat lane; CSE/LICM dedups distinct invariants). Tag each so it round-trips with
// Object.is semantics.
// Recursive keyer, NOT JSON.stringify with a replacer: the kernel's stringify
// silently dropped the replacer, so in-kernel nodeEqual collapsed the very
// constants the tagging exists to distinguish (a latent unsound SLP merge,
// host≠kernel). A plain walk behaves identically on both sides.
export function stableNodeKey(v) {
  if (Array.isArray(v)) { let s = '['; for (let i = 0; i < v.length; i++) s += (i ? ',' : '') + stableNodeKey(v[i]); return s + ']' }
  if (typeof v === 'bigint') return `${v}n`
  // Number.isNaN, not `v !== v`: `v` is a generic AST-leaf value here (the whole
  // point of this function), so in-kernel its kind is ambiguous and `!==` takes
  // jz's own bit-equality dispatch — a sign-set qNaN (x86 wasm arithmetic's
  // uncanonicalized 0/0 etc.) then reads bit-equal to itself and this guard misses
  // it (same root cause/fix as emitNum in ir.js — see that comment). Native no-op.
  if (typeof v === 'number' && (Number.isNaN(v) || v === Infinity || v === -Infinity || Object.is(v, -0)))
    return Number.isNaN(v) ? '#NaN' : v === Infinity ? '#Inf' : v === -Infinity ? '#-Inf' : '#-0'
  if (typeof v === 'string') return JSON.stringify(v)
  return String(v)  // numbers, booleans, null, undefined — all distinct spellings
}
export function nodeEqual(a, b) {
  return stableNodeKey(a) === stableNodeKey(b)
}

/** Property entries of an object-literal AST node (`['{}', …]`). */
export function descriptorProps(node) {
  if (!Array.isArray(node) || node[0] !== '{}') return null
  const body = node[1]
  if (body == null) return []
  if (Array.isArray(body) && body[0] === ',') return body.slice(1)
  return [body]
}

/** Comma-unwrapped entries from an object-literal constructor arg list. */
export function objectLiteralEntries(args) {
  const raw = args.length === 1 && Array.isArray(args[0]) && args[0][0] === ',' ? args[0].slice(1) : args
  return raw.filter(p => p != null)
}

/** String literal node → string, or null. */
export function literalString(node) {
  return Array.isArray(node) && node[0] == null && typeof node[1] === 'string' ? node[1] : null
}

/** Zero numeric literal node. */
export function isZeroLiteral(node) {
  return Array.isArray(node) && node[0] == null && node[1] === 0
}

/** Top-level module statements; null when `ast` is not module-shaped. */
export function moduleStmts(ast) {
  if (!Array.isArray(ast)) return null
  return ast[0] === ';' ? ast.slice(1).filter(Boolean) : [ast]
}

/** Unwrap esbuild module binding to `[name, init]`, or null. */
export function bindingOf(stmt) {
  if (!Array.isArray(stmt)) return null
  if (stmt[0] === '=' && typeof stmt[1] === 'string') return [stmt[1], stmt[2]]
  if ((stmt[0] === 'let' || stmt[0] === 'const' || stmt[0] === 'var') && stmt.length === 2 &&
      Array.isArray(stmt[1]) && stmt[1][0] === '=' && typeof stmt[1][1] === 'string')
    return [stmt[1][1], stmt[1][2]]
  return null
}

/** Identifier refs in value positions (skip decl names, member keys, object keys). */
export function collectBareRefs(node, out) {
  if (typeof node === 'string') return void out.add(node)
  if (!Array.isArray(node)) return
  if (node[0] === 'let' || node[0] === 'const' || node[0] === 'var') {
    for (let i = 1; i < node.length; i++)
      if (Array.isArray(node[i]) && node[i][0] === '=') collectBareRefs(node[i][2], out)
  } else if ((node[0] === '.' || node[0] === '?.') && typeof node[2] === 'string') {
    collectBareRefs(node[1], out)
  } else if (node[0] === ':') {
    collectBareRefs(node[2], out)
  } else {
    for (let i = 1; i < node.length; i++) collectBareRefs(node[i], out)
  }
}

/** Deep walk: `pred` on every node including bare identifiers; descends into arrows. */
export function someDeep(node, pred) {
  if (pred(node)) return true
  if (!Array.isArray(node)) return false
  for (let i = 1; i < node.length; i++) if (someDeep(node[i], pred)) return true
  return false
}

/** Alias for {@link extractParams}. */
export const paramList = extractParams

