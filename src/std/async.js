/**
 * `jz:async` – the promise runtime as readable jz source.
 *
 * An async function body lowers to the generator state machine (await ≡
 * yield) and `__async_run` drives it, parking on awaited promises. Promises
 * are fixed-shape objects whose `then`, `catch` and `finally` are methods of
 * their literal; a reaction queues as a job, its handler, state and value in
 * the arrays `__mt`, `__ms`, `__mv` (no closure per job), drained at host
 * boundaries (export return, timer tick): interop calls the exported
 * `__mt_drain` and settles host Promises through `__p_state` / `__p_value`;
 * `__p_make` / `__p_finish` adopt host promises. A WASI build drains it
 * itself at the same boundaries (optimize/watr-tail.js wasiTurns). One copy
 * per program: every module that awaits imports it, so a promise settled in
 * one module resolves an await in another.
 *
 * Divergences (documented): unhandled rejections don't report; job ordering
 * is per-drain-cycle (boundary/timer granularity), not per-continuation;
 * AggregateError is a fixed-shape `{ name, message, errors }` value.
 *
 * @module std/async
 */

/** A promise's fields, in layout order: the summary names the promise an
 *  async function returns by this record (src/summary/index.js promiseAt). */
export const PROMISE_KEYS = ['__p', 'st', 'rs', 'val', 'cbs', 'then', 'catch', 'finally']

export default `
// The job queue: each job's handler, the state it settles with (0: a job of
// its own, called with no arguments) and the value, in arrays of their own,
// the handlers one closure family; \`__mh\` the next job. The jobs run take
// no room for long: once they are half the queue, and a thousand, they go.
export let __mt = []
export let __ms = []
export let __mv = []
export let __mh = 0
export let __job = (h, st, v) => { __mt.push(h); __ms.push(st); __mv.push(v) }
export let __drain = () => {
  while (__mh < __mt.length) {
    let i = __mh
    __mh = i + 1
    if (i >= 1024 && i * 2 >= __mt.length) { __mt.splice(0, i); __ms.splice(0, i); __mv.splice(0, i); __mh = 1; i = 0 }
    let h = __mt[i], st = __ms[i], v = __mv[i]
    if (st === 0) h(); else h(st, v)
  }
  __mt.length = 0; __ms.length = 0; __mv.length = 0; __mh = 0
}
export let __state = (p) => p != null && typeof p === 'object' && p.__p === 1 ? p.st : -1
export let __value = (p) => p.val
export let __p_new = () => ({ __p: 1, st: 0, rs: 0, val: undefined, cbs: null,
  then(ok, err) {
    let q = __p_new()
    __p_sub(this, (st, v) => {
      // non-callable handlers are ignored (spec: fulfillment/rejection pass through)
      if (st === 1) { if (ok == null || typeof ok !== 'function') { __p_settle(q, 1, v) } else { try { __p_settle(q, 1, ok(v)) } catch (e) { __p_settle(q, 2, e) } } }
      else { if (err == null || typeof err !== 'function') { __p_settle(q, 2, v) } else { try { __p_settle(q, 1, err(v)) } catch (e2) { __p_settle(q, 2, e2) } } }
    })
    return q
  },
  catch(err) { return this.then(undefined, err) },
  finally(fn) { return this.then((v) => { fn(); return v }, (e) => { fn(); throw e }) } })
// A reaction: a job at once where the promise is settled, else at its settlement
export let __p_sub = (p, h) => {
  if (p.st > 0) __job(h, p.st, p.val)
  else if (p.cbs == null) p.cbs = [h]
  else p.cbs.push(h)
}
export let __p_fin = (p, st, v) => {
  if (p.st > 0) return
  p.st = st
  p.val = v
  let cbs = p.cbs
  if (cbs == null) return
  p.cbs = null
  for (let i = 0; i < cbs.length; i++) __job(cbs[i], st, v)
}
export let __p_settle = (p, st, v) => {
  if (p.st > 0 || p.rs === 1) return
  if (st === 1 && v != null && typeof v === 'object') {
    // a promise resolved with itself rejects (27.2.1.3.2 step 7)
    if (v === p) { __p_fin(p, 2, new TypeError('Chaining cycle detected for promise')); return }
    // a promise adopted as a thenable is (NewPromiseResolveThenableJob): its
    // then() runs in a job of its own, the settlement a reaction after it
    if (v.__p === 1) { p.rs = 1; __job(() => __p_sub(v, (st2, v2) => __p_fin(p, st2, v2)), 0, undefined); return }
    // plain-object thenable (spec: any object with callable then): \`then\` is
    // read once, a throw of its getter rejecting, and called on the object in
    // a job; the resolve/reject pair shares one already-called latch, and a
    // then() throw after that latch is ignored (27.2.1.3.2, 27.2.2.2).
    let then = undefined
    try { then = v.then } catch (e) { __p_fin(p, 2, e); return }
    if (typeof then === 'function') {
      p.rs = 1
      __job(() => {
        let done = 0
        try {
          then.call(v,
            (x) => { if (done) return; done = 1; p.rs = 0; __p_settle(p, 1, x) },
            (e) => { if (done) return; done = 1; __p_fin(p, 2, e) })
        } catch (e2) { if (done === 0) __p_fin(p, 2, e2) }
      }, 0, undefined)
      return
    }
  }
  __p_fin(p, st, v)
}
// An object awaited is resolved as a promise is (its \`then\` read there, once);
// any other value resumes a job later. \`h(st, x)\` takes the settlement.
export let __await = (v, h) => {
  if (v != null && typeof v === 'object') __p_sub(__p_resolve(v), h)
  else __job(h, 1, v)
}
// The value an await of \`a\` resumes its machine with (jzify/generators.js):
// \`v\`, what the driver below sends, is the settled value of \`a\`, which the
// program summary reads off \`a\` (src/summary/index.js awaited).
export let __awaited = (a, v) => v
// The driver: one handler per call resumes the machine at each settlement.
export let __async_run = (it) => {
  let p = __p_new()
  let step = (st, x) => {
    let r
    try { r = st === 1 ? it.next(x) : it.throw(x) } catch (e) { __p_settle(p, 2, e); return }
    if (r.done) __p_settle(p, 1, r.value)
    else __await(r.value, step)
  }
  let r0
  try { r0 = it.next() } catch (e) { __p_settle(p, 2, e); return p }
  if (r0.done) __p_settle(p, 1, r0.value)
  else __await(r0.value, step)
  return p
}
export let __p_exec = (fn) => {
  if (fn == null || typeof fn !== 'function') throw new TypeError('Promise executor is not callable')
  let p = __p_new()
  let done = 0
  try {
    fn((v) => { if (done) return; done = 1; __p_settle(p, 1, v) },
       (e) => { if (done) return; done = 1; __p_settle(p, 2, e) })
  } catch (e2) { if (done === 0) __p_settle(p, 2, e2) }
  return p
}
export let __p_resolve = (v) => {
  if (v != null && typeof v === 'object' && v.__p === 1) return v
  let p = __p_new(); __p_settle(p, 1, v); return p
}
export let __p_reject = (e) => { let p = __p_new(); __p_settle(p, 2, e); return p }
// What an async function that never awaits returns (jzify/async.js
// settledAsync): a new promise resolved with \`v\`, a thenable adopted.
export let __p_done = (v) => { let p = __p_new(); __p_settle(p, 1, v); return p }
// GetIterator for the combinators: arrays pass through, iterator-protocol
// values drain, anything else (non-iterable input, or an @@iterator that is
// non-callable / returns a non-object) yields null → the combinator REJECTS
// with a TypeError value instead of resolving garbage.
export let __p_list = (v) => {
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
export let __p_all = (arr) => {
  let p = __p_new()
  let a = __p_list(arr)
  if (a == null) { __p_settle(p, 2, 'TypeError: Promise.all argument is not iterable'); return p }
  let n = a.length, out = [], left = n
  if (n === 0) { __p_settle(p, 1, out); return p }
  for (let i = 0; i < n; i++) {
    let k = i
    __await(a[k], (st, v) => { if (st === 1) { out[k] = v; left--; if (left === 0) __p_settle(p, 1, out) } else __p_settle(p, 2, v) })
  }
  return p
}
export let __p_race = (arr) => {
  let p = __p_new()
  let a = __p_list(arr)
  if (a == null) { __p_settle(p, 2, 'TypeError: Promise.race argument is not iterable'); return p }
  for (let i = 0; i < a.length; i++) __await(a[i], (st, v) => __p_settle(p, st, v))
  return p
}
export let __p_allSettled = (arr) => {
  let p = __p_new()
  let a = __p_list(arr)
  if (a == null) { __p_settle(p, 2, 'TypeError: Promise.allSettled argument is not iterable'); return p }
  let n = a.length, out = [], left = n
  if (n === 0) { __p_settle(p, 1, out); return p }
  for (let i = 0; i < n; i++) {
    let k = i
    __await(a[k], (st, v) => {
      out[k] = st === 1 ? { status: 'fulfilled', value: v, reason: undefined } : { status: 'rejected', value: undefined, reason: v }
      left--; if (left === 0) __p_settle(p, 1, out)
    })
  }
  return p
}
export let __p_any = (arr) => {
  let p = __p_new()
  let a = __p_list(arr)
  if (a == null) { __p_settle(p, 2, 'TypeError: Promise.any argument is not iterable'); return p }
  let n = a.length, errs = [], left = n
  if (n === 0) { __p_settle(p, 2, { name: 'AggregateError', message: 'All promises were rejected', errors: errs }); return p }
  for (let i = 0; i < n; i++) {
    let k = i
    __await(a[k], (st, v) => {
      if (st === 1) { __p_settle(p, 1, v); return }
      errs[k] = v; left--; if (left === 0) __p_settle(p, 2, { name: 'AggregateError', message: 'All promises were rejected', errors: errs })
    })
  }
  return p
}
export let __p_try = (fn, ...aa) => {
  let p = __p_new()
  try { __p_settle(p, 1, fn(...aa)) } catch (e) { __p_settle(p, 2, e) }
  return p
}
export let __p_withResolvers = () => {
  let p = __p_new()
  return { promise: p, resolve: (v) => __p_settle(p, 1, v), reject: (e) => __p_settle(p, 2, e) }
}
export let __mt_drain = () => __drain()
export let __p_state = (p) => __state(p)
export let __p_value = (p) => __value(p)
export let __p_make = () => __p_new()
export let __p_finish = (p, st, v) => __p_settle(p, st, v)
`
