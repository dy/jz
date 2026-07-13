/**
 * async/await lowering — the generator machinery driving a plain-jz promise
 * runtime. No engine event loop, no stdlib/WAT additions: an async function
 * body lowers to the SAME state machine as function* (await ≡ yield), and a
 * driver (__async_run) steps it, parking on awaited promises. Promises are
 * fixed-shape objects; `then` callbacks queue as closures in a module-level
 * microtask array drained at host boundaries (export return, timer tick) —
 * the host wrapper (interop.js) calls the exported __mt_drain and settles
 * host Promises for async exports.
 *
 * v1 surface (precise rejects elsewhere): no try/catch across an await (the
 * machine constraint — an awaited rejection rejects the async function);
 * `new Promise(executor)`, `Promise.resolve/reject/all/race/allSettled/any/
 * try/withResolvers`, `.then/.catch/.finally` chains all work (canonicalized
 * to the injected helpers). AggregateError surfaces as a fixed-shape
 * `{ name, message, errors }` value (errors are untagged in jz).
 * Divergences (documented): unhandled rejections don't report; job ordering
 * is per-drain-cycle (boundary/timer granularity), not per-continuation.
 *
 * Pay-per-use: nothing below is injected unless the program contains async
 * source; sync programs compile byte-identically.
 *
 * @module jzify/async
 */

// The runtime, as readable jz source — parsed + spliced ahead of user code
// when async is present. Exported entries are the host-boundary contract.
export const ASYNC_RUNTIME = `
let __mt = []
let __sq = []
let __drain = () => {
  while (__mt.length > 0 || __sq.length > 0) {
    while (__mt.length > 0) { let cb = __mt.shift(); cb() }
    if (__sq.length > 0) {
      let p = __sq.shift()
      let cbs = p.cbs
      p.cbs = []
      let st = p.st
      let v = p.val
      for (let i = 0; i < cbs.length; i++) { let cb = cbs[i]; cb(st, v) }
    }
  }
}
let __state = (p) => p != null && typeof p === 'object' && p.__p === 1 ? p.st : -1
let __value = (p) => p.val
let __p_new = () => {
  let p = { __p: 1, st: 0, rs: 0, val: undefined, cbs: [], then: undefined, catch: undefined, finally: undefined }
  p.then = (ok, err) => {
    let q = __p_new()
    __p_sub(p, (st, v) => {
      // non-callable handlers are ignored (spec: fulfillment/rejection pass through)
      if (st === 1) { if (ok == null || typeof ok !== 'function') { __p_settle(q, 1, v) } else { try { __p_settle(q, 1, ok(v)) } catch (e) { __p_settle(q, 2, e) } } }
      else { if (err == null || typeof err !== 'function') { __p_settle(q, 2, v) } else { try { __p_settle(q, 1, err(v)) } catch (e2) { __p_settle(q, 2, e2) } } }
    })
    return q
  }
  p.catch = (err) => p.then(undefined, err)
  p.finally = (fn) => p.then((v) => { fn(); return v }, (e) => { fn(); throw e })
  return p
}
let __p_sub = (p, h) => {
  if (p.st > 0) { let st = p.st, v = p.val; __mt.push(() => h(st, v)) }
  else p.cbs.push(h)
}
let __p_fin = (p, st, v) => {
  if (p.st > 0) return
  p.st = st
  p.val = v
  if (p.cbs.length > 0) __sq.push(p)
}
let __p_settle = (p, st, v) => {
  if (p.st > 0 || p.rs === 1) return
  if (st === 1 && v != null && typeof v === 'object') {
    if (v.__p === 1) { p.rs = 1; __p_sub(v, (st2, v2) => __p_fin(p, st2, v2)); return }
    // plain-object thenable (spec: any object with callable then) — adopt in a
    // job; the resolve/reject pair shares one already-called latch, and a
    // then() throw after that latch is ignored (25.4.1.3.2).
    if (typeof v.then === 'function') {
      p.rs = 1
      __mt.push(() => {
        let done = 0
        try {
          v.then(
            (x) => { if (done) return; done = 1; p.rs = 0; __p_settle(p, 1, x) },
            (e) => { if (done) return; done = 1; __p_fin(p, 2, e) })
        } catch (e2) { if (done === 0) __p_fin(p, 2, e2) }
      })
      return
    }
  }
  __p_fin(p, st, v)
}
let __await = (v, ok, err) => {
  if (v != null && typeof v === 'object' && (v.__p === 1 || typeof v.then === 'function'))
    __p_sub(__p_resolve(v), (st, x) => { if (st === 1) ok(x); else err(x) })
  else { __mt.push(() => ok(v)) }
}
let __async_run = (it) => {
  let p = __p_new()
  let onstep = (r) => {
    if (r.done) __p_settle(p, 1, r.value)
    else __await(r.value,
      (v) => { let r2; try { r2 = it.next(v) } catch (e) { __p_settle(p, 2, e); return } onstep(r2) },
      (e) => { it.return(undefined); __p_settle(p, 2, e) })
  }
  let r0
  try { r0 = it.next() } catch (e) { __p_settle(p, 2, e); return p }
  onstep(r0)
  return p
}
let __p_exec = (fn) => {
  if (fn == null || typeof fn !== 'function') throw 'Promise executor is not callable'
  let p = __p_new()
  let done = 0
  try {
    fn((v) => { if (done) return; done = 1; __p_settle(p, 1, v) },
       (e) => { if (done) return; done = 1; __p_settle(p, 2, e) })
  } catch (e2) { if (done === 0) __p_settle(p, 2, e2) }
  return p
}
let __p_resolve = (v) => {
  if (v != null && typeof v === 'object' && v.__p === 1) return v
  let p = __p_new(); __p_settle(p, 1, v); return p
}
let __p_reject = (e) => { let p = __p_new(); __p_settle(p, 2, e); return p }
// GetIterator for the combinators: arrays pass through, iterator-protocol
// values drain, anything else (non-iterable input, or an @@iterator that is
// non-callable / returns a non-object) yields null → the combinator REJECTS
// with a TypeError value instead of resolving garbage.
let __p_list = (v) => {
  if (v == null) return null
  if (typeof v === 'string') return v.split('')
  if (typeof v !== 'object') return null
  let w = v
  if (w['@@iterator'] != null) {
    if (typeof w['@@iterator'] !== 'function') return null
    w = w['@@iterator']()
  }
  if (w != null && typeof w === 'object' && typeof w.next === 'function') {
    let a = [], r = w.next()
    while (!r.done) { a.push(r.value); r = w.next() }
    return a
  }
  if (w != null && typeof w === 'object' && w.length != null) return w
  return null
}
let __p_all = (arr) => {
  let p = __p_new()
  let a = __p_list(arr)
  if (a == null) { __p_settle(p, 2, 'TypeError: Promise.all argument is not iterable'); return p }
  let n = a.length, out = [], left = n
  if (n === 0) { __p_settle(p, 1, out); return p }
  for (let i = 0; i < n; i++) {
    let k = i
    __await(a[k], (v) => { out[k] = v; left--; if (left === 0) __p_settle(p, 1, out) }, (e) => __p_settle(p, 2, e))
  }
  return p
}
let __p_race = (arr) => {
  let p = __p_new()
  let a = __p_list(arr)
  if (a == null) { __p_settle(p, 2, 'TypeError: Promise.race argument is not iterable'); return p }
  for (let i = 0; i < a.length; i++) __await(a[i], (v) => __p_settle(p, 1, v), (e) => __p_settle(p, 2, e))
  return p
}
let __p_allSettled = (arr) => {
  let p = __p_new()
  let a = __p_list(arr)
  if (a == null) { __p_settle(p, 2, 'TypeError: Promise.allSettled argument is not iterable'); return p }
  let n = a.length, out = [], left = n
  if (n === 0) { __p_settle(p, 1, out); return p }
  for (let i = 0; i < n; i++) {
    let k = i
    __await(a[k],
      (v) => { out[k] = { status: 'fulfilled', value: v, reason: undefined }; left--; if (left === 0) __p_settle(p, 1, out) },
      (e) => { out[k] = { status: 'rejected', value: undefined, reason: e }; left--; if (left === 0) __p_settle(p, 1, out) })
  }
  return p
}
let __p_any = (arr) => {
  let p = __p_new()
  let a = __p_list(arr)
  if (a == null) { __p_settle(p, 2, 'TypeError: Promise.any argument is not iterable'); return p }
  let n = a.length, errs = [], left = n
  if (n === 0) { __p_settle(p, 2, { name: 'AggregateError', message: 'All promises were rejected', errors: errs }); return p }
  for (let i = 0; i < n; i++) {
    let k = i
    __await(a[k], (v) => __p_settle(p, 1, v),
      (e) => { errs[k] = e; left--; if (left === 0) __p_settle(p, 2, { name: 'AggregateError', message: 'All promises were rejected', errors: errs }) })
  }
  return p
}
let __p_try = (fn, ...aa) => {
  let p = __p_new()
  try { __p_settle(p, 1, fn(...aa)) } catch (e) { __p_settle(p, 2, e) }
  return p
}
let __p_withResolvers = () => {
  let p = __p_new()
  return { promise: p, resolve: (v) => __p_settle(p, 1, v), reject: (e) => __p_settle(p, 2, e) }
}
export let __mt_drain = () => __drain()
export let __p_state = (p) => __state(p)
export let __p_value = (p) => __value(p)
export let __p_make = () => __p_new()
export let __p_finish = (p, st, v) => __p_settle(p, st, v)
`

// Async generators — the SAME sync machine, with TAGGED yields: the lowered
// body yields { a: 1, v } where the source awaited and { a: 0, v } where it
// yielded, and __ag_run drives the machine, parking on awaited promises and
// resolving each next() with a { value, done } record. next() calls serialize
// through a per-instance queue (spec: requests queue while a step is inflight).
// Injected only when a program contains async generators / for-await.
export const ASYNC_GEN_RUNTIME = `
let __ag_fin = (st, p, ok, v) => { __p_settle(p, ok, v); st.b = 0; __ag_kick(st) }
let __ag_step = (st, g, p, r) => {
  if (r.done) { __ag_fin(st, p, 1, { value: r.value, done: true }); return }
  let t = r.value
  // AsyncGeneratorYield AWAITS the yielded value first — yielding a rejected
  // promise rejects the pending next() and closes the machine.
  if (t.a === 0) {
    __await(t.v,
      (v) => __ag_fin(st, p, 1, { value: v, done: false }),
      (e) => { g.return(undefined); __ag_fin(st, p, 2, e) })
    return
  }
  __await(t.v,
    (v) => {
      let r2
      try { r2 = g.next(v) } catch (e) { __ag_fin(st, p, 2, e); return }
      __ag_step(st, g, p, r2)
    },
    (e) => { g.return(undefined); __ag_fin(st, p, 2, e) })
}
let __ag_kick = (st) => {
  if (st.b === 1) return
  if (st.q.length === 0) return
  st.b = 1
  let job = st.q.shift()
  let r
  try { r = job.g.next(job.v) } catch (e) { st.b = 0; __p_settle(job.p, 2, e); __ag_kick(st); return }
  __ag_step(st, job.g, job.p, r)
}
let __ag_run = (g) => {
  let st = { b: 0, q: [] }
  let ag = { next: undefined, return: undefined, throw: undefined, '@@asyncIterator': undefined }
  ag.next = (v) => { let p = __p_new(); st.q.push({ g: g, p: p, v: v }); __ag_kick(st); return p }
  ag.return = (v) => { let p = __p_new(); let r = g.return(v); __p_settle(p, 1, { value: r.value, done: true }); return p }
  ag.throw = (e) => { let p = __p_new(); try { g.throw(e) } catch (x) { __p_settle(p, 2, x) } return p }
  ag[Symbol.asyncIterator] = () => ag
  return ag
}
`

export function createAsyncLowering({ genTemp, err }) {
  let used = false
  let agUsed = false

  // await → yield inside THIS function body only (nested function forms keep
  // their own await/this rules; a stray await inside a nested sync fn falls
  // through to prepare's clean reject).
  const FN_OPS = new Set(['=>', 'function', 'function*', 'class', 'async'])

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
    if (node[0] === 'try' && refsAwait(node))
      err('try/catch across `await` is outside the v1 async surface — let the rejection reject the async function, or move the try into a sync helper')
    return node.map((n, i) => i === 0 ? n : mapAwait(n))
  }
  function refsAwait(node) {
    if (!Array.isArray(node)) return false
    if (FN_OPS.has(node[0])) return false
    if (node[0] === 'await' || node[0] === 'for await') return true
    return node.some(refsAwait)
  }
  function refsSuspend(node) {
    if (!Array.isArray(node)) return false
    if (FN_OPS.has(node[0])) return false
    if (node[0] === 'await' || node[0] === 'for await' || node[0] === 'yield' || node[0] === 'yield*') return true
    return node.some(refsSuspend)
  }

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
    used = true
    // Source-level desugar: (...aa) => __async_run((function* (params) { mappedBody })(...aa))
    // The function* expression rides the standard generator lowering; the body
    // runs synchronously to the first await (spec), then parks on the promise.
    const aa = genTemp('aa')
    return ['=>', ['()', ['...', aa]],
      ['()', '__async_run', ['()', ['function*', null, params, mapAwait(body)], ['...', aa]]]]
  }

  // async function* (params) { body } → (...aa) => __ag_run(TAGGED_MACHINE(...aa))
  function lowerAsyncGen(params, body) {
    used = true
    agUsed = true
    const aa = genTemp('ag')
    return ['=>', ['()', ['...', aa]],
      ['()', '__ag_run', ['()', ['function*', null, params, mapAgen(body)], ['...', aa]]]]
  }

  return {
    lowerAsync, lowerAsyncGen,
    noteAsync: () => { used = true },
    asyncUsed: () => used, agenUsed: () => agUsed,
    resetAsync: () => { used = false; agUsed = false },
  }
}
