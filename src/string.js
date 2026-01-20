// String method implementations
import { ctx, gen } from './compile.js'
import { PTR_TYPE, wat, i32 } from './types.js'
import { strCharAt, strLen, strNew, strSetChar } from './memory.js'

export const charCodeAt = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedStringType = true
  ctx.usedMemory = true
  return wat(strCharAt( rw, i32(gen(args[0]))), 'i32')
}

export const slice = (rw, args) => {
  ctx.usedStringType = true
  ctx.usedMemory = true
  const id = ctx.loopCounter++
  const str = `$_sslice_str_${id}`, idx = `$_sslice_i_${id}`, len = `$_sslice_len_${id}`, result = `$_sslice_result_${id}`, start = `$_sslice_start_${id}`, end = `$_sslice_end_${id}`, newLen = `$_sslice_newlen_${id}`
  ctx.addLocal(str.slice(1), 'string')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(result.slice(1), 'string')
  ctx.addLocal(start.slice(1), 'i32')
  ctx.addLocal(end.slice(1), 'i32')
  ctx.addLocal(newLen.slice(1), 'i32')

  const startArg = args.length >= 1 ? i32(gen(args[0])) : '(i32.const 0)'
  const endArg = args.length >= 2 ? i32(gen(args[1])) : strLen( `(local.get ${str})`)
  return wat(`(local.set ${str} ${rw})
    (local.set ${len} ${strLen( `(local.get ${str})`)})
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
    (local.set ${result} ${strNew( `(local.get ${newLen})`)})
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${newLen})))
      ${strSetChar( `(local.get ${result})`, `(local.get ${idx})`, strCharAt( `(local.get ${str})`, `(i32.add (local.get ${start}) (local.get ${idx}))`))}
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`, 'string')
}

export const indexOf = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedStringType = true
  ctx.usedMemory = true
  const searchVal = gen(args[0])
  const id = ctx.loopCounter++


  // String argument: find substring index
  if (searchVal.type === 'string') {
    const str = `$_sidx_str_${id}`, search = `$_sidx_search_${id}`, idx = `$_sidx_i_${id}`, len = `$_sidx_len_${id}`, searchLen = `$_sidx_slen_${id}`, result = `$_sidx_result_${id}`, j = `$_sidx_j_${id}`, match = `$_sidx_match_${id}`
    ctx.addLocal(str.slice(1), 'string')
    ctx.addLocal(search.slice(1), 'string')
    ctx.addLocal(idx.slice(1), 'i32')
    ctx.addLocal(len.slice(1), 'i32')
    ctx.addLocal(searchLen.slice(1), 'i32')
    ctx.addLocal(result.slice(1), 'i32')
    ctx.addLocal(j.slice(1), 'i32')
    ctx.addLocal(match.slice(1), 'i32')
    return wat(`(local.set ${str} ${rw})
      (local.set ${search} ${searchVal})
      (local.set ${len} ${strLen( `(local.get ${str})`)})
      (local.set ${searchLen} ${strLen( `(local.get ${search})`)})
      (local.set ${result} (i32.const -1))
      (if (i32.eqz (local.get ${searchLen}))
        (then (local.set ${result} (i32.const 0)))
        (else (if (i32.le_s (local.get ${searchLen}) (local.get ${len}))
          (then
            (local.set ${idx} (i32.const 0))
            (block $done_${id} (loop $loop_${id}
              (br_if $done_${id} (i32.gt_s (local.get ${idx}) (i32.sub (local.get ${len}) (local.get ${searchLen}))))
              (local.set ${match} (i32.const 1))
              (local.set ${j} (i32.const 0))
              (block $inner_done_${id} (loop $inner_loop_${id}
                (br_if $inner_done_${id} (i32.ge_s (local.get ${j}) (local.get ${searchLen})))
                (if (i32.ne ${strCharAt( `(local.get ${str})`, `(i32.add (local.get ${idx}) (local.get ${j}))`)} ${strCharAt( `(local.get ${search})`, `(local.get ${j})`)})
                  (then (local.set ${match} (i32.const 0)) (br $inner_done_${id})))
                (local.set ${j} (i32.add (local.get ${j}) (i32.const 1)))
                (br $inner_loop_${id})))
              (if (local.get ${match})
                (then (local.set ${result} (local.get ${idx})) (br $done_${id})))
              (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
              (br $loop_${id})))))))
      (local.get ${result})`, 'i32')
  }

  // Char code argument
  if (searchVal.type !== 'i32' && searchVal.type !== 'f64') return null
  const str = `$_sindexof_str_${id}`, idx = `$_sindexof_i_${id}`, len = `$_sindexof_len_${id}`, result = `$_sindexof_result_${id}`, target = `$_sindexof_target_${id}`
  ctx.addLocal(str.slice(1), 'string')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(result.slice(1), 'i32')
  ctx.addLocal(target.slice(1), 'i32')
  return wat(`(local.set ${str} ${rw})
    (local.set ${target} ${i32(searchVal)})
    (local.set ${len} ${strLen( `(local.get ${str})`)})
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const -1))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (if (i32.eq ${strCharAt( `(local.get ${str})`, `(local.get ${idx})`)} (local.get ${target}))
        (then
          (local.set ${result} (local.get ${idx}))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`, 'i32')
}

export const substring = (rw, args) => {
  if (args.length < 1) return null
  ctx.usedStringType = true
  ctx.usedMemory = true
  const id = ctx.loopCounter++
  const str = `$_substr_str_${id}`, idx = `$_substr_i_${id}`, len = `$_substr_len_${id}`, result = `$_substr_result_${id}`, start = `$_substr_start_${id}`, end = `$_substr_end_${id}`, newLen = `$_substr_newlen_${id}`
  ctx.addLocal(str.slice(1), 'string')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(result.slice(1), 'string')
  ctx.addLocal(start.slice(1), 'i32')
  ctx.addLocal(end.slice(1), 'i32')
  ctx.addLocal(newLen.slice(1), 'i32')

  const startArg = i32(gen(args[0]))
  const endArg = args.length >= 2 ? i32(gen(args[1])) : strLen( `(local.get ${str})`)
  return wat(`(local.set ${str} ${rw})
    (local.set ${len} ${strLen( `(local.get ${str})`)})
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
    (local.set ${result} ${strNew( `(local.get ${newLen})`)})
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${newLen})))
      ${strSetChar( `(local.get ${result})`, `(local.get ${idx})`, strCharAt( `(local.get ${str})`, `(i32.add (local.get ${start}) (local.get ${idx}))`))}
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`, 'string')
}

export const toLowerCase = (rw, args) => {
  ctx.usedStringType = true
  ctx.usedMemory = true
  const id = ctx.loopCounter++
  const str = `$_tolower_str_${id}`, idx = `$_tolower_i_${id}`, len = `$_tolower_len_${id}`, result = `$_tolower_result_${id}`, ch = `$_tolower_ch_${id}`
  ctx.addLocal(str.slice(1), 'string')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(result.slice(1), 'string')
  ctx.addLocal(ch.slice(1), 'i32')

  return wat(`(local.set ${str} ${rw})
    (local.set ${len} ${strLen( `(local.get ${str})`)})
    (local.set ${result} ${strNew( `(local.get ${len})`)})
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set ${ch} ${strCharAt( `(local.get ${str})`, `(local.get ${idx})`)})
      (if (i32.and (i32.ge_s (local.get ${ch}) (i32.const 65)) (i32.le_s (local.get ${ch}) (i32.const 90)))
        (then (local.set ${ch} (i32.add (local.get ${ch}) (i32.const 32)))))
      ${strSetChar( `(local.get ${result})`, `(local.get ${idx})`, `(local.get ${ch})`)}
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`, 'string')
}

export const toUpperCase = (rw, args) => {
  ctx.usedStringType = true
  ctx.usedMemory = true
  const id = ctx.loopCounter++
  const str = `$_toupper_str_${id}`, idx = `$_toupper_i_${id}`, len = `$_toupper_len_${id}`, result = `$_toupper_result_${id}`, ch = `$_toupper_ch_${id}`
  ctx.addLocal(str.slice(1), 'string')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(result.slice(1), 'string')
  ctx.addLocal(ch.slice(1), 'i32')

  return wat(`(local.set ${str} ${rw})
    (local.set ${len} ${strLen( `(local.get ${str})`)})
    (local.set ${result} ${strNew( `(local.get ${len})`)})
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set ${ch} ${strCharAt( `(local.get ${str})`, `(local.get ${idx})`)})
      (if (i32.and (i32.ge_s (local.get ${ch}) (i32.const 97)) (i32.le_s (local.get ${ch}) (i32.const 122)))
        (then (local.set ${ch} (i32.sub (local.get ${ch}) (i32.const 32)))))
      ${strSetChar( `(local.get ${result})`, `(local.get ${idx})`, `(local.get ${ch})`)}
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`, 'string')
}

export const includes = (rw, args) => {
  if (args.length < 1) return null
  ctx.usedStringType = true
  ctx.usedMemory = true
  const searchVal = gen(args[0])
  const id = ctx.loopCounter++


  // String argument: check if substring exists
  if (searchVal.type === 'string') {
    const str = `$_sincl_str_${id}`, search = `$_sincl_search_${id}`, idx = `$_sincl_i_${id}`, len = `$_sincl_len_${id}`, searchLen = `$_sincl_slen_${id}`, result = `$_sincl_result_${id}`, j = `$_sincl_j_${id}`, match = `$_sincl_match_${id}`
    ctx.addLocal(str.slice(1), 'string')
    ctx.addLocal(search.slice(1), 'string')
    ctx.addLocal(idx.slice(1), 'i32')
    ctx.addLocal(len.slice(1), 'i32')
    ctx.addLocal(searchLen.slice(1), 'i32')
    ctx.addLocal(result.slice(1), 'i32')
    ctx.addLocal(j.slice(1), 'i32')
    ctx.addLocal(match.slice(1), 'i32')
    return wat(`(local.set ${str} ${rw})
      (local.set ${search} ${searchVal})
      (local.set ${len} ${strLen( `(local.get ${str})`)})
      (local.set ${searchLen} ${strLen( `(local.get ${search})`)})
      (local.set ${result} (i32.const 0))
      (if (i32.eqz (local.get ${searchLen}))
        (then (local.set ${result} (i32.const 1)))
        (else (if (i32.le_s (local.get ${searchLen}) (local.get ${len}))
          (then
            (local.set ${idx} (i32.const 0))
            (block $done_${id} (loop $loop_${id}
              (br_if $done_${id} (i32.gt_s (local.get ${idx}) (i32.sub (local.get ${len}) (local.get ${searchLen}))))
              (local.set ${match} (i32.const 1))
              (local.set ${j} (i32.const 0))
              (block $inner_done_${id} (loop $inner_loop_${id}
                (br_if $inner_done_${id} (i32.ge_s (local.get ${j}) (local.get ${searchLen})))
                (if (i32.ne ${strCharAt( `(local.get ${str})`, `(i32.add (local.get ${idx}) (local.get ${j}))`)} ${strCharAt( `(local.get ${search})`, `(local.get ${j})`)})
                  (then (local.set ${match} (i32.const 0)) (br $inner_done_${id})))
                (local.set ${j} (i32.add (local.get ${j}) (i32.const 1)))
                (br $inner_loop_${id})))
              (if (local.get ${match})
                (then (local.set ${result} (i32.const 1)) (br $done_${id})))
              (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
              (br $loop_${id})))))))
      (local.get ${result})`, 'i32')
  }

  // Char code argument
  if (searchVal.type !== 'i32' && searchVal.type !== 'f64') return null
  const str = `$_sincludes_str_${id}`, idx = `$_sincludes_i_${id}`, len = `$_sincludes_len_${id}`, target = `$_sincludes_target_${id}`, result = `$_sincludes_result_${id}`
  ctx.addLocal(str.slice(1), 'string')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(target.slice(1), 'i32')
  ctx.addLocal(result.slice(1), 'i32')
  return wat(`(local.set ${str} ${rw})
    (local.set ${target} ${i32(searchVal)})
    (local.set ${len} ${strLen( `(local.get ${str})`)})
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (if (i32.eq ${strCharAt( `(local.get ${str})`, `(local.get ${idx})`)} (local.get ${target}))
        (then
          (local.set ${result} (i32.const 1))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`, 'i32')
}

export const startsWith = (rw, args) => {
  if (args.length < 1) return null
  ctx.usedStringType = true
  ctx.usedMemory = true
  const searchVal = gen(args[0])
  const id = ctx.loopCounter++


  // String argument: check prefix
  if (searchVal.type === 'string') {
    const str = `$_starts_str_${id}`, search = `$_starts_search_${id}`, idx = `$_starts_i_${id}`, len = `$_starts_len_${id}`, searchLen = `$_starts_slen_${id}`, result = `$_starts_result_${id}`
    ctx.addLocal(str.slice(1), 'string')
    ctx.addLocal(search.slice(1), 'string')
    ctx.addLocal(idx.slice(1), 'i32')
    ctx.addLocal(len.slice(1), 'i32')
    ctx.addLocal(searchLen.slice(1), 'i32')
    ctx.addLocal(result.slice(1), 'i32')
    return wat(`(local.set ${str} ${rw})
      (local.set ${search} ${searchVal})
      (local.set ${len} ${strLen( `(local.get ${str})`)})
      (local.set ${searchLen} ${strLen( `(local.get ${search})`)})
      (local.set ${result} (i32.const 1))
      (if (i32.gt_s (local.get ${searchLen}) (local.get ${len}))
        (then (local.set ${result} (i32.const 0)))
        (else
          (local.set ${idx} (i32.const 0))
          (block $done_${id} (loop $loop_${id}
            (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${searchLen})))
            (if (i32.ne ${strCharAt( `(local.get ${str})`, `(local.get ${idx})`)} ${strCharAt( `(local.get ${search})`, `(local.get ${idx})`)})
              (then (local.set ${result} (i32.const 0)) (br $done_${id})))
            (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
            (br $loop_${id})))))
      (local.get ${result})`, 'i32')
  }

  // Char code argument (backward compat)
  if (searchVal.type !== 'i32' && searchVal.type !== 'f64') return null
  const str = `$_starts_str_${id}`, ch = `$_starts_ch_${id}`, target = `$_starts_target_${id}`
  ctx.addLocal(str.slice(1), 'string')
  ctx.addLocal(ch.slice(1), 'i32')
  ctx.addLocal(target.slice(1), 'i32')
  return wat(`(local.set ${str} ${rw})
    (local.set ${target} ${i32(searchVal)})
    (local.set ${ch} (if (result i32) (i32.gt_s ${strLen( `(local.get ${str})`)} (i32.const 0))
      (then ${strCharAt( `(local.get ${str})`, '(i32.const 0)')})
      (else (i32.const -1))))
    (i32.eq (local.get ${ch}) (local.get ${target}))`, 'i32')
}

export const endsWith = (rw, args) => {
  if (args.length < 1) return null
  ctx.usedStringType = true
  ctx.usedMemory = true
  const searchVal = gen(args[0])
  const id = ctx.loopCounter++


  // String argument: check suffix
  if (searchVal.type === 'string') {
    const str = `$_ends_str_${id}`, search = `$_ends_search_${id}`, idx = `$_ends_i_${id}`, len = `$_ends_len_${id}`, searchLen = `$_ends_slen_${id}`, result = `$_ends_result_${id}`, offset = `$_ends_offset_${id}`
    ctx.addLocal(str.slice(1), 'string')
    ctx.addLocal(search.slice(1), 'string')
    ctx.addLocal(idx.slice(1), 'i32')
    ctx.addLocal(len.slice(1), 'i32')
    ctx.addLocal(searchLen.slice(1), 'i32')
    ctx.addLocal(result.slice(1), 'i32')
    ctx.addLocal(offset.slice(1), 'i32')
    return wat(`(local.set ${str} ${rw})
      (local.set ${search} ${searchVal})
      (local.set ${len} ${strLen( `(local.get ${str})`)})
      (local.set ${searchLen} ${strLen( `(local.get ${search})`)})
      (local.set ${result} (i32.const 1))
      (if (i32.gt_s (local.get ${searchLen}) (local.get ${len}))
        (then (local.set ${result} (i32.const 0)))
        (else
          (local.set ${offset} (i32.sub (local.get ${len}) (local.get ${searchLen})))
          (local.set ${idx} (i32.const 0))
          (block $done_${id} (loop $loop_${id}
            (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${searchLen})))
            (if (i32.ne ${strCharAt( `(local.get ${str})`, `(i32.add (local.get ${offset}) (local.get ${idx}))`)} ${strCharAt( `(local.get ${search})`, `(local.get ${idx})`)})
              (then (local.set ${result} (i32.const 0)) (br $done_${id})))
            (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
            (br $loop_${id})))))
      (local.get ${result})`, 'i32')
  }

  // Char code argument (backward compat)
  if (searchVal.type !== 'i32' && searchVal.type !== 'f64') return null
  const str = `$_ends_str_${id}`, ch = `$_ends_ch_${id}`, target = `$_ends_target_${id}`, len = `$_ends_len_${id}`
  ctx.addLocal(str.slice(1), 'string')
  ctx.addLocal(ch.slice(1), 'i32')
  ctx.addLocal(target.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  return wat(`(local.set ${str} ${rw})
    (local.set ${target} ${i32(searchVal)})
    (local.set ${len} ${strLen( `(local.get ${str})`)})
    (local.set ${ch} (if (result i32) (i32.gt_s (local.get ${len}) (i32.const 0))
      (then ${strCharAt( `(local.get ${str})`, `(i32.sub (local.get ${len}) (i32.const 1))`)})
      (else (i32.const -1))))
    (i32.eq (local.get ${ch}) (local.get ${target}))`, 'i32')
}

export const trim = (rw, args) => {
  ctx.usedStringType = true
  ctx.usedMemory = true
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

  return wat(`(local.set ${str} ${rw})
    (local.set ${len} ${strLen( `(local.get ${str})`)})
    (local.set ${start} (i32.const 0))
    (local.set ${end} (local.get ${len}))
    ;; Find start
    (block $start_done_${id} (loop $start_loop_${id}
      (br_if $start_done_${id} (i32.ge_s (local.get ${start}) (local.get ${len})))
      (local.set ${ch} ${strCharAt( `(local.get ${str})`, `(local.get ${start})`)})
      (br_if $start_done_${id} (i32.and (i32.ne (local.get ${ch}) (i32.const 32)) (i32.and (i32.ne (local.get ${ch}) (i32.const 9)) (i32.and (i32.ne (local.get ${ch}) (i32.const 10)) (i32.ne (local.get ${ch}) (i32.const 13))))))
      (local.set ${start} (i32.add (local.get ${start}) (i32.const 1)))
      (br $start_loop_${id})))
    ;; Find end
    (block $end_done_${id} (loop $end_loop_${id}
      (br_if $end_done_${id} (i32.le_s (local.get ${end}) (local.get ${start})))
      (local.set ${ch} ${strCharAt( `(local.get ${str})`, `(i32.sub (local.get ${end}) (i32.const 1))`)})
      (br_if $end_done_${id} (i32.and (i32.ne (local.get ${ch}) (i32.const 32)) (i32.and (i32.ne (local.get ${ch}) (i32.const 9)) (i32.and (i32.ne (local.get ${ch}) (i32.const 10)) (i32.ne (local.get ${ch}) (i32.const 13))))))
      (local.set ${end} (i32.sub (local.get ${end}) (i32.const 1)))
      (br $end_loop_${id})))
    (local.set ${newLen} (i32.sub (local.get ${end}) (local.get ${start})))
    (local.set ${result} ${strNew( `(local.get ${newLen})`)})
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${newLen})))
      ${strSetChar( `(local.get ${result})`, `(local.get ${idx})`, strCharAt( `(local.get ${str})`, `(i32.add (local.get ${start}) (local.get ${idx}))`))}
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`, 'string')
}

// split(separator) - split string by separator, returns array of strings
export const split = (rw, args) => {
  if (args.length < 1) return null
  ctx.usedStringType = true
  ctx.usedArrayType = true
  ctx.usedMemory = true
  const sepVal = gen(args[0])
  const id = ctx.loopCounter++


  // String separator
  if (sepVal.type === 'string') {

    const str = `$_split_str_${id}`, sep = `$_split_sep_${id}`, len = `$_split_len_${id}`, sepLen = `$_split_slen_${id}`
    const idx = `$_split_i_${id}`, count = `$_split_count_${id}`, start = `$_split_start_${id}`, result = `$_split_result_${id}`
    const j = `$_split_j_${id}`, match = `$_split_match_${id}`, part = `$_split_part_${id}`, partLen = `$_split_plen_${id}`, k = `$_split_k_${id}`, arrIdx = `$_split_arri_${id}`
    ctx.addLocal(str.slice(1), 'string')
    ctx.addLocal(sep.slice(1), 'string')
    ctx.addLocal(len.slice(1), 'i32')
    ctx.addLocal(sepLen.slice(1), 'i32')
    ctx.addLocal(idx.slice(1), 'i32')
    ctx.addLocal(count.slice(1), 'i32')
    ctx.addLocal(start.slice(1), 'i32')
    ctx.addLocal(result.slice(1), 'f64')
    ctx.addLocal(j.slice(1), 'i32')
    ctx.addLocal(match.slice(1), 'i32')
    ctx.addLocal(part.slice(1), 'string')
    ctx.addLocal(partLen.slice(1), 'i32')
    ctx.addLocal(k.slice(1), 'i32')
    ctx.addLocal(arrIdx.slice(1), 'i32')

    const arrNew = `(call $__alloc (i32.const ${PTR_TYPE.REF_ARRAY}) (local.get ${count}))`
    const arrSet = `(f64.store (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (local.get ${arrIdx}) (i32.const 3))) (local.get ${part}))`

    return wat(`(local.set ${str} ${rw})
      (local.set ${sep} ${sepVal})
      (local.set ${len} ${strLen(`(local.get ${str})`)})
      (local.set ${sepLen} ${strLen( `(local.get ${sep})`)})
      ;; Count parts first
      (if (i32.eqz (local.get ${sepLen}))
        (then (local.set ${count} (local.get ${len})))  ;; empty sep: one part per char
        (else
          (local.set ${count} (i32.const 1))
          (local.set ${idx} (i32.const 0))
          (block $cnt_done_${id} (loop $cnt_loop_${id}
            (br_if $cnt_done_${id} (i32.gt_s (local.get ${idx}) (i32.sub (local.get ${len}) (local.get ${sepLen}))))
            (local.set ${match} (i32.const 1))
            (local.set ${j} (i32.const 0))
            (block $m_done_${id} (loop $m_loop_${id}
              (br_if $m_done_${id} (i32.ge_s (local.get ${j}) (local.get ${sepLen})))
              (if (i32.ne ${strCharAt( `(local.get ${str})`, `(i32.add (local.get ${idx}) (local.get ${j}))`)} ${strCharAt( `(local.get ${sep})`, `(local.get ${j})`)})
                (then (local.set ${match} (i32.const 0)) (br $m_done_${id})))
              (local.set ${j} (i32.add (local.get ${j}) (i32.const 1)))
              (br $m_loop_${id})))
            (if (local.get ${match})
              (then
                (local.set ${count} (i32.add (local.get ${count}) (i32.const 1)))
                (local.set ${idx} (i32.add (local.get ${idx}) (local.get ${sepLen})))
              )
              (else (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))))
            (br $cnt_loop_${id})))))
      ;; Create result array and fill
      (local.set ${result} ${arrNew})
      (local.set ${start} (i32.const 0))
      (local.set ${arrIdx} (i32.const 0))
      (if (i32.eqz (local.get ${sepLen}))
        (then
          ;; Empty separator: split into individual chars
          (local.set ${idx} (i32.const 0))
          (block $char_done_${id} (loop $char_loop_${id}
            (br_if $char_done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
            (local.set ${part} ${strNew( '(i32.const 1)')})
            ${strSetChar( `(local.get ${part})`, '(i32.const 0)', strCharAt( `(local.get ${str})`, `(local.get ${idx})`))}
            ${arrSet}
            (local.set ${arrIdx} (i32.add (local.get ${arrIdx}) (i32.const 1)))
            (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
            (br $char_loop_${id}))))
        (else
          (local.set ${idx} (i32.const 0))
          (block $fill_done_${id} (loop $fill_loop_${id}
            (br_if $fill_done_${id} (i32.gt_s (local.get ${idx}) (i32.sub (local.get ${len}) (local.get ${sepLen}))))
            (local.set ${match} (i32.const 1))
            (local.set ${j} (i32.const 0))
            (block $fm_done_${id} (loop $fm_loop_${id}
              (br_if $fm_done_${id} (i32.ge_s (local.get ${j}) (local.get ${sepLen})))
              (if (i32.ne ${strCharAt( `(local.get ${str})`, `(i32.add (local.get ${idx}) (local.get ${j}))`)} ${strCharAt( `(local.get ${sep})`, `(local.get ${j})`)})
                (then (local.set ${match} (i32.const 0)) (br $fm_done_${id})))
              (local.set ${j} (i32.add (local.get ${j}) (i32.const 1)))
              (br $fm_loop_${id})))
            (if (local.get ${match})
              (then
                ;; Found separator - extract part
                (local.set ${partLen} (i32.sub (local.get ${idx}) (local.get ${start})))
                (local.set ${part} ${strNew( `(local.get ${partLen})`)})
                (local.set ${k} (i32.const 0))
                (block $cpy_done_${id} (loop $cpy_loop_${id}
                  (br_if $cpy_done_${id} (i32.ge_s (local.get ${k}) (local.get ${partLen})))
                  ${strSetChar( `(local.get ${part})`, `(local.get ${k})`, strCharAt( `(local.get ${str})`, `(i32.add (local.get ${start}) (local.get ${k}))`))}
                  (local.set ${k} (i32.add (local.get ${k}) (i32.const 1)))
                  (br $cpy_loop_${id})))
                ${arrSet}
                (local.set ${arrIdx} (i32.add (local.get ${arrIdx}) (i32.const 1)))
                (local.set ${start} (i32.add (local.get ${idx}) (local.get ${sepLen})))
                (local.set ${idx} (local.get ${start})))
              (else (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))))
            (br $fill_loop_${id})))
          ;; Last part
          (local.set ${partLen} (i32.sub (local.get ${len}) (local.get ${start})))
          (local.set ${part} ${strNew( `(local.get ${partLen})`)})
          (local.set ${k} (i32.const 0))
          (block $last_done_${id} (loop $last_loop_${id}
            (br_if $last_done_${id} (i32.ge_s (local.get ${k}) (local.get ${partLen})))
            ${strSetChar( `(local.get ${part})`, `(local.get ${k})`, strCharAt( `(local.get ${str})`, `(i32.add (local.get ${start}) (local.get ${k}))`))}
            (local.set ${k} (i32.add (local.get ${k}) (i32.const 1)))
            (br $last_loop_${id})))
          ${arrSet}))
      (local.get ${result})`, 'f64', { uniformType: 'string' })
  }

  // Char code separator
  if (sepVal.type === 'i32' || sepVal.type === 'f64') {

    const str = `$_split_str_${id}`, sepChar = `$_split_sep_${id}`, len = `$_split_len_${id}`
    const idx = `$_split_i_${id}`, count = `$_split_count_${id}`, start = `$_split_start_${id}`, result = `$_split_result_${id}`
    const part = `$_split_part_${id}`, partLen = `$_split_plen_${id}`, k = `$_split_k_${id}`, arrIdx = `$_split_arri_${id}`
    ctx.addLocal(str.slice(1), 'string')
    ctx.addLocal(sepChar.slice(1), 'i32')
    ctx.addLocal(len.slice(1), 'i32')
    ctx.addLocal(idx.slice(1), 'i32')
    ctx.addLocal(count.slice(1), 'i32')
    ctx.addLocal(start.slice(1), 'i32')
    ctx.addLocal(result.slice(1), 'f64')
    ctx.addLocal(part.slice(1), 'string')
    ctx.addLocal(partLen.slice(1), 'i32')
    ctx.addLocal(k.slice(1), 'i32')
    ctx.addLocal(arrIdx.slice(1), 'i32')

    const arrNew = `(call $__alloc (i32.const ${PTR_TYPE.REF_ARRAY}) (local.get ${count}))`
    const arrSet = `(f64.store (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (local.get ${arrIdx}) (i32.const 3))) (local.get ${part}))`

    return wat(`(local.set ${str} ${rw})
      (local.set ${sepChar} ${i32(sepVal)})
      (local.set ${len} ${strLen(`(local.get ${str})`)})
      ;; Count parts
      (local.set ${count} (i32.const 1))
      (local.set ${idx} (i32.const 0))
      (block $cnt_done_${id} (loop $cnt_loop_${id}
        (br_if $cnt_done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
        (if (i32.eq ${strCharAt( `(local.get ${str})`, `(local.get ${idx})`)} (local.get ${sepChar}))
          (then (local.set ${count} (i32.add (local.get ${count}) (i32.const 1)))))
        (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
        (br $cnt_loop_${id})))
      ;; Create and fill array
      (local.set ${result} ${arrNew})
      (local.set ${start} (i32.const 0))
      (local.set ${arrIdx} (i32.const 0))
      (local.set ${idx} (i32.const 0))
      (block $fill_done_${id} (loop $fill_loop_${id}
        (br_if $fill_done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
        (if (i32.eq ${strCharAt( `(local.get ${str})`, `(local.get ${idx})`)} (local.get ${sepChar}))
          (then
            (local.set ${partLen} (i32.sub (local.get ${idx}) (local.get ${start})))
            (local.set ${part} ${strNew( `(local.get ${partLen})`)})
            (local.set ${k} (i32.const 0))
            (block $cpy_done_${id} (loop $cpy_loop_${id}
              (br_if $cpy_done_${id} (i32.ge_s (local.get ${k}) (local.get ${partLen})))
              ${strSetChar( `(local.get ${part})`, `(local.get ${k})`, strCharAt( `(local.get ${str})`, `(i32.add (local.get ${start}) (local.get ${k}))`))}
              (local.set ${k} (i32.add (local.get ${k}) (i32.const 1)))
              (br $cpy_loop_${id})))
            ${arrSet}
            (local.set ${arrIdx} (i32.add (local.get ${arrIdx}) (i32.const 1)))
            (local.set ${start} (i32.add (local.get ${idx}) (i32.const 1)))))
        (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
        (br $fill_loop_${id})))
      ;; Last part
      (local.set ${partLen} (i32.sub (local.get ${len}) (local.get ${start})))
      (local.set ${part} ${strNew( `(local.get ${partLen})`)})
      (local.set ${k} (i32.const 0))
      (block $last_done_${id} (loop $last_loop_${id}
        (br_if $last_done_${id} (i32.ge_s (local.get ${k}) (local.get ${partLen})))
        ${strSetChar( `(local.get ${part})`, `(local.get ${k})`, strCharAt( `(local.get ${str})`, `(i32.add (local.get ${start}) (local.get ${k}))`))}
        (local.set ${k} (i32.add (local.get ${k}) (i32.const 1)))
        (br $last_loop_${id})))
      ${arrSet}
      (local.get ${result})`, 'f64', { uniformType: 'string' })
  }

  return null
}

// replace(search, replacement) - replace first occurrence
export const replace = (rw, args) => {
  if (args.length < 2) return wat(rw, 'string')
  ctx.usedStringType = true
  ctx.usedMemory = true
  const searchVal = gen(args[0])
  const replaceVal = gen(args[1])
  const id = ctx.loopCounter++


  // String search, string replacement
  if (searchVal.type === 'string' && replaceVal.type === 'string') {
    const str = `$_repl_str_${id}`, search = `$_repl_search_${id}`, repl = `$_repl_repl_${id}`
    const len = `$_repl_len_${id}`, searchLen = `$_repl_slen_${id}`, replLen = `$_repl_rlen_${id}`
    const idx = `$_repl_i_${id}`, j = `$_repl_j_${id}`, match = `$_repl_match_${id}`
    const result = `$_repl_result_${id}`, newLen = `$_repl_newlen_${id}`, k = `$_repl_k_${id}`, foundIdx = `$_repl_found_${id}`
    ctx.addLocal(str.slice(1), 'string')
    ctx.addLocal(search.slice(1), 'string')
    ctx.addLocal(repl.slice(1), 'string')
    ctx.addLocal(len.slice(1), 'i32')
    ctx.addLocal(searchLen.slice(1), 'i32')
    ctx.addLocal(replLen.slice(1), 'i32')
    ctx.addLocal(idx.slice(1), 'i32')
    ctx.addLocal(j.slice(1), 'i32')
    ctx.addLocal(match.slice(1), 'i32')
    ctx.addLocal(result.slice(1), 'string')
    ctx.addLocal(newLen.slice(1), 'i32')
    ctx.addLocal(k.slice(1), 'i32')
    ctx.addLocal(foundIdx.slice(1), 'i32')

    return wat(`(local.set ${str} ${rw})
      (local.set ${search} ${searchVal})
      (local.set ${repl} ${replaceVal})
      (local.set ${len} ${strLen( `(local.get ${str})`)})
      (local.set ${searchLen} ${strLen( `(local.get ${search})`)})
      (local.set ${replLen} ${strLen( `(local.get ${repl})`)})
      (local.set ${foundIdx} (i32.const -1))
      ;; Find first occurrence
      (if (i32.and (i32.gt_s (local.get ${searchLen}) (i32.const 0)) (i32.le_s (local.get ${searchLen}) (local.get ${len})))
        (then
          (local.set ${idx} (i32.const 0))
          (block $find_done_${id} (loop $find_loop_${id}
            (br_if $find_done_${id} (i32.gt_s (local.get ${idx}) (i32.sub (local.get ${len}) (local.get ${searchLen}))))
            (local.set ${match} (i32.const 1))
            (local.set ${j} (i32.const 0))
            (block $m_done_${id} (loop $m_loop_${id}
              (br_if $m_done_${id} (i32.ge_s (local.get ${j}) (local.get ${searchLen})))
              (if (i32.ne ${strCharAt( `(local.get ${str})`, `(i32.add (local.get ${idx}) (local.get ${j}))`)} ${strCharAt( `(local.get ${search})`, `(local.get ${j})`)})
                (then (local.set ${match} (i32.const 0)) (br $m_done_${id})))
              (local.set ${j} (i32.add (local.get ${j}) (i32.const 1)))
              (br $m_loop_${id})))
            (if (local.get ${match})
              (then (local.set ${foundIdx} (local.get ${idx})) (br $find_done_${id})))
            (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
            (br $find_loop_${id})))))
      ;; Build result
      (if (i32.lt_s (local.get ${foundIdx}) (i32.const 0))
        (then (local.set ${result} (local.get ${str})))
        (else
          (local.set ${newLen} (i32.add (i32.sub (local.get ${len}) (local.get ${searchLen})) (local.get ${replLen})))
          (local.set ${result} ${strNew( `(local.get ${newLen})`)})
          ;; Copy before
          (local.set ${k} (i32.const 0))
          (block $b_done_${id} (loop $b_loop_${id}
            (br_if $b_done_${id} (i32.ge_s (local.get ${k}) (local.get ${foundIdx})))
            ${strSetChar( `(local.get ${result})`, `(local.get ${k})`, strCharAt( `(local.get ${str})`, `(local.get ${k})`))}
            (local.set ${k} (i32.add (local.get ${k}) (i32.const 1)))
            (br $b_loop_${id})))
          ;; Copy replacement
          (local.set ${k} (i32.const 0))
          (block $r_done_${id} (loop $r_loop_${id}
            (br_if $r_done_${id} (i32.ge_s (local.get ${k}) (local.get ${replLen})))
            ${strSetChar( `(local.get ${result})`, `(i32.add (local.get ${foundIdx}) (local.get ${k}))`, strCharAt( `(local.get ${repl})`, `(local.get ${k})`))}
            (local.set ${k} (i32.add (local.get ${k}) (i32.const 1)))
            (br $r_loop_${id})))
          ;; Copy after
          (local.set ${idx} (i32.add (local.get ${foundIdx}) (local.get ${searchLen})))
          (local.set ${k} (i32.const 0))
          (block $a_done_${id} (loop $a_loop_${id}
            (br_if $a_done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
            ${strSetChar( `(local.get ${result})`, `(i32.add (i32.add (local.get ${foundIdx}) (local.get ${replLen})) (local.get ${k}))`, strCharAt( `(local.get ${str})`, `(local.get ${idx})`))}
            (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
            (local.set ${k} (i32.add (local.get ${k}) (i32.const 1)))
            (br $a_loop_${id})))))
      (local.get ${result})`, 'string')
  }

  // Char code search, string replacement
  if ((searchVal.type === 'i32' || searchVal.type === 'f64') && replaceVal.type === 'string') {
    const str = `$_repl_str_${id}`, searchChar = `$_repl_sch_${id}`, repl = `$_repl_repl_${id}`
    const len = `$_repl_len_${id}`, replLen = `$_repl_rlen_${id}`
    const idx = `$_repl_i_${id}`, result = `$_repl_result_${id}`, newLen = `$_repl_newlen_${id}`, k = `$_repl_k_${id}`, foundIdx = `$_repl_found_${id}`
    ctx.addLocal(str.slice(1), 'string')
    ctx.addLocal(searchChar.slice(1), 'i32')
    ctx.addLocal(repl.slice(1), 'string')
    ctx.addLocal(len.slice(1), 'i32')
    ctx.addLocal(replLen.slice(1), 'i32')
    ctx.addLocal(idx.slice(1), 'i32')
    ctx.addLocal(result.slice(1), 'string')
    ctx.addLocal(newLen.slice(1), 'i32')
    ctx.addLocal(k.slice(1), 'i32')
    ctx.addLocal(foundIdx.slice(1), 'i32')

    return wat(`(local.set ${str} ${rw})
      (local.set ${searchChar} ${i32(searchVal)})
      (local.set ${repl} ${replaceVal})
      (local.set ${len} ${strLen( `(local.get ${str})`)})
      (local.set ${replLen} ${strLen( `(local.get ${repl})`)})
      (local.set ${foundIdx} (i32.const -1))
      ;; Find first char
      (local.set ${idx} (i32.const 0))
      (block $find_done_${id} (loop $find_loop_${id}
        (br_if $find_done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
        (if (i32.eq ${strCharAt( `(local.get ${str})`, `(local.get ${idx})`)} (local.get ${searchChar}))
          (then (local.set ${foundIdx} (local.get ${idx})) (br $find_done_${id})))
        (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
        (br $find_loop_${id})))
      ;; Build result
      (if (i32.lt_s (local.get ${foundIdx}) (i32.const 0))
        (then (local.set ${result} (local.get ${str})))
        (else
          (local.set ${newLen} (i32.add (i32.sub (local.get ${len}) (i32.const 1)) (local.get ${replLen})))
          (local.set ${result} ${strNew( `(local.get ${newLen})`)})
          ;; Copy before
          (local.set ${k} (i32.const 0))
          (block $b_done_${id} (loop $b_loop_${id}
            (br_if $b_done_${id} (i32.ge_s (local.get ${k}) (local.get ${foundIdx})))
            ${strSetChar( `(local.get ${result})`, `(local.get ${k})`, strCharAt( `(local.get ${str})`, `(local.get ${k})`))}
            (local.set ${k} (i32.add (local.get ${k}) (i32.const 1)))
            (br $b_loop_${id})))
          ;; Copy replacement
          (local.set ${k} (i32.const 0))
          (block $r_done_${id} (loop $r_loop_${id}
            (br_if $r_done_${id} (i32.ge_s (local.get ${k}) (local.get ${replLen})))
            ${strSetChar( `(local.get ${result})`, `(i32.add (local.get ${foundIdx}) (local.get ${k}))`, strCharAt( `(local.get ${repl})`, `(local.get ${k})`))}
            (local.set ${k} (i32.add (local.get ${k}) (i32.const 1)))
            (br $r_loop_${id})))
          ;; Copy after
          (local.set ${idx} (i32.add (local.get ${foundIdx}) (i32.const 1)))
          (local.set ${k} (i32.const 0))
          (block $a_done_${id} (loop $a_loop_${id}
            (br_if $a_done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
            ${strSetChar( `(local.get ${result})`, `(i32.add (i32.add (local.get ${foundIdx}) (local.get ${replLen})) (local.get ${k}))`, strCharAt( `(local.get ${str})`, `(local.get ${idx})`))}
            (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
            (local.set ${k} (i32.add (local.get ${k}) (i32.const 1)))
            (br $a_loop_${id})))))
      (local.get ${result})`, 'string')
  }

  return wat(rw, 'string')
}

// substr(start, length) - deprecated but common
export const substr = (rw, args) => {
  if (args.length < 1) return null
  ctx.usedStringType = true
  ctx.usedMemory = true
  const id = ctx.loopCounter++
  const str = `$_substr_str_${id}`, idx = `$_substr_i_${id}`, len = `$_substr_len_${id}`, result = `$_substr_result_${id}`, start = `$_substr_start_${id}`, subLen = `$_substr_sublen_${id}`, newLen = `$_substr_newlen_${id}`
  ctx.addLocal(str.slice(1), 'string')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(result.slice(1), 'string')
  ctx.addLocal(start.slice(1), 'i32')
  ctx.addLocal(subLen.slice(1), 'i32')
  ctx.addLocal(newLen.slice(1), 'i32')

  const startArg = i32(gen(args[0]))
  const lenArg = args.length >= 2 ? i32(gen(args[1])) : `(i32.sub (local.get ${len}) (local.get ${start}))`
  return wat(`(local.set ${str} ${rw})
    (local.set ${len} ${strLen( `(local.get ${str})`)})
    (local.set ${start} ${startArg})
    ;; Handle negative start
    (if (i32.lt_s (local.get ${start}) (i32.const 0))
      (then (local.set ${start} (i32.add (local.get ${len}) (local.get ${start})))))
    (if (i32.lt_s (local.get ${start}) (i32.const 0)) (then (local.set ${start} (i32.const 0))))
    (local.set ${subLen} ${lenArg})
    (if (i32.lt_s (local.get ${subLen}) (i32.const 0)) (then (local.set ${subLen} (i32.const 0))))
    ;; Clamp to remaining length
    (local.set ${newLen} (i32.sub (local.get ${len}) (local.get ${start})))
    (if (i32.gt_s (local.get ${subLen}) (local.get ${newLen})) (then (local.set ${subLen} (local.get ${newLen}))))
    (if (i32.lt_s (local.get ${subLen}) (i32.const 0)) (then (local.set ${subLen} (i32.const 0))))
    (local.set ${result} ${strNew( `(local.get ${subLen})`)})
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${subLen})))
      ${strSetChar( `(local.get ${result})`, `(local.get ${idx})`, strCharAt( `(local.get ${str})`, `(i32.add (local.get ${start}) (local.get ${idx}))`))}
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`, 'string')
}

// trimStart - remove leading whitespace
export const trimStart = (rw, args) => {
  ctx.usedStringType = true
  ctx.usedMemory = true
  const id = ctx.loopCounter++
  const str = `$_trimS_str_${id}`, idx = `$_trimS_i_${id}`, len = `$_trimS_len_${id}`, result = `$_trimS_result_${id}`, start = `$_trimS_start_${id}`, ch = `$_trimS_ch_${id}`, newLen = `$_trimS_newlen_${id}`
  ctx.addLocal(str.slice(1), 'string')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(result.slice(1), 'string')
  ctx.addLocal(start.slice(1), 'i32')
  ctx.addLocal(ch.slice(1), 'i32')
  ctx.addLocal(newLen.slice(1), 'i32')

  return wat(`(local.set ${str} ${rw})
    (local.set ${len} ${strLen( `(local.get ${str})`)})
    (local.set ${start} (i32.const 0))
    (block $start_done_${id} (loop $start_loop_${id}
      (br_if $start_done_${id} (i32.ge_s (local.get ${start}) (local.get ${len})))
      (local.set ${ch} ${strCharAt( `(local.get ${str})`, `(local.get ${start})`)})
      (br_if $start_done_${id} (i32.and (i32.ne (local.get ${ch}) (i32.const 32)) (i32.and (i32.ne (local.get ${ch}) (i32.const 9)) (i32.and (i32.ne (local.get ${ch}) (i32.const 10)) (i32.ne (local.get ${ch}) (i32.const 13))))))
      (local.set ${start} (i32.add (local.get ${start}) (i32.const 1)))
      (br $start_loop_${id})))
    (local.set ${newLen} (i32.sub (local.get ${len}) (local.get ${start})))
    (local.set ${result} ${strNew( `(local.get ${newLen})`)})
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${newLen})))
      ${strSetChar( `(local.get ${result})`, `(local.get ${idx})`, strCharAt( `(local.get ${str})`, `(i32.add (local.get ${start}) (local.get ${idx}))`))}
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`, 'string')
}

// trimEnd - remove trailing whitespace
export const trimEnd = (rw, args) => {
  ctx.usedStringType = true
  ctx.usedMemory = true
  const id = ctx.loopCounter++
  const str = `$_trimE_str_${id}`, idx = `$_trimE_i_${id}`, len = `$_trimE_len_${id}`, result = `$_trimE_result_${id}`, end = `$_trimE_end_${id}`, ch = `$_trimE_ch_${id}`
  ctx.addLocal(str.slice(1), 'string')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(result.slice(1), 'string')
  ctx.addLocal(end.slice(1), 'i32')
  ctx.addLocal(ch.slice(1), 'i32')

  return wat(`(local.set ${str} ${rw})
    (local.set ${len} ${strLen( `(local.get ${str})`)})
    (local.set ${end} (local.get ${len}))
    (block $end_done_${id} (loop $end_loop_${id}
      (br_if $end_done_${id} (i32.le_s (local.get ${end}) (i32.const 0)))
      (local.set ${ch} ${strCharAt( `(local.get ${str})`, `(i32.sub (local.get ${end}) (i32.const 1))`)})
      (br_if $end_done_${id} (i32.and (i32.ne (local.get ${ch}) (i32.const 32)) (i32.and (i32.ne (local.get ${ch}) (i32.const 9)) (i32.and (i32.ne (local.get ${ch}) (i32.const 10)) (i32.ne (local.get ${ch}) (i32.const 13))))))
      (local.set ${end} (i32.sub (local.get ${end}) (i32.const 1)))
      (br $end_loop_${id})))
    (local.set ${result} ${strNew( `(local.get ${end})`)})
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${end})))
      ${strSetChar( `(local.get ${result})`, `(local.get ${idx})`, strCharAt( `(local.get ${str})`, `(local.get ${idx})`))}
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`, 'string')
}

// repeat(n) - repeat string n times
export const repeat = (rw, args) => {
  if (args.length < 1) return null
  ctx.usedStringType = true
  ctx.usedMemory = true
  const id = ctx.loopCounter++
  const str = `$_repeat_str_${id}`, idx = `$_repeat_i_${id}`, len = `$_repeat_len_${id}`, result = `$_repeat_result_${id}`, count = `$_repeat_count_${id}`, newLen = `$_repeat_newlen_${id}`, srcIdx = `$_repeat_src_${id}`, rep = `$_repeat_rep_${id}`
  ctx.addLocal(str.slice(1), 'string')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(result.slice(1), 'string')
  ctx.addLocal(count.slice(1), 'i32')
  ctx.addLocal(newLen.slice(1), 'i32')
  ctx.addLocal(srcIdx.slice(1), 'i32')
  ctx.addLocal(rep.slice(1), 'i32')

  return wat(`(local.set ${str} ${rw})
    (local.set ${count} ${i32(gen(args[0]))})
    (if (i32.lt_s (local.get ${count}) (i32.const 0)) (then (local.set ${count} (i32.const 0))))
    (local.set ${len} ${strLen( `(local.get ${str})`)})
    (local.set ${newLen} (i32.mul (local.get ${len}) (local.get ${count})))
    (local.set ${result} ${strNew( `(local.get ${newLen})`)})
    (local.set ${idx} (i32.const 0))
    (local.set ${rep} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${rep}) (local.get ${count})))
      (local.set ${srcIdx} (i32.const 0))
      (block $inner_done_${id} (loop $inner_loop_${id}
        (br_if $inner_done_${id} (i32.ge_s (local.get ${srcIdx}) (local.get ${len})))
        ${strSetChar( `(local.get ${result})`, `(local.get ${idx})`, strCharAt( `(local.get ${str})`, `(local.get ${srcIdx})`))}
        (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
        (local.set ${srcIdx} (i32.add (local.get ${srcIdx}) (i32.const 1)))
        (br $inner_loop_${id})))
      (local.set ${rep} (i32.add (local.get ${rep}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`, 'string')
}

// padStart(targetLength, padString) - pad at start with repeating string
export const padStart = (rw, args) => {
  if (args.length < 1) return null
  ctx.usedStringType = true
  ctx.usedMemory = true
  const id = ctx.loopCounter++

  const padArg = args.length >= 2 ? gen(args[1]) : null

  // String padding
  if (padArg && padArg.type === 'string') {
    const str = `$_padS_str_${id}`, idx = `$_padS_i_${id}`, len = `$_padS_len_${id}`, result = `$_padS_result_${id}`, targetLen = `$_padS_target_${id}`, padStr = `$_padS_padstr_${id}`, padStrLen = `$_padS_pslen_${id}`, padLen = `$_padS_padlen_${id}`, padIdx = `$_padS_pidx_${id}`
    ctx.addLocal(str.slice(1), 'string')
    ctx.addLocal(idx.slice(1), 'i32')
    ctx.addLocal(len.slice(1), 'i32')
    ctx.addLocal(result.slice(1), 'string')
    ctx.addLocal(targetLen.slice(1), 'i32')
    ctx.addLocal(padStr.slice(1), 'string')
    ctx.addLocal(padStrLen.slice(1), 'i32')
    ctx.addLocal(padLen.slice(1), 'i32')
    ctx.addLocal(padIdx.slice(1), 'i32')
    return wat(`(local.set ${str} ${rw})
      (local.set ${padStr} ${padArg})
      (local.set ${len} ${strLen( `(local.get ${str})`)})
      (local.set ${targetLen} ${i32(gen(args[0]))})
      (local.set ${padStrLen} ${strLen( `(local.get ${padStr})`)})
      (if (i32.or (i32.le_s (local.get ${targetLen}) (local.get ${len})) (i32.eqz (local.get ${padStrLen})))
        (then (local.set ${result} (local.get ${str})))
        (else
          (local.set ${padLen} (i32.sub (local.get ${targetLen}) (local.get ${len})))
          (local.set ${result} ${strNew( `(local.get ${targetLen})`)})
          ;; Fill padding by cycling through padStr
          (local.set ${idx} (i32.const 0))
          (local.set ${padIdx} (i32.const 0))
          (block $pad_done_${id} (loop $pad_loop_${id}
            (br_if $pad_done_${id} (i32.ge_s (local.get ${idx}) (local.get ${padLen})))
            ${strSetChar( `(local.get ${result})`, `(local.get ${idx})`, strCharAt( `(local.get ${padStr})`, `(local.get ${padIdx})`))}
            (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
            (local.set ${padIdx} (i32.add (local.get ${padIdx}) (i32.const 1)))
            (if (i32.ge_s (local.get ${padIdx}) (local.get ${padStrLen}))
              (then (local.set ${padIdx} (i32.const 0))))
            (br $pad_loop_${id})))
          ;; Copy original
          (local.set ${idx} (i32.const 0))
          (block $copy_done_${id} (loop $copy_loop_${id}
            (br_if $copy_done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
            ${strSetChar( `(local.get ${result})`, `(i32.add (local.get ${padLen}) (local.get ${idx}))`, strCharAt( `(local.get ${str})`, `(local.get ${idx})`))}
            (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
            (br $copy_loop_${id})))))
      (local.get ${result})`, 'string')
  }

  // Char code or default space
  const str = `$_padS_str_${id}`, idx = `$_padS_i_${id}`, len = `$_padS_len_${id}`, result = `$_padS_result_${id}`, targetLen = `$_padS_target_${id}`, padChar = `$_padS_pad_${id}`, padLen = `$_padS_padlen_${id}`
  ctx.addLocal(str.slice(1), 'string')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(result.slice(1), 'string')
  ctx.addLocal(targetLen.slice(1), 'i32')
  ctx.addLocal(padChar.slice(1), 'i32')
  ctx.addLocal(padLen.slice(1), 'i32')
  const padCharCode = padArg ? i32(padArg) : '(i32.const 32)'
  return wat(`(local.set ${str} ${rw})
    (local.set ${len} ${strLen( `(local.get ${str})`)})
    (local.set ${targetLen} ${i32(gen(args[0]))})
    (local.set ${padChar} ${padCharCode})
    (if (i32.le_s (local.get ${targetLen}) (local.get ${len}))
      (then (local.set ${result} (local.get ${str})))
      (else
        (local.set ${padLen} (i32.sub (local.get ${targetLen}) (local.get ${len})))
        (local.set ${result} ${strNew( `(local.get ${targetLen})`)})
        ;; Fill padding
        (local.set ${idx} (i32.const 0))
        (block $pad_done_${id} (loop $pad_loop_${id}
          (br_if $pad_done_${id} (i32.ge_s (local.get ${idx}) (local.get ${padLen})))
          ${strSetChar( `(local.get ${result})`, `(local.get ${idx})`, `(local.get ${padChar})`)}
          (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
          (br $pad_loop_${id})))
        ;; Copy original
        (local.set ${idx} (i32.const 0))
        (block $copy_done_${id} (loop $copy_loop_${id}
          (br_if $copy_done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
          ${strSetChar( `(local.get ${result})`, `(i32.add (local.get ${padLen}) (local.get ${idx}))`, strCharAt( `(local.get ${str})`, `(local.get ${idx})`))}
          (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
          (br $copy_loop_${id})))))
    (local.get ${result})`, 'string')
}

// padEnd(targetLength, padString) - pad at end with repeating string
export const padEnd = (rw, args) => {
  if (args.length < 1) return null
  ctx.usedStringType = true
  ctx.usedMemory = true
  const id = ctx.loopCounter++

  const padArg = args.length >= 2 ? gen(args[1]) : null

  // String padding
  if (padArg && padArg.type === 'string') {
    const str = `$_padE_str_${id}`, idx = `$_padE_i_${id}`, len = `$_padE_len_${id}`, result = `$_padE_result_${id}`, targetLen = `$_padE_target_${id}`, padStr = `$_padE_padstr_${id}`, padStrLen = `$_padE_pslen_${id}`, padLen = `$_padE_padlen_${id}`, padIdx = `$_padE_pidx_${id}`
    ctx.addLocal(str.slice(1), 'string')
    ctx.addLocal(idx.slice(1), 'i32')
    ctx.addLocal(len.slice(1), 'i32')
    ctx.addLocal(result.slice(1), 'string')
    ctx.addLocal(targetLen.slice(1), 'i32')
    ctx.addLocal(padStr.slice(1), 'string')
    ctx.addLocal(padStrLen.slice(1), 'i32')
    ctx.addLocal(padLen.slice(1), 'i32')
    ctx.addLocal(padIdx.slice(1), 'i32')
    return wat(`(local.set ${str} ${rw})
      (local.set ${padStr} ${padArg})
      (local.set ${len} ${strLen( `(local.get ${str})`)})
      (local.set ${targetLen} ${i32(gen(args[0]))})
      (local.set ${padStrLen} ${strLen( `(local.get ${padStr})`)})
      (if (i32.or (i32.le_s (local.get ${targetLen}) (local.get ${len})) (i32.eqz (local.get ${padStrLen})))
        (then (local.set ${result} (local.get ${str})))
        (else
          (local.set ${padLen} (i32.sub (local.get ${targetLen}) (local.get ${len})))
          (local.set ${result} ${strNew( `(local.get ${targetLen})`)})
          ;; Copy original
          (local.set ${idx} (i32.const 0))
          (block $copy_done_${id} (loop $copy_loop_${id}
            (br_if $copy_done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
            ${strSetChar( `(local.get ${result})`, `(local.get ${idx})`, strCharAt( `(local.get ${str})`, `(local.get ${idx})`))}
            (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
            (br $copy_loop_${id})))
          ;; Fill padding by cycling through padStr
          (local.set ${idx} (i32.const 0))
          (local.set ${padIdx} (i32.const 0))
          (block $pad_done_${id} (loop $pad_loop_${id}
            (br_if $pad_done_${id} (i32.ge_s (local.get ${idx}) (local.get ${padLen})))
            ${strSetChar( `(local.get ${result})`, `(i32.add (local.get ${len}) (local.get ${idx}))`, strCharAt( `(local.get ${padStr})`, `(local.get ${padIdx})`))}
            (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
            (local.set ${padIdx} (i32.add (local.get ${padIdx}) (i32.const 1)))
            (if (i32.ge_s (local.get ${padIdx}) (local.get ${padStrLen}))
              (then (local.set ${padIdx} (i32.const 0))))
            (br $pad_loop_${id})))))
      (local.get ${result})`, 'string')
  }

  // Char code or default space
  const str = `$_padE_str_${id}`, idx = `$_padE_i_${id}`, len = `$_padE_len_${id}`, result = `$_padE_result_${id}`, targetLen = `$_padE_target_${id}`, padChar = `$_padE_pad_${id}`, padLen = `$_padE_padlen_${id}`
  ctx.addLocal(str.slice(1), 'string')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(result.slice(1), 'string')
  ctx.addLocal(targetLen.slice(1), 'i32')
  ctx.addLocal(padChar.slice(1), 'i32')
  ctx.addLocal(padLen.slice(1), 'i32')
  const padCharCode = padArg ? i32(padArg) : '(i32.const 32)'
  return wat(`(local.set ${str} ${rw})
    (local.set ${len} ${strLen( `(local.get ${str})`)})
    (local.set ${targetLen} ${i32(gen(args[0]))})
    (local.set ${padChar} ${padCharCode})
    (if (i32.le_s (local.get ${targetLen}) (local.get ${len}))
      (then (local.set ${result} (local.get ${str})))
      (else
        (local.set ${padLen} (i32.sub (local.get ${targetLen}) (local.get ${len})))
        (local.set ${result} ${strNew( `(local.get ${targetLen})`)})
        ;; Copy original
        (local.set ${idx} (i32.const 0))
        (block $copy_done_${id} (loop $copy_loop_${id}
          (br_if $copy_done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
          ${strSetChar( `(local.get ${result})`, `(local.get ${idx})`, strCharAt( `(local.get ${str})`, `(local.get ${idx})`))}
          (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
          (br $copy_loop_${id})))
        ;; Fill padding
        (local.set ${idx} (i32.const 0))
        (block $pad_done_${id} (loop $pad_loop_${id}
          (br_if $pad_done_${id} (i32.ge_s (local.get ${idx}) (local.get ${padLen})))
          ${strSetChar( `(local.get ${result})`, `(i32.add (local.get ${len}) (local.get ${idx}))`, `(local.get ${padChar})`)}
          (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
          (br $pad_loop_${id})))))
    (local.get ${result})`, 'string')
}
