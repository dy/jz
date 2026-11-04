/**
 * `jz:async` – the promise runtime as readable jz source.
 *
 * An async function body lowers to the generator state machine (await ≡
 * yield), which drives itself: it subscribes itself to what it awaits
 * (`__await`) and settles the promise its frame holds (`__async_ret`), or,
 * called by an await of its call, resumes the awaiting machine with no
 * promise between them (`__k_ret`, jzify/async.js splitDirectAsync). Promises
 * are fixed-shape objects whose `then`, `catch` and `finally` are methods of
 * their literal; a reaction queues as a job, its handler, state and value
 * three entries of the array `__mt` (no closure per job), drained at host
 * boundaries (export return, timer tick): interop calls the exported
 * `__mt_drain` and settles host Promises through `__p_state` / `__p_value`;
 * `__p_make` / `__p_finish` adopt host promises. A WASI build drains it
 * itself at the same boundaries (optimize/watr-tail.js wasiTurns). One copy
 * per program: every module that awaits imports it, so a promise settled in
 * one module resolves an await in another. Its bindings hold the values they
 * carry without their identities (src/summary/index.js `opaque`, which reads
 * an awaited value off the promise it names), and a promise only where
 * `__p_is` proves one, `__p_cast` then typing it as any promise: so each of
 * its reads of a promise's fields is a slot's. A value it resolves with is
 * probed for a `then` only where its layout may hold one (`__p_plain`).
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
// The job queue: each job three entries, its handler, the state it settles
// with (0: a job of its own, called with no arguments) and the value;
// \`__mh\` the next job. The jobs run take no room for long: once they are
// half the queue, and a thousand, they go.
export let __mt = []
export let __mh = 0
export let __job = (h, st, v) => { __mt.push(h, st, v) }
export let __drain = () => {
  while (__mh < __mt.length) {
    let i = __mh
    __mh = i + 3
    if (i >= 3072 && i * 2 >= __mt.length) { __mt.splice(0, i); __mh = 3; i = 0 }
    let h = __mt[i], st = __mt[i + 1], v = __mt[i + 2]
    if (st === 0) h(); else h(st, v)
  }
  __mt.length = 0; __mh = 0
}
// the host's reads of a value it holds: a promise's state (-1: none) and value
export let __state = (p) => __p_is(p) ? __p_cast(p).st : -1
export let __value = (p) => __p_cast(p).val
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
  if (st === 1 && v != null && typeof v === 'object' && !__p_plain(v)) __p_adopt(p, v)
  else __p_fin(p, st, v)
}
export let __p_adopt = (p, v) => {
  // a promise resolved with itself rejects (27.2.1.3.2 step 7)
  if (v === p) { __p_fin(p, 2, new TypeError('Chaining cycle detected for promise')); return }
  // a promise adopted as a thenable is (NewPromiseResolveThenableJob): its
  // then() runs in a job of its own, the settlement a reaction after it
  if (__p_is(v)) { let q = __p_cast(v); p.rs = 1; __job(() => __p_sub(q, (st2, v2) => __p_fin(p, st2, v2)), 0, undefined); return }
  // plain-object thenable (spec: any object with callable then): \`then\` is
  // read once, a throw of its getter rejecting
  let then = undefined
  try { then = __p_thenOf(v) } catch (e) { __p_fin(p, 2, e); return }
  if (typeof then === 'function') { __p_then(p, v, then); return }
  __p_fin(p, 1, v)
}
// A resolution's \`then\`, read once: one read for both resolutions (a
// promise's here, an awaiting machine's, \`__k_ret\`), its receiver every
// value either resolves with, which the summary holds as one binding.
export let __p_thenOf = (v) => v.then
// A thenable resolving p: its \`then\`, read once where it resolved p, is
// called on it in a job; the resolve/reject pair shares one already-called
// latch, and a then() throw after that latch is ignored (27.2.1.3.2, 27.2.2.2).
export let __p_then = (p, v, then) => {
  p.rs = 1
  __job(() => {
    let done = 0
    try {
      then.call(v,
        (x) => { if (done) return; done = 1; p.rs = 0; __p_settle(p, 1, x) },
        (e) => { if (done) return; done = 1; __p_fin(p, 2, e) })
    } catch (e2) { if (done === 0) __p_fin(p, 2, e2) }
  }, 0, undefined)
}
// An object awaited is resolved as a promise is (its \`then\` read there, once);
// any other value resumes a job later. \`h(st, x)\` takes the settlement.
export let __await = (v, h) => {
  if (v != null && typeof v === 'object') __p_sub(__p_resolve(v), h)
  else __job(h, 1, v)
}
// The value an await of \`a\` resumes its machine with (jzify/generators.js):
// \`v\`, what its settlement sends, is the settled value of \`a\`, which the
// program summary reads off \`a\` (src/summary/index.js awaited).
export let __awaited = (a, v) => v
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
  if (__p_is(v)) return __p_cast(v)
  let p = __p_new(); __p_settle(p, 1, v); return p
}
// A promise rejected with \`e\`; with a continuation \`k\`, none: k resumes
// with the rejection a job later, as an await of that promise would.
export let __p_reject = (e, k) => {
  if (k != null) { __job(k, 2, e); return __p_k }
  let p = __p_new(); __p_settle(p, 2, e); return p
}
// An async function's promise, a field of its machine's frame
// (jzify/generators.js \`self\`), and its completion: the summary names the
// promise at its \`__p_async\` call node and joins into it what each
// \`__async_ret\` resolves it with (src/summary/index.js). A call an await
// makes directly (jzify/async.js \`direct\`) passes the awaiting machine as
// \`k\`: then there is no promise, only the one that never settles,
// \`__p_k\`, which stands for it where the summary reads its type, and the
// completion resumes k (\`__k_ret\`).
let __p_k = __p_new()
export let __p_async = (k) => k != null ? __p_k : __p_new()
export let __async_ret = (p, v, k) => { if (k != null) __k_ret(k, v); else __p_settle(p, 1, v) }
export let __async_rej = (p, e, k) => { if (k != null) __job(k, 2, e); else __p_settle(p, 2, e) }
// What an async function that never awaits returns (jzify/async.js
// settledAsync): a new promise resolved with \`v\`, a thenable adopted, or,
// called with a continuation, none.
export let __p_done = (v, k) => {
  if (k != null) { __k_ret(k, v); return __p_k }
  let p = __p_new(); __p_settle(p, 1, v); return p
}
// The awaiting machine \`k\` resumed with what the call it awaits resolved
// its promise with, where that promise would have resumed it: a job later,
// or, for a value that adopts (a promise, a thenable, its \`then\` read here
// once), from a promise resolved with it, which k then awaits.
export let __k_ret = (k, v) => {
  if (v != null && typeof v === 'object' && !__p_plain(v)) __k_adopt(k, v)
  else __job(k, 1, v)
}
export let __k_adopt = (k, v) => {
  if (__p_is(v)) { let p = __p_new(); __p_settle(p, 1, v); __p_sub(p, k); return }
  let then = undefined
  try { then = __p_thenOf(v) } catch (e) { __job(k, 2, e); return }
  if (typeof then === 'function') { let p = __p_new(); __p_then(p, v, then); __p_sub(p, k); return }
  __job(k, 1, v)
}
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
  let n = a.length, out = new Array(n), left = n
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
  let n = a.length, out = new Array(n), left = n
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
// (the host settles only a promise it made, \`__p_make\`'s)
export let __p_finish = (p, st, v) => { if (__p_is(p)) __p_settle(__p_cast(p), st, v) }
`
