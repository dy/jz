/**
 * Module evaluation and namespace objects.
 *
 * A bundled module's statements run at start-up, before its importers', in
 * the order ES evaluates them (ctx.module.moduleInits). A module that only
 * `import()` reaches (jzify hoistDynamicImports: a lazy namespace import)
 * evaluates on its namespace's first read instead: its statements move into a
 * loader that runs once, after the loaders of the lazy modules it imports. A
 * module a static import reaches from the entry is evaluated at start-up and
 * never again, however many `import()`s name it.
 *
 * A namespace read as a value (the result of `import()`, an `import * as ns`
 * passed on) is one object per module, made on the first read: each export
 * under its name in code-unit order, as ES lists them, the value itself or a
 * getter where a function of the program may assign the binding later.
 *
 * @module prepare/module-eval
 */
import { ctx } from '../ctx.js'
import { T, ACCESSOR_GET, MUTATE_OPS, walkAst } from '../ast.js'
import { frameRoots } from '../function.js'

/** An edge of the module graph, from the module preparing now (the entry when none is). */
export const importEdge = (to, lazy = false) =>
  (ctx.module.importEdges ??= []).push([ctx.module.moduleStack.at(-1) ?? null, to, lazy])

const recordOf = (exports) => { for (const r of ctx.module.resolvedModules.values()) if (r.exports === exports) return r }
// Functions take the compiler's prefix; the bindings a module may get (its
// evaluation state and error, its namespace object) are globals its functions
// read, which a T-named declaration at module level is not (a prepare temp of
// the start function), so they are spelled like prepare's other module-level
// bindings (literals.js `__salit`).
const nsOf = (r) => `${r.prefix}$${T}ns`
const loaderOf = (r) => `${r.prefix}$${T}load`

/** A module's namespace read as a value: a call of the function that makes it. */
export function namespaceValue(exports) {
  const r = recordOf(exports)
  ;(ctx.module.nsValues ??= new Set()).add(r)
  return ['()', nsOf(r), null]
}

// A module's statements in its loader: its bindings stay globals, so the
// declaration of one is the assignment it makes, a const's included (the
// loader's write is its initialization); a closure's own stay.
const assignDecls = (n) => {
  if (!Array.isArray(n) || n[0] == null || n[0] === '=>') return n
  if (n[0] === 'let' || n[0] === 'const') {
    const parts = n.slice(1).map(d => {
      const name = typeof d === 'string' ? d : d[0] === '=' && typeof d[1] === 'string' ? d[1] : null
      if (name == null || !ctx.scope.globals.has(name)) return [n[0], assignDecls(d)]
      ctx.scope.consts?.delete(name)
      return ['=', name, typeof d === 'string' ? [, undefined] : assignDecls(d[2])]
    })
    return parts.length === 1 ? parts[0] : [',', ...parts]
  }
  for (let i = 1; i < n.length; i++) n[i] = assignDecls(n[i])
  return n
}

/** Once every module is prepared: move each lazy module's statements into its
 *  loader and make the namespaces read as values. `prep` declares at the top
 *  level, as the entry does. */
export function settleModules(prep) {
  const edges = ctx.module.importEdges ?? [], values = ctx.module.nsValues ?? new Set()
  if (!values.size && !edges.some(e => e[2])) return
  const records = ctx.module.resolvedModules
  // What the entry reaches through static imports, and the compiler's own
  // modules; the rest of what `import()` reaches is lazy.
  const eager = new Set(), lazy = new Set()
  const reach = (from) => { for (const [a, b, l] of edges) if (a === from && !l && !eager.has(b)) { eager.add(b); reach(b) } }
  reach(null)
  for (const spec of records.keys()) if (spec.startsWith('jz:') && !eager.has(spec)) { eager.add(spec); reach(spec) }
  const pull = (spec) => {
    if (eager.has(spec) || lazy.has(spec)) return
    lazy.add(spec)
    for (const [a, b, l] of edges) if (a === spec && !l) pull(b)
  }
  for (const [, b, l] of edges) if (l) pull(b)

  // A binding assigned after its module ran: by a function, or a closure the module made.
  const assigned = new Set()
  const note = (n) => { if (MUTATE_OPS.has(n[0]) && typeof n[1] === 'string') assigned.add(n[1]) }
  for (const f of ctx.funcs.list) if (f.body) for (const root of frameRoots(f)) walkAst(root, { enter: note })
  const closures = (n) => { if (!Array.isArray(n)) return; if (n[0] === '=>') walkAst(n, { enter: note }); else for (let i = 1; i < n.length; i++) closures(n[i]) }
  for (const init of ctx.module.moduleInits) closures(init)

  const decls = []
  const define = (name, body) => {
    prep(['const', ['=', name, ['=>', ['()', null], ['{}', [';', ...body]]]]])
    return ctx.funcs.list.find(f => f.name === name)
  }
  for (const spec of lazy) {
    // The loader runs the module once, after its lazy imports; one that threw
    // throws its error again for every later import (ES module Evaluate: an
    // errored module keeps its [[EvaluationError]]).
    const r = records.get(spec), state = `${r.prefix}$__state`, error = `${r.prefix}$__error`
    decls.push(['let', ['=', state, [null, 0]]], ['let', error])
    const deps = [...new Set(edges.filter(([a, b, l]) => a === spec && !l && lazy.has(b)).map(e => e[1]))]
    const loader = define(loaderOf(r), [
      ['if', state, [';', ['if', ['===', state, [null, 2]], ['throw', error]], ['return']]],
      ['try', [';', ['=', state, [null, 1]], ...deps.map(d => ['()', loaderOf(records.get(d)), null])],
        ['catch', 'e', [';', ['=', state, [null, 2]], ['=', error, 'e'], ['throw', 'e']]]]])
    const at = ctx.module.moduleInits.indexOf(r.init)
    if (at < 0) continue
    ctx.module.moduleInits.splice(at, 1)
    // prepared, the try is `['catch', body, param, handler]`
    const init = assignDecls(r.init), run = loader.body[1].find(st => Array.isArray(st) && st[0] === 'catch')
    run[1] = [';', ...(run[1]?.[0] === ';' ? run[1].slice(1) : [run[1]]), ...(init[0] === ';' ? init.slice(1) : [init])]
  }
  for (const r of values) {
    const obj = `${r.prefix}$__ns`
    decls.push(['let', obj])
    const props = [...r.exports.keys()].sort().map((name, i) => {
      const v = r.exports.get(name)
      if (v instanceof Map) return [':', name, namespaceValue(v)]   // `export * as name from`
      if (!assigned.has(v)) return [':', name, v]
      // a live binding: the literal's getter (jzify/classes.js lowerObjectLiteralAccessors)
      ;(ctx.transform.literalAccessorNames ??= new Set()).add(name)
      const get = `${r.prefix}$${T}get${i}`
      prep(['const', ['=', get, ['=>', ['()', null], v]]])
      return [':', name + ACCESSOR_GET, get]
    })
    define(nsOf(r), [...(lazy.has(r.spec) ? [['()', loaderOf(r), null]] : []),
      ['return', ['??=', obj, props.length ? ['{}', [',', ...props]] : ['{}']]]])
  }
  if (decls.length) ctx.module.moduleInits.unshift(prep([';', ...decls]))
}
