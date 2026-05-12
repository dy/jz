// Closures: capture, currying, callbacks, methods, ABI/arity, unboxing
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { MAX_CLOSURE_ARITY } from '../src/ir.js'

// Raw instantiation — proves the test path needs no host imports.
function run(code, opts) {
  const wasm = compile(code, opts)
  const mod = new WebAssembly.Module(wasm)
  return new WebAssembly.Instance(mod).exports
}

// jz() wires host imports needed by dynamic-property and full-runtime paths.
const runHost = (code, opts) => jz(code, opts).exports

const wat = (src) => jz.compile(src, { wat: true })
const fnBody = (w, name) => {
  const re = new RegExp(`\\(func \\$${name}(?:\\$exp)?(?:\\s|$)`)
  const m = w.match(re)
  return m ? w.slice(m.index, m.index + 4000) : null
}

const throws = (code, match, msg) => {
  let error
  try { compile(code) } catch (e) { error = e }
  ok(error && error.message.includes(match), `${msg}: expected "${match}", got "${error?.message}"`)
}

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

test('closure: integer const capture folds into closure body', () => {
  const src = `
    export let f = (x) => {
      const MASK = 255
      let g = y => y & MASK
      return g(x)
    }
  `
  is(runHost(src).f(511), 255)
  const body = wat(src).match(/\(func \$[^\s)]*closure[\s\S]*?^  \)/m)?.[0]
  ok(body, 'closure body present')
  ok(!/\$__env|f64\.load|local\.get \$MASK/.test(body), 'const capture should not allocate/load an env slot')
  ok(/\(i32\.const 255\)/.test(body), 'const capture should become an immediate')
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
  is(runHost(`
    let o = { mul: (x) => x * 2 }
    export let f = () => o.mul(5)
  `).f(), 10)
})

test('method: multiple methods on same object', () => {
  is(runHost(`
    let o = { mul: (x) => x * 2, add: (x) => x + 3 }
    export let f = () => o.mul(5) + o.add(10)
  `).f(), 23)
})

test('method: polymorphic ?: receiver — distinct schemas, shared method name', () => {
  // (w==0 ? a : b).f(5) — different OBJECT shapes (a, b have different `f`
  // closures); receiver type is unioned, dispatch resolves at runtime via the
  // schema-property closure path with per-arm aux→sid lookup.
  const { f } = runHost(`
    let a = { f: (x) => x + 1 }
    let b = { f: (x) => x * 10 }
    export let f = (w) => (w == 0 ? a : b).f(5)
  `)
  is(f(0), 6)
  is(f(1), 50)
})

test('method: dynamic key dispatch via o[k](args)', () => {
  const { f } = runHost(`
    let o = { mul: (x) => x * 2, add: (x) => x + 100 }
    export let f = (k) => o[k](5)
  `)
  is(f('mul'), 10)
  is(f('add'), 105)
})

test('method: chained call through factory return', () => {
  is(runHost(`
    let mk = () => ({ inc: (x) => x + 1 })
    export let f = () => mk().inc(5)
  `).f(), 6)
})

test('method: nested object dispatch', () => {
  is(runHost(`
    let o = { sub: { times3: (x) => x * 3 } }
    export let f = () => o.sub.times3(5)
  `).f(), 15)
})

test('method: closure captures outer state', () => {
  is(runHost(`
    let n = 7
    let o = { get: () => n, mul: (x) => x * n }
    export let f = () => o.get() + o.mul(3)
  `).f(), 28)  // 7 + 21
})

test('method: dispatch under host:wasi', () => {
  // WASI host disallows JS-side runtime imports — closure dispatch must work
  // with pure-WASM closure machinery (no host help).
  const ex = runHost(`
    let o = { mul: (x) => x * 2, add: (x) => x + 3 }
    export let calc = () => o.mul(5) + o.add(10)
  `, { jzify: true, host: 'wasi' })
  is(ex.calc(), 23)
})

// ============================================================================
// Closure ABI: MAX_CLOSURE_ARITY boundary, static arity errors, argc-aware rest
// ============================================================================

test('arity err: closure with 9 fixed params', () => {
  throws(
    `export let f = () => {
      let g = (a,b,c,d,e,f,g,h,i) => a
      return g(1,2,3,4,5,6,7,8,9)
    }`,
    'MAX_CLOSURE_ARITY',
    'nested closure with 9 fixed params should error'
  )
})

test('arity err: closure with 8 fixed + rest has no slot', () => {
  throws(
    `export let f = () => {
      let g = (a,b,c,d,e,f,g,h,...r) => r.length
      return g()
    }`,
    'MAX_CLOSURE_ARITY',
    'closure with 8 fixed + rest should error (rest needs free slot)'
  )
})

test('arity err: closure call with 9 args', () => {
  throws(
    `export let f = () => {
      let g = (...r) => r.length
      return g(1,2,3,4,5,6,7,8,9)
    }`,
    'MAX_CLOSURE_ARITY',
    'closure call with 9 args should error'
  )
})

test('arity err: top-level func with 9 params used as value', () => {
  throws(
    `let big = (a,b,c,d,e,f,g,h,i) => a
    let apply = (fn) => fn(1,2,3,4,5,6,7,8)
    export let f = () => apply(big)`,
    'MAX_CLOSURE_ARITY',
    'top-level func with 9 params used as value should error'
  )
})

test('arity ok: closure with 8 fixed params (boundary)', () => {
  const { f } = runHost(`export let f = () => {
    let g = (a,b,c,d,e,f,g,h) => a + b + c + d + e + f + g + h
    return g(1,2,3,4,5,6,7,8)
  }`)
  is(f(), 36)
})

test('arity ok: closure with 7 fixed + rest (boundary)', () => {
  const { f } = runHost(`export let f = () => {
    let g = (a,b,c,d,e,f,g,...r) => a + b + c + d + e + f + g + r.length
    return g(1,2,3,4,5,6,7,8)
  }`)
  is(f(), 29)  // 28 + rest.length=1
})

test('arity ok: top-level func with 8 params used as value', () => {
  const { f } = runHost(`
    let big = (a,b,c,d,e,f,g,h) => a + b + c + d + e + f + g + h
    let apply = (fn) => fn(1,2,3,4,5,6,7,8)
    export let f = () => apply(big)
  `)
  is(f(), 36)
})

// === argc-aware rest packing ===

test('rest closure: argc=0', () => {
  const { f } = runHost(`export let f = () => {
    let g = (...r) => r.length
    return g()
  }`)
  is(f(), 0)
})

test('rest closure: argc=1', () => {
  const { f } = runHost(`export let f = () => {
    let g = (...r) => r.length
    return g(42)
  }`)
  is(f(), 1)
})

test('rest closure: argc=MAX_CLOSURE_ARITY', () => {
  const { f } = runHost(`export let f = () => {
    let g = (...r) => r.length
    return g(1,2,3,4,5,6,7,8)
  }`)
  is(f(), 8)
})

test('rest closure: sum of all args', () => {
  const { f } = runHost(`export let f = () => {
    let sum = (...nums) => {
      let s = 0
      for (let i = 0; i < nums.length; i++) s += nums[i]
      return s
    }
    return sum(1,2,3,4,5,6,7,8)
  }`)
  is(f(), 36)
})

test('rest closure: fixed + rest, rest.length reflects overflow only', () => {
  const { f } = runHost(`export let f = () => {
    let g = (a, b, ...r) => a + b + r.length
    return g(10, 20, 100, 200, 300)
  }`)
  is(f(), 33)  // 10+20+3
})

test('rest closure: fixed + rest, indexing into rest', () => {
  const { f } = runHost(`export let f = () => {
    let g = (a, ...r) => a + r[0] + r[1] + r[2]
    return g(100, 1, 2, 3)
  }`)
  is(f(), 106)
})

// === Defaults via UNDEF inline-slot padding ===

test('defaults closure: omit arg → default fires', () => {
  const { f } = runHost(`export let f = () => {
    let g = (x = 42) => x
    return g()
  }`)
  is(f(), 42)
})

test('defaults closure: provide arg → overrides default', () => {
  const { f } = runHost(`export let f = () => {
    let g = (x = 42) => x
    return g(7)
  }`)
  is(f(), 7)
})

test('defaults closure: partial args, some defaults fire', () => {
  const { f } = runHost(`export let f = () => {
    let g = (a, b = 10, c = 100) => a + b + c
    return g(1)
  }`)
  is(f(), 111)
})

test('defaults closure: all args provided', () => {
  const { f } = runHost(`export let f = () => {
    let g = (a, b = 10, c = 100) => a + b + c
    return g(1, 2, 3)
  }`)
  is(f(), 6)
})

test('defaults closure: default captured from outer', () => {
  const { f } = runHost(`export let f = () => {
    let d = 99
    let g = (x = d) => x
    return g()
  }`)
  is(f(), 99)
})

// === Mixed fixed + rest + defaults ===

test('closure mixed: fixed + default + rest', () => {
  const { f } = runHost(`export let f = () => {
    let g = (a, b = 10, ...r) => a + b + r.length
    return g(1)
  }`)
  is(f(), 11)
})

test('closure mixed: fixed + default + rest with args', () => {
  const { f } = runHost(`export let f = () => {
    let g = (a, b = 10, ...r) => a + b + r.length
    return g(1, 20, 100, 200)
  }`)
  is(f(), 23)  // 1+20+2
})

// === Spread path: prebuiltArray decode into inline slots ===

test('spread into closure: small array', () => {
  const { f } = runHost(`export let f = () => {
    let g = (a, b, c) => a + b + c
    let arr = [1, 2, 3]
    return g(...arr)
  }`)
  is(f(), 6)
})

test('spread into closure: rest consumes spread', () => {
  const { f } = runHost(`export let f = () => {
    let g = (...r) => r.length
    let arr = [1, 2, 3, 4, 5]
    return g(...arr)
  }`)
  is(f(), 5)
})

test('spread into closure: mixed literal + spread', () => {
  const { f } = runHost(`export let f = () => {
    let sum = (...n) => {
      let s = 0
      for (let i = 0; i < n.length; i++) s += n[i]
      return s
    }
    let arr = [2, 3]
    return sum(1, ...arr, 4)
  }`)
  is(f(), 10)
})

// === HOF + spread combinations ===

test('HOF: callback with defaults', () => {
  const { f } = runHost(`
    let apply = (fn) => fn()
    export let f = () => {
      let g = (x = 7) => x * 2
      return apply(g)
    }
  `)
  is(f(), 14)
})

test('HOF: callback with rest receives correct count', () => {
  const { f } = runHost(`
    let apply3 = (fn) => fn(1, 2, 3)
    export let f = () => {
      let g = (...r) => r.length
      return apply3(g)
    }
  `)
  is(f(), 3)
})

test('HOF: top-level i32-param func used as value', () => {
  const { f } = runHost(`
    let twice = (n) => n * 2
    let apply = (fn, x) => fn(x)
    export let f = () => apply(twice, 21)
  `)
  is(f(), 42)
})

test('MAX_CLOSURE_ARITY exported value', () => {
  is(MAX_CLOSURE_ARITY, 8)
})

// ============================================================================
// CLOSURE local unboxing (analyzePtrUnboxable VAL.CLOSURE branch)
//
// `let g = (x) => …` with non-reassigned `g` is stored as i32 envPtr instead of
// the full f64 NaN-box. ptrAux=funcIdx is preserved on the rep so reboxing for
// escape paths (array store, pass to non-narrowed param, indirect call through
// inner helper) reconstructs the correct call_indirect target.
// ============================================================================

test('closure-unbox: direct call with capture works', () => {
  const { f } = runHost(`export let f = (n) => {
    let g = (x) => x + n
    return g(1) + g(2)
  }`)
  is(f(10), 23)
})

test('closure-unbox: passed to inner taking fn (call_indirect rebox path)', () => {
  // `h(g)` reboxes `g` to f64 for the inner closure's f64 param. Inner does
  // call_indirect on it — funcIdx must be preserved through the rebox.
  const { f } = runHost(`export let f = (n) => {
    let g = (x) => x * 2 + n
    let h = (fn) => fn(7)
    return h(g)
  }`)
  is(f(10), 24)
})

test('closure-unbox: escape via array store + indirect call', () => {
  const { f } = runHost(`export let f = (n) => {
    let g = (x) => x + n
    let arr = [g]
    return arr[0](5)
  }`)
  is(f(10), 15)
})

test('closure-unbox: escape via apply (passed across function boundary)', () => {
  const { f } = runHost(`
    export let apply = (fn, x) => fn(x)
    export let f = (n) => {
      let g = (x) => x + n
      return apply(g, 5)
    }
  `)
  is(f(10), 15)
})

test('closure-unbox: multiple unboxed closures with distinct funcIdx', () => {
  const { f } = runHost(`export let f = (n) => {
    let a = (x) => x + n
    let b = (x) => x * n
    let h = (fn, x) => fn(x)
    return h(a, 3) + h(b, 3)
  }`)
  is(f(10), 13 + 30)
})

test('closure-unbox: reassignment disqualifies', () => {
  // analyzePtrUnboxable disqualifies any name with > 0 bare `=` assignments.
  const { f } = runHost(`export let f = (n) => {
    let g = (x) => x + n
    g = (x) => x - n
    return g(5)
  }`)
  is(f(10), -5)
})

test('closure-unbox: nullish comparison disqualifies', () => {
  // `g == null` would lose the nullish NaN representation if `g` were i32.
  const { f } = runHost(`export let f = (n) => {
    let g = (x) => x + n
    if (g == null) return 0
    return g(7)
  }`)
  is(f(10), 17)
})

test('closure-unbox: captured by inner closure still works', () => {
  // Inner `h` captures `g`. Capture serialization in closure.make uses
  // asF64(emit('g')) which must rebox correctly when outer rep is i32.
  const { f } = runHost(`export let f = (n) => {
    let g = (x) => x + n
    let h = (y) => g(y) * 2
    return h(3)
  }`)
  is(f(10), 26)
})

test('closure-unbox: codegen — local declared as i32', () => {
  const w = wat(`
    export let f = (n) => {
      let g = (x) => x + n
      return g(1)
    }
  `)
  const body = fnBody(w, 'f')
  ok(body, '$f present')
  ok(/\(local \$g i32\)/.test(body), '$g declared as i32 (closure unboxed)')
  ok(!/\(local \$g f64\)/.test(body), '$g not f64')
})

test('closure-unbox: o.fn(g) — object-property closure dispatch', () => {
  const { f } = runHost(`export let f = () => {
    let g = (n) => n + 100
    let o = { fn: g }
    return o.fn(5)
  }`)
  is(f(), 105)
})

test('closure-unbox: o.fn(g) — module-level binding', () => {
  // Module-level `let g = (n) => …` is extracted via defFunc into
  // ctx.func.list (top-level function). Post-prep scan in prepare.js detects
  // top-level func names used in value positions and includeModule('fn').
  const { f } = runHost(`
    let g = (n) => n + 100
    let o = { fn: g }
    export let f = () => o.fn(5)
  `)
  is(f(), 105)
})

test('trampoline arity: closure ABI widens to a table-resident function arity', () => {
  // `pick3` (arity 3) is lifted to a top-level function and used only as a
  // first-class value; the sole indirect call passes 1 arg, so maxCall=1, and
  // a lifted def's param list is never re-observed by the arity scan (it walks
  // bodies, not param lists) so maxDef misses it too. The closure ABI width
  // must be widened by `valueUsed` arities — otherwise the boundary trampoline
  // forwards `$__a2` against a 2-param trampoline → "Unknown local $__a2" at
  // assemble time.
  const { put, run } = runHost(`
    let pick3 = (a, b, c) => a
    let store = []
    export let put = () => { store[0] = pick3 }
    export let run = (i) => store[i](42)
  `)
  put()
  is(run(0), 42)
})

test('closure-unbox: trivial closure-call program stays compact (post-watr fusedRewrite)', () => {
  // Pin the post-watrOptimize fusedRewrite pass — without it watr's inliner
  // re-introduces a rebox/unbox roundtrip across the closure-body inline
  // boundary. Threshold tracks the ≤252b figure with small headroom.
  const src = `
    let g = (x) => x + 1
    export let f = () => g(41)
  `
  const bytes = jz.compile(src).length
  ok(bytes <= 260, `closure-call probe ${bytes}b — rebox/unbox roundtrip likely re-introduced (>260b)`)
})

test('closure-unbox: no reinterpret/wrap_i64 roundtrip in inlined closure call', () => {
  // After watrOptimize inlines the closure body, the call-site
  // `asF64(local.get $g)` (rebox to f64) immediately meets the body's
  // `i32.wrap_i64 (i64.reinterpret_f64 …)` (unbox back to envPtr). The
  // post-watr fusedRewrite pass folds this — assert the WAT for $f doesn't
  // contain the surviving roundtrip pattern.
  const w = wat(`
    let g = (x) => x + 1
    export let f = () => g(41)
  `)
  const body = fnBody(w, 'f')
  ok(body, '$f present')
  ok(!/i32\.wrap_i64\s*\(\s*i64\.reinterpret_f64/.test(body),
    '$f contains wrap_i64(reinterpret_f64 …) — rebox roundtrip survived')
})
