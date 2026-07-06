// Closures: capture, currying, callbacks, methods, ABI/arity, unboxing
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, onWasi, onKernel } from './_matrix.js'
import jz, { compile } from '../index.js'
import { MAX_CLOSURE_ARITY } from '../src/ir.js'

// Raw instantiation — proves the test path needs no host imports.
function run(code, opts) {
  return jz(code, opts).exports
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
  if (onWasi()) return  // wasi: closure ABI adds $__env param / WAT check host-specific
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
  is(jz('let k = () => 7; let use = (g) => g(); export let f = () => use(k)').exports.f(), 7)
})

test('HOF: top-level function with args', async () => {
  is(jz('let add = (a, b) => a + b; let apply = (g, x, y) => g(x, y); export let f = () => apply(add, 3, 4)').exports.f(), 7)
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
  // `big` stored into an array — a genuine non-devirtualizable escape, so the
  // closure ABI is unavoidable and the arity ceiling must fire. (Passing it
  // straight to a forwarder no longer suffices: inlineHotInternalCalls inlines
  // the forwarder and the call devirtualizes to a direct `call $big`.)
  throws(
    `let big = (a,b,c,d,e,f,g,h,i) => a
    export let f = () => { let arr = [big]; return arr[0](1,2,3,4,5,6,7,8) }`,
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
// CLOSURE local unboxing (unboxablePtrs VAL.CLOSURE branch)
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
  // unboxablePtrs disqualifies any name with > 0 bare `=` assignments.
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
  // Inspect jz's pre-watr structure: `(local $g i32)` is the closure-unbox
  // decision recorded by jz; watr's coalesceLocals/inlineOnce would dissolve
  // the standalone `$g` slot into the surrounding frame.
  const w = jz.compile(`
    export let f = (n) => {
      let g = (x) => x + n
      return g(1) + g(2)
    }
  `, { wat: true, optimize: { watr: false } })
  const body = fnBody(w, 'f')
  ok(body, '$f present')
  // multi-use closure so the slot survives foldSetToTee (jz's own coalesce of single-use defs)
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
  if (belowOpt(2)) return  // size pin: the pass under test runs at optimize >= 2
  if (onWasi()) return  // wasi: size pin / wasi module larger due to extra imports
  if (onKernel()) return  // kernel: bytes path is unoptimized (no post-watr fusedRewrite); size pin assumes level-2
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

// IIFE arrow whose body is a sparse-array literal. subscript/jessie emits the
// JZ_NULL Symbol sentinel for the leading hole. When the IIFE callee is an
// arrow expression, callee dispatch indexed `ctx.core.emit[callee]` which
// stringified the array node and hit the sentinel: "Cannot convert a Symbol
// value to a string". The lookup now requires `typeof callee === 'string'`.

test('IIFE arrow returning sparse array literal materializes holes as undefined', () => {
  const { f } = runHost(`export let f = () => (p => [, ''])([1])`)
  const r = f()
  is(r.length, 2)
  is(r[0], undefined)
  is(r[1], '')
})

// Arrow whose `{}` body contains a single expression statement: per JS grammar,
// `=> {` is always a block (use `=> ({...})` for an object return), so the body
// must return `undefined`, NOT allocate an empty object. The parser may emit
// `['{}', expr]` for the body — jzify normalizes it back to a block shape
// (`['{}', [';', expr]]`) so prepare.js doesn't mistake it for an object literal.
test('arrow block body with single expression-statement returns undefined', () => {
  // Bare form covered by test262 (statement-body-requires-braces-must-return-explicitly-missing.js)
  const { f } = runHost(`
    var plusOne = v => { v + 1; }
    export let f = () => plusOne(1)
  `, { jzify: true })
  is(f(), undefined)
})

test('arrow block body inside another arrow returns undefined', () => {
  // Nested form: parser elides the `;` wrapper deeper inside; verifies the
  // jzify `=>` normalization fires across nesting depth.
  const { f } = runHost(`export let f = () => {
    var plusOne = v => { v + 1; }
    let r = plusOne(1)
    return r === undefined ? 1 : 2
  }`, { jzify: true })
  is(f(), 1)
})

// === Function-namespace scalar replacement (plan.js flattenFuncNamespaces) ===
// A user function used as a property bag — `parse.space = …; parse.step = …` —
// otherwise compiles each `f.prop` to a closure-keyed hash side-table access.
// Since the table can never be observed by the host, jz dissolves a reassigned
// slot into an f64 module global and drops a single-write only-called slot's
// dead `__dyn_set`.

// The esbuild/jessie dialect-override pattern: a property is reassigned, so the
// receiver becomes a `multiProp` dynamic object. SROA must preserve last-write
// semantics and the count side-effect.
const nsReassign = `
  let count = 0
  let parse = (s) => parse.space() + parse.step()
  parse.space = () => (count = count + 1, count)
  parse.step = () => count + 1
  parse.space = () => (count = count + 2, count)
  export let run = (n) => {
    let t = 0
    for (let i = 0; i < n; i = i + 1) t = t + parse.space() + parse.step()
    return t
  }`

test('func-namespace SROA: reassigned slot keeps last-write + side-effects', () => {
  // count: 0→2→4→6; t = (2+3)+(4+5)+(6+7) = 27.
  is(run(nsReassign).run(3), 27)
  is(run(nsReassign).run(0), 0)
  is(run(nsReassign).run(1), 5)
})

test('func-namespace SROA: dynamic property machinery is eliminated', () => {
  if (belowOpt(1)) return  // asserts SROA dissolved dyn-prop machinery — runs at optimize >= 1
  const w = wat(nsReassign)
  ok(!/__dyn_set/.test(w), 'no __dyn_set — reassigned slot dissolved to a global')
  ok(!/__dyn_get/.test(w), 'no __dyn_get — every f.prop access is a global/direct call')
})

test('func-namespace SROA: single-write only-called slot direct-calls, no table', () => {
  // `lex.next` is written once and only ever called → emit direct-calls
  // $lex$next and the dead __dyn_set write is dropped.
  const src = `
    let lex = (s) => lex.next()
    lex.next = () => 7
    export let f = () => lex.next() + lex.next()`
  is(run(src).f(), 14)
  const w = wat(src)
  ok(!/__dyn_set/.test(w), 'no __dyn_set for a single-write only-called slot')
})

test('func-namespace SROA: cross-module single-write only-called slot direct-calls, no table', () => {
  // subscript's asi.js writes `parse.enter`/`parse.exit` onto parse.js's
  // EXPORTED `parse` — the lift's name must carry parse.js's module prefix
  // (the base function's OWNING module), not asi.js's (the module that
  // TEXTUALLY contains the write). The dead-write matcher used to reconstruct
  // the expected name from the local module's own mangling, so a
  // cross-module lift never matched and both the write and every
  // `parse.enter()`/`parse.exit()` call stayed on the dyn-prop path forever —
  // exactly the hot tokenizer probes this pin catches. Two-module shape: m1
  // exports `lex` and calls its own `.next` slot; m2 (a DIFFERENT module)
  // supplies the single write.
  const code = `import { lex } from './m1.js'
import './m2.js'
export let f = () => lex('x')`
  const modules = {
    './m1.js': `export let lex = (s) => lex.next() + lex.next()`,
    './m2.js': `import { lex } from './m1.js'
lex.next = () => 7`,
  }
  is(run(code, { modules }).f(), 14)
  const w = jz.compile(code, { modules, wat: true })
  ok(!/__dyn_set/.test(w), 'no __dyn_set for a cross-module single-write only-called slot')
  ok(!/__dyn_get/.test(w), 'the call devirtualizes too — no __dyn_get left to read a dropped write')
})

test('func-namespace SROA: escaping namespace keeps the dynamic path correct', () => {
  // `api` escapes via a bare-value alias — the property table could be reached
  // through the alias, so flattening is disqualified; correctness must hold.
  const src = `
    let api = (s) => 0
    api.hit = () => 1
    api.hit = () => 2
    export let f = () => {
      let alias = api
      return alias.hit()
    }`
  is(runHost(src).f(), 2)
})

// === call_indirect devirtualization (watr/optimize devirt) ===
// `let f = c ? a : b; f(x)` — the candidate set is two closure constants, so
// each call site becomes a guarded direct-call chain with the original
// call_indirect kept as the fallback arm (zero-init/unknown flows unchanged).

test('devirt: two-candidate closure local → guarded direct calls + fallback', () => {
  const src = `
    let dbl = (x) => x * 2
    let sqr = (x) => x * x
    export let main = (n, m) => {
      let f = m > 0 ? dbl : sqr
      let s = 0
      for (let i = 0; i < n; i++) s += f(i)
      return s
    }`
  const w = jz.compile(src, { wat: true, optimize: 3 })
  // tramp names carry jz's invisible name-mangling char after `$` — match loosely
  ok(/\(call \$\S*tramp_dbl/.test(w) && /\(call \$\S*tramp_sqr/.test(w),
    'both candidates direct-called under guards')
  ok(/call_indirect/.test(w), 'original call_indirect kept as the fallback arm')
  const { main } = run(src, { optimize: 3 })
  is(main(100, 1), 9900)   // 2*Σ0..99
  is(main(100, -1), 328350) // Σi²
  is(main(0, 1), 0)
})

test('devirt: size preset stays indirect (no byte growth)', () => {
  const src = `
    let dbl = (x) => x * 2
    let sqr = (x) => x * x
    export let main = (m, x) => {
      let f = m > 0 ? dbl : sqr
      return f(x)
    }`
  const w = jz.compile(src, { wat: true, optimize: 'size' })
  ok(!/\(call \$\S*tramp/.test(w), 'size preset keeps the indirect call')
  const { main } = run(src, { optimize: 'size' })
  is(main(1, 21), 42)
  is(main(-1, 5), 25)
})

test('devirt: param-held closure is never devirtualized (unknown candidates)', () => {
  const src = `
    let add1 = (x) => x + 1
    let pass = (g, x) => g(x)
    export let main = (x) => pass(add1, x) + pass((y) => y * 3, x)`
  // pass() may inline entirely; correctness across candidate shapes is the pin.
  const { main } = run(src, { optimize: 3 })
  is(main(4), 17) // (4+1) + (4*3)
})

// ---- nullable mark across captures ------------------------------------------
// A capture whose parent binding can hold null (`let x = null` later assigned a
// number) must keep its nullable mark inside the closure body — the body's own
// write facts (val NUMBER) would otherwise fold `x == null` to constant false
// and skip the guard. Found via the self-host kernel: _offsetLocalStride's
// `stride == null` first-write guard never fired in a recursive walker, killing
// every offset-tee memory.copy recognition in jz.wasm.

test('capture nullable: null-compare guard survives recursive closure writes', () => {
  const r = run(`
    export let go = () => {
      let stride = null, ok = true
      function walk(n, d) {
        if (d > 0) walk(n, d - 1)
        if (d === 0) {
          if (stride == null) stride = 3
          else if (stride !== 3) ok = false
        }
      }
      walk(0, 1)
      return (stride === 3 ? 10 : 0) + (ok ? 1 : 0)
    }
  `)
  is(r.go(), 11)
})

test('capture nullable: strict ===null guard inside plain closure', () => {
  const r = run(`
    export let go = () => {
      let x = null
      function set(v) { if (x === null) x = v }
      set(7)
      set(9)
      return x
    }
  `)
  is(r.go(), 7)
})

// ── IIFE lambda-lifting (liftIIFEs) ──────────────────────────────────────────────────
// `(params => body)(args)` is hoisted to a top-level function with its free variables
// appended as params and replaced by a DIRECT call — so it never rides the f64-only
// closure ABI (SIMD flows through) and pays no closure alloc/indirect call. Capture is
// by value, exact for a synchronous immediate invocation. inlineOnce then folds the
// single-caller body back in. A capture that's MUTATED in the body can't lift (no
// write-back) and stays on the closure path — still correct.
test('IIFE lift: capture-by-value, params, nesting — direct call, no closure table', () => {
  is(runHost('export let f = (a) => (() => a * 2.0 + 1.0)()').f(5), 11, 'captures enclosing a by value')
  is(runHost('export let f = (a) => ((x) => x + a)(10.0)').f(7), 17, 'own param + capture')
  is(runHost('export let f = (a) => (() => (() => a * 3.0)() + 1.0)()').f(2), 7, 'nested IIFE')
  is(runHost('let g = 100.0\nexport let f = () => (() => g + 5.0)()').f(), 105, 'module global stays a global ref, not a capture')
  // A liftable IIFE leaves no closure scaffolding: the lift → direct call → inlineOnce
  // collapses it, so no call_indirect / table-backed closure survives.
  if (!onKernel() && !belowOpt(2))
    ok(!/call_indirect/.test(wat('export let f = (a) => (() => a * 2.0)()')), 'lifted IIFE emits no call_indirect')
})

test('IIFE lift: a mutated capture bails to the closure path, stays correct', () => {
  // x is reassigned inside the IIFE; lifting (by-value param) would lose the write-back,
  // so the lift bails and the closure cell carries it — the visible value is still right.
  is(runHost('export let f = (a) => { let x = a; let y = (() => { x = x + 10.0; return x * 2.0 })(); return x + y }').f(5), 45, 'mutated-capture IIFE: x=15, y=30 → 45')
})

// Identifiers named like Object.prototype members must resolve as ordinary variables.
// The compiler keyed several resolution dictionaries (CONSTANTS, F64_CONSTANTS,
// REJECT_IDENTS, GLOBALS, the scope chain) on the identifier name with PLAIN objects.
// In V8, `{}` inherits Object.prototype, so `'valueOf' in CONSTANTS` was true and
// `CONSTANTS['valueOf']` returned the inherited method — `let valueOf = 5` resolved to a
// boxed function (emitted 0) and `valueOf = …` errored "Assignment to non-variable".
// jz.js-ONLY: the self-host kernel's jz objects are prototype-less, so the kernel compiled
// these correctly all along (the bug only bit the compiler running in V8). Fixed by making
// the dictionaries prototype-less (Object.create(null)).
test('identifiers named like Object methods resolve as plain variables (proto-less dicts)', () => {
  for (const n of ['valueOf', 'toString', 'hasOwnProperty', 'constructor', 'isPrototypeOf', 'propertyIsEnumerable']) {
    is(run(`export let main = () => { let ${n} = 5; return ${n} }`).main(), 5, `let ${n}`)
    is(run(`export let main = () => { let ${n} = 5; ${n} = ${n} + 2; return ${n} }`).main(), 7, `reassign ${n}`)
    is(run(`let f = (${n}) => ${n} + 1; export let main = () => f(41)`).main(), 42, `param ${n}`)
    is(run(`export let main = () => { let ${n} = 0; for (let i=0;i<5;i++) ${n} = ${n} + i; return ${n} }`).main(), 10, `loop ${n}`)
  }
  is(run('let valueOf = 7; export let main = () => valueOf').main(), 7, 'module-level valueOf')
  is(run('export let valueOf = () => 9; export let main = () => valueOf()').main(), 9, 'export named valueOf')
  is(run('export let main = () => { let toString = 3; { let x = toString + 1; return x } }').main(), 4, 'nested-scope toString')
  is(run('export let main = () => { let o = {valueOf: 5, x: 2}; return o.valueOf + o.x }').main(), 7, 'object property valueOf unaffected')
})

// A write to a captured variable FROM INSIDE the closure body did not join the
// shared cell's type. If every outer-visible value was integer (`let env = 0`),
// the cell stayed i32 and closure-side f64 stores truncated silently: `env = 1.5`
// read back 1; a one-pole accumulator `env = c*env + (1-c)*x` collapsed to 0
// forever. Outer-side float writes DID widen (`let n = 0; fn; n = 0.5` was fine) —
// only closure-body writes were missing from the join.
//
// ROOT CAUSE — the SAME "stops at `=>`" blind spot in THREE independent places,
// all now fixed together (they share the shape, not just the symptom):
//   1. src/type.js collectIntDefs (the intCertainMap fixpoint): its body walker
//      returned immediately on any `=>` node, so a captured name's ONLY visible
//      "definition" was its outer declaration — the closure-body reassignment
//      never contradicted it, so intCertain stayed (wrongly) true forever.
//   2. src/compile/index.js's closure-capture narrowing consumed that same
//      intCertain to decide the boxed CELL's storage width (i32 vs f64) —
//      inherited the blind spot.
//   3. src/compile/analyze.js's widenLocalTypes (the general i32→f64 local-
//      width fixpoint, feeding narrowI32Results' decision on the ENCLOSING
//      FUNCTION's own wasm result type) had the identical `=>`-skip in its own
//      body walker — so even once (1)/(2) were fixed and the cell itself read/
//      wrote as genuine f64, `env`'s reported LOCAL type stayed i32, and
//      `return env` narrowed the whole function to i32, truncating at the
//      return site instead of the cell.
// Fix: collectIntDefs/intCertainMap gained an opt-in `capturedNames` mode that
// also folds in defs found inside nested arrows (used only by the boxed-cell
// narrowing call site — every other caller is unaffected); widenLocalTypes
// computes the same "reassigned somewhere, maybe inside an arrow" name set via
// findMutations (already `=>`-transparent) and threads it through its own two
// widening walks the same way. Live instance: dynamics-processor envelope.js
// (`let env = 0; return (x) => { env = c*env + (1-c)*mag; … }`) — every
// envelope-based processor (compressor, limiter, deesser, ducker, compand)
// compiled clean and ran as a silent passthrough.
test('closure: f64 write from closure body widens an int-initialized captured cell', () => {
  const { f } = run(`export let f = () => {
    let env = 0
    let set = () => { env = 1.5 }
    set()
    return env
  }`)
  is(f(), 1.5)
})

test('closure: one-pole accumulator in returned closure (envelope follower)', () => {
  const { f } = run(`
    let follower = (c) => {
      let env = 0
      return (x) => env = c * env + (1 - c) * x
    }
    export let f = () => {
      let g = follower(0.9)
      let last = 0
      for (let i = 0; i < 100; i++) last = g(0.5)
      return last
    }`)
  ok(Math.abs(f() - 0.49998671930055616) < 1e-12, `expected ≈0.5, got ${f()}`)
})
