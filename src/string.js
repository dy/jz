// String method implementations
import { ctx, opts, gen } from './compile.js'
import { PTR_TYPE, tv, asF64, asI32 } from './types.js'
import { strCharAt, strLen, strNew, strSetChar } from './gc.js'

export const charCodeAt = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedStringType = true
  if (!opts.gc) ctx.usedMemory = true
  return tv('i32', strCharAt(opts.gc, rw, asI32(gen(args[0]))[1]))
}

export const slice = (rw, args) => {
  ctx.usedStringType = true
  if (!opts.gc) ctx.usedMemory = true
  const id = ctx.loopCounter++
  const str = `$_sslice_str_${id}`, idx = `$_sslice_i_${id}`, len = `$_sslice_len_${id}`, result = `$_sslice_result_${id}`, start = `$_sslice_start_${id}`, end = `$_sslice_end_${id}`, newLen = `$_sslice_newlen_${id}`
  ctx.addLocal(str.slice(1), 'string')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(result.slice(1), 'string')
  ctx.addLocal(start.slice(1), 'i32')
  ctx.addLocal(end.slice(1), 'i32')
  ctx.addLocal(newLen.slice(1), 'i32')
  const gc = opts.gc
  const startArg = args.length >= 1 ? asI32(gen(args[0]))[1] : '(i32.const 0)'
  const endArg = args.length >= 2 ? asI32(gen(args[1]))[1] : strLen(gc, `(local.get ${str})`)
  return tv('string', `(local.set ${str} ${rw})
    (local.set ${len} ${strLen(gc, `(local.get ${str})`)})
    (local.set ${start} ${startArg})
    (local.set ${end} ${endArg})
    (if (i32.lt_s (local.get ${start}) (i32.const 0))
      (then (local.set ${start} (i32.add (local.get ${len}) (local.get ${start})))))
    (if (i32.lt_s (local.get ${end}) (i32.const 0))
      (then (local.set ${end} (i32.add (local.get ${len}) (local.get ${end})))))
    (if (i32.lt_s (local.get ${start}) (i32.const 0)) (then (local.set ${start} (i32.const 0))))
    (if (i32.gt_s (local.get ${end}) (local.get ${len})) (then (local.set ${end} (local.get ${len}))))
    (local.set ${newLen} (i32.sub (local.get ${end}) (local.get ${start})))
    (if (i32.lt_s (local.get ${newLen}) (i32.const 0)) (then (local.set ${newLen} (i32.const 0))))
    (local.set ${result} ${strNew(gc, `(local.get ${newLen})`)})
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${newLen})))
      ${strSetChar(gc, `(local.get ${result})`, `(local.get ${idx})`, strCharAt(gc, `(local.get ${str})`, `(i32.add (local.get ${start}) (local.get ${idx}))`))}
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
}

export const indexOf = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedStringType = true
  if (!opts.gc) ctx.usedMemory = true
  const searchVal = gen(args[0])
  // For simplicity, only support single char search (number)
  if (searchVal[0] !== 'i32' && searchVal[0] !== 'f64') return null
  const id = ctx.loopCounter++
  const str = `$_sindexof_str_${id}`, idx = `$_sindexof_i_${id}`, len = `$_sindexof_len_${id}`, result = `$_sindexof_result_${id}`, target = `$_sindexof_target_${id}`
  ctx.addLocal(str.slice(1), 'string')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(result.slice(1), 'i32')
  ctx.addLocal(target.slice(1), 'i32')
  const gc = opts.gc
  return tv('i32', `(local.set ${str} ${rw})
    (local.set ${target} ${asI32(searchVal)[1]})
    (local.set ${len} ${strLen(gc, `(local.get ${str})`)})
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const -1))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (if (i32.eq ${strCharAt(gc, `(local.get ${str})`, `(local.get ${idx})`)} (local.get ${target}))
        (then
          (local.set ${result} (local.get ${idx}))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
}

export const substring = (rw, args) => {
  if (args.length < 1) return null
  ctx.usedStringType = true
  if (!opts.gc) ctx.usedMemory = true
  const id = ctx.loopCounter++
  const str = `$_substr_str_${id}`, idx = `$_substr_i_${id}`, len = `$_substr_len_${id}`, result = `$_substr_result_${id}`, start = `$_substr_start_${id}`, end = `$_substr_end_${id}`, newLen = `$_substr_newlen_${id}`
  ctx.addLocal(str.slice(1), 'string')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(result.slice(1), 'string')
  ctx.addLocal(start.slice(1), 'i32')
  ctx.addLocal(end.slice(1), 'i32')
  ctx.addLocal(newLen.slice(1), 'i32')
  const gc = opts.gc
  const startArg = asI32(gen(args[0]))[1]
  const endArg = args.length >= 2 ? asI32(gen(args[1]))[1] : strLen(gc, `(local.get ${str})`)
  return tv('string', `(local.set ${str} ${rw})
    (local.set ${len} ${strLen(gc, `(local.get ${str})`)})
    (local.set ${start} ${startArg})
    (local.set ${end} ${endArg})
    (if (i32.lt_s (local.get ${start}) (i32.const 0)) (then (local.set ${start} (i32.const 0))))
    (if (i32.gt_s (local.get ${start}) (local.get ${len})) (then (local.set ${start} (local.get ${len}))))
    (if (i32.lt_s (local.get ${end}) (i32.const 0)) (then (local.set ${end} (i32.const 0))))
    (if (i32.gt_s (local.get ${end}) (local.get ${len})) (then (local.set ${end} (local.get ${len}))))
    (if (i32.gt_s (local.get ${start}) (local.get ${end}))
      (then
        (local.set ${newLen} (local.get ${start}))
        (local.set ${start} (local.get ${end}))
        (local.set ${end} (local.get ${newLen}))))
    (local.set ${newLen} (i32.sub (local.get ${end}) (local.get ${start})))
    (local.set ${result} ${strNew(gc, `(local.get ${newLen})`)})
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${newLen})))
      ${strSetChar(gc, `(local.get ${result})`, `(local.get ${idx})`, strCharAt(gc, `(local.get ${str})`, `(i32.add (local.get ${start}) (local.get ${idx}))`))}
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
}

export const toLowerCase = (rw, args) => {
  ctx.usedStringType = true
  if (!opts.gc) ctx.usedMemory = true
  const id = ctx.loopCounter++
  const str = `$_tolower_str_${id}`, idx = `$_tolower_i_${id}`, len = `$_tolower_len_${id}`, result = `$_tolower_result_${id}`, ch = `$_tolower_ch_${id}`
  ctx.addLocal(str.slice(1), 'string')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(result.slice(1), 'string')
  ctx.addLocal(ch.slice(1), 'i32')
  const gc = opts.gc
  return tv('string', `(local.set ${str} ${rw})
    (local.set ${len} ${strLen(gc, `(local.get ${str})`)})
    (local.set ${result} ${strNew(gc, `(local.get ${len})`)})
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set ${ch} ${strCharAt(gc, `(local.get ${str})`, `(local.get ${idx})`)})
      (if (i32.and (i32.ge_s (local.get ${ch}) (i32.const 65)) (i32.le_s (local.get ${ch}) (i32.const 90)))
        (then (local.set ${ch} (i32.add (local.get ${ch}) (i32.const 32)))))
      ${strSetChar(gc, `(local.get ${result})`, `(local.get ${idx})`, `(local.get ${ch})`)}
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
}

export const toUpperCase = (rw, args) => {
  ctx.usedStringType = true
  if (!opts.gc) ctx.usedMemory = true
  const id = ctx.loopCounter++
  const str = `$_toupper_str_${id}`, idx = `$_toupper_i_${id}`, len = `$_toupper_len_${id}`, result = `$_toupper_result_${id}`, ch = `$_toupper_ch_${id}`
  ctx.addLocal(str.slice(1), 'string')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(result.slice(1), 'string')
  ctx.addLocal(ch.slice(1), 'i32')
  const gc = opts.gc
  return tv('string', `(local.set ${str} ${rw})
    (local.set ${len} ${strLen(gc, `(local.get ${str})`)})
    (local.set ${result} ${strNew(gc, `(local.get ${len})`)})
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set ${ch} ${strCharAt(gc, `(local.get ${str})`, `(local.get ${idx})`)})
      (if (i32.and (i32.ge_s (local.get ${ch}) (i32.const 97)) (i32.le_s (local.get ${ch}) (i32.const 122)))
        (then (local.set ${ch} (i32.sub (local.get ${ch}) (i32.const 32)))))
      ${strSetChar(gc, `(local.get ${result})`, `(local.get ${idx})`, `(local.get ${ch})`)}
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
}

export const includes = (rw, args) => {
  if (args.length < 1) return null
  ctx.usedStringType = true
  if (!opts.gc) ctx.usedMemory = true
  const searchVal = gen(args[0])
  if (searchVal[0] !== 'i32' && searchVal[0] !== 'f64') return null
  const id = ctx.loopCounter++
  const str = `$_sincludes_str_${id}`, idx = `$_sincludes_i_${id}`, len = `$_sincludes_len_${id}`, target = `$_sincludes_target_${id}`, result = `$_sincludes_result_${id}`
  ctx.addLocal(str.slice(1), 'string')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(target.slice(1), 'i32')
  ctx.addLocal(result.slice(1), 'i32')
  const gc = opts.gc
  return tv('i32', `(local.set ${str} ${rw})
    (local.set ${target} ${asI32(searchVal)[1]})
    (local.set ${len} ${strLen(gc, `(local.get ${str})`)})
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (if (i32.eq ${strCharAt(gc, `(local.get ${str})`, `(local.get ${idx})`)} (local.get ${target}))
        (then
          (local.set ${result} (i32.const 1))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
}

export const startsWith = (rw, args) => {
  if (args.length < 1) return null
  ctx.usedStringType = true
  if (!opts.gc) ctx.usedMemory = true
  const searchVal = gen(args[0])
  if (searchVal[0] !== 'i32' && searchVal[0] !== 'f64') return null
  const id = ctx.loopCounter++
  const str = `$_starts_str_${id}`, ch = `$_starts_ch_${id}`, target = `$_starts_target_${id}`
  ctx.addLocal(str.slice(1), 'string')
  ctx.addLocal(ch.slice(1), 'i32')
  ctx.addLocal(target.slice(1), 'i32')
  const gc = opts.gc
  return tv('i32', `(local.set ${str} ${rw})
    (local.set ${target} ${asI32(searchVal)[1]})
    (local.set ${ch} (if (result i32) (i32.gt_s ${strLen(gc, `(local.get ${str})`)} (i32.const 0))
      (then ${strCharAt(gc, `(local.get ${str})`, '(i32.const 0)')})
      (else (i32.const -1))))
    (i32.eq (local.get ${ch}) (local.get ${target}))`)
}

export const endsWith = (rw, args) => {
  if (args.length < 1) return null
  ctx.usedStringType = true
  if (!opts.gc) ctx.usedMemory = true
  const searchVal = gen(args[0])
  if (searchVal[0] !== 'i32' && searchVal[0] !== 'f64') return null
  const id = ctx.loopCounter++
  const str = `$_ends_str_${id}`, ch = `$_ends_ch_${id}`, target = `$_ends_target_${id}`, len = `$_ends_len_${id}`
  ctx.addLocal(str.slice(1), 'string')
  ctx.addLocal(ch.slice(1), 'i32')
  ctx.addLocal(target.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  const gc = opts.gc
  return tv('i32', `(local.set ${str} ${rw})
    (local.set ${target} ${asI32(searchVal)[1]})
    (local.set ${len} ${strLen(gc, `(local.get ${str})`)})
    (local.set ${ch} (if (result i32) (i32.gt_s (local.get ${len}) (i32.const 0))
      (then ${strCharAt(gc, `(local.get ${str})`, `(i32.sub (local.get ${len}) (i32.const 1))`)})
      (else (i32.const -1))))
    (i32.eq (local.get ${ch}) (local.get ${target}))`)
}

export const trim = (rw, args) => {
  ctx.usedStringType = true
  if (!opts.gc) ctx.usedMemory = true
  const id = ctx.loopCounter++
  const str = `$_trim_str_${id}`, idx = `$_trim_i_${id}`, len = `$_trim_len_${id}`, result = `$_trim_result_${id}`, start = `$_trim_start_${id}`, end = `$_trim_end_${id}`, ch = `$_trim_ch_${id}`, newLen = `$_trim_newlen_${id}`
  ctx.addLocal(str.slice(1), 'string')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(result.slice(1), 'string')
  ctx.addLocal(start.slice(1), 'i32')
  ctx.addLocal(end.slice(1), 'i32')
  ctx.addLocal(ch.slice(1), 'i32')
  ctx.addLocal(newLen.slice(1), 'i32')
  const gc = opts.gc
  return tv('string', `(local.set ${str} ${rw})
    (local.set ${len} ${strLen(gc, `(local.get ${str})`)})
    (local.set ${start} (i32.const 0))
    (local.set ${end} (local.get ${len}))
    ;; Find start
    (block $start_done_${id} (loop $start_loop_${id}
      (br_if $start_done_${id} (i32.ge_s (local.get ${start}) (local.get ${len})))
      (local.set ${ch} ${strCharAt(gc, `(local.get ${str})`, `(local.get ${start})`)})
      (br_if $start_done_${id} (i32.and (i32.ne (local.get ${ch}) (i32.const 32)) (i32.and (i32.ne (local.get ${ch}) (i32.const 9)) (i32.and (i32.ne (local.get ${ch}) (i32.const 10)) (i32.ne (local.get ${ch}) (i32.const 13))))))
      (local.set ${start} (i32.add (local.get ${start}) (i32.const 1)))
      (br $start_loop_${id})))
    ;; Find end
    (block $end_done_${id} (loop $end_loop_${id}
      (br_if $end_done_${id} (i32.le_s (local.get ${end}) (local.get ${start})))
      (local.set ${ch} ${strCharAt(gc, `(local.get ${str})`, `(i32.sub (local.get ${end}) (i32.const 1))`)})
      (br_if $end_done_${id} (i32.and (i32.ne (local.get ${ch}) (i32.const 32)) (i32.and (i32.ne (local.get ${ch}) (i32.const 9)) (i32.and (i32.ne (local.get ${ch}) (i32.const 10)) (i32.ne (local.get ${ch}) (i32.const 13))))))
      (local.set ${end} (i32.sub (local.get ${end}) (i32.const 1)))
      (br $end_loop_${id})))
    (local.set ${newLen} (i32.sub (local.get ${end}) (local.get ${start})))
    (local.set ${result} ${strNew(gc, `(local.get ${newLen})`)})
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${newLen})))
      ${strSetChar(gc, `(local.get ${result})`, `(local.get ${idx})`, strCharAt(gc, `(local.get ${str})`, `(i32.add (local.get ${start}) (local.get ${idx}))`))}
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
}

// Stub implementations
export const split = (rw, args) => {
  ctx.usedArrayType = true
  if (opts.gc) return tv('array', `(array.new $f64array (f64.const 0) (i32.const 0))`)
  ctx.usedMemory = true
  return tv('f64', `(call $__alloc (i32.const ${PTR_TYPE.F64_ARRAY}) (i32.const 0))`)
}

export const replace = (rw, args) => tv('string', rw)
