/**
 * fs — basic file IO over WASI (host:'wasi' only).
 *
 * `fs.read(path)` → string, `fs.write(path, data)` → undefined. Synchronous by
 * construction — WASI preview1 IS synchronous, so no event-loop breach. Paths
 * resolve against the FIRST PREOPEN (fd 3, the wasi convention): run under
 * wasmtime/node:wasi with a preopened directory. jz strings are raw UTF-8
 * bytes, so read/write are binary-lossless (a byte is `s.charCodeAt(i)`).
 *
 * Failures throw the WASI errno as a number (e.g. 44 = NOENT) — jz errors are
 * values; catch and inspect. host:'js' rejects at compile with a wiring hint.
 *
 * @module fs
 */

import { typed, asI64 } from '../src/ir.js'
import { emit, hostImport } from '../src/bridge.js'
import { inc, err, LAYOUT } from '../src/ctx.js'

const setupWasi = (ctx) => {
  const needPathOpen = () => hostImport('wasi_snapshot_preview1', 'path_open',
    ['func', '$__path_open', ['param', 'i32'], ['param', 'i32'], ['param', 'i32'], ['param', 'i32'], ['param', 'i32'], ['param', 'i64'], ['param', 'i64'], ['param', 'i32'], ['param', 'i32'], ['result', 'i32']])
  const needFdRead = () => hostImport('wasi_snapshot_preview1', 'fd_read',
    ['func', '$__fd_read', ['param', 'i32'], ['param', 'i32'], ['param', 'i32'], ['param', 'i32'], ['result', 'i32']])
  const needFdWrite = () => hostImport('wasi_snapshot_preview1', 'fd_write',
    ['func', '$__fd_write', ['param', 'i32'], ['param', 'i32'], ['param', 'i32'], ['param', 'i32'], ['result', 'i32']])
  const needFdClose = () => hostImport('wasi_snapshot_preview1', 'fd_close',
    ['func', '$__fd_close', ['param', 'i32'], ['result', 'i32']])
  const needFilestat = () => hostImport('wasi_snapshot_preview1', 'fd_filestat_get',
    ['func', '$__fd_filestat_get', ['param', 'i32'], ['param', 'i32'], ['result', 'i32']])

  // Stage a jz string's bytes into linear memory → packed (ptr<<32)|len in an
  // i64 (SSO strings live in the box, heap strings in place — no copy).
  ctx.core.stdlib['__fs_path'] = `(func $__fs_path (param $str i64) (result i64)
    (local $aux i32) (local $len i32) (local $off i32) (local $buf i32)
    (local.set $aux (call $__ptr_aux (local.get $str)))
    (if (i32.and (local.get $aux) (i32.const ${LAYOUT.SSO_BIT}))
      (then
        (local.set $len (i32.and (i32.shr_u (local.get $aux) (i32.const 10)) (i32.const 7)))
        (local.set $buf (call $__alloc (local.get $len)))
        (local.set $off (i32.const 0))
        (block $done (loop $loop
          (br_if $done (i32.ge_s (local.get $off) (local.get $len)))
          (i32.store8 (i32.add (local.get $buf) (local.get $off))
            (call $__sso_char (local.get $str) (local.get $off)))
          (local.set $off (i32.add (local.get $off) (i32.const 1)))
          (br $loop))))
      (else
        (local.set $buf (call $__ptr_offset (local.get $str)))
        (local.set $len (call $__str_len (local.get $str)))))
    (i64.or (i64.shl (i64.extend_i32_u (local.get $buf)) (i64.const 32))
      (i64.extend_i32_u (local.get $len))))`

  // read: path_open(preopen fd 3) → filestat size → exact alloc → read loop → string
  ctx.core.stdlib['__fs_read'] = `(func $__fs_read (param $path i64) (result f64)
    (local $pl i64) (local $scratch i32) (local $fd i32) (local $e i32)
    (local $size i32) (local $buf i32) (local $total i32) (local $n i32)
    (local.set $pl (call $__fs_path (local.get $path)))
    (local.set $scratch (call $__alloc (i32.const 64)))
    ;; rights: FD_READ(2) | FD_FILESTAT_GET(1<<21)
    (local.set $e (call $__path_open (i32.const 3) (i32.const 1)
      (i32.wrap_i64 (i64.shr_u (local.get $pl) (i64.const 32)))
      (i32.wrap_i64 (i64.and (local.get $pl) (i64.const 0xffffffff)))
      (i32.const 0) (i64.const ${2 | (1 << 21)}) (i64.const 0) (i32.const 0)
      (local.get $scratch)))
    (if (local.get $e) (then (throw $__jz_err (f64.convert_i32_u (local.get $e)))))
    (local.set $fd (i32.load (local.get $scratch)))
    (local.set $e (call $__fd_filestat_get (local.get $fd) (local.get $scratch)))
    (if (local.get $e) (then
      (drop (call $__fd_close (local.get $fd)))
      (throw $__jz_err (f64.convert_i32_u (local.get $e)))))
    ;; filestat.size at offset 32 (u64; jz caps at i32 addressable)
    (local.set $size (i32.wrap_i64 (i64.load offset=32 (local.get $scratch))))
    (local.set $buf (call $__alloc (local.get $size)))
    (local.set $total (i32.const 0))
    (block $eof (loop $read
      (br_if $eof (i32.ge_u (local.get $total) (local.get $size)))
      (i32.store (local.get $scratch) (i32.add (local.get $buf) (local.get $total)))
      (i32.store offset=4 (local.get $scratch) (i32.sub (local.get $size) (local.get $total)))
      (local.set $e (call $__fd_read (local.get $fd) (local.get $scratch) (i32.const 1)
        (i32.add (local.get $scratch) (i32.const 8))))
      (if (local.get $e) (then
        (drop (call $__fd_close (local.get $fd)))
        (throw $__jz_err (f64.convert_i32_u (local.get $e)))))
      (local.set $n (i32.load offset=8 (local.get $scratch)))
      (br_if $eof (i32.eqz (local.get $n)))
      (local.set $total (i32.add (local.get $total) (local.get $n)))
      (br $read)))
    (drop (call $__fd_close (local.get $fd)))
    (call $__mkstr (local.get $buf) (local.get $total)))`

  // write: path_open CREAT|TRUNC → fd_write loop → close
  ctx.core.stdlib['__fs_write'] = `(func $__fs_write (param $path i64) (param $data i64)
    (local $pl i64) (local $dl i64) (local $scratch i32) (local $fd i32) (local $e i32)
    (local $buf i32) (local $len i32) (local $total i32) (local $n i32)
    (local.set $pl (call $__fs_path (local.get $path)))
    (local.set $dl (call $__fs_path (local.get $data)))
    (local.set $scratch (call $__alloc (i32.const 16)))
    ;; oflags: CREAT(1)|TRUNC(8); rights: FD_WRITE(64)
    (local.set $e (call $__path_open (i32.const 3) (i32.const 1)
      (i32.wrap_i64 (i64.shr_u (local.get $pl) (i64.const 32)))
      (i32.wrap_i64 (i64.and (local.get $pl) (i64.const 0xffffffff)))
      (i32.const 9) (i64.const 64) (i64.const 0) (i32.const 0)
      (local.get $scratch)))
    (if (local.get $e) (then (throw $__jz_err (f64.convert_i32_u (local.get $e)))))
    (local.set $fd (i32.load (local.get $scratch)))
    (local.set $buf (i32.wrap_i64 (i64.shr_u (local.get $dl) (i64.const 32))))
    (local.set $len (i32.wrap_i64 (i64.and (local.get $dl) (i64.const 0xffffffff))))
    (local.set $total (i32.const 0))
    (block $done (loop $write
      (br_if $done (i32.ge_u (local.get $total) (local.get $len)))
      (i32.store (local.get $scratch) (i32.add (local.get $buf) (local.get $total)))
      (i32.store offset=4 (local.get $scratch) (i32.sub (local.get $len) (local.get $total)))
      (local.set $e (call $__fd_write (local.get $fd) (local.get $scratch) (i32.const 1)
        (i32.add (local.get $scratch) (i32.const 8))))
      (if (local.get $e) (then
        (drop (call $__fd_close (local.get $fd)))
        (throw $__jz_err (f64.convert_i32_u (local.get $e)))))
      (local.set $n (i32.load offset=8 (local.get $scratch)))
      (br_if $done (i32.eqz (local.get $n)))
      (local.set $total (i32.add (local.get $total) (local.get $n)))
      (br $write)))
    (drop (call $__fd_close (local.get $fd))))`

  ctx.core.emit['fs.read'] = (path) => {
    needPathOpen(); needFdRead(); needFdClose(); needFilestat()
    inc('__fs_path'); inc('__fs_read')
    return typed(['call', '$__fs_read', asI64(emit(path))], 'f64')
  }
  ctx.core.emit['fs.write'] = (path, data) => {
    needPathOpen(); needFdWrite(); needFdClose()
    inc('__fs_path'); inc('__fs_write')
    return ['call', '$__fs_write', asI64(emit(path)), asI64(emit(data))]
  }
}

export default (ctx) => {
  if (ctx.transform.host === 'wasi') setupWasi(ctx)
  else {
    const reject = (m) => () => err(`fs.${m} needs a WASI host — compile with host:'wasi' (CLI --host wasi), or wire your own file access via {imports}`)
    ctx.core.emit['fs.read'] = reject('read')
    ctx.core.emit['fs.write'] = reject('write')
  }
}
