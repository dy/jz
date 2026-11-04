// Minimal-output invariants — every emitted construct must be mapped to something
// the source actually needs. A constant carries no `__start`; a heap-free program
// carries no memory/allocator; the allocator (`__jz_alloc`/`__jz_clear` + `__alloc`/
// `__memgrow`/…) appears only when the program allocates. These pin the wins and
// guard against the boilerplate creeping back. Baseline: smaller than AssemblyScript.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import parseWat from 'watr/parse'
import { onWasi, onKernel, levels, adaptI64 } from './_matrix.js'
import { scalarCase } from './_scalar-core-cases.js'
import { oracle, compile, jz, funcWat } from './util.js'
import { ctx } from '../src/ctx.js'
import { dropSettledTests } from '../src/optimize/settled-tests.js'

// These pin the *default JS-host* output shape. WASI wraps every module in command
// boilerplate (a `_start` export, fd imports) and the self-compile kernel owns its own
// pipeline, so the bare-minimal expectations below don't apply there.
const skip = onWasi() || onKernel()

// Structural probes over WAT text — coarse but exactly what "did we emit X?" means.
const wat = (src, optimize = 0) => compile(src, { wat: true, optimize })
const has = (src, frag, O) => wat(src, O).includes(frag)
const hasMemory = (src, O) => has(src, '(memory', O)
const hasAllocator = (src, O) => has(src, '_alloc', O)        // __jz_alloc/__jz_clear exports + __alloc
const hasStart = (src, O) => has(src, '$__start', O)
const hasData = (src, O) => has(src, '(data', O)

// === Constants never need a start function ===
// A const initialised to a compile-time value belongs in the global decl, inline
// and immutable — not assigned at runtime in `__start`. True for every primitive
// shape, including the NaN-boxed ones (atoms, SSO strings) that aren't plain i32/f64.
const CONST_PRIMITIVES = {
  number: 'export const x = 42',
  float: 'export const x = 3.14',
  'boolean true': 'export const x = true',
  'boolean false': 'export const x = false',
  null: 'export const x = null',
  undefined: 'export const x = undefined',
  NaN: 'export const x = NaN',
  Infinity: 'export const x = Infinity',
  'SSO string (≤4 ascii)': "export const x = 'abc'",
  'folded string concat': "export const x = 'a' + 'b'",
  'folded arithmetic': 'export const x = 2 * 3 + 1',
}
for (const [name, src] of Object.entries(CONST_PRIMITIVES)) {
  test(`minimal: const ${name} — no __start`, () => {
    if (skip) return
    for (const O of levels(0, 2)) {
      ok(!hasStart(src, O), `${name} @O${O}: a constant must not run in __start`)
    }
  })
}

// === Heap-free programs expose no memory and no allocator ===
// Numbers, booleans, atoms and SSO strings live entirely in f64 registers. Nothing
// touches linear memory, so there is no `(memory)`, no allocator, no data segment.
const HEAP_FREE = {
  'numeric const': 'export const x = 42',
  'SSO string const': "export const x = 'hi'",
  'atom const': 'export const x = null',
  'numeric fn': scalarCase('minimal-numeric-fn').source,
  'boolean fn': 'export const f = (a) => a > 0',
}
for (const [name, src] of Object.entries(HEAP_FREE)) {
  test(`minimal: heap-free ${name} — no memory/allocator`, () => {
    if (skip) return
    for (const O of levels(0, 2)) {
      ok(!hasMemory(src, O), `${name} @O${O}: heap-free program must not declare memory`)
      ok(!hasAllocator(src, O), `${name} @O${O}: heap-free program must not pull the allocator`)
    }
  })
}

// === Static strings: data segment, no allocator ===
// A string literal too long for SSO lands in a static data segment with a constant
// pointer. The segment needs memory, but nothing allocates — so no `__jz_alloc`/`__jz_clear`
// and (the pointer being constant) no `__start`.
test('minimal: static string — data segment, no allocator, no __start', () => {
  if (skip) return
  const src = "export const s = 'a string longer than four bytes'"
  ok(hasMemory(src), 'static string needs memory for its data segment')
  ok(hasData(src), 'static string lives in a data segment')
  ok(!hasAllocator(src), 'a static string allocates nothing')
  ok(!hasStart(src), 'a constant pointer needs no runtime init')
})

// === The allocator appears only when the program actually allocates ===
test('minimal: runtime string concat pulls the allocator', () => {
  if (skip) return
  // `s + '!'` builds a fresh string at runtime → genuine allocation.
  ok(hasAllocator("export let f = (s) => s + '!'"), 'runtime concat must allocate')
})
test('minimal: pure numeric module pulls no allocator', () => {
  if (skip) return
  ok(!hasAllocator(scalarCase('minimal-pure-numeric').source), 'arithmetic never allocates')
})

test('minimal: alloc:false omits the uncallable arena-reset heal protocol', () => {
  if (skip) return
  const src = 'export let f = () => { const a = []; a.push(1); return a.length }'
  const normal = wat(src, 'size')
  const standalone = compile(src, { wat: true, optimize: 'size', alloc: false })
  ok(normal.includes('$__durable_arr_snap'), 'ordinary output keeps _clear-time durable-array healing')
  ok(!standalone.includes('$__durable_arr_snap'), 'without allocator/reset exports no heal consumer exists')
  ok(!standalone.includes('$__durable_fwd_log'), 'header logging is absent with its reset consumer')
})

// === No emitted compiler-internal function is dead ===
// Every `$__foo` / `$math.foo` helper in the binary must be *reached* (called, in the elem
// table, or exported). An eager include or a dead-branch dependency that nothing actually
// calls is pure over-production — e.g. string concat used to ship the alloc trio's
// `__alloc_hdr` (which it never calls) and a stray `__str_len`. Holds at every opt level.
const deadInternalFuncs = (w) => {
  const internal = (n) => typeof n === 'string' && n !== '$__start' && (n.startsWith('$__') || /^\$[a-z_]+\./.test(n))
  const defined = parseWat(w).slice(1).filter(n => n[0] === 'func' && internal(n[1]) &&
    !n.some(p => Array.isArray(p) && p[0] === 'export')).map(n => n[1])
  // A defined helper that appears exactly once in the module text is referenced nowhere but
  // its own definition — dead. Inline exports above are roots without a second name;
  // other real references (call/elem/separate export) make the count ≥ 2.
  return defined.filter((fn) => (w.match(new RegExp('\\' + fn + '(?![\\w.])', 'g')) || []).length <= 1)
}
test('minimal: dead-helper probe recognizes inline and separate export roots', () => {
  is(deadInternalFuncs(`(module (func) (func $__dead)
    (func $__inline (export "inline"))
    (func $__separate) (export "separate" (func $__separate))
    (func $__called) (func $main (call $__called)))`), ['$__dead'])
})
const NO_DEAD = {
  'string concat': "export let f = (s) => s + '!'",
  'untyped property read': 'export let f = (o) => o.x',
  'untyped index read': 'export let f = (a, i) => a[i]',
  'array push': 'export let f = (n) => { let a = []; a.push(n); return a }',
  'number to string': 'export let f = (n) => String(n)',
  'object literal return': 'export let f = (n) => ({ x: n, y: n * 2 })',
}
for (const [name, src] of Object.entries(NO_DEAD)) {
  test(`minimal: ${name} emits no dead internal func`, () => {
    if (skip) return
    for (const O of levels(0, 2)) {
      const dead = deadInternalFuncs(wat(src, O))
      is(dead.length, 0, `${name} @O${O}: dead internal funcs — ${dead.join(', ')}`)
    }
  })
}

// === Hot-loop leaf helpers inline (no per-iteration call tax) ===
// A leaf with no loop of its own, ≤2 call sites, all inside a caller's loop, is spliced
// in — V8's pre-Turboshaft wasm tiers never inline cross-function, so an out-of-line call
// here is a hard per-iteration cost. This pins the loop-sited-leaf size budget in
// plan/inline.js: a ~160-node helper like cloth's `relax` (a sqrt + a handful of array
// writes, fired per link) must fold into the loop, not survive as a `call`. Guards the
// in-loop cap against creeping back down below the medium-helper range.
test('minimal: medium leaf called in a hot loop inlines', () => {
  if (skip) return
  const src = `
    let arr
    let relaxish = (a, b) => {
      let dx = arr[b] - arr[a], dy = arr[b + 1] - arr[a + 1]
      let d = Math.sqrt(dx * dx + dy * dy) + 0.0001
      let k = (d - 10.0) / d * 0.5
      let mx = dx * k, my = dy * k
      arr[a] = arr[a] + mx; arr[a + 1] = arr[a + 1] + my
      arr[b] = arr[b] - mx; arr[b + 1] = arr[b + 1] - my
    }
    export let step = (n) => { let i = 0; while (i < n) { relaxish(i, i + 2); relaxish(i, i + 4); i = i + 2 } }
    export let setup = (n) => { arr = new Float64Array(n); return arr }
  `
  for (const O of levels(2, 'speed')) {
    ok(!has(src, 'call $relaxish', O), `@O${O}: a hot-loop leaf helper must inline, not stay a call`)
  }
})

// === Empty / trivial programs ===
test('minimal: empty program is an empty module', () => {
  if (skip) return
  is(wat(scalarCase('empty-module').source).replace(/\s+/g, ' ').trim(), '(module)')
})
test('minimal: dead pure expression statement is eliminated at O2', () => {
  if (skip) return
  is(wat('1 + 2;', 2).replace(/\s+/g, ' ').trim(), '(module)')
})

// === Constant aggregates: static data segment, no allocator ===
// An all-literal array (≥4 elems) or object literal is a compile-time constant living in
// a static data segment behind a const pointer, like a static string. Nothing allocates,
// so no `__jz_alloc`/`__jz_clear`. Reachability-gated: an array/object module load no longer drags
// the allocator in wholesale — only a *reached* allocator does, and a module-scope const
// reaches none. (≤3-element arrays are excluded — see the known-gap below.)
const CONST_AGGREGATES = {
  'small array': 'export const x = [1, 2, 3]',
  'single-element array': 'export const x = [42]',
  'larger array': 'export const x = [1, 2, 3, 4, 5, 6]',
  'object literal': 'export const x = { a: 1, b: 2 }',
}
for (const [name, src] of Object.entries(CONST_AGGREGATES)) {
  test(`minimal: const ${name} — data segment, no allocator`, () => {
    if (skip) return
    ok(hasData(src), `${name}: a constant aggregate lives in a data segment`)
    ok(!hasAllocator(src), `${name}: a constant aggregate allocates nothing`)
  })
}

// === Fully-static template literals fold to one string constant ===
// `a${123}b`, `hello ${1+2} world` — every interpolation is a compile-time constant, so
// prepare folds the template to a single literal (static data segment / SSO box), with no
// runtime concat and no heap machinery. A dynamic interpolation still concatenates.
const STATIC_TEMPLATES = {
  'number interp': 'export const x = `a${123}b`',
  'arithmetic interp': 'export const x = `hello ${1 + 2} world`',
  'sso result': 'export const x = `${2 * 3}x`',
}
for (const [name, src] of Object.entries(STATIC_TEMPLATES)) {
  test(`minimal: static template (${name}) — no allocator`, () => {
    if (skip) return
    ok(!hasAllocator(src), `${name}: a fully-static template allocates nothing`)
  })
}

// === Flat-object typed slots specialize — no polymorphic ToNumber/string battery ===
// A non-escaping object literal is SRoA'd into scalar locals, and a write-once slot
// carries its initializer's value-type (kind.js `VT['.']`). So arithmetic on a numeric
// slot — `p.x * 2`, `p.x * p.y` — stays a plain f64 op, never the ToNumber + ftoa +
// str_concat battery (and its allocator) that an *untyped* property read drags in.
// Without the slot-type binding these scalarized objects ballooned ~75 B → ~5.9 KB.
// (A reassigned slot stays conservative — its runtime value may differ; see fuzz.)
const TYPED_SLOTS = {
  'literal slot product': 'export let f = () => { let p = { x: 5 }; return p.x * 2 }',
  'expression slot product': 'export let f = (n) => { let p = { x: n * 1 }; return p.x * 2 }',
  'int-coerced param slot': 'export let f = (n) => { let p = { x: n | 0 }; return p.x * 2 }',
  'two numeric slots': 'export let f = (n) => { let p = { x: n | 0, y: 3 }; return p.x * p.y }',
}
for (const [name, src] of Object.entries(TYPED_SLOTS)) {
  test(`minimal: flat-object ${name} — no ToNumber/allocator`, () => {
    if (skip) return
    for (const O of levels(0, 2)) {
      ok(!has(src, '$__to_num', O), `${name} @O${O}: a numeric slot must not pull ToNumber`)
      ok(!hasAllocator(src, O), `${name} @O${O}: a scalarized numeric object allocates nothing`)
    }
  })
}

// === Function-local array literals stay fresh per call (no static aliasing) ===
// The static-data path is module-scope-only: a function-local literal that is mutated in
// place must NOT alias a shared region, or the mutation leaks across calls. (Imported,
// not run via WAT probes — this is a value-correctness invariant.)
test('minimal: function-local mutated array is fresh each call', () => {
  if (skip) return
  const g = jz('export let g = () => { let a = [1,2,3,4]; a[0] = a[0] + 1; return a }').exports.g
  is(JSON.stringify(g()), '[2,2,3,4]', 'call 1')
  is(JSON.stringify(g()), '[2,2,3,4]', 'call 2 must not see call 1’s mutation')
})

// === Small function-local literal arrays scalarize — no memory, no allocator ===
// A non-escaping, fixed-length array of compile-time-constant values, indexed only by
// static integers, dissolves into scalar `a#i` locals (flatObjectCandidate, same machinery
// as flat objects). No heap, no `(memory)`, no allocator — `let a=[1,2,3]; a[0]+a[2]`
// is just two local reads. Bounded to FLAT_ARRAY_MAX elements; a constant element only.
const FLAT_ARRAYS = {
  'single element': 'export let f = () => { let a = [42]; return a[0] }',
  'three reads': 'export let f = () => { let a = [1, 2, 3]; return a[0] + a[1] + a[2] }',
  'in-bounds write': 'export let f = () => { let a = [1, 2]; a[0] = 9; return a[0] + a[1] }',
  'string elements': 'export let f = () => { let a = ["ab", "cd"]; return a[1] }',
}
for (const [name, src] of Object.entries(FLAT_ARRAYS)) {
  test(`minimal: flat array ${name} — no memory/allocator`, () => {
    if (skip) return
    for (const O of levels(0, 2)) {
      ok(!hasMemory(src, O), `${name} @O${O}: a scalarized array needs no memory`)
      ok(!hasAllocator(src, O), `${name} @O${O}: a scalarized array allocates nothing`)
    }
  })
}
// Scalarization is conservative: anything that isn't a plain positional read/write of a
// constant-valued slot keeps the array heap-backed (correctness over minimalism). A
// `.length` resize, a function/closure element (would desync the call-indirect table),
// a dynamic index, or a runtime-valued element all fall back to a real array.
test('minimal: scalarization-ineligible arrays stay correct', () => {
  if (skip) return
  is(JSON.stringify(jz('export let g = () => { let a = [5,6]; a[0]++; return a[0] }').exports.g()), '6', 'fresh per call')
  is(jz('export let g = () => { let a = [1,2,3]; a.length = 1; return a.length }').exports.g(), 1, '.length resize stays an array')
  is(jz('export let g = () => { let f=()=>1,h=()=>2; let a=[f,h]; return a[0]()+a[1]() }').exports.g(), 3, 'function elements call correctly')
  is(jz('export let g = (n) => { let a=[n,n*2]; return a[0]+a[1] }').exports.g(5), 15, 'runtime-valued elements')
})

// === Static aggregate element access folds to a constant ===
// A module-scope const/let/var aggregate whose every reference is a static READ is
// replaced by its literal element/property value program-wide — `var x=[1,2,3];
// y=x[0]` becomes `y=1`. The array is never built: no `(data`, no `(memory`, and no
// `__arr_idx_known`/`__ptr_offset` index helper. Holds for arrays and objects, and
// across function bodies that read the binding.
const FOLD_AGGREGATES = {
  'const array index': 'const x = [1, 2, 3]\nexport const y = x[0]',
  'let array index': 'let x = [1, 2, 3]\nexport const y = x[1]',
  'var array index': 'var x = [1, 2, 3]\nexport const y = x[2]',
  'const object prop': 'const o = { a: 1, b: 2 }\nexport const y = o.a',
  'array read from fn': 'const x = [10, 20]\nexport const f = () => x[0] + x[1]',
}
for (const [name, src] of Object.entries(FOLD_AGGREGATES)) {
  test(`minimal: static ${name} — folds to constant`, () => {
    if (skip) return
    ok(!hasData(src), `${name}: a folded aggregate needs no data segment`)
    ok(!hasMemory(src), `${name}: a folded aggregate needs no memory`)
    ok(!has(src, '__arr_idx', 0), `${name}: a folded access needs no array-index helper`)
  })
}
// Conservative: anything that isn't a static read keeps the aggregate heap-backed
// (correctness over folding). Reassignment, element writes, exporting the aggregate,
// dynamic indices, escapes (passed as a value) and spreads all disqualify.
const NO_FOLD = {
  'reassigned': 'var x = [1, 2, 3]\nx = [9]\nexport const y = x[0]',
  'element write': 'var x = [1, 2, 3]\nx[0] = 9\nexport const y = x[0]',
  'exported aggregate': 'export const x = [1, 2, 3]\nexport const y = x[0]',
  'escapes as arg': 'const sum = (a) => a[0]\nconst x = [4, 5]\nexport const y = sum(x)',
}
for (const [name, src] of Object.entries(NO_FOLD)) {
  test(`minimal: ${name} aggregate stays heap-backed`, () => {
    if (skip) return
    ok(hasData(src), `${name}: a non-static-read aggregate must remain a real aggregate`)
  })
}

test('minimal: aggregate scans distinguish every declaration in a list', () => {
  for (const [init, read] of [['[3, 5]', 'x[1]'], ['{ a: 3, b: 5 }', 'x.b']]) {
    const src = `const x = ${init}
      export function f(n) { let before = n, x = ${init}, after = n + 1; ${read} = before + after; return ${read} }
      export function g() { return ${read} }`
    for (const optimize of levels(0, 2, 3)) {
      const ex = jz(src, { optimize }).exports
      for (const n of [0, 2, 2, -1, 0]) {
        is(ex.f(n), 2 * n + 1, 'a non-leading local declaration owns its writes')
        is(ex.g(), 5, 'the module aggregate keeps its own value')
      }
    }
  }
})

test('minimal: failed static aggregate candidates emit each element once', () => {
  const cases = [
    ['[next(), [next(), x => x + n]]', '10 * a[0] + a[1][0] + a[1][1](x)'],
    ['{ first: next(), inner: { second: next(), call: x => x + n } }', '10 * a.first + a.inner.second + a.inner.call(x)'],
    ['{ first: next(), inner: [next(), x => x + n] }', '10 * a.first + a.inner[0] + a.inner[1](x)'],
  ]
  for (const [init, read] of cases) for (const optimize of levels(0, 1, 2, 3)) {
    const src = `let n = 0
      function next() { return ++n }
      const a = ${init}
      export function f(x) { return ${read} }
      export function count() { return n }`
    const ex = jz(src, { optimize }).exports
    if (!onKernel()) is(ctx.closure.bodies.length, 1, 'one source closure is registered once, including speculative static construction')
    is(ex.count(), 2, 'initializers run once, in source order')
    for (const x of [0, 3, 3, -1, 0]) {
      is(ex.f(x), x + 14, 'nested literals retain their evaluation order, stored values and callable')
      is(ex.count(), 2, 'calls do not repeat module initialization')
    }
  }
})

// === Never-relocated arrays skip the realloc-forwarding follow ===
// A fresh array literal whose every use is a pure read (`a[i]` / `a.length`) can never
// be grown, so its index reads derive the base directly — no `__ptr_offset` forwarding
// chase. The SAFETY INVARIANT is the converse: any array that COULD be relocated must
// keep forwarding, or a read through a stale base corrupts memory. Both directions are
// pinned (the second is memory-safety-critical — see neverGrownCandidate's default-deny proof).
// Float elements stay a plain heap array (not promoted to a typed/int vector) and the
// dynamic loop index keeps it from scalarizing — so this exercises the plain-array
// never-grown read path specifically.
const FIXED_ARRAYS = {
  'float index loop': 'export let f=(n)=>{let a=[1.5,2.5,3.5,4.5]; let s=0; for(let i=0;i<4;i++) s+=a[i]*n; return s}',
  'float reduce': 'export let f=()=>{let a=[1.5,2.5,3.5,4.5,5.5,6.5,7.5,8.5,9.5]; let s=0; for(let i=0;i<9;i++) s+=a[i]; return s}',
}
for (const [name, src] of Object.entries(FIXED_ARRAYS)) {
  test(`minimal: fixed array (${name}) skips forwarding`, () => {
    if (skip) return
    ok(!has(src, '__ptr_offset', 2), `${name}: a never-grown array reads without the forwarding follow`)
  })
}
// Memory-safety invariant: every array that can be relocated MUST keep forwarding.
const RELOCATABLE = {
  pushed: 'export let f=()=>{let a=[1,2]; a.push(3); return a[0]}',
  'length grown': 'export let f=()=>{let a=[1,2]; a.length=5; return a[0]}',
  'compound length grow': 'export let f=()=>{let a=[1,2]; a.length+=1; return a[0]}',
  'aliased then grown': 'export let f=()=>{let a=[1,2]; let b=a; b.push(3); return a[0]}',
  'stored then grown': 'export let f=()=>{let a=[1,2]; let w={}; w.d=a; w.d.push(3); return a[0]}',
  'element written': 'export let f=(i)=>{let a=[1,2]; a[i]=9; return a[0]}',
}
for (const [name, src] of Object.entries(RELOCATABLE)) {
  test(`minimal: relocatable array (${name}) keeps forwarding`, () => {
    if (skip) return
    ok(has(src, '__ptr_offset', 2), `${name}: a possibly-relocated array MUST follow forwarding (memory safety)`)
  })
}
// And the relocations stay correct at runtime (the read sees the grown buffer).
test('minimal: never-grown analysis preserves grow semantics', () => {
  if (skip) return
  is(jz('export let f=()=>{let a=[1,2]; a.push(3); return a[2]}').exports.f(), 3, 'pushed element readable')
  is(jz('export let f=()=>{let a=[1,2]; let w={}; w.d=a; w.d.push(7); return a[2]}').exports.f(), 7, 'grow via alias visible through original')
})

// === Typed arrays never forward — they are fixed-size, never relocated ===
// A typed array's index read derives its base directly (no __ptr_offset chase): unlike
// ARRAY/HASH/SET/MAP (growable) or an inferred OBJECT (can alias a relocated array),
// VAL.TYPED is a narrow type that can only be a real fixed-size typed array.
test('minimal: typed-array reads skip the forwarding follow', () => {
  if (skip) return
  const src = 'export let f=(n)=>{let a=new Float64Array(16); for(let i=0;i<16;i++)a[i]=i*n; let s=0; for(let i=0;i<16;i++)s+=a[i]; return s}'
  ok(!has(src, '__ptr_offset', 2), 'a typed array reads/writes without __ptr_offset')
  is(jz(src).exports.f(2), 240, 'typed array still computes correctly')  // 2*sum(0..15) = 2*120
})

// === Numeric Array(n) loops skip ToNumber / string formatting ===
// Numeric cells carry Number-or-undefined reads: holes become NaN in arithmetic.
// General Number indices still need a named-property fallback outside the element
// domain. Pin the direct numeric loop paths, not the cold helpers' mere presence.
const NUMERIC_FILL = {
  'arithmetic fill': 'export let f=(n)=>{let a=Array(n); for(let i=0;i<n;i++)a[i]=(i%13)-6; let s=0; for(let i=0;i<n;i++)s+=a[i]*a[i]; return s|0}',
  'bare numeric-local write': 'export let f=(n)=>{let a=Array(n); for(let i=0;i<n;i++){let v=i*0.5+1; a[i]=v} let s=0; for(let i=0;i<n;i++)s+=a[i]; return s|0}',
  'self element read': 'export let f=(n)=>{let a=Array(n); for(let i=0;i<n;i++)a[i]=i*3; a[0]=a[n-1]; let s=0; for(let i=0;i<n;i++)s+=a[i]; return s|0}',
  'new Array(n) ctor': 'export let f=(n)=>{let a=new Array(n); for(let i=0;i<n;i++)a[i]=i&7; let s=0; for(let i=0;i<n;i++)s+=a[i]; return s|0}',
}
const STRINGY = ['__to_num', '__to_str', '__str_concat', '__ftoa', '__itoa', '__skipws', '__static_str']
const irSome = (node, pred) => Array.isArray(node) && (pred(node) || node.some(c => irSome(c, pred)))
const numericFillLoops = w => {
  const loops = []
  for (const f of parseWat(w)) if (f?.[0] === 'func' && /^\$f(?:\$|$)/.test(f[1]))
    irSome(f, n => { if (n[0] === 'loop') loops.push(n); return false })
  return loops
}
for (const [name, src] of Object.entries(NUMERIC_FILL)) {
  test(`minimal: numeric Array(n) (${name}) skips ToNumber/string`, () => {
    if (skip) return
    for (const O of levels(0, 2)) {
      const loops = numericFillLoops(wat(src, O))
      const numeric = n => !irSome(n, x => x[0] === 'call' && STRINGY.includes(x[1]?.slice(1)))
      const wordCounter = n => O === 0 || irSome(n.find(x => x?.[0] === 'br_if'),
        x => x[0] === 'i32.ge_s' || x[0] === 'i32.ge_u')
      ok(loops.some(n => numeric(n) && wordCounter(n) && irSome(n, x => x[0] === 'f64.store')),
        `${name} @O${O}: direct numeric fill needs no ToNumber/string call`)
      ok(loops.some(n => numeric(n) && wordCounter(n) && irSome(n, x => x[0] === 'f64.load') && irSome(n, x => x[0] === 'f64.add')),
        `${name} @O${O}: direct numeric reads feed native addition without ToNumber/string calls`)
    }
  })
}
// Stored Numbers remain numeric; an unwritten hole still yields undefined.
test('minimal: numeric Array(n) narrowing preserves results', () => {
  if (skip) return
  is(jz(NUMERIC_FILL['arithmetic fill']).exports.f(64), 874, 'arithmetic-fill sum of squares')
  is(jz('export let f=()=>{let a=Array(4); a[0]=5; a[1]=6; let s=0; for(let i=0;i<4;i++)s+=a[i]; return s}').exports.f(), NaN, 'unwritten holes read undefined: NaN through the sum, as JS')
})
test('minimal: numeric Array(n) loops preserve boundary and reuse results', () => {
  const answer = (fn, ...args) => { try { return ['value', fn(...args)] } catch (e) { return ['error', e.name] } }
  for (const O of levels(0, 1, 2, 3, 'size')) for (const [name, src] of Object.entries(NUMERIC_FILL)) {
    const got = jz(src, { optimize: O }).exports.f, want = oracle(src).f
    for (const n of [0, -0, 1, 3, 13, 64, 3, 3, 0, -1, 1.5, NaN, Infinity, 4294967296])
      is(answer(got, n), answer(want, n), `${name} @O${O}: ${String(n)}`)
  }
})

test('minimal: numeric array reads keep named-key and value-coercion fallbacks', () => {
  const src = `export function f(k, value) {
    const a = Array(2); a[0] = 3; a[k] = value
    return [typeof a[k], a[k] * 2, a[0], a.length, Object.keys(a)]
  }`
  const answer = (fn, ...args) => { try { return ['value', fn(...args)] } catch (e) { return ['error', e.name] } }
  for (const O of levels(0, 1, 2, 3, 'size')) {
    const got = jz(src, { optimize: O }).exports.f, want = oracle(src).f
    for (const k of [0, -0, 1, -1, 1.5, NaN, Infinity, -Infinity, 4294967295, 4294967296, 4294967297, 'length', 'named', -1, 0])
      for (const value of [7, '7', undefined, null])
        is(answer(got, k, value), answer(want, k, value), `named/coerced read @O${O}: ${String(k)}, ${String(value)}`)
  }
})

// SOUNDNESS: the moment an array could hold a non-Number, narrowing must NOT fire — else
// `+` would compile to f64.add on a string pointer. The cell joins the store in a callee
// through the parameter, and the string store in the body.
test('minimal: numeric Array(n) narrowing stays sound under non-numeric use', () => {
  if (skip) return
  // a mutator that writes a string through its parameter reaches the cell, so
  // `a[0]+a[1]` stays a polymorphic concat, not a numeric add.
  is(jz('let g=(arr)=>{arr[1]="x"+"y"}; export let f=(n)=>{let a=Array(n); for(let i=0;i<n;i++)a[i]=i; g(a); return a[0]+a[1]}').exports.f(3), '0xy', 'escape to string mutator stays string-correct')
  // a string element write in-body poisons the numeric proof (rhs is not VAL.NUMBER).
  is(jz('export let f=(n)=>{let a=Array(n); for(let i=0;i<n;i++)a[i]=i; a[0]="hi"; return a[0]+a[1]}').exports.f(3), 'hi1', 'mixed string write disqualifies narrowing')
})

// === Module-level numeric const tables shed the ToNumber/string subsystem ===
// A top-level `const T = [n, …]` (flat) or `[[n,…], …]` (nested) is provably numeric, so
// `T[i]` / `T[i][j]` reads skip __to_num — the synth/floatbeat lookup-table shape. Without
// it a module table drags the full string battery (~5 KB) into a string-free kernel (synth
// 7.7 KB → 2 KB; a chord table 6 KB → 0.6 KB). Flat = recordGlobalRep's arrayElemValType;
// nested adds arrayElemElemValType + the `C[i][j]` / `ch=C[i];ch[j]` read sites.
const NUMERIC_TABLE = {
  'flat *':          'const T=[1.5,2.5,3.5,4.5,5.5,6.5,7.5,8.5]\nexport let f=(n)=>{let s=0;for(let i=0;i<n;i++)s+=T[i&7]*2;return s}',
  'flat -':          'const T=[1.5,2.5,3.5,4.5]\nexport let f=(n)=>{let s=0;for(let i=0;i<n;i++)s-=T[i&3];return s|0}',
  'nested direct':   'const C=[[0,4,7],[2,5,9],[5,9,0],[7,11,2]]\nexport let f=(n)=>{let s=0;for(let i=0;i<n;i++)s+=C[i&3][i&1]*2;return s}',
  'nested via bind': 'const C=[[0,4,7],[2,5,9],[5,9,0],[7,11,2]]\nexport let f=(n)=>{let s=0;for(let i=0;i<n;i++){let ch=C[i&3];s+=ch[i&1]*2}return s}',
}
for (const [name, src] of Object.entries(NUMERIC_TABLE)) {
  test(`minimal: module numeric const table (${name}) skips ToNumber/string`, () => {
    if (skip) return
    for (const O of levels(0, 2)) {
      const w = wat(src, O)
      for (const h of STRINGY) ok(!w.includes(`$${h} `) && !w.includes(`$${h})`),
        `${name} @O${O}: a module numeric table must not pull ${h}`)
    }
  })
}
// Value-correct: the read yields the stored Number (flat and one level down).
test('minimal: module numeric const table reads are value-correct', () => {
  if (skip) return
  is(jz('const T=[10,20,30]\nexport let f=()=>T[1]+T[2]').exports.f(), 50, 'flat read')
  is(jz('const C=[[0,4,7],[2,5,9]]\nexport let f=()=>C[1][2]*2').exports.f(), 18, 'nested direct read')
  is(jz('const C=[[0,4,7],[2,5,9]]\nexport let f=()=>{let ch=C[1];return ch[0]*2}').exports.f(), 4, 'nested via binding')
})
// SOUNDNESS (default-deny): a non-numeric element write — including a NESTED `C[i][j]=str`,
// which the dynWriteVars root-walk now flags — must disable narrowing, else `*` would
// f64.mul a NaN-boxed pointer. The null case proves it routes through ToNumber (null→0),
// not the NaN-box coincidence (which would give NaN).
test('minimal: module numeric table narrowing stays sound under non-numeric write', () => {
  if (skip) return
  ok(Number.isNaN(jz('const T=[1.5,2.5,3.5]\nexport let f=()=>{T[0]="hi";return T[0]*2}').exports.f()), 'flat string write → NaN')
  ok(Number.isNaN(jz('const C=[[1,2],[3,4]]\nexport let f=()=>{C[0][0]="hi";return C[0][0]*2}').exports.f()), 'nested string write → NaN')
  is(jz('const C=[[1,2],[3,4]]\nexport let f=()=>{C[0][0]=null;return C[0][0]*2}').exports.f(), 0, 'nested null write → 0 (ToNumber, not NaN-box)')
})

// === KNOWN REDUNDANCY (targets, not yet minimal) ===
// `new Date()` (and other single heap-pointer constructors) drag in the full allocator +
// memgrow for one pointer. (`(a) => a[0] + a[1]` on an *untyped* param is NOT a gap —
// `a[0]` is a polymorphic array/string index and `+` a polymorphic add/concat, so its
// allocator is genuinely reachable, not redundant.)
test('minimal [known-gap]: new Date still drags in the allocator', () => {
  if (skip) return
  const over = hasAllocator('export const d = new Date(0)')
  if (!over) ok(true, 'new Date no longer pulls the allocator — promote this to a positive assertion')
  else ok(true, 'KNOWN: new Date(0) pulls the full allocator/memgrow for a single pointer')
})

// === .work/archive/todo.md §deletion-sweep Slice A: zero size cost for Error-free modules ===
// buildErrorObject/toStrI64's Error-schema arm are gated on the Error-class
// emit handlers and ctx.features.error (prepare's whole-program scan) firing —
// a program that never constructs an Error must be byte-identical to what it
// compiled before this slice: no memory, no allocator, no schema machinery
// pulled in by merely having the Error CLASSES available. `__errcls__` (audit-
// #9 P0-2: un-stolen, ordinary property name, no longer a schema concept at
// all) can't leak either way — kept as a belt-and-braces string-absence check.
test('minimal: heap-free numeric fn stays heap-free (Error machinery is reachability-gated)', () => {
  if (skip) return
  const src = 'export let f = (a, b) => a + b'
  for (const O of levels(0, 2)) {
    ok(!hasMemory(src, O), `@O${O}: an Error-free program must not declare memory`)
    ok(!hasAllocator(src, O), `@O${O}: an Error-free program must not pull the allocator`)
    ok(!has(src, '__errcls__', O), `@O${O}: no Error schema leaks into a program that never constructs one`)
    ok(!has(src, 'Cannot read properties', O), `@O${O}: no nullish-receiver message string leaks into a program with no member-access/call site`)
  }
})

// audit-#11 gap-2: throwTypeErrorIR (src/ir.js) now forces module/string.js
// inclusion + interns 'TypeError' and its two message strings — a real
// dependency this synthetic TypeError never needed before (both were left
// `undefined`). Reachability MUST still gate it exactly like every other
// Error mechanism above: a program with no member-access/call site that
// could ever throw one pays nothing (the pin right above already covers
// that — a program with NO nullish-receiver check site at all never even
// calls throwTypeErrorIR, so `ctx.module.include('string')` never fires).
// This pin is the positive half: a program that DOES have one (a Map
// `.get()` absent-key read feeding a property access — the same shape
// audit-#10's own dyn-keys.js repro uses) must show the real strings.
test('minimal: nullish-receiver TypeError message strings appear exactly when the check site does (audit-#11 gap-2)', () => {
  if (skip) return
  const src = "export let f = () => { const m = new Map(); m.set('present', [1, 2]); return m.get('missing').length }"
  for (const O of levels(0, 2)) {
    const w = wat(src, O)
    ok(w.includes('T\\00y\\00p\\00e\\00E\\00r\\00r\\00o\\00r'), `@O${O}: the constructed TypeError's class name string is present`)
    ok(w.includes('Cannot read properties of undefined'.split('').join('\\00')), `@O${O}: the read-family message string is present`)
  }
})

// String-pool reachability (fix/string-pool-reach): an opaque `.length` access is
// emitted through module/core.js's runtime-dispatch arm (emitLengthAccess) before
// the receiver's real type is known — that arm eagerly mints the TypeError schema
// and, once pullStdlib realizes $__length/$__length.value, interns "TypeError" and
// "Cannot read properties of undefined" (module/core.js's __throw_property_nullish
// thunk), plus buildStartFn's whole-schema-list runtime table (src/wat/assemble.js)
// bakes every schema's key strings (e.g. the branded ['message','name'] pair) into
// the data segment the same way. All of that is SOUND at the point it runs — the
// receiver could still be nullish — but a LATER pass (optimizeModule's narrowing,
// here: proving `rows` is always the array it was just built as) can resolve the
// specific call site to a direct array-length read, leaving $__length/
// $__length.value/$__throw_property_nullish and the whole schema table with no
// surviving caller. Before this fix those interned bytes leaked into every module
// with ANY opaque length/property-dispatch site regardless of whether treeshake
// proved the throw path itself dead (the audited aos/wav size-gate regression).
// stripDeadInternedSpans (src/wat/assemble.js) reclaims that trailing dead run once
// real reachability is known — this pin is the negative half (dead: neither
// string, matching the schema-fix's OWN 'jz:schema' custom-section reconciliation
// this is the runtime-data-segment analog of); the pin below is the positive half
// (live: both strings, AND the throw actually happens with the right host-visible
// class/message).
test('minimal: dead opaque-.length throw path leaves neither the TypeError schema name nor its message string (fix/string-pool-reach)', () => {
  if (skip) return
  const src = `export let f = () => {
    const rows = []
    for (let i = 0; i < 5; i++) rows.push({ x: i })
    let s = 0
    for (let i = 0; i < rows.length; i++) s += rows[i].x
    return s
  }`
  for (const O of levels(0, 2, 3)) {
    const w = wat(src, O)
    ok(!w.includes('T\\00y\\00p\\00e\\00E\\00r\\00r\\00o\\00r'), `@O${O}: rows is provably always an array — the TypeError class name string must not leak`)
    ok(!w.includes('Cannot read properties of undefined'.split('').join('\\00')), `@O${O}: the never-reached throw's message string must not leak`)
  }
})

test('minimal: live opaque-.length throw path keeps both strings and throws a real host TypeError (fix/string-pool-reach)', () => {
  if (skip) return
  const src = `export let f = (x) => {
    let obj = x > 0 ? { a: 1 } : undefined
    return obj.length
  }`
  for (const O of levels(0, 2, 3)) {
    const w = wat(src, O)
    ok(w.includes('T\\00y\\00p\\00e\\00E\\00r\\00r\\00o\\00r'), `@O${O}: obj can be undefined at runtime — the TypeError class name string must survive`)
    ok(w.includes('Cannot read properties of undefined'.split('').join('\\00')), `@O${O}: the reachable throw's message string must survive`)
  }
  // skip is already false here (the early return above covers WASI/kernel, whose
  // command wrapping / self-hosted pipeline this default-JS-host instantiate call
  // doesn't target) — host-side runtime correctness for those is the job of
  // test/errors.js and the kernel-oracle/kernel-parity legs, not this file.
  const inst = jz(src)
  let caught = null
  try { inst.exports.f(-1) } catch (e) { caught = e }
  ok(caught instanceof TypeError, `host received ${caught?.constructor?.name ?? caught}, expected a real TypeError instance`)
  ok(!!caught && /Cannot read properties of undefined/.test(caught.message),
    `message was ${JSON.stringify(caught?.message)}, expected it to mention "Cannot read properties of undefined"`)
})

// A literal laid out in the data segment whose every referent the optimizer
// erased leaves the binary, wherever in the segment it lies
// (optimize/watr-tail.js stripDeadLateData): watr inlines `pick(k)` with a
// constant and folds the other arm away, its string with it, while the string
// beside it keeps its bytes. The pre-link reclaim only cut the segment's tail,
// and only for helpers' spans: a dead stdlib error message laid out before a
// live one (stdlib-dists' typed-view messages) stayed.
test('minimal: a literal whose last referent the optimizer folded away leaves the data segment', () => {
  if (skip) return
  const enc = s => s.split('').join('\\00')
  const first = 'first long string here', second = 'second long string here'
  for (const [k, kept, gone] of [[1, first, second], [2, second, first]]) {
    const src = `const pick = (k) => k === 1 ? '${first}' : '${second}'
export let f = () => pick(${k})`
    for (const O of [...levels(2, 3), 'size']) {
      const w = wat(src, O)
      ok(w.includes(enc(kept)), `@O${O} pick(${k}): the string the program reads keeps its bytes`)
      ok(!w.includes(enc(gone)), `@O${O} pick(${k}): the folded arm's string leaves the data segment`)
      is(jz(src, { optimize: O }).exports.f(), kept, `@O${O} pick(${k}): the kept string reads as written`)
    }
  }
})

// Per-instance RUNTIME HEAP cost of a constructed Error. audit-#9 P0-2 shrank
// the object from 3 slots (['message','name','__errcls__']) to 2
// (['message','name']) — class identity moved to the schema id, so this is
// now a 16B payload + 16B header = 32B/instance, under the original design's
// own ~60-100B ledger estimate. This is a claim about the `__jz_heap` bump-
// allocator's growth per allocation, NOT compiled .wasm byte size (a single
// construction call SITE costs the same code bytes whether it runs once or in
// a hot loop) — measured directly via `instance.exports.__jz_heap` before/after a steady-
// state batch (after `__jz_clear()` resets any one-time init/data-segment cost so
// only the repeated per-call growth is counted).
if (!skip) {
  test('minimal: constructed Error heap footprint (audit-#9 P0-2: 2-slot object, ~32B/instance)', () => {
    const inst = jz(`export let f = (n) => { let t = 0; for (let i = 0; i < n; i++) { let e = new Error('boom'); t = t + e.message.length } return t }`)
    inst.exports.f(1)                    // pay one-time init (allocator/data segment) before measuring
    const { __jz_heap: heap, __jz_clear: clear } = inst.instance.exports
    const before = heap.value
    clear()
    const REPS = 2000
    inst.exports.f(REPS)
    const perInstance = (heap.value - before) / REPS
    ok(perInstance <= 120, `${perInstance}B/instance steady-state heap growth (2-slot object: 16B payload + 16B header = 32B — well under the original 3-slot ~60-100B ledger estimate)`)
  })
}

// The compact prototype's bench rows, kept as a production size ratchet now that
// the prototype is retired (prototype/compact/README.md's correction, 2026-09-02).
// Each row's byte count at `optimize: 'size'` may only fall; the recorded value is
// production's, with the prototype's own figure alongside for the record.
test('minimal: the compact-prototype bench rows stay at or below their recorded bytes', () => {
  if (skip) return
  const DSP = `const a=new Float64Array(64);const b=new Float64Array(64);export let f=(x)=>{
    for(let i=0;i<a.length;i++)a[i]=x+i
    for(let j=0;j<b.length;j++)b[j]=a[j]*2+1
    let sum=0
    for(let k=0;k<b.length;k++)sum+=b[k]
    return sum
  }`
  const ROWS = [
    ['constant', 'export let f = () => 1 + 2 * 3', [], 7, 41, 41],
    ['nan-fold', 'export let f = () => 0 / 0', [], NaN, 41, 41],
    ['arithmetic', 'export let f = x => { x=+x; return x*x*0.5+3 }', [8], 35, 58, 64],
    ['direct-call', 'let mul=(x,y)=>x*y; export let f=(x,y)=>{x=+x;y=+y;return mul(x,y)+1}', [3, 4], 13, 49, 69],
    ['conditional', 'export let f=x=>{x=+x;if(x>0)return x;else return -x}', [-9], 9, 82, 61],
    ['for-loop', 'export let f=n=>{n=+n;let s=0;for(let i=0;i<n;i++)s+=i;return s}', [100], 4950, 74, 102],
    ['while-loop', 'export let f=n=>{n=+n;let s=0;let i=0;while(i<n){s+=i;i++}return s}', [100], 4950, 74, 102],
    ['bitwise', scalarCase('differential-fnv-i32').source, [1, 2, 3], 5689143, 120, 212],
    ['typed-simd', DSP, [3], 4480, 220, 287],
  ]
  for (const [name, src, args, expected, recorded] of ROWS) {
    const bytes = compile(src, { optimize: 'size', alloc: false })
    ok(bytes.length <= recorded, `${name}: ${bytes.length} B (recorded ${recorded})`)
    const { exports } = new WebAssembly.Instance(new WebAssembly.Module(bytes))
    ok(Object.is(exports.f(...args), expected), `${name}: result`)
  }
})

// === Size-tier codegen classes closed against the v1 ledger ===
// Each pins one lowering with a differential run and a byte ratchet at
// `optimize: 'size'` (the recorded value may only fall).
// (a raw host: a result that may be undefined or null crosses as its i64 bits, jz:i64exp `r`)
const run = (src, opts) => { const mod = new WebAssembly.Module(compile(src, { alloc: false, ...opts })); return adaptI64(mod, new WebAssembly.Instance(mod).exports) }
const jsFn = (src, name) => oracle(src)[name]

// A union-typed array pushed from several literal sites reserves each element
// through one __arr_push_slot call; the sites store only their fields.
const UNION_PUSH = `const measure = (o) => {
  const k = o.k
  if (k === 0) return (o.x + o.y) | 0
  else if (k === 1) return Math.imul(o.r, 3)
  else if (k === 2) return (Math.imul(o.w, o.h) - o.d) | 0
  return Math.imul(o.n, o.s)
}
export let f = (n) => {
  const rows = []
  let s = 0x1234abcd | 0
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    const k = s & 3, a = (s >>> 3) & 1023, b = (s >>> 13) & 1023
    if (k === 0) rows.push({ k: k, x: a, y: b })
    else if (k === 1) rows.push({ k: k, r: a })
    else if (k === 2) rows.push({ k: k, w: a, h: b, d: b })
    else rows.push({ k: k, n: b, s: a })
  }
  let sum = 0
  for (let i = 0; i < rows.length; i++) sum = (sum + measure(rows[i])) | 0
  return sum
}`
test('minimal: multi-site union push reserves elements out of line', () => {
  if (skip) return
  const w = wat(UNION_PUSH, 'size')
  is((w.match(/call \$__arr_push_slot/g) || []).length, 4, 'one reservation call per push site')
  ok(!w.includes('$__arr_grow_known'), 'the grow sequence is not expanded per site')
  is(run(UNION_PUSH, { optimize: 'size' }).f(1000), jsFn(UNION_PUSH, 'f')(1000))
  is(run(UNION_PUSH, { optimize: 3 }).f(1000), jsFn(UNION_PUSH, 'f')(1000))
  const bytes = compile(UNION_PUSH, { optimize: 'size', alloc: false }).length
  ok(bytes <= 1203, `union push: ${bytes} B (recorded 1203)`)
})

// `new T(x.buffer, x.byteOffset, n)` over an owned typed array reads x's data
// offset directly: no boxed BUFFER pointer, no forwarding chase.
const OWNED_VIEW = `export let f = (n) => {
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) out[i] = i * 1.5
  const u = new Uint32Array(out.buffer, out.byteOffset, out.length * 2)
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < u.length; i += 3) h = Math.imul(h ^ (u[i] | 0), 0x01000193) | 0
  return h >>> 0
}`
test('minimal: a view over an owned typed array takes its base directly', () => {
  if (skip) return
  ok(!wat(OWNED_VIEW, 'size').includes('$__ptr_offset'), 'no pointer unboxing for x.buffer')
  for (const n of [0, 7, 100]) is(run(OWNED_VIEW, { optimize: 'size' }).f(n), jsFn(OWNED_VIEW, 'f')(n), `n=${n}`)
  const bytes = compile(OWNED_VIEW, { optimize: 'size', alloc: false }).length
  ok(bytes <= 529, `owned view: ${bytes} B (recorded 529)`)
})

// A proven post-increment read of an integer element feeds an integer store
// as its raw i32 (no f64 round trip, no ToUint8 select chain).
const BYTE_COPY = `export let f = (n) => {
  const src = new Uint8Array(256), out = new Uint8Array(256)
  for (let i = 0; i < 256; i++) src[i] = (i * 7) & 255
  let ip = 0, op = 0
  while (ip < 256) out[op++] = src[ip++]
  let h = 0
  for (let i = 0; i < 256; i++) h = (h * 31 + out[i]) | 0
  return h + n
}`
test('minimal: post-increment byte copy stays on the integer path', () => {
  if (skip) return
  const w = wat(BYTE_COPY, 'size')
  ok(!w.includes('trunc_sat'), 'no ToInt32 of the copied byte')
  is(run(BYTE_COPY, { optimize: 'size' }).f(1), jsFn(BYTE_COPY, 'f')(1))
  const bytes = compile(BYTE_COPY, { optimize: 'size', alloc: false }).length
  ok(bytes <= 475, `byte copy: ${bytes} B (recorded 475)`)
})

// A looped kernel called from two sites is one function at -Os (speed tiers
// may still splice it per site).
const TWO_SITE_KERNEL = `const pass = (a, b, m, step) => {
  let phase = 1
  for (let k = 0; k < m; k++) { const idx = phase | 0; b[k] = a[idx] * 0.5 + a[idx + 1] * 0.5; phase += step }
}
export let f = (n) => {
  const a = new Float64Array(64), b = new Float64Array(32), c = new Float64Array(16)
  for (let i = 0; i < 64; i++) a[i] = i
  pass(a, b, 32, 1.5); pass(b, c, 16, 1.5)
  let s = 0
  for (let i = 0; i < 16; i++) s += c[i]
  return s + n
}`
test('minimal: a two-site looped kernel is not duplicated at -Os', () => {
  if (skip) return
  is((wat(TWO_SITE_KERNEL, 'size').match(/call \$pass/g) || []).length, 2, 'both sites call the kernel')
  is(run(TWO_SITE_KERNEL, { optimize: 'size' }).f(0), jsFn(TWO_SITE_KERNEL, 'f')(0))
  const bytes = compile(TWO_SITE_KERNEL, { optimize: 'size', alloc: false }).length
  ok(bytes <= 671, `two-site kernel: ${bytes} B (recorded 671)`)
})

// `new Float64Array(N >> 1)` with a module const N is a static length.
test('minimal: a folded constructor length is a static length', () => {
  if (skip) return
  const src = 'const N = 65536; export let f = () => { const w = new Float64Array(N >> 1); for (let k = 0; k < 32768; k++) w[k] = k; return w[5] }'
  ok(!/\$[^\s)]*tbi\d*/.test(compile(src, { wat: true, optimize: { level: 'size', watr: false } })), 'no checked typed access')
  is(run(src, { optimize: 'size' }).f(), 5)
})

// A small local lambda over a captured counter (`const rnd = () => { s ^= …;
// return s >>> 0 }`) is spliced at every site, expression positions included
// (a hoisted temp before the statement, commuting with a disjoint `w++` on
// the store's own index); its draws are uint32 locals, so `% K` and `& m`
// stay integer ops. No closure object, no env cell, no f64 remainder.
const XORSHIFT_DRAWS = `export let f = (n) => {
  let s = 0x9b3f017 | 0
  const rnd = () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return s >>> 0
  }
  const out = new Uint8Array(4096)
  let w = 0, acc = 0
  for (let r = 0; r < n; r++) {
    const ax = (rnd() % 1000) * 0.1, ay = ((rnd() % 2000) - 1000) * 0.05
    const kind = rnd() % 3
    let fl = rnd() & 1
    if (kind === 0) fl |= 0x02 | ((rnd() & 1) << 4)
    else if (kind === 2) fl |= 0x10
    out[w++] = fl
    out[w++] = rnd() % 256
    acc += ax + ay
  }
  let h = 0
  for (let i = 0; i < w; i++) h = (h * 31 + out[i]) | 0
  return h + acc
}`
test('minimal: a local xorshift lambda splices at every site as uint32 draws', () => {
  if (skip) return
  const w = wat(XORSHIFT_DRAWS, 'size')
  ok(!/\(func \$\S*closure/.test(w), 'no closure function')
  ok(!w.includes('call_indirect'), 'no indirect call')
  ok(!w.includes('f64.trunc'), 'no f64 remainder emulation')
  ok(w.includes('i32.rem_u'), 'uint32 draws take i32.rem_u')
  for (const n of [0, 1, 500]) is(run(XORSHIFT_DRAWS, { optimize: 'size' }).f(n), jsFn(XORSHIFT_DRAWS, 'f')(n), `n=${n}`)
  is(run(XORSHIFT_DRAWS, { optimize: 3 }).f(500), jsFn(XORSHIFT_DRAWS, 'f')(500), 'O3')
  const bytes = compile(XORSHIFT_DRAWS, { optimize: 'size', alloc: false }).length
  ok(bytes <= 767, `xorshift draws: ${bytes} B (recorded 767)`)
})

// The hoist must keep evaluation order: a draw after an effectful call, or
// after a store index that the lambda itself reads, stays in place.
test('minimal: lambda hoisting keeps evaluation order against real effects', () => {
  if (skip) return
  const src = `export let f = (n) => {
    let s = 1, w = 0
    const bump = () => { s = s * 3 + 1; return s }
    const draw = () => { w = w + 2; return w }
    const out = new Int32Array(64)
    for (let i = 0; i < n; i++) {
      out[w++] = draw()              // draw reads w: must run after w++
      const v = bump() + draw()      // in order: bump first
      out[i] = v + out[w & 63]
    }
    let h = 0
    for (let i = 0; i < 64; i++) h = (h * 31 + out[i]) | 0
    return h
  }`
  for (const optimize of levels('size', 0, 3)) is(run(src, { optimize }).f(20), jsFn(src, 'f')(20), `O${optimize}`)
})

// `3 + ((s >>> 8) % 6)`: the remainder of a uint32 draw by a positive literal
// is a bounded integer, so the sum stays an i32 local and its loop bound needs
// no f64 snap.
test('minimal: a uint32 remainder keeps its consumer an i32 local', () => {
  if (skip) return
  const src = 'export let f = (n) => { n = +n; let s = 0x1234abcd | 0; let t = 0; for (let i = 0; i < n; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; const len = 3 + ((s >>> 8) % 6); for (let j = 0; j < len; j++) t += j } return t }'
  const w = wat(src, 'size')
  ok(w.includes('(local $len i32)'), 'len is an i32 local')
  ok(w.includes('i32.rem_u'), 'remainder is i32.rem_u')
  is(run(src, { optimize: 'size' }).f(300), jsFn(src, 'f')(300))
  is(run(src, { optimize: 3 }).f(300), jsFn(src, 'f')(300))
})

// A record-stream cursor whose discriminant is the read itself (`if (o.k === 0)`)
// takes the packed union carrier like the `const k = o.k` alias form.
test('minimal: a direct cursor-read discriminant admits the union carrier', () => {
  if (skip) return
  const src = `export let f = (n) => {
    const rows = []
    let s = 0x1234abcd | 0
    for (let i = 0; i < n; i++) {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5
      const k = s & 3, a = (s >>> 3) & 1023, b = (s >>> 13) & 1023
      if (k === 0) rows.push({ k: k, x: a, y: b })
      else if (k === 1) rows.push({ k: k, r: a })
      else if (k === 2) rows.push({ k: k, w: a, h: b, d: b })
      else rows.push({ k: k, n: b, s: a })
    }
    let sum = 0
    for (let i = 0; i < rows.length; i++) {
      const o = rows[i]
      if (o.k === 0) sum = (sum + o.x + o.y) | 0
      else if (o.k === 1) sum = (sum + Math.imul(o.r, 3)) | 0
      else if (o.k === 2) sum = (sum + Math.imul(o.w, o.h) - o.d) | 0
      else sum = (sum + Math.imul(o.n, o.s)) | 0
    }
    return sum
  }`
  const w = wat(src, 'size')
  ok(!w.includes('__dyn_get'), 'no dynamic property reads')
  ok(w.includes('call $__arr_push_slot'), 'packed union pushes')
  const wasm = run(src, { optimize: 'size' }).f, js = jsFn(src, 'f')
  for (const n of [0,0,1,4,1000,3,0]) is(wasm(n), js(n), `cursor stream length ${n}`)
  const bytes = compile(src, { optimize: 'size', alloc: false }).length
  ok(bytes <= 1203, `record-stream cursor: ${bytes} B (recorded 1203)`)
})

// A concat with a side statically longer than the SSO capacity (a literal, a
// module-const string) is heap-only: the twin without SSO arms serves, and the
// self-accumulating form keeps its bump-extend.
test('minimal: a long-literal concat skips the SSO arms', () => {
  if (skip) return
  const acc = `const BASE = 'let alpha_12 = beta + 12345;\\n'
  export let f = (n) => { let s = ''; for (let i = 0; i < n; i++) s = s + BASE; return s.length }`
  const w = compile(acc, { wat: true, optimize: { level: 'size', watr: false } })
  ok(w.includes('call $__str_concat_raw_long'), 'the accumulation takes the long twin')
  ok(!w.includes('call $__str_concat_raw '), 'no SSO-capable accumulation twin')
  for (const n of [0, 1, 40]) is(jz(acc, { optimize: 'size' }).exports.f(n), jsFn(acc, 'f')(n), `n=${n}`)
  // The size tier links one body for the family: with a fresh concat in the
  // program the twin's sites take the general form (bridge.js general()).
  const src = `const BASE = 'let alpha_12 = beta + 12345;\\n'
  export let f = (n) => { let s = ''; for (let i = 0; i < n; i++) s = s + BASE; const t = s + 'x'; return s.length * 1000 + t.length }`
  const post = compile(src, { wat: true, optimize: 'size' })
  ok(!post.includes('$__str_concat_raw_long'), 'the long twin collapses into the fresh body')
  const speed = compile(src, { wat: true, optimize: { level: 3, watr: false } })
  ok(speed.includes('call $__str_concat_raw_long'), 'the speed tier keeps the twin')
  for (const n of [0, 1, 40]) is(jz(src, { optimize: 'size' }).exports.f(n), jsFn(src, 'f')(n), `n=${n}`)
  is(jz(src, { optimize: 3 }).exports.f(40), jsFn(src, 'f')(40), 'O3')
  const bytes = compile(src, { optimize: 'size', alloc: false }).length
  ok(bytes <= 1043, `long concat: ${bytes} B (recorded 1043)`)
})

// A typed factory called with one constant (`mkSignal(N)`, `const out = new
// Float64Array(n)` returned) publishes its result's static length, so the
// caller's binding proves its accesses like a local constructor would.
test('minimal: a typed factory result carries its static length', () => {
  if (skip) return
  const src = `const N = 4096
  const mk = (n) => { const out = new Float64Array(n); let s = 7; for (let i = 0; i < n; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; out[i] = (s >>> 0) / 4294967296 } return out }
  export let f = () => {
    const sig = mk(N), re = new Float64Array(N)
    for (let i = 0; i < N; i++) re[i] = sig[i] * 2
    let h = 0
    for (let i = 0; i < N; i += 64) h = (h * 31 + (re[i] * 1000 | 0)) | 0
    return h
  }`
  const pre = (s) => compile(s, { wat: true, optimize: { level: 'size', watr: false } })
  ok(!/\$[^\s)]*tbi\d*/.test(pre(src)), 'no checked access on the factory result')
  is(jz(src, { optimize: 'size' }).exports.f(), jsFn(src, 'f')())
  is(jz(src, { optimize: 3 }).exports.f(), jsFn(src, 'f')())
  // Two call sites with different constants publish nothing.
  const two = src.replace('const sig = mk(N), re', 'const sig = mk(N), other = mk(64), re').replace('return h\n', 'return h + other[3]\n')
  ok(/\$[^\s)]*tbi\d*/.test(pre(two)), 'disagreeing call sites keep the check')
  is(jz(two, { optimize: 'size' }).exports.f(), jsFn(two, 'f')())
})

// The size tier links the runtime's plain walks: `__str_eq` is one loop through
// the encoding-agnostic accessors (no hot/cold split, no 4-byte chunking) and
// `__str_hash` the SSO mix plus the byte FNV; the dictionary probes call the
// hash instead of inlining its fast arms. The hash values match the speed
// tier's bit for bit (the literal prehash is computed from the same walk).
test('minimal: the size tier links the plain string walks', () => {
  if (skip) return
  const src = `const words = ['alpha', 'beta', 'gamma_long_key', 'delta', 'alpha', 'gamma_long_key', 'epsilon_longer']
  export let f = (n) => {
    const counts = {}
    for (let i = 0; i < n; i++) { const w = words[i % words.length]; counts[w] = (counts[w] | 0) + 1 }
    let h = 0
    for (let i = 0; i < words.length; i++) h = (h * 31 + (counts[words[i]] | 0)) | 0
    return h * 7 + (words[2] === 'gamma_' + 'long_key' ? 1 : 0) + (words[0] === words[4] ? 2 : 0)
  }`
  const pre = compile(src, { wat: true, optimize: { level: 'size', watr: false } })
  ok(!pre.includes('$__str_eq_cold'), 'no hot/cold split')
  const post = compile(src, { wat: true, optimize: 'size' })
  const eqBody = post.slice(post.indexOf('(func $__str_eq'), post.indexOf('(func', post.indexOf('(func $__str_eq') + 10))
  ok(eqBody.includes('call $__char_at') && !eqBody.includes('i32.load offset'), 'the byte walk through __char_at')
  for (const n of [0, 3, 50]) {
    is(jz(src, { optimize: 'size' }).exports.f(n), jsFn(src, 'f')(n), `size n=${n}`)
    is(jz(src, { optimize: 3 }).exports.f(n), jsFn(src, 'f')(n), `speed n=${n}`)
  }
  // (2461 -> 2473: the dictionary's growth tests its table against TABLE_MAX,
  // module/collection/upsert.js nextCapIR)
  const bytes = compile(src, { optimize: 'size', alloc: false }).length
  ok(bytes <= 2473, `dictionary count: ${bytes} B (recorded 2473)`)
})

// A ring value under a branchless conditional narrows: `x = c ? x + d : x - d`
// over i32 x and a byte d computes in i32 (no f64 add, no +∞ guard), and a
// post-increment index into a checked read is `r - 1` over the incremented
// local, not `wrap(trunc(f64(r) - 1))`.
test('minimal: select and post-increment indices narrow to the i32 ring', () => {
  if (skip) return
  const src = `const decode = (stream, flags, n) => {
    let x = 0, r = 0, h = 0
    for (let i = 0; i < n; i++) {
      const f = flags[i]
      if (f & 2) { const d = stream[r++]; x = (f & 16) ? x + d : x - d }
      h = Math.imul(h ^ x, 16777619)
    }
    return h
  }
  export let f = (seed) => {
    const stream = new Uint8Array(64), flags = new Uint8Array(64)
    let s = seed | 0
    for (let i = 0; i < 64; i++) { s = (s * 1103515245 + 12345) | 0; stream[i] = s >>> 24; flags[i] = (s >>> 8) & 255 }
    return decode(stream, flags, 64)
  }`
  const w = compile(src, { wat: true, optimize: { level: 3, watr: false, sourceInline: false } })
  const body = w.slice(w.indexOf('(func $decode'), w.indexOf('(func $f'))
  ok(!body.includes('f64.add') && !body.includes('f64.sub'), 'no f64 arithmetic on the accumulator')
  ok(!body.includes('trunc_sat'), 'no conversion on the index')
  for (const seed of [7, 12345]) {
    const ref = jsFn(src, 'f')(seed)
    is(jz(src, { optimize: 3 }).exports.f(seed), ref, `speed seed=${seed}`)
    is(jz(src, { optimize: 'size' }).exports.f(seed), ref, `size seed=${seed}`)
  }
})

// An array grown only through its own name (push, element write, `.length =`)
// with every grow written back is never stale: its reads, length reads and
// push sites take the raw offset instead of following forwarding. An alias or
// an escape (a call argument, a capture, a store) keeps the follow.
test('minimal: an own-name-current array reads without the forwarding follow', () => {
  if (skip) return
  const src = `export let f = (n) => {
    const a = []
    for (let i = 0; i < n; i++) a.push(i * 3)
    a[n + 2] = 7
    let s = 0
    for (let i = 0; i < a.length; i++) s += a[i] | 0
    a.length = 2
    return s * 1000 + a.length * 10 + (a[1] | 0)
  }`
  const pre = compile(src, { wat: true, optimize: { level: 'size', watr: false } })
  const body = pre.slice(pre.indexOf('(func $f'), pre.indexOf('(func', pre.indexOf('(func $f') + 10))
  ok(!body.includes('call $__ptr_offset '), 'no forwarding follow in the function')
  for (const n of [0, 1, 5, 40]) for (const O of levels(0, 'size', 3)) is(jz(src, { optimize: O }).exports.f(n), jsFn(src, 'f')(n), `O${O} n=${n}`)
  // an alias can grow the array behind the binding's back: the follow stays
  const aliased = src.replace('a[n + 2] = 7', 'const b = a; b.push(9); b[n + 2] = 7')
  const pre2 = compile(aliased, { wat: true, optimize: { level: 'size', watr: false } })
  ok(pre2.includes('call $__ptr_offset '), 'an alias keeps the follow')
  for (const n of [0, 5, 40]) is(jz(aliased, { optimize: 'size' }).exports.f(n), jsFn(aliased, 'f')(n), `aliased n=${n}`)
  // a nested function holds its own copy of the pointer: its push relocates
  // behind this function's local (the self-hosted compiler's `out.push` inside
  // a `forEach` callback trapped on exactly this)
  const captured = `export let f = (n) => {
    const a = []
    const seed = [1, 2, 3, 4, 5, 6, 7, 8, 9]
    for (let i = 0; i < n; i++) seed.forEach(v => { a.push(v * 3 + i) })
    let s = 0
    for (let i = 0; i < a.length; i++) s += a[i] | 0
    return s * 1000 + a.length
  }`
  const pre3 = compile(captured, { wat: true, optimize: { level: 'size', watr: false, sourceInline: false } })
  ok(pre3.includes('call $__ptr_offset '), 'a captured array keeps the follow')
  for (const n of [0, 5, 40]) for (const O of levels(0, 'size', 3)) is(jz(captured, { optimize: O }).exports.f(n), jsFn(captured, 'f')(n), `captured O${O} n=${n}`)
})

test('minimal: an enumeration of a receiver no layout names is one function, whatever its sites', () => {
  // (each Object.keys/values/entries site spliced the whole own-property walk:
  // a helper inlined at fourteen sites made a 1.8 MB function that the hosted
  // compiler ran out of memory compiling)
  const src = `function sig(a) { return [a.length, Object.keys(a), Object.values(a), Object.entries(a)] }
    export function f(mode) { const a = mode ? [, undefined, 3, , 1] : [], b = a.slice(), c = a.concat(a)
      return [sig(a), sig(b), sig(c), sig(a.slice().reverse())] }`
  const js = oracle(src)
  for (const optimize of levels(1, 2, 3)) {
    if (onKernel()) break
    const wat = compile(src, { optimize, wat: true })
    for (const mode of [0, 1, 2]) is((wat.match(new RegExp(`\\(func \\$__idx_enum_of${mode}\\b`, 'g')) || []).length, 1, `O${optimize}: one walk for mode ${mode}`)
    ok((wat.match(/\(loop \$[^\s)]*owloop/g) || []).length <= 3, `O${optimize}: one property walk per kind, not per site`)
  }
  for (const optimize of levels(0, 2)) {
    const { f } = jz(src, { optimize }).exports
    for (const mode of [0, 1]) is(f(mode), js.f(mode), `O${optimize} f(${mode})`)
  }
})

// A length store of an integer word resizes without ToNumber at every tier
// (module/array.js `__arr_set_len`, emit-assign.js lengthWord): `q.length = 0`
// links no conversion, whose string parser and number printer were most of a
// small program's bytes at the size tier. Any other value still converts, its
// RangeError kept.
test('minimal: a word length store links no conversion at the size tier', () => {
  if (skip) return
  const src = `export let f = () => { const q = [1, 2, 3]; for (let i = 0; i < 4; i++) q.push(i); q.length = 2; const a = q.length; q.length = 5; return a * 100 + q.length * 10 + (q[4] === undefined ? 1 : 0) }`
  ok(!compile(src, { wat: true, optimize: 'size' }).includes('$__to_num'), 'no ToNumber linked')
  const conv = `export let f = (v) => { const q = [1, 2, 3]; q.length = v; return q.length }`
  for (const optimize of levels(0, 2, 'size')) {
    is(jz(src, { optimize }).exports.f(), oracle(src).f(), `O${optimize}: word stores`)
    is(jz(conv, { optimize }).exports.f(1), 1, `O${optimize}: a number`)
    is(jz(conv, { optimize }).exports.f('2'), 2, `O${optimize}: a string converts`)
    throws(() => jz(conv, { optimize }).exports.f(-1), RangeError, `O${optimize}: a negative length throws`)
    throws(() => jz(conv, { optimize }).exports.f(1.5), RangeError, `O${optimize}: a fraction throws`)
  }
})

// The size tier links the key hash and equality arms a program's Set and Map
// keys reach (module/collection/identity.js noteProbeKey, module/collection.js
// keyArms): Number and atom keys take the number arms (no string walks), string
// keys the string arm, object keys neither. A seeding notes its elements' kind.
test('minimal: the size tier links the key arms its keys reach', () => {
  if (skip) return
  const nums = `export let f = (n) => { const m = new Map(), s = new Set(); for (let i = 0; i < n; i++) { m.set(i % 7, i); s.add((i % 5) * 0.5) }
    const zs = new Set([0, -0, NaN, NaN, undefined, null, true, false, 1]); m.set(undefined, 9)
    return (m.get(3) | 0) + s.size * 100 + zs.size * 10000 + (zs.has(NaN) ? 1 : 0) + (zs.has(-0) ? 2 : 0) + (zs.has(undefined) ? 4 : 0) + (zs.has(0 / 0) ? 8 : 0) + (zs.has(null) ? 16 : 0) + (m.get(undefined) | 0) * 1000000 + (m.has(NaN) ? 32 : 0) }`
  const strs = `export let f = (n) => { const m = new Map(); for (let i = 0; i < n; i++) { const k = 'key' + (i % 9); m.set(k, (m.get(k) | 0) + 1) } return m.size * 100 + (m.get('key' + 3) | 0) }`
  const objs = `export let f = (n) => { const os = [], m = new Map(); for (let i = 0; i < n; i++) { const o = { i }; os.push(o); m.set(o, i) } let t = 0; for (const o of os) t += m.get(o); return t + m.size }`
  for (const optimize of levels(0, 2, 'size')) for (const [name, src] of [['numbers', nums], ['strings', strs], ['objects', objs]])
    for (const n of [0, 20]) is(jz(src, { optimize }).exports.f(n), oracle(src).f(n), `${name}, O${optimize}, n=${n}`)
  // (before watr, which inlines a helper of one caller under its caller's name)
  const w = (src) => compile(src, { wat: true, optimize: { level: 'size', watr: false } })
  ok(!/\$__str_(eq|hash)\b/.test(w(nums)), 'Number and atom keys: no string arms')
  ok(/\$__str_hash\b/.test(w(strs)), 'string keys: the string hash')
  ok(!/\$__str_eq\b/.test(w(objs)), 'object keys: no string equality')
})

// A call in statement position whose receiver may be missing keeps the
// statement's expectation past the receiver's guard (emit/method-dispatch.js):
// `l.push(i)` of a Map's read drops the length it would return, where it
// read the array's header again to compute it.
test('minimal: a dropped call past a receiver guard computes no result', () => {
  if (skip) return
  const src = `export let f = (n) => { const m = new Map(); for (let i = 0; i < n; i++) { let l = m.get(i & 3); if (l === undefined) { l = []; m.set(i & 3, l) } l.push(i) } let t = 0; for (const [k, v] of m) t += k * v.length; return t }`
  for (const optimize of levels(0, 2, 'size')) for (const n of [0, 9]) is(jz(src, { optimize }).exports.f(n), oracle(src).f(n), `O${optimize}, n=${n}`)
  const lists = `export let f = (n) => { const m = new Map(); for (let i = 0; i < n; i++) { let l = m.get(i & 3); if (l === undefined) { l = []; m.set(i & 3, l) } l.push(i) } return n }`
  is((funcWat(compile(lists, { optimize: { level: 'size', watr: false }, wat: true }), 'f').match(/call \$__ptr_offset\b/g) || []).length, 0, 'no header read for the dropped length')
})

// `if (l === undefined) { l = []; m.set(k, l) }` fills the binding whichever way
// control came, so a read past it needs no guard (emit/dispatch.js filledName).
// A test that lets a null through, an arm that may not fill, an arm or a later
// statement that assigns again, and a closure that assigns all keep the guard.
test('minimal: a binding an if fills holds a value past it', () => {
  if (skip) return
  const of = (seed, fill) => `export let f = (n) => { const m = new Map(); m.set(1, ${seed}); let l = m.get(n); ${fill} l.push(n); return l.length }`
  const out = (fn, n) => { try { return fn(n) } catch { return 'threw' } }
  const guards = (src) => (funcWat(compile(src, { optimize: { level: 'size', watr: false, sourceInline: false }, wat: true }), 'f').match(/\$__throw_property_nullish\b/g) || []).length
  for (const fill of ['if (l === undefined) { l = []; m.set(n, l) }', 'if (l == null) l = [];', 'if (!l) { l = [n] }']) {
    const src = of('[1]', fill)
    for (const optimize of levels(0, 2, 'size')) for (const n of [1, 2]) is(jz(src, { optimize }).exports.f(n), oracle(src).f(n), `${fill}, O${optimize}, n=${n}`)
    is(guards(src), 0, `${fill}: no guard`)
  }
  for (const [seed, fill] of [
    ['null', 'if (l === undefined) l = [];'],
    ['[1]', 'if (l == null) { if (n) l = [] }'],
    ['[1]', 'if (l == null) { l = []; l = m.get(9) }'],
    ['[1]', 'if (l == null) { l = []; l &&= m.get(9) }'],
    ['[1]', 'if (l == null) l = []; l = m.get(9);'],
    ['[1]', 'if (l == null) l = []; if (n) l = m.get(9);'],
    ['[1]', 'for (let i = 0; i < 3; i++) { if (l == null) l = []; if (i == n) l = m.get(9); l.push(i) }'],
    ['[1]', 'const g = () => { l = m.get(9) }; if (l == null) l = []; g();'],
  ]) {
    const src = of(seed, fill), want = oracle(src).f
    for (const optimize of levels(0, 2, 'size')) for (const n of [0, 1, 2]) is(out(jz(src, { optimize }).exports.f, n), out(want, n), `${fill}, O${optimize}, n=${n}`)
    ok(guards(src) > 0, `${fill}: keeps the guard`)
  }
})

// A collection or an array the summary proves is read in place: `new Set(array)`
// by the program's own element read, `.size` from the table's header, `.length = 0`
// by the word (module/collection.js, emit-assign.js). The kinds a proof leaves out
// (a hole, a raw Number array, a table a growth moved, a missing source) answer as JS.
test('minimal: a proven source reads in place', () => {
  if (skip) return
  const srcs = {
    seed: `export let f = (n) => { const a = [1, 2, 2, n, n]; a.push('x'); a.push('x'); const s = new Set(a); return s.size + (s.has(n) ? 10 : 0) + (s.has('x') ? 100 : 0) }`,
    hole: `export let f = (n) => { const a = [1, , 1, , n]; const s = new Set(a); return s.size + (s.has(undefined) ? 10 : 0) }`,
    raw: `export let f = (n) => { const a = new Array(4).fill(0.5); a[1] = n; a[2] = n + 0.25; const s = new Set(a); return s.size + (s.has(0.5) ? 10 : 0) }`,
    missing: `export let f = (n) => { const a = n > 2 ? [1, 2] : undefined; return new Set(a).size }`,
    other: `export let f = (n) => { const a = n > 2 ? 'abca' : new Uint8Array(n); return new Set(a).size }`,
    size: `const ms = []; export let f = (n) => { const m = new Map(), s = new Set(); ms.push(m); for (let i = 0; i < n * 40; i++) { ms[0].set(i, i); s.add(i & 15) } const t = ms.pop(); return m.size + t.size * 1000 + s.size * 1000000 }`,
    clear: `export let f = (n) => { const a = [], b = a; for (let i = 0; i < n * 30; i++) a.push(i); const v = (b.length = 0); a.push(7); return a.length * 10 + b[0] + v + (a[1] === undefined ? 100 : 0) }`,
    clearStatic: `const S = [1, 2, 3]; export let f = (n) => { S.length = 0; S.push(n); return S.length * 10 + S[0] }`,
    sizeMissing: `export let f = (n) => { const s = n > 2 ? new Map([[1, 2]]) : null; return s.size }`,
    clearMissing: `export let f = (n) => { const a = n > 2 ? [1, 2] : undefined; a.length = 0; return 1 }`,
    walk: `export let f = (n) => { const s = new Set([1, n]); let t = 0; for (const x of s) t += x; return t }`,
    walkMissing: `export let f = (n) => { const s = n > 2 ? new Set([1, n]) : undefined; let t = 0; for (const x of s) t += x; return t }`,
  }
  const out = (fn, n) => { try { return fn(n) } catch { return 'threw' } }
  for (const [name, src] of Object.entries(srcs)) {
    const want = oracle(src).f
    for (const optimize of levels(0, 2, 'size')) for (const n of [1, 3]) is(out(jz(src, { optimize }).exports.f, n), out(want, n), `${name}, O${optimize}, n=${n}`)
  }
  const w = (src) => compile(src, { wat: true, optimize: { level: 'size', watr: false, sourceInline: false } })
  ok(!/\$__typed_idx/.test(w(srcs.seed)) && !/\$__ptr_type\b/.test(funcWat(w(srcs.seed), 'f')), 'a proven array: no reader of every kind')
  ok(!/\$__len\b/.test(w(srcs.size)), '.size: no length of every kind')
  ok(!/\$__arr_set_len\b/.test(w(srcs.clear)), '.length = 0: no resize')
  ok(!/\$__jz_last_err_bits/.test(funcWat(w(srcs.walk), 'f')) && /\$__jz_last_err_bits/.test(funcWat(w(srcs.walkMissing), 'f')), 'a walk guards only a source that may be missing')
})

// The size tier reads an element of a known array it cannot prove in bounds
// through the one bounded read (module/array.js), not a bounds test per site;
// an array of Numbers keeps its inline read, whose miss its consumer folds.
test('minimal: the size tier calls the bounded element read', () => {
  if (skip) return
  const src = `export let f = (n) => { const a = ['a', , 'c']; a.push('d'); let s = ''; for (const i of [0, 1, 2, 3, 4, -1, n]) s += a[i] + ',' + a[n - i] + ','; return s }`
  for (const optimize of levels(0, 2, 'size')) for (const n of [0, 2, 7]) is(jz(src, { optimize }).exports.f(n), oracle(src).f(n), `O${optimize}, n=${n}`)
  const w = (s) => funcWat(compile(s, { optimize: { level: 'size', watr: false, sourceInline: false }, wat: true }), 'f')
  ok(/\$__arr_idx_known\b/.test(w(src)), 'the bounded read')
  const nums = `export let f = (n) => { const k = n | 0, a = []; for (let i = 0; i < 9; i++) a.push(i * 0.5); return a[k] + a[k + 1] }`
  for (const optimize of levels(0, 2, 'size')) for (const n of [0, 8, 20]) is(jz(nums, { optimize }).exports.f(n), oracle(nums).f(n), `Numbers, O${optimize}, n=${n}`)
  ok(!/\$__arr_idx_known\b/.test(w(nums)), 'Numbers read inline')
})

// A test that failed stays failed while its locals hold (optimize/settled-tests.js).
test('minimal: a settled test goes', () => {
  if (skip) return
  const src = `const g = (docs, n) => { const stop = new Set(), s = new Set(); stop.add('a1'); for (let i = 0; i <= n; i++) { const doc = docs[i]; for (let k = 0; k < doc.length; k++) if (!stop.has(doc[k])) s.add(doc[k]) } return s.size }
    export let f = (n) => { const a = [], b = []; for (let i = 0; i < 3; i++) b.push('a' + i); a.push(b); a.push(b.slice(1)); return g(a, n) + g(a, n) }`
  const out = (fn, n) => { try { return fn(n) } catch { return 'threw' } }
  for (const optimize of levels(0, 2, 'size')) for (const n of [0, 1, 2]) is(out(jz(src, { optimize }).exports.f, n), out(oracle(src).f, n), `O${optimize}, n=${n}`)
  const guards = (settledTests) => (funcWat(compile(src, { optimize: { level: 'size', watr: false, sourceInline: false, settledTests }, wat: true }), 'g').match(/\$__throw_property_nullish\b/g) || []).length
  is([guards(false), guards(true)], [3, 1], 'one guard for the three reads of a binding')
  const drop = (body) => { const fn = ['func', '$f', ['local', '$x', 'f64'], ['local', '$y', 'f64'], ['local', '$c', 'i32'], ...body]; dropSettledTests(fn); return JSON.stringify(fn) }
  const test = (name = '$x') => ['i64.eq', ['i64.reinterpret_f64', ['local.get', name]], ['i64.const', '0x7ff']]
  const guard = (name) => ['if', test(name), ['then', ['call', '$t'], ['unreachable']]]
  const count = (body) => (drop(body).match(/"\$t"/g) || []).length
  is(count([guard(), guard()]), 1, 'the second goes')
  is(count([['local.set', '$y', ['local.get', '$x']], guard(), guard('$y')]), 1, 'through a capture')
  is(count([guard(), ['call', '$g'], guard()]), 1, 'a call leaves a local alone')
  is(count([guard(), ['if', ['local.get', '$c'], ['then', guard()]]]), 1, 'down into an arm')
  is(count([guard(), ['block', '$b', ['loop', '$l', guard(), ['br', '$l']]]]), 1, 'down into a loop that leaves it alone')
  is(count([['if', ['i32.or', test(), test('$y')], ['then', ['unreachable']]], guard('$y')]), 0, 'a part of a test that failed')
  is(count([guard(), ['local.set', '$x', ['local.get', '$y']], guard()]), 2, 'a write ends it')
  is(count([guard(), ['local.set', '$x', ['call', '$g']], guard()]), 2, 'a write of a call ends it')
  is(count([guard(), ['if', ['local.get', '$c'], ['then', ['local.set', '$x', ['call', '$g']]]], guard()]), 2, 'an arm that writes it ends it')
  is(count([guard(), ['loop', '$l', guard(), ['local.set', '$x', ['local.get', '$y']], ['br_if', '$l', ['local.get', '$c']]]]), 2, 'a loop that writes it')
  is(count([['if', ['local.get', '$c'], ['then', guard()]], guard()]), 2, 'an arm does not dominate')
  is(count([['if', ['local.get', '$c'], ['then', guard()], ['else', guard()]], guard()]), 2, 'both arms do')
  is(count([['block', '$b', ['br_if', '$b', ['local.get', '$c']], guard()], guard()]), 2, 'a branch past it')
  is(count([['if', test(), ['then', ['call', '$u']]], guard()]), 1, 'an arm that falls through settles nothing')
  is(count([['if', test(), ['then', ['block', '$b', ['br_if', '$b', ['local.get', '$c']], ['unreachable']]]], guard()]), 1, 'an arm a branch leaves falls through')
  is(count([['if', test(), ['then', ['unreachable']], ['else', ['local.set', '$x', ['local.get', '$y']]]], guard()]), 1, 'an else that writes it')
  const reTee = ['i64.eq', ['i64.reinterpret_f64', ['local.tee', '$x', ['local.get', '$y']]], ['i64.const', '0x1']]
  is(count([['if', ['i32.or', test(), reTee], ['then', ['unreachable']]], ['local.set', '$y', ['call', '$g']], guard()]), 1, 'a part the test itself rewrites')
  is(count([guard(), ['if', ['i32.or', test(), test()], ['then', ['call', '$t']]]]), 1, 'every part settled')
  ok(drop([guard(), ['if', ['i64.eq', ['i64.reinterpret_f64', ['local.tee', '$y', ['local.get', '$x']]], ['i64.const', '0x7ff']], ['then', ['call', '$t']]], ['call', '$u', ['local.get', '$y']]]).includes('["local.set","$y",["local.get","$x"]]'), 'a dropped test keeps its tees')
  const shared = guard(), mine = ['if', ['local.get', '$c'], ['then', shared], ['else', ['nop']]]
  is(count([mine, shared, shared]), 3, 'a node two parents share stays')
})

// `m.get(k) || 0` of a Map of Numbers is a Number though the read may miss (the
// summary drops what the test discards, kind/val-type-of.js): the sum it enters
// converts nothing, nor does `|| 0` let a miss through (ir/coerce.js
// fallsBackPresent). Its tests are the walked list's guard and the truthiness'.
test('minimal: a logical op of a missing Number is a Number', () => {
  if (skip) return
  const src = `const tally = (lists) => { const m = new Map(); for (const [, l] of lists) m.set(l.length, (m.get(l.length) || 0) + 1); return m }
    export let f = (n) => { const lists = new Map(); for (let i = 0; i < n; i++) { let l = lists.get(i % 3); if (l === undefined) { l = []; lists.set(i % 3, l) } l.push(i) } let t = 0; for (const [k, v] of tally(lists)) t += k * 10 + v; return t }`
  for (const optimize of levels(0, 2, 'size')) for (const n of [0, 2, 7]) is(jz(src, { optimize }).exports.f(n), oracle(src).f(n), `O${optimize}, n=${n}`)
  const w = funcWat(compile(src, { optimize: { level: 'size', watr: false, sourceInline: false }, wat: true }), 'tally')
  is((w.match(/\((i64|f64)\.eq\b/g) || []).length, 2, 'no conversion of the operand')
  const mixed = `export let f = (n) => { const m = new Map(); m.set(1, 'a'); m.set(2, n); return (m.get(n) || 0) + 1 }`
  for (const optimize of levels(0, 2, 'size')) for (const n of [0, 1, 2, 3]) is(jz(mixed, { optimize }).exports.f(n), oracle(mixed).f(n), `mixed, O${optimize}, n=${n}`)
  const bools = `export let f = (n) => { const m = new Map(); m.set(1, true); m.set(2, n > 1); return (m.get(n) || 0) + 1 }`
  for (const optimize of levels(0, 2, 'size')) for (const n of [0, 1, 2, 3]) is(jz(bools, { optimize }).exports.f(n), oracle(bools).f(n), `bools, O${optimize}, n=${n}`)
})

// A probe of a table the summary proves present passes the table's offset and
// takes the hash and equality its key's kinds pick (module/collection/forms.js,
// collection/ordered.js formParams): a key of no string, BigInt or array by its
// bits, strings and atoms by a string's content, any other the general pair.
// The size tier writes the probe, the insertion and the growth once and links
// one probe an operation (stdlib-pull.js collapseTwins). Every form keeps
// SameValueZero (-0 is +0, NaN is NaN), insertion order and a deleted key's
// absence, in a table any other site may fill with keys of other kinds.
const TABLE_KERNELS = {
  ints: `export let f = (n) => { const m = new Map(), s = new Set(); for (let i = -3; i < n; i++) { m.set(i, i * 2); s.add(i & 3) } m.delete(1); m.set(-0, 'z'); s.add(-0); s.delete(2); let o = ''; for (const [k, v] of m) o += k + ':' + v + ','; for (const k of s) o += k + ';'; return o + m.get(0) + m.has(1) + s.has(0) + m.size }`,
  nums: `export let f = (n) => { const s = new Set(), m = new Map(); const xs = [0, -0, NaN, 0 / 0, 1.5, -1.5, n, n / 3, Infinity]; for (const x of xs) { s.add(x); m.set(x, (m.get(x) || 0) + 1) } let o = ''; for (const x of s) o += x + ','; for (const [k, v] of m) o += k + '=' + v + ';'; return o + s.has(NaN) + s.has(-0) + m.get(0) + s.size }`,
  mixed: `export let f = (n) => { const m = new Map(); m.set(1, 'a'); m.set('1', 'b'); m.set(n, 'c'); m.set('' + n, 'd'); m.set(true, 'e'); m.set(null, 'f'); m.set(undefined, 'g'); return [m.get(1), m.get('1'), m.get(n), m.get('' + n), m.get(true), m.get(null), m.get(undefined), m.get(1 === n), m.size].join('|') }`,
  strs: `export let f = (n) => { const m = new Map(), s = new Set(); for (let i = 0; i < n; i++) { const k = 'key' + (i % 5); m.set(k, (m.get(k) || 0) + i); s.add('ab' + (i % 3)) } s.delete('ab1'); let o = ''; for (const [k, v] of m) o += k + v; for (const k of s) o += k; return o + m.get('key' + 2) + s.has('a' + 'b0') + s.has('ab1') + m.has('nope') }`,
  strOrMissing: `export let f = (n) => { const a = ['x', 'y']; const m = new Map(); m.set(undefined, 7); for (let i = 0; i < 4; i++) { const k = a[i]; m.set(k, (m.get(k) || 0) + 1) } return [m.get('x'), m.get(undefined), m.get(a[5]), m.size].join() }`,
  refs: `export let f = (n) => { const a = { id: 1 }, b = { id: 2 }, g = () => n, mm = new Map(); const m = new Map(), s = new Set(); m.set(a, 1); m.set(b, 2); m.set(g, 3); m.set(mm, 4); s.add(a); s.add(a); s.add(b); m.delete(b); for (let i = 0; i < n; i++) mm.set(i, i); return [m.get(a), m.get(b), m.get(g), m.get(mm), m.get({ id: 1 }), s.size, s.has(b), m.size].join() }`,
  objOrMissing: `export let f = (n) => { const os = [{ v: 1 }, { v: 2 }]; const m = new Map(); for (let i = 0; i < 3; i++) { const o = os[i]; m.set(o, i) } return [m.get(os[0]), m.get(undefined), m.get(os[1]), m.size].join() }`,
  grow: `export let f = (n) => { const m = new Map(); for (let i = 0; i < n; i++) m.set(i * 7 % 1000, i); for (let i = 0; i < n; i += 3) m.delete(i * 7 % 1000); let t = 0; for (const [k, v] of m) t = (t * 31 + k + v) | 0; return t + ':' + m.size + ':' + m.get(7) }`,
  churn: `export let f = (n) => { const m = new Map(), s = new Set(), t = new Map(); for (let i = 0; i < n * 25; i++) { m.set(i % 37, i); if (i % 3) m.delete((i * 7) % 37); s.add('k' + (i % 29)); if (i % 4 === 1) s.delete('k' + ((i * 5) % 29)); t.set(i % 11, i); t.delete((i + 3) % 11) } let o = ''; for (const [k, v] of m) o += k + ':' + v + ','; for (const k of s) o += k + ';'; for (let i = 0; i < 40; i++) o += (m.has(i) ? 1 : 0) + (s.has('k' + i) ? 2 : 0); return o + m.size + ':' + s.size + ':' + t.size }`,
  setCopy: `export let f = (n) => { const a = new Set(); for (let i = 0; i < n + 3; i++) a.add('w' + (i % 7)); a.delete('w1'); const b = new Set(a); b.add('x'); a.add('y'); const c = new Set(new Set([3, -0, 3, NaN, n])); let o = ''; for (const k of b) o += k; for (const k of c) o += k + ','; return o + b.size + a.size + b.has('w1') + c.has(0) + c.has(NaN) }`,
  arrayKeys: `export let f = (n) => { const s = new Set(), m = new Map(), held = []; for (let i = 0; i < n + 2; i++) { const o = [i]; held.push(o); s.add(o); m.set(o, i); for (const a of held) a.push(i) } let c = 0; for (const a of held) if (s.has(a)) c += m.get(a) + a.length; return c + ':' + s.has([0]) + ':' + s.size }`,
  setret: `export let f = (n) => { const m = new Map(); const r = m.set(1, 2); const s = new Set(); const q = s.add(n); return (r === m) + ':' + (q === s) + ':' + r.get(1) + ':' + q.has(n) }`,
}

test('minimal: a proven table probes by its key\'s form', () => {
  if (skip) return
  const out = (fn, n) => { try { return fn(n) } catch (e) { return 'threw ' + e.message } }
  for (const [name, src] of Object.entries(TABLE_KERNELS)) {
    const want = oracle(src).f
    for (const optimize of levels(0, 2, 'size')) for (const n of [0, 3, 40]) is(out(jz(src, { optimize }).exports.f, n), out(want, n), `${name}, O${optimize}, n=${n}`)
  }
  const size = (src) => compile(src, { wat: true, optimize: { level: 'size', watr: false } })
  const ints = size(TABLE_KERNELS.ints), strs = size(TABLE_KERNELS.strs), mixed = size(TABLE_KERNELS.mixed)
  ok(!/\(func \$__(map_hash|same_value_zero)\b/.test(ints) && /\(func \$__ord_probe_b\b/.test(ints), 'integer keys: the bits pair alone')
  ok(!/\(func \$__(map_hash|same_value_zero)\b/.test(strs) && /\(func \$__ord_probe_s\b/.test(strs), 'string keys: the string pair alone')
  ok(!/\$__map_get_o[bs]\b/.test(mixed) && /\(func \$__map_get_o\b/.test(mixed), 'two forms of one operation: the general one')
  ok(!/\(loop \$probe/.test(funcWat(ints, '__map_get_ob')) && !/\(loop \$probe/.test(funcWat(ints, '__map_set_ob')) && /\(loop \$probe/.test(funcWat(ints, '__ord_probe_b')), 'the probe written once')
  ok(!/\$__ptr_type\b/.test(funcWat(ints, '__map_get_ob')), 'no tag test of a proven table')
})

// An index the summary bounds reads in place (summary/span.js, summary/index.js):
// a remainder of a shifted word by a fixed array's length, through a constant
// too; a counter its loop bounds by the length, where the body calls a table's
// method or pushes (none shrinks an array). No miss arm, no undefined rendered.
test('minimal: a bounded index reads in place', () => {
  if (skip) return
  const srcs = {
    rem: `const R = ['a', 'b', 'c']; export let f = (s) => { const r = (s >>> 13) % 96; return 'x' + R[r % R.length] + R[(s >>> 1) % 3] }`,
    loop: `export let f = (n) => { const a = [], m = new Map(), q = []; for (let i = 0; i < n; i++) a.push(i * 3); let t = 0; for (let j = 0; j < a.length; j++) { const w = a[j]; if (!m.has(w)) { m.set(w, j); q.push(w) } } for (let h = 0; h < q.length; h++) { t += q[h]; if (h < 3) q.push(h) } return t + ':' + q.length }`,
    bfs: `export let f = (n) => { const adj = new Map(); for (let i = 0; i < n; i++) { let l = adj.get(i & 3); if (l === undefined) { l = []; adj.set(i & 3, l) } l.push(i) } const d = new Map(), q = [0]; let t = 0; for (let h = 0; h < q.length; h++) { const v = q[h]; const list = adj.get(v); if (list === undefined) continue; for (let j = 0; j < list.length; j++) { const w = list[j]; if (!d.has(w)) { d.set(w, h); t += w; q.push(w) } } } return t + ':' + q.length }`,
    shrink: `export let f = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(i); let t = 0; for (let j = 0; j < a.length; j++) { t += a[j] + 1; if (j === 2) a.pop() } return t }`,
  }
  for (const [name, src] of Object.entries(srcs)) for (const optimize of levels(0, 2, 'size')) for (const n of [0, 5, 9]) is(jz(src, { optimize }).exports.f(n), oracle(src).f(n), `${name}, O${optimize}, n=${n}`)
  const w = (src, fn = 'f') => funcWat(compile(src, { optimize: { level: 'size', watr: false }, wat: true }), fn)
  ok(!/__static_str/.test(compile(srcs.rem, { optimize: { level: 'size', watr: false }, wat: true })), 'no undefined to render')
  ok(!/\$__arr_value\b/.test(w(srcs.loop)) && !/\$__arr_value\b/.test(w(srcs.bfs)), 'a bounded read of a hole-free array takes the cell')
})

// The size tier keeps an object boxed where it leaves as a value (a key, an
// argument) more than half as often as a member reads through it
// (compile/analyze/ptr-eligibility.js): each value use would rebox its offset.
test('minimal: an object used as a value stays boxed', () => {
  if (skip) return
  const src = `export let f = (n) => { const os = []; for (let i = 0; i < 4; i++) os.push({ id: i }); const m = new Map(), s = new Set(); let t = 0; for (let i = 0; i < os.length; i++) { const o = os[i]; m.set(o, i); s.add(o); if (m.has(o) && s.has(o)) t += m.get(o) + o.id } return t }`
  for (const optimize of levels(0, 2, 'size')) is(jz(src, { optimize }).exports.f(3), oracle(src).f(3), `O${optimize}`)
  const body = funcWat(compile(src, { optimize: { level: 'size', watr: false }, wat: true }), 'f')
  ok(!/i64\.extend_i32_u \(local\.get \$o/.test(body), 'no rebox of the key')
})

// The layouts the host's decoder reads: an object of the program that reaches
// the host keeps its row (compile/func-exports.js hostReadsObjects, link/sections.js);
// one no export, import or throw can hand over leaves its names out of the module.
test('minimal: a layout the host never reads is not written', () => {
  if (skip) return
  const names = (src) => { const b = WebAssembly.Module.customSections(new WebAssembly.Module(compile(src, { optimize: 'size' })), 'jz:schema'); return b.length ? new TextDecoder().decode(b[0]) : '' }
  ok(!names(`export let f = () => { const m = new Map(); m.set(1, { alpha: 2 }); return m.get(1).alpha }`).includes('alpha'), 'held inside')
  const returned = `export let f = (n) => { const m = new Map(); m.set(1, { alpha: n * 2 }); return m.get(1) }`
  ok(names(returned).includes('alpha'), 'returned')
  is(jz(returned, { optimize: 'size' }).exports.f(3).alpha, 6, 'returned object decodes')
  const taken = `export let f = (o) => { const m = new Map(); m.set(1, { alpha: 1 }); return o.alpha + m.get(1).alpha }`
  ok(names(taken).includes('alpha'), 'an export that takes a value')
  is(jz(taken, { optimize: 'size' }).exports.f({ alpha: 2 }), 3, 'a host object reads')
  const thrown = `export let f = (n) => { const m = new Map(); m.set(1, { alpha: n }); throw m.get(1) }`
  ok(names(thrown).includes('alpha'), 'thrown')
  try { jz(thrown, { optimize: 'size' }).exports.f(4); ok(false, 'throws') } catch (e) { is(e.alpha, 4, 'thrown object decodes') }
  let err = null
  try { jz(`export let f = (n) => { const m = new Map(); return m.get(n).x }`, { optimize: 'size' }).exports.f(1) } catch (e) { err = e }
  ok(err instanceof TypeError && /undefined/.test(err.message), 'a runtime Error keeps its class and message')
  const sections = (src) => WebAssembly.Module.customSections(new WebAssembly.Module(compile(src, { optimize: 'size' })), 'jz:fields').length + WebAssembly.Module.customSections(new WebAssembly.Module(compile(src, { optimize: 'size' })), 'jz:views').length
  // (a program whose runtime may throw keeps the Error's row: the tables stay written for it alone)
  const held = `const o = { a: new Float64Array(2), b: [1], c: 'x' }; o.a[0] = 1; const m = new Map(); m.set(1, o); const r = m.get(2)`
  ok(sections(`export let f = () => { ${held}; return r.a.length + o.b.length + o.c.length }`) === 0, 'no field contract or view past the boundary nothing crosses')
  ok(sections(`export let f = () => { ${held}; return r.a.length ? r : o }`) > 0, 'a value that crosses keeps them')
})

// The size tier's ToInt32 of a Number of unknown range is one call past three
// sites (optimize/to-int32.js outlineToInt32), exact at every value.
test('minimal: a repeated ToInt32 is one call at the size tier', () => {
  if (skip) return
  const src = `export let f = (a, b, c, d) => { const x = a * 1, y = b * 1, z = c * 1, w = d * 1; return ((x | 0) + (y | 0) * 3 + (z | 0) * 5 + (w | 0) * 7) | 0 }`
  for (const args of [[1.5, -2.5, 3, 4], [Infinity, -Infinity, NaN, 0], [2 ** 31, 2 ** 32 + 1, -(2 ** 31) - 1, 2 ** 53]])
    for (const optimize of levels(2, 'size')) is(jz(src, { optimize }).exports.f(...args), oracle(src).f(...args), `O${optimize}, ${args}`)
  ok(/call \$__to_i32\b/.test(compile(src, { optimize: { level: 'size', watr: false }, wat: true })), 'one call')
})

// A program whose keys hold no reference hashes by the number arm alone.
test('minimal: the bits hash links the arms its keys reach', () => {
  if (skip) return
  const hash = (src) => funcWat(compile(src, { optimize: { level: 'size', watr: false }, wat: true }), '__hash_bits')
  ok(!/local\.set \$hi\b/.test(hash(`export let f = (n) => { const m = new Map(); m.set(n | 0, 1); m.set(undefined, 2); return m.get(n | 0) + m.get(undefined) }`)), 'numbers and atoms')
  ok(/local\.set \$hi\b/.test(hash(`export let f = (n) => { const m = new Map(), o = { a: n }; m.set(o, 1); return m.get(o) }`)), 'a reference')
})

// The size tier prints an integer through the scratch render alone, which packs
// a short result into the pointer as the speed tier's digit loop does: the same
// bits for the same text (a Map key, `===` to a literal), with no second path.
test('minimal: the size tier prints an integer by one walk', () => {
  if (skip) return
  const src = `export let f = (n) => { const m = new Map(); for (let i = -2; i < n; i++) m.set('k' + i, i); const s = String(n | 0); return (m.get('k-1') | 0) + (m.get('k' + 12) | 0) * 100 + (s === '40' ? 10000 : 0) + m.size * 100000 + ('' + (1234567 + n)).length * 1000000000 }`
  for (const optimize of levels(0, 2, 'size')) for (const n of [0, 13, 40]) is(jz(src, { optimize }).exports.f(n), oracle(src).f(n), `O${optimize}, n=${n}`)
  const w = compile(src, { optimize: { level: 'size', watr: false }, wat: true })
  ok(!funcWat(w, '__i32_to_str').includes('$packed'), 'no digit-packing loop')
})

// The size tier's remainder is one call, its long division alone (module/core.js
// `__rem`). The expected values are ECMA-262 Number::remainder, by Node's `%`.
test('minimal: the size tier remainder is exact at every operand', () => {
  if (skip) return
  const src = `export let f = (x, y) => x % y; export let g = (x) => x % 8; export let h = (x) => x % 3`
  const want = oracle(src), pairs = [[5.5, 3], [-7, 2], [-4, 2], [0, 5], [-0, 5], [NaN, 3], [3, NaN], [Infinity, 3], [-Infinity, 3], [3, Infinity], [-3, -Infinity], [3, 0], [3, -0], [0, 0],
    [1e23, 7], [9007199254740994, 3.7], [5e-324, 3], [3, 5e-324], [1e308, 3e-300], [-1e308, 7], [1.5, 0.25], [2 ** 53 + 2, 3], [2 ** 60, 10], [7, -3], [-7, -3], [1, 1], [0.1, 0.01]]
  for (const optimize of levels(0, 2, 'size')) {
    const { f, g, h } = jz(src, { optimize }).exports
    for (const [x, y] of pairs) {
      ok(Object.is(f(x, y), want.f(x, y)), `${x} % ${y} at ${optimize}: ${f(x, y)}`)
      ok(Object.is(g(x), want.g(x)) && Object.is(h(x), want.h(x)), `${x} % 8, % 3 at ${optimize}`)
    }
  }
  ok(!/f64\.trunc/.test(funcWat(compile(src, { optimize: { level: 'size', watr: false, sourceInline: false }, wat: true }), 'g')), 'a literal divisor takes the one path')
})

// One walk counts a word's digits at the size tier (module/number.js `__udigits`).
test('minimal: the size tier counts digits at every magnitude', () => {
  if (skip) return
  const src = `export let f = (n) => String(n | 0); export let g = (n) => ('' + (n | 0) + 'x').length; export let h = (n) => [n | 0].join()
    export let u = (n) => String(n >>> 0) + 'x' + (n >>> 0)
    export let c = (x, n) => { const w = String(x); let t = ''; for (let i = 0; i < n; i++) t = w + i; return t }
    export let d = (w, n) => String(w) + (n | 0)`
  const want = oracle(src), values = [0, 1, -1, 9, 10, -10, 99, 100, 999, 1000, 99999, 100000, 999999, 1000000, -1000000, 9999999, 2147483647, -2147483648, 1000000000]
  for (const optimize of levels(0, 2, 'size')) {
    const { f, g, h, u, c, d } = jz(src, { optimize }).exports
    for (const v of values) { is(f(v), want.f(v), `String(${v}) at ${optimize}`); is(g(v), want.g(v), `length at ${v}`); is(h(v), want.h(v), `join at ${v}`); is(u(v), want.u(v), `unsigned at ${v}`); is(d('w', v), want.d('w', v), `word leaf at ${v}`) }
    for (const n of [1, 2, 11, 1001]) is(c('wxyz', n), want.c('wxyz', n), `a counter leaf at ${n}, ${optimize}`)
    is(c('', 2), '1', 'an empty head packs')
  }
})

// A concat of literals and digits whose count alone passes six units skips the
// SSO check; six or fewer still pack it, or a Map or \`===\` would miss the literal.
test('minimal: a short concat stays canonical', () => {
  if (skip) return
  const src = `export let f = (n) => {
    const m = new Map(), c = String.fromCharCode(97 + (n | 0)), d = n | 0
    m.set('abcdef', 1); m.set('abcde', 2); m.set('abcdefg', 3); m.set('a0', 4); m.set('a0bcd', 5); m.set('a0bcde', 6)
    return (m.get(c + 'bcdef') | 0) + (m.get(c + 'bcde') | 0) * 10 + (m.get(c + 'bcdefg') | 0) * 100 + (m.get('a' + d) | 0) * 1000 +
      (m.get('a' + d + 'bcd') | 0) * 10000 + (m.get('a' + d + 'bcde') | 0) * 100000 + ((c + 'bcdef' === 'abcdef') ? 1000000 : 0) + (('' + c + c).length) * 10000000
  }`
  const want = oracle(src).f
  for (const optimize of levels(0, 2, 'size')) for (const n of [0, 1]) is(jz(src, { optimize }).exports.f(n), want(n), `n=${n} at ${optimize}`)
  const w = (t) => funcWat(compile(`export let f = (n) => { const c = String(n); return ${t} }`, { optimize: { level: 'size', watr: false }, wat: true }), 'f')
  ok(!/call \$__sso_norm/.test(w(`'abcd' + c + 'efgh'`)), 'seven literal units: no check')
  ok(/call \$__sso_fresh/.test(w(`'ab' + c + 'cd'`)), 'six or fewer: the check')
})

// A table a holder names past a growth, and an array a table holds past its own,
// reach their live blocks by the walk alone at the size tier.
test('minimal: the size tier walks every stub', () => {
  if (skip) return
  const src = `export let f = (n) => {
    const a = new Map(), b = a, h = { t: a }, s = new Set(), s2 = s, arr = [1]
    a.set('arr', arr)
    let t = 0
    for (let i = 0; i < n; i++) {
      (i & 1 ? a : b).set(i, i); h.t.set(-i - 1, i); s.add(i); s2.add(i * 2); arr.push(i)
      t += a.size + h.t.size * 2 + s2.size * 3
    }
    for (const [k, v] of b) t += v === arr ? 7 : v
    for (const x of s2) t += x
    b.delete(0); s2.delete(0)
    return t + h.t.size + s.size + a.get('arr').length + a.get('arr')[n] * 1000 + (s.has(n - 1) ? 1 : 0)
  }`
  const want = oracle(src).f
  for (const optimize of levels(0, 2, 'size')) for (const n of [0, 1, 7, 40, 300]) is(jz(src, { optimize }).exports.f(n), want(n), `n=${n} at ${optimize}`)
})

// A count kept in a Map reads Number or missing: a fused update carries that kind
// (compile/slot-update.js), so \`|| 0\` and a truth test need no ToNumber or tag test.
test('minimal: a fused update reads the kind of its read', () => {
  if (skip) return
  const src = `export let f = (n) => {
    const m = new Map()
    m.set('z', NaN); m.set('y', 0); m.set('x', 5)
    for (let i = 0; i < n; i++) {
      const k = 'k' + (i & 3)
      m.set(k, (m.get(k) || 0) + 1)
      m.set('z', (m.get('z') || 0) + 1)
      m.set('y', m.get('y') ? 1 : 2)
      m.set('x', (m.get('x') ?? 3) * 2)
    }
    return m.get('k0') + m.get('z') * 100 + m.get('y') * 10000 + m.get('x') * 100000
  }`
  const want = oracle(src).f
  for (const optimize of levels(0, 2, 'size')) for (const n of [1, 2, 9]) is(jz(src, { optimize }).exports.f(n), want(n), `n=${n} at ${optimize}`)
  const body = funcWat(compile(`export let f = (m, k) => { const t = new Map(); t.set(k, 1); t.set(k, (t.get(k) || 0) + 1); return t.get(k) }`, { optimize: { level: 'size', watr: false, sourceInline: false }, wat: true }), 'f')
  ok(!/__to_num\b|i64\.eq/.test(body.slice(body.indexOf('__map_slot'))), 'the old value is a Number past the test')
  const tested = funcWat(compile(`export let f = (k) => { const t = new Map(); t.set(k, 1); t.set(k, t.get(k) ? 1 : 2); return t.get(k) }`, { optimize: { level: 'size', watr: false, sourceInline: false }, wat: true }), 'f')
  ok(!/__is_truthy|__to_bool/.test(tested), 'a truth test of the old value tests a Number')
})

// One walk reads and packs short strings at the size tier (module/string.js
// `__sso_pack`, `__char_at` by `__str_length`): an SSO, a heap string and a view on
// either side, the empty result, a unit past ASCII that stays on the heap.
test('minimal: a short string reads and packs at the size tier', () => {
  if (skip) return
  const src = `
    export let cat = (a, b) => { const s = a + b; const m = new Map(); m.set('abcdef', 1); m.set('', 2); m.set('ab', 3); return s + '|' + s.length + '|' + (m.get(s) | 0) + '|' + (s === 'abcdef') }
    export let view = (a) => { const v = a.slice(2, 5); return (v + 'xyz') + '|' + v.charCodeAt(1) + '|' + v.charCodeAt(5) + '|' + v.charCodeAt(-1) }
    export let at = (a, i) => a.charCodeAt(i)
    export let of = (n) => { const a = String.fromCharCode(97 + (n & 7)), b = String.fromCharCode((n & 127) + 1), c = String.fromCharCode(n & 127); return a + '|' + b.charCodeAt(0) + '|' + b.length + '|' + c.charCodeAt(0) + '|' + (a === 'c') }`
  const want = oracle(src), words = ['', 'a', 'ab', 'abc', 'abcdef', 'abcdefg', 'caf\u00e9', '\u00e9', 'long string on the heap', 'def']
  for (const optimize of levels(0, 2, 'size')) {
    const { cat, view, at, of } = jz(src, { optimize }).exports
    for (const a of words) {
      for (const b of words) is(cat(a, b), want.cat(a, b), `${JSON.stringify(a)} + ${JSON.stringify(b)} at ${optimize}`)
      is(view(a), want.view(a), `view of ${JSON.stringify(a)} at ${optimize}`)
      for (const i of [0, 1, 5, 6, 7, 100, -1]) ok(Object.is(at(a, i), want.at(a, i)), `${JSON.stringify(a)}[${i}] at ${optimize}`)
    }
    for (const n of [0, 2, 7, 96, 126, 127, 255, 1000]) is(of(n), want.of(n), `char code ${n} at ${optimize}`)
  }
  const ascii = funcWat(compile(`export let f = (n) => String.fromCharCode(97 + (n & 7))`, { optimize: { level: 'size', watr: false, sourceInline: false }, wat: true }), 'f')
  ok(!/__char_unit/.test(ascii), 'a code the range holds to ASCII is one inline unit')
  ok(/__char_unit/.test(funcWat(compile(`export let f = (n) => String.fromCharCode((n & 127) + 1)`, { optimize: { level: 'size', watr: false, sourceInline: false }, wat: true }), 'f')), 'one past ASCII is not')
})

// A word's remainder is a word (`next() % n` of a function narrowed to an unsigned
// word): the storage it lands in and a result of it stay integers, seen by a
// caller analyzed before its callee narrowed (narrow/results.js).
test('minimal: a remainder of an unsigned word is a word', () => {
  if (skip) return
  const src = `let seed = 5
    const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
    const pick = () => { const a = next() % 1024, b = next() % 1024; return a < b ? a : b }
    export let f = (n) => { const w = [1, 2, 3, 4]; let t = 0; for (let i = 0; i < n; i++) { const p = pick(); t += p + w[p & 3] } return t }
    export let g = (x) => { const a = (x >>> 0) % 7; return a }`
  for (const optimize of levels(0, 2, 'size')) {
    const want = oracle(src), { f, g } = jz(src, { optimize }).exports
    is(f(50), want.f(50), `a draw at ${optimize}`)
    for (const x of [0, 7, -1, -7, 2 ** 31, 2 ** 32 - 1]) is(g(x), want.g(x), `${x} at ${optimize}`)
  }
  ok(/\(func \$pick\s+\(result i32\)/.test(compile(src, { optimize: { level: 'size', watr: false, sourceInline: false }, wat: true })), 'an integer result')
})
