// Generators (Ring 1 pivot, extension-surface plan): regenerator-style state
// machines — no stack suspension. `function*` lowers to a factory arrow whose
// body is a dispatch loop over hoisted locals; `{ next, return }` are ordinary
// closures over that state (mutable captures). for-of over a KNOWN generator
// call desugars to while-next (inside AND outside generator bodies). Sync only.
// v1 rejects (precise messages): yield*, yield in arbitrary expressions,
// try across yield, yield inside for-of/for-in bodies.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'

const j = (code) => jz(code).exports.f()

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
  rejects(`function* g() { try { yield 1 } catch (e) {} } export let f = () => 1`, 'try/catch across a yield')
  rejects(`export let f = () => { let y = yield 1; return y }`, 'yield outside a generator')
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
