/**
 * Whole-program function-namespace SRoA analysis (a user function used as a
 * property bag). Split out of analyze.js (pipeline-minimality slice); see
 * analyze.js's module header for the full split rationale and
 * `.work/archive/analyze-traversals.md` for the traversal inventory.
 *
 * @module compile/analyze/func-namespaces
 */
import { isFuncRef, STATIC_BASE } from '../../ast.js'
import { ctx, err } from '../../ctx.js'

/**
 * The one named function a function's own property holds for good, or null:
 * every store into the property, through the function's name at any depth,
 * an alias, a parameter or a computed key, stores that function, and the
 * function never reaches code that may store another (the summary's
 * `propFunction`). Decided once per compile, at the first ask: a summary of
 * code later passes rewrote may know less, and the namespace flattening, the
 * program index and the emitter must give one answer (a call made direct
 * where the index left its target unreached, or a slot read whose function
 * the index released, breaks the module).
 */
export const propFunctionOf = (fn, prop) => {
  const key = `${fn}.${prop}`, held = ctx.funcs.heldProps
  if (held.has(key)) return held.get(key)
  if (!ctx.summary) return null
  const r = ctx.summary.propFunction(fn, prop)
  held.set(key, r)
  return r
}

/** A derived class's copy of its base's static that reads its receiver, and a
 *  `super.m` the class resolved, take the member as the class defining it
 *  does (jzify/classes.js staticCopy): each class from the base up to that one
 *  must store nothing else into the name, here or in any function, where JS
 *  would read the newer value through the base. Rejected rather than read stale. */
export const checkStaticCopies = () => {
  for (const { cls, slot, held } of ctx.transform.staticCopies ?? []) for (const c of held)
    if (ctx.summary?.storedFunction(c, slot) !== `${c}$${slot}`)
      err(`class \`${cls}\` takes the static \`${slot.replace(/__[gs]et$/, '')}\` of its base \`${c}\` as declared, but the program stores another value into it: a static that reads \`this\` is bound to each class deriving it where the class is defined`)
}

/** `fn$prop`, prepare's lift of a top-level `fn.prop = arrow`, where the
 *  property holds it for good (`propFunctionOf`): a call of the property is
 *  that function's own call. Null otherwise. */
export const liftedPropOf = (fn, prop) => {
  if (!ctx.funcs.names.has(fn)) return null
  const held = propFunctionOf(fn, prop)
  if (held == null || !ctx.funcs.names.has(held) || held.length <= prop.length + 1 || !held.endsWith('$' + prop)) return null
  // its own lift, or, for a derived class's static it never holds itself, its base's
  const owner = held.slice(0, -prop.length - 1)
  return (owner === fn || ctx.funcs.names.has(owner)) && !ctx.funcs.multiProp.has(`${owner}.${prop}`) ? held : null
}

/**
 * Whole-program function-namespace SRoA analysis.
 *
 * A user function used as a property bag — `parse.space = …; parse.step()` —
 * is otherwise compiled as a dynamic object: each `f.prop` write becomes a
 * `__dyn_set` into a hash side-table keyed by the closure pointer, each read a
 * `__dyn_get`. But a function's property table can never be observed by the
 * host (the host gets only the callable; the table lives in jz linear memory),
 * so the property set is statically closed — jz sees every `f.PROP` site. When
 * `f` never escapes as a bare value, each property dissolves:
 *   - written once, at module top level, to a known function → the property is
 *     constant: every `f.PROP` site rewrites straight to that function name
 *     (direct calls, no storage at all).
 *   - otherwise → a mutable f64 module global (`global.get` / `global.set`).
 *
 * Escape-as-CALLEE vs escape-as-TABLE: `f`/`f.PROP` appearing as a call's
 * callee (`f(...)`, `f?.(...)`, `f.prop(...)`, `f.prop?.(...)`) or as the
 * exported value (`export`) hands out only the invoked/callable function
 * VALUE — never a handle onto f's property table — so neither disqualifies.
 * Every other bare mention of `f` (stored into a data structure, aliased
 * `let g = f`, compared, an argument to anything but treated as a plain call
 * position, `f[computed]`/`f?.[computed]`) COULD leak a reference the table
 * is reachable through, so it still disqualifies (`start strict`: this is
 * deliberately not trying to prove higher-order callback safety yet).
 *
 * Returns `Map<funcName, { disq, rebound, props:Set, valRead:Set,
 * writes:Map<prop,[{rhs,atInit}]> }>` — `valRead` is the subset of props read
 * as a value (not merely called). `flattenFuncNamespaces` (plan.js) turns it
 * into the rewrite. A name carrying `disq` escapes / is reassigned / is
 * computed-indexed: its table stays; `rebound` (the name itself reassigned)
 * means even a call of a property may reach another function's.
 */
export function analyzeFuncNamespaces(ast) {
  const funcNames = ctx.funcs.names
  if (!funcNames || !funcNames.size) return new Map()

  const ns = new Map()
  const rec = (name) => {
    let r = ns.get(name)
    if (!r) ns.set(name, r = { disq: false, rebound: false, props: new Set(), valRead: new Set(), writes: new Map() })
    return r
  }
  // `['.'|'?.', f, P]` member where f is a known function and P a string key.
  const memberOf = (n) =>
    Array.isArray(n) && (n[0] === '.' || n[0] === '?.') &&
    isFuncRef(n[1], funcNames) && typeof n[2] === 'string' ? n : null

  // `atInit` — node is a direct top-level statement (constant-fold candidate);
  // read only at the `=` handler, never propagated into sub-expressions.
  function visit(node, atInit) {
    if (typeof node === 'string') {
      // Bare mention of a known function in value position — it escapes; an
      // alias could reach its property table. Disqualify.
      if (funcNames.has(node)) rec(node).disq = true
      return
    }
    if (!Array.isArray(node)) return
    const op = node[0]

    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=') {
          if (!isFuncRef(d[1], funcNames)) visit(d[1], false)  // skip f's own decl
          // `let f = f` is prepare's self-name placeholder for a lifted function —
          // skip it (a bare visit would falsely disqualify f). Any other funcRef
          // rhs (`let g = f`) is a real alias and must disqualify f.
          if (!(isFuncRef(d[2], funcNames) && d[2] === d[1])) visit(d[2], false)
        } else visit(d, false)
      }
      return
    }

    if (op === 'export') {
      // Exporting the function value is safe — the host gets the callable,
      // never the linear-memory property table. Skip bare function children.
      for (let i = 1; i < node.length; i++)
        if (!isFuncRef(node[i], funcNames)) visit(node[i], false)
      return
    }

    if (op === '=') {
      const m = memberOf(node[1])
      if (m) {
        const r = rec(m[1]); r.props.add(m[2])
        // a derived class's base (jzify/classes.js): a name the class does not
        // hold reads the base's table, which the runtime walks: both keep theirs
        if (m[2] === STATIC_BASE) r.disq = true
        let w = r.writes.get(m[2]); if (!w) r.writes.set(m[2], w = [])
        w.push({ rhs: node[2], atInit })
        visit(node[2], false)
        return
      }
      if (isFuncRef(node[1], funcNames)) { const r = rec(node[1]); r.disq = r.rebound = true }  // reassignment
      else visit(node[1], false)
      visit(node[2], false)
      return
    }

    // `f(...)` / `f?.(...)` and `f.PROP(...)` / `f.PROP?.(...)` — escape-as-
    // CALLEE, not escape-as-table. Calling f (or a prop of f) hands the host/
    // callee only the invoked function VALUE, never f's property table, so
    // neither shape disqualifies. `prep()` keeps `?.()` a distinct op from
    // `()` (same flattened-args shape — see prepare/index.js's `'?.()'`
    // handler). Mirror both call forms here.
    if (op === '()' || op === '?.()') {
      const m = memberOf(node[1])
      if (m) rec(m[1]).props.add(m[2])
      else if (!isFuncRef(node[1], funcNames)) visit(node[1], false)  // bare f(...)/f?.(...) ok
      for (let i = 2; i < node.length; i++) visit(node[i], false)
      return
    }

    // `f.PROP` / `f?.PROP` as a plain value (read) — not the callee of a call
    // (those are handled by the `()`/`?.()` branch above). A value-read means
    // the property's stored value must stay retrievable; devirt cannot drop it.
    const m = memberOf(node)
    if (m) { const r = rec(m[1]); r.props.add(m[2]); r.valRead.add(m[2]); return }

    // Computed `f[k]` / `f?.[k]` — the key set is no longer static: a genuine
    // table escape (unlike computed CALL args, this reaches arbitrary props).
    if ((op === '[]' || op === '?.[]') && isFuncRef(node[1], funcNames)) {
      rec(node[1]).disq = true
      for (let i = 2; i < node.length; i++) visit(node[i], false)
      return
    }

    for (let i = 1; i < node.length; i++) visit(node[i], false)
  }

  const visitTop = (n) => {
    if (Array.isArray(n) && n[0] === ';')
      for (let i = 1; i < n.length; i++) visit(n[i], true)
    else visit(n, true)
  }
  visitTop(ast)
  // Bundled multi-module programs keep each module's top-level statements in
  // moduleInits, not `ast` — the `f.prop = …` writes that define a namespace
  // live there. Walk them at init scope so writes are recorded and an escape
  // inside init code still disqualifies.
  for (const mi of ctx.module.moduleInits || []) visitTop(mi)
  for (const fn of ctx.funcs.list) if (fn.body && !fn.raw) visit(fn.body, false)

  return ns
}
