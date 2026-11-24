// Property reads by schema (devirtSchemaReads and the dispatch it builds), escape
// analysis of local objects, and integer certainty through captures and schema slots.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { onKernel, levels, belowOpt, onWasi } from './_matrix.js'
import { ctx } from '../src/ctx.js'
import parseWat from 'watr/parse'
import encodeWat from 'watr/compile'
import { devirtSchemaReads } from '../src/optimize/devirt.js'
import { objectSchemaGuardHex } from '../layout.js'
import { passFacts } from '../src/wat/assemble/optimize-module.js'
import { funcWat, run, oracle, jz, compile } from './util.js'
import { count, walk } from '../scripts/wat-probe.mjs'
import { findFunc } from './_optimizer.js'

test('devirtSchemaReads: schemas with the same field slot share one dispatch arm', () => {
  const src = `const rows = [{x:1,a:0}, {x:2,b:0}, {p:0,x:3}, {p:0,x:4,q:0}, {q:0,r:0,x:5}, {pad:9}, 7]
    export function read(o) { return o.x }
    export function f(i) { return read(rows[i]) }`
  const w = compile(src, { wat: true, optimize: { level: 1, sourceInline: false, watr: false } })
  const body = findFunc(parseWat(w), '$read')
  ok(body, 'the dynamic read keeps its own body')
  const ir = JSON.stringify(body)
  ok(ir.includes('br_table'), 'the dense schema dispatch is exercised')
  is((ir.match(/"i64.load"/g) || []).length, 3, 'five schemas use three distinct slot loads')
  const ref = oracle(src).f
  for (const level of levels(1, 2, 3, 'size')) {
    const { f } = run(src, { optimize: { level, sourceInline: false } })
    for (const i of [0, 1, 2, 3, 4, 5, 6, 0]) is(f(i), ref(i), `O${level}, row ${i}`)
  }
})

test('devirtSchemaReads: empty branch and loop regions cannot leak cached reads', () => {
  const src = `export function value(o,n) {
    let s = 0
    if (n > 0) s += o.x + o.x
    if (n === 2) o.x += 3
    for (let i = 0; i < n; i++) { s += o.x + o.x; o.x++ }
    return s + o.x + o.x
  }
  export function f(n,k) { return value(k ? {x:3,p:2} : {p:2,x:4}, n) }`
  ok(compile(src, { wat: true, optimize: { level: 1, sourceInline: false, watr: false } }).includes('__dsr'), 'the schema-read pass handles this receiver')
  const ref = oracle(src).f
  for (const level of levels(1, 2, 3, 'size')) {
    const { f } = run(src, { optimize: { level, sourceInline: false } })
    for (const n of [-1, 0, 1, 2, 3, 0]) for (const k of [0, 1]) is(f(n,k), ref(n,k), `O${level}, n=${n}, k=${k}`)
  }
})

test('devirtSchemaReads: registered field slots remain isolated across compilations', () => {
  const graphs = [
    `const rows = [{x:1,y:2}, {pad:8,x:3,y:4}, {y:6}];`,
    `const rows = [{pad:9,y:3,x:7}, {x:5,y:4}, {y:2,pad:8}];`,
  ]
  const body = `function get(o) { return (o.x === undefined ? -1 : o.x) + o.y }
    export function f(i) { return get(rows[i % 3]) }`
  for (const level of levels(1, 2, 3, 'size')) for (const graph of [0, 0, 1, 0]) {
    const src = graphs[graph] + body
    const { f } = run(src, { optimize: { level, sourceInline: false } })
    const ref = oracle(src).f
    for (const i of [0, 1, 2, 0]) is(f(i), ref(i), `O${level}, graph ${graph}, row ${i}`)
  }
})

test('devirtSchemaReads: sparse fields remain specialized past 24 module schemas', () => {
  const src = `const rows=[{wanted:7},${Array.from({length:30}, (_,i)=>`{field${i}:${i}}`).join(',')},{padding:1,wanted:9}]
    function get(o){return o.wanted}
    export function f(k){return get(rows[k])}`
  const w = compile(src, { wat: true, optimize: { level: 1, watr: false } })
  const start = w.indexOf('(func $get\n'), body = w.slice(start, w.indexOf('(func', start + 1))
  ok(start >= 0 && (body.match(/i64\.load/g) || []).length === 2, 'unrelated schemas do not disable specialization')
  ok(!body.includes('br_table'), 'sparse schema ids do not allocate a wide jump table')
  const { f } = run(src, { optimize: { level: 1, snapshotInit: true } })
  for (const k of [0, 0, 31, 1, 0]) is(f(k), k === 0 ? 7 : k === 31 ? 9 : undefined)
})

test('devirtSchemaReads: Number bits matching an object tag stay on the generic path', () => {
  const src = `const object={wanted:7}; function get(o){return o.wanted}
    export function f(k){return get(k ? object : 1.6875)}`
  for (const optimize of levels(1, 2, 3)) {
    const { f } = run(src, { optimize: { level: optimize, snapshotInit: true } })
    for (const k of [0, 1, 0]) is(f(k), k ? 7 : undefined, `O${optimize}, input ${k}`)
  }
})

test('devirtSchemaReads: a raw Number slot read by the dispatch canonicalizes its NaN in the arm', () => {
  // Every schema an arm loads `v` for keeps it a raw Number: the arm turns a
  // NaN of any payload (here one that reads as a string box, and the
  // undefined atom's bits) into the canonical NaN, as `__schema_value` does.
  const src = `const bits = new Float64Array(2), words = new Uint32Array(bits.buffer)
    words[0] = 16; words[1] = 0x7ffa0001; words[2] = 0; words[3] = 0x7ff80001
    const odd = bits[0], undefLike = bits[1]
    const mk = (k, v) => k % 3 === 0 ? { t: k, v } : k % 3 === 1 ? { u: k, w: 2, v } : { a: 1, b: 2, c: 3, v }
    const list = []
    for (let i = 0; i < 6; i++) list.push(mk(i, i < 3 ? odd : undefLike))
    export let f = (i) => { const o = list[i % 6], v = o.v
      return (typeof v) + ':' + (v !== v) + ':' + (v === undefined) + ':' + String(v) }`
  ok(!funcWat(compile(src, { wat: true, optimize: 'speed' }), 'f').includes('$__schema_value'), 'the arms convert the slots they load')
  const ref = oracle(src).f
  for (const optimize of levels(0, 2, 3, 'size')) {
    const { f } = run(src, { optimize })
    for (let i = 0; i < 6; i++) is(f(i), ref(i), `O${optimize}, row ${i}`)
  }
})

test('devirtSchemaReads: megamorphic property read switches on schemaId to direct slot loads', () => {
  // The shapes-bench class: one access site seeing several record variants —
  // the ~50-op __dyn_get_any_t_h hash probe becomes a br_table on the box's aux
  // schemaId into direct slot loads, original call as the always-sound default.
  const src = `const mk = (k, a, b) => k === 0 ? { t: k, x: a, y: b } : k === 1 ? { t: k, r: a } : { t: k, w: a, h: b }
  const geo = (o, sel) => sel === 0 ? o.x + o.y : sel === 1 ? o.r * 3 : o.w * o.h
  export let f = (n) => { let s = 0; for (let i = 0; i < n; i++) s += geo(mk(i % 3, i + 1, i + 2), i % 3); return s }`
  const w = compile(src, { wat: true, optimize: { level: 'speed', watr: false } })
  const { f } = run(src, { optimize: 'speed' })
  const mk = (k, a, b) => k === 0 ? { t: k, x: a, y: b } : k === 1 ? { t: k, r: a } : { t: k, w: a, h: b }
  const geoJs = (o, sel) => sel === 0 ? o.x + o.y : sel === 1 ? o.r * 3 : o.w * o.h
  let ref = 0; for (let i = 0; i < 9; i++) ref += geoJs(mk(i % 3, i + 1, i + 2), i % 3)
  is(f(9), ref, 'devirted reads bit-match the generic path')
})

test('devirtSchemaReads: stable receiver hoists one sid; proven discriminant field is a bare load', () => {
  // Receiver-stable refinement (shapes bench residual): a never-written
  // receiver's schemaId is constant (aux bits; jz OBJECT shape never changes),
  // so a multi-read function computes `sid | -1` ONCE (entry-hoisted select) and
  // every read drops its per-read __ptr_type guard + aux extract. Receiver flows
  // through a mixed array (rows[i] — the shapes-bench shape), so emit can't
  // specialize and the reads reach the pass tagged. `x` sits at DIFFERENT slots
  // across schemas (slot 1 vs slot 2), forcing a real br_table; `t` is first
  // everywhere → collapse.
  const src = `const mkRows = () => {
    const rows = []
    for (let i = 0; i < 9; i++) {
      const k = i % 3
      if (k === 0) rows.push({ t: k, x: i + 1, y: i + 2 })
      else if (k === 1) rows.push({ t: k, r: i + 1, x: i + 2 })
      else rows.push({ t: k, w: i + 1, h: i + 2 })
    }
    return rows
  }
  const geo = (o) => { const s = o.t; return s === 0 ? o.x * 2 + o.y : s === 1 ? o.r * 3 + o.x : o.w * o.h }
  export let f = () => { const rows = mkRows(); let acc = 0; for (let i = 0; i < rows.length; i++) acc += geo(rows[i]); return acc }`
  // `geo` is a hot leaf the speed tier would splice into f's loop; the pass
  // under test needs it as its own function, so keep it out of the inliner.
  const w = compile(src, { wat: true, optimize: { level: 'speed', watr: false, sourceInline: false } })
  const gAt = w.indexOf('(func $geo')
  ok(gAt >= 0, 'geo compiles as its own function pre-watr')
  const geoWat = w.slice(gAt, w.indexOf('(func', gAt + 1))
  ok(/\$__dsrs\d+/.test(geoWat), 'multi-read receiver gets an entry-hoisted sid local')
  // a proven-OBJECT receiver needs no tag test: the sid is a bare aux extract; an unproven one selects over the tag test
  ok(/local\.set \$__dsrs\d+\s*\((?:i32\.wrap_i64|select)/.test(geoWat), 'sid computed branch-free (bare aux extract, or select over tag test)')
  ok(/br_table/.test(geoWat), 'slot-conflicting prop still dispatches via br_table')
  ok(!/br_if[^\n]*\n?[^\n]*call \$__ptr_type/.test(geoWat), 'no per-read tag-guard call in the dispatches')
  let discriminant
  walk(parseWat(geoWat), n => {
    if (!discriminant && (n[0] === 'local.set' || n[0] === 'local.tee') && n[1] === '$s') discriminant = n[2]
  })
  // Later writes may reuse s's dead slot; only its first definition is the discriminant.
  is(count(discriminant, n => n[0] === 'f64.load'), 1, 'discriminant reads one slot')
  is(count(discriminant, n => n[0] === 'br_table' || n[0] === 'call' && n[1] !== '$__throw_property_nullish'), 0,
    'only the nullish error path can call; the field load stays direct')
  const mkRowsJs = () => {
    const rows = []
    for (let i = 0; i < 9; i++) {
      const k = i % 3
      if (k === 0) rows.push({ t: k, x: i + 1, y: i + 2 })
      else if (k === 1) rows.push({ t: k, r: i + 1, x: i + 2 })
      else rows.push({ t: k, w: i + 1, h: i + 2 })
    }
    return rows
  }
  const geoJs = (o) => { const s = o.t; return s === 0 ? o.x * 2 + o.y : s === 1 ? o.r * 3 + o.x : o.w * o.h }
  const rowsJs = mkRowsJs(); let ref = 0
  for (let i = 0; i < rowsJs.length; i++) ref += geoJs(rowsJs[i])
  const { f } = run(src, { optimize: 'speed' })
  is(f(), ref, 'refined reads bit-match the generic path')
})

test('schema discriminant hint narrows one guard but preserves alien-schema fallback', () => {
  // `const k=o.k; if(k===K)` may predict the schema whose immutable tag is K,
  // but it cannot prove host/dynamic schemas never carry K. The optimization
  // must keep an exact-sid guard and the ordinary dynamic miss arm.
  const src = `
    // Consumer deliberately precedes producers: the census is a whole-program
    // fact, never an emitter/function-order side effect.
    const visit = (o) => { const k = o.k; if (k === 0) return (o.x + o.y) | 0; else if (k === 1) return (o.r * 3) | 0; else if (k === 2) return (o.w * o.h) | 0; return -1 }
    const expected = (k) => k === 0 ? { k: k, x: 7, y: 9 } : k === 1 ? { k: k, r: 5 } : { k: k, w: 4, h: 6 }
    const alien = (k) => ({ k: k, z: 41 })
    export const f = (useAlien) => visit(useAlien ? alien(0) : expected(0))
  `
  const w = compile(src, { wat: true, optimize: { level: 'speed', watr: false } })
  const at = w.indexOf('(func $visit')
  const visitWat = w.slice(at, w.indexOf('(func', at + 1))
  ok((visitWat.match(/i64\.eq/g) || []).length >= 3, 'each predicted branch keeps an exact runtime SID guard')
  ok(/call \$__dyn_get/.test(visitWat), 'guard miss retains dynamic property semantics')
  const { f } = run(src, { optimize: 'speed' })
  is(f(0), 16, 'predicted schema takes direct slots')
  is(f(1), 0, 'same tag on alien schema takes dynamic missing-field path')
})

test('devirtSchemaReads: duplicate read of the same (receiver, prop) reuses one dispatch', () => {
  // The shapes-bench k=1/6 residual: `o.r * (o.r + 3)` paid TWO full
  // sid-dispatch blocks. Two schemas carry r so the reads exercise dispatch
  // memoization.
  const mkSrc = (body) => `const mkRows = () => {
    const rows = []
    for (let i = 0; i < 9; i++) {
      const k = i % 3
      if (k === 0) rows.push({ t: k, x: i + 1, y: i + 2 })
      else if (k === 1) rows.push({ t: k, r: i + 1, x: i + 2 })
      else rows.push({ t: k, w: i + 1, h: i + 2, r: i + 3 })
    }
    return rows
  }
  const geo = (o) => { const s = o.t; return s === 0 ? o.x * 2 + o.y : s === 1 ? ${body} : o.w * o.h }
  export let f = () => { const rows = mkRows(); let acc = 0; for (let i = 0; i < rows.length; i++) acc += geo(rows[i]); return acc }`
  const src = mkSrc('o.r * (o.r + 3)')
  const w = compile(src, { wat: true, optimize: { level: 'speed', watr: false, sourceInline: false } })
  const gAt = w.indexOf('(func $geo')
  const geoWat = w.slice(gAt, w.indexOf('(func', gAt + 1))
  // (the memo local may share a slot with another i64 temp once locals coalesce:
  // count the dispatches, one a read of `t`, `x`-or-`r`, `w`… each)
  const dispatches = (geoWat.match(/call \$__dyn_get/g) || []).length
  ok(dispatches <= 3, `the duplicated read reuses the first one's dispatch (${dispatches} dispatches)`)
  is((geoWat.match(/0x7ffa4400000000/g) || []).length <= 3, true,
    'one dispatch per distinct prop key (t, x-or-r…), not per occurrence')
  const geoJs = (o) => { const s = o.t; return s === 0 ? o.x * 2 + o.y : s === 1 ? o.r * (o.r + 3) : o.w * o.h }
  const rows = []
  for (let i = 0; i < 9; i++) {
    const k = i % 3
    rows.push(k === 0 ? { t: k, x: i + 1, y: i + 2 } : k === 1 ? { t: k, r: i + 1, x: i + 2 } : { t: k, w: i + 1, h: i + 2 })
  }
  let ref = 0
  for (let i = 0; i < rows.length; i++) ref += geoJs(rows[i])
  const { f } = run(src, { optimize: 'speed' })
  is(f(), ref, 'memoized read bit-matches the generic path')
  const size = compile(src, { wat: true, optimize: { level: 'size', watr: false, sourceInline: false } })
  const at = size.indexOf('(func $geo'), geoSize = size.slice(at, size.indexOf('(func', at + 1))
  ok(/\$__dsrm\d+/.test(geoSize), 'size mode retains duplicate-read reuse')
  ok(!/\$__dsr[os]\d+/.test(geoSize), 'size mode adds no schema dispatch arms or receiver cache')
  is(run(src, { optimize: 'size' }).f(), ref, 'shared size-mode lookup agrees with the specialized speed mode')
})

test('devirtSchemaReads: empty and populated branch memos preserve reads and writes', () => {
  const read = '(call $__dyn_get_test (local.get $recv))'
  const bodies = [
    `(if (local.get $flag) (then (drop ${read}))) (i64.add ${read} ${read})`,
    `(local.set $sum ${read}) (if (local.get $flag) (then (i64.store (i32.const 0) (i64.const 17)))) (i64.add (local.get $sum) ${read})`,
    `(block $exit (br_if $exit (local.get $flag)) (local.set $sum (i64.add ${read} ${read}))) (i64.add (local.get $sum) ${read})`,
    `(local.set $sum ${read}) (block $exit (loop $loop
      (br_if $exit (i32.eqz (local.get $n)))
      (local.set $sum (i64.add (local.get $sum) (i64.add ${read} ${read})))
      (i64.store (i32.const 0) (i64.add ${read} (i64.const 1)))
      (local.set $n (i32.sub (local.get $n) (i32.const 1))) (br $loop)))
      (i64.add (local.get $sum) ${read})`,
  ]
  for (const body of bodies) {
    compile('', { optimize: 'size' })
    ctx.schema.list.push(['x'])
    ctx.core.includes.add('__ptr_type')
    const ast = parseWat(`(module (memory (export "memory") 1)
      (func $__dyn_get_test (param i64) (result i64) (i64.load (i32.const 0)))
      (func $f (export "f") (param $recv i64) (param $flag i32) (param $n i32)
        (result i64) (local $sum i64) ${body}))`)
    const bytes = encodeWat(ast)
    const original = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports
    const fn = findFunc(ast, '$f')
    devirtSchemaReads(fn, passFacts(ctx.transform.optimize), ctx.transform.optimize)
    is(encodeWat(ast), bytes, 'an untagged function stays byte-identical')
    walk(fn, n => { if (n[0] === 'call' && n[1] === '$__dyn_get_test') n.dvProp = 'x' })
    devirtSchemaReads(fn, passFacts(ctx.transform.optimize), ctx.transform.optimize)
    const optimized = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ast))).exports
    for (const flag of [0, 1, 1, 0]) for (const n of [0, 1, 3]) {
      for (const ex of [original, optimized]) new DataView(ex.memory.buffer).setBigInt64(0, 11n, true)
      is(optimized.f(0n, flag, n), original.f(0n, flag, n), `flag ${flag}, count ${n}: ${body}`)
    }
  }
})

test('devirtSchemaReads: a receiver local the function writes keeps its reads to one value of it', () => {
  // The memo follows a written receiver local to its next write: a rebinding,
  // one in a branch, one a loop makes each end the reads of the value before.
  const read = '(call $__dyn_get_test (local.get $o))'
  const bodies = [
    `(local.set $o (local.get $recv)) (i64.add ${read} ${read})`,
    `(local.set $o (local.get $recv)) (local.set $sum ${read}) (local.set $o (i64.add (local.get $recv) (i64.const 8))) (i64.add (local.get $sum) ${read})`,
    `(local.set $o (local.get $recv)) (local.set $sum ${read}) (if (local.get $flag) (then (local.set $o (i64.const 8)))) (i64.add (local.get $sum) ${read})`,
    `(local.set $o (local.get $recv)) (local.set $sum ${read}) (block $exit (loop $loop
      (br_if $exit (i32.eqz (local.get $n)))
      (local.set $sum (i64.add (local.get $sum) (i64.add ${read} ${read})))
      (local.set $o (i64.add (local.get $o) (i64.const 8)))
      (local.set $n (i32.sub (local.get $n) (i32.const 1))) (br $loop)))
      (i64.add (local.get $sum) ${read})`,
  ]
  for (const body of bodies) {
    compile('', { optimize: 'size' })
    ctx.schema.list.push(['x'])
    ctx.core.includes.add('__ptr_type')
    const ast = parseWat(`(module (memory (export "memory") 1)
      (func $__dyn_get_test (param i64) (result i64) (i64.load (i32.wrap_i64 (local.get 0))))
      (func $f (export "f") (param $recv i64) (param $flag i32) (param $n i32)
        (result i64) (local $sum i64) (local $o i64) ${body}))`)
    const original = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ast))).exports
    const fn = findFunc(ast, '$f')
    walk(fn, n => { if (n[0] === 'call' && n[1] === '$__dyn_get_test') n.dvProp = 'x' })
    devirtSchemaReads(fn, passFacts(ctx.transform.optimize), ctx.transform.optimize)
    if (body === bodies[0]) ok(JSON.stringify(fn).includes('$__dsrm'), 'two reads of one value share a memo')
    const optimized = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ast))).exports
    for (const flag of [0, 1]) for (const n of [0, 1, 3]) {
      for (const ex of [original, optimized]) { const v = new DataView(ex.memory.buffer); for (let i = 0; i < 6; i++) v.setBigInt64(i * 8, BigInt(11 + i * 7), true) }
      is(optimized.f(0n, flag, n), original.f(0n, flag, n), `flag ${flag}, count ${n}: ${body}`)
    }
  }
})

test('devirtSchemaReads: a field read straight off an element is dispatched as one held in a local is', () => {
  // The receiver of `ps[i].x` is the element's load, past the forwarding word of its array's
  // base. It reads and never writes, so the dispatch may run it once, where it stood. Under
  // `i < ps.length` the element is present with no test, and the read was a hash probe an
  // element where the same read through a local was a jump table.
  const records = `const ps = []\nfor (let i = 0; i < 64; i++) { const p = i & 1 ? { x: i, y: i + 1 } : { y: i + 1, x: i }; ps.push(p) }`
  const forms = {
    'under a count': `let s = 0; for (let i = 0; i < 64; i++) s += ps[i].x; return s`,
    'held in a local': `let s = 0; for (let i = 0; i < 64; i++) { const p = ps[i]; s += p.x } return s`,
    'under the length': `let s = 0; for (let i = 0; i < ps.length; i++) s += ps[i].x; return s`,
    'beside a store to the element': `let s = 0; for (let i = 0; i < ps.length; i++) { ps[i].y = s; s += ps[i].x + ps[i].y } return s`,
    'off an element of an element': `const rows = [ps, ps]; let s = 0; for (let i = 0; i < ps.length; i++) s += rows[i & 1][i].x; return s`,
  }
  for (const [name, body] of Object.entries(forms)) {
    const src = `${records}\nexport const f = () => { ${body} }`
    for (const optimize of levels(2, 'speed')) ok(/br_table/.test(compile(src, { wat: true, optimize })), `${name}: a jump table at ${optimize}`)
    for (const optimize of levels(0, 2, 3, 'speed', 'size')) is(run(src, { optimize }).f(), oracle(src).f(), `${name} at ${optimize}`)
  }
})

test('devirtSchemaReads: a receiver may read memory; no operand may write', () => {
  // An object of the test's schema at 16, its field 7; its box in memory at 64.
  const cases = [
    // [what, the call, whether the dispatch takes it]
    ['a receiver loaded from memory', `(call $__dyn_get_test2 (i64.load (i32.const 64)) (i64.const 1))`, true],
    ['a receiver loaded past a forwarding word', `(call $__dyn_get_test2 (i64.load (if (result i32) (i32.eq (i32.load (i32.const 4)) (i32.const -1)) (then (call $__ptr_offset_fwd (i32.const 64))) (else (i32.const 64)))) (i64.const 1))`, true],
    ['a receiver a tee holds', `(call $__dyn_get_test2 (local.tee $sum (i64.load (i32.const 64))) (i64.const 1))`, true],
    ['a key that writes', `(call $__dyn_get_test2 (i64.load (i32.const 64)) (block (result i64) (i64.store (i32.const 0) (i64.const 99)) (i64.const 1)))`, false],
    ['a receiver that calls the program', `(call $__dyn_get_test2 (call $bump) (i64.const 1))`, false],
  ]
  for (const [name, call, taken] of cases) {
    compile('', { optimize: 2 })
    const box = BigInt(objectSchemaGuardHex(ctx.schema.register(['x']))) | 16n
    ctx.core.includes.add('__ptr_type')
    const ast = parseWat(`(module (memory (export "memory") 1)
      (func $__ptr_offset_fwd (param i32) (result i32) (local.get 0))
      (func $bump (result i64) (i64.store (i32.const 0) (i64.add (i64.load (i32.const 0)) (i64.const 1))) (i64.load (i32.const 64)))
      (func $__dyn_get_test2 (param i64 i64) (result i64) (i64.add (i64.load (i32.const 0)) (i64.const 1000)))
      (func $f (export "f") (result i64) (local $sum i64) (i64.add ${call} (i64.load (i32.const 0)))))`)
    const bytes = encodeWat(ast), fn = findFunc(ast, '$f')
    walk(fn, n => { if (n[0] === 'call' && n[1] === '$__dyn_get_test2') n.dvProp = 'x' })
    devirtSchemaReads(fn, passFacts(ctx.transform.optimize), ctx.transform.optimize)
    is(JSON.stringify(fn).includes('br_table'), taken, `${name}: ${taken ? 'dispatched' : 'left a call'}`)
    const original = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports
    const optimized = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ast))).exports
    // (the box at 64 is an object of the schema, then a number: the arm, then the call)
    for (const held of [box, 5n]) {
      for (const ex of [original, optimized]) { const v = new DataView(ex.memory.buffer); v.setBigInt64(0, 3n, true); v.setBigInt64(16, 7n, true); v.setBigInt64(64, held, true) }
      const want = original.f(), got = optimized.f()
      if (taken) is(got, held === box ? 7n + 3n : want, `${name}: ${held === box ? 'the slot' : 'the call'}`)
      else is(got, want, `${name}: as written`)
      is(new DataView(optimized.memory.buffer).getBigInt64(0, true), new DataView(original.memory.buffer).getBigInt64(0, true), `${name}: memory as written`)
    }
  }
})

test('devirtConstFnArrayCalls: const-arrow-table indexed call switches to direct calls', () => {
  // The dispatch-bench shape: a module-const array of capture-free operators,
  // one data-indexed call site.
  const src = `const ops = [
    (x, k) => (x + k) | 0,
    (x, k) => x ^ k,
    (x, k) => (k - x) | 0,
  ]
  export let f = (sel, x, k) => ops[sel & 3](x, k)`
  const w = compile(src, { wat: true, optimize: { level: 'speed', watr: false } })
  ok(/br_table/.test(w), 'indexed const-fn-array call dispatches via br_table')
  ok(/__throw_not_callable/.test(w), 'the default arm answers an index the table does not hold')
  const { f } = run(src, { optimize: 'speed' })
  is(f(0, 5, 3), 8); is(f(1, 5, 3), 6); is(f(2, 5, 3), -2)
})

test('size: function tables retain one indirect path without speculative arm copies', () => {
  if (onKernel()) return
  const src = `const ops=[(x,k)=>(x+k)|0,(x,k)=>x^k,(x,k)=>(k-x)|0];
    export function f(sel,x,k){return ops[sel](x,k)}`
  const compact = { optimize: 'size' }, expanded = { optimize: { level: 'size', devirtFnArrays: true } }
  ok(compile(src, compact).length < compile(src, expanded).length, 'retaining both paths costs bytes')
  ok(!compile(src, { ...compact, wat: true }).includes('br_table'), 'size omits speculative dispatch')
  ok(compile(src, { optimize: 'speed', wat: true }).includes('br_table'), 'speed retains direct arms')
  for (const options of [compact, expanded]) {
    const { f } = run(src, options)
    for (const sel of [0,0,1,2,0]) is(f(sel,5,3), [8,6,-2][sel])
    for (const sel of [-1,3]) throws(() => f(sel,5,3), TypeError, 'missing element still throws')
    is(f(0,5,3), 8, 'valid call after errors')
  }
})

test('escape analysis: local object property reads scalarize literal', () => {
  const src = `
    export const main = (x) => {
      const obj = { a: x, b: x + 1 }
      return obj.a + obj["b"]
    }
  `
  const wat = compile(src, { wat: true })
  ok(!/\(call \$__alloc_hdr\b/.test(wat), 'non-escaping object literal should not allocate')
  is(run(src).main(4), 9)
})

test('escape analysis: monotonically-extended object scalarizes', () => {
  // Real code extends static objects (`o.newProp = …`); SRoA must follow the
  // monotonic extension into flat field locals rather than bail to the heap.
  const src = `
    export const main = (x) => {
      const o = { a: x }
      o.b = x + 1
      o.c = o.a + o.b
      return o.c
    }
  `
  const wat = compile(src, { wat: true })
  ok(!/\(call \$__alloc_hdr\b/.test(wat), 'extended non-escaping object should not allocate')
  is(run(src).main(4), 9)
})

test('escape analysis: extension field read before write yields undefined', () => {
  // `o.b` init to undefined at the decl — a read that runs before the write
  // matches JS, and the conditional write still scalarizes.
  const src = `
    export const main = (cond) => {
      const o = { a: 10 }
      const before = o.b
      if (cond) o.b = 5
      return o.b
    }
  `
  const wat = compile(src, { wat: true })
  ok(!/\(call \$__alloc_hdr\b/.test(wat), 'conditionally-extended object should not allocate')
  is(run(src).main(1), 5)
  is(run(src).main(0), undefined)  // unwritten extension field reads undefined
})

test('escape analysis: bracket-key extension scalarizes', () => {
  const src = `
    export const main = (x) => {
      const o = { x: x }
      o['y'] = 7
      return o.x + o['y']
    }
  `
  const wat = compile(src, { wat: true })
  ok(!/\(call \$__alloc_hdr\b/.test(wat), 'bracket-key-extended object should not allocate')
  is(run(src).main(1), 8)
})

test('escape analysis: extended object that escapes still heap allocates', () => {
  // Inspect jz output without watr — `inlineOnce`+`treeshake` may erase the
  // `__alloc_hdr` import once the allocating helper has been fused inline.
  const wat = compile(`
    export const main = (x) => {
      const obj = { a: x }
      obj.b = x + 1
      return obj
    }
  `, { wat: true, optimize: { watr: false } })
  ok(/\(call \$__alloc_hdr\b/.test(wat), 'escaping extended object must stay materialized')
})

test('escape analysis: returned object still heap allocates', () => {
  const wat = compile(`
    export const main = (x) => {
      const obj = { a: x }
      return obj
    }
  `, { wat: true, optimize: { watr: false } })
  ok(/\(call \$__alloc_hdr\b/.test(wat), 'returned object must remain materialized')
})

test('escape analysis: call-passed object still heap allocates', () => {
  // sourceInline off: the fixture pins escape analysis at a REAL call
  // boundary — the leaf inliner would otherwise splice get's body, the call
  // disappears, and scalarizing obj becomes correct (no escape). The callee
  // uses the object whole: one that only read fields would take them as lanes
  // (plan/lanes.js) and the object would rightly dissolve.
  const wat = compile(`
    const get = (obj) => obj
    export const main = (x) => {
      const obj = { a: x }
      return get(obj).a
    }
  `, { wat: true, optimize: { watr: false, sourceInline: false } })
  ok(/\(call \$__alloc_hdr\b/.test(wat), 'call-passed object must remain materialized')
})

test('dynamic prop reads reuse receiver type tag', () => {
  if (onWasi()) return  // wasi: external object WAT name differs
  if (belowOpt(2)) return  // receiver-tag CSE/hoisting runs at optimize >= 2
  const wat = compile(`
    export const main = (o) => {
      return o.a + o.b + o.c
    }
  `, { wat: true })
  ok(/\(call \$__dyn_get_any_t_h\b/.test(wat))
  const reads = []
  walk(parseWat(wat), n => { if (n[0] === 'call' && n[1] === '$__dyn_get_any_t_h') reads.push(n) })
  is(reads.length, 3, 'three property reads')
  is(reads[0][4][0], 'local.tee', 'the first read saves the receiver tag')
  const tag = reads[0][4][1]
  ok(reads.slice(1).every(n => n[4][0] === 'local.get' && n[4][1] === tag), 'later reads reuse that tag, including after inlining')
})

test('monomorphic schema-slot devirtualization: singleton-schema dot-read compiles to aux-guard + load, no call', () => {
  if (onWasi()) return  // wasi: external object WAT name differs in the fallback arm
  const wat = compile(`
    const mk = () => ({ a: 1, b: 2, c: 3 })
    export const build = () => mk()
    export const getA = (o) => o.a
  `, { wat: true, optimize: 0 })
  // Guard: one masked i64 compare against the packed (NAN_PREFIX|tag|schemaId)
  // high word — proves "is an OBJECT" AND "is exactly this schema" at once.
  ok(/0xFFFFFFFF00000000/.test(wat), 'expected the tag+aux guard mask constant')
  // The arm the guard enters: the slot's load (a Number field drops a NaN
  // payload on the way out, module/schema.js schemaValueIR), and no call.
  const getA = wat.indexOf('(func $getA'), at = getA < 0 ? -1 : wat.indexOf('(then', wat.indexOf('0xFFFFFFFF00000000', getA))
  let end = at, depth = 0
  do { depth += wat[end] === '(' ? 1 : wat[end] === ')' ? -1 : 0; end++ } while (depth > 0 && end < wat.length)
  const thenArm = at < 0 ? '' : wat.slice(at, end)
  ok(/^\(then\s*(?:\(block\s*\(result f64\)\s*\(local\.set \$\S+\s*)?\(f64\.load\b/.test(thenArm), 'expected a direct f64.load in the guarded (then) arm')
  ok(thenArm && !/call/.test(thenArm), 'the guarded fast path must not call any helper')
  // The generic dispatch remains reachable as the polymorphic fallback, never removed.
  ok(/\(call \$__dyn_get_any_t_h\b/.test(wat), 'generic dyn dispatch remains as the polymorphic fallback')
})

test('polymorphic object prop reads use typed object dispatch', () => {
  const src = `
    const left = () => ({ x: 11, y: 100 })
    const right = () => ({ y: 200, x: 22 })
    export const hx = (w) => { const o = w == 0 ? left() : right(); return o.x }
    export const hy = (w) => { const o = w == 0 ? left() : right(); return o.y }
  `
  const wat = compile(src, { wat: true })
  ok(/\(i32\.const 3\)[\s\S]*?\(call \$__dyn_get_expr_t/.test(wat), 'expected OBJECT-typed dynamic slot dispatch')
  const { hx, hy } = run(src)
  is(hx(0), 11)
  is(hx(1), 22)
  is(hy(0), 100)
  is(hy(1), 200)
})

// Workstream #5: closure-capture rep narrowing

test('captureIntCertain: intCertain propagates across capture (Math.floor elides)', () => {
  // Parent has `let i = n | 0` — every defining RHS is integer (bitwise-or).
  const src = `
    export const make = (n) => {
      let i = n | 0
      const inner = () => Math.floor(i)
      return inner
    }
    export const main = (n) => make(n)()
  `
  const wat = compile(src, { wat: true, optimize: { watr: false } })
  // Find the closure body (JZ uses U+E000 as identifier prefix).
  const closRe = /\(func \$\u{e000}closure[0-9]+[\s\S]*?\n  \)/u
  const body = wat.match(closRe)?.[0] || ''
  ok(body, 'closure body emitted')
  ok(!body.includes('f64.floor'), 'Math.floor elided on intCertain capture')
  is(run(src).main(3.7), 3)
})

test('captureIntCertain: intCertain skips __to_num in arithmetic on captures', () => {
  // We use string concat (forces __to_num path) to make the difference visible.
  const src = `
    export const make = (n) => {
      let i = n | 0
      const tag = () => 'x' + i
      return tag
    }
    export const main = (n) => make(n)()
  `
  const wat = compile(src, { wat: true, optimize: { watr: false } })
  const closRe = /\(func \$\u{e000}closure[0-9]+[\s\S]*?\n  \)/u
  const body = wat.match(closRe)?.[0] || ''
  ok(body, 'closure body emitted')
  // With intCertain on `i`, the inner body should not insert __to_num for `i`.
  // (concat itself may call other helpers, but the operand `i` flows straight to f64.)
  ok(!body.includes('$__to_num'), 'no __to_num wrap on intCertain capture in concat')
  is(run(src).main(7.9), 'x7')
})

test('captureIntCertain: float capture does NOT enable elision', () => {
  // Counterpoint to the floor test: `i = n + 0.5` is not integer-certain, so
  // the closure must keep `f64.floor`.
  const src = `
    export const make = (n) => {
      let i = n + 0.5
      const inner = () => Math.floor(i)
      return inner
    }
    export const main = (n) => make(n)()
  `
  const wat = compile(src, { wat: true, optimize: { watr: false } })
  const closRe = /\(func \$\u{e000}closure[0-9]+[\s\S]*?\n  \)/u
  const body = wat.match(closRe)?.[0] || ''
  ok(body, 'closure body emitted')
  ok(body.includes('f64.floor'), 'float capture keeps f64.floor')
  is(run(src).main(3), 3)
})

// Workstream #3c: schema field intCertain

test('schema slot integer certainty: Math.floor elides on intCertain slot', () => {
  // `{ x: n | 0, y: (n * 2) | 0 }` — every observed write to slot x and y is
  // integer-shaped (bitwise op result). Math.floor(p.x) / Math.floor(p.y)
  // should drop the f64.floor op.
  const src = `
    export const main = (n) => {
      const p = { x: n | 0, y: (n * 2) | 0 }
      return Math.floor(p.x) + Math.floor(p.y)
    }
  `
  const wat = compile(src, { wat: true, optimize: { watr: false } })
  const body = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] || ''
  ok(body, 'main body emitted')
  ok(!body.includes('f64.floor'), 'Math.floor elided on intCertain slot reads')
  is(run(src).main(3.7), 10) // floor(3) + floor(7) = 10
})

test('schema slot integer certainty: float slot keeps f64.floor', () => {
  // Counterpoint: slot is written with a non-int value → not intCertain.
  const src = `
    export const main = (n) => {
      const p = { x: n + 0.5 }
      return Math.floor(p.x)
    }
  `
  const wat = compile(src, { wat: true, optimize: { watr: false } })
  const body = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] || ''
  ok(body, 'main body emitted')
  ok(body.includes('f64.floor'), 'non-int slot retains f64.floor')
  is(run(src).main(3.0), 3)
})

test('schema slot integer certainty: later non-int assign poisons slot', () => {
  // `p.x = n | 0` then `p.x = 1.5` — the second write makes the slot
  // polymorphic. `p.x` could be 1.5 at the read site, so Math.floor must
  // stay. Global poison: even though the literal seed was int, one non-int
  // write anywhere in the program flips the slot false.
  const src = `
    export const make = (n) => {
      const p = { x: n | 0 }
      p.x = 1.5
      return p
    }
    export const main = (n) => Math.floor(make(n).x)
  `
  const wat = compile(src, { wat: true, optimize: { watr: false } })
  const body = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] || ''
  ok(body, 'main body emitted')
  // Verify Math.floor is emitted *somewhere* in the produced module — could be
  // inlined into main or `make` depending on the inliner's decisions.
  ok(wat.includes('f64.floor'), 'poisoned slot retains f64.floor')
  is(run(src).main(7), 1)
})

test('schema slot integer certainty: int slot via local intCertain binding', () => {
  // Slot fed by a local `k` that the per-body intCertain fixpoint marks as
  // integer-shaped (`let k = n | 0`).
  const src = `
    export const main = (n) => {
      const k = n | 0
      const p = { v: k }
      return Math.floor(p.v)
    }
  `
  const wat = compile(src, { wat: true, optimize: { watr: false } })
  // Math.floor must be elided anywhere it would have been emitted for p.v.
  ok(!wat.includes('f64.floor'), 'Math.floor elided via local→slot intCertain transit')
  is(run(src).main(5.9), 5)
})

test('devirtSchemaReads: an empty inline cache cannot match zero or subnormal numbers', () => {
  const shapes = Array.from({ length: 30 }, (_, i) => `{k${i}:0,x:${i}}`)
  const src = `function mk(i) { switch(i%30) { ${shapes.map((s,i) => `case ${i}: return ${s};`).join('')} } return {x:-1,z:0} }
    export function zero(n) { const o = n ? mk(n) : 0; return o.x }
    export function tiny(n) { const o = n ? mk(n) : 5e-324; return o.x }`
  for (const level of levels(1, 2, 3, 'size')) for (const snapshotInit of [false, true]) {
    const r = jz(src, { optimize: { level, snapshotInit, sourceInline: false } })
    for (const fn of [r.exports.zero, r.exports.tiny]) {
      is(fn(0), undefined, 'the first primitive read misses an empty cache')
      is(fn(0), undefined, 'a failed read does not fill the cache')
      is(fn(4), 4, 'a real object fills the cache')
      is(fn(0), undefined, 'a primitive still misses a populated cache')
      is(fn(7), 7, 'a different schema refills it')
    }
    r.instance.exports.__jz_clear()
    is(r.exports.zero(0), undefined, 'reset preserves the receiver guard')
    is(r.exports.tiny(4), 4)
  }
})

test('devirtSchemaReads: past the dispatch budget a read site keeps an inline cache', () => {
  // 30 shapes carry `x` at three different slots: too many for a jump table,
  // so the site caches the last static schema it resolved (high word, slot)
  // and reads the next receiver of that schema behind one compare.
  const shapes = Array.from({ length: 30 }, (_, i) => i % 3 === 0 ? `{ x: ${i}, k${i}: ${i} }` : i % 3 === 1 ? `{ k${i}: ${i}, x: ${i} }` : `{ a${i}: 1, b${i}: 2, x: ${i} }`)
  const src = `const mk = (i) => { switch (i % 30) { ${shapes.map((s, i) => `case ${i}: return ${s}`).join('\n')} } return { x: -1, z: 0 } }
    export const f = (n) => { let t = 0; for (let i = 0; i < n; i++) { const o = mk(i); t += o.x } return t }
    export const g = (n) => { let t = 0; for (let i = 0; i < n; i++) { const o = i % 2 ? mk(3) : mk(7); t += o.x } return t }
    export const h = (n) => { let t = 0; for (let i = 0; i < n; i++) { const o = i % 5 ? mk(4) : 12; t += o.x === undefined ? 100 : o.x } return t }`
  const w = compile(src, { wat: true, optimize: { level: 1, watr: false } })
  ok((w.match(/global\.get \$__ic_hi\d+/g) || []).length >= 3, 'each over-budget read site owns an inline cache')
  ok(!w.slice(w.indexOf('(func $f')).includes('br_table'), 'no jump table past the budget')
  const { f, g, h } = run(src, { optimize: { level: 1, snapshotInit: true } })
  const js = (n) => { let t = 0; for (let i = 0; i < n; i++) t += i % 30; return t }
  is(f(1000), js(1000), 'polymorphic receivers match the generic read')
  is(g(1001), Array.from({ length: 1001 }, (_, i) => i % 2 ? 3 : 7).reduce((a, b) => a + b, 0), 'alternating schemas refill the cache')
  is(h(1000), Array.from({ length: 1000 }, (_, i) => i % 5 ? 4 : 100).reduce((a, b) => a + b, 0), 'a Number receiver reads undefined through the generic path')
})

test('a record of several shapes held by a local is read as the pointer, boxed only where a box is read', () => {
  // shapes' scan: `measure(rows[i])` inlined into the kernel, its parameter holding one
  // of four record shapes.
  const src = `const N = 256
    const initRows = () => {
      const rows = []
      let s = 0x1234abcd | 0
      for (let i = 0; i < N; i++) {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5
        const k = s & 3, a = (s >>> 3) & 1023, b = (s >>> 13) & 1023
        if (k === 0) rows.push({ k: k, x: a, y: b })
        else if (k === 1) rows.push({ k: k, r: a })
        else if (k === 2) rows.push({ k: k, w: a, h: b })
        else rows.push({ k: k, a: a, b: b, c: k })
      }
      return rows
    }
    const measure = (o) => {
      const k = o.k
      if (k === 0) return (o.x + o.y) | 0
      else if (k === 1) return Math.imul(o.r, 3)
      else if (k === 2) return Math.imul(o.w, o.h)
      return (o.a + o.b + o.c) | 0
    }
    const runKernel = (rows, iters) => {
      let h = 0
      for (let it = 0; it < iters; it++) {
        let sum = it | 0
        for (let i = 0; i < rows.length; i++) sum = (sum + measure(rows[i])) | 0
        h = Math.imul(h ^ sum, 16777619)
      }
      return h
    }
    export let main = (iters) => {
      const rows = initRows()
      let cs = 0
      for (let i = 0; i < 2; i++) cs = runKernel(rows, iters)
      for (let i = 0; i < 3; i++) cs = (cs + runKernel(rows, iters)) | 0
      return cs
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) for (const n of [1, 3, 10]) is(run(src, { optimize }).main(n), js.main(n), `${n} at ${optimize}`)
  if (onKernel() || belowOpt(2)) return
  const w = compile(src, { wat: true, optimize: 'speed' })
  const kernel = funcWat(w, 'runKernel')
  ok(kernel, 'the kernel is a function of its own')
  // (the innermost loops read the fields; a loop around a version reads the list's length through its box once a round)
  const leaves = [], inner = (n) => Array.isArray(n) && (n[0] === 'loop' || n.some(inner))
  walk(parseWat(kernel), n => { if (n[0] === 'loop' && !n.some(inner)) leaves.push(n) })
  ok(leaves.length >= 1, 'the kernel has a scan loop')
  is(leaves.reduce((k, n) => k + count(n, m => m[0] === 'i64.reinterpret_f64' || m[0] === 'f64.reinterpret_i64'), 0), 0, 'no box or unbox in the scan loops')
})
