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
 * Out (v1): yield inside arbitrary expressions, yield*, try across yield,
 * for-of/for-in bodies containing yield, labeled break/continue across states.
 *
 * @module jzify/generators
 */

const isYield = (n) => Array.isArray(n) && (n[0] === 'yield' || n[0] === 'yield*')
const hasYield = (n) => Array.isArray(n) && (isYield(n) || n.some(hasYield))

// A break/continue that would bind OUTSIDE this statement (its target loop was
// decomposed into states, so the raw op would bind my dispatch while(1) instead).
// Inner loops re-bind their own jumps; arrows are their own function.
const hasFreeJump = (n, depth = 0) => {
  if (!Array.isArray(n)) return false
  const op = n[0]
  if ((op === 'break' || op === 'continue') && n[1] == null) return depth === 0
  if (op === '=>') return false
  const inner = op === 'while' || op === 'do' || op === 'for' || op === 'for-in' ||
    op === 'for-of' || op === 'switch' ? depth + 1 : depth
  return n.some((c, i) => i > 0 && hasFreeJump(c, inner))
}

const S = { NEXT: '__s', SENT: '__sent' }

export function createGeneratorLowering({ transform, err, generatorNames, genTemp }) {
  // Collect every let/const binding name in the body — generator locals live in
  // the factory scope so they survive across next() resumes. Shadowing across
  // sibling blocks would collide after hoisting — reject (rename support later).
  const collectLocals = (node, out, path) => {
    if (!Array.isArray(node)) return
    if ((node[0] === 'let' || node[0] === 'const')) {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        const name = Array.isArray(d) && d[0] === '=' ? d[1] : d
        if (typeof name !== 'string')
          err('generators v1: destructuring declarations inside a generator body are not supported yet — bind names first')
        if (out.has(name)) err(`generators v1: '${name}' is declared twice in the generator body — hoisted locals must be unique`)
        out.add(name)
      }
    }
    // arrows create their own scope — their decls don't hoist
    if (node[0] === '=>') return
    for (let i = 1; i < node.length; i++) collectLocals(node[i], out, path)
  }

  function lowerGenerator(params, rawBody) {
    const body = Array.isArray(rawBody) && rawBody[0] === ';' ? rawBody.slice(1) : [rawBody]

    const locals = new Set()
    for (const st of body) collectLocals(st, locals)

    // ---- state machine ----
    // states[i] = list of statements; terminators are written explicitly as
    // `__s = k` + return/continue shapes. State 0 is the entry; -1 is done.
    const states = []
    const newState = () => (states.push([]), states.length - 1)
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
      if (op === 'yield*') err('generators v1: yield* is not supported yet — loop over the inner iterator and yield each value')
      if (op === 'yield') return emitYield(cur, st, null)
      if ((op === 'let' || op === 'const') && st.length === 2 && Array.isArray(st[1]) &&
          st[1][0] === '=' && isYield(st[1][2])) {
        if (st[1][2][0] === 'yield*') err('generators v1: yield* is not supported yet')
        return emitYield(cur, st[1][2], st[1][1])
      }
      if (op === '=' && typeof st[1] === 'string' && isYield(st[2])) {
        if (st[2][0] === 'yield*') err('generators v1: yield* is not supported yet')
        return emitYield(cur, st[2], st[1])
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

      // --- compound statements stay atomic only when they carry no yield AND no
      // break/continue that binds a DECOMPOSED loop (the raw op would bind the
      // dispatch while(1) instead — an infinite next()) ---
      if (!hasYield(st) && !(loopCtx && hasFreeJump(st))) {
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
        if (init != null) flattenStmt(init, cur, null) === cur || err('generators v1: yield in a for-init is not supported')
        const test = newState(), bodyS = newState(), stepS = newState(), exit = newState()
        stmtsOf(cur).push(...gotoIR(test))
        stmtsOf(test).push(['if', cond == null ? [null, true] : transform(cond), [';', ...gotoIR(bodyS)], [';', ...gotoIR(exit)]], [';;continue'])
        const bEnd = flattenList(blockStmts(bodyB), bodyS, { cont: stepS, brk: exit })
        if (bEnd != null) stmtsOf(bEnd).push(...gotoIR(stepS))
        if (step != null) stmtsOf(stepS).push(transform(step))
        stmtsOf(stepS).push(...gotoIR(test))
        return exit
      }
      if (op === '{}' || op === ';') return flattenList(blockStmts(st), cur, loopCtx)
      if (op === 'try' || op === 'catch' || op === 'finally')
        err('generators v1: try/catch across a yield is not supported yet')
      err(`generators v1: yield inside \`${op}\` is not supported yet — hoist the yield to statement position`)
    }

    const blockStmts = (b) =>
      b == null ? []
      : Array.isArray(b) && b[0] === '{}' ? blockStmts(b[1])
      : Array.isArray(b) && b[0] === ';' ? b.slice(1)
      : [b]

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

    const nextBody = ['{}', [';',
      ['=', S.SENT, '__in'],
      ['while', [null, true], ['{}', [';', dispatch]]],
    ]]

    const decls = [
      ['let', ['=', S.NEXT, [null, 0]], ['=', S.SENT, [null, undefined]],
        ...[...locals].map(n => ['=', n, [null, undefined]])],
      ['const', ['=', '__next', ['=>', '__in', nextBody]]],
    ]

    const genObj = ['{}', [',',
      [':', 'next', ['=>', '__v', ['()', '__next', '__v']]],
      [':', 'return', ['=>', '__v', ['{}', [';',
        ['=', S.NEXT, [null, -1]],
        ['return', ['{}', [',', [':', 'value', '__v'], [':', 'done', [null, true]]]]]]]]],
    ]]

    return ['=>', params, ['{}', [';', ...decls, ['return', genObj]]]]
  }

  // for-of over a KNOWN generator call → while-next desugar (fusion-friendly:
  // the optimizer sees plain closure calls + a fixed-shape result object).
  function desugarForOfGenerator(decl, iterExpr, body, temp) {
    const it = temp('gi'), r = temp('gr')
    const name = Array.isArray(decl) ? decl[1] : decl
    return ['{}', [';',
      ['const', ['=', it, iterExpr]],
      ['let', ['=', r, ['()', ['.', it, 'next'], null]]],
      ['while', ['!', ['.', r, 'done']], ['{}', [';',
        ['let', ['=', name, ['.', r, 'value']]],
        ...(Array.isArray(body) && body[0] === ';' ? body.slice(1) : [body]),
        ['=', r, ['()', ['.', it, 'next'], null]],
      ]]],
    ]]
  }

  return { lowerGenerator, desugarForOfGenerator }
}
