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
 *   - yield as a statement, or as the RHS of `let x = yield E` / `x = yield E`
 *   - yield inside if/else, while, do-while and C-style for (any nesting)
 *   - plain `return E` anywhere; unlabeled break/continue of yield-bearing loops
 *   - compound statements WITHOUT yield stay atomic (later passes handle them)
 *   - yield* E — delegates to ANY iterator-protocol value (sent values thread,
 *     the completion value lands in `x = yield* E`)
 * Out (v1): yield inside arbitrary expressions, try across yield,
 * for-of/for-in bodies containing yield (except known-generator for-of, which
 * desugars), labeled break/continue across states.
 *
 * @module jzify/generators
 */

import { walkAst, some, isBlockBody } from '../src/ast.js'

const isYield = (n) => Array.isArray(n) && (n[0] === 'yield' || n[0] === 'yield*')
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

// A break/continue that would bind OUTSIDE this statement (its target loop was
// decomposed into states, so the raw op would bind my dispatch while(1) instead).
// Inner loops re-bind their own jumps; nested function forms bind their own.
const hasFreeJump = (n, depth = 0) => {
  if (!Array.isArray(n)) return false
  const op = n[0]
  if ((op === 'break' || op === 'continue') && n[1] == null) return depth === 0
  if (FN_BOUNDARY_OPS.has(op)) return false
  const inner = op === 'while' || op === 'do' || op === 'for' || op === 'for-in' ||
    op === 'for-of' || op === 'switch' ? depth + 1 : depth
  return n.some((c, i) => i > 0 && hasFreeJump(c, inner))
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

// ES2025 iterator helpers on iterator VALUES ride `jz:iter-helpers` (src/std),
// imported when a program that mints iterators also uses helper methods in
// non-fusable positions (chain stored as a value, helper on an unknown
// receiver) or tests `instanceof Iterator`; generator objects then mint
// through `__it_mk`. `Array.from(x)` over iterator values rides `jz:iter-arr`.

export function createGeneratorLowering({ transform, err, generatorNames, genTemp, iterProto }) {
  // A destructuring declaration in the body binds through a temp: the machine
  // hoists plain names only, so `let { a, b: c, d = 1 } = e` becomes the
  // declarators `t = e, a = t.a, c = t.b, d = t.d ?? 1` (arrays by index, a
  // rest element by slice, nested patterns recursively). prepare's own
  // destructuring never sees a generator body (the machine lowers first).
  const patternDecls = (pat, src, out) => {
    const items = (n) => n == null ? [] : Array.isArray(n) && n[0] === ',' ? n.slice(1) : [n]
    const bind = (target, value) => {
      if (typeof target === 'string') { out.push(['=', target, value]); return }
      if (Array.isArray(target) && target[0] === '=') {   // default: `name = dflt`
        const t = genTemp('pd'); out.push(['=', t, value])
        bind(target[1], ['??', t, target[2]]); return
      }
      if (Array.isArray(target) && (target[0] === '{}' || target[0] === '[]')) {
        const t = genTemp('pt'); out.push(['=', t, value]); patternDecls(target, t, out); return
      }
      err('generators v1: this destructuring shape inside a generator body is not supported yet – bind names first')
    }
    if (pat[0] === '{}') {
      for (const it of items(pat[1])) {
        if (typeof it === 'string') bind(it, ['.', src, it])
        else if (Array.isArray(it) && it[0] === ':') bind(it[2], ['.', src, it[1]])
        else if (Array.isArray(it) && it[0] === '=') bind(it, ['.', src, it[1]])
        else err('generators v1: this destructuring shape inside a generator body is not supported yet – bind names first')
      }
    } else {
      items(pat[1]).forEach((it, i) => {
        if (it == null) return
        if (Array.isArray(it) && it[0] === '...') bind(it[1], ['()', ['.', src, 'slice'], [null, i]])
        else bind(it, ['[]', src, [null, i]])
      })
    }
  }
  const desugarPatternDecls = (node) => {
    if (!Array.isArray(node)) return node
    if (FN_BOUNDARY_OPS.has(node[0])) return node
    if ((node[0] === 'let' || node[0] === 'const') && node.some((d, i) => i > 0 && Array.isArray(d) && d[0] === '=' && Array.isArray(d[1]))) {
      // one declarator per statement: the machine's `let x = yield E` case
      // takes a lone declarator, and the temp's initializer may be that yield
      const out = []
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && Array.isArray(d[1])) {
          const t = genTemp('pv'); out.push(['=', t, desugarPatternDecls(d[2])]); patternDecls(d[1], t, out)
        } else out.push(Array.isArray(d) ? ['=', d[1], desugarPatternDecls(d[2])] : d)
      }
      return [';', ...out.map(d => ['let', d])]
    }
    return node.map((n, i) => i === 0 ? n : desugarPatternDecls(n))
  }
  // Hoisting flattens block scopes into the factory scope: a name declared in
  // two blocks (`for (let i …)` twice, an `i` in each `if` arm) would be one
  // hoisted local, so every later declaration renames apart (`i`, `i$1`) with
  // its references, scope by scope, before the collect below. A block, a loop
  // head, an `if` arm and a catch clause open a scope; a nested function sees
  // the renamed outer name unless it rebinds it, and its own declarations are
  // not hoisted, so they keep their spelling.
  const uniqueLocals = (body) => {
    const taken = new Set()
    let uid = 0
    const declNames = (st) => {
      const out = []
      if (Array.isArray(st) && (st[0] === 'let' || st[0] === 'const'))
        for (let i = 1; i < st.length; i++) { const d = st[i]; const n = Array.isArray(d) && d[0] === '=' ? d[1] : d; if (typeof n === 'string') out.push(n) }
      return out
    }
    // declare the statement's names into env: a repeat renames, a first keeps its spelling
    const declare = (st, env, hoisted) => {
      for (const n of declNames(st)) {
        if (!hoisted) { env.delete(n); continue }
        if (taken.has(n)) env.set(n, `${n}$${++uid}`)
        else { taken.add(n); env.delete(n) }
      }
    }
    const paramNames = (params) => { const out = []; walkAst(Array.isArray(params) ? params : [null, params], { enter: n => { for (const c of n) if (typeof c === 'string' && c !== '()' && c !== ',' && c !== '...' && c !== '=') out.push(c) } }); return out }
    const walk = (n, env, hoisted) => {
      if (typeof n === 'string') return env.get(n) ?? n
      if (!Array.isArray(n) || n[0] == null || n[0] === 'str') return n
      const op = n[0]
      if (op === '.' || op === '?.') return [op, walk(n[1], env, hoisted), n[2]]
      if (op === ':') return [op, n[1], walk(n[2], env, hoisted)]
      if (op === 'class') return n
      // object literal shorthand `{ i }` is key and reference at once
      if (op === '{}' && n.length === 2 && !isBlockBody(n)) {
        const items = Array.isArray(n[1]) && n[1][0] === ',' ? n[1].slice(1) : [n[1]]
        const out = items.map(it => typeof it === 'string' && env.has(it) ? [':', it, env.get(it)] : walk(it, env, hoisted))
        return ['{}', out.length === 1 ? out[0] : [',', ...out]]
      }
      if (op === '=>' || op === 'function' || op === 'function*' || op === 'async') {
        if (op === 'async') return [op, walk(n[1], env, false)]
        const inner = new Map(env)
        const params = op === '=>' ? n[1] : n[2], body = op === '=>' ? n[2] : n[3]
        for (const p of paramNames(params)) inner.delete(p)
        const out = n.slice()
        out[op === '=>' ? 1 : 2] = walk(params, inner, false)
        out[op === '=>' ? 2 : 3] = scope(body, inner, false)
        return out
      }
      if (op === 'for') {
        const inner = new Map(env)
        const head = n[1]
        let outHead
        if (Array.isArray(head) && (head[0] === 'of' || head[0] === 'in')) {
          declare(head[1], inner, hoisted)
          outHead = [head[0], walk(head[1], inner, hoisted), walk(head[2], env, hoisted)]
        } else if (Array.isArray(head) && head[0] === ';') {
          if (Array.isArray(head[1]) && (head[1][0] === 'let' || head[1][0] === 'const')) declare(head[1], inner, hoisted)
          outHead = head.map((c, i) => i === 0 ? c : walk(c, inner, hoisted))
        } else outHead = walk(head, inner, hoisted)
        return ['for', outHead, scope(n[2], inner, hoisted)]
      }
      if (op === 'while' || op === 'do') return [op, walk(n[1], env, hoisted), scope(n[2], env, hoisted)]
      if (op === 'if') return ['if', walk(n[1], env, hoisted), scope(n[2], env, hoisted), ...(n.length > 3 ? [scope(n[3], env, hoisted)] : [])]
      if (op === 'try') return n.map((c, i) => {
        if (i === 0) return c
        if (Array.isArray(c) && c[0] === 'catch') { const inner = new Map(env); if (typeof c[1] === 'string') inner.delete(c[1]); return ['catch', c[1], scope(c[2], inner, hoisted)] }
        if (Array.isArray(c) && c[0] === 'finally') return ['finally', scope(c[1], env, hoisted)]
        return scope(c, env, hoisted)
      })
      if (op === '{}') return scope(n, env, hoisted)
      if (op === 'switch') { const inner = new Map(env); return n.map((c, i) => i === 0 ? c : walk(c, inner, hoisted)) }
      if (op === ';') return list(n.slice(1), env, hoisted, ';')
      if (op === 'let' || op === 'const') {
        // the declarator's own initializer sees the new name (`let go = () => go()`)
        declare(n, env, hoisted)
        return n.map((d, i) => i === 0 ? d : typeof d === 'string' ? (env.get(d) ?? d) : ['=', walk(d[1], env, hoisted), walk(d[2], env, hoisted)])
      }
      return n.map((c, i) => i === 0 ? c : walk(c, env, hoisted))
    }
    // a statement in scope position: a block, a sequence or a lone statement
    const scope = (n, env, hoisted) => {
      const inner = new Map(env)
      if (Array.isArray(n) && n[0] === '{}' && isBlockBody(n)) {
        const stmts = n.length === 1 ? [] : Array.isArray(n[1]) && n[1][0] === ';' ? n[1].slice(1) : [n[1]]
        const out = list(stmts, inner, hoisted, ';')
        return ['{}', out]
      }
      return walk(n, inner, hoisted)
    }
    // statements sharing one scope, in order: a declaration renames what follows
    const list = (stmts, env, hoisted, head) => [head, ...stmts.map(st => walk(st, env, hoisted))]
    const env = new Map()
    return body.map(st => walk(st, env, true))
  }
  // Collect every let/const binding name in the body — generator locals live in
  // the factory scope so they survive across next() resumes (shadowing renamed
  // apart by uniqueLocals above).
  const collectLocals = (node, out, path) => walkAst(node, { enter: n => {
    if ((n[0] === 'let' || n[0] === 'const')) {
      for (let i = 1; i < n.length; i++) {
        const d = n[i]
        const name = Array.isArray(d) && d[0] === '=' ? d[1] : d
        if (typeof name !== 'string')
          err('generators v1: this destructuring shape inside a generator body is not supported yet – bind names first')
        if (out.has(name)) err(`generators v1: '${name}' is declared twice in the generator body — hoisted locals must be unique`)
        out.add(name)
      }
    }
    // nested function forms create their own scope — their decls don't hoist
    if (FN_BOUNDARY_OPS.has(n[0])) return false
  } })

  function lowerGenerator(params, rawBody) {
    const body = blockStmts(rawBody)

    // JS hoists function declarations: a machine body binds its TOP-LEVEL
    // ones as consts up front (the machine assigns hoisted locals before
    // dispatch reaches any user statement, so call-before-declaration keeps
    // working). The const-bound function EXPRESSION rides the proven closure
    // lane; the raw declaration statement would otherwise reach the machine
    // splice as an unresolvable reference (transform-level hoistFnDecl binds
    // a scope the __next closure never sees). Block-nested declarations stay
    // a named v1 reject in flattenStmt below.
    for (let i = 0; i < body.length; i++) {
      const st = body[i]
      if (Array.isArray(st) && st[0] === 'function' && st[1]) {
        body.splice(i, 1)
        body.unshift(['const', ['=', st[1], ['function', '', st[2], st[3]]]])
      }
    }

    for (let i = 0; i < body.length; i++) body[i] = desugarPatternDecls(body[i])
    body.splice(0, body.length, ...uniqueLocals(body))
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
    const newState = () => (states.push([]), stateHandler.push(curHandler), states.length - 1)
    const stmtsOf = (id) => states[id]
    const setState = (id) => [';;set', id]           // internal marker, resolved below
    const gotoIR = (id) => [[';;set', id], [';;continue']]

    // `yield E` at a resume boundary: park the resume id, emit the {value,done:false}
    // return. The resume state optionally starts by binding `target = __sent`.
    const emitYield = (cur, yexpr, target) => {
      const resume = newState()
      const value = yexpr[1] === undefined ? [null, undefined] : transform(yexpr[1])
      stmtsOf(cur).push(
        [';;set', resume],
        ['return', ['{}', [',', [':', 'value', value], [':', 'done', [null, false]]]]])
      if (target) stmtsOf(resume).push(['=', target, S.SENT])
      return resume
    }

    // yield* E — the delegate loop is nothing but already-supported constructs:
    // sent values thread through (`sent = yield r.value; r = it.next(sent)`),
    // and the delegate's COMPLETION value (final r.value) lands in `target`.
    // E may be any iterable: an ['@@iterator']() provider unwraps first; a
    // plain indexed iterable (array/string) yields element-wise (fork mirrors
    // desugarForOfProtocol; both arms decompose like any generator-body loop).
    const desugarYieldStar = (expr, target) => {
      // the source copies before the @@iterator() unwrap — single-assignment
      // locals keep the probe reads on the precise kind.
      const src = genTemp('yv'), it = genTemp('yi'), r = genTemp('yr'), sent = genTemp('ys'), ix = genTemp('yx')
      locals.add(src); locals.add(it); locals.add(r); locals.add(sent); locals.add(ix)
      const NULL = [null, null]
      return ['{}', [';',
        ['=', src, expr],
        ['=', it, src],
        ['if', ['&&', ['!=', src, NULL], ['!=', ['.', src, '@@iterator'], NULL]],
          ['=', it, ['()', ['.', src, '@@iterator'], null]]],
        ['if', ['&&', ['!=', it, NULL], ['!=', ['.', it, 'next'], NULL]],
          ['{}', [';',
            ['=', r, ['()', ['.', it, 'next'], null]],
            ['while', ['!', ['.', r, 'done']], ['{}', [';',
              ['=', sent, ['yield', ['.', r, 'value']]],
              ['=', r, ['()', ['.', it, 'next'], sent]],
            ]]],
            ...(target ? [['=', target, ['.', r, 'value']]] : []),
          ]],
          ['{}', [';',
            ['=', ix, [null, 0]],
            ['while', ['<', ix, ['.', it, 'length']], ['{}', [';',
              ['yield', ['[]', it, ix]],
              ['=', ix, ['+', ix, [null, 1]]],
            ]]],
            ...(target ? [['=', target, [null, undefined]]] : []),
          ]]],
      ]]
    }

    // Flatten a statement list into states. Returns the state id control falls
    // into after the list (or null if control never falls through).
    // loopCtx = { cont, brk } target state ids for the innermost decomposed loop.
    const flattenList = (stmts, cur, loopCtx) => {
      for (const st of stmts) {
        if (cur == null) return null   // unreachable code after a terminator — drop
        cur = flattenStmt(st, cur, loopCtx)
      }
      return cur
    }

    const flattenStmt = (st, cur, loopCtx) => {
      if (!Array.isArray(st)) { if (st != null) stmtsOf(cur).push(transform(st)); return cur }
      const op = st[0]

      // --- yield forms ---
      if (op === 'yield*') return flattenStmt(desugarYieldStar(st[1], null), cur, loopCtx)
      if (op === 'yield') return emitYield(cur, st, null)
      if ((op === 'let' || op === 'const') && st.length === 2 && Array.isArray(st[1]) &&
          st[1][0] === '=' && isYield(st[1][2])) {
        if (st[1][2][0] === 'yield*') return flattenStmt(desugarYieldStar(st[1][2][1], st[1][1]), cur, loopCtx)
        return emitYield(cur, st[1][2], st[1][1])
      }
      if (op === '=' && typeof st[1] === 'string' && isYield(st[2])) {
        if (st[2][0] === 'yield*') return flattenStmt(desugarYieldStar(st[2][1], st[1]), cur, loopCtx)
        return emitYield(cur, st[2], st[1])
      }
      // `name.prop = yield E` (a field set from an await): the value lands in a
      // temp at the resume, then the store – the receiver is a plain name, so
      // evaluating it after the yield changes nothing observable
      if (op === '=' && Array.isArray(st[1]) && st[1][0] === '.' && typeof st[1][1] === 'string' && isYield(st[2]) && st[2][0] === 'yield') {
        const t = genTemp('ya'); locals.add(t)
        const resume = emitYield(cur, st[2], t)
        stmtsOf(resume).push(['=', st[1], t])
        return resume
      }

      // --- return ---
      if (op === 'return') {
        const v = st[1] === undefined ? [null, undefined] : transform(st[1])
        stmtsOf(cur).push(
          [';;set', -1],
          ['return', ['{}', [',', [':', 'value', v], [':', 'done', [null, true]]]]])
        return null
      }

      // --- break/continue of a DECOMPOSED loop ---
      if (op === 'break' && st[1] == null && loopCtx) { stmtsOf(cur).push(...gotoIR(loopCtx.brk)); return null }
      if (op === 'continue' && st[1] == null && loopCtx) { stmtsOf(cur).push(...gotoIR(loopCtx.cont)); return null }

      // --- function declarations: top-level ones were hoisted to consts by
      // lowerGenerator's pre-pass; one reaching HERE sits inside a DECOMPOSED
      // block — name the v1 limit instead of leaking an unresolvable ref ---
      if (op === 'function' && st[1])
        err(`generators v1: function declaration '${st[1]}' inside a decomposed async/generator block is not supported yet — move it to the function's top level or bind it as \`const ${st[1]} = function () { … }\``)

      // --- a statement list flattens statement by statement: its `let`s are
      // hoisted machine locals and must become assignments, never a nested
      // block's own bindings shadowing them ---
      if (op === '{}' || op === ';') return flattenList(blockStmts(st), cur, loopCtx)

      // --- compound statements stay atomic only when they carry no yield, no
      // plain return (see hasReturn — a nested return must reach the `return`
      // case above, not fall-through as a bare host return), AND no
      // break/continue that binds a DECOMPOSED loop (the raw op would bind the
      // dispatch while(1) instead — an infinite next()) ---
      if (!hasYield(st) && !hasReturn(st) && !(loopCtx && hasFreeJump(st))) {
        // let/const initializers become assignments (names are hoisted)
        if (op === 'let' || op === 'const') {
          for (let i = 1; i < st.length; i++) {
            const d = st[i]
            if (Array.isArray(d) && d[0] === '=') stmtsOf(cur).push(['=', d[1], transform(d[2])])
          }
          return cur
        }
        stmtsOf(cur).push(transform(st))
        return cur
      }

      // --- yield-bearing control ---
      if (op === 'if') {
        const [, cond, thenB, elseB] = st
        const join = newState()
        const thenS = newState()
        const elseS = elseB != null ? newState() : join
        stmtsOf(cur).push(['if', transform(cond), [';', ...gotoIR(thenS)], [';', ...gotoIR(elseS)]], [';;continue'])
        const tEnd = flattenList(blockStmts(thenB), thenS, loopCtx)
        if (tEnd != null) stmtsOf(tEnd).push(...gotoIR(join))
        if (elseB != null) {
          const eEnd = flattenList(blockStmts(elseB), elseS, loopCtx)
          if (eEnd != null) stmtsOf(eEnd).push(...gotoIR(join))
        }
        return join
      }
      if (op === 'while') {
        const [, cond, bodyB] = st
        const test = newState(), bodyS = newState(), exit = newState()
        stmtsOf(cur).push(...gotoIR(test))
        stmtsOf(test).push(['if', transform(cond), [';', ...gotoIR(bodyS)], [';', ...gotoIR(exit)]], [';;continue'])
        const bEnd = flattenList(blockStmts(bodyB), bodyS, { cont: test, brk: exit })
        if (bEnd != null) stmtsOf(bEnd).push(...gotoIR(test))
        return exit
      }
      if (op === 'do') {
        const [, bodyB, cond] = st
        const bodyS = newState(), test = newState(), exit = newState()
        stmtsOf(cur).push(...gotoIR(bodyS))
        const bEnd = flattenList(blockStmts(bodyB), bodyS, { cont: test, brk: exit })
        if (bEnd != null) stmtsOf(bEnd).push(...gotoIR(test))
        stmtsOf(test).push(['if', transform(cond), [';', ...gotoIR(bodyS)], [';', ...gotoIR(exit)]], [';;continue'])
        return exit
      }
      if (op === 'for') {
        const [, head, bodyB] = st
        // for-of over a KNOWN generator call inside a generator body: desugar to
        // the while-next form first — the result is yield-decomposable.
        if (Array.isArray(head) && head[0] === 'of' && Array.isArray(head[2]) &&
            head[2][0] === '()' && typeof head[2][1] === 'string' && generatorNames?.has(head[2][1])) {
          const localTemp = (t) => { const n = genTemp(t); locals.add(n); return n }
          return flattenStmt(desugarForOfGenerator(head[1], head[2], bodyB, localTemp), cur, loopCtx)
        }
        if (Array.isArray(head) && (head[0] === 'of' || head[0] === 'in'))
          err('generators v1: yield inside for-of/for-in is not supported yet — use an indexed for')
        // C-style [';', init, cond, step] (subscript head shape)
        const [, init, cond, step] = Array.isArray(head) && head[0] === ';' ? head : [';', head, undefined, undefined]
        if (init != null) flattenStmt(init, cur, null) === cur || err('generators v1: yield in a for-init is not supported — move the initializer before the loop')
        const test = newState(), bodyS = newState(), stepS = newState(), exit = newState()
        stmtsOf(cur).push(...gotoIR(test))
        stmtsOf(test).push(['if', cond == null ? [null, true] : transform(cond), [';', ...gotoIR(bodyS)], [';', ...gotoIR(exit)]], [';;continue'])
        const bEnd = flattenList(blockStmts(bodyB), bodyS, { cont: stepS, brk: exit })
        if (bEnd != null) stmtsOf(bEnd).push(...gotoIR(stepS))
        if (step != null) stmtsOf(stepS).push(transform(step))
        stmtsOf(stepS).push(...gotoIR(test))
        return exit
      }
      if (op === 'try') {
        // try/catch across a yield (an await): the try body's states carry the
        // catch state as their handler; the catch binds the machine's `__err`.
        // A `finally` that yields, or a return/break/continue leaving a try
        // that has a finally (the finally would be skipped), stays out of v1.
        const catchC = st.find((c, i) => i > 1 && Array.isArray(c) && c[0] === 'catch')
        const finallyC = st.find((c, i) => i > 1 && Array.isArray(c) && c[0] === 'finally')
        if (finallyC && (hasYield(finallyC[1]) || hasReturn(st[1]) || (catchC && hasReturn(catchC[2])) || hasFreeJump(st[1]) || (catchC && hasFreeJump(catchC[2]))))
          err('generators v1: a `finally` that yields, or a return/break/continue leaving a try with a finally, is not supported yet across a yield')
        if (!catchC) {   // try/finally only: run the finally after the body (no yield in it)
          const bEnd = flattenList(blockStmts(st[1]), cur, loopCtx)
          if (bEnd == null) return null
          for (const f of blockStmts(finallyC[1])) stmtsOf(bEnd).push(transform(f))
          return bEnd
        }
        const catchS = newState(), after = newState()   // outside the region
        const outer = curHandler
        curHandler = catchS
        const bodyS = newState()
        stmtsOf(cur).push(...gotoIR(bodyS))
        const bEnd = flattenList(blockStmts(st[1]), bodyS, loopCtx)
        curHandler = outer
        const fin = finallyC ? blockStmts(finallyC[1]).map(transform) : []
        if (bEnd != null) stmtsOf(bEnd).push(...fin, ...gotoIR(after))
        if (catchC[1] != null) { locals.add(catchC[1]); stmtsOf(catchS).push(['=', catchC[1], S.ERR]) }
        const cEnd = flattenList(blockStmts(catchC[2]), catchS, loopCtx)
        if (cEnd != null) stmtsOf(cEnd).push(...fin, ...gotoIR(after))
        return after
      }
      if (op === 'catch' || op === 'finally')
        err('generators v1: a stray catch/finally clause across a yield')
      err(`generators v1: yield inside \`${op}\` is not supported yet — hoist the yield to statement position`)
    }


    const entry = newState()
    const end = flattenList(body, entry, null)
    if (end != null) stmtsOf(end).push(
      [';;set', -1],
      ['return', ['{}', [',', [':', 'value', [null, undefined]], [':', 'done', [null, true]]]]])

    // ---- assemble the dispatch loop ----
    // Internal markers resolve here: [';;set', k] → __s = k; [';;continue'] → continue.
    const resolve = (n) => {
      if (!Array.isArray(n)) return n
      if (n[0] === ';;set') return ['=', S.NEXT, [null, n[1]]]
      if (n[0] === ';;continue') return ['continue']
      return n.map(resolve)
    }
    // if-chain over states (highest → the shape jz compiles tightly)
    let dispatch = ['return', ['{}', [',', [':', 'value', [null, undefined]], [':', 'done', [null, true]]]]]
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
    const loopBody = guarded
      ? ['try', [';', ['if', S.THRSET, ['{}', [';', ['=', S.THRSET, [null, false]], ['throw', S.THR]]]], dispatch], ['catch', '__e', ['{}', route]]]
      : dispatch
    const nextBody = ['{}', [';',
      ['=', S.SENT, '__in'],
      ['while', [null, true], ['{}', [';', loopBody]]],
    ]]

    const decls = [
      ['let', ['=', S.NEXT, [null, 0]], ['=', S.SENT, [null, undefined]],
        ...(guarded ? [['=', S.ERR, [null, undefined]], ['=', S.THR, [null, undefined]], ['=', S.THRSET, [null, false]]] : []),
        ...[...locals].map(n => ['=', n, [null, undefined]])],
      ['const', ['=', '__next', ['=>', '__in', nextBody]]],
    ]

    const nextFn = ['=>', '__v', ['()', '__next', '__v']]
    const returnFn = ['=>', '__v', ['{}', [';',
      ['=', S.NEXT, [null, -1]],
      ['return', ['{}', [',', [':', 'value', '__v'], [':', 'done', [null, true]]]]]]]]
    // throw(v): with try regions the exception is raised at the resume point
    // (the machine's own catch routes it); without, no handler can exist, so
    // close the machine and rethrow to the caller of throw().
    const throwFn = guarded
      ? ['=>', '__v', ['{}', [';', ['=', S.THR, '__v'], ['=', S.THRSET, [null, true]], ['return', ['()', '__next', [null, undefined]]]]]]
      : ['=>', '__v', ['{}', [';', ['=', S.NEXT, [null, -1]], ['throw', '__v']]]]

    // Helper-bearing programs mint through __it_mk (decorated iterator —
    // map/filter/… as value-position methods); others keep the bare record.
    if (iterProto?.helpers) {
      return ['=>', params, ['{}', [';', ...decls,
        ['return', ['()', '__it_mk', [',', nextFn, returnFn, throwFn]]]]]]
    }
    const genObj = ['{}', [',',
      [':', 'next', nextFn],
      [':', 'return', returnFn],
      [':', 'throw', throwFn],
    ]]

    return ['=>', params, ['{}', [';', ...decls, ['return', genObj]]]]
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
        const n = args[0], c = temp('tk')
        build = () => [
          ['if', ['>=', c, n], ['{}', [';', ['break']]]],
          ['=', c, ['+', c, [null, 1]]],
          ...inner()]
        build.decls = [[c, [null, 0]]].concat(inner.decls || [])
      } else if (h === 'drop') {
        const n = args[0], c = temp('dp')
        build = () => [
          ['if', ['<', c, n], ['{}', [';', ['=', c, ['+', c, [null, 1]]], ['continue']]]],
          ...inner()]
        build.decls = [[c, [null, 0]]].concat(inner.decls || [])
      }
      if (!build.decls && inner.decls) build.decls = inner.decls
    }
    return build
  }

  // Fused loop skeleton: declares it/r (+stage counters), loops next().
  function fusedLoop(root, stages, temp, x, emitStmts, prologue = [], epilogue = []) {
    const it = temp('gi'), r = temp('gr')
    const build = stageBody(stages, x, temp, emitStmts)
    // Pull at the TOP of the body: stage/user `continue` must advance to the
    // NEXT item — a tail-position pull would be skipped and re-process the
    // same value forever (the drop()-stage / user-continue hazard).
    return ['{}', [';',
      ['const', ['=', it, root]],
      ['let', ['=', x, [null, undefined]], ['=', r, [null, undefined]],
        ...(build.decls || []).map(([n, init]) => ['=', n, init])],
      ...prologue,
      ['while', [null, true], ['{}', [';',
        ['=', r, ['()', ['.', it, 'next'], null]],
        ['if', ['.', r, 'done'], ['{}', [';', ['break']]]],
        ['=', x, ['.', r, 'value']],
        ...build(),
      ]]],
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

  // for-of over a KNOWN generator call → while-next desugar (fusion-friendly:
  // the optimizer sees plain closure calls + a fixed-shape result object).
  function desugarForOfGenerator(decl, iterExpr, body, temp) {
    const it = temp('gi'), r = temp('gr')
    const name = Array.isArray(decl) ? decl[1] : decl
    // Pull at the TOP: a user `continue` in the body must advance the iterator
    // (a tail pull would be skipped — infinite loop on the same item).
    return ['{}', [';',
      ['const', ['=', it, iterExpr]],
      ['let', ['=', r, [null, undefined]]],
      ['while', [null, true], ['{}', [';',
        ['=', r, ['()', ['.', it, 'next'], null]],
        ['if', ['.', r, 'done'], ['{}', [';', ['break']]]],
        ['let', ['=', name, ['.', r, 'value']]],
        ...(Array.isArray(body) && body[0] === ';' ? body.slice(1) : [body]),
      ]]],
    ]]
  }

  // for-of over an UNKNOWN source in a program that mints iterators: unwrap a
  // ['@@iterator']() provider, then a callable `next` drives the machine
  // LAZILY (pull-at-top — a `break` stops pulling, spec-faithful); anything
  // else falls to the indexed array path. 'of-idx' marks that arm so the fork
  // doesn't re-enter. The probes run once per loop, not per iteration, and
  // programs without iterator producers never take this shape (iterProto
  // gate) — they compile byte-identically.
  function desugarForOfProtocol(decl, iterExpr, body, temp) {
    // `w` starts as a COPY of the source and takes the @@iterator() result —
    // the source local stays single-assignment so its precise kind keeps
    // serving the probe reads above the fork.
    const v = temp('gv'), w = temp('gw'), r = temp('gr')
    const NULL = [null, null]
    const isDecl = Array.isArray(decl) && (decl[0] === 'let' || decl[0] === 'const')
    const bind = isDecl ? [decl[0], ['=', decl[1], ['.', r, 'value']]] : ['=', decl, ['.', r, 'value']]
    const bodyStmts = Array.isArray(body) && body[0] === ';' ? body.slice(1) : [body]
    return ['{}', [';',
      ['let', ['=', v, iterExpr]],
      ['let', ['=', w, v]],
      ['if', ['&&', ['!=', v, NULL], ['!=', ['.', v, '@@iterator'], NULL]],
        ['=', w, ['()', ['.', v, '@@iterator'], null]]],
      ['if', ['&&', ['!=', w, NULL], ['!=', ['.', w, 'next'], NULL]],
        ['{}', [';',
          ['let', ['=', r, [null, undefined]]],
          ['while', [null, true], ['{}', [';',
            ['=', r, ['()', ['.', w, 'next'], null]],
            ['if', ['.', r, 'done'], ['{}', [';', ['break']]]],
            bind,
            ...bodyStmts,
          ]]],
        ]],
        ['for', ['of-idx', decl, w], body]],
    ]]
  }

  return { lowerGenerator, desugarForOfGenerator, desugarForOfProtocol, unwindChain, fuseTerminal, fusedLoop, isTerminal: (h) => TERMINAL_HELPERS.has(h) }
}
