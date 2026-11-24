// Data-form gate: how the data is held does not matter, nor how the work on it
// is reached, so every form of the same data compiles as well as its best form.
//
// The same work over the same data, held in each form the bench cases and the
// gallery hold it: a sequence of numbers (made by a typed array or a view of
// one, push, an indexed store, new Array, fill, Array.from, a literal, map or a
// spread copy, and held at module level, in a module `let` an init call sets,
// as a parameter, as a field of an object or of `this`, or captured by a
// closure), a record (a literal, a class instance, `{}` then stores, a spread,
// Object.assign, a factory's result, one of two literals, a tuple, a typed
// array, a record of arrays, a nullable holder), a keyed collection (a Map by
// integer, string or object keys, a Set, an object as a dictionary, in each
// counter spelling); and over the records of a class, each way an object
// program reaches the work (in the loop, a function, a method, an inherited or
// an overridden one, a closure a field holds, getters and setters, a callback)
// and the next record (an index, the iterator, a `next` field, a container's
// `at(i)`). The program of a form holds its group's kernels, each an
// export; a cell is one kernel of one form at level 2 or at 'speed'.
//  (a) Every call answers what Node answers. A difference is a miscompile,
//      never listed.
//  (b) Per kernel the best form sets the bar. Three counts over the loops the
//      kernel's call enters (test/_loop-ops.js), static over the loops a run
//      selected, so the same on every machine: whether the program's own
//      functions hold a SIMD op there (the runtime's `$__*` copy loops use one
//      for every form); the calls there, the runtime's and the program's, but
//      a `$__throw*`; and the ops there, as spellings.js counts them, a called
//      function of the program's counted as its body (see `measure`). A form
//      not vectorized where another is falls short by `simd: 'lost'`; by
//      `calls`, its calls past the fewest of any form; by `ops`, its ops past
//      the form of its own status with the fewest calls, then the fewest ops.
//      Calls are a count apart because a call is one op where the body behind
//      it runs tens to hundreds of them (`__dyn_get_t_h`, `__hash_get_local_h`):
//      by ops alone, a loop that calls the dynamic path would rank above the
//      inline code it falls back from. The start is not a kernel (a module's
//      init may be baked at compile time); the `late` holder's init call is.
//  (c) Memory beside the counts: what a call of the kernel takes from the heap
//      once its first call is behind it (test/_loop-ops.js `steady`: the bump
//      pointer's advance, the middle of eight calls'). A kernel that keeps
//      nothing takes none; one that renews its records takes what the records
//      weigh, and a form short of the lightest falls short by `mem`, in bytes.
//  (d) 'speed' is no worse than level 2: a cell at 'speed' whose call runs
//      more calls (every function's entries counted as the kernel runs, the
//      middle of the same eight calls', so a loop written out four times, an
//      arm that never runs or a first call's snapshots weigh nothing),
//      lost the SIMD level 2 has, or takes more from the heap than the same
//      cell at level 2 falls short by `tier`.
// A shortfall of today is listed in test/data-forms.json. A cell fails on any
// difference from its listing, a smaller gap too, so the list holds what the
// compiler does and only shrinks. Rewrite it with `node test/data-forms.js
// --update`; `node test/data-forms.js --show[=text]` prints each cell's counts
// and its calls by name (`--show=rec/` sweeps one group). A kernel in which no
// form runs a trip is left out of (b) and kept in (a), as in spellings.js.
// The table is the JS host's: under wasi the tests return.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import parseWat from 'watr/parse'
import { onWasi } from './_matrix.js'
import { compile, oracle } from './util.js'
import { loopBodyOps, runEntered, isSite } from './_loop-ops.js'

const LEVELS = [2, 'speed']
const KNOWN = join(import.meta.dirname, 'data-forms.json')
// 256 elements: no loop over them is written out (unrollTrips takes 4 to 16).
const N = 256
const SIMD = /^(v128|[if](8x16|16x8|32x4|64x2))\./
const isSimd = n => typeof n[0] === 'string' && SIMD.test(n[0])
const CALLS = new Set(['call', 'return_call', 'call_indirect', 'return_call_indirect', 'call_ref', 'return_call_ref'])
const lines = (...xs) => xs.flat().filter(Boolean).join('\n') + '\n'
const range = (n, f) => Array.from({ length: n }, (_, i) => f(i))

// ── Sequences ────────────────────────────────────────────────────────────────
// a and b floats, c the output, idx a permutation of 0..N-1 (the index of a
// gather): each made by one of MAKE, the four the same way.
const SEQ = { a: ['i * 0.5', i => i * 0.5], b: ['i + 1', i => i + 1], c: ['0', () => 0], idx: ['(i * 37 + 11) % N', i => (i * 37 + 11) % N] }
const MAKE = {
  typed: (n, v, set, int) => `${set}${n} = new ${int ? 'Int32Array' : 'Float64Array'}(N); for (let i = 0; i < N; i++) ${n}[i] = ${v}`,
  // the decoders' view by subarray at an offset into a larger buffer, held as
  // the bench cases hold it: at module level and passed to a function. (Not a
  // Float32Array: its lane loop takes four elements a pass where Float64Array's
  // takes two, so its static count is no bar for theirs.)
  view: (n, v, set, int) => `${set}${n} = new ${int ? 'Int32Array' : 'Float64Array'}(2 * N).subarray(N >> 1, N + (N >> 1)); for (let i = 0; i < N; i++) ${n}[i] = ${v}`,
  push: (n, v, set) => `${set}${n} = []; for (let i = 0; i < N; i++) ${n}.push(${v})`,
  index: (n, v, set) => `${set}${n} = []; for (let i = 0; i < N; i++) ${n}[i] = ${v}`,
  newArray: (n, v, set) => `${set}${n} = new Array(N); for (let i = 0; i < ${n}.length; i++) ${n}[i] = ${v}`,
  fill: (n, v, set) => `${set}${n} = new Array(N).fill(0); for (let i = 0; i < N; i++) ${n}[i] = ${v}`,
  from: (n, v, set) => `${set}${n} = Array.from({ length: N }, (_, i) => ${v})`,
  literal: (n, v, set, int, f) => `${set}${n} = [${range(N, f).join(', ')}]`,
  map: (n, v, set) => `${set}${n} = new Array(N).fill(0).map((_, i) => ${v})`,
  spread: (n, v, set) => `const ${n}0 = []; for (let i = 0; i < N; i++) ${n}0.push(${v}); ${set}${n} = [...${n}0]`,
}
const makeAll = (form, set) => Object.entries(SEQ).map(([n, [v, f]]) => MAKE[form](n, v, set, n === 'idx', f))
// Each kernel reads the sequences by the names `at` gives them: floats read
// (dot), a store (prefix), integers read as numbers (isum) and as indices
// (gather), and polytri's masked index (mask). `check` reads every element of
// every sequence, so (a) sees each store.
const SEQ_KERNELS = {
  dot: ({ a, b }) => `let s = 0; for (let i = 0; i < N; i++) s += ${a}[i] * ${b}[i]; return s`,
  prefix: ({ a, c }) => `let s = 0; for (let i = 0; i < N; i++) { s += ${a}[i]; ${c}[i] = s } return ${c}[N - 1]`,
  isum: ({ idx }) => `let s = 0; for (let i = 0; i < N; i++) s += ${idx}[i]; return s`,
  gather: ({ a, idx }) => `let s = 0; for (let i = 0; i < N; i++) s += ${a}[${idx}[i]]; return s`,
  mask: ({ b, idx }) => `let s = 0; for (let i = 0; i < N; i++) s += ${b}[${idx}[i] & (N - 1)]; return s`,
}
const SEQ_CHECK = ({ a, b, c, idx }) => `let s = 0; for (let i = 0; i < N; i++) s += ${a}[i] + 2 * ${b}[i] + 3 * ${c}[i] + 5 * ${idx}[i]; return s`
const names = Object.keys(SEQ), at = pre => Object.fromEntries(names.map(n => [n, pre + n]))
const allKernels = { ...SEQ_KERNELS, check: SEQ_CHECK }
const exportsOf = refs => Object.entries(allKernels).map(([k, f]) => `export let ${k} = () => { ${f(refs)} }`)
// Where the program holds the sequences. `late` makes them in an init call, the
// gallery's form, and that call is the kernel `fill`: the other holders make
// them at the start, which no kernel measures.
const HOLD = {
  module: form => lines(makeAll(form, 'const '), exportsOf(at(''))),
  late: form => lines(`let ${names.join(', ')}`, `export let fill = () => {`, makeAll(form, ''), `return 0 }`, exportsOf(at(''))),
  param: form => lines(makeAll(form, 'const '), Object.entries(allKernels).map(([k, f]) => {
    const body = f(at('p')), used = names.filter(n => body.includes(`p${n}[`))
    return `const ${k}Of = (${used.map(n => 'p' + n).join(', ')}) => { ${body} }\nexport let ${k} = () => ${k}Of(${used.join(', ')})`
  })),
  field: form => lines(makeAll(form, 'const '), `const d = { ${names.join(', ')} }`, exportsOf(at('d.'))),
  this: form => lines('class K {', 'constructor() {', makeAll(form, 'const '), names.map(n => `this.${n} = ${n}`), '}',
    Object.entries(allKernels).map(([k, f]) => `${k}() { ${f(at('this.'))} }`), '}', 'const k = new K()',
    Object.keys(allKernels).map(k => `export let ${k} = () => k.${k}()`)),
  closure: form => lines('const mk = () => {', makeAll(form, 'const '), 'return {',
    Object.entries(allKernels).map(([k, f]) => `${k}: () => { ${f(at(''))} },`), '} }', 'const k = mk()',
    Object.keys(allKernels).map(k => `export let ${k} = () => k.${k}()`)),
}
const HOLDS = { view: ['module', 'param'] }
const seqPrograms = () => Object.keys(MAKE).flatMap(form => (HOLDS[form] ?? Object.keys(HOLD)).map(hold => {
  const kernels = [...(hold === 'late' ? ['fill'] : []), ...Object.keys(SEQ_KERNELS)]
  return { form: `${form}@${hold}`, src: `const N = ${N}\n` + HOLD[hold](form), kernels, calls: [...kernels, 'check'] }
}))

// ── Records ──────────────────────────────────────────────────────────────────
// N records {x, y, vx, vy} in an array `ps`, and `st` the one at N/2 held in
// a variable. Each form makes a record of four values by statements that bind
// `n`, a fifth value the condition of the forms that join two literals; its
// `field(p, f)` reads a field, `p.f` where it names none.
const V = { x: i => `${i} * 0.5`, y: i => `${i} + 1`, vx: i => `${i} % 7 - 3`, vy: i => `${i} % 5 * 0.25` }
const FIELDS = Object.keys(V)
const lit = (x, y, vx, vy) => `{ x: ${x}, y: ${y}, vx: ${vx}, vy: ${vy} }`
const prop = (p, f) => `${p}.${f}`
const RECORD = {
  literal: { make: (n, x, y, vx, vy) => `const ${n} = ${lit(x, y, vx, vy)}` },
  class: {
    pre: 'class P { constructor(x, y, vx, vy) { this.x = x; this.y = y; this.vx = vx; this.vy = vy } }',
    make: (n, x, y, vx, vy) => `const ${n} = new P(${x}, ${y}, ${vx}, ${vy})`,
  },
  stores: { make: (n, x, y, vx, vy) => `const ${n} = {}; ${n}.x = ${x}; ${n}.y = ${y}; ${n}.vx = ${vx}; ${n}.vy = ${vy}` },
  spread: { make: (n, x, y, vx, vy) => `const ${n}v = { vx: ${vx}, vy: ${vy} }; const ${n} = { x: ${x}, y: ${y}, ...${n}v }` },
  // the spread's source gains a key under a condition (decode-wav's header)
  spreadOpen: { make: (n, x, y, vx, vy, c) => `const ${n}v = { vx: ${vx}, vy: ${vy} }; if (${c}) ${n}v.t = 1; const ${n} = { x: ${x}, y: ${y}, ...${n}v }` },
  assign: { make: (n, x, y, vx, vy) => `const ${n} = Object.assign({ x: ${x}, y: ${y} }, { vx: ${vx}, vy: ${vy} })` },
  factory: {
    pre: `const mk = (x, y, vx, vy) => (${lit('x', 'y', 'vx', 'vy')})`,
    make: (n, x, y, vx, vy) => `const ${n} = mk(${x}, ${y}, ${vx}, ${vy})`,
  },
  condSame: { make: (n, x, y, vx, vy, c) => `const ${n} = ${c} ? ${lit(x, y, vx, vy)} : ${lit(x, y, vx, vy)}` },
  condOrder: { make: (n, x, y, vx, vy, c) => `const ${n} = ${c} ? ${lit(x, y, vx, vy)} : { vy: ${vy}, vx: ${vx}, y: ${y}, x: ${x} }` },
  // one literal holds a key the other lacks, ahead of the others; no kernel reads it
  condMissing: { make: (n, x, y, vx, vy, c) => `const ${n} = ${c} ? { m: 1, x: ${x}, y: ${y}, vx: ${vx}, vy: ${vy} } : ${lit(x, y, vx, vy)}` },
  tuple: { make: (n, x, y, vx, vy) => `const ${n} = [${x}, ${y}, ${vx}, ${vy}]`, field: (p, f) => `${p}[${FIELDS.indexOf(f)}]` },
  // a typed array as the record (the gallery's scalar boxes, the decoders'
  // arrays of typed arrays)
  box: { make: (n, ...v) => `const ${n} = new Float64Array(4); ${v.slice(0, 4).map((x, i) => `${n}[${i}] = ${x}`).join('; ')}`, field: (p, f) => `${p}[${FIELDS.indexOf(f)}]` },
}
// `step` updates every record in place, `advance` the one held in `st`,
// `renew` replaces every record by a new one of the same form, the update
// written immutably, and `sum` reads two fields of every record straight off
// its element, with no name for the record between.
const recKernels = (r, get) => ({
  step: `for (let i = 0; i < ps.length; i++) { const p = ps[i]; ${get('p', 'x')} += ${get('p', 'vx')}; ${get('p', 'y')} += ${get('p', 'vy')} } return ${get('ps[0]', 'x')}`,
  advance: `for (let i = 0; i < N; i++) { ${get('st', 'x')} += ${get('st', 'vx')}; ${get('st', 'y')} += ${get('st', 'vy')} } return ${get('st', 'x')} + ${get('st', 'y')}`,
  renew: `for (let i = 0; i < ps.length; i++) { const p = ps[i]; ${r.make('q', `${get('p', 'x')} + ${get('p', 'vx')}`, `${get('p', 'y')} + ${get('p', 'vy')}`, get('p', 'vx'), get('p', 'vy'), 'i & 1')}; ps[i] = q } return ${get('ps[0]', 'x')}`,
  sum: `let s = 0; for (let i = 0; i < ps.length; i++) s += ${get('ps[i]', 'x')} + ${get('ps[i]', 'y')}; return s`,
})
const recCheck = get => `let s = 0; for (let i = 0; i < ps.length; i++) { const p = ps[i]; s += ${get('p', 'x')} + 2 * ${get('p', 'y')} + 3 * ${get('p', 'vx')} + 5 * ${get('p', 'vy')} } return s + ${get('st', 'x')} * 7 + ${get('st', 'y')} * 11`
const recProgram = (form, r, late) => {
  const get = r.field ?? prop, ks = recKernels(r, get)
  const build = `for (let i = 0; i < N; i++) { ${r.make('p', ...Object.values(V).map(f => f('i')), 'i & 1')}; ps.push(p) }`
  return {
    form, kernels: Object.keys(ks), calls: [...(late ? ['init'] : []), ...Object.keys(ks), 'check'],
    src: lines(`const N = ${N}`, r.pre, late ? ['let ps = null, st = null', `export let init = () => { ps = []; ${build} st = ps[N >> 1]; return 0 }`] : ['const ps = []', build, 'const st = ps[N >> 1]'],
      Object.entries(ks).map(([k, b]) => `export let ${k} = () => { ${b} }`), `export let check = () => { ${recCheck(get)} }`),
  }
}
const recPrograms = () => [
  ...Object.entries(RECORD).map(([form, r]) => recProgram(form, r)),
  // the literal form held in nullable variables an init call sets (decode-wav's `hdr`)
  recProgram('nullable', RECORD.literal, true),
  // a record of arrays, plain and typed: no record to hold in a variable
  ...[['soa', n => `const ${n} = []; for (let i = 0; i < N; i++) ${n}.push(${V[n.toLowerCase()]('i')})`],
    ['soaTyped', n => `const ${n} = new Float64Array(N); for (let i = 0; i < N; i++) ${n}[i] = ${V[n.toLowerCase()]('i')}`]].map(([form, make]) => ({
    form, kernels: ['step'], calls: ['step', 'check'],
    src: lines(`const N = ${N}`, ['X', 'Y', 'VX', 'VY'].map(make),
      'export let step = () => { for (let i = 0; i < X.length; i++) { X[i] += VX[i]; Y[i] += VY[i] } return X[0] }',
      'export let check = () => { let s = 0; for (let i = 0; i < X.length; i++) s += X[i] + 2 * Y[i] + 3 * VX[i] + 5 * VY[i]; return s }'),
  })),
]

// ── Keyed collections ────────────────────────────────────────────────────────
// K keys; `ks` names them N times in a fixed order, `qs` probes N times, 5 of
// each 42 probes absent. `count` counts each key of ks into the table, `lookup`
// sums the counts qs reads, `member` counts the probes present. A Set holds no
// count: it takes ks at the start and has `member` alone.
const K = 37
const KEYS = {
  int: { key: j => `1000 + 17 * (${j})` },
  str: { key: j => `'k' + (${j})` },
  obj: { key: j => `{ id: ${j} }`, pool: true },
}
const SPELL = {
  getOr: { table: 'new Map()', count: 'm.set(k, (m.get(k) || 0) + 1)', read: 'm.get(k) || 0', has: 'm.has(k)' },
  hasGet: { table: 'new Map()', count: 'm.set(k, m.has(k) ? m.get(k) + 1 : 1)', read: 'm.has(k) ? m.get(k) : 0', has: 'm.has(k)' },
  getUndef: { table: 'new Map()', count: 'const c = m.get(k); m.set(k, c === undefined ? 1 : c + 1)', read: '(m.get(k) ?? 0)', has: 'm.get(k) !== undefined' },
  dictOr: { table: '{}', count: 'm[k] = (m[k] || 0) + 1', read: 'm[k] || 0', has: 'm[k] !== undefined', keys: ['int', 'str'] },
  dictBits: { table: '{}', count: 'm[k] = (m[k] | 0) + 1', read: 'm[k] | 0', has: 'm[k] !== undefined', keys: ['int', 'str'] },
  set: { table: 'new Set()', has: 'm.has(k)' },
}
const keyPrograms = kind => {
  const { key, pool } = KEYS[kind]
  // object keys are records made once; the int and string keys are made per use
  const keyOf = j => pool ? `pool[${j}]` : key(j)
  const seq = (n, j) => kind === 'int'
    ? `const ${n} = new Int32Array(N); for (let i = 0; i < N; i++) ${n}[i] = ${keyOf(j)}`
    : `const ${n} = []; for (let i = 0; i < N; i++) ${n}.push(${keyOf(j)})`
  return Object.entries(SPELL).filter(([, s]) => !s.keys || s.keys.includes(kind)).map(([form, s]) => {
    const ks = {
      ...s.count && {
        count: `for (let i = 0; i < N; i++) { const k = ks[i]; ${s.count} } return 0`,
        lookup: `let s = 0; for (let i = 0; i < N; i++) { const k = qs[i]; s += ${s.read} } return s`,
      },
      member: `let s = 0; for (let i = 0; i < N; i++) { const k = qs[i]; if (${s.has}) s++ } return s`,
    }
    return {
      form, kernels: Object.keys(ks), calls: Object.keys(ks),
      src: lines(`const N = ${N}, K = ${K}`, pool && `const pool = []; for (let j = 0; j < K + 5; j++) pool.push(${key('j')})`,
        seq('ks', '(i * 7) % K'), seq('qs', '(i * 5) % (K + 5)'), `const m = ${s.table}`,
        !s.count && 'for (let i = 0; i < N; i++) m.add(ks[i])',
        Object.entries(ks).map(([k, b]) => `export let ${k} = () => { ${b} }`)),
    }
  })
}

// ── Reaching the work, reaching the next record ──────────────────────────────
// N records of a class, and two kernels over them: `step` updates each in place,
// `sum` reads each. A program is made of how the kernel reaches the next record
// (`walk`) and how it reaches the work on it (`step`, `sum`); `check` reads every
// field of every record through the same walk.
//  call: the work written in the loop, in a function, in a method, in a method a
//  base class defines, in a method each of two or of three classes of the array
//  defines (the same sums, their terms in another order), in a closure a field
//  holds, by getter and setter methods, in a callback a container's `each` calls
//  and in one the array's own `forEach` calls.
//  link: the next record by an index into the array, by the array's iterator,
//  through a `next` field (a list in the array's order), and through a container's
//  `at(i)` and `size()`.
const vals = i => Object.values(V).map(f => f(i)).join(', ')
const ctor = (more = '') => `constructor(x, y, vx, vy) { this.x = x; this.y = y; this.vx = vx; this.vy = vy${more} }`
const cls = (...members) => `class P { ${[ctor(), ...members].join(' ')} }`
const moved = p => `${p}.x += ${p}.vx; ${p}.y += ${p}.vy`
const weighed = p => `${p}.x + 2 * ${p}.y + 3 * ${p}.vx + 5 * ${p}.vy`
const MOVE = `move() { ${moved('this')} }`, WEIGH = `weigh() { return ${weighed('this')} }`
const Q = 'class Q extends P { move() { this.y += this.vy; this.x += this.vx } weigh() { return 5 * this.vy + 3 * this.vx + 2 * this.y + this.x } }'
const R = 'class R extends P { move() { this.x = this.x + this.vx; this.y = this.y + this.vy } weigh() { return 3 * this.vx + this.x + 5 * this.vy + 2 * this.y } }'
const vec = (...members) => `class Vec { constructor() { this.items = [] } add(p) { this.items.push(p) } ${members.join(' ')} }`
const inVec = `const ps = new Vec(); for (let i = 0; i < N; i++) ps.add(new P(${vals('i')}))`
const pushed = (make = i => `new P(${vals(i)})`) => `const ps = []; for (let i = 0; i < N; i++) ps.push(${make('i')})`
const byIndex = body => `for (let i = 0; i < ps.length; i++) { const p = ps[i]; ${body} }`
const objProgram = (form, { pre, build = pushed(), walk = byIndex, step = moved('p'), sum = `s += ${weighed('p')}`, first = 'ps[0]' }) => ({
  form, kernels: ['step', 'sum'], calls: ['step', 'sum', 'check'],
  src: lines(`const N = ${N}`, pre, build,
    `export let step = () => { ${walk(step)}; return ${first}.x }`,
    `export let sum = () => { let s = 0; ${walk(sum)}; return s }`,
    `export let check = () => { let s = 0; ${walk(`s += ${weighed('p')} + 7 * p.x`)}; return s }`),
})
const viaMethod = { step: 'p.move()', sum: 's += p.weigh()' }
const CALL = {
  inline: { pre: cls() },
  fn: { pre: [cls(), `const move = p => { ${moved('p')} }`, `const weigh = p => ${weighed('p')}`], step: 'move(p)', sum: 's += weigh(p)' },
  method: { pre: cls(MOVE, WEIGH), ...viaMethod },
  inherit: { pre: [cls(MOVE, WEIGH), 'class Q extends P {}'], build: pushed(i => `new Q(${vals(i)})`), ...viaMethod },
  override2: { pre: [cls(MOVE, WEIGH), Q], build: pushed(i => `${i} & 1 ? new Q(${vals(i)}) : new P(${vals(i)})`), ...viaMethod },
  override3: { pre: [cls(MOVE, WEIGH), Q, R], build: pushed(i => `${i} % 3 === 1 ? new Q(${vals(i)}) : ${i} % 3 === 2 ? new R(${vals(i)}) : new P(${vals(i)})`), ...viaMethod },
  field: { pre: [`const move = p => { ${moved('p')} }`, `const weigh = p => ${weighed('p')}`, `class P { ${ctor('; this.move = move; this.weigh = weigh')} }`], step: 'p.move(p)', sum: 's += p.weigh(p)' },
  getset: {
    pre: cls('getX() { return this.x }', 'getY() { return this.y }', 'getVx() { return this.vx }', 'getVy() { return this.vy }', 'setX(v) { this.x = v }', 'setY(v) { this.y = v }'),
    step: 'p.setX(p.getX() + p.getVx()); p.setY(p.getY() + p.getVy())', sum: 's += p.getX() + 2 * p.getY() + 3 * p.getVx() + 5 * p.getVy()',
  },
  each: { pre: [cls(), vec('each(f) { for (let i = 0; i < this.items.length; i++) f(this.items[i]) }')], build: inVec, walk: body => `ps.each(p => { ${body} })`, first: 'ps.items[0]' },
  forEach: { pre: cls(), walk: body => `ps.forEach(p => { ${body} })` },
}
const LINK = {
  index: { pre: cls() },
  of: { pre: cls(), walk: body => `for (const p of ps) { ${body} }` },
  list: {
    pre: `class P { ${ctor('; this.next = null')} }`, first: 'head',
    build: `let head = null; for (let i = N - 1; i >= 0; i--) { const p = new P(${vals('i')}); p.next = head; head = p }`,
    walk: body => `for (let p = head; p !== null; p = p.next) { ${body} }`,
  },
  vector: {
    pre: [cls(), vec('at(i) { return this.items[i] }', 'size() { return this.items.length }')], build: inVec, first: 'ps.at(0)',
    walk: body => `for (let i = 0; i < ps.size(); i++) { const p = ps.at(i); ${body} }`,
  },
}
const objPrograms = forms => () => Object.entries(forms).map(([form, o]) => objProgram(form, o))

const GROUPS = {
  seq: seqPrograms,
  rec: recPrograms,
  'key-int': () => keyPrograms('int'),
  'key-str': () => keyPrograms('str'),
  'key-obj': () => keyPrograms('obj'),
  call: objPrograms(CALL),
  link: objPrograms(LINK),
}

// ── The measure ──────────────────────────────────────────────────────────────
const show = v => Object.is(v, -0) ? '-0' : String(v)
// A program at a level: each call's answer, and per kernel the counts of the
// loops its call entered. The program's own functions are those not named
// `$__*` (the runtime's, and the module's init `$__start`). A call of one of
// them counts its body where it is called, all but the body's own loops, which
// count where a run enters them: the optimizer moves a loop's body into a
// function of its own (`gather$s0`), and that body is the loop's work. The SIMD
// ops count in the program's functions alone: the runtime's copy loops use them
// for every form. A call of `$__throw*` is the error path, never returning: the
// test before it counts as ops, the call not at all.
const DECL = new Set(['param', 'result', 'local', 'export', 'type'])
const measure = (p, level) => {
  const tree = parseWat(compile(p.src, { optimize: level, wat: true }))
  const { runs, kept } = runEntered(tree, p.calls.map(c => [c, []]), true, p.kernels)
  const funcs = new Map(tree.filter(n => Array.isArray(n) && n[0] === 'func' && !String(n[1]).startsWith('$__')).map(f => [f[1], f]))
  const own = ['module', ...funcs.values()]
  const callee = n => CALLS.has(n[0]) && !String(n[1]).startsWith('$__throw') && (n[0].includes('call_') ? n[0] : n[1])
  const NONE = { ops: 0, calls: [], simd: 0 }
  // a call's weight: the call, and the body of a program function it calls
  const bodies = new Map()
  const weight = n => {
    const f = callee(n), b = f && funcs.has(f) ? body(f) : NONE
    return { ops: 1 + b.ops, calls: f ? [f.replace(/^\$/, ''), ...b.calls] : [], simd: Number(isSimd(n)) + b.simd }
  }
  const body = f => {
    if (bodies.has(f)) return bodies.get(f) ?? NONE
    bodies.set(f, null)
    const out = { ops: 0, calls: [], simd: 0 }
    const walk = n => {
      if (!Array.isArray(n) || n[0] === 'loop' || isSite(n)) return
      const w = weight(n)
      out.ops += w.ops; out.calls.push(...w.calls); out.simd += w.simd
      n.forEach(walk)
    }
    funcs.get(f).slice(2).filter(n => !(Array.isArray(n) && DECL.has(n[0]))).forEach(walk)
    bodies.set(f, out)
    return out
  }
  return {
    out: runs.map(r => r.ret),
    cost: Object.fromEntries(p.kernels.map(k => {
      const m = runs[p.calls.indexOf(k)].loops, calls = []
      loopBodyOps(tree, m, n => { calls.push(...weight(n).calls); return 0 })
      return [k, {
        simd: loopBodyOps(own, m, n => weight(n).simd) > 0, calls,
        ops: loopBodyOps(tree, m, n => weight(n).ops), trips: [...m.values()].some(h => h > 1),
        mem: kept.get(k).mem, ran: kept.get(k).ran,
      }]
    })),
  }
}
const node = p => { const m = oracle(p.src); return p.calls.map(c => m[c]()) }

// One group at one level: the miscompiles, each cell's counts, and each short
// cell's gap.
const swept = new Map()
const sweep = (group, level) => {
  const id = `${group}/${level}`
  if (!swept.has(id)) swept.set(id, sweepOnce(group, level))
  return swept.get(id)
}
const sweepOnce = (group, level) => {
  const bad = [], rows = {}
  for (const p of GROUPS[group]()) {
    const key = k => `${group}/${p.form}/${k}/${level}`
    let m
    try { m = measure(p, level) } catch (e) { bad.push(`${key('*')}: ${e.message.split('\n')[0]}\n${p.src}`); continue }
    const want = node(p)
    p.calls.forEach((c, i) => Object.is(m.out[i], want[i]) || bad.push(`${key(c)}: jz ${show(m.out[i])}, node ${show(want[i])}\n${p.src}`))
    for (const k of p.kernels) (rows[k] ??= []).push({ key: key(k), ...m.cost[k] })
  }
  const gaps = {}
  for (const cells of Object.values(rows)) {
    if (!cells.some(r => r.trips)) continue
    const vec = cells.some(r => r.simd), fewest = Math.min(...cells.map(r => r.calls.length)), least = Math.min(...cells.map(r => r.mem))
    for (const status of [true, false]) {
      const peers = cells.filter(r => r.simd === status)
      if (!peers.length) continue
      const bar = peers.reduce((b, r) => r.calls.length < b.calls.length || r.calls.length === b.calls.length && r.ops < b.ops ? r : b)
      for (const r of peers) {
        const g = {}
        if (vec && !status) g.simd = 'lost'
        if (r.calls.length > fewest) g.calls = r.calls.length - fewest
        if (r.ops > bar.ops) g.ops = r.ops - bar.ops
        if (r.mem > least) g.mem = r.mem - least
        if (Object.keys(g).length) gaps[r.key] = g
      }
    }
  }
  const all = Object.values(rows).flat()
  // (d): against the same cell a tier below
  if (level === 'speed') {
    const below = new Map(sweep(group, 2).rows.map(r => [r.key.slice(0, r.key.lastIndexOf('/')), r]))
    for (const r of all) {
      const b = below.get(r.key.slice(0, r.key.lastIndexOf('/')))
      if (!b || !(r.trips || b.trips)) continue
      const tier = {}
      if (r.ran > b.ran) tier.calls = r.ran - b.ran
      if (b.simd && !r.simd) tier.simd = 'lost'
      if (r.mem > b.mem) tier.mem = r.mem - b.mem
      if (Object.keys(tier).length) (gaps[r.key] ??= {}).tier = tier
    }
  }
  return { bad, gaps, rows: all }
}

// Every cell the gate measures, by key; no compile.
const cells = () => Object.entries(GROUPS).flatMap(([group, programs]) =>
  programs().flatMap(p => p.kernels.flatMap(k => LEVELS.map(l => `${group}/${p.form}/${k}/${l}`))))

// A cell's shortfall against what the table lists for it.
const verdict = (key, g = {}, k = {}) => {
  const bad = []
  for (const [f, what] of [['calls', 'calls'], ['ops', 'ops'], ['mem', 'bytes kept a call']]) {
    if (g[f] && !k[f]) bad.push(`${key}: ${g[f]} ${what} past the best form, not listed`)
    else if ((g[f] || 0) !== (k[f] || 0)) bad.push(`${key}: ${g[f] || 'no'} ${what} past the best form now, listed ${k[f]}`)
  }
  if (g.simd !== k.simd) bad.push(`${key}: ${g.simd ? 'not vectorized where another form is' : 'vectorized as the best form'}, listed ${k.simd ?? 'none'}`)
  const tier = t => t ? JSON.stringify(t) : 'none'
  if (tier(g.tier) !== tier(k.tier)) bad.push(`${key}: short of level 2 by ${tier(g.tier)}, listed ${tier(k.tier)}`)
  return bad
}

const pass = (group, level) => `${group} at ${level === 2 ? 'level 2' : level}`
const update = process.argv.includes('--update'), shown = process.argv.find(a => a.startsWith('--show'))
if (update || shown) {
  if (onWasi()) throw new Error('data-forms: the table is the JS host\'s; run without JZ_TEST_HOST=wasi')
  // `--show=rec/` sweeps that group alone, a filter without a group all of them;
  // `--update` sweeps all
  const filter = shown?.split('=')[1] ?? ''
  const wanted = group => update || !filter.includes('/') || filter.startsWith(group + '/')
  const known = {}, bad = []
  for (const group of Object.keys(GROUPS)) for (const level of LEVELS) {
    if (!wanted(group)) continue
    const t0 = performance.now(), r = sweep(group, level)
    console.error(`${pass(group, level)}: ${((performance.now() - t0) / 1000).toFixed(1)} s`)
    bad.push(...r.bad); Object.assign(known, r.gaps)
    if (shown) for (const c of r.rows) if (c.key.includes(filter))
      console.log(`${c.key}  ${c.simd ? 'simd ' : ''}${c.ops} ops  ${c.calls.length} calls${c.calls.length ? ' ' + c.calls.join(' ') : ''}  ${c.ran} run${c.mem ? `  takes ${c.mem} bytes a call` : ''}${r.gaps[c.key] ? '  short ' + JSON.stringify(r.gaps[c.key]) : ''}`)
  }
  if (update) {
    const keys = cells().filter(k => known[k])
    writeFileSync(KNOWN, '{\n' + keys.map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(known[k])}`).join(',\n') + '\n}\n')
    console.log(`data-forms: ${keys.length} gaps of ${cells().length} cells written to ${KNOWN}`)
  }
  if (bad.length) { console.error(`answers differ, not listed:\n${bad.join('\n')}`); process.exitCode = 1 }
} else {
  const known = JSON.parse(readFileSync(KNOWN, 'utf8'))
  test('data-forms: a cell passes only as listed, a smaller gap failing like a larger one', () => {
    const fails = (g, k) => verdict('cell', g, k).length
    for (const [g, k] of [[{}, {}], [{ ops: 5 }, { ops: 5 }], [{ calls: 2, ops: 5 }, { calls: 2, ops: 5 }], [{ simd: 'lost' }, { simd: 'lost' }], [{ mem: 64 }, { mem: 64 }], [{ tier: { calls: 1 } }, { tier: { calls: 1 } }]]) ok(!fails(g, k), `as listed: ${JSON.stringify([g, k])}`)
    for (const [g, k] of [[{ ops: 5 }, {}], [{ ops: 5 }, { ops: 3 }], [{ ops: 3 }, { ops: 5 }], [{}, { ops: 5 }], [{ calls: 1 }, { calls: 2 }], [{ calls: 2 }, {}],
      [{}, { calls: 1 }], [{ simd: 'lost' }, {}], [{}, { simd: 'lost' }], [{ simd: 'lost' }, { ops: 5 }], [{ ops: 5 }, { calls: 5 }],
      [{ mem: 64 }, {}], [{}, { mem: 64 }], [{ mem: 64 }, { mem: 32 }], [{ tier: { calls: 1 } }, {}], [{}, { tier: { mem: 8 } }], [{ tier: { calls: 1 } }, { tier: { calls: 2 } }]]) ok(fails(g, k), `differs: ${JSON.stringify([g, k])}`)
  })
  test('data-forms: every listed gap names a cell the gate measures', () => {
    const all = new Set(cells()), stale = Object.keys(known).filter(k => !all.has(k))
    ok(!stale.length, stale.length ? `not measured: ${stale.join(', ')}` : 'listed cells')
  })
  for (const group of Object.keys(GROUPS)) for (const level of LEVELS) {
    test(`data-forms: ${pass(group, level)} answers what Node does and compiles as well as the best form`, () => {
      if (onWasi()) return
      const { bad, gaps } = sweep(group, level)
      ok(!bad.length, bad.length ? `answers differ from Node, a miscompile:\n${bad.join('\n')}` : 'every form answers what Node answers')
      const keys = cells().filter(k => k.startsWith(`${group}/`) && k.endsWith(`/${level}`))
      const off = keys.flatMap(k => verdict(k, gaps[k], known[k]))
      ok(!off.length, off.length ? `${off.join('\n')}\nIf a gap closed or moved, rewrite the table: node test/data-forms.js --update` : 'gaps as listed')
    })
  }
}
