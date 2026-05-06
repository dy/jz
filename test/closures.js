// Closures: capture by value, currying, callbacks, first-class functions
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'

function run(code, opts) {
  const wasm = compile(code, opts)
  const mod = new WebAssembly.Module(wasm)
  return new WebAssembly.Instance(mod).exports
}

// Method-dispatch tests pull dynamic-property helpers that need host imports;
// jz() wires them. Plain-closure tests above use raw instantiation since they
// don't hit those code paths.
const runFull = (code, opts) => jz(code, opts).exports

// === Basic closure (capture outer variable) ===

test('closure: capture param', () => {
  is(run(`
    export let makeAdder = (n) => (x) => x + n
    export let test = () => {
      let add5 = makeAdder(5)
      return add5(10)
    }
  `).test(), 15)
})

test('closure: capture multiple values', () => {
  is(run(`
    export let test = () => {
      let a = 10
      let b = 20
      let fn = (x) => x + a + b
      return fn(3)
    }
  `).test(), 33)
})

// === Currying ===

test('closure: currying', () => {
  const { test } = run(`
    export let add = (a) => (b) => a + b
    export let test = () => {
      let add3 = add(3)
      return add3(7) + add3(10)
    }
  `)
  is(test(), 23)  // 10 + 13
})

test('closure: curried mul', () => {
  is(run(`
    export let mul = (a) => (b) => a * b
    export let test = () => {
      let double = mul(2)
      let triple = mul(3)
      return double(5) + triple(5)
    }
  `).test(), 25)  // 10 + 15
})

// === Callbacks ===

test('closure: pass function as callback', () => {
  is(run(`
    let apply = (fn, x) => fn(x)
    export let test = () => {
      let double = (x) => x * 2
      return apply(double, 21)
    }
  `).test(), 42)
})

test('closure: callback with capture', () => {
  is(run(`
    let apply = (fn, x) => fn(x)
    export let test = () => {
      let n = 100
      let addN = (x) => x + n
      return apply(addN, 5)
    }
  `).test(), 105)
})

// === No captures (function reference) ===

test('closure: no-capture function reference', () => {
  is(run(`
    export let test = () => {
      let neg = (x) => -x
      return neg(42)
    }
  `).test(), -42)
})

// === Closure preserves value at creation time ===

test('closure: mutable capture (by reference)', () => {
  is(run(`
    export let test = () => {
      let n = 10
      let fn = (x) => x + n
      n = 999
      return fn(5)
    }
  `).test(), 1004)  // n=999 visible to closure (JS semantics)
})

test('closure: hoisted function captures later binding by reference', () => {
  is(run(`
    export let test = () => {
      function inner() { return x * 10 + y }
      let x = 2
      let y = 1
      x ||= 0
      y ||= 0
      return inner()
    }
  `, { jzify: true }).test(), 21)
})

test('closure: mutation from inside closure', () => {
  is(run(`
    export let test = () => {
      let count = 0
      let inc = () => { count += 1; return count }
      inc()
      inc()
      return inc()
    }
  `).test(), 3)
})

test('closure: immutable capture stays fast', () => {
  is(run(`
    export let test = () => {
      let x = 42
      let fn = () => x
      return fn()
    }
  `).test(), 42)
})

test('closure: two closures share mutable cell', () => {
  is(run(`
    export let test = () => {
      let n = 0
      let inc = () => { n += 1; return n }
      let get = () => n
      inc()
      inc()
      return get()
    }
  `).test(), 2)
})

test('closure: inner mutation visible to outer', () => {
  is(run(`
    export let test = () => {
      let n = 0
      let inc = () => { n += 1; return n }
      inc()
      inc()
      return n
    }
  `).test(), 2)
})

test('closure: ++ on captured var', () => {
  is(run(`
    export let test = () => {
      let n = 0
      let inc = () => ++n
      inc()
      inc()
      return inc()
    }
  `).test(), 3)
})

test('closure: captured parameter', () => {
  is(run(`
    export let add = (base) => {
      let fn = (x) => base + x
      base = 100
      return fn(5)
    }
  `).add(0), 105)
})

// === Multiple closures from same factory ===

test('closure: multiple instances', () => {
  const { test } = run(`
    export let make = (n) => (x) => x * n
    export let test = () => {
      let x2 = make(2)
      let x3 = make(3)
      let x10 = make(10)
      return x2(5) + x3(5) + x10(5)
    }
  `)
  is(test(), 75)  // 10 + 15 + 50
})

// === Expression-valued closures ===

test('closure: returned closure with default', () => {
  is(run(`
    let mk = () => (x = 1) => x
    export let test = () => mk()()
  `).test(), 1)
})

test('closure: returned closure with args', () => {
  is(run(`
    let mk = () => (a, b) => a + b
    export let test = () => mk()(3, 4)
  `).test(), 7)
})

test('closure: returned closure with rest', () => {
  is(run(`
    let mk = () => (...args) => args.length
    export let test = () => mk()(1, 2, 3)
  `).test(), 3)
})

// === Top-level higher-order functions ===

test('HOF: top-level function as argument', async () => {
  const wasm = compile('let k = () => 7; let use = (g) => g(); export let f = () => use(k)')
  is(new WebAssembly.Instance(new WebAssembly.Module(wasm)).exports.f(), 7)
})

test('HOF: top-level function with args', async () => {
  const wasm = compile('let add = (a, b) => a + b; let apply = (g, x, y) => g(x, y); export let f = () => apply(add, 3, 4)')
  is(new WebAssembly.Instance(new WebAssembly.Module(wasm)).exports.f(), 7)
})

// === Method dispatch (closure stored as object property, called as o.m(args)) ===
//
// `o.m(args)` where `m` is a closure-valued property goes through schema-known
// slot read + closure.call (src/emit.js) for fixed-shape objects. The fn module
// must be auto-loaded for any inline arrow that survives prep — defFunc only
// lifts arrows that are the direct RHS of a let/const, so an arrow inside an
// object literal stays as a closure value and needs the closure runtime.

test('method: inline arrow called as o.m(args)', () => {
  is(runFull(`
    let o = { mul: (x) => x * 2 }
    export let f = () => o.mul(5)
  `).f(), 10)
})

test('method: multiple methods on same object', () => {
  is(runFull(`
    let o = { mul: (x) => x * 2, add: (x) => x + 3 }
    export let f = () => o.mul(5) + o.add(10)
  `).f(), 23)
})

test('method: polymorphic ?: receiver — distinct schemas, shared method name', () => {
  // (w==0 ? a : b).f(5) — different OBJECT shapes (a, b have different `f`
  // closures); receiver type is unioned, dispatch resolves at runtime via the
  // schema-property closure path with per-arm aux→sid lookup.
  const { f } = runFull(`
    let a = { f: (x) => x + 1 }
    let b = { f: (x) => x * 10 }
    export let f = (w) => (w == 0 ? a : b).f(5)
  `)
  is(f(0), 6)
  is(f(1), 50)
})

test('method: dynamic key dispatch via o[k](args)', () => {
  const { f } = runFull(`
    let o = { mul: (x) => x * 2, add: (x) => x + 100 }
    export let f = (k) => o[k](5)
  `)
  is(f('mul'), 10)
  is(f('add'), 105)
})

test('method: chained call through factory return', () => {
  is(runFull(`
    let mk = () => ({ inc: (x) => x + 1 })
    export let f = () => mk().inc(5)
  `).f(), 6)
})

test('method: nested object dispatch', () => {
  is(runFull(`
    let o = { sub: { times3: (x) => x * 3 } }
    export let f = () => o.sub.times3(5)
  `).f(), 15)
})

test('method: closure captures outer state', () => {
  is(runFull(`
    let n = 7
    let o = { get: () => n, mul: (x) => x * n }
    export let f = () => o.get() + o.mul(3)
  `).f(), 28)  // 7 + 21
})

test('method: dispatch under host:wasi', () => {
  // WASI host disallows JS-side runtime imports — closure dispatch must work
  // with pure-WASM closure machinery (no host help).
  const ex = runFull(`
    let o = { mul: (x) => x * 2, add: (x) => x + 3 }
    export let calc = () => o.mul(5) + o.add(10)
  `, { jzify: true, host: 'wasi' })
  is(ex.calc(), 23)
})
