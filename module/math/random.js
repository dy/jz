/**
 * Math.random — entropy-seeded xorshift32 (or a fixed reproducible seed via
 * `randomSeed: <n>`), plus the WASI/JS-host entropy shim that seeds it. Pure
 * move from module/math.js (pipeline-minimality): `rngEntropy`/
 * `rngSeedConst`/`wasi` are grep-verified used ONLY by this family in the
 * original file — nowhere else in math.js touches them, so they move here
 * wholesale rather than staying beside the unrelated `crPow` const they sat
 * next to in the original closure.
 *
 * @module math/random
 */
import { typed } from '../../src/ir.js'
import { reg, hostImport, wat } from '../../src/bridge.js'
import { ctx, declGlobal } from '../../src/ctx.js'

export const registerMathRandom = () => {
  // Math.random seeding. DEFAULT: entropy-seeded once from the host on first use (crypto under
  // host:'js', `random_get` under WASI), so randomness "just works" and isn't silently reproducible.
  // `randomSeed: <n>` picks a fixed seed for a reproducible sequence; `true` forces entropy explicitly.
  // Either way jz emits the randomness syscall only when `Math.random` is actually used.
  const rngEntropy = ctx.transform.randomSeed === undefined || ctx.transform.randomSeed === true
  const rngSeedConst = typeof ctx.transform.randomSeed === 'number'
    ? ((ctx.transform.randomSeed >>> 0) || 1)   // xorshift dies on 0 → floor at 1
    : 12345
  // Which entropy shim seeds the RNG: WASI's random_get syscall vs the JS-host
  // env.rngSeed import (module/crypto.js mirrors this same wasiShims split).
  const wasi = ctx.transform.targetProfile.wasiShims

  // Random
  reg('math.random', ['math.random'], () => {
    // Entropy mode: pull the host randomness syscall on demand (only when
    // Math.random is actually used) — env.rngSeed (JS host) or WASI random_get.
    if (rngEntropy) {
      if (wasi)
        hostImport('wasi_snapshot_preview1', 'random_get', ['func', '$__random_get', ['param', 'i32'], ['param', 'i32'], ['result', 'i32']])
      else
        hostImport('env', 'rngSeed', ['func', '$__env_rng_seed', ['result', 'i32']])
    }
    return typed(['call', '$math.random'], 'f64')
  })

  // xorshift32 → [0,1). In entropy mode a one-shot prologue replaces the fixed
  // initial state with host entropy on first call (branch is well-predicted after).
  const rngSeedPrologue = rngEntropy ? `(if (i32.eqz (global.get $math.rng_seeded))
      (then (global.set $math.rng_state (call $__rng_seed)) (global.set $math.rng_seeded (i32.const 1))))
    ` : ``
  wat('math.random', `(func $math.random (result f64)
    (local $s i32)
    ${rngSeedPrologue}(local.set $s (global.get $math.rng_state))
    (local.set $s (i32.xor (local.get $s) (i32.shl (local.get $s) (i32.const 13))))
    (local.set $s (i32.xor (local.get $s) (i32.shr_u (local.get $s) (i32.const 17))))
    (local.set $s (i32.xor (local.get $s) (i32.shl (local.get $s) (i32.const 5))))
    (global.set $math.rng_state (local.get $s))
    (f64.div (f64.convert_i32_u (i32.and (local.get $s) (i32.const 0x7FFFFFFF))) (f64.const 2147483647.0)))`,
    rngEntropy ? ['__rng_seed'] : [])

  // Global for random state — seeded with the fixed constant (deterministic) or,
  // in entropy mode, overwritten from the host on first Math.random() call.
  declGlobal('math.rng_state', 'i32', rngSeedConst)
  if (rngEntropy) {
    declGlobal('math.rng_seeded', 'i32')
    // One i32 of host entropy, floored at 1 (xorshift32 is dead at state 0).
    wat('__rng_seed', wasi
      ? `(func $__rng_seed (result i32)
    (local $buf i32) (local $s i32)
    (local.set $buf (call $__alloc (i32.const 4)))
    (drop (call $__random_get (local.get $buf) (i32.const 4)))
    (local.set $s (i32.load (local.get $buf)))
    (select (local.get $s) (i32.const 1) (local.get $s)))`
      : `(func $__rng_seed (result i32)
    (local $s i32)
    (local.set $s (call $__env_rng_seed))
    (select (local.get $s) (i32.const 1) (local.get $s)))`,
      wasi ? ['__alloc'] : [])
  }
}
