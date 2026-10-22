/**
 * fs — basic file IO over WASI (host:'wasi' only).
 *
 * `fs.read(path)` → string, `fs.write(path, data)` → undefined. Synchronous by
 * construction — WASI preview1 IS synchronous, so no event-loop breach. Paths
 * resolve against the FIRST PREOPEN (fd 3, the wasi convention): run under
 * wasmtime/node:wasi with a preopened directory. Paths and file contents use UTF-8 at the WASI boundary.
 *
 * `fs.readSync(fd, buffer[, offset[, length]])` → bytes read (0 at EOF) and
 * `fs.writeSync(fd, buffer | string[, offset[, length]])` → bytes written move raw
 * bytes through a descriptor, as Node's do: stdin is fd 0, stdout 1, stderr 2.
 * A read is one `fd_read` and may return fewer bytes than asked; a write loops
 * until every byte is out. offset and length count bytes of the view.
 *
 * Failures throw the WASI errno as a number (e.g. 44 = NOENT) — jz errors are
 * values; catch and inspect. host:'js' rejects at compile with a wiring hint.
 *
 * @module fs
 */

import { typed, asF64, asI64, asI32, asI32Sat, isNullishLit } from '../src/ir.js'
import { emit, hostImport } from '../src/bridge.js'
import { inc, err, PTR } from '../src/ctx.js'
import { dataAlign, dataLen, dataPush } from '../src/static-data.js'
import { errorCodeLiteral, ERR } from '../err-codes.js'

const raise = (code) => `(global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${errorCodeLiteral(code)}))) (throw $__jz_err (f64.const ${errorCodeLiteral(code)}))`
const raiseErrno = `(global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.convert_i32_u (local.get $e)))) (throw $__jz_err (f64.convert_i32_u (local.get $e)))`

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

  // Encode text for WASI → packed (ptr<<32)|byteLength in an i64.
  ctx.core.stdlib['__fs_path'] = `(func $__fs_path (param $str i64) (result i64)
    (local $cap i32) (local $buf i32) (local $len i32)
    (local.set $cap (i32.mul (call $__str_length (local.get $str)) (i32.const 3)))
    (local.set $buf (call $__alloc (local.get $cap)))
    (local.set $len (i32.wrap_i64 (i64.shr_u (call $__utf8_encode (local.get $str) (local.get $buf) (local.get $cap)) (i64.const 32))))
    (i64.or (i64.shl (i64.extend_i32_u (local.get $buf)) (i64.const 32)) (i64.extend_i32_u (local.get $len))))`

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
    (if (local.get $e) (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.convert_i32_u (local.get $e)))) (throw $__jz_err (f64.convert_i32_u (local.get $e)))))
    (local.set $fd (i32.load (local.get $scratch)))
    (local.set $e (call $__fd_filestat_get (local.get $fd) (local.get $scratch)))
    (if (local.get $e) (then
      (drop (call $__fd_close (local.get $fd)))
      (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.convert_i32_u (local.get $e)))) (throw $__jz_err (f64.convert_i32_u (local.get $e)))))
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
        (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.convert_i32_u (local.get $e)))) (throw $__jz_err (f64.convert_i32_u (local.get $e)))))
      (local.set $n (i32.load offset=8 (local.get $scratch)))
      (br_if $eof (i32.eqz (local.get $n)))
      (local.set $total (i32.add (local.get $total) (local.get $n)))
      (br $read)))
    (drop (call $__fd_close (local.get $fd)))
    (call $__utf8_decode (local.get $buf) (local.get $total) (i32.const 1)))`

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
    (if (local.get $e) (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.convert_i32_u (local.get $e)))) (throw $__jz_err (f64.convert_i32_u (local.get $e)))))
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
        (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.convert_i32_u (local.get $e)))) (throw $__jz_err (f64.convert_i32_u (local.get $e)))))
      (local.set $n (i32.load offset=8 (local.get $scratch)))
      (br_if $done (i32.eqz (local.get $n)))
      (local.set $total (i32.add (local.get $total) (local.get $n)))
      (br $write)))
    (drop (call $__fd_close (local.get $fd))))`

  ctx.core.emit['fs.read'] = (path) => {
    needPathOpen(); needFdRead(); needFdClose(); needFilestat()
    ctx.module.include('string')
    inc('__fs_path', '__utf8_encode', '__utf8_decode'); inc('__fs_read')
    return typed(['call', '$__fs_read', asI64(emit(path))], 'f64')
  }
  ctx.core.emit['fs.write'] = (path, data) => {
    needPathOpen(); needFdWrite(); needFdClose()
    ctx.module.include('string')
    inc('__fs_path', '__utf8_encode'); inc('__fs_write')
    return ['call', '$__fs_write', asI64(emit(path)), asI64(emit(data))]
  }

  // The bytes a call moves: [offset, offset+length) of a typed array's view, or a
  // string's UTF-8 when $text; $rest takes the length to the end. Packed
  // (ptr<<32)|len, validated as Node validates (an empty span skips the offset bound).
  ctx.core.stdlib['__fs_span'] = `(func $__fs_span (param $v i64) (param $text i32) (param $off i32) (param $len i32) (param $rest i32) (result i64)
    (local $t i32) (local $b i64) (local $bl i32)
    (local.set $t (call $__ptr_type (local.get $v)))
    (if (i32.eq (local.get $t) (i32.const ${PTR.TYPED}))
      (then (local.set $b (i64.or
        (i64.shl (i64.extend_i32_u (call $__typed_data (local.get $v))) (i64.const 32))
        (i64.extend_i32_u (i32.shl (call $__len (local.get $v))
          (call $__typed_shift (i32.and (call $__ptr_aux (local.get $v)) (i32.const 7))))))))
      (else (if (i32.and (local.get $text) (i32.eq (local.get $t) (i32.const ${PTR.STRING})))
        (then (local.set $b (call $__fs_path (local.get $v))))
        (else ${raise(ERR.FS_BUFFER)}))))
    (local.set $bl (i32.wrap_i64 (local.get $b)))
    (if (local.get $rest) (then (local.set $len (i32.sub (local.get $bl) (local.get $off)))))
    (if (i32.or (i32.lt_s (local.get $off) (i32.const 0))
          (i32.or (i32.lt_s (local.get $len) (i32.const 0))
            (i32.and (i32.ne (local.get $len) (i32.const 0))
              (i32.gt_u (i32.add (local.get $off) (local.get $len)) (local.get $bl)))))
      (then ${raise(ERR.FS_RANGE)}))
    (i64.or
      (i64.shl (i64.extend_i32_u (i32.add (i32.wrap_i64 (i64.shr_u (local.get $b) (i64.const 32))) (local.get $off))) (i64.const 32))
      (i64.extend_i32_u (local.get $len))))`

  // One iovec in the static pool: a read or write per call allocates nothing,
  // so a host loop serving messages forever holds its memory flat.
  const iov = () => { dataAlign(4); const off = dataLen(); dataPush(new Uint8Array(12)); return off }

  ctx.core.stdlib['__fs_read_sync'] = () => {
    const io = iov()
    return `(func $__fs_read_sync (param $fd i32) (param $buf i64) (param $off i32) (param $len i32) (param $rest i32) (result f64)
    (local $s i64) (local $e i32)
    (local.set $s (call $__fs_span (local.get $buf) (i32.const 0) (local.get $off) (local.get $len) (local.get $rest)))
    (i32.store (i32.const ${io}) (i32.wrap_i64 (i64.shr_u (local.get $s) (i64.const 32))))
    (i32.store (i32.const ${io + 4}) (i32.wrap_i64 (local.get $s)))
    (local.set $e (call $__fd_read (local.get $fd) (i32.const ${io}) (i32.const 1) (i32.const ${io + 8})))
    (if (local.get $e) (then ${raiseErrno}))
    (f64.convert_i32_u (i32.load (i32.const ${io + 8}))))`
  }

  ctx.core.stdlib['__fs_write_sync'] = () => {
    const io = iov()
    return `(func $__fs_write_sync (param $fd i32) (param $buf i64) (param $text i32) (param $off i32) (param $len i32) (param $rest i32) (result f64)
    (local $s i64) (local $p i32) (local $n i32) (local $total i32) (local $e i32)
    (local.set $s (call $__fs_span (local.get $buf) (local.get $text) (local.get $off) (local.get $len) (local.get $rest)))
    (local.set $p (i32.wrap_i64 (i64.shr_u (local.get $s) (i64.const 32))))
    (local.set $n (i32.wrap_i64 (local.get $s)))
    (block $done (loop $write
      (br_if $done (i32.ge_u (local.get $total) (local.get $n)))
      (i32.store (i32.const ${io}) (i32.add (local.get $p) (local.get $total)))
      (i32.store (i32.const ${io + 4}) (i32.sub (local.get $n) (local.get $total)))
      (local.set $e (call $__fd_write (local.get $fd) (i32.const ${io}) (i32.const 1) (i32.const ${io + 8})))
      (if (local.get $e) (then ${raiseErrno}))
      (br_if $done (i32.eqz (i32.load (i32.const ${io + 8}))))
      (local.set $total (i32.add (local.get $total) (i32.load (i32.const ${io + 8}))))
      (br $write)))
    (f64.convert_i32_u (local.get $total)))`
  }

  // Node's positional forms. readSync(fd, buffer[, offset, length]): Node reads a
  // lone third argument as an options object. writeSync(fd, buffer[, offset[, length]])
  // or writeSync(fd, string): Node reads a string's third argument as a position.
  // Calls go where the descriptor stands, so an explicit position is refused.
  const num = (x) => isNullishLit(x) ? ['i32.const', 0] : asI32Sat(asF64(emit(x)))
  const given = (x) => x != null && !isNullishLit(x)
  const syncArgs = (m, a) => {
    const [fd, buf, off, len, pos] = a
    if (buf == null) err(`fs.${m}(fd, buffer) needs a buffer`)
    if (a.length > 5 || given(pos)) err(`fs.${m}: a position is not supported; the call reads and writes at the descriptor's current offset`)
    if (m === 'readSync' && off != null && len == null) err(`fs.readSync(fd, buffer, offset) is an options call in Node; pass (fd, buffer, offset, length)`)
    // An absent offset, or writeSync's absent length, runs to the end; readSync's
    // explicit length ToInt32s (undefined reads 0 bytes), as Node's do.
    const toEnd = off == null || m === 'writeSync' && !given(len)
    const args = [asI32(asF64(emit(fd))), asI64(emit(buf))]
    if (m === 'writeSync') args.push(['i32.const', off == null ? 1 : 0])
    args.push(off == null ? ['i32.const', 0] : num(off), toEnd ? ['i32.const', 0] : num(len), ['i32.const', toEnd ? 1 : 0])
    return args
  }
  const spanDeps = ['__fs_span', '__ptr_type', '__ptr_aux', '__len', '__typed_shift', '__typed_data']
  ctx.core.emit['fs.readSync'] = (...a) => {
    needFdRead()
    inc(...spanDeps, '__fs_read_sync')
    return typed(['call', '$__fs_read_sync', ...syncArgs('readSync', a)], 'f64')
  }
  ctx.core.emit['fs.writeSync'] = (...a) => {
    needFdWrite()
    ctx.module.include('string')
    inc(...spanDeps, '__fs_path', '__utf8_encode', '__fs_write_sync')
    return typed(['call', '$__fs_write_sync', ...syncArgs('writeSync', a)], 'f64')
  }
}

export default (ctx) => {
  if (ctx.transform.targetProfile.wasiShims) setupWasi(ctx)
  else {
    const reject = (m) => () => err(`fs.${m} needs a WASI host — compile with host:'wasi' (CLI --host wasi), or wire your own file access via {imports}`)
    ctx.core.emit['fs.read'] = reject('read')
    ctx.core.emit['fs.write'] = reject('write')
    ctx.core.emit['fs.readSync'] = reject('readSync')
    ctx.core.emit['fs.writeSync'] = reject('writeSync')
  }
}
