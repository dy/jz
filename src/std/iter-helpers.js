/**
 * `jz:iter-helpers` – ES2025 iterator helpers as first-class values: each
 * helper wraps the source in a fresh decorated iterator, lazy and
 * spec-shaped (value+counter callbacks, early return() on short-circuit).
 * Fusable chains still fuse (jzify/generators.js); this is the fallback that
 * makes helper results first-class values.
 *
 * @module std/iter-helpers
 */

export default `
export let __it_fn = (f, name) => { if (f == null || typeof f !== 'function') throw 'TypeError: ' + name + ' callback must be callable' }
export let __it_cl = (it) => { if (typeof it.return === 'function') it.return(undefined) }
export let __it_lim = (n, name) => {
  if (typeof n === 'object') throw 'TypeError: ' + name + ' limit is an object (with valueOf/toString) – jz has no general ToPrimitive dynamic dispatch for a value received through an untyped parameter; call .valueOf()/.toString() (or Number()) yourself before passing the result'
  let lim = +n
  if (lim !== lim) throw 'RangeError: ' + name + ' limit must not be NaN'
  lim = Math.trunc(lim)
  if (lim < 0) throw 'RangeError: ' + name + ' limit must be non-negative'
  return lim
}
export let __it_mk = (nx, rt, th) => {
  let it = { next: nx, return: rt, throw: th, '@@iterator': undefined,
    map: undefined, filter: undefined, take: undefined, drop: undefined, flatMap: undefined,
    toArray: undefined, reduce: undefined, forEach: undefined, some: undefined, every: undefined, find: undefined }
  it[Symbol.iterator] = () => it
  it.map = (f) => { __it_fn(f, 'map'); let c = 0; return __it_mk((v) => {
    let r = it.next(v)
    if (r.done) return r
    let m = f(r.value, c)
    c++
    return { value: m, done: false }
  }, it.return, it.throw) }
  it.filter = (f) => { __it_fn(f, 'filter'); let c = 0; return __it_mk((v) => {
    let r = it.next(v)
    while (!r.done) { let hit = f(r.value, c); c++; if (hit) return { value: r.value, done: false }; r = it.next() }
    return r
  }, it.return, it.throw) }
  it.take = (n) => {
    let lim = __it_lim(n, 'take')
    let c = 0
    return __it_mk(() => {
      if (c >= lim) { __it_cl(it); return { value: undefined, done: true } }
      c++
      return it.next()
    }, it.return, it.throw)
  }
  it.drop = (n) => {
    let lim = __it_lim(n, 'drop')
    let c = 0
    return __it_mk(() => {
      while (c < lim) { c++; let r0 = it.next(); if (r0.done) return r0 }
      return it.next()
    }, it.return, it.throw)
  }
  it.flatMap = (f) => {
    __it_fn(f, 'flatMap')
    let inner = null, c = 0
    return __it_mk(() => {
      while (true) {
        if (inner != null) {
          let ri = inner.next()
          if (!ri.done) return ri
          inner = null
        }
        let r = it.next()
        if (r.done) return r
        let m = f(r.value, c)
        c++
        inner = __it_from(m)
      }
    }, (rv) => {
      // closing the helper closes the ACTIVE inner iterator first (spec:
      // IteratorClose forwards through the flattening), then the source.
      if (inner != null) { let i2 = inner; inner = null; __it_cl(i2) }
      if (typeof it.return === 'function') return it.return(rv)
      return { value: rv, done: true }
    }, it.throw)
  }
  it.toArray = () => { let a = [], r = it.next(); while (!r.done) { a.push(r.value); r = it.next() } return a }
  it.reduce = (f, init) => {
    __it_fn(f, 'reduce')
    let acc = init, c = 0
    if (init === undefined) {
      let r0 = it.next()
      if (r0.done) throw 'TypeError: Reduce of empty iterator with no initial value'
      acc = r0.value
      c = 1
    }
    let r = it.next()
    while (!r.done) { acc = f(acc, r.value, c); c++; r = it.next() }
    return acc
  }
  it.forEach = (f) => { __it_fn(f, 'forEach'); let c = 0, r = it.next(); while (!r.done) { f(r.value, c); c++; r = it.next() } }
  it.some = (f) => { __it_fn(f, 'some'); let c = 0, r = it.next(); while (!r.done) { if (f(r.value, c)) { __it_cl(it); return true } c++; r = it.next() } return false }
  it.every = (f) => { __it_fn(f, 'every'); let c = 0, r = it.next(); while (!r.done) { if (!f(r.value, c)) { __it_cl(it); return false } c++; r = it.next() } return true }
  it.find = (f) => { __it_fn(f, 'find'); let c = 0, r = it.next(); while (!r.done) { if (f(r.value, c)) { __it_cl(it); return r.value } c++; r = it.next() } return undefined }
  return it
}
export let __it_from = (v) => {
  if (v == null) throw 'TypeError: value is not iterable'
  let w = v
  if (typeof w === 'object' && w[Symbol.iterator] != null) {
    if (typeof w[Symbol.iterator] !== 'function') throw 'TypeError: [Symbol.iterator] is not callable'
    w = w[Symbol.iterator]()
  }
  if (typeof w === 'object' && w.next != null) return w
  let ix = 0
  return __it_mk(() => {
    if (ix >= v.length) return { value: undefined, done: true }
    let e = v[ix]
    ix++
    return { value: e, done: false }
  }, undefined, undefined)
}
`
