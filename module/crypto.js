/**
 * crypto — Web Crypto's compute slice: getRandomValues + randomUUID.
 *
 * Entropy rides the host's CSPRNG through the same channel Math.random seeds
 * from: WASI `random_get` under host:'wasi', an `env.random` byte-fill (wired
 * by interop from globalThis.crypto.getRandomValues) under host:'js'. A
 * numeric `randomSeed` option switches BOTH into a deterministic xorshift32
 * stream — reproducible runs for sims/tests, explicitly NOT cryptographic
 * (documented divergence; the default entropy mode IS the host CSPRNG).
 *
 * getRandomValues keeps the spec's guards (integer typed arrays only, ≤ 64 KiB
 * per call) and returns its argument. randomUUID mints a lowercase v4 UUID.
 * crypto.subtle stays out by doctrine — security crypto is out of scope.
 *
 * @module crypto
 */

import { typed, asI64 } from '../src/ir.js'
import { emit, wat, hostImport, bind } from '../src/bridge.js'
import { inc, declGlobal, PTR } from '../src/ctx.js'

export default (ctx) => {
  const seeded = typeof ctx.transform.randomSeed === 'number'
  const seedConst = seeded ? ((ctx.transform.randomSeed >>> 0) || 1) : 0 // xorshift dies on 0
  const wasi = ctx.transform.host === 'wasi'

  const needEntropy = () => wasi
    ? hostImport('wasi_snapshot_preview1', 'random_get',
        ['func', '$__random_get', ['param', 'i32'], ['param', 'i32'], ['result', 'i32']])
    : hostImport('env', 'random',
        ['func', '$__env_random', ['param', 'i32'], ['param', 'i32']])

  if (seeded) {
    declGlobal('crypto.state', 'i32', seedConst)
    wat('__crypto_fill', `(func $__crypto_fill (param $dst i32) (param $len i32)
    (local $s i32) (local $i i32)
    (local.set $s (global.get $crypto.state))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $i) (local.get $len)))
      (local.set $s (i32.xor (local.get $s) (i32.shl (local.get $s) (i32.const 13))))
      (local.set $s (i32.xor (local.get $s) (i32.shr_u (local.get $s) (i32.const 17))))
      (local.set $s (i32.xor (local.get $s) (i32.shl (local.get $s) (i32.const 5))))
      (i32.store8 (i32.add (local.get $dst) (local.get $i)) (local.get $s))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (global.set $crypto.state (local.get $s)))`)
  } else {
    wat('__crypto_fill', wasi
      ? `(func $__crypto_fill (param $dst i32) (param $len i32)
    (drop (call $__random_get (local.get $dst) (local.get $len))))`
      : `(func $__crypto_fill (param $dst i32) (param $len i32)
    (call $__env_random (local.get $dst) (local.get $len)))`)
  }

  // Spec guards (WebCryptoAPI §10.1.1): receiver must be an integer typed
  // array (floats → TypeMismatchError), byteLength ≤ 65536 (QuotaExceeded).
  // Element codes 0–5 are the int family; code 7 + the bigint flag is
  // BigInt64/BigUint64 (allowed). Returns the receiver, filled.
  wat('__get_random_values', `(func $__get_random_values (param $p i64) (result f64)
    (local $aux i32) (local $et i32) (local $bl i32)
    (if (i32.ne (call $__ptr_type (local.get $p)) (i32.const ${PTR.TYPED}))
      (then (throw $__jz_err (f64.const 0))))
    (local.set $aux (call $__ptr_aux (local.get $p)))
    (local.set $et (i32.and (local.get $aux) (i32.const 7)))
    (if (i32.and
          (i32.gt_u (local.get $et) (i32.const 5))
          (i32.eqz (i32.and (local.get $aux) (i32.const 16))))
      (then (throw $__jz_err (f64.const 0))))
    (local.set $bl (i32.shl (call $__len (local.get $p)) (call $__typed_shift (local.get $et))))
    (if (i32.gt_u (local.get $bl) (i32.const 65536))
      (then (throw $__jz_err (f64.const 0))))
    (call $__crypto_fill (call $__typed_data (local.get $p)) (local.get $bl))
    (f64.reinterpret_i64 (local.get $p)))`,
    ['__crypto_fill', '__ptr_type', '__ptr_aux', '__len', '__typed_shift', '__typed_data'])

  // Lowercase v4 UUID: 16 entropy bytes, version/variant bits, hex + dashes.
  wat('__random_uuid', `(func $__random_uuid (result f64)
    (local $buf i32) (local $base i32) (local $out i32)
    (local $i i32) (local $j i32) (local $b i32) (local $n i32)
    (local.set $buf (call $__alloc (i32.const 16)))
    (call $__crypto_fill (local.get $buf) (i32.const 16))
    (i32.store8 (i32.add (local.get $buf) (i32.const 6))
      (i32.or (i32.and (i32.load8_u (i32.add (local.get $buf) (i32.const 6))) (i32.const 15)) (i32.const 64)))
    (i32.store8 (i32.add (local.get $buf) (i32.const 8))
      (i32.or (i32.and (i32.load8_u (i32.add (local.get $buf) (i32.const 8))) (i32.const 63)) (i32.const 128)))
    (local.set $base (call $__alloc (i32.const 40)))
    (i32.store (local.get $base) (i32.const 36))
    (local.set $out (i32.add (local.get $base) (i32.const 4)))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 16)))
      (local.set $b (i32.load8_u (i32.add (local.get $buf) (local.get $i))))
      (local.set $n (i32.shr_u (local.get $b) (i32.const 4)))
      (i32.store8 (i32.add (local.get $out) (local.get $j))
        (select (i32.add (local.get $n) (i32.const 87)) (i32.add (local.get $n) (i32.const 48)) (i32.gt_u (local.get $n) (i32.const 9))))
      (local.set $n (i32.and (local.get $b) (i32.const 15)))
      (i32.store8 (i32.add (i32.add (local.get $out) (local.get $j)) (i32.const 1))
        (select (i32.add (local.get $n) (i32.const 87)) (i32.add (local.get $n) (i32.const 48)) (i32.gt_u (local.get $n) (i32.const 9))))
      (local.set $j (i32.add (local.get $j) (i32.const 2)))
      ;; dash after bytes 3, 5, 7, 9 → 8-4-4-4-12
      (if (i32.or
            (i32.or (i32.eq (local.get $i) (i32.const 3)) (i32.eq (local.get $i) (i32.const 5)))
            (i32.or (i32.eq (local.get $i) (i32.const 7)) (i32.eq (local.get $i) (i32.const 9))))
        (then
          (i32.store8 (i32.add (local.get $out) (local.get $j)) (i32.const 45))
          (local.set $j (i32.add (local.get $j) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $out)))`,
    ['__crypto_fill', '__alloc', '__mkptr'])

  bind('crypto.getRandomValues', (arr) => {
    if (!seeded) needEntropy()
    ctx.runtime.throws = true
    ctx.features.typedarray = true
    inc('__get_random_values')
    return typed(['call', '$__get_random_values', asI64(emit(arr))], 'f64')
  })

  bind('crypto.randomUUID', () => {
    if (!seeded) needEntropy()
    inc('__random_uuid')
    return typed(['call', '$__random_uuid'], 'f64')
  })
}
