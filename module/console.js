/**
 * Console + clocks module — two host-mode lowerings.
 *
 * `host: 'js'` (default): emit `env.print(val: i64, fd: i32, sep: i32)` and
 *   `env.now(clock: i32) -> f64`. The JS host (src/host.js) wires both
 *   automatically — `print` reads the NaN-boxed value via `mem.read`, so
 *   stringification happens host-side (no __ftoa / __write_str / __write_val
 *   stdlib in the binary). `sep`: 10=newline, 32=space, 0=no separator.
 *   `clock`: 0=Date.now (epoch ms), 1=performance.now (monotonic ms).
 *
 *   The val param is i64 (not f64): V8 (notably node 22 on x64) intermittently
 *   canonicalizes f64 NaN payloads at the wasm→JS boundary, collapsing the
 *   high-mantissa discriminator bits and corrupting NaN-boxed pointers. i64
 *   is integer-typed and preserves all 64 bits exactly. Host reinterprets the
 *   bits as f64 with a DataView before calling mem.read.
 *
 * `host: 'wasi'`: emit `wasi_snapshot_preview1.fd_write` + `clock_time_get`.
 *   Output runs natively on wasmtime/wasmer/deno and on browsers/Node via the
 *   tiny `jz/wasi` polyfill auto-applied by the `jz()` runtime.
 *
 * console.log/warn/error: variadic. fd=1 for log, fd=2 for warn/error.
 *
 * @module console
 */

import { typed, asF64, asI64, mkPtrIR, NULL_NAN, UNDEF_NAN } from '../src/ir.js'
import { emit } from '../src/emit.js'
import { valTypeOf, VAL, exprType } from '../src/analyze.js'
import { inc, PTR, LAYOUT } from '../src/ctx.js'

const addImportOnce = (ctx, mod, name, fn) => {
  if (ctx.module.imports.some(i => i[1] === `"${mod}"` && i[2] === `"${name}"`)) return
  ctx.module.imports.push(['import', `"${mod}"`, `"${name}"`, fn])
}

// Template-literal concat chains (`a${x}b`) lower to ['()', ['.', X, 'concat'], Y]
// in prepare. Walking left from the chain root recovers the parts in order; if the
// base is a `['str', ...]` it's a template-shaped chain (vs an arbitrary user
// .concat call). Returning the parts lets console.log skip __str_concat/__to_str
// entirely — biquad's only string churn is the perf-summary line.
const flattenTemplateConcat = (node) => {
  const parts = []
  let n = node
  while (Array.isArray(n) && n[0] === '()' && n.length === 3 &&
         Array.isArray(n[1]) && n[1][0] === '.' && n[1][2] === 'concat') {
    parts.unshift(n[2])
    n = n[1][1]
  }
  if (!(Array.isArray(n) && n[0] === 'str')) return null
  parts.unshift(n)
  return parts
}

const setupWasi = (ctx) => {
  Object.assign(ctx.core.stdlibDeps, {
    __write_val: ['__ptr_type', '__write_str', '__write_num', '__write_int', '__write_byte', '__static_str'],
    __write_num: ['__ftoa', '__write_str'],
    __write_int: ['__itoa', '__mkstr', '__write_str'],
    __write_str: ['__sso_char', '__str_len'],
    __read_stdin: ['__mkstr'],
  })

  const needFdWrite = () => addImportOnce(ctx, 'wasi_snapshot_preview1', 'fd_write',
    ['func', '$__fd_write', ['param', 'i32'], ['param', 'i32'], ['param', 'i32'], ['param', 'i32'], ['result', 'i32']])

  const needFdRead = () => addImportOnce(ctx, 'wasi_snapshot_preview1', 'fd_read',
    ['func', '$__fd_read', ['param', 'i32'], ['param', 'i32'], ['param', 'i32'], ['param', 'i32'], ['result', 'i32']])

  ctx.core.stdlib['__write_str'] = `(func $__write_str (param $fd i32) (param $ptr i64)
    (local $iov i32) (local $aux i32) (local $len i32) (local $off i32) (local $buf i32)
    (local.set $iov (call $__alloc (i32.const 12)))
    (local.set $aux (call $__ptr_aux (local.get $ptr)))
    (if (i32.and (local.get $aux) (i32.const ${LAYOUT.SSO_BIT}))
      (then
        (local.set $len (i32.and (local.get $aux) (i32.const 7)))
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
        (i32.store (local.get $iov) (call $__ptr_offset (local.get $ptr)))
        (i32.store (i32.add (local.get $iov) (i32.const 4)) (call $__str_len (local.get $ptr)))))
    (drop (call $__fd_write (local.get $fd) (local.get $iov) (i32.const 1)
      (i32.add (local.get $iov) (i32.const 8)))))`

  ctx.core.stdlib['__write_byte'] = `(func $__write_byte (param $fd i32) (param $byte i32)
    (local $iov i32)
    (local.set $iov (call $__alloc (i32.const 13)))
    (i32.store8 (i32.add (local.get $iov) (i32.const 12)) (local.get $byte))
    (i32.store (local.get $iov) (i32.add (local.get $iov) (i32.const 12)))
    (i32.store (i32.add (local.get $iov) (i32.const 4)) (i32.const 1))
    (drop (call $__fd_write (local.get $fd) (local.get $iov) (i32.const 1)
      (i32.add (local.get $iov) (i32.const 8)))))`

  ctx.core.stdlib['__write_num'] = `(func $__write_num (param $fd i32) (param $val f64)
    (call $__write_str (local.get $fd) (i64.reinterpret_f64 (call $__ftoa (local.get $val) (i32.const 0) (i32.const 0)))))`
  ctx.core.stdlib['__write_int'] = `(func $__write_int (param $fd i32) (param $val f64)
    (local $buf i32)
    (local.set $buf (call $__alloc (i32.const 12)))
    (call $__write_str (local.get $fd)
      (i64.reinterpret_f64 (call $__mkstr (local.get $buf) (call $__itoa (i32.trunc_sat_f64_s (local.get $val)) (local.get $buf))))))`
  ctx.core.stdlib['__write_val'] = `(func $__write_val (param $fd i32) (param $val i64)
    (local $type i32) (local $f f64)
    (local.set $f (f64.reinterpret_i64 (local.get $val)))
    (if (f64.eq (local.get $f) (local.get $f))
      (then (call $__write_num (local.get $fd) (local.get $f)) (return)))
    (if (i64.eq (local.get $val) (i64.const ${NULL_NAN}))
      (then (call $__write_str (local.get $fd) (i64.reinterpret_f64 (call $__static_str (i32.const 5)))) (return)))
    (if (i64.eq (local.get $val) (i64.const ${UNDEF_NAN}))
      (then (call $__write_str (local.get $fd) (i64.reinterpret_f64 (call $__static_str (i32.const 6)))) (return)))
    (local.set $type (call $__ptr_type (local.get $val)))
    (if (i32.eqz (local.get $type))
      (then (call $__write_str (local.get $fd) (i64.reinterpret_f64 (call $__static_str (i32.const 0)))) (return)))
    (if (i32.eq (local.get $type) (i32.const ${PTR.STRING}))
      (then (call $__write_str (local.get $fd) (local.get $val)) (return)))
    (call $__write_str (local.get $fd) (i64.reinterpret_f64 (call $__static_str
      (if (result i32) (i32.eq (local.get $type) (i32.const 1))
        (then (i32.const 7)) (else (i32.const 8)))))))`

  ctx.core.stdlib['__read_stdin'] = `(func $__read_stdin (result f64)
    (local $iov i32) (local $nio i32) (local $buf i32) (local $total i32) (local $n i32)
    (local.set $iov (call $__alloc (i32.const 8)))
    (local.set $nio (call $__alloc (i32.const 4)))
    (local.set $buf (call $__alloc (i32.const 65536)))
    (local.set $total (i32.const 0))
    (block $eof (loop $read
      (i32.store (local.get $iov) (i32.add (local.get $buf) (local.get $total)))
      (i32.store offset=4 (local.get $iov) (i32.sub (i32.const 65536) (local.get $total)))
      (drop (call $__fd_read (i32.const 0) (local.get $iov) (i32.const 1) (local.get $nio)))
      (local.set $n (i32.load (local.get $nio)))
      (br_if $eof (i32.eqz (local.get $n)))
      (local.set $total (i32.add (local.get $total) (local.get $n)))
      (br_if $eof (i32.ge_s (local.get $total) (i32.const 65536)))
      (br $read)))
    (call $__mkstr (local.get $buf) (local.get $total)))`

  ctx.core.emit['readStdin'] = () => {
    needFdRead()
    inc('__read_stdin')
    return typed(['call', '$__read_stdin'], 'f64')
  }

  const makeConsole = (method, fd) => {
    ctx.core.emit[`console.${method}`] = (...args) => {
      needFdWrite()
      inc('__write_byte')
      const ir = []
      const writePart = (part) => {
        if (Array.isArray(part) && part[0] === 'str' && part[1] === '') return
        const vt = valTypeOf(part)
        if (vt === VAL.STRING) {
          inc('__write_str')
          ir.push(['call', '$__write_str', ['i32.const', fd], asI64(emit(part))])
        } else if (vt === VAL.NUMBER) {
          if (exprType(part, ctx.func.locals) === 'i32') {
            inc('__write_int')
            ir.push(['call', '$__write_int', ['i32.const', fd], asF64(emit(part))])
          } else {
            inc('__write_num')
            ir.push(['call', '$__write_num', ['i32.const', fd], asF64(emit(part))])
          }
        } else {
          inc('__write_val')
          ir.push(['call', '$__write_val', ['i32.const', fd], asI64(emit(part))])
        }
      }
      for (let i = 0; i < args.length; i++) {
        if (i > 0) ir.push(['call', '$__write_byte', ['i32.const', fd], ['i32.const', 32]])
        const parts = flattenTemplateConcat(args[i])
        if (parts) for (const p of parts) writePart(p)
        else writePart(args[i])
      }
      ir.push(['call', '$__write_byte', ['i32.const', fd], ['i32.const', 10]])
      ir.push(['f64.const', 0])
      return typed(['block', ['result', 'f64'], ...ir], 'f64')
    }
  }

  makeConsole('log', 1)
  makeConsole('warn', 2)
  makeConsole('error', 2)

  const needClock = () => addImportOnce(ctx, 'wasi_snapshot_preview1', 'clock_time_get',
    ['func', '$__clock_time_get', ['param', 'i32'], ['param', 'i64'], ['param', 'i32'], ['result', 'i32']])

  ctx.core.stdlib['__time_ms'] = `(func $__time_ms (param $clock i32) (result f64)
    (drop (call $__clock_time_get (local.get $clock) (i64.const 1000) (i32.const 0)))
    (f64.div (f64.convert_i64_u (i64.load (i32.const 0))) (f64.const 1000000)))`

  ctx.core.emit['Date.now'] = () => {
    needClock()
    inc('__time_ms')
    return typed(['call', '$__time_ms', ['i32.const', 0]], 'f64')
  }
  ctx.core.emit['performance.now'] = () => {
    needClock()
    inc('__time_ms')
    return typed(['call', '$__time_ms', ['i32.const', 1]], 'f64')
  }
  ctx.core.emit['console.now'] = ctx.core.emit['Date.now']
  ctx.core.emit['console.perfNow'] = ctx.core.emit['performance.now']
}

const setupJsHost = (ctx) => {
  const needPrint = () => addImportOnce(ctx, 'env', 'print',
    ['func', '$__print', ['param', 'i64'], ['param', 'i32'], ['param', 'i32']])
  const needNow = () => addImportOnce(ctx, 'env', 'now',
    ['func', '$__now', ['param', 'i32'], ['result', 'f64']])

  // Empty SSO string ("") for zero-arg console.log() — host reads as "".
  const emptyStr = () => mkPtrIR(PTR.STRING, LAYOUT.SSO_BIT, 0)
  const asI64Bits = (e) => ['i64.reinterpret_f64', asF64(emit(e))]

  const makeConsole = (method, fd) => {
    ctx.core.emit[`console.${method}`] = (...args) => {
      needPrint()
      // Each segment carries its trailing separator (0=none, 32=space, 10=newline).
      // Template-concat chains (`a${x}b`) flatten to per-`${}` segments — the host
      // stringifies, so jz drops __str_concat/__to_str entirely.
      const segments = []
      for (let i = 0; i < args.length; i++) {
        const before = segments.length
        const flat = flattenTemplateConcat(args[i])
        const sub = flat || [args[i]]
        for (const p of sub) {
          if (Array.isArray(p) && p[0] === 'str' && p[1] === '') continue
          segments.push({ expr: asI64Bits(p), sep: 0 })
        }
        // Empty arg (`console.log('', 'a')`) still needs to mark its boundary
        // so the inter-arg space lands in the right place.
        if (segments.length === before) segments.push({ expr: ['i64.reinterpret_f64', emptyStr()], sep: 0 })
        if (i < args.length - 1) segments[segments.length - 1].sep = 32
      }
      const ir = []
      if (segments.length === 0) {
        ir.push(['call', '$__print', ['i64.reinterpret_f64', emptyStr()], ['i32.const', fd], ['i32.const', 10]])
      } else {
        segments[segments.length - 1].sep = 10
        for (const { expr, sep } of segments) {
          ir.push(['call', '$__print', expr, ['i32.const', fd], ['i32.const', sep]])
        }
      }
      ir.push(['f64.const', 0])
      return typed(['block', ['result', 'f64'], ...ir], 'f64')
    }
  }

  makeConsole('log', 1)
  makeConsole('warn', 2)
  makeConsole('error', 2)

  ctx.core.emit['Date.now'] = () => {
    needNow()
    return typed(['call', '$__now', ['i32.const', 0]], 'f64')
  }
  ctx.core.emit['performance.now'] = () => {
    needNow()
    return typed(['call', '$__now', ['i32.const', 1]], 'f64')
  }
  ctx.core.emit['console.now'] = ctx.core.emit['Date.now']
  ctx.core.emit['console.perfNow'] = ctx.core.emit['performance.now']
}

export default (ctx) => {
  if (ctx.transform.host === 'wasi') setupWasi(ctx)
  else setupJsHost(ctx)
}
