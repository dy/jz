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

import { FN_BOUNDARY_OPS } from './generators.js'
import { some } from '../src/ast.js'

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
          ['=', it, ['()', ['.', src, '@@iterator'], null]]]],
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
          ['=', it, ['()', ['.', src, '@@iterator'], null]]]],
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
      ['()', '__async_run', ['()', ['function*', null, params, mapAwait(body)], ['...', aa]]]]
  }

  // async function* (params) { body } → (...aa) => __ag_run(TAGGED_MACHINE(...aa))
  function lowerAsyncGen(params, body) {
    const aa = genTemp('ag')
    return ['=>', ['()', ['...', aa]],
      ['()', '__ag_run', ['()', ['function*', null, params, mapAgen(body)], ['...', aa]]]]
  }

  return {
    lowerAsync, lowerAsyncGen,
  }
}
