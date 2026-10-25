/**
 * `jz:asyncgen` – async generators over the same sync machine, with TAGGED
 * yields (jzify/generators.js): the machine yields `{ a: 1, v }` where the
 * source awaits, `{ a: 0, v }` where it yields and `{ a: 2, v }` where a
 * yield* yields its delegate's value. `__ag_run` drives it as
 * ECMA-262 runs an async generator (27.6.3): next(), throw() and return()
 * queue, the oldest settling at each yield and at completion. An await, or a
 * yielded value, that rejects throws into the machine where it stands, so its
 * try regions see it; return(v) at a yield awaits v, then runs the finally
 * blocks around it; a generator not started, or completed, answers return(v)
 * with v awaited, throw(e) by rejecting.
 *
 * @module std/asyncgen
 */

export default `
// st.s: 0 suspended at its start, 1 at a yield, 2 executing, 3 awaiting a
// return, 4 completed; st.q: the requests { k: 0 next, 1 throw, 2 return, v, p }
export let __ag_call = (st, g, k, v) => {
  let r
  try { r = k === 0 ? g.next(v) : k === 1 ? g.throw(v) : g.return(v) } catch (e) { __ag_done(st, 2, e); return }
  if (r.done) { __ag_done(st, 1, { value: r.value, done: true }); return }
  let t = r.value
  // a delegate's value (a yield*'s) is yielded as it is
  if (t.a === 2) { __ag_yield(st, g, t.v); return }
  __await(t.v, (x) => { if (t.a === 0) __ag_yield(st, g, x); else __ag_call(st, g, 0, x) }, (e) => __ag_call(st, g, 1, e))
}
// AsyncGeneratorYield: the oldest request settles, a queued one resumes at once
export let __ag_yield = (st, g, x) => {
  __p_settle(st.q.shift().p, 1, { value: x, done: false })
  if (st.q.length > 0) __ag_resume(st, g)
  else st.s = 1
}
// AsyncGeneratorResume with the oldest request: a return awaits its value first
export let __ag_resume = (st, g) => {
  st.s = 2
  let job = st.q[0]
  if (job.k === 2) __await(job.v, (x) => __ag_call(st, g, 2, x), (e) => __ag_call(st, g, 1, e))
  else __ag_call(st, g, job.k, job.v)
}
// the body completed: the oldest request settles, then the queued ones
export let __ag_done = (st, ok, v) => {
  st.s = 4
  __p_settle(st.q.shift().p, ok, v)
  __ag_drain(st)
}
// AsyncGeneratorDrainQueue: a next() is done, a throw() rejects, a return() awaits its value
export let __ag_drain = (st) => {
  while (st.q.length > 0) {
    let job = st.q[0]
    if (job.k === 2) {
      st.s = 3
      __await(job.v, (x) => { st.s = 4; st.q.shift(); __p_settle(job.p, 1, { value: x, done: true }); __ag_drain(st) },
        (e) => { st.s = 4; st.q.shift(); __p_settle(job.p, 2, e); __ag_drain(st) })
      return
    }
    st.q.shift()
    if (job.k === 1) __p_settle(job.p, 2, job.v)
    else __p_settle(job.p, 1, { value: undefined, done: true })
  }
}
// A request at the start resumes the machine as one at a yield does: its
// throw() or return() there ends it without running the body.
export let __ag_ask = (st, g, k, v) => {
  let p = __p_new()
  if (st.s === 4 && k !== 2) {
    if (k === 1) __p_settle(p, 2, v)
    else __p_settle(p, 1, { value: undefined, done: true })
    return p
  }
  st.q.push({ k: k, v: v, p: p })
  if (st.s === 4) __ag_drain(st)
  else if (st.s < 2) __ag_resume(st, g)
  return p
}
// CreateAsyncFromSyncIterator, for a yield* of a sync iterator: each result
// a promise of it with its value awaited; a value that rejects closes the
// iterator, unless it came of return() or the result is done.
export let __ag_cont = (it, r, close) => {
  if (r == null || typeof r !== 'object' && typeof r !== 'function') throw new TypeError('iterator result is not an object')
  let p = __p_new(), done = r.done
  __await(r.value, (x) => __p_settle(p, 1, { value: x, done: done }), (e) => {
    if (close && !done) { try { if (it.return != null) it.return() } catch (x) {} }
    __p_settle(p, 2, e)
  })
  return p
}
export let __ag_from = (it) => ({
  next: (v) => { try { return __ag_cont(it, it.next(v), 1) } catch (e) { return __p_reject(e) } },
  return: (v) => {
    try { return it.return == null ? __p_resolve({ value: v, done: true }) : __ag_cont(it, it.return(v), 0) } catch (e) { return __p_reject(e) }
  },
  // a missing throw() closes the iterator, then rejects with a TypeError
  throw: (v) => {
    try {
      if (it.throw != null) return __ag_cont(it, it.throw(v), 1)
      if (it.return != null) {
        let r = it.return()
        if (r == null || typeof r !== 'object' && typeof r !== 'function') throw new TypeError('iterator return result is not an object')
      }
      throw new TypeError("The iterator does not provide a 'throw' method")
    } catch (e) { return __p_reject(e) }
  },
})
export let __ag_run = (g) => {
  let st = { s: 0, q: [] }
  let ag = { next: undefined, return: undefined, throw: undefined, '@@asyncIterator': undefined }
  ag.next = (v) => __ag_ask(st, g, 0, v)
  ag.return = (v) => __ag_ask(st, g, 2, v)
  ag.throw = (e) => __ag_ask(st, g, 1, e)
  ag[Symbol.asyncIterator] = () => ag
  return ag
}
`
