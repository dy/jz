// The optimize levels and per-pass switches, and pins of the generic passes: dead
// stores, copy and forward propagation, local slots, dead tables, effects.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { onKernel, levels, belowOpt } from './_matrix.js'
import { solveEffects, resolveOptimize, PASS_NAMES } from '../src/optimize/index.js'
import { EQ_ZERO_KERNEL } from './_optimizer-kernels.js'
import { optimize as watOptimize } from 'watr/optimize'
import parseWat from 'watr/parse'
import { run, oracle, jz, compile } from './util.js'
import { parse, count } from '../scripts/wat-probe.mjs'
import { findFunc, preWatr } from './_optimizer.js'

test('vectorizeLaneLocal: preserves stores inside void blocks', () => {
  const { main } = run(`
    export const main = () => {
      const state = new Int32Array(12)
      let s = 0x1234abcd | 0
      for (let i = 0; i < 12; i++) {
        s ^= s << 13
        s ^= s >>> 17
        s ^= s << 5
        state[i] = s
      }
      for (let i = 0; i < 12; i++) {
        let x = state[i] | 0
        x ^= x << 7
        x ^= x >>> 9
        x = Math.imul(x, 1103515245) + 12345
        state[i] = x ^ (x >>> 16)
      }
      return state[11] >>> 0
    }
  `)
  is(main(), 2805299282)
})

test('shared optimizer: eq-zero keeps dense-switch lowering and non-switch values across O0/O2/O3', () => {
  const ops = (fn, op) => count(fn, n => n[0] === op)
  for (const optimize of levels(0, 2, 3)) {
    // The speed tier splices the hot leaf into chain's loop (its scrutinee
    // then rides a tee, which watr's chainTable does not lower); the shape
    // under test is the standalone function's, so keep it out of the inliner.
    const structural = optimize === 3 ? { level: 3, sourceInline: false } : optimize
    const pre = parse(EQ_ZERO_KERNEL, preWatr(structural))
    const dispatch = findFunc(pre, '$dispatch')
    const masked = findFunc(pre, '$masked')
    const reversed = findFunc(pre, '$reversed')
    // `op`'s integer width is the call sites' (interval fixpoints, from level 2,
    // optimize/config.js): O0 compares the Number it receives.
    if (optimize !== 0) {
      is(ops(dispatch, 'i32.eq'), 5, `O${optimize}: all five dense-chain arms retain i32.eq(local,const)`)
      is(ops(dispatch, 'i32.eqz'), 0, `O${optimize}: the zero arm is not split from the dense chain`)
    }
    is(ops(masked, 'i32.eq'), 1, `O${optimize}: computed comparisons reach the shared optimizer`)
    is(ops(reversed, 'i32.eq'), 1, `O${optimize}: reversed comparisons reach the shared optimizer`)
    if (optimize !== 0) {
      const final = parse(EQ_ZERO_KERNEL, structural)
      is(ops(findFunc(final, '$masked') || findFunc(final, '$masked$exp'), 'i32.eqz'), 1, `O${optimize}: shared optimizer folds right-zero`)
      is(ops(findFunc(final, '$reversed') || findFunc(final, '$reversed$exp'), 'i32.eqz'), 1, `O${optimize}: shared optimizer folds left-zero`)
      is(count(final, n => n[0] === 'br_table'), 1,
        `O${optimize}: the complete dense chain reaches one br_table`)
    }

    const { chain, masked: runMasked, reversed: runReversed, main } = jz(EQ_ZERO_KERNEL, { optimize }).exports
    is(chain(0, 9), 0, `O${optimize}: zero-trip chain`)
    is(chain(7, 9), 439, `O${optimize}: all dense arms plus default execute correctly`)
    is(runMasked(-8), 101, `O${optimize}: computed right-zero true`)
    is(runMasked(7), 202, `O${optimize}: computed right-zero false`)
    is(runReversed(0), 303, `O${optimize}: computed left-zero true`)
    is(runReversed(-1), 404, `O${optimize}: computed left-zero false`)
    is(main(), 404, `O${optimize}: combined non-switch result`)
  }
})

test('resolveOptimize: levels, booleans, object overrides', () => {
  const level2 = resolveOptimize(true)
  const allOff = resolveOptimize(false)
  for (const n of PASS_NAMES) {
    is(level2[n], resolveOptimize(2)[n], `level true: ${n} matches level 2`)
    is(allOff[n], false, `level false: ${n} off`)
  }
  is(resolveOptimize(0).watr, false)
  is(resolveOptimize(0).treeshake, false)
  // Default (level 2) runs the full watr pipeline (inlineOnce + coalesce on;
  // `inline` stays off per watr's own default).
  is(resolveOptimize(2).watr, true)
  is(resolveOptimize(2).sourceInline, true)
  is(resolveOptimize(2).nestedSmallConstForUnroll, 'auto')
  // Level 3 keeps watr on, plus aggressive nested-unroll.
  is(resolveOptimize(3).watr, true)
  is(resolveOptimize(3).sourceInline, true)
  is(resolveOptimize(3).nestedSmallConstForUnroll, true)
  // level 1 = encoding-compactness only
  const l1 = resolveOptimize(1)
  is(l1.treeshake, true)
  is(l1.sortLocalsByUse, true)
  is(l1.coalesceLocals, true)
  is(l1.fusedRewrite, true)
  is(l1.watr, false)
  is(l1.hoistAddrBase, false)
  is(l1.hoistConstantPool, false)
  // object: level 0 base + watr override
  const o = resolveOptimize({ level: 0, watr: true })
  is(o.watr, true)
  is(o.treeshake, false)
  is(resolveOptimize({ level: 3, nestedSmallConstForUnroll: 'auto' }).nestedSmallConstForUnroll, 'auto')
  // undefined: default = level 2
  is(resolveOptimize(undefined).watr, true)
  is(resolveOptimize(undefined).sourceInline, true)
  is(resolveOptimize(undefined).nestedSmallConstForUnroll, 'auto')
  // string presets. 'balanced' was removed (it was a pure synonym for the default
  // level 2); a stray 'balanced' now FAILS like any unknown preset — the silent
  // level-2 fallback shipped the wrong pipeline on typos ('sped') with no signal.
  try { resolveOptimize('balanced'); ok(false, `removed 'balanced' must throw`) }
  catch (e) { ok(/optimize takes true, false, 'size' or 'speed'; got 'balanced'/.test(String(e.message)), `removed 'balanced' throws the unknown-preset error`) }
  const size = resolveOptimize('size')
  is(size.watr, true)
  is(size.smallConstForUnroll, false)
  is(size.nestedSmallConstForUnroll, false)
  is(size.vectorizeLaneLocal, false)
  is(size.treeshake, true)
  is(size.scalarTypedArrayLen, 8)
  is(size.scalarTypedLoopUnroll, 4)
  // 'speed' = level 3: everything on, including watr.
  const speed = resolveOptimize('speed')
  is(speed.watr, true)
  is(speed.vectorizeLaneLocal, true)
  is(speed.nestedSmallConstForUnroll, true)
  is(speed.smallConstForUnroll, true)
  // unknown string falls back to level 2
  try { resolveOptimize('bogus'); ok(false, `unknown preset must throw`) }
  catch (e) { ok(/optimize takes true, false, 'size' or 'speed'; got 'bogus'/.test(String(e.message)), `unknown preset throws`) }
  // object with string level base + override
  const sizePlusVec = resolveOptimize({ level: 'size', vectorizeLaneLocal: true })
  is(sizePlusVec.vectorizeLaneLocal, true)
  is(sizePlusVec.smallConstForUnroll, false)
  is(sizePlusVec.scalarTypedArrayLen, 8)

  // Pre-analyze loop transforms (compile/index.js) must be OFF at level 0/1 and ON at 2+.
  for (const n of ['loopIVDivMod', 'loopSquare', 'unrollRecurrence', 'clampPeel']) {
    is(resolveOptimize(0)[n], false, `${n} off at level 0`)
    is(resolveOptimize(1)[n], false, `${n} off at level 1`)
    is(resolveOptimize(2)[n], true, `${n} on at level 2`)
  }
  is(resolveOptimize('size').unrollRecurrence, false, 'unrollRecurrence stays off at size (×2 body = size regression)')
  is(resolveOptimize('speed').unrollRecurrence, true, 'unrollRecurrence on at speed')
  is(resolveOptimize('size').clampPeel, false, 'clampPeel stays off at size (edge-peel triples a stencil loop)')
  is(resolveOptimize('speed').clampPeel, true, 'clampPeel on at speed (vectorizes the clamp-free interior)')
  is(resolveOptimize('size').promoteGlobals, false, 'promoteGlobals off at size (global→local snapshot is dead size weight)')
  is(resolveOptimize('speed').promoteGlobals, true, 'promoteGlobals on at speed')
  is(resolveOptimize('size').hoistInvariantLoop, false, 'hoistInvariantLoop off at size (LICM entry temps cost bytes)')
  is(resolveOptimize('speed').hoistInvariantLoop, true, 'hoistInvariantLoop on at speed')
})

test('opts.optimize: false produces correct output (semantics preserved)', () => {
  const { main: fast } = run(
    `export const main = (n) => { let s = 0; for (let i = 0; i < n; i++) s = s + i*2; return s | 0 }`,
    { optimize: false }
  )
  is(fast(10), 90)
  const { main: full } = run(
    `export const main = (n) => { let s = 0; for (let i = 0; i < n; i++) s = s + i*2; return s | 0 }`,
    { optimize: 2 }
  )
  is(full(10), 90)
})

test('opts.optimize: size preset shrinks the scalar loop', () => {
  const src = `export const main = (n) => { let s = 0; for (let i = 0; i < n; i++) s = s + i*2; return s | 0 }`
  const off = compile(src, { optimize: false })
  const on = compile(src, { optimize: 'size' })
  ok(off.length >= on.length, `expected optimize:false (${off.length}) >= optimize:size (${on.length})`)
})

test('opts.optimize: object override gates per-pass', () => {
  // Disabling treeshake keeps unreachable funcs; binary should be ≥ default.
  const src = `
    const dead = () => 42
    export const main = (n) => n + 1
  `
  const sized = compile(src, { optimize: { treeshake: false } })
  const shaken = compile(src, { optimize: true })
  ok(sized.length >= shaken.length, `treeshake:false (${sized.length}) ≥ treeshake:true (${shaken.length})`)
})

test('dead-store elimination (watr): side-effecting RHS of an overwritten local must run', () => {
  // A small-constant warmup loop unrolls into N consecutive `cs = side()` writes
  // whose results are all overwritten before any read. Whatever pass removes the
  // dead stores (watr's, since jz's deadStoreElim was retired as subsumed) must
  // NOT delete those `local.set`s wholesale — `side()` mutates the array each call.
  const { main } = run(`
    const bump = (a) => { a[0] = a[0] + 1; return a[0] | 0 }
    export const main = () => {
      const a = new Int32Array(1)
      let cs = 0
      for (let i = 0; i < 5; i++) cs = bump(a)
      return a[0] | 0
    }
  `, { optimize: 2 })
  is(main(), 5)
})

// pass semantic-preservation pins
// Each pins one optimizer pass against a class of value-corrupting regression.
// Behavioural (run + assert), since the failure mode is a wrong runtime value.

test('zero-init drop (watr zeroinit): -0.0 initializer is preserved (not coerced to +0)', () => {
  // -0 and +0 share an i64/f64 zero bit pattern under `===`, but `1/-0` is
  // -Infinity. The zero-init drop must exclude -0.0 (locals default to +0.0).
  is(run('export let main = () => { let x = -0.0; return 1 / x }').main(), -Infinity)
  is(run('export let main = () => { let x = 0.0; return 1 / x }').main(), Infinity)
})

test('zero-init drop (watr zeroinit): i64 0n zero-init survives into later arithmetic', () => {
  // BigInt locals init to `i64.const 0`; the i32/f64 zero-init dropper must not touch the i64
  // slot.
  is(run('export let main = () => { let x = 0n; return Number(x + 5n) }').main(), 5)
})

test('specializeBimorphicTyped: one callee at both f64 and i32 sites stays correct', () => {
  // `add` is reached with float args from one export and int args from another;
  // specialization must not let either site read the other’s ABI.
  const ex = run(`
    let add = (a, b) => a + b
    export let f = () => add(1.5, 2.5)
    export let i = () => add(3, 4)
  `)
  is(ex.f(), 4)
  is(ex.i(), 7)
})

test('dead-store elimination (watr): a store whose value is read later must survive', () => {
  // a[0]=7 is read into x before being overwritten; eliminating it would drop x.
  is(run('export let main = () => { let a = [0, 0]; a[0] = 7; let x = a[0]; a[0] = 9; return x + a[0] }').main(), 16)
})

test('arenaRewind: an allocation that is returned must persist (no rewind)', () => {
  // `mk` allocates an array and returns it; arena rewind must not reclaim it
  // before the caller reads the elements.
  const ex = run(`
    let mk = () => { let a = [1, 2, 3]; return a }
    export let main = () => { let a = mk(); return a[0] + a[1] + a[2] }
  `)
  is(ex.main(), 6)
})

// The value-model lowering leaves local round-trips `$b = $a; $b = f($b)`; copy-prop
// rewrites the use to $a and the adjacent-dead-store pass drops the now-dead copy.
const watStr = n => JSON.stringify(n)

test('wat copy-prop: collapses a local copy round-trip, dropping the copy', () => {
  const mod = ['module',
    ['func', '$f', ['param', '$a', 'i32'], ['result', 'i32'],
      ['local', '$b', 'i32'],
      ['local.set', '$b', ['local.get', '$a']],
      ['local.set', '$b', ['i32.add', ['local.get', '$b'], ['i32.const', 1]]],
      ['local.get', '$b'],
    ],
  ]
  const out = watStr(watOptimize(mod, 'propagate locals'))
  ok(!out.includes('["local.get","$b"]'), 'every $b read folded away')
  ok(out.includes('["local.get","$a"]'), 'the add now reads the copy source $a directly')
  // The whole round-trip should collapse to the bare expression.
  ok((out.match(/local\.set/g) || []).length === 0, 'the dead copy + the temp set are gone')
})

test('wat copy-prop: a copy whose source is later reassigned is NOT propagated past it', () => {
  // $b = $a; $a = 9; use $b  →  $b must keep the OLD $a, so the copy may not fold to $a.
  const mod = ['module',
    ['func', '$f', ['param', '$a', 'i32'], ['result', 'i32'],
      ['local', '$b', 'i32'],
      ['local.set', '$b', ['local.get', '$a']],
      ['local.set', '$a', ['i32.const', 9]],
      ['i32.add', ['local.get', '$b'], ['local.get', '$a']],
    ],
  ]
  // Correctness via execution: run the same program through jz end-to-end.
  const ex = jz('export const f = (a) => { let b = a; a = 9; return (b + a) | 0 }')
  is(ex.exports.f(3), 12)   // 3 + 9, NOT 9 + 9
})

test('forward-propagation: typed-array global swap must survive (double-buffer idiom)', () => {
  // The canonical ping-pong swap `let s = f; f = g; g = s` over reassignable typed-array
  // module globals. forwardPropagate tracked `s = (global.get $f)` as a single-use copy but
  // had NO invalidation for the intervening `f = g` (global.set $f) — so it substituted the
  // now-stale `(global.get $f)` into `g = s`, collapsing it to `g = g` (a vacuumed self-store).
  // After the swap f AND g then aliased the SAME buffer, so a stencil sim (lbm) streamed into
  // the buffer it was reading → noise. purgeGlobalRefs on every global.set is the fix. Pin all
  // opt levels, both swap legs, and the cross-call persistence (the bug also breaks getG alone).
  const SRC = `
    let f = new Float64Array(2)
    let g = new Float64Array(2)
    export let init = () => { f[0] = 1.0; g[0] = 99.0 }
    export let swap = () => { let s = f; f = g; g = s }
    export let getF = (i) => f[i]
    export let getG = (i) => g[i]
  `
  for (const optimize of levels(null, 'size', 'speed')) {
    const { init, swap, getF, getG } = run(SRC, { optimize })
    init(); swap()
    is(getF(0), 99, `opt=${optimize}: f → old g (99)`)
    is(getG(0), 1,  `opt=${optimize}: g → old f (1)`)
  }
})

test('dead helper does not leak the Eisel-Lemire decimal table', () => {
  if (onKernel()) return  // needs host-side { modules } wiring + optimize:'size' (the kernel owns its pipeline and ignores both — it can't resolve './lib.js')
  // A dead lib export whose `arr[i] | 0` on an untyped param pulls __to_num →
  // __dec_to_f64 (consumer of the 10.4 KB power-of-10 table). watr treeshakes the dead
  // function but not the data segment, so the table used to bloat every such module.
  const lib = `export let used = (h, x) => ((h ^ (x | 0)) * 16777619) | 0
export let dead = (arr) => { let h = 0; for (let i = 0; i < arr.length; i++) h = used(h, arr[i]); return h }`
  const bytes = compile(
    `import { used } from './lib.js'\nexport let main = () => { let z = new Int32Array(4); z[0] = 7; return used(0, z[0]) }`,
    { modules: { './lib.js': lib }, optimize: 'size', alloc: false })
  ok(bytes.length < 1024, `module is ${bytes.length} B — decimal table (10.4 KB) leaked from a dead helper`)
})

test('post-watr dead conversion owners leave no orphaned numeric tables', async () => {
  if (onKernel()) return
  // This shape is still conservatively live before watr: dynamic HASH values flow
  // through an integer coercion while generated integer keys flow through ToString.
  const src = `const run = (words) => {
    const counts = {}
    for (let i = 0; i < words.length; i++) {
      const w = words[i]
      counts[w] = (counts[w] | 0) + 1
    }
    return counts['a'] | 0
  }
  export let main = () => {
    const words = []
    for (let j = 0; j < 8; j++) words.push('zz' + j)
    words.push('a')
    return run(words)
  }`
  const bytes = compile(src, { optimize: 'size', alloc: false })
  ok(bytes.length < 6000, `module is ${bytes.length} B — post-watr numeric tables leaked`)
  const { instance } = await WebAssembly.instantiate(bytes)
  is(instance.exports.main(), 1, 'stripping orphaned ranges preserves the live HASH result')
})

test('live runtime decimal parsing keeps the Eisel-Lemire table (no false strip)', () => {
  // The dual: Number() on a runtime string IS live, so __dec_to_f64 must keep its table.
  // The module carries the 10.4 KB table and instantiates.
  const src = `let toNum = (s) => Number(s)\nexport let main = (s) => { let a = new Float64Array(2); a[0] = toNum(s); return a[0] }`
  const bytes = compile(src, { optimize: 'size', alloc: false })
  ok(bytes.length > 2048, `module is ${bytes.length} B — table wrongly stripped from live Number()`)
  new WebAssembly.Module(bytes)   // throws if the strip left a dangling reference
})

test('local slots: lightweight cleanup bounds recursive frames', () => {
  // Sequential property operations create disjoint address/value temporaries.
  // Without coalescing, 48 stores leave 336 locals and overflow the stack at
  // roughly 512 calls on Node; slot count pins the cause independently of V8.
  const src = `export function visit(a, n) { if (n <= 0) return 0;
    ${'a[0] = (a[0] || 0) + 1;'.repeat(48)}
    return visit(a, n - 1) + 1 }
    export function main(n) { const a = new Float64Array(1); return visit(a, n) + a[0] }`
  const locals = optimize => findFunc(parseWat(compile(src, { optimize, wat: true })), '$visit')
    .filter(n => n[0] === 'local').length
  const baseline = locals({ level: 1, coalesceLocals: false })
  for (const optimize of levels(1, 'fast')) {
    ok(locals(optimize) < baseline / 4, `${optimize}: disjoint lifetimes share slots`)
    const { main } = jz(src, { optimize }).exports
    for (const n of [0, 1, 1024, 1024, 3, 0])
      is(main(n), n * 49, `${optimize}: fresh frame at depth ${n}`)
  }
})

test('propagateLocals: forwards single-use temps and tees the first of multiple uses', () => {
  // jz emits short-lived address/index temps; the shared pass (watr/optimize
  // `propagate`) forwards a pure single-use temp into its use and sinks a
  // multi-use single-def into a tee at its first use. Structure at `watr: false`,
  // where the shared local cleanup is the only propagation.
  const wat = (src, opt) => {
    const fn = findFunc(parseWat(compile(src, { wat: true, optimize: { ...opt, coalesceLocals: false } })), '$f')
    ok(fn, 'inspect the user function, not runtime helper locals')
    return JSON.stringify(fn)
  }
  const count = (w, re) => (w.match(re) || []).length
  const temp = `export let f = x => { let t = x + 1; return t + 3 }`
  const on = wat(temp, { level: 2, watr: false }), off = wat(temp, { level: 2, watr: false, propagateLocals: false })
  ok(count(on, /\["local",/g) < count(off, /\["local",/g), 'the user temp is forwarded')
  const multi = `export let f = (x, y) => { let p = x * y; return p + p * 2 }`
  const onM = wat(multi, { level: 2, watr: false }), offM = wat(multi, { level: 2, watr: false, propagateLocals: false })
  ok(count(onM, /\["local.get",/g) < count(offM, /\["local.get",/g), 'the user function loses a get')
  ok(/\["local.tee",/.test(onM), 'the user function emits a local.tee')

  // Compare to JS, not just another configuration of the compiler. Each call
  // gets fresh input buffers: one execution must not prepare the next oracle.
  const cloneArgs = args => args.map(x => ArrayBuffer.isView(x) ? x.slice() : x)
  for (const [s, args] of [
    [temp, [[0], [-1], [7], [NaN], [Infinity], [-Infinity]]],
    [multi, [[0, 1], [-1, 0], [3, 4], [NaN, 1], [Infinity, 1]]],
    [`export let f = (a, n) => { let acc = 0; for (let i = 0; i < n; i++) { let k = i * 3 + 1; acc = (acc + k) | 0 } return acc | 0 }`, [[0, 0], [0, 1], [0, 7]]],
    [`export let f = () => { try { throw "err" } catch (e) { return e.length } }`, [[]]],
    [`export let f = (buf, n) => { let s = 0; for (let i = 0; i < n; i++) s += buf[i] * 2; return s }`, [[new Float64Array(0), 0], [new Float64Array([1]), 1], [new Float64Array([1, 2, 3, 4]), 4]]],
    [`export let f = (n) => { let b = new Float64Array(n); return b.length }`, [[0], [1], [5]]],
    [`export let f = (a, c) => { let p = a[0] + a[1]; let r = p; if (c) r = p * 2; return r }`, [[new Float64Array([3, 4]), 0], [new Float64Array([3, 4]), 1]]],
    [`export let f = (a) => { let v = a[0]; a[0] = 99; return v + a[0] }`, [[new Float64Array([7])]]],
    [`export let f = (a, n) => { let k = a[0] * 2; let s = 0; for (let i = 0; i < n; i++) s += k; return s }`, [[new Float64Array([5]), 0], [new Float64Array([5]), 1], [new Float64Array([5]), 3]]],
    // an argument stored into and read back takes a float array (README: in-place array arguments)
    [`export let f = (a, d) => { let q = (100 / d) | 0; a[0] = 7; return q + a[0] }`, [[new Float64Array([0]), 0], [new Float64Array([0]), 5]]],
  ]) {
    const js = oracle(s).f
    for (const level of [{ level: 1 }, { level: 2, watr: false }, { level: 'fast' }, { level: 2 }, { level: 'speed' }]) {
      const onF = jz(s, { optimize: level }).exports.f
      const offF = jz(s, { optimize: { ...level, propagateLocals: false } }).exports.f
      for (const a of args) {
        const expectedArgs = cloneArgs(a), onArgs = cloneArgs(a), offArgs = cloneArgs(a)
        const expected = js(...expectedArgs)
        const actual = onF(...onArgs), disabled = offF(...offArgs)
        is(actual, expected, `shared propagation: ${JSON.stringify(level)}`)
        is(disabled, expected, `early propagation disabled: ${JSON.stringify(level)}`)
        // Generic host values are copy-in. Observe persistent writes inside the
        // module in the stateful test below, rather than requiring copy-back here.
      }
    }
  }
})

test('propagateLocals: loads and persistent writes remain ordered across calls', () => {
  const src = `const b = new Float64Array([7]);
    export function f(n) { const v = b[0]; b[0] = n; return v }
    export const state = () => b[0]`
  for (const optimize of ['fast', {level: 'fast', propagateLocals: false},
    {level: 2, watr: false}, 2, 3]) {
    const js = oracle(src)
    const wasm = jz(src, { optimize }).exports
    const observe = ex => [7, 7, 99, 0, -0, 7].map(n => [ex.f(n), ex.state()])
    is(observe(wasm), observe(js), `${JSON.stringify(optimize)}: A → A → B, zero and signed zero`)
  }
})

test('propagateLocals: abrupt values preserve operand order and state before recovery', () => {
  const src = `let trace = 0; const b = new Float64Array([7]);
    const left = () => { trace = trace * 10 + 1; return 100n }
    const right = d => { trace = trace * 10 + 2; return BigInt(d) }
    export function f(d) { trace = 0; b[0] = 7; const v = left() / right(d);
      b[0] = 99; trace = trace * 10 + 3; return v + BigInt(b[0]) }
    export const state = () => String(b[0]) + ':' + trace`
  const observe = (f, arg) => {
    try { return ['value', f(arg)] }
    catch (e) { return ['throw', e.name] }
  }
  for (const optimize of [{ level: 'fast' }, { level: 'fast', propagateLocals: false },
    { level: 2, watr: false }, { level: 2 }, { level: 3 }]) {
    const js = oracle(src)
    const wasm = jz(src, { optimize }).exports
    const args = ['4', '4', '0', 'bad', '4']
    // Capture each state before recovery, even when its result is already wrong.
    const actual = args.map(arg => [observe(wasm.f, arg), wasm.state()])
    const expected = args.map(arg => [observe(js.f, arg), js.state()])
    is(actual, expected, `${JSON.stringify(optimize)}: repeat, zero divisor, invalid BigInt, recovery`)
  }
})

// Separate tests keep one missing schema from hiding the sibling producer paths.
for (const src of [
    'const o = {a: 7, b: undefined, c: null}; export const f = () => o',
    'export const f = n => ({a: n, b: undefined, c: null})',
    'export const f = n => n ? {a: n} : null',
    ...['Error', 'TypeError', 'RangeError'].map(name => `export function f() { throw new ${name}("message") }`),
]) for (const optimize of ['fast', {level: 2, watr: false}, 2, 3]) {
  test(`propagateLocals: schema metadata: ${JSON.stringify(optimize)}: ${src}`, () => {
    const observe = (f, n) => {
      try { return ['value', f(n)] }
      catch (e) { return ['throw', e.name, e.message] }
    }
    const js = oracle(src).f
    const wasm = jz(src, { optimize }).exports.f
    is([0, 1, 1, 0].map(n => observe(wasm, n)), [0, 1, 1, 0].map(n => observe(js, n)),
      `${JSON.stringify(optimize)}: ${src}`)
  })
}

test('vectorizer const-exponent pow arm: AoS pure-fn ** with module-const exponent compiles at every tier (colorpq shape)', () => {
  if (belowOpt(2)) return  // tier bit-identity premise needs BOTH sides vectorized — the opt0 leg forces the default side scalar
  // Regression: the arm's crPow branch read the optimize config off the LIFT ctx, which never
  // carries it (`ctx.transform` undefined → TypeError at compile). Reaching the arm needs the
  // exact colorpq shape: a pure fn kept as a call (multi-site, so sourceInline declines),
  // inlined only DURING lift, its const exponent found via ctx.constLocals inside an AoS
  // interleaved-channel loop.
  const src = `
    const spow = (a, e) => { const s = a < 0 ? -1 : 1, av = a < 0 ? -a : a; return s * av ** e }
    const nv = 2610 / 16384, p = 1.7 * 2523 / 32, c1 = 3424 / 4096, c2 = 2413 / 128, c3 = 2392 / 128
    const kernel = (src, dst, n) => {
      for (let i = 0; i < n; i++) {
        const L = src[i * 3], M = src[i * 3 + 1], S = src[i * 3 + 2]
        const tl = spow(L / 10000, nv), tm = spow(M / 10000, nv), ts = spow(S / 10000, nv)
        const PL = spow((c1 + c2 * tl) / (1 + c3 * tl), p)
        const PM = spow((c1 + c2 * tm) / (1 + c3 * tm), p)
        const PS = spow((c1 + c2 * ts) / (1 + c3 * ts), p)
        dst[i * 3] = PL; dst[i * 3 + 1] = PM; dst[i * 3 + 2] = PS
      }
    }
    const a = new Float64Array(96), d = new Float64Array(96)
    export let f = () => {
      for (let i = 0; i < 96; i++) a[i] = i * 31.7 + 1
      kernel(a, d, 32)
    }
    export let g = (k) => d[k]`
  // Element-wise bit comparison (a float-sum checksum would confound this with the speed
  // tier's reassociated vector reduction).
  const dump = (opt) => {
    const ex = jz(src, opt ? { optimize: opt } : undefined).exports
    ex.f()
    return Array.from({ length: 96 }, (_, k) => ex.g(k))
  }
  is(dump(), dump('speed'), 'default-tier lift lowering (exp_v(c·log_v x)) is bit-identical to the speed-tier emit lowering')
  is(dump({ level: 2, crPow: true }), dump({ level: 'speed', crPow: true }), 'pow_fold_v (lift) is bit-identical to pow_fold (emit)')
})

test('effects: the SCC bitsets close cycles and indirect calls', () => {
  const funcs = [
    ['func', '$a', ['call', '$b']],
    ['func', '$b', ['global.set', '$x', ['i32.const', 1]], ['call', '$a']],
    ['func', '$c', ['call', '$a']],
    ['func', '$d'],
    ['func', '$e', ['call_indirect', '$ft', ['i32.const', 0]]],
    ['func', '$ywriter', ['global.set', '$y', ['i32.const', 1]]],
  ]
  const fx = solveEffects(funcs)
  ok(fx.sets('$a', '$x') && fx.sets('$b', '$x') && fx.sets('$c', '$x'),
    'one direct write propagates through an SCC and its caller')
  ok(!fx.sets('$d', '$x') && !fx.sets('$d', '$y'), 'no-effect function keeps the shared empty row')
  ok(fx.sets('$e', '$x') && fx.sets('$e', '$y'), 'indirect call conservatively reaches every written global')
})
