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
  rejects(`function* g() { yield* [1, 2] } export let f = () => g().next().value`, 'yield*')
  rejects(`function* g() { try { yield 1 } catch (e) {} } export let f = () => 1`, 'try/catch across a yield')
  rejects(`export let f = () => { let y = yield 1; return y }`, 'yield outside a generator')
})
