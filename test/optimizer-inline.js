// Inlining: the IR inliner's splices and budgets, the source inliner (sourceInline),
// and arguments a spliced loop reads.
import test from 'tst'
import { almost, is, ok } from 'tst/assert.js'
import { onKernel, levels, belowOpt, onWasi } from './_matrix.js'
import parseWat from 'watr/parse'
import { funcWat, run, oracle, jz, compile } from './util.js'
import { parse, loopCount, count } from '../scripts/wat-probe.mjs'
import { findFunc, preWatr, callsInLoop } from './_optimizer.js'

test('inline: large multi-caller leaf folds at speed (transitive candidacy + expression-position hoist), bit-exact', () => {
  // `mix` is a block-body LEAF that CALLS leaf helpers lo/hi — so the strict "any user call
  // ⇒ outline" gate keeps it standalone at ≤2 — and is invoked from MULTIPLE sites in
  // EXPRESSION position `2.0*mix(i) + mix(i+1)`, which neither inlineInStmt's `const X=call`
  // path nor single-call inlineOnce reaches. At speed, transitive candidacy makes it a
  // candidate once lo/hi are, and the hoist lifts the nested calls into temps the direct
  // path folds → 0 calls. ≤2 keep the conservative multi-caller policy (V8 wasm tier-up).
  // This is noise's perlin shape in miniature; a revert of ANY of the three pieces
  // (transitive candidacy, the hoist, or the speed gate) fails a distinct assertion.
  const SRC = `
    let lo = (x) => x * 0.5
    let hi = (x) => x + 1.0
    let mix = (x) => { let a = lo(x); let b = hi(x); return a + b }
    export let f = (n) => { let s = 0.0
      for (let i = 0; i < n; i = i + 1) s = s + 2.0 * mix(i) + mix(i + 1)
      return s }`
  // bit-exact: inlining is pure substitution, so speed must equal the level-2 (called) result
  if (!onWasi()) is(jz(SRC, { optimize: { level: 'speed' } }).exports.f(50),
                    jz(SRC, { optimize: 2 }).exports.f(50), 'speed == level 2 (bit-exact)')
  if (onKernel()) return  // call-shape is a host-codegen assertion; bit-exactness above is portable
  const calls = (opt) => (compile(SRC, { wat: true, optimize: opt }).match(/call \$mix/g) || []).length
  is(calls({ level: 'speed' }), 0, 'speed: transitive+hoist fully inlines the multi-caller leaf')
  ok(calls(2) >= 1, 'level 2: strict policy keeps the multi-caller leaf outlined for tier-up')
})

// The leaf site cap bounds duplication at sites outside loops; a site inside a
// loop is the call the splice exists to remove. three's Vector3.fromArray has a
// dozen callers in the library and a handful per element in a frame's kernels:
// the library's straight-line callers no longer keep the kernels' calls.
test('inline: a small leaf called from many straight-line sites still splices into the loops that call it', () => {
  // seven straight-line callers and four calls in the loop: over the leaf's site cap together, under it apart
  const cold = Array.from({ length: 7 }, (_, i) => `let c${i} = (a) => leaf(a, ${i})`).join('\n')
  const SRC = `
    let leaf = (a, o) => a[o] * 2 + a[o + 1] * 3 + a[o + 2] * 5 + a[o + 3] * 7
    ${cold}
    export let f = (n) => { const a = new Float64Array(n + 20); for (let i = 0; i < n; i++) a[i] = i
      let s = 0.0
      for (let i = 0; i < n; i++) s = s + ${Array.from({ length: 4 }, (_, i) => `leaf(a, i + ${i})`).join(' + ')}
      return s + ${Array.from({ length: 7 }, (_, i) => `c${i}(a)`).join(' + ')} }`
  is(jz(SRC, { optimize: 2 }).exports.f(16), jz(SRC, { optimize: 0 }).exports.f(16), 'bit-exact')
  if (onKernel()) return
  is(callsInLoop(SRC, '$leaf'), 0, 'the loop\'s calls are spliced whatever the count of straight-line sites')
})

test('inline: a leaf past the everywhere budget splices at its loop sites, the straight-line sites keep the call', () => {
  // ~90 nodes, three straight-line callers and one loop call: over the two-site rule, under the loop budget
  const SRC = `
    let leaf = (a, o) => {
      const p = a[o] * 2 + a[o + 1] * 3, q = a[o + 2] * 5 + a[o + 3] * 7, r = a[o + 4] * 11 + a[o + 5] * 13
      const s = p * q + r, t = p - q * r, u = s * t + p * 3 - q * 5 + r * 7
      return u * 2 + s - t + a[o + 6] * 17 + a[o + 7] * 19 }
    let c0 = (a) => leaf(a, 0)
    let c1 = (a) => leaf(a, 1)
    let c2 = (a) => leaf(a, 2)
    export let f = (n) => { const a = new Float64Array(n + 20); for (let i = 0; i < n; i++) a[i] = i * 0.5
      let s = 0.0
      for (let i = 0; i < n; i++) { const v = leaf(a, i); s = s + v }
      return s + c0(a) + c1(a) + c2(a) }`
  is(jz(SRC, { optimize: 2 }).exports.f(16), jz(SRC, { optimize: 0 }).exports.f(16), 'bit-exact')
  if (onKernel()) return
  is(callsInLoop(SRC, '$leaf'), 0, 'the loop call is spliced')
  ok(count(parse(SRC, preWatr(2)), n => (n[0] === 'call' || n[0] === 'return_call') && n[1] === '$leaf') >= 1, 'the straight-line sites keep the call')
})

test('inline: unreachable callers do not consume the duplication budget', () => {
  const unused = Array.from({ length: 24 }, (_, i) => `function unused${i}(p) { return set(p, ${i}, 1) }`).join('\n')
  const src = `function set(p, x, z) { if (z === undefined) z = p.z; p.x = x; p.z = z; return p }
    ${unused}
    export function f(n) {
      const p = { x: 0, z: 0 }; let s = 0
      for (let k = 0; k < 2; k++) { set(p, k, 1); for (let i = 0; i < n; i++) s += p.x + p.z + i }
      return s
    }`
  for (const optimize of levels(0, 2, 3)) {
    const { f } = jz(src, { optimize }).exports
    for (const n of [0, 1, 4, 9]) is(f(n), n * n + 2 * n, `nested loop, n=${n}, O${optimize}`)
  }
  if (onKernel()) return
  ok(!/call \$__alloc/.test(compile(src, { optimize: 'speed', wat: true })), 'the live setter inlines and the receiver scalarizes')
})

test('inline: a method\'s synthesized dispatcher and binder are no sites of it', () => {
  // ~90 nodes at one loop site: over the everywhere budget only if the dispatcher's arm and the binder's closure count
  const SRC = `
    class W { constructor(a) { this.a = a }
      mix(o) { const a = this.a
        const p = a[o] * 2 + a[o + 1] * 3, q = a[o + 2] * 5 + a[o + 3] * 7, r = a[o + 4] * 11 + a[o + 5] * 13
        const s = p * q + r, t = p - q * r, u = s * t + p * 3 - q * 5 + r * 7
        return u * 2 + s - t + a[o + 6] * 17 + a[o + 7] * 19 } }
    export let f = (n) => { const a = new Float64Array(n + 20); for (let i = 0; i < n; i++) a[i] = i * 0.5
      const w = new W(a)
      let s = 0.0
      for (let i = 0; i < n; i++) { const v = w.mix(i); s = s + v }
      return s }`
  is(jz(SRC, { optimize: 2 }).exports.f(16), jz(SRC, { optimize: 0 }).exports.f(16), 'bit-exact')
  if (onKernel()) return
  is(loopCount(findFunc(parse(SRC, preWatr(2)), '$f'), n => n[0] === 'call' && /mix$/.test(n[1])), 0, 'the method splices into the loop')
})

test('inline: returns inside a loop and in nested arms lower to one exit, and the body splices', () => {
  const SRC = `
    let planes = new Float64Array([1, 2, 3, -4, 5, 6])
    let inside = (limit) => { for (let i = 0; i < 6; i++) { if (planes[i] < limit) return false } return true }
    let hit = (u, v, w, cull) => {
      if (cull) { if (u < 0 || v < 0 || w < 0) return -1 } else { if ((u < 0 || v < 0 || w < 0) && (u > 0 || v > 0 || w > 0)) return -2 }
      const det = u + v + w
      if (det === 0) return -3
      const t = u * 2 - v
      if (det > 0 ? t < 0 : t > 0) return -4
      return t / det }
    let first = (limit) => { let n = 0; for (let i = 0; i < 6; i++) { n++; if (planes[i] < limit) return i * 10 + n } n += 100; return n }
    export let f = (n) => { let s = 0.0
      for (let k = 0; k < n; k++) { const h = hit(k % 5 - 2, k % 7 - 3, k % 3 - 1, k % 2 === 0); s = s + h + first(k - 3); if (inside(k - 8)) s = s + 1 }
      return s }`
  const o0 = jz(SRC, { optimize: 0 }).exports.f(37)
  almost(o0, -47.9 + 202 + 5, 1e-9, 'the reference value (Node: 159.1)')
  is(jz(SRC, { optimize: 3 }).exports.f(37), o0, 'bit-exact at speed')
  // a bare `return` beside a valued one: the exit assigns undefined
  const MIXED = `let f0 = (a) => { if (a > 1) return; return a }
    export let f = (n) => { let s = 0.0; for (let k = 0; k < n; k++) { const v = f0(k); if (v === undefined) s = s + 10; else s = s + v } return s }`
  is(jz(MIXED, { optimize: 3 }).exports.f(5), 0 + 1 + 30, 'a bare return exits with undefined')
  if (onKernel()) return
  for (const name of ['$hit', '$first', '$inside']) is(callsInLoop(SRC, name, 3), 0, `${name} is spliced into the loop`)
})

// A `throw` is a statement of a spliced body like any other: it leaves the caller as it left
// the callee. A function that checks its arguments and throws was never spliced, so every
// validating helper stayed a call with a frame of its own (a stack's `push` and `pop` that
// throw on misuse: 5.6 times Node's time where the same pair without the checks took 3.2).
test('inline: a body that throws splices, and throws where the callee threw', () => {
  const caught = (f) => { try { return { value: f() } } catch (e) { return e instanceof Error ? { error: e.constructor.name, message: e.message } : { thrown: e } } }
  const programs = {
    'a guard before the work': `const check = (k) => { if (k > 5) throw new RangeError('past ' + k); return k * 2 }
      export const f = (n) => { let s = 0; for (let i = 0; i < n; i++) s += check(i); return s }`,
    'a throw in one arm, a value in the other': `const pick = (o, k) => { if (k < 3) return o.a + k; throw new Error('no arm for ' + k) }
      export const f = (n) => { const o = { a: 10 }; let s = 0; for (let i = 0; i < n; i++) s += pick(o, i); return s }`,
    'a body that only throws': `const fail = (what) => { throw new TypeError(what) }
      export const f = (n) => { let s = 0; for (let i = 0; i < n; i++) s += i < 4 ? i : fail('at ' + i); return s }`,
    'a throw inside the callee\'s loop': `const total = (a, n) => { let t = 0; for (let j = 0; j < n; j++) { if (a[j] < 0) throw new Error('negative at ' + j); t += a[j] } return t }
      export const f = (n) => { const a = [3, 1, 4, -1, 5]; let s = 0; for (let i = 0; i < 3; i++) s += total(a, n); return s }`,
    'a throw before the callee\'s effect': `const put = (o, k) => { if (k === 3) throw new Error('refused'); o.n += k; return o.n }
      const state = { n: 0 }
      export const f = (n) => { let s = 0; try { for (let i = 0; i < n; i++) s += put(state, i) } catch (e) { s += 1000 } return s * 100 + state.n }`,
    'caught in the caller': `const check = (k) => { if (k > 2) throw new RangeError('past'); return k }
      export const f = (n) => { let s = 0; for (let i = 0; i < n; i++) { try { s += check(i) } catch (e) { s += 100 } } return s }`,
    'a finally around the spliced call': `const check = (k) => { if (k > 2) throw new RangeError('past'); return k }
      let seen = 0
      export const f = (n) => { let s = 0; for (let i = 0; i < n; i++) { try { s += check(i) } catch (e) { s += 100 } finally { seen += 1 } } return s * 10 + seen }`,
    'a thrown string and a thrown number': `const check = (k) => { if (k === 2) throw 'two'; if (k === 4) throw 4; return k }
      export const f = (n) => { let s = 0; for (let i = 0; i < n; i++) s += check(i); return s }`,
    'a method that throws on misuse': `class Stack { constructor() { this.items = [0, 0, 0, 0]; this.n = 0 }
        push(x) { if (this.n === 4) throw new Error('full'); this.items[this.n] = x; this.n += 1 }
        pop() { if (this.n === 0) throw new Error('empty'); this.n -= 1; return this.items[this.n] } }
      export const f = (n) => { const st = new Stack(); let s = 0; for (let i = 0; i < n; i++) { st.push(i); if (i & 1) s += st.pop() + st.pop() } return s + st.n }`,
    'arguments evaluated before the throw': `let calls = 0
      const next = () => { calls += 1; return calls }
      const check = (a, b) => { if (a + b > 6) throw new Error('sum ' + (a + b)); return a + b }
      export const f = (n) => { let s = 0; try { for (let i = 0; i < n; i++) s += check(next(), next()) } catch (e) { s += 500 } return s * 100 + calls }`,
  }
  for (const [label, src] of Object.entries(programs)) {
    // (a module with state is asked once at each count, a fresh instance each)
    for (const optimize of levels(0, 1, 2, 3, 'size', 'speed')) for (const n of [0, 3, 5, 9])
      is(caught(() => run(src, { optimize }).f(n)), caught(() => oracle(src).f(n)), `${label}, f(${n}) at ${optimize}`)
  }
  if (belowOpt(2)) return
  // at the speed tier, where a helper of this size splices into the loop that calls it, the
  // guard's callee is no call there
  const text = compile(programs['a guard before the work'], { wat: true, optimize: 'speed' })
  ok(!/\(call \$check\b/.test(funcWat(text, 'f')), 'the checking helper is spliced into its loop')
  const stack = compile(programs['a method that throws on misuse'], { wat: true, optimize: 'speed' })
  ok(!/\(call \$Stack.(push|pop)\b/.test(funcWat(stack, 'f')), 'and so are a stack\'s push and pop')
})

test('inline: a tuple result keeps a value per lane at every return', () => {
  // prepare types `return [x, y]` at every exit as two results; one lowered
  // exit returning a binding pushed one (the STFT's spectrum(), stretch-pvoc-lock)
  const SRC = `function sp(c, a, b) { if (c) { const r = { re: a, im: b }; return [r.re, r.im] } let s = 0; for (let k = 0; k < 3; k++) s += k; return [a + s, b] }
    function lp(n, a, b) { for (let k = 0; k < n; k++) if (k === 2) return [k, a]; return [a, b] }
    export let f = (c) => { const [x, y] = sp(c, 1, 2), [u, v] = lp(c, 1, 2); return x * 1000 + y * 100 + u * 10 + v }`
  for (const optimize of levels(0, 2, 3)) {
    const { f } = jz(SRC, { optimize }).exports
    is([f(0), f(5)].join(), '4212,1221', `tuple returns at ${optimize}`)
  }
})

test('inline: expression-position hoist preserves evaluation order of side effects', () => {
  // The hoist lifts a candidate call to a `const __h = call` temp at the statement top. That
  // is sound ONLY when no side effect precedes it: here `a()` (a non-candidate — it has a loop)
  // runs BEFORE `helper()` textually, so helper must NOT be hoisted above it. Each fn records
  // its call order into `log`; the returned digits encode the order (123 = a,helper,b).
  const order = (src) => jz(src, { optimize: { level: 'speed' } }).exports.f()
  const NONCAND_FIRST = `let log = new Int32Array(4); let n = 0;
    let a = () => { let s = 0; for (let i = 0; i < 1; i = i + 1) s = s + 1; log[n] = 1; n = n + 1; return 10 }
    let helper = (x) => { log[n] = 2; n = n + 1; return x + 1 }
    let b = () => { log[n] = 3; n = n + 1; return 100 }
    export let f = () => { n = 0; let t = a() + helper(5) * b(); return t * 1000000 + log[0]*100 + log[1]*10 + log[2] }`
  is(order(NONCAND_FIRST), 610000123, 'effect before a candidate blocks its hoist — order a,helper,b preserved')

  // When everything preceding is pure / hoistable, the candidate DOES fold (0 calls) and order holds.
  const ALL_CAND = NONCAND_FIRST.replace('let a = () => { let s = 0; for (let i = 0; i < 1; i = i + 1) s = s + 1; log[n] = 1', 'let a = () => { log[n] = 1')
  is(order(ALL_CAND), 610000123, 'all-candidate chain: order a,helper,b preserved')
  if (!onKernel()) is((compile(ALL_CAND, { wat: true, optimize: { level: 'speed' } }).match(/call \$helper/g) || []).length, 0, 'helper still inlines when nothing effectful precedes it')

  // A READ before the call sees the value before the callee's store: `s.v * 1000 + bump(s)`
  // reads 99, then bump stores 100 (the hoist would have read 100).
  const READ_FIRST = `const reveal = (s) => s.v
    const bump = (s) => { s.v = s.v + 1; return s.v }
    let g = 1
    const inc = () => { g = g + 1; return g }
    export let f = () => { let s = { v: 99 }; return reveal(s) * 1000 + bump(s) }
    export let direct = () => { let s = { v: 99 }; return s.v * 1000 + bump(s) }
    export let global = () => g * 1000 + inc()`
  for (const optimize of levels(2, 'speed')) {
    const e = jz(READ_FIRST, { optimize }).exports
    is(e.f(), 99100, `${optimize}: the read through an inlined accessor precedes the store`); is(e.direct(), 99100, `${optimize}: the member read precedes the store`); is(e.global(), 1002, `${optimize}: the global read precedes the store`)
  }
})

test('a leaf called only from a method a dispatcher reaches still splices', () => {
  if (onKernel()) return
  // The inliner counts sites in the functions that run. A class method reached
  // through a member access the census cannot name (two classes answer
  // `valueAt`: a dispatcher tests each) is one of them, as the program index's
  // call graph seeds it; the liveness the inliner read seeded only from direct
  // calls, so every leaf such a method called kept its call (the Web Audio
  // render's automation guards, 3.4× slower than the inlined render).
  const src = `
    const isRamp = (e) => e.kind === 'ramp'
    const isStep = (e) => e.kind === 'step'
    class Steps {
      constructor() { this.events = [{ kind: 'step', t: 0, v: 1 }, { kind: 'ramp', t: 1, v: 3 }] }
      valueAt(t) {
        let v = 0
        for (let i = 0; i < this.events.length; i++) {
          const e = this.events[i]
          if (isStep(e) && e.t <= t) v = e.v
          else if (isRamp(e) && e.t <= t) v = v + (e.v - v) * 0.5
        }
        return v
      }
    }
    class Flat {
      constructor(v) { this.v = v }
      valueAt(t) { return this.v + t }
    }
    export let main = (n) => {
      const tracks = [new Steps(), new Flat(2), new Steps()]
      let s = 0
      for (let k = 0; k < n; k++) s += tracks[k % 3].valueAt(k & 1)
      return s
    }`
  const wat = compile(src, { optimize: { level: 'speed', watr: false }, wat: true })
  is((wat.match(/call \$is(?:Ramp|Step)\b/g) || []).length, 0, 'the guards splice into the method')
  is(jz(src, { optimize: { level: 'speed' } }).exports.main(1000), 1833, 'the dispatched method answers')
})

test('sourceInline: early void returns preserve guards and argument effects', () => {
  const src = `let calls = 0, output = 0
    const arg = x => { calls++; return x }
    function update(a, b) { if (a === b) return; output += a + b }
    export function main() {
      update(arg(2), arg(2)); update(arg(2), arg(3))
      return [output, calls]
    }`
  const { main } = run(src, { optimize: 3 })
  is(main(), [5, 4])
  is(main(), [10, 8])
  if (!belowOpt(2)) ok(!/\(call \$update\b/.test(compile(src, { wat: true, optimize: 3 })))
})

test('sourceInline: early value returns join the caller loop without evaluating the other arm', () => {
  const src = `let trace = 0
    function choose(x) {
      trace = trace * 10 + 1
      if (x === 0) return (trace = trace * 10 + 2, -0)
      trace = trace * 10 + 3
      let y = x * 2
      return y + 1
    }
    export function main(n) {
      trace = 0
      let result = 0
      for (let i = 0; i < n; i++) result += choose(i)
      return [result, trace]
    }
    export function zero(n) { let result = 0; for (let i = 0; i < n; i++) result = choose(0); return result }`
  for (const optimize of levels(0, 2, 'speed', 'size')) {
    const { main, zero } = run(src, { optimize })
    is(main(0), [0, 0], `${optimize}: empty loop`)
    is(main(2), [3, 1213], `${optimize}: early then trailing return`)
    is(main(2), [3, 1213], `${optimize}: repeated invocation`)
    is(main(1), [0, 12], `${optimize}: only early return`)
    ok(Object.is(zero(1), -0), `${optimize}: returned signed zero`)
  }
  if (!belowOpt(3)) ok(!/\(call \$choose\b/.test(compile(src, { wat: true, optimize: 'speed' })), 'early value helper inlines at its loop call sites')
})

test('sourceInline: early boolean results keep their identity in locals and mixed returns', () => {
  const src = `function matches(x) {
      if (x === 0) return x !== 1 || x > 2
      return x === 1 && x !== 2
    }
    function mixed(x) { if (x < 2) return x !== 1 || x > 2; return 7 }
    export function main() {
      const a = matches(0), b = matches(1), c = matches(2), d = mixed(0), e = mixed(2)
      return [typeof a, a, b, c, typeof d, d, e]
    }
    export function coerce(flag) {
      const v = mixed(flag)
      return [typeof v, v, +v, v + 2, v ? 12 : 34, v === true, +mixed(flag)]
    }`
  for (const optimize of levels(0, 2, 'speed', 'size')) {
    const { main, coerce } = run(src, { optimize })
    is(main(), ['boolean', true, true, false, 'boolean', true, 7])
    is(main(), ['boolean', true, true, false, 'boolean', true, 7])
    is(coerce(0), ['boolean', true, 1, 3, 12, true, 1])
    is(coerce(1), ['boolean', false, 0, 2, 34, false, 0])
    is(coerce(2), ['number', 7, 7, 9, 12, false, 7])
  }
})

test('sourceInline: value return folding keeps fallthrough scope and nested exits', () => {
  const src = `function choose(x) {
      const y = x + 1
      if (x < 0) return y
      let z = y * 3
      if (x === 0) z += 2
      return z
    }
    function nested(x) {
      if (x < 0) return 11
      if (x === 0) return 22
      return 33
    }
    export function main(n) {
      let a = 0, b = 0
      for (let i = -1; i < n; i++) { a += choose(i); b += nested(i) }
      return [a, b]
    }`
  for (const optimize of levels(0, 2, 'speed', 'size')) {
    const { main } = run(src, { optimize })
    is(main(-1), [0, 0])
    is(main(0), [0, 11])
    is(main(1), [5, 33])
    is(main(3), [20, 99])
  }
})

test('size tier: shared scalar helpers remain outlined', () => {
  const src = `function mix(x) { const y=x*x+3*x+7; return y*y-y+2 }
    export function f(x) { return mix(x)+mix(x+1)+mix(x+2) }`
  for (const optimize of levels('size', 2, 3)) {
    const { f } = run(src, { optimize }), ref = oracle(src).f
    for (const x of [0, 0, -1, 2, 0.5]) is(f(x), ref(x))
    if (optimize === 'size' && !onKernel()) {
      const wat = compile(src, { wat:true, optimize:{level:'size', watr:false} })
      ok(/\(call \$mix\b/.test(wat), 'shared body survives source lowering')
    }
  }
})

test('sourceInline: small loop helpers inline across several speed-tier sites', () => {
  const src = `function count(n) { let sum = 0; while (n > 0) { sum += n; n-- }; return sum }
    function total(n) { const a = count(n); const b = count(n + 1); const c = count(n + 2); return a + b + c }
    export function main(n) { return total(n) }`
  const { main } = run(src, { optimize: 3 })
  is(main(-3), 0)
  is(main(2), 19)
  is(main(3), 31)
  if (!belowOpt(3)) ok(!/\(call \$count\b/.test(compile(src, { wat: true, optimize: 3 })))
})

test('sourceInline: small helpers join existing exported loops', () => {
  const src = `function count(n) { let sum = 0; while (n > 0) { sum += n; n-- }; return sum }
    export function main(n) { let sum = 0; for (let i = 0; i < n; i++) {
      const a = count(i), b = count(i + 1), c = count(i + 2); sum += a + b + c
    }; return sum }`
  const { main } = run(src, { optimize: 3 })
  is(main(0), 0)
  is(main(4), 64)
  is(main(-1), 0)
  if (!belowOpt(3)) ok(!/\(call \$count\b/.test(compile(src, { wat: true, optimize: 3 })))
})

test('sourceInline: leaf substitution retains reads around coercion and later arguments', () => {
  const cases = [
    `let x = 0; const leaf = v => v + ((x = 7), 1);
      export const f = n => { x = n; const r = leaf(x); return [r, x] }`,
    `let x; const leaf = v => v * 2 + v * 3;
      export const f = n => { x = {valueOf() { x = 9; return n }}; const r = leaf(x); return [r, x] }`,
    `let x = 0; const leaf = (v, w) => v !== v;
      export const f = n => { x = n; const r = leaf(x, x = NaN); return [r, Number.isNaN(x)] }`,
    `let x = 0; const leaf = v => ((x = 7), v);
      export const f = n => { x = n; const r = leaf(x); return [r, x] }`,
    `let calls = 0; const arg = n => { calls++; return n };
      const leaf = v => false ? v : 4;
      export const f = n => [leaf(arg(n)), calls]`,
    `let calls = 0; const arg = n => { calls++; return {value: n} };
      const leaf = v => v.value;
      export const f = n => [leaf(arg(n)), calls]`,
  ]
  for (const src of cases) for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const ref = oracle(src).f, { f } = run(src, { optimize })
    for (const n of [3, 3, -2, 0, NaN, 3]) is(f(n), ref(n), `leaf evaluation at O${optimize}, n=${n}`)
  }
})

test('sourceInline: caller binding substitution preserves writes, captures and coercions', () => {
  const cases = [
    `const pair = (v, w) => v * 10 + w;
      export const f = n => { let x = n; return pair(x, x = n + 10) }`,
    `const pair = (v, w) => v * 10 + w;
      export const f = n => { let x = n; return pair(-x, x = n + 10) }`,
    `const leaf = v => v * 2 + v * 3;
      export const f = n => { let x = { valueOf() { x = 9; return n } };
        const result = leaf(x); return [result, x] }`,
    `const leaf = v => v.x + v.x;
      export const f = n => { let p = { get x() { p = { x: 20 }; return n } };
        const result = leaf(p); return [result, p.x] }`,
    `const keep = v => () => v;
      export const f = n => { let x = n; const read = keep(x); x++; return [read(), x] }`,
    `const leaf = (v, touch) => { touch(); return v };
      function outer(x, touch = () => { x += 10 }) { return leaf(x, touch) }
      export const f = n => outer(n)`,
  ]
  for (const src of cases) for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const ref = oracle(src).f, { f } = run(src, { optimize })
    for (const n of [3, 3, -2, 0, 0.5, 3])
      is(f(n), ref(n), `caller storage at O${optimize}, n=${n}`)
  }
})

test('sourceInline: mutable parameters retain private storage and argument order', () => {
  const src = `let calls = 0
    function arg(x) { calls = calls * 10 + x; return x }
    function count(n, step) { let sum = 0; while (n > 0) { sum += n; n -= step }; return sum }
    function collect() {
      let n = 3, step = 1
      const a = count(n, step); const b = count(arg(2), arg(1)); const c = count(0, step)
      return [a, b, c, n, step, calls]
    }
    export function main() { return collect() }`
  const { main } = run(src, { optimize: 3 })
  is(main(), [6, 3, 0, 3, 1, 21])
  is(main(), [6, 3, 0, 3, 1, 2121])
  if (!belowOpt(3)) ok(!/\(call \$count\b/.test(compile(src, { wat: true, optimize: 3 })))
})

test('sourceInline: expression flattening preserves writable parameters and locals', () => {
  const cases = [
    `const step = (a, b) => (b = a + 1) && b; export const f = n => 2 * step(n)`,
    `const step = (a, b = 0) => (b += a) && b; export const f = n => 2 * step(n)`,
    `const step = (a, b) => (b = a + 1) && b; export const f = n => 2 * step(n, n + 2)`,
    `const step = (a, b) => (b = a + 1) && b;
      export const f = n => { const v = 2 * step(n, n); return v + n }`,
    `const step = a => { let b = a + 2; return (b = a + 1) && b }
      export const f = n => 2 * step(n)`,
    `const step = (a, b = 1) => b++ + a + b; export const f = n => 2 * step(n)`,
  ]
  for (const src of cases) {
    const ref = oracle(src).f
    for (const optimize of levels(0, 2, 3)) {
      const { f } = run(src, { optimize })
      for (const n of [3, -1, 0, 0.5, 3]) is(f(n), ref(n), `private assignment storage at O${optimize}`)
    }
  }
})

test('sourceInline: exported loop budget includes expanded callees', () => {
  const src = `function mix(x) {
      const a = x + 1, b = x + 2, c = x + 3, d = x + 4
      return a * b + c * d + (a - c) * (b - d) + a * c + b * d
    }
    function fill(a, n) { for (let i = 0; i < n; i++) a[i] = mix(i) }
    function repeat(a, n) { for (let j = 0; j < 3; j++) fill(a, n) }
    export function f(n) {
      const a = new Float64Array(1024)
      for (let warm = 0; warm < 2; warm++) repeat(a, n)
      for (let pass = 0; pass < 2; pass++) repeat(a, n)
      return [a[0], a[31], a[1000]]
    }`
  const { f } = run(src, { optimize: 3 })
  is(f(0), [0, 0, 0])
  is(f(1024), [29, 4493, 4020029])
  is(f(1), [29, 0, 0])
  is(f(1024), [29, 4493, 4020029])
  if (!belowOpt(3)) {
    const wat = compile(src, { wat: true, optimize: { level: 3, watr: false } })
    ok(/\(call \$(?:fill|repeat)\b/.test(funcWat(wat, 'f')), 'bulk loop remains callable for tier-up')
  }
})

test('sourceInline: inlines returnless hot internal helper calls', () => {
  const src = `
    const hot = (a, n) => {
      for (let i = 0; i < n; i++) a[i] = i + 1
    }
    const runKernel = (a) => { hot(a, 4) }
    export const main = () => {
      const a = new Float64Array(4)
      runKernel(a)
      return a[3] | 0
    }
  `
  const wat = compile(src, { wat: true, optimize: 3 })
  ok(!/\(call \$hot\b/.test(wat), 'expected hot helper call to be inlined')
  ok(!/\(func \$hot\b/.test(wat), 'expected inlined helper to treeshake away')
  const { main } = run(src, { optimize: 3 })
  is(main(), 4)
})

test('sourceInline: enabled by default at level 2 — inlines void hot helper', () => {
  const wat = compile(`
    const hot = (a, n) => {
      for (let i = 0; i < n; i++) a[i] = i + 1
    }
    const runKernel = (a) => { hot(a, 4) }
    export const main = () => {
      const a = new Float64Array(4)
      runKernel(a)
      return a[3] | 0
    }
  `, { wat: true, optimize: { watr: false } })
  ok(!/\(call \$hot\b/.test(wat), 'level 2 source optimizer should inline the helper before watr')
})

test('sourceInline: trailing-return helper inlines into `let X = call(...)` initializer', () => {
  if (belowOpt(2)) return  // asserts the sourceInline pass ran (optimize >= 2)
  const src = `
    const sum = (arr) => {
      let s = 0
      for (let i = 0; i < arr.length; i++) s += arr[i]
      return s
    }
    const runKernel = (a) => { const t = sum(a); return t | 0 }
    export const main = () => {
      const a = new Float64Array(4)
      a[0] = 1; a[1] = 2; a[2] = 3; a[3] = 4
      return runKernel(a)
    }
  `
  const wat = compile(src, { wat: true })
  ok(!/\(call \$sum\b/.test(wat), 'expected trailing-return sum to be inlined at expr-position call')
  const { main } = run(src)
  is(main(), 10)
})

test('sourceInline: trailing-return helper inlines into `X = call(...)` assignment', () => {
  if (belowOpt(2)) return  // asserts the sourceInline pass ran (optimize >= 2)
  const src = `
    const acc = (arr) => {
      let s = 0
      for (let i = 0; i < arr.length; i++) s += arr[i]
      return s + 1
    }
    const runKernel = (a) => { let r = 0; r = acc(a); return r | 0 }
    export const main = () => {
      const a = new Float64Array(3)
      a[0] = 10; a[1] = 20; a[2] = 30
      return runKernel(a)
    }
  `
  const wat = compile(src, { wat: true })
  ok(!/\(call \$acc\b/.test(wat), 'expected trailing-return acc to be inlined at assignment-rhs')
  const { main } = run(src)
  is(main(), 61)
})

test('sourceInline: nested calls flatten — lerp(grad(a), grad(b), t) fully inlines', () => {
  if (belowOpt(2)) return
  // A call whose args are THEMSELVES candidate calls (noise's `lerp(grad(aa,…), grad(ba,…), u)`)
  // must flatten end-to-end: non-simple args bind to temps (no duplication), then a follow-up
  // pass folds the inner candidate into the temp decl.
  const src = `
    const grad = (h, x, y) => { const g = h & 3; const u = (g & 1) === 0 ? x : -x; const v = (g & 2) === 0 ? y : -y; return u + v }
    const lerp = (a, b, t) => a + t * (b - a)
    const perlin = (perm, x, y) => {
      const X = (x | 0) & 255
      const aa = perm[(perm[X] + 1) & 511], ba = perm[(perm[(X + 1) & 511] + 1) & 511]
      return lerp(grad(aa, x, y), grad(ba, x - 1.0, y), x)
    }
    const run = (perm) => { let s = 0.0; for (let i = 0; i < 256; i++) s = s + perlin(perm, i * 0.1, i * 0.2); return s }
    export const main = () => { const perm = new Int32Array(512); for (let i = 0; i < 512; i++) perm[i] = (i * 31) & 255; return run(perm) }
  `
  const wat = compile(src, { wat: true })
  ok(!/\(call \$grad\b/.test(wat) && !/\(call \$lerp\b/.test(wat), 'nested grad/lerp calls fully inlined (perlin flattens)')
  ok(!/\(func \$grad\b/.test(wat) && !/\(func \$lerp\b/.test(wat), 'inlined leaves treeshake away')
  // Bit-exact: inlining + temp-binding must not change the result.
  const fast = run(src).main()
  const slow = jz(src, { optimize: { level: 2, sourceInline: false } }).exports.main()
  is(fast, slow, 'inlined result identical to un-inlined')
})

test('sourceInline: trailing-return helper inlines into indexed `out[i] = call(...)`', () => {
  const src = `
    export let beat = (t) => Math.sin(t * 6.28)
    export let fill = (out, len, sr) => {
      let i = 0
      while (i < len) { out[i] = beat(i / sr); i++ }
    }
    export const main = () => {
      const out = new Float64Array(4)
      fill(out, 4, 44100)
      return out[1]
    }
  `
  const wat = compile(src, { wat: true, optimize: { watr: false } })
  const fillFn = wat.match(/\(func \$fill[\s\S]*?\n  \)/)?.[0] || ''
  ok(!/call \$beat/.test(fillFn), 'expected beat inlined into fill loop')
  const { beat, main } = run(src)
  almost(main(), beat(1 / 44100), 1e-5)
})

test('sourceInline: does NOT inline ordinary hot loop into exported entry', () => {
  const src = `
    const hot = (n) => {
      let s = 0
      for (let i = 0; i < n; i++) s += i + 1
      return s
    }
    export const main = () => {
      return hot(4) | 0
    }
  `
  // jz's sourceInline declines (skip-into-export rule); but watr's `inlineOnce`
  // is single-callsite based and would happily inline `hot` itself. Disable
  // watr to verify jz's own decision.
  const wat = compile(src, { wat: true, optimize: { watr: false } })
  ok(/\(call \$hot\b/.test(wat), 'expected call kept inside exported entry (skip-into-export rule)')
  const { main } = run(src)
  is(main(), 10)
})

test('sourceInline: does NOT inline nested typed-array kernel unless all typed arrays are fixed', () => {
  const src = `
    const cascade = (x, state, out, nStages) => {
      for (let i = 0; i < x.length; i++) {
        let v = x[i]
        for (let s = 0; s < nStages; s++) {
          const y = v + state[s]
          state[s] = y
          v = y
        }
        out[i] = v
      }
    }
    const runKernel = () => {
      const x = new Float64Array(80)
      const state = new Float64Array(4)
      const out = new Float64Array(80)
      x[0] = 2
      state[0] = 1
      cascade(x, state, out, 4)
      return out[0] | 0
    }
    export const main = () => runKernel()
  `
  const wat = compile(src, { wat: true, optimize: { watr: false } })
  ok(/\(func \$cascade\b/.test(wat), 'nested kernel should stay callable')
  ok(/\(call \$cascade\b/.test(wat), 'nested kernel call should be preserved')
  const { main } = run(src)
  is(main(), 3)
})

test('sourceInline: disabled by optimize:false', () => {
  const wat = compile(`
    const hot = (a, n) => {
      for (let i = 0; i < n; i++) a[i] = i + 1
    }
    export const main = () => {
      const a = new Float64Array(4)
      hot(a, 4)
      return a[3] | 0
    }
  `, { wat: true, optimize: false })
  ok(/\(call \$hot\b/.test(wat), 'optimize:false should keep the helper call')
})

test('vectorized single-caller helper still participates in inlineOnce', () => {
  const src = `const map=(a,o)=>{for(let i=0;i<64;i++)o[i]=a[i]+1}
    export let f=()=>{const a=new Float64Array(64),o=new Float64Array(64);map(a,o);return o[3]}`
  const wat = compile(src, { wat: true, optimize: 'speed' })
  ok(/v128/.test(wat), 'helper loop vectorizes')
  ok(!/\(func \$map\b|call \$map\b/.test(wat), 'cosmetic SIMD markers do not pin an internal helper')
  is(run(src, { optimize: 'speed' }).f(), 1, 'inlined SIMD helper stays exact')
})

// plan/inline.js's `inlineHotInternalCalls` walks non-exported function bodies
// and passes them to `inlineInStmt`.

test('inliner preserves return value of an expr-bodied arrow whose entire body is a candidate call', () => {
  const { entry } = jz(`
    let leaf = () => 42
    let mid = () => leaf()
    export let entry = () => mid()
  `).exports
  is(entry(), 42)
})

test('inliner: expr-bodied arrow with arg-forwarding candidate', () => {
  const { entry } = jz(`
    let twice = (n) => n * 2
    let wrap = (n) => twice(n)
    export let entry = (n) => wrap(n)
  `).exports
  is(entry(21), 42)
})

test('inline: a callee returning a Math call splices into its loop site (a pure call commutes with the site\'s reads)', () => {
  if (onKernel() || belowOpt(2)) return
  const src = `
    const measure = (o) => { const k = o.k; if (k === 0) return (o.x + o.y) | 0; return Math.imul(o.r, 3) }
    export let f = (seed) => {
      const rows = []
      let s = seed | 0
      for (let i = 0; i < 64; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; const a = s & 1023; if ((s & 1) === 0) rows.push({ k: 0, x: a, y: i }); else rows.push({ k: 1, r: a }) }
      let sum = 0
      for (let i = 0; i < rows.length; i++) sum = (sum + measure(rows[i])) | 0
      return sum
    }`
  const wat = compile(src, { wat: true, optimize: 'speed' })
  ok(!/\(func \$measure/.test(wat), 'the callee is spliced away')
  // the spliced result is a number: no undefined-sentinel test turns it into a NaN before the sum
  is(loopCount(parseWat(wat), n => n[0] === 'i64.const' && /7FF80002/i.test(String(n[1]))), 0, 'no absent test on the spliced result')
  for (const seed of [1, 7, 12345]) is(run(src, { optimize: 'speed' }).f(seed), oracle(src).f(seed), `seed=${seed}`)
})

test('sourceInline preserves side effects of an expr-bodied callee at statement position', () => {
  // `setS = v => s = v` is an expression-bodied arrow whose BODY is the effect
  // (the assignment). Called as a statement (`setS(7);`), the result is unused —
  // but inlineHotInternalCalls used to splice only the prefix and DROP the value
  // expression, losing the `s = v` write. (This is what froze the self-compile parser:
  // its `seek = n => idx = n` stopped advancing `idx`, so comment-skip looped
  // forever.) The effect must survive inlining.
  const setter = run(`
    let s = 0
    let setS = (v) => s = v
    export const f = () => { setS(7); return s }`, { optimize: 2 })
  is(setter.f(), 7, 'assignment in inlined expr-body must run')

  // Same class via a one-liner that calls another fn for its effect.
  const viacall = run(`
    let n = 0
    let bump = () => n = n + 1
    let tick = () => bump()
    export const g = () => { tick(); tick(); tick(); return n }`, { optimize: 2 })
  is(viacall.g(), 3, 'nested effectful call in inlined expr-body must run')
})

// A `let`-declared arrow that is only ever called is a const to the local-lambda
// inliner: the floatbeat idiom `let s = (n, x) => …` compiles to the spliced
// body, not a closure with a per-call environment.
test('let-declared local arrows inline like const ones', () => {
  const src = `export let beat = (t) => { let A = 440; let s = (n, x) => (((t / 375 * A * (n + 1)) | 0) & (x | 0)) / 256; return s(2, (-t >> 8) & 255) + s(5, 127) }`
  const w = compile(src, { optimize: 'speed', wat: true })
  ok(!/closure|__alloc/.test(funcWat(w, 'beat')), 'no closure, no environment allocation')
  is(run(src).beat(1234.5), oracle(src).beat(1234.5))
})

test('a callee that throws stays a call in an arrow, which still splices into the function around it', () => {
  // The speed tier splices a body that throws into its caller. Into a local arrow it would
  // write a `throw`, and the arrow's own splice takes no body with one: the arrow would
  // stay a closure, its loop's bindings captured cells (test/iteration-release.js).
  const progs = {
    'a check called at a statement': `const check = (v) => { if (v > 50) throw new RangeError('past ' + v); return v + 1 }
      export let f = (n) => { let s = 0; const add = (k) => { s += check(k * 2) }; for (let i = 0; i < n; i++) add(i); return s }`,
    'a check called in the arrow\'s loop': `const check = (v) => { if (v > 50) throw new RangeError('past ' + v); return v + 1 }
      export let f = (n) => { let s = 0; const sum = (m) => { for (let k = 0; k < m; k++) s += check(k + m) }; for (let i = 0; i < n; i++) sum(i & 7); sum(n >> 1); return s }`,
    'through a callee that calls the one that throws': `const check = (v) => { if (v > 50) throw new RangeError('past ' + v); return v + 1 }
      const twice = (v) => check(v) + check(v + 1)
      export let f = (n) => { let s = 0; const add = (k) => { s += twice(k) }; for (let i = 0; i < n; i++) add(i); return s }`,
  }
  const outcome = (f, n) => { try { return f(n) } catch (e) { return `${e.constructor.name}: ${e.message}` } }
  for (const [name, src] of Object.entries(progs)) {
    const host = oracle(src)
    for (const optimize of levels(0, 1, 2, 3, 'size', 'speed')) {
      const m = run(src, { optimize })
      for (const n of [0, 1, 6, 30, 60]) is(outcome(m.f, n), outcome(host.f, n), `${name}, ${optimize}: f(${n})`)
    }
    ok(!/\(func \$(?!__)\S*closure\d/.test(compile(src, { optimize: 'speed', wat: true })), `${name}: no closure of the program is left at the speed tier`)
  }
})

test('a call carried into a spliced closure reads its arguments as the caller binds them', () => {
  // `sweep` is a local lambda the plan splices after the call inside it was
  // spliced; that call's argument seams (`const a = x`) were made while `x` was
  // a capture, and stay names for `x` in the caller: a typed array the lane
  // vectorizer reads, not a box.
  if (onKernel()) return
  const src = `function dot(N, x, y) { let s = 0; for (let i = 0; i < N; i++) s += x[i] * y[i]; return s }
    const fn = dot
    export let main = (n) => {
      const x = new Float64Array(n), y = new Float64Array(n)
      for (let i = 0; i < n; i++) { x[i] = i; y[i] = n - i }
      const out = new Float64Array(64)
      const sweep = () => { for (let i = 0; i < 64; i++) out[i] = fn(n - (i & 7), x, y) }
      for (let r = 0; r < 3; r++) sweep()
      return out[5]
    }`
  ok(/f64x2/.test(compile(src, { wat: true, optimize: { level: 'speed' } })), 'the spliced dot product vectorizes')
  is(jz(src, { optimize: { level: 'speed' } }).exports.main(100), oracle(src).main(100))
})

test('an argument a spliced loop tests is bound once before it, so the loop it bounds versions', () => {
  // `n - (i & 7)` is Number arithmetic over bindings nothing writes while `dot` runs,
  // but `dot` reads it in its loop's test: substituted there it is no bound of names,
  // and the versioning that takes the counter integral (and the lane vectorizer after
  // it) passed the loop by.
  if (onKernel()) return
  const src = `function dot(N, x, y) { let s = 0; for (let i = 0; i < N; i++) s += x[i] * y[i]; return s }
    const fn = dot
    export let main = (n) => {
      const x = new Float64Array(n), y = new Float64Array(n)
      for (let i = 0; i < n; i++) { x[i] = i; y[i] = n - i }
      const out = new Float64Array(64)
      for (let r = 0; r < 3; r++) for (let i = 0; i < 64; i++) out[i] = fn(n - (i & 7), x, y)
      return out[5]
    }`
  ok(/f64x2/.test(compile(src, { wat: true, optimize: { level: 'speed' } })), 'the spliced dot product vectorizes')
  is(jz(src, { optimize: { level: 'speed' } }).exports.main(100), oracle(src).main(100))
})

test('an argument a spliced loop body reads is bound once before the loop, so its guarded arm takes a word of it', () => {
  // `r * 0.5` is read once in the callee's text, at an index of its loop's body:
  // substituted there it is computed every iteration and no binding the guard can
  // prove whole, so the copy stayed a byte loop and the sums scalar.
  if (onKernel()) return
  const drive = (call) => `export let main = (m) => {
      const x = new Float64Array(256), y = new Float64Array(64)
      for (let i = 0; i < 256; i++) x[i] = i * 3 + 1
      let t = 0
      for (let r = 0; r < m; r++) t += ${call}
      return t
    }`
  const kernels = {
    'a copy lifts to memory.copy': [/memory\.copy/, `function take(src, at, n) { const out = new Float64Array(n); for (let k = 0; k < n; k++) out[k] = src[at + k]; let s = 0; for (let k = 0; k < n; k++) s += out[k] * k; return s }
      ${drive('take(x, r * 0.5, 64)')}`],
    'a window sum vectorizes': [/f64x2/, `function win(src, at, n) { let s = 0; for (let k = 0; k < n; k++) s += src[at + k]; return s }
      ${drive('win(x, r * 0.5, 64)')}`],
    'a scaled copy vectorizes': [/f64x2/, `function scale(src, dst, at, n) { for (let k = 0; k < n; k++) dst[k] = src[at + k] * 2; return dst[1] }
      ${drive('scale(x, y, r * 0.5, 64)')}`],
  }
  for (const [name, [shape, src]] of Object.entries(kernels)) {
    const text = compile(src, { wat: true, optimize: { level: 'speed' } })
    ok(!/\(func \$(take|win|scale)\b/.test(text) && shape.test(text), name)
    const m = jz(src, { optimize: { level: 'speed' } }).exports, host = oracle(src)
    for (const n of [0, 1, 2, 9]) is(m.main(n), host.main(n), `${name}: main(${n})`)
  }
})
