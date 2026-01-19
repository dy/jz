// Array method implementations
import { ctx, opts, gen, tv, asF64, asI32, truthy, PTR_TYPE, extractParams } from '../compile.js'

export const fill = (rw, args) => {
  if (args.length < 1) return null  // Let fallback handle error
  ctx.usedArrayType = true
  if (opts.gc) {
    ctx.usedStdlib.add('arrayFill')
    return tv('array', `(call $arrayFill ${rw} ${asF64(gen(args[0]))[1]})`)
  }
  ctx.usedMemory = true
  ctx.usedStdlib.add('arrayFillMem')
  return tv('f64', `(call $arrayFillMem ${rw} ${asF64(gen(args[0]))[1]})`)
}

export const map = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.map requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'
  const id = ctx.loopCounter++
  const arr = `$_map_arr_${id}`, result = `$_map_result_${id}`, idx = `$_map_i_${id}`, len = `$_map_len_${id}`
  if (opts.gc) {
    ctx.addLocal(arr.slice(1), 'array')
    ctx.addLocal(result.slice(1), 'array')
  } else {
    ctx.addLocal(arr.slice(1), 'f64')
    ctx.addLocal(result.slice(1), 'f64')
  }
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(paramName, 'f64')
  if (opts.gc) {
    return tv('array', `(local.set ${arr} ${rw})
    (local.set ${len} (array.len (local.get ${arr})))
    (local.set ${result} (array.new $f64array (f64.const 0) (local.get ${len})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} (array.get $f64array (local.get ${arr}) (local.get ${idx})))
      (array.set $f64array (local.get ${result}) (local.get ${idx}) ${asF64(gen(body))[1]})
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
  }
  ctx.usedMemory = true
  return tv('f64', `(local.set ${arr} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (local.set ${result} (call $__alloc (i32.const ${PTR_TYPE.F64_ARRAY}) (local.get ${len})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${idx}) (i32.const 3)))))
      (f64.store (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (local.get ${idx}) (i32.const 3))) ${asF64(gen(body))[1]})
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
}

export const reduce = (rw, args) => {
  if (args.length < 1) return null
  ctx.usedArrayType = true
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.reduce requires arrow function')
  const [, params, body] = callback
  const paramNames = extractParams(params)
  const accName = paramNames[0] || '_acc', curName = paramNames[1] || '_cur'
  const id = ctx.loopCounter++
  const arr = `$_reduce_arr_${id}`, acc = `$_reduce_acc_${id}`, idx = `$_reduce_i_${id}`, len = `$_reduce_len_${id}`
  if (opts.gc) {
    ctx.addLocal(arr.slice(1), 'array')
  } else {
    ctx.addLocal(arr.slice(1), 'f64')
  }
  ctx.addLocal(acc.slice(1), 'f64')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(accName, 'f64')
  ctx.addLocal(curName, 'f64')
  const initVal = args.length >= 2 ? asF64(gen(args[1]))[1] : '(f64.const 0)'
  if (opts.gc) {
    return tv('f64', `(local.set ${arr} ${rw})
    (local.set ${len} (array.len (local.get ${arr})))
    (local.set ${acc} ${initVal})
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${accName} (local.get ${acc}))
      (local.set $${curName} (array.get $f64array (local.get ${arr}) (local.get ${idx})))
      (local.set ${acc} ${asF64(gen(body))[1]})
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${acc})`)
  }
  ctx.usedMemory = true
  return tv('f64', `(local.set ${arr} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (local.set ${acc} ${initVal})
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${accName} (local.get ${acc}))
      (local.set $${curName} (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${idx}) (i32.const 3)))))
      (local.set ${acc} ${asF64(gen(body))[1]})
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${acc})`)
}

export const filter = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.filter requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'
  const id = ctx.loopCounter++
  const arr = `$_filter_arr_${id}`, result = `$_filter_result_${id}`, idx = `$_filter_i_${id}`, len = `$_filter_len_${id}`, count = `$_filter_count_${id}`
  if (opts.gc) {
    ctx.addLocal(arr.slice(1), 'array')
    ctx.addLocal(result.slice(1), 'array')
  } else {
    ctx.addLocal(arr.slice(1), 'f64')
    ctx.addLocal(result.slice(1), 'f64')
  }
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(count.slice(1), 'i32')
  ctx.addLocal(paramName, 'f64')
  if (opts.gc) {
    return tv('array', `(local.set ${arr} ${rw})
    (local.set ${len} (array.len (local.get ${arr})))
    (local.set ${result} (array.new $f64array (f64.const 0) (local.get ${len})))
    (local.set ${idx} (i32.const 0))
    (local.set ${count} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} (array.get $f64array (local.get ${arr}) (local.get ${idx})))
      (if ${truthy(gen(body))[1]}
        (then
          (array.set $f64array (local.get ${result}) (local.get ${count}) (local.get $${paramName}))
          (local.set ${count} (i32.add (local.get ${count}) (i32.const 1)))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
  }
  ctx.usedMemory = true
  return tv('f64', `(local.set ${arr} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (local.set ${result} (call $__alloc (i32.const ${PTR_TYPE.F64_ARRAY}) (local.get ${len})))
    (local.set ${idx} (i32.const 0))
    (local.set ${count} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${idx}) (i32.const 3)))))
      (if ${truthy(gen(body))[1]}
        (then
          (f64.store (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (local.get ${count}) (i32.const 3))) (local.get $${paramName}))
          (local.set ${count} (i32.add (local.get ${count}) (i32.const 1)))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
}

export const find = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.find requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'
  const id = ctx.loopCounter++
  const arr = `$_find_arr_${id}`, result = `$_find_result_${id}`, idx = `$_find_i_${id}`, len = `$_find_len_${id}`
  if (opts.gc) {
    ctx.addLocal(arr.slice(1), 'array')
  } else {
    ctx.addLocal(arr.slice(1), 'f64')
  }
  ctx.addLocal(result.slice(1), 'f64')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(paramName, 'f64')
  if (opts.gc) {
    return tv('f64', `(local.set ${arr} ${rw})
    (local.set ${len} (array.len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (f64.const nan))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} (array.get $f64array (local.get ${arr}) (local.get ${idx})))
      (if ${truthy(gen(body))[1]}
        (then
          (local.set ${result} (local.get $${paramName}))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
  }
  ctx.usedMemory = true
  return tv('f64', `(local.set ${arr} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (f64.const nan))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${idx}) (i32.const 3)))))
      (if ${truthy(gen(body))[1]}
        (then
          (local.set ${result} (local.get $${paramName}))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
}

export const findIndex = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.findIndex requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'
  const id = ctx.loopCounter++
  const arr = `$_findi_arr_${id}`, result = `$_findi_result_${id}`, idx = `$_findi_i_${id}`, len = `$_findi_len_${id}`
  if (opts.gc) {
    ctx.addLocal(arr.slice(1), 'array')
  } else {
    ctx.addLocal(arr.slice(1), 'f64')
  }
  ctx.addLocal(result.slice(1), 'i32')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(paramName, 'f64')
  if (opts.gc) {
    return tv('i32', `(local.set ${arr} ${rw})
    (local.set ${len} (array.len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const -1))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} (array.get $f64array (local.get ${arr}) (local.get ${idx})))
      (if ${truthy(gen(body))[1]}
        (then
          (local.set ${result} (local.get ${idx}))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
  }
  ctx.usedMemory = true
  return tv('i32', `(local.set ${arr} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const -1))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${idx}) (i32.const 3)))))
      (if ${truthy(gen(body))[1]}
        (then
          (local.set ${result} (local.get ${idx}))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
}

export const indexOf = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  const searchVal = gen(args[0])
  const id = ctx.loopCounter++
  const arr = `$_indexof_arr_${id}`, target = `$_indexof_target_${id}`, idx = `$_indexof_i_${id}`, len = `$_indexof_len_${id}`, result = `$_indexof_result_${id}`
  if (opts.gc) {
    ctx.addLocal(arr.slice(1), 'array')
  } else {
    ctx.addLocal(arr.slice(1), 'f64')
  }
  ctx.addLocal(target.slice(1), 'f64')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(result.slice(1), 'i32')
  if (opts.gc) {
    return tv('i32', `(local.set ${arr} ${rw})
    (local.set ${target} ${asF64(searchVal)[1]})
    (local.set ${len} (array.len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const -1))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (if (f64.eq (array.get $f64array (local.get ${arr}) (local.get ${idx})) (local.get ${target}))
        (then
          (local.set ${result} (local.get ${idx}))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
  }
  ctx.usedMemory = true
  return tv('i32', `(local.set ${arr} ${rw})
    (local.set ${target} ${asF64(searchVal)[1]})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const -1))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (if (f64.eq (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${idx}) (i32.const 3)))) (local.get ${target}))
        (then
          (local.set ${result} (local.get ${idx}))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
}

export const includes = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  const searchVal = gen(args[0])
  const id = ctx.loopCounter++
  const arr = `$_includes_arr_${id}`, target = `$_includes_target_${id}`, idx = `$_includes_i_${id}`, len = `$_includes_len_${id}`, result = `$_includes_result_${id}`
  if (opts.gc) {
    ctx.addLocal(arr.slice(1), 'array')
  } else {
    ctx.addLocal(arr.slice(1), 'f64')
  }
  ctx.addLocal(target.slice(1), 'f64')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(result.slice(1), 'i32')
  if (opts.gc) {
    return tv('i32', `(local.set ${arr} ${rw})
    (local.set ${target} ${asF64(searchVal)[1]})
    (local.set ${len} (array.len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (if (f64.eq (array.get $f64array (local.get ${arr}) (local.get ${idx})) (local.get ${target}))
        (then
          (local.set ${result} (i32.const 1))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
  }
  ctx.usedMemory = true
  return tv('i32', `(local.set ${arr} ${rw})
    (local.set ${target} ${asF64(searchVal)[1]})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (if (f64.eq (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${idx}) (i32.const 3)))) (local.get ${target}))
        (then
          (local.set ${result} (i32.const 1))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
}

export const every = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.every requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'
  const id = ctx.loopCounter++
  const arr = `$_every_arr_${id}`, result = `$_every_result_${id}`, idx = `$_every_i_${id}`, len = `$_every_len_${id}`
  if (opts.gc) {
    ctx.addLocal(arr.slice(1), 'array')
  } else {
    ctx.addLocal(arr.slice(1), 'f64')
  }
  ctx.addLocal(result.slice(1), 'i32')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(paramName, 'f64')
  if (opts.gc) {
    return tv('i32', `(local.set ${arr} ${rw})
    (local.set ${len} (array.len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const 1))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} (array.get $f64array (local.get ${arr}) (local.get ${idx})))
      (if (i32.eqz ${truthy(gen(body))[1]})
        (then
          (local.set ${result} (i32.const 0))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
  }
  ctx.usedMemory = true
  return tv('i32', `(local.set ${arr} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const 1))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${idx}) (i32.const 3)))))
      (if (i32.eqz ${truthy(gen(body))[1]})
        (then
          (local.set ${result} (i32.const 0))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
}

export const some = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.some requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'
  const id = ctx.loopCounter++
  const arr = `$_some_arr_${id}`, result = `$_some_result_${id}`, idx = `$_some_i_${id}`, len = `$_some_len_${id}`
  if (opts.gc) {
    ctx.addLocal(arr.slice(1), 'array')
  } else {
    ctx.addLocal(arr.slice(1), 'f64')
  }
  ctx.addLocal(result.slice(1), 'i32')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(paramName, 'f64')
  if (opts.gc) {
    return tv('i32', `(local.set ${arr} ${rw})
    (local.set ${len} (array.len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} (array.get $f64array (local.get ${arr}) (local.get ${idx})))
      (if ${truthy(gen(body))[1]}
        (then
          (local.set ${result} (i32.const 1))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
  }
  ctx.usedMemory = true
  return tv('i32', `(local.set ${arr} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (local.set ${result} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${idx}) (i32.const 3)))))
      (if ${truthy(gen(body))[1]}
        (then
          (local.set ${result} (i32.const 1))
          (br $done_${id})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
}

export const slice = (rw, args) => {
  ctx.usedArrayType = true
  const id = ctx.loopCounter++
  const arr = `$_slice_arr_${id}`, idx = `$_slice_i_${id}`, len = `$_slice_len_${id}`, result = `$_slice_result_${id}`, start = `$_slice_start_${id}`, end = `$_slice_end_${id}`, newLen = `$_slice_newlen_${id}`
  if (opts.gc) {
    ctx.addLocal(arr.slice(1), 'array')
    ctx.addLocal(result.slice(1), 'array')
  } else {
    ctx.addLocal(arr.slice(1), 'f64')
    ctx.addLocal(result.slice(1), 'f64')
  }
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(start.slice(1), 'i32')
  ctx.addLocal(end.slice(1), 'i32')
  ctx.addLocal(newLen.slice(1), 'i32')
  const startArg = args.length >= 1 ? asI32(gen(args[0]))[1] : '(i32.const 0)'
  if (opts.gc) {
    const endArg = args.length >= 2 ? asI32(gen(args[1]))[1] : `(array.len (local.get ${arr}))`
    return tv('array', `(local.set ${arr} ${rw})
    (local.set ${len} (array.len (local.get ${arr})))
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
    (local.set ${result} (array.new $f64array (f64.const 0) (local.get ${newLen})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${newLen})))
      (array.set $f64array (local.get ${result}) (local.get ${idx})
        (array.get $f64array (local.get ${arr}) (i32.add (local.get ${start}) (local.get ${idx}))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
  }
  ctx.usedMemory = true
  const endArg = args.length >= 2 ? asI32(gen(args[1]))[1] : `(call $__ptr_len (local.get ${arr}))`
  return tv('f64', `(local.set ${arr} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
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
    (local.set ${result} (call $__alloc (i32.const ${PTR_TYPE.F64_ARRAY}) (local.get ${newLen})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${newLen})))
      (f64.store (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (local.get ${idx}) (i32.const 3)))
        (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (i32.add (local.get ${start}) (local.get ${idx})) (i32.const 3)))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
}

export const reverse = (rw, args) => {
  ctx.usedArrayType = true
  const id = ctx.loopCounter++
  const arr = `$_rev_arr_${id}`, left = `$_rev_left_${id}`, right = `$_rev_right_${id}`, tmp = `$_rev_tmp_${id}`, len = `$_rev_len_${id}`
  if (opts.gc) {
    ctx.addLocal(arr.slice(1), 'array')
  } else {
    ctx.addLocal(arr.slice(1), 'f64')
  }
  ctx.addLocal(left.slice(1), 'i32')
  ctx.addLocal(right.slice(1), 'i32')
  ctx.addLocal(tmp.slice(1), 'f64')
  ctx.addLocal(len.slice(1), 'i32')
  if (opts.gc) {
    return tv('array', `(local.set ${arr} ${rw})
    (local.set ${len} (array.len (local.get ${arr})))
    (local.set ${left} (i32.const 0))
    (local.set ${right} (i32.sub (local.get ${len}) (i32.const 1)))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${left}) (local.get ${right})))
      (local.set ${tmp} (array.get $f64array (local.get ${arr}) (local.get ${left})))
      (array.set $f64array (local.get ${arr}) (local.get ${left})
        (array.get $f64array (local.get ${arr}) (local.get ${right})))
      (array.set $f64array (local.get ${arr}) (local.get ${right}) (local.get ${tmp}))
      (local.set ${left} (i32.add (local.get ${left}) (i32.const 1)))
      (local.set ${right} (i32.sub (local.get ${right}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${arr})`)
  }
  ctx.usedMemory = true
  return tv('f64', `(local.set ${arr} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (local.set ${left} (i32.const 0))
    (local.set ${right} (i32.sub (local.get ${len}) (i32.const 1)))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${left}) (local.get ${right})))
      (local.set ${tmp} (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${left}) (i32.const 3)))))
      (f64.store (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${left}) (i32.const 3)))
        (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${right}) (i32.const 3)))))
      (f64.store (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${right}) (i32.const 3))) (local.get ${tmp}))
      (local.set ${left} (i32.add (local.get ${left}) (i32.const 1)))
      (local.set ${right} (i32.sub (local.get ${right}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${arr})`)
}

export const push = (rw, args) => {
  if (args.length !== 1) return null
  // In-place push not supported without resizable arrays, return new array with element appended
  ctx.usedArrayType = true
  const val = gen(args[0])
  const id = ctx.loopCounter++
  const arr = `$_push_arr_${id}`, result = `$_push_result_${id}`, idx = `$_push_i_${id}`, len = `$_push_len_${id}`
  if (opts.gc) {
    ctx.addLocal(arr.slice(1), 'array')
    ctx.addLocal(result.slice(1), 'array')
  } else {
    ctx.addLocal(arr.slice(1), 'f64')
    ctx.addLocal(result.slice(1), 'f64')
  }
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  if (opts.gc) {
    return tv('array', `(local.set ${arr} ${rw})
    (local.set ${len} (array.len (local.get ${arr})))
    (local.set ${result} (array.new $f64array (f64.const 0) (i32.add (local.get ${len}) (i32.const 1))))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (array.set $f64array (local.get ${result}) (local.get ${idx})
        (array.get $f64array (local.get ${arr}) (local.get ${idx})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (array.set $f64array (local.get ${result}) (local.get ${len}) ${asF64(val)[1]})
    (local.get ${result})`)
  }
  ctx.usedMemory = true
  return tv('f64', `(local.set ${arr} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (local.set ${result} (call $__alloc (i32.const ${PTR_TYPE.F64_ARRAY}) (i32.add (local.get ${len}) (i32.const 1))))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (f64.store (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (local.get ${idx}) (i32.const 3)))
        (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${idx}) (i32.const 3)))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (f64.store (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (local.get ${len}) (i32.const 3))) ${asF64(val)[1]})
    (local.get ${result})`)
}

export const pop = (rw, args) => {
  // Returns last element (doesn't modify original without resizable arrays)
  ctx.usedArrayType = true
  const id = ctx.loopCounter++
  const arr = `$_pop_arr_${id}`, len = `$_pop_len_${id}`
  if (opts.gc) {
    ctx.addLocal(arr.slice(1), 'array')
  } else {
    ctx.addLocal(arr.slice(1), 'f64')
  }
  ctx.addLocal(len.slice(1), 'i32')
  if (opts.gc) {
    return tv('f64', `(local.set ${arr} ${rw})
    (local.set ${len} (array.len (local.get ${arr})))
    (if (result f64) (i32.gt_s (local.get ${len}) (i32.const 0))
      (then (array.get $f64array (local.get ${arr}) (i32.sub (local.get ${len}) (i32.const 1))))
      (else (f64.const nan)))`)
  }
  ctx.usedMemory = true
  return tv('f64', `(local.set ${arr} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (if (result f64) (i32.gt_s (local.get ${len}) (i32.const 0))
      (then (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (i32.sub (local.get ${len}) (i32.const 1)) (i32.const 3)))))
      (else (f64.const nan)))`)
}

export const forEach = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.forEach requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'
  const id = ctx.loopCounter++
  const arr = `$_foreach_arr_${id}`, idx = `$_foreach_i_${id}`, len = `$_foreach_len_${id}`
  if (opts.gc) {
    ctx.addLocal(arr.slice(1), 'array')
  } else {
    ctx.addLocal(arr.slice(1), 'f64')
  }
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  ctx.addLocal(paramName, 'f64')
  if (opts.gc) {
    return tv('f64', `(local.set ${arr} ${rw})
    (local.set ${len} (array.len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} (array.get $f64array (local.get ${arr}) (local.get ${idx})))
      (drop ${asF64(gen(body))[1]})
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (f64.const 0)`)
  }
  ctx.usedMemory = true
  return tv('f64', `(local.set ${arr} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${idx}) (i32.const 3)))))
      (drop ${asF64(gen(body))[1]})
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (f64.const 0)`)
}

export const concat = (rw, args) => {
  if (args.length !== 1) return null
  ctx.usedArrayType = true
  const arr2 = gen(args[0])
  const id = ctx.loopCounter++
  const arr1 = `$_concat_arr1_${id}`, arr2loc = `$_concat_arr2_${id}`, result = `$_concat_result_${id}`, idx = `$_concat_i_${id}`, len1 = `$_concat_len1_${id}`, len2 = `$_concat_len2_${id}`
  if (opts.gc) {
    ctx.addLocal(arr1.slice(1), 'array')
    ctx.addLocal(arr2loc.slice(1), 'array')
    ctx.addLocal(result.slice(1), 'array')
  } else {
    ctx.addLocal(arr1.slice(1), 'f64')
    ctx.addLocal(arr2loc.slice(1), 'f64')
    ctx.addLocal(result.slice(1), 'f64')
  }
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len1.slice(1), 'i32')
  ctx.addLocal(len2.slice(1), 'i32')
  if (opts.gc) {
    return tv('array', `(local.set ${arr1} ${rw})
    (local.set ${arr2loc} ${arr2[1]})
    (local.set ${len1} (array.len (local.get ${arr1})))
    (local.set ${len2} (array.len (local.get ${arr2loc})))
    (local.set ${result} (array.new $f64array (f64.const 0) (i32.add (local.get ${len1}) (local.get ${len2}))))
    (local.set ${idx} (i32.const 0))
    (block $done1_${id} (loop $loop1_${id}
      (br_if $done1_${id} (i32.ge_s (local.get ${idx}) (local.get ${len1})))
      (array.set $f64array (local.get ${result}) (local.get ${idx})
        (array.get $f64array (local.get ${arr1}) (local.get ${idx})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop1_${id})))
    (local.set ${idx} (i32.const 0))
    (block $done2_${id} (loop $loop2_${id}
      (br_if $done2_${id} (i32.ge_s (local.get ${idx}) (local.get ${len2})))
      (array.set $f64array (local.get ${result}) (i32.add (local.get ${len1}) (local.get ${idx}))
        (array.get $f64array (local.get ${arr2loc}) (local.get ${idx})))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop2_${id})))
    (local.get ${result})`)
  }
  ctx.usedMemory = true
  return tv('f64', `(local.set ${arr1} ${rw})
    (local.set ${arr2loc} ${arr2[1]})
    (local.set ${len1} (call $__ptr_len (local.get ${arr1})))
    (local.set ${len2} (call $__ptr_len (local.get ${arr2loc})))
    (local.set ${result} (call $__alloc (i32.const ${PTR_TYPE.F64_ARRAY}) (i32.add (local.get ${len1}) (local.get ${len2}))))
    (local.set ${idx} (i32.const 0))
    (block $done1_${id} (loop $loop1_${id}
      (br_if $done1_${id} (i32.ge_s (local.get ${idx}) (local.get ${len1})))
      (f64.store (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (local.get ${idx}) (i32.const 3)))
        (f64.load (i32.add (call $__ptr_offset (local.get ${arr1})) (i32.shl (local.get ${idx}) (i32.const 3)))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop1_${id})))
    (local.set ${idx} (i32.const 0))
    (block $done2_${id} (loop $loop2_${id}
      (br_if $done2_${id} (i32.ge_s (local.get ${idx}) (local.get ${len2})))
      (f64.store (i32.add (call $__ptr_offset (local.get ${result})) (i32.shl (i32.add (local.get ${len1}) (local.get ${idx})) (i32.const 3)))
        (f64.load (i32.add (call $__ptr_offset (local.get ${arr2loc})) (i32.shl (local.get ${idx}) (i32.const 3)))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop2_${id})))
    (local.get ${result})`)
}

export const join = (rw, args) => {
  // Returns sum of all elements (simplified join for numeric arrays)
  ctx.usedArrayType = true
  const id = ctx.loopCounter++
  const arr = `$_join_arr_${id}`, result = `$_join_result_${id}`, idx = `$_join_i_${id}`, len = `$_join_len_${id}`
  if (opts.gc) {
    ctx.addLocal(arr.slice(1), 'array')
  } else {
    ctx.addLocal(arr.slice(1), 'f64')
  }
  ctx.addLocal(result.slice(1), 'f64')
  ctx.addLocal(idx.slice(1), 'i32')
  ctx.addLocal(len.slice(1), 'i32')
  if (opts.gc) {
    return tv('f64', `(local.set ${arr} ${rw})
    (local.set ${len} (array.len (local.get ${arr})))
    (local.set ${result} (f64.const 0))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set ${result} (f64.add (local.get ${result}) (array.get $f64array (local.get ${arr}) (local.get ${idx}))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
  }
  ctx.usedMemory = true
  return tv('f64', `(local.set ${arr} ${rw})
    (local.set ${len} (call $__ptr_len (local.get ${arr})))
    (local.set ${result} (f64.const 0))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set ${result} (f64.add (local.get ${result}) (f64.load (i32.add (call $__ptr_offset (local.get ${arr})) (i32.shl (local.get ${idx}) (i32.const 3))))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result})`)
}
