// UTF-8 belongs to byte-oriented APIs. Internal strings contain UTF-16 units.
import { ctx, inc, PTR, err, setLinkDemand } from '../../src/ctx.js'
import { bind, wat, emit } from '../../src/bridge.js'
import { typed, asI32, asI64, asF64, UNDEF_NAN, temp, tempI32, tempI64, toStrI64 } from '../../src/ir.js'
import { ERR } from '../../err-codes.js'

export function registerEncoding() {
  const label = value => {
    if (value == null || (Array.isArray(value) && value[0] == null && value[1] === undefined)) return
    const name = Array.isArray(value) && value[0] === 'str' ? value[1].trim().toLowerCase() : null
    if (!['utf-8', 'utf8', 'unicode-1-1-utf-8'].includes(name))
      err('TextDecoder supports a literal UTF-8 encoding label')
  }
  const optionsOf = (node, stream = false) => {
    if (node == null || (Array.isArray(node) && node[0] == null && node[1] == null)) return 0
    if (!Array.isArray(node) || !['{','{}'].includes(node[0])) err('TextDecoder options must be a literal object')
    const entries = node.length === 2 && Array.isArray(node[1]) && [',',';'].includes(node[1][0]) ? node[1].slice(1) : node.slice(1)
    let flags = 0
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry[0] !== ':') err('TextDecoder options must use literal keys and values')
      const key = typeof entry[1] === 'string' ? entry[1] : entry[1][1], value = entry[2]
      if (!Array.isArray(value) || (value[0] !== 'bool' && value[0] != null)) err('TextDecoder options must use literal boolean values')
      if (stream) { if (key !== 'stream' || value[1]) err('TextDecoder streaming is not supported') }
      else if (key === 'ignoreBOM') flags |= value[1] ? 1 : 0
      else if (key === 'fatal') flags |= value[1] ? 2 : 0
      else err(`TextDecoder: unsupported option '${key}'`)
    }
    return flags
  }
  bind('TextEncoder', () => typed(['f64.const', 1], 'f64'))
  bind('TextDecoder', (encoding, options) => {
    label(encoding)
    return typed(['f64.const', 4 | optionsOf(options)], 'f64')
  })

  // Returns UTF-16 units read in the low word, UTF-8 bytes written in the high.
  // Capacity is checked before writing a complete scalar; no partial sequence.
  wat('__utf8_encode', `(func $__utf8_encode (param $s i64) (param $dst i32) (param $cap i32) (result i64)
    (local $len i32) (local $i i32) (local $j i32) (local $cp i32) (local $low i32)
    (local $units i32) (local $n i32) (local $p i32)
    (local.set $len (call $__str_length (local.get $s)))
    (block $done (loop $next
      (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
      (local.set $cp (call $__char_at (local.get $s) (local.get $i)))
      (local.set $units (i32.const 1))
      (if (i32.lt_u (i32.sub (local.get $cp) (i32.const 55296)) (i32.const 2048))
        (then
          (local.set $low (i32.const 0))
          (if (i32.and (i32.lt_u (local.get $cp) (i32.const 56320))
                (i32.lt_u (i32.add (local.get $i) (i32.const 1)) (local.get $len)))
            (then (local.set $low (call $__char_at (local.get $s) (i32.add (local.get $i) (i32.const 1))))))
          (if (i32.lt_u (i32.sub (local.get $low) (i32.const 56320)) (i32.const 1024))
            (then
              (local.set $cp (i32.add (i32.const 65536) (i32.add
                (i32.shl (i32.sub (local.get $cp) (i32.const 55296)) (i32.const 10))
                (i32.sub (local.get $low) (i32.const 56320)))))
              (local.set $units (i32.const 2)))
            (else (local.set $cp (i32.const 65533))))))
      (local.set $n (if (result i32) (i32.lt_u (local.get $cp) (i32.const 128)) (then (i32.const 1))
        (else (if (result i32) (i32.lt_u (local.get $cp) (i32.const 2048)) (then (i32.const 2))
          (else (select (i32.const 3) (i32.const 4) (i32.lt_u (local.get $cp) (i32.const 65536))))))))
      (br_if $done (i32.gt_u (local.get $n) (i32.sub (local.get $cap) (local.get $j))))
      (local.set $p (i32.add (local.get $dst) (local.get $j)))
      (if (i32.eq (local.get $n) (i32.const 1))
        (then (i32.store8 (local.get $p) (local.get $cp)))
        (else
          (if (i32.eq (local.get $n) (i32.const 2))
            (then (i32.store8 (local.get $p) (i32.or (i32.const 192) (i32.shr_u (local.get $cp) (i32.const 6)))))
            (else
              (if (i32.eq (local.get $n) (i32.const 3))
                (then (i32.store8 (local.get $p) (i32.or (i32.const 224) (i32.shr_u (local.get $cp) (i32.const 12)))))
                (else
                  (i32.store8 (local.get $p) (i32.or (i32.const 240) (i32.shr_u (local.get $cp) (i32.const 18))))
                  (i32.store8 offset=1 (local.get $p) (i32.or (i32.const 128) (i32.and (i32.shr_u (local.get $cp) (i32.const 12)) (i32.const 63))))))
              (i32.store8 (i32.add (local.get $p) (i32.sub (local.get $n) (i32.const 2)))
                (i32.or (i32.const 128) (i32.and (i32.shr_u (local.get $cp) (i32.const 6)) (i32.const 63))))))
          (i32.store8 (i32.add (local.get $p) (i32.sub (local.get $n) (i32.const 1)))
            (i32.or (i32.const 128) (i32.and (local.get $cp) (i32.const 63))))))
      (local.set $i (i32.add (local.get $i) (local.get $units)))
      (local.set $j (i32.add (local.get $j) (local.get $n)))
      (br $next)))
    (i64.or (i64.extend_i32_u (local.get $i)) (i64.shl (i64.extend_i32_u (local.get $j)) (i64.const 32))))`)

  wat('__str_encode', `(func $__str_encode (param $s i64) (result f64)
    (local $cap i32) (local $dst i32) (local $n i32)
    (local.set $cap (i32.mul (call $__str_length (local.get $s)) (i32.const 3)))
    (local.set $dst (call $__alloc_hdr_n (i32.const 0) (local.get $cap) (i32.const 1)))
    (local.set $n (i32.wrap_i64 (i64.shr_u (call $__utf8_encode (local.get $s) (local.get $dst) (local.get $cap)) (i64.const 32))))
    (i32.store (i32.sub (local.get $dst) (i32.const 8)) (local.get $n))
    (call $__mkptr (i32.const ${PTR.TYPED}) (i32.const 1) (local.get $dst)))`)

  bind('.encode', (obj, value) => {
    setLinkDemand('typedarray')
    inc('__str_encode')
    const receiver = emit(obj), input = temp('enc')
    const local = typed(['local.get', `$${input}`], 'f64')
    const empty = asI64(emit(['str', '']))
    if (value == null) return typed(['block', ['result', 'f64'], ['drop', receiver], ['call', '$__str_encode', empty]], 'f64')
    return typed(['block', ['result', 'f64'], ['drop', receiver],
      ['local.set', `$${input}`, asF64(emit(value))],
      ['call', '$__str_encode', ['if', ['result', 'i64'], ['i64.eq', asI64(local), ['i64.const', UNDEF_NAN]],
        ['then', empty], ['else', toStrI64(value, local)]]]], 'f64')
  })

  // Consume maximal valid prefixes on malformed UTF-8, emit U+FFFD, and retry
  // the first non-continuation byte. UTF-16 output needs at most 2*input bytes.
  wat('__utf8_decode', `(func $__utf8_decode (param $src i32) (param $len i32) (param $flags i32) (result f64)
    (local $out i32) (local $i i32) (local $j i32)
    (local $b i32) (local $cp i32) (local $n i32) (local $lo i32) (local $hi i32)
    (local.set $out (i32.add (call $__alloc (i32.add (i32.const 4) (i32.shl (local.get $len) (i32.const 1)))) (i32.const 4)))
    (block $done (loop $next
      (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
      (local.set $b (i32.load8_u (i32.add (local.get $src) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (local.set $cp (local.get $b))
      (if (i32.ge_u (local.get $b) (i32.const 128)) (then
        (local.set $n (i32.const 0))
        (local.set $lo (i32.const 128)) (local.set $hi (i32.const 191))
        (if (i32.lt_u (i32.sub (local.get $b) (i32.const 194)) (i32.const 30))
          (then (local.set $n (i32.const 1)) (local.set $cp (i32.and (local.get $b) (i32.const 31)))))
        (if (i32.lt_u (i32.sub (local.get $b) (i32.const 224)) (i32.const 16))
          (then (local.set $n (i32.const 2)) (local.set $cp (i32.and (local.get $b) (i32.const 15)))
            (if (i32.eq (local.get $b) (i32.const 224)) (then (local.set $lo (i32.const 160))))
            (if (i32.eq (local.get $b) (i32.const 237)) (then (local.set $hi (i32.const 159))))))
        (if (i32.lt_u (i32.sub (local.get $b) (i32.const 240)) (i32.const 5))
          (then (local.set $n (i32.const 3)) (local.set $cp (i32.and (local.get $b) (i32.const 7)))
            (if (i32.eq (local.get $b) (i32.const 240)) (then (local.set $lo (i32.const 144))))
            (if (i32.eq (local.get $b) (i32.const 244)) (then (local.set $hi (i32.const 143))))))
        (if (i32.eqz (local.get $n)) (then (if (i32.and (local.get $flags) (i32.const 2))
              (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.TEXT_DECODE}))) (throw $__jz_err (f64.const ${ERR.TEXT_DECODE}))))
            (local.set $cp (i32.const 65533))))
        (block $bad (loop $cont
          (br_if $bad (i32.eqz (local.get $n)))
          (if (i32.ge_u (local.get $i) (local.get $len))
            (then (if (i32.and (local.get $flags) (i32.const 2))
              (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.TEXT_DECODE}))) (throw $__jz_err (f64.const ${ERR.TEXT_DECODE}))))
            (local.set $cp (i32.const 65533)) (br $bad)))
          (local.set $b (i32.load8_u (i32.add (local.get $src) (local.get $i))))
          (if (i32.or (i32.lt_u (local.get $b) (local.get $lo)) (i32.gt_u (local.get $b) (local.get $hi)))
            (then (if (i32.and (local.get $flags) (i32.const 2))
              (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.TEXT_DECODE}))) (throw $__jz_err (f64.const ${ERR.TEXT_DECODE}))))
            (local.set $cp (i32.const 65533)) (br $bad)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (local.set $cp (i32.or (i32.shl (local.get $cp) (i32.const 6)) (i32.and (local.get $b) (i32.const 63))))
          (local.set $lo (i32.const 128)) (local.set $hi (i32.const 191))
          (local.set $n (i32.sub (local.get $n) (i32.const 1)))
          (br $cont)))))
      (if (i32.and (i32.eqz (i32.and (local.get $flags) (i32.const 1))) (i32.and (i32.eq (local.get $i) (i32.const 3)) (i32.eq (local.get $cp) (i32.const 65279)))) (then (br $next)))
      (if (i32.gt_u (local.get $cp) (i32.const 65535))
        (then
          (local.set $cp (i32.sub (local.get $cp) (i32.const 65536)))
          (i32.store16 (i32.add (local.get $out) (i32.shl (local.get $j) (i32.const 1)))
            (i32.add (i32.const 55296) (i32.shr_u (local.get $cp) (i32.const 10))))
          (local.set $j (i32.add (local.get $j) (i32.const 1)))
          (local.set $cp (i32.add (i32.const 56320) (i32.and (local.get $cp) (i32.const 1023))))))
      (i32.store16 (i32.add (local.get $out) (i32.shl (local.get $j) (i32.const 1))) (local.get $cp))
      (local.set $j (i32.add (local.get $j) (i32.const 1)))
      (br $next)))
    (i32.store (i32.sub (local.get $out) (i32.const 4)) (local.get $j))
    (call $__sso_norm (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $out))))`)

  wat('__bytes_decode', `(func $__bytes_decode (param $arr i64) (param $flags i32) (result f64)
    (if (i64.eq (local.get $arr) (i64.const ${UNDEF_NAN}))
      (then (return (call $__utf8_decode (i32.const 0) (i32.const 0) (local.get $flags)))))
    (if (i32.and (i32.ne (call $__ptr_type (local.get $arr)) (i32.const ${PTR.BUFFER}))
          (i32.ne (call $__ptr_type (local.get $arr)) (i32.const ${PTR.TYPED})))
      (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.TEXT_DECODE_INPUT}))) (throw $__jz_err (f64.const ${ERR.TEXT_DECODE_INPUT}))))
    (call $__utf8_decode (call $__typed_data (local.get $arr)) (call $__byte_length (local.get $arr)) (local.get $flags)))`)

  bind('.decode', (obj, value, options) => {
    // Emit the receiver even on a chained call, to validate its constructor.
    const receiver = emit(obj)
    optionsOf(options, true)
    ctx.runtime.throws = true
    if (value == null) return typed(['block', ['result', 'f64'], ['drop', receiver], emit(['str', ''])], 'f64')
    ctx.module.include('typedarray')
    inc('__bytes_decode')
    const flags = tempI32('dec')
    return typed(['block', ['result', 'f64'], ['local.set', `$${flags}`, asI32(receiver)],
      ['call', '$__bytes_decode', asI64(emit(value)), ['local.get', `$${flags}`]]], 'f64')
  })

  wat('__str_encode_into', `(func $__str_encode_into (param $s i64) (param $dst i64) (result i64)
    (if (i32.or (i32.ne (call $__ptr_type (local.get $dst)) (i32.const ${PTR.TYPED}))
          (i32.ne (i32.and (call $__ptr_aux (local.get $dst)) (i32.const 119)) (i32.const 1)))
      (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.ENCODE_INTO_RECEIVER})))
        (throw $__jz_err (f64.const ${ERR.ENCODE_INTO_RECEIVER}))))
    (call $__utf8_encode (local.get $s) (call $__typed_data (local.get $dst)) (call $__byte_length (local.get $dst))))`)
  bind('.encodeInto', (obj, str, dst) => {
    ctx.runtime.throws = true
    setLinkDemand('typedarray')
    ctx.module.include('typedarray')
    ctx.module.include('array')
    ctx.module.include('collection')
    inc('__str_encode_into', '__hash_new', '__hash_set')
    const counts = tempI64('ein'), h = temp('eih'), input = temp('eis'), target = tempI64('eid')
    const value = typed(['local.get', `$${input}`], 'f64')
    const hI64 = ['i64.reinterpret_f64', ['local.get', `$${h}`]]
    const count = shift => ['i64.reinterpret_f64', ['f64.convert_i32_u', ['i32.wrap_i64',
      shift ? ['i64.shr_u', ['local.get', `$${counts}`], ['i64.const', 32]] : ['local.get', `$${counts}`]]]]
    return typed(['block', ['result', 'f64'],
      ['drop', emit(obj)],
      ['local.set', `$${input}`, asF64(emit(str))],
      ['local.set', `$${target}`, asI64(emit(dst))],
      ['local.set', `$${counts}`, ['call', '$__str_encode_into', toStrI64(str, value), ['local.get', `$${target}`]]],
      ['local.set', `$${h}`, ['call', '$__hash_new']],
      ['local.set', `$${h}`, ['f64.reinterpret_i64', ['call', '$__hash_set', hI64, asI64(emit(['str', 'read'])), count(0)]]],
      ['local.set', `$${h}`, ['f64.reinterpret_i64', ['call', '$__hash_set', hI64, asI64(emit(['str', 'written'])), count(1)]]],
      ['local.get', `$${h}`]], 'f64')
  })
}
