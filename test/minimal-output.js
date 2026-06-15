// Minimal-output invariants — every emitted construct must be mapped to something
// the source actually needs. A constant carries no `__start`; a heap-free program
// carries no memory/allocator; the allocator (`_alloc`/`_clear` + `__alloc`/
// `__memgrow`/…) appears only when the program allocates. These pin the wins and
// guard against the boilerplate creeping back. Baseline: smaller than AssemblyScript.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { compile } from '../index.js'
import { onWasi, onKernel } from './_matrix.js'

// These pin the *default JS-host* output shape. WASI wraps every module in command
// boilerplate (a `_start` export, fd imports) and the self-host kernel owns its own
// pipeline, so the bare-minimal expectations below don't apply there.
const skip = onWasi() || onKernel()

// Structural probes over WAT text — coarse but exactly what "did we emit X?" means.
const wat = (src, optimize = 0) => compile(src, { wat: true, optimize })
const has = (src, frag, O) => wat(src, O).includes(frag)
const hasMemory = (src, O) => has(src, '(memory', O)
const hasAllocator = (src, O) => has(src, '_alloc', O)        // _alloc/_clear exports + __alloc
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
    for (const O of [0, 2]) {
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
  'numeric fn': 'export const f = (a, b) => a + b',
  'boolean fn': 'export const f = (a) => a > 0',
}
for (const [name, src] of Object.entries(HEAP_FREE)) {
  test(`minimal: heap-free ${name} — no memory/allocator`, () => {
    if (skip) return
    for (const O of [0, 2]) {
      ok(!hasMemory(src, O), `${name} @O${O}: heap-free program must not declare memory`)
      ok(!hasAllocator(src, O), `${name} @O${O}: heap-free program must not pull the allocator`)
    }
  })
}

// === Static strings: data segment, no allocator ===
// A string literal too long for SSO lands in a static data segment with a constant
// pointer. The segment needs memory, but nothing allocates — so no `_alloc`/`_clear`
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
  ok(!hasAllocator('export let f = (a, b) => a * b + 1'), 'arithmetic never allocates')
})

// === No emitted compiler-internal function is dead ===
// Every `$__foo` / `$math.foo` helper in the binary must be *reached* (called, in the elem
// table, or exported). An eager include or a dead-branch dependency that nothing actually
// calls is pure over-production — e.g. string concat used to ship the alloc trio's
// `__alloc_hdr` (which it never calls) and a stray `__str_len`. Holds at every opt level.
const deadInternalFuncs = (src, optimize) => {
  const w = wat(src, optimize)
  const internal = (n) => n !== '$__start' && (n.startsWith('$__') || /^\$[a-z_]+\./.test(n))
  const defined = [...w.matchAll(/\(func (\$[\w.]+)/g)].map((m) => m[1]).filter(internal)
  // A defined helper that appears exactly once in the module text is referenced nowhere but
  // its own definition — dead. Any real reference (call/elem/export) makes the count ≥ 2.
  return defined.filter((fn) => (w.match(new RegExp('\\' + fn + '(?![\\w.])', 'g')) || []).length <= 1)
}
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
    for (const O of [0, 2]) {
      const dead = deadInternalFuncs(src, O)
      is(dead.length, 0, `${name} @O${O}: dead internal funcs — ${dead.join(', ')}`)
    }
  })
}

// === Empty / trivial programs ===
test('minimal: empty program is an empty module', () => {
  if (skip) return
  is(wat('').replace(/\s+/g, ' ').trim(), '(module)')
})
test('minimal: dead pure expression statement is eliminated at O2', () => {
  if (skip) return
  is(wat('1 + 2;', 2).replace(/\s+/g, ' ').trim(), '(module)')
})

// === Constant aggregates: static data segment, no allocator ===
// An all-literal array (≥4 elems) or object literal is a compile-time constant living in
// a static data segment behind a const pointer, like a static string. Nothing allocates,
// so no `_alloc`/`_clear`. Reachability-gated: an array/object module load no longer drags
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
    for (const O of [0, 2]) {
      ok(!has(src, '$__to_num', O), `${name} @O${O}: a numeric slot must not pull ToNumber`)
      ok(!hasAllocator(src, O), `${name} @O${O}: a scalarized numeric object allocates nothing`)
    }
  })
}

// === Function-local array literals stay fresh per call (no static aliasing) ===
// The static-data path is module-scope-only: a function-local literal that is mutated in
// place must NOT alias a shared region, or the mutation leaks across calls. (Imported,
// not run via WAT probes — this is a value-correctness invariant.)
import jz from '../index.js'
test('minimal: function-local mutated array is fresh each call', () => {
  if (skip) return
  const g = jz('export let g = () => { let a = [1,2,3,4]; a[0] = a[0] + 1; return a }').exports.g
  is(JSON.stringify(g()), '[2,2,3,4]', 'call 1')
  is(JSON.stringify(g()), '[2,2,3,4]', 'call 2 must not see call 1’s mutation')
})

// === Small function-local literal arrays scalarize — no memory, no allocator ===
// A non-escaping, fixed-length array of compile-time-constant values, indexed only by
// static integers, dissolves into scalar `a#i` locals (scanFlatObjects, same machinery
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
    for (const O of [0, 2]) {
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

// === Never-relocated arrays skip the realloc-forwarding follow ===
// A fresh array literal whose every use is a pure read (`a[i]` / `a.length`) can never
// be grown, so its index reads derive the base directly — no `__ptr_offset` forwarding
// chase. The SAFETY INVARIANT is the converse: any array that COULD be relocated must
// keep forwarding, or a read through a stale base corrupts memory. Both directions are
// pinned (the second is memory-safety-critical — see scanNeverGrown's default-deny proof).
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

// === Numeric Array(n) sheds the ToNumber / string-format subsystem ===
// A fresh `Array(n)` / `[]` filled only with Number element writes is provably numeric, so
// its `a[i]` reads skip __to_num — the same win a numeric array LITERAL already gets, now
// for the dominant construct-then-fill kernel shape (`let a = Array(n); for(..) a[i] = …`).
// Without it every untyped index drags the full __to_num → __to_str → __ftoa/__itoa/__skipws
// string battery: a 4–17× bloat over the typed-array form (the REPL "Array swap" cliff).
const NUMERIC_FILL = {
  'arithmetic fill': 'export let f=(n)=>{let a=Array(n); for(let i=0;i<n;i++)a[i]=(i%13)-6; let s=0; for(let i=0;i<n;i++)s+=a[i]*a[i]; return s|0}',
  'bare numeric-local write': 'export let f=(n)=>{let a=Array(n); for(let i=0;i<n;i++){let v=i*0.5+1; a[i]=v} let s=0; for(let i=0;i<n;i++)s+=a[i]; return s|0}',
  'self element read': 'export let f=(n)=>{let a=Array(n); for(let i=0;i<n;i++)a[i]=i*3; a[0]=a[n-1]; let s=0; for(let i=0;i<n;i++)s+=a[i]; return s|0}',
  'new Array(n) ctor': 'export let f=(n)=>{let a=new Array(n); for(let i=0;i<n;i++)a[i]=i&7; let s=0; for(let i=0;i<n;i++)s+=a[i]; return s|0}',
}
const STRINGY = ['__to_num', '__to_str', '__str_concat', '__ftoa', '__itoa', '__skipws', '__static_str']
for (const [name, src] of Object.entries(NUMERIC_FILL)) {
  test(`minimal: numeric Array(n) (${name}) skips ToNumber/string`, () => {
    if (skip) return
    for (const O of [0, 2]) {
      const w = wat(src, O)
      for (const h of STRINGY) ok(!w.includes(`$${h} `) && !w.includes(`$${h})`),
        `${name} @O${O}: a numeric Array(n) must not pull ${h}`)
    }
  })
}
// And the elision is value-correct (the read still yields the stored Number; holes are 0).
test('minimal: numeric Array(n) narrowing preserves results', () => {
  if (skip) return
  is(jz(NUMERIC_FILL['arithmetic fill']).exports.f(64), 874, 'arithmetic-fill sum of squares')
  is(jz('export let f=()=>{let a=Array(4); a[0]=5; a[1]=6; let s=0; for(let i=0;i<4;i++)s+=a[i]; return s}').exports.f(), 11, 'unwritten holes read as 0')
})
// SOUNDNESS (default-deny): the moment an array could hold a non-Number, narrowing must
// NOT fire — else `+` would compile to f64.add on a string pointer. These are the cases
// that would catch an over-eager future relaxation of scanNumericFill.
test('minimal: numeric Array(n) narrowing stays sound under non-numeric use', () => {
  if (skip) return
  // escapes to a mutator that writes a string → scanNumericFill disqualifies (any non-index
  // use bails), so `a[0]+a[1]` stays a polymorphic concat, not a numeric add.
  is(jz('let g=(arr)=>{arr[1]="x"+"y"}; export let f=(n)=>{let a=Array(n); for(let i=0;i<n;i++)a[i]=i; g(a); return a[0]+a[1]}').exports.f(3), '0xy', 'escape to string mutator stays string-correct')
  // a string element write in-body poisons the numeric proof (rhs is not VAL.NUMBER).
  is(jz('export let f=(n)=>{let a=Array(n); for(let i=0;i<n;i++)a[i]=i; a[0]="hi"; return a[0]+a[1]}').exports.f(3), 'hi1', 'mixed string write disqualifies narrowing')
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
