// Standard modules in jz's own subset (src/std): a module referencing a std
// global (`Event`, `DOMException`, `WeakRef`) or a lowering helper
// (`__p_new`, `__it_drain`) it does not declare imports the `jz:` module
// implicitly; the bundler prepares each specifier once, so every module
// shares one class identity and one promise runtime (one microtask queue).
// Reflection over a descriptor-free object model: `C.prototype` of a class
// is an empty object, a descriptor is the value under the data flags.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { onKernel, onWasi } from './_matrix.js'

const run = (src, opts) => jz(src, opts).exports.f()

test('std: EventTarget dispatch order, once, removal, preventDefault, instanceof', () => {
  is(run(`class Src extends EventTarget {
    #onended = null
    get onended() { return this.#onended }
    set onended(fn) { if (this.#onended) this.removeEventListener('ended', this.#onended); this.#onended = fn; if (fn) this.addEventListener('ended', fn) }
    stop() { this.dispatchEvent(new Event('ended')) }
  }
  export let f = () => {
    const s = new Src(); let n = 0
    s.addEventListener('ended', (e) => { n += e.type === 'ended' && e.target === s ? 1 : 100 })
    s.addEventListener('ended', () => { n += 10 }, { once: true })
    s.onended = (e) => { n += 1000 }
    s.stop(); s.stop()
    s.onended = null
    s.stop()
    const ev = new CustomEvent('x', { detail: 7, cancelable: true }); ev.preventDefault()
    return n + (ev instanceof Event ? 10000 : 0) + (ev.defaultPrevented ? 100000 : 0) + (s.dispatchEvent(ev) ? 0 : 1000000) + ev.detail * 10000000
  }`), 70000000 + 1000000 + 100000 + 10000 + 2000 + 10 + 3)
})

test('std: one class identity across modules', () => {
  const modules = {
    './a.js': `export const mk = () => new Event('tick')`,
    './b.js': `export class T extends EventTarget { go() { this.dispatchEvent(new Event('go')) } }`,
  }
  const src = `import { mk } from './a.js'
    import { T } from './b.js'
    export const f = () => { const e = mk(); const t = new T(); let n = 0; t.addEventListener('go', () => n++); t.go(); return (e instanceof Event ? 1 : 0) + (e.type === 'tick' ? 10 : 0) + n * 100 }`
  is(run(src, { modules }), 111)
  const wat = compile(src, { modules, wat: true })
  is((wat.match(/\(func \$\S*\$Event\n/g) || []).length, 1, 'one Event factory for the program')
})

test('std: one promise runtime across modules – a promise settled in one module resolves an await in another', async () => {
  if (onWasi() || onKernel()) return
  const modules = {
    './a.js': `export const g = async () => { return 2 }`,
    './b.js': `export const h = async () => { const v = await Promise.resolve(5); return v }`,
  }
  const src = `import { g } from './a.js'
    import { h } from './b.js'
    export const f = async () => { const v = await g(); const w = await h(); return v + w + 1 }
    export const k = () => g()`
  const m = jz(src, { modules })
  is(await m.exports.f(), 8)
  is(await m.exports.k(), 2, 'a raw promise from an imported async function adopts at the boundary')
  const wat = compile(src, { modules, wat: true })
  is((wat.match(/\(func \$\S*__p_settle\S*/g) || []).length, 1, 'one settle function for the program')
  ok(typeof m.exports.__mt_drain === 'function', 'the host-boundary contract is exported from the program')
})

test('std: DOMException carries name and legacy code; `globalThis.X || Error` keeps the std class', () => {
  is(run(`const _DOMException = globalThis.DOMException
    export const DOMErr = _DOMException ? (msg, name) => new _DOMException(msg, name) : (msg, name) => { let e = new Error(msg); e.name = name; return e }
    export class InvalidStateError extends (_DOMException || Error) {
      constructor(msg = 'Invalid state') { super(msg, 'InvalidStateError'); if (!_DOMException) this.name = 'InvalidStateError' }
    }
    export let f = () => {
      let a = 0, b = 0
      try { throw new InvalidStateError() } catch (e) { a = (e instanceof Error ? 1 : 0) + (e.name === 'InvalidStateError' ? 10 : 0) + (e.message === 'Invalid state' ? 100 : 0) + (e instanceof DOMException ? 1000 : 0) + e.code * 10000 }
      try { throw DOMErr('bad', 'IndexSizeError') } catch (e) { b = (e instanceof DOMException ? 1 : 0) + e.code * 10 + (e.message === 'bad' ? 100 : 0) }
      return a * 1000 + b
    }`), 111111 * 1000 + 111)
})

test('std: WeakRef derefs and FinalizationRegistry never fires (no collector)', () => {
  is(run(`class T { #clones = new Set(); #reg = new FinalizationRegistry(ref => this.#clones.delete(ref))
    add(o) { const r = new WeakRef(o); this.#clones.add(r); this.#reg.register(o, r, o); return r }
    live() { let n = 0; for (let r of this.#clones) if (r.deref()) n++; return n } }
  export let f = () => { const t = new T(); const r = t.add({ a: 1 }); t.add({ a: 2 }); return t.live() * 10 + r.deref().a }`), 21)
})

test('std: a declared name shadows the std global; a sync program links nothing', () => {
  is(run(`class Event { constructor(t) { this.t = t + 1 } } export let f = () => new Event(1).t`), 2)
  const wat = compile(`export let f = () => 1`, { wat: true })
  ok(!/\$jz_\w+\$/.test(wat), 'no std module in a program that references none')
})

test('reflection: C.prototype is empty, descriptors are data descriptors, defineProperty stores', () => {
  is(run(`class G { get gain() { return 1 } }
    const makeEnumerable = (proto) => { let n = 0; for (let name of Object.getOwnPropertyNames(proto)) { let desc = Object.getOwnPropertyDescriptor(proto, name); if (desc.get && !desc.enumerable) n++ } return n }
    export let f = () => { let n = 0; for (let cls of [G]) n += makeEnumerable(cls.prototype); const d = Object.getOwnPropertyDescriptor({ a: 5 }, 'a'); return n * 10 + d.value + (Object.getOwnPropertyDescriptor({ a: 5 }, 'b') === undefined ? 100 : 0) + (d.writable && d.enumerable && d.configurable ? 1000 : 0) }`), 1105)
  is(run(`const def = (o, k, d) => Object.defineProperty(o, k, d)
    export let f = () => { const o = {}; def(o, 'a', { value: 5, enumerable: true }); const d = Object.getOwnPropertyDescriptor(o, 'a'); def(o, 'b', { ...d, enumerable: false }); return o.a * 10 + o.b }`), 55)
  is(run(`const def = (o, k, d) => Object.defineProperty(o, k, d)
    export let f = () => { const o = { a: 1 }; def(o, 'a', { writable: false }); def(o, 'b', { value: 7 }); return o.a * 10 + o.b }`), 17, 'a descriptor without value leaves the property')
  is(run(`const def = (o, k, d) => Object.defineProperty(o, k, d)
    export let f = () => { try { def({}, 'x', { get() { return 1 } }); return '' } catch (e) { return e.name } }`), 'TypeError', 'a runtime accessor descriptor is a TypeError')
  throws(() => compile(`export let f = () => Object.defineProperty({}, 'x', { get() { return 1 } })`), /accessor descriptor/)
})

test('accessors: `in` sees accessor slots; a literal receiver stores plainly; a derived accessor probes', () => {
  is(run(`class C extends EventTarget { _r = 1; get sampleRate() { return this._r } }
    const chk = (o) => ('sampleRate' in o ? 1 : 0) + ('_r' in o ? 10 : 0) + ('nope' in o ? 100 : 0)
    export const f = () => chk(new C()) + chk({ sampleRate: 2 }) * 1000 + ('sampleRate' in new C() ? 100000 : 0)`), 101011)
  is(run(`class A { get v() { return 1 } } class B extends A { get bufferSize() { return 5 } set bufferSize(x) { this.q = x } }
    export let f = () => { let format = { a: 1 }; format.bufferSize = 3; const b = new B(); b.bufferSize = 9; return format.bufferSize + format.a + b.bufferSize + b.q }`), 18)
})

test('well-known symbol polyfill assignment is a no-op statement', () => {
  is(run(`Symbol.dispose ||= Symbol('dispose')
    class P { constructor() { this.open = 1 }
      [Symbol.dispose]() { this.open = 0 } }
    export let f = () => { const p = new P(); p[Symbol.dispose](); return p.open + 5 }`), 5)
})

test('host import: a missing argument crosses as undefined in the i64 carrier', () => {
  if (onWasi() || onKernel()) return
  const m = jz(`import dec from '@audio/decode'\nexport let f = (x) => dec(x)`,
    { imports: { '@audio/decode': { default: (a, b, c) => a * 10 + (b === undefined ? 1 : 0) + (c === undefined ? 1 : 0) } } })
  is(m.exports.f(1), 12)
})
