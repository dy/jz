import { compile } from './watr-compile.js'
import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const N_RUNS = 21
const N_WARMUP = 3
const N_ITERS = 24

const WAT_CORE = `(module
  (type $bin (func (param i32 i32) (result i32)))
  (func $add (type $bin) (i32.add (local.get 0) (local.get 1)))
  (func $mul (type $bin) (i32.mul (local.get 0) (local.get 1)))
  (func (export "main") (param $n i32) (result i32)
    (local $i i32)
    (local $acc i32)
    (loop $loop
      (local.set $acc (call $add (local.get $acc) (local.get $i)))
      (local.set $acc (i32.xor (local.get $acc) (call $mul (local.get $i) (i32.const 17))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $loop (i32.lt_s (local.get $i) (local.get $n))))
    (local.get $acc)))`

const WAT_MEMORY = `(module
  (memory (export "memory") 1)
  (data (i32.const 32) "jz-watr-benchmark")
  (func (export "sum") (param $n i32) (result i32)
    (local $i i32)
    (local $acc i32)
    (loop $loop
      (local.set $acc (i32.add (local.get $acc) (i32.load8_u (i32.add (i32.const 32) (local.get $i)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $loop (i32.lt_s (local.get $i) (local.get $n))))
    (local.get $acc)))`

const WAT_TABLE = `(module
  (type $ret (func (result i32)))
  (table $tbl 3 funcref)
  (elem (table $tbl) (i32.const 0) funcref $a $b $c)
  (func $a (result i32) (i32.const 11))
  (func $b (result i32) (i32.const 17))
  (func $c (result i32) (i32.const 23))
  (func (export "call") (param $i i32) (result i32)
    (call_indirect $tbl (type $ret) (local.get $i))))`

const checksumBytes = (buf) => {
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < buf.length; i++) h = mix(h, buf[i])
  return h >>> 0
}

export let main = () => {
  let h = 0x811c9dc5 | 0
  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) {
    h = 0x811c9dc5 | 0
    for (let k = 0; k < N_ITERS; k++) {
      if (k % 3 === 0) cs = checksumBytes(compile(WAT_CORE))
      else if (k % 3 === 1) cs = checksumBytes(compile(WAT_MEMORY))
      else cs = checksumBytes(compile(WAT_TABLE))
      h = mix(h, cs)
    }
    cs = h >>> 0
  }

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    h = 0x811c9dc5 | 0
    for (let k = 0; k < N_ITERS; k++) {
      if (k % 3 === 0) cs = checksumBytes(compile(WAT_CORE))
      else if (k % 3 === 1) cs = checksumBytes(compile(WAT_MEMORY))
      else cs = checksumBytes(compile(WAT_TABLE))
      h = mix(h, cs)
    }
    cs = h >>> 0
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, N_ITERS, 3, N_RUNS)
}
