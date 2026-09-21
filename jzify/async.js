/**
 * async/await lowering – the generator machinery driving the plain-jz promise
 * runtime `jz:async` (src/std/async.js). No engine event loop, no stdlib/WAT
 * additions: an async function body lowers to the SAME state machine as
 * function* (await ≡ yield), and the runtime's driver (__async_run) steps
 * it, parking on awaited promises; the runtime is imported implicitly by
 * every module that awaits, one copy per program.
 *
 * v1 surface (precise rejects elsewhere): try/catch across an await routes
 * the rejection to the catch (the machine's try regions, generators.js); a
 * `finally` that awaits stays out;
 * `new Promise(executor)`, `Promise.resolve/reject/all/race/allSettled/any/
 * try/withResolvers`, `.then/.catch/.finally` chains all work (canonicalized
 * to the injected helpers). AggregateError surfaces as a fixed-shape
 * `{ name, message, errors }` value (errors are untagged in jz).
 * Divergences (documented): unhandled rejections don't report; job ordering
 * is per-drain-cycle (boundary/timer granularity), not per-continuation.
 *
 * Pay-per-use: nothing is imported unless the program contains async
 * source; sync programs compile byte-identically.
 *
 * @module jzify/async
 */

import { FN_BOUNDARY_OPS, probe } from './generators.js'
import { some, ASSIGN_OPS } from '../src/ast.js'

export function createAsyncLowering({ genTemp, err }) {

  // await → yield inside THIS function body only (nested function forms keep
  // their own await/this rules; a stray await inside a nested sync fn falls
  // through to prepare's clean reject). The boundary set is the layer-wide
  // canonical one (generators.js FN_BOUNDARY_OPS) — one definition for every
  // control-effects walker.
  const FN_OPS = FN_BOUNDARY_OPS

  // `for await (decl of src)` → protocol loop in terms of PLAIN await: unwrap
  // @@asyncIterator (else @@iterator), drive next() through await, and await
  // each element (sync-source values may be promises; awaiting an async
  // iterator's already-resolved value is a harmless pass-through). Non-protocol
  // sources fall to an indexed loop with per-element await. The result is
  // machine-lowerable by the same v1 yield surface as any while loop.
  const NULL = [null, null]
  function desugarForAwait(head, body) {
    const [, decl, srcExpr] = head
    const src = genTemp('fa'), it = genTemp('fi'), r = genTemp('fr'), ix = genTemp('fx')
    const isDecl = Array.isArray(decl) && (decl[0] === 'let' || decl[0] === 'const')
    const name = isDecl ? decl[1] : decl
    // the loop binding declares ONCE before the protocol fork (both arms would
    // otherwise re-declare it — the machine hoists locals and rejects dupes)
    const bind = (valExpr) => ['=', name, ['await', valExpr]]
    const bodyStmts = Array.isArray(body) && body[0] === ';' ? body.slice(1) : [body]
    return ['{}', [';',
      ...(isDecl ? [['let', ['=', name, [null, undefined]]]] : []),
      ['let', ['=', src, srcExpr]],
      ['let', ['=', it, src]],
      ['if', ['&&', ['!=', src, NULL], ['!=', ['.', src, '@@asyncIterator'], NULL]],
        ['=', it, ['()', ['.', src, '@@asyncIterator'], null]],
        ['if', ['&&', ['!=', src, NULL], ['!=', ['.', src, '@@iterator'], NULL]],
          ['=', it, ['()', probe(src, '@@iterator'), null]]]],
      ['if', ['&&', ['!=', it, NULL], ['!=', ['.', it, 'next'], NULL]],
        ['{}', [';',
          ['let', ['=', r, ['await', ['()', ['.', it, 'next'], null]]]],
          ['while', ['!', ['.', r, 'done']], ['{}', [';',
            bind(['.', r, 'value']),
            ...bodyStmts,
            ['=', r, ['await', ['()', ['.', it, 'next'], null]]],
          ]]],
        ]],
        ['{}', [';',
          ['let', ['=', ix, [null, 0]]],
          ['while', ['<', ix, ['.', it, 'length']], ['{}', [';',
            bind(['[]', it, ix]),
            ['=', ix, ['+', ix, [null, 1]]],
            ...bodyStmts,
          ]]],
        ]]],
    ]]
  }

  function mapAwait(node) {
    if (!Array.isArray(node)) return node
    if (FN_OPS.has(node[0])) return node
    if (node[0] === 'for await' && Array.isArray(node[1]) && node[1][0] === 'of')
      return mapAwait(desugarForAwait(node[1], node[2]))
    if (node[0] === 'await') return ['yield', mapAwait(node[1])]
    return node.map((n, i) => i === 0 ? n : mapAwait(n))
  }
  function fnBoundary(n) { return FN_OPS.has(n[0]) }
  function isAwait(n) { return n[0] === 'await' || n[0] === 'for await' }
  function isSuspend(n) { return isAwait(n) || n[0] === 'yield' || n[0] === 'yield*' }
  function refsAwait(node) { return some(node, isAwait, { boundary: fnBoundary }) }
  function refsSuspend(node) { return some(node, isSuspend, { boundary: fnBoundary }) }

  // ---- await in expression position → statement position ----
  // The machine suspends at statements only (generators.js: a yield as a
  // statement, or the right side of `let x = yield E` / `x = yield E` /
  // `x.f = yield E`). Every other await is hoisted: the awaited value lands
  // in a temp declared before the statement, and whatever the statement
  // evaluates before that await lands in temps first, so the source's order
  // holds (a callee and an assignment target stay in place: a temp would
  // turn a method call into a closure call, or store into a copy). A
  // short-circuit or conditional whose later arm awaits becomes an if
  // statement assigning a temp; a loop whose test awaits tests at the top of
  // each iteration of `while (true)`.
  const UNDEF = [null, undefined]
  const isAwaitOf = (e) => Array.isArray(e) && e[0] === 'await'
  const isSimple = (e) => !Array.isArray(e) || e[0] == null
  const stmtsOf = (b) => b == null ? [] : Array.isArray(b) && b[0] === ';' ? b.slice(1) : Array.isArray(b) && b[0] === '{}' ? stmtsOf(b[1]) : [b]
  const seq = (list) => list.length === 1 ? list[0] : [';', ...list]
  const block = (list) => ['{}', seq(list)]
  const hoistList = (b) => stmtsOf(b).flatMap(hoistStmt)
  // A body keeps its spelling: a block stays a block, a lone statement stays bare.
  const blockOf = (b) => { if (b == null) return b; const list = hoistList(b); return list.length === 1 && !(Array.isArray(b) && b[0] === '{}') ? list[0] : block(list) }
  const hasContinue = (b) => some(b, n => n[0] === 'continue', { boundary: fnBoundary })
  const keepsPlace = (op, i) => i === 1 && (op === '()' || op === '?.()' || ASSIGN_OPS.has(op) || op === '++' || op === '--')
  function hoistExpr(e) {
    if (!Array.isArray(e) || FN_OPS.has(e[0]) || !refsAwait(e)) return { pre: [], expr: e }
    const op = e[0]
    if (op === 'await') {
      const inner = hoistExpr(e[1]), t = genTemp('aw')
      return { pre: [...inner.pre, ['let', ['=', t, ['await', inner.expr]]]], expr: t }
    }
    if ((op === '&&' || op === '||' || op === '??') && refsAwait(e[2])) {
      const l = hoistExpr(e[1]), r = hoistExpr(e[2]), t = genTemp('aw')
      const test = op === '&&' ? t : op === '||' ? ['!', t] : ['==', t, NULL]
      return { pre: [...l.pre, ['let', ['=', t, l.expr]], ['if', test, block([...r.pre, ['=', t, r.expr]])]], expr: t }
    }
    if (op === '?' && (refsAwait(e[2]) || refsAwait(e[3]))) {
      const c = hoistExpr(e[1]), a = hoistExpr(e[2]), b = hoistExpr(e[3]), t = genTemp('aw')
      return { pre: [...c.pre, ['let', ['=', t, UNDEF]], ['if', c.expr, block([...a.pre, ['=', t, a.expr]]), block([...b.pre, ['=', t, b.expr]])]], expr: t }
    }
    // Children evaluate left to right: those before the last awaiting child
    // land in temps, the rest stay in place.
    const out = e.slice(), pre = []
    let last = 1
    for (let i = 1; i < e.length; i++) if (refsAwait(e[i])) last = i
    // A property or a spread is not a value: its value settles instead.
    const settleVal = (x) => { if (isSimple(x)) return x; const t = genTemp('aw'); pre.push(['let', ['=', t, x]]); return t }
    const settle = (i, x) => isSimple(x) || keepsPlace(op, i) ? x
      : x[0] === ':' ? [':', x[1], settleVal(x[2])]
      : x[0] === '...' ? ['...', settleVal(x[1])]
      : settleVal(x)
    for (let i = 1; i < e.length; i++) {
      const child = e[i]
      if (i > last) continue
      const h = refsAwait(child) ? hoistExpr(child) : { pre: [], expr: child }
      pre.push(...h.pre)
      out[i] = i < last ? settle(i, h.expr) : h.expr
    }
    return { pre, expr: out }
  }
  function hoistStmt(st) {
    if (!Array.isArray(st) || !refsAwait(st)) return [st]
    const op = st[0]
    if (op === ';') return st.slice(1).flatMap(hoistStmt)
    if (op === '{}') return [block(hoistList(st[1]))]
    if (op === 'await') { const inner = hoistExpr(st[1]); return [...inner.pre, ['await', inner.expr]] }
    if (op === 'let' || op === 'const' || op === 'var') {
      const out = []
      for (const d of st.slice(1)) {
        if (!Array.isArray(d) || d[0] !== '=' || !refsAwait(d[2])) { out.push([op, d]); continue }
        if (typeof d[1] === 'string' && isAwaitOf(d[2])) { const inner = hoistExpr(d[2][1]); out.push(...inner.pre, [op, ['=', d[1], ['await', inner.expr]]]); continue }
        const h = hoistExpr(d[2]); out.push(...h.pre, [op, ['=', d[1], h.expr]])
      }
      return out
    }
    if (ASSIGN_OPS.has(op)) {
      const target = st[1], plain = typeof target === 'string' || (Array.isArray(target) && target[0] === '.' && typeof target[1] === 'string')
      if (op === '=' && plain && isAwaitOf(st[2])) { const inner = hoistExpr(st[2][1]); return [...inner.pre, ['=', target, ['await', inner.expr]]] }
      const h = hoistExpr(st[2])
      return [...h.pre, [op, target, h.expr]]
    }
    if (op === 'return' || op === 'throw') { const h = hoistExpr(st[1]); return [...h.pre, [op, h.expr]] }
    if (op === 'if') { const c = hoistExpr(st[1]); return [...c.pre, ['if', c.expr, blockOf(st[2]), ...(st.length > 3 ? [blockOf(st[3])] : [])]] }
    if (op === 'while') {
      if (!refsAwait(st[1])) return [['while', st[1], blockOf(st[2])]]
      const c = hoistExpr(st[1])
      return [['while', [null, true], block([...c.pre, ['if', ['!', c.expr], ['break']], ...hoistList(st[2])])]]
    }
    if (op === 'do') {
      if (!refsAwait(st[2])) return [['do', blockOf(st[1]), st[2]]]
      if (hasContinue(st[1])) return [st]
      const c = hoistExpr(st[2])
      return [['while', [null, true], block([...hoistList(st[1]), ...c.pre, ['if', ['!', c.expr], ['break']]])]]
    }
    if (op === 'for' && Array.isArray(st[1])) {
      const head = st[1]
      if (head[0] === 'of' || head[0] === 'in') { const src = hoistExpr(head[2]); return [...src.pre, ['for', [head[0], head[1], src.expr], blockOf(st[2])]] }
      if (head[0] === ';') {
        const [, init, cond, step] = head
        const initStmts = init == null ? [] : hoistStmt(init)
        if (!refsAwait(cond) && !refsAwait(step)) {
          const inline = initStmts.length === 1 && !refsAwait(init)
          return [...(inline ? [] : initStmts), ['for', [';', inline ? init : null, cond, step], blockOf(st[2])]]
        }
        if (hasContinue(st[2])) return [st]
        const c = cond == null ? { pre: [], expr: [null, true] } : hoistExpr(cond), s = step == null ? null : hoistExpr(step)
        return [...initStmts, ['while', [null, true], block([...c.pre, ['if', ['!', c.expr], ['break']], ...hoistList(st[2]), ...(s ? [...s.pre, s.expr] : [])])]]
      }
    }
    if (op === 'for await' && Array.isArray(st[1]) && st[1][0] === 'of') { const src = hoistExpr(st[1][2]); return [...src.pre, ['for await', ['of', st[1][1], src.expr], blockOf(st[2])]] }
    if (op === 'try') return [['try', blockOf(st[1]), ...st.slice(2).map(c => c[0] === 'catch' ? ['catch', c[1], blockOf(c[2])] : c[0] === 'finally' ? ['finally', blockOf(c[1])] : c)]]
    if (op === 'switch') { const d = hoistExpr(st[1]); return [...d.pre, ['switch', d.expr, ...st.slice(2).map(c => c[0] === 'case' ? ['case', c[1], seq(hoistList(c[2]))] : c[0] === 'default' ? ['default', seq(hoistList(c[1]))] : c)]] }
    if (op === ':' && typeof st[1] === 'string') return [[':', st[1], blockOf(st[2])]]
    const h = hoistExpr(st)
    return [...h.pre, ...(typeof h.expr === 'string' ? [] : [h.expr])]
  }
  const hoistAwaits = (body) => Array.isArray(body) && body[0] === '{}' ? block(hoistList(body)) : seq(hoistList(body))

  // async generator body → tagged-yield machine body: `await E` suspends as
  // { a: 1, v: E } (driver resumes with the resolved value), `yield E` as
  // { a: 0, v: E } (driver resolves next() and resumes with the sent value).
  // `yield*`/for-await desugar into plain await/yield loops first and recurse.
  const tag = (a, v) => ['yield', ['{}', [',', [':', 'a', [null, a]], [':', 'v', v]]]]
  function mapAgen(node) {
    if (!Array.isArray(node)) return node
    if (FN_OPS.has(node[0])) return node
    if (node[0] === 'for await' && Array.isArray(node[1]) && node[1][0] === 'of')
      return mapAgen(desugarForAwait(node[1], node[2]))
    if (node[0] === 'yield*') return mapAgen(desugarYieldStarAsync(node[1], null))
    if (node[0] === 'await') return tag(1, mapAgen(node[1]))
    if (node[0] === 'yield') return node[1] === undefined ? tag(0, [null, undefined]) : tag(0, mapAgen(node[1]))
    if (node[0] === 'try' && refsSuspend(node))
      err('try/catch across `await`/`yield` is outside the v1 async-generator surface — let the rejection reject, or move the try into a sync helper')
    return node.map((n, i) => i === 0 ? n : mapAgen(n))
  }

  // `yield* E` inside an async generator: delegate through await'd next()
  // (async or sync sources both work — __await passes plain values through).
  function desugarYieldStarAsync(expr) {
    const src = genTemp('ya'), it = genTemp('yb'), r = genTemp('yc'), sent = genTemp('yd'), ix = genTemp('ye')
    return ['{}', [';',
      ['let', ['=', src, expr]],
      ['let', ['=', it, src]],
      ['if', ['&&', ['!=', src, NULL], ['!=', ['.', src, '@@asyncIterator'], NULL]],
        ['=', it, ['()', ['.', src, '@@asyncIterator'], null]],
        ['if', ['&&', ['!=', src, NULL], ['!=', ['.', src, '@@iterator'], NULL]],
          ['=', it, ['()', probe(src, '@@iterator'), null]]]],
      ['if', ['&&', ['!=', it, NULL], ['!=', ['.', it, 'next'], NULL]],
        ['{}', [';',
          ['let', ['=', r, ['await', ['()', ['.', it, 'next'], null]]]],
          ['while', ['!', ['.', r, 'done']], ['{}', [';',
            ['let', ['=', sent, ['yield', ['.', r, 'value']]]],
            ['=', r, ['await', ['()', ['.', it, 'next'], sent]]],
          ]]],
        ]],
        // indexed fallback (arrays/strings): each element rides the same
        // tagged yield, so a rejected element rejects next() and closes.
        ['{}', [';',
          ['let', ['=', ix, [null, 0]]],
          ['while', ['<', ix, ['.', it, 'length']], ['{}', [';',
            ['yield', ['[]', it, ix]],
            ['=', ix, ['+', ix, [null, 1]]],
          ]]],
        ]]],
    ]]
  }

  // async (params) => body / async function (params) { body } →
  //   (...aa) => __async_run(MACHINE_FACTORY(...aa))
  // The factory is the standard generator lowering of the await-mapped body.
  function lowerAsync(params, body) {
    // Source-level desugar: (...aa) => __async_run((function* (params) { mappedBody })(...aa))
    // The function* expression rides the standard generator lowering; the body
    // runs synchronously to the first await (spec), then parks on the promise.
    const aa = genTemp('aa')
    return ['=>', ['()', ['...', aa]],
      ['()', '__async_run', ['()', ['function*', null, params, mapAwait(hoistAwaits(body))], ['...', aa]]]]
  }

  // async function* (params) { body } → (...aa) => __ag_run(TAGGED_MACHINE(...aa))
  function lowerAsyncGen(params, body) {
    const aa = genTemp('ag')
    return ['=>', ['()', ['...', aa]],
      ['()', '__ag_run', ['()', ['function*', null, params, mapAgen(hoistAwaits(body))], ['...', aa]]]]
  }

  return {
    lowerAsync, lowerAsyncGen,
  }
}
