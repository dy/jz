/**
 * Dead-code and constant-folding predicates shared by the statement-sequence and
 * conditional handlers: boolean-negation stripping, dead-postfix/unreachable-code
 * removal, and literal truthiness (litTruth/alwaysTruthy/alwaysFalsy).
 *
 * @module prepare/const-fold
 */



// In a pure boolean position (consumer reads only truthiness) `!!e` is exactly `e`.
// Drop redundant double-negation; recurse so `!!!!e → e`. NOT valid for `&&`/`||`
// operands — those are value-preserving (`!!a && b` returns `false`, not `a`).
export const stripBoolNot = c => {
  while (Array.isArray(c) && c[0] === '!' && Array.isArray(c[1]) && c[1][0] === '!') c = c[1][1]
  return c
}
// In a statement (value-discarded) position, postfix `x++`/`x--` is lowered to `(++x) − 1` /
// `(--x) + 1` to recover the old value — but nobody reads it, so drop the ∓1 and keep the bare
// increment. (`obj.p++` lowers via `obj.p = obj.p + 1`, also wrapped.) Cleaner AST for the loop/
// recurrence passes; codegen already discarded the ∓1, so this is purely canonicalization.
const isOne = n => Array.isArray(n) && n[0] == null && n[1] === 1
export const dropDeadPostfix = s => {
  if (Array.isArray(s) && s.length === 3 && isOne(s[2]) && Array.isArray(s[1])) {
    const inner = s[1][0]
    if ((s[0] === '-' && (inner === '++' || inner === '=')) ||
        (s[0] === '+' && (inner === '--' || inner === '='))) return s[1]
  }
  return s
}
// Constant-condition `if` at STATEMENT level folds to its live arm (dual of the
// '?:' emitter's literal-condition fold, but at prep — the proper level: the dead
// arm's code never reaches analysis/emission at all). `litTruth` is deliberately
// literal-only, so a host-capability probe (`typeof WebAssembly === 'undefined'`,
// folded by resolveTypeof under spec §13.5.3) is the canonical trigger.
export const foldConstIf = (s) => {
  if (!Array.isArray(s) || s[0] !== 'if') return s
  const t = litTruth(s[1])
  return t === true ? s[2] : t === false ? (s[3] ?? null) : s
}
// Unreachable-tail pruning: statements after an unconditional `return`/`throw`
// never execute — without this, a folded host-capability early-return
// (`if (typeof WebAssembly === 'undefined') return false` → `return false`)
// leaves the whole host-only remainder of the function flowing through
// analysis + emission (snapshot.js's hermetic-instantiation block was the live
// case: its `new WebAssembly.Global(..., 0n)` tripped the strict BigInt
// boundary check from provably-dead code). Hoisting safety: `function`
// declarations don't survive to this IR (jzify lowers them to bindings), and a
// live-prefix closure referencing a tail-declared binding is permanently-TDZ
// code — but rather than silently change that to a compile error, BAIL (keep
// the tail) whenever the live prefix references any name the tail declares.
const declNamesOf = (s, out) => {
  if (!Array.isArray(s)) return
  if ((s[0] === 'let' || s[0] === 'const') && s.length) {
    for (let i = 1; i < s.length; i++) {
      const d = s[i]
      if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') out.add(d[1])
      else if (typeof d === 'string') out.add(d)
    }
  }
}
const referencesAny = (node, names) => {
  if (typeof node === 'string') return names.has(node)
  if (!Array.isArray(node)) return false
  for (let i = 1; i < node.length; i++) if (referencesAny(node[i], names)) return true
  return false
}
export const truncateUnreachable = (list) => {
  for (let i = 0; i < list.length - 1; i++) {
    const s = list[i]
    if (Array.isArray(s) && (s[0] === 'return' || s[0] === 'throw')) {
      const tail = list.slice(i + 1)
      const declared = new Set()
      for (const t of tail) declNamesOf(t, declared)
      if (declared.size) {
        for (let k = 0; k <= i; k++) if (referencesAny(list[k], declared)) return list
      }
      return list.slice(0, i + 1)
    }
  }
  return list
}
export const stringValue = node => Array.isArray(node) && node[0] == null && typeof node[1] === 'string' ? node[1] : null
export const MUTATING_ARRAY_METHODS = new Set(['copyWithin', 'fill', 'pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift'])

// Always-truthy / always-falsy over PREPPED IR: literals plus the short-circuit
// lattice — `a || b` is always-truthy when either arm always is, `a && b` when
// both are; duals for falsy. Powers dead-arm elimination in the '||'/'&&'
// handlers: resolveTypeof folds a guard arm to a literal mid-chain
// (`x || typeof g === 'undefined' || g.member`) and left-associativity buries
// it one level deep, where emit's literal-LHS fold never looks. Dropping the
// dead tail at prep keeps its host-global reads out of the import section.
const litTruth = n => Array.isArray(n) && n.length === 2 && n[0] == null ? !!n[1]
  : Array.isArray(n) && n[0] === 'str' && typeof n[1] === 'string' ? !!n[1] : null
export const alwaysTruthy = (n) => litTruth(n) ?? (Array.isArray(n) &&
  (n[0] === '||' ? alwaysTruthy(n[1]) || alwaysTruthy(n[2])
    : n[0] === '&&' && alwaysTruthy(n[1]) && alwaysTruthy(n[2])))
export const alwaysFalsy = (n) => {
  const l = litTruth(n)
  return l != null ? !l : Array.isArray(n) &&
    (n[0] === '&&' ? alwaysFalsy(n[1]) || alwaysFalsy(n[2])
      : n[0] === '||' && alwaysFalsy(n[1]) && alwaysFalsy(n[2]))
}