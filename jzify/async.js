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

export function createAsyncLowering({ genTemp, err }) {
  let used = false

  // await → yield inside THIS function body only (nested function forms keep
  // their own await/this rules; a stray await inside a nested sync fn falls
  // through to prepare's clean reject).
  const FN_OPS = new Set(['=>', 'function', 'function*', 'class', 'async'])
  function mapAwait(node) {
    if (!Array.isArray(node)) return node
    if (FN_OPS.has(node[0])) return node
    if (node[0] === 'await') return ['yield', mapAwait(node[1])]
    if (node[0] === 'try' && refsAwait(node))
      err('try/catch across `await` is outside the v1 async surface — let the rejection reject the async function, or move the try into a sync helper')
    return node.map((n, i) => i === 0 ? n : mapAwait(n))
  }
  function refsAwait(node) {
    if (!Array.isArray(node)) return false
    if (FN_OPS.has(node[0])) return false
    if (node[0] === 'await') return true
    return node.some(refsAwait)
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

  return { lowerAsync, noteAsync: () => { used = true }, asyncUsed: () => used, resetAsync: () => { used = false } }
}
