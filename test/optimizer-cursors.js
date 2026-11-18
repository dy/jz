// Loops that step a pointer or a cursor: exits by the pointer, the address of a
// record a jumping variable reaches, and a ring's cursor run a lap at a time.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { onKernel, ownedLevels } from './_matrix.js'
import parseWat from 'watr/parse'
import encodeWat from 'watr/compile'
import { pointerExits } from '../src/optimize/pointer-exits.js'
import { jumpPointers } from '../src/optimize/jump-pointers.js'
import { ringLaps } from '../src/optimize/ring-laps.js'
import { run, oracle, compile } from './util.js'
import { count } from '../scripts/wat-probe.mjs'

test('pointerExits: a loop keeping a counter only to stop stops by the pointer stepped beside it', () => {
  const g = (n) => ['local.get', n], k = (v) => ['i32.const', v]
  const step = (x, c) => ['local.set', x, ['i32.add', g(x), k(c)]]
  const tee = (x, c) => ['local.tee', x, ['i32.add', g(x), k(c)]]
  const add = ['local.set', '$s', ['i32.add', g('$s'), ['i32.load', 'offset=4', g('$p')]]]
  const fn = (...body) => ['func', '$f', ['param', '$b', 'i32'], ['result', 'i32'], ['local', '$i', 'i32'], ['local', '$p', 'i32'], ['local', '$s', 'i32'], ...body, g('$s')]
  const one = (f) => pointerExits(['module', f])[1]
  // a top-tested loop: the counter's start goes, its declaration holds the end
  const top = (N, cmp = 'i32.ge_s', S = 1, D = 20, I0 = 0) => fn(['local.set', '$i', k(I0)],
    ['block', '$B', ['local.set', '$p', g('$b')],
      ['loop', '$L', ['br_if', '$B', [cmp, g('$i'), k(N)]], add, step('$i', S), step('$p', D), ['br', '$L']]])
  is(one(top(1024)), ['func', '$f', ['param', '$b', 'i32'], ['result', 'i32'], ['local', '$__pe0', 'i32'], ['local', '$p', 'i32'], ['local', '$s', 'i32'],
    ['block', '$B', ['local.set', '$p', g('$b')], ['local.set', '$__pe0', ['i32.add', g('$p'), k(20480)]],
      ['loop', '$L', ['br_if', '$B', ['i32.eq', g('$p'), g('$__pe0')]], add, step('$p', 20), ['br', '$L']]], g('$s')],
    'the test asks for the end pointer, the step and the start go')
  // a rotated loop unrolled twice: a guard reading the start, a test in the middle and at the back edge
  const rot = (N) => fn(['block', '$B', ['br_if', '$B', ['i32.ge_s', ['local.tee', '$i', k(0)], k(N)]], ['local.set', '$p', g('$b')],
    ['loop', '$L', add, step('$p', 20), ['br_if', '$B', ['i32.eqz', ['i32.lt_s', tee('$i', 1), k(N)]]],
      add, step('$p', 20), ['br_if', '$L', ['i32.lt_s', tee('$i', 1), k(N)]]]])
  is(one(rot(64))[7], ['block', '$B', ['local.set', '$p', g('$b')], ['local.set', '$__pe0', ['i32.add', g('$p'), k(1280)]],
    ['loop', '$L', add, step('$p', 20), ['br_if', '$B', ['i32.eq', g('$p'), g('$__pe0')]],
      add, step('$p', 20), ['br_if', '$L', ['i32.ne', g('$p'), g('$__pe0')]]]], 'both tests ask for the end; the guard that never branches goes')
  const kept = (f, why) => is(one(f), JSON.parse(JSON.stringify(f)), why)
  const loopOf = (f) => f[f.length - 2][2]
  const withBody = (f, edit) => { const c = JSON.parse(JSON.stringify(f)); edit(loopOf(c)); return c }
  kept(withBody(top(64), L => L.splice(3, 0, ['local.set', '$s', g('$i')])), 'a counter the body reads stays')
  kept(withBody(top(64), L => L.splice(3, 0, ['if', g('$s'), ['then', ['br', '$L']]])), 'a continue past the steps keeps the counter')
  kept(withBody(top(64), L => { L[2] = ['br_if', '$B', ['i32.ge_s', g('$i'), g('$b')]] }), 'a bound the constants do not decide keeps the counter')
  kept(withBody(top(64), L => L.splice(4, 1)), 'a counter without a pointer stepped beside it stays')
  kept(withBody(top(64), L => { L[5] = ['if', g('$s'), ['then', step('$p', 20)]] }), 'a pointer stepped conditionally keeps the counter')
  kept(top(-5, 'i32.ge_u', 1, 20, 2147483000), 'a counter that would wrap before it leaves stays')
  kept(top(65536, 'i32.ge_s', 1, 65536), 'an end past 2^32 bytes of pointer steps keeps the counter')
  kept(top(9, 'i32.eq', 2), 'a counter that never meets its constant stays')

  // the rewritten loops run as the originals: counting up, down, by three, unsigned, to a meeting, odd trips
  const exec = (f, base) => {
    const m = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(['module', ['memory', '$m', ['export', '"m"'], 2], [...f.slice(0, 2), ['export', '"f"'], ...f.slice(2)]])))
    const mem = new Int32Array(m.exports.m.buffer)
    for (let i = 0; i < mem.length; i++) mem[i] = Math.imul(i, 2654435761) >>> 9
    try { return m.exports.f(base) } catch (e) { return String(e) }   // a pointer stepped out of memory traps alike
  }
  const shapes = [top(1024), top(1, 'i32.ge_s'), top(0, 'i32.ge_s'), top(-3, 'i32.lt_s', -1, -20, 40), top(100, 'i32.ge_u', 3),
    top(99, 'i32.eq', 3), top(31, 'i32.gt_s', 1, 12, 5), top(7, 'i32.ge_s', 1, -8, 0), rot(64), rot(63), rot(1)]
  for (const f of shapes) {
    const before = JSON.stringify(f), after = one(JSON.parse(before))
    ok(JSON.stringify(after) !== before, `${before.slice(70, 150)}… is rewritten`)
    for (const base of [0, 4096, 60000]) is(exec(after, base), exec(JSON.parse(before), base), `same answer at ${base}: ${before.slice(70, 150)}`)
  }

  // a scan of records of four shapes, a constant count of them, read through the strength-reduced pointer
  const src = `const build = () => {
      const rows = []
      let s = 0x1234abcd | 0
      for (let i = 0; i < 512; i++) {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5
        const k = s & 3, a = (s >>> 3) & 1023, b = (s >>> 13) & 1023
        if (k === 0) rows.push({ k: k, x: a, y: b })
        else if (k === 1) rows.push({ k: k, r: a })
        else if (k === 2) rows.push({ k: k, w: a, h: b })
        else rows.push({ k: k, n: b })
      }
      return rows
    }
    const measure = (o) => {
      const k = o.k
      if (k === 0) return (o.x + o.y) | 0
      else if (k === 1) return Math.imul(o.r, 3)
      else if (k === 2) return Math.imul(o.w, o.h)
      return o.n
    }
    const scan = (rows) => {
      let h = 0
      for (let r = 0; r < 4; r++) {
        let sum = r | 0
        for (let i = 0; i < rows.length; i++) sum = (sum + measure(rows[i])) | 0
        h = Math.imul(h ^ sum, 16777619)
      }
      return h
    }
    export let f = () => scan(build())`
  const want = oracle(src).f()
  for (const optimize of ownedLevels('speed', { level: 'speed', pointerExits: false }, 2)) is(run(src, { optimize }).f(), want, JSON.stringify(optimize))
  if (onKernel()) return
  const ends = (optimize) => count(parseWat(compile(src, { wat: true, optimize })), n => n[0] === 'local' && typeof n[1] === 'string' && n[1].startsWith('$__pe'))
  ok(ends('speed') >= 1, `the record loop stops by its pointer (${ends('speed')})`)
  is(ends({ level: 'speed', pointerExits: false }), 0, 'pointerExits: false keeps the counter')
})

test('jumpPointers: a loop variable that jumps carries the address of its record beside it', () => {
  const g = (n) => ['local.get', n], k = (v) => ['i32.const', v], set = (x, v) => ['local.set', x, v]
  // records of three words at $b: [op, step, target]; the index steps by one, by two, jumps to a target, or stops
  const rec = (pc, s = 12) => ['i32.add', g('$b'), ['i32.mul', g(pc), k(s)]]
  const next = (pc = '$pc', s = 12) => ['block', '$j', ['result', 'i32'],
    ['if', ['i32.eqz', ['i32.and', g('$op'), k(3)]], ['then', ['br', '$j', g('$t')]]],
    ['if', ['i32.eq', ['i32.and', g('$op'), k(3)], k(1)], ['then', ['br', '$j', ['i32.add', g(pc), k(2)]]]],
    ['if', ['i32.eq', ['i32.and', g('$op'), k(3)], k(2)], ['then', ['br', '$j', ['i32.load', 'offset=4', rec(pc, s)]]]],
    ['i32.add', g(pc), k(1)]]
  const fn = ({ s = 12, write = (v) => set('$pc', v), head = true, extra = [] } = {}) => ['func', '$f', ['param', '$b', 'i32'], ['param', '$n', 'i32'], ['result', 'i32'],
    ['local', '$pc', 'i32'], ['local', '$op', 'i32'], ['local', '$t', 'i32'], ['local', '$s', 'i32'], ['local', '$fuel', 'i32'],
    set('$fuel', k(500)),
    ['block', '$B',
      ['loop', '$L',
        ['br_if', '$B', ['i32.ge_s', g('$pc'), g('$n')]],
        ['br_if', '$B', ['i32.eqz', ['local.tee', '$fuel', ['i32.sub', g('$fuel'), k(1)]]]],
        ...(head ? [set('$op', ['i32.load', rec('$pc', s)]), set('$t', ['i32.load', 'offset=8', rec('$pc', s)])]
          : [['if', g('$fuel'), ['then', set('$op', ['i32.load', rec('$pc', s)]), set('$t', ['i32.load', 'offset=8', rec('$pc', s)])]]]),
        set('$s', ['i32.add', ['i32.mul', g('$s'), k(31)], ['i32.xor', g('$op'), g('$pc')]]),
        ...extra,
        write(next('$pc', s)),
        ['br', '$L']]],
    ['i32.add', g('$s'), g('$pc')]]
  const one = (f) => jumpPointers(['module', f])[1]
  const has = (n, pred) => Array.isArray(n) && (pred(n) || n.some(c => has(c, pred)))
  const pointer = (f) => has(f, n => n[0] === 'local' && typeof n[1] === 'string' && n[1].startsWith('$__jp'))
  const after = one(fn())
  ok(pointer(after), 'a pointer is declared')
  ok(has(after, n => n[0] === 'i32.load' && n[1] === 'offset=8' && n[2][0] === 'local.get' && n[2][1].startsWith('$__jp')), 'the record is read through it')
  ok(has(after, n => n[0] === 'local.set' && n[1].startsWith('$__jp') && n[2][0] === 'i32.add' && n[2][1][0] === 'local.get' && n[2][2][1] === 24), 'a step by two advances it two records')
  const loopOf = (f) => f[f.length - 2][f[f.length - 2].length - 1]
  is(loopOf(after).slice(4, 6), [set('$op', ['i32.load', g('$__jp0')]), set('$t', ['i32.load', 'offset=8', g('$__jp0')])], 'the head reads the record through the pointer')
  const kept = (f, why) => is(one(f), JSON.parse(JSON.stringify(f)), why)
  kept(fn({ s: 8 }), 'a stride an x64 index scales keeps its addresses')
  kept(fn({ write: (v) => ['drop', ['local.tee', '$pc', v]] }), 'a write inside an expression keeps the loop')
  kept(fn({ extra: [set('$pc', ['i32.add', g('$pc'), k(0)])] }), 'two writes a pass keep the loop')
  kept(fn({ head: false }), 'an address formed only off the head keeps the loop')
  const jumps = fn({ write: (v) => set('$pc', ['i32.load', 'offset=4', rec('$pc')]) })
  kept(jumps, 'a variable that only jumps forms its address at each jump anyway')
  kept(fn({ write: (v) => set('$pc', ['i32.add', g('$pc'), k(1)]) }), 'a variable that only steps is left to strength reduction')
  const byDepth = fn({ extra: [['if', g('$op'), ['then', ['br', 2]]]] })
  kept(byDepth, 'a branch by depth keeps the function')

  // the rewritten loops run as the originals, over records holding targets in and out of range
  const exec = (f, fill, n) => {
    const m = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(['module', ['memory', '$m', ['export', '"m"'], 1], [...f.slice(0, 2), ['export', '"f"'], ...f.slice(2)]])))
    const mem = new Int32Array(m.exports.m.buffer)
    for (let i = 0; i < 4096; i++) mem[i] = fill(i)
    try { return m.exports.f(64, n) } catch (e) { return String(e) }
  }
  const fills = [(i) => Math.imul(i, 2654435761) >>> 29, (i) => (Math.imul(i, 40503) >>> 7) % 23 - 3, (i) => i % 5 === 2 ? -1 : i % 7, (i) => i % 3 === 2 ? 0x15555556 : i & 7]
  for (const shape of [fn(), fn({ s: 20 }), fn({ s: -12 }), fn({ extra: [set('$s', ['i32.add', g('$s'), ['i32.load', 'offset=4', rec('$pc')]])] })]) {
    const before = JSON.stringify(shape), after = one(JSON.parse(before))
    ok(JSON.stringify(after) !== before, 'rewritten')
    for (const fill of fills) for (const n of [0, 5, 16, 40]) is(exec(after, fill, n), exec(JSON.parse(before), fill, n), `same answer: ${fill} ${n}`)
  }

  // an interpreter of four-word instructions: it steps, skips one, jumps to a target it reads
  const src = `const run = (code, reg, n) => {
      let pc = 0, steps = 0
      while (pc < n) {
        const o = pc * 4
        const op = code[o], d = code[o + 1]
        steps++
        if (op === 0) { reg[d] = code[o + 3]; pc = pc + 1 }
        else if (op === 1) { reg[d] = (reg[d] + reg[code[o + 2]]) | 0; pc = pc + 1 }
        else if (op === 2) { reg[d] = Math.imul(reg[d], code[o + 3]) ^ (reg[d] >>> 7); pc = pc + 1 }
        else if (op === 3) { reg[d] = (reg[d] - 1) | 0; pc = pc + 1 }
        else if (op === 4) { if (reg[d] !== 0) pc = code[o + 3]; else pc = pc + 1 }
        else if (op === 5) { if ((reg[d] & 1) === 0) pc = pc + 2; else pc = pc + 1 }
        else pc = n
      }
      return (reg[0] ^ reg[1] ^ reg[2] ^ steps) | 0
    }
    export let f = (k) => {
      const prog = [0, 0, 0, 7, 0, 1, 0, 50, 0, 2, 0, 3, 2, 0, 0, 40503, 1, 2, 0, 0, 5, 2, 0, 0, 1, 0, 2, 0, 3, 1, 0, 0, 4, 1, 0, 3, 6, 0, 0, 0]
      const code = new Int32Array(40), reg = new Int32Array(4)
      for (let i = 0; i < 40; i++) code[i] = prog[i] | 0
      code[7] = (k & 63) + 1
      return run(code, reg, 10)
    }`
  const want = oracle(src)
  for (const optimize of ownedLevels('speed', { level: 'speed', jumpPointers: false }, 2, 0))
    for (const x of [0, 1, 13, 62, 1000]) is(run(src, { optimize }).f(x), want.f(x), `${JSON.stringify(optimize)} ${x}`)
  if (onKernel()) return
  const pointers = (optimize) => count(parseWat(compile(src, { wat: true, optimize })), n => n[0] === 'local' && typeof n[1] === 'string' && n[1].startsWith('$__jp'))
  ok(pointers('speed') >= 1, `the interpreter reads its instructions through a pointer (${pointers('speed')})`)
  is(pointers({ level: 'speed', jumpPointers: false }), 0, 'jumpPointers: false keeps the index')
})

test('ringLaps: a counted loop stepping a cursor around a ring runs a lap at a time', () => {
  const g = (n) => ['local.get', n], k = (v) => ['i32.const', v], set = (x, v) => ['local.set', x, v]
  // the remainder below the divisor, as emit/arithmetic.js belowDivisorRem writes it
  const below = (m) => ['if', ['result', 'i32'], ['i32.lt_u', ['local.tee', '$t', ['i32.add', g('$p'), k(1)]], m], ['then', g('$t')],
    ['else', ['if', ['result', 'i32'], ['i32.lt_u', ['local.tee', '$u', ['i32.sub', g('$t'), m]], m], ['then', g('$u')], ['else', ['i32.rem_s', g('$t'), m]]]]]
  const rem = (op, m) => [op, ['i32.add', g('$p'), k(1)], m]
  const mask = (v) => ['i32.and', ['i32.add', k(1), g('$p')], k(v)]
  // S1 reads the cursor, S2 the counter; the wrap's work, where there is one, ends the body
  const fn = (ring, { s1 = [], s2 = [], wrap = [set('$s', ['i32.add', g('$s'), k(1000)])], after = [], pre = true } = {}) =>
    ['func', '$f', ['param', '$n', 'i32'], ['param', '$m', 'i32'], ['param', '$p0', 'i32'], ['result', 'i32'],
      ['local', '$i', 'i32'], ['local', '$p', 'i32'], ['local', '$s', 'i32'], ['local', '$t', 'i32'], ['local', '$u', 'i32'],
      set('$p', g('$p0')),
      ['block', '$B', ...(pre ? [['br_if', '$B', ['i32.ge_s', g('$i'), g('$n')]]] : []),
        ['loop', '$L', ...s1, set('$s', ['i32.add', ['i32.mul', g('$s'), k(31)], g('$p')]), set('$p', ring),
          set('$s', ['i32.xor', g('$s'), g('$i')]), ...s2, ...(wrap ? [['if', ['i32.eqz', g('$p')], ['then', ...wrap]]] : []), ...after,
          ['br_if', '$L', ['i32.lt_s', ['local.tee', '$i', ['i32.add', g('$i'), k(1)]], g('$n')]]]],
      ['i32.add', ['i32.mul', g('$s'), k(7)], g('$p')]]
  const one = (f) => ringLaps(['module', f])[1]
  const exec = (f, args) => {
    const m = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(['module', [...f.slice(0, 2), ['export', '"f"'], ...f.slice(2)]])))
    try { return m.exports.f(...args) } catch (e) { return String(e) }   // a remainder by zero traps alike
  }
  const shapes = {
    'the remainder below the divisor': fn(below(g('$m'))),
    'no wrap work': fn(below(g('$m')), { wrap: null }),
    'a temporary the optimizer gave the address read too': fn(below(g('$m')), { s1: [set('$t', ['i32.mul', g('$i'), k(3)]), set('$s', ['i32.add', g('$s'), g('$t')])] }),
    'a signed remainder by a local': fn(rem('i32.rem_s', g('$m'))),
    'an unsigned remainder by a constant': fn(rem('i32.rem_u', k(7))),
    'a mask of 16 slots': fn(mask(15)),
    // the wrap's work reads the cursor (0 there, not m) and the temporaries the step wrote
    'wrap work reading the cursor and the temporaries': fn(below(g('$m')), { s1: [set('$u', ['i32.mul', g('$i'), k(5)])],
      s2: [set('$s', ['i32.add', g('$s'), g('$t')])], wrap: [set('$s', ['i32.add', ['i32.add', g('$s'), ['i32.mul', g('$p'), k(13)]], g('$u')])] }),
    // a rotated loop no test enters: one pass runs whatever the counter, the laps only where it is below its bound
    'no test before the loop': fn(below(g('$m')), { pre: false }),
  }
  const grid = []
  for (const n of [0, 1, 5, 16, 17, 33, 100]) for (const m of [1, 2, 7, 16, 0, -3]) for (const p0 of [0, 1, m - 1, m, m + 3, 6, 15, -1]) grid.push([n, m, p0])
  for (const [why, f] of Object.entries(shapes)) {
    const before = JSON.stringify(f), after = one(JSON.parse(before))
    ok(JSON.stringify(after) !== before, `${why}: rewritten`)
    const block = after.find(n => Array.isArray(n) && n[0] === 'block'), guarded = block[block.length - 1]
    const laps = JSON.stringify(guarded[2])
    ok(!/rem_|i32\.and/.test(laps) && laps.includes('$__rl'), `${why}: the laps step the cursor by one`)
    let bad = 0
    for (const args of grid) if (!Object.is(exec(after, args), exec(JSON.parse(before), args))) bad++
    is(bad, 0, `${why}: same answer over ${grid.length} counts, sizes and entries`)
  }
  const kept = (f, why) => is(one(f), JSON.parse(JSON.stringify(f)), why)
  kept(fn(below(g('$m')), { s2: [set('$s', ['i32.add', g('$s'), g('$p')])] }), 'a cursor read after its step stays')
  kept(fn(below(g('$m')), { wrap: [set('$s', ['i32.add', g('$s'), g('$i')])] }), 'wrap work reading the counter stays')
  kept(fn(below(g('$m')), { after: [set('$s', ['i32.add', g('$s'), k(1)])] }), 'wrap work that does not end the body stays')
  kept(fn(below(g('$m')), { s1: [['br_if', '$B', ['i32.eq', g('$s'), k(12345)]]] }), 'a branch out of the loop stays')
  kept(fn(below(g('$m')), { s1: [['if', g('$s'), ['then', ['br', '$L']]]] }), 'a continue stays')
  kept(fn(below(g('$m')), { s2: [['drop', ['call', '$g', g('$s')]]] }), 'a call stays')
  kept(fn(below(g('$m')), { s1: [set('$p', ['i32.xor', g('$p'), k(0)])] }), 'a cursor written beside its step stays')
  kept(fn(below(g('$m')), { s1: [set('$i', g('$i'))] }), 'a counter written in the body stays')
  kept(fn(below(g('$m')), { s2: [set('$n', g('$n'))] }), 'a bound the loop writes stays')
  kept(fn(below(g('$m')), { s2: [set('$m', g('$m'))] }), 'a ring size the loop writes stays')
  kept(fn(below(g('$m')), { s2: [set('$u', k(0))] }), 'the wrap temporary written after the step stays')
  kept(fn(mask(12)), 'a mask of no power of two stays')
  kept(fn(rem('i32.rem_s', k(0))), 'a remainder by zero stays')

  // a boxcar running sum over a window kept in a parameters record (a DSP library's idiom), its
  // sum refreshed once a lap: the same answers at every tier, laps at the speed tier
  const src = (w) => `const avg = (data, params) => {
      let ptr = params.ptr
      let mem = params.memory
      if (ptr == null) {
        if (typeof mem === 'number') mem = new Array(mem).fill(0)
        ptr = params.ptr = 0
        params.memory = mem
      }
      const m = mem.length
      let sum = params._sum
      if (sum == null) { sum = 0; for (let j = 0; j < m; j++) sum += mem[j] }
      for (let i = 0, l = data.length; i < l; i++) {
        sum += data[i] - mem[ptr]
        mem[ptr] = data[i]
        ptr = (ptr + 1) % m
        data[i] = sum / m
        if (ptr === 0) { sum = 0; for (let j = 0; j < m; j++) sum += mem[j] }
      }
      params.ptr = ptr
      params._sum = sum
      return data
    }
    export let f = (n, calls) => {
      const params = { memory: ${w} }
      let h = 0
      for (let c = 0; c < calls; c++) {
        const x = new Float64Array(n + c)
        for (let i = 0; i < x.length; i++) x[i] = Math.sin(i * 0.37 + c) * 3
        avg(x, params)
        for (let i = 0; i < x.length; i++) h = (Math.imul(h, 31) + (x[i] * 1000 | 0)) | 0
        h = (h + params.ptr) | 0
      }
      return h
    }`
  for (const w of [16, 7, 1]) {
    const want = oracle(src(w)).f, opts = ['speed', { level: 'speed', ringLaps: false }, 2]
    for (const optimize of opts) for (const [n, calls] of [[100, 3], [15, 4], [16, 2], [0, 2], [33, 5]])
      is(run(src(w), { optimize }).f(n, calls), want(n, calls), `window ${w}, ${n} samples, ${calls} calls, ${JSON.stringify(optimize)}`)
  }
  if (onKernel()) return
  const laps = (optimize) => count(parseWat(compile(src(16), { wat: true, optimize })), n => n[0] === 'loop' && typeof n[1] === 'string' && n[1].startsWith('$__rl'))
  ok(laps('speed') >= 2, `the window's sample loop runs in laps (${laps('speed')} lap loops)`)
  is(laps({ level: 'speed', ringLaps: false }), 0, 'ringLaps: false keeps the loop as written')
})
