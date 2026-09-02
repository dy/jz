/**
 * `jz:asyncgen` – async generators over the same sync machine, with TAGGED
 * yields: the lowered body yields `{ a: 1, v }` where the source awaited and
 * `{ a: 0, v }` where it yielded; `__ag_run` drives the machine, parking on
 * awaited promises and resolving each next() with a `{ value, done }`
 * record. next() calls serialize through a per-instance queue (spec:
 * requests queue while a step is inflight).
 *
 * @module std/asyncgen
 */

export default `
export let __ag_fin = (st, p, ok, v) => { __p_settle(p, ok, v); st.b = 0; __ag_kick(st) }
export let __ag_step = (st, g, p, r) => {
  if (r.done) { __ag_fin(st, p, 1, { value: r.value, done: true }); return }
  let t = r.value
  // AsyncGeneratorYield AWAITS the yielded value first – yielding a rejected
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
export let __ag_kick = (st) => {
  if (st.b === 1) return
  if (st.q.length === 0) return
  st.b = 1
  let job = st.q.shift()
  let r
  try { r = job.g.next(job.v) } catch (e) { st.b = 0; __p_settle(job.p, 2, e); __ag_kick(st); return }
  __ag_step(st, job.g, job.p, r)
}
export let __ag_run = (g) => {
  let st = { b: 0, q: [] }
  let ag = { next: undefined, return: undefined, throw: undefined, '@@asyncIterator': undefined }
  ag.next = (v) => { let p = __p_new(); st.q.push({ g: g, p: p, v: v }); __ag_kick(st); return p }
  ag.return = (v) => { let p = __p_new(); let r = g.return(v); __p_settle(p, 1, { value: r.value, done: true }); return p }
  ag.throw = (e) => { let p = __p_new(); try { g.throw(e) } catch (x) { __p_settle(p, 2, x) } return p }
  ag[Symbol.asyncIterator] = () => ag
  return ag
}
`
