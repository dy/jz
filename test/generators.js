// Generators (Ring 1 pivot, extension-surface plan): regenerator-style state
// machines — no stack suspension. `function*` lowers to a factory arrow whose
// body is a dispatch loop over hoisted locals; `{ next, return }` are ordinary
// closures over that state (mutable captures). for-of over a KNOWN generator
// call desugars to while-next (inside AND outside generator bodies). Sync only.
// v1 rejects (precise messages): yield in arbitrary expressions, yield inside
// for-of/for-in bodies over values not known to be generators.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { oracle, batch } from './util.js'

const j = (code) => jz(code).exports.f()

// Every export of `source` answers what Node answers, at each level.
const agreeAll = (source) => {
  const expected = oracle(source)
  for (const optimize of [0, 2, 3, 'size']) {
    const actual = jz(source, { optimize }).exports
    for (const name of Object.keys(expected))
      if (typeof expected[name] === 'function') is(actual[name](), expected[name](), `${name}, level ${optimize}`)
  }
}

// Several standalone arrows as one compile, each called once.
const jMany = (arrows) => batch(arrows).map(f => f())

test('generators: nested array literals preserve holes and spread evaluation order', () => {
  const source = `function* values(n) { for (let i = 0; i < n; i++) yield i * 2 }
    export function f(n) {
      let order = ''
      const mark = x => { order += x; return x }
      const items = [mark('a'), [mark('b'), ...values(n), , [mark('c')]], mark('d')]
      return [JSON.stringify(items), order]
    }`
  const expected = Function(source.replace('export ', '') + '; return f')()
  for (const optimize of [0, 2, 3, 'size']) {
    const { f } = jz(source, { optimize }).exports
    for (const n of [0, 1, 1, 4, 0]) is(f(n), expected(n), `level ${optimize}, count ${n}`)
  }
})

test('generators: nested literal factories keep independent captures and close after errors', () => {
  const source = `export function f(n, fail) {
    let order = ''
    const factories = [0, [function* () {
      order += 'a'
      const sent = yield n
      order += 'b'
      if (fail) throw sent
      return sent + 1
    }, , function* () {
      order += 'c'
      yield n + 2
      return n + 3
    }], []]
    const a = factories[1][0](), b = factories[1][2]()
    const before = order, first = a.next(), second = b.next()
    const out = [before, first.value, first.done, second.value, second.done, order]
    try { const last = a.next(7); out.push(last.value, last.done) }
    catch (e) { out.push(e, 'caught') }
    const closed = a.next(), last = b.next()
    out.push(closed.value, closed.done, last.value, last.done, order,
      factories[1].length, factories[1][1] === undefined, factories[2].length)
    return out
  }`
  const expected = oracle(source)
  for (const optimize of [0, 2, 3, 'size']) {
    const actual = jz(source, { optimize }).exports
    for (const args of [[0, 0], [0, 0], [4, 1], [-3, 0], [0, 1], [0, 0]])
      is(actual.f(...args), expected.f(...args), `level ${optimize}, ${args}`)
  }
})

test('generators: defaults and body vars have separate environments', () => {
  const { f } = jz(`export function f() {
    var x = 'outside', params, body
    function* g(_ = params = function() { return x }) {
      var x = 'inside'
      body = function() { return x }
      yield x
    }
    const it = g()
    const before = params()
    const first = it.next()
    const last = it.next()
    return [before, params(), body(), first.value, last.done, x]
  }`).exports
  for (let i = 0; i < 2; i++) is(f(), ['outside', 'outside', 'inside', 'inside', true, 'outside'])
})

test('generators: manual next() protocol + return value', () => {
  is(j(`function* g(n) { let i = 0; while (i < n) { yield i; i++ } return -1 }
        export let f = () => { let it = g(3); let r = ''; let s = it.next(); while (!s.done) { r += s.value; s = it.next() } return r + '|' + s.value }`),
    '012|-1')
})

test('generators: two-way — next(v) delivers the sent value', () => {
  is(j(`function* echo() { let got = yield 1; let got2 = yield got * 2; return got2 + 100 }
        export let f = () => { let it = echo(); let a = it.next().value; let b = it.next(5).value; let c = it.next(7).value; return '' + a + ',' + b + ',' + c }`),
    '1,10,107')
})

test('generators: for-of consumption (C-style loop machine)', () => {
  is(j(`function* g(n) { for (let i = 0; i < n; i++) yield i * 10 }
        export let f = () => { let s = 0; for (const x of g(4)) s += x; return s }`), 60)
})

test('generators: if/else state split', () => {
  is(j(`function* g(c) { if (c) { yield 'a'; yield 'b' } else yield 'z'; yield 'end' }
        export let f = () => { let r = ''; for (const x of g(1)) r += x; for (const x of g(0)) r += '|' + x; return r }`),
    'abend|z|end')
})

test('generators: break/continue of a decomposed loop', () => {
  is(j(`function* g() { for (let i = 0; i < 10; i++) { if (i % 2) continue; if (i > 5) break; yield i } }
        export let f = () => { let r = ''; for (const x of g()) r += x; return r }`), '024')
})

test('generators: do-while machine + inner loops stay atomic', () => {
  is(j(`function* g() { let i = 0; do { yield i; i++ } while (i < 3) }
        export let f = () => { let r = ''; for (const v of g()) r += v; return r }`), '012')
  is(j(`function* g() { for (let i = 0; i < 2; i++) { let s = 0; for (let jj = 0; jj < 9; jj++) { if (jj > 2) break; s += jj } yield s } }
        export let f = () => { let r = ''; for (const v of g()) r += v + ','; return r }`), '3,3,')
})

test('generators: independent instances', () => {
  is(j(`function* g() { let i = 0; while (i < 3) { yield i; i++ } }
        export let f = () => { let a = g(), b = g(); return '' + a.next().value + b.next().value + a.next().value + b.next().value }`),
    '0011')
})

test('generators: return() closes the machine', () => {
  is(j(`function* g() { yield 1; yield 2 }
        export let f = () => { let it = g(); it.next(); let r = it.return(9); return '' + r.value + ',' + (r.done ? 1 : 0) + ',' + (it.next().done ? 1 : 0) }`),
    '9,1,1')
})

test('generators: expression form + nested generator for-of', () => {
  is(j(`let g = function* () { yield 7 }; export let f = () => g().next().value`), 7)
  is(j(`function* inner() { yield 1; yield 2 }
        function* outer() { yield 0; for (const v of inner()) yield v * 10 }
        export let f = () => { let r = ''; for (const x of outer()) r += x + ','; return r }`),
    '0,10,20,')
})

test('generators: v1 rejections are precise', () => {
  const rejects = (src, needle) => {
    let e; try { jz.compile(src) } catch (x) { e = x }
    ok(e && e.message.includes(needle), `${needle}: got ${e?.message?.slice(0, 90)}`)
  }
  rejects(`export let f = () => { let y = yield 1; return y }`, 'yield outside a generator')
  // a yield as an operand stands in parentheses (ECMA-262 YieldExpression is an AssignmentExpression)
  rejects(`function* g() { void yield } export let f = () => 1`, 'must stand in parentheses')
  rejects(`function* g() { const x = 3 + yield 4 } export let f = () => 1`, 'must stand in parentheses')
  rejects(`function* g() { yield\n* 1 } export let f = () => 1`, 'must stand in parentheses')
  // an async function is no generator: a yield in it, a pattern's default too, is no suspension
  rejects(`async function h() { for await ([x = yield] of [[]]) {} } export let f = () => 1`, 'yield outside a generator body')
  // a parenthesized comma expression is no array pattern element
  rejects(`let x, y; function h() { [(x, y)] = [[]] } export let f = () => 1`, 'invalid destructuring target')
})

// try/catch across a yield: the try body's states carry the catch state as
// their handler; a throw raised in the body after a resume, or injected by
// throw() at the suspension point, lands in the catch; a finally without a
// yield runs on both paths; states outside any region close the machine.
test('generators: try/catch across a yield', () => {
  const run = (src) => jz(src, { jzify: true }).exports.f()
  is(run(`function* g() { let log = 0; try { log = log*10+1; const x = yield 1; log = log*10+2; if (x > 0) throw 7; log = log*10+3 } catch (e) { log = log*10+9 } return log*10+4 }
    export let f = () => { const it = g(); it.next(); return it.next(5).value }`), 1294)
  is(run(`function* g() { let log = 0; try { log = log*10+1; yield 1; log = log*10+2 } catch (e) { log = log*10+e } return log*10+4 }
    export let f = () => { const it = g(); it.next(); return it.throw(9).value }`), 194)
  is(run(`function* g() { let log = 0; try { yield 1; log = log*10+2 } finally { log = log*10+5 } return log }
    export let f = () => { const it = g(); it.next(); return it.next().value }`), 25)
  // destructuring declarations bind through a temp (object keys, renames,
  // defaults, array holes and rest, nested), across yields and in one state
  is(run(`function* g() { let [p, , q = 4, ...r] = [1, 2]; yield p; const { z, w: v } = { z: q * 5, w: r.length }; yield z + v }
    export let f = () => { const it = g(); return it.next().value * 100 + it.next().value }`), 120)
  // no handler at the suspension point: throw() rethrows and closes
  is(run(`function* g() { yield 1; yield 2 }
    export let f = () => { const it = g(); it.next(); let got = 0; try { it.throw(3) } catch (e) { got = e } return got * 10 + (it.next().done ? 1 : 0) }`), 31)
})

// ES2025 iterator helpers as FUSED loops: a chain rooted at a known generator
// call — g().map(f).filter(p).take(n)… — compiles to ONE while-next loop with
// the stages composed in place (no intermediate iterator objects). Terminals
// (toArray/reduce/forEach/some/every/find) fuse in expression position.
test('iterator helpers: stage fusion in for-of', () => {
  is(j(`function* g(n) { for (let i = 0; i < n; i++) yield i }
        export let f = () => { let s = ''; for (const v of g(8).map((x) => x * 10).filter((x) => x % 20 === 0)) s += v + ','; return s }`),
    '0,20,40,60,')
  is(j(`function* nat() { let i = 0; while (1) { yield i; i++ } }
        export let f = () => { let s = ''; for (const v of nat().drop(3).take(4)) s += v; return s }`),
    '3456')  // take() also terminates the INFINITE source
})

test('iterator helpers: terminals fuse in expression position', () => {
  is(j(`function* g() { yield 3; yield 1; yield 2 }
        export let f = () => g().map((x) => x + 1).toArray().join('-')`), '4-2-3')
  is(j(`function* g(n) { for (let i = 1; i <= n; i++) yield i }
        export let f = () => g(5).reduce((a, b) => a + b, 100)`), 115)
  is(j(`function* g() { yield 1; yield 5; yield 9 }
        export let f = () => '' + (g().some((x) => x > 8) ? 1 : 0) + (g().every((x) => x > 0) ? 1 : 0) + g().find((x) => x > 3)`),
    '115')
})

test('for-of desugar: user continue advances the iterator (pull-at-top)', () => {
  is(j(`function* g() { for (let i = 0; i < 6; i++) yield i }
        export let f = () => { let s = ''; for (const v of g()) { if (v % 2) continue; s += v } return s }`),
    '024')
})

// yield* delegates to ANY iterator-protocol value: yields pass through, sent
// values thread into the delegate, and the delegate's COMPLETION value is the
// yield* result (`let done = yield* inner()`).
test('generators: yield* delegation', () => {
  is(j(`function* inner() { yield 1; yield 2; return 9 }
        function* outer() { yield 0; let done = yield* inner(); yield done }
        export let f = () => { let r = ''; for (const v of outer()) r += v + ','; return r }`),
    '0,1,2,9,')
  is(j(`function* inner() { let a = yield 'i1'; yield 'got:' + a }
        function* outer() { yield* inner() }
        export let f = () => { let it = outer(); let r = it.next().value; let r2 = it.next(42).value; return r + '|' + r2 }`),
    'i1|got:42')
})

test('generators: spread fuses to toArray', () => {
  is(j(`function* g() { yield 3; yield 1 } export let f = () => [...g()].join('-')`), '3-1')
  is(j(`function* g(n) { for (let i = 0; i < n; i++) yield i }
        export let f = () => [...g(6).filter((x) => x % 2), 99].join(',')`), '1,3,5,99')
  is(j(`function* g() { yield 7 } export let f = () => [0, ...g(), 1].join('')`), '071')
})

// throw(v): no try may span a yield (v1 rejects it), so an injected exception
// is always unhandled by spec — the machine closes, the throw is catchable at
// the caller of throw().
test('generators: throw() closes the machine and rethrows', () => {
  is(j(`function* g() { yield 1; yield 2 }
        export let f = () => { let it = g(); it.next(); let caught = 0; try { it.throw('boom') } catch (e) { caught = 1 } return '' + caught + (it.next().done ? 1 : 0) }`),
    '11')
})

// Generator METHODS (subscript 10.6 grammar): { *g() {} } / class { *m() {} } /
// static *s() {} — the member value is a function* expression riding the same
// lowering. `this` binds to the instance (renamed like any method).
test('generators: methods in classes and object literals', () => {
  is(j(`class A { *g(n) { for (let i = 0; i < n; i++) yield i } }
        export let f = () => { let r = ''; for (const v of new A().g(4)) r += v; return r }`), '0123')
  is(j(`class C { constructor(b) { this.b = b } *g() { yield this.b; yield this.b + 1 } }
        export let f = () => { let it = new C(7).g(); return '' + it.next().value + it.next().value }`), '78')
  is(j(`class A { static *r(n) { for (let i = 0; i < n; i++) yield i * 2 } }
        export let f = () => { let r = ''; for (const v of A.r(3)) r += v; return r }`), '024')
  is(j(`let o = { *g(n) { yield n; yield n * 10 } }
        export let f = () => { let r = ''; for (const v of o.g(3)) r += v + ','; return r }`), '3,30,')
})

// Iterator protocol for VALUES: for-of over a stored machine, a method-call
// result, a hand-rolled { next }, or an object with *[Symbol.iterator]().
// The fork probes once per loop and drives next() lazily — break stops an
// infinite source; programs without iterator producers keep the plain
// indexed desugar (byte-identical).
test('iterator protocol: for-of over iterator values', () => {
  is(j(`function* g(n) { for (let i = 0; i < n; i++) yield i * 2 }
        export let f = () => { let it = g(3), r = ''; for (const v of it) r += v + ','; return r }`), '0,2,4,')
  is(j(`let mk = (n) => { let i = 0; return { next: () => ({ done: i >= n, value: i++ }) } }
        export let f = () => { let r = ''; for (const v of mk(3)) r += v; return r }`), '012')
  is(j(`class R { constructor(n) { this.n = n } *[Symbol.iterator]() { for (let i = 0; i < this.n; i++) yield i } }
        export let f = () => { let r = ''; for (const v of new R(4)) r += v; return r }`), '0123')
  // break stays lazy — an infinite stored iterator terminates
  is(j(`function* nat() { let i = 0; while (1) { yield i; i++ } }
        export let f = () => { let it = nat(), r = ''; for (const v of it) { if (v > 2) break; r += v } return r }`), '012')
  // continue advances (pull-at-top), arrays in the same program stay indexed
  is(j(`function* g() { yield 1 }
        export let f = () => { let s = 0; for (const v of [1, 2, 3]) s += v; let r = ''; for (const v of g()) { if (v > 9) continue; r += v } return s + r }`), '61')
})

// `using` (ERM, subscript 10.6): scope-exit disposal via [Symbol.dispose] —
// try/finally lowering, LIFO for multiple resources, null skipped, non-
// disposable throws at binding. Divergence: no SuppressedError aggregation.
test('using: scope-exit disposal', () => {
  is(j(`let log = ''
        let open = (t) => ({ [Symbol.dispose]: () => { log += 'd' + t } })
        export let f = () => { { using a = open(1), b = open(2); log += 'x' }; return log }`), 'xd2d1')
  is(j(`let log = ''
        let open = () => ({ [Symbol.dispose]: () => { log += 'd' } })
        export let f = () => { try { using a = open(); log += 'b'; throw 'boom' } catch (e) { log += 'c' } return log }`), 'bdc')
  // Both bodies are self-contained (no module-level state, no shared names) —
  // batched into one compile even though they're not textually adjacent.
  const [okVal, threw] = jMany([
    `() => { using a = null; return 'ok' }`,
    `() => { try { using a = { x: 1 }; return 'no' } catch (e) { return e instanceof TypeError && e.message.includes('dispose') ? 'threw' : e } }`,
  ])
  is(okVal, 'ok')
  is(j(`let log = ''
        let open = () => ({ [Symbol.dispose]: () => { log += 'd' } })
        let g = () => { using a = open(); log += 'b'; return 9 }
        export let f = () => '' + g() + log`), '9bd')
  is(threw, 'threw')
  // The method is read once, at binding, and called on the resource.
  is(j(`let reads = 0, log = ''
        let open = () => ({ get [Symbol.dispose]() { reads++; return () => { log += 'd' } } })
        export let f = () => { { using a = open(); log += 'b' } return log + reads }`), 'bd1')
  is(j(`let log = ''
        let open = (n) => ({ n, [Symbol.dispose]() { log += this.n } })
        export let f = () => { { using a = open(4), b = open(5); log += 'b' } return log }`), 'b54')
  is(j(`export let f = () => { try { using a = { [Symbol.dispose]: 1 }; return 'no' } catch (e) { return e instanceof TypeError ? 'threw' : e } }`), 'threw')
})

test('using: classic for initializer is disposed on every exit', () => {
  const { f } = jz(`export function f(mode) {
    let log = '', i = 0
    const open = n => {
      log += 'o' + n
      if (mode === 4 && n === 2) throw 'init'
      return { [Symbol.dispose]: () => { log += 'd' + n } }
    }
    try {
      for (using a = open(1), b = open(2); i < (mode === 0 ? 0 : 2); i++) {
        log += 'b'
        if (mode === 2) break
        if (mode === 3) throw 'body'
      }
    } catch (e) { log += 'c' + e }
    return log
  }`).exports
  for (const [mode, expected] of [[0, 'o1o2d2d1'], [1, 'o1o2bbd2d1'], [2, 'o1o2bd2d1'],
    [3, 'o1o2bd2d1cbody'], [4, 'o1o2d1cinit'], [0, 'o1o2d2d1']]) is(f(mode), expected)
})

// Spread of iterator VALUES: __drain normalizes at the site (pass-through for
// arrays/strings; materializes machines and @@iterator providers) — injected
// only in iterator-minting programs.
test('iterator protocol: spread of iterator values', () => {
  is(j(`function* g(n) { for (let i = 0; i < n; i++) yield i }
        export let f = () => { let it = g(3); return [...it].join('-') }`), '0-1-2')
  is(j(`function* g() { yield 1; yield 2 }
        let sum = (...xs) => { let s = 0; for (const x of xs) s += x; return s }
        export let f = () => sum(...g(), 10)`), 13)
  is(j(`class R { *[Symbol.iterator]() { yield 7; yield 8 } }
        export let f = () => [...new R()].join('')`), '78')
  is(j(`function* g() { yield 3 }
        export let f = () => { let a = [1, 2]; return [...a, ...g()].join('') }`), '123')
})

// Iterator helpers on iterator VALUES (ES2025): a helper-using program mints
// generator objects through __it_mk — map/filter/take/drop/flatMap and the
// terminals become value-position methods (lazy, value+counter callbacks,
// early return() on short-circuit), Symbol.iterator returns self, and
// `instanceof Iterator` is the callable-next shape probe. Fusable chains
// still fuse; helper-free programs mint the bare record (pay-per-use).
test('iterator helpers: value-position chains', () => {
  is(j(`function* g() { yield 1; yield 2; yield 3 }
        export let f = () => {
          let it = g().map((x) => x * 10)
          return it.next().value + '|' + it.next().value
        }`), '10|20')
  is(j(`function* nat() { let n = 0; while (true) { yield n; n++ } }
        export let f = () => {
          let evens = nat().filter((x) => x % 2 === 0)
          return evens.take(5).toArray().join(',')
        }`), '0,2,4,6,8')
  is(j(`function* g() { yield 1; yield 2; yield 3 }
        export let f = () => g().drop(1).flatMap((x) => [x, x * 100]).toArray().join(',')`), '2,200,3,300')
})

test('iterator helpers: spec callbacks and terminals', () => {
  is(j(`function* g() { yield 'a'; yield 'b' }
        export let f = () => g().map((x, i) => x + i).toArray().join(',')`), 'a0,b1')
  is(j(`function* g() { yield 2; yield 4; yield 6 }
        export let f = () => '' + g().reduce((a, b) => a + b) + '|' + g().find((x) => x > 3) +
          '|' + g().some((x) => x > 5) + '|' + g().every((x) => x % 2 === 0)`), '12|4|true|true')
  is(j(`function* g() { yield 1 }
        export let f = () => { try { g().take(-1); return 'no' } catch (e) { return e.includes('RangeError') ? 'range' : e } }`), 'range')
})

test('iterator helpers: instanceof Iterator, protocol interplay', () => {
  is(j(`function* g() { yield 1 }
        export let f = () => '' + (g() instanceof Iterator) + (g().map((x) => x) instanceof Iterator) +
          ([1, 2] instanceof Iterator) + (5 instanceof Iterator)`), 'truetruefalsefalse')
  is(j(`function* g() { yield 1; yield 2; yield 3 }
        export let f = () => {
          let s = 0
          for (const v of g().map((x) => x * 2)) s += v
          let it = g().map((x) => x + 1)
          for (const v of it) s += v
          return s
        }`), 21)
  is(j(`function* g() { yield 1; yield 2 }
        export let f = () => [...g().map((x) => x * 3)].join('-')`), '3-6')
})

test('generator arguments ownership: outer function is not rest-lowered for a nested generator', () => {
  // usesArguments walked THROUGH `function*` — an outer function containing an
  // arguments-using generator was itself rest-param-lowered, and the
  // generator's arguments-writes aliased the outer (empty) rest array → OOB
  // (test262 yield/formal-parameters-after-reassignment-strict).
  const { exports } = jz(`export let _run = () => {
    function* g(a, b, c, d) { arguments[0] = 32; yield a; yield b }
    var iter = g(23, 45, 33)
    var result
    result = iter.next()
    return result.value
  }`, { jzify: true })
  is(exports._run(), 23)
})

test('generators: shadowed locals rename apart before hoisting (sibling loops, if arms, catch, closures)', () => {
  is(j(`function* g(n) { for (let i = 0; i < n; i++) yield i; for (let i = 0; i < n; i++) yield i * 10; let w = (e) => e + w.k; w.k = 5; yield w(1) } export let f = () => [...g(2)].join(',')`), '0,1,0,10,6')
  is(j(`function* g() { let s = 0; if (s === 0) { let i = 100; s += i } else { let i = 200; s += i } const fns = []; for (const i of [1, 2]) fns.push(() => i); for (let i = 0; i < 2; i++) s += fns[i](); const { i } = { i: 1000 }; yield s + i } export let f = () => [...g()][0]`), 100 + 3 + 1000)
})

test('generators: finally runs once on normal, injected and caught exceptions', () => {
  for (const source of [
    `let log = ''; function* g() { try { yield 1; log += 'B' } finally { log += 'F' } }
     export function f() { const it = g(); it.next(); it.next(); return log }`,
    `let log = ''; function* g() { try { yield 1 } finally { log += 'F' } }
     export function f() { const it = g(); it.next(); try { it.throw('E') } catch(e) { log += e }; return log }`,
    `let log = ''; function* g() { try { yield 1 } catch(e) { log += e; throw 'C' } finally { log += 'F' } }
     export function f() { const it = g(); it.next(); try { it.throw('E') } catch(e) { log += e }; return log }`,
    `function* g() { try { yield 1 } finally { return 42 } }
     export function f() { const it = g(); it.next(); const r = it.throw('E'); return r.value + ':' + r.done }`,
    `function bad() { throw 'R' } function* g() { try { try { yield 1 } finally { return bad() } } catch(e) { return e } }
     export function f() { const it = g(); it.next(); return it.throw('E').value }`,
    `let log = ''; function* g() { try { try { yield 1 } finally { log += 'I'; throw 'F' } } finally { log += 'O' } }
     export function f() { const it = g(); it.next(); try { it.throw('E') } catch(e) { log += e }; return log }`,
  ]) {
    const expected = oracle(source).f()
    is(j(source), expected)
  }
})

// A completion leaving a try runs its finally blocks, innermost first: a
// return(), a return statement, a break or continue. return() at a yield* asks
// the delegate first; a finally can yield or override the pending completion.
test('generators: return() and every completion leaving a try run its finally blocks', () => agreeAll(`let log = ''
  function* g() { try { yield 1; yield 2 } finally { log += 'F' } }
  function* nested() { try { try { yield 1 } finally { log += 'a' } } finally { log += 'b' } }
  function* yields() { try { yield 1 } finally { yield 2; log += 'f' } }
  function* own() { try { yield 1 } finally { return 'own' } }
  function* inner() { try { yield 'a'; yield 'b' } finally { log += 'I' } }
  function* delegating() { try { yield* inner() } finally { log += 'D' } }
  function* stubborn() { try { yield 1 } finally { yield 'again' } }
  function* resumed() { yield* stubborn(); log += 'after' }
  function* jumps() { for (let i = 0; i < 3; i++) { try { if (i === 1) continue; if (i === 2) break; yield i } finally { log += i } } try { return 'r' } finally { log += 'R' } }
  const show = (r) => r.value + ':' + r.done + ','
  export let manual = () => { log = ''; const it = g(); it.next(); return show(it.return(7)) + show(it.next()) + log }
  export let unstarted = () => { log = ''; const it = g(); return show(it.return(7)) + show(it.next()) + log }
  export let pattern = () => { log = ''; const [a] = g(); return a + log }
  export let order = () => { log = ''; const it = nested(); it.next(); return show(it.return(5)) + log }
  export let yielding = () => { log = ''; const it = yields(); it.next(); return show(it.return(9)) + show(it.next()) + show(it.next()) + log }
  export let overriding = () => { log = ''; const it = own(); it.next(); return show(it.return(9)) }
  export let delegated = () => { log = ''; const it = delegating(); it.next(); return show(it.return(4)) + log }
  export let delegateYields = () => { log = ''; const it = resumed(); it.next(); return show(it.return(3)) + show(it.next()) + log }
  export let jumping = () => { log = ''; const it = jumps(); return show(it.next()) + show(it.next()) + log }`))

// throw() at a yield* goes to the delegate's throw(): its catch can answer,
// and a done result ends the yield* with its value. A delegate with no
// throw() is closed and the yield* throws a TypeError; an array's iterator
// has neither throw() nor return().
test('generators: yield* forwards throw() to its delegate', () => agreeAll(`let log = ''
  const show = (r) => r.value + ':' + r.done + ','
  function* inner() { try { yield 'a'; yield 'b' } catch (e) { log += 'c' + e; yield 'h'; return 'r' } finally { log += 'I' } }
  function* outer() { const v = yield* inner(); log += 'v' + v; yield 'z' }
  function* quick() { try { yield 'a' } catch (e) { return 'q' + e } }
  function* ends() { const v = yield* quick(); yield 'v' + v }
  const own = () => ({ i: 0, next() { this.i++; return { value: this.i, done: this.i > 3 } }, return() { log += 'R'; return {} }, [Symbol.iterator]() { return this } })
  function* viaOwn() { try { yield* own() } catch (e) { log += e instanceof TypeError ? 'T' : 'x'; yield 'p' } }
  function* viaArray() { try { yield* [1, 2] } catch (e) { log += e instanceof TypeError ? 'T' : 'x' } }
  function* viaNumber() { try { yield* { next() { return 5 }, [Symbol.iterator]() { return this } } } catch (e) { log += e instanceof TypeError ? 'T' : 'x' } }
  export let forwarded = () => { log = ''; const it = outer(); it.next(); return show(it.throw('X')) + show(it.next()) + show(it.next()) + log }
  export let done = () => { const it = ends(); it.next(); return show(it.throw('X')) + show(it.next()) }
  export let missing = () => { log = ''; const it = viaOwn(); it.next(); return show(it.throw('Z')) + log }
  export let array = () => { log = ''; const it = viaArray(); it.next(); return show(it.throw('Y')) + log }
  export let arrayReturn = () => { log = ''; const it = viaArray(); it.next(); return show(it.return(3)) + log }
  export let notObject = () => { log = ''; return show(viaNumber().next()) + log }`))

// A yield anywhere in an expression suspends at a statement of its own, the
// operands before it evaluated first, an assignment's target and current
// value read first; a loop's test, step and initializer, a switch's case
// tests and a labeled statement's jumps run across yields.
test('generators: yield in expressions, loop heads, switch and labels', () => agreeAll(`let log = ''
  const m = (x) => { log += x; return x }
  const drive = (it, sends) => { const out = []; let r = it.next(), k = 0; while (!r.done) { out.push(r.value); r = it.next(sends[k++]) } return out.join() + '=' + r.value }
  function* expr() { const r = m('a') + (yield m('b')) + m('c'); const o = { p: yield 'p', q: [yield 'q', ...(yield 'r')] }; return r + JSON.stringify(o) + (yield (yield 1) + 1) }
  function* logic(c) { const a = c && (yield 'y'); const b = c || (yield 'n'); return [a, b, c ? yield 't' : yield 'f'].join() }
  let s = 10
  function* assign(o) { s += yield 1; o.a.b = yield 2; o.a.c ||= yield 3; o.a.d ||= yield 4; return s + JSON.stringify(o) }
  function* sw(x) { switch (x) { case 1: yield 'a'; case 2: yield 'b'; break; case (yield 'q'): yield 'c'; default: yield 'd'; case 4: yield 'e' } return 'end' }
  function* skip() { let n = 0; while (n < 5) { n++; yield n; switch (n % 2) { case 0: continue } yield 'o' } }
  function* wh() { let n = 0; while ((yield 'w' + n) < 2) { n++; if (n === 2) continue; n += 10 } return n }
  function* fr() { for (let i = yield 'i', j = i * 2; i < (yield 'c' + i); i += yield 's' + i) { if (i === 1) continue; yield 'b' + i + j } return 'f' }
  function* dw() { let n = 0; do { n++; if (n === 2) continue; yield 'b' + n } while (yield 't' + n); return n }
  function* lb() { a: for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) { if (j === 1) continue a; if (i === 2) break a; yield '' + i + j } } b: { yield 'x'; if (s) break b; yield 'y' } c: try { yield 'z'; break c } finally { log += 'F' } return 'L' }
  function* closing() { try { switch (1) { case 1: yield 1; yield 2 } } finally { log += 'C' } }
  export let expressions = () => { log = ''; return drive(expr(), ['S', 1, 2, [3, 4], 5, 6]) + log }
  export let shortCircuit = () => [0, 1].map(c => drive(logic(c), ['S', 'T', 'U'])).join('|')
  export let assignments = () => { s = 10; const o = { a: { b: 0, c: 0, d: 1 } }; const it = assign(o); it.next(); s = 100; it.next(5); it.next(6); return JSON.stringify(it.next(7)) }
  export let switches = () => [[1, []], [3, [3]], [4, [0]], [9, [0]]].map(([x, sends]) => drive(sw(x), sends)).join('|') + drive(skip(), [])
  export let loopHeads = () => drive(wh(), [0, 1, 5]) + '|' + drive(fr(), [1, 3, 1, 3, 'x', 5, 3]) + '|' + drive(dw(), [1, 1, 1, 0, 0])
  export let labeled = () => { log = ''; s = 1; return drive(lb(), []) + log }
  export let returned = () => { log = ''; const it = closing(); it.next(); return JSON.stringify(it.return(5)) + log }`))

// A for-of or for-in whose body yields runs over what the source holds as a
// for-of reads it (an array live, a string's code points, a Map's entries, a
// typed array, an iterator through its protocol) or over the keys a for-in
// enumerates; the iterator closes when the body leaves early, a labeled jump
// leaves it, or a return() or throw() arrives at a yield in it.
test('generators: yield in for-of and for-in bodies', () => agreeAll(`let log = ''
  const own = (n) => ({ i: 0, next() { this.i++; return { value: this.i, done: this.i > n } }, return() { log += 'R'; return {} }, [Symbol.iterator]() { return this } })
  function* src() { try { yield 1; yield 2 } finally { log += 'S' } }
  function* values(a) { for (const x of a) { yield x; if (x === 1) a.push(9) } }
  function* chars(s) { for (const c of s) yield c }
  function* entries(m, s, t) { for (const [k, v] of m) yield k + v; for (const x of s) yield x; for (const x of t) yield x }
  function* proto(n) { for (const x of own(n)) { yield x; if (x === 2) break } yield 'end' }
  function* closing() { try { for (const x of src()) yield x * 10 } finally { log += 'G' } }
  function* labeled() { outer: for (const x of [1, 2, 3]) { for (const y of own(3)) { if (y === 2) continue outer; if (x === 3) break outer; yield x * 10 + y } } yield 0 }
  function* keys(o) { for (const k in o) { if (k === 'c') return k; yield k + o[k] } }
  function* heads(a) { let x; const o = { p: 0 }; for (x of a) yield x; for (o.p of a) yield o.p + 1; yield 'x' + x }
  export let arrays = () => [...values([1, 2])].join() + '|' + [...chars('a😀b')].join('|')
  export let collections = () => [...entries(new Map([['a', 1], ['b', 2]]), new Set([7, 8]), new Float64Array([1.5]))].join()
  export let protocols = () => { log = ''; return [...proto(5)].join() + log + [...proto(1)].join() + log }
  export let returned = () => { log = ''; const it = closing(); return it.next().value + JSON.stringify(it.return(5)) + log }
  export let thrown = () => { log = ''; const it = proto(5); it.next(); try { it.throw('E') } catch (e) { log += e } return log }
  export let jumps = () => { log = ''; return [...labeled()].join() + log }
  export let forIn = () => JSON.stringify([...keys({ a: 1, b: 2, c: 3, d: 4 })]) + [...keys(null)].length
  export let assignedHeads = () => [...heads([1, 2])].join()`))

// The body's declarations are the machine's locals, each spelled apart: a
// block's binding shadows a parameter, an outer name or a catch parameter
// without touching it, a reference made before a later declaration reads
// that declaration's binding, a hoisted var names its parameter. A closure
// made in a loop the machine splits keeps its own iteration's bindings, as
// JS keeps them, and shares them with the iteration's code.
test('generators: block scopes and per-iteration bindings across yields', () => agreeAll(`let outer = 'o'
  function* shadow(p) { var p; { let p = 2; let outer = 3; yield p + outer } yield p + outer; let e = 'e'; try { yield 0; throw 'x' } catch (e) { yield e } yield e }
  function* forward() { const f = () => x; { let x = 1; yield f } let x = 2; yield x }
  function* loops() { const fs = []
    for (let i = 0; i < 3; i++) { const j = i * 2; fs.push(() => i + ':' + j); yield i }
    let k = 0; while (k < 2) { const c = k; fs.push(() => c); yield k++ }
    for (let i = 0, f0 = () => i; i < 2; i++) { fs.push(f0, () => i++); yield i }
    for (const x of ['a', 'b']) { fs.push(() => x); yield x }
    for (let n = 0; n < 2; n++) { try { yield n; throw n * 10 } catch (e) { fs.push(() => e) } switch (n) { case 0: case 1: let s = 's' + n; fs.push(() => s) } }
    yield fs.map(f => f()).join() + '/' + fs.map(f => f()).join() }
  export let shadowed = () => [...shadow(1)].join()
  export let forwardRefs = () => { const it = forward(); const f = it.next().value; it.next(); return f() }
  export let perIteration = () => [...loops()].join('|')`))

// A destructuring declaration in a generator body binds as one anywhere
// does: an object rest, a default for undefined only, an iterator through
// its protocol, nested and computed patterns, across a yield, in a catch
// clause and in a for-of head.
test('generators: destructuring across yields', () => agreeAll(`
  function* src() { yield 1; yield 2; yield 3 }
  function* g(o) { let { a, b = 2, ...r } = o; yield a + ':' + b + ':' + Object.keys(r).join()
    const [x, y] = new Set([1, 2]); const [first, ...rest] = src(); const [c1] = '😀b'; yield x + y + first + rest.join() + c1
    const { p: [q, { z = 5 } = {}], [o.k]: w } = { p: [1], dyn: 'W' }; yield q + z + w
    let [m, n] = yield 'send'; const { s, t = 4 } = yield 'send2'; yield m + n + s + t
    try { yield 0; throw { e1: 1, e2: [2] } } catch ({ e1, e2: [e3] }) { yield e1 + e3 }
    for (const [k, v] of new Map([['a', 1]])) yield k + v
    let u, v; for ([u, v] of [[1, 2], [3, 4]]) yield u * v }
  export let destructured = () => { const it = g({ a: 1, b: null, c: 3, k: 'dyn' }); const out = []; let r = it.next(); while (!r.done) { out.push(r.value); r = it.next(r.value === 'send' ? [1, 2] : r.value === 'send2' ? { s: 3 } : undefined) } return out.join('|') }`))

// A destructuring whose default or computed key yields runs the steps
// ECMA-262 takes: keys read in turn, an iterator stepped as the pattern
// reaches each element and closed when the pattern leaves it unfinished (a
// return() or throw() at the yield too), an assignment's target evaluated
// before its value.
test('generators: yield in destructuring defaults and computed keys', () => agreeAll(`let log = ''
  function* src() { try { yield undefined; yield 2; yield 3 } finally { log += 'F' } }
  function* g(o) { const { a = yield 'a?', [yield 'k?']: b, c = yield 'c?' } = o; const [x = yield 'x?', y, ...r] = src(); yield a + b + c + x + y + r.join() + log; const t = {}; [t.p = yield 't?'] = []; yield JSON.stringify(t) }
  function* closing() { const [m = yield 'm?', n] = src(); yield m + n }
  function* caught() { try { throw {} } catch ({ e = yield 'e?' }) { yield 'got ' + e } }
  const drive = (it, sends) => { const out = []; let r = it.next(), k = 0; while (!r.done) { out.push(r.value); r = it.next(sends[k++]) } return out.join() }
  export let defaults = () => { log = ''; return drive(g({ k: 'K', c: 'C' }), [1, 'k', 9, 'X', 'T']) }
  export let returned = () => { log = ''; const it = closing(); it.next(); return JSON.stringify(it.return(5)) + log }
  export let thrown = () => { log = ''; const it = closing(); it.next(); try { it.throw('E') } catch (e) { log += e } return log }
  export let catchClause = () => drive(caught(), ['M'])`))

// for-of closes its iterator (IteratorClose) when the body leaves early: a
// break, return, throw or outward continue calls return(), once. Exhaustion,
// a continue and an exception from next() close nothing; the body's exception
// stands over return()'s, which is otherwise the loop's (with its result
// checked to be an object).
test('for-of: a body leaving early closes its iterator', () => agreeAll(`let log = ''
  function* g() { try { yield 1; yield 2; yield 3 } finally { log += 'F' } }
  function* bad() { try { yield 1 } finally { throw 'R' } }
  function* boom() { try { yield 1; throw 'N' } finally { log += 'F' } }
  function* outer() { try { for (const x of g()) yield x } finally { log += 'O' } }
  function* relay() { for (const x of g()) yield x }
  const own = (ret) => ({ i: 0, next() { this.i++; return { value: this.i, done: this.i > 3 } }, return: ret, [Symbol.iterator]() { return this } })
  const closed = () => { log += 'R'; return {} }
  const trap = (f) => { try { return f() } catch (e) { return e instanceof TypeError ? 'TypeError' : e } }
  export let broken = () => { log = ''; for (const x of g()) { log += x; break } return log }
  export let returned = () => { log = ''; const f = () => { for (const x of g()) return x }; return f() + log }
  export let thrown = () => { log = ''; return trap(() => { for (const x of g()) throw 'E' }) + log }
  export let jumped = () => { log = ''; outer: for (let i = 0; i < 2; i++) for (const x of g()) { log += x; continue outer } return log }
  export let completed = () => { log = ''; for (const x of g()) { if (x < 3) continue; log += x } return log }
  export let assigned = () => { log = ''; let x; for (x of g()) if (x === 2) break; return log + x }
  export let bodyWins = () => trap(() => { for (const x of bad()) throw 'B' })
  export let returnErr = () => trap(() => { for (const x of bad()) break })
  export let nextErr = () => { log = ''; return trap(() => { for (const x of boom()) log += x }) + log }
  export let suspended = () => { log = ''; for (const x of outer()) { log += x; break } return log }
  export let relayed = () => { log = ''; for (const x of relay()) { log += x; break } return log }
  export let protocol = () => { log = ''; for (const x of own(closed)) if (x === 2) break; return log }
  export let protocolBodyWins = () => trap(() => { for (const x of own(() => { throw 'X' })) throw 'B' })
  export let notCallable = () => trap(() => { for (const x of own(5)) break })
  export let notObject = () => trap(() => { for (const x of own(() => 5)) break })`))

test('iterator helpers: fused loops close their generator; take() closes before another pull', () => agreeAll(`let log = ''
  function* g() { try { log += 1; yield 1; log += 2; yield 2; log += 3; yield 3 } finally { log += 'F' } }
  export let mapped = () => { log = ''; for (const x of g().map(v => v * 10)) { log += x; break } return log }
  export let found = () => { log = ''; return g().find(v => v === 2) + log }
  export let some = () => { log = ''; return g().some(v => v === 1) + log }
  export let taken = () => { log = ''; for (const x of g().take(1)) log += 'x'; return log }
  export let filtered = () => { log = ''; return g().filter(v => v > 1).take(1).toArray().join() + log }
  export let threw = () => { log = ''; try { g().map(v => { throw 'C' }).toArray() } catch (e) { log += e } return log }
  export let assigned = () => { log = ''; let x; for (x of g().map(v => v * 10)) {} return x + log }`))

// `E[Symbol.iterator]()` is the iterator over E for any E: an indexed value's
// own (`__it_from` mints it), a provider's `@@iterator` result, a machine
// itself; Map and Set iterate their snapshot views. The delegating idiom
// (`[Symbol.iterator]() { return this.items[Symbol.iterator]() }`) is the
// common collection wrapper; a for-of over it drives the protocol.
test('iterator values: [Symbol.iterator]() on any receiver', () => {
  is(j(`export let f = () => { const a = [7, 8]; return a[Symbol.iterator]().next().value }`), 7)
  is(j(`export let f = (x) => { const a = x ? [7, 8] : 'ab'; const it = a[Symbol.iterator](); return it.next().value + it.next().value }`), 'ab')
  is(j(`export let f = () => { let s = 0; for (const [k, v] of new Map([['a', 1], ['b', 2]])[Symbol.iterator]()) s += v; for (const v of new Set([3, 4])[Symbol.iterator]()) s += v; return s }`), 10)
  is(j(`class List {
          constructor() { this._ev = [] }
          [Symbol.iterator]() { return this._ev[Symbol.iterator]() }
          add(e) { this._ev.push(e) }
        }
        class P {
          #l = new List()
          set value(v) { for (const e of this.#l) { if (e.type === 'x') throw new Error('x') } this.#l.add({ type: 'set', value: v }) }
          count() { let n = 0, s = 0; for (const e of this.#l) { n++; s += e.value } return n * 100 + s }
        }
        export let f = () => { const p = new P(); p.value = 1; p.value = 2; return p.count() + [...new List()].length }`), 203)
  is(j(`class L { constructor() { this.a = [{ v: 1 }, { v: 2 }] }
  [Symbol.iterator]() { return this.a[Symbol.iterator]() } }
        export let f = () => { const l = new L(); let s = 0; for (const e of l) s += e.v; return s + [...l].length + Array.from(l).length }`), 7)
  is(j(`function* g() { yield 1; yield 2 }
        export let f = () => { const it = g()[Symbol.iterator](); let s = 0; for (const v of it) s += v; return s }`), 3)
})
