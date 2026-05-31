// Determinism gate: the same source must compile to byte-identical wasm, every
// time and within a process. A drift here means hidden nondeterminism — Map/Set
// iteration order, Date.now()/Math.random() leaking into codegen, or unstable
// sort/dedup in the optimizer — which would break content-addressed caching,
// reproducible builds, and bisection. ~free to assert, easy to regress.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { compile } from '../index.js'
import { OPT_LEVEL } from './_matrix.js'

const PROGRAMS = [
  'export let add = (a, b) => a + b',
  'export let mix = (n) => { let h = 2166136261|0; for (let i = 0; i < (n|0); i++) { h = Math.imul(h ^ i, 16777619); h ^= h >>> 13 } return h >>> 0 }',
  'export let shape = () => { let o = { x: 1, y: 2, z: 3 }; let a = [o.x, o.y, o.z]; return a[0] + a[1] + a[2] }',
  'export let str = (s) => s.length + s.charCodeAt(0)',
  'export let poly = (a, b, c) => { let s = 0; for (let i = 0; i < 100; i++) s += a*i*i + b*i + c; return s }',
  'let N = 0; let buf; export let init = (k) => { N = k; buf = new Float64Array(k); return buf }; export let run = () => { let i = 0; while (i < N) { buf[i] = buf[i] * 2.0 + i; i++ } }',
]

const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

test(`determinism: same source → byte-identical wasm (opt ${OPT_LEVEL})`, () => {
  for (const src of PROGRAMS) {
    const a = compile(src), b = compile(src), c = compile(src)
    ok(eq(a, b) && eq(b, c), `non-deterministic output for: ${src.slice(0, 50)}…`)
  }
})

test('determinism: stable across opt levels (each level self-consistent)', () => {
  for (const src of PROGRAMS) {
    for (const opt of [0, 1, 2, 3]) {
      const a = compile(src, { optimize: opt }), b = compile(src, { optimize: opt })
      ok(eq(a, b), `non-deterministic at optimize:${opt} for: ${src.slice(0, 40)}…`)
    }
  }
})

// Compilation must be independent of what was compiled before: reset() has to
// fully clear the shared ctx between compiles. A forgotten field — a new Map left
// unreset — leaks the prior program's state into the next, making output depend on
// history. The same-source test above only catches that incidentally; this asserts
// it directly: B compiled after assorted, feature-dense predecessors must stay
// byte-identical to B compiled fresh.
test('determinism: compilation is independent of prior compiles (no ctx leak)', () => {
  const B = PROGRAMS[2]   // object-schema + array program — exercises many ctx namespaces
  // A: dense across schema / closures / strings / typed arrays / globals / loops,
  // so a leaked field in any of those would perturb the following compile of B.
  const A = `
    let g = 0
    export let f = (n) => {
      const o = { a: 1, b: 2, c: 3 }
      const add = (x) => x + o.a
      const buf = new Float64Array(4)
      let s = "hello".length
      for (let i = 0; i < (n | 0); i++) { buf[i & 3] = add(i); s += buf[i & 3] }
      g += s
      return s + g + o.b + o.c
    }`
  const refB = compile(B)
  compile(A);           const afterA = compile(B)
  compile(PROGRAMS[4]); const afterPoly = compile(B)
  ok(eq(refB, afterA), 'compile(B) changed after compile(A) — prior ctx state leaked through reset()')
  ok(eq(refB, afterPoly), 'compile(B) changed after compile(poly) — prior ctx state leaked through reset()')
})
