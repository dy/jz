// A loop that writes no array header (its stores are element stores, its
// calls change no header) reads a present array's forwarding word and length
// once, before the loop (optimize/licm.js, ir/pointers.js fwdOffsetIR's value
// form): `mul(out, a[i], b[i])` over module arrays of arrays resolves `a` and
// `b` ahead of the loop and tests only the index inside. A loop that grows an
// array, or reads one that may be missing, keeps the reads inside: the hoisted
// load of a missing receiver would trap where the zero-trip loop did nothing.
// A durable array such a loop stores into is saved for the reset before the
// loop, once (compile/emit/control-flow.js durableLoopArrays).
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz from '../index.js'
import { belowOpt, levels } from './_matrix.js'
import { agree, funcWat, oracle, run, wat } from './util.js'

const fnText = (text, name) => funcWat(text, name + '$exp') || funcWat(text, name)

const src = `const a = [], b = [], out = [0, 0, 0, 0], grown = []
  for (let i = 0; i < 64; i++) { a.push([i, i + 1, i + 2, i + 3]); b.push([i * 2, 1, 2, 3]) }
  const mul = (o, p, q) => { o[0] = p[0] * q[0] + p[1] * q[1]; o[1] = p[2] * q[2]; o[2] = p[3] + q[3]; o[3] = 1; return o }
  export const run = (n) => { let acc = 0; for (let i = 0; i < n; i++) { mul(out, a[i], b[i]); acc += out[0] + out[1] + out[2] } return acc }
  export const grow = (n) => { let acc = 0; for (let i = 0; i < n; i++) { grown.push(i); acc += a[i][0] } return acc + grown.length }
  let c
  export const bind = () => { c = a; return c.length }
  export const sum = (n) => { let s = 0; for (let i = 0; i < n; i++) s += c[i][0]; return s }
  const big = (p, q) => { let s = 0; for (let k = 0; k < 4; k++) { s += p[k] * q[k]; s -= p[k] / (q[k] + 1); s *= 1.0001; s += p[3 - k] - q[3 - k] } out[0] = s; out[1] = s * 2; out[2] = s * 3; return s + out[1] }
  const pushed = (x) => { grown.push(x); return grown.length }
  export const viaCall = (n) => { let acc = 0; for (let i = 0; i < n; i++) acc += big(a[i], b[i]); return acc }
  export const viaPush = (n) => { let acc = 0; for (let i = 0; i < n; i++) acc += pushed(a[i][0]); return acc }`

// The loop's body as text: what sits between `(loop` and the function's end.
const loopBody = (fn) => fn.slice(fn.indexOf('(loop '))
const before = (fn) => fn.slice(0, fn.indexOf('(loop '))

test('header hoist: the kernels answer what the host answers, a zero-trip loop reads nothing', () => {
  for (const optimize of levels(0, 2, 3)) {
    for (const n of [0, 1, 64]) agree(src, 'run', [n], { optimize }, `run(${n}) at ${optimize}`)
    const host = oracle(src), jz = run(src, { optimize })
    throws(() => jz.run(70), 'a read past a: the element has no [0]'); throws(() => host.run(70))
    is(jz.sum(0), host.sum(0), `sum(0) before bind at ${optimize}: the missing receiver is never read`)
    throws(() => jz.sum(1), 'sum(1) before bind reads the missing receiver'); throws(() => host.sum(1))
    is(jz.bind(), host.bind()); is(jz.sum(5), host.sum(5), `sum(5) after bind at ${optimize}`)
    is(jz.grow(3), host.grow(3), `grow(3) at ${optimize}`)
    is(jz.viaCall(64), host.viaCall(64), `viaCall(64) at ${optimize}`)
    is(jz.viaPush(3), host.viaPush(3), `viaPush(3) at ${optimize}`)
  }
})

// A call the loop makes settles by the callee's own body (collectHeaderSafeFuncs):
// one that stores elements only lets the hops out, one that grows an array keeps them in.
test('header hoist: a header-safe callee lets the hops out, a growing one keeps them in', () => {
  if (belowOpt(2)) return
  const text = wat(src, { optimize: 2 })
  // The hoist runs before watr inlines `big`: only the census lets it through then.
  const call = fnText(text, 'viaCall'), push = fnText(text, 'viaPush')
  is((loopBody(call).match(/call \$__ptr_offset_fwd/g) || []).length, 0, 'no forwarding hop inside a loop calling a header-safe function')
  ok(/call \$__ptr_offset_fwd/.test(loopBody(push)), 'a loop calling a function that pushes keeps the hop inside')
})

test('header hoist: the forwarding hop and the length leave the loop, the barrier goes first', () => {
  if (belowOpt(2)) return
  const text = wat(src, { optimize: 2 })
  const fn = fnText(text, 'run')
  is((loopBody(fn).match(/call \$__ptr_offset_fwd/g) || []).length, 0, 'no forwarding hop inside the loop')
  is((loopBody(fn).match(/i32\.load/g) || []).length, 0, 'no header word read inside the loop')
  ok(/local\.set \$__li/.test(before(fn)), 'the invariants sit before the loop')
  is((fn.match(/call \$__durable_arr_snap/g) || []).length, 1, 'the durable array is saved once')
  ok(/call \$__durable_arr_snap/.test(before(fn)), 'and before the loop')
  ok(/call \$__ptr_offset_fwd/.test(loopBody(fnText(text, 'grow'))), 'a loop that grows an array keeps the hop inside')
  ok(/i32\.load/.test(loopBody(fnText(text, 'sum'))), 'a receiver that may be missing keeps its header reads inside')
})

// The reset keeps its meaning with the barrier ahead of the loop: round 2
// starts from what module init left, however many times the loop stored.
test('header hoist: a reset restores the array the loop stored into', () => {
  for (const optimize of levels(0, 2)) {
    const { exports } = jz(src, { optimize })
    const first = exports.run(64)
    is(exports.run(64), first, 'a second call sees no difference: out is overwritten each pass')
    exports._clear()
    is(exports.run(64), first, 'round 2 answers the same')
  }
})
