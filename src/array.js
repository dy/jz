// Array method implementations
import { ctx, opts, gen } from './compile.js'
import { PTR_TYPE, wat, f64, i32, bool } from './types.js'
import { extractParams } from './analyze.js'
import { arrGet, arrSet, arrLen, arrNew } from './gc.js'

export const fill = (rw, args) => {
  if (args.length < 1) return null  // Let fallback handle error
  ctx.usedArrayType = true
  if (opts.gc) {
    ctx.usedStdlib.push('arrayFill')
    return wat(`(call $arrayFill ${rw} ${f64(gen(args[0]))})`, 'array')
  }
  ctx.usedMemory = true
  ctx.usedStdlib.push('arrayFillMem')
  return wat(`(call $arrayFillMem ${rw} ${f64(gen(args[0]))})`, 'f64')
}

export const map = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  if (!opts.gc) ctx.usedMemory = true
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.map requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'
  const id = ctx.loopCounter++
  const arr = `$_map_arr_${id}`, result = `$_map_result_${id}`, idx = `$_map_i_${id}`, len = `$_map_len_${id}`
  ctx.addLocal(arr.slice(1), opts.gc ? 'array' : 'f64')
  ctx.addLocal(result.slice(1), opts.gc ? 'array' : 'f64')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(paramName, 'f64')
  const gc = opts.gc
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(gc, `(local.get ${arr})`)})
    (local.set ${result} ${arrNew(gc, `(local.get ${len})`)})
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} ${arrGet(gc, `(local.get ${arr})`, `(local.get ${idx})`)})
      ${arrSet(gc, `(local.get ${result})`, `(local.get ${idx})`, f64(gen(body)))}
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`, gc ? 'array' : 'f64')
}

export const reduce = (rw, args) => {
  if (args.length < 1) return null
  ctx.usedArrayType = true
  if (!opts.gc) ctx.usedMemory = true
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.reduce requires arrow function')
  const [, params, body] = callback
  const paramNames = extractParams(params)
  const accName = paramNames[0] || '_acc', curName = paramNames[1] || '_cur'
  const id = ctx.loopCounter++
  const arr = `$_reduce_arr_${id}`, acc = `$_reduce_acc_${id}`, idx = `$_reduce_i_${id}`, len = `$_reduce_len_${id}`
  ctx.addLocal(arr.slice(1), opts.gc ? 'array' : 'f64')
  ctx.addLocal(acc.slice(1), 'f64')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(accName, 'f64')
  ctx.addLocal(curName, 'f64')
  const initVal = args.length >= 2 ? f64(gen(args[1])) : '(f64.const 0)'
  const gc = opts.gc
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(gc, `(local.get ${arr})`)})
    (local.set ${acc} ${initVal})
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${accName} (local.get ${acc}))
      (local.set $${curName} ${arrGet(gc, `(local.get ${arr})`, `(local.get ${idx})`)})
      (local.set ${acc} ${f64(gen(body))})
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${acc})`, 'f64')
}

export const filter = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  if (!opts.gc) ctx.usedMemory = true
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.filter requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'
  const id = ctx.loopCounter++
  const arr = `$_filter_arr_${id}`, result = `$_filter_result_${id}`, idx = `$_filter_i_${id}`, len = `$_filter_len_${id}`, count = `$_filter_count_${id}`
  ctx.addLocal(arr.slice(1), opts.gc ? 'array' : 'f64')
  ctx.addLocal(result.slice(1), opts.gc ? 'array' : 'f64')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(count.slice(1), 'i32')
  ctx.addLocal(paramName, 'f64')
  const gc = opts.gc
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(gc, `(local.get ${arr})`)})
    (local.set ${result} ${arrNew(gc, `(local.get ${len})`)})
    (local.set ${idx} (i32.const 0))
    (local.set ${count} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} ${arrGet(gc, `(local.get ${arr})`, `(local.get ${idx})`)})
      (if ${bool(gen(body))}
        (then
          ${arrSet(gc, `(local.get ${result})`, `(local.get ${count})`, `(local.get $${paramName})`)}
          (local.set ${count} (i32.add (local.get ${count}) (i32.const 1)))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`, gc ? 'array' : 'f64')
}

export const find = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  if (!opts.gc) ctx.usedMemory = true
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.find requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'
  const id = ctx.loopCounter++
  const arr = `$_find_arr_${id}`, result = `$_find_result_${id}`, idx = `$_find_i_${id}`, len = `$_find_len_${id}`
  ctx.addLocal(arr.slice(1), opts.gc ? 'array' : 'f64')
  ctx.addLocal(result.slice(1), 'f64')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(paramName, 'f64')
  const gc = opts.gc
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(gc, `(local.get ${arr})`)})
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (f64.const nan))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} ${arrGet(gc, `(local.get ${arr})`, `(local.get ${idx})`)})
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
  if (!opts.gc) ctx.usedMemory = true
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.findIndex requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'
  const id = ctx.loopCounter++
  const arr = `$_findi_arr_${id}`, result = `$_findi_result_${id}`, idx = `$_findi_i_${id}`, len = `$_findi_len_${id}`
  ctx.addLocal(arr.slice(1), opts.gc ? 'array' : 'f64')
  ctx.addLocal(result.slice(1), 'i32')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(paramName, 'f64')
  const gc = opts.gc
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(gc, `(local.get ${arr})`)})
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const -1))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} ${arrGet(gc, `(local.get ${arr})`, `(local.get ${idx})`)})
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
  if (!opts.gc) ctx.usedMemory = true
  const searchVal = gen(args[0])
  const id = ctx.loopCounter++
  const arr = `$_indexof_arr_${id}`, target = `$_indexof_target_${id}`, idx = `$_indexof_i_${id}`, len = `$_indexof_len_${id}`, result = `$_indexof_result_${id}`
  ctx.addLocal(arr.slice(1), opts.gc ? 'array' : 'f64')
  ctx.addLocal(target.slice(1), 'f64')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(result.slice(1), 'i32')
  const gc = opts.gc
  return wat(`(local.set ${arr} ${rw})
    (local.set ${target} ${f64(searchVal)})
    (local.set ${len} ${arrLen(gc, `(local.get ${arr})`)})
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const -1))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (if (f64.eq ${arrGet(gc, `(local.get ${arr})`, `(local.get ${idx})`)} (local.get ${target}))
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
  if (!opts.gc) ctx.usedMemory = true
  const searchVal = gen(args[0])
  const id = ctx.loopCounter++
  const arr = `$_includes_arr_${id}`, target = `$_includes_target_${id}`, idx = `$_includes_i_${id}`, len = `$_includes_len_${id}`, result = `$_includes_result_${id}`
  ctx.addLocal(arr.slice(1), opts.gc ? 'array' : 'f64')
  ctx.addLocal(target.slice(1), 'f64')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(result.slice(1), 'i32')
  const gc = opts.gc
  return wat(`(local.set ${arr} ${rw})
    (local.set ${target} ${f64(searchVal)})
    (local.set ${len} ${arrLen(gc, `(local.get ${arr})`)})
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (if (f64.eq ${arrGet(gc, `(local.get ${arr})`, `(local.get ${idx})`)} (local.get ${target}))
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
  if (!opts.gc) ctx.usedMemory = true
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.every requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'
  const id = ctx.loopCounter++
  const arr = `$_every_arr_${id}`, result = `$_every_result_${id}`, idx = `$_every_i_${id}`, len = `$_every_len_${id}`
  ctx.addLocal(arr.slice(1), opts.gc ? 'array' : 'f64')
  ctx.addLocal(result.slice(1), 'i32')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(paramName, 'f64')
  const gc = opts.gc
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(gc, `(local.get ${arr})`)})
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const 1))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} ${arrGet(gc, `(local.get ${arr})`, `(local.get ${idx})`)})
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
  if (!opts.gc) ctx.usedMemory = true
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.some requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'
  const id = ctx.loopCounter++
  const arr = `$_some_arr_${id}`, result = `$_some_result_${id}`, idx = `$_some_i_${id}`, len = `$_some_len_${id}`
  ctx.addLocal(arr.slice(1), opts.gc ? 'array' : 'f64')
  ctx.addLocal(result.slice(1), 'i32')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(paramName, 'f64')
  const gc = opts.gc
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(gc, `(local.get ${arr})`)})
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} ${arrGet(gc, `(local.get ${arr})`, `(local.get ${idx})`)})
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
  if (!opts.gc) ctx.usedMemory = true
  const id = ctx.loopCounter++
  const arr = `$_slice_arr_${id}`, idx = `$_slice_i_${id}`, len = `$_slice_len_${id}`, result = `$_slice_result_${id}`, start = `$_slice_start_${id}`, end = `$_slice_end_${id}`, newLen = `$_slice_newlen_${id}`
  ctx.addLocal(arr.slice(1), opts.gc ? 'array' : 'f64')
  ctx.addLocal(result.slice(1), opts.gc ? 'array' : 'f64')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(start.slice(1), 'i32')
  ctx.addLocal(end.slice(1), 'i32')
  ctx.addLocal(newLen.slice(1), 'i32')
  const gc = opts.gc
  const startArg = args.length >= 1 ? i32(gen(args[0])) : '(i32.const 0)'
  const endArg = args.length >= 2 ? i32(gen(args[1])) : arrLen(gc, `(local.get ${arr})`)
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(gc, `(local.get ${arr})`)})
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
    (local.set ${result} ${arrNew(gc, `(local.get ${newLen})`)})
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${newLen})))
      ${arrSet(gc, `(local.get ${result})`, `(local.get ${idx})`, arrGet(gc, `(local.get ${arr})`, `(i32.add (local.get ${start}) (local.get ${idx}))`))}
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`, gc ? 'array' : 'f64')
}

export const reverse = (rw, args) => {
  ctx.usedArrayType = true
  if (!opts.gc) ctx.usedMemory = true
  const id = ctx.loopCounter++
  const arr = `$_rev_arr_${id}`, left = `$_rev_left_${id}`, right = `$_rev_right_${id}`, tmp = `$_rev_tmp_${id}`, len = `$_rev_len_${id}`
  ctx.addLocal(arr.slice(1), opts.gc ? 'array' : 'f64')
  ctx.addLocal(left.slice(1), 'i32')
  ctx.addLocal(right.slice(1), 'i32')
  ctx.addLocal(tmp.slice(1), 'f64')
  ctx.addLocal(len.slice(1), 'i32')
  const gc = opts.gc
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(gc, `(local.get ${arr})`)})
    (local.set ${left} (i32.const 0))
    (local.set ${right} (i32.sub (local.get ${len}) (i32.const 1)))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${left}) (local.get ${right})))
      (local.set ${tmp} ${arrGet(gc, `(local.get ${arr})`, `(local.get ${left})`)})
      ${arrSet(gc, `(local.get ${arr})`, `(local.get ${left})`, arrGet(gc, `(local.get ${arr})`, `(local.get ${right})`))}
      ${arrSet(gc, `(local.get ${arr})`, `(local.get ${right})`, `(local.get ${tmp})`)}
      (local.set ${left} (i32.add (local.get ${left}) (i32.const 1)))
      (local.set ${right} (i32.sub (local.get ${right}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${arr})`, gc ? 'array' : 'f64')
}

export const push = (rw, args) => {
  if (args.length !== 1) return null
  // In-place push not supported without resizable arrays, return new array with element appended
  ctx.usedArrayType = true
  if (!opts.gc) ctx.usedMemory = true
  const val = gen(args[0])
  const id = ctx.loopCounter++
  const arr = `$_push_arr_${id}`, result = `$_push_result_${id}`, idx = `$_push_i_${id}`, len = `$_push_len_${id}`
  ctx.addLocal(arr.slice(1), opts.gc ? 'array' : 'f64')
  ctx.addLocal(result.slice(1), opts.gc ? 'array' : 'f64')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  const gc = opts.gc
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(gc, `(local.get ${arr})`)})
    (local.set ${result} ${arrNew(gc, `(i32.add (local.get ${len}) (i32.const 1))`)})
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      ${arrSet(gc, `(local.get ${result})`, `(local.get ${idx})`, arrGet(gc, `(local.get ${arr})`, `(local.get ${idx})`))}
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    ${arrSet(gc, `(local.get ${result})`, `(local.get ${len})`, f64(val))}
    (local.get ${result})`, gc ? 'array' : 'f64')
}

export const pop = (rw, args) => {
  // Returns last element (doesn't modify original without resizable arrays)
  ctx.usedArrayType = true
  if (!opts.gc) ctx.usedMemory = true
  const id = ctx.loopCounter++
  const arr = `$_pop_arr_${id}`, len = `$_pop_len_${id}`
  ctx.addLocal(arr.slice(1), opts.gc ? 'array' : 'f64')
  ctx.addLocal(len.slice(1), 'i32')
  const gc = opts.gc
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(gc, `(local.get ${arr})`)})
    (if (result f64) (i32.gt_s (local.get ${len}) (i32.const 0))
      (then ${arrGet(gc, `(local.get ${arr})`, `(i32.sub (local.get ${len}) (i32.const 1))`)})
      (else (f64.const nan)))`, 'f64')
}

export const forEach = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  if (!opts.gc) ctx.usedMemory = true
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.forEach requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'
  const id = ctx.loopCounter++
  const arr = `$_foreach_arr_${id}`, idx = `$_foreach_i_${id}`, len = `$_foreach_len_${id}`
  ctx.addLocal(arr.slice(1), opts.gc ? 'array' : 'f64')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(paramName, 'f64')
  const gc = opts.gc
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(gc, `(local.get ${arr})`)})
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} ${arrGet(gc, `(local.get ${arr})`, `(local.get ${idx})`)})
      (drop ${f64(gen(body))})
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (f64.const 0)`, 'f64')
}

export const concat = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  if (!opts.gc) ctx.usedMemory = true
  const arr2 = gen(args[0])
  const id = ctx.loopCounter++
  const arr1 = `$_concat_arr1_${id}`, arr2loc = `$_concat_arr2_${id}`, result = `$_concat_result_${id}`, idx = `$_concat_i_${id}`, len1 = `$_concat_len1_${id}`, len2 = `$_concat_len2_${id}`
  ctx.addLocal(arr1.slice(1), opts.gc ? 'array' : 'f64')
  ctx.addLocal(arr2loc.slice(1), opts.gc ? 'array' : 'f64')
  ctx.addLocal(result.slice(1), opts.gc ? 'array' : 'f64')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len1.slice(1), 'i32')
  ctx.addLocal(len2.slice(1), 'i32')
  const gc = opts.gc
  return wat(`(local.set ${arr1} ${rw})
    (local.set ${arr2loc} ${arr2})
    (local.set ${len1} ${arrLen(gc, `(local.get ${arr1})`)})
    (local.set ${len2} ${arrLen(gc, `(local.get ${arr2loc})`)})
    (local.set ${result} ${arrNew(gc, `(i32.add (local.get ${len1}) (local.get ${len2}))`)})
    (local.set ${idx} (i32.const 0))
    (block $done1_${id} (loop $loop1_${id}
      (br_if $done1_${id} (i32.ge_s (local.get ${idx}) (local.get ${len1})))
      ${arrSet(gc, `(local.get ${result})`, `(local.get ${idx})`, arrGet(gc, `(local.get ${arr1})`, `(local.get ${idx})`))}
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop1_${id})))
    (local.set ${idx} (i32.const 0))
    (block $done2_${id} (loop $loop2_${id}
      (br_if $done2_${id} (i32.ge_s (local.get ${idx}) (local.get ${len2})))
      ${arrSet(gc, `(local.get ${result})`, `(i32.add (local.get ${len1}) (local.get ${idx}))`, arrGet(gc, `(local.get ${arr2loc})`, `(local.get ${idx})`))}
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop2_${id})))
    (local.get ${result})`, gc ? 'array' : 'f64')
}

export const join = (rw, args) => {
  // Returns sum of all elements (simplified join for numeric arrays)
  ctx.usedArrayType = true
  if (!opts.gc) ctx.usedMemory = true
  const id = ctx.loopCounter++
  const arr = `$_join_arr_${id}`, result = `$_join_result_${id}`, idx = `$_join_i_${id}`, len = `$_join_len_${id}`
  ctx.addLocal(arr.slice(1), opts.gc ? 'array' : 'f64')
  ctx.addLocal(result.slice(1), 'f64')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  const gc = opts.gc
  return wat(`(local.set ${arr} ${rw})
    (local.set ${len} ${arrLen(gc, `(local.get ${arr})`)})
    (local.set ${result} (f64.const 0))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set ${result} (f64.add (local.get ${result}) ${arrGet(gc, `(local.get ${arr})`, `(local.get ${idx})`)}))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`, 'f64')
}
