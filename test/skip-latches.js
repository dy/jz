// A test that skips a loop's inner scan runs the rest of the round in a copy of
// its own (src/optimize/skip-latches.js): V8 lays code out as written, and the
// round that skipped the scan jumped past it, and past the arms the scan's slow
// path keeps after it, to the latch. The copy folds what the way to the branch
// decides: a flag the round cleared, a cursor an earlier test bounded.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { onKernel, levels } from './_matrix.js'
import { oracle, jz, compile, funcWat } from './util.js'
import parseWat from 'watr/parse'
import { walk } from '../scripts/wat-probe.mjs'
import { skipLatches } from '../src/optimize/skip-latches.js'
import { SELF_OPTIMIZE } from '../scripts/build-profile.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const g = (n) => ['local.get', n], k = (v) => ['i32.const', v]
const elem = ['f64.load', ['i32.add', g('$z'), ['i32.shl', g('$k'), k(3)]]]
const step = ['local.set', '$k', ['i32.add', g('$k'), k(1)]]
const scan = ['loop', '$W', step, ['br_if', '$W', ['f64.lt', elem, g('$x')]]]
const tail = ['local.set', '$s', ['i32.add', g('$s'), g('$k')]]
const latch = ['br_if', '$L', ['i32.lt_s', ['local.tee', '$q', ['i32.add', g('$q'), k(1)]], k(9)]]
const one = (body) => skipLatches(['module', ['func', '$f', body]])[1][2]

test('skipLatches: the round that skips a scan entered on its data takes the latch in a copy of the rest', () => {
  const skip = ['br_if', '$B', ['i32.eqz', ['f64.lt', elem, g('$x')]]]
  is(one(['block', '$brk', ['loop', '$L', ['block', '$B', skip, scan], tail, latch]]),
    ['block', '$brk', ['loop', '$L', ['block', '$B', ['if', skip[2], ['then', tail, latch, ['br', '$brk']]], scan], tail, latch]],
    'the skip falls into the rest of the round, the latch, and the loop\'s exit')
  // a loop that is not its block's last statement leaves by a block of its own
  is(one(['block', '$brk', ['loop', '$L', ['block', '$B', skip, scan], tail, latch], ['nop']]),
    ['block', '$brk', ['block', '$out_s0', ['loop', '$L', ['block', '$B', ['if', skip[2], ['then', tail, latch, ['br', '$out_s0']]], scan], tail, latch]], ['nop']],
    'a loop with code after it in its block is wrapped')
})

// The copy runs where the branch took the round: a flag set to a literal before the scan,
// a cursor a guard kept in range, read by the conditionals of the rest, decides them.
test('skipLatches: the copy folds the tests the way to the branch decides', () => {
  const guard = ['br_if', '$B', ['i32.gt_s', g('$k'), k(383)]]
  const skip = ['br_if', '$B', ['i32.eqz', ['f64.lt', elem, g('$x')]]]
  const slow = ['if', g('$left'), ['then', ['loop', '$S', step, ['br_if', '$S', ['f64.lt', elem, g('$x')]]]]]
  const hot = ['local.set', '$s', ['f64.load', ['i32.add', g('$v'), ['i32.shl', g('$k'), k(2)]]]]
  const cold = ['local.set', '$s', ['f64.const', 0]]
  const suffix = ['if', ['i32.le_s', g('$k'), k(383)], ['then', hot], ['else', cold]]
  const body = ['loop', '$L', ['local.set', '$left', k(0)], ['block', '$B', guard, skip, scan], slow, suffix, tail, latch]
  const out = one(['block', '$brk', body])
  is(out[2][3][2], guard, 'a guard of words alone keeps its branch')
  is(out[2][3][3], ['if', skip[2], ['then', hot, tail, latch, ['br', '$brk']]], 'the copy keeps the arm the cursor\'s range takes, without the flag\'s slow path')
  is(out[2].slice(4), [slow, suffix, tail, latch], 'the rest of the round is as written')
})

test('skipLatches: a test of words, a rest that keeps a loop, a loop without a latch and a branch by depth keep their shape', () => {
  // (the pass rewrites its input in place: compare with a copy taken before)
  const kept = (body, why) => { const before = JSON.parse(JSON.stringify(body)); is(one(body), before, why) }
  const skip = ['br_if', '$B', ['i32.eqz', ['f64.lt', elem, g('$x')]]]
  kept(['block', '$brk', ['loop', '$L', ['block', '$B', ['br_if', '$B', ['i32.ge_s', g('$k'), g('$n')]], scan], tail, latch]], 'a counted entry test keeps its branch')
  kept(['block', '$brk', ['loop', '$L', ['block', '$B', skip, scan], ['loop', '$M', ['br_if', '$M', g('$y')]], tail, latch]], 'a rest that keeps a loop is not copied')
  kept(['block', '$brk', ['loop', '$L', ['block', '$B', skip, scan], tail]], 'a loop without a latch at its end keeps its shape')
  kept(['block', '$brk', ['loop', '$L', ['block', '$B', skip, scan, ['br_if', 0, g('$y')]], tail, latch]], 'a function that branches by depth keeps its loops')
  kept(['block', '$brk', ['loop', '$L', ['block', '$B', skip, tail], tail, latch]], 'a test that skips no loop keeps its branch')
})

// The lower envelope's scan and a cursor stepping to the next boundary, each against the
// host, with inputs whose scans run to the end of their arrays.
const SCANS = `
export let run = (seed, mode) => {
  const z = new Float64Array(65), v = new Int32Array(64), f = new Float64Array(64), d = new Float64Array(64)
  let s = seed | 0
  for (let i = 0; i < 64; i++) {
    s = (s * 1103515245 + 12345) | 0
    const r = (s >>> 8) % 100
    z[i] = mode === 0 ? i * 0.9 + (r % 7) : mode === 1 ? (r < 20 ? i : i * 3) : mode === 2 ? NaN : -1
    v[i] = (r * 7) % 64
    f[i] = r - 50
  }
  z[64] = mode === 3 ? -1 : 1e20
  let k = 0, h = 0
  for (let q = 0; q < 64; q++) {
    while (z[k + 1] < q) k++
    const dq = q - v[k]
    d[q] = dq * dq + f[v[k]]
    h = (h * 31 + (d[q] === d[q] ? d[q] % 1000003 : 7)) % 1000000007
  }
  let j = 0, c = 0
  for (let q = 0; q < 64; q++) {
    if (j < 64 && f[j] > q - 50) { while (j < 64 && f[j] > q - 50) j++; c += j }
    c = (c * 7 + q) % 1000003
  }
  return h + '/' + k + '/' + c
}`

test('skipLatches: scans agree with the host with and without the copies', () => {
  const native = oracle(SCANS).run
  for (const optimize of [...levels(0, 2, 3, 'size'), { level: 'speed', skipLatches: false }]) {
    const wasm = jz(SCANS, { optimize }).exports.run
    for (let mode = 0; mode < 4; mode++) for (let seed = 1; seed <= 6; seed++)
      is(wasm(seed, mode), native(seed, mode), `${JSON.stringify(optimize)}: mode ${mode}, seed ${seed}`)
  }
  if (onKernel()) return
  // the most branches back to one loop's head in `run`: the latch, and each copy's
  const backs = (optimize) => {
    let most = 0
    walk(parseWat(funcWat(compile(SCANS, { optimize, wat: true }), 'run')), n => {
      if (n[0] !== 'loop' || typeof n[1] !== 'string') return
      let b = 0
      walk(n, m => { if ((m[0] === 'br' || m[0] === 'br_if') && m[1] === n[1]) b++ })
      if (b > most) most = b
    })
    return most
  }
  ok(backs('speed') > backs({ level: 'speed', skipLatches: false }), 'the scan\'s skip takes a latch of its own')
})

// The pass runs inside the self-compiled compiler too (dist/jz.wasm, built at SELF_OPTIMIZE):
// compiled by jz at that profile, it copies what it copies natively. A test the way leaves
// open keeps its conditional in the copy, one the way decides keeps the arm it takes (the
// answers are words: a null beside literal booleans read back as false self-compiled, and the
// copy dropped open conditionals, the kernel-parity corpus's durable-forward scan, lz's best
// match update).
test('skipLatches: compiled at the self-compile profile, the pass copies what it copies natively', () => {
  const src = readFileSync(join(import.meta.dirname, '../src/optimize/skip-latches.js'), 'utf8')
  const driver = `import { skipLatches } from './skip-latches.js'
export let run = (json) => JSON.stringify(skipLatches(JSON.parse(json)))`
  const hosted = jz(driver, { modules: { './skip-latches.js': src }, optimize: SELF_OPTIMIZE }).exports.run
  const skip = ['br_if', '$B', ['i32.eqz', ['f64.lt', elem, g('$x')]]]
  const guard = ['br_if', '$B', ['i32.gt_s', g('$k'), k(383)]]
  const open = ['if', ['i32.eqz', ['global.get', '$buf']], ['then', ['global.set', '$buf', k(1)]]]
  const openWord = ['if', ['i32.ge_u', g('$n'), ['global.get', '$cap']], ['then', ['local.set', '$s', k(2)]]]
  const flag = ['if', g('$left'), ['then', ['local.set', '$s', k(3)]], ['else', ['local.set', '$s', k(4)]]]
  const range = ['if', ['i32.le_s', g('$k'), k(383)], ['then', ['local.set', '$s', k(5)]], ['else', ['local.set', '$s', k(6)]]]
  const exit = ['br_if', '$brk', ['i32.gt_s', g('$k'), k(400)]]
  const body = ['loop', '$L', ['local.set', '$left', k(0)], ['block', '$B', guard, skip, scan], open, openWord, flag, range, exit, tail, latch]
  const module = ['module', ['func', '$f', ['block', '$brk', body]]]
  const native = JSON.stringify(skipLatches(JSON.parse(JSON.stringify(module))))
  ok(native.includes('"$buf"') && native.split('"global.get","$cap"').length === 3, 'the open conditionals stand in the copy and after it')
  is(hosted(JSON.stringify(module)), native, 'the self-compile profile copies the same')
})
