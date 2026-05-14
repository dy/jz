/**
 * Timer module — setTimeout/setInterval/clearTimeout/clearInterval.
 *
 * Two host-mode lowerings:
 *
 *   `host: 'js'` (default): emit `env.setTimeout(cb: f64, delay: f64, repeat: i32) -> f64`
 *     and `env.clearTimeout(id: f64) -> f64`. The JS host (interop/nanbox.js) drives both
 *     via global setTimeout/setInterval and calls back into wasm through the
 *     exported `__invoke_closure(clos: i64) -> f64` trampoline. No queue, no
 *     polling — the host's event loop does the scheduling.
 *
 *   `host: 'wasi'`: pure-WASM timer queue using WASI clock_time_get for
 *     deadlines. Runs inline after __start (or via __timer_loop on wasmtime/
 *     wasmer). No JS host needed.
 *
 * WASI queue layout: heap-allocated array of entries in linear memory.
 *   Each entry (40 bytes):
 *     [0]  id (i32)           — unique timer ID
 *     [4]  pad (i32)
 *     [8]  closure_ptr (f64)  — NaN-boxed closure to invoke
 *     [16] deadline_ns (i64)  — absolute nanoseconds (monotonic clock)
 *     [24] interval_ms (f64)  — 0 for setTimeout, >0 for setInterval
 *     [32] alive (i32)        — 1=active, 0=cleared
 *     [36] pad (i32)
 *
 * @module timer
 */

import { typed, asF64, asI64, UNDEF_NAN, MAX_CLOSURE_ARITY, temp, tempI64 } from '../src/ir.js'
import { emit } from '../src/emit.js'
import { inc, PTR, LAYOUT } from '../src/ctx.js'

const MAX_TIMERS = 64
const ENTRY_SIZE = 40

const addImportOnce = (ctx, mod, name, fn) => {
  if (ctx.module.imports.some(i => i[1] === `"${mod}"` && i[2] === `"${name}"`)) return
  ctx.module.imports.push(['import', `"${mod}"`, `"${name}"`, fn])
}

// Shared "fire a NaN-boxed closure with 0 args" trampoline. Funcref index lives
// in upper 16 bits of the pointer payload; remaining $ftN slots get UNDEF_NAN.
// Closure is also passed as $__env so captures resolve via env-load.
// `exported` adds (export "__invoke_closure") so the JS host can call it.
const invokeClosureFn = (exported) => `(func $__invoke_closure${exported ? ' (export "__invoke_closure")' : ''} (param $clos i64) (result f64)
  (call_indirect (type \$ftN)
    (f64.reinterpret_i64 (local.get $clos))
    (i32.const 0)
    ${Array.from({length: MAX_CLOSURE_ARITY}, () => `(f64.const nan:${UNDEF_NAN})`).join('\n    ')}
    (i32.wrap_i64 (i64.and
      (i64.shr_u (local.get $clos) (i64.const ${LAYOUT.AUX_SHIFT}))
      (i64.const ${LAYOUT.AUX_MASK})))))`

const setupWasi = (ctx) => {
  // Always include init + tick + loop when timer module loads (structural, not per-emitter)
  inc('__timer_init', '__timer_tick', '__timer_loop')

  Object.assign(ctx.core.stdlibDeps, {
    __timer_init: ['__alloc'],
    __timer_add: ['__time_ns'],
    __timer_cancel: [],
    __timer_dispatch: ['__invoke_closure'],
    __timer_tick: ['__time_ns', '__timer_dispatch'],
    __timer_loop: ['__time_ns', '__timer_dispatch'],
  })

  // Force closure ABI width to MAX_CLOSURE_ARITY so __timer_dispatch's
  // call_indirect always matches the $ftN type (env, argc, a0..a7)
  ctx.closure.floor = MAX_CLOSURE_ARITY

  addImportOnce(ctx, 'wasi_snapshot_preview1', 'clock_time_get',
    ['func', '$__clock_time_get', ['param', 'i32'], ['param', 'i64'], ['param', 'i32'], ['result', 'i32']])

  // __time_ns() → i64 — current monotonic nanoseconds
  // Reuses address 0-7 for the i64 output (same as __time_ms in console.js)
  ctx.core.stdlib['__time_ns'] = `(func $__time_ns (result i64)
    (drop (call $__clock_time_get (i32.const 1) (i64.const 1) (i32.const 0)))
    (i64.load (i32.const 0)))`

  // __timer_init() — allocate timer queue, zero-fill, init next_id
  // Queue layout: [next_id i32 @ -4] [entry0 .. entry{MAX_TIMERS-1}]
  // We store next_id as a global to survive across calls
  ctx.core.stdlib['__timer_init'] = `(func $__timer_init
    (global.set $__timer_next_id (i32.const 1))
    (global.set $__timer_count (i32.const 0))
    (global.set $__timer_queue (call $__alloc (i32.const ${MAX_TIMERS * ENTRY_SIZE})))
    (memory.fill (global.get $__timer_queue) (i32.const 0) (i32.const ${MAX_TIMERS * ENTRY_SIZE})))`

  // __timer_add(closure_ptr: i64, delay_ms: f64, interval: i32) → f64 (timer ID)
  // interval=0 → setTimeout, interval=1 → setInterval
  ctx.core.stdlib['__timer_add'] = `(func $__timer_add (param $clos i64) (param $delay f64) (param $is_interval i32) (result f64)
    (local $id i32)
    (local $slot i32)
    (local $base i32)
    (local $deadline i64)
    ;; Find free slot
    (local.set $slot (i32.const -1))
    (local.set $base (global.get $__timer_queue))
    (block $found (loop $scan
      ;; slot starts at -1, increment first
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br_if $found (i32.ge_s (local.get $slot) (i32.const ${MAX_TIMERS})))
      ;; Check alive field at slot*ENTRY_SIZE + 32
      (br_if $scan (i32.load (i32.add (local.get $base)
        (i32.add (i32.mul (local.get $slot) (i32.const ${ENTRY_SIZE})) (i32.const 32)))))
      ;; alive==0 → free slot, break
      (br $found)))
    ;; No free slot? Return 0 (error)
    (if (i32.ge_s (local.get $slot) (i32.const ${MAX_TIMERS}))
      (then (return (f64.const 0))))
    ;; Compute deadline = now + delay_ms * 1_000_000
    (local.set $deadline (i64.add
      (call $__time_ns)
      (i64.trunc_f64_u (f64.mul (local.get $delay) (f64.const 1000000)))))
    ;; Allocate ID
    (local.set $id (global.get $__timer_next_id))
    (global.set $__timer_next_id (i32.add (local.get $id) (i32.const 1)))
    ;; Write entry
    ;; id @ offset+0
    (i32.store (i32.add (local.get $base) (i32.mul (local.get $slot) (i32.const ${ENTRY_SIZE})))
      (local.get $id))
    ;; closure_ptr @ offset+8
    (i64.store (i32.add (local.get $base) (i32.add (i32.mul (local.get $slot) (i32.const ${ENTRY_SIZE})) (i32.const 8)))
      (local.get $clos))
    ;; deadline_ns @ offset+16
    (i64.store (i32.add (local.get $base) (i32.add (i32.mul (local.get $slot) (i32.const ${ENTRY_SIZE})) (i32.const 16)))
      (local.get $deadline))
    ;; interval_ms @ offset+24 — store delay for intervals, 0 for timeouts
    (f64.store (i32.add (local.get $base) (i32.add (i32.mul (local.get $slot) (i32.const ${ENTRY_SIZE})) (i32.const 24)))
      (select (local.get $delay) (f64.const 0) (local.get $is_interval)))
    ;; alive @ offset+32
    (i32.store (i32.add (local.get $base) (i32.add (i32.mul (local.get $slot) (i32.const ${ENTRY_SIZE})) (i32.const 32)))
      (i32.const 1))
    ;; Increment active count
    (global.set $__timer_count (i32.add (global.get $__timer_count) (i32.const 1)))
    ;; Return ID as f64
    (f64.convert_i32_u (local.get $id)))`

  // __timer_cancel(id: f64) → f64 (0)
  ctx.core.stdlib['__timer_cancel'] = `(func $__timer_cancel (param $id f64) (result f64)
    (local $slot i32)
    (local $base i32)
    (local $target i32)
    (local.set $target (i32.trunc_f64_u (local.get $id)))
    (local.set $base (global.get $__timer_queue))
    (local.set $slot (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_s (local.get $slot) (i32.const ${MAX_TIMERS})))
      ;; Check if id matches and alive
      (if (i32.and
            (i32.eq (i32.load (i32.add (local.get $base) (i32.mul (local.get $slot) (i32.const ${ENTRY_SIZE})))) (local.get $target))
            (i32.load (i32.add (local.get $base) (i32.add (i32.mul (local.get $slot) (i32.const ${ENTRY_SIZE})) (i32.const 32)))))
        (then
          ;; Mark dead
          (i32.store (i32.add (local.get $base) (i32.add (i32.mul (local.get $slot) (i32.const ${ENTRY_SIZE})) (i32.const 32))) (i32.const 0))
          ;; Decrement count
          (global.set $__timer_count (i32.sub (global.get $__timer_count) (i32.const 1)))
          (br $done)))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br $scan)))
    (f64.const 0))`

  // __timer_dispatch(now_ns: i64) → i32 (number of callbacks dispatched)
  // Finds all due timers (deadline <= now), invokes them, reschedules intervals
  ctx.core.stdlib['__timer_dispatch'] = `(func $__timer_dispatch (param $now i64) (result i32)
    (local $slot i32)
    (local $base i32)
    (local $dispatched i32)
    (local $clos i64)
    (local $interval f64)
    (local $id i32)
    (local.set $dispatched (i32.const 0))
    (local.set $base (global.get $__timer_queue))
    (local.set $slot (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_s (local.get $slot) (i32.const ${MAX_TIMERS})))
      ;; Check alive
      (if (i32.load (i32.add (local.get $base) (i32.add (i32.mul (local.get $slot) (i32.const ${ENTRY_SIZE})) (i32.const 32))))
        (then
          ;; Check deadline <= now
          (if (i64.le_u
                (i64.load (i32.add (local.get $base) (i32.add (i32.mul (local.get $slot) (i32.const ${ENTRY_SIZE})) (i32.const 16))))
                (local.get $now))
            (then
              ;; Read closure and interval before potentially clearing
              (local.set $clos (i64.load (i32.add (local.get $base) (i32.add (i32.mul (local.get $slot) (i32.const ${ENTRY_SIZE})) (i32.const 8)))))
              (local.set $interval (f64.load (i32.add (local.get $base) (i32.add (i32.mul (local.get $slot) (i32.const ${ENTRY_SIZE})) (i32.const 24)))))
              (local.set $id (i32.load (i32.add (local.get $base) (i32.mul (local.get $slot) (i32.const ${ENTRY_SIZE})))))
              ;; Interval? Reschedule
              (if (f64.gt (local.get $interval) (f64.const 0))
                (then
                  ;; New deadline = now + interval_ms * 1_000_000
                  (i64.store (i32.add (local.get $base) (i32.add (i32.mul (local.get $slot) (i32.const ${ENTRY_SIZE})) (i32.const 16)))
                    (i64.add (local.get $now) (i64.trunc_f64_u (f64.mul (local.get $interval) (f64.const 1000000))))))
                (else
                  ;; Timeout: mark dead
                  (i32.store (i32.add (local.get $base) (i32.add (i32.mul (local.get $slot) (i32.const ${ENTRY_SIZE})) (i32.const 32))) (i32.const 0))
                  (global.set $__timer_count (i32.sub (global.get $__timer_count) (i32.const 1)))))
              ;; Fire closure with 0 args (shared trampoline)
              (drop (call $__invoke_closure (local.get $clos)))
              (local.set $dispatched (i32.add (local.get $dispatched) (i32.const 1)))))))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br $scan)))
    (local.get $dispatched))`

  // __timer_tick() → i32 — non-blocking tick. Dispatches due timers, returns remaining active count.
  // Called by JS runtime (host.js) via setInterval to drive timers without blocking.
  ctx.core.stdlib['__timer_tick'] = `(func $__timer_tick (export "__timer_tick") (result i32)
    (local $now i64)
    (if (i32.le_s (global.get $__timer_count) (i32.const 0))
      (then (return (i32.const 0))))
    (local.set $now (call $__time_ns))
    (drop (call $__timer_dispatch (local.get $now)))
    (global.get $__timer_count))`

  // __timer_loop() — blocking event loop. Polls clock, dispatches due timers.
  // Exits when no active timers remain (all timeouts fired, all intervals cleared).
  // Intended for CLI/wasmtime/wasmer where JS event loop is unavailable.
  ctx.core.stdlib['__timer_loop'] = `(func $__timer_loop (export "__timer_loop")
    (local $now i64)
    (local $any i32)
    (block $exit (loop $poll
      ;; Exit if no active timers
      (br_if $exit (i32.le_s (global.get $__timer_count) (i32.const 0)))
      ;; Get current time
      (local.set $now (call $__time_ns))
      ;; Dispatch due timers
      (drop (call $__timer_dispatch (local.get $now)))
      ;; Loop
      (br $poll))))`

  ctx.core.stdlib['__invoke_closure'] = invokeClosureFn(false)

  // Register globals for timer state
  // $__timer_queue: i32 — base address of timer array
  // $__timer_next_id: i32 — next timer ID
  // $__timer_count: i32 — number of active timers
  ctx.scope.globals.set('__timer_queue', '(global $__timer_queue (mut i32) (i32.const 0))')
  ctx.scope.globals.set('__timer_next_id', '(global $__timer_next_id (mut i32) (i32.const 0))')
  ctx.scope.globals.set('__timer_count', '(global $__timer_count (mut i32) (i32.const 0))')

  // Emitter: setTimeout(closure, delay) → timer_id
  ctx.core.emit['setTimeout'] = (closureExpr, delayExpr) => {
    inc('__timer_add')
    const t = tempI64('tc')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, asI64(emit(closureExpr))],
      ['call', '$__timer_add', ['local.get', `$${t}`], asF64(emit(delayExpr)), ['i32.const', 0]]], 'f64')
  }

  // Emitter: setInterval(closure, delay) → timer_id
  ctx.core.emit['setInterval'] = (closureExpr, delayExpr) => {
    inc('__timer_add')
    const t = tempI64('tc')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, asI64(emit(closureExpr))],
      ['call', '$__timer_add', ['local.get', `$${t}`], asF64(emit(delayExpr)), ['i32.const', 1]]], 'f64')
  }

  // Emitter: clearTimeout(id) → undefined
  ctx.core.emit['clearTimeout'] = (idExpr) => {
    inc('__timer_cancel')
    return typed(['call', '$__timer_cancel', asF64(emit(idExpr))], 'f64')
  }

  // Emitter: clearInterval(id) → undefined
  ctx.core.emit['clearInterval'] = (idExpr) => {
    inc('__timer_cancel')
    return typed(['call', '$__timer_cancel', asF64(emit(idExpr))], 'f64')
  }
}

const setupJsHost = (ctx) => {
  // Timer callbacks are invoked through __invoke_closure, which always pads to
  // MAX_CLOSURE_ARITY. Set the ABI floor before plan() resolves $ftN width.
  ctx.closure.floor = MAX_CLOSURE_ARITY

  // env.setTimeout's cb param is i64 (NaN-box bits) to dodge V8's f64 NaN
  // canonicalization at the wasm→JS boundary (same reason as env.print —
  // see module/console.js header). delay is a real numeric f64 (no NaN-box
  // hazard), repeat is i32, return is the timer id (numeric int).
  const needSetTimeout = () => addImportOnce(ctx, 'env', 'setTimeout',
    ['func', '$__set_timeout', ['param', 'i64'], ['param', 'f64'], ['param', 'i32'], ['result', 'f64']])
  const needClearTimeout = () => addImportOnce(ctx, 'env', 'clearTimeout',
    ['func', '$__clear_timeout', ['param', 'f64'], ['result', 'f64']])

  ctx.core.stdlib['__invoke_closure'] = invokeClosureFn(true)

  const emitSet = (closureExpr, delayExpr, repeat) => {
    needSetTimeout()
    inc('__invoke_closure')
    return typed(['call', '$__set_timeout',
      ['i64.reinterpret_f64', asF64(emit(closureExpr))],
      asF64(emit(delayExpr)),
      ['i32.const', repeat]], 'f64')
  }
  ctx.core.emit['setTimeout'] = (c, d) => emitSet(c, d, 0)
  ctx.core.emit['setInterval'] = (c, d) => emitSet(c, d, 1)

  const emitClear = (idExpr) => {
    needClearTimeout()
    return typed(['call', '$__clear_timeout', asF64(emit(idExpr))], 'f64')
  }
  ctx.core.emit['clearTimeout'] = emitClear
  ctx.core.emit['clearInterval'] = emitClear
}

export default (ctx) => {
  if (ctx.transform.host === 'wasi') setupWasi(ctx)
  else setupJsHost(ctx)
}
