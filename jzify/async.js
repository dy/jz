/**
 * async/await lowering – the generator machinery driving the plain-jz promise
 * runtime `jz:async` (src/std/async.js). No engine event loop, no stdlib/WAT
 * additions: an async function body lowers to the SAME state machine as
 * function* (an await suspends as a yield does), and the runtime's driver
 * (__async_run) steps it, parking on awaited promises; the runtime is
 * imported implicitly by every module that awaits, one copy per program.
 *
 * v1 surface (precise rejects elsewhere): try/catch/finally across an await
 * (or an async generator's yield) routes the rejection to the catch and every
 * completion through the finally (the machine's try regions, generators.js),
 * which may await itself; an async generator's driver (__ag_run, jz:asyncgen)
 * throws a rejection into the machine where it stands;
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

import { FN_BOUNDARY_OPS, probe, closingLoop } from './generators.js'
import { usesArguments } from './arguments.js'
import { some, ASSIGN_OPS, extractParams, withLoc } from '../src/ast.js'

export function createAsyncLowering({ genTemp }) {

  // The awaits of THIS function body only (nested function forms keep
  // their own await/this rules; a stray await inside a nested sync fn falls
  // through to prepare's clean reject). The boundary set is the layer-wide
  // canonical one (generators.js FN_BOUNDARY_OPS) — one definition for every
  // control-effects walker.
  const FN_OPS = FN_BOUNDARY_OPS

  // `for await (decl of src)` → protocol loop in terms of PLAIN await: unwrap
  // @@asyncIterator (else @@iterator), drive next() through await; a sync
  // source's values are awaited in turn, as CreateAsyncFromSyncIterator's are
  // (an async iterator's are not, their settling is the next() promise's).
  // Non-protocol sources fall to an indexed loop with per-element await. The
  // result is machine-lowerable by the same v1 yield surface as any while
  // loop. A body leaving early awaits the iterator's return() (AsyncIteratorClose).
  const NULL = [null, null]
  function desugarForAwait(head, body) {
    const [, decl, srcExpr] = head
    const src = genTemp('fa'), it = genTemp('fi'), r = genTemp('fr'), ix = genTemp('fx'), sync = genTemp('fs')
    const isDecl = Array.isArray(decl) && (decl[0] === 'let' || decl[0] === 'const')
    const name = isDecl ? decl[1] : decl
    // the loop binding declares ONCE before the protocol fork (both arms would
    // otherwise re-declare it — the machine hoists locals and rejects dupes)
    const bodyStmts = Array.isArray(body) && body[0] === ';' ? body.slice(1) : [body]
    const open = genTemp('fo'), value = genTemp('fv'), result = genTemp('fq'), close = ['.', it, 'return']
    const notObject = ['||', ['==', result, NULL], ['&&', ['!==', ['typeof', result], [null, 'object']], ['!==', ['typeof', result], [null, 'function']]]]
    // Pull at the top: a `continue` in the body must advance the iterator.
    const protocol = ['{}', [';',
      ['let', ['=', open, [null, false]], ['=', value, [null, undefined]], ['=', result, [null, undefined]]],
      closingLoop(['while', [null, true], ['{}', [';',
        ['=', open, [null, false]],
        ['=', r, ['await', ['()', ['.', it, 'next'], null]]],
        ['if', ['.', r, 'done'], ['{}', [';', ['break']]]],
        ['=', value, ['.', r, 'value']],
        ['=', open, [null, true]],
        // a sync source's rejected value closes it
        ['if', sync, ['=', value, ['await', value]]],
        ['=', name, value],
        ...bodyStmts,
      ]]], open, [
        ['if', ['!=', close, NULL], ['{}', [';',
          ['=', result, ['await', ['()', close.slice(), null]]],
          ['if', notObject, ['throw', ['new', ['()', 'TypeError', [null, 'iterator return result is not an object']]]]]]]],
      ], [
        ['try', ['{}', [';', ['if', ['!=', close.slice(), NULL], ['{}', [';', ['await', ['()', close.slice(), null]]]]]]],
          ['catch', genTemp('fe'), ['{}', null]]],
      ], genTemp('ff'), body)]]
    return ['{}', [';',
      ...(isDecl ? [['let', ['=', name, [null, undefined]]]] : []),
      ['let', ['=', src, srcExpr]],
      ['let', ['=', it, src], ['=', sync, [null, false]]],
      ['if', ['&&', ['!=', src, NULL], ['!=', ['.', src, '@@asyncIterator'], NULL]],
        ['=', it, ['()', ['.', src, '@@asyncIterator'], null]],
        ['if', ['&&', ['!=', src, NULL], ['!=', ['.', src, '@@iterator'], NULL]],
          ['{}', [';', ['=', it, ['()', probe(src, '@@iterator'), null]], ['=', sync, [null, true]]]]]],
      ['if', ['&&', ['!=', it, NULL], ['!=', ['.', it, 'next'], NULL]],
        ['{}', [';',
          ['let', ['=', r, [null, undefined]]],
          protocol,
        ]],
        ['{}', [';',
          ['let', ['=', ix, [null, 0]]],
          ['while', ['<', ix, ['.', it, 'length']], ['{}', [';',
            ['=', name, ['await', ['[]', it, ix]]],
            ['=', ix, ['+', ix, [null, 1]]],
            ...bodyStmts,
          ]]],
        ]]],
    ]]
  }

  // `for await` → plain awaits. An await stays an await: the machine suspends
  // at it as at a yield and types the value it resumes with (generators.js).
  function mapAwait(node) {
    if (!Array.isArray(node)) return node
    if (FN_OPS.has(node[0])) return node
    if (node[0] === 'for await' && Array.isArray(node[1]) && node[1][0] === 'of')
      return mapAwait(desugarForAwait(node[1], node[2]))
    return withLoc(node.map((n, i) => i === 0 ? n : mapAwait(n)), node)
  }
  function fnBoundary(n) { return FN_OPS.has(n[0]) }
  function isAwait(n) { return n[0] === 'await' || n[0] === 'for await' }
  function refsAwait(node) { return some(node, isAwait, { boundary: fnBoundary }) }

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
  // What an expression or a statement lowers to stands where it stood.
  function hoistExpr(e) {
    const h = hoistExprNode(e)
    for (const s of h.pre) withLoc(s, e)
    withLoc(h.expr, e)
    return h
  }
  function hoistExprNode(e) {
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
    const out = hoistStmtNode(st)
    for (const s of out) withLoc(s, st)
    return out
  }
  function hoistStmtNode(st) {
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

  // An async generator's `return E` awaits E (ECMA-262 ReturnStatement), inside
  // whatever try it stands in; a bare `return` does not.
  function awaitReturns(node) {
    if (!Array.isArray(node) || FN_OPS.has(node[0])) return node
    if (node[0] === 'return' && node[1] !== undefined) return withLoc(['return', ['await', node[1]]], node)
    return withLoc(node.map((n, i) => i === 0 ? n : awaitReturns(n)), node)
  }

  // async (a, b) => body / async function (a, b) { body } →
  //   (a, b) => __async_run(MACHINE_FACTORY(a, b))
  // The factory is the standard generator lowering of the body.
  function lowerAsync(params, body) {
    // Source-level desugar: (a, b) => __async_run((function* (a, b) { mappedBody })(a, b))
    // The function* expression rides the standard generator lowering; the body
    // runs synchronously to the first await (spec), then parks on the promise.
    // The wrapper passes each argument on as it took it, a pattern's or a
    // default's in a name of its own, a rest by spreading it: the machine's
    // parameters are then its callers' arguments, as a plain function's are. A
    // function reading `arguments` takes them all, `(...aa)`, keeping their count.
    const machine = ['function*', null, params, mapAwait(hoistAwaits(body))], list = extractParams(params)
    const own = usesArguments(body) || usesArguments(params) ? [['...', genTemp('aa')]]
      : list.map(p => typeof p === 'string' ? p : Array.isArray(p) && p[0] === '...' ? ['...', genTemp('aa')] : genTemp('ap'))
    const seq = (l) => l.length === 0 ? null : l.length === 1 ? l[0] : [',', ...l]
    const run = ['()', '__async_run', ['()', machine, seq(own.map(p => Array.isArray(p) ? p.slice() : p))]]
    if (list.every(p => typeof p === 'string')) return ['=>', ['()', seq(own)], run]
    // Defaults and destructuring run in the factory, before the driver can
    // catch body exceptions. An async call rejects for either kind of failure.
    const error = genTemp('ae')
    return ['=>', ['()', seq(own)], ['{}', [';',
      ['try', ['{}', ['return', run]], ['catch', error, ['{}', ['return', ['()', '__p_reject', error]]]]]]]]
  }

  // async function* (params) { body } → (...aa) => __ag_run(TAGGED_MACHINE(...aa)):
  // the body lowers as an async function's does, its for await desugared; the
  // machine (generators.js, its async mode) suspends at awaits and yields
  // alike, tagging which for the driver, and lowers yield*.
  function lowerAsyncGen(params, body) {
    const aa = genTemp('ag')
    return ['=>', ['()', ['...', aa]],
      ['()', '__ag_run', ['()', ['function*', null, params, mapAwait(hoistAwaits(awaitReturns(body))), 'async'], ['...', aa]]]]
  }

  return {
    lowerAsync, lowerAsyncGen,
  }
}
