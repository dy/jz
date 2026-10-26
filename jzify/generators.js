/**
 * Generators — regenerator-style state machines, no stack suspension.
 *
 * `function* g(a) { … yield E … }` lowers to a factory arrow returning
 * `{ next, return }` closures over shared mutable state: the body becomes a
 * dispatch loop over a state local, each yield splits a state boundary, and
 * `next(v)` is an ordinary closure call through the uniform ABI (mutable
 * captures already ship). Sync only — no event loop, no microtasks.
 *
 * v1 surface (everything else rejects with a precise message):
 *   - yield as a statement, or as the RHS of `let x = yield E` / `x = yield E`;
 *     one anywhere else in an expression is hoisted to a statement of its own,
 *     what the expression evaluates before it first (jzify/async.js)
 *   - yield inside if/else, while, do-while, C-style for (in its test, step
 *     and initializer too), switch (in a case's test too) and labeled
 *     statements (any nesting)
 *   - yield inside a for-of or for-in body: the loop desugars to ones the
 *     machine splits (eachLoop), its iterator closed as a for-of closes it
 *   - plain `return E` anywhere; break and continue, labeled or not, of a
 *     statement split into states
 *   - compound statements WITHOUT yield stay atomic (later passes handle them)
 *   - yield* E — delegates to ANY iterator-protocol value (sent values thread,
 *     throw() and return() go to the delegate's own, the completion value
 *     lands in `x = yield* E`)
 *   - an async body's `await E` (jzify/async.js) suspends as a yield does; the
 *     value it resumes with is `__awaited(a, sent)`, `a` holding E, which the
 *     program summary types as the settled value of E
 *   - an async generator's machine yields tagged records to its driver
 *     (jz:asyncgen): an await, a yield, or a delegate's value
 *   - try/catch/finally across yields: a completion leaving a guarded body (a
 *     throw, return, break or continue, or a return() at a yield) runs the
 *     finally blocks it crosses, which may yield themselves
 *   - for-of closes its iterator when its body leaves early (closingLoop)
 *   - block scopes: each binding spelled apart, a closure in a loop the
 *     machine splits keeping its iteration's bindings (resolveLocals)
 *   - destructuring declarations, catch and for-of patterns of any shape, a
 *     yield in a default or computed key running the steps (patternSteps)
 *   - function and class declarations in any block (declarations)
 * Out (v1): an object rest beside a yield or await in a destructuring default.
 *
 * @module jzify/generators
 */

import { walkAst, some, TDZ, withLoc, noted, collectParamName, extractParams } from '../src/ast.js'
import { ctx } from '../src/ctx.js'

const isYield = (n) => Array.isArray(n) && (n[0] === 'yield' || n[0] === 'yield*' || n[0] === 'await')
/** A desugar's own call of a well-known member it has probed (`v['@@iterator']()`
 *  after `v['@@iterator'] != null`): a member call the iterator rewrite
 *  (transform.js) leaves alone, where a program's call is `__it_from(v)`. */
export const probe = (v, prop) => Object.assign(['.', v, prop], { probe: true })
// THE one canonical function boundary for every control-effects walker in
// this layer (hasYield/hasReturn/hasFreeJump/collectLocals here, async.js's
// await mapper via import): a nested function form OWNS its yields, returns,
// jumps, and declarations — none of them belong to the enclosing machine.
// 'async' is the pre-lowering wrapper node; 'class' bodies hold methods
// (each its own function). Walkers that stopped only at '=>' (or nowhere,
// hasYield) misrouted nested function declarations/expressions: their inner
// `return` forced statement decomposition and then read as a machine return
// ("yield inside `function`" rejections for previously-supported bodies).
export const FN_BOUNDARY_OPS = new Set(['=>', 'function', 'function*', 'class', 'async'])

const fnBoundary = (n) => FN_BOUNDARY_OPS.has(n[0])
const hasYield = (n) => some(n, isYield, { boundary: fnBoundary })

// A break/continue that would bind OUTSIDE this statement (its target was
// decomposed into states, so the raw op would bind my dispatch while(1) instead).
// An inner loop binds its own break and continue, a switch its break, a label
// its jumps; nested function forms bind their own.
const hasFreeJump = (n, loops = 0, switches = 0, labels = null) => {
  if (!Array.isArray(n)) return false
  const op = n[0]
  if (op === 'break' || op === 'continue')
    return n[1] != null ? !labels?.includes(n[1]) : op === 'continue' ? loops === 0 : loops + switches === 0
  if (FN_BOUNDARY_OPS.has(op)) return false
  if (op === ':' && typeof n[1] === 'string') return hasFreeJump(n[2], loops, switches, [...(labels || []), n[1]])
  const loop = op === 'while' || op === 'do' || op === 'for' ? 1 : 0, sw = op === 'switch' ? 1 : 0
  for (let i = 1; i < n.length; i++) if (hasFreeJump(n[i], loops + loop, switches + sw, labels)) return true
  return false
}

// A `return` anywhere in this statement (same canonical boundary — a nested
// function form's own return belongs to IT, not this generator/async body).
// Needed alongside hasYield: a compound statement with no yield but a plain
// `return` is NOT inert — splicing it atomically (below) would let the return
// execute as a bare host return out of the __next closure instead of the
// {value,done} record next()'s caller (__async_run, or a manual .next()) reads,
// corrupting every settlement (numbers included, worst on heap/NaN-boxed values
// read back as a wrong-shaped result).
const hasReturn = (n) => {
  if (!Array.isArray(n)) return false
  if (FN_BOUNDARY_OPS.has(n[0])) return false
  return n[0] === 'return' || n.some(hasReturn)
}

// A statement the machine splits into states (the rest stay atomic): one
// holding a yield or an await, a return, or a jump out of it.
const decomposes = (st) => hasYield(st) || hasReturn(st) || hasFreeJump(st)

// Canonical statement-list view of any body/branch node: '{}' unwraps
// (recursively — a block's payload may itself be a ';' list or one stmt),
// ';' splits, anything else is a single statement. Shared by the machine
// entry normalization and every flattenStmt branch walk.
const blockStmts = (b) =>
  b == null ? []
  : Array.isArray(b) && b[0] === '{}' ? blockStmts(b[1])
  : Array.isArray(b) && b[0] === ';' ? b.slice(1)
  : [b]

const S = { NEXT: '__s', SENT: '__sent', ERR: '__err', THR: '__thr', THRSET: '__thrset' }

/** A loop over an iterator, closed when its body leaves early (IteratorClose):
 *  `open` is set while the body runs. A break, return or outward jump runs
 *  `close`, whose error propagates; an exception runs `abort`, which swallows
 *  its own, and stands. Leaving through the iterator itself (its next(), done
 *  or value) closes nothing. A body that cannot leave but by an exception
 *  (`leavesLoop`) needs no finally. */
export const closingLoop = (loop, open, close, abort, error, body) => ['try', ['{}', [';', loop]],
  ['catch', error, ['{}', [';', ['if', open, ['{}', [';', ['=', open, [null, false]], ...abort]]], ['throw', error]]]],
  ...(leavesLoop(body) ? [['finally', ['{}', [';', ['if', open, ['{}', [';', ...close]]]]]]] : [])]

/** Whether statements of a loop's body can leave it other than by finishing
 *  or throwing: a return, a break of it, a labeled jump, or a yield (where a
 *  return() can arrive). A nested loop or switch binds its own break. */
const leavesLoop = (n, depth = 0) => {
  if (!Array.isArray(n)) return false
  const op = n[0]
  if (FN_BOUNDARY_OPS.has(op)) return false
  if (op === 'return' || op === 'yield' || op === 'yield*') return true
  if (op === 'break') return n[1] != null || depth === 0
  if (op === 'continue') return n[1] != null
  const inner = op === 'while' || op === 'do' || op === 'for' || op === 'switch' ? depth + 1 : depth
  for (let i = 1; i < n.length; i++) if (leavesLoop(n[i], inner)) return true
  return false
}

/** Whether a generator body's return() does more than end the machine: a
 *  finally or a `using` to run, a yield* delegate or a for-of suspended in its
 *  body to close. A loop over a generator that does none has nothing to close. */
export const closesOnReturn = (body) => some(body, n => n[0] === 'finally' || n[0] === 'yield*' || n[0] === 'using' ||
  n[0] === 'for' && Array.isArray(n[1]) && n[1][0] === 'of' && hasYield(n[2]), { boundary: fnBoundary })

/** A for-of head's binding of one value: a declaration, or an assignment to its target. */
export const bindTo = (decl, value) => Array.isArray(decl) && (decl[0] === 'let' || decl[0] === 'const' || decl[0] === 'var')
  ? [decl[0], ['=', decl[1], value]] : ['=', decl, value]
const bodyStmts = (body) => Array.isArray(body) && body[0] === ';' ? body.slice(1) : [body]
// A block's own statements: a block inside it is a statement of its own.
const ownStmts = (n) => n == null ? [] : Array.isArray(n) && n[0] === '{}' ? (n[1] == null ? [] : Array.isArray(n[1]) && n[1][0] === ';' ? n[1].slice(1) : [n[1]])
  : Array.isArray(n) && n[0] === ';' ? n.slice(1) : [n]
/** The names a binding pattern binds. */
const patternNames = (p) => { const out = new Set(); collectParamName(p, out); return [...out] }
/** A loop under its labels, outermost first. */
export const labeled = (labels, loop) => labels ? labels.reduceRight((l, name) => [':', name, l], loop) : loop

// ES2025 iterator helpers on iterator VALUES ride `jz:iter-helpers` (src/std),
// imported when a program that mints iterators also uses helper methods in
// non-fusable positions (chain stored as a value, helper on an unknown
// receiver) or tests `instanceof Iterator`; generator objects then mint
// through `__it_mk`. `Array.from(x)` over iterator values rides `jz:iter-arr`.

export function createGeneratorLowering({ transform, transformParams, err, generatorNames, generatorCloses, genTemp, iterProto, lowerArguments, hoistSuspensions, hoistExpr, enterMachineScope, leaveBuiltinScope }) {
  // ---- the body's bindings, resolved ----
  // The machine hoists every declaration of its body into the factory scope,
  // where all its states see it, so each takes a spelling of its own: a
  // top-level one its name (a `var` hoisted under a parameter's name is the
  // parameter), a block's its name unless a parameter, a name the body reads
  // from outside it or an earlier binding holds it, then `name$k`; every
  // reference reads the binding its scope resolves to, a forward one too. A
  // binding of a scope the machine enters again (one a loop it splits runs
  // through) that a closure captures lives in a cell, `{ v }`, made each time
  // the scope is entered (a for-head's copied into a fresh one each
  // iteration, as JS copies it), and a closure reads the cells it was made
  // with: `((x) => () => x.v)(x)`. Nested functions keep their bindings.
  const resolveLocals = (stmts, params) => {
    const deep = (n) => Array.isArray(n) ? noted(n, n.map(deep)) : n
    stmts = stmts.map(deep)
    const scopes = new WeakMap(), reads = new WeakMap(), free = new Set(), seen = new Set(), tops = [], nested = []
    const paramScope = { parent: null, names: new Map(), machine: false }
    for (const p of params) paramScope.names.set(p, { name: p, spelling: p })
    const root = { parent: paramScope, names: new Map(), machine: true, top: true, flat: true, reenter: false }
    let emitting = false, outer = null
    const UNDEF = [null, undefined]
    const cellOf = (v) => ['{}', [':', 'v', v]]
    const at = (b) => b.cell ? ['.', b.spelling, 'v'] : b.spelling
    const items = (n) => n == null ? [] : Array.isArray(n) && n[0] === ',' ? n.slice(1) : [n]
    const commas = (list) => list.length === 0 ? null : list.length === 1 ? list[0] : [',', ...list]
    // a scope per node and role, made while scanning and found again while emitting
    const scope = (node, tag, parent, props = {}) => {
      let m = scopes.get(node)
      if (!m) { m = new Map(); scopes.set(node, m) }
      let s = m.get(tag)
      if (!s) {
        s = { parent, names: new Map(), machine: parent.machine && !props.fn && !props.own, top: false,
          fn: !!props.fn, flat: !!props.flat, reenter: !!props.flat && (!!parent.reenter || !!props.loop) }
        m.set(tag, s)
      }
      return s
    }
    const bind = (s, name) => {
      if (typeof name !== 'string' || !name || s.names.has(name)) return
      // a top-level `var` (a bare `let`) under a parameter's name is the parameter
      if (s.top && paramScope.names.has(name)) return
      const b = { name, spelling: name, cell: false, captured: false, machine: s.machine, top: s.top, reenter: s.reenter }
      s.names.set(name, b)
      if (b.machine) (b.top ? tops : nested).push(b)
    }
    const bindPattern = (s, p) => { for (const n of patternNames(p)) bind(s, n) }
    // a list's declarations bind where the list begins, as JS hoists them in their scope
    const declare = (list, s) => {
      for (let st of list) {
        if (!Array.isArray(st)) continue
        if (st[0] === ';') { declare(st.slice(1), s); continue }
        if (st[0] === 'async' && Array.isArray(st[1])) st = st[1]
        if (st[0] === 'let' || st[0] === 'const') for (let i = 1; i < st.length; i++) bindPattern(s, Array.isArray(st[i]) && st[i][0] === '=' ? st[i][1] : st[i])
        else if ((st[0] === 'function' || st[0] === 'function*' || st[0] === 'class') && typeof st[1] === 'string') bind(s, st[1])
      }
    }
    const lookup = (name, s) => { for (let t = s; t; t = t.parent) { const b = t.names.get(name); if (b) return b } return null }
    const ref = (name, s) => {
      seen.add(name)
      let crossed = false
      for (let t = s; t; t = t.parent) {
        const b = t.names.get(name)
        if (b) {
          if (!emitting && crossed && b.machine) { b.captured = true; reads.get(outer)?.add(b) }
          return emitting && b.machine ? at(b) : name
        }
        if (t.fn) crossed = true
      }
      if (!emitting) free.add(name)
      return name
    }
    const key = (k, s) => Array.isArray(k) && k[0] === '[]' && k.length === 2 ? ['[]', expr(k[1], s)] : k
    // an object literal or pattern's items: a shorthand names its key and its binding at once
    const object = (n, s, leaf) => ['{}', commas(items(n[1]).map(it => {
      const name = typeof it === 'string' ? it : Array.isArray(it) && it[0] === '=' && typeof it[1] === 'string' ? it[1] : null
      if (name == null) return leaf(it)
      const r = leaf(name)
      if (typeof it === 'string') return r === name ? it : [':', name, r]
      const d = expr(it[2], s)
      return r === name ? ['=', name, d] : [':', name, ['=', r, d]]
    }))]
    // A declaration's target: each name's spelling, a cell's slot where `slot`
    // (the declaration assigns it), defaults and computed keys read in `s`.
    const target = (p, s, slot) => {
      if (typeof p === 'string') { const b = lookup(p, s); return b?.machine ? (slot ? at(b) : b.spelling) : p }
      if (!Array.isArray(p) || p[0] == null) return p
      const op = p[0]
      if (op === '=') return ['=', target(p[1], s, slot), expr(p[2], s)]
      if (op === '...') return ['...', target(p[1], s, slot)]
      if (op === ':') return [':', key(p[1], s), target(p[2], s, slot)]
      if (op === ',' || op === '[]') return [op, ...p.slice(1).map(x => x == null ? x : target(x, s, slot))]
      if (op === '{}') return object(p, s, (x) => target(x, s, slot))
      return expr(p, s)
    }
    const hasCell = (p, s) => patternNames(p).some(n => lookup(n, s)?.cell)
    const cellsOf = (s) => [...s.names.values()].filter(b => b.cell)
    const makeCells = (s) => emitting ? cellsOf(s).map(b => ['let', ['=', b.spelling, cellOf(UNDEF)]]) : []
    const own = ownStmts
    // what a block lowers to keeps its spelling: braces, a list or a lone statement
    const shaped = (orig, out) => {
      if (Array.isArray(orig) && orig[0] === '{}') {
        const inner = orig[1]
        if (Array.isArray(inner) && inner[0] === ';') return ['{}', [';', ...out]]
        if (inner == null && !out.length) return orig.slice()
        return ['{}', out.length === 1 && inner != null ? out[0] : [';', ...out]]
      }
      if (Array.isArray(orig) && orig[0] === ';') return [';', ...out]
      return out.length === 1 ? out[0] : [';', ...out]
    }
    // statements of a scope, its cells made first, a function declaration
    // bound as a constant (one that reads cells) next
    const list = (stmts, s, flat) => {
      if (!emitting) declare(stmts, s)
      const out = stmts.map(st => stmt(st, s, flat))
      const hoisted = (st) => Array.isArray(st) && st.hoisted === true
      return [...makeCells(s), ...out.filter(hoisted), ...out.filter(st => !hoisted(st))]
    }
    const block = (n, parent, flat, loop) => {
      // a lone name or literal declares nothing (a function body may be one)
      if (!Array.isArray(n)) return expr(n, parent)
      const s = scope(n, 'b', parent, { flat, loop })
      return withLoc(shaped(n, list(own(n), s, flat)), n)
    }
    const declaration = (n, s) => {
      const op = n[0], parts = []
      let decls = []
      const flush = () => { if (decls.length) parts.push([op, ...decls]); decls = [] }
      for (let i = 1; i < n.length; i++) {
        const d = n[i], assigns = Array.isArray(d) && d[0] === '=', t = assigns ? d[1] : d, init = assigns ? expr(d[2], s) : undefined
        if (typeof t === 'string' && s.top && paramScope.names.has(t)) {
          if (assigns) { flush(); parts.push(['=', t, init]) }
          continue
        }
        if (emitting && hasCell(t, s)) {
          // a cell's declaration assigns its slot; the pattern's other names declare apart
          flush()
          const plain = patternNames(t).map(x => lookup(x, s)).filter(b => !b.cell).map(b => b.spelling)
          if (plain.length) parts.push(['let', ...plain])
          parts.push(['=', target(t, s, true), assigns ? init : UNDEF])
          continue
        }
        decls.push(assigns ? withLoc(['=', target(t, s, false), init], d) : target(t, s, false))
      }
      flush()
      return parts.length === 1 ? parts[0] : [';', ...parts]
    }
    const stmt = (n, s, flat) => withLoc(stmtAt(n, s, flat), n)
    const stmtAt = (n, s, flat) => {
      if (!Array.isArray(n) || n[0] == null) return expr(n, s)
      const op = n[0], inner = flat && decomposes(n)
      if (op === ';') return [';', ...n.slice(1).map(st => stmt(st, s, flat))]
      if (op === '{}') return block(n, s, flat)
      if (op === 'let' || op === 'const') return declaration(n, s)
      if (op === ':' && typeof n[1] === 'string') return [':', n[1], stmt(n[2], s, inner)]
      if (op === 'if') return ['if', expr(n[1], s), block(n[2], s, inner), ...(n.length > 3 ? [block(n[3], s, inner)] : [])]
      if (op === 'while') return ['while', expr(n[1], s), block(n[2], s, inner, true)]
      if (op === 'do') return ['do', block(n[1], s, inner, true), expr(n[2], s)]
      if (op === 'for') return forStmt(n, s, inner)
      if (op === 'try') return ['try', block(n[1], s, inner), ...n.slice(2).map(c => {
        if (!Array.isArray(c)) return c
        if (c[0] === 'finally') return ['finally', block(c[1], s, inner)]
        // the parameter and the body share a scope (the body cannot redeclare it)
        const cs = scope(c, 'x', s, { flat: inner })
        if (!emitting && c[1] != null) bindPattern(cs, c[1])
        const out = list(own(c[2]), cs, inner)
        if (c[1] == null || !emitting || !hasCell(c[1], cs)) return ['catch', c[1] == null ? c[1] : target(c[1], cs, false), shaped(c[2] ?? ['{}', null], out)]
        // a captured parameter lives in a cell the body makes first
        const caught = genTemp('ce'), made = cellsOf(cs).length
        const plain = patternNames(c[1]).map(x => cs.names.get(x)).filter(b => !b.cell).map(b => b.spelling)
        return ['catch', caught, ['{}', [';', ...out.slice(0, made), ...(plain.length ? [['let', ...plain]] : []),
          ['=', target(c[1], cs, true), caught], ...out.slice(made)]]]
      })]
      if (op === 'switch') {
        // its cases share one scope, made as it is entered
        const w = scope(n, 'w', s, { flat: inner }), clauses = n.slice(2)
        const bodyOf = (c) => own(c[0] === 'case' ? c[2] : c[1])
        if (!emitting) declare(clauses.flatMap(bodyOf), w)
        const out = ['switch', expr(n[1], s), ...clauses.map(c => c[0] === 'case'
          ? ['case', expr(c[1], w), shaped(c[2], bodyOf(c).map(st => stmt(st, w, inner)))]
          : ['default', shaped(c[1], bodyOf(c).map(st => stmt(st, w, inner)))])]
        const made = makeCells(w)
        return made.length ? [';', ...made, out] : out
      }
      const decl = op === 'async' && Array.isArray(n[1]) ? n[1] : n
      if ((decl[0] === 'function' || decl[0] === 'function*' || decl[0] === 'class' && op !== 'async') && typeof decl[1] === 'string' && decl[1]) {
        const out = fn(n, s, true)
        if (out[0] !== '()') return out
        // a declaration whose closure reads cells binds the call's value
        return Object.assign(['const', ['=', target(decl[1], s, false), out]], { hoisted: decl[0] !== 'class' })
      }
      return expr(n, s)
    }
    const forStmt = (n, s, inner) => {
      const head = n[1], h = scope(n, 'h', s, { flat: inner, loop: true })
      if (Array.isArray(head) && (head[0] === 'of' || head[0] === 'in' || head[0] === 'of-idx')) {
        // the source reads outside the loop's scope, the binding and the body inside it
        const decl = head[1], isDecl = Array.isArray(decl) && (decl[0] === 'let' || decl[0] === 'const')
        if (!emitting && isDecl) bindPattern(h, decl[1])
        return ['for', [head[0], isDecl ? [decl[0], target(decl[1], h, false)] : expr(decl, s), expr(head[2], s)], block(n[2], h, inner, true)]
      }
      const [, init, cond, step] = Array.isArray(head) && head[0] === ';' ? head : [';', head, null, null]
      if (!emitting && init != null) declare([init], h)
      const init2 = init == null ? init : stmt(init, h, inner), cond2 = cond == null ? cond : expr(cond, h), step2 = step == null ? step : expr(step, h)
      const body = block(n[2], h, inner, true), cells = emitting ? cellsOf(h) : []
      if (!cells.length) return ['for', [';', init2, cond2, step2], body]
      // the head's bindings copy into fresh cells after the initializer and before each step
      const copy = () => cells.map(b => ['=', b.spelling, cellOf(['.', b.spelling, 'v'])])
      const steps = [...copy(), ...(step2 == null ? [] : [step2])]
      return ['for', [';', [';', ...makeCells(h), ...(init2 == null ? [] : [init2]), ...copy()], cond2, commas(steps)], body]
    }
    // A function form: a scope of its own. One standing in the machine body
    // reads the cells it captures through the parameters of a call made where
    // it stands.
    const fn = (n, s, decl) => {
      const top = outer == null
      if (top) { outer = n; if (!emitting) reads.set(n, new Set()) }
      const out = fnAt(n, s, decl)
      if (!top) return out
      outer = null
      const cells = emitting ? [...reads.get(n)].filter(b => b.cell).map(b => b.spelling) : []
      if (!cells.length) return out
      return ['()', ['=>', ['()', commas(cells)], out], commas(cells.slice())]
    }
    const fnParams = (p, f) => {
      if (!emitting) for (const x of extractParams(p)) bindPattern(f, x)
      return p == null ? p : expr(p, f)
    }
    const fnAt = (n, s, decl) => {
      const op = n[0]
      if (op === 'async') return ['async', fnAt(n[1], s, decl)]
      if (op === '=>') {
        const f = scope(n, 'f', s, { fn: true })
        const p = fnParams(n[1], f)
        return ['=>', p, Array.isArray(n[2]) && n[2][0] === '{}' ? block(n[2], f, false) : expr(n[2], f)]
      }
      if (op === 'class') {
        // a class names itself inside; its members run apart from the body
        const c = scope(n, 'c', s, { own: true }), k = scope(n, 'k', c, { fn: true })
        if (!emitting && n[1] && !decl) bind(c, n[1])
        const mk = (x) => Array.isArray(x) && x[0] === 'static' ? ['static', mk(x[1])] : key(x, c)
        const member = (m) => {
          if (!Array.isArray(m)) return m
          if (m[0] === 'static') return ['static', Array.isArray(m[1]) && m[1][0] === '{}' ? block(m[1], k, false) : member(m[1])]
          if (m[0] === '=' || m[0] === ':') return [m[0], mk(m[1]), expr(m[2], k)]
          if (m[0] === 'get' || m[0] === 'set') { const f = scope(m, 'f', k, { fn: true }); return [m[0], mk(m[1]), fnParams(m[2], f), block(m[3], f, false)] }
          return expr(m, k)
        }
        const body = n[3] == null ? n[3] : Array.isArray(n[3]) && n[3][0] === ';' ? [';', ...n[3].slice(1).map(member)] : member(n[3])
        return ['class', decl ? target(n[1], s, false) : n[1], n[2] == null ? n[2] : expr(n[2], s), body]
      }
      // function / function*: an expression's own name binds inside it
      const self = scope(n, 's', s, { own: true }), f = scope(n, 'f', self, { fn: true })
      if (!emitting && n[1] && !decl) bind(self, n[1])
      const p = fnParams(n[2], f)
      return [op, decl ? target(n[1], s, false) : n[1], p, n[3] == null ? n[3] : block(n[3], f, false), ...n.slice(4)]
    }
    const expr = (n, s) => {
      if (typeof n === 'string') return ref(n, s)
      if (!Array.isArray(n) || n[0] == null) return n
      return withLoc(noted(n, exprAt(n, s)), n)
    }
    const exprAt = (n, s) => {
      const op = n[0]
      if (op === 'str' || op === '//' || op === 'break' || op === 'continue') return n.slice()
      if (op === '.' || op === '?.') return [op, expr(n[1], s), n[2]]
      if (FN_BOUNDARY_OPS.has(op)) return fn(n, s, false)
      if (op === 'get' || op === 'set') { const f = scope(n, 'f', s, { fn: true }); return [op, key(n[1], s), fnParams(n[2], f), block(n[3], f, false)] }
      if (op === ':') return [':', key(n[1], s), expr(n[2], s)]
      if (op === '{}') return object(n, s, (x) => expr(x, s))
      return n.map((c, i) => i === 0 ? c : expr(c, s))
    }
    // scan: bind, resolve, note what each closure captures
    list(stmts, root, true)
    for (const b of nested) b.cell = b.reenter && b.captured
    // spell: a top-level binding keeps its name, a block's takes one nothing else holds
    const taken = new Set([...paramScope.names.keys(), ...free, ...Object.values(S), '__next', '__in', '__v', '__e'])
    for (const b of tops) taken.add(b.name)
    for (const b of nested) {
      let sp = b.name, k = 0
      while (taken.has(sp) || sp !== b.name && seen.has(sp)) sp = `${b.name}$${++k}`
      b.spelling = sp; taken.add(sp)
    }
    emitting = true
    return list(stmts, root, true)
  }
  // Collect every let/const binding name in the body, a pattern's names too:
  // generator locals live in the factory scope so they survive across next()
  // resumes (each spelled apart by resolveLocals above).
  const collectLocals = (node, out) => walkAst(node, { enter: n => {
    if ((n[0] === 'let' || n[0] === 'const')) {
      for (let i = 1; i < n.length; i++) {
        const d = n[i]
        for (const name of patternNames(Array.isArray(d) && d[0] === '=' ? d[1] : d)) {
          // a rejection names this declaration
          if (out.has(name) && n.loc != null) ctx.error.loc = n.loc
          if (out.has(name)) err(`generators v1: '${name}' is declared twice in the generator body — hoisted locals must be unique`)
          out.add(name)
        }
      }
    }
    // nested function forms create their own scope — their decls don't hoist
    if (FN_BOUNDARY_OPS.has(n[0])) return false
  } })

  // A decomposed for-of or for-in becomes loops the machine splits as it
  // splits any: over a known generator's machine or an iterator's protocol
  // (closed when the body leaves early, closingLoop), or by index over what
  // the source holds as prepare's for-of reads it (`__iter_arr`: an array, a
  // typed array, a string's code points, a collection's entries), or over the
  // keys a for-in enumerates. Its binding is the first statement of each
  // iteration, the body a block inside; its labels go to the loops.
  const isEach = (n) => Array.isArray(n) && n[0] === 'for' && Array.isArray(n[1]) && (n[1][0] === 'of' || n[1][0] === 'in' || n[1][0] === 'of-idx')
  const eachLoop = (st, labels) => {
    const [, [kind, decl, src], body] = st
    const inner = ['{}', [';', ...bodyStmts(body)]]
    if (kind === 'of' && Array.isArray(src) && src[0] === '()' && typeof src[1] === 'string' && generatorNames?.has(src[1]))
      return desugarForOfGenerator(decl, src, inner, genTemp, labels)
    if (kind === 'of' && iterProto?.on) return desugarForOfProtocol(decl, src, inner, genTemp, labels)
    const list = genTemp(kind === 'in' ? 'fk' : 'fa'), i = genTemp('fx'), key = genTemp('fn')
    const fill = kind === 'in'
      ? [['let', ['=', list, ['[]', null]]], ['for', ['in', ['const', key], src], ['()', ['.', list, 'push'], key]]]
      : [['let', ['=', list, ['()', '__iter_arr', src]]]]
    return ['{}', [';', ...fill, ['let', ['=', i, [null, 0]]],
      labeled(labels, ['for', [';', null, ['<', i, ['.', list, 'length']], ['=', i, ['+', i, [null, 1]]]],
        ['{}', [';', bindTo(decl, ['[]', list, i]), inner]]])]]
  }
  // A list the machine flattens binds its function declarations as constants
  // first, as JS hoists them (the last first), and a class declaration as a
  // `let` where it stands: either would declare in the one state it runs
  // in. A switch's cases share one list's declarations, bound before it.
  const declarations = (stmts) => {
    const fns = [], rest = []
    for (const st of stmts) {
      const decl = Array.isArray(st) && st[0] === 'async' ? st[1] : st
      if (Array.isArray(decl) && (decl[0] === 'function' || decl[0] === 'function*') && decl[1]) {
        const value = [decl[0], '', decl[2], decl[3]]
        fns.unshift(withLoc(['const', ['=', decl[1], st[0] === 'async' ? ['async', value] : value]], st))
      } else if (Array.isArray(st) && st[0] === 'class' && st[1]) rest.push(withLoc(['let', ['=', st[1], st.slice()]], st))
      else rest.push(st)
    }
    return { fns, rest }
  }
  const flatList = (stmts) => { const { fns, rest } = declarations(stmts.map(st => prepared(st))); return [...fns, ...rest] }
  // the body as the machine splits it: its lists' declarations bound, its
  // decomposed for-of and for-in loops desugared
  const prepared = (st, labels = null) => withLoc(preparedAt(st, labels), st)
  const preparedAt = (st, labels) => {
    if (!Array.isArray(st)) return st
    const op = st[0], each = (b) => prepared(b)
    // a block in a list the machine flattens flattens too
    if (op === ';') return [';', ...flatList(st.slice(1))]
    if (op === '{}') return ['{}', [';', ...flatList(ownStmts(st))]]
    if (!decomposes(st)) return st
    if (op === ':' && typeof st[1] === 'string') {
      const names = [...(labels || []), st[1]], inner = st[2]
      if (Array.isArray(inner) && inner[0] === ':' || isEach(inner)) return prepared(inner, names)
      return labeled(names, each(inner))
    }
    if (isEach(st)) return prepared(eachLoop(st, labels))
    if (op === 'if') return ['if', st[1], each(st[2]), ...(st.length > 3 ? [each(st[3])] : [])]
    if (op === 'while' || op === 'for') return [op, st[1], each(st[2])]
    if (op === 'do') return ['do', each(st[1]), st[2]]
    if (op === 'try') return ['try', each(st[1]), ...st.slice(2).map(c => c[0] === 'catch' ? ['catch', c[1], each(c[2] ?? ['{}', null])] : c[0] === 'finally' ? ['finally', each(c[1])] : c)]
    if (op === 'switch') {
      const fns = [], clauses = st.slice(2).map(c => {
        const i = c[0] === 'case' ? 2 : 1, d = declarations(ownStmts(c[i]).map(s => prepared(s)))
        fns.push(...d.fns)
        const out = c.slice(); out[i] = [';', ...d.rest]
        return out
      })
      return fns.length ? [';', ...fns, ['switch', st[1], ...clauses]] : ['switch', st[1], ...clauses]
    }
    return st
  }

  // `agen`: the body of an async generator, whose driver reads tagged yields
  function lowerGenerator(params, rawBody, agen = false) {
    // the function's own scope, as its source declared it
    const owners = [rawBody, params]
    const lowered = lowerArguments(params, rawBody, true)
    params = lowered[0]; rawBody = lowered[1]
    const paramInit = lowered[2].map(transform)
    // every yield and await at a statement (jzify/async.js)
    const body = blockStmts(hoistSuspensions(rawBody))

    // the root list binds its function declarations up front: the machine
    // assigns hoisted locals before dispatch reaches any user statement, so a
    // call before the declaration works
    body.splice(0, body.length, ...flatList(body))
    body.splice(0, body.length, ...resolveLocals(body, [...new Set(extractParams(params).flatMap(patternNames))]))
    const locals = new Set()
    for (const st of body) collectLocals(st, locals)

    // ---- state machine ----
    // states[i] = list of statements; terminators are written explicitly as
    // `__s = k` + return/continue shapes. State 0 is the entry; -1 is done.
    const states = []
    // a `try` spanning a yield is a REGION of states: every state created while
    // its body flattens records the catch state as its handler (-1: none); the
    // dispatch loop routes an exception raised in a state to that handler
    const stateHandler = []
    let curHandler = -1
    // A try with a finally guards its body and catch: a completion leaving them
    // (normal, a throw, a return, a break or continue) runs the finally first.
    // `next` holds where the finally continues: a state, or THROWN with the
    // exception in `error`. Every state records the innermost such try whose
    // guarded part it belongs to (null: none), so a return() injected at a yield
    // finds the finally blocks it must run.
    const stateFinally = []
    let curFinally = null
    const newState = () => (states.push([]), stateHandler.push(curHandler), stateFinally.push(curFinally), states.length - 1)
    const stmtsOf = (id) => states[id]
    const gotoIR = (id) => [[';;set', id], [';;continue']]
    const record = (value, done) => ['{}', [',', [':', 'value', value], [':', 'done', [null, done]]]]
    const THROWN = -2
    // The finally blocks a jump from `fin` to a point outside `until` crosses, innermost first.
    const crossing = (fin, until = null) => {
      const out = []
      for (let f = fin; f !== until; f = f.outer) out.push(f)
      return out
    }
    // Leave for state `target` through the finally blocks `fins`: each, once
    // complete, continues at the next, the outermost at `target`.
    const leave = (fins, target) => {
      let dest = target
      for (let i = fins.length - 1; i > 0; i--) {
        const via = newState()
        stmtsOf(via).push(['=', fins[i].next, [null, dest]], ...gotoIR(fins[i].finS))
        dest = via
      }
      return fins.length ? [['=', fins[0].next, [null, dest]], ...gotoIR(fins[0].finS)] : gotoIR(dest)
    }
    // A return completion: its value waits in `returned` while finally blocks run.
    let returned = null, completeS = -1
    const returnSlot = () => {
      if (returned == null) { returned = genTemp('returned'); locals.add(returned) }
      return returned
    }
    const leaveReturn = (fin, value) => {
      if (!fin) return [[';;set', -1], ['return', record(value, true)]]
      const slot = returnSlot()
      if (completeS < 0) {
        completeS = newState()
        stmtsOf(completeS).push([';;set', -1], ['return', record(slot, true)])
      }
      return [...(value === slot ? [] : [['=', slot, value]]), ...leave(crossing(fin), completeS)]
    }
    // Suspension points a return() reaches as a return completion (a yield),
    // and the delegated yields of a yield*, which take whatever completion
    // arrives as data: its `kind` local says which (0 next, 1 throw, 2 return).
    const resumes = [], delivered = []

    // `yield E` at a resume boundary: park the resume id, emit the {value,done:false}
    // return. The resume state optionally starts by binding `target = __sent`.
    // An await's operand is kept in a local of its own: the target binds
    // `__awaited(a, __sent)`, the sent value typed as the settled value of `a`.
    // `['yield', E, kind]` is a yield*'s. An async generator's driver
    // (jz:asyncgen) reads the yielded value as a tagged record: `a: 1` an
    // await, `a: 0` a yield, whose value it awaits first, `a: 2` a delegate's
    // value, yielded as it is.
    const emitYield = (cur, yexpr, target) => {
      const resume = newState(), op = yexpr[0], kind = op === 'yield' ? yexpr[2] : null
      let value = yexpr[1] === undefined ? [null, undefined] : transform(yexpr[1]), sent = S.SENT
      if (target && op === 'await') {
        const a = genTemp('av'); locals.add(a)
        stmtsOf(cur).push(['=', a, value])
        value = a; sent = ['()', '__awaited', [',', a, S.SENT]]
      }
      if (agen) value = ['{}', [',', [':', 'a', [null, op === 'await' ? 1 : kind ? 2 : 0]], [':', 'v', value]]]
      stmtsOf(cur).push([';;set', resume], ['return', record(value, false)])
      if (target) stmtsOf(resume).push(['=', target, sent])
      // an await is resumed only by its own settling
      if (kind) delivered.push({ resume, kind })
      else if (op !== 'await') resumes.push(resume)
      return resume
    }

    // yield* E: E's iterator answers each completion the generator receives
    // at the delegated yield. throw(e) calls its throw(e), or, lacking one,
    // closes it and throws a TypeError; return(v) calls its return(v), or,
    // lacking one, returns v; a done result of either ends the generator with
    // a return of its value, a done next() the yield* with its value (in
    // `target`). A method is tested, then read again where it is called, as
    // for-of's return() is (GetMethod reads once; a method held as a value to
    // call costs the program its receivers' kinds). An async generator awaits
    // each result, and the value of a return() with no method to answer it, and
    // takes a sync iterator through __ag_from (CreateAsyncFromSyncIterator),
    // its values yielded as they are (tag 2). E may be any iterable: an
    // ['@@iterator']() provider unwraps first; any other yields what a for-of
    // reads of it (`__iter_arr`: an array live, a string's code points, a
    // Map's entries, a Set's values), as an iterator with no throw() or
    // return() (the fork mirrors desugarForOfProtocol; both arms decompose
    // like any generator-body loop).
    const desugarYieldStar = (expr, target) => {
      // the source copies before the @@iterator() unwrap — single-assignment
      // locals keep the probe reads on the precise kind.
      const local = (t) => { const name = genTemp(t); locals.add(name); return name }
      const src = local('yv'), it = local('yi'), r = local('yr'), sent = local('ys'), ix = local('yx'), kind = local('yk'), list = local('yl')
      // an async generator's awaited value
      const value = agen ? local('yw') : null
      const NULL = [null, null]
      const settled = (e) => agen ? ['await', e] : e
      const typeError = (msg) => ['throw', ['new', ['()', 'TypeError', [null, msg]]]]
      // fresh nodes at each use: a node stands in one place in the tree
      const notObject = () => ['||', ['==', r, NULL], ['&&', ['!==', ['typeof', r], [null, 'object']], ['!==', ['typeof', r], [null, 'function']]]]
      // the value of a return() the delegate cannot answer (an async one awaits it)
      const returns = (v) => agen ? [['=', value, ['await', v]], ['return', value]] : [['return', v]]
      const call = (name, args) => ['=', r, settled(['()', ['.', it, name], args])]
      const noThrow = () => typeError("The iterator does not provide a 'throw' method")
      const has = (key) => ['&&', ['!=', src, NULL], ['!=', ['.', src, key], NULL]]
      const syncIterator = ['()', probe(src, '@@iterator'), null]
      return ['{}', [';',
        ['=', src, expr],
        ['=', it, src],
        agen
          ? ['if', has('@@asyncIterator'), ['=', it, ['()', ['.', src, '@@asyncIterator'], null]],
            ['if', has('@@iterator'), ['=', it, ['()', '__ag_from', syncIterator]]]]
          : ['if', has('@@iterator'), ['=', it, syncIterator]],
        ['if', ['&&', ['!=', it, NULL], ['!=', ['.', it, 'next'], NULL]],
          ['{}', [';',
            ['=', kind, [null, 0]],
            ['=', sent, [null, undefined]],
            ['while', [null, true], ['{}', [';',
              ['if', ['===', kind, [null, 0]], call('next', sent),
                ['if', ['===', kind, [null, 1]], ['{}', [';',
                  // IteratorClose before the TypeError: return()'s own error stands
                  ['if', ['==', ['.', it, 'throw'], NULL], ['{}', [';',
                    ['if', ['!=', ['.', it, 'return'], NULL], ['{}', [';', call('return', null),
                      ['if', notObject(), typeError('iterator return result is not an object')]]]],
                    noThrow()]]],
                  call('throw', sent)]],
                ['{}', [';',
                  ['if', ['==', ['.', it, 'return'], NULL], ['{}', [';', ...returns(sent)]]],
                  call('return', sent)]]]],
              ['if', notObject(), typeError('iterator result is not an object')],
              ['if', ['.', r, 'done'], ['{}', [';', ['if', ['===', kind, [null, 2]], ['return', ['.', r, 'value']]], ['break']]]],
              ['=', kind, [null, 0]],
              ['=', sent, ['yield', ['.', r, 'value'], kind]],
            ]]],
            ...(target ? [['=', target, ['.', r, 'value']]] : []),
          ]],
          ['{}', [';',
            ['=', list, ['()', '__iter_arr', it]],
            ['=', ix, [null, 0]],
            ['while', ['<', ix, ['.', list, 'length']], ['{}', [';',
              ...(agen ? [['=', value, ['await', ['[]', list, ix]]]] : []),
              ['=', kind, [null, 0]],
              ['=', sent, ['yield', agen ? value : ['[]', list, ix], kind]],
              ['if', ['===', kind, [null, 1]], noThrow()],
              ['if', ['===', kind, [null, 2]], ['{}', [';', ...returns(sent)]]],
              ['=', ix, ['+', ix, [null, 1]]],
            ]]],
            ...(target ? [['=', target, [null, undefined]]] : []),
          ]]],
      ]]
    }

    // Flatten a statement list into states. Returns the state id control falls
    // into after the list (or null if control never falls through).
    // `jumps` = { brk, cont, labels }: where a break, a continue and a jump to
    // a label go out of decomposed statements, each a target { s, fin } (its
    // state, and the try with a finally it stands in: a jump to it crosses
    // the finally blocks between). `labels` name the statement flattening.
    const flattenList = (stmts, cur, jumps) => {
      for (const st of stmts) {
        if (cur == null) return null   // unreachable code after a terminator — drop
        cur = flattenStmt(st, cur, jumps)
      }
      return cur
    }

    // a statement is the current position while it flattens (ctx.js)
    const flattenStmt = (st, cur, jumps, labels) => {
      const outer = ctx.error.loc
      if (Array.isArray(st) && st.loc != null) ctx.error.loc = st.loc
      const next = flattenStmtAt(st, cur, jumps, labels)
      ctx.error.loc = outer
      return next
    }
    const target = (s) => ({ s, fin: curFinally })
    // a loop's jumps: its break and continue, under each of its labels too
    const loopJumps = (jumps, labels, brk, cont) => {
      const own = { brk: target(brk), cont: target(cont), labels: jumps?.labels }
      if (labels) { own.labels = new Map(own.labels); for (const l of labels) own.labels.set(l, own) }
      return own
    }
    // An expression that may suspend, as statements and a value: its yields
    // and awaits land in temps of their own (hoistExpr), machine locals.
    const split = (e) => {
      if (e == null || !hasYield(e)) return { pre: [], expr: e }
      const h = hoistExpr(e)
      for (const s of h.pre) collectLocals(s, locals)
      return h
    }
    // Branch on a test that may suspend, where it stands.
    const branch = (at, cond, then, otherwise, jumps) => {
      const c = split(cond)
      at = flattenList(c.pre, at, jumps)
      stmtsOf(at).push(['if', c.expr == null ? [null, true] : transform(c.expr), [';', ...gotoIR(then)], [';', ...gotoIR(otherwise)]], [';;continue'])
    }
    const flattenStmtAt = (st, cur, jumps, labels) => {
      if (!Array.isArray(st)) { if (st != null) stmtsOf(cur).push(transform(st)); return cur }
      const op = st[0]

      // --- yield forms ---
      if (op === 'yield*') return flattenStmt(desugarYieldStar(st[1], null), cur, jumps)
      if (op === 'yield' || op === 'await') return emitYield(cur, st, null)
      if ((op === 'let' || op === 'const') && st.length === 2 && Array.isArray(st[1]) &&
          st[1][0] === '=' && isYield(st[1][2])) {
        if (st[1][2][0] === 'yield*') return flattenStmt(desugarYieldStar(st[1][2][1], st[1][1]), cur, jumps)
        return emitYield(cur, st[1][2], st[1][1])
      }
      if (op === '=' && typeof st[1] === 'string' && isYield(st[2])) {
        if (st[2][0] === 'yield*') return flattenStmt(desugarYieldStar(st[2][1], st[1]), cur, jumps)
        return emitYield(cur, st[2], st[1])
      }
      // `name.prop = yield E` (a field set from an await): the value lands in a
      // temp at the resume, then the store – the receiver is a plain name, so
      // evaluating it after the yield changes nothing observable
      if (op === '=' && Array.isArray(st[1]) && st[1][0] === '.' && typeof st[1][1] === 'string' && isYield(st[2])) {
        const t = genTemp('ya'); locals.add(t)
        const resume = st[2][0] === 'yield*' ? flattenStmt(desugarYieldStar(st[2][1], t), cur, jumps) : emitYield(cur, st[2], t)
        stmtsOf(resume).push(['=', st[1], t])
        return resume
      }

      // --- return ---
      if (op === 'return') {
        let v = st[1] === undefined ? [null, undefined] : transform(st[1])
        if (curHandler >= 0 && !curFinally && st[1] !== undefined) {
          // Evaluate while this state's exception handler is still active.
          const value = genTemp('return'); locals.add(value)
          stmtsOf(cur).push(['=', value, v]); v = value
        }
        stmtsOf(cur).push(...leaveReturn(curFinally, v))
        return null
      }

      // --- a break or continue of a DECOMPOSED statement, through the finally blocks between ---
      if (op === 'break' || op === 'continue') {
        const to = st[1] != null ? jumps?.labels?.get(st[1]) : jumps
        const at = to && (op === 'break' ? to.brk : to.cont)
        if (at) { stmtsOf(cur).push(...leave(crossing(curFinally, at.fin), at.s)); return null }
      }

      // --- a statement list flattens statement by statement: its `let`s are
      // hoisted machine locals and must become assignments, never a nested
      // block's own bindings shadowing them ---
      if (op === '{}' || op === ';') return flattenList(blockStmts(st), cur, jumps)

      // --- compound statements stay atomic only when they carry no yield, no
      // plain return (see hasReturn — a nested return must reach the `return`
      // case above, not fall-through as a bare host return), AND no
      // break/continue that binds a DECOMPOSED statement (the raw op would
      // bind the dispatch while(1) instead — an infinite next()) ---
      if (!decomposes(st)) {
        // let/const initializers become assignments (names are hoisted), a
        // declaration without one the undefined it declares
        if (op === 'let' || op === 'const') {
          for (let i = 1; i < st.length; i++) {
            const d = st[i]
            // a pattern assigns its names as any destructuring assignment does
            if (Array.isArray(d) && d[0] === '=') stmtsOf(cur).push(Array.isArray(d[1]) ? transform(withLoc(['=', d[1], d[2]], d)) : withLoc(['=', d[1], transform(d[2])], d))
            else if (typeof d === 'string') stmtsOf(cur).push(['=', d, [null, undefined]])
          }
          return cur
        }
        // a labeled block keeps its label (a colon in an expression names no statement)
        if (op === ':' && typeof st[1] === 'string' && Array.isArray(st[2]) && st[2][0] === '{}')
          stmtsOf(cur).push(withLoc(['label', st[1], transform(st[2])], st))
        else stmtsOf(cur).push(transform(st))
        return cur
      }

      // --- a labeled statement: a loop takes its labels, any other statement
      // ends where a break of its label goes ---
      if (op === ':' && typeof st[1] === 'string') {
        const names = [...(labels || []), st[1]], inner = st[2]
        if (Array.isArray(inner) && (inner[0] === ':' || inner[0] === 'while' || inner[0] === 'do' || inner[0] === 'for'))
          return flattenStmt(inner, cur, jumps, names)
        const after = newState(), own = { brk: target(after) }, map = new Map(jumps?.labels)
        for (const l of names) map.set(l, own)
        const end = flattenStmt(inner, cur, { ...jumps, labels: map })
        if (end != null) stmtsOf(end).push(...gotoIR(after))
        return after
      }

      // --- yield-bearing control ---
      if (op === 'if') {
        const [, cond, thenB, elseB] = st
        const join = newState()
        const thenS = newState()
        const elseS = elseB != null ? newState() : join
        stmtsOf(cur).push(['if', transform(cond), [';', ...gotoIR(thenS)], [';', ...gotoIR(elseS)]], [';;continue'])
        const tEnd = flattenList(blockStmts(thenB), thenS, jumps)
        if (tEnd != null) stmtsOf(tEnd).push(...gotoIR(join))
        if (elseB != null) {
          const eEnd = flattenList(blockStmts(elseB), elseS, jumps)
          if (eEnd != null) stmtsOf(eEnd).push(...gotoIR(join))
        }
        return join
      }
      // A loop's test, step and initializer run where the loop runs them, a
      // yield or await among them suspending there (split).
      if (op === 'while') {
        const [, cond, bodyB] = st
        const test = newState(), bodyS = newState(), exit = newState()
        stmtsOf(cur).push(...gotoIR(test))
        branch(test, cond, bodyS, exit, jumps)
        const bEnd = flattenList(blockStmts(bodyB), bodyS, loopJumps(jumps, labels, exit, test))
        if (bEnd != null) stmtsOf(bEnd).push(...gotoIR(test))
        return exit
      }
      if (op === 'do') {
        const [, bodyB, cond] = st
        const bodyS = newState(), test = newState(), exit = newState()
        stmtsOf(cur).push(...gotoIR(bodyS))
        const bEnd = flattenList(blockStmts(bodyB), bodyS, loopJumps(jumps, labels, exit, test))
        if (bEnd != null) stmtsOf(bEnd).push(...gotoIR(test))
        branch(test, cond, bodyS, exit, jumps)
        return exit
      }
      if (op === 'for') {
        const [, head, bodyB] = st
        // (a for-of or for-in arrives desugared: eachLoop)
        // C-style [';', init, cond, step] (subscript head shape)
        const [, init, cond, step] = Array.isArray(head) && head[0] === ';' ? head : [';', head, undefined, undefined]
        if (init != null) cur = flattenStmt(init, cur, jumps)
        const test = newState(), bodyS = newState(), stepS = newState(), exit = newState()
        stmtsOf(cur).push(...gotoIR(test))
        branch(test, cond, bodyS, exit, jumps)
        const bEnd = flattenList(blockStmts(bodyB), bodyS, loopJumps(jumps, labels, exit, stepS))
        if (bEnd != null) stmtsOf(bEnd).push(...gotoIR(stepS))
        const s = split(step), sEnd = flattenList(s.pre, stepS, jumps)
        if (s.expr != null) stmtsOf(sEnd).push(transform(s.expr))
        stmtsOf(sEnd).push(...gotoIR(test))
        return exit
      }
      // A switch tests its cases in order, a yield or await in a test
      // suspending there, enters the first that matches, else its default,
      // and falls from each case into the next; a break leaves it.
      if (op === 'switch') {
        const clauses = st.slice(2), exit = newState(), disc = genTemp('sw')
        locals.add(disc)
        stmtsOf(cur).push(['=', disc, transform(st[1])])
        const bodies = clauses.map(() => newState())
        let at = cur
        clauses.forEach((c, i) => {
          if (c[0] !== 'case') return
          const t = split(c[1])
          at = flattenList(t.pre, at, jumps)
          stmtsOf(at).push(['if', ['===', disc, transform(t.expr)], [';', ...gotoIR(bodies[i])]])
        })
        const dflt = clauses.findIndex(c => c[0] === 'default')
        stmtsOf(at).push(...gotoIR(dflt >= 0 ? bodies[dflt] : exit))
        const own = { ...jumps, brk: target(exit) }
        clauses.forEach((c, i) => {
          const end = flattenList(blockStmts(c[0] === 'case' ? c[2] : c[1]), bodies[i], own)
          if (end != null) stmtsOf(end).push(...gotoIR(i + 1 < clauses.length ? bodies[i + 1] : exit))
        })
        return exit
      }
      if (op === 'try') {
        // try/catch across a yield (an await): the try body's states carry the
        // catch state as their handler; the catch binds the machine's `__err`.
        // A finally runs for every completion leaving the body or the catch:
        // each records in `next` where the finally continues (curFinally).
        const catchC = st.find((c, i) => i > 1 && Array.isArray(c) && c[0] === 'catch')
        const finallyC = st.find((c, i) => i > 1 && Array.isArray(c) && c[0] === 'finally')
        const outer = curHandler, outerFinally = curFinally
        const after = newState()
        const fin = finallyC ? { finS: newState(), next: genTemp('next'), error: genTemp('error'), outer: outerFinally } : null
        const finS = fin ? fin.finS : after
        const errorS = fin ? newState() : outer
        if (fin) {
          locals.add(fin.next); locals.add(fin.error)
          stmtsOf(errorS).push(['=', fin.next, [null, THROWN]], ['=', fin.error, S.ERR], ...gotoIR(finS))
        }
        const finish = end => {
          if (end == null) return
          if (fin) stmtsOf(end).push(['=', fin.next, [null, after]])
          stmtsOf(end).push(...gotoIR(finS))
        }
        // Exceptions from the catch must also run the finalizer. Its own
        // states belong to the outer region, so it cannot catch itself.
        if (fin) curFinally = fin
        curHandler = errorS
        const catchS = catchC ? newState() : errorS
        curHandler = catchS
        const bodyS = newState()
        stmtsOf(cur).push(...gotoIR(bodyS))
        finish(flattenList(blockStmts(st[1]), bodyS, jumps))
        if (catchC) {
          curHandler = errorS
          let at = catchS
          if (catchC[1] != null) {
            for (const name of patternNames(catchC[1])) locals.add(name)
            if (typeof catchC[1] === 'string') stmtsOf(catchS).push(['=', catchC[1], S.ERR])
            else if (hasYield(catchC[1])) at = flattenList(patternSteps('let', catchC[1], S.ERR), catchS, jumps)
            else stmtsOf(catchS).push(transform(['=', catchC[1], S.ERR]))
          }
          finish(flattenList(blockStmts(catchC[2]), at, jumps))
        }
        curHandler = outer
        curFinally = outerFinally
        if (fin) {
          // One finalizer for every completion. Its own return, throw or jump
          // overrides the pending one; falling through resumes it.
          const end = flattenList(blockStmts(finallyC[1]), finS, jumps)
          if (end != null) stmtsOf(end).push(['if', ['===', fin.next, [null, THROWN]], ['throw', fin.error]],
            ['=', S.NEXT, fin.next], [';;continue'])
        }
        return after
      }
      if (op === 'catch' || op === 'finally')
        err('generators v1: a stray catch/finally clause across a yield')
      // what hoistSuspensions leaves in place: a pattern's default or computed key
      if (op === 'let' || op === 'const')
        return flattenList(st.slice(1).flatMap(d => Array.isArray(d) && d[0] === '=' && hasYield(d[1]) ? patternSteps(op, d[1], d[2]) : [[op, d]]), cur, jumps)
      if (op === '=' && hasYield(st[1])) return flattenList(patternSteps(null, st[1], st[2]), cur, jumps)
      err(`generators v1: yield inside \`${op}\` is not supported yet — hoist the yield to statement position`)
    }
    // A destructuring whose default or computed key suspends runs as the
    // steps ECMA-262 takes (BindingInitialization,
    // DestructuringAssignmentEvaluation): an object pattern reads its keys in
    // turn, an array pattern steps its source's iterator (its protocol, or an
    // index over what a for-of reads), a default runs for undefined only, an
    // assignment's target is evaluated before its value, and an iterator the
    // pattern leaves unfinished closes, by an exception or a return() too.
    // `kind` declares the names (let, const) or assigns the targets (null).
    const patternSteps = (kind, pat, value) => {
      const out = [], UNDEF = [null, undefined], NULL = [null, null]
      const local = (x) => { const t = genTemp('ds'); locals.add(t); out.push(['=', t, x]); return t }
      const now = (e) => { const h = split(e); out.push(...h.pre); return h.expr }
      const typeError = (msg) => ['throw', ['new', ['()', 'TypeError', [null, msg]]]]
      // an assignment target's reference: its object and key, read first
      const ref = (t) => {
        if (kind || !Array.isArray(t)) return t
        if (t[0] === '.') return ['.', local(now(t[1])), t[2]]
        if (t[0] === '[]' && t.length === 3) return ['[]', local(now(t[1])), local(now(t[2]))]
        return t
      }
      const bind = (target, v, settled) => {
        const isDefault = Array.isArray(target) && target[0] === '='
        const inner = isDefault ? target[1] : target
        const nested = Array.isArray(inner) && (inner[0] === '{}' || inner[0] === '[]' && inner.length === 2)
        const place = nested || settled ? inner : ref(inner)
        let value = v
        if (isDefault) {
          value = local(v)
          const h = split(target[2])
          out.push(['if', ['===', value, UNDEF], ['{}', [';', ...h.pre, ['=', value, h.expr]]]])
        }
        if (nested) return inner[0] === '{}' ? object(inner, value) : array(inner, value)
        out.push(kind ? [kind, ['=', place, value]] : ['=', place, value])
      }
      const object = (p, v) => {
        const src = local(v)
        out.push(['if', ['==', src, NULL], typeError('cannot destructure undefined or null')])
        for (const it of p[1] == null ? [] : Array.isArray(p[1]) && p[1][0] === ',' ? p[1].slice(1) : [p[1]]) {
          if (Array.isArray(it) && it[0] === '...')
            err('generators v1: an object rest beside a yield or await in a destructuring default is not supported yet – read the value into a name first')
          const key = typeof it === 'string' ? it : it[0] === '=' ? it[1] : it[1], target = typeof it === 'string' || it[0] === '=' ? it : it[2]
          // a computed key is evaluated as the pattern reaches it
          const read = typeof key === 'string' ? ['.', src, key]
            : Array.isArray(key) && key[0] === '[]' && key.length === 2 ? ['[]', src, local(now(key[1]))] : ['[]', src, key]
          bind(target, read)
        }
      }
      const array = (p, v) => {
        const src = local(v)
        out.push(['if', ['==', src, NULL], typeError('value is not iterable')])
        const w = local(src)
        out.push(['if', ['!=', ['.', src, '@@iterator'], NULL], ['=', w, ['()', probe(src, '@@iterator'), null]]])
        const open = local(['&&', ['!=', w, NULL], ['!=', ['.', w, 'next'], NULL]]), proto = local(open)
        out.push(['if', ['!', proto], ['=', w, ['()', '__iter_arr', w]]])
        const done = local([null, false]), ix = local([null, 0]), r = local(UNDEF)
        // the next element, or undefined once the source is done; the
        // iterator's own next(), done or value throwing closes nothing
        const step = (v) => ['if', ['!', done], ['if', proto,
          ['{}', [';', ['=', open, [null, false]], ['=', r, ['()', ['.', w, 'next'], null]],
            ['if', ['.', r, 'done'], ['=', done, [null, true]], ['{}', [';', ['=', v, ['.', r, 'value']], ['=', open, [null, true]]]]]]],
          ['if', ['<', ix, ['.', w, 'length']], ['{}', [';', ['=', v, ['[]', w, ix]], ['=', ix, ['+', ix, [null, 1]]]]], ['=', done, [null, true]]]]]
        const outer = out.splice(0)
        for (const it of p[1] == null ? [] : Array.isArray(p[1]) && p[1][0] === ',' ? p[1].slice(1) : [p[1]]) {
          if (it == null) { out.push(step(local(UNDEF))); continue }
          if (Array.isArray(it) && it[0] === '...') {
            const rest = local(['[]', null]), v = local(UNDEF)
            out.push(['while', ['!', done], ['{}', [';', ['=', v, UNDEF], step(v), ['if', ['!', done], ['()', ['.', rest, 'push'], v]]]]])
            bind(it[1], rest)
            continue
          }
          // an assignment's target is evaluated before the step
          const isDefault = Array.isArray(it) && it[0] === '='
          const inner = isDefault ? it[1] : it
          const nested = Array.isArray(inner) && (inner[0] === '{}' || inner[0] === '[]' && inner.length === 2)
          const place = nested ? inner : ref(inner)
          const v = local(UNDEF)
          out.push(step(v))
          bind(isDefault ? ['=', place, it[2]] : place, v, true)
        }
        // the pattern's own exception closes the iterator and stands; a
        // completion leaving it unfinished closes it
        const body = out.splice(0), error = genTemp('de')
        locals.add(error)
        out.push(...outer, ['try', ['{}', [';', ...body]],
          ['catch', error, ['{}', [';', ['if', open, ['{}', [';', ['=', open, [null, false]],
            ['try', ['{}', [';', ['if', ['!=', ['.', w, 'return'], NULL], ['()', ['.', w, 'return'], null]]]], ['catch', genTemp('dq'), ['{}', null]]]]]], ['throw', error]]]],
          ['finally', ['{}', [';', ['if', open, ['{}', [';', ['=', open, [null, false]], ['if', ['!=', ['.', w, 'return'], NULL], ['()', ['.', w, 'return'], null]]]]]]]]])
      }
      bind(pat, value)
      return out
    }


    const entry = newState()
    // the states lower in the machine's scope (jzify/index.js enterMachineScope)
    const outer = enterMachineScope?.(owners, body)
    let end
    try { end = flattenList(body, entry, null) } finally { if (enterMachineScope) leaveBuiltinScope(outer) }
    if (end != null) stmtsOf(end).push([';;set', -1], ['return', record([null, undefined], true)])

    // return(v) at a suspended yield is a return completion there (its value in
    // `returned`): the enclosing finally blocks run first. Elsewhere it just
    // closes the machine. Each entry state starts that completion; returnFn
    // dispatches to it. A yield*'s yield takes the completion itself.
    const entries = new Map()
    for (const resume of resumes) {
      const fin = stateFinally[resume]
      if (!fin) continue
      if (!entries.has(fin)) {
        const s = newState()
        stmtsOf(s).push(...leaveReturn(fin, returnSlot()))
        entries.set(fin, { s, ids: [] })
      }
      entries.get(fin).ids.push(resume)
    }

    // ---- assemble the dispatch loop ----
    // Internal markers resolve here: [';;set', k] → __s = k; [';;continue'] → continue.
    const resolve = (n) => {
      if (!Array.isArray(n)) return n
      if (n[0] === ';;set') return ['=', S.NEXT, [null, n[1]]]
      if (n[0] === ';;continue') return ['continue']
      return withLoc(n.map(resolve), n)
    }
    // if-chain over states (highest → the shape jz compiles tightly)
    let dispatch = ['return', record([null, undefined], true)]
    for (let i = states.length - 1; i >= 0; i--)
      dispatch = ['if', ['===', S.NEXT, [null, i]], ['{}', [';', ...states[i].map(resolve), ['continue']]], ['{}', [';', dispatch]]]

    // try regions: the dispatch runs under one catch that routes an exception
    // raised in a region state to its handler (`__err` carries it) and closes
    // the machine on any other; an injected throw(v) is raised at the resume
    // point, inside that catch, so it reaches the same handlers
    const handlers = new Map()
    stateHandler.forEach((h, i) => { if (h >= 0) (handlers.get(h) ?? handlers.set(h, []).get(h)).push(i) })
    const guarded = handlers.size > 0
    let route = [';', ['=', S.NEXT, [null, -1]], ['throw', '__e']]
    for (const [h, ids] of handlers) {
      const cond = ids.map(i => ['===', S.NEXT, [null, i]]).reduce((a, b) => ['||', a, b])
      route = ['if', cond, ['{}', [';', ['=', S.ERR, '__e'], ['=', S.NEXT, [null, h]], ['continue']]], ['{}', route]]
    }
    const loopBody = ['try', guarded
      ? [';', ['if', S.THRSET, ['{}', [';', ['=', S.THRSET, [null, false]], ['throw', S.THR]]]], dispatch]
      : dispatch, ['catch', '__e', ['{}', route]]]
    const nextBody = ['{}', [';',
      ['=', S.SENT, '__in'],
      ['while', [null, true], ['{}', [';', loopBody]]],
    ]]

    // The locals are declared ahead of the steps that initialize them, each
    // where its declaration stood: they hold no value before (TDZ, src/ast.js).
    const decls = [
      ['let', ['=', S.NEXT, [null, 0]], ['=', S.SENT, [null, undefined]],
        ...(guarded ? [['=', S.ERR, [null, undefined]], ['=', S.THR, [null, undefined]], ['=', S.THRSET, [null, false]]] : [])],
      ...(locals.size ? [['let', TDZ, ...locals]] : []),
      ['const', ['=', '__next', ['=>', '__in', nextBody]]],
    ]

    const nextFn = ['=>', '__v', ['()', '__next', '__v']]
    const at = (ids) => ids.map(i => ['===', S.NEXT, [null, i]]).reduce((a, b) => ['||', a, b])
    // a yield*'s yield resumes with the completion's kind and value
    const deliver = (k) => delivered.map(({ resume, kind }) => ['if', at([resume]),
      ['{}', [';', ['=', kind, [null, k]], ['return', ['()', '__next', '__v']]]]])
    const closing = []
    for (const { s, ids } of entries.values()) closing.push(['if', at(ids),
      ['{}', [';', ['=', returned, '__v'], ['=', S.NEXT, [null, s]], ['return', ['()', '__next', [null, undefined]]]]]])
    const returnFn = ['=>', '__v', ['{}', [';', ...deliver(2), ...closing,
      ['=', S.NEXT, [null, -1]],
      ['return', record('__v', true)]]]]
    // throw(v): with try regions the exception is raised at the resume point
    // (the machine's own catch routes it); without, no handler can exist, so
    // close the machine and rethrow to the caller of throw().
    const throwFn = guarded
      ? ['=>', '__v', ['{}', [';', ...deliver(1), ['=', S.THR, '__v'], ['=', S.THRSET, [null, true]], ['return', ['()', '__next', [null, undefined]]]]]]
      : ['=>', '__v', ['{}', [';', ...deliver(1), ['=', S.NEXT, [null, -1]], ['throw', '__v']]]]

    // Helper-bearing programs mint through __it_mk (decorated iterator —
    // map/filter/… as value-position methods); others keep the bare record.
    if (iterProto?.helpers) {
      return ['=>', transformParams(params), ['{}', [';', ...paramInit, ...decls,
        ['return', ['()', '__it_mk', [',', nextFn, returnFn, throwFn]]]]]]
    }
    const iterator = genTemp('iterator')
    const genObj = ['{}', [',',
      [':', 'next', nextFn],
      [':', 'return', returnFn],
      [':', 'throw', throwFn],
      [':', '@@iterator', ['=>', null, iterator]],
    ]]

    return ['=>', transformParams(params), ['{}', [';', ...paramInit, ...decls,
      ['const', ['=', iterator, genObj]], ['return', iterator]]]]
  }

  // ---- ES2025 iterator-helper chain fusion ----
  // `g(args).map(f).filter(p).take(n)` rooted at a KNOWN generator call fuses
  // into ONE while-next loop — no intermediate iterator objects. Consuming
  // positions: a for-of head, or a terminal helper (toArray/reduce/forEach/
  // some/every/find) in expression position. A chain stored as a VALUE is out
  // of the v1 model (the object has no helper methods — the known-receiver
  // fail-fast reports it precisely).
  const STAGE_HELPERS = new Set(['map', 'filter', 'take', 'drop'])
  const TERMINAL_HELPERS = new Set(['toArray', 'reduce', 'forEach', 'some', 'every', 'find'])

  // Unwind `root.h1(a).h2(b)…` → { root: ['()', gen, args], stages: [{h, args}] }
  // when the root is a known generator call; null otherwise.
  function unwindChain(node) {
    const stages = []
    let cur = node
    while (Array.isArray(cur) && cur[0] === '()' && Array.isArray(cur[1]) && cur[1][0] === '.') {
      const helper = cur[1][2]
      if (!STAGE_HELPERS.has(helper) && !TERMINAL_HELPERS.has(helper)) return null
      stages.unshift({ h: helper, args: cur[2] == null ? [] : (Array.isArray(cur[2]) && cur[2][0] === ',' ? cur[2].slice(1) : [cur[2]]) })
      cur = cur[1][1]
    }
    if (!(Array.isArray(cur) && cur[0] === '()' && typeof cur[1] === 'string' && generatorNames?.has(cur[1]))) return null
    return { root: cur, stages }
  }

  // Compose the per-item body: stage transforms wrap `emit(x)` — the innermost
  // callback receives the final item statements.
  // Returns statements for the while body given (xName, emitStmts).
  function stageBody(stages, x, temp, emitStmts) {
    // build from the last stage outward
    let build = emitStmts
    for (let i = stages.length - 1; i >= 0; i--) {
      const { h, args } = stages[i]
      const inner = build
      if (h === 'map') {
        // spec: fn(value, counter)
        const fn = args[0], c = temp('mc')
        build = () => [['=', x, ['()', fn, [',', x, c]]], ['=', c, ['+', c, [null, 1]]], ...inner()]
        build.decls = [[c, [null, 0]]].concat(inner.decls || [])
      } else if (h === 'filter') {
        const fn = args[0], c = temp('fc'), hv = temp('fh')
        build = () => [
          ['=', hv, ['()', fn, [',', x, c]]],
          ['=', c, ['+', c, [null, 1]]],
          ['if', hv, ['{}', [';', ...inner()]]]]
        build.decls = [[c, [null, 0]], [hv, [null, undefined]]].concat(inner.decls || [])
      } else if (h === 'take') {
        // the limit is checked before the next pull, and reaching it closes the source
        const n = args[0], c = temp('tk')
        build = () => [['=', c, ['+', c, [null, 1]]], ...inner()]
        build.decls = [[c, [null, 0]]].concat(inner.decls || [])
        build.limits = [[c, n]].concat(inner.limits || [])
      } else if (h === 'drop') {
        const n = args[0], c = temp('dp')
        build = () => [
          ['if', ['<', c, n], ['{}', [';', ['=', c, ['+', c, [null, 1]]], ['continue']]]],
          ...inner()]
        build.decls = [[c, [null, 0]]].concat(inner.decls || [])
      }
      if (!build.decls && inner.decls) build.decls = inner.decls
      if (!build.limits && inner.limits) build.limits = inner.limits
    }
    return build
  }

  // Fused loop skeleton: declares it/r (+stage counters), loops next(). A
  // stage callback, the body or a terminal leaving early closes the generator.
  function fusedLoop(root, stages, temp, x, emitStmts, prologue = [], epilogue = []) {
    const it = temp('gi'), r = temp('gr'), closes = closesGenerator(root)
    const build = stageBody(stages, x, temp, emitStmts)
    // a take() at its limit stops before another pull, closing the source
    const limits = (build.limits || []).map(([c, n]) =>
      ['if', ['>=', c, n], ['{}', [';', ...(closes ? closeGenerator(it) : []), ['break']]]])
    return ['{}', [';',
      ['const', ['=', it, root]],
      ['let', ['=', x, [null, undefined]], ['=', r, [null, undefined]],
        ...(build.decls || []).map(([n, init]) => ['=', n, init])],
      ...prologue,
      ...pullLoop(it, r, limits, [['=', x, ['.', r, 'value']], ...build()], closes, temp),
      ...epilogue,
    ]]
  }

  // Terminal helper in EXPRESSION position → IIFE returning the reduction.
  function fuseTerminal(chain, temp) {
    const { root, stages } = chain
    const last = stages[stages.length - 1]
    if (!TERMINAL_HELPERS.has(last.h)) return null
    const mid = stages.slice(0, -1)
    const x = temp('gx'), acc = temp('ga'), cn = temp('gc')
    const T = last.h, A = last.args
    const ret = (v) => ['return', v]
    const bump = ['=', cn, ['+', cn, [null, 1]]]
    // spec: every terminal callback receives (…, value, counter)
    let prologue = [], emit, epilogue
    if (T === 'toArray') {
      prologue = [['let', ['=', acc, ['[]', null]]]]
      emit = () => [['()', ['.', acc, 'push'], x]]
      epilogue = [ret(acc)]
    } else if (T === 'reduce') {
      // no initial value → the first element seeds the accumulator (counter
      // starts at 1 for the first reducer call); empty + no init throws.
      const first = temp('gf')
      const noInit = A[1] === undefined
      prologue = [['let', ['=', cn, [null, 0]], ['=', first, [null, noInit]],
        ['=', acc, noInit ? [null, undefined] : A[1]]]]
      emit = () => [
        ['if', first,
          ['{}', [';', ['=', acc, x], ['=', first, [null, false]]]],
          ['{}', [';', ['=', acc, ['()', A[0], [',', acc, x, cn]]]]]],
        bump]
      epilogue = [
        ...(noInit ? [['if', first, ['throw', [null, 'Reduce of empty iterator with no initial value']]]] : []),
        ret(acc)]
    } else if (T === 'forEach') {
      prologue = [['let', ['=', cn, [null, 0]]]]
      emit = () => [['()', A[0], [',', x, cn]], bump]
      epilogue = [ret([null, undefined])]
    } else if (T === 'some') {
      prologue = [['let', ['=', cn, [null, 0]]]]
      emit = () => [['if', ['()', A[0], [',', x, cn]], ['{}', [';', ret([null, true])]]], bump]
      epilogue = [ret([null, false])]
    } else if (T === 'every') {
      prologue = [['let', ['=', cn, [null, 0]]]]
      emit = () => [['if', ['!', ['()', A[0], [',', x, cn]]], ['{}', [';', ret([null, false])]]], bump]
      epilogue = [ret([null, true])]
    } else if (T === 'find') {
      prologue = [['let', ['=', cn, [null, 0]]]]
      emit = () => [['if', ['()', A[0], [',', x, cn]], ['{}', [';', ret(x)]]], bump]
      epilogue = [ret([null, undefined])]
    } else return null
    const body = fusedLoop(root, mid, temp, x, emit, prologue, epilogue)
    const iife = ['()', ['=>', ['()', null], body], null]
    // a loop-bearing arrow with multiple boolean returns loses bool kind
    // (stringifies as '1') — !! restores it for the predicate terminals
    return T === 'some' || T === 'every' ? ['!', ['!', iife]] : iife
  }

  // A generator object's own return(): closing it runs its pending finally
  // blocks. A call of a known generator whose return() has none needs none.
  const closeGenerator = (it) => [['()', ['.', it, 'return'], null]]
  const abortGenerator = (it, temp) => [['try', ['{}', [';', ...closeGenerator(it)]], ['catch', temp('gq'), ['{}', null]]]]
  const closesGenerator = (call) => !(Array.isArray(call) && call[0] === '()' && typeof call[1] === 'string' &&
    generatorNames?.has(call[1]) && !generatorCloses?.has(call[1]))

  // `while (true)` pulling the generator `it` into `r` at the TOP, then `body`:
  // a stage or user `continue` must advance to the NEXT item, where a tail pull
  // would be skipped and re-process the same value forever (the drop()-stage /
  // user-continue hazard). `before` runs ahead of each pull.
  const pullLoop = (it, r, before, body, closes, temp, labels) => {
    const pull = [['=', r, ['()', ['.', it, 'next'], null]], ['if', ['.', r, 'done'], ['{}', [';', ['break']]]]]
    if (!closes) return [labeled(labels, ['while', [null, true], ['{}', [';', ...before, ...pull, ...body]]])]
    const open = temp('go')
    return [['let', ['=', open, [null, false]]], closingLoop(labeled(labels, ['while', [null, true], ['{}', [';',
      ['=', open, [null, false]], ...before, ...pull, ['=', open, [null, true]], ...body]]]),
      open, closeGenerator(it), abortGenerator(it, temp), temp('ge'), [';', ...body])]
  }

  // for-of over a KNOWN generator call → while-next desugar (fusion-friendly:
  // the optimizer sees plain closure calls + a fixed-shape result object).
  function desugarForOfGenerator(decl, iterExpr, body, temp, labels) {
    const it = temp('gi'), r = temp('gr')
    return ['{}', [';',
      ['const', ['=', it, iterExpr]],
      ['let', ['=', r, [null, undefined]]],
      ...pullLoop(it, r, [], [bindTo(decl, ['.', r, 'value']), ...bodyStmts(body)], closesGenerator(iterExpr), temp, labels),
    ]]
  }

  // for-of over an UNKNOWN source in a program that mints iterators: unwrap a
  // ['@@iterator']() provider, then a callable `next` drives the machine
  // LAZILY (pull-at-top — a `break` stops pulling, spec-faithful); anything
  // else falls to the indexed array path. 'of-idx' marks that arm so the fork
  // doesn't re-enter. The probes run once per loop, not per iteration, and
  // programs without iterator producers never take this shape (iterProto
  // gate) — they compile byte-identically.
  function desugarForOfProtocol(decl, iterExpr, body, temp, labels) {
    // `w` starts as a COPY of the source and takes the @@iterator() result —
    // the source local stays single-assignment so its precise kind keeps
    // serving the probe reads above the fork.
    const v = temp('gv'), w = temp('gw'), r = temp('gr'), open = temp('go'), value = temp('gn'), result = temp('gq')
    const NULL = [null, null]
    // IteratorClose in place, as next() is called: `w` keeps this loop's
    // kinds (a helper's parameter would join every loop's iterators). A
    // non-callable return() throws its TypeError by the call.
    const close = [['if', ['!=', ['.', w, 'return'], NULL], ['{}', [';',
      ['=', result, ['()', ['.', w, 'return'], null]],
      ['if', ['||', ['==', result, NULL], ['&&', ['!==', ['typeof', result], [null, 'object']], ['!==', ['typeof', result], [null, 'function']]]],
        ['throw', ['new', ['()', 'TypeError', [null, 'iterator return result is not an object']]]]]]]]]
    const abort = [['try', ['{}', [';', ['if', ['!=', ['.', w, 'return'], NULL], ['()', ['.', w, 'return'], null]]]],
      ['catch', temp('ge'), ['{}', null]]]]
    // A value read throws before the binding, which closes on its own errors.
    return ['{}', [';',
      ['let', ['=', v, iterExpr]],
      ['let', ['=', w, v]],
      ['if', ['&&', ['!=', v, NULL], ['!=', ['.', v, '@@iterator'], NULL]],
        ['=', w, ['()', probe(v, '@@iterator'), null]]],
      ['if', ['&&', ['!=', w, NULL], ['!=', ['.', w, 'next'], NULL]],
        ['{}', [';',
          ['let', ['=', r, [null, undefined]], ['=', open, [null, false]], ['=', value, [null, undefined]], ['=', result, [null, undefined]]],
          closingLoop(labeled(labels, ['while', [null, true], ['{}', [';',
            ['=', open, [null, false]],
            ['=', r, ['()', ['.', w, 'next'], null]],
            ['if', ['.', r, 'done'], ['{}', [';', ['break']]]],
            ['=', value, ['.', r, 'value']],
            ['=', open, [null, true]],
            bindTo(decl, value),
            ...bodyStmts(body),
          ]]]), open, close, abort, temp('ge'), body),
        ]],
        labeled(labels, ['for', ['of-idx', decl, w], body])],
    ]]
  }

  return { lowerGenerator, desugarForOfGenerator, desugarForOfProtocol, unwindChain, fuseTerminal, fusedLoop, bindTo, isTerminal: (h) => TERMINAL_HELPERS.has(h) }
}
