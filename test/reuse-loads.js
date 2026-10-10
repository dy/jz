// A load an earlier load already read, with no store between, reads the earlier value
// (src/optimize/reuse-loads.js reuseLoads); a byte or half of a word read alone is the
// narrow load of it (narrowByteLoads). Every value is a differential against the host;
// the WAT shows the loads.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { agree, wat } from './util.js'
import { belowOpt } from './_matrix.js'
import parseWat from 'watr/parse'
import encodeWat from 'watr/compile'
import { reuseLoads, narrowByteLoads } from '../src/optimize/reuse-loads.js'

const count = (text, re) => (text.match(re) || []).length
// the balanced form that opens at `at`
const form = (text, at) => { let d = 0; for (let i = at; i < text.length; i++) { if (text[i] === '(') d++; else if (text[i] === ')' && --d === 0) return text.slice(at, i + 1) } return text.slice(at) }
const shapes = (src, check) => { if (!belowOpt(2)) check(wat(src)) }
const exportsOf = ir => new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir)), { m: { m: new WebAssembly.Memory({ initial: 1 }) } }).exports

// A radix pass: the digit of an element and the element itself, read in one step.
const SCATTER = `const scatter = (a, b, count, shift) => {
  for (let i = 0; i < 4096; i++) {
    const d = (a[i] >>> shift) & 0xff
    b[count[d]] = a[i]
    count[d]++
  }
}
const histogram = (a, count) => { for (let i = 0; i < 4096; i++) count[(a[i] >>> 8) & 0xff]++ }
export let main = (k) => {
  const a = new Uint32Array(4096), b = new Uint32Array(4096), c = new Int32Array(256)
  for (let i = 0; i < 4096; i++) a[i] = (i * 2654435761 + k) >>> 0
  histogram(a, c)
  let sum = 0
  for (let i = 0; i < 256; i++) { const n = c[i]; c[i] = sum; sum += n }
  scatter(a, b, c, 8)
  return (b[5] + b[4095] + c[3]) >>> 0
}`

test('reuse-loads: an element read twice with only loads between loads once', () => {
  for (const k of [0, 1, 77]) agree(SCATTER, 'main', [k])
  shapes(SCATTER, text => {
    const loop = form(text, text.lastIndexOf('(loop '))
    // the element once; the count, and again after the store into \`b\`, which may reach it
    is(count(loop, /\(i32\.load(?![0-9])/g), 3, 'the scatter step loads its element once')
    ok(/i32\.load8_u offset=1/.test(text), 'the histogram reads the digit as one byte')
  })
})

test('reuse-loads: a store, a call, a write of the address or a join keeps the second load', () => {
  const ir = parseWat(`(module (import "m" "m" (memory 1))
    (func $id (param i32) (result i32) (local.get 0))
    (func $f (export "f") (param $p i32) (param $c i32) (result i32) (local $q i32)
      (i32.store (i32.const 0) (i32.const 5))
      (i32.store (i32.const 4) (i32.const 6))
      (local.set $q (i32.add
        (i32.load (local.get $p))
        (if (result i32) (local.get $c) (then (i32.load (local.get $p))) (else (i32.const 0)))))
      (i32.store (local.get $p) (i32.const 9))
      (local.set $q (i32.add (local.get $q) (i32.load (local.get $p))))
      (drop (call $id (i32.const 0)))
      (local.set $q (i32.add (local.get $q) (i32.load (local.get $p))))
      (local.set $p (i32.const 4))
      (i32.add (local.get $q) (i32.add (i32.load (local.get $p)) (i32.load (local.get $p))))))`)
  const fn = ir.find(n => n[0] === 'func' && n[1] === '$f')
  const before = exportsOf(ir).f
  ok(reuseLoads(fn), 'the last pair shares its load')
  const text = JSON.stringify(fn)
  is(count(text, /"i32\.load"/g), 5, 'only the store-free pair after the write of $p shares a load')
  const after = exportsOf(ir).f
  for (const p of [0, 4]) for (const c of [0, 1]) is(after(p, c), before(p, c), `p=${p} c=${c}`)
})

test('reuse-loads: a part of a word narrows to its load, the word kept whole where read whole', () => {
  const ir = parseWat(`(module (import "m" "m" (memory 1))
    (func $f (export "f") (param $p i32) (result i32) (local $w i32) (local $v i32)
      (i32.store (local.get $p) (i32.const 0x89abcdef))
      (i32.add (i32.add (i32.add
        (i32.and (i32.shr_u (i32.load (local.get $p)) (i32.const 8)) (i32.const 255))
        (i32.shr_s (i32.load (local.get $p)) (i32.const 16)))
        (i32.add (i32.and (local.tee $w (i32.load (local.get $p))) (i32.const 65535)) (i32.and (local.get $w) (i32.const 65535))))
        (i32.add (i32.and (local.tee $v (i32.load (local.get $p))) (i32.const 255)) (local.get $v)))))`)
  const fn = ir.find(n => n[0] === 'func' && n[1] === '$f')
  const before = exportsOf(ir).f
  ok(narrowByteLoads(fn), 'the parts narrow')
  const text = JSON.stringify(fn)
  ok(text.includes('"i32.load8_u","offset=1"') && text.includes('"i32.load16_s","offset=2"'), 'byte 1 and the signed top half read alone')
  is(count(text, /"i32\.load16_u"/g), 1, 'a local every read of which takes its low half holds the half')
  is(count(text, /"i32\.load"/g), 1, 'a local read whole keeps the word')
  const after = exportsOf(ir).f
  for (const p of [0, 8, 100]) is(after(p), before(p), `p=${p}`)
})
