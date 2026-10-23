/**
 * fs — basic file IO over WASI (host:'wasi' only).
 *
 * `fs.read(path)` → string, `fs.write(path, data)` → undefined. Synchronous by
 * construction — WASI preview1 IS synchronous, so no event-loop breach. Paths
 * resolve against the FIRST PREOPEN (fd 3, the wasi convention): run under
 * wasmtime/node:wasi with a preopened directory. Paths and file contents use UTF-8 at the WASI boundary.
 *
 * `fs.readSync(fd, buffer[, options | offset, length])` → bytes read (0 at EOF) and
 * `fs.writeSync(fd, buffer[, options | offset[, length]])`, `fs.writeSync(fd, string)`
 * → bytes written move raw bytes through a descriptor, as Node's do: stdin is fd 0,
 * stdout 1, stderr 2; options are `{ offset, length }`. A read is one `fd_read` and
 * may return fewer bytes than asked; a write loops until every byte is out. offset
 * and length count bytes of the view. `import { readSync } from 'node:fs'` works too.
 *
 * Failures throw the WASI errno as a number (e.g. 44 = NOENT) — jz errors are
 * values; catch and inspect. host:'js' rejects at compile with a wiring hint.
 *
 * @module fs
 */

import { typed, asF64, asI64, asI32, isNullishLit, temp, toInt32, toNumF64, undefExpr, NULL_NAN, UNDEF_NAN } from '../src/ir.js'
import { emit, hostImport, storedValue } from '../src/bridge.js'
import { inc, err, PTR, LAYOUT } from '../src/ctx.js'
import { ACCESSOR_GET, ACCESSOR_SET, isLiteralStr, isUndefinedLiteral } from '../src/ast.js'
import { valTypeOf } from '../src/kind.js'
import { VAL } from '../src/reps.js'
import { dataAlign, dataLen, dataPush } from '../src/static-data.js'
import { i64Hex, nanPrefixHex, nanPrefixMaskHex } from '../layout.js'
import { errorCodeLiteral, ERR } from '../err-codes.js'

const TAG_AUX = i64Hex((BigInt(LAYOUT.TAG_MASK) << BigInt(LAYOUT.TAG_SHIFT)) | (BigInt(LAYOUT.AUX_MASK) << BigInt(LAYOUT.AUX_SHIFT)))

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

  // Node's validation (lib/fs.js readSync/writeSync, internal/fs/utils.js), in its
  // order and with its error classes. A value with a pointer tag is a NaN box, so
  // a Number never reads as a buffer; a box with a tag or aux is not a Number.
  const isBox = (b) => `(i64.eq (i64.and ${b} (i64.const ${nanPrefixMaskHex()})) (i64.const ${nanPrefixHex()}))`
  const notNumber = (b) => `(i32.and ${isBox(b)} (i64.ne (i64.and ${b} (i64.const ${TAG_AUX})) (i64.const 0)))`

  // A typed array's view, packed (data<<32)|byteLength; any other value is Node's TypeError.
  ctx.core.stdlib['__fs_view'] = () => `(func $__fs_view (param $v i64) (result i64)
    (if (i32.eqz (i32.and ${isBox('(local.get $v)')} (i32.eq (call $__ptr_type (local.get $v)) (i32.const ${PTR.TYPED}))))
      (then ${raise(ERR.FS_BUFFER)}))
    (i64.or (i64.shl (i64.extend_i32_u (call $__typed_data (local.get $v))) (i64.const 32))
      (i64.extend_i32_u (i32.shl (call $__len (local.get $v))
        (call $__typed_shift (i32.and (call $__ptr_aux (local.get $v)) (i32.const 7)))))))`

  // validateInteger(offset, 'offset', 0): undefined is 0 (null too where $nullish,
  // writeSync's `offset == null`), another non-Number a TypeError, a fraction, NaN,
  // a negative or a value past 2^53 - 1 a RangeError.
  ctx.core.stdlib['__fs_offset'] = () => `(func $__fs_offset (param $v f64) (param $nullish i32) (result f64)
    (local $b i64)
    (local.set $b (i64.reinterpret_f64 (local.get $v)))
    (if (i32.or (i64.eq (local.get $b) (i64.const ${UNDEF_NAN}))
          (i32.and (local.get $nullish) (i64.eq (local.get $b) (i64.const ${NULL_NAN}))))
      (then (return (f64.const 0))))
    (if ${notNumber('(local.get $b)')} (then ${raise(ERR.FS_OFFSET)}))
    (if (i32.eqz (i32.and (f64.eq (f64.trunc (local.get $v)) (local.get $v))
          (i32.and (f64.ge (local.get $v) (f64.const 0)) (f64.le (local.get $v) (f64.const 9007199254740991)))))
      (then ${raise(ERR.FS_RANGE)}))
    (local.get $v))`

  // One iovec in the static pool: a read or write per call allocates nothing,
  // so a host loop serving messages forever holds its memory flat.
  const iov = () => { dataAlign(4); const off = dataLen(); dataPush(new Uint8Array(12)); return off }

  // readSync: $len is the ToInt32'd length, $rest takes byteLength - offset. A zero
  // length reads nothing and answers 0 before the buffer's size is asked.
  ctx.core.stdlib['__fs_read_sync'] = () => {
    const io = iov()
    return `(func $__fs_read_sync (param $fd i32) (param $buf i64) (param $off f64) (param $len i32) (param $rest i32) (result f64)
    (local $view i64) (local $bl f64) (local $e i32)
    (local.set $view (call $__fs_view (local.get $buf)))
    (local.set $off (call $__fs_offset (local.get $off) (i32.const 0)))
    (local.set $bl (f64.convert_i32_u (i32.wrap_i64 (local.get $view))))
    (if (local.get $rest) (then (local.set $len (i32.wrap_i64 (i64.trunc_sat_f64_s (f64.sub (local.get $bl) (local.get $off)))))))
    (if (i32.eqz (local.get $len)) (then (return (f64.const 0))))
    (if (f64.eq (local.get $bl) (f64.const 0)) (then ${raise(ERR.FS_EMPTY)}))
    (if (i32.or (i32.lt_s (local.get $len) (i32.const 0))
          (f64.gt (f64.add (local.get $off) (f64.convert_i32_s (local.get $len))) (local.get $bl)))
      (then ${raise(ERR.FS_RANGE)}))
    (i32.store (i32.const ${io}) (i32.add (i32.wrap_i64 (i64.shr_u (local.get $view) (i64.const 32))) (i32.trunc_f64_u (local.get $off))))
    (i32.store (i32.const ${io + 4}) (local.get $len))
    (local.set $e (call $__fd_read (local.get $fd) (i32.const ${io}) (i32.const 1) (i32.const ${io + 8})))
    (if (local.get $e) (then ${raiseErrno}))
    (f64.convert_i32_u (i32.load (i32.const ${io + 8}))))`
  }

  // writeSync: a length that is no Number, or $rest, runs to the end. A string is
  // written whole as UTF-8; its third argument is a position, so only null,
  // undefined or the options object ($opts, which Node ignores there) pass.
  ctx.core.stdlib['__fs_write_sync'] = () => {
    const io = iov()
    return `(func $__fs_write_sync (param $fd i32) (param $buf i64) (param $off f64) (param $len f64) (param $rest i32) (param $opts i32) (result f64)
    (local $s i64) (local $b i64) (local $bl f64) (local $p i32) (local $n i32) (local $total i32) (local $e i32)
    (if (i32.and ${isBox('(local.get $buf)')} (i32.eq (call $__ptr_type (local.get $buf)) (i32.const ${PTR.STRING})))
      (then
        (local.set $b (i64.reinterpret_f64 (local.get $off)))
        (if (i32.eqz (i32.or (local.get $opts)
              (i32.or (i64.eq (local.get $b) (i64.const ${UNDEF_NAN})) (i64.eq (local.get $b) (i64.const ${NULL_NAN})))))
          (then ${raise(ERR.FS_BUFFER)}))
        (local.set $s (call $__fs_path (local.get $buf))))
      (else
        (local.set $s (call $__fs_view (local.get $buf)))
        (local.set $off (call $__fs_offset (local.get $off) (i32.const 1)))
        (local.set $bl (f64.convert_i32_u (i32.wrap_i64 (local.get $s))))
        (if (i32.or (local.get $rest) ${notNumber('(i64.reinterpret_f64 (local.get $len))')})
          (then (local.set $len (f64.sub (local.get $bl) (local.get $off)))))
        (if (i32.or (f64.gt (local.get $off) (local.get $bl))
              (i32.or (f64.gt (local.get $len) (f64.sub (local.get $bl) (local.get $off)))
                (i32.or (f64.lt (local.get $len) (f64.const 0)) (f64.ne (f64.trunc (local.get $len)) (local.get $len)))))
          (then ${raise(ERR.FS_RANGE)}))
        (local.set $s (i64.or
          (i64.shl (i64.extend_i32_u (i32.add (i32.wrap_i64 (i64.shr_u (local.get $s) (i64.const 32))) (i32.trunc_f64_u (local.get $off)))) (i64.const 32))
          (i64.extend_i32_u (i32.trunc_f64_u (local.get $len)))))))
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

  // Node's forms: readSync(fd, buffer[, options]), readSync(fd, buffer, offset,
  // length[, position]); writeSync(fd, buffer[, options]), writeSync(fd, buffer,
  // offset[, length[, position]]), writeSync(fd, string[, position[, encoding]]).
  // A third argument that is an object, null among them, is the options, and
  // readSync takes any lone third argument for them. jz reads an object literal's
  // keys at compile time; its values run as written, with every argument, in order.
  // Calls go where the descriptor stands, so a position other than null or
  // undefined is refused; a string's encoding is UTF-8.
  const given = (x) => x != null && !isNullishLit(x)
  const isNull = (x) => isNullishLit(x) && !isUndefinedLiteral(x)
  const isObjectLit = (x) => Array.isArray(x) && x[0] === '{}'
  const OBJECT_KINDS = new Set([VAL.OBJECT, VAL.HASH, VAL.ARRAY, VAL.TYPED, VAL.BUFFER, VAL.MAP, VAL.SET, VAL.DATE, VAL.REGEX])
  const numeric = (x) => valTypeOf(x) === VAL.NUMBER
  // A value as Node's checks see it: a Number, or the box of anything else.
  const value = (x) => asF64(numeric(x) ? emit(x) : storedValue(x))
  const literalOnly = (m) => err(`fs.${m}: options must be an object literal ({ offset, length }), its keys plain; jz reads them at compile time`)
  const noPosition = (m) => err(`fs.${m}: a position is not supported; the call reads and writes at the descriptor's current offset`)

  // The options literal as [node, role] in source order: offset, length and
  // position by their last key, every other value run and dropped.
  const optionItems = (m, o, items) => {
    const entries = o.length === 2 && Array.isArray(o[1]) && o[1][0] === ',' ? o[1].slice(1) : o.slice(1)
    const keys = entries.map(e => !Array.isArray(e) || e[0] !== ':' ? null
      : typeof e[1] === 'string' ? e[1] : isLiteralStr(e[1]) ? e[1][1] : null)
    entries.forEach((e, i) => {
      const k = keys[i]
      if (e == null) return
      if (k == null || k === 'offset' + ACCESSOR_GET || k === 'length' + ACCESSOR_GET || k === 'position' + ACCESSOR_GET ||
        k === 'offset' + ACCESSOR_SET || k === 'length' + ACCESSOR_SET || k === 'position' + ACCESSOR_SET) literalOnly(m)
      const last = keys.lastIndexOf(k) === i
      if (k === 'position' && last && given(e[2])) noPosition(m)
      // An undefined value takes the default, as destructuring does.
      const role = !last || isUndefinedLiteral(e[2]) ? null : k === 'offset' ? 'off' : k === 'length' ? 'len' : null
      items.push([e[2], role])
    })
  }

  // The call's [node, role] items, in the order the source runs them.
  const syncItems = (m, a) => {
    const [fd, buf, third] = a
    if (buf == null) err(`fs.${m}(fd, buffer) needs a buffer`)
    const items = [[fd, 'fd'], [buf, 'buf']]
    const options = third != null && (isObjectLit(third) || isNull(third) || m === 'readSync' && a.length === 3)
    if (options) {
      if (isObjectLit(third)) optionItems(m, third, items)
      else if (given(third)) err(`fs.readSync(fd, buffer, options): Node reads a lone third argument as options; pass an object literal ({ offset, length }) or (fd, buffer, offset, length)`)
      for (let i = 3; i < a.length; i++) items.push([a[i], null])
      return { items, options }
    }
    // an object Node would take for the options, which jz cannot read
    if (third != null && OBJECT_KINDS.has(valTypeOf(third))) literalOnly(m)
    if (given(a[4])) noPosition(m)
    if (third != null) items.push([third, 'off'])
    // writeSync's length that is no Number runs to the end; readSync's ToInt32s
    if (a.length > 3) items.push([a[3], m === 'writeSync' && isNullishLit(a[3]) ? null : 'len'])
    for (let i = 4; i < a.length; i++) items.push([a[i], null])
    return { items, options }
  }

  // The call's arguments: the values where they run in the call's order, else each
  // in a temp first, so every one runs once and in source order.
  const ORDER = ['fd', 'buf', 'off', 'len']
  const syncArgs = (m, a) => {
    const { items, options } = syncItems(m, a)
    const live = items.filter(([n, r]) => r != null || given(n))
    const lenItem = live.find(([, r]) => r === 'len')
    // readSync's options length that may be undefined takes the default at run time
    const restAtRun = m === 'readSync' && options && lenItem != null && !numeric(lenItem[0])
    const direct = !restAtRun && live.every(([, r], i) => r != null && (i === 0 || ORDER.indexOf(r) > ORDER.indexOf(live[i - 1][1])))
    const setup = []
    let fd = null, buf = null, off = null, len = null
    for (const [n, r] of live) {
      let got = null
      if (!direct) {
        if (r == null) { setup.push(['drop', asF64(emit(n))]); continue }
        const t = temp('fs')
        setup.push(['local.set', `$${t}`, r === 'fd' || r === 'buf' ? asF64(emit(n)) : value(n)])
        got = { node: numeric(n) ? n : t, ir: typed(['local.get', `$${t}`], 'f64') }
      }
      const at = got ?? { node: n, ir: null }
      if (r === 'fd') fd = at
      else if (r === 'buf') buf = at
      else if (r === 'off') off = at
      else len = at
    }
    const args = [asI32(fd.ir ?? asF64(emit(fd.node))), asI64(buf.ir ?? emit(buf.node)),
      off ? off.ir ?? value(off.node) : undefExpr()]
    if (m === 'readSync') {
      args.push(len ? toInt32(toNumF64(len.node, len.ir ?? emit(len.node))) : ['i32.const', 0])
      args.push(restAtRun ? ['i64.eq', asI64(len.ir), ['i64.const', UNDEF_NAN]] : ['i32.const', len ? 0 : 1])
    } else args.push(len ? len.ir ?? value(len.node) : ['f64.const', 0], ['i32.const', len ? 0 : 1], ['i32.const', options ? 1 : 0])
    return { setup, args }
  }
  const syncCall = (m, a) => {
    const { setup, args } = syncArgs(m, a)
    const call = typed(['call', `$__fs_${m === 'readSync' ? 'read' : 'write'}_sync`, ...args], 'f64')
    return setup.length ? typed(['block', ['result', 'f64'], ...setup, call], 'f64') : call
  }
  const viewDeps = ['__fs_view', '__fs_offset', '__ptr_type', '__ptr_aux', '__len', '__typed_shift', '__typed_data']
  ctx.core.emit['fs.readSync'] = (...a) => {
    needFdRead()
    inc(...viewDeps, '__fs_read_sync')
    return syncCall('readSync', a)
  }
  ctx.core.emit['fs.writeSync'] = (...a) => {
    needFdWrite()
    ctx.module.include('string')
    inc(...viewDeps, '__fs_path', '__utf8_encode', '__fs_write_sync')
    return syncCall('writeSync', a)
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
