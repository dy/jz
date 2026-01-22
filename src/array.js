// Array method implementations
import { ctx, gen } from './compile.js'
import { PTR_TYPE, wat, f64, i32, bool } from './types.js'
import { extractParams } from './analyze.js'
import { arrGet, arrSet, arrLen, arrNew, arrCopy, ptrWithLen } from './memory.js'

export const fill = (rw, args) => {
  if (args.length < 1) return null
  ctx.usedArrayType = true
  ctx.usedMemory = true
  ctx.usedStdlib.push('arrayFill')
  return wat(`(call $arrayFill ${rw} ${f64(gen(args[0]))})`, 'f64')
}

export const map = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  ctx.usedMemory = true
  ctx.returnsArrayPointer = true
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.map requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'
  const id = ctx.loopCounter++
  const arr = `$_map_arr_${id}`, result = `$_map_result_${id}`, idx = `$_map_i_${id}`, len = `$_map_len_${id}`
  ctx.addLocal(arr.slice(1), 'f64')
  ctx.addLocal(result.slice(1), 'f64')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(paramName, 'f64')
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(`(local.get ${arr})`)})
    (local.set ${result} ${arrNew(`(local.get ${len})`)})
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} ${arrGet(`(local.get ${arr})`, `(local.get ${idx})`)})
      ${arrSet(`(local.get ${result})`, `(local.get ${idx})`, f64(gen(body)))}
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`, 'f64')
}

export const reduce = (rw, args) => {
  if (args.length < 1) return null
  ctx.usedArrayType = true
  ctx.usedMemory = true
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.reduce requires arrow function')
  const [, params, body] = callback
  const paramNames = extractParams(params)
  const accName = paramNames[0] || '_acc', curName = paramNames[1] || '_cur'
  const id = ctx.loopCounter++
  const arr = `$_reduce_arr_${id}`, acc = `$_reduce_acc_${id}`, idx = `$_reduce_i_${id}`, len = `$_reduce_len_${id}`
  ctx.addLocal(arr.slice(1), 'f64')
  ctx.addLocal(acc.slice(1), 'f64')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(accName, 'f64')
  ctx.addLocal(curName, 'f64')
  const initVal = args.length >= 2 ? f64(gen(args[1])) : '(f64.const 0)'
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(`(local.get ${arr})`)})
    (local.set ${acc} ${initVal})
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${accName} (local.get ${acc}))
      (local.set $${curName} ${arrGet(`(local.get ${arr})`, `(local.get ${idx})`)})
      (local.set ${acc} ${f64(gen(body))})
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${acc})`, 'f64')
}

export const filter = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  ctx.usedMemory = true
  ctx.returnsArrayPointer = true
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.filter requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'
  const id = ctx.loopCounter++
  const arr = `$_filter_arr_${id}`, result = `$_filter_result_${id}`, idx = `$_filter_i_${id}`, len = `$_filter_len_${id}`, count = `$_filter_count_${id}`
  ctx.addLocal(arr.slice(1), 'f64')
  ctx.addLocal(result.slice(1), 'f64')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(count.slice(1), 'i32')
  ctx.addLocal(paramName, 'f64')
  const finalResult = ptrWithLen(`(local.get ${result})`, `(local.get ${count})`)
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(`(local.get ${arr})`)})
    (local.set ${result} ${arrNew(`(local.get ${len})`)})
    (local.set ${idx} (i32.const 0))
    (local.set ${count} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} ${arrGet(`(local.get ${arr})`, `(local.get ${idx})`)})
      (if ${bool(gen(body))}
        (then
          ${arrSet(`(local.get ${result})`, `(local.get ${count})`, `(local.get $${paramName})`)}
          (local.set ${count} (i32.add (local.get ${count}) (i32.const 1)))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    ${finalResult}`, 'f64')
}

export const find = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  ctx.usedMemory = true
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.find requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'
  const id = ctx.loopCounter++
  const arr = `$_find_arr_${id}`, result = `$_find_result_${id}`, idx = `$_find_i_${id}`, len = `$_find_len_${id}`
  ctx.addLocal(arr.slice(1), 'f64')
  ctx.addLocal(result.slice(1), 'f64')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(paramName, 'f64')
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(`(local.get ${arr})`)})
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (f64.const nan))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} ${arrGet(`(local.get ${arr})`, `(local.get ${idx})`)})
      (if ${bool(gen(body))}
        (then
          (local.set ${result} (local.get $${paramName}))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`, 'f64')
}

export const findIndex = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  ctx.usedMemory = true
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.findIndex requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'
  const id = ctx.loopCounter++
  const arr = `$_findi_arr_${id}`, result = `$_findi_result_${id}`, idx = `$_findi_i_${id}`, len = `$_findi_len_${id}`
  ctx.addLocal(arr.slice(1), 'f64')
  ctx.addLocal(result.slice(1), 'i32')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(paramName, 'f64')
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(`(local.get ${arr})`)})
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const -1))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} ${arrGet(`(local.get ${arr})`, `(local.get ${idx})`)})
      (if ${bool(gen(body))}
        (then
          (local.set ${result} (local.get ${idx}))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`, 'i32')
}

export const indexOf = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  ctx.usedMemory = true
  const searchVal = gen(args[0])
  const id = ctx.loopCounter++
  const arr = `$_indexof_arr_${id}`, target = `$_indexof_target_${id}`, idx = `$_indexof_i_${id}`, len = `$_indexof_len_${id}`, result = `$_indexof_result_${id}`
  ctx.addLocal(arr.slice(1), 'f64')
  ctx.addLocal(target.slice(1), 'f64')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(result.slice(1), 'i32')
  return wat(`(local.set ${arr} ${rw})
    (local.set ${target} ${f64(searchVal)})
    (local.set ${len} ${arrLen(`(local.get ${arr})`)})
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const -1))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (if (f64.eq ${arrGet(`(local.get ${arr})`, `(local.get ${idx})`)} (local.get ${target}))
        (then
          (local.set ${result} (local.get ${idx}))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`, 'i32')
}

export const includes = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  ctx.usedMemory = true
  const searchVal = gen(args[0])
  const id = ctx.loopCounter++
  const arr = `$_includes_arr_${id}`, target = `$_includes_target_${id}`, idx = `$_includes_i_${id}`, len = `$_includes_len_${id}`, result = `$_includes_result_${id}`
  ctx.addLocal(arr.slice(1), 'f64')
  ctx.addLocal(target.slice(1), 'f64')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(result.slice(1), 'i32')
  return wat(`(local.set ${arr} ${rw})
    (local.set ${target} ${f64(searchVal)})
    (local.set ${len} ${arrLen(`(local.get ${arr})`)})
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (if (f64.eq ${arrGet(`(local.get ${arr})`, `(local.get ${idx})`)} (local.get ${target}))
        (then
          (local.set ${result} (i32.const 1))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`, 'i32')
}

export const every = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  ctx.usedMemory = true
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.every requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'
  const id = ctx.loopCounter++
  const arr = `$_every_arr_${id}`, result = `$_every_result_${id}`, idx = `$_every_i_${id}`, len = `$_every_len_${id}`
  ctx.addLocal(arr.slice(1), 'f64')
  ctx.addLocal(result.slice(1), 'i32')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(paramName, 'f64')
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(`(local.get ${arr})`)})
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const 1))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} ${arrGet(`(local.get ${arr})`, `(local.get ${idx})`)})
      (if (i32.eqz ${bool(gen(body))})
        (then
          (local.set ${result} (i32.const 0))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`, 'i32')
}

export const some = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  ctx.usedMemory = true
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.some requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'
  const id = ctx.loopCounter++
  const arr = `$_some_arr_${id}`, result = `$_some_result_${id}`, idx = `$_some_i_${id}`, len = `$_some_len_${id}`
  ctx.addLocal(arr.slice(1), 'f64')
  ctx.addLocal(result.slice(1), 'i32')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(paramName, 'f64')
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(`(local.get ${arr})`)})
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} ${arrGet(`(local.get ${arr})`, `(local.get ${idx})`)})
      (if ${bool(gen(body))}
        (then
          (local.set ${result} (i32.const 1))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`, 'i32')
}

export const slice = (rw, args) => {
  ctx.usedArrayType = true
  ctx.usedMemory = true
  ctx.returnsArrayPointer = true
  const id = ctx.loopCounter++
  const arr = `$_slice_arr_${id}`, len = `$_slice_len_${id}`, result = `$_slice_result_${id}`, start = `$_slice_start_${id}`, end = `$_slice_end_${id}`, newLen = `$_slice_newlen_${id}`
  ctx.addLocal(arr.slice(1), 'f64')
  ctx.addLocal(result.slice(1), 'f64')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(start.slice(1), 'i32')
  ctx.addLocal(end.slice(1), 'i32')
  ctx.addLocal(newLen.slice(1), 'i32')
  const startArg = args.length >= 1 ? i32(gen(args[0])) : '(i32.const 0)'
  const endArg = args.length >= 2 ? i32(gen(args[1])) : arrLen(`(local.get ${arr})`)
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(`(local.get ${arr})`)})
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
    (local.set ${result} ${arrNew(`(local.get ${newLen})`)})
    ${arrCopy(`(local.get ${result})`, `(i32.const 0)`, `(local.get ${arr})`, `(local.get ${start})`, `(local.get ${newLen})`)}
    (local.get ${result})`, 'f64')
}

export const reverse = (rw, args) => {
  ctx.usedArrayType = true
  ctx.usedMemory = true
  ctx.returnsArrayPointer = true
  const id = ctx.loopCounter++
  const arr = `$_rev_arr_${id}`, left = `$_rev_left_${id}`, right = `$_rev_right_${id}`, tmp = `$_rev_tmp_${id}`, len = `$_rev_len_${id}`
  ctx.addLocal(arr.slice(1), 'f64')
  ctx.addLocal(left.slice(1), 'i32')
  ctx.addLocal(right.slice(1), 'i32')
  ctx.addLocal(tmp.slice(1), 'f64')
  ctx.addLocal(len.slice(1), 'i32')
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(`(local.get ${arr})`)})
    (local.set ${left} (i32.const 0))
    (local.set ${right} (i32.sub (local.get ${len}) (i32.const 1)))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${left}) (local.get ${right})))
      (local.set ${tmp} ${arrGet(`(local.get ${arr})`, `(local.get ${left})`)})
      ${arrSet(`(local.get ${arr})`, `(local.get ${left})`, arrGet(`(local.get ${arr})`, `(local.get ${right})`))}
      ${arrSet(`(local.get ${arr})`, `(local.get ${right})`, `(local.get ${tmp})`)}
      (local.set ${left} (i32.add (local.get ${left}) (i32.const 1)))
      (local.set ${right} (i32.sub (local.get ${right}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${arr})`, 'f64')
}

export const push = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  ctx.usedMemory = true
  const val = gen(args[0])
  const id = ctx.loopCounter++
  const arr = `$_push_arr_${id}`, result = `$_push_result_${id}`, len = `$_push_len_${id}`
  ctx.addLocal(arr.slice(1), 'f64')
  ctx.addLocal(result.slice(1), 'f64')
  ctx.addLocal(len.slice(1), 'i32')
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(`(local.get ${arr})`)})
    (local.set ${result} ${arrNew(`(i32.add (local.get ${len}) (i32.const 1))`)})
    ${arrCopy(`(local.get ${result})`, `(i32.const 0)`, `(local.get ${arr})`, `(i32.const 0)`, `(local.get ${len})`)}
    ${arrSet(`(local.get ${result})`, `(local.get ${len})`, f64(val))}
    (local.get ${result})`, 'f64')
}

export const pop = (rw, args) => {
  ctx.usedArrayType = true
  ctx.usedMemory = true
  const id = ctx.loopCounter++
  const arr = `$_pop_arr_${id}`, len = `$_pop_len_${id}`
  ctx.addLocal(arr.slice(1), 'f64')
  ctx.addLocal(len.slice(1), 'i32')
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(`(local.get ${arr})`)})
    (if (result f64) (i32.gt_s (local.get ${len}) (i32.const 0))
      (then ${arrGet(`(local.get ${arr})`, `(i32.sub (local.get ${len}) (i32.const 1))`)})
      (else (f64.const nan)))`, 'f64')
}

// shift() - returns first element, does not mutate array (returns new view would require tracking)
// For now: simple implementation that just returns first element
export const shift = (rw, args) => {
  ctx.usedArrayType = true
  ctx.usedMemory = true
  const id = ctx.loopCounter++
  const arr = `$_shift_arr_${id}`, len = `$_shift_len_${id}`
  ctx.addLocal(arr.slice(1), 'f64')
  ctx.addLocal(len.slice(1), 'i32')
  // Returns first element or NaN if empty
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(`(local.get ${arr})`)})
    (if (result f64) (i32.gt_s (local.get ${len}) (i32.const 0))
      (then ${arrGet(`(local.get ${arr})`, `(i32.const 0)`)})
      (else (f64.const nan)))`, 'f64')
}

// unshift(x) - add element to start, returns new array
export const unshift = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  ctx.usedMemory = true
  ctx.returnsArrayPointer = true
  const val = gen(args[0])
  const id = ctx.loopCounter++
  const arr = `$_unshift_arr_${id}`, result = `$_unshift_result_${id}`, len = `$_unshift_len_${id}`
  ctx.addLocal(arr.slice(1), 'f64')
  ctx.addLocal(result.slice(1), 'f64')
  ctx.addLocal(len.slice(1), 'i32')
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(`(local.get ${arr})`)})
    (local.set ${result} ${arrNew(`(i32.add (local.get ${len}) (i32.const 1))`)})
    ${arrSet(`(local.get ${result})`, `(i32.const 0)`, f64(val))}
    ${arrCopy(`(local.get ${result})`, `(i32.const 1)`, `(local.get ${arr})`, `(i32.const 0)`, `(local.get ${len})`)}
    (local.get ${result})`, 'f64')
}

export const forEach = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  ctx.usedMemory = true
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.forEach requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'
  const id = ctx.loopCounter++
  const arr = `$_foreach_arr_${id}`, idx = `$_foreach_i_${id}`, len = `$_foreach_len_${id}`
  ctx.addLocal(arr.slice(1), 'f64')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(paramName, 'f64')
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(`(local.get ${arr})`)})
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} ${arrGet(`(local.get ${arr})`, `(local.get ${idx})`)})
      (drop ${f64(gen(body))})
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (f64.const 0)`, 'f64')
}

export const concat = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  ctx.usedMemory = true
  ctx.returnsArrayPointer = true
  const arr2 = gen(args[0])
  const id = ctx.loopCounter++
  const arr1 = `$_concat_arr1_${id}`, arr2loc = `$_concat_arr2_${id}`, result = `$_concat_result_${id}`, len1 = `$_concat_len1_${id}`, len2 = `$_concat_len2_${id}`
  ctx.addLocal(arr1.slice(1), 'f64')
  ctx.addLocal(arr2loc.slice(1), 'f64')
  ctx.addLocal(result.slice(1), 'f64')
  ctx.addLocal(len1.slice(1), 'i32')
  ctx.addLocal(len2.slice(1), 'i32')
  return wat(`(local.set ${arr1} ${rw})
    (local.set ${arr2loc} ${arr2})
    (local.set ${len1} ${arrLen(`(local.get ${arr1})`)})
    (local.set ${len2} ${arrLen(`(local.get ${arr2loc})`)})
    (local.set ${result} ${arrNew(`(i32.add (local.get ${len1}) (local.get ${len2}))`)})
    ${arrCopy(`(local.get ${result})`, `(i32.const 0)`, `(local.get ${arr1})`, `(i32.const 0)`, `(local.get ${len1})`)}
    ${arrCopy(`(local.get ${result})`, `(local.get ${len1})`, `(local.get ${arr2loc})`, `(i32.const 0)`, `(local.get ${len2})`)}
    (local.get ${result})`, 'f64')
}

// join() - TODO: requires number-to-string conversion (complex)
// For now returns 0 (placeholder)
export const join = (rw, args) => {
  // Proper join would need f64->string conversion which is complex in WASM
  // Return 0 as placeholder - users should use JS for string operations
  return wat('(f64.const 0)', 'f64')
}

// flat(depth) - flatten nested arrays by depth levels (default 1)
export const flat = (rw, args) => {
  ctx.usedArrayType = true
  ctx.usedMemory = true
  ctx.returnsArrayPointer = true
  const depth = args.length > 0 ? gen(args[0]) : '(f64.const 1)'
  const id = ctx.loopCounter++
  const arr = `$_flat_arr_${id}`, result = `$_flat_result_${id}`, idx = `$_flat_i_${id}`, len = `$_flat_len_${id}`
  const elem = `$_flat_elem_${id}`, innerIdx = `$_flat_j_${id}`, innerLen = `$_flat_ilen_${id}`, outIdx = `$_flat_out_${id}`
  ctx.addLocal(arr.slice(1), 'f64')
  ctx.addLocal(result.slice(1), 'f64')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(elem.slice(1), 'f64')
  ctx.addLocal(innerIdx.slice(1), 'i32')
  ctx.addLocal(innerLen.slice(1), 'i32')
  ctx.addLocal(outIdx.slice(1), 'i32')
  // First pass: count total elements
  // Second pass: copy elements
  // For depth=1, check if element is pointer (NaN-boxed), if so expand
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(`(local.get ${arr})`)})
    ;; Count total elements for allocation (depth=1 only for now)
    (local.set ${outIdx} (i32.const 0))
    (local.set ${idx} (i32.const 0))
    (block $count_done_${id} (loop $count_loop_${id}
      (br_if $count_done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set ${elem} ${arrGet(`(local.get ${arr})`, `(local.get ${idx})`)})
      (if (call $__is_pointer (local.get ${elem}))
        (then (local.set ${outIdx} (i32.add (local.get ${outIdx}) (call $__ptr_len (local.get ${elem})))))
        (else (local.set ${outIdx} (i32.add (local.get ${outIdx}) (i32.const 1)))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $count_loop_${id})))
    ;; Allocate result array
    (local.set ${result} ${arrNew(`(local.get ${outIdx})`)})
    ;; Copy elements, flattening nested arrays
    (local.set ${outIdx} (i32.const 0))
    (local.set ${idx} (i32.const 0))
    (block $copy_done_${id} (loop $copy_loop_${id}
      (br_if $copy_done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set ${elem} ${arrGet(`(local.get ${arr})`, `(local.get ${idx})`)})
      (if (call $__is_pointer (local.get ${elem}))
        (then
          ;; It's a nested array - copy its elements
          (local.set ${innerLen} (call $__ptr_len (local.get ${elem})))
          (local.set ${innerIdx} (i32.const 0))
          (block $inner_done_${id} (loop $inner_loop_${id}
            (br_if $inner_done_${id} (i32.ge_s (local.get ${innerIdx}) (local.get ${innerLen})))
            ${arrSet(`(local.get ${result})`, `(local.get ${outIdx})`, arrGet(`(local.get ${elem})`, `(local.get ${innerIdx})`))}
            (local.set ${outIdx} (i32.add (local.get ${outIdx}) (i32.const 1)))
            (local.set ${innerIdx} (i32.add (local.get ${innerIdx}) (i32.const 1)))
            (br $inner_loop_${id}))))
        (else
          ;; It's a regular value - copy directly
          ${arrSet(`(local.get ${result})`, `(local.get ${outIdx})`, `(local.get ${elem})`)}
          (local.set ${outIdx} (i32.add (local.get ${outIdx}) (i32.const 1)))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $copy_loop_${id})))
    (local.get ${result})`, 'f64')
}

// flatMap(fn) - map then flatten (equivalent to .map(fn).flat(1))
export const flatMap = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  ctx.usedMemory = true
  ctx.returnsArrayPointer = true
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.flatMap requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'
  const id = ctx.loopCounter++
  const arr = `$_flatmap_arr_${id}`, mapped = `$_flatmap_mapped_${id}`, result = `$_flatmap_result_${id}`
  const idx = `$_flatmap_i_${id}`, len = `$_flatmap_len_${id}`, elem = `$_flatmap_elem_${id}`
  const innerIdx = `$_flatmap_j_${id}`, innerLen = `$_flatmap_ilen_${id}`, outIdx = `$_flatmap_out_${id}`
  ctx.addLocal(arr.slice(1), 'f64')
  ctx.addLocal(mapped.slice(1), 'f64')
  ctx.addLocal(result.slice(1), 'f64')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(elem.slice(1), 'f64')
  ctx.addLocal(innerIdx.slice(1), 'i32')
  ctx.addLocal(innerLen.slice(1), 'i32')
  ctx.addLocal(outIdx.slice(1), 'i32')
  ctx.addLocal(paramName, 'f64')
  // First pass: map and count total elements
  // Second pass: map again and flatten into result
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(`(local.get ${arr})`)})
    ;; First pass: count total elements after map+flatten
    (local.set ${outIdx} (i32.const 0))
    (local.set ${idx} (i32.const 0))
    (block $count_done_${id} (loop $count_loop_${id}
      (br_if $count_done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} ${arrGet(`(local.get ${arr})`, `(local.get ${idx})`)})
      (local.set ${elem} ${f64(gen(body))})
      (if (call $__is_pointer (local.get ${elem}))
        (then (local.set ${outIdx} (i32.add (local.get ${outIdx}) (call $__ptr_len (local.get ${elem})))))
        (else (local.set ${outIdx} (i32.add (local.get ${outIdx}) (i32.const 1)))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $count_loop_${id})))
    ;; Allocate result array
    (local.set ${result} ${arrNew(`(local.get ${outIdx})`)})
    ;; Second pass: map again and flatten
    (local.set ${outIdx} (i32.const 0))
    (local.set ${idx} (i32.const 0))
    (block $copy_done_${id} (loop $copy_loop_${id}
      (br_if $copy_done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} ${arrGet(`(local.get ${arr})`, `(local.get ${idx})`)})
      (local.set ${elem} ${f64(gen(body))})
      (if (call $__is_pointer (local.get ${elem}))
        (then
          ;; Result is array - flatten it
          (local.set ${innerLen} (call $__ptr_len (local.get ${elem})))
          (local.set ${innerIdx} (i32.const 0))
          (block $inner_done_${id} (loop $inner_loop_${id}
            (br_if $inner_done_${id} (i32.ge_s (local.get ${innerIdx}) (local.get ${innerLen})))
            ${arrSet(`(local.get ${result})`, `(local.get ${outIdx})`, arrGet(`(local.get ${elem})`, `(local.get ${innerIdx})`))}
            (local.set ${outIdx} (i32.add (local.get ${outIdx}) (i32.const 1)))
            (local.set ${innerIdx} (i32.add (local.get ${innerIdx}) (i32.const 1)))
            (br $inner_loop_${id}))))
        (else
          ;; Result is scalar - copy directly
          ${arrSet(`(local.get ${result})`, `(local.get ${outIdx})`, `(local.get ${elem})`)}
          (local.set ${outIdx} (i32.add (local.get ${outIdx}) (i32.const 1)))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $copy_loop_${id})))    (local.get ${result})`, 'f64')
}
