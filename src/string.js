// String method implementations
import { ctx, gen } from './compile.js'
import { PTR_TYPE, wat, i32 } from './types.js'
import { strCharAt, strLen, strNew, strSetChar, strCopy, genSubstringSearch, genPrefixMatch } from './memory.js'

export const charCodeAt = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedStringType = true
  ctx.usedMemory = true
  // For simple receivers, use directly
  // For complex receivers (multi-statement blocks), store in local first
  const id = ctx.loopCounter++
  const str = `$_charat_str_${id}`
  ctx.addLocal(str, 'string')
  // Store receiver, then compute charCodeAt, return i32
  return wat(`(block (result i32)
    (local.set ${str} ${rw})
    ${strCharAt(`(local.get ${str})`, i32(gen(args[0])))})`, 'i32')
}

export const slice = (rw, args) => {
  ctx.usedStringType = true
  ctx.usedMemory = true
  const id = ctx.loopCounter++
  const str = `$_sslice_str_${id}`, len = `$_sslice_len_${id}`, result = `$_sslice_result_${id}`
  const start = `$_sslice_start_${id}`, end = `$_sslice_end_${id}`, newLen = `$_sslice_newlen_${id}`
  ctx.addLocal(str, 'string')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(result, 'string')
  ctx.addLocal(start, 'i32')
  ctx.addLocal(end, 'i32')
  ctx.addLocal(newLen, 'i32')

  const startArg = args.length >= 1 ? i32(gen(args[0])) : '(i32.const 0)'
  const endArg = args.length >= 2 ? i32(gen(args[1])) : strLen(`(local.get ${str})`)
  return wat(`(local.set ${str} ${rw})
    (local.set ${len} ${strLen(`(local.get ${str})`)})
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
    (local.set ${result} ${strNew(`(local.get ${newLen})`)})
    ${strCopy(`(local.get ${result})`, '(i32.const 0)', `(local.get ${str})`, `(local.get ${start})`, `(local.get ${newLen})`)}
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
    return wat(genSubstringSearch(ctx, rw, String(searchVal), '{idx}', '(i32.const -1)'), 'i32')
  }

  // Char code argument
  if (searchVal.type !== 'i32' && searchVal.type !== 'f64') return null
  const str = `$_sindexof_str_${id}`, idx = `$_sindexof_i_${id}`, len = `$_sindexof_len_${id}`, target = `$_sindexof_target_${id}`
  ctx.addLocal(str, 'string')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(target, 'i32')
  return wat(`(local.set ${str} ${rw})
    (local.set ${target} ${i32(searchVal)})
    (local.set ${len} ${strLen(`(local.get ${str})`)})
    (local.set ${idx} (i32.const 0))
    (block $found_${id} (result i32)
      (block $done_${id}
        (loop $loop_${id}
          (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
          (if (i32.eq ${strCharAt(`(local.get ${str})`, `(local.get ${idx})`)} (local.get ${target}))
            (then (br $found_${id} (local.get ${idx}))))
          (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
          (br $loop_${id})))
      (i32.const -1))`, 'i32')
}

// str.search(regex) - returns index of first match or -1
export const search = (rw, args) => {
  if (args.length !== 1) return null
  const searchVal = gen(args[0])
  const id = ctx.loopCounter++

  // Regex argument
  if (searchVal.type === 'regex') {
    ctx.usedStringType = true
    ctx.usedMemory = true
    const regexId = searchVal.schema
    const strPtr = `$_search_ptr_${id}`, strOff = `$_search_off_${id}`, strLen_ = `$_search_len_${id}`, searchPos = `$_search_pos_${id}`, matchResult = `$_search_res_${id}`
    ctx.addLocal(strPtr, 'f64')
    ctx.addLocal(strOff, 'i32')
    ctx.addLocal(strLen_, 'i32')
    ctx.addLocal(searchPos, 'i32')
    ctx.addLocal(matchResult, 'i32')

    // Search loop: try at each position until match or end
    // Convert SSO to heap first for memory access
    return wat(`(local.set ${strPtr} (call $__sso_to_heap ${rw}))
      (local.set ${strOff} (call $__ptr_offset (local.get ${strPtr})))
      (local.set ${strLen_} (call $__ptr_len (local.get ${strPtr})))
      (local.set ${searchPos} (i32.const 0))
      (local.set ${matchResult} (i32.const -1))
      (block $found_${id}
        (loop $search_${id}
          (br_if $found_${id} (i32.gt_s (local.get ${searchPos}) (local.get ${strLen_})))
          (if (i32.ge_s (call $__regex_${regexId} (local.get ${strOff}) (local.get ${strLen_}) (local.get ${searchPos})) (i32.const 0))
            (then
              (local.set ${matchResult} (local.get ${searchPos}))
              (br $found_${id})))
          (local.set ${searchPos} (i32.add (local.get ${searchPos}) (i32.const 1)))
          (br $search_${id})))
      (local.get ${matchResult})`, 'i32')
  }

  // For non-regex, fall back to indexOf behavior
  return indexOf(rw, args)
}

// str.match(regex) - returns array [fullMatch, group1, ...] or null
// With /g flag: returns array of all matches (no groups per JS spec)
export const match = (rw, args) => {
  if (args.length !== 1) return null
  const searchVal = gen(args[0])

  // Only regex argument supported
  if (searchVal.type !== 'regex') return null

  ctx.usedStringType = true
  ctx.usedArrayType = true
  ctx.usedMemory = true
  const regexId = searchVal.schema
  const groupCount = ctx.regexGroups?.[regexId] || 0
  const isGlobal = ctx.regexFlags?.[regexId]?.includes('g')
  const id = ctx.loopCounter++

  // Locals for search and result building
  const strPtr = `$_match_str_${id}`, strOff = `$_match_off_${id}`, strLen_ = `$_match_len_${id}`
  const searchPos = `$_match_srch_${id}`, matchEnd = `$_match_end_${id}`
  const result = `$_match_res_${id}`, groupBuf = `$_match_grp_${id}`
  const part = `$_match_part_${id}`, partLen = `$_match_plen_${id}`
  const k = `$_match_k_${id}`
  const gStart = `$_match_gs_${id}`, gEnd = `$_match_ge_${id}`
  const matchCount = `$_match_cnt_${id}`, arrIdx = `$_match_ai_${id}`

  ctx.addLocal(strPtr, 'f64')
  ctx.addLocal(strOff, 'i32')
  ctx.addLocal(strLen_, 'i32')
  ctx.addLocal(searchPos, 'i32')
  ctx.addLocal(matchEnd, 'i32')
  ctx.addLocal(result, 'f64')
  ctx.addLocal(groupBuf, 'i32')
  ctx.addLocal(part, 'f64')
  ctx.addLocal(partLen, 'i32')
  ctx.addLocal(k, 'i32')
  ctx.addLocal(gStart, 'i32')
  ctx.addLocal(gEnd, 'i32')
  if (isGlobal) {
    ctx.addLocal(matchCount, 'i32')
    ctx.addLocal(arrIdx, 'i32')
  }

  // Helper to copy substring
  const copySubstr = (startLocal, endLocal, destLocal) => `
    (local.set ${partLen} (i32.sub (local.get ${endLocal}) (local.get ${startLocal})))
    (local.set ${destLocal} (call $__alloc (i32.const ${PTR_TYPE.STRING}) (local.get ${partLen})))
    (local.set ${k} (i32.const 0))
    (block $cpy_done_${id} (loop $cpy_loop_${id}
      (br_if $cpy_done_${id} (i32.ge_s (local.get ${k}) (local.get ${partLen})))
      (i32.store16 (i32.add (call $__ptr_offset (local.get ${destLocal})) (i32.shl (local.get ${k}) (i32.const 1)))
        (i32.load16_u (i32.add (local.get ${strOff}) (i32.shl (i32.add (local.get ${startLocal}) (local.get ${k})) (i32.const 1)))))
      (local.set ${k} (i32.add (local.get ${k}) (i32.const 1)))
      (br $cpy_loop_${id})))
  `

  if (isGlobal) {
    // Global match: return array of all match strings (no groups per JS spec)
    return wat(`(block (result f64)
      (local.set ${strPtr} (call $__sso_to_heap ${rw}))
      (local.set ${strOff} (call $__ptr_offset (local.get ${strPtr})))
      (local.set ${strLen_} (call $__ptr_len (local.get ${strPtr})))
      ;; First pass: count matches
      (local.set ${matchCount} (i32.const 0))
      (local.set ${searchPos} (i32.const 0))
      (block $cnt_done_${id} (loop $cnt_loop_${id}
        (br_if $cnt_done_${id} (i32.gt_s (local.get ${searchPos}) (local.get ${strLen_})))
        (local.set ${matchEnd} (call $__regex_${regexId} (local.get ${strOff}) (local.get ${strLen_}) (local.get ${searchPos})))
        (if (i32.ge_s (local.get ${matchEnd}) (i32.const 0))
          (then
            (local.set ${matchCount} (i32.add (local.get ${matchCount}) (i32.const 1)))
            (local.set ${searchPos} (select (i32.add (local.get ${matchEnd}) (i32.const 1)) (local.get ${matchEnd})
              (i32.eq (local.get ${matchEnd}) (local.get ${searchPos})))))
          (else (local.set ${searchPos} (i32.add (local.get ${searchPos}) (i32.const 1)))))
        (br $cnt_loop_${id})))
      ;; If no matches, return null
      (if (result f64) (i32.eqz (local.get ${matchCount}))
        (then (f64.const 0))
        (else
          ;; Allocate result array
          (local.set ${result} (call $__alloc (i32.const ${PTR_TYPE.ARRAY}) (local.get ${matchCount})))
          ;; Allocate temp buffer for group positions (8 bytes: start+end as i32s)
          (local.set ${groupBuf} (global.get $__heap))
          (global.set $__heap (i32.add (global.get $__heap) (i32.const 8)))
          ;; Second pass: extract matches
          (local.set ${arrIdx} (i32.const 0))
          (local.set ${searchPos} (i32.const 0))
          (block $ext_done_${id} (loop $ext_loop_${id}
            (br_if $ext_done_${id} (i32.ge_s (local.get ${arrIdx}) (local.get ${matchCount})))
            (local.set ${matchEnd} (call $__regex_${regexId}_exec (local.get ${strOff}) (local.get ${strLen_}) (local.get ${searchPos}) (local.get ${groupBuf})))
            (if (i32.ge_s (local.get ${matchEnd}) (i32.const 0))
              (then
                ;; Extract match string (group 0)
                (local.set ${gStart} (i32.load (local.get ${groupBuf})))
                (local.set ${gEnd} (i32.load (i32.add (local.get ${groupBuf}) (i32.const 4))))
                ${copySubstr(gStart, gEnd, part)}
                (f64.store (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (local.get ${arrIdx}) (i32.const 3))) (local.get ${part}))
                (local.set ${arrIdx} (i32.add (local.get ${arrIdx}) (i32.const 1)))
                (local.set ${searchPos} (select (i32.add (local.get ${matchEnd}) (i32.const 1)) (local.get ${matchEnd})
                  (i32.eq (local.get ${matchEnd}) (local.get ${searchPos})))))
              (else (local.set ${searchPos} (i32.add (local.get ${searchPos}) (i32.const 1)))))
            (br $ext_loop_${id})))
          (local.get ${result}))))`, 'f64')
  }

  // Non-global: result array has groupCount + 1 elements (full match + groups)
  const resultLen = groupCount + 1
  const arrNew = `(call $__alloc (i32.const ${PTR_TYPE.ARRAY}) (i32.const ${resultLen}))`

  return wat(`(block (result f64)
    (local.set ${strPtr} (call $__sso_to_heap ${rw}))
    (local.set ${strOff} (call $__ptr_offset (local.get ${strPtr})))
    (local.set ${strLen_} (call $__ptr_len (local.get ${strPtr})))
    (local.set ${searchPos} (i32.const 0))
    (local.set ${matchEnd} (i32.const -1))
    ;; Allocate temp buffer for group positions (8 bytes per group: start+end as i32s)
    (local.set ${groupBuf} (global.get $__heap))
    (global.set $__heap (i32.add (global.get $__heap) (i32.const ${(groupCount + 1) * 8})))
    ;; Search loop
    (block $found_${id}
      (loop $search_${id}
        (br_if $found_${id} (i32.gt_s (local.get ${searchPos}) (local.get ${strLen_})))
        (local.set ${matchEnd} (call $__regex_${regexId}_exec (local.get ${strOff}) (local.get ${strLen_}) (local.get ${searchPos}) (local.get ${groupBuf})))
        (br_if $found_${id} (i32.ge_s (local.get ${matchEnd}) (i32.const 0)))
        (local.set ${searchPos} (i32.add (local.get ${searchPos}) (i32.const 1)))
        (br $search_${id})))
    ;; Check if found
    (if (result f64) (i32.lt_s (local.get ${matchEnd}) (i32.const 0))
      (then (f64.const 0))  ;; null
      (else
        ;; Build result array
        (local.set ${result} ${arrNew})
        ;; Extract full match (group 0)
        (local.set ${gStart} (i32.load (local.get ${groupBuf})))
        (local.set ${gEnd} (i32.load (i32.add (local.get ${groupBuf}) (i32.const 4))))
        ${copySubstr(gStart, gEnd, part)}
        (f64.store (call $__ptr_offset (local.get ${result})) (local.get ${part}))
        ;; Extract capture groups
        ${Array.from({length: groupCount}, (_, i) => `
        (local.set ${gStart} (i32.load (i32.add (local.get ${groupBuf}) (i32.const ${(i + 1) * 8}))))
        (local.set ${gEnd} (i32.load (i32.add (local.get ${groupBuf}) (i32.const ${(i + 1) * 8 + 4}))))
        ${copySubstr(gStart, gEnd, part)}
        (f64.store (i32.add (call $__ptr_offset (local.get ${result})) (i32.const ${(i + 1) * 8})) (local.get ${part}))`).join('\n')}
        (local.get ${result}))))`, 'f64')
}

export const substring = (rw, args) => {
  if (args.length < 1) return null
  ctx.usedStringType = true
  ctx.usedMemory = true
  const id = ctx.loopCounter++
  const str = `$_substr_str_${id}`, idx = `$_substr_i_${id}`, len = `$_substr_len_${id}`, result = `$_substr_result_${id}`, start = `$_substr_start_${id}`, end = `$_substr_end_${id}`, newLen = `$_substr_newlen_${id}`
  ctx.addLocal(str, 'string')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(result, 'string')
  ctx.addLocal(start, 'i32')
  ctx.addLocal(end, 'i32')
  ctx.addLocal(newLen, 'i32')

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
  ctx.addLocal(str, 'string')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(result, 'string')
  ctx.addLocal(ch, 'i32')

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
  ctx.addLocal(str, 'string')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(result, 'string')
  ctx.addLocal(ch, 'i32')

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
    return wat(genSubstringSearch(ctx, rw, String(searchVal), '(i32.const 1)', '(i32.const 0)'), 'i32')
  }

  // Char code argument
  if (searchVal.type !== 'i32' && searchVal.type !== 'f64') return null
  const str = `$_sincludes_str_${id}`, idx = `$_sincludes_i_${id}`, len = `$_sincludes_len_${id}`, target = `$_sincludes_target_${id}`
  ctx.addLocal(str, 'string')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(target, 'i32')
  return wat(`(local.set ${str} ${rw})
    (local.set ${target} ${i32(searchVal)})
    (local.set ${len} ${strLen(`(local.get ${str})`)})
    (local.set ${idx} (i32.const 0))
    (block $found_${id} (result i32)
      (block $done_${id}
        (loop $loop_${id}
          (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
          (if (i32.eq ${strCharAt(`(local.get ${str})`, `(local.get ${idx})`)} (local.get ${target}))
            (then (br $found_${id} (i32.const 1))))
          (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
          (br $loop_${id})))
      (i32.const 0))`, 'i32')
}

export const startsWith = (rw, args) => {
  if (args.length < 1) return null
  ctx.usedStringType = true
  ctx.usedMemory = true
  const searchVal = gen(args[0])
  const id = ctx.loopCounter++

  // String argument: check prefix
  if (searchVal.type === 'string') {
    return wat(genPrefixMatch(ctx, rw, String(searchVal), 0), 'i32')
  }

  // Char code argument (backward compat)
  if (searchVal.type !== 'i32' && searchVal.type !== 'f64') return null
  const str = `$_starts_str_${id}`, target = `$_starts_target_${id}`
  ctx.addLocal(str, 'string')
  ctx.addLocal(target, 'i32')
  return wat(`(local.set ${str} ${rw})
    (local.set ${target} ${i32(searchVal)})
    (if (result i32) (i32.gt_s ${strLen(`(local.get ${str})`)} (i32.const 0))
      (then (i32.eq ${strCharAt(`(local.get ${str})`, '(i32.const 0)')} (local.get ${target})))
      (else (i32.const 0)))`, 'i32')
}

export const endsWith = (rw, args) => {
  if (args.length < 1) return null
  ctx.usedStringType = true
  ctx.usedMemory = true
  const searchVal = gen(args[0])
  const id = ctx.loopCounter++

  // String argument: check suffix
  if (searchVal.type === 'string') {
    return wat(genPrefixMatch(ctx, rw, String(searchVal), -1), 'i32')
  }

  // Char code argument (backward compat)
  if (searchVal.type !== 'i32' && searchVal.type !== 'f64') return null
  const str = `$_ends_str_${id}`, target = `$_ends_target_${id}`, len = `$_ends_len_${id}`
  ctx.addLocal(str, 'string')
  ctx.addLocal(target, 'i32')
  ctx.addLocal(len, 'i32')
  return wat(`(local.set ${str} ${rw})
    (local.set ${target} ${i32(searchVal)})
    (local.set ${len} ${strLen(`(local.get ${str})`)})
    (if (result i32) (i32.gt_s (local.get ${len}) (i32.const 0))
      (then (i32.eq ${strCharAt(`(local.get ${str})`, `(i32.sub (local.get ${len}) (i32.const 1))`)} (local.get ${target})))
      (else (i32.const 0)))`, 'i32')
}

export const trim = (rw, args) => {
  ctx.usedStringType = true
  ctx.usedMemory = true
  const id = ctx.loopCounter++
  const str = `$_trim_str_${id}`, idx = `$_trim_i_${id}`, len = `$_trim_len_${id}`, result = `$_trim_result_${id}`, start = `$_trim_start_${id}`, end = `$_trim_end_${id}`, ch = `$_trim_ch_${id}`, newLen = `$_trim_newlen_${id}`
  ctx.addLocal(str, 'string')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(result, 'string')
  ctx.addLocal(start, 'i32')
  ctx.addLocal(end, 'i32')
  ctx.addLocal(ch, 'i32')
  ctx.addLocal(newLen, 'i32')

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
    ctx.addLocal(str, 'string')
    ctx.addLocal(sep, 'string')
    ctx.addLocal(len, 'i32')
    ctx.addLocal(sepLen, 'i32')
    ctx.addLocal(idx, 'i32')
    ctx.addLocal(count, 'i32')
    ctx.addLocal(start, 'i32')
    ctx.addLocal(result, 'f64')
    ctx.addLocal(j, 'i32')
    ctx.addLocal(match, 'i32')
    ctx.addLocal(part, 'string')
    ctx.addLocal(partLen, 'i32')
    ctx.addLocal(k, 'i32')
    ctx.addLocal(arrIdx, 'i32')

    const arrNew = `(call $__alloc (i32.const ${PTR_TYPE.ARRAY}) (local.get ${count}))`
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
    ctx.addLocal(str, 'string')
    ctx.addLocal(sepChar, 'i32')
    ctx.addLocal(len, 'i32')
    ctx.addLocal(idx, 'i32')
    ctx.addLocal(count, 'i32')
    ctx.addLocal(start, 'i32')
    ctx.addLocal(result, 'f64')
    ctx.addLocal(part, 'string')
    ctx.addLocal(partLen, 'i32')
    ctx.addLocal(k, 'i32')
    ctx.addLocal(arrIdx, 'i32')

    const arrNew = `(call $__alloc (i32.const ${PTR_TYPE.ARRAY}) (local.get ${count}))`
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

  // Regex separator
  if (sepVal.type === 'regex') {
    const regexId = sepVal.schema
    const str = `$_split_str_${id}`, strOff = `$_split_off_${id}`, len = `$_split_len_${id}`
    const idx = `$_split_i_${id}`, count = `$_split_count_${id}`, start = `$_split_start_${id}`, result = `$_split_result_${id}`
    const part = `$_split_part_${id}`, partLen = `$_split_plen_${id}`, k = `$_split_k_${id}`, arrIdx = `$_split_arri_${id}`
    const matchEnd = `$_split_mend_${id}`
    ctx.addLocal(str, 'f64')
    ctx.addLocal(strOff, 'i32')
    ctx.addLocal(len, 'i32')
    ctx.addLocal(idx, 'i32')
    ctx.addLocal(count, 'i32')
    ctx.addLocal(start, 'i32')
    ctx.addLocal(result, 'f64')
    ctx.addLocal(part, 'f64')
    ctx.addLocal(partLen, 'i32')
    ctx.addLocal(k, 'i32')
    ctx.addLocal(arrIdx, 'i32')
    ctx.addLocal(matchEnd, 'i32')

    const arrNew = `(call $__alloc (i32.const ${PTR_TYPE.ARRAY}) (local.get ${count}))`
    const arrSet = `(f64.store (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (local.get ${arrIdx}) (i32.const 3))) (local.get ${part}))`

    // Helper to copy substring
    const copySubstr = (startExpr, lenExpr, destLocal) => `
      (local.set ${destLocal} (call $__alloc (i32.const ${PTR_TYPE.STRING}) ${lenExpr}))
      (local.set ${k} (i32.const 0))
      (block $cpy_done2_${id} (loop $cpy_loop2_${id}
        (br_if $cpy_done2_${id} (i32.ge_s (local.get ${k}) ${lenExpr}))
        (i32.store16 (i32.add (call $__ptr_offset (local.get ${destLocal})) (i32.shl (local.get ${k}) (i32.const 1)))
          (i32.load16_u (i32.add (local.get ${strOff}) (i32.shl (i32.add ${startExpr} (local.get ${k})) (i32.const 1)))))
        (local.set ${k} (i32.add (local.get ${k}) (i32.const 1)))
        (br $cpy_loop2_${id})))
    `

    return wat(`(local.set ${str} (call $__sso_to_heap ${rw}))
      (local.set ${strOff} (call $__ptr_offset (local.get ${str})))
      (local.set ${len} (call $__ptr_len (local.get ${str})))
      ;; Count parts first
      (local.set ${count} (i32.const 1))
      (local.set ${idx} (i32.const 0))
      (block $cnt_done_${id} (loop $cnt_loop_${id}
        (br_if $cnt_done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
        (local.set ${matchEnd} (call $__regex_${regexId} (local.get ${strOff}) (local.get ${len}) (local.get ${idx})))
        (if (i32.ge_s (local.get ${matchEnd}) (i32.const 0))
          (then
            (local.set ${count} (i32.add (local.get ${count}) (i32.const 1)))
            ;; Skip to end of match (avoid infinite loop on zero-width match)
            (local.set ${idx} (select (i32.add (local.get ${matchEnd}) (i32.const 1)) (local.get ${matchEnd})
              (i32.eq (local.get ${matchEnd}) (local.get ${idx})))))
          (else (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))))
        (br $cnt_loop_${id})))
      ;; Create and fill array
      (local.set ${result} ${arrNew})
      (local.set ${start} (i32.const 0))
      (local.set ${arrIdx} (i32.const 0))
      (local.set ${idx} (i32.const 0))
      (block $fill_done_${id} (loop $fill_loop_${id}
        (br_if $fill_done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
        (local.set ${matchEnd} (call $__regex_${regexId} (local.get ${strOff}) (local.get ${len}) (local.get ${idx})))
        (if (i32.ge_s (local.get ${matchEnd}) (i32.const 0))
          (then
            ;; Extract part before match
            (local.set ${partLen} (i32.sub (local.get ${idx}) (local.get ${start})))
            ${copySubstr(`(local.get ${start})`, `(local.get ${partLen})`, part)}
            ${arrSet}
            (local.set ${arrIdx} (i32.add (local.get ${arrIdx}) (i32.const 1)))
            (local.set ${start} (local.get ${matchEnd}))
            ;; Advance past match
            (local.set ${idx} (select (i32.add (local.get ${matchEnd}) (i32.const 1)) (local.get ${matchEnd})
              (i32.eq (local.get ${matchEnd}) (local.get ${idx})))))
          (else (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))))
        (br $fill_loop_${id})))
      ;; Last part
      (local.set ${partLen} (i32.sub (local.get ${len}) (local.get ${start})))
      ${copySubstr(`(local.get ${start})`, `(local.get ${partLen})`, part)}
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
    ctx.addLocal(str, 'string')
    ctx.addLocal(search, 'string')
    ctx.addLocal(repl, 'string')
    ctx.addLocal(len, 'i32')
    ctx.addLocal(searchLen, 'i32')
    ctx.addLocal(replLen, 'i32')
    ctx.addLocal(idx, 'i32')
    ctx.addLocal(j, 'i32')
    ctx.addLocal(match, 'i32')
    ctx.addLocal(result, 'string')
    ctx.addLocal(newLen, 'i32')
    ctx.addLocal(k, 'i32')
    ctx.addLocal(foundIdx, 'i32')

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
    ctx.addLocal(str, 'string')
    ctx.addLocal(searchChar, 'i32')
    ctx.addLocal(repl, 'string')
    ctx.addLocal(len, 'i32')
    ctx.addLocal(replLen, 'i32')
    ctx.addLocal(idx, 'i32')
    ctx.addLocal(result, 'string')
    ctx.addLocal(newLen, 'i32')
    ctx.addLocal(k, 'i32')
    ctx.addLocal(foundIdx, 'i32')

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

  // Regex search, string replacement
  if (searchVal.type === 'regex' && replaceVal.type === 'string') {
    const regexId = searchVal.schema
    const isGlobal = ctx.regexFlags?.[regexId]?.includes('g')

    const str = `$_repl_str_${id}`, strOff = `$_repl_off_${id}`, repl = `$_repl_repl_${id}`
    const len = `$_repl_len_${id}`, replLen = `$_repl_rlen_${id}`
    const idx = `$_repl_i_${id}`, result = `$_repl_result_${id}`, newLen = `$_repl_newlen_${id}`, k = `$_repl_k_${id}`
    const foundIdx = `$_repl_found_${id}`, matchEnd = `$_repl_mend_${id}`, matchLen = `$_repl_mlen_${id}`
    const totalMatchLen = `$_repl_tml_${id}`, matchCount = `$_repl_mc_${id}`, writePos = `$_repl_wp_${id}`, lastEnd = `$_repl_le_${id}`
    ctx.addLocal(str, 'f64')
    ctx.addLocal(strOff, 'i32')
    ctx.addLocal(repl, 'f64')
    ctx.addLocal(len, 'i32')
    ctx.addLocal(replLen, 'i32')
    ctx.addLocal(idx, 'i32')
    ctx.addLocal(result, 'f64')
    ctx.addLocal(newLen, 'i32')
    ctx.addLocal(k, 'i32')
    ctx.addLocal(foundIdx, 'i32')
    ctx.addLocal(matchEnd, 'i32')
    ctx.addLocal(matchLen, 'i32')
    if (isGlobal) {
      ctx.addLocal(totalMatchLen, 'i32')
      ctx.addLocal(matchCount, 'i32')
      ctx.addLocal(writePos, 'i32')
      ctx.addLocal(lastEnd, 'i32')
    }

    if (isGlobal) {
      // Global replace: replace ALL matches
      // Wrap in block so the whole thing is a valid expression
      // Convert SSO strings to heap for memory access
      return wat(`(block (result f64)
        (local.set ${str} (call $__sso_to_heap ${rw}))
        (local.set ${strOff} (call $__ptr_offset (local.get ${str})))
        (local.set ${repl} (call $__sso_to_heap ${replaceVal}))
        (local.set ${len} (call $__ptr_len (local.get ${str})))
        (local.set ${replLen} (call $__ptr_len (local.get ${repl})))
        ;; First pass: count matches and total match length
        (local.set ${totalMatchLen} (i32.const 0))
        (local.set ${matchCount} (i32.const 0))
        (local.set ${idx} (i32.const 0))
        (block $cnt_done_${id} (loop $cnt_loop_${id}
          (br_if $cnt_done_${id} (i32.gt_s (local.get ${idx}) (local.get ${len})))
          (local.set ${matchEnd} (call $__regex_${regexId} (local.get ${strOff}) (local.get ${len}) (local.get ${idx})))
          (if (i32.ge_s (local.get ${matchEnd}) (i32.const 0))
            (then
              (local.set ${matchCount} (i32.add (local.get ${matchCount}) (i32.const 1)))
              (local.set ${totalMatchLen} (i32.add (local.get ${totalMatchLen}) (i32.sub (local.get ${matchEnd}) (local.get ${idx}))))
              (local.set ${idx} (select (i32.add (local.get ${matchEnd}) (i32.const 1)) (local.get ${matchEnd})
                (i32.eq (local.get ${matchEnd}) (local.get ${idx})))))
            (else (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))))
          (br $cnt_loop_${id})))
        ;; If no matches, return original
        (if (result f64) (i32.eqz (local.get ${matchCount}))
          (then (local.get ${str}))
          (else
            ;; Allocate result: original - matchedChars + (matchCount * replLen)
            (local.set ${newLen} (i32.add (i32.sub (local.get ${len}) (local.get ${totalMatchLen})) (i32.mul (local.get ${matchCount}) (local.get ${replLen}))))
            (local.set ${result} (call $__alloc (i32.const ${PTR_TYPE.STRING}) (local.get ${newLen})))
            ;; Second pass: build result
            (local.set ${writePos} (i32.const 0))
            (local.set ${lastEnd} (i32.const 0))
            (local.set ${idx} (i32.const 0))
            (block $bld_done_${id} (loop $bld_loop_${id}
              (br_if $bld_done_${id} (i32.gt_s (local.get ${idx}) (local.get ${len})))
              (local.set ${matchEnd} (call $__regex_${regexId} (local.get ${strOff}) (local.get ${len}) (local.get ${idx})))
              (if (i32.ge_s (local.get ${matchEnd}) (i32.const 0))
                (then
                  ;; Copy text before match (from lastEnd to idx)
                  (local.set ${k} (local.get ${lastEnd}))
                  (block $cp1_done_${id} (loop $cp1_loop_${id}
                    (br_if $cp1_done_${id} (i32.ge_s (local.get ${k}) (local.get ${idx})))
                    (i32.store16 (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (local.get ${writePos}) (i32.const 1)))
                      (i32.load16_u (i32.add (local.get ${strOff}) (i32.shl (local.get ${k}) (i32.const 1)))))
                    (local.set ${writePos} (i32.add (local.get ${writePos}) (i32.const 1)))
                    (local.set ${k} (i32.add (local.get ${k}) (i32.const 1)))
                    (br $cp1_loop_${id})))
                  ;; Copy replacement
                  (local.set ${k} (i32.const 0))
                  (block $cpr_done_${id} (loop $cpr_loop_${id}
                    (br_if $cpr_done_${id} (i32.ge_s (local.get ${k}) (local.get ${replLen})))
                    (i32.store16 (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (local.get ${writePos}) (i32.const 1)))
                      (i32.load16_u (i32.add (call $__ptr_offset (local.get ${repl})) (i32.shl (local.get ${k}) (i32.const 1)))))
                    (local.set ${writePos} (i32.add (local.get ${writePos}) (i32.const 1)))
                    (local.set ${k} (i32.add (local.get ${k}) (i32.const 1)))
                    (br $cpr_loop_${id})))
                  (local.set ${lastEnd} (local.get ${matchEnd}))
                  (local.set ${idx} (select (i32.add (local.get ${matchEnd}) (i32.const 1)) (local.get ${matchEnd})
                    (i32.eq (local.get ${matchEnd}) (local.get ${idx})))))
                (else (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))))
              (br $bld_loop_${id})))
            ;; Copy remaining text after last match
            (local.set ${k} (local.get ${lastEnd}))
            (block $cpf_done_${id} (loop $cpf_loop_${id}
              (br_if $cpf_done_${id} (i32.ge_s (local.get ${k}) (local.get ${len})))
              (i32.store16 (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (local.get ${writePos}) (i32.const 1)))
                (i32.load16_u (i32.add (local.get ${strOff}) (i32.shl (local.get ${k}) (i32.const 1)))))
              (local.set ${writePos} (i32.add (local.get ${writePos}) (i32.const 1)))
              (local.set ${k} (i32.add (local.get ${k}) (i32.const 1)))
              (br $cpf_loop_${id})))
            (local.get ${result}))))`, 'string')
    }

    // Non-global: replace first match only
    // Wrap in block so multi-statement is valid expression
    return wat(`(block (result f64)
      (local.set ${str} (call $__sso_to_heap ${rw}))
      (local.set ${strOff} (call $__ptr_offset (local.get ${str})))
      (local.set ${repl} (call $__sso_to_heap ${replaceVal}))
      (local.set ${len} (call $__ptr_len (local.get ${str})))
      (local.set ${replLen} (call $__ptr_len (local.get ${repl})))
      (local.set ${foundIdx} (i32.const -1))
      (local.set ${matchEnd} (i32.const -1))
      ;; Search for first match
      (local.set ${idx} (i32.const 0))
      (block $find_done_${id} (loop $find_loop_${id}
        (br_if $find_done_${id} (i32.gt_s (local.get ${idx}) (local.get ${len})))
        (local.set ${matchEnd} (call $__regex_${regexId} (local.get ${strOff}) (local.get ${len}) (local.get ${idx})))
        (if (i32.ge_s (local.get ${matchEnd}) (i32.const 0))
          (then (local.set ${foundIdx} (local.get ${idx})) (br $find_done_${id})))
        (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
        (br $find_loop_${id})))
      ;; Build result
      (if (result f64) (i32.lt_s (local.get ${foundIdx}) (i32.const 0))
        (then (local.get ${str}))
        (else
          (local.set ${matchLen} (i32.sub (local.get ${matchEnd}) (local.get ${foundIdx})))
          (local.set ${newLen} (i32.add (i32.sub (local.get ${len}) (local.get ${matchLen})) (local.get ${replLen})))
          (local.set ${result} (call $__alloc (i32.const ${PTR_TYPE.STRING}) (local.get ${newLen})))
          ;; Copy before match
          (local.set ${k} (i32.const 0))
          (block $b_done_${id} (loop $b_loop_${id}
            (br_if $b_done_${id} (i32.ge_s (local.get ${k}) (local.get ${foundIdx})))
            (i32.store16 (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (local.get ${k}) (i32.const 1)))
              (i32.load16_u (i32.add (local.get ${strOff}) (i32.shl (local.get ${k}) (i32.const 1)))))
            (local.set ${k} (i32.add (local.get ${k}) (i32.const 1)))
            (br $b_loop_${id})))
          ;; Copy replacement
          (local.set ${k} (i32.const 0))
          (block $r_done_${id} (loop $r_loop_${id}
            (br_if $r_done_${id} (i32.ge_s (local.get ${k}) (local.get ${replLen})))
            (i32.store16 (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (i32.add (local.get ${foundIdx}) (local.get ${k})) (i32.const 1)))
              (i32.load16_u (i32.add (call $__ptr_offset (local.get ${repl})) (i32.shl (local.get ${k}) (i32.const 1)))))
            (local.set ${k} (i32.add (local.get ${k}) (i32.const 1)))
            (br $r_loop_${id})))
          ;; Copy after match
          (local.set ${idx} (local.get ${matchEnd}))
          (local.set ${k} (i32.const 0))
          (block $a_done_${id} (loop $a_loop_${id}
            (br_if $a_done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
            (i32.store16 (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (i32.add (i32.add (local.get ${foundIdx}) (local.get ${replLen})) (local.get ${k})) (i32.const 1)))
              (i32.load16_u (i32.add (local.get ${strOff}) (i32.shl (local.get ${idx}) (i32.const 1)))))
            (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
            (local.set ${k} (i32.add (local.get ${k}) (i32.const 1)))
            (br $a_loop_${id})))
          (local.get ${result}))))`, 'string')
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
  ctx.addLocal(str, 'string')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(result, 'string')
  ctx.addLocal(start, 'i32')
  ctx.addLocal(subLen, 'i32')
  ctx.addLocal(newLen, 'i32')

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
  ctx.addLocal(str, 'string')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(result, 'string')
  ctx.addLocal(start, 'i32')
  ctx.addLocal(ch, 'i32')
  ctx.addLocal(newLen, 'i32')

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
  ctx.addLocal(str, 'string')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(result, 'string')
  ctx.addLocal(end, 'i32')
  ctx.addLocal(ch, 'i32')

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
  ctx.addLocal(str, 'string')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(result, 'string')
  ctx.addLocal(count, 'i32')
  ctx.addLocal(newLen, 'i32')
  ctx.addLocal(srcIdx, 'i32')
  ctx.addLocal(rep, 'i32')

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
    ctx.addLocal(str, 'string')
    ctx.addLocal(idx, 'i32')
    ctx.addLocal(len, 'i32')
    ctx.addLocal(result, 'string')
    ctx.addLocal(targetLen, 'i32')
    ctx.addLocal(padStr, 'string')
    ctx.addLocal(padStrLen, 'i32')
    ctx.addLocal(padLen, 'i32')
    ctx.addLocal(padIdx, 'i32')
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
  ctx.addLocal(str, 'string')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(result, 'string')
  ctx.addLocal(targetLen, 'i32')
  ctx.addLocal(padChar, 'i32')
  ctx.addLocal(padLen, 'i32')
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
    ctx.addLocal(str, 'string')
    ctx.addLocal(idx, 'i32')
    ctx.addLocal(len, 'i32')
    ctx.addLocal(result, 'string')
    ctx.addLocal(targetLen, 'i32')
    ctx.addLocal(padStr, 'string')
    ctx.addLocal(padStrLen, 'i32')
    ctx.addLocal(padLen, 'i32')
    ctx.addLocal(padIdx, 'i32')
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
  ctx.addLocal(str, 'string')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(result, 'string')
  ctx.addLocal(targetLen, 'i32')
  ctx.addLocal(padChar, 'i32')
  ctx.addLocal(padLen, 'i32')
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
