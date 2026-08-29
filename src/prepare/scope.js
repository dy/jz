/**
 * Scope-chain machinery: resolveScope/isDeclared/prescanBlockDecls/pushScope/popScope,
 * plus binding-name collection, loop-local tracking, and identifier substitution used
 * while expanding destructuring and rewriting loop bodies.
 *
 * @module prepare/scope
 */

import { REFS_THROUGH_ARROWS, T, refsName } from '../ast.js'
import { ctx, declGlobal, err } from '../ctx.js'
import { mintLocal } from './ident-purity.js'
import { freshPrepareId, funcLocalNames, loopLocalNames, prepState, scopes, staticConstScopes } from './state.js'



/** Resolve variable name through block scope chain (innermost rename wins). */
export function resolveScope(name) {
  for (let i = scopes.length - 1; i >= 0; i--)
    if (scopes[i].has(name)) return scopes[i].get(name)
  return name
}

/** Check if name is declared in any current scope level. */
export function isDeclared(name) {
  return scopes.some(s => s.has(name))
}

/** Pre-register a block's immediate plain `let`/`const` binding names in the
 *  just-pushed scope frame (JS block hoisting): a closure textually BEFORE the
 *  decl must capture the BLOCK's binding, not an outer same-named one — the
 *  rename decision has to exist before the block's statements are traversed
 *  (`let x = 100; { let f = () => x; let x = 5; f() }` returns 5, not 100's
 *  bits). Rename policy is identical to prepDecl's traversal-time rule; the
 *  decl handler then consumes the mapping instead of minting its own.
 *  Destructure patterns keep their traversal-time registration (they never
 *  rename today; totality is the Stage-1a follow-up). Direct forward READS
 *  of a block `let` are TDZ errors in JS — invalid inputs, unconstrained. */
export function prescanBlockDecls(node) {
  const top = scopes[scopes.length - 1]
  if (!top) return
  const fnNames = funcLocalNames[funcLocalNames.length - 1]
  const scan = (s) => {
    if (!Array.isArray(s)) return
    // a nested bare [';' …] list is the SAME block scope (only {} creates one) —
    // the for-of lowering wraps bodies as [';', bindStmt, origBody]
    if (s[0] === ';') { for (let i = 1; i < s.length; i++) scan(s[i]); return }
    if (s[0] !== 'let' && s[0] !== 'const') return
    for (let i = 1; i < s.length; i++) {
      const d = s[i], t = Array.isArray(d) && d[0] === '=' ? d[1] : d
      for (const name of bindingNames(t)) {
        if (typeof name !== 'string' || top.has(name) || name.includes(T)) continue
        // loopLocalNames: a depth-0 loop-body binding a nested closure captures
        // (see its declaration) — mint it exactly like a depth!==0 local instead
        // of letting it fall through to the single-instance global spelling.
        const isLL = loopLocalNames.has(name)
        top.set(name, (prepState.depth !== 0 || isLL) ? mintForScope(name, isLL)
          : (isDeclared(name) || fnNames?.has(name)) ? `${name}${T}${freshPrepareId()}` : name)
      }
    }
  }
  scan(node)
}

export function pushScope(scope = new Map()) {
  scopes.push(scope)
  staticConstScopes.push([null, null, null])
}

export function popScope() {
  scopes.pop()
  staticConstScopes.pop()
}

export function bindingNames(pattern, out = new Set()) {
  if (typeof pattern === 'string') out.add(pattern)
  else if (Array.isArray(pattern)) {
    if (pattern[0] === '...' && typeof pattern[1] === 'string') out.add(pattern[1])
    else if (pattern[0] === '=') bindingNames(pattern[1], out)
    else if (pattern[0] === ':') bindingNames(pattern[2], out)
    else if (pattern[0] === '[]' || pattern[0] === '{}' || pattern[0] === ',') {
      for (const item of pattern.slice(1)) bindingNames(item, out)
    }
  }
  return out
}

/** Mint `name`'s local spelling and, if minting is because of loopLocalNames
 *  (a module-scope per-iteration capture — see its own declaration), record
 *  the FINAL minted spelling in the compile-persistent
 *  ctx.scope.moduleLoopCaptured (assemble.js's buildStartFn matches against
 *  the post-rename ast, so the pre-rename source name it was marked under is
 *  useless there). depth!==0 (an ordinary function-scope mint unrelated to
 *  this mechanism) leaves moduleLoopCaptured untouched. */
export function mintForScope(name, isLoopLocal) {
  const m = mintLocal(name)
  if (isLoopLocal) ctx.scope.moduleLoopCaptured.add(m)
  return m
}

/** Does any arrow inside `node` reference `name`? The capture test for the
 *  per-iteration for-head `let` lowering (pay only when actually captured). */
export function bodyCapturesName(node, name) {
  if (!Array.isArray(node)) return false
  if (node[0] === '=>') return refsName(node[2], name, REFS_THROUGH_ARROWS)
  for (let i = 1; i < node.length; i++) if (bodyCapturesName(node[i], name)) return true
  return false
}

/** Names bound by a `let`/`const` anywhere inside `node`, stopping at nested
 *  arrow boundaries (their own decls are that arrow's locals, irrelevant
 *  here). Feeds the module-scope per-iteration-binding scan in the `for`
 *  handler: every loop-body-declared name (the for-of/for-in desugared bind,
 *  the for-head captured-let copy-in, or an ordinary body-scoped `let`) is a
 *  candidate for loopLocalNames — checked against bodyCapturesName before
 *  actually being marked, so an uncaptured loop var still takes the cheaper
 *  single-instance global path. */
export function collectLoopDeclNames(node, out = new Set()) {
  if (!Array.isArray(node)) return out
  const op = node[0]
  if (op === '=>') return out
  if (op === 'let' || op === 'const') {
    for (let i = 1; i < node.length; i++) {
      const d = node[i]
      bindingNames(Array.isArray(d) && d[0] === '=' ? d[1] : d, out)
    }
  }
  for (let i = 1; i < node.length; i++) collectLoopDeclNames(node[i], out)
  return out
}

/** Mark `nm` loop-local for the CURRENT loop (loopLocalNames — scoped,
 *  popped when that loop's body finishes prepping) AND record it in the
 *  compile-persistent ctx.scope.moduleLoopCaptured, which assemble.js's
 *  buildStartFn consults once, after prepare is done, to box the (rare)
 *  subset of these names ALSO mutated after capture. See loopLocalNames'
 *  own declaration. */
export function markLoopLocal(nm) {
  loopLocalNames.add(nm)
}

/** Module-scope (depth 0) per-iteration binding scan for a loop body: mark
 *  every body-declared let/const a nested closure captures in loopLocalNames
 *  (pay-per-capture — an uncaptured loop var keeps the cheaper single-
 *  instance global) for the duration of `run()`, then restore. Shared by
 *  'for' (for-of/for-in/for-head-capture all funnel through the classic ';'
 *  branch after desugaring) and 'while' (do-while lowers to while). See
 *  loopLocalNames' own declaration for the full rationale. */
export function withLoopLocalNames(body, run) {
  let added = null
  if (prepState.depth === 0) {
    for (const nm of collectLoopDeclNames(body)) {
      if (!loopLocalNames.has(nm) && bodyCapturesName(body, nm)) {
        (added ||= []).push(nm)
        markLoopLocal(nm)
      }
    }
  }
  try { return run() }
  finally { if (added) for (const nm of added) loopLocalNames.delete(nm) }
}

/** Rename bare identifiers per `map` — literal nodes and non-computed property
 *  keys stay untouched. Used to point a for-head's cond/step at the carrier. */
export function substIdents(node, map) {
  if (typeof node === 'string') return map.get(node) ?? node
  if (!Array.isArray(node) || node[0] == null) return node
  if (node[0] === 'str') return node
  if (node[0] === '.') return ['.', substIdents(node[1], map), node[2]]
  // Property/label key position is not an identifier read (`{ i: i }` in a
  // for-head cond must rename only the VALUE side).
  if (node[0] === ':' && typeof node[1] === 'string') return [':', node[1], ...node.slice(2).map(n => substIdents(n, map))]
  return [node[0], ...node.slice(1).map(n => substIdents(n, map))]
}

// Element count of a prepared inline array literal `['[', e0, e1, …]` with no
// spread (spread → dynamic length). Returns null when not such a literal, so
// destructuring a non-literal source keeps its runtime element reads.
export const inlineArrayLen = (e) =>
  Array.isArray(e) && e[0] === '[' && !e.slice(1).some(x => Array.isArray(x) && x[0] === '...')
    ? e.length - 1 : null

export function declareGlobal(name, user = true) {
  if (prepState.depth !== 0 || typeof name !== 'string' || loopLocalNames.has(name)) return name
  if (ctx.scope.globals.has(name)) err(`'${name}' conflicts with a compiler internal — choose a different name`)
  declGlobal(name, 'f64')
  if (user) ctx.scope.userGlobals.add(name)
  return name
}

/** True if `node` contains a `break`/`continue` that belongs to it — i.e. not
 *  one nested inside its own function. (Nested loops are intentionally counted:
 *  an over-detection only opts into the safe frame-carrying lowering below.) */
const hasLoopJump = (node) => {
  if (!Array.isArray(node)) return false
  const op = node[0]
  if (op === 'break' || op === 'continue') return true
  if (op === '=>' || op === 'function') return false
  return node.some(hasLoopJump)
}

/** Retarget a for-in iteration's *own* unlabeled `break`/`continue` to explicit
 *  block labels — `break` to the construct-wide label, `continue` to this
 *  iteration's label. Nested loops/functions own their jumps and are skipped;
 *  labeled jumps already name their target and are left untouched. */
const retargetLoopJumps = (node, brkLabel, contLabel) => {
  if (!Array.isArray(node)) return node
  const op = node[0]
  if (op === 'break' && node.length === 1) return ['break', brkLabel]
  if (op === 'continue' && node.length === 1) return ['break', contLabel]
  if (op === 'for' || op === 'for-in' || op === 'while' || op === 'do'
      || op === '=>' || op === 'function') return node
  return node.map(c => retargetLoopJumps(c, brkLabel, contLabel))
}