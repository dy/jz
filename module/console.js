/**
 * WASI module — console.log/warn/error via fd_write.
 *
 * Imports wasi_snapshot_preview1.fd_write — standard WASI Preview 1.
 * Output .wasm runs natively on wasmtime/wasmer/deno.
 * For browser/Node, use jz/wasi polyfill.
 *
 * console.log(a, b, c) → serialize each arg to string bytes,
 *   write space-separated to fd=1, append newline.
 * console.warn/error → fd=2.
 *
 * @module wasi
 */

import { emit, typed, asF64 } from '../src/compile.js'
import { ctx, inc, PTR } from '../src/ctx.js'

export default () => {

  // Import fd_write from WASI
  ctx.imports.push(
    ['import', '"wasi_snapshot_preview1"', '"fd_write"',
      ['func', '$__fd_write', ['param', 'i32'], ['param', 'i32'], ['param', 'i32'], ['param', 'i32'], ['result', 'i32']]])

  // __write_str(fd: i32, ptr: f64) — write a NaN-boxed string to fd via iov
  // Handles both SSO and heap strings
  ctx.stdlib['__write_str'] = `(func $__write_str (param $fd i32) (param $ptr f64)
    (local $iov i32) (local $type i32) (local $len i32) (local $off i32) (local $buf i32)
    ;; Allocate iov (8 bytes: ptr + len) + nwritten (4 bytes)
    (local.set $iov (call $__alloc (i32.const 12)))
    (local.set $type (call $__ptr_type (local.get $ptr)))
    (if (i32.eq (local.get $type) (i32.const ${PTR.SSO}))
      (then
        ;; SSO: unpack chars to memory buffer, then write
        (local.set $len (call $__ptr_aux (local.get $ptr)))
        (local.set $buf (call $__alloc (local.get $len)))
        (local.set $off (i32.const 0))
        (block $done (loop $loop
          (br_if $done (i32.ge_s (local.get $off) (local.get $len)))
          (i32.store8 (i32.add (local.get $buf) (local.get $off))
            (call $__sso_char (local.get $ptr) (local.get $off)))
          (local.set $off (i32.add (local.get $off) (i32.const 1)))
          (br $loop)))
        (i32.store (local.get $iov) (local.get $buf))
        (i32.store (i32.add (local.get $iov) (i32.const 4)) (local.get $len)))
      (else
        ;; Heap string: offset points directly to char data
        (i32.store (local.get $iov) (call $__ptr_offset (local.get $ptr)))
        (i32.store (i32.add (local.get $iov) (i32.const 4)) (call $__str_len (local.get $ptr)))))
    (drop (call $__fd_write (local.get $fd) (local.get $iov) (i32.const 1)
      (i32.add (local.get $iov) (i32.const 8)))))`

  // __write_byte(fd: i32, byte: i32) — write a single byte (space, newline)
  ctx.stdlib['__write_byte'] = `(func $__write_byte (param $fd i32) (param $byte i32)
    (local $iov i32)
    (local.set $iov (call $__alloc (i32.const 13)))
    (i32.store8 (i32.add (local.get $iov) (i32.const 12)) (local.get $byte))
    (i32.store (local.get $iov) (i32.add (local.get $iov) (i32.const 12)))
    (i32.store (i32.add (local.get $iov) (i32.const 4)) (i32.const 1))
    (drop (call $__fd_write (local.get $fd) (local.get $iov) (i32.const 1)
      (i32.add (local.get $iov) (i32.const 8)))))`

  // __write_num(fd: i32, val: f64) — convert number to string, write to fd
  ctx.stdlib['__write_num'] = `(func $__write_num (param $fd i32) (param $val f64)
    (call $__write_str (local.get $fd) (call $__ftoa (local.get $val) (i32.const 0) (i32.const 0))))`

  // __write_val(fd: i32, val: f64) — write any value, auto-detecting type
  ctx.stdlib['__write_val'] = `(func $__write_val (param $fd i32) (param $val f64)
    (local $type i32)
    ;; Not NaN → plain number
    (if (f64.eq (local.get $val) (local.get $val))
      (then (call $__write_num (local.get $fd) (local.get $val)) (return)))
    ;; NaN: check if it's a pointer (type > 0) or plain NaN (type = 0)
    (local.set $type (call $__ptr_type (local.get $val)))
    (if (i32.eqz (local.get $type))
      (then (call $__write_str (local.get $fd) (call $__static_str (i32.const 0))) (return)))
    ;; String pointer
    (if (i32.or (i32.eq (local.get $type) (i32.const ${PTR.STRING}))
                (i32.eq (local.get $type) (i32.const ${PTR.SSO})))
      (then (call $__write_str (local.get $fd) (local.get $val)) (return)))
    ;; Array/Object placeholder
    (call $__write_str (local.get $fd) (call $__static_str
      (if (result i32) (i32.eq (local.get $type) (i32.const 1))
        (then (i32.const 7)) (else (i32.const 8))))))`

  // console.log(...args) — variadic, each arg separated by space, followed by newline
  const makeConsole = (method, fd) => {
    ctx.emit[`console.${method}`] = (...args) => {
      inc('__write_val')
      const ir = []
      for (let i = 0; i < args.length; i++) {
        if (i > 0) ir.push(['call', '$__write_byte', ['i32.const', fd], ['i32.const', 32]])  // space
        ir.push(['call', '$__write_val', ['i32.const', fd], asF64(emit(args[i]))])
      }
      ir.push(['call', '$__write_byte', ['i32.const', fd], ['i32.const', 10]])  // newline
      ir.push(['f64.const', 0])  // return undefined
      return typed(['block', ['result', 'f64'], ...ir], 'f64')
    }
  }

  makeConsole('log', 1)
  makeConsole('warn', 2)
  makeConsole('error', 2)

  // === Date.now / performance.now via WASI clock_time_get ===

  ctx.imports.push(
    ['import', '"wasi_snapshot_preview1"', '"clock_time_get"',
      ['func', '$__clock_time_get', ['param', 'i32'], ['param', 'i64'], ['param', 'i32'], ['result', 'i32']]])

  // __time_ms(clock_id) → f64 milliseconds
  // clock_time_get writes i64 nanoseconds to memory, we convert to f64 ms
  ctx.stdlib['__time_ms'] = `(func $__time_ms (param $clock i32) (result f64)
    (drop (call $__clock_time_get (local.get $clock) (i64.const 1000) (i32.const 0)))
    (f64.div (f64.convert_i64_u (i64.load (i32.const 0))) (f64.const 1000000)))`

  ctx.emit['Date.now'] = () => {
    inc('__time_ms')
    return typed(['call', '$__time_ms', ['i32.const', 0]], 'f64')  // clock 0 = realtime
  }

  ctx.emit['performance.now'] = () => {
    inc('__time_ms')
    return typed(['call', '$__time_ms', ['i32.const', 1]], 'f64')  // clock 1 = monotonic
  }
}
